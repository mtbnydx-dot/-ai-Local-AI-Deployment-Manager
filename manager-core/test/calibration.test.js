"use strict";

// Calibration store, observations and the afterReady hook (docs/overhaul/02-models.md
// §10.6, §21.2 calibration.test.js, MOD-10): the 500-record cap, the atomic
// write, the corrupt-file rename, the key taken verbatim from
// engines.paramsKey, exact versus non-exact lookups, observationFromFacts over
// 01 logFacts (vLLM, SGLang, llama per-device buffers) without reading logs,
// a recorded ready launch from a fake supervisor, an exact hit reaching the
// real memory models as "measured", and a failing hook never failing the job.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("..");
const engines = require("../engines");
const calibration = require("../model-inspector/calibration");
const observations = require("../model-inspector/observations");
const { managerHooks } = require("../model-inspector/manager-hooks");
const { createRuntimeSupervisor } = require("../engines/runtime-supervisor");

const DIGEST = "sha256:" + "a".repeat(64);
const OTHER_DIGEST = "sha256:" + "b".repeat(64);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calibration-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(overrides = {}) {
  return {
    contentDigest: DIGEST,
    engineId: "vllm",
    runtimeId: "vllm@test",
    recipeId: null,
    paramsKey: "262144|1|auto|-",
    launchId: null,
    estimated: { perGpuMb: { 0: 60000 }, breakdown: { weights: 30000 }, policy: "weights-plus-kv" },
    measured: { perGpuMb: { 0: 62000 }, gpuUsedDeltaMb: 62000, logFacts: {} },
    at: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

const PLAN = Object.freeze({
  engineId: "vllm",
  values: { contextLength: 262144, concurrency: 1, kvCacheDtype: "auto" },
  memory: { policy: "weights-plus-kv", perGpuMb: { 0: 60000 }, breakdown: { weights: 30000, kv: 20000 } },
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("the store keeps at most 500 records and writes {schemaVersion:1, records} atomically", (t) => {
  const file = path.join(tempDir(t), "data", "memory-calibration.json");
  const store = calibration.createCalibrationStore({ file });
  assert.equal(store.maxRecords, 500);
  for (let index = 0; index < 505; index += 1) store.record(record({ paramsKey: `${index}|1|auto|-`, launchId: `launch-${index}` }));
  assert.equal(store.size(), 500);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.records.length, 500);
  assert.equal(saved.records[0].paramsKey, "5|1|auto|-", "the oldest five dropped");
  assert.equal(saved.records[499].paramsKey, "504|1|auto|-");
  // No temporary file is left behind and a second store instance reads the same file.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["memory-calibration.json"]);
  assert.equal(calibration.createCalibrationStore({ file }).size(), 500);
});

test("a failed write leaves the previous file intact and no temporary file", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "memory-calibration.json");
  const store = calibration.createCalibrationStore({ file });
  store.record(record({ launchId: "first" }));
  const before = fs.readFileSync(file, "utf8");
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to) === file) throw Object.assign(new Error("disk says no"), { code: "ENOSPC" });
    return realRename(from, to);
  };
  try {
    assert.throws(() => store.record(record({ launchId: "second" })), /disk says no/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(dir), ["memory-calibration.json"]);
});

test("a corrupt file is renamed to .corrupt-<ts>, ignored, and rewritten by the next record", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "memory-calibration.json");
  fs.writeFileSync(file, "{ this is not json");
  const logged = [];
  const store = calibration.createCalibrationStore({ file, now: () => 1234567, log: (message) => logged.push(message) });
  assert.equal(store.lookup({ contentDigest: DIGEST, runtimeId: "vllm@test", paramsKey: "262144|1|auto|-" }), null);
  assert.equal(store.size(), 0);
  assert.ok(fs.existsSync(`${file}.corrupt-1234567`));
  assert.equal(fs.existsSync(file), false);
  assert.equal(logged.length, 1);
  store.record(record());
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).records.length, 1);

  // A well-formed JSON of the wrong shape or schema version counts as corrupt too.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, records: [] }));
  const other = calibration.createCalibrationStore({ file, now: () => 7654321 });
  assert.equal(other.size(), 0);
  assert.ok(fs.existsSync(`${file}.corrupt-7654321`));
});

