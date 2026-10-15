"use strict";

// The hub's persistent global download queue (docs/overhaul/03-hub.md §8,
// HUB-7): order, concurrency, the idle-only gate, per-volume disk waits,
// persistence, restart resume (interrupted, paused, retry timers,
// waiting/auth), the orphan check, dedupe, retries, cancel-and-delete, the
// `downloads` events and the storage busy-path probe. The transfer engine,
// verifier, busy signal and disk are fakes; nothing is spawned or fetched.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createModelStorage, createModelMigration, createStorageBusyPathProbe } = require("..");
const { createDownloadQueue, JOB_ID_RE } = require("../model-hub/queue");
const { createHubStore } = require("../model-hub/store");
const { createCliTransferEngine } = require("../model-hub/transfer");
const { createModelHub } = require("../model-hub");
const { computeFilesetHash, identityKeyFor } = require("../model-hub/library");
const { reserveBytes, availableBytes, createDiskGuard } = require("../model-hub/disk");
const { HubError } = require("../model-hub/errors");

const SHA = "a".repeat(40);
const FAKE_TOKEN = "hf_fakeQueueTokenForTestsOnly000000";

function tempDir(t, prefix = "hub-queue-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLogger() {
  return { warn() {}, info() {}, log() {}, error() {} };
}

