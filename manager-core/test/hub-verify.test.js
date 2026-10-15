"use strict";

// Verification pipeline and hash worker (docs/overhaul/03-hub.md §7.3, §7.4,
// HUB-6): sha256 in a worker thread, only bad files deleted, skip-if-verified,
// the worker heartbeat watchdog under a fake clock, `transfer_empty`, and marker
// v2 read back by `prepareDownload`. Temp directories only; the 1 GiB file is
// sparse and never leaves the temp dir.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const test = require("node:test");
const { Worker } = require("node:worker_threads");

const { verifyArtifact, createArtifactVerifier, writeDownloadMarker, MARKER_FILE } = require("../model-hub/verify");
const { hashFileWithProgress } = require("../model-hub/hash-worker");
const { createModelStorage } = require("../model-storage");
const { createModelFilesystemStore } = require("../model-filesystem-store");

const MIN = 60_000;

function tempDir(t, prefix = "hub-verify-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createClock(start = 1_800_000_000_000) {
  return {
    t: start,
    now() {
      return this.t;
    },
    advance(ms) {
      this.t += ms;
    },
  };
}

/** A job over real files in a temp dir. `files`: { name: Buffer|string }. */
function makeJob(t, files, { roles = {}, extra = {} } = {}) {
  const localDir = path.join(tempDir(t), "acme-demo");
  fs.mkdirSync(localDir, { recursive: true });
  const manifest = [];
  for (const [name, content] of Object.entries(files)) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const target = path.join(localDir, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    const role = roles[name] || (name.endsWith(".safetensors") || name.endsWith(".gguf") ? "weight" : "sidecar");
    manifest.push(role === "weight"
      ? { path: name, size: buffer.length, sha256: sha256(buffer), role }
      : { path: name, size: buffer.length, sha256: null, gitOid: "c".repeat(40), role });
  }
  return {
    id: "dl_verify0000000001",
    state: "verifying",
    artifact: {
      provider: "huggingface",
      repo: "acme/demo",
      revision: "main",
      revisionSha: "d".repeat(40),
      artifactKey: "gguf:|Q4_K_M",
      quant: "Q4_K_M",
      files: manifest,
      totalBytes: manifest.reduce((sum, file) => sum + file.size, 0),
    },
    target: { localDir },
    transfer: { engine: "cli", cli: "hf", options: { source: "huggingface", xet: "default", credentialMode: "none" } },
    progress: { files: manifest.map((file) => ({ path: file.path, bytes: file.size, size: file.size, state: "done" })) },
    retry: { count: 0, max: 2, history: [] },
    ...extra,
  };
}

function exists(job, name) {
  return fs.existsSync(path.join(job.target.localDir, ...name.split("/")));
}

const okStore = { verifyDownloadedModel: async () => ({ ok: true, status: "ok", issues: [] }) };

function fakeWorkerFactory(scripts) {
  const workers = [];
  const createWorker = (data) => {
    const worker = new EventEmitter();
    worker.data = data;
    worker.terminated = false;
    worker.terminate = async () => {
      worker.terminated = true;
    };
    workers.push(worker);
    const script = scripts[workers.length - 1];
    if (script) setImmediate(() => script(worker));
    return worker;
  };
  return { workers, createWorker };
}

function fakeTimers() {
  const checks = [];
  return {
    checks,
    setInterval(fn) {
      checks.push(fn);
      return { unref() {} };
    },
    clearInterval() {},
  };
}

