"use strict";

// First-run setup wizard (06 §8, OPS-14): step states from doctor, step actions
// as supervisor operations, the images step through the manager pull endpoint
// only, the ops step never registering anything, and `platform setup
// --non-interactive --yes` on a fixture root. Everything is faked: no Docker,
// no service, no network.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const setupApi = require("../platform/setup");
const { createFixRunner } = require("../platform/doctor-fix");
const { createWorld } = require("./fixtures/platform/supervisor-world");
const { createFakeDpapi } = require("./fixtures/secrets/fake-dpapi");
const { run: runCli } = require("../../scripts/platformctl.js");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-wizard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function check(id, status, extra = {}) {
  return { id, group: id.split(".")[0], status, title: { "en-US": id }, detail: `${id} ${status}`, data: {}, fix: null, actions: [], ...extra };
}

const RUNTIMES = [
  { runtimeId: "vllm-fixture", engineId: "vllm", image: "fixture/vllm:1", present: false, localBuild: false },
  { runtimeId: "llama-fixture", engineId: "llama", image: "fixture/llama:1", present: false, localBuild: false },
];

function fixtureReport(overrides = {}) {
  const checks = new Map([
    ["env.node-version", check("env.node-version", "ok")],
    ["runtime.docker-cli", check("runtime.docker-cli", "ok")],
    ["env.deps.vllm-manager", check("env.deps.vllm-manager", "fail")],
    ["env.mcp-dist", check("env.mcp-dist", "ok")],
    ["env.download-cli", check("env.download-cli", "warn")],
    ["storage.model-roots", check("storage.model-roots", "warn")],
    ["runtime.images", check("runtime.images", "warn", { data: { runtimes: RUNTIMES } })],
    ["sec.lan-keys", check("sec.lan-keys", "skip")],
    ["ops.autostart", check("ops.autostart", "warn")],
    ["ops.nightly", check("ops.nightly", "warn")],
    ["ops.backup", check("ops.backup", "warn")],
    ["ops.supervisor", check("ops.supervisor", "fail")],
  ]);
  for (const [id, value] of Object.entries(overrides)) checks.set(id, typeof value === "string" ? check(id, value) : value);
  return { schemaVersion: 1, checks: [...checks.values()] };
}

// A fake manager: POST /api/runtimes/:id/pull starts a job that succeeds on the third poll.
function fakeManager() {
  const calls = [];
  let polls = 0;
  const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    const pathname = new URL(url).pathname;
    if (pathname === "/api/manager/health") return reply(200, { ok: true });
    if (method === "POST" && /^\/api\/runtimes\/[^/]+\/pull$/.test(pathname)) return reply(202, { job: { id: "job-1" } });
    if (pathname === "/api/jobs/job-1") { polls += 1; return reply(200, polls >= 3 ? { id: "job-1", status: "success", progress: 1 } : { id: "job-1", status: "running", progress: polls / 3 }); }
    return reply(404, {});
  };
  return { fetch, calls };
}

function runnerOptions(root, extra = {}) {
  const manager = extra.manager || fakeManager();
  const spawned = [];
  return {
    manager,
    spawned,
    options: {
      aiRoot: root,
      env: {},
      runDoctor: async () => fixtureReport(),
      execFile: (file, args, _options, callback) => { spawned.push([file, ...args]); callback(null, "", ""); },
      execute: async (file, args) => { spawned.push([file, ...args]); return { stdout: "", stderr: "" }; },
      registry: { packages: [{ dir: "vllm-manager", live: true }], components: [] },
      config: { values: {} },
      fixOptions: { fetch: manager.fetch, managerUrl: () => "http://127.0.0.1:1", sleep: async () => {}, pollMs: 1 },
      ...extra.options,
    },
  };
}

