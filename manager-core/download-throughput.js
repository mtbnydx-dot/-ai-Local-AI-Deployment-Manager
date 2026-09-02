"use strict";

// Watches the average transfer rate of a running download and raises one hint
// when it has been crawling long enough that switching source is worth it.
// There is no native rate limiting in hf/modelscope, so the advisor only
// advises; it never touches the process.

function createThroughputAdvisor(options = {}) {
  const minSampleMs = Math.max(30_000, Number(options.minSampleMs || 180_000));
  const slowBytesPerSec = Math.max(1, Number(options.slowBytesPerSec || 1_000_000));
  const now = typeof options.now === "function" ? options.now : Date.now;
  let startedAt = null;
  let startBytes = 0;
  let advised = false;

  function observe(downloadedBytes, at = now()) {
    const bytes = Math.max(0, Number(downloadedBytes) || 0);
    if (startedAt === null) {
      startedAt = at;
      startBytes = bytes;
      return null;
    }
    if (advised) return null;
    const elapsedMs = at - startedAt;
    if (elapsedMs < minSampleMs) return null;
    const averageBytesPerSec = Math.max(0, bytes - startBytes) / (elapsedMs / 1000);
    if (averageBytesPerSec >= slowBytesPerSec) return null;
    advised = true;
    return { kind: "slow", averageBytesPerSec, elapsedMs, thresholdBytesPerSec: slowBytesPerSec };
  }

  function reset() {
    startedAt = null;
    startBytes = 0;
    advised = false;
  }

  return { observe, reset };
}

function formatSlowDownloadHint(advice, context = {}) {
  const formatBytes = context.formatBytes || ((value) => `${Math.round(value / 1024)} KB`);
  const minutes = Math.max(1, Math.round(advice.elapsedMs / 60000));
  const alternatives = [];
  if (context.source !== "modelscope") {
    if (!context.hfMirror) alternatives.push("在下载设置里开启 hf-mirror 镜像");
    if (context.modelScopeRepo) alternatives.push(`改用 ModelScope 同源仓 ${context.modelScopeRepo}`);
    else alternatives.push("用「测速选镜像」看 ModelScope 是否有同源仓");
  } else {
    alternatives.push("改用 Hugging Face 官方源或 hf-mirror");
  }
  return `近 ${minutes} 分钟平均速度 ${formatBytes(advice.averageBytesPerSec)}/s，低于 ${formatBytes(advice.thresholdBytesPerSec)}/s。可以暂停后${alternatives.join("，或")}，再点继续从已下载部分续传。`;
}

module.exports = { createThroughputAdvisor, formatSlowDownloadHint };
