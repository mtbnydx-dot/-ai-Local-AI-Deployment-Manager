"use strict";

// GET /api/engines and POST /api/engines/descriptors/validate (01-engines §21.1)
// over a recording app and fake Docker reads. No docker process is spawned.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");

const ACCEPTANCE_RUNTIME_IDS = [
  "vllm@0.28.0",
  "sglang@0.5.17",
  "sglang@qwen38flashnext-sm120-dac5523d",
  "sglang@pennyroyal-v2.5.1",
  "sglang@flashnext-nvme-ple-20260831",
  "llamacpp@b10630",
];

function recordingApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

async function call(app, route, req = {}) {
  const res = fakeResponse();
  await app.routes.get(route)({ headers: {}, body: undefined, ...req }, res);
  return res;
}

function overrideDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-override-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
}

// Fake getImageStatus with the reasons docker-runtime.getImageStatus returns.
function fakeImages(present, { daemonDown = false } = {}) {
  const calls = [];
  const getImageStatus = async (image) => {
    calls.push(image);
    if (daemonDown) return { ok: false, text: "Docker Desktop is not running", reason: "docker-daemon" };
    return present.has(image) ? { ok: true, text: image, id: "sha256:fixture" } : { ok: false, text: `missing: ${image}`, reason: "missing-image" };
  };
  return { getImageStatus, calls };
}

function mount(t, { managerId, files, images = fakeImages(new Set()), containers = [], local = true, now, registry } = {}) {
  const app = recordingApp();
  const engineRegistry = registry || core.engines.createEngineRegistry({ overrideDir: overrideDir(t, files), env: {} });
  core.engines.registerEngineRoutes(app, {
    registry: engineRegistry,
    managerId,
    ownerLabelValue: `${managerId}-manager`,
    isLocalRequest: () => local,
    getImageStatus: images.getImageStatus,
    listManagedContainers: async () => containers,
    now,
  });
  return { app, registry: engineRegistry, images };
}

