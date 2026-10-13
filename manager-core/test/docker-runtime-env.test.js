"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("..");
const { buildDockerChildEnv, dockerRunWithRetries } = require("../docker-runtime");

const FAKE_KEY = "fixture-runtime-key-0123456789";
const FAKE_HF = "fixture-hf-token-value";

test("docker child env helpers are exported through the manager-core barrel", () => {
  assert.equal(core.buildDockerChildEnv, buildDockerChildEnv);
  assert.equal(core.dockerRunWithRetries, dockerRunWithRetries);
});

test("buildDockerChildEnv merges secrets over the base env without WSL", () => {
  const baseEnv = { PATH: "C:/bin", HF_TOKEN: "stale-value", WSLENV: "EXISTING/p" };
  const env = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY, HF_TOKEN: FAKE_HF }, { viaWsl: false, baseEnv });
  assert.equal(env.VLLM_API_KEY, FAKE_KEY);
  assert.equal(env.HF_TOKEN, FAKE_HF);
  assert.equal(env.PATH, "C:/bin");
  // WSLENV is only touched when docker runs through the WSL prefix.
  assert.equal(env.WSLENV, "EXISTING/p");
  // The base env is never mutated.
  assert.equal(baseEnv.HF_TOKEN, "stale-value");
  assert.equal(Object.hasOwn(baseEnv, "VLLM_API_KEY"), false);
});

test("buildDockerChildEnv defaults to process.env and skips empty or invalid names", () => {
  const env = buildDockerChildEnv({ LLAMA_API_KEY: FAKE_KEY, EMPTY_SECRET: "", "BAD NAME": "x", NULL_SECRET: null });
  assert.equal(env.LLAMA_API_KEY, FAKE_KEY);
  assert.equal(Object.hasOwn(env, "EMPTY_SECRET"), false);
  assert.equal(Object.hasOwn(env, "BAD NAME"), false);
  assert.equal(Object.hasOwn(env, "NULL_SECRET"), false);
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
  assert.equal(Object.hasOwn(process.env, "LLAMA_API_KEY") && process.env.LLAMA_API_KEY === FAKE_KEY, false);
});

test("buildDockerChildEnv appends NAME/u to WSLENV, keeps existing entries and dedupes", () => {
  const fresh = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY, HF_TOKEN: FAKE_HF }, { viaWsl: true, baseEnv: {} });
  assert.equal(fresh.WSLENV, "VLLM_API_KEY/u:HF_TOKEN/u");

  const merged = buildDockerChildEnv(
    { VLLM_API_KEY: FAKE_KEY, HF_TOKEN: FAKE_HF },
    { viaWsl: true, baseEnv: { WSLENV: "USERPROFILE/p:HF_TOKEN/u" } },
  );
  assert.equal(merged.WSLENV, "USERPROFILE/p:HF_TOKEN/u:VLLM_API_KEY/u");

  // Windows env names are case-insensitive: reuse the existing key's casing
  // and treat a differently-cased entry as already present.
  const cased = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY }, { viaWsl: true, baseEnv: { WslEnv: "vllm_api_key" } });
  assert.equal(cased.WslEnv, "vllm_api_key");
  assert.equal(Object.hasOwn(cased, "WSLENV"), false);

  // No secrets: nothing to forward, WSLENV stays as it was.
  const none = buildDockerChildEnv({}, { viaWsl: true, baseEnv: { WSLENV: "A/u" } });
  assert.equal(none.WSLENV, "A/u");
});

function fakeDocker(failures = []) {
  const calls = [];
  const docker = async (args, options) => {
    calls.push({ args, options });
    const failure = failures.shift();
    if (failure) throw failure;
    return { stdout: "container-id\n", stderr: "" };
  };
  return { docker, calls };
}

test("dockerRunWithRetries hands the same env to the first attempt", async () => {
  const env = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY }, { viaWsl: true, baseEnv: {} });
  const { docker, calls } = fakeDocker();
  const result = await dockerRunWithRetries({ docker, runArgs: ["run", "-d", "-e", "VLLM_API_KEY", "image"], dockerOptions: { env } });
  assert.equal(result.stdout, "container-id\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.VLLM_API_KEY, FAKE_KEY);
  assert.equal(calls[0].options.env.WSLENV, "VLLM_API_KEY/u");
});