test("lookup returns the exact key hit with the median of the max per-GPU measured memory", (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  const key = "262144|1|auto|-";
  store.record(record({ measured: { perGpuMb: { 0: 60000, 1: 64000 } } }));
  store.record(record({ measured: { perGpuMb: { 0: 70000 } } }));
  store.record(record({ measured: { perGpuMb: { 0: 66000 } } }));
  const hit = store.lookup({ contentDigest: DIGEST, runtimeId: "vllm@test", paramsKey: key });
  assert.equal(hit.exact, true);
  assert.equal(hit.measuredMb, 66000);
  assert.equal(hit.samples, 3);
  // A record with no measured memory is not a sample.
  store.record(record({ measured: { perGpuMb: {} } }));
  assert.equal(store.lookup({ contentDigest: DIGEST, runtimeId: "vllm@test", paramsKey: key }).samples, 3);
});

test("non-exact records are never returned as exact", (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  store.record(record());
  const base = { contentDigest: DIGEST, runtimeId: "vllm@test", paramsKey: "262144|1|auto|-" };
  assert.equal(store.lookup({ ...base, paramsKey: "131072|1|auto|-" }), null);
  assert.equal(store.lookup({ ...base, runtimeId: "vllm@other" }), null);
  assert.equal(store.lookup({ ...base, contentDigest: OTHER_DIGEST }), null);
  assert.equal(store.lookup({ ...base, runtimeId: null }), null);

  const card = { contentDigest: DIGEST };
  const near = store.calibrationFor(card, "vllm", "vllm@test", "131072|1|auto|-");
  assert.equal(near.exact, false, "01 never applies it");
  assert.equal(near.measuredMb, null);
  assert.equal(near.samples, 0);
  assert.equal(near.records.length, 1, "only fit.js reads the records, for the drift check");
  assert.equal(store.calibrationFor({ contentDigest: OTHER_DIGEST }, "vllm", "vllm@test", base.paramsKey), null);
  assert.equal(store.calibrationFor({ contentDigest: DIGEST }, "sglang", "sglang@test", base.paramsKey), null, "another engine");
  assert.equal(store.calibrationFor(null, "vllm", "vllm@test", base.paramsKey), null);
  const exact = store.calibrationFor(card, "vllm", "vllm@test", base.paramsKey);
  assert.deepEqual({ ...exact, records: exact.records.length }, { exact: true, measuredMb: 62000, samples: 1, records: 1 });
});

test("recent returns the last n records of a model and engine, oldest first", (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  for (let index = 0; index < 7; index += 1) store.record(record({ launchId: `v${index}` }));
  store.record(record({ launchId: "s0", engineId: "sglang", runtimeId: "sglang@test" }));
  store.record(record({ launchId: "o0", contentDigest: OTHER_DIGEST }));
  assert.deepEqual(store.recent({ contentDigest: DIGEST, engineId: "vllm" }, 3).map((item) => item.launchId), ["v4", "v5", "v6"]);
  assert.equal(store.recent({ contentDigest: DIGEST }, 50).length, 8);
  assert.deepEqual(store.recent({ contentDigest: null }, 3), []);
});

test("a launch is recorded once and an invalid record is refused", (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  assert.equal(store.record(record({ launchId: "L1" })).recorded, true);
  assert.deepEqual(store.record(record({ launchId: "L1" })), { recorded: false, duplicate: true, size: 1 });
  assert.throws(() => store.record(record({ paramsKey: null })), /contentDigest, runtimeId and paramsKey/);
  assert.throws(() => store.record(null), TypeError);
});

