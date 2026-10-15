"use strict";

// DockerHost (docs/overhaul/01-engines.md §13, ENG-9). Docker is a fake: every
// call goes through an injected execFile / spawn, no docker process is started.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const core = require("..");
const { createDockerHost, createDockerHostConfig, parseDockerPullProgress, redactRunArgs } = require("../engines/hosts/docker");
const { renderRunArgs } = require("../engines/adapters/_docker-segments");
const { waitForRuntimeReady } = require("../runtime-wait");

const FAKE_KEY = "fixture-runtime-key-0123456789";
const FAKE_HF = "fixture-hf-token-value";
const PICK_FIRST = (candidates) => candidates.find(Boolean) || "";

function configFor(env, platformConfig, options = {}) {
  return createDockerHostConfig(env, platformConfig, { firstExisting: PICK_FIRST, ...options });
}

// handler(file, args, options, callNumber) -> {stdout, stderr} or {error, stderr}
function fakeExec(handler) {
  const calls = [];
  const execFileCommand = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const out = handler(file, args, options, calls.length) || {};
    const error = out.error ? Object.assign(new Error(out.error), { stderr: out.stderr || "" }) : null;
    setImmediate(() => callback(error, out.stdout || "", out.stderr || ""));
  };
  return { execFileCommand, calls };
}

const cmd = Object.freeze({
  docker: {
    flags: ["--name", "vllm-local", "-p", "127.0.0.1:8000:8000", "-e", "VLLM_API_KEY", "-e", "HF_TOKEN"],
    entrypoint: "",
    image: "vllm/vllm-openai:v0.0.0-test",
    args: ["--model", "/models/x", "--api-key", FAKE_KEY],
  },
  redactions: [FAKE_KEY],
});

test("createDockerHostConfig precedence: env > platform.json docker.wslDistro > Docker Desktop", () => {
  const desktop = configFor({}, null);
  assert.equal(desktop.id, "docker-desktop");
  assert.equal(desktop.viaWsl, false);
  assert.deepEqual([...desktop.dockerArgsPrefix], []);
  assert.equal(desktop.runtimeName, "Docker Desktop");
  assert.equal(desktop.daemonStartFile, "");

  const fromFile = configFor({}, { values: { wslDistro: "FileDistro" }, sources: { "docker.wslDistro": "file" } });
  assert.equal(fromFile.id, "docker-wsl:FileDistro");
  assert.equal(fromFile.sources.wslDistro, "file");
  assert.deepEqual([...fromFile.dockerArgsPrefix], ["-d", "FileDistro", "--exec", "docker"]);
  assert.equal(fromFile.dockerExe, "wsl.exe");
  assert.deepEqual([...fromFile.daemonStartArgs], ["-d", "FileDistro", "--exec", "sleep", "infinity"]);

  const fromEnv = configFor({ DOCKER_WSL_DISTRO: "EnvDistro", WSL_EXE: "custom-wsl.exe" }, { wslDistro: "FileDistro" });
  assert.equal(fromEnv.wslDistro, "EnvDistro");
  assert.equal(fromEnv.sources.wslDistro, "env");
  assert.equal(fromEnv.dockerExe, "custom-wsl.exe");
  assert.equal(fromEnv.runtimeName, "WSL EnvDistro");
});

test("createDockerHostConfig reads readSection(\"docker\") when no config is passed and never throws on a bad file", () => {
  const seen = [];
  const config = configFor({}, undefined, {
    readSection: (name, options) => {
      seen.push(name);
      assert.ok(options.env);
      return { values: { wslDistro: "Ubuntu-24.04", desktopExe: "D-exe" }, sources: { "docker.wslDistro": "file" }, errors: [] };
    },
  });
  assert.deepEqual(seen, ["docker"]);
  assert.equal(config.id, "docker-wsl:Ubuntu-24.04");
  assert.equal(config.dockerDesktopExe, "D-exe");

  const broken = configFor({}, undefined, { readSection: () => { throw new Error("boom"); } });
  assert.equal(broken.id, "docker-desktop");
  assert.equal(broken.warnings[0].code, "config_unreadable");
});