async function until(predicate, { timeoutMs = 3000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A transfer engine that never spawns: every start is recorded, a test ends
// an attempt with exit(code), and stop() exits with the stop reason.
function fakeEngine() {
  const started = [];
  const engine = {
    id: "cli",
    started,
    orphanCalls: [],
    start(job, hooks) {
      const handle = {
        job,
        jobId: job.id,
        pid: 4000 + started.length,
        stopReason: null,
        exited: false,
        exit(code = 0, extra = {}) {
          if (handle.exited) return;
          handle.exited = true;
          hooks.onExit({ code, signal: null, stopReason: handle.stopReason, stderrTail: extra.stderr || [], ...extra });
        },
        stop(reason) {
          handle.stopReason = handle.stopReason || reason;
          setImmediate(() => handle.exit(null));
          return Promise.resolve();
        },
        stderrTail: () => [],
      };
      started.push(handle);
      hooks.onSpawn({ pid: handle.pid, startedAt: new Date().toISOString() });
      hooks.onLine("stdout", `fake download of ${job.artifact.repo}`);
      return handle;
    },
    async findOrphans(jobs, options) {
      engine.orphanCalls.push({ ids: jobs.map((job) => job.id), options });
      return [];
    },
  };
  engine.running = () => started.filter((handle) => !handle.exited);
  engine.handleOf = (jobId) => started.filter((handle) => handle.jobId === jobId).at(-1);
  return engine;
}

function fakeEvents() {
  const published = [];
  return {
    published,
    publish(type, payload) {
      published.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
      return { type };
    },
    of: (type) => published.filter((item) => item.type === type),
  };
}

function fakeTokens(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    released: [],
    async put(token) {
      const ref = `dlt_${"b".repeat(15)}${map.size}`;
      map.set(ref, token);
      return ref;
    },
    resolve: (ref) => map.get(ref) || null,
    async release(ref) {
      this.released.push(ref);
      map.delete(ref);
    },
    values: () => [...map.values()],
  };
}

function baseSettings(overrides = {}) {
  const settings = {
    transfer: { maxConcurrent: 1, xet: "high-performance" },
    retry: { maxAttempts: 3, baseDelaySeconds: 0.01, maxDelaySeconds: 0.05, perClass: { network: true, server: true, watchdog: true, integrity: true, tooling: "once" } },
    queue: { idleOnly: false, idleGraceSeconds: 0, resumeOnStart: true, resumeDelaySeconds: 0 },
    storage: { reserveGb: 0 },
    history: { keepRecords: 200, retentionDays: 365 },
    notifications: { onReady: true, onFailure: true },
  };
  for (const [section, values] of Object.entries(overrides)) settings[section] = { ...settings[section], ...values };
  return settings;
}

function spec(root, name, { size = 1000, volume = "X:", priority, files, repo, credential, source = "huggingface" } = {}) {
  const fileList = files || [{ path: `${name}-Q4_K_M.gguf`, size, sha256: null, role: "weight" }];
  return {
    origin: { kind: "console" },
    priority,
    artifact: {
      provider: "huggingface",
      repo: repo || `org/${name}`,
      revision: "main",
      revisionSha: SHA,
      artifactKey: "gguf:|Q4_K_M",
      kind: "gguf-quant",
      format: "gguf",
      quant: "Q4_K_M",
      companions: [],
      files: fileList,
      totalBytes: fileList.reduce((sum, file) => sum + file.size, 0),
    },
    target: { rootId: "legacy", rootLabel: "Library", outputName: name, localDir: path.join(root, "models", name), volume },
    transfer: {
      options: { source, endpoint: "https://huggingface.co", xet: "default", credentialMode: credential ? "temp-token" : "cached-login", tokenRef: credential || null, remember: false },
    },
  };
}

async function makeQueue(t, options = {}) {
  const root = options.root || tempDir(t);
  const dataDir = path.join(root, "hub");
  const store = options.store || createHubStore({ dataDir });
  await store.init();
  const engine = options.engine || fakeEngine();
  const events = options.events || fakeEvents();
  let settings = options.settings || baseSettings();
  const queue = createDownloadQueue({
    store,
    engine,
    verifier: options.verifier || { verifyArtifact: async () => ({ ok: true, verifiedFiles: [], seconds: 0 }) },
    library: options.library || null,
    settings: () => settings,
    busySignal: options.busySignal || null,
    disk: options.disk || null,
    events,
    tokens: options.tokens || fakeTokens(),
    modelStorage: options.modelStorage || null,
    getBusyPaths: options.getBusyPaths || null,
    logger: quietLogger(),
    pollMs: options.pollMs ?? 10,
    stopWaitMs: 200,
  });
  if (options.load) queue.load(options.load);
  if (options.start !== false) await queue.start();
  t.after(() => queue.stop());
  return { root, dataDir, store, engine, events, queue, setSettings: (next) => { settings = next; } };
}

const stateOf = (queue, id) => queue.get(id)?.state;

// --- order and concurrency ------------------------------------------------------

test("priority, reorder and start-now order the queue; maxConcurrent caps it and force exceeds it by one", async (t) => {
  const { root, engine, queue } = await makeQueue(t);
  const first = await queue.enqueue(spec(root, "first"));
  await until(() => engine.started.length === 1, { what: "first start" });
  assert.match(first.id, JOB_ID_RE);
  assert.equal(stateOf(queue, first.id), "downloading");

  const a = await queue.enqueue(spec(root, "a"));
  const b = await queue.enqueue(spec(root, "b", { priority: "low" }));
  const c = await queue.enqueue(spec(root, "c", { priority: "high" }));
  const d = await queue.enqueue(spec(root, "d"));
  await queue.idle();
  assert.equal(engine.started.length, 1, "one slot");
  assert.deepEqual([queue.get(c.id).state, queue.get(c.id).waitReason], ["waiting", "concurrency"], "the head waits for a slot");
  assert.equal(stateOf(queue, a.id), "queued");

  await queue.reorder([d.id, a.id]);
  await queue.startNow(b.id);
  assert.deepEqual([queue.get(b.id).priority, queue.get(b.id).bypassIdleOnce], ["high", true]);
  assert.deepEqual(queue.list().jobs.filter((job) => job.state !== "downloading").map((job) => job.target.outputName), ["b", "c", "d", "a"]);

  const order = [];
  for (let index = 0; index < 4; index += 1) {
    engine.running()[0].exit(0);
    await until(() => engine.started.length === index + 2, { what: `start ${index + 2}` });
    order.push(engine.started.at(-1).job.target.outputName);
  }
  assert.deepEqual(order, ["b", "c", "d", "a"]);

  // start-now with force runs beside the active job, once.
  const e = await queue.enqueue(spec(root, "e"));
  const f = await queue.enqueue(spec(root, "f"));
  await queue.startNow(f.id, { force: true });
  await until(() => engine.running().length === 2, { what: "forced start" });
  assert.equal(stateOf(queue, f.id), "downloading");
  assert.equal(stateOf(queue, e.id), "waiting");
  assert.equal(queue.aggregate().activeCount, 2);
});

test("the setting maxConcurrent runs that many jobs at once and busy() reports active transfers", async (t) => {
  const { root, engine, queue } = await makeQueue(t, { settings: baseSettings({ transfer: { maxConcurrent: 2 } }) });
  const jobs = [];
  for (const name of ["one", "two", "three"]) jobs.push(await queue.enqueue(spec(root, name)));
  await until(() => engine.started.length === 2, { what: "two starts" });
  await queue.idle();
  assert.equal(engine.started.length, 2);
  assert.deepEqual(queue.busy(), { downloads: 2, verifying: 0 });
  assert.deepEqual(queue.counts(), { active: 2, queued: 0, waiting: 1, speedBps: 0 });
  engine.handleOf(jobs[0].id).exit(0);
  await until(() => stateOf(queue, jobs[0].id) === "ready", { what: "ready" });
  await until(() => engine.started.length === 3, { what: "third start" });
});

// --- idle-only --------------------------------------------------------------------

test("idle-only waits in runtime-busy until two idle polls idleGraceSeconds apart; start-now bypasses it once", async (t) => {
  let busy = true;
  const polls = [];
  const busySignal = async () => {
    polls.push({ at: Date.now(), busy });
    return { busy, known: true, detail: [] };
  };
  const { root, engine, queue } = await makeQueue(t, {
    busySignal,
    settings: baseSettings({ queue: { idleOnly: true, idleGraceSeconds: 0.08 } }),
    pollMs: 15,
  });
  const job = await queue.enqueue(spec(root, "idle"));
  await until(() => polls.length >= 3, { what: "busy polls" });
  assert.deepEqual([queue.get(job.id).state, queue.get(job.id).waitReason], ["waiting", "runtime-busy"]);
  assert.equal(engine.started.length, 0);

  busy = false;
  const idleFrom = Date.now();
  await until(() => engine.started.length === 1, { what: "idle start" });
  const idlePolls = polls.filter((poll) => !poll.busy);
  assert.ok(idlePolls.length >= 2, "two idle polls");
  assert.ok(idlePolls.at(-1).at - idlePolls[0].at >= 75, "the polls are idleGraceSeconds apart");
  assert.ok(Date.now() - idleFrom >= 75);

  // Busy again: the next job waits, start-now runs it anyway.
  busy = true;
  engine.running()[0].exit(0);
  const next = await queue.enqueue(spec(root, "bypass"));
  await until(() => queue.get(next.id).waitReason === "runtime-busy", { what: "busy wait" });
  await queue.startNow(next.id);
  await until(() => engine.started.length === 2, { what: "bypass start" });
  assert.equal(queue.get(next.id).bypassIdleOnce, false, "the bypass is used up");
});

test("an unreadable or unknown runtime load counts as idle", async (t) => {
  const { root, engine, queue } = await makeQueue(t, {
    busySignal: async () => { throw new Error("manager unreachable"); },
    settings: baseSettings({ queue: { idleOnly: true, idleGraceSeconds: 0 } }),
  });
  await queue.enqueue(spec(root, "unknown"));
  await until(() => engine.started.length === 1, { what: "start" });
});

// --- disk -------------------------------------------------------------------------

test("disk: a job waits in waiting/disk when its volume is short, others proceed; one that cannot fit alone is disk_full", async (t) => {
  const free = { "X:": 100, "Y:": 100 };
  const disk = {
    volumeOf: () => "X:",
    freeBytes: async (_dir, job) => free[job?.target?.volume] ?? null,
    reserveBytes: () => 0,
  };
  const { root, engine, events, queue } = await makeQueue(t, { disk, settings: baseSettings({ transfer: { maxConcurrent: 3 } }) });
  const big = await queue.enqueue(spec(root, "big", { size: 80, volume: "X:" }));
  await until(() => engine.started.length === 1, { what: "big start" });
  const second = await queue.enqueue(spec(root, "second", { size: 50, volume: "X:" }));
  const other = await queue.enqueue(spec(root, "other", { size: 50, volume: "Y:" }));
  await until(() => engine.started.length === 2, { what: "other volume start" });
  await queue.idle();
  assert.equal(engine.started[1].jobId, other.id);
  assert.deepEqual([queue.get(second.id).state, queue.get(second.id).waitReason], ["waiting", "disk"]);
  const notice = events.of("notification").find((item) => item.payload.kind === "hub.download.disk");
  assert.ok(notice, "a disk notification");
  assert.equal(notice.payload.jobId, second.id);

  engine.handleOf(big.id).exit(0);
  await until(() => engine.started.length === 3, { what: "second start after the volume frees" });
  assert.equal(engine.started[2].jobId, second.id);

  await assert.rejects(queue.enqueue(spec(root, "huge", { size: 200, volume: "X:" })), (error) => error instanceof HubError && error.code === "disk_full" && error.status === 507);
});

test("disk helpers: the reserve is max(5 % of free, reserveGb) and availability subtracts pending bytes", async (t) => {
  const GIB = 1024 ** 3;
  assert.equal(reserveBytes(1000 * GIB, { storage: { reserveGb: 10 } }), 50 * GIB);
  assert.equal(reserveBytes(100 * GIB, { storage: { reserveGb: 10 } }), 10 * GIB);
  assert.equal(availableBytes({ free: 100, pending: 30, reserve: 20 }), 50);
  assert.equal(availableBytes({ free: 10, pending: 30, reserve: 20 }), 0);
  const dir = tempDir(t);
  const guard = createDiskGuard({ statfs: async () => ({ bavail: 4, bsize: 1024 }) });
  assert.equal(await guard.freeBytes(path.join(dir, "not-yet", "model")), 4096);
  assert.match(guard.volumeOf(dir), process.platform === "win32" ? /^[A-Z]:$/ : /^\//);
});

// --- persistence and restart -----------------------------------------------------------

test("downloads.json round-trips the queue; state transitions persist and publish downloads events", async (t) => {
  const { root, dataDir, store, engine, events, queue } = await makeQueue(t);
  const job = await queue.enqueue(spec(root, "persisted"));
  await until(() => engine.started.length === 1, { what: "start" });
  await store.flush();
  const doc = JSON.parse(fs.readFileSync(path.join(dataDir, "downloads.json"), "utf8"));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.writerPid, process.pid);
  const saved = doc.jobs.find((item) => item.id === job.id);
  assert.equal(saved.state, "downloading");
  assert.equal(saved.transfer.pid, engine.started[0].pid);
  assert.deepEqual(saved.phaseHistory.map((entry) => entry.phase), ["queued", "resolving", "downloading"]);
  assert.ok(Array.isArray(saved.logs) && saved.logs.length > 0, "the log ring is persisted");

  const reloaded = createDownloadQueue({ store, settings: baseSettings, logger: quietLogger() });
  reloaded.load(doc);
  const copy = reloaded.get(job.id);
  assert.deepEqual(copy, queue.get(job.id), "the API shape survives the round trip");
  assert.equal(Object.hasOwn(copy, "logs"), false, "the API shape has no logs");

  const downloads = events.of("downloads");
  assert.ok(downloads.length >= 3);
  for (const item of downloads) {
    assert.equal(typeof item.payload.kind, "string");
    assert.ok(Array.isArray(item.payload.jobs));
    assert.deepEqual(Object.keys(item.payload.aggregate).sort(), ["activeCount", "etaSeconds", "queuedCount", "speedBps"]);
    for (const published of item.payload.jobs) assert.equal(Object.hasOwn(published, "logs"), false);
  }
  assert.deepEqual(downloads.filter((item) => item.payload.jobs[0]?.id === job.id).map((item) => item.payload.jobs[0].state).filter((state, index, all) => all.indexOf(state) === index), ["queued", "resolving", "downloading"]);
  assert.ok(events.published.every((item) => ["downloads", "notification"].includes(item.type)), "the queue publishes downloads and notification only");
});

test("restart: in-process jobs become interrupted and resume after the delay; paused stays paused; retry timers are re-armed; a lost temp token waits in waiting/auth", async (t) => {
  const root = tempDir(t);
  const settings = baseSettings({ transfer: { maxConcurrent: 4 }, queue: { idleOnly: true, idleGraceSeconds: 0, resumeDelaySeconds: 0.15 } });
  // First run: build real job records, held by a busy platform.
  const first = await makeQueue(t, { root, settings, busySignal: async () => ({ busy: true, known: true }) });
  const running = await first.queue.enqueue(spec(root, "running"));
  const paused = await first.queue.enqueue(spec(root, "paused"));
  const retrying = await first.queue.enqueue(spec(root, "retrying"));
  const auth = await first.queue.enqueue(spec(root, "auth", { credential: "dlt_lostlostlostlost" }));
  await first.queue.pause(paused.id);
  await first.queue.stop();
  await first.store.flush();
  const doc = JSON.parse(fs.readFileSync(path.join(first.dataDir, "downloads.json"), "utf8"));
  const byId = new Map(doc.jobs.map((job) => [job.id, job]));
  Object.assign(byId.get(running.id), { state: "downloading", transfer: { ...byId.get(running.id).transfer, pid: 4242 } });
  Object.assign(byId.get(retrying.id), { state: "retrying", retry: { count: 1, max: 3, nextAt: new Date(Date.now() + 120).toISOString(), history: [{ at: new Date().toISOString(), code: "network_unreachable" }] } });

  const engine = fakeEngine();
  const tokens = fakeTokens();
  const events = fakeEvents();
  const restarted = await makeQueue(t, { root, settings: baseSettings({ transfer: { maxConcurrent: 4 }, queue: { resumeDelaySeconds: 0.15 } }), engine, tokens, events, load: doc, store: createHubStore({ dataDir: first.dataDir }) });
  const q = restarted.queue;
  assert.deepEqual(engine.orphanCalls.map((call) => [call.ids, call.options.kill]), [[[running.id], true]], "the orphan check runs for the in-process job");
  assert.equal(stateOf(q, running.id), "interrupted");
  assert.equal(q.get(running.id).autoResume, true);
  assert.equal(q.get(running.id).transfer.pid, null);
  assert.equal(stateOf(q, paused.id), "paused");
  assert.deepEqual([q.get(auth.id).state, q.get(auth.id).waitReason], ["waiting", "auth"]);
  const authNotices = events.of("notification").filter((item) => item.payload.kind === "hub.download.auth");
  assert.equal(authNotices.length, 1);
  assert.deepEqual(authNotices[0].payload.title, { zh: "需要重新输入 Hugging Face 令牌", en: "Re-enter the Hugging Face token" });
  assert.deepEqual(authNotices[0].payload.action.apiCall, { method: "POST", path: `/api/hub/downloads/${auth.id}/resume` });

  // The retry timer fires first (120 ms), then the delayed resume (150 ms).
  await until(() => engine.started.some((handle) => handle.jobId === retrying.id), { what: "re-armed retry" });
  assert.equal(engine.started.some((handle) => handle.jobId === running.id), false, "not resumed before the delay");
  await until(() => engine.started.some((handle) => handle.jobId === running.id), { what: "auto-resume" });
  await sleep(30);
  assert.equal(stateOf(q, paused.id), "paused", "paused stays paused");
  assert.equal(engine.started.some((handle) => handle.jobId === auth.id), false, "an auth wait is never spawned");
  assert.equal(stateOf(q, auth.id), "waiting");

  // Resume without the token is refused; with one it runs.
  await assert.rejects(q.resume(auth.id), (error) => error.code === "hf_token_expired" && error.status === 409);
  const ref = await tokens.put(FAKE_TOKEN);
  await q.resume(auth.id, { credential: { tokenRef: ref, remember: false } });
  await until(() => engine.started.some((handle) => handle.jobId === auth.id), { what: "auth job start" });
  assert.equal(q.get(auth.id).transfer.options.tokenRef, ref);

  // A graceful stop leaves in-process jobs interrupted with autoResume.
  await q.stop();
  assert.equal(stateOf(q, running.id), "interrupted");
  assert.equal(q.get(auth.id).autoResume, true);
  const dataText = fs.readFileSync(path.join(first.dataDir, "downloads.json"), "utf8");
  assert.equal(dataText.includes(FAKE_TOKEN), false, "no token reaches downloads.json");
});

test("the orphan check kills only a process whose command line matches the job", async (t) => {
  const root = tempDir(t);
  const terminated = [];
  const processes = {
    111: { ProcessId: 111, CommandLine: `hf.exe download org/match --local-dir ${path.join(root, "models", "match")}` },
    222: { ProcessId: 222, CommandLine: "notepad.exe" },
  };
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const pid = Number(/ProcessId=(\d+)/.exec(args.join(" "))?.[1]);
    setImmediate(() => {
      if (processes[pid]) child.stdout.emit("data", Buffer.from(JSON.stringify(processes[pid])));
      child.emit("close", 0);
    });
    return child;
  };
  const engine = createCliTransferEngine({ hfCli: "hf", modelScopeCli: "modelscope", hfHome: root, dataDir: root, spawnImpl, platform: "win32", terminate: (pid) => terminated.push(pid) });
  const seed = await makeQueue(t, { root, start: true, busySignal: async () => ({ busy: true }), settings: baseSettings({ queue: { idleOnly: true } }) });
  const match = await seed.queue.enqueue(spec(root, "match"));
  const other = await seed.queue.enqueue(spec(root, "other"));
  await seed.queue.stop();
  const doc = seed.queue.document();
  for (const [job, pid] of [[match, 111], [other, 222]]) {
    const record = doc.jobs.find((item) => item.id === job.id);
    record.state = "downloading";
    record.transfer.pid = pid;
  }
  const restarted = await makeQueue(t, { root, engine, load: JSON.parse(JSON.stringify(doc)), settings: baseSettings({ queue: { resumeOnStart: false } }), store: seed.store });
  assert.deepEqual(terminated, [111], "the reused pid of an unrelated process is never killed");
  assert.equal(stateOf(restarted.queue, match.id), "interrupted");
  assert.equal(stateOf(restarted.queue, other.id), "interrupted");
});

