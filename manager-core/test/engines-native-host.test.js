"use strict";

// NativeProcessHost (01-engines §13, ENG-22): flag gating, sha256 verification
// before every spawn, the state file and adoption, stop through
// terminateProcessTree, and the relaunch-based rollback. spawn, kill, pid
// checks and the health GET are fakes; nothing starts a process or touches the
// network, and every path lives in a temp directory.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const { createNativeHost, isNativeEnabled, normalizeNativeSpec, NO_HOT_ROLLBACK } = require("../engines/hosts/native");
const { createEngineRegistry } = require("../engines/registry");
const runtimeManifest = require("../runtime-manifest");

const BINARY_BYTES = Buffer.from("fake llama-server binary");
const BINARY_SHA = crypto.createHash("sha256").update(BINARY_BYTES).digest("hex");
const BINARY_REL = "runtimes/native/llama-server.exe";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-host-"));
  fs.mkdirSync(path.join(root, path.dirname(BINARY_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, BINARY_REL), BINARY_BYTES);
  return root;
}

function fakeSpawner() {
  const calls = [];
  let nextPid = 4100;
  const spawn = (file, args, spawnOptions) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.unref = () => {};
    calls.push({ file, args, options: spawnOptions, child });
    return child;
  };
  return { spawn, calls };
}

function commandOf(overrides = {}) {
  return {
    host: "native",
    native: { name: "llama-local", path: BINARY_REL, sha256: BINARY_SHA, args: ["--port", "18080", "--model", "m.gguf"], env: { LLAMA_LOG: "1" }, port: 18080, ...overrides.native },
    labels: { "ai.manager": "llama-manager", "ai.manager.launch-id": "lch_old", ...overrides.labels },
    secretEnv: { LLAMA_API_KEY: "sk-test-fake-0000" },
    redactions: ["sk-test-fake-0000"],
  };
}

function makeHost(root, extra = {}) {
  const alive = new Set();
  const spawner = fakeSpawner();
  const killed = [];
  const host = createNativeHost({
    managerId: "llama",
    managerLabelValue: "llama-manager",
    aiRoot: root,
    enabled: true,
    env: { PATH: "/fake/bin", SECRET_FAKE: "must-not-leak", CUDA_VISIBLE_DEVICES: "0" },
    spawn: (...args) => {
      const child = spawner.spawn(...args);
      alive.add(child.pid);
      return child;
    },
    terminate: (pid) => {
      killed.push(pid);
      alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    healthCheck: async () => true,
    delay: async () => {},
    stopWaitMs: 50,
    ...extra,
  });
  return { host, alive, killed, calls: spawner.calls };
}

test("the native host is disabled by default and refuses every operation", async () => {
  const root = makeRoot();
  // The real readSection over an empty temp root: engines.native.enabled defaults to false.
  assert.equal(isNativeEnabled({ aiRoot: root, env: {} }), false);
  const { host, calls } = makeHost(root, { enabled: undefined, readSection: undefined, env: {}, aiRoot: root });
  assert.equal(host.enabled(), false);
  assert.deepEqual(await host.ready(), { ok: false, version: "", detail: "native_host_disabled", started: false });
  await assert.rejects(host.create(commandOf()), { code: "native_host_disabled", status: 409 });
  await assert.rejects(host.inspect("llama-local"), { code: "native_host_disabled" });
  await assert.rejects(host.stop("llama-local"), { code: "native_host_disabled" });
  assert.equal(calls.length, 0);
});

test("the flag is read through readSection(\"engines\") and only a literal true enables it", () => {
  const seen = [];
  const reader = (value) => (name) => {
    seen.push(name);
    return value;
  };
  assert.equal(isNativeEnabled({ readSection: reader({ values: { native: { enabled: true } } }) }), true);
  assert.deepEqual(seen, ["engines"]);
  assert.equal(isNativeEnabled({ readSection: reader({ values: { native: { enabled: "true" } } }) }), false);
  assert.equal(isNativeEnabled({ readSection: reader({ values: {}, errors: [{ code: "unknown_section" }] }) }), false);
  assert.equal(isNativeEnabled({ readSection: () => { throw new Error("boom"); } }), false);
  // The schema fragment ships the key, default off.
  assert.equal(require("../platform/config").readSection("engines", { aiRoot: makeRoot(), env: {} }).values.native.enabled, false);
});

test("the registry hides the native host kind unless the flag is on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-registry-"));
  const descriptor = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "engines", "llamacpp.json"), "utf8"));
  descriptor.host.kinds = ["native", "docker"];
  descriptor.host.default = "native";
  fs.writeFileSync(path.join(dir, "llamacpp.json"), JSON.stringify(descriptor));
  const overrideDir = path.join(dir, "none");
  let flag = false;
  const registry = createEngineRegistry({ bundledDir: dir, overrideDir, nativeEnabled: () => flag });
  assert.deepEqual(registry.errors(), []);
  assert.deepEqual(registry.hostKindsFor("llamacpp"), ["docker"]);
  assert.equal(registry.defaultHostKindFor("llamacpp"), "docker");
  flag = true;
  assert.deepEqual(registry.hostKindsFor("llamacpp"), ["native", "docker"]);
  assert.equal(registry.defaultHostKindFor("llamacpp"), "native");
  // Bundled engines are docker-only and unaffected.
  assert.deepEqual(createEngineRegistry({ nativeEnabled: false }).hostKindsFor("vllm"), ["docker"]);
  assert.equal(core.engines.hosts.native.createNativeHost, createNativeHost);
});

