"use strict";

// Memory models (docs/overhaul/01-engines.md §12, 00 §9.1): the one
// engine-side memory estimator. It owns each engine's memory semantics and
// the exact gpu-admission request each policy produces, so the managers, the
// launch plan and /api/memory-estimate cannot disagree about what a launch
// asks admission for. It reads no files: artifact inputs come from the legacy
// model facts today and from 02 fit.js (MOD-9) later, and calibrations from
// 02 calibrationFor() through the resolver (MOD-10; null until then).
//
//   estimate(engineId, inputs, { descriptor?, registry? }) → MemoryEstimate
//   inputsFromPlan(plan, ctx) → MemoryInputs        (the adapters' estimateMemory)
//   paramsKey(plan, engineId?) → "262144|1|auto|262144"
//
// MemoryInputs: { values (catalog ids), artifact|null, gpus[], mode,
//                 recipeMemory|null, calibration|null, legacy|null }
// MemoryEstimate: the 00 §4.3 memory block plus { confidence, admissionRequest,
//                 notes[{zh,en}], warnings[], errors[] }.
//
// admissionRequest uses gpu-admission's own field names (P0-RT-3, must-keep):
// requestedMb, requestedMbByGpu, requestedFraction, requestedFractionOfFree,
// poolCappedTokens, minClampMb, estimatePolicy. The SGLang fraction request
// is byte-equal to what P0-RT-3's launch-request.js sent.

const { DEFAULT_MIN_CLAMP_MB, SGLANG_FRACTION_OF_FREE_ESTIMATE_POLICY } = require("../gpu-admission");

const MIB = 1024 * 1024;

// Activation, graph and non-torch constants (moved from 02 §10.4). Bytes
// unless the name says MiB.
const MEMORY_CONSTANTS = Object.freeze({
  activationBytesPerTokenHidden: 24,
  logitsBytesPerVocab: 4,
  logitsMaxSeqs: 256,
  cudaGraphMb: 512,
  nonTorchMb: 768,
  vllmDefaultMaxBatchedTokens: 8192,
  sglangDefaultChunkedPrefillSize: 8192,
  sglangOverheadMb: 1024,
  sglangCalibrationMargin: 1.05,
  ggufCalibrationMargin: 1.03,
  ggufComputeBaseMb: 256,
  ggufOverheadMb: 512,
  weightsPlusKvOverheadMb: 1024,
  minClampMb: DEFAULT_MIN_CLAMP_MB,
});

const ESTIMATE_POLICIES = Object.freeze({
  deviceFraction: "vllm_gpu_memory_utilization",
  staticFractionOfFree: SGLANG_FRACTION_OF_FREE_ESTIMATE_POLICY,
  sglangCalibrated: "sglang_calibrated",
  ggufCalibrated: "llama_calibrated",
  ggufEstimate: "gguf_estimate",
  ggufUnavailable: "llama_estimate_unavailable",
  recipeMeasured: "recipe_measured",
  freeFractionAfterWeights: "free_fraction_after_weights",
  weightsPlusKv: "weights_plus_kv",
});

// memoryModel.kind of the tier-1 engines when no registry is at hand.
const DEFAULT_MEMORY_MODELS = Object.freeze({
  vllm: Object.freeze({ kind: "device-fraction", fractionParam: "vllm.gpuMemoryUtilization" }),
  sglang: Object.freeze({ kind: "static-fraction-of-free", fractionParam: "sglang.memFractionStatic", poolTokensParam: "sglang.maxTotalTokens" }),
  llamacpp: Object.freeze({ kind: "gguf-estimate" }),
  external: Object.freeze({ kind: "server-reported" }),
});

const EMPTY_BREAKDOWN = Object.freeze({ weights: 0, kv: 0, activations: 0, draft: 0, mmproj: 0, overhead: 0 });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function fraction(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : 0;
}

