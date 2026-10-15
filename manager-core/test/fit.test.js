"use strict";

// Memory fit (docs/overhaul/02-models.md §10, §21.2 fit.test.js, MOD-9): the
// artifact inputs per attention kind and offload value with hand-computed
// numbers, estimateFit against a recording stub of 01's memory models (inputs
// verbatim, policy/perGpuMb/admissionRequest passed through, the low/high
// range, grading, calibration warnings, the engine_model_unavailable
// fallback), the FitResult schema, integration with the real
// engines/memory-models.js and the recorded legacy plans.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const core = require("..");
const fit = require("../model-inspector/fit");
const memoryModels = require("../engines/memory-models");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CARDS = path.join(__dirname, "fixtures", "model-cards");
const LEGACY = require("./fixtures/fit/legacy-bodies.json");

function fixtureCard(id) {
  return structuredClone(require(path.join(CARDS, id, "expected-card.json")));
}

const QWEN = fixtureCard("qwen38-27b-fp8");
const DEEPSEEK = fixtureCard("deepseek-v4-flash-q2k-gguf");
const FLASH_NEXT = fixtureCard("qwen38-flashnext-nvfp4");
const HOST = Object.freeze({
  gpus: [{ id: "0", name: "GPU 0", totalMb: 97887, freeMb: 97000, usedMb: 600, computeCap: "12.0" }],
  ramBytes: 256 * GIB,
  ramFreeBytes: 200 * GIB,
  platform: "wsl",
});
// floor(97887 x 0.85 - 8192): gpu-admission's default policy on an idle GPU.
const EMPTY_GPU_BUDGET = 75011;

// The 01 §12 field names memory-models.js reads, in the order 02 §10.2 lists them.
const ARTIFACT_01_FIELDS = ["weightsMb", "kvBytesPerToken", "kvBytesPerTokenHigh", "stateBytesPerSeq", "draftMb", "mmprojMb", "hidden", "vocab", "confidence"];

function syntheticCard({ topology = {}, weights = null, context = {}, quant = {} } = {}) {
  return {
    schema: "modelcard/v1",
    cardId: "mc_aaaaaaaaaaaaaaaaaaaa",
    contentDigest: "sha256:" + "0".repeat(64),
    topology: { layers: 4, heads: 8, kvHeads: 8, headDim: 128, hiddenSize: 1024, vocabSize: 32000, ...topology },
    weights: weights || { exact: true, totalBytes: 2 * GIB, byClass: { dense: 2 * GIB } },
    context: { native: 32768, slidingWindow: null, ...context },
    quant: { kvScheme: null, ...quant },
    modalities: { projectorFiles: [] },
  };
}

function swaCard() {
  return syntheticCard({
    topology: {
      attention: {
        histogram: { full: 1, swa: 3 },
        kinds: { full: { kvHeads: 8, kDim: 128, vDim: 128 }, swa: { window: 1024, kvHeads: 8, kDim: 128, vDim: 128 } },
      },
    },
  });
}

// A recording stub of engines.memoryModels.estimate.
function recordingStub(reply = {}) {
  const calls = [];
  return {
    calls,
    estimate(engineId, inputs, options) {
      calls.push({ engineId, inputs: structuredClone(inputs), options });
      const value = typeof reply === "function" ? reply(engineId, inputs, options, calls.length) : reply;
      if (value instanceof Error) throw value;
      return {
        perGpuMb: { 0: 60000 },
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
        ...value,
      };
    },
  };
}

function fitInput(overrides = {}) {
  return {
    card: QWEN,
    legacy: null,
    engineId: "vllm",
    runtimeId: "vllm@test",
    gpuIds: ["0"],
    values: { contextLength: 262144, concurrency: 1 },
    host: HOST,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Artifact inputs: KV per attention kind (02 §10.3)
// ---------------------------------------------------------------------------

test("Qwen3.8-27B: 65,536 B/token over 16 full layers and 153,944,064 B linear state per sequence", () => {
  for (const engineId of ["vllm", "sglang", "llamacpp"]) {
    const kv = fit.kvBytes(QWEN, { contextLength: 262144, concurrency: 1 }, { engineId });
    assert.equal(kv.bytesPerTokenLow, 65536, engineId);
    assert.equal(kv.bytesPerTokenHigh, 65536, engineId);
    assert.equal(kv.stateBytesPerSeq, 153944064, engineId);
    assert.equal(kv.lowBytes, 262144 * 65536, engineId);
    assert.deepEqual(kv.layers, [
      { kind: "full", count: 16, bytesPerToken: 65536 },
      { kind: "linear", count: 48, stateBytesPerSeq: 153944064 },
    ]);
  }
  const artifact = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 262144, concurrency: 1 }, gpuIds: ["0"] });
  assert.deepEqual(artifact.kvMb, { low: 16384, high: 16384 });
  // FP8 KV halves the per-token bytes.
  assert.equal(fit.kvBytes(QWEN, { contextLength: 1024, kvCacheDtype: "fp8" }, { engineId: "vllm" }).bytesPerTokenLow, 32768);
});