test("GET /api/engines returns the three engines across both managers with their runtimeIds", async (t) => {
  const vllmImages = fakeImages(new Set([
    "vllm/vllm-openai@sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635",
    "local/sglang:qwen38flashnext-sm120-dac5523d",
  ]));
  const vllm = mount(t, {
    managerId: "vllm",
    images: vllmImages,
    containers: [
      { name: "vllm-local", manager: "vllm-manager", engine: "sglang", running: true, labels: {} },
      { name: "vllm-local-2", manager: "vllm-manager", engine: "vllm", running: true, labels: {} },
      { name: "vllm-local-3", manager: "vllm-manager", engine: "vllm", running: false, labels: {} },
      { name: "llama-local", manager: "llama-manager", engine: "llama", running: true, labels: {} },
    ],
  });
  const llama = mount(t, { managerId: "llama" });

  const vllmBody = (await call(vllm.app, "GET /api/engines")).body;
  const llamaBody = (await call(llama.app, "GET /api/engines")).body;
  assert.equal(vllmBody.ok, true);
  assert.equal(vllmBody.managerId, "vllm");
  assert.equal(llamaBody.managerId, "llama");
  assert.ok(Number.isFinite(Date.parse(vllmBody.generatedAt)));
  assert.deepEqual(vllmBody.errors, []);
  assert.deepEqual(vllmBody.engines.map((engine) => engine.engineId), ["vllm", "sglang"]);
  assert.deepEqual(llamaBody.engines.map((engine) => engine.engineId), ["llamacpp"]);

  const engines = [...vllmBody.engines, ...llamaBody.engines];
  assert.equal(engines.length, 3);
  const runtimeIds = engines.flatMap((engine) => engine.runtimes.map((runtime) => runtime.runtimeId));
  for (const runtimeId of ACCEPTANCE_RUNTIME_IDS) assert.ok(runtimeIds.includes(runtimeId), runtimeId);
  assert.equal(new Set(runtimeIds).size, runtimeIds.length);

  const byId = Object.fromEntries(engines.map((engine) => [engine.engineId, engine]));
  for (const engine of engines) {
    assert.deepEqual(Object.keys(engine.capabilities.autoParsers).sort(), ["reasoning", "tool"], engine.engineId);
    for (const field of ["label", "family", "adapter", "tier", "status", "hostKinds", "artifactFormats", "runtimes", "capabilities", "apiSurface", "memoryModel", "health"]) {
      assert.ok(Object.hasOwn(engine, field), `${engine.engineId}.${field}`);
    }
    for (const runtime of engine.runtimes) {
      for (const field of ["runtimeId", "manifestKey", "image", "default", "present", "introspected", "features", "status", "localBuild", "pullPolicy"]) {
        assert.ok(Object.hasOwn(runtime, field), `${runtime.runtimeId}.${field}`);
      }
    }
  }
  assert.deepEqual(byId.llamacpp.capabilities.autoParsers, { tool: "auto", reasoning: "auto" });
  assert.deepEqual(byId.vllm.capabilities.autoParsers, { tool: null, reasoning: null });
  assert.deepEqual(byId.sglang.memoryModel, { kind: "static-fraction-of-free" });
  assert.deepEqual(byId.vllm.hostKinds, ["docker"]);

  const sglangRuntimes = Object.fromEntries(byId.sglang.runtimes.map((runtime) => [runtime.runtimeId, runtime]));
  const nvme = sglangRuntimes["sglang@flashnext-nvme-ple-20260831"];
  assert.equal(nvme.status, "experimental");
  assert.equal(nvme.pullPolicy, "explicit");
  assert.equal(nvme.default, false);
  assert.equal(sglangRuntimes["sglang@0.5.17"].default, true);
  assert.equal(sglangRuntimes["sglang@qwen38flashnext-sm120-dac5523d"].present, true);
  assert.equal(sglangRuntimes["sglang@qwen38flashnext-sm120-dac5523d"].localBuild, true);
  assert.equal(sglangRuntimes["sglang@0.5.17"].present, false);
  assert.equal(byId.vllm.runtimes[0].present, true);
  assert.equal(byId.vllm.runtimes[0].introspected, false);
  assert.deepEqual(byId.llamacpp.runtimes.map((runtime) => [runtime.runtimeId, runtime.status]), [
    ["llamacpp@b10630", "pinned"],
    ["llamacpp@muse-62bf73d", "retired"],
  ]);

  // One running sglang and one running vllm container of this manager; the
  // stopped one and the llama manager's container are not counted.
  assert.deepEqual(byId.sglang.health, { host: "docker", hostReady: true, instances: 1 });
  assert.deepEqual(byId.vllm.health, { host: "docker", hostReady: true, instances: 1 });
  assert.deepEqual(byId.llamacpp.health, { host: "docker", hostReady: true, instances: 0 });
});

