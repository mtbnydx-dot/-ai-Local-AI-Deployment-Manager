"use strict";

// Model hub skeleton (docs/overhaul/03-hub.md §3, §8, §14, HUB-1): the data
// store with atomic writes, the settings, the downloadsOwner flag and the hub
// lifecycle. Every case works in a temp directory and passes its env
// explicitly, so neither this machine's environment nor a real
// <AI_ROOT>/config/platform.json or hub data directory can leak in.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const platformConfig = require("../platform/config");
const { createHubStore, hubWriterIsLive, WRITER_STALE_MS } = require("../model-hub/store");
const settingsModule = require("../model-hub/settings");
const { readHubConfig, DOWNLOADS_OWNER_ENV } = require("../model-hub/config");
const { createModelHub, discoverHubClis } = require("../model-hub");

const STORE_MODULE = path.join(__dirname, "..", "model-hub", "store.js");
const NO_ENV = Object.freeze({});
const FIXED_NOW = Date.parse("2026-10-14T08:00:00.000Z");

function tempDir(t, prefix = "hub-store-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClock(start = FIXED_NOW) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function quietLogger() {
  const lines = [];
  return { lines, log: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
}

function tempNames(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writePlatformJson(root, value) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "platform.json"), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

// --- store: atomic writes ------------------------------------------------------

test("atomic writes round-trip, are serialized per file and leave no temp file", async (t) => {
  const dir = tempDir(t);
  const store = createHubStore({ dataDir: dir });
  assert.deepEqual(store.read("settings"), { exists: false, value: null, error: null, file: path.join(dir, "settings.json") });

  await store.write("settings", { schemaVersion: 1, value: 1 });
  assert.deepEqual(store.read("settings").value, { schemaVersion: 1, value: 1 });
  assert.match(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), /\n$/);

  // Twenty writes in flight at once: the last one handed in is the one on disk.
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.write("settings", { schemaVersion: 1, value: index })));
  await store.flush();
  assert.deepEqual(readJson(path.join(dir, "settings.json")), { schemaVersion: 1, value: 19 });
  assert.deepEqual(tempNames(dir), []);
  assert.throws(() => store.read("secrets"), /unknown hub data file/);
});

test("a temp file a crash left behind is never read and init() sweeps it", async (t) => {
  const dir = tempDir(t);
  const store = createHubStore({ dataDir: dir });
  await store.write("settings", { schemaVersion: 1, value: "kept" });
  // A torn temp next to a good file, and one for a file that was never written.
  fs.writeFileSync(path.join(dir, `.settings.json.4242.${Date.now()}.deadbeef.tmp`), '{"schemaVersion":1,"value":"to');
  fs.writeFileSync(path.join(dir, `.library.json.4242.${Date.now()}.cafebabe.tmp`), "{\"entries\":[");
  fs.writeFileSync(path.join(dir, "unrelated.tmp"), "not ours");

  const fresh = createHubStore({ dataDir: dir });
  assert.deepEqual(fresh.read("settings").value, { schemaVersion: 1, value: "kept" });
  assert.equal(fresh.read("library").exists, false, "a lone temp file is not the file");

  const swept = await fresh.init();
  assert.equal(swept.removedTemps.length, 2);
  assert.deepEqual(tempNames(dir), ["unrelated.tmp"], "only the hub's own temps are swept");
  assert.ok(fs.statSync(path.join(dir, "logs")).isDirectory());
  assert.ok(fs.statSync(path.join(dir, "migration")).isDirectory());
  assert.deepEqual(fresh.read("settings").value, { schemaVersion: 1, value: "kept" });
});

