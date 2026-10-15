"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createFakeClock, createWorld, NODE_EXE } = require("./fixtures/platform/supervisor-world");

function rec(supervisor, id) {
  return supervisor.records.get(id);
}

test("core.platform exposes the supervisor modules as one namespace", () => {
  const core = require("..");
  for (const name of ["supervisor", "control", "status", "idle", "entryClient"]) assert.equal(typeof core.platform[name], "object", name);
  assert.equal(typeof core.platform.supervisor.createSupervisor, "function");
  assert.equal(core.createSupervisor, undefined);
});

test("start order: `after` members spawn without waiting, `dependsOn` waits for readiness", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, {
    clock, profile: "full",
    ensureDocker: () => new Promise((resolve) => clock.setTimeout(() => resolve(true), 5000)),
  });
  const supervisor = world.create();
  const started = supervisor.start();
  await clock.advance(1000);
  // entry is `after: docker`, so it is spawned while Docker is still starting.
  assert.equal(rec(supervisor, "docker").state, "starting");
  assert.deepEqual(world.starts(), ["entry", "vllm-manager", "llama-manager"]);
  assert.equal(rec(supervisor, "platform-mcp").state, "blocked");
  assert.equal(rec(supervisor, "platform-mcp").blocked.reason, "requires-missing");
  assert.equal(rec(supervisor, "platform-mcp").blocked.fix, "env.mcp-dist");
  assert.equal(rec(supervisor, "tts-gateway").state, "not-installed");
  // search-gateway `dependsOn: docker`, so it waits for Docker readiness.
  assert.equal(world.starts("search-gateway").length, 0);
  await clock.advance(5000);
  await started;
  assert.equal(rec(supervisor, "docker").state, "ready");
  assert.deepEqual(world.starts(), ["entry", "vllm-manager", "llama-manager", "search-gateway"]);
  for (const id of ["entry", "vllm-manager", "llama-manager", "search-gateway"]) assert.equal(rec(supervisor, id).state, "ready", id);
  // The listener follows its parent and is never spawned.
  assert.equal(rec(supervisor, "service-entry-public").state, "unhealthy");
  assert.equal(world.starts("service-entry-public").length, 0);
  assert.equal(world.starts("tts-workers").length, 0, "on-demand members are not started by the profile");
  const desired = JSON.parse(fs.readFileSync(path.join(world.aiRoot, ".runtime", "platform", "desired.json"), "utf8"));
  assert.equal(desired.entry, "running");
});

test("Docker-blocked dependants resume when the 30 s Docker probe turns green", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, { clock, profile: "full", dockerUp: false });
  const supervisor = world.create();
  await supervisor.start();
  assert.equal(rec(supervisor, "docker").state, "blocked");
  assert.equal(rec(supervisor, "docker").reason, "docker-unavailable");
  assert.equal(rec(supervisor, "search-gateway").state, "blocked");
  assert.deepEqual(rec(supervisor, "search-gateway").blocked, { reason: "docker-unavailable", dependency: "docker" });
  assert.equal(rec(supervisor, "entry").state, "ready", "after-only members do not wait for Docker");
  world.dockerUp = true;
  await clock.advance(29000);
  assert.equal(world.starts("search-gateway").length, 0);
  await clock.advance(1000);
  assert.equal(rec(supervisor, "docker").state, "ready");
  assert.equal(world.starts("search-gateway").length, 1);
  assert.equal(rec(supervisor, "search-gateway").state, "ready");
});

test("crashes restart on the backoff schedule and fail after 5 restarts in 600 s", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, { clock });
  const supervisor = world.create();
  await supervisor.startComponent("entry", { wait: true });
  assert.equal(rec(supervisor, "entry").state, "ready");
  const delays = [];
  for (let index = 0; index < 5; index += 1) {
    const before = world.starts("entry").length;
    world.exit("entry", 1);
    await clock.flush();
    assert.equal(rec(supervisor, "entry").state, "backoff");
    assert.equal(rec(supervisor, "entry").lastExit.reason, "crash");
    const from = clock.now();
    while (world.starts("entry").length === before) await clock.advance(500);
    delays.push((clock.now() - from) / 1000);
    assert.equal(rec(supervisor, "entry").state, "ready");
  }
  assert.deepEqual(delays, [1, 2, 5, 15, 30]);
  world.exit("entry", 1);
  await clock.flush();
  assert.equal(rec(supervisor, "entry").state, "failed");
  assert.equal(rec(supervisor, "entry").reason, "max-restarts");
  await clock.advance(120000);
  assert.equal(world.starts("entry").length, 6, "no restart after failed");
  const failed = world.notifications.filter((item) => item.kind === "component.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, "error");
  assert.equal(typeof failed[0].title.zh, "string");
  assert.equal(typeof failed[0].body.en, "string");
  assert.match(failed[0].body.en, /crash/);
  assert.match(failed[0].title.en, /^Service entry /, "each language carries its own label");
  assert.match(failed[0].title.zh, /^统一入口/);
  assert.equal(world.notifications.filter((item) => item.kind === "component.recovered").length, 5);
  const status = await supervisor.status();
  const row = status.components.find((item) => item.id === "entry");
  assert.deepEqual(row.restarts, { count: 5, windowCount: 5 });
});

