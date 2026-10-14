"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEngineRegistry } = require("../engines/registry");
const { createParamCatalog } = require("../engines/param-catalog");
const { createRuntimeFacts } = require("../engines/runtime-facts");
const { registerEngineRoutes } = require("../engines/routes");

const RUNTIME = "vllm@0.28.0";
const ID = `sha256:${"a".repeat(64)}`;
const PREFIX = "/api/engines/:engineId/runtimes/:runtimeId";

function mount(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "introspect-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
  const facts = createRuntimeFacts({ registry, aiRoot: root, resolveImageId: async () => ID });
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) };
  registerEngineRoutes(app, { registry, managerId: "vllm", isLocalRequest: () => true, runtimeFacts: facts, paramCatalog: createParamCatalog({ overrideDir: path.join(root, "config") }), ...extra });
  return { facts, registry, async call(method, suffix, request = {}) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
    const route = suffix.startsWith("/api/") ? suffix : `${PREFIX}/${suffix}`;
    await routes.get(`${method} ${route}`)({ params: { engineId: "vllm", runtimeId: RUNTIME }, query: {}, headers: {}, ...request }, response);
    return response;
  } };
}

test("flags GET returns both fact sections and a catalog diff without probing a container", async (t) => {
  const { facts, call } = mount(t);
  const flags = { capturedAt: "2026-10-14T00:00:00Z", flags: [{ flag: "--max-model-len", choices: [] }, { flag: "--new-option", choices: [] }] };
  await facts.put(RUNTIME, "flags", flags);
  await facts.put(RUNTIME, "registries", { architectures: ["ExampleForCausalLM"] });
  const response = await call("GET", "flags", { query: { against: "catalog" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.flags, flags);
  assert.deepEqual(response.body.registries, { architectures: ["ExampleForCausalLM"] });
  assert.deepEqual(response.body.diff.added, ["--new-option"]);
  assert.ok(response.body.diff.catalogMissing.includes("--kv-cache-dtype"));
});

test("flags GET validates the runtime and reports an uncaptured runtime", async (t) => {
  const { call } = mount(t);
  assert.equal((await call("GET", "flags")).body.error.code, "runtime_not_introspected");
  assert.equal((await call("GET", "flags", { params: { engineId: "vllm", runtimeId: "vllm@missing" } })).body.error.code, "unknown_runtime");
  assert.equal((await call("GET", "flags", { params: { engineId: "llamacpp", runtimeId: "llamacpp@b10630" } })).body.error.code, "engine_not_hosted");
});

test("schema and engines read the shared flags cache and refine autoParsers", async (t) => {
  const { facts, call } = mount(t);
  await facts.put(RUNTIME, "flags", { capturedAt: "2026-10-14T00:00:00Z", flags: [
    { flag: "--kv-cache-dtype", choices: ["auto", "new_dtype"] },
    { flag: "--tool-call-parser", choices: ["auto", "hermes"], default: "auto" },
    { flag: "--reasoning-parser", choices: ["auto", "qwen3"], default: "auto" },
  ] });
  const schema = (await call("GET", "/api/engines/:engineId/schema")).body;
  assert.equal(schema.runtime.introspected, true);
  assert.deepEqual(schema.params.find((param) => param.id === "kvCacheDtype").choices.map((choice) => choice.value), ["auto", "new_dtype"]);
  const engines = (await call("GET", "/api/engines")).body.engines;
  const engine = engines.find((entry) => entry.engineId === "vllm");
  assert.equal(engine.runtimes.find((entry) => entry.runtimeId === RUNTIME).introspected, true);
  assert.deepEqual(engine.capabilities.autoParsers, { tool: "auto", reasoning: "auto" });
});

test("introspection requires both admin access and confirm:true before any job/probe", async (t) => {
  let calls = 0;
  const denied = mount(t, { isAdminRequest: () => false, createJob: () => { calls += 1; } });
  assert.equal((await denied.call("POST", "introspect", { body: { confirm: true } })).statusCode, 403);
  const allowed = mount(t, { createJob: () => { calls += 1; } });
  assert.equal((await allowed.call("POST", "introspect", { body: {} })).body.error.code, "confirmation_required");
  assert.equal((await allowed.call("POST", "introspect", { body: { confirm: "true" } })).statusCode, 400);
  assert.equal(calls, 0);
});

test("an explicitly confirmed action creates an introspect job and finishes it through existing hooks", async (t) => {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const seen = [];
  const { call } = mount(t, {
    createJob: (type, title, meta) => { seen.push(type); return { id: "test_job", type, title, status: "running", meta }; },
    introspectRuntime: async (engineId, runtimeId, options) => {
      seen.push(`${engineId}:${runtimeId}`);
      assert.equal(typeof options.runtimeFacts.put, "function");
      return { imageId: ID, flags: { flags: [{ flag: "--model" }] } };
    },
    finishJob: (job, meta) => { seen.push(meta.flagCount); resolveDone(job); },
    failJob: () => assert.fail("should finish"),
  });
  const response = await call("POST", "introspect", { body: { confirm: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.job.type, "introspect");
  assert.equal(response.body.job.status, "running");
  await done;
  assert.deepEqual(seen, ["introspect", `vllm:${RUNTIME}`, 1]);
});

test("a failed background probe marks the job failed with its machine-readable code", async (t) => {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const { call } = mount(t, {
    createJob: (type, _title, meta) => ({ id: "test_job", type, meta }),
    introspectRuntime: async () => { throw Object.assign(new Error("timeout"), { code: "introspection_timeout" }); },
    finishJob: () => assert.fail("must not finish"),
    failJob: (job) => resolveDone(job),
  });
  await call("POST", "introspect", { body: { confirm: true } });
  assert.equal((await done).meta.errorCode, "introspection_timeout");
});

test("a missing image returns runtime_image_missing before creating any job", async (t) => {
  let jobs = 0;
  const { call } = mount(t, {
    runtimeFacts: { imageId: async () => null },
    createJob: () => { jobs += 1; }, finishJob: () => {}, failJob: () => {},
  });
  const response = await call("POST", "introspect", { body: { confirm: true } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error.code, "runtime_image_missing");
  assert.equal(jobs, 0);
});