test("DeepSeek-V4 GGUF at f16 and 1M tokens: compressed KV 6.76 GiB low, 8.76 GiB high; the MTP ratio only with MTP", () => {
  const values = { contextLength: 1048576, concurrency: 1, "llamacpp.cacheTypeK": "f16", "llamacpp.cacheTypeV": "f16" };
  const kv = fit.kvBytes(DEEPSEEK, values, { engineId: "llamacpp" });
  // 21 x ratio 4, 20 x ratio 128, 2 x ratio 0 (hand-computed per 02 §10.3).
  assert.equal(kv.lowBytes, 21 * 335675392 + 20 * 10616832 + 2 * 128 * 512 * 2);
  assert.equal(kv.highBytes, 21 * 335675392 + 20 * 10616832 + 2 * 1048576 * 512 * 2);
  assert.equal((kv.lowBytes / GIB).toFixed(2), "6.76");
  assert.equal((kv.highBytes / GIB).toFixed(2), "8.76");
  assert.deepEqual(kv.layers[0].ratios, { 0: 2, 4: 21, 128: 20 });
  assert.equal(kv.uncertain, true);
  const withMtp = fit.kvBytes(DEEPSEEK, { ...values, "speculative.method": "draft-mtp" }, { engineId: "llamacpp" });
  // The 44th compress_ratios entry (0) is the next-n layer.
  assert.equal(withMtp.highBytes - kv.highBytes, 1048576 * 512 * 2);
  assert.equal(withMtp.lowBytes - kv.lowBytes, 128 * 512 * 2);
});

test("sliding-window layers: vLLM pages min(C,W) per sequence; llama.cpp pools min(C,W)·S + ubatch unless swaFull", () => {
  const card = swaCard();
  const perToken = 8 * (128 * 2 + 128 * 2);
  const vllm = fit.kvBytes(card, { contextLength: 8192, concurrency: 2 }, { engineId: "vllm" });
  assert.equal(vllm.lowBytes, perToken * 8192 * 2 + 3 * perToken * 1024 * 2);
  assert.equal(vllm.bytesPerTokenLow, Math.ceil(vllm.lowBytes / (8192 * 2)));
  const llama = fit.kvBytes(card, { contextLength: 8192, concurrency: 2, "llamacpp.ubatchSize": 512 }, { engineId: "llamacpp" });
  assert.equal(llama.lowBytes, perToken * 16384 + 3 * perToken * 2560);
  // gguf-estimate multiplies by contextLength only: per slot-context token.
  assert.equal(llama.bytesPerTokenLow, Math.ceil(llama.lowBytes / 8192));
  const full = fit.kvBytes(card, { contextLength: 8192, concurrency: 2, "llamacpp.swaFull": true }, { engineId: "llamacpp" });
  assert.equal(full.lowBytes, 4 * perToken * 16384);
});

test("MLA, mamba2, gated-deltanet with an indexer and unknown layers use the 02 §10.3 formulas", () => {
  const mla = syntheticCard({ topology: { layers: 61, attention: { histogram: { mla: 61 }, kinds: { mla: { kvLoraRank: 512, ropeDim: 64 } } } } });
  assert.equal(fit.kvBytes(mla, { contextLength: 4096, concurrency: 1 }, { engineId: "vllm" }).lowBytes, 61 * (512 + 64) * 2 * 4096);

  const mamba = syntheticCard({
    topology: {
      layers: 3,
      attention: {
        histogram: { linear: 2, full: 1 },
        kinds: {
          full: { kvHeads: 8, kDim: 128, vDim: 128 },
          linear: { variant: "mamba2", convKernel: 4, nHeads: 64, headDim: 64, stateSize: 128, groups: 8, dInner: 4096 },
        },
      },
    },
  });
  // conv (dInner + 2·G·N)·(K−1)·2 + ssm nHeads·headDim·N·4
  assert.equal(fit.kvBytes(mamba, { contextLength: 1024 }, { engineId: "llamacpp" }).stateBytesPerSeq, 2 * ((4096 + 2 * 8 * 128) * 3 * 2 + 64 * 64 * 128 * 4));

  const flash = fit.kvBytes(FLASH_NEXT, { contextLength: 262144, concurrency: 1 }, { engineId: "sglang" });
  assert.equal(flash.lowBytes, 12 * 2 * (256 * 2 + 256 * 2) * 262144 + 12 * Math.ceil(262144 / 4) * 128 * 1 * 2);
  assert.equal(flash.stateBytesPerSeq, 36 * ((2 * 16 * 128 + 48 * 128) * 3 * 2 + 48 * 128 * 128 * 4));

  const unknown = syntheticCard({ topology: { layers: 32, heads: 32, kvHeads: 8, headDim: 128 } });
  const kv = fit.kvBytes(unknown, { contextLength: 1000, concurrency: 1 }, { engineId: "vllm" });
  assert.equal(kv.lowBytes, 32 * 8 * 128 * 4 * 1000);
  assert.equal(kv.highBytes, 32 * 32 * 128 * 4 * 1000);
  assert.equal(kv.uncertain, true);
});

