"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  THROTTLE_REASONS,
  QUERY_CHAIN,
  PROCS_FIELDS,
  PROCS_PLAIN_FIELDS,
  createGpuCollector,
  parseNvidiaSmiTelemetry,
  parseComputeApps,
  decodeThrottle,
} = require("../telemetry/collectors/gpu");
const { integrateEnergyWh, priceAt, costOf } = require("../telemetry/energy");
const { openTelemetryStore, TelemetryStoreError } = require("../telemetry/store");
const fixture = require("./fixtures/telemetry/nvidia-smi.json");

const NOW = Date.UTC(2026, 9, 14, 8, 0, 0);
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ALL_FIELDS = Object.keys(fixture.gpus[0]);
const LEGACY_ONLY = QUERY_CHAIN[QUERY_CHAIN.length - 1];
const GPU0_UUID = fixture.gpus[0].uuid;
const GPU1_UUID = fixture.gpus[1].uuid;

const GPU0_ROW = Object.freeze({
  gpuIndex: 0,
  gpuUuid: GPU0_UUID,
  name: "NVIDIA Example GPU 96GB",
  utilPct: 87,
  memUtilPct: 41,
  memUsedMb: 90112,
  memTotalMb: 97887,
  tempC: 71,
  memTempC: null,
  powerW: 412.35,
  powerLimitW: 585,
  fanPct: 30,
  smClockMhz: 2520,
  memClockMhz: 13801,
  smClockMaxMhz: 3090,
  pstate: "P1",
  throttleMask: 0x400,
  throttle: "bit_0x400",
});
const GPU1_ROW = Object.freeze({
  gpuIndex: 1,
  gpuUuid: GPU1_UUID,
  name: "NVIDIA Example GPU 24GB",
  utilPct: 0,
  memUtilPct: 0,
  memUsedMb: 512,
  memTotalMb: 24576,
  tempC: 34,
  memTempC: null,
  powerW: null,
  powerLimitW: 450,
  fanPct: null,
  smClockMhz: 210,
  memClockMhz: 405,
  smClockMaxMhz: 2805,
  pstate: "P8",
  throttleMask: 0x1,
  throttle: "gpu_idle",
});

function assertClose(actual, expected, message) {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);
}

function without(list, ...drop) {
  return list.filter((item) => !drop.includes(item));
}

function invalidField(field) {
  return { error: Object.assign(new Error("Command failed: nvidia-smi"), { code: 2 }), stdout: `Field "${field}" is not a valid field to query.\r\n` };
}

