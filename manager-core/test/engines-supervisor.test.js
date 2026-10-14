"use strict";

// runtime-supervisor (docs/overhaul/01-engines.md §14, ENG-10). The host, the
// GPU admission, the jobs store and the event hub are fakes that record every
// call; no docker process, port or GPU is touched. The real runtime-wait runs
// where its polling needs no clock (ready at once, container exited).

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("..");
const jobUtils = require("../job-utils");
const {
  createRuntimeSupervisor,
  assessRuntimeGate,
  labelsFromArgs,
  publishedPortOf,
  tailExcerpt,
  LIFECYCLE_PHASES,
} = require("../engines/runtime-supervisor");

const FAKE_KEY = "fixture-runtime-key-0123456789";
const FAKE_SK = "sk-fixturefixturefixture0000";
const LAUNCH_ID = "lch_TESTTESTTESTTESTTEST";
const IMAGE = "ghcr.io/fixture/runtime@sha256:" + "a".repeat(64);

function fakeHost(options = {}) {
  const calls = [];
  const state = { existing: options.existing || null, present: options.present !== false, created: new Set() };
  const host = {
    kind: "docker",
    config: { runtimeName: "Docker Desktop" },
    async ready({ autoStart } = {}) {
      calls.push(["ready", Boolean(autoStart)]);
      return { ok: true, version: "27.0.0-fixture", detail: "", started: false };
    },
    async list() {
      calls.push(["list"]);
      return options.managed || [];
    },
    async inspect(name, inspectOptions = {}) {
      calls.push(["inspect", name, inspectOptions.fresh]);
      if (state.created.has(name)) return { exists: true, running: true, status: "running", labels: {} };
      return state.existing ? { exists: true, running: true, ...state.existing } : { exists: false, running: false, labels: {} };
    },
    async ensureImage(image, ensureOptions = {}) {
      calls.push(["ensureImage", image, ensureOptions.policy]);
      if (options.onEnsureImage) await options.onEnsureImage();
      if (state.present) return { ok: true, pulled: false, image };
      if (ensureOptions.policy === "explicit") {
        throw Object.assign(new Error(`Image ${image} is not present; pull it explicitly before launching.`), { code: "image_pull_required", status: 409 });
      }
      await ensureOptions.onMissing?.({ image, status: { text: "missing" } });
      ensureOptions.onAttempt?.({ attempt: 1, attempts: 3, image });
      calls.push(["pull", image]);
      state.present = true;
      return { ok: true, pulled: true, image, result: { stdout: "pulled" } };
    },
    async checkpoint(name) {
      calls.push(["checkpoint", name]);
      const hadPrevious = Boolean(state.existing);
      return {
        hadPrevious,
        async commit() {
          calls.push(["checkpoint.commit", name]);
          return { committed: true, removedBackup: hadPrevious };
        },
        async rollback() {
          calls.push(["checkpoint.rollback", name]);
          return { rolledBack: true, restoredPrevious: hadPrevious };
        },
      };
    },
    async create(cmd, createOptions = {}) {
      calls.push(["create", cmd.name, Object.keys(createOptions.secretEnv || {})]);
      if (options.createError) throw new Error(options.createError);
      state.created.add(cmd.name);
      return { name: cmd.name, id: "cid", stdout: "cid\n", stderr: "" };
    },
    async logs(name, logOptions = {}) {
      calls.push(["logs", name, logOptions.tail]);
      return options.logs || "";
    },
    async stop(name) {
      calls.push(["stop", name]);
      return { removed: true };
    },
  };
  return { host, calls, state };
}

function fakeJobs() {
  const finished = [];
  const failed = [];
  return {
    finished,
    failed,
    create(meta = {}) {
      return jobUtils.createJobRecord("serve", "Start fixture", { ...meta });
    },
    api: {
      appendLog(job, text) {
        for (const line of String(text || "").split("\n")) if (line) job.logs.push(line);
      },
      setJobProgress(job, progress) {
        jobUtils.applyJobProgress(job, progress);
      },
      scheduleJobsSave() {},
      finishJob(job, meta) {
        if (jobUtils.markJobSuccess(job, { meta })) finished.push(job.id);
      },
      failJob(job, error) {
        if (jobUtils.markJobFailed(job, error?.message || String(error))) failed.push(job.id);
      },
    },
  };
}

