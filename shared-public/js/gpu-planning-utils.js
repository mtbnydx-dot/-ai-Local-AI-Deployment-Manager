(function () {
  function clampUtilization(value, fallback = 0.9) {
    const number = Number(value);
    return Math.min(0.98, Math.max(0.1, Number.isFinite(number) ? number : fallback));
  }

  function normalizeGpuForPlan(gpu = {}, options = {}) {
    const totalMb = Number(gpu.totalMb || 0);
    const usedMb = Number(gpu.usedMb || 0);
    const freeMb = Math.max(0, totalMb - usedMb);
    const reserveMb = Number(options.reserveMb ?? 1024);
    const minUsableMb = Number(options.minUsableMb ?? 0);
    const utilization = clampUtilization(options.utilization, options.defaultUtilization || 0.9);
    const rawUsableMb = Math.min(totalMb * utilization, freeMb - reserveMb);
    const usableMb = Math.max(minUsableMb, rawUsableMb);
    const normalized = {
      ...gpu,
      id: String(gpu.id ?? gpu.index ?? options.visibleIndex ?? "0"),
      visibleIndex: Number(options.visibleIndex ?? gpu.index ?? 0),
      totalGb: totalMb / 1024,
      usedGb: usedMb / 1024,
      freeGb: freeMb / 1024,
      usableGb: Math.max(0, usableMb) / 1024,
      generation: inferGpuGeneration(gpu.name),
    };
    if (options.includePerformance) normalized.performanceFactor = estimateGpuPerformanceFactor(gpu.name);
    return normalized;
  }

  function inferGpuGeneration(name) {
    const text = String(name || "").toLowerCase();
    if (text.includes("blackwell") || text.includes("rtx pro 6000") || text.includes("pro 6000")) return "Blackwell 96GB";
    if (text.includes("rtx 50") || text.includes("5090") || text.includes("5080") || text.includes("5070")) return "RTX 50";
    if (text.includes("rtx 40") || text.includes("4090") || text.includes("4080") || text.includes("4070")) return "RTX 40";
    if (text.includes("a100")) return "A100";
    if (text.includes("h100")) return "H100";
    return "";
  }

  function shortGpuLabel(name, fallbackId = "0") {
    const text = String(name || "").replace(/^NVIDIA\s+/i, "").trim();
    if (!text) return `GPU ${fallbackId}`;
    if (/RTX PRO 6000/i.test(text)) return "RTX PRO 6000";
    if (/RTX 6000/i.test(text)) return "RTX 6000";
    const match = text.match(/(RTX\s+\d{4}(?:\s*Ti)?|A100|H100|H200|B200|L40S)/i);
    return match ? match[1].replace(/\s+/g, " ") : `GPU ${fallbackId}`;
  }

  function isHeterogeneous(gpus, threshold = 1.2) {
    if (!gpus || gpus.length < 2) return false;
    const totals = gpus.map((gpu) => Number(gpu.totalGb || 0) || Number(gpu.totalMb || 0) / 1024).filter(Boolean);
    if (totals.length > 1 && Math.max(...totals) / Math.max(1, Math.min(...totals)) > threshold) return true;
    const names = new Set(gpus.map((gpu) => String(gpu.name || "").replace(/\s+/g, " ").toLowerCase()));
    return names.size > 1;
  }

  // Relative-throughput table. The built-in list is the fallback; the manager
  // serves an updatable copy from manager-core/data/gpu-performance.json via
  // /api/reference-data, so new hardware does not require a code change.
  const BUILT_IN_GPU_PERFORMANCE = {
    defaultFactor: 1,
    factors: [
      { match: ["blackwell", "rtx pro 6000", "pro 6000"], factor: 1.55 },
      { match: ["5090"], factor: 1.45 },
      { match: ["5080"], factor: 1.18 },
      { match: ["5070 ti"], factor: 0.86 },
      { match: ["5070"], factor: 0.76 },
      { match: ["4090"], factor: 1.1 },
      { match: ["4080"], factor: 0.9 },
    ],
  };

  let gpuPerformanceTable = BUILT_IN_GPU_PERFORMANCE;

  function configureGpuPerformanceTable(table) {
    const factors = Array.isArray(table?.factors) ? table.factors.filter((item) => Array.isArray(item?.match)) : [];
    gpuPerformanceTable = factors.length
      ? { defaultFactor: Number(table.defaultFactor ?? 1) || 1, factors }
      : BUILT_IN_GPU_PERFORMANCE;
    return gpuPerformanceTable;
  }

  function estimateGpuPerformanceFactor(name) {
    const text = String(name || "").toLowerCase();
    for (const entry of gpuPerformanceTable.factors) {
      if (entry.match.some((token) => text.includes(String(token).toLowerCase()))) {
        const factor = Number(entry.factor);
        return Number.isFinite(factor) && factor > 0 ? factor : gpuPerformanceTable.defaultFactor;
      }
    }
    return gpuPerformanceTable.defaultFactor;
  }

  function splitStringFromWeights(weights) {
    const clean = (weights || []).map((value) => Math.max(1, Number(value || 0)));
    if (clean.length < 2) return "";
    return clean.map((value) => String(Math.max(1, Math.round(value)))).join(",");
  }

  function buildLightSplit(gpus) {
    if (!gpus || gpus.length !== 2) return "";
    const [a, b] = gpus;
    const bigger = a.usableGb >= b.usableGb ? a : b;
    const smaller = bigger === a ? b : a;
    if (bigger.usableGb / Math.max(1, smaller.usableGb) < 1.35) return "";
    const big = Math.max(1, Math.round(bigger.usableGb * 0.82));
    const small = Math.max(1, Math.round(smaller.usableGb * 0.55));
    return gpus.map((gpu) => gpu === bigger ? big : small).join(",");
  }

  window.GpuPlanningUtils = {
    clampUtilization,
    normalizeGpuForPlan,
    inferGpuGeneration,
    shortGpuLabel,
    isHeterogeneous,
    estimateGpuPerformanceFactor,
    configureGpuPerformanceTable,
    splitStringFromWeights,
    buildLightSplit,
  };
})();