// A transient driver error (exit 15, "GPU is lost or inaccessible"): not a
// field error, so no other field list is the fix.
function deviceHandleError() {
  return { error: Object.assign(new Error("Command failed: nvidia-smi"), { code: 15 }), stdout: fixture.queryGpu.deviceHandleUnknown };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function joined(list) {
  return list.map((fields) => fields.join(","));
}

// A fake nvidia-smi behind the child_process.execFile signature. `fields` is
// what the "driver" supports: an unknown field fails the way nvidia-smi does
// (exit code 2, the message on stdout). `apps(requestedFields)` answers
// --query-compute-apps; `fail(args)` can fail any call.
function fakeDriver({ fields = ALL_FIELDS, gpus = fixture.gpus, apps = null, fail = null } = {}) {
  const driver = { known: new Set(fields), gpus, apps, fail, calls: [] };
  driver.execFile = (file, args, options, callback) => {
    driver.calls.push({ file, args: [...args], options: { ...options } });
    const failure = typeof driver.fail === "function" ? driver.fail(args) : null;
    if (failure) {
      callback(failure.error, failure.stdout || "", failure.stderr || "");
      return;
    }
    const gpuArg = args.find((arg) => arg.startsWith("--query-gpu="));
    if (gpuArg) {
      const requested = gpuArg.slice("--query-gpu=".length).split(",");
      const unknown = requested.find((field) => !driver.known.has(field));
      if (unknown) {
        const answer = invalidField(unknown);
        callback(answer.error, answer.stdout, "");
        return;
      }
      callback(null, driver.gpus.map((gpu) => requested.map((field) => gpu[field]).join(", ")).join("\r\n") + "\r\n", "");
      return;
    }
    const appsArg = args.find((arg) => arg.startsWith("--query-compute-apps="));
    if (appsArg) {
      const answer = typeof driver.apps === "function" ? driver.apps(appsArg.slice("--query-compute-apps=".length).split(",")) : null;
      if (answer && answer.error) callback(answer.error, answer.stdout || "", "");
      else callback(null, answer ? answer.stdout : "", "");
      return;
    }
    callback(Object.assign(new Error("unexpected nvidia-smi call"), { code: 1 }), "", "");
  };
  driver.gpuQueries = () => driver.calls
    .map((call) => call.args[0])
    .filter((arg) => arg.startsWith("--query-gpu="))
    .map((arg) => arg.slice("--query-gpu=".length));
  driver.appQueries = () => driver.calls
    .map((call) => call.args[0])
    .filter((arg) => arg.startsWith("--query-compute-apps="))
    .map((arg) => arg.slice("--query-compute-apps=".length));
  return driver;
}

// Answers the compute-apps query with a fixture when the requested field list
// matches it, and with nvidia-smi's invalid-field error otherwise.
function appsFrom(entry) {
  return (requested) => (requested.join(",") === entry.fields ? { stdout: entry.stdout } : invalidField(requested[0]));
}

function fakeClock(start = NOW) {
  const clock = { at: start, now: () => clock.at, advance: (ms) => { clock.at += ms; } };
  return clock;
}

function fakeTimers() {
  const timers = {
    pending: [],
    setTimeout(fn, ms) {
      const handle = { fn, ms, cleared: false, unref() {} };
      timers.pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    async runNext() {
      while (timers.pending.length && timers.pending[0].cleared) timers.pending.shift();
      const handle = timers.pending.shift();
      assert.ok(handle && !handle.cleared, "a live timer is scheduled");
      await handle.fn();
      return handle;
    },
    next() {
      return timers.pending.find((handle) => !handle.cleared) || null;
    },
  };
  return timers;
}

function memoryStore() {
  const store = {
    states: new Map(),
    rows: [],
    async getState(name) {
      return store.states.has(name) ? JSON.parse(JSON.stringify(store.states.get(name))) : null;
    },
    async setState(name, value) {
      store.states.set(name, JSON.parse(JSON.stringify(value)));
      return { ok: true };
    },
    async insertGpuSamples(rows) {
      store.rows.push(...rows.map((row) => ({ ...row })));
      return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
  };
  return store;
}

function makeCollector(driver, options = {}) {
  const logs = [];
  const collector = createGpuCollector({
    execFile: driver.execFile,
    now: (options.clock || fakeClock()).now,
    logger: (level, message) => logs.push({ level, message }),
    ...options,
  });
  return { collector, logs };
}

test("nvidia-smi fixture: N/A, [N/A] and [Not Supported] parse to NULL, real zeros stay 0", () => {
  const rows = parseNvidiaSmiTelemetry(fixture.queryGpu.full.stdout, fixture.queryGpu.full.fields);
  assert.deepEqual(rows, [GPU0_ROW, GPU1_ROW]);
  // The fake driver renders the same text, so the chain tests below read the
  // fixture as nvidia-smi prints it.
  const driver = fakeDriver();
  driver.execFile("nvidia-smi", [`--query-gpu=${fixture.queryGpu.full.fields}`], {}, (error, stdout) => {
    assert.equal(error, null);
    assert.equal(stdout, fixture.queryGpu.full.stdout);
  });
  assert.deepEqual(QUERY_CHAIN[0].join(","), fixture.queryGpu.full.fields);
});

test("power_limit_w prefers enforced.power.limit and falls back to power.limit", () => {
  const fields = "index,power.limit,enforced.power.limit";
  const rows = parseNvidiaSmiTelemetry("0, 600.00, 585.00\n1, 450.00, [N/A]\n2, N/A, N/A\n", fields);
  assert.deepEqual(rows.map((row) => row.powerLimitW), [585, 450, null]);
  assert.equal(parseNvidiaSmiTelemetry("0, 600.00\n", "index,power.limit")[0].powerLimitW, 600);
});

test("parse keeps commas in GPU names and skips error text, blank lines and repeated indexes", () => {
  const [row] = parseNvidiaSmiTelemetry(fixture.queryGpu.commaName.stdout, fixture.queryGpu.commaName.fields);
  assert.equal(row.name, "NVIDIA Example GPU, Rev B");
  assert.equal(row.powerW, 120.5);
  // A zero mask means "no reason active", which is not the same as unknown.
  assert.equal(row.throttleMask, 0);
  assert.equal(row.throttle, "");

  const full = fixture.queryGpu.full;
  assert.deepEqual(parseNvidiaSmiTelemetry(fixture.queryGpu.noDevices, full.fields), []);
  assert.deepEqual(parseNvidiaSmiTelemetry(fixture.queryGpu.invalidField, full.fields), []);
  assert.deepEqual(parseNvidiaSmiTelemetry(fixture.queryGpu.driverUnavailable, full.fields), []);
  assert.deepEqual(parseNvidiaSmiTelemetry("", full.fields), []);
  assert.deepEqual(parseNvidiaSmiTelemetry(full.stdout, ""), []);
  const noisy = `\r\n${fixture.queryGpu.invalidField}${full.stdout}\r\n${full.stdout.split("\r\n")[0]}\r\n`;
  assert.deepEqual(parseNvidiaSmiTelemetry(noisy, full.fields), [GPU0_ROW, GPU1_ROW]);

  // Units are tolerated if a query ever runs without nounits; text is not a number.
  const [units] = parseNvidiaSmiTelemetry("0, 412.35 W, 87 %, 97887 MiB, hot\n", "index,power.draw,utilization.gpu,memory.total,temperature.gpu");
  assert.equal(units.powerW, 412.35);
  assert.equal(units.utilPct, 87);
  assert.equal(units.memTotalMb, 97887);
  assert.equal(units.tempC, null);

  const legacy = parseNvidiaSmiTelemetry(fixture.queryGpu.legacy.stdout, fixture.queryGpu.legacy.fields);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].gpuUuid, null);
  assert.equal(legacy[0].memUtilPct, null);
  assert.equal(legacy[0].powerLimitW, 600);
  assert.equal(legacy[0].throttleMask, null);
  assert.equal(legacy[0].throttle, null);
});

test("decodeThrottle: the §8 table, unknown bits as bit_0x…, and the host's 0x400", () => {
  assert.deepEqual(decodeThrottle(0x400), ["bit_0x400"]);
  assert.deepEqual(decodeThrottle("0x0000000000000400"), ["bit_0x400"]);
  assert.deepEqual(decodeThrottle(0), []);
  assert.deepEqual(decodeThrottle("0x0000000000000000"), []);
  for (const reason of THROTTLE_REASONS) assert.deepEqual(decodeThrottle(reason.bit), [reason.slug]);
  assert.deepEqual(decodeThrottle(0x1ff), THROTTLE_REASONS.map((reason) => reason.slug));
  assert.deepEqual(decodeThrottle(0x8 | 0x40 | 0x400 | 0x10000), ["hw_slowdown", "hw_thermal", "bit_0x400", "bit_0x10000"]);
  assert.deepEqual(decodeThrottle("0x8000000000000001"), ["gpu_idle", "bit_0x8000000000000000"]);
  assert.deepEqual(decodeThrottle(0x400n), ["bit_0x400"]);
  assert.deepEqual(decodeThrottle("1024"), ["bit_0x400"]);
  for (const bad of [null, undefined, "", "N/A", "[N/A]", "0xzz", "garbage", -1, 1.5, Number.NaN]) {
    assert.deepEqual(decodeThrottle(bad), [], `decodeThrottle(${String(bad)})`);
  }
  assert.deepEqual(THROTTLE_REASONS.filter((reason) => reason.hardware).map((reason) => reason.slug),
    ["hw_slowdown", "hw_thermal", "hw_power_brake"]);

  // throttleMask keeps bits 0-52 as a safe integer; `throttle` is decoded
  // from all 64 bits (see the gpu_samples test below).
  const masks = parseNvidiaSmiTelemetry(
    "0, 0x8000000000000400\n1, 0x0020000000000041\n2, 0x001fffffffffffff\n3, 0xffffffffffffffff\n",
    "index,clocks_event_reasons.active",
  );
  assert.deepEqual(masks.map((row) => row.throttleMask), [0x400, 0x41, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  assert.ok(masks.every((row) => Number.isSafeInteger(row.throttleMask)));
  assert.equal(masks[0].throttle, "bit_0x400,bit_0x8000000000000000");
  assert.equal(masks[1].throttle, "gpu_idle,hw_thermal,bit_0x20000000000000");
  assert.equal(masks[3].throttle.split(",").length, 64, "every bit of an all-ones mask is listed");
  assert.deepEqual(decodeThrottle(masks[0].throttleMask), ["bit_0x400"]);
});

test("the fallback chain uses the first query the driver accepts", async () => {
  const profiles = [
    { name: "current driver", fields: ALL_FIELDS, step: 0 },
    { name: "pre-535 driver without clocks_event_reasons", fields: without(ALL_FIELDS, "clocks_event_reasons.active"), step: 1 },
    { name: "no memory temperature or utilization", fields: without(ALL_FIELDS, "temperature.memory", "utilization.memory"), step: 2 },
    {
      name: "old driver without either",
      fields: without(ALL_FIELDS, "clocks_event_reasons.active", "temperature.memory", "utilization.memory"),
      step: 3,
    },
    { name: "legacy fields only", fields: LEGACY_ONLY, step: 4 },
  ];
  for (const profile of profiles) {
    const driver = fakeDriver({ fields: profile.fields });
    const { collector } = makeCollector(driver);
    const result = await collector.tick();
    assert.equal(result.ok, true, profile.name);
    assert.deepEqual(driver.gpuQueries(), QUERY_CHAIN.slice(0, profile.step + 1).map((fields) => fields.join(",")), profile.name);
    assert.equal(collector.status().query.step, profile.step, profile.name);
    assert.equal(collector.status().state, "ok", profile.name);
    assert.equal(result.rows.length, 2, profile.name);
    assert.equal(result.rows[0].powerW, 412.35, profile.name);
  }

  const reduced = fakeDriver({ fields: without(ALL_FIELDS, "temperature.memory", "utilization.memory") });
  const { rows } = await makeCollector(reduced).collector.tick();
  assert.equal(rows[0].memUtilPct, null);
  assert.equal(rows[0].throttle, "bit_0x400");

  const legacy = fakeDriver({ fields: LEGACY_ONLY });
  const legacyRows = (await makeCollector(legacy).collector.tick()).rows;
  assert.equal(legacyRows[0].gpuUuid, null);
  assert.equal(legacyRows[0].throttle, null);
  assert.equal(legacyRows[0].powerLimitW, 600);
});

test("nvidia-smi runs through execFile without a shell, with a 5 s timeout", async () => {
  const driver = fakeDriver();
  await makeCollector(driver).collector.tick();
  const [call] = driver.calls;
  assert.equal(call.file, "nvidia-smi");
  assert.deepEqual(call.args, [`--query-gpu=${QUERY_CHAIN[0].join(",")}`, "--format=csv,noheader,nounits"]);
  assert.equal(call.options.timeout, 5000);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, undefined);
  assert.ok(driver.calls.every((entry) => entry.file === "nvidia-smi" && entry.options.timeout === 5000));
});

test("a promise-returning execFile works too", async () => {
  const driver = fakeDriver();
  const execFile = (file, args, options) => new Promise((resolve, reject) => {
    driver.execFile(file, args, options, (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve({ stdout })));
  });
  const { collector } = makeCollector(driver, { execFile });
  const result = await collector.tick();
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map(({ at, energyWh, procs, ...row }) => row), [GPU0_ROW, GPU1_ROW]);
});

test("the working query is cached for one hour, then the chain is probed again", async () => {
  const clock = fakeClock();
  const driver = fakeDriver({ fields: without(ALL_FIELDS, "clocks_event_reasons.active") });
  const { collector } = makeCollector(driver, { clock });
  await collector.tick();
  assert.equal(driver.gpuQueries().length, 2);
  assert.equal(collector.status().query.cachedUntil, NOW + HOUR_MS);
  for (let index = 1; index < 6; index += 1) {
    clock.advance(10_000);
    await collector.tick();
  }
  assert.equal(driver.gpuQueries().length, 7, "the cached query runs alone");
  clock.at = NOW + HOUR_MS;
  await collector.tick();
  assert.deepEqual(driver.gpuQueries().slice(7), QUERY_CHAIN.slice(0, 2).map((fields) => fields.join(",")));
  assert.equal(collector.status().query.cachedUntil, NOW + 2 * HOUR_MS);
});

test("a cached query that starts failing re-walks the chain in the same tick", async () => {
  const clock = fakeClock();
  const driver = fakeDriver();
  const { collector } = makeCollector(driver, { clock });
  await collector.tick();
  assert.equal(collector.status().query.step, 0);
  // A driver change drops the new spelling.
  driver.known.delete("clocks_event_reasons.active");
  clock.advance(10_000);
  const result = await collector.tick();
  assert.equal(result.ok, true);
  assert.deepEqual(driver.gpuQueries(), [QUERY_CHAIN[0], QUERY_CHAIN[0], QUERY_CHAIN[1]].map((fields) => fields.join(",")));
  assert.equal(collector.status().query.step, 1);
  assert.equal(collector.status().consecutiveFailures, 0);
});

test("a transient driver error keeps the cached query; the step that answers serves that tick only", async () => {
  const clock = fakeClock();
  let hiccups = 0;
  // The driver knows every field except the pre-535 throttle spelling.
  const driver = fakeDriver({
    fields: without(ALL_FIELDS, "clocks_throttle_reasons.active"),
    fail: (args) => {
      if (hiccups > 0 && args[0] === `--query-gpu=${QUERY_CHAIN[0].join(",")}`) {
        hiccups -= 1;
        return deviceHandleError();
      }
      return null;
    },
  });
  const { collector } = makeCollector(driver, { clock });
  await collector.tick();
  assert.equal(collector.status().query.step, 0);

  hiccups = 1;
  clock.advance(10_000);
  const hiccup = await collector.tick();
  assert.equal(hiccup.ok, true, "a lower step still delivers this tick's sample");
  assert.deepEqual(driver.gpuQueries().slice(1), joined(QUERY_CHAIN.slice(0, 3)));
  assert.equal(hiccup.rows[0].memUtilPct, null);
  assertClose(hiccup.rows[0].energyWh, (412.35 * 10) / 3600, "energy keeps integrating");
  assert.equal(collector.status().query.step, 0, "the full query stays cached");
  assert.equal(collector.status().consecutiveFailures, 0);

  clock.advance(10_000);
  const next = await collector.tick();
  assert.deepEqual(driver.gpuQueries().slice(4), joined([QUERY_CHAIN[0]]));
  assert.equal(next.rows[0].memUtilPct, 41);
});

test("without a cached query, a step reached past a driver error is used once and not cached", async () => {
  const clock = fakeClock();
  let hiccups = 1;
  const driver = fakeDriver({ fail: () => (hiccups-- > 0 ? deviceHandleError() : null) });
  const { collector } = makeCollector(driver, { clock });
  const first = await collector.tick();
  assert.equal(first.ok, true);
  assert.deepEqual(driver.gpuQueries(), joined(QUERY_CHAIN.slice(0, 2)));
  assert.equal(collector.status().query, null);
  clock.advance(10_000);
  await collector.tick();
  assert.deepEqual(driver.gpuQueries().slice(2), joined([QUERY_CHAIN[0]]));
  assert.equal(collector.status().query.step, 0);
});

test("a rejected field is recognised by exit code 2 or by nvidia-smi's message", async () => {
  const failures = [
    { error: Object.assign(new Error("Command failed: nvidia-smi"), { code: 255 }), stdout: fixture.queryGpu.invalidField },
    { error: Object.assign(new Error("Command failed: nvidia-smi"), { code: 2 }), stdout: "" },
  ];
  for (const failure of failures) {
    const driver = fakeDriver({ fail: (args) => (args[0].includes("clocks_event_reasons.active") ? failure : null) });
    const { collector } = makeCollector(driver);
    await collector.tick();
    assert.equal(collector.status().query.step, 1, `exit ${failure.error.code}`);
  }
});

test("a missing nvidia-smi degrades at once and backs off to 60 s; a good sample restores 10 s", async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  let missing = true;
  const driver = fakeDriver({
    fail: () => (missing ? { error: Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" }) } : null),
  });
  const { collector, logs } = makeCollector(driver, { clock, timers });
  collector.start();
  assert.equal(collector.status().state, "starting");
  assert.equal(timers.next().ms, 0);
  await timers.runNext();
  let status = collector.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.intervalMs, 60_000);
  assert.equal(status.lastError.code, "nvidia_smi_missing");
  assert.equal(driver.calls.length, 1, "no other field list can fix a missing binary");
  assert.equal(timers.next().ms, 60_000);
  assert.equal(logs.filter((line) => line.level === "warn").length, 1);

  missing = false;
  clock.advance(60_000);
  await timers.runNext();
  status = collector.status();
  assert.equal(status.state, "ok");
  assert.equal(status.intervalMs, 10_000);
  assert.equal(status.lastOkAt, NOW + 60_000);
  assert.equal(timers.next().ms, 10_000);
  await collector.stop();
});

test("three failed ticks in a row degrade the collector; a single failure does not", async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  let failing = false;
  const driver = fakeDriver({
    fail: () => (failing
      ? { error: Object.assign(new Error("Command failed: nvidia-smi"), { code: 9 }), stdout: fixture.queryGpu.driverUnavailable }
      : null),
  });
  const { collector } = makeCollector(driver, { clock, timers });
  collector.start();
  await timers.runNext();
  assert.equal(collector.status().state, "ok");

  failing = true;
  clock.advance(10_000);
  await timers.runNext();
  let status = collector.status();
  assert.equal(status.state, "ok");
  assert.equal(status.intervalMs, 10_000);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.lastError.code, "nvidia_smi_failed");
  assert.match(status.lastError.message, /couldn't communicate with the NVIDIA driver/);

  const before = driver.gpuQueries().length;
  clock.advance(10_000);
  await timers.runNext();
  // The cached query first, then the rest of the chain; a driver error is
  // not a field error, so the cache survives it.
  assert.equal(driver.gpuQueries().length - before, QUERY_CHAIN.length);
  assert.equal(collector.status().state, "ok");
  assert.equal(collector.status().query.step, 0);
  clock.advance(10_000);
  await timers.runNext();
  status = collector.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.intervalMs, 60_000);
  assert.equal(status.consecutiveFailures, 3);
  assert.equal(timers.next().ms, 60_000);

  failing = false;
  clock.advance(60_000);
  const recovered = driver.gpuQueries().length;
  await timers.runNext();
  assert.equal(collector.status().state, "ok");
  assert.equal(collector.status().consecutiveFailures, 0);
  assert.deepEqual(driver.gpuQueries().slice(recovered), [QUERY_CHAIN[0].join(",")], "the kept cache answers at once");
  assert.equal(timers.next().ms, 10_000);
  await collector.stop();
});