test("the key in the store is engines.paramsKey output verbatim", (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  const llamaPlan = { engineId: "llamacpp", values: { contextLength: 131072, concurrency: 1, "llamacpp.cacheTypeK": "f16", "llamacpp.cacheTypeV": "f16" } };
  const sglangPlan = { engineId: "sglang", values: { contextLength: 262144, concurrency: 1, kvCacheDtype: "auto", "sglang.maxTotalTokens": 262144 } };
  assert.equal(engines.paramsKey(llamaPlan), "131072|1|f16/f16|-");
  assert.equal(engines.paramsKey(sglangPlan), "262144|1|auto|262144");
  for (const plan of [llamaPlan, sglangPlan, PLAN]) {
    const args = { launchId: `L-${plan.engineId}`, plan, runtimeId: `${plan.engineId}@test`, contentDigest: DIGEST, logFacts: {}, gpuUsedBeforeMb: 1000 };
    const observation = observations.observationFromFacts(args, { gpuUsedNowMb: 41000 });
    assert.equal(observation.paramsKey, engines.paramsKey(plan), "derived with the 01 builder");
    store.record(observation);
    assert.equal(store.lookup({ contentDigest: DIGEST, runtimeId: args.runtimeId, paramsKey: engines.paramsKey(plan) }).samples, 1);
  }
  // A key the supervisor supplies is used as given.
  const given = observations.observationFromFacts({ launchId: "x", plan: PLAN, paramsKey: "given-key", runtimeId: "r", contentDigest: DIGEST }, {});
  assert.equal(given.paramsKey, "given-key");
});

// ---------------------------------------------------------------------------
// observationFromFacts
// ---------------------------------------------------------------------------

test("observationFromFacts maps vLLM, SGLang and llama.cpp logFacts without reading any log", () => {
  const base = { launchId: "L", runtimeId: "r@test", contentDigest: DIGEST, plan: PLAN, gpuUsedBeforeMb: 1000 };

  const vllm = observations.observationFromFacts({ ...base, engineId: "vllm", logFacts: { weightsGiB: 28.5, kvGiB: 20.25, kvTokens: 262144, maxConcurrency: 1.4, note: "text is dropped" } }, { gpuUsedNowMb: 61000 });
  assert.deepEqual(vllm.measured.logFacts, { weightsGiB: 28.5, kvGiB: 20.25, kvTokens: 262144, maxConcurrency: 1.4 });
  assert.equal(vllm.measured.gpuUsedDeltaMb, 60000);
  assert.deepEqual(vllm.measured.perGpuMb, { 0: 60000 });
  assert.deepEqual(vllm.estimated, { perGpuMb: { 0: 60000 }, breakdown: { weights: 30000, kv: 20000 }, policy: "weights-plus-kv" });
  assert.equal(vllm.engineId, "vllm");
  assert.equal(vllm.launchId, "L");

  const sglang = observations.observationFromFacts({ ...base, engineId: "sglang", logFacts: { weightsGiB: 27, kvTokens: 262144 } }, { gpuUsedNowMb: 51000 });
  assert.deepEqual(sglang.measured.logFacts, { weightsGiB: 27, kvTokens: 262144 });
  assert.equal(sglang.engineId, "sglang");

  const llamaFacts = { modelBufferMiB: { CUDA0: 30000, CUDA1: 29000, CPU: 12000 }, kvBufferMiB: { CUDA0: 2000, CUDA1: 2000 }, computeBufferMiB: { CUDA0: 900, CUDA1: 400 } };
  const llama = observations.observationFromFacts({ ...base, engineId: "llamacpp", logFacts: llamaFacts }, { gpuUsedNowMb: { 0: 33100, 1: 31900 } });
  assert.deepEqual(llama.measured.logFacts, llamaFacts);
  assert.equal(llama.measured.gpuUsedDeltaMb, 64000);
  assert.deepEqual(llama.measured.perGpuMb, { 0: 32000, 1: 32000 }, "the growth splits evenly across the launch's GPUs");

  // No GPU reading: the facts are kept, the measured memory is empty.
  const blind = observations.observationFromFacts({ ...base, logFacts: { weightsGiB: 1 } }, { gpuUsedNowMb: null });
  assert.deepEqual(blind.measured, { perGpuMb: {}, gpuUsedDeltaMb: null, logFacts: { weightsGiB: 1 } });
  // GPU memory that shrank is not negative growth.
  assert.equal(observations.observationFromFacts({ ...base }, { gpuUsedNowMb: 500 }).measured.gpuUsedDeltaMb, 0);
});

