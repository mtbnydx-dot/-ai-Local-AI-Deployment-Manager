"use strict";

// Legacy alias table (docs/overhaul/01-engines.md §9.5). The old forms, the
// builtin profiles, launch-profiles.json, recent-launches.json and the sleep
// ledger all speak the flat legacy config ({maxModelLen, maxNumSeqs,
// sglangMaxTotalTokens, ...}); v2 requests speak catalog param ids. The mapping
// itself is catalog data: each param names its legacy field, aliases, codec
// and, where it is not an empty string, the legacy spelling of "unset"
// (param.legacy). This module holds the codecs plus the few legacy fields that
// are LaunchRequest fields rather than params.
//
// Round trip: valuesToLegacyConfig(legacyConfigToValues(config, e), e, { base: config })
// returns config for every config the managers' normalizeLaunchConfig builds.
// A field that is present but unset stays in values as null, so its legacy
// spelling ("" for text, legacy.unset such as 0 for sglangMaxTotalTokens) comes
// back. Secret params (the API key) never enter values.

const { isImageReference } = require("./descriptor-schema");
const paramCatalog = require("./param-catalog");
const { normalizeManagerId, unknownEngineError } = require("./registry");
const { normalizeGpuIds, normalizeNetworkAccess } = require("../common-utils");
const { normalizeRuntimeInstanceMode } = require("../runtime-instance-utils");

// Legacy body fields that are LaunchRequest fields, not params (01 §9.3).
const REQUEST_FIELDS = Object.freeze(["model", "port", "instanceMode", "instanceId", "networkAccess", "engine", "runtimeImage", "gpuDeviceIds"]);

// vllm-manager's multi-GPU layout helper. Today's launch request keeps the
// parallel size of the chosen mode and forces the other two to 1; it also
// falls back to "single" when fewer than two GPUs are selected, which needs
// host facts and stays with the resolver (request.legacy.multiGpuMode).
// llama-manager binds the same field to llamacpp.splitMode instead.
const LAYOUT_FIELD = "multiGpuMode";
const LAYOUT_DEFAULT = "single";
const LAYOUT_PARAMS = Object.freeze({ tensor: "tensorParallel", pipeline: "pipelineParallel", data: "dataParallel" });

// Manifest runtimes whose image also selects a recipe (01 §9.5): the
// Pennyroyal image is the Pennyroyal recipe today.
const RUNTIME_RECIPES = Object.freeze({ sglangPennyroyal: "pennyroyal-v251" });

const TEXT_TYPES = new Set(["string", "path", "enum"]);
const TRUE_TEXT = /^(?:true|on|yes|1)$/i;
const FALSE_TEXT = /^(?:false|off|no|0)$/i;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function present(config, field) {
  return Object.hasOwn(config, field) && config[field] !== undefined;
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

// A {value, source} entry (planner output) carries its value inside.
function unwrapValue(entry) {
  if (isPlainObject(entry) && Object.hasOwn(entry, "value") && (Object.keys(entry).length === 1 || Object.hasOwn(entry, "source"))) return entry.value;
  return entry;
}

// Booleans the way the managers read them; anything else is returned as is
// so validateValues reports it.
function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && TRUE_TEXT.test(value.trim())) return true;
  if (typeof value === "string" && FALSE_TEXT.test(value.trim())) return false;
  return value;
}

function bilingual(zh, en) {
  return `${zh} / ${en}`;
}

function legacyFields(param) {
  return [param.legacy.field, ...(param.legacy.aliases || [])];
}

// The managers read "field || alias" (cacheTypeK || kvCacheDtype, draftModel ||
// specDraftModel) or "field ?? alias" (topP ?? top_p): the first field holding
// a value wins, and a blank field still counts when no other one is set.
function readRaw(config, param) {
  let blank = null;
  for (const name of legacyFields(param)) {
    if (!present(config, name)) continue;
    if (!isBlank(config[name])) return { found: true, value: config[name] };
    if (!blank) blank = { found: true, value: config[name] };
  }
  return blank || { found: false };
}

function decodeScalar(param, raw) {
  if (param.legacy.unset !== undefined && raw === param.legacy.unset) return null;
  if (isBlank(raw)) return null;
  if (param.type === "int" || param.type === "float") {
    if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
    return raw;
  }
  if (param.type === "bool" || param.type === "tristate") return toBool(raw);
  return raw;
}

