"use strict";

// 04 TEL-1: the manager stats sampler on top of P0-OBS-5's rate window and
// P0-RT-5's speed sources. The P0 fixtures run through the managers' real
// buildModelStats (and so the real recent-rate ring), once called directly as
// P0 ships it and once through the sampler as GET /api/stats now reads it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const sampler = require("../telemetry/collectors/manager-stats-sampler");
const { quantile } = require("../telemetry/histogram");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_FILES = {
  vllm: path.join(REPO_ROOT, "vllm-manager", "server.js"),
  llama: path.join(REPO_ROOT, "llama-manager", "server.js"),
};
const managers = {
  vllm: require(SERVER_FILES.vllm),
  llama: require(SERVER_FILES.llama),
};

const CONTAINER = Object.freeze({ id: "c0ffee000001", name: "runtime-local", running: true, exists: true });

function fakeClock(startMs) {
  let value = startMs;
  return {
    now: () => value,
    set: (ms) => {
      value = ms;
    },
    advance: (ms) => {
      value += ms;
    },
  };
}

function omit(object, keys) {
  return Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));
}

// What the managers' summary function returns for one /metrics read, built
// from the manager's own parser and buildModelStats.
function scrapeSummary(managerId, { name, engine, lines, nowSeconds, runtimeKey = "runtime-1" }) {
  const manager = managers[managerId];
  const text = lines(name).join("\n");
  const metrics = manager.parsePrometheusMetrics(text);
  const options = managerId === "vllm" ? { engine } : {};
  const models = manager.buildModelStats(metrics, { [name]: { id: name } }, {}, nowSeconds, options);
  const summary = {
    engine,
    processStartSeconds: 1000,
    totals: manager.withSpeedWindowSeconds(core.aggregateStats(models, 100), models),
    models,
    modelsByName: Object.fromEntries(models.map((model) => [model.name, model])),
  };
  return {
    summary,
    text,
    scrapedAt: nowSeconds * 1000,
    histograms: sampler.latencyHistogramsFromSeries(metrics, models.map((model) => model.name), {
      includeUnlabeled: managerId === "llama",
    }),
    runtimeKey,
  };
}

// A stand-in for one manager: the sampler scrapes the fake engine through
// scrapeSummary and poll() is what collectStats does with the sample.
function sampledManager(managerId, { name, engine, linesAt }) {
  const clock = fakeClock(0);
  const engineReads = { count: 0 };
  let runtimeKey = "runtime-1";
  const statsSampler = sampler.createStatsSampler({
    now: clock.now,
    listInstances: async () => [{ id: "primary", primary: true, container: CONTAINER }],
    scrapeInstance: async (instance, { at }) => {
      engineReads.count += 1;
      return scrapeSummary(managerId, { name, engine, lines: linesAt(at / 1000), nowSeconds: at / 1000, runtimeKey });
    },
  });
  function poll() {
    const { summary, latency } = sampler.sampledStatsSummary(statsSampler, "primary", {
      container: CONTAINER,
      empty: core.emptyStatsSummary(CONTAINER, null),
    });
    return sampler.applyStatsWindows(summary, latency);
  }
  return {
    clock,
    engineReads,
    sampler: statsSampler,
    poll,
    setRuntimeKey: (value) => {
      runtimeKey = value;
    },
  };
}

// ---------------------------------------------------------------------------
// P0-RT-5 fixtures (the stats-speed.test.js sequences of both managers).

