"use strict";

// Launch planner (docs/overhaul/02-models.md §11, §21.2 planner.test.js,
// MOD-14): the §11 fixture expectations with tolerances (DeepSeek-V4 Q2_K
// balanced on one 96 GB GPU -> llama.cpp with a few expert layers in RAM;
// Qwen3.8-27B FP8 max-context -> vLLM 262144 x 1 without offload), catalog ids
// with source "planner" only, at most three diversified plans per GPU set,
// the RAM reserve, recipes keeping their locks, and the constraints. The real
// engines/memory-models.js and bundled catalogs are used throughout.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const core = require("..");
const { planLaunches, GOALS } = require("../model-inspector/planner");
const { evaluateCompatibility } = require("../model-inspector/compatibility");
const paramCatalog = require("../engines/param-catalog");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CARDS = path.join(__dirname, "fixtures", "model-cards");

function fixtureCard(id) {
  return structuredClone(require(path.join(CARDS, id, "expected-card.json")));
}

const QWEN = fixtureCard("qwen38-27b-fp8");
const DEEPSEEK = fixtureCard("deepseek-v4-flash-q2k-gguf");
const GPU = Object.freeze({ name: "GPU", totalMb: 97887, freeMb: 97000, usedMb: 600, computeCap: "12.0" });
const HOST = Object.freeze({
  gpus: [{ id: "0", ...GPU }],
  ramBytes: 256 * GIB,
  ramFreeBytes: 200 * GIB,
  platform: "wsl",
});
const TWO_GPUS = Object.freeze({ ...HOST, gpus: [{ id: "0", ...GPU }, { id: "1", ...GPU }] });
// A dedicated 96 GB card: gpu-admission policy without the shared-desktop margins.
const DEDICATED = Object.freeze({ maxUtilizationPct: 98, reserveMb: 1024 });

// Compatibility rows computed once per card and host, with an empty env so no
// developer override flag changes a verdict.
const rowCache = new Map();
function rowsFor(card, host = HOST) {
  const key = `${card.contentDigest}|${host.gpus.length}`;
  if (!rowCache.has(key)) rowCache.set(key, evaluateCompatibility(card, { host, env: {} }));
  return rowCache.get(key);
}

function plan(input) {
  const host = input.host || HOST;
  return planLaunches({ recipes: [], rows: rowsFor(input.card, host), ...input, host });
}

function plainValues(item) {
  return Object.fromEntries(Object.entries(item.values).map(([id, entry]) => [id, entry.value]));
}

function ramUsedMb(item) {
  return item.fit.ram.weights + item.fit.ram.experts + item.fit.ram.kv;
}

function assertPlanContract(sets) {
  for (const set of sets) {
    assert.ok(set.plans.length <= 3, `at most 3 plans per GPU set, got ${set.plans.length}`);
    assert.ok(Array.isArray(set.notes));
    const seen = new Set();
    set.plans.forEach((item, index) => {
      assert.equal(item.rank, index + 1);
      assert.match(item.planId, /^pl_\d+$/);
      assert.deepEqual(item.gpuIds, set.gpuIds);
      assert.equal(item.validated, null);
      assert.ok(item.title.zh && item.title.en);
      const catalog = paramCatalog.loadCatalog(item.engineId);
      for (const [id, entry] of Object.entries(item.values)) {
        assert.ok(catalog.byId.has(id), `${id} is a ${item.engineId} catalog id`);
        assert.equal(entry.source, "planner", `${id} carries source planner`);
        assert.ok(Object.hasOwn(entry, "value"));
      }
      assert.deepEqual(paramCatalog.validateValues(plainValues(item), catalog, {}).errors, []);
      assert.notEqual(item.fit.status, "fail");
      const key = `${item.engineId}|${item.recipeId}|${JSON.stringify(plainValues(item))}`;
      assert.ok(!seen.has(key), "plans of one GPU set are distinct");
      seen.add(key);
    });
    // Diversified: the best plan of each engine first, then the winner's alternative.
    const engines = set.plans.map((item) => item.engineId);
    const firstRepeat = engines.findIndex((id, index) => engines.indexOf(id) !== index);
    if (firstRepeat >= 0) {
      assert.equal(engines[firstRepeat], engines[0]);
      assert.equal(new Set(engines.slice(0, firstRepeat)).size, firstRepeat);
    }
  }
}

