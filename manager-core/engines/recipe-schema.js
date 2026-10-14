"use strict";

// Recipe validator (docs/overhaul/01-engines.md §10.1, 00 §9.10). A recipe is
// a validated launch configuration for one engine: values, derived values,
// locks and blocks as expressions (expr.js), the launch data a tier-1 adapter
// consumes through its slots (fixed args, env, labels, docker flags), the
// memory policy, the builtin launch profile it backs, and the legacy preset
// shape the managers still hand to their runtime-command wrappers.
//
// Hand-written like descriptor-schema.js, no dependencies. Recipe loading,
// 02's save-as-recipe (MOD-17) and the console all call validateRecipe; 02
// never validates recipes with descriptor-schema.js.
//
//   validateRecipe(obj, { catalogs?, registry?, mode: "bundled"|"override" })
//     → { ok, errors: [{ path, code, message }], warnings: [{ path, code, message }] }
//
// catalogs is a param-catalog loader (loadCatalog(engineId)) or a map
// { engineId: catalog }; registry is an engine registry. Without them the
// checks that need them (engine registered, runtime resolvable, param ids in
// the catalog) are skipped, so the console can run the structural checks on
// its own. A recipe that extends another is validated after the merge (the
// loader does that); validateRecipe checks the fields as given.
//
// Value forms. values entries are a JSON literal or {"expr": AST}. The legacy
// templates, env values, label values and fixed args also accept
//   {"text": "…{{placeholder}}…", "when"?: AST, "skipEmpty"?: true}  skipEmpty: left out when a placeholder is empty
//   {"recipe": paramId, "else"?: literal, "format"?: "json"}   the param's resolved value
//   {"expr": AST, "format"?: "json"}                           "json" stringifies objects
//   {"fixed": "env"}                                           the rendered recipe env
//   {"var": name}                                              a legacy.vars entry
// Placeholders: param:<id>, user:<id>, fact:<name>, env:<NAME>, var:<name>,
// fixedEnv:<NAME>, manifest:<key>.<field>, runtime.image, recipe.runtimeImage,
// blockReason, draft.path.

const expr = require("./expr");

const RECIPE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const MANIFEST_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const LABEL_KEY_PATTERN = /^[a-z0-9][a-z0-9.\-/]{0,127}$/;
const LEGACY_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const VAR_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMPUTE_CAP_PATTERN = /^\d{1,2}(?:\.\d{1,2})?$/;
const MODEL_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLACEHOLDER_PATTERN = /\{\{([^{}]{1,96})\}\}/g;
const MAX_ID_LENGTH = 64;
const MAX_TEXT_LENGTH = 2000;
const MAX_ARGS = 128;
const MAX_ARG_LENGTH = 4096;

const KINDS = Object.freeze(["model", "scenario"]);
const STATUSES = Object.freeze(["verified", "experimental", "blocked"]);
const MANAGER_IDS = Object.freeze(["vllm", "llama"]);
const MATCH_KEYS = Object.freeze(["familyId", "contentDigest", "runtimeId", "capabilityIds", "quant", "minComputeCapability", "minGpuMemoryGb"]);
const MEMORY_POLICIES = Object.freeze([
  "device-fraction", "static-fraction-of-free", "free-fraction-after-weights", "gguf-estimate",
  "measured", "server-reported", "weights-plus-kv",
]);
const SEVERITIES = Object.freeze(["fail", "warn"]);
const VALIDATION_KINDS = Object.freeze(["kvCacheDtypeIn", "rule", "tokenizerSha256", "draftArchitecture"]);
// Slots the tier-1 adapters read (adapters/_vllm-manager.js) and their types.
const SLOT_TYPES = Object.freeze({
  restart: "string",
  hfCacheMount: "boolean",
  modelMountReadOnly: "boolean",
  cacheMount: "string",
  modelArgStyle: ["positional", "flag"],
  disableQuantizationArg: "boolean",
  disableKvCacheDtypeArg: "boolean",
  disableLanguageModelOnly: "boolean",
});
// Docker flags a recipe may not set through dockerFlags: the manager owns
// identity, networking, GPUs, mounts, env and labels (they have their own
// slots and fields), and nothing may widen the container's privileges.
const DENIED_DOCKER_FLAGS = new Set([
  "--name", "--network", "--net", "-p", "--publish", "-P", "--publish-all", "-v", "--volume", "--mount",
  "-e", "--env", "--env-file", "--label", "-l", "--label-file", "--restart", "--gpus", "--ipc",
  "--entrypoint", "--privileged", "--pid", "--cap-add", "--security-opt", "--device", "--user", "-u",
  "--rm", "--userns", "--uts", "--volumes-from",
]);
// Legacy body fields that are LaunchRequest fields rather than params (01 §9.3,
// legacy-aliases.REQUEST_FIELDS) plus vllm-manager's layout field. Conditions
// may read them as {"user": field}: the managers' legacy checks did.
const LEGACY_REQUEST_FIELDS = Object.freeze(["model", "port", "instanceMode", "instanceId", "networkAccess", "engine", "runtimeImage", "gpuDeviceIds", "multiGpuMode"]);
const FIXED_PLACEHOLDERS = new Set(["runtime.image", "recipe.runtimeImage", "blockReason", "draft.path"]);
const TEMPLATE_FORMS = Object.freeze({
  expr: new Set(["expr", "format"]),
  text: new Set(["text", "when", "skipEmpty"]),
  recipe: new Set(["recipe", "else", "format"]),
  fixed: new Set(["fixed"]),
  var: new Set(["var"]),
});

const TOP_FIELDS = new Set([
  "schemaVersion", "asOf", "staleAfterDays", "id", "kind", "status", "label", "description", "engineId",
  "extends", "runtime", "match", "appliesWhen", "priority", "inputs", "values", "derived", "locks",
  "blockIf", "validation", "fixedArgs", "env", "labels", "dockerFlags", "slots", "memory", "stallMs",
  "notes", "legacy", "profile", "evidence",
]);
const LEGACY_FIELDS = new Set(["presetId", "presetLabel", "notesEn", "preset", "base", "mismatch", "check", "vars", "mergeCapabilities"]);
const PROFILE_FIELDS = new Set(["id", "name", "description", "managerId", "order", "requirements", "modelDir", "values", "legacy", "pinRuntimeImage"]);
// Host paths never appear in recipe data (01 §10.1): a drive letter, a UNC
// share or a home directory. Container paths (/cache, /opt/...) are fine.
const HOST_PATH_PATTERN = /(?:^|[\s="',:;])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9]|\/(?:home|Users)\/|~[\\/])/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function joinPath(base, key) {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

function createReport() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(path, code, message) {
      errors.push({ path, code, message });
    },
    warn(path, code, message) {
      warnings.push({ path, code, message });
    },
  };
}

