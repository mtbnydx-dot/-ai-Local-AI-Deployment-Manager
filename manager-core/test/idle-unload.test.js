const test = require("node:test");
const assert = require("node:assert/strict");

const { createIdleUnloadController, normalizeIdleUnloadSettings } = require("../idle-unload");

function harness(overrides = {}) {
  const files = { settings: {}, sleep: {} };
  const stopped = [];
  const started = [];
  let clock = 0;
  const controller = createIdleUnloadController({
    settingsFile: "settings",
    sleepFile: "sleep",
    engine: "vllm",
    readJsonFile: async (file, fallback) => (file === "settings" ? files.settings : files.sleep) ?? fallback,
    writeJsonFile: async (file, value) => { if (file === "settings") files.settings = value; else files.sleep = value; },
    listInstances: overrides.listInstances || (async () => []),
    stopInstance: overrides.stopInstance || (async (instance) => { stopped.push(instance.id); }),
    startRuntime: overrides.startRuntime || (async (config) => { started.push(config); return { id: "job-1" }; }),
    now: () => clock,
    log: () => {},
    ...overrides.controller,
  });
  return {
    controller,
    stopped,
    started,
    files,
    advance: (minutes) => { clock += minutes * 60 * 1000; },
  };
}

const instance = {
  id: "primary",
  containerName: "vllm-local",
  model: "qwen3-27b",
  name: "qwen3",
  running: true,
  requestsTotal: 10,
  activeRequests: 0,
  queuedRequests: 0,
  vramReservationMb: 40000,
  launchConfig: { model: "qwen3-27b", name: "qwen3", maxModelLen: 32768 },
};

test("settings clamp to values where a cold start is worth the memory", () => {
  const settings = normalizeIdleUnloadSettings({ idleMinutes: 1, excludeModels: "a, b ,,c" });
  assert.equal(settings.idleMinutes, 5);
  assert.deepEqual(settings.excludeModels, ["a", "b", "c"]);
  assert.equal(settings.enabled, false);
});

test("nothing is unloaded while the feature is off", async () => {
  const kit = harness({ listInstances: async () => [{ ...instance }] });
  kit.advance(600);
  const result = await kit.controller.tick();
  assert.equal(result.enabled, false);
  assert.deepEqual(kit.stopped, []);
});

test("a runtime is released only after its request counter stops moving", async () => {
  let requestsTotal = 10;
  const kit = harness({ listInstances: async () => [{ ...instance, requestsTotal }] });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });

  // First observation only starts the clock.
  assert.deepEqual((await kit.controller.tick()).released, []);
  kit.advance(40);
  // Traffic arrived in between, so the clock restarts rather than firing.
  requestsTotal = 25;
  assert.deepEqual((await kit.controller.tick()).released, []);
  kit.advance(40);

  const released = (await kit.controller.tick()).released;
  assert.equal(released.length, 1);
  assert.equal(released[0].model, "qwen3-27b");
  assert.deepEqual(kit.stopped, ["primary"]);
  assert.equal(kit.files.sleep.sleeping[0].config.maxModelLen, 32768);
});

test("a busy runtime is never released, however long it has been resident", async () => {
  const kit = harness({ listInstances: async () => [{ ...instance, running: true, queuedRequests: 3 }] });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(600);
  assert.deepEqual((await kit.controller.tick()).released, []);
  assert.deepEqual(kit.stopped, []);
});

test("exclusions and the size floor keep a runtime resident", async () => {
  const kit = harness({ listInstances: async () => [{ ...instance }] });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30, excludeModels: ["qwen3-27b"] });
  await kit.controller.tick();
  kit.advance(120);
  assert.deepEqual((await kit.controller.tick()).released, []);

  await kit.controller.saveSettings({ excludeModels: [], minVramMb: 80000 });
  await kit.controller.tick();
  kit.advance(120);
  assert.deepEqual((await kit.controller.tick()).released, []);
});

