"use strict";

// vllm-manager starts through the shared runtime-supervisor (docs/overhaul/
// 01-engines.md §14, ENG-11): the vLLM run context (lib/run-context.js) runs
// on the real supervisor with a fake host, fake jobs and a fake wait, and
// the image stage on the real DockerHost.ensureImage over a fake docker
// runtime. Nothing is started, pulled or stopped.

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../../manager-core");
const jobUtils = require("../../manager-core/job-utils");
const { createRuntimeSupervisor } = require("../../manager-core/engines/runtime-supervisor");
const { createDockerHost } = require("../../manager-core/engines/hosts/docker");
const { PENNYROYAL_DEFAULTS, createPennyroyalPreset } = require("../lib/pennyroyal");
const {
  DEFAULT_STALL_TIMEOUT_MS,
  buildVllmImagePullOptions,
  createVllmRunContext,
  imagePullPolicyFor,
  vllmInstanceId,
  vllmStallTimeoutMs,
} = require("../lib/run-context");
const { DEFAULT_VLLM_RELEASE } = require("../lib/runtime-compatibility");

const IMAGE = `vllm/vllm-openai@sha256:${"a".repeat(64)}`;
const EXPERIMENTAL_IMAGE = "ghcr.io/fixture/experimental:tag";
const CONFIG = { containerName: "vllm-local", imagePlatform: "linux/amd64", managerId: "vllm-manager" };
const GPUS = [{ index: 0, id: "0", name: "Fixture GPU", computeCapability: "12.0", driverVersion: "610.47" }];

function fakeJobs() {
  return {
    create() {
      return jobUtils.createJobRecord("serve", "Start fixture", {});
    },
    api: {
      appendLog(job, text) {
        for (const line of String(text || "").split("\n")) if (line) job.logs.push(line);
      },
      setJobProgress(job, progress) { jobUtils.applyJobProgress(job, progress); },
      scheduleJobsSave() {},
      finishJob(job, meta) { jobUtils.markJobSuccess(job, { meta }); },
      failJob(job, error) { jobUtils.markJobFailed(job, error?.message || String(error)); },
    },
  };
}

// The host: ensureImage is the real DockerHost's over a fake docker runtime
// (image missing, pullImageWithRetry recorded); the rest are recording fakes.
function fakeHost({ present = false } = {}) {
  const calls = [];
  const runtime = {
    docker: async () => ({ stdout: "", stderr: "" }),
    async getImageStatus(image) {
      calls.push(["imageStatus", image]);
      return present ? { ok: true, text: image } : { ok: false, text: "missing", reason: "missing-image" };
    },
    async pullImageWithRetry(image, options) {
      calls.push(["pull", image, { attempts: options.attempts, initialDelayMs: options.initialDelayMs, platform: options.platform }]);
      options.onAttempt?.({ attempt: 1, attempts: options.attempts, image });
      options.onFailure?.({ attempt: 1, attempts: options.attempts, image, detail: "fixture timeout" });
      options.onAttempt?.({ attempt: 2, attempts: options.attempts, image });
      return { stdout: "pulled fixture", stderr: "" };
    },
  };
  const real = createDockerHost({ config: { dockerExe: "docker", dockerArgsPrefix: [], viaWsl: false }, runtime, managerLabelValue: CONFIG.managerId });
  const created = new Set();
  const host = {
    kind: "docker",
    ensureImage: real.ensureImage,
    async ready() { calls.push(["ready"]); return { ok: true, version: "27.0.0-fixture", started: false }; },
    async list() { calls.push(["list"]); return []; },
    async inspect(name) {
      calls.push(["inspect", name]);
      return created.has(name) ? { exists: true, running: true, labels: {} } : { exists: true, running: true, labels: { "ai.manager.gpu-admission-lease": "lease-old" } };
    },
    async checkpoint(name) {
      calls.push(["checkpoint", name]);
      return {
        hadPrevious: true,
        async commit() { calls.push(["checkpoint.commit"]); return { committed: true }; },
        async rollback() { calls.push(["checkpoint.rollback"]); return { rolledBack: true, restoredPrevious: true }; },
      };
    },
    async create(cmd) { calls.push(["create", cmd.name]); created.add(cmd.name); return { stdout: "cid\n" }; },
    async logs() { return ""; },
    async stop(name) { calls.push(["stop", name]); return { removed: true }; },
  };
  return { host, calls };
}

