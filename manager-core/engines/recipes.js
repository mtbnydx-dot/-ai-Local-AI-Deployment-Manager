"use strict";

// Recipes as data (docs/overhaul/01-engines.md §10). A recipe is one validated
// launch configuration for an engine (values, derived values, locks, blocks,
// fixed launch data, memory policy) or, as a scenario, one builtin launch
// profile. Bundled recipes live in manager-core/data/recipes/*.json; owner
// files and 02's save-as-recipe output live in <AI_ROOT>/config/recipes/*.json.
// Every file goes through recipe-schema.validateRecipe.
//
//   createRecipeStore({ bundledDir?, overrideDir?, registry?, paramCatalog? })
//   loadRecipes()     → { recipes[], errors[] }
//   reloadRecipes()   → { ok, count, errors[], digest }   atomic swap; a held snapshot never changes
//   matchRecipes({ engineId, model, hostFacts, runtime, user }) → [{ recipe, eligible, score, reasons[] }]
//   applyRecipe(recipe, userValues, ctx) → { values, provenance, overrides, blocks, validation, fixed, memory, notes, locks }
//   presetFromRecipe(recipeId, legacyOpts, launch, ctx) → legacy preset   (resolveVllmRuntimePreset shim)
//   builtinProfiles(managerId, { modelsRoot, normalize }) → legacy profile list (default-profiles.js shim)
//   watchRecipeOverrides({ dir, store, debounceMs, watch, timers, log }) → { close, trigger }
//
// Override files. A file whose id is a bundled recipe deep-merges over it
// (objects merge, arrays replace); a new id is a new recipe. A file that does
// not validate keeps the last version of that file that did (or, without one,
// leaves the bundled recipe alone) and reports its errors, which GET
// /api/engines lists. `extends` merges a parent the same way (the profile is
// not inherited), at most four levels deep.
//
// Legacy shim. vllm-manager's runtime presets and both managers' builtin
// profiles are rendered from recipe data until the launch-plan resolver
// (ENG-7) replaces them: legacy.preset maps preset fields to template values
// (recipe-schema.js), the SGLang base preset ("sglang-openai-runtime") stays
// code here, and legacy.check feeds checkModelCompatibility. Legacy option
// bodies become user values through the alias table (legacy-aliases.js).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const expr = require("./expr");
const legacyAliases = require("./legacy-aliases");
const paramCatalog = require("./param-catalog");
const recipeSchema = require("./recipe-schema");
const registryModule = require("./registry");
const runtimeManifest = require("../runtime-manifest");
const { positiveInt } = require("../common-utils");
const { userDataDir } = require("../reference-data");

