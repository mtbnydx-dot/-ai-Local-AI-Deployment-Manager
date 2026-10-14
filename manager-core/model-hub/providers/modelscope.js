"use strict";

// ModelScope metadata provider (03 §4.2, HUB-3): search through the dolphin
// catalogue endpoint (page-number cursor), the repository manifest from the
// repo/files listing (Files[] with sizes and sha256, the revision SHA from
// Files[].Revision) and the README. Public repositories only in phase 1: a
// private or gated one answers 401/403 and is reported as repo_not_found with
// a ModelScope-specific detail (03 §6.3).
//
// Everything here is metadata; the bytes are moved by the CLI transfer engine
// (HUB-5), which builds its environment with buildModelScopeCliEnv below (the
// existing proxy-strip / direct-DNS helper, reused rather than copied). No
// credential is ever attached: the provider's fetchImpl refuses a token or an
// authorization header, like the mirror's.

const { buildDownloadEnv } = require("../../download-utils");
const { fetchWithSystemProxyFallback } = require("../../proxy-fetch");
const {
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  authorizedFetch,
  cappedJson,
  cappedText,
  credentialHostViolation,
  providerHttpError,
  wrapTransportError,
} = require("./http");

const DEFAULT_ENDPOINT = "https://www.modelscope.cn";
// ModelScope's default branch is "master", not "main".
const DEFAULT_REVISION = "master";
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const MAX_PAGE = 1000;
// 03 §17: response caps.
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const README_MAX_BYTES = 512 * 1024;
const README_HARD_MAX_BYTES = 4 * 1024 * 1024;

const SORT_FIELDS = Object.freeze({
  trending: "Default",
  downloads: "DownloadsCount",
  likes: "StarsCount",
  updated: "GmtModified",
});
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REPO_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,95}$/;

const PUBLIC_ONLY_HINT = Object.freeze({
  zh: "ModelScope 仅支持公开仓库；私有或需授权的仓库无法下载。",
  en: "Only public ModelScope repositories are supported; private or gated ones cannot be downloaded.",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
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

/** "owner/name" → the encoded "owner/name" URL path, or throws invalid_repo. */
function repoPathOf(repo) {
  const value = text(repo);
  const segments = value.split("/");
  if (segments.length !== 2 || !segments.every((segment) => REPO_SEGMENT.test(segment))) {
    throw new ProviderError("invalid_repo", "The repository id is not a valid ModelScope id (owner/name).", { baseCode: "repo_not_found", details: { repo: value.slice(0, 200) } });
  }
  return segments.map(encodeURIComponent).join("/");
}

function revisionOf(revision) {
  const value = text(revision) || DEFAULT_REVISION;
  if (value.length > 255 || value === "." || value === ".." || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProviderError("invalid_revision", "The revision is not valid.", { baseCode: "revision_not_found" });
  }
  return value;
}

function filePathOf(filePath) {
  const value = String(filePath || "");
  const segments = value.split("/");
  if (!value || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f\u007f\\]/.test(segment))) {
    throw new ProviderError("unsafe_path", "The file path is not a safe repository path.", { baseCode: "unknown" });
  }
  return value;
}

/** Epoch seconds or milliseconds, or an ISO string → ISO text, or null. */
function isoTime(value) {
  if (typeof value === "string" && value.trim() && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const number = finiteNumber(value);
  if (!number || number <= 0) return null;
  return new Date(number * (number < 1e12 ? 1000 : 1)).toISOString();
}

function nameList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => (isPlainObject(item) ? text(item.Name) || text(item.name) : text(item)))
    .filter(Boolean);
}

/** One entry of Data.Model.Models → a RawRepo (same shape as the HF provider's), or null without a usable id. */
function normalizeSearchItem(raw) {
  if (!isPlainObject(raw)) return null;
  const owner = text(raw.Path) || text(raw.Namespace) || text(raw.Organization) || text(raw.OrganizationName)
    || (isPlainObject(raw.Owner) ? text(raw.Owner.Name) : text(raw.Owner));
  const name = text(raw.Name) || text(raw.ModelName);
  const declaredId = text(raw.Id);
  const repo = declaredId.includes("/") ? declaredId : owner && name ? `${owner}/${name}` : "";
  const segments = repo.split("/");
  if (segments.length !== 2 || !segments.every(Boolean)) return null;
  const tasks = nameList(raw.Tasks);
  const tags = [...new Set([...tasks, ...nameList(raw.Tags)])];
  const libraries = nameList(raw.Libraries);
  return {
    namespace: "modelscope",
    repo,
    author: owner || segments[0],
    pipelineTag: tasks[0] || null,
    library: libraries[0] || text(raw.Library) || null,
    tags,
    downloads: finiteNumber(raw.Downloads ?? raw.DownloadsCount),
    likes: finiteNumber(raw.Stars ?? raw.StarsCount ?? raw.Likes),
    lastModified: isoTime(raw.LastUpdatedTime ?? raw.GmtModified ?? raw.LastModifiedTime),
    createdAt: isoTime(raw.CreatedTime ?? raw.GmtCreate),
    gated: false,
    gatedMode: null,
    private: false,
    baseModel: null,
    license: text(raw.License) || null,
    safetensors: null,
    gguf: null,
    usedStorage: finiteNumber(raw.StorageSize ?? raw.Size),
    displayName: text(raw.ChineseName) || null,
    description: text(raw.Description) || null,
  };
}

