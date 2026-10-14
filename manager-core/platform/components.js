"use strict";

// Component registry (docs/overhaul/06-ops.md §3): loads, validates, overrides
// and resolves manager-core/data/platform-components.json, builds the
// dependency graph and maps changed paths to components. Plain CommonJS with
// no dependencies; config.js is loaded lazily so a caller that only orders
// components pays nothing.
//
// - loadComponentRegistry: the bundled file plus components.<id> overrides from
//   platform.json (§3.6). Never throws: a bad override or a bad entry goes to
//   registry.errors and the bundled entry stays in force.
// - resolveComponent: absolute cwd, argv, env, ports and urls for one entry.
//   The resolved env holds secret values taken from the secret store (the
//   child gets them only through env), so a ResolvedComponent is never logged
//   or serialised to a client.
// - startOrder / stopOrder / selectProfile / componentsForPaths: pure graph
//   and glob helpers for the supervisor and the deploy steps.

const fs = require("node:fs");
const path = require("node:path");

const BUNDLED_FILE = path.join(__dirname, "..", "data", "platform-components.json");
const HOOK_DIR = path.join(__dirname, "hooks");
const REGISTRY_SCHEMA_VERSION = 1;

// The old /api/status ids (§3.2). `entry` kept its id, so it is not listed.
const LEGACY_IDS = Object.freeze({
  vllm: "vllm-manager",
  llama: "llama-manager",
  tts: "tts-gateway",
  mcp: "platform-mcp",
  search: "search-gateway",
});
const PROFILE_ALIASES = Object.freeze({ all: "full" });
const PROFILES = Object.freeze(["core", "full", "none"]);
const SELECTABLE_PROFILES = Object.freeze(["core", "full"]);
// Pseudo id for changes that need a supervisor re-exec rather than a component restart (§9.3).
const SUPERVISOR_ID = "supervisor";
const SUPERVISOR_PATHS = Object.freeze([
  "scripts/platformctl.js",
  "manager-core/platform/**",
  "manager-core/data/platform-components.json",
  "manager-core/data/platform-config.schema.json",
  "manager-core/data/platform-config.d/**",
]);

const KINDS = Object.freeze(["node", "process", "group", "compose", "external", "listener"]);
const OVERRIDE_KINDS = Object.freeze(["external", "compose"]);
const STOP_STRATEGIES = Object.freeze(["http-then-kill", "kill", "script-then-kill", "compose", "never"]);
const RESTART_MODES = Object.freeze(["on-failure", "always", "never", "docker"]);
const ON_FAILURE = Object.freeze(["report", "restart"]);
const OVERRIDE_FIELDS = Object.freeze(["autostart", "profile", "disabled", "restartPolicy", "liveness", "env", "args"]);
const FORBIDDEN_OVERRIDE_FIELDS = Object.freeze(["command", "cwd", "kind"]);

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const HOOK_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DISTRO_PATTERN = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER_PATTERN = /\$\{([^}]*)\}/g;
const WHOLE_PLACEHOLDER_PATTERN = /^\$\{([^}]*)\}$/;
const ROOTED_PATH_PATTERN = /^\$\{(?:AI_ROOT|TTS_RUNTIME_ROOT)\}[\\/]/;
const SIMPLE_PLACEHOLDERS = Object.freeze(["AI_ROOT", "NODE", "PWSH", "DOCKER", "TTS_RUNTIME_ROOT"]);
const LOCALES = Object.freeze(["zh-CN", "en-US"]);
// Fields whose text is copy, not launch data; placeholders are not expanded there.
const COPY_FIELDS = new Set(["label", "description", "$comment"]);

const DEFAULT_RESTART_POLICY = Object.freeze({
  mode: "on-failure",
  maxRestarts: 5,
  windowSec: 600,
  backoffSec: Object.freeze([1, 2, 5, 15, 30, 60]),
  stableAfterSec: 600,
});
const DEFAULT_READINESS_INTERVAL_MS = 1000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stripBom(text) {
  return String(text).replace(/^﻿/, "");
}

function registryError(id, field, code, message) {
  return { id, field, code, message };
}

function lazyConfig() {
  return require("./config");
}

// ---------------------------------------------------------------------------
// Validation

function configKeys(config) {
  let schema = config?.schema;
  if (!schema) {
    try {
      schema = lazyConfig().loadPlatformSchema();
    } catch {
      schema = null;
    }
  }
  return schema?.leaves instanceof Map ? new Set(schema.leaves.keys()) : null;
}

function walkStrings(value, visit, field = "") {
  if (typeof value === "string") {
    visit(value, field);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, visit, `${field}[${index}]`));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!field && COPY_FIELDS.has(key)) continue;
      walkStrings(item, visit, field ? `${field}.${key}` : key);
    }
  }
}