// ---------------------------------------------------------------------------
// Artifact inputs: weights and offload (02 §10.4)
// ---------------------------------------------------------------------------

test("MemoryInputs.artifact carries 01's field names first, then the additive v1 fields", () => {
  const artifact = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 262144, concurrency: 1 }, gpuIds: ["0"] });
  assert.deepEqual(Object.keys(artifact).slice(0, ARTIFACT_01_FIELDS.length), ARTIFACT_01_FIELDS);
  assert.equal(artifact.schema, "artifact-memory-inputs/v1");
  for (const key of ["contentDigest", "layers", "nativeContext", "weightsMbByGpu", "ramMb", "byClassMb", "offload", "kvMb", "kvLayers", "assumptions"]) {
    assert.ok(Object.hasOwn(artifact, key), key);
  }
  assert.equal(artifact.confidence, "exact");
  assert.equal(artifact.hidden, 5120);
  assert.equal(artifact.vocab, 248320);
  // MTP weights count only with MTP speculation.
  const byClass = QWEN.weights.byClass;
  const withoutMtp = Object.entries(byClass).reduce((sum, [key, bytes]) => sum + (key === "mtp" ? 0 : bytes), 0);
  assert.equal(artifact.weightsMb, Math.ceil(withoutMtp / MIB));
  const mtp = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 4096, "speculative.method": "mtp" } });
  assert.equal(mtp.weightsMb, Math.ceil((withoutMtp + byClass.mtp) / MIB));
  // languageModelOnly drops the vision tower; tensor parallel splits per GPU.
  const textOnly = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 4096, "vllm.languageModelOnly": true, tensorParallel: 2 }, gpuIds: ["0", "1"] });
  assert.equal(textOnly.weightsMb, Math.ceil((withoutMtp - byClass.vision) / MIB));
  assert.deepEqual(Object.keys(textOnly.weightsMbByGpu), ["0", "1"]);
});

test("llamacpp.nCpuMoe moves Σ expertsByLayer[0..N-1] to RAM; gpuLayers and CPU tensor overrides move layers", () => {
  const values = { contextLength: 32768, concurrency: 1 };
  const base = fit.artifactMemoryInputs({ card: DEEPSEEK, engineId: "llamacpp", values, gpuIds: ["0"] });
  const moved = DEEPSEEK.weights.expertsByLayer.slice(0, 6).reduce((a, b) => a + b, 0);
  const moe = fit.artifactMemoryInputs({ card: DEEPSEEK, engineId: "llamacpp", values: { ...values, "llamacpp.nCpuMoe": 6 }, gpuIds: ["0"] });
  assert.equal(moe.ramMb.experts, Math.ceil(moved / MIB));
  assert.ok(Math.abs((base.weightsMb - moe.weightsMb) - moved / MIB) <= 1, "GPU weights drop by the moved experts");
  assert.equal(moe.offload.expertLayersInRam, 6);
  // token_embd stays in host RAM: counted, but a fixed placement.
  assert.equal(base.ramMb.weights, Math.ceil(DEEPSEEK.weights.byClass.embedding / MIB));
  assert.equal(base.offload.fixedRamMb, base.ramMb.weights);

  const layers = fit.artifactMemoryInputs({ card: DEEPSEEK, engineId: "llamacpp", values: { ...values, "llamacpp.gpuLayers": 40 }, gpuIds: ["0"] });
  assert.equal(layers.offload.layersInRam, 3);
  assert.equal(layers.ramMb.experts, Math.ceil(DEEPSEEK.weights.expertsByLayer.slice(0, 3).reduce((a, b) => a + b, 0) / MIB));

  const override = fit.artifactMemoryInputs({
    card: DEEPSEEK,
    engineId: "llamacpp",
    values: { ...values, "llamacpp.overrideTensor": [{ pattern: "blk\\.(4[0-2])\\.ffn_.*_exps\\.", buffer: "CPU" }, { pattern: "blk\\.0\\.ffn_up_exps", buffer: "CUDA0" }] },
    gpuIds: ["0"],
  });
  assert.equal(override.ramMb.experts, Math.ceil(DEEPSEEK.weights.expertsByLayer.slice(40, 43).reduce((a, b) => a + b, 0) / MIB));
  assert.equal(override.offload.tensorsInRam, 3);
});

test("vLLM cpuOffloadGb and kvOffloadingSize, SGLang PLE offload land in ram; the tensor split follows llamacpp.tensorSplit", () => {
  const base = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 4096 } });
  const offload = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 4096, "vllm.cpuOffloadGb": 4, "vllm.kvOffloadingSize": 8 } });
  assert.equal(offload.ramMb.weights, 4096);
  assert.equal(offload.ramMb.kv, 8192);
  assert.ok(Math.abs(base.weightsMb - offload.weightsMb - 4096) <= 1);
  const ple = fit.artifactMemoryInputs({ card: FLASH_NEXT, engineId: "sglang", values: { contextLength: 4096, "sglang.pleOffloadEmbedding": true } });
  assert.equal(ple.ramMb.weights, Math.ceil(FLASH_NEXT.weights.byClass.ple / MIB));
  const split = fit.artifactMemoryInputs({ card: DEEPSEEK, engineId: "llamacpp", values: { contextLength: 4096, "llamacpp.tensorSplit": "3,1" }, gpuIds: ["0", "1"] });
  assert.ok(Math.abs(split.weightsMbByGpu["0"] - 3 * split.weightsMbByGpu["1"]) <= 3);
});