test("image presence is cached for 60 s, and a Docker that cannot answer gives present null", async (t) => {
  let clock = Date.parse("2026-10-14T08:00:00.000Z");
  const images = fakeImages(new Set());
  const { app } = mount(t, { managerId: "llama", images, now: () => clock });
  await call(app, "GET /api/engines");
  const first = images.calls.length;
  assert.equal(first, 2, "one inspect per runtime image");
  await call(app, "GET /api/engines");
  assert.equal(images.calls.length, first, "served from the cache");
  clock += 61_000;
  await call(app, "GET /api/engines");
  assert.equal(images.calls.length, first * 2, "re-inspected after the TTL");

  const down = mount(t, { managerId: "llama", images: fakeImages(new Set(), { daemonDown: true }) });
  const body = (await call(down.app, "GET /api/engines")).body;
  assert.deepEqual(body.engines[0].runtimes.map((runtime) => runtime.present), [null, null]);
  assert.equal(body.engines[0].health.hostReady, false);
  // The container listing answers [] when Docker is down, so the count is unknown too.
  assert.equal(body.engines[0].health.instances, null);
  // A listing that did find running containers is still counted.
  const listed = mount(t, {
    managerId: "llama",
    images: fakeImages(new Set(), { daemonDown: true }),
    containers: [{ name: "llama-local", manager: "llama-manager", engine: "llama", running: true, labels: {} }],
  });
  assert.equal((await call(listed.app, "GET /api/engines")).body.engines[0].health.instances, 1);

  // Without Docker probes the fields are unknown rather than guessed.
  const app2 = recordingApp();
  core.engines.registerEngineRoutes(app2, { registry: core.engines.createEngineRegistry({ overrideDir: overrideDir(t), env: {} }), managerId: "vllm" });
  const bare = (await call(app2, "GET /api/engines")).body;
  assert.deepEqual(bare.engines[0].health, { host: "docker", hostReady: null, instances: null });
  assert.equal(bare.engines[0].runtimes[0].present, null);
});

test("a bad override is listed in errors[] and the engines are still served", async (t) => {
  const { app } = mount(t, {
    managerId: "vllm",
    files: {
      "broken.json": "{ nope",
      "vllm.json": { id: "vllm", status: "nonsense" },
      "sglang.json": { id: "sglang", runtimes: { allowed: ["sglang", "sglangX"], default: "sglangX" } },
    },
  });
  const res = await call(app, "GET /api/engines");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.engines.map((engine) => [engine.engineId, engine.status]), [["vllm", "stable"], ["sglang", "stable"]]);
  assert.deepEqual(res.body.errors.map((item) => [path.basename(item.file), item.source, item.code]).sort(), [
    ["broken.json", "override", "invalid_json"],
    ["sglang.json", "override", "default_runtime_unresolved"],
    ["sglang.json", "override", "unknown_runtime"],
    ["vllm.json", "override", "enum"],
  ]);
  const enumError = res.body.errors.find((item) => item.code === "enum");
  assert.equal(enumError.engineId, "vllm");
  assert.equal(enumError.path, "status");
  // The rejected sglang override left every runtime and the default in place.
  const sglang = res.body.engines.find((engine) => engine.engineId === "sglang");
  assert.deepEqual(sglang.runtimes.map((runtime) => runtime.runtimeId), ACCEPTANCE_RUNTIME_IDS.filter((id) => id.startsWith("sglang@")));
  assert.deepEqual(sglang.runtimes.filter((runtime) => runtime.default).map((runtime) => runtime.runtimeId), ["sglang@0.5.17"]);
});

test("each manager reports the errors of its own engines plus the shared ones", async (t) => {
  const files = {
    "broken.json": "{ nope",
    "llamacpp.json": { id: "llamacpp", status: "nonsense" },
    "vllm.json": { id: "vllm", status: "nonsense" },
    "new-engine.json": { id: "new-engine", adapter: "docker-template" },
  };
  const registry = core.engines.createEngineRegistry({ overrideDir: overrideDir(t, files), env: {} });
  const errorsOf = async (managerId) => {
    const body = (await call(mount(t, { managerId, registry }).app, "GET /api/engines")).body;
    return [...new Set(body.errors.map((item) => `${path.basename(item.file)}:${item.engineId}`))].sort();
  };
  // Engine-less problems and engines that failed to load are shared, so the
  // entry aggregate dedupes those; an engine's own errors appear once.
  assert.deepEqual(await errorsOf("vllm"), ["broken.json:", "new-engine.json:new-engine", "vllm.json:vllm"]);
  assert.deepEqual(await errorsOf("llama"), ["broken.json:", "llamacpp.json:llamacpp", "new-engine.json:new-engine"]);
});

