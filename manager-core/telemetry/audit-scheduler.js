"use strict";

// Scheduled audit exports (docs/overhaul/04 §16.3), run by the entry.
//
// audit.schedule = {enabled, incrementalEveryMinutes, fullAtLocal}. The
// scheduler ticks every minute and decides what is due:
//
//   - an incremental export every incrementalEveryMinutes;
//   - a full export at the first fullAtLocal slot after needsRebaseline
//     became true. needsRebaseline is audit-chain.js's rule, which is
//     P0-OBS-6's AI_AUDIT_REBASELINE_DAYS trigger, so the full cadence has no
//     setting of its own.
//
// Incrementals pass full:false to the export, so the store's own automatic
// rebaseline never turns an hourly run into a full one at a random hour.
//
// It skips with the event audit.export.skipped (reason openwebui_missing)
// when the OpenWebUI container does not exist, and never starts Docker or a
// container. Each run records audit.export or audit.export.failed, updates
// collector_state.audit, prunes with the retention plan after a success
// (audit-store.js does it under the export lock; the removed exports leave the
// index) and indexes the new export (§16.5). Manual exports from the audit API
// go through runExport() as well, so one process never runs two exports.
//
// The clock is injected (now), and so are the timer functions, which is how
// the tests drive a day of minutes without waiting.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { AUDIT_RETENTION_DEFAULTS, groupAuditChains, planAuditRetention } = require("./audit-chain");
const { redactSecrets } = require("../secret-redactor");

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TICK_MS = MINUTE_MS;
const STATE_NAME = "audit";
const SCHEDULER_ACTOR = "system:audit-scheduler";
const MISSING_REASON = "openwebui_missing";
const BUSY_REASON = "export_in_progress";
const RETRY_AFTER_FAILURE_MS = 15 * MINUTE_MS;
const RETRY_AFTER_BUSY_MS = 5 * MINUTE_MS;
// A repeated skip for the same reason is recorded once a day, not every run.
const SKIP_REPEAT_MS = DAY_MS;
const ERROR_TEXT_LIMIT = 300;
const DEFAULT_SCHEDULE = Object.freeze({ enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSchedule(value) {
  const input = isPlainObject(value) ? value : {};
  const every = Math.floor(Number(input.incrementalEveryMinutes));
  const slot = typeof input.fullAtLocal === "string" ? input.fullAtLocal.trim() : "";
  return {
    enabled: input.enabled !== false,
    incrementalEveryMinutes: Number.isFinite(every) ? Math.min(1440, Math.max(15, every)) : DEFAULT_SCHEDULE.incrementalEveryMinutes,
    fullAtLocal: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot) ? slot : DEFAULT_SCHEDULE.fullAtLocal,
  };
}

function retentionPolicy(value) {
  const input = isPlainObject(value) ? value : {};
  return {
    maxExports: input.maxExports,
    maxAgeDays: input.maxAgeDays,
    rebaselineDays: input.rebaselineDays,
    maxChains: input.maxChains,
  };
}

function slotParts(text) {
  const [hours, minutes] = text.split(":").map(Number);
  return { hours, minutes };
}

// The newest fullAtLocal slot at or before `ms`, in the host's local time.
function latestSlotAtOrBefore(ms, text) {
  const { hours, minutes } = slotParts(text);
  const day = new Date(ms);
  let slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
  if (slot.getTime() > ms) slot = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1, hours, minutes, 0, 0);
  return slot.getTime();
}

// The first slot strictly after `ms`.
function nextSlotAfter(ms, text) {
  const { hours, minutes } = slotParts(text);
  const previous = new Date(latestSlotAtOrBefore(ms, text));
  return new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1, hours, minutes, 0, 0).getTime();
}

function iso(ms) {
  return Number.isFinite(ms) && ms !== null ? new Date(ms).toISOString() : null;
}

function shortError(error) {
  const text = redactSecrets(String(error?.message || error || "unknown error"));
  return text.length > ERROR_TEXT_LIMIT ? text.slice(0, ERROR_TEXT_LIMIT) : text;
}

function freshState() {
  return {
    lastRunAt: null,
    lastOkAt: null,
    lastError: null,
    nextIncrementalAt: null,
    nextFullAt: null,
    lastAttemptAt: null,
    lastFullSlotAt: null,
    lastSkip: null,
    lastRuns: { incremental: null, full: null },
  };
}

