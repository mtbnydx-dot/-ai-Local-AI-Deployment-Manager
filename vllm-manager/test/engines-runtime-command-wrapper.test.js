const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 01-engines ENG-5: lib/runtime-command.js is a wrapper over the vllm/sglang
// adapters. normalizeRuntimeEngine delegates to the engine registry with the
// legacy coercion as fallback; the builder dispatches to the adapter the
// registry names, keeps secrets out of the plan, and writes the legacy job
// effects (meta, ledger save, log lines) even when a preset blocks.

// No installed <AI_ROOT>/config file may leak into these assertions.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const engines = require("../../manager-core/engines");
const { createVllmRuntimeCommandBuilder, normalizeRuntimeEngine } = require("../lib/runtime-command");

const FAKE_KEY = "fixture-wrapper-key-0001";

// A registry stand-in: legacy values map through `table`, engines through `descriptors`.
function fakeRegistry(table, descriptors) {
  return {
    fromLegacy: (value) => table[String(value ?? "").trim().toLowerCase()] ?? "unknown",
    hostedBy: (managerId) => Object.values(descriptors).filter((item) => item.hostManager === managerId).map((item) => item.id),
    get: (engineId) => descriptors[engineId] || null,
    toLegacy: (engineId) => descriptors[engineId]?.legacy?.engineLabel || engineId,
    resolveRuntime: () => { throw new Error("no runtime"); },
  };
}

const DESCRIPTORS = {
  vllm: { id: "vllm", adapter: "vllm", hostManager: "vllm", legacy: { engineLabel: "vllm" } },
  sglang: { id: "sglang", adapter: "sglang", hostManager: "vllm", legacy: { engineLabel: "sglang" } },
  lmdeploy: { id: "lmdeploy", adapter: "docker-template", hostManager: "vllm", legacy: {} },
  llamacpp: { id: "llamacpp", adapter: "llamacpp", hostManager: "llama", legacy: { engineLabel: "llama" } },
};

function builderDeps(overrides = {}) {
  const logs = [];
  const calls = [];
  const deps = {
    CONFIG: { containerName: "vllm-local", managerId: "vllm-manager", hfCache: "C:/fixture/cache/hf", modelsRoot: "C:/fixture/models", sglangCache: "C:/fixture/cache/sglang", image: "fixture/vllm:pinned" },
    MANAGER_LABEL_KEY: "ai.manager", MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine", MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: (_job, line) => logs.push(line),
    scheduleJobsSave: () => calls.push("scheduleJobsSave"),
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => {
      calls.push("dockerPublishArgs");
      return [`127.0.0.1:${port}:8000`];
    },
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("C:/fixture/models", "/models"),
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: () => ({ modelArg: "/models/fixture", effectiveLoadFormat: "auto", localPath: "C:/fixture/models/fixture" }),
    effectiveLaunchQuantization: () => ({ value: "", modelConfigMethod: "" }),
    resolveVllmRuntimePreset: () => ({}),
    ...overrides,
  };
  return { deps, logs, calls };
}

const BASE_OPTS = {
  model: "C:/fixture/models/fixture", name: "fixture", port: 8002, networkAccess: "local", serviceHost: "127.0.0.1",
  gpuDeviceIds: ["0"], dtype: "auto", maxModelLen: 32768, maxNumSeqs: 2, gpuMemoryUtilization: 0.8, kvCacheDtype: "auto",
  tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
};

