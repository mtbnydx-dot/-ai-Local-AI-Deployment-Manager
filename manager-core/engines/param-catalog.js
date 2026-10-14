"use strict";

// Launch parameter catalogs (docs/overhaul/01-engines.md §9). A catalog is data:
// manager-core/data/launch-params/common.json holds the shared concepts (groups,
// labels, help, units) and <engineId>.json binds them to that engine's flags and
// adds the engine's own parameters. <AI_ROOT>/config/launch-params/*.json
// overrides merge by id. A broken override is reported in errors() and the
// bundled definition stays in force; loading never throws.
//
// The catalog describes parameters; it emits nothing itself. Tier-1 adapters
// still build argv in legacy order (emit.mode "adapter"), and later packages add
// the generic appended emission (emit.mode "catalog") and introspected flags.

const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("../reference-data");
const expr = require("./expr");

const BUNDLED_PARAMS_DIR = path.join(__dirname, "..", "data", "launch-params");
const COMMON_FILE = "common.json";

const PARAM_TYPES = Object.freeze(["int", "float", "bool", "tristate", "enum", "string", "path", "json", "list", "kv"]);
const LEVELS = Object.freeze(["basic", "advanced", "expert"]);
const EMIT_MODES = Object.freeze(["adapter", "catalog"]);
const EMIT_KINDS = Object.freeze(["flag-value", "flag-bool", "bool-pair", "json", "repeat", "csv", "env", "none"]);
const TRANSFORMS = Object.freeze(["containerPath", "ctxTimesConcurrency", "jsonStringify"]);
const RULE_KINDS = Object.freeze(["errorIf", "warnIf", "requires", "conflicts"]);
const VRAM_EFFECTS = Object.freeze(["none", "weights", "kv-linear", "kv-dtype", "kv-pool", "fraction", "activations", "offload", "draft", "mmproj", "split"]);
const LEGACY_CODECS = Object.freeze(["direct", "invertedBool", "prefixCachingPair", "defaultTrueBool"]);
const HELP_KEYS = Object.freeze(["what", "whenToChange", "tradeoffs"]);
const INSTANCE_MODES = Object.freeze(["replace", "parallel", "add"]);

const PARAM_FIELDS = new Set([
  "id", "group", "level", "order", "type", "unit", "label", "summary", "help", "docs",
  "range", "choices", "choicesFrom", "pattern", "maxLength", "engineDefault", "platformDefault",
  "emit", "flags", "vramEffect", "rules", "managed", "secret", "legacy", "appliesWhen",
  "fromModel", "requiresFeature",
]);
// Overrides may tune copy, ranges, defaults and choices, never the security
// properties of a parameter.
const OVERRIDE_LOCKED_FIELDS = new Set(["managed", "secret"]);
// Merged key by key (copy); every other object field is replaced whole.
const MERGED_OBJECT_FIELDS = new Set(["label", "summary", "help"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const FLAG_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const DOM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LEGACY_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const GROUP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const FEATURE_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
const CHOICES_FROM_PATTERN = /^introspect:--?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PATTERN_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
const MAX_CHOICES = 256;
const MAX_STRING_VALUE = 4096;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function joinPath(base, key) {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

function bilingual(zh, en) {
  return `${zh} / ${en}`;
}

// ---------------------------------------------------------------------------
// Validation (hand-written, no dependencies; same style as descriptor-schema.js)
// ---------------------------------------------------------------------------

function checkI18n(value, where, errors, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push({ path: where, code: "required", message: `${where} needs zh and en text.` });
    return;
  }
  if (!isPlainObject(value)) {
    errors.push({ path: where, code: "invalid_type", message: `${where} must be {"zh": "…", "en": "…"}.` });
    return;
  }
  for (const lang of ["zh", "en"]) {
    const text = value[lang];
    if (typeof text !== "string" || !text.trim()) {
      errors.push({ path: joinPath(where, lang), code: "required", message: `${joinPath(where, lang)} must be non-empty text.` });
    } else if (text.length > MAX_TEXT_LENGTH) {
      errors.push({ path: joinPath(where, lang), code: "too_long", message: `${joinPath(where, lang)} is longer than ${MAX_TEXT_LENGTH} characters.` });
    }
  }
  for (const key of Object.keys(value)) {
    if (key !== "zh" && key !== "en") errors.push({ path: joinPath(where, key), code: "unknown_field", message: `Unknown language key ${key}.` });
  }
}

function checkExpression(ast, where, errors, paramIds) {
  const result = expr.validateExpr(ast, { envAllowlist: [], paramIds });
  for (const item of result.errors) {
    errors.push({ path: item.path ? `${where}.${item.path}` : where, code: `expr_${item.code}`, message: item.message });
  }
}

function checkPattern(pattern, where, errors) {
  if (typeof pattern !== "string" || !pattern || pattern.length > MAX_PATTERN_LENGTH) {
    errors.push({ path: where, code: "invalid_pattern", message: `${where} must be a regular expression of at most ${MAX_PATTERN_LENGTH} characters.` });
    return;
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (error) {
    errors.push({ path: where, code: "invalid_pattern", message: `${where}: ${error.message}` });
  }
}

function isDefaultValue(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value) || isPlainObject(value);
}

function checkDefault(value, where, errors, paramIds) {
  if (value === undefined || value === null) return;
  if (isPlainObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "expr")) {
    checkExpression(value.expr, joinPath(where, "expr"), errors, paramIds);
    return;
  }
  if (!isDefaultValue(value) || (typeof value === "number" && !Number.isFinite(value))) {
    errors.push({ path: where, code: "invalid_type", message: `${where} must be a JSON value or {"expr": …}.` });
  }
}

function checkEmit(emit, where, errors) {
  if (!isPlainObject(emit)) {
    errors.push({ path: where, code: "required", message: `${where} must describe how the parameter reaches the engine.` });
    return;
  }
  const allowed = new Set(["mode", "kind", "flag", "falseFlag", "env", "omitWhen", "transform", "via"]);
  for (const key of Object.keys(emit)) {
    if (!allowed.has(key)) errors.push({ path: joinPath(where, key), code: "unknown_field", message: `Unknown emit field ${key}.` });
  }
  if (!EMIT_MODES.includes(emit.mode)) errors.push({ path: joinPath(where, "mode"), code: "invalid_value", message: `emit.mode must be one of ${EMIT_MODES.join(", ")}.` });
  if (!EMIT_KINDS.includes(emit.kind)) errors.push({ path: joinPath(where, "kind"), code: "invalid_value", message: `emit.kind must be one of ${EMIT_KINDS.join(", ")}.` });
  for (const key of ["flag", "falseFlag"]) {
    if (emit[key] !== undefined && emit[key] !== null && (typeof emit[key] !== "string" || !FLAG_PATTERN.test(emit[key]))) {
      errors.push({ path: joinPath(where, key), code: "invalid_flag", message: `${joinPath(where, key)} is not a command-line flag.` });
    }
  }
  const needsFlag = ["flag-value", "flag-bool", "json", "repeat", "csv"].includes(emit.kind);
  if (needsFlag && !emit.flag) errors.push({ path: joinPath(where, "flag"), code: "required", message: `emit.kind ${emit.kind} needs emit.flag.` });
  if (emit.kind === "bool-pair" && !emit.flag && !emit.falseFlag) {
    errors.push({ path: joinPath(where, "flag"), code: "required", message: "emit.kind bool-pair needs emit.flag, emit.falseFlag or both." });
  }
  if (emit.kind === "env" && (typeof emit.env !== "string" || !ENV_PATTERN.test(emit.env))) {
    errors.push({ path: joinPath(where, "env"), code: "required", message: "emit.kind env needs an environment variable name in emit.env." });
  }
  if (emit.transform !== undefined && emit.transform !== null && !TRANSFORMS.includes(emit.transform)) {
    errors.push({ path: joinPath(where, "transform"), code: "invalid_value", message: `emit.transform must be one of ${TRANSFORMS.join(", ")}.` });
  }
  if (emit.omitWhen !== undefined && (!Array.isArray(emit.omitWhen) || !emit.omitWhen.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item)))) {
    errors.push({ path: joinPath(where, "omitWhen"), code: "invalid_type", message: "emit.omitWhen must list scalar values." });
  }
  if (emit.via !== undefined && emit.via !== null && (typeof emit.via !== "string" || !expr.PARAM_ID_PATTERN.test(emit.via))) {
    errors.push({ path: joinPath(where, "via"), code: "invalid_value", message: "emit.via must name the parameter the value flows through." });
  }
}