test("a timeout ends the chain walk and counts as a failure", async () => {
  const driver = fakeDriver({
    fail: () => ({ error: Object.assign(new Error("Command failed: nvidia-smi"), { killed: true, signal: "SIGTERM", code: null }) }),
  });
  const { collector } = makeCollector(driver);
  const result = await collector.tick();
  assert.equal(result.ok, false);
  assert.equal(result.error, "nvidia_smi_timeout");
  assert.equal(driver.calls.length, 1);
  assert.equal(collector.status().consecutiveFailures, 1);
});

test("an empty GPU list is a failure, not an empty sample", async () => {
  const driver = fakeDriver({ gpus: [] });
  driver.execFile = ((original) => (file, args, options, callback) => original(file, args, options, (error, stdout, stderr) => {
    callback(error, error ? stdout : fixture.queryGpu.noDevices, stderr);
  }))(driver.execFile);
  const { collector } = makeCollector(driver);
  const result = await collector.tick();
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_gpu");
  assert.equal(collector.status().lastError.message, "No devices were found");
  assert.equal(collector.latest(), null);
});

test("per-process VRAM: WDDM [N/A] leaves procs NULL and pauses the query for one hour", async () => {
  const clock = fakeClock();
  const driver = fakeDriver({ apps: appsFrom(fixture.computeApps.wddm) });
  const { collector, logs } = makeCollector(driver, { clock });
  const first = await collector.tick();
  assert.deepEqual(first.rows.map((row) => row.procs), [null, null]);
  assert.deepEqual(driver.appQueries(), [PROCS_FIELDS.join(",")]);
  let status = collector.status();
  assert.equal(status.procs.enabled, false);
  assert.equal(status.procs.reason, "per_process_memory_unavailable");
  assert.equal(status.procs.pausedUntil, NOW + HOUR_MS);
  assert.equal(logs.filter((line) => /per-process/.test(line.message)).length, 1);

  for (let at = NOW + MINUTE_MS; at < NOW + HOUR_MS; at += 5 * MINUTE_MS) {
    clock.at = at;
    const { rows } = await collector.tick();
    assert.deepEqual(rows.map((row) => row.procs), [null, null]);
  }
  assert.equal(driver.appQueries().length, 1, "no per-process call while paused");

  clock.at = NOW + HOUR_MS;
  await collector.tick();
  assert.equal(driver.appQueries().length, 2, "the query is tried again after an hour");
  status = collector.status();
  assert.equal(status.procs.pausedUntil, NOW + 2 * HOUR_MS);
  assert.equal(logs.filter((line) => /per-process/.test(line.message)).length, 1, "logged once per pause, not per hour");
});