function fakeEvents() {
  const sent = [];
  return { sent, broadcast: (event, data) => sent.push({ event, data: JSON.parse(JSON.stringify(data)) }) };
}

function fakeLease(calls, id = "lease-new") {
  return {
    summary: { id },
    async commit(meta) { calls.push(["lease.commit", meta.containerName]); },
    async release(reason) { calls.push(["lease.release", reason]); },
  };
}

function fakeAdmission(calls) {
  return {
    async acquireAfterPrepare(request, prepare) {
      calls.push(["admission.acquireAfterPrepare"]);
      const context = await prepare(request);
      calls.push(["admission.acquired"]);
      return { lease: fakeLease(calls), context };
    },
  };
}

function fakeSecrets(calls) {
  return { async remove(ref) { calls.push(["secrets.remove", ref]); } };
}

function fakeLaunchStore(calls) {
  return {
    beginLaunch(job) {
      calls.push(["launch.begin"]);
      job.meta.launchId = LAUNCH_ID;
      return LAUNCH_ID;
    },
    recordCommand(launchId, argv, { redact }) {
      calls.push(["launch.command", launchId, redact(argv).join(" ")]);
    },
    markStatus(launchId, status) {
      calls.push(["launch.status", launchId, status]);
    },
  };
}

function runContext(overrides = {}) {
  return {
    options: { instanceMode: "replace", containerName: "llama-local", port: 18080 },
    engineId: "llamacpp",
    engineName: "llama.cpp",
    containerName: "llama-local",
    instanceId: "primary",
    port: 18080,
    gpuIds: ["0"],
    apiKeyRef: "rk-new",
    admissionRequest: { gpus: [{ gpuIndex: 0, requestMb: 1000 }] },
    buildCommand: () => ({
      runArgs: [
        "run", "-d", "--name", "llama-local",
        "--label", "ai.manager=llama", "--label", "ai.manager.runtime-id=llamacpp@fixture",
        "-e", "LLAMA_API_KEY", IMAGE, "--api-key", FAKE_KEY,
      ],
      publish: ["-p", "127.0.0.1:18080:8080"],
      image: IMAGE,
      secretEnv: { LLAMA_API_KEY: FAKE_KEY },
    }),
    wait: {
      apiKey: FAKE_KEY,
      serviceUrl: "http://127.0.0.1:18080/v1",
      probe: async () => ({ ok: true, detail: "fixture output" }),
    },
    ...overrides,
  };
}

// Container up and serving at once: the real runtime-wait finishes on its first poll.
const READY_GETTERS = Object.freeze({
  containerStatus: async () => ({ exists: true, running: true, status: "Up" }),
  servedModels: async () => [{ id: "fixture-model" }],
});

function supervisorFor({ host, jobs, calls, events, ...rest }) {
  return createRuntimeSupervisor({
    managerId: "llama",
    host,
    jobs: jobs.api,
    events: events || fakeEvents(),
    launchStore: fakeLaunchStore(calls),
    secrets: fakeSecrets(calls),
    admission: fakeAdmission(calls),
    getters: READY_GETTERS,
    delay: async () => {},
    ...rest,
  });
}

function indexOfCall(calls, name) {
  return calls.findIndex((call) => call[0] === name);
}

function callNames(calls) {
  return calls.map((call) => call[0]);
}

