"use strict";

const crypto = require("crypto");

// Benchmark results used to live only in the job ledger, which is trimmed to the
// last few dozen jobs and carries no launch configuration. That made the one
// question this platform exists to answer -- did raising max-num-seqs or
// switching KV dtype actually help? -- impossible to answer after the fact.
// This store keeps a small, durable history of runs together with the launch
// configuration each run was measured against.

const COMPARED_METRICS = [
  { key: "wallTokensPerSecond", label: "整体吞吐 tok/s", better: "higher", digits: 2 },
  { key: "avgTokensPerSecond", label: "单请求 tok/s", better: "higher", digits: 2 },
  { key: "avgTtftMs", label: "平均 TTFT ms", better: "lower", digits: 0 },
  { key: "p95TtftMs", label: "P95 TTFT ms", better: "lower", digits: 0 },
  { key: "avgMs", label: "平均端到端 ms", better: "lower", digits: 0 },
  { key: "p50Ms", label: "P50 端到端 ms", better: "lower", digits: 0 },
  { key: "p95Ms", label: "P95 端到端 ms", better: "lower", digits: 0 },
];

// Config keys that change throughput or memory behaviour. Anything else is
// noise in a comparison table.
const COMPARED_CONFIG_KEYS = [
  "engine", "runtimeImage", "quantization", "dtype", "kvCacheDtype",
  "maxModelLen", "maxNumSeqs", "maxNumBatchedTokens", "gpuMemoryUtilization",
  "tensorParallelSize", "pipelineParallelSize", "multiGpuMode", "gpuIds",
  "gpuLayers", "tensorSplit", "cacheTypeK", "cacheTypeV",
  "speculativeMode", "numSpeculativeTokens", "enablePrefixCaching",
  "cpuOffloadGb", "kvOffloadingSize",
];

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanScalar(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return String(value).slice(0, 200);
}

function normalizeBenchmarkConfig(value = {}) {
  const config = {};
  for (const key of COMPARED_CONFIG_KEYS) {
    const cleaned = cleanScalar(value[key]);
    if (cleaned !== null) config[key] = cleaned;
  }
  return config;
}

function normalizeBenchmarkRun(value = {}) {
  if (!value || typeof value !== "object") return null;
  const at = value.at && Date.parse(value.at) ? value.at : null;
  if (!at) return null;
  return {
    id: String(value.id || "").slice(0, 64) || crypto.randomUUID(),
    at,
    engine: String(value.engine || "").slice(0, 40),
    model: String(value.model || "").slice(0, 300),
    label: String(value.label || "").slice(0, 120),
    config: normalizeBenchmarkConfig(value.config || {}),
    load: {
      requests: finiteNumber(value.load?.requests),
      concurrency: finiteNumber(value.load?.concurrency),
      maxTokens: finiteNumber(value.load?.maxTokens),
      stream: Boolean(value.load?.stream),
      warmupRequests: finiteNumber(value.load?.warmupRequests),
      failedRequests: finiteNumber(value.load?.failedRequests),
      totalOutputTokens: finiteNumber(value.load?.totalOutputTokens),
    },
    metrics: Object.fromEntries(COMPARED_METRICS.map((metric) => [metric.key, finiteNumber(value.metrics?.[metric.key])])),
  };
}

function normalizeBenchmarkHistory(value = {}, options = {}) {
  const maxRuns = Math.min(2000, Math.max(10, Number(options.maxRuns || 200)));
  const runs = (Array.isArray(value.runs) ? value.runs : [])
    .map((run) => normalizeBenchmarkRun(run))
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { version: 1, updatedAt: value.updatedAt || null, runs: runs.slice(-maxRuns) };
}

function buildBenchmarkRun(benchmark = {}, options = {}) {
  return normalizeBenchmarkRun({
    id: options.id || crypto.randomUUID(),
    at: options.at || new Date().toISOString(),
    engine: options.engine || "",
    model: benchmark.model || options.model || "",
    label: options.label || "",
    config: options.config || {},
    load: {
      requests: benchmark.requests,
      concurrency: benchmark.concurrency,
      maxTokens: benchmark.maxTokens,
      stream: benchmark.stream,
      warmupRequests: benchmark.warmupRequests,
      failedRequests: benchmark.failedRequests,
      totalOutputTokens: benchmark.totalOutputTokens,
    },
    metrics: benchmark,
  });
}