test("core.models.planner exposes planLaunches", () => {
  assert.equal(core.models.planner.planLaunches, planLaunches);
  assert.deepEqual(core.models.planner.GOALS, ["max-context", "balanced", "throughput", "low-vram"]);
});

test("DeepSeek-V4 Q2_K balanced on one 96 GB GPU -> llama.cpp, a few expert layers in RAM, context >= 32K", () => {
  const sets = plan({ card: DEEPSEEK, goal: "balanced", host: { ...HOST, admissionPolicy: DEDICATED } });
  assert.equal(sets.length, 1);
  assertPlanContract(sets);
  const best = sets[0].plans[0];
  assert.equal(best.engineId, "llamacpp");
  assert.equal(best.runtimeId, "llamacpp@b10630");
  const nCpuMoe = best.values["llamacpp.nCpuMoe"].value;
  assert.ok(nCpuMoe >= 1 && nCpuMoe <= 6, `llamacpp.nCpuMoe ${nCpuMoe} in [1, 6]`);
  assert.ok(best.values.contextLength.value >= 32768);
  assert.equal(best.values.concurrency.value, 4);
  assert.equal(best.values["llamacpp.gpuLayers"].value, "all");
  assert.match(best.values["llamacpp.nCpuMoe"].reason, /routed experts to RAM/);
  assert.equal(best.fit.spill, true);
  assert.ok(best.fit.ram.experts > 0);
  // The card's architecture is not in the knowledge: support needs a probe.
  assert.equal(best.requiresProbe, true);
  assert.ok(best.tradeoffs.some((item) => /CPU/.test(item.en)));
  assert.match(best.title.en, /^llama\.cpp · \d+K context · 4 parallel requests · experts of \d+ layers in RAM/);
  // Every plan keeps 5 % headroom on the graded estimate.
  for (const item of sets[0].plans) assert.ok(item.fit.headroomMb >= 0.05 * item.fit.budgetMb["0"]);
});

test("DeepSeek-V4 balanced under gpu-admission's default policy still lands on llama.cpp with expert offload", () => {
  const sets = plan({ card: DEEPSEEK, goal: "balanced" });
  assertPlanContract(sets);
  const best = sets[0].plans[0];
  assert.equal(best.engineId, "llamacpp");
  const nCpuMoe = best.values["llamacpp.nCpuMoe"].value;
  assert.ok(nCpuMoe >= 1 && nCpuMoe <= DEEPSEEK.topology.layers);
  assert.ok(best.values.contextLength.value >= 32768);
  // vLLM can load the GGUF too, but not natively: it ranks behind llama.cpp.
  const vllm = sets[0].plans.find((item) => item.engineId === "vllm");
  if (vllm) assert.ok(vllm.rank > best.rank);
});

test("Qwen3.8-27B FP8 max-context -> vLLM 262144 x 1 without offload, KV pool >= one full-length request", () => {
  const sets = plan({ card: QWEN, goal: "max-context" });
  assertPlanContract(sets);
  const best = sets[0].plans[0];
  assert.equal(best.engineId, "vllm");
  assert.equal(best.values.contextLength.value, 262144);
  assert.equal(best.values.concurrency.value, 1);
  assert.equal(best.values.kvCacheDtype.value, "auto");
  assert.equal(best.values["vllm.cpuOffloadGb"]?.value ?? 0, 0);
  assert.equal(best.fit.spill, false);
  assert.equal(best.fit.offloadedMb, 0);
  assert.ok(best.fit.maxFullLengthRequests >= 1);
  assert.ok(best.fit.kvPoolTokens >= 262144);
  assert.equal(best.requiresProbe, false);
  // Memory-first goals keep speculative decoding off even where the family enables it.
  assert.equal(best.values["speculative.method"].value, "off");
});

test("every goal on both fixtures: catalog ids with source planner, <= 3 diversified plans per GPU set", () => {
  for (const card of [QWEN, DEEPSEEK]) {
    for (const goal of GOALS) {
      const sets = plan({ card, goal, host: TWO_GPUS });
      assert.deepEqual(sets.map((set) => set.gpuIds), [["0"], ["1"], ["0", "1"]]);
      assertPlanContract(sets);
      for (const set of sets) {
        assert.ok(set.plans.length >= 1, `${goal} plans something on [${set.gpuIds}]`);
        for (const item of set.plans) assert.equal(item.goal, goal);
      }
    }
  }
});