test("replace: preflight, image before the checkpoint, admission around the checkpoint, create, wait, commit", async () => {
  const { host, calls } = fakeHost({ existing: { labels: { "ai.manager.api-key-ref": "rk-old", "ai.manager.gpu-admission-lease": "lease-old" } } });
  const jobs = fakeJobs();
  const supervisor = supervisorFor({ host, jobs, calls });
  const job = jobs.create();
  const run = runContext();
  await supervisor.start({ job, run });

  assert.equal(job.status, "success");
  const names = callNames(calls);
  assert.ok(indexOfCall(calls, "ready") < indexOfCall(calls, "ensureImage"));
  assert.ok(indexOfCall(calls, "ensureImage") < indexOfCall(calls, "admission.acquireAfterPrepare"), "image before admission");
  assert.ok(indexOfCall(calls, "admission.acquireAfterPrepare") < indexOfCall(calls, "checkpoint"), "replace acquires after prepare");
  assert.ok(indexOfCall(calls, "checkpoint") < indexOfCall(calls, "admission.acquired"));
  assert.ok(indexOfCall(calls, "admission.acquired") < indexOfCall(calls, "create"));
  assert.ok(indexOfCall(calls, "create") < indexOfCall(calls, "checkpoint.commit"));
  assert.ok(indexOfCall(calls, "checkpoint.commit") < indexOfCall(calls, "lease.commit"));
  assert.deepEqual(run.admissionRequest.retireLeaseIds, ["lease-old"], "the old container's lease is retired");
  assert.deepEqual(calls.find((call) => call[0] === "secrets.remove"), ["secrets.remove", "rk-old"], "the previous key ref goes after commit");
  assert.equal(names.includes("stop"), false);
  assert.equal(names.includes("lease.release"), false);
  assert.deepEqual(calls.find((call) => call[0] === "launch.status"), ["launch.status", LAUNCH_ID, "running"]);
  // The secret env reaches create by name only; the recorded argv is redacted.
  assert.deepEqual(calls.find((call) => call[0] === "create")[2], ["LLAMA_API_KEY"]);
  assert.equal(calls.find((call) => call[0] === "launch.command")[2].includes(FAKE_KEY), false);
  assert.equal(job.meta.launchCommand.includes(FAKE_KEY), false);
  assert.match(job.meta.launchCommand, /<redacted>/);
  assert.equal(job.meta.runtimeContainerCreated, true);

  // Lifecycle phases in pipeline order, every one closed with a duration.
  const phases = job.lifecycle.phaseHistory.map((entry) => entry.phase);
  assert.deepEqual(phases, ["pull", "admission", "container", "weights", "probe", "ready"]);
  for (const entry of job.lifecycle.phaseHistory) {
    assert.ok(LIFECYCLE_PHASES.includes(entry.phase));
    assert.equal(typeof entry.durationMs, "number");
    assert.ok(Number.isFinite(Date.parse(entry.at)));
  }
  assert.equal(job.lifecycle.phase, "ready");
  assert.equal(job.progress.phase, "ready");
  assert.equal(job.progress.stageKey, "commit");
  assert.deepEqual(job.progress.stageText, { zh: "服务已就绪", en: "Ready" });
  assert.equal(job.progress.stage, "服务已就绪", "the legacy zh stage string is kept");
  assert.equal(job.failure, undefined);
});

test("parallel: a lease handed in is committed and no replace admission runs", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const supervisor = supervisorFor({ host, jobs, calls });
  const job = jobs.create();
  await supervisor.start({
    job,
    run: runContext({ mode: "parallel", containerName: "llama-local-b", instanceId: "b", lease: fakeLease(calls, "lease-parallel"), admissionRequest: null }),
  });
  assert.equal(job.status, "success");
  assert.equal(indexOfCall(calls, "admission.acquireAfterPrepare"), -1);
  assert.deepEqual(calls.find((call) => call[0] === "lease.commit"), ["lease.commit", "llama-local-b"]);
});

test("a caller-owned admission (prepareAdmission) wraps the checkpoint and rebuilds the command", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const supervisor = supervisorFor({ host, jobs, calls });
  const job = jobs.create();
  let builds = 0;
  const base = runContext();
  await supervisor.start({
    job,
    run: runContext({
      cleanup: "caller",
      buildCommand: (...args) => { builds += 1; return base.buildCommand(...args); },
      prepareAdmission: async (prepare) => {
        calls.push(["caller.prepare"]);
        return prepare();
      },
    }),
  });
  assert.equal(job.status, "success");
  assert.equal(builds, 2, "re-plan after admission");
  assert.ok(indexOfCall(calls, "caller.prepare") < indexOfCall(calls, "checkpoint"));
  assert.equal(indexOfCall(calls, "admission.acquireAfterPrepare"), -1);
  assert.equal(indexOfCall(calls, "lease.commit"), -1, "the caller commits its own lease");
});

