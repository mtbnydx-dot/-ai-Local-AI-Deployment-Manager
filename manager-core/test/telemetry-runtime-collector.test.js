"use strict";

// RuntimeCollector (04 TEL-7). The route responses are built by 01's own
// parsePrometheus + mapPrometheus over the recorded vLLM, SGLang and llama.cpp
// /metrics fixtures, exactly as the manager's route returns them (`raw`).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const metrics = require("../engines/metrics");
const { createRuntimeCollector, createGatewayLatencyWindow } = require("../telemetry/collectors/runtime");
const { openTelemetryStore } = require("../telemetry/store");
const golden = require("./fixtures/telemetry/runtime-golden.json");

const PROM = path.join(__dirname, "fixtures", "engines", "metrics");
const T0 = Date.parse("2026-10-14T08:00:10.004Z");
const STEP = 10_000;
const TELEMETRY_DIR = path.join(__dirname, "..", "telemetry");

function prom(name) {
  return fs.readFileSync(path.join(PROM, name), "utf8").split(String.fromCharCode(13)).join("");
}

// Adds `n` observations at `value` to one histogram of a Prometheus text.
function observeInText(text, base, value, n) {
  return text.split("\n").map((line) => {
    const bucket = line.match(new RegExp(`^(${base}_bucket\\{.*le="([^"]+)"\\} )(\\S+)$`));
    if (bucket) {
      const bound = bucket[2] === "+Inf" ? Infinity : Number(bucket[2]);
      return value <= bound ? `${bucket[1]}${Number(bucket[3]) + n}` : line;
    }
    const count = line.match(new RegExp(`^(${base}_count\\{.*\\} )(\\S+)$`));
    if (count) return `${count[1]}${Number(count[2]) + n}`;
    const sum = line.match(new RegExp(`^(${base}_sum\\{.*\\} )(\\S+)$`));
    if (sum) return `${sum[1]}${Number(sum[2]) + value * n}`;
    return line;
  }).join("\n");
}

// Sets the value of every sample of one metric.
function setInText(text, name, value) {
  return text.split("\n").map((line) => (line.startsWith(`${name}{`) || line.startsWith(`${name} `)
    ? `${line.slice(0, line.lastIndexOf(" ") + 1)}${value}`
    : line)).join("\n");
}

const TEXTS = (() => {
  const vllmFirst = prom("vllm.prom");
  const vllmSecond = prom("vllm-later.prom");
  const sglangFirst = prom("sglang.prom");
  let sglangSecond = sglangFirst;
  const sglang = (name, value) => { sglangSecond = setInText(sglangSecond, `sglang:${name}`, value); };
  sglang("prompt_tokens_total", 1_243_345);
  sglang("generation_tokens_total", 410_211);
  sglang("cached_tokens_total", 833_000);
  sglang("num_requests_total", 920);
  sglang("num_running_reqs", 2);
  sglang("num_queue_reqs", 1);
  sglangSecond = observeInText(sglangSecond, "sglang:time_to_first_token_seconds", 0.15, 8);
  sglangSecond = observeInText(sglangSecond, "sglang:e2e_request_latency_seconds", 3, 8);
  const llamaFirst = prom("llamacpp.prom");
  let llamaSecond = llamaFirst;
  llamaSecond = setInText(llamaSecond, "llamacpp:prompt_tokens_total", 58_710);
  llamaSecond = setInText(llamaSecond, "llamacpp:tokens_predicted_total", 20_880);
  return { vllm: [vllmFirst, vllmSecond], sglang: [sglangFirst, sglangSecond], llamacpp: [llamaFirst, llamaSecond] };
})();

const ENGINE_OF = { vllm: "vllm", sglang: "sglang", llamacpp: "llamacpp" };
const MODEL_OF = { vllm: "qwen3.8-27b", sglang: "qwen3.8-flash-next", llamacpp: "llama-demo" };

function routeResponse(engine, text, scrapedAtMs, overrides = {}) {
  const mapped = metrics.mapPrometheus(ENGINE_OF[engine], metrics.parsePrometheus(text), { defaultModel: MODEL_OF[engine] });
  const raw = { processStartSeconds: mapped.processStartSeconds, models: mapped.models };
  return {
    ok: true,
    status: 200,
    data: {
      ok: true,
      fleetId: `${engine}:primary`,
      managerId: engine,
      instanceId: "primary",
      engineId: ENGINE_OF[engine],
      scrapeOk: true,
      errorCode: null,
      scrapedAt: new Date(scrapedAtMs).toISOString(),
      raw,
      metrics: {},
      facts: {},
      unsupported: mapped.unsupported,
      ...overrides,
    },
  };
}

