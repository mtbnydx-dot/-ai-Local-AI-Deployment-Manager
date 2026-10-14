"use strict";

// 01-engines §8.3 / §25: the engine adapters reproduce the golden fixtures.
// Each builder and profile fixture runs through the harness with a runtime
// command module that calls the adapter itself: the legacy inputs are mapped
// by the manager wrapper (prepareLaunch), the adapter the registry names
// builds the LaunchCommand, and the legacy result is read back from that
// command alone (renderRunArgs, publish, secretEnv, metaPatch, logs). runArgs,
// activePublishArgs, secretEnvNames, runtimeImage and runtimeEngine must match
// exactly, jobMeta deep-equal and logs exactly.
//
// Preset (PRE-*) and request (R-*) fixtures do not reach an adapter; they move
// with recipes (ENG-6) and the launch-plan resolver (ENG-7).

const test = require("node:test");
const assert = require("node:assert/strict");
const harness = require("./helpers/engine-golden-stubs");

harness.prepareGoldenEnvironment();

const engines = require("../engines");
const vllmRuntimeCommand = require("../../vllm-manager/lib/runtime-command");

const ADAPTER_KINDS = new Set(["builder", "profile"]);
const fixtures = harness.loadGoldenFixtures().filter((fixture) => ADAPTER_KINDS.has(fixture.kind));
const code = (fixture) => fixture.id.split("-").slice(0, 2).join("-");

const VLLM_ADAPTER_CODES = [
  "G-V1", "G-V2", "G-V3a", "G-V3b", "G-V4", "G-S1", "G-S2", "G-S3",
  "P-V01", "P-V02", "P-V03", "P-V04", "P-V05", "P-V06", "P-V07", "P-V08", "P-V09", "P-V10",
];

// The LaunchCommand invariants every adapter build must hold (01 §6).
function assertLaunchCommand(command, ctx) {
  assert.equal(command.host, "docker");
  assert.ok(Array.isArray(command.docker.flags) && Array.isArray(command.docker.args));
  assert.equal(command.docker.image, ctx.runtime.image);
  assert.deepEqual(command.files, []);
  const pairs = {};
  for (let index = 0; index < command.docker.flags.length - 1; index += 1) {
    if (command.docker.flags[index] !== "--label") continue;
    const pair = command.docker.flags[index + 1];
    pairs[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
  }
  assert.deepEqual(command.labels, pairs);
  for (const secret of [ctx.secrets.apiKey, ctx.secrets.hfToken].filter(Boolean)) {
    assert.ok(command.redactions.includes(String(secret)));
    assert.equal(command.docker.flags.some((flag) => String(flag).includes(String(secret))), false);
  }
}

// A vllm-manager runtime command module that builds through the adapters.
function adapterRuntimeCommand(calls) {
  const registry = engines.getEngineRegistry();
  function replay(job, deps, { metaPatch, logs }) {
    if (metaPatch) {
      job.meta = { ...job.meta, ...metaPatch };
      deps.scheduleJobsSave();
    }
    for (const line of logs) deps.appendLog(job, line);
  }
  return {
    normalizeRuntimeEngine: vllmRuntimeCommand.normalizeRuntimeEngine,
    createVllmRuntimeCommandBuilder(deps) {
      const { prepareLaunch } = vllmRuntimeCommand.createVllmRuntimeCommandBuilder(deps);
      return {
        buildVllmRuntimeCommand(job, opts) {
          const { engineId, plan, ctx, preset } = prepareLaunch(job, opts);
          const adapter = engines.adapterFor(registry.get(engineId));
          assert.ok(adapter, `no adapter for ${engineId}`);
          calls.push(adapter.id);
          let command;
          try {
            command = adapter.buildLaunch(plan, ctx);
          } catch (error) {
            if (error.code !== "blocked") throw error;
            replay(job, deps, error.launch);
            throw new Error(error.message);
          }
          assertLaunchCommand(command, ctx);
          replay(job, deps, command);
          return {
            runArgs: engines.renderRunArgs(command),
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

test("every vLLM and SGLang builder and profile golden has an adapter case", () => {
  const codes = fixtures.filter((fixture) => fixture.manager === "vllm").map(code);
  assert.deepEqual([...codes].sort(), [...VLLM_ADAPTER_CODES].sort());
});

for (const fixture of fixtures) {
  if (fixture.manager !== "vllm") {
    test(`${fixture.id} is reproduced by the llamacpp adapter`, { skip: "the llamacpp adapter lands in ENG-4" }, () => {});
    continue;
  }
  test(`${fixture.id} is reproduced by the ${fixture.expect.runtimeEngine} adapter`, async () => {
    const calls = [];
    const actual = await harness.runGoldenFixture(fixture, { vllmRuntimeCommand: adapterRuntimeCommand(calls) });
    assert.deepEqual(actual, fixture.expect);
    assert.deepEqual(calls, [fixture.expect.runtimeEngine]);
  });
}