test("a process that dies between the temp write and the rename leaves the old file intact", async (t) => {
  const dir = tempDir(t);
  // The child writes v1, then dies while writing v2: once right before the
  // rename (complete temp) and once halfway through the temp (torn temp).
  const script = `
    const [storeModule, dataDir, mode] = process.argv.slice(1);
    const { createHubStore } = require(storeModule);
    (async () => {
      const store = createHubStore({ dataDir });
      if (mode === "seed") {
        await store.write("downloads", { schemaVersion: 1, jobs: [{ id: "dl_v1" }] });
        return;
      }
      const io = mode === "before-rename"
        ? { rename: () => process.exit(9) }
        : { writeFile: (file, text) => { require("node:fs").writeFileSync(file, text.slice(0, 20)); process.exit(9); } };
      const crashing = createHubStore({ dataDir, io });
      await crashing.write("downloads", { schemaVersion: 1, jobs: [{ id: "dl_v2" }] });
    })();
  `;
  const run = (mode) => spawnSync(process.execPath, ["-e", script, STORE_MODULE, dir, mode], { encoding: "utf8", timeout: 30000 });
  assert.equal(run("seed").status, 0);
  for (const mode of ["before-rename", "torn-temp"]) {
    const crashed = run(mode);
    assert.equal(crashed.status, 9, `${mode}: ${crashed.stderr}`);
    assert.equal(tempNames(dir).length, 1, `${mode}: the crash left its temp file`);
    const store = createHubStore({ dataDir: dir });
    assert.deepEqual(store.readDownloads().value.jobs, [{ id: "dl_v1" }], `${mode}: the old file is what reads see`);
    await store.init();
    assert.deepEqual(tempNames(dir), [], `${mode}: init() swept the temp`);
    assert.deepEqual(store.readDownloads().value.jobs, [{ id: "dl_v1" }]);
  }
});

test("a failed rename rejects the write, keeps the old file and removes the temp", async (t) => {
  const dir = tempDir(t);
  await createHubStore({ dataDir: dir }).write("library", { schemaVersion: 1, entries: ["old"] });
  const store = createHubStore({ dataDir: dir, io: { rename: async () => { throw Object.assign(new Error("simulated EIO"), { code: "EIO" }); } } });
  await assert.rejects(store.write("library", { schemaVersion: 1, entries: ["new"] }), /simulated EIO/);
  assert.deepEqual(readJson(path.join(dir, "library.json")).entries, ["old"]);
  assert.deepEqual(tempNames(dir), []);
  // The chain keeps going after a failure.
  const healthy = createHubStore({ dataDir: dir });
  await healthy.write("library", { schemaVersion: 1, entries: ["newer"] });
  assert.deepEqual(readJson(path.join(dir, "library.json")).entries, ["newer"]);
});