test("step states derive from doctor, recorded steps and hand-done work", (t) => {
  const root = tempRoot(t);
  let described = setupApi.describeSetup({ aiRoot: root, env: {}, doctor: fixtureReport({ "storage.model-roots": "ok", "env.download-cli": "ok" }), lan: false });
  assert.deepEqual(described.steps.map((step) => step.id), ["prereq", "deps", "download-cli", "storage", "images", "tts", "exposure", "ops", "start", "first-model"]);
  const status = Object.fromEntries(described.steps.map((step) => [step.id, step.status]));
  assert.equal(status.prereq, "done");
  assert.equal(status.deps, "todo");
  assert.equal(status["download-cli"], "done", "a step done by hand shows as done");
  assert.equal(status.storage, "done");
  assert.equal(status.images, "todo");
  assert.equal(status.start, "todo");
  assert.equal(described.completedAt, null);
  assert.equal(described.current, "deps");

  described = setupApi.describeSetup({ aiRoot: root, env: {}, doctor: fixtureReport({ "runtime.docker-cli": check("runtime.docker-cli", "fail", { fix: { id: "docker", risk: "manual", label: { "en-US": "Install Docker" }, command: "winget install Docker.DockerDesktop" } }) }), lan: false });
  const blocked = described.steps[0];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.data.blocking[0].id, "runtime.docker-cli");
  assert.equal(blocked.data.blocking[0].fix.command, "winget install Docker.DockerDesktop");

  setupApi.recordStep(root, "tts", "skipped");
  setupApi.recordStep(root, "images", "failed");
  described = setupApi.describeSetup({ aiRoot: root, env: {}, doctor: fixtureReport(), lan: false });
  assert.equal(described.steps.find((step) => step.id === "tts").status, "skipped");
  assert.equal(described.steps.find((step) => step.id === "images").status, "failed");

  const recorded = JSON.parse(fs.readFileSync(setupApi.setupFile(root), "utf8"));
  assert.equal(recorded.steps.tts.state, "skipped");
  assert.equal(recorded.completedAt, null);
  setupApi.skipAll(root);
  assert.ok(setupApi.describeSetup({ aiRoot: root, env: {}, doctor: null, lan: false }).completedAt);
});

test("images pulls only through the manager endpoint and never spawns docker", async (t) => {
  const root = tempRoot(t);
  const { options, manager, spawned } = runnerOptions(root);
  const lines = [], progress = [];
  const outcome = await setupApi.createSetupRunner(options).runStep("images", {}, { line: (text) => lines.push(text), progress: (value) => progress.push(value) });
  assert.deepEqual(outcome.result.pulled, ["vllm-fixture"], "vLLM is the default engine");
  assert.ok(manager.calls.includes("POST /api/runtimes/vllm-fixture/pull"));
  assert.ok(manager.calls.some((call) => call.startsWith("GET /api/jobs/job-1")));
  assert.ok(!manager.calls.some((call) => call.includes("llama-fixture")));
  assert.equal(spawned.length, 0, "nothing is spawned, in particular no docker pull");
  assert.ok(lines.some((line) => /job-1: running/.test(line)));
  assert.ok(progress.length > 0);
  assert.equal(setupApi.readSetupState(root).steps.images.state, "done");

  await assert.rejects(() => setupApi.createSetupRunner(options).prepare("images", { engines: ["docker"] }), (error) => error.code === "invalid_request");
  await assert.rejects(() => setupApi.createSetupRunner(options).prepare("nope", {}), (error) => error.code === "setup_step_unknown");
});

test("the ops step reports commands and never registers a task", async (t) => {
  const root = tempRoot(t);
  const { options, spawned } = runnerOptions(root);
  const runner = setupApi.createSetupRunner(options);
  const plan = await runner.prepare("ops", {});
  assert.equal(plan.immediate.commands.length, 3);
  assert.ok(plan.immediate.commands.some((command) => /backup-platform\.ps1 -Register/.test(command)));
  assert.ok(plan.immediate.commands.some((command) => /nightly-e2e\.ps1 -Register/.test(command)));
  assert.ok(plan.immediate.commands.some((command) => /autostart enable/.test(command)));
  const outcome = await runner.execute(plan, {});
  assert.equal(outcome.result.registered, false);
  assert.equal(spawned.length, 0);
  assert.equal(setupApi.readSetupState(root).steps.ops, undefined, "showing the commands does not mark the step done");
});

