"use strict";

// Idle sleep -> wake over LaunchStore (01-engines §15.3, ENG-8). The real
// idle-unload controller and wake hooks run with a LaunchStore, the real vLLM
// launch handler (createVllmStartRuntimeRequest) and the real command builder,
// over a fake docker and a fake GPU admission. runStartJob does what the
// server's start path does with the store: beginLaunch before the build,
// recordCommand after it, and the ready mark from recordRecentLaunch.
// P0-RT-2's own tests (idle-unload.test.js, both idle-wake-integration.test.js)
// run unchanged next to this file.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../index");
const { createVllmStartRuntimeRequest } = require("../../vllm-manager/lib/launch-request");
const { createVllmRuntimeCommandBuilder } = require("../../vllm-manager/lib/runtime-command");

const MANAGER_ID = "vllm-manager";
const PRIMARY = "vllm-local";
const KEY = "fixture-engines-wake-key-0123456789";
const LAUNCH_LABEL = "ai.manager.launch-id";

function labelsFromArgs(args) {
  const labels = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, ...rest] = String(args[index + 1]).split("=");
    labels[key] = rest.join("=");
  }
  return labels;
}

// The argv with the per-launch values (job id, launch id, key ref) blanked.
function comparableArgv(args) {
  return args.map((arg) => String(arg).replace(/^(ai\.manager\.(?:job|launch-id|api-key-ref))=.*$/, "$1=*"));
}

function normalizeLaunchConfig(config = {}) {
  return {
    model: String(config.model || ""),
    engine: String(config.engine || "vllm"),
    name: String(config.name || ""),
    port: Number(config.port || 8000),
    maxModelLen: Number(config.maxModelLen || 8192),
    maxNumSeqs: Number(config.maxNumSeqs || 4),
  };
}

