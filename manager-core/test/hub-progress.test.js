"use strict";

// Progress monitor and phase-aware watchdog (docs/overhaul/03-hub.md §7.2,
// §7.3, HUB-6). Everything runs on a fake clock and a fake file system; no
// timer is real and no file is touched.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createTransferMonitor, listIncompleteFiles } = require("../model-hub/progress");
const { classifyTransferFailure } = require("../model-hub/errors");

const MIN = 60_000;
const LOCAL_DIR = path.resolve(path.sep, "models", "demo-model");
const HF_HOME = path.resolve(path.sep, "hf-home");
const DOWNLOAD_CACHE = path.join(LOCAL_DIR, ".cache", "huggingface", "download");

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

function createFakeFs() {
  const files = new Map();
  const norm = (p) => path.resolve(p);
  const fake = {
    files,
    set(p, size, mtimeMs = 1000) {
      files.set(norm(p), { size, mtimeMs });
    },
    remove(p) {
      files.delete(norm(p));
    },
    async stat(p) {
      const entry = files.get(norm(p));
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: entry.size, mtimeMs: entry.mtimeMs, isFile: () => true };
    },
    async readdir(dir) {
      const prefix = norm(dir) + path.sep;
      const names = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split(path.sep)[0]);
      }
      if (!names.size) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...names];
    },
  };
  return fake;
}

function makeJob(overrides = {}) {
  return {
    id: "dl_test0000000000aa",
    state: "downloading",
    artifact: {
      provider: "huggingface",
      repo: "acme/demo-model",
      files: [
        { path: "model-00001.safetensors", size: 1000, sha256: "a".repeat(64), role: "weight" },
        { path: "sub/model-00002.safetensors", size: 3000, sha256: "b".repeat(64), role: "weight" },
        { path: "config.json", size: 100, role: "sidecar" },
      ],
      totalBytes: 4100,
    },
    target: { localDir: LOCAL_DIR },
    transfer: { engine: "cli", cli: "hf", options: { source: "huggingface", xet: "high-performance", credentialMode: "none" } },
    progress: null,
    ...overrides,
  };
}

function setup(t, { job = makeJob(), settings = {}, hfHome = "", measureDir } = {}) {
  const clock = createClock();
  const fs = createFakeFs();
  const stalls = [];
  const updates = [];
  const logs = [];
  const monitor = createTransferMonitor(job, {
    fs,
    clock,
    hfHome,
    settings,
    measureDir,
    onStall: (info) => stalls.push(info),
    onUpdate: (progress, info) => updates.push({ progress, info }),
    onLog: (line) => logs.push(line),
  });
  t.after(() => monitor.stop());
  return { job, clock, fs, monitor, stalls, updates, logs };
}

test("per-file bytes come from final files and .incomplete fragments", async (t) => {
  const { job, fs, monitor, clock } = setup(t);
  fs.set(path.join(LOCAL_DIR, "model-00001.safetensors"), 1000);
  fs.set(path.join(DOWNLOAD_CACHE, "sub", "model-00002.safetensors.0123abcd.incomplete"), 1200);
  fs.set(path.join(DOWNLOAD_CACHE, "sub", "model-00002.safetensors.metadata"), 120);
  await monitor.tick();
  clock.advance(2000);
  fs.set(path.join(DOWNLOAD_CACHE, "sub", "model-00002.safetensors.0123abcd.incomplete"), 2200);
  const progress = await monitor.tick();

  assert.equal(progress.bytesDone, 3200);
  assert.equal(progress.bytesTotal, 4100);
  assert.equal(progress.filesDone, 1);
  assert.equal(progress.filesTotal, 3);
  assert.deepEqual(
    progress.files.map((file) => [file.path, file.bytes, file.size, file.state]),
    [
      ["model-00001.safetensors", 1000, 1000, "done"],
      ["sub/model-00002.safetensors", 2200, 3000, "partial"],
      ["config.json", 0, 100, "pending"],
    ],
  );
  assert.equal(progress.speedBps, 500, "1000 bytes in 2 s");
  assert.ok(progress.etaSeconds > 0);
  assert.equal(progress.percent, 78);
  assert.equal(progress.samples.length, 2);
  assert.equal(job.progress, progress, "the monitor updates job.progress in place of the job");
});

