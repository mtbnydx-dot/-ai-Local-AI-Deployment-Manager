"use strict";

// fitGrid (docs/overhaul/02-models.md §10.8, §21.2, MOD-9b): the largest
// passing ladder context per (kvDtype, concurrency) cell, limitedBy, the
// bounds (grid size, 12 evaluations per cell, the time budget) and
// memoization. A recording stub of engines.memoryModels stands in for 01 where
// exact thresholds matter; the real memory models cover monotonicity.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const core = require("..");
const fit = require("../model-inspector/fit");

const GIB = 1024 ** 3;
const CARDS = path.join(__dirname, "fixtures", "model-cards");

function fixtureCard(id, cardId) {
  return { ...structuredClone(require(path.join(CARDS, id, "expected-card.json"))), cardId };
}

const QWEN = fixtureCard("qwen38-27b-fp8", "mc_aaaaaaaaaaaaaaaaaaaa");
const DEEPSEEK = fixtureCard("deepseek-v4-flash-q2k-gguf", "mc_bbbbbbbbbbbbbbbbbbbb");
const HOST = Object.freeze({
  gpus: [{ id: "0", name: "GPU 0", totalMb: 97887, freeMb: 97000, usedMb: 600 }],
  ramBytes: 256 * GIB,
  ramFreeBytes: 200 * GIB,
});
// floor(97887 x 0.85 - 8192): gpu-admission's default policy on an idle GPU.
const BUDGET = 75011;

function bigCard(native = 1048576) {
  return {
    schema: "modelcard/v1",
    cardId: "mc_cccccccccccccccccccc",
    contentDigest: "sha256:" + "1".repeat(64),
    topology: { layers: 4, heads: 8, kvHeads: 8, headDim: 128, hiddenSize: 1024, vocabSize: 32000 },
    weights: { exact: true, totalBytes: 2 * GIB, byClass: { dense: 2 * GIB } },
    context: { native, slidingWindow: null },
    quant: { kvScheme: null },
    modalities: { projectorFiles: [] },
  };
}

// perGpuMb = 20000 + contextLength x concurrency / 5, so a cell passes while
// contextLength x concurrency <= 275055.
function linearStub(extra = () => ({})) {
  const calls = [];
  return {
    calls,
    paramsKey: (plan, engineId) => core.engines.memoryModels.paramsKey(plan, engineId),
    estimate(engineId, inputs) {
      calls.push({ engineId, values: inputs.values });
      const tokens = inputs.values.contextLength * inputs.values.concurrency;
      return {
        perGpuMb: { 0: Math.round(20000 + tokens / 5) },
        breakdown: { weights: 1, kv: 2, activations: 3, draft: 0, mmproj: 0, overhead: 4 },
        admissionRequestMb: null,
        kvPoolTokens: 1000,
        maxFullLengthRequests: 2,
        policy: "device-fraction",
        confidence: "estimated",
        admissionRequest: { requestedFraction: 0.7, estimatePolicy: "vllm_gpu_memory_utilization" },
        notes: [],
        warnings: [],
        errors: [],
        ...extra(inputs),
      };
    },
  };
}

function input(overrides = {}) {
  return { card: bigCard(), engineId: "vllm", runtimeId: "vllm@test", gpuIds: ["0"], values: {}, host: HOST, ...overrides };
}

function cellOf(grid, kvDtype, concurrency) {
  return grid.cells.find((cell) => cell.kvDtype === kvDtype && cell.concurrency === concurrency);
}

test("each cell holds the largest ladder context whose status is not fail", () => {
  const models = linearStub();
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto", "fp8"], concurrency: [1, 2, 4] }, { memoryModels: models, memo: new Map() });
  assert.deepEqual(grid.ladder, [1048576, 524288, 262144, 131072, 65536, 32768, 16384, 8192]);
  assert.equal(grid.native, 1048576);
  assert.equal(grid.cells.length, 6);
  assert.deepEqual(grid.cells.map((cell) => cell.maxContext), [262144, 131072, 65536, 262144, 131072, 65536]);
  for (const cell of grid.cells) {
    assert.equal(cell.limitedBy, "vram");
    assert.notEqual(cell.status, "fail", "the largest passing rung is not a failure");
    assert.equal(cell.spill, false);
    assert.equal(cell.truncated, undefined);
  }
  assert.equal(grid.ok, true);
  assert.equal(grid.cardId, "mc_cccccccccccccccccccc");
  assert.equal(grid.engineId, "vllm");
  assert.equal(grid.runtimeId, "vllm@test");
  assert.ok(Number.isInteger(grid.durationMs));
});