const P0_RT5_FIXTURES = [
  {
    id: "an idle SGLang with a generation counter reports the counter window",
    managerId: "vllm",
    engine: "sglang",
    steps: [
      { at: 100, lines: (n) => [`sglang:generation_tokens_total{model_name="${n}"} 1000`, `sglang:gen_throughput{model_name="${n}"} 88.5`, `sglang:num_running_reqs{model_name="${n}"} 0`] },
      { at: 160, lines: (n) => [`sglang:generation_tokens_total{model_name="${n}"} 1600`, `sglang:gen_throughput{model_name="${n}"} 88.5`, `sglang:num_running_reqs{model_name="${n}"} 0`] },
    ],
    expect: [
      { outputSource: "counter_window", windowSeconds: 0, recentOutputTokensPerSecond: 0, idle: true },
      { outputSource: "counter_window", windowSeconds: 60, recentOutputTokensPerSecond: 10, idle: false },
    ],
  },
  {
    id: "a running SGLang reports the live gauge",
    managerId: "vllm",
    engine: "sglang",
    steps: [
      { at: 500, lines: (n) => [`sglang:generation_tokens_total{model_name="${n}"} 500`, `sglang:gen_throughput{model_name="${n}"} 120.25`, `sglang:num_running_reqs{model_name="${n}"} 3`] },
    ],
    expect: [
      { outputSource: "sglang_gen_throughput_gauge", recentOutputTokensPerSecond: 120.25, outputObservedAt: 500, idle: false },
    ],
  },
  {
    id: "an SGLang build without generation_tokens_total uses the gauge while running and 0 when idle",
    managerId: "vllm",
    engine: "sglang",
    steps: [
      { at: 700, lines: (n) => [`sglang:gen_throughput{model_name="${n}"} 64`, `sglang:num_running_reqs{model_name="${n}"} 1`] },
      { at: 760, lines: (n) => [`sglang:gen_throughput{model_name="${n}"} 64`, `sglang:num_running_reqs{model_name="${n}"} 0`] },
    ],
    expect: [
      { outputSource: "sglang_gen_throughput_gauge", recentOutputTokensPerSecond: 64, idle: false },
      { outputSource: "sglang_gen_throughput_gauge", recentOutputTokensPerSecond: 0, outputObservedAt: null, idle: true },
    ],
  },
  {
    id: "vLLM reports the counter window with windowSeconds",
    managerId: "vllm",
    engine: "vllm",
    steps: [
      { at: 1000, lines: (n) => [`vllm:generation_tokens_total{model_name="${n}"} 100`, `vllm:prompt_tokens_total{model_name="${n}"} 400`] },
      { at: 1060, lines: (n) => [`vllm:generation_tokens_total{model_name="${n}"} 700`, `vllm:prompt_tokens_total{model_name="${n}"} 1600`] },
    ],
    expect: [
      { outputSource: "counter_window", windowSeconds: 0, averageSource: null },
      { outputSource: "counter_window", windowSeconds: 60, recentOutputTokensPerSecond: 10, recentPromptTokensPerSecond: 20, averageSource: null, idle: false },
    ],
  },
  {
    id: "llama recent output comes from the counter window, never the lifetime average",
    managerId: "llama",
    engine: "llama",
    steps: [
      { at: 300, lines: () => ["llamacpp:tokens_predicted_total 1000", "llamacpp:prompt_tokens_total 5000", "llamacpp:predicted_tokens_seconds 42.5", "llamacpp:prompt_tokens_seconds 910", "llamacpp:requests_processing 0"] },
      { at: 360, lines: () => ["llamacpp:tokens_predicted_total 1300", "llamacpp:prompt_tokens_total 5600", "llamacpp:predicted_tokens_seconds 42.5", "llamacpp:prompt_tokens_seconds 910", "llamacpp:requests_processing 1"] },
    ],
    expect: [
      { outputSource: "counter_window", windowSeconds: 0, recentOutputTokensPerSecond: 0, averageSource: "engine_lifetime_gauge" },
      { outputSource: "counter_window", windowSeconds: 60, recentOutputTokensPerSecond: 5, averageOutputTokensPerSecond: 42.5, averageSource: "engine_lifetime_gauge", idle: false },
    ],
  },
  {
    id: "an idle llama server reports zero recent output even with a high lifetime average",
    managerId: "llama",
    engine: "llama",
    steps: [
      { at: 1000, lines: () => ["llamacpp:tokens_predicted_total 4000", "llamacpp:prompt_tokens_total 9000", "llamacpp:predicted_tokens_seconds 77", "llamacpp:prompt_tokens_seconds 1200", "llamacpp:requests_processing 0"] },
      { at: 1060, lines: () => ["llamacpp:tokens_predicted_total 4000", "llamacpp:prompt_tokens_total 9000", "llamacpp:predicted_tokens_seconds 77", "llamacpp:prompt_tokens_seconds 1200", "llamacpp:requests_processing 0"] },
    ],
    expect: [
      { outputSource: "counter_window", windowSeconds: 0 },
      { outputSource: "counter_window", windowSeconds: 60, recentOutputTokensPerSecond: 0, averageOutputTokensPerSecond: 77, averageSource: "engine_lifetime_gauge", idle: true },
    ],
  },
];

