"use strict";

// ENG-20 (01-engines §22): v1 launch profiles read as before and are written
// as v2 with their flat config kept (the v1 file is saved once), recent
// launches enter LaunchStore exactly once, and a sleep record that only has a
// flat config still wakes.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../index");
const { createLaunchStore } = require("../engines/launch-store");
const { createIdleUnloadController } = require("../idle-unload");
const { legacyProfileToV2 } = require("../engines/legacy-aliases");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJsonFile = async (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJsonFile = async (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// The managers' normalizeLaunchProfile reduced to its shape: id, name,
// description, source, updatedAt and a config that passes through.
function normalizeLaunchProfile(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name || "").trim();
  if (!name) return null;
  return {
    id: String(value.id || name),
    name,
    description: String(value.description || ""),
    source: value.source === "builtin" ? "builtin" : "user",
    updatedAt: value.updatedAt || "2026-01-01T00:00:00.000Z",
    config: { ...(value.config || {}) },
  };
}

const V1_CONFIG = {
  model: "C:/fixture/models/Qwen-A",
  engine: "vllm",
  name: "qwen-a",
  port: 8000,
  maxModelLen: 32768,
  maxNumSeqs: 4,
  gpuMemoryUtilization: 0.9,
};
const V1_FILE = {
  version: 1,
  updatedAt: "2026-01-02T00:00:00.000Z",
  profiles: [{
    id: "p-one", name: "One", description: "fixture", source: "user",
    updatedAt: "2026-01-01T00:00:00.000Z", config: V1_CONFIG,
  }],
};

function makeProfiles(dir, extra = {}) {
  const file = path.join(dir, "launch-profiles.json");
  const store = core.createLaunchProfilesStore({
    file,
    readJsonFile,
    writeJsonFile,
    normalizeLaunchProfile,
    defaultLaunchProfiles: () => [],
    makeProfileId: (name) => String(name).toLowerCase().replace(/\W+/g, "-"),
    toV2: (profile) => core.engines.legacyProfileToV2(profile, { managerId: "vllm-manager" }),
    ...extra,
  });
  return { file, store };
}

test("a v1 profile file reads exactly as before", async (t) => {
  const dir = tempDir(t);
  const { file, store } = makeProfiles(dir);
  fs.writeFileSync(file, JSON.stringify(V1_FILE));
  const read = await store.getLaunchProfiles();
  assert.deepEqual(read.profiles, V1_FILE.profiles);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(V1_FILE), "reading never rewrites the file");
});

test("the first write stores v2 entries with config kept and saves the v1 file once", async (t) => {
  const dir = tempDir(t);
  const { file, store } = makeProfiles(dir);
  const original = JSON.stringify(V1_FILE);
  fs.writeFileSync(file, original);
  const saved = await store.saveLaunchProfile({ name: "Two", config: { ...V1_CONFIG, name: "two", maxModelLen: 65536 } });
  // The API answer keeps the v1 shape.
  assert.deepEqual(Object.keys(saved.profile).sort(), ["config", "description", "id", "name", "source", "updatedAt"]);

  const backup = path.join(dir, "launch-profiles.v1.bak.json");
  assert.equal(fs.readFileSync(backup, "utf8"), original);

  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.profiles.length, 2);
  for (const entry of written.profiles) {
    assert.equal(entry.schemaVersion, 2);
    assert.equal(entry.engineId, "vllm");
    assert.equal(typeof entry.catalogVersion, "string");
    assert.equal(entry.values.contextLength, entry.config.maxModelLen);
  }
  const untouched = written.profiles.find((entry) => entry.id === "p-one");
  assert.deepEqual(untouched.config, V1_CONFIG, "config is kept");

  // The backup is created once: a later write leaves it alone.
  await store.saveLaunchProfile({ name: "Three", config: V1_CONFIG });
  await store.deleteLaunchProfile("p-one");
  assert.equal(fs.readFileSync(backup, "utf8"), original);

  // v2 entries read back through the same v1 view.
  const read = await store.getLaunchProfiles();
  assert.ok(read.profiles.every((entry) => !("values" in entry) && !("schemaVersion" in entry)));
});

