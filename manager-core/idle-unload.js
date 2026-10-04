"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  idleMinutes: 30,
  minVramMb: 0,
  excludeModels: [],
  wakeOnDemand: true,
});

// A resident model holds its weights and KV pool for as long as the container
// runs, whether or not anyone is using it. On a single-GPU workstation that is
// the difference between "one model at a time" and a usable fleet. This
// controller releases an idle runtime and keeps everything needed to bring the
// same configuration back, so the release is reversible rather than a stop.
//
// Idleness is read from the request counters the stats path already collects,
// so nothing is added to the request hot path and both engines work the same
// way: a runtime is idle when its cumulative request count has not moved and
// nothing is running or queued.

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeIdleUnloadSettings(value = {}, previous = DEFAULT_SETTINGS) {
  const base = { ...DEFAULT_SETTINGS, ...previous };
  const excludeSource = value.excludeModels === undefined ? base.excludeModels : value.excludeModels;
  const excludeModels = (Array.isArray(excludeSource) ? excludeSource : String(excludeSource || "").split(","))
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 50);
  return {
    enabled: value.enabled === undefined ? Boolean(base.enabled) : Boolean(value.enabled),
    // Below ~5 minutes a cold start costs more than the memory is worth.
    idleMinutes: Math.min(1440, Math.max(5, Math.floor(finiteNumber(
      value.idleMinutes === undefined ? base.idleMinutes : value.idleMinutes,
      DEFAULT_SETTINGS.idleMinutes,
    )))),
    minVramMb: Math.min(1_000_000, Math.max(0, Math.floor(finiteNumber(
      value.minVramMb === undefined ? base.minVramMb : value.minVramMb,
      0,
    )))),
    excludeModels,
    wakeOnDemand: value.wakeOnDemand === undefined ? Boolean(base.wakeOnDemand) : Boolean(value.wakeOnDemand),
  };
}

function normalizeSleepRecord(value = {}) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim();
  const model = String(value.model || "").trim();
  if (!id || !model || !value.config || typeof value.config !== "object") return null;
  return {
    id: id.slice(0, 200),
    model: model.slice(0, 300),
    name: String(value.name || "").slice(0, 200),
    engine: String(value.engine || "").slice(0, 40),
    containerName: String(value.containerName || "").slice(0, 200),
    sleptAt: value.sleptAt && Date.parse(value.sleptAt) ? value.sleptAt : new Date().toISOString(),
    reason: String(value.reason || "idle").slice(0, 120),
    idleMinutes: finiteNumber(value.idleMinutes, 0),
    vramMb: finiteNumber(value.vramMb, 0),
    wakeFailedAt: value.wakeFailedAt && Date.parse(value.wakeFailedAt) ? value.wakeFailedAt : null,
    wakeError: String(value.wakeError || "").slice(0, 500),
    config: value.config,
  };
}

function normalizeSleepLedger(value = {}) {
  const sleeping = (Array.isArray(value.sleeping) ? value.sleeping : [])
    .map((item) => normalizeSleepRecord(item))
    .filter(Boolean);
  return { version: 1, updatedAt: value.updatedAt || null, sleeping };
}

