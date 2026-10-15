"use strict";

// The calibration store (docs/overhaul/02-models.md §10.6, 00 §9.1, MOD-10):
// <manager>/data/memory-calibration.json, the only calibration store. One
// record per ready launch, keyed by (contentDigest, runtimeId, paramsKey)
// where paramsKey is 01 engines.paramsKey(plan) taken verbatim: this module
// never builds the key itself, it only compares it.
//
//   createCalibrationStore({ file, maxRecords: 500, now?, log? })
//     → { lookup({contentDigest, runtimeId, paramsKey}), record(observation),
//         recent({contentDigest, engineId}, n), calibrationFor(card, engineId, runtimeId, paramsKey), size() }
//   calibrationFor(card, engineId, runtimeId, paramsKey, { store })
//     → { exact, measuredMb, samples, records } | null   (01 PlanCtx shape)
//
// The file is {schemaVersion: 1, records: [...]}, at most maxRecords (the
// oldest drop first), written through a temporary file and a rename. A file
// that does not parse is renamed to <file>.corrupt-<ts>, ignored, and
// rewritten by the next record().

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CALIBRATION_SCHEMA_VERSION = 1;
const DEFAULT_MAX_RECORDS = 500;
const DRIFT_SAMPLES = 5;
const RENAME_RETRIES = 6;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function maxOf(map) {
  const numbers = Object.values(isPlainObject(map) ? map : {}).map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : 0;
}

function median(numbers) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Not available: the retry simply goes again at once.
  }
}

function renameSyncWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open for a moment.
      if (attempt >= RENAME_RETRIES || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      sleepSync(25 * (attempt + 1));
    }
  }
}

/** A record as the store keeps it: key fields are strings, measured/estimated are objects. */
function normalizeRecord(input) {
  if (!isPlainObject(input)) return null;
  const contentDigest = text(input.contentDigest);
  const runtimeId = text(input.runtimeId);
  const paramsKey = text(input.paramsKey);
  if (!contentDigest || !runtimeId || !paramsKey) return null;
  const estimated = isPlainObject(input.estimated) ? input.estimated : {};
  const measured = isPlainObject(input.measured) ? input.measured : {};
  const delta = measured.gpuUsedDeltaMb === null || measured.gpuUsedDeltaMb === undefined ? NaN : Number(measured.gpuUsedDeltaMb);
  return {
    contentDigest,
    engineId: text(input.engineId),
    runtimeId,
    recipeId: text(input.recipeId),
    paramsKey,
    launchId: text(input.launchId),
    estimated: {
      perGpuMb: isPlainObject(estimated.perGpuMb) ? { ...estimated.perGpuMb } : {},
      breakdown: isPlainObject(estimated.breakdown) ? { ...estimated.breakdown } : {},
      policy: text(estimated.policy),
    },
    measured: {
      perGpuMb: isPlainObject(measured.perGpuMb) ? { ...measured.perGpuMb } : {},
      gpuUsedDeltaMb: Number.isFinite(delta) ? delta : null,
      logFacts: isPlainObject(measured.logFacts) ? JSON.parse(JSON.stringify(measured.logFacts)) : {},
    },
    at: text(input.at) || new Date().toISOString(),
  };
}

