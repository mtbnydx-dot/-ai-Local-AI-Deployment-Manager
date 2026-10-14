"use strict";

// Platform configuration (docs/overhaul/06-ops.md §4, 00 §9.5). This module is
// the only code that parses, validates or writes <AI_ROOT>/config/platform.json.
// It owns the schema (the core file data/platform-config.schema.json plus one
// fragment per owning spec in data/platform-config.d/), the env-to-key map
// (each env var maps to exactly one key) and the writer. Other modules read
// through readSection and write through writeSection.
//
// Reads never throw: a missing file means all defaults, a BOM is stripped, and
// a corrupt file or an invalid value leaves the next source in force with the
// reason in errors[]. Secret leaves never live in platform.json; their values
// go to the secret store (setSecretLeaf) and are only ever reported as {set}.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { replaceFileAtomically } = require("../file-utils");

const DATA_DIR = path.join(__dirname, "..", "data");
const CORE_SCHEMA_FILE = path.join(DATA_DIR, "platform-config.schema.json");
const FRAGMENT_DIR = path.join(DATA_DIR, "platform-config.d");
const FRAGMENT_SUFFIX = ".schema.json";
const DEFAULT_AI_ROOT = path.resolve(__dirname, "..", "..");

const CONFIG_SCHEMA_VERSION = 1;
const LOCALES = Object.freeze(["zh-CN", "en-US"]);
const SOURCES = Object.freeze(["runtime", "env", "file", "derived", "default"]);
const TYPES = Object.freeze(["string", "integer", "number", "boolean", "array", "object", "null"]);
const FORMATS = Object.freeze(["port", "hostname", "https-url", "path", "cidr"]);
const ENV_PARSERS = Object.freeze(["string", "int", "flag01", "csv", "inverted-flag01"]);
const SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const SECRET_NAMESPACE_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);
const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_HOST = "0.0.0.0";
// The same words service-entry's envFlag accepts, so a reported value always
// matches what the consumer of the env var sees.
const TRUE_WORDS = Object.freeze(["1", "true", "yes", "on"]);
const FALSE_WORDS = Object.freeze(["0", "false", "no", "off"]);
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const READ_CACHE_LIMIT = 32;
const ALL_COMPONENTS = "*";

// Platform keywords a leaf may carry on top of the JSON Schema subset (§4.2).
const LEAF_KEYWORDS = new Set([
  "type", "enum", "minimum", "maximum", "pattern", "format", "items", "properties", "additionalProperties",
  "default", "title", "description", "env", "envParse", "envValues", "derivedEnv", "consumers", "derives",
  "restartRequired", "secret", "group", "docs",
]);

// derived (§4.4): the value a leaf takes when no runtime, env or file value
// set it. lan_implied_by_host runs after these, in resolveValues.
const DERIVE_RULES = Object.freeze({
  "listeners.admin.host": (get) => (get("listeners.admin.lan") === true ? WILDCARD_HOST : LOOPBACK_HOST),
  "listeners.public.host": (get) => (get("listeners.public.lan") === true ? WILDCARD_HOST : LOOPBACK_HOST),
  "managers.vllm.host": (get) => get("managers.bindHost"),
  "managers.llama.host": (get) => get("managers.bindHost"),
});

const ERROR_STATUS = Object.freeze({
  config_locked: 409,
  config_conflict: 409,
  config_invalid: 400,
  secret_via_store: 400,
  section_mismatch: 400,
  unknown_section: 400,
  not_secret: 400,
  secret_store_unavailable: 503,
  config_write_failed: 500,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasCopy(value) {
  return isPlainObject(value) && LOCALES.every((locale) => typeof value[locale] === "string" && value[locale].trim());
}

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : JSON.stringify(value);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function etagOf(bytes) {
  return bytes ? `sha256:${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` : "none";
}

// ---------------------------------------------------------------------------
// Value checks (the dialect of §4.2)

function isHostname(value) {
  const text = String(value);
  if (WILDCARD_HOSTS.has(text) || net.isIP(text.replace(/^\[|\]$/g, ""))) return true;
  if (text.length > 253) return false;
  return text.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

// "IP" or "IP/prefix", the forms SERVICE_ENTRY_TRUSTED_PROXIES accepts today.
function isCidr(value) {
  const text = String(value).trim();
  const slash = text.indexOf("/");
  const address = (slash === -1 ? text : text.slice(0, slash)).replace(/^\[|\]$/g, "");
  const family = net.isIP(address);
  if (!family) return false;
  if (slash === -1) return true;
  const prefix = text.slice(slash + 1);
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function isHttpsUrl(value) {
  if (value === "") return true;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isPathText(value) {
  return value === "" || (!String(value).includes("\0") && String(value).length <= 1024);
}

const FORMAT_CHECKS = Object.freeze({
  port: (value) => Number.isInteger(value) && value >= 1 && value <= 65535,
  hostname: (value) => typeof value === "string" && isHostname(value),
  "https-url": (value) => typeof value === "string" && isHttpsUrl(value),
  path: (value) => typeof value === "string" && isPathText(value),
  cidr: (value) => typeof value === "string" && isCidr(value),
});

function typeMatches(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    case "null": return value === null;
    default: return false;
  }
}

// Compiles a node of the dialect into a checker spec. Problems with the node
// itself (an unknown type, a pattern that does not compile) go to `problems`.
function compileSpec(node, field, problems) {
  const spec = { types: null, enum: null, minimum: null, maximum: null, pattern: null, format: null, items: null, properties: null, closed: false };
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.length || !types.every((type) => TYPES.includes(type))) {
      problems.push({ field, code: "schema_invalid", message: `${field}: type must be one of ${TYPES.join(", ")}.` });
    } else {
      spec.types = types;
    }
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || !node.enum.length) problems.push({ field, code: "schema_invalid", message: `${field}: enum must be a non-empty list.` });
    else spec.enum = node.enum.slice();
  }
  for (const bound of ["minimum", "maximum"]) {
    if (node[bound] === undefined) continue;
    if (typeof node[bound] !== "number" || !Number.isFinite(node[bound])) problems.push({ field, code: "schema_invalid", message: `${field}: ${bound} must be a number.` });
    else spec[bound] = node[bound];
  }
  if (node.pattern !== undefined) {
    try {
      spec.pattern = new RegExp(String(node.pattern));
    } catch (error) {
      problems.push({ field, code: "schema_invalid", message: `${field}: pattern does not compile (${error.message}).` });
    }
  }
  if (node.format !== undefined) {
    if (!FORMATS.includes(node.format)) problems.push({ field, code: "schema_invalid", message: `${field}: format must be one of ${FORMATS.join(", ")}.` });
    else spec.format = node.format;
  }
  if (node.items !== undefined) {
    if (!isPlainObject(node.items)) problems.push({ field, code: "schema_invalid", message: `${field}: items must be an object.` });
    else spec.items = compileSpec(node.items, `${field}[]`, problems);
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      problems.push({ field, code: "schema_invalid", message: `${field}: properties must be an object.` });
    } else {
      spec.properties = {};
      for (const [name, child] of Object.entries(node.properties)) {
        if (UNSAFE_KEYS.has(name) || !isPlainObject(child)) {
          problems.push({ field: `${field}.${name}`, code: "schema_invalid", message: `${field}.${name}: not a valid property.` });
          continue;
        }
        spec.properties[name] = compileSpec(child, `${field}.${name}`, problems);
      }
    }
  }
  if (node.additionalProperties !== undefined) {
    if (node.additionalProperties !== false) problems.push({ field, code: "schema_invalid", message: `${field}: additionalProperties may only be false.` });
    else spec.closed = true;
  }
  return spec;
}