function checkFlags(flags, where, errors) {
  if (!Array.isArray(flags) || !flags.length) {
    errors.push({ path: where, code: "invalid_type", message: `${where} must be a non-empty list of {flag, since?, until?}.` });
    return;
  }
  flags.forEach((item, index) => {
    const at = joinPath(where, index);
    if (!isPlainObject(item) || typeof item.flag !== "string" || !FLAG_PATTERN.test(item.flag)) {
      errors.push({ path: at, code: "invalid_flag", message: `${at} must be {flag, since?, until?} with a command-line flag.` });
      return;
    }
    for (const key of ["since", "until"]) {
      if (item[key] !== undefined && !expr.parseVersion(item[key])) errors.push({ path: joinPath(at, key), code: "invalid_value", message: `${joinPath(at, key)} must be a version.` });
    }
    for (const key of Object.keys(item)) {
      if (!["flag", "since", "until"].includes(key)) errors.push({ path: joinPath(at, key), code: "unknown_field", message: `Unknown field ${key}.` });
    }
  });
}

function checkChoices(choices, where, errors) {
  if (!Array.isArray(choices) || !choices.length || choices.length > MAX_CHOICES) {
    errors.push({ path: where, code: "invalid_type", message: `${where} must be a list of 1 to ${MAX_CHOICES} choices.` });
    return;
  }
  const seen = new Set();
  choices.forEach((choice, index) => {
    const at = joinPath(where, index);
    const value = isPlainObject(choice) ? choice.value : choice;
    if (!["string", "number", "boolean"].includes(typeof value)) {
      errors.push({ path: at, code: "invalid_type", message: `${at} must be a scalar or {value, label}.` });
      return;
    }
    if (seen.has(value)) errors.push({ path: at, code: "duplicate_choice", message: `Choice ${value} is listed twice.` });
    seen.add(value);
    if (isPlainObject(choice)) {
      if (choice.label !== undefined) checkI18n(choice.label, joinPath(at, "label"), errors);
      for (const key of Object.keys(choice)) {
        if (key !== "value" && key !== "label") errors.push({ path: joinPath(at, key), code: "unknown_field", message: `Unknown choice field ${key}.` });
      }
    }
  });
}

function checkLegacy(legacy, where, errors) {
  if (legacy === null) return;
  if (!isPlainObject(legacy)) {
    errors.push({ path: where, code: "invalid_type", message: `${where} must be {field, aliases?, domId, codec?, unset?, formDefault?} or null.` });
    return;
  }
  for (const key of Object.keys(legacy)) {
    if (!["field", "aliases", "domId", "codec", "unset", "formDefault"].includes(key)) errors.push({ path: joinPath(where, key), code: "unknown_field", message: `Unknown legacy field ${key}.` });
  }
  if (typeof legacy.field !== "string" || !LEGACY_FIELD_PATTERN.test(legacy.field)) {
    errors.push({ path: joinPath(where, "field"), code: "required", message: "legacy.field must name the legacy body/config field." });
  }
  if (legacy.aliases !== undefined && (!Array.isArray(legacy.aliases) || !legacy.aliases.every((item) => typeof item === "string" && LEGACY_FIELD_PATTERN.test(item)))) {
    errors.push({ path: joinPath(where, "aliases"), code: "invalid_type", message: "legacy.aliases must list field names." });
  }
  if (legacy.domId !== undefined && legacy.domId !== null && (typeof legacy.domId !== "string" || !DOM_ID_PATTERN.test(legacy.domId))) {
    errors.push({ path: joinPath(where, "domId"), code: "invalid_value", message: "legacy.domId must be a DOM id or null." });
  }
  // The legacy spelling of "unset" when it is not an empty string (sglangMaxTotalTokens 0).
  if (legacy.unset !== undefined && legacy.unset !== null && !["string", "number", "boolean"].includes(typeof legacy.unset)) {
    errors.push({ path: joinPath(where, "unset"), code: "invalid_type", message: "legacy.unset must be a scalar." });
  }
  // The decoded value an untouched legacy form sends (the PLE box is checked
  // by default): such a value is not a user choice and never warns.
  if (legacy.formDefault !== undefined && !["string", "number", "boolean"].includes(typeof legacy.formDefault)) {
    errors.push({ path: joinPath(where, "formDefault"), code: "invalid_type", message: "legacy.formDefault must be a scalar." });
  }
  if (legacy.codec !== undefined && !LEGACY_CODECS.includes(legacy.codec)) {
    errors.push({ path: joinPath(where, "codec"), code: "invalid_value", message: `legacy.codec must be one of ${LEGACY_CODECS.join(", ")}.` });
  }
}

/**
 * A complete parameter definition (after a binding merged onto its concept).
 * options: { groups: Set, paramIds: Set }
 */