test("percent is capped at 99 until the job is ready", async (t) => {
  const { job, fs, monitor } = setup(t);
  fs.set(path.join(LOCAL_DIR, "model-00001.safetensors"), 1000);
  fs.set(path.join(LOCAL_DIR, "sub", "model-00002.safetensors"), 3000);
  fs.set(path.join(LOCAL_DIR, "config.json"), 100);
  const progress = await monitor.tick();
  assert.equal(progress.bytesDone, 4100);
  assert.equal(progress.percent, 99);
  assert.equal(progress.filesDone, 3);
  job.state = "ready";
  assert.equal((await monitor.tick()).percent, 100);
});

test("a stat error on one tick does not lose the previous progress", async (t) => {
  const { fs, monitor, clock, updates } = setup(t);
  fs.set(path.join(LOCAL_DIR, "model-00001.safetensors"), 500);
  await monitor.tick();
  const original = fs.stat;
  fs.stat = async () => {
    throw new Error("EIO");
  };
  clock.advance(5000);
  const progress = await monitor.tick();
  assert.ok(progress, "tick resolves");
  fs.stat = original;
  assert.equal(updates.length, 2);
});

test("incomplete listing reports fragments of the selected files only", async () => {
  const fs = createFakeFs();
  fs.set(path.join(DOWNLOAD_CACHE, "a.gguf.1234.incomplete"), 10);
  fs.set(path.join(DOWNLOAD_CACHE, "other.gguf.5678.incomplete"), 99);
  const found = await listIncompleteFiles({ fs, localDir: LOCAL_DIR, paths: ["a.gguf", "b.gguf"] });
  assert.deepEqual(found, [{ path: "a.gguf", bytes: 10 }]);
});

test("Xet growth then a flat cache moves downloading to materializing; exit 0 moves to verifying", async (t) => {
  let xetSize = 0;
  const { clock, fs, monitor, stalls } = setup(t, { hfHome: HF_HOME, measureDir: async () => xetSize });
  assert.equal(monitor.phase(), "downloading");
  await monitor.tick();

  clock.advance(30_000);
  xetSize = 5_000_000;
  await monitor.tick();
  assert.equal(monitor.phase(), "downloading", "the cache is still growing");

  clock.advance(30_000);
  await monitor.tick();
  assert.equal(monitor.phase(), "downloading", "one flat sample is not enough");

  clock.advance(30_000);
  await monitor.tick();
  assert.equal(monitor.phase(), "materializing");

  // Files grow on disk while the cache stays flat: still materializing.
  clock.advance(5000);
  fs.set(path.join(DOWNLOAD_CACHE, "model-00001.safetensors.ff00.incomplete"), 400);
  await monitor.tick();
  assert.equal(monitor.phase(), "materializing");

  // New chunks arriving means it was still downloading.
  clock.advance(30_000);
  xetSize = 9_000_000;
  await monitor.tick();
  assert.equal(monitor.phase(), "downloading");

  await monitor.noteExit({ code: 0 });
  assert.equal(monitor.phase(), "verifying");
  assert.equal(stalls.length, 0);
});

test("a non-zero exit keeps the phase and stops the watchdog", async (t) => {
  const { clock, monitor, stalls } = setup(t);
  await monitor.tick();
  await monitor.noteExit({ code: 1 });
  assert.equal(monitor.phase(), "downloading");
  clock.advance(30 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 0);
});

test("xet: off and ModelScope never infer materializing", async (t) => {
  for (const patch of [{ xet: "off" }, { source: "modelscope" }]) {
    let size = 0;
    const job = makeJob();
    job.transfer.options = { ...job.transfer.options, ...patch };
    const { clock, monitor } = setup(t, { job, hfHome: HF_HOME, measureDir: async () => size });
    await monitor.tick();
    clock.advance(30_000);
    size = 100;
    await monitor.tick();
    for (let i = 0; i < 4; i += 1) {
      clock.advance(30_000);
      await monitor.tick();
    }
    assert.equal(monitor.phase(), "downloading", JSON.stringify(patch));
  }
});

test("downloading: no stall before stallMinutes (10), `stall` at 10", async (t) => {
  const { clock, monitor, stalls } = setup(t);
  await monitor.tick();
  clock.advance(10 * MIN - 1000);
  await monitor.tick();
  assert.equal(stalls.length, 0);
  clock.advance(1000);
  await monitor.tick();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].phase, "downloading");
  assert.equal(stalls[0].code, "stall");
  assert.equal(stalls[0].thresholdMs, 10 * MIN);
  const failure = classifyTransferFailure({ exitCode: null, stderrTail: [], phase: "downloading", job: makeJob(), signals: stalls[0].signals });
  assert.equal(failure.code, "stall");
  assert.equal(failure.retryable, true);

  clock.advance(10 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 1, "the stall is reported once per monitor");
});

