"use strict";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMetricsHistory(value = {}, options = {}) {
  const maxSamples = Math.min(20000, Math.max(120, Number(options.maxSamples || 4320)));
  const samples = Array.isArray(value.samples) ? value.samples.filter((sample) => sample && Date.parse(sample.at)) : [];
  return {
    version: 1,
    updatedAt: value.updatedAt || null,
    samples: samples.slice(-maxSamples),
  };
}

function buildMetricsHistorySample(summary = {}, options = {}) {
  const live = summary.live && typeof summary.live === "object" ? summary.live : summary;
  const totals = live.totals || summary.totals || {};
  const model = (live.models || summary.models || [])[0] || {};
  const latency = totals.latency || model.latency || {};
  const speed = totals.speed || model.speed || {};
  const requests = totals.requests || model.requests || {};
  const gpu = summary.gpu || live.gpu || options.gpu || {};
  const speculative = model.speculative || {};
  return {
    at: options.at || summary.updatedAt || new Date().toISOString(),
    engine: String(options.engine || ""),
    container: String(summary.container?.name || live.container?.name || options.container || ""),
    model: String(model.name || options.model || ""),
    running: Boolean(summary.container?.running ?? live.container?.running),
    latency: {
      e2eMs: finiteNumber(latency.avgE2eSeconds) * 1000,
      ttftMs: finiteNumber(latency.avgTtftSeconds) * 1000,
      tpotMs: finiteNumber(latency.avgTimePerOutputTokenSeconds || latency.avgInterTokenSeconds) * 1000,
      queueMs: finiteNumber(model.latency?.avgQueueSeconds) * 1000,
    },
    throughput: {
      promptTokensPerSecond: finiteNumber(speed.recentPromptTokensPerSecond),
      outputTokensPerSecond: finiteNumber(speed.recentOutputTokensPerSecond),
      requestsPerMinute: finiteNumber(speed.recentRequestsPerMinute),
    },
    requests: {
      total: finiteNumber(requests.total),
      running: finiteNumber(model.requests?.running),
      waiting: finiteNumber(model.requests?.waiting),
    },
    gpu: {
      usedMb: nullableNumber(gpu.usedMb),
      totalMb: nullableNumber(gpu.totalMb),
      utilizationPercent: nullableNumber(gpu.util),
      temperatureC: nullableNumber(gpu.temp),
      powerWatts: nullableNumber(gpu.powerWatts),
      powerLimitWatts: nullableNumber(gpu.powerLimitWatts),
      fanPercent: nullableNumber(gpu.fanPercent),
    },
    speculative: {
      enabled: Boolean(speculative.enabled),
      draftTokens: finiteNumber(speculative.draftTokens),
      acceptedTokens: finiteNumber(speculative.acceptedTokens),
      acceptanceRate: finiteNumber(speculative.acceptanceRate),
    },
  };
}

function createMetricsHistoryStore(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const maxSamples = Math.min(20000, Math.max(120, Number(options.maxSamples || 4320)));
  const minIntervalMs = Math.min(60 * 60 * 1000, Math.max(1000, Number(options.minIntervalMs || 60 * 1000)));
  let writeQueue = Promise.resolve();

  if (!file || typeof readJsonFile !== "function" || typeof writeJsonFile !== "function") {
    throw new Error("createMetricsHistoryStore requires file, readJsonFile, and writeJsonFile.");
  }

  async function getMetricsHistory(query = {}) {
    const ledger = normalizeMetricsHistory(await readJsonFile(file, {}), { maxSamples });
    const hours = Math.min(24 * 365, Math.max(0.25, Number(query.hours || 24)));
    const fromMs = Date.now() - hours * 60 * 60 * 1000;
    const model = String(query.model || "").trim().toLowerCase();
    const samples = ledger.samples.filter((sample) => {
      if (Date.parse(sample.at) < fromMs) return false;
      return !model || String(sample.model || "").toLowerCase() === model;
    });
    return { ...ledger, hours, samples };
  }

  async function recordMetricsHistory(summary, recordOptions = {}) {
    const sample = buildMetricsHistorySample(summary, {
      engine: options.engine,
      ...recordOptions,
    });
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const ledger = normalizeMetricsHistory(await readJsonFile(file, {}), { maxSamples });
      const previous = ledger.samples.at(-1);
      const sameRuntime = previous
        && previous.engine === sample.engine
        && previous.container === sample.container
        && previous.model === sample.model;
      const elapsed = previous ? Date.parse(sample.at) - Date.parse(previous.at) : Infinity;
      if (sameRuntime && elapsed >= 0 && elapsed < minIntervalMs) ledger.samples[ledger.samples.length - 1] = sample;
      else ledger.samples.push(sample);
      ledger.samples = ledger.samples.slice(-maxSamples);
      ledger.updatedAt = new Date().toISOString();
      await writeJsonFile(file, ledger);
      return sample;
    });
    return writeQueue;
  }

  return {
    getMetricsHistory,
    recordMetricsHistory,
  };
}

module.exports = {
  normalizeMetricsHistory,
  buildMetricsHistorySample,
  createMetricsHistoryStore,
};