test("a synchronous write overtakes an async write still in flight", async (t) => {
  const dir = tempDir(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = createHubStore({
    dataDir: dir,
    io: {
      async writeFile(file, text) {
        await gate;
        fs.writeFileSync(file, text);
      },
    },
  });
  const pending = store.write("downloads", { schemaVersion: 1, jobs: [{ id: "older" }] });
  await new Promise((resolve) => setImmediate(resolve));
  store.writeSync("downloads", { schemaVersion: 1, jobs: [{ id: "final" }] });
  release();
  await pending;
  await store.flush();
  assert.deepEqual(readJson(path.join(dir, "downloads.json")).jobs, [{ id: "final" }], "the older async value never lands");
  assert.deepEqual(tempNames(dir), []);
});

test("corrupt, non-object and BOM-prefixed files read without throwing", async (t) => {
  const dir = tempDir(t);
  const store = createHubStore({ dataDir: dir });
  fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
  const corrupt = store.read("settings");
  assert.equal(corrupt.exists, true);
  assert.equal(corrupt.value, null);
  assert.equal(corrupt.error.code, "corrupt");
  assert.equal(corrupt.error.message.includes(dir), false, "messages name the file, not its folder");

  fs.writeFileSync(path.join(dir, "migrations.json"), "[1, 2]");
  assert.equal(store.read("migrations").error.code, "corrupt");

  fs.writeFileSync(path.join(dir, "library.json"), `﻿${JSON.stringify({ schemaVersion: 1, entries: [] })}`);
  assert.deepEqual(store.read("library").value, { schemaVersion: 1, entries: [] });
});

// --- store: stamp and history ----------------------------------------------------

test("downloads.json carries the writerPid/heartbeatAt stamp that tells a live hub from a stale file", async (t) => {
  const dir = tempDir(t);
  const clock = fakeClock();
  const store = createHubStore({ dataDir: dir, clock, pid: 4321 });
  assert.deepEqual(store.readDownloads().value, { schemaVersion: 1, writerPid: null, heartbeatAt: null, jobs: [] });
  await store.writeDownloads({ jobs: [{ id: "dl_a" }, "not a job"] });
  const doc = readJson(path.join(dir, "downloads.json"));
  assert.deepEqual(doc, { schemaVersion: 1, jobs: [{ id: "dl_a" }, "not a job"], writerPid: 4321, heartbeatAt: "2026-10-14T08:00:00.000Z" });
  assert.deepEqual(store.readDownloads().value.jobs, [{ id: "dl_a" }], "readers keep job objects only");

  const alive = (pid) => pid === 4321;
  assert.equal(hubWriterIsLive(doc, { now: FIXED_NOW + 60_000, isPidAlive: alive }), true);
  assert.equal(hubWriterIsLive(doc, { now: FIXED_NOW + WRITER_STALE_MS + 1, isPidAlive: alive }), false, "a stale heartbeat");
  assert.equal(hubWriterIsLive(doc, { now: FIXED_NOW, isPidAlive: () => false }), false, "a dead writer");
  assert.equal(hubWriterIsLive({ ...doc, heartbeatAt: "garbage" }, { now: FIXED_NOW, isPidAlive: alive }), false);
  assert.equal(hubWriterIsLive({ ...doc, writerPid: process.pid }, { now: FIXED_NOW }), true, "the real pid probe sees this process");

  clock.advance(30_000);
  store.writeDownloads({ jobs: [] }, { sync: true });
  assert.equal(readJson(path.join(dir, "downloads.json")).heartbeatAt, "2026-10-14T08:00:30.000Z");
});

test("history appends JSON lines, and a line torn by a crash never swallows the next record", async (t) => {
  const dir = tempDir(t);
  const store = createHubStore({ dataDir: dir });
  assert.deepEqual(store.readHistory(), { records: [], skipped: 0 });
  assert.equal(await store.appendHistory([{ id: "dl_1" }, { id: "dl_2" }]), 2);
  fs.appendFileSync(store.historyFile, '{"id":"dl_torn","sta');
  assert.equal(await store.appendHistory({ id: "dl_3" }), 1);
  const { records, skipped } = store.readHistory();
  assert.deepEqual(records.map((record) => record.id), ["dl_1", "dl_2", "dl_3"]);
  assert.equal(skipped, 1);
});

// --- settings ----------------------------------------------------------------------

test("default settings are 03 §14's", () => {
  assert.deepEqual(settingsModule.defaultSettings(), {
    schemaVersion: 1,
    sources: { policy: "huggingface", hfEndpoint: "https://huggingface.co", mirrorEndpoint: "https://hf-mirror.com", modelScopeEndpoint: "https://www.modelscope.cn", gatedUsesOfficial: true },
    transfer: { xet: "high-performance", maxConcurrent: 1, stallMinutes: 10, materializeStallMinutes: 20 },
    verify: { sha256: true },
    retry: { maxAttempts: 3, baseDelaySeconds: 10, maxDelaySeconds: 600, perClass: { network: true, server: true, watchdog: true, integrity: true, tooling: "once" } },
    queue: { idleOnly: false, idleGraceSeconds: 30, resumeOnStart: true, resumeDelaySeconds: 20 },
    storage: { reserveGb: 10, showLegacyRootWhenEmpty: false },
    history: { keepRecords: 200, retentionDays: 365 },
    library: { rescanOnStart: true, updateCheck: "manual", identifyOnline: false },
    notifications: { onReady: true, onFailure: true },
  });
  assert.notEqual(settingsModule.defaultSettings(), settingsModule.defaultSettings(), "every call is a fresh object");
});

test("validateSettings merges a partial patch and reports every invalid field", () => {
  const ok = settingsModule.validateSettings({ transfer: { maxConcurrent: 2 }, retry: { perClass: { tooling: false } }, schemaVersion: 1 }, { env: NO_ENV });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.transfer.maxConcurrent, 2);
  assert.equal(ok.settings.transfer.xet, "high-performance", "untouched leaves keep their value");
  assert.equal(ok.settings.retry.perClass.tooling, false);
  assert.deepEqual(ok.changed, ["transfer.maxConcurrent", "retry.perClass.tooling"]);

  const base = ok.settings;
  const bad = settingsModule.validateSettings({
    schemaVersion: 2,
    sources: { policy: "nearest", hfEndpoint: "http://huggingface.co" },
    transfer: { maxConcurrent: 9, stallMinutes: 2.5 },
    verify: "yes",
    queue: { idleOnly: "true" },
    retry: { perClass: { network: "twice" } },
    extras: { a: 1 },
  }, { base, env: NO_ENV });
  assert.equal(bad.ok, false);
  assert.equal(bad.settings, undefined, "nothing is merged when anything is invalid");
  const byField = Object.fromEntries(bad.errors.map((error) => [error.field, error.code]));
  assert.deepEqual(byField, {
    schemaVersion: "invalid_value",
    "sources.policy": "invalid_value",
    "sources.hfEndpoint": "invalid_format",
    "transfer.maxConcurrent": "out_of_range",
    "transfer.stallMinutes": "invalid_type",
    verify: "invalid_type",
    "queue.idleOnly": "invalid_type",
    "retry.perClass.network": "invalid_value",
    extras: "unknown_key",
  });
  for (const error of bad.errors) assert.equal(typeof error.message, "string");
  // A parsed body can carry an own __proto__ key; it is refused, never merged.
  const proto = settingsModule.validateSettings(JSON.parse('{"__proto__":{"polluted":true},"retry":{"__proto__":{"polluted":true}}}'), { env: NO_ENV });
  assert.deepEqual(proto.errors.map((error) => [error.field, error.code]), [["__proto__", "unknown_key"], ["retry.__proto__", "unknown_key"]]);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(settingsModule.validateSettings([1], { env: NO_ENV }).errors.map((error) => error.code), ["invalid_type"]);
});