// Each check reports at most one error per value: { field, code, message }.
function checkValue(spec, value, field, errors) {
  if (spec.types && !spec.types.some((type) => typeMatches(type, value))) {
    errors.push({ field, code: "invalid_type", message: `${field} must be ${spec.types.join(" or ")}, not ${describeValue(value)}.` });
    return;
  }
  if (value === null) return;
  if (spec.enum && !spec.enum.some((item) => deepEqual(item, value))) {
    errors.push({ field, code: "invalid_value", message: `${field} must be one of ${spec.enum.map((item) => JSON.stringify(item)).join(", ")}.` });
    return;
  }
  if (typeof value === "number") {
    if ((spec.minimum !== null && value < spec.minimum) || (spec.maximum !== null && value > spec.maximum)) {
      const range = [spec.minimum !== null ? `>= ${spec.minimum}` : "", spec.maximum !== null ? `<= ${spec.maximum}` : ""].filter(Boolean).join(" and ");
      errors.push({ field, code: "out_of_range", message: `${field} must be ${range}.` });
      return;
    }
  }
  if (spec.format && (typeof value === "string" || typeof value === "number") && !FORMAT_CHECKS[spec.format](value)) {
    errors.push({ field, code: "invalid_format", message: `${field} is not a valid ${spec.format}.` });
    return;
  }
  if (spec.pattern && typeof value === "string" && !spec.pattern.test(value)) {
    errors.push({ field, code: "invalid_format", message: `${field} must match ${spec.pattern}.` });
    return;
  }
  if (Array.isArray(value) && spec.items) {
    value.forEach((item, index) => checkValue(spec.items, item, `${field}[${index}]`, errors));
  }
  if (isPlainObject(value) && (spec.properties || spec.closed)) {
    for (const [name, item] of Object.entries(value)) {
      const child = spec.properties?.[name];
      if (child) checkValue(child, item, `${field}.${name}`, errors);
      else if (spec.closed) errors.push({ field: `${field}.${name}`, code: "unknown_key", message: `${field}.${name} is not a known field.` });
    }
  }
}

function validateLeafValue(leaf, value) {
  const errors = [];
  checkValue(leaf.spec, value, leaf.key, errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Schema: core file plus fragments (§4.2)

function readJsonText(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, missing: error?.code === "ENOENT", error: error?.code === "ENOENT" ? "file not found" : String(error?.message || error) };
  }
  try {
    return { ok: true, value: JSON.parse(stripBom(text)) };
  } catch (error) {
    return { ok: false, missing: false, error: error.message };
  }
}

function normalizeConsumers(value, field, problems) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && (id === ALL_COMPONENTS || COMPONENT_ID_PATTERN.test(id)))) {
    problems.push({ field, code: "schema_invalid", message: `${field}: consumers must be a list of component ids.` });
    return [];
  }
  return Array.from(new Set(value));
}

function compileLeaf(node, key, origin, problems) {
  const start = problems.length;
  for (const name of Object.keys(node)) {
    // "$comment" and "x-..." are annotations for humans and tools.
    if (!LEAF_KEYWORDS.has(name) && !name.startsWith("$") && !name.startsWith("x-")) {
      problems.push({ field: key, code: "schema_invalid", message: `${key}: unknown keyword "${name}".` });
    }
  }
  const spec = compileSpec(node, key, problems);
  if (!spec.types) problems.push({ field: key, code: "schema_invalid", message: `${key}: a leaf needs a type.` });
  if (!hasCopy(node.title) || !hasCopy(node.description)) {
    problems.push({ field: key, code: "missing_copy", message: `${key}: title and description need both ${LOCALES.join(" and ")}.` });
  }
  const leafConsumers = normalizeConsumers(node.consumers, key, problems);
  const env = [];
  if (node.env !== undefined) {
    if (!Array.isArray(node.env)) problems.push({ field: key, code: "schema_invalid", message: `${key}: env must be a list.` });
    for (const entry of Array.isArray(node.env) ? node.env : []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
        problems.push({ field: key, code: "schema_invalid", message: `${key}: ${JSON.stringify(name)} is not an env name.` });
        continue;
      }
      const consumers = typeof entry === "string" ? leafConsumers || [] : normalizeConsumers(entry.consumers, key, problems) || leafConsumers || [];
      env.push({ name, consumers });
    }
  }
  const derivedEnv = [];
  for (const entry of Array.isArray(node.derivedEnv) ? node.derivedEnv : []) {
    if (!isPlainObject(entry) || !ENV_NAME_PATTERN.test(String(entry.name || "")) || typeof entry.template !== "string" || !entry.template.includes("{value}")) {
      problems.push({ field: key, code: "schema_invalid", message: `${key}: derivedEnv entries need a name and a template with {value}.` });
      continue;
    }
    derivedEnv.push({ name: entry.name, template: entry.template, consumers: normalizeConsumers(entry.consumers, key, problems) || [] });
  }
  if (node.derivedEnv !== undefined && !Array.isArray(node.derivedEnv)) problems.push({ field: key, code: "schema_invalid", message: `${key}: derivedEnv must be a list.` });
  const envParse = node.envParse === undefined ? defaultEnvParse(spec.types) : node.envParse;
  if (!ENV_PARSERS.includes(envParse)) problems.push({ field: key, code: "schema_invalid", message: `${key}: envParse must be one of ${ENV_PARSERS.join(", ")}.` });
  if (node.envValues !== undefined && !(isPlainObject(node.envValues) && Object.values(node.envValues).every((value) => typeof value === "string"))) {
    problems.push({ field: key, code: "schema_invalid", message: `${key}: envValues must map env text to a value.` });
  }
  let secret = null;
  if (isPlainObject(node.secret)) {
    if (!SECRET_NAMESPACE_PATTERN.test(String(node.secret.namespace || "")) || !SECRET_NAME_PATTERN.test(String(node.secret.name || ""))) {
      problems.push({ field: key, code: "schema_invalid", message: `${key}: secret needs a valid namespace and name.` });
    } else {
      secret = { namespace: node.secret.namespace, name: node.secret.name };
    }
    if (node.default !== undefined) problems.push({ field: key, code: "schema_invalid", message: `${key}: a secret leaf has no default.` });
  } else if (node.secret !== undefined && node.secret !== false) {
    problems.push({ field: key, code: "schema_invalid", message: `${key}: secret must be false or {namespace, name}.` });
  }
  let restartRequired = false;
  if (node.restartRequired === true || node.restartRequired === false || node.restartRequired === undefined) {
    restartRequired = node.restartRequired === true;
  } else {
    restartRequired = normalizeConsumers(node.restartRequired, `${key}.restartRequired`, problems);
  }
  const derives = Array.isArray(node.derives) ? node.derives.filter((item) => typeof item === "string") : [];
  if (node.group !== undefined && typeof node.group !== "string") problems.push({ field: key, code: "schema_invalid", message: `${key}: group must be a string.` });
  if (!secret) {
    if (node.default === undefined) {
      problems.push({ field: key, code: "schema_invalid", message: `${key}: a leaf needs a default.` });
    } else if (spec.types) {
      const defaultErrors = [];
      checkValue(spec, expandDefault(node.default, DEFAULT_AI_ROOT), key, defaultErrors);
      if (defaultErrors.length) problems.push({ field: key, code: "schema_invalid", message: `${key}: default is invalid (${defaultErrors[0].message})` });
    }
  }
  const fatal = problems.slice(start).some((problem) => problem.code === "schema_invalid");
  return {
    leaf: {
      key,
      namespace: key.split(".")[0],
      owner: origin.owner,
      origin: origin.file,
      spec,
      type: spec.types && spec.types.length === 1 ? spec.types[0] : spec.types,
      enum: spec.enum,
      default: node.default,
      title: node.title,
      description: node.description,
      docs: typeof node.docs === "string" ? node.docs : "",
      group: typeof node.group === "string" ? node.group : origin.group || key.split(".")[0],
      env,
      envParse,
      envValues: isPlainObject(node.envValues) ? { ...node.envValues } : null,
      derivedEnv,
      consumers: leafConsumers || [],
      derives,
      restartRequired,
      secret,
    },
    fatal,
  };
}

function defaultEnvParse(types) {
  const type = Array.isArray(types) ? types.find((item) => item !== "null") : null;
  if (type === "integer" || type === "number") return "int";
  if (type === "boolean") return "flag01";
  if (type === "array") return "csv";
  return "string";
}

function expandDefault(value, aiRoot) {
  if (typeof value !== "string" || !value.includes("${AI_ROOT}")) return clone(value);
  return path.normalize(value.split("${AI_ROOT}").join(aiRoot));
}

