"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");
const rollups = require("../telemetry/rollups");
const schema = require("../telemetry/schema");
const storeWorker = require("../telemetry/store-worker");
const { openTelemetryStore, STORE_WORKER } = require("../telemetry/store");
const { GATEWAY_MS_BUCKETS, newHist, observe, quantile } = require("../telemetry/histogram");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TZ = 480;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// Order of every rollup table's primary key, for row-by-row comparisons.
const ROLLUP_ORDER = Object.freeze({
  rollup_1m: "bucket, manager_id, fleet_id, engine_id, model, key_id, customer_id, source_program, protocol, status_class, error_class, source",
  rollup_1h: "bucket, manager_id, fleet_id, engine_id, model, key_id, customer_id, source_program, protocol, status_class, error_class, source",
  rollup_1d: "bucket, manager_id, fleet_id, engine_id, model, key_id, customer_id, source_program, protocol, status_class, error_class, source",
  runtime_rollup_1m: "bucket, fleet_id, model",
  runtime_rollup_1h: "bucket, fleet_id, model",
  runtime_rollup_1d: "bucket, fleet_id, model",
  gpu_rollup_1m: "bucket, gpu_index",
  gpu_rollup_1h: "bucket, gpu_index",
  gpu_rollup_1d: "bucket, gpu_index",
});

const cleanups = new WeakMap();

