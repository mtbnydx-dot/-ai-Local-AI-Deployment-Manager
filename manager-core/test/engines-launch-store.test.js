"use strict";

// LaunchStore (01-engines §15, ENG-8): records, retention, the adoption order
// for containers started by older code (launch-id label → container name →
// model path → served name → jobs-ledger meta → partial), deterministic
// adopted ids, the wake plan, and that neither a plaintext key nor a
// calibrations key ever reaches the store file.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../index");
const { createLaunchStore, LAUNCH_ID_PATTERN } = require("../engines/launch-store");

const FIXTURE_KEY = "fixture-launch-store-key-0123456789";
const PRIMARY = "vllm-local";

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "launch-store.json");
}

// A stand-in for the manager's normalizeLaunchConfig: a fixed field set.
function normalizeConfig(config = {}) {
  return {
    model: String(config.model || ""),
    engine: String(config.engine || "vllm"),
    name: String(config.name || ""),
    port: Number(config.port || 8000),
    maxModelLen: Number(config.maxModelLen || 8192),
    maxNumSeqs: Number(config.maxNumSeqs || 4),
    networkAccess: config.networkAccess === "lan" ? "lan" : "local",
    gpuDeviceIds: Array.isArray(config.gpuDeviceIds) ? config.gpuDeviceIds.map(String) : [],
  };
}

function makeStore(t, extra = {}) {
  const file = extra.file === undefined ? tempFile(t) : extra.file;
  let seed = 0;
  const store = createLaunchStore({
    file,
    managerId: "vllm-manager",
    normalizeConfig,
    toContainerPath: (value) => String(value).replace(/^C:\/fixture\/models/i, "/models"),
    secretValues: () => [FIXTURE_KEY],
    // Deterministic launch ids for the test.
    random: (size) => Buffer.alloc(size, (seed += 1)),
    ...extra,
  });
  return { store, file };
}

const runOptions = {
  model: "C:/fixture/models/Qwen-A",
  engine: "vllm",
  name: "qwen-a",
  port: 8000,
  maxModelLen: 32768,
  maxNumSeqs: 4,
  instanceMode: "replace",
  instanceId: "qwen-a",
  containerName: PRIMARY,
  networkAccess: "local",
  gpuDeviceIds: ["0"],
  runtimeApiKeyRef: "fixture-ref-0001",
  vllmApiKey: FIXTURE_KEY,
};

test("create, get, list and update keep a launch record with a lch_ id", async (t) => {
  const { store, file } = makeStore(t);
  const job = { id: "job-1", meta: { model: runOptions.model } };
  const launchId = store.beginLaunch(job, runOptions);
  assert.match(launchId, LAUNCH_ID_PATTERN);
  assert.equal(job.meta.launchId, launchId, "the id is stamped into job.meta for the builder");
  assert.equal(store.beginLaunch(job, runOptions), launchId, "one record per job, also on a retry");

  const record = store.get(launchId);
  assert.equal(record.status, "starting");
  assert.equal(record.source, "api");
  assert.equal(record.jobId, "job-1");
  assert.equal(record.containerName, PRIMARY);
  assert.equal(record.spec.engineId, "vllm");
  assert.deepEqual(record.spec.model, { ref: runOptions.model, servedName: "qwen-a", contentDigest: null });
  assert.deepEqual(record.spec.instance, { mode: "replace", id: "qwen-a", port: 8000, networkAccess: "local", gpuIds: ["0"] });
  assert.equal(record.spec.values.contextLength, 32768);
  assert.equal(record.spec.values.concurrency, 4);
  assert.deepEqual(record.spec.secrets, { apiKeyRef: "fixture-ref-0001" });

  store.recordCommand(launchId, [
    "run", "-d", "--name", PRIMARY, "--label", `ai.manager.launch-id=${launchId}`,
    "--label", "ai.manager.engine-id=sglang", "--label", "ai.manager.recipe=qwen38-flashnext-262k",
    "--label", "ai.manager.runtime-id=sglang@qwen38flashnext-sm120-dac5523d", "image:tag", "--api-key", FIXTURE_KEY,
  ]);
  const ready = store.markStatus(launchId, "running", { event: "ready" });
  assert.equal(ready.status, "running");
  assert.equal(ready.spec.engineId, "sglang");
  assert.equal(ready.spec.recipeId, "qwen38-flashnext-262k");
  assert.equal(ready.spec.runtimeId, "sglang@qwen38flashnext-sm120-dac5523d");
  assert.deepEqual(ready.history.map((entry) => entry.event), ["started", "ready"]);
  assert.equal(store.list({ status: "running" }).length, 1);
  assert.equal(store.list({ status: "failed" }).length, 0);

  await store.flush();
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(FIXTURE_KEY), false, "the key never reaches the store file");
  assert.ok(text.includes("<redacted>"), "the argv secret is redacted");
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.launches[0].launchId, launchId);

  // A second store reads the file back.
  const reopened = makeStore(t, { file }).store;
  assert.equal(reopened.get(launchId).status, "running");
});

