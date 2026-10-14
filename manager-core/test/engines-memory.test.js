"use strict";

// Memory models (docs/overhaul/01-engines.md §12, §25 engines-memory): the
// admission requests stay P0-RT-3's, the real gpu-admission module decides
// on them as before, Pennyroyal's measured formula, calibration, paramsKey,
// the resolver's calibrationFor hook and the /api/memory-estimate shape.

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const core = require("..");
const memoryModels = require("../engines/memory-models");
const { createVllmStartRuntimeRequest } = require("../../vllm-manager/lib/launch-request");
const { createVllmDefaultLaunchProfiles } = require("../../vllm-manager/lib/default-profiles");
const { pennyroyalRecipeMemory, PENNYROYAL_IMAGE } = require("../../vllm-manager/lib/pennyroyal");
const { buildVllmMemoryEstimate } = require("../../vllm-manager/lib/memory-estimate");

const GOLDENS = path.join(__dirname, "fixtures", "engines", "goldens");
const FLASH_NEXT_GPU = Object.freeze({ id: "0", totalMb: 97887, usedMb: 600 });

function profileConfig(id) {
  const profile = createVllmDefaultLaunchProfiles((config) => ({ ...config })).find((item) => item.id === id);
  assert.ok(profile, `${id} default profile exists`);
  return profile.config;
}

async function golden(name) {
  return JSON.parse(await fsp.readFile(path.join(GOLDENS, `${name}.json`), "utf8"));
}