test("local bytes and CLI output reset the downloading watchdog", async (t) => {
  const { clock, fs, monitor, stalls } = setup(t);
  await monitor.tick();

  clock.advance(9 * MIN);
  fs.set(path.join(DOWNLOAD_CACHE, "model-00001.safetensors.aa.incomplete"), 10);
  await monitor.tick();
  clock.advance(9 * MIN);
  monitor.noteLine("stderr", "Fetching 3 files");
  await monitor.tick();
  clock.advance(9 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 0);

  clock.advance(MIN + 1);
  await monitor.tick();
  assert.equal(stalls.length, 1);
});

test("Xet cache growth resets the downloading watchdog", async (t) => {
  let xetSize = 0;
  const { clock, monitor, stalls } = setup(t, { hfHome: HF_HOME, measureDir: async () => xetSize });
  await monitor.tick();
  clock.advance(9 * MIN);
  xetSize = 1;
  await monitor.tick();
  clock.advance(9 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 0, "18 minutes since the start, 9 since the last Xet growth");
});

test("the stall thresholds follow the settings", async (t) => {
  const { clock, monitor, stalls } = setup(t, { settings: { transfer: { stallMinutes: 2 } } });
  await monitor.tick();
  clock.advance(2 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 1);

  const dotted = setup(t, { settings: () => ({ "transfer.stallMinutes": 3 }) });
  await dotted.monitor.tick();
  dotted.clock.advance(3 * MIN - 1);
  await dotted.monitor.tick();
  assert.equal(dotted.stalls.length, 0);
  dotted.clock.advance(1);
  await dotted.monitor.tick();
  assert.equal(dotted.stalls.length, 1);
});

test("materializing: no kill before materializeStallMinutes (20), `stall` at 20", async (t) => {
  let xetSize = 0;
  const { clock, monitor, stalls } = setup(t, { hfHome: HF_HOME, measureDir: async () => xetSize });
  await monitor.tick();
  clock.advance(30_000);
  xetSize = 10;
  await monitor.tick();
  clock.advance(30_000);
  await monitor.tick();
  clock.advance(30_000);
  await monitor.tick();
  assert.equal(monitor.phase(), "materializing");

  // 10 minutes of silence would kill a download but not a materialization.
  clock.advance(10 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 0);
  clock.advance(10 * MIN - 1000);
  await monitor.tick();
  assert.equal(stalls.length, 0, "just under 20 minutes since materializing began");
  clock.advance(1000);
  await monitor.tick();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].phase, "materializing");
  assert.equal(stalls[0].thresholdMs, 20 * MIN);
  assert.equal(stalls[0].code, "stall");
});

test("local growth keeps a materializing job alive", async (t) => {
  let xetSize = 0;
  const { clock, fs, monitor, stalls } = setup(t, { hfHome: HF_HOME, measureDir: async () => xetSize });
  await monitor.tick();
  clock.advance(30_000);
  xetSize = 10;
  await monitor.tick();
  clock.advance(30_000);
  await monitor.tick();
  clock.advance(30_000);
  await monitor.tick();
  assert.equal(monitor.phase(), "materializing");
  for (let i = 1; i <= 5; i += 1) {
    clock.advance(15 * MIN);
    fs.set(path.join(DOWNLOAD_CACHE, "sub", `model-00002.safetensors.cd.incomplete`), i * 100);
    await monitor.tick();
  }
  assert.equal(stalls.length, 0);
});

test("resolving: an HTTP step longer than 60 s aborts as network_timeout", async (t) => {
  const job = makeJob({ state: "resolving" });
  const { clock, monitor, stalls } = setup(t, { job });
  assert.equal(monitor.phase(), "resolving");
  monitor.beginStep("manifest");
  clock.advance(60_000);
  await monitor.tick();
  assert.equal(stalls.length, 0);
  clock.advance(1);
  await monitor.tick();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].phase, "resolving");
  assert.equal(stalls[0].code, "network_timeout");
  const failure = classifyTransferFailure({ exitCode: null, stderrTail: [], phase: "resolving", job, signals: stalls[0].signals });
  assert.equal(failure.code, "network_timeout");
  assert.equal(failure.baseCode, "network_unreachable");
});

