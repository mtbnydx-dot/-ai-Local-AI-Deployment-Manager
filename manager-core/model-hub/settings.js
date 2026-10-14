"use strict";

// Hub settings (03 §14): the one global settings object behind
// GET/PUT /api/hub/settings, persisted as data/hub/settings.json.
//
// HUB_SETTINGS_SCHEMA lists every leaf by its dotted key, in the order the
// API returns them. validateSettings() checks a partial patch against it and
// merges it into the current settings; normalizeSettings() reads a stored
// file tolerantly (an invalid leaf falls back to its default and is
// reported). fromLegacy()/toLegacy() map the managers' seven-key download
// settings (migration and the /api/download/settings shim). Settings hold no
// secret.

const SETTINGS_SCHEMA_VERSION = 1;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function leaf(type, defaultValue, extra = {}) {
  return Object.freeze({ type, default: defaultValue, ...extra });
}

const RETRY_CLASS_VALUES = Object.freeze([true, false, "once"]);

const HUB_SETTINGS_SCHEMA = Object.freeze({
  "sources.policy": leaf("enum", "huggingface", { values: Object.freeze(["huggingface", "hf-mirror", "auto"]) }),
  "sources.hfEndpoint": leaf("endpoint", "https://huggingface.co"),
  "sources.mirrorEndpoint": leaf("endpoint", "https://hf-mirror.com"),
  "sources.modelScopeEndpoint": leaf("endpoint", "https://www.modelscope.cn"),
  "sources.gatedUsesOfficial": leaf("boolean", true),
  "transfer.xet": leaf("enum", "high-performance", { values: Object.freeze(["high-performance", "default", "off"]) }),
  "transfer.maxConcurrent": leaf("integer", 1, { min: 1, max: 4 }),
  "transfer.stallMinutes": leaf("integer", 10, { min: 1, max: 240 }),
  "transfer.materializeStallMinutes": leaf("integer", 20, { min: 1, max: 480 }),
  "verify.sha256": leaf("boolean", true),
  "retry.maxAttempts": leaf("integer", 3, { min: 0, max: 10 }),
  "retry.baseDelaySeconds": leaf("integer", 10, { min: 1, max: 3600 }),
  "retry.maxDelaySeconds": leaf("integer", 600, { min: 1, max: 86400 }),
  "retry.perClass.network": leaf("enum", true, { values: RETRY_CLASS_VALUES }),
  "retry.perClass.server": leaf("enum", true, { values: RETRY_CLASS_VALUES }),
  "retry.perClass.watchdog": leaf("enum", true, { values: RETRY_CLASS_VALUES }),
  "retry.perClass.integrity": leaf("enum", true, { values: RETRY_CLASS_VALUES }),
  "retry.perClass.tooling": leaf("enum", "once", { values: RETRY_CLASS_VALUES }),
  "queue.idleOnly": leaf("boolean", false),
  "queue.idleGraceSeconds": leaf("integer", 30, { min: 0, max: 3600 }),
  "queue.resumeOnStart": leaf("boolean", true),
  "queue.resumeDelaySeconds": leaf("integer", 20, { min: 0, max: 3600 }),
  "storage.reserveGb": leaf("number", 10, { min: 0, max: 100000 }),
  "storage.showLegacyRootWhenEmpty": leaf("boolean", false),
  "history.keepRecords": leaf("integer", 200, { min: 0, max: 10000 }),
  "history.retentionDays": leaf("integer", 365, { min: 1, max: 3650 }),
  "library.rescanOnStart": leaf("boolean", true),
  "library.updateCheck": leaf("enum", "manual", { values: Object.freeze(["manual", "weekly"]) }),
  "library.identifyOnline": leaf("boolean", false),
  "notifications.onReady": leaf("boolean", true),
  "notifications.onFailure": leaf("boolean", true),
});

