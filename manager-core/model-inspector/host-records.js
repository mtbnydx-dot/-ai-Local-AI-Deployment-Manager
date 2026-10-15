"use strict";

// Host records (docs/overhaul/02-models.md section 13, MOD-16).
//
// A host record is the durable result of one qualification run on this host:
// service-entry/data/model-host-records.json, schemaVersion 1, written
// atomically, at most 50 records per contentDigest. The ENTRY is the only
// writer (createHostRecordStore below). The manager that ran the qualification
// only pushes its record to POST /internal/models/host-records, signed by
// internal-auth.js (pushHostRecord below); when the push fails after three
// retries the record stays in job.result.hostRecord and the owner imports it
// (POST /api/models/:id/qualifications/import).
//
// This module also owns what a record means for a card: each passing check
// adds `verified-on-host` evidence for (contentDigest, runtimeId)
// (evidenceForRecord / withHostEvidence), and compatibility.js counts a record
// with a pass as supportEvidence. A failed check never removes a declared fact.

const { atomicWriteJsonFile } = require("../file-utils");
const { redactSecrets } = require("../secret-redactor");
const { newRecordId } = require("./qualify");

const SCHEMA_VERSION = 1;
const MAX_RECORDS_PER_DIGEST = 50;
const HOST_RECORDS_PATH = "/internal/models/host-records";
// Retries after the first attempt: 1 s, 4 s, 16 s (section 13).
const PUSH_RETRY_DELAYS_MS = Object.freeze([1000, 4000, 16000]);
const CHECKS = Object.freeze(["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "needle", "speculative", "throughput"]);
const STATUSES = Object.freeze(["pass", "warn", "fail", "skip"]);
const RECORD_ID_RE = /^qr_[a-z2-7]{20}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CARD_ID_RE = /^mc_[a-z2-7]{20}$/;
const LAUNCH_ID_RE = /^lch_[a-z2-7]{20}$/;
const ENGINE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const FLEET_ID_RE = /^(vllm|llama):[A-Za-z0-9._:-]{1,128}$/;
const MAX_RESULTS = 20;
const MAX_TEXT = 600;
const MAX_JSON_BYTES = 4096;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fieldError(field, code, message) {
  return { field, code, message };
}

function cleanText(value, max = MAX_TEXT) {
  return redactSecrets(String(value)).slice(0, max);
}

function nullableText(value, max, pattern) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) return { error: true };
  return { value };
}

// A small JSON value (numbers, strings, booleans, nesting) within a byte bound; secrets redacted.
function boundedJson(value) {
  if (!isPlainObject(value)) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) return null;
  return JSON.parse(redactSecrets(text));
}

function normalizeDetail(detail) {
  if (!isPlainObject(detail)) return null;
  if (typeof detail.zh !== "string" || typeof detail.en !== "string") return null;
  return { zh: cleanText(detail.zh), en: cleanText(detail.en) };
}

function normalizeRootCause(value) {
  if (!isPlainObject(value) || typeof value.code !== "string") return undefined;
  const out = { code: cleanText(value.code, 80), signatureId: typeof value.signatureId === "string" ? cleanText(value.signatureId, 80) : null };
  const hint = normalizeDetail(value.hint);
  if (hint) out.hint = hint;
  const title = normalizeDetail(value.title);
  if (title) out.title = title;
  return out;
}

/**
 * Validates an incoming host record (the body of POST /internal/models/host-records
 * without `jobId`, or a record pulled from a job) and rebuilds it from the
 * known fields only. Returns {record, errors}; errors are 422 field errors.
 */