function createAuditScheduler(options = {}) {
  const { auditStore, index = null, store = null, config } = options;
  if (!auditStore || typeof auditStore.exportOpenWebuiAudit !== "function" || typeof auditStore.listAuditExports !== "function") {
    throw new TypeError("createAuditScheduler needs an audit store");
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  // The entry's event bus. The scheduler records its events in the telemetry
  // store, which is where the console reads audit.* from; the bus is accepted
  // so a later notification channel needs no signature change.
  const events = options.events || null;
  const containerStatus = typeof options.containerStatus === "function" ? options.containerStatus : null;
  const logger = options.logger || console;
  const setTimer = typeof options.setInterval === "function" ? options.setInterval : setInterval;
  const clearTimer = typeof options.clearInterval === "function" ? options.clearInterval : clearInterval;
  const warn = (message) => {
    try {
      logger.warn?.(redactSecrets(`audit-scheduler: ${message}`));
    } catch {
      // Logging never breaks the scheduler.
    }
  };

  let state = null;
  let primePromise = null;
  let running = false;
  let timer = null;
  // In-memory only: a restart tries again at the next tick.
  let retryIncrementalAt = null;
  let retryFullAt = null;

  async function readConfig() {
    let value = typeof config === "function" ? await config() : config;
    if (!isPlainObject(value)) value = {};
    return {
      schedule: normalizeSchedule(value.schedule),
      retention: retentionPolicy(value.retention),
      logQueryText: value.logQueryText === true,
    };
  }

  async function loadState(t, cfg) {
    let loaded = null;
    try {
      loaded = store ? await store.getState(STATE_NAME) : null;
    } catch (error) {
      warn(`the saved schedule state could not be read (${error?.code || error?.message || "error"}); starting fresh`);
    }
    state = freshState();
    if (isPlainObject(loaded)) {
      for (const key of Object.keys(state)) if (loaded[key] !== undefined) state[key] = loaded[key];
      if (!isPlainObject(state.lastRuns)) state.lastRuns = { incremental: null, full: null };
    }
    // A fresh scheduler waits one interval for its first incremental, and
    // does not catch up a full slot that passed before it ever ran.
    if (!Number.isFinite(state.lastAttemptAt)) state.lastAttemptAt = t;
    if (!Number.isFinite(state.lastFullSlotAt)) state.lastFullSlotAt = latestSlotAtOrBefore(t, cfg.schedule.fullAtLocal);
  }

  // Loads the saved state once, with the clock as of the first call. start()
  // calls it, so the interval counts from the start of the entry.
  function prime() {
    if (!primePromise) {
      primePromise = (async () => {
        const t = now();
        await loadState(t, await readConfig());
      })();
    }
    return primePromise;
  }

  function nextIncrementalMs(cfg) {
    const regular = state.lastAttemptAt + cfg.schedule.incrementalEveryMinutes * MINUTE_MS;
    return retryIncrementalAt === null ? regular : Math.max(retryIncrementalAt, state.lastAttemptAt);
  }

  async function retentionPlan(cfg, t) {
    const exports = await auditStore.listAuditExports();
    return { exports, plan: planAuditRetention(exports, cfg.retention, t) };
  }

  // When the next full export is due: now when needsRebaseline is true and
  // the slot is still pending, otherwise the first fullAtLocal slot after the
  // newest baseline turns older than rebaselineDays. Null when rebaselining
  // is off (rebaselineDays 0) or the schedule is.
  function nextFullMs(cfg, t, loaded) {
    const days = Number(cfg.retention.rebaselineDays ?? AUDIT_RETENTION_DEFAULTS.rebaselineDays);
    if (!(days > 0) || !cfg.schedule.enabled) return null;
    const slotText = cfg.schedule.fullAtLocal;
    if (loaded.plan.needsRebaseline) {
      if (latestSlotAtOrBefore(t, slotText) > state.lastFullSlotAt) return Math.max(t, retryFullAt ?? 0);
      return nextSlotAfter(t, slotText);
    }
    const newestFull = loaded.exports.find((item) => !item.mode || item.mode === "full");
    const createdMs = Date.parse(newestFull?.createdAt || "");
    if (!Number.isFinite(createdMs)) return null;
    return nextSlotAfter(createdMs + days * DAY_MS, slotText);
  }

  async function saveState(t, cfg) {
    if (!state) return;
    state.nextIncrementalAt = cfg.schedule.enabled ? nextIncrementalMs(cfg) : null;
    try {
      state.nextFullAt = nextFullMs(cfg, t, await retentionPlan(cfg, t));
    } catch {
      // The listing is best effort; the old value stays.
    }
    if (!store) return;
    try {
      await store.setState(STATE_NAME, state);
    } catch (error) {
      warn(`the schedule state could not be saved (${error?.code || error?.message || "error"})`);
    }
  }

  async function record(type, severity, title, data) {
    if (!store) return;
    try {
      await store.insertEvents([{ at: now(), type, severity, source: "entry", title, data }]);
    } catch (error) {
      warn(`event ${type} could not be recorded (${error?.code || error?.message || "error"})`);
    }
  }

  async function logAccess(action, outcome, target, detail) {
    if (!store || typeof store.appendAuditAccess !== "function") return;
    try {
      await store.appendAuditAccess({ at: now(), source: "entry", actor: SCHEDULER_ACTOR, action, target, outcome, detail });
    } catch (error) {
      warn(`access log row ${action} could not be written (${error?.code || error?.message || "error"})`);
    }
  }

  async function readManifest(auditDir, fallback) {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(auditDir, "manifest.json"), "utf8"));
      return isPlainObject(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  async function updateIndex(result, removed) {
    if (!index) return;
    if (result.auditDir && result.auditId && typeof index.indexExport === "function") {
      try {
        await index.indexExport(result.auditDir, await readManifest(result.auditDir, { auditId: result.auditId, mode: result.mode }));
      } catch (error) {
        warn(`export ${result.auditId} could not be indexed (${error?.code || error?.message || "error"})`);
      }
    }
    if (typeof index.removeExport !== "function") return;
    for (const item of removed) {
      try {
        await index.removeExport(item.auditId);
      } catch (error) {
        warn(`export ${item.auditId} could not be removed from the index (${error?.code || error?.message || "error"})`);
      }
    }
  }

  async function pruneAfterSuccess(result) {
    if (Array.isArray(result.pruned)) return result.pruned;
    if (typeof auditStore.pruneAuditExports !== "function") return [];
    try {
      const pruned = await auditStore.pruneAuditExports();
      return Array.isArray(pruned?.removed) ? pruned.removed : [];
    } catch (error) {
      warn(`retention could not run (${error?.code || error?.message || "error"})`);
      return [];
    }
  }

  function classify(result) {
    if (result?.skipped) {
      const reason = String(result.reason || "");
      if (reason === BUSY_REASON) return "busy";
      if (result.empty) return "empty";
      if (reason === MISSING_REASON || /container not found/i.test(reason)) return "missing";
      return "skipped";
    }
    return result?.ok ? "ok" : "failed";
  }

  async function execute(mode, trigger, request, cfg, startedAt) {
    const scheduled = trigger === "scheduled";
    let result;
    let status = null;
    if (containerStatus) {
      try {
        status = await containerStatus();
      } catch {
        // Unknown; the export itself checks the container again.
      }
    }
    if (status && status.exists === false) {
      result = { ok: false, skipped: true, reason: MISSING_REASON };
    } else {
      try {
        result = await auditStore.exportOpenWebuiAudit(scheduled ? "scheduled" : "manual", {
          manager: "service-entry",
          requestedBy: scheduled ? "scheduler" : String(request.actor || "owner"),
          note: String(request.note || ""),
          full: mode === "full",
        });
      } catch (error) {
        result = { ok: false, error: shortError(error) };
      }
    }
    const kind = classify(result);
    const resultMode = result?.mode === "full" || result?.mode === "incremental" ? result.mode : mode;
    const outcome = { ok: kind === "ok" || kind === "empty", kind, mode: resultMode, trigger };
    const t = now();
    const durationMs = Math.max(0, t - startedAt);

    if (kind === "busy") {
      retryIncrementalAt = t + RETRY_AFTER_BUSY_MS;
      retryFullAt = t + RETRY_AFTER_BUSY_MS;
      return { ...outcome, skipped: true, reason: BUSY_REASON, retry: true };
    }

    state.lastAttemptAt = t;
    if (kind === "ok" || kind === "empty") {
      retryIncrementalAt = null;
      retryFullAt = null;
      state.lastRunAt = t;
      state.lastOkAt = t;
      state.lastError = null;
      state.lastSkip = null;
      const removed = await pruneAfterSuccess(result);
      Object.assign(outcome, {
        auditId: result.auditId || null,
        chatCount: Number(result.chatCount || 0),
        messageCount: Number(result.messageCount || 0),
        totalChatCount: result.totalChatCount ?? null,
        rebaseline: Boolean(result.rebaseline),
        pruned: removed,
      });
      state.lastRuns[resultMode] = {
        at: t, ok: true, auditId: outcome.auditId, trigger, chatCount: outcome.chatCount, messageCount: outcome.messageCount, empty: kind === "empty",
      };
      if (kind === "ok") {
        await record("audit.export", "info", `Audit export finished (${resultMode}, ${outcome.chatCount} chats)`, {
          auditId: outcome.auditId, mode: resultMode, trigger, chatCount: outcome.chatCount, messageCount: outcome.messageCount, rebaseline: outcome.rebaseline, durationMs,
        });
        if (scheduled) await logAccess("export_scheduled", "ok", outcome.auditId, { mode: resultMode, chatCount: outcome.chatCount, messageCount: outcome.messageCount });
      } else {
        Object.assign(outcome, { skipped: true, empty: true, reason: "no_changes" });
        await record("audit.export.skipped_empty", "info", "Audit export found no new conversations", { mode: resultMode, trigger });
        if (scheduled) await logAccess("export_skipped", "ok", null, { mode: resultMode, reason: "no_changes" });
      }
      if (removed.length) {
        await record("audit.prune", "info", `Audit retention removed ${removed.length} export${removed.length === 1 ? "" : "s"}`, { removed });
        await logAccess("prune", "ok", `${removed.length} exports`, { removed: removed.map((item) => ({ auditId: item.auditId, reason: item.reason })) });
      }
      await updateIndex(result, removed);
    } else if (kind === "failed") {
      const message = shortError(result?.error || result?.message || result?.reason || "export failed");
      retryIncrementalAt = t + Math.min(cfg.schedule.incrementalEveryMinutes * MINUTE_MS, RETRY_AFTER_FAILURE_MS);
      retryFullAt = t + RETRY_AFTER_FAILURE_MS;
      state.lastRunAt = t;
      state.lastError = message;
      state.lastRuns[resultMode] = { at: t, ok: false, trigger, error: message };
      Object.assign(outcome, { error: message, retry: true });
      await record("audit.export.failed", "warning", "Audit export failed", { mode: resultMode, trigger, error: message });
      if (scheduled) await logAccess("export_failed", "error", null, { mode: resultMode, error: message });
    } else {
      // Open WebUI is not there (or the export skipped for another reason).
      // Nothing failed, so there is no failure event and no lastError.
      const reason = kind === "missing" ? MISSING_REASON : String(result.reason || "skipped").slice(0, 120);
      retryIncrementalAt = null;
      retryFullAt = t + cfg.schedule.incrementalEveryMinutes * MINUTE_MS;
      const previous = isPlainObject(state.lastSkip) ? state.lastSkip : null;
      const repeated = previous && previous.reason === reason && t - Number(previous.loggedAt || 0) < SKIP_REPEAT_MS;
      state.lastSkip = repeated ? { reason, at: t, loggedAt: previous.loggedAt } : { reason, at: t, loggedAt: t };
      Object.assign(outcome, { skipped: true, reason, retry: true });
      if (!repeated) {
        await record("audit.export.skipped", "info", "Audit export skipped: Open WebUI container not found", { reason, mode: resultMode, trigger });
        if (scheduled) await logAccess("export_skipped", "ok", null, { mode: resultMode, reason });
      }
    }
    await saveState(t, cfg);
    return outcome;
  }

  // One export now (or the scheduled one). request = {mode, trigger, note,
  // actor}. Resolves with {ok, kind, mode, trigger, ...}; it does not throw.
  async function runExport(request = {}) {
    const mode = request.mode === "full" ? "full" : "incremental";
    const trigger = request.trigger === "manual" ? "manual" : "scheduled";
    if (running) return { ok: false, kind: "busy", mode, trigger, skipped: true, reason: BUSY_REASON, retry: true };
    running = true;
    try {
      await prime();
      const startedAt = now();
      const cfg = await readConfig();
      return await execute(mode, trigger, request, cfg, startedAt);
    } catch (error) {
      warn(`export run failed unexpectedly: ${shortError(error)}`);
      return { ok: false, kind: "failed", mode, trigger, error: shortError(error) };
    } finally {
      running = false;
    }
  }

  // One scheduler step. start() calls it every minute; tests call it directly
  // with a moving clock.
  async function tick() {
    if (running) return { ran: false, reason: "busy" };
    await prime();
    const t = now();
    const cfg = await readConfig();
    if (!cfg.schedule.enabled) return { ran: false, reason: "disabled" };

    const slot = latestSlotAtOrBefore(t, cfg.schedule.fullAtLocal);
    if (slot > state.lastFullSlotAt && (retryFullAt === null || t >= retryFullAt)) {
      const { plan } = await retentionPlan(cfg, t);
      if (plan.needsRebaseline) {
        const outcome = await runExport({ mode: "full", trigger: "scheduled" });
        // A failure, a missing container or a busy lock leaves the slot
        // pending; the retry time keeps it from running every minute.
        if (!outcome.retry) {
          state.lastFullSlotAt = slot;
          await saveState(now(), cfg);
        }
        return { ran: true, mode: "full", outcome };
      }
      state.lastFullSlotAt = slot;
      await saveState(t, cfg);
    }

    if (t >= nextIncrementalMs(cfg)) {
      const outcome = await runExport({ mode: "incremental", trigger: "scheduled" });
      return { ran: true, mode: "incremental", outcome };
    }
    return { ran: false, reason: "not_due" };
  }

  function start() {
    if (timer) return;
    prime().catch((error) => warn(`the schedule state could not be loaded: ${shortError(error)}`));
    timer = setTimer(() => {
      tick().catch((error) => warn(`tick failed: ${shortError(error)}`));
    }, TICK_MS);
    timer?.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  // The status block of GET /api/audit/status.
  async function describe() {
    await prime();
    const t = now();
    const cfg = await readConfig();
    let nextFullAt = state.nextFullAt;
    let needsRebaseline = null;
    try {
      const loaded = await retentionPlan(cfg, t);
      needsRebaseline = loaded.plan.needsRebaseline;
      nextFullAt = nextFullMs(cfg, t, loaded);
    } catch {
      // The saved value stands.
    }
    return {
      enabled: cfg.schedule.enabled,
      running,
      incrementalEveryMinutes: cfg.schedule.incrementalEveryMinutes,
      fullAtLocal: cfg.schedule.fullAtLocal,
      needsRebaseline,
      lastRunAt: iso(state.lastRunAt),
      lastOkAt: iso(state.lastOkAt),
      lastError: state.lastError,
      nextIncrementalAt: cfg.schedule.enabled ? iso(nextIncrementalMs(cfg)) : null,
      nextFullAt: iso(nextFullAt),
      lastSkip: state.lastSkip ? { reason: state.lastSkip.reason, at: iso(state.lastSkip.at) } : null,
      lastRuns: {
        incremental: state.lastRuns.incremental ? { ...state.lastRuns.incremental, at: iso(state.lastRuns.incremental.at) } : null,
        full: state.lastRuns.full ? { ...state.lastRuns.full, at: iso(state.lastRuns.full.at) } : null,
      },
    };
  }

  // Chains, the retention policy and its plan, for the same block.
  async function retention() {
    const cfg = await readConfig();
    const { exports, plan } = await retentionPlan(cfg, now());
    return {
      policy: { ...cfg.retention },
      chains: groupAuditChains(exports),
      plan: { remove: plan.remove, warnings: plan.warnings, needsRebaseline: plan.needsRebaseline },
      exports,
    };
  }

  return {
    describe,
    events,
    prime,
    retention,
    runExport,
    start,
    stop,
    tick,
    get running() {
      return running;
    },
    get timer() {
      return Boolean(timer);
    },
  };
}

module.exports = {
  DEFAULT_SCHEDULE,
  SCHEDULER_ACTOR,
  createAuditScheduler,
  latestSlotAtOrBefore,
  nextSlotAfter,
  normalizeSchedule,
};