test("a binary whose sha256 differs is refused and never spawned", async () => {
  const root = makeRoot();
  const { host, calls } = makeHost(root);
  const wrong = commandOf({ native: { sha256: "0".repeat(64) } });
  await assert.rejects(host.create(wrong), (error) => {
    assert.equal(error.code, "native_binary_mismatch");
    assert.equal(error.details.expected, "0".repeat(64));
    assert.equal(error.details.actual, BINARY_SHA);
    return true;
  });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(host.stateDir), false);
  assert.equal(await host.imagePresent({ path: BINARY_REL, sha256: "0".repeat(64) }), false);
  assert.equal(await host.imagePresent({ path: BINARY_REL, sha256: BINARY_SHA }), true);
  // Verified before every spawn: tampering after a first good start is caught.
  await host.create(commandOf());
  fs.writeFileSync(path.join(root, BINARY_REL), "tampered");
  await assert.rejects(host.create(commandOf({ native: { name: "second" } })), { code: "native_binary_mismatch" });
  assert.equal(calls.length, 1);
  await assert.rejects(host.create(commandOf({ native: { path: "runtimes/missing.exe" } })), { code: "native_binary_missing" });
});

test("binary paths must stay below the platform root", async () => {
  const root = makeRoot();
  const { host, calls } = makeHost(root);
  for (const bad of ["../outside.exe", "/abs/llama-server.exe", "C:\\Windows\\x.exe", "a/../../b.exe", ""]) {
    assert.equal(normalizeNativeSpec({ path: bad, sha256: BINARY_SHA }), null, bad);
    await assert.rejects(host.create(commandOf({ native: { path: bad } })), { code: "native_binary_invalid" });
  }
  assert.equal(calls.length, 0);
});

test("create spawns detached and hidden with an env allowlist, logs to a file and writes the state file", async () => {
  const root = makeRoot();
  const { host, calls } = makeHost(root, { now: () => new Date("2026-10-15T08:00:00.000Z") });
  const created = await host.create(commandOf());
  assert.equal(created.pid, 4100);
  assert.equal(created.name, "llama-local");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.file, fs.realpathSync(path.join(root, BINARY_REL)));
  assert.deepEqual(call.args, ["--port", "18080", "--model", "m.gguf"]);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.stdio[0], "ignore");
  assert.equal(typeof call.options.stdio[1], "number");
  assert.equal(call.options.env.PATH, "/fake/bin");
  assert.equal(call.options.env.CUDA_VISIBLE_DEVICES, "0");
  assert.equal(call.options.env.LLAMA_LOG, "1");
  assert.equal(call.options.env.LLAMA_API_KEY, "sk-test-fake-0000");
  assert.equal("SECRET_FAKE" in call.options.env, false);

  const statePath = path.join(root, ".runtime", "native", "llama", "llama-local.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.pid, 4100);
  assert.equal(state.startedAt, "2026-10-15T08:00:00.000Z");
  assert.equal(state.binarySha256, BINARY_SHA);
  assert.equal(state.port, 18080);
  assert.equal(state.launchId, "lch_old");
  assert.equal(state.labels["ai.manager"], "llama-manager");
  assert.equal(JSON.stringify(state).includes("sk-test-fake-0000"), false);
  assert.equal(fs.existsSync(path.join(root, "llama-manager", "logs", "native", "llama-local.log")), true);

  const rendered = host.renderCommand(commandOf({ native: { args: ["--api-key", "sk-test-fake-0000"] } }));
  assert.equal(rendered.argv[1], "--api-key");
  assert.deepEqual(rendered.redactedArgv.slice(1), ["--api-key", "<redacted>"]);

  const inspected = await host.inspect("llama-local");
  assert.equal(inspected.running, true);
  assert.equal(inspected.ports, "127.0.0.1:18080");
  assert.equal(inspected.imageId, BINARY_SHA);
  assert.deepEqual((await host.list()).map((item) => item.name), ["llama-local"]);
  assert.deepEqual(await host.list({ ownerLabelValue: "vllm-manager" }), []);
  assert.deepEqual(await host.inspect("nope"), { exists: false, running: false, status: "missing", labels: {} });
});