function checkPlaceholders(spec, keys, errors) {
  const id = spec.id;
  const portNames = new Set((Array.isArray(spec.ports) ? spec.ports : []).map((port) => port?.name));
  const scan = (scopeNames, root, rootField) => {
    walkStrings(root, (text, field) => {
      const whole = WHOLE_PLACEHOLDER_PATTERN.exec(text);
      for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
        const token = match[1];
        const where = rootField ? `${rootField}${field ? `.${field}` : ""}` : field;
        if (token === "DOCKER") {
          // ${DOCKER} is an array element (it expands to several argv items).
          const isElement = Boolean(whole) && /\[\d+\]$/.test(field);
          if (!isElement) errors.push(registryError(id, where, "placeholder_position", "${DOCKER} is only valid as a whole array element."));
        } else if (SIMPLE_PLACEHOLDERS.includes(token)) {
          // known
        } else if (token.startsWith("config:")) {
          const key = token.slice("config:".length);
          if (keys && !keys.has(key)) errors.push(registryError(id, where, "unknown_placeholder", `\${${token}} is not a platform config key.`));
        } else if (token.startsWith("port:")) {
          if (!scopeNames.has(token.slice("port:".length))) errors.push(registryError(id, where, "unknown_placeholder", `\${${token}} names no port of ${id}.`));
        } else {
          errors.push(registryError(id, where, "unknown_placeholder", `\${${token}} is not a known placeholder.`));
        }
      }
    });
  };
  const { members, ...rest } = spec;
  scan(portNames, rest, "");
  if (Array.isArray(members)) {
    members.forEach((member, index) => {
      const names = new Set((Array.isArray(member?.ports) ? member.ports : []).map((port) => port?.name));
      scan(names, member, `members[${index}]`);
    });
  }
}

function checkCopy(spec, errors, field, required) {
  const value = spec[field];
  if (value === undefined) {
    if (required) errors.push(registryError(spec.id, field, "missing_field", `${field} needs zh-CN and en-US text.`));
    return;
  }
  if (!isPlainObject(value) || LOCALES.some((locale) => typeof value[locale] !== "string" || !value[locale].trim())) {
    errors.push(registryError(spec.id, field, "invalid_copy", `${field} needs non-empty zh-CN and en-US text.`));
  }
}

function checkPorts(id, ports, errors, field = "ports") {
  if (ports === undefined) return;
  if (!Array.isArray(ports)) {
    errors.push(registryError(id, field, "invalid_type", `${field} must be an array.`));
    return;
  }
  const seen = new Set();
  ports.forEach((port, index) => {
    const at = `${field}[${index}]`;
    if (!isPlainObject(port) || typeof port.name !== "string" || !port.name) {
      errors.push(registryError(id, at, "invalid_port", "A port needs a name."));
      return;
    }
    if (seen.has(port.name)) errors.push(registryError(id, at, "duplicate_port", `Port name ${port.name} is used twice.`));
    seen.add(port.name);
    const numeric = Number.isInteger(port.port) && port.port >= 1 && port.port <= 65535;
    if (!numeric && typeof port.port !== "string") errors.push(registryError(id, `${at}.port`, "invalid_port", "A port is 1-65535 or a ${config:...} placeholder."));
    if (typeof port.bind !== "string" || !port.bind) errors.push(registryError(id, `${at}.bind`, "invalid_port", "A port needs a bind address."));
  });
}

function checkProbe(id, field, probe, errors) {
  if (probe === undefined) return;
  if (!isPlainObject(probe)) {
    errors.push(registryError(id, field, "invalid_type", `${field} must be an object.`));
    return;
  }
  const kinds = ["http", "tcp", "command"].filter((key) => probe[key] !== undefined);
  if (kinds.length !== 1) errors.push(registryError(id, field, "invalid_probe", `${field} needs exactly one of http, tcp or command.`));
  if (probe.command !== undefined && (!Array.isArray(probe.command) || probe.command.some((item) => typeof item !== "string"))) {
    errors.push(registryError(id, `${field}.command`, "invalid_probe", "A command probe is an array of strings."));
  }
}

function checkRestartPolicy(id, policy, errors, field = "restartPolicy") {
  if (policy === undefined) return;
  if (!isPlainObject(policy)) {
    errors.push(registryError(id, field, "invalid_type", `${field} must be an object.`));
    return;
  }
  if (policy.mode !== undefined && !RESTART_MODES.includes(policy.mode)) errors.push(registryError(id, `${field}.mode`, "invalid_value", `mode is one of ${RESTART_MODES.join(", ")}.`));
  for (const key of ["maxRestarts", "windowSec", "stableAfterSec"]) {
    if (policy[key] !== undefined && !(Number.isInteger(policy[key]) && policy[key] >= 0)) errors.push(registryError(id, `${field}.${key}`, "invalid_value", `${key} must be a non-negative integer.`));
  }
  if (policy.backoffSec !== undefined && !(Array.isArray(policy.backoffSec) && policy.backoffSec.length && policy.backoffSec.every((item) => Number.isFinite(item) && item >= 0))) {
    errors.push(registryError(id, `${field}.backoffSec`, "invalid_value", "backoffSec is a non-empty list of seconds."));
  }
}