// Windows keeps an open database file locked, so every store a test opens is
// closed before its temp folder is removed.
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-rollups-"));
  const tasks = [];
  cleanups.set(t, tasks);
  t.after(async () => {
    for (const task of tasks.reverse()) {
      try { await task(); } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return dir;
}

function cleanup(t, task) {
  cleanups.get(t).push(task);
}

function quietLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push({ level, message });
  return { lines, log: push("log"), warn: push("warn"), error: push("error") };
}

async function openStore(t, file, options = {}) {
  const store = await openTelemetryStore({ file, inProcess: true, logger: quietLogger(), retention: { yieldMs: 1 }, ...options });
  cleanup(t, () => store.close());
  return store;
}

function withDb(file, operation, options = {}) {
  const db = new sqlite.DatabaseSync(file, options);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function readDb(file, operation) {
  return withDb(file, operation, { readOnly: true });
}

function plain(rows) {
  return rows.map((row) => ({ ...row }));
}

function snapshot(file) {
  return readDb(file, (db) => Object.fromEntries(Object.entries(ROLLUP_ORDER)
    .map(([table, order]) => [table, plain(db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all())])));
}

function requestTotal(file, table, where = "1 = 1", ...params) {
  return readDb(file, (db) => Number(db.prepare(`SELECT COALESCE(SUM(requests), 0) AS n FROM ${table}
    WHERE source <> 'coverage' AND ${where}`).get(...params).n));
}

function dirtyRows(file) {
  return readDb(file, (db) => plain(db.prepare("SELECT grain, bucket FROM rollup_dirty ORDER BY grain, bucket").all()));
}

function insertCoverage(file, buckets, component = "recorder") {
  withDb(file, (db) => {
    const insert = db.prepare("INSERT OR IGNORE INTO coverage_1m (bucket, component) VALUES (?, ?)");
    for (const bucket of buckets) insert.run(bucket, component);
  });
}

function requestId(index) {
  let value = index;
  let text = "";
  for (let position = 0; position < 20; position += 1) {
    text = BASE32[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `req_${text}`;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function simpleRequest(index, receivedAt, overrides = {}) {
  return {
    requestId: requestId(index),
    ingress: "entry",
    receivedAt,
    endedAt: receivedAt + 100,
    protocol: "openai",
    op: "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelResolved: "model-a",
    status: 200,
    terminalState: "completed",
    errorClass: "none",
    durationMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------- dataset

// 22:00 to 02:30 local (+08:00): the window crosses local midnight at 16:00Z.
const START = Date.UTC(2026, 9, 13, 14, 0, 0);
const END = Date.UTC(2026, 9, 13, 18, 30, 0);
// 00:30 local two days later: both local days of the window are closed.
const FINAL = Date.UTC(2026, 9, 14, 16, 30, 0);
const STATUSES = [200, 200, 200, 200, 200, 429, 500, 499];
const OUTCOMES = {
  200: ["completed", "none"],
  429: ["rejected", "rate_limited"],
  500: ["failed", "upstream_5xx"],
  499: ["client_abort", "client_abort"],
};

function datasetRequest(index, receivedAt) {
  const status = STATUSES[index % STATUSES.length];
  const [terminalState, errorClass] = OUTCOMES[status];
  const stream = index % 3 !== 0;
  const ok = status === 200;
  return {
    requestId: requestId(index),
    ingress: index % 41 === 0 ? "import:entry" : "entry",
    receivedAt,
    endedAt: receivedAt + 500 + (index % 900),
    managerId: index % 2 ? "vllm" : "llama",
    fleetId: index % 2 ? "vllm:primary" : "llama:primary",
    engineId: index % 2 ? "sglang" : "llamacpp",
    protocol: index % 4 === 0 ? "claude" : "openai",
    op: index % 4 === 0 ? "messages" : "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelRequested: "auto",
    modelResolved: index % 9 === 0 ? null : `model-${index % 3}`,
    stream,
    keyId: index % 5 === 0 ? null : `k_${index % 2}`,
    customerId: index % 7 === 0 ? "cust_a" : null,
    sourceProgram: ["curl", "openwebui", "python"][index % 3],
    clientIp: "192.0.2.10",
    status,
    terminalState,
    errorClass,
    durationMs: 200 + ((index * 7919) % 20_000),
    ttftMs: stream && ok ? 40 + ((index * 104_729) % 3000) : null,
    // Fractional speeds, so float sums would show any change of fold order.
    decodeTps: stream && ok ? 20 + ((index * 2_654_435_761) % 10_000) / 97 : null,
    promptTokens: 100 + (index % 50),
    cachedTokens: index % 4 ? 32 : 0,
    outputTokens: ok ? 10 + (index % 300) : 0,
    usageSource: index % 6 === 0 ? "estimated" : "reported",
    finishReason: ["stop", "length", "tool_calls", "stop"][index % 4],
    extra: index % 53 === 0 ? { dupOf: requestId(index - 1) } : { toolSchemaCount: 0 },
    late: index % 17 === 0,
  };
}

function cumulative(values) {
  let total = 0;
  return values.map((value) => (total += value));
}

function datasetRuntime(step, at, fleet) {
  const vllm = fleet === "vllm:primary";
  const failed = step % 97 === 5;
  const reset = !failed && step % 211 === 7;
  const row = {
    at,
    fleetId: fleet,
    model: vllm ? "model-1" : "model-2",
    managerId: vllm ? "vllm" : "llama",
    engineId: vllm ? "sglang" : "llamacpp",
    runtimeKey: `lch_${fleet}:1`,
    intervalMs: 10_000,
    scrapeOk: failed ? 0 : 1,
    errorCode: failed ? "timeout" : null,
    reset: reset ? 1 : 0,
    idle: step % 13 === 0 ? 1 : 0,
    latencySource: vllm ? "engine_histogram" : "gateway",
    energyWh: 0.3 + (step % 7) / 10,
    late: (vllm && step % 31 === 0) || (!vllm && step % 37 === 3),
  };
  if (failed) return row;
  Object.assign(row, {
    running: step % 4,
    waiting: step % 3 === 0 ? 1 : 0,
    kvUsage: (step % 100) / 100 + 0.005,
    kvCapacityTokens: 262_144,
  });
  if (reset) return row;
  Object.assign(row, {
    dPromptTokens: 900 + (step % 11) * 13,
    dCachedTokens: 300 + (step % 5) * 7,
    dOutputTokens: 150 + (step % 9) * 3,
    dRequests: 1 + (step % 3),
    dErrors: vllm ? step % 2 : null,
    dSpecDraftTokens: vllm ? 30 : null,
    dSpecAcceptedTokens: vllm ? 20 + (step % 5) : null,
  });
  if (vllm) {
    // One scrape with different bucket bounds and fewer observations.
    const odd = step % 101 === 3;
    row.hist = odd
      ? { ttft: { le: [0.1, 1, "+Inf"], d: cumulative([1, 0, 0]) } }
      : {
        ttft: { le: [0.05, 0.1, 0.25, 0.5, 1, "+Inf"], d: cumulative([step % 2, 1, step % 3, 1, 0, step % 5 === 0 ? 1 : 0]), sum: 0.4 + step / 1000 },
        e2e: { le: [1, 5, 10, 30, "+Inf"], d: cumulative([0, 1, 1, step % 2, 0]) },
      };
  } else {
    const counts = new Array(GATEWAY_MS_BUCKETS.length).fill(0);
    counts[4 + (step % 6)] = 1 + (step % 2);
    row.hist = { ttft: { le: GATEWAY_MS_BUCKETS, d: cumulative(counts) } };
  }
  return row;
}

function datasetGpu(step, at, gpuIndex) {
  return {
    at,
    gpuIndex,
    gpuUuid: `GPU-0000000${gpuIndex}`,
    name: "Test GPU",
    utilPct: step % 9 === 0 ? 0 : 20 + (step % 70),
    memUsedMb: 40_000 + (step % 50) * 100,
    memTotalMb: 97_887,
    tempC: 50 + (step % 20),
    powerW: 150 + (step % 30) * 10.5,
    energyWh: (150 + (step % 30) * 10.5) * 10 / 3600,
    throttle: step % 9 === 0 ? "gpu_idle" : step % 4 !== 1 ? "sw_power_cap,bit_0x400" : "",
    late: gpuIndex === 0 && step % 29 === 0,
  };
}

function buildDataset() {
  const requests = [];
  let index = 0;
  for (let at = START + 7_000; at < END; at += 23_000 + (index % 5) * 1_000) {
    index += 1;
    requests.push(datasetRequest(index, at));
  }
  // One group with three fractional speeds in one minute, the middle one
  // late: float addition is not associative ((0.1 + 0.3) + 0.2 differs from
  // (0.3 + 0.2) + 0.1), so only a fixed fold order gives the same sums
  // whatever the insert order.
  const burst = START + 61 * MINUTE_MS;
  [0.1, 0.2, 0.3].forEach((decodeTps, position) => {
    index += 1;
    requests.push({
      ...datasetRequest(1, burst + position * 1_000),
      requestId: requestId(index),
      decodeTps,
      late: position === 1,
    });
  });
  const runtime = [];
  const gpu = [];
  let step = 0;
  for (let at = START; at < END; at += 10_000) {
    step += 1;
    for (const fleet of ["vllm:primary", "llama:primary"]) runtime.push(datasetRuntime(step, at, fleet));
    gpu.push(datasetGpu(step, at, 0));
    // GPU 1 skips five samples now and then: a 60 s gap.
    if (step % 50 < 10 || step % 50 >= 15) gpu.push(datasetGpu(step, at + 3_000, 1));
  }
  const coverage = [];
  for (let bucket = START; bucket < END; bucket += MINUTE_MS) {
    // A collection gap from 15:30 to 15:45.
    if (bucket >= START + 90 * MINUTE_MS && bucket < START + 105 * MINUTE_MS) continue;
    coverage.push({ bucket, late: bucket === START + 190 * MINUTE_MS });
  }
  return { requests, runtime, gpu, coverage };
}

function inRange(from, to, field = "at") {
  return (row) => row[field] >= from && row[field] < to;
}

// ---------------------------------------------------------------- tests

test("recomputing any bucket equals a from-scratch rollup, and late rows mark dirty and propagate to 1h and 1d", async (t) => {
  const dir = tempDir(t);
  const data = buildDataset();
  const options = { timezoneOffsetMinutes: TZ };

  // A: the live job, 10 minutes at a time, with the late rows held back.
  const fileA = path.join(dir, "incremental.sqlite");
  const storeA = await openStore(t, fileA);
  for (let from = START; from < END + 10 * MINUTE_MS; from += 10 * MINUTE_MS) {
    const to = from + 10 * MINUTE_MS;
    const live = (row) => !row.late;
    assert.equal((await storeA.insertRequests(data.requests.filter(inRange(from, to, "receivedAt")).filter(live))).rejected, 0);
    assert.equal((await storeA.insertRuntimeSamples(data.runtime.filter(inRange(from, to)).filter(live))).rejected, 0);
    assert.equal((await storeA.insertGpuSamples(data.gpu.filter(inRange(from, to)).filter(live))).rejected, 0);
    insertCoverage(fileA, data.coverage.filter(inRange(from, to, "bucket")).filter(live).map((row) => row.bucket));
    const run = await storeA.runRollups(to, options);
    assert.equal(run.ok, true);
  }
  for (const now of [END + HOUR_MS, FINAL]) assert.equal((await storeA.runRollups(now, options)).ok, true);
  assert.deepEqual(dirtyRows(fileA), [], "nothing was late yet");
  const watermarks = await storeA.getState("rollup.1d");
  assert.equal(watermarks.watermark, Date.UTC(2026, 9, 14, 16), "both local days are closed");

  // The late rows arrive after their minute, hour and day were closed.
  const lateRequest = data.requests.find((row) => row.late && row.extra.dupOf === undefined);
  const lateMinute = Math.floor(lateRequest.receivedAt / MINUTE_MS) * MINUTE_MS;
  const lateHour = Math.floor(lateRequest.receivedAt / HOUR_MS) * HOUR_MS;
  const lateDay = rollups.alignDay(lateRequest.receivedAt, TZ);
  const before = {
    minute: requestTotal(fileA, "rollup_1m", "bucket = ?", lateMinute),
    hour: requestTotal(fileA, "rollup_1h", "bucket = ?", lateHour),
    day: requestTotal(fileA, "rollup_1d", "bucket = ?", lateDay),
  };
  const lateIn = (from, to) => data.requests
    .filter((row) => row.late && !row.extra.dupOf && row.receivedAt >= from && row.receivedAt < to).length;
  await storeA.insertRequests(data.requests.filter((row) => row.late));
  await storeA.insertRuntimeSamples(data.runtime.filter((row) => row.late));
  await storeA.insertGpuSamples(data.gpu.filter((row) => row.late));
  const lateCoverage = data.coverage.find((row) => row.late).bucket;
  insertCoverage(fileA, [lateCoverage]);
  withDb(fileA, (db) => assert.equal(rollups.markDirty(db, lateCoverage), true, "a coverage writer marks a closed minute"));
  const dirty = dirtyRows(fileA);
  assert.ok(dirty.length > 0);
  assert.deepEqual(new Set(dirty.map((row) => row.grain)), new Set(["requests.1m", "runtime.1m", "gpu.1m"]));
  assert.ok(dirty.some((row) => row.grain === "requests.1m" && row.bucket === lateMinute));
  assert.ok(dirty.some((row) => row.grain === "requests.1m" && row.bucket === lateCoverage));

  const late = await storeA.runRollups(FINAL + MINUTE_MS, options);
  assert.equal(late.ok, true);
  assert.ok(late.recomputed["1m"] >= dirty.length - 1);
  assert.ok(late.recomputed["1h"] > 0, "dirty minutes propagate to their closed hours");
  assert.ok(late.recomputed["1d"] > 0, "dirty hours propagate to their closed days");
  assert.equal(late.dirtyPending, 0);
  assert.deepEqual(dirtyRows(fileA), []);
  assert.equal(requestTotal(fileA, "rollup_1m", "bucket = ?", lateMinute), before.minute + lateIn(lateMinute, lateMinute + MINUTE_MS));
  assert.equal(requestTotal(fileA, "rollup_1h", "bucket = ?", lateHour), before.hour + lateIn(lateHour, lateHour + HOUR_MS));
  assert.equal(requestTotal(fileA, "rollup_1d", "bucket = ?", lateDay), before.day + lateIn(lateDay, lateDay + DAY_MS));
  await storeA.close();
  const incremental = snapshot(fileA);

  // B: everything inserted at once, in reverse order, and rolled up once.
  const fileB = path.join(dir, "from-scratch.sqlite");
  const storeB = await openStore(t, fileB);
  await storeB.insertRequests(data.requests.slice().reverse());
  await storeB.insertRuntimeSamples(data.runtime.slice().reverse());
  await storeB.insertGpuSamples(data.gpu.slice().reverse());
  insertCoverage(fileB, data.coverage.map((row) => row.bucket).reverse());
  assert.equal((await storeB.runRollups(FINAL + MINUTE_MS, options)).ok, true);
  await storeB.close();
  const fromScratch = snapshot(fileB);

  for (const table of Object.keys(ROLLUP_ORDER)) {
    assert.ok(fromScratch[table].length > 0, `${table} has rows`);
    assert.deepEqual(incremental[table], fromScratch[table], `${table} matches the from-scratch rollup`);
  }

  // The totals match the raw rows: duplicates (extra.dupOf) are skipped, and
  // every minute, hour and day sums to the same.
  const counted = data.requests.filter((row) => !row.extra.dupOf).length;
  for (const table of ["rollup_1m", "rollup_1h", "rollup_1d"]) assert.equal(requestTotal(fileB, table), counted, table);
  const sum = (rows, column) => rows.reduce((total, row) => total + row[column], 0);
  for (const grain of ["1m", "1h", "1d"]) {
    assert.equal(sum(fromScratch[`runtime_rollup_${grain}`], "sample_count"), data.runtime.length);
    assert.equal(sum(fromScratch[`gpu_rollup_${grain}`], "sample_count"), data.gpu.length);
  }
  assert.ok(fromScratch.rollup_1h.some((row) => row.source === "import"), "imported requests keep source import");
  assert.deepEqual(new Set(fromScratch.rollup_1d.map((row) => row.bucket)), new Set([Date.UTC(2026, 9, 12, 16), Date.UTC(2026, 9, 13, 16)]));

  // Recomputing every bucket of every grain explicitly changes nothing.
  withDb(fileA, (db) => {
    const recompute = { now: FINAL + MINUTE_MS, timezoneOffsetMinutes: TZ };
    for (const grain of rollups.GRAINS) {
      const from = grain === "1d" ? Date.UTC(2026, 9, 12, 16) : START - HOUR_MS;
      const to = grain === "1d" ? Date.UTC(2026, 9, 15, 16) : END + HOUR_MS;
      rollups.rollupRequests(db, grain, from, to, recompute);
      rollups.rollupSamples(db, "runtime", grain, from, to, recompute);
      rollups.rollupSamples(db, "gpu", grain, from, to, recompute);
    }
  });
  assert.deepEqual(snapshot(fileA), incremental, "an explicit recompute is idempotent");

  // A damaged bucket is restored by recomputing just that bucket.
  withDb(fileA, (db) => {
    db.prepare("UPDATE rollup_1h SET requests = requests + 99, ttft_hist = NULL WHERE bucket = ?").run(lateHour);
    db.prepare("DELETE FROM runtime_rollup_1h WHERE bucket = ?").run(lateHour);
    db.prepare("UPDATE gpu_rollup_1d SET energy_wh = 0 WHERE bucket = ?").run(lateDay);
    const recompute = { now: FINAL + MINUTE_MS, timezoneOffsetMinutes: TZ };
    assert.equal(rollups.rollupRequests(db, "1h", lateHour, lateHour + 1, recompute).buckets, 1);
    rollups.rollupSamples(db, "runtime", "1h", lateHour, lateHour + 1, recompute);
    rollups.rollupSamples(db, "gpu", "1d", lateDay, lateDay + 1, recompute);
  });
  assert.deepEqual(snapshot(fileA), incremental);
});

test("coverage gives null for a collection gap and 0 for a covered bucket without requests", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openStore(t, file);
  const at = (hour, minute, second = 0) => Date.UTC(2026, 9, 14, hour, minute, second);
  const covered = [];
  for (let minute = 0; minute < 10; minute += 1) if (minute !== 5) covered.push(at(10, minute));
  insertCoverage(file, covered);
  // Another component's coverage does not count for request metrics.
  insertCoverage(file, [at(10, 5)], "gpu");
  await store.insertRequests([
    simpleRequest(1, at(10, 2, 10), { modelResolved: "model-a" }),
    simpleRequest(2, at(10, 5, 30), { modelResolved: "model-a" }),
    simpleRequest(3, at(10, 7, 0), { modelResolved: "model-b" }),
  ]);
  const options = { timezoneOffsetMinutes: TZ };
  assert.equal((await store.runRollups(at(10, 30), options)).ok, true);

  // Opening the closed minutes and hours does not mark anything dirty: a
  // duplicate row and a row in an open minute.
  await store.insertRequests([simpleRequest(1, at(10, 2, 10)), simpleRequest(4, at(10, 29, 30))]);
  assert.deepEqual(dirtyRows(file), []);
  await store.runRollups(Date.UTC(2026, 9, 15, 12), options);

  const counts = (grain, from, to, filters) => withDb(file, (db) => rollups.requestCounts(db, { grain, from, to, filters, timezoneOffsetMinutes: TZ })
    .map((row) => row.requests));
  assert.deepEqual(counts("1m", at(9, 58), at(10, 12)), [null, null, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, null, null],
    "10:05 has a request but no coverage; 10:10 onwards is a gap");
  assert.deepEqual(counts("1m", at(10, 0), at(10, 9), { model: "model-b" }), [0, 0, 0, 0, 0, null, 0, 1, 0]);
  assert.deepEqual(counts("1h", at(9, 0), at(12, 0)), [null, 4, null]);
  assert.deepEqual(counts("1h", at(9, 0), at(12, 0), { model: "model-c" }), [null, 0, null]);
  const day = Date.UTC(2026, 9, 13, 16);
  assert.deepEqual(counts("1d", day - DAY_MS, day + DAY_MS), [null, 4]);
  assert.deepEqual(counts("1d", day, day + DAY_MS, { model: ["model-a", "model-c"] }), [3]);
  assert.deepEqual(counts("1d", day, day + DAY_MS, { model: "model-c" }), [0]);
  withDb(file, (db) => {
    assert.throws(() => rollups.requestCounts(db, { grain: "1m", from: 0, to: 1, filters: { client_ip: "x" } }), { code: "unknown_dimension" });
    const markers = plain(db.prepare("SELECT * FROM rollup_1m WHERE source = 'coverage' ORDER BY bucket").all());
    assert.deepEqual(markers.map((row) => row.bucket), covered);
    for (const marker of markers) {
      assert.equal(marker.requests, 0);
      assert.equal(marker.model, "");
      assert.equal(marker.ttft_hist, null);
    }
    assert.equal(db.prepare("SELECT SUM(requests) AS n FROM rollup_1m").get().n, 4, "markers add nothing to sums");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_1h WHERE source = 'coverage'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_1d WHERE source = 'coverage'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_1m WHERE bucket = ?").get(at(10, 11)).n, 0, "a gap writes no row");
  });
});

test("an hour rebuilt from raw rows after coverage_1m was pruned keeps its coverage", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openStore(t, file);
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  // 13 days before NOW: inside minuteDays now, past it two days later.
  const hour = Date.UTC(2026, 9, 1, 10, 0, 0);
  const day = rollups.alignDay(hour, TZ);
  const options = { timezoneOffsetMinutes: TZ };
  insertCoverage(file, Array.from({ length: 60 }, (unused, minute) => hour + minute * MINUTE_MS));
  await store.insertRequests([simpleRequest(1, hour + 5 * MINUTE_MS)]);
  await store.runRollups(NOW, options);
  const counts = (grain, from, to) => withDb(file, (db) => rollups.requestCounts(db, {
    grain, from, to, filters: { model: "model-b" }, timezoneOffsetMinutes: TZ,
  }).map((row) => row.requests));
  assert.deepEqual(counts("1h", hour, hour + HOUR_MS), [0], "covered, no model-b requests");
  assert.deepEqual(counts("1d", day, day + DAY_MS), [0]);

  // Two days later retention prunes the 1m rows and coverage_1m of that
  // hour; its raw requests stay (requestsDays 30).
  const later = NOW + 2 * DAY_MS;
  await store.runRollups(later, options);
  await store.runRetention(later);
  readDb(file, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coverage_1m WHERE bucket >= ? AND bucket < ?").get(hour, hour + HOUR_MS).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_1m WHERE bucket >= ? AND bucket < ?").get(hour, hour + HOUR_MS).n, 0);
  });

  // A late row for that hour (a spool replay) rebuilds it from raw rows.
  await store.insertRequests([simpleRequest(2, hour + 7 * MINUTE_MS)]);
  const result = await store.runRollups(later + MINUTE_MS, options);
  assert.deepEqual(result.recomputed, { "1m": 0, "1h": 1, "1d": 1 });
  assert.equal(requestTotal(file, "rollup_1h", "bucket = ?", hour), 2);
  assert.equal(requestTotal(file, "rollup_1d", "bucket = ?", day), 2);
  assert.deepEqual(counts("1h", hour, hour + HOUR_MS), [0], "the rebuilt hour is still covered");
  assert.deepEqual(counts("1d", day, day + DAY_MS), [0]);
  readDb(file, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_1h WHERE bucket = ? AND source = 'coverage'").get(hour).n, 1);
  });

  // An uncovered hour rebuilt the same way gets no marker.
  const gap = hour + 3 * HOUR_MS;
  await store.insertRequests([simpleRequest(3, gap + MINUTE_MS)]);
  await store.runRollups(later + 2 * MINUTE_MS, options);
  assert.deepEqual(counts("1h", gap, gap + HOUR_MS), [null]);
});

test("local days follow the +08:00 boundary, close at 00:10 and survive an offset change", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openStore(t, file);
  const lastLocalMs = Date.UTC(2026, 9, 13, 15, 59, 59, 999);
  const localMidnight = Date.UTC(2026, 9, 13, 16, 0, 0);
  await store.insertRequests([simpleRequest(1, lastLocalMs), simpleRequest(2, localMidnight)]);
  const options = { timezoneOffsetMinutes: TZ };
  await store.runRollups(Date.UTC(2026, 9, 13, 16, 9, 59), options);
  assert.equal(requestTotal(file, "rollup_1m"), 2, "both minutes are closed 90 s after they end");
  assert.equal(requestTotal(file, "rollup_1h"), 1, "the 15:00Z hour is closed by minute 2");
  assert.equal(requestTotal(file, "rollup_1d"), 0, "the day closes at 00:10 local, not before");
  await store.runRollups(Date.UTC(2026, 9, 13, 16, 10, 0), options);
  assert.deepEqual(readDb(file, (db) => plain(db.prepare("SELECT bucket, requests FROM rollup_1d").all())),
    [{ bucket: Date.UTC(2026, 9, 12, 16), requests: 1 }], "23:59:59.999 local belongs to the earlier day");
  await store.runRollups(Date.UTC(2026, 9, 14, 16, 10, 0), options);
  assert.deepEqual(readDb(file, (db) => plain(db.prepare("SELECT bucket, requests FROM rollup_1d ORDER BY bucket").all())), [
    { bucket: Date.UTC(2026, 9, 12, 16), requests: 1 },
    { bucket: localMidnight, requests: 1 },
  ]);

  // The same rows in UTC fall on one day.
  const utcFile = path.join(dir, "utc.sqlite");
  const utc = await openStore(t, utcFile);
  await utc.insertRequests([simpleRequest(1, lastLocalMs), simpleRequest(2, localMidnight)]);
  await utc.runRollups(Date.UTC(2026, 9, 15, 0, 10), { timezoneOffsetMinutes: 0 });
  assert.deepEqual(readDb(utcFile, (db) => plain(db.prepare("SELECT bucket, requests FROM rollup_1d").all())),
    [{ bucket: Date.UTC(2026, 9, 13), requests: 2 }]);

  // Offsets that are not whole hours are refused.
  for (const bad of [330, -90, 900, "x"]) {
    assert.throws(() => rollups.normalizeTimezoneOffset(bad), { code: "invalid_timezone_offset" }, String(bad));
    await assert.rejects(store.runRollups(Date.UTC(2026, 9, 15), { timezoneOffsetMinutes: bad }), { code: "invalid_timezone_offset" });
  }
  assert.equal(rollups.normalizeTimezoneOffset(840), 840);
  assert.equal(rollups.normalizeTimezoneOffset("-720"), -720);
  assert.equal(rollups.normalizeTimezoneOffset(null), rollups.hostTimezoneOffsetMinutes());
});

