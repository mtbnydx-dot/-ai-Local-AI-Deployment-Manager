"use strict";

// Deploy restarts (06 §9.3 step 5, OPS-11b): restartViaSupervisor over a fake
// control client, and executePostDeploy wired to it. Nothing here touches a
// real supervisor, pipe or service.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const steps = require("../platform/deploy-steps");

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function registry() {
  return {
    packages: [],
    components: [
      { id: "docker", kind: "external" },
      { id: "entry", kind: "node", paths: ["service-entry/**", "manager-core/**", "!manager-core/platform/**"] },
      { id: "vllm-manager", kind: "node", paths: ["vllm-manager/**", "manager-core/**", "!manager-core/platform/**"] },
      { id: "llama-manager", kind: "node", paths: ["llama-manager/**", "manager-core/**", "!manager-core/platform/**"] },
    ],
  };
}

function manifestOf(...paths) {
  return { schemaVersion: 1, deployedAt: new Date(NOW).toISOString(), commit: "a".repeat(40), branch: "feature/x", files: paths.map((p) => ({ path: p, action: "updated", afterSha256: "0".repeat(64) })) };
}

/**
 * A fake control client. `busy` ids answer queued; `pids` is consumed by the
 * /v1/status polls, so a re-exec shows a new pid after a few polls.
 */
function fakeControl({ up = true, busy = {}, failing = {}, pids = [100, 100, 200] } = {}) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    available: async () => up,
    request: async (method, route, options = {}) => {
      calls.push({ method, route, body: options.body });
      if (route === "/v1/status") {
        const pid = pids[Math.min(polls, pids.length - 1)];
        polls += 1;
        return { status: 200, json: { supervisor: { pid } } };
      }
      if (route === "/v1/reexec") return { status: 202, json: { ok: true } };
      const match = /^\/v1\/components\/([a-z0-9-]+)\/restart$/.exec(route);
      if (match) {
        const id = match[1];
        if (failing[id]) return { status: 500, json: { error: { code: failing[id] } } };
        if (busy[id]) return { status: 202, json: { ok: true, queued: true, blockers: busy[id] } };
        return { status: 202, json: { ok: true, opId: `op-${id}` } };
      }
      return { status: 404, json: {} };
    },
  };
}

async function post(root, manifest, options = {}) {
  const backup = path.join(root, "artifacts", "worktree-deploy-backups", "20261015-120000");
  fs.mkdirSync(backup, { recursive: true });
  const manifestFile = path.join(backup, "deployment-manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return steps.executePostDeploy({
    aiRoot: root, manifest, manifestFile, backupRoot: backup, registry: registry(), allManifests: [],
    now: () => NOW, nodeVersion: "v24.16.0", noPrune: true, ...options,
  });
}

const adapterFor = (control) => (request) => steps.restartViaSupervisor({ ...request, control, sleep: async () => {}, now: () => NOW });

test("changed restarts idle components now and queues busy ones with their blockers", async (t) => {
  const root = tempRoot(t);
  const blockers = [{ kind: "launch", source: "vllm", id: "j1", title: "Load model" }];
  const control = fakeControl({ busy: { "vllm-manager": blockers } });
  const result = await post(root, manifestOf("vllm-manager\\server.js", "llama-manager\\server.js", "docs\\readme.md"), { restart: "changed", restartAdapter: adapterFor(control) });
  assert.equal(result.ok, true);
  assert.equal(result.restartResult.action, "requested");
  assert.deepEqual(result.restartResult.ids, ["llama-manager", "vllm-manager"]);
  const posts = control.calls.filter((call) => call.method === "POST");
  assert.deepEqual(posts.map((call) => call.route), ["/v1/components/llama-manager/restart", "/v1/components/vllm-manager/restart"]);
  for (const call of posts) assert.deepEqual(call.body, { when: "idle" });
  const outcome = result.restartResult.outcome;
  assert.deepEqual(outcome.restarted, ["llama-manager"]);
  assert.deepEqual(outcome.queued, [{ id: "vllm-manager", blockers }]);
  assert.equal(outcome.reexeced, false);
});

