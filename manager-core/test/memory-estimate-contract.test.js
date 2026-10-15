"use strict";

// /api/memory-estimate must-keep contract (docs/overhaul/02-models.md §10.7,
// §21.2, MOD-9b): legacy bodies answer exactly as before (the llama plan only
// gains weightsGb), every key platform-mcp reads is present for both managers,
// and card mode answers with every legacy key plus `fit` and `card`. Fake GPUs
// and fixture cards only.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const core = require("..");
const { buildVllmMemoryEstimate } = require("../../vllm-manager/lib/memory-estimate");
const { buildLlamaMemoryEstimate } = require("../../llama-manager/lib/memory-estimate");

const GOLDEN = require("./fixtures/fit/memory-estimate-golden.json");
const GIB = 1024 ** 3;
const CARDS = path.join(__dirname, "fixtures", "model-cards");

function fixtureCard(id, cardId) {
  return { ...structuredClone(require(path.join(CARDS, id, "expected-card.json"))), cardId };
}

const QWEN = fixtureCard("qwen38-27b-fp8", "mc_aaaaaaaaaaaaaaaaaaaa");
const DEEPSEEK = fixtureCard("deepseek-v4-flash-q2k-gguf", "mc_bbbbbbbbbbbbbbbbbbbb");
const GPUS = [{ id: "0", name: "GPU 0", totalMb: 97887, usedMb: 600, freeMb: 97287 }];

// The body platform-mcp's memory_estimate tool posts (platform-client.ts).
function mcpBody(engine) {
  return {
    paramsB: 27,
    contextTokens: 32768,
    bytesPerParam: engine === "llama" ? 0.56 : 1,
    selectedGpus: GPUS,
    gpuMemoryUtilization: 0.9,
    cpuOffloadGb: 0,
    kvOffloadGb: 0,
    maxNumSeqs: 1,
    multiGpuMode: "single",
    tensorParallelSize: 1,
    speculativeMode: "off",
    numSpeculativeTokens: 3,
  };
}

const MCP_PLAN_KEYS = ["weightsGb", "kvGb", "overheadPerGpuGb", "perGpuGb", "overflowPerGpuGb", "recommendedCpuOffloadGb", "recommendedKvOffloadGb", "status"];
const MCP_RECOMMENDATION_KEYS = ["status", "summary", "suggestions"];

function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

test("legacy bodies answer exactly as recorded before MOD-9b; the llama plan gains only weightsGb", () => {
  assert.equal(GOLDEN.records.length, 7);
  for (const record of GOLDEN.records) {
    const fn = record.manager === "vllm" ? buildVllmMemoryEstimate : buildLlamaMemoryEstimate;
    const actual = fn(structuredClone(record.input));
    assert.ok(!(actual instanceof Promise), `${record.name}: a body without a card answers synchronously`);
    const body = wire(actual);
    if (record.manager === "llama") {
      assert.equal(body.plan.weightsGb, body.plan.gpuWeightsGb, `${record.name}: weightsGb is the GPU-resident weights`);
      delete body.plan.weightsGb;
    }
    assert.equal(JSON.stringify(body), JSON.stringify(record.expected), record.name);
  }
});

test("every key platform-mcp reads is present for both managers; llama weightsGb is no longer null", () => {
  for (const [manager, fn] of [["vllm", buildVllmMemoryEstimate], ["llama", buildLlamaMemoryEstimate]]) {
    const body = wire(fn(mcpBody(manager)));
    assert.equal(body.ok, true);
    const plan = body.plan;
    assert.ok(Number.isFinite(plan.weightsGb) && plan.weightsGb > 0, `${manager}: plan.weightsGb`);
    assert.ok(Number.isFinite(plan.kvGb), `${manager}: plan.kvGb`);
    assert.ok(Number.isFinite(plan.perGpuGb ?? plan.peakGpuGb), `${manager}: perGpuGb or peakGpuGb`);
    assert.ok(["ok", "warn", "fail"].includes(body.recommendations.status), `${manager}: status`);
    for (const key of MCP_RECOMMENDATION_KEYS) assert.ok(key in body.recommendations, `${manager}: recommendations.${key}`);
    assert.ok(Array.isArray(body.recommendations.suggestions));
    if (manager === "vllm") for (const key of MCP_PLAN_KEYS) assert.ok(key in plan, `vllm: plan.${key}`);
  }
});

