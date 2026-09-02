const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * HOUR_MS;
const DEFAULT_MAX_SAMPLES = 10_000;

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function optionalNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function decodedTokenCount(slot = {}) {
  const candidates = [slot.n_decoded];
  if (Array.isArray(slot.next_token)) {
    for (const item of slot.next_token) candidates.push(item?.n_decoded);
  }
  const values = candidates
    .map(optionalNonNegativeInteger)
    .filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function normalizeSlotObservation(slot = {}, context = {}, observedAtMs = Date.now()) {
  if (!slot || typeof slot !== "object") return null;
  const taskId = slot.id_task === null || slot.id_task === undefined ? "" : String(slot.id_task).trim();
  if (!taskId || taskId === "-1") return null;

  const runtimeId = String(context.runtimeId || "runtime").trim() || "runtime";
  const slotId = String(slot.id ?? slot.slot_id ?? "0");
  const isProcessing = Boolean(slot.is_processing);
  const processedTokens = nonNegativeInteger(slot.n_prompt_tokens_processed);
  const reportedCachedTokens = nonNegativeInteger(slot.n_prompt_tokens_cache);
  const promptAndOutputTokens = nonNegativeInteger(slot.n_prompt_tokens);
  const decodedTokens = decodedTokenCount(slot);
  const promptFromLiveCounters = processedTokens + reportedCachedTokens;
  const promptFromFinalCounters = decodedTokens === null
    ? null
    : Math.max(0, promptAndOutputTokens - decodedTokens);

  let promptTokens;
  let cachedTokens;
  let inferredAfterReset = false;
  if (isProcessing) {
    promptTokens = promptFromLiveCounters || promptFromFinalCounters || processedTokens;
    cachedTokens = Math.min(promptTokens, reportedCachedTokens);
  } else if (promptFromFinalCounters !== null) {
    promptTokens = Math.max(promptFromFinalCounters, promptFromLiveCounters, processedTokens);
    cachedTokens = Math.min(promptTokens, Math.max(reportedCachedTokens, promptTokens - processedTokens));
    inferredAfterReset = reportedCachedTokens === 0 && cachedTokens > 0;
  } else {
    // llama.cpp clears n_prompt_tokens_cache when an idle slot is reset. If
    // n_decoded is unavailable as well, the cached portion cannot be inferred
    // safely, so do not create a misleading zero-hit sample.
    if (!reportedCachedTokens && promptAndOutputTokens > processedTokens) return null;
    promptTokens = Math.max(promptFromLiveCounters, processedTokens);
    cachedTokens = Math.min(promptTokens, reportedCachedTokens);
  }

  if (promptTokens <= 0) return null;
  const effectiveProcessedTokens = Math.min(promptTokens, processedTokens);
  const observedAt = new Date(observedAtMs).toISOString();
  const slotKey = `${runtimeId}:${slotId}`;
  return {
    key: `${slotKey}:${taskId}`,
    slotKey,
    runtimeId,
    slotId,
    taskId,
    model: String(context.model || ""),
    source: String(context.source || "llama.cpp /slots"),
    status: isProcessing ? "running" : "completed",
    observedAt,
    completedAt: isProcessing ? null : observedAt,
    promptTokens,
    processedTokens: effectiveProcessedTokens,
    cachedTokens,
    hitRate: promptTokens ? cachedTokens / promptTokens : null,
    inferredAfterReset,
  };
}

function emptyLedger(nowIso) {
  return {
    version: 1,
    createdAt: nowIso,
    updatedAt: null,
    totals: {
      requests: 0,
      promptTokens: 0,
      processedTokens: 0,
      cachedTokens: 0,
    },
    latest: null,
    samples: [],
    lastTaskBySlot: {},
  };
}

function normalizeSample(value = {}) {
  if (!value || typeof value !== "object" || !value.key || !value.completedAt) return null;
  const promptTokens = nonNegativeInteger(value.promptTokens);
  if (!promptTokens) return null;
  const cachedTokens = Math.min(promptTokens, nonNegativeInteger(value.cachedTokens));
  return {
    key: String(value.key),
    slotKey: String(value.slotKey || ""),
    runtimeId: String(value.runtimeId || ""),
    slotId: String(value.slotId ?? "0"),
    taskId: String(value.taskId ?? ""),
    model: String(value.model || ""),
    source: String(value.source || "llama.cpp /slots"),
    status: "completed",
    observedAt: String(value.observedAt || value.completedAt),
    completedAt: String(value.completedAt),
    promptTokens,
    processedTokens: Math.min(promptTokens, nonNegativeInteger(value.processedTokens)),
    cachedTokens,
    hitRate: cachedTokens / promptTokens,
    inferredAfterReset: Boolean(value.inferredAfterReset),
  };
}

function normalizeLedger(value, nowIso) {
  const item = value && typeof value === "object" ? value : {};
  const ledger = emptyLedger(nowIso);
  ledger.createdAt = String(item.createdAt || nowIso);
  ledger.updatedAt = item.updatedAt ? String(item.updatedAt) : null;
  ledger.totals = {
    requests: nonNegativeInteger(item.totals?.requests),
    promptTokens: nonNegativeInteger(item.totals?.promptTokens),
    processedTokens: nonNegativeInteger(item.totals?.processedTokens),
    cachedTokens: nonNegativeInteger(item.totals?.cachedTokens),
  };
  ledger.samples = Array.isArray(item.samples) ? item.samples.map(normalizeSample).filter(Boolean) : [];
  ledger.latest = normalizeSample(item.latest) || ledger.samples.at(-1) || null;
  ledger.lastTaskBySlot = item.lastTaskBySlot && typeof item.lastTaskBySlot === "object"
    ? Object.fromEntries(Object.entries(item.lastTaskBySlot).map(([key, taskId]) => [String(key), String(taskId)]))
    : {};
  return ledger;
}

function aggregateSamples(samples = []) {
  const totals = samples.reduce((sum, sample) => ({
    requests: sum.requests + 1,
    promptTokens: sum.promptTokens + nonNegativeInteger(sample.promptTokens),
    processedTokens: sum.processedTokens + nonNegativeInteger(sample.processedTokens),
    cachedTokens: sum.cachedTokens + nonNegativeInteger(sample.cachedTokens),
  }), { requests: 0, promptTokens: 0, processedTokens: 0, cachedTokens: 0 });
  return summarizeBucket(totals);
}

function summarizeBucket(value = {}) {
  const promptTokens = nonNegativeInteger(value.promptTokens);
  const cachedTokens = Math.min(promptTokens, nonNegativeInteger(value.cachedTokens));
  return {
    requests: nonNegativeInteger(value.requests),
    promptTokens,
    processedTokens: Math.min(promptTokens, nonNegativeInteger(value.processedTokens)),
    cachedTokens,
    hitRate: promptTokens ? cachedTokens / promptTokens : null,
  };
}

function summarizeObservation(value) {
  if (!value) return null;
  return {
    status: value.status,
    model: value.model,
    source: value.source,
    observedAt: value.observedAt,
    completedAt: value.completedAt,
    taskId: value.taskId,
    slotId: value.slotId,
    promptTokens: value.promptTokens,
    processedTokens: value.processedTokens,
    cachedTokens: value.cachedTokens,
    hitRate: value.hitRate,
    inferredAfterReset: Boolean(value.inferredAfterReset),
  };
}

function createCacheHitTracker(options = {}) {
  const file = options.file;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const retentionMs = Math.max(HOUR_MS, Number(options.retentionMs || DEFAULT_RETENTION_MS));
  const maxSamples = Math.max(100, Number(options.maxSamples || DEFAULT_MAX_SAMPLES));
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  if (!file || typeof readJsonFile !== "function" || typeof writeJsonFile !== "function") {
    throw new Error("createCacheHitTracker requires file, readJsonFile, and writeJsonFile.");
  }

  let ledger = null;
  let loadPromise = null;
  let loadError = "";
  let writeQueue = Promise.resolve();
  const activeBySlot = new Map();

  async function ensureLoaded() {
    if (ledger) return ledger;
    if (!loadPromise) {
      loadPromise = Promise.resolve().then(async () => {
        const nowIso = new Date(now()).toISOString();
        try {
          ledger = normalizeLedger(await readJsonFile(file, {}), nowIso);
        } catch (error) {
          loadError = error.message;
          ledger = emptyLedger(nowIso);
          onError(`cache-hit ledger unavailable: ${error.message}`);
        }
        return ledger;
      });
    }
    return loadPromise;
  }

  function pruneSamples(nowMs) {
    const cutoff = nowMs - retentionMs;
    ledger.samples = ledger.samples
      .filter((sample) => Date.parse(sample.completedAt) >= cutoff)
      .slice(-maxSamples);
    const activeRuntimeIds = new Set(ledger.samples.map((sample) => sample.runtimeId).filter(Boolean));
    if (ledger.latest?.runtimeId) activeRuntimeIds.add(ledger.latest.runtimeId);
    const entries = Object.entries(ledger.lastTaskBySlot)
      .filter(([slotKey]) => !activeRuntimeIds.size || Array.from(activeRuntimeIds).some((runtimeId) => slotKey.startsWith(`${runtimeId}:`)))
      .slice(-100);
    ledger.lastTaskBySlot = Object.fromEntries(entries);
  }

  let lastPersistAt = 0;

  async function persist({ force = false } = {}) {
    if (loadError) return;
    const nowMs = Date.now();
    if (!force && nowMs - lastPersistAt < 5000) return;
    lastPersistAt = nowMs;
    const snapshot = {
      ...ledger,
      totals: { ...ledger.totals },
      samples: ledger.samples.slice(),
      lastTaskBySlot: { ...ledger.lastTaskBySlot },
      latest: ledger.latest,
    };
    writeQueue = writeQueue.catch(() => {}).then(() => writeJsonFile(file, snapshot));
    await writeQueue;
  }

  async function observeSlots(slots, context = {}) {
    await ensureLoaded();
    const observedAtMs = now();
    const list = Array.isArray(slots) ? slots : (slots && typeof slots === "object" ? [slots] : []);
    const runtimeId = String(context.runtimeId || "runtime").trim() || "runtime";
    const seenSlotKeys = new Set();
    let changed = false;

    for (const slot of list) {
      const observation = normalizeSlotObservation(slot, context, observedAtMs);
      const slotId = String(slot?.id ?? slot?.slot_id ?? "0");
      const slotKey = `${runtimeId}:${slotId}`;
      seenSlotKeys.add(slotKey);
      if (!observation) {
        if (!slot?.is_processing) activeBySlot.delete(slotKey);
        continue;
      }
      if (observation.status === "running") {
        activeBySlot.set(slotKey, observation);
        continue;
      }

      activeBySlot.delete(slotKey);
      if (ledger.lastTaskBySlot[slotKey] === observation.taskId) continue;
      ledger.lastTaskBySlot[slotKey] = observation.taskId;
      ledger.samples.push(observation);
      ledger.latest = observation;
      ledger.totals.requests += 1;
      ledger.totals.promptTokens += observation.promptTokens;
      ledger.totals.processedTokens += observation.processedTokens;
      ledger.totals.cachedTokens += observation.cachedTokens;
      ledger.updatedAt = observation.completedAt;
      changed = true;
    }

    for (const slotKey of activeBySlot.keys()) {
      if (slotKey.startsWith(`${runtimeId}:`) && !seenSlotKeys.has(slotKey)) activeBySlot.delete(slotKey);
    }

    if (changed) {
      pruneSamples(observedAtMs);
      await persist();
    }
    return getSummary();
  }

  async function clearActive(runtimeId = "") {
    await ensureLoaded();
    const prefix = runtimeId ? `${runtimeId}:` : "";
    for (const slotKey of activeBySlot.keys()) {
      if (!prefix || slotKey.startsWith(prefix)) activeBySlot.delete(slotKey);
    }
  }

  async function getSummary() {
    await ensureLoaded();
    const nowMs = now();
    const hourSamples = ledger.samples.filter((sample) => Date.parse(sample.completedAt) >= nowMs - HOUR_MS);
    const active = Array.from(activeBySlot.values())
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] || null;
    const latest = active || ledger.latest || ledger.samples.at(-1) || null;
    return {
      enabled: true,
      source: "llama.cpp /slots (read-only polling)",
      trackingSince: ledger.createdAt,
      updatedAt: active?.observedAt || ledger.updatedAt,
      latest: summarizeObservation(latest),
      rollingHour: aggregateSamples(hourSamples),
      cumulative: summarizeBucket(ledger.totals),
      observedRequests: ledger.totals.requests,
      coverage: "observed-tasks",
      note: "Completed tasks observed between slot polls are persisted; very short tasks that both start and finish between polls can be missed.",
      error: loadError || "",
    };
  }

  async function flush() {
    await ensureLoaded();
    await persist({ force: true });
  }

  return {
    observeSlots,
    clearActive,
    getSummary,
    flush,
  };
}

module.exports = {
  HOUR_MS,
  normalizeSlotObservation,
  aggregateSamples,
  createCacheHitTracker,
};