test("observations.js reads no file and calibration facts come only from logFacts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "model-inspector", "observations.js"), "utf8");
  assert.doesNotMatch(source, /require\("(node:)?fs/);
  assert.doesNotMatch(source, /\.logs\(|readFile|createReadStream/);
});

// ---------------------------------------------------------------------------
// The afterReady hook
// ---------------------------------------------------------------------------

function hookFixture(t, overrides = {}) {
  const dir = tempDir(t);
  const readings = [];
  const gpuStatus = async () => {
    const used = readings.length ? readings.shift() : 1000;
    return { gpus: [{ id: "0", usedMb: used }, { id: "1", usedMb: 99999 }] };
  };
  const slept = [];
  const messages = [];
  const hooks = managerHooks({
    managerId: "vllm",
    dataDir: dir,
    gpuStatus,
    sleep: async (ms) => { slept.push(ms); },
    log: (message) => messages.push(message),
    ...overrides,
  });
  return { dir, hooks, readings, slept, messages, file: path.join(dir, "memory-calibration.json") };
}

const READY = Object.freeze({
  managerId: "vllm",
  launchId: "launch-1",
  engineId: "vllm",
  runtimeId: "vllm@test",
  plan: PLAN,
  paramsKey: "262144|1|auto|-",
  contentDigest: DIGEST,
  logFacts: { weightsGiB: 28.5, kvGiB: 20 },
  gpuUsedBeforeMb: 1000,
});

test("afterReady samples twice 10 s apart, takes the larger reading and records once per launch", async (t) => {
  const { hooks, readings, slept, file } = hookFixture(t);
  readings.push(50000, 61000);
  const first = await hooks.afterReady({ ...READY });
  assert.equal(first.recorded, true);
  assert.deepEqual(slept, [10000]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).records;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].paramsKey, "262144|1|auto|-");
  assert.deepEqual(saved[0].measured.perGpuMb, { 0: 60000 }, "only the launch's GPU, the larger sample minus gpuUsedBeforeMb");
  assert.equal(saved[0].measured.gpuUsedDeltaMb, 60000);
  assert.deepEqual(saved[0].measured.logFacts, { weightsGiB: 28.5, kvGiB: 20 });

  // The same launch again, even through a fresh hooks object over the same file.
  assert.equal(await hooks.afterReady({ ...READY }), null);
  const again = managerHooks({ managerId: "vllm", dataDir: path.dirname(file), gpuStatus: async () => ({ gpus: [] }), sleep: async () => {} });
  assert.equal((await again.afterReady({ ...READY })).duplicate, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).records.length, 1);
  await hooks.afterReady({ ...READY, launchId: "launch-2" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).records.length, 2);
});