test("legacy facts without a card give heuristic artifact inputs with the MHA upper bound as the high end", () => {
  const artifact = fit.artifactMemoryInputs({ legacy: { paramsB: 8, bytesPerParam: 2 }, engineId: "vllm", values: { contextLength: 8192, concurrency: 1 } });
  assert.equal(artifact.confidence, "heuristic");
  assert.equal(artifact.weightsMb, Math.ceil((8e9 * 2) / MIB));
  // 7B/8B bucket: 32 layers, 8 KV heads (32 for MHA), head dim 128.
  assert.equal(artifact.kvBytesPerToken, 32 * 8 * 128 * 4);
  assert.equal(artifact.kvBytesPerTokenHigh, 32 * 32 * 128 * 4);
  assert.throws(() => fit.artifactMemoryInputs({ engineId: "vllm", values: {} }), { code: "fit_input_invalid" });
});

// ---------------------------------------------------------------------------
// FitInput values: catalog ids only
// ---------------------------------------------------------------------------

test("FitInput accepts only catalog ids: an unknown id becomes an assumption; absent ids take catalog defaults", () => {
  const stub = recordingStub();
  const result = fit.estimateFit(fitInput({ values: { contextLength: 65536, "llamacpp.nCpuMoe": 4, "made.up": 1 } }), { memoryModels: stub, suggestions: false });
  const { values } = stub.calls[0].inputs;
  assert.equal(values.contextLength, 65536);
  assert.equal(Object.hasOwn(values, "llamacpp.nCpuMoe"), false);
  assert.equal(Object.hasOwn(values, "made.up"), false);
  assert.ok(result.assumptions.some((item) => item.en.includes("llamacpp.nCpuMoe") && item.en.includes("made.up")));
  // platformDefault expressions read instance.mode: parallel 0.7, replace 0.92.
  assert.equal(values["vllm.gpuMemoryUtilization"], 0.7);
  assert.equal(values.concurrency, 4);
  fit.estimateFit(fitInput({ instanceMode: "replace" }), { memoryModels: stub, suggestions: false });
  assert.equal(stub.calls[1].inputs.values["vllm.gpuMemoryUtilization"], 0.92);
  assert.equal(stub.calls[1].inputs.mode, "replace");
});

// ---------------------------------------------------------------------------
// estimateFit against a recording stub
// ---------------------------------------------------------------------------

test("estimateFit passes MemoryInputs verbatim and policy, perGpuMb and admissionRequest through unchanged", () => {
  const admissionRequest = { requestedFractionOfFree: 0.88, poolCappedTokens: 262144, minClampMb: 4096, estimatePolicy: "sglang_mem_fraction_static_of_free", clamped: false, verdict: "ok" };
  const perGpuMb = { 0: 61234 };
  const stub = recordingStub({ policy: "static-fraction-of-free", perGpuMb, admissionRequest, admissionRequestMb: null, maxFullLengthRequests: 1 });
  const recipeMemory = { measuredMiB: 1 };
  const calibration = { exact: true, measuredMb: 50000, samples: 3 };
  const input = fitInput({ engineId: "sglang", values: { contextLength: 262144, concurrency: 1, "sglang.maxTotalTokens": 262144 }, recipeMemory });
  const result = fit.estimateFit(input, { memoryModels: stub, calibration, suggestions: false });
  assert.equal(stub.calls.length, 1, "low = high: one estimate call");
  const { engineId, inputs } = stub.calls[0];
  assert.equal(engineId, "sglang");
  assert.deepEqual(Object.keys(inputs).sort(), ["artifact", "calibration", "gpus", "legacy", "mode", "recipeMemory", "values"]);
  assert.equal(inputs.legacy, null);
  assert.equal(inputs.mode, "parallel");
  assert.deepEqual(inputs.recipeMemory, recipeMemory);
  assert.deepEqual(inputs.calibration, calibration);
  // empty-gpu basis: a synthetic idle GPU.
  assert.deepEqual(inputs.gpus, [{ id: "0", name: "GPU 0", totalMb: 97887, usedMb: 600, freeMb: 97287, computeCap: "12.0" }]);
  assert.deepEqual(inputs.artifact, fit.artifactMemoryInputs({ ...input, values: inputs.values }));
  assert.equal(result.policy, "static-fraction-of-free");
  assert.equal(result.perGpuMb, perGpuMb);
  assert.equal(result.admissionRequest, admissionRequest);
  assert.deepEqual(result.admissionRequest, admissionRequest, "P0-RT-3 fields never renamed or recomputed");
  for (const key of ["requestedFractionOfFree", "poolCappedTokens", "minClampMb", "clamped", "verdict"]) {
    assert.ok(Object.hasOwn(result.admissionRequest, key), key);
    assert.equal(Object.hasOwn(result, key), false, `${key} only inside admissionRequest`);
  }
  // budgetBasis "now" passes the host GPUs as they are.
  fit.estimateFit({ ...input, budgetBasis: "now" }, { memoryModels: stub, suggestions: false });
  assert.deepEqual(stub.calls[1].inputs.gpus, [{ id: "0", name: "GPU 0", totalMb: 97887, usedMb: 600, freeMb: 97000, computeCap: "12.0" }]);
});

