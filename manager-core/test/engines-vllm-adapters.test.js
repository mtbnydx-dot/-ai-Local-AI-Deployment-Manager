"use strict";

// The vllm and sglang tier-1 adapters (docs/overhaul/01-engines.md §6-§7,
// ENG-5): the LaunchCommand shape, purity (host facts and secrets only through
// ctx), the recipe slots the SGLang adapter consumes in legacy order, the
// blocked error, renderRunArgs and the no-family-branch rule. The byte-for-byte
// argv of every vLLM/SGLang golden is asserted by engines-golden.test.js.

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
const segments = require("../engines/adapters/_docker-segments");

const engines = core.engines;
const registry = engines.createEngineRegistry({ env: {}, overrideDir: EMPTY_CONFIG_DIR });
const FAKE_KEY = "fixture-api-key-0001";
const FAKE_HF_TOKEN = "fixture-hf-token-0001";

function basePlan(overrides = {}) {
  return {
    engineId: "vllm",
    values: {
      servedName: "fixture-model",
      contextLength: 32768,
      concurrency: 4,
      dtype: "auto",
      quantization: "",
      kvCacheDtype: "auto",
      "vllm.gpuMemoryUtilization": 0.9,
      "sglang.memFractionStatic": 0.85,
    },
    fixed: { args: [], env: {}, labels: [], dockerFlags: [], slots: {} },
    instance: { port: 8001, networkAccess: "local", serviceHost: "127.0.0.1", gpuIds: ["0"] },
    legacy: { preset: {}, runOptions: {}, quantization: {} },
    ...overrides,
  };
}

function baseCtx(engineId, overrides = {}) {
  const calls = [];
  const ctx = {
    descriptor: registry.get(engineId),
    runtime: { runtimeId: `${engineId}@fixture`, manifestKey: null, image: `fixture/${engineId}:pinned`, features: {}, compatVersion: null },
    host: {
      kind: "docker",
      containerPort: 8000,
      config: {
        modelsRoot: "C:/fixture/models",
        hfCache: "C:/fixture/cache/hf",
        vllmCache: "C:/fixture/cache/vllm",
        sglangCache: "C:/fixture/cache/sglang",
        containerName: "vllm-local",
        managerLabelValue: "vllm-manager",
      },
      labelKeys: { manager: "ai.manager", engine: "ai.manager.engine", apiKeyRef: "ai.manager.api-key-ref" },
      modelMountArgs: ["-v", "C:/fixture/models:/models"],
    },
    model: { modelArg: "/models/fixture-model", effectiveLoadFormat: "auto", localPath: "C:/fixture/models/fixture-model" },
    hostFacts: { platform: "linux", gpus: [], env: {} },
    secrets: {},
    jobId: "serve-fixture",
    admission: { leaseId: "lease-fixture", vramReservationMb: 1234 },
    launchId: null,
    toContainerPath: (value) => String(value).replace("C:/fixture/models", "/models"),
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port, _access, host) => {
      calls.push("dockerPublishArgs");
      return [`${host || "127.0.0.1"}:${port}:8000`];
    },
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    normalizeGpuIds: (ids) => ids || [],
    lanAddress: () => {
      calls.push("lanAddress");
      return "192.0.2.10";
    },
    ...overrides,
  };
  return { ctx, calls };
}

function valueAfter(list, flag) {
  const index = list.indexOf(flag);
  return index >= 0 ? list[index + 1] : undefined;
}

function withProcessEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("core.engines resolves the vllm and sglang descriptors to their adapters", () => {
  assert.equal(engines.adapterFor(registry.get("vllm")), engines.adapters.vllm);
  assert.equal(engines.adapterFor(registry.get("sglang")), engines.adapters.sglang);
  assert.equal(engines.adapterFor("vllm"), engines.adapters.vllm);
  assert.equal(engines.adapters.vllm.id, "vllm");
  assert.equal(engines.adapters.sglang.id, "sglang");
  assert.equal(engines.adapterFor("no-such-adapter"), null);
  assert.equal(engines.adapterFor(null), null);
  assert.equal(engines.adapterFor({ adapter: "__proto__" }), null);
});

