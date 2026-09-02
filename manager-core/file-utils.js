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

// Config health registry. A config file that exists but cannot be parsed used
// to fall back to defaults silently -- which quietly turned auth off, because
// the exposure defaults have requireApiKey=false. Corruption now surfaces as an
// error and is recorded here so the UI can show it instead of pretending the
// settings loaded.
const configHealthIssues = new Map();

function recordConfigHealthIssue(file, kind, message) {
  const key = path.resolve(file);
  configHealthIssues.set(key, {
    file: key,
    kind,
    message: String(message || ""),
    at: new Date().toISOString(),
  });
}

function clearConfigHealthIssue(file) {
  configHealthIssues.delete(path.resolve(file));
}

function listConfigHealthIssues() {
  return Array.from(configHealthIssues.values()).sort((a, b) => a.file.localeCompare(b.file));
}

function configCorruptError(file, detail) {
  const error = new Error(`Config file is not valid JSON: ${file} (${detail})`);
  error.code = "CONFIG_CORRUPT";
  error.file = file;
  return error;
}

// Missing is normal and yields the fallback. Present-but-unparseable throws.
async function readJsonFile(file, fallback) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      clearConfigHealthIssue(file);
      return fallback;
    }
    recordConfigHealthIssue(file, "unreadable", error.message);
    throw error;
  }
  if (!String(text).trim()) {
    // A zero-length file is the signature of a truncated write, not an
    // intentionally empty config.
    recordConfigHealthIssue(file, "empty", "File is empty.");
    throw configCorruptError(file, "file is empty");
  }
  try {
    const value = JSON.parse(text);
    clearConfigHealthIssue(file);
    return value;
  } catch (error) {
    recordConfigHealthIssue(file, "corrupt", error.message);
    throw configCorruptError(file, error.message);
  }
}

// For optional, user-editable data files where falling back to a built-in
// default is the correct behaviour. Still records the issue for the UI.
async function readJsonFileTolerant(file, fallback) {
  try {
    return await readJsonFile(file, fallback);
  } catch {
    return fallback;
  }
}

async function inspectJsonFile(file) {
  try {
    await readJsonFile(file, null);
    return { file: path.resolve(file), ok: true, kind: "", message: "" };
  } catch (error) {
    return {
      file: path.resolve(file),
      ok: false,
      kind: error.code === "CONFIG_CORRUPT" ? "corrupt" : "unreadable",
      message: error.message,
    };
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
    await replaceFileAtomically(temp, file);
    return value;
  });
}

// Windows can transiently reject a replace while another process has the
// destination open. Retry the atomic rename before resorting to a copy, since a
// copy that dies midway leaves a truncated config -- exactly the state that
// used to disable auth silently.
async function replaceFileAtomically(temp, file, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fsp.rename(temp, file);
      return;
    } catch (error) {
      const retryable = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!retryable) throw error;
      if (attempt === attempts) {
        await fsp.copyFile(temp, file);
        await fsp.rm(temp, { force: true });
        return;
      }
      await delay(25 * attempt);
    }
  }
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
  readJsonFileTolerant,
  inspectJsonFile,
  listConfigHealthIssues,
  recordConfigHealthIssue,
  clearConfigHealthIssue,
  writeJsonFile,
  withFileWriteQueue,
  flushFileWriteQueues,
  atomicWriteJsonFile,
  replaceFileAtomically,
  withFileLock,
  removeStaleLock,
  sha256File,
  hashFilesInDir,
};