// Waits on wall-clock time, not on a count of event-loop turns: the code under
// test does real file I/O before it reaches the point being awaited, and a loaded
// machine can take far longer than any fixed number of turns for that.
async function until(condition, label = "condition", timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function answerAll(worker, status = "ok") {
  for (const entry of worker.data.manifest) worker.emit("message", { type: "file", name: entry.name, status, bytes: entry.size });
  worker.emit("message", { type: "done", result: { mismatched: [] } });
}

test("hashes in the worker thread, verifies the structure and writes marker v2", async (t) => {
  const job = makeJob(t, {
    "model-Q4_K_M.gguf": crypto.randomBytes(300_000),
    "mmproj-F16.gguf": crypto.randomBytes(40_000),
    "README.md": "hello",
  });
  const progress = [];
  const result = await verifyArtifact(job, { fsStore: okStore, settings: {}, onProgress: (p) => progress.push(p) });

  assert.equal(result.ok, true, JSON.stringify(result.failure));
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.failure, null);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.verifiedFiles.map((file) => [file.path, file.sha256 !== null]), [
    ["model-Q4_K_M.gguf", true],
    ["mmproj-F16.gguf", true],
    ["README.md", false],
  ]);
  assert.ok(progress.length >= 3);
  assert.deepEqual(progress.at(-1).filesDone, 2);
  assert.deepEqual(job.progress.verify, { filesDone: 2, filesTotal: 2, bytesDone: 340_000 });
  const states = Object.fromEntries(job.progress.files.map((file) => [file.path, file.state]));
  assert.deepEqual(states, { "model-Q4_K_M.gguf": "verified", "mmproj-F16.gguf": "verified", "README.md": "done" });

  const marker = JSON.parse(fs.readFileSync(path.join(job.target.localDir, MARKER_FILE), "utf8"));
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.model, "acme/demo");
  assert.equal(marker.source, "huggingface");
  assert.equal(marker.precision, "Q4_K_M");
  assert.equal(marker.provider, "huggingface");
  assert.equal(marker.transport, "huggingface");
  assert.equal(marker.revision, "main");
  assert.equal(marker.revisionSha, "d".repeat(40));
  assert.equal(marker.artifactKey, "gguf:|Q4_K_M");
  assert.equal(marker.jobId, job.id);
  assert.match(marker.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(marker.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(marker.files.find((file) => file.path === "README.md"), { path: "README.md", size: 5, gitOid: "c".repeat(40), sha256: null });
  assert.match(marker.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.marker, path.join(job.target.localDir, MARKER_FILE));
});

test("marker v2 is readable by prepareDownload and keeps the v1 fields it compares", async (t) => {
  const root = tempDir(t);
  const modelsRoot = path.join(root, "models");
  const storage = createModelStorage({ modelsRoot, file: path.join(root, "data", "model-storage.json") });
  fs.mkdirSync(modelsRoot, { recursive: true });
  const localDir = path.join(modelsRoot, "acme-demo");
  const metadata = { model: "acme/demo", source: "huggingface", precision: "Q4_K_M" };
  storage.prepareDownload(localDir, metadata);
  const v1 = JSON.parse(fs.readFileSync(path.join(localDir, MARKER_FILE), "utf8"));
  assert.equal(v1.schemaVersion, undefined);

  fs.writeFileSync(path.join(localDir, "model.gguf"), "weights");
  const job = {
    id: "dl_marker00000000001",
    artifact: { provider: "huggingface", repo: "acme/demo", quant: "Q4_K_M", revision: "main", revisionSha: "e".repeat(40), artifactKey: "gguf:|Q4_K_M", files: [] },
    target: { localDir },
    transfer: { options: { source: "hf-mirror" } },
  };
  await writeDownloadMarker(job, { files: [{ path: "model.gguf", size: 7, sha256: sha256(Buffer.from("weights")) }] });
  const v2 = JSON.parse(fs.readFileSync(path.join(localDir, MARKER_FILE), "utf8"));
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.createdAt, v1.createdAt, "createdAt of the v1 marker is kept");
  assert.equal(v2.source, "huggingface", "the v1 `source` is kept verbatim");
  assert.equal(v2.transport, "hf-mirror");
  assert.equal(v2.provider, "huggingface");

  // The directory now has files; the same download identity is accepted, a different one is not.
  assert.doesNotThrow(() => storage.prepareDownload(localDir, metadata));
  assert.throws(() => storage.prepareDownload(localDir, { ...metadata, precision: "Q8_0" }), /已有其他文件/);
});