// --- dedupe ---------------------------------------------------------------------------

test("dedupe at enqueue: already_downloading, already_in_library unless allowDuplicate, target_occupied", async (t) => {
  const root = tempDir(t);
  const duplicateSpec = spec(root, "dup", { files: [{ path: "dup.gguf", size: 10, sha256: "c".repeat(64), role: "weight" }] });
  const identityKey = identityKeyFor({ provider: "huggingface", repo: "org/dup", revisionSha: SHA, confidence: "declared" }, computeFilesetHash(duplicateSpec.artifact.files));
  const library = { list: async () => ({ entries: [{ id: "lib_dup", identityKey, verification: { status: "ok" } }], nextCursor: null }) };
  const prepared = [];
  const modelStorage = {
    prepareDownload(target) {
      if (target.endsWith("occupied")) throw Object.assign(new Error("目标目录已有其他文件"), { status: 409 });
      prepared.push(target);
    },
  };
  const { queue } = await makeQueue(t, { root, library, modelStorage, busySignal: async () => ({ busy: true }), settings: baseSettings({ queue: { idleOnly: true } }) });

  const first = await queue.enqueue(spec(root, "same"));
  await assert.rejects(queue.enqueue(spec(root, "same")), (error) => error.code === "already_downloading" && error.status === 409 && error.details.existingJobId === first.id);
  await assert.rejects(queue.enqueue(duplicateSpec), (error) => error.code === "already_in_library" && error.status === 409 && error.details.entryId === "lib_dup");
  const allowed = await queue.enqueue(duplicateSpec, { allowDuplicate: true });
  assert.equal(allowed.state, "queued");
  await assert.rejects(queue.enqueue(spec(root, "occupied")), (error) => error.code === "target_occupied" && error.status === 409);
  assert.deepEqual(prepared, [path.join(root, "models", "same"), path.join(root, "models", "dup")]);
});

