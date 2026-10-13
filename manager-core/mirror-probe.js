"use strict";

// Timed range downloads against the three sources a download can actually use:
// huggingface.co, hf-mirror.com and ModelScope. CDN resolve paths, not API
// round-trips, so the numbers reflect what a real transfer would see. Read
// only, no side effects.
const { suggestModelScopeRepo } = require("./repo-mirrors");

const DEFAULT_PROBE_REPO = "Qwen/Qwen2.5-0.5B-Instruct";
const DEFAULT_PROBE_FILE = "config.json";
const PROBE_RANGE_BYTES = 2 * 1024 * 1024;
const SOURCE_LABELS = {
  official: "huggingface.co",
  mirror: "hf-mirror.com",
  modelscope: "modelscope.cn",
};

function encodeRepo(repo) {
  return String(repo || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function probeUrl(source, repo, file) {
  if (source === "modelscope") return `https://www.modelscope.cn/models/${encodeRepo(repo)}/resolve/master/${file}`;
  const base = source === "mirror" ? "https://hf-mirror.com" : "https://huggingface.co";
  return `${base}/${encodeRepo(repo)}/resolve/main/${file}`;
}

async function timeProbe(fetchImpl, source, repo, file, options = {}) {
  const timeoutMs = Math.max(2000, Number(options.timeoutMs || 12_000));
  const url = probeUrl(source, repo, file);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: {
        range: `bytes=0-${PROBE_RANGE_BYTES - 1}`,
        "user-agent": "local-model-manager-mirror-probe/2.0",
        // Only huggingface.co itself may see a Hugging Face token; never the
        // third-party mirror or ModelScope.
        ...(options.token && source === "official" ? { authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok && response.status !== 206) {
      return { source, label: SOURCE_LABELS[source], repo, ok: false, url, status: response.status, ms: Date.now() - startedAt, bytes: 0, bytesPerSec: 0, error: `HTTP ${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    const ms = Math.max(1, Date.now() - startedAt);
    const bytes = buffer.byteLength;
    return { source, label: SOURCE_LABELS[source], repo, ok: true, url, status: response.status, ms, bytes, bytesPerSec: Math.round(bytes / (ms / 1000)) };
  } catch (error) {
    return { source, label: SOURCE_LABELS[source], repo, ok: false, url, status: 0, ms: Date.now() - startedAt, bytes: 0, bytesPerSec: 0, error: error?.message || String(error) };
  }
}

// Small files give no throughput signal, so latency decides; when both sides
// filled the range, throughput decides with a margin so noise does not flip
// the recommendation.
function pickFaster(candidates) {
  const alive = candidates.filter((item) => item.ok);
  if (!alive.length) return null;
  const byThroughput = alive.every((item) => item.bytes >= PROBE_RANGE_BYTES / 2);
  const sorted = [...alive].sort((a, b) => (byThroughput ? b.bytesPerSec - a.bytesPerSec : a.ms - b.ms));
  const best = sorted[0];
  const official = alive.find((item) => item.source === "official");
  if (official && best.source !== "official") {
    const clearlyFaster = byThroughput ? best.bytesPerSec > official.bytesPerSec * 1.15 : best.ms < official.ms * 0.85;
    if (!clearlyFaster) return official;
  }
  return best;
}

async function probeHfMirrorSpeed(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = String(options.model || "").trim().includes("/") ? String(options.model).trim() : DEFAULT_PROBE_REPO;
  const file = String(options.file || "").trim() || DEFAULT_PROBE_FILE;
  const modelScopeCandidates = options.modelScopeRepo
    ? [String(options.modelScopeRepo)]
    : suggestModelScopeRepo(repo).candidates;

  const [official, mirror] = await Promise.all([
    timeProbe(fetchImpl, "official", repo, file, options),
    timeProbe(fetchImpl, "mirror", repo, file, options),
  ]);
  // ModelScope candidates are tried in order until one exists; a 404 there
  // only means the mapping guess was wrong, not that ModelScope is slow.
  let modelscope = null;
  const modelScopeAttempts = [];
  for (const candidate of modelScopeCandidates.slice(0, 3)) {
    const attempt = await timeProbe(fetchImpl, "modelscope", candidate, file, options);
    modelScopeAttempts.push(attempt);
    if (attempt.ok || attempt.status !== 404) {
      modelscope = attempt;
      break;
    }
  }
  if (!modelscope) {
    modelscope = modelScopeAttempts.at(-1) || { source: "modelscope", label: SOURCE_LABELS.modelscope, repo: "", ok: false, url: "", status: 0, ms: 0, bytes: 0, bytesPerSec: 0, error: "no ModelScope candidate" };
  }

  const best = pickFaster([official, mirror, modelscope]);
  const recommended = best?.source || "official";
  return {
    ok: Boolean(best),
    repo,
    file,
    official,
    mirror,
    modelscope,
    modelScopeRepo: modelscope.ok ? modelscope.repo : "",
    modelScopeCandidates,
    sources: [official, mirror, modelscope],
    recommended,
    recommendedLabel: SOURCE_LABELS[recommended],
    at: new Date().toISOString(),
  };
}

module.exports = { PROBE_RANGE_BYTES, SOURCE_LABELS, pickFaster, probeHfMirrorSpeed, probeUrl };