test("only the bad files are deleted; the failure is checksum_mismatch and repeats are not retried", async (t) => {
  const good = crypto.randomBytes(50_000);
  const job = makeJob(t, { "a.safetensors": good, "b.safetensors": crypto.randomBytes(50_000), "c.safetensors": crypto.randomBytes(50_000) });
  // Same size, different content.
  fs.writeFileSync(path.join(job.target.localDir, "b.safetensors"), crypto.randomBytes(50_000));

  const result = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched.map((item) => [item.path, item.reason]), [["b.safetensors", "sha256"]]);
  assert.deepEqual(result.badFiles, ["b.safetensors"]);
  assert.equal(result.failure.code, "checksum_mismatch");
  assert.equal(result.failure.retryable, true);
  assert.equal(result.marker, null);
  assert.equal(exists(job, "a.safetensors"), true);
  assert.equal(exists(job, "b.safetensors"), false);
  assert.equal(exists(job, "c.safetensors"), true);
  assert.equal(fs.existsSync(path.join(job.target.localDir, MARKER_FILE)), false, "no marker for a failed verification");
  assert.equal(job.progress.files.find((file) => file.path === "b.safetensors").state, "bad");
  assert.equal(job.progress.files.find((file) => file.path === "a.safetensors").state, "verified");

  // The queue stores badFiles in job.retry; the same file failing twice stops the retries.
  job.retry.badFiles = result.badFiles;
  fs.writeFileSync(path.join(job.target.localDir, "b.safetensors"), crypto.randomBytes(50_000));
  const again = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(again.failure.code, "checksum_mismatch");
  assert.equal(again.failure.retryable, false);
  assert.equal(again.skipped, 2, "the two good files were verified before and are not hashed again");
  assert.equal(exists(job, "a.safetensors"), true);
  assert.equal(exists(job, "c.safetensors"), true);
});

test("a truncated file is deleted and reported as verify_failed", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(20_000), "b.safetensors": crypto.randomBytes(20_000) });
  fs.truncateSync(path.join(job.target.localDir, "b.safetensors"), 9000);
  const result = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "verify_failed");
  assert.deepEqual(result.mismatched.map((item) => [item.path, item.reason, item.expected, item.actual]), [["b.safetensors", "size", 20_000, 9000]]);
  assert.equal(exists(job, "a.safetensors"), true);
  assert.equal(exists(job, "b.safetensors"), false);
});

test("files verified earlier with the same size and mtime are skipped; a changed mtime is hashed again", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(30_000), "b.safetensors": crypto.randomBytes(30_000) });
  const first = await verifyArtifact(job, { fsStore: okStore, settings: {}, writeMarker: false });
  assert.equal(first.ok, true);

  const spy = fakeWorkerFactory([]);
  const second = await verifyArtifact(job, { fsStore: okStore, settings: {}, createWorker: spy.createWorker, writeMarker: false });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, 2);
  assert.equal(spy.workers.length, 0, "nothing left to hash, so no worker is started");
  assert.ok(second.verifiedFiles.every((file) => file.sha256), "skipped files still carry their sha256 into the marker");

  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(job.target.localDir, "b.safetensors"), later, later);
  const hashing = fakeWorkerFactory([answerAll]);
  const third = await verifyArtifact(job, { fsStore: okStore, settings: {}, createWorker: hashing.createWorker, writeMarker: false });
  assert.equal(third.ok, true);
  assert.equal(third.skipped, 1);
  assert.deepEqual(hashing.workers[0].data.manifest.map((entry) => entry.name), ["b.safetensors"]);
});

test("verify.sha256 = false skips hashing but still checks sizes and structure", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(10_000) });
  fs.writeFileSync(path.join(job.target.localDir, "a.safetensors"), crypto.randomBytes(10_000));
  const spy = fakeWorkerFactory([]);
  const result = await verifyArtifact(job, { fsStore: okStore, settings: { verify: { sha256: false } }, createWorker: spy.createWorker });
  assert.equal(result.ok, true);
  assert.equal(spy.workers.length, 0);
  assert.equal(result.verifiedFiles[0].sha256, null, "an unchecked hash is not claimed in the marker");
});

