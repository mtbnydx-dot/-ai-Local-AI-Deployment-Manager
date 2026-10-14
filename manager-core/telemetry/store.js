"use strict";

// TelemetryStore (docs/overhaul/04-telemetry.md §3, §4.1, §22).
//
// openTelemetryStore() starts store-worker.js in a worker_threads worker that
// owns the node:sqlite handle; this side only posts {id, method, args}
// messages, so no synchronous SQLite call ever runs on the caller's event
// loop. `inProcess: true` loads the same core on the calling thread and is
// meant for unit tests only.
//
// Failure handling:
// - Open or migration failure: degraded mode. Writes are discarded and
//   counted, queries and audit appends reject with telemetry_store_unavailable,
//   stats() reports store:"unavailable". The file is never deleted, recreated
//   or retried; the next entry start tries again.
// - Worker crash: pending calls reject with telemetry_store_crashed, calls
//   during the restart reject with telemetry_store_restarting (both
//   retryable, so the recorder keeps its buffer), and the worker restarts
//   with backoff from 1 s to 60 s.

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { redactSecrets } = require("../secret-redactor");

const WORKER_FILE = path.join(__dirname, "store-worker.js");
const WORKER_KIND = "telemetry-store";
const METHODS = Object.freeze([
  "insertRequests",
  "insertRuntimeSamples",
  "insertGpuSamples",
  "insertEvents",
  "appendAuditAccess",
  "call",
  "runRollups",
  "runRetention",
  "getState",
  "setState",
  "stats",
]);
const INSERT_COUNTERS = Object.freeze({
  insertRequests: "requests",
  insertRuntimeSamples: "runtimeSamples",
  insertGpuSamples: "gpuSamples",
  insertEvents: "events",
});
const DEFAULT_FLUSH_MS = 2000;
const STABLE_UPTIME_MS = 60_000;
// Test hook: returns the live Worker so a test can crash it.
const STORE_WORKER = Symbol("telemetryStoreWorker");

