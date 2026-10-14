"use strict";

// resolveLaunchPlan, POST /api/launch/plan and /api/start through the resolver
// (01-engines ENG-7, §11 and §21.1). The managers' launch requests run with a
// fake host: stub normalisers, the real vLLM runtime-command builder, fake GPU
// telemetry, image presence and container listing. Nothing here starts a
// process, talks to Docker or reads the live root.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-plan-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const { createVllmStartRuntimeRequest } = require("../../vllm-manager/lib/launch-request");
const { createVllmRuntimeCommandBuilder } = require("../../vllm-manager/lib/runtime-command");
const { createLlamaStartRuntimeRequest } = require("../../llama-manager/lib/launch-request");

const engines = core.engines;
const plans = engines.launchPlan;
const FAKE_KEY = "fixture-plan-api-key-0001";
const OTHER_FAKE_KEY = "fixture-plan-api-key-0002";
const MODEL = "C:/fixture/models/Qwen3.8-27B-FP8";
const GPU = Object.freeze({ id: "0", index: "0", name: "NVIDIA RTX PRO 6000 Blackwell", computeCap: "12.0", totalMb: 97887, usedMb: 600 });
// The legacy preset of the qwen38-vllm-mtp3 recipe (reasoning and tool parsers locked).
const QWEN38_PRESET = Object.freeze({ id: "qwen3.8-vllm-fp8", reasoningParser: "qwen3", toolCallParser: "qwen3_coder", enableAutoToolChoice: true });

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

async function call(app, route, req = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
  await app.routes.get(route)({ headers: {}, ...req }, res);
  return res;
}

function testLease(calls, summary) {
  return {
    summary,
    startHeartbeat: () => () => {},
    commit: async () => calls.push("commit"),
    release: async (reason) => calls.push(`release:${reason}`),
  };
}

/** A registry whose runtime for `image` is experimental (explicit pull policy). */
function registryWithExplicitRuntime(image) {
  const base = engines.getEngineRegistry();
  const ref = Object.freeze({
    ...base.defaultRuntime("vllm"),
    runtimeId: "vllm@experimental-fixture",
    manifestKey: null,
    image,
    status: "experimental",
    localBuild: false,
    default: false,
    pullPolicy: "explicit",
  });
  return {
    ...base,
    resolveRuntime(engineId, selector = {}) {
      if (selector.image === image || selector.runtimeId === ref.runtimeId) return ref;
      return base.resolveRuntime(engineId, selector);
    },
  };
}

/**
 * vllm-manager's launch request over a fake host. options: { preset, registry,
 * missingImages, containers, admissionPreview, gpus }.
 */
