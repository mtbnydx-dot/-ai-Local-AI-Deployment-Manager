"use strict";

// Disk accounting of the download queue (03 §8): which drive a target is on,
// how much is free there, and the reserve the queue never fills.
//
//   volumeOf(p)                         "X:" (the drive of the real path), "/" off Windows
//   freeBytes(p, { statfs })            free bytes of the volume holding p (nearest existing ancestor)
//   reserveBytes(free, settings)        max(5 % of free, storage.reserveGb)
//   availableBytes({ free, pending, reserve })   free − pending − reserve, never below 0
//   createDiskGuard({ statfs, volumeOf }) → { volumeOf, freeBytes, reserveBytes }
//
//   computeUsage({ modelStorage, library, queue, hfHome, settings, ... })   03 §13.5
//   runCleanup({ targets, confirm, library, queue })                        POST /storage/cleanup
//
// computeUsage is the root-aware storage view: one row per registered root
// (with the drive it sits on as `volume`, the bytes the queue has yet to
// write there and the reserve it keeps), the models in them, the Hugging Face
// cache, the residue and orphan partial downloads that can be cleaned, and
// the duplicates. There is no per-drive list: the console groups by `volume`.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { measureDiskFreeBytes } = require("../download-resume-check");
const { overlapsPath, pathKey } = require("../model-storage");
const { LibraryError, dirBytes, volumeOf } = require("./library");

const GIB = 1024 ** 3;
const RESERVE_FRACTION = 0.05;
const DEFAULT_RESERVE_GB = 10;

function settingNumber(settings, key, fallback) {
  const source = typeof settings === "function" ? settings() : settings;
  let current = source;
  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return fallback;
    current = current[segment];
  }
  const value = Number(current);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The reserve the queue keeps free on a volume: max(5 % of free, storage.reserveGb). */
function reserveBytes(free, settings) {
  const freeBytes = Number(free);
  const fraction = Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes * RESERVE_FRACTION : 0;
  return Math.round(Math.max(fraction, settingNumber(settings, "storage.reserveGb", DEFAULT_RESERVE_GB) * GIB));
}

/** Free bytes of the volume holding `target`; null when no ancestor can be measured. */
function freeBytes(target, { statfs = fsp.statfs } = {}) {
  // measureDiskFreeBytes starts at the parent, so the target itself need not exist yet.
  return measureDiskFreeBytes(target, statfs);
}

