"use strict";

// docker-template engines through vllm-manager (docs/overhaul/01-engines.md
// §19, ENG-18): the real launch handler (createVllmStartRuntimeRequest), the real
// command builder and the real planner over a fake host. Nothing talks to docker,
// pulls an image, or touches a live data directory: the AI root is a temp dir and
// docker is a recording fake.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-template-wiring-"));
process.env.AI_ROOT = ROOT;
process.env.AI_REFERENCE_DATA_DIR = ROOT;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const core = require("../../manager-core");
const jobUtils = require("../../manager-core/job-utils");
const { createRuntimeSupervisor } = require("../../manager-core/engines/runtime-supervisor");
const { createVllmStartRuntimeRequest } = require("../lib/launch-request");
const { createVllmRuntimeCommandBuilder, normalizeRuntimeEngine, templateEngineOf } = require("../lib/runtime-command");
const { createVllmRunContext } = require("../lib/run-context");

const MANAGER_ID = "vllm-manager";
const PRIMARY = "vllm-local";
const MODEL = "C:/store/exl3-model";
const KEY = "fixture-template-key-0123456789";
const ACK = ["experimental-engine"];

function labelsFromArgs(args) {
  const labels = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, ...rest] = String(args[index + 1]).split("=");
    labels[key] = rest.join("=");
  }
  return labels;
}

function toContainerPath(value) {
  const text = String(value);
  if (/^\/models(\/|$)/.test(text)) return text;
  if (!/^C:\/store(\/|$)/i.test(text)) throw new Error(`outside the model storage: ${text}`);
  return text.replace(/^C:\/store/i, "/models");
}

function createRig({ imagePresent = false, platform = process.platform } = {}) {
  const root = fs.mkdtempSync(path.join(ROOT, "rig-"));
  const registry = core.engines.createEngineRegistry({ overrideDir: path.join(root, "no-overrides"), env: {} });
  const aclCalls = [];
  const launchFiles = core.engines.createLaunchFiles({
    root,
    platform,
    env: { USERNAME: "fixture-user", USERDOMAIN: "FIXTURE" },
    execFile: async (file, args) => { aclCalls.push([file, ...args]); return { stdout: "", stderr: "" }; },
  });
  const builder = createVllmRuntimeCommandBuilder({
    CONFIG: { containerName: PRIMARY, managerId: MANAGER_ID, hfCache: "C:/cache/hf", modelsRoot: "C:/store", image: "vllm/fixture:pinned" },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: (job, line) => { job.logs.push(line); },
    scheduleJobsSave: () => {},
    dockerGpuArg: (ids) => (ids.length ? `device=${ids.join(",")}` : "all"),
    dockerPublishArgs: (port, access, host, containerPort = 8000) => [`127.0.0.1:${port}:${containerPort}`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: toContainerPath,
    normalizeGpuIds: (value) => (Array.isArray(value) ? value.map(String) : []),
    getLanAddress: () => "192.0.2.10",
    resolveLaunchModel: (model) => ({ modelArg: toContainerPath(model), effectiveLoadFormat: "auto", localPath: model }),
    effectiveLaunchQuantization: () => ({ value: "", modelConfigMethod: "" }),
    resolveVllmRuntimePreset: () => ({}),
    engineRegistry: registry,
    launchFiles,
  });
  const jobs = [];
  const builds = [];
  const dockerCalls = [];
  const secrets = new Map();
  const start = createVllmStartRuntimeRequest({
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
    normalizeNetworkAccess: core.normalizeNetworkAccess || ((value) => (value === "lan" ? "lan" : "local")),
    normalizeRuntimeEngine: (value) => normalizeRuntimeEngine(value, registry),
    templateEngineFor: (engineId) => templateEngineOf(registry, engineId),
    getEngineRegistry: () => registry,
    getLanAddress: () => "192.0.2.10",
    // The server's: a path outside every model storage root is a 400.
    resolveRequestedModel: (value) => {
      try {
        toContainerPath(value);
      } catch (error) {
        throw Object.assign(error, { status: 400, code: "model_outside_storage" });
      }
      return String(value);
    },
    createJob: (type, title, meta) => {
      const job = jobUtils.createJobRecord(type, title, meta);
      jobs.push(job);
      return job;
    },
    runStartJob: async (job, runOptions) => {
      // The supervisor's LaunchStore mints this before the first build.
      job.meta.launchId = `lch_wiring${String(builds.length + 1).padStart(4, "0")}`;
      const built = builder.buildVllmRuntimeCommand(job, runOptions);
      builds.push({ job, runOptions, built });
      job.status = "success";
    },
    failJob: (job, error) => { job.status = "failed"; job.error = error.message; },
    saveRuntimeApiKey: async (apiKey) => { const ref = `ref-${secrets.size + 1}`; secrets.set(ref, apiKey); return ref; },
    deleteRuntimeApiKey: async (ref) => { secrets.delete(ref); },
    normalizeRuntimeInstanceMode: core.normalizeRuntimeInstanceMode,
    normalizeRuntimeInstanceId: core.normalizeRuntimeInstanceId,
    buildRuntimeContainerName: core.buildRuntimeContainerName,
    prepareLaunchCommand: (runOptions, { jobId, launchId }) => builder.prepareLaunch({ id: jobId, meta: { launchId } }, { ...runOptions, launchId }),
    getHostGpus: async () => [{ id: "0", index: 0, name: "Fixture GPU", computeCapability: "12.0", driverVersion: "610.47", totalMb: 97887, usedMb: 600 }],
    imagePresence: (image) => { dockerCalls.push(["imagePresence", image]); return imagePresent; },
    listContainers: async () => [],
  });
  return { root, registry, launchFiles, builder, start, jobs, builds, dockerCalls, secrets, aclCalls };
}

// The launch handler runs the job on a later tick.
async function flush() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const LAUNCH = { model: MODEL, port: 8010, acknowledge: ACK, maxModelLen: 8192, maxNumSeqs: 4 };

test("the three engines are registered as experimental, hosted by vllm-manager", () => {
  const rig = createRig();
  assert.deepEqual(rig.registry.errors(), []);
  assert.deepEqual(rig.registry.hostedBy("vllm"), ["vllm", "sglang", "lmdeploy", "tabbyapi", "trtllm"]);
  for (const id of ["lmdeploy", "trtllm", "tabbyapi"]) {
    const descriptor = rig.registry.get(id);
    assert.equal(descriptor.status, "experimental", id);
    assert.equal(descriptor.adapter, "docker-template", id);
    assert.equal(descriptor.hostManager, "vllm", id);
    assert.equal(rig.registry.defaultRuntime(id).status, "unpinned", id);
    assert.equal(rig.registry.defaultRuntime(id).pullPolicy, "explicit", id);
    assert.equal(normalizeRuntimeEngine(id, rig.registry), id, id);
  }
});

test("a launch without the acknowledgement is 400 experimental_ack_required and builds nothing", async () => {
  const rig = createRig({ imagePresent: true });
  const { acknowledge: _drop, ...body } = LAUNCH;
  await assert.rejects(() => rig.start({ body: { ...body, engine: "lmdeploy" } }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "experimental_ack_required");
    return true;
  });
  assert.equal(rig.jobs.length, 0, "no job was created");
  assert.deepEqual(rig.dockerCalls, []);
  // The v2 spelling answers the same.
  await assert.rejects(() => rig.start({ body: { engineId: "lmdeploy", model: { ref: MODEL }, instance: { port: 8010 } } }), (error) => error.code === "experimental_ack_required" && error.status === 400);
});

