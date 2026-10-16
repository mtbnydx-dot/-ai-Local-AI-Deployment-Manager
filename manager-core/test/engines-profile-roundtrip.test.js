"use strict";

// Exercise each manager's real normalizer and its configured profile store,
// without listening, loading host state, or starting any external process.
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, mock } = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-roundtrip-"));
const savedEnv = { ...process.env };
const managedEnv = /^(?:AI|VLLM|SGLANG|LLAMA|HF|HUGGINGFACE|MODEL|MODELSCOPE|DOCKER|DEVTOOLS|WSL|OPEN_WEBUI|PYTHON|MANAGER|SERVICE_ENTRY|PLATFORM)_/i;
for (const name of Object.keys(process.env)) if (managedEnv.test(name)) delete process.env[name];
Object.assign(process.env, {
  AI_ROOT: root,
  AI_REFERENCE_DATA_DIR: root,
  AI_FRONTEND_SMOKE: "1",
  PLATFORM_CONFIG_FILE: path.join(root, "config", "platform.json"),
  VLLM_MANAGER_STATE_DIR: path.join(root, "vllm"),
  LLAMA_MANAGER_STATE_DIR: path.join(root, "llama"),
  VLLM_MODELS_ROOT: path.join(root, "models"),
  LLAMA_MODELS_ROOT: path.join(root, "models"),
  MODEL_STORAGE_FILE: path.join(root, "model-storage.json"),
  MODEL_GPU_ADMISSION_ROOT: path.join(root, "gpu-admission"),
});
fs.mkdirSync(path.join(root, "models"), { recursive: true });

const unexpectedIo = () => { throw new Error("Profile tests must not call external services or processes."); };
mock.method(globalThis, "fetch", unexpectedIo);
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) mock.method(childProcess, name, unexpectedIo);

const core = require("../index");
const createStore = core.createLaunchProfilesStore;
const managers = new Map();
mock.method(core, "createLaunchProfilesStore", (options) => {
  const store = createStore(options);
  managers.set(path.basename(path.dirname(path.dirname(options.file))), { store, options });
  return store;
});
require("../../vllm-manager/server");
require("../../llama-manager/server");