// --- failures, retries, completion ----------------------------------------------------------

test("a retryable failure retries with backoff, a non-retryable one fails with a classified error and a notification; ready registers in the library", async (t) => {
  const registered = [];
  const library = { registerFromJob: async (job) => { registered.push(job.id); return { entryId: "lib_ready" }; }, list: async () => ({ entries: [], nextCursor: null }) };
  const { root, engine, events, queue } = await makeQueue(t, { library });
  const job = await queue.enqueue(spec(root, "flaky"));
  await until(() => engine.started.length === 1);
  engine.started[0].exit(1, { stderr: ["requests.exceptions.ConnectionError: Max retries exceeded with url"] });
  await until(() => engine.started.length === 2, { what: "automatic retry" });
  const retried = queue.get(job.id);
  assert.equal(retried.retry.count, 1);
  assert.equal(retried.retry.history[0].code, "network_unreachable");
  assert.ok(retried.phaseHistory.some((entry) => entry.phase === "retrying"));

  engine.started[1].exit(1, { stderr: ["huggingface_hub.errors.RepositoryNotFoundError: 404 Client Error. Repository Not Found for url"] });
  await until(() => stateOf(queue, job.id) === "failed", { what: "failed" });
  const failed = queue.get(job.id);
  assert.equal(failed.error.code, "repo_not_found");
  assert.equal(failed.error.retryable, false);
  assert.ok(failed.error.title.zh && failed.error.title.en && failed.error.hint.zh && failed.error.hint.en);
  assert.ok(events.of("notification").some((item) => item.payload.kind === "hub.download.failed" && item.payload.severity === "error"));

  // A user retry runs it again; this time it completes.
  await queue.retry(job.id);
  await until(() => engine.started.length === 3, { what: "user retry" });
  assert.equal(queue.get(job.id).retry.count, 0);
  engine.started[2].exit(0);
  await until(() => stateOf(queue, job.id) === "ready", { what: "ready" });
  const ready = queue.get(job.id);
  assert.equal(ready.progress.percent, 100);
  assert.equal(ready.result.libraryEntryId, "lib_ready");
  assert.deepEqual(registered, [job.id]);
  assert.ok(events.of("notification").some((item) => item.payload.kind === "hub.download.ready"));
});