test("a runtime with no reproducible launch spec is left running", async () => {
  const kit = harness({ listInstances: async () => [{ ...instance, launchConfig: null }] });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(120);
  assert.deepEqual((await kit.controller.tick()).released, []);
  assert.deepEqual(kit.stopped, []);
});

test("waking restarts the stored configuration and clears the record", async () => {
  const kit = harness({ listInstances: async () => [{ ...instance }] });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(120);
  await kit.controller.tick();

  const sleeping = await kit.controller.listSleeping();
  assert.equal(sleeping.sleeping.length, 1);
  // The config itself is not exposed to the UI, only that one exists.
  assert.equal(sleeping.sleeping[0].config, undefined);
  assert.equal(sleeping.sleeping[0].hasConfig, true);

  const woke = await kit.controller.wake("primary");
  assert.equal(woke.ok, true);
  assert.equal(kit.started[0].model, "qwen3-27b");
  assert.deepEqual((await kit.controller.listSleeping()).sleeping, []);
});

test("a failed wake keeps the record so the configuration is not lost", async () => {
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    startRuntime: async () => { throw new Error("no free VRAM"); },
  });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(120);
  await kit.controller.tick();

  await assert.rejects(() => kit.controller.wake("primary"), /no free VRAM/);
  const sleeping = await kit.controller.listSleeping();
  assert.equal(sleeping.sleeping.length, 1);
  assert.equal(sleeping.sleeping[0].wakeError, "no free VRAM");
});

test("concurrent wakes share one cold start", async () => {
  let starts = 0;
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    startRuntime: async () => {
      starts += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: "job-1" };
    },
  });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(120);
  await kit.controller.tick();

  await Promise.all([kit.controller.wake("primary"), kit.controller.wake("primary")]);
  assert.equal(starts, 1);
});

test("waking an unknown instance reports 404 rather than throwing a bare error", async () => {
  const kit = harness();
  await assert.rejects(() => kit.controller.wake("missing"), (error) => error.status === 404);
});

test("a sleeping runtime can be looked up by model or served name", async () => {
  const kit = harness({ listInstances: async () => [{ ...instance }] });
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(120);
  await kit.controller.tick();

  assert.equal((await kit.controller.findSleepingForModel("qwen3-27b")).id, "primary");
  assert.equal((await kit.controller.findSleepingForModel("qwen3")).id, "primary");
  assert.equal(await kit.controller.findSleepingForModel("other"), null);

  await kit.controller.clearFor("qwen3-27b");
  assert.equal(await kit.controller.findSleepingForModel("qwen3-27b"), null);
});

test("the old automation idle setting is carried over once", async () => {
  const kit = harness({
    controller: { readLegacySettings: async () => ({ idleUnloadEnabled: true, idleMinutes: 90 }) },
  });
  const settings = await kit.controller.getSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.idleMinutes, 90);
});

test("a saved policy wins over the legacy automation setting", async () => {
  const kit = harness({
    controller: { readLegacySettings: async () => ({ idleUnloadEnabled: true, idleMinutes: 90 }) },
  });
  await kit.controller.saveSettings({ enabled: false, idleMinutes: 20 });
  const fresh = harness({
    controller: { readLegacySettings: async () => ({ idleUnloadEnabled: true, idleMinutes: 90 }) },
  });
  // A stored policy is present, so the legacy values are not consulted again.
  fresh.files.settings = kit.files.settings;
  const settings = await fresh.controller.getSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.idleMinutes, 20);
});

// ---- Wake end to end (08 P0-1) -------------------------------------------

const { createIdleWakeHooks } = require("../idle-unload");

async function sleepOnce(kit) {
  await kit.controller.saveSettings({ enabled: true, idleMinutes: 30 });
  await kit.controller.tick();
  kit.advance(120);
  return (await kit.controller.tick()).released;
}