const LEAF_KEYS = Object.freeze(Object.keys(HUB_SETTINGS_SCHEMA));
const RETRY_CLASS_KEYS = Object.freeze(LEAF_KEYS.filter((key) => key.startsWith("retry.perClass.")));
// The legacy key order of the managers' GET /api/download/settings.
const LEGACY_KEYS = Object.freeze(["queueMode", "autoRetryCount", "autoRetryDelaySeconds", "hfMirror", "hfTransfer", "verifyChecksums", "idleOnlyQueue"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getPath(object, key) {
  let current = object;
  for (const segment of key.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(object, key, value) {
  const segments = key.split(".");
  let current = object;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

function isBranch(key) {
  return LEAF_KEYS.some((name) => name.startsWith(`${key}.`));
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : JSON.stringify(value);
}

function issue(field, code, message) {
  return { field, code, message };
}

/** The full default settings, schemaVersion first. */
function defaultSettings() {
  const settings = { schemaVersion: SETTINGS_SCHEMA_VERSION };
  for (const key of LEAF_KEYS) setPath(settings, key, clone(HUB_SETTINGS_SCHEMA[key].default));
  return settings;
}

// Endpoints are https: without credentials, query or fragment (03 §14);
// loopback http: only under NODE_ENV=test. Returns the normalized URL
// (no trailing slash) or an issue.
function checkEndpoint(key, value, env) {
  if (typeof value !== "string" || !value.trim()) return { error: issue(key, "invalid_type", `${key} must be a URL string.`) };
  const text = value.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: issue(key, "invalid_format", `${key} is not a valid URL.`) };
  }
  if (url.username || url.password) return { error: issue(key, "invalid_format", `${key} must not carry a user name or password.`) };
  if (url.search || url.hash || text.includes("?") || text.includes("#")) {
    return { error: issue(key, "invalid_format", `${key} must not carry a query or fragment.`) };
  }
  const loopbackTest = url.protocol === "http:" && String(env?.NODE_ENV || "") === "test" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopbackTest) return { error: issue(key, "invalid_format", `${key} must be an https: URL.`) };
  return { value: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

// { value } or { error } for one leaf.
function checkLeaf(key, value, env) {
  const spec = HUB_SETTINGS_SCHEMA[key];
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? { value } : { error: issue(key, "invalid_type", `${key} must be true or false, not ${describe(value)}.`) };
    case "enum":
      return spec.values.includes(value)
        ? { value }
        : { error: issue(key, "invalid_value", `${key} must be one of ${spec.values.map((item) => JSON.stringify(item)).join(", ")}.`) };
    case "integer":
    case "number": {
      const ok = spec.type === "integer" ? Number.isInteger(value) : typeof value === "number" && Number.isFinite(value);
      if (!ok) return { error: issue(key, "invalid_type", `${key} must be ${spec.type === "integer" ? "a whole number" : "a number"}, not ${describe(value)}.`) };
      if (value < spec.min || value > spec.max) return { error: issue(key, "out_of_range", `${key} must be between ${spec.min} and ${spec.max}.`) };
      return { value };
    }
    case "endpoint":
      return checkEndpoint(key, value, env);
    default:
      return { error: issue(key, "invalid_value", `${key} cannot be set.`) };
  }
}

// Checks a nested patch in its own order: each valid leaf goes to `out` as
// [key, value]; unknown keys, a branch given a non-object and an invalid leaf
// are issues.
function collectPatch(patch, prefix, out, errors, env) {
  for (const [name, value] of Object.entries(patch)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (UNSAFE_KEYS.has(name)) {
      errors.push(issue(key, "unknown_key", `${key} is not a hub setting.`));
    } else if (Object.hasOwn(HUB_SETTINGS_SCHEMA, key)) {
      const checked = checkLeaf(key, value, env);
      if (checked.error) errors.push(checked.error);
      else out.push([key, checked.value]);
    } else if (isBranch(key)) {
      if (isPlainObject(value)) collectPatch(value, key, out, errors, env);
      else errors.push(issue(key, "invalid_type", `${key} must be an object, not ${describe(value)}.`));
    } else {
      errors.push(issue(key, "unknown_key", `${key} is not a hub setting.`));
    }
  }
}

function crossFieldErrors(settings) {
  const base = getPath(settings, "retry.baseDelaySeconds");
  const max = getPath(settings, "retry.maxDelaySeconds");
  if (Number.isInteger(base) && Number.isInteger(max) && max < base) {
    return [issue("retry.maxDelaySeconds", "out_of_range", "retry.maxDelaySeconds must be at least retry.baseDelaySeconds.")];
  }
  return [];
}

/**
 * Checks a partial patch (03 §14 PUT) and merges it into `base` (the current
 * settings, defaults when omitted). Returns { ok: true, settings, changed }
 * with the full merged settings, or { ok: false, errors } with one 00 §4.2
 * field error per problem; nothing is merged then.
 */
function validateSettings(patch, options = {}) {
  const env = options.env || process.env;
  const base = isPlainObject(options.base) ? options.base : defaultSettings();
  if (!isPlainObject(patch)) return { ok: false, errors: [issue("$body", "invalid_type", "The settings patch must be a JSON object.")] };
  const errors = [];
  const entries = [];
  const body = { ...patch };
  if (Object.hasOwn(body, "schemaVersion")) {
    if (body.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      errors.push(issue("schemaVersion", "invalid_value", `schemaVersion must be ${SETTINGS_SCHEMA_VERSION}.`));
    }
    delete body.schemaVersion;
  }
  collectPatch(body, "", entries, errors, env);
  const merged = normalizeSettings(base, { env }).settings;
  const changed = [];
  for (const [key, value] of entries) {
    if (JSON.stringify(getPath(merged, key)) !== JSON.stringify(value)) changed.push(key);
    setPath(merged, key, value);
  }
  errors.push(...crossFieldErrors(merged));
  if (errors.length) return { ok: false, errors };
  return { ok: true, settings: merged, changed };
}

/**
 * Reads stored settings tolerantly: every valid leaf is kept, an invalid or
 * missing one takes its default, unknown keys are dropped. Returns
 * { settings, errors } where errors name the leaves that fell back.
 */
function normalizeSettings(stored, options = {}) {
  const env = options.env || process.env;
  const settings = defaultSettings();
  const errors = [];
  if (!isPlainObject(stored)) return { settings, errors };
  for (const key of LEAF_KEYS) {
    const value = getPath(stored, key);
    if (value === undefined) continue;
    const checked = checkLeaf(key, value, env);
    if (checked.error) errors.push({ ...checked.error, message: `${checked.error.message} The default is used.` });
    else setPath(settings, key, checked.value);
  }
  const cross = crossFieldErrors(settings);
  if (cross.length) {
    setPath(settings, "retry.maxDelaySeconds", Math.max(getPath(settings, "retry.baseDelaySeconds"), HUB_SETTINGS_SCHEMA["retry.maxDelaySeconds"].default));
    errors.push(...cross.map((error) => ({ ...error, message: `${error.message} It was raised to fit.` })));
  }
  return { settings, errors };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function retryDisabled(settings) {
  return RETRY_CLASS_KEYS.every((key) => getPath(settings, key) === false);
}

/**
 * Maps the managers' legacy download settings to a hub settings patch
 * (03 §14 table). Only the keys present are mapped. `current` (the hub
 * settings) lets a non-zero retry count re-enable the retry classes that a
 * legacy count of 0 switched off.
 */
function fromLegacy(legacy, options = {}) {
  const input = isPlainObject(legacy) ? legacy : {};
  const current = isPlainObject(options.current) ? options.current : null;
  const patch = {};
  if (input.queueMode !== undefined) {
    // Legacy "off" ran every download at once; the hub caps that at 3.
    setPath(patch, "transfer.maxConcurrent", input.queueMode ? 1 : 3);
  }
  if (input.autoRetryCount !== undefined) {
    const count = clampInteger(input.autoRetryCount, 0, 10, HUB_SETTINGS_SCHEMA["retry.maxAttempts"].default);
    setPath(patch, "retry.maxAttempts", count);
    if (count === 0) {
      for (const key of RETRY_CLASS_KEYS) setPath(patch, key, false);
    } else if (current && retryDisabled(current)) {
      for (const key of RETRY_CLASS_KEYS) setPath(patch, key, clone(HUB_SETTINGS_SCHEMA[key].default));
    }
  }
  if (input.autoRetryDelaySeconds !== undefined) {
    const delay = clampInteger(input.autoRetryDelaySeconds, 1, 3600, HUB_SETTINGS_SCHEMA["retry.baseDelaySeconds"].default);
    setPath(patch, "retry.baseDelaySeconds", delay);
    const maxDelay = getPath(current || defaultSettings(), "retry.maxDelaySeconds");
    if (delay > maxDelay) setPath(patch, "retry.maxDelaySeconds", delay);
  }
  if (input.hfMirror !== undefined) setPath(patch, "sources.policy", input.hfMirror ? "hf-mirror" : "huggingface");
  if (input.hfTransfer !== undefined) setPath(patch, "transfer.xet", input.hfTransfer ? "high-performance" : "default");
  if (input.verifyChecksums !== undefined) setPath(patch, "verify.sha256", input.verifyChecksums !== false);
  if (input.idleOnlyQueue !== undefined) setPath(patch, "queue.idleOnly", Boolean(input.idleOnlyQueue));
  return patch;
}

/** The managers' legacy seven-key object for hub settings. */
function toLegacy(settings) {
  const source = normalizeSettings(settings).settings;
  return {
    queueMode: getPath(source, "transfer.maxConcurrent") === 1,
    autoRetryCount: retryDisabled(source) ? 0 : getPath(source, "retry.maxAttempts"),
    autoRetryDelaySeconds: clampInteger(getPath(source, "retry.baseDelaySeconds"), 1, 3600, 10),
    hfMirror: getPath(source, "sources.policy") === "hf-mirror",
    hfTransfer: getPath(source, "transfer.xet") === "high-performance",
    verifyChecksums: getPath(source, "verify.sha256") === true,
    idleOnlyQueue: getPath(source, "queue.idleOnly") === true,
  };
}

/**
 * The live settings of one hub over its store. load() reads settings.json
 * (a missing file means defaults and is left absent, so 03 §16's
 * settings-v1 migration can still tell it was never written); update()
 * validates against the current value and writes atomically. Updates are
 * serialized, so two PUTs never lose each other's change.
 */
function createSettingsService(options = {}) {
  const store = options.store;
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
    throw new TypeError("createSettingsService needs the hub store");
  }
  const env = options.env || process.env;
  let current = defaultSettings();
  let loaded = false;
  let fileErrors = [];
  let chain = Promise.resolve();

  function load() {
    const result = store.read("settings");
    fileErrors = [];
    if (result.error) {
      current = defaultSettings();
      fileErrors.push({ file: result.file, name: "settings.json", code: result.error.code, message: `${result.error.message} Default settings are in force until the settings are saved.` });
    } else if (result.exists) {
      const normalized = normalizeSettings(result.value, { env });
      current = normalized.settings;
      for (const error of normalized.errors) fileErrors.push({ file: result.file, name: "settings.json", ...error });
    } else {
      current = defaultSettings();
    }
    loaded = true;
    return { exists: result.exists, settings: clone(current) };
  }

  function get() {
    if (!loaded) load();
    return clone(current);
  }

  function update(patch) {
    const run = chain.then(async () => {
      if (!loaded) load();
      const checked = validateSettings(patch, { base: current, env });
      if (!checked.ok) return { ok: false, code: "settings_invalid", errors: checked.errors };
      await store.write("settings", checked.settings);
      current = checked.settings;
      fileErrors = [];
      return { ok: true, settings: clone(current), changed: checked.changed };
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    load,
    get,
    update,
    errors: () => clone(fileErrors),
  };
}

module.exports = {
  HUB_SETTINGS_SCHEMA,
  LEGACY_KEYS,
  SETTINGS_SCHEMA_VERSION,
  createSettingsService,
  defaultSettings,
  fromLegacy,
  normalizeSettings,
  toLegacy,
  validateSettings,
};