function instance(engine, extra = {}) {
  return {
    fleetId: `${engine}:primary`,
    managerId: engine,
    instanceId: "primary",
    engineId: ENGINE_OF[engine],
    runtimeId: `${engine}-rt`,
    launchId: "lch_test",
    lifecycleState: "ready",
    model: MODEL_OF[engine],
    models: [MODEL_OF[engine]],
    ...extra,
  };
}

function fakeStore() {
  const rows = [];
  const events = [];
  return {
    rows,
    events,
    insertRuntimeSamples: async (batch) => {
      rows.push(...batch);
      return { accepted: batch.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    insertEvents: async (batch) => {
      events.push(...batch);
      return { accepted: batch.length };
    },
  };
}

// A collector whose route answers come from `script`: a function
// (instance, call) → route response, called once per instance and tick.
function makeCollector(script, options = {}) {
  const store = options.store || fakeStore();
  const instances = options.instances || [instance("vllm")];
  const calls = { metrics: 0, stats: 0 };
  const collector = createRuntimeCollector({
    store,
    listFleetInstances: async () => instances,
    fetchInstanceMetrics: async (inst) => {
      calls.metrics += 1;
      return script(inst, calls.metrics);
    },
    fetchManagerStats: options.fetchManagerStats
      ? async (...args) => {
        calls.stats += 1;
        return options.fetchManagerStats(...args);
      }
      : undefined,
    requestLatency: options.requestLatency,
    now: options.now || (() => T0),
    logger: null,
    ...options.extra,
  });
  return { collector, store, calls };
}

const NO_NEGATIVES = (row) => {
  for (const [key, value] of Object.entries(row)) {
    if (/^d[A-Z]/.test(key) || /Tps$|^rpm$/.test(key)) assert.ok(value === null || value >= 0, `${key} is negative: ${value}`);
  }
};

for (const engine of ["vllm", "sglang", "llamacpp"]) {
  test(`${engine}: a pair of route responses gives the golden runtime_samples row`, async () => {
    const [first, second] = TEXTS[engine];
    const responses = [routeResponse(engine, first, T0), routeResponse(engine, second, T0 + STEP)];
    let index = 0;
    const gatewayWindow = createGatewayLatencyWindow({ now: () => T0 + STEP });
    if (engine === "llamacpp") {
      for (const [ttft, duration] of [[120, 900], [180, 1400], [240, 2600], [90, 700]]) {
        gatewayWindow.add({ fleetId: "llamacpp:primary", modelResolved: MODEL_OF.llamacpp, endedAt: T0 + 5000, ttftMs: ttft, durationMs: duration, terminalState: "completed" });
      }
      gatewayWindow.add({ fleetId: "llamacpp:primary", modelResolved: MODEL_OF.llamacpp, endedAt: T0 - 5000, ttftMs: 9000, durationMs: 9000, terminalState: "completed" });
    }
    const { collector, store } = makeCollector(() => responses[index], { instances: [instance(engine)], requestLatency: engine === "llamacpp" ? gatewayWindow.query : undefined });
    await collector.tick();
    assert.equal(store.rows.length, 0, "the first snapshot is only a baseline");
    index = 1;
    await collector.tick();
    assert.equal(store.rows.length, 1);
    const row = store.rows[0];
    NO_NEGATIVES(row);
    assert.deepEqual(JSON.parse(JSON.stringify(row)), golden[engine]);
  });
}

test("a manager without optional keys gets NULL columns, not errors", async () => {
  const [first, second] = TEXTS.sglang;
  const responses = [routeResponse("sglang", first, T0), routeResponse("sglang", second, T0 + STEP)];
  let index = 0;
  const { collector, store } = makeCollector(() => responses[index]);
  await collector.tick();
  index = 1;
  await collector.tick();
  const row = store.rows[0];
  for (const key of ["dErrors", "dAborts", "dFinishLength", "dSpecDraftTokens", "dSpecAcceptedTokens", "specAcceptRate", "tpotP50Ms", "queueP95Ms"]) {
    assert.equal(row[key], null, key);
  }
  assert.equal(row.scrapeOk, 1);
  assert.equal(row.latencySource, "engine_histogram");
  assert.ok(row.ttftP50Ms > 0);
});

test("route responses with no models or no counters still produce a row without throwing", async () => {
  const bare = (value) => ({
    ok: true,
    status: 200,
    data: { ok: true, scrapeOk: true, scrapedAt: new Date(T0 + value).toISOString(), raw: { processStartSeconds: null, models: [{ model: "m", counters: {}, gauges: {}, histograms: {} }] } },
  });
  let step = 0;
  const { collector, store } = makeCollector(() => bare(step * STEP));
  await collector.tick();
  step = 1;
  await collector.tick();
  const row = store.rows[0];
  assert.equal(row.scrapeOk, 1);
  assert.equal(row.dPromptTokens, null);
  assert.equal(row.running, null);
  assert.equal(row.idle, 0, "unknown activity is not idle");
  assert.equal(row.latencySource, "none");
});

test("idle intervals have rates of exactly 0 and NULL percentiles", async () => {
  const [first] = TEXTS.vllm;
  const idle = setInText(setInText(first, "vllm:num_requests_running", 0), "vllm:num_requests_waiting", 0);
  const responses = [routeResponse("vllm", idle, T0), routeResponse("vllm", idle, T0 + STEP)];
  let index = 0;
  const { collector, store } = makeCollector(() => responses[index]);
  await collector.tick();
  index = 1;
  await collector.tick();
  const row = store.rows[0];
  assert.equal(row.idle, 1);
  assert.equal(row.promptTps, 0);
  assert.equal(row.outputTps, 0);
  assert.equal(row.rpm, 0);
  assert.equal(row.dRequests, 0);
  assert.equal(row.ttftP50Ms, null);
  assert.equal(row.e2eP95Ms, null);
  assert.equal(row.hist, null);
  assert.equal(row.prefixHitRate, null);
});

test("an unchanged scrapedAt is skipped", async () => {
  const [first, second] = TEXTS.vllm;
  const responses = [routeResponse("vllm", first, T0), routeResponse("vllm", second, T0 + STEP), routeResponse("vllm", second, T0 + STEP)];
  let index = 0;
  const { collector, store } = makeCollector(() => responses[index]);
  await collector.tick();
  index = 1;
  await collector.tick();
  index = 2;
  await collector.tick();
  assert.equal(store.rows.length, 1);
});

test("a launch change writes a reset row with NULL deltas and rebases", async () => {
  const [first, second] = TEXTS.vllm;
  const live = [instance("vllm", { launchId: "lch_a" })];
  let current = routeResponse("vllm", first, T0);
  const store = fakeStore();
  const collector = createRuntimeCollector({
    store,
    listFleetInstances: async () => live,
    fetchInstanceMetrics: async () => current,
    now: () => T0,
    logger: null,
  });
  await collector.tick();
  live[0] = instance("vllm", { launchId: "lch_b" });
  current = routeResponse("vllm", second, T0 + STEP);
  await collector.tick();
  assert.equal(store.rows.length, 1);
  const reset = store.rows[0];
  assert.equal(reset.reset, 1);
  assert.equal(reset.runtimeKey, "lch_b:1760400000");
  for (const key of ["dPromptTokens", "dOutputTokens", "dRequests", "promptTps", "outputTps", "rpm", "ttftP50Ms", "prefixHitRate", "intervalMs"]) {
    assert.equal(reset[key], null, key);
  }
  assert.equal(reset.running, 0, "gauges still describe the new process");
  // The reset snapshot is the new baseline: the next pair differences normally.
  current = routeResponse("vllm", second, T0 + 2 * STEP);
  await collector.tick();
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1].reset, 0);
  assert.equal(store.rows[1].dOutputTokens, 0);
  NO_NEGATIVES(store.rows[1]);
});

