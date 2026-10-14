"use strict";

// The llama.cpp engine adapter and the shared docker renderer
// (docs/overhaul/01-engines.md §5-§7, ENG-4): renderRunArgs order, the
// LaunchCommand shape, runtime.features gating (the replacement for
// supportsB10630Controls), plan values with provenance, recipe sampling
// values, the secret channel, purity and failures that keep their log lines.
// The full argv of every llama golden is asserted by engines-golden.test.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// No installed <AI_ROOT>/config file may leak into these assertions.
const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const llamacpp = require("../engines/adapters/llamacpp");
const { labelsFromFlags, renderRunArgs } = require("../engines/adapters/_docker-segments");

const FAKE_API_KEY = "fixture-llama-adapter-key-0001";
const FAKE_HF_TOKEN = "fixture-llama-adapter-hf-0001";
const B10630_FEATURES = Object.freeze({ reasoningEffort: true, mmprojDevice: true });

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function basePlan(overrides = {}) {
  return {
    engineId: "llamacpp",
    values: {
      servedName: "qwen-vision",
      contextLength: 32768,
      concurrency: 2,
      "llamacpp.planningUtilization": 0.9,
      "llamacpp.gpuLayers": 999,
      "llamacpp.batchSize": 2048,
      "llamacpp.ubatchSize": 512,
      "llamacpp.cacheTypeK": "q8_0",
      "llamacpp.cacheTypeV": "q8_0",
      "llamacpp.flashAttention": "auto",
      "llamacpp.splitMode": "none",
      "llamacpp.mainGpu": 0,
      "llamacpp.reasoning": "auto",
      "llamacpp.reasoningFormat": "auto",
      "llamacpp.reasoningEffort": "high",
      "llamacpp.reasoningBudget": 1024,
      "llamacpp.mmprojDevice": "CUDA0",
      "llamacpp.textOnly": false,
      ...(overrides.values || {}),
    },
    instance: { mode: "replace", id: "primary", port: 8080, networkAccess: "local", serviceHost: "127.0.0.1", gpuIds: ["0"], ...(overrides.instance || {}) },
    secrets: { ...(overrides.secrets || {}) },
    launch: { jobId: "serve-adapter", ...(overrides.launch || {}) },
    recipe: overrides.recipe ?? null,
  };
}