test("the restart counter resets after stableAfterSec of ready", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, { clock });
  const supervisor = world.create();
  await supervisor.startComponent("entry", { wait: true });
  world.exit("entry", 1);
  await clock.advance(1000);
  assert.equal(rec(supervisor, "entry").restartTimes.length, 1);
  await clock.advance(600 * 1000);
  assert.equal(rec(supervisor, "entry").restartTimes.length, 0);
});

test("a clean unrequested exit sets desired=stopped and does not restart", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, { clock });
  const supervisor = world.create();
  await supervisor.startComponent("vllm-manager", { wait: true });
  world.exit("vllm-manager", 0);
  await clock.advance(120000);
  const component = rec(supervisor, "vllm-manager");
  assert.equal(component.state, "stopped");
  assert.equal(component.desired, "stopped");
  assert.equal(component.lastExit.reason, "exit-clean");
  assert.equal(world.starts("vllm-manager").length, 1);
  const desired = JSON.parse(fs.readFileSync(path.join(world.aiRoot, ".runtime", "platform", "desired.json"), "utf8"));
  assert.equal(desired["vllm-manager"], "stopped");
});

test("EADDRINUSE after exit, or a foreign port owner before spawn, gives blocked{port-conflict} without retry", async (t) => {
  const clock = createFakeClock();
  const world = createWorld(t, { clock });
  const supervisor = world.create();
  await supervisor.startComponent("entry", { wait: true });
  const errLog = rec(supervisor, "entry").spec.logs.err;
  fs.mkdirSync(path.dirname(errLog), { recursive: true });
  fs.writeFileSync(errLog, "starting\nError: listen EADDRINUSE: address already in use 127.0.0.1:5176\n");
  world.exit("entry", 1);
  await clock.advance(120000);
  assert.equal(rec(supervisor, "entry").state, "blocked");
  assert.equal(rec(supervisor, "entry").reason, "port-conflict");
  assert.equal(rec(supervisor, "entry").lastExit.reason, "port-conflict");
  assert.ok(rec(supervisor, "entry").lastExit.stderrTail.some((line) => line.includes("EADDRINUSE")));
  assert.equal(world.starts("entry").length, 1);

  world.listen(5178, 999, { processCreatedAt: "2026-10-14T07:00:00.000Z", exe: "C:\\fixture\\python.exe", commandLine: "python -m http.server 5178", imageName: "python.exe" });
  await supervisor.startComponent("llama-manager", { wait: true });
  const llama = rec(supervisor, "llama-manager");
  assert.equal(llama.state, "blocked");
  assert.deepEqual(llama.blocked, { reason: "port-conflict", port: 5178, pid: 999, imageName: "python.exe" });
  assert.equal(world.starts("llama-manager").length, 0);
});