test("findWakePlan supplies the config and the placement reaches the start body", async () => {
  const kit = harness({
    listInstances: async () => [{ ...instance, launchConfig: null }],
    controller: {
      findWakePlan: async () => ({
        config: { model: "D:/store/qwen3-27b", name: "qwen3", port: 8011 },
        placement: { instanceMode: "parallel", instanceId: "qwen3", containerName: "vllm-local-qwen3" },
      }),
      // The legacy hook is never consulted once findWakePlan exists.
      findLaunchConfig: () => assert.fail("findLaunchConfig must not run when findWakePlan is wired"),
    },
  });
  const released = await sleepOnce(kit);
  assert.equal(released.length, 1);
  assert.deepEqual(kit.files.sleep.sleeping[0].placement, { instanceMode: "parallel", instanceId: "qwen3", containerName: "vllm-local-qwen3" });

  await kit.controller.wake("primary");
  assert.equal(kit.started[0].model, "D:/store/qwen3-27b");
  assert.equal(kit.started[0].port, 8011);
  assert.equal(kit.started[0].instanceMode, "parallel");
  assert.equal(kit.started[0].instanceId, "qwen3");
  assert.equal(kit.started[0].apiKey, "");
});

test("a missing wake plan leaves the runtime running", async () => {
  const kit = harness({
    listInstances: async () => [{ ...instance, launchConfig: null }],
    controller: { findWakePlan: async () => null },
  });
  assert.deepEqual(await sleepOnce(kit), []);
  assert.deepEqual(kit.stopped, []);
});

test("canWake refuses with 409 and details until confirmReplace is sent", async () => {
  const verdicts = [];
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    controller: {
      canWake: async (record) => {
        verdicts.push(record.id);
        return {
          ok: false,
          code: "wake_would_replace_running",
          message: "唤醒会替换正在运行的 other-model。/ Waking would replace the running model other-model.",
          details: { runningModel: "other-model", runningContainer: "vllm-local" },
        };
      },
    },
  });
  await sleepOnce(kit);

  await assert.rejects(() => kit.controller.wake("primary"), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "wake_would_replace_running");
    assert.deepEqual(error.details, { runningModel: "other-model", runningContainer: "vllm-local" });
    assert.match(error.message, /Waking would replace the running model other-model/);
    return true;
  });
  assert.deepEqual(kit.started, []);
  // The refusal changes nothing in the ledger.
  const sleeping = (await kit.controller.listSleeping()).sleeping;
  assert.equal(sleeping.length, 1);
  assert.equal(sleeping[0].wakeError, "");

  const woke = await kit.controller.wake("primary", { confirmReplace: true });
  assert.equal(woke.ok, true);
  assert.equal(kit.started.length, 1);
  // The explicit confirm skips the guard entirely.
  assert.deepEqual(verdicts, ["primary"]);
});

test("wake secrets are prepared before stop, resolved before start and released after the wake", async () => {
  const events = [];
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    stopInstance: async (target) => { events.push(`stop:${target.id}`); },
    startRuntime: async (body) => { events.push(`start:${body.apiKey}`); return { job: { id: "job-wake" } }; },
    controller: {
      prepareWakeSecrets: async (target) => { events.push(`prepare:${target.id}`); return { secretRef: "wake-ref-0001" }; },
      resolveWakeSecrets: async (record) => { events.push(`resolve:${record.secretRef}`); return { apiKey: "fixture-wake-key" }; },
      releaseWakeSecrets: async (record) => { events.push(`release:${record.secretRef}`); },
    },
  });
  await sleepOnce(kit);
  assert.deepEqual(events, ["prepare:primary", "stop:primary"]);
  const stored = kit.files.sleep.sleeping[0];
  assert.equal(stored.secretRef, "wake-ref-0001");
  assert.equal(stored.hasApiKey, true);
  assert.equal(JSON.stringify(kit.files.sleep).includes("fixture-wake-key"), false, "the ledger holds the ref only");
  // The UI listing exposes neither the config nor the ref.
  const listed = (await kit.controller.listSleeping()).sleeping[0];
  assert.equal(listed.secretRef, undefined);
  assert.equal(listed.hasApiKey, true);

  const woke = await kit.controller.wake("primary");
  assert.deepEqual(woke.job, { id: "job-wake" });
  assert.deepEqual(events, ["prepare:primary", "stop:primary", "resolve:wake-ref-0001", "start:fixture-wake-key", "release:wake-ref-0001"]);
});