test("a changed offset starts a new segment: no hour lands in two days or in none", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openStore(t, file);
  const hourly = [];
  for (let at = Date.UTC(2026, 9, 13, 12); at <= Date.UTC(2026, 9, 15, 12); at += HOUR_MS) hourly.push(simpleRequest(hourly.length + 1, at));
  await store.insertRequests(hourly);
  await store.runRollups(Date.UTC(2026, 9, 14, 16, 10), { timezoneOffsetMinutes: 480 });
  // +09:00 from the first open day on.
  await store.runRollups(Date.UTC(2026, 9, 16, 0), { timezoneOffsetMinutes: 540 });
  await store.runRollups(Date.UTC(2026, 9, 17, 0), { timezoneOffsetMinutes: 540 });
  const days = () => readDb(file, (db) => plain(db.prepare("SELECT bucket, SUM(requests) AS requests FROM rollup_1d GROUP BY bucket ORDER BY bucket").all()));
  assert.deepEqual(days(), [
    { bucket: Date.UTC(2026, 9, 12, 16), requests: 4 },
    { bucket: Date.UTC(2026, 9, 13, 16), requests: 24 },
    // The first +09:00 day runs from the old boundary to the next +09:00
    // midnight (23 h); later days are aligned to +09:00.
    { bucket: Date.UTC(2026, 9, 14, 16), requests: 21 },
  ]);
  assert.equal(days().reduce((total, row) => total + row.requests, 0), hourly.length);
  const state = await store.getState("rollup.1d");
  assert.deepEqual(state.segments, [
    { from: Date.UTC(2026, 9, 12, 16), offsetMinutes: 480 },
    { from: Date.UTC(2026, 9, 14, 16), offsetMinutes: 540 },
  ]);
  assert.equal(state.watermark, Date.UTC(2026, 9, 16, 15));

  // A late row inside the transition day is recomputed into that day.
  await store.insertRequests([simpleRequest(500, Date.UTC(2026, 9, 15, 3, 30))]);
  const late = await store.runRollups(Date.UTC(2026, 9, 17, 0, 1), { timezoneOffsetMinutes: 540 });
  assert.equal(late.recomputed["1d"], 1);
  assert.equal(days()[2].requests, 22);
});

