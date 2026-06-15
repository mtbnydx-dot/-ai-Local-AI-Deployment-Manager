const path = require("node:path");
const {
  applyClaudeBridgeUsage,
  aggregateStats,
  diffRuntimeCounters,
  emptyRuntimeCounters,
  maxRuntimeCounters,
  mergeLiveAndStatsLedger,
  mergeStatsLedgerModelDelta,
  normalizeClientUsageCounters,
  runtimeCountersFromStatsModel,
  statsLedgerModelToStatsModel,
  statsLedgerToSummary,
} = require("./stats-utils");

function createStatsLedgerStore(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const normalizeClients = typeof options.normalizeClients === "function"
    ? options.normalizeClients
    : (value) => (value && typeof value === "object" ? value : {});
  const claudeUsageOptions = options.claudeUsageOptions || {};
  const persistRuntimeFacts = Boolean(options.persistRuntimeFacts);
  const useMonotonicRuntimeCounters = Boolean(options.monotonicRuntimeCounters);
  let writeQueue = Promise.resolve();

  if (!file || typeof readJsonFile !== "function" || typeof writeJsonFile !== "function") {
    throw new Error("createStatsLedgerStore requires file, readJsonFile, and writeJsonFile.");
  }

  async function withStatsLedgerWrite(task) {
    const previous = writeQueue;
    let release;
    writeQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
    }
  }

  async function waitForStatsLedgerWrites() {
    await writeQueue.catch(() => {});
  }

  async function loadStatsLedger() {
    return normalizeStatsLedger(await readJsonFile(file, {}));
  }

  async function saveStatsLedger(ledger) {
    return writeJsonFile(file, normalizeStatsLedger(ledger));
  }

  function normalizeStatsLedger(value = {}) {
    const item = value && typeof value === "object" ? value : {};
    const ledger = {
      version: 1,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || null,
      models: item.models && typeof item.models === "object" ? item.models : {},
      runtimes: item.runtimes && typeof item.runtimes === "object" ? item.runtimes : {},
      clients: normalizeClients(item.clients),
    };
    if (persistRuntimeFacts) {
      ledger.runtimeFacts = item.runtimeFacts && typeof item.runtimeFacts === "object" ? item.runtimeFacts : {};
    }
    return ledger;
  }

  async function updateStatsLedger(summary, reason = "collect") {
    return withStatsLedgerWrite(async () => {
      const ledger = await loadStatsLedger();
      if (!summary?.processStartSeconds || !Array.isArray(summary.models) || !summary.models.length) {
        return ledger;
      }
      for (const model of summary.models) {
        const runtimeKey = `${summary.processStartSeconds}:${model.name}`;
        const previous = ledger.runtimes[runtimeKey] || emptyRuntimeCounters();
        const current = runtimeCountersFromStatsModel(model);
        const effectiveCurrent = useMonotonicRuntimeCounters ? maxRuntimeCounters(current, previous) : current;
        const delta = diffRuntimeCounters(effectiveCurrent, previous);
        mergeStatsLedgerModelDelta(ledger, model, delta, summary, reason);
        if (persistRuntimeFacts) mergeRuntimeFactsLedger(ledger, model, summary, reason);
        ledger.runtimes[runtimeKey] = effectiveCurrent;
      }
      ledger.updatedAt = new Date().toISOString();
      ledger.version = 1;
      await saveStatsLedger(ledger);
      return ledger;
    });
  }

  async function recordClaudeBridgeUsage(event = {}) {
    return withStatsLedgerWrite(async () => {
      const ledger = await loadStatsLedger();
      const clients = ledger.clients && typeof ledger.clients === "object" ? ledger.clients : {};
      const claude = applyClaudeBridgeUsage(clients.claude, event, claudeUsageOptions);
      clients.claude = claude;
      ledger.clients = normalizeClients(clients);
      ledger.updatedAt = new Date().toISOString();
      await saveStatsLedger(ledger);
      return claude;
    });
  }

  function mergeRuntimeFactsLedger(ledger, model, summary, reason) {
    const facts = normalizeRuntimeFacts({
      ...(summary.facts || {}),
      maxModelLen: model.maxModelLen || model.context?.maxModelLen || null,
      kvCacheTokens: summary.facts?.kvCacheTokens || model.context?.capacityTokens || null,
      maxConcurrency: summary.facts?.maxConcurrency || model.context?.concurrencyAtMaxLen || null,
    });
    if (!hasRuntimeFacts(facts)) return;
    ledger.runtimeFacts = ledger.runtimeFacts && typeof ledger.runtimeFacts === "object" ? ledger.runtimeFacts : {};
    const existing = ledger.runtimeFacts[model.name] || {};
    ledger.runtimeFacts[model.name] = {
      ...existing,
      name: model.name,
      root: model.root || existing.root || "",
      updatedAt: new Date().toISOString(),
      reason,
      processStartSeconds: summary.processStartSeconds || existing.processStartSeconds || null,
      facts: mergeRuntimeFacts(existing.facts || {}, facts),
    };
  }

  async function getPersistedRuntimeFacts(modelHints = []) {
    const ledger = await loadStatsLedger();
    const needles = normalizeRuntimeFactHints(modelHints);
    const candidates = [];
    for (const item of Object.values(ledger.runtimeFacts || {})) {
      if (!item || typeof item !== "object") continue;
      if (needles.length && !runtimeFactItemMatches(item, needles)) continue;
      candidates.push({
        name: item.name,
        root: item.root || "",
        updatedAt: item.updatedAt || "",
        processStartSeconds: item.processStartSeconds || null,
        facts: item.facts || {},
      });
    }
    for (const item of Object.values(ledger.models || {})) {
      const facts = item?.last?.facts;
      if (!facts || typeof facts !== "object") continue;
      if (needles.length && !runtimeFactItemMatches(item, needles)) continue;
      candidates.push({
        name: item.name,
        root: item.root || "",
        updatedAt: item.last?.updatedAt || "",
        processStartSeconds: item.last?.processStartSeconds || null,
        facts: {
          ...facts,
          maxModelLen: item.last?.maxModelLen || item.last?.context?.maxModelLen || null,
          kvCacheTokens: facts.kvCacheTokens || item.last?.context?.capacityTokens || null,
          maxConcurrency: facts.maxConcurrency || item.last?.context?.concurrencyAtMaxLen || null,
        },
      });
    }
    candidates.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
    return candidates.reduce((facts, item) => mergeRuntimeFacts(facts, item.facts || {}), {});
  }

  return {
    withStatsLedgerWrite,
    waitForStatsLedgerWrites,
    loadStatsLedger,
    saveStatsLedger,
    normalizeStatsLedger,
    updateStatsLedger,
    recordClaudeBridgeUsage,
    getPersistedRuntimeFacts,
    mergeRuntimeFactsLedger,
  };
}