function normalizeHostRecord(input) {
  const errors = [];
  if (!isPlainObject(input)) return { record: null, errors: [fieldError("$", "invalid", "The host record must be a JSON object.")] };
  const record = {};

  const id = input.id === undefined || input.id === null || input.id === "" ? newRecordId() : input.id;
  if (typeof id !== "string" || !RECORD_ID_RE.test(id)) errors.push(fieldError("id", "invalid", "id must be qr_ followed by 20 base32 characters."));
  record.id = id;
  if (typeof input.contentDigest !== "string" || !DIGEST_RE.test(input.contentDigest)) errors.push(fieldError("contentDigest", "invalid", "contentDigest must be sha256:<64 hex>."));
  record.contentDigest = input.contentDigest;
  if (typeof input.cardId !== "string" || !CARD_ID_RE.test(input.cardId)) errors.push(fieldError("cardId", "invalid", "cardId must be a model card id (mc_…)."));
  record.cardId = input.cardId;
  if (typeof input.engineId !== "string" || !ENGINE_ID_RE.test(input.engineId)) errors.push(fieldError("engineId", "invalid", "engineId is not a valid engine id."));
  record.engineId = input.engineId;
  if (typeof input.runtimeId !== "string" || !input.runtimeId || input.runtimeId.length > 128 || /[\s/\\]/.test(input.runtimeId)) errors.push(fieldError("runtimeId", "invalid", "runtimeId must be like engine@version."));
  record.runtimeId = input.runtimeId;
  const recipe = nullableText(input.recipeId, 200, /^[a-z0-9][a-z0-9-]*$/);
  if (recipe.error) errors.push(fieldError("recipeId", "invalid", "recipeId must be a kebab-case id or null."));
  record.recipeId = recipe.value ?? null;
  const paramsKey = nullableText(input.paramsKey, 200);
  if (paramsKey.error) errors.push(fieldError("paramsKey", "invalid", "paramsKey must be a short string or null."));
  record.paramsKey = paramsKey.value ?? null;
  const launch = nullableText(input.launchId, 40, LAUNCH_ID_RE);
  if (launch.error) errors.push(fieldError("launchId", "invalid", "launchId must be lch_… or null."));
  record.launchId = launch.value ?? null;
  if (typeof input.fleetId !== "string" || !FLEET_ID_RE.test(input.fleetId)) errors.push(fieldError("fleetId", "invalid", "fleetId must be <managerId>:<instanceId>."));
  record.fleetId = input.fleetId;

  const host = isPlainObject(input.host) ? input.host : {};
  record.host = {};
  for (const key of ["gpu", "computeCap", "driver"]) {
    const value = host[key];
    record.host[key] = typeof value === "string" && value ? cleanText(value, 120) : null;
  }

  const at = typeof input.at === "string" ? Date.parse(input.at) : NaN;
  if (!Number.isFinite(at)) errors.push(fieldError("at", "invalid", "at must be an ISO timestamp."));
  record.at = Number.isFinite(at) ? new Date(at).toISOString() : null;
  const duration = Number(input.durationMs);
  if (!Number.isFinite(duration) || duration < 0 || duration > 86_400_000) errors.push(fieldError("durationMs", "invalid", "durationMs must be a non-negative number of milliseconds."));
  record.durationMs = Number.isFinite(duration) ? Math.round(duration) : 0;

  const results = Array.isArray(input.results) ? input.results : null;
  if (!results || !results.length || results.length > MAX_RESULTS) {
    errors.push(fieldError("results", "invalid", `results must list 1 to ${MAX_RESULTS} checks.`));
    record.results = [];
  } else {
    record.results = [];
    const seen = new Set();
    results.forEach((item, index) => {
      const where = `results[${index}]`;
      if (!isPlainObject(item) || !CHECKS.includes(item.check) || seen.has(item.check)) {
        errors.push(fieldError(`${where}.check`, "invalid", "check must be a known, unrepeated check id."));
        return;
      }
      if (!STATUSES.includes(item.status)) {
        errors.push(fieldError(`${where}.status`, "invalid", "status must be pass, warn, fail or skip."));
        return;
      }
      const detail = normalizeDetail(item.detail);
      if (!detail) {
        errors.push(fieldError(`${where}.detail`, "invalid", "detail must be {zh, en} strings."));
        return;
      }
      seen.add(item.check);
      const metrics = item.metrics === undefined ? {} : boundedJson(item.metrics);
      if (metrics === null) {
        errors.push(fieldError(`${where}.metrics`, "invalid", `metrics must be an object of at most ${MAX_JSON_BYTES} bytes.`));
        return;
      }
      const rootCause = normalizeRootCause(item.rootCause);
      record.results.push({ check: item.check, status: item.status, detail, metrics, ...(rootCause ? { rootCause } : {}) });
    });
  }

  const observed = isPlainObject(input.observed) ? input.observed : {};
  const peak = {};
  if (isPlainObject(observed.peakMb)) {
    for (const [gpu, value] of Object.entries(observed.peakMb).slice(0, 16)) {
      if (/^[A-Za-z0-9_.-]{1,16}$/.test(gpu) && Number.isFinite(Number(value)) && Number(value) >= 0) peak[gpu] = Math.round(Number(value));
    }
  }
  const engineFacts = observed.engineFacts === undefined ? {} : boundedJson(observed.engineFacts);
  if (engineFacts === null) errors.push(fieldError("observed.engineFacts", "invalid", `engineFacts must be an object of at most ${MAX_JSON_BYTES} bytes.`));
  record.observed = { peakMb: peak, engineFacts: engineFacts || {} };

  return { record: errors.length ? null : record, errors };
}