function checkStop(id, stop, errors, field = "stop") {
  if (stop === undefined) return;
  if (!isPlainObject(stop) || !STOP_STRATEGIES.includes(stop.strategy)) {
    errors.push(registryError(id, `${field}.strategy`, "invalid_value", `strategy is one of ${STOP_STRATEGIES.join(", ")}.`));
    return;
  }
  if (stop.strategy === "http-then-kill" && typeof stop.http !== "string") errors.push(registryError(id, `${field}.http`, "missing_field", "http-then-kill needs a stop URL."));
  if (stop.strategy === "script-then-kill" && !(Array.isArray(stop.script) && stop.script.length)) errors.push(registryError(id, `${field}.script`, "missing_field", "script-then-kill needs a script command."));
  if (stop.auth !== undefined && stop.auth !== "system") errors.push(registryError(id, `${field}.auth`, "invalid_value", 'auth can only be "system".'));
}

function checkStringList(id, field, value, errors) {
  if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
    errors.push(registryError(id, field, "invalid_type", `${field} must be an array of strings.`));
  }
}

function checkEnv(id, field, env, errors) {
  if (env === undefined) return;
  if (!isPlainObject(env)) {
    errors.push(registryError(id, field, "invalid_type", `${field} must be an object of strings.`));
    return;
  }
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_PATTERN.test(name) || typeof value !== "string") errors.push(registryError(id, `${field}.${name}`, "invalid_env", "An env entry is NAME: string."));
  }
}

function checkLaunch(id, spec, errors, field = "") {
  const at = (name) => (field ? `${field}.${name}` : name);
  if (typeof spec.command !== "string" || !spec.command) errors.push(registryError(id, at("command"), "missing_field", "A process needs a command."));
  checkStringList(id, at("args"), spec.args, errors);
  checkEnv(id, at("env"), spec.env, errors);
}

/** Validation errors for one registry entry (shape only; references are checked across the registry). */
function validateComponentSpec(spec, { keys = null } = {}) {
  const errors = [];
  if (!isPlainObject(spec)) return [registryError("", "", "invalid_type", "A component must be an object.")];
  const id = typeof spec.id === "string" ? spec.id : "";
  if (!ID_PATTERN.test(id)) return [registryError(id, "id", "invalid_id", "id must match [a-z][a-z0-9-]{1,31}.")];
  if (!KINDS.includes(spec.kind)) errors.push(registryError(id, "kind", "invalid_value", `kind is one of ${KINDS.join(", ")}.`));
  if (!PROFILES.includes(spec.profile)) errors.push(registryError(id, "profile", "invalid_value", `profile is one of ${PROFILES.join(", ")}.`));
  if (spec.autostart !== undefined && typeof spec.autostart !== "boolean") errors.push(registryError(id, "autostart", "invalid_type", "autostart must be true or false."));
  checkCopy(spec, errors, "label", true);
  checkCopy(spec, errors, "description", false);
  checkStringList(id, "dependsOn", spec.dependsOn, errors);
  checkStringList(id, "after", spec.after, errors);
  checkStringList(id, "paths", spec.paths, errors);
  checkStringList(id, "extraLogs", spec.extraLogs, errors);
  checkPorts(id, spec.ports, errors);
  checkProbe(id, "readiness", spec.readiness, errors);
  checkProbe(id, "liveness", spec.liveness, errors);
  if (spec.liveness?.onFailure !== undefined && !ON_FAILURE.includes(spec.liveness.onFailure)) errors.push(registryError(id, "liveness.onFailure", "invalid_value", `onFailure is one of ${ON_FAILURE.join(", ")}.`));
  checkRestartPolicy(id, spec.restartPolicy, errors);
  checkStop(id, spec.stop, errors);
  if (spec.hook !== undefined && !(typeof spec.hook === "string" && HOOK_PATTERN.test(spec.hook))) errors.push(registryError(id, "hook", "invalid_value", "hook is a hook module name."));
  if (spec.docs !== undefined && !(typeof spec.docs === "string" && spec.docs.startsWith("/"))) errors.push(registryError(id, "docs", "invalid_value", "docs is a URL path."));
  switch (spec.kind) {
    case "node":
    case "process":
      checkLaunch(id, spec, errors);
      break;
    case "group":
      if (!Array.isArray(spec.members) || !spec.members.length) {
        errors.push(registryError(id, "members", "missing_field", "A group needs members."));
      } else {
        const names = new Set();
        spec.members.forEach((member, index) => {
          const at = `members[${index}]`;
          if (!isPlainObject(member) || typeof member.name !== "string" || !member.name) {
            errors.push(registryError(id, at, "invalid_member", "A member needs a name."));
            return;
          }
          if (names.has(member.name)) errors.push(registryError(id, `${at}.name`, "duplicate_member", `Member ${member.name} is listed twice.`));
          names.add(member.name);
          checkLaunch(id, member, errors, at);
          checkPorts(id, member.ports, errors, `${at}.ports`);
          checkProbe(id, `${at}.readiness`, member.readiness, errors);
          checkStop(id, member.stop, errors, `${at}.stop`);
          checkStringList(id, `${at}.dependsOn`, member.dependsOn, errors);
        });
      }
      break;
    case "compose":
      if (!isPlainObject(spec.compose) || typeof spec.compose.file !== "string" || typeof spec.compose.project !== "string") {
        errors.push(registryError(id, "compose", "missing_field", "A compose component needs compose.file and compose.project."));
      }
      break;
    case "listener":
      if (typeof spec.parent !== "string") errors.push(registryError(id, "parent", "missing_field", "A listener needs its parent component."));
      if (!Array.isArray(spec.ports) || !spec.ports.length) errors.push(registryError(id, "ports", "missing_field", "A listener needs ports."));
      break;
    default:
      break;
  }
  checkPlaceholders(spec, keys, errors);
  return errors;
}