function fakeVllmManager(options = {}) {
  const calls = [];
  const started = [];
  const registry = options.registry || engines.getEngineRegistry();
  const CONFIG = {
    defaultPort: 8000,
    containerName: "vllm-local",
    managerId: "vllm-manager",
    modelsRoot: "C:/fixture/models",
    hfCache: "C:/fixture/cache/huggingface",
    vllmCache: "C:/fixture/cache/vllm",
    sglangCache: "C:/fixture/cache/sglang",
    image: registry.defaultRuntime("vllm").image,
    sglangImage: registry.defaultRuntime("sglang").image,
  };
  const toContainerPath = (value) => String(value).replace("C:/fixture/models", "/models");
  const normalizeGpuIds = (value) => (Array.isArray(value) ? value.map(String) : String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
  const builder = createVllmRuntimeCommandBuilder({
    CONFIG,
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {},
    scheduleJobsSave: () => {},
    dockerGpuArg: (ids) => (ids.length ? `device=${ids.join(",")}` : "all"),
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: toContainerPath,
    normalizeGpuIds,
    getLanAddress: () => "192.168.1.27",
    resolveLaunchModel: (model) => ({ modelArg: toContainerPath(model), effectiveLoadFormat: "auto", localPath: model }),
    effectiveLaunchQuantization: () => ({ value: "", modelConfigMethod: "" }),
    resolveVllmRuntimePreset: (opts) => ({
      ...(options.preset || {}),
      image: String(opts.runtimeImage || "").trim() || (opts.engine === "sglang" ? CONFIG.sglangImage : CONFIG.image),
    }),
    engineRegistry: registry,
  });
  let jobs = 0;
  const start = createVllmStartRuntimeRequest({
    CONFIG,
    cleanRequired: (value, name) => {
      if (!value) {
        const error = new Error(`${name} 必须填写`);
        error.status = 400;
        throw error;
      }
      return String(value);
    },
    deriveName: (model) => String(model).split(/[\\/]/).pop(),
    positiveInt: (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback),
    nonNegativeNumber: (value, fallback) => (value === undefined || value === null || value === "" ? fallback : Math.max(0, Number(value))),
    optionalNonNegativeNumber: (value) => (value === undefined || value === null || value === "" ? null : Math.max(0, Number(value))),
    normalizeDtype: (value) => value || "auto",
    normalizeQuantization: (value) => value || "",
    normalizeLoadFormat: (value) => value || "auto",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeKvCacheDtype: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    normalizeGpuIds,
    normalizeClientPreset: (value) => value || "openai",
    normalizeReasoningParser: (value) => value || "",
    normalizeToolCallParser: (value) => value || "",
    inferToolCallParser: () => "",
    normalizeNetworkAccess: (value) => (value === "lan" ? "lan" : "local"),
    checkModelCompatibility: async () => {
      calls.push("checkModelCompatibility");
      return { ok: true, findings: [] };
    },
    getLanAddress: () => "192.168.1.27",
    createJob: (type, title, meta) => {
      calls.push("createJob");
      jobs += 1;
      return { id: `serve-${jobs}`, type, title, meta, status: "running" };
    },
    runStartJob: async (job, runOptions) => {
      calls.push("runStartJob");
      started.push({ job, runOptions });
      job.status = "success";
    },
    failJob: (_job, error) => calls.push(`failJob:${error.message}`),
    acquireGpuAdmission: async () => {
      calls.push("acquireGpuAdmission");
      return testLease(calls, { id: "lease-1", requestedTotalMb: 9000, reservations: [{ gpuId: "GPU-0", gpuIndex: "0", requestedMb: 9000 }] });
    },
    acquireGpuAdmissionAfterPrepare: async () => {
      throw new Error("the fake runStartJob never prepares a replacement");
    },
    saveRuntimeApiKey: async () => {
      calls.push("saveRuntimeApiKey");
      return "ref-fixture";
    },
    deleteRuntimeApiKey: async () => calls.push("deleteRuntimeApiKey"),
    getEngineRegistry: () => registry,
    prepareLaunchCommand: (runOptions, { jobId }) => {
      const prepared = builder.prepareLaunch({ id: jobId, meta: {} }, runOptions);
      return { ...prepared, recipe: engines.recipes.recipeForLegacyPreset(prepared.preset) };
    },
    getHostGpus: async () => {
      calls.push("getHostGpus");
      return (options.gpus || [GPU]).map((gpu) => ({ ...gpu }));
    },
    imagePresence: async (image) => {
      calls.push(`imagePresence:${image}`);
      return !(options.missingImages || []).includes(image);
    },
    admissionPreview: options.admissionPreview || (async (_request, { mode }) => {
      calls.push(`admissionPreview:${mode}`);
      return { verdict: "ok", message: "", clamped: false, requestedMb: 9000, reservedMb: 9000, gpus: [{ gpuIndex: "0", reservedMb: 9000 }] };
    }),
    listContainers: async () => {
      calls.push("listContainers");
      return options.containers || [];
    },
    getIntrospection: options.getIntrospection,
    modelStorage: options.modelStorage,
  });
  return { start, builder, calls, started, CONFIG, registry };
}

function legacyBody(extra = {}) {
  return {
    model: MODEL,
    port: "8000",
    instanceMode: "replace",
    maxModelLen: "65536",
    maxNumSeqs: "4",
    gpuMemoryUtilization: "0.9",
    dtype: "auto",
    kvCacheDtype: "auto",
    gpuDeviceIds: "0",
    ...extra,
  };
}

function v2Body(extra = {}) {
  return {
    engineId: "vllm",
    model: { ref: MODEL },
    instance: { mode: "replace", port: 8000, networkAccess: "local", gpuIds: ["0"] },
    values: { contextLength: 65536, concurrency: 4 },
    ...extra,
  };
}

function withoutLabel(argv, key) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--label" && String(argv[index + 1]).startsWith(`${key}=`)) {
      index += 1;
      continue;
    }
    out.push(argv[index]);
  }
  return out;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("a plan is side-effect free: no admission, key, job or start call", async () => {
  const host = fakeVllmManager();
  const plan = await host.start.planLaunch(legacyBody({ apiKey: FAKE_KEY }));
  assert.equal(plan.ok, true, JSON.stringify(plan.errors.concat(plan.blockers)));
  for (const forbidden of ["acquireGpuAdmission", "saveRuntimeApiKey", "createJob", "runStartJob"]) {
    assert.equal(host.calls.includes(forbidden), false, forbidden);
  }
  assert.ok(host.calls.includes("admissionPreview:replace"));
  assert.equal(plan.engineId, "vllm");
  assert.match(plan.planHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.runtime.id, "vllm@0.28.0");
  assert.equal(plan.admission.verdict, "ok");
  assert.deepEqual(plan.memory.perGpuMb, { 0: 9000 });
  assert.equal(plan.memory.policy, "device-fraction");
  assert.equal(plan.memory.admissionRequest.requestedFraction, 0.9);
  assert.ok(plan.catalogVersion);
  // The key never reaches the plan; only its env name does.
  const text = JSON.stringify(plans.publicPlan(plan));
  assert.equal(text.includes(FAKE_KEY), false);
  assert.equal(plan.command.env.VLLM_API_KEY, "<redacted>");
  assert.equal(Object.hasOwn(JSON.parse(text), "legacy"), false);
});