test("the range calls estimate twice only when the artifact's low and high KV differ", () => {
  const stub = recordingStub((engineId, inputs) => ({ policy: "gguf-estimate", perGpuMb: { 0: 50000 + inputs.artifact.kvMb.low }, maxFullLengthRequests: null, admissionRequest: { requestedMb: 1, estimatePolicy: "gguf_estimate" } }));
  const result = fit.estimateFit(fitInput({ card: DEEPSEEK, engineId: "llamacpp", values: { contextLength: 1048576, concurrency: 1 } }), { memoryModels: stub, suggestions: false });
  assert.equal(stub.calls.length, 2);
  const [low, high] = stub.calls.map((call) => call.inputs.artifact);
  assert.equal(high.kvBytesPerToken, low.kvBytesPerTokenHigh);
  assert.ok(high.kvBytesPerToken > low.kvBytesPerToken);
  assert.equal(result.range.lowMb, 50000 + low.kvMb.low);
  assert.equal(result.range.highMb, 50000 + low.kvMb.high);
  assert.equal(result.perGpuMb["0"], result.range.lowMb, "the point estimate is the plan's (low) estimate");

  const once = recordingStub();
  fit.estimateFit(fitInput(), { memoryModels: once, suggestions: false });
  assert.equal(once.calls.length, 1);
});

test("status and spill grading table", () => {
  const grade = (reply, overrides = {}, options = {}) => fit.estimateFit(fitInput({ values: { contextLength: 262144, concurrency: 1 }, ...overrides }), { memoryModels: recordingStub(reply), suggestions: false, ...options });
  const ok = grade({});
  assert.equal(ok.status, "ok");
  assert.equal(ok.spill, false);
  assert.deepEqual(ok.budgetMb, { 0: EMPTY_GPU_BUDGET });
  assert.equal(ok.headroomMb, EMPTY_GPU_BUDGET - 60000);
  assert.equal(grade({ perGpuMb: { 0: 70000 } }).status, "warn", "above 90 % of the budget");
  const over = grade({ perGpuMb: { 0: 80000 } });
  assert.equal(over.status, "fail");
  assert.equal(over.overflowMb, 80000 - EMPTY_GPU_BUDGET);
  assert.equal(grade({ maxFullLengthRequests: 0 }).status, "fail", "vLLM refuses to start");
  assert.equal(grade({ maxFullLengthRequests: 1 }, { values: { contextLength: 262144, concurrency: 2 } }).status, "warn");
  const spill = grade({}, { values: { contextLength: 262144, concurrency: 1, "vllm.cpuOffloadGb": 2 } });
  assert.equal(spill.spill, true);
  assert.equal(spill.status, "warn");
  assert.deepEqual(spill.ram, { weights: 2048, experts: 0, kv: 0 });
  assert.equal(grade({ confidence: "fraction-only" }).status, "warn");
  const heuristic = grade({}, { card: null, legacy: { paramsB: 8, bytesPerParam: 2 } });
  assert.equal(heuristic.confidence, "heuristic");
  assert.equal(heuristic.status, "warn");
  assert.equal(grade({ confidence: "measured" }).confidence, "measured");
  // RAM: 43 expert layers in RAM against 32 GiB of host RAM minus the 16 GiB reserve.
  const ram = grade({ policy: "gguf-estimate", maxFullLengthRequests: null }, {
    card: DEEPSEEK, engineId: "llamacpp", values: { contextLength: 8192, concurrency: 1, "llamacpp.nCpuMoe": 43 },
    host: { ...HOST, ramBytes: 32 * GIB },
  });
  assert.equal(ram.status, "fail");
  assert.ok(ram.statusReasons.includes("ram"));
  assert.equal(ram.spill, true);
  // budgetBasis "now": min(free − reserve, total × maxUtil − used).
  const now = grade({}, { budgetBasis: "now" }, { admissionPolicy: { reserveMb: 1000, maxUtilizationPct: 95 } });
  assert.deepEqual(now.budgetMb, { 0: Math.floor(Math.min(97000 - 1000, 97887 * 0.95 - 600)) });
});