function checkReferences(components, errors) {
  const ids = new Set(components.map((component) => component.id));
  for (const component of components) {
    for (const field of ["dependsOn", "after"]) {
      for (const target of Array.isArray(component[field]) ? component[field] : []) {
        if (!ids.has(target)) errors.push(registryError(component.id, field, "unknown_reference", `${field} names unknown component ${target}.`));
        else if (target === component.id) errors.push(registryError(component.id, field, "unknown_reference", `${component.id} cannot depend on itself.`));
      }
    }
    if (component.kind === "listener" && component.parent && !ids.has(component.parent)) {
      errors.push(registryError(component.id, "parent", "unknown_reference", `parent names unknown component ${component.parent}.`));
    }
    for (const [index, member] of (Array.isArray(component.members) ? component.members : []).entries()) {
      for (const target of Array.isArray(member?.dependsOn) ? member.dependsOn : []) {
        if (!ids.has(target)) errors.push(registryError(component.id, `members[${index}].dependsOn`, "unknown_reference", `dependsOn names unknown component ${target}.`));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Load and override

function describeFreshness(data, now) {
  const asOf = Date.parse(String(data?.asOf || ""));
  const staleAfterDays = Number(data?.staleAfterDays || 0);
  const ageDays = Number.isFinite(asOf) ? Math.max(0, Math.floor((now - asOf) / DAY_MS)) : null;
  return {
    asOf: data?.asOf || "",
    ageDays,
    staleAfterDays: staleAfterDays || null,
    stale: ageDays !== null && staleAfterDays > 0 && ageDays > staleAfterDays,
  };
}

function readBundled(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { error: registryError("$registry", "$file", "registry_unreadable", `The component registry cannot be read (${error?.code || "error"}).`) };
  }
  try {
    const parsed = JSON.parse(stripBom(text));
    if (!isPlainObject(parsed)) throw new Error("not an object");
    return { parsed };
  } catch {
    return { error: registryError("$registry", "$file", "registry_corrupt", "The component registry is not valid JSON.") };
  }
}

function overrideEntries(config) {
  const source = config?.values?.components ?? config?.components;
  return isPlainObject(source) ? Object.entries(source) : [];
}

function envFromOverride(env) {
  if (isPlainObject(env)) return env;
  if (Array.isArray(env)) {
    const result = {};
    for (const item of env) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(String(item));
      if (!match) return null;
      result[match[1]] = match[2];
    }
    return result;
  }
  return null;
}

function mergeOverride(spec, override, errors) {
  const id = spec.id;
  const problems = [];
  for (const key of Object.keys(override)) {
    if (FORBIDDEN_OVERRIDE_FIELDS.includes(key)) problems.push(registryError(id, `components.${id}.${key}`, "forbidden_override_field", `${key} cannot be overridden.`));
    else if (!OVERRIDE_FIELDS.includes(key)) problems.push(registryError(id, `components.${id}.${key}`, "unknown_override_field", `${key} is not an overridable field.`));
  }
  const merged = clone(spec);
  if (override.autostart !== undefined) merged.autostart = override.autostart;
  if (override.profile !== undefined) merged.profile = override.profile;
  if (override.disabled !== undefined) {
    if (typeof override.disabled === "boolean") merged.disabled = override.disabled;
    else problems.push(registryError(id, `components.${id}.disabled`, "invalid_type", "disabled must be true or false."));
  }
  if (override.restartPolicy !== undefined) merged.restartPolicy = { ...(merged.restartPolicy || {}), ...(isPlainObject(override.restartPolicy) ? override.restartPolicy : { mode: "invalid" }) };
  if (override.liveness !== undefined) {
    const onFailure = isPlainObject(override.liveness) ? override.liveness.onFailure : undefined;
    const extra = isPlainObject(override.liveness) ? Object.keys(override.liveness).filter((key) => key !== "onFailure") : ["liveness"];
    for (const key of extra) problems.push(registryError(id, `components.${id}.liveness.${key}`, "unknown_override_field", "Only liveness.onFailure can be overridden."));
    if (onFailure !== undefined) {
      if (!merged.liveness) problems.push(registryError(id, `components.${id}.liveness`, "invalid_value", `${id} has no liveness probe to change.`));
      else merged.liveness = { ...merged.liveness, onFailure };
    }
  }
  if (override.env !== undefined) {
    const extraEnv = envFromOverride(override.env);
    if (!extraEnv) problems.push(registryError(id, `components.${id}.env`, "invalid_env", "env is an object or a list of NAME=value."));
    else merged.env = { ...(merged.env || {}), ...extraEnv };
  }
  if (override.args !== undefined) merged.args = override.args;
  problems.push(...validateComponentSpec(merged, { keys: null }).map((error) => ({ ...error, field: error.field.startsWith("components.") ? error.field : `components.${id}.${error.field}` })));
  if (problems.length) {
    errors.push(...problems);
    return null;
  }
  return merged;
}

/**
 * The registry for this AI root (§3.7): the bundled entries with the
 * components.<id> overrides of platform.json merged by id. Never throws.
 */
function loadComponentRegistry({ aiRoot, config, bundledFile = BUNDLED_FILE, now = Date.now() } = {}) {
  void aiRoot;
  const errors = [];
  const read = readBundled(bundledFile);
  const registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    asOf: "",
    staleAfterDays: null,
    freshness: describeFreshness({}, now),
    requirements: {},
    packages: [],
    components: [],
    errors,
    overridden: [],
  };
  if (read.error) {
    errors.push(read.error);
    return registry;
  }
  const data = read.parsed;
  if (data.schemaVersion !== REGISTRY_SCHEMA_VERSION) errors.push(registryError("$registry", "schemaVersion", "unsupported_schema_version", `schemaVersion ${data.schemaVersion} is not supported.`));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.asOf || ""))) errors.push(registryError("$registry", "asOf", "missing_field", "asOf is a date (YYYY-MM-DD)."));
  if (!(Number.isInteger(data.staleAfterDays) && data.staleAfterDays > 0)) errors.push(registryError("$registry", "staleAfterDays", "missing_field", "staleAfterDays is a positive number of days."));
  registry.asOf = String(data.asOf || "");
  registry.staleAfterDays = Number.isInteger(data.staleAfterDays) ? data.staleAfterDays : null;
  registry.freshness = describeFreshness(data, now);
  registry.requirements = isPlainObject(data.requirements) ? clone(data.requirements) : {};
  registry.packages = Array.isArray(data.packages) ? clone(data.packages) : [];

  const keys = configKeys(config);
  const seen = new Set();
  for (const spec of Array.isArray(data.components) ? data.components : []) {
    const problems = validateComponentSpec(spec, { keys });
    errors.push(...problems);
    if (!isPlainObject(spec) || typeof spec.id !== "string") continue;
    if (seen.has(spec.id)) {
      errors.push(registryError(spec.id, "id", "duplicate_id", `Component id ${spec.id} is used twice.`));
      continue;
    }
    seen.add(spec.id);
    registry.components.push(clone(spec));
  }

  for (const [id, override] of overrideEntries(config)) {
    if (!isPlainObject(override)) {
      errors.push(registryError(id, `components.${id}`, "invalid_type", "An override must be an object."));
      continue;
    }
    const index = registry.components.findIndex((component) => component.id === id);
    if (index === -1) {
      const added = acceptNewComponent(id, override, errors, keys);
      if (added) {
        registry.components.push(added);
        registry.overridden.push(id);
      }
      continue;
    }
    const merged = mergeOverride(registry.components[index], override, errors);
    if (merged) {
      registry.components[index] = merged;
      registry.overridden.push(id);
    }
  }

  checkReferences(registry.components, errors);
  Object.defineProperty(registry, "byId", {
    enumerable: false,
    value: new Map(registry.components.map((component) => [component.id, component])),
  });
  return registry;
}