test("a supervisor change re-execs first and waits for the new pid before any restart", async (t) => {
  const root = tempRoot(t);
  const control = fakeControl();
  const result = await post(root, manifestOf("manager-core\\platform\\supervisor.js", "vllm-manager\\server.js"), { restart: "changed", restartAdapter: adapterFor(control) });
  assert.equal(result.restartResult.action, "requested");
  assert.equal(result.restartResult.reexec, true);
  assert.equal(result.restartResult.outcome.reexeced, true);
  const routes = control.calls.map((call) => `${call.method} ${call.route}`);
  const reexecAt = routes.indexOf("POST /v1/reexec");
  const restartAt = routes.indexOf("POST /v1/components/vllm-manager/restart");
  assert.ok(reexecAt >= 0 && restartAt > reexecAt, routes.join(" | "));
  assert.ok(routes.slice(reexecAt, restartAt).filter((route) => route === "GET /v1/status").length >= 2, "polled until the pid changed");
});

test("a re-exec that never completes restarts nothing and falls back to the printed commands", async (t) => {
  const root = tempRoot(t);
  const control = fakeControl({ pids: [100] });
  let clock = NOW;
  const adapter = (request) => steps.restartViaSupervisor({ ...request, control, sleep: async () => { clock += 10000; }, now: () => clock });
  const result = await post(root, manifestOf("scripts\\platformctl.js", "vllm-manager\\server.js"), { restart: "changed", restartAdapter: adapter });
  assert.equal(result.ok, true, "the files are deployed; a restart problem is not a failure");
  assert.equal(result.restartResult.action, "commands");
  assert.equal(result.restartResult.code, "reexec_failed");
  assert.deepEqual(result.restartResult.commands, ["platform supervisor reexec", "platform restart vllm-manager --when-idle"]);
  assert.equal(control.calls.some((call) => call.route.includes("/components/")), false);
});

test("without the supervisor the step prints the commands and still succeeds", async (t) => {
  const root = tempRoot(t);
  const control = fakeControl({ up: false });
  const result = await post(root, manifestOf("vllm-manager\\server.js"), { restart: "changed", restartAdapter: adapterFor(control) });
  assert.equal(result.ok, true);
  assert.equal(result.restartResult.action, "commands");
  assert.equal(result.restartResult.code, "supervisor_unavailable");
  assert.deepEqual(result.restartResult.commands, ["platform restart vllm-manager --when-idle"]);
  assert.deepEqual(control.calls, []);
});

test("restart none never calls the supervisor", async (t) => {
  const root = tempRoot(t);
  const control = fakeControl();
  const result = await post(root, manifestOf("vllm-manager\\server.js"), { restart: "none", restartAdapter: adapterFor(control) });
  assert.equal(result.restartResult.action, "listed");
  assert.deepEqual(control.calls, []);
});

test("all restarts every restartable component; external ones are skipped", async (t) => {
  const root = tempRoot(t);
  const control = fakeControl();
  const result = await post(root, manifestOf("docs\\readme.md"), { restart: "all", restartAdapter: adapterFor(control) });
  assert.deepEqual([...result.restartResult.outcome.restarted].sort(), ["entry", "llama-manager", "vllm-manager"]);
});

test("a single failed restart is reported and does not stop the others", async () => {
  const control = fakeControl({ failing: { entry: "component_failed" } });
  const outcome = await steps.restartViaSupervisor({ ids: ["entry", "llama-manager"], control, sleep: async () => {} });
  assert.deepEqual(outcome.failed, [{ id: "entry", code: "component_failed" }]);
  assert.deepEqual(outcome.restarted, ["llama-manager"]);
});

test("nothing changed means no supervisor call", async (t) => {
  const root = tempRoot(t);
  const control = fakeControl();
  const result = await post(root, manifestOf("docs\\readme.md"), { restart: "changed", restartAdapter: adapterFor(control) });
  assert.equal(result.restartResult.action, "nothing");
  assert.deepEqual(control.calls, []);
});