test("a newer running launch supersedes the old record of the same container", (t) => {
  const { store } = makeStore(t, { file: "" });
  const first = store.beginLaunch({ id: "job-1", meta: {} }, runOptions);
  store.markStatus(first, "running", { event: "ready" });
  const second = store.beginLaunch({ id: "job-2", meta: {} }, { ...runOptions, model: "C:/fixture/models/Qwen-B", name: "qwen-b" });
  store.markStatus(second, "running", { event: "ready" });
  assert.equal(store.get(first).status, "stopped");
  assert.equal(store.get(first).history.at(-1).detail, `replaced by ${second}`);
  assert.equal(store.get(second).status, "running");
});

test("retention evicts the oldest records but never a starting, running or sleeping one", (t) => {
  const { store } = makeStore(t, { file: "", maxRecords: 3 });
  const sleeping = store.create({ engineId: "vllm" }, { status: "sleeping" }).launchId;
  const running = store.create({ engineId: "vllm" }, { status: "running" }).launchId;
  const old = store.create({ engineId: "vllm" }, { status: "stopped" }).launchId;
  const failed = store.create({ engineId: "vllm" }, { status: "failed" }).launchId;
  const newest = store.create({ engineId: "vllm" }, { status: "stopped" }).launchId;
  assert.equal(store.list({ limit: 10 }).length, 3);
  assert.ok(store.get(sleeping));
  assert.ok(store.get(running));
  assert.ok(store.get(newest));
  assert.equal(store.get(old), null);
  assert.equal(store.get(failed), null);
});

test("a launch still starting when the manager stopped is read back as failed", async (t) => {
  const { store, file } = makeStore(t);
  const launchId = store.beginLaunch({ id: "job-1", meta: {} }, runOptions);
  await store.flush();
  const record = makeStore(t, { file }).store.get(launchId);
  assert.equal(record.status, "failed");
  assert.equal(record.history.at(-1).detail, "interrupted");
});

test("no calibrations key and no plaintext secret is ever written", async (t) => {
  const { store, file } = makeStore(t);
  const launchId = store.create({
    engineId: "vllm",
    model: { ref: "C:/fixture/models/Qwen-A", servedName: "qwen-a" },
    values: { contextLength: 4096, apiKey: FIXTURE_KEY, calibrations: { x: 1 } },
    extraEnv: { HF_TOKEN: FIXTURE_KEY, SAFE: "1" },
    secrets: { apiKeyRef: "fixture-ref-0002", apiKey: FIXTURE_KEY },
    calibrations: [{ measured: 1 }],
  }, { resolved: { calibrations: { measured: 1 }, note: `key ${FIXTURE_KEY}` } }).launchId;
  store.appendEvent(launchId, { event: "failed", detail: `docker said ${FIXTURE_KEY}` });
  store.update(launchId, { spec: { secrets: { apiKeyRef: "fixture-ref-0003" } } });
  await store.flush();
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(FIXTURE_KEY), false);
  assert.equal(text.includes("calibrations"), false);
  const record = store.get(launchId);
  assert.deepEqual(record.spec.values, { contextLength: 4096 });
  assert.deepEqual(record.spec.extraEnv, { SAFE: "1" });
  assert.deepEqual(record.spec.secrets, { apiKeyRef: "fixture-ref-0003" });
});

// ---- Adoption (§15.1) -------------------------------------------------------

