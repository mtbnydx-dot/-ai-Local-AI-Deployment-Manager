"use strict";

// ENG-13 (docs/overhaul/01-engines.md §16.4, §21.1; 00 §4.1 and §9.17): typed
// instances, sleeping records, per-instance logs, launch and relaunch, and
// GET /api/config entryPort. Docker is a fake; nothing is spawned.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEngineRegistry } = require("../engines/registry");
const { createInstanceCatalog, engineIdOfContainer, isHostedContainer } = require("../engines/instances");
const { createLaunchStore } = require("../engines/launch-store");
const { registerEngineRoutes } = require("../engines/routes");
const { createIdleUnloadController, sleepIdOf } = require("../idle-unload");
const { createOwnedRuntimeContainerResolver } = require("../runtime-request-utils");
const { registerManagerRoutes, resolveEntryPort } = require("../manager-routes");

const LAUNCH_ID = "lch_7q2m4k5xwb3d5f6g2h3j";
const SLEEP_ID = /^slp_[a-z2-7]{20}$/;
const FAKE_KEY = ("sk-" + "fixture-not-a-real-key-0001");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eng13-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRegistry(root) {
  return createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
}

function container(overrides = {}) {
  const labels = {
    "ai.manager": "vllm-local",
    "ai.manager.engine": "sglang",
    "ai.manager.engine-id": "sglang",
    "ai.manager.launch-id": LAUNCH_ID,
    "ai.manager.recipe": "qwen38-flashnext-262k",
    "ai.manager.runtime-id": "sglang@0.5.17",
    "ai.manager.job": "job_1",
    ...(overrides.labels || {}),
  };
  return {
    name: "vllm-local",
    image: "example/sglang:0.5.17",
    status: "Up 3 minutes",
    running: true,
    manager: "vllm-local",
    engine: labels["ai.manager.engine"],
    ...overrides,
    labels,
  };
}

// The legacy item as a manager builds it today (vllm-manager legacyRuntimeInstance).
const LEGACY = Object.freeze({
  id: "primary",
  instanceMode: "replace",
  primary: true,
  containerName: "vllm-local",
  running: true,
  status: "Up 3 minutes",
  image: "example/sglang:0.5.17",
  engine: "sglang",
  port: 8000,
  gpuIds: ["0"],
  vramReservationMb: 88000,
  gpuMemoryUtilization: 0.9,
  maxNumBatchedTokens: 0,
  localBaseUrl: "http://127.0.0.1:8000/v1",
  lanBaseUrl: null,
  requestsTotal: 4,
  activeRequests: 0,
  queuedRequests: 0,
  models: [{ id: "qwen3.8", root: "fixture-model", maxModelLen: 262144, requestsTotal: 4, runningRequests: 0, waitingRequests: 0, lastKnown: false }],
});

function catalogKit(t, extra = {}) {
  const root = tempRoot(t);
  const registry = makeRegistry(root);
  const launchStore = createLaunchStore({ file: path.join(root, "launch-store.json"), managerId: "vllm", registry });
  const record = launchStore.create({
    engineId: "sglang",
    runtimeId: "sglang@0.5.17",
    recipeId: "qwen38-flashnext-262k",
    model: { ref: "fixture-model", servedName: "qwen3.8" },
    instance: { mode: "replace", id: "primary", port: 8000, gpuIds: ["0"] },
    values: { contextLength: 262144 },
  }, { launchId: LAUNCH_ID, source: "ui", status: "running", containerName: "vllm-local", resolved: { imageId: `sha256:${"a".repeat(64)}`, argvRedacted: ["run", "-d", "--name", "vllm-local", "-e", "HF_TOKEN=***"] } });
  const jobs = new Map(extra.jobs || []);
  const catalog = createInstanceCatalog({ registry, managerId: "vllm", launchStore, getJob: (id) => jobs.get(id) || null, ...extra.catalog });
  return { root, registry, launchStore, record, catalog, jobs };
}