function checkI18n(report, value, where, { required = true, extraKeys = [] } = {}) {
  if (value === undefined || value === null) {
    if (required) report.error(where, "required", `${where} needs zh and en text.`);
    return;
  }
  if (!isPlainObject(value)) {
    report.error(where, "invalid_type", `${where} must be {"zh": "…", "en": "…"}.`);
    return;
  }
  for (const lang of ["zh", "en"]) {
    const text = value[lang];
    if (typeof text !== "string" || !text.trim()) report.error(joinPath(where, lang), "required", `${joinPath(where, lang)} must be non-empty text.`);
    else if (text.length > MAX_TEXT_LENGTH) report.error(joinPath(where, lang), "too_long", `${joinPath(where, lang)} is longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "zh" && key !== "en" && !extraKeys.includes(key)) report.error(joinPath(where, key), "unknown_field", `Unknown language key ${key}.`);
  }
}

function checkUnknownFields(report, value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) report.error(joinPath(where, key), "unknown_field", `Unknown field ${joinPath(where, key)}.`);
  }
}

function checkString(report, value, where, { required = false, pattern = null, max = MAX_TEXT_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) report.error(where, "required", `${where} is required.`);
    return false;
  }
  if (typeof value !== "string" || !value.trim()) {
    report.error(where, "invalid_type", `${where} must be non-empty text.`);
    return false;
  }
  if (value.length > max) {
    report.error(where, "too_long", `${where} is longer than ${max} characters.`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    report.error(where, "invalid_value", `${where} does not match ${pattern}.`);
    return false;
  }
  return true;
}

function catalogFor(catalogs, engineId) {
  if (!catalogs || !engineId) return null;
  try {
    if (typeof catalogs.loadCatalog === "function") return catalogs.loadCatalog(engineId);
    return isPlainObject(catalogs) || catalogs instanceof Map
      ? (catalogs instanceof Map ? catalogs.get(engineId) : catalogs[engineId]) || null
      : null;
  } catch {
    return null;
  }
}

function catalogIds(catalog) {
  if (!catalog) return null;
  if (catalog.byId instanceof Map) return new Set(catalog.byId.keys());
  if (Array.isArray(catalog.params)) return new Set(catalog.params.map((param) => param.id));
  return null;
}

/**
 * The scope a recipe's expressions are checked in: the params it may set (its
 * engine's catalog), the ids its conditions may read (every engine the same
 * manager hosts, because the legacy forms send every field for every engine,
 * plus the legacy request fields), its env inputs and its vars.
 */
function recipeScope(recipe, { catalogs, registry }) {
  const engineId = typeof recipe.engineId === "string" ? recipe.engineId : null;
  const own = catalogIds(catalogFor(catalogs, engineId));
  let readable = null;
  if (own) {
    readable = new Set([...own, ...LEGACY_REQUEST_FIELDS]);
    const managerId = registry?.get?.(engineId)?.hostManager || null;
    const siblings = managerId && typeof registry?.hostedBy === "function" ? registry.hostedBy(managerId) : [];
    for (const sibling of siblings) {
      for (const id of catalogIds(catalogFor(catalogs, sibling)) || []) readable.add(id);
    }
  }
  const envAllowlist = Array.isArray(recipe.inputs?.env) ? recipe.inputs.env.filter((name) => typeof name === "string") : [];
  const vars = isPlainObject(recipe.legacy?.vars) ? new Set(Object.keys(recipe.legacy.vars)) : new Set();
  const envKeys = isPlainObject(recipe.env) ? new Set(Object.keys(recipe.env)) : new Set();
  return { engineId, own, readable, envAllowlist, vars, envKeys };
}

function checkExpr(report, ast, where, scope) {
  const result = expr.validateExpr(ast, {
    envAllowlist: scope.envAllowlist,
    ...(scope.readable ? { paramIds: [...scope.readable] } : {}),
  });
  for (const item of result.errors) {
    report.error(item.path ? `${where}.${item.path}` : where, `expr_${item.code}`, item.message);
  }
  return result.ok;
}

function checkParamId(report, id, where, scope) {
  if (typeof id !== "string" || !expr.PARAM_ID_PATTERN.test(id)) {
    report.error(where, "invalid_param", `${where} must name a parameter id.`);
    return false;
  }
  if (scope.own && !scope.own.has(id)) {
    report.error(where, "unknown_param", `${scope.engineId} has no parameter ${id}.`);
    return false;
  }
  return true;
}

function checkJsonLiteral(report, value, where, depth = 0) {
  if (depth > 16) {
    report.error(where, "too_deep", `${where} nests too deeply.`);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) report.error(where, "invalid_value", `${where} must be a finite number.`);
    return;
  }
  if (typeof value === "string") {
    if (value.includes("\0")) report.error(where, "invalid_value", `${where} contains a NUL character.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkJsonLiteral(report, item, joinPath(where, index), depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") report.error(joinPath(where, key), "invalid_value", `${key} is not allowed as a key.`);
      else checkJsonLiteral(report, item, joinPath(where, key), depth + 1);
    }
    return;
  }
  report.error(where, "invalid_value", `${where} must be JSON.`);
}

function checkPlaceholders(report, text, where, scope, manifestOk) {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    const [namespace, rest] = name.includes(":") ? [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)] : [name, ""];
    let ok = false;
    if (!rest) ok = FIXED_PLACEHOLDERS.has(name);
    else if (namespace === "param" || namespace === "user") ok = expr.PARAM_ID_PATTERN.test(rest) && (!scope.readable || scope.readable.has(rest));
    else if (namespace === "fact") ok = expr.isFactName(rest);
    else if (namespace === "env") ok = scope.envAllowlist.includes(rest);
    else if (namespace === "var") ok = scope.vars.has(rest);
    else if (namespace === "fixedEnv") ok = scope.envKeys.has(rest);
    else if (namespace === "manifest") ok = /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(rest) && manifestOk(rest.split(".")[0]);
    if (!ok) report.error(where, "unknown_placeholder", `${where}: unknown placeholder {{${name}}}.`);
  }
}