test("storage registers roots and the cache folder; a prerequisite failure is recorded", async (t) => {
  const root = tempRoot(t);
  const registered = [], written = [];
  const { options } = runnerOptions(root, {
    options: {
      createModelStorage: () => ({ registerRoot: (input) => { registered.push(input); } }),
      writeConfig: async (request) => { written.push(request.set); return { ok: true }; },
    },
  });
  const modelRoot = path.join(root, "models-extra"), hfHome = path.join(root, "hf");
  const outcome = await setupApi.createSetupRunner(options).runStep("storage", { modelRoots: [modelRoot], hfHome }, {});
  assert.equal(registered[0].path, modelRoot);
  assert.deepEqual(written[0], { "paths.hfHome": hfHome });
  assert.equal(outcome.result.registered[0].status, "registered");
  await assert.rejects(() => setupApi.createSetupRunner(options).prepare("storage", { modelRoots: ["relative/dir"] }), (error) => error.code === "invalid_request");

  const blocking = runnerOptions(root, { options: { runDoctor: async () => fixtureReport({ "env.node-version": "fail" }) } });
  await assert.rejects(() => setupApi.createSetupRunner(blocking.options).runStep("prereq", {}, {}), (error) => error.code === "prereq_blocked");
  assert.equal(setupApi.readSetupState(root).steps.prereq.state, "failed");
});

test("lan exposure is reverted when no API key is active", async (t) => {
  const root = tempRoot(t);
  const written = [];
  const { options } = runnerOptions(root, {
    options: {
      writeConfig: async (request) => { written.push(request.set["listeners.admin.lan"]); return { ok: true }; },
      runDoctor: async () => fixtureReport({ "sec.lan-keys": "fail" }),
    },
  });
  await assert.rejects(() => setupApi.createSetupRunner(options).runStep("exposure", { mode: "lan" }, {}), (error) => error.code === "lan_requires_key");
  assert.deepEqual(written, [true, false]);
});