test("image policy: auto pulls a missing image before the checkpoint; explicit fails and never pulls", async () => {
  {
    const { host, calls } = fakeHost({ present: false });
    const jobs = fakeJobs();
    const job = jobs.create();
    await supervisorFor({ host, jobs, calls }).start({ job, run: runContext() });
    assert.equal(job.status, "success");
    assert.ok(indexOfCall(calls, "pull") >= 0 && indexOfCall(calls, "pull") < indexOfCall(calls, "checkpoint"));
    assert.ok(job.logs.some((line) => line.includes("Pulling before current model is stopped.")));
  }
  {
    const { host, calls } = fakeHost({ present: false });
    const jobs = fakeJobs();
    const job = jobs.create();
    await assert.rejects(
      supervisorFor({ host, jobs, calls }).start({ job, run: runContext({ imagePolicy: "explicit" }) }),
      { code: "image_pull_required" },
    );
    assert.equal(indexOfCall(calls, "pull"), -1);
    assert.equal(indexOfCall(calls, "checkpoint"), -1);
    assert.equal(indexOfCall(calls, "create"), -1);
    assert.equal(job.status, "failed");
    assert.equal(job.failure.code, "image_pull_required");
    assert.equal(job.failure.phase, "pull");
  }
});

test("add never stops: an occupied slot fails or skips without a checkpoint, stop or create", async () => {
  for (const onConflict of ["fail", "skip"]) {
    const { host, calls } = fakeHost({ existing: { labels: {} } });
    const jobs = fakeJobs();
    const job = jobs.create();
    const started = supervisorFor({ host, jobs, calls }).start({ job, run: runContext({ mode: "add", onConflict }) });
    if (onConflict === "fail") {
      await assert.rejects(started, { code: "instance_conflict" });
      assert.equal(job.status, "failed");
      assert.equal(job.failure.code, "instance_conflict");
    } else {
      assert.deepEqual(await started, { skipped: true });
      assert.equal(job.status, "success");
      assert.equal(job.meta.skipped, true);
    }
    for (const forbidden of ["stop", "checkpoint", "create", "ensureImage", "admission.acquireAfterPrepare"]) {
      assert.equal(indexOfCall(calls, forbidden), -1, `${onConflict}: ${forbidden}`);
    }
  }
  // A free slot starts without any checkpoint or stop.
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const job = jobs.create();
  await supervisorFor({ host, jobs, calls }).start({ job, run: runContext({ mode: "add", containerName: "llama-local-c", lease: fakeLease(calls) }) });
  assert.equal(job.status, "success");
  assert.equal(indexOfCall(calls, "checkpoint"), -1);
  assert.equal(indexOfCall(calls, "stop"), -1);
  assert.equal(indexOfCall(calls, "admission.acquireAfterPrepare"), -1);
});

test("rollback on a create failure releases the lease, deletes the key ref and restores the checkpoint", async () => {
  const { host, calls } = fakeHost({ existing: { labels: {} }, createError: "docker: Error response from daemon: fixture failure" });
  const jobs = fakeJobs();
  const job = jobs.create();
  await assert.rejects(supervisorFor({ host, jobs, calls }).start({ job, run: runContext() }), /fixture failure/);
  const names = callNames(calls);
  assert.ok(names.includes("checkpoint.rollback"));
  assert.deepEqual(calls.find((call) => call[0] === "lease.release"), ["lease.release", "start-failed"]);
  assert.deepEqual(calls.find((call) => call[0] === "secrets.remove"), ["secrets.remove", "rk-new"]);
  assert.equal(names.includes("checkpoint.commit"), false);
  assert.equal(names.includes("lease.commit"), false);
  assert.equal(job.status, "failed");
  assert.match(job.error, /fixture failure/, "the legacy error string is kept");
  assert.equal(job.failure.code, "container_create_failed");
  assert.equal(job.failure.phase, "container");
  assert.ok(job.logs.includes("新模型启动失败，已恢复原容器 llama-local。"));
});