test("percentiles and histograms merge across grains", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openStore(t, file);
  const minute = (offset) => Date.UTC(2026, 9, 14, 10, offset);
  const ttfts = [[minute(0), 120], [minute(0) + 5_000, 380], [minute(1), 2_400], [minute(1) + 9_000, 45]];
  await store.insertRequests(ttfts.map(([at, ttft], index) => simpleRequest(index + 1, at, { stream: true, ttftMs: ttft, decodeTps: 10.25 * (index + 1) })));
  const engine = (at, d, extra = {}) => ({
    at, fleetId: "vllm:a", model: "m", managerId: "vllm", runtimeKey: "k", scrapeOk: 1, intervalMs: 10_000,
    latencySource: "engine_histogram", hist: { ttft: { le: [0.1, 0.5, 1, "+Inf"], d } }, ...extra,
  });
  await store.insertRuntimeSamples([
    engine(minute(0), [2, 5, 6, 6]),
    engine(minute(0) + 10_000, [0, 1, 4, 5]),
    engine(minute(1), [1, 1, 1, 9]),
    // Different bounds and fewer observations: kept out of the merge.
    engine(minute(1) + 10_000, [1, 2], { hist: { ttft: { le: [0.2, "+Inf"], d: [1, 2] } } }),
    { ...engine(minute(1) + 20_000, null), hist: { ttft: { le: GATEWAY_MS_BUCKETS, d: new Array(GATEWAY_MS_BUCKETS.length).fill(1) } }, latencySource: "gateway" },
  ]);
  // GPU 0: 10 s samples with a 70 s gap, capped at two intervals (20 s).
  await store.insertGpuSamples([0, 10, 20, 90, 100].map((seconds) => ({
    at: minute(0) + seconds * 1000, gpuIndex: 0, throttle: "sw_thermal", energyWh: 1, utilPct: seconds === 20 ? 0 : 50,
  })));
  await store.runRollups(Date.UTC(2026, 9, 15, 12), { timezoneOffsetMinutes: TZ });

  readDb(file, (db) => {
    const reference = newHist(GATEWAY_MS_BUCKETS);
    for (const [, ttft] of ttfts) observe(reference, ttft);
    const hourly = db.prepare("SELECT * FROM rollup_1h WHERE source = 'live'").get();
    const minutes = db.prepare("SELECT ttft_hist FROM rollup_1m WHERE source = 'live' ORDER BY bucket").all().map((row) => JSON.parse(row.ttft_hist));
    assert.deepEqual(JSON.parse(hourly.ttft_hist), reference.counts);
    assert.deepEqual(JSON.parse(hourly.ttft_hist), minutes[0].map((value, index) => value + minutes[1][index]));
    assert.equal(hourly.ttft_n, 4);
    assert.equal(hourly.ttft_ms_sum, 120 + 380 + 2400 + 45);
    assert.equal(hourly.decode_tps_sum, 10.25 + 20.5 + 30.75 + 41);
    const daily = db.prepare("SELECT ttft_hist FROM rollup_1d WHERE source = 'live'").get();
    assert.equal(quantile({ le: GATEWAY_MS_BUCKETS, counts: JSON.parse(daily.ttft_hist) }, 0.95), quantile(reference, 0.95));

    const runtimeHour = db.prepare("SELECT * FROM runtime_rollup_1h").get();
    const merged = JSON.parse(runtimeHour.hist).ttft;
    assert.deepEqual(merged, { le: [0.1, 0.5, 1, "+Inf"], d: [3, 7, 11, 20], unit: "s", count: 20 });
    for (const [suffix, level] of [["p50", 0.5], ["p95", 0.95], ["p99", 0.99]]) {
      assert.equal(runtimeHour[`ttft_${suffix}_ms`], quantile({ le: merged.le, counts: merged.d }, level) * 1000, suffix);
    }
    assert.equal(runtimeHour.latency_source, "engine_histogram");
    assert.equal(runtimeHour.sample_count, 5);
    const runtimeMinute = db.prepare("SELECT ttft_p50_ms FROM runtime_rollup_1m WHERE bucket = ?").get(minute(0));
    assert.equal(runtimeMinute.ttft_p50_ms, quantile({ le: [0.1, 0.5, 1, "+Inf"], counts: [2, 6, 10, 11] }, 0.5) * 1000);

    const gpuHour = db.prepare("SELECT * FROM gpu_rollup_1h").get();
    // 10 (no previous sample) + 10 + 10 + 20 (capped gap) + 10 seconds.
    assert.deepEqual(JSON.parse(gpuHour.throttle_seconds), { sw_thermal: 60 });
    assert.equal(gpuHour.energy_wh, 5);
    assert.equal(gpuHour.idle_energy_wh, 1);
    assert.equal(gpuHour.util_pct_avg, 40);
    assert.equal(gpuHour.util_pct_max, 50);
  });
});