const byContainer = {
  model: "C:/fixture/models/by-container", name: "served-a", containerName: "vllm-local-b", instanceMode: "parallel", instanceId: "b",
  config: { model: "C:/fixture/models/by-container", name: "served-a", port: 8012, maxModelLen: 16384 },
};
const byPath = {
  model: "C:/fixture/models/by-path", name: "served-path",
  config: { model: "C:/fixture/models/by-path", name: "served-path", port: 8013 },
};
const byServed = {
  model: "C:/fixture/models/by-served", name: "served-x",
  config: { model: "C:/fixture/models/by-served", name: "served-x", port: 8014 },
};
const recentLaunches = [byPath, byServed, byContainer];
const ledgerJob = {
  id: "job-ledger",
  meta: { model: "C:/fixture/models/from-ledger", name: "ledger-model", engine: "vllm", port: 8015, maxModelLen: 65536, maxNumSeqs: 2, instanceMode: "parallel", instanceId: "led", containerName: "vllm-local-led" },
};
const jobsLedgerLookup = (jobId) => (jobId === ledgerJob.id ? ledgerJob : null);
const lookups = { recentLaunches, jobsLedgerLookup };

test("adoption follows label, container name, path, served name, ledger meta, then partial", (t) => {
  const { store } = makeStore(t, { file: "" });
  const labelled = store.beginLaunch({ id: "job-l", meta: {} }, { ...runOptions, containerName: "vllm-local-b", name: "served-a" });

  // 1. The launch-id label wins over every legacy match.
  const one = store.resolveForInstance({ containerName: "vllm-local-b", model: "served-a", name: "/models/by-path", labels: { "ai.manager.launch-id": labelled } }, lookups);
  assert.equal(one.launchId, labelled);
  assert.equal(one.source, "api");

  // 2. Container name (with an agreeing served name), before a path match.
  const two = store.adopt({ containerName: "vllm-local-b", model: "served-a", name: "/models/by-path", labels: {} }, lookups);
  assert.equal(two.source, "adopted");
  assert.equal(two.spec.model.ref, byContainer.model);
  assert.deepEqual(two.spec.instance, { mode: "parallel", id: "b", port: 8012, networkAccess: "local", gpuIds: [] });
  assert.equal(two.history[0].event, "adopted");
  assert.equal(two.history[0].detail, "recent-launch");

  // 3. Model path (host path mapped to the container path, case-insensitive).
  const three = store.adopt({ containerName: "vllm-local", model: "nope", name: "/MODELS/by-path", labels: {} }, lookups);
  assert.equal(three.spec.model.ref, byPath.model);

  // 4. Served name.
  const four = store.adopt({ containerName: "vllm-local-z", model: "served-x", name: "/models/elsewhere", labels: {} }, lookups);
  assert.equal(four.spec.model.ref, byServed.model);

  // 5. The job label's meta in the jobs ledger.
  const five = store.adopt({ containerName: "vllm-local-led", model: "unknown", name: "/models/unknown", labels: { "ai.manager.job": "job-ledger" } }, lookups);
  assert.equal(five.spec.model.ref, "C:/fixture/models/from-ledger");
  assert.equal(five.spec.values.contextLength, 65536);
  assert.equal(five.jobId, "job-ledger");
  assert.equal(five.partial, undefined);

  // 6. Labels only: partial.
  const six = store.adopt({
    containerName: "vllm-local-q",
    model: "label-only",
    name: "/models/label-only",
    labels: { "ai.manager.model": "label-only", "ai.manager.port": "8016", "ai.manager.gpu-ids": "0,1", "ai.manager.max-model-len": "8192", "ai.manager.max-num-seqs": "3", "ai.manager.engine": "sglang" },
  }, lookups);
  assert.equal(six.partial, true);
  assert.equal(six.spec.engineId, "sglang");
  assert.deepEqual(six.spec.model, { ref: "", servedName: "label-only", contentDigest: null });
  assert.deepEqual(six.spec.instance.gpuIds, ["0", "1"]);
  assert.deepEqual(six.spec.values, { contextLength: 8192, concurrency: 3 });
  assert.equal(store.findWakePlan({ containerName: "vllm-local-q", model: "label-only", name: "/models/label-only", labels: { "ai.manager.model": "label-only" } }, lookups), null,
    "a partial record is not wakeable (launch_config_partial)");
  assert.equal(core.engines.launchStore.LAUNCH_CONFIG_PARTIAL.code, "launch_config_partial");
});