function fakeRegistry() {
  return {
    resolveRuntime(engineId, { image }) {
      if (image === EXPERIMENTAL_IMAGE) return { runtimeId: `${engineId}@experimental`, pullPolicy: "explicit" };
      if (image === IMAGE) return { runtimeId: `${engineId}@pinned`, pullPolicy: "auto" };
      throw Object.assign(new Error("unknown runtime"), { code: "unknown_runtime" });
    },
    get: (engineId) => ({ id: engineId, tier: 1, status: "stable" }),
  };
}

function runContextFactory(overrides = {}) {
  const logs = [];
  const factory = createVllmRunContext({
    CONFIG,
    env: {},
    appendLog: (job, text) => job.logs.push(String(text)),
    checkModelCompatibility: async () => ({ ok: true, findings: [] }),
    getGpuStatus: async () => ({ ok: true, gpus: GPUS }),
    previewRuntimePreset: (opts) => ({ id: "fixture-preset", engine: opts.engine || "vllm", image: opts.runtimeImage || IMAGE }),
    buildRuntimeCommand: (job, opts) => {
      logs.push(opts);
      const image = opts.runtimeImage || IMAGE;
      return { runArgs: ["run", "-d", "--name", opts.containerName || CONFIG.containerName, image], activePublishArgs: [], runtimeImage: image, secretEnv: {} };
    },
    knownRuntimeImageMetadata: (image) => (image === IMAGE ? { ...DEFAULT_VLLM_RELEASE } : null),
    stallMsForPreset: (preset) => core.engines.recipes.stallMsForPreset(preset),
    redactDockerArgs: (argv) => argv,
    dockerPublishArgs: () => ["127.0.0.1:8000:8000"],
    formatDockerPublishArgs: (args) => args.join(" "),
    extractLogIssues: () => [],
    registry: fakeRegistry(),
    ...overrides,
  });
  return { factory, builds: logs };
}

function supervisorFor(host, jobs, { waits = [], gpus = GPUS } = {}) {
  return createRuntimeSupervisor({
    managerId: CONFIG.managerId,
    containerBaseName: CONFIG.containerName,
    host,
    jobs: jobs.api,
    runtimeGatePolicy: "enforce",
    probes: { nvidiaCompatibility: async () => ({ ok: true, gpus }) },
    waitForRuntimeReady: async (options) => {
      waits.push(options);
      options.finishJob(options.job, { ready: true });
    },
    delay: async () => {},
  });
}

function startOptions(extra = {}) {
  return {
    model: "fixture/model",
    engine: "vllm",
    instanceMode: "replace",
    containerName: CONFIG.containerName,
    port: 18000,
    gpuDeviceIds: ["0"],
    runtimeApiKeyRef: "rk-fixture",
    networkAccess: "local",
    modelCompatibility: { ok: true, findings: [] },
    ...extra,
  };
}

test("vllm runs the supervisor with the hard runtime gate, fresh getters and the pull job wired", () => {
  const manager = require("../server");
  const { config } = manager.runtimeSupervisor;
  assert.equal(config.managerId, manager.CONFIG.managerId);
  assert.equal(config.runtimeGatePolicy, "enforce");
  assert.equal(config.hostKind, "docker");
  assert.equal(config.getters.containerStatus, manager.getContainerStatusFresh);
  assert.equal(config.getters.servedModels, manager.getServedModelsFresh);
  assert.equal(typeof manager.runtimeSupervisor.pullRuntime, "function");

  const run = manager.vllmRunContext(startOptions({ engine: "sglang", instanceMode: "parallel", containerName: "vllm-local-code", instanceId: "code", port: 18001 }));
  assert.equal(run.cleanup, "caller");
  assert.equal(run.engineId, "sglang");
  assert.equal(run.engineName, "SGLang");
  assert.equal(run.instanceId, "code");
  assert.equal(run.apiKeyRef, "rk-fixture");
  assert.equal(run.gate.errorCode, "vllm_runtime_incompatible");
  // The pinned default image of a stable tier-1 engine keeps today's implicit pull.
  assert.equal(run.imagePolicy(manager.CONFIG.image), "auto");
  assert.equal(vllmInstanceId(manager.CONFIG, manager.CONFIG.containerName, "ignored"), "primary");
  assert.deepEqual(manager.buildVllmImagePullOptions({}), { attempts: 3, initialDelayMs: 3000, platform: manager.CONFIG.imagePlatform });
});

