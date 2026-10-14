"use strict";

// The recipe validator (01-engines §10.1, 00 §9.10): every bundled recipe
// validates, and the checks the loader, the console and 02's save-as-recipe
// rely on reject what they must.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("../index");
const paramCatalog = require("../engines/param-catalog");
const recipeSchema = require("../engines/recipe-schema");

const RECIPES_DIR = path.join(__dirname, "..", "data", "recipes");
const registry = core.engines.createEngineRegistry({ env: {} });
const catalogs = paramCatalog.getParamCatalog();

function options(extra = {}) {
  return { catalogs, registry, validateValues: paramCatalog.validateValues, mode: "bundled", ...extra };
}

function readBundled() {
  return fs.readdirSync(RECIPES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, recipe: JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, name), "utf8")) }));
}

function bundled(id) {
  return JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, `${id}.json`), "utf8"));
}

function errorKeys(result) {
  return result.errors.map((item) => `${item.path}:${item.code}`);
}

test("validateRecipe is exported by core.engines.recipeSchema", () => {
  assert.equal(typeof core.engines.recipeSchema.validateRecipe, "function");
  assert.equal(core.engines.recipeSchema.validateRecipe, recipeSchema.validateRecipe);
  assert.equal(core.engines.validateRecipe, recipeSchema.validateRecipe);
});

test("the bundled set is 11 model recipes and 10 scenario recipes", () => {
  const all = readBundled();
  assert.equal(all.length, 21);
  assert.equal(all.filter((item) => item.recipe.kind === "model").length, 11);
  assert.equal(all.filter((item) => item.recipe.kind === "scenario").length, 10);
  for (const { name, recipe } of all) assert.equal(`${recipe.id}.json`, name, "the file is named after its recipe id");
  assert.equal(new Set(all.map((item) => item.recipe.id)).size, 21);
});

test("every bundled recipe passes validateRecipe with the real registry and catalogs", () => {
  for (const { recipe } of readBundled()) {
    const result = recipeSchema.validateRecipe(recipe, options());
    assert.deepEqual(result.errors, [], recipe.id);
    assert.equal(result.ok, true, recipe.id);
    assert.deepEqual(result.warnings, [], `${recipe.id} (bundled recipes carry no warnings)`);
  }
});

test("a bundled recipe also validates structurally without catalogs or a registry", () => {
  for (const { recipe } of readBundled()) {
    const result = recipeSchema.validateRecipe(recipe, { mode: "bundled" });
    assert.deepEqual(result.errors, [], recipe.id);
  }
});

test("no bundled recipe holds an absolute or user path", () => {
  const pathLike = /(?:^|[\s="',:;])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9]|\/(?:home|Users)\/|~[\\/])/;
  for (const { name } of readBundled()) {
    const text = fs.readFileSync(path.join(RECIPES_DIR, name), "utf8");
    const strings = [];
    JSON.parse(text, (key, value) => {
      if (typeof value === "string") strings.push(value);
      return value;
    });
    for (const value of strings) assert.equal(pathLike.test(value), false, `${name}: ${value}`);
    assert.equal(/\\Users\\|\/Users\/|@[a-z0-9-]+\.[a-z]{2,}/i.test(text), false, name);
  }
});

test("a profile's modelDir is a bare directory name", () => {
  for (const { recipe } of readBundled()) {
    if (!recipe.profile?.modelDir) continue;
    assert.match(recipe.profile.modelDir, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, recipe.id);
  }
});

test("a host path in a recipe is rejected", () => {
  const recipe = bundled("qwen38-flashnext-262k");
  recipe.notes = [{ zh: "/home/someone/models", en: "D:/data/models" }];
  const result = recipeSchema.validateRecipe(recipe, options());
  assert.equal(result.ok, false);
  assert.deepEqual(errorKeys(result), ["notes[0].zh:host_path", "notes[0].en:host_path"]);
});

test("an unknown param id in values, derived or locks is rejected when catalogs are given", () => {
  const recipe = bundled("qwen38-flashnext-262k");
  recipe.values["sglang.noSuchParam"] = 1;
  recipe.derived["sglang.alsoMissing"] = { const: 2 };
  recipe.locks[0].param = "nope.lockedParam";
  const result = recipeSchema.validateRecipe(recipe, options());
  assert.equal(result.ok, false);
  const keys = errorKeys(result);
  assert.ok(keys.includes("values.sglang.noSuchParam:unknown_param"), keys.join());
  assert.ok(keys.includes("derived.sglang.alsoMissing:unknown_param"), keys.join());
  assert.ok(keys.includes("locks[0].param:unknown_param"), keys.join());
  // Without catalogs the same ids cannot be judged.
  assert.equal(recipeSchema.validateRecipe(recipe, { registry, mode: "bundled" }).ok, true);
});

test("a bad expression is rejected: unknown operator, unknown param leaf, env outside the allowlist", () => {
  const unknownOperator = bundled("qwen38-flashnext-262k");
  unknownOperator.derived["sglang.pageSize"] = { bogusOp: [1] };
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(unknownOperator, options())), ["derived.sglang.pageSize:expr_unknown_operator"]);

  const unknownLeaf = bundled("qwen38-flashnext-262k");
  unknownLeaf.derived["sglang.pageSize"] = { param: "sglang.neverDefined" };
  const leafResult = recipeSchema.validateRecipe(unknownLeaf, options());
  assert.equal(leafResult.ok, false);
  assert.ok(errorKeys(leafResult).some((key) => key.startsWith("derived.sglang.pageSize")), errorKeys(leafResult).join());

  const envOutside = bundled("qwen38-flashnext-262k");
  envOutside.values.quantization = { expr: { env: "VLLM_NOT_DECLARED" } };
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(envOutside, options())), ["values.quantization.expr.env:expr_env_not_allowed"]);

  const tooDeep = bundled("qwen38-flashnext-262k");
  let ast = { const: 1 };
  for (let i = 0; i < 40; i += 1) ast = { not: [ast] };
  tooDeep.derived["sglang.pageSize"] = ast;
  assert.equal(recipeSchema.validateRecipe(tooDeep, options()).ok, false, "expr.js depth limit applies");
});

