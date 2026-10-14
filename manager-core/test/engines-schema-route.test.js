"use strict";

// GET /api/engines/:engineId/schema (01-engines §21.1, ENG-3) over a recording
// app: groups, params with legacy domIds, availability per runtime, and the
// facts every appliesWhen, rule and platform default reads. GPU, model and
// introspection reads are injected fakes; nothing touches Docker.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const EMPTY_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "engines-config-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_CONFIG_DIR;
test.after(() => fs.rmSync(EMPTY_CONFIG_DIR, { recursive: true, force: true }));

const core = require("..");

const ROUTE = "GET /api/engines/:engineId/schema";
const SM120_GPUS = { ok: true, gpus: [{ id: "0", index: 0, name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", computeCap: "12.0", totalMb: 97887, usedMb: 600 }] };

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

async function schema(app, engineId, query = {}) {
  const res = fakeResponse();
  await app.routes.get(ROUTE)({ headers: {}, params: { engineId }, query }, res);
  return res;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-schema-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mount(t, { managerId = "vllm", ...deps } = {}) {
  const app = recordingApp();
  core.engines.registerEngineRoutes(app, {
    registry: core.engines.createEngineRegistry({ overrideDir: tempDir(t), env: {} }),
    managerId,
    isLocalRequest: () => true,
    paramCatalog: core.engines.createParamCatalog({ overrideDir: tempDir(t) }),
    ...deps,
  });
  return app;
}

// Every fact an expression of the param reads.
function factsRead(param) {
  return [param.appliesWhen, ...param.rules.map((rule) => rule.when), param.platformDefault?.expr]
    .filter((ast) => ast !== null && ast !== undefined)
    .flatMap((ast) => core.engines.expr.collectRefs(ast).facts);
}

test("GET /api/engines/sglang/schema returns groups, params with legacy domIds, unverified availability and facts", async (t) => {
  let gpuCalls = 0;
  const app = mount(t, { getGpuStatus: async () => { gpuCalls += 1; return SM120_GPUS; } });
  const res = await schema(app, "sglang");
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.equal(body.ok, true);
  assert.equal(body.engineId, "sglang");
  assert.equal(body.managerId, "vllm");
  assert.match(body.catalogVersion, /^\d{4}-\d{2}-\d{2}\+\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.recipes, []);
  assert.deepEqual(body.scenarios, []);
  assert.equal(gpuCalls, 1);

  // Groups: the ones sglang fills, ordered, with zh/en labels.
  assert.ok(body.groups.length >= 8);
  assert.deepEqual(body.groups.map((group) => group.order), [...body.groups.map((group) => group.order)].sort((a, b) => a - b));
  for (const group of body.groups) assert.ok(group.label.zh && group.label.en && group.id);
  const groupIds = new Set(body.groups.map((group) => group.id));
  for (const param of body.params) assert.ok(groupIds.has(param.group), `${param.id} in ${param.group}`);

  // Params carry the legacy form's DOM ids.
  const byId = Object.fromEntries(body.params.map((param) => [param.id, param]));
  assert.equal(byId["sglang.maxTotalTokens"].legacy.domId, "sglangMaxTotalTokens");
  assert.equal(byId["sglang.memFractionStatic"].legacy.domId, "gpuMemoryUtilization");
  assert.equal(byId["reasoning.defaultEnabled"].legacy.domId, "sglangDisableThinkingByDefault");
  assert.equal(byId.contextLength.legacy.domId, "maxModelLen");
  assert.ok(body.params.filter((param) => param.legacy?.domId).length >= 25);
  for (const param of body.params) {
    for (const field of ["label", "summary", "help", "type", "level", "order", "emit", "availability", "choices", "platformDefaultValue"]) {
      assert.ok(Object.hasOwn(param, field), `${param.id}.${field}`);
    }
  }

  // No introspection yet: every runtime flag is unverified (and allowed), nothing is unavailable.
  assert.deepEqual(body.runtime, {
    runtimeId: "sglang@0.5.17",
    manifestKey: "sglang",
    image: body.runtime.image,
    status: "pinned",
    features: {},
    introspected: false,
    introspectedAt: null,
    flagCount: null,
  });
  const states = new Set(body.params.map((param) => param.availability.state));
  assert.deepEqual([...states].sort(), ["available", "unverified"]);
  assert.equal(byId["sglang.maxTotalTokens"].availability.state, "unverified");
  assert.equal(byId["sglang.maxTotalTokens"].availability.flag, "--max-total-tokens");
  for (const param of body.params.filter((item) => item.availability.state === "available")) {
    assert.equal(param.availability.flag, undefined, `${param.id} is a runtime flag and cannot be verified without introspection`);
  }

  // facts cover every fact appliesWhen, rules and defaults read, plus the standard set.
  const read = new Set(body.params.flatMap(factsRead));
  assert.ok(read.has("model.quantMethod"), "sglang.fp4GemmBackend's appliesWhen reads model.quantMethod");
  for (const name of [...read, ...core.engines.expr.FACT_NAMES]) assert.ok(Object.hasOwn(body.facts, name), `facts.${name}`);
  assert.equal(body.facts["host.platform"], process.platform);
  assert.equal(body.facts["host.anySm12x"], true);
  assert.equal(body.facts["host.maxComputeCap"], 12);
  assert.equal(body.facts["runtime.id"], "sglang@0.5.17");
  assert.equal(body.facts["runtime.compatVersion"], "0.5.17");
  assert.equal(body.facts["model.quantMethod"], null);
  assert.equal(body.facts["instance.mode"], null);
  // Feature-gated params name their feature; unknown on a runtime that does not list it.
  assert.equal(body.facts["runtime.features.pleOffload"], null);

  // The console can evaluate appliesWhen with these facts and the values alone.
  const fp4 = core.engines.expr.compileExpr(byId["sglang.fp4GemmBackend"].appliesWhen);
  assert.equal(fp4.run({ fact: { ...body.facts, "model.quantMethod": "modelopt_fp4" }, param: {} }), true);
});

test("?runtime= and ?instanceMode= select the runtime and the facts the defaults read", async (t) => {
  const app = mount(t, { getGpuStatus: async () => SM120_GPUS });
  const body = (await schema(app, "sglang", { runtime: "sglangFlashNext", instanceMode: "parallel" })).body;
  assert.equal(body.runtime.runtimeId, "sglang@qwen38flashnext-sm120-dac5523d");
  assert.equal(body.facts["runtime.features.pleOffload"], true);
  assert.equal(body.facts["instance.mode"], "parallel");
  const memFraction = body.params.find((param) => param.id === "sglang.memFractionStatic");
  assert.equal(memFraction.platformDefaultValue, 0.7);
  const byRuntimeId = (await schema(app, "sglang", { runtime: "sglang@pennyroyal-v2.5.1", instanceMode: "replace" })).body;
  assert.equal(byRuntimeId.runtime.manifestKey, "sglangPennyroyal");
  assert.equal(byRuntimeId.params.find((param) => param.id === "sglang.memFractionStatic").platformDefaultValue, 0.92);
  // An unknown mode is not a fact.
  assert.equal((await schema(app, "sglang", { instanceMode: "everything" })).body.facts["instance.mode"], null);

  const unknown = await schema(app, "sglang", { runtime: "sglang@9.9.9" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.error.code, "unknown_runtime");
  assert.match(unknown.body.error.hint, /sglang@0\.5\.17/);
});

test("unknown and foreign engines are errors in the 00 §4.2 envelope", async (t) => {
  const vllm = mount(t, { managerId: "vllm" });
  for (const engineId of ["nope", "Bad_Id", "", undefined]) {
    const res = await schema(vllm, engineId);
    assert.equal(res.statusCode, 400, String(engineId));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, "unknown_engine");
  }
  const foreign = await schema(vllm, "llamacpp");
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.body.error.code, "engine_not_hosted");
  assert.match(foreign.body.error.hint, /\/api\/m\/llama\/engines\/llamacpp\/schema/);

  const llama = mount(t, { managerId: "llama" });
  const own = await schema(llama, "llamacpp");
  assert.equal(own.statusCode, 200);
  assert.equal(own.body.runtime.runtimeId, "llamacpp@b10630");
  assert.equal(own.body.params.find((param) => param.id === "llamacpp.reasoningEffort").legacy.domId, "reasoningEffort");
  assert.deepEqual(own.body.legacyIgnored.map((item) => item.field), ["loadFormat"]);
  assert.equal((await schema(llama, "vllm")).statusCode, 404);
});

test("a failed GPU probe leaves host facts unknown and the schema is still served", async (t) => {
  for (const getGpuStatus of [
    async () => ({ ok: false, text: "nvidia-smi query failed", gpus: [] }),
    async () => { throw new Error("probe crashed"); },
    undefined,
  ]) {
    const app = mount(t, { getGpuStatus });
    const res = await schema(app, "vllm");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.facts["host.anySm12x"], null);
    assert.equal(res.body.facts["host.maxComputeCap"], null);
    assert.equal(res.body.facts["host.platform"], process.platform);
  }
});

test("introspection and model facts come from optional hooks whose failures never break the route", async (t) => {
  const seen = [];
  const app = mount(t, {
    getIntrospection: async (runtime) => {
      seen.push(runtime.runtimeId);
      return { capturedAt: "2026-10-14T00:00:00.000Z", flags: [{ flag: "--max-model-len" }, { flag: "--kv-cache-dtype", choices: ["auto", "fp8", "fp8_e4m3"] }] };
    },
    getModelFacts: async (ref, ctx) => {
      seen.push(`${ctx.engineId}:${ref}`);
      return { quantMethod: "fp8", architectures: ["Qwen3ForCausalLM"], nativeMtp: { supported: false } };
    },
  });
  const body = (await schema(app, "vllm", { model: "C:/fixture/models/demo" })).body;
  assert.deepEqual(seen, ["vllm@0.28.0", "vllm:C:/fixture/models/demo"]);
  assert.deepEqual([body.runtime.introspected, body.runtime.flagCount, body.runtime.introspectedAt], [true, 2, "2026-10-14T00:00:00.000Z"]);
  const byId = Object.fromEntries(body.params.map((param) => [param.id, param]));
  assert.equal(byId.contextLength.availability.state, "available");
  assert.equal(byId["vllm.maxNumBatchedTokens"].availability.state, "unavailable");
  assert.deepEqual(byId.kvCacheDtype.choices.map((choice) => choice.value), ["auto", "fp8", "fp8_e4m3"]);
  assert.equal(body.facts["model.quantMethod"], "fp8");
  assert.deepEqual(body.facts["model.architectures"], ["Qwen3ForCausalLM"]);
  assert.equal(body.facts["model.nativeMtp.supported"], false);

  // No ?model=: the model hook is not asked.
  seen.length = 0;
  await schema(app, "vllm");
  assert.deepEqual(seen, ["vllm@0.28.0"]);

  const broken = mount(t, {
    getIntrospection: async () => { throw new Error("cache unreadable"); },
    getModelFacts: async () => { throw new Error("model unreadable"); },
  });
  const res = await schema(broken, "vllm", { model: "C:/fixture/models/demo" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.runtime.introspected, false);
  assert.equal(res.body.facts["model.quantMethod"], null);
});

test("an invalid launch-params override is reported in the schema and the bundled param is served", async (t) => {
  const overrides = tempDir(t);
  fs.writeFileSync(path.join(overrides, "sglang.json"), JSON.stringify({
    kind: "engine",
    engineId: "sglang",
    params: [{ id: "sglang.pageSize", level: "wizard" }],
  }));
  const app = mount(t, { paramCatalog: core.engines.createParamCatalog({ overrideDir: overrides }) });
  const body = (await schema(app, "sglang")).body;
  assert.equal(body.ok, true);
  assert.equal(body.params.find((param) => param.id === "sglang.pageSize").level, "expert");
  assert.deepEqual(body.errors.map((item) => [item.source, item.code]), [["override", "invalid_value"]]);
  // File paths stay on the server.
  assert.equal(Object.hasOwn(body.errors[0], "file"), false);
});
