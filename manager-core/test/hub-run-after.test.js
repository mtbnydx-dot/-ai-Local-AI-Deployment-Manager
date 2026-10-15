"use strict";

// Download & Run of the model hub (docs/overhaul/03-hub.md §11, HUB-14). A
// fake manager server answers POST /api/launch/plan and /api/start on an
// ephemeral loopback port and logs every request; the download queue runs
// with a fake transfer engine. Nothing reaches a real manager, Docker or the
// network.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDownloadQueue } = require("../model-hub/queue");
const { createHubStore } = require("../model-hub/store");
const { createRunAfter, normalizeRunAfterRequest } = require("../model-hub/run-after");

const SHA = "b".repeat(40);
const CARD = { schemaVersion: 1, source: "remote", repo: "org/model", format: "gguf", weightsBytes: 1000 };
const REQUEST = { engineId: "llamacpp", managerId: null, recipeId: null, values: { contextLength: 32768 }, acceptWarnings: false, allowReplace: false };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-run-after-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const quietLogger = () => ({ warn() {}, info() {}, log() {}, error() {}, debug() {} });

async function until(predicate, { timeoutMs = 10000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A loopback port nothing listens on.
function closedPort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// A manager that plans and starts what the test tells it to. `log` has
// { method, url, headers, body } for every request.
async function fakeManager(t, handlers = {}) {
  const log = [];
  const manager = {
    log,
    plan: handlers.plan || (() => ({ status: 200, json: { ok: true, errors: [], blockers: [], warnings: [], steps: [{ kind: "start", containerName: "llama-local" }], planHash: "sha256:aaa", admission: { verdict: "ok" } } })),
    start: handlers.start || (() => ({ status: 200, json: { job: { id: "job_1", meta: { launchId: "lch_1" } }, plan: { planHash: "sha256:aaa" } } })),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      log.push({ method: req.method, url: req.url, headers: req.headers, body });
      let answer = { status: 404, json: { error: "Not found" } };
      if (req.method === "POST" && req.url === "/api/launch/plan") answer = manager.plan(body, log);
      else if (req.method === "POST" && req.url === "/api/start") answer = manager.start(body, log);
      else if (req.method === "GET" && req.url === "/api/engines") answer = { status: 200, json: { engines: [{ id: "llamacpp" }, { id: "vllm" }] } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  manager.port = server.address().port;
  manager.calls = (url) => log.filter((entry) => entry.url === url);
  return manager;
}

function runAfterFor(manager, extra = {}) {
  return createRunAfter({ managers: [{ id: "llama", port: manager.port }, { id: "vllm", port: manager.port }], logger: quietLogger(), ...extra });
}

const replacePlan = (containerName) => ({
  status: 200,
  json: { ok: true, errors: [], warnings: [], planHash: `sha256:${containerName}`, admission: { verdict: "ok" }, steps: [{ kind: "replace", containerName, model: "old-model" }, { kind: "start", containerName }] },
});

// --- plan time (advisory) ---------------------------------------------------------

test("the prospective plan sends model.card and prospective:true, no model.ref, with an x-request-id", async (t) => {
  const manager = await fakeManager(t);
  const result = await runAfterFor(manager).advise({ request: REQUEST, card: CARD });
  const plans = manager.calls("/api/launch/plan");
  assert.equal(plans.length, 1);
  assert.equal(manager.calls("/api/start").length, 0);
  const [call] = plans;
  assert.equal(call.body.prospective, true);
  assert.deepEqual(call.body.model, { card: CARD });
  assert.equal(Object.hasOwn(call.body.model, "ref"), false);
  assert.equal(call.body.engineId, "llamacpp");
  assert.deepEqual(call.body.values, { contextLength: 32768 });
  assert.deepEqual(call.body.instance, { mode: "replace" });
  assert.match(call.headers["x-request-id"], /^hub-run-/);
  assert.equal(result.managerId, "llama");
  assert.equal(result.advice.available, true);
  assert.equal(result.advice.verdict, "ok");
  assert.equal(result.advice.planHash, "sha256:aaa");
});

test("a block verdict makes Download & Run unavailable in the advice, and a manager that is down does not throw", async (t) => {
  const manager = await fakeManager(t, {
    plan: () => ({ status: 200, json: { ok: true, errors: [], steps: [], planHash: "sha256:x", admission: { verdict: "block", message: "no memory" } } }),
  });
  const blocked = await runAfterFor(manager).advise({ request: REQUEST, card: CARD });
  assert.equal(blocked.advice.available, false);
  assert.equal(blocked.advice.verdict, "block");
  assert.equal(blocked.advice.message, "no memory");

  const unreachable = createRunAfter({ managers: [{ id: "llama", port: await closedPort() }], logger: quietLogger(), timeoutMs: 300 });
  const offline = await unreachable.advise({ request: { ...REQUEST, managerId: "llama" }, card: CARD });
  assert.equal(offline.advice.available, false);
  assert.equal(offline.advice.errors[0].code, "manager_unreachable");
});

test("without 01 support the plan is 422 run_after_unavailable (400 naming prospective, 404 or ENG-7's plan error), detected once per manager", async (t) => {
  const variants = [
    { status: 400, json: { error: { code: "invalid_body", message: "prospective is not supported here" } } },
    { status: 404, json: { error: "Not found" } },
    { status: 200, json: { ok: false, errors: [{ field: "prospective", code: "prospective_unsupported", message: "no" }], steps: [] } },
  ];
  for (const answer of variants) {
    const manager = await fakeManager(t, { plan: () => answer });
    const runAfter = runAfterFor(manager);
    await assert.rejects(() => runAfter.advise({ request: REQUEST, card: CARD }), (error) => {
      assert.equal(error.code, "run_after_unavailable");
      assert.equal(error.status, 422);
      return true;
    });
    assert.equal(runAfter.isUnavailable("llama"), true);
    const before = manager.calls("/api/launch/plan").length;
    await assert.rejects(() => runAfter.advise({ request: REQUEST, card: CARD }), { code: "run_after_unavailable" });
    assert.equal(manager.calls("/api/launch/plan").length, before, "not asked again");
  }
  const manager = await fakeManager(t);
  await assert.rejects(() => runAfterFor(manager).advise({ request: REQUEST, card: null }), { code: "run_after_unavailable" });
  assert.equal(manager.calls("/api/launch/plan").length, 0, "no card, no plan");
});

test("the runAfter request is validated and reduced to its fields", () => {
  assert.equal(normalizeRunAfterRequest(null), null);
  assert.deepEqual(normalizeRunAfterRequest({ engineId: "vllm", extra: 1 }), { engineId: "vllm", managerId: null, recipeId: null, values: {}, acceptWarnings: false, allowReplace: false });
  for (const bad of ["x", [], {}, { engineId: "" }, { engineId: "vllm", values: [] }, { engineId: "vllm", allowReplace: "yes" }, { engineId: "vllm", managerId: 3 }]) {
    assert.throws(() => normalizeRunAfterRequest(bad), { code: "invalid_request", status: 400 }, JSON.stringify(bad));
  }
});

test("the manager is resolved from the engine list, falling back to gguf → llama and the rest → vllm", async (t) => {
  const manager = await fakeManager(t);
  const viaList = createRunAfter({
    managers: [{ id: "llama", port: manager.port }, { id: "vllm", port: manager.port }],
    getEngines: async () => ({ engines: [{ id: "sglang", managerId: "vllm" }, { id: "llamacpp", managerId: "llama" }] }),
    logger: quietLogger(),
  });
  assert.equal((await viaList.resolveManager({ engineId: "sglang", managerId: null })).id, "vllm");
  assert.equal((await viaList.resolveManager({ engineId: "llamacpp", managerId: null })).id, "llama");
  const fallback = runAfterFor(manager, { getEngines: async () => { throw new Error("down"); } });
  assert.equal((await fallback.resolveManager({ engineId: "llamacpp", managerId: null })).id, "llama");
  assert.equal((await fallback.resolveManager({ engineId: "sglang", managerId: null })).id, "vllm");
  assert.equal((await fallback.resolveManager({ engineId: "sglang", managerId: "llama" })).id, "llama");
  await assert.rejects(() => fallback.resolveManager({ engineId: "x", managerId: "nope" }), { code: "run_after_unavailable" });
  // Without a getEngines, each manager's own /api/engines is read.
  assert.equal((await runAfterFor(manager).resolveManager({ engineId: "vllm", managerId: null })).id, "llama", "the first manager listing the engine");
});

// --- completion (authoritative) -----------------------------------------------------

function fakeEngine() {
  const started = [];
  return {
    id: "cli",
    started,
    start(job, hooks) {
      const handle = {
        jobId: job.id,
        pid: 4000 + started.length,
        stopReason: null,
        exited: false,
        exit(code = 0) {
          if (handle.exited) return;
          handle.exited = true;
          hooks.onExit({ code, signal: null, stopReason: handle.stopReason, stderrTail: [] });
        },
        stop() {
          setImmediate(() => handle.exit(null));
          return Promise.resolve();
        },
        stderrTail: () => [],
      };
      started.push(handle);
      hooks.onSpawn({ pid: handle.pid, startedAt: new Date().toISOString() });
      return handle;
    },
    async findOrphans() {
      return [];
    },
  };
}

function fakeEvents() {
  const published = [];
  return {
    published,
    publish(type, payload) {
      published.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    },
    of: (type) => published.filter((item) => item.type === type),
  };
}

function jobSpec(root, runAfter) {
  return {
    origin: { kind: "console" },
    runAfter,
    artifact: {
      provider: "huggingface", repo: "org/model", revision: "main", revisionSha: SHA, artifactKey: "gguf:|Q4_K_M",
      kind: "gguf-quant", format: "gguf", quant: "Q4_K_M", companions: [],
      files: [{ path: "model-Q4_K_M.gguf", size: 1000, sha256: null, role: "weight" }], totalBytes: 1000,
    },
    target: { rootId: "legacy", rootLabel: "Library", outputName: "model", localDir: path.join(root, "models", "model"), volume: "X:" },
    transfer: { options: { source: "huggingface", endpoint: "https://huggingface.co", xet: "default", credentialMode: "cached-login", tokenRef: null, remember: false } },
  };
}

// Enqueues a download with `runAfterRequest` and lets it finish into `ready`.
async function readyJob(t, manager, runAfterRequest, runAfterOptions = {}) {
  const root = tempDir(t);
  const store = createHubStore({ dataDir: path.join(root, "hub") });
  await store.init();
  const engine = fakeEngine();
  const events = fakeEvents();
  const queue = createDownloadQueue({
    store,
    engine,
    verifier: { verifyArtifact: async () => ({ ok: true, verifiedFiles: [], seconds: 0 }) },
    library: null,
    settings: () => ({
      transfer: { maxConcurrent: 1, xet: "high-performance" },
      retry: { maxAttempts: 3, baseDelaySeconds: 0.01, maxDelaySeconds: 0.05, perClass: {} },
      queue: { idleOnly: false, idleGraceSeconds: 0, resumeOnStart: true, resumeDelaySeconds: 0 },
      storage: { reserveGb: 0 },
      history: { keepRecords: 200, retentionDays: 365 },
      notifications: { onReady: true, onFailure: true },
    }),
    events,
    runAfter: runAfterFor(manager, runAfterOptions),
    logger: quietLogger(),
    pollMs: 10,
    stopWaitMs: 200,
  });
  await queue.start();
  t.after(() => queue.stop());
  const job = await queue.enqueue(jobSpec(root, runAfterRequest));
  await until(() => engine.started.length === 1, { what: "transfer start" });
  engine.started[0].exit(0);
  await until(() => queue.get(job.id).state === "ready", { what: "ready" });
  return { queue, job, events, localDir: job.target.localDir };
}

const settled = (queue, id, states) => until(() => states.includes(queue.get(id).runAfter?.state), { what: `runAfter ${states.join("|")}` });

// The hub never stops or removes anything (03 §11): no request of the log may.
function assertNoStopOrRemove(manager, label = "") {
  for (const entry of manager.log) {
    assert.equal(/stop|remove|delete|kill|unload/i.test(entry.url), false, `${label} ${entry.method} ${entry.url}`);
    assert.notEqual(entry.method, "DELETE", label);
  }
}

test("the authoritative plan sends model.ref and no prospective flag, then /api/start runs once with the same body", async (t) => {
  const manager = await fakeManager(t);
  const { queue, job, events, localDir } = await readyJob(t, manager, { ...REQUEST });
  await settled(queue, job.id, ["started"]);
  const planCalls = manager.calls("/api/launch/plan");
  assert.equal(planCalls.length, 1);
  assert.deepEqual(planCalls[0].body.model, { ref: localDir });
  assert.equal(Object.hasOwn(planCalls[0].body, "prospective"), false);
  const starts = manager.calls("/api/start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].body, planCalls[0].body);
  assert.match(starts[0].headers["x-request-id"], /^hub-run-/);
  assert.equal(starts[0].headers["x-request-id"], planCalls[0].headers["x-request-id"]);

  const after = queue.get(job.id);
  assert.equal(after.state, "ready", "the download stays ready");
  assert.equal(after.runAfter.state, "started");
  assert.equal(after.runAfter.launchJobId, "job_1");
  assert.equal(after.runAfter.launchId, "lch_1");
  assert.equal(after.runAfter.planHash, "sha256:aaa");
  assert.equal(after.runAfter.managerId, "llama");
  assert.equal(after.runAfter.engineId, "llamacpp");
  await until(() => events.of("notification").some((item) => item.payload.kind === "hub.runAfter.started"), { what: "started notification" });
  const kinds = events.of("notification").map((item) => item.payload.kind);
  assert.ok(kinds.includes("hub.download.ready") && kinds.includes("hub.runAfter.started"), kinds.join());
  assert.ok(events.of("downloads").some((item) => item.payload.jobs[0]?.runAfter?.state === "started"), "the job event carries the result");
  assertNoStopOrRemove(manager);
});

test("a replace waits for confirmation; POST /run starts once; nothing is stopped or removed", async (t) => {
  const manager = await fakeManager(t, { plan: () => replacePlan("llama-local") });
  const { queue, job, events, localDir } = await readyJob(t, manager, { ...REQUEST });
  await settled(queue, job.id, ["needs-confirmation"]);
  assert.equal(manager.calls("/api/start").length, 0);
  const waiting = queue.get(job.id).runAfter;
  assert.deepEqual([waiting.pending.reason, waiting.pending.containerName], ["replace", "llama-local"]);
  // The state is visible before the notification is published.
  await until(() => events.of("notification").some((item) => item.payload.kind === "hub.runAfter.confirm"), { what: "confirmation notification" });
  const note = events.of("notification").map((item) => item.payload).find((item) => item.kind === "hub.runAfter.confirm");
  assert.equal(note.jobId, job.id);
  assert.deepEqual(note.action.apiCall, { method: "POST", path: `/api/hub/downloads/${job.id}/run`, body: { confirmReplace: true } });

  await assert.rejects(() => queue.confirmRunAfter(job.id, {}), { code: "confirmation_required", status: 400 });
  const confirmed = await queue.confirmRunAfter(job.id, { confirmReplace: true });
  assert.equal(confirmed.runAfter.state, "started");
  assert.equal(manager.calls("/api/start").length, 1);
  assert.deepEqual(manager.calls("/api/start")[0].body.model, { ref: localDir });
  await assert.rejects(() => queue.confirmRunAfter(job.id, { confirmReplace: true }), { code: "invalid_state", status: 409 });
  assert.equal(manager.calls("/api/start").length, 1, "start is called once");
  assertNoStopOrRemove(manager);
});

test("allowReplace starts without a confirmation", async (t) => {
  const manager = await fakeManager(t, { plan: () => replacePlan("llama-local") });
  const { queue, job } = await readyJob(t, manager, { ...REQUEST, allowReplace: true });
  await settled(queue, job.id, ["started"]);
  assert.equal(manager.calls("/api/start").length, 1);
  assertNoStopOrRemove(manager);
});

test("a plan that names a different instance than the confirmed one asks again", async (t) => {
  let name = "llama-local";
  const manager = await fakeManager(t, { plan: () => replacePlan(name) });
  const { queue, job, events } = await readyJob(t, manager, { ...REQUEST });
  await settled(queue, job.id, ["needs-confirmation"]);
  name = "llama-other";
  const again = await queue.confirmRunAfter(job.id, { confirmReplace: true });
  assert.equal(again.runAfter.state, "needs-confirmation");
  assert.deepEqual([again.runAfter.pending.reason, again.runAfter.pending.containerName], ["instance_changed", "llama-other"]);
  assert.equal(manager.calls("/api/start").length, 0);
  assert.equal(events.of("notification").filter((item) => item.payload.kind === "hub.runAfter.confirm").length, 2, "asked again");
  const done = await queue.confirmRunAfter(job.id, { confirmReplace: true });
  assert.equal(done.runAfter.state, "started");
  assert.equal(manager.calls("/api/start").length, 1);
  assertNoStopOrRemove(manager);
});

test("block, unaccepted warn, an error plan and a failing start leave the download ready with the failure in runAfter", async (t) => {
  const cases = [
    { name: "block", plan: { status: 200, json: { ok: true, errors: [], steps: [], planHash: "sha256:b", admission: { verdict: "block", message: "too big" } } }, code: "plan_blocked" },
    { name: "warn", plan: { status: 200, json: { ok: true, errors: [], steps: [], planHash: "sha256:w", admission: { verdict: "warn", message: "tight" } } }, code: "plan_warning" },
    { name: "errors", plan: { status: 200, json: { ok: false, errors: [{ code: "recipe_blocked", message: "retired" }], steps: [], admission: null } }, code: "plan_blocked" },
    { name: "http", plan: { status: 500, json: { error: "boom" } }, code: "plan_failed" },
    { name: "start", start: { status: 409, json: { error: { code: "instance_conflict", message: "busy" } } }, code: "start_failed" },
  ];
  for (const item of cases) {
    const manager = await fakeManager(t, { ...(item.plan ? { plan: () => item.plan } : {}), ...(item.start ? { start: () => item.start } : {}) });
    const { queue, job, events } = await readyJob(t, manager, { ...REQUEST });
    await settled(queue, job.id, ["failed"]);
    const after = queue.get(job.id);
    assert.equal(after.state, "ready", item.name);
    assert.equal(after.runAfter.error.code, item.code, item.name);
    await until(() => events.of("notification").some((entry) => entry.payload.kind === "hub.runAfter.failed"), { what: `${item.name} notification` });
    assertNoStopOrRemove(manager, item.name);
  }
  const warn = await fakeManager(t, { plan: () => ({ status: 200, json: { ok: true, errors: [], steps: [], planHash: "sha256:w", admission: { verdict: "warn" } } }) });
  const accepted = await readyJob(t, warn, { ...REQUEST, acceptWarnings: true });
  await settled(accepted.queue, accepted.job.id, ["started"]);
});

test("an unreachable manager fails the run, not the download", async (t) => {
  const manager = await fakeManager(t);
  const { queue, job } = await readyJob(t, manager, { ...REQUEST, managerId: "gone" }, { managers: [{ id: "gone", port: await closedPort() }], timeoutMs: 300 });
  await settled(queue, job.id, ["failed"]);
  assert.equal(queue.get(job.id).state, "ready");
  assert.equal(queue.get(job.id).runAfter.error.code, "manager_unreachable");
});
