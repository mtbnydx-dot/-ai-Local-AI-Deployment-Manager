// CON-11b (07 §6.3 step 3, 02 §18 R-UI-3, R-UI-4): the rules behind the wizard's
// Resources step, run in Node: the fit bar's numbers, the plan cards' view of a
// recommended plan, the fit solver's grid, and the model that applies a plan to
// the draft. Drawing and interaction are covered in a browser by
// tests/frontend/console/console-wizard.spec.js (part 2).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);
const fitBar = await load("components/fit-bar.js");
const planCards = await load("components/plan-cards.js");
const solver = await load("components/fit-solver.js");
const model = await load("lib/resources-model.js");
const wizard = await load("lib/wizard-state.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "..", "tests", "fixtures", "console");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const catalogs = { zh: readJson(path.join(CONSOLE_DIR, "i18n", "models", "zh-CN.json")), en: readJson(path.join(CONSOLE_DIR, "i18n", "models", "en-US.json")) };
const fixture = (name) => readJson(path.join(FIXTURES, "wizard", `${name}.json`));

const MEMORY = {
  perGpuMb: { 0: 60000 },
  breakdown: { weights: 30000, kv: 20000, activations: 8000, draft: 1000, mmproj: 500, overhead: 500 },
  admissionRequestMb: 60000,
  kvPoolTokens: 200000,
  maxFullLengthRequests: 3,
  policy: "static-fraction-of-free",
};

// ---- FitBar -----------------------------------------------------------------------------------

test("the fit bar stacks six segments in order and draws the runtime overhead with the activations", () => {
  const view = fitBar.fitModel({ ...MEMORY, headroomMb: 5000, budgetMb: { 0: 65000 } });
  assert.deepEqual(view.segments.map((segment) => segment.kind), ["weights", "kv", "activations", "draft", "mmproj", "headroom"]);
  assert.deepEqual(view.segments.map((segment) => segment.kind), [...fitBar.FIT_SEGMENTS]);
  assert.deepEqual(view.segments.map((segment) => segment.mb), [30000, 20000, 8500, 1000, 500, 5000]);
  assert.equal(view.usedMb, 60000);
  assert.equal(view.totalMb, 65000);
  assert.equal(view.headroomKnown, true);
  assert.equal(view.spill, false);
  assert.equal(view.overMb, 0);
});

test("headroom comes from the budget when the estimate has no headroomMb, and is unknown without either", () => {
  const withBudget = fitBar.fitModel({ ...MEMORY, budgetMb: { 0: 64000 } });
  assert.equal(withBudget.headroomMb, 4000);
  assert.equal(withBudget.headroomKnown, true);
  const unknown = fitBar.fitModel(MEMORY);
  assert.equal(unknown.headroomMb, 0);
  assert.equal(unknown.headroomKnown, false);
  const over = fitBar.fitModel({ ...MEMORY, budgetMb: { 0: 55000 } });
  assert.equal(over.headroomMb, 0);
  assert.equal(over.overMb, 5000, "use beyond the budget is reported");
});

test("a spill adds the RAM bar from ram.weights, ram.experts and ram.kv", () => {
  const explicit = fitBar.fitModel({ ...MEMORY, spill: true, ram: { weights: 0, experts: 4096, kv: 0 } });
  assert.equal(explicit.spill, true);
  assert.deepEqual(explicit.ram.parts, [{ kind: "weights", mb: 0 }, { kind: "experts", mb: 4096 }, { kind: "kv", mb: 0 }]);
  assert.equal(explicit.ram.totalMb, 4096);
  assert.equal(fitBar.fitModel({ ...MEMORY, ram: { kv: 10 } }).spill, true, "RAM use implies a spill");
  assert.equal(fitBar.fitModel({ ...MEMORY, ram: { weights: 0, experts: 0, kv: 0 } }).spill, false);
  assert.equal(fitBar.fitModel(MEMORY, { experts: 1 }).spill, true, "the ram prop wins over fit.ram");
});

test("an estimate without a breakdown draws nothing", () => {
  assert.equal(fitBar.fitModel(null), null);
  assert.equal(fitBar.fitModel({ perGpuMb: { 0: 1 } }), null);
});

test("every memory.policy value, including static-fraction-of-free and weights-plus-kv, has a label in zh and en", () => {
  assert.deepEqual([...fitBar.MEMORY_POLICIES].sort(), [
    "device-fraction", "free-fraction-after-weights", "gguf-estimate", "measured", "server-reported", "static-fraction-of-free", "weights-plus-kv",
  ]);
  for (const policy of fitBar.MEMORY_POLICIES) {
    const key = fitBar.policyKey(policy);
    assert.equal(key, `models.fit.policy.${policy}`);
    for (const locale of ["zh", "en"]) assert.ok(String(catalogs[locale][key] || "").trim(), `${locale} has no label for ${policy}`);
  }
  assert.equal(fitBar.policyKey("made-up-policy"), null, "an unknown policy has no key; the page shows its raw name");
  assert.equal(fitBar.policyKey(undefined), null);
});

test("every goal, fit and plan key exists in zh and en with the same placeholders", () => {
  const keys = Object.keys(catalogs.en).filter((key) => /^models\.(goal|fit|plan)\./.test(key) || key.startsWith("models.wizard.resources."));
  assert.ok(keys.length >= 60);
  for (const key of keys) {
    assert.ok(catalogs.zh[key], `zh is missing ${key}`);
    const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
    assert.equal(holes(catalogs.zh[key]), holes(catalogs.en[key]), `placeholders of ${key}`);
  }
  for (const goal of wizard.GOALS) assert.ok(catalogs.en[`models.goal.${goal}`] && catalogs.zh[`models.goal.${goal}`], goal);
  for (const key of ["weights", "kv", "activations", "draft", "mmproj", "headroom", "ram", "kvPool", "expertOffload", "spill"]) assert.ok(catalogs.zh[`models.fit.${key}`], key);
  assert.equal(catalogs.en["models.fit.spill"], "Some weights or KV sit in system RAM; expect lower speed");
});

// ---- plan cards ---------------------------------------------------------------------------------

const PLAN = {
  planId: "pl_1", rank: 1, gpuIds: ["0"], goal: "balanced", engineId: "llamacpp", runtimeId: "llamacpp@b10630", recipeId: null,
  title: { zh: "llama.cpp · 128K", en: "llama.cpp · 128K" },
  values: {
    "llamacpp.nCpuMoe": { value: 2, source: "planner", reason: { zh: "把专家放到内存", en: "moves experts to RAM" } },
    contextLength: { value: 131072, source: "planner" },
    "llamacpp.gpuLayers": { value: "all", source: "planner" },
    concurrency: { value: 1, source: "planner" },
  },
  fit: MEMORY,
  tradeoffs: [{ zh: "生成变慢", en: "Generation is slower" }],
  validated: null,
};

test("a plan card is validated, failed or not validated; validated null is the manager being absent", () => {
  assert.equal(planCards.validationOf(PLAN), "unvalidated");
  assert.equal(planCards.validationOf({ validated: { ok: true, errors: [] } }), "ok");
  assert.equal(planCards.validationOf({ validated: { ok: true, errors: [{ code: "x" }] } }), "failed");
  assert.equal(planCards.validationOf({ validated: { ok: false, errors: [] } }), "failed");
  assert.equal(planCards.validationOf(null), "unvalidated");
});

test("a card leads with context, concurrency and KV, and shows at most six settings", () => {
  const rows = planCards.keyValues(PLAN);
  assert.deepEqual(rows.map((row) => row.id), ["contextLength", "concurrency", "llamacpp.nCpuMoe", "llamacpp.gpuLayers"]);
  assert.deepEqual(rows[2].reason, { zh: "把专家放到内存", en: "moves experts to RAM" });
  const many = { values: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, { value: index, source: "planner" }])) };
  assert.equal(planCards.keyValues(many).length, 6);
});