test("createDockerHostConfig validates the distro: env throws, a bad file value warns", () => {
  assert.throws(() => configFor({ DOCKER_WSL_DISTRO: "bad distro;" }, null), (error) => error.code === "invalid_docker_wsl_distro");
  const bad = configFor({}, { wslDistro: "bad distro;" });
  assert.equal(bad.id, "docker-desktop");
  assert.equal(bad.warnings[0].code, "invalid_value");
});

test("renderCommand uses renderRunArgs and redacts secrets", () => {
  const host = createDockerHost({ config: configFor({}, null), ...fakeExec(() => ({})) });
  const { argv, redactedArgv } = host.renderCommand(cmd);
  assert.deepEqual(argv, renderRunArgs(cmd));
  assert.equal(argv[0], "run");
  assert.equal(argv.includes(FAKE_KEY), true);
  assert.equal(redactedArgv.includes(FAKE_KEY), false);
  assert.equal(redactedArgv[redactedArgv.indexOf("--api-key") + 1], "<redacted>");
  assert.deepEqual(redactRunArgs(["--hf-token", "abc"]), ["--hf-token", "<redacted>"]);
  assert.equal(core.engines.hosts.docker, require("../engines/hosts/docker"));
});

test("WSL prefix is applied to every docker call", async () => {
  const exec = fakeExec((file, args) => (args.includes("run") ? { stdout: "cid\n" } : {}));
  const host = createDockerHost({ config: configFor({ DOCKER_WSL_DISTRO: "Ubuntu" }, null), ...exec });
  await host.create(cmd, { secretEnv: { VLLM_API_KEY: FAKE_KEY } });
  await host.logs("vllm-local", { tail: 5 });
  assert.ok(exec.calls.length >= 2);
  for (const call of exec.calls) {
    assert.equal(call.file, "wsl.exe");
    assert.deepEqual(call.args.slice(0, 4), ["-d", "Ubuntu", "--exec", "docker"]);
  }
});

test("create retries once with the secret env: name conflict, then a LAN bind fallback", async () => {
  const secretEnv = { VLLM_API_KEY: FAKE_KEY, HF_TOKEN: FAKE_HF };
  const lanArgs = ["run", "-d", "--name", "vllm-local", "-p", "192.168.1.5:8000:8000", "-e", "VLLM_API_KEY", "-e", "HF_TOKEN", "image"];
  const baseEnv = { PATH: "x", WSLENV: "USERPROFILE/p" };

  // Name conflict: first run fails, the leftover is removed, the retry works.
  const conflict = fakeExec((file, args, options, n) => (n === 1
    ? { error: "run failed", stderr: "Conflict. The container name \"/vllm-local\" is already in use by container \"abc\"" }
    : { stdout: "cid-1\n" }));
  const conflictHost = createDockerHost({ config: configFor({ DOCKER_WSL_DISTRO: "Ubuntu" }, null), baseEnv, ...conflict });
  const retries = [];
  const first = await conflictHost.create({ runArgs: lanArgs }, { secretEnv, lanFallback: false, onRetry: (retry) => retries.push(retry.kind) });
  assert.equal(first.id, "cid-1");
  assert.deepEqual(retries, ["name-conflict"]);
  const runCalls = conflict.calls.filter((call) => call.args.includes("run"));
  assert.equal(runCalls.length, 2);
  assert.equal(conflict.calls.filter((call) => call.args.includes("rm")).length, 1);
  for (const call of runCalls) {
    assert.equal(call.options.env.VLLM_API_KEY, FAKE_KEY);
    assert.equal(call.options.env.HF_TOKEN, FAKE_HF);
    assert.equal(call.options.env.WSLENV, "USERPROFILE/p:VLLM_API_KEY/u:HF_TOKEN/u");
    assert.equal(call.args.join(" ").includes(FAKE_KEY), false);
    assert.equal(call.args.join(" ").includes(FAKE_HF), false);
  }

  // LAN bind failure: the retry republishes on the wildcard address.
  const lan = fakeExec((file, args, options, n) => (n === 1
    ? { error: "run failed", stderr: "driver failed programming external connectivity: Bind for 192.168.1.5:8000 failed" }
    : { stdout: "cid-2\n" }));
  const lanHost = createDockerHost({ config: configFor({ DOCKER_WSL_DISTRO: "Ubuntu" }, null), baseEnv, ...lan });
  const lanRetries = [];
  const second = await lanHost.create({ runArgs: lanArgs }, { secretEnv, onRetry: (retry) => lanRetries.push(retry.kind) });
  assert.deepEqual(lanRetries, ["lan-bind"]);
  assert.equal(second.id, "cid-2");
  assert.equal(second.attempts, 2);
  assert.deepEqual(second.publish, ["0.0.0.0:8000:8000"]);
  assert.equal(lan.calls.length, 2);
  assert.ok(lan.calls[1].args.includes("0.0.0.0:8000:8000"));
  assert.equal(lan.calls[1].args.includes("192.168.1.5:8000:8000"), false);
  for (const call of lan.calls) {
    assert.equal(call.options.env.VLLM_API_KEY, FAKE_KEY);
    assert.equal(call.options.env.WSLENV, "USERPROFILE/p:VLLM_API_KEY/u:HF_TOKEN/u");
  }
});