test("a counter decrease writes a reset row; later rows are never negative", async () => {
  const [first, second] = TEXTS.vllm;
  const lowered = setInText(first, "vllm:generation_tokens_total", 1000);
  const responses = [routeResponse("vllm", second, T0), routeResponse("vllm", lowered, T0 + STEP), routeResponse("vllm", second, T0 + 2 * STEP)];
  let index = 0;
  const { collector, store } = makeCollector(() => responses[index]);
  for (index = 0; index < 3; index += 1) await collector.tick();
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[0].reset, 1);
  assert.equal(store.rows[0].dOutputTokens, null);
  // The third snapshot is against the lowered baseline: it rose again.
  assert.equal(store.rows[1].reset, 0);
  for (const row of store.rows) NO_NEGATIVES(row);
});

test("a scrapedAt that goes backwards is a reset, not a negative interval", async () => {
  const [first, second] = TEXTS.vllm;
  const responses = [routeResponse("vllm", first, T0 + STEP), routeResponse("vllm", second, T0)];
  let index = 0;
  const { collector, store } = makeCollector(() => responses[index]);
  await collector.tick();
  index = 1;
  await collector.tick();
  assert.equal(store.rows[0].reset, 1);
  assert.equal(store.rows[0].intervalMs, null);
});

test("llama latency is derived from gateway rows; without a source it is 'none'", async () => {
  const [first, second] = TEXTS.llamacpp;
  const responses = [routeResponse("llamacpp", first, T0), routeResponse("llamacpp", second, T0 + STEP)];
  const asked = [];
  const run = async (requestLatency) => {
    let index = 0;
    const { collector, store } = makeCollector(() => responses[index], { instances: [instance("llamacpp")], requestLatency });
    await collector.tick();
    index = 1;
    await collector.tick();
    return store.rows[0];
  };
  const withGateway = await run((query) => {
    asked.push(query);
    const window = createGatewayLatencyWindow({ now: () => T0 + STEP });
    window.add({ fleetId: query.fleetId, endedAt: T0 + 4000, ttftMs: 100, durationMs: 800, terminalState: "completed" });
    window.add({ fleetId: query.fleetId, endedAt: T0 + 6000, ttftMs: 100, durationMs: null, terminalState: "failed" });
    window.add({ fleetId: "llamacpp:other", endedAt: T0 + 6000, ttftMs: 5000, durationMs: 5000, terminalState: "completed" });
    return window.query(query);
  });
  assert.deepEqual(asked, [{ fleetId: "llamacpp:primary", model: "llama-demo", fromMs: T0, toMs: T0 + STEP }]);
  assert.equal(withGateway.latencySource, "gateway");
  assert.ok(withGateway.ttftP50Ms > 0 && withGateway.e2eP50Ms > 0);
  assert.equal(withGateway.hist.ttft.unit, "ms");
  assert.equal(withGateway.hist.ttft.count, 2);
  assert.equal(withGateway.hist.e2e.count, 1);
  assert.equal(withGateway.itlP50Ms, null);
  const none = await run(undefined);
  assert.equal(none.latencySource, "none");
  assert.equal(none.ttftP50Ms, null);
  const failing = await run(() => {
    throw new Error("store busy");
  });
  assert.equal(failing.latencySource, "none");
});