test("goal shapes: throughput favours concurrency with speculative decoding, low-vram the smallest context", () => {
  const throughput = plan({ card: QWEN, goal: "throughput" })[0].plans;
  assert.equal(throughput[0].values.contextLength.value, 32768);
  assert.ok(throughput[0].values.concurrency.value >= 16);
  assert.ok(throughput.every((item) => item.fit.offloadedMb === 0));
  assert.ok(throughput.some((item) => item.values["speculative.method"]?.value === "mtp"), "the family's MTP is tried for throughput");
  const lowVram = plan({ card: QWEN, goal: "low-vram" })[0].plans;
  assert.equal(lowVram[0].values.contextLength.value, 8192);
  assert.equal(lowVram[0].values.concurrency.value, 1);
});

test("multi-GPU sets: vLLM gets tensorParallel over the set; explicit gpuSets are respected", () => {
  const sets = plan({ card: QWEN, goal: "balanced", host: TWO_GPUS, gpuSets: [["0", "1"], ["7"]] });
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].gpuIds, ["0", "1"]);
  assert.equal(sets[0].plans[0].values.tensorParallel.value, 2);
  assert.ok(sets[0].notes.some((note) => note.en.includes("[7]")));
  const single = plan({ card: QWEN, goal: "balanced", host: TWO_GPUS, gpuSets: [["1"]] });
  assert.equal(Object.hasOwn(single[0].plans[0].values, "tensorParallel"), false);
});

test("the RAM reserve is respected: host RAM use stays below ramFree - ramReserve", () => {
  const host = { ...HOST, ramFreeBytes: 24 * GIB, admissionPolicy: DEDICATED };
  const relaxed = plan({ card: DEEPSEEK, goal: "balanced", host });
  assertPlanContract(relaxed);
  assert.ok(relaxed[0].plans.length >= 1);
  for (const item of relaxed[0].plans) assert.ok(ramUsedMb(item) <= 24 * 1024 - 16 * 1024);
  const offloaded = relaxed[0].plans[0];
  assert.ok(ramUsedMb(offloaded) > 4 * 1024, "the best plan needs more than 4 GiB of RAM");

  // A 20 GiB reserve leaves 4 GiB: that plan can no longer be offered.
  const strict = plan({ card: DEEPSEEK, goal: "balanced", host, constraints: { ramReserveGb: 20 } });
  assertPlanContract(strict);
  for (const item of strict[0].plans) assert.ok(ramUsedMb(item) <= 4 * 1024, `RAM ${ramUsedMb(item)} MiB within the reserve`);
  assert.ok(!strict[0].plans.some((item) => JSON.stringify(plainValues(item)) === JSON.stringify(plainValues(offloaded))));

  // Default reserve (16 GiB) applies when the constraint is absent.
  const tiny = plan({ card: DEEPSEEK, goal: "balanced", host: { ...host, ramFreeBytes: 17 * GIB } });
  for (const item of tiny[0].plans) assert.ok(ramUsedMb(item) <= 1024);
});

test("allowCpuOffload false and engines[] narrow the search", () => {
  const sets = plan({ card: DEEPSEEK, goal: "balanced", host: { ...HOST, admissionPolicy: DEDICATED }, constraints: { allowCpuOffload: false } });
  assertPlanContract(sets);
  for (const item of sets[0].plans) {
    assert.equal(item.fit.offloadedMb, 0);
    assert.equal(item.values["llamacpp.nCpuMoe"]?.value ?? 0, 0);
  }
  if (!sets[0].plans.length) assert.ok(sets[0].notes.some((note) => /fits/.test(note.en)));

  const only = plan({ card: DEEPSEEK, goal: "balanced", constraints: { engines: ["vllm"] } });
  assert.ok(only[0].plans.every((item) => item.engineId === "vllm"));

  const minContext = plan({ card: QWEN, goal: "low-vram", constraints: { minContext: 32768 } });
  assert.ok(minContext[0].plans[0].values.contextLength.value >= 32768);
  const concurrency = plan({ card: QWEN, goal: "max-context", constraints: { concurrency: 2 } });
  assert.equal(concurrency[0].plans[0].values.concurrency.value, 2);
});