test("endpoints are https: without credentials, query or fragment; loopback http: only under NODE_ENV=test", () => {
  const check = (value, env = NO_ENV) => settingsModule.validateSettings({ sources: { mirrorEndpoint: value } }, { env });
  assert.equal(check("https://mirror.example/").settings.sources.mirrorEndpoint, "https://mirror.example");
  assert.equal(check("https://mirror.example/hf/").settings.sources.mirrorEndpoint, "https://mirror.example/hf");
  for (const value of ["http://mirror.example", "https://user:pw@mirror.example", "https://mirror.example/?a=1", "https://mirror.example/#x", "ftp://mirror.example", "mirror.example", "", 42]) {
    assert.equal(check(value).ok, false, String(value));
  }
  assert.equal(check("http://127.0.0.1:9").ok, false, "loopback http needs NODE_ENV=test");
  assert.equal(check("http://127.0.0.1:9", { NODE_ENV: "test" }).settings.sources.mirrorEndpoint, "http://127.0.0.1:9");
  assert.equal(check("http://mirror.example", { NODE_ENV: "test" }).ok, false, "only loopback");
});

test("retry.maxDelaySeconds below retry.baseDelaySeconds is refused", () => {
  const result = settingsModule.validateSettings({ retry: { baseDelaySeconds: 900 } }, { env: NO_ENV });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [["retry.maxDelaySeconds", "out_of_range"]]);
  assert.equal(settingsModule.validateSettings({ retry: { baseDelaySeconds: 900, maxDelaySeconds: 900 } }, { env: NO_ENV }).ok, true);
});

test("normalizeSettings keeps the valid leaves of a stored file and reports the rest", () => {
  const { settings, errors } = settingsModule.normalizeSettings({
    schemaVersion: 1,
    transfer: { maxConcurrent: 3, xet: "turbo" },
    retry: { baseDelaySeconds: 700, maxDelaySeconds: 30 },
    stray: true,
  }, { env: NO_ENV });
  assert.equal(settings.transfer.maxConcurrent, 3);
  assert.equal(settings.transfer.xet, "high-performance");
  assert.equal(settings.retry.baseDelaySeconds, 700);
  assert.equal(settings.retry.maxDelaySeconds, 700, "raised to fit the base delay");
  assert.equal(Object.hasOwn(settings, "stray"), false);
  assert.deepEqual(errors.map((error) => error.field), ["transfer.xet", "retry.maxDelaySeconds"]);
});