function normalizeStatsClientLedger(value) {
  const clients = value && typeof value === "object" ? value : {};
  return {
    claude: normalizeClientUsageCounters(clients.claude, "claude", "Claude 兼容桥"),
  };
}

function normalizeRuntimeFacts(value = {}) {
  return {
    kvCacheTokens: positiveFactNumber(value.kvCacheTokens),
    maxContextTokens: positiveFactNumber(value.maxContextTokens || value.maxModelLen),
    maxModelLen: positiveFactNumber(value.maxModelLen || value.maxContextTokens),
    maxConcurrency: positiveFactNumber(value.maxConcurrency),
    modelLoadMemoryGiB: positiveFactNumber(value.modelLoadMemoryGiB),
    modelLoadSeconds: positiveFactNumber(value.modelLoadSeconds),
    torchCompileSeconds: positiveFactNumber(value.torchCompileSeconds),
    warmupSeconds: positiveFactNumber(value.warmupSeconds),
    graphCaptureGiB: positiveFactNumber(value.graphCaptureGiB),
    engineInitSeconds: positiveFactNumber(value.engineInitSeconds),
  };
}

function mergeRuntimeFacts(base = {}, override = {}) {
  const left = normalizeRuntimeFacts(base);
  const right = normalizeRuntimeFacts(override);
  const merged = {};
  for (const key of Object.keys(left)) {
    merged[key] = right[key] ?? left[key] ?? null;
  }
  return merged;
}