test("plan equals execution: /api/start runs the run options and argv the plan showed", async () => {
  const host = fakeVllmManager({ preset: QWEN38_PRESET });
  const body = legacyBody({ apiKey: FAKE_KEY, reasoningParser: "" });
  const plan = await host.start.planLaunch(body);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors.concat(plan.blockers)));
  const result = await host.start({ body });
  await settle();
  assert.equal(result.plan.planHash, plan.planHash);
  assert.equal(result.plan.verdict, null);
  const { job, runOptions } = host.started[0];
  assert.equal(result.job, job);
  // The launch runs the plan's run options; only the admission and key fields are filled in.
  const planned = engines.requestToLegacyRunOptions(plan);
  for (const key of ["runtimeApiKeyRef", "vramReservationMb", "gpuAdmissionLeaseId", "gpuAdmissionFinalized", "gpuAdmissionRequest", "prepareGpuAdmission"]) {
    delete planned[key];
  }
  for (const [key, value] of Object.entries(planned)) assert.deepEqual(runOptions[key], value, key);
  // runStartJob's builder renders the plan's argv; only the labels minted per
  // launch differ (job id, lease, reservation, key reference), and the hash
  // of the executed command is the plan's.
  const built = host.builder.buildVllmRuntimeCommand(job, { ...runOptions, hostGpus: [GPU] });
  const executed = ["docker", ...built.runArgs].map((arg) => (arg === FAKE_KEY ? "<redacted>" : arg));
  const volatile = ["ai.manager.job", "ai.manager.gpu-admission-lease", "ai.manager.vram-reservation-mb", "ai.manager.api-key-ref"];
  const stable = (argv) => volatile.reduce(withoutLabel, argv);
  assert.deepEqual(stable(executed), stable(plan.command.argv));
  assert.equal(executed.includes(`ai.manager.job=${job.id}`), true);
  assert.equal(executed.includes("ai.manager.api-key-ref=ref-fixture"), true);
  assert.equal(plan.command.argv.includes("ai.manager.job=plan"), true);
  assert.equal(plan.command.argv.includes("ai.manager.api-key-ref=pending"), true);
  const { adapter, plan: adapterPlan, ctx } = host.builder.prepareLaunch(job, { ...runOptions, hostGpus: [GPU] });
  assert.equal(plans.commandView(adapter.buildLaunch(adapterPlan, ctx)).planHash, plan.planHash);
  // The same recipe ran: the plan names it and its locked parsers are in argv.
  assert.equal(plan.recipe.id, "qwen38-vllm-mtp3");
  assert.equal(plan.values.reasoningParser.value, "qwen3");
  assert.equal(plan.values.reasoningParser.source, "recipe");
  assert.equal(plan.values.contextLength.source, "user");
});

test("planHash is stable for identical inputs and ignores the key value", async () => {
  const host = fakeVllmManager();
  const first = await host.start.planLaunch(legacyBody({ apiKey: FAKE_KEY }));
  const second = await host.start.planLaunch(legacyBody({ apiKey: FAKE_KEY }));
  const otherKey = await host.start.planLaunch(legacyBody({ apiKey: OTHER_FAKE_KEY }));
  const longer = await host.start.planLaunch(legacyBody({ apiKey: FAKE_KEY, maxModelLen: "131072" }));
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.planHash, otherKey.planHash);
  assert.notEqual(first.planHash, longer.planHash);
  assert.equal(plans.computePlanHash({ image: "a", argvRedacted: ["x"], labels: { b: "1", a: "2" } }),
    plans.computePlanHash({ image: "a", argvRedacted: ["x"], labels: { a: "2", b: "1" } }));
  assert.equal(plans.computePlanHash({ image: "a", argvRedacted: ["--label", "ai.manager.job=1"], labels: { "ai.manager.job": "1" } }),
    plans.computePlanHash({ image: "a", argvRedacted: ["--label", "ai.manager.job=2"], labels: { "ai.manager.job": "2" } }));
});

test("alias round trip: a legacy body and its v2 request plan the same command", async () => {
  const host = fakeVllmManager();
  const body = legacyBody();
  const legacyPlan = await host.start.planLaunch(body);
  const { request } = plans.toLaunchRequest(body, { managerId: "vllm", registry: host.registry });
  delete request.legacy;
  assert.equal(plans.isV2Request(request), true);
  const v2Plan = await host.start.planLaunch(request);
  assert.equal(v2Plan.ok, true, JSON.stringify(v2Plan.errors.concat(v2Plan.blockers)));
  assert.equal(v2Plan.planHash, legacyPlan.planHash);
  assert.deepEqual(v2Plan.command.argv, legacyPlan.command.argv);
  assert.equal(v2Plan.values.contextLength.value, 65536);
  assert.equal(v2Plan.values.contextLength.source, "user");
});