test("the legacy seven-key settings map both ways (03 §14 table)", () => {
  assert.deepEqual(settingsModule.LEGACY_KEYS, ["queueMode", "autoRetryCount", "autoRetryDelaySeconds", "hfMirror", "hfTransfer", "verifyChecksums", "idleOnlyQueue"]);
  assert.deepEqual(settingsModule.toLegacy(settingsModule.defaultSettings()), {
    queueMode: true, autoRetryCount: 3, autoRetryDelaySeconds: 10, hfMirror: false, hfTransfer: true, verifyChecksums: true, idleOnlyQueue: false,
  });
  assert.deepEqual(settingsModule.fromLegacy({
    queueMode: false, autoRetryCount: 5, autoRetryDelaySeconds: 30, hfMirror: true, hfTransfer: false, verifyChecksums: false, idleOnlyQueue: true,
  }), {
    transfer: { maxConcurrent: 3, xet: "default" },
    retry: { maxAttempts: 5, baseDelaySeconds: 30 },
    sources: { policy: "hf-mirror" },
    verify: { sha256: false },
    queue: { idleOnly: true },
  });
  assert.deepEqual(settingsModule.fromLegacy({ hfMirror: false }), { sources: { policy: "huggingface" } }, "only the keys present are mapped");
  assert.deepEqual(settingsModule.fromLegacy(null), {});

  // A retry count of 0 switches every retry class off, and back.
  const off = settingsModule.validateSettings(settingsModule.fromLegacy({ autoRetryCount: 0 }), { env: NO_ENV }).settings;
  assert.deepEqual(off.retry.perClass, { network: false, server: false, watchdog: false, integrity: false, tooling: false });
  assert.equal(settingsModule.toLegacy(off).autoRetryCount, 0);
  const on = settingsModule.validateSettings(settingsModule.fromLegacy({ autoRetryCount: 2 }, { current: off }), { base: off, env: NO_ENV }).settings;
  assert.deepEqual(on.retry.perClass, settingsModule.defaultSettings().retry.perClass);
  assert.equal(settingsModule.toLegacy(on).autoRetryCount, 2);

  // The legacy delay range (1-3600 s) always validates: the cap follows it.
  const slow = settingsModule.validateSettings(settingsModule.fromLegacy({ autoRetryDelaySeconds: 3600 }), { env: NO_ENV });
  assert.equal(slow.ok, true);
  assert.equal(slow.settings.retry.maxDelaySeconds, 3600);
  assert.equal(settingsModule.fromLegacy({ autoRetryCount: 99, autoRetryDelaySeconds: "x" }).retry.maxAttempts, 10);

  // fromLegacy(toLegacy(x)) gives x back for what the legacy keys can express.
  const sample = settingsModule.validateSettings({
    transfer: { maxConcurrent: 3, xet: "default" }, sources: { policy: "hf-mirror" }, retry: { maxAttempts: 4, baseDelaySeconds: 15 }, verify: { sha256: false }, queue: { idleOnly: true },
  }, { env: NO_ENV }).settings;
  const back = settingsModule.validateSettings(settingsModule.fromLegacy(settingsModule.toLegacy(sample), { current: sample }), { env: NO_ENV }).settings;
  assert.deepEqual(back, sample);
});

// --- readHubConfig ---------------------------------------------------------------

test("readHubConfig precedence is env > platform.json > default, and an invalid value falls through", (t) => {
  const root = tempDir(t, "hub-config-");
  assert.deepEqual(readHubConfig(root, NO_ENV), { downloadsOwner: "hub", source: "default", errors: [] });

  writePlatformJson(root, { schemaVersion: 1, hub: { downloadsOwner: "manager" } });
  assert.deepEqual(readHubConfig(root, NO_ENV), { downloadsOwner: "manager", source: "file", errors: [] });
  assert.deepEqual(readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "hub" }), { downloadsOwner: "hub", source: "env", errors: [] });
  assert.equal(readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "MANAGER" }).downloadsOwner, "manager", "env text is case-insensitive");
  assert.equal(readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "  " }).source, "file", "a blank env var is unset");

  const badEnv = readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "both" });
  assert.equal(badEnv.downloadsOwner, "manager");
  assert.equal(badEnv.source, "file");
  assert.deepEqual(badEnv.errors.map((error) => [error.field, error.code, error.source]), [["hub.downloadsOwner", "invalid_value", "env"]]);

  writePlatformJson(root, { schemaVersion: 1, hub: { downloadsOwner: "everyone" } });
  const badFile = readHubConfig(root, NO_ENV);
  assert.equal(badFile.downloadsOwner, "hub");
  assert.equal(badFile.source, "default");
  assert.deepEqual(badFile.errors.map((error) => [error.code, error.source]), [["invalid_value", "file"]]);

  writePlatformJson(root, "{ torn");
  const corrupt = readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "manager" });
  assert.equal(corrupt.downloadsOwner, "manager", "env still wins over a corrupt file");
  assert.equal(readHubConfig(root, NO_ENV).downloadsOwner, "hub");
  assert.equal(readHubConfig(root, NO_ENV).errors[0].code, "parse_error");
});