const BUNDLED_RECIPES_DIR = path.join(__dirname, "..", "data", "recipes");
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXTENDS_DEPTH = 4;
const DEFAULT_DEBOUNCE_MS = 1000;
// matchRecipes scores (01 §10.3). Identity keys that do not match make the
// recipe ineligible; quant, compute capability and memory only score.
const SCORES = Object.freeze({ contentDigest: 80, familyId: 50, capabilityIds: 50, quant: 20, sm: 10, memory: 10, runtime: 5, verified: 5 });
// Slots the legacy run-option path takes from a recipe. The argument-style
// switches still come from the preset's own flags (positionalModel, ...), so a
// hand-made preset keeps its argv.
const LEGACY_DOCKER_SLOTS = Object.freeze(["restart", "hfCacheMount", "modelMountReadOnly", "cacheMount"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// The legacy SGLang base preset's fixed text (vllm-manager resolveVllmRuntimePreset).
const SGLANG_BASE = Object.freeze({
  id: "sglang-openai-runtime",
  label: "SGLang OpenAI runtime",
  note: "uses SGLang 0.5.17 with the OpenAI-compatible API on container port 8000",
  dsparkReason: "当前 DSpark 档只对已验证的 Qwen3.8 主模型开放。",
  speculativeModes: Object.freeze(["off", "dspark"]),
});

function isPlainObject(value) {
  return recipeSchema.isPlainObject(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Objects merge key by key; arrays, scalars and null replace. */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function present(value) {
  return value !== undefined && value !== null && value !== expr.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function fileError(source, file, code, message, extra = {}) {
  return { source: "recipes", origin: source, file: path.basename(file || ""), engineId: "", path: "", code, message, ...extra };
}

/** [{ name, file, raw } | { name, file, error }] for the *.json files of dir, sorted by name. */
function readRecipeDir(dir, source) {
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    return [{ name: "", file: dir, error: fileError(source, dir, "recipes_unreadable", `Cannot read ${source} recipes: ${error.message}`) }];
  }
  const entries = [];
  for (const name of names.filter((item) => item.toLowerCase().endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        entries.push({ name, file, error: fileError(source, file, "recipe_too_large", `${name} is larger than ${MAX_FILE_BYTES / 1024} KiB.`) });
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      if (!isPlainObject(raw) || typeof raw.id !== "string" || !recipeSchema.RECIPE_ID_PATTERN.test(raw.id)) {
        entries.push({ name, file, error: fileError(source, file, "invalid_id", `${name} has no valid recipe id.`) });
        continue;
      }
      entries.push({ name, file, raw });
    } catch (error) {
      const code = error instanceof SyntaxError ? "invalid_json" : "recipe_unreadable";
      entries.push({ name, file, error: fileError(source, file, code, `${name}: ${error.message}`) });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function emptySnapshot() {
  return deepFreeze({ recipes: new Map(), list: [], errors: [], warnings: [], digest: "", sources: {} });
}

function createRecipeStore(options = {}) {
  const bundledDir = options.bundledDir || BUNDLED_RECIPES_DIR;
  const overrideDir = Object.hasOwn(options, "overrideDir") ? options.overrideDir : path.join(userDataDir(), "recipes");
  const registryOf = () => options.registry || registryModule.getEngineRegistry();
  const catalogsOf = () => options.paramCatalog || paramCatalog.getParamCatalog();
  // Override file name → the last { id, raw } of it that validated.
  const lastGood = new Map();
  let snapshot = null;

  function validate(recipe, mode) {
    return recipeSchema.validateRecipe(recipe, {
      catalogs: catalogsOf(),
      registry: registryOf(),
      validateValues: paramCatalog.validateValues,
      mode,
    });
  }

  // rawById: id → { raw, source } (an override already merged over its
  // bundled recipe). → { recipes: Map id → recipe, problems: Map id → errors[], warnings[] }
  function resolveAll(rawById) {
    const recipes = new Map();
    const problems = new Map();
    const warnings = [];
    const state = new Map();
    const fail = (id, items) => {
      problems.set(id, [...(problems.get(id) || []), ...items]);
      state.set(id, "failed");
      return null;
    };
    function resolve(id, depth) {
      if (state.get(id) === "done") return recipes.get(id);
      if (state.get(id) === "failed") return null;
      const entry = rawById.get(id);
      if (!entry) return null;
      if (state.get(id) === "visiting") return fail(id, [{ path: "extends", code: "extends_cycle", message: `${id} extends itself through ${entry.raw.extends}.` }]);
      state.set(id, "visiting");
      let recipe = clone(entry.raw);
      if (entry.raw.extends !== undefined) {
        const parentId = entry.raw.extends;
        if (depth >= MAX_EXTENDS_DEPTH) return fail(id, [{ path: "extends", code: "extends_too_deep", message: `${id} extends more than ${MAX_EXTENDS_DEPTH} levels.` }]);
        if (typeof parentId !== "string" || !rawById.has(parentId)) {
          return fail(id, [{ path: "extends", code: "extends_unknown", message: `${id} extends ${parentId}, which is not a recipe.` }]);
        }
        const parent = resolve(parentId, depth + 1);
        if (state.get(id) === "failed") return null;
        if (!parent) return fail(id, [{ path: "extends", code: "extends_invalid", message: `${id} extends ${parentId}, which is not valid.` }]);
        const { profile: _profile, ...inherited } = clone(parent);
        recipe = deepMerge(inherited, entry.raw);
      }
      const result = validate(recipe, entry.source === "override" ? "override" : "bundled");
      if (!result.ok) return fail(id, result.errors);
      for (const item of result.warnings) warnings.push({ id, ...item });
      recipes.set(id, deepFreeze(recipe));
      state.set(id, "done");
      return recipes.get(id);
    }
    for (const id of rawById.keys()) resolve(id, 0);
    return { recipes, problems, warnings };
  }

  function build() {
    const errors = [];
    const bundledRaw = new Map();
    for (const entry of readRecipeDir(bundledDir, "bundled")) {
      if (entry.error) {
        errors.push(entry.error);
      } else if (bundledRaw.has(entry.raw.id)) {
        errors.push(fileError("bundled", entry.file, "duplicate_recipe", `${entry.raw.id} is defined twice.`));
      } else {
        bundledRaw.set(entry.raw.id, { raw: entry.raw, source: "bundled", file: entry.name });
      }
    }
    const overrideEntries = readRecipeDir(overrideDir, "override");
    const names = new Set(overrideEntries.map((entry) => entry.name));
    for (const name of [...lastGood.keys()]) if (!names.has(name)) lastGood.delete(name);
    // name → { id, raw, fresh }
    const overrides = new Map();
    for (const entry of overrideEntries) {
      if (entry.error) {
        errors.push(entry.error);
        if (lastGood.has(entry.name)) overrides.set(entry.name, { ...lastGood.get(entry.name), fresh: false });
      } else {
        overrides.set(entry.name, { id: entry.raw.id, raw: entry.raw, fresh: true });
      }
    }

    let resolved = null;
    for (let round = 0; round <= overrides.size + 1; round += 1) {
      const rawById = new Map(bundledRaw);
      const owner = new Map();
      for (const [name, item] of overrides) {
        if (owner.has(item.id)) {
          errors.push(fileError("override", name, "duplicate_recipe", `${item.id} is also defined by ${owner.get(item.id)}; ${name} is ignored.`));
          continue;
        }
        owner.set(item.id, name);
        const base = bundledRaw.get(item.id)?.raw;
        rawById.set(item.id, { raw: base ? deepMerge(base, item.raw) : item.raw, source: "override" });
      }
      resolved = resolveAll(rawById);
      const failing = [...overrides].filter(([, item]) => item.fresh && resolved.problems.has(item.id));
      if (!failing.length) break;
      for (const [name, item] of failing) {
        for (const problem of resolved.problems.get(item.id)) {
          errors.push(fileError("override", name, problem.code, problem.message, { path: problem.path || "", engineId: String(item.raw.engineId || "") }));
        }
        if (lastGood.has(name)) overrides.set(name, { ...lastGood.get(name), fresh: false });
        else overrides.delete(name);
      }
    }
    // Problems left are bundled recipes (or kept versions) that no longer validate.
    const overrideIds = new Set([...overrides.values()].map((item) => item.id));
    for (const [id, items] of resolved.problems) {
      const source = overrideIds.has(id) ? "override" : "bundled";
      const file = source === "bundled" ? bundledRaw.get(id)?.file : [...overrides].find(([, item]) => item.id === id)?.[0];
      for (const problem of items) {
        errors.push(fileError(source, file || `${id}.json`, problem.code, problem.message, { path: problem.path || "", engineId: String((bundledRaw.get(id)?.raw || {}).engineId || "") }));
      }
    }
    for (const [name, item] of overrides) {
      if (item.fresh && resolved.recipes.has(item.id)) lastGood.set(name, { id: item.id, raw: item.raw });
    }
    const list = [...resolved.recipes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sources = {};
    for (const recipe of list) sources[recipe.id] = overrideIds.has(recipe.id) ? "override" : "bundled";
    const digest = `sha256:${crypto.createHash("sha256").update(canonicalJson(list)).digest("hex")}`;
    return deepFreeze({ recipes: resolved.recipes, list, errors, warnings: resolved.warnings, digest, sources });
  }

  function current() {
    if (!snapshot) snapshot = build();
    return snapshot;
  }

  /** Re-reads both directories and swaps the snapshot in one assignment. */
  function reload() {
    snapshot = build();
    return { ok: snapshot.errors.length === 0, count: snapshot.list.length, errors: clone(snapshot.errors), digest: snapshot.digest };
  }

  return {
    bundledDir,
    overrideDir,
    snapshot: current,
    reload,
    load() {
      const snap = current();
      return { recipes: snap.list, errors: clone(snap.errors) };
    },
    list(filter = {}) {
      return current().list.filter((recipe) => (
        (!filter.kind || recipe.kind === filter.kind)
        && (!filter.engineId || recipe.engineId === filter.engineId)
        && (!filter.managerId || recipe.profile?.managerId === filter.managerId)
      ));
    },
    get(id) {
      return current().recipes.get(String(id || "")) || null;
    },
    errors() {
      return clone(current().errors);
    },
    warnings() {
      return clone(current().warnings);
    },
    digest() {
      return current().digest;
    },
    sourceOf(id) {
      return current().sources[id] || null;
    },
    registry: registryOf,
    catalogs: catalogsOf,
  };
}

let defaultStore = null;

/** The process-wide store (bundled data + <AI_ROOT>/config/recipes). */
function getRecipeStore() {
  if (!defaultStore) defaultStore = createRecipeStore();
  return defaultStore;
}

function clearRecipeStoreCache() {
  defaultStore = null;
}

function storeOf(ctx) {
  return ctx?.store || getRecipeStore();
}

function loadRecipes(store = getRecipeStore()) {
  return store.load();
}

function reloadRecipes(store = getRecipeStore()) {
  return store.reload();
}

// ---------------------------------------------------------------------------
// Expression context
// ---------------------------------------------------------------------------

// Env inputs arrive trimmed and lower-cased: every one a recipe reads today is
// a switch, a backend name or a number.
function envResolver(recipe, ctx = {}) {
  const allowed = new Set(Array.isArray(recipe?.inputs?.env) ? recipe.inputs.env : []);
  const source = ctx.env && typeof ctx.env === "object" ? ctx.env : process.env;
  return (name) => {
    if (!allowed.has(name)) return null;
    const raw = typeof source === "function" ? source(name) : source[name];
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim().toLowerCase();
    return text || null;
  };
}

function evalContext(state) {
  return {
    param: (id) => (Object.hasOwn(state.values, id) ? state.values[id] : null),
    user: (id) => (Object.hasOwn(state.user, id) ? state.user[id] : null),
    fact: (name) => (Object.hasOwn(state.facts, name) ? state.facts[name] : null),
    env: state.env,
  };
}

function run(ast, state) {
  const value = expr.evaluate(ast, evalContext(state));
  return value === expr.UNKNOWN ? null : value;
}

function isTrue(ast, state) {
  return expr.truthState(expr.evaluate(ast, evalContext(state))) === "true";
}

function unwrapUserValue(entry) {
  if (isPlainObject(entry) && Object.hasOwn(entry, "value") && (Object.keys(entry).length === 1 || Object.hasOwn(entry, "source"))) return entry.value;
  return entry;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function formatPlaceholder(value) {
  if (!present(value)) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function manifestField(key, field) {
  const release = runtimeManifest.getRuntimeRelease(key);
  return release && Object.hasOwn(release, field) ? release[field] : null;
}

function placeholderValue(name, state) {
  const split = name.indexOf(":");
  const namespace = split > 0 ? name.slice(0, split) : name;
  const rest = split > 0 ? name.slice(split + 1) : "";
  switch (namespace) {
    case "param": return state.values[rest];
    case "user": return state.user[rest];
    case "fact": return state.facts[rest];
    case "env": return state.env(rest);
    case "var": return state.vars[rest];
    case "fixedEnv": return state.fixedEnv?.[rest];
    case "manifest": {
      const [key, field] = rest.split(".");
      return manifestField(key, field);
    }
    default: return state.placeholders?.[name];
  }
}

function renderText(text, state) {
  let empty = false;
  const out = String(text).replace(/\{\{([^{}]{1,96})\}\}/g, (_match, name) => {
    const value = formatPlaceholder(placeholderValue(name, state));
    if (!value) empty = true;
    return value;
  });
  return { text: out, empty };
}

/**
 * One template value (recipe-schema.js "Value forms") → its value, or
 * undefined when it renders to nothing. Literals are copied as they are; a
 * template form that yields null or nothing gives undefined, so the field is
 * left out.
 */
function renderTemplate(value, state) {
  const form = recipeSchema.templateForm(value);
  if (!form) return clone(value);
  if (form === "expr") {
    const result = run(value.expr, state);
    if (!present(result)) return undefined;
    return value.format === "json" ? JSON.stringify(result) : clone(result);
  }
  if (form === "text") {
    if (value.when !== undefined && !isTrue(value.when, state)) return undefined;
    const { text, empty } = renderText(value.text, state);
    return value.skipEmpty && empty ? undefined : text;
  }
  if (form === "recipe") {
    const result = Object.hasOwn(state.values, value.recipe) && present(state.values[value.recipe])
      ? state.values[value.recipe]
      : value.else;
    if (!present(result)) return undefined;
    return value.format === "json" ? JSON.stringify(result) : clone(result);
  }
  if (form === "fixed") return clone(state.fixedEnv || {});
  if (form === "var") return present(state.vars[value.var]) ? clone(state.vars[value.var]) : undefined;
  return undefined;
}

function renderI18n(item, state) {
  return {
    zh: renderText(item.zh, state).text,
    en: renderText(item.en, state).text,
  };
}

function renderNotes(notes, state) {
  const out = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    if (note.when !== undefined && !isTrue(note.when, state)) continue;
    out.push(renderI18n(note, state));
  }
  return out;
}

function renderEnv(recipe, state) {
  const env = {};
  for (const [name, value] of Object.entries(recipe.env || {})) {
    const rendered = renderTemplate(value, state);
    if (rendered !== undefined && rendered !== null) env[name] = String(rendered);
  }
  return env;
}

function renderFixed(recipe, state) {
  const args = [];
  for (const arg of recipe.fixedArgs || []) {
    const rendered = renderTemplate(arg, state);
    if (rendered !== undefined && rendered !== null && rendered !== "") args.push(String(rendered));
  }
  const labels = [];
  for (const label of recipe.labels || []) {
    const rendered = renderTemplate(label.value, state);
    if (rendered !== undefined && rendered !== null) labels.push({ key: label.key, value: String(rendered) });
  }
  return {
    args,
    env: clone(state.fixedEnv || {}),
    labels,
    dockerFlags: [...(recipe.dockerFlags || [])],
    slots: clone(recipe.slots || {}),
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function computeCapNumber(value) {
  const number = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? number : null;
}

function modelCapabilityIds(model) {
  const ids = new Set();
  for (const id of Array.isArray(model?.capabilityIds) ? model.capabilityIds : []) if (id) ids.add(String(id));
  if (model?.capabilityId) ids.add(String(model.capabilityId));
  return ids;
}

/** Identity verdict of one recipe for a model: { ok, score, reasons }. */
function identityMatch(recipe, model) {
  const match = recipe.match || {};
  const reasons = [];
  let ok = true;
  let score = 0;
  if (match.contentDigest !== undefined) {
    if (model?.contentDigest && String(model.contentDigest).replace(/^sha256:/, "") === match.contentDigest) {
      score += SCORES.contentDigest;
      reasons.push("content_digest");
    } else {
      ok = false;
      reasons.push("content_digest_mismatch");
    }
  }
  if (match.familyId !== undefined) {
    if (model?.familyId && model.familyId === match.familyId) {
      score += SCORES.familyId;
      reasons.push("family");
    } else {
      ok = false;
      reasons.push("family_mismatch");
    }
  }
  if (match.capabilityIds !== undefined) {
    const ids = modelCapabilityIds(model);
    if (match.capabilityIds.some((id) => ids.has(id))) {
      score += SCORES.capabilityIds;
      reasons.push("capability");
    } else {
      ok = false;
      reasons.push("capability_mismatch");
    }
  }
  return { ok, score, reasons };
}

function factsFor(input = {}) {
  const host = input.hostFacts || null;
  const facts = paramCatalog.buildFacts({
    host,
    model: input.model || null,
    runtime: input.runtime || null,
    instanceMode: input.instanceMode || null,
  });
  if (input.facts) Object.assign(facts, input.facts);
  return facts;
}

/**
 * matchRecipes({ engineId, model, hostFacts, runtime, user }) → model recipes
 * of the engine, eligible first, then by priority, score and id. model: {
 * contentDigest?, familyId?, capabilityId?, capabilityIds?, quantMethod? };
 * hostFacts: { platform, anySm12x, maxComputeCap, maxGpuMemoryGb? };
 * runtime: a RuntimeRef ({ runtimeId, manifestKey }). Scenario recipes never match.
 */
function matchRecipes(input = {}, store = getRecipeStore()) {
  const engineId = String(input.engineId || "");
  const model = input.model || {};
  const host = input.hostFacts || {};
  const runtime = input.runtime || null;
  const facts = factsFor(input);
  const user = isPlainObject(input.user) ? input.user : {};
  const results = [];
  for (const recipe of store.list({ kind: "model", engineId })) {
    const identity = identityMatch(recipe, model);
    const reasons = [...identity.reasons];
    let eligible = identity.ok;
    let score = identity.score;
    const match = recipe.match || {};
    if (match.runtimeId !== undefined) {
      if (runtime?.runtimeId === match.runtimeId) reasons.push("runtime_pinned");
      else {
        eligible = false;
        reasons.push("runtime_mismatch");
      }
    }
    if (Array.isArray(match.quant)) {
      const quant = String(model.quantMethod || "").toLowerCase();
      if (quant && match.quant.includes(quant)) {
        score += SCORES.quant;
        reasons.push("quant");
      } else reasons.push(quant ? "quant_mismatch" : "quant_unknown");
    }
    if (match.minComputeCapability !== undefined) {
      const have = computeCapNumber(host.maxComputeCap);
      const need = computeCapNumber(match.minComputeCapability);
      if (have === null) reasons.push("compute_capability_unknown");
      else if (have >= need) {
        score += SCORES.sm;
        reasons.push("compute_capability");
      } else reasons.push("compute_capability_low");
    }
    if (match.minGpuMemoryGb !== undefined) {
      const have = Number(host.maxGpuMemoryGb);
      if (!Number.isFinite(have) || have <= 0) reasons.push("gpu_memory_unknown");
      else if (have >= match.minGpuMemoryGb) {
        score += SCORES.memory;
        reasons.push("gpu_memory");
      } else reasons.push("gpu_memory_low");
    }
    if (recipe.runtime && runtime?.manifestKey === recipe.runtime.ref) {
      score += SCORES.runtime;
      reasons.push("runtime");
    }
    if (recipe.status === "verified") score += SCORES.verified;
    if (recipe.appliesWhen !== undefined) {
      const state = { values: {}, user, facts, env: envResolver(recipe, input) };
      const verdict = expr.truthState(expr.evaluate(recipe.appliesWhen, evalContext(state)));
      if (verdict === "false") {
        eligible = false;
        reasons.push("applies_when_false");
      } else if (verdict === "unknown") reasons.push("applies_when_unknown");
    }
    results.push({ recipe, eligible, score, reasons });
  }
  return results.sort((a, b) => (
    Number(b.eligible) - Number(a.eligible)
    || (b.recipe.priority || 0) - (a.recipe.priority || 0)
    || b.score - a.score
    || a.recipe.id.localeCompare(b.recipe.id)
  ));
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function newState(recipe, userValues, ctx = {}) {
  const user = {};
  for (const [id, entry] of Object.entries(isPlainObject(userValues) ? userValues : {})) {
    const value = unwrapUserValue(entry);
    if (value !== undefined && value !== null) user[id] = clone(value);
  }
  return {
    recipe,
    user,
    values: {},
    recipeValues: {},
    provenance: {},
    facts: ctx.facts || factsFor(ctx),
    env: envResolver(recipe, ctx),
    vars: {},
    fixedEnv: {},
    placeholders: { ...(ctx.placeholders || {}) },
  };
}

function evaluateValues(recipe, state) {
  const overrides = [];
  const locks = new Map((recipe.locks || []).map((lock) => [lock.param, lock]));
  for (const [id, entry] of Object.entries(recipe.values || {})) {
    const value = isPlainObject(entry) && Object.hasOwn(entry, "expr") ? run(entry.expr, state) : clone(entry);
    if (!present(value)) continue;
    state.values[id] = value;
    state.recipeValues[id] = value;
    state.provenance[id] = "recipe";
  }
  for (const [id, value] of Object.entries(state.user)) {
    const lock = locks.get(id);
    if (lock) {
      if (!expr.deepEqual(value, lock.value)) {
        overrides.push({ param: id, code: "recipe_locked", user: clone(value), value: clone(lock.value), reason: clone(lock.reason) });
      }
      continue;
    }
    state.values[id] = clone(value);
    state.provenance[id] = "user";
  }
  for (const [id, ast] of Object.entries(recipe.derived || {})) {
    const value = run(ast, state);
    if (!present(value)) continue;
    state.values[id] = value;
    state.recipeValues[id] = value;
    state.provenance[id] = "derived";
  }
  for (const lock of recipe.locks || []) {
    state.values[lock.param] = clone(lock.value);
    state.recipeValues[lock.param] = clone(lock.value);
    state.provenance[lock.param] = "lock";
  }
  for (const [name, ast] of Object.entries(recipe.legacy?.vars || {})) state.vars[name] = run(ast, state);
  state.fixedEnv = renderEnv(recipe, state);
  return overrides;
}

function evaluateBlocks(recipe, state) {
  const blocks = [];
  for (const rule of recipe.blockIf || []) {
    if (!isTrue(rule.when, state)) continue;
    blocks.push({
      code: rule.code,
      message: renderI18n(rule.message, state),
      ...(rule.check ? { check: clone(rule.check) } : {}),
    });
  }
  return blocks;
}

/**
 * The validation rules that need no I/O: kvCacheDtypeIn (the effective KV
 * dtype, when set, must be one of values) and rule (violated when `when` is
 * true). tokenizerSha256 and draftArchitecture read files and run in the
 * callers that have them (legacyCompatibility, presetFromRecipe).
 */
function evaluateValidation(recipe, state, codes = null) {
  const findings = [];
  for (const rule of recipe.validation || []) {
    if (codes && !codes.includes(rule.code)) continue;
    let violated = false;
    if (rule.kind === "kvCacheDtypeIn") {
      const value = state.values.kvCacheDtype;
      violated = present(value) && value !== "" && !rule.values.includes(String(value).toLowerCase());
    } else if (rule.kind === "rule") {
      violated = isTrue(rule.when, state);
    }
    if (!violated) continue;
    findings.push({
      code: rule.code,
      severity: rule.severity,
      title: clone(rule.title),
      message: renderI18n(rule.message, state),
    });
  }
  return findings;
}

function evaluateMemory(recipe, state) {
  const memory = recipe.memory;
  if (!memory) return null;
  const measured = isPlainObject(memory.measuredMiB) ? run(memory.measuredMiB.expr, state) : memory.measuredMiB;
  return {
    policy: present(measured) && memory.policy !== "measured" ? "measured" : memory.policy,
    calibrate: memory.calibrate !== false,
    measuredMiB: present(measured) ? measured : null,
    ...(memory.estimatePolicy ? { estimatePolicy: memory.estimatePolicy } : {}),
  };
}

function runApply(recipe, userValues, ctx) {
  const state = newState(recipe, userValues, ctx);
  const overrides = evaluateValues(recipe, state);
  const blocks = evaluateBlocks(recipe, state);
  return { state, overrides, blocks };
}

/**
 * applyRecipe(recipe, userValues, ctx) → the recipe resolved for one launch:
 * values (recipe values, then the user's, then derived values, then locks),
 * provenance per param, overrides (user values a lock replaced), blocks,
 * validation findings, fixed launch data, the memory policy and notes.
 * ctx: { facts? | hostFacts/model/runtime, env?, placeholders? }.
 */
function applyRecipe(recipe, userValues = {}, ctx = {}) {
  const { state, overrides, blocks } = runApply(recipe, userValues, ctx);
  return {
    recipeId: recipe.id,
    status: recipe.status,
    values: clone(state.values),
    provenance: { ...state.provenance },
    overrides,
    blocks,
    validation: evaluateValidation(recipe, state),
    fixed: renderFixed(recipe, state),
    memory: evaluateMemory(recipe, state),
    notes: renderNotes(recipe.notes, state),
    locks: clone(recipe.locks || []),
  };
}

// ---------------------------------------------------------------------------
// Legacy shim: user values, facts and the selection of today's presets
// ---------------------------------------------------------------------------

/**
 * Legacy option body → user values: every engine of the recipe engine's
 * manager decodes it (the old forms send every field for every engine), the
 * recipe engine last, plus the legacy request fields as they are. The
 * speculative mode is read the way normalizeSpeculativeMode reads it.
 */
function legacyUserValues(opts, engineId, store = getRecipeStore()) {
  const source = isPlainObject(opts) ? opts : {};
  const registry = store.registry();
  const catalogs = store.catalogs();
  let siblings = [engineId];
  try {
    const managerId = registry.get(engineId)?.hostManager;
    if (managerId) siblings = [...registry.hostedBy(managerId).filter((id) => id !== engineId), engineId];
  } catch {
    siblings = [engineId];
  }
  const user = {};
  for (const id of siblings) {
    let catalog;
    try {
      catalog = catalogs.loadCatalog(id);
    } catch {
      continue;
    }
    Object.assign(user, legacyAliases.legacyConfigToValues(source, id, { catalog }));
  }
  for (const field of recipeSchema.LEGACY_REQUEST_FIELDS) {
    const raw = source[field];
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) continue;
    user[field] = typeof raw === "string" ? raw.trim() : clone(raw);
  }
  if (typeof user["speculative.method"] === "string") {
    user["speculative.method"] = user["speculative.method"].trim().toLowerCase().replaceAll("-", "_") || null;
  }
  for (const [id, value] of Object.entries(user)) if (value === null) delete user[id];
  return user;
}

// The runtime a legacy body asks for: its runtimeImage through the registry
// ("" when none is given, <engine>@custom for an image the manifest does not know).
function legacyRuntime(opts, engineId, store) {
  const image = String(opts?.runtimeImage || "").trim();
  if (!image) return { runtimeId: "", manifestKey: null, image: "" };
  try {
    const ref = store.registry().resolveRuntime(engineId, { image });
    return { runtimeId: ref.runtimeId, manifestKey: ref.manifestKey || null, image, features: ref.features || {}, compatVersion: ref.compatVersion || null };
  } catch {
    return { runtimeId: `${engineId}@custom`, manifestKey: null, image };
  }
}

function legacyFacts(ctx, engineId, opts, store) {
  const host = ctx.hostFacts || paramCatalog.hostFactsFromGpus(Array.isArray(ctx.hostGpus) ? ctx.hostGpus : [], ctx.platform || process.platform);
  const runtime = legacyRuntime(opts, engineId, store);
  const facts = paramCatalog.buildFacts({ host, model: ctx.model || null, runtime });
  facts["runtime.id"] = runtime.runtimeId;
  return { facts, runtime };
}

/**
 * The recipe today's preset code would have used: a runtime image that pins a
 * recipe (the Pennyroyal image) selects it even for another model, which is
 * then a mismatch; otherwise the top eligible model recipe of the engine.
 * → { recipe, mismatch } or null.
 */
function selectLegacyRecipe(engineId, opts, ctx = {}) {
  const store = storeOf(ctx);
  const { facts, runtime } = legacyFacts(ctx, engineId, opts, store);
  const pinned = runtime.manifestKey ? legacyAliases.RUNTIME_RECIPES[runtime.manifestKey] : null;
  if (pinned) {
    const recipe = store.get(pinned);
    if (recipe && recipe.engineId === engineId) return { recipe, mismatch: !identityMatch(recipe, ctx.model || {}).ok };
  }
  const user = legacyUserValues(opts, engineId, store);
  const ranked = matchRecipes({ engineId, model: ctx.model || {}, hostFacts: ctx.hostFacts, runtime, user, facts, env: ctx.env }, store);
  const top = ranked.find((item) => item.eligible);
  return top ? { recipe: top.recipe, mismatch: false } : null;
}

/** withCapabilities of resolveVllmRuntimePreset: capability defaults under the preset's own fields. */
function mergeCapabilityPreset(preset = {}, capabilities = {}) {
  const caps = capabilities || {};
  const hasCapabilityPreset = Boolean(
    caps.speculativeConfig
    || caps.reasoningParser
    || caps.toolCallParser
    || caps.reasoningParserPlugin
    || caps.unsupportedReason
    || Object.keys(caps.env || {}).length,
  );
  return {
    ...preset,
    id: preset.id || (hasCapabilityPreset ? `model-${caps.modelType || "capabilities"}` : ""),
    label: preset.label || (hasCapabilityPreset ? `${caps.architecture || caps.modelType || "Model"} capability profile` : ""),
    env: { ...(caps.env || {}), ...(preset.env || {}) },
    forceTrustRemoteCode: Boolean(preset.forceTrustRemoteCode || caps.forceTrustRemoteCode),
    reasoningParser: preset.reasoningParser || caps.reasoningParser,
    reasoningParserPlugin: preset.reasoningParserPlugin || caps.reasoningParserPlugin,
    toolCallParser: preset.toolCallParser || caps.toolCallParser,
    enableAutoToolChoice: Boolean(preset.enableAutoToolChoice || caps.enableAutoToolChoice),
    speculativeConfig: preset.speculativeConfig || caps.speculativeConfig,
    unsupportedReason: preset.unsupportedReason || caps.unsupportedReason,
    notes: [...(preset.notes || []), ...(caps.notes || [])],
    capabilities,
  };
}

function textOf(value) {
  return present(value) ? String(value) : "";
}

// The SGLang base preset ("sglang-openai-runtime") over the resolved values:
// the user's values where the old preset read the form, the recipe's own
// values where it read the model branch, capability parsers otherwise.
function sglangBasePreset(state, ctx, mode, handlesDspark) {
  const value = (id) => (present(state.values[id]) ? state.values[id] : null);
  const fromRecipe = (id) => (present(state.recipeValues[id]) ? state.recipeValues[id] : null);
  const caps = ctx.capabilities || {};
  const maxRunning = positiveInt(value("sglang.maxRunningRequests") ?? value("concurrency"), 1);
  const thinkingOff = value("reasoning.defaultEnabled") === false;
  let unsupportedReason = "";
  if (!SGLANG_BASE.speculativeModes.includes(mode)) unsupportedReason = `SGLang 档当前只开放 off 或 dspark，不会静默转换 ${mode}。`;
  else if (mode === "dspark" && !handlesDspark) unsupportedReason = SGLANG_BASE.dsparkReason;
  return {
    id: SGLANG_BASE.id,
    label: SGLANG_BASE.label,
    engine: "sglang",
    image: ctx.image,
    quantization: textOf(fromRecipe("quantization")),
    forceTrustRemoteCode: fromRecipe("trustRemoteCode") === true,
    attentionBackend: textOf(value("sglang.attentionBackend")),
    reasoningParser: fromRecipe("reasoningParser") || caps.reasoningParser,
    toolCallParser: fromRecipe("toolCallParser") || caps.toolCallParser,
    enableAutoToolChoice: Boolean(fromRecipe("autoToolChoice") || caps.enableAutoToolChoice),
    maxRunningRequests: maxRunning,
    effectiveMaxRunningRequests: maxRunning,
    maxTotalTokens: positiveInt(value("sglang.maxTotalTokens"), 0),
    pageSize: positiveInt(value("sglang.pageSize"), 0),
    chunkedPrefillSize: positiveInt(value("sglang.chunkedPrefillSize"), 8192),
    fp4GemmBackend: textOf(value("sglang.fp4GemmBackend")),
    pleOffloadEmbedding: value("sglang.pleOffloadEmbedding") === true,
    linearAttnPrefillBackend: textOf(value("sglang.linearAttnPrefillBackend")),
    linearAttnDecodeBackend: textOf(value("sglang.linearAttnDecodeBackend")),
    mambaSsmDtype: textOf(value("sglang.mambaSsmDtype")),
    mambaRadixCacheStrategy: textOf(value("sglang.mambaRadixCacheStrategy")),
    mambaTrackInterval: positiveInt(value("sglang.mambaTrackInterval"), 0),
    maxMambaCacheSize: positiveInt(value("sglang.maxMambaCacheSize"), 0),
    disableThinkingByDefault: thinkingOff,
    defaultChatTemplateKwargs: thinkingOff ? JSON.stringify({ enable_thinking: false }) : "",
    mambaSchedulerStrategy: textOf(value("sglang.mambaSchedulerStrategy")),
    disablePrefillCudaGraph: value("sglang.disablePrefillCudaGraph") === true,
    mmFeatureTransport: textOf(value("sglang.mmFeatureTransport")),
    speculativeConfig: null,
    speculativeAlgorithm: mode === "dspark" ? "DSPARK" : "",
    draftModel: "",
    dsparkBlockSize: Math.min(32, Math.max(1, positiveInt(value("sglang.dsparkBlockSize"), 7))),
    draftModelQuantization: "unquant",
    unsupportedReason,
    notes: [SGLANG_BASE.note],
  };
}

function recipeRuntimeImage(recipe, ctx, store) {
  if (!recipe?.runtime) return "";
  const key = recipe.runtime.ref;
  if (typeof ctx.imageFor === "function") {
    const image = ctx.imageFor(key);
    if (image) return image;
  }
  try {
    return store.registry().resolveRuntime(recipe.engineId, { manifestKey: key }).image;
  } catch {
    return runtimeManifest.runtimeImageReference(key) || "";
  }
}

function defaultEngineImage(engineId, ctx, store) {
  if (typeof ctx.defaultImage === "function") return ctx.defaultImage(engineId) || "";
  if (typeof ctx.defaultImage === "string") return ctx.defaultImage;
  try {
    return store.registry().defaultRuntime(engineId)?.image || "";
  } catch {
    return "";
  }
}

/**
 * The image a legacy preset runs: a recipe runtime (the requested image when
 * the recipe allows an override), else the requested image, else the
 * engine's default image.
 */
function legacyImage(recipe, opts, ctx, store, engineId) {
  const requested = String(opts?.runtimeImage || "").trim();
  if (recipe?.runtime) {
    if (recipe.runtime.allowOverride && requested) return requested;
    return recipeRuntimeImage(recipe, ctx, store);
  }
  return requested || defaultEngineImage(engineId, ctx, store);
}

function draftRule(recipe) {
  return (recipe?.validation || []).find((rule) => rule.kind === "draftArchitecture") || null;
}

/**
 * presetFromRecipe(recipeId | null, legacyOpts, launch, ctx) → the legacy
 * runtime preset object. ctx: { engineId, capabilities, speculativeMode,
 * model: { capabilityIds }, hostGpus | hostFacts, platform, mismatch,
 * imageFor(manifestKey), defaultImage(engineId), resolveDraftModel(value, rule), env, store }.
 */
function presetFromRecipe(recipeId, legacyOpts = {}, launch = {}, ctx = {}) {
  const store = storeOf(ctx);
  const opts = isPlainObject(legacyOpts) ? legacyOpts : {};
  const recipe = recipeId ? (typeof recipeId === "object" ? recipeId : store.get(recipeId)) : null;
  if (recipeId && !recipe) throw new Error(`Unknown recipe ${recipeId}.`);
  const engineId = recipe?.engineId || ctx.engineId || "vllm";
  const { facts } = legacyFacts(ctx, engineId, opts, store);
  const user = legacyUserValues(opts, engineId, store);
  const image = legacyImage(recipe, opts, ctx, store, engineId);
  const placeholders = { "runtime.image": image, "recipe.runtimeImage": recipe ? recipeRuntimeImage(recipe, ctx, store) : "" };
  const state = newState(recipe || {}, user, { facts, env: ctx.env, placeholders });
  const blocks = recipe ? (evaluateValues(recipe, state), evaluateBlocks(recipe, state)) : [];
  if (!recipe) {
    for (const [id, value] of Object.entries(state.user)) state.values[id] = value;
  }
  const mode = String(ctx.speculativeMode || state.user["speculative.method"] || "off");
  const rule = draftRule(recipe);
  let draft = { path: "", ok: true, reason: "" };
  if (rule && typeof ctx.resolveDraftModel === "function") {
    draft = ctx.resolveDraftModel(textOf(state.user["speculative.draftModel"]), { architecture: rule.architecture, defaultDir: rule.defaultDir }) || draft;
  }
  state.placeholders["draft.path"] = draft.path || "";

  const useBase = engineId === "sglang" && recipe?.legacy?.base !== false;
  let preset = useBase ? sglangBasePreset(state, { ...ctx, image }, mode, Boolean(rule)) : {};
  let reason = useBase ? preset.unsupportedReason : "";
  if (!recipe) {
    if (!useBase) preset = { id: "", env: {} };
    return ctx.capabilities === null ? preset : mergeCapabilityPreset(preset, ctx.capabilities || {});
  }
  const legacy = recipe.legacy || {};
  preset.id = legacy.presetId || recipe.id;
  preset.label = legacy.presetLabel || recipe.label?.en || recipe.id;
  preset.image = image;
  const blockReason = blocks.map((block) => block.message.zh).join(" ");
  state.placeholders.blockReason = blockReason;
  for (const [field, template] of Object.entries(legacy.preset || {})) {
    const rendered = renderTemplate(template, state);
    if (rendered === undefined) delete preset[field];
    else preset[field] = rendered;
  }
  if (ctx.mismatch && legacy.mismatch) reason = legacy.mismatch.reason.zh;
  else if (blockReason) reason = blockReason;
  else if (!reason && !draft.ok) reason = draft.reason || "";
  preset.unsupportedReason = reason;
  preset.notes = (legacy.notesEn || []).map((note) => renderTemplate(note, state)).filter((note) => note !== undefined);
  return legacy.mergeCapabilities === false ? preset : mergeCapabilityPreset(preset, ctx.capabilities || {});
}

/** selectLegacyRecipe + presetFromRecipe: today's resolveVllmRuntimePreset over recipe data. */
function legacyRuntimePreset(engineId, legacyOpts = {}, launch = {}, ctx = {}) {
  const selected = selectLegacyRecipe(engineId, legacyOpts, ctx);
  return presetFromRecipe(selected?.recipe || null, legacyOpts, launch, { ...ctx, engineId, mismatch: Boolean(selected?.mismatch) });
}

/** The recipe a legacy preset object was rendered from (legacy.presetId), or null. */
function recipeForLegacyPreset(preset, store = getRecipeStore()) {
  const id = String(preset?.id || "");
  if (!id) return null;
  const candidates = store.list({ kind: "model" }).filter((recipe) => recipe.legacy?.presetId === id);
  if (!candidates.length) return null;
  const engine = String(preset.engine || "");
  return candidates.sort((a, b) => (
    Number(b.engineId === engine) - Number(a.engineId === engine) || (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id)
  ))[0];
}

/**
 * The recipe's fixed launch data for a legacy launch, in the shape the
 * adapters' recipe slots take: args, "key=value" labels, docker flags and the
 * docker slots (restart, mounts). Env stays on the preset.
 */
function renderLaunchFixed(recipe, { opts = {}, ctx = {} } = {}) {
  const store = storeOf(ctx);
  const user = legacyUserValues(opts, recipe.engineId, store);
  const { facts } = legacyFacts(ctx, recipe.engineId, opts, store);
  const { state } = runApply(recipe, user, { facts, env: ctx.env });
  const fixed = renderFixed(recipe, state);
  const slots = {};
  for (const key of LEGACY_DOCKER_SLOTS) if (Object.hasOwn(fixed.slots, key)) slots[key] = fixed.slots[key];
  return {
    args: fixed.args,
    labels: fixed.labels.map((label) => `${label.key}=${label.value}`),
    dockerFlags: fixed.dockerFlags,
    slots,
  };
}

/** The legacy option errors of a recipe: its blockIf messages (zh), in order. */
function legacyOptionErrors(recipeId, opts = {}, ctx = {}) {
  const store = storeOf(ctx);
  const recipe = typeof recipeId === "object" ? recipeId : store.get(recipeId);
  if (!recipe) return [];
  const user = legacyUserValues(opts, recipe.engineId, store);
  const { facts } = legacyFacts(ctx, recipe.engineId, opts, store);
  return runApply(recipe, user, { facts, env: ctx.env }).blocks.map((block) => block.message.zh);
}

async function tokenizerFinding(rule, localPath) {
  try {
    const tokenizer = await fs.promises.readFile(path.join(localPath, "tokenizer.json"));
    if (crypto.createHash("sha256").update(tokenizer).digest("hex") === rule.sha256) return null;
    return { severity: rule.severity, title: rule.title.zh, detail: rule.message.zh };
  } catch (error) {
    return { severity: rule.severity, title: (rule.unverifiedTitle || rule.title).zh, detail: error.message };
  }
}

/**
 * The findings and recommendations checkModelCompatibility shows for a recipe
 * (legacy.check), in its order: static findings, the model mismatch, the
 * blocks, and the validation rules (tokenizer hashes need ctx.localPath).
 * → { findings: [{ severity, title, detail }], recommendations: { legacyField: value } }.
 */
async function legacyCompatibility(recipeId, input = {}, ctx = {}) {
  const store = storeOf(ctx);
  const recipe = typeof recipeId === "object" ? recipeId : store.get(recipeId);
  if (!recipe) throw new Error(`Unknown recipe ${recipeId}.`);
  const user = legacyUserValues(input, recipe.engineId, store);
  const { facts } = legacyFacts(ctx, recipe.engineId, input, store);
  const placeholders = { "recipe.runtimeImage": recipeRuntimeImage(recipe, ctx, store) };
  const { state, blocks } = runApply(recipe, user, { facts, env: ctx.env, placeholders });
  const check = recipe.legacy?.check || {};
  const findings = [];
  for (const item of check.findings || []) {
    if (item.from === "mismatch") {
      const mismatch = recipe.legacy?.mismatch;
      if (ctx.mismatch && mismatch) {
        findings.push({ severity: "fail", title: (mismatch.check?.title || mismatch.reason).zh, detail: (mismatch.check?.detail || mismatch.reason).zh });
      }
    } else if (item.from === "blockIf") {
      for (const block of blocks) {
        if (item.codes && !item.codes.includes(block.code)) continue;
        findings.push({
          severity: "fail",
          title: (block.check?.title || check.blockTitle || { zh: block.code }).zh,
          detail: block.check?.detail ? block.check.detail.zh : block.message.zh,
        });
      }
    } else if (item.from === "validation") {
      for (const rule of recipe.validation || []) {
        if (item.codes && !item.codes.includes(rule.code)) continue;
        if (rule.kind === "tokenizerSha256") {
          if (!ctx.localPath) continue;
          const found = await tokenizerFinding(rule, ctx.localPath);
          if (found) findings.push(found);
        } else if (rule.kind === "kvCacheDtypeIn" || rule.kind === "rule") {
          for (const found of evaluateValidation(recipe, state, [rule.code])) {
            findings.push({ severity: found.severity, title: found.title.zh, detail: found.message.zh });
          }
        }
      }
    } else {
      findings.push({ severity: item.severity, title: item.title.zh, detail: item.detail.zh });
    }
  }
  const recommendations = check.recommendFromProfile ? profileLegacyConfig(recipe, store) : {};
  for (const [field, template] of Object.entries(check.recommendations || {})) {
    const rendered = renderTemplate(template, state);
    if (rendered !== undefined) recommendations[field] = rendered;
  }
  return { findings, recommendations };
}

// ---------------------------------------------------------------------------
// Builtin profiles
// ---------------------------------------------------------------------------

function profileEngineId(recipe, store) {
  if (recipe.engineId) return recipe.engineId;
  try {
    return store.registry().defaultEngineFor(recipe.profile.managerId);
  } catch {
    return recipe.profile.managerId === "llama" ? "llamacpp" : "vllm";
  }
}

/** A profile's flat legacy config, without its model. */
function profileLegacyConfig(recipe, store = getRecipeStore(), ctx = {}) {
  const profile = recipe.profile;
  if (!profile) return {};
  const engineId = profileEngineId(recipe, store);
  const config = {};
  if (recipe.engineId) {
    try {
      config.engine = store.registry().toLegacy(recipe.engineId);
    } catch {
      config.engine = recipe.engineId;
    }
  }
  Object.assign(config, legacyAliases.valuesToLegacyConfig(profile.values || {}, engineId, { catalog: store.catalogs().loadCatalog(engineId) }));
  Object.assign(config, clone(profile.legacy || {}));
  if (profile.pinRuntimeImage) config.runtimeImage = recipeRuntimeImage(recipe, ctx, store);
  return config;
}

function defaultModelsRoot() {
  if (process.env.VLLM_MODELS_ROOT) return process.env.VLLM_MODELS_ROOT;
  const aiRoot = process.env.AI_ROOT || path.resolve(__dirname, "..", "..");
  return path.join(aiRoot, "models");
}

// The model directory under the models root, in the root's own separator style.
function joinModelDir(root, dir) {
  const text = String(root || "").replace(/[\\/]+$/, "");
  const separator = text.includes("\\") && !text.includes("/") ? "\\" : "/";
  return `${text}${separator}${dir}`;
}

/**
 * builtinProfiles(managerId, { modelsRoot?, normalize?, imageFor? }) → the
 * manager's builtin launch profiles in their legacy shape, ordered by
 * profile.order: { id, name, description, source: "builtin", requirements?,
 * config }. config is the profile's legacy config through normalize (the
 * manager's normalizeLaunchConfig).
 */
function builtinProfiles(managerId, options = {}) {
  const store = options.store || getRecipeStore();
  const normalize = typeof options.normalize === "function" ? options.normalize : (config) => config;
  const modelsRoot = options.modelsRoot || defaultModelsRoot();
  return store.list({ managerId })
    .filter((recipe) => recipe.profile)
    .sort((a, b) => a.profile.order - b.profile.order || a.profile.id.localeCompare(b.profile.id))
    .map((recipe) => {
      const profile = recipe.profile;
      const config = {
        ...(profile.modelDir ? { model: joinModelDir(modelsRoot, profile.modelDir) } : {}),
        ...profileLegacyConfig(recipe, store, options),
      };
      return {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        source: "builtin",
        ...(profile.requirements ? { requirements: clone(profile.requirements) } : {}),
        config: normalize(config),
      };
    });
}

// ---------------------------------------------------------------------------
// Override watcher
// ---------------------------------------------------------------------------

/**
 * fs.watch on the override directory with a debounce (01 §10.3): a burst of
 * events triggers one reloadRecipes after debounceMs of quiet. A missing
 * directory is not watched (the reload route still works); any other watch
 * error logs one line and stops the watcher.
 */
function watchRecipeOverrides(options = {}) {
  const store = options.store || getRecipeStore();
  const dir = options.dir || store.overrideDir;
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : DEFAULT_DEBOUNCE_MS;
  const watch = typeof options.watch === "function" ? options.watch : fs.watch;
  const timers = options.timers || { setTimeout, clearTimeout };
  const log = typeof options.log === "function" ? options.log : () => {};
  const onReload = typeof options.onReload === "function" ? options.onReload : null;
  let timer = null;
  let watcher = null;
  let closed = false;

  function fire() {
    timer = null;
    if (closed) return;
    try {
      const result = store.reload();
      if (onReload) onReload(result);
      if (!result.ok) log(`[recipes] reload kept the last good recipes; ${result.errors.length} file error(s), see GET /api/engines`);
    } catch (error) {
      log(`[recipes] reload failed: ${error.message}`);
    }
  }

  function trigger() {
    if (closed) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(fire, debounceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    watcher = null;
  }

  if (dir) {
    try {
      watcher = watch(dir, { persistent: false }, () => trigger());
      if (watcher && typeof watcher.on === "function") {
        watcher.on("error", (error) => {
          log(`[recipes] watching ${path.basename(dir)} stopped: ${error.message}`);
          stop();
        });
      }
    } catch (error) {
      watcher = null;
      if (error.code !== "ENOENT") log(`[recipes] cannot watch ${path.basename(dir)}: ${error.message}`);
    }
  }

  return {
    trigger,
    get watching() {
      return Boolean(watcher);
    },
    close() {
      closed = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      stop();
    },
  };
}

module.exports = {
  BUNDLED_RECIPES_DIR,
  LEGACY_DOCKER_SLOTS,
  SCORES,
  applyRecipe,
  builtinProfiles,
  clearRecipeStoreCache,
  createRecipeStore,
  deepMerge,
  getRecipeStore,
  legacyCompatibility,
  legacyOptionErrors,
  legacyRuntimePreset,
  legacyUserValues,
  loadRecipes,
  matchRecipes,
  mergeCapabilityPreset,
  presetFromRecipe,
  profileLegacyConfig,
  recipeForLegacyPreset,
  recipeRuntimeImage,
  reloadRecipes,
  renderLaunchFixed,
  selectLegacyRecipe,
  watchRecipeOverrides,
};