test("recipe locks: a v2 user conflict is a field error, a planner conflict an override", async () => {
  const host = fakeVllmManager({ preset: QWEN38_PRESET });
  const user = await host.start.planLaunch(v2Body({ recipeId: "qwen38-vllm-mtp3", values: { contextLength: 65536, reasoningParser: "deepseek_r1" } }));
  assert.equal(user.ok, false);
  assert.deepEqual(user.errors.map((item) => [item.field, item.code]), [["reasoningParser", "recipe_locked"]]);
  assert.equal(user.errors[0].suggestion.value, "qwen3");
  assert.equal(host.calls.includes("checkModelCompatibility"), false, "a v2 field error stops before normalisation");

  const planner = await host.start.planLaunch(v2Body({
    recipeId: "qwen38-vllm-mtp3",
    values: { contextLength: { value: 32768, source: "planner" }, reasoningParser: { value: "deepseek_r1", source: "planner" } },
  }));
  assert.equal(planner.ok, true, JSON.stringify(planner.errors.concat(planner.blockers)));
  assert.ok(planner.warnings.some((item) => item.field === "reasoningParser" && item.code === "recipe_locked_override"));
  assert.deepEqual(planner.overrides.find((item) => item.param === "reasoningParser"),
    { param: "reasoningParser", from: "deepseek_r1", to: "qwen3", source: "recipe", reason: planner.values.reasoningParser.reason });
  assert.equal(planner.values.contextLength.source, "planner");
  assert.equal(planner.values.contextLength.value, 32768);
  assert.equal(planner.recipe.id, "qwen38-vllm-mtp3");
  assert.ok(planner.recipe.locks.some((lock) => lock.param === "reasoningParser"));
});

test("a recipe the launch would not run is a field error", async () => {
  const host = fakeVllmManager();
  const plan = await host.start.planLaunch(v2Body({ recipeId: "qwen38-vllm-mtp3" }));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors.map((item) => item.code), ["recipe_not_applicable"]);
  const unknown = await host.start.planLaunch(v2Body({ recipeId: "no-such-recipe" }));
  assert.deepEqual(unknown.errors.map((item) => [item.field, item.code]), [["recipeId", "unknown_recipe"]]);
});

test("/api/start: a v2 lock conflict is 400 recipe_locked, a legacy one is overridden with a warning", async () => {
  const host = fakeVllmManager({ preset: QWEN38_PRESET });
  await assert.rejects(
    () => host.start({ body: v2Body({ recipeId: "qwen38-vllm-mtp3", values: { reasoningParser: "deepseek_r1" } }) }),
    (error) => error.status === 400 && error.code === "recipe_locked"
      && error.errors.length === 1 && error.errors[0].code === "recipe_locked",
  );
  assert.equal(host.calls.includes("createJob"), false);

  const result = await host.start({ body: legacyBody({ reasoningParser: "deepseek_r1" }) });
  await settle();
  assert.ok(result.job);
  assert.ok(result.plan.warnings.some((item) => item.field === "reasoningParser" && item.code === "recipe_locked_override"));
  assert.ok(result.plan.overrides.some((item) => item.param === "reasoningParser" && item.to === "qwen3"));
  // Launch mode makes no preview reads of its own.
  assert.equal(host.calls.some((item) => item.startsWith("admissionPreview") || item === "listContainers"), false);
});

test("/api/start errors keep the legacy shape and add ok:false and errors[]", async () => {
  const app = recordingApp();
  const host = fakeVllmManager();
  core.registerRuntimeRoutes(app, { startRuntime: host.start });
  const invalid = await call(app, "POST /api/start", { body: legacyBody({ maxModelLen: "NaN" }) });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.body.error, /maxModelLen/);
  assert.equal(invalid.body.ok, false);
  assert.equal(invalid.body.errors[0].code, "invalid_value");
  const locked = await call(app, "POST /api/start", { body: v2Body({ recipeId: "no-such-recipe" }) });
  assert.equal(locked.statusCode, 400);
  assert.equal(locked.body.code, "unknown_recipe");
  assert.equal(typeof locked.body.error, "string");
  assert.deepEqual(locked.body.errors.map((item) => item.code), ["unknown_recipe"]);
  const unknown = await call(app, "POST /api/start", { body: legacyBody({ engine: "tensorrt" }) });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.code, "unknown_engine");
  assert.equal(Object.hasOwn(unknown.body, "errors"), false);
});

test("unknown engine → 400 unknown_engine on plan and start, for both managers", async () => {
  const host = fakeVllmManager();
  for (const body of [{ engineId: "nope" }, v2Body({ engineId: "llamacpp" }), legacyBody({ engine: "llama" }), legacyBody({ engine: "nope" })]) {
    await assert.rejects(() => host.start.planLaunch(body), (error) => error.status === 400 && error.code === "unknown_engine", JSON.stringify(body));
    await assert.rejects(() => host.start({ body }), (error) => error.status === 400 && error.code === "unknown_engine");
  }
  const llama = createLlamaStartRuntimeRequest({ CONFIG: { defaultPort: 8080, containerName: "llama-local" }, cleanRequired: (value) => String(value || "") });
  await assert.rejects(() => llama.planLaunch({ model: "C:/fixture/models/a.gguf", engine: "sglang" }), (error) => error.code === "unknown_engine");
  await assert.rejects(() => llama({ body: { engineId: "vllm", model: { ref: "C:/fixture/models/a.gguf" } } }), (error) => error.code === "unknown_engine");
  assert.equal(host.calls.includes("createJob"), false);
});

