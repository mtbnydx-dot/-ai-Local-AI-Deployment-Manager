"use strict";

// ENG-14 in the vLLM manager (docs/overhaul/01-engines.md §16.1): the
// canonical metrics equal what buildModelStats (the /api/stats facade) reads
// from the same recorded /metrics text, /api/stats keeps its shape and P0-RT-5's
// speed fields, and GET /api/instances/:id/metrics is registered and served
// from the sampler. No docker process is spawned and no engine is called.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-metrics-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const manager = require("../server");
const core = require("../../manager-core");

const metrics = core.engines.metrics;
const FIXTURES = path.join(__dirname, "..", "..", "manager-core", "test", "fixtures", "engines", "metrics");
const SPEED_SOURCES = new Set(["counter_window", "sglang_gen_throughput_gauge"]);
// The per-model /api/stats shape; ENG-14 must not change it.
const STATS_MODEL_KEYS = ["name", "engine", "runtimeVersion", "root", "maxModelLen", "tokens", "requests", "latency", "averages", "speed", "cache", "speculative", "context"];

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function legacyAndCanonical(engineId, name) {
  const text = fixture(name);
  const legacyMetrics = manager.parsePrometheusMetrics(text);
  const servedName = legacyMetrics.find((metric) => metric.labels.model_name)?.labels.model_name;
  const [legacy, ...others] = manager.buildModelStats(legacyMetrics, { [servedName]: { id: servedName } }, {}, 1760400600, {
    engine: engineId,
    updateSamples: false,
  });
  assert.equal(others.length, 0, name);
  const mapped = metrics.mapPrometheus(engineId, metrics.parsePrometheus(text), { registry: manager.engineRegistry });
  assert.equal(mapped.models.length, 1, name);
  return { legacy, canonical: mapped.models[0], summary: metrics.summarize(mapped), servedName };
}

// buildModelStats reports a missing reading as 0; canonical values are null.
const orZero = (value) => value ?? 0;

for (const [engineId, name] of [["vllm", "vllm.prom"], ["vllm", "vllm-later.prom"], ["sglang", "sglang.prom"]]) {
  test(`canonical ${engineId} metrics equal buildModelStats on ${name}`, () => {
    const { legacy, canonical, summary, servedName } = legacyAndCanonical(engineId, name);
    const { counters, gauges } = canonical;
    assert.equal(canonical.model, servedName);
    assert.equal(legacy.name, servedName);

    assert.equal(counters.promptTokensTotal, legacy.tokens.prompt);
    assert.equal(counters.generationTokensTotal, legacy.tokens.generation);
    assert.equal(orZero(counters.cachedPromptTokensTotal), legacy.tokens.cachedPrompt);
    assert.equal(counters.requestsTotal, legacy.requests.total);
    assert.deepEqual(counters.requestsByFinishReason ?? {}, legacy.requests.byFinishReason);
    assert.equal(orZero(gauges.requestsRunning), legacy.requests.running);
    assert.equal(orZero(gauges.requestsWaiting), legacy.requests.waiting);
    assert.equal(orZero(gauges.kvUsageRatio), legacy.context.kvUsagePercent);
    assert.equal(orZero(counters.prefixQueriesTotal), legacy.cache.prefixQueries);
    assert.equal(orZero(counters.prefixHitsTotal), legacy.cache.prefixHits);
    assert.equal(counters.prefixHitsTotal / counters.prefixQueriesTotal, legacy.cache.prefixHitRate);
    assert.equal(orZero(counters.specDraftsTotal), legacy.speculative.draftCycles);
    assert.equal(orZero(counters.specDraftTokensTotal), legacy.speculative.draftTokens);
    assert.equal(orZero(counters.specAcceptedTokensTotal), legacy.speculative.acceptedTokens);
    assert.equal(orZero(summary.specAcceptRate), legacy.speculative.acceptanceRate);

    assert.equal(orZero(summary.ttftSeconds?.avg), legacy.latency.avgTtftSeconds);
    assert.equal(orZero(summary.e2eSeconds?.avg), legacy.latency.avgE2eSeconds);
    assert.equal(orZero(summary.itlSeconds?.avg), legacy.latency.avgInterTokenSeconds);
    assert.equal(orZero(summary.tpotSeconds?.avg), legacy.latency.avgTimePerOutputTokenSeconds);
    assert.equal(orZero(summary.queueSeconds?.avg), legacy.latency.avgQueueSeconds);

    if (engineId === "sglang") {
      assert.equal(gauges.kvCapacityTokens, legacy.context.capacityTokens);
      // P0-RT-5: while requests run, SGLang's speed is the live gauge.
      assert.equal(legacy.requests.running > 0, true);
      assert.equal(legacy.speed.outputSource, "sglang_gen_throughput_gauge");
      assert.equal(gauges.genThroughputTps, legacy.speed.recentOutputTokensPerSecond);
    }
  });
}