test("rollback on a wait failure: the container exited, the excerpt is the redacted log tail", async () => {
  const logLines = Array.from({ length: 60 }, (_, index) => `load line ${index}`);
  logLines.push(`server_args=ServerArgs(api_key='${FAKE_SK}') --api-key ${FAKE_KEY}`, "fatal: model failed to load");
  const { host, calls } = fakeHost({ logs: logLines.join("\n") });
  const jobs = fakeJobs();
  const job = jobs.create();
  const supervisor = supervisorFor({
    host,
    jobs,
    calls,
    getters: {
      containerStatus: async () => ({ exists: true, running: false, status: "Exited (1)" }),
      servedModels: async () => [],
    },
  });
  await assert.rejects(supervisor.start({ job, run: runContext({ wait: { ...runContext().wait, extractLogIssues: (text) => (/fatal: .*/.exec(text) || []).slice(0, 1) } }) }), /exited before becoming ready/);
  assert.ok(callNames(calls).includes("checkpoint.rollback"));
  assert.ok(callNames(calls).includes("lease.release"));
  assert.ok(callNames(calls).includes("secrets.remove"));
  const failure = job.failure;
  assert.deepEqual(Object.keys(failure).sort(), ["code", "hint", "logExcerpt", "phase", "signatureId"]);
  assert.equal(failure.code, "container_exited");
  assert.equal(failure.phase, "weights");
  assert.equal(failure.signatureId, null);
  assert.equal(failure.hint, null);
  assert.ok(failure.logExcerpt.split("\n").length <= 40);
  assert.ok(Buffer.byteLength(failure.logExcerpt, "utf8") <= 4096);
  assert.match(failure.logExcerpt, /fatal: model failed to load/);
  assert.match(failure.logExcerpt, /<redacted>/);
  assert.equal(failure.logExcerpt.includes(FAKE_KEY), false);
  assert.equal(failure.logExcerpt.includes(FAKE_SK), false);
});

test("wait failure codes: probe_failed, stalled, ready_timeout; classifyFailure supplies signature and hint", async () => {
  const cases = [
    { message: "llama.cpp API became reachable but generation probe failed: empty output", stage: "生成自检失败", code: "probe_failed", phase: "probe" },
    { message: "llama.cpp start stalled: no log output for 10 minutes", stage: "启动停滞", code: "stalled", phase: "weights" },
    { message: "llama.cpp did not become ready within 20 minutes", stage: "启动超时，日志有错误", code: "ready_timeout", phase: "weights" },
  ];
  for (const item of cases) {
    const { host, calls } = fakeHost();
    const jobs = fakeJobs();
    const job = jobs.create();
    const classified = [];
    const supervisor = supervisorFor({
      host,
      jobs,
      calls,
      waitForRuntimeReady: async (waitOptions) => {
        waitOptions.setJobProgress(waitOptions.job, { percent: 60, stage: "等待模型加载" });
        if (item.phase === "probe") waitOptions.setJobProgress(waitOptions.job, { percent: 96, stage: "生成自检" });
        waitOptions.setJobProgress(waitOptions.job, { stage: item.stage, state: "fail" });
        throw new Error(item.message);
      },
      hooks: {
        classifyFailure: (logText, context) => {
          classified.push(context);
          return { signatureId: "fixture-signature", hint: { zh: "提示", en: "Hint" } };
        },
      },
    });
    await assert.rejects(supervisor.start({ job, run: runContext() }));
    assert.equal(job.failure.code, item.code, item.code);
    assert.equal(job.failure.phase, item.phase, item.code);
    assert.equal(job.failure.signatureId, "fixture-signature");
    assert.deepEqual(job.failure.hint, { zh: "提示", en: "Hint" });
    assert.equal(classified.length, 1);
    assert.equal(classified[0].engineId, "llamacpp");
    assert.equal(classified[0].phase, item.phase);
    assert.ok(callNames(calls).includes("checkpoint.rollback"), `${item.code}: rollback`);
    assert.ok(callNames(calls).includes("lease.release"), `${item.code}: lease released`);
  }
});

test("cancellation between stages stops before any container is created", async () => {
  const { host, calls } = fakeHost({ existing: { labels: {} } });
  const jobs = fakeJobs();
  const job = jobs.create();
  host.ensureImage = async (image) => {
    calls.push(["ensureImage", image]);
    jobUtils.markJobCancelRequested(job, "cancel");
    return { ok: true, pulled: false };
  };
  await assert.rejects(supervisorFor({ host, jobs, calls }).start({ job, run: runContext() }), { code: "START_CANCELLED" });
  assert.equal(indexOfCall(calls, "checkpoint"), -1);
  assert.equal(indexOfCall(calls, "create"), -1);
  assert.equal(job.failure.code, "start_cancelled");
  assert.equal(job.status, "failed");

  // A job cancelled while it waited in the queue is skipped without any host call.
  const queued = jobs.create();
  queued.status = "failed";
  const second = fakeHost();
  await supervisorFor({ host: second.host, jobs, calls: second.calls }).start({ job: queued, run: runContext() });
  assert.deepEqual(second.calls, []);
  assert.ok(queued.logs.some((line) => line.includes("跳过启动")));
});