test("a file that is already v2 is not backed up", async (t) => {
  const dir = tempDir(t);
  const { file, store } = makeProfiles(dir);
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: V1_FILE.profiles.map((p) => legacyProfileToV2(p, { managerId: "vllm-manager" })) }));
  await store.saveLaunchProfile({ name: "Two", config: V1_CONFIG });
  assert.equal(fs.existsSync(path.join(dir, "launch-profiles.v1.bak.json")), false);
});

test("without toV2 the profile file keeps its v1 form", async (t) => {
  const dir = tempDir(t);
  const { file, store } = makeProfiles(dir, { toV2: null });
  await store.saveLaunchProfile({ name: "Two", config: V1_CONFIG });
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal("schemaVersion" in written.profiles[0], false);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test("an unconvertible profile is written unchanged", () => {
  const odd = { id: "x", name: "X", config: { model: "m", engine: "no-such-engine" } };
  assert.deepEqual(legacyProfileToV2(odd, { managerId: "vllm-manager" }), odd);
});

const recentEntries = [
  {
    model: "C:/fixture/models/Qwen-B", name: "qwen-b", launchedAt: "2026-01-03T10:00:00.000Z",
    containerName: "vllm-local-b", instanceMode: "parallel", instanceId: "b",
    config: { ...V1_CONFIG, model: "C:/fixture/models/Qwen-B", name: "qwen-b", port: 8001 },
  },
  { model: V1_CONFIG.model, name: "qwen-a", launchedAt: "2026-01-02T10:00:00.000Z", config: V1_CONFIG },
];

test("recent launches are imported into LaunchStore exactly once", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "launch-store.json");
  const open = () => createLaunchStore({ file, managerId: "vllm-manager" });

  const first = open();
  assert.deepEqual(first.importRecentLaunches(recentEntries), { imported: 2, already: false });
  assert.deepEqual(first.importRecentLaunches(recentEntries), { imported: 0, already: true });
  assert.equal(first.list().length, 2);
  assert.ok(first.list().every((record) => record.source === "migration" && record.status === "stopped"));
  await first.flush();

  // A restart reads the marker back.
  const second = open();
  assert.deepEqual(second.importRecentLaunches(recentEntries), { imported: 0, already: true });
  assert.equal(second.list().length, 2);

  // The legacy view keeps the entry fields, including the P0-RT-2 ones.
  const view = second.toRecentLaunches(8);
  assert.deepEqual(view.map((entry) => entry.name), ["qwen-b", "qwen-a"]);
  assert.equal(view[0].containerName, "vllm-local-b");
  assert.equal(view[0].instanceMode, "parallel");
  assert.equal(view[0].instanceId, "b");
  assert.equal(view[0].launchedAt, recentEntries[0].launchedAt);
  assert.equal(view[0].config.maxModelLen, V1_CONFIG.maxModelLen);

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.ok(stored.migrations.recentLaunches);
});

test("an empty recent-launches file still marks the migration done", () => {
  const store = createLaunchStore({ managerId: "vllm-manager" });
  assert.deepEqual(store.importRecentLaunches([]), { imported: 0, already: false });
  assert.equal(store.importRecentLaunches(recentEntries).already, true);
});

test("a sleep ledger record with only a flat config wakes", async () => {
  const files = { settings: {}, sleep: { version: 1, sleeping: [{ id: "primary", model: "qwen-a", name: "qwen-a", config: V1_CONFIG }] } };
  const started = [];
  const controller = createIdleUnloadController({
    settingsFile: "settings",
    sleepFile: "sleep",
    engine: "vllm",
    readJsonFile: async (file, fallback) => (file === "settings" ? files.settings : files.sleep) ?? fallback,
    writeJsonFile: async (file, value) => { if (file === "settings") files.settings = value; else files.sleep = value; },
    listInstances: async () => [],
    stopInstance: async () => {},
    startRuntime: async (config) => { started.push(config); return { id: "job-1" }; },
    now: () => 0,
    log: () => {},
  });
  await controller.wake("primary", { confirmReplace: true });
  assert.equal(started.length, 1);
  assert.equal(started[0].model, V1_CONFIG.model);
  assert.equal(started[0].maxModelLen, V1_CONFIG.maxModelLen);

  // The same flat config converts to a spec the store can keep.
  const store = createLaunchStore({ managerId: "vllm-manager" });
  const spec = store.specFromLegacyConfig(V1_CONFIG);
  assert.equal(spec.engineId, "vllm");
  assert.equal(store.configFromSpec(spec).maxModelLen, V1_CONFIG.maxModelLen);
});