// A real supervisor over a fake host: the hook gets the context the supervisor
// builds, and the only log reads are the supervisor's own, before afterReady.
function supervisorHarness(t, { afterReady, logText, gpuUsed = 1000 }) {
  const logCalls = { count: 0, afterHook: 0 };
  let hookStarted = false;
  const host = {
    kind: "docker",
    async ready() { return { ok: true, version: "fixture", detail: "", started: false }; },
    async list() { return []; },
    async inspect() { return { exists: true, running: true, status: "running", labels: {} }; },
    async ensureImage(image) { return { ok: true, pulled: false, image }; },
    async checkpoint() { return { hadPrevious: false, async commit() { return { committed: true }; }, async rollback() { return {}; } }; },
    async create(cmd) { return { name: cmd.name, id: "cid", stdout: "cid\n", stderr: "" }; },
    async logs() { logCalls.count += 1; if (hookStarted) logCalls.afterHook += 1; return logText; },
    async stop() { return { removed: true }; },
  };
  const registry = core.engines.createEngineRegistry({ overrideDir: path.join(tempDir(t), "engines"), env: {} });
  const supervisor = createRuntimeSupervisor({
    managerId: "llama",
    host,
    registry,
    jobs: {
      appendLog(job, line) { job.logs.push(line); },
      setJobProgress(job, patch) { job.progress = { ...(job.progress || {}), ...patch }; },
      scheduleJobsSave() {},
      finishJob(job) { job.status = "success"; },
      failJob(job, error) { job.status = "error"; job.error = String(error?.message || error); },
      assertActive() {},
    },
    events: { emit() {}, publish() {} },
    launchStore: {
      beginLaunch(job) { job.meta.launchId = "lch_TESTTESTTESTTESTTEST"; return job.meta.launchId; },
      recordCommand() {},
      markStatus() {},
    },
    probes: { gpuStatus: async () => ({ ok: true, gpus: [{ id: "0", index: 0, usedMb: gpuUsed }] }) },
    getters: {
      containerStatus: async () => ({ exists: true, running: true, status: "Up" }),
      servedModels: async () => [{ id: "fixture-model" }],
    },
    hooks: { afterReady: (context) => { hookStarted = true; return afterReady(context); } },
    delay: async () => {},
  });
  const job = { id: "job-1", status: "running", logs: [], meta: {} };
  const run = {
    options: { instanceMode: "replace", containerName: "llama-local", port: 18080 },
    engineId: "llamacpp",
    engineName: "llama.cpp",
    containerName: "llama-local",
    instanceId: "primary",
    port: 18080,
    gpuIds: [],
    plan: { engineId: "llamacpp", values: { contextLength: 32768, concurrency: 1, "llamacpp.cacheTypeK": "f16", "llamacpp.cacheTypeV": "f16" }, memory: { policy: "gguf-estimate", perGpuMb: { 0: 9000 }, breakdown: {} } },
    runtimeId: "llamacpp@fixture",
    paramsKey: "32768|1|f16/f16|-",
    contentDigest: DIGEST,
    buildCommand: () => ({
      runArgs: ["run", "-d", "--name", "llama-local", "--label", "ai.manager=llama", "fixture-image"],
      publish: ["-p", "127.0.0.1:18080:8080"],
      image: "fixture-image",
      secretEnv: {},
    }),
    wait: { serviceUrl: "http://127.0.0.1:18080/v1", probe: async () => ({ ok: true, detail: "fixture" }) },
  };
  return { supervisor, job, run, logCalls };
}

test("a fake supervisor records one observation per ready launch from logFacts without reading logs", async (t) => {
  const dir = tempDir(t);
  const used = [10000, 10400];
  const hooks = managerHooks({
    managerId: "llama",
    dataDir: dir,
    gpuStatus: async () => ({ gpus: [{ id: "0", usedMb: used.length ? used.shift() : 10400 }] }),
    sleep: async () => {},
  });
  const text = fs.readFileSync(path.join(__dirname, "fixtures", "engines", "log-samples", "llamacpp-startup.log.fixture"), "utf8");
  const { supervisor, job, run, logCalls } = supervisorHarness(t, { afterReady: hooks.afterReady, logText: text });
  await supervisor.start({ job, run });
  assert.equal(job.status, "success", job.error);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "memory-calibration.json"), "utf8")).records;
  assert.equal(saved.length, 1, "once per ready launch");
  assert.equal(saved[0].launchId, "lch_TESTTESTTESTTESTTEST");
  assert.equal(saved[0].runtimeId, "llamacpp@fixture");
  assert.equal(saved[0].paramsKey, "32768|1|f16/f16|-");
  assert.equal(saved[0].contentDigest, DIGEST);
  assert.deepEqual(saved[0].measured.logFacts.modelBufferMiB, { CUDA0: 2410.55, CUDA1: 2210.25 });
  assert.equal(saved[0].measured.gpuUsedDeltaMb, 9400, "the larger sample (10400) minus gpuUsedBeforeMb (1000)");
  assert.equal(logCalls.afterHook, 0, "the hook read no log");
  assert.ok(logCalls.count > 0, "the supervisor itself read logs for readiness");
});