test("a failed wake keeps the wake key; forget releases it", async () => {
  const released = [];
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    startRuntime: async () => { throw new Error("no free VRAM"); },
    controller: {
      prepareWakeSecrets: async () => ({ secretRef: "wake-ref-0002" }),
      resolveWakeSecrets: async () => ({ apiKey: "fixture-wake-key" }),
      releaseWakeSecrets: async (record) => { released.push(record.secretRef); },
    },
  });
  await sleepOnce(kit);
  await assert.rejects(() => kit.controller.wake("primary"), /no free VRAM/);
  assert.deepEqual(released, []);
  assert.equal((await kit.controller.forget("primary")).ok, true);
  assert.deepEqual(released, ["wake-ref-0002"]);
});

test("a wake whose key is gone answers 409 wake_api_key_missing and starts nothing", async () => {
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    controller: {
      prepareWakeSecrets: async () => ({ secretRef: "wake-ref-0003" }),
      resolveWakeSecrets: async () => ({ apiKey: "" }),
      releaseWakeSecrets: async () => {},
    },
  });
  await sleepOnce(kit);
  await assert.rejects(() => kit.controller.wake("primary", { confirmReplace: true }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "wake_api_key_missing");
    assert.match(error.message, /原 API Key 已不可用/);
    assert.match(error.message, /The original API key is no longer available/);
    return true;
  });
  assert.deepEqual(kit.started, []);
  assert.equal((await kit.controller.listSleeping()).sleeping.length, 1);
});

test("sleep is skipped and the container kept when the API key cannot be captured", async () => {
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    controller: {
      prepareWakeSecrets: async () => { throw Object.assign(new Error("unreadable"), { code: "api_key_unavailable" }); },
    },
  });
  assert.deepEqual(await sleepOnce(kit), []);
  assert.deepEqual(kit.stopped, []);
  assert.deepEqual(kit.files.sleep, {});

  // Any other capture failure also keeps the runtime: nothing is stopped.
  const other = harness({
    listInstances: async () => [{ ...instance }],
    controller: { prepareWakeSecrets: async () => { throw new Error("store write failed"); } },
  });
  assert.deepEqual(await sleepOnce(other), []);
  assert.deepEqual(other.stopped, []);
});

test("a failed stop releases the wake key it had just stored", async () => {
  const released = [];
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    stopInstance: async () => { throw new Error("docker unavailable"); },
    controller: {
      prepareWakeSecrets: async () => ({ secretRef: "wake-ref-0004" }),
      releaseWakeSecrets: async (record) => { released.push(record.secretRef); },
    },
  });
  assert.deepEqual(await sleepOnce(kit), []);
  assert.deepEqual(released, ["wake-ref-0004"]);
  assert.deepEqual(kit.files.sleep, {});
});

test("a legacy record without placement wakes into the replace slot under the guard", async () => {
  const kit = harness({
    controller: {
      canWake: async (record) => (record.placement === null
        ? { ok: false, code: "wake_would_replace_running", details: { runningModel: "busy", runningContainer: "vllm-local" } }
        : { ok: true }),
    },
  });
  // Written by the pre-P0 code: no placement, secretRef or hasApiKey.
  kit.files.sleep = {
    version: 1,
    sleeping: [{ id: "primary", model: "qwen3-27b", name: "qwen3", config: { model: "qwen3-27b", name: "qwen3" } }],
  };
  await assert.rejects(() => kit.controller.wake("primary"), (error) => error.status === 409 && error.code === "wake_would_replace_running");
  await kit.controller.wake("primary", { confirmReplace: true });
  assert.equal(kit.started[0].instanceMode, "replace");
  assert.equal(kit.started[0].instanceId, "");
  assert.equal(kit.started[0].model, "qwen3-27b");
});