test("TTLs from §4.3 are enforced, and the rollup job never rebuilds pruned buckets", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const store = await openStore(t, file);
  await store.insertRequests([
    simpleRequest(1, NOW - 30 * DAY_MS - 1_000, { clientIp: "192.0.2.1" }),
    simpleRequest(2, NOW - 30 * DAY_MS + 60_000, { clientIp: "192.0.2.2", userAgent: "ua" }),
    simpleRequest(3, NOW - 6 * DAY_MS, { clientIp: "192.0.2.3", userAgent: "ua" }),
  ]);
  await store.insertRuntimeSamples([NOW - 48 * HOUR_MS - 1_000, NOW - 48 * HOUR_MS + 1_000]
    .map((at) => ({ at, fleetId: "vllm:a", managerId: "vllm", runtimeKey: "k", scrapeOk: 1 })));
  await store.insertGpuSamples([{ at: NOW - 48 * HOUR_MS - 1_000, gpuIndex: 0 }, { at: NOW - 48 * HOUR_MS + 1_000, gpuIndex: 0 }]);
  await store.insertEvents([
    { at: NOW - 400 * DAY_MS - 1_000, type: "alert.firing", source: "telemetry", title: "old alert" },
    { at: NOW - 400 * DAY_MS + 60_000, type: "alert.firing", source: "telemetry", title: "kept alert" },
    { at: NOW - 3000 * DAY_MS, type: "launch.ready", source: "vllm", title: "launch" },
    { at: NOW - 3000 * DAY_MS, type: "instance.state", source: "vllm", title: "instance" },
    { at: NOW - 3000 * DAY_MS, type: "container.oom", source: "vllm", title: "container", severity: "critical" },
    { at: NOW - 3000 * DAY_MS, type: "manager.exit", source: "vllm", title: "manager" },
    { at: NOW - 3000 * DAY_MS, type: "audit.export", source: "entry", title: "audit" },
    { at: NOW - 3000 * DAY_MS, type: "config.platform", source: "entry", title: "config" },
    { at: NOW - 3000 * DAY_MS, type: "security.ban", source: "entry", title: "ban" },
    { at: NOW - 3000 * DAY_MS, type: "security.auth_failed", source: "entry", title: "auth failed" },
    { at: NOW - 90 * DAY_MS - 1_000, type: "mcp.tool_call", source: "mcp", title: "old tool call" },
    { at: NOW - 89 * DAY_MS, type: "mcp.tool_call", source: "mcp", title: "kept tool call" },
  ]);
  await store.appendAuditAccess({ at: NOW - 3000 * DAY_MS, source: "entry", actor: "system:cli", action: "verify", outcome: "ok" });
  await store.close();

  withDb(file, (db) => {
    const counters = "requests, completed, client_aborts, streams, prompt_tokens, cached_tokens, output_tokens, estimated_usage, "
      + "finish_length, finish_tool, duration_ms_sum, ttft_ms_sum, ttft_n, decode_tps_sum, decode_tps_n";
    const zeros = counters.split(", ").map(() => "0").join(", ");
    for (const grain of ["1m", "1h", "1d"]) {
      const ttlMs = grain === "1m" ? 14 * DAY_MS : grain === "1h" ? 400 * DAY_MS : 5000 * DAY_MS;
      for (const [bucket, label] of [[NOW - ttlMs - MINUTE_MS, "old"], [NOW - ttlMs + HOUR_MS, "kept"]]) {
        db.prepare(`INSERT INTO rollup_${grain} (bucket, model, ${counters}) VALUES (?, ?, ${zeros})`).run(bucket, label);
        db.prepare(`INSERT INTO runtime_rollup_${grain} (bucket, fleet_id, model, sample_count) VALUES (?, 'f', ?, 1)`).run(bucket, label);
        db.prepare(`INSERT INTO gpu_rollup_${grain} (bucket, gpu_index, name, sample_count) VALUES (?, 0, ?, 1)`).run(bucket, label);
      }
    }
    for (const [bucket, label] of [[NOW - 14 * DAY_MS - MINUTE_MS, "old"], [NOW - 14 * DAY_MS + MINUTE_MS, "kept"]]) {
      db.prepare("INSERT INTO control_counts_1m (bucket, route, status_class, count) VALUES (?, ?, '2xx', 1)").run(bucket, label);
      db.prepare("INSERT INTO coverage_1m (bucket, component) VALUES (?, ?)").run(bucket, label);
    }
    db.prepare(`INSERT INTO lifetime_baseline (manager_id, model, source, imported_at) VALUES ('vllm', 'm', 'stats-ledger', ?)`).run(NOW - 3000 * DAY_MS);
    db.prepare(`INSERT INTO import_runs (source, file_key, started_at, status) VALUES ('stats-ledger', 'k', ?, 'done')`).run(NOW - 3000 * DAY_MS);
  });

  const reopened = await openStore(t, file);
  const result = await reopened.runRetention(NOW, { ipDays: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.pressure, null);
  readDb(file, (db) => {
    const labels = (table, column) => db.prepare(`SELECT ${column} AS label FROM ${table} ORDER BY ${column}`).all().map((row) => row.label);
    for (const grain of ["1m", "1h"]) {
      assert.deepEqual(labels(`rollup_${grain}`, "model"), ["kept"], `rollup_${grain}`);
      assert.deepEqual(labels(`runtime_rollup_${grain}`, "model"), ["kept"], `runtime_rollup_${grain}`);
      assert.deepEqual(labels(`gpu_rollup_${grain}`, "name"), ["kept"], `gpu_rollup_${grain}`);
    }
    assert.deepEqual(labels("rollup_1d", "model"), ["kept", "old"], "daily rollups are kept forever");
    assert.deepEqual(labels("runtime_rollup_1d", "model"), ["kept", "old"]);
    assert.deepEqual(labels("gpu_rollup_1d", "name"), ["kept", "old"]);
    assert.deepEqual(labels("control_counts_1m", "route"), ["kept"]);
    assert.deepEqual(labels("coverage_1m", "component"), ["kept"]);
    assert.deepEqual(labels("requests", "request_id"), [requestId(2), requestId(3)]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runtime_samples").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gpu_samples").get().n, 1);
    assert.deepEqual(labels("events", "title").sort(), [
      "audit", "ban", "config", "container", "instance", "kept alert", "kept tool call", "launch", "manager",
    ], "launch.*, instance.*, container.*, manager.*, audit.*, config.* and security.ban are kept forever");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_access_log").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lifetime_baseline").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM import_runs").get().n, 1);
    const masked = plain(db.prepare("SELECT request_id, client_ip, user_agent FROM requests ORDER BY request_id").all());
    assert.deepEqual(masked, [
      { request_id: requestId(2), client_ip: "192.0.2.x", user_agent: null },
      { request_id: requestId(3), client_ip: "192.0.2.3", user_agent: "ua" },
    ], "client data is masked after ipDays");
  });
  const floors = await reopened.getState("retention.floors");
  assert.deepEqual(floors, {
    requests: NOW - 30 * DAY_MS,
    samples: NOW - 48 * HOUR_MS,
    minute: NOW - 14 * DAY_MS,
    hour: NOW - 400 * DAY_MS,
  });
});