function templateForm(value) {
  if (!isPlainObject(value)) return null;
  for (const [form, keys] of Object.entries(TEMPLATE_FORMS)) {
    if (Object.hasOwn(value, form) && Object.keys(value).every((key) => keys.has(key))) return form;
  }
  return null;
}

/**
 * One template value (legacy preset field, recommendation, env value, label
 * value, fixed arg). allowText limits where the text form is meaningful.
 */
function checkTemplateValue(report, value, where, scope, context) {
  const form = templateForm(value);
  if (!form) {
    checkJsonLiteral(report, value, where);
    if (typeof value === "string") checkPlaceholderFree(report, value, where);
    return;
  }
  if (form === "expr") {
    checkExpr(report, value.expr, `${where}.expr`, scope);
    if (value.format !== undefined && value.format !== "json") report.error(`${where}.format`, "invalid_value", "format is \"json\".");
  } else if (form === "text") {
    if (typeof value.text !== "string" || value.text.length > MAX_TEXT_LENGTH || value.text.includes("\0")) {
      report.error(`${where}.text`, "invalid_value", `${where}.text must be text of at most ${MAX_TEXT_LENGTH} characters.`);
    } else {
      checkPlaceholders(report, value.text, `${where}.text`, scope, context.manifestOk);
    }
    if (value.when !== undefined) checkExpr(report, value.when, `${where}.when`, scope);
    if (value.skipEmpty !== undefined && typeof value.skipEmpty !== "boolean") report.error(`${where}.skipEmpty`, "invalid_type", "skipEmpty is a boolean.");
  } else if (form === "recipe") {
    if (typeof value.recipe !== "string" || !expr.PARAM_ID_PATTERN.test(value.recipe)) report.error(`${where}.recipe`, "invalid_param", "recipe names a parameter id.");
    else if (scope.own && !scope.own.has(value.recipe)) report.error(`${where}.recipe`, "unknown_param", `${scope.engineId} has no parameter ${value.recipe}.`);
    if (value.else !== undefined) checkJsonLiteral(report, value.else, `${where}.else`);
    if (value.format !== undefined && value.format !== "json") report.error(`${where}.format`, "invalid_value", "format is \"json\".");
  } else if (form === "fixed") {
    if (value.fixed !== "env") report.error(`${where}.fixed`, "invalid_value", "fixed is \"env\".");
  } else if (form === "var") {
    if (!scope.vars.has(value.var)) report.error(`${where}.var`, "unknown_var", `legacy.vars has no ${value.var}.`);
  }
}

function checkPlaceholderFree(report, text, where) {
  if (PLACEHOLDER_PATTERN.test(text)) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    report.error(where, "invalid_value", `${where}: placeholders need the {"text": …} form.`);
  }
  PLACEHOLDER_PATTERN.lastIndex = 0;
}

function checkHeader(report, recipe) {
  if (recipe.schemaVersion !== 1) report.error("schemaVersion", "unsupported_version", "schemaVersion must be 1.");
  if (typeof recipe.asOf !== "string" || !DATE_PATTERN.test(recipe.asOf)) report.error("asOf", "invalid_value", "asOf is a YYYY-MM-DD date.");
  if (!Number.isInteger(recipe.staleAfterDays) || recipe.staleAfterDays < 1) report.error("staleAfterDays", "invalid_value", "staleAfterDays is a positive integer.");
}

function checkIdentity(report, recipe, { registry }) {
  if (typeof recipe.id !== "string" || recipe.id.length > MAX_ID_LENGTH || !RECIPE_ID_PATTERN.test(recipe.id)) {
    report.error("id", "invalid_id", "id is a kebab-case recipe id (a-z, 0-9 and single dashes, at most 64 characters).");
  }
  if (!KINDS.includes(recipe.kind)) report.error("kind", "invalid_value", `kind is one of ${KINDS.join(", ")}.`);
  if (!STATUSES.includes(recipe.status)) report.error("status", "invalid_value", `status is one of ${STATUSES.join(", ")}.`);
  checkI18n(report, recipe.label, "label");
  checkI18n(report, recipe.description, "description", { required: false });
  if (recipe.kind === "model" || recipe.engineId !== undefined) {
    if (typeof recipe.engineId !== "string" || !ENGINE_ID_PATTERN.test(recipe.engineId)) {
      report.error("engineId", recipe.engineId === undefined ? "required" : "invalid_value", "A model recipe names its engineId.");
    } else if (registry && typeof registry.has === "function" && !registry.has(recipe.engineId)) {
      report.error("engineId", "unknown_engine", `Engine ${recipe.engineId} is not registered.`);
    }
  }
  if (recipe.extends !== undefined) {
    if (typeof recipe.extends !== "string" || !RECIPE_ID_PATTERN.test(recipe.extends)) report.error("extends", "invalid_value", "extends names a recipe id.");
    else if (recipe.extends === recipe.id) report.error("extends", "invalid_value", "A recipe cannot extend itself.");
  }
  if (recipe.priority !== undefined && (!Number.isInteger(recipe.priority) || Math.abs(recipe.priority) > 100000)) {
    report.error("priority", "invalid_value", "priority is an integer.");
  }
  if (recipe.stallMs !== undefined && (!Number.isInteger(recipe.stallMs) || recipe.stallMs < 60000 || recipe.stallMs > 24 * 3600 * 1000)) {
    report.error("stallMs", "invalid_value", "stallMs is an integer between one minute and a day.");
  }
}

// The runtime the recipe pins, through the registry: { runtimeId } or null.
function checkRuntime(report, recipe, { registry }) {
  const runtime = recipe.runtime;
  if (runtime === undefined) return null;
  if (!isPlainObject(runtime)) {
    report.error("runtime", "invalid_type", "runtime is {\"ref\": manifestKey, \"allowOverride\": boolean}.");
    return null;
  }
  checkUnknownFields(report, runtime, new Set(["ref", "allowOverride"]), "runtime");
  if (!checkString(report, runtime.ref, "runtime.ref", { required: true, pattern: MANIFEST_KEY_PATTERN })) return null;
  if (runtime.allowOverride !== undefined && typeof runtime.allowOverride !== "boolean") report.error("runtime.allowOverride", "invalid_type", "allowOverride is a boolean.");
  if (!registry || typeof registry.resolveRuntime !== "function" || typeof recipe.engineId !== "string") return null;
  try {
    return registry.resolveRuntime(recipe.engineId, { manifestKey: runtime.ref });
  } catch (error) {
    report.error("runtime.ref", "runtime_unresolved", `Runtime ${runtime.ref} is not a runtime of ${recipe.engineId}: ${error.message}`);
    return null;
  }
}

