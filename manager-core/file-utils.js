const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const fileWriteQueues = new Map();

function firstExisting(candidates) {
  const valid = (candidates || []).filter(Boolean);
  for (const candidate of valid) {
    if (looksLikePath(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return valid[valid.length - 1] || "";
}

function looksLikePath(value) {
  const text = String(value || "");
  if (!text) return false;
  return path.isAbsolute(text) || /[\\/]/.test(text);
}

async function ensureDirs(...dirs) {
  await Promise.all(dirs.filter(Boolean).map((dir) => fsp.mkdir(dir, { recursive: true })));
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  return withFileWriteQueue(file, () => atomicWriteJsonFile(file, value));
}

function withFileWriteQueue(file, task) {
  const key = path.resolve(file);
  const previous = fileWriteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  fileWriteQueues.set(key, next.finally(() => {
    if (fileWriteQueues.get(key) === next) fileWriteQueues.delete(key);
  }));
  return next;
}

async function flushFileWriteQueues() {
  await Promise.allSettled(Array.from(fileWriteQueues.values()));
}

async function atomicWriteJsonFile(file, value) {
  await ensureDirs(path.dirname(file));
  return withFileLock(file, async () => {
    const name = path.basename(file);
    const temp = path.join(path.dirname(file), `.${name}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(temp, file);
    return value;
  });
}

async function withFileLock(file, task) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      await fsp.mkdir(lockDir);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() > deadline) throw error;
      await removeStaleLock(lockDir, 30000);
      await delay(50);
    }
  }
  try {
    return await task();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function removeStaleLock(lockDir, maxAgeMs) {
  try {
    const stat = await fsp.stat(lockDir);
    if (Date.now() - stat.mtimeMs > maxAgeMs) {
      await fsp.rm(lockDir, { recursive: true, force: true });
    }
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashFilesInDir(dir) {
  const results = [];
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const relative = path.relative(dir, full).replace(/\\/g, "/");
        results.push({ relative, sha256: await sha256File(full) });
      }
    }
  }
  await walk(dir);
  return results.sort((a, b) => a.relative.localeCompare(b.relative));
}

module.exports = {
  firstExisting,
  looksLikePath,
  ensureDirs,
  readJsonFile,
  writeJsonFile,
  withFileWriteQueue,
  flushFileWriteQueues,
  atomicWriteJsonFile,
  withFileLock,
  removeStaleLock,
  sha256File,
  hashFilesInDir,
};
