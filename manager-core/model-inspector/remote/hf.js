"use strict";

// Hugging Face client of the remote inspector (docs/overhaul/02-models.md §6).
//
//   GET {endpoint}/api/models/{repo}/revision/{revision}?blobs=true
//       -> sha, siblings[{rfilename, size}], safetensors, gguf, config,
//          cardData.base_model, pipeline_tag, library_name, gated
//   GET {endpoint}/{repo}/resolve/{sha}/{file}   small files and Range reads
//
// Credential policy (02 §19, 03 §17): a token is attached only to requests
// whose origin is the official endpoint or the endpoint the owner configured
// (the `endpoint` option, or a `mirrors` entry), never over cleartext HTTP
// (loopback excepted) and never on to another host when a download redirects
// to a CDN. A caller whose own fetch attaches credentials passes no token.
// `mirrors`, when given, is the owner's whole list: an endpoint outside it
// (and outside the official one) is refused before any request.

const { REPO_ID } = require("../detectors/hf-config");
const {
  DEFAULT_MAX_BYTES, RemoteError, createRepoReader, discard, fetchChecked, readBody,
} = require("./range-reader");

const HF_ENDPOINT = "https://huggingface.co";
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const API_MAX_BYTES = 16 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function encodePath(value) {
  return String(value || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** {origin, base} for an endpoint URL; throws RemoteError endpoint_invalid. */
function normalizeEndpoint(endpoint, fallback = HF_ENDPOINT) {
  const text = String(endpoint || fallback).trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RemoteError("endpoint_invalid", "The endpoint is not a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RemoteError("endpoint_invalid", "The endpoint must be a plain http(s) URL without credentials.");
  }
  return { origin: url.origin, base: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

function secureForToken(url) {
  return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * resolveEndpoints({endpoint, mirrors}) -> {official, chosen, tokenOrigins}
 * tokenOrigins: the origins that may receive a token.
 */
function resolveEndpoints({ endpoint, mirrors } = {}) {
  const official = normalizeEndpoint(HF_ENDPOINT);
  const chosen = endpoint ? normalizeEndpoint(endpoint) : official;
  const tokenOrigins = new Set([official.origin, chosen.origin]);
  if (Array.isArray(mirrors)) {
    const listed = mirrors.map((item) => normalizeEndpoint(item));
    if (chosen.origin !== official.origin && !listed.some((item) => item.origin === chosen.origin)) {
      throw new RemoteError("endpoint_not_allowed", "The endpoint is neither the official Hugging Face endpoint nor a configured mirror.");
    }
    for (const item of listed) tokenOrigins.add(item.origin);
  }
  return { official, chosen, tokenOrigins };
}

/**
 * requestHeaders({token, url, endpoint, mirrors, headers}) -> headers for one
 * request to `url`: the token becomes `authorization` only for an allowed
 * origin (see the header comment). Used by the inspector and by
 * remote-model-config.js.
 */
function requestHeaders({ token, url, endpoint, mirrors, headers = {} } = {}) {
  const result = { ...headers };
  if (!token) return result;
  let target;
  try {
    target = new URL(url);
  } catch {
    return result;
  }
  let origins;
  try {
    origins = resolveEndpoints({ endpoint, mirrors }).tokenOrigins;
  } catch {
    return result;
  }
  if (origins.has(target.origin) && secureForToken(target)) result.authorization = `Bearer ${token}`;
  return result;
}

/** {endpoint}/{repo}/resolve/{revision}/{file} */
function fileUrl(repo, revision, file, endpoint = HF_ENDPOINT) {
  const { base } = normalizeEndpoint(endpoint);
  return `${base}/${encodePath(repo)}/resolve/${encodeURIComponent(revision)}/${encodePath(file)}`;
}

function textOf(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function baseModelOf(cardData) {
  const raw = cardData?.base_model;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" && REPO_ID.test(first) ? first : null;
}

function normalizeSiblings(siblings) {
  return (Array.isArray(siblings) ? siblings : [])
    .map((item) => ({
      name: typeof item?.rfilename === "string" ? item.rfilename : "",
      size: Number(item?.size ?? item?.lfs?.size) || 0,
      sha256: /^[0-9a-f]{64}$/.test(String(item?.lfs?.sha256 || item?.lfs?.oid || "")) ? String(item.lfs.sha256 || item.lfs.oid) : null,
    }))
    .filter((item) => item.name);
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * createHfClient({repo, revision, endpoint, mirrors, token, fetchImpl, readRange, budget, maxBytes})
 * -> {source: "hf", endpoint, info(), fileUrl(name), fetchFile(name, opts), rangeRead(name, start, length)}
 * info() resolves the repo and fixes the revision the file reads use (the sha).
 */
function createHfClient({
  repo, revision = "main", endpoint, mirrors, token, fetchImpl, readRange, budget, maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!REPO_ID.test(String(repo || ""))) throw new RemoteError("invalid_repo", "The repository id must look like owner/name.");
  if (!REVISION_PATTERN.test(String(revision || ""))) throw new RemoteError("invalid_repo", "The revision is not valid.");
  const { chosen, tokenOrigins } = resolveEndpoints({ endpoint, mirrors });
  let pinned = revision;

  function headersFor(url, extra = {}) {
    const headers = { accept: "application/json", ...extra };
    if (!token) return headers;
    let target;
    try {
      target = new URL(url);
    } catch {
      return headers;
    }
    if (tokenOrigins.has(target.origin) && secureForToken(target)) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  const reader = createRepoReader({
    fileUrl: (name) => fileUrl(repo, pinned, name, chosen.base),
    headersFor,
    fetchImpl,
    readRange,
    budget,
    maxBytes,
  });

  async function info() {
    budget.check();
    const url = `${chosen.base}/api/models/${encodePath(repo)}/revision/${encodeURIComponent(revision)}?blobs=true`;
    const { response } = await fetchChecked(url, { fetchImpl, headersFor, signal: budget.signal, timeoutMs: budget.timeoutFor() });
    const { status } = response;
    if (status === 401 || status === 403) {
      await discard(response);
      throw new RemoteError("gated", "The repository needs authorization (gated or private).", { status });
    }
    if (status === 404) {
      let text = "";
      try {
        text = (await readBody(response, 4096)).buffer.toString("utf8");
      } catch {
        text = "";
      }
      throw new RemoteError(/revision/i.test(text) ? "revision_not_found" : "repo_not_found", "The repository or revision was not found.", { status });
    }
    if (status === 429) {
      await discard(response);
      throw new RemoteError("rate_limited", "The hub is rate limiting requests.", { status });
    }
    if (status !== 200) {
      await discard(response);
      throw new RemoteError("http_error", `The hub answered HTTP ${status}.`, { status });
    }
    let body;
    try {
      body = JSON.parse((await readBody(response, API_MAX_BYTES)).buffer.toString("utf8"));
    } catch {
      throw new RemoteError("bad_response", "The hub answered something that is not JSON.");
    }
    if (!objectOrNull(body)) throw new RemoteError("bad_response", "The hub answered an unexpected document.");
    const sha = /^[0-9a-f]{7,64}$/i.test(String(body.sha || "")) ? String(body.sha).toLowerCase() : null;
    pinned = sha || revision;
    const siblings = normalizeSiblings(body.siblings);
    return {
      sha,
      files: siblings,
      gated: Boolean(body.gated),
      downloads: Number.isFinite(Number(body.downloads)) ? Number(body.downloads) : null,
      likes: Number.isFinite(Number(body.likes)) ? Number(body.likes) : null,
      lastModified: textOf(body.lastModified, 64) || null,
      pipelineTag: textOf(body.pipeline_tag, 64) || null,
      libraryName: textOf(body.library_name, 64) || null,
      safetensors: objectOrNull(body.safetensors),
      gguf: objectOrNull(body.gguf),
      config: objectOrNull(body.config),
      baseModel: baseModelOf(objectOrNull(body.cardData)),
    };
  }

  return {
    source: "hf",
    endpoint: chosen.base,
    info,
    fileUrl: (name) => fileUrl(repo, pinned, name, chosen.base),
    fetchFile: reader.fetchFile,
    rangeRead: reader.rangeRead,
  };
}

module.exports = {
  API_MAX_BYTES,
  HF_ENDPOINT,
  REVISION_PATTERN,
  createHfClient,
  encodePath,
  fileUrl,
  normalizeEndpoint,
  requestHeaders,
  resolveEndpoints,
};
