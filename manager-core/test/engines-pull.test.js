"use strict";

// POST /api/runtimes/:runtimeId/pull and the supervisor's pull job (docs/
// overhaul/01-engines.md §14 "Pull jobs", §21.1, 00 §9.2; ENG-11). The route
// runs over a recording app, the supervisor over a fake host whose pull is
// driven by the test, a fake GPU admission and a recording event hub. No
// docker process is spawned and nothing is pulled.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-pull-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");
const jobUtils = require("../job-utils");
const { createRuntimeSupervisor, PULL_JOB_ID_PATTERN } = require("../engines/runtime-supervisor");

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

async function pullRequest(app, runtimeId, body = { confirm: true }) {
  const res = fakeResponse();
  await app.routes.get("POST /api/runtimes/:runtimeId/pull")({ headers: {}, params: { runtimeId }, body }, res);
  return res;
}

function emptyOverrideDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-pull-override-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every RuntimeHost method records its call; pull() resolves or rejects when
// the test says so and reports layer progress through onProgress.
function fakeHost() {
  const calls = [];
  const pending = [];
  const record = (name) => async (...args) => {
    calls.push([name, args[0]]);
    throw new Error(`${name} must not be called by a pull`);
  };
  const host = {
    kind: "docker",
    ready: record("ready"),
    inspect: record("inspect"),
    list: record("list"),
    ensureImage: record("ensureImage"),
    checkpoint: record("checkpoint"),
    create: record("create"),
    logs: record("logs"),
    stop: record("stop"),
    pull(image, options = {}) {
      calls.push(["pull", image, options.platform]);
      return new Promise((resolve, reject) => pending.push({ image, options, resolve, reject }));
    },
  };
  return { host, calls, pending };
}

function fakeJobs() {
  const jobs = new Map();
  return {
    jobs,
    api: {
      createJob(type, title, meta, options = {}) {
        const job = jobUtils.createJobRecord(type, title, meta, options);
        jobs.set(job.id, job);
        return job;
      },
      appendLog(job, text) {
        for (const line of String(text || "").split("\n")) if (line) job.logs.push(line);
      },
      setJobProgress(job, progress) { jobUtils.applyJobProgress(job, progress); },
      scheduleJobsSave() {},
      finishJob(job, meta) { jobUtils.markJobSuccess(job, { meta }); },
      failJob(job, error) { jobUtils.markJobFailed(job, error?.message || String(error)); },
    },
  };
}

function setup(t, { managerId = "vllm", local = true } = {}) {
  const registry = core.engines.createEngineRegistry({ overrideDir: emptyOverrideDir(t), env: {} });
  const { host, calls, pending } = fakeHost();
  const jobs = fakeJobs();
  const sent = [];
  const admissionCalls = [];
  const admission = new Proxy({}, { get: (_target, name) => (...args) => { admissionCalls.push([name, args]); } });
  const supervisor = createRuntimeSupervisor({
    managerId,
    host,
    jobs: jobs.api,
    admission,
    events: { broadcast: (event, data) => sent.push({ event, data: JSON.parse(JSON.stringify(data)) }) },
    resolveRuntime: (runtimeId) => core.engines.findHostedRuntime(registry, managerId, runtimeId),
    imagePlatform: "linux/amd64",
  });
  let presenceCleared = 0;
  const app = recordingApp();
  const routes = core.engines.registerEngineRoutes(app, {
    registry,
    managerId,
    isLocalRequest: () => local,
    getImageStatus: async () => ({ ok: false, reason: "missing-image" }),
    pullRuntime: (runtimeId, options) => supervisor.pullRuntime(runtimeId, {
      ...options,
      onSettled: (job) => { presenceCleared += 1; options.onSettled?.(job); },
    }),
  });
  return { registry, supervisor, app, routes, host, calls, pending, jobs, sent, admissionCalls, presenceCleared: () => presenceCleared };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the pull route requires confirm:true and an admin caller, and creates no job without them", async (t) => {
  const world = setup(t);
  const unconfirmed = await pullRequest(world.app, "vllm@0.28.0", {});
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(unconfirmed.body.ok, false);
  assert.equal(unconfirmed.body.error.code, "confirm_required");
  assert.equal((await pullRequest(world.app, "vllm@0.28.0", { confirm: "yes" })).statusCode, 400);

  const remote = setup(t, { local: false });
  const forbidden = await pullRequest(remote.app, "vllm@0.28.0");
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.body.error.code, "forbidden");

  assert.equal(world.jobs.jobs.size + remote.jobs.jobs.size, 0);
  assert.deepEqual(world.calls, []);
});

test("an unknown or foreign runtime is 404 and a local build is 422 with the rebuild hint", async (t) => {
  const world = setup(t);
  const unknown = await pullRequest(world.app, "vllm@does-not-exist");
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, "unknown_runtime");
  // llama.cpp's runtime is not hosted by the vLLM manager.
  assert.equal((await pullRequest(world.app, "llamacpp@b10630")).statusCode, 404);

  const localBuild = await pullRequest(world.app, "sglang@qwen38flashnext-sm120-dac5523d");
  assert.equal(localBuild.statusCode, 422);
  assert.equal(localBuild.body.error.code, "runtime_local_build");
  assert.match(localBuild.body.error.hint, /Rebuild/);
  assert.equal(world.jobs.jobs.size, 0);
  assert.deepEqual(world.calls, []);
});