test("a temp-token job releases its token on ready and is put into waiting/auth before spawn when the vault lost it", async (t) => {
  const tokens = fakeTokens({ dlt_present00000000: FAKE_TOKEN });
  const { root, engine, queue } = await makeQueue(t, { tokens });
  const kept = await queue.enqueue(spec(root, "kept", { credential: "dlt_present00000000" }));
  await until(() => engine.started.length === 1);
  engine.started[0].exit(0);
  await until(() => stateOf(queue, kept.id) === "ready");
  await until(() => tokens.released.includes("dlt_present00000000"), { what: "release" });

  const lost = await queue.enqueue(spec(root, "lost", { credential: "dlt_missing00000000" }));
  await until(() => queue.get(lost.id).waitReason === "auth", { what: "auth wait" });
  assert.equal(engine.started.length, 1, "never spawned");
  assert.equal(queue.get(lost.id).error, null, "not failed");
});

test("verification that fails on the same file twice is not retried again", async (t) => {
  let call = 0;
  const verifier = {
    async verifyArtifact(job) {
      call += 1;
      return {
        ok: false,
        badFiles: [job.artifact.files[0].path],
        failure: { code: "checksum_mismatch", baseCode: "checksum_mismatch", class: "integrity", retryable: true, title: { zh: "校验失败", en: "Checksum mismatch" }, hint: { zh: "重试", en: "Retry" }, actions: ["retry"], detail: `attempt ${call}` },
      };
    },
  };
  const { root, engine, queue } = await makeQueue(t, { verifier });
  const job = await queue.enqueue(spec(root, "bad"));
  await until(() => engine.started.length === 1);
  engine.started[0].exit(0);
  await until(() => engine.started.length === 2, { what: "integrity retry" });
  engine.started[1].exit(0);
  await until(() => stateOf(queue, job.id) === "failed", { what: "failed" });
  assert.equal(queue.get(job.id).error.code, "checksum_mismatch");
  assert.equal(queue.get(job.id).error.retryable, false);
  assert.equal(engine.started.length, 2);
});