test("heartbeat silence terminates the worker, retries the unfinished files once, then verify_failed", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(10_000), "b.safetensors": crypto.randomBytes(10_000) });
  const clock = createClock();
  const timers = fakeTimers();
  const { workers, createWorker } = fakeWorkerFactory([
    // First worker: finishes a, then goes silent.
    (worker) => worker.emit("message", { type: "file", name: "a.safetensors", status: "ok", bytes: 10_000 }),
    () => {},
  ]);
  const pending = verifyArtifact(job, { fsStore: okStore, settings: {}, clock, timers, createWorker, writeMarker: false });

  await until(() => workers.length === 1, "first worker");
  await until(() => timers.checks.length === 1, "first watchdog");
  await new Promise((resolve) => setImmediate(resolve)); // the worker's scripted message is delivered
  clock.advance(5 * MIN - 1);
  timers.checks[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1, "4:59 of silence is still fine");
  clock.advance(1);
  timers.checks[0]();

  await until(() => workers.length === 2, "second worker");
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(workers[1].data.manifest.map((entry) => entry.name), ["b.safetensors"], "only the unfinished file is retried");
  await until(() => timers.checks.length === 2, "second watchdog");
  clock.advance(5 * MIN);
  timers.checks[1]();

  const result = await pending;
  assert.equal(workers[1].terminated, true);
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "verify_failed");
  assert.equal(result.failure.retryable, true);
  assert.match(result.failure.detail, /hash worker/);
  assert.equal(exists(job, "a.safetensors"), true, "silence deletes nothing");
  assert.equal(exists(job, "b.safetensors"), true);
  assert.equal(fs.existsSync(path.join(job.target.localDir, MARKER_FILE)), false);
});

test("a worker that recovers on the retry completes the verification", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(10_000) });
  const clock = createClock();
  const timers = fakeTimers();
  const { workers, createWorker } = fakeWorkerFactory([() => {}, answerAll]);
  const pending = verifyArtifact(job, { fsStore: okStore, settings: {}, clock, timers, createWorker });
  await until(() => timers.checks.length === 1, "watchdog");
  clock.advance(5 * MIN);
  timers.checks[0]();
  const result = await pending;
  assert.equal(workers.length, 2);
  assert.equal(result.ok, true, JSON.stringify(result.failure));
  assert.ok(fs.existsSync(path.join(job.target.localDir, MARKER_FILE)));
});

test("any worker message counts as a heartbeat", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(10_000) });
  const clock = createClock();
  const timers = fakeTimers();
  const { workers, createWorker } = fakeWorkerFactory([]);
  const pending = verifyArtifact(job, { fsStore: okStore, settings: {}, clock, timers, createWorker, writeMarker: false });
  await until(() => timers.checks.length === 1, "watchdog");
  for (let i = 0; i < 6; i += 1) {
    clock.advance(4 * MIN);
    workers[0].emit("message", { type: "heartbeat" });
    timers.checks[0]();
  }
  assert.equal(workers.length, 1, "24 minutes in, still the first worker");
  answerAll(workers[0]);
  assert.equal((await pending).ok, true);
});

test("a crashing worker is retried once, then verify_failed", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(10_000) });
  const { workers, createWorker } = fakeWorkerFactory([
    (worker) => worker.emit("error", new Error("boom")),
    (worker) => worker.emit("exit", 1),
  ]);
  const result = await verifyArtifact(job, { fsStore: okStore, settings: {}, timers: fakeTimers(), createWorker });
  assert.equal(workers.length, 2);
  assert.equal(result.failure.code, "verify_failed");
});

test("exit 0 with a selected weight that is empty or missing is transfer_empty, non-retryable, and deletes nothing", async (t) => {
  const job = makeJob(t, { "a.gguf": crypto.randomBytes(5000), "b.gguf": crypto.randomBytes(5000), "README.md": "x" });
  fs.writeFileSync(path.join(job.target.localDir, "b.gguf"), "");
  const result = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "transfer_empty");
  assert.equal(result.failure.baseCode, "filter_no_match");
  assert.equal(result.failure.retryable, false);
  assert.deepEqual(result.empty, ["b.gguf"]);
  assert.equal(exists(job, "a.gguf"), true);
  assert.equal(exists(job, "b.gguf"), true);

  fs.rmSync(path.join(job.target.localDir, "b.gguf"));
  const missing = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(missing.failure.code, "transfer_empty");
  assert.deepEqual(missing.missing, ["b.gguf"]);
  assert.equal(missing.failure.retry.auto, false);
});

test("a missing sidecar is verify_failed, not transfer_empty", async (t) => {
  const job = makeJob(t, { "a.gguf": crypto.randomBytes(2000), "README.md": "x" });
  fs.rmSync(path.join(job.target.localDir, "README.md"));
  const result = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(result.failure.code, "verify_failed");
  assert.deepEqual(result.missing, ["README.md"]);
});