test("inputs.env takes only VLLM_/SGLANG_/LLAMA_ style names", () => {
  const recipe = bundled("qwen36-nvfp4-vllm");
  assert.equal(recipeSchema.validateRecipe(recipe, options()).ok, true);
  recipe.inputs.env = ["lower_case"];
  const keys = errorKeys(recipeSchema.validateRecipe(recipe, options()));
  assert.ok(keys.includes("inputs.env[0]:env_name_invalid"), keys.join());
  // The expressions that read the now-undeclared names lose their allowlist.
  assert.ok(keys.some((key) => key.endsWith(":expr_env_not_allowed")), keys.join());
});

test("match.runtimeId must resolve to the runtime.ref runtime", () => {
  const recipe = bundled("qwen38-flashnext-262k");
  recipe.match.runtimeId = "sglang@not-the-runtime";
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(recipe, options())), ["match.runtimeId:match_runtime_mismatch"]);

  const withoutRuntime = bundled("qwen38-flashnext-262k");
  delete withoutRuntime.runtime;
  withoutRuntime.match.runtimeId = "sglang@flashnext-20260831";
  assert.ok(errorKeys(recipeSchema.validateRecipe(withoutRuntime, options())).includes("match.runtimeId:match_runtime_mismatch"));

  const matching = bundled("qwen38-flashnext-262k");
  const runtimeId = registry.resolveRuntime("sglang", { manifestKey: matching.runtime.ref }).runtimeId;
  matching.match.runtimeId = runtimeId;
  assert.equal(recipeSchema.validateRecipe(matching, options()).ok, true, runtimeId);
});

test("an unknown match key is rejected, and a scenario never carries a match", () => {
  const unknownKey = bundled("qwen38-flashnext-262k");
  unknownKey.match.extra = 1;
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(unknownKey, options())), ["match.extra:unknown_match_key"]);

  const scenario = bundled("scenario-low-vram-safe");
  scenario.match = { familyId: "qwen3.8-flash-next" };
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(scenario, options())), ["match:invalid_value"]);
});

test("match.capabilityIds is accepted; an owner file is told to move to familyId", () => {
  const recipe = bundled("qwen38-flashnext-262k");
  assert.deepEqual(recipe.match.capabilityIds, ["qwen3.8-flash-next"]);
  assert.equal(recipe.match.familyId, undefined);

  const asBundled = recipeSchema.validateRecipe(recipe, options({ mode: "bundled" }));
  assert.equal(asBundled.ok, true);
  assert.deepEqual(asBundled.warnings, [], "ENG-25 migrates the bundled files; they do not warn meanwhile");

  const asOverride = recipeSchema.validateRecipe(recipe, options({ mode: "override" }));
  assert.equal(asOverride.ok, true);
  assert.deepEqual(asOverride.warnings.map((item) => `${item.path}:${item.code}`), ["match.capabilityIds:recipe_match_deprecated"]);

  const familyForm = bundled("qwen38-flashnext-262k");
  familyForm.match = { familyId: "qwen3.8-flash-next", quant: ["nvfp4"] };
  const family = recipeSchema.validateRecipe(familyForm, options({ mode: "override" }));
  assert.equal(family.ok, true);
  assert.deepEqual(family.warnings, []);
});

test("identity checks: id pattern, kind, status, unregistered engine and unresolvable runtime", () => {
  const badId = bundled("qwen38-flashnext-262k");
  badId.id = "Bad_Id";
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(badId, options())), ["id:invalid_id"]);

  const badKind = bundled("qwen38-flashnext-262k");
  badKind.kind = "profile";
  badKind.status = "great";
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(badKind, options())), ["kind:invalid_value", "status:invalid_value"]);

  const unknownEngine = bundled("qwen38-flashnext-262k");
  unknownEngine.engineId = "no-such-engine";
  const engineResult = recipeSchema.validateRecipe(unknownEngine, options());
  assert.ok(errorKeys(engineResult).includes("engineId:unknown_engine"));

  const unknownRuntime = bundled("qwen38-flashnext-262k");
  unknownRuntime.runtime.ref = "noSuchRuntime";
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(unknownRuntime, options())), ["runtime.ref:runtime_unresolved"]);
});

test("unknown top-level fields and non-objects are rejected", () => {
  const extra = bundled("qwen38-flashnext-262k");
  extra.surprise = true;
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(extra, options())), ["surprise:unknown_field"]);
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe([], options())), [":invalid_type"]);
  assert.deepEqual(errorKeys(recipeSchema.validateRecipe(null, options())), [":invalid_type"]);
});

test("docker flags the platform manages cannot be smuggled in through a recipe", () => {
  const recipe = bundled("pennyroyal-v251");
  assert.equal(recipeSchema.validateRecipe(recipe, options()).ok, true);
  recipe.dockerFlags = [...recipe.dockerFlags, "--privileged"];
  const result = recipeSchema.validateRecipe(recipe, options());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.path.startsWith("dockerFlags")), errorKeys(result).join());
});

test("a recipe is judged by the same validator in both modes", () => {
  for (const { recipe } of readBundled()) {
    const asOverride = recipeSchema.validateRecipe(recipe, options({ mode: "override" }));
    assert.deepEqual(asOverride.errors, [], recipe.id);
  }
});