test("containers are instances when their engine is hosted or unknown, never when unlabelled", (t) => {
  const registry = makeRegistry(tempRoot(t));
  const opts = { registry, managerId: "vllm" };
  assert.equal(engineIdOfContainer(container(), opts), "sglang");
  assert.equal(engineIdOfContainer(container({ labels: { "ai.manager.engine-id": "" , "ai.manager.engine": "vllm" }, engine: "vllm" }), opts), "vllm");
  assert.equal(engineIdOfContainer(container({ labels: { "ai.manager.engine-id": "", "ai.manager.engine": "mystery" }, engine: "mystery" }), opts), "unknown");
  assert.equal(engineIdOfContainer({ labels: {} }, opts), "");
  assert.equal(isHostedContainer(container(), opts), true);
  assert.equal(isHostedContainer(container({ labels: { "ai.manager.engine-id": "", "ai.manager.engine": "mystery" }, engine: "mystery" }), opts), true);
  assert.equal(isHostedContainer({ labels: {} }, opts), false);
  // llama.cpp belongs to the llama manager.
  assert.equal(isHostedContainer(container({ labels: { "ai.manager.engine-id": "llamacpp", "ai.manager.engine": "llama" }, engine: "llama" }), { registry, managerId: "llama" }), true);
  assert.equal(isHostedContainer(container({ labels: { "ai.manager.engine-id": "llamacpp", "ai.manager.engine": "llama" }, engine: "llama" }), opts), false);
});

test("typed fields are added next to the legacy ones and never change them", (t) => {
  const phaseHistory = [{ phase: "container", at: "2026-10-14T08:00:00.000Z", durationMs: 1000 }, { phase: "weights", at: "2026-10-14T08:00:01.000Z", durationMs: 9000 }];
  const { catalog } = catalogKit(t, { jobs: [["job_1", { id: "job_1", status: "success", finishedAt: "2026-10-14T08:00:10.000Z", lifecycle: { phase: "ready", phaseHistory } }]] });
  const typed = catalog.typed(LEGACY, container());
  const merged = { ...LEGACY, ...typed };

  const legacyKeys = Object.keys(LEGACY);
  assert.deepEqual(Object.fromEntries(legacyKeys.map((key) => [key, merged[key]])), { ...LEGACY });
  assert.deepEqual(Object.keys(typed).sort(), ["apiSurface", "capabilities", "capabilitySource", "engineFamily", "engineId", "launchId", "lifecycle", "recipeId", "runtime"]);
  assert.equal(typed.engineId, "sglang");
  assert.equal(typed.engineFamily, "sglang");
  assert.deepEqual(typed.runtime, { id: "sglang@0.5.17", version: typed.runtime.version, image: "example/sglang:0.5.17", digest: `sha256:${"a".repeat(64)}` });
  assert.equal(typed.recipeId, "qwen38-flashnext-262k");
  assert.equal(typed.launchId, LAUNCH_ID);
  assert.deepEqual(typed.lifecycle, { state: "ready", phase: "ready", percent: 100, since: "2026-10-14T08:00:10.000Z", phaseHistory });
  assert.equal(typeof typed.capabilities.text, "boolean");
  assert.equal(typed.capabilities.maxContext, 262144);
  assert.deepEqual(Object.keys(typed.apiSurface), ["chat", "completions", "responses", "messages", "embeddings", "rerank"]);
  // No sleep field on a container.
  assert.equal("sleep" in typed, false);
});

test("lifecycle follows the container and the in-flight job", (t) => {
  const { catalog, jobs } = catalogKit(t);
  jobs.set("job_1", { id: "job_1", status: "running", createdAt: "2026-10-14T08:00:00.000Z", progress: { percent: 42 }, lifecycle: { phase: "weights", phaseHistory: [{ phase: "weights", at: "2026-10-14T08:00:05.000Z", durationMs: null }] } });
  assert.deepEqual(
    (({ state, phase, percent, since }) => ({ state, phase, percent, since }))(catalog.typed(LEGACY, container()).lifecycle),
    { state: "loading", phase: "weights", percent: 42, since: "2026-10-14T08:00:05.000Z" },
  );
  jobs.clear();
  assert.equal(catalog.typed(LEGACY, container({ running: false, status: "Exited (137) 2 minutes ago" })).lifecycle.state, "crashed");
  assert.equal(catalog.typed(LEGACY, container({ running: false, status: "Exited (0) 2 minutes ago" })).lifecycle.state, "stopped");
  assert.deepEqual(catalog.typed(LEGACY, container()).lifecycle.phaseHistory, []);
});