test("applying a plan hands its catalog ids over unchanged, as exactly { value, source: planner }", () => {
  const values = model.planValues(PLAN);
  assert.deepEqual(Object.keys(values).sort(), Object.keys(PLAN.values).sort(), "no id is renamed, added or dropped");
  for (const [id, entry] of Object.entries(values)) {
    assert.deepEqual(Object.keys(entry).sort(), ["source", "value"], `${id} carries no reason`);
    assert.equal(entry.source, "planner");
    assert.deepEqual(entry.value, PLAN.values[id].value);
  }
  assert.equal(planCards.planValues, model.planValues);
  assert.ok(PLAN.values["llamacpp.nCpuMoe"].reason, "the plan itself is not mutated");
});

// ---- applying a plan to the draft ----------------------------------------------------------------

const DRAFT = wizard.createDraft({
  modelRef: { kind: "local", entryId: null, path: "C:/fixture/models/example", cardId: "mc_aaaaaaaaaaaaaaaaaaaa" },
  engineId: "vllm", managerId: "vllm", runtimeId: "vllm@0.28.0", recipeId: "old-recipe", gpus: ["0", "1"],
  values: { contextLength: 4096, "vllm.cpuOffloadGb": 8, "speculative.method": "off", "llamacpp.cacheTypeK": "q8_0" },
  acknowledge: ["experimental-engine", "other"],
});

