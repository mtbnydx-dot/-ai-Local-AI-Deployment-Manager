"use strict";

// Hub data directory (03 §3): <AI_ROOT>/service-entry/data/hub/ with
// downloads.json, library.json, settings.json, migrations.json, the
// downloads-history.jsonl log, logs/ and migration/ snapshots. Nothing here
// is a secret (§17).
//
// Every JSON file is replaced atomically: the new bytes go to a temp file in
// the same directory, are flushed, and a rename swaps them in. A crash
// therefore leaves either the old file or the new one, never a torn one. A
// temp file a crash left behind is never read (reads open only the real
// name), and init() sweeps it. The entry is the only writer, so writes to one
// file are serialized in process. downloads.json carries a writerPid and
// heartbeatAt stamp, which lets another process (the storage busy-path
// probe, 03 §8) tell a live hub from a stale file.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { replaceFileAtomically } = require("../file-utils");

const STORE_SCHEMA_VERSION = 1;
const HUB_FILES = Object.freeze({
  downloads: "downloads.json",
  library: "library.json",
  settings: "settings.json",
  migrations: "migrations.json",
});
const HISTORY_FILE = "downloads-history.jsonl";
const LOGS_DIR = "logs";
const MIGRATION_DIR = "migration";
const TEMP_SUFFIX = ".tmp";
// A writer that has not stamped downloads.json for this long is gone (03 §8).
const WRITER_STALE_MS = 2 * 60 * 1000;
const RENAME_ATTEMPTS = 12;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The file operations a write goes through. Tests swap them to simulate a
// crash between the temp write and the rename.
const DEFAULT_IO = Object.freeze({
  async writeFile(file, text) {
    const handle = await fsp.open(file, "w");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => replaceFileAtomically(from, to, RENAME_ATTEMPTS),
  writeFileSync(file, text) {
    const fd = fs.openSync(file, "w");
    try {
      fs.writeSync(fd, text, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  // The synchronous twin of replaceFileAtomically: Windows can refuse a
  // replace for a moment while a scanner holds the destination open.
  renameSync(from, to) {
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
      try {
        fs.renameSync(from, to);
        return;
      } catch (error) {
        const retryable = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
        if (!retryable) throw error;
        if (attempt === RENAME_ATTEMPTS) {
          fs.copyFileSync(from, to);
          fs.rmSync(from, { force: true });
          return;
        }
        sleepSync(25 * attempt);
      }
    }
  },
});

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

/**
 * Whether a downloads.json document was stamped by a hub that is still
 * running: its writerPid is alive and heartbeatAt is under two minutes old.
 * The storage busy-path probe (03 §8) reads hub jobs only then.
 */
function hubWriterIsLive(doc, options = {}) {
  if (!isPlainObject(doc)) return false;
  const now = Number(options.now ?? Date.now());
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : WRITER_STALE_MS;
  const isAlive = typeof options.isPidAlive === "function" ? options.isPidAlive : isProcessAlive;
  const at = Date.parse(String(doc.heartbeatAt || ""));
  if (!Number.isFinite(at) || now - at > maxAgeMs || at - now > maxAgeMs) return false;
  return Boolean(isAlive(Number(doc.writerPid)));
}

function createHubStore(options = {}) {
  if (!options.dataDir) throw new TypeError("createHubStore needs a dataDir");
  const dataDir = path.resolve(String(options.dataDir));
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const pid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const io = { ...DEFAULT_IO, ...(isPlainObject(options.io) ? options.io : {}) };
  const historyFile = path.join(dataDir, HISTORY_FILE);
  const queues = new Map();
  const pendingTemps = new Set();
  // Per file: the sequence number of the newest write handed in and of the
  // newest one on disk. An async write overtaken by a synchronous one (the
  // shutdown flush) drops its temp instead of renaming older data over it.
  const issued = new Map();
  const committed = new Map();

  function fileOf(name) {
    if (!Object.hasOwn(HUB_FILES, name)) throw new TypeError(`unknown hub data file: ${name}`);
    return path.join(dataDir, HUB_FILES[name]);
  }

  function nextSequence(file) {
    const value = (issued.get(file) || 0) + 1;
    issued.set(file, value);
    return value;
  }

  function tempPathFor(file) {
    const stamp = `${pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
    return path.join(path.dirname(file), `.${path.basename(file)}.${stamp}${TEMP_SUFFIX}`);
  }

  function isTempOfHubFile(name) {
    if (!name.endsWith(TEMP_SUFFIX)) return false;
    return [...Object.values(HUB_FILES), HISTORY_FILE].some((base) => name.startsWith(`.${base}.`));
  }

  // One chain per file. The stored tail never rejects, so a failed write
  // does not stop the ones queued behind it.
  function enqueue(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task);
    const tail = next.catch(() => {});
    queues.set(key, tail);
    tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  }

  function serialize(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  // Creates the directory tree and removes temp files a crash left behind.
  // Temps of writes still in flight in this process are kept.
  async function init() {
    await fsp.mkdir(path.join(dataDir, LOGS_DIR), { recursive: true });
    await fsp.mkdir(path.join(dataDir, MIGRATION_DIR), { recursive: true });
    const removed = [];
    let names = [];
    try {
      names = await fsp.readdir(dataDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const full = path.join(dataDir, name);
      if (!isTempOfHubFile(name) || pendingTemps.has(full)) continue;
      try {
        await fsp.rm(full, { force: true });
        removed.push(name);
      } catch {
        // A temp the OS still holds is swept on the next start.
      }
    }
    return { removedTemps: removed };
  }

  // { exists, value, error }. A missing file is not an error; a file that is
  // not a JSON object is { code: "corrupt" } and value null. Messages name the
  // file by its base name only.
  function read(name) {
    const file = fileOf(name);
    const base = path.basename(file);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, value: null, error: null, file };
      return { exists: true, value: null, file, error: { code: "unreadable", message: `${base} could not be read (${error?.code || "error"}).` } };
    }
    let value;
    try {
      value = JSON.parse(stripBom(text));
    } catch (error) {
      return { exists: true, value: null, file, error: { code: "corrupt", message: `${base} is not valid JSON (${error.message}).` } };
    }
    if (!isPlainObject(value)) {
      return { exists: true, value: null, file, error: { code: "corrupt", message: `${base} does not hold a JSON object.` } };
    }
    return { exists: true, value, error: null, file };
  }

  // Atomic replace; resolves with the value once it is on disk.
  function write(name, value) {
    const file = fileOf(name);
    const text = serialize(value);
    const sequence = nextSequence(file);
    return enqueue(file, async () => {
      if ((committed.get(file) || 0) > sequence) return value;
      await fsp.mkdir(dataDir, { recursive: true });
      const temp = tempPathFor(file);
      pendingTemps.add(temp);
      try {
        await io.writeFile(temp, text);
        if ((committed.get(file) || 0) > sequence) {
          await fsp.rm(temp, { force: true }).catch(() => {});
          return value;
        }
        await io.rename(temp, file);
        committed.set(file, Math.max(committed.get(file) || 0, sequence));
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
      } finally {
        pendingTemps.delete(temp);
      }
      return value;
    });
  }

  // The same atomic replace without yielding, for the shutdown flush: it
  // completes even when the process exits right after it.
  function writeSync(name, value) {
    const file = fileOf(name);
    const text = serialize(value);
    const sequence = nextSequence(file);
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = tempPathFor(file);
    try {
      io.writeFileSync(temp, text);
      io.renameSync(temp, file);
      committed.set(file, Math.max(committed.get(file) || 0, sequence));
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // init() sweeps it on the next start.
      }
      throw error;
    }
    return value;
  }

  function stamp(doc) {
    const base = isPlainObject(doc) ? doc : {};
    return {
      schemaVersion: Number.isInteger(base.schemaVersion) ? base.schemaVersion : STORE_SCHEMA_VERSION,
      ...base,
      writerPid: pid,
      heartbeatAt: new Date(clock.now()).toISOString(),
    };
  }

  // downloads.json as { schemaVersion, writerPid, heartbeatAt, jobs }.
  function readDownloads() {
    const result = read("downloads");
    const doc = result.value || {};
    return {
      ...result,
      value: result.error ? null : {
        schemaVersion: Number.isInteger(doc.schemaVersion) ? doc.schemaVersion : STORE_SCHEMA_VERSION,
        writerPid: Number.isInteger(doc.writerPid) ? doc.writerPid : null,
        heartbeatAt: typeof doc.heartbeatAt === "string" ? doc.heartbeatAt : null,
        jobs: Array.isArray(doc.jobs) ? doc.jobs.filter(isPlainObject) : [],
      },
    };
  }

  function writeDownloads(doc, { sync = false } = {}) {
    const value = stamp({ ...(isPlainObject(doc) ? doc : {}), jobs: Array.isArray(doc?.jobs) ? doc.jobs : [] });
    return sync ? writeSync("downloads", value) : write("downloads", value);
  }

  // Appends terminal job records as JSON lines. A line torn by a crash is
  // closed off first, so it can never swallow the next record.
  function appendHistory(records) {
    const list = (Array.isArray(records) ? records : [records]).filter(isPlainObject);
    if (!list.length) return Promise.resolve(0);
    const text = list.map((record) => JSON.stringify(record)).join("\n");
    return enqueue(historyFile, async () => {
      await fsp.mkdir(dataDir, { recursive: true });
      let lead = "";
      try {
        const handle = await fsp.open(historyFile, "r");
        try {
          const { size } = await handle.stat();
          if (size > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            if (last[0] !== 0x0a) lead = "\n";
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fsp.appendFile(historyFile, `${lead}${text}\n`, "utf8");
      return list.length;
    });
  }

  // Every intact record; lines that do not parse (a torn tail) are skipped
  // and counted.
  function readHistory() {
    let text = "";
    try {
      text = fs.readFileSync(historyFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { records: [], skipped: 0 };
      throw error;
    }
    const records = [];
    let skipped = 0;
    for (const line of stripBom(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (isPlainObject(record)) records.push(record);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return { records, skipped };
  }

  // Keeps the history records `keep(record)` accepts (the queue prunes
  // records older than history.retentionDays at start, 03 §8). The file is
  // replaced atomically in the same chain as appendHistory, so an append is
  // never lost to the rewrite. Resolves to the number of records removed.
  function rewriteHistory(keep) {
    return enqueue(historyFile, async () => {
      const { records } = readHistory();
      const kept = records.filter((record) => keep(record));
      const removed = records.length - kept.length;
      if (!removed) return 0;
      await fsp.mkdir(dataDir, { recursive: true });
      const temp = tempPathFor(historyFile);
      pendingTemps.add(temp);
      try {
        await io.writeFile(temp, kept.map((record) => `${JSON.stringify(record)}
`).join(""));
        await io.rename(temp, historyFile);
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
      } finally {
        pendingTemps.delete(temp);
      }
      return removed;
    });
  }

  // Resolves once every write handed in so far has settled.
  async function flush() {
    while (queues.size) {
      await Promise.allSettled([...queues.values()]);
    }
  }

  return {
    dataDir,
    historyFile,
    logsDir: path.join(dataDir, LOGS_DIR),
    migrationDir: path.join(dataDir, MIGRATION_DIR),
    fileOf,
    init,
    read,
    write,
    writeSync,
    stamp,
    readDownloads,
    writeDownloads,
    appendHistory,
    readHistory,
    rewriteHistory,
    flush,
  };
}

module.exports = {
  HISTORY_FILE,
  HUB_FILES,
  STORE_SCHEMA_VERSION,
  WRITER_STALE_MS,
  createHubStore,
  hubWriterIsLive,
};