test("renderRunArgs puts flags, the entrypoint and the image back in docker order", () => {
  const command = { docker: { flags: ["--name", "x"], entrypoint: "sglang", image: "img:1", args: ["serve", "--port", "8000"] } };
  assert.deepEqual(engines.renderRunArgs(command), ["run", "-d", "--name", "x", "--entrypoint", "sglang", "img:1", "serve", "--port", "8000"]);
  assert.deepEqual(engines.renderRunArgs({ docker: { ...command.docker, entrypoint: null } }), ["run", "-d", "--name", "x", "img:1", "serve", "--port", "8000"]);
  assert.deepEqual(segments.labelsFromFlags(["--label", "a=1", "-e", "X=2", "--label", "b=x=y", "--label", "a=3"]), { a: "3", b: "x=y" });
  assert.deepEqual(segments.envAssignmentFlags({ A: "1", B: "", C: null, D: 0 }), ["-e", "A=1", "-e", "D=0"]);
});

test("the vLLM adapter returns a LaunchCommand with the key only in the secret channel", (t) => {
  // The adapter is pure: process env values must not reach the command.
  withProcessEnv(t, { HF_TOKEN: "process-hf-token-ignored", VLLM_START_TIMEOUT_MS: "600000" });
  const { ctx } = baseCtx("vllm", { secrets: { apiKey: FAKE_KEY, apiKeyRef: "ref-fixture", hfToken: FAKE_HF_TOKEN } });
  const command = engines.adapters.vllm.buildLaunch(basePlan(), ctx);

  assert.equal(command.host, "docker");
  assert.equal(command.docker.entrypoint, null);
  assert.equal(command.docker.image, "fixture/vllm:pinned");
  assert.deepEqual(command.docker.args.slice(0, 2), ["--model", "/models/fixture-model"]);
  assert.deepEqual(command.publish, ["127.0.0.1:8001:8000"]);
  assert.deepEqual(command.secretEnv, { HF_TOKEN: FAKE_HF_TOKEN, VLLM_API_KEY: FAKE_KEY });
  assert.deepEqual(command.redactions, [FAKE_KEY, FAKE_HF_TOKEN]);
  assert.deepEqual(command.files, []);
  assert.equal(command.metaPatch, null);
  const argv = engines.renderRunArgs(command);
  assert.equal(argv.some((arg) => String(arg).includes(FAKE_KEY) || String(arg).includes(FAKE_HF_TOKEN)), false);
  assert.equal(argv.includes("--api-key"), false);
  assert.ok(argv.indexOf("VLLM_API_KEY") < argv.indexOf("fixture/vllm:pinned"));
  assert.equal(valueAfter(command.docker.flags, "--health-start-period"), "60m");
  assert.equal(command.labels["ai.manager.engine"], "vllm");
  assert.equal(command.labels["ai.manager.api-key-ref"], "ref-fixture");
  assert.equal(command.labels["ai.manager.gpu-memory-utilization"], "0.9");
  assert.equal(command.labels["ai.manager.vram-reservation-mb"], "1234");
  assert.equal(command.labels["ai.manager.gpu-admission-lease"], "lease-fixture");
  assert.deepEqual(command.logs, ["Docker publish: -p 127.0.0.1:8001:8000", "GPU isolation: --gpus device=0"]);

  // Host facts come from ctx only.
  const timed = engines.adapters.vllm.buildLaunch(basePlan(), baseCtx("vllm", { hostFacts: { env: { VLLM_START_TIMEOUT_MS: "600000" } } }).ctx);
  assert.equal(valueAfter(timed.docker.flags, "--health-start-period"), "10m");
  assert.deepEqual(timed.secretEnv, {});
});

test("both adapters read values wrapped with their provenance like plain values", () => {
  const plain = basePlan({
    values: {
      ...basePlan().values,
      quantization: "fp8",
      chatTemplateKwargs: { enable_thinking: false },
      "sglang.maxRunningRequests": 2,
    },
  });
  const wrapped = {
    ...plain,
    values: Object.fromEntries(Object.entries(plain.values).map(([id, value]) => [id, { value, source: "user", reason: "fixture" }])),
  };
  for (const engineId of ["vllm", "sglang"]) {
    const expected = engines.adapters[engineId].buildLaunch({ ...plain, engineId }, baseCtx(engineId).ctx);
    const actual = engines.adapters[engineId].buildLaunch({ ...wrapped, engineId }, baseCtx(engineId).ctx);
    assert.deepEqual(actual, expected, engineId);
    assert.equal(valueAfter(actual.docker.args, "--default-chat-template-kwargs"), JSON.stringify({ enable_thinking: false }));
  }
  // The caller's plan is not rewritten.
  assert.deepEqual(wrapped.values.quantization, { value: "fp8", source: "user", reason: "fixture" });
});