test("a bare legacy model or variant object does not switch on card mode", () => {
  const { cardModeRequested } = core.models.cardEstimate;
  assert.equal(cardModeRequested({ model: "/models/x.gguf", variant: { layers: 4 }, paramsB: 7 }), false);
  assert.equal(cardModeRequested({ paramsB: 7 }), false);
  assert.equal(cardModeRequested({ cardId: "mc_aaaaaaaaaaaaaaaaaaaa" }), true);
  assert.equal(cardModeRequested({ model: "/models/x", engineId: "vllm" }), true);
  assert.equal(cardModeRequested({ model: "owner/repo", values: {} }), true);
  assert.equal(cardModeRequested({ model: "owner/repo" }), false);
  const body = { model: "/models/x.gguf", paramsB: 7, contextTokens: 4096, selectedGpus: GPUS };
  assert.ok(!(buildLlamaMemoryEstimate(body) instanceof Promise));
});

async function cardMode(manager, card, extra = {}) {
  const fn = manager === "vllm" ? buildVllmMemoryEstimate : buildLlamaMemoryEstimate;
  const body = { ...mcpBody(manager), cardId: card.cardId, card, ...extra };
  delete body.paramsB;
  return wire(await fn(body));
}

test("card mode: every legacy key is present, plus fit and card (vLLM)", async () => {
  const legacy = wire(buildVllmMemoryEstimate(mcpBody("vllm")));
  const body = await cardMode("vllm", QWEN, { contextTokens: 262144, maxNumSeqs: 1, engineId: "vllm" });
  for (const key of Object.keys(legacy)) assert.ok(key in body, `top-level ${key}`);
  for (const key of Object.keys(legacy.plan)) assert.ok(key in body.plan, `plan.${key}`);
  for (const key of Object.keys(legacy.recommendations)) assert.ok(key in body.recommendations, `recommendations.${key}`);
  assert.equal(body.card.cardId, QWEN.cardId);
  assert.ok(["exact", "config", "heuristic", "measured"].includes(body.card.confidence));
  assert.deepEqual(core.models.fit.validateFitResult(body.fit), { ok: true, errors: [] });
  assert.equal(body.fit.policy, "device-fraction");
  // The plan numbers are the fit's, not the legacy heuristic's.
  const peakMb = Math.max(...Object.values(body.fit.perGpuMb));
  assert.equal(body.plan.perGpuGb, peakMb / 1024);
  assert.equal(body.plan.status, body.fit.status);
  assert.equal(body.recommendations.status, body.fit.status);
  assert.ok(body.plan.weightsGb > 25 && body.plan.weightsGb < 35, "weights from the tensor table");
  assert.equal(body.plan.kvGb, body.fit.artifact.kvMb.low / 1024);
});

test("card mode: every legacy key is present, plus fit and card (llama.cpp, spill)", async () => {
  const legacy = wire(buildLlamaMemoryEstimate(mcpBody("llama")));
  const body = await cardMode("llama", DEEPSEEK, { contextTokens: 32768, values: { "llamacpp.nCpuMoe": 3 } });
  for (const key of Object.keys(legacy)) assert.ok(key in body, `top-level ${key}`);
  for (const key of Object.keys(legacy.plan)) assert.ok(key in body.plan, `plan.${key}`);
  for (const key of Object.keys(legacy.recommendations)) assert.ok(key in body.recommendations, `recommendations.${key}`);
  assert.equal(body.fit.spill, true, "nCpuMoe moves experts to RAM");
  assert.ok(body.fit.ram.experts > 0);
  assert.equal(body.plan.weightsGb, body.plan.gpuWeightsGb);
  assert.ok(body.plan.totalWeightsGb > body.plan.gpuWeightsGb, "part of the weights sits in RAM");
  assert.equal(body.plan.totalWeightsGb, DEEPSEEK.weights.totalBytes / 1024 ** 3);
  assert.equal(body.plan.peakGpuGb, Math.max(...Object.values(body.fit.perGpuMb)) / 1024);
  for (const allocation of body.plan.allocations) {
    assert.equal(allocation.allocatedGb, body.fit.perGpuMb[allocation.gpu.id] / 1024);
  }
  assert.equal(body.card.cardId, DEEPSEEK.cardId);
});