test("cancellation during the wait rolls the checkpoint back", async () => {
  const { host, calls } = fakeHost({ existing: { labels: {} } });
  const jobs = fakeJobs();
  const job = jobs.create();
  const supervisor = supervisorFor({
    host,
    jobs,
    calls,
    getters: {
      containerStatus: async () => {
        jobUtils.markJobCancelRequested(job, "cancel");
        return { exists: true, running: true, status: "Up" };
      },
      servedModels: async () => [],
    },
  });
  await assert.rejects(supervisor.start({ job, run: runContext() }), { code: "START_CANCELLED" });
  assert.ok(callNames(calls).includes("checkpoint.rollback"));
  assert.equal(job.failure.code, "start_cancelled");
});

test("fresh getters: the configured getters drive the wait; without them the host is inspected fresh", async () => {
  {
    const { host, calls } = fakeHost();
    const jobs = fakeJobs();
    const used = [];
    const supervisor = supervisorFor({
      host,
      jobs,
      calls,
      getters: {
        containerStatus: async (name) => { used.push(["containerStatus", name]); return { exists: true, running: true }; },
        servedModels: async (port, apiKey) => { used.push(["servedModels", port, apiKey === FAKE_KEY]); return used.length > 2 ? [{ id: "m" }] : []; },
      },
    });
    assert.equal(supervisor.config.getters.containerStatus.length, 1);
    const job = jobs.create();
    await supervisor.start({ job, run: runContext() });
    assert.deepEqual(used.slice(0, 2), [["servedModels", 18080, true], ["containerStatus", "llama-local"]]);
  }
  {
    const { host, calls } = fakeHost();
    const jobs = fakeJobs();
    let served = 0;
    const supervisor = supervisorFor({ host, jobs, calls, getters: { servedModels: async () => (served++ ? [{ id: "m" }] : []) } });
    const job = jobs.create();
    await supervisor.start({ job, run: runContext() });
    assert.ok(calls.some((call) => call[0] === "inspect" && call[1] === "llama-local" && call[2] === true));
  }
});

test("afterReady is called once after commit with the launch context; its error is logged and ignored", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const contexts = [];
  const supervisor = supervisorFor({
    host,
    jobs,
    calls,
    probes: { gpuStatus: async () => ({ ok: true, gpus: [{ id: "0", index: 0, usedMb: 1234 }, { id: "1", index: 1, usedMb: 99 }] }) },
    hooks: {
      afterReady: async (context) => {
        contexts.push({ ...context, finishedBefore: calls.some((call) => call[0] === "checkpoint.commit") });
        throw new Error("fixture observer down");
      },
    },
  });
  const job = jobs.create();
  await supervisor.start({ job, run: runContext({ paramsKey: "8192|1|auto|-" }) });
  assert.equal(job.status, "success");
  assert.equal(contexts.length, 1);
  const [context] = contexts;
  assert.equal(context.finishedBefore, true);
  assert.equal(context.launchId, LAUNCH_ID);
  assert.equal(context.managerId, "llama");
  assert.equal(context.runtimeId, "llamacpp@fixture", "from the ai.manager.runtime-id label");
  assert.equal(context.paramsKey, "8192|1|auto|-");
  assert.equal(context.gpuUsedBeforeMb, 1234);
  assert.deepEqual(context.logFacts, {});
  assert.ok(job.logs.some((line) => line.includes("afterReady hook failed (ignored): fixture observer down")));
});