test("GET /api/engines never shows a secret that override data names as an image variable", async (t) => {
  const secret = "hf_FAKEFAKEFAKEFAKEFAKE";
  const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-manifest-"));
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "runtime-manifest.json"), "utf8"));
  fs.writeFileSync(path.join(manifestDir, "runtime-manifest.json"), JSON.stringify({
    asOf: "2026-10-14",
    runtimes: { sglangPennyroyal: { ...bundled.runtimes.sglangPennyroyal, envOverride: "HF_TOKEN" } },
  }));
  process.env.AI_REFERENCE_DATA_DIR = manifestDir;
  core.clearRuntimeManifestCache();
  t.after(() => {
    process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
    core.clearRuntimeManifestCache();
    fs.rmSync(manifestDir, { recursive: true, force: true });
  });
  const customEngine = {
    schemaVersion: 1,
    asOf: "2026-10-14",
    staleAfterDays: 120,
    id: "custom-lab",
    label: { zh: "Custom lab", en: "Custom lab" },
    family: "openai-server",
    adapter: "docker-template",
    tier: 2,
    status: "experimental",
    hostManager: "vllm",
    artifactFormats: ["safetensors"],
    runtimes: { default: "customLab", allowed: ["customLab"], envOverride: { customLab: "HF_TOKEN" } },
    host: { kinds: ["docker"], default: "docker", containerPort: 8000 },
    api: { openaiBase: "/v1", models: "/v1/models", health: "/health", ready: { kind: "models-list" } },
    memoryModel: { kind: "measured" },
    capabilities: {
      parallelInstances: false, tensorParallel: false, pipelineParallel: false, dataParallel: false, expertParallel: false,
      speculative: [], autoParsers: { tool: null, reasoning: null }, lora: false, multiModel: false, hotLoad: false, sleepWake: false, roles: ["chat"],
    },
    secrets: { apiKey: { mode: "unsupported" } },
    template: { args: ["serve"] },
  };
  const images = fakeImages(new Set());
  const registry = core.engines.createEngineRegistry({ overrideDir: overrideDir(t, { "custom-lab.json": customEngine }), env: { HF_TOKEN: secret } });
  const { app } = mount(t, { managerId: "vllm", registry, images });
  const res = await call(app, "GET /api/engines");
  assert.equal(res.statusCode, 200);
  assert.ok(!JSON.stringify(res.body).includes(secret), "the secret is not in the payload");
  assert.ok(!images.calls.includes(secret), "the secret never reaches docker image inspect");
  assert.deepEqual(res.body.engines.map((engine) => engine.engineId), ["vllm", "sglang"]);
  const pennyroyal = res.body.engines[1].runtimes.find((runtime) => runtime.manifestKey === "sglangPennyroyal");
  assert.equal(Object.hasOwn(pennyroyal, "imageOverrideEnv"), false);
  // Both problems are reported: the manifest falls back to the bundled table
  // and the custom engine is not loaded.
  assert.deepEqual(res.body.errors.map((item) => [item.source, item.engineId, item.code]).sort(), [
    ["manifest", "", "manifest_invalid"],
    ["override", "custom-lab", "env_not_allowed"],
  ]);
});

