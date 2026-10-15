// CON-10 (07 section 4.5, 13.1): buildFormModel over the schema and plan
// fixtures of vllm, sglang (the Flash-Next recipe locks) and llamacpp. The
// snapshots are the same with and without the schema's `facts`, because an
// unresolved fact keeps appliesWhen open. A second part runs over the real
// manager-core catalogs: every param has both labels, a known group, a widget
// and an appliesWhen that validateExpr accepts. Refresh the goldens with
// UPDATE_GOLDENS=1.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateExpr } from "../../console/lib/expr.js";
import {
  applySuggestion,
  buildFormModel,
  flattenFields,
  humanHint,
  LEVELS,
  pickText,
  secretState,
  validateValue,
  WIDGETS,
  widgetFor,
  withValue,
} from "../../console/lib/schema-form-model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "console");
const GOLDEN = path.join(HERE, "golden");
const require = createRequire(import.meta.url);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const schema = (engine) => readJson(path.join(FIXTURES, `schema-${engine}.json`));
const plan = (engine) => readJson(path.join(FIXTURES, `plan-${engine}.json`));
const clone = (value) => JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// The explicit user values of each scenario. A fake key stands for a secret.
const FAKE_KEY = "fake-test-key-0000";
const VALUES = {
  sglang: {
    contextLength: 262144,
    concurrency: 4,
    "sglang.memFractionStatic": 0.995,
    prefixCaching: false,
    "sglang.hicache.enable": true,
    "sglang.hicache.ratio": 2,
    trustRemoteCode: false,
    chatTemplateKwargs: { enable_thinking: false },
    "speculative.method": { value: "dspark", source: "planner" },
    apiKey: FAKE_KEY,
  },
  vllm: {
    contextLength: 131072,
    "speculative.method": "mtp",
    "lora.adapters": [{ name: "style", path: "C:/fixture/lora" }],
    hfOverrides: { rope_scaling: { type: "yarn" } },
    tensorParallel: 2,
    "vllm.gpuMemoryUtilization": 5,
    apiKey: null,
  },
  llamacpp: {
    "llamacpp.cacheTypeK": "q8_0",
    "llamacpp.overrideTensor": [{ pattern: "ffn_.*_exps", buffer: "CPU" }],
    "llamacpp.textOnly": false,
    "llamacpp.threads": 8,
    apiKey: FAKE_KEY,
  },
};

/** The golden projection of a model: everything that decides what renders, without the help prose. */
function project(model) {
  return {
    engineId: model.engineId,
    mode: model.mode,
    level: model.level,
    counts: model.counts,
    unplaced: model.unplaced,
    groups: model.groups.map((group) => ({
      id: group.id,
      label: group.label,
      hiddenCount: group.hiddenCount,
      fields: group.fields.map((field) => ({
        id: field.id,
        domId: field.domId,
        widget: field.widget,
        type: field.type,
        label: field.label,
        unit: field.unit,
        flag: field.flag,
        level: field.level,
        userValue: field.userValue,
        effective: field.effective,
        ghost: field.ghost,
        hint: field.hint,
        changed: field.changed,
        locked: field.locked,
        error: field.error,
        warnings: field.warnings,
        suggestion: field.suggestion,
        appliesState: field.appliesState,
        secretState: field.secretState,
        choices: field.choices ? field.choices.map((choice) => choice.value) : null,
      })),
    })),
  };
}

function snapshots(engine, { withFacts = true } = {}) {
  const catalog = schema(engine);
  if (!withFacts) delete catalog.facts;
  const out = {};
  for (const level of ["basic", "expert"]) {
    out[level] = project(buildFormModel({ catalog, plan: plan(engine), values: VALUES[engine], locale: "en-US", level }));
  }
  return out;
}

function checkGolden(name, actual) {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDENS === "1") {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepStrictEqual(actual, readJson(file), `${name} differs; rerun with UPDATE_GOLDENS=1 if the change is intended`);
}

for (const engine of ["vllm", "sglang", "llamacpp"]) {
  test(`${engine}: the form model matches its golden, with and without schema facts`, () => {
    const withFacts = snapshots(engine);
    checkGolden(`schema-form-${engine}.json`, withFacts);
    // An unresolved fact fails open, so the same fields show.
    assert.deepStrictEqual(snapshots(engine, { withFacts: false }), withFacts);
  });
}

