"use strict";

// Rollups (docs/overhaul/04-telemetry.md §10, §6.4). These functions run
// inside the store worker, next to the DatabaseSync handle; store-worker.js
// calls runRollups every 30 s and markLate on every insert.
//
// Three families roll up at three grains:
//   requests  requests        -> rollup_1m, rollup_1h, rollup_1d
//   runtime   runtime_samples -> runtime_rollup_1m, _1h, _1d
//   gpu       gpu_samples     -> gpu_rollup_1m, _1h, _1d
// A 1m bucket is a function of the raw rows of its minute, a 1h bucket of the
// 1m rows of its hour and a 1d bucket of the 1h rows of its local day. A
// bucket is always written as DELETE plus a recompute, and every fold runs in
// a fixed order (raw rows by time and id, child rows by bucket and key), so
// recomputing any bucket writes exactly the rows a from-scratch rollup
// writes. When the rows one grain below were already pruned, the bucket is
// rebuilt from the raw rows through the same per-grain folds, or left alone
// when those are gone too.
//
// Watermarks (collector_state rollup.1m, rollup.1h, rollup.1d): every bucket
// below a grain's watermark is closed. The live roll closes a minute 90 s
// after it ends, an hour at minute 2 and a local day at 00:10. An insert into
// a closed minute adds (<family>.1m, bucket) to rollup_dirty (markLate); a
// bare grain ('1m', bucket) from another writer means every family. The next
// pass recomputes that minute and marks its hour and day dirty when they are
// closed. Dirty buckets whose inputs retention already pruned are dropped and
// counted.
//
// Coverage (§6.4): a closed minute with a coverage_1m row from the recorder
// gets a zero-count marker row in rollup_1m (every dimension '', source
// 'coverage'), which folds into the hour and the day. A request count is null
// for a bucket with neither data nor a marker (a collection gap), and 0 for a
// covered bucket without matching requests (requestCounts). An hour rebuilt
// from raw rows after coverage_1m was pruned keeps its marker.
//
// Local days use timezoneOffsetMinutes, whole hours only. A changed offset
// starts a new calendar segment at the day watermark: closed days keep their
// bounds, and the first day under the new offset runs to its next local
// midnight, so no hour is counted in two days or in none.
//
// Importers that write rollup rows directly (TEL-18, source 'import') must
// write every grain they cover; this job folds whatever is in the grain below.

const { GATEWAY_MS_BUCKETS, DECODE_TPS_BUCKETS, mergeHist, quantile } = require("./histogram");
const { statusClass } = require("./error-class");
const schema = require("./schema");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const GRAINS = Object.freeze(["1m", "1h", "1d"]);
// How long after its end a bucket closes: 90 s for minutes (late finalisers),
// minute 2 for hours, 00:10 local for days.
const CLOSE_DELAY_MS = Object.freeze({ "1m": 90_000, "1h": 120_000, "1d": 600_000 });
const COVERAGE_SOURCE = "coverage";
// coverage_1m components that make a minute count as covered for requests.
const REQUEST_COVERAGE_COMPONENTS = Object.freeze(["recorder"]);
const DEFAULT_BUDGET_MS = 200;
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
const MAX_CALENDAR_SEGMENTS = 32;
const DIRTY_PAGE = 256;
const TIMEZONE_RANGE = Object.freeze([-720, 840]);
// Percentile columns recomputed from the merged histograms, and their kinds.
const QUANTILES = Object.freeze([["p50", 0.5], ["p95", 0.95], ["p99", 0.99]]);
const LATENCY_KINDS = Object.freeze(["ttft", "e2e", "itl", "tpot", "queue"]);

// ---------------------------------------------------------------- helpers

function rollupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function floorTo(at, size) {
  return Math.floor(at / size) * size;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addNullable(total, value) {
  const number = numberOrNull(value);
  if (number === null) return total;
  return total === null ? number : total + number;
}

function maxNullable(current, value) {
  const number = numberOrNull(value);
  if (number === null) return current;
  return current === null || number > current ? number : current;
}

function parseJson(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const STATEMENTS = new WeakMap();

function statement(db, sql) {
  let cache = STATEMENTS.get(db);
  if (!cache) {
    cache = new Map();
    STATEMENTS.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

// Joins the caller's transaction when there is one (markLate runs inside the
// insert transaction), otherwise runs `operation` in its own.
function inTransaction(db, operation) {
  if (db.isTransaction) return operation();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function readState(db, name) {
  const row = statement(db, "SELECT value FROM collector_state WHERE name = ?").get(name);
  return row ? parseJson(row.value) : null;
}

function writeState(db, name, value) {
  statement(
    db,
    "INSERT INTO collector_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(name, JSON.stringify(value), Date.now());
}

function readWatermark(db, grain) {
  const state = readState(db, `rollup.${grain}`);
  const value = Number(state && state.watermark);
  return state && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------- local days

function hostTimezoneOffsetMinutes() {
  const offset = -new Date().getTimezoneOffset();
  return Number.isInteger(offset) && offset % 60 === 0 ? offset || 0 : 0;
}

// null/undefined/"" means the host offset (or UTC when the host offset is not
// a whole hour). Anything else must be a whole number of hours in range.
function normalizeTimezoneOffset(value) {
  if (value === undefined || value === null || value === "") return hostTimezoneOffsetMinutes();
  let number = Number.NaN;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) number = Number(value.trim());
  if (!Number.isInteger(number) || number % 60 !== 0 || number < TIMEZONE_RANGE[0] || number > TIMEZONE_RANGE[1]) {
    throw rollupError(
      "invalid_timezone_offset",
      "telemetry.timezoneOffsetMinutes must be a whole number of hours between -720 and 840 (for example 480 for UTC+08:00).",
    );
  }
  return number || 0;
}

// Start of the local day that holds `at`, as epoch ms.
function alignDay(at, offsetMinutes) {
  const shift = offsetMinutes * MINUTE_MS;
  return floorTo(at + shift, DAY_MS) - shift;
}

// segments: [{from, offsetMinutes}] sorted by `from`. Times before the first
// segment use its offset.
function createCalendar(segments) {
  const list = segments.length ? segments : [{ from: 0, offsetMinutes: 0 }];
  function segmentIndex(at) {
    let index = 0;
    for (let position = 1; position < list.length; position += 1) {
      if (list[position].from <= at) index = position;
    }
    return index;
  }
  return {
    segments: list,
    offsetAt(at) {
      return list[segmentIndex(at)].offsetMinutes;
    },
    dayOf(at) {
      const segment = list[segmentIndex(at)];
      const start = alignDay(at, segment.offsetMinutes);
      return at >= segment.from && start < segment.from ? segment.from : start;
    },
    dayEnd(bucket) {
      const index = segmentIndex(bucket);
      const end = alignDay(bucket, list[index].offsetMinutes) + DAY_MS;
      const next = list[index + 1];
      return next && next.from < end ? next.from : end;
    },
  };
}

function calendarFromState(db, fallbackOffset) {
  const state = readState(db, "rollup.1d");
  const segments = state && Array.isArray(state.segments) ? state.segments.filter(validSegment) : [];
  if (segments.length) return createCalendar(segments);
  return createCalendar([{ from: Number.MIN_SAFE_INTEGER, offsetMinutes: fallbackOffset }]);
}

function validSegment(segment) {
  return segment && Number.isFinite(Number(segment.from)) && Number.isInteger(segment.offsetMinutes);
}

// ---------------------------------------------------------------- requests family

const REQUEST_DIMENSIONS = Object.freeze([
  "manager_id", "fleet_id", "engine_id", "model", "key_id", "customer_id",
  "source_program", "protocol", "status_class", "error_class",
]);
const REQUEST_COUNTERS = Object.freeze([
  "requests", "completed", "client_aborts", "streams", "prompt_tokens", "cached_tokens", "output_tokens",
  "estimated_usage", "finish_length", "finish_tool", "duration_ms_sum", "ttft_ms_sum", "ttft_n",
  "decode_tps_sum", "decode_tps_n",
]);
// Rollup histogram columns: JSON arrays of cumulative counts over fixed bounds.
const REQUEST_HISTOGRAMS = Object.freeze({
  ttft_hist: GATEWAY_MS_BUCKETS,
  duration_hist: GATEWAY_MS_BUCKETS,
  decode_hist: DECODE_TPS_BUCKETS,
});
const REQUEST_RAW_COLUMNS = Object.freeze([
  "request_id", "ingress", "received_at", "manager_id", "fleet_id", "engine_id", "model_resolved", "model_requested",
  "key_id", "customer_id", "source_program", "protocol", "status", "terminal_state", "error_class", "stream",
  "prompt_tokens", "cached_tokens", "output_tokens", "usage_source", "finish_reason", "duration_ms", "ttft_ms",
  "decode_tps", "extra",
]);

function boundIndex(bounds, value) {
  for (let index = 0; index < bounds.length; index += 1) {
    const bound = bounds[index];
    if (bound === "+Inf" || value <= bound) return index;
  }
  return bounds.length - 1;
}

function observeCounts(counts, bounds, value) {
  const number = numberOrNull(value);
  if (number === null) return counts;
  const output = counts || new Array(bounds.length).fill(0);
  for (let index = boundIndex(bounds, number); index < output.length; index += 1) output[index] += 1;
  return output;
}

function addCounts(counts, bounds, value) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length !== bounds.length) return counts;
  const output = counts || new Array(bounds.length).fill(0);
  for (let index = 0; index < output.length; index += 1) output[index] += Number(parsed[index]) || 0;
  return output;
}

// The rollup dimensions of one raw requests row. Exported so the query layer
// groups raw rows exactly as the rollups do.
function requestDimensions(row) {
  return {
    manager_id: text(row.manager_id),
    fleet_id: text(row.fleet_id),
    engine_id: text(row.engine_id),
    model: text(row.model_resolved) || text(row.model_requested),
    key_id: text(row.key_id),
    customer_id: text(row.customer_id),
    source_program: text(row.source_program),
    protocol: text(row.protocol),
    status_class: statusClass(row.status),
    error_class: text(row.error_class),
    source: text(row.ingress).startsWith("import") ? "import" : "live",
  };
}

// §18: an imported entry row that duplicates a manager row carries
// extra.dupOf, and rollups skip it.
function isDuplicate(row) {
  if (typeof row.extra !== "string" || !row.extra.includes("dupOf")) return false;
  const extra = parseJson(row.extra);
  return Boolean(extra && extra.dupOf);
}

const requestsFamily = {
  name: "requests",
  tables: Object.freeze({ "1m": "rollup_1m", "1h": "rollup_1h", "1d": "rollup_1d" }),
  rawTtl: "requests",
  key: Object.freeze([...REQUEST_DIMENSIONS, "source"]),
  columns: Object.freeze(["bucket", ...REQUEST_DIMENSIONS, ...REQUEST_COUNTERS, ...Object.keys(REQUEST_HISTOGRAMS), "source"]),
  newGroup(key) {
    const counters = {};
    for (const name of REQUEST_COUNTERS) counters[name] = 0;
    const hist = {};
    for (const name of Object.keys(REQUEST_HISTOGRAMS)) hist[name] = null;
    return { key, counters, hist };
  },
  keyOfRaw(row) {
    return requestDimensions(row);
  },
  addRaw(group, row) {
    const counters = group.counters;
    counters.requests += 1;
    if (row.terminal_state === "completed") counters.completed += 1;
    if (row.terminal_state === "client_abort") counters.client_aborts += 1;
    if (Number(row.stream) === 1) counters.streams += 1;
    counters.prompt_tokens += numberOrNull(row.prompt_tokens) || 0;
    counters.cached_tokens += numberOrNull(row.cached_tokens) || 0;
    counters.output_tokens += numberOrNull(row.output_tokens) || 0;
    if (row.usage_source === "estimated") counters.estimated_usage += 1;
    if (row.finish_reason === "length") counters.finish_length += 1;
    if (row.finish_reason === "tool_calls") counters.finish_tool += 1;
    counters.duration_ms_sum += numberOrNull(row.duration_ms) || 0;
    group.hist.duration_hist = observeCounts(group.hist.duration_hist, GATEWAY_MS_BUCKETS, row.duration_ms);
    const ttft = numberOrNull(row.ttft_ms);
    if (ttft !== null) {
      counters.ttft_ms_sum += ttft;
      counters.ttft_n += 1;
      group.hist.ttft_hist = observeCounts(group.hist.ttft_hist, GATEWAY_MS_BUCKETS, ttft);
    }
    const decode = numberOrNull(row.decode_tps);
    if (decode !== null) {
      counters.decode_tps_sum += decode;
      counters.decode_tps_n += 1;
      group.hist.decode_hist = observeCounts(group.hist.decode_hist, DECODE_TPS_BUCKETS, decode);
    }
  },
  fold(group, child) {
    for (const name of REQUEST_COUNTERS) group.counters[name] += Number(child[name]) || 0;
    for (const [name, bounds] of Object.entries(REQUEST_HISTOGRAMS)) {
      group.hist[name] = addCounts(group.hist[name], bounds, child[name]);
    }
  },
  finish(group, bucket) {
    const row = { bucket, ...group.key, ...group.counters };
    for (const name of Object.keys(REQUEST_HISTOGRAMS)) row[name] = group.hist[name] ? JSON.stringify(group.hist[name]) : null;
    return row;
  },
};

function coverageKey() {
  const key = {};
  for (const name of REQUEST_DIMENSIONS) key[name] = "";
  key.source = COVERAGE_SOURCE;
  return key;
}

// ---------------------------------------------------------------- runtime family

const RUNTIME_DELTAS = Object.freeze([
  "d_prompt_tokens", "d_cached_tokens", "d_output_tokens", "d_requests", "d_errors", "d_aborts", "d_finish_length",
  "d_spec_draft_tokens", "d_spec_accepted_tokens",
]);
const RUNTIME_GAUGES = Object.freeze(["running", "waiting", "kv_usage"]);
const RUNTIME_PERCENTILES = Object.freeze(
  LATENCY_KINDS.flatMap((kind) => QUANTILES.map(([suffix]) => `${kind}_${suffix}_ms`)),
);

function newGauge() {
  return { sum: 0, weight: 0, max: null };
}

function addGauge(gauge, average, weight, max) {
  const value = numberOrNull(average);
  if (value !== null) {
    gauge.sum += value * weight;
    gauge.weight += weight;
  }
  gauge.max = maxNullable(gauge.max, max);
}

function gaugeAverage(gauge) {
  return gauge.weight > 0 ? gauge.sum / gauge.weight : null;
}

// Histogram units: engine histograms are in seconds, gateway-derived ones in
// milliseconds (§7.2). Rollup hist JSON names the unit explicitly.
function histogramUnit(hist, latencySource) {
  if (hist && (hist.unit === "ms" || hist.unit === "s")) return hist.unit;
  return latencySource === "gateway" ? "ms" : "s";
}

function addHistogram(variants, hist, unit) {
  let parsed;
  try {
    parsed = mergeHist(null, hist);
  } catch {
    return;
  }
  if (!parsed) return;
  const variant = `${unit}|${JSON.stringify(parsed.le)}`;
  const current = variants.get(variant);
  variants.set(variant, current ? mergeHist(current, parsed) : parsed);
}

// One histogram per kind: the variant (unit and bounds) with the most
// observations wins when an engine changed its buckets inside a bucket.
function pickHistogram(variants) {
  let bestKey = null;
  let best = null;
  for (const [variant, hist] of variants) {
    if (!best || hist.count > best.count || (hist.count === best.count && variant < bestKey)) {
      best = hist;
      bestKey = variant;
    }
  }
  if (!best) return null;
  const output = { le: best.le, d: best.counts, unit: bestKey.split("|")[0], count: best.count };
  if (best.sum !== null && best.sum !== undefined) output.sum = best.sum;
  return output;
}

function addWeighted(map, name, weight) {
  if (!name) return;
  map.set(name, (map.get(name) || 0) + weight);
}

function pickWeighted(map) {
  let best = null;
  let bestWeight = -1;
  for (const [name, weight] of map) {
    if (weight > bestWeight || (weight === bestWeight && name < best)) {
      best = name;
      bestWeight = weight;
    }
  }
  return best;
}

function ratio(numerator, denominator) {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
}

const runtimeFamily = {
  name: "runtime",
  tables: Object.freeze({ "1m": "runtime_rollup_1m", "1h": "runtime_rollup_1h", "1d": "runtime_rollup_1d" }),
  rawTtl: "samples",
  key: Object.freeze(["fleet_id", "model"]),
  columns: Object.freeze([
    "bucket", "fleet_id", "model", "manager_id", "engine_id", "sample_count", "scrape_failures", "resets",
    "idle_seconds", "interval_ms_sum", ...RUNTIME_DELTAS,
    "running_avg", "running_max", "waiting_avg", "waiting_max", "kv_usage_avg", "kv_usage_max", "kv_capacity_tokens",
    "prefix_hit_rate", "spec_accept_rate", ...RUNTIME_PERCENTILES, "latency_source", "hist", "energy_wh",
  ]),
  newGroup(key) {
    const deltas = {};
    for (const name of RUNTIME_DELTAS) deltas[name] = null;
    const gauges = {};
    for (const name of RUNTIME_GAUGES) gauges[name] = newGauge();
    const hist = {};
    for (const kind of LATENCY_KINDS) hist[kind] = new Map();
    return {
      key, managerId: "", engineId: null, sampleCount: 0, scrapeFailures: 0, resets: 0, idleMs: 0, intervalMs: 0,
      deltas, gauges, kvCapacity: null, energy: null, sources: new Map(), hist,
    };
  },
  keyOfRaw(row) {
    return { fleet_id: text(row.fleet_id), model: text(row.model) };
  },
  addRaw(group, row) {
    group.managerId = text(row.manager_id);
    if (row.engine_id !== null && row.engine_id !== undefined) group.engineId = text(row.engine_id);
    group.sampleCount += 1;
    if (Number(row.scrape_ok) !== 1) group.scrapeFailures += 1;
    if (Number(row.reset) === 1) group.resets += 1;
    const interval = numberOrNull(row.interval_ms);
    if (interval !== null && Number(row.scrape_ok) === 1 && Number(row.reset) !== 1) group.intervalMs += interval;
    if (interval !== null && Number(row.idle) === 1) group.idleMs += interval;
    for (const name of RUNTIME_DELTAS) group.deltas[name] = addNullable(group.deltas[name], row[name]);
    for (const name of RUNTIME_GAUGES) addGauge(group.gauges[name], row[name], 1, row[name]);
    group.kvCapacity = maxNullable(group.kvCapacity, row.kv_capacity_tokens);
    group.energy = addNullable(group.energy, row.energy_wh);
    addWeighted(group.sources, row.latency_source, 1);
    const hist = parseJson(row.hist);
    if (hist && typeof hist === "object") {
      for (const kind of LATENCY_KINDS) {
        if (hist[kind]) addHistogram(group.hist[kind], hist[kind], histogramUnit(hist[kind], row.latency_source));
      }
    }
  },
  fold(group, child) {
    group.managerId = text(child.manager_id);
    if (child.engine_id !== null && child.engine_id !== undefined) group.engineId = text(child.engine_id);
    const samples = Number(child.sample_count) || 0;
    const failures = Number(child.scrape_failures) || 0;
    group.sampleCount += samples;
    group.scrapeFailures += failures;
    group.resets += Number(child.resets) || 0;
    group.intervalMs += Number(child.interval_ms_sum) || 0;
    group.idleMs += Math.round((Number(child.idle_seconds) || 0) * 1000);
    for (const name of RUNTIME_DELTAS) group.deltas[name] = addNullable(group.deltas[name], child[name]);
    // Gauge averages are weighted by the scrapes that could report them. The
    // schema keeps no per-gauge count, so a gauge that only some successful
    // scrapes of a minute reported weighs as if all of them had: exact per
    // sample while a gauge is either always or never reported.
    const weight = Math.max(1, samples - failures);
    for (const name of RUNTIME_GAUGES) addGauge(group.gauges[name], child[`${name}_avg`], weight, child[`${name}_max`]);
    group.kvCapacity = maxNullable(group.kvCapacity, child.kv_capacity_tokens);
    group.energy = addNullable(group.energy, child.energy_wh);
    addWeighted(group.sources, child.latency_source, samples);
    const hist = parseJson(child.hist);
    if (hist && typeof hist === "object") {
      for (const kind of LATENCY_KINDS) {
        if (hist[kind]) addHistogram(group.hist[kind], hist[kind], histogramUnit(hist[kind], child.latency_source));
      }
    }
  },
  finish(group, bucket) {
    const row = {
      bucket,
      ...group.key,
      manager_id: group.managerId,
      engine_id: group.engineId,
      sample_count: group.sampleCount,
      scrape_failures: group.scrapeFailures,
      resets: group.resets,
      idle_seconds: group.idleMs / 1000,
      interval_ms_sum: group.intervalMs,
      ...group.deltas,
    };
    for (const name of RUNTIME_GAUGES) {
      row[`${name}_avg`] = gaugeAverage(group.gauges[name]);
      row[`${name}_max`] = group.gauges[name].max;
    }
    row.kv_capacity_tokens = group.kvCapacity;
    row.prefix_hit_rate = ratio(group.deltas.d_cached_tokens, group.deltas.d_prompt_tokens);
    row.spec_accept_rate = ratio(group.deltas.d_spec_accepted_tokens, group.deltas.d_spec_draft_tokens);
    const merged = {};
    for (const kind of LATENCY_KINDS) {
      const hist = pickHistogram(group.hist[kind]);
      if (hist) merged[kind] = hist;
      const scale = hist && hist.unit === "s" ? 1000 : 1;
      for (const [suffix, level] of QUANTILES) {
        const value = hist ? quantile({ le: hist.le, counts: hist.d }, level) : null;
        row[`${kind}_${suffix}_ms`] = value === null || !Number.isFinite(value) ? null : value * scale;
      }
    }
    row.latency_source = pickWeighted(group.sources);
    row.hist = Object.keys(merged).length ? JSON.stringify(merged) : null;
    row.energy_wh = group.energy;
    return row;
  },
};

// ---------------------------------------------------------------- gpu family

const GPU_AVERAGES = Object.freeze([["util_pct", "util_pct_avg", "util_pct_max"], ["temp_c", "temp_c_avg", "temp_c_max"],
  ["power_w", "power_w_avg", "power_w_max"]]);

function throttleReasons(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return Array.from(new Set(value.split(",").map((reason) => reason.trim()).filter(Boolean)));
}

function addThrottle(map, reason, ms) {
  map.set(reason, (map.get(reason) || 0) + ms);
}

const gpuFamily = {
  name: "gpu",
  tables: Object.freeze({ "1m": "gpu_rollup_1m", "1h": "gpu_rollup_1h", "1d": "gpu_rollup_1d" }),
  rawTtl: "samples",
  key: Object.freeze(["gpu_index"]),
  columns: Object.freeze([
    "bucket", "gpu_index", "gpu_uuid", "name", "sample_count", "util_pct_avg", "util_pct_max", "mem_used_mb_max",
    "mem_total_mb", "temp_c_avg", "temp_c_max", "power_w_avg", "power_w_max", "energy_wh", "idle_energy_wh",
    "throttle_seconds",
  ]),
  newGroup(key) {
    const gauges = {};
    for (const [name] of GPU_AVERAGES) gauges[name] = newGauge();
    return {
      key, uuid: null, name: null, sampleCount: 0, gauges, memUsedMax: null, memTotal: null,
      energy: 0, idleEnergy: 0, throttleMs: new Map(),
    };
  },
  keyOfRaw(row) {
    return { gpu_index: Number(row.gpu_index) };
  },
  // `durationMs` is the time this sample stands for: the gap to the previous
  // sample of the same GPU, capped at two collector intervals (§8).
  addRaw(group, row, durationMs) {
    if (row.gpu_uuid !== null && row.gpu_uuid !== undefined) group.uuid = text(row.gpu_uuid);
    if (row.name !== null && row.name !== undefined) group.name = text(row.name);
    group.sampleCount += 1;
    for (const [name] of GPU_AVERAGES) addGauge(group.gauges[name], row[name], 1, row[name]);
    group.memUsedMax = maxNullable(group.memUsedMax, row.mem_used_mb);
    group.memTotal = maxNullable(group.memTotal, row.mem_total_mb);
    const energy = numberOrNull(row.energy_wh) || 0;
    group.energy += energy;
    const reasons = throttleReasons(row.throttle);
    if (numberOrNull(row.util_pct) === 0 || reasons.includes("gpu_idle")) group.idleEnergy += energy;
    for (const reason of reasons) addThrottle(group.throttleMs, reason, durationMs);
  },
  fold(group, child) {
    if (child.gpu_uuid !== null && child.gpu_uuid !== undefined) group.uuid = text(child.gpu_uuid);
    if (child.name !== null && child.name !== undefined) group.name = text(child.name);
    const samples = Number(child.sample_count) || 0;
    group.sampleCount += samples;
    // Weighted by sample_count, as for runtime gauges (no per-gauge count).
    for (const [name, average, max] of GPU_AVERAGES) addGauge(group.gauges[name], child[average], Math.max(1, samples), child[max]);
    group.memUsedMax = maxNullable(group.memUsedMax, child.mem_used_mb_max);
    group.memTotal = maxNullable(group.memTotal, child.mem_total_mb);
    group.energy += Number(child.energy_wh) || 0;
    group.idleEnergy += Number(child.idle_energy_wh) || 0;
    const throttle = parseJson(child.throttle_seconds);
    if (throttle && typeof throttle === "object") {
      for (const [reason, seconds] of Object.entries(throttle)) {
        addThrottle(group.throttleMs, reason, Math.round((Number(seconds) || 0) * 1000));
      }
    }
  },
  finish(group, bucket) {
    const row = { bucket, ...group.key, gpu_uuid: group.uuid, name: group.name, sample_count: group.sampleCount };
    for (const [name, average, max] of GPU_AVERAGES) {
      row[average] = gaugeAverage(group.gauges[name]);
      row[max] = group.gauges[name].max;
    }
    row.mem_used_mb_max = group.memUsedMax;
    row.mem_total_mb = group.memTotal;
    row.energy_wh = group.energy;
    row.idle_energy_wh = group.idleEnergy;
    const reasons = Array.from(group.throttleMs.keys()).sort();
    row.throttle_seconds = reasons.length
      ? JSON.stringify(Object.fromEntries(reasons.map((reason) => [reason, group.throttleMs.get(reason) / 1000])))
      : null;
    return row;
  },
};

const FAMILIES = Object.freeze({ requests: requestsFamily, runtime: runtimeFamily, gpu: gpuFamily });
const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));

function familyOf(name) {
  const family = FAMILIES[name];
  if (!family) throw rollupError("unknown_rollup_family", `Unknown rollup family: ${name}`);
  return family;
}

function assertGrain(grain) {
  if (!GRAINS.includes(grain)) throw rollupError("unknown_rollup_grain", `Unknown rollup grain: ${grain}`);
}

// ---------------------------------------------------------------- context

function ttlFrom(input) {
  const ttl = { ...schema.TTL_DEFAULTS };
  if (input && typeof input === "object") {
    for (const key of Object.keys(ttl)) {
      const value = numberOrNull(input[key]);
      if (value !== null && value > 0) ttl[key] = value;
    }
  }
  return ttl;
}

// Buckets at or above a cutoff still have their inputs: raw rows (requests,
// samples) or the rows of a grain. `floors` are the cutoffs retention last
// applied, which include the size guard's (store-worker.js).
function computeCutoffs(now, ttl, floors) {
  const floor = (name, value) => Math.max(value, Number.isFinite(Number(floors && floors[name])) ? Number(floors[name]) : -Infinity);
  return {
    requests: floor("requests", now - ttl.requestsDays * DAY_MS),
    samples: floor("samples", now - ttl.samplesHours * HOUR_MS),
    "1m": floor("minute", now - ttl.minuteDays * DAY_MS),
    "1h": floor("hour", now - ttl.hourDays * DAY_MS),
    "1d": -Infinity,
  };
}

// `budgetMs` bounds one call: no budget (null) is unlimited, and a negative
// one counts as 0. The budget is only checked once the call has done one
// unit of work (one dirty entry or one bucket close), so every call makes
// progress even with a budget of 0.
function createContext(db, now, options = {}) {
  const at = Number(now);
  if (!Number.isFinite(at)) throw rollupError("invalid_time", "Rollups need a finite time.");
  const offset = normalizeTimezoneOffset(options.timezoneOffsetMinutes);
  const ttl = ttlFrom(options.ttl);
  const floors = options.floors || readState(db, "retention.floors") || {};
  const sampleIntervalMs = Math.max(1000, numberOrNull(options.sampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS);
  const budget = numberOrNull(options.budgetMs);
  const budgetMs = budget === null ? null : Math.max(0, budget);
  const started = Date.now();
  let units = 0;
  let gpuIndexes = null;
  return {
    db,
    now: at,
    offset,
    ttl,
    cutoffs: computeCutoffs(at, ttl, floors),
    calendar: options.calendar || calendarFromState(db, offset),
    sampleIntervalMs,
    progress() {
      units += 1;
    },
    units() {
      return units;
    },
    overBudget() {
      return budgetMs !== null && units > 0 && Date.now() - started >= budgetMs;
    },
    gpuIndexes() {
      if (!gpuIndexes) gpuIndexes = listGpuIndexes(db);
      return gpuIndexes;
    },
  };
}

// Distinct gpu_index values by skip-scan over the (gpu_index, at) key.
function listGpuIndexes(db) {
  const next = statement(db, "SELECT gpu_index FROM gpu_samples WHERE gpu_index > ? ORDER BY gpu_index LIMIT 1");
  const indexes = [];
  let cursor = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const row = next.get(cursor);
    if (!row) return indexes;
    cursor = Number(row.gpu_index);
    indexes.push(cursor);
  }
}

// ---------------------------------------------------------------- bucket computation

function childGrainOf(grain) {
  return grain === "1d" ? "1h" : "1m";
}

function bucketEnd(ctx, grain, bucket) {
  if (grain === "1m") return bucket + MINUTE_MS;
  if (grain === "1h") return bucket + HOUR_MS;
  return ctx.calendar.dayEnd(bucket);
}

function bucketOf(ctx, grain, at) {
  if (grain === "1m") return floorTo(at, MINUTE_MS);
  if (grain === "1h") return floorTo(at, HOUR_MS);
  return ctx.calendar.dayOf(at);
}

function groupKeyText(family, key) {
  return JSON.stringify(family.key.map((name) => key[name]));
}

function groupFor(groups, family, key) {
  const text = groupKeyText(family, key);
  let group = groups.get(text);
  if (!group) {
    group = family.newGroup(key);
    groups.set(text, group);
  }
  return group;
}

function finishGroups(family, groups, bucket) {
  return Array.from(groups.keys()).sort().map((text) => family.finish(groups.get(text), bucket));
}

function selectRawRequests(db, from, to) {
  return statement(db, `SELECT ${REQUEST_RAW_COLUMNS.join(", ")} FROM requests
    WHERE received_at >= ? AND received_at < ? ORDER BY received_at, request_id`).all(from, to);
}

function minuteCovered(db, bucket) {
  const placeholders = REQUEST_COVERAGE_COMPONENTS.map(() => "?").join(", ");
  return Boolean(statement(db, `SELECT 1 AS covered FROM coverage_1m
    WHERE bucket >= ? AND bucket < ? AND component IN (${placeholders}) LIMIT 1`)
    .get(bucket, bucket + MINUTE_MS, ...REQUEST_COVERAGE_COMPONENTS));
}

function computeRequestMinute(ctx, bucket) {
  const groups = new Map();
  for (const row of selectRawRequests(ctx.db, bucket, bucket + MINUTE_MS)) {
    if (isDuplicate(row)) continue;
    requestsFamily.addRaw(groupFor(groups, requestsFamily, requestsFamily.keyOfRaw(row)), row);
  }
  if (minuteCovered(ctx.db, bucket)) groupFor(groups, requestsFamily, coverageKey());
  return finishGroups(requestsFamily, groups, bucket);
}

function computeRuntimeMinute(ctx, bucket) {
  const groups = new Map();
  const rows = statement(ctx.db, `SELECT * FROM runtime_samples WHERE at >= ? AND at < ? ORDER BY at, fleet_id, model`)
    .all(bucket, bucket + MINUTE_MS);
  for (const row of rows) runtimeFamily.addRaw(groupFor(groups, runtimeFamily, runtimeFamily.keyOfRaw(row)), row);
  return finishGroups(runtimeFamily, groups, bucket);
}

function computeGpuMinute(ctx, bucket) {
  const groups = new Map();
  const cap = 2 * ctx.sampleIntervalMs;
  const previous = statement(ctx.db, "SELECT at FROM gpu_samples WHERE gpu_index = ? AND at < ? ORDER BY at DESC LIMIT 1");
  const select = statement(ctx.db, "SELECT * FROM gpu_samples WHERE gpu_index = ? AND at >= ? AND at < ? ORDER BY at");
  for (const index of ctx.gpuIndexes()) {
    const rows = select.all(index, bucket, bucket + MINUTE_MS);
    if (!rows.length) continue;
    const before = previous.get(index, bucket);
    let prevAt = before ? Number(before.at) : null;
    for (const row of rows) {
      const at = Number(row.at);
      const duration = prevAt === null ? ctx.sampleIntervalMs : Math.min(Math.max(0, at - prevAt), cap);
      gpuFamily.addRaw(groupFor(groups, gpuFamily, gpuFamily.keyOfRaw(row)), row, duration);
      prevAt = at;
    }
  }
  return finishGroups(gpuFamily, groups, bucket);
}

const MINUTE_COMPUTERS = Object.freeze({ requests: computeRequestMinute, runtime: computeRuntimeMinute, gpu: computeGpuMinute });

function selectRollupRows(db, family, grain, from, to) {
  const order = ["bucket", ...family.key].join(", ");
  return statement(db, `SELECT * FROM ${family.tables[grain]} WHERE bucket >= ? AND bucket < ? ORDER BY ${order}`).all(from, to);
}

function foldRows(family, children, bucket) {
  const groups = new Map();
  for (const child of children) {
    const key = {};
    for (const name of family.key) key[name] = child[name];
    family.fold(groupFor(groups, family, key), child);
  }
  return finishGroups(family, groups, bucket);
}

// The rows of one bucket, or null when its inputs are gone (pruned by
// retention). A higher grain reads the stored rows of the grain below while
// that grain's retention covers the whole bucket; otherwise it recomputes
// those rows first, so the folds and their order stay the same.
function computeBucket(ctx, family, grain, bucket) {
  if (grain === "1m") {
    if (bucket < ctx.cutoffs[family.rawTtl]) return null;
    return MINUTE_COMPUTERS[family.name](ctx, bucket);
  }
  const childGrain = childGrainOf(grain);
  const end = bucketEnd(ctx, grain, bucket);
  if (bucket >= ctx.cutoffs[childGrain]) {
    return foldRows(family, selectRollupRows(ctx.db, family, childGrain, bucket, end), bucket);
  }
  const children = [];
  for (let child = bucket; child < end; child = bucketEnd(ctx, childGrain, child)) {
    const rows = computeBucket(ctx, family, childGrain, child);
    if (rows === null) return null;
    children.push(...rows);
  }
  // coverage_1m is pruned with the 1m rows (minuteDays), so minutes rebuilt
  // from raw rows past that point no longer know they were covered. Coverage
  // only ever grows, so the bucket keeps the marker it already has.
  if (family === requestsFamily && bucket < ctx.cutoffs["1m"] && !children.some(isCoverageRow)
    && hasCoverageMarker(ctx.db, family.tables[grain], bucket)) {
    children.push(coverageRow(bucket));
  }
  return foldRows(family, children, bucket);
}

function isCoverageRow(row) {
  return row.source === COVERAGE_SOURCE;
}

function coverageRow(bucket) {
  return requestsFamily.finish(requestsFamily.newGroup(coverageKey()), bucket);
}

function hasCoverageMarker(db, table, bucket) {
  return Boolean(statement(db, `SELECT 1 AS covered FROM ${table} WHERE bucket = ? AND source = ? LIMIT 1`)
    .get(bucket, COVERAGE_SOURCE));
}

function writeBucket(ctx, family, grain, bucket, rows) {
  // Never write rows retention already pruned for this grain; they would only
  // be deleted again. 1d is kept forever.
  if (bucket < ctx.cutoffs[grain]) return false;
  const table = family.tables[grain];
  statement(ctx.db, `DELETE FROM ${table} WHERE bucket = ?`).run(bucket);
  const insert = statement(ctx.db, `INSERT INTO ${table} (${family.columns.join(", ")}) VALUES (${family.columns.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(...family.columns.map((name) => (row[name] === undefined ? null : row[name])));
  return true;
}

// ---------------------------------------------------------------- data lookups

const NEXT_RAW_SQL = Object.freeze([
  "SELECT MIN(received_at) AS at FROM requests WHERE received_at >= ? AND received_at < ?",
  "SELECT MIN(at) AS at FROM runtime_samples WHERE at >= ? AND at < ?",
]);

// Earliest time in [from, to) at which any input of `grain` has a row, or
// null. Each lookup is an index seek.
function nextDataTime(ctx, grain, from, to) {
  if (!(from < to)) return null;
  const candidates = [];
  const take = (row) => {
    const value = row && numberOrNull(row.at);
    if (value !== null) candidates.push(value);
  };
  for (const sql of NEXT_RAW_SQL) take(statement(ctx.db, sql).get(from, to));
  const placeholders = REQUEST_COVERAGE_COMPONENTS.map(() => "?").join(", ");
  take(statement(ctx.db, `SELECT MIN(bucket) AS at FROM coverage_1m WHERE bucket >= ? AND bucket < ? AND component IN (${placeholders})`)
    .get(from, to, ...REQUEST_COVERAGE_COMPONENTS));
  const gpu = statement(ctx.db, "SELECT MIN(at) AS at FROM gpu_samples WHERE gpu_index = ? AND at >= ? AND at < ?");
  for (const index of ctx.gpuIndexes()) take(gpu.get(index, from, to));
  const lower = grain === "1d" ? ["1m", "1h"] : grain === "1h" ? ["1m"] : [];
  for (const childGrain of lower) {
    for (const family of Object.values(FAMILIES)) {
      take(statement(ctx.db, `SELECT MIN(bucket) AS at FROM ${family.tables[childGrain]} WHERE bucket >= ? AND bucket < ?`).get(from, to));
    }
  }
  return candidates.length ? Math.min(...candidates) : null;
}

// ---------------------------------------------------------------- dirty marks

// `family` null writes the bare grain, which stands for every family.
function insertDirty(db, family, grain, bucket) {
  statement(db, "INSERT OR IGNORE INTO rollup_dirty (grain, bucket) VALUES (?, ?)").run(family ? `${family}.${grain}` : grain, bucket);
}

// Marks the closed minutes that rows inserted late belong to. `items` are
// {at} (requests use received_at), plus gpuIndex for gpu samples: a late GPU
// sample also changes the duration of the next sample of that GPU, so that
// sample's minute is marked as well. Runs inside the insert transaction.
// Returns the number of minutes marked.
function markLate(db, familyName, items) {
  familyOf(familyName);
  const watermark = readWatermark(db, "1m");
  if (watermark === null || !Array.isArray(items) || !items.length) return 0;
  const buckets = new Set();
  const nextSample = familyName === "gpu"
    ? statement(db, "SELECT at FROM gpu_samples WHERE gpu_index = ? AND at > ? ORDER BY at LIMIT 1")
    : null;
  for (const item of items) {
    const at = numberOrNull(item && item.at);
    if (at === null) continue;
    const bucket = floorTo(at, MINUTE_MS);
    if (bucket >= watermark) continue;
    buckets.add(bucket);
    if (nextSample && item.gpuIndex !== null && item.gpuIndex !== undefined) {
      const next = nextSample.get(Number(item.gpuIndex), at);
      const nextBucketStart = next ? floorTo(Number(next.at), MINUTE_MS) : null;
      if (nextBucketStart !== null && nextBucketStart < watermark) buckets.add(nextBucketStart);
    }
  }
  for (const bucket of buckets) insertDirty(db, familyName, "1m", bucket);
  return buckets.size;
}

// §10: an insert whose minute is at or before the watermark marks it dirty.
// For writers other than the store's insert methods, e.g. a coverage_1m
// upsert for a closed minute (family "requests").
function markDirty(db, atMs, familyName = "requests") {
  return markLate(db, familyName, [{ at: atMs }]) > 0;
}

// ---------------------------------------------------------------- the job

function emptyTally() {
  return { "1m": 0, "1h": 0, "1d": 0 };
}

function loadWatermarks(ctx) {
  const db = ctx.db;
  let minute = readWatermark(db, "1m");
  const limit = floorTo(ctx.now - CLOSE_DELAY_MS["1m"], MINUTE_MS);
  if (minute === null) {
    const first = nextDataTime(ctx, "1h", Number.MIN_SAFE_INTEGER, limit);
    minute = first === null ? limit : Math.min(limit, floorTo(first, MINUTE_MS));
    writeState(db, "rollup.1m", { watermark: minute });
  }
  let hour = readWatermark(db, "1h");
  if (hour === null) {
    hour = floorTo(minute, HOUR_MS);
    writeState(db, "rollup.1h", { watermark: hour });
  }
  const dayState = readState(db, "rollup.1d");
  let day = Number(dayState && dayState.watermark);
  let segments = dayState && Array.isArray(dayState.segments) ? dayState.segments.filter(validSegment) : [];
  if (!dayState || !Number.isFinite(day) || !segments.length) {
    day = alignDay(hour, ctx.offset);
    segments = [{ from: day, offsetMinutes: ctx.offset }];
    writeState(db, "rollup.1d", { watermark: day, segments });
  } else if (segments[segments.length - 1].offsetMinutes !== ctx.offset) {
    // A new offset applies from the first open day on; closed days keep
    // their bounds.
    const last = segments[segments.length - 1];
    if (last.from >= day) last.offsetMinutes = ctx.offset;
    else segments.push({ from: day, offsetMinutes: ctx.offset });
    while (segments.length > MAX_CALENDAR_SEGMENTS) segments.shift();
    writeState(db, "rollup.1d", { watermark: day, segments });
  }
  ctx.calendar = createCalendar(segments);
  return { minute, hour, day, segments };
}

function saveWatermark(ctx, marks, grain, value) {
  if (grain === "1m") marks.minute = value;
  else if (grain === "1h") marks.hour = value;
  else marks.day = value;
  const state = { watermark: value };
  if (grain === "1d") state.segments = marks.segments;
  writeState(ctx.db, `rollup.${grain}`, state);
}

function watermarkOf(marks, grain) {
  return grain === "1m" ? marks.minute : grain === "1h" ? marks.hour : marks.day;
}

// The hour of a minute or the local day of an hour, when it is closed.
function closedParent(ctx, marks, grain, bucket) {
  if (grain === "1m") {
    const hour = floorTo(bucket, HOUR_MS);
    return hour < marks.hour ? { grain: "1h", bucket: hour } : null;
  }
  if (grain === "1h") {
    const day = ctx.calendar.dayOf(bucket);
    return day < marks.day ? { grain: "1d", bucket: day } : null;
  }
  return null;
}

// Recomputes the dirty buckets of one grain, oldest first, and marks each
// parent dirty when the parent is already closed. markLate writes
// '<family>.<grain>' entries; a bare grain ('1m', the (grain, bucket) form of
// §10) stands for every family. A bucket counts as recomputed when at least
// one family rewrote it, and as dropped when no family could rebuild it; a
// bare entry marks its parent bare too. A minute below the 1m TTL is not
// written again, but its hour still is.
function processDirty(ctx, marks, grain, result) {
  const db = ctx.db;
  const names = [grain, ...FAMILY_NAMES.map((name) => `${name}.${grain}`)];
  const select = statement(db, `SELECT grain, bucket FROM rollup_dirty WHERE grain IN (${names.map(() => "?").join(", ")})
    ORDER BY bucket, grain LIMIT ${DIRTY_PAGE}`);
  const remove = statement(db, "DELETE FROM rollup_dirty WHERE grain = ? AND bucket = ?");
  for (;;) {
    const page = select.all(...names);
    if (!page.length) return true;
    for (const entry of page) {
      if (ctx.overBudget()) return false;
      const bare = entry.grain === grain;
      const families = bare ? Object.values(FAMILIES) : [FAMILIES[String(entry.grain).split(".")[0]]];
      const bucket = Number(entry.bucket);
      inTransaction(db, () => {
        remove.run(entry.grain, entry.bucket);
        // Not closed yet: the live roll computes it.
        if (bucket >= watermarkOf(marks, grain)) return;
        const rebuilt = [];
        let written = 0;
        for (const family of families) {
          const rows = computeBucket(ctx, family, grain, bucket);
          if (rows === null) continue;
          rebuilt.push(family.name);
          if (writeBucket(ctx, family, grain, bucket, rows)) written += 1;
        }
        if (!rebuilt.length) {
          result.droppedDirty += 1;
          return;
        }
        if (written) result.recomputed[grain] += 1;
        const parent = closedParent(ctx, marks, grain, bucket);
        if (!parent) return;
        for (const name of bare ? [null] : rebuilt) insertDirty(db, name, parent.grain, parent.bucket);
      });
      ctx.progress();
    }
  }
}

// Closes the buckets of `grain` that end at or before `limit`, skipping empty
// stretches. Families without input in a bucket are left untouched. The data
// check, the write and the watermark move share one transaction, so a row a
// second writer inserts meanwhile is either rolled here or marked dirty.
function closeBuckets(ctx, marks, grain, limit, result) {
  for (;;) {
    if (bucketEnd(ctx, grain, watermarkOf(marks, grain)) > limit) return true;
    if (ctx.overBudget()) return false;
    const closed = inTransaction(ctx.db, () => {
      const bucket = watermarkOf(marks, grain);
      const end = bucketEnd(ctx, grain, bucket);
      if (nextDataTime(ctx, grain, bucket, end) === null) {
        const later = nextDataTime(ctx, grain, end, limit);
        saveWatermark(ctx, marks, grain, bucketOf(ctx, grain, later === null ? limit : later));
        return false;
      }
      for (const family of Object.values(FAMILIES)) {
        const rows = computeBucket(ctx, family, grain, bucket);
        if (rows && rows.length) writeBucket(ctx, family, grain, bucket, rows);
      }
      saveWatermark(ctx, marks, grain, end);
      return true;
    });
    if (closed) result.closed[grain] += 1;
    ctx.progress();
  }
}

function countDirty(db) {
  return Number(statement(db, "SELECT COUNT(*) AS n FROM rollup_dirty").get().n) || 0;
}

// One bounded pass: dirty minutes, the live minute roll, dirty and closing
// hours, dirty and closing days. Stops early when `budgetMs` runs out and
// reports more:true; the next call continues where this one stopped. `units`
// counts the dirty entries and bucket closes handled; a call that reports
// more:true has handled at least one.
function runRollups(db, now, options = {}) {
  const started = Date.now();
  const ctx = createContext(db, now, options);
  const result = { ok: true, at: ctx.now, more: false, closed: emptyTally(), recomputed: emptyTally(), droppedDirty: 0 };
  const marks = inTransaction(db, () => loadWatermarks(ctx));
  const minuteLimit = floorTo(ctx.now - CLOSE_DELAY_MS["1m"], MINUTE_MS);
  const steps = [
    () => processDirty(ctx, marks, "1m", result),
    () => closeBuckets(ctx, marks, "1m", minuteLimit, result),
    () => processDirty(ctx, marks, "1h", result),
    () => closeBuckets(ctx, marks, "1h", Math.min(marks.minute, ctx.now - CLOSE_DELAY_MS["1h"]), result),
    () => processDirty(ctx, marks, "1d", result),
    () => closeBuckets(ctx, marks, "1d", Math.min(marks.hour, ctx.now - CLOSE_DELAY_MS["1d"]), result),
  ];
  for (const step of steps) {
    if (!step()) {
      result.more = true;
      break;
    }
  }
  const previous = readState(db, "rollup") || {};
  const summary = {
    lastRunAt: ctx.now,
    durationMs: Date.now() - started,
    timezoneOffsetMinutes: ctx.offset,
    closed: result.closed,
    recomputed: result.recomputed,
    droppedDirty: (Number(previous.droppedDirty) || 0) + result.droppedDirty,
    dirtyPending: countDirty(db),
  };
  writeState(db, "rollup", summary);
  return {
    ...result,
    units: ctx.units(),
    durationMs: summary.durationMs,
    dirtyPending: summary.dirtyPending,
    watermarks: { "1m": marks.minute, "1h": marks.hour, "1d": marks.day },
  };
}

// ---------------------------------------------------------------- explicit recompute

function rollupRange(db, familyNames, grain, fromBucket, toBucket, options) {
  assertGrain(grain);
  const ctx = createContext(db, options.now === undefined ? Date.now() : options.now, options);
  const from = Number(fromBucket);
  const to = Number(toBucket);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw rollupError("invalid_range", "Rollup ranges need finite bounds.");
  const result = { buckets: 0, rows: 0, skipped: 0 };
  let bucket = bucketOf(ctx, grain, from);
  if (bucket < from) bucket = bucketEnd(ctx, grain, bucket);
  for (; bucket < to; bucket = bucketEnd(ctx, grain, bucket)) {
    inTransaction(db, () => {
      for (const name of familyNames) {
        const family = familyOf(name);
        const rows = computeBucket(ctx, family, grain, bucket);
        if (rows === null || !writeBucket(ctx, family, grain, bucket, rows)) {
          result.skipped += 1;
          continue;
        }
        result.rows += rows.length;
      }
    });
    result.buckets += 1;
  }
  return result;
}

// Recomputes every request bucket of `grain` whose start lies in
// [fromBucket, toBucket). Buckets whose inputs were pruned are left as they
// are. options: {now, ttl, timezoneOffsetMinutes} (the 1d calendar comes from
// the job state when it exists).
function rollupRequests(db, grain, fromBucket, toBucket, options = {}) {
  return rollupRange(db, ["requests"], grain, fromBucket, toBucket, options);
}

// The same for runtime ("runtime") or GPU ("gpu") samples.
function rollupSamples(db, kind, grain, fromBucket, toBucket, options = {}) {
  if (kind !== "runtime" && kind !== "gpu") throw rollupError("unknown_rollup_family", `Unknown sample kind: ${kind}`);
  return rollupRange(db, [kind], grain, fromBucket, toBucket, options);
}

// ---------------------------------------------------------------- coverage-aware counts

// Request counts per bucket of `grain` in [from, to): a number where the
// bucket has matching rows, 0 where it is covered but nothing matches, and
// null for a collection gap. `filters` maps rollup dimensions (and `source`)
// to a value or a list of values.
function requestCounts(db, { grain = "1m", from, to, filters = {}, timezoneOffsetMinutes } = {}) {
  assertGrain(grain);
  const ctx = { calendar: calendarFromState(db, normalizeTimezoneOffset(timezoneOffsetMinutes)) };
  const table = requestsFamily.tables[grain];
  const where = ["bucket >= ?", "bucket < ?", "source <> ?"];
  const params = [Number(from), Number(to), COVERAGE_SOURCE];
  for (const [name, value] of Object.entries(filters || {})) {
    if (![...REQUEST_DIMENSIONS, "source"].includes(name)) throw rollupError("unknown_dimension", `Unknown rollup dimension: ${name}`);
    const values = (Array.isArray(value) ? value : [value]).map(text);
    if (!values.length) continue;
    where.push(`${name} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }
  const sums = new Map(db.prepare(`SELECT bucket, SUM(requests) AS n FROM ${table} WHERE ${where.join(" AND ")} GROUP BY bucket`)
    .all(...params).map((row) => [Number(row.bucket), Number(row.n)]));
  const covered = new Set(statement(db, `SELECT bucket FROM ${table} WHERE bucket >= ? AND bucket < ? AND source = ?`)
    .all(Number(from), Number(to), COVERAGE_SOURCE).map((row) => Number(row.bucket)));
  const output = [];
  let bucket = bucketOf(ctx, grain, Number(from));
  if (bucket < Number(from)) bucket = bucketEnd(ctx, grain, bucket);
  for (; bucket < Number(to); bucket = bucketEnd(ctx, grain, bucket)) {
    output.push({ bucket, requests: sums.has(bucket) ? sums.get(bucket) : covered.has(bucket) ? 0 : null });
  }
  return output;
}

module.exports = {
  GRAINS,
  CLOSE_DELAY_MS,
  COVERAGE_SOURCE,
  REQUEST_COVERAGE_COMPONENTS,
  REQUEST_DIMENSIONS,
  REQUEST_HISTOGRAMS,
  LATENCY_KINDS,
  FAMILY_NAMES,
  DEFAULT_BUDGET_MS,
  hostTimezoneOffsetMinutes,
  normalizeTimezoneOffset,
  alignDay,
  createCalendar,
  requestDimensions,
  rollupRequests,
  rollupSamples,
  markDirty,
  markLate,
  runRollups,
  requestCounts,
};