P0_RT5_FIXTURES.forEach((fixture, index) => {
  test(`P0-RT-5 fixture through the sampler: ${fixture.id}`, async () => {
    const p0Name = `tel1-p0-${index}`;
    const sampledName = `tel1-sampled-${index}`;
    const manager = managers[fixture.managerId];
    const steps = new Map(fixture.steps.map((step) => [step.at, step]));
    const node = sampledManager(fixture.managerId, {
      name: sampledName,
      engine: fixture.engine,
      linesAt: (seconds) => steps.get(seconds).lines,
    });
    for (const [stepIndex, step] of fixture.steps.entries()) {
      // P0 as it ships: buildModelStats called directly at the same time.
      const metrics = manager.parsePrometheusMetrics(step.lines(p0Name).join("\n"));
      const options = fixture.managerId === "vllm" ? { engine: fixture.engine } : {};
      const [p0] = manager.buildModelStats(metrics, { [p0Name]: { id: p0Name } }, {}, step.at, options);

      node.clock.set(step.at * 1000);
      await node.sampler.tick();
      const stats = node.poll();
      const [model] = stats.models;

      assert.equal(model.speed.windowSeconds, p0.speed.windowSeconds, "speed.windowSeconds");
      assert.equal(model.speed.outputSource, p0.speed.outputSource, "speed.outputSource");
      // Everything P0 ships is unchanged; the sampler only adds fields.
      assert.deepEqual(omit(model.speed, ["window", "averageSource"]), omit(p0.speed, ["averageSource"]));
      assert.deepEqual(omit(model.latency, ["scope", "window"]), p0.latency);
      assert.deepEqual(model.speed.window, {
        seconds: p0.speed.windowSeconds,
        source: p0.speed.outputSource,
        idle: model.speed.window.idle,
      });
      assert.equal(model.speed.window.source, model.speed.outputSource);
      assert.equal(model.latency.scope, "since_process_start");
      assert.equal(stats.totals.speed.window.source, stats.totals.speed.outputSource);
      assert.equal(stats.totals.speed.window.seconds, stats.totals.speed.windowSeconds);
      for (const [key, value] of Object.entries(fixture.expect[stepIndex])) {
        const actual = key === "idle" ? model.speed.window.idle : model.speed[key];
        assert.deepEqual(actual, value, `step ${stepIndex} ${key}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Call frequency.

// A vLLM engine whose counters and latency histograms grow by a different
// amount every second, so the window choice is visible in the rates.
function busyVllmLines(seconds) {
  const step = Math.floor(seconds);
  const generation = step * 37 + (step % 7) * 11;
  const prompt = step * 113 + (step % 5) * 29;
  const requests = Math.floor(step / 3);
  return (name) => [
    `vllm:generation_tokens_total{model_name="${name}"} ${generation}`,
    `vllm:prompt_tokens_total{model_name="${name}"} ${prompt}`,
    `vllm:request_success_total{model_name="${name}",finished_reason="stop"} ${requests}`,
    `vllm:num_requests_running{model_name="${name}"} ${step % 2}`,
    `vllm:time_to_first_token_seconds_bucket{model_name="${name}",le="0.1"} ${requests}`,
    `vllm:time_to_first_token_seconds_bucket{model_name="${name}",le="1.0"} ${requests * 2}`,
    `vllm:time_to_first_token_seconds_bucket{model_name="${name}",le="+Inf"} ${requests * 2}`,
    `vllm:time_to_first_token_seconds_sum{model_name="${name}"} ${requests * 0.6}`,
    `vllm:time_to_first_token_seconds_count{model_name="${name}"} ${requests * 2}`,
  ];
}

async function runPollingScenario(name, pollsPerInterval) {
  const node = sampledManager("vllm", { name, engine: "vllm", linesAt: busyVllmLines });
  const base = 50_000;
  const perTick = [];
  let polled = 0;
  for (let tick = 0; tick < 16; tick += 1) {
    node.clock.set((base + tick * 10) * 1000);
    await node.sampler.tick();
    perTick.push(node.sampler.latest("primary").summary.models[0].speed);
    // UI polls between two ticks.
    for (let poll = 0; poll < pollsPerInterval; poll += 1) {
      node.clock.advance(150);
      const before = node.engineReads.count;
      const stats = node.poll();
      polled += 1;
      assert.equal(node.engineReads.count, before, "a UI poll never scrapes the engine");
      assert.ok(stats.models.length === 1);
    }
  }
  const final = node.poll();
  return { perTick, final, engineReads: node.engineReads.count, scrapes: node.sampler.stats().scrapes, polled };
}

test("rates are identical whether /api/stats is called 0, 1 or 50 times, and a poll costs no engine scrape", async () => {
  const runs = [];
  for (const [index, polls] of [0, 1, 50].entries()) runs.push(await runPollingScenario(`tel1-frequency-${index}`, polls));
  assert.deepEqual(runs.map((run) => run.polled), [0, 16, 800]);
  for (const run of runs) {
    assert.equal(run.engineReads, 16, "one engine read per sampler tick");
    assert.equal(run.scrapes, 16);
  }
  assert.deepEqual(runs[1].perTick, runs[0].perTick);
  assert.deepEqual(runs[2].perTick, runs[0].perTick);
  const finalSpeed = (run) => run.final.models[0].speed;
  assert.deepEqual(finalSpeed(runs[1]), finalSpeed(runs[0]));
  assert.deepEqual(finalSpeed(runs[2]), finalSpeed(runs[0]));
  assert.deepEqual(runs[2].final.totals, runs[0].final.totals);
  assert.deepEqual(runs[2].final.models[0].latency, runs[0].final.models[0].latency);
  // The window really moved: 150 s of samples, a 60 s baseline.
  assert.equal(finalSpeed(runs[0]).windowSeconds, 60);
  assert.ok(finalSpeed(runs[0]).recentOutputTokensPerSecond > 0);
});

// ---------------------------------------------------------------------------
// latency.window from histogram buckets.

function histogramLines(name, baseName, bounds, counts, sum) {
  return [
    ...bounds.map((bound, index) => `${baseName}_bucket{model_name="${name}",le="${bound}"} ${counts[index]}`),
    `${baseName}_sum{model_name="${name}"} ${sum}`,
    `${baseName}_count{model_name="${name}"} ${counts[counts.length - 1]}`,
  ];
}

// Every 10 s tick adds four requests: TTFT 1 x <=0.1, 1 x <=0.5, 2 x <=1;
// end-to-end 2 x <=1, 1 x <=5, 1 x <=10; and 100 inter-token gaps, half
// <=0.01 and half <=0.05. Queue time is not exported.
function latencyLines(tick) {
  return (name) => [
    `vllm:generation_tokens_total{model_name="${name}"} ${tick * 100}`,
    `vllm:request_success_total{model_name="${name}",finished_reason="stop"} ${tick * 4}`,
    ...histogramLines(name, "vllm:time_to_first_token_seconds", ["0.1", "0.5", "1.0", "+Inf"], [tick, 2 * tick, 4 * tick, 4 * tick], tick * 2),
    ...histogramLines(name, "vllm:e2e_request_latency_seconds", ["1.0", "5.0", "10.0", "+Inf"], [2 * tick, 3 * tick, 4 * tick, 4 * tick], tick * 12),
    ...histogramLines(name, "vllm:inter_token_latency_seconds", ["0.01", "0.05", "+Inf"], [50 * tick, 100 * tick, 100 * tick], tick * 2),
  ];
}

test("latency.window comes from bucket deltas over the last five minutes", async () => {
  const base = 80_000;
  const node = sampledManager("vllm", {
    name: "tel1-latency",
    engine: "vllm",
    linesAt: (seconds) => latencyLines(Math.round((seconds - base) / 10) + 1),
  });
  node.clock.set(base * 1000);
  await node.sampler.tick();
  // One snapshot: histograms exist, but there is no baseline yet.
  let stats = node.poll();
  assert.deepEqual(stats.models[0].latency.window, {
    seconds: 0, ttftP50Seconds: null, ttftP95Seconds: null, e2eP95Seconds: null, itlP50Seconds: null, queueP95Seconds: null, requests: 0,
  });
  for (let tick = 1; tick <= 30; tick += 1) {
    node.clock.set((base + tick * 10) * 1000);
    await node.sampler.tick();
  }
  stats = node.poll();
  const window = stats.models[0].latency.window;
  // 30 ticks: TTFT delta [30, 60, 120, 120], e2e [60, 90, 120, 120], ITL [1500, 3000, 3000].
  assert.equal(window.seconds, 300);
  assert.equal(window.requests, 120);
  assert.equal(window.ttftP50Seconds, 0.5);
  assert.ok(Math.abs(window.ttftP95Seconds - 0.95) < 1e-9);
  assert.ok(Math.abs(window.e2eP95Seconds - 9) < 1e-9);
  assert.equal(window.itlP50Seconds, 0.01);
  assert.equal(window.queueP95Seconds, null, "queue time is not exported");
  assert.equal(window.ttftP95Seconds, quantile({ le: [0.1, 0.5, 1, "+Inf"], counts: [30, 60, 120, 120] }, 0.95));
  assert.deepEqual(stats.totals.latency.window, window, "one model: the totals window is the model's");
  assert.equal(stats.totals.latency.scope, "since_process_start");
  // The lifetime averages are untouched.
  assert.equal(stats.models[0].latency.avgTtftSeconds, 2 * 31 / (4 * 31));

  // The ring keeps 31 snapshots, so the window stays five minutes long.
  node.clock.set((base + 310) * 1000);
  await node.sampler.tick();
  assert.equal(node.poll().models[0].latency.window.seconds, 300);
  assert.equal(node.poll().models[0].latency.window.requests, 120);

  // A new runtime starts its window from scratch.
  node.setRuntimeKey("runtime-2");
  node.clock.set((base + 320) * 1000);
  await node.sampler.tick();
  assert.equal(node.poll().models[0].latency.window.seconds, 0);
  node.clock.set((base + 330) * 1000);
  await node.sampler.tick();
  assert.equal(node.poll().models[0].latency.window.seconds, 10);
  assert.equal(node.poll().models[0].latency.window.requests, 4);
});

test("a counter that went down is never used as a latency baseline", () => {
  const hist = (counts) => ({ ttftSeconds: { le: [0.5, "+Inf"], counts, sum: null, count: counts[1] } });
  const snapshots = [
    { at: 0, histograms: { m: hist([10, 20]) } },
    { at: 10_000, histograms: { m: hist([1, 2]) } },
    { at: 20_000, histograms: { m: hist([3, 6]) } },
  ];
  const window = sampler.computeLatencyWindow(snapshots, 300).models.m;
  assert.equal(window.seconds, 10, "the pre-restart snapshot is skipped");
  assert.equal(window.requests, 4);
});

test("llama.cpp exports no latency histograms, so latency.window is null", async () => {
  const node = sampledManager("llama", {
    name: "tel1-llama-latency",
    engine: "llama",
    linesAt: (seconds) => () => [`llamacpp:tokens_predicted_total ${seconds}`, "llamacpp:predicted_tokens_seconds 30"],
  });
  for (const seconds of [100, 110]) {
    node.clock.set(seconds * 1000);
    await node.sampler.tick();
  }
  const stats = node.poll();
  assert.equal(stats.models[0].latency.window, null);
  assert.equal(stats.models[0].latency.scope, "since_process_start");
  assert.equal(stats.totals.latency.window, null);
  assert.equal(stats.models[0].speed.averageSource, "engine_lifetime_gauge");
});

test("histograms are assembled from parsed series without parsing text", () => {
  const metrics = managers.vllm.parsePrometheusMetrics([
    'vllm:e2e_request_latency_seconds_bucket{model_name="a",engine="0",le="1.0"} 2',
    'vllm:e2e_request_latency_seconds_bucket{model_name="a",engine="1",le="1.0"} 3',
    'vllm:e2e_request_latency_seconds_bucket{model_name="a",engine="0",le="5.0"} 4',
    'vllm:e2e_request_latency_seconds_bucket{model_name="a",engine="1",le="5.0"} 4',
    'vllm:e2e_request_latency_seconds_sum{model_name="a",engine="0"} 3.5',
    'vllm:e2e_request_latency_seconds_count{model_name="a",engine="0"} 9',
    'vllm:e2e_request_latency_seconds_bucket{model_name="b",le="+Inf"} 1',
    'sglang:time_to_first_token_seconds_bucket{le="0.5"} 1',
    'sglang:time_to_first_token_seconds_bucket{le="+Inf"} 2',
  ].join("\n"));
  // Bucket series are summed per le; a missing +Inf bucket takes _count.
  assert.deepEqual(sampler.histogramFromSeries(metrics.filter((m) => m.labels.model_name === "a"), "vllm:e2e_request_latency_seconds"), {
    le: [1, 5, "+Inf"], counts: [5, 8, 9], sum: 3.5, count: 9,
  });
  assert.equal(sampler.histogramFromSeries(metrics, "vllm:queue_missing"), null);
  const byModel = sampler.latencyHistogramsFromSeries(metrics, ["a", "b"]);
  assert.deepEqual(Object.keys(byModel).sort(), ["a", "b"]);
  assert.equal(byModel.a.ttftSeconds, undefined, "unlabeled series are not shared between two models");
  const single = sampler.latencyHistogramsFromSeries(metrics, ["a"]);
  assert.deepEqual(single.a.ttftSeconds.counts, [1, 2], "one model owns the unlabeled series");
  assert.deepEqual(sampler.latencyHistogramsFromSeries(metrics, ["c"], { includeUnlabeled: false }), {});
});

// ---------------------------------------------------------------------------
// The sampler itself.

test("each tick scrapes every listed instance once; lastScrape returns the last scrape text and time", async () => {
  const clock = fakeClock(1_000_000);
  const scraped = [];
  let instances = [{ id: "primary", container: CONTAINER }, { id: "side", container: { ...CONTAINER, id: "c0ffee000002" } }];
  let fail = false;
  const statsSampler = sampler.createStatsSampler({
    now: clock.now,
    listInstances: async () => instances,
    scrapeInstance: async (instance, { at }) => {
      scraped.push(instance.id);
      if (fail && instance.id === "primary") throw new Error("metrics returned 503");
      if (fail) return { summary: { error: "fetch failed" } };
      return { summary: { id: instance.id, at }, text: `# ${instance.id} ${at}`, scrapedAt: new Date(at + 5).toISOString() };
    },
    logger: { warn: () => {} },
  });
  assert.equal(statsSampler.latest("primary"), null);
  assert.equal(statsSampler.lastScrape("primary"), null);
  assert.equal(statsSampler.window("primary"), null);

  await statsSampler.tick();
  assert.deepEqual(scraped.sort(), ["primary", "side"]);
  assert.deepEqual(statsSampler.lastScrape("primary"), { text: "# primary 1000000", scrapedAt: new Date(1_000_005).toISOString() });
  const latest = statsSampler.latest("primary");
  assert.equal(latest.summary.id, "primary");
  assert.equal(latest.at, 1_000_000);
  assert.equal(latest.error, null);
  assert.equal(latest.instance.container, CONTAINER);

  // Failed reads keep the last good scrape for lastScrape and report the error.
  fail = true;
  clock.advance(10_000);
  await statsSampler.tick();
  assert.deepEqual(statsSampler.lastScrape("primary"), { text: "# primary 1000000", scrapedAt: new Date(1_000_005).toISOString() });
  assert.equal(statsSampler.latest("primary").summary, null);
  assert.equal(statsSampler.latest("primary").error, "metrics returned 503");
  assert.equal(statsSampler.latest("side").error, "fetch failed");

  // An instance that stopped is dropped.
  fail = false;
  instances = [instances[0]];
  clock.advance(10_000);
  await statsSampler.tick();
  assert.equal(statsSampler.latest("side"), null);
  assert.equal(statsSampler.lastScrape("side"), null);
  assert.deepEqual(statsSampler.lastScrape("primary"), { text: "# primary 1020000", scrapedAt: new Date(1_020_005).toISOString() });
  const stats = statsSampler.stats();
  assert.equal(stats.ticks, 3);
  assert.equal(stats.scrapes, 5);
  assert.equal(stats.scrapeErrors, 1);
  assert.deepEqual(stats.instances, ["primary"]);
});

test("concurrent ticks share one pass, and a failed listing keeps the last samples", async () => {
  let release;
  let listCalls = 0;
  let listFails = false;
  const statsSampler = sampler.createStatsSampler({
    listInstances: async () => {
      listCalls += 1;
      if (listFails) throw new Error("docker unavailable");
      await new Promise((resolve) => {
        release = resolve;
      });
      return [{ id: "primary" }];
    },
    scrapeInstance: async () => ({ summary: { ok: true } }),
    logger: { warn: () => {} },
  });
  const first = statsSampler.tick();
  const second = statsSampler.tick();
  assert.equal(first, second);
  await Promise.resolve();
  release();
  await first;
  assert.equal(listCalls, 1);
  listFails = true;
  await statsSampler.tick();
  assert.equal(statsSampler.latest("primary").summary.ok, true);
  assert.equal(statsSampler.stats().listErrors, 1);
});

test("the stats ledger is written at most once per 60 s (fake clock)", async () => {
  const clock = fakeClock(0);
  let stored = {};
  const writes = [];
  const ledgerStore = core.createStatsLedgerStore({
    file: "stats-ledger.json",
    readJsonFile: async () => JSON.parse(JSON.stringify(stored)),
    writeJsonFile: async (_file, value) => {
      writes.push(clock.now());
      stored = JSON.parse(JSON.stringify(value));
    },
  });
  const summaryAt = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const tokens = { prompt: seconds * 3, generation: seconds, cachedPrompt: 0 };
    return {
      engine: "vllm",
      processStartSeconds: 1000,
      models: [{ name: "tel1-ledger", engine: "vllm", tokens, requests: { total: seconds, success: seconds, error: 0, aborted: 0 } }],
    };
  };
  const persisted = [];
  const statsSampler = sampler.createStatsSampler({
    now: clock.now,
    listInstances: async () => [{ id: "primary", container: CONTAINER }],
    scrapeInstance: async (_instance, { at }) => ({ summary: summaryAt(at) }),
    onPersist: async (records, { at }) => {
      persisted.push(at);
      await ledgerStore.updateStatsLedger(records[0].summary);
    },
  });
  // Ticks every 10 s for five minutes, then 9.9 s ticks for two more.
  const times = [];
  for (let at = 0; at <= 300_000; at += 10_000) times.push(at);
  for (let at = 309_900; at <= 420_000; at += 9_900) times.push(at);
  for (const at of times) {
    clock.set(at);
    await statsSampler.tick();
    // /api/stats between ticks: a preview, never a write.
    const before = writes.length;
    const preview = await ledgerStore.previewStatsLedger(summaryAt(at));
    assert.equal(writes.length, before);
    assert.equal(preview.models["tel1-ledger"].tokens.generation, Math.floor(at / 1000));
  }
  assert.deepEqual(persisted.slice(0, 6), [0, 60_000, 120_000, 180_000, 240_000, 300_000]);
  assert.deepEqual(writes, persisted);
  for (let index = 1; index < writes.length; index += 1) {
    assert.ok(writes[index] - writes[index - 1] >= 60_000, `write ${index} came ${writes[index] - writes[index - 1]} ms after the previous one`);
  }
  assert.equal(statsSampler.stats().persists, writes.length);
  // The persisted totals equal the counters of the last persisted sample.
  assert.equal(stored.models["tel1-ledger"].tokens.generation, Math.floor(writes.at(-1) / 1000));
});

test("a failing persist is counted and does not stop sampling", async () => {
  const clock = fakeClock(0);
  const statsSampler = sampler.createStatsSampler({
    now: clock.now,
    listInstances: async () => [{ id: "primary" }],
    scrapeInstance: async () => ({ summary: {} }),
    onPersist: async () => {
      throw new Error("disk full");
    },
    logger: { warn: () => {} },
  });
  await statsSampler.tick();
  clock.advance(60_000);
  await statsSampler.tick();
  assert.equal(statsSampler.stats().persistErrors, 2);
  assert.equal(statsSampler.stats().ticks, 2);
});

test("start samples at once and then every interval; stop ends the loop", async () => {
  const scheduled = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      handle.cleared = true;
    },
  };
  let ticks = 0;
  const statsSampler = sampler.createStatsSampler({
    intervalMs: 1000,
    timers,
    now: () => 0,
    listInstances: async () => {
      ticks += 1;
      return [];
    },
    scrapeInstance: async () => ({}),
  });
  assert.equal(statsSampler.stats().intervalMs, 5000, "the interval is at least 5 s");
  statsSampler.start();
  statsSampler.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 0);
  await scheduled[0].fn();
  assert.equal(ticks, 1);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].ms, 5000);
  await statsSampler.stop();
  assert.equal(scheduled[1].cleared, true);
  await scheduled[1].fn();
  assert.equal(ticks, 1, "a timer of a stopped loop does nothing");
  assert.equal(scheduled.length, 2);
});