// null → the legacy spelling of unset, or no field at all when there is none.
function encodeScalar(param, value) {
  if (value === null || value === undefined) {
    if (param.legacy.unset !== undefined) return { set: true, value: param.legacy.unset };
    if (TEXT_TYPES.has(param.type)) return { set: true, value: "" };
    return { set: false };
  }
  return { set: true, value: clone(value) };
}

/**
 * Codecs by param.legacy.codec. decode(param, config) → { found, value };
 * encode(param, value) → { legacyField: value, ... }.
 */
const CODECS = Object.freeze({
  direct: {
    decode(param, config) {
      const raw = readRaw(config, param);
      return raw.found ? { found: true, value: decodeScalar(param, raw.value) } : { found: false };
    },
    encode(param, value) {
      const out = encodeScalar(param, value);
      return out.set ? { [param.legacy.field]: out.value } : {};
    },
  },
  // sglangDisableThinkingByDefault → reasoning.defaultEnabled. A legacy config
  // can say "off by default" or nothing; "on by default" has no legacy form.
  invertedBool: {
    decode(param, config) {
      const raw = readRaw(config, param);
      if (!raw.found) return { found: false };
      return { found: true, value: toBool(raw.value) === true ? false : null };
    },
    encode(param, value) {
      return { [param.legacy.field]: value === false };
    },
  },
  // enablePrefixCaching + disablePrefixCaching → tristate prefixCaching, read
  // the way launch-request.js and the builders read the pair: disable wins;
  // a present enable decides on/unset; without enable, "not disabled" is on.
  prefixCachingPair: {
    decode(param, config) {
      const [enableField, disableField] = legacyFields(param);
      const hasEnable = present(config, enableField);
      const hasDisable = Boolean(disableField) && present(config, disableField);
      if (!hasEnable && !hasDisable) return { found: false };
      if (hasDisable && toBool(config[disableField]) === true) return { found: true, value: false };
      if (hasEnable) return { found: true, value: toBool(config[enableField]) === true ? true : null };
      return { found: true, value: true };
    },
    encode(param, value) {
      const [enableField, disableField] = legacyFields(param);
      const out = { [enableField]: value === true };
      if (disableField) out[disableField] = value === false;
      return out;
    },
  },
  // textOnlyMode / languageModelOnly on llama-manager: true unless one of the
  // fields says false (normalizeDefaultTrueBoolean); both are written back.
  defaultTrueBool: {
    decode(param, config) {
      const names = legacyFields(param).filter((name) => present(config, name));
      if (!names.length) return { found: false };
      const off = names.some((name) => config[name] === false || config[name] === 0
        || (typeof config[name] === "string" && FALSE_TEXT.test(config[name].trim())));
      return { found: true, value: !off };
    },
    encode(param, value) {
      return Object.fromEntries(legacyFields(param).map((name) => [name, value !== false]));
    },
  },
});

function codecFor(param) {
  return CODECS[param.legacy.codec] || CODECS.direct;
}

function catalogFor(engineId, options = {}) {
  if (options.catalog) return options.catalog;
  const loader = options.paramCatalog || paramCatalog.getParamCatalog();
  return loader.loadCatalog(engineId);
}

// Params a legacy config can carry: bound to a legacy field and not secret.
function legacyParams(catalog) {
  return catalog.params.filter((param) => param.legacy && !param.secret);
}

/**
 * Every legacy field (and alias) a catalog binds, including secret params,
 * so valuesToLegacyConfig never copies a key value over from a base config.
 */
function legacyFieldSet(catalog) {
  const fields = new Set();
  for (const param of catalog.params) {
    if (param.legacy) for (const name of legacyFields(param)) fields.add(name);
  }
  return fields;
}

/**
 * legacyConfigToValues(config, engineId, { catalog?, paramCatalog? }) → values
 * (profiles, recent launches, the sleep ledger, legacy bodies). Only fields
 * present in config produce values; a present but unset field gives null.
 */