/** The model list and the total count, wherever this API generation put them. */
function searchPage(json) {
  const data = isPlainObject(json?.Data) ? json.Data : {};
  const model = isPlainObject(data.Model) ? data.Model : isPlainObject(data.model) ? data.model : {};
  const list = [model.Models, data.Models, model.models, data.models].find(Array.isArray) || [];
  return { list, total: finiteNumber(model.TotalCount ?? data.TotalCount ?? model.Total ?? data.Total) };
}

function stripSha256(value) {
  const hex = String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
  return SHA256_HEX.test(hex) ? hex : null;
}

function revisionShaOf(value) {
  const hex = String(value || "").trim().toLowerCase();
  return SHA1_HEX.test(hex) ? hex : null;
}

/** One entry of Data.Files → a manifest file, or null for directories and nameless entries. */
function fileFromEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const type = text(raw.Type).toLowerCase();
  if (type && type !== "blob" && type !== "file") return null;
  const filePath = typeof raw.Path === "string" && raw.Path ? raw.Path : typeof raw.Name === "string" ? raw.Name : "";
  if (!filePath) return null;
  const sha256 = stripSha256(raw.Sha256);
  return {
    path: filePath.replace(/^\/+/, ""),
    size: finiteNumber(raw.Size),
    sha256,
    gitOid: null,
    lfs: typeof raw.IsLFS === "boolean" ? raw.IsLFS : Boolean(sha256),
  };
}

/**
 * The first well-formed Files[].Revision in listing order; null when none
 * carries one. A full-SHA revision the caller asked for is already exact.
 */
function revisionShaFromFiles(entries, requested) {
  const exact = revisionShaOf(requested);
  if (exact) return exact;
  for (const entry of entries) {
    const sha = revisionShaOf(isPlainObject(entry) ? entry.Revision : "");
    if (sha) return sha;
  }
  return null;
}

/**
 * GET repo/files → RepoManifest (03 §4.1). ModelScope's listing carries no
 * card data, so tags, pipeline tag, library, base model and license stay
 * empty; nothing here throws on a partial payload.
 */
function normalizeFilesResponse(json, { repo = "", revision = DEFAULT_REVISION, fetchedFrom = "", now = Date.now() } = {}) {
  const data = isPlainObject(json?.Data) ? json.Data : {};
  const entries = Array.isArray(data.Files) ? data.Files : [];
  const seen = new Set();
  const files = [];
  for (const entry of entries) {
    const file = fileFromEntry(entry);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    files.push(file);
  }
  return {
    namespace: "modelscope",
    repo,
    revision,
    revisionSha: revisionShaFromFiles(entries, revision),
    gated: false,
    gatedMode: null,
    private: false,
    lastModified: null,
    tags: [],
    pipelineTag: null,
    library: null,
    baseModel: null,
    license: null,
    structured: { safetensors: null, gguf: null, config: {} },
    files,
    filesTruncated: false,
    fetchedAt: new Date(now).toISOString(),
    fetchedFrom,
    warnings: [],
  };
}

function notFoundError(status, what, extra = {}) {
  return new ProviderError("repo_not_found", `The ModelScope repository was not found or is not public (${what}).`, {
    status: status || null,
    details: { provider: "modelscope", publicOnly: true, hint: PUBLIC_ONLY_HINT, ...(status ? { status } : {}), ...extra },
  });
}

/** A non-2xx ModelScope response → ProviderError; 401/403/404 all mean "not a public repository". */
function modelScopeHttpError(response, what) {
  const status = Number(response.status) || 0;
  if (status === 401 || status === 403 || status === 404) {
    try {
      response.body?.cancel?.()?.catch?.(() => {});
    } catch {
      // Already consumed.
    }
    return notFoundError(status, what);
  }
  return providerHttpError(response, { tokenSent: false, what });
}

/**
 * ModelScope answers many failures with HTTP 200 and { Success: false, Code,
 * Message } in the body. Returns a ProviderError for such a payload, else null.
 */