test("dirty buckets past raw retention are dropped with a counter; younger ones rebuild their hour from raw rows", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const store = await openStore(t, file);
  const minute = NOW - 20 * DAY_MS + 7 * MINUTE_MS;
  const hour = Math.floor(minute / HOUR_MS) * HOUR_MS;
  const day = rollups.alignDay(minute, TZ);
  await store.insertRequests([simpleRequest(1, minute + 1_000), simpleRequest(2, minute + 2_000), simpleRequest(3, NOW - 6 * DAY_MS)]);
  const options = { timezoneOffsetMinutes: TZ };
  await store.runRollups(NOW - 19 * DAY_MS, options);
  assert.equal(requestTotal(file, "rollup_1m", "bucket = ?", minute), 2);
  assert.equal(requestTotal(file, "rollup_1d", "bucket = ?", day), 2);
  await store.runRollups(NOW, options);
  await store.runRetention(NOW);
  assert.equal(requestTotal(file, "rollup_1m", "bucket = ?", minute), 0, "the 1m row is past minuteDays");
  assert.equal(requestTotal(file, "rollup_1h", "bucket = ?", hour), 2);

  // A late row 20 days back: its raw rows are still kept, its 1m rows not.
  await store.insertRequests([simpleRequest(4, minute + 3_000)]);
  // And one past the raw TTL, whose bucket can no longer be rebuilt.
  await store.insertRequests([simpleRequest(5, NOW - 31 * DAY_MS)]);
  assert.equal(dirtyRows(file).length, 2);
  const result = await store.runRollups(NOW + MINUTE_MS, options);
  assert.equal(result.droppedDirty, 1);
  assert.deepEqual(result.recomputed, { "1m": 0, "1h": 1, "1d": 1 }, "the pruned minute is not written again; its hour and day are");
  assert.deepEqual(dirtyRows(file), []);
  assert.equal(requestTotal(file, "rollup_1m", "bucket = ?", minute), 0, "a pruned 1m bucket is not written again");
  assert.equal(requestTotal(file, "rollup_1h", "bucket = ?", hour), 3, "the hour is rebuilt from the raw rows");
  assert.equal(requestTotal(file, "rollup_1d", "bucket = ?", day), 3);
  assert.equal(requestTotal(file, "rollup_1d", "bucket = ?", rollups.alignDay(NOW - 31 * DAY_MS, TZ)), 0);
  assert.equal((await store.stats()).rollups.droppedDirty, 1);
});

