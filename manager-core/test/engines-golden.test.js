"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const harness = require("./helpers/engine-golden-stubs");

// 01-engines §8.3 / §25: the engine adapters reproduce the golden fixtures.
// Every builder and profile fixture runs through the shared harness with the
// manager's builder module swapped for a bridge that calls adapter.buildLaunch
// itself and renders argv with the shared docker renderer, so runArgs, publish
// args, the secret channel, job meta and log lines all come from the adapter's
// LaunchCommand. The bridge borrows only the legacy plan mapping (run options
// -> plan, model and runtime resolution) from the manager wrapper. runArgs,
// activePublishArgs, secretEnvNames, runtimeImage and runtimeEngine must match
// exactly, jobMeta deep-equal and logs exactly.
//
// ENG-4 covers llama.cpp (G-L1..3, P-L01..05); ENG-5 covers vLLM and SGLang
// (G-V*, G-S*, P-V*). Preset (PRE-*) and request (R-*) fixtures do not reach an
// adapter; they move with recipes (ENG-6) and the launch-plan resolver (ENG-7).

const env = harness.prepareGoldenEnvironment();
const core = require("../index");
const { labelsFromFlags, renderRunArgs } = require("../engines/adapters/_docker-segments");

const LLAMA_WRAPPER = path.join(harness.REPO_ROOT, "llama-manager", "lib", "runtime-command.js");
const VLLM_WRAPPER = path.join(harness.REPO_ROOT, "vllm-manager", "lib", "runtime-command.js");
const LLAMA_ADAPTER_CODES = ["G-L1", "G-L2", "G-L3", "P-L01", "P-L02", "P-L03", "P-L04", "P-L05"];
const VLLM_ADAPTER_CODES = [
  "G-V1", "G-V2", "G-V3a", "G-V3b", "G-V4", "G-S1", "G-S2", "G-S3",
  "P-V01", "P-V02", "P-V03", "P-V04", "P-V05", "P-V06", "P-V07", "P-V08", "P-V09", "P-V10",
];

const fixtures = harness.loadGoldenFixtures();
const codeOf = (fixture) => fixture.id.split("-").slice(0, 2).join("-");
const adapterFixtures = (manager) => fixtures.filter((fixture) => fixture.manager === manager && ["builder", "profile"].includes(fixture.kind));
const llamaFixtures = adapterFixtures("llama");
const vllmFixtures = adapterFixtures("vllm");

function canonical(value) {
  return harness.canonicalizeValue(harness.toJsonValue(value), env);
}

// The LaunchCommand behind a golden result (01 §6): the rendered argv, its
// segments, the publish args and the secret channel all equal the golden.
// Every secret in secretEnv is a name-only -e flag before the image, and its
// value is only in secretEnv and redactions.
function assertLaunchCommandMatches(command, expect) {
  assert.equal(command.host, "docker");
  assert.deepEqual(command.files, []);
  assert.deepEqual(canonical(renderRunArgs(command)), expect.runArgs);
  const flagsEnd = expect.runArgs.indexOf(command.docker.entrypoint ? "--entrypoint" : expect.runtimeImage);
  assert.deepEqual(canonical(command.docker.flags), expect.runArgs.slice(2, flagsEnd));
  assert.equal(canonical(command.docker.image), expect.runtimeImage);
  assert.deepEqual(canonical(command.publish), expect.activePublishArgs);
  assert.deepEqual(Object.keys(command.secretEnv).sort(), expect.secretEnvNames);
  const argvText = JSON.stringify(renderRunArgs(command));
  for (const [name, secret] of Object.entries(command.secretEnv)) {
    assert.ok(command.redactions.includes(secret), name);
    assert.equal(argvText.includes(secret), false, name);
    const at = command.docker.flags.indexOf(name);
    assert.equal(command.docker.flags[at - 1], "-e", name);
  }
  // labels mirrors the --label pairs of the flags.
  assert.deepEqual(command.labels, labelsFromFlags(command.docker.flags));
}

// ---------------------------------------------------------------------------
// llama.cpp (ENG-4)

// A llama-manager runtime-command module whose builder goes straight to the
// adapter. Every { plan, ctx, command } it builds is collected for the checks
// below.
function llamaAdapterBridge(launches) {
  const wrapper = require(LLAMA_WRAPPER);
  return {
    ...wrapper,
    createLlamaRuntimeCommandBuilder(deps) {
      const builder = wrapper.createLlamaRuntimeCommandBuilder(deps);
      return {
        ...builder,
        buildLlamaRuntimeCommand(job, opts) {
          const { plan, ctx } = builder.planLlamaLaunch(job, opts);
          let command;
          try {
            command = core.engines.adapters.llamacpp.buildLaunch(plan, ctx);
          } catch (error) {
            for (const line of error?.logs || []) deps.appendLog(job, line);
            throw error;
          }
          launches.push({ plan, ctx, command });
          for (const line of command.logs) deps.appendLog(job, line);
          return {
            runArgs: renderRunArgs(command),
            activePublishArgs: command.publish,
            runtimeImage: command.docker.image,
            secretEnv: command.secretEnv,
          };
        },
      };
    },
  };
}

