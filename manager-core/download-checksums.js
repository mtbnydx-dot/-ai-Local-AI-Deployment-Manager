"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function normalizeManifest(manifest) {
  return (Array.isArray(manifest) ? manifest : [])
    .map((item) => ({
      name: String(item?.name || "").trim().replaceAll("\\", "/"),
      size: Number(item?.size || 0),
      sha256: String(item?.sha256 || "").toLowerCase(),
    }))
    .filter((item) => item.name && !item.name.includes("..") && /^[0-9a-f]{64}$/.test(item.sha256));
}

// 用 Hugging Face LFS 清单（?blobs=true 的 lfs.oid）逐文件流式校验 SHA256。
// 只报告结果，不做任何删除；由调用方决定如何处置坏文件。
async function verifyDownloadChecksums(localDir, manifest, options = {}) {
  const root = path.resolve(String(localDir || ""));
  const entries = normalizeManifest(manifest);
  const onFile = typeof options.onFile === "function" ? options.onFile : () => {};
  // The model hub's hash worker passes a hasher that reports progress (03 §3).
  const hashFile = typeof options.sha256File === "function" ? options.sha256File : sha256File;
  const result = { checked: 0, matched: 0, mismatched: [], missing: [], totalBytes: 0 };
  for (const entry of entries) {
    const filePath = path.resolve(root, entry.name);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) continue;
    let stat = null;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      result.missing.push(entry.name);
      onFile({ name: entry.name, status: "missing" });
      continue;
    }
    if (!stat.isFile()) {
      result.missing.push(entry.name);
      onFile({ name: entry.name, status: "missing" });
      continue;
    }
    if (entry.size > 0 && stat.size !== entry.size) {
      result.checked += 1;
      result.mismatched.push({ name: entry.name, reason: "size", expected: entry.size, actual: stat.size });
      onFile({ name: entry.name, status: "size-mismatch" });
      continue;
    }
    const digest = await hashFile(filePath, entry);
    result.checked += 1;
    result.totalBytes += stat.size;
    if (digest === entry.sha256) {
      result.matched += 1;
      onFile({ name: entry.name, status: "ok", bytes: stat.size });
    } else {
      result.mismatched.push({ name: entry.name, reason: "sha256", expected: entry.sha256, actual: digest });
      onFile({ name: entry.name, status: "sha256-mismatch" });
    }
  }
  result.ok = result.mismatched.length === 0 && result.missing.length === 0;
  return result;
}

// 下载成功后的可选 SHA256 步骤：坏文件删除后抛错，让自动续传只补这些分片。
function createDownloadChecksumRunner(options = {}) {
  const appendLog = options.appendLog;
  const getSettings = options.getSettings;
  const formatBytes = options.formatBytes || ((value) => `${value} B`);
  if (typeof appendLog !== "function" || typeof getSettings !== "function") {
    throw new Error("createDownloadChecksumRunner requires appendLog and getSettings.");
  }

  return async function runDownloadChecksumVerification(job) {
    const manifest = normalizeManifest(job?.meta?.fileManifest);
    if (!manifest.length) return null;
    if (getSettings().verifyChecksums === false) {
      appendLog(job, "SHA256 校验已在下载设置中关闭，跳过。");
      return null;
    }
    const localDir = path.resolve(String(job.meta?.localDir || ""));
    if (!localDir) return null;
    const totalManifestBytes = manifest.reduce((sum, item) => sum + (item.size || 0), 0);
    appendLog(job, `开始 SHA256 校验：${manifest.length} 个权重文件、约 ${formatBytes(totalManifestBytes)}（清单来自 Hugging Face LFS）。`);
    const startedAt = Date.now();
    const result = await verifyDownloadChecksums(localDir, manifest, {
      onFile: ({ name, status, bytes }) => {
        if (status === "ok") appendLog(job, `SHA256 OK: ${name} (${formatBytes(bytes || 0)})`);
      },
    });
    job.meta = {
      ...(job.meta || {}),
      checksum: {
        checked: result.checked,
        matched: result.matched,
        mismatched: result.mismatched.map((item) => item.name),
        missing: result.missing,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        at: new Date().toISOString(),
      },
    };
    if (result.mismatched.length) {
      for (const item of result.mismatched) {
        const target = path.resolve(localDir, item.name);
        if (target === localDir || !target.startsWith(localDir + path.sep)) continue;
        await fsp.rm(target, { force: true }).catch(() => {});
        appendLog(job, `已删除校验失败的文件：${item.name}（${item.reason === "size" ? "大小不符" : "SHA256 不符"}）`);
      }
      throw new Error(`SHA256 校验失败：${result.mismatched.length} 个文件与 Hugging Face 清单不一致，已删除损坏文件；继续下载会只重新获取这些文件。`);
    }
    if (result.missing.length) {
      throw new Error(`下载清单中 ${result.missing.length} 个权重文件缺失：${result.missing.join("、")}。任务不能标记为成功，请继续下载补齐。`);
    }
    appendLog(job, `SHA256 校验通过：${result.matched}/${result.checked} 个文件、${formatBytes(result.totalBytes)}，耗时 ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} 秒。`);
    return result;
  };
}

module.exports = {
  createDownloadChecksumRunner,
  normalizeChecksumManifest: normalizeManifest,
  verifyDownloadChecksums,
};