async function createRig(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "engines-idle-wake-"));
  const secretStore = core.createRuntimeSecretStore({ file: path.join(root, "runtime-api-keys.json") });
  const storeFile = path.join(root, "launch-store.json");
  const toContainerPath = (value) => String(value).replace(/^C:\/store/i, "/models");
  const launchStore = core.engines.createLaunchStore({
    file: storeFile,
    managerId: MANAGER_ID,
    normalizeConfig: normalizeLaunchConfig,
    toContainerPath,
    secretValues: () => secretStore.values(),
  });
  t.after(async () => {
    await launchStore.flush();
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const files = new Map();
  const readJsonFile = async (file, fallback) => (files.has(file) ? structuredClone(files.get(file)) : fallback);
  const writeJsonFile = async (file, value) => { files.set(file, structuredClone(value)); };

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
    windowsPathToContainerPath: toContainerPath,
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: (model) => ({ modelArg: toContainerPath(model), effectiveLoadFormat: "auto", localPath: model }),
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
      launchStore.beginLaunch(job, runOptions);
      if (typeof runOptions.prepareGpuAdmission === "function") {
        await runOptions.prepareGpuAdmission(async () => ({ prepared: true }));
      }
      const previous = containers.get(runOptions.containerName);
      const { runArgs, secretEnv } = buildVllmRuntimeCommand(job, runOptions);
      launchStore.recordCommand(job.meta.launchId, runArgs);
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
        config: normalizeLaunchConfig(meta),
      });
      launchStore.markStatus(meta.launchId, "running", { event: "ready", patch: { containerName: meta.containerName } });
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
    toContainerPath,
    launchStore,
    jobsLedgerLookup: (jobId) => jobs.find((job) => job.id === jobId) || null,
  });
  const controller = core.createIdleUnloadController({
    settingsFile: "idle-settings",
    sleepFile: "idle-sleeping",
    engine: "vllm",
    readJsonFile,
    writeJsonFile,
    // As the server maps /api/instances: no labels; the hooks read them.
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

  async function launch(body) {
    const { job } = await realStart({ body });
    await waitFor(() => job.status !== "running");
    assert.equal(job.status, "success", job.error);
    return job;
  }

  async function sleepIdle(excludeModels = []) {
    await controller.saveSettings({ enabled: true, idleMinutes: 30, excludeModels });
    await controller.tick();
    clock += 31 * 60 * 1000;
    return (await controller.tick()).released;
  }

  return {
    containers, controller, dockerRuns, jobs, launch, launchStore, recentLaunches, secretStore, sleepIdle, startBodies, storeFile,
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

test("sleep records the LaunchSpec and wake starts a job with identical argv", async (t) => {
  const rig = await createRig(t);
  const first = await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000, maxModelLen: 32768 });
  const launchId = first.meta.launchId;
  assert.match(launchId, core.engines.launchStore.LAUNCH_ID_PATTERN);
  const labels = rig.containers.get(PRIMARY).labels;
  assert.equal(labels[LAUNCH_LABEL], launchId);
  assert.equal(labels["ai.manager.engine-id"], "vllm");
  assert.equal(labels["ai.manager.recipe"], "");
  assert.equal(rig.launchStore.get(launchId).status, "running");
  const firstArgv = rig.dockerRuns.at(-1).args;

  const released = await rig.sleepIdle();
  assert.equal(released.length, 1);
  const record = rig.ledger().sleeping[0];
  assert.equal(record.launchId, launchId);
  assert.equal(record.spec.model.ref, "C:/store/Qwen-A");
  assert.equal(record.spec.values.contextLength, 32768);
  assert.match(record.secretRef, /^wake-/, "the wake copy lives under a wake-* ref");
  assert.equal(record.spec.secrets.apiKeyRef, record.secretRef);
  assert.deepEqual(record.placement, { instanceMode: "replace", instanceId: "qwen-a", containerName: PRIMARY });
  // Old controllers keep reading the flat config.
  assert.equal(record.config.model, "C:/store/Qwen-A");
  assert.equal(record.config.maxModelLen, 32768);
  const sleeping = rig.launchStore.get(launchId);
  assert.equal(sleeping.status, "sleeping");
  assert.equal(sleeping.spec.secrets.apiKeyRef, record.secretRef);
  assert.equal(sleeping.history.at(-1).event, "slept");
  assert.equal(rig.secretStore.get(record.secretRef), KEY);
  const listed = (await rig.controller.listSleeping()).sleeping[0];
  assert.equal(listed.launchId, launchId);
  assert.equal(listed.spec, undefined);

  const woke = await rig.controller.wake(record.id);
  assert.equal(woke.ok, true);
  const job = rig.jobs.find((item) => item.id === woke.job.id);
  await waitFor(() => job.status !== "running");
  assert.equal(job.status, "success", job.error);
  const body = rig.startBodies.at(-1);
  assert.equal(body.apiKey, KEY);
  assert.equal(body.instanceMode, "replace");
  assert.deepEqual(comparableArgv(rig.dockerRuns.at(-1).args), comparableArgv(firstArgv), "the wake runs the same command");
  assert.equal(rig.dockerRuns.at(-1).env.VLLM_API_KEY, KEY);

  const relaunched = job.meta.launchId;
  assert.notEqual(relaunched, launchId);
  assert.equal(rig.containers.get(PRIMARY).labels[LAUNCH_LABEL], relaunched);
  assert.equal(rig.launchStore.get(relaunched).status, "running");
  const old = rig.launchStore.get(launchId);
  assert.equal(old.status, "stopped");
  assert.equal(old.spec.secrets.apiKeyRef, "");
  assert.ok(old.history.some((entry) => entry.event === "woken"));
  // The wake ref was released after the successful wake.
  assert.equal(rig.secretStore.get(record.secretRef), "");
  assert.deepEqual(rig.secretStore.values(), [KEY]);

  await rig.launchStore.flush();
  const text = fs.readFileSync(rig.storeFile, "utf8");
  assert.equal(text.includes(KEY), false, "no plaintext key in the store");
  assert.equal(text.includes("calibrations"), false);
});

test("a labelled container resolves by launch-id before P0's matching order", async (t) => {
  const rig = await createRig(t);
  const job = await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", port: 8000 });
  // A newer recent-launch entry that P0's container-name match would pick.
  rig.recentLaunches.unshift({
    model: "C:/store/Wrong", name: "qwen-a", containerName: PRIMARY, instanceMode: "replace", instanceId: "qwen-a",
    config: { model: "C:/store/Wrong", name: "qwen-a", port: 8999 },
  });
  await rig.sleepIdle();
  const record = rig.ledger().sleeping[0];
  assert.equal(record.launchId, job.meta.launchId);
  assert.equal(record.config.model, "C:/store/Qwen-A");
  assert.equal(record.config.port, 8000);

  const woke = await rig.controller.wake(record.id);
  const wakeJob = rig.jobs.find((item) => item.id === woke.job.id);
  await waitFor(() => wakeJob.status !== "running");
  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/Qwen-A");
  assert.equal(body.port, 8000);
});

test("a legacy flat sleep record without launchId or spec still wakes", async (t) => {
  const rig = await createRig(t);
  rig.setLedger({
    version: 1,
    sleeping: [{ id: "legacy-1", model: "qwen-a", name: "/models/Qwen-A", config: { model: "C:/store/Qwen-A", name: "qwen-a", port: 8000 } }],
  });
  const woke = await rig.controller.wake("legacy-1");
  assert.equal(woke.ok, true);
  const job = rig.jobs.find((item) => item.id === woke.job.id);
  await waitFor(() => job.status !== "running");
  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/Qwen-A");
  assert.equal(body.instanceMode, "replace");
  assert.equal(body.apiKey, "");
  await waitFor(() => rig.containers.get(PRIMARY)?.labels["ai.manager.model"] === "qwen-a");
  assert.equal(rig.ledger().sleeping.length, 0);
});

test("containers started by older code are adopted: recent launch, jobs ledger, and a partial one is kept running", async (t) => {
  const rig = await createRig(t);
  // Old-style containers: no launch-id label.
  rig.containers.set(PRIMARY, {
    name: PRIMARY, exists: true, running: true,
    labels: { "ai.manager": MANAGER_ID, "ai.manager.model": "old-a", "ai.manager.job": "job-gone" },
  });
  rig.recentLaunches.push({ model: "C:/store/Old-A", name: "old-a", config: { model: "C:/store/Old-A", name: "old-a", port: 8000 } });
  rig.jobs.push({ id: "job-old-b", type: "serve", status: "success", meta: { model: "C:/store/Old-B", name: "old-b", engine: "vllm", port: 8021, maxModelLen: 16384, maxNumSeqs: 2, instanceMode: "parallel", instanceId: "b", containerName: `${PRIMARY}-b` } });
  rig.containers.set(`${PRIMARY}-b`, {
    name: `${PRIMARY}-b`, exists: true, running: true,
    labels: { "ai.manager": MANAGER_ID, "ai.manager.model": "old-b", "ai.manager.job": "job-old-b", "ai.manager.instance": "b", "ai.manager.instance-mode": "parallel" },
  });
  rig.containers.set(`${PRIMARY}-c`, {
    name: `${PRIMARY}-c`, exists: true, running: true,
    labels: { "ai.manager": MANAGER_ID, "ai.manager.model": "old-c", "ai.manager.instance": "c", "ai.manager.instance-mode": "parallel", "ai.manager.max-model-len": "4096" },
  });

  const released = await rig.sleepIdle();
  assert.deepEqual(released.map((item) => item.model).sort(), ["old-a", "old-b"]);
  assert.ok(rig.containers.has(`${PRIMARY}-c`), "a partial launch is not released");

  const ledger = rig.ledger().sleeping;
  const a = ledger.find((item) => item.model === "old-a");
  const b = ledger.find((item) => item.model === "old-b");
  assert.equal(a.config.model, "C:/store/Old-A", "the recent-launch config itself");
  assert.equal(b.config.model, "C:/store/Old-B");
  assert.equal(b.config.port, 8021);
  assert.equal(b.config.maxModelLen, 16384);
  assert.deepEqual(b.placement, { instanceMode: "parallel", instanceId: "b", containerName: `${PRIMARY}-b` });
  for (const item of [a, b]) {
    const adopted = rig.launchStore.get(item.launchId);
    assert.equal(adopted.source, "adopted");
    assert.equal(adopted.status, "sleeping");
  }

  const woke = await rig.controller.wake(b.id);
  const wakeJob = rig.jobs.find((item) => item.id === woke.job.id);
  await waitFor(() => wakeJob.status !== "running");
  const body = rig.startBodies.at(-1);
  assert.equal(body.model, "C:/store/Old-B");
  assert.equal(body.instanceMode, "parallel");
  assert.equal(body.instanceId, "b");
  assert.equal(body.port, 8021);
});

test("api_key_unavailable skips sleep and keeps the container; the record stays running", async (t) => {
  const rig = await createRig(t);
  const job = await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000 });
  await rig.secretStore.remove(rig.containers.get(PRIMARY).labels["ai.manager.api-key-ref"]);
  assert.deepEqual(await rig.sleepIdle(), []);
  assert.ok(rig.containers.get(PRIMARY).running);
  assert.equal(rig.ledger().sleeping.length, 0);
  assert.equal(rig.launchStore.get(job.meta.launchId).status, "running");
});

test("forget releases the wake ref and stops the LaunchStore record", async (t) => {
  const rig = await createRig(t);
  const job = await rig.launch({ model: "C:/store/Qwen-A", name: "qwen-a", apiKey: KEY, port: 8000 });
  await rig.sleepIdle();
  const record = rig.ledger().sleeping[0];
  assert.equal((await rig.controller.forget(record.id)).ok, true);
  assert.equal(rig.secretStore.get(record.secretRef), "");
  const stopped = rig.launchStore.get(job.meta.launchId);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.spec.secrets.apiKeyRef, "");
});