// --- user operations ---------------------------------------------------------------------------

test("pause keeps the files, resume re-enters at the head of its band, cancel-and-delete needs the folder name and reports reclaimed bytes", async (t) => {
  const busyPaths = [];
  const { root, engine, queue, store } = await makeQueue(t, { getBusyPaths: async () => busyPaths });
  const job = await queue.enqueue(spec(root, "ops"));
  await until(() => engine.started.length === 1);
  const localDir = queue.get(job.id).target.localDir;
  fs.writeFileSync(path.join(localDir, "part.gguf"), Buffer.alloc(2048, 1));

  const paused = await queue.pause(job.id);
  assert.equal(paused.state, "paused");
  assert.equal(engine.started[0].stopReason, "pause");
  assert.ok(fs.existsSync(path.join(localDir, "part.gguf")), "pause keeps the files");

  const other = await queue.enqueue(spec(root, "other"));
  await until(() => engine.started.length === 2, { what: "other start" });
  const resumed = await queue.resume(job.id);
  assert.deepEqual([resumed.state, resumed.waitReason], ["waiting", "concurrency"], "back in the queue, at its head");
  assert.ok(resumed.queueOrder < queue.get(other.id).queueOrder, "the head of its band");

  await assert.rejects(queue.cancel(job.id, { deletePartial: true, confirm: "wrong" }), (error) => error.code === "confirm_required" && error.status === 400);
  busyPaths.push({ path: localDir, label: "容器 test" });
  await assert.rejects(queue.cancel(job.id, { deletePartial: true, confirm: "ops" }), (error) => error.code === "path_busy" && error.status === 409);
  assert.equal(stateOf(queue, job.id), "waiting", "a refused delete cancels nothing");
  busyPaths.length = 0;
  const cancelled = await queue.cancel(job.id, { deletePartial: true, confirm: "ops" });
  assert.equal(cancelled.job.state, "cancelled");
  assert.ok(cancelled.reclaimedBytes >= 2048);
  assert.equal(fs.existsSync(localDir), false);

  await assert.rejects(queue.remove(other.id), (error) => error.code === "invalid_state" && error.status === 409);
  await queue.remove(job.id);
  assert.equal(queue.get(job.id), null);
  await store.flush();
  const history = queue.history({});
  assert.equal(history.records[0].id, job.id);
  assert.equal(Object.hasOwn(history.records[0], "logs"), false);
  assert.equal(queue.history({ state: "ready" }).records.length, 0);

  const all = await queue.pauseAll();
  assert.equal(all.affected, 1);
  assert.equal(stateOf(queue, other.id), "paused");
  assert.equal((await queue.resumeAll()).affected, 1);
  await assert.rejects(queue.setPriority(other.id, "urgent"), (error) => error.code === "invalid_request");
  assert.equal((await queue.setPriority(other.id, "low")).priority, "low");
  await assert.rejects(queue.pause("dl_nosuchjobnosuchj"), (error) => error.code === "download_not_found" && error.status === 404);
});