test("an unknown-engine container is typed engineId unknown", (t) => {
  const { catalog } = catalogKit(t);
  const odd = container({ labels: { "ai.manager.engine-id": "", "ai.manager.engine": "mystery", "ai.manager.launch-id": "" }, engine: "mystery" });
  const typed = catalog.typed({ ...LEGACY, id: "odd" }, odd);
  assert.equal(typed.engineId, "unknown");
  assert.equal(typed.engineFamily, "unknown");
  assert.equal(typed.launchId, null);
  assert.equal(catalog.isHosted(odd), true);
  assert.equal(catalog.isKnownEngine(odd), false);
});

test("sleeping records are instance-shaped and carry sleep.id", async (t) => {
  const records = [
    { id: "primary", model: "qwen3.8", name: "fixture-model", engine: "sglang", containerName: "vllm-local", sleptAt: "2026-10-14T09:00:00.000Z", reason: "idle", vramMb: 88000, placement: { instanceMode: "replace" }, hasConfig: true, launchId: LAUNCH_ID },
  ];
  const { catalog } = catalogKit(t, { catalog: { listSleeping: async () => ({ ok: true, sleeping: records }) } });
  const [sleeping] = await catalog.sleeping();
  assert.match(sleeping.sleep.id, SLEEP_ID);
  assert.equal(sleeping.sleep.id, sleepIdOf(records[0]));
  assert.equal(sleeping.id, sleeping.sleep.id);
  assert.deepEqual(sleeping.sleep, { id: sleeping.sleep.id, since: "2026-10-14T09:00:00.000Z", wakeable: true, reason: "idle" });
  assert.equal(sleeping.lifecycle.state, "sleeping");
  assert.deepEqual(sleeping.lifecycle.phaseHistory, []);
  assert.equal(sleeping.running, false);
  assert.equal(sleeping.engineId, "sglang");
  assert.equal(sleeping.launchId, LAUNCH_ID);
  assert.equal(sleeping.recipeId, "qwen38-flashnext-262k");
  assert.equal(sleeping.models[0].id, "qwen3.8");
  // Same sleep, same id; another sleep of the same instance, another id.
  assert.equal(sleepIdOf(records[0]), sleepIdOf({ ...records[0] }));
  assert.notEqual(sleepIdOf(records[0]), sleepIdOf({ ...records[0], sleptAt: "2026-10-14T10:00:00.000Z" }));
  // Without a sleep ledger there is nothing to list.
  assert.deepEqual(await createInstanceCatalog({ registry: makeRegistry(tempRoot(t)), managerId: "vllm" }).sleeping(), []);
});

test("the idle-unload controller wakes and forgets a record by its slp_ id as well as its ledger id", async () => {
  const files = { settings: {}, sleep: { sleeping: [
    { id: "primary", model: "qwen3.8", name: "m", config: { model: "qwen3.8" }, sleptAt: "2026-10-14T09:00:00.000Z" },
    { id: "second", model: "qwen3.8b", name: "m2", config: { model: "qwen3.8b" }, sleptAt: "2026-10-14T09:00:00.000Z" },
  ] } };
  const started = [];
  const controller = createIdleUnloadController({
    settingsFile: "settings",
    sleepFile: "sleep",
    engine: "vllm",
    readJsonFile: async (file, fallback) => (file === "settings" ? files.settings : files.sleep) ?? fallback,
    writeJsonFile: async (file, value) => { if (file === "settings") files.settings = value; else files.sleep = value; },
    listInstances: async () => [],
    stopInstance: async () => {},
    startRuntime: async (config) => { started.push(config.model); return { id: "job-1" }; },
    log: () => {},
  });
  const [first, second] = files.sleep.sleeping;
  const woke = await controller.wake(sleepIdOf(first));
  assert.equal(woke.ok, true);
  assert.deepEqual(started, ["qwen3.8"]);
  assert.equal((await controller.forget(sleepIdOf(second))).ok, true);
  assert.deepEqual((await controller.listSleeping()).sleeping, []);
  await assert.rejects(() => controller.wake("slp_aaaaaaaaaaaaaaaaaaaa"), (error) => error.status === 404);
});