/** {pass, warn, fail, skip} counts and a one-line summary of a record, for the `library` event. */
function summaryOf(record) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of Array.isArray(record?.results) ? record.results : []) {
    if (Object.hasOwn(counts, item?.status)) counts[item.status] += 1;
  }
  return { ...counts, total: counts.pass + counts.warn + counts.fail + counts.skip, runtimeId: record?.runtimeId || null };
}

// What each passing check proves about the card (02 section 13).
const EVIDENCE_FACTS = Object.freeze({
  models: ["/identity"],
  chat: ["/identity"],
  "reasoning-split": ["/template/reasoningFormat"],
  "tool-call": ["/capabilities/tools"],
  "json-output": ["/capabilities/jsonOutput"],
  vision: ["/modalities/input"],
  needle: ["/context/native"],
});

/** The verified-on-host evidence entries a record adds to the card of its contentDigest. */
function evidenceForRecord(record) {
  const entries = [];
  if (!isPlainObject(record) || !Array.isArray(record.results)) return entries;
  for (const result of record.results) {
    if (result?.status !== "pass") continue;
    for (const fact of EVIDENCE_FACTS[result.check] || []) {
      entries.push({
        fact,
        source: { kind: "qualification", ref: String(record.id || "") },
        confidence: "verified-on-host",
        note: {
          zh: `在本机 ${record.runtimeId} 上通过「${result.check}」验证。`,
          en: `Passed "${result.check}" on this host with ${record.runtimeId}.`,
        },
      });
    }
  }
  return entries;
}

/**
 * A copy of `card` with the verified-on-host evidence of the records that belong
 * to its contentDigest. The card itself (a cache entry) is never changed.
 */