function validateParam(param, where, options = {}) {
  const errors = [];
  if (!isPlainObject(param)) return [{ path: where, code: "invalid_type", message: `${where} must be an object.` }];
  for (const key of Object.keys(param)) {
    if (!PARAM_FIELDS.has(key) || UNSAFE_KEYS.has(key)) errors.push({ path: joinPath(where, key), code: "unknown_field", message: `Unknown parameter field ${key}.` });
  }
  if (typeof param.id !== "string" || !expr.PARAM_ID_PATTERN.test(param.id)) {
    errors.push({ path: joinPath(where, "id"), code: "invalid_id", message: "A parameter id is dotted camelCase (contextLength, sglang.maxTotalTokens)." });
  }
  if (typeof param.group !== "string" || (options.groups && !options.groups.has(param.group))) {
    errors.push({ path: joinPath(where, "group"), code: "unknown_group", message: `Unknown group ${param.group}.` });
  }
  if (!LEVELS.includes(param.level)) errors.push({ path: joinPath(where, "level"), code: "invalid_value", message: `level must be one of ${LEVELS.join(", ")}.` });
  if (!Number.isInteger(param.order) || param.order < 0 || param.order > 100000) {
    errors.push({ path: joinPath(where, "order"), code: "invalid_value", message: "order must be a non-negative integer." });
  }
  if (!PARAM_TYPES.includes(param.type)) errors.push({ path: joinPath(where, "type"), code: "invalid_value", message: `type must be one of ${PARAM_TYPES.join(", ")}.` });
  if (param.unit !== undefined && param.unit !== null && (typeof param.unit !== "string" || param.unit.length > 32)) {
    errors.push({ path: joinPath(where, "unit"), code: "invalid_value", message: "unit must be short text." });
  }
  checkI18n(param.label, joinPath(where, "label"), errors);
  checkI18n(param.summary, joinPath(where, "summary"), errors);
  if (!isPlainObject(param.help)) {
    errors.push({ path: joinPath(where, "help"), code: "required", message: "help needs what, whenToChange and tradeoffs." });
  } else {
    for (const key of HELP_KEYS) checkI18n(param.help[key], joinPath(where, `help.${key}`), errors);
    for (const key of Object.keys(param.help)) {
      if (!HELP_KEYS.includes(key)) errors.push({ path: joinPath(where, `help.${key}`), code: "unknown_field", message: `Unknown help key ${key}.` });
    }
  }
  if (param.docs !== undefined && param.docs !== null && (typeof param.docs !== "string" || !/^https:\/\/[^\s]{1,500}$/.test(param.docs))) {
    errors.push({ path: joinPath(where, "docs"), code: "invalid_value", message: "docs must be an https URL." });
  }
  if (param.range !== undefined && param.range !== null) {
    const range = param.range;
    const numeric = ["int", "float"].includes(param.type);
    if (!isPlainObject(range) || !numeric) {
      errors.push({ path: joinPath(where, "range"), code: "invalid_type", message: "range is {min?, max?, step?} on int and float parameters." });
    } else {
      for (const key of Object.keys(range)) {
        if (!["min", "max", "step"].includes(key) || !Number.isFinite(range[key])) {
          errors.push({ path: joinPath(where, `range.${key}`), code: "invalid_value", message: `range.${key} must be a finite number.` });
        }
      }
      if (Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > range.max) {
        errors.push({ path: joinPath(where, "range"), code: "invalid_value", message: "range.min is above range.max." });
      }
    }
  }
  if (param.choices !== undefined && param.choices !== null) checkChoices(param.choices, joinPath(where, "choices"), errors);
  if (param.type === "enum" && !param.choices && !param.choicesFrom && !param.pattern) {
    errors.push({ path: joinPath(where, "choices"), code: "required", message: "An enum needs choices, choicesFrom or a pattern." });
  }
  if (param.choicesFrom !== undefined && param.choicesFrom !== null && (typeof param.choicesFrom !== "string" || !CHOICES_FROM_PATTERN.test(param.choicesFrom))) {
    errors.push({ path: joinPath(where, "choicesFrom"), code: "invalid_value", message: "choicesFrom is \"introspect:<flag>\"." });
  }
  if (param.pattern !== undefined && param.pattern !== null) checkPattern(param.pattern, joinPath(where, "pattern"), errors);
  if (param.maxLength !== undefined && (!Number.isInteger(param.maxLength) || param.maxLength < 1 || param.maxLength > 262144)) {
    errors.push({ path: joinPath(where, "maxLength"), code: "invalid_value", message: "maxLength must be a positive integer." });
  }
  checkDefault(param.engineDefault, joinPath(where, "engineDefault"), errors, options.paramIds);
  checkDefault(param.platformDefault, joinPath(where, "platformDefault"), errors, options.paramIds);
  checkEmit(param.emit, joinPath(where, "emit"), errors);
  if (param.flags !== undefined && param.flags !== null) checkFlags(param.flags, joinPath(where, "flags"), errors);
  if (param.vramEffect !== undefined && !VRAM_EFFECTS.includes(param.vramEffect)) {
    errors.push({ path: joinPath(where, "vramEffect"), code: "invalid_value", message: `vramEffect must be one of ${VRAM_EFFECTS.join(", ")}.` });
  }
  if (param.rules !== undefined) {
    if (!Array.isArray(param.rules)) {
      errors.push({ path: joinPath(where, "rules"), code: "invalid_type", message: "rules must be a list." });
    } else {
      param.rules.forEach((rule, index) => {
        const at = joinPath(where, `rules[${index}]`);
        if (!isPlainObject(rule)) {
          errors.push({ path: at, code: "invalid_type", message: `${at} must be {kind, when, code, message}.` });
          return;
        }
        if (!RULE_KINDS.includes(rule.kind)) errors.push({ path: joinPath(at, "kind"), code: "invalid_value", message: `rule kind must be one of ${RULE_KINDS.join(", ")}.` });
        if (typeof rule.code !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(rule.code)) errors.push({ path: joinPath(at, "code"), code: "invalid_value", message: "rule code is snake_case." });
        if (rule.when === undefined) errors.push({ path: joinPath(at, "when"), code: "required", message: "A rule needs a when expression." });
        else checkExpression(rule.when, joinPath(at, "when"), errors, options.paramIds);
        checkI18n(rule.message, joinPath(at, "message"), errors);
        for (const key of Object.keys(rule)) {
          if (!["kind", "when", "code", "message"].includes(key)) errors.push({ path: joinPath(at, key), code: "unknown_field", message: `Unknown rule field ${key}.` });
        }
      });
    }
  }
  for (const key of ["managed", "secret", "fromModel"]) {
    if (param[key] !== undefined && typeof param[key] !== "boolean") errors.push({ path: joinPath(where, key), code: "invalid_type", message: `${key} must be true or false.` });
  }
  if (param.legacy !== undefined) checkLegacy(param.legacy, joinPath(where, "legacy"), errors);
  if (param.appliesWhen !== undefined && param.appliesWhen !== null) checkExpression(param.appliesWhen, joinPath(where, "appliesWhen"), errors, options.paramIds);
  if (param.requiresFeature !== undefined && param.requiresFeature !== null && (typeof param.requiresFeature !== "string" || !FEATURE_PATTERN.test(param.requiresFeature))) {
    errors.push({ path: joinPath(where, "requiresFeature"), code: "invalid_value", message: "requiresFeature names a runtime feature flag." });
  }
  if (param.secret === true && param.type !== "string") {
    errors.push({ path: joinPath(where, "type"), code: "invalid_value", message: "A secret parameter is a string." });
  }
  return errors;
}

function checkFileHeader(file, kind, errors) {
  if (!isPlainObject(file)) {
    errors.push({ path: "", code: "invalid_type", message: "A launch-params file is a JSON object." });
    return false;
  }
  if (file.schemaVersion !== 1) errors.push({ path: "schemaVersion", code: "unsupported_version", message: "schemaVersion must be 1." });
  if (typeof file.asOf !== "string" || !DATE_PATTERN.test(file.asOf)) errors.push({ path: "asOf", code: "invalid_value", message: "asOf is a YYYY-MM-DD date." });
  if (file.staleAfterDays !== undefined && (!Number.isInteger(file.staleAfterDays) || file.staleAfterDays < 1)) {
    errors.push({ path: "staleAfterDays", code: "invalid_value", message: "staleAfterDays is a positive integer." });
  }
  if (file.kind !== kind) errors.push({ path: "kind", code: "invalid_value", message: `kind must be "${kind}".` });
  if (!Array.isArray(file.params)) errors.push({ path: "params", code: "required", message: "params must be a list." });
  return true;
}

function checkGroups(groups, errors) {
  if (!Array.isArray(groups) || !groups.length) {
    errors.push({ path: "groups", code: "required", message: "groups must be a non-empty list." });
    return;
  }
  const seen = new Set();
  groups.forEach((group, index) => {
    const at = `groups[${index}]`;
    if (!isPlainObject(group) || typeof group.id !== "string" || !GROUP_ID_PATTERN.test(group.id)) {
      errors.push({ path: at, code: "invalid_value", message: `${at} needs a kebab-case id.` });
      return;
    }
    if (seen.has(group.id)) errors.push({ path: at, code: "duplicate_group", message: `Group ${group.id} is defined twice.` });
    seen.add(group.id);
    if (!Number.isInteger(group.order)) errors.push({ path: `${at}.order`, code: "invalid_value", message: "A group order is an integer." });
    checkI18n(group.label, `${at}.label`, errors);
    for (const key of Object.keys(group)) {
      if (!["id", "order", "label"].includes(key)) errors.push({ path: `${at}.${key}`, code: "unknown_field", message: `Unknown group field ${key}.` });
    }
  });
}

// ---------------------------------------------------------------------------
// Merging and normalisation
// ---------------------------------------------------------------------------

