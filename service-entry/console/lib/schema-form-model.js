// SchemaForm model (07 section 4.5): the pure half of the form that renders
// 01's parameter catalog. buildFormModel turns a schema response (the
// catalog), an optional launch plan and the user's explicit values into
// groups of FieldModels; components/schema-form.js only draws them. Nothing
// here touches the DOM, so goldens pin the behaviour under node --test.
//
// Inputs
//   catalog  GET /api/engines/:engineId/schema: { engineId, groups, params,
//            notApplicable, facts }. `facts` is optional; without a fact the
//            expression evaluator answers UNKNOWN and appliesWhen fails open.
//   plan     a LaunchPlan (or, in config mode, an object of the same shape):
//            { values: { id: { value, source, reason } }, recipe: { locks },
//            errors, warnings }. The plan is the authority; the form never
//            decides what the engine will do.
//   values   the user's explicit values { id: value }. Absent or null is
//            unset. { value, source: "planner" } marks a planner suggestion
//            the user accepted. A secret's value is never echoed: the model
//            reports only its state (unchanged, pending, clear).
//
// A suggestion never changes values by itself. applySuggestion returns the
// new values for the click that accepts it.

import { compileExpr, UNKNOWN } from "./expr.js";

export const LEVELS = Object.freeze(["basic", "advanced", "expert"]);
export const MODES = Object.freeze(["launch", "config", "catalog"]);
export const WIDGETS = Object.freeze(["number", "segmented", "select", "switch", "text", "path", "json", "tokens", "rows", "tristate", "kv", "secret"]);
export const FIELD_SOURCES = Object.freeze(["user", "planner", "recipe", "model", "knowledge", "engine-default", "platform-default"]);

const LEVEL_RANK = Object.freeze({ basic: 0, advanced: 1, expert: 2 });
const SEGMENTED_MAX = 5;
const HAN = /\p{Script=Han}/u;
const BILINGUAL_SEPARATOR = " / ";
const compiledCache = new WeakMap();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSet(value) {
  return value !== undefined && value !== null;
}