test("stop waits for a pass in flight, but not for one that hangs", async () => {
  let release;
  const persisted = [];
  const statsSampler = sampler.createStatsSampler({
    listInstances: async () => [{ id: "primary" }],
    scrapeInstance: () => new Promise((resolve) => {
      release = () => resolve({ summary: { ok: true } });
    }),
    onPersist: async () => {
      persisted.push(true);
    },
  });
  const pass = statsSampler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = statsSampler.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await stopping;
  await pass;
  assert.deepEqual(persisted, [true], "the pass finished its ledger write before stop resolved");

  const hanging = sampler.createStatsSampler({
    stopWaitMs: 0,
    listInstances: async () => [{ id: "primary" }],
    scrapeInstance: () => new Promise(() => {}),
  });
  hanging.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await hanging.stop();
});

test("STATS_SAMPLE_INTERVAL_MS is 10 s by default and clamped to 5-60 s", () => {
  assert.equal(sampler.resolveStatsSampleIntervalMs(undefined), 10_000);
  assert.equal(sampler.resolveStatsSampleIntervalMs(""), 10_000);
  assert.equal(sampler.resolveStatsSampleIntervalMs("abc"), 10_000);
  assert.equal(sampler.resolveStatsSampleIntervalMs("1000"), 5000);
  assert.equal(sampler.resolveStatsSampleIntervalMs("15000"), 15_000);
  assert.equal(sampler.resolveStatsSampleIntervalMs(120_000), 60_000);
  assert.throws(() => sampler.createStatsSampler({}), /scrapeInstance/);
});

