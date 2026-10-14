"use strict";

// Manager stats sampler (docs/overhaul/04-telemetry.md §17.1, TEL-1). Runs
// inside vllm-manager and llama-manager.
//
// One timer, independent of any UI, scrapes every running instance once per
// intervalMs (default 10 s from STATS_SAMPLE_INTERVAL_MS, at least 5 s)
// through the manager's own summary function, which feeds P0-OBS-5's
// recent-rate ring exactly as before. Per instance the sampler keeps:
// - the newest summary. GET /api/stats reads it (sampledStatsSummary) instead
//   of scraping, so a UI poll costs no engine scrape and the rates no longer
//   depend on how often anyone polls;
// - the text and time of the newest successful scrape, for lastScrape(). 01's
//   metrics route may serve it while it is at most 5 s old (§7.1, §25 R2);
// - the last 31 cumulative latency histograms (5 min at 10 s). window()
//   turns them into latency.window with histogram.js deltaCumulative and
//   quantile, so the percentiles cover the last five minutes and not the
//   whole process lifetime (F3).
// onPersist runs at most once per persistIntervalMs (60 s); the managers
// write stats-ledger.json and metrics-history.json from it.
//
// applyStatsWindows adds the §17.1 fields to a /api/stats summary:
// speed.window {seconds, source, idle}, speed.averageSource, latency.scope
// and latency.window. Every field P0 ships (speed.windowSeconds,
// speed.outputSource, the recent rates, latency.avg*) stays as it is (C8).
//
// The sampler never parses Prometheus text: the manager parses it with
// prometheus-utils, and latencyHistogramsFromSeries only groups the parsed
// _bucket/_sum/_count series into histograms.

const { deltaCumulative, mergeHist, quantile } = require("../histogram");

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 60_000;
const PERSIST_INTERVAL_MS = 60_000;
// 31 snapshots span 300 s at the default interval.
const SNAPSHOT_LIMIT = 31;
const LATENCY_WINDOW_SECONDS = 300;
const TREND_MAX_POINTS = 288;
const LATENCY_SCOPE = "since_process_start";
const AVERAGE_SOURCE_LIFETIME_GAUGE = "engine_lifetime_gauge";
// How long stop() waits for a pass in flight (a /metrics read times out
// after 4 s).
const STOP_WAIT_MS = 5000;
const SAMPLING_NOTE = "Runtime metrics are being sampled; the first sample arrives within one sampling interval.";
const MAX_ERROR_CHARS = 300;

// Engine latency histograms by window field. The first base name with bucket
// series wins (vLLM, then SGLang). llama.cpp exports none, so its window is
// null.
const LATENCY_HISTOGRAMS = Object.freeze({
  ttftSeconds: Object.freeze(["vllm:time_to_first_token_seconds", "sglang:time_to_first_token_seconds"]),
  e2eSeconds: Object.freeze(["vllm:e2e_request_latency_seconds", "sglang:e2e_request_latency_seconds"]),
  itlSeconds: Object.freeze(["vllm:inter_token_latency_seconds", "sglang:inter_token_latency_seconds"]),
  queueSeconds: Object.freeze(["vllm:request_queue_time_seconds", "sglang:queue_time_seconds"]),
});

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