test("a hook that throws is logged by the supervisor and the job still succeeds", async (t) => {
  const { supervisor, job, run } = supervisorHarness(t, { afterReady: async () => { throw new Error("hook blew up"); }, logText: "" });
  await supervisor.start({ job, run });
  assert.equal(job.status, "success");
  assert.ok(job.logs.some((line) => line.includes("afterReady hook failed (ignored): hook blew up")));
});

test("afterReady skips a launch it cannot key and never throws", async (t) => {
  const { hooks, file, messages } = hookFixture(t);
  assert.equal(await hooks.afterReady({ ...READY, contentDigest: null, plan: null }), null);
  assert.equal(await hooks.afterReady({ ...READY, runtimeId: null }), null);
  assert.equal(await hooks.afterReady({ ...READY, paramsKey: null, plan: null }), null);
  assert.equal(await hooks.afterReady(undefined), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(messages, []);
});

test("a failing hook never fails the job: a broken store and a failing GPU probe are swallowed and logged once", async (t) => {
  // A store that cannot write.
  const blocked = hookFixture(t, { calibrationStore: { calibrationFor() { throw new Error("lookup exploded"); }, record() { throw new Error("write exploded"); } } });
  assert.equal(await blocked.hooks.afterReady({ ...READY }), null);
  assert.equal(await blocked.hooks.afterReady({ ...READY, launchId: "again" }), null);
  assert.equal(blocked.messages.length, 1, "logged once");
  assert.match(blocked.messages[0], /write exploded/);
  assert.equal(blocked.hooks.calibrationFor({ contentDigest: DIGEST }, "vllm", "vllm@test", "k"), null);

  // A GPU probe that throws still records the log facts.
  const probe = hookFixture(t, { gpuStatus: async () => { throw new Error("nvidia-smi gone"); } });
  const result = await probe.hooks.afterReady({ ...READY });
  assert.equal(result.recorded, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(probe.file, "utf8")).records[0].measured.perGpuMb, {});
});

test("managerHooks without a dataDir stays a safe no-op, and classifyFailure is the root-cause matcher", async () => {
  const hooks = managerHooks({ managerId: "vllm" });
  assert.equal(hooks.calibrationFor({ contentDigest: DIGEST }, "vllm", "r", "k"), null);
  assert.equal(await hooks.afterReady({ ...READY }), null);
  assert.equal(hooks.classifyFailure("", { engineId: "vllm", phase: "weights" }), null);
  assert.equal(hooks.classifyFailure("some log text", { engineId: "vllm", phase: "weights" }).code, "engine_start_failed");
  assert.deepEqual(Object.keys(hooks).sort(), ["afterReady", "calibrationFor", "classifyFailure", "modelFacts"]);
});

// ---------------------------------------------------------------------------
// From the store to the memory models
// ---------------------------------------------------------------------------

test("core.models exposes the calibration and observations members", () => {
  assert.equal(typeof core.models.calibration.createCalibrationStore, "function");
  assert.equal(core.models.calibration.calibrationFor, calibration.calibrationFor);
  assert.equal(typeof core.models.observations.observationFromFacts, "function");
});

