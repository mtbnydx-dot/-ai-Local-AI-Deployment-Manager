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

function parseMemoryEstimateWeights(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s:;]+/);
  return raw
    .map((item) => memoryEstimateNumber(item, NaN))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function buildLlamaMemoryEstimate(input = {}) {
  const selectedGpus = normalizeMemoryEstimateGpus(input.selectedGpus || input.gpus || []);
  const arch = normalizeMemoryEstimateArch(input.arch || input.modelConfig || input.config);
  const plan = core.estimateLlamaMemoryPlan({
    paramsB: memoryEstimateNumber(input.paramsB, 0),
    contextTokens: Math.max(1, memoryEstimateNumber(input.contextTokens ?? input.maxModelLen, 8192)),
    // GGUF usually has lower transient overhead than safetensors, so the default bytes/param is intentionally lower.
    bytesPerParam: Math.max(0.125, memoryEstimateNumber(input.bytesPerParam, 0.56)),
    kvBytes: Math.max(0.125, memoryEstimateNumber(input.kvBytes, 2)),
    arch,
    selectedGpus,
    utilization: memoryEstimateNumber(input.gpuMemoryUtilization ?? input.utilization, 0.9),
    gpuLayers: input.gpuLayers ?? input.nGpuLayers ?? "all",
    tensorSplitWeights: parseMemoryEstimateWeights(input.tensorSplitWeights ?? input.tensorSplit),
    multimodalReserveGb: Math.max(0, memoryEstimateNumber(input.multimodalReserveGb, input.arch?.isMultimodal ? 2 : 0)),
  });
  const suggestions = [];
  if (!plan.selectedGpus.length) {
    suggestions.push("没有传入 GPU 显存数据，只能给出模型本身的理论占用。");
  } else if (plan.status === "fail") {
    suggestions.push(`预计会溢出显存，建议把 GPU layers 降到 ${plan.recommendedGpuLayers}/${plan.totalLayers} 左右，让剩余层落到内存。`);
  } else if (plan.status === "warn") {
    suggestions.push("预计接近显存上限，建议降低 GPU layers、缩短上下文或调低可用显存比例。");
  } else {
    suggestions.push("当前配置预计可运行，并保留了基本运行时余量。");
  }
  if (selectedGpus.length > 1) {
    const suggestedSplit = selectedGpus.map((gpu) => Math.max(1, Math.round(gpu.freeGb || gpu.totalGb || 1))).join(",");
    suggestions.push(`异构多卡建议 tensor split 按可用显存近似填写：${suggestedSplit}。`);
  }
  return {
    ok: true,
    engine: "llama.cpp",
    plan,
    recommendations: {
      status: plan.status,
      summary: plan.status === "ok" ? "预计可运行" : plan.status === "warn" ? "预计接近显存上限" : "预计会显存不足",
      suggestions,
      recommendedGpuLayers: plan.recommendedGpuLayers,
      totalLayers: plan.totalLayers,
      peakGpuGb: plan.peakGpuGb,
      allocations: plan.allocations,
    },
  };
}

module.exports = {
  buildLlamaMemoryEstimate,
  normalizeMemoryEstimateArch,
  normalizeMemoryEstimateGpus,
  parseMemoryEstimateWeights,
};