test("per-process VRAM: once a minute, attributed by GPU uuid, base names only", async () => {
  const clock = fakeClock();
  const driver = fakeDriver({ apps: appsFrom(fixture.computeApps.numbers) });
  const { collector } = makeCollector(driver, { clock });
  const { rows } = await collector.tick();
  assert.deepEqual(rows[0].procs, [
    { pid: 101, name: "python3", usedMb: 81920 },
    { pid: 102, name: "llama-server", usedMb: 2048 },
  ]);
  assert.deepEqual(rows[1].procs, [{ pid: 103, name: "tool, with comma", usedMb: null }]);
  assert.equal(collector.status().procs.enabled, true);

  clock.advance(10_000);
  const between = await collector.tick();
  assert.deepEqual(between.rows.map((row) => row.procs), [null, null]);
  assert.equal(driver.appQueries().length, 1);
  clock.at = NOW + MINUTE_MS;
  await collector.tick();
  assert.equal(driver.appQueries().length, 2);

  const parsed = parseComputeApps(fixture.computeApps.wddm.stdout, fixture.computeApps.wddm.fields);
  assert.deepEqual(parsed.map((entry) => [entry.gpuUuid, entry.pid, entry.name, entry.usedMb]), [
    [GPU0_UUID, 4242, "example-server.exe", null],
    [GPU0_UUID, 5150, "example-helper.exe", null],
  ]);
});

test("a long process list stays within the 8 KiB procs column", async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `${GPU0_UUID}, ${1000 + index}, /opt/example/${"x".repeat(200)}-${index}, ${index}`);
  const driver = fakeDriver({ gpus: [fixture.gpus[0]], apps: () => ({ stdout: `${lines.join("\n")}\n` }) });
  const { rows } = await makeCollector(driver).collector.tick();
  assert.equal(rows[0].procs.length, 48);
  assert.equal(rows[0].procs[0].usedMb, 199, "the biggest users are kept");
  assert.ok(rows[0].procs.every((entry) => entry.name.length <= 64));
  assert.ok(Buffer.byteLength(JSON.stringify(rows[0].procs), "utf8") <= 8192);
});

test("per-process VRAM without gpu_uuid is attributed only on a single-GPU host", async () => {
  const apps = (requested) => (requested.includes("gpu_uuid") ? invalidField("gpu_uuid") : appsFrom(fixture.computeApps.plain)(requested));
  const clock = fakeClock();
  const single = fakeDriver({ gpus: [fixture.gpus[0]], apps });
  const { collector } = makeCollector(single, { clock });
  const { rows } = await collector.tick();
  assert.deepEqual(rows[0].procs, [{ pid: 101, name: "python3", usedMb: 81920 }]);
  assert.deepEqual(single.appQueries(), [PROCS_FIELDS.join(","), PROCS_PLAIN_FIELDS.join(",")]);
  clock.at = NOW + MINUTE_MS;
  await collector.tick();
  assert.deepEqual(single.appQueries().slice(2), [PROCS_PLAIN_FIELDS.join(",")], "the working variant is reused");

  const dual = fakeDriver({ apps });
  const dualRows = (await makeCollector(dual).collector.tick()).rows;
  assert.deepEqual(dualRows.map((row) => row.procs), [null, null]);
});

test("per-process VRAM: a driver error on the gpu_uuid variant does not lock in the plain list", async () => {
  let hiccups = 1;
  const apps = (requested) => {
    if (requested.includes("gpu_uuid") && hiccups-- > 0) return deviceHandleError();
    return appsFrom(requested.includes("gpu_uuid") ? fixture.computeApps.numbers : fixture.computeApps.plain)(requested);
  };
  const clock = fakeClock();
  const driver = fakeDriver({ apps });
  const { collector } = makeCollector(driver, { clock });
  const first = await collector.tick();
  assert.deepEqual(first.rows.map((row) => row.procs), [null, null], "the plain list cannot be attributed on two GPUs");
  assert.deepEqual(driver.appQueries(), [PROCS_FIELDS.join(","), PROCS_PLAIN_FIELDS.join(",")]);
  clock.at = NOW + MINUTE_MS;
  const second = await collector.tick();
  assert.deepEqual(driver.appQueries().slice(2), [PROCS_FIELDS.join(",")], "gpu_uuid is tried first again");
  assert.deepEqual(second.rows[0].procs.map((entry) => entry.pid), [101, 102]);
});