test("scrape failures write scrape_ok=0 rows and the event fires once after 3 in a row", async () => {
  let mode = "timeout";
  const { collector, store } = makeCollector(() => {
    if (mode === "timeout") return { ok: false, status: 0, code: "manager_timeout", data: null };
    if (mode === "500") return { ok: false, status: 500, data: null };
    if (mode === "envelope") return { ok: false, status: 502, data: { ok: false, error: { code: "parse_error" } } };
    return { ok: true, status: 200, data: { ok: true, scrapeOk: false, errorCode: "unsupported_endpoint", scrapedAt: null, raw: null } };
  });
  await collector.tick();
  mode = "500";
  await collector.tick();
  mode = "envelope";
  await collector.tick();
  mode = "unsupported";
  await collector.tick();
  assert.deepEqual(store.rows.map((row) => [row.scrapeOk, row.errorCode]), [[0, "timeout"], [0, "http_500"], [0, "parse_error"], [0, "unsupported_endpoint"]]);
  assert.equal(store.rows[0].reset, 0);
  assert.equal(store.rows[0].dOutputTokens, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.events.map((event) => event.type), ["runtime.scrape_failed"]);
  assert.equal(store.events[0].data.failures, 3);
  assert.equal(collector.status().fleets["vllm:primary"].consecutiveFailures, 4);
});

test("no_sample answers write nothing; loading and external instances are not scraped", async () => {
  const { collector, store, calls } = makeCollector(
    () => ({ ok: true, status: 200, data: { ok: true, scrapeOk: false, errorCode: "no_sample", scrapedAt: null, raw: null } }),
    { instances: [instance("vllm"), instance("llamacpp", { lifecycleState: "loading" }), instance("sglang", { external: true }), instance("sglang", { fleetId: "sglang:2", instanceId: "2", lifecycleState: "sleeping" })] },
  );
  await collector.tick();
  assert.equal(calls.metrics, 2, "ready and sleeping only");
  assert.equal(store.rows.length, 0);
});