function checkStringList(report, value, where, { pattern = null, min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    report.error(where, "invalid_type", `${where} is a list of text.`);
    return;
  }
  value.forEach((item, index) => checkString(report, item, joinPath(where, index), { required: true, pattern, max: 256 }));
  if (new Set(value).size !== value.length) report.error(where, "duplicate_value", `${where} lists a value twice.`);
}

function checkMatch(report, recipe, runtimeRef) {
  const match = recipe.match;
  if (match === undefined) return;
  if (!isPlainObject(match)) {
    report.error("match", "invalid_type", "match is an object.");
    return;
  }
  for (const key of Object.keys(match)) {
    if (!MATCH_KEYS.includes(key)) report.error(`match.${key}`, "unknown_match_key", `Unknown match key ${key}; match takes ${MATCH_KEYS.join(", ")}.`);
  }
  if (recipe.kind === "scenario" && Object.keys(match).length) report.error("match", "invalid_value", "A scenario recipe never matches a model.");
  if (match.familyId !== undefined) checkString(report, match.familyId, "match.familyId", { pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ });
  if (match.contentDigest !== undefined) checkString(report, match.contentDigest, "match.contentDigest", { pattern: SHA256_PATTERN });
  if (match.capabilityIds !== undefined) {
    checkStringList(report, match.capabilityIds, "match.capabilityIds", { pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ });
    report.warn("match.capabilityIds", "recipe_match_deprecated", "match.capabilityIds is the deprecated v1 capability alias; use match.familyId.");
  }
  if (match.quant !== undefined) checkStringList(report, match.quant, "match.quant", { pattern: /^[a-z0-9][a-z0-9_-]{0,31}$/ });
  if (match.minComputeCapability !== undefined) checkString(report, match.minComputeCapability, "match.minComputeCapability", { pattern: COMPUTE_CAP_PATTERN });
  if (match.minGpuMemoryGb !== undefined && (typeof match.minGpuMemoryGb !== "number" || !(match.minGpuMemoryGb > 0) || match.minGpuMemoryGb > 4096)) {
    report.error("match.minGpuMemoryGb", "invalid_value", "minGpuMemoryGb is a positive number.");
  }
  if (match.runtimeId !== undefined && checkString(report, match.runtimeId, "match.runtimeId", { pattern: /^[a-z][a-z0-9-]{1,31}@[A-Za-z0-9._-]{1,96}$/ })) {
    if (!recipe.runtime) report.error("match.runtimeId", "match_runtime_mismatch", "match.runtimeId needs runtime.ref naming the same runtime.");
    else if (runtimeRef && runtimeRef.runtimeId !== match.runtimeId) {
      report.error("match.runtimeId", "match_runtime_mismatch", `match.runtimeId ${match.runtimeId} differs from runtime.ref ${recipe.runtime.ref} (${runtimeRef.runtimeId}).`);
    }
  }
}

function checkInputs(report, recipe) {
  if (recipe.inputs === undefined) return;
  if (!isPlainObject(recipe.inputs)) {
    report.error("inputs", "invalid_type", "inputs is {\"env\": [names]}.");
    return;
  }
  checkUnknownFields(report, recipe.inputs, new Set(["env"]), "inputs");
  if (recipe.inputs.env === undefined) return;
  if (!Array.isArray(recipe.inputs.env)) {
    report.error("inputs.env", "invalid_type", "inputs.env is a list of variable names.");
    return;
  }
  recipe.inputs.env.forEach((name, index) => {
    const where = `inputs.env[${index}]`;
    if (typeof name !== "string" || !expr.ENV_NAME_PATTERN.test(name)) report.error(where, "env_name_invalid", `${where} must match ${expr.ENV_NAME_PATTERN}.`);
    else if (expr.SECRET_ENV_PATTERN.test(name)) report.error(where, "env_name_secret", `${name} holds a secret; a recipe never reads it.`);
  });
}

function checkValues(report, recipe, scope) {
  if (recipe.values !== undefined) {
    if (!isPlainObject(recipe.values)) report.error("values", "invalid_type", "values maps parameter ids to values.");
    else {
      for (const [id, value] of Object.entries(recipe.values)) {
        const where = `values.${id}`;
        if (!checkParamId(report, id, where, scope)) continue;
        if (isPlainObject(value) && Object.hasOwn(value, "expr")) {
          if (Object.keys(value).length !== 1) report.error(where, "invalid_value", `${where}: an expression value is {"expr": AST}.`);
          checkExpr(report, value.expr, `${where}.expr`, scope);
        } else {
          checkJsonLiteral(report, value, where);
        }
      }
    }
  }
  if (recipe.derived !== undefined) {
    if (!isPlainObject(recipe.derived)) report.error("derived", "invalid_type", "derived maps parameter ids to expressions.");
    else {
      for (const [id, ast] of Object.entries(recipe.derived)) {
        if (checkParamId(report, id, `derived.${id}`, scope)) checkExpr(report, ast, `derived.${id}`, scope);
      }
    }
  }
  if (recipe.locks !== undefined) {
    if (recipe.kind === "scenario") report.error("locks", "invalid_value", "A scenario recipe has no locks.");
    if (!Array.isArray(recipe.locks)) report.error("locks", "invalid_type", "locks is a list.");
    else {
      const seen = new Set();
      recipe.locks.forEach((lock, index) => {
        const where = `locks[${index}]`;
        if (!isPlainObject(lock)) {
          report.error(where, "invalid_type", `${where} is {param, value, reason}.`);
          return;
        }
        checkUnknownFields(report, lock, new Set(["param", "value", "reason"]), where);
        if (checkParamId(report, lock.param, `${where}.param`, scope)) {
          if (seen.has(lock.param)) report.error(`${where}.param`, "duplicate_lock", `${lock.param} is locked twice.`);
          seen.add(lock.param);
        }
        if (!Object.hasOwn(lock, "value") || lock.value === null) report.error(`${where}.value`, "required", "A lock pins a value.");
        else checkJsonLiteral(report, lock.value, `${where}.value`);
        checkI18n(report, lock.reason, `${where}.reason`);
      });
    }
  }
}