test("a spawn that yields no pid is a failure and leaves no state", async () => {
  const root = makeRoot();
  const { host } = makeHost(root, { spawn: () => Object.assign(new EventEmitter(), { unref() {} }) });
  await assert.rejects(host.create(commandOf()), { code: "native_spawn_failed" });
  assert.equal(fs.existsSync(path.join(host.stateDir, "llama-local.json")), false);
});

test("the log file is rotated at the size limit", async () => {
  const root = makeRoot();
  const { host } = makeHost(root, { logMaxBytes: 10 });
  const logPath = path.join(host.logDir, "llama-local.log");
  fs.mkdirSync(host.logDir, { recursive: true });
  fs.writeFileSync(logPath, "x".repeat(32));
  await host.create(commandOf());
  assert.equal(fs.readFileSync(`${logPath}.1`, "utf8"), "x".repeat(32));
  assert.equal(fs.statSync(logPath).size, 0);
  fs.writeFileSync(logPath, "one\ntwo\nthree\n");
  assert.equal(await host.logs("llama-local", { tail: 2 }), "three\n");
});

test("adoption keeps a live healthy instance, flags an unhealthy one and drops a dead state file", async () => {
  const root = makeRoot();
  const first = makeHost(root);
  await first.host.create(commandOf());
  await first.host.create(commandOf({ native: { name: "llama-b", port: 18081 }, labels: { "ai.manager.launch-id": "lch_b" } }));
  await first.host.create(commandOf({ native: { name: "llama-c", port: 18082 }, labels: { "ai.manager.launch-id": "lch_c" } }));
  fs.writeFileSync(path.join(first.host.stateDir, "other.json"), JSON.stringify({ name: "other", pid: 1, port: 1, labels: { "ai.manager": "vllm-manager" } }));
  // The manager restarts: a new host over the same state directory.
  const restarted = makeHost(root, {
    isAlive: (pid) => pid !== 4101,
    healthCheck: async (port) => port === 18080,
  });
  const result = await restarted.host.adopt();
  assert.deepEqual(result.adopted.map((item) => item.name), ["llama-local"]);
  assert.equal(result.adopted[0].launchId, "lch_old");
  assert.deepEqual(result.unhealthy.map((item) => [item.name, item.status]), [["llama-c", "unhealthy"]]);
  assert.deepEqual(result.stale, ["llama-b"]);
  assert.equal(fs.existsSync(path.join(restarted.host.stateDir, "llama-b.json")), false);
  assert.equal(fs.existsSync(path.join(restarted.host.stateDir, "llama-c.json")), true);
  assert.equal(fs.existsSync(path.join(restarted.host.stateDir, "other.json")), true, "another owner's state is untouched");
});

test("stop terminates the process tree, waits for the exit and removes the state file", async () => {
  const root = makeRoot();
  const { host, killed } = makeHost(root);
  await host.create(commandOf());
  assert.deepEqual(await host.stop("llama-local", { reason: "test" }), { removed: true, pid: 4100 });
  assert.deepEqual(killed, [4100]);
  assert.equal(fs.existsSync(path.join(host.stateDir, "llama-local.json")), false);
  assert.deepEqual(await host.stop("llama-local"), { removed: false, pid: null });

  const stuck = makeHost(root, { terminate: () => {} });
  await stuck.host.create(commandOf());
  await assert.rejects(stuck.host.stop("llama-local"), { code: "native_stop_timeout" });
  assert.equal(fs.existsSync(path.join(stuck.host.stateDir, "llama-local.json")), true);
});

