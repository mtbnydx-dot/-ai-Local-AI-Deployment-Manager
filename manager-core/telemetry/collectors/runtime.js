"use strict";

// RuntimeCollector (docs/overhaul/04-telemetry.md §7.2). Runs in the entry.
//
// Every intervalMs (10 s) it asks each ready or sleeping fleet instance for
// 01's metrics route (GET /api/instances/:id/metrics, §7.1), reads the `raw`
// part, differences it against the previous snapshot of the same
// (fleetId, model) and writes one runtime_samples row through
// store.insertRuntimeSamples. This module never parses Prometheus text: the
// route's `raw` is 01's mapPrometheus output (engines/metrics.js), in
// camelCase canonical keys.
//
// - Time alignment uses the manager's `scrapedAt`, not the entry's clock. A
//   scrapedAt equal to the previous one (the route served the same snapshot)
//   is skipped. `at` of the row is that scrapedAt.
// - runtime_key = <the route's runtimeKey, else launchId/runtimeId/instanceId>
//   + ":" + processStartSeconds. A changed key, a counter that went down or a
//   scrapedAt that went backwards writes a `reset=1` row with NULL deltas,
//   rates and percentiles and takes the new snapshot as the baseline. The
//   very first snapshot of a series is only a baseline (no row).
// - Optional keys (specDraft/Accepted, requestsByFinishReasonTotal, gauges,
//   histograms) that the engine does not expose leave their columns NULL.
// - Percentiles: deltaCumulative(prev, cur) + quantile() per histogram
//   (latency_source = engine_histogram, engine histograms are in seconds and
//   the percentile columns in ms, the stored `hist` keeps the engine's unit
//   and says so). An engine with no latency histograms (llama.cpp) takes TTFT
//   and e2e from gateway rows through `requestLatency` (latency_source =
//   gateway, fixed GATEWAY_MS_BUCKETS, ms), or 'none' without that source.
// - Idle (no requests, nothing running or waiting) rows have rates of exactly
//   0 and NULL percentiles, and are never carried forward.
// - Three failed scrapes in a row while the instance is ready record
//   runtime.scrape_failed once per streak.
// - A manager that answers 404 for the route (partial deploy) is read from
//   /api/stats at most every 30 s instead: counter deltas, latency_source
//   'none', and the telemetry.degraded event once per manager. The route is
//   probed again every minute.
// - Store writes never hold up sampling: a batch the store cannot take for
//   now goes back to a bounded queue.

const { GATEWAY_MS_BUCKETS, deltaCumulative, newHist, observe, quantile } = require("../histogram");
const { redactSecrets } = require("../../secret-redactor");

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 3_600_000;
const SCRAPE_TIMEOUT_MS = 3000;
const MAX_PARALLEL = 8;
const FAILURES_BEFORE_EVENT = 3;
const STATS_INTERVAL_MS = 30_000;
const ROUTE_PROBE_MS = 60_000;
const MAX_PENDING_ROWS = 2000;
const STOP_FLUSH_MS = 2000;
const READY_STATES = new Set(["ready", "sleeping"]);
// Error codes the route and the transport can report, as the column holds them.
const SCRAPE_ERROR_CODES = new Set(["timeout", "unsupported_endpoint", "parse_error", "unreachable"]);