test("per-process VRAM: an empty list is [] only on a host that has reported per-process numbers", async () => {
  const clock = fakeClock();
  const store = memoryStore();
  let stdout = "";
  const driver = fakeDriver({ apps: () => ({ stdout }) });
  const { collector } = makeCollector(driver, { clock, store });
  const fresh = await collector.tick();
  assert.deepEqual(fresh.rows.map((row) => row.procs), [null, null], "no compute process yet: cannot tell WDDM from idle");
  assert.equal(collector.status().procs.memoryReported, null);

  stdout = fixture.computeApps.numbers.stdout;
  clock.at = NOW + MINUTE_MS;
  await collector.tick();
  assert.equal(collector.status().procs.memoryReported, true);
  stdout = "";
  clock.at = NOW + 2 * MINUTE_MS;
  const idle = await collector.tick();
  assert.deepEqual(idle.rows.map((row) => row.procs), [[], []], "this host measures, so the list is really empty");

  stdout = fixture.computeApps.wddm.stdout;
  clock.at = NOW + 3 * MINUTE_MS;
  await collector.tick();
  assert.equal(collector.status().procs.memoryReported, false);
  await collector.stop();

  // After the pause, and across a restart, an empty WDDM list stays NULL.
  stdout = "";
  clock.at = NOW + 3 * MINUTE_MS + HOUR_MS;
  const restarted = makeCollector(driver, { clock, store }).collector;
  const wddmIdle = await restarted.tick();
  assert.deepEqual(wddmIdle.rows.map((row) => row.procs), [null, null]);
  assert.equal(restarted.status().procs.memoryReported, false);
  assert.equal(driver.appQueries().length, 5);
});

test("integrateEnergyWh caps gaps at two intervals and never fills in missing readings", () => {
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 10_000, powerW: 360 }), 1, "10 s at 360 W");
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 10_000, powerW: 360 }, { intervalMs: 10_000 }), 1, "explicit interval");
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 20_000, powerW: 360 }), 2, "exactly two intervals");
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 25_000, powerW: 360 }), 2, "25 s gap capped to 20 s");
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + HOUR_MS, powerW: 360 }), 2, "an hour of downtime is not filled in");
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 90_000, powerW: 360 }, { intervalMs: 60_000 }), 9, "backoff interval");
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 600_000, powerW: 360 }, { intervalMs: 60_000 }), 12, "capped at 120 s");
  // The §3 two-argument form takes the interval from the samples.
  assertClose(integrateEnergyWh({ at: NOW }, { at: NOW + 90_000, powerW: 360, intervalMs: 60_000 }), 9, "interval on cur");
  assertClose(integrateEnergyWh({ at: NOW, intervalMs: 60_000 }, { at: NOW + 600_000, powerW: 360 }), 12, "interval on prev");
  assertClose(integrateEnergyWh({ at: NOW, intervalMs: 60_000 }, { at: NOW + 90_000, powerW: 360, intervalMs: 5000 }), 9,
    "the larger of the two intervals");
  assertClose(integrateEnergyWh({ at: NOW, intervalMs: 60_000 }, { at: NOW + 90_000, powerW: 360 }, { intervalMs: 10_000 }), 2,
    "an explicit option wins");
  assertClose(integrateEnergyWh({ at: NOW, intervalMs: "x" }, { at: NOW + 90_000, powerW: 360, intervalMs: -1 }), 2,
    "unusable intervals fall back to 10 s");
  assertClose(integrateEnergyWh({ at: new Date(NOW).toISOString() }, { at: new Date(NOW + 10_000).toISOString(), powerW: 360 }), 1, "ISO times");
  assert.equal(integrateEnergyWh({ at: NOW }, { at: NOW + 10_000, powerW: 0 }), 0, "a real 0 W reading is 0 Wh");
  for (const powerW of [null, undefined, "", Number.NaN, -5, "[N/A]"]) {
    assert.equal(integrateEnergyWh({ at: NOW }, { at: NOW + 10_000, powerW }), null, `powerW ${String(powerW)}`);
  }
  assert.equal(integrateEnergyWh(null, { at: NOW, powerW: 360 }), null, "first sample");
  assert.equal(integrateEnergyWh({}, { at: NOW, powerW: 360 }), null, "predecessor without a time");
  assert.equal(integrateEnergyWh({ at: NOW }, { at: NOW, powerW: 360 }), null, "same instant");
  assert.equal(integrateEnergyWh({ at: NOW }, { at: NOW - 6000, powerW: 360 }), null, "clock went backwards");
});

test("the collector integrates energy per GPU and caps a collector gap", async () => {
  const clock = fakeClock();
  const { collector } = makeCollector(fakeDriver(), { clock });
  const first = await collector.tick();
  assert.deepEqual(first.rows.map((row) => row.energyWh), [null, null]);
  clock.advance(10_000);
  const second = await collector.tick();
  assertClose(second.rows[0].energyWh, (412.35 * 10) / 3600, "10 s");
  assert.equal(second.rows[1].energyWh, null, "no power reading, no energy");
  clock.advance(5 * MINUTE_MS);
  const third = await collector.tick();
  assertClose(third.rows[0].energyWh, (412.35 * 20) / 3600, "a 5 min gap integrates two intervals only");
  assert.deepEqual(collector.latest().gpus[0], {
    index: 0, util: 87, memUsedMb: 90112, memTotalMb: 97887, tempC: 71, powerW: 412.35, powerLimitW: 585, throttle: ["bit_0x400"],
  });
  assert.deepEqual(collector.latest().gpus[1].throttle, ["gpu_idle"]);
  assert.equal(collector.latest().at, NOW + 10_000 + 5 * MINUTE_MS);
});

// Epoch ms of a wall-clock time in UTC+08:00; hours past 23 roll into the
// next day.
function local(hours, minutes = 0, seconds = 0, ms = 0) {
  return Date.UTC(2026, 9, 14, hours, minutes, seconds, ms) - 480 * MINUTE_MS;
}

const NIGHT_TARIFF = Object.freeze({
  pricePerKwh: 0.6,
  currency: "CNY",
  tariffs: [{ from: "23:00", to: "07:00", pricePerKwh: 0.31 }],
  hostBaselineWatts: 0,
});
const TZ8 = Object.freeze({ timezoneOffsetMinutes: 480 });

test("priceAt: tariff windows that cross midnight are priced correctly", () => {
  const cases = [
    [local(12), 0.6],
    [local(22, 59, 59, 999), 0.6],
    [local(23), 0.31],
    [local(23, 59, 59, 999), 0.31],
    [local(24), 0.31],
    [local(27, 30), 0.31],
    [local(30, 59, 59, 999), 0.31],
    [local(31), 0.6],
  ];
  for (const [at, price] of cases) {
    assert.equal(priceAt(at, NIGHT_TARIFF, TZ8), price, new Date(at + 480 * MINUTE_MS).toISOString());
  }
  assert.equal(priceAt(local(23), { ...NIGHT_TARIFF, timezoneOffsetMinutes: 480 }), 0.31, "offset from the config");
  assert.equal(priceAt(local(23), { ...NIGHT_TARIFF, timezoneOffsetMinutes: 0 }, TZ8), 0.31, "options win");
  assert.equal(priceAt(local(23), NIGHT_TARIFF, { timezoneOffsetMinutes: 0 }), 0.6, "15:00 UTC is daytime");
  assert.equal(priceAt(new Date(local(23)).toISOString(), NIGHT_TARIFF, TZ8), 0.31, "ISO time");
  for (const at of [local(0), local(6), local(12), local(18), local(23, 30)]) {
    const host = -new Date(at).getTimezoneOffset();
    assert.equal(priceAt(at, NIGHT_TARIFF), priceAt(at, NIGHT_TARIFF, { timezoneOffsetMinutes: host }), "host offset by default");
  }
});