test("a pull is a dl_ image-pull job with progress on jobs events, joined by a concurrent request, and touches no container or lease", async (t) => {
  const world = setup(t);
  const image = world.registry.resolveRuntime("vllm", { runtimeId: "vllm@0.28.0" }).image;

  const first = await pullRequest(world.app, "vllm@0.28.0");
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.existing, false);
  assert.match(first.body.job.id, PULL_JOB_ID_PATTERN);
  assert.match(first.body.job.id, /^dl_[a-z2-7]{20}$/);
  assert.equal(first.body.job.type, "image-pull");
  assert.equal(first.body.job.meta.runtimeId, "vllm@0.28.0");
  assert.equal(first.body.job.meta.image, image);

  const second = await pullRequest(world.app, "vllm@0.28.0");
  assert.equal(second.statusCode, 202);
  assert.equal(second.body.existing, true);
  assert.equal(second.body.job.existing, true);
  assert.equal(second.body.job.id, first.body.job.id);

  await settle();
  assert.equal(world.pending.length, 1, "one docker pull for two requests");
  const { options, resolve } = world.pending[0];
  assert.equal(options.platform, "linux/amd64");
  options.onProgress({ percent: 25, layersTotal: 4, layersDone: 1, status: "" });
  options.onProgress({ percent: 25, layersTotal: 4, layersDone: 1, status: "" });
  options.onProgress({ percent: 60, layersTotal: 4, layersDone: 2, status: "" });
  const job = world.jobs.jobs.get(first.body.job.id);
  assert.equal(job.progress.percent, 60);
  assert.equal(job.progress.stageKey, "pull");
  assert.equal(job.progress.phase, "pull");
  assert.deepEqual(job.progress.stageText, { zh: `正在拉取镜像 ${image}：60%`, en: `Pulling image ${image}: 60%` });

  resolve({ ok: true, image, digest: `sha256:${"b".repeat(64)}` });
  await settle();
  await settle();
  assert.equal(job.status, "success");
  assert.equal(job.progress.percent, 100);
  assert.equal(job.lifecycle.phase, "pull");
  assert.equal(job.lifecycle.phaseHistory.length, 1);
  assert.ok(job.logs.some((line) => line.includes(`sha256:${"b".repeat(64)}`)));
  assert.equal(world.presenceCleared(), 1);

  const jobEvents = world.sent.filter((item) => item.event === "jobs").map((item) => item.data);
  assert.ok(jobEvents.every((data) => data.managerId === "vllm" && data.full === false && data.jobs[0].id === job.id));
  const percents = jobEvents.map((data) => data.jobs[0].progress.percent);
  assert.deepEqual(percents.slice(0, 3), [0, 25, 60], "unchanged progress is not re-sent");
  assert.equal(jobEvents.at(-1).jobs[0].status, "success");

  // Only docker pull: no container, image-ensure, admission or lease call.
  assert.deepEqual(world.calls.map(([name]) => name), ["pull"]);
  assert.deepEqual(world.admissionCalls, []);

  // The image is free again: a new request starts a new pull.
  const third = await pullRequest(world.app, "vllm@0.28.0");
  assert.equal(third.body.existing, false);
  assert.notEqual(third.body.job.id, first.body.job.id);
});

test("a failed pull keeps the error string and gains the job error object", async (t) => {
  const world = setup(t);
  const started = await pullRequest(world.app, "sglang@0.5.17");
  assert.equal(started.statusCode, 202);
  await settle();
  const error = Object.assign(new Error("manifest unknown"), { code: "image_pull_failed", stderr: "Error response from daemon: manifest unknown" });
  world.pending[0].reject(error);
  await settle();
  await settle();
  const job = world.jobs.jobs.get(started.body.job.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /manifest unknown/);
  assert.equal(job.failure.code, "image_pull_failed");
  assert.equal(job.failure.phase, "pull");
  assert.equal(job.failure.signatureId, null);
  assert.match(job.failure.logExcerpt, /manifest unknown/);
  assert.equal(world.sent.filter((item) => item.event === "jobs").at(-1).data.jobs[0].status, "failed");
  assert.deepEqual(world.calls.map(([name]) => name), ["pull"]);
});

test("llama-manager serves the same route for its own runtimes", async (t) => {
  const world = setup(t, { managerId: "llama" });
  const res = await pullRequest(world.app, "llamacpp@b10630");
  assert.equal(res.statusCode, 202);
  assert.match(res.body.job.id, PULL_JOB_ID_PATTERN);
  assert.equal((await pullRequest(world.app, "vllm@0.28.0")).statusCode, 404);
});

test("the route answers 503 when the manager wired no pull job", async (t) => {
  const app = recordingApp();
  core.engines.registerEngineRoutes(app, {
    registry: core.engines.createEngineRegistry({ overrideDir: emptyOverrideDir(t), env: {} }),
    managerId: "vllm",
    isLocalRequest: () => true,
  });
  const res = await pullRequest(app, "vllm@0.28.0");
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "pull_unavailable");
});
