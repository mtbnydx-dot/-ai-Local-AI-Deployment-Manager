const core = require("../../manager-core");
const { isPennyroyalImage, pennyroyalRecipeMemory } = require("./pennyroyal");

// SGLang bodies go through the engine memory model (01-engines §12), so this
// preview and the launch ask admission for the same request.
function estimateSglangMemory(input, recipeMemory = null) {
  const pool = Math.max(0, Math.floor(memoryEstimateNumber(input.sglangMaxTotalTokens, 0)));
  return core.engines.memoryModels.estimate("sglang", {
    values: {
      contextLength: Math.floor(memoryEstimateNumber(input.contextTokens ?? input.maxModelLen, 0)) || undefined,
      "sglang.memFractionStatic": memoryEstimateNumber(input.gpuMemoryUtilization ?? input.utilization, 0.9),
      "sglang.maxTotalTokens": pool,
    },
    recipeMemory,
  });
}

function memoryEstimateNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeMemoryEstimateArch(value = null) {
  if (!value || typeof value !== "object") return null;
  const layers = memoryEstimateNumber(value.layers ?? value.numHiddenLayers ?? value.num_hidden_layers, 0);
  const kvLayers = memoryEstimateNumber(value.kvLayers ?? value.numKvLayers ?? value.num_key_value_layers ?? layers, layers);
  const kvHeads = memoryEstimateNumber(value.kvHeads ?? value.numKeyValueHeads ?? value.num_key_value_heads, 0);
  const headDim = memoryEstimateNumber(value.headDim ?? value.head_dim, 0);
  if (!layers || !kvHeads || !headDim) return null;
  return {
    layers,
    kvLayers,
    kvHeads,
    headDim,
    label: value.label || value.modelType || value.model_type || "request config",
    source: value.source || "request",
  };
}

function normalizeMemoryEstimateGpus(value = []) {
  const list = Array.isArray(value) ? value : [];
  return list.map((gpu = {}, index) => {
    const totalMb = memoryEstimateNumber(gpu.totalMb ?? gpu.total_mib ?? gpu.memoryTotalMb, 0);
    const usedMb = memoryEstimateNumber(gpu.usedMb ?? gpu.used_mib ?? gpu.memoryUsedMb, 0);
    const freeMb = memoryEstimateNumber(gpu.freeMb ?? gpu.free_mib ?? gpu.memoryFreeMb, Math.max(0, totalMb - usedMb));
    const totalGb = memoryEstimateNumber(gpu.totalGb, totalMb / 1024);
    const usedGb = memoryEstimateNumber(gpu.usedGb, usedMb / 1024);
    const freeGb = memoryEstimateNumber(gpu.freeGb, freeMb / 1024);
    return {
      id: String(gpu.id ?? gpu.index ?? index),
      name: String(gpu.name || `GPU ${gpu.id ?? index}`),
      totalMb: totalGb ? totalGb * 1024 : totalMb,
      usedMb: usedGb ? usedGb * 1024 : usedMb,
      freeMb: freeGb ? freeGb * 1024 : freeMb,
      totalGb,
      usedGb,
      freeGb,
    };
  }).filter((gpu) => gpu.totalGb > 0 || gpu.totalMb > 0);
}

// Preview of the SGLang VRAM admission decision on the minimum-free selected
// GPU. The policy comes from the server (never from the request body) and
// defaults to the gpu-admission module defaults for direct calls.
function previewSglangAdmission(input, selectedGpus) {
  const gpus = core.normalizeGpuTelemetry({ gpus: selectedGpus });
  if (!gpus.length) return null;
  const gpu = gpus.reduce((lowest, item) => (item.freeMb < lowest.freeMb ? item : lowest));
  const policySource = input.admissionPolicy && typeof input.admissionPolicy === "object" ? input.admissionPolicy : {};
  const policy = core.normalizeGpuAdmissionPolicy(policySource, {
    reserveMb: core.DEFAULT_RESERVE_MB,
    maxUtilizationPct: core.DEFAULT_MAX_UTILIZATION_PCT,
  });
  const startupMarginMb = Math.max(0, Math.round(memoryEstimateNumber(policySource.startupMarginMb, core.DEFAULT_STARTUP_MARGIN_MB)));
  const request = estimateSglangMemory(input).admissionRequest;
  const poolCappedTokens = request.poolCappedTokens;
  let decision;
  try {
    decision = core.decideGpuReservation(request, gpu, {
      pendingMb: 0,
      reserveMb: policy.reserveMb,
      maxUtilization: policy.maxUtilizationPct,
      startupMarginMb,
    });
  } catch {
    return null;
  }
  const mode = String(input.instanceMode || "replace").toLowerCase() === "parallel" ? "parallel" : "replace";
  return {
    preview: {
      verdict: decision.verdict,
      requestedMb: decision.requestedMb,
      availableMb: decision.availableMb,
      reservedMb: decision.reservedMb,
      clamped: decision.clamped,
      maxFraction: decision.maxFraction,
      poolCappedTokens,
      basis: "policy-snapshot",
    },
    message: core.formatGpuAdmissionMessage(decision, request, { mode }),
  };
}