function createCalibrationStore(options = {}) {
  const file = text(options.file);
  if (!file) throw new TypeError("createCalibrationStore needs a file.");
  const maxRecords = Math.max(1, Math.floor(positive(options.maxRecords)) || DEFAULT_MAX_RECORDS);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : null;

  let cache = null; // { signature, records }

  function signatureOf() {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  function quarantine() {
    const target = `${file}.corrupt-${now()}`;
    try {
      fs.renameSync(file, target);
    } catch {
      // A rename that fails leaves the file for record() to overwrite.
    }
    if (log) log(`memory calibration file did not parse; renamed to ${path.basename(target)}`);
  }

  function load() {
    const signature = signatureOf();
    if (cache && cache.signature === signature) return cache.records;
    let records = [];
    if (signature !== "missing") {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!isPlainObject(parsed) || parsed.schemaVersion !== CALIBRATION_SCHEMA_VERSION || !Array.isArray(parsed.records)) {
          throw new Error("unexpected shape");
        }
        records = parsed.records.map(normalizeRecord).filter(Boolean);
      } catch {
        quarantine();
        records = [];
      }
    }
    cache = { signature: signatureOf(), records };
    return records;
  }

  function write(records) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: CALIBRATION_SCHEMA_VERSION, records }), "utf8");
      renameSyncWithRetry(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
    cache = { signature: signatureOf(), records };
  }

  /**
   * Appends an observation. A launchId already in the store is recorded once
   * only. Returns { recorded, duplicate?, size }; throws on an invalid record
   * or a failed write (the afterReady hook catches it).
   */
  function record(observation) {
    const next = normalizeRecord(observation);
    if (!next) throw new TypeError("A calibration record needs contentDigest, runtimeId and paramsKey.");
    const records = load();
    if (next.launchId && records.some((item) => item.launchId === next.launchId)) {
      return { recorded: false, duplicate: true, size: records.length };
    }
    const kept = [...records, next].slice(-maxRecords);
    write(kept);
    return { recorded: true, size: kept.length };
  }

  /** The exact-key hit: { exact: true, measuredMb, samples, records } or null. */
  function lookup({ contentDigest, runtimeId, paramsKey } = {}) {
    const digest = text(contentDigest);
    const runtime = text(runtimeId);
    const key = text(paramsKey);
    if (!digest || !runtime || !key) return null;
    const matching = load().filter((item) => item.contentDigest === digest && item.runtimeId === runtime && item.paramsKey === key);
    const measured = matching.map((item) => maxOf(item.measured?.perGpuMb)).filter((value) => value > 0);
    if (!measured.length) return null;
    return {
      exact: true,
      measuredMb: Math.round(median(measured) * 100) / 100,
      samples: measured.length,
      records: matching.map((item) => structuredClone(item)),
    };
  }

  /** The last n records for (contentDigest, engineId), oldest first. */
  function recent({ contentDigest, engineId } = {}, n = DRIFT_SAMPLES) {
    const digest = text(contentDigest);
    if (!digest) return [];
    const engine = text(engineId);
    const matching = load().filter((item) => item.contentDigest === digest && (!engine || item.engineId === engine));
    const count = Math.max(0, Math.floor(Number(n)) || 0);
    return (count ? matching.slice(-count) : []).map((item) => structuredClone(item));
  }

  const api = {
    file,
    maxRecords,
    lookup,
    record,
    recent,
    size: () => load().length,
    calibrationFor: (card, engineId, runtimeId, paramsKey) => calibrationFor(card, engineId, runtimeId, paramsKey, { store: api }),
  };
  return api;
}

/**
 * 01 PlanCtx calibrationFor(card, engineId, runtimeId, paramsKey): an exact
 * key hit is { exact: true, measuredMb, samples, records } where records are
 * the last <= 5 of this model and engine for 02's drift check (§10.6). With no
 * exact hit but earlier launches of the same model and engine the answer is
 * { exact: false, measuredMb: null, samples: 0, records }: 01 never applies it
 * and only fit.js reads the records. Null when nothing is known or no store.
 */
function calibrationFor(card, engineId, runtimeId, paramsKey, { store = null } = {}) {
  const contentDigest = text(card?.contentDigest);
  if (!store || !contentDigest) return null;
  const records = store.recent({ contentDigest, engineId }, DRIFT_SAMPLES);
  const hit = store.lookup({ contentDigest, runtimeId, paramsKey });
  if (hit) return { exact: true, measuredMb: hit.measuredMb, samples: hit.samples, records };
  if (!records.length) return null;
  return { exact: false, measuredMb: null, samples: 0, records };
}

module.exports = {
  CALIBRATION_SCHEMA_VERSION,
  DEFAULT_MAX_RECORDS,
  DRIFT_SAMPLES,
  createCalibrationStore,
  calibrationFor,
  normalizeRecord,
};