// STATS_SAMPLE_INTERVAL_MS (telemetry.managerSampleIntervalMs, §20):
// 5000-60000 ms, default 10 000.
function resolveStatsSampleIntervalMs(value, fallback = DEFAULT_INTERVAL_MS) {
  return clampInt(value, MIN_INTERVAL_MS, MAX_INTERVAL_MS, fallback);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorText(error) {
  if (!error) return null;
  const text = typeof error === "string" ? error : error.message || String(error);
  return text.slice(0, MAX_ERROR_CHARS);
}

function timeMs(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundOf(label) {
  const text = String(label ?? "").trim();
  if (!text) return null;
  if (/^\+?inf$/i.test(text)) return Infinity;
  const value = Number(text);
  return Number.isNaN(value) ? null : value;
}

// One cumulative histogram ({le, counts, sum, count}, the histogram.js shape)
// from parsed series: the <baseName>_bucket series summed per `le` across
// their other labels, plus <baseName>_sum and <baseName>_count. Returns null
// when the series hold no bucket of that name.
function histogramFromSeries(series, baseName) {
  const bucketName = `${baseName}_bucket`;
  const sumName = `${baseName}_sum`;
  const countName = `${baseName}_count`;
  const byBound = new Map();
  let sum = 0;
  let count = 0;
  let hasSum = false;
  let hasCount = false;
  for (const metric of Array.isArray(series) ? series : []) {
    if (!metric || typeof metric.name !== "string") continue;
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue;
    if (metric.name === bucketName) {
      const bound = boundOf(metric.labels?.le);
      if (bound === null) continue;
      byBound.set(bound, (byBound.get(bound) || 0) + value);
    } else if (metric.name === sumName) {
      sum += value;
      hasSum = true;
    } else if (metric.name === countName) {
      count += value;
      hasCount = true;
    }
  }
  if (!byBound.size) return null;
  const bounds = Array.from(byBound.keys()).sort((a, b) => a - b);
  const counts = bounds.map((bound) => byBound.get(bound));
  if (bounds[bounds.length - 1] !== Infinity) {
    bounds.push(Infinity);
    counts.push(hasCount ? count : Math.max(0, ...counts));
  }
  return {
    le: bounds.map((bound) => (bound === Infinity ? "+Inf" : bound)),
    counts,
    sum: hasSum ? sum : null,
    count: hasCount ? count : counts[counts.length - 1],
  };
}

// The latency histograms of each model in one scrape:
// { [modelName]: { ttftSeconds?, e2eSeconds?, itlSeconds?, queueSeconds? } }.
// A series belongs to a model through its model_name label; series without
// one count for every model when includeUnlabeled is set (default: exactly
// one model), as buildModelStats scopes them. Models without any histogram
// are left out.
function latencyHistogramsFromSeries(series, modelNames, options = {}) {
  const names = Array.from(new Set((Array.isArray(modelNames) ? modelNames : [])
    .map((name) => String(name ?? ""))
    .filter(Boolean)));
  const includeUnlabeled = options.includeUnlabeled ?? names.length === 1;
  const families = options.families || LATENCY_HISTOGRAMS;
  const list = Array.isArray(series) ? series : [];
  const result = {};
  for (const name of names) {
    const scoped = list.filter((metric) => {
      const label = metric?.labels?.model_name;
      return label === name || (includeUnlabeled && !label);
    });
    const histograms = {};
    for (const [key, baseNames] of Object.entries(families)) {
      for (const baseName of baseNames) {
        const hist = histogramFromSeries(scoped, baseName);
        if (hist) {
          histograms[key] = hist;
          break;
        }
      }
    }
    if (Object.keys(histograms).length) result[name] = histograms;
  }
  return result;
}

function emptyLatencyWindow() {
  return {
    seconds: 0,
    ttftP50Seconds: null,
    ttftP95Seconds: null,
    e2eP95Seconds: null,
    itlP50Seconds: null,
    queueP95Seconds: null,
    requests: 0,
  };
}

function quantileOrNull(hist, level) {
  if (!hist) return null;
  const value = quantile(hist, level);
  return Number.isFinite(value) ? value : null;
}

function windowFromDeltas(deltas, seconds) {
  const requests = deltas.e2eSeconds?.count ?? deltas.ttftSeconds?.count ?? 0;
  return {
    seconds,
    ttftP50Seconds: quantileOrNull(deltas.ttftSeconds, 0.5),
    ttftP95Seconds: quantileOrNull(deltas.ttftSeconds, 0.95),
    e2eP95Seconds: quantileOrNull(deltas.e2eSeconds, 0.95),
    itlP50Seconds: quantileOrNull(deltas.itlSeconds, 0.5),
    queueP95Seconds: quantileOrNull(deltas.queueSeconds, 0.95),
    requests: Math.max(0, Number(requests) || 0),
  };
}

// The per-family increase from a baseline snapshot of one model to the
// current one. A family the baseline did not export yet counts from zero. A
// family that went down (a restart) has no delta; the baseline is unusable
// when no family has one.
function familyDeltas(baseline, current) {
  if (!baseline || !current) return null;
  const deltas = {};
  let usable = false;
  for (const [key, hist] of Object.entries(current)) {
    const delta = baseline[key] ? deltaCumulative(baseline[key], hist) : deltaCumulative(zeroLike(hist), hist);
    if (delta) {
      deltas[key] = delta;
      usable = true;
    }
  }
  return usable ? deltas : null;
}

function zeroLike(hist) {
  const counts = Array.isArray(hist?.counts) ? hist.counts : [];
  return { le: hist?.le || [], counts: counts.map(() => 0), sum: hist?.sum === null ? null : 0, count: 0 };
}

// latency.window for every model of the newest snapshot, from the oldest
// snapshot at most `seconds` older (plus slackMs of timer jitter) whose
// histograms give a delta. `seconds` in the result is the real span, as
// speed.windowSeconds is. totals merges the models' deltas; a model without
// histograms has a null window, and totals is null when no model has one.
function computeLatencyWindow(snapshots, seconds = LATENCY_WINDOW_SECONDS, options = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  const newest = list[list.length - 1];
  const requested = Number(seconds) > 0 ? Number(seconds) : LATENCY_WINDOW_SECONDS;
  if (!newest) return { seconds: requested, models: {}, totals: null };
  const spanMs = requested * 1000 + Math.max(0, Number(options.slackMs) || 0);
  const models = {};
  const merged = {};
  let mergedSeconds = null;
  let mergedRequests = 0;
  let anyWindow = false;
  for (const [name, current] of Object.entries(newest.histograms || {})) {
    let chosen = null;
    for (const snapshot of list.slice(0, -1)) {
      const age = newest.at - snapshot.at;
      if (!(age > 0) || age > spanMs) continue;
      const deltas = familyDeltas(snapshot.histograms?.[name], current);
      if (deltas) {
        chosen = { age, deltas };
        break;
      }
    }
    if (!chosen) {
      models[name] = emptyLatencyWindow();
      anyWindow = true;
      continue;
    }
    const window = windowFromDeltas(chosen.deltas, Math.round(chosen.age / 1000));
    models[name] = window;
    anyWindow = true;
    mergedSeconds = Math.max(mergedSeconds ?? 0, window.seconds);
    mergedRequests += window.requests;
    for (const [key, delta] of Object.entries(chosen.deltas)) {
      if (merged[key] === null) continue;
      try {
        merged[key] = mergeHist(merged[key] || null, delta);
      } catch {
        // Different bucket bounds across models cannot be summed.
        merged[key] = null;
      }
    }
  }
  let totals = null;
  if (anyWindow) {
    const deltas = Object.fromEntries(Object.entries(merged).filter(([, value]) => value));
    totals = mergedSeconds === null
      ? emptyLatencyWindow()
      : { ...windowFromDeltas(deltas, mergedSeconds), requests: mergedRequests };
  }
  return { seconds: requested, models, totals };
}

function instanceIdOf(instance) {
  const id = instance && typeof instance === "object" ? instance.id : instance;
  return id === null || id === undefined ? "" : String(id);
}

function createStatsSampler(options = {}) {
  if (typeof options.scrapeInstance !== "function") {
    throw new TypeError("createStatsSampler requires scrapeInstance.");
  }
  const scrapeInstance = options.scrapeInstance;
  const listInstances = typeof options.listInstances === "function" ? options.listInstances : async () => [];
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onTick = typeof options.onTick === "function" ? options.onTick : null;
  const onPersist = typeof options.onPersist === "function" ? options.onPersist : null;
  const intervalMs = resolveStatsSampleIntervalMs(options.intervalMs);
  const persistIntervalMs = clampInt(options.persistIntervalMs, 0, 24 * 60 * 60 * 1000, PERSIST_INTERVAL_MS);
  const snapshotLimit = clampInt(options.snapshotLimit, 2, 10_000, SNAPSHOT_LIMIT);
  const stopWaitMs = clampInt(options.stopWaitMs, 0, MAX_INTERVAL_MS, STOP_WAIT_MS);
  const timers = options.timers && typeof options.timers.setTimeout === "function"
    ? options.timers
    : { setTimeout, clearTimeout };
  const warn = typeof options.logger?.warn === "function"
    ? (message) => options.logger.warn(message)
    : (message) => console.warn(message);

  // instanceId -> { instance, summary, at, scrapedAt, error, runtimeKey, scrape, snapshots }
  const states = new Map();
  const counters = { ticks: 0, scrapes: 0, scrapeErrors: 0, persists: 0, persistErrors: 0, listErrors: 0 };
  let inflight = null;
  let timer = null;
  let started = false;
  // Bumped by start() and stop(); a timer callback of an earlier run sees a
  // stale generation and does not reschedule.
  let generation = 0;
  let lastTickAt = null;
  let lastPersistAt = null;

  function clock() {
    const value = Math.floor(Number(now()));
    return Number.isFinite(value) ? value : Date.now();
  }

  function record(instanceId) {
    const state = states.get(instanceId);
    if (!state) return null;
    return {
      instanceId,
      instance: state.instance,
      summary: state.summary,
      at: state.at,
      scrapedAt: state.scrapedAt,
      error: state.error,
    };
  }

  async function scrapeOne(instance, instanceId, at) {
    counters.scrapes += 1;
    let result = null;
    let failure = null;
    try {
      result = await scrapeInstance(instance, { at });
    } catch (error) {
      failure = error;
      counters.scrapeErrors += 1;
    }
    const state = states.get(instanceId) || { snapshots: [], scrape: null, runtimeKey: null };
    const runtimeKey = result?.runtimeKey === undefined || result?.runtimeKey === null || result?.runtimeKey === ""
      ? null
      : String(result.runtimeKey);
    // A new runtime (container or process) starts its histograms from zero.
    if (runtimeKey !== null && state.runtimeKey !== null && runtimeKey !== state.runtimeKey) state.snapshots = [];
    if (runtimeKey !== null) state.runtimeKey = runtimeKey;
    const scrapedAtMs = timeMs(result?.scrapedAt, at);
    state.instance = instance;
    state.at = at;
    state.scrapedAt = new Date(scrapedAtMs).toISOString();
    state.summary = result?.summary ?? null;
    state.error = errorText(failure || result?.error || result?.summary?.error);
    if (typeof result?.text === "string") {
      state.scrape = { text: result.text, scrapedAt: state.scrapedAt };
    }
    const histograms = result?.histograms && typeof result.histograms === "object" ? result.histograms : null;
    if (histograms && Object.keys(histograms).length) {
      state.snapshots.push({ at: scrapedAtMs, histograms });
      if (state.snapshots.length > snapshotLimit) state.snapshots = state.snapshots.slice(-snapshotLimit);
    }
    states.set(instanceId, state);
  }

  async function runTick() {
    const at = clock();
    counters.ticks += 1;
    lastTickAt = at;
    let instances;
    try {
      instances = await listInstances();
    } catch (error) {
      // Listing failed (Docker unreachable): keep the last samples, persist
      // nothing, and try again next tick.
      counters.listErrors += 1;
      warn(`stats sampler could not list instances: ${errorText(error)}`);
      return [];
    }
    const unique = new Map();
    for (const instance of Array.isArray(instances) ? instances : []) {
      const instanceId = instanceIdOf(instance);
      if (instanceId && !unique.has(instanceId)) unique.set(instanceId, instance);
    }
    await Promise.all(Array.from(unique, ([instanceId, instance]) => scrapeOne(instance, instanceId, at)));
    for (const instanceId of Array.from(states.keys())) {
      if (!unique.has(instanceId)) states.delete(instanceId);
    }
    const records = Array.from(unique.keys(), record).filter(Boolean);
    if (onTick) {
      try {
        await onTick(records, { at });
      } catch (error) {
        warn(`stats sampler onTick failed: ${errorText(error)}`);
      }
    }
    if (onPersist && (lastPersistAt === null || at - lastPersistAt >= persistIntervalMs)) {
      lastPersistAt = at;
      counters.persists += 1;
      try {
        await onPersist(records, { at });
      } catch (error) {
        counters.persistErrors += 1;
        warn(`stats sampler persist failed: ${errorText(error)}`);
      }
    }
    return records;
  }

  // One sampling pass. Concurrent calls share the pass in flight.
  function tick() {
    if (inflight) return inflight;
    inflight = runTick().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function schedule(runGeneration, delayMs) {
    timer = timers.setTimeout(async () => {
      timer = null;
      if (runGeneration !== generation) return;
      const startedAt = clock();
      await tick().catch((error) => warn(`stats sampler tick failed: ${errorText(error)}`));
      if (runGeneration !== generation) return;
      schedule(runGeneration, Math.max(0, intervalMs - (clock() - startedAt)));
    }, delayMs);
    timer?.unref?.();
  }

  // Samples once now, then every intervalMs, start to start.
  function start() {
    if (started) return;
    started = true;
    generation += 1;
    schedule(generation, 0);
  }

  // Stops the timer. The returned promise settles once a pass still in
  // flight has finished, so a shutdown can wait for its ledger write, but
  // never later than stopWaitMs.
  function stop() {
    started = false;
    generation += 1;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (!inflight) return Promise.resolve();
    return new Promise((resolve) => {
      const guard = setTimeout(resolve, stopWaitMs);
      guard.unref?.();
      inflight.then(() => {}, () => {}).then(() => {
        clearTimeout(guard);
        resolve();
      });
    });
  }

  function latest(instanceId) {
    return record(instanceIdOf(instanceId));
  }

  function window(instanceId, seconds = LATENCY_WINDOW_SECONDS) {
    const state = states.get(instanceIdOf(instanceId));
    if (!state) return null;
    return computeLatencyWindow(state.snapshots, seconds, { slackMs: Math.round(intervalMs / 2) });
  }

  function lastScrape(instanceId) {
    const scrape = states.get(instanceIdOf(instanceId))?.scrape;
    return scrape ? { text: scrape.text, scrapedAt: scrape.scrapedAt } : null;
  }

  function stats() {
    return {
      ...counters,
      started,
      intervalMs,
      persistIntervalMs,
      lastTickAt: lastTickAt === null ? null : new Date(lastTickAt).toISOString(),
      lastPersistAt: lastPersistAt === null ? null : new Date(lastPersistAt).toISOString(),
      instances: Array.from(states.keys()),
    };
  }

  return { start, stop, tick, latest, window, lastScrape, stats };
}

function sameContainer(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id) return String(left.id) === String(right.id);
  return Boolean(left.name) && String(left.name) === String(right.name);
}

// The live summary GET /api/stats shows for one instance, read from the
// sampler without scraping: { summary, latency }. `empty` is the manager's
// summary for a runtime without metrics (core.emptyStatsSummary). A stopped
// container gives `empty`. Until the sampler has scraped the running
// container (just started, or replaced since the last tick) the result is
// `empty` with the sampling note, and after a pass that threw it is `empty`
// with the error. `gpu`, when given, replaces the sample's. latency is
// window(instanceId) of the same container, else null.
function sampledStatsSummary(sampler, instanceId, options = {}) {
  const empty = options.empty ?? null;
  const container = options.container ?? null;
  if (!container?.running) return { summary: empty, latency: null };
  const sample = sampler?.latest?.(instanceId) ?? null;
  if (!sample || !sameContainer(sample.instance?.container, container)) {
    return {
      summary: empty ? { ...empty, note: options.samplingNote || SAMPLING_NOTE } : null,
      latency: null,
    };
  }
  // The last pass failed before the manager built a summary.
  if (!sample.summary) return { summary: empty ? { ...empty, error: sample.error || "sample failed" } : null, latency: null };
  const summary = options.gpu === undefined ? sample.summary : { ...sample.summary, gpu: options.gpu };
  return { summary, latency: sampler.window?.(instanceId) ?? null };
}

function isIdleSpeed(speed, running) {
  if (Number(running || 0) > 0) return false;
  return !(Number(speed?.recentPromptTokensPerSecond || 0) > 0
    || Number(speed?.recentOutputTokensPerSecond || 0) > 0
    || Number(speed?.recentRequestsPerMinute || 0) > 0);
}

function speedWindow(speed, idle) {
  return {
    seconds: Number(speed?.windowSeconds || 0),
    // The same vocabulary as outputSource (C8), never a second one.
    source: speed?.outputSource ?? null,
    idle,
  };
}

function withModelWindows(model, latencyWindow) {
  if (!model || typeof model !== "object") return model;
  const speed = model.speed && typeof model.speed === "object" ? model.speed : {};
  const latency = model.latency && typeof model.latency === "object" ? model.latency : {};
  return {
    ...model,
    speed: {
      ...speed,
      window: speedWindow(speed, isIdleSpeed(speed, model.requests?.running)),
      averageSource: speed.averageSource ?? null,
    },
    latency: {
      ...latency,
      scope: LATENCY_SCOPE,
      window: latencyWindow ?? null,
    },
  };
}

// /api/stats with the §17.1 additions. `latency` is window() of the
// summary's instance (or null): its per-model windows go to
// models[].latency.window and its totals to totals.latency.window. Nothing
// P0 ships is changed or removed.
function applyStatsWindows(summary, latency = null) {
  if (!summary || typeof summary !== "object") return summary;
  const result = { ...summary };
  const models = Array.isArray(summary.models)
    ? summary.models.map((model) => withModelWindows(model, latency?.models?.[model?.name] ?? null))
    : null;
  if (models) {
    result.models = models;
    if (summary.modelsByName && typeof summary.modelsByName === "object") {
      result.modelsByName = Object.fromEntries(models.map((model) => [model?.name, model]));
    }
  }
  if (summary.totals && typeof summary.totals === "object") {
    const totals = summary.totals;
    const speed = totals.speed && typeof totals.speed === "object" ? totals.speed : null;
    const latencyTotals = totals.latency && typeof totals.latency === "object" ? totals.latency : {};
    const idle = (models || []).every((model) => model?.speed?.window?.idle !== false)
      && (!speed || isIdleSpeed(speed, 0));
    result.totals = {
      ...totals,
      ...(speed ? { speed: { ...speed, window: speedWindow(speed, idle) } } : {}),
      latency: { ...latencyTotals, scope: LATENCY_SCOPE, window: latency?.totals ?? null },
    };
  }
  return result;
}

// trends.samples for /api/stats: at most maxPoints (288), oldest first. The
// samples are split into maxPoints runs of consecutive samples and the newest
// of each run is kept, so the last point is always the newest sample.
function downsampleTrendSamples(samples, maxPoints = TREND_MAX_POINTS) {
  const list = Array.isArray(samples) ? samples : [];
  const limit = Math.max(1, Math.floor(Number(maxPoints) || TREND_MAX_POINTS));
  if (list.length <= limit) return list.slice();
  const kept = [];
  let lastBucket = -1;
  for (let index = 0; index < list.length; index += 1) {
    const bucket = Math.floor((index * limit) / list.length);
    if (bucket === lastBucket) kept[kept.length - 1] = list[index];
    else kept.push(list[index]);
    lastBucket = bucket;
  }
  return kept;
}

module.exports = {
  STATS_SAMPLE_DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  STATS_SAMPLE_MIN_INTERVAL_MS: MIN_INTERVAL_MS,
  STATS_SAMPLE_MAX_INTERVAL_MS: MAX_INTERVAL_MS,
  STATS_PERSIST_INTERVAL_MS: PERSIST_INTERVAL_MS,
  STATS_SNAPSHOT_LIMIT: SNAPSHOT_LIMIT,
  LATENCY_WINDOW_SECONDS,
  LATENCY_HISTOGRAMS,
  LATENCY_SCOPE,
  AVERAGE_SOURCE_LIFETIME_GAUGE,
  TREND_MAX_POINTS,
  resolveStatsSampleIntervalMs,
  histogramFromSeries,
  latencyHistogramsFromSeries,
  computeLatencyWindow,
  createStatsSampler,
  sampledStatsSummary,
  applyStatsWindows,
  downsampleTrendSamples,
};
