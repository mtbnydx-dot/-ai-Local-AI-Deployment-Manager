const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("..");

test("network helpers normalize local, lan, and host values", () => {
  assert.equal(core.normalizeRemoteAddress("::ffff:192.168.1.2"), "192.168.1.2");
  assert.equal(core.isLocalAddress("127.0.0.1"), true);
  assert.equal(core.isLocalAddress("192.168.1.2"), false);
  assert.equal(core.isExternalAddress("192.168.1.9", "192.168.1.2"), true);
  assert.equal(core.isExternalAddress("192.168.1.2", "192.168.1.2"), false);
  assert.equal(core.extractHostname("http://192.168.1.2:5177/path"), "192.168.1.2");
});

test("secret records migrate legacy plaintext to hash-only shape", () => {
  const record = core.normalizeSecretRecord({ apiKey: "sk-local-secret" });
  assert.equal(record.secret, "");
  assert.equal(record.hash, core.hashSecret("sk-local-secret"));
  assert.equal(record.preview, "sk-loca...cret");
  assert.equal(core.isSecretAccepted("sk-local-secret", record), true);
  assert.equal(core.isSecretAccepted("wrong", record), false);
  const migrated = core.normalizeSecretRecord({}, { apiKey: "sk-legacy" });
  assert.equal(migrated.hash, core.hashSecret("sk-legacy"));
});

test("gateway helpers extract common auth fields", () => {
  assert.equal(core.serviceApiKeySource({ authorization: "Bearer sk-test" }), "authorization-bearer");
  assert.equal(core.extractServiceApiKey({ authorization: "Bearer sk-test" }), "sk-test");
  assert.equal(core.extractServiceApiKey({ "anthropic-api-key": "sk-anthropic" }), "sk-anthropic");
});

test("access events summarize request, latency, token, and group data", () => {
  const now = Date.parse("2026-06-14T12:10:00.000Z");
  const events = [
    core.normalizeAccessEvent({ at: "2026-06-14T12:00:00.000Z", remoteAddress: "192.168.1.9", status: 200, durationMs: 100, inputTokens: 10, outputTokens: 5, path: "/serve/v1/chat/completions", model: "local" }, "192.168.1.2"),
    core.normalizeAccessEvent({ at: "2026-06-14T12:01:00.000Z", remoteAddress: "127.0.0.1", status: 401, durationMs: 20, path: "/claude/messages" }, "192.168.1.2"),
  ];
  assert.equal(events[0].external, true);
  assert.equal(events[1].external, false);
  const summary = core.summarizeAccessEvents(events, now);
  assert.equal(summary.requests.total, 2);
  assert.equal(summary.requests.success, 1);
  assert.equal(summary.requests.authFailures, 1);
  assert.equal(summary.tokens.total, 15);
  const grouped = core.groupAccessEvents(events, (event) => event.path);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].count, 1);
});

test("vLLM memory plan treats CPU offload as a per-GPU budget", () => {
  const base = {
    paramsB: 27,
    contextTokens: 65536,
    bytesPerParam: 0.55,
    kvBytes: 1,
    selectedGpus: [
      { id: "0", totalGb: 24, usedGb: 2 },
      { id: "1", totalGb: 24, usedGb: 2 },
    ],
    utilization: 0.9,
    mode: "tensor",
    tensorParallelSize: 2,
    cpuOffloadGb: 0,
  };
  const noOffload = core.estimateVllmMemoryPlan(base);
  const offloaded = core.estimateVllmMemoryPlan({ ...base, cpuOffloadGb: 4 });
  assert.equal(offloaded.memorySplitFactor, 2);
  assert.ok(offloaded.weightPerGpuGb < noOffload.weightPerGpuGb);
  assert.ok(noOffload.weightPerGpuGb - offloaded.weightPerGpuGb > 3.9);
});

test("vLLM data parallel does not split per-GPU memory", () => {
  const plan = core.estimateVllmMemoryPlan({
    paramsB: 13,
    contextTokens: 8192,
    bytesPerParam: 2,
    selectedGpus: [
      { id: "0", totalGb: 48, usedGb: 4 },
      { id: "1", totalGb: 48, usedGb: 4 },
    ],
    mode: "data",
    tensorParallelSize: 2,
  });
  assert.equal(plan.memorySplitFactor, 1);
  assert.ok(plan.weightPerGpuBeforeOffloadGb > 20);
});

test("vLLM overflow recommends CPU or KV offload", () => {
  const plan = core.estimateVllmMemoryPlan({
    paramsB: 70,
    contextTokens: 131072,
    bytesPerParam: 2,
    kvBytes: 2,
    selectedGpus: [{ id: "0", totalGb: 24, usedGb: 2 }],
    utilization: 0.9,
  });
  assert.equal(plan.status, "fail");
  assert.ok(plan.overflowPerGpuGb > 0);
  assert.ok(plan.recommendedCpuOffloadGb > 0 || plan.recommendedKvOffloadGb > 0);
});

test("llama memory plan can reduce GPU layers for RAM fallback", () => {
  const plan = core.estimateLlamaMemoryPlan({
    paramsB: 70,
    contextTokens: 65536,
    bytesPerParam: 0.8,
    kvBytes: 1,
    selectedGpus: [{ id: "0", totalGb: 24, usedGb: 2 }],
    gpuLayers: "all",
  });
  assert.equal(plan.status, "fail");
  assert.ok(plan.recommendedGpuLayers < plan.totalLayers);
  assert.ok(plan.totalWeightsGb > plan.gpuWeightsGb || plan.recommendedGpuLayers < plan.requestedGpuLayers);
});

test("llama memory plan moves weights and KV to RAM when GPU layers are reduced", () => {
  const allGpu = core.estimateLlamaMemoryPlan({
    paramsB: 13,
    contextTokens: 32768,
    bytesPerParam: 0.56,
    kvBytes: 1,
    gpuLayers: "all",
    selectedGpus: [{ id: "0", totalGb: 48, usedGb: 4 }],
  });
  const halfGpu = core.estimateLlamaMemoryPlan({
    paramsB: 13,
    contextTokens: 32768,
    bytesPerParam: 0.56,
    kvBytes: 1,
    gpuLayers: Math.floor(allGpu.totalLayers / 2),
    selectedGpus: [{ id: "0", totalGb: 48, usedGb: 4 }],
  });

  assert.ok(halfGpu.gpuWeightsGb < allGpu.gpuWeightsGb);
  assert.ok(halfGpu.gpuKvGb < allGpu.gpuKvGb);
  assert.ok(halfGpu.cpuWeightsGb > allGpu.cpuWeightsGb);
  assert.ok(halfGpu.cpuKvGb > allGpu.cpuKvGb);
});