test("a missing image is blocker image_pull_required (409) and is never pulled implicitly", async () => {
  const rig = createRig({ imagePresent: false });
  const plan = await rig.start.planLaunch({ ...LAUNCH, engine: "lmdeploy" });
  assert.equal(plan.ok, false);
  const pull = plan.steps.find((step) => step.kind === "pull");
  assert.deepEqual({ policy: pull.policy, required: pull.required, runtimeId: pull.runtimeId }, { policy: "explicit", required: true, runtimeId: "lmdeploy@0.18.0" });
  const blocker = plan.blockers.find((item) => item.code === "image_pull_required");
  assert.ok(blocker, JSON.stringify(plan.blockers));
  assert.equal(blocker.action.apiCall.path, "/api/runtimes/lmdeploy%400.18.0/pull");
  assert.deepEqual(blocker.action.apiCall.body, { confirm: true });
  await assert.rejects(() => rig.start({ body: { ...LAUNCH, engine: "lmdeploy" } }), (error) => error.status === 409 && error.code === "image_pull_required");
  assert.equal(rig.jobs.length, 0);
  assert.equal(rig.builds.length, 0);
});

test("a plan renders the lmdeploy command from the descriptor template", async () => {
  const rig = createRig({ imagePresent: true });
  const plan = await rig.start.planLaunch({
    engineId: "lmdeploy",
    acknowledge: ACK,
    model: { ref: MODEL, servedName: "served-a" },
    instance: { port: 8010, gpuIds: ["0"] },
    values: { contextLength: 16384, concurrency: 8, "lmdeploy.cacheMaxEntryCount": 0.6, "lmdeploy.backend": "pytorch" },
  });
  assert.equal(plan.ok, true, JSON.stringify([plan.errors, plan.blockers]));
  const argv = plan.command.argv;
  const tail = argv.slice(argv.indexOf("lmdeploy:v0.18.0") === -1 ? argv.indexOf("openmmlab/lmdeploy:v0.18.0") + 1 : 0);
  assert.deepEqual(tail, [
    "serve", "api_server", "/models/exl3-model",
    "--server-name", "0.0.0.0", "--server-port", "23333", "--model-name", "served-a",
    "--session-len", "16384", "--max-batch-size", "8", "--tp", "1",
    "--cache-max-entry-count", "0.6", "--backend", "pytorch", "--enable-metrics",
  ]);
  assert.ok(argv.includes("-p") && argv.includes("127.0.0.1:8010:23333"));
  assert.ok(argv.join(" ").includes("--entrypoint lmdeploy"));
  assert.equal(plan.command.labels["ai.manager.engine-id"], "lmdeploy");
  assert.equal(plan.runtime.id, "lmdeploy@0.18.0");
  assert.equal(plan.runtime.pullPolicy, "explicit");
  assert.ok(plan.warnings.some((item) => item.code === "experimental_engine"));
  assert.ok(plan.warnings.some((item) => item.code === "engine_sm120_unverified"), "lmdeploy is unverified on SM120");
  // The plan and the launch build the same command.
  const launched = await rig.start({ body: { engineId: "lmdeploy", acknowledge: ACK, model: { ref: MODEL, servedName: "served-a" }, instance: { port: 8010, gpuIds: ["0"] }, values: { contextLength: 16384, concurrency: 8, "lmdeploy.cacheMaxEntryCount": 0.6, "lmdeploy.backend": "pytorch" } } });
  await flush();
  assert.equal(launched.plan.planHash, plan.planHash);
});