// New ids from overrides: only kind external | compose (the extension slot for 05's tunnel, §3.6).
function acceptNewComponent(id, override, errors, keys) {
  const field = `components.${id}`;
  if (!ID_PATTERN.test(id)) {
    errors.push(registryError(id, field, "invalid_id", "id must match [a-z][a-z0-9-]{1,31}."));
    return null;
  }
  if (!OVERRIDE_KINDS.includes(override.kind)) {
    errors.push(registryError(id, field, "unknown_component", `${id} is not a bundled component; new components must be kind ${OVERRIDE_KINDS.join(" or ")}.`));
    return null;
  }
  const spec = { profile: "none", autostart: false, ...clone(override), id };
  const problems = validateComponentSpec(spec, { keys });
  if (spec.hook !== undefined) problems.push(registryError(id, `${field}.hook`, "forbidden_override_field", "An added component cannot use a hook."));
  if (problems.length) {
    errors.push(...problems.map((problem) => ({ ...problem, field: `${field}.${problem.field}` })));
    return null;
  }
  return spec;
}

/** Looks a component up by registry id or by its legacy /api/status id. */
function getComponent(registry, idOrLegacy) {
  const wanted = String(idOrLegacy || "");
  const components = Array.isArray(registry?.components) ? registry.components : [];
  return components.find((component) => component.id === wanted)
    || components.find((component) => component.legacyId === wanted)
    || null;
}

// ---------------------------------------------------------------------------
// Profiles and ordering

function selectProfile(registry, profile, { includeOnDemand = false } = {}) {
  const name = PROFILE_ALIASES[String(profile || "")] || String(profile || "");
  if (!SELECTABLE_PROFILES.includes(name)) {
    const error = new Error(`Unknown profile "${profile}"; use ${SELECTABLE_PROFILES.join(" or ")} (or all).`);
    error.code = "E_UNKNOWN_PROFILE";
    throw error;
  }
  const wanted = name === "full" ? ["core", "full"] : ["core"];
  return registry.components
    .filter((component) => wanted.includes(component.profile))
    .filter((component) => component.disabled !== true)
    .filter((component) => includeOnDemand || component.autostart !== false)
    .map((component) => component.id);
}