test("planDraft sets provenance planner, the GPU set, and drops the old engine's own settings on an engine change", () => {
  const next = model.planDraft(DRAFT, PLAN, { managerId: "llama", experimental: false });
  assert.equal(next.engineId, "llamacpp");
  assert.equal(next.managerId, "llama");
  assert.equal(next.runtimeId, "llamacpp@b10630");
  assert.equal(next.recipeId, "");
  assert.deepEqual(next.gpus, ["0"]);
  assert.equal(next.goal, "balanced");
  assert.deepEqual(next.values.contextLength, { value: 131072, source: "planner" });
  assert.deepEqual(next.values["llamacpp.nCpuMoe"], { value: 2, source: "planner" });
  assert.equal(Object.hasOwn(next.values, "vllm.cpuOffloadGb"), false, "another engine's setting is dropped");
  assert.equal(next.values["speculative.method"], "off", "a shared setting stays");
  assert.equal(next.values["llamacpp.cacheTypeK"], "q8_0", "the new engine's own setting stays unless the plan sets it");
  assert.deepEqual(next.acknowledge, ["other"], "the experimental acknowledgement follows the new engine");
  assert.deepEqual(model.planDraft(DRAFT, PLAN, { managerId: "llama", experimental: true }).acknowledge, ["other", "experimental-engine"]);
  assert.equal(DRAFT.engineId, "vllm", "the draft is not mutated");
});

test("the request of an applied plan sends planner values as { value, source }", () => {
  const next = model.planDraft(DRAFT, PLAN, { managerId: "llama" });
  const request = wizard.planRequest(next, {});
  assert.deepEqual(request.values.contextLength, { value: 131072, source: "planner" });
  assert.equal(request.engineId, "llamacpp");
  assert.deepEqual(request.instance.gpuIds, ["0"]);
});

test("a plan of the same engine keeps the manager and the user's other values", () => {
  const plan = { ...PLAN, engineId: "vllm", runtimeId: "vllm@0.28.0", recipeId: "r1", values: { contextLength: { value: 8192, source: "planner" } } };
  const next = model.planDraft(DRAFT, plan, { managerId: "ignored" });
  assert.equal(next.managerId, "vllm");
  assert.equal(next.recipeId, "r1");
  assert.equal(next.values["vllm.cpuOffloadGb"], 8);
  assert.deepEqual(next.values.contextLength, { value: 8192, source: "planner" });
  assert.deepEqual(next.gpus, ["0"]);
  assert.deepEqual(model.planDraft(DRAFT, { ...plan, gpuIds: undefined }).gpus, ["0", "1"], "a plan without a GPU set keeps the draft's GPUs");
});

test("engineRows names the engine and recipe a plan changes ahead of the value rows", () => {
  const labels = { engine: "Engine", recipe: "Recipe" };
  assert.deepEqual(model.engineRows(DRAFT, PLAN, labels), [
    { id: "engine", label: "Engine", from: "vllm@0.28.0", to: "llamacpp@b10630" },
    { id: "recipe", label: "Recipe", from: "old-recipe", to: "" },
  ]);
  assert.deepEqual(model.engineRows({ ...DRAFT, recipeId: "" }, { ...PLAN, engineId: "vllm", runtimeId: "vllm@0.28.0" }, labels), []);
});

