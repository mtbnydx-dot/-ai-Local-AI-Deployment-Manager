"use strict";

// engines/metrics.js and GET /api/instances/:id/metrics (01-engines §16.1,
// ENG-14): the parser on recorded-format /metrics fixtures per engine, the
// cumulative mapping onto canonical keys, the summary, the descriptor seed
// maps, and the background sampler behind the route. Engines are fakes or a
// throwaway HTTP server on an ephemeral port; Docker is never called.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-metrics-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const histogram = require("../telemetry/histogram");
const { parsePrometheusMetrics } = require("../prometheus-utils");

const metrics = core.engines.metrics;
const FIXTURES = path.join(__dirname, "fixtures", "engines", "metrics");
const SCRAPED_AT = Date.parse("2026-10-14T08:00:10.004Z");
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function registry() {
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-metrics-override-"));
  test.after(() => fs.rmSync(overrideDir, { recursive: true, force: true }));
  return core.engines.createEngineRegistry({ overrideDir, env: {} });
}

const REGISTRY = registry();

function mapFixture(engineId, name, options = {}) {
  return metrics.mapPrometheus(engineId, metrics.parsePrometheus(fixture(name)), { registry: REGISTRY, ...options });
}

// Every object key in a metrics/raw payload is camelCase; the finish-reason
// split is keyed by the engine's own reason names.
function assertCamelCaseKeys(value, where) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCamelCaseKeys(item, `${where}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.match(key, CAMEL_CASE, `${where}.${key}`);
    if (key === "requestsByFinishReason" || key === "requestsByFinishReasonTotal") continue;
    assertCamelCaseKeys(item, `${where}.${key}`);
  }
}

test("core.engines.metrics exposes the parser, the mapper, the summary, the histogram helpers and the sampler", () => {
  for (const name of ["parsePrometheus", "mapPrometheus", "summarize", "deltaCumulative", "quantile", "createInstanceMetricsSampler"]) {
    assert.equal(typeof metrics[name], "function", name);
  }
  // One implementation of the histogram helpers, shared with 04.
  assert.equal(metrics.deltaCumulative, histogram.deltaCumulative);
  assert.equal(metrics.quantile, histogram.quantile);
  assert.equal(typeof core.engines.readInstanceMetrics, "function");
});

test("parsePrometheus reads the recorded vLLM exposition: families, Go-style floats and empty label values", () => {
  const parsed = metrics.parsePrometheus(fixture("vllm.prom"));
  assert.equal(parsed.types["vllm:prompt_tokens_total"], "counter");
  assert.equal(parsed.types["vllm:prompt_tokens_created"], "gauge");
  assert.equal(parsed.types["vllm:num_requests_running"], "gauge");
  assert.equal(parsed.types["vllm:time_to_first_token_seconds"], "histogram");
  assert.equal(parsed.types.process_start_time_seconds, "gauge");
  const prompt = parsed.samples.find((sample) => sample.name === "vllm:prompt_tokens_total");
  assert.deepEqual(prompt, { name: "vllm:prompt_tokens_total", labels: { engine: "0", model_name: "qwen3.8-27b" }, value: 1203345 });
  assert.equal(parsed.samples.find((sample) => sample.name === "process_start_time_seconds").value, 1760400000);
  const lora = parsed.samples.find((sample) => sample.name === "vllm:lora_requests_info");
  assert.deepEqual(lora.labels, { max_lora: "0", running_lora_adapters: "", waiting_lora_adapters: "" });
  const infBucket = parsed.samples.find((sample) => sample.name === "vllm:time_to_first_token_seconds_bucket" && sample.labels.le === "+Inf");
  assert.equal(infBucket.value, 912);
});

test("parsePrometheus agrees with the managers' parser on every recorded fixture", () => {
  for (const name of ["vllm.prom", "vllm-later.prom", "sglang.prom", "llamacpp.prom"]) {
    const text = fixture(name);
    const parsed = metrics.parsePrometheus(text);
    assert.deepEqual(parsed.samples, parsePrometheusMetrics(text), name);
    assert.ok(parsed.samples.length > 10, name);
  }
  const sglang = metrics.parsePrometheus(fixture("sglang.prom"));
  assert.equal(sglang.types["sglang:prompt_tokens_total"], "counter");
  assert.equal(sglang.types["sglang:token_usage"], "gauge");
  assert.equal(sglang.types["sglang:time_to_first_token_seconds"], "histogram");
  const llama = metrics.parsePrometheus(fixture("llamacpp.prom"));
  assert.equal(llama.types["llamacpp:tokens_predicted_total"], "counter");
  assert.equal(llama.types["llamacpp:requests_processing"], "gauge");
  assert.ok(llama.samples.every((sample) => Object.keys(sample.labels).length === 0));
});

test("parsePrometheus is tolerant: escapes, comments, CRLF, timestamps, odd values and broken lines", () => {
  const text = [
    "# HELP odd A help line with \"quotes\"",
    "# TYPE odd_metric gauge",
    "# TYPE latency summary",
    "# just a comment",
    "",
    "odd_metric{path=\"a\\\\x\",quote=\"say \\\"hi\\\"\",multi=\"a\\nb\",brace=\"}{,=\"} 3 1760400000000",
    "odd_metric{trailing=\"comma\",} 4\r",
    "odd_metric{__proto__=\"polluted\",kind=\"proto\"} 5",
    "odd_metric{kind=\"dup\",kind=\"second\"} 6",
    "latency{quantile=\"0.5\"} 0.25",
    "latency_sum 10",
    "untyped_metric 7",
    "nan_metric NaN",
    "inf_metric +Inf",
    "neg_inf_metric -Inf",
    "broken{label=\"unterminated} 1",
    "broken{=\"x\"} 1",
    "broken_value abc",
    "nolabelvalue{a=} 1",
    "9starts_with_digit 1",
    "name_without_value",
    "exp_metric 1.5e+03",
  ].join("\n");
  const parsed = metrics.parsePrometheus(text);
  const odd = parsed.samples.filter((sample) => sample.name === "odd_metric");
  assert.deepEqual(odd.map((sample) => sample.value), [3, 4, 5, 6]);
  assert.deepEqual(odd[0].labels, { path: "a\\x", quote: "say \"hi\"", multi: "a\nb", brace: "}{,=" });
  assert.deepEqual(odd[1].labels, { trailing: "comma" });
  assert.deepEqual(odd[2].labels, { kind: "proto" });
  assert.equal(Object.getPrototypeOf(odd[2].labels), Object.prototype);
  assert.deepEqual(odd[3].labels, { kind: "dup" });
  assert.equal(parsed.types.odd_metric, "gauge");
  assert.equal(parsed.types.latency, "untyped", "a summary reads as untyped");
  assert.equal(parsed.types.untyped_metric, "untyped", "a sample without # TYPE is its own untyped family");
  assert.equal(parsed.samples.find((sample) => sample.name === "exp_metric").value, 1500);
  for (const name of ["nan_metric", "inf_metric", "neg_inf_metric", "broken", "broken_value", "nolabelvalue", "name_without_value"]) {
    assert.ok(!parsed.samples.some((sample) => sample.name === name), name);
  }
  assert.ok(!parsed.samples.some((sample) => sample.name.startsWith("9")));
});

test("parsePrometheus refuses more than 4 MiB of text", () => {
  const line = "filler_metric{pad=\"" + "x".repeat(1000) + "\"} 1\n";
  const text = line.repeat(Math.ceil((metrics.MAX_METRICS_TEXT_BYTES + 1) / line.length));
  assert.throws(() => metrics.parsePrometheus(text), (error) => error.code === "metrics_too_large");
  assert.equal(metrics.parsePrometheus(line.repeat(100)).samples.length, 100);
});

test("mapPrometheus keeps vLLM histograms cumulative and fills every canonical key", () => {
  const mapped = mapFixture("vllm", "vllm.prom");
  assert.equal(mapped.processStartSeconds, 1760400000);
  assert.equal(mapped.models.length, 1);
  const [model] = mapped.models;
  assert.equal(model.model, "qwen3.8-27b");
  for (const [group, keys] of Object.entries(metrics.CANONICAL_METRIC_KEYS)) {
    for (const key of keys) assert.ok(Object.hasOwn(model[group], key), `${group}.${key}`);
  }
  assert.deepEqual(model.counters.requestsByFinishReason, { abort: 9, error: 2, length: 21, stop: 880 });
  assert.deepEqual(model.counters.requestsByFinishReasonTotal, model.counters.requestsByFinishReason);
  assert.equal(model.counters.requestsTotal, 912);
  assert.equal(model.counters.promptTokensTotal, 1203345);
  assert.equal(model.counters.cachedPromptTokensTotal, 803000);
  assert.equal(model.counters.preemptionsTotal, 0);
  assert.equal(model.counters.specDraftsTotal, 141633);
  assert.equal(model.gauges.kvUsageRatio, 0.31);
  assert.equal(model.gauges.kvCapacityTokens, null);
  assert.deepEqual(model.histograms.ttftSeconds, {
    le: [0.001, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 20, 40, 80, 160, 640, 2560, "+Inf"],
    counts: [0, 0, 0, 0, 0, 0, 0, 100, 301, 611, 812, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912, 912],
    sum: 402.1,
    count: 912,
  });
  for (const key of metrics.CANONICAL_METRIC_KEYS.histograms) {
    const hist = model.histograms[key];
    assert.equal(hist.le.length, hist.counts.length, key);
    assert.equal(hist.le.at(-1), "+Inf", key);
    assert.equal(hist.counts.at(-1), hist.count, key);
    assert.ok(hist.counts.every((count, index) => index === 0 || count >= hist.counts[index - 1]), `${key} is cumulative`);
  }
  assert.deepEqual(mapped.unsupported, ["gauges.kvCapacityTokens", "gauges.specAcceptRate", "gauges.genThroughputTps"]);
  assertCamelCaseKeys(mapped, "raw");
});

test("mapPrometheus sums every label except model_name and le, and ratio gauges take the largest value", () => {
  const text = [
    "# TYPE vllm:prompt_tokens_total counter",
    "vllm:prompt_tokens_total{engine=\"0\",model_name=\"m\"} 100",
    "vllm:prompt_tokens_total{engine=\"1\",model_name=\"m\"} 50",
    "vllm:request_success_total{engine=\"0\",finished_reason=\"stop\",model_name=\"m\"} 7",
    "vllm:request_success_total{engine=\"1\",finished_reason=\"stop\",model_name=\"m\"} 3",
    "vllm:request_success_total{engine=\"1\",finished_reason=\"length\",model_name=\"m\"} 1",
    "vllm:num_requests_running{engine=\"0\",model_name=\"m\"} 2",
    "vllm:num_requests_running{engine=\"1\",model_name=\"m\"} 1",
    "vllm:kv_cache_usage_perc{engine=\"0\",model_name=\"m\"} 0.4",
    "vllm:kv_cache_usage_perc{engine=\"1\",model_name=\"m\"} 0.7",
    "vllm:time_to_first_token_seconds_bucket{engine=\"0\",le=\"0.5\",model_name=\"m\"} 4",
    "vllm:time_to_first_token_seconds_bucket{engine=\"0\",le=\"+Inf\",model_name=\"m\"} 6",
    "vllm:time_to_first_token_seconds_bucket{engine=\"1\",le=\"0.5\",model_name=\"m\"} 1",
    "vllm:time_to_first_token_seconds_bucket{engine=\"1\",le=\"+Inf\",model_name=\"m\"} 4",
    "vllm:time_to_first_token_seconds_sum{engine=\"0\",model_name=\"m\"} 3",
    "vllm:time_to_first_token_seconds_sum{engine=\"1\",model_name=\"m\"} 2",
    "vllm:time_to_first_token_seconds_count{engine=\"0\",model_name=\"m\"} 6",
    "vllm:time_to_first_token_seconds_count{engine=\"1\",model_name=\"m\"} 4",
    "vllm:generation_tokens_total{model_name=\"other\"} 9",
    "vllm:num_requests_waiting 5",
  ].join("\n");
  const mapped = metrics.mapPrometheus("vllm", metrics.parsePrometheus(text), { registry: REGISTRY });
  assert.deepEqual(mapped.models.map((model) => model.model), ["m", "other", null]);
  const [m, other, unlabelled] = mapped.models;
  assert.equal(m.counters.promptTokensTotal, 150);
  assert.equal(m.counters.requestsTotal, 11);
  assert.deepEqual(m.counters.requestsByFinishReason, { stop: 10, length: 1 });
  assert.equal(m.gauges.requestsRunning, 3);
  assert.equal(m.gauges.kvUsageRatio, 0.7);
  assert.deepEqual(m.histograms.ttftSeconds, { le: [0.5, "+Inf"], counts: [5, 10], sum: 5, count: 10 });
  assert.equal(other.counters.generationTokensTotal, 9);
  assert.equal(other.counters.promptTokensTotal, null);
  // Two labelled models: an unlabelled sample cannot be attributed to either.
  assert.equal(unlabelled.gauges.requestsWaiting, 5);

  // With a single labelled model, unlabelled samples are that model's.
  const single = metrics.mapPrometheus("vllm", metrics.parsePrometheus([
    "vllm:prompt_tokens_total{model_name=\"m\"} 10",
    "vllm:num_requests_waiting 2",
  ].join("\n")), { registry: REGISTRY });
  assert.equal(single.models.length, 1);
  assert.equal(single.models[0].gauges.requestsWaiting, 2);

  const summary = metrics.summarize(mapped);
  assert.equal(summary.promptTokensTotal, 150);
  assert.equal(summary.generationTokensTotal, 9);
  assert.equal(summary.kvUsageRatio, 0.7);
  assert.equal(summary.requestsWaiting, 5);
});

test("SGLang maps full-attention KV usage first, and a genuine zero does not fall back", () => {
  const mapped = mapFixture("sglang", "sglang.prom");
  const [model] = mapped.models;
  assert.equal(model.model, "qwen3.8-flash-next");
  assert.equal(model.gauges.kvUsageRatio, 0.31, "full_token_usage, not the 0.62 max(KV, SWA, Mamba) token_usage");
  assert.equal(model.gauges.kvCapacityTokens, 262144);
  assert.equal(model.gauges.genThroughputTps, 41.5);
  assert.equal(model.counters.prefixQueriesTotal, model.counters.promptTokensTotal);
  assert.equal(model.counters.prefixHitsTotal, model.counters.cachedPromptTokensTotal);
  assert.deepEqual(mapped.unsupported, [
    "counters.requestsByFinishReason",
    "counters.preemptionsTotal",
    "counters.specDraftTokensTotal",
    "counters.specAcceptedTokensTotal",
    "histograms.tpotSeconds",
  ]);
  const zero = fixture("sglang.prom").replace(/^(sglang:full_token_usage\{[^}]*\}) .*$/m, "$1 0.0");
  const zeroMapped = metrics.mapPrometheus("sglang", metrics.parsePrometheus(zero), { registry: REGISTRY });
  assert.equal(zeroMapped.models[0].gauges.kvUsageRatio, 0);
  const noFull = fixture("sglang.prom").split("\n").filter((line) => !line.startsWith("sglang:full_token_usage")).join("\n");
  assert.equal(metrics.mapPrometheus("sglang", metrics.parsePrometheus(noFull), { registry: REGISTRY }).models[0].gauges.kvUsageRatio, 0.62);
});

test("llama.cpp fills kvUsageRatio and cached tokens from the manager's derived inputs", () => {
  const derived = { busySlots: 1, nSlots: 4, cacheHit: { cachedTokens: 31000 } };
  const mapped = mapFixture("llamacpp", "llamacpp.prom", { derived, defaultModel: "glimmer-q4" });
  assert.equal(mapped.processStartSeconds, null, "llama-server exports no process metrics");
  assert.equal(mapped.models.length, 1);
  const [model] = mapped.models;
  assert.equal(model.model, "glimmer-q4");
  assert.equal(model.counters.promptTokensTotal, 58210);
  assert.equal(model.counters.generationTokensTotal, 20480);
  assert.equal(model.counters.cachedPromptTokensTotal, 31000);
  assert.equal(model.gauges.requestsRunning, 1);
  assert.equal(model.gauges.kvUsageRatio, 0.25);
  for (const key of metrics.CANONICAL_METRIC_KEYS.histograms) assert.ok(mapped.unsupported.includes(`histograms.${key}`), key);
  assert.ok(!mapped.unsupported.includes("gauges.kvUsageRatio"));

  // The engine's own gauge wins when it exports one.
  const withRatio = `${fixture("llamacpp.prom")}llamacpp:kv_cache_usage_ratio 0.5\n`;
  assert.equal(metrics.mapPrometheus("llamacpp", metrics.parsePrometheus(withRatio), { registry: REGISTRY, derived }).models[0].gauges.kvUsageRatio, 0.5);

  const bare = mapFixture("llamacpp", "llamacpp.prom");
  assert.equal(bare.models[0].model, null);
  assert.equal(bare.models[0].gauges.kvUsageRatio, null);
  assert.ok(bare.unsupported.includes("gauges.kvUsageRatio"));
  assert.ok(bare.unsupported.includes("counters.cachedPromptTokensTotal"));
  const noSlots = mapFixture("llamacpp", "llamacpp.prom", { derived: { busySlots: 0, nSlots: 0 } });
  assert.equal(noSlots.models[0].gauges.kvUsageRatio, null, "a ratio over zero slots has no value");
});

test("derive expressions read dotted paths and refuse anything else", () => {
  const derived = { a: 3, b: 4, nested: { c: "6" }, zero: 0 };
  assert.equal(metrics.evaluateDerive("a/b", derived), 0.75);
  assert.equal(metrics.evaluateDerive("nested.c", derived), 6);
  assert.equal(metrics.evaluateDerive("nested.c/a", derived), 2);
  assert.equal(metrics.evaluateDerive("a/zero", derived), null);
  assert.equal(metrics.evaluateDerive("missing", derived), null);
  assert.equal(metrics.evaluateDerive("a*b", derived), null);
  assert.equal(metrics.evaluateDerive("constructor", derived), null);
  assert.equal(metrics.evaluateDerive("__proto__.x", derived), null);
});

test("summarize gives since-start percentiles, and interval percentiles with a previous snapshot", () => {
  const first = mapFixture("vllm", "vllm.prom");
  const later = mapFixture("vllm", "vllm-later.prom");
  const summary = metrics.summarize(first);
  const ttft = first.models[0].histograms.ttftSeconds;
  assert.deepEqual(summary.ttftSeconds, {
    avg: 402.1 / 912,
    p50: histogram.quantile(ttft, 0.5),
    p95: histogram.quantile(ttft, 0.95),
    count: 912,
  });
  assert.equal(summary.ttftSeconds.p50, 0.375);
  assert.equal(summary.promptTokensTotal, 1203345);
  assert.deepEqual(summary.requestsByFinishReason, { abort: 9, error: 2, length: 21, stop: 880 });
  assert.ok(!Object.hasOwn(summary, "requestsByFinishReasonTotal"));
  assert.equal(summary.specAcceptRate, 260117 / 424899, "accepted / draft tokens without an engine gauge");
  assert.equal(summary.kvCapacityTokens, null);
  for (const key of metrics.CANONICAL_METRIC_KEYS.histograms) assert.deepEqual(Object.keys(summary[key]), ["avg", "p50", "p95", "count"], key);
  assertCamelCaseKeys(summary, "metrics");

  const interval = metrics.summarize(later, { previous: first });
  const delta = histogram.deltaCumulative(ttft, later.models[0].histograms.ttftSeconds);
  assert.equal(interval.ttftSeconds.count, 100);
  assert.equal(interval.ttftSeconds.avg, (452.1 - 402.1) / 100);
  assert.equal(interval.ttftSeconds.p95, histogram.quantile(delta, 0.95));
  assert.equal(interval.promptTokensTotal, 1343345, "counters stay cumulative");

  // A restart (counts went down) falls back to the time since process start.
  const afterReset = metrics.summarize(first, { previous: later });
  assert.deepEqual(afterReset.ttftSeconds, summary.ttftSeconds);

  const empty = metrics.summarize({ models: [] });
  assert.equal(empty.promptTokensTotal, null);
  assert.equal(empty.ttftSeconds, null);
});

test("the bundled descriptors seed metricsMap with canonical keys and the histogram kind", () => {
  assert.deepEqual(REGISTRY.errors(), []);
  const canonical = new Map(Object.entries(metrics.CANONICAL_METRIC_KEYS).flatMap(([group, keys]) => keys.map((key) => [key, group])));
  for (const engineId of ["vllm", "sglang", "llamacpp"]) {
    const { metricsMap } = REGISTRY.get(engineId);
    assert.equal(metricsMap.path, "/metrics", engineId);
    assert.equal(metricsMap.format, "prometheus", engineId);
    const keys = Object.keys(metricsMap.map);
    assert.ok(keys.length >= 6, engineId);
    for (const [key, sources] of Object.entries(metricsMap.map)) {
      assert.ok(canonical.has(key), `${engineId}.${key} is a canonical key`);
      for (const source of sources) {
        if (source.derive) {
          assert.match(source.derive, core.engines.descriptorSchema.METRIC_DERIVE_PATTERN);
          continue;
        }
        const expected = { counters: "counter", gauges: "gauge", histograms: "histogram" }[canonical.get(key)];
        assert.equal(source.kind, expected, `${engineId}.${key} ${source.name}`);
      }
    }
  }
  assert.ok(Object.keys(REGISTRY.get("vllm").metricsMap.map).includes("ttftSeconds"));
  assert.deepEqual(REGISTRY.get("llamacpp").metricsMap.map.kvUsageRatio, [
    { name: "llamacpp:kv_cache_usage_ratio", kind: "gauge" },
    { derive: "busySlots/nSlots" },
  ]);
  // The validator checks the derive grammar too.
  const bad = core.engines.validateDescriptor({ id: "vllm", metricsMap: { path: "/metrics", format: "prometheus", map: { kvUsageRatio: [{ derive: "busy*slots" }] } } }, { mode: "override" });
  assert.deepEqual(bad.errors.map((item) => `${item.path}:${item.code}`), ["metricsMap.map.kvUsageRatio[0].derive:pattern"]);
});

test("mapPrometheus rejects an unknown engine and maps keys an override adds", () => {
  assert.throws(() => metrics.mapPrometheus("nope", { samples: [] }, { registry: REGISTRY }), (error) => error.code === "unknown_engine");
  const descriptor = {
    id: "vllm",
    metricsMap: { path: "/metrics", format: "prometheus", map: {
      promptTokensTotal: [{ name: "custom_prompt_total", kind: "counter", scale: 2 }],
      swapRatio: [{ name: "custom_swap", kind: "gauge" }],
    } },
  };
  const mapped = metrics.mapPrometheus("vllm", metrics.parsePrometheus("custom_prompt_total 5\ncustom_swap 0.5\n"), { descriptor });
  assert.equal(mapped.models[0].counters.promptTokensTotal, 10);
  assert.equal(mapped.models[0].gauges.swapRatio, 0.5);
  assert.ok(!mapped.unsupported.includes("gauges.swapRatio"));
  assert.equal(metrics.summarize(mapped).swapRatio, 0.5);
});

// ---------------------------------------------------------------------------
// Sampler and route

function sglangImage() {
  return REGISTRY.defaultRuntime("sglang").image;
}

function container(overrides = {}) {
  const { labels = {}, ...rest } = overrides;
  return {
    exists: true,
    running: true,
    id: "3f2a9c41d2e7",
    name: "vllm-local",
    image: sglangImage(),
    createdAt: "2026-10-14 07:59:00 +0000 UTC",
    ...rest,
    labels: {
      "ai.manager": "vllm-manager",
      "ai.manager.engine": "sglang",
      "ai.manager.port": "8000",
      "ai.manager.model": "qwen3.8-flash-next",
      ...labels,
    },
  };
}

function fakeEngines(byPort = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers, signal: init.signal });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const handler = byPort[new URL(url).port];
      if (!handler) throw new TypeError("fetch failed");
      return await handler(init);
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

function promResponse(text, status = 200) {
  return new Response(text, { status, headers: { "content-type": "text/plain; version=0.0.4" } });
}

function sampler(options = {}) {
  let containers = options.containers || [container()];
  let listCalls = 0;
  const engines = options.engines || fakeEngines({ 8000: () => promResponse(fixture("sglang.prom")) });
  const instance = metrics.createInstanceMetricsSampler({
    registry: REGISTRY,
    managerId: options.managerId || "vllm",
    ownerLabelValue: options.ownerLabelValue || "vllm-manager",
    primaryContainerName: options.primaryContainerName ?? "vllm-local",
    listContainers: async () => {
      listCalls += 1;
      if (options.listError) throw new Error("docker is not running");
      return containers;
    },
    fetchImpl: engines.fetchImpl,
    now: () => SCRAPED_AT,
    ...options.extra,
  });
  return {
    instance,
    engines,
    listCalls: () => listCalls,
    setContainers: (next) => {
      containers = next;
    },
  };
}

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

function mountMetricsRoute(metricsSampler, extraDeps = {}) {
  const app = recordingApp();
  core.engines.registerEngineRoutes(app, { registry: REGISTRY, managerId: "vllm", metricsSampler, ...extraDeps });
  const handler = app.routes.get("GET /api/instances/:id/metrics");
  assert.equal(typeof handler, "function");
  return async (id) => {
    const res = fakeResponse();
    await handler({ params: { id }, query: {}, headers: {} }, res);
    return res;
  };
}

test("the route serves the sampler snapshot in the §16.1 shape without scraping on the request path", async () => {
  const launchId = "lch_0123456789abcdefghjk";
  const harness = sampler({ containers: [container({ labels: { "ai.manager.launch-id": launchId } })] });
  await harness.instance.tick();
  assert.equal(harness.engines.calls.length, 1);
  assert.equal(harness.engines.calls[0].url, "http://127.0.0.1:8000/metrics");
  assert.ok(harness.engines.calls[0].signal, "every scrape carries a timeout signal");
  const scrapesAfterTick = harness.engines.calls.length;
  const listingsAfterTick = harness.listCalls();

  const get = mountMetricsRoute(harness.instance);
  const res = await get("primary");
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.deepEqual(Object.keys(body), [
    "ok", "fleetId", "managerId", "instanceId", "engineId", "runtimeId", "launchId", "runtimeKey", "processStartSeconds",
    "scrapedAt", "scrapeOk", "errorCode", "metrics", "raw", "facts", "unsupported",
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.fleetId, "vllm:primary");
  assert.equal(body.managerId, "vllm");
  assert.equal(body.instanceId, "primary");
  assert.equal(body.engineId, "sglang");
  assert.equal(body.runtimeId, REGISTRY.defaultRuntime("sglang").runtimeId);
  assert.equal(body.launchId, launchId);
  assert.equal(body.runtimeKey, "sglang:3f2a9c:1760400000");
  assert.equal(body.processStartSeconds, 1760400000);
  assert.equal(body.scrapedAt, "2026-10-14T08:00:10.004Z");
  assert.equal(body.scrapeOk, true);
  assert.equal(body.errorCode, null);
  assert.deepEqual(body.facts, {});
  // metrics is the summary, raw the cumulative mapping, both camelCase.
  const mapped = mapFixture("sglang", "sglang.prom", { defaultModel: "qwen3.8-flash-next" });
  assert.deepEqual(body.metrics, JSON.parse(JSON.stringify(metrics.summarize(mapped))));
  assert.deepEqual(body.raw, JSON.parse(JSON.stringify({ processStartSeconds: 1760400000, models: mapped.models })));
  assert.equal(body.metrics.kvUsageRatio, 0.31);
  assert.deepEqual(Object.keys(body.metrics.ttftSeconds), ["avg", "p50", "p95", "count"]);
  assert.deepEqual(body.raw.models[0].histograms.ttftSeconds.counts.at(-1), 912);
  assert.deepEqual(body.unsupported, mapped.unsupported);
  assertCamelCaseKeys(body.metrics, "metrics");
  assertCamelCaseKeys(body.raw, "raw");

  // The container name resolves to the same instance.
  assert.equal((await get("vllm-local")).body.instanceId, "primary");
  for (let index = 0; index < 25; index += 1) {
    assert.equal((await get("primary")).statusCode, 200);
  }
  assert.equal(harness.engines.calls.length, scrapesAfterTick, "no scrape on the request path");
  assert.equal(harness.listCalls(), listingsAfterTick, "no Docker listing on the request path");
  // Callers get copies; the stored snapshot does not change.
  body.metrics.promptTokensTotal = -1;
  assert.equal(harness.instance.read("primary").metrics.promptTokensTotal, 1203345);
});

test("an unknown or unowned id is 404 unknown_instance without Docker, and 503 before the first listing", async () => {
  const harness = sampler({
    containers: [
      container(),
      container({ name: "llama-local", id: "aaaaaaaaaaaa", labels: { "ai.manager": "llama-manager", "ai.manager.engine": "llama" } }),
      container({ name: "vllm-mystery", id: "bbbbbbbbbbbb", labels: { "ai.manager.engine": "mystery", "ai.manager.instance": "mystery" } }),
    ],
  });
  const get = mountMetricsRoute(harness.instance);
  const early = await get("primary");
  assert.equal(early.statusCode, 503);
  assert.equal(early.body.error.code, "metrics_not_ready");
  assert.equal(harness.listCalls(), 0, "the route never lists by itself");

  await harness.instance.tick();
  const listings = harness.listCalls();
  const scrapes = harness.engines.calls.length;
  for (const id of ["nope", "llama-local", "mystery", "vllm-mystery", "", "../primary", "x".repeat(300)]) {
    const res = await get(id);
    assert.equal(res.statusCode, 404, id);
    assert.equal(res.body.ok, false, id);
    assert.equal(res.body.error.code, "unknown_instance", id);
  }
  assert.equal(harness.listCalls(), listings, "no Docker listing for an unknown id");
  assert.equal(harness.engines.calls.length, scrapes, "no scrape for an unknown id");
  assert.deepEqual(harness.instance.list().map((item) => item.instanceId), ["primary"]);
});

test("the route is registered only with a sampler", () => {
  const app = recordingApp();
  core.engines.registerEngineRoutes(app, { registry: REGISTRY, managerId: "vllm" });
  assert.ok(!app.routes.has("GET /api/instances/:id/metrics"));
});

test("runtimeKey changes when the container or the engine process restarts", async () => {
  let processStart = "1.7604e+09";
  const harness = sampler({
    engines: fakeEngines({ 8000: () => promResponse(fixture("sglang.prom").replace(/^process_start_time_seconds .*$/m, `process_start_time_seconds ${processStart}`)) }),
  });
  await harness.instance.tick();
  const first = harness.instance.read("primary");
  assert.equal(first.runtimeKey, "sglang:3f2a9c:1760400000");

  // The engine restarted inside the same container (restart policy).
  processStart = "1.7605e+09";
  await harness.instance.tick();
  const restarted = harness.instance.read("primary");
  assert.equal(restarted.runtimeKey, "sglang:3f2a9c:1760500000");

  // The container was replaced: the old snapshot is dropped until the new one is scraped.
  harness.setContainers([container({ id: "9e8d7c6b5a41", createdAt: "2026-10-14 09:00:00 +0000 UTC", running: false })]);
  await harness.instance.tick();
  const replaced = harness.instance.read("primary");
  assert.equal(replaced.scrapeOk, false);
  assert.equal(replaced.errorCode, "no_sample");
  assert.equal(replaced.metrics, null);
  assert.equal(replaced.raw, null);
  assert.equal(replaced.runtimeKey, `sglang:9e8d7c:${Date.parse("2026-10-14T09:00:00Z") / 1000}`, "the container start until a scrape names the process");
  assert.notEqual(replaced.runtimeKey, restarted.runtimeKey);
});

test("the sampler follows P0-RT-4's ownership rule and names instances like /api/instances", async () => {
  const harness = sampler({
    containers: [
      container(),
      container({ name: "vllm-local-b", id: "cccccccccccc", labels: { "ai.manager.instance": "b", "ai.manager.engine": "vllm", "ai.manager.port": "8001" } }),
      container({ name: "vllm-local-c", id: "dddddddddddd", labels: { "ai.manager.engine-id": "sglang", "ai.manager.engine": "", "ai.manager.port": "8002" } }),
      container({ name: "foreign", id: "eeeeeeeeeeee", labels: { "ai.manager": "someone-else" } }),
    ],
    engines: fakeEngines({
      8000: () => promResponse(fixture("sglang.prom")),
      8001: () => promResponse(fixture("vllm.prom")),
      8002: () => promResponse(fixture("sglang.prom")),
    }),
  });
  await harness.instance.tick();
  const listed = harness.instance.list();
  assert.deepEqual(listed.map((item) => [item.instanceId, item.engineId, item.fleetId]), [
    ["primary", "sglang", "vllm:primary"],
    ["b", "vllm", "vllm:b"],
    ["vllm-local-c", "sglang", "vllm:vllm-local-c"],
  ]);
  assert.equal(harness.instance.read("vllm-local-b").instanceId, "b");
  assert.equal(harness.instance.read("b").metrics.promptTokensTotal, 1203345);
  assert.equal(harness.instance.read("b").runtimeKey, "vllm:cccccc:1760400000");
  assert.equal(harness.instance.resolve("foreign"), null);

  // An unlabelled primary container is still this manager's (P0-RT-4).
  const bare = sampler({ containers: [container({ labels: { "ai.manager": "", "ai.manager.engine": "" } })] });
  await bare.instance.tick();
  assert.equal(bare.instance.read("primary").engineId, "vllm", "the manager's default engine");
  const taken = sampler({ containers: [container({ labels: { "ai.manager": "llama-manager" } })] });
  await taken.instance.tick();
  assert.equal(taken.instance.read("primary"), null);
});

test("scrape failures map to the documented error codes and never keep stale data", async () => {
  const timeout = () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };
  const cases = [
    ["timeout", timeout],
    ["http_500", () => promResponse("boom", 500)],
    ["http_401", () => promResponse("unauthorized", 401)],
    ["unsupported_endpoint", () => promResponse("not found", 404)],
    ["unsupported_endpoint", () => promResponse("This server does not support metrics endpoint.", 501)],
    ["parse_error", () => promResponse("x".repeat(4096))],
  ];
  for (const [code, handler] of cases) {
    const harness = sampler({ engines: fakeEngines({ 8000: handler }), extra: { maxBytes: 2048 } });
    await harness.instance.tick();
    const payload = harness.instance.read("primary");
    assert.equal(payload.scrapeOk, false, code);
    assert.equal(payload.errorCode, code, code);
    assert.equal(payload.scrapedAt, "2026-10-14T08:00:10.004Z", code);
    assert.equal(payload.metrics, null, code);
    assert.equal(payload.raw, null, code);
    assert.deepEqual(payload.unsupported, [], code);
  }
  const refused = sampler({ engines: fakeEngines({}) });
  await refused.instance.tick();
  assert.equal(refused.instance.read("primary").errorCode, "unreachable");

  const noKey = sampler({ extra: { headersFor: () => { throw new Error("key store unavailable"); } } });
  await noKey.instance.tick();
  assert.equal(noKey.instance.read("primary").errorCode, "unreachable");
  assert.equal(noKey.engines.calls.length, 0, "no request without the engine's key");

  // A success after a failure replaces it; a failure after a success drops the old data.
  let fail = false;
  const flaky = sampler({ engines: fakeEngines({ 8000: () => (fail ? promResponse("", 503) : promResponse(fixture("sglang.prom"))) }) });
  await flaky.instance.tick();
  assert.equal(flaky.instance.read("primary").scrapeOk, true);
  fail = true;
  await flaky.instance.tick();
  assert.equal(flaky.instance.read("primary").errorCode, "http_503");
  assert.equal(flaky.instance.read("primary").metrics, null);
});

test("stopped containers are listed but not scraped, and Docker outages keep the last listing", async () => {
  const harness = sampler({ containers: [container({ running: false })] });
  await harness.instance.tick();
  const payload = harness.instance.read("primary");
  assert.equal(payload.scrapeOk, false);
  assert.equal(payload.errorCode, "no_sample");
  assert.equal(payload.scrapedAt, null);
  assert.equal(harness.engines.calls.length, 0);

  const outage = sampler({ listError: true });
  await outage.instance.tick();
  assert.equal(outage.instance.ready(), false);
  assert.equal(outage.instance.stats().listErrors, 1);
});

test("the sampler scrapes at most four instances at once, forwards headers and derived inputs", async () => {
  const ports = [8000, 8001, 8002, 8003, 8004, 8005];
  const containers = ports.map((port, index) => container({
    name: index === 0 ? "vllm-local" : `vllm-local-${index}`,
    id: `${index}`.repeat(12),
    labels: { "ai.manager.port": String(port), "ai.manager.instance": index === 0 ? undefined : `i${index}` },
  }));
  const engines = fakeEngines(Object.fromEntries(ports.map((port) => [port, () => promResponse(fixture("sglang.prom"))])));
  const seen = [];
  const harness = sampler({
    containers,
    engines,
    extra: {
      headersFor: () => ({ authorization: "Bearer test-only-not-a-key" }),
      getDerivedInputs: (instance) => {
        seen.push(instance.instanceId);
        return null;
      },
      getFacts: (instance) => (instance.primary ? { kvTokens: 262144 } : null),
    },
  });
  await harness.instance.tick();
  assert.equal(engines.calls.length, 6);
  assert.ok(engines.maxInFlight() <= 4, `max in flight ${engines.maxInFlight()}`);
  assert.ok(engines.maxInFlight() > 1, "scrapes run in parallel");
  assert.ok(engines.calls.every((call) => call.headers.authorization === "Bearer test-only-not-a-key"));
  assert.equal(seen.length, 6);
  assert.deepEqual(harness.instance.read("primary").facts, { kvTokens: 262144 });
  assert.deepEqual(harness.instance.read("i1").facts, {});

  const llama = metrics.createInstanceMetricsSampler({
    registry: REGISTRY,
    managerId: "llama",
    ownerLabelValue: "llama-manager",
    primaryContainerName: "llama-local",
    listContainers: async () => [{
      exists: true, running: true, id: "0a1b2c3d4e5f", name: "llama-local", image: "",
      createdAt: "2026-10-14T07:00:00Z",
      labels: { "ai.manager": "llama-manager", "ai.manager.engine": "llama", "ai.manager.port": "8080", "ai.manager.model": "glimmer-q4" },
    }],
    getDerivedInputs: (instance) => (instance.primary ? { busySlots: 2, nSlots: 4, cacheHit: { cachedTokens: 12 } } : null),
    fetchImpl: fakeEngines({ 8080: () => promResponse(fixture("llamacpp.prom")) }).fetchImpl,
    now: () => SCRAPED_AT,
  });
  await llama.tick();
  const payload = llama.read("primary");
  assert.equal(payload.engineId, "llamacpp");
  assert.equal(payload.fleetId, "llama:primary");
  assert.equal(payload.metrics.kvUsageRatio, 0.5);
  assert.equal(payload.metrics.cachedPromptTokensTotal, 12);
  assert.equal(payload.raw.processStartSeconds, null);
  assert.equal(payload.processStartSeconds, Date.parse("2026-10-14T07:00:00Z") / 1000, "llama-server has no process metric; the container start stands in");
  assert.equal(payload.runtimeKey, `llamacpp:0a1b2c:${Date.parse("2026-10-14T07:00:00Z") / 1000}`);
  assert.equal(payload.raw.models[0].model, "glimmer-q4");
});

test("start runs a first round at once and stop clears the timer", async () => {
  const harness = sampler({ extra: { intervalMs: 60_000 } });
  harness.instance.start();
  harness.instance.start();
  assert.equal(harness.instance.stats().running, true);
  await harness.instance.tick();
  assert.equal(harness.listCalls(), 1, "start's round and the explicit tick are one round");
  assert.equal(harness.instance.ready(), true);
  harness.instance.stop();
  assert.equal(harness.instance.stats().running, false);
  assert.throws(() => metrics.createInstanceMetricsSampler({ managerId: "vllm", listContainers: async () => [] }), TypeError);
  assert.throws(() => metrics.createInstanceMetricsSampler({ registry: REGISTRY, managerId: "tts", listContainers: async () => [] }), TypeError);
  assert.throws(() => metrics.createInstanceMetricsSampler({ registry: REGISTRY, managerId: "vllm" }), TypeError);
});

test("a real engine endpoint on an ephemeral port: success with auth, then a timeout", async (t) => {
  let hang = false;
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || "");
    if (hang) return; // never answers
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(fixture("vllm.prom"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const { port } = server.address();
  const instance = metrics.createInstanceMetricsSampler({
    registry: REGISTRY,
    managerId: "vllm",
    ownerLabelValue: "vllm-manager",
    primaryContainerName: "vllm-local",
    listContainers: async () => [container({ image: REGISTRY.defaultRuntime("vllm").image, labels: { "ai.manager.engine": "vllm", "ai.manager.port": String(port) } })],
    headersFor: () => ({ authorization: "Bearer test-only-not-a-key" }),
    timeoutMs: 300,
  });
  await instance.tick();
  const ok = instance.read("primary");
  assert.equal(ok.scrapeOk, true);
  assert.equal(ok.engineId, "vllm");
  assert.equal(ok.runtimeId, REGISTRY.defaultRuntime("vllm").runtimeId);
  assert.equal(ok.metrics.requestsTotal, 912);
  assert.deepEqual(seenAuth, ["Bearer test-only-not-a-key"]);

  hang = true;
  const started = Date.now();
  await instance.tick();
  assert.equal(instance.read("primary").errorCode, "timeout");
  assert.ok(Date.now() - started < 5000, "the timeout bounds the round");
});