test("readHubConfig applies the same precedence when the platform config cannot be used", (t) => {
  const root = tempDir(t, "hub-config-");
  const broken = { readSection: () => { throw new Error("schema unavailable"); } };
  const unknown = { readSection: () => ({ values: {}, sources: {}, errors: [{ field: "hub", code: "unknown_section", message: "x" }] }) };
  for (const stub of [broken, unknown]) {
    assert.deepEqual(readHubConfig(root, NO_ENV, { platformConfig: stub }), { downloadsOwner: "hub", source: "default", errors: [] });
    writePlatformJson(root, { hub: { downloadsOwner: "manager" } });
    assert.deepEqual(readHubConfig(root, NO_ENV, { platformConfig: stub }), { downloadsOwner: "manager", source: "file", errors: [] });
    assert.deepEqual(readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "Hub" }, { platformConfig: stub }), { downloadsOwner: "hub", source: "env", errors: [] });
    const badEnv = readHubConfig(root, { [DOWNLOADS_OWNER_ENV]: "nobody" }, { platformConfig: stub });
    assert.deepEqual([badEnv.downloadsOwner, badEnv.source, badEnv.errors[0].source], ["manager", "file", "env"]);
    fs.rmSync(path.join(root, "config"), { recursive: true, force: true });
  }
});

test("the hub fragment declares hub.downloadsOwner in the platform schema", () => {
  const schema = platformConfig.loadPlatformSchema();
  assert.deepEqual(schema.errors, []);
  const fragment = schema.fragments.find((item) => item.namespace === "hub");
  assert.deepEqual(fragment, { file: "data/platform-config.d/hub.schema.json", namespace: "hub", owner: "03-hub", accepted: true });
  const leaf = schema.leaves.get("hub.downloadsOwner");
  assert.deepEqual(leaf.enum, ["hub", "manager"]);
  assert.equal(leaf.default, "hub");
  assert.equal(platformConfig.envNameIndex(schema).get(DOWNLOADS_OWNER_ENV), "hub.downloadsOwner");
});

// --- the hub ---------------------------------------------------------------------

function makeHub(t, extra = {}) {
  const root = extra.root || tempDir(t, "hub-root-");
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const logger = quietLogger();
  const hub = createModelHub({
    aiRoot: root,
    dataDir,
    env: NO_ENV,
    clock: extra.clock || fakeClock(),
    logger,
    heartbeatMs: 3_600_000,
    hfCli: extra.hfCli,
    modelScopeCli: extra.modelScopeCli,
    ...extra.options,
  });
  t.after(() => hub.stop());
  return { hub, root, dataDir, logger };
}