// ---- behaviour ---------------------------------------------------------------------

function build(engine, extra = {}) {
  return buildFormModel({ catalog: schema(engine), plan: plan(engine), values: VALUES[engine], locale: "en-US", level: "expert", ...extra });
}

const byId = (model) => new Map(flattenFields(model).map((field) => [field.id, field]));

test("the model never mutates its inputs and never applies a suggestion", () => {
  const catalog = deepFreeze(schema("vllm"));
  const planInput = deepFreeze(plan("vllm"));
  const values = deepFreeze(clone(VALUES.vllm));
  const model = buildFormModel({ catalog, plan: planInput, values, locale: "en-US", level: "expert" });
  const fields = byId(model);
  const context = fields.get("contextLength");
  assert.deepEqual(context.suggestion, { value: 65536, why: "65536 fits in the current memory" });
  assert.equal(context.userValue, 131072, "the user's value is untouched");
  assert.equal(values.contextLength, 131072);
  const applied = applySuggestion(values, context);
  assert.equal(applied.contextLength, 65536);
  assert.equal(values.contextLength, 131072, "applySuggestion returns new values");
  assert.deepEqual(applySuggestion(values, { id: "x", suggestion: null }), values);
});

test("a recipe lock disables the field with its reason, and beats the user's value", () => {
  const fields = byId(build("sglang"));
  const lock = fields.get("trustRemoteCode");
  assert.deepEqual(lock.locked, { kind: "recipe", reason: "Qwen3.8 needs repository code", value: true });
  assert.equal(lock.userValue, false);
  assert.deepEqual(lock.effective, { value: true, source: "recipe", reason: "Qwen3.8 needs repository code" });
  for (const id of ["reasoningParser", "toolCallParser", "autoToolChoice"]) assert.equal(fields.get(id).locked.kind, "recipe", id);
  assert.equal(fields.get("contextLength").locked, null);
  const zh = byId(build("sglang", { locale: "zh-CN" })).get("trustRemoteCode");
  assert.match(zh.locked.reason, /\p{Script=Han}/u);
});

test("the planner provenance reaches the effective source, from the plan or from a wrapped value", () => {
  const vllm = byId(build("vllm"));
  assert.equal(vllm.get("speculative.numTokens").effective.source, "planner");
  const sglang = byId(build("sglang"));
  assert.equal(sglang.get("speculative.method").effective.source, "planner");
  assert.equal(sglang.get("speculative.method").effective.value, "dspark");
  assert.equal(sglang.get("speculative.method").userValue, "dspark");
  assert.equal(sglang.get("contextLength").effective.source, "user");
  assert.equal(sglang.get("quantization").effective.source, "recipe");
  assert.equal(vllm.get("quantization").effective.source, "model");
  assert.equal(vllm.get("reasoningParser").effective.source, "knowledge");
  assert.equal(vllm.get("dtype").effective.source, "engine-default");
});

test("not-applicable fields are counted and hidden, and appliesWhen follows the values", () => {
  const catalog = schema("vllm");
  const off = buildFormModel({ catalog, plan: null, values: {}, locale: "en-US", level: "expert" });
  const ids = (model) => flattenFields(model).map((field) => field.id);
  assert.ok(!ids(off).includes("speculative.numTokens"), "speculative.numTokens needs a method");
  assert.ok(!ids(off).includes("vllm.lora.maxLoras"));
  assert.equal(off.counts.notApplicable, catalog.notApplicable.length + 5);
  const on = buildFormModel({ catalog, plan: null, values: { "speculative.method": "mtp", "lora.adapters": [{ name: "a", path: "p" }] }, locale: "en-US", level: "expert" });
  assert.ok(ids(on).includes("speculative.numTokens"));
  assert.ok(ids(on).includes("vllm.lora.maxLoras"));
  assert.equal(on.counts.notApplicable, catalog.notApplicable.length + 1, "only the multi-GPU backend stays hidden");
  // A fact the host reports decides too; a missing fact keeps the field.
  const sglang = schema("sglang");
  const awq = clone(sglang);
  awq.facts["model.quantMethod"] = "awq";
  const hidden = buildFormModel({ catalog: awq, plan: null, values: {}, locale: "en-US", level: "expert" });
  assert.ok(!ids(hidden).includes("sglang.fp4GemmBackend"));
  const open = buildFormModel({ catalog: sglang, plan: null, values: {}, locale: "en-US", level: "expert" });
  assert.ok(ids(open).includes("sglang.fp4GemmBackend"));
  delete awq.facts;
  assert.ok(ids(buildFormModel({ catalog: awq, plan: null, values: {}, locale: "en-US", level: "expert" })).includes("sglang.fp4GemmBackend"), "unknown facts fail open");
});