test("an engine without API-key support is forced to a loopback publish and the key is dropped", async () => {
  const rig = createRig({ imagePresent: true });
  const body = { ...LAUNCH, engine: "trtllm", networkAccess: "lan", apiKey: KEY };
  const plan = await rig.start.planLaunch(body);
  assert.equal(plan.ok, true, JSON.stringify([plan.errors, plan.blockers]));
  assert.ok(plan.command.argv.includes("127.0.0.1:8010:8000"));
  assert.ok(!plan.command.argv.some((token) => String(token).startsWith("0.0.0.0:") || String(token).startsWith("192.0.2.10:")), "no wildcard or LAN publish");
  assert.ok(!JSON.stringify(plan).includes(KEY), "the key is nowhere in the plan");
  const codes = plan.warnings.map((item) => item.code);
  assert.ok(codes.includes("lan_unavailable") && codes.includes("api_key_unsupported"), codes.join());
  const { job } = await rig.start({ body });
  await flush();
  assert.equal(job.meta.networkAccess, "local");
  assert.equal(job.meta.hasApiKey, false);
  assert.equal(rig.secrets.size, 0, "a key the engine cannot use is never stored");
  const built = rig.builds.at(-1).built;
  assert.ok(built.runArgs.includes("127.0.0.1:8010:8000"));
  assert.deepEqual(built.secretEnv, {});
  assert.ok(!built.runArgs.join(" ").includes(KEY));
});

test("injection attempts are refused with 400 and nothing is built", async () => {
  const rig = createRig({ imagePresent: true });
  const refuse = (body, code) => assert.rejects(() => rig.start({ body: { ...LAUNCH, engine: "lmdeploy", ...body } }), (error) => error.status === 400 && error.code === code);
  await refuse({ name: "--evil-flag" }, "template_value_flag_injection");
  await refuse({ name: "bad\nname" }, "template_value_invalid");
  // A path-typed value outside the model storage roots never becomes a mount or an argument.
  await assert.rejects(
    () => rig.start({ body: { engineId: "tabbyapi", acknowledge: ACK, apiKey: KEY, model: { ref: MODEL }, instance: { port: 8010 }, values: { "speculative.draftModel": "C:/elsewhere/draft" } } }),
    (error) => error.status === 400 && error.code === "template_path_outside_storage",
  );
  await assert.rejects(() => rig.start({ body: { ...LAUNCH, engine: "lmdeploy", model: "C:/elsewhere/model" } }), (error) => error.status === 400);
  assert.equal(rig.jobs.length, 0);
});

test("TabbyAPI needs a key, writes config.yml and a secret api_tokens.yml, and reads the model from one folder", async () => {
  const rig = createRig({ imagePresent: true });
  await assert.rejects(() => rig.start({ body: { ...LAUNCH, engine: "tabbyapi" } }), (error) => error.status === 400 && error.code === "api_key_required");
  const body = { ...LAUNCH, engine: "tabbyapi", apiKey: KEY, networkAccess: "lan" };
  const plan = await rig.start.planLaunch(body);
  assert.equal(plan.ok, true, JSON.stringify([plan.errors, plan.blockers]));
  assert.deepEqual(plan.command.files, [
    { id: "config", target: "/app/config.yml", secret: false },
    { id: "tokens", target: "/app/api_tokens.yml", secret: true },
  ]);
  assert.ok(!JSON.stringify(plan).includes(KEY));
  const { job } = await rig.start({ body });
  await flush();
  const built = rig.builds.at(-1).built;
  assert.equal(built.files.length, 2);
  const config = built.files.find((file) => file.id === "config").content;
  assert.deepEqual(config.model, { model_dir: "/models", model_name: "exl3-model", max_seq_len: 8192, tensor_parallel: false, gpu_split_auto: true });
  assert.equal(config.network.disable_auth, false);
  const tokens = built.files.find((file) => file.id === "tokens");
  assert.equal(tokens.secret, true);
  assert.equal(tokens.content.api_key, KEY);
  assert.ok(!built.runArgs.join(" ").includes(KEY), "the key is not in argv");
  assert.ok(job.meta.launchId === undefined || !JSON.stringify(job.meta).includes(KEY));
});