// Histogram kind → [raw histogram key, [[column, quantile], …]].
const LATENCY_COLUMNS = Object.freeze({
  ttft: Object.freeze(["ttftSeconds", [["ttftP50Ms", 0.5], ["ttftP95Ms", 0.95], ["ttftP99Ms", 0.99]]]),
  e2e: Object.freeze(["e2eSeconds", [["e2eP50Ms", 0.5], ["e2eP95Ms", 0.95]]]),
  itl: Object.freeze(["itlSeconds", [["itlP50Ms", 0.5], ["itlP95Ms", 0.95]]]),
  tpot: Object.freeze(["tpotSeconds", [["tpotP50Ms", 0.5]]]),
  queue: Object.freeze(["queueSeconds", [["queueP95Ms", 0.95]]]),
});
const COUNTER_FIELDS = Object.freeze(["prompt", "output", "cached", "requests", "specDraft", "specAccepted", "errors", "aborts", "length"]);
const PERCENTILE_COLUMNS = Object.freeze(Object.values(LATENCY_COLUMNS).flatMap(([, columns]) => columns.map(([column]) => column)));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function round3(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function ratio(numerator, denominator) {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
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

function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 0, code: "manager_timeout" }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- snapshots

// Counter map entries are numbers or null. The finish-reason split is an
// object of per-reason totals; a reason missing from the split of an engine
// that exposes one counts as 0 (the series appears with the first request).
function finishReasonTotals(counters) {
  const split = counters.requestsByFinishReasonTotal ?? counters.requestsByFinishReason;
  if (!isPlainObject(split)) return null;
  const read = (reason) => finite(split[reason]) ?? 0;
  return { errors: read("error"), aborts: read("abort"), length: read("length") };
}

// One model of the route's `raw` → the collector's snapshot.
function snapshotFromRaw(modelEntry, scrapedAtMs, runtimeKey) {
  const counters = isPlainObject(modelEntry?.counters) ? modelEntry.counters : {};
  const gauges = isPlainObject(modelEntry?.gauges) ? modelEntry.gauges : {};
  const histograms = isPlainObject(modelEntry?.histograms) ? modelEntry.histograms : {};
  const reasons = finishReasonTotals(counters);
  return {
    atMs: scrapedAtMs,
    runtimeKey,
    counters: {
      prompt: finite(counters.promptTokensTotal),
      output: finite(counters.generationTokensTotal),
      cached: finite(counters.cachedPromptTokensTotal),
      requests: finite(counters.requestsTotal),
      specDraft: finite(counters.specDraftTokensTotal),
      specAccepted: finite(counters.specAcceptedTokensTotal),
      errors: reasons ? reasons.errors : null,
      aborts: reasons ? reasons.aborts : null,
      length: reasons ? reasons.length : null,
    },
    gauges: {
      running: finite(gauges.requestsRunning),
      waiting: finite(gauges.requestsWaiting),
      kvUsage: finite(gauges.kvUsageRatio),
      kvCapacityTokens: finite(gauges.kvCapacityTokens),
    },
    hists: Object.fromEntries(Object.entries(LATENCY_COLUMNS).map(([kind, [key]]) => [kind, isPlainObject(histograms[key]) ? histograms[key] : null])),
  };
}

// One /api/stats model (fallback) → the same snapshot, without histograms.
function snapshotFromStats(statsModel, atMs, runtimeKey) {
  const tokens = isPlainObject(statsModel?.tokens) ? statsModel.tokens : {};
  const requests = isPlainObject(statsModel?.requests) ? statsModel.requests : {};
  return {
    atMs,
    runtimeKey,
    counters: {
      prompt: finite(tokens.prompt),
      output: finite(tokens.generation),
      cached: finite(tokens.cachedPrompt),
      requests: finite(requests.total),
      specDraft: null,
      specAccepted: null,
      errors: finite(requests.error),
      aborts: finite(requests.aborted),
      length: null,
    },
    gauges: { running: finite(requests.running), waiting: finite(requests.waiting), kvUsage: null, kvCapacityTokens: null },
    hists: { ttft: null, e2e: null, itl: null, tpot: null, queue: null },
  };
}

function hasEngineLatency(snapshot) {
  return Object.values(snapshot.hists).some(Boolean);
}

// True when the baseline cannot be differenced with the new snapshot.
function isReset(prev, cur) {
  if (prev.runtimeKey !== cur.runtimeKey) return true;
  if (!(cur.atMs > prev.atMs)) return true;
  for (const field of COUNTER_FIELDS) {
    const before = prev.counters[field];
    const after = cur.counters[field];
    if (before !== null && after !== null && after < before) return true;
  }
  return false;
}

function delta(before, after) {
  return before !== null && after !== null ? after - before : null;
}

function nullRow(base) {
  const row = {
    ...base,
    intervalMs: null,
    scrapeOk: 1,
    errorCode: null,
    reset: 0,
    idle: 0,
    dPromptTokens: null,
    dCachedTokens: null,
    dOutputTokens: null,
    dRequests: null,
    dErrors: null,
    dAborts: null,
    dFinishLength: null,
    promptTps: null,
    outputTps: null,
    rpm: null,
    running: null,
    waiting: null,
    kvUsage: null,
    kvCapacityTokens: null,
    prefixHitRate: null,
    dSpecDraftTokens: null,
    dSpecAcceptedTokens: null,
    specAcceptRate: null,
    latencySource: null,
    hist: null,
  };
  for (const column of PERCENTILE_COLUMNS) row[column] = null;
  return row;
}

function gaugesInto(row, snapshot) {
  row.running = snapshot.gauges.running;
  row.waiting = snapshot.gauges.waiting;
  row.kvUsage = snapshot.gauges.kvUsage;
  row.kvCapacityTokens = snapshot.gauges.kvCapacityTokens;
}

// Percentile columns and the stored interval histograms from the engine's own
// cumulative histograms. Kinds without a usable baseline stay NULL.
function engineLatency(row, prev, cur) {
  const hist = {};
  for (const [kind, [, columns]] of Object.entries(LATENCY_COLUMNS)) {
    const interval = deltaCumulative(prev.hists[kind], cur.hists[kind]);
    if (!interval || !(interval.count > 0)) continue;
    for (const [column, level] of columns) {
      const value = quantile(interval, level);
      row[column] = value === null ? null : round3(value * 1000);
    }
    hist[kind] = { le: interval.le, d: interval.counts, sum: interval.sum, count: interval.count, unit: "s" };
  }
  row.hist = Object.keys(hist).length ? hist : null;
}

// ---------------------------------------------------------------- gateway rows

/**
 * An in-memory window over finalised gateway rows (the recorder's `onRow`),
 * for engines without latency histograms. query({fleetId, model, fromMs,
 * toMs}) → {ttft, e2e}: cumulative histograms over GATEWAY_MS_BUCKETS of the
 * rows that ended in (fromMs, toMs]; TTFT of rows that have one, e2e (the
 * request duration) of completed rows. `model` narrows to modelResolved when
 * it is not empty.
 */
function createGatewayLatencyWindow(options = {}) {
  const retainMs = clampInt(options.retainMs, 10_000, 3_600_000, 300_000);
  const maxRows = clampInt(options.maxRows, 100, 1_000_000, 50_000);
  const now = typeof options.now === "function" ? options.now : Date.now;
  let rows = [];

  function prune() {
    const cutoff = now() - retainMs;
    if (rows.length > maxRows) rows = rows.slice(rows.length - maxRows);
    let drop = 0;
    while (drop < rows.length && rows[drop].endedAt < cutoff) drop += 1;
    if (drop) rows = rows.slice(drop);
  }

  return {
    add(row) {
      if (!row || !row.fleetId) return;
      const endedAt = finite(row.endedAt) ?? finite(row.receivedAt);
      if (endedAt === null) return;
      rows.push({
        fleetId: String(row.fleetId),
        model: String(row.modelResolved || row.modelRequested || ""),
        endedAt,
        ttftMs: finite(row.ttftMs),
        durationMs: row.terminalState === "completed" ? finite(row.durationMs) : null,
      });
      if (rows.length > maxRows) prune();
    },
    query({ fleetId, model = "", fromMs, toMs } = {}) {
      prune();
      const ttft = newHist(GATEWAY_MS_BUCKETS);
      const e2e = newHist(GATEWAY_MS_BUCKETS);
      for (const row of rows) {
        if (row.fleetId !== fleetId || !(row.endedAt > fromMs && row.endedAt <= toMs)) continue;
        if (model && row.model && row.model !== model) continue;
        observe(ttft, row.ttftMs);
        observe(e2e, row.durationMs);
      }
      return { ttft: ttft.count ? ttft : null, e2e: e2e.count ? e2e : null };
    },
    size: () => rows.length,
  };
}

// ---------------------------------------------------------------- collector

/**
 * options:
 * - store: TelemetryStore (insertRuntimeSamples, insertEvents).
 * - listFleetInstances(): the entry's cached instances, [{fleetId, managerId,
 *   instanceId, engineId, runtimeId, launchId, lifecycleState, external,
 *   model, models}] (sync or async).
 * - fetchInstanceMetrics(instance, {timeoutMs}) → {ok, status, data, code?}
 *   (the entry's manager client shape) for 01's route.
 * - fetchManagerStats(managerId, {timeoutMs}) → the same shape for /api/stats
 *   (the fallback; without it a manager lacking the route gets failure rows).
 * - requestLatency({fleetId, model, fromMs, toMs}) → {ttft, e2e} | null.
 * - intervalMs (10 s), now, timers, logger, events (accepted for the shared
 *   collector signature, unused), concurrency (8), timeoutMs (3 s).
 */
function createRuntimeCollector(options = {}) {
  const store = options.store || null;
  const listFleetInstances = typeof options.listFleetInstances === "function" ? options.listFleetInstances : async () => [];
  const fetchInstanceMetrics = typeof options.fetchInstanceMetrics === "function" ? options.fetchInstanceMetrics : null;
  const fetchManagerStats = typeof options.fetchManagerStats === "function" ? options.fetchManagerStats : null;
  const requestLatency = typeof options.requestLatency === "function" ? options.requestLatency : null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timers = options.timers && typeof options.timers.setTimeout === "function" ? options.timers : { setTimeout, clearTimeout };
  const log = normalizeLogger(options.logger);
  const intervalMs = clampInt(options.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const timeoutMs = clampInt(options.timeoutMs, 100, 60_000, SCRAPE_TIMEOUT_MS);
  const concurrency = clampInt(options.concurrency, 1, 64, MAX_PARALLEL);
  const statsIntervalMs = clampInt(options.statsIntervalMs, 0, 3_600_000, STATS_INTERVAL_MS);
  const routeProbeMs = clampInt(options.routeProbeMs, 0, 3_600_000, ROUTE_PROBE_MS);
  const stopFlushMs = clampInt(options.stopFlushMs, 0, 60_000, STOP_FLUSH_MS);

  // `${fleetId}\0${model}` → previous snapshot (route series) and
  // `stats:${fleetId}\0${model}` for the /api/stats fallback series.
  const baselines = new Map();
  // fleetId → { scrapedAt, failures, failureStart, eventSent, lastErrorCode, lastOkAt }
  const fleets = new Map();
  // managerId → { since, lastProbeAt, lastStatsAt, eventSent }
  const degraded = new Map();
  const latestRows = new Map();
  let pending = [];
  let timer = null;
  let generation = 0;
  let running = false;
  let stopped = false;
  let inflight = null;
  let lastTickAt = null;
  let lastError = null;
  const counters = { ticks: 0, written: 0, dropped: 0, storeErrors: 0, resets: 0, failures: 0 };

  function clock() {
    const value = Math.floor(Number(now()));
    return Number.isFinite(value) ? value : Date.now();
  }

  // ------------------------------------------------------------ row building

  function identity(instance) {
    return {
      fleetId: String(instance.fleetId),
      managerId: String(instance.managerId || ""),
      engineId: instance.engineId ? String(instance.engineId) : null,
      runtimeId: instance.runtimeId ? String(instance.runtimeId) : null,
      launchId: instance.launchId ? String(instance.launchId) : null,
    };
  }

  async function gatewayHists(fleetId, model, fromMs, toMs) {
    if (!requestLatency) return null;
    try {
      const result = await requestLatency({ fleetId, model, fromMs, toMs });
      return isPlainObject(result) ? result : null;
    } catch {
      return null;
    }
  }

  // Row for one series, or null for a first snapshot (baseline only).
  async function buildRow(base, key, snapshot) {
    const prev = baselines.get(key) || null;
    baselines.set(key, snapshot);
    if (!prev) return null;
    const row = nullRow(base);
    row.at = snapshot.atMs;
    gaugesInto(row, snapshot);
    const gatewayLatency = !hasEngineLatency(snapshot);
    row.latencySource = gatewayLatency ? (requestLatency ? "gateway" : "none") : "engine_histogram";
    if (isReset(prev, snapshot)) {
      row.reset = 1;
      counters.resets += 1;
      return row;
    }
    const interval = snapshot.atMs - prev.atMs;
    const seconds = interval / 1000;
    row.intervalMs = interval;
    const d = {};
    for (const field of COUNTER_FIELDS) d[field] = delta(prev.counters[field], snapshot.counters[field]);
    row.dPromptTokens = d.prompt;
    row.dOutputTokens = d.output;
    row.dCachedTokens = d.cached;
    row.dRequests = d.requests;
    row.dErrors = d.errors;
    row.dAborts = d.aborts;
    row.dFinishLength = d.length;
    row.dSpecDraftTokens = d.specDraft;
    row.dSpecAcceptedTokens = d.specAccepted;
    row.promptTps = d.prompt === null ? null : d.prompt / seconds;
    row.outputTps = d.output === null ? null : d.output / seconds;
    row.rpm = d.requests === null ? null : (d.requests / seconds) * 60;
    row.prefixHitRate = ratio(d.cached, d.prompt);
    row.specAcceptRate = ratio(d.specAccepted, d.specDraft);

    // Requests are counted by the request counter, or by token movement for
    // an engine without one (llama.cpp); unknown activity is not idle.
    const activity = d.requests !== null ? d.requests : d.prompt !== null && d.output !== null ? d.prompt + d.output : null;
    const idle = activity === 0 && (snapshot.gauges.running ?? 0) === 0 && (snapshot.gauges.waiting ?? 0) === 0;
    if (idle) {
      row.idle = 1;
      row.promptTps = 0;
      row.outputTps = 0;
      row.rpm = 0;
      return row;
    }
    if (gatewayLatency) {
      if (requestLatency) await gatewayLatencyInto(row, base.fleetId, key, prev.atMs, snapshot.atMs);
    } else {
      engineLatency(row, prev, snapshot);
    }
    return row;
  }

  async function gatewayLatencyInto(row, fleetId, key, fromMs, toMs) {
    const model = key.slice(key.indexOf("\0") + 1);
    const result = await gatewayHists(fleetId, model, fromMs, toMs);
    if (!result) {
      row.latencySource = "none";
      return;
    }
    const hist = {};
    for (const [kind, columns] of [["ttft", [["ttftP50Ms", 0.5], ["ttftP95Ms", 0.95], ["ttftP99Ms", 0.99]]], ["e2e", [["e2eP50Ms", 0.5], ["e2eP95Ms", 0.95]]]]) {
      const source = result[kind];
      if (!source || !(Number(source.count) > 0)) continue;
      for (const [column, level] of columns) row[column] = round3(quantile(source, level));
      const counts = Array.isArray(source.counts) ? source.counts : source.d;
      hist[kind] = { le: source.le, d: counts, sum: finite(source.sum), count: finite(source.count), unit: "ms" };
    }
    row.hist = Object.keys(hist).length ? hist : null;
  }

  function failureRow(base, model, errorCode, errorAt) {
    const row = nullRow(base);
    row.at = errorAt;
    row.model = model;
    row.scrapeOk = 0;
    row.errorCode = errorCode;
    return row;
  }

  // ------------------------------------------------------------ scraping

  function fleetState(fleetId) {
    let state = fleets.get(fleetId);
    if (!state) {
      state = { scrapedAt: null, failures: 0, failureStart: null, eventSent: false, lastErrorCode: null, lastOkAt: null, lastStatsAt: 0 };
      fleets.set(fleetId, state);
    }
    return state;
  }

  function recordSuccess(fleetId) {
    const state = fleetState(fleetId);
    state.failures = 0;
    state.failureStart = null;
    state.eventSent = false;
    state.lastErrorCode = null;
    state.lastOkAt = clock();
  }

  function recordFailure(instance, errorCode, rows) {
    const state = fleetState(instance.fleetId);
    counters.failures += 1;
    if (state.failures === 0) state.failureStart = clock();
    state.failures += 1;
    state.lastErrorCode = errorCode;
    const base = { ...identity(instance), model: String(instance.model || "") };
    base.runtimeKey = `${instance.launchId || instance.runtimeId || instance.instanceId || ""}:`;
    rows.push(failureRow(base, base.model, errorCode, clock()));
    const lifecycle = String(instance.lifecycleState || "ready");
    if (state.failures >= FAILURES_BEFORE_EVENT && !state.eventSent && lifecycle === "ready") {
      state.eventSent = true;
      writeEvent({
        at: clock(),
        source: "telemetry",
        type: "runtime.scrape_failed",
        severity: "warning",
        title: "Runtime metrics could not be read",
        data: { fleetId: instance.fleetId, managerId: instance.managerId, errorCode, failures: state.failures, i18nKey: "obs.event.runtimeScrapeFailed" },
        dedupeKey: `runtime.scrape_failed:${instance.fleetId}:${state.failureStart}`,
      });
    }
  }

  function writeEvent(event) {
    if (!store || typeof store.insertEvents !== "function") return;
    Promise.resolve(store.insertEvents([event])).catch(() => {});
  }

  // The route is missing (not an unknown-instance answer): the manager has
  // not been upgraded yet.
  function isRouteMissing(result) {
    if (!result || result.status !== 404) return false;
    const code = result.data?.error?.code ?? result.code;
    return code !== "unknown_instance";
  }

  function errorCodeOf(result) {
    if (!result) return "unreachable";
    if (result.status > 0) {
      const status = Number(result.status);
      if (status === 404 || status === 501) return "unsupported_endpoint";
      return `http_${status}`;
    }
    if (result.code === "manager_timeout" || result.code === "timeout") return "timeout";
    return "unreachable";
  }

  async function scrapeRoute(instance) {
    let result;
    try {
      result = await withTimeout(Promise.resolve(fetchInstanceMetrics(instance, { timeoutMs })), timeoutMs + 500);
    } catch (error) {
      result = { ok: false, status: 0, code: error?.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
    return result;
  }

  async function sampleInstance(instance, rows) {
    const manager = degraded.get(instance.managerId);
    if (manager && clock() - manager.lastProbeAt < routeProbeMs) return;
    if (manager) manager.lastProbeAt = clock();
    const result = await scrapeRoute(instance);
    if (isRouteMissing(result)) {
      markDegraded(instance.managerId);
      return;
    }
    if (result && result.ok) degraded.delete(instance.managerId);
    if (!result || !result.ok) {
      const envelopeCode = result?.data?.error?.code;
      recordFailure(instance, SCRAPE_ERROR_CODES.has(envelopeCode) ? envelopeCode : errorCodeOf(result), rows);
      return;
    }
    const payload = result.data;
    if (!isPlainObject(payload)) {
      recordFailure(instance, "parse_error", rows);
      return;
    }
    if (payload.ok === false) {
      const code = String(payload.error?.code || "");
      recordFailure(instance, SCRAPE_ERROR_CODES.has(code) ? code : code ? `http_${result.status}` : "parse_error", rows);
      return;
    }
    if (payload.scrapeOk === false) {
      // No snapshot yet (the sampler has not scraped this instance): nothing
      // to record, and not a failure either.
      if (payload.errorCode === "no_sample") return;
      recordFailure(instance, String(payload.errorCode || "unreachable"), rows);
      return;
    }
    const scrapedAtMs = Date.parse(String(payload.scrapedAt || ""));
    const raw = payload.raw;
    if (!Number.isFinite(scrapedAtMs) || !isPlainObject(raw) || !Array.isArray(raw.models)) {
      recordFailure(instance, "parse_error", rows);
      return;
    }
    recordSuccess(instance.fleetId);
    const state = fleetState(instance.fleetId);
    if (state.scrapedAt === scrapedAtMs) return;
    state.scrapedAt = scrapedAtMs;
    const processStart = finite(raw.processStartSeconds) ?? finite(payload.processStartSeconds);
    const runtimeKey = `${instance.launchId || payload.launchId || instance.runtimeId || payload.runtimeId || payload.runtimeKey || instance.instanceId}:${processStart ?? ""}`;
    const base = {
      ...identity(instance),
      engineId: instance.engineId || payload.engineId || null,
      runtimeId: instance.runtimeId || payload.runtimeId || null,
      launchId: instance.launchId || payload.launchId || null,
      runtimeKey,
    };
    for (const entry of raw.models) {
      const model = String(entry?.model || instance.model || "");
      const key = `${instance.fleetId}\0${model}`;
      const row = await buildRow({ ...base, model }, key, snapshotFromRaw(entry, scrapedAtMs, runtimeKey));
      if (row) rows.push(row);
    }
  }

  // ------------------------------------------------------------ fallback

  function markDegraded(managerId) {
    let entry = degraded.get(managerId);
    if (!entry) {
      entry = { since: clock(), lastProbeAt: clock(), lastStatsAt: 0, eventSent: false };
      degraded.set(managerId, entry);
    } else {
      entry.lastProbeAt = clock();
    }
    if (!entry.eventSent) {
      entry.eventSent = true;
      log("warn", `Telemetry: the ${managerId} manager has no metrics route; runtime samples fall back to /api/stats.`);
      writeEvent({
        at: clock(),
        source: "telemetry",
        type: "telemetry.degraded",
        severity: "warning",
        title: "Runtime metrics fall back to /api/stats",
        data: { collector: "runtime", managerId, reason: "metrics_route_missing", i18nKey: "obs.event.telemetryDegraded" },
        dedupeKey: `telemetry.degraded:runtime:${managerId}:${entry.since}`,
      });
    }
  }

  async function sampleStats(managerId, instances, rows) {
    const entry = degraded.get(managerId);
    if (!entry || !fetchManagerStats || clock() - entry.lastStatsAt < statsIntervalMs) return;
    entry.lastStatsAt = clock();
    let result;
    try {
      result = await withTimeout(Promise.resolve(fetchManagerStats(managerId, { timeoutMs })), timeoutMs + 500);
    } catch {
      result = null;
    }
    const models = result?.ok && Array.isArray(result.data?.models) ? result.data.models : null;
    if (!models) {
      for (const instance of instances) recordFailure(instance, errorCodeOf(result), rows);
      return;
    }
    const at = clock();
    for (const statsModel of models) {
      const name = String(statsModel?.name || "");
      if (!name) continue;
      const instance = instances.find((candidate) => Array.isArray(candidate.models) && candidate.models.includes(name)) || instances[0];
      if (!instance) continue;
      recordSuccess(instance.fleetId);
      const runtimeKey = `${instance.launchId || instance.runtimeId || instance.instanceId}:`;
      const base = { ...identity(instance), runtimeKey, model: name };
      const row = await buildRow(base, `stats:${instance.fleetId}\0${name}`, snapshotFromStats(statsModel, at, runtimeKey));
      if (row) {
        // The ledger is per manager: running/waiting are the model's own.
        row.latencySource = "none";
        row.hist = null;
        rows.push(row);
      }
    }
  }

  // ------------------------------------------------------------ tick

  function eligible(instance) {
    if (!isPlainObject(instance) || !instance.fleetId) return false;
    if (instance.external === true || instance.engineId === "external" || instance.managerId === "external") return false;
    const state = String(instance.lifecycleState || instance.lifecycle?.state || "").toLowerCase();
    return READY_STATES.has(state);
  }

  async function runPool(items, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        try {
          await worker(item);
        } catch (error) {
          lastError = String(error?.message || error);
        }
      }
    });
    await Promise.all(lanes);
  }

  function forgetGoneFleets(all) {
    const present = new Set(all.map((instance) => instance.fleetId));
    for (const key of [...baselines.keys()]) {
      const fleetId = key.replace(/^stats:/, "").split("\0")[0];
      if (!present.has(fleetId)) baselines.delete(key);
    }
    for (const fleetId of [...fleets.keys()]) {
      if (!present.has(fleetId)) {
        fleets.delete(fleetId);
        latestRows.delete(fleetId);
      }
    }
  }

  async function tick() {
    if (!fetchInstanceMetrics) return { rows: 0 };
    counters.ticks += 1;
    lastTickAt = clock();
    let all;
    try {
      const listed = await listFleetInstances();
      all = Array.isArray(listed) ? listed.filter((instance) => isPlainObject(instance) && instance.fleetId) : [];
    } catch (error) {
      lastError = String(error?.message || error);
      return { rows: 0, error: lastError };
    }
    forgetGoneFleets(all);
    const targets = all.filter(eligible);
    const rows = [];
    await runPool(targets, (instance) => sampleInstance(instance, rows));
    const byManager = new Map();
    for (const instance of targets) {
      if (!degraded.has(instance.managerId)) continue;
      if (!byManager.has(instance.managerId)) byManager.set(instance.managerId, []);
      byManager.get(instance.managerId).push(instance);
    }
    for (const [managerId, instances] of byManager) {
      try {
        await sampleStats(managerId, instances, rows);
      } catch (error) {
        lastError = String(error?.message || error);
      }
    }
    for (const row of rows) latestRows.set(row.fleetId, row);
    await write(rows);
    return { rows: rows.length };
  }

  async function write(rows) {
    pending.push(...rows);
    if (pending.length > MAX_PENDING_ROWS) {
      counters.dropped += pending.length - MAX_PENDING_ROWS;
      pending = pending.slice(pending.length - MAX_PENDING_ROWS);
    }
    if (!pending.length || !store || typeof store.insertRuntimeSamples !== "function") return;
    const batch = pending;
    pending = [];
    try {
      const result = await store.insertRuntimeSamples(batch);
      if (result && result.error) {
        counters.storeErrors += 1;
        if (result.retryable) pending = batch.concat(pending);
        else counters.dropped += batch.length;
        return;
      }
      counters.written += Number(result?.accepted) || 0;
    } catch (error) {
      counters.storeErrors += 1;
      lastError = String(error?.message || error);
      if (error?.retryable) pending = batch.concat(pending).slice(-MAX_PENDING_ROWS);
      else counters.dropped += batch.length;
    }
  }

  // ------------------------------------------------------------ lifecycle

  function schedule(run) {
    if (stopped || !running || run !== generation) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (run !== generation) return;
      inflight = tick().catch((error) => {
        lastError = String(error?.message || error);
      }).finally(() => {
        inflight = null;
        schedule(run);
      });
    }, intervalMs);
    timer.unref?.();
  }

  function start() {
    if (running) return;
    running = true;
    stopped = false;
    generation += 1;
    schedule(generation);
  }

  async function stop({ flushMs = stopFlushMs } = {}) {
    stopped = true;
    running = false;
    generation += 1;
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (inflight) {
      let guard = null;
      await Promise.race([inflight, new Promise((resolve) => {
        guard = setTimeout(resolve, Math.max(0, flushMs));
        guard.unref?.();
      })]);
      clearTimeout(guard);
    }
    return { ok: true };
  }

  function status() {
    const fleetStatus = {};
    for (const [fleetId, state] of fleets) {
      fleetStatus[fleetId] = {
        consecutiveFailures: state.failures,
        lastErrorCode: state.lastErrorCode,
        lastScrapedAt: state.scrapedAt,
        lastOkAt: state.lastOkAt,
      };
    }
    return {
      state: degraded.size ? "degraded" : stopped ? "stopped" : running ? "ok" : "idle",
      intervalMs,
      lastTickAt,
      lastError,
      pendingRows: pending.length,
      degradedManagers: [...degraded.keys()],
      fleets: fleetStatus,
      ...counters,
    };
  }

  return {
    start,
    stop,
    tick,
    status,
    latest: (fleetId) => (fleetId === undefined ? [...latestRows.values()] : latestRows.get(fleetId) || null),
  };
}

module.exports = {
  LATENCY_COLUMNS,
  createGatewayLatencyWindow,
  createRuntimeCollector,
};