test("the search is a binary search over the ladder, never a scan", () => {
  const models = linearStub();
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1] }, { memoryModels: models, memo: new Map() });
  // 8 rungs: at most ceil(log2(9)) = 4 estimate calls for one cell.
  assert.ok(models.calls.length <= 4, `${models.calls.length} calls`);
  assert.equal(grid.stats.evaluations, models.calls.length);
});

test("limitedBy native: a model that fits at every rung is capped by its native context", () => {
  const grid = fit.fitGrid(input({ card: bigCard(32768) }), { kvDtypes: ["auto"], concurrency: [1] }, { memoryModels: linearStub(), memo: new Map() });
  assert.deepEqual(grid.ladder, [32768, 16384, 8192]);
  assert.equal(grid.cells[0].maxContext, 32768);
  assert.equal(grid.cells[0].limitedBy, "native");
});

test("limitedBy vram: the next rung overflows the budget", () => {
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1] }, { memoryModels: linearStub(), memo: new Map() });
  assert.equal(grid.cells[0].maxContext, 262144);
  assert.equal(grid.cells[0].limitedBy, "vram");
});

test("limitedBy engine: the engine's memory model blocks the next rung (vLLM cannot hold one full-length request)", () => {
  const stub = linearStub((inputs) => (inputs.values.contextLength >= 524288
    ? { maxFullLengthRequests: 0, perGpuMb: { 0: 30000 } }
    : {}));
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1] }, { memoryModels: stub, memo: new Map() });
  assert.equal(grid.cells[0].maxContext, 262144);
  assert.equal(grid.cells[0].limitedBy, "engine");
});

test("limitedBy ram: nothing fits because the CPU-side bytes exceed free RAM", () => {
  const host = { ...HOST, ramBytes: 24 * GIB, ramFreeBytes: 24 * GIB };
  const grid = fit.fitGrid({
    card: DEEPSEEK,
    engineId: "llamacpp",
    runtimeId: "llamacpp@test",
    gpuIds: ["0"],
    values: { "llamacpp.nCpuMoe": 43 },
    host,
  }, { kvDtypes: ["f16"], concurrency: [1] }, { memo: new Map() });
  const cell = grid.cells[0];
  assert.equal(cell.maxContext, 0);
  assert.equal(cell.status, "fail");
  assert.equal(cell.limitedBy, "ram");
});

test("real memory models: DeepSeek-V4 on llama.cpp gets a monotone grid over KV types and concurrency", () => {
  const grid = fit.fitGrid({
    card: DEEPSEEK, engineId: "llamacpp", runtimeId: "llamacpp@test", gpuIds: ["0"], values: { "llamacpp.nCpuMoe": 3 }, host: HOST,
  }, { kvDtypes: ["f16", "q8_0"], concurrency: [1, 4] }, { memo: new Map() });
  assert.equal(grid.cells.length, 4);
  assert.ok(cellOf(grid, "q8_0", 1).maxContext >= cellOf(grid, "f16", 1).maxContext, "a quantized cache never shrinks the context");
  assert.ok(cellOf(grid, "f16", 4).maxContext <= cellOf(grid, "f16", 1).maxContext, "more sequences never grow it");
  for (const cell of grid.cells) {
    assert.ok(grid.ladder.includes(cell.maxContext) || cell.maxContext === 0);
    if (cell.maxContext) assert.notEqual(cell.status, "fail");
  }
});

test("real memory models: Qwen3.8-27B on vLLM holds 262144 x 1 at fp8", () => {
  const grid = fit.fitGrid({
    card: QWEN, engineId: "vllm", runtimeId: "vllm@test", gpuIds: ["0"], values: {}, host: HOST,
  }, { kvDtypes: ["auto", "fp8"], concurrency: [1] }, { memo: new Map() });
  assert.equal(cellOf(grid, "fp8", 1).maxContext, 262144);
  assert.equal(cellOf(grid, "fp8", 1).limitedBy, "native");
});

test("contexts[] adds a matrix of status, spill and perGpuMb per (context, concurrency, kvDtype)", () => {
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1, 2], contexts: [65536, 524288] }, { memoryModels: linearStub(), memo: new Map() });
  assert.equal(grid.matrix.length, 4);
  const at = (contextLength, concurrency) => grid.matrix.find((item) => item.contextLength === contextLength && item.concurrency === concurrency);
  assert.equal(at(65536, 1).status, "ok");
  assert.equal(at(524288, 1).status, "fail");
  assert.equal(at(65536, 1).perGpuMb["0"], Math.round(20000 + 65536 / 5));
  assert.equal(at(524288, 2).spill, false);
  assert.deepEqual(Object.keys(at(65536, 1)).sort(), ["concurrency", "contextLength", "kvDtype", "perGpuMb", "spill", "status"]);
  assert.equal(fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1] }, { memoryModels: linearStub(), memo: new Map() }).matrix, undefined);
});