test("the diff starts from the plan's effective values under the draft's explicit ones", () => {
  const current = model.currentValues({ values: { contextLength: { value: 131072, source: "engine-default", reason: "x" }, concurrency: { value: 1, source: "engine-default" } } }, DRAFT);
  assert.deepEqual(current.contextLength, 4096, "the user's value wins");
  assert.deepEqual(current.concurrency, { value: 1, source: "engine-default" });
  const rows = wizard.diffValues(current, model.planValues(PLAN), null, { locale: "en-US" });
  const context = rows.find((row) => row.id === "contextLength");
  assert.deepEqual({ from: context.from, to: context.to, source: context.source }, { from: "4096", to: "131072", source: "planner" });
});

test("recommendBody sends the picked GPUs as one set and omits gpuSets when none is picked", () => {
  assert.deepEqual(model.recommendBody("mc_x", "balanced", ["0", "1"]), { cardId: "mc_x", goal: "balanced", gpuSets: [["0", "1"]] });
  assert.deepEqual(model.recommendBody("mc_x", "throughput", []), { cardId: "mc_x", goal: "throughput" });
});

test("missingEndpoint is a 404 route, 405, 501 or endpoint_unavailable", () => {
  for (const error of [{ status: 404 }, { status: 405 }, { status: 501 }, { code: "endpoint_unavailable" }, { code: "feature_unavailable" }]) assert.equal(model.missingEndpoint(error), true);
  for (const error of [{ status: 500 }, { status: 400, code: "invalid_goal" }, null, {}]) assert.equal(model.missingEndpoint(error), false);
});

// ---- the resource panel's numbers ----------------------------------------------------------------

test("the admission verdict has a label per value and nothing for an unknown one", () => {
  assert.deepEqual(model.admissionOf({ admission: { verdict: "ok", message: "m" } }), { verdict: "ok", status: "ok", key: "models.fit.verdict.ok", message: "m" });
  assert.equal(model.admissionOf({ admission: { verdict: "block" } }).status, "error");
  assert.equal(model.admissionOf({ admission: { verdict: "warn" } }).key, "models.fit.verdict.warn");
  assert.equal(model.admissionOf({ admission: { verdict: "maybe" } }), null);
  assert.equal(model.admissionOf(null), null);
  assert.equal(catalogs.en["models.fit.verdict.ok"], "Fits");
  assert.equal(catalogs.en["models.fit.verdict.warn"], "Tight");
  assert.equal(catalogs.en["models.fit.verdict.block"], "Does not fit");
});

test("one GPU's bar scales the plan's breakdown to that GPU's share of the memory", () => {
  const memory = { perGpuMb: { 0: 30000, 1: 10000 }, breakdown: { weights: 24000, kv: 12000, activations: 4000 } };
  const first = model.gpuSegments(memory, "0");
  const second = model.gpuSegments(memory, "1");
  assert.deepEqual(first, [{ kind: "weights", mb: 18000 }, { kind: "kv", mb: 9000 }, { kind: "activations", mb: 3000 }]);
  assert.equal(second.reduce((sum, segment) => sum + segment.mb, 0), 10000);
  assert.deepEqual(model.gpuSegments({ perGpuMb: { 0: 100 }, breakdown: { weights: 100 } }, "0"), [{ kind: "weights", mb: 100 }]);
  assert.deepEqual(model.gpuSegments(null, "0"), []);
});

test("fitOf gives a plan's memory a budget from the free memory of its GPUs when it has none", () => {
  const gpus = model.hostGpus({ gpus: [{ id: 0, name: "A", totalMb: 100, freeMb: 90, usedMb: 10 }, { id: "1", totalMb: 50 }, null, { name: "no id" }] });
  assert.deepEqual(gpus.map((gpu) => gpu.id), ["0", "1"]);
  assert.equal(gpus[1].freeMb, null);
  const fit = model.fitOf({ perGpuMb: { 0: 40 }, breakdown: { weights: 40 } }, gpus);
  assert.deepEqual(fit.budgetMb, { 0: 90 });
  assert.equal(fitBar.fitModel(fit).headroomMb, 50);
  const own = { perGpuMb: { 0: 40 }, breakdown: { weights: 40 }, headroomMb: 7 };
  assert.equal(model.fitOf(own, gpus), own, "a memory that knows its headroom is left alone");
  assert.equal(model.fitOf({ perGpuMb: {} }, gpus), null);
});