test.after(() => {
  mock.restoreAll();
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

const VERSION = "2026-10-10+2026-10-09";
const PRIVATE = "TESTONLY-profile-private-value";
for (const [managerId, engineId, legacyEngine] of [["vllm", "vllm", "vllm"], ["llama", "llamacpp", "llama.cpp"]]) {
  test(`${managerId}: v2 sparse values, recipe and catalog version survive save, disk and a fresh read`, async () => {
    const { store, options } = managers.get(managerId);
    const input = {
      name: `${managerId} v2`,
      schemaVersion: 2,
      engineId,
      recipeId: "example-recipe",
      catalogVersion: VERSION,
      values: {
        contextLength: 65536,
        concurrency: { value: 2, source: "user" },
        apiKey: PRIVATE,
        hfToken: PRIVATE,
        unknownParameter: PRIVATE,
      },
      config: {
        model: path.join(root, "models", "example"),
        engine: legacyEngine,
        name: "example-served",
        port: 8001,
        maxModelLen: 4096,
        maxNumSeqs: 8,
        apiKey: PRIVATE,
        hfToken: PRIVATE,
        unknownField: PRIVATE,
      },
      unknownField: PRIVATE,
    };
    const saved = await store.saveLaunchProfile(input);
    const assertProfile = (profile) => {
      assert.equal(profile.schemaVersion, 2);
      assert.equal(profile.engineId, engineId);
      assert.equal(profile.recipeId, "example-recipe");
      assert.equal(profile.catalogVersion, VERSION);
      assert.deepEqual(profile.values, { contextLength: 65536, concurrency: 2 });
      assert.equal(profile.config.maxModelLen, 65536);
      assert.equal(profile.config.maxNumSeqs, 2);
      assert.equal(profile.config.model, input.config.model);
      assert.equal(profile.config.name, "example-served");
      assert.equal(profile.config.port, 8001);
      assert.equal(JSON.stringify(profile).includes(PRIVATE), false, "private and unknown input fields are excluded");
    };
    assertProfile(saved.profile);
    const raw = fs.readFileSync(options.file, "utf8");
    assert.equal(raw.includes(PRIVATE), false, "no private value reaches the profile file");
    const disk = JSON.parse(raw).profiles.find((profile) => profile.id === saved.profile.id);
    assertProfile(disk);

    // A new store must reconstruct the same values rather than normalize only
    // the legacy fallback config or depend on an in-memory save result.
    const reopened = createStore(options);
    const read = await reopened.getLaunchProfiles();
    assertProfile(read.profiles.find((profile) => profile.id === saved.profile.id));
    assert.equal(fs.readFileSync(options.file, "utf8"), raw, "reading does not rewrite profiles");
  });

  test(`${managerId}: a legacy config-only client retains its normalized config without a supplied catalog version`, async () => {
    const { store, options } = managers.get(managerId);
    const saved = await store.saveLaunchProfile({
      name: `${managerId} legacy`,
      config: {
        model: path.join(root, "models", "legacy"),
        engine: legacyEngine,
        maxModelLen: 32768,
        maxNumSeqs: 3,
        apiKey: PRIVATE,
        unknownField: PRIVATE,
      },
    });
    assert.deepEqual(Object.keys(saved.profile).sort(), ["config", "description", "id", "name", "source", "updatedAt"]);
    assert.equal(saved.profile.config.maxModelLen, 32768);
    assert.equal(saved.profile.config.maxNumSeqs, 3);
    assert.equal(JSON.stringify(saved.profile).includes(PRIVATE), false);
    const disk = JSON.parse(fs.readFileSync(options.file, "utf8")).profiles.find((profile) => profile.id === saved.profile.id);
    assert.equal(disk.schemaVersion, 2);
    assert.equal(disk.values.contextLength, 32768);
    assert.equal(disk.values.concurrency, 3);
    assert.ok(disk.catalogVersion);
    const reopened = createStore(options);
    const read = (await reopened.getLaunchProfiles()).profiles.find((profile) => profile.id === saved.profile.id);
    assert.deepEqual(read.config, saved.profile.config);
    assert.equal(fs.readFileSync(options.file, "utf8").includes(PRIVATE), false);
  });

  test(`${managerId}: v2 input cannot name an engine hosted by another manager`, async () => {
    const { store, options } = managers.get(managerId);
    const before = fs.readFileSync(options.file, "utf8");
    await assert.rejects(store.saveLaunchProfile({
      name: "Wrong manager",
      schemaVersion: 2,
      engineId: managerId === "vllm" ? "llamacpp" : "vllm",
      values: { contextLength: 65536 },
      catalogVersion: VERSION,
      config: { engine: legacyEngine },
    }), (error) => error.status === 400 && error.code === "unknown_engine");
    assert.equal(fs.readFileSync(options.file, "utf8"), before);
  });
}

test("vllm: v2 engine identity controls the legacy engine field", async () => {
  const { store, options } = managers.get("vllm");
  const saved = await store.saveLaunchProfile({
    name: "SGLang profile",
    schemaVersion: 2,
    engineId: "sglang",
    values: { contextLength: 65536, concurrency: 2 },
    catalogVersion: VERSION,
    config: { engine: "vllm", name: "sglang-served" },
  });
  assert.equal(saved.profile.engineId, "sglang");
  assert.equal(saved.profile.config.engine, "sglang");
  const read = (await createStore(options).getLaunchProfiles()).profiles.find((profile) => profile.id === saved.profile.id);
  assert.equal(read.config.engine, "sglang");
  assert.equal(read.config.name, "sglang-served");
  assert.deepEqual(read.values, { contextLength: 65536, concurrency: 2 });
});