test("POST /api/launch/plan answers 200 for every plan problem and 400 only for a malformed body", async () => {
  const host = fakeVllmManager({ preset: QWEN38_PRESET });
  const app = recordingApp();
  engines.registerEngineRoutes(app, {
    registry: host.registry,
    managerId: "vllm",
    isLocalRequest: (req) => req.local !== false,
    planLaunch: (body) => host.start.planLaunch(body),
  });
  const ok = await call(app, "POST /api/launch/plan", { body: legacyBody() });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  for (const field of ["planHash", "steps", "blockers", "errors", "warnings", "catalogVersion", "values", "overrides", "command", "memory", "admission", "recipe", "runtime"]) {
    assert.ok(Object.hasOwn(ok.body, field), field);
  }
  const problems = [
    v2Body({ values: { contextLength: "long" } }),
    v2Body({ recipeId: "qwen38-vllm-mtp3", values: { reasoningParser: "deepseek_r1" } }),
    legacyBody({ maxModelLen: "NaN" }),
    legacyBody({ instanceMode: "parallel", port: "" }),
  ];
  for (const body of problems) {
    const res = await call(app, "POST /api/launch/plan", { body });
    assert.equal(res.statusCode, 200, JSON.stringify(body));
    assert.equal(res.body.ok, false);
    assert.ok(res.body.errors.length + res.body.blockers.length > 0);
  }
  const malformed = [
    [[], "invalid_body"],
    ["text", "invalid_body"],
    [v2Body({ values: [] }), "invalid_request"],
    [v2Body({ instance: { mode: 1 } }), "invalid_request"],
    [v2Body({ extraArgs: "--x" }), "invalid_request"],
    [legacyBody({ filler: "x".repeat(plans.MAX_BODY_BYTES) }), "body_too_large"],
    [{ engineId: "nope" }, "unknown_engine"],
  ];
  for (const [body, code] of malformed) {
    const res = await call(app, "POST /api/launch/plan", { body });
    assert.equal(res.statusCode, 400, code);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, code);
  }
  const remote = await call(app, "POST /api/launch/plan", { body: legacyBody(), local: false });
  assert.equal(remote.statusCode, 403);
});

test("steps run pull, replace, start, and a missing explicit-policy image blocks with image_pull_required", async () => {
  const running = [{ name: "vllm-local", running: true, labels: { "ai.manager.model": "qwen3.6-27b", "ai.manager.vram-reservation-mb": "80000", "ai.manager.gpu-ids": "0" } }];
  const previews = [];
  const host = fakeVllmManager({
    containers: running,
    admissionPreview: async (request, options) => {
      previews.push({ request, options });
      return { verdict: "ok", message: "", requestedMb: 1, reservedMb: 1, gpus: [] };
    },
  });
  const plan = await host.start.planLaunch(legacyBody());
  assert.deepEqual(plan.steps.map((step) => step.kind), ["pull", "replace", "start"]);
  assert.deepEqual(plan.steps[0], { kind: "pull", runtimeId: "vllm@0.28.0", image: host.CONFIG.image, required: false, policy: "auto" });
  assert.deepEqual(plan.steps[1], { kind: "replace", containerName: "vllm-local", model: "qwen3.6-27b" });
  assert.deepEqual(plan.steps[2], { kind: "start", containerName: "vllm-local", port: 8000, gpuIds: ["0"] });
  // The replace preview counts the running model's memory as released.
  assert.deepEqual(previews[0].options, { mode: "replace", releasedMbByGpu: { 0: 80000 } });

  const parallel = await host.start.planLaunch(legacyBody({ instanceMode: "parallel", instanceId: "side", port: "8123" }));
  assert.deepEqual(parallel.steps.map((step) => step.kind), ["pull", "start"]);
  assert.equal(parallel.steps[1].containerName, "vllm-local-side");

  const image = "registry.example.invalid/engine:experimental";
  const explicit = fakeVllmManager({ registry: registryWithExplicitRuntime(image), missingImages: [image] });
  const blocked = await explicit.start.planLaunch(v2Body({ runtimeId: "vllm@experimental-fixture" }));
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.steps[0], { kind: "pull", runtimeId: "vllm@experimental-fixture", image, required: true, policy: "explicit" });
  assert.equal(blocked.steps.at(-1).kind, "start");
  const blocker = blocked.blockers.find((item) => item.code === "image_pull_required");
  assert.ok(blocker, JSON.stringify(blocked.blockers));
  assert.ok(blocker.message.zh && blocker.message.en);
  assert.deepEqual(blocker.action.apiCall, { method: "POST", path: "/api/runtimes/vllm%40experimental-fixture/pull", body: { confirm: true } });
  // The launch refuses with 409 before any job, lease or key.
  await assert.rejects(() => explicit.start({ body: v2Body({ runtimeId: "vllm@experimental-fixture" }) }),
    (error) => error.status === 409 && error.code === "image_pull_required" && /pull/.test(error.hint));
  for (const forbidden of ["acquireGpuAdmission", "saveRuntimeApiKey", "createJob"]) assert.equal(explicit.calls.includes(forbidden), false);

  // The same image present: no blocker, the step is not required.
  const present = fakeVllmManager({ registry: registryWithExplicitRuntime(image) });
  const ready = await present.start.planLaunch(v2Body({ runtimeId: "vllm@experimental-fixture" }));
  assert.equal(ready.blockers.length, 0, JSON.stringify(ready.blockers));
  assert.equal(ready.steps[0].required, false);
});