test("records dropped by clearFor or a re-sleep release their wake keys", async () => {
  const released = [];
  let ref = 0;
  const kit = harness({
    listInstances: async () => [{ ...instance }],
    controller: {
      prepareWakeSecrets: async () => ({ secretRef: `wake-ref-${String(++ref).padStart(4, "0")}` }),
      releaseWakeSecrets: async (record) => { released.push(record.secretRef); },
    },
  });
  await sleepOnce(kit);
  // A second release of the same id replaces the old record and its key.
  await kit.controller.sleepInstance({ ...instance }, { reason: "manual" });
  assert.deepEqual(released, ["wake-ref-0001"]);
  await kit.controller.clearFor("qwen3-27b");
  assert.deepEqual(released, ["wake-ref-0001", "wake-ref-0002"]);
});

function hookKit({ containers = {}, launches = [], secrets = {} } = {}) {
  const store = new Map(Object.entries(secrets));
  let next = 0;
  const secretStore = {
    get: (reference) => store.get(reference) || "",
    set: async (secret) => {
      const reference = `wake-ref-${String(++next).padStart(4, "0")}`;
      store.set(reference, secret);
      return reference;
    },
    remove: async (reference) => store.delete(reference),
  };
  const bodies = [];
  const hooks = createIdleWakeHooks({
    managerId: "vllm-manager",
    primaryContainerName: "vllm-local",
    listRecentLaunches: () => launches,
    getContainerStatus: async (name) => containers[name] || { exists: false, running: false, labels: {} },
    secretStore,
    startRuntimeRequest: async (request) => { bodies.push(request); return { job: { id: "job-hooks" } }; },
    toContainerPath: (value) => String(value).replace(/^D:\/store/i, "/models"),
  });
  return { hooks, store, bodies };
}

test("wake hooks match by container name, then model path, then served name", async () => {
  const byPath = { model: "D:/store/qwen-a", name: "qwen-a", config: { model: "D:/store/qwen-a", name: "qwen-a" } };
  const byContainer = {
    model: "D:/store/qwen-b", name: "qwen-a", containerName: "vllm-local-b", instanceMode: "parallel", instanceId: "b",
    config: { model: "D:/store/qwen-b", name: "qwen-a", port: 8012 },
  };
  const byServed = { model: "D:/store/other", name: "served-x", config: { model: "D:/store/other", name: "served-x" } };
  const { hooks } = hookKit({ launches: [byPath, byServed, byContainer] });

  // 1. Container name wins over a newer path match.
  const first = await hooks.findWakePlan({ containerName: "vllm-local-b", model: "qwen-a", name: "/models/qwen-a" });
  assert.equal(first.config.model, "D:/store/qwen-b");
  assert.deepEqual(first.placement, { instanceMode: "parallel", instanceId: "b", containerName: "vllm-local-b" });

  // 2. Model path (host path mapped to the container path, case-insensitive).
  const second = await hooks.findWakePlan({ containerName: "vllm-local", model: "nope", name: "/MODELS/qwen-a" });
  assert.equal(second.config.model, "D:/store/qwen-a");

  // 3. Served name.
  const third = await hooks.findWakePlan({ containerName: "vllm-local", model: "served-x", name: "/models/elsewhere" });
  assert.equal(third.config.model, "D:/store/other");

  // A legacy launch record takes the placement the instance is running in.
  assert.deepEqual(
    (await hooks.findWakePlan({ id: "primary", containerName: "vllm-local", instanceMode: "replace", model: "served-x" })).placement,
    { instanceMode: "replace", instanceId: "", containerName: "vllm-local" },
  );
  assert.equal(await hooks.findWakePlan({ containerName: "x", model: "unknown", name: "/models/unknown" }), null);
});