test("tristate, kv, list and secret parameters pick their widgets", () => {
  const fields = byId(build("sglang"));
  assert.equal(fields.get("prefixCaching").widget, "tristate");
  assert.equal(fields.get("prefixCaching").userValue, false, "Off is a value; Default is null");
  assert.equal(fields.get("reasoning.defaultEnabled").widget, "tristate");
  assert.equal(fields.get("apiKey").widget, "secret");
  assert.equal(byId(build("vllm")).get("lora.adapters").widget, "rows");
  assert.equal(byId(build("llamacpp")).get("llamacpp.overrideTensor").widget, "rows");
  assert.equal(widgetFor({ type: "kv" }), "kv");
  assert.equal(widgetFor({ type: "list" }), "tokens");
  assert.equal(widgetFor({ type: "list", secret: true }), "secret");
  assert.equal(widgetFor({ type: "enum", choices: [1, 2, 3, 4, 5].map((value) => ({ value })) }), "segmented");
  assert.equal(widgetFor({ type: "enum", choices: [1, 2, 3, 4, 5, 6].map((value) => ({ value })) }), "select");
  assert.equal(widgetFor({ type: "enum", choices: null }), "text");
  assert.equal(widgetFor({ type: "bool" }), "switch");
  assert.equal(widgetFor({ type: "json" }), "json");
  assert.equal(widgetFor({ type: "path" }), "path");
  // A kv parameter renders its value as given.
  const catalog = { engineId: "demo", groups: [{ id: "g", label: { en: "G" } }], params: [{ id: "extraEnv", group: "g", level: "basic", type: "kv", label: { en: "Env" } }] };
  const model = buildFormModel({ catalog, values: { extraEnv: { A: "1" } }, locale: "en-US" });
  assert.deepEqual(model.groups[0].fields[0].userValue, { A: "1" });
  assert.equal(model.groups[0].fields[0].widget, "kv");
});

test("a secret is write-only: only its state leaves the model", () => {
  for (const [engine, state] of [["sglang", "pending"], ["vllm", "clear"], ["llamacpp", "pending"]]) {
    const model = build(engine);
    const field = byId(model).get("apiKey");
    assert.equal(field.secretState, state, engine);
    assert.equal(field.secret, true);
    assert.equal(field.userValue, null);
    assert.equal(field.effective.value, null);
    assert.equal(field.effective.redacted, true);
    assert.equal(field.ghost, null);
    assert.equal(field.changed, true);
    assert.equal(JSON.stringify(model).includes(FAKE_KEY), false, `${engine} model must not hold the secret`);
  }
  assert.equal(secretState({}, "apiKey"), "unchanged");
  assert.equal(secretState({ apiKey: "" }, "apiKey"), "unchanged");
  assert.equal(secretState({ apiKey: null }, "apiKey"), "clear");
  const unchanged = byId(buildFormModel({ catalog: schema("sglang"), values: {}, locale: "en-US", level: "expert" })).get("apiKey");
  assert.equal(unchanged.changed, false);
  assert.deepEqual(withValue({ apiKey: "x" }, "apiKey", null, { keepNull: true }), { apiKey: null });
  assert.deepEqual(withValue({ a: 1 }, "a", null), {});
  assert.deepEqual(withValue({ a: 1 }, "b", 2), { a: 1, b: 2 });
});