test("adopted ids are deterministic and adoption is idempotent", (t) => {
  const instance = { containerName: "vllm-local", model: "served-x", name: "/models/elsewhere", labels: { "ai.manager.job": "job-old", "ai.manager.model": "served-x" } };
  const first = makeStore(t, { file: "" }).store;
  const second = makeStore(t, { file: "" }).store;
  const a = first.adopt(instance, lookups);
  const b = second.adopt(instance, lookups);
  assert.match(a.launchId, LAUNCH_ID_PATTERN);
  assert.equal(a.launchId, b.launchId);
  assert.equal(first.adopt(instance, lookups).launchId, a.launchId);
  assert.equal(first.list({ limit: 10 }).length, 1);
  const other = first.adopt({ ...instance, containerName: "vllm-local-other" }, lookups);
  assert.notEqual(other.launchId, a.launchId);
});

test("findWakePlan: label record rebuilds the legacy config; legacy matches return P0's config and placement", (t) => {
  const { store } = makeStore(t, { file: "" });
  const job = { id: "job-w", meta: {} };
  const launchId = store.beginLaunch(job, { ...runOptions, instanceMode: "parallel", instanceId: "side", containerName: "vllm-local-side", port: 8011 });
  store.markStatus(launchId, "running", { event: "ready" });
  const labelled = store.findWakePlan({ containerName: "vllm-local-side", model: "qwen-a", labels: { "ai.manager.launch-id": launchId } }, { recentLaunches: [byContainer] });
  assert.equal(labelled.launchId, launchId);
  assert.deepEqual(labelled.config, normalizeConfig({ ...runOptions, port: 8011 }));
  assert.deepEqual(labelled.placement, { instanceMode: "parallel", instanceId: "side", containerName: "vllm-local-side" });
  assert.equal(labelled.spec.secrets.apiKeyRef, "fixture-ref-0001");

  // P0 order: the recent-launch config itself, untouched, and its placement.
  const legacy = store.findWakePlan({ containerName: "vllm-local-b", model: "served-a", name: "/models/x", labels: {} }, lookups);
  assert.equal(legacy.config, byContainer.config);
  assert.deepEqual(legacy.placement, { instanceMode: "parallel", instanceId: "b", containerName: "vllm-local-b" });
  assert.match(legacy.launchId, LAUNCH_ID_PATTERN);
  assert.equal(store.get(legacy.launchId).source, "adopted");
  // A legacy entry without placement takes where the instance runs.
  const primary = store.findWakePlan({ id: "primary", containerName: "vllm-local", instanceMode: "replace", model: "served-x", labels: {} }, lookups);
  assert.deepEqual(primary.placement, { instanceMode: "replace", instanceId: "", containerName: "vllm-local" });
});

test("toRecentLaunches gives the legacy recent-launch entries of launches that became ready", (t) => {
  const { store } = makeStore(t, { file: "", clock: () => Date.parse("2026-10-15T08:00:00.000Z") });
  const ready = store.beginLaunch({ id: "job-1", meta: {} }, runOptions);
  store.markStatus(ready, "running", { event: "ready", patch: { containerName: PRIMARY } });
  store.beginLaunch({ id: "job-2", meta: {} }, { ...runOptions, model: "C:/fixture/models/never-ready", name: "never" });
  assert.deepEqual(store.toRecentLaunches(8), [{
    model: runOptions.model,
    name: "qwen-a",
    launchedAt: "2026-10-15T08:00:00.000Z",
    containerName: PRIMARY,
    instanceMode: "replace",
    instanceId: "qwen-a",
    config: normalizeConfig(runOptions),
  }]);
});

test("a spec rebuilds exactly the flat config every builtin profile launches with", () => {
  const harness = require("./helpers/engine-golden-stubs");
  harness.prepareGoldenEnvironment();
  const { createVllmDefaultLaunchProfiles } = require("../../vllm-manager/lib/default-profiles");
  const { createLlamaDefaultLaunchProfiles } = require("../../llama-manager/lib/default-profiles");
  const vllm = harness.loadServer("vllm").internals.normalizeLaunchConfig;
  const llama = harness.loadServer("llama").server.normalizeLaunchConfig;
  const sets = [
    ["vllm-manager", vllm, createVllmDefaultLaunchProfiles(vllm)],
    ["llama-manager", llama, createLlamaDefaultLaunchProfiles(llama)],
  ];
  let checked = 0;
  for (const [managerId, normalize, profiles] of sets) {
    const store = createLaunchStore({ managerId, normalizeConfig: normalize });
    for (const profile of profiles) {
      const spec = store.specFromLegacyConfig(profile.config);
      assert.deepEqual(store.configFromSpec(spec), normalize(profile.config), profile.id);
      checked += 1;
    }
  }
  assert.equal(checked, 15);
});