test("a missing local build blocks with runtime_local_build_missing and is never pulled", async () => {
  const image = engines.getEngineRegistry().resolveRuntime("sglang", { runtimeId: "sglang@qwen38flashnext-sm120-dac5523d" }).image;
  const host = fakeVllmManager({ missingImages: [image] });
  const plan = await host.start.planLaunch(v2Body({ engineId: "sglang", runtimeId: "sglang@qwen38flashnext-sm120-dac5523d" }));
  assert.equal(plan.steps[0].required, true);
  assert.equal(plan.steps[0].image, image);
  assert.deepEqual(plan.blockers.map((item) => item.code), ["runtime_local_build_missing"]);
  assert.equal(plan.blockers[0].action, undefined);
});

test("an admission block is blocker insufficient_vram in the plan; the launch keeps the acquire 409", async () => {
  const host = fakeVllmManager({
    admissionPreview: async () => ({
      verdict: "block",
      message: "替换启动需要 96801 MiB，安全预算只有 89095 MiB。现有模型容器未改动。 / Replacement launch needs 96801 MiB but the safe budget is 89095 MiB. Existing model containers were not changed.",
      requestedMb: 96801,
      reservedMb: 96801,
      gpus: [{ gpuIndex: "0", reservedMb: 96801 }],
    }),
  });
  const plan = await host.start.planLaunch(legacyBody());
  assert.equal(plan.ok, false);
  assert.equal(plan.admission.verdict, "block");
  assert.deepEqual(plan.blockers.map((item) => item.code), ["insufficient_vram"]);
  assert.match(plan.blockers[0].message.zh, /^替换启动需要 96801 MiB/);
  assert.match(plan.blockers[0].message.en, /^Replacement launch needs 96801 MiB/);
  // Launch mode never previews: admission stays with acquire.
  const result = await host.start({ body: legacyBody() });
  await settle();
  assert.ok(result.job);
});

test("gpu-admission evaluate() previews the P0-RT-3 decision without a lock or a write", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engines-plan-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let usedMb = 600;
  const controller = core.createGpuAdmissionController({
    root,
    reserveMb: 8192,
    maxUtilizationPct: 95,
    startupMarginMb: 1024,
    policyFile: false,
    getGpuStatus: async () => ({ ok: true, gpus: [{ id: "0", totalMb: 97887, usedMb }] }),
  });
  const request = {
    engine: "sglang",
    instanceMode: "replace",
    containerName: "vllm-local",
    gpuIds: ["0"],
    requestedFractionOfFree: 0.995,
    poolCappedTokens: 262144,
    minClampMb: 4096,
    estimatePolicy: "sglang_mem_fraction_static_of_free",
  };
  const warn = await controller.evaluate(request, { mode: "replace" });
  assert.equal(warn.verdict, "warn");
  assert.equal(warn.clamped, true);
  assert.equal(warn.requestedMb, 96801);
  assert.equal(warn.reservedMb, 89095);
  assert.match(warn.message, /^SGLang 静态显存比例按空闲显存折算需要 96801 MiB，超过安全预算 89095 MiB/);
  assert.equal(fs.existsSync(path.join(root, "leases.json")), false, "evaluate writes nothing");
  assert.equal(fs.existsSync(path.join(root, "admission.lock")), false, "evaluate takes no lock");

  // Before the old model stops: its memory comes back through releasedMbByGpu.
  usedMb = 90000;
  const replaced = await controller.evaluate(request, { mode: "replace", releasedMbByGpu: { 0: 89400 } });
  assert.equal(replaced.verdict, "warn");
  assert.equal(replaced.reservedMb, 89095);

  const block = await controller.evaluate({ ...request, poolCappedTokens: 0 }, { mode: "replace", releasedMbByGpu: { 0: 89400 } });
  assert.equal(block.verdict, "block");
  assert.equal(block.maxFraction, 0.915);
  assert.match(block.message, /^替换启动需要 96801 MiB，安全预算只有 89095 MiB/);

  // A lease of the replaced container is not counted against its successor.
  usedMb = 600;
  const lease = await controller.acquire({ ...request, instanceMode: "parallel", requestedFractionOfFree: undefined, requestedMb: 20000 });
  const withPeer = await controller.evaluate({ ...request, containerName: "vllm-local-other" }, { mode: "parallel" });
  const withOwn = await controller.evaluate(request, { mode: "replace" });
  assert.ok(withPeer.requestedMb < withOwn.requestedMb, `${withPeer.requestedMb} < ${withOwn.requestedMb}`);
  await lease.release("test");

  const down = core.createGpuAdmissionController({ root, policyFile: false, getGpuStatus: async () => { throw new Error("nvidia-smi missing"); } });
  const unknown = await down.evaluate(request, { mode: "replace" });
  assert.equal(unknown.verdict, "unknown");
  assert.equal(unknown.code, "vram_telemetry_unavailable");
});