function envelopeError(json, what) {
  if (!isPlainObject(json)) return null;
  const code = finiteNumber(json.Code);
  const failed = json.Success === false || (code !== null && code >= 400);
  if (!failed) return null;
  const message = text(json.Message);
  if (code === 401 || code === 403 || code === 404 || /not\s*exist|not\s*found|no such (?:model|repo)|unauthori[sz]ed|forbidden|permission/i.test(message)) {
    return notFoundError(null, what, { code });
  }
  if (/revision|branch|tag/i.test(message) && /invalid|not|unknown/i.test(message)) {
    return new ProviderError("revision_not_found", `The revision was not found (${what}).`, { details: { provider: "modelscope", code } });
  }
  return new ProviderError("provider_http_error", `ModelScope reported an error (${what}).`, {
    baseCode: "unknown",
    retryable: code !== null && code >= 500,
    details: { provider: "modelscope", code },
  });
}

/**
 * The CLI environment for a ModelScope download: the existing proxy-strip,
 * NO_PROXY=* and direct-DNS (PYTHONPATH=python-direct-dns) behaviour of
 * download-utils, which HUB-5's transfer engine layers on top of its base
 * env. The caller passes the env to start from; this module never reads it.
 */
function buildModelScopeCliEnv(hfCache, env = {}) {
  return buildDownloadEnv(hfCache, env, { source: "modelscope" });
}

/**
 * createModelScopeProvider({ endpoint, fetchImpl, cache, clock, timeoutMs })
 * → HubProvider with id "modelscope" (03 §4.1).
 *
 * Without a `fetchImpl`, metadata requests go through
 * fetchWithSystemProxyFallback (system proxy when the direct route fails).
 * `cache` is an optional `{ search, manifest, readme }` of single-flight
 * caches; cached values are cloned on the way out.
 */
