"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const harness = require("./helpers/engine-golden-stubs");

// 01-engines §8.3: the engine adapters reproduce the golden fixtures. Every
// fixture runs through the shared harness with the manager's builder module
// swapped for a bridge that calls adapter.buildLaunch itself and renders argv
// with the shared docker renderer, so runArgs, publish args, the secret
// channel, job meta and log lines all come from the adapter's LaunchCommand.
// The bridge borrows only the legacy plan mapping (run options -> plan, model
// and runtime resolution) from the manager wrapper.
//
// ENG-4 covers llama.cpp (G-L1..3, P-L01..05); the request goldens (R-*) do
// not reach a builder.

const env = harness.prepareGoldenEnvironment();
const core = require("../index");
const { labelsFromFlags, renderRunArgs } = require("../engines/adapters/_docker-segments");

const LLAMA_WRAPPER = path.join(harness.REPO_ROOT, "llama-manager", "lib", "runtime-command.js");
const LLAMA_ADAPTER_CODES = ["G-L1", "G-L2", "G-L3", "P-L01", "P-L02", "P-L03", "P-L04", "P-L05"];

const fixtures = harness.loadGoldenFixtures();
const codeOf = (fixture) => fixture.id.split("-").slice(0, 2).join("-");
const llamaFixtures = fixtures.filter((fixture) => fixture.manager === "llama" && ["builder", "profile"].includes(fixture.kind));

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

function canonical(value) {
  return harness.canonicalizeValue(harness.toJsonValue(value), env);
}

test("the llama.cpp adapter golden set holds every builder and profile case", () => {
  assert.deepEqual(llamaFixtures.map(codeOf).sort(), [...LLAMA_ADAPTER_CODES].sort());
});

for (const fixture of llamaFixtures) {
  test(`${fixture.id} is reproduced by the llamacpp adapter`, async () => {
    const launches = [];
    const result = await harness.runGoldenFixture(fixture, { llamaRuntimeCommand: llamaAdapterBridge(launches) });
    assert.deepEqual(result, fixture.expect);

    // The LaunchCommand behind that result (01 §6).
    assert.equal(launches.length, 1);
    const [{ command }] = launches;
    const { expect } = fixture;
    assert.equal(command.host, "docker");
    assert.equal(command.docker.entrypoint, null);
    assert.deepEqual(command.files, []);
    assert.deepEqual(command.metaPatch, {});
    assert.deepEqual(canonical(renderRunArgs(command)), expect.runArgs);
    assert.deepEqual(canonical(command.docker.flags), expect.runArgs.slice(2, expect.runArgs.indexOf(expect.runtimeImage)));
    assert.equal(canonical(command.docker.image), expect.runtimeImage);
    assert.deepEqual(canonical(command.publish), expect.activePublishArgs);
    // The secret channel is pinned by name: every secret is a name-only -e flag
    // before the image, its value is only in secretEnv and redactions.
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
