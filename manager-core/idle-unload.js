"use strict";

const { buildRuntimeContainerName } = require("./runtime-instance-utils");
// The wake matching and placement rules live with LaunchStore (01 §15.3), so
// the legacy hooks and the store cannot drift apart.
const {
  isLaunchId,
  matchRecentLaunch,
  normalizeWakePlacement,
  recentLaunchPlacement,
} = require("./engines/launch-store");

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

// Only the opaque runtime-secret-store reference is ever kept in the ledger.
function normalizeWakeSecretRef(value) {
  const reference = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,160}$/.test(reference) ? reference : "";
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
    placement: normalizeWakePlacement(value.placement),
    secretRef: normalizeWakeSecretRef(value.secretRef),
    hasApiKey: Boolean(value.hasApiKey),
    config: value.config,
    // LaunchStore link (01 ENG-8): kept when present; old records have neither.
    ...(isLaunchId(value.launchId) ? { launchId: value.launchId } : {}),
    ...(value.spec && typeof value.spec === "object" && !Array.isArray(value.spec) ? { spec: value.spec } : {}),
  };
}

function wakeRefusal(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

const WAKE_API_KEY_MISSING_MESSAGE = "原 API Key 已不可用，请从启动页重新启动该模型。/ The original API key is no longer available. Start the model again from the launch page.";

function wakeWouldReplaceMessage(model) {
  return `唤醒会替换正在运行的 ${model}。/ Waking would replace the running model ${model}.`;
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
  // Optional wake hooks (08 P0-1). findWakePlan replaces findLaunchConfig when
  // present; the secret hooks keep an instance's API key across sleep through
  // the runtime secret store; canWake guards against replacing a running model.
  const findWakePlan = typeof options.findWakePlan === "function" ? options.findWakePlan : null;
  const canWake = typeof options.canWake === "function" ? options.canWake : null;
  const prepareWakeSecrets = typeof options.prepareWakeSecrets === "function" ? options.prepareWakeSecrets : null;
  const resolveWakeSecrets = typeof options.resolveWakeSecrets === "function" ? options.resolveWakeSecrets : null;
  const releaseWakeSecrets = typeof options.releaseWakeSecrets === "function" ? options.releaseWakeSecrets : null;
  // Optional (01 ENG-8): told when a record is slept, woken or dropped, so the
  // LaunchStore record follows it. Failures are logged and never block.
  const recordSleepEvent = typeof options.recordSleepEvent === "function" ? options.recordSleepEvent : null;
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
      // The automation panel used to own idle unloading, with no way back once
      // a container was stopped. Carry that preference over the first time so
      // nobody silently loses it when the feature moved here.
      const legacy = Object.keys(stored || {}).length ? null : await readLegacySettings();
      settingsCache = normalizeIdleUnloadSettings(stored, legacy ? {
        ...DEFAULT_SETTINGS,
        enabled: Boolean(legacy.idleUnloadEnabled),
        idleMinutes: legacy.idleMinutes || DEFAULT_SETTINGS.idleMinutes,
      } : DEFAULT_SETTINGS);
    }
    return settingsCache;
  }

  async function readLegacySettings() {
    if (typeof options.readLegacySettings !== "function") return null;
    try {
      const legacy = await options.readLegacySettings();
      return legacy && typeof legacy === "object" ? legacy : null;
    } catch {
      return null;
    }
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
      // Neither the config nor the secret-store reference leaves the manager.
      sleeping: ledger.sleeping.map(({ config, secretRef: _secretRef, spec: _spec, ...rest }) => ({ ...rest, hasConfig: Boolean(config) })),
    };
  }

  // A wake key lives in the runtime secret store only while its record does,
  // so every path that drops a record (wake, forget, clearFor, replacement,
  // the ledger cap) releases it. Release failures are logged, never thrown.
  async function releaseSecretsFor(records) {
    if (!releaseWakeSecrets) return;
    const seen = new Set();
    for (const record of records) {
      if (!record?.secretRef || seen.has(record.secretRef)) continue;
      seen.add(record.secretRef);
      try {
        await releaseWakeSecrets(record);
      } catch (error) {
        log(`idle-unload could not release the wake key of ${record.model}: ${error.message}`);
      }
    }
  }

  async function notifySleepEvent(event, records, details = {}) {
    if (!recordSleepEvent) return;
    for (const record of records) {
      if (!record?.launchId) continue;
      try {
        await recordSleepEvent(event, record, details);
      } catch (error) {
        log(`idle-unload could not record ${event} for ${record.model}: ${error.message}`);
      }
    }
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
    const plan = findWakePlan ? await findWakePlan(instance) : null;
    const config = instance.launchConfig || (findWakePlan ? plan?.config : await findLaunchConfig(instance));
    if (!config || !config.model) {
      // Without a reproducible launch spec an unload would be a one-way stop,
      // so the runtime is left alone and the reason is reported once.
      log(`idle-unload skipped ${instance.model || instance.containerName}: launch configuration unavailable`);
      return { ok: false, reason: "launch_config_unavailable" };
    }
    // Stopping removes the container's key from the secret store, so it is
    // copied under a wake ref first. A key that cannot be read makes the
    // release one-way, and the runtime keeps running instead.
    let secrets = null;
    if (prepareWakeSecrets) {
      try {
        secrets = await prepareWakeSecrets(instance);
      } catch (error) {
        if (error?.code !== "api_key_unavailable") throw error;
        log(`idle-unload skipped ${instance.model || instance.containerName}: API key unavailable`);
        return { ok: false, reason: "api_key_unavailable" };
      }
    }
    const secretRef = normalizeWakeSecretRef(secrets?.secretRef);
    try {
      await stopInstance(instance);
    } catch (error) {
      await releaseSecretsFor([{ model: instance.model, secretRef }]);
      throw error;
    }
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
      placement: plan?.placement,
      secretRef,
      hasApiKey: Boolean(secretRef),
      config,
      // While sleeping, the spec's key reference is the wake ref (01 §15.3).
      launchId: plan?.launchId,
      spec: plan?.spec ? { ...plan.spec, secrets: { ...(plan.spec.secrets || {}), apiKeyRef: secretRef } } : undefined,
    });
    const kept = [record, ...ledger.sleeping.filter((item) => item.id !== record.id)].slice(0, 50);
    const dropped = ledger.sleeping.filter((item) => !kept.includes(item));
    ledger.sleeping = kept;
    await writeLedger(ledger);
    await releaseSecretsFor(dropped);
    await notifySleepEvent("forgotten", dropped.filter((item) => item.launchId !== record.launchId));
    await notifySleepEvent("slept", [record]);
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
      // Refusals below happen before anything starts, so the record is left
      // exactly as it was and the caller can act on the code.
      let apiKey = "";
      if (resolveWakeSecrets && (record.secretRef || record.hasApiKey)) {
        const resolved = await resolveWakeSecrets(record);
        apiKey = String(resolved?.apiKey || "");
      }
      if (record.hasApiKey && !apiKey) {
        throw wakeRefusal(409, "wake_api_key_missing", WAKE_API_KEY_MISSING_MESSAGE);
      }
      // Waking must never replace a running model implicitly; only the UI's
      // explicit confirm sends confirmReplace.
      if (canWake && wakeOptions.confirmReplace !== true) {
        const verdict = await canWake(record);
        if (verdict && verdict.ok === false) {
          const runningModel = verdict.details?.runningModel || "";
          throw wakeRefusal(
            verdict.status || 409,
            verdict.code || "wake_would_replace_running",
            verdict.message || wakeWouldReplaceMessage(runningModel || record.model),
            verdict.details,
          );
        }
      }
      // A legacy record has no placement and goes back to the replace slot.
      const placement = record.placement;
      const body = {
        ...record.config,
        instanceMode: placement?.instanceMode || "replace",
        instanceId: placement?.instanceId || "",
        apiKey,
        ...(wakeOptions.overrides || {}),
      };
      try {
        const started = await startRuntime(body);
        // The launch handler answers { job }; the wake response carries the job.
        const job = started && typeof started === "object" && started.job ? started.job : started;
        const next = await readLedger();
        const removed = next.sleeping.filter((item) => item.id === target);
        next.sleeping = next.sleeping.filter((item) => item.id !== target);
        await writeLedger(next);
        // The launch saved the key under the new container's own ref.
        await releaseSecretsFor([record, ...removed]);
        await notifySleepEvent("woken", [record], { job });
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
    const removed = ledger.sleeping.filter((item) => item.id === target);
    ledger.sleeping = ledger.sleeping.filter((item) => item.id !== target);
    if (ledger.sleeping.length === before) return { ok: false, removed: 0 };
    await writeLedger(ledger);
    await releaseSecretsFor(removed);
    await notifySleepEvent("forgotten", removed);
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
      const removed = ledger.sleeping.filter((item) => !filtered.includes(item));
      ledger.sleeping = filtered;
      await writeLedger(ledger);
      await releaseSecretsFor(removed);
      await notifySleepEvent("forgotten", removed);
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

// The servers' implementation of the wake hooks, shared by both managers so
// the matching, the guard and the secret handling cannot drift apart. The
// launch record keeps the host path while a running instance reports the
// container path, so toContainerPath maps one onto the other for matching.
// With a launchStore (01 ENG-8) the wake plan comes from LaunchStore: the
// container's launch-id label first, then exactly this matching order, then
// the jobs-ledger entry of its job label.
function createIdleWakeHooks(options = {}) {
  const {
    managerId = "",
    primaryContainerName,
    managerLabelKey = "ai.manager",
    apiKeyRefLabelKey = "ai.manager.api-key-ref",
    apiKeyLabelKey = "ai.manager.api-key",
    modelLabelKey = "ai.manager.model",
    listRecentLaunches = () => [],
    getContainerStatus,
    secretStore,
    startRuntimeRequest,
    toContainerPath = (value) => value,
    buildContainerName = buildRuntimeContainerName,
    launchStore = null,
    jobsLedgerLookup = null,
  } = options;
  if (!primaryContainerName || typeof getContainerStatus !== "function" || typeof startRuntimeRequest !== "function"
    || !secretStore || typeof secretStore.get !== "function" || typeof secretStore.set !== "function"
    || typeof secretStore.remove !== "function") {
    throw new Error("createIdleWakeHooks requires primaryContainerName, getContainerStatus, startRuntimeRequest and a secret store.");
  }

  async function containerLabels(containerName) {
    if (!containerName) return {};
    try {
      return (await getContainerStatus(containerName))?.labels || {};
    } catch {
      return {};
    }
  }

  // Matching order (08 P0-1): container name, then model path, then served
  // name (launch-store.js matchRecentLaunch).
  async function findWakePlan(instance = {}) {
    const launches = await listRecentLaunches() || [];
    if (launchStore) {
      const labels = { ...(instance.labels || {}), ...(await containerLabels(instance.containerName)) };
      return launchStore.findWakePlan({ ...instance, labels }, { recentLaunches: launches, jobsLedgerLookup, toContainerPath });
    }
    const entry = matchRecentLaunch(launches, instance, { toContainerPath });
    if (!entry) return null;
    return { config: entry.config, placement: recentLaunchPlacement(entry, instance) };
  }

  async function canWake(record = {}) {
    const placement = record.placement;
    const parallel = placement?.instanceMode === "parallel";
    const containerName = parallel
      ? placement.containerName || buildContainerName(primaryContainerName, "parallel", placement.instanceId || record.config?.name || "")
      : primaryContainerName;
    const container = await getContainerStatus(containerName);
    if (!container?.exists || !container.running) return { ok: true };
    const owner = String(container.labels?.[managerLabelKey] || "");
    // Replace placement (or a legacy record) only conflicts with the primary
    // container this manager owns; a parallel slot conflicts with anything
    // running under its name.
    if (!parallel && owner && managerId && owner !== managerId) return { ok: true };
    const runningModel = String(container.labels?.[modelLabelKey] || "").trim() || containerName;
    return {
      ok: false,
      status: 409,
      code: "wake_would_replace_running",
      message: wakeWouldReplaceMessage(runningModel),
      details: { runningModel, runningContainer: containerName },
    };
  }

  async function prepareWakeSecrets(instance = {}) {
    const container = await getContainerStatus(instance.containerName);
    const labels = container?.labels || {};
    const reference = String(labels[apiKeyRefLabelKey] || "").trim();
    const legacyKey = String(labels[apiKeyLabelKey] || "").trim();
    if (!reference && !legacyKey) return null;
    let key = legacyKey;
    if (reference) {
      try {
        key = String(secretStore.get(reference) || "");
      } catch {
        key = "";
      }
    }
    if (!key) {
      const error = new Error("The runtime API key of this instance cannot be read, so it is not released.");
      error.code = "api_key_unavailable";
      throw error;
    }
    // The copy is a wake-<uuid> ref, so it never collides with a container's own.
    const secretRef = await secretStore.set(key, { prefix: "wake" });
    if (!secretRef) {
      const error = new Error("The runtime API key could not be kept for wake, so the instance is not released.");
      error.code = "api_key_unavailable";
      throw error;
    }
    return { secretRef };
  }

  async function resolveWakeSecrets(record = {}) {
    if (!record.secretRef) return { apiKey: "" };
    return { apiKey: String(secretStore.get(record.secretRef) || "") };
  }

  async function releaseWakeSecrets(record = {}) {
    if (record.secretRef) await secretStore.remove(record.secretRef);
  }

  // The LaunchStore record follows its sleep record: sleeping with the wake
  // ref while released, stopped once woken (the wake is a new launch) or
  // forgotten, when the wake ref is gone.
  async function recordSleepEvent(event, record = {}, details = {}) {
    if (!launchStore || !record.launchId) return;
    if (event === "slept") {
      launchStore.markStatus(record.launchId, "sleeping", {
        event: "slept",
        detail: record.id,
        patch: { spec: { secrets: { apiKeyRef: record.secretRef || "" } } },
      });
    } else if (event === "woken" || event === "forgotten") {
      launchStore.markStatus(record.launchId, "stopped", {
        event: event === "woken" ? "woken" : "stopped",
        detail: event === "woken" ? String(details.job?.id || "") : "forgotten",
        patch: { spec: { secrets: { apiKeyRef: "" } } },
      });
    }
  }

  return {
    // The launch handler takes { body }; wake hands it the start body.
    startRuntime: (body) => startRuntimeRequest({ body }),
    findWakePlan,
    canWake,
    prepareWakeSecrets,
    resolveWakeSecrets,
    releaseWakeSecrets,
    ...(launchStore ? { recordSleepEvent } : {}),
  };
}

module.exports = {
  DEFAULT_IDLE_UNLOAD_SETTINGS: DEFAULT_SETTINGS,
  createIdleWakeHooks,
  normalizeWakePlacement,
  normalizeIdleUnloadSettings,
  normalizeSleepLedger,
  normalizeSleepRecord,
  createIdleUnloadController,
};