test("create on Docker Desktop leaves WSLENV alone and does not retry a loopback bind failure", async () => {
  const exec = fakeExec(() => ({ error: "run failed", stderr: "Bind for 127.0.0.1:8000 failed: port is already allocated" }));
  const host = createDockerHost({ config: configFor({}, null), baseEnv: { PATH: "x" }, ...exec });
  await assert.rejects(host.create(cmd, { secretEnv: { VLLM_API_KEY: FAKE_KEY } }));
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].options.env.VLLM_API_KEY, FAKE_KEY);
  assert.equal(Object.hasOwn(exec.calls[0].options.env, "WSLENV"), false);
});

test("imagePresent is fresh on every call and distinguishes missing from Docker down", async () => {
  let state = "missing";
  const exec = fakeExec(() => {
    if (state === "missing") return { error: "x", stderr: "Error: No such image: img:1" };
    if (state === "down") return { error: "x", stderr: "error during connect: dockerDesktopLinuxEngine pipe" };
    return { stdout: "sha256:abc\t1024\t[\"img:1\"]\t[]\n" };
  });
  const host = createDockerHost({ config: configFor({}, null), ...exec });
  assert.equal(await host.imagePresent("img:1"), false);
  state = "present";
  assert.equal(await host.imagePresent("img:1"), true);
  state = "down";
  assert.equal(await host.imagePresent("img:1"), null);
  assert.equal(exec.calls.length, 3);
});

test("ensureImage: auto pulls a missing image, explicit never pulls", async () => {
  let present = false;
  const exec = fakeExec((file, args) => {
    if (args.includes("inspect")) return present ? { stdout: "sha256:abc\t1\t[]\t[]\n" } : { error: "x", stderr: "No such image: img:2" };
    if (args.includes("pull")) { present = true; return { stdout: "pulled\n" }; }
    return {};
  });
  const host = createDockerHost({ config: configFor({}, null), delay: async () => {}, ...exec });

  await assert.rejects(host.ensureImage("img:2", { policy: "explicit" }), (error) => error.code === "image_pull_required" && error.status === 409);
  assert.equal(exec.calls.some((call) => call.args.includes("pull")), false);
  await assert.rejects(host.ensureImage("img:2", { policy: "nope" }), (error) => error.code === "invalid_pull_policy");

  const attempts = [];
  const missing = [];
  const ensured = await host.ensureImage("img:2", {
    policy: "auto",
    platform: "linux/amd64",
    onAttempt: (info) => attempts.push(info.attempt),
    onMissing: ({ image }) => missing.push(image),
  });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.pulled, true);
  assert.deepEqual(attempts, [1]);
  assert.deepEqual(missing, ["img:2"]);
  const pullCall = exec.calls.find((call) => call.args.includes("pull"));
  assert.deepEqual(pullCall.args, ["pull", "--platform", "linux/amd64", "img:2"]);

  const again = await host.ensureImage("img:2");
  assert.equal(again.pulled, false);
});