function edgesFor(component, selected) {
  const targets = [...(component.dependsOn || []), ...(component.after || [])];
  if (component.kind === "listener" && component.parent) targets.push(component.parent);
  return Array.from(new Set(targets)).filter((target) => selected.has(target) && target !== component.id);
}

/** Topological order over dependsOn, after and a listener's parent; ties keep registry order. Throws E_CYCLE. */
function startOrder(registry, ids) {
  const index = new Map(registry.components.map((component, position) => [component.id, position]));
  const selected = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const component = getComponent(registry, raw);
    if (!component) {
      const error = new Error(`Unknown component "${raw}".`);
      error.code = "E_UNKNOWN_COMPONENT";
      throw error;
    }
    selected.add(component.id);
  }
  const edges = new Map();
  for (const id of selected) edges.set(id, edgesFor(registry.components[index.get(id)], selected));
  const cycle = findCycle(edges, index);
  if (cycle) {
    const error = new Error(`Component dependency cycle: ${cycle.join(" -> ")}.`);
    error.code = "E_CYCLE";
    error.cycle = cycle;
    throw error;
  }
  const done = new Set();
  const order = [];
  while (order.length < selected.size) {
    const ready = Array.from(selected)
      .filter((id) => !done.has(id) && edges.get(id).every((target) => done.has(target)))
      .sort((left, right) => index.get(left) - index.get(right));
    done.add(ready[0]);
    order.push(ready[0]);
  }
  return order;
}