test("the owned-container resolver honours a manager-provided engine test", async () => {
  const odd = container({ name: "vllm-odd", labels: { "ai.manager.engine-id": "", "ai.manager.engine": "mystery", "ai.manager.instance": "odd" }, engine: "mystery" });
  const base = { primaryContainerName: "vllm-local", managerId: "vllm-local", getContainerStatus: async () => ({ exists: false }), listManagedContainers: async () => [odd] };
  assert.equal(await createOwnedRuntimeContainerResolver({ ...base, engines: ["vllm", "sglang"] })("odd"), null);
  assert.equal(await createOwnedRuntimeContainerResolver({ ...base, isRuntimeContainer: () => true })("odd"), "vllm-odd");
});

// ---- routes ---------------------------------------------------------------

function mountRoutes(t, extra = {}) {
  const kit = catalogKit(t);
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) };
  const dockerCalls = [];
  const containers = [container()];
  const started = [];
  const stopped = [];
  const findInstance = async (id) => {
    const found = containers.find((item) => item.name === id || (id === "primary" && item.name === "vllm-local"));
    if (!found) return null;
    const legacy = { ...LEGACY, id: found.name === "vllm-local" ? "primary" : found.name, containerName: found.name };
    return { instance: { ...legacy, ...kit.catalog.typed(legacy, found) }, container: found, state: kit.catalog.stateOf(legacy, found) };
  };
  registerEngineRoutes(app, {
    registry: kit.registry,
    managerId: "vllm",
    isLocalRequest: () => true,
    docker: async (args) => { dockerCalls.push(args); return { stdout: `line one\nAuthorization: Bearer ${FAKE_KEY}\n`, stderr: "" }; },
    resolveLogContainer: createOwnedRuntimeContainerResolver({
      primaryContainerName: "vllm-local",
      managerId: "vllm-local",
      getContainerStatus: async (name) => ({ exists: true, labels: { "ai.manager": "vllm-local" }, name }),
      listManagedContainers: async () => containers,
      isRuntimeContainer: (item) => kit.catalog.isHosted(item),
    }),
    redactLogs: (text) => text.split(FAKE_KEY).join("***"),
    launchStore: kit.launchStore,
    findInstance,
    planLaunch: async () => ({ ok: true, planHash: "sha256:current", errors: [], blockers: [], warnings: [] }),
    startRuntime: async ({ body }) => {
      started.push(body);
      const job = { id: "job_2", meta: {} };
      setTimeout(() => { job.meta.launchId = "lch_aaaaaaaaaaaaaaaaaaaa"; }, 15);
      return { job, plan: { planHash: "sha256:current" } };
    },
    stopInstance: async ({ id }) => { stopped.push(id); },
    apiKeyFor: async () => FAKE_KEY,
    ...extra,
  });
  async function call(method, route, request = {}) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
    await routes.get(`${method} ${route}`)({ params: {}, query: {}, headers: {}, body: {}, ...request }, response);
    return response;
  }
  return { ...kit, call, dockerCalls, containers, started, stopped, routes };
}