test("a manager without the route falls back to /api/stats deltas, latency_source none, one degraded event", async () => {
  let at = T0;
  const statsAt = [
    { name: "qwen3.8-27b", tokens: { prompt: 1000, generation: 400, cachedPrompt: 600 }, requests: { total: 10, error: 1, aborted: 0, running: 1, waiting: 0 } },
    { name: "qwen3.8-27b", tokens: { prompt: 1500, generation: 700, cachedPrompt: 900 }, requests: { total: 14, error: 2, aborted: 1, running: 0, waiting: 0 } },
    { name: "qwen3.8-27b", tokens: { prompt: 1500, generation: 700, cachedPrompt: 900 }, requests: { total: 14, error: 2, aborted: 1, running: 0, waiting: 0 } },
  ];
  let statsIndex = 0;
  const { collector, store, calls } = makeCollector(
    () => ({ ok: false, status: 404, data: null }),
    {
      now: () => at,
      fetchManagerStats: async () => ({ ok: true, status: 200, data: { models: [statsAt[statsIndex]] } }),
    },
  );
  await collector.tick();
  assert.equal(store.rows.length, 0, "baseline");
  at += 31_000;
  statsIndex = 1;
  await collector.tick();
  assert.equal(store.rows.length, 1);
  const row = store.rows[0];
  assert.equal(row.latencySource, "none");
  assert.equal(row.hist, null);
  assert.equal(row.dPromptTokens, 500);
  assert.equal(row.dOutputTokens, 300);
  assert.equal(row.dRequests, 4);
  assert.equal(row.dErrors, 1);
  assert.equal(row.dAborts, 1);
  assert.equal(row.intervalMs, 31_000);
  assert.ok(Math.abs(row.outputTps - 300 / 31) < 1e-9);
  assert.equal(row.dFinishLength, null);
  assert.equal(row.ttftP50Ms, null);
  // Within 30 s no new stats call; the route is not re-probed within 60 s.
  const before = { metrics: calls.metrics, stats: calls.stats };
  at += 5000;
  await collector.tick();
  assert.deepEqual({ metrics: calls.metrics, stats: calls.stats }, before);
  // The 3rd sample is idle: no requests, nothing running.
  at += 31_000;
  statsIndex = 2;
  await collector.tick();
  assert.equal(store.rows.length, 2);
  assert.equal(store.rows[1].idle, 1);
  assert.equal(store.rows[1].outputTps, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.events.map((event) => event.type), ["telemetry.degraded"]);
  assert.equal(collector.status().state, "degraded");
});

test("an unknown_instance 404 is a scrape failure, not a missing route", async () => {
  const { collector, store, calls } = makeCollector(
    () => ({ ok: false, status: 404, data: { ok: false, error: { code: "unknown_instance" } } }),
    { fetchManagerStats: async () => ({ ok: true, data: { models: [] } }) },
  );
  await collector.tick();
  assert.equal(calls.stats, 0);
  assert.equal(store.rows[0].errorCode, "unsupported_endpoint");
  assert.deepEqual(collector.status().degradedManagers, []);
});

test("instances are scraped at most 8 at a time and a hung route times out", async () => {
  let active = 0;
  let peak = 0;
  const instances = Array.from({ length: 20 }, (_, index) => instance("vllm", { fleetId: `vllm:${index}`, instanceId: String(index) }));
  const { collector, store } = makeCollector(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { ok: false, status: 0, code: "manager_timeout" };
  }, { instances });
  await collector.tick();
  assert.equal(peak, 8);
  assert.equal(store.rows.length, 20);
  const hung = createRuntimeCollector({
    store: fakeStore(),
    listFleetInstances: async () => [instance("vllm")],
    fetchInstanceMetrics: () => new Promise(() => {}),
    timeoutMs: 100,
    logger: null,
  });
  await hung.tick();
  assert.equal(hung.status().fleets["vllm:primary"].lastErrorCode, "timeout");
});

test("rows the store cannot take for now are retried on the next tick", async () => {
  const [first, second, third] = [TEXTS.vllm[0], TEXTS.vllm[1], setInText(TEXTS.vllm[1], "vllm:prompt_tokens_total", 1_400_000)];
  const responses = [routeResponse("vllm", first, T0), routeResponse("vllm", second, T0 + STEP), routeResponse("vllm", third, T0 + 2 * STEP)];
  let index = 0;
  const store = fakeStore();
  let busy = true;
  const inner = store.insertRuntimeSamples;
  store.insertRuntimeSamples = async (batch) => (busy ? { accepted: 0, error: "telemetry_store_busy", retryable: true } : inner(batch));
  const { collector } = makeCollector(() => responses[index], { store });
  await collector.tick();
  index = 1;
  await collector.tick();
  assert.equal(store.rows.length, 0);
  busy = false;
  index = 2;
  await collector.tick();
  assert.equal(store.rows.length, 2);
  assert.equal(collector.status().pendingRows, 0);
});