test("logs return the redacted tail, and the resume check measures the job folder", async (t) => {
  const tokens = fakeTokens({ dlt_logtoken0000000: FAKE_TOKEN });
  const { root, engine, queue, dataDir } = await makeQueue(t, { tokens, disk: { freeBytes: async () => 5000, reserveBytes: () => 0 } });
  const job = await queue.enqueue(spec(root, "logged", { credential: "dlt_logtoken0000000" }));
  await until(() => engine.started.length === 1);
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "logs", `${job.id}.log`), `line one\nusing ${FAKE_TOKEN}\nline three\n`);
  const logs = await queue.logs(job.id, { tail: 2 });
  assert.equal(logs.total, 3);
  assert.equal(logs.lines.length, 2);
  assert.equal(logs.lines.join("\n").includes(FAKE_TOKEN), false);
  assert.ok(logs.lines[0].includes("<redacted>"));

  fs.writeFileSync(path.join(queue.get(job.id).target.localDir, "logged-Q4_K_M.gguf"), Buffer.alloc(400));
  const check = await queue.resumeCheck(job.id);
  assert.equal(check.diskFreeBytes, 5000);
  assert.equal(check.partial.length, 1);
  assert.equal(check.outputName, "logged");
});

// --- the hub and the storage probe -------------------------------------------------------------

test("hub.busy() and the hub status report active transfers of the queue", async (t) => {
  const root = tempDir(t);
  const engine = fakeEngine();
  const events = fakeEvents();
  const hub = createModelHub({ aiRoot: root, dataDir: path.join(root, "hub"), env: {}, logger: quietLogger(), heartbeatMs: 3_600_000, transferEngine: engine, events, verifier: { verifyArtifact: async () => ({ ok: true }) } });
  await hub.start();
  t.after(() => hub.stop());
  assert.deepEqual(hub.busy(), { downloads: 0, verifying: 0 });
  const job = await hub.queue.enqueue(spec(root, "hubjob"));
  await until(() => engine.started.length === 1);
  assert.deepEqual(hub.busy(), { downloads: 1, verifying: 0 });
  assert.equal(hub.status().active, 1);
  assert.equal(hub.jobs.get(job.id).state, "downloading");
  await hub.stop();
  const doc = JSON.parse(fs.readFileSync(path.join(root, "hub", "downloads.json"), "utf8"));
  assert.equal(doc.jobs.find((item) => item.id === job.id).state, "interrupted", "the final write has the interrupted job");
  assert.ok(events.of("downloads").length > 0, "the hub publishes through events.publish");
});

test("the storage busy-path probe sees hub jobs, so a migration refuses a downloading folder", async (t) => {
  const root = tempDir(t);
  const models = path.join(root, "models");
  fs.mkdirSync(models, { recursive: true });
  const storage = createModelStorage({ modelsRoot: models, file: path.join(root, "service-entry", "data", "model-storage.json") });
  const downloading = path.join(models, "downloading-model");
  fs.mkdirSync(downloading);
  fs.writeFileSync(path.join(downloading, "config.json"), "{}");
  const store = createHubStore({ dataDir: path.join(root, "service-entry", "data", "hub") });
  await store.init();
  await store.writeDownloads({ jobs: [
    { id: "dl_aaaaaaaaaaaaaaaa", state: "downloading", target: { localDir: downloading } },
    { id: "dl_bbbbbbbbbbbbbbbb", state: "ready", target: { localDir: path.join(models, "done") } },
  ] });
  const noDocker = async () => ({ stdout: "" });
  const probe = createStorageBusyPathProbe({ aiRoot: root, runCommand: noDocker });
  const busy = await probe();
  assert.deepEqual(busy.map((item) => [item.path, item.jobId]), [[downloading, "dl_aaaaaaaaaaaaaaaa"]]);

  const migration = createModelMigration({ storage, getBusyPaths: probe, reserveBytes: 0 });
  const target = path.join(root, "elsewhere");
  await assert.rejects(migration.plan({ source: downloading, targetDirectory: target }), /dl_aaaaaaaaaaaaaaaa/);

  // A stale stamp (dead writer) no longer blocks anything.
  const stale = createStorageBusyPathProbe({ aiRoot: root, runCommand: noDocker, isPidAlive: () => false });
  assert.deepEqual(await stale(), []);
});