function checkBlockIf(report, recipe, scope) {
  if (recipe.blockIf === undefined) return;
  if (!Array.isArray(recipe.blockIf)) {
    report.error("blockIf", "invalid_type", "blockIf is a list.");
    return;
  }
  recipe.blockIf.forEach((rule, index) => {
    const where = `blockIf[${index}]`;
    if (!isPlainObject(rule)) {
      report.error(where, "invalid_type", `${where} is {when, code, message}.`);
      return;
    }
    checkUnknownFields(report, rule, new Set(["when", "code", "message", "check"]), where);
    if (!Object.hasOwn(rule, "when")) report.error(`${where}.when`, "required", "A block names its condition.");
    else checkExpr(report, rule.when, `${where}.when`, scope);
    checkString(report, rule.code, `${where}.code`, { required: true, pattern: CODE_PATTERN });
    checkI18n(report, rule.message, `${where}.message`);
    checkCheckText(report, rule.check, `${where}.check`);
  });
}

function checkCheckText(report, check, where) {
  if (check === undefined) return;
  if (!isPlainObject(check)) {
    report.error(where, "invalid_type", `${where} is {title, detail}.`);
    return;
  }
  checkUnknownFields(report, check, new Set(["title", "detail"]), where);
  checkI18n(report, check.title, `${where}.title`, { required: false });
  checkI18n(report, check.detail, `${where}.detail`, { required: false });
}

function checkValidation(report, recipe, scope, manifestOk) {
  if (recipe.validation === undefined) return;
  if (!Array.isArray(recipe.validation)) {
    report.error("validation", "invalid_type", "validation is a list.");
    return;
  }
  const codes = new Set();
  recipe.validation.forEach((rule, index) => {
    const where = `validation[${index}]`;
    if (!isPlainObject(rule)) {
      report.error(where, "invalid_type", `${where} is a validation rule.`);
      return;
    }
    if (!VALIDATION_KINDS.includes(rule.kind)) {
      report.error(`${where}.kind`, "unknown_validation", `kind is one of ${VALIDATION_KINDS.join(", ")}.`);
      return;
    }
    const allowed = new Set(["kind", "severity", "code", "title", "message"]);
    if (rule.kind === "kvCacheDtypeIn") {
      allowed.add("values");
      checkStringList(report, rule.values, `${where}.values`);
    } else if (rule.kind === "rule") {
      allowed.add("when");
      if (!Object.hasOwn(rule, "when")) report.error(`${where}.when`, "required", "A rule names its condition.");
      else checkExpr(report, rule.when, `${where}.when`, scope);
    } else if (rule.kind === "tokenizerSha256") {
      allowed.add("sha256");
      allowed.add("unverifiedTitle");
      checkString(report, rule.sha256, `${where}.sha256`, { required: true, pattern: SHA256_PATTERN });
      checkI18n(report, rule.unverifiedTitle, `${where}.unverifiedTitle`, { required: false });
    } else if (rule.kind === "draftArchitecture") {
      allowed.add("architecture");
      allowed.add("defaultDir");
      checkString(report, rule.architecture, `${where}.architecture`, { required: true, pattern: /^[A-Za-z][A-Za-z0-9_]{0,63}$/ });
      checkString(report, rule.defaultDir, `${where}.defaultDir`, { required: true, pattern: MODEL_DIR_PATTERN });
    }
    checkUnknownFields(report, rule, allowed, where);
    if (!SEVERITIES.includes(rule.severity)) report.error(`${where}.severity`, "invalid_value", `severity is one of ${SEVERITIES.join(", ")}.`);
    if (checkString(report, rule.code, `${where}.code`, { required: true, pattern: CODE_PATTERN })) {
      if (codes.has(rule.code)) report.error(`${where}.code`, "duplicate_code", `${rule.code} is used twice.`);
      codes.add(rule.code);
    }
    checkI18n(report, rule.title, `${where}.title`);
    if (rule.kind === "draftArchitecture") checkI18n(report, rule.message, `${where}.message`, { required: false });
    else if (isPlainObject(rule.message)) {
      checkI18n(report, rule.message, `${where}.message`);
      for (const lang of ["zh", "en"]) {
        if (typeof rule.message[lang] === "string") checkPlaceholders(report, rule.message[lang], `${where}.message.${lang}`, scope, manifestOk);
      }
    } else checkI18n(report, rule.message, `${where}.message`);
  });
}