test("an exact hit reaches memoryModels.estimate and yields measured; a far-off measurement raises estimate_drift", async (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  const card = structuredClone(require("./fixtures/model-cards/deepseek-v4-flash-q2k-gguf/expected-card.json"));
  const values = { contextLength: 32768, concurrency: 1, "llamacpp.nCpuMoe": 20 };
  const runtimeId = "llama@test";
  const paramsKey = engines.paramsKey({ engineId: "llamacpp", values });
  const host = { gpus: [{ id: "0", name: "GPU 0", totalMb: 97887, freeMb: 97000, usedMb: 600, computeCap: "12.0" }], ramBytes: 256 * 1024 ** 3, ramFreeBytes: 200 * 1024 ** 3, platform: "wsl" };
  const input = { card, legacy: null, engineId: "llamacpp", runtimeId, gpuIds: ["0"], values, host };

  const estimated = core.models.fit.estimateFit(input, { calibrationFor: store.calibrationFor, suggestions: false });
  const estimatedMb = Math.max(...Object.values(estimated.perGpuMb));
  for (let index = 0; index < 3; index += 1) {
    store.record(record({
      contentDigest: card.contentDigest,
      engineId: "llamacpp",
      runtimeId,
      paramsKey,
      launchId: `m${index}`,
      estimated: { perGpuMb: estimated.perGpuMb, breakdown: estimated.breakdown, policy: estimated.policy },
      measured: { perGpuMb: { 0: Math.round(estimatedMb * 1.3) }, gpuUsedDeltaMb: Math.round(estimatedMb * 1.3), logFacts: {} },
    }));
  }
  const measured = core.models.fit.estimateFit(input, { calibrationFor: store.calibrationFor, suggestions: false });
  assert.equal(measured.policy, "measured");
  assert.equal(measured.confidence, "measured");
  assert.deepEqual({ applied: measured.calibration.applied, samples: measured.calibration.samples, source: measured.calibration.source }, { applied: true, samples: 3, source: "exact" });
  assert.ok(Math.abs(measured.calibration.driftRatio - 1.3) < 0.01);
  assert.ok(measured.warnings.some((item) => item.code === "estimate_drift"));
  assert.ok(Math.max(...Object.values(measured.perGpuMb)) > estimatedMb * 1.25);

  // A different paramsKey for the same model is not an exact hit and is not applied.
  const otherValues = { ...values, contextLength: 16384 };
  const other = core.models.fit.estimateFit({ ...input, values: otherValues }, { calibrationFor: store.calibrationFor, suggestions: false });
  assert.notEqual(other.policy, "measured");
  assert.equal(other.calibration.applied, false);
});

test("weights_mismatch comes from engine-reported weights in a recorded launch", (t) => {
  const store = calibration.createCalibrationStore({ file: path.join(tempDir(t), "c.json") });
  const card = structuredClone(require("./fixtures/model-cards/qwen38-27b-fp8/expected-card.json"));
  const values = { contextLength: 262144, concurrency: 1 };
  const host = { gpus: [{ id: "0", name: "GPU 0", totalMb: 97887, freeMb: 97000, usedMb: 600, computeCap: "12.0" }], ramBytes: 256 * 1024 ** 3, ramFreeBytes: 200 * 1024 ** 3, platform: "wsl" };
  const input = { card, legacy: null, engineId: "vllm", runtimeId: "vllm@test", gpuIds: ["0"], values, host };
  const plain = core.models.fit.estimateFit(input, { suggestions: false });
  const weightsGiB = (plain.artifact.weightsMb / 1024) * 1.25;
  store.record(record({
    contentDigest: card.contentDigest,
    estimated: { perGpuMb: plain.perGpuMb, breakdown: plain.breakdown, policy: plain.policy },
    measured: { perGpuMb: { 0: Math.max(...Object.values(plain.perGpuMb)) }, gpuUsedDeltaMb: 1, logFacts: { weightsGiB } },
  }));
  const result = core.models.fit.estimateFit(input, { calibrationFor: store.calibrationFor, suggestions: false });
  assert.ok(result.warnings.some((item) => item.code === "weights_mismatch"));
  assert.equal(result.calibration.driftRatio, null, "measured equals estimated: no drift");
});