test("adoption: via the identity record, via the platform pattern, and stale records are archived", async (t) => {
  const world = createWorld(t);
  const created = "2026-10-14T06:00:00.000Z";
  world.identities.set("entry", { schemaVersion: 1, id: "entry", pid: 7001, processCreatedAt: created, exe: NODE_EXE, commandLine: "node server.js", startedAt: created });
  world.listen(5176, 7001, { processCreatedAt: created, exe: NODE_EXE, commandLine: "node server.js" });
  world.listen(5177, 7002, { processCreatedAt: created, exe: NODE_EXE, commandLine: "\"node.exe\" server.js" });
  world.identities.set("llama-manager", { schemaVersion: 1, id: "llama-manager", pid: 7003, processCreatedAt: created, exe: NODE_EXE, commandLine: "node server.js" });
  world.up.add("entry");
  world.up.add("vllm-manager");
  const supervisor = world.create();
  await supervisor.reconcile();
  assert.equal(rec(supervisor, "entry").state, "ready");
  assert.equal(rec(supervisor, "entry").owner, "supervisor");
  assert.equal(rec(supervisor, "entry").pid, 7001);
  assert.equal(rec(supervisor, "vllm-manager").state, "ready");
  assert.equal(rec(supervisor, "vllm-manager").owner, "adopted");
  assert.ok(world.calls.some((call) => call[0] === "adopt" && call[1] === "vllm-manager" && call[2] === 7002));
  assert.ok(world.calls.some((call) => call[0] === "archive" && call[1] === "llama-manager"));
  assert.equal(world.starts().length, 0);
  // Adopted processes that vanish are noticed by reconcile.
  world.processes.delete(7002);
  await supervisor.reconcile();
  assert.equal(rec(supervisor, "vllm-manager").lastExit.reason, "vanished");
});

test("an unknown port owner that does not look like the platform is never adopted", async (t) => {
  const world = createWorld(t);
  world.listen(5177, 7010, { processCreatedAt: "2026-10-14T06:00:00.000Z", exe: "C:\\fixture\\other.exe", commandLine: "other server.js" });
  world.up.add("vllm-manager");
  const supervisor = world.create();
  await supervisor.reconcile();
  assert.equal(rec(supervisor, "vllm-manager").state, "unknown");
  assert.equal(rec(supervisor, "vllm-manager").reason, "unknown-owner");
  assert.ok(!world.calls.some((call) => call[0] === "adopt"));
});

test("identity mismatch never kills", async (t) => {
  const world = createWorld(t);
  world.identities.set("entry", { schemaVersion: 1, id: "entry", pid: 7001, processCreatedAt: "2026-10-14T06:00:00.000Z", exe: NODE_EXE, commandLine: "node server.js" });
  // PID reused by a process created later.
  world.listen(5176, 7001, { processCreatedAt: "2026-10-14T07:30:00.000Z", exe: NODE_EXE, commandLine: "node server.js" });
  world.up.add("entry");
  const supervisor = world.create();
  await supervisor.reconcile();
  assert.equal(rec(supervisor, "entry").state, "unknown");
  assert.equal(rec(supervisor, "entry").reason, "identity-mismatch");
  await supervisor.stopComponent("entry", { wait: true });
  await supervisor.startComponent("entry", { wait: true });
  assert.equal(rec(supervisor, "entry").state, "unknown");
  assert.ok(!world.calls.some((call) => ["stop", "killTree", "start"].includes(call[0])), JSON.stringify(world.calls.filter((call) => call[0] !== "probe")));

  // A running child whose identity changed under it: the launcher refuses.
  await supervisor.startComponent("vllm-manager", { wait: true });
  const pid = rec(supervisor, "vllm-manager").pid;
  world.processes.get(pid).processCreatedAt = "2026-10-14T09:00:00.000Z";
  await supervisor.stopComponent("vllm-manager", { wait: true });
  assert.equal(rec(supervisor, "vllm-manager").state, "unknown");
  assert.equal(rec(supervisor, "vllm-manager").reason, "identity-mismatch");
  assert.ok(world.processes.has(pid), "the process is left running");
  assert.ok(!world.calls.some((call) => call[0] === "killTree"));
});

test("the listener component is never spawned and goes disabled when off", async (t) => {
  const world = createWorld(t, { runtimeOverrides: { "listeners.public.enabled": false } });
  const supervisor = world.create();
  await supervisor.startComponent("entry", { wait: true });
  await world.clock.flush();
  assert.equal(rec(supervisor, "service-entry-public").state, "disabled");
  assert.equal(world.starts("service-entry-public").length, 0);
  await assert.rejects(supervisor.startComponent("service-entry-public"), (error) => error.status === 400 && error.code === "detect_only_component");
  await assert.rejects(supervisor.stopComponent("service-entry-public"), (error) => error.status === 400 && error.code === "detect_only_component");

  const on = createWorld(t, { up: ["service-entry-public"] });
  const second = on.create();
  await second.startComponent("entry", { wait: true });
  await on.clock.flush();
  assert.equal(rec(second, "service-entry-public").state, "ready");
  await second.stopComponent("entry", { wait: true });
  assert.equal(rec(second, "service-entry-public").state, "stopped");
  assert.equal(on.starts("service-entry-public").length, 0);
  assert.ok(!on.calls.some((call) => call[0] === "stop" && call[1] === "service-entry-public"));
});