test("estimate_drift and weights_mismatch come from the calibration records", () => {
  const record = (measured, estimated, logFacts = {}) => ({ estimated: { perGpuMb: { 0: estimated } }, measured: { perGpuMb: { 0: measured }, logFacts } });
  const base = fit.artifactMemoryInputs({ card: QWEN, engineId: "vllm", values: { contextLength: 262144, concurrency: 1 } });
  const weightsGiB = base.weightsMb / 1024;
  const calibration = { exact: false, samples: 0, records: [record(70000, 60000, { weightsGiB }), record(72000, 60000, { weightsGiB: weightsGiB * 1.2 })] };
  const drift = fit.estimateFit(fitInput(), { memoryModels: recordingStub(), calibration, suggestions: false });
  assert.equal(drift.calibration.driftRatio, Math.round(((70000 / 60000 + 72000 / 60000) / 2) * 1000) / 1000);
  const codes = drift.warnings.map((item) => item.code);
  assert.ok(codes.includes("estimate_drift"));
  assert.ok(codes.includes("weights_mismatch"));
  assert.equal(drift.calibration.applied, false);

  const steady = fit.estimateFit(fitInput(), { memoryModels: recordingStub(), calibration: { records: [record(61000, 60000, { weightsGiB })] }, suggestions: false });
  assert.equal(steady.calibration.driftRatio, null);
  assert.deepEqual(steady.warnings, []);

  // An exact calibration that 01 applied as "measured".
  const applied = fit.estimateFit(fitInput(), { memoryModels: recordingStub({ policy: "measured", confidence: "measured" }), calibration: { exact: true, measuredMb: 50000, samples: 4 }, suggestions: false });
  assert.deepEqual(applied.calibration, { applied: true, samples: 4, source: "exact", driftRatio: null });
});

test("estimate_drift fires outside [0.9, 1.15] on the median of the last five records only", () => {
  const record = (measured) => ({ estimated: { perGpuMb: { 0: 60000 } }, measured: { perGpuMb: { 0: measured }, logFacts: {} } });
  const drift = (ratios) => fit.estimateFit(fitInput(), { memoryModels: recordingStub(), calibration: { records: ratios.map((ratio) => record(60000 * ratio)) }, suggestions: false }).calibration.driftRatio;
  assert.equal(drift([1.16]), 1.16);
  assert.equal(drift([0.89]), 0.89);
  assert.equal(drift([0.9]), null);
  assert.equal(drift([1.15]), null);
  // Records older than the last five do not count: five steady launches after a wild one.
  assert.equal(drift([2, 1, 1, 1, 1, 1]), null);
  // The median, not the mean: one outlier among the last five does not trip it.
  assert.equal(drift([1, 1, 1.5, 1, 1]), null);
  assert.equal(drift([1.3, 1.3, 1.3, 1, 1]), 1.3);
  // Records without a measured or estimated value are skipped.
  assert.equal(fit.estimateFit(fitInput(), { memoryModels: recordingStub(), calibration: { records: [{ estimated: { perGpuMb: {} }, measured: { perGpuMb: {} } }] }, suggestions: false }).calibration.driftRatio, null);
});

test("calibrationFor is asked with engines.paramsKey output verbatim", () => {
  const seen = [];
  const calibrationFor = (card, engineId, runtimeId, paramsKey) => {
    seen.push({ card, engineId, runtimeId, paramsKey });
    return null;
  };
  fit.estimateFit(fitInput({ values: { contextLength: 262144, concurrency: 1, kvCacheDtype: "auto" } }), { memoryModels: recordingStub(), calibrationFor, suggestions: false });
  assert.equal(seen[0].card, QWEN);
  assert.equal(seen[0].runtimeId, "vllm@test");
  assert.equal(seen[0].paramsKey, memoryModels.paramsKey({ engineId: "vllm", values: { contextLength: 262144, concurrency: 1, kvCacheDtype: "auto" } }, "vllm"));
  assert.equal(seen[0].paramsKey, "262144|1|auto|-");
});

test("engine_model_unavailable falls back to a weights-plus-KV estimate", () => {
  const unknown = Object.assign(new Error("Engine x has no memory model."), { code: "unknown_memory_model" });
  const stub = recordingStub((engineId, inputs, options) => (options?.memoryModel?.kind === "weights-plus-kv"
    ? { policy: "weights-plus-kv", perGpuMb: { 0: 40000 }, admissionRequest: { requestedMb: 40000, estimatePolicy: "weights_plus_kv" } }
    : unknown));
  const result = fit.estimateFit(fitInput({ engineId: "mystery" }), { memoryModels: stub, catalog: null, suggestions: false });
  assert.equal(result.policy, "weights-plus-kv");
  assert.deepEqual(result.perGpuMb, { 0: 40000 });
  assert.equal(result.warnings[0].code, "engine_model_unavailable");
  assert.equal(stub.calls.length, 2);

  // Without any memory model at all, the local estimate keeps the same shape.
  const local = fit.estimateFit(fitInput({ engineId: "mystery" }), { memoryModels: { estimate() { throw unknown; } }, catalog: null, suggestions: false });
  assert.equal(local.policy, "weights-plus-kv");
  assert.ok(local.perGpuMb["0"] > 0);
  assert.equal(fit.validateFitResult(local).ok, true);

  // 08's old policy name is read as its 00 §9.1 name; a policy outside 00 is not passed through.
  assert.equal(fit.estimateFit(fitInput(), { memoryModels: recordingStub({ policy: "free-fraction" }), suggestions: false }).policy, "static-fraction-of-free");
  const bogus = fit.estimateFit(fitInput(), { memoryModels: recordingStub((e, i, options) => (options ? { policy: "weights-plus-kv" } : { policy: "bogus" })), suggestions: false });
  assert.equal(bogus.policy, "weights-plus-kv");
  assert.equal(bogus.warnings.at(-1).code, "engine_model_unavailable");
});