test(".incomplete fragments of selected files after exit 0 are verify_failed", async (t) => {
  const job = makeJob(t, { "a.gguf": crypto.randomBytes(2000) });
  const cache = path.join(job.target.localDir, ".cache", "huggingface", "download");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "a.gguf.0f0f.incomplete"), "partial");
  fs.writeFileSync(path.join(cache, "unrelated.bin.1111.incomplete"), "partial");
  const result = await verifyArtifact(job, { fsStore: okStore, settings: {} });
  assert.equal(result.failure.code, "verify_failed");
  assert.match(result.failure.detail, /a\.gguf/);
  assert.doesNotMatch(result.failure.detail, /unrelated/);

  fs.rmSync(path.join(cache, "a.gguf.0f0f.incomplete"));
  const clean = await verifyArtifact(job, { fsStore: okStore, settings: {}, writeMarker: false });
  assert.equal(clean.ok, true, "fragments of files outside the selection do not fail the download");
});

test("a failing structure check is verify_failed; the shared store is called with strictIncomplete", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(2000) });
  const calls = [];
  const store = {
    verifyDownloadedModel: async (input, options) => {
      calls.push([input, options]);
      return { ok: false, status: "fail", issues: [{ severity: "fail", title: "缺少模型配置", detail: "no config.json" }] };
    },
  };
  const result = await verifyArtifact(job, { fsStore: store, settings: {} });
  assert.equal(result.failure.code, "verify_failed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { strictIncomplete: true });
  assert.equal(calls[0][0].localDir, path.resolve(job.target.localDir));
  assert.equal(exists(job, "a.safetensors"), true, "a structure failure deletes nothing");

  const throwing = await verifyArtifact(job, { fsStore: { verifyDownloadedModel: async () => { throw new Error("path outside the library"); } }, settings: {} });
  assert.equal(throwing.failure.code, "verify_failed");
});

test("the real filesystem store rejects a garbage safetensors file and accepts a plausible GGUF", async (t) => {
  const root = tempDir(t);
  const modelsRoot = path.join(root, "models");
  const store = createModelFilesystemStore({ modelsRoot, hfCache: path.join(root, "hf") });

  const bad = makeJob(t, { "config.json": "{}", "model.safetensors": Buffer.from("not a safetensors header at all") });
  bad.target.localDir = path.join(modelsRoot, "bad");
  fs.mkdirSync(bad.target.localDir, { recursive: true });
  for (const name of ["config.json", "model.safetensors"]) fs.writeFileSync(path.join(bad.target.localDir, name), name === "config.json" ? "{}" : "not a safetensors header at all");
  const failed = await verifyArtifact(bad, { fsStore: store, settings: { verify: { sha256: false } } });
  assert.equal(failed.failure.code, "verify_failed", JSON.stringify(failed.failure));

  const header = Buffer.alloc(64);
  header.write("GGUF", 0, "latin1");
  header.writeUInt32LE(3, 4);
  const good = makeJob(t, { "m.gguf": header });
  good.target.localDir = path.join(modelsRoot, "good");
  fs.mkdirSync(good.target.localDir, { recursive: true });
  fs.writeFileSync(path.join(good.target.localDir, "m.gguf"), header);
  const passed = await verifyArtifact(good, { fsStore: store, settings: {} });
  assert.equal(passed.ok, true, JSON.stringify(passed.failure));
});

test("an aborted verification rejects with AbortError and leaves the files alone", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(2000) });
  const controller = new AbortController();
  const { workers, createWorker } = fakeWorkerFactory([]);
  const pending = verifyArtifact(job, { fsStore: okStore, settings: {}, timers: fakeTimers(), createWorker, signal: controller.signal });
  await until(() => workers.length === 1, "worker");
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(workers[0].terminated, true);
  assert.equal(exists(job, "a.safetensors"), true);

  controller.abort();
  await assert.rejects(verifyArtifact(job, { fsStore: okStore, settings: {}, signal: controller.signal }), { name: "AbortError" });
});

test("createArtifactVerifier binds shared dependencies", async (t) => {
  const job = makeJob(t, { "a.safetensors": crypto.randomBytes(2000) });
  const verifier = createArtifactVerifier({ fsStore: okStore, settings: {} });
  const result = await verifier.verifyArtifact(job);
  assert.equal(result.ok, true);
  const written = await verifier.writeMarker(job, { files: result.verifiedFiles });
  assert.equal(JSON.parse(fs.readFileSync(written.path, "utf8")).schemaVersion, 2);
});