test("v2 parts of later packages are plan errors, not silent drops", async () => {
  const host = fakeVllmManager();
  const plan = await host.start.planLaunch(v2Body({ prospective: true, instance: { mode: "add" }, extraArgs: ["--x"] }));
  // extraArgs became real in ENG-15: without introspection an unknown flag is a warning.
  assert.deepEqual(plan.errors.map((item) => item.code).sort(), ["instance_mode_unsupported", "prospective_unsupported"]);
  assert.ok(plan.warnings.some((item) => item.code === "extra_arg_unverified"));
});

test("extraArgs and extraEnv are validated, shown as custom, appended last and run as planned (ENG-15)", async () => {
  const host = fakeVllmManager();
  const body = v2Body({ extraArgs: ["--swap-space", "4"], extraEnv: { VLLM_FIXTURE_FLAG: "1" } });
  const plan = await host.start.planLaunch(body);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors.concat(plan.blockers)));
  assert.deepEqual(plan.custom, { extraArgs: ["--swap-space", "4"], extraEnv: { VLLM_FIXTURE_FLAG: "1" } });
  assert.deepEqual(plan.command.argv.slice(-2), ["--swap-space", "4"]);
  assert.equal(plan.command.env.VLLM_FIXTURE_FLAG, "1");
  assert.ok(plan.warnings.some((item) => item.field === "extraArgs[0]" && item.code === "extra_arg_unverified"));
  const baseline = await host.start.planLaunch(v2Body());
  assert.equal(Object.hasOwn(baseline, "custom"), false, "a plan without extras is unchanged");
  assert.notEqual(plan.planHash, baseline.planHash);

  const result = await host.start({ body });
  await settle();
  const { job, runOptions } = host.started[0];
  assert.equal(result.plan.planHash, plan.planHash);
  assert.deepEqual(runOptions.extraArgs, ["--swap-space", "4"]);
  assert.deepEqual(runOptions.extraEnv, { VLLM_FIXTURE_FLAG: "1" });
  assert.deepEqual(job.meta.extraArgs, ["--swap-space", "4"]);
  assert.deepEqual(job.meta.extraEnv, { VLLM_FIXTURE_FLAG: "1" });
});

test("extraArgs with a managed flag, a set parameter's flag or a denied variable are plan errors", async () => {
  const host = fakeVllmManager();
  const managed = await host.start.planLaunch(v2Body({ extraArgs: ["--port", "9000"] }));
  assert.equal(managed.ok, false);
  assert.deepEqual(managed.errors.map((item) => item.code), ["extra_arg_denied"]);
  assert.equal(managed.command, null);
  const duplicate = await host.start.planLaunch(v2Body({ extraArgs: ["--max-model-len", "4096"] }));
  assert.deepEqual(duplicate.errors.map((item) => item.code), ["extra_arg_denied"]);
  const env = await host.start.planLaunch(v2Body({ extraEnv: { HF_TOKEN: "x", VLLM_OK: "1" } }));
  assert.deepEqual(env.errors.map((item) => item.code), ["extra_env_denied"]);
  await assert.rejects(() => host.start({ body: v2Body({ extraArgs: ["--port", "9000"] }) }), (error) => error.status === 400);
  assert.equal(host.started.length, 0);
});

test("with introspection an unknown extra flag is an error, and a path flag is confined to model storage", async () => {
  const root = "C:/fixture/models";
  const modelStorage = {
    fromContainerPath: (value) => String(value),
    resolvePath(value) {
      if (!String(value).startsWith(`${root}/`)) throw new Error("outside");
      return value;
    },
    toContainerPath(value) {
      modelStorage.resolvePath(value);
      return String(value).replace(root, "/models");
    },
  };
  const getIntrospection = async () => ({ flags: [
    { flag: "--swap-space", aliases: [], takesValue: true, valueHint: "SWAP_SPACE" },
    { flag: "--chat-template", aliases: [], takesValue: true, valueHint: "CHAT_TEMPLATE_FILE" },
  ] });
  const host = fakeVllmManager({ getIntrospection, modelStorage });
  const unknown = await host.start.planLaunch(v2Body({ extraArgs: ["--nope", "1"] }));
  assert.deepEqual(unknown.errors.map((item) => item.code), ["extra_arg_unknown"]);
  const outside = await host.start.planLaunch(v2Body({ extraArgs: ["--chat-template", "C:/elsewhere/t.jinja"] }));
  assert.deepEqual(outside.errors.map((item) => item.code), ["extra_arg_denied"]);
  const inside = await host.start.planLaunch(v2Body({ extraArgs: ["--chat-template", `${root}/t.jinja`, "--swap-space", "2"] }));
  assert.equal(inside.ok, true, JSON.stringify(inside.errors));
  assert.deepEqual(inside.command.argv.slice(-4), ["--chat-template", "/models/t.jinja", "--swap-space", "2"]);
  assert.deepEqual(inside.warnings.filter((item) => item.code === "extra_arg_unverified"), []);
});