test("normalizeRuntimeEngine maps legacy values through the bundled registry", () => {
  const registry = engines.createEngineRegistry({ env: {}, overrideDir: EMPTY_CONFIG_DIR });
  const cases = [
    [undefined, "vllm"], ["", "vllm"], ["vllm", "vllm"], ["VLLM", "vllm"], ["sglang", "sglang"], [" SGLang ", "sglang"],
    ["llama", "vllm"], ["llamacpp", "vllm"], ["unknown-engine", "vllm"], [null, "vllm"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(normalizeRuntimeEngine(value, registry), expected, String(value));
    assert.equal(normalizeRuntimeEngine(value), expected, `${value} (process registry)`);
  }
});

test("normalizeRuntimeEngine delegates to the registry and falls back to the legacy coercion", () => {
  // Delegation: the registry's answer wins over the legacy coercion.
  const renamed = fakeRegistry({ "radix-runtime": "sglang", sglang: "vllm" }, DESCRIPTORS);
  assert.equal(normalizeRuntimeEngine("radix-runtime", renamed), "sglang");
  assert.equal(normalizeRuntimeEngine("sglang", renamed), "vllm");
  // Fallback: engines this wrapper cannot launch, other managers' engines,
  // unknown values and a registry that fails all keep the legacy answer.
  const others = fakeRegistry({ lmdeploy: "lmdeploy", llama: "llamacpp", sglang: "sglang" }, DESCRIPTORS);
  assert.equal(normalizeRuntimeEngine("lmdeploy", others), "vllm");
  assert.equal(normalizeRuntimeEngine("llama", others), "vllm");
  assert.equal(normalizeRuntimeEngine("whatever", others), "vllm");
  assert.equal(normalizeRuntimeEngine("sglang", others), "sglang");
  const broken = { fromLegacy: () => { throw new Error("registry unavailable"); } };
  assert.equal(normalizeRuntimeEngine("sglang", broken), "sglang");
  assert.equal(normalizeRuntimeEngine("vllm", broken), "vllm");
  assert.equal(normalizeRuntimeEngine("other", broken), "vllm");
});

test("the builder dispatches to the adapter the registry names and keeps secrets out of the plan", (t) => {
  const registry = engines.createEngineRegistry({ env: {}, overrideDir: EMPTY_CONFIG_DIR });
  const spy = t.mock.method(engines.adapters.sglang, "buildLaunch");
  const { deps } = builderDeps({
    engineRegistry: registry,
    resolveVllmRuntimePreset: () => ({ id: "fixture-sglang", engine: "sglang", image: "fixture/sglang:pinned", maxRunningRequests: 2 }),
  });
  const { buildVllmRuntimeCommand, prepareLaunch } = createVllmRuntimeCommandBuilder(deps);
  const opts = { ...BASE_OPTS, engine: "sglang", vllmApiKey: FAKE_KEY, runtimeApiKeyRef: "ref-fixture" };

  const prepared = prepareLaunch({ id: "serve-wrapper", meta: {} }, opts);
  assert.equal(prepared.engineId, "sglang");
  assert.equal(prepared.adapter, engines.adapters.sglang);
  assert.equal(prepared.plan.values.servedName, "fixture");
  assert.equal(prepared.plan.values.contextLength, 32768);
  assert.equal(prepared.plan.values["sglang.memFractionStatic"], 0.8);
  assert.equal(prepared.plan.values["sglang.maxRunningRequests"], 2);
  assert.equal(Object.hasOwn(prepared.plan.values, "vllm.gpuMemoryUtilization"), false);
  assert.equal(prepared.ctx.runtime.image, "fixture/sglang:pinned");
  assert.equal(prepared.ctx.runtime.runtimeId, "sglang@custom");
  assert.equal(prepared.ctx.secrets.apiKey, FAKE_KEY);
  const { legacy, ...shown } = prepared.plan;
  assert.equal(JSON.stringify(shown).includes(FAKE_KEY), false);
  assert.equal(legacy.runOptions, opts);

  const job = { id: "serve-wrapper", meta: {} };
  const result = buildVllmRuntimeCommand(job, opts);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(result.runtimeEngine, "sglang");
  assert.equal(result.runtimeImage, "fixture/sglang:pinned");
  assert.deepEqual(result.runtimePreset, { id: "fixture-sglang", engine: "sglang", image: "fixture/sglang:pinned", maxRunningRequests: 2 });
  assert.deepEqual(result.runArgs.slice(result.runArgs.indexOf("--entrypoint"), result.runArgs.indexOf("--entrypoint") + 3), ["--entrypoint", "sglang", "fixture/sglang:pinned"]);
  assert.deepEqual(result.runArgs.slice(-2), ["--api-key", FAKE_KEY]);
  assert.deepEqual(result.secretEnv, {});
  assert.equal(job.meta.runtimePreset, "fixture-sglang");
  assert.equal(job.meta.effectiveMaxRunningRequests, 2);
});

test("a blocking preset writes the legacy job effects and throws its reason without touching docker helpers", () => {
  const { deps, logs, calls } = builderDeps({
    resolveVllmRuntimePreset: () => ({ id: "fixture-blocked", label: "Fixture blocked", unsupportedReason: "fixture block reason", notes: ["fixture note"] }),
  });
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder(deps);
  const job = { id: "serve-blocked", meta: { kept: true } };
  assert.throws(() => buildVllmRuntimeCommand(job, BASE_OPTS), (error) => {
    assert.equal(error.message, "fixture block reason");
    assert.equal(error.code, undefined);
    return true;
  });
  assert.equal(job.meta.kept, true);
  assert.equal(job.meta.runtimePreset, "fixture-blocked");
  assert.equal(job.meta.engine, "vllm");
  assert.deepEqual(calls, ["scheduleJobsSave"]);
  assert.deepEqual(logs, [
    "Runtime preset: Fixture blocked; using vllm image fixture/vllm:pinned.",
    "Runtime preset note: fixture note",
    "Runtime preset blocked: fixture block reason",
  ]);
});

test("a preset quantization is emitted where the legacy builder emitted it: SGLang only", () => {
  const quantized = (engine) => builderDeps({
    effectiveLaunchQuantization: () => ({ value: "fp8", modelConfigMethod: "fp8" }),
    resolveVllmRuntimePreset: () => ({ id: `fixture-${engine}`, engine, quantization: "modelopt_fp4" }),
  });
  for (const [engine, emitted] of [["vllm", "fp8"], ["sglang", "modelopt_fp4"]]) {
    const { deps, logs } = quantized(engine);
    const job = { id: `serve-${engine}`, meta: {} };
    const { runArgs } = createVllmRuntimeCommandBuilder(deps).buildVllmRuntimeCommand(job, { ...BASE_OPTS, engine, quantization: "fp8" });
    assert.equal(runArgs[runArgs.indexOf("--quantization") + 1], emitted, engine);
    assert.equal(runArgs.filter((arg) => arg === "--quantization").length, 1, engine);
    // job.meta and the override line record the preset value for both engines.
    assert.equal(job.meta.quantization, "modelopt_fp4", engine);
    assert.ok(logs.includes("Quantization runtime override: fp8 -> modelopt_fp4."), engine);
  }
});

test("without a preset the builder writes no job meta and saves nothing", () => {
  const { deps, logs, calls } = builderDeps();
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder(deps);
  const job = { id: "serve-plain", meta: {} };
  const result = buildVllmRuntimeCommand(job, BASE_OPTS);
  assert.deepEqual(job.meta, {});
  assert.deepEqual(calls, ["dockerPublishArgs"]);
  assert.deepEqual(logs, ["Docker publish: -p 127.0.0.1:8002:8000", "GPU isolation: --gpus device=0"]);
  assert.equal(result.runtimeEngine, "vllm");
  assert.equal(result.runtimeImage, "fixture/vllm:pinned");
  assert.ok(result.runArgs.includes("ai.manager.engine=vllm"));
});