// Walks a properties tree. A node with `properties` is a branch; anything
// else is a leaf. Keys are dotted paths below the namespace.
function collectTree(properties, prefix, origin, out) {
  for (const [name, node] of Object.entries(properties)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (UNSAFE_KEYS.has(name) || !SEGMENT_PATTERN.test(name)) {
      out.outside.push({ field: key, code: "schema_invalid", message: `${key}: "${name}" is not a valid key name; keys are single segments without dots.` });
      continue;
    }
    if (!isPlainObject(node)) {
      out.problems.push({ field: key, code: "schema_invalid", message: `${key}: expected an object.` });
      continue;
    }
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties) || (node.type !== undefined && node.type !== "object")) {
        out.problems.push({ field: key, code: "schema_invalid", message: `${key}: a branch has type object and a properties object.` });
        continue;
      }
      out.branches.push({ key, owner: origin.owner, origin: origin.file });
      collectTree(node.properties, key, origin, out);
      continue;
    }
    // A leaf with a fatal problem is left out; the problem is reported.
    const compiled = compileLeaf(node, key, origin, out.problems);
    if (!compiled.fatal) out.leaves.push(compiled.leaf);
  }
}

function emptyCollection() {
  return { leaves: [], branches: [], problems: [], outside: [] };
}