function availableBytes({ free, pending = 0, reserve = 0 } = {}) {
  const value = Number(free) - Math.max(0, Number(pending) || 0) - Math.max(0, Number(reserve) || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** The queue's `disk` dependency; tests replace statfs (or the whole object). */
function createDiskGuard(options = {}) {
  const statfs = typeof options.statfs === "function" ? options.statfs : fsp.statfs;
  const volume = typeof options.volumeOf === "function" ? options.volumeOf : volumeOf;
  return {
    volumeOf: (target) => volume(target),
    freeBytes: (target) => freeBytes(target, { statfs }),
    reserveBytes,
  };
}

// --- storage usage (03 §13.5) ----------------------------------------------------

const TERMINAL_JOB_STATES = Object.freeze(["ready", "failed", "cancelled"]);
// Jobs that are writing (or about to write) their target now.
const WRITING_JOB_STATES = Object.freeze(["resolving", "downloading", "materializing", "verifying"]);
const ORPHAN_SCAN_LIMIT = 200;
const CLEANUP_TARGETS_MAX = 100;
const TASK_WAIT_MS = 120 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jobsOf(options) {
  let list = [];
  try {
    if (typeof options.jobs === "function") list = options.jobs();
    else if (Array.isArray(options.jobs)) list = options.jobs;
    else if (options.queue && typeof options.queue.document === "function") list = options.queue.document().jobs;
  } catch {
    list = [];
  }
  return Array.isArray(list) ? list.filter(isPlainObject) : [];
}

function remainingBytes(job) {
  const total = Number(job?.artifact?.totalBytes) || 0;
  const done = Number(job?.progress?.bytesDone) || 0;
  return Math.max(0, total - done);
}

function activeJobOn(jobs, target) {
  return jobs.find((job) => !TERMINAL_JOB_STATES.includes(job.state) && job.target?.localDir && overlapsPath(job.target.localDir, target)) || null;
}

async function waitForTask(library, taskId, timeoutMs = TASK_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = library.getTask(taskId);
    if (!task || task.state === "succeeded" || task.state === "failed") return task;
    if (Date.now() > deadline) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Terminal downloads that left a folder behind: failed or cancelled jobs
 * whose target still exists, that no live job uses, that are not an update of
 * a library entry (that folder is the model) and that no other download
 * produced a library entry from. Newest job per folder.
 */
async function findOrphanPartials({ jobs, entries, only = null }) {
  const candidates = jobs
    .filter((job) => (job.state === "failed" || job.state === "cancelled") && job.target?.localDir && job.origin?.kind !== "library-update" && (!only || job.id === only))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, ORPHAN_SCAN_LIMIT);
  const seen = new Set();
  const found = [];
  for (const job of candidates) {
    const key = pathKey(job.target.localDir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (activeJobOn(jobs, job.target.localDir)) continue;
    const entry = entries.find((item) => pathKey(item.path) === key);
    if (entry && entry.provenance?.downloadJobId && entry.provenance.downloadJobId !== job.id) continue;
    let stat = null;
    try {
      stat = await fsp.stat(job.target.localDir);
    } catch {
      stat = null;
    }
    if (!stat?.isDirectory()) continue;
    const bytes = await dirBytes(job.target.localDir);
    if (bytes <= 0) continue;
    found.push({ jobId: job.id, rootId: job.target.rootId || null, path: path.resolve(job.target.localDir), bytes, reason: job.state });
  }
  return found;
}

function duplicateGroups(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set();
  const groups = [];
  for (const entry of entries) {
    if (seen.has(entry.id) || !entry.duplicates?.length) continue;
    const ids = new Set();
    const pending = [entry.id];
    while (pending.length) {
      const id = pending.pop();
      if (ids.has(id) || !byId.has(id)) continue;
      ids.add(id);
      pending.push(...(byId.get(id).duplicates || []));
    }
    for (const id of ids) seen.add(id);
    if (ids.size < 2) continue;
    const sizes = [...ids].map((id) => Number(byId.get(id).bytes) || 0);
    groups.push({ entryIds: [...ids].sort(), reclaimableBytes: sizes.reduce((sum, value) => sum + value, 0) - Math.max(...sizes) });
  }
  return groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
}

/**
 * computeUsage(options) → the 03 §13.5 body. `library` and `modelStorage` are
 * required; `queue` (or `jobs`) supplies the live jobs; `settings` is the hub
 * settings (or a getter). `refresh: true` rescans the library first, so the
 * numbers reflect the disk instead of the registry.
 */
async function computeUsage(options = {}) {
  const { modelStorage, library } = options;
  if (!modelStorage || !library) throw new TypeError("computeUsage needs modelStorage and library");
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const statfs = typeof options.statfs === "function" ? options.statfs : fsp.statfs;
  const settings = (typeof options.settings === "function" ? options.settings() : options.settings) || {};
  const hfHome = path.resolve(String(options.hfHome || ""));
  if (options.refresh) {
    const started = await library.rescan();
    await waitForTask(library, started.taskId);
  }
  const snapshot = await modelStorage.snapshot();
  const defaultId = snapshot.defaultRootId || "legacy";
  const entries = library.all();
  const jobs = jobsOf(options);

  const pendingByVolume = new Map();
  for (const job of jobs) {
    if (!WRITING_JOB_STATES.includes(job.state) || !job.target?.localDir) continue;
    const volume = job.target.volume || volumeOf(job.target.localDir);
    pendingByVolume.set(volume, (pendingByVolume.get(volume) || 0) + remainingBytes(job));
  }

  const showLegacy = settings?.storage?.showLegacyRootWhenEmpty === true;
  const roots = snapshot.roots.map((root) => {
    const own = entries.filter((entry) => entry.rootId === root.id);
    const volume = volumeOf(root.path);
    const available = root.online !== false;
    const free = available && Number.isFinite(Number(root.freeBytes)) ? Number(root.freeBytes) : null;
    const pending = pendingByVolume.get(volume) || 0;
    const modelCount = own.length;
    const incompleteFiles = own.reduce((sum, entry) => sum + (entry.residue?.incompleteFiles || 0), 0);
    const legacy = root.id === "legacy";
    const isDefault = root.id === defaultId;
    const busyRoot = jobs.some((job) => !TERMINAL_JOB_STATES.includes(job.state) && job.target?.rootId === root.id);
    return {
      id: root.id,
      label: root.label || path.basename(root.path) || root.id,
      path: root.path,
      mode: root.mode === "model" ? "model" : "library",
      default: isDefault,
      legacy,
      volume,
      available,
      freeBytes: free,
      totalBytes: available && Number.isFinite(Number(root.totalBytes)) ? Number(root.totalBytes) : null,
      usedByModelsBytes: own.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
      modelCount,
      incompleteFiles,
      incompleteBytes: own.reduce((sum, entry) => sum + (entry.residue?.incompleteBytes || 0), 0),
      pendingBytes: pending,
      reserveBytes: free === null ? 0 : reserveBytes(free, settings),
      projectedFreeBytes: free === null ? null : Math.max(0, free - pending),
      // An empty legacy folder the owner no longer uses is not shown (its
      // container mount stays); a setting brings it back.
      hidden: legacy && !isDefault && modelCount === 0 && incompleteFiles === 0 && !busyRoot && !showLegacy,
    };
  });
  roots.sort((a, b) => Number(b.default) - Number(a.default));

  const models = entries
    .filter((entry) => entry.rootId)
    .map((entry) => ({
      name: entry.relativePath,
      path: entry.path,
      rootId: entry.rootId,
      sizeBytes: Number(entry.bytes) || 0,
      bytes: Number(entry.bytes) || 0,
      incomplete: (entry.residue?.incompleteFiles || 0) > 0,
      incompleteFiles: entry.residue?.incompleteFiles || 0,
      incompleteBytes: entry.residue?.incompleteBytes || 0,
      modified: entry.mtime,
      entryId: entry.id,
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes || (a.name < b.name ? -1 : 1));

  const [hubBytes, xetBytes, modelscopeBytes, hfFree] = await Promise.all([
    dirBytes(path.join(hfHome, "hub")),
    dirBytes(path.join(hfHome, "xet")),
    dirBytes(path.join(hfHome, "modelscope")),
    Promise.resolve(freeBytes(path.join(hfHome, "hub"), { statfs })).catch(() => null),
  ]);

  const residues = entries
    .filter((entry) => entry.rootId && (entry.residue?.incompleteFiles || 0) > 0)
    .map((entry) => ({
      entryId: entry.id,
      rootId: entry.rootId,
      incompleteFiles: entry.residue.incompleteFiles,
      incompleteBytes: entry.residue.incompleteBytes,
      busy: Boolean(activeJobOn(jobs, entry.path)),
    }));

  return {
    ok: true,
    roots,
    models,
    hfCache: {
      path: hfHome,
      volume: volumeOf(hfHome),
      freeBytes: Number.isFinite(Number(hfFree)) ? Number(hfFree) : null,
      hubBytes,
      xetBytes,
      modelscopeBytes,
    },
    residues,
    orphanPartials: await findOrphanPartials({ jobs, entries }),
    duplicates: duplicateGroups(entries),
    updatedAt: new Date(clock.now()).toISOString(),
  };
}

/**
 * runCleanup({ targets, confirm, library, queue }) → { ok, reclaimedBytes,
 * results[] } (POST /storage/cleanup). `confirm` must be true. Targets are
 * { kind: "incomplete", entryId } (the `.incomplete` files of a library
 * entry) or { kind: "partial-download", jobId } (the folder a failed or
 * cancelled download left behind). Each target is judged alone: one that is
 * busy or gone gives an error result and the others still run.
 */
async function runCleanup(options = {}) {
  const { library } = options;
  if (!library) throw new TypeError("runCleanup needs library");
  const { targets, confirm } = options;
  if (confirm !== true) {
    throw new LibraryError("confirm_required", "Cleaning up deletes files; send confirm: true.", { status: 400, details: { field: "confirm" } });
  }
  if (!Array.isArray(targets) || !targets.length || targets.length > CLEANUP_TARGETS_MAX) {
    throw new LibraryError("invalid_request", `targets must list 1 to ${CLEANUP_TARGETS_MAX} cleanup targets.`, { status: 400, details: { field: "targets" } });
  }
  for (const target of targets) {
    const valid = isPlainObject(target)
      && ((target.kind === "incomplete" && typeof target.entryId === "string" && target.entryId)
        || (target.kind === "partial-download" && typeof target.jobId === "string" && target.jobId));
    if (!valid) {
      throw new LibraryError("invalid_request", "Each target is { kind: \"incomplete\", entryId } or { kind: \"partial-download\", jobId }.", { status: 400, details: { field: "targets" } });
    }
  }
  const results = [];
  let reclaimedBytes = 0;
  for (const target of targets) {
    const id = target.kind === "incomplete" ? { entryId: target.entryId } : { jobId: target.jobId };
    try {
      let bytes = 0;
      let removed;
      if (target.kind === "incomplete") {
        const done = await library.cleanupResidue(target.entryId);
        bytes = done.removedBytes;
        removed = done.removed.length;
      } else {
        const jobs = jobsOf(options);
        const job = jobs.find((item) => item.id === target.jobId || (Array.isArray(item.legacyIds) && item.legacyIds.includes(target.jobId)));
        if (!job) throw new LibraryError("download_not_found", "No such download.", { status: 404 });
        const orphan = (await findOrphanPartials({ jobs, entries: library.all(), only: job.id }))[0];
        if (!orphan) {
          throw new LibraryError("not_an_orphan", "This download left no partial folder that can be cleaned.", { status: 409, details: { state: job.state } });
        }
        bytes = await library.removeFolder(orphan.path);
      }
      reclaimedBytes += bytes;
      results.push({ kind: target.kind, ...id, ok: true, reclaimedBytes: bytes, ...(removed !== undefined ? { removedFiles: removed } : {}) });
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      results.push({ kind: target.kind, ...id, ok: false, reclaimedBytes: 0, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
  }
  return { ok: true, reclaimedBytes, results };
}

module.exports = {
  DEFAULT_RESERVE_GB,
  RESERVE_FRACTION,
  availableBytes,
  computeUsage,
  createDiskGuard,
  freeBytes,
  reserveBytes,
  runCleanup,
  volumeOf,
};