test("jobs and instances events carry the managerId", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  const events = fakeEvents();
  const job = jobs.create();
  await supervisorFor({ host, jobs, calls, events }).start({ job, run: runContext() });
  const jobEvents = events.sent.filter((item) => item.event === "jobs");
  assert.ok(jobEvents.length >= 3);
  for (const item of jobEvents) {
    assert.equal(item.data.managerId, "llama");
    assert.equal(item.data.full, false);
    assert.equal(item.data.jobs.length, 1);
    assert.equal(item.data.jobs[0].id, job.id);
  }
  assert.equal(jobEvents.at(-1).data.jobs[0].status, "success");
  assert.equal(jobEvents.at(-1).data.jobs[0].lifecycle.phase, "ready");
  const instanceEvents = events.sent.filter((item) => item.event === "instances");
  assert.deepEqual(instanceEvents.map((item) => item.data), [{ managerId: "llama", changed: ["primary"], removed: [] }]);

  // A failure emits the failed job with its failure object, and the instance change.
  const failing = fakeHost({ createError: "fixture create failure" });
  const failedEvents = fakeEvents();
  const failedJob = jobs.create();
  await assert.rejects(supervisorFor({ host: failing.host, jobs, calls: failing.calls, events: failedEvents }).start({ job: failedJob, run: runContext() }));
  const last = failedEvents.sent.filter((item) => item.event === "jobs").at(-1).data;
  assert.equal(last.managerId, "llama");
  assert.equal(last.jobs[0].status, "failed");
  assert.equal(last.jobs[0].failure.code, "container_create_failed");
  assert.ok(failedEvents.sent.some((item) => item.event === "instances" && item.data.managerId === "llama"));
});

test("runtime gate: warn logs failing findings and continues; enforce fails before the image stage", async () => {
  const probe = async () => ({ ok: true, gpus: [{ index: 0, id: "0", name: "Fixture GPU", computeCapability: "5.0", driverVersion: "500.00" }] });
  const release = { version: "fixture", platform: "linux/amd64", minimumComputeCapability: "6.1", minimumDriverVersions: { win32: "580.88", linux: "580.65.06" } };
  {
    const { host, calls } = fakeHost();
    const jobs = fakeJobs();
    const supervisor = supervisorFor({ host, jobs, calls, runtimeGatePolicy: "warn", probes: { nvidiaCompatibility: probe } });
    assert.equal(supervisor.config.runtimeGatePolicy, "warn");
    const job = jobs.create();
    await supervisor.start({ job, run: runContext({ runtimeRelease: release }) });
    assert.equal(job.status, "success");
    assert.ok(job.logs.some((line) => line.startsWith("Runtime compatibility [fail]: GPU 0 compute capability")));
    assert.ok(job.logs.some((line) => line.startsWith("Runtime gate (warn mode):")));
  }
  {
    const { host, calls } = fakeHost();
    const jobs = fakeJobs();
    const supervisor = supervisorFor({ host, jobs, calls, probes: { nvidiaCompatibility: probe } });
    assert.equal(supervisor.config.runtimeGatePolicy, "enforce");
    const job = jobs.create();
    await assert.rejects(supervisor.start({ job, run: runContext({ runtimeRelease: release }) }), { code: "runtime_incompatible" });
    assert.equal(indexOfCall(calls, "ensureImage"), -1);
    assert.equal(job.failure.code, "runtime_incompatible");
    assert.equal(job.failure.phase, "pull");
  }
  assert.throws(() => createRuntimeSupervisor({ managerId: "x", host: fakeHost().host, jobs: fakeJobs().api, runtimeGatePolicy: "off" }), /gate policy/);
});

test("assessRuntimeGate checks compute capability, driver and platform from the manifest release", () => {
  const llama = core.engines.listRuntimes().find((ref) => ref.runtimeId.startsWith("llamacpp@") && ref.release?.minimumComputeCapability);
  assert.ok(llama, "the manifest has a llama.cpp release with requirements");
  const gpus = [{ index: 0, id: "0", name: "Fixture GPU", computeCapability: "12.0", driverVersion: "590.00" }];
  const ok = assessRuntimeGate({ probe: { ok: true, gpus }, release: llama.release, hostPlatform: "win32", hostArch: "x64", selectedGpuIds: ["0"] });
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  const oldDriver = assessRuntimeGate({ probe: { ok: true, gpus: [{ ...gpus[0], driverVersion: "500.00" }] }, release: llama.release, hostPlatform: "win32", hostArch: "x64" });
  assert.equal(oldDriver.ok, false);
  assert.ok(oldDriver.findings.some((item) => item.severity === "fail" && item.title === "NVIDIA driver"));
  const missingGpu = assessRuntimeGate({ probe: { ok: true, gpus }, release: llama.release, selectedGpuIds: ["3"], hostArch: "x64" });
  assert.equal(missingGpu.ok, false);
  const noProbe = assessRuntimeGate({ probe: { ok: false, gpus: [], error: "nvidia-smi missing" }, release: llama.release });
  assert.equal(noProbe.status, "fail");
  const unknown = assessRuntimeGate({ probe: { ok: true, gpus }, release: null, imageReference: "custom/image:tag" });
  assert.equal(unknown.status, "warn");
});