test("sampledStatsSummary only serves a sample of the container that is running now", async () => {
  const statsSampler = sampler.createStatsSampler({
    listInstances: async () => [{ id: "primary", container: CONTAINER }],
    scrapeInstance: async () => ({ summary: { models: [], totals: {}, gpu: { name: "old" } } }),
  });
  const empty = core.emptyStatsSummary(CONTAINER, null, { stoppedNote: "stopped" });
  const stopped = sampler.sampledStatsSummary(statsSampler, "primary", { container: { ...CONTAINER, running: false }, empty });
  assert.equal(stopped.summary, empty);
  assert.equal(stopped.latency, null);
  const notYet = sampler.sampledStatsSummary(statsSampler, "primary", { container: CONTAINER, empty });
  assert.match(notYet.summary.note, /sampled/);
  await statsSampler.tick();
  const replaced = sampler.sampledStatsSummary(statsSampler, "primary", { container: { ...CONTAINER, id: "c0ffee0000ff" }, empty });
  assert.match(replaced.summary.note, /sampled/);
  const current = sampler.sampledStatsSummary(statsSampler, "primary", { container: CONTAINER, empty, gpu: { name: "now" } });
  assert.equal(current.summary.gpu.name, "now");
  assert.deepEqual(current.latency, { seconds: 300, models: {}, totals: null });

  const failing = sampler.createStatsSampler({
    listInstances: async () => [{ id: "primary", container: CONTAINER }],
    scrapeInstance: async () => {
      throw new Error("metrics returned 500");
    },
  });
  await failing.tick();
  const failed = sampler.sampledStatsSummary(failing, "primary", { container: CONTAINER, empty });
  assert.equal(failed.summary.error, "metrics returned 500");
  assert.equal(failed.summary.note, "stopped");
});

