"use strict";

// The hub's one global, persistent download queue (03 §8). It owns every
// DownloadJob (§8.1): their order, the concurrency limit, the idle-only gate,
// per-volume disk reservation, retries, restart resume and the terminal
// history. It drives one transfer engine (transfer.js), one progress monitor
// per attempt (progress.js) and the completion pipeline (verify.js), and it
// registers finished downloads in the library.
//
// The queue never touches SSE: it publishes `downloads` and `notification`
// through `events.publish(type, payload)` (07 ENT-EV) and nothing else.
// downloads.json is written on every state transition and at most every 5 s
// for progress; the store makes each write atomic.
//
//   createDownloadQueue({ store, engine, monitorFactory, verifier, library,
//     settings, busySignal, disk, events, tokens, modelStorage, getBusyPaths,
//     runAfter, errorData, redactor, clock, timers, logger, pollMs, stopWaitMs })
//   → { load, start, stop, enqueue, list, get, logs, history, pause, resume,
//       cancel, retry, setPriority, reorder, startNow, pauseAll, resumeAll,
//       remove, resumeCheck, aggregate, counts, busy, document, publicJob }
//
// States (03 §7.1): queued, waiting (waitReason runtime-busy | disk |
// concurrency | auth), resolving, downloading, materializing, verifying,
// ready, retrying, paused, interrupted, failed, cancelled.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createSecretRedactor } = require("../secret-redactor");
const { inspectDownloadResume } = require("../download-resume-check");
const { overlapsPath, pathKey } = require("../model-storage");
const {
  HUB_ERROR_CODES,
  HubError,
  classifyTransferFailure,
  describeHubError,
  retryDecision,
} = require("./errors");
const { computeFilesetHash, identityKeyFor } = require("./library");
const { availableBytes, reserveBytes: defaultReserveBytes } = require("./disk");

const JOB_SCHEMA_VERSION = 1;
const JOB_ID_RE = /^dl_[a-z2-7]{16}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const IN_PROCESS_STATES = Object.freeze(["resolving", "downloading", "materializing", "verifying"]);
const TRANSFER_STATES = Object.freeze(["resolving", "downloading", "materializing"]);
const TERMINAL_STATES = Object.freeze(["ready", "failed", "cancelled"]);
const PENDING_STATES = Object.freeze(["queued", "waiting", "retrying"]);
const JOB_STATES = Object.freeze([...PENDING_STATES, ...IN_PROCESS_STATES, "paused", "interrupted", ...TERMINAL_STATES]);
const WAIT_REASONS = Object.freeze(["runtime-busy", "disk", "concurrency", "auth"]);
const PRIORITIES = Object.freeze(["high", "normal", "low"]);
const PRIORITY_RANK = Object.freeze({ high: 0, normal: 1, low: 2 });
const ORIGIN_KINDS = Object.freeze(["console", "manager-shim", "mcp", "migration", "library-update"]);
const PHASE_HISTORY_CAP = 32;
const RETRY_HISTORY_CAP = 20;
const LOG_RING_LINES = 400;
const LOG_TAIL_MAX = 2000;
const LOG_TAIL_DEFAULT = 200;
const PROGRESS_PERSIST_MS = 5000;
const PROGRESS_EMIT_MS = 1000;
const POLL_MS = 30 * 1000;
const STOP_WAIT_MS = 3000;
const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 100;
const HISTORY_LIMIT_DEFAULT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function randomBase32(chars) {
  let output = "";
  for (const byte of crypto.randomBytes(chars)) output += BASE32_ALPHABET[byte & 31];
  return output;
}

function newJobId() {
  return `dl_${randomBase32(16)}`;
}

function settingAt(settings, key, fallback) {
  let current = settings;
  for (const segment of key.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return fallback;
    current = current[segment];
  }
  return current === undefined || current === null ? fallback : current;
}

