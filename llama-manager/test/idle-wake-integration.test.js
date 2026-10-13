"use strict";

// Idle sleep -> wake end to end (docs/overhaul/08-p0-fixes.md P0-1). The
// controller runs with the shared wake hooks and the real llama.cpp launch
// handler (createLlamaStartRuntimeRequest) over a fake docker and a fake GPU
// admission. Assertions go only through the hook interface, the wake route and
// the start body that reaches the launch handler, so 01 ENG-8 can run this
// unchanged.

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const core = require("../../manager-core");
const { createLlamaStartRuntimeRequest } = require("../lib/launch-request");
const { createLlamaRuntimeCommandBuilder } = require("../lib/runtime-command");

const MANAGER_ID = "llama-manager";
const PRIMARY = "llama-local";
const KEY = "fixture-llama-wake-key-0123456789";

function labelsFromArgs(args) {
  const labels = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, ...rest] = String(args[index + 1]).split("=");
    labels[key] = rest.join("=");
  }
  return labels;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the start job");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createRig(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "llama-idle-wake-"));
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
    const reference = container.labels["ai.manager.api-key-ref"];
    if (reference) await secretStore.remove(reference);
  };

  const { buildLlamaRuntimeCommand } = createLlamaRuntimeCommandBuilder({
    CONFIG: { containerName: PRIMARY, managerId: MANAGER_ID, hfCache: "C:/cache/hf", modelsRoot: "C:/store", image: "llama:fixture" },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {},
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8080`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    normalizeDefaultTrueBoolean: (value) => value !== false,
    windowsPathToContainerPath: (value) => String(value).replace(/^C:\/store/i, "/models"),
    resolveLaunchModel: (model) => ({ modelArg: String(model).replace(/^C:\/store/i, "/models"), effectiveLoadFormat: "gguf", ggufFiles: [] }),
  });

  const jobs = [];
  const recentLaunches = [];
  const fakeLease = (request) => ({
    summary: { id: `lease-${request.containerName}`, requestedTotalMb: 2000, reservations: [] },
    commit: async () => {},
    release: async () => {},
    startHeartbeat: () => () => {},
  });
  const realStart = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: PRIMARY, managerId: MANAGER_ID },
    cleanRequired: (value, name) => {
      const text = String(value || "").trim();
      if (!text) throw Object.assign(new Error(`${name} is required`), { status: 400 });
      return text;
    },
    deriveName: (model) => path.posix.basename(String(model)).replace(/\.gguf$/i, "").toLowerCase(),
    positiveInt: (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback),
    normalizeGpuLayers: (value) => (value == null || value === "" ? -1 : value),
    normalizeLlamaCacheType: (value) => value || "f16",
    normalizeOnOffAuto: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    normalizeLlamaSplitMode: (value) => value || "layer",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeClientPreset: (value) => value || "openai",
    normalizeLlamaReasoningFormat: (value) => value || "auto",
    normalizeDefaultTrueBoolean: (value) => value !== false,
    normalizeNetworkAccess: (value) => (value === "lan" ? "lan" : "local"),
    getLanAddress: () => "127.0.0.1",
    getGpuStatus: async () => ({ gpus: [{ id: "0" }] }),
    buildLlamaGpuPlan: () => ({ mainGpu: 0, mainGpuHostId: "0" }),
    suggestTensorSplit: () => "",
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
      const { runArgs, secretEnv } = buildLlamaRuntimeCommand(job, runOptions);
      if (previous) await removeContainer(runOptions.containerName);
      await core.dockerRunWithRetries({
        docker,
        runArgs,
        dockerOptions: { env: core.buildDockerChildEnv(secretEnv, { viaWsl: false, baseEnv: {} }) },
      });
      job.status = "success";
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
    estimateParallelVram: async () => ({ requestedMb: 2000, estimatePolicy: "fixture_estimate" }),
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
    engine: "llama",
    readJsonFile,
    writeJsonFile,
    listInstances: async () => [...containers.values()].filter((item) => item.running).map((item) => ({
      id: item.name === PRIMARY ? "primary" : item.labels["ai.manager.instance"],
      containerName: item.name,
      model: item.labels["ai.manager.model"],
      name: item.name,
      running: true,
      requestsTotal: 3,
      activeRequests: 0,
      queuedRequests: 0,
      vramReservationMb: 2000,
      instanceMode: item.name === PRIMARY ? "replace" : item.labels["ai.manager.instance-mode"],
      launchConfig: null,
    })),
    stopInstance: (instance) => removeContainer(instance.containerName),
    now: () => clock,
    log: () => {},
    ...hooks,
  });

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

  async function sleepIdle(settings = {}) {
    await controller.saveSettings({ enabled: true, idleMinutes: 30, ...settings });
    await controller.tick();
    clock += 31 * 60 * 1000;
    return (await controller.tick()).released;
  }

  return {
    call, containers, dockerRuns, jobs, launch, secretStore, sleepIdle, startBodies,
    ledger: () => files.get("idle-sleeping") || { sleeping: [] },
  };
}

test("llama: sleep keeps the key, the guard holds, and the confirmed wake restarts with model, placement and key", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/qwen-a.gguf", name: "qwen-a", apiKey: KEY, port: 8080 });
  assert.equal(rig.dockerRuns.at(-1).env.LLAMA_API_KEY, KEY);

  assert.equal((await rig.sleepIdle()).length, 1);
  assert.equal(rig.containers.has(PRIMARY), false);
  const record = rig.ledger().sleeping[0];
  assert.deepEqual(record.placement, { instanceMode: "replace", instanceId: "qwen-a", containerName: PRIMARY });
  assert.equal(record.hasApiKey, true);
  assert.deepEqual(rig.secretStore.values(), [KEY]);
  assert.equal(rig.secretStore.get(record.secretRef), KEY);

  await rig.launch({ model: "C:/store/other.gguf", name: "other-model", port: 8080 });
  const refused = await rig.call("POST", "/api/idle-unload/primary/wake", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "wake_would_replace_running");
  assert.deepEqual(refused.body.details, { runningModel: "other-model", runningContainer: PRIMARY });
  assert.equal(rig.startBodies.length, 0);

  const woke = await rig.call("POST", "/api/idle-unload/primary/wake", { confirmReplace: true });
  assert.equal(woke.status, 200);
  assert.equal(woke.body.model, "qwen-a");
  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/qwen-a.gguf");
  assert.equal(body.instanceMode, "replace");
  assert.equal(body.instanceId, "qwen-a");
  assert.equal(body.apiKey, KEY);
  const job = rig.jobs.find((item) => item.id === woke.body.job.id);
  await waitFor(() => job.status !== "running");

  const run = rig.dockerRuns.at(-1);
  assert.equal(run.env.LLAMA_API_KEY, KEY);
  assert.ok(!run.args.some((arg) => String(arg).includes(KEY)));
  assert.equal(rig.secretStore.get(record.secretRef), "");
  assert.deepEqual(rig.secretStore.values(), [KEY]);
});

test("llama: a parallel instance wakes into its own slot; a missing key is refused", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/main.gguf", name: "main-model", port: 8080 });
  await rig.launch({ model: "C:/store/side.gguf", name: "side-model", instanceMode: "parallel", instanceId: "side", port: 8091, apiKey: KEY });
  const released = await rig.sleepIdle({ excludeModels: ["main-model"] });
  assert.equal(released.length, 1);
  const record = rig.ledger().sleeping[0];
  assert.deepEqual(record.placement, { instanceMode: "parallel", instanceId: "side", containerName: `${PRIMARY}-side` });

  const woke = await rig.call("POST", `/api/idle-unload/${encodeURIComponent(record.id)}/wake`, {});
  assert.equal(woke.status, 200);
  const body = rig.startBodies.at(-1);
  assert.equal(body.instanceMode, "parallel");
  assert.equal(body.instanceId, "side");
  assert.equal(body.port, 8091);
  assert.equal(body.apiKey, KEY);
  await waitFor(() => rig.containers.has(`${PRIMARY}-side`));
  assert.equal(rig.containers.get(PRIMARY).labels["ai.manager.model"], "main-model");

  // Sleep it again and lose the stored key: the wake answers 409.
  const again = await rig.sleepIdle({ excludeModels: ["main-model"] });
  assert.equal(again.length, 1);
  await rig.secretStore.remove(rig.ledger().sleeping[0].secretRef);
  const refused = await rig.call("POST", `/api/idle-unload/${encodeURIComponent(again[0].id)}/wake`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "wake_api_key_missing");
});

test("llama: a key that cannot be captured skips sleep and keeps the container", async (t) => {
  const rig = await createRig(t);
  await rig.launch({ model: "C:/store/qwen-a.gguf", name: "qwen-a", apiKey: KEY, port: 8080 });
  await rig.secretStore.remove(rig.containers.get(PRIMARY).labels["ai.manager.api-key-ref"]);
  assert.deepEqual(await rig.sleepIdle(), []);
  assert.ok(rig.containers.get(PRIMARY).running);
  assert.equal(rig.ledger().sleeping.length, 0);
});
