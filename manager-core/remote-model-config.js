"use strict";

// Fetches a repository's config.json without downloading the model, so the
// pre-download check can look at the declared architecture / quantization.
// Both hubs serve raw files: Hugging Face under /resolve/main, ModelScope
// under /resolve/master.

const DEFAULT_TIMEOUT_MS = 12_000;

function encodeRepoPath(model) {
  return String(model || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function remoteConfigUrl(source, model, options = {}) {
  const repo = encodeRepoPath(model);
  if (String(source || "").toLowerCase() === "modelscope") {
    return `${options.modelScopeEndpoint || "https://www.modelscope.cn"}/models/${repo}/resolve/master/${options.file || "config.json"}`;
  }
  return `${options.hfEndpoint || "https://huggingface.co"}/${repo}/resolve/main/${options.file || "config.json"}`;
}

async function fetchRemoteModelConfig(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const source = String(options.source || "huggingface").toLowerCase() === "modelscope" ? "modelscope" : "huggingface";
  const model = String(options.model || "").trim();
  if (!model || !model.includes("/")) return { ok: false, source, model, status: 0, config: null, reason: "model id must look like owner/name" };
  const url = remoteConfigUrl(source, model, options);
  const headers = { accept: "application/json", "user-agent": "local-model-manager-precheck/1.0" };
  if (source === "huggingface" && options.token) headers.authorization = `Bearer ${options.token}`;
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(2000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))),
    });
    if (response.status === 404) return { ok: false, source, model, status: 404, url, config: null, reason: "仓库没有 config.json（GGUF 仓库通常如此）" };
    if (response.status === 401 || response.status === 403) return { ok: false, source, model, status: response.status, url, config: null, gated: true, reason: "需要授权才能读取 config.json" };
    if (!response.ok) return { ok: false, source, model, status: response.status, url, config: null, reason: `HTTP ${response.status}` };
    const text = await response.text();
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      return { ok: false, source, model, status: response.status, url, config: null, reason: "config.json 不是合法 JSON" };
    }
    if (!config || typeof config !== "object") return { ok: false, source, model, status: response.status, url, config: null, reason: "config.json 为空" };
    return { ok: true, source, model, status: response.status, url, config };
  } catch (error) {
    return { ok: false, source, model, status: 0, url, config: null, reason: error?.message || String(error) };
  }
}

module.exports = {
  encodeRepoPath,
  fetchRemoteModelConfig,
  remoteConfigUrl,
};