test("/api/stats keeps its model shape and P0-RT-5's speed fields", () => {
  for (const [engineId, name] of [["vllm", "vllm.prom"], ["sglang", "sglang.prom"]]) {
    const { legacy } = legacyAndCanonical(engineId, name);
    assert.deepEqual(Object.keys(legacy), STATS_MODEL_KEYS, name);
    assert.equal(typeof legacy.speed.windowSeconds, "number", name);
    assert.ok(SPEED_SOURCES.has(legacy.speed.outputSource), `${name}: ${legacy.speed.outputSource}`);
    const totals = manager.withSpeedWindowSeconds(core.aggregateStats([legacy], 600), [legacy]);
    assert.equal(typeof totals.speed.windowSeconds, "number", name);
  }
});

test("the vLLM manager registers the metrics route and does not sample until it starts", () => {
  const routes = manager.app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
  assert.ok(routes.includes("GET /api/instances/:id/metrics"));
  const stats = manager.instanceMetricsSampler.stats();
  assert.equal(stats.running, false, "requiring the server starts no sampler timer");
  assert.equal(stats.listings, 0, "and lists no containers");
  assert.equal(manager.instanceMetricsSampler.managerId, "vllm");
});

test("GET /api/instances/:id/metrics answers over HTTP from the sampler", async (t) => {
  const registry = manager.engineRegistry;
  const fetchCalls = [];
  const sampler = metrics.createInstanceMetricsSampler({
    registry,
    managerId: "vllm",
    ownerLabelValue: "vllm-manager",
    primaryContainerName: "vllm-local",
    listContainers: async () => [{
      exists: true,
      running: true,
      id: "5c4b3a291807",
      name: "vllm-local",
      image: registry.defaultRuntime("vllm").image,
      createdAt: "2026-10-14 07:59:00 +0000 UTC",
      labels: { "ai.manager": "vllm-manager", "ai.manager.engine": "vllm", "ai.manager.port": "8000" },
    }],
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return new Response(fixture("vllm.prom"), { status: 200 });
    },
  });
  await sampler.tick();
  const app = express();
  core.engines.registerEngineRoutes(app, { registry, managerId: "vllm", metricsSampler: sampler });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/instances/primary/metrics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fleetId, "vllm:primary");
  assert.equal(body.engineId, "vllm");
  assert.equal(body.runtimeId, registry.defaultRuntime("vllm").runtimeId);
  assert.equal(body.runtimeKey, "vllm:5c4b3a:1760400000");
  assert.equal(body.metrics.requestsTotal, 912);
  assert.equal(body.raw.models[0].counters.requestsTotal, 912);
  assert.ok(Array.isArray(body.unsupported));

  const unknown = await fetch(`${base}/api/instances/${encodeURIComponent("no such instance")}/metrics`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "unknown_instance");
  assert.equal(fetchCalls.length, 1, "the two requests caused no scrape");
});