test("the llama.cpp adapter golden set holds every builder and profile case", () => {
  assert.deepEqual(llamaFixtures.map(codeOf).sort(), [...LLAMA_ADAPTER_CODES].sort());
});

for (const fixture of llamaFixtures) {
  test(`${fixture.id} is reproduced by the llamacpp adapter`, async () => {
    const launches = [];
    const result = await harness.runGoldenFixture(fixture, { llamaRuntimeCommand: llamaAdapterBridge(launches) });
    assert.deepEqual(result, fixture.expect);

    assert.equal(launches.length, 1);
    const [{ command }] = launches;
    const { expect } = fixture;
    assertLaunchCommandMatches(command, expect);
    assert.equal(command.docker.entrypoint, null);
    assert.deepEqual(command.metaPatch, {});
    assert.equal(command.labels["ai.manager.engine"], "llama");
    // The adapter's lines are the builder's; a profile run logs the launch
    // request's lines first.
    assert.deepEqual(canonical(command.logs), expect.logs.slice(expect.logs.length - command.logs.length));
    if (fixture.kind === "builder") assert.deepEqual(canonical(command.logs), expect.logs);
  });
}

// supportsB10630Controls is gone: the b10630 flags follow runtime.features.
test("llama goldens gate the b10630 controls on runtime features", async () => {
  const byCode = new Map(llamaFixtures.map((fixture) => [codeOf(fixture), fixture]));
  const launched = {};
  for (const code of ["G-L1", "G-L3", "P-L01"]) {
    const launches = [];
    await harness.runGoldenFixture(byCode.get(code), { llamaRuntimeCommand: llamaAdapterBridge(launches) });
    launched[code] = { runtime: launches[0].ctx.runtime, args: launches[0].command.docker.args };
  }
  assert.equal(launched["G-L1"].runtime.runtimeId, "llamacpp@b10630");
  assert.deepEqual(launched["G-L1"].runtime.features, { reasoningEffort: true, mmprojDevice: true });
  assert.ok(launched["G-L1"].args.includes("--reasoning-effort"));
  assert.equal(launched["P-L01"].runtime.runtimeId, "llamacpp@b10630");
  assert.ok(launched["P-L01"].args.includes("--reasoning-effort"));
  assert.equal(launched["G-L3"].runtime.runtimeId, "llamacpp@muse-62bf73d");
  assert.deepEqual(launched["G-L3"].runtime.features, { reasoningEffort: false, mmprojDevice: false });
  assert.equal(launched["G-L3"].args.includes("--reasoning-effort"), false);
  assert.equal(launched["G-L3"].args.includes("--mmproj-device"), false);
});

// ---------------------------------------------------------------------------
// vLLM and SGLang (ENG-5)

// A vllm-manager runtime-command module whose builder goes straight to the
// adapter the registry names for the launch's engine. Every { engineId, plan,
// ctx, command } it builds is collected for the checks below.
function vllmAdapterBridge(launches) {
  const wrapper = require(VLLM_WRAPPER);
  const registry = core.engines.getEngineRegistry();
  function replay(job, deps, { metaPatch, logs }) {
    if (metaPatch) {
      job.meta = { ...job.meta, ...metaPatch };
      deps.scheduleJobsSave();
    }
    for (const line of logs) deps.appendLog(job, line);
  }
  return {
    ...wrapper,
    createVllmRuntimeCommandBuilder(deps) {
      const builder = wrapper.createVllmRuntimeCommandBuilder(deps);
      return {
        ...builder,
        buildVllmRuntimeCommand(job, opts) {
          const { engineId, plan, ctx, preset } = builder.prepareLaunch(job, opts);
          const adapter = core.engines.adapterFor(registry.get(engineId));
          assert.ok(adapter, `no adapter for ${engineId}`);
          let command;
          try {
            command = adapter.buildLaunch(plan, ctx);
          } catch (error) {
            if (error?.launch) replay(job, deps, error.launch);
            if (error?.code === "blocked") throw new Error(error.message);
            throw error;
          }
          launches.push({ engineId, adapterId: adapter.id, plan, ctx, command });
          replay(job, deps, command);
          return {
            runArgs: renderRunArgs(command),
            activePublishArgs: command.publish,
            runtimeImage: command.docker.image,
            runtimePreset: preset,
            runtimeEngine: registry.toLegacy(engineId),
            secretEnv: command.secretEnv,
          };
        },
      };
    },
  };
}