test("the vLLM adapter honours the recipe slots and appends recipe args last", () => {
  const plan = basePlan({
    values: { ...basePlan().values, quantization: "fp8", kvCacheDtype: "fp8", "vllm.speculativeConfig": { method: "mtp", num_speculative_tokens: 3 } },
    fixed: {
      args: ["--fixed-tail", "1"],
      env: { VLLM_FIXTURE: "1", VLLM_EMPTY: "" },
      labels: ["ai.runtime.fixture=yes"],
      dockerFlags: ["--init"],
      slots: { modelArgStyle: "positional", disableQuantizationArg: true, disableKvCacheDtypeArg: true },
    },
  });
  const command = engines.adapters.vllm.buildLaunch(plan, baseCtx("vllm").ctx);
  assert.equal(command.docker.args[0], "/models/fixture-model");
  assert.equal(command.docker.args.includes("--model"), false);
  assert.equal(command.docker.args.includes("--quantization"), false);
  assert.equal(command.docker.args.includes("--kv-cache-dtype"), false);
  assert.equal(valueAfter(command.docker.args, "--speculative-config"), JSON.stringify({ method: "mtp", num_speculative_tokens: 3 }));
  assert.deepEqual(command.docker.args.slice(-2), ["--fixed-tail", "1"]);
  const flags = command.docker.flags;
  assert.ok(flags.indexOf("--init") > flags.indexOf("C:/fixture/models:/models"));
  assert.ok(flags.indexOf("ai.runtime.fixture=yes") > flags.indexOf("--init"));
  assert.ok(flags.indexOf("C:/fixture/cache/vllm:/root/.cache/vllm") > flags.indexOf("ai.runtime.fixture=yes"));
  assert.deepEqual(flags.slice(-2), ["-e", "VLLM_FIXTURE=1"]);
});

test("the SGLang adapter places every recipe slot where the legacy builder did", () => {
  const plan = basePlan({
    engineId: "sglang",
    values: {
      ...basePlan().values,
      "sglang.maxRunningRequests": 2,
      "sglang.maxTotalTokens": 65536,
      "speculative.method": "DSPARK",
      "speculative.draftModel": "C:/fixture/models/draft",
    },
    fixed: {
      args: ["--fixed-tail", "1"],
      env: { SGLANG_FIXTURE: "1" },
      labels: ["ai.runtime.fixture=yes"],
      dockerFlags: ["--init", "--ulimit", "memlock=-1:-1"],
      slots: { restart: "no", hfCacheMount: false, modelMountReadOnly: true, cacheMount: "type=volume,source=fixture-cache,target=/cache" },
    },
  });
  const { ctx } = baseCtx("sglang", { secrets: { apiKey: FAKE_KEY } });
  const command = engines.adapters.sglang.buildLaunch(plan, ctx);
  const flags = command.docker.flags;
  const args = command.docker.args;

  assert.equal(command.docker.entrypoint, "sglang");
  assert.equal(valueAfter(flags, "--restart"), "no");
  assert.equal(flags.some((flag) => String(flag).endsWith(":/root/.cache/huggingface")), false);
  assert.ok(flags.includes("C:/fixture/models:/models:ro"));
  const lastEngineLabel = flags.indexOf("ai.sglang.ple-offload-embedding=false");
  assert.ok(lastEngineLabel > 0);
  assert.equal(flags[lastEngineLabel + 1], "--init");
  assert.ok(flags.indexOf("ai.runtime.fixture=yes") > flags.indexOf("memlock=-1:-1"));
  assert.equal(valueAfter(flags, "--mount"), "type=volume,source=fixture-cache,target=/cache");
  assert.ok(flags.indexOf("--mount") > flags.indexOf("ai.runtime.fixture=yes"));
  assert.equal(flags.some((flag) => String(flag).startsWith("C:/fixture/cache/")), false);
  assert.equal(command.labels["ai.sglang.effective-max-running-requests"], "2");
  assert.equal(command.labels["ai.sglang.max-total-tokens"], "65536");
  assert.equal(command.labels["ai.manager.gpu-memory-utilization"], "0.85");
  assert.deepEqual(flags.slice(-2), ["-e", "SGLANG_FIXTURE=1"]);

  assert.equal(valueAfter(args, "--max-running-requests"), "2");
  assert.equal(valueAfter(args, "--mem-fraction-static"), "0.85");
  assert.equal(valueAfter(args, "--speculative-draft-model-path"), "/models/draft");
  assert.equal(valueAfter(args, "--speculative-dspark-block-size"), "7");
  // fixedArgsTail: after the DSPARK block and immediately before --api-key.
  assert.ok(args.indexOf("--fixed-tail") > args.indexOf("--speculative-draft-model-quantization"));
  assert.deepEqual(args.slice(-4), ["--fixed-tail", "1", "--api-key", FAKE_KEY]);
  // SGLang keeps the key in argv (08 O1): no env channel, listed for redaction.
  assert.deepEqual(command.secretEnv, {});
  assert.deepEqual(command.redactions, [FAKE_KEY]);
});