function legacyConfigToValues(config, engineId, options = {}) {
  if (!isPlainObject(config)) return {};
  const catalog = catalogFor(engineId, options);
  const values = {};
  for (const param of legacyParams(catalog)) {
    const decoded = codecFor(param).decode(param, config);
    if (decoded.found) values[param.id] = decoded.value;
  }
  return values;
}

/**
 * valuesToLegacyConfig(values, engineId, { base?, catalog?, paramCatalog? }) →
 * the flat legacy config (GET /api/tools/profiles, /api/recent-launches).
 * Only params present in values are written. With base, the base config's
 * other fields (model, port, gpuDeviceIds, ...) are kept in their order and
 * its param fields are replaced by the values; a param field the values do
 * not mention is dropped.
 */
function valuesToLegacyConfig(values, engineId, options = {}) {
  const catalog = catalogFor(engineId, options);
  const source = isPlainObject(values) ? values : {};
  const encoded = {};
  for (const param of legacyParams(catalog)) {
    if (!Object.hasOwn(source, param.id)) continue;
    Object.assign(encoded, codecFor(param).encode(param, unwrapValue(source[param.id])));
  }
  const base = isPlainObject(options.base) ? options.base : null;
  if (!base) return encoded;
  const owned = legacyFieldSet(catalog);
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (!owned.has(key)) out[key] = clone(value);
    else if (Object.hasOwn(encoded, key)) out[key] = encoded[key];
  }
  for (const [key, value] of Object.entries(encoded)) {
    if (!Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

// A value the user did not really choose: unset, omitted from argv, or the
// platform/engine default. Such values never warn when an engine ignores them,
// because the old forms send every field for every engine.
function isQuietValue(param, value) {
  if (value === null || value === undefined) return true;
  if ((param.emit?.omitWhen || []).some((item) => item === value)) return true;
  for (const fallback of [param.platformDefault, param.engineDefault]) {
    if (fallback !== null && fallback !== undefined && !isPlainObject(fallback) && fallback === value) return true;
  }
  return (param.type === "bool" || param.type === "tristate") && value === false && param.platformDefault !== true;
}

function resolveLegacyEngine(value, managerId, registry) {
  const hosted = registry.hostedBy(managerId);
  const text = String(value ?? "").trim();
  const engineId = registry.fromLegacy(text, managerId);
  // No coercion (01 §3): a non-empty engine this manager does not host is 400.
  if (!hosted.includes(engineId)) throw unknownEngineError(text || engineId);
  return engineId;
}

function engineLabel(registry, engineId) {
  const label = registry.get(engineId)?.label;
  return { zh: label?.zh || engineId, en: label?.en || engineId };
}

function fieldWarning(field, code, zh, en, extra = {}) {
  return { field, code, message: bilingual(zh, en), ...extra };
}

/**
 * Warnings for legacy fields this engine ignores: the old forms send every
 * field for every engine of the manager, so only a value the user changed
 * warns (param_not_applicable for another engine's param, param_ignored for a
 * param or form field this engine's legacy path never used).
 */
function ignoredFieldWarnings(body, { engineId, catalog, otherCatalogs, registry }) {
  const warnings = [];
  const label = engineLabel(registry, engineId);
  const own = legacyFieldSet(catalog);
  const seen = new Set();
  for (const other of otherCatalogs) {
    for (const param of legacyParams(other)) {
      const field = param.legacy.field;
      if (own.has(field) || seen.has(field)) continue;
      const decoded = codecFor(param).decode(param, body);
      if (!decoded.found || isQuietValue(param, decoded.value)) continue;
      seen.add(field);
      const mine = catalog.byId.get(param.id);
      warnings.push(mine
        ? fieldWarning(field, "param_ignored", `${label.zh} 的旧版启动路径不使用“${mine.label.zh}”，已忽略`, `${label.en}'s legacy launch path does not use "${mine.label.en}"; ignored`, { param: param.id })
        : fieldWarning(field, "param_not_applicable", `${label.zh} 不使用“${param.label.zh}”，已忽略`, `${label.en} does not use "${param.label.en}"; ignored`, { param: param.id }));
    }
  }
  // A dead form control (llama's loadFormat) warns only when moved off its
  // default, which is "auto" on every such control today.
  for (const item of catalog.legacyIgnored || []) {
    if (!present(body, item.field) || isBlank(body[item.field]) || String(body[item.field]).trim().toLowerCase() === "auto") continue;
    warnings.push(fieldWarning(item.field, item.code || "param_ignored", item.reason.zh, item.reason.en));
  }
  return warnings;
}

function applyLayout(body, values, catalog) {
  if (catalog.byLegacyField[LAYOUT_FIELD]) return null;
  const mode = String(body[LAYOUT_FIELD] || LAYOUT_DEFAULT).trim().toLowerCase();
  for (const [layout, paramId] of Object.entries(LAYOUT_PARAMS)) {
    const param = catalog.byId.get(paramId);
    // Only sizes the legacy path reads: SGLang's --pp-size/--dp-size are new
    // catalog flags with no legacy field, and a forced 1 would emit them.
    if (!param?.legacy) continue;
    if (layout !== mode) values[paramId] = 1;
  }
  return mode;
}

function badRequest(code, message) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

/**
 * legacyBodyToRequest(body, { managerId, registry, paramCatalog? }) →
 *   { request: LaunchRequestV2, warnings: FieldError[] }
 *
 * A legacy /api/start body becomes a v2 request: engine through the registry
 * (an unknown non-empty engine is 400 unknown_engine), runtimeImage through
 * the manifest (runtimeId, the Pennyroyal recipe, or runtime.imageOverride),
 * the flat fields through the catalog, and the API key as request.apiKey.
 * request.legacy.multiGpuMode carries vllm-manager's layout choice, which the
 * resolver still has to check against the selected GPU count.
 */
function legacyBodyToRequest(body, options = {}) {
  const { registry } = options;
  if (!registry || typeof registry.hostedBy !== "function") throw new TypeError("legacyBodyToRequest needs an engine registry.");
  const managerId = normalizeManagerId(options.managerId);
  if (!managerId) throw new TypeError(`legacyBodyToRequest: unknown managerId ${options.managerId}`);
  if (!isPlainObject(body)) throw badRequest("invalid_body", "The launch request body must be a JSON object.");
  const loader = options.paramCatalog || paramCatalog.getParamCatalog();
  const engineId = resolveLegacyEngine(body.engine, managerId, registry);
  const catalog = loader.loadCatalog(engineId);
  const otherCatalogs = registry.hostedBy(managerId)
    .filter((id) => id !== engineId)
    .map((id) => loader.loadCatalog(id));

  const values = legacyConfigToValues(body, engineId, { catalog });
  const multiGpuMode = applyLayout(body, values, catalog);
  const warnings = ignoredFieldWarnings(body, { engineId, catalog, otherCatalogs, registry });

  const servedName = String(body.name ?? "").trim();
  const request = {
    engineId,
    model: { ref: String(body.model ?? "").trim(), ...(servedName ? { servedName } : {}) },
    instance: {
      mode: normalizeRuntimeInstanceMode(body.instanceMode),
      networkAccess: normalizeNetworkAccess(body.networkAccess),
      gpuIds: normalizeGpuIds(body.gpuDeviceIds),
    },
    values,
  };
  const instanceId = String(body.instanceId ?? "").trim();
  if (instanceId) request.instance.id = instanceId;
  if (!isBlank(body.port)) request.instance.port = Number(body.port);

  const image = String(body.runtimeImage ?? "").trim();
  if (image) {
    if (!isImageReference(image)) throw badRequest("invalid_runtime_image", "runtimeImage is not a Docker image reference.");
    const ref = registry.resolveRuntime(engineId, { image });
    if (ref.custom) {
      request.runtime = { imageOverride: image };
    } else {
      request.runtimeId = ref.runtimeId;
      if (RUNTIME_RECIPES[ref.manifestKey]) request.recipeId = RUNTIME_RECIPES[ref.manifestKey];
    }
  }
  const apiKey = String(body.apiKey ?? "").trim();
  if (apiKey) request.apiKey = apiKey;
  if (multiGpuMode) request.legacy = { multiGpuMode };
  return { request, warnings };
}

module.exports = {
  CODECS,
  LAYOUT_PARAMS,
  REQUEST_FIELDS,
  RUNTIME_RECIPES,
  legacyBodyToRequest,
  legacyConfigToValues,
  legacyFieldSet,
  valuesToLegacyConfig,
};