test("applyStatsWindows only adds fields and handles summaries without models", () => {
  const empty = core.emptyStatsSummary(null, null);
  const decorated = sampler.applyStatsWindows(empty, null);
  assert.deepEqual(omit(decorated.totals.speed, ["window"]), empty.totals.speed);
  assert.deepEqual(decorated.totals.speed.window, { seconds: 0, source: "unavailable", idle: true });
  assert.deepEqual(decorated.totals.latency, { scope: "since_process_start", window: null });
  assert.deepEqual(decorated.models, []);
  assert.equal(sampler.applyStatsWindows(null), null);
  // Idempotent.
  assert.deepEqual(sampler.applyStatsWindows(decorated, null), decorated);
});

test("trends are downsampled to at most 288 points, newest kept", () => {
  const samples = Array.from({ length: 1440 }, (_, index) => ({ at: new Date(index * 60_000).toISOString(), index }));
  const kept = sampler.downsampleTrendSamples(samples);
  assert.equal(kept.length, 288);
  assert.equal(kept.at(-1).index, 1439);
  assert.ok(kept.every((sample, index) => index === 0 || sample.index > kept[index - 1].index));
  assert.deepEqual(sampler.downsampleTrendSamples(samples.slice(0, 10)), samples.slice(0, 10));
  assert.deepEqual(sampler.downsampleTrendSamples(undefined), []);
});

