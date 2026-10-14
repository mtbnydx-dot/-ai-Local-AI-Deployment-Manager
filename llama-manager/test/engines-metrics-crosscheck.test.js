"use strict";

// ENG-14 in the llama.cpp manager (docs/overhaul/01-engines.md §16.1): the
// canonical metrics equal what buildModelStats (the /api/stats facade) reads
// from the same recorded llama-server /metrics text, /api/stats keeps P0-RT-5's
// speed fields, and the metrics route is registered without sampling at load.
// No docker process is spawned and no engine is called.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llama-metrics-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const manager = require("../server");
const core = require("../../manager-core");

const metrics = core.engines.metrics;
const FIXTURE = path.join(__dirname, "..", "..", "manager-core", "test", "fixtures", "engines", "metrics", "llamacpp.prom");
const MODEL = "glimmer-q4";
const STATS_MODEL_KEYS = ["name", "root", "maxModelLen", "tokens", "requests", "latency", "averages", "speed", "cache", "context"];

const orZero = (value) => value ?? 0;

function legacyAndCanonical(text) {
  const [legacy, ...others] = manager.buildModelStats(manager.parsePrometheusMetrics(text), { [MODEL]: { id: MODEL } }, {}, 1760400600, {
    updateSamples: false,
  });
  assert.equal(others.length, 0);
  const mapped = metrics.mapPrometheus("llamacpp", metrics.parsePrometheus(text), { registry: manager.engineRegistry, defaultModel: MODEL });
  assert.equal(mapped.models.length, 1);
  return { legacy, canonical: mapped.models[0], mapped };
}

test("canonical llama.cpp metrics equal buildModelStats on the recorded llama-server text", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  for (const variant of [text, `${text}llamacpp:kv_cache_usage_ratio 0.5\n`]) {
    const { legacy, canonical, mapped } = legacyAndCanonical(variant);
    assert.equal(canonical.model, legacy.name);
    assert.equal(canonical.counters.promptTokensTotal, legacy.tokens.prompt);
    assert.equal(canonical.counters.generationTokensTotal, legacy.tokens.generation);
    assert.equal(orZero(canonical.counters.requestsTotal), legacy.requests.total);
    assert.equal(canonical.gauges.requestsRunning, legacy.requests.running);
    assert.equal(canonical.gauges.requestsWaiting, legacy.requests.waiting);
    assert.equal(orZero(canonical.gauges.kvUsageRatio), legacy.context.kvUsagePercent);
    // llama-server has no latency histograms; /api/stats takes them from log facts.
    for (const key of metrics.CANONICAL_METRIC_KEYS.histograms) assert.ok(mapped.unsupported.includes(`histograms.${key}`), key);
  }
});

test("/api/stats keeps its llama model shape and P0-RT-5's speed fields", () => {
  const { legacy } = legacyAndCanonical(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(Object.keys(legacy), STATS_MODEL_KEYS);
  assert.equal(legacy.speed.outputSource, "counter_window");
  assert.equal(typeof legacy.speed.windowSeconds, "number");
  assert.equal(legacy.speed.averageOutputTokensPerSecond, 39.9799);
});

test("the llama manager registers the metrics route and does not sample until it starts", () => {
  const routes = manager.app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
  assert.ok(routes.includes("GET /api/instances/:id/metrics"));
  const stats = manager.instanceMetricsSampler.stats();
  assert.equal(stats.running, false);
  assert.equal(stats.listings, 0);
  assert.equal(manager.instanceMetricsSampler.managerId, "llama");
});