test("levels, search, groups and forced visibility", () => {
  const catalog = schema("sglang");
  const count = (level) => buildFormModel({ catalog, values: {}, locale: "en-US", level }).counts;
  assert.ok(count("basic").visible < count("advanced").visible && count("advanced").visible < count("expert").visible);
  assert.equal(count("expert").hidden, 0);
  assert.equal(count("basic").visible + count("basic").hidden, count("expert").visible);
  assert.equal(buildFormModel({ catalog, values: {}, level: "bogus" }).level, "basic");
  // A user value or an error keeps a deeper field visible at Basic.
  const basic = buildFormModel({ catalog, plan: plan("sglang"), values: { "sglang.pageSize": 128 }, locale: "en-US", level: "basic" });
  assert.ok(byId(basic).has("sglang.pageSize"));
  assert.equal(byId(basic).get("sglang.pageSize").changed, true);
  const withError = buildFormModel({ catalog, plan: { errors: [{ field: "sglang.pageSize", code: "bad", message: "No" }] }, values: {}, locale: "en-US", level: "basic" });
  assert.equal(byId(withError).get("sglang.pageSize").error.message, "No");
  // Search matches the label, summary, flag and id, ignores the level, and needs every term.
  const found = (query, locale = "en-US") => flattenFields(buildFormModel({ catalog, values: {}, locale, level: "basic", query })).map((field) => field.id);
  assert.ok(found("--context-length").includes("contextLength"));
  assert.ok(found("context length").includes("contextLength"));
  assert.ok(found("CONTEXT").includes("contextLength"));
  assert.ok(found("mamba").includes("sglang.maxMambaCacheSize"), "an expert field is found from Basic");
  assert.deepEqual(found("context zzzz"), []);
  assert.ok(found("上下文", "zh-CN").includes("contextLength"));
  // The groups option picks groups in order.
  const picked = buildFormModel({ catalog, values: {}, locale: "en-US", level: "expert", groups: ["memory", "capacity"] });
  assert.deepEqual(picked.groups.map((group) => group.id), ["memory", "capacity"]);
  assert.ok(picked.groups.every((group) => group.fields.every((field) => field.group === group.id)));
  // Catalog mode shows every level and every param, including conditional ones.
  const all = buildFormModel({ catalog, values: {}, locale: "en-US", mode: "catalog" });
  assert.equal(flattenFields(all).length, catalog.params.length);
  assert.equal(all.counts.hidden, 0);
});

test("errors, warnings and suggestions come from the plan, fieldErrors and client checks", () => {
  const vllm = byId(build("vllm"));
  assert.equal(vllm.get("tensorParallel").error.code, "gpu_count_mismatch");
  assert.equal(vllm.get("tensorParallel").error.message, "Tensor parallel 2 needs 2 GPUs but 1 is selected");
  assert.equal(vllm.get("tensorParallel").suggestion, null);
  assert.equal(byId(build("vllm", { locale: "zh-CN" })).get("tensorParallel").error.message, "张量并行 2 需要 2 张 GPU，当前只选了 1 张");
  // The client check catches an out-of-range value and offers the bound, without applying it.
  const range = vllm.get("vllm.gpuMemoryUtilization");
  assert.equal(range.error.code, "out_of_range");
  assert.equal(range.error.source, "client");
  assert.deepEqual(range.suggestion, { value: 1, why: null });
  assert.equal(vllm.get("contextLength").error.source, "plan", "the plan's error wins over a client check");
  assert.equal(build("vllm").counts.errors >= 3, true);
  assert.equal(byId(build("sglang")).get("sglang.memFractionStatic").warnings[0].code, "high_memory_fraction");
  // fieldErrors (a 400 from the server) merge in; an error for no known field is kept apart.
  const merged = buildFormModel({ catalog: schema("llamacpp"), plan: null, values: {}, locale: "en-US", level: "expert",
    fieldErrors: [{ field: "contextLength", code: "x", message: "Too long" }, { field: "nope", code: "y", message: "Elsewhere" }] });
  assert.equal(byId(merged).get("contextLength").error.message, "Too long");
  assert.deepEqual(merged.unplaced, [{ field: "nope", code: "y", message: "Elsewhere", source: "plan" }]);
});

