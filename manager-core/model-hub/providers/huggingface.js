"use strict";

// Hugging Face metadata provider (03 §4): search with a Link-header cursor,
// the repository manifest (files with sizes and sha256, the revision SHA),
// and the README. The same implementation serves the official API and a
// mirror; the mirror is built in hf-mirror.js with credentials switched off.
//
// Everything here is metadata. Model bytes are moved by the transfer engine
// (HUB-5). Every request goes through authorizedFetch, so a credential only
// ever reaches huggingface.co (providers/http.js).

const {
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  authorizedFetch,
  cappedJson,
  cappedText,
  credentialHostViolation,
  credentialsAllowed,
  nextLinkOf,
  providerHttpError,
  readCapped,
  wrapTransportError,
} = require("./http");

const DEFAULT_ENDPOINT = "https://huggingface.co";
// 03 §4.2: the fields requested with expand[] on a search. The spec also lists
// usedStorage, but the live search endpoint rejects it with HTTP 400, so it is
// not requested (the field stays optional in a normalised item).
const SEARCH_EXPAND = Object.freeze([
  "downloads",
  "likes",
  "lastModified",
  "pipeline_tag",
  "library_name",
  "tags",
  "gated",
  "safetensors",
  "gguf",
  "cardData",
]);
const SORT_ALIASES = Object.freeze({
  trending: "trendingScore",
  downloads: "downloads",
  likes: "likes",
  updated: "lastModified",
  created: "createdAt",
});
const NATIVE_SORTS = Object.freeze(new Set(["trendingScore", "downloads", "likes", "lastModified", "createdAt", "downloadsAllTime"]));
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
// 03 §17: response caps.
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const README_MAX_BYTES = 512 * 1024;
const README_HARD_MAX_BYTES = 4 * 1024 * 1024;
// A revision listing this long is fetched again through the paged tree API
// (03 §4.2), and the tree is read for at most this many pages.
const TREE_FALLBACK_FILES = 20000;
const MAX_TREE_PAGES = 100;
const MAX_CURSOR_LENGTH = 4096;

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REPO_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,95}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

function normalizeEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || DEFAULT_ENDPOINT));
  } catch {
    throw new ProviderError("provider_bad_url", "The provider endpoint is not a valid URL.", { baseCode: "unknown" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("provider_bad_url", "The provider endpoint must be an http(s) URL.", { baseCode: "unknown" });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** "owner/name" (or a legacy single-segment id) → the encoded URL path, or throws invalid_repo. */
function repoPathOf(repo) {
  const value = text(repo);
  const segments = value.split("/");
  if (segments.length < 1 || segments.length > 2 || !segments.every((segment) => REPO_SEGMENT.test(segment))) {
    throw new ProviderError("invalid_repo", "The repository id is not a valid Hugging Face id.", { baseCode: "repo_not_found", details: { repo: value.slice(0, 200) } });
  }
  return segments.map(encodeURIComponent).join("/");
}

function revisionPartOf(revision) {
  const value = text(revision) || "main";
  if (value.length > 255 || value === "." || value === ".." || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProviderError("invalid_revision", "The revision is not valid.", { baseCode: "revision_not_found" });
  }
  return encodeURIComponent(value);
}

function filePartOf(filePath) {
  const value = String(filePath || "");
  const segments = value.split("/");
  if (!value || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f\\]/.test(segment))) {
    throw new ProviderError("unsafe_path", "The file path is not a safe repository path.", { baseCode: "unknown" });
  }
  return segments.map(encodeURIComponent).join("/");
}

function baseModelOf(cardData, tags) {
  const declared = isPlainObject(cardData) ? cardData.base_model : null;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  if (Array.isArray(declared)) {
    const first = declared.find((item) => typeof item === "string" && item.trim());
    if (first) return first.trim();
  }
  // Tags carry "base_model:<relation>:<repo>" (and a bare "base_model:<repo>").
  for (const tag of tags) {
    const match = /^base_model:(?:[a-z_]+:)?(.+\/.+)$/.exec(tag);
    if (match) return match[1];
  }
  return null;
}

function licenseOf(cardData, tags) {
  const declared = isPlainObject(cardData) ? cardData.license : null;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  if (Array.isArray(declared)) {
    const first = declared.find((item) => typeof item === "string" && item.trim());
    if (first) return first.trim();
  }
  const tag = tags.find((item) => item.startsWith("license:"));
  return tag ? tag.slice("license:".length) : null;
}

function gatedOf(value) {
  return { gated: Boolean(value), gatedMode: typeof value === "string" && value ? value : null };
}

function structuredSafetensors(value) {
  if (!isPlainObject(value)) return null;
  return { total: finiteNumber(value.total), parameters: isPlainObject(value.parameters) ? { ...value.parameters } : {} };
}

function structuredGguf(value) {
  if (!isPlainObject(value)) return null;
  return {
    architecture: text(value.architecture) || null,
    context_length: finiteNumber(value.context_length),
    total: finiteNumber(value.total),
  };
}

/** One entry of GET /api/models → a RawRepo, or null when it has no usable id. */
function normalizeSearchItem(raw, namespace = "huggingface") {
  if (!isPlainObject(raw)) return null;
  const repo = text(raw.id) || text(raw.modelId);
  if (!repo || repo.split("/").length > 2) return null;
  const tags = stringList(raw.tags);
  const cardData = isPlainObject(raw.cardData) ? raw.cardData : null;
  return {
    namespace,
    repo,
    author: text(raw.author) || (repo.includes("/") ? repo.split("/")[0] : null),
    pipelineTag: text(raw.pipeline_tag) || null,
    library: text(raw.library_name) || null,
    tags,
    downloads: finiteNumber(raw.downloads),
    likes: finiteNumber(raw.likes),
    lastModified: text(raw.lastModified) || null,
    createdAt: text(raw.createdAt) || null,
    ...gatedOf(raw.gated),
    private: Boolean(raw.private),
    baseModel: baseModelOf(cardData, tags),
    license: licenseOf(cardData, tags),
    safetensors: structuredSafetensors(raw.safetensors),
    gguf: structuredGguf(raw.gguf),
    usedStorage: finiteNumber(raw.usedStorage),
  };
}

function stripSha256Prefix(value) {
  const hex = String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
  return SHA256_HEX.test(hex) ? hex : null;
}

function gitOidOf(value) {
  const hex = String(value || "").trim().toLowerCase();
  return SHA1_HEX.test(hex) ? hex : null;
}

/** A model-info sibling (blobs=true) → a manifest file, or null. */
function fileFromSibling(raw) {
  if (!isPlainObject(raw)) return null;
  const filePath = typeof raw.rfilename === "string" ? raw.rfilename : "";
  if (!filePath) return null;
  const lfs = isPlainObject(raw.lfs) ? raw.lfs : null;
  return {
    path: filePath,
    size: finiteNumber(raw.size) ?? finiteNumber(lfs?.size),
    sha256: lfs ? stripSha256Prefix(lfs.sha256 || lfs.oid) : null,
    gitOid: gitOidOf(raw.blobId),
    lfs: Boolean(lfs),
  };
}

/** A tree entry (recursive=true&expand=true) → a manifest file, or null for directories. */
function fileFromTreeEntry(raw) {
  if (!isPlainObject(raw) || raw.type !== "file") return null;
  const filePath = typeof raw.path === "string" ? raw.path : "";
  if (!filePath) return null;
  const lfs = isPlainObject(raw.lfs) ? raw.lfs : null;
  return {
    path: filePath,
    size: finiteNumber(lfs?.size) ?? finiteNumber(raw.size),
    sha256: lfs ? stripSha256Prefix(lfs.sha256 || lfs.oid) : null,
    gitOid: gitOidOf(raw.oid),
    lfs: Boolean(lfs),
  };
}

/**
 * GET /api/models/{repo}/revision/{rev}?blobs=true → RepoManifest (03 §4.1).
 * `files` may be replaced by the caller when the listing came from the tree
 * API. Missing fields give null, empty lists or empty objects; nothing here
 * throws on a partial payload.
 */
function normalizeRepoInfo(data, { repo = "", revision = "main", namespace = "huggingface", fetchedFrom = "", now = Date.now() } = {}) {
  const info = isPlainObject(data) ? data : {};
  const tags = stringList(info.tags);
  const cardData = isPlainObject(info.cardData) ? info.cardData : null;
  const sha = String(info.sha || "").trim().toLowerCase();
  return {
    namespace,
    repo: text(info.id) || text(info.modelId) || repo,
    revision,
    revisionSha: SHA1_HEX.test(sha) ? sha : null,
    ...gatedOf(info.gated),
    private: Boolean(info.private),
    lastModified: text(info.lastModified) || null,
    tags,
    pipelineTag: text(info.pipeline_tag) || null,
    library: text(info.library_name) || null,
    baseModel: baseModelOf(cardData, tags),
    license: licenseOf(cardData, tags),
    structured: {
      safetensors: structuredSafetensors(info.safetensors),
      gguf: structuredGguf(info.gguf),
      config: isPlainObject(info.config) ? info.config : {},
    },
    files: (Array.isArray(info.siblings) ? info.siblings : []).map(fileFromSibling).filter(Boolean),
    filesTruncated: false,
    fetchedAt: new Date(now).toISOString(),
    fetchedFrom,
    warnings: [],
  };
}

function hasAuthorizationHeader(headers) {
  if (!headers) return false;
  try {
    return new Headers(headers).has("authorization");
  } catch {
    return false;
  }
}

/**
 * createHuggingFaceProvider({ id, endpoint, fetchImpl, getToken, cache,
 * credentials, clock, timeoutMs }) → HubProvider (03 §4.1).
 *
 * `getToken` (sync or async) is called per request; the token is attached
 * only for huggingface.co hosts. `credentials: false` (the mirror) never
 * calls it. `cache` is an optional `{ search, manifest, readme }` of
 * single-flight caches; cached values are cloned on the way out. The token
 * is never part of a cache key, only whether one was sent.
 */
function createHuggingFaceProvider(options = {}) {
  const id = options.id || "huggingface";
  const apiBase = normalizeEndpoint(options.endpoint);
  const baseFetch = options.fetchImpl || globalThis.fetch;
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const cache = options.cache || null;
  const getToken = typeof options.getToken === "function" ? options.getToken : () => "";
  const sendsCredentials = options.credentials !== false && credentialsAllowed(new URL(apiBase));
  const userAgent = options.userAgent || "local-ai-hub/1.0";

  async function resolveToken(url) {
    if (!sendsCredentials || !credentialsAllowed(new URL(url))) return "";
    const token = await getToken();
    return typeof token === "string" ? token.trim() : "";
  }

  async function send(url, { token = "", headers, signal, ...rest } = {}) {
    try {
      return await authorizedFetch(url, {
        ...rest,
        token,
        fetchImpl: baseFetch,
        timeoutMs,
        signal,
        headers: { "user-agent": userAgent, ...(headers || {}) },
      });
    } catch (error) {
      throw wrapTransportError(error, { signal });
    }
  }

  // The fetch handed to 02 (inspectRemote Range reads): same guards, token
  // chosen by the provider, never by the caller.
  async function providerFetch(url, init = {}) {
    const { token: callerToken, headers, ...rest } = init || {};
    if (!sendsCredentials && (callerToken || hasAuthorizationHeader(headers))) throw credentialHostViolation(new URL(String(url)));
    return authorizedFetch(url, {
      ...rest,
      headers,
      token: await resolveToken(String(url)),
      fetchImpl: baseFetch,
      timeoutMs,
    });
  }

  function cached(kind, key, loader) {
    const store = cache?.[kind];
    if (!store || typeof store.get !== "function") return loader();
    return store.get(key, loader).then((value) => structuredClone(value));
  }

  async function getJson(url, { maxBytes, signal, what, token }) {
    const response = await send(url, { token, signal, headers: { accept: "application/json" } });
    if (!response.ok) throw providerHttpError(response, { tokenSent: Boolean(token), what });
    try {
      return { json: await cappedJson(response, maxBytes), response };
    } catch (error) {
      throw wrapTransportError(error, { signal });
    }
  }

  function modelsUrl() {
    return `${apiBase}/api/models`;
  }

  function searchUrl(query) {
    const url = new URL(modelsUrl());
    const params = url.searchParams;
    const term = text(query.q);
    if (term) params.set("search", term);
    if (text(query.author)) params.set("author", text(query.author));
    for (const filter of [].concat(query.filter ?? []).map(text).filter(Boolean)) params.append("filter", filter);
    const task = text(query.task) || text(query.pipelineTag);
    if (task) params.set("pipeline_tag", task);
    const sortInput = text(query.sort) || "trending";
    const sort = SORT_ALIASES[sortInput] || (NATIVE_SORTS.has(sortInput) ? sortInput : "");
    if (!sort) throw new ProviderError("invalid_query", `Unknown sort "${sortInput.slice(0, 40)}".`, { baseCode: "unknown", details: { field: "sort" } });
    params.set("sort", sort);
    params.set("direction", query.direction === 1 || query.direction === "1" ? "1" : "-1");
    const requested = Math.floor(Number(query.limit));
    params.set("limit", String(requested >= 1 ? Math.min(MAX_LIMIT, requested) : DEFAULT_LIMIT));
    for (const field of SEARCH_EXPAND) params.append("expand[]", field);
    return url.href;
  }

  // A cursor is the query part of the Link header's next URL. Only that part
  // is ever used, on this provider's own endpoint, so a Link (or a cursor
  // handed back by a client) can never point a request at another host.
  function cursorUrl(cursor) {
    const value = String(cursor);
    let parsed;
    try {
      parsed = value.length <= MAX_CURSOR_LENGTH ? new URL(value, "https://cursor.invalid") : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !/(?:^|\/)api\/models\/?$/.test(parsed.pathname) || !parsed.search) {
      throw new ProviderError("invalid_cursor", "The search cursor is not valid for this provider.", { baseCode: "unknown", details: { field: "cursor" } });
    }
    const url = new URL(modelsUrl());
    url.search = parsed.search;
    return url.href;
  }

  function cursorOf(response) {
    const link = nextLinkOf(response);
    if (!link) return null;
    try {
      const parsed = new URL(link, apiBase);
      if (!/(?:^|\/)api\/models\/?$/.test(parsed.pathname) || !parsed.search) return null;
      return `/api/models${parsed.search}`;
    } catch {
      return null;
    }
  }

  async function search(query = {}) {
    const input = isPlainObject(query) ? query : {};
    const url = input.cursor ? cursorUrl(input.cursor) : searchUrl(input);
    const token = await resolveToken(url);
    const key = `search|${id}|${apiBase}|cred:${Boolean(token)}|${url}`;
    return cached("search", key, async () => {
      const { json, response } = await getJson(url, { maxBytes: SEARCH_MAX_BYTES, signal: input.signal, what: "search", token });
      if (!Array.isArray(json)) throw new ProviderError("provider_bad_response", "The search answer is not a list.", { baseCode: "unknown" });
      return {
        items: json.map((raw) => normalizeSearchItem(raw)).filter(Boolean),
        nextCursor: cursorOf(response),
        fetchedFrom: apiBase,
        warnings: [],
      };
    });
  }

  // The paged tree listing used for very large repositories.
  async function listTree(repoPath, revisionPart, { signal, token }) {
    const base = `${apiBase}/api/models/${repoPath}/tree/${revisionPart}`;
    let url = `${base}?recursive=true&expand=true`;
    const files = [];
    let remaining = MANIFEST_MAX_BYTES;
    for (let page = 0; page < MAX_TREE_PAGES; page += 1) {
      let json;
      let response;
      try {
        response = await send(url, { token, signal, headers: { accept: "application/json" } });
        if (!response.ok) throw providerHttpError(response, { tokenSent: Boolean(token), what: "file tree" });
        const { buffer } = await readCapped(response, remaining);
        remaining -= buffer.length;
        json = JSON.parse(buffer.toString("utf8"));
      } catch (error) {
        if (error?.code === "provider_response_too_large") return { files, truncated: true };
        if (error instanceof SyntaxError) throw new ProviderError("provider_bad_response", "The file tree answer is not valid JSON.", { baseCode: "unknown" });
        throw wrapTransportError(error, { signal });
      }
      if (!Array.isArray(json)) throw new ProviderError("provider_bad_response", "The file tree answer is not a list.", { baseCode: "unknown" });
      for (const entry of json) {
        const file = fileFromTreeEntry(entry);
        if (file) files.push(file);
      }
      const next = nextLinkOf(response);
      if (!next) return { files, truncated: false };
      // Like the search cursor, only the query part of the link is used.
      let query = "";
      try {
        const parsed = new URL(next, apiBase);
        query = parsed.pathname.includes("/tree/") ? parsed.search : "";
      } catch {
        query = "";
      }
      if (!query) return { files, truncated: true };
      url = `${base}${query}`;
    }
    return { files, truncated: true };
  }

  async function getRepo(repo, opts = {}) {
    const repoPath = repoPathOf(repo);
    const revision = text(opts.revision) || "main";
    const revisionPart = revisionPartOf(revision);
    const url = `${apiBase}/api/models/${repoPath}/revision/${revisionPart}?blobs=true`;
    const token = await resolveToken(url);
    const key = `manifest|${id}|${apiBase}|cred:${Boolean(token)}|${repoPath}|${revision}`;
    const loader = async () => {
      const { json } = await getJson(url, { maxBytes: MANIFEST_MAX_BYTES, signal: opts.signal, what: "repository manifest", token });
      if (!isPlainObject(json)) throw new ProviderError("provider_bad_response", "The repository answer is not an object.", { baseCode: "unknown" });
      const manifest = normalizeRepoInfo(json, { repo: text(repo), revision, namespace: "huggingface", fetchedFrom: apiBase, now: clock.now() });
      if (manifest.files.length >= TREE_FALLBACK_FILES) {
        try {
          const tree = await listTree(repoPath, revisionPart, { signal: opts.signal, token });
          if (tree.files.length) {
            manifest.files = tree.files;
            manifest.filesTruncated = tree.truncated;
          }
        } catch (error) {
          if (opts.signal?.aborted || error?.name === "AbortError") throw error;
          // The revision listing is still usable; say that it may be short.
          manifest.filesTruncated = true;
          manifest.warnings.push({ code: "file_tree_unavailable", message: "The paged file tree could not be read; the file list may be incomplete.", detail: String(error?.code || "error") });
        }
      }
      return manifest;
    };
    if (opts.force) return loader();
    return cached("manifest", key, loader);
  }

  function fileUrl(repo, filePath, revision = "main") {
    return `${apiBase}/${repoPathOf(repo)}/resolve/${revisionPartOf(revision)}/${filePartOf(filePath)}`;
  }

  async function getReadme(repo, opts = {}) {
    const maxBytes = Math.min(README_HARD_MAX_BYTES, Math.max(1, Math.floor(Number(opts.maxBytes)) || README_MAX_BYTES));
    const revision = text(opts.revision) || "main";
    const url = fileUrl(repo, "README.md", revision);
    const token = await resolveToken(url);
    const key = `readme|${id}|${apiBase}|cred:${Boolean(token)}|${repoPathOf(repo)}|${revision}|${maxBytes}`;
    return cached("readme", key, async () => {
      const response = await send(url, { token, signal: opts.signal, headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" } });
      if (!response.ok) {
        const error = providerHttpError(response, { tokenSent: Boolean(token), what: "README" });
        // A repository without a README is not a failure.
        if (error.code === "file_not_found" || (error.code === "repo_not_found" && error.details?.hfErrorCode !== "RepoNotFound")) {
          return { markdown: "", truncated: false, missing: true, fetchedFrom: apiBase, warnings: [] };
        }
        throw error;
      }
      let body;
      try {
        body = await cappedText(response, maxBytes);
      } catch (error) {
        throw wrapTransportError(error, { signal: opts.signal });
      }
      return { markdown: body.text, truncated: body.truncated, missing: false, fetchedFrom: apiBase, warnings: [] };
    });
  }

  return {
    id,
    namespace: "huggingface",
    apiBase,
    fileBase: apiBase,
    sendsCredentials,
    search,
    getRepo,
    getReadme,
    fetchImpl: providerFetch,
    fileUrl,
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  MANIFEST_MAX_BYTES,
  README_MAX_BYTES,
  SEARCH_EXPAND,
  SEARCH_MAX_BYTES,
  TREE_FALLBACK_FILES,
  createHuggingFaceProvider,
  normalizeRepoInfo,
  normalizeSearchItem,
};