test("a bare (grain, bucket) dirty row from another writer recomputes every family", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openStore(t, file);
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const minute = NOW - 90 * MINUTE_MS;
  const hour = Math.floor(minute / HOUR_MS) * HOUR_MS;
  const sample = { at: minute, fleetId: "vllm:a", managerId: "vllm", runtimeKey: "k", scrapeOk: 1 };
  await store.insertRequests([simpleRequest(1, minute + 1_000)]);
  await store.insertRuntimeSamples([sample]);
  await store.insertGpuSamples([{ at: minute, gpuIndex: 0, utilPct: 10 }]);
  const options = { timezoneOffsetMinutes: TZ };
  await store.runRollups(NOW, options);

  // Rows written behind the store's back, marked the way §10 words it.
  withDb(file, (db) => {
    db.prepare("INSERT INTO runtime_samples (at, fleet_id, model, manager_id, runtime_key, scrape_ok) VALUES (?, 'vllm:a', '', 'vllm', 'k', 1)")
      .run(minute + 10_000);
    db.prepare("INSERT INTO gpu_samples (at, gpu_index, util_pct) VALUES (?, 0, 30)").run(minute + 10_000);
    db.prepare("INSERT INTO rollup_dirty (grain, bucket) VALUES ('1m', ?)").run(minute);
  });
  const result = await store.runRollups(NOW + MINUTE_MS, options);
  assert.equal(result.recomputed["1m"], 1, "one dirty bucket, every family rewritten");
  assert.equal(result.recomputed["1h"], 1);
  assert.equal(result.dirtyPending, 0);
  assert.deepEqual(dirtyRows(file), []);
  readDb(file, (db) => {
    assert.equal(db.prepare("SELECT sample_count FROM runtime_rollup_1m WHERE bucket = ?").get(minute).sample_count, 2);
    assert.equal(db.prepare("SELECT sample_count FROM runtime_rollup_1h WHERE bucket = ?").get(hour).sample_count, 2);
    assert.equal(db.prepare("SELECT util_pct_avg FROM gpu_rollup_1h WHERE bucket = ?").get(hour).util_pct_avg, 20);
  });
  assert.equal(requestTotal(file, "rollup_1h", "bucket = ?", hour), 1, "the requests family is unchanged");
});

test("a step budget of 0 still makes progress on every call", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const core = storeWorker.createStoreCore({ file, allowMainThread: true, retention: { yieldMs: 1 } });
  cleanup(t, () => core.close());
  core.insertRequests([simpleRequest(1, NOW - 10 * MINUTE_MS), simpleRequest(2, NOW - 3 * HOUR_MS)]);
  const options = { budgetMs: 0, timezoneOffsetMinutes: TZ };
  const run = await core.runRollups(NOW, options);
  assert.equal(run.ok, true);
  assert.equal(run.more, false);
  assert.ok(run.steps > 1, `one unit per step (${run.steps} steps)`);
  assert.equal(core.getState("rollup.1m").watermark, Math.floor((NOW - 90_000) / MINUTE_MS) * MINUTE_MS, "the pending minute is closed");
  assert.equal(requestTotal(file, "rollup_1m"), 2);
  assert.equal(requestTotal(file, "rollup_1h"), 1);

  // Dirty minutes too, and a 0 budget from the job settings.
  core.insertRequests([3, 4, 5].map((index) => simpleRequest(index, NOW - (20 + index) * MINUTE_MS)));
  assert.equal(dirtyRows(file).length, 3);
  assert.equal(core.configureJobs({ rollupBudgetMs: 0 }).jobs.rollupBudgetMs, 0);
  const late = await core.runRollups(NOW + MINUTE_MS, { timezoneOffsetMinutes: TZ });
  assert.equal(late.ok, true);
  assert.equal(late.recomputed["1m"], 3);
  assert.equal(late.dirtyPending, 0);
  assert.ok(late.steps >= 3);

  // Directly: a call that asks for more has done at least one unit.
  withDb(file, (db) => {
    db.prepare("INSERT INTO rollup_dirty (grain, bucket) VALUES ('requests.1m', ?), ('requests.1m', ?)")
      .run(NOW - 30 * MINUTE_MS, NOW - 31 * MINUTE_MS);
    for (let calls = 0; ; calls += 1) {
      assert.ok(calls < 20, "the pass ends");
      const step = rollups.runRollups(db, NOW + 2 * MINUTE_MS, options);
      if (!step.more) break;
      assert.ok(step.units >= 1);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rollup_dirty").get().n, 0);
  });
});

test("the size guard deletes old raw rows first and records a pressure warning", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const store = await openStore(t, file);
  const old = NOW - 8 * DAY_MS;
  await store.insertRequests([simpleRequest(1, old), simpleRequest(2, NOW - 6 * DAY_MS)]);
  await store.insertRuntimeSamples([NOW - 13 * HOUR_MS, NOW - 11 * HOUR_MS]
    .map((at) => ({ at, fleetId: "vllm:a", managerId: "vllm", runtimeKey: "k", scrapeOk: 1 })));
  await store.insertGpuSamples([{ at: NOW - 13 * HOUR_MS, gpuIndex: 0 }, { at: NOW - 11 * HOUR_MS, gpuIndex: 0 }]);
  await store.runRollups(NOW, { timezoneOffsetMinutes: TZ });
  const oldMinute = Math.floor(old / MINUTE_MS) * MINUTE_MS;
  assert.equal(requestTotal(file, "rollup_1m", "bucket = ?", oldMinute), 1);

  // Under the limit nothing extra goes.
  const calm = await store.runRetention(NOW, undefined, { maxDbMb: 2048 });
  assert.equal(calm.pressure, null);
  assert.deepEqual(calm.deleted, {});

  // The limit sits one page below the pages in use, so reclaiming free
  // pages alone cannot satisfy it.
  const { pageCount, freelistPages, pageSize } = await store.stats();
  const usedBytes = (pageCount - freelistPages) * pageSize;
  const pressed = await store.runRetention(NOW + MINUTE_MS, undefined, { maxDbMb: (usedBytes - pageSize) / (1024 * 1024) });
  assert.ok(pressed.pressure, "the guard triggers");
  assert.equal(pressed.pressure.dbBytes, usedBytes);
  assert.equal(pressed.pressure.requestsBefore, NOW + MINUTE_MS - 7 * DAY_MS);
  assert.equal(pressed.pressure.samplesBefore, NOW + MINUTE_MS - 12 * HOUR_MS);
  assert.deepEqual(pressed.pressure.deleted, { requests: 1, runtime_samples: 1, gpu_samples: 1 });
  readDb(file, (db) => {
    assert.deepEqual(db.prepare("SELECT request_id FROM requests").all().map((row) => row.request_id), [requestId(2)]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runtime_samples").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gpu_samples").get().n, 1);
    const events = plain(db.prepare("SELECT type, severity, source, data FROM events").all());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "telemetry.retention.pressure");
    assert.equal(events[0].severity, "warning");
    assert.deepEqual(JSON.parse(events[0].data).deleted, pressed.pressure.deleted);
    assert.equal(JSON.parse(events[0].data).i18nKey, "obs.event.retentionPressure", "the console localises the English title");
  });
  assert.equal(requestTotal(file, "rollup_1m", "bucket = ?", oldMinute), 1, "rollups of the deleted rows stay");

  // The guard's cutoff is a floor for the rollup job: a late row in that
  // range cannot rebuild its minute from what is left, so it is dropped.
  await store.insertRequests([simpleRequest(3, old + 1_000)]);
  const rolled = await store.runRollups(NOW + 2 * MINUTE_MS, { timezoneOffsetMinutes: TZ });
  assert.equal(rolled.droppedDirty, 1);
  assert.equal(requestTotal(file, "rollup_1m", "bucket = ?", oldMinute), 1);
});

