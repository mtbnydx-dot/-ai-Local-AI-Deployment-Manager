"use strict";

// ModelScope client of the remote inspector (docs/overhaul/02-models.md §6).
//
//   GET {endpoint}/api/v1/models/{owner}/{name}/repo/files?Recursive=true&Revision={rev}
//       -> Data.Files[{Path, Size, Sha256, Type, Revision}]
//   GET {endpoint}/models/{repo}/resolve/{rev}/{file}   small files and Range reads
//
// Public repositories only, and no credential of any kind is ever attached
// (the HF token never leaves Hugging Face). ModelScope may not honour Range;
// then the header-derived facts stay unknown (never fabricated). `hasConfig`
// is a fact of the file list, not a constant.

const { REPO_ID } = require("../detectors/hf-config");
const {
  DEFAULT_MAX_BYTES, RemoteError, createRepoReader, discard, fetchChecked, readBody,
} = require("./range-reader");
const { encodePath, normalizeEndpoint } = require("./hf");

const MODELSCOPE_ENDPOINT = "https://www.modelscope.cn";
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const API_MAX_BYTES = 16 * 1024 * 1024;

function resolveEndpoint({ endpoint, mirrors } = {}) {
  const official = normalizeEndpoint(MODELSCOPE_ENDPOINT);
  if (!endpoint) return official;
  const chosen = normalizeEndpoint(endpoint);
  const host = new URL(chosen.origin).hostname.toLowerCase();
  const modelScopeHost = host === "modelscope.cn" || host.endsWith(".modelscope.cn");
  const listed = Array.isArray(mirrors) && mirrors.some((item) => {
    try {
      return normalizeEndpoint(item).origin === chosen.origin;
    } catch {
      return false;
    }
  });
  if (!modelScopeHost && !listed) {
    throw new RemoteError("endpoint_not_allowed", "The endpoint is not a ModelScope endpoint.");
  }
  return chosen;
}

/** {endpoint}/models/{repo}/resolve/{revision}/{file} */
function fileUrl(repo, revision, file, endpoint = MODELSCOPE_ENDPOINT) {
  const { base } = normalizeEndpoint(endpoint);
  return `${base}/models/${encodePath(repo)}/resolve/${encodeURIComponent(revision)}/${encodePath(file)}`;
}

function listFilesUrl(repo, revision, endpoint = MODELSCOPE_ENDPOINT) {
  const { base } = normalizeEndpoint(endpoint);
  return `${base}/api/v1/models/${encodePath(repo)}/repo/files?Recursive=true&Revision=${encodeURIComponent(revision)}`;
}

function normalizeFiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && String(item.Type || "blob").toLowerCase() !== "tree")
    .map((item) => ({
      name: String(item.Path || item.Name || ""),
      size: Number(item.Size) || 0,
      sha256: /^[0-9a-f]{64}$/.test(String(item.Sha256 || "")) ? String(item.Sha256) : null,
    }))
    .filter((item) => item.name);
}

/**
 * createModelScopeClient({repo, revision, endpoint, mirrors, fetchImpl, readRange, budget, maxBytes})
 * -> {source: "modelscope", endpoint, info(), fileUrl(name), fetchFile, rangeRead}
 * Same shape as the Hugging Face client (hf.js). `token` is not an option.
 */
function createModelScopeClient({
  repo, revision = "master", endpoint, mirrors, fetchImpl, readRange, budget, maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!REPO_ID.test(String(repo || ""))) throw new RemoteError("invalid_repo", "The repository id must look like owner/name.");
  if (!REVISION_PATTERN.test(String(revision || ""))) throw new RemoteError("invalid_repo", "The revision is not valid.");
  const chosen = resolveEndpoint({ endpoint, mirrors });
  const headersFor = () => ({ accept: "application/json" });
  const reader = createRepoReader({
    fileUrl: (name) => fileUrl(repo, revision, name, chosen.base),
    headersFor,
    fetchImpl,
    readRange,
    budget,
    maxBytes,
  });

  async function info() {
    budget.check();
    const { response } = await fetchChecked(listFilesUrl(repo, revision, chosen.base), {
      fetchImpl, headersFor, signal: budget.signal, timeoutMs: budget.timeoutFor(),
    });
    const { status } = response;
    if (status === 401 || status === 403) {
      await discard(response);
      throw new RemoteError("gated", "The repository is private or needs authorization; ModelScope is read without credentials.", { status });
    }
    if (status === 404) {
      await discard(response);
      throw new RemoteError("repo_not_found", "The repository or revision was not found.", { status });
    }
    if (status === 429) {
      await discard(response);
      throw new RemoteError("rate_limited", "ModelScope is rate limiting requests.", { status });
    }
    if (status !== 200) {
      await discard(response);
      throw new RemoteError("http_error", `ModelScope answered HTTP ${status}.`, { status });
    }
    let body;
    try {
      body = JSON.parse((await readBody(response, API_MAX_BYTES)).buffer.toString("utf8"));
    } catch {
      throw new RemoteError("bad_response", "ModelScope answered something that is not JSON.");
    }
    if (!body || typeof body !== "object") throw new RemoteError("bad_response", "ModelScope answered an unexpected document.");
    if (body.Success === false || (Number.isFinite(Number(body.Code)) && Number(body.Code) !== 200)) {
      throw new RemoteError("repo_not_found", "ModelScope does not list this repository or revision.", { status: 404 });
    }
    return {
      sha: null,
      files: normalizeFiles(body.Data?.Files),
      gated: false,
      downloads: null,
      likes: null,
      lastModified: null,
      pipelineTag: null,
      libraryName: null,
      safetensors: null,
      gguf: null,
      config: null,
      baseModel: null,
    };
  }

  return {
    source: "modelscope",
    endpoint: chosen.base,
    info,
    fileUrl: (name) => fileUrl(repo, revision, name, chosen.base),
    fetchFile: reader.fetchFile,
    rangeRead: reader.rangeRead,
  };
}

module.exports = {
  MODELSCOPE_ENDPOINT,
  REVISION_PATTERN,
  createModelScopeClient,
  fileUrl,
  listFilesUrl,
  resolveEndpoint,
};