test("ensureImage onMissing may refuse the pull", async () => {
  const exec = fakeExec(() => ({ error: "x", stderr: "No such image" }));
  const host = createDockerHost({ config: configFor({}, null), ...exec });
  await assert.rejects(host.ensureImage("local/x:1", { onMissing: () => { throw new Error("build it first"); } }), /build it first/);
  assert.equal(exec.calls.some((call) => call.args.includes("pull")), false);
});

test("pull streams layer progress and resolves with the digest; local builds are refused", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const spawned = [];
  const spawnCommand = (file, args) => {
    spawned.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", "abcdef123456: Pulling fs layer\nabcdef123456: Downloading\n");
      child.stdout.emit("data", `abcdef123456: Pull complete\nDigest: ${digest}\nStatus: Downloaded newer image\n`);
      child.emit("close", 0);
    });
    return child;
  };
  const host = createDockerHost({ config: configFor({ DOCKER_WSL_DISTRO: "Ubuntu" }, null), spawnCommand, ...fakeExec(() => ({})) });
  const percents = [];
  const result = await host.pull("img:3", { platform: "linux/amd64", onProgress: (progress) => percents.push(progress.percent) });
  assert.equal(result.ok, true);
  assert.equal(result.digest, digest);
  assert.deepEqual(spawned[0].args, ["-d", "Ubuntu", "--exec", "docker", "pull", "--platform", "linux/amd64", "img:3"]);
  assert.equal(percents.at(-1), 100);
  assert.ok(percents.length >= 2);
  await assert.rejects(host.pull("local/muse:1"), (error) => error.code === "image_local_build" && error.status === 422);

  const progress = parseDockerPullProgress("aaaaaaaaaaaa: Pull complete\nbbbbbbbbbbbb: Downloading\n");
  assert.equal(progress.layersTotal, 2);
  assert.equal(progress.layersDone, 1);
});

test("inspect, list, logs and stop wrap docker without caching", async () => {
  const info = {
    Id: "cid",
    Name: "/vllm-local",
    Created: "2026-01-01T00:00:00Z",
    Image: "sha256:img",
    State: { Running: true, Status: "running", StartedAt: "2026-01-01T00:00:01Z", ExitCode: 0 },
    Config: { Image: "vllm/x:1", Labels: { "ai.manager": "vllm" } },
    NetworkSettings: { Ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8000" }] } },
  };
  const row = { ID: "cid", Names: "vllm-local", State: "running", Status: "Up 1 minute", Labels: "ai.manager=vllm", Image: "vllm/x:1", Ports: "", CreatedAt: "2026-01-01 00:00:00 +0000 UTC" };
  const exec = fakeExec((file, args) => {
    if (args[0] === "inspect") return args[1] === "gone" ? { error: "x", stderr: "Error: No such object: gone" } : { stdout: JSON.stringify(info) };
    if (args[0] === "ps") return { stdout: `${JSON.stringify(row)}\n` };
    if (args[0] === "logs") return { stdout: "out\n", stderr: "err\n" };
    return {};
  });
  const host = createDockerHost({ config: configFor({}, null), managerLabelValue: "vllm", ...exec });
  const state = await host.inspect("vllm-local");
  assert.equal(state.exists, true);
  assert.equal(state.running, true);
  assert.equal(state.image, "vllm/x:1");
  assert.equal(state.imageId, "sha256:img");
  assert.equal(state.ports, "127.0.0.1:8000->8000/tcp");
  assert.equal(state.labels["ai.manager"], "vllm");
  assert.equal((await host.inspect("gone")).exists, false);
  const rows = await host.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "vllm-local");
  assert.equal(exec.calls.find((call) => call.args[0] === "ps").args.includes("label=ai.manager=vllm"), true);
  assert.equal(await host.logs("vllm-local", { tail: 30, sinceIso: "2026-01-01T00:00:00Z" }), "out\nerr\n");
  const logCall = exec.calls.find((call) => call.args[0] === "logs");
  assert.deepEqual(logCall.args, ["logs", "--tail", "30", "--since", "2026-01-01T00:00:00Z", "vllm-local"]);
});