test("the SGLang adapter mounts its cache root, falling back to the vLLM cache like the builder", () => {
  const plan = basePlan({ engineId: "sglang" });
  const own = engines.adapters.sglang.buildLaunch(plan, baseCtx("sglang").ctx);
  assert.ok(own.docker.flags.includes("C:/fixture/cache/sglang:/root/.cache"));
  assert.ok(own.docker.flags.includes("C:/fixture/cache/hf:/root/.cache/huggingface"));
  assert.equal(valueAfter(own.docker.flags, "--restart"), "on-failure:3");
  const { ctx } = baseCtx("sglang");
  ctx.host.config = { ...ctx.host.config, sglangCache: "" };
  const fallback = engines.adapters.sglang.buildLaunch(plan, ctx);
  assert.ok(fallback.docker.flags.includes("C:/fixture/cache/vllm:/root/.cache/vllm"));
  assert.ok(own.docker.args.includes("--sleep-on-idle"));
  assert.equal(valueAfter(own.docker.args, "--chunked-prefill-size"), "8192");
  assert.equal(valueAfter(own.docker.args, "--max-running-requests"), "4");
});

test("a blocking preset throws before any docker helper runs and carries the partial job effects", () => {
  for (const engineId of ["vllm", "sglang"]) {
    const plan = basePlan({
      engineId,
      legacy: {
        preset: { id: "fixture-preset", label: "Fixture preset", notes: ["note one"], unsupportedReason: "fixture block reason" },
        runOptions: { maxNumSeqs: 4 },
        quantization: {},
      },
    });
    const { ctx, calls } = baseCtx(engineId);
    assert.throws(() => engines.adapters[engineId].buildLaunch(plan, ctx), (error) => {
      assert.equal(error.code, "blocked");
      assert.equal(error.message, "fixture block reason");
      assert.equal(error.findings[0].severity, "fail");
      assert.equal(error.findings[0].code, "recipe_blocked");
      assert.equal(error.launch.metaPatch.runtimePreset, "fixture-preset");
      assert.equal(error.launch.metaPatch.engine, engineId);
      assert.deepEqual(error.launch.logs, [
        `Runtime preset: Fixture preset; using ${engineId} image fixture/${engineId}:pinned.`,
        "Runtime preset note: note one",
        "Runtime preset blocked: fixture block reason",
      ]);
      return true;
    });
    assert.deepEqual(calls, []);
  }
});

test("a LAN launch without a key asks ctx for the LAN address only then", () => {
  const plan = basePlan({ instance: { ...basePlan().instance, networkAccess: "lan", serviceHost: "" } });
  const { ctx, calls } = baseCtx("vllm");
  const command = engines.adapters.vllm.buildLaunch(plan, ctx);
  assert.deepEqual(calls, ["dockerPublishArgs", "lanAddress"]);
  assert.ok(command.logs.some((line) => line.includes("192.0.2.10")));
  const keyed = baseCtx("vllm", { secrets: { apiKey: FAKE_KEY } });
  engines.adapters.vllm.buildLaunch(plan, keyed.ctx);
  assert.deepEqual(keyed.calls, ["dockerPublishArgs"]);
});

// D5 / ENG-23: model behaviour comes from recipe data, never from a branch.
test("the vllm and sglang adapters carry no model-family branch", () => {
  const dir = path.join(__dirname, "..", "engines", "adapters");
  const patterns = [/isQwen/, /isPennyroyal/, /isDiffusionGemma/, /flashNext/i, /museGlimmer/i, /=== "sglang"/, /=== "vllm"/, /=== "llama"/, /supportsB10630/];
  for (const file of ["vllm.js", "sglang.js", "_vllm-manager.js", "_docker-segments.js"]) {
    const code = fs.readFileSync(path.join(dir, file), "utf8");
    for (const pattern of patterns) assert.equal(pattern.test(code), false, `${file} matches ${pattern}`);
  }
});