test("the size guard gives free pages back before it deletes any row", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  // 50 pages vacuumed per pass: an earlier big delete leaves the file large.
  const store = await openStore(t, file, { retention: { yieldMs: 1, vacuumPages: 50 } });
  const expired = Array.from({ length: 3000 }, (unused, index) => simpleRequest(index + 1, NOW - 31 * DAY_MS + index, {
    userAgent: `agent-${"x".repeat(200)}-${index}`,
  }));
  await store.insertRequests([...expired, simpleRequest(9001, NOW - 8 * DAY_MS)]);
  const pruned = await store.runRetention(NOW);
  assert.equal(pruned.deleted.requests, 3000);
  const { pageCount, freelistPages, pageSize } = await store.stats();
  assert.ok(freelistPages > 50, `the delete left free pages (${freelistPages})`);

  // Over the limit only because of the free pages: they go back, rows stay.
  const result = await store.runRetention(NOW + MINUTE_MS, undefined, { maxDbMb: ((pageCount - 1) * pageSize) / (1024 * 1024) });
  assert.equal(result.ok, true);
  assert.equal(result.pressure, null);
  assert.deepEqual(result.deleted, {});
  const after = await store.stats({ rows: true });
  assert.equal(after.freelistPages, 0);
  assert.equal(after.pageCount, pageCount - freelistPages);
  assert.equal(after.rows.requests, 1, "the 8-day-old row is not deleted");
  assert.equal(after.rows.events, 0, "no pressure event");
});

function fakeClock(start) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, ms, due: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    delays() {
      return Array.from(timers.values()).map((timer) => timer.ms).sort((left, right) => left - right);
    },
    // Fires every timer due by now + ms (each job reschedules itself).
    advance(ms) {
      now += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test("the worker schedules rollups every 30 s and retention every hour, and settings apply live", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const clock = fakeClock(NOW);
  const core = storeWorker.createStoreCore({
    file, allowMainThread: true, clock, retention: { yieldMs: 1 }, jobs: { enabled: true, timezoneOffsetMinutes: TZ },
  });
  cleanup(t, () => core.close());
  assert.deepEqual(clock.delays(), [5_000, 60_000], "first rollup soon, first retention after startup");
  core.insertRequests([simpleRequest(1, NOW - 10 * MINUTE_MS)]);

  clock.advance(5_000);
  await waitFor(() => clock.delays().includes(30_000));
  assert.deepEqual(clock.delays(), [30_000, 60_000]);
  assert.equal(core.getState("rollup").lastRunAt, NOW + 5_000);
  assert.equal(core.getState("rollup.1m").watermark, Math.floor((NOW + 5_000 - 90_000) / MINUTE_MS) * MINUTE_MS);

  clock.advance(30_000);
  await waitFor(() => core.getState("rollup").lastRunAt === NOW + 35_000);
  clock.advance(25_000);
  await waitFor(() => clock.delays().includes(3_600_000));
  assert.equal(core.getState("retention").lastRunAt, NOW + 60_000);
  assert.equal(core.stats().jobs.lastRuns.retention.ok, true);

  // Live settings: an invalid offset is refused, the rest applies at once.
  assert.throws(() => core.configureJobs({ timezoneOffsetMinutes: 330 }), { code: "invalid_timezone_offset" });
  const configured = core.configureJobs({ maxDbMb: 512, ttl: { requestsDays: 10 }, timezoneOffsetMinutes: 540 });
  assert.equal(configured.ok, true);
  assert.equal(configured.jobs.maxDbMb, 512);
  assert.equal(configured.jobs.ttl.requestsDays, 10);
  assert.equal(configured.jobs.ttl.minuteDays, schema.TTL_DEFAULTS.minuteDays);
  assert.equal(configured.jobs.timezoneOffsetMinutes, 540);
  // Retention is due an hour after its last run, not an hour from now.
  assert.deepEqual(clock.delays(), [5_000, 3_600_000]);
  clock.advance(1_000);
  core.insertRequests([simpleRequest(2, NOW - 11 * DAY_MS)]);
  clock.advance(3_600_000 - 1_000);
  await waitFor(() => (core.getState("retention") || {}).lastRunAt === NOW + 3_660_000);
  assert.equal(core.getState("retention").ttl.requestsDays, 10);
  assert.equal(core.stats({ rows: true }).rows.requests, 1, "the configured requestsDays was enforced");

  assert.deepEqual(core.configureJobs({ enabled: false }).jobs.scheduled, []);
  assert.deepEqual(clock.delays(), []);
  core.configureJobs({ enabled: true });
  assert.equal(clock.delays().length, 2);
  core.beginClose();
  assert.deepEqual(clock.delays(), [], "closing stops the schedule");
});

test("ttl patches keep the retention keys they leave out, in configureJobs and per call", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const core = storeWorker.createStoreCore({ file, allowMainThread: true, clock: fakeClock(NOW), retention: { yieldMs: 1 } });
  cleanup(t, () => core.close());
  core.configureJobs({ ttl: { requestsDays: 90, minuteDays: 30 } });
  // Unset, empty and non-numeric values keep the current value too.
  const second = core.configureJobs({ ttl: { ipDays: 10, hourDays: null, eventsDays: "", samplesHours: "x" } });
  const expected = { ...schema.TTL_DEFAULTS, requestsDays: 90, minuteDays: 30, ipDays: 10 };
  assert.deepEqual(second.jobs.ttl, expected);
  assert.deepEqual(core.configureJobs({ maxDbMb: 512 }).jobs.ttl, expected, "a patch without ttl keeps it");
  assert.deepEqual(core.configureJobs({ ttl: null }).jobs.ttl, expected);
  assert.deepEqual(storeWorker.normalizeJobs({ ttl: { minuteDays: 7 } }, second.jobs).ttl, { ...expected, minuteDays: 7 });

  // A per-call ttl patches the job's ttl as well: requestsDays stays 90.
  core.insertRequests([simpleRequest(1, NOW - 40 * DAY_MS), simpleRequest(2, NOW - 100 * DAY_MS)]);
  const pass = await core.runRetention(NOW, { ipDays: 5 });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.ttl, { ...expected, ipDays: 5 });
  assert.deepEqual(readDb(file, (db) => db.prepare("SELECT request_id FROM requests").all().map((row) => row.request_id)), [requestId(1)]);
  assert.deepEqual(core.stats().jobs.ttl, expected, "a per-call ttl does not change the job");
});

test("jobs are off by default and run inside the worker when enabled, also after a restart", async (t) => {
  const dir = tempDir(t);
  const quiet = await openStore(t, path.join(dir, "quiet.sqlite"));
  assert.equal((await quiet.stats()).jobs.enabled, false);
  assert.deepEqual((await quiet.stats()).jobs.scheduled, []);

  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({
    file,
    logger: quietLogger(),
    restartMinMs: 20,
    jobs: { enabled: true, rollupEveryMs: 50, firstRollupDelayMs: 0, firstRetentionDelayMs: 0, timezoneOffsetMinutes: TZ },
  });
  cleanup(t, () => store.close());
  const now = Date.now();
  await store.insertRequests(Array.from({ length: 20 }, (unused, index) => simpleRequest(index + 1, now - 30 * MINUTE_MS + index * MINUTE_MS)));
  await waitFor(async () => {
    const stats = await store.stats({ rows: true });
    return stats.rows.rollup1m >= 18 && stats.retention !== null;
  });
  const stats = await store.stats();
  assert.equal(stats.thread, "worker");
  assert.equal(stats.jobs.enabled, true);
  assert.ok(stats.rollups.watermarks["1m"] >= Math.floor((now - 3 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS);

  const configured = await store.configureJobs({ rollupEveryMs: 40, maxDbMb: 512 });
  assert.equal(configured.jobs.rollupEveryMs, 40);
  await store[STORE_WORKER]().terminate();
  await waitFor(() => store.state === "ready" && store[STORE_WORKER]() !== null);
  const restarted = await store.stats();
  assert.equal(restarted.restarts, 1);
  assert.equal(restarted.jobs.enabled, true);
  assert.equal(restarted.jobs.rollupEveryMs, 40, "a restarted worker keeps the configured jobs");
  assert.equal(restarted.jobs.maxDbMb, 512);
});
