"use strict";

// Idle sleep -> wake end to end (docs/overhaul/08-p0-fixes.md P0-1). The
// controller runs with the shared wake hooks and the real vLLM launch handler
// (createVllmStartRuntimeRequest) over a fake docker and a fake GPU admission.
// Assertions go only through the hook interface, the wake route and the start
// body that reaches the launch handler, so 01 ENG-8 can run this unchanged.

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const core = require("../../manager-core");
const { createVllmStartRuntimeRequest } = require("../lib/launch-request");
const { createVllmRuntimeCommandBuilder } = require("../lib/runtime-command");

const MANAGER_ID = "vllm-manager";
const PRIMARY = "vllm-local";
const KEY = "fixture-wake-key-0123456789";
const OTHER_KEY = "fixture-other-key-0123456789";

function labelsFromArgs(args) {
  const labels = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, ...rest] = String(args[index + 1]).split("=");
    labels[key] = rest.join("=");
  }
  return labels;
}

async function createRig(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vllm-idle-wake-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const secretStore = core.createRuntimeSecretStore({ file: path.join(root, "runtime-api-keys.json") });
  const files = new Map();
  const readJsonFile = async (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback);
  const writeJsonFile = async (file, value) => { files.set(file, structuredClone(value)); };

  // Fake docker: a container table fed by the docker run argv.
  const containers = new Map();
  const dockerRuns = [];
  const docker = async (args, options = {}) => {
    if (args[0] !== "run") throw new Error(`unexpected docker ${args[0]}`);
    dockerRuns.push({ args, env: options.env || {} });
    const name = args[args.indexOf("--name") + 1];
    containers.set(name, { name, exists: true, running: true, labels: labelsFromArgs(args) });
    return { stdout: `${name}-id\n`, stderr: "" };
  };
  const removeContainer = async (name) => {
    const container = containers.get(name);
    if (!container) return;
    containers.delete(name);
    // As the server's stop paths do: the container's key ref goes with it.
    const reference = container.labels["ai.manager.api-key-ref"];
    if (reference) await secretStore.remove(reference);
  };

  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
    CONFIG: { containerName: PRIMARY, managerId: MANAGER_ID, hfCache: "C:/cache/hf", modelsRoot: "C:/store", image: "vllm/fixture:pinned" },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {},
    scheduleJobsSave: () => {},
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace(/^C:\/store/i, "/models"),
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: (model) => ({ modelArg: String(model).replace(/^C:\/store/i, "/models"), effectiveLoadFormat: "auto", localPath: model }),
    effectiveLaunchQuantization: () => ({ value: "", modelConfigMethod: "" }),
    resolveVllmRuntimePreset: () => ({}),
  });

  const jobs = [];
  const recentLaunches = [];
  const fakeLease = (request) => ({
    summary: { id: `lease-${request.containerName}`, requestedTotalMb: 1000, reservations: [] },
    commit: async () => {},
    release: async () => {},
    startHeartbeat: () => () => {},
  });
  // The launch handler with fake admission and a runStartJob that builds the
  // real command and runs it on the fake docker, like the server does.
  const realStart = createVllmStartRuntimeRequest({
    CONFIG: { containerName: PRIMARY, managerId: MANAGER_ID, defaultPort: 8000 },
    cleanRequired: (value, name) => {
      const text = String(value || "").trim();
      if (!text) throw Object.assign(new Error(`${name} is required`), { status: 400 });
      return text;
    },
    deriveName: (model) => path.posix.basename(String(model)).toLowerCase(),
    positiveInt: (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback),
    nonNegativeNumber: (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback),
    optionalNonNegativeNumber: (value) => (value === undefined || value === null || value === "" ? null : Number(value)),
    normalizeDtype: (value) => String(value || "auto"),
    normalizeQuantization: (value) => String(value || ""),
    normalizeLoadFormat: (value) => String(value || "auto"),
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeKvCacheDtype: (value) => String(value || "auto"),
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    normalizeClientPreset: (value) => String(value || "generic"),
    normalizeReasoningParser: (value) => String(value || "auto"),
    normalizeToolCallParser: (value) => String(value || "auto"),
    inferToolCallParser: () => "",
    normalizeNetworkAccess: (value) => (value === "lan" ? "lan" : "local"),
    getLanAddress: () => "127.0.0.1",
    createJob: (type, title, meta) => {
      const job = { id: `job-${jobs.length + 1}`, type, title, status: "running", meta: { ...meta }, logs: [] };
      jobs.push(job);
      return job;
    },
    runStartJob: async (job, runOptions) => {
      if (typeof runOptions.prepareGpuAdmission === "function") {
        await runOptions.prepareGpuAdmission(async () => ({ prepared: true }));
      }
      const previous = containers.get(runOptions.containerName);
      const { runArgs, secretEnv } = buildVllmRuntimeCommand(job, runOptions);
      if (previous) await removeContainer(runOptions.containerName);
      await core.dockerRunWithRetries({
        docker,
        runArgs,
        dockerOptions: { env: core.buildDockerChildEnv(secretEnv, { viaWsl: false, baseEnv: {} }) },
      });
      job.status = "success";
      // What the server's onJobSuccess -> recordRecentLaunch keeps.
      const meta = job.meta;
      recentLaunches.unshift({
        model: meta.model,
        name: meta.name,
        containerName: meta.containerName,
        instanceMode: meta.instanceMode,
        instanceId: meta.instanceId,
        config: { model: meta.model, name: meta.name, port: meta.port, maxModelLen: meta.maxModelLen, maxNumSeqs: meta.maxNumSeqs },
      });
    },
    failJob: (job, error) => { job.status = "failed"; job.error = error.message; },
    acquireGpuAdmission: async (request) => fakeLease(request),
    acquireGpuAdmissionAfterPrepare: async (request, prepare) => ({ lease: fakeLease(request), context: await prepare(request) }),
    saveRuntimeApiKey: (apiKey) => secretStore.set(apiKey),
    deleteRuntimeApiKey: (reference) => secretStore.remove(reference),
    normalizeRuntimeInstanceMode: core.normalizeRuntimeInstanceMode,
    normalizeRuntimeInstanceId: core.normalizeRuntimeInstanceId,
    buildRuntimeContainerName: core.buildRuntimeContainerName,
  });
  const startBodies = [];
  const startRuntimeRequest = async (request) => {
    startBodies.push(structuredClone(request.body));
    return realStart(request);
  };

  let clock = 0;
  const hooks = core.createIdleWakeHooks({
    managerId: MANAGER_ID,
    primaryContainerName: PRIMARY,
    listRecentLaunches: () => recentLaunches,
    getContainerStatus: async (name) => containers.get(name) || { exists: false, running: false, labels: {} },
    secretStore,
    startRuntimeRequest,
    toContainerPath: (value) => String(value).replace(/^C:\/store/i, "/models"),
  });
  const controller = core.createIdleUnloadController({
    settingsFile: "idle-settings",
    sleepFile: "idle-sleeping",
    engine: "vllm",
    readJsonFile,
    writeJsonFile,
    listInstances: async () => [...containers.values()].filter((item) => item.running).map((item) => ({
      id: item.name === PRIMARY ? "primary" : item.labels["ai.manager.instance"],
      containerName: item.name,
      model: item.labels["ai.manager.model"],
      name: "/models/served-elsewhere",
      running: true,
      requestsTotal: 5,
      activeRequests: 0,
      queuedRequests: 0,
      vramReservationMb: 1000,
      instanceMode: item.name === PRIMARY ? "replace" : item.labels["ai.manager.instance-mode"],
      launchConfig: null,
    })),
    stopInstance: (instance) => removeContainer(instance.containerName),
    now: () => clock,
    log: () => {},
    ...hooks,
  });

  // The route exactly as the manager registers it.
  const app = express();
  app.use(express.json());
  core.registerManagerRoutes(app, {
    idleUnload: {
      listSleeping: () => controller.listSleeping(),
      saveSettings: (body) => controller.saveSettings(body),
      wake: (id, options) => controller.wake(id, options),
      forget: (id) => controller.forget(id),
    },
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  async function launch(body) {
    const { job } = await realStart({ body });
    await waitFor(() => job.status !== "running");
    assert.equal(job.status, "success", job.error);
    return job;
  }

  async function sleepIdle() {
    await controller.saveSettings({ enabled: true, idleMinutes: 30 });
    await controller.tick();
    clock += 31 * 60 * 1000;
    return (await controller.tick()).released;
  }

  return {
    call, controller, containers, dockerRuns, jobs, launch, secretStore, sleepIdle, startBodies,
    ledger: () => files.get("idle-sleeping") || { sleeping: [] },
    setLedger: (value) => files.set("idle-sleeping", structuredClone(value)),
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the start job");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("vLLM: sleep keeps the key, the guard holds, and the confirmed wake restarts with model, placement and key", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000 });
  assert.deepEqual(rig.secretStore.values(), [KEY]);

  const released = await rig.sleepIdle();
  assert.equal(released.length, 1);
  assert.equal(rig.containers.has(PRIMARY), false, "the idle container was stopped");
  const record = rig.ledger().sleeping[0];
  assert.deepEqual(record.placement, { instanceMode: "replace", instanceId: "qwen-a", containerName: PRIMARY });
  assert.equal(record.hasApiKey, true);
  assert.ok(record.secretRef);
  assert.equal(JSON.stringify(rig.ledger()).includes(KEY), false, "the ledger holds the ref only");
  // The container ref went with the stop; the wake ref is the only entry.
  assert.deepEqual(rig.secretStore.values(), [KEY]);
  assert.equal(rig.secretStore.get(record.secretRef), KEY);

  // Something else now owns the primary slot.
  await rig.launch({ model: "C:/store/Other", name: "other-model", apiKey: OTHER_KEY, port: 8000 });
  const refused = await rig.call("POST", "/api/idle-unload/primary/wake", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, "wake_would_replace_running");
  assert.deepEqual(refused.body.details, { runningModel: "other-model", runningContainer: PRIMARY });
  assert.match(refused.body.error, /Waking would replace the running model other-model/);
  assert.equal(rig.startBodies.length, 0, "a refused wake never reaches the launch handler");
  assert.equal(rig.containers.get(PRIMARY).labels["ai.manager.model"], "other-model");

  const woke = await rig.call("POST", "/api/idle-unload/primary/wake", { confirmReplace: true });
  assert.equal(woke.status, 200);
  assert.equal(woke.body.ok, true);
  assert.equal(woke.body.id, "primary");
  assert.equal(woke.body.model, "qwen-a");
  assert.ok(woke.body.job.id);

  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/Qwen-A");
  assert.equal(body.instanceMode, "replace");
  assert.equal(body.instanceId, "qwen-a");
  assert.equal(body.apiKey, KEY);
  const job = rig.jobs.find((item) => item.id === woke.body.job.id);
  await waitFor(() => job.status !== "running");
  assert.equal(job.status, "success");

  // The key reached the container through the docker child env, not argv.
  const run = rig.dockerRuns.at(-1);
  assert.equal(run.env.VLLM_API_KEY, KEY);
  assert.ok(run.args.includes("VLLM_API_KEY"));
  assert.ok(!run.args.some((arg) => String(arg).includes(KEY)));
  assert.equal(rig.containers.get(PRIMARY).labels["ai.manager.model"], "qwen-a");

  // The wake ref is released; the store holds only the new container's ref.
  assert.equal(rig.secretStore.get(record.secretRef), "");
  assert.deepEqual(rig.secretStore.values(), [KEY]);
  assert.equal(rig.ledger().sleeping.length, 0);
});

test("vLLM: a parallel instance wakes back into its own slot without a confirm", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/Main", name: "main-model", port: 8000 });
  await rig.launch({ model: "C:/store/Side", name: "side-model", instanceMode: "parallel", instanceId: "side", port: 8011, apiKey: KEY });
  // Only the side instance goes idle.
  await rig.controller.saveSettings({ enabled: true, idleMinutes: 30, excludeModels: ["main-model"] });
  const released = await rig.sleepIdle();
  assert.equal(released.length, 1);
  assert.equal(released[0].model, "side-model");
  assert.equal(rig.containers.has(`${PRIMARY}-side`), false);
  assert.ok(rig.containers.has(PRIMARY), "the primary model is untouched");

  const woke = await rig.call("POST", `/api/idle-unload/${encodeURIComponent(released[0].id)}/wake`, {});
  assert.equal(woke.status, 200);
  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/Side");
  assert.equal(body.instanceMode, "parallel");
  assert.equal(body.instanceId, "side");
  assert.equal(body.port, 8011);
  assert.equal(body.apiKey, KEY);
  await waitFor(() => rig.containers.has(`${PRIMARY}-side`));
  assert.equal(rig.containers.get(PRIMARY).labels["ai.manager.model"], "main-model");
});