test("FitResult policy only takes the 00 §4.3 / §9.1 values (schema)", () => {
  assert.deepEqual([...fit.MEMORY_POLICIES].sort(), [
    "device-fraction", "free-fraction-after-weights", "gguf-estimate", "measured", "server-reported", "static-fraction-of-free", "weights-plus-kv",
  ]);
  assert.deepEqual(fit.FIT_RESULT_SCHEMA.properties.policy.enum, [...fit.MEMORY_POLICIES]);
  for (const policy of fit.MEMORY_POLICIES) {
    const result = fit.estimateFit(fitInput(), { memoryModels: recordingStub({ policy }), suggestions: false });
    assert.equal(result.policy, policy);
    assert.deepEqual(fit.validateFitResult(result), { ok: true, errors: [] }, policy);
  }
  const result = fit.estimateFit(fitInput(), { memoryModels: recordingStub(), suggestions: false });
  for (const policy of ["free-fraction", "fraction", "", null]) {
    assert.equal(fit.validateFitResult({ ...result, policy }).ok, false, String(policy));
  }
  assert.equal(fit.validateFitResult({ ...result, status: "maybe" }).ok, false);
  assert.equal(fit.validateFitResult({ ...result, confidence: "estimated" }).ok, false);
});

test("suggestions are engine-correct catalog ids with deltaMb from a re-run estimate", () => {
  // vLLM: a KV shortfall never lowers gpuMemoryUtilization.
  const vllm = fit.estimateFit(fitInput({ values: { contextLength: 262144, concurrency: 1, "vllm.gpuMemoryUtilization": 0.45 } }));
  assert.equal(vllm.status, "fail");
  assert.ok(vllm.suggestions.length > 0);
  assert.equal(vllm.suggestions.some((item) => item.param === "vllm.gpuMemoryUtilization"), false);
  assert.deepEqual(vllm.suggestions.map((item) => item.code).slice(0, 2), ["kv_fp8", "context_shorter"]);
  // An admission conflict (reservation above the gate's budget) does.
  const conflict = fit.estimateFit(fitInput({ instanceMode: "replace", values: { contextLength: 32768, concurrency: 1 } }));
  assert.ok(conflict.statusReasons.includes("vram"));
  assert.equal(conflict.suggestions[0].param, "vllm.gpuMemoryUtilization");
  assert.ok(conflict.suggestions[0].deltaMb < 0);

  // llama.cpp MoE: nCpuMoe before gpuLayers, deltaMb equal to a re-run.
  const llamaInput = fitInput({ card: DEEPSEEK, engineId: "llamacpp", values: { contextLength: 32768, concurrency: 1 } });
  const llama = fit.estimateFit(llamaInput);
  assert.equal(llama.status, "fail");
  const params = llama.suggestions.map((item) => item.param);
  assert.ok(params.indexOf("llamacpp.nCpuMoe") >= 0 && params.indexOf("llamacpp.nCpuMoe") < params.indexOf("llamacpp.gpuLayers"));
  const moe = llama.suggestions.find((item) => item.param === "llamacpp.nCpuMoe");
  const rerun = fit.estimateFit({ ...llamaInput, values: { ...llamaInput.values, "llamacpp.nCpuMoe": moe.to } }, { suggestions: false });
  assert.equal(moe.deltaMb, rerun.perGpuMb["0"] - llama.perGpuMb["0"]);
  assert.notEqual(rerun.status, "fail");

  // SGLang: maxTotalTokens before memFractionStatic.
  const sglang = fit.estimateFit(fitInput({ engineId: "sglang", instanceMode: "replace", card: QWEN, values: { contextLength: 65536, concurrency: 1, "sglang.memFractionStatic": 0.95 } }));
  const order = sglang.suggestions.map((item) => item.param);
  assert.ok(order.includes("sglang.maxTotalTokens"));
  if (order.includes("sglang.memFractionStatic")) assert.ok(order.indexOf("sglang.maxTotalTokens") < order.indexOf("sglang.memFractionStatic"));
  for (const result of [vllm, conflict, llama, sglang]) {
    for (const item of result.suggestions) {
      assert.ok(item.message.zh && item.message.en);
      assert.equal(typeof item.deltaMb, "number");
    }
  }
});

// ---------------------------------------------------------------------------
// Integration with the real 01 memory models (ENG-12)
// ---------------------------------------------------------------------------

test("real memory models: Qwen3.8-27B on vLLM at 262144 x 1 holds at least one full-length request", () => {
  const result = fit.estimateFit(fitInput({ values: { contextLength: 262144, concurrency: 1 } }));
  assert.equal(result.policy, "device-fraction");
  assert.ok(result.maxFullLengthRequests >= 1);
  assert.deepEqual(result.admissionRequest, { requestedFraction: 0.7, estimatePolicy: "vllm_gpu_memory_utilization" });
  assert.deepEqual(result.perGpuMb, { 0: Math.ceil(97887 * 0.7) });
  assert.equal(result.confidence, "exact");
  assert.notEqual(result.status, "fail");
  assert.deepEqual(fit.validateFitResult(result), { ok: true, errors: [] });
});