test("unverified rows join only with includeUnverified and are flagged requiresProbe", () => {
  const plain = plan({ card: QWEN, goal: "max-context" });
  assert.ok(plain[0].plans.every((item) => item.engineId !== "sglang"));
  assert.ok(plain[0].notes.some((note) => note.en.includes("include unverified")));
  const wide = plan({ card: QWEN, goal: "max-context", constraints: { includeUnverified: true } });
  assertPlanContract(wide);
  const sglang = wide[0].plans.find((item) => item.engineId === "sglang");
  assert.ok(sglang, "an SGLang plan with includeUnverified");
  assert.equal(sglang.requiresProbe, true);
  assert.equal(sglang.support.verdict, "unknown");
  assert.ok(sglang.rank > 1, "the verified engine ranks first");
});

test("a missing catalog id removes its strategy with a note", () => {
  const full = paramCatalog.loadCatalog("llamacpp");
  // A GET /schema-like payload without llamacpp.nCpuMoe.
  const payload = { engineId: "llamacpp", params: full.params.filter((param) => param.id !== "llamacpp.nCpuMoe") };
  const sets = plan({ card: DEEPSEEK, goal: "balanced", host: { ...HOST, admissionPolicy: DEDICATED }, catalogs: { llamacpp: payload } });
  assert.ok(sets[0].notes.some((note) => note.en.includes("llamacpp.nCpuMoe") && note.en.includes("removed")));
  for (const item of sets[0].plans) assert.equal(Object.hasOwn(item.values, "llamacpp.nCpuMoe"), false);
  // Without a catalog the engine is not planned at all.
  const none = plan({ card: QWEN, goal: "max-context", catalogs: { vllm: null } });
  assert.ok(none[0].plans.every((item) => item.engineId !== "vllm"));
  assert.ok(none[0].notes.some((note) => note.en.includes("No parameter catalog") && note.en.includes("vllm")));
});

test("matching recipes are evaluated first and keep their locks; locked ids stay out of values", () => {
  const recipe = {
    schemaVersion: 1,
    id: "test-fp8-kv",
    kind: "model",
    status: "verified",
    engineId: "vllm",
    label: { zh: "测试方案", en: "Test recipe" },
    match: { contentDigest: QWEN.contentDigest.replace(/^sha256:/, "") },
    values: { "speculative.method": "off" },
    locks: [{ param: "kvCacheDtype", value: "fp8", reason: { zh: "测试", en: "test" } }],
  };
  const other = { ...recipe, id: "test-other-model", match: { contentDigest: "f".repeat(64) } };
  const sets = plan({ card: QWEN, goal: "balanced", recipes: [recipe, other] });
  assertPlanContract(sets);
  const withRecipe = sets[0].plans.find((item) => item.recipeId === "test-fp8-kv");
  assert.ok(withRecipe, "the matching recipe yields a plan");
  assert.deepEqual(withRecipe.locks, ["kvCacheDtype"]);
  assert.equal(Object.hasOwn(withRecipe.values, "kvCacheDtype"), false);
  assert.equal(Object.hasOwn(withRecipe.values, "speculative.method"), false, "recipe values are left to the recipe");
  assert.equal(withRecipe.requiresProbe, false);
  assert.ok(!sets[0].plans.some((item) => item.recipeId === "test-other-model"));
});

test("invalid input is a coded error; planning is deterministic and side-effect free", () => {
  assert.throws(() => planLaunches({ host: HOST }), (error) => error.code === "planner_input_invalid" && error.status === 400);
  assert.throws(() => planLaunches({ card: QWEN, host: HOST, goal: "fastest" }), (error) => error.code === "invalid_value");
  const card = structuredClone(QWEN);
  const input = { card, goal: "balanced", host: HOST, rows: rowsFor(QWEN), recipes: [] };
  const first = planLaunches(input);
  assert.deepEqual(planLaunches(input), first);
  assert.deepEqual(card, QWEN, "the card is not mutated");
  // No GPUs: no sets, no throw.
  assert.deepEqual(planLaunches({ card: QWEN, host: { gpus: [] }, rows: [], recipes: [] }), []);
});
