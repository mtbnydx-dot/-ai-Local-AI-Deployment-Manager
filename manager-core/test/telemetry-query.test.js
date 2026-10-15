"use strict";

// The query layer (docs/overhaul/04-telemetry.md §11, TEL-11) against a real
// store in a temp folder: source and step selection, tiered reads that agree
// with the raw rows, whitelists, keyset pagination, top-N folding, coverage
// nulls, request detail, lifecycle and export paging.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");
const query = require("../telemetry/query");
const { openTelemetryStore } = require("../telemetry/store");
const { GATEWAY_MS_BUCKETS } = require("../telemetry/histogram");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TZ = 480;
const BASE = Date.UTC(2026, 9, 14, 0, 0, 0);
// Two local days later: 2026-10-14 and 2026-10-15 (UTC+08:00) are closed.
const NOW = BASE + 2 * DAY_MS;
const START = BASE + 2 * HOUR_MS;
const END = BASE + 5.5 * HOUR_MS;
const GAP_FROM = BASE + 3 * HOUR_MS;
const GAP_TO = BASE + 4 * HOUR_MS;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const MODELS = ["model-a", "model-b", "model-c", "model-d"];

function requestId(index, prefix = "req_") {
  let value = index;
  let text = "";
  for (let position = 0; position < 20; position += 1) {
    text = BASE32[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `${prefix}${text}`;
}

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-query-"));
  const file = path.join(dir, "telemetry.sqlite");
  const holder = {};
  t.after(async () => {
    try { await holder.store?.close({ flushMs: 0 }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return { dir, file, holder };
}

function withDb(file, operation) {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function genRequest(index, receivedAt) {
  const failed = index % 10 === 9;
  const aborted = index % 25 === 7;
  const status = failed ? 500 : aborted ? 499 : 200;
  const ok = status === 200;
  return {
    requestId: requestId(index),
    managerRequestId: requestId(index, "mgr_"),
    ingress: index % 7 === 0 ? "public" : "entry",
    receivedAt,
    endedAt: receivedAt + 800,
    managerId: index % 2 ? "vllm" : "llama",
    fleetId: index % 2 ? "vllm:primary" : "llama:primary",
    engineId: index % 2 ? "sglang" : "llamacpp",
    runtimeId: index % 2 ? "sglang@0.5.17" : "llamacpp@b10630",
    launchId: index % 2 ? "lch_aaaaaaaaaaaaaaaaaaaa" : null,
    protocol: "openai",
    op: "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelRequested: "auto",
    modelResolved: MODELS[index % 4],
    stream: index % 3 !== 0,
    keyId: `k_${index % 3}`,
    customerId: index % 5 === 0 ? "cust_a" : null,
    sourceProgram: index % 2 ? "openwebui" : "curl",
    clientIp: index % 2 ? "192.0.2.10" : "198.51.100.7",
    userAgent: "test-agent",
    status,
    terminalState: failed ? "failed" : aborted ? "client_abort" : "completed",
    errorClass: failed ? "upstream_5xx" : aborted ? "client_abort" : "none",
    queueMs: 3,
    upstreamHeadersMs: 140,
    ttftMs: ok ? 100 + (index % 50) * 20 : null,
    durationMs: 800,
    decodeTps: ok ? 20 + (index % 40) : null,
    promptTokens: 100 + (index % 50),
    cachedTokens: 20,
    outputTokens: ok ? 50 + (index % 100) : 0,
    usageSource: index % 6 === 0 ? "estimated" : "reported",
    finishReason: index % 8 === 0 ? "length" : "stop",
    extra: { toolSchemaCount: 0 },
  };
}

// 420 requests every 30 s from 02:00 to 05:30 UTC, none in the 03:00-04:00
// collection gap, and the recorder covers every minute except the gap.
function buildRequests() {
  const rows = [];
  let index = 0;
  for (let at = START; at < END; at += 30_000) {
    index += 1;
    if (at >= GAP_FROM && at < GAP_TO) continue;
    rows.push(genRequest(index, at));
  }
  return rows;
}

function runtimeSample(at, fleetId, step) {
  return {
    at,
    fleetId,
    model: fleetId === "vllm:primary" ? "model-a" : "model-b",
    managerId: fleetId.split(":")[0],
    engineId: fleetId === "vllm:primary" ? "sglang" : "llamacpp",
    runtimeKey: `k_${fleetId}`,
    intervalMs: 10_000,
    scrapeOk: 1,
    idle: step % 10 === 0 ? 1 : 0,
    latencySource: "engine_histogram",
    running: step % 4,
    waiting: step % 3 === 0 ? 1 : 0,
    kvUsage: 0.2 + (step % 10) / 100,
    dPromptTokens: 500,
    dCachedTokens: 100,
    dOutputTokens: 100 + (step % 5),
    dRequests: 1,
    outputTps: 10,
    energyWh: 0.5,
    hist: { ttft: { le: [0.1, 0.5, 1, "+Inf"], d: [2, 5, 6, 6] } },
  };
}

function gpuSample(at, step) {
  return {
    at,
    gpuIndex: 0,
    gpuUuid: "GPU-00000000",
    name: "Test GPU",
    utilPct: 50,
    memUsedMb: 40_000 + (step % 10) * 100,
    memTotalMb: 80_000,
    tempC: 60,
    powerW: 300,
    powerLimitW: 600,
    smClockMhz: 1800,
    energyWh: (300 * 10) / 3600,
    throttle: at < START + 30 * MINUTE_MS ? "sw_power_cap" : "",
  };
}

function buildEvents() {
  return [
    { at: START + 1000, type: "launch.started", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Launch started: model-a", data: { model: "model-a", engineId: "sglang", recipeId: "recipe-one" }, dedupeKey: "e1" },
    { at: START + 61_000, type: "launch.ready", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Launch ready: model-a", data: { model: "model-a", engineId: "sglang", recipeId: "recipe-one", durationMs: 60_000, summary: { contextLength: 262144, kvCacheDtype: "fp8", argv: ["--secret-flag"] } }, dedupeKey: "e2" },
    { at: START + 2 * HOUR_MS, type: "instance.state", severity: "info", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Instance sleeping", data: { state: "sleeping", model: "model-a" }, dedupeKey: "e3" },
    { at: START + 2.5 * HOUR_MS, type: "container.exit", severity: "warning", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_aaaaaaaaaaaaaaaaaaaa", title: "Container exited", data: { exitCode: 137, oomKilled: false }, dedupeKey: "e4" },
    { at: START + 10 * MINUTE_MS, type: "launch.started", severity: "info", source: "llama", managerId: "llama", fleetId: "llama:primary", launchId: "lch_bbbbbbbbbbbbbbbbbbbb", title: "Launch started: model-b", data: { model: "model-b", engineId: "llamacpp" }, dedupeKey: "e5" },
    { at: START + 12 * MINUTE_MS, type: "launch.failed", severity: "warning", source: "llama", managerId: "llama", fleetId: "llama:primary", launchId: "lch_bbbbbbbbbbbbbbbbbbbb", title: "Launch failed: model-b", data: { model: "model-b", engineId: "llamacpp", errorSignature: "oom_weights", phase: "weights" }, dedupeKey: "e6" },
    { at: START + 20 * MINUTE_MS, type: "security.ban", severity: "warning", source: "entry", title: "Client address banned", data: { ip: "203.0.113.9", ipMasked: "203.0.113.x" }, dedupeKey: "e7" },
    { at: START + 30 * MINUTE_MS, type: "alert.firing", severity: "critical", source: "telemetry", requestId: requestId(5), title: "GPU hot", data: { ruleId: "gpu_temp_high" }, dedupeKey: "e8" },
  ];
}

// The dataset once, per test: a store opened in-process, rolled up at NOW,
// and three fresh requests after the roll that only exist as raw rows.
async function seed(t, options = {}) {
  const { dir, file, holder } = tempStore(t);
  const store = await openTelemetryStore({ file, inProcess: true, logger: quietLogger() });
  holder.store = store;
  const requests = buildRequests();
  assert.equal((await store.insertRequests(requests)).rejected, 0);
  const coverage = [];
  for (let bucket = START; bucket < BASE + 7 * HOUR_MS; bucket += MINUTE_MS) {
    if (bucket >= GAP_FROM && bucket < GAP_TO) continue;
    coverage.push({ bucket, component: "recorder" });
  }
  await store.recordCoverage(coverage);
  const runtime = [];
  const gpu = [];
  let step = 0;
  for (let at = START; at < END; at += 10_000) {
    step += 1;
    runtime.push(runtimeSample(at, "vllm:primary", step));
    gpu.push(gpuSample(at, step));
  }
  assert.equal((await store.insertRuntimeSamples(runtime)).rejected, 0);
  assert.equal((await store.insertGpuSamples(gpu)).rejected, 0);
  assert.equal((await store.insertEvents(buildEvents())).rejected, 0);
  await store.runRollups(NOW, { timezoneOffsetMinutes: TZ });
  const fresh = [1, 2, 3].map((n) => genRequest(1000 + n, NOW - 20_000 + n * 1000));
  await store.insertRequests(fresh);
  if (options.liveSamples) {
    await store.insertRuntimeSamples([runtimeSample(NOW - 20_000, "vllm:primary", 3)]);
    await store.insertGpuSamples([gpuSample(NOW - 20_000, 3)]);
  }
  return { store, file, dir, requests, fresh, all: [...requests, ...fresh] };
}

function parse(endpoint, search = "", options = {}) {
  return query.parseQuery(endpoint, new URLSearchParams(search), { now: NOW, tzOffsetMinutes: TZ, ...options });
}

async function run(store, name, endpoint, search = "", options = {}) {
  return store.call(name, parse(endpoint, search, options));
}

function sumPoints(series) {
  return series.points.reduce((sum, [, value]) => sum + (value || 0), 0);
}

function range(from, to) {
  return `from=${from}&to=${to}`;
}

// --- parse ------------------------------------------------------------------

test("parameters are whitelisted: unknown, repeated and malformed ones are 400", () => {
  assert.throws(() => parse("summary", "bogus=1"), (error) => error.code === "unknown_parameter" && error.status === 400);
  assert.throws(() => parse("live", "from=1"), (error) => error.code === "unknown_parameter");
  assert.throws(() => parse("timeseries", "metrics=req.count&sql=drop"), (error) => error.code === "unknown_parameter");
  const repeated = new URLSearchParams();
  repeated.append("from", "2026-10-15T00:00:00Z");
  repeated.append("from", "2026-10-15T01:00:00Z");
  assert.throws(() => query.parseQuery("summary", repeated, { now: NOW }), (error) => error.code === "duplicate_parameter");
  assert.throws(() => parse("timeseries", "metrics=nope"), (error) => error.code === "unknown_metric");
  assert.throws(() => parse("timeseries"), (error) => error.code === "missing_parameter");
  assert.throws(() => parse("timeseries", "metrics=req.count,req.errors,tok.prompt,tok.cached,tok.output,lat.ttft_p50,lat.ttft_p95"), (error) => error.code === "out_of_range");
  assert.throws(() => parse("timeseries", "metrics=req.count&groupBy=gpu"), (error) => error.code === "group_by_not_allowed");
  assert.throws(() => parse("timeseries", "metrics=rt.rpm&groupBy=key"), (error) => error.code === "group_by_not_allowed");
  assert.throws(() => parse("timeseries", "metrics=req.count&groupBy=model%3Bdrop"), (error) => error.code === "group_by_not_allowed");
  assert.throws(() => parse("breakdown", "dim=password"), (error) => error.code === "unknown_dimension");
  assert.throws(() => parse("breakdown", "dim=model&sort=-secret"), (error) => error.code === "unknown_sort");
  assert.throws(() => parse("breakdown", "dim=model&limit=500"), (error) => error.code === "out_of_range");
  assert.throws(() => parse("summary", "status_class=9xx"), (error) => error.code === "invalid_value");
  assert.throws(() => parse("summary", "error_class=made_up"), (error) => error.code === "invalid_value");
  assert.throws(() => parse("requests", "cursor=not-a-cursor"), (error) => error.code === "invalid_cursor");
  assert.throws(() => parse("requests", "limit=0"), (error) => error.code === "out_of_range");
  assert.throws(() => parse("requests", "q=a%20b"), (error) => error.code === "invalid_value");
  assert.throws(() => parse("summary", "from=yesterday"), (error) => error.code === "invalid_value");
  assert.throws(() => parse("summary", "from=2026-10-15T00:00:00Z&to=2026-10-14T00:00:00Z"), (error) => error.code === "invalid_range");
  assert.throws(() => parse("summary", "from=2024-01-01T00:00:00Z"), (error) => error.code === "range_too_large");
  assert.throws(() => parse("export", "kind=secrets"), (error) => error.code === "invalid_value");
  assert.throws(() => parse("export", "kind=rollup&stream=1"), (error) => error.code === "filter_not_available");
  assert.throws(() => parse("summary", "ingress=public&from=2026-01-01T00:00:00Z&to=2026-10-14T00:00:00Z"), (error) => error.code === "range_too_large");
  assert.throws(() => parse("timeseries", "metrics=req.count&stream=1&from=2026-01-01T00:00:00Z&to=2026-10-14T00:00:00Z"), (error) => error.code === "range_too_large");
});

test("times take ISO 8601 or epoch milliseconds and default to the last hour", () => {
  const defaults = parse("summary");
  assert.equal(defaults.to, NOW);
  assert.equal(defaults.from, NOW - HOUR_MS);
  const iso = parse("summary", "from=2026-10-14T02:00:00Z&to=2026-10-14T03:00:00Z");
  const epoch = parse("summary", `from=${START}&to=${START + HOUR_MS}`);
  assert.equal(iso.from, epoch.from);
  assert.equal(iso.to, epoch.to);
  const dateOnly = parse("summary", "from=2026-10-14&to=2026-10-15");
  assert.equal(dateOnly.from, BASE);
  assert.equal(dateOnly.to - dateOnly.from, DAY_MS);
});

// --- source and step -----------------------------------------------------------

test("the step is the smallest nice step under 600 points and the source follows it", async (t) => {
  const { store } = await seed(t);
  const cases = [
    // [range ms, expected step seconds, expected source]
    [HOUR_MS, 10, "requests"],
    [2 * HOUR_MS, 30, "requests"],
    [6 * HOUR_MS, 60, "rollup_1m"],
    [24 * HOUR_MS, 300, "rollup_1m"],
    [7 * DAY_MS, 1800, "rollup_1m"],
    [30 * DAY_MS, 10_800, "rollup_1h"],
    [400 * DAY_MS, 86_400, "rollup_1d"],
  ];
  for (const [span, step, source] of cases) {
    const result = await run(store, "timeseries", "timeseries", `metrics=req.count&${range(NOW - span, NOW)}`);
    assert.equal(result.step, step, `step for ${span / HOUR_MS} h`);
    assert.equal(result.source, source, `source for ${span / HOUR_MS} h`);
    for (const series of result.series) assert.ok(series.points.length <= 600, `${series.points.length} points`);
    assert.equal(result.series[0].points.length, Math.ceil((NOW - (Math.floor((NOW - span + TZ * MINUTE_MS) / (step * 1000)) * step * 1000 - TZ * MINUTE_MS)) / (step * 1000)));
  }
  // An explicit step is raised to keep 600 points, and old data coarsens to hours.
  const tiny = await run(store, "timeseries", "timeseries", `metrics=req.count&step=1&${range(NOW - 7 * DAY_MS, NOW)}`);
  assert.ok(tiny.step >= 1008);
  assert.ok(tiny.series[0].points.length <= 600);
  const old = await run(store, "timeseries", "timeseries", `metrics=req.count&step=300&${range(NOW - 20 * DAY_MS, NOW)}`);
  assert.equal(old.step % 3600, 0);
});

test("every series has at most 600 points whatever the range and step", async (t) => {
  const { store } = await seed(t);
  for (const span of [HOUR_MS + 1, 3 * HOUR_MS, 5 * DAY_MS + 12345, 90 * DAY_MS, 399 * DAY_MS]) {
    for (const stepSec of [null, 1, 7, 61, 3600]) {
      const search = `metrics=req.count,rt.output_tps,gpu.util&${range(NOW - span, NOW)}${stepSec ? `&step=${stepSec}` : ""}`;
      const result = await run(store, "timeseries", "timeseries", search);
      for (const series of result.series) assert.ok(series.points.length <= 600, `span ${span} step ${stepSec}: ${series.points.length}`);
    }
  }
});

// --- tiered reads agree with raw rows -----------------------------------------------

test("totals agree between raw rows, rollups and the live tail whatever the range is cut at", async (t) => {
  const { store, file, all } = await seed(t);
  const expected = withDb(file, (db) => db.prepare("SELECT COUNT(*) AS n, SUM(prompt_tokens) AS p, SUM(output_tokens) AS o, SUM(CASE WHEN error_class NOT IN ('none','client_abort') THEN 1 ELSE 0 END) AS e FROM requests").get());
  assert.equal(expected.n, all.length);
  const cuts = [BASE, BASE + 90 * MINUTE_MS + 17_000, BASE + 2 * HOUR_MS + 1, BASE + 5 * HOUR_MS + 12 * MINUTE_MS];
  for (const from of cuts) {
    const summary = await run(store, "summary", "summary", `${range(from, NOW)}&compare=none`);
    const direct = withDb(file, (db) => db.prepare("SELECT COUNT(*) AS n, SUM(prompt_tokens) AS p, SUM(output_tokens) AS o, SUM(CASE WHEN error_class NOT IN ('none','client_abort') THEN 1 ELSE 0 END) AS e FROM requests WHERE received_at >= ? AND received_at < ?").get(from, NOW));
    assert.equal(summary.current.requests, direct.n, `requests from ${new Date(from).toISOString()}`);
    assert.equal(summary.current.promptTokens, direct.p);
    assert.equal(summary.current.outputTokens, direct.o);
    assert.equal(summary.current.errorRate, Math.round((direct.e / direct.n) * 1e4) / 1e4);
  }
  const whole = await run(store, "summary", "summary", `${range(BASE, NOW)}`);
  assert.equal(whole.source, "rollup_1d");
  assert.equal(whole.current.requests, all.length);
  assert.equal(whole.current.activeKeys, 3);
  assert.equal(whole.previous.requests, 0);
  // The default (last hour) holds the three fresh requests, which are not rolled up yet.
  const lastHour = await run(store, "summary", "summary", "");
  assert.equal(lastHour.current.requests, 3);
  assert.equal(lastHour.source, "rollup_1m", "closed minutes come from rollups, the unclosed tail from rows");
});

test("a series sums to the same total at every step and source", async (t) => {
  const { store, all } = await seed(t);
  for (const step of [60, 300, 3600, 86_400]) {
    const result = await run(store, "timeseries", "timeseries", `metrics=req.count&step=${step}&${range(BASE, NOW)}`);
    assert.equal(sumPoints(result.series[0]), all.length, `step ${step}`);
  }
  const raw = await run(store, "timeseries", "timeseries", `metrics=req.count&${range(START, START + 2 * HOUR_MS)}`);
  assert.equal(raw.source, "requests");
  const expected = all.filter((row) => row.receivedAt >= START && row.receivedAt < START + 2 * HOUR_MS).length;
  assert.equal(sumPoints(raw.series[0]), expected);
});

test("request counts are 0 where the recorder covered a bucket and null in a collection gap", async (t) => {
  const { store } = await seed(t);
  const result = await run(store, "timeseries", "timeseries", `metrics=req.count,req.error_rate&step=3600&${range(BASE + HOUR_MS, BASE + 8 * HOUR_MS)}`);
  const count = result.series.find((series) => series.metric === "req.count");
  const rate = result.series.find((series) => series.metric === "req.error_rate");
  const valueAt = (series, hourOffset) => series.points.find(([at]) => at === BASE + hourOffset * HOUR_MS)[1];
  assert.equal(valueAt(count, 1), null, "01:00 is before any coverage");
  assert.ok(valueAt(count, 2) > 0, "02:00 has traffic");
  assert.equal(valueAt(count, 3), null, "03:00 is the gap");
  assert.ok(valueAt(count, 4) > 0);
  assert.equal(valueAt(count, 6), 0, "06:00 is covered with no traffic");
  assert.equal(valueAt(rate, 6), null, "a ratio without requests is null, not 0");
  assert.equal(valueAt(count, 7), null, "07:00 is not covered");
});

test("groupBy keeps the top groups and folds the rest into other", async (t) => {
  const { store, all } = await seed(t);
  const result = await run(store, "timeseries", "timeseries", `metrics=req.count&groupBy=model&top=2&step=3600&${range(BASE, NOW)}`);
  assert.equal(result.series.length, 3);
  assert.equal(result.otherGroups, 2);
  assert.deepEqual(result.series[2].group, { other: true });
  assert.ok(result.series[0].group.model && result.series[1].group.model);
  assert.equal(result.series.reduce((sum, series) => sum + sumPoints(series), 0), all.length);
  const wide = await run(store, "timeseries", "timeseries", `metrics=req.count&groupBy=model&top=8&step=3600&${range(BASE, NOW)}`);
  assert.equal(wide.series.length, 4);
  assert.equal(wide.otherGroups, 0);
  assert.ok(wide.series.every((series) => series.group.model));
});

test("filters narrow every source and values are bound, never interpolated", async (t) => {
  const { store, all } = await seed(t);
  const only = await run(store, "summary", "summary", `${range(BASE, NOW)}&model=model-a&compare=none`);
  assert.equal(only.current.requests, all.filter((row) => row.modelResolved === "model-a").length);
  const two = await run(store, "summary", "summary", `${range(BASE, NOW)}&model=model-a,model-b&error_class=upstream_5xx&compare=none`);
  assert.equal(two.current.requests, all.filter((row) => ["model-a", "model-b"].includes(row.modelResolved) && row.errorClass === "upstream_5xx").length);
  const status = await run(store, "summary", "summary", `${range(BASE, NOW)}&status_class=5xx&compare=none`);
  assert.equal(status.current.requests, all.filter((row) => row.status >= 500).length);
  const injected = await run(store, "summary", "summary", `${range(BASE, NOW)}&model=${encodeURIComponent("x' OR 1=1 --")}&compare=none`);
  assert.equal(injected.current.requests, 0);
  // ingress reads the request rows (it is not a rollup dimension).
  const ingress = await run(store, "timeseries", "timeseries", `metrics=req.count&ingress=public&${range(START, END)}`);
  assert.equal(ingress.source, "requests");
  assert.equal(sumPoints(ingress.series[0]), all.filter((row) => row.ingress === "public" && row.receivedAt >= START && row.receivedAt < END).length);
  const streams = await run(store, "summary", "summary", `${range(BASE, NOW)}&stream=1&compare=none`);
  assert.equal(streams.current.requests, all.filter((row) => row.stream).length);
});

test("latency percentiles come from merged histograms and the heatmap carries its bounds", async (t) => {
  const { store, all } = await seed(t);
  const result = await run(store, "timeseries", "timeseries", `metrics=lat.ttft_p95,lat.duration_p50,lat.decode_tps_p50,lat.ttft_hist&step=3600&${range(START, END)}`);
  const p95 = result.series.find((series) => series.metric === "lat.ttft_p95");
  assert.ok(p95.points.some(([, value]) => value > 100 && value < 1200));
  const heat = result.series.find((series) => series.metric === "lat.ttft_hist");
  const first = heat.points.find(([, value]) => Array.isArray(value));
  assert.equal(first[1].length, GATEWAY_MS_BUCKETS.length);
  assert.deepEqual(result.le, GATEWAY_MS_BUCKETS);
  const total = heat.points.reduce((sum, [, value]) => sum + (value ? value.reduce((a, b) => a + b, 0) : 0), 0);
  assert.equal(total, all.filter((row) => row.ttftMs !== null && row.ttftMs !== undefined && row.receivedAt >= START && row.receivedAt < END).length);
  const duration = result.series.find((series) => series.metric === "lat.duration_p50");
  assert.ok(duration.points.some(([, value]) => value > 500 && value <= 1000));
});

// --- runtime and gpu -------------------------------------------------------------

test("runtime and gpu metrics aggregate gauges, rates and ratios from sums", async (t) => {
  const { store } = await seed(t);
  const result = await run(store, "timeseries", "timeseries", `metrics=rt.output_tps,rt.kv_usage,rt.prefix_hit,rt.ttft_p95,rt.idle_share&step=3600&${range(START, END)}`);
  const gpuResult = await run(store, "timeseries", "timeseries", `metrics=gpu.util,gpu.mem_used_pct,gpu.power_ratio,gpu.energy_wh,gpu.sm_clock_mhz&step=3600&${range(START, END)}`);
  const by = (metric) => (result.series.find((series) => series.metric === metric) || gpuResult.series.find((series) => series.metric === metric));
  const mid = (metric) => by(metric).points.find(([, value]) => value !== null)[1];
  assert.ok(Math.abs(mid("rt.output_tps") - 10.2) < 0.5, `output tps ${mid("rt.output_tps")}`);
  assert.equal(mid("rt.prefix_hit"), 0.2);
  assert.ok(mid("rt.kv_usage") > 0.2 && mid("rt.kv_usage") < 0.3);
  assert.equal(mid("rt.idle_share"), 0.1);
  assert.ok(mid("rt.ttft_p95") > 100 && mid("rt.ttft_p95") <= 1000, "seconds from the engine histogram become milliseconds");
  assert.equal(mid("gpu.util"), 50);
  assert.ok(mid("gpu.mem_used_pct") > 50 && mid("gpu.mem_used_pct") < 52);
  assert.equal(mid("gpu.power_ratio"), 0.5);
  const energy = by("gpu.energy_wh").points.reduce((sum, [, value]) => sum + (value || 0), 0);
  const samples = (END - START) / 10_000;
  assert.ok(Math.abs(energy - samples * (300 * 10 / 3600)) < 0.01, `energy ${energy}`);
  // Raw samples (short range) and rollups agree.
  const raw = await run(store, "timeseries", "timeseries", `metrics=gpu.energy_wh,gpu.power_ratio,gpu.sm_clock_mhz&${range(START, START + HOUR_MS)}`);
  assert.equal(raw.source, "gpu_samples");
  assert.equal(raw.series.find((series) => series.metric === "gpu.sm_clock_mhz").points.find(([, value]) => value !== null)[1], 1800);
  assert.equal(raw.series.find((series) => series.metric === "gpu.power_ratio").points.find(([, value]) => value !== null)[1], 0.5);
  const hour = await run(store, "timeseries", "timeseries", `metrics=gpu.energy_wh&step=3600&${range(START, START + HOUR_MS)}`);
  assert.ok(Math.abs(sumPoints(raw.series[0]) - sumPoints(hour.series[0])) < 0.01);
  const grouped = await run(store, "timeseries", "timeseries", `metrics=rt.rpm&groupBy=fleet&step=3600&${range(START, END)}`);
  assert.equal(grouped.series.length, 1);
  assert.deepEqual(grouped.series[0].group, { fleet: "vllm:primary" });
});

test("throttle seconds split by reason and energy cost follows the current tariff", async (t) => {
  const { store } = await seed(t);
  const throttle = await run(store, "timeseries", "timeseries", `metrics=gpu.throttle_seconds&step=3600&${range(START, END)}`);
  assert.deepEqual(throttle.series.map((series) => series.group), [{ reason: "sw_power_cap" }]);
  assert.ok(Math.abs(sumPoints(throttle.series[0]) - 30 * 60) < 30, `${sumPoints(throttle.series[0])} s`);
  const energy = { pricePerKwh: 0.6, currency: "CNY", tariffs: [{ from: "00:00", to: "12:00", pricePerKwh: 0.5 }], hostBaselineWatts: 0 };
  const cost = await run(store, "timeseries", "timeseries", `metrics=energy.cost,gpu.energy_wh&step=3600&${range(START, END)}`, { energy });
  const wh = sumPoints(cost.series.find((series) => series.metric === "gpu.energy_wh"));
  const paid = sumPoints(cost.series.find((series) => series.metric === "energy.cost"));
  // 10:00-12:00 local at the 0.5 window, 12:00-13:30 at the 0.6 base price.
  assert.ok(Math.abs(paid - (0.3 + 0.27)) < 0.002, `cost ${paid} for ${wh} Wh`);
  const unpriced = await run(store, "timeseries", "timeseries", `metrics=energy.cost&step=3600&${range(START, END)}`);
  assert.ok(unpriced.series[0].points.every(([, value]) => value === null));
});

test("annotations come from lifecycle events inside the range", async (t) => {
  const { store } = await seed(t);
  const result = await run(store, "timeseries", "timeseries", `metrics=req.count&annotate=launch,container,alert&step=3600&${range(START, END)}`);
  const types = new Set(result.annotations.map((item) => item.type));
  assert.ok(types.has("launch.ready") && types.has("container.exit") && types.has("alert.firing"));
  assert.ok(!types.has("security.ban"));
  assert.ok(result.annotations.every((item) => item.eventId && item.title && item.at));
  const filtered = await run(store, "timeseries", "timeseries", `metrics=req.count&annotate=launch&fleet_id=llama:primary&step=3600&${range(START, END)}`);
  assert.ok(filtered.annotations.length >= 1 && filtered.annotations.every((item) => item.fleetId === "llama:primary"));
});

// --- breakdown -------------------------------------------------------------------

test("breakdown groups with shares, samples, sparklines and labels", async (t) => {
  const { store, all } = await seed(t);
  const result = await run(store, "breakdown", "breakdown", `dim=error_class&spark=1&${range(BASE, NOW)}`);
  assert.equal(result.dim, "error_class");
  assert.equal(result.total.requests, all.length);
  assert.equal(result.rows.reduce((sum, row) => sum + row.requests, 0), all.length);
  assert.ok(Math.abs(result.rows.reduce((sum, row) => sum + row.share, 0) - 1) < 0.01);
  const upstream = result.rows.find((row) => row.key === "upstream_5xx");
  assert.deepEqual(upstream.label, { zh: "上游报错", en: "Upstream error" });
  assert.equal(upstream.requests, all.filter((row) => row.errorClass === "upstream_5xx").length);
  assert.equal(upstream.errorRate, 1);
  assert.equal(upstream.sampleRequestIds.length, 3);
  assert.ok(upstream.sampleRequestIds.every((id) => all.some((row) => row.requestId === id && row.errorClass === "upstream_5xx")));
  assert.equal(upstream.spark.length, 24);
  assert.equal(upstream.spark.reduce((a, b) => a + b, 0), upstream.requests);
  assert.deepEqual(Object.keys(upstream).filter((key) => ["ttftP95Ms", "durationP95Ms", "decodeTpsP50", "promptTokens", "cachedTokens", "outputTokens"].includes(key)).length, 6);
  const sorted = await run(store, "breakdown", "breakdown", `dim=model&sort=requests&limit=2&${range(BASE, NOW)}`);
  assert.equal(sorted.rows.length, 2);
  assert.ok(sorted.rows[0].requests <= sorted.rows[1].requests, "no minus prefix sorts ascending");
  const programs = await run(store, "breakdown", "breakdown", `dim=source&${range(BASE, NOW)}`);
  assert.deepEqual(programs.rows.find((row) => row.key === "openwebui").label, { zh: "OpenWebUI", en: "OpenWebUI" });
  const ips = await run(store, "breakdown", "breakdown", `dim=client_ip&${range(START, END)}`);
  assert.deepEqual(ips.rows.map((row) => row.key).sort(), ["192.0.2.10", "198.51.100.7"]);
});

// --- requests ----------------------------------------------------------------------

test("keyset pagination is stable with equal timestamps and a consistent total order", async (t) => {
  const { store } = await seed(t);
  const stamp = NOW - 10 * MINUTE_MS;
  const batch = [];
  for (let index = 0; index < 12; index += 1) batch.push({ ...genRequest(2000 + index, stamp), requestId: requestId(2000 + index) });
  await store.insertRequests(batch);
  const window = `from=${stamp - 1}&to=${stamp + 1}`;
  const pages = [];
  let cursor = "";
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await run(store, "listRequests", "requests", `${window}&limit=5${cursor ? `&cursor=${cursor}` : ""}`);
    pages.push(...page.rows.map((row) => row.requestId));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages.length, 12);
  assert.equal(new Set(pages).size, 12, "no row twice");
  const direct = await run(store, "listRequests", "requests", `${window}&limit=500`);
  assert.deepEqual(pages, direct.rows.map((row) => row.requestId));
  assert.equal(direct.nextCursor, null);
  // New rows after the first page do not disturb the pages that follow.
  const first = await run(store, "listRequests", "requests", `${window}&limit=5`);
  await store.insertRequests([{ ...genRequest(3000, stamp + 500), requestId: requestId(3000) }]);
  const second = await run(store, "listRequests", "requests", `${window}&limit=5&cursor=${first.nextCursor}`);
  assert.deepEqual(second.rows.map((row) => row.requestId), pages.slice(5, 10));
  assert.ok(first.rows.every((row) => typeof row.receivedAt === "string" && row.receivedAt.endsWith("Z")));
  assert.equal(typeof first.rows[0].extra, "object");
  assert.equal(typeof first.rows[0].stream, "boolean");
});

test("the request list filters, searches by id prefix and returns facets", async (t) => {
  const { store, all } = await seed(t);
  const failed = await run(store, "listRequests", "requests", `${range(BASE, NOW)}&terminal_state=failed&limit=500&facets=1`);
  assert.equal(failed.rows.length, all.filter((row) => row.terminalState === "failed").length);
  assert.ok(failed.rows.every((row) => row.terminalState === "failed"));
  assert.deepEqual(Object.keys(failed.facets), ["status_class", "error_class", "model", "source_program"]);
  assert.equal(failed.facets.error_class.upstream_5xx, failed.rows.length);
  assert.equal(failed.facetsTruncated, undefined);
  const slow = await run(store, "listRequests", "requests", `${range(BASE, NOW)}&min_ttft_ms=1000&limit=500`);
  assert.ok(slow.rows.length > 0 && slow.rows.every((row) => row.ttftMs >= 1000));
  const target = all[10];
  const byPrefix = await run(store, "listRequests", "requests", `q=${target.requestId.slice(0, 23)}`);
  assert.ok(byPrefix.rows.some((row) => row.requestId === target.requestId), "an id search ignores the default last-hour window");
  const byManager = await run(store, "listRequests", "requests", `q=${target.managerRequestId}`);
  assert.equal(byManager.rows[0].requestId, target.requestId);
  const byIp = await run(store, "listRequests", "requests", `${range(BASE, NOW)}&client_ip=198.51.100.7&limit=1`);
  assert.equal(byIp.rows[0].clientIp, "198.51.100.7");
});

test("request detail has the timeline, the launch summary without argv, and nearby events", async (t) => {
  const { store, all } = await seed(t);
  const row = all.find((item) => item.fleetId === "vllm:primary" && item.receivedAt > START + 5 * MINUTE_MS && item.status === 200);
  const detail = await store.call("getRequest", { requestId: row.requestId });
  assert.equal(detail.request.requestId, row.requestId);
  assert.deepEqual(detail.timeline.map((mark) => mark.mark), ["received", "dispatched", "headers", "first_token", "done"]);
  assert.deepEqual(detail.timeline.slice(1).map((mark) => mark.offsetMs), [3, 140, row.ttftMs, 800]);
  assert.equal(detail.instance.fleetId, "vllm:primary");
  assert.equal(detail.instance.recipeId, "recipe-one");
  assert.deepEqual(detail.instance.launch.summary, { contextLength: 262144, kvCacheDtype: "fp8" });
  assert.equal(JSON.stringify(detail).includes("secret-flag"), false);
  assert.ok(detail.instance.nearestSample.at.endsWith("Z"));
  const withEvent = await store.call("getRequest", { requestId: requestId(5) });
  assert.equal(withEvent.events.some((event) => event.type === "alert.firing"), true, "an event with the request id is listed");
  const nearby = await store.call("getRequest", { requestId: all.find((item) => item.fleetId === "vllm:primary" && item.receivedAt > START + 59_000 && item.receivedAt < START + 63_000).requestId });
  assert.ok(nearby.events.some((event) => event.type === "launch.ready"), "an event of the same fleet within a minute is listed");
  const byManagerId = await store.call("getRequest", { requestId: row.managerRequestId });
  assert.equal(byManagerId.request.requestId, row.requestId);
  await assert.rejects(() => store.call("getRequest", { requestId: "req_missing" }), (error) => error.code === "request_not_found");
});

// --- events, lifecycle, launches, baseline, live ------------------------------------

test("events list by type prefix with a keyset cursor", async (t) => {
  const { store } = await seed(t);
  const launches = await run(store, "listEvents", "events", `type=launch.&${range(START, END)}`);
  assert.equal(launches.rows.length, 4);
  assert.ok(launches.rows.every((row) => row.type.startsWith("launch.")));
  assert.ok(launches.rows[0].at >= launches.rows[1].at, "newest first");
  const both = await run(store, "listEvents", "events", `type=launch.,alert.&severity=critical,warning&${range(START, END)}`);
  assert.deepEqual(new Set(both.rows.map((row) => row.type)), new Set(["launch.failed", "alert.firing"]));
  const pages = [];
  let cursor = "";
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await run(store, "listEvents", "events", `${range(START, END)}&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    pages.push(...page.rows.map((row) => row.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages.length, 8);
  assert.equal(new Set(pages).size, 8);
  const fleet = await run(store, "listEvents", "events", `fleet_id=llama:primary&${range(START, END)}`);
  assert.deepEqual(fleet.rows.map((row) => row.type), ["launch.failed", "launch.started"]);
  assert.equal(fleet.rows[0].data.errorSignature, "oom_weights");
  assert.throws(() => parse("events", "type=Launch%20X"), (error) => error.code === "invalid_value");
});

test("lifecycle turns launch, state and container events into intervals", async (t) => {
  const { store } = await seed(t);
  const result = await run(store, "lifecycle", "lifecycle", range(START, END));
  const vllm = result.instances.find((item) => item.fleetId === "vllm:primary");
  assert.equal(vllm.model, "model-a");
  assert.equal(vllm.engineId, "sglang");
  assert.deepEqual(vllm.intervals.map((item) => item.state), ["loading", "ready", "sleeping", "crashed"]);
  assert.equal(vllm.intervals[0].from, new Date(START + 1000).toISOString());
  assert.equal(vllm.intervals[0].to, new Date(START + 61_000).toISOString());
  assert.equal(vllm.intervals[1].launchId, "lch_aaaaaaaaaaaaaaaaaaaa");
  assert.equal(vllm.intervals[3].to, new Date(END).toISOString(), "an open interval ends at the range end");
  const llama = result.instances.find((item) => item.fleetId === "llama:primary");
  assert.deepEqual(llama.intervals.map((item) => item.state), ["loading", "crashed"]);
  // A range that starts inside an interval is seeded from the last earlier event.
  const later = await run(store, "lifecycle", "lifecycle", range(START + 10 * MINUTE_MS, START + 20 * MINUTE_MS));
  const seeded = later.instances.find((item) => item.fleetId === "vllm:primary");
  assert.equal(seeded.intervals[0].state, "ready");
  assert.equal(seeded.intervals[0].from, new Date(START + 10 * MINUTE_MS).toISOString());
});

test("launches count per model with ready durations and top failures", async (t) => {
  const { store } = await seed(t);
  const byModel = await run(store, "launches", "launches", `${range(START, END)}`);
  const a = byModel.rows.find((row) => row.key === "model-a");
  assert.deepEqual([a.started, a.ready, a.failed, a.readyP50Seconds, a.readyP95Seconds], [1, 1, 0, 60, 60]);
  const b = byModel.rows.find((row) => row.key === "model-b");
  assert.deepEqual([b.started, b.ready, b.failed], [1, 0, 1]);
  assert.deepEqual(b.topFailures, [{ signature: "oom_weights", count: 1 }]);
  const byRecipe = await run(store, "launches", "launches", `groupBy=recipe&${range(START, END)}`);
  assert.ok(byRecipe.rows.some((row) => row.key === "recipe-one"));
  assert.ok(byRecipe.rows.some((row) => row.key === "unknown"));
  const byEngine = await run(store, "launches", "launches", `groupBy=engine&${range(START, END)}`);
  assert.deepEqual(byEngine.rows.map((row) => row.key).sort(), ["llamacpp", "sglang"]);
});

test("energy groups by hour, day, gpu, fleet and model and prices at the current tariff", async (t) => {
  const { store } = await seed(t);
  const energy = { pricePerKwh: 1, currency: "USD", tariffs: [], hostBaselineWatts: 100 };
  const hours = await run(store, "energy", "energy", `groupBy=hour&${range(START, END)}`, { energy });
  assert.deepEqual(hours.rows.map((row) => row.key.slice(11, 13)), ["02", "03", "04", "05"]);
  const wh = hours.rows.reduce((sum, row) => sum + row.energyWh, 0);
  assert.ok(Math.abs(wh - ((END - START) / 10_000) * (300 * 10 / 3600)) < 0.05);
  assert.equal(hours.totals.hostBaselineWh, 100 * ((END - START) / HOUR_MS));
  assert.ok(Math.abs(hours.totals.cost - wh / 1000) < 0.001);
  assert.equal(hours.currency, "USD");
  assert.equal(hours.tariffApplied, "current");
  assert.equal(hours.priceConfigured, true);
  assert.deepEqual(hours.rows.map((row) => row.outputTokens !== null), [true, false, true, true], "output tokens come from the same hours; the gap hour has none");
  const days = await run(store, "energy", "energy", `groupBy=day&${range(BASE, NOW)}`, { energy });
  assert.deepEqual(days.rows.map((row) => row.key), ["2026-10-14"]);
  const gpus = await run(store, "energy", "energy", `groupBy=gpu&${range(BASE, NOW)}`);
  assert.deepEqual(gpus.rows.map((row) => row.key), ["0"]);
  assert.equal(gpus.priceConfigured, false);
  assert.equal(gpus.rows[0].cost, null);
  assert.equal(gpus.rows[0].costPerMOutputTokens, null);
  const fleets = await run(store, "energy", "energy", `groupBy=fleet&${range(BASE, NOW)}`, { energy });
  assert.deepEqual(fleets.rows.map((row) => row.key), ["vllm:primary"]);
  assert.ok(fleets.rows[0].energyWh > 0 && fleets.rows[0].idleWh > 0 && fleets.rows[0].idleWh < fleets.rows[0].energyWh);
  assert.ok(fleets.rows[0].costPerMOutputTokens > 0);
});

test("baseline and live snapshots read imported counters and the latest samples", async (t) => {
  const { store, file } = await seed(t, { liveSamples: true });
  // lifetime_baseline is written by the importers; a second connection stands in.
  const db = new sqlite.DatabaseSync(file);
  db.prepare("INSERT INTO lifetime_baseline (manager_id, model, engine, first_seen, last_seen, prompt_tokens, cached_tokens, output_tokens, requests, errors, source, imported_at) VALUES ('vllm', 'model-a', 'sglang', ?, ?, 1000, 100, 500, 12, 1, 'stats-ledger', ?)").run(BASE, BASE + HOUR_MS, NOW);
  db.close();
  const baseline = await store.call("baseline", {});
  assert.deepEqual(baseline.rows, [{ managerId: "vllm", model: "model-a", firstSeen: new Date(BASE).toISOString(), lastSeen: new Date(BASE + HOUR_MS).toISOString(), promptTokens: 1000, outputTokens: 500, requests: 12, source: "stats-ledger" }]);
  const live = await store.call("live", { now: NOW, inflight: 2, collectors: { recorder: "ok", gpu: "degraded" } });
  assert.equal(live.ok, true);
  assert.equal(live.windowSeconds, 60);
  assert.equal(live.gateway.inflight, 2);
  assert.equal(live.gateway.requestsPerMin, 3);
  assert.equal(live.gateway.errorRate5m, 0);
  assert.equal(live.instances.length, 1);
  assert.equal(live.instances[0].fleetId, "vllm:primary");
  assert.equal(live.instances[0].state, "sleeping");
  assert.equal(live.gpus[0].throttle.length, 0);
  assert.equal(live.gpus[0].powerLimitW, 600);
  assert.deepEqual(live.alerts, { firing: 0, critical: 0 });
  assert.equal(live.collectors.gpu, "degraded");
  assert.equal(live.collectors.store, "ok");
});

// --- export and limits --------------------------------------------------------------

test("export pages oldest first, keeps the keyset, and stops at the cap", async (t) => {
  const { store, all } = await seed(t);
  const q = parse("export", `kind=requests&${range(BASE, NOW)}`, { exportMaxRows: 1000 });
  assert.equal((await store.call("exportCount", q)).total, all.length);
  assert.equal(q.maxRows, 1000);
  const ids = [];
  let after = null;
  let columns = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await store.call("exportPage", { ...q, after, pageRows: 100 });
    columns = page.columns;
    ids.push(...page.rows.map((row) => row[columns.indexOf("requestId")]));
    if (!page.next) break;
    after = page.next;
  }
  assert.equal(ids.length, all.length);
  assert.deepEqual(ids, all.slice().sort((a, b) => a.receivedAt - b.receivedAt).map((row) => row.requestId));
  assert.ok(columns.includes("receivedAt") && columns.includes("clientIp"));
  const rollup = parse("export", `kind=rollup&grain=1m&${range(START, END)}`);
  const first = await store.call("exportPage", { ...rollup, pageRows: 50 });
  assert.equal(first.rows.length, 50);
  assert.equal(first.columns[0], "bucket");
  const second = await store.call("exportPage", { ...rollup, after: first.next, pageRows: 50 });
  assert.notDeepEqual(second.rows[0], first.rows[0]);
  const events = await store.call("exportPage", { ...parse("export", `kind=events&${range(START, END)}`), pageRows: 100 });
  assert.equal(events.rows.length, 8);
});

test("a query that runs out of budget is stopped with query_timeout", async (t) => {
  const { store } = await seed(t);
  await assert.rejects(() => run(store, "timeseries", "timeseries", `metrics=req.count&${range(BASE, NOW)}`, { budgetMs: -1 }), (error) => error.code === "query_timeout");
  await assert.rejects(() => run(store, "listRequests", "requests", range(BASE, NOW), { budgetMs: -1 }), (error) => error.code === "query_timeout");
  const fine = await run(store, "summary", "summary", range(BASE, NOW));
  assert.ok(fine.current.requests > 0);
});

test("only the query module's own function exports are callable by name", async (t) => {
  const { store } = await seed(t);
  for (const name of ["METRICS", "constructor", "__proto__", "toString", "Drop", "x; DROP TABLE requests", "QueryError"]) {
    await assert.rejects(() => store.call(name, {}), (error) => error.code === "unknown_query", name);
  }
});