test("hub.enqueue resolves a plan body: fresh manifest, compiled selection, a target from model storage and only a tokenRef", async (t) => {
  const root = tempDir(t);
  const models = path.join(root, "models");
  fs.mkdirSync(models, { recursive: true });
  const { normalizeRepoInfo } = require("../model-hub/providers/huggingface");
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hub", "hf-gguf-multiquant.json"), "utf8"));
  const manifest = normalizeRepoInfo(raw, { repo: "example-org/Example-8B-GGUF", revision: "main" });
  const asked = [];
  const providers = { forNamespace: (namespace, policy) => ({ getRepo: async (repo, opts) => { asked.push([namespace, policy, repo, opts.revision]); return manifest; } }), get: () => null };
  const modelStorage = createModelStorage({ modelsRoot: models, file: path.join(root, "service-entry", "data", "model-storage.json") });
  const engine = fakeEngine();
  let owner = "hub";
  const hub = createModelHub({
    aiRoot: root,
    dataDir: path.join(root, "hub"),
    env: {},
    logger: quietLogger(),
    heartbeatMs: 3_600_000,
    transferEngine: engine,
    providers,
    modelStorage,
    disk: { volumeOf: () => "X:", freeBytes: async () => 1e13, reserveBytes: () => 0 },
    verifier: { verifyArtifact: async () => ({ ok: true }) },
    readConfig: () => ({ downloadsOwner: owner, source: "default", errors: [] }),
    libraryOptions: { watch: false },
  });
  await hub.start();
  t.after(() => hub.stop());
  const ref = await hub.tokens.put(FAKE_TOKEN);
  const job = await hub.enqueue(
    { provider: "huggingface", repo: "example-org/Example-8B-GGUF", selection: { artifactKey: "gguf:|Q4_K_M" } },
    { origin: { kind: "manager-shim", managerId: "llama" }, credential: { tokenRef: ref, remember: false } },
  );
  assert.deepEqual(asked, [["huggingface", undefined, "example-org/Example-8B-GGUF", "main"]]);
  assert.equal(job.ownerManagerId, "llama");
  assert.equal(job.origin.kind, "manager-shim");
  assert.equal(job.artifact.quant, "Q4_K_M");
  assert.equal(job.artifact.revisionSha, manifest.revisionSha);
  assert.ok(job.artifact.files.some((file) => file.path.endsWith("Q4_K_M.gguf") && file.role === "weight"));
  assert.equal(job.target.localDir, path.join(models, "example-org-Example-8B-GGUF"));
  assert.equal(job.target.rootId, "legacy");
  assert.equal(job.transfer.include.mode, "include");
  assert.deepEqual([job.transfer.options.source, job.transfer.options.credentialMode, job.transfer.options.tokenRef], ["huggingface", "temp-token", ref]);
  assert.equal(JSON.stringify(job).includes(FAKE_TOKEN), false, "the job never carries the token");
  await until(() => engine.started.length === 1, { what: "start" });

  await assert.rejects(hub.enqueue({ repo: "not a repo" }), (error) => error.code === "invalid_request" && error.status === 400);
  await assert.rejects(hub.enqueue({ repo: "example-org/Example-8B-GGUF", selection: { artifactKey: "gguf:|NOPE" } }), (error) => error.status === 422);
  await assert.rejects(hub.enqueue({ planId: "pln_unknown" }), (error) => error.code === "plan_not_found" && error.status === 404);
  owner = "manager";
  await assert.rejects(hub.enqueue({ repo: "example-org/Example-8B-GGUF" }), (error) => error.code === "hub_disabled" && error.status === 409);
});

test("nothing in the hub writes SSE: it publishes through events.publish only", () => {
  const dir = path.join(__dirname, "..", "model-hub");
  const files = fs.readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(".js"));
  assert.ok(files.length > 10);
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.equal(/text\/event-stream|\.writeHead\(|res\.write\(|\bevent: /.test(text), false, `${name} touches the SSE transport`);
  }
  const queueText = fs.readFileSync(path.join(dir, "queue.js"), "utf8");
  assert.deepEqual([...new Set([...queueText.matchAll(/publish\("([a-z.]+)"/g)].map((match) => match[1]))].sort(), ["downloads", "notification"]);
});