// ---- the fit solver -------------------------------------------------------------------------------

const GRID = {
  ok: true, engineId: "vllm", native: 262144,
  cells: [
    { kvDtype: "auto", concurrency: 1, maxContext: 262144, limitedBy: "native", status: "ok", spill: false },
    { kvDtype: "fp8", concurrency: 1, maxContext: 262144, limitedBy: "native", status: "ok", spill: false },
    { kvDtype: "auto", concurrency: 4, maxContext: 65536, limitedBy: "vram", status: "ok", spill: false },
    { kvDtype: "fp8", concurrency: 4, maxContext: 131072, limitedBy: "vram", status: "warn", spill: true },
    { kvDtype: "auto", concurrency: 8, maxContext: 0, limitedBy: "vram", status: "fail", spill: false },
  ],
};

test("the grid is a table of KV dtype by concurrency; a cell says fits, uses RAM or does not fit", () => {
  const view = solver.gridView(GRID);
  assert.deepEqual(view.kvDtypes, ["auto", "fp8"]);
  assert.deepEqual(view.concurrency, [1, 4, 8]);
  assert.equal(view.native, 262144);
  assert.equal(view.cell("fp8", 4).maxContext, 131072);
  assert.equal(view.cell("fp8", 8), null, "a missing cell is empty");
  assert.equal(solver.cellTone(view.cell("auto", 1)), "fits");
  assert.equal(solver.cellTone(view.cell("fp8", 4)), "spill");
  assert.equal(solver.cellTone(view.cell("auto", 8)), "none");
  assert.equal(solver.cellTone({ maxContext: 100, status: "fail" }), "none");
  assert.equal(solver.cellTone({ maxContext: null }), "none");
  assert.deepEqual(solver.gridView(null).kvDtypes, []);
});

test("a cell stands for context, concurrency and the KV dtype under the engine's own catalog ids", () => {
  const cell = GRID.cells[3];
  assert.deepEqual(solver.cellValues("vllm", cell), { contextLength: 131072, concurrency: 4, kvCacheDtype: "fp8" });
  assert.deepEqual(solver.cellValues("llamacpp", { ...cell, kvDtype: "q8_0" }), { contextLength: 131072, concurrency: 4, "llamacpp.cacheTypeK": "q8_0", "llamacpp.cacheTypeV": "q8_0" });
  assert.deepEqual(solver.kvParamsFor("sglang"), ["kvCacheDtype"]);
});

test("the grid asks for the catalog's KV dtypes in the preferred order", () => {
  const vllm = readJson(path.join(FIXTURES, "schema-vllm.json"));
  assert.deepEqual(solver.gridKvDtypes("vllm", vllm), ["auto", "fp8", "fp8_e5m2"]);
  assert.deepEqual(solver.gridKvDtypes("vllm", vllm, 2), ["auto", "fp8"]);
  assert.deepEqual(solver.gridKvDtypes("vllm", null), ["auto", "fp8"], "without a catalog the two common dtypes");
  assert.deepEqual(solver.gridKvDtypes("llamacpp", null), ["f16", "q8_0"]);
  assert.ok(solver.gridKvDtypes("vllm", vllm).length <= 4, "02 allows at most four KV dtypes");
});

test("without a grid the FitResult suggestions are the chips, with their delta", () => {
  const chips = solver.suggestionChips({
    suggestions: [
      { code: "kv_fp8", param: "kvCacheDtype", to: "fp8", deltaMb: -8192, message: { zh: "fp8 KV 可省 8 GiB", en: "fp8 KV saves 8 GiB" } },
      { code: "ctx", param: "contextLength", to: 65536 },
      { code: "bad" },
      null,
    ],
  });
  assert.deepEqual(chips.map((chip) => [chip.code, chip.param, chip.to, chip.deltaMb]), [["kv_fp8", "kvCacheDtype", "fp8", -8192], ["ctx", "contextLength", 65536, null]]);
  assert.deepEqual(solver.suggestionChips(null), []);
});