function hasRuntimeFacts(facts = {}) {
  return Object.values(facts).some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
}

function positiveFactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeRuntimeFactHints(hints) {
  return (Array.isArray(hints) ? hints : [hints])
    .map((hint) => String(hint || "").trim().toLowerCase())
    .filter(Boolean);
}

function runtimeFactItemMatches(item, needles) {
  return runtimeFactValuesMatch([
    item?.name,
    item?.root,
    item?.id,
    item?.last?.root,
    item?.last?.model,
  ], needles);
}

function jobMatchesRuntimeFactHints(job, needles) {
  return runtimeFactValuesMatch([
    job?.meta?.model,
    job?.meta?.name,
    job?.meta?.servedModels ? JSON.stringify(job.meta.servedModels) : "",
  ], needles);
}

function runtimeFactValuesMatch(values, needles) {
  const rawValues = values
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const compactValues = rawValues
    .flatMap((value) => [value, path.basename(value.replace(/\\/g, "/"))])
    .map(normalizeRuntimeFactKey)
    .filter(Boolean);
  const rawText = rawValues.join("\n");
  return needles.some((needle) => {
    if (rawText.includes(needle)) return true;
    const compactNeedle = normalizeRuntimeFactKey(needle);
    if (!compactNeedle) return false;
    return compactValues.some((value) => (
      value.length >= 6
      && (value.includes(compactNeedle) || compactNeedle.includes(value))
    ));
  });
}

function normalizeRuntimeFactKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9]+/g, "");
}

function inactiveRuntimeContext(context = {}) {
  const item = context && typeof context === "object" ? context : {};
  return {
    activeTokens: 0,
    capacityTokens: null,
    kvUsagePercent: 0,
    maxModelLen: item.maxModelLen || null,
    concurrencyAtMaxLen: null,
  };
}

function mergeLiveAndStatsLedgerInactive(liveSummary, ledger) {
  const historical = statsLedgerToSummary(ledger);
  const liveModels = Array.isArray(liveSummary?.models) ? liveSummary.models : [];
  const liveByName = Object.fromEntries(liveModels.map((model) => [model.name, model]));
  const mergedModels = historical.models.map((model) => ({
    ...model,
    context: liveByName[model.name]?.context || inactiveRuntimeContext(model.context),
    latency: liveByName[model.name]?.latency || model.latency,
    averages: liveByName[model.name]?.averages || model.averages,
    speed: liveByName[model.name]?.speed || model.speed,
    cache: liveByName[model.name]?.cache || model.cache,
    requests: {
      ...model.requests,
      running: liveByName[model.name]?.requests?.running || 0,
      waiting: liveByName[model.name]?.requests?.waiting || 0,
    },
  }));
  for (const model of liveModels) {
    if (!mergedModels.some((item) => item.name === model.name)) mergedModels.push(model);
  }
  const totals = aggregateStats(mergedModels, liveSummary?.uptimeSeconds || null);
  if (liveSummary?.totals?.context) totals.context = liveSummary.totals.context;
  return {
    ...historical,
    source: liveSummary?.source || historical.source,
    processStartSeconds: liveSummary?.processStartSeconds || null,
    uptimeSeconds: liveSummary?.uptimeSeconds || null,
    facts: liveSummary?.facts || historical.facts,
    totals,
    models: mergedModels.sort((a, b) => b.tokens.total - a.tokens.total),
    modelsByName: Object.fromEntries(mergedModels.map((model) => [model.name, model])),
    rawMetricCount: liveSummary?.rawMetricCount || 0,
    note: historical.note,
  };
}

module.exports = {
  createStatsLedgerStore,
  hasRuntimeFacts,
  inactiveRuntimeContext,
  mergeLiveAndStatsLedger,
  mergeLiveAndStatsLedgerInactive,
  mergeRuntimeFacts,
  normalizeRuntimeFactHints,
  normalizeRuntimeFactKey,
  normalizeRuntimeFacts,
  normalizeStatsClientLedger,
  jobMatchesRuntimeFactHints,
  runtimeFactItemMatches,
  runtimeFactValuesMatch,
  statsLedgerModelToStatsModel,
  statsLedgerToSummary,
};