test("start() prepares the data directory and stamps downloads.json; status() is the HUB-1 skeleton", async (t) => {
  const root = tempDir(t, "hub-root-");
  const hfCli = path.join(root, "venvs", "download-cli", "Scripts", "hf.exe");
  fs.mkdirSync(path.dirname(hfCli), { recursive: true });
  fs.writeFileSync(hfCli, "");
  const { hub, dataDir, logger } = makeHub(t, { root, hfCli, modelScopeCli: "modelscope", options: { migration: false } });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `.downloads.json.1.${Date.now()}.00000000.tmp`), "{");

  assert.equal(hub.state, "idle");
  assert.equal(fs.readdirSync(dataDir).length, 1, "creating the hub touched no file");
  await hub.start();
  assert.equal(hub.state, "running");
  assert.deepEqual(tempNames(dataDir), []);
  assert.equal(logger.lines.filter((line) => line.includes("temp file")).length, 1);
  const stamped = readJson(path.join(dataDir, "downloads.json"));
  assert.deepEqual(stamped, { schemaVersion: 1, jobs: [], writerPid: process.pid, heartbeatAt: "2026-10-14T08:00:00.000Z" });
  assert.equal(fs.existsSync(path.join(dataDir, "settings.json")), false, "absent settings stay absent for the settings-v1 migration");

  assert.deepEqual(hub.status(), {
    ok: true,
    state: "running",
    owner: "hub",
    ownerSource: "default",
    active: 0,
    queued: 0,
    waiting: 0,
    speedBps: 0,
    cli: { hf: { path: hfCli, found: true, version: null }, modelscope: { path: "modelscope", found: null, version: null } },
    dataDir,
    dataErrors: [],
    configErrors: [],
    migration: { done: false },
    features: { runAfter: true, rememberToken: false, models: false },
    startedAt: "2026-10-14T08:00:00.000Z",
  });
  assert.deepEqual(hub.busy(), { downloads: 0, verifying: 0 });
  assert.equal(hub.start(), hub.start(), "start() is idempotent");
});

test("the status follows hub.downloadsOwner and reports a bad value", async (t) => {
  const root = tempDir(t, "hub-root-");
  writePlatformJson(root, { hub: { downloadsOwner: "manager" } });
  const { hub } = makeHub(t, { root });
  await hub.start();
  assert.deepEqual([hub.status().owner, hub.status().ownerSource], ["manager", "file"]);
  const envHub = createModelHub({ aiRoot: root, dataDir: path.join(root, "other"), env: { [DOWNLOADS_OWNER_ENV]: "sometimes" }, logger: quietLogger() });
  const status = envHub.status();
  assert.deepEqual([status.owner, status.ownerSource, status.configErrors[0].code], ["manager", "file", "invalid_value"]);
});

test("settings persist across hub instances; a hub that is not running writes nothing", async (t) => {
  const root = tempDir(t, "hub-root-");
  const first = makeHub(t, { root });
  const settingsFile = path.join(first.dataDir, "settings.json");
  assert.deepEqual(await first.hub.settings.get(), settingsModule.defaultSettings(), "an unstarted hub reads defaults");
  assert.deepEqual(await first.hub.settings.update({ transfer: { maxConcurrent: 2 } }), { ok: false, code: "hub_unavailable", message: "The model hub is not running." });
  assert.equal(fs.existsSync(settingsFile), false);

  await first.hub.start();
  const saved = await first.hub.settings.update({ transfer: { maxConcurrent: 2 }, sources: { policy: "hf-mirror" } });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.transfer.maxConcurrent, 2);
  assert.deepEqual(readJson(settingsFile), saved.settings);

  const invalid = await first.hub.settings.update({ transfer: { maxConcurrent: 0 } });
  assert.deepEqual([invalid.ok, invalid.code, invalid.errors[0].field], [false, "settings_invalid", "transfer.maxConcurrent"]);
  assert.deepEqual(readJson(settingsFile), saved.settings, "an invalid patch writes nothing");

  // Two concurrent patches of different keys both land.
  await Promise.all([first.hub.settings.update({ verify: { sha256: false } }), first.hub.settings.update({ queue: { idleOnly: true } })]);
  const both = await first.hub.settings.get();
  assert.deepEqual([both.verify.sha256, both.queue.idleOnly, both.transfer.maxConcurrent], [false, true, 2]);

  await first.hub.stop();
  assert.equal((await first.hub.settings.update({ verify: { sha256: true } })).code, "hub_unavailable");

  const second = makeHub(t, { root });
  await second.hub.start();
  assert.deepEqual(await second.hub.settings.get(), both, "a new instance reads what the old one wrote");
});

test("a corrupt settings.json falls back to defaults, is kept and is reported until the settings are saved", async (t) => {
  const { hub, dataDir } = makeHub(t);
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, "settings.json");
  fs.writeFileSync(settingsFile, "{ torn by a crash");
  await hub.start();
  assert.deepEqual(await hub.settings.get(), settingsModule.defaultSettings());
  const [error] = hub.status().dataErrors;
  assert.deepEqual([error.name, error.code, error.file], ["settings.json", "corrupt", settingsFile]);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), "{ torn by a crash", "the file is not overwritten by a read");

  assert.equal((await hub.settings.update({ history: { keepRecords: 50 } })).ok, true);
  assert.deepEqual(hub.status().dataErrors, []);
  assert.equal(readJson(settingsFile).history.keepRecords, 50);
});

