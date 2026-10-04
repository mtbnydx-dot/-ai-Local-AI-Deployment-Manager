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