function mergeParam(base, patch) {
  const merged = clone(base) || {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (MERGED_OBJECT_FIELDS.has(key) && isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = key === "help"
        ? Object.fromEntries([...new Set([...Object.keys(merged.help), ...Object.keys(value)])]
          .map((helpKey) => [helpKey, isPlainObject(value[helpKey]) && isPlainObject(merged.help[helpKey]) ? { ...merged.help[helpKey], ...value[helpKey] } : clone(value[helpKey] ?? merged.help[helpKey])]))
        : { ...merged[key], ...clone(value) };
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function normalizeChoices(choices) {
  if (!Array.isArray(choices)) return null;
  return choices.map((choice) => (isPlainObject(choice) ? { ...choice } : { value: choice }));
}

// Fills the optional fields so every ParamView has the same keys.
function normalizeParam(param, docs) {
  return {
    id: param.id,
    group: param.group,
    level: param.level,
    order: param.order,
    type: param.type,
    unit: param.unit ?? null,
    label: param.label,
    summary: param.summary,
    help: param.help,
    docs: param.docs ?? docs ?? null,
    range: param.range ?? null,
    choices: normalizeChoices(param.choices),
    choicesFrom: param.choicesFrom ?? null,
    pattern: param.pattern ?? null,
    maxLength: param.maxLength ?? null,
    engineDefault: param.engineDefault ?? null,
    platformDefault: param.platformDefault ?? null,
    emit: { omitWhen: [null], transform: null, via: null, ...param.emit },
    flags: param.flags ?? null,
    vramEffect: param.vramEffect ?? "none",
    rules: param.rules ?? [],
    managed: param.managed === true,
    secret: param.secret === true,
    legacy: param.legacy ? { aliases: [], domId: null, codec: "direct", ...param.legacy } : null,
    appliesWhen: param.appliesWhen ?? null,
    fromModel: param.fromModel === true,
    requiresFeature: param.requiresFeature ?? null,
  };
}

// Expressions are compiled once per catalog build: appliesWhen, rule conditions
// and expression defaults.
function compileParam(param) {
  const options = { envAllowlist: [] };
  const compiled = {
    appliesWhen: param.appliesWhen ? expr.compileExpr(param.appliesWhen, options) : null,
    rules: param.rules.map((rule) => ({ rule, when: expr.compileExpr(rule.when, options) })),
    platformDefault: isPlainObject(param.platformDefault) && Object.hasOwn(param.platformDefault, "expr")
      ? expr.compileExpr(param.platformDefault.expr, options)
      : null,
  };
  return compiled;
}

function sortParams(params, groupOrder) {
  return [...params].sort((a, b) => (groupOrder.get(a.group) ?? 1e9) - (groupOrder.get(b.group) ?? 1e9)
    || a.order - b.order
    || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

// fs messages name the absolute path ("EACCES: permission denied, scandir
// '<path>'"); catalog errors reach viewer-readable routes, so they carry the
// error code only. The file stays in the error's own `file` field.
function readProblem(error, what) {
  if (error instanceof SyntaxError) return { code: "invalid_json", message: error.message };
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code) ? ` (${error.code})` : "";
  return { code: "unreadable", message: `The ${what} cannot be read${code}.` };
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { ok: false, error, problem: readProblem(error, "file") };
  }
}

function listJsonFiles(dir) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    return { files, error: null };
  } catch (error) {
    return { files: [], error: error.code === "ENOENT" ? null : error, problem: readProblem(error, "directory") };
  }
}

// ---------------------------------------------------------------------------
// Availability, choices, facts
// ---------------------------------------------------------------------------

function introspectedFlagIndex(introspected) {
  const flags = Array.isArray(introspected?.flags) ? introspected.flags : null;
  if (!flags) return null;
  const index = new Map();
  for (const entry of flags) {
    if (!entry || typeof entry.flag !== "string") continue;
    index.set(entry.flag, entry);
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
      if (typeof alias === "string" && !index.has(alias)) index.set(alias, entry);
    }
  }
  return index;
}

function inVersionWindow(item, compatVersion) {
  const version = expr.parseVersion(compatVersion);
  if (!version) return true;
  const since = item.since !== undefined ? expr.parseVersion(item.since) : null;
  const until = item.until !== undefined ? expr.parseVersion(item.until) : null;
  const compare = (a, b) => {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
    }
    return 0;
  };
  return (!since || compare(version, since) >= 0) && (!until || compare(version, until) <= 0);
}

/** The flag a parameter would use on this runtime (renamed flags choose by introspection, then compatVersion). */
function candidateFlags(param, runtime) {
  if (Array.isArray(param.flags) && param.flags.length) {
    return param.flags.filter((item) => inVersionWindow(item, runtime?.compatVersion)).map((item) => item.flag);
  }
  return [param.emit?.flag, param.emit?.falseFlag].filter(Boolean);
}

const AVAILABILITY_REASONS = Object.freeze({
  noFlag: { zh: "不对应运行时参数，由平台处理", en: "Not a runtime flag; the platform handles it" },
  notIntrospected: { zh: "未验证：尚未检测这个运行时支持的参数", en: "Unverified: this runtime's flags have not been introspected" },
  envUnverified: { zh: "未验证：经环境变量传递，尚未确认运行时读取它", en: "Unverified: passed as an environment variable the runtime is not yet confirmed to read" },
  inRuntime: { zh: "运行时支持这个参数", en: "The runtime supports this flag" },
  notInRuntime: { zh: "本版本不支持：运行时没有这个参数", en: "Not in this runtime: the runtime has no such flag" },
  featureMissing: { zh: "本版本不支持：运行时缺少所需功能", en: "Not in this runtime: the runtime lacks the feature it needs" },
});

/**
 * paramAvailability(param, runtime, introspected) → { state, code?, flag?, reason{zh,en} }
 *   available    the runtime is known to support it (or it is not a runtime flag)
 *   unavailable  the runtime lacks the flag or the feature it needs
 *   unverified   no introspection yet; the flag is allowed
 */
function paramAvailability(param, runtime, introspected) {
  const feature = param.requiresFeature;
  if (feature) {
    const value = runtime?.features?.[feature];
    // A custom image resolves to no manifest entry and assumes no feature (01 §5).
    if (value === false || (runtime?.custom && value !== true)) {
      return { state: "unavailable", code: "feature_not_in_runtime", feature, reason: AVAILABILITY_REASONS.featureMissing };
    }
  }
  const flags = candidateFlags(param, runtime);
  const index = introspectedFlagIndex(introspected);
  if (!flags.length) {
    const renamed = index && Array.isArray(param.flags) ? param.flags.find((item) => index.has(item.flag)) : null;
    if (renamed) return { state: "available", flag: renamed.flag, reason: AVAILABILITY_REASONS.inRuntime };
    if (param.emit?.kind === "env") {
      const confirmed = index && [...index.values()].some((entry) => entry.env === param.emit.env);
      return confirmed
        ? { state: "available", reason: AVAILABILITY_REASONS.inRuntime }
        : { state: "unverified", reason: AVAILABILITY_REASONS.envUnverified };
    }
    if (Array.isArray(param.flags) && param.flags.length) {
      return { state: "unavailable", code: "flag_not_in_runtime", reason: AVAILABILITY_REASONS.notInRuntime };
    }
    return { state: "available", reason: AVAILABILITY_REASONS.noFlag };
  }
  if (!index) return { state: "unverified", flag: flags[0], reason: AVAILABILITY_REASONS.notIntrospected };
  const hit = flags.find((flag) => index.has(flag));
  if (hit) return { state: "available", flag: hit, reason: AVAILABILITY_REASONS.inRuntime };
  // With introspection a renamed flag is chosen by presence, whatever the version window said.
  const renamed = Array.isArray(param.flags) ? param.flags.map((item) => item.flag).find((flag) => index.has(flag)) : null;
  if (renamed) return { state: "available", flag: renamed, reason: AVAILABILITY_REASONS.inRuntime };
  return { state: "unavailable", code: "flag_not_in_runtime", flag: flags[0], reason: AVAILABILITY_REASONS.notInRuntime };
}

