function normalizeLlamaSplitMode(value) {
  const mode = String(value || "layer").trim().toLowerCase();
  if (mode === "single") return "none";
  if (mode === "pipeline") return "layer";
  if (mode === "data") return "layer";
  return new Set(["none", "layer", "tensor", "row"]).has(mode) ? mode : "layer";
}

function suggestTensorSplit(gpus, gpuDeviceIds = [], utilization = 0.92, mode = "layer") {
  const plan = buildLlamaGpuPlan({ ok: true, gpus: gpus || [] }, gpuDeviceIds, utilization, mode);
  return plan.recommendedTensorSplit || "";
}

function buildLlamaGpuPlan(gpuStatus, gpuDeviceIds = [], utilization = 0.92, mode = "layer", mainGpuValue = null) {
  const allGpus = Array.isArray(gpuStatus?.gpus) ? gpuStatus.gpus : [];
  const selectedIds = normalizeGpuIds(gpuDeviceIds);
  const ratio = Math.min(0.98, Math.max(0.1, Number(utilization || 0.92)));
  const selected = selectPlanGpus(allGpus, selectedIds).map((gpu, visibleIndex) => normalizePlanGpu(gpu, visibleIndex, ratio));
  const selectedGpuIds = selected.map((gpu) => gpu.id);
  const splitMode = normalizeLlamaSplitMode(mode);
  const mainGpu = normalizeMainGpu(mainGpuValue, selectedGpuIds);
  const primary = selected[mainGpu] || selected[0] || null;
  const hetero = isHeterogeneousGpuSet(selected);

  if (selected.length < 2 || splitMode === "none") {
    return {
      ok: Boolean(selected.length),
      selectedGpuIds,
      selected,
      visibleCount: selected.length,
      hetero,
      recommendedMode: "none",
      recommendedTensorSplit: "",
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      summary: selected.length
        ? `Single GPU mode on GPU ${primary?.id || mainGpu}`
        : "No NVIDIA GPU selected",
      profiles: selected.length ? buildSingleGpuProfiles(selected, mainGpu) : [],
      notes: selected.length
        ? ["只选择一张 GPU 时，llama.cpp 容器内 main-gpu 应为 0。"]
        : ["未检测到可用于规划的 NVIDIA GPU。"],
    };
  }

  const memorySplit = splitStringFromWeights(selected.map((gpu) => gpu.usableGb));
  const speedSplit = splitStringFromWeights(selected.map((gpu) => gpu.usableGb * gpu.performanceFactor));
  const lightOffloadSplit = buildLightOffloadSplit(selected);
  const recommendedTensorSplit = splitMode === "layer"
    ? lightOffloadSplit || speedSplit || memorySplit
    : splitMode === "row"
      ? memorySplit
      : speedSplit || memorySplit;
  const profiles = [
    {
      id: "hetero-layer-speed",
      label: "异构稳妥",
      mode: "layer",
      tensorSplit: lightOffloadSplit || speedSplit || memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: `${shortGpuLabel(primary?.name, primary?.id)} 承担更多层，其它 GPU 轻量分担，通常更适合本地 Claude 单路交互。`,
    },
    {
      id: "hetero-layer-capacity",
      label: "长上下文",
      mode: "layer",
      tensorSplit: memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: "按可用显存接近 2:1 分配，优先换更长上下文和更大 KV cache。",
    },
    {
      id: "row-balanced",
      label: "row 并行",
      mode: "row",
      tensorSplit: memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: "行切分有并行收益，但 KV 和中间结果更依赖 main GPU，建议先做短测。",
    },
    {
      id: "tensor-experimental",
      label: "tensor 实验",
      mode: "tensor",
      tensorSplit: speedSplit || memorySplit,
      mainGpu,
      mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
      description: "张量切分可能提高吞吐，但异构卡更容易被慢卡拖住。",
    },
  ];

  return {
    ok: true,
    selectedGpuIds,
    selected,
    visibleCount: selected.length,
    hetero,
    recommendedMode: splitMode,
    recommendedTensorSplit,
    memoryTensorSplit: memorySplit,
    speedTensorSplit: speedSplit,
    lightOffloadTensorSplit: lightOffloadSplit,
    mainGpu,
    mainGpuHostId: primary?.id || mainGpuHostId(mainGpu, selectedGpuIds),
    summary: hetero
      ? `${selected.length} 张异构 GPU：建议 main GPU ${primary?.id || 0}，${splitMode} split ${recommendedTensorSplit}`
      : `${selected.length} 张同级 GPU：建议 ${splitMode} split ${recommendedTensorSplit}`,
    profiles,
    notes: [
      "main-gpu 传给 llama.cpp 的是容器内可见序号，不是宿主机物理编号。",
      hetero
        ? "异构多卡优先 layer；小显存或较慢的卡适合轻量分担或长上下文扩容，不一定让单路速度翻倍。"
        : "同级多卡可以更积极尝试 row 或 tensor split。",
    ],
  };
}

function normalizeGpuIds(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return Array.from(new Set(raw.map(String).filter((item) => /^\d+$/.test(item))));
}