function createIdleUnloadController(options = {}) {
  const settingsFile = options.settingsFile;
  const sleepFile = options.sleepFile;
  const readJsonFile = options.readJsonFile;
  const writeJsonFile = options.writeJsonFile;
  const engine = String(options.engine || "");
  const listInstances = options.listInstances;
  const stopInstance = options.stopInstance;
  const startRuntime = options.startRuntime;
  const findLaunchConfig = options.findLaunchConfig || (() => null);
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});
  if (!settingsFile || !sleepFile || typeof readJsonFile !== "function" || typeof writeJsonFile !== "function") {
    throw new Error("createIdleUnloadController requires settingsFile, sleepFile, readJsonFile, and writeJsonFile.");
  }
  if (typeof listInstances !== "function" || typeof stopInstance !== "function" || typeof startRuntime !== "function") {
    throw new Error("createIdleUnloadController requires listInstances, stopInstance, and startRuntime.");
  }

  // Activity is tracked in memory only. After a restart every runtime starts
  // its idle clock again, which is the safe direction: a freshly restarted
  // manager never unloads something on the strength of counters it never saw.
  const activity = new Map();
  let settingsCache = null;
  let ticking = false;
  const waking = new Map();

  async function getSettings() {
    if (!settingsCache) {
      const stored = await readJsonFile(settingsFile, {});
      settingsCache = normalizeIdleUnloadSettings(stored, DEFAULT_SETTINGS);
    }
    return settingsCache;
  }

  async function saveSettings(input = {}) {
    const current = await getSettings();
    const next = normalizeIdleUnloadSettings(input, current);
    await writeJsonFile(settingsFile, next);
    settingsCache = next;
    // Changing the policy restarts every idle clock: a longer timeout should
    // not immediately unload something that was already past the old one.
    activity.clear();
    return next;
  }

  async function readLedger() {
    return normalizeSleepLedger(await readJsonFile(sleepFile, {}));
  }

  async function writeLedger(ledger) {
    const snapshot = normalizeSleepLedger({ ...ledger, updatedAt: new Date().toISOString() });
    await writeJsonFile(sleepFile, snapshot);
    return snapshot;
  }

  async function listSleeping() {
    const ledger = await readLedger();
    return {
      ok: true,
      settings: await getSettings(),
      sleeping: ledger.sleeping.map(({ config, ...rest }) => ({ ...rest, hasConfig: Boolean(config) })),
    };
  }

  function instanceKey(instance) {
    return `${instance.containerName || ""}::${instance.id || ""}`;
  }

  function isExcluded(settings, instance) {
    const model = String(instance.model || "").toLowerCase();
    const name = String(instance.name || "").toLowerCase();
    return settings.excludeModels.some((pattern) => {
      const needle = pattern.toLowerCase();
      return model === needle || name === needle || model.includes(needle);
    });
  }

  // Returns the idle milliseconds for a runtime, or null when it is active or
  // has not been observed long enough to judge.
  function idleMillisFor(instance, timestamp) {
    const key = instanceKey(instance);
    const total = finiteNumber(instance.requestsTotal, 0);
    // `running` on an instance means "the container is up", so in-flight work
    // is reported separately and must never be read from that flag.
    const busy = finiteNumber(instance.activeRequests, 0) + finiteNumber(instance.queuedRequests, 0);
    const previous = activity.get(key);
    if (!previous || previous.total !== total || busy > 0) {
      activity.set(key, { total, since: timestamp });
      return busy > 0 ? 0 : null;
    }
    return timestamp - previous.since;
  }

  function forgetInstance(instance) {
    activity.delete(instanceKey(instance));
  }

  async function sleepInstance(instance, context = {}) {
    const config = instance.launchConfig || await findLaunchConfig(instance);
    if (!config || !config.model) {
      // Without a reproducible launch spec an unload would be a one-way stop,
      // so the runtime is left alone and the reason is reported once.
      log(`idle-unload skipped ${instance.model || instance.containerName}: launch configuration unavailable`);
      return { ok: false, reason: "launch_config_unavailable" };
    }
    await stopInstance(instance);
    const ledger = await readLedger();
    const record = normalizeSleepRecord({
      id: instance.id || instance.containerName,
      model: instance.model,
      name: instance.name,
      engine: engine || instance.engine,
      containerName: instance.containerName,
      sleptAt: new Date().toISOString(),
      reason: context.reason || "idle",
      idleMinutes: context.idleMinutes || 0,
      vramMb: instance.vramReservationMb,
      config,
    });
    ledger.sleeping = [record, ...ledger.sleeping.filter((item) => item.id !== record.id)].slice(0, 50);
    await writeLedger(ledger);
    forgetInstance(instance);
    log(`idle-unload released ${record.model} after ${Math.round(record.idleMinutes)} min idle; configuration kept for wake`);
    return { ok: true, record };
  }

  async function tick() {
    if (ticking) return { ok: true, skipped: "in_progress" };
    ticking = true;
    try {
      const settings = await getSettings();
      if (!settings.enabled) {
        activity.clear();
        return { ok: true, enabled: false, released: [] };
      }
      const instances = await listInstances();
      const timestamp = now();
      const idleThresholdMs = settings.idleMinutes * 60 * 1000;
      const seen = new Set();
      const released = [];
      for (const instance of instances) {
        seen.add(instanceKey(instance));
        if (!instance.running) continue;
        if (isExcluded(settings, instance)) continue;
        if (settings.minVramMb > 0 && finiteNumber(instance.vramReservationMb, 0) < settings.minVramMb) continue;
        const idleMs = idleMillisFor(instance, timestamp);
        if (idleMs === null || idleMs < idleThresholdMs) continue;
        try {
          const result = await sleepInstance(instance, { reason: "idle", idleMinutes: idleMs / 60000 });
          if (result.ok) released.push(result.record);
        } catch (error) {
          log(`idle-unload failed for ${instance.model || instance.containerName}: ${error.message}`);
          forgetInstance(instance);
        }
      }
      // Drop activity for runtimes that are gone so the map cannot grow.
      for (const key of [...activity.keys()]) if (!seen.has(key)) activity.delete(key);
      return { ok: true, enabled: true, released };
    } finally {
      ticking = false;
    }
  }

  async function wake(id, wakeOptions = {}) {
    const target = String(id || "").trim();
    const pending = waking.get(target);
    // Concurrent callers (a UI click and an on-demand gateway wake) must share
    // one cold start rather than racing two containers onto the same GPU.
    if (pending) return pending;
    const promise = (async () => {
      const ledger = await readLedger();
      const record = ledger.sleeping.find((item) => item.id === target);
      if (!record) {
        const error = new Error("没有找到这个休眠实例。");
        error.status = 404;
        throw error;
      }
      try {
        const job = await startRuntime({ ...record.config, ...(wakeOptions.overrides || {}) });
        const next = await readLedger();
        next.sleeping = next.sleeping.filter((item) => item.id !== target);
        await writeLedger(next);
        log(`idle-unload woke ${record.model}`);
        return { ok: true, id: target, model: record.model, job };
      } catch (error) {
        // Keep the record: the configuration is still the only way back.
        const next = await readLedger();
        next.sleeping = next.sleeping.map((item) => (item.id === target
          ? { ...item, wakeFailedAt: new Date().toISOString(), wakeError: error.message }
          : item));
        await writeLedger(next);
        throw error;
      }
    })().finally(() => waking.delete(target));
    waking.set(target, promise);
    return promise;
  }

  async function forget(id) {
    const target = String(id || "").trim();
    const ledger = await readLedger();
    const before = ledger.sleeping.length;
    ledger.sleeping = ledger.sleeping.filter((item) => item.id !== target);
    if (ledger.sleeping.length === before) return { ok: false, removed: 0 };
    await writeLedger(ledger);
    return { ok: true, removed: before - ledger.sleeping.length };
  }

  // Used by the serve path: a model the user is launching by hand should not
  // keep a stale sleep record pointing at the same instance.
  async function clearFor(model) {
    const needle = String(model || "").trim().toLowerCase();
    if (!needle) return;
    const ledger = await readLedger();
    const filtered = ledger.sleeping.filter((item) => String(item.model || "").toLowerCase() !== needle);
    if (filtered.length !== ledger.sleeping.length) {
      ledger.sleeping = filtered;
      await writeLedger(ledger);
    }
  }

  async function findSleepingForModel(model) {
    const needle = String(model || "").trim().toLowerCase();
    if (!needle) return null;
    const ledger = await readLedger();
    return ledger.sleeping.find((item) => {
      const candidates = [item.model, item.name, item.config?.name].map((value) => String(value || "").toLowerCase());
      return candidates.includes(needle);
    }) || null;
  }

  return {
    getSettings,
    saveSettings,
    listSleeping,
    tick,
    wake,
    forget,
    clearFor,
    findSleepingForModel,
    sleepInstance,
  };
}

module.exports = {
  DEFAULT_IDLE_UNLOAD_SETTINGS: DEFAULT_SETTINGS,
  normalizeIdleUnloadSettings,
  normalizeSleepLedger,
  normalizeSleepRecord,
  createIdleUnloadController,
};