test("ready reports the daemon version and does not start Docker unless asked", async () => {
  const exec = fakeExec(() => ({ error: "x", stderr: "Cannot connect to the Docker daemon" }));
  const host = createDockerHost({ config: configFor({}, null), ...exec });
  const result = await host.ready({ autoStart: false });
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  const up = createDockerHost({ config: configFor({}, null), ...fakeExec(() => ({ stdout: "27.1.1\n" })) });
  assert.deepEqual(await up.ready({}), { ok: true, version: "27.1.1", detail: "", started: false });
});

function waitOptions(overrides = {}) {
  const job = { id: "j", status: "running", logs: [], progress: {} };
  let clock = 0;
  return {
    job,
    engineName: "Fake",
    containerName: "c1",
    port: 1,
    serviceUrl: "http://127.0.0.1:1",
    waitUrl: "http://127.0.0.1:1/v1/models",
    startupTimeoutMs: 600000,
    pollIntervalMs: 1,
    logPollIntervalMs: 1,
    delayFn: async () => { clock += 1000; },
    nowFn: () => clock,
    fetchServedModels: async () => [],
    getContainerStatus: async () => ({ exists: true, running: true, status: "running" }),
    docker: async () => { throw new Error("docker must not be called when readLogs is given"); },
    extractLogIssues: () => [],
    setJobProgress: (target, value) => { target.progress = { ...target.progress, ...value }; },
    appendLog: (target, text) => { target.logs.push(text); },
    finishJob: (target, meta) => { target.finished = meta; },
    ...overrides,
  };
}

test("runtime-wait uses the inferProgress and readLogs hooks when given", async () => {
  const reads = [];
  const inferred = [];
  let served = 0;
  const options = waitOptions({
    fetchServedModels: async () => (++served > 3 ? [{ id: "m" }] : []),
    readLogs: async (name, readOptions) => { reads.push([name, readOptions.tail]); return { stdout: "hello ", stderr: "world" }; },
    inferProgress: (logText, elapsed, timeout) => {
      inferred.push([logText, elapsed, timeout]);
      return { percent: 50, stage: "custom stage", detail: "d" };
    },
  });
  await waitForRuntimeReady(options);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(([name]) => name === "c1"));
  assert.ok(inferred.length > 0);
  assert.equal(inferred.at(-1)[2], 600000);
  assert.ok(options.job.finished);
});

test("runtime-wait reads exited-container logs through readLogs with tail 2000 for root-cause analysis", async () => {
  const reads = [];
  const options = waitOptions({
    getContainerStatus: async () => ({ exists: true, running: false, status: "exited" }),
    readLogs: async (name, readOptions) => { reads.push([name, readOptions.tail]); return "boom"; },
  });
  await assert.rejects(waitForRuntimeReady(options), /exited before becoming ready/);
  assert.deepEqual(reads, [["c1", 2000]]);
});

test("runtime-wait keeps docker logs as the default reader", async () => {
  const dockerCalls = [];
  const options = waitOptions({
    getContainerStatus: async () => ({ exists: true, running: false, status: "exited" }),
    docker: async (args) => { dockerCalls.push(args); return { stdout: "out", stderr: "err" }; },
  });
  await assert.rejects(waitForRuntimeReady(options), /exited before becoming ready/);
  assert.deepEqual(dockerCalls, [["logs", "--tail", "2000", "c1"]]);
});