test("real memory models: Flash-Next on SGLang reports static-fraction-of-free with P0-RT-3's admission fields unchanged", () => {
  const values = { contextLength: 262144, concurrency: 1, "sglang.memFractionStatic": 0.88, "sglang.maxTotalTokens": 262144, "sglang.pleOffloadEmbedding": true };
  const result = fit.estimateFit(fitInput({ card: FLASH_NEXT, engineId: "sglang", values }), { suggestions: false });
  assert.equal(result.policy, "static-fraction-of-free");
  const direct = memoryModels.estimate("sglang", { values: result.values, artifact: result.artifact, gpus: [{ id: "0", totalMb: 97887, usedMb: 600, freeMb: 97287 }], mode: "parallel" });
  assert.deepEqual(result.admissionRequest, direct.admissionRequest);
  assert.deepEqual(result.admissionRequest, {
    requestedFractionOfFree: 0.88,
    poolCappedTokens: 262144,
    minClampMb: memoryModels.MEMORY_CONSTANTS.minClampMb,
    estimatePolicy: "sglang_mem_fraction_static_of_free",
  });
  assert.deepEqual(result.perGpuMb, direct.perGpuMb);
  assert.equal(result.spill, true, "PLE in host RAM");
  assert.deepEqual(fit.validateFitResult(result), { ok: true, errors: [] });
});

test("real memory models: DeepSeek-V4 on llama.cpp is a gguf-estimate whose request includes the GPU-resident weights and KV", () => {
  const result = fit.estimateFit(fitInput({ card: DEEPSEEK, engineId: "llamacpp", values: { contextLength: 32768, concurrency: 1, "llamacpp.nCpuMoe": 20 } }), { suggestions: false });
  assert.equal(result.policy, "gguf-estimate");
  assert.equal(result.admissionRequest.estimatePolicy, "gguf_estimate");
  assert.ok(result.admissionRequest.requestedMb > result.artifact.weightsMb + result.artifact.kvMb.low);
  assert.ok(result.range.highMb >= result.range.lowMb);
  assert.equal(result.spill, true);
});

// ---------------------------------------------------------------------------
// Legacy path, constants, namespace
// ---------------------------------------------------------------------------

test("legacyEstimate equals the post-ENG-12 legacy plans for 20 recorded bodies", () => {
  assert.equal(LEGACY.records.length, 20);
  for (const [index, record] of LEGACY.records.entries()) {
    const actual = JSON.parse(JSON.stringify(fit.legacyEstimate(structuredClone(record.input), { engineId: record.engineId })));
    assert.deepEqual(actual, record.expected, `record ${index} (${record.engineId})`);
  }
  // The engine may also come from the body itself.
  const llama = LEGACY.records.find((record) => record.engineId === "llamacpp");
  assert.deepEqual(JSON.parse(JSON.stringify(fit.legacyEstimate({ ...llama.input, engine: "llamacpp" }))), llama.expected);
});

test("FIT_CONSTANTS are artifact-side named exports, overridable from platform.json models.fitConstants", () => {
  assert.equal(fit.FIT_CONSTANTS.idleUsedMb, 600);
  assert.equal(fit.FIT_CONSTANTS.ramReserveGb, 16);
  assert.equal(fit.FIT_CONSTANTS.dtypeBytes.q8_0, 34 / 32);
  assert.equal(fit.FIT_CONSTANTS.dtypeBytes.nvfp4, 9 / 16);
  assert.ok(Object.isFrozen(fit.FIT_CONSTANTS));
  for (const key of Object.keys(memoryModels.MEMORY_CONSTANTS)) {
    assert.equal(Object.hasOwn(fit.FIT_CONSTANTS, key), false, `${key} is 01's`);
  }
  const reads = [];
  const constants = fit.fitConstantsFromConfig((name) => {
    reads.push(name);
    return { values: { fitConstants: { idleUsedMb: 1000, bogus: 5, dtypeBytes: { q8_0: 1 } } } };
  });
  assert.deepEqual(reads, ["models"]);
  assert.equal(constants.idleUsedMb, 1000);
  assert.equal(constants.dtypeBytes.q8_0, 1);
  assert.equal(Object.hasOwn(constants, "bogus"), false);
  assert.equal(fit.fitConstantsFromConfig(() => { throw new Error("no config"); }), fit.FIT_CONSTANTS);
  const stub = recordingStub();
  fit.estimateFit(fitInput(), { memoryModels: stub, fitConstants: { idleUsedMb: 1000 }, suggestions: false });
  assert.equal(stub.calls[0].inputs.gpus[0].freeMb, 97887 - 1000);
});

test("core.models.fit exposes the fit namespace", () => {
  for (const name of ["artifactMemoryInputs", "kvBytes", "estimateFit", "legacyEstimate", "FIT_CONSTANTS"]) {
    assert.equal(core.models.fit[name], fit[name], name);
  }
});