test("resolving: finished steps never time out and idle resolving is not a stall", async (t) => {
  const { clock, monitor, stalls } = setup(t, { job: makeJob({ state: "resolving" }) });
  monitor.beginStep("access");
  clock.advance(30_000);
  monitor.endStep();
  clock.advance(10 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 0);
});

test("verifying is not watched here (the hash worker heartbeat is, in verify.js)", async (t) => {
  const { clock, monitor, stalls } = setup(t);
  monitor.setPhase("verifying");
  assert.equal(monitor.phase(), "verifying");
  await monitor.tick();
  clock.advance(60 * MIN);
  await monitor.tick();
  assert.equal(stalls.length, 0);
});

test("verified and bad marks survive ticks until the file changes", async (t) => {
  const { fs, monitor } = setup(t);
  const target = path.join(LOCAL_DIR, "model-00001.safetensors");
  fs.set(target, 1000, 5555);
  monitor.markFile("model-00001.safetensors", "verified", { size: 1000, mtimeMs: 5555, sha256: "a".repeat(64) });
  let progress = await monitor.tick();
  assert.equal(progress.files[0].state, "verified");
  assert.equal(progress.files[0].mtimeMs, 5555);
  assert.equal(progress.files[0].sha256, "a".repeat(64));
  assert.equal(progress.filesDone, 1);

  fs.set(target, 1000, 6000);
  progress = await monitor.tick();
  assert.equal(progress.files[0].state, "done", "a changed mtime drops the verified mark");

  fs.remove(target);
  monitor.markFile("model-00001.safetensors", "bad", { size: 999, mtimeMs: 0 });
  progress = await monitor.tick();
  assert.equal(progress.files[0].state, "bad");
  fs.set(path.join(DOWNLOAD_CACHE, "model-00001.safetensors.ee.incomplete"), 1);
  progress = await monitor.tick();
  assert.equal(progress.files[0].state, "partial", "a new fragment means the file is being fetched again");

  assert.throws(() => monitor.markFile("x", "weird"), /Unknown file state/);
});

test("a new monitor picks up verified entries already on the job", async (t) => {
  const job = makeJob();
  const { fs } = setup(t, { job });
  const target = path.join(LOCAL_DIR, "model-00001.safetensors");
  fs.set(target, 1000, 4242);
  job.progress = { files: [{ path: "model-00001.safetensors", bytes: 1000, size: 1000, state: "verified", mtimeMs: 4242 }] };
  const next = createTransferMonitor(job, { fs, clock: createClock(), settings: {} });
  const progress = await next.tick();
  assert.equal(progress.files[0].state, "verified");
});

test("the tick timer runs every 2 s for the first 30 s, then every 5 s", async (t) => {
  const delays = [];
  const callbacks = [];
  const clock = createClock();
  const fs = createFakeFs();
  const timers = {
    setTimeout(fn, ms) {
      delays.push(ms);
      callbacks.push(fn);
      return { unref() {} };
    },
    clearTimeout() {},
  };
  const monitor = createTransferMonitor(makeJob(), { fs, clock, settings: {}, timers });
  t.after(() => monitor.stop());
  monitor.start();
  assert.deepEqual(delays, [2000]);
  for (let i = 0; i < 15; i += 1) {
    clock.advance(delays[delays.length - 1]);
    await callbacks.shift()();
  }
  assert.equal(delays[14], 2000);
  assert.equal(delays[15], 5000, "the 31st second onwards");
  assert.ok(delays.slice(15).every((ms) => ms === 5000));
});

test("a crawling transfer raises the slow_source advice once, without touching settings", async (t) => {
  const { job, clock, fs, monitor, logs } = setup(t);
  const part = path.join(DOWNLOAD_CACHE, "sub", "model-00002.safetensors.ab.incomplete");
  fs.set(part, 1);
  await monitor.tick();
  for (let i = 1; i <= 8; i += 1) {
    clock.advance(30_000);
    fs.set(part, 1 + i * 100);
    await monitor.tick();
  }
  assert.deepEqual(job.advice, { code: "slow_source", suggest: "hf-mirror" });
  assert.equal(logs.length, 1);
});