function shortLocale(locale) {
  return String(locale || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * Text for one locale from backend copy: a string, a { zh, en } object, or the
 * "zh / en" form some server messages use.
 */
export function pickText(text, locale = "zh-CN") {
  const lang = shortLocale(locale);
  if (typeof text === "string") {
    const at = text.indexOf(BILINGUAL_SEPARATOR);
    if (at > 0 && HAN.test(text.slice(0, at)) && !HAN.test(text.slice(at + BILINGUAL_SEPARATOR.length))) {
      return lang === "zh" ? text.slice(0, at) : text.slice(at + BILINGUAL_SEPARATOR.length);
    }
    return text;
  }
  if (!isPlainObject(text)) return "";
  const mine = text[lang] ?? text[lang === "zh" ? "zh-CN" : "en-US"];
  if (typeof mine === "string" && mine) return mine;
  const other = text[lang === "zh" ? "en" : "zh"] ?? text[lang === "zh" ? "en-US" : "zh-CN"];
  return typeof other === "string" ? other : "";
}

function fold(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase();
}

export function levelRank(level) {
  return Object.hasOwn(LEVEL_RANK, level) ? LEVEL_RANK[level] : 0;
}

/** The control a parameter renders with (07 section 4.5 widget table). */
export function widgetFor(param) {
  if (param?.secret) return "secret";
  switch (param?.type) {
    case "tristate": return "tristate";
    case "kv": return "kv";
    case "list": return isPlainObject(param.item?.fields) ? "rows" : "tokens";
    case "int":
    case "float": return "number";
    case "bool": return "switch";
    case "json": return "json";
    case "path": return "path";
    case "enum": {
      const count = Array.isArray(param.choices) ? param.choices.length : 0;
      if (!count) return "text";
      return count <= SEGMENTED_MAX ? "segmented" : "select";
    }
    default: return "text";
  }
}

function normalizeChoices(param, locale) {
  if (!Array.isArray(param.choices) || !param.choices.length) return null;
  return param.choices.map((choice) => {
    if (!isPlainObject(choice)) return { value: choice, label: String(choice) };
    return { value: choice.value, label: pickText(choice.label, locale) || String(choice.value) };
  });
}

function flagOf(param) {
  return param.availability?.flag || param.flag || param.emit?.flag || param.flags?.[0]?.flag || null;
}

function domIdOf(param) {
  const legacy = param.legacy?.domId;
  if (typeof legacy === "string" && legacy) return legacy;
  return `sf-${String(param.id).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** Deep equality for JSON values (key order matters, as it does in the plan hash). */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** { value, source } for a values entry, unwrapping { value, source: "planner" }. */
function readUserEntry(raw) {
  if (raw === undefined || raw === null) return { value: null, source: "user" };
  if (isPlainObject(raw) && Object.keys(raw).length === 2 && "value" in raw && typeof raw.source === "string" && FIELD_SOURCES.includes(raw.source)) {
    return { value: raw.value ?? null, source: raw.source };
  }
  return { value: raw, source: "user" };
}

/**
 * The state of a write-only secret: nothing sent (unchanged), a new value
 * typed this session (pending) or an explicit clear.
 */
export function secretState(values, id) {
  if (!values || !Object.hasOwn(values, id)) return "unchanged";
  const raw = values[id];
  if (raw === null) return "clear";
  if (raw === undefined || raw === "") return "unchanged";
  return "pending";
}

/** The values with one field set. Unset (null or undefined) drops the key, except a secret's explicit clear. */
export function withValue(values, id, value, { keepNull = false } = {}) {
  const next = { ...(values || {}) };
  if (value === undefined || (value === null && !keepNull)) delete next[id];
  else next[id] = value;
  return next;
}

/** The values with a field's suggestion applied (the click handler; the model never does this). */
export function applySuggestion(values, field) {
  if (!field?.suggestion) return { ...(values || {}) };
  return withValue(values, field.id, field.suggestion.value, { keepNull: field.secret });
}

function numberOk(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Client-side checks that need no round trip (range, choices, length, json
 * shape, list size). The plan's errors stay the authority; this only keeps an
 * obviously wrong value from waiting for the next plan.
 * @returns {{ code, bounds?, suggestion? } | null}
 */
export function validateValue(param, value) {
  if (!isSet(value)) return null;
  const type = param.type;
  if (type === "int" || type === "float") {
    if (!numberOk(value)) return { code: "not_number" };
    if (type === "int" && !Number.isInteger(value)) return { code: "not_integer", suggestion: { value: Math.round(value) } };
    const { min, max } = param.range || {};
    if (numberOk(min) && value < min) return { code: "out_of_range", bounds: { min, max: numberOk(max) ? max : null }, suggestion: { value: min } };
    if (numberOk(max) && value > max) return { code: "out_of_range", bounds: { min: numberOk(min) ? min : null, max }, suggestion: { value: max } };
    return null;
  }
  if (type === "enum" && Array.isArray(param.choices) && param.choices.length) {
    const allowed = param.choices.map((choice) => (isPlainObject(choice) ? choice.value : choice));
    return allowed.some((item) => sameValue(item, value)) ? null : { code: "not_in_choices" };
  }
  if (type === "string" || type === "path") {
    if (typeof value !== "string") return { code: "not_text" };
    if (numberOk(param.maxLength) && value.length > param.maxLength) return { code: "too_long", bounds: { max: param.maxLength } };
    if (typeof param.pattern === "string" && param.pattern) {
      try {
        if (!new RegExp(param.pattern).test(value)) return { code: "pattern_mismatch" };
      } catch {
        return null;
      }
    }
    return null;
  }
  if (type === "list") {
    if (!Array.isArray(value)) return { code: "not_list" };
    const max = param.item?.maxItems;
    if (numberOk(max) && value.length > max) return { code: "too_many_items", bounds: { max } };
    const fields = param.item?.fields;
    if (isPlainObject(fields)) {
      for (const row of value) {
        if (!isPlainObject(row)) return { code: "item_invalid" };
        for (const [name, spec] of Object.entries(fields)) {
          const cell = row[name];
          if (spec?.required && (cell === undefined || cell === null || cell === "")) return { code: "item_invalid" };
          if (isSet(cell) && typeof cell === "string" && typeof spec?.pattern === "string") {
            try {
              if (!new RegExp(spec.pattern).test(cell)) return { code: "item_invalid" };
            } catch {
              // An unusable catalog pattern never blocks the user.
            }
          }
        }
      }
    }
    return null;
  }
  if (type === "kv") {
    if (!isPlainObject(value)) return { code: "not_object" };
    return null;
  }
  return null;
}

/**
 * The compact reading aid beside a number: "262,144 = 256K" for token counts,
 * "8,192 MiB = 8 GiB" for memory. Null when there is nothing worth saying.
 */
export function humanHint(param, value, locale = "en-US") {
  if (!numberOk(value) || !Number.isInteger(value)) return null;
  const unit = String(param.unit || "").toLowerCase();
  const shown = new Intl.NumberFormat(locale).format(value);
  if (unit === "tokens") {
    if (value >= 1048576 && value % 1048576 === 0) return `${shown} = ${value / 1048576}M`;
    if (value >= 1024 && value % 1024 === 0) return `${shown} = ${value / 1024}K`;
    return null;
  }
  if (unit === "mib" || unit === "mb") {
    if (value >= 1024 && value % 1024 === 0) return `${shown} ${param.unit} = ${value / 1024} GiB`;
  }
  return null;
}

function compileApplies(expr) {
  if (!isPlainObject(expr) && !Array.isArray(expr)) return null;
  let compiled = compiledCache.get(expr);
  if (!compiled) {
    compiled = compileExpr(expr, { envAllowlist: "any" });
    compiledCache.set(expr, compiled);
  }
  return compiled.ok ? compiled : null;
}

function searchText(param) {
  return fold([
    param.id,
    pickText(param.label, "zh-CN"),
    pickText(param.label, "en-US"),
    pickText(param.summary, "zh-CN"),
    pickText(param.summary, "en-US"),
    flagOf(param),
  ].filter(Boolean).join("\n"));
}

function matchesQuery(text, terms) {
  return terms.every((term) => text.includes(term));
}

function errorFor(entry, locale, source) {
  return { code: String(entry.code || "invalid"), message: pickText(entry.message, locale) || null, source };
}

function suggestionOf(entry, locale) {
  const suggestion = entry?.suggestion;
  if (!isPlainObject(suggestion) || !("value" in suggestion)) return null;
  return { value: suggestion.value, why: pickText(suggestion.why, locale) || null };
}

function groupEntries(plan, name, field) {
  const list = Array.isArray(plan?.[name]) ? plan[name] : [];
  return list.filter((item) => isPlainObject(item) && item.field === field);
}

/**
 * @param {object} input
 * @param input.catalog the schema response
 * @param input.plan the launch plan (or config description), or null
 * @param input.values the user's explicit values
 * @param input.engineId defaults to catalog.engineId
 * @param input.locale "zh-CN" | "en-US"
 * @param input.level "basic" | "advanced" | "expert"; catalog mode shows every level
 * @param input.query search text: label, summary, flag and id, every term must match; a search ignores the level
 * @param input.groups group ids to show, in that order; default: every group in catalog order
 * @param input.mode "launch" | "config" | "catalog"
 * @param input.fieldErrors extra field errors in the plan's errors[] shape (a 400 from the server)
 * @returns {{ engineId, mode, level, query, groups, counts, unplaced }}
 */
export function buildFormModel({ catalog, plan = null, values = {}, engineId, locale = "zh-CN", level = "basic", query = "", groups, mode = "launch", fieldErrors = [] } = {}) {
  const params = Array.isArray(catalog?.params) ? catalog.params : [];
  const facts = isPlainObject(catalog?.facts) ? catalog.facts : {};
  const planValues = isPlainObject(plan?.values) ? plan.values : {};
  const locks = new Map((Array.isArray(plan?.recipe?.locks) ? plan.recipe.locks : []).filter((lock) => lock && lock.param).map((lock) => [lock.param, lock]));
  const userValues = isPlainObject(values) ? values : {};
  const byId = new Map(params.map((param) => [param.id, param]));
  const activeMode = MODES.includes(mode) ? mode : "launch";
  const catalogMode = activeMode === "catalog";
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const rank = levelRank(level);
  const planErrors = [...(Array.isArray(plan?.errors) ? plan.errors : []), ...(Array.isArray(fieldErrors) ? fieldErrors : [])];
  const errorPlan = { errors: planErrors, warnings: plan?.warnings };

  // The value a parameter has right now: lock, then the user's, then the plan, then the defaults.
  const memo = new Map();
  const computing = new Set();
  function platformDefaultOf(param) {
    if (param.platformDefaultValue !== undefined) return param.platformDefaultValue;
    const raw = param.platformDefault;
    if (isPlainObject(raw) && Object.keys(raw).length === 1 && "expr" in raw) {
      // Normally the server evaluated it (platformDefaultValue); this covers a catalog without that field.
      const compiled = compileApplies(raw.expr);
      try {
        const value = compiled ? compiled.run(context) : null;
        return value === UNKNOWN ? null : value;
      } catch {
        return null;
      }
    }
    return raw ?? null;
  }
  function effectiveOf(param) {
    const id = param.id;
    if (memo.has(id)) return memo.get(id);
    if (computing.has(id)) return { value: null, source: null, reason: null };
    computing.add(id);
    let result;
    const lock = locks.get(id);
    const user = param.secret ? { value: null, source: "user" } : readUserEntry(userValues[id]);
    const planned = planValues[id];
    if (lock) {
      result = { value: lock.value ?? null, source: "recipe", reason: pickText(lock.reason, locale) || null };
    } else if (isSet(user.value)) {
      result = { value: user.value, source: user.source, reason: null };
    } else if (isPlainObject(planned) && "value" in planned) {
      result = { value: planned.value ?? null, source: planned.source || null, reason: pickText(planned.reason, locale) || null };
    } else if (isSet(platformDefaultOf(param))) {
      result = { value: platformDefaultOf(param), source: "platform-default", reason: null };
    } else if (isSet(param.engineDefault)) {
      result = { value: param.engineDefault, source: "engine-default", reason: null };
    } else {
      result = { value: null, source: null, reason: null };
    }
    computing.delete(id);
    memo.set(id, result);
    return result;
  }

  const valueOfId = (id) => {
    const param = byId.get(id);
    if (param) return effectiveOf(param).value;
    const planned = planValues[id];
    return isPlainObject(planned) && "value" in planned ? planned.value : null;
  };
  const context = {
    param: valueOfId,
    user: (id) => (byId.get(id)?.secret ? null : readUserEntry(userValues[id]).value),
    fact: (name) => (Object.hasOwn(facts, name) ? facts[name] : undefined),
  };

  function appliesState(param) {
    if (param.appliesWhen === null || param.appliesWhen === undefined) return "true";
    const compiled = compileApplies(param.appliesWhen);
    if (!compiled) return "unknown";
    let result;
    try {
      result = compiled.run(context);
    } catch {
      return "unknown";
    }
    if (result === UNKNOWN) return "unknown";
    return result === true ? "true" : "false";
  }

  const counts = { visible: 0, hidden: 0, notApplicable: Array.isArray(catalog?.notApplicable) ? catalog.notApplicable.length : 0, changed: 0, errors: 0 };
  const groupDefs = [...(Array.isArray(catalog?.groups) ? catalog.groups : [])]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => (numberOk(a.group.order) && numberOk(b.group.order) ? a.group.order - b.group.order : 0) || a.index - b.index)
    .map(({ group }) => group);
  const known = new Set(groupDefs.map((group) => group.id));
  for (const param of params) {
    if (param.group && !known.has(param.group)) {
      known.add(param.group);
      groupDefs.push({ id: param.group, label: param.group });
    }
  }
  const wanted = Array.isArray(groups) && groups.length
    ? groups.map((item) => (typeof item === "string" ? item : item?.id)).map((id) => groupDefs.find((group) => group.id === id) || { id, label: id })
    : groupDefs;

  const outGroups = [];
  for (const group of wanted) {
    const members = params
      .map((param, index) => ({ param, index }))
      .filter(({ param }) => param.group === group.id)
      .sort((a, b) => (numberOk(a.param.order) && numberOk(b.param.order) ? a.param.order - b.param.order : 0) || a.index - b.index);
    const fields = [];
    let hiddenCount = 0;
    for (const { param } of members) {
      const field = buildField(param);
      if (!field.applicable && !catalogMode) {
        counts.notApplicable += 1;
        continue;
      }
      if (field.changed) counts.changed += 1;
      if (field.error) counts.errors += 1;
      if (field.visible) {
        fields.push(field);
        counts.visible += 1;
      } else {
        hiddenCount += 1;
        counts.hidden += 1;
      }
    }
    if (fields.length) outGroups.push({ id: group.id, label: pickText(group.label, locale) || group.id, fields, hiddenCount });
  }

  // Server errors that name no field on this form (a blocker for another step, a typo'd field).
  const unplaced = planErrors
    .filter((item) => isPlainObject(item) && !byId.has(item.field))
    .map((item) => ({ field: item.field ?? null, ...errorFor(item, locale, "plan") }));

  function buildField(param) {
    const id = param.id;
    const secret = Boolean(param.secret);
    const entry = secret ? { value: null, source: "user" } : readUserEntry(userValues[id]);
    const effective = effectiveOf(param);
    const state = secret ? secretState(userValues, id) : null;
    const userValue = entry.value;
    const changed = secret ? state !== "unchanged" : isSet(userValue);
    const lock = locks.get(id);
    const availability = param.availability
      ? { state: param.availability.state || "unverified", reason: pickText(param.availability.reason, locale) || null }
      : null;
    let locked = null;
    if (lock) locked = { kind: "recipe", reason: pickText(lock.reason, locale) || null, value: lock.value ?? null };
    else if (param.managed) locked = { kind: "managed", reason: null, value: null };
    else if (!catalogMode && availability?.state === "unavailable") locked = { kind: "unavailable", reason: availability.reason, value: null };

    const serverErrors = [...groupEntries(errorPlan, "errors", id)];
    const warnings = groupEntries(errorPlan, "warnings", id).map((item) => errorFor(item, locale, "plan"));
    let error = serverErrors.length ? errorFor(serverErrors[0], locale, "plan") : null;
    let suggestion = null;
    for (const item of [...serverErrors, ...groupEntries(errorPlan, "warnings", id)]) {
      suggestion = suggestionOf(item, locale);
      if (suggestion) break;
    }
    if (!error && !secret && !locked && isSet(userValue)) {
      const problem = validateValue(param, userValue);
      if (problem) {
        error = { code: problem.code, message: null, source: "client", ...(problem.bounds ? { bounds: problem.bounds } : {}) };
        if (problem.suggestion) suggestion = { value: problem.suggestion.value, why: null };
      }
    }

    const applies = appliesState(param);
    const applicable = applies !== "false";
    let visible = true;
    if (!catalogMode && !applicable) visible = false;
    if (visible && terms.length) visible = matchesQuery(searchText(param), terms);
    else if (visible && !catalogMode && levelRank(param.level) > rank) visible = Boolean(error) || changed;

    const shown = isSet(userValue) ? userValue : effective.value;
    return {
      id,
      domId: domIdOf(param),
      group: param.group || null,
      widget: widgetFor(param),
      type: param.type || "string",
      label: pickText(param.label, locale) || id,
      unit: param.unit || null,
      summary: pickText(param.summary, locale) || null,
      help: {
        what: pickText(param.help?.what, locale) || null,
        whenToChange: pickText(param.help?.whenToChange, locale) || null,
        tradeoffs: pickText(param.help?.tradeoffs, locale) || null,
        docs: param.docs || null,
      },
      flag: flagOf(param),
      userValue: secret ? null : userValue,
      effective: secret ? { value: null, source: effective.source, reason: effective.reason, redacted: true } : effective,
      ghost: secret || isSet(userValue) ? null : effective.value,
      hint: secret ? null : humanHint(param, shown, locale),
      changed,
      locked,
      error,
      warnings,
      suggestion,
      applicable,
      appliesState: applies,
      visible,
      level: LEVELS.includes(param.level) ? param.level : "advanced",
      secret,
      secretState: secret ? state : null,
      configured: secret ? Boolean(isPlainObject(planValues[id]) && isSet(planValues[id].value)) || param.set === true : null,
      choices: normalizeChoices(param, locale),
      range: param.range ? { min: param.range.min ?? null, max: param.range.max ?? null, step: param.range.step ?? null } : null,
      item: isPlainObject(param.item) ? param.item : null,
      pattern: typeof param.pattern === "string" ? param.pattern : null,
      maxLength: numberOk(param.maxLength) ? param.maxLength : null,
      availability,
    };
  }

  return {
    engineId: engineId || catalog?.engineId || null,
    mode: activeMode,
    level: LEVELS.includes(level) ? level : "basic",
    query: String(query || ""),
    groups: outGroups,
    counts,
    unplaced,
  };
}

/** Field models of a built form as one flat list. */
export function flattenFields(model) {
  return (model?.groups || []).flatMap((group) => group.fields);
}
