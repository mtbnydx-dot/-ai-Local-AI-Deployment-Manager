"use strict";

// Migration from the managers' download settings and ledgers (docs/overhaul/
// 03-hub.md §16, HUB-12). The legacy fixtures under fixtures/hub-migrate are
// copied into a temp AI root, including 08-era meta.transfer and
// meta.errorCode records. Nothing touches a real AI root, a real manager or
// the network: the hub runs over temp directories with a fake transfer engine.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createModelFilesystemStore } = require("../model-filesystem-store");
const { createModelStorage } = require("../model-storage");
const { createHubStore } = require("../model-hub/store");
const { createSettingsService } = require("../model-hub/settings");
const { createModelHub } = require("../model-hub");
const { runHubMigration, mapLegacyJob, STEP_IDS } = require("../model-hub/migrate");

const FIXTURES = path.join(__dirname, "fixtures", "hub-migrate");
const GOLDEN = path.join(FIXTURES, "hub-state.golden.json");
const FIXED_NOW = Date.parse("2026-10-14T08:00:00.000Z");
const LEDGER_IDS = ["mig-v-ready", "mig-v-coded", "mig-v-uncoded", "mig-v-running", "mig-l-queued", "mig-l-cancelled", "mig-l-modelscope"];

function tempDir(t, prefix = "hub-migrate-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLogger() {
  const lines = [];
  return { lines, log() {}, info() {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
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

function fakeClock() {
  return { now: () => FIXED_NOW };
}

function fakeEngine() {
  return {
    id: "cli",
    started: [],
    start(job) {
      this.started.push(job.id);
      throw new Error("the migration tests never start a transfer");
    },
    async findOrphans() {
      return [];
    },
  };
}

function replaceRoot(value, root) {
  if (typeof value === "string") return value.split("<ROOT>").join(root);
  if (Array.isArray(value)) return value.map((item) => replaceRoot(item, root));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRoot(item, root)]));
  return value;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// An AI root with both managers' legacy files, written as the managers do.
function makeWorld(t, { withLedgers = true, withSettings = true } = {}) {
  const root = tempDir(t);
  const modelsRoot = path.join(root, "models");
  fs.mkdirSync(modelsRoot, { recursive: true });
  const managers = {};
  for (const [id, dir] of [["vllm", "vllm-manager"], ["llama", "llama-manager"]]) {
    const logs = path.join(root, dir, "logs");
    fs.mkdirSync(logs, { recursive: true });
    const files = { ledger: path.join(logs, "jobs-ledger.json"), settings: path.join(logs, "download-settings.json") };
    if (withLedgers) {
      const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${id}-jobs-ledger.json`), "utf8"));
      fs.writeFileSync(files.ledger, JSON.stringify(replaceRoot(parsed, modelsRoot), null, 2));
    }
    if (withSettings) fs.copyFileSync(path.join(FIXTURES, `${id}-download-settings.json`), files.settings);
    managers[id] = files;
  }
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const modelStorage = createModelStorage({ modelsRoot, file: path.join(root, "service-entry", "data", "model-storage.json") });
  const store = createHubStore({ dataDir, clock: fakeClock() });
  const settings = createSettingsService({ store, env: {} });
  const events = fakeEvents();
  const logger = quietLogger();
  return {
    root,
    modelsRoot,
    managers,
    dataDir,
    modelStorage,
    store,
    settings,
    events,
    logger,
    async migrate(extra = {}) {
      await store.init();
      return runHubMigration({ aiRoot: root, store, settings, modelStorage, logger, events, clock: fakeClock(), ...extra });
    },
    downloads: () => JSON.parse(fs.readFileSync(path.join(dataDir, "downloads.json"), "utf8")),
    migrations: () => JSON.parse(fs.readFileSync(path.join(dataDir, "migrations.json"), "utf8")),
    managerHashes() {
      const hashes = {};
      for (const [id, files] of Object.entries(managers)) {
        for (const [kind, file] of Object.entries(files)) hashes[`${id}.${kind}`] = { sha: sha256File(file), mtime: fs.statSync(file).mtimeMs };
      }
      return hashes;
    },
  };
}

function normalizeJobs(doc, root) {
  const clean = (value) => {
    if (typeof value === "string") return value.split(root).join("<ROOT>").replaceAll("\\", "/");
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  return clean(doc.jobs
    // The drive letter depends on where the temp directory lives.
    .map((job) => ({ ...job, id: `dl_${job.legacyIds[0]}`, target: { ...job.target, volume: job.target.volume ? "<VOLUME>" : null } }))
    .sort((a, b) => a.legacyIds[0].localeCompare(b.legacyIds[0])));
}

function jobByLegacy(doc, legacyId) {
  return doc.jobs.find((job) => job.legacyIds.includes(legacyId));
}

test("a golden import: ledgers, settings and notification map to the hub state", async (t) => {
  const world = makeWorld(t);
  const result = await world.migrate();
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.ran, STEP_IDS);

  const doc = world.downloads();
  assert.equal(doc.jobs.length, LEDGER_IDS.length, "serve jobs are not imported");
  const actual = {
    jobs: normalizeJobs(doc, world.root),
    settings: JSON.parse(fs.readFileSync(path.join(world.dataDir, "settings.json"), "utf8")),
    steps: world.migrations().steps.map(({ id, done, counts }) => ({ id, done, counts })),
  };
  if (process.env.UPDATE_HUB_MIGRATE_GOLDEN === "1") fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
});

test("legacy states map: success ready, cancelled cancelled, failed failed, the rest paused by the migration", async (t) => {
  const world = makeWorld(t);
  await world.migrate();
  const doc = world.downloads();
  const states = Object.fromEntries(LEDGER_IDS.map((id) => [id, jobByLegacy(doc, id).state]));
  assert.deepEqual(states, {
    "mig-v-ready": "ready",
    "mig-v-coded": "failed",
    "mig-v-uncoded": "failed",
    "mig-v-running": "paused",
    "mig-l-queued": "paused",
    "mig-l-cancelled": "cancelled",
    "mig-l-modelscope": "paused",
  });
  for (const id of ["mig-v-running", "mig-l-queued", "mig-l-modelscope"]) {
    const job = jobByLegacy(doc, id);
    assert.equal(job.pausedBy, "migration");
    assert.equal(job.autoResume, false, "there is no automatic restart after an upgrade (O2)");
    assert.equal(job.origin.kind, "migration");
    assert.match(job.id, /^dl_[a-z2-7]{16}$/);
  }
  assert.equal(jobByLegacy(doc, "mig-v-ready").artifact.files.length, 2);
  assert.equal(jobByLegacy(doc, "mig-v-ready").artifact.files[0].role, "weight");
  assert.equal(jobByLegacy(doc, "mig-l-queued").artifact.manifestPending, true, "no manifest: rebuilt at resume time");
  assert.deepEqual(jobByLegacy(doc, "mig-l-queued").artifact.legacySelection, { precision: "Q4_K_M", includeExtras: ["mmproj"] });
});

test("08 error codes and transfer options carry over", async (t) => {
  const world = makeWorld(t);
  await world.migrate();
  const doc = world.downloads();

  const coded = jobByLegacy(doc, "mig-v-coded");
  assert.equal(coded.error.code, "hf_auth_invalid", "the stored meta.errorCode is kept");
  assert.equal(coded.error.baseCode, "hf_auth_invalid");
  assert.equal(coded.error.retryable, false);
  assert.deepEqual(coded.error.hint, { zh: "请重新登录 Hugging Face。", en: "Sign in to Hugging Face again." });
  assert.ok(coded.error.title.zh && coded.error.title.en);
  assert.ok(coded.error.class);

  const uncoded = jobByLegacy(doc, "mig-v-uncoded");
  assert.equal(uncoded.error.code, "disk_full", "an unclassified failure is classified from its logs");
  assert.ok(uncoded.error.hint.zh && uncoded.error.hint.en);

  // meta.transfer (08 P0-DL-2) wins over the manager's settings.
  const ready = jobByLegacy(doc, "mig-v-ready");
  assert.deepEqual(
    [ready.transfer.options.source, ready.transfer.options.xet, ready.transfer.options.credentialMode, ready.transfer.options.tokenRef],
    ["huggingface", "high-performance", "cached-login", null],
  );
  assert.equal(ready.priority, "high");
  // Without meta.transfer the manager's own settings apply (llama: hfMirror).
  const queued = jobByLegacy(doc, "mig-l-queued");
  assert.deepEqual(
    [queued.transfer.options.source, queued.transfer.options.endpoint, queued.transfer.options.xet, queued.transfer.options.credentialMode],
    ["hf-mirror", "https://hf-mirror.com", "default", "cached-login"],
  );
  const scope = jobByLegacy(doc, "mig-l-modelscope");
  assert.equal(scope.transfer.options.source, "modelscope");
  assert.equal(scope.transfer.cli, "modelscope");
  // A tokenRef into a manager's memory cannot be recovered.
  const token = jobByLegacy(doc, "mig-v-running");
  assert.deepEqual(
    [token.transfer.options.credentialMode, token.transfer.options.tokenRef, token.transfer.options.remember],
    ["temp-token", null, false],
  );
  assert.equal(JSON.stringify(doc).includes("dlt_00112233445566778899aabbccddeeff"), false, "the legacy tokenRef is not kept");
});

test("settings-v1: vLLM wins, and hub settings that already exist are never overwritten", async (t) => {
  const world = makeWorld(t);
  await world.migrate();
  const saved = world.settings.get();
  assert.equal(saved.transfer.maxConcurrent, 1, "queueMode true from the vLLM file");
  assert.equal(saved.retry.maxAttempts, 3);
  assert.equal(saved.retry.baseDelaySeconds, 20);
  assert.equal(saved.sources.policy, "huggingface", "vLLM's hfMirror false beats llama's true");
  assert.equal(saved.transfer.xet, "high-performance");
  assert.equal(saved.verify.sha256, true);
  assert.equal(saved.queue.idleOnly, false);

  const other = makeWorld(t);
  await other.store.init();
  const first = await other.settings.update({ retry: { maxAttempts: 7 } });
  assert.equal(first.ok, true);
  const result = await other.migrate();
  assert.equal(other.settings.get().retry.maxAttempts, 7);
  assert.equal(other.settings.get().sources.policy, "huggingface", "the legacy files did not touch the saved settings");
  const step = other.migrations().steps.find((item) => item.id === "settings-v1");
  assert.equal(step.done, true);
  assert.equal(step.counts.reason, "hub-settings-exist");
  assert.ok(result.ran.includes("settings-v1"));
});

test("a rerun is idempotent: nothing runs, nothing is written, nothing is imported twice", async (t) => {
  const world = makeWorld(t);
  await world.migrate();
  const downloads = fs.readFileSync(path.join(world.dataDir, "downloads.json"), "utf8");
  const migrations = fs.readFileSync(path.join(world.dataDir, "migrations.json"), "utf8");
  const snapshots = fs.readdirSync(world.store.migrationDir).sort();
  const published = world.events.published.length;

  const again = await world.migrate();
  assert.deepEqual(again.ran, []);
  assert.deepEqual(again.skipped, STEP_IDS);
  assert.equal(fs.readFileSync(path.join(world.dataDir, "downloads.json"), "utf8"), downloads);
  assert.equal(fs.readFileSync(path.join(world.dataDir, "migrations.json"), "utf8"), migrations);
  assert.deepEqual(fs.readdirSync(world.store.migrationDir).sort(), snapshots);
  assert.equal(world.events.published.length, published, "no second notification");

  // Even with the step records gone, legacyIds keep the jobs from doubling.
  fs.rmSync(path.join(world.dataDir, "migrations.json"));
  const third = await world.migrate();
  assert.equal(world.downloads().jobs.length, LEDGER_IDS.length);
  assert.equal(world.migrations().steps.find((step) => step.id === "ledgers-v1").counts.imported, 0);
  assert.equal(world.migrations().steps.find((step) => step.id === "ledgers-v1").counts.alreadyImported, LEDGER_IDS.length);
  assert.deepEqual(third.failed, []);
});

test("snapshots are written and the managers' files are unchanged byte for byte", async (t) => {
  const world = makeWorld(t);
  const before = world.managerHashes();
  await world.migrate();
  assert.deepEqual(world.managerHashes(), before, "content and mtime of every manager file");

  const names = fs.readdirSync(world.store.migrationDir).sort();
  assert.equal(names.length, 4);
  for (const [id, files] of Object.entries(world.managers)) {
    for (const [kind, base] of [["ledger", "jobs-ledger"], ["settings", "download-settings"]]) {
      const name = names.find((item) => item.startsWith(`${id}-${base}.`));
      assert.ok(name, `${id} ${base} snapshot`);
      assert.match(name, /^(vllm|llama)-[a-z-]+\.2026-10-14T08-00-00\.000Z\.json$/);
      assert.equal(sha256File(path.join(world.store.migrationDir, name)), before[`${id}.${kind}`].sha);
    }
  }
});

test("the notification is emitted once with the imported and paused counts", async (t) => {
  const world = makeWorld(t);
  await world.migrate();
  const notes = world.events.of("notification");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].payload.kind, "hub.migration.imported");
  assert.equal(notes[0].payload.severity, "info");
  assert.equal(notes[0].payload.body.en, "Imported 7 downloads from the managers (3 paused)");
  assert.equal(notes[0].payload.body.zh, "已从管理器导入 7 个下载任务（3 个已暂停）");

  const empty = makeWorld(t, { withLedgers: false, withSettings: false });
  await empty.migrate();
  assert.equal(empty.events.of("notification").length, 0, "nothing imported, nothing to announce");
  assert.deepEqual(empty.migrations().steps.map((step) => step.done), [true, true, true, true, true]);
});

test("an unreadable ledger fails its step only; the other manager is imported and a rerun finishes", async (t) => {
  const world = makeWorld(t);
  const good = fs.readFileSync(world.managers.llama.ledger, "utf8");
  fs.writeFileSync(world.managers.llama.ledger, "{ not json");
  const first = await world.migrate();
  assert.deepEqual(first.failed.map((item) => item.id), ["ledgers-v1"]);
  assert.equal(world.downloads().jobs.length, 4, "the vLLM ledger was imported");
  assert.equal(world.migrations().steps.find((step) => step.id === "ledgers-v1").done, false);
  assert.equal(world.events.of("notification").length, 0, "no notification before the import is complete");
  assert.equal(fs.readFileSync(world.managers.llama.ledger, "utf8"), "{ not json", "the broken manager file is left alone");

  fs.writeFileSync(world.managers.llama.ledger, good);
  const second = await world.migrate();
  assert.deepEqual(second.failed, []);
  assert.equal(world.downloads().jobs.length, LEDGER_IDS.length);
  const ledgers = world.migrations().steps.find((step) => step.id === "ledgers-v1");
  assert.equal(ledgers.done, true);
  assert.equal(ledgers.counts.imported, LEDGER_IDS.length, "the counts add up across the two runs");
  assert.equal(world.events.of("notification").length, 1);
});

test("mapLegacyJob refuses records that are not downloads or have no absolute target", () => {
  assert.equal(mapLegacyJob({ id: "a", type: "serve", meta: {} }), null);
  assert.equal(mapLegacyJob({ id: "a", type: "download", status: "queued", meta: { localDir: "relative/dir" } }), null);
  assert.equal(mapLegacyJob({ type: "download", meta: { localDir: path.resolve("x") } }), null);
});

test("secrets in legacy logs and errors are redacted on import", async (t) => {
  const world = makeWorld(t);
  const ledger = JSON.parse(fs.readFileSync(world.managers.vllm.ledger, "utf8"));
  const failed = ledger.jobs.find((job) => job.id === "mig-v-uncoded");
  failed.logs.push("Authorization: Bearer hf_fakeMigrationTokenForTestsOnly000000");
  failed.error = "failed with HF_TOKEN=hf_fakeMigrationTokenForTestsOnly000000";
  fs.writeFileSync(world.managers.vllm.ledger, JSON.stringify(ledger));
  await world.migrate();
  const text = fs.readFileSync(path.join(world.dataDir, "downloads.json"), "utf8");
  assert.equal(text.includes("hf_fakeMigrationTokenForTestsOnly"), false);
  assert.ok(text.includes("<redacted>"));
});

// --- the hub: start-up wiring, resume of an unrecoverable token, rollback ---------

function makeHub(world, extra = {}) {
  return createModelHub({
    aiRoot: world.root,
    dataDir: world.dataDir,
    env: {},
    logger: world.logger,
    heartbeatMs: 3_600_000,
    store: world.store,
    modelStorage: world.modelStorage,
    fsStore: createModelFilesystemStore({ storage: world.modelStorage, modelsRoot: world.modelsRoot, hfCache: path.join(world.root, "cache", "huggingface"), listRoots: () => world.modelStorage.roots() }),
    events: world.events,
    transferEngine: fakeEngine(),
    verifier: { verifyArtifact: async () => ({ ok: true }) },
    clock: fakeClock(),
    libraryOptions: { watchMs: 0 },
    ...extra,
  });
}

test("the hub imports at start; an unrecoverable tokenRef gives waiting/auth on resume", async (t) => {
  const world = makeWorld(t);
  // The finished download's folder exists, so the library step links it.
  const ready = path.join(world.modelsRoot, "example-org-Example-8B");
  fs.mkdirSync(ready, { recursive: true });
  fs.writeFileSync(path.join(ready, "config.json"), "{}");
  fs.writeFileSync(path.join(ready, "model.safetensors"), Buffer.alloc(64, "x"));

  const hub = makeHub(world);
  await hub.start();
  t.after(() => hub.stop());
  assert.equal(hub.state, "running");
  assert.equal(hub.status().migration.done, true);
  assert.equal(world.events.of("notification").filter((item) => item.payload.kind === "hub.migration.imported").length, 1);

  const listed = hub.jobs.list({ include: "terminal", limit: 50 });
  assert.equal(listed.jobs.length, LEDGER_IDS.length);
  const paused = hub.jobs.get("mig-v-running");
  assert.equal(paused.state, "paused", "jobs resolve by their legacy id");
  assert.equal(paused.pausedBy, "migration");

  await assert.rejects(hub.jobs.resume("mig-v-running"), (error) => error.code === "hf_token_expired" && error.status === 409);
  const after = hub.jobs.get("mig-v-running");
  assert.equal(after.state, "waiting");
  assert.equal(after.waitReason, "auth");
  assert.ok(world.events.of("notification").some((item) => item.payload.kind === "hub.download.auth"), "the token prompt is emitted");

  // A job without a token resumes normally (the fake engine is not started
  // because the pump only schedules; the state change is what we check).
  const resumed = await hub.jobs.resume("mig-l-queued");
  assert.equal(resumed.pausedBy, null, "a job without a token resume is accepted");

  // The finished download is linked to its library entry.
  const job = hub.jobs.get("mig-v-ready");
  await hub.stop();
  const doc = world.downloads();
  const stored = jobByLegacy(doc, "mig-v-ready");
  assert.equal(stored.state, "ready");
  assert.ok(stored.result?.libraryEntryId, "ready jobs are linked to library entries");
  assert.equal(job.id, stored.id);
});

test("the rollback flag makes POST /downloads answer 409 hub_disabled and imports nothing", async (t) => {
  const world = makeWorld(t);
  const hub = makeHub(world, { env: { AI_HUB_DOWNLOADS_OWNER: "manager" } });
  await hub.start();
  t.after(() => hub.stop());
  assert.equal(hub.config().downloadsOwner, "manager");
  await assert.rejects(
    hub.enqueue({ repo: "example-org/Example-8B-GGUF" }),
    (error) => error.code === "hub_disabled" && error.status === 409,
  );
  assert.equal(fs.existsSync(path.join(world.dataDir, "migrations.json")), false, "the managers keep their controllers: no import");
  assert.equal(hub.status().migration.done, false);
  assert.equal(world.events.of("notification").length, 0);
});

test("the migration module never defines a redact helper or writes outside the hub data directory", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "model-hub", "migrate.js"), "utf8");
  assert.equal(/function\s+redact\w*\s*\(/.test(source), false);
  assert.equal(/writeFile(?:Sync)?\([^)]*(?:ledger|settings)\b/.test(source), false);
});