test("liveness failures make a ready component unhealthy after failureThreshold, and recovery clears it", async (t) => {
  const world = createWorld(t);
  const supervisor = world.create();
  await supervisor.startComponent("vllm-manager", { wait: true });
  world.up.delete("vllm-manager");
  await world.clock.advance(50000);
  assert.equal(rec(supervisor, "vllm-manager").state, "ready", "5 failures are below the threshold of 6");
  await world.clock.advance(10000);
  assert.equal(rec(supervisor, "vllm-manager").state, "unhealthy");
  assert.ok(world.events.some((event) => event.type === "component" && event.data.id === "vllm-manager" && event.data.state === "unhealthy"));
  world.up.add("vllm-manager");
  await world.clock.advance(10000);
  assert.equal(rec(supervisor, "vllm-manager").state, "ready");
});

test("idle gate: busy now -> 409 component_busy, idle -> pending restart that runs when idle and warns when overdue", async (t) => {
  const world = createWorld(t);
  const supervisor = world.create();
  await supervisor.startComponent("vllm-manager", { wait: true });
  world.blockers = [{ kind: "launch", source: "vllm-manager", id: "job_1", title: "Serve", since: null }];
  await assert.rejects(supervisor.restart(["vllm-manager"], { when: "now" }), (error) => error.status === 409 && error.code === "component_busy" && error.extra.blockers.length === 1);
  // Another manager's jobs do not hold this one.
  world.blockers = [{ kind: "download", source: "llama-manager", id: "job_2", title: "Download", since: null }];
  await supervisor.restart(["vllm-manager"], { when: "now", wait: true });
  assert.equal(world.starts("vllm-manager").length, 2);

  world.blockers = [{ kind: "requests", source: "entry", id: "streams", title: "2 streams", since: null }];
  const queued = await supervisor.restart(["vllm-manager"], { when: "idle" });
  assert.deepEqual(queued.queued, ["vllm-manager"]);
  const file = path.join(world.aiRoot, ".runtime", "platform", "pending-restarts.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved[0].id, "vllm-manager");
  assert.equal(Date.parse(saved[0].deadline) - Date.parse(saved[0].queuedAt), 6 * 3600 * 1000);
  await supervisor.pendingTick();
  assert.equal(world.starts("vllm-manager").length, 2, "still busy");

  await world.clock.advance(6 * 3600 * 1000 + 1000);
  await supervisor.pendingTick();
  await supervisor.pendingTick();
  const overdue = world.notifications.filter((item) => item.kind === "restart.overdue");
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].severity, "warn");
  assert.equal((await supervisor.pendingRestarts()).length, 1, "an overdue restart stays queued");

  world.blockers = [];
  await supervisor.pendingTick();
  assert.equal(world.starts("vllm-manager").length, 3);
  assert.equal((await supervisor.pendingRestarts()).length, 0);
  assert.equal(world.notifications.filter((item) => item.kind === "restart.executed").length, 1);
  assert.equal(rec(supervisor, "vllm-manager").state, "ready");
});

test("a 401 on the entry busy probe becomes an `unknown` blocker that fails closed", async (t) => {
  const requests = [];
  const world = createWorld(t, {
    collectBlockers: null,
    entryClient: { request: async (method, target) => { requests.push([method, target]); return { status: 401, json: null }; } },
  });
  const supervisor = world.create();
  await supervisor.startComponent("entry", { wait: true });
  await assert.rejects(supervisor.restart(["entry"], { when: "now" }), (error) => {
    assert.equal(error.code, "component_busy");
    assert.equal(error.extra.blockers[0].kind, "unknown");
    assert.equal(error.extra.blockers[0].source, "entry");
    return true;
  });
  assert.deepEqual(requests, [["GET", "/api/platform/busy"]]);
  const idle = await supervisor.idle();
  assert.equal(idle.idle, false);
});