test("the vLLM and SGLang adapter golden set holds every builder and profile case", () => {
  assert.deepEqual(vllmFixtures.map(codeOf).sort(), [...VLLM_ADAPTER_CODES].sort());
});

for (const fixture of vllmFixtures) {
  test(`${fixture.id} is reproduced by the ${fixture.expect.runtimeEngine} adapter`, async () => {
    const launches = [];
    const result = await harness.runGoldenFixture(fixture, { vllmRuntimeCommand: vllmAdapterBridge(launches) });
    assert.deepEqual(result, fixture.expect);

    assert.equal(launches.length, 1);
    const [{ adapterId, ctx, command }] = launches;
    const { expect } = fixture;
    assert.equal(adapterId, expect.runtimeEngine);
    assertLaunchCommandMatches(command, expect);
    assert.equal(command.docker.image, ctx.runtime.image);
    assert.equal(command.docker.entrypoint, adapterId === "sglang" ? "sglang" : null);
    assert.equal(command.labels["ai.manager.engine"], expect.runtimeEngine);
    // The preset's job.meta block is the adapter's metaPatch.
    for (const [key, value] of Object.entries(canonical(command.metaPatch || {}))) {
      assert.deepEqual(value, expect.jobMeta[key], key);
    }
    // The adapter's lines are the builder's; a profile run logs the launch
    // request's lines first.
    assert.deepEqual(canonical(command.logs), expect.logs.slice(expect.logs.length - command.logs.length));
    if (fixture.kind === "builder") assert.deepEqual(canonical(command.logs), expect.logs);
  });
}

// ---------------------------------------------------------------------------
// The whole golden set (ENG-23)
//
// Moved from the managers' engines-golden-legacy tests, which ENG-23 deletes:
// builder and profile fixtures run through the adapters above, preset
// fixtures (PRE-*) through the recipe shim in engines-recipes.test.js, and the
// request fixtures (R-*) here through the managers' launch-request
// normalisation, which the launch-plan resolver drives. The set, the secret
// channel and the host path separators are checked once for both managers.

const byCode = new Map(fixtures.map((fixture) => [codeOf(fixture), fixture]));
const REQUEST_CODES = ["R-L1", "R-L2", "R-V1", "R-V2", "R-V3"];
const PRESET_CODES = [
  "PRE-01", "PRE-02", "PRE-03", "PRE-04", "PRE-05", "PRE-06", "PRE-07", "PRE-08", "PRE-09", "PRE-10",
  "PRE-11", "PRE-12", "PRE-13", "PRE-14", "PRE-15", "PRE-16a", "PRE-16b", "PRE-17", "PRE-18", "PRE-19",
];

test("the golden set holds every builder, profile, preset and request case of both managers", () => {
  const expected = [...LLAMA_ADAPTER_CODES, ...VLLM_ADAPTER_CODES, ...PRESET_CODES, ...REQUEST_CODES].sort();
  assert.deepEqual([...byCode.keys()].sort(), expected);
  assert.equal(fixtures.length, expected.length);
  for (const fixture of fixtures) {
    assert.equal(fixture.schemaVersion, 1, fixture.id);
    assert.ok(Array.isArray(fixture.history) && fixture.history.length > 0, fixture.id);
    assert.equal(fixture.manager, codeOf(fixture).includes("L") ? "llama" : "vllm", fixture.id);
  }
});

for (const code of REQUEST_CODES) {
  test(`${code} is reproduced by the launch-request normalisation`, async () => {
    const fixture = byCode.get(code);
    assert.equal(fixture.kind, "request");
    assert.deepEqual(await harness.runGoldenFixture(fixture), fixture.expect);
  });
}