function withHostEvidence(card, records) {
  if (!isPlainObject(card) || !card.contentDigest || !Array.isArray(records)) return card;
  const own = records.filter((record) => record?.contentDigest === card.contentDigest);
  if (!own.length) return card;
  const evidence = Array.isArray(card.evidence) ? [...card.evidence] : [];
  const seen = new Set(evidence.filter((entry) => entry?.source?.kind === "qualification").map((entry) => `${entry.fact}|${entry.source.ref}`));
  for (const record of own) {
    for (const entry of evidenceForRecord(record)) {
      const key = `${entry.fact}|${entry.source.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(entry);
    }
  }
  return { ...card, evidence };
}

/**
 * The key an auto-qualify decision looks up: a record covers a launch when
 * (contentDigest, runtimeId) match and either its recipeId equals the launch's
 * recipeId, or - for a launch without a recipe - its paramsKey equals the
 * launch's paramsKey.
 */
function recordCovers(record, { contentDigest, runtimeId, recipeId = null, paramsKey = null }) {
  if (!isPlainObject(record) || record.contentDigest !== contentDigest || record.runtimeId !== runtimeId) return false;
  if (recipeId) return record.recipeId === recipeId;
  return !record.recipeId && Boolean(paramsKey) && record.paramsKey === paramsKey;
}

// --- the entry's store ---------------------------------------------------------------

/**
 * createHostRecordStore({file, maxPerDigest}) -> {all, list, get, has, append}.
 * One JSON file, {schemaVersion: 1, records: [...]}, replaced atomically; the
 * entry is its only writer, and writes are serialised. A missing or corrupt
 * file reads as empty (the next write replaces it).
 */
function createHostRecordStore({ file, maxPerDigest = MAX_RECORDS_PER_DIGEST } = {}) {
  if (typeof file !== "string" || !file) throw new TypeError("createHostRecordStore needs a file.");
  const fs = require("node:fs");
  let queue = Promise.resolve();

  async function read() {
    try {
      const data = JSON.parse(await fs.promises.readFile(file, "utf8"));
      const list = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : [];
      return list.filter(isPlainObject);
    } catch {
      return [];
    }
  }

  async function all() {
    return read();
  }

  async function list(contentDigest) {
    if (!contentDigest) return [];
    return (await read()).filter((record) => record.contentDigest === contentDigest);
  }

  async function get(id) {
    return (await read()).find((record) => record.id === id) || null;
  }

  async function has(query) {
    return (await read()).some((record) => recordCovers(record, query));
  }

  /** Appends a normalized record. Returns {record, duplicate}: the same id again is a no-op. */
  function append(record) {
    const run = queue.then(async () => {
      const records = await read();
      const existing = records.find((item) => item.id === record.id);
      if (existing) return { record: existing, duplicate: true };
      records.push(clone(record));
      // Keep the newest `maxPerDigest` records of this digest.
      const mine = records.filter((item) => item.contentDigest === record.contentDigest);
      let kept = records;
      if (mine.length > maxPerDigest) {
        const drop = new Set(mine.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, mine.length - maxPerDigest).map((item) => item.id));
        kept = records.filter((item) => !drop.has(item.id));
      }
      await atomicWriteJsonFile(file, { schemaVersion: SCHEMA_VERSION, records: kept });
      return { record, duplicate: false };
    });
    queue = run.catch(() => {});
    return run;
  }

  return { file, all, list, get, has, append };
}

// --- the manager's push -----------------------------------------------------------------

function retryableStatus(status, code) {
  if (!status) return true;
  if (status >= 500 || [401, 408, 429].includes(status)) return true;
  // The entry may not have registered the job yet when a very short run ends.
  return status === 409 && code === "job_mismatch";
}

/**
 * Signs and sends one host record to the entry: POST /internal/models/host-records
 * with the record plus {jobId}, through createInternalClient({managerId}). A
 * transport failure, 5xx, 401, 408, 429 or a job the entry has not registered
 * yet is retried after 1, 4 and 16 s; any other refusal is final. Resolves to
 * {ok, attempts, id?, code?, status?}; never throws and never logs the body.
 */
async function pushHostRecord({ internalClient, record, jobId, delaysMs = PUSH_RETRY_DELAYS_MS, sleep, log } = {}) {
  if (!internalClient || typeof internalClient.request !== "function") return { ok: false, attempts: 0, code: "no_internal_client" };
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const note = (line) => {
    try {
      if (typeof log === "function") log(line);
    } catch {
      // Logging never breaks the push.
    }
  };
  const body = { ...record, jobId };
  let last = { ok: false, attempts: 0, code: "push_failed" };
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    if (attempt > 0) await wait(delaysMs[attempt - 1]);
    last = { ok: false, attempts: attempt + 1, code: "push_failed" };
    try {
      const response = await internalClient.request("POST", HOST_RECORDS_PATH, body);
      const status = Number(response?.status) || 0;
      const code = response?.json?.error?.code || response?.json?.code || null;
      if (status >= 200 && status < 300 && response?.json?.ok) return { ok: true, attempts: attempt + 1, id: response.json.id || record?.id || null, status };
      last = { ok: false, attempts: attempt + 1, status, code: code || `http_${status}` };
      if (!retryableStatus(status, code)) {
        note(`Host record push refused (HTTP ${status}${code ? ` ${code}` : ""}).`);
        return { ...last, final: true };
      }
    } catch (error) {
      last = { ok: false, attempts: attempt + 1, code: String(error?.code || "internal_unavailable") };
    }
    if (attempt < delaysMs.length) note(`Host record push attempt ${attempt + 1} failed (${last.code}); retrying in ${Math.round(delaysMs[attempt] / 1000)} s.`);
  }
  note(`Host record push failed after ${last.attempts} attempts (${last.code}).`);
  return last;
}

module.exports = {
  CHECKS,
  EVIDENCE_FACTS,
  HOST_RECORDS_PATH,
  MAX_RECORDS_PER_DIGEST,
  PUSH_RETRY_DELAYS_MS,
  SCHEMA_VERSION,
  createHostRecordStore,
  evidenceForRecord,
  normalizeHostRecord,
  pushHostRecord,
  recordCovers,
  summaryOf,
  withHostEvidence,
};