test("card mode reads the model from a folder, a body without a card is not guessed at, and an unknown model is model_not_found", async () => {
  const seen = [];
  const body = wire(await buildVllmMemoryEstimate(
    { ...mcpBody("vllm"), model: "my-model", engineId: "vllm", paramsB: undefined },
    {
      resolveModelPath: (ref) => { seen.push(ref); return "/fixture/models/my-model"; },
      inspectLocal: async (target) => { seen.push(target); return QWEN; },
    },
  ));
  assert.deepEqual(seen, ["my-model", "/fixture/models/my-model"]);
  assert.equal(body.card.cardId, QWEN.cardId);
  await assert.rejects(
    () => buildVllmMemoryEstimate({ ...mcpBody("vllm"), model: "missing", engineId: "vllm" }, { resolveModelPath: () => null, inspectRemote: false }),
    (error) => error.code === "model_not_found" && error.status === 404,
  );
});

test("the admission policy the server supplies reaches card-mode grading", async () => {
  const tight = await cardMode("vllm", QWEN, { contextTokens: 262144, engineId: "vllm", admissionPolicy: { reserveMb: 0, maxUtilizationPct: 5 } });
  const normal = await cardMode("vllm", QWEN, { contextTokens: 262144, engineId: "vllm", admissionPolicy: { reserveMb: 8192, maxUtilizationPct: 85 } });
  assert.ok(tight.fit.budgetMb["0"] < normal.fit.budgetMb["0"]);
  assert.equal(tight.fit.status, "fail");
});

test("memory-estimator exposes the legacyEstimate facade over fit.legacyEstimate", () => {
  const input = { paramsB: 7, contextTokens: 4096, bytesPerParam: 2, selectedGpus: GPUS };
  const facade = core.legacyEstimate(structuredClone(input), { engineId: "vllm" });
  const direct = core.models.fit.legacyEstimate(structuredClone(input), { engineId: "vllm" });
  assert.deepEqual(wire(facade), wire(direct));
  assert.equal(facade.engine, "vllm");
  assert.equal(core.legacyEstimate(structuredClone(input), { engineId: "llamacpp" }).engine, "llama.cpp");
});

test("gguf-variants fitFor: the bytes heuristic stays without a card; with a card the verdict is estimateFit's", () => {
  const bytes = 20 * GIB;
  assert.deepEqual(core.fitFor(bytes, { gpuTotalMb: 97887 }), {
    status: "fits",
    ratio: (bytes / (1024 * 1024) * 1.05 + 1024 + 2048) / 97887,
    note: core.fitFor(bytes, { gpuTotalMb: 97887 }).note,
  });
  assert.equal(core.fitFor(bytes, {}).status, "unknown");
  const roomy = core.fitFor(bytes, { gpuTotalMb: 97887, card: DEEPSEEK, values: { "llamacpp.nCpuMoe": 3 } });
  assert.equal(roomy.source, "estimateFit");
  assert.ok(["fits", "tight", "exceeds"].includes(roomy.status));
  assert.equal(roomy.spill, true);
  const small = core.fitFor(bytes, { gpuTotalMb: 24576, card: DEEPSEEK });
  assert.equal(small.status, "exceeds");
  assert.ok(small.ratio > 1);
  // A listing asks per quant group.
  const listing = core.listGgufVariants([{ name: "m-Q2_K.gguf", size: bytes }], { gpuTotalMb: 24576, cardFor: () => DEEPSEEK });
  assert.equal(listing.variants[0].fit.source, "estimateFit");
});