// Bundled files are named relative to manager-core; anything else (a test
// fixture directory) by its base name only, so no local path reaches a message.
function relativeSchemaFile(file) {
  const relative = path.relative(path.join(__dirname, ".."), file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return path.basename(file);
  return relative.split(path.sep).join("/");
}

function isRetired(retiredKeys, key) {
  return Object.keys(retiredKeys).find((retired) => key === retired || key.startsWith(`${retired}.`)) || "";
}

function statSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.ctimeMs}`;
  } catch (error) {
    return `missing:${error?.code || ""}`;
  }
}

function fragmentFiles(fragmentDir) {
  try {
    return fs.readdirSync(fragmentDir).filter((name) => name.endsWith(FRAGMENT_SUFFIX)).sort();
  } catch {
    return [];
  }
}

function schemaSignature(coreFile, fragmentDir) {
  const parts = [coreFile, statSignature(coreFile), fragmentDir];
  for (const name of fragmentFiles(fragmentDir)) parts.push(name, statSignature(path.join(fragmentDir, name)));
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

const schemaCache = new Map();

/**
 * Merges the core schema file and the fragments (06 §4.2). A fragment that
 * declares a key outside its namespace, a namespace owned by the core file, a
 * retired key or an env name that is already mapped is rejected as a whole
 * with fragment_conflict; its keys then load as unknown_key warnings. Never
 * throws: problems are reported in schema.errors.
 */
function loadPlatformSchema({ coreFile = CORE_SCHEMA_FILE, fragmentDir = FRAGMENT_DIR } = {}) {
  const signature = schemaSignature(coreFile, fragmentDir);
  const cacheKey = `${path.resolve(coreFile)}\0${path.resolve(fragmentDir)}`;
  const cached = schemaCache.get(cacheKey);
  if (cached && cached.signature === signature) return cached;
  const schema = buildSchema(coreFile, fragmentDir, signature);
  schemaCache.set(cacheKey, schema);
  return schema;
}

function buildSchema(coreFile, fragmentDir, signature) {
  const errors = [];
  const leaves = new Map();
  const branches = new Map();
  const namespaces = new Map();
  const envIndex = new Map();
  const derivedEnvIndex = new Map();
  const groups = [];
  const fragments = [];
  let meta = { schemaVersion: CONFIG_SCHEMA_VERSION, asOf: "", staleAfterDays: null, fragmentNamespaces: {}, retiredKeys: {} };

  const coreName = relativeSchemaFile(coreFile);
  const core = readJsonText(coreFile);
  if (!core.ok || !isPlainObject(core.value) || !isPlainObject(core.value.properties)) {
    errors.push({ file: coreName, field: "$file", code: core.ok ? "schema_invalid" : "parse_error", message: `The platform config schema could not be read: ${core.error || "it has no properties"}.` });
  } else {
    const value = core.value;
    meta = {
      schemaVersion: Number(value.schemaVersion) || CONFIG_SCHEMA_VERSION,
      asOf: String(value.asOf || ""),
      staleAfterDays: Number(value.staleAfterDays) || null,
      fragmentNamespaces: isPlainObject(value.fragmentNamespaces) ? { ...value.fragmentNamespaces } : {},
      retiredKeys: isPlainObject(value.retiredKeys) ? { ...value.retiredKeys } : {},
    };
    for (const group of Array.isArray(value.groups) ? value.groups : []) {
      if (isPlainObject(group) && typeof group.id === "string" && hasCopy(group.title)) groups.push({ id: group.id, title: { ...group.title } });
      else errors.push({ file: coreName, field: "groups", code: "schema_invalid", message: "Every group needs an id and a bilingual title." });
    }
    const out = emptyCollection();
    collectTree(value.properties, "", { owner: String(value.owner || "06-ops"), file: coreName }, out);
    for (const problem of [...out.outside, ...out.problems]) errors.push({ file: coreName, ...problem });
    for (const branch of out.branches) branches.set(branch.key, branch);
    for (const leaf of out.leaves) {
      const names = [...leaf.env.map((entry) => entry.name), ...leaf.derivedEnv.map((entry) => entry.name)];
      const taken = names.filter((name) => envIndex.has(name) || derivedEnvIndex.has(name));
      if (taken.length) {
        errors.push({ file: coreName, field: leaf.key, code: "env_conflict", message: `${leaf.key}: env ${taken.join(", ")} is already mapped to another key.` });
        leaf.env = leaf.env.filter((entry) => !taken.includes(entry.name));
        leaf.derivedEnv = leaf.derivedEnv.filter((entry) => !taken.includes(entry.name));
      }
      leaves.set(leaf.key, leaf);
      for (const entry of leaf.env) envIndex.set(entry.name, leaf.key);
      for (const entry of leaf.derivedEnv) derivedEnvIndex.set(entry.name, leaf.key);
    }
    for (const name of Object.keys(value.properties)) {
      namespaces.set(name, { namespace: name, owner: String(value.owner || "06-ops"), file: coreName, core: true });
    }
  }

  for (const name of fragmentFiles(fragmentDir)) {
    const file = path.join(fragmentDir, name);
    const fileName = relativeSchemaFile(file);
    const result = mergeFragment({ file, fileName, name, meta, leaves, branches, namespaces, envIndex, derivedEnvIndex, groups });
    fragments.push({ file: fileName, namespace: result.namespace, owner: result.owner, accepted: result.ok });
    for (const problem of result.errors) errors.push({ file: fileName, namespace: result.namespace, ...problem });
  }

  const schema = {
    schemaVersion: meta.schemaVersion,
    asOf: meta.asOf,
    staleAfterDays: meta.staleAfterDays,
    signature,
    coreFile,
    fragmentDir,
    fragmentNamespaces: meta.fragmentNamespaces,
    retiredKeys: meta.retiredKeys,
    groups,
    leaves,
    branches,
    namespaces,
    envIndex,
    derivedEnvIndex,
    fragments,
    errors,
  };
  return Object.freeze(schema);
}

function mergeFragment({ file, fileName, name, meta, leaves, branches, namespaces, envIndex, derivedEnvIndex, groups }) {
  const parsed = readJsonText(file);
  const expected = name.slice(0, -FRAGMENT_SUFFIX.length);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return { ok: false, namespace: expected, owner: "", errors: [{ field: "$file", code: "fragment_invalid", message: `${fileName} could not be read: ${parsed.error || "not an object"}.` }] };
  }
  const value = parsed.value;
  const namespace = String(value.namespace || "");
  const owner = String(value.owner || "");
  const reject = (code, message, field = namespace || "$file") => ({ ok: false, namespace, owner, errors: [{ field, code, message }] });
  if (!SEGMENT_PATTERN.test(namespace) || UNSAFE_KEYS.has(namespace)) return reject("fragment_invalid", `${fileName} needs a "namespace".`);
  if (!isPlainObject(value.properties)) return reject("fragment_invalid", `${fileName} needs a "properties" object.`);
  if (namespace !== expected) return reject("fragment_conflict", `${fileName} declares namespace "${namespace}", outside the namespace its file name claims ("${expected}").`);
  const existing = namespaces.get(namespace);
  if (existing && !existing.core) return reject("fragment_conflict", `Namespace "${namespace}" is already declared by ${existing.file}.`);
  if (existing?.core && !Object.hasOwn(meta.fragmentNamespaces, namespace)) {
    return reject("fragment_conflict", `Namespace "${namespace}" is owned by the core schema; its keys cannot come from a fragment.`);
  }
  if (isRetired(meta.retiredKeys, namespace)) return reject("fragment_conflict", `Namespace "${namespace}" is retired; use ${meta.retiredKeys[isRetired(meta.retiredKeys, namespace)]}.`);

  const title = hasCopy(value.title) ? { ...value.title } : null;
  const out = emptyCollection();
  collectTree(value.properties, namespace, { owner, file: fileName, group: namespace }, out);
  if (out.outside.length) {
    return { ok: false, namespace, owner, errors: out.outside.map((problem) => ({ ...problem, code: "fragment_conflict", message: `${problem.message} A fragment may only declare keys inside "${namespace}".` })) };
  }
  if (out.problems.length) return { ok: false, namespace, owner, errors: out.problems.map((problem) => ({ ...problem, code: "fragment_invalid" })) };

  const conflicts = [];
  const seen = new Set();
  for (const item of [...out.branches, ...out.leaves]) {
    const retired = isRetired(meta.retiredKeys, item.key);
    if (retired) {
      conflicts.push({ field: item.key, code: "fragment_conflict", message: `${item.key} is retired; it lives at ${meta.retiredKeys[retired]}.` });
    } else if (leaves.has(item.key)) {
      conflicts.push({ field: item.key, code: "fragment_conflict", message: `${item.key} is already declared by ${leaves.get(item.key).origin}.` });
    }
  }
  // A shared branch (the console namespace) may gain leaves, never lose one
  // to a fragment leaf of the same name.
  for (const leaf of out.leaves) {
    if (branches.has(leaf.key)) conflicts.push({ field: leaf.key, code: "fragment_conflict", message: `${leaf.key} is a group of settings in ${branches.get(leaf.key).origin}.` });
  }
  for (const leaf of out.leaves) {
    for (const envName of [...leaf.env.map((entry) => entry.name), ...leaf.derivedEnv.map((entry) => entry.name)]) {
      if (envIndex.has(envName) || derivedEnvIndex.has(envName)) {
        conflicts.push({ field: leaf.key, code: "fragment_conflict", message: `${leaf.key}: env ${envName} is already mapped to ${envIndex.get(envName) || derivedEnvIndex.get(envName)}.` });
      } else if (seen.has(envName)) {
        conflicts.push({ field: leaf.key, code: "fragment_conflict", message: `${leaf.key}: env ${envName} appears twice in this fragment.` });
      }
      seen.add(envName);
    }
  }
  if (conflicts.length) return { ok: false, namespace, owner, errors: conflicts };

  if (!existing) namespaces.set(namespace, { namespace, owner, file: fileName, core: false });
  if (!branches.has(namespace)) branches.set(namespace, { key: namespace, owner, origin: fileName });
  for (const branch of out.branches) if (!branches.has(branch.key)) branches.set(branch.key, branch);
  for (const leaf of out.leaves) {
    leaves.set(leaf.key, leaf);
    for (const entry of leaf.env) envIndex.set(entry.name, leaf.key);
    for (const entry of leaf.derivedEnv) derivedEnvIndex.set(entry.name, leaf.key);
  }
  if (!groups.some((group) => group.id === namespace)) groups.push({ id: namespace, title: title || { "zh-CN": namespace, "en-US": namespace } });
  return { ok: true, namespace, owner, errors: [] };
}

/** env name -> key for every readable env var (derived output names excluded). */
function envNameIndex(schema = loadPlatformSchema()) {
  return new Map(schema.envIndex);
}

// ---------------------------------------------------------------------------
// Paths and the file

function resolvePaths(options = {}, env = process.env) {
  const explicitRoot = options.aiRoot ? path.resolve(String(options.aiRoot)) : "";
  const aiRoot = explicitRoot || path.resolve(String(env.AI_ROOT || DEFAULT_AI_ROOT));
  let file = path.join(aiRoot, "config", "platform.json");
  if (options.file) file = path.resolve(String(options.file));
  else if (!explicitRoot && env.PLATFORM_CONFIG_FILE) file = path.resolve(String(env.PLATFORM_CONFIG_FILE));
  return { aiRoot, file, changeLog: path.join(aiRoot, "logs", "platform", "config-changes.jsonl") };
}

/** Where platform.json lives for an AI root. */
function platformConfigFile({ aiRoot, env = process.env } = {}) {
  return resolvePaths({ aiRoot }, env).file;
}

function readConfigFile(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, bytes: null, etag: "none", parsed: null, error: null };
    return { exists: false, bytes: null, etag: "none", parsed: null, error: { field: "$file", code: "read_error", message: `platform.json could not be read (${error?.code || "error"}); defaults are in force.` } };
  }
  const etag = etagOf(bytes);
  let parsed;
  try {
    parsed = JSON.parse(stripBom(bytes.toString("utf8")));
  } catch (error) {
    return { exists: true, bytes, etag, parsed: null, error: { field: "$file", code: "parse_error", message: `platform.json is not valid JSON (${error.message}); defaults are in force.` } };
  }
  if (!isPlainObject(parsed)) {
    return { exists: true, bytes, etag, parsed: null, error: { field: "$file", code: "parse_error", message: "platform.json must hold a JSON object; defaults are in force." } };
  }
  return { exists: true, bytes, etag, parsed, error: null };
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
    if (UNSAFE_KEYS.has(segment)) return;
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  const last = segments[segments.length - 1];
  if (!UNSAFE_KEYS.has(last)) current[last] = value;
}

// Removes a key and then every parent object it leaves empty.
function deletePath(object, key) {
  const segments = key.split(".");
  const trail = [object];
  let current = object;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return;
    current = current[segment];
    trail.push(current);
  }
  if (!isPlainObject(current)) return;
  delete current[segments[segments.length - 1]];
  for (let index = trail.length - 1; index > 0; index -= 1) {
    if (Object.keys(trail[index]).length) break;
    delete trail[index - 1][segments[index - 1]];
  }
}

function unknownKeyWarning(schema, key) {
  const retired = isRetired(schema.retiredKeys, key);
  const movedTo = retired ? schema.retiredKeys[retired] : "";
  return {
    field: key,
    code: "unknown_key",
    message: movedTo ? `${key} is no longer read; it moved to ${movedTo}.` : `${key} is not a known setting and is ignored.`,
    ...(movedTo ? { movedTo } : {}),
  };
}

// platform.json -> Map(key -> raw value). Secret leaves found in the file are
// reported and dropped, so their values never reach any result.
function collectFileValues(schema, parsed, errors, warnings) {
  const values = new Map();
  const visit = (key, value) => {
    const leaf = schema.leaves.get(key);
    if (leaf) {
      if (leaf.secret) {
        errors.push({ field: key, code: "secret_via_store", source: "file", message: `${key} is a secret and is ignored in platform.json; set it through the secret store.` });
        return;
      }
      values.set(key, value);
      return;
    }
    if (schema.branches.has(key)) {
      if (!isPlainObject(value)) {
        errors.push({ field: key, code: "invalid_type", source: "file", message: `${key} must be an object in platform.json.` });
        return;
      }
      for (const [name, child] of Object.entries(value)) visit(`${key}.${name}`, child);
      return;
    }
    warnings.push(unknownKeyWarning(schema, key));
  };
  for (const [name, value] of Object.entries(parsed || {})) {
    if (name === "schemaVersion" || name === "$schema") continue;
    visit(name, value);
  }
  if (parsed && parsed.schemaVersion !== undefined && parsed.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    warnings.push({ field: "schemaVersion", code: "schema_version_mismatch", message: `platform.json has schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this build reads ${CONFIG_SCHEMA_VERSION}, and unknown keys are ignored.` });
  }
  return values;
}

// ---------------------------------------------------------------------------
// Env

function parseNameList(value) {
  return new Set(String(value || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean));
}

function parseEnvText(leaf, text) {
  const raw = String(text).trim();
  if (leaf.envValues) {
    const mapped = Object.entries(leaf.envValues).find(([from]) => from.toLowerCase() === raw.toLowerCase());
    if (mapped) return { ok: true, value: mapped[1] };
  }
  switch (leaf.envParse) {
    case "int": {
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return { ok: false };
      return { ok: true, value: Number(raw) };
    }
    case "flag01":
    case "inverted-flag01": {
      const word = raw.toLowerCase();
      let flag;
      if (TRUE_WORDS.includes(word)) flag = true;
      else if (FALSE_WORDS.includes(word)) flag = false;
      else return { ok: false };
      return { ok: true, value: leaf.envParse === "flag01" ? flag : !flag };
    }
    case "csv":
      return { ok: true, value: raw.split(/[;,]/).map((item) => item.trim()).filter(Boolean) };
    default:
      return { ok: true, value: raw };
  }
}

function serializeEnvValue(leaf, value) {
  if (value === null || value === undefined) return "";
  switch (leaf.envParse) {
    case "flag01": return value === true ? "1" : "0";
    case "inverted-flag01": return value === true ? "0" : "1";
    case "csv": return Array.isArray(value) ? value.join(",") : String(value);
    default: return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

// The env names of a leaf that are set and not demoted by
// PLATFORM_CONFIG_ENV_KEYS (names a supervisor or CLI injected from config).
function presentEnvNames(leaf, env, demoted) {
  return leaf.env.map((entry) => entry.name).filter((name) => {
    const value = env[name];
    return value !== undefined && value !== null && String(value).trim() !== "" && !demoted.has(name);
  });
}

// ---------------------------------------------------------------------------
// Resolution (§4.4): runtime > env > file > derived > default

function isWildcardHost(value) {
  return typeof value === "string" && WILDCARD_HOSTS.has(value.trim());
}

function resolveValues(schema, { fileValues, env, runtime, aiRoot, secrets, reservedPorts }) {
  const errors = [];
  const warnings = [];
  const values = {};
  const sources = {};
  const envNames = {};
  const envSet = {};
  const secretState = {};
  const demoted = parseNameList(env.PLATFORM_CONFIG_ENV_KEYS);
  const pending = [];

  for (const leaf of schema.leaves.values()) {
    const { key } = leaf;
    envNames[key] = leaf.env.map((entry) => entry.name);
    const setNames = presentEnvNames(leaf, env, demoted);
    envSet[key] = setNames;
    if (leaf.secret) {
      secretState[key] = resolveSecretState(leaf, setNames, secrets);
      values[key] = { set: secretState[key].set };
      sources[key] = secretState[key].source;
      continue;
    }
    const candidates = [];
    if (runtime && Object.hasOwn(runtime, key)) candidates.push({ source: "runtime", value: runtime[key] });
    if (setNames.length) {
      const parsed = setNames.map((name) => ({ name, result: parseEnvText(leaf, env[name]) }));
      const distinct = new Set(parsed.map((item) => JSON.stringify(item.result.value)));
      if (distinct.size > 1) {
        warnings.push({ field: key, code: "env_alias_conflict", message: `${setNames.join(" and ")} are all set for ${key} with different values; ${setNames[0]} wins.` });
      }
      const first = parsed[0];
      if (first.result.ok) candidates.push({ source: "env", value: first.result.value, env: first.name });
      else errors.push({ field: key, code: "invalid_type", source: "env", env: first.name, message: `${first.name} cannot be read as ${leaf.type}; it is ignored.` });
    }
    if (fileValues.has(key)) candidates.push({ source: "file", value: fileValues.get(key) });
    let chosen = null;
    for (const candidate of candidates) {
      const problems = validateLeafValue(leaf, candidate.value);
      if (!problems.length) {
        chosen = candidate;
        break;
      }
      errors.push({ ...problems[0], field: key, source: candidate.source, ...(candidate.env ? { env: candidate.env } : {}) });
    }
    if (chosen) {
      values[key] = clone(chosen.value);
      sources[key] = chosen.source;
    } else {
      pending.push(leaf);
    }
  }

  // Defaults first, so derive rules can read the leaves they depend on.
  const derivable = pending.filter((leaf) => DERIVE_RULES[leaf.key]);
  for (const leaf of pending) {
    if (DERIVE_RULES[leaf.key]) continue;
    values[leaf.key] = expandDefault(leaf.default, aiRoot);
    sources[leaf.key] = "default";
  }
  const get = (key) => values[key];
  for (const leaf of derivable) {
    const derived = DERIVE_RULES[leaf.key](get);
    if (derived !== undefined && !validateLeafValue(leaf, derived).length) {
      values[leaf.key] = derived;
      sources[leaf.key] = "derived";
    } else {
      values[leaf.key] = expandDefault(leaf.default, aiRoot);
      sources[leaf.key] = "default";
    }
  }

  // lan_implied_by_host: a wildcard ADMIN host binds the LAN whatever `lan`
  // says, so an unset `lan` reports true with source "derived" (05's
  // SERVICE_ENTRY_HOST=0.0.0.0 rule).
  if (schema.leaves.has("listeners.admin.lan") && isWildcardHost(values["listeners.admin.host"]) && values["listeners.admin.lan"] !== true) {
    warnings.push({ field: "listeners.admin.lan", code: "lan_implied_by_host", message: `listeners.admin.host is ${values["listeners.admin.host"]}, so the console is reachable from the LAN even though listeners.admin.lan is off.` });
    if (sources["listeners.admin.lan"] === "default") {
      values["listeners.admin.lan"] = true;
      sources["listeners.admin.lan"] = "derived";
    }
  }

  const crossField = crossFieldErrors(schema, values, reservedPorts);
  errors.push(...crossField);
  return { values, sources, envNames, envSet, secretState, errors, warnings, crossField };
}

function resolveSecretState(leaf, setNames, secrets) {
  if (setNames.length) return { set: true, source: "env", env: setNames[0] };
  if (!secrets || typeof secrets.has !== "function") return { set: null, source: "unknown" };
  try {
    const set = Boolean(secrets.has(leaf.secret.namespace, leaf.secret.name));
    let updatedAt = "";
    if (set && typeof secrets.list === "function") {
      const entry = (secrets.list(leaf.secret.namespace) || []).find((item) => item?.name === leaf.secret.name);
      updatedAt = String(entry?.updatedAt || "");
    }
    return { set, source: set ? "store" : "default", ...(updatedAt ? { updatedAt } : {}) };
  } catch (error) {
    return { set: null, source: "unknown", error: String(error?.code || "secret_store_unavailable") };
  }
}

function crossFieldErrors(schema, values, reservedPorts = []) {
  const errors = [];
  const seen = new Map();
  for (const item of Array.isArray(reservedPorts) ? reservedPorts : []) {
    if (Number.isInteger(item?.port)) seen.set(item.port, String(item.name || item.id || "registry"));
  }
  for (const leaf of schema.leaves.values()) {
    if (leaf.spec.format !== "port" || leaf.secret) continue;
    const port = values[leaf.key];
    if (!Number.isInteger(port)) continue;
    if (seen.has(port)) {
      errors.push({ field: leaf.key, code: "port_conflict", fields: [seen.get(port), leaf.key], message: `${leaf.key} uses port ${port}, which ${seen.get(port)} already uses.` });
    } else {
      seen.set(port, leaf.key);
    }
  }
  const adminLan = values["listeners.admin.lan"] === true || isWildcardHost(values["listeners.admin.host"]);
  const publicLan = values["listeners.public.lan"] === true || isWildcardHost(values["listeners.public.host"]);
  if ((adminLan || publicLan) && values["exposure.requireApiKey"] === "off") {
    errors.push({
      field: "exposure.requireApiKey",
      code: "insecure_combination",
      fields: [adminLan ? "listeners.admin.lan" : "listeners.public.lan", "exposure.requireApiKey"],
      message: "LAN access cannot be combined with exposure.requireApiKey = off: anyone on the network could use the models without a key.",
    });
  }
  errors.push(...telemetryRuleErrors(schema, values));
  return errors;
}

function minutesOfDay(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(text || ""));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// A tariff window as [start, end) minute ranges; one that crosses midnight
// splits in two, and from === to covers the whole day.
function tariffRanges(tariff) {
  const from = minutesOfDay(tariff?.from);
  const to = minutesOfDay(tariff?.to);
  if (from === null || to === null) return [];
  if (from === to) return [[0, 1440]];
  return from < to ? [[from, to]] : [[from, 1440], [0, to]];
}

// 04 §20 hands these rules to this validator, and TEL packages never edit
// this file, so they live here and apply once the telemetry fragment loads.
function telemetryRuleErrors(schema, values) {
  const errors = [];
  const requestsDays = values["telemetry.retention.requestsDays"];
  const ipDays = values["telemetry.retention.ipDays"];
  if (schema.leaves.has("telemetry.retention.ipDays") && Number.isFinite(ipDays) && Number.isFinite(requestsDays) && ipDays > requestsDays) {
    errors.push({
      field: "telemetry.retention.ipDays",
      code: "retention_order",
      fields: ["telemetry.retention.ipDays", "telemetry.retention.requestsDays"],
      message: "IP and client details cannot be kept longer than the request rows they belong to.",
    });
  }
  const offset = values["telemetry.timezoneOffsetMinutes"];
  if (schema.leaves.has("telemetry.timezoneOffsetMinutes") && Number.isInteger(offset) && offset % 60 !== 0) {
    errors.push({ field: "telemetry.timezoneOffsetMinutes", code: "invalid_format", message: "The time zone for daily totals must be a whole number of hours." });
  }
  const tariffs = values["telemetry.energy.tariffs"];
  if (schema.leaves.has("telemetry.energy.tariffs") && Array.isArray(tariffs)) {
    const ranges = tariffs.flatMap((tariff, index) => tariffRanges(tariff).map((range) => ({ index, range })));
    const overlap = ranges.find((left, position) => ranges.slice(position + 1).some((right) => right.index !== left.index
      && left.range[0] < right.range[1] && right.range[0] < left.range[1]));
    if (overlap) {
      errors.push({ field: "telemetry.energy.tariffs", code: "tariff_overlap", message: "Time-of-use tariff windows may cross midnight but must not overlap." });
    }
  }
  return errors;
}

/**
 * Effective configuration (06 §4.4). Never throws. Secret leaves carry
 * {set} in values and never a value; pass `secrets` (a vault with
 * has(namespace, name) and list(namespace)) to learn whether the store holds
 * them, otherwise they read {set: null} unless an env var sets them.
 */
function loadPlatformConfig(options = {}) {
  const env = options.env || process.env;
  const schema = options.schema || loadPlatformSchema();
  const { aiRoot, file } = resolvePaths(options, env);
  const read = readConfigFile(file);
  const errors = [];
  const warnings = [];
  if (read.error) errors.push(read.error);
  const fileValues = collectFileValues(schema, read.parsed, errors, warnings);
  const runtime = {};
  for (const [key, value] of Object.entries(isPlainObject(options.runtimeOverrides) ? options.runtimeOverrides : {})) {
    const leaf = schema.leaves.get(key);
    if (!leaf) warnings.push(unknownKeyWarning(schema, key));
    else if (leaf.secret) errors.push({ field: key, code: "secret_via_store", source: "runtime", message: `${key} is a secret and cannot be set as a runtime override.` });
    else runtime[key] = value;
  }
  const resolved = resolveValues(schema, { fileValues, env, runtime, aiRoot, secrets: options.secrets, reservedPorts: options.reservedPorts });
  const loaded = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    aiRoot,
    file,
    exists: read.exists,
    etag: read.etag,
    values: resolved.values,
    sources: resolved.sources,
    envNames: resolved.envNames,
    envSet: resolved.envSet,
    secrets: resolved.secretState,
    errors: [...errors, ...resolved.errors],
    warnings: [...warnings, ...resolved.warnings],
  };
  Object.defineProperty(loaded, "schema", { value: schema, enumerable: false });
  Object.defineProperty(loaded, "get", { value: (key) => clone(loaded.values[key]), enumerable: false });
  return loaded;
}

// ---------------------------------------------------------------------------
// Sections (§4.6)

const readCache = new Map();

function envFingerprint(schema, env) {
  const hash = crypto.createHash("sha256");
  for (const name of [...schema.envIndex.keys(), "PLATFORM_CONFIG_ENV_KEYS"].sort()) {
    const value = env[name];
    if (value !== undefined) hash.update(`${name}=${value}\0`);
  }
  return hash.digest("hex").slice(0, 16);
}

function forgetCachedReads(file) {
  for (const [key, entry] of readCache) if (entry.file === file) readCache.delete(key);
}

function cachedLoad(options) {
  const env = options.env || process.env;
  const schema = options.schema || loadPlatformSchema();
  const { aiRoot, file } = resolvePaths(options, env);
  const cacheKey = [aiRoot, file, schema.signature, statSignature(file), envFingerprint(schema, env)].join("\0");
  const hit = readCache.get(cacheKey);
  if (hit) return hit.loaded;
  const loaded = loadPlatformConfig({ aiRoot, file, env, schema });
  readCache.set(cacheKey, { file, loaded });
  while (readCache.size > READ_CACHE_LIMIT) readCache.delete(readCache.keys().next().value);
  return loaded;
}

function sectionKind(schema, name) {
  if (schema.branches.has(name)) return "branch";
  if (schema.leaves.has(name)) return "leaf";
  return "";
}

function withinSection(name, key) {
  return key === name || key.startsWith(`${name}.`);
}

function errorFields(error) {
  return [error.field, ...(Array.isArray(error.fields) ? error.fields : [])].filter(Boolean);
}

/**
 * One namespace (or any branch, e.g. "listeners.admin") of the effective
 * config, cached per (aiRoot, file mtime/size/inode, schema, mapped env), so
 * the entry may call it on every request. `value` is an alias of `values`.
 */
function readSection(name, options = {}) {
  const schema = options.schema || loadPlatformSchema();
  const sectionName = String(name || "");
  const kind = sectionKind(schema, sectionName);
  if (!kind) {
    return { values: {}, value: {}, sources: {}, etag: "none", errors: [{ field: sectionName, code: "unknown_section", message: `"${sectionName}" is not a platform config section.` }], warnings: [] };
  }
  const loaded = cachedLoad({ ...options, schema });
  const env = options.env || process.env;
  const demoted = parseNameList(env.PLATFORM_CONFIG_ENV_KEYS);
  const sources = {};
  let values = {};
  for (const leaf of schema.leaves.values()) {
    if (!withinSection(sectionName, leaf.key)) continue;
    let value = clone(loaded.values[leaf.key]);
    let source = loaded.sources[leaf.key];
    if (leaf.secret && options.secrets) {
      const state = resolveSecretState(leaf, presentEnvNames(leaf, env, demoted), options.secrets);
      value = { set: state.set };
      source = state.source;
    }
    sources[leaf.key] = source;
    if (kind === "leaf") values = value;
    else setPath(values, leaf.key.slice(sectionName.length + 1), value);
  }
  const inSection = (error) => error.field === "$file" || errorFields(error).some((field) => withinSection(sectionName, field));
  return {
    values,
    value: values,
    sources,
    etag: loaded.etag,
    errors: clone(loaded.errors.filter(inSection)),
    warnings: clone(loaded.warnings.filter(inSection)),
  };
}

// Flattens a section patch into keys (§4.6). Nested objects and dotted keys
// are relative to the section; an absolute key inside the section is accepted
// too. A known key outside the section is section_mismatch.
function flattenSectionPatch(schema, name, patch) {
  const set = {};
  const unset = [];
  const errors = [];
  if (schema.leaves.has(name)) {
    if (patch === null) unset.push(name);
    else set[name] = patch;
    return { set, unset, errors };
  }
  const known = (key) => schema.leaves.has(key) || schema.branches.has(key);
  const walk = (prefix, object) => {
    for (const [segment, value] of Object.entries(object)) {
      let key = `${prefix}.${segment}`;
      if (!known(key) && prefix === name && withinSection(name, segment) && known(segment)) key = segment;
      if (!known(key)) {
        if (known(segment) || isRetired(schema.retiredKeys, segment) || schema.namespaces.has(segment.split(".")[0])) {
          errors.push({ field: segment, code: "section_mismatch", message: `${segment} is not part of the "${name}" section.` });
        } else {
          errors.push({ ...unknownKeyWarning(schema, key) });
        }
        continue;
      }
      if (schema.leaves.has(key)) {
        if (value === null) unset.push(key);
        else set[key] = value;
      } else if (value === null) {
        for (const leafKey of schema.leaves.keys()) if (withinSection(key, leafKey)) unset.push(leafKey);
      } else if (isPlainObject(value)) {
        walk(key, value);
      } else {
        errors.push({ field: key, code: "invalid_type", message: `${key} is a group of settings; pass an object or null.` });
      }
    }
  };
  walk(name, patch);
  return { set, unset, errors };
}

// ---------------------------------------------------------------------------
// The writer (§4.6)

function failure(code, message, extra = {}) {
  return { ok: false, status: ERROR_STATUS[code] || 400, code, error: { code, message }, etag: extra.etag, changed: [], restartRequired: [], errors: extra.errors || [], ...(extra.warnings ? { warnings: extra.warnings } : {}) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// platform.json.lock is created with "wx" and holds only {pid, at}. A lock
// older than staleMs belonged to a writer that died and is taken over.
async function acquireLock(lockFile, { waitMs, staleMs }) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let immediateRetries = 0;
  for (;;) {
    try {
      const handle = await fsp.open(lockFile, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      // Windows answers EPERM while another writer's lock is being deleted.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    }
    let retryNow = false;
    try {
      const stat = await fsp.stat(lockFile);
      if (Date.now() - stat.mtimeMs > staleMs) {
        await fsp.rm(lockFile, { force: true });
        retryNow = true;
      }
    } catch (error) {
      if (error?.code === "ENOENT") retryNow = true;
    }
    if (retryNow && immediateRetries < 5) {
      immediateRetries += 1;
      continue;
    }
    if (Date.now() >= deadline) return false;
    await delay(15 + Math.floor(Math.random() * 25));
  }
}

function cleanActor(actor) {
  const text = String(actor || "unknown").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.slice(0, 128) || "unknown";
}

async function appendChangeLog(changeLog, entry) {
  await fsp.mkdir(path.dirname(changeLog), { recursive: true });
  await fsp.appendFile(changeLog, `${JSON.stringify(entry)}\n`, "utf8");
}

function restartTargets(schema, keys) {
  const targets = new Set();
  for (const key of keys) {
    const leaf = schema.leaves.get(key);
    if (!leaf || !leaf.restartRequired) continue;
    if (Array.isArray(leaf.restartRequired)) {
      for (const id of leaf.restartRequired) targets.add(id);
      continue;
    }
    const consumers = new Set([...leaf.consumers, ...leaf.env.flatMap((entry) => entry.consumers), ...leaf.derivedEnv.flatMap((entry) => entry.consumers)]);
    if (!consumers.size) targets.add(ALL_COMPONENTS);
    for (const id of consumers) targets.add(id);
  }
  return Array.from(targets).sort();
}

function crossFieldSignature(error) {
  return `${error.code}:${errorFields(error).sort().join(",")}`;
}

// Cross-field problems of the file alone (env and runtime left out), so the
// writer judges what it stores rather than the caller's environment.
function fileViewErrors(schema, object, aiRoot, reservedPorts) {
  const scratchErrors = [];
  const fileValues = collectFileValues(schema, object, scratchErrors, []);
  return resolveValues(schema, { fileValues, env: {}, runtime: {}, aiRoot, reservedPorts }).crossField;
}

/**
 * The only code path that writes platform.json (06 §4.6): lock, etag check,
 * validation of the merged file, .bak copy, tmp + rename, and one line in
 * logs/platform/config-changes.jsonl with the changed keys (never values).
 * Never throws for a refused write; I/O failures come back as
 * config_write_failed.
 */
async function writePlatformConfig(options = {}) {
  const schema = options.schema || loadPlatformSchema();
  const { aiRoot, file, changeLog } = resolvePaths(options, options.env || process.env);
  const set = isPlainObject(options.set) ? options.set : {};
  const unset = Array.isArray(options.unset) ? options.unset.map(String) : [];
  const errors = [];
  for (const [key, value] of Object.entries(set)) {
    const leaf = schema.leaves.get(key);
    if (!leaf) {
      errors.push(unknownKeyWarning(schema, key));
      continue;
    }
    if (leaf.secret) {
      return failure("secret_via_store", `${key} is a secret; set it with setSecretLeaf so it goes to the secret store, never platform.json.`, { errors: [{ field: key, code: "secret_via_store", message: `${key} is stored in the secret store.` }] });
    }
    if (value === undefined) {
      errors.push({ field: key, code: "invalid_type", message: `${key} has no value; use unset to remove it.` });
      continue;
    }
    errors.push(...validateLeafValue(leaf, value));
  }
  for (const key of unset) {
    if (!key.split(".").every((segment) => segment && !UNSAFE_KEYS.has(segment))) errors.push({ field: key, code: "invalid_key", message: `${key} is not a valid key.` });
  }
  if (errors.length) return failure("config_invalid", "The settings were not saved because some values are invalid.", { errors });

  const lockFile = `${file}.lock`;
  let temp = "";
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const locked = await acquireLock(lockFile, { waitMs: options.lockWaitMs ?? LOCK_WAIT_MS, staleMs: options.lockStaleMs ?? LOCK_STALE_MS });
    if (!locked) return failure("config_locked", "Another process is saving the settings right now; try again in a moment.");
  } catch (error) {
    return failure("config_write_failed", `The settings lock could not be taken (${error?.code || "error"}).`);
  }
  try {
    const current = readConfigFile(file);
    if (options.etag !== undefined && options.etag !== null && String(options.etag) !== current.etag) {
      return failure("config_conflict", "The settings changed since you loaded them; reload and try again.", { etag: current.etag });
    }
    if (current.error) {
      return failure("config_invalid", "platform.json cannot be read, so it is not overwritten; fix or remove it first.", { etag: current.etag, errors: [current.error] });
    }
    const before = current.parsed ? clone(current.parsed) : {};
    const next = clone(before);
    for (const key of unset) deletePath(next, key);
    for (const [key, value] of Object.entries(set)) {
      const leaf = schema.leaves.get(key);
      // platform.json keeps only values that differ from the defaults (§4.1);
      // a leaf with a derive rule keeps an explicit value, which pins it.
      if (!DERIVE_RULES[key] && deepEqual(value, expandDefault(leaf.default, aiRoot))) deletePath(next, key);
      else setPath(next, key, clone(value));
    }
    const changed = Array.from(new Set([...unset, ...Object.keys(set)])).filter((key) => !deepEqual(getPath(before, key), getPath(next, key))).sort();
    if (!changed.length) return { ok: true, etag: current.etag, changed: [], restartRequired: [], errors: [] };

    const known = new Set(fileViewErrors(schema, before, aiRoot, options.reservedPorts).map(crossFieldSignature));
    const introduced = fileViewErrors(schema, next, aiRoot, options.reservedPorts).filter((error) => !known.has(crossFieldSignature(error)));
    if (introduced.length) return failure("config_invalid", "The settings were not saved because they conflict with each other.", { etag: current.etag, errors: introduced });

    const document = { schemaVersion: CONFIG_SCHEMA_VERSION, ...next };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fsp.writeFile(temp, text, "utf8");
    if (current.exists) await fsp.copyFile(file, `${file}.bak`);
    await replaceFileAtomically(temp, file);
    temp = "";
    forgetCachedReads(file);
    const warnings = [];
    try {
      await appendChangeLog(changeLog, { at: new Date().toISOString(), actor: cleanActor(options.actor), changed });
    } catch (error) {
      warnings.push({ field: "$changeLog", code: "change_log_failed", message: `The change log could not be written (${error?.code || "error"}).` });
    }
    return { ok: true, etag: etagOf(Buffer.from(text, "utf8")), changed, restartRequired: restartTargets(schema, changed), errors: [], ...(warnings.length ? { warnings } : {}) };
  } catch (error) {
    return failure("config_write_failed", `The settings could not be saved (${error?.code || "error"}).`);
  } finally {
    if (temp) await fsp.rm(temp, { force: true }).catch(() => {});
    await fsp.rm(lockFile, { force: true }).catch(() => {});
  }
}

/**
 * Writes one section through writePlatformConfig. `patch` is relative to the
 * section; null unsets a key (or a whole group). 05 updateAccessSection and
 * 04's settings PUTs call this and never write the file themselves.
 */
async function writeSection(name, patch, options = {}) {
  const schema = options.schema || loadPlatformSchema();
  const sectionName = String(name || "");
  if (!sectionKind(schema, sectionName)) {
    return failure("unknown_section", `"${sectionName}" is not a platform config section.`, { errors: [{ field: sectionName, code: "unknown_section", message: `"${sectionName}" is not a platform config section.` }] });
  }
  if (!schema.leaves.has(sectionName) && !isPlainObject(patch)) {
    return failure("config_invalid", "A section patch must be an object.", { errors: [{ field: sectionName, code: "invalid_type", message: "A section patch must be an object." }] });
  }
  const flat = flattenSectionPatch(schema, sectionName, patch);
  const mismatch = flat.errors.filter((error) => error.code === "section_mismatch");
  if (mismatch.length) return failure("section_mismatch", `Only keys of the "${sectionName}" section can be written here.`, { errors: mismatch });
  if (flat.errors.length) return failure("config_invalid", "The settings were not saved because some keys are unknown.", { errors: flat.errors });
  return writePlatformConfig({ ...options, schema, set: flat.set, unset: flat.unset });
}

function defaultSecretVault(aiRoot) {
  let secretStore;
  try {
    secretStore = require("../secret-store");
  } catch {
    return null;
  }
  return typeof secretStore.createSecretVault === "function" ? secretStore.createSecretVault({ aiRoot }) : null;
}

/**
 * Sets (or with value === null clears) a secret leaf in the secret store
 * (06 §4.5). The value never touches platform.json or the change log.
 */
async function setSecretLeaf(key, value, options = {}) {
  const schema = options.schema || loadPlatformSchema();
  const leaf = schema.leaves.get(String(key || ""));
  if (!leaf || !leaf.secret) return failure("not_secret", `${key} is not a secret setting; use writeSection.`);
  if (value !== null && (typeof value !== "string" || !value.trim())) {
    return failure("config_invalid", `${key} needs a non-empty string.`, { errors: [{ field: leaf.key, code: "invalid_type", message: `${leaf.key} needs a non-empty string.` }] });
  }
  const { aiRoot, changeLog } = resolvePaths(options, options.env || process.env);
  const vault = options.secrets || defaultSecretVault(aiRoot);
  if (!vault) return failure("secret_store_unavailable", "The secret store is not available in this build.");
  try {
    if (value === null) await (typeof vault.clear === "function" ? vault.clear(leaf.secret.namespace, leaf.secret.name) : vault.remove(leaf.secret.namespace, leaf.secret.name));
    else await vault.set(leaf.secret.namespace, leaf.secret.name, value);
  } catch (error) {
    return failure("secret_store_unavailable", `The secret store refused the change (${error?.code || "error"}).`);
  }
  const updatedAt = new Date().toISOString();
  const warnings = [];
  try {
    await appendChangeLog(changeLog, { at: updatedAt, actor: cleanActor(options.actor), changed: [leaf.key], secret: true });
  } catch (error) {
    warnings.push({ field: "$changeLog", code: "change_log_failed", message: `The change log could not be written (${error?.code || "error"}).` });
  }
  return { ok: true, updatedAt, restartRequired: restartTargets(schema, [leaf.key]), ...(warnings.length ? { warnings } : {}) };
}

// ---------------------------------------------------------------------------
// Description and child env

/**
 * The settings page model (06 §4.6): every leaf with its value, default,
 * source and copy, grouped. Secret leaves appear only with includeSecrets and
 * then only as secret:{set, source, updatedAt}; no secret value is ever here.
 */
function describeEffectiveConfig(loaded, { includeSecrets = false } = {}) {
  const schema = loaded.schema || loadPlatformSchema();
  const byGroup = new Map(schema.groups.map((group) => [group.id, { id: group.id, title: group.title, items: [] }]));
  for (const leaf of schema.leaves.values()) {
    if (leaf.secret && !includeSecrets) continue;
    if (!byGroup.has(leaf.group)) byGroup.set(leaf.group, { id: leaf.group, title: { "zh-CN": leaf.group, "en-US": leaf.group }, items: [] });
    const item = {
      key: leaf.key,
      type: leaf.type,
      ...(leaf.enum ? { enum: leaf.enum.slice() } : {}),
      source: loaded.sources[leaf.key],
      envNames: leaf.env.map((entry) => entry.name),
      restartRequired: leaf.restartRequired === true ? restartTargets(schema, [leaf.key]) : (leaf.restartRequired || false) && leaf.restartRequired.slice(),
      title: { ...leaf.title },
      description: { ...leaf.description },
      docs: leaf.docs,
      owner: leaf.owner,
    };
    if (leaf.secret) {
      const state = loaded.secrets?.[leaf.key] || { set: null, source: "unknown" };
      item.secret = { set: state.set, source: state.source, ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}) };
    } else {
      item.value = clone(loaded.values[leaf.key]);
      item.default = expandDefault(leaf.default, loaded.aiRoot || DEFAULT_AI_ROOT);
      if (DERIVE_RULES[leaf.key]) item.derived = true;
    }
    const error = loaded.errors.find((entry) => errorFields(entry).includes(leaf.key));
    if (error) item.error = { code: error.code, message: error.message };
    byGroup.get(leaf.group).items.push(item);
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    etag: loaded.etag,
    groups: Array.from(byGroup.values()).filter((group) => group.items.length),
    errors: clone(loaded.errors),
    warnings: clone(loaded.warnings),
  };
}

function consumes(consumers, componentId) {
  return consumers.includes(ALL_COMPONENTS) || consumers.includes(componentId);
}

function registryComponentId(registry, componentId) {
  const components = Array.isArray(registry?.components) ? registry.components : [];
  const match = components.find((component) => component?.id === componentId || component?.legacyId === componentId);
  return match?.id || componentId;
}

/**
 * Env for a child process (06 §4.4): every mapped env var the component
 * consumes whose value did not come from the true environment, the derived
 * env (MCP URLs), and secret values from `secrets` (env only, never argv).
 * PLATFORM_CONFIG_ENV_KEYS lists the injected names, so the child reports
 * file/default instead of env for them.
 */
function childEnv(loaded, componentId, registry, { secrets } = {}) {
  const schema = loaded.schema || loadPlatformSchema();
  const id = registryComponentId(registry, String(componentId || ""));
  const env = {};
  const injected = [];
  const put = (name, text) => {
    if (text === "" || text === undefined) return;
    env[name] = text;
    injected.push(name);
  };
  for (const leaf of schema.leaves.values()) {
    const alreadySet = new Set(loaded.envSet?.[leaf.key] || []);
    const value = loaded.values[leaf.key];
    for (const entry of leaf.env) {
      if (!consumes(entry.consumers, id) || alreadySet.has(entry.name)) continue;
      if (leaf.secret) {
        if (loaded.sources[leaf.key] === "env" || !secrets || typeof secrets.get !== "function") continue;
        let secretValue = "";
        try {
          secretValue = String(secrets.get(leaf.secret.namespace, leaf.secret.name) || "");
        } catch {
          secretValue = "";
        }
        put(entry.name, secretValue);
        continue;
      }
      put(entry.name, serializeEnvValue(leaf, value));
    }
    if (leaf.secret) continue;
    for (const entry of leaf.derivedEnv) {
      if (consumes(entry.consumers, id)) put(entry.name, entry.template.split("{value}").join(String(value)));
    }
  }
  const injectedKeys = Array.from(new Set(injected)).sort();
  env.PLATFORM_CONFIG_ENV_KEYS = injectedKeys.join(",");
  env.PLATFORM_CONFIG_FILE = loaded.file;
  return { env, injectedKeys };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  CORE_SCHEMA_FILE,
  FRAGMENT_DIR,
  SOURCES,
  DERIVED_KEYS: Object.freeze(Object.keys(DERIVE_RULES)),
  loadPlatformSchema,
  loadPlatformConfig,
  describeEffectiveConfig,
  writePlatformConfig,
  readSection,
  writeSection,
  setSecretLeaf,
  childEnv,
  envNameIndex,
  platformConfigFile,
  validateLeafValue,
};