function checkLaunchData(report, recipe, scope, manifestOk) {
  if (recipe.fixedArgs !== undefined) {
    if (!Array.isArray(recipe.fixedArgs) || recipe.fixedArgs.length > MAX_ARGS) report.error("fixedArgs", "invalid_type", `fixedArgs is a list of at most ${MAX_ARGS} arguments.`);
    else {
      recipe.fixedArgs.forEach((arg, index) => {
        const where = `fixedArgs[${index}]`;
        if (typeof arg === "string") {
          if (!arg || arg.length > MAX_ARG_LENGTH || arg.includes("\0")) report.error(where, "invalid_value", `${where} must be a non-empty argument.`);
          else checkPlaceholderFree(report, arg, where);
        } else if (["expr", "text", "var"].includes(templateForm(arg))) {
          checkTemplateValue(report, arg, where, scope, { manifestOk });
        } else {
          report.error(where, "invalid_type", `${where} is text or a text/expr form.`);
        }
      });
    }
  }
  if (recipe.env !== undefined) {
    if (!isPlainObject(recipe.env)) report.error("env", "invalid_type", "env maps variable names to values.");
    else {
      for (const [name, value] of Object.entries(recipe.env)) {
        const where = `env.${name}`;
        if (!ENV_NAME_PATTERN.test(name)) report.error(where, "env_name_invalid", `${name} is not an environment variable name.`);
        else if (expr.SECRET_ENV_PATTERN.test(name)) report.error(where, "env_name_secret", `${name} would hold a secret; recipe env is shown in plans and logs.`);
        if (typeof value === "string") checkPlaceholderFree(report, value, where);
        else if (["expr", "text", "var"].includes(templateForm(value))) checkTemplateValue(report, value, where, scope, { manifestOk });
        else report.error(where, "invalid_type", `${where} is text or a text/expr form.`);
      }
    }
  }
  if (recipe.labels !== undefined) {
    if (!Array.isArray(recipe.labels)) report.error("labels", "invalid_type", "labels is a list of {key, value}.");
    else {
      const keys = new Set();
      recipe.labels.forEach((label, index) => {
        const where = `labels[${index}]`;
        if (!isPlainObject(label)) {
          report.error(where, "invalid_type", `${where} is {key, value}.`);
          return;
        }
        checkUnknownFields(report, label, new Set(["key", "value"]), where);
        if (checkString(report, label.key, `${where}.key`, { required: true, pattern: LABEL_KEY_PATTERN })) {
          if (/^ai\.manager(?:\.|$)/.test(label.key)) report.error(`${where}.key`, "managed_label", "ai.manager.* labels belong to the manager.");
          if (keys.has(label.key)) report.error(`${where}.key`, "duplicate_label", `${label.key} is set twice.`);
          keys.add(label.key);
        }
        if (typeof label.value === "string") checkPlaceholderFree(report, label.value, `${where}.value`);
        else if (["expr", "text", "var"].includes(templateForm(label.value))) checkTemplateValue(report, label.value, `${where}.value`, scope, { manifestOk });
        else report.error(`${where}.value`, "invalid_type", `${where}.value is text or a text/expr form.`);
      });
    }
  }
  if (recipe.dockerFlags !== undefined) {
    if (!Array.isArray(recipe.dockerFlags) || recipe.dockerFlags.length > MAX_ARGS) report.error("dockerFlags", "invalid_type", "dockerFlags is a list of arguments.");
    else {
      recipe.dockerFlags.forEach((flag, index) => {
        const where = `dockerFlags[${index}]`;
        if (typeof flag !== "string" || !flag || flag.length > 256 || flag.includes("\0")) {
          report.error(where, "invalid_value", `${where} must be a non-empty argument.`);
          return;
        }
        const name = flag.split("=")[0];
        if (DENIED_DOCKER_FLAGS.has(name)) report.error(where, "docker_flag_denied", `${name} is managed by the platform and cannot be a recipe docker flag.`);
      });
    }
  }
  if (recipe.slots !== undefined) {
    if (!isPlainObject(recipe.slots)) report.error("slots", "invalid_type", "slots is an object.");
    else {
      for (const [key, value] of Object.entries(recipe.slots)) {
        const where = `slots.${key}`;
        const type = SLOT_TYPES[key];
        if (!type) report.error(where, "unknown_slot", `Unknown slot ${key}; slots are ${Object.keys(SLOT_TYPES).join(", ")}.`);
        else if (Array.isArray(type) ? !type.includes(value) : typeof value !== type) {
          report.error(where, "invalid_value", Array.isArray(type) ? `${key} is one of ${type.join(", ")}.` : `${key} is a ${type}.`);
        }
      }
      const mount = recipe.slots.cacheMount;
      if (typeof mount === "string" && !/^type=volume,source=[A-Za-z0-9][A-Za-z0-9_.-]{0,127},target=\/[A-Za-z0-9_./-]{0,255}$/.test(mount)) {
        report.error("slots.cacheMount", "invalid_value", "cacheMount is a named volume: type=volume,source=<name>,target=/<container path>.");
      }
      if (typeof recipe.slots.restart === "string" && !/^(?:no|always|unless-stopped|on-failure(?::\d{1,2})?)$/.test(recipe.slots.restart)) {
        report.error("slots.restart", "invalid_value", "restart is a docker restart policy.");
      }
    }
  }
}

function checkMemory(report, recipe, scope) {
  const memory = recipe.memory;
  if (memory === undefined) return;
  if (!isPlainObject(memory)) {
    report.error("memory", "invalid_type", "memory is an object.");
    return;
  }
  checkUnknownFields(report, memory, new Set(["policy", "calibrate", "measuredMiB", "estimatePolicy"]), "memory");
  if (!MEMORY_POLICIES.includes(memory.policy)) report.error("memory.policy", "invalid_value", `policy is one of ${MEMORY_POLICIES.join(", ")}.`);
  if (memory.calibrate !== undefined && typeof memory.calibrate !== "boolean") report.error("memory.calibrate", "invalid_type", "calibrate is a boolean.");
  if (memory.estimatePolicy !== undefined) checkString(report, memory.estimatePolicy, "memory.estimatePolicy", { pattern: /^[a-z0-9_]{1,96}$/ });
  const measured = memory.measuredMiB;
  if (measured === undefined || measured === null) {
    if (memory.policy === "measured") report.error("memory.measuredMiB", "required", "The measured policy needs measuredMiB.");
  } else if (isPlainObject(measured) && Object.hasOwn(measured, "expr")) {
    checkExpr(report, measured.expr, "memory.measuredMiB.expr", scope);
  } else if (typeof measured !== "number" || !(measured > 0)) {
    report.error("memory.measuredMiB", "invalid_value", "measuredMiB is a positive number or {\"expr\": AST}.");
  }
}

function checkNotes(report, notes, where, scope, manifestOk) {
  if (notes === undefined) return;
  if (!Array.isArray(notes)) {
    report.error(where, "invalid_type", `${where} is a list.`);
    return;
  }
  notes.forEach((note, index) => {
    const at = joinPath(where, index);
    checkI18n(report, note, at, { extraKeys: ["when"] });
    if (isPlainObject(note) && note.when !== undefined) checkExpr(report, note.when, `${at}.when`, scope);
    for (const lang of ["zh", "en"]) {
      if (typeof note?.[lang] === "string") checkPlaceholders(report, note[lang], `${at}.${lang}`, scope, manifestOk);
    }
  });
}

