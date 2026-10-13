const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("..");

// Obviously fake values; the point is that they never reach disk or a mirror.
const DOWNLOAD_TOKEN = "hf_FakeDownloadTokenForTests0000";
const ENV_TOKEN = "hf_FakeInheritedEnvTokenForTests00";

function listFilesRecursive(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(target) : [target];
  });
}

function buildHarness(t, controllerOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-transfer-"));
  const jobs = new Map();
  const tokens = new Map();
  const released = [];
  const spawns = [];
  const store = core.createJobsLedgerStore({
    jobs,
    file: path.join(dir, "jobs-ledger.json"),
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
  });
  const builder = core.createDownloadCommandBuilder({
    hfCli: "hf",
    modelScopeCli: "modelscope",
    hfCache: path.join(dir, "hf-cache"),
    modelsRoot: path.join(dir, "store"),
    env: { PATH: "x", HF_TOKEN: ENV_TOKEN, HUGGING_FACE_HUB_TOKEN: ENV_TOKEN },
    cleanRequired: core.cleanRequired,
  });
  const controller = core.createDownloadJobController({
    jobs,
    createJob: store.createJob,
    appendLog: store.appendLog,
    failJob: store.failJob,
    scheduleSave: () => {},
    spawnJobProcess: (job, command, args, options) => {
      job.status = "running";
      spawns.push({ id: job.id, command, args, env: options.env });
    },
    buildDownloadSpecFromJob: builder.buildDownloadSpecFromJob,
    stopProgressTracker: () => {},
    resolveDownloadSecret: (ref) => tokens.get(ref) || null,
    releaseDownloadSecret: (ref) => {
      released.push(ref);
      tokens.delete(ref);
    },
    processStartedAt: Date.now() - 60_000,
    setRetryTimeout: () => ({ unref() {} }),
    clearRetryTimeout: () => {},
    hfMirror: true,
    hfTransfer: true,
    ...controllerOptions,
  });
  t.after(async () => {
    store.clearJobsSaveTimer();
    await store.waitForJobsLedgerWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, jobs, tokens, released, spawns, store, builder, controller };
}

function enqueue(harness, model, transfer) {
  const localDir = path.join(harness.dir, "store", model.replace("/", "__"));
  const settings = harness.controller.getDownloadSettings();
  const token = transfer?.tokenRef ? harness.tokens.get(transfer.tokenRef) : null;
  return harness.controller.enqueueOrStartDownload("hf", ["download", model, "--local-dir", localDir], {
    env: core.buildDownloadEnv(path.join(harness.dir, "hf-cache"), { PATH: "x" }, {
      source: "huggingface",
      hfMirror: transfer ? transfer.hfMirror : settings.hfMirror,
      hfTransfer: settings.hfTransfer,
      token,
    }),
    title: `Download ${model}`,
    meta: { model, source: "huggingface", localDir, ...(transfer ? { transfer } : {}) },
  });
}

function fail(harness, job) {
  harness.store.failJob(job, new Error("Process exited with code 1"));
  job.meta.failedAt = Date.now();
}

test("a resumed job reuses its recorded mirror and transfer settings", (t) => {
  const harness = buildHarness(t);
  const job = enqueue(harness, "org/mirrored", { hfMirror: true, hfTransfer: true, tokenRef: null, gated: false });
  assert.deepEqual(job.meta.transfer, {
    hfMirror: true,
    hfEndpoint: "https://hf-mirror.com",
    hfTransfer: true,
    tokenRef: null,
    gated: false,
  });
  fail(harness, job);
  // The global settings change after enqueue; the job keeps what it started with.
  harness.controller.applyDownloadSettings({ hfMirror: false, hfTransfer: false });
  harness.controller.resumeDownloadJob(job);
  const env = harness.spawns.at(-1).env;
  assert.equal(env.HF_ENDPOINT, "https://hf-mirror.com");
  assert.equal(env.HF_XET_HIGH_PERFORMANCE, "1");
  assert.equal(env.HF_TOKEN, undefined, "the mirror never receives an inherited token");
  assert.equal(env.HUGGING_FACE_HUB_TOKEN, undefined);
  assert.equal(env.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1", "the implicit login token is disabled for the mirror");
});

test("a gated job resolves its token only through the ref and stays on the official endpoint", (t) => {
  const harness = buildHarness(t);
  harness.tokens.set("dlt_gated", DOWNLOAD_TOKEN);
  const job = enqueue(harness, "org/gated", { hfMirror: true, hfTransfer: false, tokenRef: "dlt_gated", gated: true });
  assert.equal(job.meta.transfer.hfMirror, false, "gated and token downloads force the official endpoint");
  assert.equal(job.meta.transfer.hfEndpoint, null);
  assert.equal(harness.spawns[0].env.HF_TOKEN, DOWNLOAD_TOKEN);
  assert.equal(harness.spawns[0].env.HF_ENDPOINT, undefined);
  fail(harness, job);

  const lookups = [];
  const resolve = (ref) => {
    lookups.push(ref);
    return harness.tokens.get(ref) || null;
  };
  const spec = harness.builder.buildDownloadSpecFromJob(job, { settings: { hfMirror: true }, resolveSecret: resolve });
  assert.deepEqual(lookups, ["dlt_gated"]);
  assert.equal(spec.options.env.HF_TOKEN, DOWNLOAD_TOKEN);
  assert.equal(spec.options.env.HF_ENDPOINT, undefined);
  assert.equal(spec.options.env.HF_HUB_DISABLE_IMPLICIT_TOKEN, undefined);

  harness.controller.resumeDownloadJob(job);
  assert.equal(job.status, "running");
  assert.equal(harness.spawns.at(-1).env.HF_TOKEN, DOWNLOAD_TOKEN);
});

test("a missing token fails the resume with hf_token_expired and is not retried", (t) => {
  const harness = buildHarness(t);
  harness.tokens.set("dlt_lost", DOWNLOAD_TOKEN);
  const job = enqueue(harness, "org/lost", { hfMirror: false, hfTransfer: false, tokenRef: "dlt_lost", gated: true });
  fail(harness, job);
  harness.tokens.clear(); // what a manager restart does to the in-memory map
  assert.throws(
    () => harness.builder.buildDownloadSpecFromJob(job, { resolveSecret: () => null }),
    (error) => error.code === "hf_token_expired" && /Token/.test(error.message),
  );
  assert.throws(() => harness.controller.resumeDownloadJob(job), (error) => error.code === "hf_token_expired");
  assert.equal(job.status, "failed");
  assert.equal(job.meta.errorCode, "hf_token_expired");
  assert.equal(job.meta.errorRetryable, false);
  assert.equal(harness.spawns.length, 1, "nothing is spawned without the token");
  // A builder without a resolver behaves the same: no silent retry without the token.
  assert.throws(() => harness.builder.buildDownloadSpecFromJob(job), (error) => error.code === "hf_token_expired");
});

test("a legacy job without meta.transfer uses the current settings", (t) => {
  const harness = buildHarness(t);
  const job = enqueue(harness, "org/legacy", null);
  assert.equal(job.meta.transfer, undefined);
  fail(harness, job);
  harness.controller.resumeDownloadJob(job);
  const mirrored = harness.spawns.at(-1).env;
  assert.equal(mirrored.HF_ENDPOINT, "https://hf-mirror.com");
  assert.equal(mirrored.HF_XET_HIGH_PERFORMANCE, "1");
  assert.equal(mirrored.HF_TOKEN, undefined);

  fail(harness, job);
  harness.controller.applyDownloadSettings({ hfMirror: false, hfTransfer: false });
  harness.controller.resumeDownloadJob(job);
  const official = harness.spawns.at(-1).env;
  assert.equal(official.HF_ENDPOINT, undefined);
  assert.equal(official.HF_XET_HIGH_PERFORMANCE, undefined);
  assert.equal(official.HF_TOKEN, ENV_TOKEN, "the official endpoint keeps today's inherited token");

  // Callers that pass no settings keep the old behaviour exactly.
  const plain = harness.builder.buildDownloadSpecFromJob({ meta: { model: "org/legacy" } });
  assert.equal(plain.options.env.HF_ENDPOINT, undefined);
});

test("buildDownloadEnv isolates tokens from the mirror and forces official for token downloads", () => {
  const base = { PATH: "x", HF_TOKEN: ENV_TOKEN, HUGGING_FACE_HUB_TOKEN: ENV_TOKEN };
  const mirror = core.buildDownloadEnv("cache", base, { hfMirror: true });
  assert.equal(mirror.HF_ENDPOINT, "https://hf-mirror.com");
  assert.equal(mirror.HF_TOKEN, undefined);
  assert.equal(mirror.HUGGING_FACE_HUB_TOKEN, undefined);
  assert.equal(mirror.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
  assert.equal(base.HF_TOKEN, ENV_TOKEN, "the caller's env is not mutated");

  const withToken = core.buildDownloadEnv("cache", base, { hfMirror: true, token: DOWNLOAD_TOKEN });
  assert.equal(withToken.HF_ENDPOINT, undefined, "a token download never goes to the mirror");
  assert.equal(withToken.HF_TOKEN, DOWNLOAD_TOKEN);
  assert.equal(withToken.HF_HUB_DISABLE_IMPLICIT_TOKEN, undefined);

  const gated = core.buildDownloadEnv("cache", base, { hfMirror: true, gated: true });
  assert.equal(gated.HF_ENDPOINT, undefined);

  const custom = core.buildDownloadEnv("cache", { PATH: "x" }, { hfMirror: true, hfEndpoint: "https://mirror.invalid" });
  assert.equal(custom.HF_ENDPOINT, "https://mirror.invalid");
});

test("normalizeDownloadTransfer keeps only the transfer fields and never a token", () => {
  const normalized = core.normalizeDownloadTransfer({
    hfMirror: true,
    hfTransfer: 1,
    token: DOWNLOAD_TOKEN,
    hfToken: DOWNLOAD_TOKEN,
    tokenRef: "",
  });
  assert.deepEqual(normalized, { hfMirror: true, hfEndpoint: "https://hf-mirror.com", hfTransfer: true, tokenRef: null, gated: false });
  assert.deepEqual(core.normalizeDownloadTransfer(null), { hfMirror: false, hfEndpoint: null, hfTransfer: false, tokenRef: null, gated: false });
  assert.equal(core.normalizeDownloadTransfer({ hfMirror: true, tokenRef: "dlt_x" }).hfMirror, false);
});

test("no token reaches job meta, logs, the ledger or any file in the test tree", async (t) => {
  const harness = buildHarness(t);
  harness.tokens.set("dlt_secret", DOWNLOAD_TOKEN);
  const job = enqueue(harness, "org/secret", {
    hfMirror: false,
    hfTransfer: false,
    tokenRef: "dlt_secret",
    gated: true,
    token: DOWNLOAD_TOKEN, // a caller mistake: normalisation drops it
  });
  fail(harness, job);
  harness.controller.drainDownloadQueue();
  harness.controller.resumeDownloadJob(job);
  fail(harness, job);
  harness.controller.drainDownloadQueue();
  await harness.store.saveJobsLedgerNow();

  assert.equal(JSON.stringify(job.meta).includes(DOWNLOAD_TOKEN), false);
  assert.equal(JSON.stringify(job.logs).includes(DOWNLOAD_TOKEN), false);
  const ledger = fs.readFileSync(path.join(harness.dir, "jobs-ledger.json"), "utf8");
  assert.ok(ledger.includes("dlt_secret"), "the ledger keeps the reference");
  for (const file of listFilesRecursive(harness.dir)) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(DOWNLOAD_TOKEN), false, `${path.basename(file)} holds no token`);
  }
});

test("download tokens are released on success, cancel and partial removal", async (t) => {
  const harness = buildHarness(t, { removePartialPath: async () => {}, resolvePartialPath: (value) => value });
  for (const ref of ["dlt_ok", "dlt_cancel", "dlt_remove", "dlt_paused"]) harness.tokens.set(ref, DOWNLOAD_TOKEN);

  const ok = enqueue(harness, "org/ok", { tokenRef: "dlt_ok", gated: true });
  core.markJobSuccess(ok);
  harness.controller.drainDownloadQueue();
  harness.controller.drainDownloadQueue();
  assert.deepEqual(harness.released, ["dlt_ok"], "released once after success");

  const cancelled = enqueue(harness, "org/cancel", { tokenRef: "dlt_cancel", gated: true });
  fail(harness, cancelled);
  await harness.controller.cancelDownloadJob(cancelled);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(harness.released.includes("dlt_cancel"));

  const removed = enqueue(harness, "org/remove", { tokenRef: "dlt_remove", gated: true });
  fail(harness, removed);
  await harness.controller.deletePartialDownload(removed);
  assert.ok(harness.released.includes("dlt_remove"));

  // A paused or failed job keeps its token so it can still be resumed.
  const paused = enqueue(harness, "org/paused", { tokenRef: "dlt_paused", gated: true });
  harness.controller.pauseDownloadJobAfterStop(paused);
  harness.controller.drainDownloadQueue();
  assert.equal(harness.tokens.get("dlt_paused"), DOWNLOAD_TOKEN);
  assert.equal(harness.released.includes("dlt_paused"), false);
});
