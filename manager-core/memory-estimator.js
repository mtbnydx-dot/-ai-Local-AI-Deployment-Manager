"use strict";

const GIB = 1024 ** 3;

const DEFAULT_ARCH_BUCKETS = [
  { maxParamsB: 2, layers: 24, kvHeads: 8, headDim: 128, label: "small model heuristic" },
  { maxParamsB: 8, layers: 32, kvHeads: 8, headDim: 128, label: "7B/8B heuristic" },
  { maxParamsB: 16, layers: 40, kvHeads: 8, headDim: 128, label: "14B heuristic" },
  { maxParamsB: 34, layers: 48, kvHeads: 8, headDim: 128, label: "27B/32B heuristic" },
  { maxParamsB: 80, layers: 80, kvHeads: 8, headDim: 128, label: "70B heuristic" },
  { maxParamsB: Infinity, layers: 96, kvHeads: 8, headDim: 128, label: "large model heuristic" },
];

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function bytesToGiB(bytes) {
  return finiteNumber(bytes, 0) / GIB;
}

function estimateArchitecture(paramsB, override = null) {
  if (override && override.layers && override.kvHeads && override.headDim) {
    return {
      layers: Math.max(1, Math.floor(finiteNumber(override.layers, 1))),
      kvLayers: Math.max(1, Math.floor(finiteNumber(override.kvLayers || override.layers, override.layers))),
      kvHeads: Math.max(1, Math.floor(finiteNumber(override.kvHeads, 1))),
      headDim: Math.max(1, Math.floor(finiteNumber(override.headDim, 128))),
      label: override.label || "model config",
      source: override.source || "config",
    };
  }
  const params = finiteNumber(paramsB, 0);
  const bucket = DEFAULT_ARCH_BUCKETS.find((item) => params <= item.maxParamsB) || DEFAULT_ARCH_BUCKETS.at(-1);
  return { ...bucket, kvLayers: bucket.layers, source: "heuristic" };
}

function estimateWeightGiB({ paramsB, bytesPerParam = 2, multiplier = 1 } = {}) {
  const params = Math.max(0, finiteNumber(paramsB, 0));
  return bytesToGiB(params * 1_000_000_000 * Math.max(0, finiteNumber(bytesPerParam, 2)) * Math.max(0, finiteNumber(multiplier, 1)));
}

function estimateKvCacheGiB({
  contextTokens,
  layers,
  kvLayers,
  kvHeads,
  headDim,
  kvBytes = 2,
  sequences = 1,
} = {}) {
  const tokens = Math.max(0, finiteNumber(contextTokens, 0));
  const layerCount = Math.max(1, finiteNumber(kvLayers || layers, layers || 1));
  const heads = Math.max(1, finiteNumber(kvHeads, 1));
  const dim = Math.max(1, finiteNumber(headDim, 128));
  const bytes = Math.max(0.125, finiteNumber(kvBytes, 2));
  const seqs = Math.max(1, finiteNumber(sequences, 1));
  return bytesToGiB(tokens * seqs * 2 * layerCount * heads * dim * bytes);
}

function normalizeGpuForEstimate(gpu = {}, { utilization = 0.9, reserveGb = 1 } = {}) {
  const totalGb = finiteNumber(gpu.totalGb, finiteNumber(gpu.totalMb, 0) / 1024);
  const usedGb = finiteNumber(gpu.usedGb, finiteNumber(gpu.usedMb, 0) / 1024);
  const freeGb = Math.max(0, finiteNumber(gpu.freeGb, totalGb - usedGb));
  const util = clamp(finiteNumber(utilization, 0.9), 0.1, 0.98);
  const usableGb = Math.max(0, Math.min(totalGb * util, freeGb - Math.max(0, reserveGb)));
  return {
    ...gpu,
    totalGb,
    usedGb,
    freeGb,
    utilization: util,
    reserveGb: Math.max(0, reserveGb),
    usableGb,
  };
}

function vllmSplitFactor({ mode = "single", tensorParallelSize = 1, pipelineParallelSize = 1 } = {}) {
  if (mode === "tensor") return Math.max(1, Math.floor(finiteNumber(tensorParallelSize, 1)));
  if (mode === "pipeline") return Math.max(1, Math.floor(finiteNumber(pipelineParallelSize, 1)));
  return 1;
}