test("GET /api/instances/:id/logs uses the owned-container resolver, clamps the tail and redacts", async (t) => {
  const { call, dockerCalls, routes } = mountRoutes(t);
  const ok = await call("GET", "/api/instances/:id/logs", { params: { id: "primary" }, query: { tail: "99999", since: "2026-10-14T08:00:00Z" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(dockerCalls[0], ["logs", "--tail", "5000", "--since", "2026-10-14T08:00:00Z", "vllm-local"]);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.instanceId, "primary");
  assert.equal(ok.body.containerName, "vllm-local");
  assert.equal(ok.body.redacted, true);
  assert.equal(ok.body.truncated, false);
  assert.ok(!ok.body.text.includes(FAKE_KEY));
  assert.ok(ok.body.text.includes("line one"));

  assert.equal((await call("GET", "/api/instances/:id/logs", { params: { id: "primary" } })).body.truncated, false);
  assert.deepEqual(dockerCalls[1].slice(0, 3), ["logs", "--tail", "200"]);
  // A tail as long as the answer may have cut lines off.
  assert.equal((await call("GET", "/api/instances/:id/logs", { params: { id: "primary" }, query: { tail: "2" } })).body.truncated, true);

  const bad = await call("GET", "/api/instances/:id/logs", { params: { id: "primary" }, query: { since: "yesterday-ish" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error.code, "invalid_since");

  const before = dockerCalls.length;
  for (const id of ["not-ours", "../etc", "", "x".repeat(200)]) {
    const unknown = await call("GET", "/api/instances/:id/logs", { params: { id } });
    assert.equal(unknown.statusCode, 404, id);
    assert.equal(unknown.body.error.code, "unknown_instance");
  }
  assert.equal(dockerCalls.length, before, "an unresolved id never reaches docker");
  assert.ok(routes.has("GET /api/instances/:id/launch"));
});

test("an unknown-engine container resolves for logs", async (t) => {
  const { call, containers, dockerCalls } = mountRoutes(t);
  containers.push(container({ name: "vllm-odd", labels: { "ai.manager.engine-id": "", "ai.manager.engine": "mystery", "ai.manager.instance": "odd" }, engine: "mystery" }));
  const response = await call("GET", "/api/instances/:id/logs", { params: { id: "odd" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.containerName, "vllm-odd");
  assert.equal(dockerCalls.at(-1).at(-1), "vllm-odd");
});

test("GET /api/instances/:id/launch returns the redacted record and docker command", async (t) => {
  const { call } = mountRoutes(t);
  const response = await call("GET", "/api/instances/:id/launch", { params: { id: "primary" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.launch.launchId, LAUNCH_ID);
  assert.equal(response.body.launch.spec.engineId, "sglang");
  assert.deepEqual(response.body.command.argv, ["run", "-d", "--name", "vllm-local", "-e", "HF_TOKEN=***"]);
  assert.equal(response.body.command.docker, "docker run -d --name vllm-local -e \"HF_TOKEN=***\"");
  assert.equal((await call("GET", "/api/instances/:id/launch", { params: { id: "missing" } })).body.error.code, "unknown_instance");
});

test("relaunch needs confirm, an administrator and a complete record", async (t) => {
  const { call, started } = mountRoutes(t);
  const noConfirm = await call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: {} });
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.body.error.code, "confirmation_required");
  assert.equal((await call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: "true" } })).statusCode, 400);
  assert.equal(started.length, 0);

  const denied = mountRoutes(t, { isAdminRequest: () => false });
  assert.equal((await denied.call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: true } })).statusCode, 403);
  assert.equal(denied.started.length, 0);

  const missing = await call("POST", "/api/instances/:id/relaunch", { params: { id: "nope" }, body: { confirm: true } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error.code, "unknown_instance");

  const invalid = await call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: true, overrides: "x" } });
  assert.equal(invalid.statusCode, 400);
});

test("relaunch starts a v2 request from the record with the instance's own mode and new launch id", async (t) => {
  const { call, started, stopped, record } = mountRoutes(t);
  const response = await call("POST", "/api/instances/:id/relaunch", {
    params: { id: "primary" },
    body: { confirm: true, overrides: { values: { contextLength: 131072 } } },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.launchId, "lch_aaaaaaaaaaaaaaaaaaaa");
  assert.equal(response.body.job.id, "job_2");
  assert.equal(started.length, 1);
  const body = started[0];
  assert.equal(body.source, "relaunch");
  assert.equal(body.fromLaunchId, record.launchId);
  assert.equal(body.engineId, "sglang");
  assert.equal(body.runtimeId, "sglang@0.5.17");
  assert.equal(body.recipeId, "qwen38-flashnext-262k");
  assert.equal(body.instance.mode, "replace");
  assert.equal(body.instance.port, 8000);
  assert.deepEqual(body.model, { ref: "fixture-model", servedName: "qwen3.8" });
  assert.equal(body.values.contextLength, 131072, "overrides win over the stored values");
  assert.equal(body.apiKey, FAKE_KEY);
  // A replace launch replaces the running container as its own plan step.
  assert.deepEqual(stopped, []);
});

test("relaunch honours expectedPlanHash", async (t) => {
  const { call, started } = mountRoutes(t);
  const stale = await call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: true, expectedPlanHash: "sha256:old" } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.error.code, "plan_changed");
  assert.equal(stale.body.details.expectedPlanHash, "sha256:old");
  assert.equal(stale.body.details.planHash, "sha256:current");
  assert.equal(started.length, 0, "a changed plan starts nothing");

  const fresh = await call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: true, expectedPlanHash: "sha256:current" } });
  assert.equal(fresh.statusCode, 200);
  assert.equal(started.length, 1);
  assert.equal((await call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: true, expectedPlanHash: 5 } })).statusCode, 400);
});