test("bounds: at most 4 KV dtypes x 8 concurrency values (x 16 contexts), a card is required", () => {
  const options = { memoryModels: linearStub(), memo: new Map() };
  assert.throws(() => fit.fitGrid(input(), { kvDtypes: ["a", "b", "c", "d", "e"], concurrency: [1] }, options), (error) => error.code === "grid_too_large" && error.status === 400);
  assert.throws(() => fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, options), (error) => error.code === "grid_too_large");
  assert.throws(() => fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [1], contexts: Array.from({ length: 17 }, (_, i) => 1024 * (i + 1)) }, options), (error) => error.code === "grid_too_large");
  assert.throws(() => fit.fitGrid(input(), { kvDtypes: ["auto"], concurrency: [0] }, options), (error) => error.code === "invalid_value");
  assert.throws(() => fit.fitGrid(input({ card: null }), {}, options), (error) => error.code === "fit_input_invalid");
  // The largest allowed grid runs.
  const full = fit.fitGrid(input(), { kvDtypes: ["auto", "fp8", "a", "b"], concurrency: [1, 2, 3, 4, 5, 6, 7, 8] }, options);
  assert.equal(full.cells.length, 32);
});

test("bounds: no cell takes more than 12 estimate calls", () => {
  const models = linearStub();
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto", "fp8", "q8_0", "q4_0"], concurrency: [1, 2, 4, 8] }, { memoryModels: models, memo: new Map() });
  assert.ok(models.calls.length <= 16 * 12);
  assert.equal(grid.stats.evaluations, models.calls.length);
  assert.equal(fit.fitGrid.LIMITS.evaluationsPerCell, 12);
  assert.equal(fit.fitGrid.LIMITS.budgetMs, 2000);
});

test("bounds: the 2 s budget marks the cells it cut short truncated and still answers", () => {
  let clock = 0;
  const models = linearStub();
  const options = { memoryModels: models, memo: new Map(), now: () => clock };
  const grid = fit.fitGrid(input(), { kvDtypes: ["auto", "fp8"], concurrency: [1, 2] }, {
    ...options,
    memoryModels: { ...models, estimate: (...args) => { clock += 700; return models.estimate(...args); } },
  });
  assert.equal(grid.truncated, true);
  assert.equal(grid.cells.length, 4);
  assert.ok(grid.cells.some((cell) => cell.truncated === true));
  for (const cell of grid.cells) assert.ok(Number.isInteger(cell.maxContext));
  assert.ok(grid.durationMs >= 2000);
});

test("memoized per card, engine, runtime and paramsKey: a repeated grid makes no estimate calls", () => {
  const memo = new Map();
  const models = linearStub();
  const options = { memoryModels: models, memo };
  const first = fit.fitGrid(input(), { kvDtypes: ["auto", "fp8"], concurrency: [1, 2] }, options);
  const callsAfterFirst = models.calls.length;
  assert.ok(callsAfterFirst > 0);
  const second = fit.fitGrid(input(), { kvDtypes: ["auto", "fp8"], concurrency: [1, 2] }, options);
  assert.equal(models.calls.length, callsAfterFirst, "no new estimate calls");
  assert.equal(second.stats.evaluations, 0);
  assert.ok(second.stats.memoHits > 0);
  assert.deepEqual(second.cells, first.cells);
  // A different runtime, host, or other value is a different evaluation.
  fit.fitGrid(input({ runtimeId: "vllm@other" }), { kvDtypes: ["auto"], concurrency: [1] }, options);
  assert.ok(models.calls.length > callsAfterFirst);
  const afterRuntime = models.calls.length;
  fit.fitGrid(input({ values: { "vllm.gpuMemoryUtilization": 0.5 } }), { kvDtypes: ["auto"], concurrency: [1] }, options);
  assert.ok(models.calls.length > afterRuntime);
  // The grid's paramsKey is 01's, verbatim.
  const keys = [...memo.keys()];
  assert.ok(keys.some((key) => key.includes("|262144|1|auto|-|")), "paramsKey rides in the memo key");
  fit.fitGrid.clearMemo();
});

test("side-effect free: the FitInput is not mutated and no calibration is written", () => {
  const request = input({ values: { contextLength: 4096, concurrency: 3 } });
  const before = JSON.stringify(request);
  fit.fitGrid(request, { kvDtypes: ["auto"], concurrency: [1] }, { memoryModels: linearStub(), memo: new Map() });
  assert.equal(JSON.stringify(request), before);
});

test("core.models.fit exposes fitGrid", () => {
  assert.equal(core.models.fit.fitGrid, fit.fitGrid);
});