function checkLegacy(report, recipe, scope, manifestOk) {
  const legacy = recipe.legacy;
  if (legacy === undefined) return;
  if (!isPlainObject(legacy)) {
    report.error("legacy", "invalid_type", "legacy is an object.");
    return;
  }
  checkUnknownFields(report, legacy, LEGACY_FIELDS, "legacy");
  if (legacy.presetId !== undefined) checkString(report, legacy.presetId, "legacy.presetId", { pattern: /^[a-z0-9][a-z0-9._-]{0,95}$/ });
  if (legacy.presetLabel !== undefined) checkString(report, legacy.presetLabel, "legacy.presetLabel", { max: 200 });
  if (legacy.mergeCapabilities !== undefined && typeof legacy.mergeCapabilities !== "boolean") report.error("legacy.mergeCapabilities", "invalid_type", "mergeCapabilities is a boolean.");
  if (legacy.base !== undefined && typeof legacy.base !== "boolean") report.error("legacy.base", "invalid_type", "base is a boolean.");
  if (legacy.vars !== undefined) {
    if (!isPlainObject(legacy.vars)) report.error("legacy.vars", "invalid_type", "legacy.vars maps names to expressions.");
    else {
      for (const [name, ast] of Object.entries(legacy.vars)) {
        if (!VAR_NAME_PATTERN.test(name)) report.error(`legacy.vars.${name}`, "invalid_value", "A var name is camelCase.");
        else checkExpr(report, ast, `legacy.vars.${name}`, scope);
      }
    }
  }
  if (legacy.notesEn !== undefined) {
    if (!Array.isArray(legacy.notesEn)) report.error("legacy.notesEn", "invalid_type", "legacy.notesEn is a list.");
    else {
      legacy.notesEn.forEach((note, index) => {
        const where = `legacy.notesEn[${index}]`;
        if (typeof note === "string") checkPlaceholderFree(report, note, where);
        else if (templateForm(note) === "text") checkTemplateValue(report, note, where, scope, { manifestOk });
        else report.error(where, "invalid_type", `${where} is text or {"text": …, "when"?: AST}.`);
      });
    }
  }
  if (legacy.preset !== undefined) {
    if (!isPlainObject(legacy.preset)) report.error("legacy.preset", "invalid_type", "legacy.preset maps legacy preset fields to values.");
    else {
      for (const [field, value] of Object.entries(legacy.preset)) {
        if (!LEGACY_FIELD_PATTERN.test(field)) report.error(`legacy.preset.${field}`, "invalid_value", "A legacy preset field is a camelCase name.");
        else checkTemplateValue(report, value, `legacy.preset.${field}`, scope, { manifestOk });
      }
    }
  }
  if (legacy.mismatch !== undefined) {
    if (!isPlainObject(legacy.mismatch)) report.error("legacy.mismatch", "invalid_type", "legacy.mismatch is {reason, check?}.");
    else {
      checkUnknownFields(report, legacy.mismatch, new Set(["reason", "check"]), "legacy.mismatch");
      checkI18n(report, legacy.mismatch.reason, "legacy.mismatch.reason");
      checkCheckText(report, legacy.mismatch.check, "legacy.mismatch.check");
    }
  }
  if (legacy.check !== undefined) checkLegacyCheck(report, recipe, scope, manifestOk);
}

function checkLegacyCheck(report, recipe, scope, manifestOk) {
  const check = recipe.legacy.check;
  if (!isPlainObject(check)) {
    report.error("legacy.check", "invalid_type", "legacy.check is an object.");
    return;
  }
  checkUnknownFields(report, check, new Set(["blockTitle", "findings", "recommendations", "recommendFromProfile"]), "legacy.check");
  checkI18n(report, check.blockTitle, "legacy.check.blockTitle", { required: false });
  if (check.recommendFromProfile !== undefined && typeof check.recommendFromProfile !== "boolean") {
    report.error("legacy.check.recommendFromProfile", "invalid_type", "recommendFromProfile is a boolean.");
  }
  if (check.findings !== undefined) {
    if (!Array.isArray(check.findings)) report.error("legacy.check.findings", "invalid_type", "findings is a list.");
    else {
      check.findings.forEach((item, index) => {
        const where = `legacy.check.findings[${index}]`;
        if (!isPlainObject(item)) {
          report.error(where, "invalid_type", `${where} is a finding or a {"from": …} reference.`);
          return;
        }
        if (Object.hasOwn(item, "from")) {
          checkUnknownFields(report, item, new Set(["from", "codes"]), where);
          if (!["mismatch", "blockIf", "validation"].includes(item.from)) report.error(`${where}.from`, "invalid_value", "from is mismatch, blockIf or validation.");
          if (item.codes !== undefined) checkStringList(report, item.codes, `${where}.codes`, { pattern: CODE_PATTERN });
          return;
        }
        checkUnknownFields(report, item, new Set(["severity", "title", "detail"]), where);
        if (!["ok", "warn", "fail", "info"].includes(item.severity)) report.error(`${where}.severity`, "invalid_value", "severity is ok, warn, fail or info.");
        checkI18n(report, item.title, `${where}.title`);
        checkI18n(report, item.detail, `${where}.detail`);
      });
    }
  }
  if (check.recommendations !== undefined) {
    if (!isPlainObject(check.recommendations)) report.error("legacy.check.recommendations", "invalid_type", "recommendations maps legacy fields to values.");
    else {
      for (const [field, value] of Object.entries(check.recommendations)) {
        if (!LEGACY_FIELD_PATTERN.test(field)) report.error(`legacy.check.recommendations.${field}`, "invalid_value", "A legacy field is a camelCase name.");
        else checkTemplateValue(report, value, `legacy.check.recommendations.${field}`, scope, { manifestOk });
      }
    }
  }
}