class TelemetryStoreError extends Error {
  constructor(code, message, { retryable = false, cause, field, sqliteCode } = {}) {
    super(message);
    this.name = "TelemetryStoreError";
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
    if (field) this.field = field;
    if (sqliteCode !== undefined) this.sqliteCode = sqliteCode;
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeLogger(logger) {
  const target = logger === undefined ? console : logger;
  return (level, message) => {
    if (!target) return;
    const text = redactSecrets(String(message));
    if (typeof target === "function") {
      target(level, text);
      return;
    }
    const method = typeof target[level] === "function" ? target[level] : target.log;
    if (typeof method === "function") method.call(target, text);
  };
}

function fromSerialized(error, fallbackCode) {
  const code = (error && error.code) || fallbackCode;
  return new TelemetryStoreError(code, (error && error.message) || code, {
    cause: error && error.cause,
    field: error && error.field,
    sqliteCode: error && error.sqliteCode,
  });
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function openTelemetryStore(options = {}) {
  if (typeof options.file !== "string" || !options.file.trim()) {
    throw new TypeError("openTelemetryStore requires options.file");
  }
  const inProcess = options.inProcess === true;
  const mode = inProcess ? "in-process" : "worker";
  const log = normalizeLogger(options.logger);
  const coreOptions = {
    file: options.file,
    queryModule: options.queryModule ? String(options.queryModule) : undefined,
    retention: options.retention && typeof options.retention === "object" ? { ...options.retention } : undefined,
  };
  const restartMinMs = clampInt(options.restartMinMs, 10, 60_000, 1000);
  const restartMaxMs = clampInt(options.restartMaxMs, restartMinMs, 600_000, 60_000);
  const openTimeoutMs = clampInt(options.openTimeoutMs, 100, 120_000, 15_000);

  let state = "opening";
  let unavailable = null;
  let info = null;
  let restarts = 0;
  let lastCrash = null;
  const dropped = { requests: 0, runtimeSamples: 0, gpuSamples: 0, events: 0, state: 0 };

  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let restartTimer = null;
  let restartDelay = restartMinMs;
  let startedAt = 0;

  let storeCore = null;
  let core = null;
  const inflight = new Set();

  function closedError() {
    return new TelemetryStoreError("telemetry_store_closed", "The telemetry store is closed.");
  }

  function unavailableError() {
    return new TelemetryStoreError("telemetry_store_unavailable", "The telemetry store is unavailable (degraded mode).", {
      cause: unavailable && unavailable.cause,
    });
  }

  function becomeUnavailable(error) {
    state = "unavailable";
    unavailable = {
      code: "telemetry_store_unavailable",
      cause: (error && error.code) || "telemetry_store_error",
      message: redactSecrets(String((error && error.message) || "Telemetry store failed to open.")),
      at: Date.now(),
    };
    log("error", `Telemetry store unavailable (${unavailable.cause}): ${unavailable.message} `
      + "Telemetry writes are discarded until the next start; the database file is left untouched.");
  }

  function updateRef() {
    if (!worker) return;
    if (pending.size > 0) worker.ref();
    else worker.unref();
  }

  function rejectPending(error) {
    const entries = Array.from(pending.values());
    pending.clear();
    for (const entry of entries) entry.reject(error);
    updateRef();
  }

  function postCall(instance, method, args) {
    return new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject, method });
      try {
        instance.postMessage({ type: "call", id, method, args });
      } catch {
        pending.delete(id);
        reject(new TelemetryStoreError("invalid_argument", "Telemetry store arguments must be plain data."));
      }
      updateRef();
    });
  }

  function onWorkerMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "log") {
      log(message.level === "error" || message.level === "warn" ? message.level : "log", message.message);
      return;
    }
    if (message.type !== "result") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    updateRef();
    if (message.ok) entry.resolve(message.result);
    else entry.reject(fromSerialized(message.error, "telemetry_store_error"));
  }

  function scheduleRestart() {
    if (Date.now() - startedAt >= STABLE_UPTIME_MS) restartDelay = restartMinMs;
    const wait = restartDelay;
    restartDelay = Math.min(restartMaxMs, restartDelay * 2);
    log("error", `Telemetry store worker stopped unexpectedly; restarting in ${wait} ms.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (state === "restarting") startWorker();
    }, wait);
    restartTimer.unref?.();
  }

  function onWorkerExit(instance, code, lastError) {
    if (instance !== worker) return;
    worker = null;
    if (state === "closed") {
      rejectPending(closedError());
      return;
    }
    rejectPending(new TelemetryStoreError("telemetry_store_crashed", "The telemetry store worker stopped.", { retryable: true }));
    if (state !== "ready") return;
    state = "restarting";
    restarts += 1;
    lastCrash = {
      at: Date.now(),
      exitCode: code,
      message: lastError ? redactSecrets(String(lastError.message || lastError)) : null,
    };
    scheduleRestart();
  }

  // Resolves once the worker is ready or the store is degraded; never rejects.
  function startWorker() {
    return new Promise((resolve) => {
      let settled = false;
      let lastError = null;
      const instance = new Worker(WORKER_FILE, { workerData: { kind: WORKER_KIND, options: coreOptions } });
      worker = instance;
      const settle = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(openTimer);
        resolve();
        return true;
      };
      const openTimer = setTimeout(() => {
        if (!settle()) return;
        if (state !== "closed") becomeUnavailable({ code: "telemetry_store_open_timeout", message: `The store did not open within ${openTimeoutMs} ms.` });
        instance.terminate().catch(() => {});
      }, openTimeoutMs);
      instance.on("message", (message) => {
        if (message && message.type === "ready") {
          if (!settle()) return;
          if (state === "closed") {
            instance.terminate().catch(() => {});
            return;
          }
          if (message.ok) {
            state = "ready";
            info = message.info || null;
            startedAt = Date.now();
            updateRef();
          } else {
            // The worker exits by itself after a failed open.
            becomeUnavailable(message.error);
          }
          return;
        }
        onWorkerMessage(message);
      });
      instance.on("error", (error) => { lastError = error; });
      instance.on("exit", (code) => {
        // A restart that dies before it is ready backs off and tries again; a
        // first start that dies, or any failed open, means degraded mode.
        const beforeReady = settle();
        if (beforeReady && state === "restarting") {
          scheduleRestart();
        } else if (beforeReady && state === "opening") {
          becomeUnavailable(lastError
            ? { code: lastError.code || "telemetry_store_worker_failed", message: lastError.message }
            : { code: "telemetry_store_worker_failed", message: `The store worker exited with code ${code}.` });
        }
        onWorkerExit(instance, code, lastError);
      });
    });
  }

  // Unit tests only: the core opens SQLite on this thread.
  function openInProcess() {
    storeCore = require("./store-worker");
    try {
      core = storeCore.createStoreCore({ ...coreOptions, allowMainThread: true, log });
      info = core.info;
      state = "ready";
    } catch (error) {
      becomeUnavailable(storeCore.serializeError(error));
    }
  }

  function runInProcess(method, args) {
    const task = (async () => {
      try {
        return await core[method](...args);
      } catch (error) {
        throw fromSerialized(storeCore.serializeError(error), "telemetry_store_error");
      }
    })();
    inflight.add(task);
    task.then(() => inflight.delete(task), () => inflight.delete(task));
    return task;
  }

  function degradedStats() {
    return {
      ok: false,
      store: "unavailable",
      mode,
      thread: null,
      file: path.resolve(options.file),
      schemaVersion: null,
      error: unavailable,
      dropped: { ...dropped },
      restarts,
      lastCrash,
      degraded: ["store_unavailable"],
    };
  }

  function degradedCall(method, args) {
    const counter = INSERT_COUNTERS[method];
    if (counter) {
      const count = Array.isArray(args[0]) ? args[0].length : 0;
      dropped[counter] += count;
      return Promise.resolve({ accepted: 0, duplicates: 0, rejected: 0, dropped: count, errors: [], error: "telemetry_store_unavailable" });
    }
    switch (method) {
      case "setState":
        dropped.state += 1;
        return Promise.resolve({ ok: false, dropped: true });
      case "getState":
        return Promise.resolve(null);
      case "runRollups":
      case "runRetention":
        return Promise.resolve({ ok: false, skipped: true, reason: "store_unavailable" });
      case "stats":
        return Promise.resolve(degradedStats());
      default:
        return Promise.reject(unavailableError());
    }
  }

  async function liveStats(args) {
    const result = inProcess ? await runInProcess("stats", args) : await postCall(worker, "stats", args);
    const merged = { ...dropped };
    for (const key of Object.values(INSERT_COUNTERS)) {
      merged[key] += Number(result.writes && result.writes[key] && result.writes[key].dropped) || 0;
    }
    return { ...result, mode, restarts, lastCrash, pending: pending.size, dropped: merged };
  }

  function invoke(method, args) {
    if (state === "closed") return Promise.reject(closedError());
    if (state === "unavailable") return degradedCall(method, args);
    if (state !== "ready" || (!inProcess && !worker)) {
      return Promise.reject(new TelemetryStoreError("telemetry_store_restarting", "The telemetry store is restarting.", { retryable: true }));
    }
    if (method === "stats") return liveStats(args);
    return inProcess ? runInProcess(method, args) : postCall(worker, method, args);
  }

  async function close({ flushMs = DEFAULT_FLUSH_MS } = {}) {
    if (state === "closed") return { ok: true, timedOut: false };
    const previous = state;
    state = "closed";
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const wait = clampInt(flushMs, 0, 60_000, DEFAULT_FLUSH_MS);
    if (inProcess) {
      const flushed = await withTimeout(Promise.allSettled(Array.from(inflight)), wait);
      try { core && core.close(); } catch {}
      return { ok: true, timedOut: !flushed };
    }
    const instance = worker;
    if (!instance) return { ok: true, timedOut: false };
    // Calls already posted are answered before "close" (the worker handles
    // messages in order), so this waits for in-flight writes up to flushMs.
    const flushed = previous === "ready" ? await withTimeout(postCall(instance, "close", []), wait) : true;
    await instance.terminate().catch(() => {});
    return { ok: true, timedOut: !flushed };
  }

  if (inProcess) openInProcess();
  else await startWorker();

  const store = { close };
  for (const method of METHODS) store[method] = (...args) => invoke(method, args);
  Object.defineProperty(store, "info", { enumerable: true, get: () => (info ? { ...info, mode } : null) });
  Object.defineProperty(store, "state", { enumerable: true, get: () => state });
  Object.defineProperty(store, STORE_WORKER, { value: () => worker });
  return store;
}

module.exports = {
  openTelemetryStore,
  TelemetryStoreError,
  STORE_WORKER,
};