test("rows are accepted by the real store and read back", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-runtime-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  t.after(async () => {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const [first, second] = TEXTS.vllm;
  const responses = [routeResponse("vllm", first, T0), routeResponse("vllm", second, T0 + STEP)];
  let index = 0;
  const { collector } = makeCollector(() => responses[index], { store });
  await collector.tick();
  index = 1;
  await collector.tick();
  assert.equal(collector.status().written, 1);
  await store.close();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT fleet_id, model, scrape_ok, d_output_tokens, latency_source, ttft_p50_ms, hist FROM runtime_samples").get();
    assert.equal(row.fleet_id, "vllm:primary");
    assert.equal(row.model, "qwen3.8-27b");
    assert.equal(row.scrape_ok, 1);
    assert.equal(row.d_output_tokens, golden.vllm.dOutputTokens);
    assert.equal(row.latency_source, "engine_histogram");
    assert.equal(row.ttft_p50_ms, golden.vllm.ttftP50Ms);
    assert.deepEqual(Object.keys(JSON.parse(row.hist)).sort(), Object.keys(golden.vllm.hist).sort());
  } finally {
    db.close();
  }
});

test("start() and stop() drive ticks from the injected timers", async () => {
  const scheduled = [];
  const timers = {
    setTimeout: (callback, ms) => {
      const handle = { callback, ms, cleared: false, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      handle.cleared = true;
    },
  };
  const { collector, calls } = makeCollector(() => ({ ok: false, status: 0, code: "manager_timeout" }), { extra: { timers, intervalMs: 5000 } });
  collector.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 5000);
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.metrics, 1);
  assert.equal(scheduled.length, 2, "the next tick is scheduled after the first finishes");
  await collector.stop();
  assert.equal(scheduled[1].cleared, true);
});

test("no Prometheus text parser exists under manager-core/telemetry", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(TELEMETRY_DIR);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(!/parsePrometheus(?:Metrics)?\b/.test(source.replace(/^\s*\/\/.*$/gm, "")), `${path.basename(file)} must not parse Prometheus text`);
    assert.ok(!/# TYPE|# HELP/.test(source), `${path.basename(file)} must not read Prometheus exposition text`);
  }
});

test("the gateway latency window keeps the last minutes, per fleet, completed rows for e2e", () => {
  let nowMs = T0;
  const window = createGatewayLatencyWindow({ now: () => nowMs, retainMs: 60_000 });
  window.add({ fleetId: "a", endedAt: T0 - 1000, ttftMs: 50, durationMs: 400, terminalState: "completed" });
  window.add({ fleetId: "a", endedAt: T0 - 1000, ttftMs: null, durationMs: 400, terminalState: "failed" });
  window.add({ fleetId: "b", endedAt: T0 - 1000, ttftMs: 50, durationMs: 400, terminalState: "completed" });
  window.add({ fleetId: "", endedAt: T0, ttftMs: 1, durationMs: 1, terminalState: "completed" });
  const result = window.query({ fleetId: "a", fromMs: T0 - 5000, toMs: T0 });
  assert.equal(result.ttft.count, 1);
  assert.equal(result.e2e.count, 1);
  assert.equal(window.query({ fleetId: "a", fromMs: T0 - 500, toMs: T0 }).ttft, null);
  nowMs = T0 + 120_000;
  window.query({ fleetId: "a", fromMs: 0, toMs: 1 });
  assert.equal(window.size(), 0);
});

test("a golden row never carries a field the schema does not have", () => {
  const db = new DatabaseSync(":memory:");
  const { MIGRATIONS } = require("../telemetry/schema");
  for (const migration of MIGRATIONS) migration.up(db);
  const columns = new Set(db.prepare("PRAGMA table_info(runtime_samples)").all().map((column) => column.name));
  db.close();
  const camel = (name) => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  const known = new Set([...columns].map(camel));
  for (const [engine, row] of Object.entries(golden)) {
    for (const key of Object.keys(row)) assert.ok(known.has(key), `${engine}: ${key} is not a runtime_samples column`);
  }
});