function estimateVllmMemoryPlan({
  paramsB,
  contextTokens,
  bytesPerParam = 2,
  kvBytes = 2,
  arch,
  selectedGpus = [],
  utilization = 0.9,
  mode = "single",
  tensorParallelSize = 1,
  pipelineParallelSize = 1,
  cpuOffloadGb = 0,
  kvOffloadGb = 0,
  overheadRatio = 0.08,
  multimodalReserveGb = 0,
} = {}) {
  const modelArch = estimateArchitecture(paramsB, arch);
  const splitFactor = vllmSplitFactor({ mode, tensorParallelSize, pipelineParallelSize });
  const memorySplitFactor = mode === "data" ? 1 : splitFactor;
  const weightsGb = estimateWeightGiB({ paramsB, bytesPerParam });
  const kvGb = estimateKvCacheGiB({ contextTokens, ...modelArch, kvBytes });
  const cpuOffloadPerGpuGb = Math.max(0, finiteNumber(cpuOffloadGb, 0));
  const kvOffloadTotalGb = Math.max(0, finiteNumber(kvOffloadGb, 0));
  const weightPerGpuBeforeOffloadGb = weightsGb / memorySplitFactor;
  const kvPerGpuBeforeOffloadGb = kvGb / memorySplitFactor;
  const kvOffloadPerGpuGb = kvOffloadTotalGb / memorySplitFactor;
  const weightPerGpuGb = Math.max(0, weightPerGpuBeforeOffloadGb - cpuOffloadPerGpuGb);
  const kvPerGpuGb = Math.max(0, kvPerGpuBeforeOffloadGb - kvOffloadPerGpuGb);
  const overheadPerGpuGb = Math.max(1.2, (weightPerGpuGb + kvPerGpuGb) * Math.max(0, finiteNumber(overheadRatio, 0.08))) + Math.max(0, finiteNumber(multimodalReserveGb, 0));
  const perGpuGb = weightPerGpuGb + kvPerGpuGb + overheadPerGpuGb;
  const gpus = selectedGpus.map((gpu) => normalizeGpuForEstimate(gpu, { utilization }));
  const minUsableGb = gpus.length ? Math.min(...gpus.map((gpu) => gpu.usableGb)) : 0;
  const overflowPerGpuGb = gpus.length ? Math.max(0, perGpuGb - minUsableGb) : 0;
  const status = !gpus.length ? "warn" : perGpuGb <= minUsableGb * 0.9 ? "ok" : perGpuGb <= minUsableGb ? "warn" : "fail";
  const recommendedCpuOffloadGb = overflowPerGpuGb > 0
    ? Math.min(weightPerGpuBeforeOffloadGb, cpuOffloadPerGpuGb + overflowPerGpuGb + 2)
    : cpuOffloadPerGpuGb;
  const recommendedKvOffloadGb = overflowPerGpuGb > 0 && recommendedCpuOffloadGb >= weightPerGpuBeforeOffloadGb
    ? kvOffloadTotalGb + overflowPerGpuGb * memorySplitFactor
    : kvOffloadTotalGb;

  return {
    engine: "vllm",
    arch: modelArch,
    weightsGb,
    kvGb,
    weightPerGpuBeforeOffloadGb,
    kvPerGpuBeforeOffloadGb,
    weightPerGpuGb,
    kvPerGpuGb,
    overheadPerGpuGb,
    perGpuGb,
    splitFactor,
    memorySplitFactor,
    cpuOffloadPerGpuGb,
    kvOffloadTotalGb,
    kvOffloadPerGpuGb,
    selectedGpus: gpus,
    minUsableGb,
    overflowPerGpuGb,
    status,
    recommendedCpuOffloadGb,
    recommendedKvOffloadGb,
  };
}