test("re-exec hand-off closes the pipe, starts the successor and exits without touching children", async (t) => {
  const world = createWorld(t);
  const calls = [];
  const supervisor = world.create({
    closeControl: async () => calls.push("close"),
    reopenControl: async () => calls.push("reopen"),
    spawnSupervisor: async (args) => calls.push(["spawn", args]),
    waitForPipe: async (ms) => { calls.push(["wait", ms]); return true; },
    exit: (code) => calls.push(["exit", code]),
  });
  await supervisor.startComponent("entry", { wait: true });
  const result = await supervisor.reexec();
  assert.match(result.opId, /^op_/);
  await world.clock.advance(100);
  assert.deepEqual(calls, ["close", ["spawn", ["supervise", "--takeover", "--profile", "none"]], ["wait", 10000], ["exit", 0]]);
  assert.ok(!world.calls.some((call) => call[0] === "stop" || call[0] === "killTree"));
  assert.ok(world.processes.has(rec(supervisor, "entry").pid), "children keep running");

  const failing = createWorld(t);
  const failedCalls = [];
  const second = failing.create({
    closeControl: async () => failedCalls.push("close"),
    reopenControl: async () => failedCalls.push("reopen"),
    spawnSupervisor: async () => failedCalls.push("spawn"),
    waitForPipe: async () => false,
    exit: () => failedCalls.push("exit"),
  });
  await second.reexec();
  await failing.clock.advance(100);
  assert.deepEqual(failedCalls, ["close", "spawn", "reopen"]);
  assert.ok(failing.events.some((event) => event.type === "operation" && event.data.line === "reexec_failed"));
});

test("stopping with models lists containers and needs confirm; a plain stop never touches them", async (t) => {
  const posts = [];
  const world = createWorld(t, {
    fetch: async (url, init = {}) => {
      if (init.method === "POST") {
        posts.push(String(url));
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ instances: [{ id: "primary", containerName: "vllm-primary", running: true }] }), { status: 200 });
    },
  });
  const supervisor = world.create();
  await supervisor.startComponent("vllm-manager", { wait: true });
  await assert.rejects(supervisor.stopComponent("vllm-manager", { models: true }), (error) => {
    assert.equal(error.code, "confirm_required");
    assert.deepEqual(error.extra.containers.map((item) => item.instanceId), ["primary"]);
    return true;
  });
  assert.equal(rec(supervisor, "vllm-manager").state, "ready");
  await supervisor.stopComponent("vllm-manager", { wait: true });
  assert.deepEqual(posts, []);
  assert.equal(rec(supervisor, "vllm-manager").state, "stopped");
  assert.equal(rec(supervisor, "vllm-manager").lastExit.reason, "requested");
});

test("operations, events and logs are served from the supervisor", async (t) => {
  const world = createWorld(t);
  const supervisor = world.create();
  const { opId } = await supervisor.startComponent("entry");
  await world.clock.flush();
  const operation = await supervisor.operation(opId);
  assert.equal(operation.state, "ok");
  assert.ok(operation.log.length >= 1);
  await assert.rejects(supervisor.operation("op_missing"), (error) => error.status === 404);
  await world.clock.advance(1500);
  assert.ok(world.events.some((event) => event.type === "status" && event.data.full === true && event.data.status.schemaVersion === 1));
  const out = rec(supervisor, "entry").spec.logs.out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "one\ntwo\n");
  const logs = await supervisor.componentLogs("entry", { stream: "out", tail: 1 });
  assert.deepEqual(logs.lines, [{ stream: "out", text: "two" }]);
  const described = await supervisor.describeComponent("entry");
  assert.ok(Object.values(described.spec.env).every((value) => value === "<redacted>"));
  await assert.rejects(supervisor.describeComponent("nope"), (error) => error.status === 404 && error.code === "component_unknown");
  const jsonl = fs.readFileSync(path.join(world.aiRoot, "logs", "platform", "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(jsonl.length > 2);
});

test("the supervise process holds the pipe with a fresh token; a second one reports already running", async (t) => {
  const control = require("../platform/control");
  const { startSupervisorProcess } = require("../platform/supervisor");
  const world = createWorld(t);
  let stored = "";
  const tokenStore = { read: () => stored, write: async (value) => { stored = value; } };
  const endpoint = control.controlEndpoint(world.aiRoot);
  const first = await startSupervisorProcess(world.options({ endpoint, tokenStore }));
  t.after(() => first.close());
  assert.equal(first.alreadyRunning, false);
  assert.match(stored, /^[A-Za-z0-9_-]{43}$/);
  const client = control.createControlClient({ endpoint, readToken: () => tokenStore.read() });
  const status = await client.request("GET", "/v1/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.mode, "supervised");
  const before = stored;
  const second = await startSupervisorProcess(world.options({ endpoint, tokenStore }));
  assert.deepEqual(second, { alreadyRunning: true, endpoint });
  assert.equal(stored, before, "a refused second supervisor never replaces the token");
});
