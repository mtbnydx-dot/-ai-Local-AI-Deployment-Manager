const { normalizeGpuIds } = require("./common-utils");

function parseNvidiaSmiGpuCsv(stdout) {
  const numeric = (value) => {
    if (value === null || value === undefined || String(value).trim() === "" || /^n\/a$/i.test(String(value).trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const gpus = String(stdout || "").trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((part) => part && part.trim());
      const hasComputeCap = parts.length >= 7 && /^\d+(?:\.\d+)?$/.test(parts[2] || "");
      const [index, name, maybeComputeCap, maybeTotal, maybeUsed, maybeUtil, maybeTemp, maybePower, maybePowerLimit, maybeFan] = parts;
      const total = hasComputeCap ? maybeTotal : maybeComputeCap;
      const used = hasComputeCap ? maybeUsed : maybeTotal;
      const util = hasComputeCap ? maybeUtil : maybeUsed;
      const temp = hasComputeCap ? maybeTemp : maybeUtil;
      const power = hasComputeCap ? maybePower : maybeTemp;
      const powerLimit = hasComputeCap ? maybePowerLimit : maybePower;
      const fan = hasComputeCap ? maybeFan : maybePowerLimit;
      return {
        index: Number(index),
        id: String(index),
        name,
        computeCap: hasComputeCap ? maybeComputeCap : "",
        totalMb: numeric(total),
        usedMb: numeric(used),
        util: numeric(util),
        temp: numeric(temp),
        powerWatts: numeric(power),
        powerLimitWatts: numeric(powerLimit),
        fanPercent: numeric(fan),
      };
    })
    .filter((gpu) => Number.isFinite(gpu.index));
  if (!gpus.length) return { ok: false, text: "No NVIDIA GPU reported by nvidia-smi", gpus: [] };
  const totalMb = gpus.reduce((sum, gpu) => sum + (Number(gpu.totalMb) || 0), 0);
  const usedMb = gpus.reduce((sum, gpu) => sum + (Number(gpu.usedMb) || 0), 0);
  const avgUtil = Math.round(gpus.reduce((sum, gpu) => sum + (Number(gpu.util) || 0), 0) / gpus.length);
  const temperatures = gpus.map((gpu) => gpu.temp).filter(Number.isFinite);
  const powers = gpus.map((gpu) => gpu.powerWatts).filter(Number.isFinite);
  const powerLimits = gpus.map((gpu) => gpu.powerLimitWatts).filter(Number.isFinite);
  const fans = gpus.map((gpu) => gpu.fanPercent).filter(Number.isFinite);
  return {
    ok: true,
    count: gpus.length,
    name: gpus.length === 1 ? gpus[0].name : `${gpus.length} GPUs`,
    totalMb,
    usedMb,
    util: avgUtil,
    temp: temperatures.length ? Math.max(...temperatures) : null,
    powerWatts: powers.length ? powers.reduce((sum, value) => sum + value, 0) : null,
    powerLimitWatts: powerLimits.length ? powerLimits.reduce((sum, value) => sum + value, 0) : null,
    fanPercent: fans.length ? Math.round(fans.reduce((sum, value) => sum + value, 0) / fans.length) : null,
    gpus,
  };
}

function createGpuRuntime(options = {}) {
  const execFileAsync = options.execFileAsync;
  const normalizeIds = options.normalizeGpuIds || normalizeGpuIds;

  async function getGpuStatus() {
    if (typeof execFileAsync !== "function") {
      return { ok: false, text: "execFileAsync is not configured", gpus: [] };
    }
    const queries = [
      "index,name,compute_cap,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed",
      "index,name,compute_cap,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,power.limit",
      "index,name,compute_cap,memory.total,memory.used,utilization.gpu,temperature.gpu",
      "index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
    ];
    let firstError = null;
    for (const query of queries) {
      try {
        const out = await execFileAsync("nvidia-smi", [
          `--query-gpu=${query}`,
          "--format=csv,noheader,nounits",
        ]);
        return parseNvidiaSmiGpuCsv(out.stdout);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    return { ok: false, text: firstError?.message || "nvidia-smi query failed", gpus: [] };
  }

  async function normalizeLaunchGpuSelection(requestedIds = []) {
    const requested = normalizeIds(requestedIds);
    const warnings = [];
    const gpu = await getGpuStatus().catch((error) => ({ ok: false, text: error.message, gpus: [] }));
    const available = Array.isArray(gpu.gpus) ? gpu.gpus : [];
    if (!gpu.ok || !available.length) {
      return { gpuDeviceIds: requested, selectedCount: requested.length || 1, warnings };
    }
    if (!requested.length) {
      return { gpuDeviceIds: [], selectedCount: available.length, warnings };
    }
    const validIds = new Set(available.flatMap((item) => [String(item.id), String(item.index)]));
    const filtered = requested.filter((id) => validIds.has(String(id)));
    const dropped = requested.filter((id) => !validIds.has(String(id)));
    if (dropped.length) {
      warnings.push(`已忽略不存在的 GPU：${dropped.join(", ")}。当前可用 GPU：${available.map((item) => item.id).join(", ")}。`);
    }
    if (!filtered.length) {
      const fallback = String(available[0].id ?? available[0].index ?? "0");
      warnings.push(`所选 GPU 不存在，已回退到 GPU ${fallback}。`);
      filtered.push(fallback);
    }
    return { gpuDeviceIds: filtered, selectedCount: filtered.length, warnings };
  }

  return {
    getGpuStatus,
    normalizeLaunchGpuSelection,
  };
}

module.exports = {
  createGpuRuntime,
  parseNvidiaSmiGpuCsv,
};