test("the pull policy follows the registry: pinned tier-1 images auto, experimental runtimes explicit", () => {
  const registry = core.engines.getEngineRegistry();
  const pinned = registry.resolveRuntime("sglang", { runtimeId: "sglang@0.5.17" });
  const experimental = registry.resolveRuntime("sglang", { runtimeId: "sglang@flashnext-nvme-ple-20260831" });
  assert.equal(imagePullPolicyFor(registry, "sglang", pinned.image), "auto");
  assert.equal(imagePullPolicyFor(registry, "sglang", experimental.image), "explicit");
  // A custom image on a stable tier-1 engine is pulled as before.
  assert.equal(imagePullPolicyFor(registry, "vllm", "ghcr.io/fixture/custom-vllm:tag"), "auto");
});

test("a missing tier-1 image is pulled before the checkpoint with today's options and log lines", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const { factory } = runContextFactory();
  const supervisor = supervisorFor(host, jobs);
  const job = jobs.create();
  await supervisor.start({ job, run: factory(startOptions()) });

  assert.equal(job.status, "success");
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf("pull") >= 0, "the missing image was pulled");
  assert.ok(names.indexOf("pull") < names.indexOf("checkpoint"), "pull before the checkpoint");
  assert.ok(names.indexOf("checkpoint") < names.indexOf("create"));
  assert.deepEqual(calls.find(([name]) => name === "pull")[2], { attempts: 3, initialDelayMs: 3000, platform: "linux/amd64" });
  assert.ok(job.logs.includes(`Runtime image preflight: missing. Pulling before current model is stopped.`));
  assert.ok(job.logs.includes(`Docker image pull attempt 1/3: ${IMAGE}`));
  assert.ok(job.logs.includes("Docker image pull 1/3 failed: fixture timeout"));
  assert.ok(job.logs.includes("pulled fixture"));
});

test("an explicit-policy image fails with image_pull_required, is never pulled, and the old model is untouched", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const { factory } = runContextFactory();
  const supervisor = supervisorFor(host, jobs);
  const job = jobs.create();
  await assert.rejects(
    supervisor.start({ job, run: factory(startOptions({ runtimeImage: EXPERIMENTAL_IMAGE })) }),
    { code: "image_pull_required" },
  );
  assert.equal(job.status, "failed");
  assert.equal(job.failure.code, "image_pull_required");
  assert.equal(job.failure.phase, "pull");
  const names = calls.map(([name]) => name);
  assert.ok(!names.includes("pull"));
  assert.ok(!names.includes("checkpoint"));
  assert.ok(!names.includes("create"));
});

test("replace admission is acquired after prepare, and the admitted GPU is hard-checked again", async () => {
  const { host, calls } = fakeHost({ present: true });
  const jobs = fakeJobs();
  const { factory, builds } = runContextFactory();
  const supervisor = supervisorFor(host, jobs, { gpus: [...GPUS, { index: 1, id: "1", name: "Old GPU", computeCapability: "7.0", driverVersion: "610.47" }] });
  const opts = startOptions({ gpuDeviceIds: [], multiGpuMode: "single", gpuAdmissionRequest: { requestedMb: 1000 } });
  opts.prepareGpuAdmission = async (prepare) => {
    calls.push(["admission.acquireAfterPrepare"]);
    const context = await prepare(opts.gpuAdmissionRequest);
    // The controller admitted GPU 0; launch-request.js writes it back.
    opts.gpuDeviceIds = ["0"];
    calls.push(["admission.acquired"]);
    return context;
  };
  const job = jobs.create();
  await supervisor.start({ job, run: factory(opts) });
  assert.equal(job.status, "success", job.error);
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf("imageStatus") < names.indexOf("admission.acquireAfterPrepare"));
  assert.ok(names.indexOf("admission.acquireAfterPrepare") < names.indexOf("checkpoint"));
  assert.ok(names.indexOf("checkpoint") < names.indexOf("admission.acquired"));
  assert.ok(names.indexOf("admission.acquired") < names.indexOf("create"));
  // prepare retired the old container's lease.
  assert.deepEqual(opts.gpuAdmissionRequest.retireLeaseIds, ["lease-old"]);
  // The implicit selection passed the early gate; the rebuild sees the admitted GPU.
  assert.ok(job.logs.some((line) => line.includes("Automatic GPU candidate selection")));
  assert.ok(job.logs.some((line) => line.startsWith("Admitted GPU compatibility [ok]")));
  assert.deepEqual(builds.at(-1).gpuDeviceIds, ["0"]);
  assert.deepEqual(builds.at(-1).hostGpus.map((gpu) => gpu.id), ["0"]);
});

