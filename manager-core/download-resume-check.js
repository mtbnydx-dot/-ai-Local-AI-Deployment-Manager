"use strict";

// "Health check" shown before a paused or failed download is resumed: which
// manifest files are already complete, which are partial, how much is left,
// and whether the model disk can take it. Read-only.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

async function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          out.push({ path: full, relative: path.relative(root, full).replaceAll("\\", "/"), size: stat.size });
        } catch {
          // A file vanishing mid-scan is normal while a download is being cleaned up.
        }
      }
    }
  }
  return out;
}

// Free space on the disk that holds the job's own directory. Storage roots can
// live on different drives, so the default models root says nothing about a
// download into another library. The directory may not exist yet (a fresh or
// deleted download), so the nearest existing ancestor is measured.
async function measureDiskFreeBytes(localDir, statfs = fsp.statfs) {
  let target = path.dirname(path.resolve(String(localDir || "")));
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stat = await statfs(target);
      const free = Number(stat.bavail) * Number(stat.bsize);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch {
      const parent = path.dirname(target);
      if (parent === target) return null;
      target = parent;
    }
  }
  return null;
}

function isIncompleteFile(relative) {
  return /\.incomplete$/i.test(relative) || /(^|\/)\.cache\/huggingface\/download\//i.test(relative) || /(^|\/)\._{3,}temp(\/|$)/i.test(relative);
}

async function inspectDownloadResume(options = {}) {
  const localDir = path.resolve(String(options.localDir || ""));
  const manifest = (Array.isArray(options.fileManifest) ? options.fileManifest : [])
    .map((item) => ({ name: String(item?.name || "").replaceAll("\\", "/"), size: Number(item?.size || 0) || 0 }))
    .filter((item) => item.name);
  const exists = fs.existsSync(localDir);
  const files = exists ? await walkFiles(localDir) : [];
  const bySize = new Map(files.map((file) => [file.relative.toLowerCase(), file]));
  const incompleteFiles = files.filter((file) => isIncompleteFile(file.relative));
  const partialBytes = incompleteFiles.reduce((sum, file) => sum + file.size, 0);

  const complete = [];
  const partial = [];
  const missing = [];
  for (const entry of manifest) {
    const local = bySize.get(entry.name.toLowerCase());
    if (local && (entry.size === 0 || local.size === entry.size)) {
      complete.push({ name: entry.name, size: local.size });
    } else if (local) {
      partial.push({ name: entry.name, expected: entry.size, actual: local.size });
    } else {
      // Incomplete staging files carry the target name plus a hash suffix.
      const staged = incompleteFiles.find((file) => file.relative.toLowerCase().includes(path.basename(entry.name).toLowerCase()));
      if (staged) partial.push({ name: entry.name, expected: entry.size, actual: staged.size, staged: staged.relative });
      else missing.push({ name: entry.name, size: entry.size });
    }
  }
  const completeBytes = complete.reduce((sum, item) => sum + item.size, 0);
  const partialOnDiskBytes = partial.reduce((sum, item) => sum + (item.actual || 0), 0);
  const manifestBytes = manifest.reduce((sum, item) => sum + item.size, 0);
  const expectedBytes = Number(options.expectedBytes || 0) || manifestBytes || 0;
  const onDiskBytes = files.reduce((sum, file) => sum + file.size, 0);
  const remainingBytes = expectedBytes ? Math.max(0, expectedBytes - completeBytes - partialOnDiskBytes) : null;
  // Callers that pass diskFreeBytes (even null) keep it; omitting it measures
  // the disk the job directory is on.
  const measuredFreeBytes = options.diskFreeBytes === undefined
    ? await measureDiskFreeBytes(localDir, typeof options.statfs === "function" ? options.statfs : undefined)
    : options.diskFreeBytes;
  const diskFreeBytes = Number(measuredFreeBytes || 0) || null;
  const reserve = diskFreeBytes ? Math.max(diskFreeBytes * 0.05, 10 * 1024 ** 3) : 0;
  const diskOk = remainingBytes === null || !diskFreeBytes ? null : remainingBytes <= diskFreeBytes - reserve;

  const notes = [];
  if (!exists) notes.push("本地目录不存在，继续下载会从头开始。");
  if (manifest.length) {
    notes.push(`清单 ${manifest.length} 个文件：${complete.length} 个完整、${partial.length} 个部分、${missing.length} 个缺失。`);
  } else {
    notes.push("没有文件清单（ModelScope 或旧任务），只能按目录体积估算。");
  }
  if (incompleteFiles.length) notes.push(`目录里有 ${incompleteFiles.length} 个 .incomplete 分片，续传会复用它们。`);
  if (diskOk === false) notes.push("模型盘剩余空间不足以完成剩余部分。");

  return {
    localDir,
    exists,
    manifestFiles: manifest.length,
    complete,
    partial,
    missing,
    incompleteFiles: incompleteFiles.length,
    completeBytes,
    partialBytes: Math.max(partialBytes, partialOnDiskBytes),
    onDiskBytes,
    expectedBytes: expectedBytes || null,
    remainingBytes,
    diskFreeBytes,
    diskOk,
    resumable: exists && (complete.length > 0 || partial.length > 0 || incompleteFiles.length > 0 || onDiskBytes > 0),
    notes,
  };
}

module.exports = { inspectDownloadResume, isIncompleteFile, measureDiskFreeBytes };