test("replace starts run serially and the queued job says so", async () => {
  const { host, calls } = fakeHost();
  const jobs = fakeJobs();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstWaiting = true;
  const supervisor = supervisorFor({
    host,
    jobs,
    calls,
    waitForRuntimeReady: async (waitOptions) => {
      if (firstWaiting) {
        firstWaiting = false;
        await gate;
      }
      waitOptions.finishJob(waitOptions.job, {});
    },
  });
  const first = jobs.create();
  const second = jobs.create();
  const one = supervisor.start({ job: first, run: runContext() });
  const two = supervisor.start({ job: second, run: runContext() });
  assert.equal(second.progress.stageKey, "queued");
  assert.equal(second.progress.stage, "等待前一个启动任务");
  assert.ok(second.logs.includes("已有启动任务进行中，排队等待其完成后再启动，避免容器名冲突。"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call[0] === "create").length, 1, "the second start waits for the first");
  release();
  await Promise.all([one, two]);
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(calls.filter((call) => call[0] === "create").length, 2);
});

test("helpers: excerpt bounds, label and port parsing, persisted lifecycle and failure", () => {
  const long = Array.from({ length: 100 }, (_, index) => `${index} ${"x".repeat(200)}`).join("\n");
  const excerpt = tailExcerpt(long);
  assert.ok(excerpt.split("\n").length <= 40);
  assert.ok(Buffer.byteLength(excerpt) <= 4096);
  assert.match(excerpt, /^\d+ x/);
  assert.ok(excerpt.endsWith("x"));
  assert.ok(Buffer.byteLength(tailExcerpt("y".repeat(10000))) <= 4096);
  assert.deepEqual(labelsFromArgs(["--label", "a=b", "--label=c=d=e", "-l", "f="]), { a: "b", c: "d=e", f: "" });
  assert.equal(publishedPortOf("127.0.0.1:18080->8080/tcp"), 18080);
  assert.equal(publishedPortOf("0.0.0.0:8001->8000/tcp, [::]:8001->8000/tcp"), 8001);
  assert.equal(publishedPortOf(""), null);

  const job = jobUtils.createJobRecord("serve", "x");
  job.lifecycle = { phase: "weights", phaseHistory: [{ phase: "weights", at: new Date(0).toISOString(), durationMs: 5 }] };
  job.failure = { code: "ready_timeout", signatureId: null, phase: "weights", hint: null, logExcerpt: "" };
  const persisted = jobUtils.normalizePersistedJob(job);
  assert.deepEqual(persisted.lifecycle, job.lifecycle);
  assert.deepEqual(persisted.failure, job.failure);
  const plain = jobUtils.normalizePersistedJob(jobUtils.createJobRecord("download", "y"));
  assert.equal("lifecycle" in plain, false);
  assert.equal("failure" in plain, false);
  // The additive progress fields are carried forward by updates that omit them.
  jobUtils.applyJobProgress(job, { percent: 50, stage: "加载权重", phase: "weights", stageKey: "waitReady", stageText: { zh: "a", en: "b" } });
  jobUtils.markJobFailed(job, "boom");
  assert.equal(job.progress.phase, "weights");
  assert.equal(job.progress.stageKey, "waitReady");
  const legacy = jobUtils.createJobRecord("serve", "z");
  jobUtils.applyJobProgress(legacy, { percent: 1, stage: "s" });
  assert.equal("phase" in legacy.progress, false);
});

test("core.engines exposes the supervisor namespace", () => {
  assert.equal(core.engines.createRuntimeSupervisor, createRuntimeSupervisor);
  assert.equal(typeof core.engines.runtimeSupervisor.probeNvidiaCompatibility, "function");
});