test("relaunch of a parallel instance stops it first, and a plan refusal keeps its legacy shape", async (t) => {
  const kit = mountRoutes(t);
  const launch = kit.launchStore.create({
    engineId: "sglang", model: { ref: "fixture-model", servedName: "side" }, instance: { mode: "parallel", id: "side", port: 8100 }, values: {},
  }, { launchId: "lch_bbbbbbbbbbbbbbbbbbbb", status: "running", containerName: "vllm-side" });
  kit.containers.push(container({ name: "vllm-side", labels: { "ai.manager.launch-id": launch.launchId, "ai.manager.instance": "side", "ai.manager.instance-mode": "parallel" } }));
  // findInstance reports the instance mode the legacy item carries.
  const original = kit.routes.get("POST /api/instances/:id/relaunch");
  assert.equal(typeof original, "function");
  const parallel = mountRoutes(t, {
    findInstance: async () => ({ instance: { id: "side", instanceMode: "parallel", containerName: "vllm-side" }, container: container({ name: "vllm-side" }), state: { labels: { "ai.manager.launch-id": launch.launchId }, containerName: "vllm-side", running: true } }),
    launchStore: kit.launchStore,
  });
  const response = await parallel.call("POST", "/api/instances/:id/relaunch", { params: { id: "side" }, body: { confirm: true } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parallel.stopped, ["side"]);
  assert.equal(parallel.started[0].instance.mode, "parallel");

  const refused = mountRoutes(t, {
    startRuntime: async () => { throw Object.assign(new Error("bad launch"), { status: 400, code: "invalid_request", errors: [{ code: "x" }] }); },
  });
  const failed = await refused.call("POST", "/api/instances/:id/relaunch", { params: { id: "primary" }, body: { confirm: true } });
  assert.equal(failed.statusCode, 400);
  assert.equal(failed.body.error.code, "invalid_request");
  assert.deepEqual(failed.body.errors, [{ code: "x" }]);
});

// ---- /api/config entryPort -------------------------------------------------

test("entryPort follows env, then the platform config, then 5176", (t) => {
  const readSection = (port) => () => ({ values: { admin: { port } } });
  assert.equal(resolveEntryPort({ env: { SERVICE_ENTRY_PORT: "5999" }, readSection: readSection(5300) }), 5999);
  assert.equal(resolveEntryPort({ env: {}, readSection: readSection(5300) }), 5300);
  assert.equal(resolveEntryPort({ env: { SERVICE_ENTRY_PORT: "not-a-port" }, readSection: readSection(5300) }), 5300);
  assert.equal(resolveEntryPort({ env: { SERVICE_ENTRY_PORT: "70000" }, readSection: () => ({ values: {} }) }), 5176);
  assert.equal(resolveEntryPort({ env: {}, readSection: () => { throw new Error("unreadable"); } }), 5176);
  assert.equal(resolveEntryPort({ env: {}, readSection: () => ({ values: { admin: { port: 0 } } }) }), 5176);
  // The real platform config, from an empty AI root: the default.
  assert.equal(resolveEntryPort({ env: {}, aiRoot: tempRoot(t) }), 5176);
});

test("GET /api/config adds entryPort and keeps the rest", async () => {
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(`GET ${route}`, handler), post: () => {} };
  registerManagerRoutes(app, {
    config: { containerName: "vllm-local" },
    host: "127.0.0.1",
    port: 5174,
    getLanAddress: () => "192.0.2.10",
    hasHfToken: () => false,
    getConfigExtras: () => ({ extra: true }),
    env: { SERVICE_ENTRY_PORT: "5200" },
  });
  const response = { json(body) { this.body = body; return this; } };
  routes.get("GET /api/config")({}, response);
  assert.deepEqual(response.body, {
    containerName: "vllm-local",
    managerHost: "127.0.0.1",
    managerPort: 5174,
    lanAddress: "192.0.2.10",
    hasHfToken: false,
    entryPort: 5200,
    extra: true,
  });
});