// The vLLM manager's launch request with fakes; resolves with the admission
// request exactly as gpu-admission receives it (JSON, as P0-RT-3's test reads it).
async function launchAdmissionRequest(body, extra = {}) {
  let captured = null;
  let job = null;
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local", managerId: "vllm-manager" },
    cleanRequired: (value) => String(value || ""),
    deriveName: () => "model",
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Number(value || fallback),
    optionalNonNegativeNumber: () => null,
    normalizeDtype: () => "auto",
    normalizeQuantization: (value) => value || "",
    normalizeLoadFormat: () => "auto",
    cleanOptionalLaunchArg: () => "",
    normalizeKvCacheDtype: () => "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    normalizeClientPreset: (value) => value || "openai",
    normalizeReasoningParser: (value) => value || "",
    normalizeToolCallParser: (value) => value || "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: () => "local",
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => {
      job = { id: "memory", type, title, meta, status: "running" };
      return job;
    },
    runStartJob: async (startedJob, options) => {
      if (options.prepareGpuAdmission) await options.prepareGpuAdmission(async () => ({ async rollback() {} }));
      startedJob.status = "success";
    },
    failJob: (failedJob) => { failedJob.status = "failed"; },
    acquireGpuAdmission: async () => null,
    acquireGpuAdmissionAfterPrepare: async (admissionRequest, prepare) => {
      captured = JSON.stringify(admissionRequest);
      if (extra.acquireAfterPrepare) return extra.acquireAfterPrepare(admissionRequest, prepare);
      return { lease: null, context: null };
    },
    ...(extra.deps || {}),
  });
  await request({ body });
  for (let i = 0; i < 100 && (captured === null || job?.status === "running"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { json: captured, request: JSON.parse(captured), job };
}

async function withController(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "engines-memory-"));
  try {
    const controller = core.createGpuAdmissionController({
      root,
      reserveMb: 8192,
      maxUtilizationPct: 95,
      startupMarginMb: 1024,
      policyFile: false,
      getGpuStatus: async () => ({ ok: true, gpus: [{ ...FLASH_NEXT_GPU }] }),
    });
    return await fn(controller);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function replaceRequest(admissionRequest) {
  return {
    managerId: "vllm-manager",
    engine: "sglang",
    instanceMode: "replace",
    instanceId: "qwen3-8-flash-next",
    containerName: "vllm-local",
    gpuIds: ["0"],
    useAllGpus: false,
    maxModelLen: 262144,
    ...admissionRequest,
  };
}

test("vLLM admission requests equal the legacy ones", async () => {
  for (const name of ["R-V2-vllm-parallel-implicit-gpu", "R-V3-vllm-replace-after-prepare"]) {
    const legacy = (await golden(name)).expect.gpuAdmissionRequest;
    const estimate = memoryModels.estimate("vllm", { values: { "vllm.gpuMemoryUtilization": legacy.requestedFraction } });
    assert.deepEqual(estimate.admissionRequest, { requestedFraction: legacy.requestedFraction, estimatePolicy: legacy.estimatePolicy });
    assert.equal(estimate.policy, "device-fraction");
    assert.equal(estimate.confidence, "fraction-only");
    // Merged onto the legacy base it gives the golden back, key order included.
    const rebuilt = { ...legacy, requestedFraction: 0.5, estimatePolicy: "x" };
    Object.assign(rebuilt, { requestedFraction: undefined }, estimate.admissionRequest);
    assert.equal(JSON.stringify(rebuilt), JSON.stringify(legacy));
  }
  // The golden SGLang request (P0-RT-3 fraction of free memory) as well.
  const sglang = (await golden("R-V1-vllm-parallel-sglang-tp2-key")).expect.gpuAdmissionRequest;
  const estimate = memoryModels.estimate("sglang", {
    values: { "sglang.memFractionStatic": sglang.requestedFractionOfFree, "sglang.maxTotalTokens": sglang.poolCappedTokens },
  });
  assert.deepEqual(estimate.admissionRequest, {
    requestedFractionOfFree: sglang.requestedFractionOfFree,
    poolCappedTokens: sglang.poolCappedTokens,
    minClampMb: sglang.minClampMb,
    estimatePolicy: sglang.estimatePolicy,
  });
});

test("the SGLang admission request is byte-equal to P0-RT-3's for the Flash-Next 262K profile", async () => {
  const config = profileConfig("qwen38-flash-next-sglang-262k");
  const { json } = await launchAdmissionRequest(config);
  // P0-RT-3's launch-request.js output, captured before ENG-12 (model path aside).
  const expected = {
    managerId: "vllm-manager", engine: "sglang", instanceMode: "replace", instanceId: "qwen3-8-flash-next",
    containerName: "vllm-local", model: "<model>", gpuIds: ["0"], useAllGpus: false,
    estimatePolicy: "sglang_mem_fraction_static_of_free", maxModelLen: 262144, maxNumSeqs: 1, maxNumBatchedTokens: 0,
    requestedFractionOfFree: 0.995, poolCappedTokens: 262144, minClampMb: 4096,
  };
  const actual = JSON.parse(json);
  assert.equal(actual.model, config.model);
  assert.equal(JSON.stringify({ ...actual, model: "<model>" }), JSON.stringify(expected));

  const { sglangMaxTotalTokens, ...uncapped } = config;
  assert.equal(sglangMaxTotalTokens, 262144);
  const noPool = JSON.parse((await launchAdmissionRequest(uncapped)).json);
  assert.equal(JSON.stringify({ ...noPool, model: "<model>" }), JSON.stringify({ ...expected, poolCappedTokens: 0 }));
});

test("the Pennyroyal admission request keeps P0's measured shape", async () => {
  const config = profileConfig("orcarouter-pennyroyal-v251-524k");
  const { json } = await launchAdmissionRequest(config);
  assert.equal(json, JSON.stringify({
    managerId: "vllm-manager", engine: "sglang", instanceMode: "replace", instanceId: "pennyroyal",
    containerName: "vllm-local", model: config.model || "", gpuIds: ["0"], useAllGpus: false,
    estimatePolicy: "pennyroyal_v251_sm120_tp1_524k_measured", maxModelLen: 524288, maxNumSeqs: 4, maxNumBatchedTokens: 0,
    requestedMb: 88000,
  }));
});

test("the real gpu-admission module clamps the Flash-Next request and warns", async () => {
  const estimate = memoryModels.estimate("sglang", {
    values: { contextLength: 262144, concurrency: 1, "sglang.memFractionStatic": 0.995, "sglang.maxTotalTokens": 262144 },
  });
  assert.equal(estimate.policy, "static-fraction-of-free");
  assert.equal(estimate.kvPoolTokens, 262144);
  assert.equal(estimate.maxFullLengthRequests, 1);
  await withController(async (controller) => {
    const preview = await controller.evaluate(replaceRequest(estimate.admissionRequest), { mode: "replace" });
    assert.equal(preview.verdict, "warn");
    assert.equal(preview.clamped, true);
    assert.equal(preview.requestedMb, 96801);
    assert.equal(preview.reservedMb, 89095);

    const lease = await controller.acquire(replaceRequest(estimate.admissionRequest));
    assert.equal(lease.summary.verdict, "warn");
    assert.equal(lease.summary.clamped, true);
    assert.equal(lease.summary.reservations[0].estimateMb, 96801);
    assert.equal(lease.summary.reservations[0].requestedMb, 89095);
    await lease.release("test");
  });
});

test("without maxTotalTokens admission refuses with maxFraction 0.915, the replace text and knobs", async () => {
  const estimate = memoryModels.estimate("sglang", {
    values: { contextLength: 262144, concurrency: 1, "sglang.memFractionStatic": 0.995 },
  });
  assert.equal(estimate.admissionRequest.poolCappedTokens, 0);
  await withController(async (controller) => {
    await assert.rejects(controller.acquire(replaceRequest(estimate.admissionRequest)), (error) => {
      assert.equal(error.code, "insufficient_vram");
      assert.equal(error.status, 409);
      assert.equal(error.details.mode, "replace");
      assert.equal(error.details.maxFraction, 0.915);
      assert.match(error.message, /^替换启动需要 96801 MiB，安全预算只有 89095 MiB。请把「静态显存比例（mem-fraction-static）」降到 0\.915 以下/);
      assert.match(error.message, /Replacement launch needs 96801 MiB but the safe budget is 89095 MiB\./);
      assert.deepEqual(error.details.knobs, [
        { param: "sglang.memFractionStatic", suggestion: 0.915 },
        { param: "sglang.maxTotalTokens", suggestion: 131072 },
      ]);
      return true;
    });
  });
});

test("details.knobs names the vLLM and llama.cpp fraction params", () => {
  assert.deepEqual(core.admissionKnobs({ engine: "vllm", requestedFraction: 0.9 }, 0.8), [{ param: "vllm.gpuMemoryUtilization", suggestion: 0.8 }]);
  assert.deepEqual(core.admissionKnobs({ engine: "llama", requestedFraction: 0.9 }, 0.8), [{ param: "llamacpp.planningUtilization", suggestion: 0.8 }]);
  assert.deepEqual(core.admissionKnobs({ engine: "sglang", requestedFractionOfFree: 0.9, maxModelLen: 32768 }, 0.7), [
    { param: "sglang.memFractionStatic", suggestion: 0.7 },
    { param: "sglang.maxTotalTokens", suggestion: 32768 },
  ]);
  assert.deepEqual(core.admissionKnobs({ requestedMb: 1000 }, null), []);
});

test("Pennyroyal reserves 88000 MiB at 524288 tokens and 84672 MiB at 262144", () => {
  for (const [tokens, mb] of [[524288, 88000], [262144, 84672]]) {
    const recipeMemory = pennyroyalRecipeMemory({ sglangMaxTotalTokens: tokens, maxModelLen: 524288 });
    const estimate = memoryModels.estimate("sglang", {
      values: { "sglang.memFractionStatic": 0.9, "sglang.maxTotalTokens": tokens },
      recipeMemory,
    });
    assert.equal(estimate.policy, "measured");
    assert.equal(estimate.confidence, "measured");
    assert.deepEqual(estimate.admissionRequest, { requestedMb: mb, estimatePolicy: "pennyroyal_v251_sm120_tp1_524k_measured" });
    assert.equal(estimate.admissionRequestMb, mb);
  }
});

test("an exact calibration gives measured and admission verdict ok", async () => {
  const calibration = { exact: true, measuredMb: 71234, samples: 2 };
  const estimate = memoryModels.estimate("sglang", {
    values: { contextLength: 262144, concurrency: 1, "sglang.memFractionStatic": 0.995, "sglang.maxTotalTokens": 262144 },
    calibration,
  });
  assert.equal(estimate.policy, "measured");
  assert.equal(estimate.confidence, "measured");
  assert.deepEqual(estimate.admissionRequest, { requestedMb: 74796, poolCappedTokens: 262144, estimatePolicy: "sglang_calibrated" });
  await withController(async (controller) => {
    const preview = await controller.evaluate(replaceRequest(estimate.admissionRequest), { mode: "replace" });
    assert.equal(preview.verdict, "ok");
    assert.equal(preview.clamped, false);
    assert.equal(preview.reservedMb, 74796);
  });
  // Not exact, or no pool cap: the P0-RT-3 fraction request stays.
  for (const variant of [
    { calibration: { ...calibration, exact: false }, pool: 262144 },
    { calibration, pool: 0 },
  ]) {
    const fallback = memoryModels.estimate("sglang", {
      values: { "sglang.memFractionStatic": 0.995, "sglang.maxTotalTokens": variant.pool },
      calibration: variant.calibration,
    });
    assert.equal(fallback.policy, "static-fraction-of-free");
    assert.equal(fallback.admissionRequest.requestedFractionOfFree, 0.995);
  }
  // llama.cpp: the measured peak plus 3 %.
  const llama = memoryModels.estimate("llamacpp", { values: {}, calibration: { exact: true, measuredMb: 20000 } });
  assert.deepEqual(llama.admissionRequest, { requestedMb: 20600, estimatePolicy: "llama_calibrated" });
});

test("the launch request takes a calibration from the resolver's calibrationFor hook", async () => {
  const calls = [];
  const config = profileConfig("qwen38-flash-next-sglang-262k");
  const { request, job } = await launchAdmissionRequest(config, {
    deps: {
      calibrationFor: (card, engineId, runtimeId, key) => {
        calls.push({ card, engineId, runtimeId, key });
        return { exact: true, measuredMb: 71234, samples: 2 };
      },
    },
    acquireAfterPrepare: async (admissionRequest) => ({
      lease: {
        summary: { id: "lease", verdict: "ok", clamped: false, requestedTotalMb: admissionRequest.requestedMb, reservations: [{ gpuId: "0", requestedMb: admissionRequest.requestedMb, estimateMb: admissionRequest.requestedMb, availableMb: 89095 }] },
        async commit() {},
        async release() {},
      },
      context: null,
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].card, null);
  assert.equal(calls[0].engineId, "sglang");
  assert.equal(typeof calls[0].runtimeId, "string");
  assert.equal(calls[0].key, "262144|1|auto|262144");
  assert.equal(request.estimatePolicy, "sglang_calibrated");
  assert.equal(request.requestedMb, 74796);
  assert.equal(request.poolCappedTokens, 262144);
  assert.equal(Object.hasOwn(request, "requestedFractionOfFree"), false);
  assert.equal(Object.hasOwn(request, "requestedFraction"), false);
  assert.equal(job.meta.admission.policy, "measured");
  assert.equal(job.meta.admission.verdict, "ok");
});

test("a failing calibration lookup only means no calibration", async () => {
  const config = profileConfig("qwen38-flash-next-sglang-262k");
  const { request } = await launchAdmissionRequest(config, {
    deps: { calibrationFor: () => { throw new Error("store unavailable"); } },
  });
  assert.equal(request.estimatePolicy, "sglang_mem_fraction_static_of_free");
  assert.equal(request.requestedFractionOfFree, 0.995);
});

test("paramsKey for vLLM, SGLang and llama.cpp", () => {
  const { paramsKey } = core.engines;
  assert.equal(paramsKey, memoryModels.paramsKey);
  assert.equal(paramsKey({ engineId: "vllm", values: { contextLength: 131072, concurrency: 4, kvCacheDtype: "fp8" } }), "131072|4|fp8|-");
  assert.equal(paramsKey({ engineId: "vllm", values: { contextLength: 8192, concurrency: 1 } }), "8192|1|auto|-");
  assert.equal(paramsKey({
    engineId: "sglang",
    values: {
      contextLength: { value: 262144, source: "recipe" },
      concurrency: { value: 1, source: "user" },
      "sglang.maxTotalTokens": { value: 262144, source: "recipe" },
    },
  }), "262144|1|auto|262144");
  assert.equal(paramsKey({ engineId: "sglang", values: { contextLength: 32768, concurrency: 2, "sglang.maxTotalTokens": 0 } }), "32768|2|auto|-");
  assert.equal(paramsKey({ engineId: "llamacpp", values: { contextLength: 65536, concurrency: 2, "llamacpp.cacheTypeK": "q8_0", "llamacpp.cacheTypeV": "q8_0" } }), "65536|2|q8_0/q8_0|-");
  assert.equal(paramsKey({ engineId: "llamacpp", values: { contextLength: 4096, concurrency: 1 } }), "4096|1|f16/f16|-");
});

test("core.engines exports the memory models for 02", () => {
  assert.equal(core.engines.memoryModels.estimate, memoryModels.estimate);
  assert.equal(typeof core.engines.memoryModels.MEMORY_CONSTANTS.nonTorchMb, "number");
  for (const name of ["deviceFraction", "staticFractionOfFree", "ggufEstimate", "freeFractionAfterWeights", "weightsPlusKv", "measured", "serverReported"]) {
    assert.equal(typeof memoryModels[name], "function", name);
  }
  for (const id of ["vllm", "sglang", "llamacpp"]) {
    assert.equal(typeof core.engines.adapters[id].estimateMemory, "function", id);
  }
});

test("adapters build MemoryInputs from the plan and call estimate", () => {
  const sglang = core.engines.adapters.sglang.estimateMemory(
    { values: { contextLength: { value: 262144, source: "recipe" }, "sglang.memFractionStatic": 0.995, "sglang.maxTotalTokens": 262144 } },
    { hostFacts: { gpus: [{ ...FLASH_NEXT_GPU }] } },
  );
  assert.equal(sglang.policy, "static-fraction-of-free");
  assert.deepEqual(sglang.perGpuMb, { 0: 96801 });
  const vllm = core.engines.adapters.vllm.estimateMemory({ values: { "vllm.gpuMemoryUtilization": 0.9 } }, { gpus: [{ id: "0", totalMb: 10000, usedMb: 0 }] });
  assert.deepEqual(vllm.admissionRequest, { requestedFraction: 0.9, estimatePolicy: "vllm_gpu_memory_utilization" });
  assert.deepEqual(vllm.perGpuMb, { 0: 9000 });
  const llama = core.engines.adapters.llamacpp.estimateMemory({ values: {} }, {
    legacy: { estimateParallelVram: { requestedMb: 24000, requestedMbByGpu: { 0: 24000 }, estimatePolicy: "llama_gguf_metadata" } },
  });
  assert.equal(llama.policy, "gguf-estimate");
  assert.deepEqual(llama.admissionRequest, { requestedMb: 24000, requestedMbByGpu: { 0: 24000 }, estimatePolicy: "llama_gguf_metadata" });
});

test("artifact inputs add a breakdown and the KV findings", () => {
  const artifact = { weightsMb: 41230, kvBytesPerToken: 65536, stateBytesPerSeq: 0, hidden: 5120, vocab: 248320, confidence: "config" };
  const gpus = [{ id: "0", totalMb: 97887, usedMb: 600 }];
  const vllm = memoryModels.estimate("vllm", {
    values: { contextLength: 131072, concurrency: 8, "vllm.gpuMemoryUtilization": 0.9 },
    artifact,
    gpus,
  });
  assert.equal(vllm.confidence, "estimated");
  assert.equal(vllm.breakdown.weights, 41230);
  assert.equal(vllm.breakdown.overhead, 512 + 768);
  assert.ok(vllm.maxFullLengthRequests >= 1);
  assert.deepEqual(vllm.warnings.map((item) => item.code), ["kv_pool_below_concurrency"]);
  const tooSmall = memoryModels.estimate("vllm", { values: { contextLength: 1048576, concurrency: 1, "vllm.gpuMemoryUtilization": 0.5 }, artifact, gpus });
  assert.deepEqual(tooSmall.errors.map((item) => item.code), ["kv_pool_too_small"]);

  const sglang = memoryModels.estimate("sglang", {
    values: { contextLength: 1048576, concurrency: 1, "sglang.memFractionStatic": 0.6, "sglang.maxTotalTokens": 1048576 },
    artifact,
    gpus,
  });
  assert.equal(sglang.breakdown.weights, 41230);
  assert.equal(sglang.breakdown.overhead, 1024);
  assert.deepEqual(sglang.warnings.map((item) => item.code), ["sglang_pool_shrinks"]);
  assert.ok(sglang.kvPoolTokens < 1048576);
  // The admission request never depends on the artifact.
  assert.deepEqual(sglang.admissionRequest, memoryModels.estimate("sglang", {
    values: { "sglang.memFractionStatic": 0.6, "sglang.maxTotalTokens": 1048576 },
  }).admissionRequest);
});

test("the data-only memory models", () => {
  const artifact = { weightsMb: 10000, kvBytesPerToken: 131072 };
  const gpus = [{ id: "0", totalMb: 24576, usedMb: 576 }];
  const lmdeploy = memoryModels.estimate("lmdeploy", { values: { "lmdeploy.cacheMaxEntryCount": 0.5 }, artifact, gpus }, {
    memoryModel: { kind: "free-fraction-after-weights", fractionParam: "lmdeploy.cacheMaxEntryCount" },
  });
  assert.deepEqual(lmdeploy.admissionRequest, { requestedMb: 17000, estimatePolicy: "free_fraction_after_weights" });
  assert.deepEqual(lmdeploy.warnings.map((item) => item.code), ["engine_memory_estimate_coarse"]);
  const tabby = memoryModels.estimate("tabbyapi", { values: { "tabbyapi.cacheSize": 8192 }, artifact }, {
    memoryModel: { kind: "weights-plus-kv", poolTokensParam: "tabbyapi.cacheSize" },
  });
  assert.deepEqual(tabby.admissionRequest, { requestedMb: 10000 + 1024 + 1024, estimatePolicy: "weights_plus_kv" });
  const external = memoryModels.estimate("external", { values: {} });
  assert.equal(external.policy, "server-reported");
  assert.equal(external.admissionRequest, null);
  assert.throws(() => memoryModels.estimate("nope", {}, { registry: { get: () => null } }), { code: "unknown_memory_model" });
});

test("/api/memory-estimate keeps its shape and reports engine sglang", () => {
  const gpu = { id: "0", name: "GPU 0", totalMb: 97887, usedMb: 600 };
  const body = { engine: "sglang", paramsB: 30, contextTokens: 262144, gpuMemoryUtilization: 0.995, sglangMaxTotalTokens: 262144, selectedGpus: [gpu] };
  const sglang = buildVllmMemoryEstimate(body);
  const vllm = buildVllmMemoryEstimate({ ...body, engine: "vllm" });
  assert.equal(sglang.engine, "sglang");
  assert.equal(vllm.engine, "vllm");
  assert.deepEqual(Object.keys(sglang), ["ok", "engine", "plan", "recommendations"]);
  assert.deepEqual(Object.keys(sglang.recommendations), Object.keys(vllm.recommendations));
  assert.deepEqual(Object.keys(sglang.plan).filter((key) => !["policy", "estimatePolicy", "admissionPreview"].includes(key)), Object.keys(vllm.plan));
  assert.equal(sglang.plan.policy, "static-fraction-of-free");
  assert.equal(sglang.plan.estimatePolicy, "sglang_mem_fraction_static_of_free");
  assert.equal(sglang.plan.admissionPreview.requestedMb, 96801);
  assert.equal(sglang.plan.admissionPreview.poolCappedTokens, 262144);

  const pennyroyal = buildVllmMemoryEstimate({ engine: "sglang", runtimeImage: PENNYROYAL_IMAGE, sglangMaxTotalTokens: 524288, selectedGpus: [gpu] });
  assert.equal(pennyroyal.engine, "sglang");
  assert.deepEqual(Object.keys(pennyroyal.plan), ["estimatePolicy", "selectedGpus", "perGpuGb", "minUsableGb", "status", "memorySplitFactor", "overflowPerGpuGb"]);
  assert.equal(pennyroyal.plan.estimatePolicy, "pennyroyal_v251_sm120_tp1_524k_measured");
  assert.equal(pennyroyal.plan.perGpuGb, 88000 / 1024);
});