async function settle(supervisor, opId) {
  for (let index = 0; index < 500; index += 1) {
    const op = await supervisor.operation(opId);
    if (op.state !== "running") return op;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("operation did not settle");
}

test("the supervisor runs a setup step as a streamed operation", async (t) => {
  const world = createWorld(t, { profile: "core" });
  const { options, manager, spawned } = runnerOptions(world.aiRoot);
  const supervisor = world.create({
    createSetupRunner: (runnerOptions_) => setupApi.createSetupRunner({ ...runnerOptions_, ...options, supervisor: runnerOptions_.supervisor }),
  });
  const started = await supervisor.runSetupStep("images", { engines: ["vllm"] });
  assert.match(started.opId, /^op_/);
  const op = await settle(supervisor, started.opId);
  assert.equal(op.kind, "setup");
  assert.equal(op.state, "ok");
  assert.deepEqual(op.result.result.pulled, ["vllm-fixture"]);
  assert.ok(op.log.some((line) => /job-1/.test(line)), "progress lines are streamed into the operation log");
  assert.equal(op.progress, 1);
  assert.equal(spawned.length, 0);
  assert.ok(manager.calls.includes("POST /api/runtimes/vllm-fixture/pull"));

  await assert.rejects(() => supervisor.runSetupStep("nope", {}), (error) => error.code === "setup_step_unknown");
  const ops = await supervisor.runSetupStep("ops", {});
  assert.equal(ops.commands.length, 3);
  assert.equal((await settle(supervisor, ops.opId)).result.result.registered, false);
  assert.equal(spawned.length, 0);

  const skipped = await supervisor.runSetupStep("all", { skip: true });
  assert.equal((await settle(supervisor, skipped.opId)).state, "ok");
  assert.ok(setupApi.readSetupState(world.aiRoot).completedAt);
});

test("platform setup --non-interactive --yes completes on a fixture root", async (t) => {
  const root = tempRoot(t);
  const { options, manager, spawned } = runnerOptions(root, {
    options: {
      installDeps: async (pkg) => { spawned.push(["npm-ci", pkg.dir]); },
      createFixRunner: (fixOptions) => {
        const real = createFixRunner({ ...fixOptions, executors: { "install-download-cli": async () => { spawned.push(["install-download-cli"]); return { installed: true }; } } });
        return real;
      },
      createModelStorage: () => ({ registerRoot: () => {} }),
      writeConfig: async () => ({ ok: true }),
    },
  });
  let supervisorUp = false;
  const operations = new Map();
  const controlClient = {
    available: async () => supervisorUp,
    request: async (method, route, request = {}) => {
      const post = /^\/v1\/setup\/([a-z-]+)$/.exec(route);
      if (method === "POST" && post) {
        const opId = `op_${operations.size + 1}`;
        const op = { opId, state: "running", log: [], result: null };
        operations.set(opId, op);
        const runner = setupApi.createSetupRunner(options);
        runner.runStep(post[1], request.body || {}, { line: (text) => op.log.push(text), progress: () => {} })
          .then((result) => { op.state = "ok"; op.result = result; }, (error) => { op.state = "failed"; op.result = { code: error.code, message: error.message }; });
        return { status: 202, json: { ok: true, opId } };
      }
      const get = /^\/v1\/operations\/(op_\d+)$/.exec(route);
      if (method === "GET" && get) return { status: 200, json: operations.get(get[1]) };
      return { status: 404, json: {} };
    },
  };
  const started = [], executed = [];
  const out = [], err = [];
  const code = await runCli(["setup", "--non-interactive", "--yes"], {
    aiRoot: root,
    env: { PLATFORM_LANG: "en-US" },
    stdout: { write: (text) => { out.push(String(text)); return true; } },
    stderr: { write: (text) => { err.push(String(text)); return true; } },
    stdin: Readable.from([]),
    stdinIsTTY: false,
    dpapi: createFakeDpapi(),
    acl: { secure: async () => {} },
    runDoctor: async () => fixtureReport(),
    setupOptions: options,
    controlClient,
    startPlatform: async (_ctx, { args }) => { started.push(args); supervisorUp = true; return 0; },
    exec: async (file, args) => { executed.push([file, ...args]); },
    sleep: async () => {},
  });
  assert.equal(code, 0, err.join(""));
  const state = setupApi.readSetupState(root);
  for (const id of ["deps", "download-cli", "storage", "images", "exposure", "ops", "start"]) assert.equal(state.steps[id].state, "done", id);
  assert.equal(state.steps.tts.state, "skipped", "optional voice is not installed without --step tts");
  assert.equal(state.steps["first-model"].state, "skipped");
  assert.ok(state.completedAt);
  assert.deepEqual(started, [["vllm-manager"], ["core"]], "the hosting manager is started before the pull, the platform last");
  assert.ok(manager.calls.includes("POST /api/runtimes/vllm-fixture/pull"));
  assert.equal(executed.length, 3, "--yes answers the ops question");
  assert.ok(spawned.every((entry) => entry[0] !== "docker"));
  assert.match(out.join(""), /Setup is complete/);
});

test("platform setup without --yes does not run the ops commands", async (t) => {
  const root = tempRoot(t);
  const { options } = runnerOptions(root, { options: { installDeps: async () => {}, createModelStorage: () => ({ registerRoot: () => {} }), writeConfig: async () => ({ ok: true }) } });
  const executed = [];
  const code = await runCli(["setup", "--non-interactive", "--step", "ops"], {
    aiRoot: root,
    env: { PLATFORM_LANG: "en-US" },
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: Readable.from([]),
    stdinIsTTY: false,
    dpapi: createFakeDpapi(),
    acl: { secure: async () => {} },
    runDoctor: async () => fixtureReport(),
    setupOptions: options,
    exec: async (file, args) => { executed.push([file, ...args]); },
  });
  assert.equal(code, 0);
  assert.equal(executed.length, 0);
  assert.equal(setupApi.readSetupState(root).steps.ops.state, "skipped");
  assert.equal(await runCli(["setup", "--step", "bogus"], { aiRoot: root, env: { PLATFORM_LANG: "en-US" }, stdout: { write: () => true }, stderr: { write: () => true }, stdin: Readable.from([]) }), 2);
});