test("hashFileWithProgress reports every progress interval and matches sha256", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "blob.bin");
  const content = crypto.randomBytes(1_000_000);
  fs.writeFileSync(file, content);
  const seen = [];
  const digest = await hashFileWithProgress(file, { chunkBytes: 64 * 1024, progressBytes: 300_000, onProgress: (bytes) => seen.push(bytes) });
  assert.equal(digest, sha256(content));
  assert.equal(seen.length, 3);
  assert.ok(seen.every((bytes, index) => index === 0 || bytes > seen[index - 1]));
});

test("hashing 1 GiB in the worker keeps main-thread event-loop delay under 50 ms (or a small multiple of the idle delay on a loaded machine)", { timeout: 180_000 }, async (t) => {
  const GIB = 1024 * 1024 * 1024;
  const dir = tempDir(t);
  const localDir = path.join(dir, "big");
  fs.mkdirSync(localDir);
  const file = path.join(localDir, "big.safetensors");
  // A sparse file reads back as zeros, so the digest is known without hashing it here.
  const handle = fs.openSync(file, "w");
  fs.ftruncateSync(handle, GIB);
  fs.closeSync(handle);
  const zeroHash = crypto.createHash("sha256");
  const zeroChunk = Buffer.alloc(8 * 1024 * 1024);
  for (let written = 0; written < GIB; written += zeroChunk.length) zeroHash.update(zeroChunk);
  const zeroDigest = zeroHash.digest("hex");
  const job = {
    id: "dl_big000000000001",
    artifact: { provider: "huggingface", repo: "acme/big", files: [{ path: "big.safetensors", size: GIB, sha256: zeroDigest, role: "weight" }], totalBytes: GIB },
    target: { localDir },
    transfer: { options: { source: "huggingface" } },
    progress: null,
  };

  // The default worker, wrapped so the test can see where the hashing ran.
  const hashWorkerPath = path.join(__dirname, "..", "model-hub", "hash-worker.js");
  const spawned = [];
  const createWorker = (data) => {
    const worker = new Worker(hashWorkerPath, { workerData: data });
    spawned.push({ worker, threadId: worker.threadId });
    return worker;
  };

  // Correctness: the 1 GiB digest is computed on a worker thread, never on the
  // main thread. This does not depend on timing at all.
  // Latency: hashing inline would stall the loop for about the whole hash time
  // (~600 ms unloaded). Scheduler noise on a busy machine is of a different
  // size, so the bound is relative: the larger of 50 ms and a multiple of the
  // delay an idle loop shows right now, and always far below the hash time.
  // A one-off hiccup gets two more measurements.
  async function maxLoopDelayMs(run) {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    try {
      await run();
    } finally {
      histogram.disable();
    }
    return histogram.max / 1e6;
  }

  let verdict = null;
  for (let attempt = 1; attempt <= 3 && !verdict?.within; attempt += 1) {
    const idleMs = await maxLoopDelayMs(() => new Promise((resolve) => setTimeout(resolve, 300)));
    spawned.length = 0;
    const startedAt = Date.now();
    let result = null;
    const hashingMs = await maxLoopDelayMs(async () => {
      result = await verifyArtifact(job, { fsStore: okStore, settings: {}, writeMarker: false, createWorker });
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.ok, true, JSON.stringify(result.failure));
    assert.ok(spawned.length >= 1, "the digest must be computed by a worker");
    assert.ok(spawned.every((entry) => entry.threadId > 0), "hash workers run on their own thread, not the main thread");
    const budgetMs = Math.max(50, idleMs * 4 + 25);
    const stallCeilingMs = elapsedMs * 0.4;
    verdict = { attempt, idleMs, hashingMs, elapsedMs, budgetMs, stallCeilingMs, within: hashingMs < budgetMs && hashingMs < stallCeilingMs };
    t.diagnostic(`attempt ${attempt}: 1 GiB verified in ${elapsedMs} ms, max event-loop delay ${hashingMs.toFixed(1)} ms (idle ${idleMs.toFixed(1)} ms, budget ${budgetMs.toFixed(1)} ms)`);
    job.progress = null;
  }
  assert.ok(verdict.within, `event loop delayed ${verdict.hashingMs.toFixed(1)} ms while hashing for ${verdict.elapsedMs} ms (idle ${verdict.idleMs.toFixed(1)} ms, budget ${verdict.budgetMs.toFixed(1)} ms)`);
});