function createModelScopeProvider(options = {}) {
  const id = "modelscope";
  const apiBase = normalizeEndpoint(options.endpoint);
  const baseFetch = typeof options.fetchImpl === "function"
    ? options.fetchImpl
    : (url, init) => fetchWithSystemProxyFallback(globalThis.fetch, url, init);
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const cache = options.cache || null;
  const userAgent = options.userAgent || "local-ai-hub/1.0";

  async function send(url, { headers, signal, ...rest } = {}) {
    try {
      return await authorizedFetch(url, {
        ...rest,
        token: "",
        fetchImpl: baseFetch,
        timeoutMs,
        signal,
        headers: { "user-agent": userAgent, ...(headers || {}) },
      });
    } catch (error) {
      throw wrapTransportError(error, { signal });
    }
  }

  // The fetch handed to 02 (inspectRemote Range reads): same redirect guard,
  // and it refuses any credential a caller tries to attach.
  async function providerFetch(url, init = {}) {
    const { token: callerToken, headers, ...rest } = init || {};
    let hasAuthorization = false;
    try {
      hasAuthorization = Boolean(headers) && new Headers(headers).has("authorization");
    } catch {
      hasAuthorization = false;
    }
    if (callerToken || hasAuthorization) throw credentialHostViolation(new URL(String(url)));
    return authorizedFetch(url, { ...rest, headers, token: "", fetchImpl: baseFetch, timeoutMs });
  }

  function cached(kind, key, loader) {
    const store = cache?.[kind];
    if (!store || typeof store.get !== "function") return loader();
    return store.get(key, loader).then((value) => structuredClone(value));
  }

  async function getJson(url, { maxBytes, signal, what, method, body }) {
    const headers = { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const response = await send(url, { method, body, signal, headers });
    if (!response.ok) throw modelScopeHttpError(response, what);
    let json;
    try {
      json = await cappedJson(response, maxBytes);
    } catch (error) {
      throw wrapTransportError(error, { signal });
    }
    const failure = envelopeError(json, what);
    if (failure) throw failure;
    return json;
  }

  function pageOf(cursor) {
    if (cursor === undefined || cursor === null || cursor === "") return 1;
    const value = String(cursor).trim();
    const page = /^\d{1,4}$/.test(value) ? Number(value) : 0;
    if (page < 1 || page > MAX_PAGE) {
      throw new ProviderError("invalid_cursor", "The search cursor is not valid for this provider.", { baseCode: "unknown", details: { field: "cursor" } });
    }
    return page;
  }

  function searchBody(query, page) {
    const sortInput = text(query.sort) || "trending";
    const sortBy = SORT_FIELDS[sortInput] || (Object.values(SORT_FIELDS).includes(sortInput) ? sortInput : "");
    if (!sortBy) throw new ProviderError("invalid_query", `Unknown sort "${sortInput.slice(0, 40)}".`, { baseCode: "unknown", details: { field: "sort" } });
    const requested = Math.floor(Number(query.limit));
    return {
      PageSize: requested >= 1 ? Math.min(MAX_LIMIT, requested) : DEFAULT_LIMIT,
      PageNumber: page,
      SortBy: sortBy,
      Name: text(query.q),
      Criterion: [],
      SingleCriterion: [],
      Target: "",
    };
  }

  async function search(query = {}) {
    const input = isPlainObject(query) ? query : {};
    const page = pageOf(input.cursor);
    const body = searchBody(input, page);
    const url = `${apiBase}/api/v1/dolphin/models`;
    const key = `search|${id}|${apiBase}|${JSON.stringify(body)}`;
    return cached("search", key, async () => {
      const json = await getJson(url, { maxBytes: SEARCH_MAX_BYTES, signal: input.signal, what: "search", method: "PUT", body: JSON.stringify(body) });
      const { list, total } = searchPage(json);
      if (!isPlainObject(json) || (!isPlainObject(json.Data) && !Array.isArray(json.Data))) {
        throw new ProviderError("provider_bad_response", "The search answer has no data.", { baseCode: "unknown" });
      }
      const more = total !== null ? page * body.PageSize < total : list.length >= body.PageSize;
      return {
        items: list.map(normalizeSearchItem).filter(Boolean),
        nextCursor: more && list.length > 0 && page < MAX_PAGE ? String(page + 1) : null,
        total,
        fetchedFrom: apiBase,
        warnings: [],
      };
    });
  }

  async function getRepo(repo, opts = {}) {
    const repoPath = repoPathOf(repo);
    const revision = revisionOf(opts.revision);
    const url = `${apiBase}/api/v1/models/${repoPath}/repo/files?Revision=${encodeURIComponent(revision)}&Recursive=true`;
    const key = `manifest|${id}|${apiBase}|${repoPath}|${revision}`;
    const loader = async () => {
      const json = await getJson(url, { maxBytes: MANIFEST_MAX_BYTES, signal: opts.signal, what: "repository manifest" });
      if (!isPlainObject(json?.Data) || !Array.isArray(json.Data.Files)) {
        throw new ProviderError("provider_bad_response", "The repository answer has no file list.", { baseCode: "unknown" });
      }
      return normalizeFilesResponse(json, { repo: text(repo), revision, fetchedFrom: apiBase, now: clock.now() });
    };
    if (opts.force) return loader();
    return cached("manifest", key, loader);
  }

  function fileUrl(repo, filePath, revision = DEFAULT_REVISION) {
    return `${apiBase}/api/v1/models/${repoPathOf(repo)}/repo?Revision=${encodeURIComponent(revisionOf(revision))}&FilePath=${encodeURIComponent(filePathOf(filePath))}`;
  }

  async function getReadme(repo, opts = {}) {
    const maxBytes = Math.min(README_HARD_MAX_BYTES, Math.max(1, Math.floor(Number(opts.maxBytes)) || README_MAX_BYTES));
    const revision = revisionOf(opts.revision);
    const url = fileUrl(repo, "README.md", revision);
    const key = `readme|${id}|${apiBase}|${repoPathOf(repo)}|${revision}|${maxBytes}`;
    return cached("readme", key, async () => {
      const response = await send(url, { signal: opts.signal, headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" } });
      if (!response.ok) {
        const error = modelScopeHttpError(response, "README");
        // A repository without a README is not a failure; a missing one is.
        if (error.code === "repo_not_found" && response.status === 404 && opts.strict !== true) {
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
      // The raw-file endpoint reports a missing file as a JSON envelope.
      if (/^\s*\{\s*"Code"/.test(body.text) && !body.truncated) {
        try {
          if (envelopeError(JSON.parse(body.text), "README")) return { markdown: "", truncated: false, missing: true, fetchedFrom: apiBase, warnings: [] };
        } catch {
          // Not an envelope: it is the README text.
        }
      }
      return { markdown: body.text, truncated: body.truncated, missing: false, fetchedFrom: apiBase, warnings: [] };
    });
  }

  return {
    id,
    namespace: "modelscope",
    apiBase,
    fileBase: apiBase,
    sendsCredentials: false,
    search,
    getRepo,
    getReadme,
    fetchImpl: providerFetch,
    fileUrl,
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_REVISION,
  MANIFEST_MAX_BYTES,
  PUBLIC_ONLY_HINT,
  SEARCH_MAX_BYTES,
  buildModelScopeCliEnv,
  createModelScopeProvider,
  normalizeFilesResponse,
  normalizeSearchItem,
};