function findCycle(edges, index) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const target of edges.get(id)) {
      if (state.get(target) === 1) return [...stack.slice(stack.indexOf(target)), target];
      if (!state.has(target)) {
        const found = visit(target);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of Array.from(edges.keys()).sort((left, right) => index.get(left) - index.get(right))) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Reverse start order. docker, listeners and detect-only entries are never stopped by the platform. */
function stopOrder(registry, ids) {
  return startOrder(registry, ids)
    .reverse()
    .filter((id) => {
      const component = registry.components.find((candidate) => candidate.id === id);
      return !(component.kind === "listener" || component.detectOnly === true || component.id === "docker" || component.stop?.strategy === "never");
    });
}

// ---------------------------------------------------------------------------
// Paths to components (deploy restart mapping, §9.3)

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  let source = "";
  const text = String(glob).replace(/\\/g, "/");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "*") {
      if (text[index + 1] === "*") {
        index += 1;
        if (text[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function matchesGlobs(globs, relPath) {
  let included = false;
  for (const glob of globs) {
    const negated = glob.startsWith("!");
    if (globToRegExp(negated ? glob.slice(1) : glob).test(relPath)) included = !negated;
  }
  return included;
}

function normalizeRelPath(text) {
  return String(text || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** The components (and the pseudo id "supervisor") that a set of changed repo-relative paths affects. */
function componentsForPaths(registry, relPaths) {
  const result = new Set();
  for (const raw of Array.isArray(relPaths) ? relPaths : Array.from(relPaths || [])) {
    const relPath = normalizeRelPath(raw);
    if (!relPath) continue;
    if (matchesGlobs(SUPERVISOR_PATHS, relPath)) result.add(SUPERVISOR_ID);
    for (const component of registry.components) {
      if (Array.isArray(component.paths) && matchesGlobs(component.paths, relPath)) result.add(component.id);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Resolution

function findOnPath(names, env) {
  const directories = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const directory of directories) {
      try {
        if (fs.statSync(path.join(directory, name)).isFile()) return name;
      } catch {
        // not here
      }
    }
  }
  return "";
}

function runtimeDefaults(runtime, config, aiRoot) {
  const env = runtime.env || process.env;
  // paths.ttsRuntimeRoot already reads TTS_RUNTIME_ROOT from the env the config was loaded with.
  const configured = String(config?.values?.["paths.ttsRuntimeRoot"] || "").trim();
  return {
    nodeExe: runtime.nodeExe || process.execPath,
    pwsh: runtime.pwsh || (findOnPath(["pwsh.exe", "pwsh"], env) ? "pwsh.exe" : "powershell.exe"),
    dockerExe: runtime.dockerExe || "docker.exe",
    wslExe: runtime.wslExe || "wsl.exe",
    ttsRuntimeRoot: path.resolve(aiRoot, runtime.ttsRuntimeRoot || configured || "tts-runtime"),
  };
}

function resolveContext(spec, { aiRoot, config, runtime = {} }) {
  const root = path.resolve(String(aiRoot || process.env.AI_ROOT || path.resolve(__dirname, "..", "..")));
  const loaded = config || lazyConfig().loadPlatformConfig({ aiRoot: root, env: runtime.env || process.env });
  return { root, loaded, defaults: runtimeDefaults(runtime, loaded, root), runtime, problems: [], spec };
}

function expandToken(token, ctx, portValues) {
  if (token === "AI_ROOT") return ctx.root;
  if (token === "NODE") return ctx.defaults.nodeExe;
  if (token === "PWSH") return ctx.defaults.pwsh;
  if (token === "TTS_RUNTIME_ROOT") return ctx.defaults.ttsRuntimeRoot;
  if (token.startsWith("config:")) {
    const key = token.slice("config:".length);
    const value = ctx.loaded.values?.[key];
    if (value === undefined) {
      ctx.problems.push(registryError(ctx.spec.id, key, "unknown_placeholder", `\${${token}} is not a platform config key.`));
      return "";
    }
    return value;
  }
  if (token.startsWith("port:")) {
    const name = token.slice("port:".length);
    if (!portValues.has(name)) {
      ctx.problems.push(registryError(ctx.spec.id, name, "unknown_placeholder", `\${${token}} names no port of ${ctx.spec.id}.`));
      return "";
    }
    return portValues.get(name);
  }
  ctx.problems.push(registryError(ctx.spec.id, token, "unknown_placeholder", `\${${token}} is not a known placeholder.`));
  return "";
}

function dockerArgv(ctx) {
  const distro = String(ctx.loaded.values?.["docker.wslDistro"] || "").trim();
  if (!distro) return [ctx.defaults.dockerExe];
  if (!DISTRO_PATTERN.test(distro)) {
    ctx.problems.push(registryError(ctx.spec.id, "docker.wslDistro", "invalid_value", "docker.wslDistro contains unsupported characters."));
    return [ctx.defaults.dockerExe];
  }
  return [ctx.defaults.wslExe, "-d", distro, "--exec", "docker"];
}

function expandValue(value, ctx, portValues) {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER_PATTERN.exec(value);
    if (whole) return expandToken(whole[1], ctx, portValues);
    const text = value.replace(PLACEHOLDER_PATTERN, (match, token) => String(expandToken(token, ctx, portValues)));
    // A path built on a root placeholder gets native separators (no mixed slashes).
    return ROOTED_PATH_PATTERN.test(value) ? path.normalize(text) : text;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item === "${DOCKER}") out.push(...dockerArgv(ctx));
      else out.push(expandValue(item, ctx, portValues));
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandValue(item, ctx, portValues);
    return out;
  }
  return value;
}

function resolvePorts(ports, ctx) {
  const noPorts = new Map();
  const resolved = (Array.isArray(ports) ? ports : []).map((port) => {
    const number = Number(expandValue(port.port, ctx, noPorts));
    const when = port.when === undefined ? true : expandValue(port.when, ctx, noPorts);
    const entry = { name: port.name, port: Number.isInteger(number) ? number : 0, bind: String(expandValue(port.bind, ctx, noPorts)), enabled: when === true || when === "true" };
    if (!Number.isInteger(number) || number < 1 || number > 65535) ctx.problems.push(registryError(ctx.spec.id, `ports.${port.name}`, "invalid_port", `Port ${port.name} resolved to ${JSON.stringify(expandValue(port.port, ctx, noPorts))}.`));
    return entry;
  });
  return resolved;
}

function portTable(ports) {
  return new Map(ports.map((port) => [port.name, port.port]));
}

function urlsFor(ports) {
  const urls = {};
  for (const port of ports) if (port.enabled) urls[port.name] = `http://127.0.0.1:${port.port}`;
  return urls;
}

function withDefaults(spec, expanded) {
  const out = {};
  if (expanded.readiness) out.readiness = { intervalMs: DEFAULT_READINESS_INTERVAL_MS, ...expanded.readiness };
  if (expanded.liveness) out.liveness = { timeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS, onFailure: "report", ...expanded.liveness };
  out.restartPolicy = { ...clone(DEFAULT_RESTART_POLICY), ...(expanded.restartPolicy || {}) };
  return out;
}

function childEnvFor(ctx, componentId, registry) {
  const { childEnv } = lazyConfig();
  const known = registry || ctx.runtime.registry || { components: [ctx.spec] };
  return childEnv(ctx.loaded, componentId, known, { secrets: ctx.runtime.secrets }).env;
}

const ENV_KINDS = new Set(["node", "process", "compose", "group"]);

function resolveLaunch(source, expandedSource, ctx, portValues, baseEnv) {
  const argv = [expandedSource.command, ...(Array.isArray(expandedSource.args) ? expandedSource.args : [])];
  return {
    cwd: path.resolve(ctx.root, expandedSource.cwd || "."),
    command: expandedSource.command,
    args: Array.isArray(expandedSource.args) ? expandedSource.args : [],
    argv,
    env: { ...baseEnv, ...(expandedSource.env || {}) },
  };
}

/**
 * One registry entry with every placeholder expanded (§3.3): absolute cwd,
 * argv, env (config-derived env from childEnv, then the entry's own env),
 * ports, urls and probes. An unknown placeholder never throws; it fills
 * `problems` and sets `blocked`.
 */
function resolveComponent(spec, { aiRoot, config, runtime = {} } = {}) {
  const ctx = resolveContext(spec, { aiRoot, config, runtime });
  const ports = resolvePorts(spec.ports, ctx);
  const portValues = portTable(ports);
  const expanded = {};
  for (const [key, value] of Object.entries(spec)) {
    if (COPY_FIELDS.has(key) || key === "ports" || key === "members") continue;
    expanded[key] = expandValue(value, ctx, portValues);
  }
  const baseEnv = ENV_KINDS.has(spec.kind) ? childEnvFor(ctx, spec.id) : {};
  const resolved = {
    id: spec.id,
    ...(spec.legacyId ? { legacyId: spec.legacyId } : {}),
    kind: spec.kind,
    profile: spec.profile,
    autostart: spec.autostart === undefined ? spec.profile !== "none" : spec.autostart,
    disabled: spec.disabled === true,
    label: clone(spec.label),
    ...(spec.description ? { description: clone(spec.description) } : {}),
    ...(spec.parent ? { parent: spec.parent } : {}),
    ...(spec.deprecated ? { deprecated: true } : {}),
    ...(spec.detectOnly ? { detectOnly: true } : {}),
    ...(spec.detect ? { detect: clone(spec.detect) } : {}),
    dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn.slice() : [],
    after: Array.isArray(spec.after) ? spec.after.slice() : [],
    ports,
    urls: urlsFor(ports),
    ...withDefaults(spec, expanded),
  };
  if (spec.kind === "node" || spec.kind === "process") {
    Object.assign(resolved, resolveLaunch(spec, expanded, ctx, portValues, baseEnv));
  }
  if (spec.kind === "compose") {
    resolved.cwd = ctx.root;
    resolved.env = { ...baseEnv, ...(expanded.env || {}) };
    resolved.compose = { ...expanded.compose, file: path.resolve(ctx.root, expanded.compose.file) };
  }
  if (spec.kind === "group") {
    resolved.cwd = ctx.root;
    resolved.members = (spec.members || []).map((member) => resolveMember(member, ctx, baseEnv));
  }
  if (spec.kind === "listener") {
    resolved.enabled = ports.some((port) => port.enabled);
  }
  for (const key of ["stop", "busy", "ensure", "hook", "docs", "paths"]) {
    if (expanded[key] !== undefined) resolved[key] = expanded[key];
  }
  if (expanded.requires) {
    resolved.requires = { ...expanded.requires };
    if (Array.isArray(expanded.requires.files)) resolved.requires.files = expanded.requires.files.map((file) => path.resolve(ctx.root, file));
  }
  if (expanded.logDir) {
    const logDir = path.resolve(ctx.root, expanded.logDir);
    resolved.logDir = logDir;
    resolved.logs = { out: path.join(logDir, `${spec.id}.out.log`), err: path.join(logDir, `${spec.id}.err.log`) };
  }
  if (Array.isArray(expanded.extraLogs)) resolved.extraLogs = expanded.extraLogs.map((file) => path.resolve(ctx.root, file));
  if (ctx.problems.length) {
    resolved.problems = ctx.problems.slice();
    resolved.blocked = { reason: "registry-invalid", problems: ctx.problems.map((problem) => problem.code) };
  }
  return resolved;
}

function resolveMember(member, ctx, baseEnv) {
  const memberCtx = { ...ctx, spec: { ...ctx.spec, id: `${ctx.spec.id}/${member.name}` } };
  const ports = resolvePorts(member.ports, memberCtx);
  const portValues = portTable(ports);
  const expanded = {};
  for (const [key, value] of Object.entries(member)) {
    if (key === "ports" || key === "name") continue;
    expanded[key] = expandValue(value, memberCtx, portValues);
  }
  const launch = resolveLaunch(member, { ...expanded, cwd: expanded.cwd || "." }, ctx, portValues, baseEnv);
  return {
    name: member.name,
    autostart: member.autostart !== false,
    ...launch,
    dependsOn: Array.isArray(member.dependsOn) ? member.dependsOn.slice() : [],
    ports,
    urls: urlsFor(ports),
    ...(expanded.readiness ? { readiness: { intervalMs: DEFAULT_READINESS_INTERVAL_MS, ...expanded.readiness } } : {}),
    ...(expanded.requires ? { requires: expanded.requires } : {}),
    ...(expanded.stop ? { stop: expanded.stop } : {}),
  };
}

// ---------------------------------------------------------------------------
// Hooks (§3.2, §3.4)

/** hooks/<name>.js: exports prepare(ctx) -> {env, blocked?} and afterReady(ctx) -> {ok, error?}; either may be absent. */
function loadHook(name) {
  if (!HOOK_PATTERN.test(String(name || ""))) {
    const error = new Error(`Invalid hook name "${name}".`);
    error.code = "E_INVALID_HOOK";
    throw error;
  }
  return require(path.join(HOOK_DIR, name));
}

module.exports = {
  BUNDLED_FILE,
  HOOK_DIR,
  LEGACY_IDS,
  PROFILE_ALIASES,
  PROFILES,
  SUPERVISOR_ID,
  KINDS,
  DEFAULT_RESTART_POLICY,
  loadComponentRegistry,
  validateComponentSpec,
  getComponent,
  resolveComponent,
  selectProfile,
  startOrder,
  stopOrder,
  componentsForPaths,
  loadHook,
};