test("vLLM: a key that cannot be captured skips sleep; a lost wake key answers 409", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000 });
  // The container's ref no longer resolves: releasing it would be one-way.
  const reference = rig.containers.get(PRIMARY).labels["ai.manager.api-key-ref"];
  await rig.secretStore.remove(reference);
  assert.deepEqual(await rig.sleepIdle(), []);
  assert.ok(rig.containers.get(PRIMARY).running, "the container keeps running");
  assert.equal(rig.ledger().sleeping.length, 0);

  // A wake whose stored key vanished (for example a restored store) is refused.
  const other = await createRig(t);
  await other.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000 });
  await other.sleepIdle();
  const record = other.ledger().sleeping[0];
  await other.secretStore.remove(record.secretRef);
  const refused = await other.call("POST", "/api/idle-unload/primary/wake", { confirmReplace: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "wake_api_key_missing");
  assert.equal(other.startBodies.length, 0);
});

test("vLLM: forget releases the wake key; a legacy record wakes under the guard", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000 });
  await rig.sleepIdle();
  const record = rig.ledger().sleeping[0];
  const forgotten = await rig.call("DELETE", "/api/idle-unload/primary");
  assert.equal(forgotten.status, 200);
  assert.equal(rig.secretStore.get(record.secretRef), "");
  assert.deepEqual(rig.secretStore.values(), []);

  // A record written before placement existed (no placement, secretRef or
  // hasApiKey), while another model runs in the primary slot.
  await rig.launch({ model: "C:/store/Other", name: "other-model", port: 8000 });
  rig.setLedger({
    version: 1,
    sleeping: [{ id: "legacy-1", model: "qwen-a", name: "/models/Qwen-A", config: { model: "C:/store/Qwen-A", name: "qwen-a", port: 8000 } }],
  });
  const refused = await rig.call("POST", "/api/idle-unload/legacy-1/wake", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "wake_would_replace_running");
  assert.equal(rig.startBodies.length, 0);

  const woke = await rig.call("POST", "/api/idle-unload/legacy-1/wake", { confirmReplace: true });
  assert.equal(woke.status, 200);
  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/Qwen-A");
  assert.equal(body.instanceMode, "replace");
  assert.equal(body.apiKey, "");
  await waitFor(() => rig.containers.get(PRIMARY)?.labels["ai.manager.model"] === "qwen-a");
});