test("priceAt: same-day, whole-day and end-of-day windows; invalid entries are skipped", () => {
  const peakValley = {
    pricePerKwh: 0.62,
    tariffs: [
      { from: "23:00", to: "07:00", pricePerKwh: 0.31 },
      { from: "10:00", to: "15:00", pricePerKwh: 1.1 },
      { from: "18:00", to: "21:00", pricePerKwh: 1.1 },
    ],
  };
  const expected = [[local(6, 59), 0.31], [local(7), 0.62], [local(9, 59), 0.62], [local(10), 1.1], [local(14, 59), 1.1],
    [local(15), 0.62], [local(18), 1.1], [local(21), 0.62], [local(23), 0.31]];
  for (const [at, price] of expected) assert.equal(priceAt(at, peakValley, TZ8), price);

  const allDay = { pricePerKwh: 0.6, tariffs: [{ from: "00:00", to: "00:00", pricePerKwh: 0.5 }] };
  assert.equal(priceAt(local(3), allDay, TZ8), 0.5);
  assert.equal(priceAt(local(15), allDay, TZ8), 0.5);

  const lateEvening = { pricePerKwh: 0.6, tariffs: [{ from: "22:00", to: "24:00", pricePerKwh: 0.4 }] };
  assert.equal(priceAt(local(22), lateEvening, TZ8), 0.4);
  assert.equal(priceAt(local(23, 59), lateEvening, TZ8), 0.4);
  assert.equal(priceAt(local(24), lateEvening, TZ8), 0.6);

  const free = { pricePerKwh: 0.6, tariffs: [{ from: "01:00", to: "05:00", pricePerKwh: 0 }] };
  assert.equal(priceAt(local(2), free, TZ8), 0);

  const broken = {
    pricePerKwh: 0.6,
    tariffs: [
      null,
      { from: "25:00", to: "07:00", pricePerKwh: 0.1 },
      { from: "7", to: "08:00", pricePerKwh: 0.1 },
      { from: "06:60", to: "08:00", pricePerKwh: 0.1 },
      { from: "06:00", to: "08:00", pricePerKwh: null },
      { from: "06:00", to: "08:00", pricePerKwh: -1 },
      { from: "06:00", to: "08:00", pricePerKwh: "cheap" },
    ],
  };
  assert.equal(priceAt(local(7), broken, TZ8), 0.6);

  const tariffOnly = { pricePerKwh: null, tariffs: [{ from: "23:00", to: "07:00", pricePerKwh: 0.31 }] };
  assert.equal(priceAt(local(1), tariffOnly, TZ8), 0.31);
  assert.equal(priceAt(local(12), tariffOnly, TZ8), null);
  assert.equal(priceAt(local(12), { pricePerKwh: null, tariffs: [] }, TZ8), null);
  assert.equal(priceAt(local(12), null, TZ8), null);
  assert.equal(priceAt(local(12), { pricePerKwh: 0.6 }, TZ8), 0.6);
  assert.equal(priceAt("not a date", NIGHT_TARIFF, TZ8), null);
});

test("costOf prices each hour with the tariff in force, across midnight", () => {
  const hours = [local(22), local(23), local(24), local(30), local(31)];
  const expected = {
    cost: 0.6 + 0.31 + 0.31 + 0.31 + 0.6,
    currency: "CNY",
    priceConfigured: true,
    energyWh: 5000,
    pricedWh: 5000,
    unpricedWh: 0,
  };
  const inputs = [
    hours.map((bucket) => ({ bucket, energyWh: 1000 })),
    hours.map((at) => ({ at, wh: 1000 })),
    hours.map((bucket) => [bucket, 1000]),
    new Map(hours.map((bucket) => [bucket, 1000])),
    Object.fromEntries(hours.map((bucket) => [bucket, 1000])),
  ];
  for (const input of inputs) {
    const result = costOf(input, NIGHT_TARIFF, TZ8);
    assertClose(result.cost, expected.cost, "cost");
    assert.deepEqual({ ...result, cost: expected.cost }, expected);
  }
  assert.equal(costOf([], NIGHT_TARIFF, TZ8).cost, 0, "no energy costs nothing");
  const skipped = costOf([{ bucket: local(12), energyWh: null }, { bucket: local(12), energyWh: -5 }, { bucket: "x", energyWh: 10 }, null], NIGHT_TARIFF, TZ8);
  assert.equal(skipped.energyWh, 0);
  assert.equal(costOf([[local(12), 1000]], { ...NIGHT_TARIFF, currency: "USD" }, TZ8).currency, "USD");
  assert.equal(costOf([[local(12), 1000]], { ...NIGHT_TARIFF, currency: "dollars" }, TZ8).currency, "CNY");
});

test("costOf splits a bucket at a half-hour boundary and keeps unpriced energy visible", () => {
  const halfHour = { pricePerKwh: 0.6, tariffs: [{ from: "23:30", to: "07:30", pricePerKwh: 0.3 }] };
  assertClose(costOf([[local(23), 1000]], halfHour, TZ8).cost, 0.45, "23:00-24:00 is half night rate");
  assertClose(costOf([[local(31), 1000]], halfHour, TZ8).cost, 0.45, "07:00-08:00 is half night rate");
  assertClose(costOf([[local(24), 1000]], halfHour, TZ8).cost, 0.3, "00:00-01:00 is all night rate");
  // One day bucket from local midnight: 8 h at 0.31 and 16 h at 0.6.
  assertClose(costOf([[local(0), 24_000]], NIGHT_TARIFF, { ...TZ8, bucketMs: 24 * HOUR_MS }).cost, 8 * 0.31 + 16 * 0.6, "day bucket");

  const tariffOnly = { pricePerKwh: null, tariffs: [{ from: "23:00", to: "07:00", pricePerKwh: 0.31 }] };
  const partial = costOf([[local(22), 1000], [local(23), 1000]], tariffOnly, TZ8);
  assertClose(partial.cost, 0.31, "only the night hour is priced");
  assert.equal(partial.pricedWh, 1000);
  assert.equal(partial.unpricedWh, 1000);
  const none = costOf([[local(12), 1000]], tariffOnly, TZ8);
  assert.equal(none.cost, null, "nothing could be priced");
  assert.equal(none.priceConfigured, true);
  assert.equal(none.unpricedWh, 1000);

  const unset = costOf([[local(12), 1000]], { pricePerKwh: null, currency: "CNY", tariffs: [], hostBaselineWatts: 0 }, TZ8);
  assert.deepEqual(unset, { cost: null, currency: "CNY", priceConfigured: false, energyWh: 1000, pricedWh: 0, unpricedWh: 1000 });
  assert.equal(costOf([[local(12), 1000]], undefined).priceConfigured, false);
});