test("POST /api/engines/descriptors/validate reports draft errors and writes nothing", async (t) => {
  const dir = overrideDir(t);
  const registry = core.engines.createEngineRegistry({ overrideDir: dir, env: {} });
  const { app } = mount(t, { managerId: "vllm", registry });
  const before = JSON.stringify(registry.list());

  const bad = await call(app, "POST /api/engines/descriptors/validate", {
    body: { descriptor: { schemaVersion: 1, id: "my-engine", adapter: "vllm", capabilities: { autoParsers: { tool: 1 } } } },
  });
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.body.ok, false);
  const codes = bad.body.errors.map((item) => `${item.path}:${item.code}`);
  for (const expected of ["adapter:adapter_not_allowed", "asOf:required", "label:required", "capabilities.autoParsers.tool:type", "capabilities.autoParsers.reasoning:required"]) {
    assert.ok(codes.includes(expected), expected);
  }

  const override = await call(app, "POST /api/engines/descriptors/validate", { body: { descriptor: { id: "sglang", status: "disabled" } } });
  assert.deepEqual(override.body, { ok: true, kind: "override", errors: [] });
  assert.equal(registry.get("sglang").status, "stable", "validation never applies the draft");

  // A well-formed override whose runtimes would not resolve is rejected, as
  // loading it would be: the engine would lose its default runtime.
  const foreign = await call(app, "POST /api/engines/descriptors/validate", {
    body: { descriptor: { id: "llamacpp", runtimes: { allowed: ["vllmGemma"], default: "vllmGemma" } } },
  });
  assert.equal(foreign.statusCode, 200);
  assert.equal(foreign.body.ok, false);
  assert.equal(foreign.body.kind, "override");
  assert.deepEqual(foreign.body.errors.map((item) => `${item.path}:${item.code}`), [
    "runtimes.allowed[0]:runtime_engine_mismatch",
    "runtimes.default:default_runtime_unresolved",
  ]);
  const typo = await call(app, "POST /api/engines/descriptors/validate", {
    body: { descriptor: { id: "sglang", runtimes: { allowed: ["sglang", "sglangX"], default: "sglangX" } } },
  });
  assert.equal(typo.body.ok, false);
  assert.deepEqual(typo.body.errors.map((item) => `${item.path}:${item.code}`), [
    "runtimes.allowed[1]:unknown_runtime",
    "runtimes.default:default_runtime_unresolved",
  ]);
  assert.ok(typo.body.errors.every((item) => item.message && !Object.hasOwn(item, "manifestKey")));
  assert.equal(registry.defaultRuntime("sglang").runtimeId, "sglang@0.5.17");

  const missing = await call(app, "POST /api/engines/descriptors/validate", { body: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error.code, "invalid_body");

  const huge = await call(app, "POST /api/engines/descriptors/validate", {
    body: { descriptor: { id: "big-engine", notes: "x".repeat(300 * 1024) } },
  });
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.body.error.code, "descriptor_too_large");

  // Nesting JSON.parse accepts but JSON.stringify cannot walk is a 400, not a 500.
  let deep = {};
  for (let depth = 0; depth < 200_000; depth += 1) deep = { a: deep };
  const nested = await call(app, "POST /api/engines/descriptors/validate", { body: { descriptor: { id: "deep-engine", notes: deep } } });
  assert.equal(nested.statusCode, 400);
  assert.equal(nested.body.error.code, "invalid_body");

  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(JSON.stringify(registry.list()), before);
});

test("descriptor validation is local-only and the route needs a registry and a managerId", async (t) => {
  const { app } = mount(t, { managerId: "llama", local: false });
  const res = await call(app, "POST /api/engines/descriptors/validate", { body: { descriptor: { id: "llamacpp" } } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(Object.keys(res.body.error).sort(), ["code", "message"]);
  assert.equal(res.body.error.code, "forbidden");

  // Without an isLocalRequest predicate the write-side route denies by default.
  const app2 = recordingApp();
  core.engines.registerEngineRoutes(app2, { registry: core.engines.createEngineRegistry({ overrideDir: overrideDir(t), env: {} }), managerId: "llama" });
  assert.equal((await call(app2, "POST /api/engines/descriptors/validate", { body: { descriptor: {} } })).statusCode, 403);

  assert.throws(() => core.engines.registerEngineRoutes(recordingApp(), { managerId: "vllm" }), TypeError);
  assert.throws(() => core.engines.registerEngineRoutes(recordingApp(), { registry: { hostedBy: () => [] }, managerId: "vllm" }), TypeError, "the draft check needs registry.checkOverride");
  assert.throws(() => core.engines.registerEngineRoutes(recordingApp(), { registry: core.engines.getEngineRegistry(), managerId: "tts" }), TypeError);
  core.engines.clearEngineRegistryCache();
});