test("an incompatible GPU fails the gate with the vLLM error code before anything changes", async () => {
  const { host, calls } = fakeHost({ present: true });
  const jobs = fakeJobs();
  const { factory } = runContextFactory();
  const supervisor = supervisorFor(host, jobs, { gpus: [{ index: 0, id: "0", name: "Old GPU", computeCapability: "7.0", driverVersion: "610.47" }] });
  const job = jobs.create();
  await assert.rejects(supervisor.start({ job, run: factory(startOptions()) }), { code: "vllm_runtime_incompatible" });
  assert.equal(job.failure.code, "vllm_runtime_incompatible");
  assert.ok(!calls.some(([name]) => ["checkpoint", "create", "pull"].includes(name)));
});

test("the model and preset preflight fail the job before Docker is touched", async () => {
  const { host, calls } = fakeHost({ present: true });
  const jobs = fakeJobs();
  const { factory } = runContextFactory({
    checkModelCompatibility: async () => ({ ok: false, findings: [{ severity: "fail", title: "Muse Glimmer 尚不支持 vLLM", detail: "Use llama-manager.", errorCode: "muse_glimmer_vllm_unsupported" }] }),
  });
  const supervisor = supervisorFor(host, jobs);
  const job = jobs.create();
  await assert.rejects(supervisor.start({ job, run: factory(startOptions({ modelCompatibility: null })) }), { code: "muse_glimmer_vllm_unsupported" });
  assert.equal(job.progress.stage, "模型预检失败");
  assert.deepEqual(calls, []);

  const blocked = runContextFactory({ previewRuntimePreset: () => ({ id: "blocked", engine: "vllm", unsupportedReason: "Not on this host." }) });
  const job2 = jobs.create();
  await assert.rejects(supervisor.start({ job: job2, run: blocked.factory(startOptions()) }), { code: "runtime_preset_unsupported" });
  assert.ok(job2.logs.includes("Runtime preset blocked: blocked"));
  assert.deepEqual(calls, []);
});

test("the Pennyroyal stall timeout is 30 minutes from its recipe, other presets keep 10 minutes", async () => {
  const preset = createPennyroyalPreset(PENNYROYAL_DEFAULTS);
  const stallMsForPreset = (value) => core.engines.recipes.stallMsForPreset(value);
  assert.equal(vllmStallTimeoutMs(preset, { env: {}, stallMsForPreset }), 30 * 60 * 1000);
  assert.equal(vllmStallTimeoutMs({ id: "fixture-preset" }, { env: {}, stallMsForPreset }), DEFAULT_STALL_TIMEOUT_MS);
  assert.equal(vllmStallTimeoutMs(preset, { env: { VLLM_START_STALL_TIMEOUT_MS: "120000" }, stallMsForPreset }), 120000);

  // The supervisor hands the recipe's stall limit to the wait.
  const { host } = fakeHost({ present: true });
  const jobs = fakeJobs();
  const { factory } = runContextFactory({ previewRuntimePreset: () => preset });
  const waits = [];
  const supervisor = supervisorFor(host, jobs, { waits });
  const job = jobs.create();
  await supervisor.start({ job, run: factory(startOptions({ engine: "sglang" })) });
  assert.equal(waits[0].stallTimeoutMs, 30 * 60 * 1000);
  assert.equal(waits[0].engineName, "SGLang");
  assert.equal(job.status, "success");
});

test("image pull options keep the configured platform and retry settings", () => {
  assert.deepEqual(buildVllmImagePullOptions({ VLLM_IMAGE_PULL_RETRIES: "4", VLLM_IMAGE_PULL_RETRY_DELAY_MS: "1250" }, "linux/amd64"), {
    attempts: 4,
    initialDelayMs: 1250,
    platform: "linux/amd64",
  });
});
