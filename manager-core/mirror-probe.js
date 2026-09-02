"use strict";

// 对官方 Hugging Face 与 hf-mirror 各做一次小体积计时下载（CDN resolve 路径，
// 不是纯 API RTT），给「自动选镜像」提供数据。只读、无副作用。
const DEFAULT_PROBE_REPO = "Qwen/Qwen2.5-0.5B-Instruct";
const DEFAULT_PROBE_FILE = "config.json";
const PROBE_RANGE_BYTES = 2 * 1024 * 1024;

async function timeProbe(fetchImpl, base, repo, file, options = {}) {
  const timeoutMs = Math.max(2000, Number(options.timeoutMs || 12_000));
  const url = `${base}/${repo}/resolve/main/${file}`;
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: {
        range: `bytes=0-${PROBE_RANGE_BYTES - 1}`,
        "user-agent": "local-model-manager-mirror-probe/1.0",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok && response.status !== 206) {
      return { ok: false, url, status: response.status, ms: Date.now() - startedAt, bytes: 0, bytesPerSec: 0, error: `HTTP ${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    const ms = Math.max(1, Date.now() - startedAt);
    const bytes = buffer.byteLength;
    return { ok: true, url, status: response.status, ms, bytes, bytesPerSec: Math.round(bytes / (ms / 1000)) };
  } catch (error) {
    return { ok: false, url, status: 0, ms: Date.now() - startedAt, bytes: 0, bytesPerSec: 0, error: error?.message || String(error) };
  }
}

async function probeHfMirrorSpeed(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repo = String(options.model || "").trim().includes("/") ? String(options.model).trim() : DEFAULT_PROBE_REPO;
  const file = String(options.file || "").trim() || DEFAULT_PROBE_FILE;
  const [official, mirror] = await Promise.all([
    timeProbe(fetchImpl, "https://huggingface.co", repo, file, options),
    timeProbe(fetchImpl, "https://hf-mirror.com", repo, file, options),
  ]);
  let recommended = "official";
  if (mirror.ok && !official.ok) recommended = "mirror";
  else if (mirror.ok && official.ok) {
    // 小文件时吞吐没有区分度，用耗时；两边都拿满 range 时用吞吐。
    const byThroughput = mirror.bytes >= PROBE_RANGE_BYTES / 2 && official.bytes >= PROBE_RANGE_BYTES / 2;
    recommended = byThroughput
      ? (mirror.bytesPerSec > official.bytesPerSec * 1.15 ? "mirror" : "official")
      : (mirror.ms < official.ms * 0.85 ? "mirror" : "official");
  }
  return {
    ok: official.ok || mirror.ok,
    repo,
    file,
    official,
    mirror,
    recommended,
    recommendedLabel: recommended === "mirror" ? "hf-mirror.com" : "huggingface.co",
    at: new Date().toISOString(),
  };
}

module.exports = { probeHfMirrorSpeed };
