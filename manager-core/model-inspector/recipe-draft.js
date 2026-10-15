"use strict";

// Save a working launch as a recipe (docs/overhaul/02-models.md §15, MOD-17).
//
//   draftRecipeFromLaunch(launch, card, hostRecord, { recipeId, scope, locks, title, notes, ... })
//     → { recipe, errors: [{ path, code, message }], warnings: [...] }
//
// `launch` is the hosting manager's LaunchStore record (01 §15.1): the effective
// values with provenance in `resolved.values`, the runtime and recipe in `spec`.
// The recipe is built in 01's schema (01 §10.1) and checked with
// `engines/recipe-schema.js#validateRecipe`, never with the descriptor validator.
// Nothing the owner would not want to share leaves the draft: the model is
// referenced by `match` (family, optionally the exact content digest), never by a
// path; secret, path and host-specific parameters, `extraArgs` and `extraEnv`
// are not copied; the planner and engine defaults are left out so the recipe
// only pins what the owner (or the planner, or the model) chose.

const { redactSecrets } = require("../secret-redactor");

const SCOPES = Object.freeze(["family", "this-model"]);
// Value sources that make it into the recipe; engine and platform defaults and
// values another recipe supplied are what a launch gets anyway.
const KEPT_SOURCES = new Set(["user", "planner", "model"]);
// Host- or identity-specific parameters that are not a property of the model.
const SKIPPED_PARAMS = new Set(["servedName", "role", "lora.adapters"]);
const STALE_AFTER_DAYS = 180;
// Above the bundled recipes (100), so a verified-on-this-host recipe wins a tie
// of identity; an exact-model recipe wins over a family one.
const PRIORITY = Object.freeze({ family: 150, "this-model": 200 });
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const QUANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const COMPUTE_CAP_PATTERN = /^\d{1,2}(?:\.\d{1,2})?$/;
const MAX_TEXT = 2000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateOf(value) {
  const parsed = new Date(value);
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function lazyEngines() {
  return require("../engines");
}

function catalogParams(catalogs, engineId) {
  try {
    const catalog = typeof catalogs?.loadCatalog === "function" ? catalogs.loadCatalog(engineId) : catalogs?.[engineId];
    return new Map((Array.isArray(catalog?.params) ? catalog.params : []).map((param) => [param.id, param]));
  } catch {
    return new Map();
  }
}

// {zh, en}, or one string used for both languages; null when it is neither.
function bilingualText(value) {
  if (typeof value === "string" && value.trim()) return { zh: value.trim(), en: value.trim() };
  if (isPlainObject(value) && typeof value.zh === "string" && typeof value.en === "string" && value.zh.trim() && value.en.trim()) {
    return { zh: value.zh.trim(), en: value.en.trim() };
  }
  return null;
}

// The parameter values the recipe pins: [{id, value}] with the ones that must not
// be copied dropped. `resolved.values` carries the provenance; a record without
// it (an adopted container) falls back to the requested values, which the owner chose.
function keptValues(launch, params) {
  const resolved = isPlainObject(launch?.resolved?.values) ? launch.resolved.values : null;
  const entries = resolved
    ? Object.entries(resolved).filter(([, entry]) => isPlainObject(entry) && KEPT_SOURCES.has(entry.source)).map(([id, entry]) => [id, entry.value])
    : Object.entries(isPlainObject(launch?.spec?.values) ? launch.spec.values : {});
  const kept = {};
  for (const [id, value] of entries) {
    if (value === null || value === undefined) continue;
    if (SKIPPED_PARAMS.has(id)) continue;
    const param = params.get(id);
    if (param && (param.secret || param.type === "path")) continue;
    kept[id] = clone(value);
  }
  return kept;
}

function peakMb(hostRecord) {
  const peaks = Object.values(isPlainObject(hostRecord?.observed?.peakMb) ? hostRecord.observed.peakMb : {}).map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return peaks.length ? Math.max(...peaks) : null;
}

function matchOf(scope, launch, card, hostRecord) {
  const match = {};
  const familyId = card?.identity?.familyId || card?.familyId || null;
  if (familyId) match.familyId = String(familyId);
  if (scope === "this-model" && typeof card?.contentDigest === "string") match.contentDigest = card.contentDigest.replace(/^sha256:/, "");
  if (typeof launch?.spec?.runtimeId === "string" && launch.spec.runtimeId) match.runtimeId = launch.spec.runtimeId;
  const quant = String(card?.quant?.method || "").toLowerCase();
  if (QUANT_PATTERN.test(quant) && quant !== "none") match.quant = [quant];
  const computeCap = hostRecord?.host?.computeCap;
  if (typeof computeCap === "string" && COMPUTE_CAP_PATTERN.test(computeCap)) match.minComputeCapability = computeCap;
  return match;
}

function lockOf(id, value) {
  return {
    param: id,
    value: clone(value),
    reason: { zh: "所有者在本机验证后锁定", en: "Locked by the owner after verifying it on this host" },
  };
}

/**
 * @param {object} launch LaunchStore record of the working launch
 * @param {object} card the model's card (identity.familyId, contentDigest, quant)
 * @param {object} hostRecord the passing qualification host record (02 §13)
 * @param {object} options { recipeId, scope: "family"|"this-model", locks?: [paramId], title: {zh,en},
 *   notes?, now?, platform?, catalogs?, registry?, validateValues?, validate?, runtimeRef? }
 * @returns {{recipe: object|null, errors: object[], warnings: object[]}}
 */
function draftRecipeFromLaunch(launch, card, hostRecord, options = {}) {
  const errors = [];
  const fail = (path, code, message) => errors.push({ path, code, message });
  const engines = options.catalogs && options.registry ? null : lazyEngines();
  const catalogs = options.catalogs || engines.getParamCatalog();
  const registry = options.registry || engines.getEngineRegistry();
  const validateValues = options.validateValues || engines?.paramCatalog?.validateValues || null;
  const validate = options.validate || (engines || lazyEngines()).recipeSchema.validateRecipe;

  const scope = SCOPES.includes(options.scope) ? options.scope : null;
  if (!scope) fail("scope", "invalid_value", `scope is one of ${SCOPES.join(", ")}.`);
  const title = bilingualText(options.title);
  if (!title || !isPlainObject(options.title)) fail("title", "required", "title needs zh and en text.");
  const spec = isPlainObject(launch?.spec) ? launch.spec : {};
  const engineId = typeof spec.engineId === "string" ? spec.engineId : "";
  if (!engineId) fail("engineId", "required", "The launch record names no engine.");

  const params = catalogParams(catalogs, engineId);
  const values = keptValues(launch, params);
  if (!Object.keys(values).length) fail("values", "required", "The launch holds no value the owner, the planner or the model chose; there is nothing to save.");

  const match = matchOf(scope, launch, card, hostRecord);
  if (scope === "family" && !match.familyId) fail("match.familyId", "family_unknown", "The model has no known family; save it for this exact model instead.");
  if (scope === "this-model" && !match.contentDigest) fail("match.contentDigest", "required", "The model card has no content digest.");
  if (match.contentDigest && !SHA256_PATTERN.test(match.contentDigest)) fail("match.contentDigest", "invalid_value", "The model's content digest is not a sha256.");

  // runtime.ref is the manifest key; the launch recorded the runtime id.
  let runtime;
  if (typeof options.runtimeRef === "string" && options.runtimeRef) {
    runtime = { ref: options.runtimeRef, allowOverride: true };
  } else if (match.runtimeId && engineId) {
    try {
      runtime = { ref: registry.resolveRuntime(engineId, { runtimeId: match.runtimeId }).manifestKey, allowOverride: true };
    } catch {
      fail("runtime.ref", "runtime_unresolved", `Runtime ${match.runtimeId} is not a runtime of ${engineId} on this platform.`);
    }
  }

  const locks = [];
  for (const [index, id] of (Array.isArray(options.locks) ? options.locks : []).entries()) {
    if (typeof id !== "string" || !Object.hasOwn(values, id)) {
      fail(`locks[${index}]`, "lock_not_in_values", `${typeof id === "string" ? id : "A lock"} is not one of the values this recipe pins.`);
    } else if (!locks.some((lock) => lock.param === id)) {
      locks.push(lockOf(id, values[id]));
    }
  }

  const notes = [];
  if (options.notes !== undefined && options.notes !== null && options.notes !== "") {
    const note = bilingualText(options.notes);
    if (!note || note.zh.length > MAX_TEXT || note.en.length > MAX_TEXT) fail("notes", "invalid_value", `notes is text of at most ${MAX_TEXT} characters, or {zh, en}.`);
    else notes.push(note);
  }

  const peak = peakMb(hostRecord);
  const recipe = {
    schemaVersion: 1,
    asOf: dateOf(options.now ?? Date.now()),
    staleAfterDays: STALE_AFTER_DAYS,
    id: options.recipeId,
    kind: "model",
    status: "verified",
    label: title || undefined,
    engineId,
    ...(runtime ? { runtime } : {}),
    match,
    priority: PRIORITY[scope] || PRIORITY.family,
    values,
    ...(locks.length ? { locks } : {}),
    ...(notes.length ? { notes } : {}),
    evidence: {
      gpu: hostRecord?.host?.gpu ?? null,
      host: typeof options.platform === "string" && options.platform ? options.platform : null,
      date: dateOf(hostRecord?.at ?? options.now ?? Date.now()),
      jobId: typeof launch?.jobId === "string" ? launch.jobId : null,
      launchId: typeof launch?.launchId === "string" ? launch.launchId : null,
      hostRecordId: typeof hostRecord?.id === "string" ? hostRecord.id : null,
      measuredPeakMb: peak,
    },
  };

  // The file must never carry a secret; a value the redactor changes is one.
  const text = JSON.stringify(recipe);
  if (redactSecrets(text) !== text) fail("", "secret_in_recipe", "A value looks like a secret or a token; recipes never hold secrets.");

  const report = validate(recipe, { catalogs, registry, ...(validateValues ? { validateValues } : {}), mode: "override" });
  const reported = Array.isArray(report?.errors) ? report.errors : [];
  const seen = new Set(errors.map((item) => `${item.path}|${item.code}`));
  for (const item of reported) {
    if (!seen.has(`${item.path}|${item.code}`)) errors.push({ path: item.path, code: item.code, message: item.message });
  }
  return { recipe: errors.length ? null : recipe, errors, warnings: Array.isArray(report?.warnings) ? report.warnings : [] };
}

module.exports = {
  KEPT_SOURCES,
  PRIORITY,
  SCOPES,
  draftRecipeFromLaunch,
};