test("rows land in gpu_samples through the store; WDDM procs stay NULL", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-gpu-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  t.after(async () => {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const clock = fakeClock();
  const { collector } = makeCollector(fakeDriver({ apps: appsFrom(fixture.computeApps.wddm) }), { clock, store });
  await collector.tick();
  clock.advance(10_000);
  await collector.tick();
  assert.equal(collector.status().written, 4);
  assert.equal(collector.status().dropped, 0);
  const saved = await store.getState("collector.gpu");
  assert.equal(saved.query, QUERY_CHAIN[0].join(","));
  assert.equal(saved.procsPausedUntil, NOW + HOUR_MS);
  assert.deepEqual(saved.lastSampleAt, { 0: NOW + 10_000, 1: NOW + 10_000 });
  await store.close();

  const db = new DatabaseSync(file);
  try {
    const rows = db.prepare("SELECT * FROM gpu_samples ORDER BY at, gpu_index").all();
    assert.equal(rows.length, 4);
    const [first, idle, second] = rows;
    assert.equal(first.at, NOW);
    assert.equal(first.gpu_uuid, GPU0_UUID);
    assert.equal(first.util_pct, 87);
    assert.equal(first.mem_temp_c, null);
    assert.equal(first.power_limit_w, 585);
    assert.equal(first.pstate, "P1");
    assert.equal(first.throttle_mask, 0x400);
    assert.equal(first.throttle, "bit_0x400");
    assert.equal(first.energy_wh, null);
    assert.equal(first.procs, null);
    assert.equal(idle.power_w, null);
    assert.equal(idle.fan_pct, null);
    assert.equal(idle.util_pct, 0);
    assert.equal(idle.throttle, "gpu_idle");
    assertClose(second.energy_wh, (412.35 * 10) / 3600, "stored energy");
    assert.equal(rows[3].energy_wh, null);
  } finally {
    db.close();
  }
});

test("collector_state carries the cached query, the procs pause and energy across a restart", async () => {
  const store = memoryStore();
  const preFields = without(ALL_FIELDS, "clocks_event_reasons.active");
  const clock = fakeClock();
  const firstDriver = fakeDriver({ fields: preFields, apps: appsFrom(fixture.computeApps.wddm) });
  const first = makeCollector(firstDriver, { clock, store }).collector;
  await first.tick();
  await first.stop();
  assert.equal(firstDriver.gpuQueries().length, 2);

  clock.advance(15_000);
  const secondDriver = fakeDriver({ fields: preFields, apps: appsFrom(fixture.computeApps.wddm) });
  const second = makeCollector(secondDriver, { clock, store }).collector;
  const resumed = await second.tick();
  assert.deepEqual(secondDriver.gpuQueries(), [QUERY_CHAIN[1].join(",")], "no re-probe after a restart");
  assert.deepEqual(secondDriver.appQueries(), [], "the WDDM pause survives the restart");
  assertClose(resumed.rows[0].energyWh, (412.35 * 15) / 3600, "energy continues across a short restart");
  await second.stop();

  clock.at = NOW + 2 * HOUR_MS;
  const thirdDriver = fakeDriver({ fields: preFields, apps: appsFrom(fixture.computeApps.wddm) });
  const third = makeCollector(thirdDriver, { clock, store }).collector;
  const late = await third.tick();
  assert.equal(thirdDriver.gpuQueries().length, 2, "an expired cache re-probes the chain");
  assert.equal(thirdDriver.appQueries().length, 1, "an expired pause tries again");
  assertClose(late.rows[0].energyWh, (412.35 * 20) / 3600, "a long outage stays capped");

  // State that does not match a chain step or a GPU index is ignored.
  const tampered = memoryStore();
  tampered.states.set("collector.gpu", {
    query: "index,name,secret.field",
    queryCachedUntil: NOW + 10 * HOUR_MS,
    lastSampleAt: { x: NOW - 1000, 0: "soon" },
  });
  const fourthDriver = fakeDriver();
  const fourth = makeCollector(fourthDriver, { clock: fakeClock(), store: tampered }).collector;
  const fresh = await fourth.tick();
  assert.deepEqual(fourthDriver.gpuQueries(), [QUERY_CHAIN[0].join(",")]);
  assert.equal(fresh.rows[0].energyWh, null);
});

test("a mask above 2^53 keeps gpu_samples readable by plain node:sqlite queries; latest() stays JSON-safe", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-gpu-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  t.after(async () => {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  // NVML's old "Unknown" reason is bit 63.
  const gpu = { ...fixture.gpus[0], "clocks_event_reasons.active": "0x8000000000000400" };
  const clock = fakeClock();
  const { collector } = makeCollector(fakeDriver({ gpus: [gpu] }), { clock, store });
  const { rows } = await collector.tick();
  assert.equal(rows[0].throttleMask, 0x400);
  assert.equal(rows[0].throttle, "bit_0x400,bit_0x8000000000000000");
  const live = JSON.parse(JSON.stringify(collector.latest()));
  assert.equal(live.samples[0].throttleMask, 0x400);
  assert.deepEqual(live.gpus[0].throttle, ["bit_0x400", "bit_0x8000000000000000"]);
  clock.advance(10_000);
  await collector.tick();
  assert.equal(collector.status().written, 2);
  await store.close();

  // The reads a rollup or an export makes, without setReadBigInts: a 64-bit
  // value in the row would throw ERR_OUT_OF_RANGE here.
  const db = new DatabaseSync(file);
  try {
    const stored = db.prepare("SELECT * FROM gpu_samples WHERE gpu_index = ? ORDER BY at").all(0);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].throttle_mask, 0x400);
    assert.equal(stored[0].throttle, "bit_0x400,bit_0x8000000000000000");
    assert.equal(db.prepare("SELECT sum(throttle_mask) AS total FROM gpu_samples").get().total, 0x800);
  } finally {
    db.close();
  }
});

test("stop() halts scheduling and nothing is written afterwards", async () => {
  const store = memoryStore();
  const clock = fakeClock();
  const timers = fakeTimers();
  const { collector } = makeCollector(fakeDriver(), { clock, timers, store });
  collector.start();
  await timers.runNext();
  await collector.flush();
  assert.equal(store.rows.length, 2);
  assert.equal(timers.next().ms, 10_000);

  await collector.stop();
  assert.equal(collector.status().state, "stopped");
  assert.equal(timers.next(), null);
  const written = store.rows.length;
  clock.advance(10_000);
  await collector.tick();
  assert.equal(store.rows.length, written);
  assert.equal(collector.status().state, "stopped");
});

test("start() right after an unawaited stop() leaves a single sampling loop", async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const driver = fakeDriver();
  let gate = null;
  const execFile = (file, args, options, callback) => {
    if (gate) gate.then(() => driver.execFile(file, args, options, callback));
    else driver.execFile(file, args, options, callback);
  };
  const { collector } = makeCollector(driver, { clock, timers, execFile });
  collector.start();
  let open = null;
  gate = new Promise((resolve) => {
    open = resolve;
  });
  const firstTick = timers.runNext();
  await settle();
  assert.equal(driver.calls.length, 0, "the first tick is waiting on nvidia-smi");
  const stopping = collector.stop();
  collector.start();
  gate = null;
  open();
  await firstTick;
  await stopping;
  const live = timers.pending.filter((handle) => !handle.cleared);
  assert.equal(live.length, 1, "the old loop does not reschedule");
  assert.equal(live[0].ms, 0, "the new loop's first tick");
  await timers.runNext();
  assert.equal(timers.pending.filter((handle) => !handle.cleared).length, 1);
  assert.equal(collector.status().state, "ok");
  await collector.stop();
});

test("setIntervalMs re-times the wait already scheduled; energy keeps a gap scheduled under the old interval", async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const { collector } = makeCollector(fakeDriver(), { clock, timers, intervalMs: 60_000 });
  collector.start();
  await timers.runNext();
  assert.equal(timers.next().ms, 60_000);

  clock.advance(20_000);
  assert.equal(collector.setIntervalMs(5000), 5000);
  assert.equal(timers.next().ms, 0, "20 s have passed, so the next tick is due at once");
  await timers.runNext();
  // The 20 s gap was scheduled under 60 s: integrated in full, not cut to 2 × 5 s.
  assertClose(collector.latest().samples[0].energyWh, (412.35 * 20) / 3600, "gap under the old interval");
  assert.equal(timers.next().ms, 5000);
  clock.advance(5000);
  await timers.runNext();
  assertClose(collector.latest().samples[0].energyWh, (412.35 * 5) / 3600, "the new interval");

  clock.advance(2000);
  assert.equal(collector.setIntervalMs(30_000), 30_000);
  assert.equal(timers.next().ms, 28_000, "a longer interval counts from the last tick's start");
  assert.equal(collector.setIntervalMs("garbage"), 30_000);
  assert.equal(collector.setIntervalMs(5), 1000);
  assert.equal(collector.status().intervalMs, 1000);
  await collector.stop();
  assert.equal(timers.next(), null);
});