test("a blocked recipe is blocker recipe_blocked in the plan and 422 at /api/start", async () => {
  const reason = "DSpark is not supported by vLLM on this host.";
  const host = fakeVllmManager({ preset: { id: "vllm-dspark-wsl-unsupported", unsupportedReason: reason } });
  const plan = await host.start.planLaunch(legacyBody());
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.blockers.map((item) => item.code), ["recipe_blocked"]);
  assert.equal(plan.blockers[0].message.en, reason);
  assert.equal(plan.recipe.id, "qwen38-dspark-vllm");
  assert.equal(plan.command, null);
  await assert.rejects(() => host.start({ body: legacyBody() }),
    (error) => error.status === 422 && error.code === "recipe_blocked" && error.details.blockers[0].code === "recipe_blocked");
  assert.equal(host.calls.includes("createJob"), false);
});

test("llama-manager plans through the same resolver: the VRAM estimate runs in a plan", async () => {
  const calls = [];
  const start = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: "llama-local", managerId: "llama-manager" },
    cleanRequired: (value, name) => {
      if (!value) throw Object.assign(new Error(`${name} required`), { status: 400 });
      return String(value);
    },
    deriveName: (model) => model.split(/[\/]/).pop(),
    positiveInt: (value, fallback) => Number(value || fallback),
    normalizeGpuLayers: (value) => (value === "auto" ? "auto" : (value == null || value === "" ? -1 : Number(value))),
    normalizeLlamaCacheType: (value) => value || "q8_0",
    normalizeOnOffAuto: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: [] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeLlamaSplitMode: (value) => value || "layer",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeClientPreset: (value) => value || "openai",
    normalizeLlamaReasoningFormat: (value) => value || "none",
    normalizeDefaultTrueBoolean: (value) => value !== false,
    normalizeNetworkAccess: (value) => value || "local",
    getLanAddress: () => "127.0.0.1",
    getGpuStatus: async () => ({ gpus: [{ id: "0" }] }),
    buildLlamaGpuPlan: () => ({ mainGpu: "0", mainGpuHostId: "host-0" }),
    suggestTensorSplit: () => "",
    createJob: () => { calls.push("createJob"); return { id: "serve-llama", meta: {} }; },
    runStartJob: async () => calls.push("runStartJob"),
    failJob: () => {},
    estimateParallelVram: async () => {
      calls.push("estimateParallelVram");
      return { requestedMb: 10000, requestedMbByGpu: { 0: 10000 }, estimatePolicy: "llama_gguf_metadata_layers_kv_sliding_window" };
    },
    getHostGpus: async () => [{ ...GPU }],
    imagePresence: async () => true,
    admissionPreview: async (request, { mode }) => {
      calls.push(`admissionPreview:${mode}:${request.requestedMb}`);
      return { verdict: "ok", message: "", requestedMb: 10000, reservedMb: 10000, gpus: [{ gpuIndex: "0", reservedMb: 10000 }] };
    },
  });
  const plan = await start.planLaunch({ model: "C:/fixture/models/model.gguf", instanceMode: "parallel", port: "8081", gpuDeviceIds: "0" });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors.concat(plan.blockers)));
  assert.equal(plan.engineId, "llamacpp");
  assert.deepEqual(calls, ["estimateParallelVram", "admissionPreview:parallel:10000"]);
  assert.equal(plan.memory.policy, "gguf-estimate");
  assert.equal(plan.memory.admissionRequestMb, 10000);
  assert.deepEqual(plan.steps.map((step) => step.kind), ["pull", "start"]);
  assert.equal(plan.steps[1].containerName, "llama-local-model-gguf");
  assert.equal(engines.requestToLegacyRunOptions(plan).llamaApiKey, "");
});

test("P0 flags: a v2 request's catalog-only values reach the planned command, a legacy body never carries them", async () => {
  const host = fakeVllmManager();
  const overrides = { rope_scaling: { rope_type: "yarn", factor: 4, original_max_position_embeddings: 32768 } };
  const plan = await host.start.planLaunch(v2Body({ values: { contextLength: 65536, concurrency: 4, hfOverrides: overrides, role: "embedding" } }));
  assert.equal(plan.ok, true, JSON.stringify(plan.errors.concat(plan.blockers)));
  const argv = plan.command.argv;
  assert.equal(argv[argv.indexOf("--hf-overrides") + 1], JSON.stringify(overrides));
  assert.deepEqual(argv.slice(argv.indexOf("--runner"), argv.indexOf("--runner") + 4), ["--runner", "pooling", "--convert", "embed"]);
  // Both sit after the legacy engine args: the baseline argv is a prefix-preserving subset.
  const baseline = await host.start.planLaunch(v2Body());
  assert.ok(argv.indexOf("--runner") > baseline.command.argv.indexOf("--max-num-seqs"));
  const legacy = await host.start.planLaunch(legacyBody());
  assert.equal(Object.hasOwn(legacy.legacy?.runOptions || {}, "catalogValues"), false);
  assert.ok(!legacy.command.argv.includes("--hf-overrides"));
  // A rule violation is a field error, not a silently dropped value.
  const bad = await host.start.planLaunch(v2Body({ values: { contextLength: 65536, concurrency: 4, "speculative.method": "eagle3" } }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.field === "speculative.method" && item.code === "speculative_needs_draft_model"));
});