test("wake hooks guard the primary slot and parallel container names", async () => {
  const running = (labels) => ({ exists: true, running: true, labels });
  const { hooks } = hookKit({
    containers: {
      "vllm-local": running({ "ai.manager": "vllm-manager", "ai.manager.model": "Qwen3.8-27B" }),
      "vllm-local-b": running({ "ai.manager": "vllm-manager", "ai.manager.model": "busy-b" }),
    },
  });
  const replace = await hooks.canWake({ placement: { instanceMode: "replace", instanceId: "", containerName: "vllm-local" }, config: {} });
  assert.equal(replace.ok, false);
  assert.equal(replace.code, "wake_would_replace_running");
  assert.deepEqual(replace.details, { runningModel: "Qwen3.8-27B", runningContainer: "vllm-local" });
  assert.equal(replace.message, "唤醒会替换正在运行的 Qwen3.8-27B。/ Waking would replace the running model Qwen3.8-27B.");
  // A legacy record (no placement) is the replace slot.
  assert.equal((await hooks.canWake({ placement: null, config: {} })).ok, false);
  assert.equal((await hooks.canWake({ placement: { instanceMode: "parallel", instanceId: "b", containerName: "vllm-local-b" }, config: {} })).ok, false);
  assert.equal((await hooks.canWake({ placement: { instanceMode: "parallel", instanceId: "c", containerName: "" }, config: {} })).ok, true);

  const idle = hookKit({ containers: { "vllm-local": { exists: true, running: false, labels: { "ai.manager": "vllm-manager" } } } });
  assert.equal((await idle.hooks.canWake({ placement: null, config: {} })).ok, true);
  const foreign = hookKit({ containers: { "vllm-local": running({ "ai.manager": "other-manager" }) } });
  assert.equal((await foreign.hooks.canWake({ placement: null, config: {} })).ok, true);
});

test("wake hooks copy the container key under a wake ref and release it", async () => {
  const { hooks, store, bodies } = hookKit({
    containers: {
      "vllm-local": { exists: true, running: true, labels: { "ai.manager.api-key-ref": "container-ref-01" } },
      "vllm-legacy": { exists: true, running: true, labels: { "ai.manager.api-key": "fixture-legacy-label-key" } },
      "vllm-lost": { exists: true, running: true, labels: { "ai.manager.api-key-ref": "missing-ref-0001" } },
      "vllm-open": { exists: true, running: true, labels: {} },
    },
    secrets: { "container-ref-01": "fixture-container-key" },
  });
  const prepared = await hooks.prepareWakeSecrets({ containerName: "vllm-local" });
  assert.equal(store.get(prepared.secretRef), "fixture-container-key");
  assert.equal(store.get("container-ref-01"), "fixture-container-key", "the container ref is left for the stop to remove");
  assert.deepEqual(await hooks.resolveWakeSecrets({ secretRef: prepared.secretRef }), { apiKey: "fixture-container-key" });
  await hooks.releaseWakeSecrets({ secretRef: prepared.secretRef });
  assert.equal(store.has(prepared.secretRef), false);

  const legacy = await hooks.prepareWakeSecrets({ containerName: "vllm-legacy" });
  assert.equal(store.get(legacy.secretRef), "fixture-legacy-label-key");
  await assert.rejects(() => hooks.prepareWakeSecrets({ containerName: "vllm-lost" }), (error) => error.code === "api_key_unavailable");
  assert.equal(await hooks.prepareWakeSecrets({ containerName: "vllm-open" }), null);

  await hooks.startRuntime({ model: "m" });
  assert.deepEqual(bodies, [{ body: { model: "m" } }]);
});