function estimateLlamaMemoryPlan({
  paramsB,
  contextTokens,
  bytesPerParam = 0.56,
  kvBytes = 2,
  arch,
  selectedGpus = [],
  utilization = 0.9,
  gpuLayers = "all",
  tensorSplitWeights = [],
  overheadRatio = 0.08,
  multimodalReserveGb = 0,
} = {}) {
  const modelArch = estimateArchitecture(paramsB, arch);
  const totalLayers = Math.max(1, finiteNumber(modelArch.layers, 1));
  const requestedLayers = gpuLayers === "all" || gpuLayers === "auto"
    ? totalLayers
    : clamp(Math.floor(finiteNumber(gpuLayers, totalLayers)), 0, totalLayers);
  const layerRatio = requestedLayers / totalLayers;
  const totalWeightsGb = estimateWeightGiB({ paramsB, bytesPerParam });
  const gpuWeightsGb = totalWeightsGb * layerRatio;
  const cpuWeightsGb = Math.max(0, totalWeightsGb - gpuWeightsGb);
  const totalKvGb = estimateKvCacheGiB({ contextTokens, ...modelArch, kvBytes });
  const gpuKvGb = totalKvGb * layerRatio;
  const cpuKvGb = Math.max(0, totalKvGb - gpuKvGb);
  const overheadGb = Math.max(1.2, (gpuWeightsGb + gpuKvGb) * Math.max(0, finiteNumber(overheadRatio, 0.08))) + Math.max(0, finiteNumber(multimodalReserveGb, 0));
  const totalGpuGb = gpuWeightsGb + gpuKvGb + overheadGb;
  const gpus = selectedGpus.map((gpu) => normalizeGpuForEstimate(gpu, { utilization }));
  const weights = tensorSplitWeights.length === gpus.length && tensorSplitWeights.some((item) => finiteNumber(item, 0) > 0)
    ? tensorSplitWeights.map((item) => Math.max(0, finiteNumber(item, 0)))
    : gpus.map((gpu) => Math.max(1, gpu.usableGb || gpu.totalGb || 1));
  const sum = weights.reduce((acc, item) => acc + item, 0) || 1;
  const allocations = gpus.map((gpu, index) => {
    const allocatedGb = totalGpuGb * (weights[index] || 0) / sum;
    const overflowGb = Math.max(0, allocatedGb - gpu.usableGb);
    return { gpu, weight: weights[index] || 0, allocatedGb, overflowGb, usableGb: gpu.usableGb };
  });
  const peakGpuGb = allocations.length ? Math.max(...allocations.map((item) => item.allocatedGb)) : totalGpuGb;
  const anyOverflow = allocations.some((item) => item.overflowGb > 0);
  const status = !allocations.length ? "warn" : anyOverflow ? "fail" : allocations.some((item) => item.allocatedGb > item.usableGb * 0.9) ? "warn" : "ok";
  const totalUsableGb = allocations.reduce((sumGb, item) => sumGb + item.usableGb, 0);
  const perLayerGpuGb = totalLayers > 0 ? (totalWeightsGb + totalKvGb) / totalLayers : 0;
  const recommendedLayerRatio = totalWeightsGb > 0
    ? clamp((Math.max(0, totalUsableGb * 0.88 - Math.max(1.2, totalKvGb * 0.02) - multimodalReserveGb)) / Math.max(totalWeightsGb + totalKvGb, perLayerGpuGb || 1), 0, 1)
    : 0;
  const recommendedGpuLayers = Math.max(0, Math.floor(totalLayers * recommendedLayerRatio));

  return {
    engine: "llama.cpp",
    arch: modelArch,
    totalWeightsGb,
    gpuWeightsGb,
    cpuWeightsGb,
    totalKvGb,
    kvGb: gpuKvGb,
    gpuKvGb,
    cpuKvGb,
    overheadGb,
    totalGpuGb,
    requestedGpuLayers: requestedLayers,
    totalLayers,
    allocations,
    selectedGpus: gpus,
    peakGpuGb,
    status,
    recommendedGpuLayers,
  };
}

module.exports = {
  bytesToGiB,
  estimateArchitecture,
  estimateWeightGiB,
  estimateKvCacheGiB,
  normalizeGpuForEstimate,
  estimateVllmMemoryPlan,
  estimateLlamaMemoryPlan,
};