function checkProfile(report, recipe, { catalogs, registry, validateValues }) {
  const profile = recipe.profile;
  if (profile === undefined) {
    if (recipe.kind === "scenario") report.error("profile", "required", "A scenario recipe is a builtin profile.");
    return;
  }
  if (!isPlainObject(profile)) {
    report.error("profile", "invalid_type", "profile is an object.");
    return;
  }
  checkUnknownFields(report, profile, PROFILE_FIELDS, "profile");
  checkString(report, profile.id, "profile.id", { required: true, pattern: PROFILE_ID_PATTERN });
  checkString(report, profile.name, "profile.name", { required: true, max: 80 });
  checkString(report, profile.description, "profile.description", { required: true, max: 180 });
  if (!MANAGER_IDS.includes(profile.managerId)) report.error("profile.managerId", "invalid_value", `managerId is one of ${MANAGER_IDS.join(", ")}.`);
  else if (typeof recipe.engineId === "string" && registry?.get?.(recipe.engineId) && registry.get(recipe.engineId).hostManager !== profile.managerId) {
    report.error("profile.managerId", "invalid_value", `${recipe.engineId} is hosted by the ${registry.get(recipe.engineId).hostManager} manager.`);
  }
  if (!Number.isInteger(profile.order)) report.error("profile.order", "invalid_value", "order is an integer.");
  if (profile.requirements !== undefined) {
    if (!isPlainObject(profile.requirements)) report.error("profile.requirements", "invalid_type", "requirements is an object.");
    else {
      checkUnknownFields(report, profile.requirements, new Set(["minGpuCount", "minSingleGpuMemoryGb"]), "profile.requirements");
      for (const [key, value] of Object.entries(profile.requirements)) {
        if (!Number.isInteger(value) || value < 1) report.error(`profile.requirements.${key}`, "invalid_value", `${key} is a positive integer.`);
      }
    }
  }
  if (profile.modelDir !== undefined) checkString(report, profile.modelDir, "profile.modelDir", { pattern: MODEL_DIR_PATTERN });
  if (profile.pinRuntimeImage !== undefined && typeof profile.pinRuntimeImage !== "boolean") report.error("profile.pinRuntimeImage", "invalid_type", "pinRuntimeImage is a boolean.");
  if (profile.pinRuntimeImage && !recipe.runtime) report.error("profile.pinRuntimeImage", "invalid_value", "pinRuntimeImage needs runtime.ref.");
  if (profile.legacy !== undefined) {
    if (!isPlainObject(profile.legacy)) report.error("profile.legacy", "invalid_type", "profile.legacy maps legacy fields to values.");
    else {
      for (const [field, value] of Object.entries(profile.legacy)) {
        if (!LEGACY_FIELD_PATTERN.test(field)) report.error(`profile.legacy.${field}`, "invalid_value", "A legacy field is a camelCase name.");
        else checkJsonLiteral(report, value, `profile.legacy.${field}`);
      }
      if (Object.hasOwn(profile.legacy, "model")) report.error("profile.legacy.model", "invalid_value", "A profile names its model through modelDir.");
    }
  }
  if (!isPlainObject(profile.values)) {
    report.error("profile.values", "required", "profile.values maps parameter ids to the profile's values.");
    return;
  }
  // Profile values are checked against the catalog of the engine the profile
  // launches: the recipe's, else the manager's default engine.
  const engineId = typeof recipe.engineId === "string"
    ? recipe.engineId
    : (typeof registry?.defaultEngineFor === "function" && MANAGER_IDS.includes(profile.managerId) ? registry.defaultEngineFor(profile.managerId) : null);
  const catalog = catalogFor(catalogs, engineId);
  const ids = catalogIds(catalog);
  for (const [id, value] of Object.entries(profile.values)) {
    const where = `profile.values.${id}`;
    if (!expr.PARAM_ID_PATTERN.test(id)) report.error(where, "invalid_param", `${where} must name a parameter id.`);
    else if (ids && !ids.has(id)) report.error(where, "unknown_param", `${engineId} has no parameter ${id}.`);
    checkJsonLiteral(report, value, where);
  }
  if (catalog && typeof validateValues === "function") {
    const result = validateValues(profile.values, catalog, { legacy: true });
    for (const item of result.errors || []) report.error(`profile.values.${item.field}`, item.code || "invalid_value", item.message || "Invalid profile value.");
  }
}

// Absolute host paths never appear in recipe data (01 §10.1).
function checkNoHostPaths(report, value, where, depth = 0) {
  if (depth > 24) return;
  if (typeof value === "string") {
    if (HOST_PATH_PATTERN.test(value)) report.error(where, "host_path", `${where} holds a host path; recipes use model-root-relative names and container paths only.`);
    return;
  }
  if (Array.isArray(value)) value.forEach((item, index) => checkNoHostPaths(report, item, joinPath(where, index), depth + 1));
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) checkNoHostPaths(report, item, joinPath(where, key), depth + 1);
}

/**
 * validateRecipe(obj, { catalogs?, registry?, validateValues?, mode }) → { ok, errors, warnings }.
 * validateValues (param-catalog's) also checks the profile values' ranges and choices.
 * mode "override" is a file under <AI_ROOT>/config/recipes; both modes apply
 * the same rules today, so an owner or 02's save-as-recipe can write anything
 * a bundled recipe can be.
 */
function validateRecipe(obj, options = {}) {
  const report = createReport();
  const { catalogs = null, registry = null, validateValues = null } = options;
  if (!isPlainObject(obj)) {
    report.error("", "invalid_type", "A recipe is a JSON object.");
    return { ok: false, errors: report.errors, warnings: report.warnings };
  }
  try {
    checkUnknownFields(report, obj, TOP_FIELDS, "");
    checkHeader(report, obj);
    checkIdentity(report, obj, { registry });
    const runtimeRef = checkRuntime(report, obj, { registry });
    checkMatch(report, obj, runtimeRef);
    checkInputs(report, obj);
    const scope = recipeScope(obj, { catalogs, registry });
    const manifestOk = (key) => {
      if (!registry || typeof registry.list !== "function") return MANIFEST_KEY_PATTERN.test(key);
      return registry.list().some((descriptor) => (descriptor.runtimes?.allowed || []).includes(key));
    };
    if (obj.appliesWhen !== undefined) checkExpr(report, obj.appliesWhen, "appliesWhen", scope);
    checkValues(report, obj, scope);
    checkBlockIf(report, obj, scope);
    checkValidation(report, obj, scope, manifestOk);
    checkLaunchData(report, obj, scope, manifestOk);
    checkMemory(report, obj, scope);
    checkNotes(report, obj.notes, "notes", scope, manifestOk);
    checkLegacy(report, obj, scope, manifestOk);
    checkProfile(report, obj, { catalogs, registry, validateValues });
    if (obj.evidence !== undefined) {
      if (!isPlainObject(obj.evidence)) report.error("evidence", "invalid_type", "evidence is an object.");
      else checkJsonLiteral(report, obj.evidence, "evidence");
    }
    checkNoHostPaths(report, obj, "");
  } catch (error) {
    // Only a pathological value gets here (nesting too deep to walk).
    report.error("", "invalid_recipe", `The recipe could not be checked: ${error.message}`);
  }
  return { ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings };
}

module.exports = {
  DENIED_DOCKER_FLAGS,
  KINDS,
  LEGACY_REQUEST_FIELDS,
  MATCH_KEYS,
  MEMORY_POLICIES,
  RECIPE_ID_PATTERN,
  SLOT_TYPES,
  STATUSES,
  VALIDATION_KINDS,
  isPlainObject,
  templateForm,
  validateRecipe,
};
