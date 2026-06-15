const { normalizeGpuIds } = require("./common-utils");

function parseNvidiaSmiGpuCsv(stdout) {
  const gpus = String(stdout || "").trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [index, name, total, used, util, temp] = line.split(",").map((part) => part && part.trim());
      return {
        index: Number(index),
        id: String(index),
        name,
        totalMb: Number(total),
        usedMb: Number(used),
        util: Number(util),
        temp: Number(temp),
      };
    })
    .filter((gpu) => Number.isFinite(gpu.index));
  if (!gpus.length) return { ok: false, text: "No NVIDIA GPU reported by nvidia-smi", gpus: [] };
  const totalMb = gpus.reduce((sum, gpu) => sum + (Number(gpu.totalMb) || 0), 0);
  const usedMb = gpus.reduce((sum, gpu) => sum + (Number(gpu.usedMb) || 0), 0);
  const avgUtil = Math.round(gpus.reduce((sum, gpu) => sum + (Number(gpu.util) || 0), 0) / gpus.length);
  return {
    ok: true,
    count: gpus.length,
    name: gpus.length === 1 ? gpus[0].name : `${gpus.length} GPUs`,
    totalMb,
    usedMb,
    util: avgUtil,
    temp: gpus[0].temp,
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
    try {
      const out = await execFileAsync("nvidia-smi", [
        "--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
      ]);
      return parseNvidiaSmiGpuCsv(out.stdout);
    } catch (error) {
      return { ok: false, text: error.message, gpus: [] };
    }
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