/** Static choices, or the introspected ones when the catalog says choicesFrom and the runtime reported them. */
function effectiveChoices(param, introspected) {
  const staticChoices = param.choices;
  const match = typeof param.choicesFrom === "string" ? /^introspect:(.+)$/.exec(param.choicesFrom) : null;
  const index = match ? introspectedFlagIndex(introspected) : null;
  const entry = index ? index.get(match[1]) : null;
  if (!entry || !Array.isArray(entry.choices) || !entry.choices.length) return clone(staticChoices);
  const labels = new Map((staticChoices || []).map((choice) => [choice.value, choice.label]));
  const values = entry.choices.filter((value) => ["string", "number", "boolean"].includes(typeof value));
  // Platform-only values (auto, none) keep their place: they are not engine flags.
  const platformValues = (staticChoices || []).filter((choice) => ["auto", "none"].includes(choice.value) && !values.includes(choice.value));
  return [
    ...platformValues.map((choice) => clone(choice)),
    ...values.map((value) => (labels.get(value) ? { value, label: clone(labels.get(value)) } : { value })),
  ];
}

function computeCapNumber(value) {
  const number = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Host facts from a GPU probe. gpus null means the probe failed (facts unknown);
 * an empty list means no NVIDIA GPU. SM12x matches the legacy hasSm12Gpu rule.
 */
function hostFactsFromGpus(gpus, platform = process.platform) {
  if (!Array.isArray(gpus)) return { platform, anySm12x: null, maxComputeCap: null };
  let anySm12x = false;
  let maxComputeCap = null;
  for (const gpu of gpus) {
    const raw = String(gpu?.computeCap ?? gpu?.compute_cap ?? "").trim();
    const name = String(gpu?.name || "").toLowerCase();
    if (raw.startsWith("12") || (name.includes("blackwell") && /rtx\s+pro\s+[56]000/.test(name))) anySm12x = true;
    const cap = computeCapNumber(raw);
    if (cap !== null && (maxComputeCap === null || cap > maxComputeCap)) maxComputeCap = cap;
  }
  return { platform, anySm12x, maxComputeCap };
}

/**
 * The fact map an expression reads (01 §10.2), with null for every fact that
 * is not known. factNames adds facts the catalog reads beyond the standard set
 * (runtime.features.<k>).
 */
function buildFacts({ host = null, model = null, runtime = null, instanceMode = null, factNames = [] } = {}) {
  const architectures = Array.isArray(model?.architectures) ? model.architectures.map(String) : null;
  const facts = {
    "host.platform": host?.platform ?? null,
    "host.anySm12x": typeof host?.anySm12x === "boolean" ? host.anySm12x : null,
    "host.maxComputeCap": Number.isFinite(host?.maxComputeCap) ? host.maxComputeCap : null,
    "model.capabilityId": model?.capabilityId || null,
    "model.familyId": model?.familyId || null,
    "model.quantMethod": model?.quantMethod || null,
    "model.architectures": architectures && architectures.length ? architectures : null,
    "model.nativeMtp.supported": typeof model?.nativeMtp?.supported === "boolean" ? model.nativeMtp.supported : null,
    "runtime.id": runtime?.runtimeId || null,
    "runtime.compatVersion": runtime?.compatVersion || null,
    "instance.mode": INSTANCE_MODES.includes(instanceMode) ? instanceMode : null,
  };
  const features = isPlainObject(runtime?.features) ? runtime.features : {};
  for (const [key, value] of Object.entries(features)) {
    if (FEATURE_PATTERN.test(key)) facts[`${expr.FEATURE_FACT_PREFIX}${key}`] = typeof value === "boolean" ? value : null;
  }
  for (const name of factNames) {
    if (expr.isFactName(name) && !Object.hasOwn(facts, name)) {
      // A custom image assumes no feature; a manifest runtime that does not list it is unknown.
      facts[name] = name.startsWith(expr.FEATURE_FACT_PREFIX) && runtime?.custom ? false : null;
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function unwrapValue(entry) {
  if (isPlainObject(entry) && Object.hasOwn(entry, "value") && (Object.keys(entry).length === 1 || Object.hasOwn(entry, "source"))) return entry.value;
  return entry;
}

function fieldError(field, code, zh, en, extra = {}) {
  return { field, code, message: bilingual(zh, en), ...extra };
}

/**
 * A legacy value the user did not really choose: unset, omitted from argv,
 * the platform or engine default, what the untouched legacy form sends
 * (legacy.formDefault), or an unchecked box. The old forms send every field
 * for every engine, so such a value never warns when an engine ignores it or
 * when it has no effect with the current settings.
 */
function isQuietLegacyValue(param, value) {
  if (value === null || value === undefined) return true;
  if ((param.emit?.omitWhen || []).some((item) => item === value)) return true;
  for (const fallback of [param.platformDefault, param.engineDefault, param.legacy?.formDefault]) {
    if (fallback !== null && fallback !== undefined && !isPlainObject(fallback) && fallback === value) return true;
  }
  return (param.type === "bool" || param.type === "tristate") && value === false && param.platformDefault !== true;
}

function choiceValues(choices) {
  return (choices || []).map((choice) => choice.value);
}

function checkType(param, value) {
  switch (param.type) {
    case "int":
      return Number.isInteger(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
    case "tristate":
      return typeof value === "boolean";
    case "enum":
      return ["string", "number", "boolean"].includes(typeof value);
    case "string":
    case "path":
      return typeof value === "string" && !/[\u0000\r\n]/.test(value);
    case "json":
      return Array.isArray(value) || isPlainObject(value);
    case "list":
      return Array.isArray(value);
    case "kv":
      return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
    default:
      return false;
  }
}

function serializedLength(value) {
  try {
    return typeof value === "string" ? value.length : JSON.stringify(value).length;
  } catch {
    return Infinity;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * createParamCatalog({ bundledDir?, overrideDir? }) → loader with loadCatalog(),
 * errors(), status(), reload(). Catalogs are cached per engine until reload().
 */
function createParamCatalog(options = {}) {
  const bundledDir = options.bundledDir || BUNDLED_PARAMS_DIR;
  const overrideDir = options.overrideDir || path.join(userDataDir(), "launch-params");
  let state = null;

  function load() {
    const errors = [];
    const files = [];
    const report = (item) => errors.push(item);

    // Bundled common file: groups and concepts.
    const commonPath = path.join(bundledDir, COMMON_FILE);
    let common = { asOf: "", groups: [], params: new Map(), staleAfterDays: null };
    const commonRead = readJsonFile(commonPath);
    if (!commonRead.ok) {
      report({ source: "bundled", file: commonPath, engineId: "", path: "", ...commonRead.problem });
    } else {
      const headerErrors = [];
      checkFileHeader(commonRead.value, "common", headerErrors);
      checkGroups(commonRead.value.groups, headerErrors);
      if (headerErrors.length) {
        errors.push(...headerErrors.map((item) => ({ source: "bundled", file: commonPath, engineId: "", ...item })));
      } else {
        common = {
          asOf: commonRead.value.asOf,
          staleAfterDays: commonRead.value.staleAfterDays ?? null,
          groups: commonRead.value.groups.map((group) => clone(group)),
          params: new Map(),
        };
        for (const [index, param] of commonRead.value.params.entries()) {
          const id = typeof param?.id === "string" ? param.id : "";
          if (common.params.has(id)) {
            report({ source: "bundled", file: commonPath, engineId: "", path: `params[${index}].id`, code: "duplicate_param", message: `Parameter ${id} is defined twice.` });
            continue;
          }
          common.params.set(id, clone(param));
        }
      }
      files.push({ file: commonPath, source: "bundled", kind: "common", asOf: commonRead.value?.asOf || "" });
    }

    // Bundled engine files: bindings and engine parameters.
    const engines = new Map();
    const bundled = listJsonFiles(bundledDir);
    if (bundled.error) report({ source: "bundled", file: bundledDir, engineId: "", path: "", ...bundled.problem });
    for (const file of bundled.files) {
      if (path.basename(file) === COMMON_FILE) continue;
      const read = readJsonFile(file);
      if (!read.ok) {
        report({ source: "bundled", file, engineId: "", path: "", ...read.problem });
        continue;
      }
      const headerErrors = [];
      checkFileHeader(read.value, "engine", headerErrors);
      const engineId = typeof read.value?.engineId === "string" ? read.value.engineId : "";
      if (!ENGINE_ID_PATTERN.test(engineId)) headerErrors.push({ path: "engineId", code: "invalid_value", message: "engineId must be a registered engine id." });
      if (engines.has(engineId)) headerErrors.push({ path: "engineId", code: "duplicate_engine", message: `Engine ${engineId} has two catalogs.` });
      if (headerErrors.length) {
        errors.push(...headerErrors.map((item) => ({ source: "bundled", file, engineId, ...item })));
        continue;
      }
      engines.set(engineId, {
        engineId,
        asOf: read.value.asOf,
        staleAfterDays: read.value.staleAfterDays ?? null,
        docs: typeof read.value.docs === "string" ? read.value.docs : null,
        file,
        entries: read.value.params.map((entry) => clone(entry)),
        legacyIgnored: Array.isArray(read.value.legacyIgnored) ? clone(read.value.legacyIgnored) : [],
        overrides: [],
      });
      files.push({ file, source: "bundled", kind: "engine", engineId, asOf: read.value.asOf });
    }

    // Overrides: {kind:"common"|"engine", engineId?, params:[partial or new]} merged by id.
    const commonOverrides = [];
    const overrideFiles = listJsonFiles(overrideDir);
    if (overrideFiles.error) report({ source: "override", file: overrideDir, engineId: "", path: "", ...overrideFiles.problem });
    for (const file of overrideFiles.files) {
      const read = readJsonFile(file);
      if (!read.ok) {
        report({ source: "override", file, engineId: "", path: "", ...read.problem });
        continue;
      }
      const value = read.value;
      const kind = value?.kind;
      const headerErrors = [];
      if (!isPlainObject(value) || !Array.isArray(value.params)) headerErrors.push({ path: "params", code: "required", message: "An override file has a params list." });
      if (kind !== "common" && kind !== "engine") headerErrors.push({ path: "kind", code: "invalid_value", message: "kind must be \"common\" or \"engine\"." });
      if (kind === "engine" && !engines.has(value?.engineId)) headerErrors.push({ path: "engineId", code: "unknown_engine", message: `No bundled catalog for engine ${String(value?.engineId || "").slice(0, 32)}.` });
      if (headerErrors.length) {
        errors.push(...headerErrors.map((item) => ({ source: "override", file, engineId: value?.engineId || "", ...item })));
        continue;
      }
      files.push({ file, source: "override", kind, engineId: kind === "engine" ? value.engineId : "", asOf: value.asOf || "" });
      const target = kind === "common" ? commonOverrides : engines.get(value.engineId).overrides;
      value.params.forEach((entry, index) => target.push({ file, index, entry: clone(entry) }));
    }

    // Common overrides apply to the concepts before any engine binds them.
    const groupIds = new Set(common.groups.map((group) => group.id));
    for (const { file, index, entry } of commonOverrides) {
      const where = { source: "override", file, engineId: "", path: `params[${index}]` };
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (!common.params.has(id)) {
        report({ ...where, code: "unknown_param", message: `Common overrides can only change existing concepts; ${id || "(no id)"} is not one.` });
        continue;
      }
      const locked = Object.keys(entry || {}).find((key) => OVERRIDE_LOCKED_FIELDS.has(key));
      if (locked) {
        report({ ...where, code: "override_locked_field", message: `${locked} cannot be changed by an override.` });
        continue;
      }
      common.params.set(id, mergeParam(common.params.get(id), entry));
    }

    state = { common, engines, errors, files, groupIds, catalogs: new Map(), loadedAt: new Date().toISOString() };
    return state;
  }

  function current() {
    return state || load();
  }

  // Every param id some catalog defines: the concepts plus each engine's own
  // params. An id this engine does not bind is "not applicable" here (01
  // §9.3), never an unknown parameter.
  function knownParamIds(snapshot) {
    const ids = new Set(snapshot.common.params.keys());
    for (const engine of snapshot.engines.values()) {
      for (const entry of [...engine.entries, ...engine.overrides.map((item) => item.entry)]) {
        if (typeof entry?.id === "string" && expr.PARAM_ID_PATTERN.test(entry.id)) ids.add(entry.id);
      }
    }
    return ids;
  }

  // The merged, validated, frozen catalog of one engine (no runtime applied).
  function buildBase(engineId) {
    const snapshot = current();
    const { common, groupIds } = snapshot;
    const engine = snapshot.engines.get(engineId);
    const errors = [];
    const groups = [...common.groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const groupOrder = new Map(groups.map((group) => [group.id, group.order]));
    const allIds = knownParamIds(snapshot);
    if (!engine) {
      return finalizeCatalog({
        engineId,
        catalogVersion: common.asOf ? `+${common.asOf}` : "",
        groups,
        params: [],
        notApplicable: [...allIds].sort(),
        legacyIgnored: [],
        errors: [{ source: "registry", engineId, path: "", code: "catalog_missing", message: `Engine ${engineId} has no parameter catalog.` }],
      });
    }

    const params = new Map();
    const ownIds = new Set();
    // Every id the catalog may reference: the engine's params plus the concepts
    // (an expression may read a concept the engine does not bind; it reads null).
    const knownIds = new Set([...common.params.keys(), ...engine.entries.map((entry) => entry?.id).filter((id) => typeof id === "string")]);
    for (const { entry } of engine.overrides) if (typeof entry?.id === "string") knownIds.add(entry.id);

    engine.entries.forEach((entry, index) => {
      const where = { source: "bundled", file: engine.file, engineId, path: `params[${index}]` };
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (ownIds.has(id)) {
        errors.push({ ...where, code: "duplicate_param", message: `Parameter ${id} is listed twice.` });
        return;
      }
      ownIds.add(id);
      const merged = common.params.has(id) ? mergeParam(common.params.get(id), entry) : clone(entry);
      const problems = validateParam(merged, `params[${index}]`, { groups: groupIds, paramIds: knownIds });
      if (problems.length) {
        errors.push(...problems.map((item) => ({ ...where, ...item })));
        return;
      }
      params.set(id, merged);
    });

    for (const { file, index, entry } of engine.overrides) {
      const where = { source: "override", file, engineId, path: `params[${index}]` };
      const id = typeof entry?.id === "string" ? entry.id : "";
      const locked = params.has(id) ? Object.keys(entry || {}).find((key) => OVERRIDE_LOCKED_FIELDS.has(key)) : null;
      if (locked) {
        errors.push({ ...where, code: "override_locked_field", message: `${locked} cannot be changed by an override.` });
        continue;
      }
      const base = params.get(id) || common.params.get(id) || null;
      const merged = base ? mergeParam(base, entry) : clone(entry);
      const problems = validateParam(merged, `params[${index}]`, { groups: groupIds, paramIds: knownIds });
      if (problems.length) {
        // The bundled definition (or no definition) stays in force.
        errors.push(...problems.map((item) => ({ ...where, ...item })));
        continue;
      }
      params.set(id, merged);
    }

    const normalized = sortParams([...params.values()].map((param) => normalizeParam(param, engine.docs)), groupOrder);
    // domIds are DOM hooks in one manager UI: unique within a catalog.
    const domIds = new Map();
    for (const param of normalized) {
      const domId = param.legacy?.domId;
      if (!domId) continue;
      if (domIds.has(domId)) errors.push({ source: "catalog", engineId, path: `${param.id}.legacy.domId`, code: "duplicate_dom_id", message: `domId ${domId} is used by ${domIds.get(domId)} and ${param.id}.` });
      else domIds.set(domId, param.id);
    }
    // Legacy form fields the engine never used: accepted with a warning (01 §9.3).
    const legacyIgnored = engine.legacyIgnored.filter((item, index) => {
      const where = `legacyIgnored[${index}]`;
      const problems = [];
      if (!isPlainObject(item) || typeof item.field !== "string" || !LEGACY_FIELD_PATTERN.test(item.field)) {
        problems.push({ path: where, code: "invalid_value", message: `${where} needs a legacy field name.` });
      } else {
        if (item.domId !== undefined && item.domId !== null && !DOM_ID_PATTERN.test(String(item.domId))) {
          problems.push({ path: `${where}.domId`, code: "invalid_value", message: `${where}.domId must be a DOM id or null.` });
        }
        if (item.code !== undefined && !/^[a-z][a-z0-9_]{1,63}$/.test(String(item.code))) {
          problems.push({ path: `${where}.code`, code: "invalid_value", message: `${where}.code is snake_case.` });
        }
        checkI18n(item.reason, `${where}.reason`, problems);
      }
      errors.push(...problems.map((problem) => ({ source: "bundled", file: engine.file, engineId, ...problem })));
      return problems.length === 0;
    }).map((item) => ({ field: item.field, domId: item.domId ?? null, code: item.code || "param_ignored", reason: item.reason }));

    return finalizeCatalog({
      engineId,
      catalogVersion: `${engine.asOf}+${common.asOf}`,
      groups,
      params: normalized,
      notApplicable: [...allIds].filter((id) => !params.has(id)).sort(),
      legacyIgnored,
      errors,
    });
  }

  function finalizeCatalog(catalog) {
    const byLegacyField = {};
    for (const param of catalog.params) {
      if (!param.legacy) continue;
      for (const field of [param.legacy.field, ...param.legacy.aliases]) {
        (byLegacyField[field] ||= []).push(param.id);
      }
    }
    const compiled = new Map(catalog.params.map((param) => [param.id, compileParam(param)]));
    // Every fact the catalog reads: expressions, plus the runtime features
    // that gate params, so the schema's facts say which ones the runtime has.
    const factNames = new Set();
    for (const entry of compiled.values()) {
      for (const item of [entry.appliesWhen, entry.platformDefault, ...entry.rules.map((rule) => rule.when)]) {
        for (const name of item?.refs?.facts || []) factNames.add(name);
      }
    }
    for (const param of catalog.params) {
      if (param.requiresFeature) factNames.add(`${expr.FEATURE_FACT_PREFIX}${param.requiresFeature}`);
    }
    const base = {
      engineId: catalog.engineId,
      catalogVersion: catalog.catalogVersion,
      groups: catalog.groups,
      params: catalog.params,
      byLegacyField,
      notApplicable: catalog.notApplicable,
      legacyIgnored: catalog.legacyIgnored,
      factNames: [...factNames].sort(),
      errors: catalog.errors,
    };
    // Compiled expressions ride along non-enumerable, so payloads never carry them.
    Object.defineProperty(base, "compiled", { value: compiled, enumerable: false });
    return deepFreeze(base);
  }

  function baseCatalog(engineId) {
    const id = String(engineId || "");
    const snapshot = current();
    if (!snapshot.catalogs.has(id)) snapshot.catalogs.set(id, buildBase(id));
    return snapshot.catalogs.get(id);
  }

  /**
   * loadCatalog(engineId, { runtime, introspected }) →
   *   { engineId, catalogVersion, groups, params, byId, byLegacyField, notApplicable,
   *     legacyIgnored, factNames, errors }
   * params carry availability and effective choices for the runtime.
   */
  function loadCatalog(engineId, loadOptions = {}) {
    const base = baseCatalog(engineId);
    const { runtime = null, introspected = null } = loadOptions;
    const params = base.params.map((param) => {
      const availability = paramAvailability(param, runtime, introspected);
      const choiceFlag = param.choicesFrom?.slice("introspect:".length);
      const runtimeChoices = choiceFlag ? introspectedFlagIndex(introspected)?.get(choiceFlag)?.choices : null;
      return Object.freeze({
        ...param,
        choices: effectiveChoices(param, introspected),
        // An enum becomes closed once the runtime gives its actual choices.
        // A permissive fallback pattern must not admit flags it cannot accept.
        pattern: param.type === "enum" && runtimeChoices?.length ? null : param.pattern,
        availability,
        flag: availability.flag || param.emit.flag || param.emit.falseFlag || null,
      });
    });
    const catalog = {
      engineId: base.engineId,
      catalogVersion: base.catalogVersion,
      groups: base.groups,
      params,
      byId: new Map(params.map((param) => [param.id, param])),
      byLegacyField: base.byLegacyField,
      notApplicable: base.notApplicable,
      legacyIgnored: base.legacyIgnored,
      factNames: base.factNames,
      errors: [...current().errors.filter((item) => !item.engineId || item.engineId === base.engineId), ...base.errors],
    };
    Object.defineProperty(catalog, "compiled", { value: base.compiled, enumerable: false });
    return catalog;
  }

  function engineIds() {
    return [...current().engines.keys()].sort();
  }

  function errors() {
    const snapshot = current();
    return [...snapshot.errors, ...engineIds().flatMap((engineId) => baseCatalog(engineId).errors)];
  }

  function status() {
    const snapshot = current();
    const all = errors();
    return {
      ok: all.length === 0,
      loadedAt: snapshot.loadedAt,
      bundledDir,
      overrideDir,
      engines: engineIds(),
      files: snapshot.files,
      errors: all,
    };
  }

  return {
    bundledDir,
    overrideDir,
    engineIds,
    errors,
    loadCatalog,
    reload: () => {
      load();
      return status();
    },
    status,
  };
}

let defaultCatalog = null;

/** Process-wide loader over the bundled data and <AI_ROOT>/config/launch-params. */
function getParamCatalog() {
  if (!defaultCatalog) defaultCatalog = createParamCatalog();
  return defaultCatalog;
}

function clearParamCatalogCache() {
  defaultCatalog = null;
}

/** loadCatalog through the process-wide loader (01 §9.1). */
function loadCatalog(engineId, options = {}) {
  return getParamCatalog().loadCatalog(engineId, options);
}

function compiledFor(catalog, id) {
  return catalog.compiled?.get(id) || compileParam(catalog.byId.get(id));
}

/**
 * The platform default of a parameter for these facts: a literal, or the value
 * of its {"expr": …} (null when the expression reads an unknown fact).
 */
function platformDefaultValue(param, catalog, { facts = {}, param: readParam = () => null } = {}) {
  const value = param.platformDefault;
  if (!(isPlainObject(value) && Object.hasOwn(value, "expr"))) return value ?? null;
  const compiled = catalog ? compiledFor(catalog, param.id).platformDefault : expr.compileExpr(value.expr, { envAllowlist: [] });
  if (!compiled?.ok) return null;
  const result = compiled.run({ param: readParam, user: () => null, fact: facts });
  return result === expr.UNKNOWN ? null : result;
}

/**
 * validateValues(values, catalog, ctx) → { errors: FieldError[], warnings: FieldError[] }
 *
 * values: { paramId: value | { value, source } }. ctx: { facts, legacy }. A
 * legacy body turns not-applicable, managed and not-in-runtime values into
 * warnings (they are ignored, as today) and keeps quiet about form defaults
 * that have no effect; a v2 request gets errors. A secret param in values is
 * always an error (secret_in_values): it belongs in the request's apiKey.
 */
function validateValues(values, catalog, ctx = {}) {
  const errors = [];
  const warnings = [];
  const facts = ctx.facts || {};
  const legacy = ctx.legacy === true;
  const soft = (item) => (legacy ? warnings : errors).push(item);
  const supplied = new Map();
  if (!isPlainObject(values)) {
    errors.push(fieldError("values", "invalid_type", "参数值必须是对象", "values must be an object"));
    return { errors, warnings };
  }

  for (const [id, entry] of Object.entries(values)) {
    const value = unwrapValue(entry);
    const param = catalog.byId.get(id);
    if (!param) {
      if (catalog.notApplicable.includes(id)) {
        soft(fieldError(id, "param_not_applicable", `${catalog.engineId} 不使用“${id}”，已忽略`, `${catalog.engineId} does not use "${id}"; ignored`));
      } else {
        errors.push(fieldError(id, "unknown_param", `未知参数“${id}”`, `Unknown parameter "${id}"`));
      }
      continue;
    }
    if (value === null || value === undefined) continue;
    const label = param.label;
    // A key travels as the request's own apiKey field (01 §11): values are
    // echoed in plans and kept in the launch store. The value is never quoted.
    if (param.secret) {
      errors.push(fieldError(id, "secret_in_values",
        `“${label.zh}”是密钥，不能放在参数值里；请用请求的 ${id} 字段传递`,
        `"${label.en}" is a secret and cannot be sent in values; send it as the request's ${id} field`,
        { use: id }));
      continue;
    }
    if (param.managed) {
      soft(fieldError(id, "param_managed", `“${label.zh}”由平台管理，不能修改`, `"${label.en}" is managed by the platform and cannot be set`));
      continue;
    }
    if (!checkType(param, value)) {
      errors.push(fieldError(id, "invalid_type", `“${label.zh}”的值类型不对（需要 ${param.type}）`, `"${label.en}" needs a ${param.type} value`));
      continue;
    }
    if (param.maxLength && serializedLength(value) > param.maxLength) {
      errors.push(fieldError(id, "too_long", `“${label.zh}”最长 ${param.maxLength} 个字符`, `"${label.en}" may be at most ${param.maxLength} characters`));
      continue;
    }
    if (["string", "path"].includes(param.type) && value.length > MAX_STRING_VALUE && !param.maxLength) {
      errors.push(fieldError(id, "too_long", `“${label.zh}”过长`, `"${label.en}" is too long`));
      continue;
    }
    if (param.type === "enum" || (param.pattern && ["string", "path"].includes(param.type))) {
      const allowed = choiceValues(param.choices);
      const inChoices = param.type === "enum" && allowed.includes(value);
      const matchesPattern = param.pattern ? new RegExp(param.pattern).test(String(value)) : false;
      if (!inChoices && !matchesPattern) {
        const list = allowed.length ? allowed.join(", ") : param.pattern;
        errors.push(fieldError(id, "invalid_choice", `“${label.zh}”不能是 ${value}；可选：${list}`, `"${label.en}" cannot be ${value}; choose one of: ${list}`));
        continue;
      }
    }
    if (param.range && typeof value === "number") {
      const { min, max } = param.range;
      if ((Number.isFinite(min) && value < min) || (Number.isFinite(max) && value > max)) {
        const clamped = Math.min(Number.isFinite(max) ? max : value, Math.max(Number.isFinite(min) ? min : value, value));
        errors.push(fieldError(id, "out_of_range",
          `“${label.zh}”须在 ${min ?? "-∞"} 到 ${max ?? "∞"} 之间`,
          `"${label.en}" must be between ${min ?? "-∞"} and ${max ?? "∞"}`,
          { suggestion: { value: clamped, why: bilingual("取允许范围内最接近的值", "the nearest allowed value") } }));
        continue;
      }
    }
    if (param.availability?.state === "unavailable") {
      soft(fieldError(id, "flag_not_in_runtime", `当前运行时不支持 ${param.flag || label.zh}`, `This runtime does not support ${param.flag || label.en}`));
      continue;
    }
    supplied.set(id, value);
  }

  // Rules and appliesWhen read the supplied values over the platform defaults.
  const defaultsInProgress = new Set();
  function effective(id) {
    if (supplied.has(id)) return supplied.get(id);
    const param = catalog.byId.get(id);
    if (!param || defaultsInProgress.has(id)) return null;
    defaultsInProgress.add(id);
    try {
      return platformDefaultValue(param, catalog, { facts, param: effective });
    } finally {
      defaultsInProgress.delete(id);
    }
  }
  const exprCtx = { param: effective, user: (id) => (supplied.has(id) ? supplied.get(id) : null), fact: facts };

  for (const param of catalog.params) {
    const compiled = compiledFor(catalog, param.id);
    const isSet = supplied.has(param.id);
    // A legacy body repeats the form's defaults for fields the settings make
    // irrelevant (one draft token with speculation off); only a changed value
    // is worth an "inactive" note.
    const quiet = legacy && isSet && isQuietLegacyValue(param, supplied.get(param.id));
    if (isSet && !quiet && compiled.appliesWhen?.ok && compiled.appliesWhen.run(exprCtx) === false) {
      warnings.push(fieldError(param.id, "param_inactive", `“${param.label.zh}”在当前设置下不起作用`, `"${param.label.en}" has no effect with the current settings`));
    }
    for (const { rule, when } of compiled.rules) {
      if (!when.ok) continue;
      const result = when.run(exprCtx);
      const fire = rule.kind === "errorIf" || rule.kind === "warnIf" || rule.kind === "conflicts"
        ? result === true && (rule.kind !== "conflicts" || isSet)
        : isSet && result === false;
      if (!fire) continue;
      const item = fieldError(param.id, rule.code, rule.message.zh, rule.message.en);
      (rule.kind === "warnIf" ? warnings : errors).push(item);
    }
  }
  return { errors, warnings };
}

/**
 * The GET /api/engines/:engineId/schema body (01 §21.1) from a loaded catalog.
 * ParamView = the §9.2 param + availability + effective choices + the flag in
 * use + the platform default evaluated for these facts.
 */
function buildSchemaPayload({ catalog, runtime = null, introspection = null, facts = {}, recipes = [], scenarios = [] } = {}) {
  const params = catalog.params.map((param) => ({
    ...clone(param),
    platformDefaultValue: platformDefaultValue(param, catalog, { facts }),
  }));
  // Only the groups this engine fills; the console renders them in order.
  const usedGroups = new Set(params.map((param) => param.group));
  return {
    ok: true,
    engineId: catalog.engineId,
    catalogVersion: catalog.catalogVersion,
    runtime: runtime
      ? {
        runtimeId: runtime.runtimeId,
        manifestKey: runtime.manifestKey ?? null,
        image: runtime.image ?? null,
        status: runtime.status ?? null,
        features: clone(runtime.features || {}),
        introspected: Boolean(introspection),
        introspectedAt: introspection?.capturedAt || null,
        flagCount: Array.isArray(introspection?.flags) ? introspection.flags.length : null,
      }
      : null,
    facts,
    groups: clone(catalog.groups.filter((group) => usedGroups.has(group.id))),
    params,
    notApplicable: [...catalog.notApplicable],
    legacyIgnored: clone(catalog.legacyIgnored),
    recipes,
    scenarios,
    errors: catalog.errors.map(({ file: _file, ...item }) => item),
  };
}

module.exports = {
  AVAILABILITY_REASONS,
  BUNDLED_PARAMS_DIR,
  EMIT_KINDS,
  EMIT_MODES,
  LEGACY_CODECS,
  LEVELS,
  PARAM_TYPES,
  RULE_KINDS,
  TRANSFORMS,
  VRAM_EFFECTS,
  buildFacts,
  buildSchemaPayload,
  candidateFlags,
  clearParamCatalogCache,
  createParamCatalog,
  effectiveChoices,
  getParamCatalog,
  hostFactsFromGpus,
  introspectedFlagIndex,
  isQuietLegacyValue,
  loadCatalog,
  mergeParam,
  paramAvailability,
  platformDefaultValue,
  validateParam,
  validateValues,
};