function roundMb(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function bilingual(zh, en) {
  return { zh, en };
}

/** Plan values as plain values: { id: value } from { id: value | { value, source } }. */
function plainValues(values) {
  const out = {};
  for (const [id, entry] of Object.entries(isPlainObject(values) ? values : {})) {
    out[id] = isPlainObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry;
  }
  return out;
}

function normalizeGpus(gpus) {
  return (Array.isArray(gpus) ? gpus : []).map((gpu, index) => {
    const totalMb = positive(gpu?.totalMb);
    const usedMb = positive(gpu?.usedMb);
    const freeRaw = Number(gpu?.freeMb);
    const freeMb = Number.isFinite(freeRaw) && freeRaw >= 0 ? freeRaw : Math.max(0, totalMb - usedMb);
    return { id: String(gpu?.id ?? gpu?.index ?? index), totalMb, usedMb, freeMb };
  }).filter((gpu) => gpu.totalMb > 0);
}

function normalizeArtifact(artifact) {
  if (!isPlainObject(artifact)) return null;
  const weightsMb = positive(artifact.weightsMb);
  const kvBytesPerToken = positive(artifact.kvBytesPerToken);
  if (!weightsMb && !kvBytesPerToken) return null;
  return {
    weightsMb,
    kvBytesPerToken,
    kvBytesPerTokenHigh: positive(artifact.kvBytesPerTokenHigh) || kvBytesPerToken,
    stateBytesPerSeq: positive(artifact.stateBytesPerSeq),
    draftMb: positive(artifact.draftMb),
    mmprojMb: positive(artifact.mmprojMb),
    hidden: positive(artifact.hidden),
    vocab: positive(artifact.vocab),
    confidence: String(artifact.confidence || "heuristic"),
  };
}

function normalizeInputs(inputs = {}) {
  const source = isPlainObject(inputs) ? inputs : {};
  const mode = ["replace", "parallel", "add"].includes(source.mode) ? source.mode : "replace";
  return {
    values: plainValues(source.values),
    artifact: normalizeArtifact(source.artifact),
    gpus: normalizeGpus(source.gpus),
    mode,
    recipeMemory: isPlainObject(source.recipeMemory) ? source.recipeMemory : null,
    calibration: isPlainObject(source.calibration) ? source.calibration : null,
    legacy: isPlainObject(source.legacy) ? source.legacy : null,
  };
}

/** The informational per-GPU footprint of an admission request (MiB by GPU id). */
function perGpuFor(request, gpus) {
  const out = {};
  if (!request) return out;
  for (const gpu of gpus) {
    const byGpu = isPlainObject(request.requestedMbByGpu) ? positive(request.requestedMbByGpu[gpu.id]) : 0;
    let mb = byGpu || positive(request.requestedMb);
    if (fraction(request.requestedFraction)) mb = Math.max(mb, Math.ceil(gpu.totalMb * request.requestedFraction));
    if (fraction(request.requestedFractionOfFree)) mb = Math.max(mb, Math.ceil(Math.max(1, gpu.freeMb * request.requestedFractionOfFree)));
    if (mb > 0) out[gpu.id] = mb;
  }
  return out;
}

function result(policy, inputs, fields = {}) {
  const admissionRequest = fields.admissionRequest || null;
  const requestedMb = positive(admissionRequest?.requestedMb);
  return {
    perGpuMb: perGpuFor(admissionRequest, inputs.gpus),
    breakdown: { ...EMPTY_BREAKDOWN, ...(fields.breakdown || {}) },
    admissionRequestMb: requestedMb || null,
    kvPoolTokens: Number.isFinite(fields.kvPoolTokens) && fields.kvPoolTokens > 0 ? Math.floor(fields.kvPoolTokens) : null,
    maxFullLengthRequests: Number.isFinite(fields.maxFullLengthRequests) ? Math.max(0, Math.floor(fields.maxFullLengthRequests)) : null,
    policy,
    confidence: fields.confidence || "estimated",
    admissionRequest,
    notes: fields.notes || [],
    warnings: fields.warnings || [],
    errors: fields.errors || [],
  };
}

function finding(code, zh, en, extra = {}) {
  return { code, message: bilingual(zh, en), ...extra };
}

// The memory-tightest GPU decides whether a launch fits.
function tightestGpu(gpus, key) {
  return gpus.length ? gpus.reduce((low, gpu) => (gpu[key] < low[key] ? gpu : low)) : null;
}

// ---------------------------------------------------------------------------
// Policies (exported for tests)
// ---------------------------------------------------------------------------

/**
 * vLLM: --gpu-memory-utilization reserves a fraction of the whole device. The
 * admission request is today's; with artifact inputs the estimate splits the
 * reservation into weights, activations, graphs, non-torch memory and the KV
 * pool left over.
 */
function deviceFraction(inputs, model = DEFAULT_MEMORY_MODELS.vllm) {
  const values = inputs.values;
  const gmu = values[model.fractionParam || "vllm.gpuMemoryUtilization"];
  const admissionRequest = { requestedFraction: gmu, estimatePolicy: ESTIMATE_POLICIES.deviceFraction };
  const artifact = inputs.artifact;
  const gpu = tightestGpu(inputs.gpus, "totalMb");
  if (!artifact || !gpu || !fraction(gmu)) {
    return result("device-fraction", inputs, {
      admissionRequest,
      confidence: "fraction-only",
      notes: [bilingual("vLLM 按整卡显存比例预留；没有模型尺寸数据，只显示预留比例。", "vLLM reserves a fraction of the whole device; without model size data only the fraction is shown.")],
    });
  }
  const C = MEMORY_CONSTANTS;
  const shards = Math.max(1, Math.floor(positive(values.tensorParallel) || 1)) * Math.max(1, Math.floor(positive(values.pipelineParallel) || 1));
  const concurrency = Math.max(1, Math.floor(positive(values.concurrency) || 1));
  const contextLength = Math.max(1, Math.floor(positive(values.contextLength) || 1));
  const batched = positive(values["vllm.maxNumBatchedTokens"]) || C.vllmDefaultMaxBatchedTokens;
  const reservedMb = gmu * gpu.totalMb;
  const weights = artifact.weightsMb / shards;
  const activations = (batched * artifact.hidden * C.activationBytesPerTokenHidden
    + artifact.vocab * C.logitsBytesPerVocab * Math.min(concurrency, C.logitsMaxSeqs)) / MIB;
  const graphs = values["vllm.enforceEager"] ? 0 : C.cudaGraphMb;
  const draft = artifact.draftMb / shards;
  const mmproj = artifact.mmprojMb / shards;
  const kvPoolMb = reservedMb - weights - activations - graphs - C.nonTorchMb - draft - mmproj;
  const perSeqBytes = (contextLength * artifact.kvBytesPerToken + artifact.stateBytesPerSeq) / shards;
  const maxFull = kvPoolMb > 0 && perSeqBytes > 0 ? Math.floor((kvPoolMb * MIB) / perSeqBytes) : 0;
  const errors = [];
  const warnings = [];
  if (maxFull < 1) {
    errors.push(finding("kv_pool_too_small",
      `KV 缓存池放不下一个 ${contextLength} tokens 的完整请求；请提高显存预留比例或降低上下文长度。`,
      `The KV cache pool cannot hold one full ${contextLength}-token request; raise the GPU memory reservation or lower the context length.`,
      { field: "contextLength" }));
  } else if (maxFull < concurrency) {
    warnings.push(finding("kv_pool_below_concurrency",
      `KV 缓存池只能同时容纳 ${maxFull} 个完整长度请求，少于并发 ${concurrency}。`,
      `The KV cache pool holds only ${maxFull} full-length requests, fewer than the concurrency of ${concurrency}.`,
      { field: "concurrency" }));
  }
  return result("device-fraction", inputs, {
    admissionRequest,
    confidence: "estimated",
    breakdown: {
      weights: roundMb(weights),
      kv: roundMb(Math.max(0, kvPoolMb)),
      activations: roundMb(activations),
      draft: roundMb(draft),
      mmproj: roundMb(mmproj),
      overhead: roundMb(graphs + C.nonTorchMb),
    },
    kvPoolTokens: artifact.kvBytesPerToken > 0 && kvPoolMb > 0 ? (kvPoolMb * MIB * shards) / artifact.kvBytesPerToken : 0,
    maxFullLengthRequests: maxFull,
    errors,
    warnings,
  });
}

/**
 * SGLang: --mem-fraction-static is a fraction of the memory free when the
 * engine starts (weights + KV pool); --max-total-tokens caps the pool, which
 * lets admission clamp to the safe budget (P0-RT-3). The admission request is
 * byte-equal to P0-RT-3's; artifact inputs add an informational breakdown.
 */
function staticFractionOfFree(inputs, model = DEFAULT_MEMORY_MODELS.sglang) {
  const values = inputs.values;
  const f = values[model.fractionParam || "sglang.memFractionStatic"];
  const pool = Math.floor(positive(values[model.poolTokensParam || "sglang.maxTotalTokens"]));
  const admissionRequest = {
    requestedFractionOfFree: f,
    poolCappedTokens: pool || 0,
    minClampMb: MEMORY_CONSTANTS.minClampMb,
    estimatePolicy: ESTIMATE_POLICIES.staticFractionOfFree,
  };
  const contextLength = Math.floor(positive(values.contextLength));
  const notes = [bilingual(
    "SGLang 的静态显存比例按启动时的空闲显存计算（权重 + KV 池）；设置 KV 池上限后，显存不足时会按安全预算收紧预留。",
    "SGLang's static memory fraction applies to the memory free at start (weights + KV pool); with a KV pool cap, admission clamps the reservation to the safe budget when memory is short.")];
  const artifact = inputs.artifact;
  const gpu = tightestGpu(inputs.gpus, "freeMb");
  if (!artifact || !gpu || !fraction(f) || !(artifact.kvBytesPerToken > 0)) {
    return result("static-fraction-of-free", inputs, {
      admissionRequest,
      confidence: "fraction-only",
      kvPoolTokens: pool,
      maxFullLengthRequests: pool && contextLength ? pool / contextLength : null,
      notes,
    });
  }
  const C = MEMORY_CONSTANTS;
  const staticMb = f * gpu.freeMb;
  const weights = artifact.weightsMb;
  const fixedMb = weights + artifact.draftMb + artifact.mmprojMb;
  const tokensFit = Math.max(0, Math.floor(((staticMb - fixedMb) * MIB) / artifact.kvBytesPerToken));
  const kvTokens = pool ? Math.min(pool, tokensFit) : tokensFit;
  const mambaSeqs = positive(values["sglang.maxMambaCacheSize"]) || positive(values["sglang.maxRunningRequests"]) || positive(values.concurrency) || 1;
  const kv = (kvTokens * artifact.kvBytesPerToken + artifact.stateBytesPerSeq * mambaSeqs) / MIB;
  const chunked = positive(values["sglang.chunkedPrefillSize"]) || C.sglangDefaultChunkedPrefillSize;
  const activations = (chunked * artifact.hidden * C.activationBytesPerTokenHidden) / MIB;
  const warnings = [];
  if (pool && weights + (pool * artifact.kvBytesPerToken) / MIB > staticMb) {
    warnings.push(finding("sglang_pool_shrinks",
      `权重加 ${pool} tokens 的 KV 池超过静态显存比例可用的 ${roundMb(staticMb)} MiB，SGLang 会自动缩小 KV 池。`,
      `Weights plus a ${pool}-token KV pool exceed the ${roundMb(staticMb)} MiB the static memory fraction allows; SGLang will shrink the KV pool.`,
      { field: "sglang.maxTotalTokens" }));
  }
  return result("static-fraction-of-free", inputs, {
    admissionRequest,
    confidence: "estimated",
    breakdown: {
      weights: roundMb(weights),
      kv: roundMb(kv),
      activations: roundMb(activations),
      draft: roundMb(artifact.draftMb),
      mmproj: roundMb(artifact.mmprojMb),
      overhead: C.sglangOverheadMb,
    },
    kvPoolTokens: kvTokens,
    maxFullLengthRequests: contextLength ? kvTokens / contextLength : null,
    notes,
    warnings,
  });
}

/**
 * A measured footprint: a recipe's memory.measuredMiB (Pennyroyal) or an
 * exact calibration (02 MOD-10). SGLang keeps its pool cap so a calibrated
 * launch that does not fit still clamps and warns like P0-RT-3; it sends no
 * requestedFractionOfFree, so the fraction candidate cannot dominate.
 */
function measured(inputs, model = {}, { engineId = "" } = {}) {
  const recipeMb = positive(inputs.recipeMemory?.measuredMiB);
  if (recipeMb) {
    return result("measured", inputs, {
      admissionRequest: {
        requestedMb: recipeMb,
        estimatePolicy: String(inputs.recipeMemory.estimatePolicy || ESTIMATE_POLICIES.recipeMeasured),
      },
      confidence: "measured",
      notes: [bilingual("按配方实测的显存预留；启动仍需通过实时显存门禁。", "The recipe's measured reservation; the launch still passes the live VRAM gate.")],
    });
  }
  const calibrationMb = positive(inputs.calibration?.measuredMb);
  if (!calibrationMb) return null;
  const notes = [bilingual("按本机实测校准的显存预留。", "A reservation calibrated from measurements on this host.")];
  const kind = model.kind || "";
  if (kind === "gguf-estimate" || engineId === "llamacpp") {
    return result("measured", inputs, {
      admissionRequest: { requestedMb: Math.ceil(calibrationMb * MEMORY_CONSTANTS.ggufCalibrationMargin), estimatePolicy: ESTIMATE_POLICIES.ggufCalibrated },
      confidence: "measured",
      notes,
    });
  }
  const pool = Math.floor(positive(inputs.values[model.poolTokensParam || "sglang.maxTotalTokens"]));
  return result("measured", inputs, {
    admissionRequest: {
      requestedMb: Math.ceil(calibrationMb * MEMORY_CONSTANTS.sglangCalibrationMargin),
      poolCappedTokens: pool,
      estimatePolicy: ESTIMATE_POLICIES.sglangCalibrated,
    },
    confidence: "measured",
    kvPoolTokens: pool,
    notes,
  });
}

/**
 * llama.cpp: today's estimateParallelVram request (inputs.legacy) and its
 * fail-closed fallback, unchanged. With artifact inputs and no legacy
 * estimate (02 MOD-9) the GGUF formula of 02 §10.4 gives requestedMb.
 */
function ggufEstimate(inputs) {
  const values = inputs.values;
  const legacy = inputs.legacy?.estimateParallelVram || inputs.legacy?.admissionRequest || null;
  if (isPlainObject(legacy) && positive(legacy.requestedMb)) {
    return result("gguf-estimate", inputs, {
      admissionRequest: {
        requestedMb: legacy.requestedMb,
        requestedMbByGpu: legacy.requestedMbByGpu ?? null,
        estimatePolicy: String(legacy.estimatePolicy || ESTIMATE_POLICIES.ggufEstimate),
      },
      confidence: "estimated",
    });
  }
  const artifact = inputs.artifact;
  if (artifact && artifact.weightsMb) {
    const C = MEMORY_CONSTANTS;
    const contextLength = positive(values.contextLength);
    const ubatch = positive(values["llamacpp.ubatchSize"]) || 512;
    const kv = (contextLength * artifact.kvBytesPerToken) / MIB;
    const compute = (ubatch * (artifact.hidden * C.activationBytesPerTokenHidden + artifact.vocab * C.logitsBytesPerVocab)) / MIB + C.ggufComputeBaseMb;
    const total = artifact.weightsMb + kv + compute + artifact.mmprojMb + artifact.draftMb + C.ggufOverheadMb;
    return result("gguf-estimate", inputs, {
      admissionRequest: { requestedMb: Math.ceil(total), estimatePolicy: ESTIMATE_POLICIES.ggufEstimate },
      confidence: "estimated",
      breakdown: {
        weights: roundMb(artifact.weightsMb),
        kv: roundMb(kv),
        activations: roundMb(compute),
        draft: roundMb(artifact.draftMb),
        mmproj: roundMb(artifact.mmprojMb),
        overhead: C.ggufOverheadMb,
      },
    });
  }
  // No trustworthy estimate: admission refuses unless a fraction is planned.
  const planned = fraction(values["llamacpp.planningUtilization"]);
  return result("gguf-estimate", inputs, {
    admissionRequest: { requestedFraction: planned || null, estimatePolicy: ESTIMATE_POLICIES.ggufUnavailable },
    confidence: "fraction-only",
    warnings: [finding("gguf_estimate_unavailable",
      "无法估算 GGUF 显存占用；没有可信估算时显存门禁会拒绝并行启动。",
      "The GGUF memory footprint cannot be estimated; without a trustworthy estimate the VRAM gate refuses parallel launches.")],
  });
}

/** LMDeploy / TensorRT-LLM: weights plus a fraction of what is free after them. */
function freeFractionAfterWeights(inputs, model = {}) {
  const f = fraction(inputs.values[model.fractionParam]);
  const weights = positive(inputs.artifact?.weightsMb) || positive(inputs.legacy?.modelDirMb);
  const gpu = tightestGpu(inputs.gpus, "freeMb");
  const warnings = [finding("engine_memory_estimate_coarse",
    "这个引擎的显存估算较粗略，按权重加剩余显存比例预留。",
    "This engine's memory estimate is coarse: weights plus a fraction of the memory left after them.")];
  if (!weights || !gpu || !f) return result("free-fraction-after-weights", inputs, { confidence: "fraction-only", warnings });
  const requestedMb = Math.ceil(weights + f * Math.max(0, gpu.freeMb - weights));
  return result("free-fraction-after-weights", inputs, {
    admissionRequest: { requestedMb, estimatePolicy: ESTIMATE_POLICIES.freeFractionAfterWeights },
    breakdown: { weights: roundMb(weights), kv: roundMb(requestedMb - weights) },
    warnings,
  });
}

/** TabbyAPI: weights plus the configured cache (tokens × bytes per token) plus 1 GiB. */
function weightsPlusKv(inputs, model = {}) {
  const values = inputs.values;
  const artifact = inputs.artifact;
  const weights = positive(artifact?.weightsMb);
  const cacheSize = positive(values[model.poolTokensParam]) || positive(values.contextLength) * Math.max(1, positive(values.concurrency) || 1);
  if (!weights || !artifact?.kvBytesPerToken || !cacheSize) return result("weights-plus-kv", inputs, { confidence: "fraction-only" });
  const kv = (cacheSize * artifact.kvBytesPerToken) / MIB;
  const overhead = MEMORY_CONSTANTS.weightsPlusKvOverheadMb;
  return result("weights-plus-kv", inputs, {
    admissionRequest: { requestedMb: Math.ceil(weights + kv + overhead), estimatePolicy: ESTIMATE_POLICIES.weightsPlusKv },
    breakdown: { weights: roundMb(weights), kv: roundMb(kv), overhead },
    kvPoolTokens: cacheSize,
  });
}

/** External endpoints: the server reports its own VRAM (display only, no lease). */
function serverReported(inputs) {
  const reportedMb = positive(inputs.legacy?.reportedMb);
  return result("server-reported", inputs, {
    confidence: reportedMb ? "measured" : "fraction-only",
    breakdown: reportedMb ? { weights: roundMb(reportedMb) } : {},
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function memoryModelFor(engineId, options = {}) {
  if (isPlainObject(options.memoryModel)) return options.memoryModel;
  let descriptor = isPlainObject(options.descriptor) ? options.descriptor : null;
  if (!descriptor) {
    try {
      const registry = options.registry || require("./registry").getEngineRegistry();
      descriptor = registry.get(engineId);
    } catch {
      descriptor = null;
    }
  }
  if (isPlainObject(descriptor?.memoryModel)) return descriptor.memoryModel;
  return DEFAULT_MEMORY_MODELS[engineId] || null;
}

/**
 * estimate(engineId, inputs, { descriptor?, registry?, memoryModel? }) → MemoryEstimate.
 * Dispatches on descriptor.memoryModel.kind. A recipe's measured memory and
 * an exact calibration (SGLang with a capped pool, llama.cpp) take precedence
 * over the engine's own policy (01 §12 table).
 */
function estimate(engineId, inputs = {}, options = {}) {
  const id = String(engineId || "");
  const model = memoryModelFor(id, options);
  if (!model) {
    const error = new Error(`Engine ${id || "(none)"} has no memory model.`);
    error.code = "unknown_memory_model";
    throw error;
  }
  const normalized = normalizeInputs(inputs);
  const calibrated = normalized.calibration?.exact === true && positive(normalized.calibration.measuredMb);
  switch (model.kind) {
    case "device-fraction":
      return deviceFraction(normalized, model);
    case "static-fraction-of-free": {
      const pool = positive(normalized.values[model.poolTokensParam || "sglang.maxTotalTokens"]);
      if (positive(normalized.recipeMemory?.measuredMiB) || (calibrated && pool)) {
        return measured(normalized, model, { engineId: id });
      }
      return staticFractionOfFree(normalized, model);
    }
    case "gguf-estimate":
      if (calibrated) return measured(normalized, model, { engineId: id });
      return ggufEstimate(normalized, model);
    case "measured":
      return measured(normalized, model, { engineId: id }) || result("measured", normalized, { confidence: "fraction-only" });
    case "free-fraction-after-weights":
      return freeFractionAfterWeights(normalized, model);
    case "weights-plus-kv":
      return weightsPlusKv(normalized, model);
    case "server-reported":
      return serverReported(normalized, model);
    default: {
      const error = new Error(`Unknown memory model kind ${String(model.kind)}.`);
      error.code = "unknown_memory_model";
      throw error;
    }
  }
}

/**
 * The adapters' MemoryInputs (01 §6 estimateMemory): effective plan values
 * plus what ctx knows. ctx.artifact (02 fit.js), ctx.calibration
 * (calibrationFor), ctx.recipeMemory or the applied recipe's plan.memory,
 * ctx.gpus or ctx.hostFacts.gpus, ctx.legacy (llama.cpp's estimate).
 */
function inputsFromPlan(plan = {}, ctx = {}) {
  const source = isPlainObject(plan) ? plan : {};
  const recipeMemory = isPlainObject(ctx.recipeMemory) ? ctx.recipeMemory
    : isPlainObject(source.memory) && positive(source.memory.measuredMiB) ? source.memory : null;
  return {
    values: plainValues(source.values),
    artifact: ctx.artifact ?? null,
    gpus: Array.isArray(ctx.gpus) ? ctx.gpus : Array.isArray(ctx.hostFacts?.gpus) ? ctx.hostFacts.gpus : [],
    mode: ctx.instanceMode || source.instance?.mode || "replace",
    recipeMemory,
    calibration: ctx.calibration ?? null,
    legacy: ctx.legacy ?? null,
  };
}

function keyPart(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

/**
 * paramsKey(plan, engineId?) → `${contextLength}|${concurrency}|${kv}|${maxTotalTokens}`
 * over effective values (00 §9.1): kv is kvCacheDtype ("auto" when unset), or
 * `${cacheTypeK}/${cacheTypeV}` for llama.cpp ("f16/f16" when unset);
 * maxTotalTokens is sglang.maxTotalTokens or "-". The calibration store key.
 */
function paramsKey(plan = {}, engineId = null) {
  const source = isPlainObject(plan) ? plan : {};
  const values = plainValues(source.values);
  const engine = String(engineId || source.engineId || "");
  const llama = engine === "llamacpp" || engine === "llama"
    || (!engine && Object.keys(values).some((id) => id.startsWith("llamacpp.")));
  const kv = llama
    ? `${keyPart(values["llamacpp.cacheTypeK"], "f16")}/${keyPart(values["llamacpp.cacheTypeV"], "f16")}`
    : keyPart(values.kvCacheDtype, "auto");
  const maxTotalTokens = positive(values["sglang.maxTotalTokens"]) ? String(Math.floor(values["sglang.maxTotalTokens"])) : "-";
  return `${keyPart(values.contextLength, "-")}|${keyPart(values.concurrency, "-")}|${kv}|${maxTotalTokens}`;
}

module.exports = {
  MEMORY_CONSTANTS,
  ESTIMATE_POLICIES,
  DEFAULT_MEMORY_MODELS,
  estimate,
  inputsFromPlan,
  paramsKey,
  memoryModelFor,
  deviceFraction,
  staticFractionOfFree,
  ggufEstimate,
  freeFractionAfterWeights,
  weightsPlusKv,
  measured,
  serverReported,
};