test("a slow store never delays sampling: one batch in flight, rows sampled meanwhile go out together", async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const store = memoryStore();
  const batches = [];
  const releases = [];
  store.insertGpuSamples = (rows) => {
    batches.push(rows.map((row) => row.at));
    return new Promise((resolve) => {
      releases.push(() => {
        store.rows.push(...rows);
        resolve({ accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] });
      });
    });
  };
  const { collector } = makeCollector(fakeDriver(), { clock, timers, store });
  collector.start();
  await timers.runNext();
  await settle();
  assert.deepEqual(batches, [[NOW, NOW]]);
  assert.equal(timers.next().ms, 10_000, "the next tick is scheduled while the write is pending");
  for (let index = 1; index <= 3; index += 1) {
    clock.advance(10_000);
    await timers.runNext();
    await settle();
  }
  let status = collector.status();
  assert.equal(status.ticks, 4);
  assert.equal(status.pendingRows, 6);
  assert.equal(batches.length, 1, "one batch in flight");

  releases.shift()();
  await settle();
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1], [10_000, 10_000, 20_000, 20_000, 30_000, 30_000].map((ms) => NOW + ms));
  releases.shift()();
  await collector.flush();
  status = collector.status();
  assert.equal(store.rows.length, 8);
  assert.equal(status.written, 8);
  assert.equal(status.pendingRows, 0);
  assert.deepEqual(store.states.get("collector.gpu").lastSampleAt, { 0: NOW + 30_000, 1: NOW + 30_000 });
  await collector.stop();
});

test("past the pending cap the oldest waiting rows are dropped and counted; stop() does not wait on a wedged store", async () => {
  const clock = fakeClock();
  const timers = fakeTimers();
  const gpus = Array.from({ length: 512 }, (_, index) => ({
    ...fixture.gpus[0],
    index: String(index),
    uuid: `GPU-${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
  }));
  const store = memoryStore();
  let calls = 0;
  store.insertGpuSamples = () => {
    calls += 1;
    return new Promise(() => {});
  };
  const { collector } = makeCollector(fakeDriver({ gpus }), { clock, timers, store, stopFlushMs: 20 });
  collector.start();
  for (let index = 0; index < 6; index += 1) {
    await timers.runNext();
    await settle();
    clock.advance(10_000);
  }
  const status = collector.status();
  assert.equal(calls, 1, "the first batch never settles");
  assert.equal(status.pendingRows, 2048);
  assert.equal(status.dropped, 512, "one tick's rows were dropped");
  const started = Date.now();
  await collector.stop();
  assert.ok(Date.now() - started < 1000, "stop() gave up on the wedged store");
  assert.equal(collector.status().state, "stopped");
});

// insertGpuSamples answers from `outcomes` in order ("busy", "restarting",
// "crashed", "closed" or "ok"), then "ok"; every batch is recorded.
function scriptedStore(outcomes) {
  const store = memoryStore();
  store.batches = [];
  store.insertGpuSamples = async (rows) => {
    store.batches.push(rows.map((row) => row.at));
    const outcome = outcomes.shift() || "ok";
    if (outcome === "busy") {
      return { accepted: 0, duplicates: 0, rejected: 0, dropped: rows.length, errors: [], error: "telemetry_store_busy", retryable: true };
    }
    if (outcome === "restarting" || outcome === "crashed") {
      throw new TelemetryStoreError(`telemetry_store_${outcome}`, "The telemetry store is restarting.", { retryable: true });
    }
    if (outcome === "closed") throw new TelemetryStoreError("telemetry_store_closed", "The telemetry store is closed.");
    store.rows.push(...rows.map((row) => ({ ...row })));
    return { accepted: rows.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
  };
  return store;
}

test("a busy, restarting or crashed store gets the batch again; no sample and no energy is lost", async () => {
  const clock = fakeClock();
  const store = scriptedStore(["busy", "restarting", "crashed"]);
  const { collector } = makeCollector(fakeDriver(), { clock, store });
  await collector.tick();
  let status = collector.status();
  assert.deepEqual([status.written, status.dropped, status.storeErrors, status.pendingRows], [0, 0, 1, 2]);

  for (let index = 1; index <= 3; index += 1) {
    clock.advance(10_000);
    await collector.tick();
  }
  assert.deepEqual(store.batches, [
    [NOW, NOW],
    [NOW, NOW, NOW + 10_000, NOW + 10_000],
    [NOW, NOW, NOW + 10_000, NOW + 10_000, NOW + 20_000, NOW + 20_000],
    [NOW, NOW, NOW + 10_000, NOW + 10_000, NOW + 20_000, NOW + 20_000, NOW + 30_000, NOW + 30_000],
  ], "handed-back rows go out first, with the next tick's rows");
  status = collector.status();
  assert.deepEqual([status.written, status.dropped, status.storeErrors, status.pendingRows], [8, 0, 3, 0]);
  const gpu0 = store.rows.filter((row) => row.gpuIndex === 0);
  assert.deepEqual(gpu0.map((row) => row.at), [0, 10_000, 20_000, 30_000].map((ms) => NOW + ms));
  assert.equal(gpu0[0].energyWh, null);
  for (const row of gpu0.slice(1)) assertClose(row.energyWh, (412.35 * 10) / 3600, "every interval keeps its energy");
  assert.deepEqual(store.states.get("collector.gpu").lastSampleAt, { 0: NOW + 30_000, 1: NOW + 30_000 });
});

test("a final store error drops the batch; flush() and stop() give handed-back rows one more try", async () => {
  const clock = fakeClock();
  const store = scriptedStore(["closed", "busy", "busy", "busy"]);
  const { collector } = makeCollector(fakeDriver(), { clock, store });
  await collector.tick();
  let status = collector.status();
  assert.deepEqual([status.written, status.dropped, status.storeErrors, status.pendingRows], [0, 2, 1, 0], "not retryable");

  clock.advance(10_000);
  await collector.tick();
  assert.equal(collector.status().pendingRows, 2);
  await collector.flush();
  assert.equal(store.batches.length, 3, "flush() tried once more");
  assert.equal(collector.status().pendingRows, 2, "and stops when the store hands the rows back again");
  await collector.flush();
  assert.equal(store.batches.length, 4);

  await collector.stop();
  assert.equal(store.batches.length, 5, "stop() makes the last attempt");
  status = collector.status();
  assert.deepEqual([status.written, status.dropped, status.storeErrors, status.pendingRows], [2, 2, 4, 0]);
  assert.deepEqual(store.rows.map((row) => row.at), [NOW + 10_000, NOW + 10_000]);
});

test("rows handed back by the store still respect the pending cap", async () => {
  const clock = fakeClock();
  const gpus = Array.from({ length: 512 }, (_, index) => ({
    ...fixture.gpus[0],
    index: String(index),
    uuid: `GPU-${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
  }));
  const store = scriptedStore(Array.from({ length: 6 }, () => "busy"));
  const { collector } = makeCollector(fakeDriver({ gpus }), { clock, store });
  for (let index = 0; index < 5; index += 1) {
    await collector.tick();
    clock.advance(10_000);
  }
  const status = collector.status();
  assert.equal(status.pendingRows, 2048);
  assert.equal(status.dropped, 512, "the oldest tick's rows were dropped");
  assert.equal(store.batches[4].length, 2048);
  assert.equal(store.batches[4][0], NOW + 10_000, "the batch starts with the oldest rows kept");
});