test("a corrupt downloads.json is kept aside and the hub starts with an empty ledger", async (t) => {
  const { hub, dataDir } = makeHub(t);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "downloads.json"), "{\"jobs\": [");
  await hub.start();
  assert.equal(fs.readFileSync(path.join(dataDir, "downloads.json.corrupt"), "utf8"), "{\"jobs\": [");
  assert.deepEqual(readJson(path.join(dataDir, "downloads.json")).jobs, []);
  assert.deepEqual(hub.status().dataErrors.map((error) => [error.name, error.code]), [["downloads.json", "corrupt"]]);
});

test("jobs in downloads.json are carried over and migration status is read from migrations.json", async (t) => {
  const { hub, dataDir } = makeHub(t);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "downloads.json"), JSON.stringify({ schemaVersion: 1, writerPid: 1, heartbeatAt: "2026-01-01T00:00:00.000Z", jobs: [{ id: "dl_keep" }] }));
  fs.writeFileSync(path.join(dataDir, "migrations.json"), JSON.stringify({ schemaVersion: 1, steps: [{ id: "settings-v1", done: true }, { id: "ledgers-v1", done: true }] }));
  await hub.start();
  const doc = readJson(path.join(dataDir, "downloads.json"));
  assert.deepEqual([doc.jobs, doc.writerPid], [[{ id: "dl_keep" }], process.pid]);
  assert.deepEqual(hub.status().migration, { done: true });
});

test("stop() is idempotent and re-stamps downloads.json synchronously", async (t) => {
  const clock = fakeClock();
  const { hub, dataDir } = makeHub(t, { clock });
  await hub.stop();
  assert.equal(hub.state, "stopped", "stopping a hub that never started is fine");
  assert.equal(fs.existsSync(dataDir), false, "and writes nothing");
  await hub.start();
  assert.equal(hub.state, "stopped", "a stopped hub does not start again");

  const running = makeHub(t, { clock });
  await running.hub.start();
  clock.advance(45_000);
  const first = running.hub.stop({ reason: "shutdown" });
  assert.equal(running.hub.stop(), first);
  await first;
  assert.equal(running.hub.state, "stopped");
  assert.equal(readJson(path.join(running.dataDir, "downloads.json")).heartbeatAt, "2026-10-14T08:00:45.000Z");
  assert.deepEqual(tempNames(running.dataDir), []);
});

test("the heartbeat re-stamps downloads.json while the hub runs", async (t) => {
  const clock = fakeClock();
  const { hub, dataDir } = makeHub(t, { clock, options: { heartbeatMs: 20 } });
  await hub.start();
  clock.advance(60_000);
  const deadline = Date.now() + 5000;
  while (readJson(path.join(dataDir, "downloads.json")).heartbeatAt !== "2026-10-14T08:01:00.000Z") {
    assert.ok(Date.now() < deadline, "the heartbeat wrote within 5 s");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("discoverHubClis follows the managers' order: override, download-cli, ai312, ai311, PATH", (t) => {
  const root = tempDir(t, "hub-cli-");
  assert.deepEqual(discoverHubClis({ aiRoot: root, env: NO_ENV }), { hfCli: "huggingface-cli", modelScopeCli: "modelscope" });
  const touch = (...parts) => {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    return file;
  };
  const ai311 = touch("venvs", "ai311", "Scripts", "hf.exe");
  assert.equal(discoverHubClis({ aiRoot: root, env: NO_ENV }).hfCli, ai311);
  const downloadCli = touch("venvs", "download-cli", "Scripts", "hf.exe");
  const modelscope = touch("venvs", "ai312", "Scripts", "modelscope.exe");
  assert.deepEqual(discoverHubClis({ aiRoot: root, env: NO_ENV }), { hfCli: downloadCli, modelScopeCli: modelscope });
  const override = touch("tools", "hf.exe");
  assert.equal(discoverHubClis({ aiRoot: root, env: { HF_CLI: override } }).hfCli, override);
});
