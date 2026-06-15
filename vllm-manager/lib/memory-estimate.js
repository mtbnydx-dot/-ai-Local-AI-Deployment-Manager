const core = require("../../manager-core");

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

function buildVllmMemoryEstimate(input = {}) {
  const selectedGpus = normalizeMemoryEstimateGpus(input.selectedGpus || input.gpus || []);
  const mode = String(input.multiGpuMode || input.mode || "single").toLowerCase();
  const normalizedMode = mode === "none" ? "single" : mode;
  const arch = normalizeMemoryEstimateArch(input.arch || input.modelConfig || input.config);
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
    multimodalReserveGb: Math.max(0, memoryEstimateNumber(input.multimodalReserveGb, input.arch?.isMultimodal ? 2 : 0)),
  });
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
  return {
    ok: true,
    engine: "vllm",
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

module.exports = {
  buildVllmMemoryEstimate,
  normalizeMemoryEstimateArch,
  normalizeMemoryEstimateGpus,
};