test("the default stop is process-job-runner terminateProcessTree (taskkill /T /F on win32)", async () => {
  const root = makeRoot();
  const killerCalls = [];
  const alive = new Set();
  const { host } = makeHost(root, {
    terminate: undefined,
    platform: "win32",
    killSpawn: (command, args, spawnOptions) => {
      killerCalls.push({ command, args, spawnOptions });
      alive.clear();
      return new EventEmitter();
    },
    spawn: (file, args, spawnOptions) => {
      alive.add(5200);
      return Object.assign(new EventEmitter(), { pid: 5200, unref() {} });
    },
    isAlive: (pid) => alive.has(pid),
  });
  await host.create(commandOf());
  await host.stop("llama-local");
  assert.equal(killerCalls.length, 1);
  assert.equal(killerCalls[0].command, "taskkill");
  assert.deepEqual(killerCalls[0].args, ["/PID", "5200", "/T", "/F"]);
});

test("replace-mode rollback stops the old instance and relaunches its LaunchSpec", async () => {
  const root = makeRoot();
  const relaunches = [];
  const { host, killed, alive } = makeHost(root, {
    relaunch: async (spec) => {
      relaunches.push(spec);
      return { relaunched: spec.launchId };
    },
  });
  await host.create(commandOf());
  const checkpoint = await host.checkpoint("llama-local");
  assert.equal(checkpoint.warning, NO_HOT_ROLLBACK);
  assert.deepEqual(killed, [4100], "the old instance is stopped at the checkpoint (no rename)");
  assert.equal(fs.existsSync(path.join(host.stateDir, "llama-local.json")), false);

  // The new launch comes up under the same name, then fails its readiness wait.
  const replacement = await host.create(commandOf({ labels: { "ai.manager.launch-id": "lch_new" } }));
  assert.equal(replacement.pid, 4101);
  const outcome = await checkpoint.rollback(new Error("not ready"));
  assert.deepEqual(killed, [4100, 4101], "the failed replacement is stopped before the old spec relaunches");
  assert.equal(alive.size, 0);
  assert.deepEqual(outcome, { restored: true, launchId: "lch_old", result: { relaunched: "lch_old" } });
  assert.deepEqual(relaunches, [{ launchId: "lch_old", labels: { "ai.manager": "llama-manager", "ai.manager.launch-id": "lch_old" }, name: "llama-local", port: 18080 }]);

  // Without a relaunch seam the rollback reports it instead of pretending.
  const bare = makeHost(makeRoot());
  await bare.host.create(commandOf());
  const bareCheckpoint = await bare.host.checkpoint("llama-local");
  assert.deepEqual(await bareCheckpoint.rollback(new Error("x")), { restored: false, reason: "no_relaunch", launchId: "lch_old" });
  // commit keeps the replacement.
  const second = makeHost(makeRoot());
  await second.host.create(commandOf());
  const committed = await (await second.host.checkpoint("llama-local")).commit();
  assert.deepEqual(committed, { committed: true });
});

test("a native host never pulls and ensureImage only verifies", async () => {
  const root = makeRoot();
  const { host } = makeHost(root);
  await assert.rejects(host.pull(), { code: "native_no_pull", status: 405 });
  assert.deepEqual(await host.ensureImage({ path: BINARY_REL, sha256: BINARY_SHA }), { ok: true, pulled: false });
  await assert.rejects(host.ensureImage({ path: BINARY_REL, sha256: "f".repeat(64) }), { code: "native_binary_mismatch" });
});

test("the runtime manifest validates native entries", () => {
  const base = { version: "b1", repository: "ggml-org/llama.cpp", engineId: "llamacpp" };
  assert.deepEqual(runtimeManifest.validateRuntimeManifest({ runtimes: { x: { ...base, native: { path: BINARY_REL, sha256: BINARY_SHA } } } }), { ok: true, errors: [] });
  const bad = runtimeManifest.validateRuntimeManifest({ runtimes: { x: { ...base, native: { path: "../evil.exe", sha256: "abc" } } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.equal(runtimeManifest.validateRuntimeManifest({ runtimes: { x: { ...base, native: "llama-server.exe" } } }).ok, false);
});