test("validateValue, humanHint and pickText", () => {
  const int = { type: "int", range: { min: 1, max: 10 } };
  assert.equal(validateValue(int, 5), null);
  assert.deepEqual(validateValue(int, 11), { code: "out_of_range", bounds: { min: 1, max: 10 }, suggestion: { value: 10 } });
  assert.deepEqual(validateValue(int, 0).suggestion, { value: 1 });
  assert.equal(validateValue(int, 2.5).code, "not_integer");
  assert.equal(validateValue({ type: "float" }, 0.5), null);
  assert.equal(validateValue(int, "x").code, "not_number");
  assert.equal(validateValue({ type: "enum", choices: [{ value: "a" }, { value: "b" }] }, "c").code, "not_in_choices");
  assert.equal(validateValue({ type: "string", maxLength: 3 }, "abcd").code, "too_long");
  assert.equal(validateValue({ type: "string", pattern: "^[a-z]+$" }, "A1").code, "pattern_mismatch");
  assert.equal(validateValue({ type: "list", item: { maxItems: 1 } }, [1, 2]).code, "too_many_items");
  assert.equal(validateValue({ type: "list", item: { fields: { name: { required: true } } } }, [{}]).code, "item_invalid");
  assert.equal(validateValue(int, null), null);
  assert.equal(humanHint({ unit: "tokens" }, 262144, "en-US"), "262,144 = 256K");
  assert.equal(humanHint({ unit: "tokens" }, 1048576, "en-US"), "1,048,576 = 1M");
  assert.equal(humanHint({ unit: "tokens" }, 1000, "en-US"), null);
  assert.equal(humanHint({ unit: "MiB" }, 8192, "en-US"), "8,192 MiB = 8 GiB");
  assert.equal(humanHint({ unit: "tokens" }, "x", "en-US"), null);
  assert.equal(pickText({ zh: "甲", en: "A" }, "zh-CN"), "甲");
  assert.equal(pickText({ zh: "甲", en: "A" }, "en-US"), "A");
  assert.equal(pickText({ en: "A" }, "zh-CN"), "A", "falls back to the other language");
  assert.equal(pickText("甲 / A", "en-US"), "A");
  assert.equal(pickText("甲 / A", "zh-CN"), "甲");
  assert.equal(pickText("Read / write", "zh-CN"), "Read / write", "a slash in plain text is not a split");
  assert.equal(pickText(null, "en-US"), "");
});

test("each field carries the DOM hooks and the legacy id", () => {
  const fields = byId(build("sglang"));
  assert.equal(fields.get("contextLength").domId, "maxModelLen");
  assert.equal(fields.get("sglang.maxTotalTokens").domId, "sglangMaxTotalTokens");
  const ids = flattenFields(build("sglang")).map((field) => field.domId);
  assert.equal(new Set(ids).size, ids.length, "domIds are unique within a form");
  assert.ok(ids.every((id) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)), "domIds are valid ids");
});

// ---- the real catalogs -------------------------------------------------------------

test("every param in the real launch-params catalogs renders", () => {
  const core = require(path.join(ROOT, "manager-core"));
  const catalogs = core.engines.getParamCatalog();
  const files = fs.readdirSync(path.join(ROOT, "manager-core", "data", "launch-params")).filter((name) => name.endsWith(".json") && name !== "common.json");
  assert.ok(files.length >= 3);
  for (const file of files) {
    const engineId = file.replace(/\.json$/, "");
    const loaded = catalogs.loadCatalog(engineId, {});
    const payload = core.engines.paramCatalog.buildSchemaPayload({ catalog: loaded, facts: {} });
    const known = new Set(payload.groups.map((group) => group.id));
    // The tier-2 template engines ship a short catalog (shared concepts plus a few engine params).
    const minimum = ["lmdeploy", "trtllm", "tabbyapi"].includes(engineId) ? 5 : 40;
    assert.ok(payload.params.length > minimum, `${engineId} has params`);
    const seen = new Set();
    for (const level of LEVELS) {
      const model = buildFormModel({ catalog: payload, values: {}, locale: "en-US", level });
      for (const field of flattenFields(model)) seen.add(field.id);
    }
    const catalogModel = buildFormModel({ catalog: payload, values: {}, locale: "zh-CN", mode: "catalog" });
    const rendered = new Set(flattenFields(catalogModel).map((field) => field.id));
    for (const param of payload.params) {
      const where = `${engineId} ${param.id}`;
      assert.ok(param.label?.zh && param.label?.en, `${where} has both labels`);
      assert.ok(known.has(param.group), `${where} has a known group`);
      assert.ok(WIDGETS.includes(widgetFor(param)), `${where} has a widget`);
      if (param.appliesWhen) assert.equal(validateExpr(param.appliesWhen).ok, true, `${where} appliesWhen`);
      assert.ok(rendered.has(param.id), `${where} renders in catalog mode`);
      // A param that is conditional on others may stay hidden in launch mode; the rest show at some level.
      if (!param.appliesWhen) assert.ok(seen.has(param.id), `${where} shows at some level`);
      const field = flattenFields(catalogModel).find((item) => item.id === param.id);
      assert.ok(field.label && !field.label.startsWith("--"), `${where} label is never a raw flag`);
    }
  }
});