// A delivered key is recorded as the placeholder of its fake value, so these
// assertions fail if the code hands the redaction marker on instead of the key.
test("the goldens pin the secret channel by name and hold no key value", () => {
  for (const fixture of fixtures) {
    const text = JSON.stringify(fixture);
    for (const secret of Object.values(harness.FAKE_SECRETS)) assert.equal(text.includes(secret), false, fixture.id);
    if (fixture.kind === "builder" || fixture.kind === "profile") {
      assert.ok(Array.isArray(fixture.expect.secretEnvNames), fixture.id);
      assert.deepEqual(Object.keys(fixture.expect.secretEnv), fixture.expect.secretEnvNames, fixture.id);
    }
  }

  const llamaKey = byCode.get("G-L2");
  assert.equal(llamaKey.input.opts.llamaApiKey, "<secret:apiKey>");
  assert.deepEqual(llamaKey.expect.secretEnvNames, ["HF_TOKEN", "LLAMA_API_KEY"]);
  assert.deepEqual(llamaKey.expect.secretEnv, { HF_TOKEN: "<secret:hfToken>", LLAMA_API_KEY: "<secret:apiKey>" });
  const imageIndex = llamaKey.expect.runArgs.indexOf(llamaKey.expect.runtimeImage);
  // The four launch identity label pairs (01 §15.2) follow the secret env names.
  assert.deepEqual(llamaKey.expect.runArgs.slice(imageIndex - 12, imageIndex - 8), ["-e", "HF_TOKEN", "-e", "LLAMA_API_KEY"]);
  assert.equal(llamaKey.expect.runArgs[imageIndex - 7], "ai.manager.launch-id=");
  assert.equal(llamaKey.expect.runArgs.includes("--api-key"), false);
  assert.equal(JSON.stringify(llamaKey.expect.runArgs).includes("<secret:"), false);
  const llamaRequest = byCode.get("R-L1").expect;
  assert.equal(llamaRequest.runOptions.llamaApiKey, "<secret:apiKey>");
  assert.equal(llamaRequest.runOptions.runtimeApiKeyRef, "ref-<secret:apiKey>");

  const vllmKey = byCode.get("G-V1");
  assert.equal(vllmKey.input.opts.vllmApiKey, "<secret:apiKey>");
  assert.deepEqual(vllmKey.expect.secretEnvNames, ["HF_TOKEN", "VLLM_API_KEY"]);
  assert.deepEqual(vllmKey.expect.secretEnv, { HF_TOKEN: "<secret:hfToken>", VLLM_API_KEY: "<secret:apiKey>" });
  const keyAt = vllmKey.expect.runArgs.indexOf("VLLM_API_KEY");
  assert.deepEqual(vllmKey.expect.runArgs.slice(keyAt - 1, keyAt + 1), ["-e", "VLLM_API_KEY"]);
  assert.equal(vllmKey.expect.runArgs.includes("--api-key"), false);
  assert.equal(JSON.stringify(vllmKey.expect.runArgs).includes("<secret:"), false);
  // SGLang keeps --api-key in argv (08 O1): the real argv carries the key, so
  // the golden holds its placeholder, not the redactor's marker.
  const sglangKey = byCode.get("G-S3").expect;
  assert.equal(sglangKey.runArgs[sglangKey.runArgs.indexOf("--api-key") + 1], "<secret:apiKey>");
  assert.equal(sglangKey.runArgs.includes(harness.REDACTED), false);
  assert.deepEqual(sglangKey.secretEnvNames, []);
  assert.deepEqual(sglangKey.secretEnv, {});
  const vllmRequest = byCode.get("R-V1").expect;
  assert.equal(vllmRequest.compatibilityRequest.apiKey, "<secret:apiKey>");
  assert.equal(vllmRequest.runOptions.vllmApiKey, "<secret:apiKey>");
  assert.equal(vllmRequest.runOptions.runtimeApiKeyRef, "ref-<secret:apiKey>");
  assert.equal(byCode.get("R-V3").expect.runOptions.vllmApiKey, "<secret:apiKey>");
});

// Host paths keep the separators the managers emit: the model library and
// cache roots are native Windows paths in the mount arguments and job metadata.
test("the profile goldens hold the host path separators the managers emit", { skip: process.platform !== "win32" && "the goldens are captured on Windows" }, () => {
  // A native path under the canonical fixture root.
  const native = (...parts) => [harness.CANONICAL_ROOT_BACKSLASH, ...parts].join("\\");
  for (const code of ["P-L01", "P-L02", "P-L03", "P-L04", "P-L05"]) {
    const { expect, input } = byCode.get(code);
    assert.ok(expect.runArgs.includes(`${native("models")}:/models`), code);
    assert.ok(expect.runArgs.includes(`${native("ai", "cache", "huggingface")}:/root/.cache/huggingface`), code);
    assert.equal(expect.jobMeta.model, input.model, code);
    assert.equal(expect.jobMeta.resolvedModel, native("models", "Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf"), code);
  }
  const penny = byCode.get("P-V01").expect;
  assert.ok(penny.runArgs.includes(`${native("models")}:/models:ro`));
  const dspark = byCode.get("P-V04").expect;
  assert.ok(dspark.runArgs.includes(`${native("ai", "cache", "huggingface")}:/root/.cache/huggingface`));
  assert.ok(dspark.runArgs.includes(`${native("models")}:/models`));
  assert.equal(dspark.jobMeta.draftModel, native("models", "RadixArk-Qwen3.8-27B-DSpark"));
  assert.equal(dspark.jobMeta.model, `${harness.CANONICAL_ROOT}/models/Qwen-Qwen3.8-27B-FP8`);
  assert.equal(byCode.get("PRE-05").expect.preset.draftModel, native("models", "RadixArk-Qwen3.8-27B-DSpark"));
});