// A comparison is only useful if it says what changed in the configuration and
// what that did to the numbers, so both are computed against a chosen baseline.
function compareBenchmarkRuns(runs = [], options = {}) {
  const list = runs.map((run) => normalizeBenchmarkRun(run)).filter(Boolean);
  if (!list.length) return { baselineId: "", runs: [], configKeys: [], metrics: [] };
  const baseline = list.find((run) => run.id === options.baselineId) || list[0];
  const configKeys = COMPARED_CONFIG_KEYS.filter((key) => {
    const present = list.filter((run) => run.config[key] !== undefined);
    if (!present.length) return false;
    // Keep a key when runs disagree, so the table shows only what varied.
    return present.length !== list.length || new Set(list.map((run) => String(run.config[key]))).size > 1;
  });
  const metrics = COMPARED_METRICS.map((metric) => {
    const baseValue = baseline.metrics[metric.key];
    return {
      ...metric,
      baseline: baseValue,
      values: list.map((run) => {
        const value = run.metrics[metric.key];
        const deltaPercent = baseValue > 0 ? ((value - baseValue) / baseValue) * 100 : null;
        const improved = deltaPercent === null || run.id === baseline.id
          ? null
          : metric.better === "higher" ? deltaPercent > 0 : deltaPercent < 0;
        return { id: run.id, value, deltaPercent, improved };
      }),
    };
  });
  return { baselineId: baseline.id, runs: list, configKeys, metrics };
}

function createBenchmarkHistoryStore(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const engine = String(options.engine || "");
  const maxRuns = Math.min(2000, Math.max(10, Number(options.maxRuns || 200)));
  if (!file || typeof readJsonFile !== "function" || typeof writeJsonFile !== "function") {
    throw new Error("createBenchmarkHistoryStore requires file, readJsonFile, and writeJsonFile.");
  }
  let writeQueue = Promise.resolve();
  let memoryLedger = null;
  let loadPromise = null;

  async function loadLedger() {
    if (memoryLedger) return memoryLedger;
    if (!loadPromise) {
      loadPromise = readJsonFile(file, {}).then((stored) => {
        memoryLedger = memoryLedger || normalizeBenchmarkHistory(stored, { maxRuns });
        return memoryLedger;
      });
    }
    return loadPromise;
  }

  async function save(ledger) {
    const snapshot = normalizeBenchmarkHistory(ledger, { maxRuns });
    writeQueue = writeQueue.catch(() => {}).then(() => writeJsonFile(file, snapshot));
    await writeQueue;
    return snapshot;
  }

  // A benchmark is cheap to re-run but expensive to lose, so a run is written
  // through immediately rather than batched behind a flush timer.
  async function recordBenchmarkRun(benchmark, recordOptions = {}) {
    const run = buildBenchmarkRun(benchmark, { engine, ...recordOptions });
    if (!run) return null;
    const ledger = await loadLedger();
    ledger.runs.push(run);
    if (ledger.runs.length > maxRuns) ledger.runs = ledger.runs.slice(-maxRuns);
    ledger.updatedAt = new Date().toISOString();
    await save(ledger);
    return run;
  }

  async function listBenchmarkRuns(query = {}) {
    const ledger = await loadLedger();
    const model = String(query.model || "").trim().toLowerCase();
    const limit = Math.min(maxRuns, Math.max(1, Number(query.limit || 50)));
    const runs = ledger.runs
      .filter((run) => !model || String(run.model || "").toLowerCase() === model)
      .slice(-limit)
      .reverse();
    const models = Array.from(new Set(ledger.runs.map((run) => run.model).filter(Boolean)));
    return { version: ledger.version, updatedAt: ledger.updatedAt, total: ledger.runs.length, models, runs };
  }

  async function compareRuns(ids = [], compareOptions = {}) {
    const wanted = (Array.isArray(ids) ? ids : String(ids || "").split(","))
      .map((id) => String(id || "").trim())
      .filter(Boolean)
      .slice(0, 8);
    const ledger = await loadLedger();
    // Preserve the caller's ordering so the baseline stays where they put it.
    const runs = wanted.map((id) => ledger.runs.find((run) => run.id === id)).filter(Boolean);
    return compareBenchmarkRuns(runs, compareOptions);
  }

  async function deleteBenchmarkRun(id) {
    const target = String(id || "").trim();
    const ledger = await loadLedger();
    const before = ledger.runs.length;
    ledger.runs = ledger.runs.filter((run) => run.id !== target);
    if (ledger.runs.length === before) return { ok: false, removed: 0 };
    ledger.updatedAt = new Date().toISOString();
    await save(ledger);
    return { ok: true, removed: before - ledger.runs.length };
  }

  async function flushBenchmarkHistory() {
    await writeQueue.catch(() => {});
  }

  return { recordBenchmarkRun, listBenchmarkRuns, compareRuns, deleteBenchmarkRun, flushBenchmarkHistory };
}

module.exports = {
  COMPARED_METRICS,
  COMPARED_CONFIG_KEYS,
  normalizeBenchmarkConfig,
  normalizeBenchmarkHistory,
  buildBenchmarkRun,
  compareBenchmarkRuns,
  createBenchmarkHistoryStore,
};