// ---------------------------------------------------------------------------
// Wiring in both managers.

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const open = source.indexOf("{", start + signature.length - 1);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

for (const [managerId, file] of Object.entries(SERVER_FILES)) {
  test(`${managerId}-manager: /api/stats reads the sampler and never scrapes (no updateSamples: true)`, () => {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /updateSamples\s*:\s*true/);
    const collectStats = functionBody(source, "async function collectStats() {");
    assert.match(collectStats, /core\.telemetry\.sampledStatsSummary\(statsSampler, "primary"/);
    assert.match(collectStats, /previewStatsLedger\(/);
    for (const forbidden of [/collectVllmMetricsSummary/, /fetch\(/, /updateStatsLedger\(/, /recordMetricsHistory\(/, /sampleCacheHitStats\(/]) {
      assert.doesNotMatch(collectStats, forbidden);
    }
    assert.match(source, /core\.telemetry\.createStatsSampler\(\{\s*intervalMs: core\.telemetry\.resolveStatsSampleIntervalMs\(process\.env\.STATS_SAMPLE_INTERVAL_MS\)/);
    assert.equal(typeof managers[managerId].statsSampler.lastScrape, "function");
    assert.equal(managers[managerId].statsSampler.stats().started, false, "requiring the manager starts no timer");
  });
}

test("core.telemetry is a namespace with the sampler", () => {
  assert.equal(core.telemetry.createStatsSampler, sampler.createStatsSampler);
  assert.equal(core.telemetry.statsSampler, sampler);
  assert.equal(core.createStatsSampler, undefined, "not spread into the flat exports");
});