function baseCtx(overrides = {}) {
  return {
    runtime: { runtimeId: "llamacpp@b10630", manifestKey: "llama", image: "llama:pinned", features: B10630_FEATURES, default: true, ...(overrides.runtime || {}) },
    host: {
      config: { containerName: "llama-local", managerLabelValue: "llama-manager", hfCache: "C:/fixture/cache", modelsRoot: "C:/fixture/models" },
      ...(overrides.host || {}),
    },
    model: {
      ref: "C:/fixture/models/qwen-vision/model.gguf",
      modelArg: "/models/qwen-vision/model.gguf",
      ggufFiles: [{ path: "C:/fixture/models/qwen-vision/model.gguf" }, { path: "C:/fixture/models/qwen-vision/mmproj-F16.gguf" }],
      ...(overrides.model || {}),
    },
    secrets: { ...(overrides.secrets || {}) },
    toContainerPath: (value) => String(value).replace("C:/fixture/models", "/models"),
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8080`],
  };
}

function valueAfter(list, flag) {
  const index = list.indexOf(flag);
  return index < 0 ? undefined : list[index + 1];
}

test("renderRunArgs joins the docker segments in order and keeps the entrypoint before the image", () => {
  const docker = { flags: ["--name", "z", "--label", "b=2", "--label", "a=1"], entrypoint: "sglang", image: "local/x:1", args: ["serve", "--b", "--a"] };
  assert.deepEqual(renderRunArgs({ host: "docker", docker }), ["run", "-d", "--name", "z", "--label", "b=2", "--label", "a=1", "--entrypoint", "sglang", "local/x:1", "serve", "--b", "--a"]);
  assert.deepEqual(renderRunArgs({ docker: { ...docker, entrypoint: null } }), ["run", "-d", "--name", "z", "--label", "b=2", "--label", "a=1", "local/x:1", "serve", "--b", "--a"]);
  // A bare docker segment renders the same.
  assert.deepEqual(renderRunArgs(docker), renderRunArgs({ docker }));
  assert.throws(() => renderRunArgs(null), TypeError);
  assert.equal(core.engines.renderRunArgs, renderRunArgs);
});

test("labelsFromFlags mirrors --label pairs and ignores other flags", () => {
  assert.deepEqual(
    labelsFromFlags(["--label", "ai.manager=llama-manager", "-e", "A=1", "--label", "ai.manager.model=", "--label", "x=a=b", "--gpus", "all", "--label"]),
    { "ai.manager": "llama-manager", "ai.manager.model": "", x: "a=b" },
  );
});

test("buildLaunch returns an ordered docker LaunchCommand", () => {
  const command = llamacpp.buildLaunch(basePlan(), baseCtx());
  assert.equal(llamacpp.id, "llamacpp");
  assert.equal(core.engines.adapters.llamacpp, llamacpp);
  assert.equal(command.host, "docker");
  assert.equal(command.docker.entrypoint, null);
  assert.equal(command.docker.image, "llama:pinned");
  assert.deepEqual(command.publish, ["127.0.0.1:8080:8080"]);
  assert.deepEqual(command.files, []);
  assert.deepEqual(command.metaPatch, {});
  assert.deepEqual(command.secretEnv, {});
  assert.deepEqual(command.redactions, []);
  assert.deepEqual(command.docker.flags.slice(0, 4), ["--name", "llama-local", "--restart", "on-failure:3"]);
  assert.deepEqual(command.docker.args.slice(0, 4), ["--model", "/models/qwen-vision/model.gguf", "--alias", "qwen-vision"]);
  assert.equal(valueAfter(command.docker.args, "--ctx-size"), "65536");
  assert.deepEqual(command.labels, labelsFromFlags(command.docker.flags));
  assert.equal(command.labels["ai.manager.job"], "serve-adapter");
  assert.equal(command.labels["ai.manager.engine"], "llama");
  const runArgs = renderRunArgs(command);
  assert.equal(runArgs.indexOf("llama:pinned"), 2 + command.docker.flags.length);
  assert.deepEqual(command.logs, [
    "GGUF model: using /models/qwen-vision/model.gguf",
    "Multimodal projector: C:/fixture/models/qwen-vision/mmproj-F16.gguf",
    "Docker publish: -p 127.0.0.1:8080:8080",
    "Context budget: 32768 tokens per slot x 2 slots = --ctx-size 65536.",
  ]);
});

test("runtime.features gate --reasoning-effort and --mmproj-device", () => {
  const supported = llamacpp.buildLaunch(basePlan(), baseCtx());
  assert.equal(valueAfter(supported.docker.args, "--reasoning-effort"), "high");
  assert.equal(valueAfter(supported.docker.args, "--mmproj-device"), "CUDA0");
  assert.equal(supported.labels["ai.manager.reasoning-effort"], "high");
  assert.equal(supported.labels["ai.manager.mmproj-device"], "CUDA0");

  // A custom image resolves to features {}: neither flag, the labels show the
  // defaults and the requested values are reported as left alone.
  const custom = llamacpp.buildLaunch(basePlan(), baseCtx({ runtime: { runtimeId: "llamacpp@custom", manifestKey: null, image: "example/llama:custom", features: {}, default: false } }));
  assert.equal(custom.docker.args.includes("--reasoning-effort"), false);
  assert.equal(custom.docker.args.includes("--mmproj-device"), false);
  assert.equal(custom.labels["ai.manager.reasoning-effort"], "default");
  assert.equal(custom.labels["ai.manager.mmproj-device"], "auto");
  assert.ok(custom.logs.includes("Runtime example/llama:custom predates --reasoning-effort; requested high was left at template default."));
  assert.ok(custom.logs.includes("Runtime example/llama:custom predates --mmproj-device; requested CUDA0 was left at auto."));
  // A missing features object reads the same as {}.
  const bare = llamacpp.buildLaunch(basePlan(), baseCtx({ runtime: { features: undefined } }));
  assert.deepEqual(bare.docker.args, custom.docker.args);

  // Each feature gates its own flag.
  const partial = llamacpp.buildLaunch(basePlan(), baseCtx({ runtime: { features: { reasoningEffort: true, mmprojDevice: false } } }));
  assert.equal(valueAfter(partial.docker.args, "--reasoning-effort"), "high");
  assert.equal(partial.docker.args.includes("--mmproj-device"), false);
  assert.equal(partial.labels["ai.manager.mmproj-device"], "auto");
});

test("plan values wrapped with provenance build the same command as plain values", () => {
  const plain = basePlan();
  const wrapped = basePlan();
  wrapped.values = Object.fromEntries(Object.entries(plain.values).map(([id, value]) => [id, { value, source: "user" }]));
  assert.deepEqual(llamacpp.buildLaunch(wrapped, baseCtx()), llamacpp.buildLaunch(plain, baseCtx()));
});

test("buildLaunch is pure: frozen inputs, no environment reads", () => {
  const previous = process.env.HF_TOKEN;
  process.env.HF_TOKEN = FAKE_HF_TOKEN;
  try {
    const plan = deepFreeze(basePlan());
    const ctx = deepFreeze(baseCtx());
    const first = llamacpp.buildLaunch(plan, ctx);
    assert.deepEqual(llamacpp.buildLaunch(plan, ctx), first);
    // The HF token reaches a launch only through ctx.secrets.
    assert.equal(renderRunArgs(first).includes("HF_TOKEN"), false);
    assert.deepEqual(first.secretEnv, {});
  } finally {
    if (previous === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previous;
  }
});

test("secrets travel by name only and come back for the docker child and the redactor", () => {
  const command = llamacpp.buildLaunch(
    basePlan({ secrets: { apiKey: FAKE_API_KEY, apiKeyRef: "runtime-secret-ref" } }),
    baseCtx({ secrets: { hfToken: FAKE_HF_TOKEN } }),
  );
  const runArgs = renderRunArgs(command);
  const imageIndex = runArgs.indexOf("llama:pinned");
  assert.deepEqual(runArgs.slice(imageIndex - 4, imageIndex), ["-e", "HF_TOKEN", "-e", "LLAMA_API_KEY"]);
  assert.deepEqual(command.secretEnv, { HF_TOKEN: FAKE_HF_TOKEN, LLAMA_API_KEY: FAKE_API_KEY });
  assert.deepEqual([...command.redactions].sort(), [FAKE_API_KEY, FAKE_HF_TOKEN].sort());
  assert.equal(JSON.stringify(runArgs).includes(FAKE_API_KEY), false);
  assert.equal(JSON.stringify(runArgs).includes(FAKE_HF_TOKEN), false);
  assert.equal(runArgs.includes("--api-key"), false);
  assert.equal(command.labels["ai.manager.api-key-ref"], "runtime-secret-ref");
  // The env name is the one the bundled descriptor declares (01 §18).
  const descriptor = core.engines.createEngineRegistry({ env: {} }).get("llamacpp");
  assert.deepEqual(descriptor.secrets.apiKey, { mode: "env", env: llamacpp.API_KEY_ENV });
});

test("an applied recipe supplies runtime and sampling defaults without a model-family branch", () => {
  const recipe = { id: "llama-muse-glimmer", runtime: { ref: "llamaMuse" }, values: { temperature: 1, topP: 0.95, topK: 64 }, legacy: { presetLabel: "Muse Glimmer" } };
  const museRuntime = { runtimeId: "llamacpp@muse-62bf73d", manifestKey: "llamaMuse", image: "local/llama.cpp:muse", features: { reasoningEffort: false, mmprojDevice: false }, default: false };
  const applied = llamacpp.buildLaunch(basePlan({ recipe }), baseCtx({ runtime: museRuntime }));
  assert.deepEqual(applied.docker.args.slice(-6), ["--temp", "1", "--top-p", "0.95", "--top-k", "64"]);
  assert.ok(applied.logs.includes("Muse Glimmer runtime image: local/llama.cpp:muse"));
  assert.equal(applied.logs.at(-1), "Muse Glimmer sampling defaults: temp=1, top-p=0.95, top-k=64.");

  // A user value wins; one out of range falls back to the recipe value.
  const user = llamacpp.buildLaunch(basePlan({ recipe, values: { temperature: 0.6, topP: 7, topK: "40" } }), baseCtx({ runtime: museRuntime }));
  assert.deepEqual(user.docker.args.slice(-6), ["--temp", "0.6", "--top-p", "0.95", "--top-k", "40"]);

  // The runtime line appears only when the recipe's runtime is not the configured default.
  const onDefault = llamacpp.buildLaunch(basePlan({ recipe }), baseCtx());
  assert.equal(onDefault.logs.some((line) => line.includes("runtime image")), false);

  // No recipe, no sampling flags.
  const none = llamacpp.buildLaunch(basePlan(), baseCtx());
  assert.equal(none.docker.args.includes("--temp"), false);
  assert.equal(none.logs.some((line) => line.includes("sampling defaults")), false);
});

test("a failed build throws the builder's error with the lines logged before it", () => {
  const ctx = baseCtx({ model: { ggufFiles: [{ path: "C:/fixture/models/qwen/model.gguf" }] } });
  assert.throws(() => llamacpp.buildLaunch(basePlan(), ctx), (error) => {
    assert.equal(error.message, "Multimodal mode requires an mmproj GGUF file in the model directory or an explicit mmproj path.");
    assert.deepEqual(error.logs, ["GGUF model: using /models/qwen-vision/model.gguf"]);
    return true;
  });
  const dflash = basePlan({ values: { "llamacpp.textOnly": true, "speculative.method": "draft-dflash" } });
  assert.throws(() => llamacpp.buildLaunch(dflash, baseCtx()), (error) => {
    assert.equal(error.message, "draft-dflash requires a local DFlash GGUF draft model.");
    assert.equal(error.logs.at(-1), "Context budget: 32768 tokens per slot x 2 slots = --ctx-size 65536.");
    return true;
  });
});

test("planFromRunOptions maps run options to catalog param ids", () => {
  const plan = llamacpp.planFromRunOptions({
    model: "C:/fixture/models/qwen/model.gguf",
    name: "qwen",
    maxModelLen: 8192,
    maxNumSeqs: 4,
    gpuMemoryUtilization: 0.92,
    multiGpuMode: "layer",
    top_p: 0.8,
    top_k: 20,
    textOnlyMode: "off",
    speculativeMode: "auto",
    llamaApiKey: FAKE_API_KEY,
    runtimeApiKeyRef: "ref-1",
    gpuDeviceIds: ["0", "1"],
    port: 8081,
    instanceMode: "parallel",
    instanceId: "qwen",
    containerName: "llama-local-qwen",
    gpuAdmissionLeaseId: "lease-1",
    vramReservationMb: 4096,
  }, { jobId: "serve-9" });
  assert.deepEqual(plan.values, {
    servedName: "qwen",
    contextLength: 8192,
    concurrency: 4,
    "llamacpp.planningUtilization": 0.92,
    "llamacpp.splitMode": "layer",
    "speculative.method": "auto",
    topP: 0.8,
    topK: 20,
    "llamacpp.textOnly": false,
  });
  assert.deepEqual(plan.instance, { mode: "parallel", id: "qwen", port: 8081, networkAccess: undefined, serviceHost: undefined, gpuIds: ["0", "1"], containerName: "llama-local-qwen" });
  assert.deepEqual(plan.secrets, { apiKey: FAKE_API_KEY, apiKeyRef: "ref-1" });
  assert.deepEqual(plan.launch, { jobId: "serve-9", gpuAdmissionLeaseId: "lease-1", vramReservationMb: 4096, gpuPlan: undefined });
  assert.equal(plan.recipe, null);
  // Text-only stays on unless a value turns it off.
  assert.equal(llamacpp.planFromRunOptions({}).values["llamacpp.textOnly"], true);
});