function numberSetting(settings, key, fallback) {
  const value = Number(settingAt(settings, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function remainingBytes(job) {
  const total = Number(job?.artifact?.totalBytes) || 0;
  const done = Number(job?.progress?.bytesDone) || 0;
  return Math.max(0, total - done);
}

function compareQueue(a, b) {
  const rank = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
  if (rank) return rank;
  return (Number(a.queueOrder) || 0) - (Number(b.queueOrder) || 0);
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (Number.isInteger(value?.o) && value.o >= 0) return value.o;
  } catch {
    // Falls through to the error below.
  }
  throw new HubError("invalid_cursor", "The cursor is not valid.", { status: 400 });
}

function clampLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function listOf(value) {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : String(value).split(",")).map((item) => String(item).trim()).filter(Boolean);
}

function notFound(id) {
  return new HubError("download_not_found", "No such download.", { status: 404, details: { id: String(id || "").slice(0, 80) } });
}

function invalidState(job, action) {
  return new HubError("invalid_state", `A ${job.state} download cannot be ${action}.`, {
    status: 409,
    details: { id: job.id, state: job.state, ...(job.waitReason ? { waitReason: job.waitReason } : {}) },
  });
}

// A failure the queue raises itself (a HubError before spawn, a lock error):
// the §6.3 result shape, so the job error and the retry policy treat it like
// a classified transfer failure.
function failureFromError(error, job, data) {
  const code = String(error?.code || "");
  if (error instanceof HubError && HUB_ERROR_CODES.includes(code)) {
    const described = describeHubError(code, data || undefined);
    return {
      code,
      baseCode: described.baseCode,
      class: described.class,
      retryable: typeof error.retryable === "boolean" ? error.retryable : described.retryable,
      retryDelayFactor: described.retryDelayFactor,
      title: { ...described.title },
      hint: { ...described.hint },
      actions: [...described.actions],
      detail: String(error.message || ""),
    };
  }
  if (error instanceof HubError) {
    // A code outside the taxonomy (invalid_transfer_options,
    // credential_host_violation, token_not_allowed_on_mirror,
    // selection_compile_error): never retried, shown as is.
    return {
      code,
      baseCode: "unknown",
      class: "tooling",
      retryable: false,
      title: { zh: "下载任务无法启动", en: "The download could not start" },
      hint: { zh: String(error.hint || "查看日志后重新计划下载。"), en: String(error.hint || "Check the log, then plan the download again.") },
      actions: ["view-log"],
      detail: String(error.message || code),
    };
  }
  return classifyTransferFailure({ exitCode: null, stderrTail: [], phase: job.state, source: job.transfer?.options?.source, spawnError: error, job }, { data: data || undefined });
}

/**
 * createDownloadQueue(deps) → queue. Every dependency except the store is
 * optional for tests; the hub (index.js) passes the real ones.
 */
function createDownloadQueue(options = {}) {
  const store = options.store;
  if (!store || typeof store.writeDownloads !== "function") throw new TypeError("createDownloadQueue needs the hub store");
  const engine = options.engine || null;
  const monitorFactory = typeof options.monitorFactory === "function" ? options.monitorFactory : null;
  const verifier = options.verifier || null;
  const library = options.library || null;
  const getSettings = typeof options.settings === "function" ? options.settings : () => options.settings || {};
  const busySignal = typeof options.busySignal === "function" ? options.busySignal : null;
  const disk = options.disk || null;
  const events = options.events && typeof options.events.publish === "function" ? options.events : null;
  const tokens = options.tokens || null;
  const modelStorage = options.modelStorage || null;
  const getBusyPaths = typeof options.getBusyPaths === "function" ? options.getBusyPaths : null;
  const runAfter = options.runAfter || null;
  const errorData = typeof options.errorData === "function" ? options.errorData : () => null;
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const timers = options.timers || { setTimeout, clearTimeout };
  const logger = options.logger || console;
  const pollMs = Number(options.pollMs) >= 0 ? Number(options.pollMs) : POLL_MS;
  const stopWaitMs = Number(options.stopWaitMs) >= 0 ? Number(options.stopWaitMs) : STOP_WAIT_MS;
  const logsDir = store.dataDir ? path.join(store.dataDir, "logs") : null;
  const redactor = options.redactor
    || createSecretRedactor({ getSecrets: () => (tokens && typeof tokens.values === "function" ? tokens.values() : []) });
  const reserveOf = disk && typeof disk.reserveBytes === "function" ? disk.reserveBytes : defaultReserveBytes;

  let jobs = [];
  // Records of downloads.json the queue cannot schedule (no dl_ id, no
  // target or no file list): kept as they are, never dropped (00 §6).
  let foreign = [];
  let started = false;
  let stopping = false;
  let lastOrder = 0;
  // Runtime-only state of a job that is in process: the engine handle, the
  // monitor, the verify abort and the reason it is being stopped.
  const runs = new Map();
  const retryTimers = new Map();
  const lastEmit = new Map();
  // One notification per wait (03 §8): the auth and disk notices are not
  // repeated while the job keeps waiting for the same reason.
  const noticed = new Set();
  let idleSince = null;
  let busyUnknownLogged = false;
  let pumping = null;
  let pumpAgain = false;
  let recheckTimer = null;
  let recheckAt = 0;
  let resumeTimer = null;
  let persistTimer = null;

  const now = () => clock.now();
  const nowIso = () => new Date(now()).toISOString();
  const settings = () => {
    try {
      const value = getSettings();
      return isPlainObject(value) ? value : {};
    } catch {
      return {};
    }
  };

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactor.redact(String(line)));
    } catch {
      // Logging never breaks the queue.
    }
  }

  // --- persistence and events ---------------------------------------------------

  function document() {
    return { schemaVersion: JOB_SCHEMA_VERSION, jobs: foreign.length ? [...jobs, ...foreign] : jobs };
  }

  function persist() {
    if (persistTimer) {
      timers.clearTimeout(persistTimer);
      persistTimer = null;
    }
    return store.writeDownloads(document()).catch((error) => warn(`model hub: writing downloads.json failed: ${error?.message || error}`));
  }

  // Progress is persisted at most every 5 s (03 §8).
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = timers.setTimeout(() => {
      persistTimer = null;
      persist();
    }, PROGRESS_PERSIST_MS);
    persistTimer?.unref?.();
  }

  /** The API shape of a job: the persisted record minus `logs` (03 §8.1). */
  function publicJob(job) {
    if (!job) return null;
    const { logs: _logs, ...rest } = job;
    return clone(rest);
  }

  function aggregate() {
    let activeCount = 0;
    let queuedCount = 0;
    let speedBps = 0;
    let remaining = 0;
    for (const job of jobs) {
      if (IN_PROCESS_STATES.includes(job.state)) {
        activeCount += 1;
        speedBps += Number(job.progress?.speedEmaBps ?? job.progress?.speedBps) || 0;
        remaining += remainingBytes(job);
      } else if (PENDING_STATES.includes(job.state)) {
        queuedCount += 1;
      }
    }
    return { activeCount, queuedCount, speedBps, etaSeconds: speedBps > 0 && remaining > 0 ? Math.round(remaining / speedBps) : null };
  }

  function publish(type, payload) {
    if (!events) return;
    try {
      events.publish(type, payload);
    } catch (error) {
      warn(`model hub: publishing a ${type} event failed: ${error?.message || error}`);
    }
  }

  function emitJob(job, kind = "job") {
    lastEmit.set(job.id, now());
    publish("downloads", { kind, jobs: [publicJob(job)], aggregate: aggregate() });
  }

  function emitRemoved(ids) {
    publish("downloads", { kind: "removed", jobs: [], removed: ids, aggregate: aggregate() });
  }

  function notify(job, kind, severity, title, body, action) {
    const payload = {
      kind,
      severity,
      title,
      ...(body ? { body: { zh: redactor.redact(body.zh), en: redactor.redact(body.en) } } : {}),
      ...(action ? { action } : {}),
      jobId: job.id,
    };
    publish("notification", payload);
  }

  function repoLabel(job) {
    const repo = String(job.artifact?.repo || job.target?.outputName || job.id);
    const quant = job.artifact?.quant ? ` ${job.artifact.quant}` : "";
    return `${repo}${quant}`;
  }

  // --- logs ---------------------------------------------------------------------

  function appendLog(job, line) {
    if (!Array.isArray(job.logs)) job.logs = [];
    const text = redactor.redact(String(line ?? ""));
    job.logs.push(text);
    if (job.logs.length > LOG_RING_LINES) job.logs.splice(0, job.logs.length - LOG_RING_LINES);
  }

  // --- state transitions --------------------------------------------------------

  function setState(job, state, { waitReason = null, persistNow = true, emit = true } = {}) {
    const reason = state === "waiting" ? waitReason : null;
    if (job.state === state && (job.waitReason || null) === reason) return false;
    const at = nowIso();
    job.state = state;
    job.waitReason = reason;
    job.updatedAt = at;
    job.phaseHistory = Array.isArray(job.phaseHistory) ? job.phaseHistory : [];
    job.phaseHistory.push(reason ? { phase: state, reason, at } : { phase: state, at });
    if (job.phaseHistory.length > PHASE_HISTORY_CAP) job.phaseHistory.splice(0, job.phaseHistory.length - PHASE_HISTORY_CAP);
    if (TERMINAL_STATES.includes(state)) job.finishedAt = at;
    else job.finishedAt = null;
    if (state !== "waiting" || reason !== "auth") noticed.delete(`auth:${job.id}`);
    if (state !== "waiting" || reason !== "disk") noticed.delete(`disk:${job.id}`);
    if (persistNow) persist();
    if (emit) emitJob(job);
    return true;
  }

  function nextOrder() {
    lastOrder = Math.max(now(), lastOrder + 1);
    return lastOrder;
  }

  // The head of a priority band: before every other job of that band.
  function headOrder(priority) {
    const band = jobs.filter((job) => job.priority === priority && !TERMINAL_STATES.includes(job.state));
    const min = band.reduce((value, job) => Math.min(value, Number(job.queueOrder) || 0), Infinity);
    return Number.isFinite(min) ? min - 1 : nextOrder();
  }

  function find(id) {
    const value = String(id || "");
    if (!value) return null;
    return jobs.find((job) => job.id === value) || jobs.find((job) => Array.isArray(job.legacyIds) && job.legacyIds.includes(value)) || null;
  }

  function mustFind(id) {
    const job = find(id);
    if (!job) throw notFound(id);
    return job;
  }

  // --- credentials --------------------------------------------------------------

  function tokenMissing(job) {
    const opts = job.transfer?.options || {};
    if (opts.credentialMode !== "temp-token") return false;
    if (!opts.tokenRef || !tokens || typeof tokens.resolve !== "function") return true;
    try {
      return !tokens.resolve(opts.tokenRef);
    } catch {
      return true;
    }
  }

  function releaseToken(job) {
    const ref = job.transfer?.options?.tokenRef;
    if (!ref || !tokens || typeof tokens.release !== "function") return;
    Promise.resolve()
      .then(() => tokens.release(ref))
      .catch((error) => warn(`model hub: releasing a token reference failed: ${error?.message || error}`));
  }

  // 03 §8 / §12: the token of a temp-token job is gone (an entry restart
  // without "remember"). The job is neither failed nor spawned; one
  // notification asks for the token again.
  function toAuthWait(job) {
    setState(job, "waiting", { waitReason: "auth" });
    const key = `auth:${job.id}`;
    if (noticed.has(key)) return;
    noticed.add(key);
    appendLog(job, "The temporary Hugging Face token is no longer in memory; the download waits for it to be entered again.");
    notify(
      job,
      "hub.download.auth",
      "warn",
      { zh: "需要重新输入 Hugging Face 令牌", en: "Re-enter the Hugging Face token" },
      { zh: `下载 ${repoLabel(job)} 需要令牌才能继续。`, en: `The download of ${repoLabel(job)} needs the token to continue.` },
      { label: { zh: "输入令牌", en: "Enter token" }, apiCall: { method: "POST", path: `/api/hub/downloads/${job.id}/resume` } },
    );
  }

  // --- retries ------------------------------------------------------------------

  function clearRetryTimer(job) {
    const timer = retryTimers.get(job.id);
    if (timer) timers.clearTimeout(timer);
    retryTimers.delete(job.id);
  }

  function armRetry(job) {
    clearRetryTimer(job);
    const at = Date.parse(String(job.retry?.nextAt || ""));
    const delay = Number.isFinite(at) ? Math.max(0, at - now()) : 0;
    const timer = timers.setTimeout(() => {
      retryTimers.delete(job.id);
      if (!started || job.state !== "retrying") return;
      job.retry.nextAt = null;
      setState(job, "queued");
      schedulePump();
    }, delay);
    timer?.unref?.();
    retryTimers.set(job.id, timer);
  }

  function errorRecord(failure) {
    return {
      code: String(failure.code || "unknown"),
      baseCode: String(failure.baseCode || failure.code || "unknown"),
      class: String(failure.class || "unknown"),
      retryable: Boolean(failure.retryable),
      title: { ...(failure.title || {}) },
      hint: { ...(failure.hint || {}) },
      actions: Array.isArray(failure.actions) ? [...failure.actions] : [],
      detail: failure.detail ? redactor.redact(String(failure.detail)) : "",
      at: nowIso(),
    };
  }

  function handleFailure(job, failure) {
    const current = settings();
    const decision = retryDecision(failure, job, current, { data: errorData() || undefined, now: now() });
    job.retry = isPlainObject(job.retry) ? job.retry : { count: 0, max: 0, nextAt: null, history: [] };
    job.retry.history = Array.isArray(job.retry.history) ? job.retry.history : [];
    job.retry.history.push({ at: nowIso(), code: String(failure.code || "unknown") });
    if (job.retry.history.length > RETRY_HISTORY_CAP) job.retry.history.splice(0, job.retry.history.length - RETRY_HISTORY_CAP);
    job.retry.max = decision.max;
    const record = errorRecord(failure);
    appendLog(job, `Attempt failed: ${record.code}${record.detail ? ` (${record.detail})` : ""}`);
    if (decision.retry) {
      if (decision.remedy) {
        job.transfer.options = { ...job.transfer.options, ...decision.remedy.set };
        job.transfer.optionsHistory = Array.isArray(job.transfer.optionsHistory) ? job.transfer.optionsHistory : [];
        job.transfer.optionsHistory.push({ at: nowIso(), reason: decision.remedy.reason, set: { ...decision.remedy.set } });
        appendLog(job, `Transfer options changed for the retry: ${JSON.stringify(decision.remedy.set)}`);
      }
      job.retry.count = decision.attempt;
      job.retry.nextAt = decision.nextAt;
      job.retry.lastError = record;
      job.error = null;
      appendLog(job, `Retrying automatically (${decision.attempt}/${decision.max}) at ${decision.nextAt}.`);
      setState(job, "retrying");
      armRetry(job);
      return;
    }
    job.retry.nextAt = null;
    job.error = record;
    setState(job, "failed");
    if (settingAt(settings(), "notifications.onFailure", true) !== false) {
      notify(
        job,
        "hub.download.failed",
        "error",
        { zh: `下载失败：${repoLabel(job)}`, en: `Download failed: ${repoLabel(job)}` },
        { zh: `${record.title.zh || record.code}。${record.hint.zh || ""}`, en: `${record.title.en || record.code}. ${record.hint.en || ""}` },
        { label: { zh: "查看下载", en: "View download" }, href: `/models/downloads?job=${job.id}` },
      );
    }
    compact();
  }

  // --- running a job --------------------------------------------------------------

  function finishRun(job, run) {
    if (runs.get(job.id) === run) runs.delete(job.id);
    run.resolveDone?.();
  }

  function onProgress(job, run, progress, info = {}) {
    if (runs.get(job.id) !== run || run.stopReason) return;
    const phase = info.phase;
    if ((phase === "downloading" || phase === "materializing") && TRANSFER_STATES.includes(job.state) && job.state !== phase && job.state !== "resolving") {
      setState(job, phase);
      return;
    }
    job.updatedAt = nowIso();
    persistSoon();
    const last = lastEmit.get(job.id) || 0;
    if (now() - last >= PROGRESS_EMIT_MS) emitJob(job, "progress");
  }

  function startMonitor(job, run) {
    if (!monitorFactory) return null;
    try {
      return monitorFactory(job, {
        onUpdate: (progress, info) => onProgress(job, run, progress, info),
        onStall: (info) => {
          if (runs.get(job.id) !== run || run.stopReason) return;
          run.signals = { ...(info?.signals || { stalled: true }) };
          appendLog(job, `No progress for ${Math.round((Number(info?.idleMs) || 0) / 60000)} min in ${info?.phase || job.state}; stopping the attempt.`);
          run.stopReason = "stall";
          run.handle?.stop("stall");
        },
        onLog: (line) => appendLog(job, line),
      });
    } catch (error) {
      warn(`model hub: the progress monitor could not start for ${job.id}: ${error?.message || error}`);
      return null;
    }
  }

  async function verifyJob(job, run) {
    setState(job, "verifying");
    run.monitor?.setPhase?.("verifying");
    if (!verifier || typeof verifier.verifyArtifact !== "function") return { ok: true, verifiedFiles: [], seconds: 0 };
    const controller = new AbortController();
    run.abort = controller;
    try {
      return await verifier.verifyArtifact(job, {
        signal: controller.signal,
        monitor: run.monitor,
        settings: settings(),
        onLog: (line) => appendLog(job, line),
        onProgress: () => {
          if (runs.get(job.id) !== run || run.stopReason) return;
          persistSoon();
          if (now() - (lastEmit.get(job.id) || 0) >= PROGRESS_EMIT_MS) emitJob(job, "progress");
        },
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return { aborted: true };
      return { ok: false, failure: failureFromError(error, job, errorData()) };
    }
  }

  async function completeJob(job, run, result) {
    job.retry.badFiles = [];
    let entryId = null;
    if (library && typeof library.registerFromJob === "function") {
      try {
        const registered = await library.registerFromJob(job);
        entryId = registered?.entryId || null;
      } catch (error) {
        appendLog(job, `The library registration failed: ${error?.message || error}`);
      }
    }
    job.result = {
      libraryEntryId: entryId,
      verifiedFiles: Array.isArray(result.verifiedFiles) ? result.verifiedFiles.length : 0,
      skippedFiles: Number(result.skipped) || 0,
      verifySeconds: Number(result.seconds) || 0,
    };
    job.progress = { ...(job.progress || {}), percent: 100, bytesDone: Number(job.artifact?.totalBytes) || job.progress?.bytesDone || 0, etaSeconds: 0, speedBps: 0, updatedAt: nowIso() };
    job.error = null;
    appendLog(job, "Download verified and ready.");
    setState(job, "ready");
    releaseToken(job);
    finishRun(job, run);
    if (settingAt(settings(), "notifications.onReady", true) !== false) {
      notify(
        job,
        "hub.download.ready",
        "success",
        { zh: `下载完成：${repoLabel(job)}`, en: `Download ready: ${repoLabel(job)}` },
        { zh: "已校验并加入模型库。", en: "Verified and added to the library." },
        entryId ? { label: { zh: "查看模型", en: "Open in library" }, href: `/models/library?entry=${entryId}` } : undefined,
      );
    }
    if (job.runAfter && runAfter && typeof runAfter.start === "function") {
      Promise.resolve()
        .then(() => runAfter.start(job))
        .catch((error) => warn(`model hub: run-after failed for ${job.id}: ${error?.message || error}`));
    }
    compact();
  }

  async function onEngineExit(job, run, exit = {}) {
    try {
      await run.monitor?.noteExit?.({ code: exit.code });
    } catch {
      // The final sample is best effort.
    }
    job.transfer.pid = null;
    job.transfer.exitCode = exit.code ?? null;
    const reason = run.stopReason || exit.stopReason || null;
    if (reason === "shutdown" || reason === "cancel") {
      finishRun(job, run);
      return;
    }
    if (reason === "pause") {
      job.autoResume = false;
      setState(job, "paused");
      finishRun(job, run);
      schedulePump();
      return;
    }
    if (reason === "stall" || exit.error || exit.code !== 0) {
      const failure = classifyTransferFailure({
        exitCode: exit.code ?? null,
        stderrTail: exit.stderrTail || run.handle?.stderrTail?.() || [],
        phase: job.state,
        source: job.transfer?.options?.source,
        spawnError: exit.error || null,
        job,
        signals: run.signals || {},
      }, { data: errorData() || undefined });
      finishRun(job, run);
      handleFailure(job, failure);
      schedulePump();
      return;
    }
    const result = await verifyJob(job, run);
    if (result.aborted || run.stopReason) {
      if (run.stopReason === "pause") {
        job.autoResume = false;
        setState(job, "paused");
      }
      finishRun(job, run);
      schedulePump();
      return;
    }
    if (result.ok) {
      await completeJob(job, run, result);
      schedulePump();
      return;
    }
    let failure = result.failure || failureFromError(new Error("Verification failed"), job, errorData());
    const previous = new Set(Array.isArray(job.retry?.badFiles) ? job.retry.badFiles : []);
    const bad = Array.isArray(result.badFiles) ? result.badFiles : [];
    // 03 §6.3: the same file failing verification twice is not retried again.
    if (bad.some((file) => previous.has(file))) failure = { ...failure, retryable: false };
    job.retry.badFiles = Array.from(new Set([...previous, ...bad]));
    finishRun(job, run);
    handleFailure(job, failure);
    schedulePump();
  }

  function runJob(job) {
    const run = { handle: null, monitor: null, abort: null, stopReason: null, signals: null };
    run.done = new Promise((resolve) => { run.resolveDone = resolve; });
    runs.set(job.id, run);
    job.transfer.attempt = (Number(job.transfer.attempt) || 0) + 1;
    job.startedAt = job.startedAt || nowIso();
    job.bypassIdleOnce = false;
    job.forceSlot = false;
    job.error = null;
    job.autoResume = true;
    appendLog(job, `Attempt ${job.transfer.attempt} started.`);
    setState(job, "resolving");

    if (tokenMissing(job)) {
      finishRun(job, run);
      toAuthWait(job);
      return;
    }
    if (!engine || typeof engine.start !== "function") {
      finishRun(job, run);
      handleFailure(job, failureFromError(new HubError("cli_missing", "No transfer engine is configured.", { status: 503 }), job, errorData()));
      return;
    }
    try {
      fs.mkdirSync(job.target.localDir, { recursive: true });
    } catch (error) {
      finishRun(job, run);
      handleFailure(job, failureFromError(error, job, errorData()));
      return;
    }
    run.monitor = startMonitor(job, run);
    try {
      run.handle = engine.start(job, {
        onLine: (stream, text) => {
          run.monitor?.noteLine?.(stream, text);
          appendLog(job, text);
        },
        onSpawn: ({ pid, startedAt }) => {
          job.transfer.pid = pid ?? null;
          job.transfer.pidStartedAt = startedAt || nowIso();
          persist();
        },
        onBatch: ({ batchIndex, batches }) => {
          job.transfer.batchIndex = batchIndex;
          job.transfer.batches = batches;
          persistSoon();
        },
        onExit: (exit) => {
          onEngineExit(job, run, exit).catch((error) => {
            warn(`model hub: finishing ${job.id} failed: ${error?.message || error}`);
            finishRun(job, run);
          });
        },
      });
    } catch (error) {
      run.monitor?.stop?.();
      finishRun(job, run);
      if (error?.code === "hf_token_expired") {
        toAuthWait(job);
        return;
      }
      handleFailure(job, failureFromError(error, job, errorData()));
      return;
    }
    job.transfer.batches = Number(job.transfer.batches) || 1;
    setState(job, "downloading");
    run.monitor?.setPhase?.("downloading");
    run.monitor?.start?.();
  }

  // --- the scheduler ----------------------------------------------------------

  function countActive() {
    return jobs.filter((job) => IN_PROCESS_STATES.includes(job.state)).length;
  }

  function scheduleRecheck(delayMs) {
    if (!started) return;
    const at = now() + Math.max(0, delayMs);
    if (recheckTimer && recheckAt <= at) return;
    if (recheckTimer) timers.clearTimeout(recheckTimer);
    recheckAt = at;
    recheckTimer = timers.setTimeout(() => {
      recheckTimer = null;
      recheckAt = 0;
      schedulePump();
    }, Math.max(0, delayMs));
    recheckTimer?.unref?.();
  }

  // 03 §8: idle means two consecutive idle polls idleGraceSeconds apart.
  // Unreachable managers count as not busy (known: false), logged once.
  async function idleGate() {
    let load = null;
    try {
      load = busySignal ? await busySignal() : { busy: false, known: false };
    } catch (error) {
      load = { busy: false, known: false };
      if (!busyUnknownLogged) warn(`model hub: the runtime load could not be read; treating the platform as idle: ${error?.message || error}`);
      busyUnknownLogged = true;
    }
    if (load && load.known === false && !busyUnknownLogged) {
      busyUnknownLogged = true;
      warn("model hub: some runtime load is unknown (a manager is unreachable); it counts as idle.");
    }
    const graceMs = Math.max(0, numberSetting(settings(), "queue.idleGraceSeconds", 30) * 1000);
    if (load?.busy) {
      idleSince = null;
      scheduleRecheck(pollMs);
      return false;
    }
    const t = now();
    if (idleSince === null) idleSince = t;
    if (t - idleSince >= graceMs) return true;
    scheduleRecheck(Math.min(pollMs, graceMs - (t - idleSince)));
    return false;
  }

  async function diskAllows(job) {
    if (!disk || typeof disk.freeBytes !== "function") return true;
    let free = null;
    try {
      free = await disk.freeBytes(job.target.localDir, job);
    } catch {
      free = null;
    }
    if (!Number.isFinite(Number(free)) || free === null) return true;
    const volume = job.target.volume || null;
    const pending = jobs
      .filter((other) => other !== job && IN_PROCESS_STATES.includes(other.state) && (other.target?.volume || null) === volume)
      .reduce((sum, other) => sum + remainingBytes(other), 0);
    const reserve = reserveOf(Number(free), settings());
    return remainingBytes(job) <= availableBytes({ free: Number(free), pending, reserve });
  }

  function toDiskWait(job) {
    setState(job, "waiting", { waitReason: "disk" });
    const key = `disk:${job.id}`;
    if (noticed.has(key)) return;
    noticed.add(key);
    notify(
      job,
      "hub.download.disk",
      "warn",
      { zh: "磁盘空间不足，下载在等待", en: "Not enough disk space; the download is waiting" },
      { zh: `${repoLabel(job)} 所在的 ${job.target.volume || "磁盘"} 剩余空间不足（含预留）。`, en: `The ${job.target.volume || "disk"} for ${repoLabel(job)} is short of space (including the reserve).` },
      { label: { zh: "打开存储", en: "Open storage" }, href: "/models/storage" },
    );
  }

  async function pumpOnce() {
    if (!started || stopping) return;
    // A token entered again (resume with a credential) or remembered makes
    // an auth wait runnable; everything else waits for its own trigger.
    for (const job of jobs) {
      if (job.state === "waiting" && job.waitReason === "auth" && !tokenMissing(job)) setState(job, "queued");
    }
    const candidates = jobs
      .filter((job) => job.state === "queued" || (job.state === "waiting" && job.waitReason !== "auth"))
      .sort(compareQueue);
    if (!candidates.length) return;
    const current = settings();
    const limit = Math.max(1, Math.min(4, Math.floor(numberSetting(current, "transfer.maxConcurrent", 1))));
    const idleOnly = settingAt(current, "queue.idleOnly", false) === true;
    let active = countActive();
    let idleOk = null;
    let blockedByConcurrency = false;
    for (const job of candidates) {
      if (!started || stopping) return;
      if (job.state !== "queued" && job.state !== "waiting") continue;
      const slotFree = active < limit || (job.forceSlot === true && active < limit + 1);
      if (!slotFree) {
        if (!blockedByConcurrency) setState(job, "waiting", { waitReason: "concurrency" });
        else if (job.state === "waiting" && job.waitReason === "concurrency") setState(job, "queued");
        blockedByConcurrency = true;
        continue;
      }
      if (tokenMissing(job)) {
        toAuthWait(job);
        continue;
      }
      if (idleOnly && job.bypassIdleOnce !== true) {
        if (idleOk === null) idleOk = await idleGate();
        if (!idleOk) {
          setState(job, "waiting", { waitReason: "runtime-busy" });
          // The head waits; the rest of the queue stays behind it.
          break;
        }
      }
      if (!(await diskAllows(job))) {
        toDiskWait(job);
        scheduleRecheck(pollMs);
        continue;
      }
      if (!started || stopping || (job.state !== "queued" && job.state !== "waiting")) continue;
      active += 1;
      runJob(job);
    }
  }

  function schedulePump() {
    if (!started || stopping) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = (async () => {
      try {
        do {
          pumpAgain = false;
          await pumpOnce();
        } while (pumpAgain && started && !stopping);
      } catch (error) {
        warn(`model hub: the download scheduler failed: ${error?.message || error}`);
      } finally {
        pumping = null;
      }
    })();
  }

  // --- history ----------------------------------------------------------------

  function compactRecord(job) {
    const artifact = job.artifact || {};
    const opts = job.transfer?.options || {};
    return {
      schemaVersion: JOB_SCHEMA_VERSION,
      id: job.id,
      legacyIds: Array.isArray(job.legacyIds) ? [...job.legacyIds] : [],
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      origin: clone(job.origin || {}),
      ownerManagerId: job.ownerManagerId,
      state: job.state,
      artifact: {
        provider: artifact.provider,
        repo: artifact.repo,
        revision: artifact.revision,
        revisionSha: artifact.revisionSha || null,
        artifactKey: artifact.artifactKey,
        kind: artifact.kind,
        format: artifact.format,
        quant: artifact.quant ?? null,
        fileCount: Array.isArray(artifact.files) ? artifact.files.length : 0,
        totalBytes: Number(artifact.totalBytes) || 0,
      },
      target: clone(job.target || {}),
      transfer: {
        engine: job.transfer?.engine || "cli",
        attempt: Number(job.transfer?.attempt) || 0,
        options: { source: opts.source, endpoint: opts.endpoint || null, xet: opts.xet, credentialMode: opts.credentialMode, remember: Boolean(opts.remember) },
      },
      progress: { bytesDone: Number(job.progress?.bytesDone) || 0, bytesTotal: Number(job.progress?.bytesTotal) || 0, speedEmaBps: Number(job.progress?.speedEmaBps) || 0 },
      retry: { count: Number(job.retry?.count) || 0 },
      error: job.error ? clone(job.error) : null,
      result: job.result ? clone(job.result) : null,
    };
  }

  // Terminal jobs beyond history.keepRecords leave downloads.json for the
  // compact history log (03 §8).
  function compact() {
    const keep = Math.max(0, Math.floor(numberSetting(settings(), "history.keepRecords", 200)));
    const terminal = jobs.filter((job) => TERMINAL_STATES.includes(job.state))
      .sort((a, b) => String(b.finishedAt || b.updatedAt || "").localeCompare(String(a.finishedAt || a.updatedAt || "")));
    const drop = terminal.slice(keep);
    if (!drop.length) return [];
    const ids = new Set(drop.map((job) => job.id));
    jobs = jobs.filter((job) => !ids.has(job.id));
    for (const job of drop) releaseToken(job);
    store.appendHistory(drop.map(compactRecord)).catch((error) => warn(`model hub: appending the download history failed: ${error?.message || error}`));
    persist();
    emitRemoved([...ids]);
    return [...ids];
  }

  async function pruneHistory() {
    if (typeof store.rewriteHistory !== "function") return 0;
    const days = Math.max(1, numberSetting(settings(), "history.retentionDays", 365));
    const cutoff = now() - days * DAY_MS;
    try {
      return await store.rewriteHistory((record) => {
        const at = Date.parse(String(record.finishedAt || record.createdAt || ""));
        return !Number.isFinite(at) || at >= cutoff;
      });
    } catch (error) {
      warn(`model hub: pruning the download history failed: ${error?.message || error}`);
      return 0;
    }
  }

  // --- lifecycle ------------------------------------------------------------------

  /** Takes the persisted jobs (downloads.json) before start(). */
  function load(doc) {
    const list = Array.isArray(doc?.jobs) ? doc.jobs : Array.isArray(doc) ? doc : [];
    const usable = (job) => isPlainObject(job) && JOB_ID_RE.test(String(job.id || "")) && JOB_STATES.includes(job.state)
      && isPlainObject(job.target) && nonEmpty(job.target.localDir) && Array.isArray(job.artifact?.files);
    jobs = list.filter(usable).map((job) => normalizeLoaded(clone(job)));
    foreign = list.filter((job) => !usable(job));
    if (foreign.length) warn(`model hub: ${foreign.length} record(s) in downloads.json are not download jobs the queue can run; they are kept unchanged.`);
    lastOrder = jobs.reduce((max, job) => Math.max(max, Number(job.queueOrder) || 0), 0);
    return jobs.length;
  }

  function normalizeLoaded(job) {
    job.legacyIds = Array.isArray(job.legacyIds) ? job.legacyIds : [];
    job.phaseHistory = Array.isArray(job.phaseHistory) ? job.phaseHistory : [];
    job.priority = PRIORITIES.includes(job.priority) ? job.priority : "normal";
    job.transfer = isPlainObject(job.transfer) ? job.transfer : { engine: "cli", options: {} };
    job.transfer.options = isPlainObject(job.transfer.options) ? job.transfer.options : {};
    job.retry = isPlainObject(job.retry) ? job.retry : { count: 0, max: 0, nextAt: null, history: [] };
    job.progress = isPlainObject(job.progress) ? job.progress : {};
    job.logs = Array.isArray(job.logs) ? job.logs.slice(-LOG_RING_LINES) : [];
    if (job.state === "waiting" && !WAIT_REASONS.includes(job.waitReason)) job.state = "queued";
    if (job.state !== "waiting") job.waitReason = null;
    return job;
  }

  /**
   * After load(): orphan check, in-process → interrupted, auth waits, retry
   * timers, then (after queue.resumeDelaySeconds) the interrupted jobs
   * re-enter the queue in their original order (03 §8 restart semantics).
   */
  async function start() {
    if (started) return;
    started = true;
    stopping = false;
    await pruneHistory();
    const inProcess = jobs.filter((job) => IN_PROCESS_STATES.includes(job.state));
    if (inProcess.some((job) => Number(job.transfer?.pid) > 0) && engine && typeof engine.findOrphans === "function") {
      try {
        const found = await engine.findOrphans(inProcess, { kill: true });
        for (const entry of found || []) {
          const job = find(entry.jobId);
          if (job && entry.killed) appendLog(job, `A download process left by the previous entry run (pid ${entry.pid}) was stopped.`);
        }
      } catch (error) {
        warn(`model hub: the orphan check failed: ${error?.message || error}`);
      }
    }
    for (const job of inProcess) {
      job.transfer.pid = null;
      job.autoResume = true;
      appendLog(job, "The service entry stopped during this download; it resumes after the restart.");
      setState(job, "interrupted", { persistNow: false });
    }
    for (const job of jobs) {
      if (["queued", "waiting", "retrying", "interrupted"].includes(job.state) && tokenMissing(job)) {
        clearRetryTimer(job);
        toAuthWait(job);
      }
    }
    for (const job of jobs) {
      if (job.state === "retrying") armRetry(job);
    }
    compact();
    persist();
    const current = settings();
    if (settingAt(current, "queue.resumeOnStart", true) !== false) {
      const delay = Math.max(0, numberSetting(current, "queue.resumeDelaySeconds", 20) * 1000);
      resumeTimer = timers.setTimeout(() => {
        resumeTimer = null;
        if (!started || stopping) return;
        const interrupted = jobs.filter((job) => job.state === "interrupted" && job.autoResume !== false).sort((a, b) => (Number(a.queueOrder) || 0) - (Number(b.queueOrder) || 0));
        for (const job of interrupted) setState(job, "queued");
        schedulePump();
      }, delay);
      resumeTimer?.unref?.();
    }
    schedulePump();
  }

  /**
   * Graceful stop (03 §8): every in-process job becomes `interrupted`
   * (autoResume) at once, so the caller's synchronous final write has it;
   * the processes are then stopped with reason "shutdown" within stopWaitMs.
   */
  async function stop({ reason = "shutdown" } = {}) {
    if (!started) return;
    stopping = true;
    started = false;
    for (const timer of retryTimers.values()) timers.clearTimeout(timer);
    retryTimers.clear();
    for (const timer of [recheckTimer, resumeTimer, persistTimer]) if (timer) timers.clearTimeout(timer);
    recheckTimer = null;
    resumeTimer = null;
    persistTimer = null;
    const waits = [];
    for (const [id, run] of runs) {
      const job = find(id);
      run.stopReason = "shutdown";
      if (job && IN_PROCESS_STATES.includes(job.state)) {
        job.autoResume = true;
        appendLog(job, `Stopped by the service entry (${reason}); it resumes after the restart.`);
        setState(job, "interrupted", { persistNow: false });
      }
      run.abort?.abort?.();
      try {
        run.monitor?.stop?.();
      } catch {
        // The monitor only has a timer.
      }
      if (run.handle && typeof run.handle.stop === "function") waits.push(Promise.resolve().then(() => run.handle.stop("shutdown")).catch(() => {}));
    }
    if (waits.length) {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise((resolve) => {
          const timer = timers.setTimeout(resolve, stopWaitMs);
          timer?.unref?.();
        }),
      ]);
    }
  }

  // --- enqueue ------------------------------------------------------------------

  async function libraryDuplicate(artifact) {
    if (!library || typeof library.list !== "function") return null;
    const files = (Array.isArray(artifact.files) ? artifact.files : []).map((file) => ({ path: file.path, size: Number(file.size) || 0, sha256: file.sha256 || null, gitOid: file.gitOid || null }));
    const provider = artifact.provider === "modelscope" ? "modelscope" : "huggingface";
    const key = identityKeyFor({ provider, repo: artifact.repo, revisionSha: artifact.revisionSha, confidence: "declared" }, files.length ? computeFilesetHash(files) : null);
    if (!key) return null;
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      const result = await library.list({ limit: 500, ...(cursor ? { cursor } : {}) });
      const hit = (result?.entries || []).find((entry) => entry.identityKey === key && entry.verification?.status !== "fail");
      if (hit) return hit;
      cursor = result?.nextCursor || null;
      if (!cursor) return null;
    }
    return null;
  }

  function activeOnDir(localDir, excludeId = "") {
    const key = pathKey(localDir);
    return jobs.find((job) => job.id !== excludeId && !TERMINAL_STATES.includes(job.state) && job.target?.localDir && pathKey(job.target.localDir) === key) || null;
  }

  /**
   * enqueue(spec, { allowDuplicate }) → DownloadJob. `spec` is a resolved
   * plan: { origin, ownerManagerId, artifact (files from the manifest),
   * target { rootId, rootLabel, outputName, localDir, volume }, transfer
   * { options, include }, priority, runAfter, legacyIds }. Dedupe (03 §8):
   * 409 already_downloading, already_in_library and target_occupied; 507
   * disk_full when the job alone cannot fit.
   */
  async function enqueue(spec = {}, { allowDuplicate = false } = {}) {
    if (!started || stopping) throw new HubError("hub_unavailable", "The download queue is not running.", { status: 503 });
    const artifact = isPlainObject(spec.artifact) ? clone(spec.artifact) : null;
    const target = isPlainObject(spec.target) ? clone(spec.target) : null;
    if (!artifact || !Array.isArray(artifact.files) || !artifact.files.length) {
      throw new HubError("filter_no_match", "The download has no files.", { status: 422 });
    }
    if (!target || !nonEmpty(target.localDir) || !path.isAbsolute(target.localDir)) {
      throw new HubError("invalid_request", "The download has no absolute target directory.", { status: 400 });
    }
    target.localDir = path.resolve(target.localDir);
    target.outputName = nonEmpty(target.outputName) ? target.outputName : path.basename(target.localDir);
    if (!target.volume && disk && typeof disk.volumeOf === "function") {
      try {
        target.volume = disk.volumeOf(target.localDir);
      } catch {
        target.volume = null;
      }
    }
    const existing = activeOnDir(target.localDir);
    if (existing) {
      throw new HubError("already_downloading", "This folder is already being downloaded.", { status: 409, details: { existingJobId: existing.id } });
    }
    if (!allowDuplicate) {
      const duplicate = await libraryDuplicate(artifact).catch(() => null);
      if (duplicate) {
        throw new HubError("already_in_library", "The same files are already in the library.", { status: 409, details: { entryId: duplicate.id } });
      }
    }
    artifact.totalBytes = Number(artifact.totalBytes) || artifact.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    if (disk && typeof disk.freeBytes === "function") {
      const free = await Promise.resolve(disk.freeBytes(target.localDir, { target })).catch(() => null);
      if (free !== null && Number.isFinite(Number(free))) {
        const reserve = reserveOf(Number(free), settings());
        if (artifact.totalBytes > Number(free) - reserve) {
          throw new HubError("disk_full", "The target drive does not have room for this download.", {
            status: 507,
            details: { volume: target.volume || null, freeBytes: Number(free), reserveBytes: reserve, totalBytes: artifact.totalBytes },
          });
        }
      }
    }
    if (modelStorage && typeof modelStorage.prepareDownload === "function") {
      try {
        modelStorage.prepareDownload(target.localDir, { model: artifact.repo, source: spec.transfer?.options?.source || artifact.provider, precision: artifact.quant || "" });
      } catch (error) {
        const status = Number(error?.status) || 409;
        if (status === 409) throw new HubError("target_occupied", "The target folder already holds other files.", { status: 409, hint: "Choose another folder name, or resume the original download." });
        throw new HubError("invalid_target", String(error?.message || "The target folder is not usable."), { status });
      }
    }
    const at = nowIso();
    const origin = isPlainObject(spec.origin) ? clone(spec.origin) : {};
    origin.kind = ORIGIN_KINDS.includes(origin.kind) ? origin.kind : "console";
    const transferOptions = isPlainObject(spec.transfer?.options) ? clone(spec.transfer.options) : {};
    delete transferOptions.hfToken;
    const job = {
      schemaVersion: JOB_SCHEMA_VERSION,
      id: newJobId(),
      legacyIds: Array.isArray(spec.legacyIds) ? spec.legacyIds.map(String) : [],
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      finishedAt: null,
      origin,
      ownerManagerId: spec.ownerManagerId === "llama" || spec.ownerManagerId === "vllm" ? spec.ownerManagerId : (artifact.format === "gguf" ? "llama" : "vllm"),
      state: "queued",
      waitReason: null,
      phaseHistory: [{ phase: "queued", at }],
      priority: PRIORITIES.includes(spec.priority) ? spec.priority : "normal",
      queueOrder: nextOrder(),
      pausedBy: null,
      autoResume: true,
      artifact,
      target,
      transfer: {
        engine: "cli",
        cli: transferOptions.source === "modelscope" ? "modelscope" : "hf",
        attempt: 0,
        batches: Array.isArray(spec.transfer?.include?.batches) ? spec.transfer.include.batches.length || 1 : 1,
        batchIndex: 0,
        pid: null,
        pidStartedAt: null,
        options: transferOptions,
        optionsHistory: [],
        ...(isPlainObject(spec.transfer?.include) ? { include: clone(spec.transfer.include) } : {}),
      },
      progress: {
        bytesDone: 0,
        bytesTotal: artifact.totalBytes,
        percent: 0,
        speedBps: 0,
        speedEmaBps: 0,
        etaSeconds: null,
        filesDone: 0,
        filesTotal: artifact.files.length,
        files: [],
        verify: { filesDone: 0, filesTotal: 0, bytesDone: 0 },
        samples: [],
        lastGrowthAt: null,
        updatedAt: at,
      },
      retry: { count: 0, max: Math.max(0, Math.floor(numberSetting(settings(), "retry.maxAttempts", 3))), nextAt: null, history: [] },
      error: null,
      advice: null,
      runAfter: spec.runAfter ?? null,
      result: null,
      bypassIdleOnce: false,
      forceSlot: false,
      logs: [],
    };
    appendLog(job, `Queued ${artifact.repo}${artifact.quant ? ` (${artifact.quant})` : ""} → ${target.outputName}.`);
    jobs.push(job);
    persist();
    emitJob(job);
    schedulePump();
    return publicJob(job);
  }

  // --- reads ------------------------------------------------------------------

  /**
   * list({ state, owner, include, limit, cursor }) → { jobs, aggregate,
   * nextCursor }. Without include=terminal only non-terminal jobs; queued
   * order first, then terminal jobs newest first.
   */
  function list(query = {}) {
    const states = listOf(query.state);
    for (const state of states) {
      if (!JOB_STATES.includes(state)) throw new HubError("invalid_request", `Unknown state "${state.slice(0, 40)}".`, { status: 400, details: { field: "state" } });
    }
    const owner = String(query.owner || "");
    const includeTerminal = listOf(query.include).includes("terminal") || states.some((state) => TERMINAL_STATES.includes(state));
    const limit = clampLimit(query.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
    const offset = decodeCursor(query.cursor);
    const matches = jobs.filter((job) => {
      if (!includeTerminal && TERMINAL_STATES.includes(job.state)) return false;
      if (states.length && !states.includes(job.state)) return false;
      if (owner && job.ownerManagerId !== owner) return false;
      return true;
    });
    const open = matches.filter((job) => !TERMINAL_STATES.includes(job.state)).sort(compareQueue);
    const done = matches.filter((job) => TERMINAL_STATES.includes(job.state))
      .sort((a, b) => String(b.finishedAt || "").localeCompare(String(a.finishedAt || "")));
    const ordered = [...open, ...done];
    const page = ordered.slice(offset, offset + limit).map(publicJob);
    return { jobs: page, aggregate: aggregate(), nextCursor: offset + limit < ordered.length ? encodeCursor(offset + limit) : null };
  }

  function get(id) {
    const job = find(id);
    return job ? publicJob(job) : null;
  }

  /** The log tail (already redacted): the job's log file, or the in-memory ring. */
  async function logs(id, { tail } = {}) {
    const job = mustFind(id);
    const count = clampLimit(tail, LOG_TAIL_DEFAULT, LOG_TAIL_MAX);
    let lines = null;
    if (logsDir) {
      try {
        const text = await fsp.readFile(path.join(logsDir, `${job.id}.log`), "utf8");
        lines = text.split(/\r?\n/).filter((line) => line !== "").map((line) => redactor.redact(line));
      } catch {
        lines = null;
      }
    }
    if (!lines || !lines.length) lines = Array.isArray(job.logs) ? job.logs.slice() : [];
    return { lines: lines.slice(-count), total: lines.length };
  }

  /** The compact history (downloads-history.jsonl), newest first. */
  function history(query = {}) {
    const text = String(query.q || "").trim().toLowerCase();
    const provider = String(query.provider || "");
    const states = listOf(query.state);
    const limit = clampLimit(query.limit, HISTORY_LIMIT_DEFAULT, LIST_LIMIT_MAX);
    const offset = decodeCursor(query.cursor);
    let records = [];
    try {
      records = store.readHistory().records;
    } catch (error) {
      warn(`model hub: reading the download history failed: ${error?.message || error}`);
    }
    const matches = records.slice().reverse().filter((record) => {
      if (provider && record.artifact?.provider !== provider && record.transfer?.options?.source !== provider) return false;
      if (states.length && !states.includes(record.state)) return false;
      if (text) {
        const haystack = [record.artifact?.repo, record.artifact?.quant, record.target?.outputName, record.id].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
    return { records: matches.slice(offset, offset + limit), nextCursor: offset + limit < matches.length ? encodeCursor(offset + limit) : null };
  }

  /** Per-file health before a resume, with disk free from the job's volume. */
  async function resumeCheck(id) {
    const job = mustFind(id);
    let free;
    if (disk && typeof disk.freeBytes === "function") {
      free = await Promise.resolve(disk.freeBytes(job.target.localDir, job)).catch(() => null);
    }
    const result = await inspectDownloadResume({
      localDir: job.target.localDir,
      fileManifest: (job.artifact?.files || []).map((file) => ({ name: file.path, size: Number(file.size) || 0 })),
      expectedBytes: Number(job.artifact?.totalBytes) || 0,
      ...(free === undefined ? {} : { diskFreeBytes: free }),
    });
    return { ...result, jobId: job.id, state: job.state, volume: job.target.volume || null, rootId: job.target.rootId || null, rootLabel: job.target.rootLabel || null, outputName: job.target.outputName };
  }

  // --- queue operations ---------------------------------------------------------

  async function stopRun(job, reason) {
    const run = runs.get(job.id);
    if (!run) return;
    run.stopReason = reason;
    run.abort?.abort?.();
    try {
      run.monitor?.stop?.();
    } catch {
      // See stop().
    }
    const stopped = run.handle && typeof run.handle.stop === "function" ? Promise.resolve().then(() => run.handle.stop(reason)).catch(() => {}) : Promise.resolve();
    await Promise.race([
      Promise.all([stopped, run.done]),
      new Promise((resolve) => {
        const timer = timers.setTimeout(resolve, Math.max(stopWaitMs, 50));
        timer?.unref?.();
      }),
    ]);
  }

  /** Pause stops the process and keeps the files (03 §8). */
  async function pause(id, { by = "user" } = {}) {
    const job = mustFind(id);
    if (job.state === "paused") return publicJob(job);
    if (TERMINAL_STATES.includes(job.state)) throw invalidState(job, "paused");
    clearRetryTimer(job);
    job.pausedBy = by;
    job.autoResume = false;
    if (runs.has(job.id)) {
      await stopRun(job, "pause");
      if (job.state !== "paused" && !TERMINAL_STATES.includes(job.state)) setState(job, "paused");
    } else {
      setState(job, "paused");
    }
    appendLog(job, `Paused by ${by}.`);
    schedulePump();
    return publicJob(job);
  }

  function applyCredential(job, credential) {
    if (!isPlainObject(credential) || !nonEmpty(credential.tokenRef)) return;
    if (job.transfer.options.source === "hf-mirror") {
      throw new HubError("token_not_allowed_on_mirror", "A mirror never receives a Hugging Face token.", { status: 422 });
    }
    const previous = job.transfer.options.tokenRef;
    job.transfer.options = { ...job.transfer.options, credentialMode: "temp-token", tokenRef: credential.tokenRef, remember: Boolean(credential.remember) };
    job.transfer.optionsHistory.push({ at: nowIso(), reason: "user/credential", set: { credentialMode: "temp-token", remember: Boolean(credential.remember) } });
    if (previous && previous !== credential.tokenRef && tokens && typeof tokens.release === "function") {
      Promise.resolve().then(() => tokens.release(previous)).catch(() => {});
    }
  }

  function applySource(job, source, sourceEndpoint) {
    if (source === undefined || source === null || source === job.transfer.options.source) return;
    const namespace = job.artifact?.provider === "modelscope" ? "modelscope" : "huggingface";
    const allowed = namespace === "modelscope" ? ["modelscope"] : ["huggingface", "hf-mirror"];
    if (!allowed.includes(source)) {
      throw new HubError("invalid_request", `The source "${String(source).slice(0, 40)}" cannot serve this repository.`, { status: 400, details: { field: "source", allowed } });
    }
    if (source === "hf-mirror" && (job.transfer.options.tokenRef || job.transfer.options.credentialMode === "temp-token")) {
      throw new HubError("token_not_allowed_on_mirror", "A mirror never receives a Hugging Face token.", { status: 422 });
    }
    const set = { source, endpoint: sourceEndpoint(source) };
    if (source === "hf-mirror") set.credentialMode = "none";
    if (source === "huggingface" && job.transfer.options.credentialMode === "none") set.credentialMode = "cached-login";
    job.transfer.options = { ...job.transfer.options, ...set };
    job.transfer.cli = source === "modelscope" ? "modelscope" : "hf";
    job.transfer.optionsHistory.push({ at: nowIso(), reason: "user/source", set });
  }

  /**
   * resume(id, { refreshTransferOptions, source, credential, sourceEndpoint })
   * → job. The job re-enters the queue at the head of its priority band. A
   * waiting/auth job needs a credential (03 §12). `credential` is what the
   * route made of credential.hfToken: { tokenRef, remember }.
   */
  async function resume(id, input = {}) {
    const job = mustFind(id);
    if (TERMINAL_STATES.includes(job.state)) throw invalidState(job, "resumed");
    if (IN_PROCESS_STATES.includes(job.state)) return publicJob(job);
    const sourceEndpoint = typeof input.sourceEndpoint === "function" ? input.sourceEndpoint : () => job.transfer.options.endpoint || null;
    applyCredential(job, input.credential);
    applySource(job, input.source, sourceEndpoint);
    if (input.refreshTransferOptions === true) {
      const set = {};
      const xet = settingAt(settings(), "transfer.xet", null);
      if (xet && job.transfer.options.source !== "modelscope") set.xet = xet;
      const endpoint = sourceEndpoint(job.transfer.options.source);
      if (endpoint) set.endpoint = endpoint;
      job.transfer.options = { ...job.transfer.options, ...set };
      job.transfer.optionsHistory.push({ at: nowIso(), reason: "user/refresh", set });
    }
    if (tokenMissing(job)) {
      if (job.state !== "waiting" || job.waitReason !== "auth") toAuthWait(job);
      throw new HubError("hf_token_expired", "Enter the Hugging Face token again to resume this download.", {
        status: 409,
        details: { id: job.id, actions: ["enter-token"] },
      });
    }
    clearRetryTimer(job);
    job.pausedBy = null;
    job.autoResume = true;
    job.retry.nextAt = null;
    job.queueOrder = headOrder(job.priority);
    appendLog(job, "Resumed.");
    if (!setState(job, "queued")) {
      persist();
      emitJob(job);
    }
    schedulePump();
    return publicJob(job);
  }

  /** A user retry of a failed (or cancelled) job starts a fresh retry budget. */
  async function retry(id) {
    const job = mustFind(id);
    if (job.state !== "failed" && job.state !== "cancelled") throw invalidState(job, "retried");
    job.retry = { ...(job.retry || {}), count: 0, nextAt: null, badFiles: [] };
    job.error = null;
    job.pausedBy = null;
    job.autoResume = true;
    job.queueOrder = headOrder(job.priority);
    appendLog(job, "Retry requested.");
    setState(job, "queued");
    schedulePump();
    return publicJob(job);
  }

  /**
   * cancel(id, { deletePartial, confirm }) → { job, reclaimedBytes }. Files
   * are kept by default; deletePartial needs confirm === outputName and is
   * refused (409 path_busy) while another job, a migration lock or a running
   * container uses the folder.
   */
  async function cancel(id, { deletePartial = false, confirm } = {}) {
    const job = mustFind(id);
    if (job.state === "ready") throw invalidState(job, "cancelled");
    if (deletePartial === true) {
      if (confirm !== job.target.outputName) {
        throw new HubError("confirm_required", "Type the folder name to delete the partial download.", { status: 400, details: { field: "confirm", expected: "outputName" } });
      }
      await assertDeletable(job, { beforeStop: true });
    }
    clearRetryTimer(job);
    if (runs.has(job.id)) await stopRun(job, "cancel");
    job.autoResume = false;
    job.pausedBy = null;
    if (job.state !== "cancelled") {
      appendLog(job, "Cancelled.");
      setState(job, "cancelled");
    }
    releaseToken(job);
    let reclaimedBytes = 0;
    if (deletePartial === true) {
      await assertDeletable(job, { beforeStop: false });
      reclaimedBytes = await deleteTarget(job);
      job.result = { ...(job.result || {}), deletedPartial: true, reclaimedBytes };
      appendLog(job, `Partial download deleted (${reclaimedBytes} bytes).`);
      persist();
      emitJob(job);
    }
    compact();
    schedulePump();
    return { job: publicJob(job), reclaimedBytes };
  }

  async function assertDeletable(job, { beforeStop }) {
    const localDir = job.target.localDir;
    const other = activeOnDir(localDir, job.id);
    if (other) throw pathBusy(job, `download ${other.id}`);
    if (beforeStop && getBusyPaths) {
      let busy = [];
      try {
        busy = await getBusyPaths();
      } catch (error) {
        throw new HubError("path_busy", "The folder could not be checked for running containers; nothing was deleted.", { status: 409, details: { reason: String(error?.message || error).slice(0, 200) } });
      }
      const hit = (Array.isArray(busy) ? busy : []).find((item) => item && item.jobId !== job.id && item.path && overlapsPath(item.path, localDir));
      if (hit) throw pathBusy(job, hit.label || "a running task");
    }
    if (!beforeStop && modelStorage && typeof modelStorage.assertUnlocked === "function") {
      try {
        modelStorage.assertUnlocked([localDir]);
      } catch {
        throw pathBusy(job, "a storage operation");
      }
    }
  }

  function pathBusy(job, label) {
    return new HubError("path_busy", "The folder is in use; nothing was deleted.", { status: 409, details: { id: job.id, usedBy: String(label).slice(0, 200) } });
  }

  async function sizeOf(target) {
    let total = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) total += await sizeOf(full);
      else if (entry.isFile()) total += await fsp.stat(full).then((stat) => stat.size).catch(() => 0);
    }
    return total;
  }

  async function deleteTarget(job) {
    let resolved = job.target.localDir;
    if (modelStorage && typeof modelStorage.resolvePath === "function") {
      try {
        resolved = modelStorage.resolvePath(job.target.localDir, { follow: false, allowRoot: false });
      } catch (error) {
        throw new HubError("invalid_target", String(error?.message || "The folder is outside the model library."), { status: Number(error?.status) || 400 });
      }
    }
    const bytes = await sizeOf(resolved);
    await fsp.rm(resolved, { recursive: true, force: true });
    return bytes;
  }

  async function setPriority(id, priority) {
    const job = mustFind(id);
    if (!PRIORITIES.includes(priority)) {
      throw new HubError("invalid_request", `priority must be one of ${PRIORITIES.join(", ")}.`, { status: 400, details: { field: "priority" } });
    }
    if (TERMINAL_STATES.includes(job.state)) throw invalidState(job, "reprioritised");
    if (job.priority !== priority) {
      job.priority = priority;
      job.updatedAt = nowIso();
      persist();
      emitJob(job);
      schedulePump();
    }
    return publicJob(job);
  }

  /** Rewrites queueOrder of queued and waiting jobs in the given order. */
  async function reorder(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string")) {
      throw new HubError("invalid_request", "ids must be a non-empty list of download ids.", { status: 400, details: { field: "ids" } });
    }
    const picked = [];
    for (const id of ids) {
      const job = mustFind(id);
      if (job.state !== "queued" && job.state !== "waiting") throw invalidState(job, "reordered");
      if (!picked.includes(job)) picked.push(job);
    }
    const orders = picked.map((job) => Number(job.queueOrder) || 0).sort((a, b) => a - b);
    picked.forEach((job, index) => {
      job.queueOrder = orders[index];
      job.updatedAt = nowIso();
    });
    persist();
    publish("downloads", { kind: "reorder", jobs: picked.map(publicJob), aggregate: aggregate() });
    schedulePump();
    return picked.map(publicJob);
  }

  /** High priority, the head of the queue and one bypass of the idle gate; force may exceed maxConcurrent by one. */
  async function startNow(id, { force = false } = {}) {
    const job = mustFind(id);
    if (IN_PROCESS_STATES.includes(job.state)) return publicJob(job);
    if (TERMINAL_STATES.includes(job.state)) throw invalidState(job, "started");
    if (tokenMissing(job)) {
      toAuthWait(job);
      throw new HubError("hf_token_expired", "Enter the Hugging Face token again to resume this download.", { status: 409, details: { id: job.id, actions: ["enter-token"] } });
    }
    clearRetryTimer(job);
    job.priority = "high";
    job.queueOrder = headOrder("high");
    job.bypassIdleOnce = true;
    job.forceSlot = force === true;
    job.pausedBy = null;
    job.autoResume = true;
    job.retry.nextAt = null;
    if (!setState(job, "queued")) {
      persist();
      emitJob(job);
    }
    schedulePump();
    return publicJob(job);
  }

  async function pauseAll() {
    const targets = jobs.filter((job) => [...PENDING_STATES, ...IN_PROCESS_STATES, "interrupted"].includes(job.state));
    for (const job of targets) await pause(job.id);
    return { affected: targets.length };
  }

  async function resumeAll() {
    const targets = jobs.filter((job) => job.state === "paused" || job.state === "interrupted").sort(compareQueue);
    let affected = 0;
    for (const job of targets) {
      try {
        await resume(job.id);
        affected += 1;
      } catch {
        // An auth wait stays waiting; it was notified.
      }
    }
    return { affected };
  }

  /** DELETE: a terminal record leaves downloads.json for the history. */
  async function remove(id) {
    const job = mustFind(id);
    if (!TERMINAL_STATES.includes(job.state)) throw invalidState(job, "removed");
    jobs = jobs.filter((item) => item !== job);
    releaseToken(job);
    await store.appendHistory([compactRecord(job)]).catch((error) => warn(`model hub: appending the download history failed: ${error?.message || error}`));
    persist();
    emitRemoved([job.id]);
    return { ok: true };
  }

  // --- status -----------------------------------------------------------------

  function counts() {
    const result = { active: 0, queued: 0, waiting: 0, speedBps: 0 };
    for (const job of jobs) {
      if (IN_PROCESS_STATES.includes(job.state)) {
        result.active += 1;
        result.speedBps += Number(job.progress?.speedEmaBps ?? job.progress?.speedBps) || 0;
      } else if (job.state === "queued" || job.state === "retrying") result.queued += 1;
      else if (job.state === "waiting") result.waiting += 1;
    }
    return result;
  }

  /** 06 OPS-13: active transfers and verifications of the queue. */
  function busy() {
    return {
      downloads: jobs.filter((job) => TRANSFER_STATES.includes(job.state)).length,
      verifying: jobs.filter((job) => job.state === "verifying").length,
    };
  }

  /** Target folders of jobs that may write them (the busy-path probe reads the same from downloads.json). */
  function busyPaths() {
    return jobs.filter((job) => !TERMINAL_STATES.includes(job.state) && job.state !== "paused" && job.target?.localDir)
      .map((job) => ({ path: job.target.localDir, label: `download ${job.id}`, jobId: job.id }));
  }

  return {
    load,
    start,
    stop,
    enqueue,
    list,
    get,
    logs,
    history,
    resumeCheck,
    pause,
    resume,
    retry,
    cancel,
    setPriority,
    reorder,
    startNow,
    pauseAll,
    resumeAll,
    remove,
    aggregate,
    counts,
    busy,
    busyPaths,
    document,
    publicJob,
    /** Resolves once a scheduling pass in flight has settled (tests). */
    async idle() {
      while (pumping) await pumping;
    },
    get size() {
      return jobs.length;
    },
  };
}

module.exports = {
  ACTIVE_STATES: IN_PROCESS_STATES,
  IN_PROCESS_STATES,
  JOB_ID_RE,
  JOB_STATES,
  PRIORITIES,
  TERMINAL_STATES,
  TRANSFER_STATES,
  WAIT_REASONS,
  createDownloadQueue,
  failureFromError,
  newJobId,
};