test("dockerRunWithRetries passes the env to the name-conflict retry", async () => {
  const env = buildDockerChildEnv({ LLAMA_API_KEY: FAKE_KEY }, { baseEnv: {} });
  const conflict = Object.assign(new Error("Conflict. The container name is already in use"), { stderr: "Conflict" });
  const { docker, calls } = fakeDocker([conflict]);
  const events = [];
  await dockerRunWithRetries({
    docker,
    runArgs: ["run", "-d", "image"],
    dockerOptions: { env },
    isNameConflictError: (error) => error === conflict,
    onNameConflict: async () => events.push("removed"),
    getBindRetryArgs: () => assert.fail("a name conflict never takes the bind retry"),
  });
  assert.deepEqual(events, ["removed"]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, ["run", "-d", "image"]);
    assert.equal(call.options.env.LLAMA_API_KEY, FAKE_KEY);
  }
});

test("dockerRunWithRetries passes the env to the LAN wildcard-bind retry", async () => {
  const env = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY }, { baseEnv: {} });
  const bindError = Object.assign(new Error("bind: cannot assign requested address"), { stderr: "bind" });
  const { docker, calls } = fakeDocker([bindError]);
  await dockerRunWithRetries({
    docker,
    runArgs: ["run", "-d", "-p", "192.0.2.10:8000:8000", "image"],
    dockerOptions: { env },
    isNameConflictError: () => false,
    getBindRetryArgs: (error) => (error === bindError ? ["run", "-d", "-p", "0.0.0.0:8000:8000", "image"] : null),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ["run", "-d", "-p", "0.0.0.0:8000:8000", "image"]);
  for (const call of calls) assert.equal(call.options.env.VLLM_API_KEY, FAKE_KEY);
});

test("dockerRunWithRetries rethrows when no retry applies, and a failing retry propagates", async () => {
  const env = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY }, { baseEnv: {} });
  const fatal = new Error("image not found");
  const first = fakeDocker([fatal]);
  await assert.rejects(
    dockerRunWithRetries({ docker: first.docker, runArgs: ["run"], dockerOptions: { env }, getBindRetryArgs: () => null }),
    (error) => error === fatal,
  );
  assert.equal(first.calls.length, 1);

  const conflict = new Error("Conflict");
  const second = new Error("still conflicting");
  const both = fakeDocker([conflict, second]);
  await assert.rejects(
    dockerRunWithRetries({
      docker: both.docker,
      runArgs: ["run"],
      dockerOptions: { env },
      isNameConflictError: (error) => error === conflict,
    }),
    (error) => error === second,
  );
  assert.equal(both.calls.length, 2);
  for (const call of both.calls) assert.equal(call.options.env.VLLM_API_KEY, FAKE_KEY);
});

test("createDockerRuntime forwards the child env to execFile for docker run", async () => {
  const seen = [];
  const runtime = core.createDockerRuntime({
    dockerExe: "wsl.exe",
    dockerArgsPrefix: ["-d", "Distro", "--exec", "docker"],
    execFileCommand: (file, args, options, callback) => {
      seen.push({ file, args, options });
      callback(null, "id\n", "");
    },
  });
  const env = buildDockerChildEnv({ VLLM_API_KEY: FAKE_KEY }, { viaWsl: true, baseEnv: {} });
  await dockerRunWithRetries({ docker: runtime.docker, runArgs: ["run", "-d", "-e", "VLLM_API_KEY", "image"], dockerOptions: { env } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, "wsl.exe");
  assert.deepEqual(seen[0].args, ["-d", "Distro", "--exec", "docker", "run", "-d", "-e", "VLLM_API_KEY", "image"]);
  assert.equal(seen[0].options.env.VLLM_API_KEY, FAKE_KEY);
  assert.equal(seen[0].options.env.WSLENV, "VLLM_API_KEY/u");
  assert.ok(!seen[0].args.some((arg) => arg.includes(FAKE_KEY)));
});