function normalizeMainGpu(value, gpuDeviceIds = []) {
  const selected = (gpuDeviceIds || []).map(String);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  const asText = String(value).trim();
  const hostIndex = selected.indexOf(asText);
  if (hostIndex >= 0) return hostIndex;
  const ordinal = Math.floor(number);
  if (selected.length && ordinal >= selected.length) return 0;
  return ordinal;
}

function mainGpuHostId(mainGpu, gpuDeviceIds = []) {
  const selected = (gpuDeviceIds || []).map(String);
  return selected[mainGpu] ?? String(mainGpu || 0);
}

function selectPlanGpus(gpus, selectedIds = []) {
  if (!Array.isArray(gpus) || !gpus.length) return [];
  const ids = (selectedIds || []).map(String);
  const selected = ids.length
    ? gpus.filter((gpu) => ids.includes(String(gpu.id)) || ids.includes(String(gpu.index)))
    : gpus;
  return selected.length ? selected : [gpus[0]];
}

function normalizePlanGpu(gpu, visibleIndex, utilization) {
  const totalMb = Number(gpu.totalMb || 0);
  const usedMb = Number(gpu.usedMb || 0);
  const freeMb = Math.max(0, totalMb - usedMb);
  const usableMb = Math.max(1024, Math.floor(Math.min(totalMb * utilization, Math.max(1024, freeMb - 1024))));
  const name = String(gpu.name || "NVIDIA GPU");
  return {
    id: String(gpu.id ?? gpu.index ?? visibleIndex),
    index: Number(gpu.index ?? gpu.id ?? visibleIndex),
    visibleIndex,
    name,
    totalMb,
    usedMb,
    freeMb,
    usableMb,
    totalGb: roundGb(totalMb),
    usedGb: roundGb(usedMb),
    freeGb: roundGb(freeMb),
    usableGb: roundGb(usableMb),
    utilization: Number(gpu.util || 0),
    temp: Number(gpu.temp || 0),
    performanceFactor: estimateGpuPerformanceFactor(name),
  };
}

function roundGb(mb) {
  return Math.round((Number(mb || 0) / 1024) * 10) / 10;
}

function estimateGpuPerformanceFactor(name) {
  const text = String(name || "").toLowerCase();
  if (text.includes("blackwell") || text.includes("rtx pro 6000") || text.includes("pro 6000")) return 1.55;
  if (text.includes("5090")) return 1.45;
  if (text.includes("5080")) return 1.18;
  if (text.includes("5070 ti")) return 0.86;
  if (text.includes("5070")) return 0.76;
  if (text.includes("4090")) return 1.1;
  if (text.includes("4080")) return 0.9;
  return 1;
}

function shortGpuLabel(name, fallbackId = "0") {
  const text = String(name || "").replace(/^NVIDIA\s+/i, "").trim();
  if (!text) return `GPU ${fallbackId}`;
  if (/RTX PRO 6000/i.test(text)) return "RTX PRO 6000";
  if (/RTX 6000/i.test(text)) return "RTX 6000";
  const match = text.match(/(RTX\s+\d{4}(?:\s*Ti)?|A100|H100|H200|B200|L40S)/i);
  return match ? match[1].replace(/\s+/g, " ") : `GPU ${fallbackId}`;
}

function isHeterogeneousGpuSet(gpus) {
  if (!gpus || gpus.length < 2) return false;
  const totals = gpus.map((gpu) => Number(gpu.totalMb || 0)).filter(Boolean);
  const names = new Set(gpus.map((gpu) => String(gpu.name || "").replace(/\s+/g, " ").trim().toLowerCase()));
  if (names.size > 1) return true;
  if (totals.length < 2) return false;
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  return min > 0 && max / min > 1.2;
}

function splitStringFromWeights(weights) {
  const clean = (weights || []).map((value) => Math.max(1, Number(value || 0)));
  if (clean.length < 2) return "";
  return clean.map((value) => String(Math.max(1, Math.round(value)))).join(",");
}

function buildLightOffloadSplit(gpus) {
  if (!gpus || gpus.length !== 2) return "";
  const [first, second] = gpus;
  const bigger = first.usableGb >= second.usableGb ? first : second;
  const smaller = bigger === first ? second : first;
  const memoryRatio = bigger.usableGb / Math.max(1, smaller.usableGb);
  if (memoryRatio < 1.35) return "";
  const bigShare = Math.max(1, Math.round(bigger.usableGb * 0.82));
  const smallShare = Math.max(1, Math.round(smaller.usableGb * 0.55));
  return gpus.map((gpu) => gpu === bigger ? bigShare : smallShare).join(",");
}

function buildSingleGpuProfiles(gpus, mainGpu) {
  return gpus.map((gpu) => ({
    id: `single-${gpu.id}`,
    label: `只用 GPU ${gpu.id}`,
    mode: "none",
    tensorSplit: "",
    mainGpu,
    mainGpuHostId: gpu.id,
    description: `${gpu.name} · 可用约 ${gpu.usableGb} GB。`,
  }));
}

module.exports = {
  buildLlamaGpuPlan,
  normalizeLlamaSplitMode,
  suggestTensorSplit,
};