function buildVllmLegacyEstimate(input = {}) {
  const selectedGpus = normalizeMemoryEstimateGpus(input.selectedGpus || input.gpus || []);
  if (input.engine === "sglang" && isPennyroyalImage(input.runtimeImage)) {
    const measured = estimateSglangMemory(input, pennyroyalRecipeMemory(input)).admissionRequest;
    const perGpuGb = measured.requestedMb / 1024;
    const minUsableGb = selectedGpus.length ? Math.min(...selectedGpus.map(gpu => gpu.freeGb)) : 0;
    const status = selectedGpus.length && perGpuGb > minUsableGb ? "fail" : "warn";
    return {
      ok: true, engine: "sglang",
      plan: { estimatePolicy: measured.estimatePolicy, selectedGpus,
        perGpuGb, minUsableGb, status, memorySplitFactor: 1,
        overflowPerGpuGb: Math.max(0, perGpuGb - minUsableGb) },
      recommendations: { status, summary: "Pennyroyal 实测预留；启动仍需通过实时显存门禁",
        suggestions: [`${perGpuGb * 1024} MiB 包含 GPU 权重、KV、MTP 和运行时；仅按实际 KV 分配结构缩减缓存预留。`, "约 51 GB FP8 PLE 位于 RAM；CPU HiCache/NIXL 关闭。", "全局显存安全余量与启动门禁保持生效。"] },
    };
  }
  const mode = String(input.multiGpuMode || input.mode || "single").toLowerCase();
  const normalizedMode = mode === "none" ? "single" : mode;
  const arch = normalizeMemoryEstimateArch(input.arch || input.modelConfig || input.config);
  const speculativeMode = String(input.speculativeMode || "off").toLowerCase();
  const speculativeTokens = Math.min(8, Math.max(1, Math.floor(memoryEstimateNumber(input.numSpeculativeTokens, 1))));
  const speculativeReserveGb = speculativeMode === "off" ? 0 : Math.min(6, 0.75 + speculativeTokens * 0.5);
  const plan = core.estimateVllmMemoryPlan({
    paramsB: memoryEstimateNumber(input.paramsB, 0),
    contextTokens: Math.max(1, memoryEstimateNumber(input.contextTokens ?? input.maxModelLen, 8192)),
    bytesPerParam: Math.max(0.125, memoryEstimateNumber(input.bytesPerParam, 2)),
    kvBytes: Math.max(0.125, memoryEstimateNumber(input.kvBytes, 2)),
    arch,
    selectedGpus,
    utilization: memoryEstimateNumber(input.gpuMemoryUtilization ?? input.utilization, 0.9),
    mode: normalizedMode,
    tensorParallelSize: Math.max(1, Math.floor(memoryEstimateNumber(input.tensorParallelSize ?? input.tpSize, normalizedMode === "tensor" ? selectedGpus.length || 1 : 1))),
    pipelineParallelSize: Math.max(1, Math.floor(memoryEstimateNumber(input.pipelineParallelSize ?? input.ppSize, normalizedMode === "pipeline" ? selectedGpus.length || 1 : 1))),
    cpuOffloadGb: Math.max(0, memoryEstimateNumber(input.cpuOffloadGb, 0)),
    kvOffloadGb: Math.max(0, memoryEstimateNumber(input.kvOffloadGb ?? input.kvOffloadingSize, 0)),
    multimodalReserveGb: Math.max(0, memoryEstimateNumber(input.multimodalReserveGb, input.arch?.isMultimodal ? 2 : 0)) + speculativeReserveGb,
  });
  plan.speculativeReserveGb = speculativeReserveGb;
  const sglang = input.engine === "sglang";
  const admissionPreview = sglang ? previewSglangAdmission(input, selectedGpus) : null;
  const suggestions = [];
  if (!plan.selectedGpus.length) {
    suggestions.push("没有传入 GPU 显存数据，只能给出模型本身的理论占用。");
  } else if (plan.status === "fail") {
    suggestions.push(`预计每卡超出约 ${plan.overflowPerGpuGb.toFixed(1)} GiB，可提高 CPU offload 或降低上下文。`);
  } else if (plan.status === "warn") {
    suggestions.push("预计接近可用显存上限，建议预留更低的 gpu-memory-utilization 或减少并发。");
  } else {
    suggestions.push("当前配置预计可运行，并保留了基本运行时余量。");
  }
  if (normalizedMode === "data" && plan.selectedGpus.length > 1) {
    suggestions.push("Data Parallel 会复制完整模型，不能降低单卡显存；长上下文优先考虑 Tensor/Pipeline 或 CPU offload。");
  }
  if (plan.recommendedCpuOffloadGb > plan.cpuOffloadPerGpuGb) {
    suggestions.push(`建议 CPU offload 至少设为 ${plan.recommendedCpuOffloadGb.toFixed(1)} GiB/卡。`);
  }
  if (plan.recommendedKvOffloadGb > plan.kvOffloadTotalGb) {
    suggestions.push(`权重已难以下放时，可尝试 KV offload 总量 ${plan.recommendedKvOffloadGb.toFixed(1)} GiB。`);
  }
  if (speculativeReserveGb > 0) {
    suggestions.push(`已为 ${speculativeMode} 推测解码额外预留约 ${speculativeReserveGb.toFixed(1)} GiB；最终是否提速应以接受率和输出吞吐为准。`);
  }
  if (sglang) {
    const sglangMemory = estimateSglangMemory(input);
    plan.policy = sglangMemory.policy;
    plan.estimatePolicy = sglangMemory.admissionRequest.estimatePolicy;
    plan.admissionPreview = admissionPreview ? admissionPreview.preview : null;
    if (admissionPreview) {
      // The admission verdict outranks the estimator: block is a launch the
      // gate will refuse, warn is a clamped reservation. ok keeps the estimate.
      if (admissionPreview.preview.verdict === "block") plan.status = "fail";
      else if (admissionPreview.preview.verdict === "warn") plan.status = "warn";
      if (admissionPreview.message) suggestions.unshift(admissionPreview.message);
    }
  }
  return {
    ok: true,
    engine: sglang ? "sglang" : "vllm",
    plan,
    recommendations: {
      status: plan.status,
      summary: plan.status === "ok" ? "预计可运行" : plan.status === "warn" ? "预计接近显存上限" : "预计会显存不足",
      suggestions,
      cpuOffloadGb: plan.recommendedCpuOffloadGb,
      kvOffloadingSize: plan.recommendedKvOffloadGb,
      overflowPerGpuGb: plan.overflowPerGpuGb,
      memorySplitFactor: plan.memorySplitFactor,
    },
  };
}

// A body without a model card keeps the legacy path byte for byte and answers
// synchronously. With a card (02 §10.7: cardId, or model with engineId /
// runtimeId / gpuIds / values) the answer comes from estimateFit and is a
// promise; the route awaits either.
function buildVllmMemoryEstimate(input = {}, options = {}) {
  if (!core.models.cardEstimate.cardModeRequested(input)) return buildVllmLegacyEstimate(input);
  return core.models.cardEstimate.buildCardEstimate(input, {
    managerFamily: "vllm",
    hostGpus: normalizeMemoryEstimateGpus(input.selectedGpus || input.gpus || []),
    legacy: buildVllmLegacyEstimate,
    admissionPolicy: input.admissionPolicy,
    ...options,
  });
}

module.exports = {
  buildVllmMemoryEstimate,
  normalizeMemoryEstimateArch,
  normalizeMemoryEstimateGpus,
};
