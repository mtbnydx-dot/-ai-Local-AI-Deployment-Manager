"use strict";

// EngineDescriptor validator (docs/overhaul/01-engines.md §4). It is written by
// hand so manager-core keeps no dependencies, and one function serves three
// callers: the bundled data/engines/*.json, <AI_ROOT>/config/engines/*.json
// overrides, and the console's custom-engine drafts. It only reads its input;
// "draft" applies the override rules and never writes anything.

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const MANIFEST_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PARAM_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
const CANONICAL_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const FLAG_PATTERN = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DURATION_PATTERN = /^\d+(?:ms|s|m|h)$/;
const RESTART_PATTERN = /^(?:no|always|unless-stopped|on-failure(?::\d+)?)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATALOG_PATTERN = /^launch-params\/[a-z][a-z0-9-]*\.json$/;
const MAX_REGEX_LENGTH = 500;

const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);
const TIER1_ENGINE_IDS = Object.freeze(["vllm", "sglang", "llamacpp"]);
const FAMILIES = Object.freeze(["vllm", "sglang", "llamacpp", "openai-server", "multi-model-server"]);
const ADAPTERS = Object.freeze(["vllm", "sglang", "llamacpp", "docker-template", "external"]);
const TIER1_ADAPTERS = Object.freeze(["vllm", "sglang", "llamacpp"]);
// An override file may add an engine only through the data-driven adapters.
const OVERRIDE_ADAPTERS = Object.freeze(["docker-template", "external"]);
const TIER1_HOST_MANAGER = Object.freeze({ vllm: "vllm", sglang: "vllm", llamacpp: "llama" });
const STATUSES = Object.freeze(["stable", "experimental", "disabled"]);
const HOST_MANAGERS = Object.freeze(["vllm", "llama", "entry"]);
const ARTIFACT_FORMATS = Object.freeze(["safetensors", "gguf", "exl3", "awq", "gptq", "fp8", "nvfp4"]);
const HOST_KINDS = Object.freeze(["docker", "native", "external"]);
const GPU_MODES = Object.freeze(["required", "optional", "none"]);
const READY_KINDS = Object.freeze(["models-list", "health-200", "health-503-loading"]);
const MEMORY_MODEL_KINDS = Object.freeze([
  "device-fraction",
  "static-fraction-of-free",
  "gguf-estimate",
  "free-fraction-after-weights",
  "weights-plus-kv",
  "measured",
  "server-reported",
]);
const SECRET_MODES = Object.freeze(["env", "flag", "file", "unsupported"]);
const METRIC_KINDS = Object.freeze(["counter", "gauge", "histogram"]);
const METRIC_FORMATS = Object.freeze(["prometheus", "json"]);
const INTROSPECTION_PARSERS = Object.freeze(["argparse", "llama-help", "click"]);
const ROLES = Object.freeze(["chat", "embedding", "rerank"]);
const LIFECYCLE_PHASES = Object.freeze(["pull", "admission", "container", "weights", "kv", "graphs", "api", "probe", "ready"]);
const API_SURFACE_KEYS = Object.freeze(["chat", "completions", "responses", "messages", "embeddings", "rerank"]);
const CAPABILITY_FLAGS = Object.freeze([
  "parallelInstances",
  "tensorParallel",
  "pipelineParallel",
  "dataParallel",
  "expertParallel",
  "lora",
  "multiModel",
  "hotLoad",
  "sleepWake",
]);

const DESCRIPTOR_FIELDS = Object.freeze([
  "schemaVersion", "asOf", "staleAfterDays", "id", "label", "description", "family", "adapter", "tier",
  "status", "hostManager", "legacy", "artifactFormats", "runtimes", "host", "api", "apiSurface", "apiQuirks",
  "catalog", "memoryModel", "capabilities", "knowledgeKeys", "secrets", "managedFlags", "extraEnvAllow",
  "introspection", "metricsMap", "logPhases", "logFacts", "errorSignatures", "template", "external",
]);
// What an override of an existing engine may touch (01 §4), plus its metadata.
const OVERRIDE_METADATA_FIELDS = Object.freeze(["schemaVersion", "asOf", "staleAfterDays", "id"]);
const OVERRIDE_FIELDS = Object.freeze(["status", "label", "runtimes", "metricsMap", "logPhases", "logFacts", "errorSignatures"]);
const OVERRIDE_RUNTIME_FIELDS = Object.freeze(["allowed", "default"]);
const MODES = Object.freeze(["bundled", "override", "draft"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinPath(base, key) {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : String(key);
}

function createCollector() {
  const errors = [];
  return {
    errors,
    add(path, code, message) {
      errors.push({ path, code, message });
    },
  };
}

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : JSON.stringify(value);
}

function checkKnownKeys(out, value, path, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.add(joinPath(path, key), "unknown_field", `Unknown field "${key}".`);
  }
}

// Each check reports at most one error per field and returns whether the value
// may be inspected further.
function requireObject(out, value, path, { required = true } = {}) {
  if (value === undefined) {
    if (required) out.add(path, "required", `${path} is required.`);
    return false;
  }
  if (!isPlainObject(value)) {
    out.add(path, "type", `${path} must be an object, not ${describeValue(value)}.`);
    return false;
  }
  return true;
}

function checkString(out, value, path, { required = false, pattern = null, allowEmpty = false, maxLength = 4096 } = {}) {
  if (value === undefined) {
    if (required) out.add(path, "required", `${path} is required.`);
    return false;
  }
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    out.add(path, "type", `${path} must be a non-empty string.`);
    return false;
  }
  if (value.length > maxLength) {
    out.add(path, "too_long", `${path} is longer than ${maxLength} characters.`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    out.add(path, "pattern", `${path} must match ${pattern}.`);
    return false;
  }
  return true;
}

function checkEnum(out, value, path, values, { required = false } = {}) {
  if (value === undefined) {
    if (required) out.add(path, "required", `${path} is required.`);
    return false;
  }
  if (!values.includes(value)) {
    out.add(path, "enum", `${path} must be one of ${values.join(", ")} (got ${describeValue(value)}).`);
    return false;
  }
  return true;
}

function checkBoolean(out, value, path, { required = false } = {}) {
  if (value === undefined) {
    if (required) out.add(path, "required", `${path} is required.`);
    return false;
  }
  if (typeof value !== "boolean") {
    out.add(path, "type", `${path} must be true or false.`);
    return false;
  }
  return true;
}

function checkInteger(out, value, path, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) {
    if (required) out.add(path, "required", `${path} is required.`);
    return false;
  }
  if (!Number.isInteger(value)) {
    out.add(path, "type", `${path} must be an integer.`);
    return false;
  }
  if (value < min || value > max) {
    out.add(path, "range", `${path} must be between ${min} and ${max}.`);
    return false;
  }
  return true;
}

function checkStringList(out, value, path, { required = false, nonEmpty = false, pattern = null, values = null, unique = true } = {}) {
  if (value === undefined) {
    if (required) out.add(path, "required", `${path} is required.`);
    return false;
  }
  if (!Array.isArray(value)) {
    out.add(path, "type", `${path} must be a list.`);
    return false;
  }
  if (nonEmpty && value.length === 0) {
    out.add(path, "empty", `${path} must not be empty.`);
    return false;
  }
  const seen = new Set();
  let ok = true;
  value.forEach((item, index) => {
    const itemPath = joinPath(path, index);
    if (values) {
      if (!checkEnum(out, item, itemPath, values, { required: true })) ok = false;
    } else if (!checkString(out, item, itemPath, { required: true, pattern })) {
      ok = false;
    }
    if (unique && seen.has(item)) {
      out.add(itemPath, "duplicate", `${itemPath} repeats ${describeValue(item)}.`);
      ok = false;
    }
    seen.add(item);
  });
  return ok;
}

function checkRegex(out, value, path, { required = true } = {}) {
  if (!checkString(out, value, path, { required, maxLength: MAX_REGEX_LENGTH })) return false;
  try {
    new RegExp(value);
    return true;
  } catch (error) {
    out.add(path, "invalid_regex", `${path} is not a valid regular expression: ${error.message}`);
    return false;
  }
}

function checkLocalizedText(out, value, path, { required = false, partial = false } = {}) {
  if (!requireObject(out, value, path, { required })) return;
  checkKnownKeys(out, value, path, ["zh", "en"]);
  for (const locale of ["zh", "en"]) {
    checkString(out, value[locale], joinPath(path, locale), { required: !partial, maxLength: 2000 });
  }
}

function checkUrlPath(out, value, path, { required = false } = {}) {
  if (!checkString(out, value, path, { required })) return false;
  if (!value.startsWith("/")) {
    out.add(path, "pattern", `${path} must be a path starting with "/".`);
    return false;
  }
  return true;
}

function validateRuntimes(out, value, path, { partial = false } = {}) {
  if (!requireObject(out, value, path, { required: !partial })) return;
  if (partial) {
    for (const key of Object.keys(value)) {
      if (!OVERRIDE_RUNTIME_FIELDS.includes(key)) {
        out.add(joinPath(path, key), "override_field_forbidden", `An override may change only ${OVERRIDE_RUNTIME_FIELDS.map((field) => `runtimes.${field}`).join(" and ")}.`);
      }
    }
  } else {
    checkKnownKeys(out, value, path, ["default", "allowed", "envOverride", "allowCustomImage"]);
  }
  const allowedOk = checkStringList(out, value.allowed, joinPath(path, "allowed"), {
    required: !partial,
    nonEmpty: true,
    pattern: MANIFEST_KEY_PATTERN,
  });
  const defaultOk = checkString(out, value.default, joinPath(path, "default"), { required: !partial, pattern: MANIFEST_KEY_PATTERN });
  if (!partial && allowedOk && defaultOk && !value.allowed.includes(value.default)) {
    out.add(joinPath(path, "default"), "not_allowed", `runtimes.default "${value.default}" is not listed in runtimes.allowed.`);
  }
  if (partial) return;
  // envOverride may name runtimes an override later drops from allowed; such
  // entries are simply unused, so only their shape is checked.
  if (requireObject(out, value.envOverride, joinPath(path, "envOverride"), { required: false })) {
    for (const [key, envName] of Object.entries(value.envOverride)) {
      const entryPath = joinPath(joinPath(path, "envOverride"), key);
      if (!MANIFEST_KEY_PATTERN.test(key)) out.add(entryPath, "pattern", `envOverride keys are manifest keys (got "${key}").`);
      checkString(out, envName, entryPath, { required: true, pattern: ENV_NAME_PATTERN });
    }
  }
  checkBoolean(out, value.allowCustomImage, joinPath(path, "allowCustomImage"));
}

function validateHost(out, value, path) {
  if (!requireObject(out, value, path)) return;
  checkKnownKeys(out, value, path, ["kinds", "default", "containerPort", "ipc", "init", "ulimits", "restart", "gpus", "allowLan", "healthcheck", "cacheMounts"]);
  const kindsOk = checkStringList(out, value.kinds, joinPath(path, "kinds"), { required: true, nonEmpty: true, values: HOST_KINDS });
  if (checkEnum(out, value.default, joinPath(path, "default"), HOST_KINDS, { required: true }) && kindsOk && !value.kinds.includes(value.default)) {
    out.add(joinPath(path, "default"), "not_allowed", `host.default "${value.default}" is not listed in host.kinds.`);
  }
  const needsPort = kindsOk && value.kinds.includes("docker");
  checkInteger(out, value.containerPort, joinPath(path, "containerPort"), { required: needsPort, min: 1, max: 65535 });
  checkString(out, value.ipc, joinPath(path, "ipc"), { pattern: /^[a-z][a-z0-9:_-]*$/ });
  checkBoolean(out, value.init, joinPath(path, "init"));
  checkStringList(out, value.ulimits, joinPath(path, "ulimits"), { pattern: /^[a-z]+=-?\d+(?::-?\d+)?$/ });
  checkString(out, value.restart, joinPath(path, "restart"), { pattern: RESTART_PATTERN });
  checkEnum(out, value.gpus, joinPath(path, "gpus"), GPU_MODES);
  checkBoolean(out, value.allowLan, joinPath(path, "allowLan"));
  if (value.healthcheck !== undefined && value.healthcheck !== null) {
    const healthPath = joinPath(path, "healthcheck");
    if (requireObject(out, value.healthcheck, healthPath)) {
      checkKnownKeys(out, value.healthcheck, healthPath, ["cmd", "interval", "timeout", "retries", "startPeriod"]);
      checkString(out, value.healthcheck.cmd, joinPath(healthPath, "cmd"), { required: true });
      for (const key of ["interval", "timeout", "startPeriod"]) {
        checkString(out, value.healthcheck[key], joinPath(healthPath, key), { required: key !== "startPeriod", pattern: DURATION_PATTERN });
      }
      checkInteger(out, value.healthcheck.retries, joinPath(healthPath, "retries"), { required: true, min: 0, max: 100 });
    }
  }
  if (value.cacheMounts !== undefined) {
    const mountsPath = joinPath(path, "cacheMounts");
    if (!Array.isArray(value.cacheMounts)) {
      out.add(mountsPath, "type", `${mountsPath} must be a list.`);
    } else {
      value.cacheMounts.forEach((mount, index) => {
        const mountPath = joinPath(mountsPath, index);
        if (!requireObject(out, mount, mountPath)) return;
        checkKnownKeys(out, mount, mountPath, ["configKey", "target"]);
        checkString(out, mount.configKey, joinPath(mountPath, "configKey"), { required: true, pattern: /^[a-z][A-Za-z0-9]*$/ });
        checkString(out, mount.target, joinPath(mountPath, "target"), { required: true, pattern: /^\/[^\s:]*$/ });
      });
    }
  }
}

function validateApi(out, value, path) {
  if (!requireObject(out, value, path)) return;
  checkKnownKeys(out, value, path, ["openaiBase", "models", "health", "version", "ready", "probe"]);
  checkUrlPath(out, value.openaiBase, joinPath(path, "openaiBase"), { required: true });
  checkUrlPath(out, value.models, joinPath(path, "models"), { required: true });
  if (value.health !== null) checkUrlPath(out, value.health, joinPath(path, "health"), { required: true });
  if (value.version !== undefined) {
    if (checkStringList(out, value.version, joinPath(path, "version"))) {
      value.version.forEach((item, index) => checkUrlPath(out, item, joinPath(joinPath(path, "version"), index)));
    }
  }
  const readyPath = joinPath(path, "ready");
  if (requireObject(out, value.ready, readyPath)) {
    checkKnownKeys(out, value.ready, readyPath, ["kind"]);
    checkEnum(out, value.ready.kind, joinPath(readyPath, "kind"), READY_KINDS, { required: true });
  }
  const probePath = joinPath(path, "probe");
  if (requireObject(out, value.probe, probePath, { required: false })) {
    checkKnownKeys(out, value.probe, probePath, ["kind", "maxTokens"]);
    checkString(out, value.probe.kind, joinPath(probePath, "kind"), { required: true, pattern: /^[a-z][a-z0-9-]*$/ });
    checkInteger(out, value.probe.maxTokens, joinPath(probePath, "maxTokens"), { min: 1, max: 4096 });
  }
}

function validateCapabilities(out, value, path) {
  if (!requireObject(out, value, path)) return;
  checkKnownKeys(out, value, path, [...CAPABILITY_FLAGS, "speculative", "autoParsers", "roles"]);
  for (const flag of CAPABILITY_FLAGS) checkBoolean(out, value[flag], joinPath(path, flag), { required: true });
  checkStringList(out, value.speculative, joinPath(path, "speculative"), { required: true, pattern: /^[A-Za-z][A-Za-z0-9_-]*$/ });
  checkStringList(out, value.roles, joinPath(path, "roles"), { required: true, nonEmpty: true, values: ROLES });
  // autoParsers is exactly {tool, reasoning}: the parser the engine applies on
  // its own when the param is unset, "auto" when it detects one from the chat
  // template, or null when it applies none (00 §9.10).
  const parsersPath = joinPath(path, "autoParsers");
  if (!requireObject(out, value.autoParsers, parsersPath)) return;
  checkKnownKeys(out, value.autoParsers, parsersPath, ["tool", "reasoning"]);
  for (const key of ["tool", "reasoning"]) {
    const parserPath = joinPath(parsersPath, key);
    const parser = value.autoParsers[key];
    if (parser === undefined) out.add(parserPath, "required", `${parserPath} is required (a parser name, "auto" or null).`);
    else if (parser !== null) checkString(out, parser, parserPath, { pattern: /^[a-z0-9][a-z0-9_.-]*$/ });
  }
}

function validateMemoryModel(out, value, path) {
  if (!requireObject(out, value, path)) return;
  checkKnownKeys(out, value, path, ["kind", "fractionParam", "poolTokensParam"]);
  checkEnum(out, value.kind, joinPath(path, "kind"), MEMORY_MODEL_KINDS, { required: true });
  checkString(out, value.fractionParam, joinPath(path, "fractionParam"), { pattern: PARAM_ID_PATTERN });
  checkString(out, value.poolTokensParam, joinPath(path, "poolTokensParam"), { pattern: PARAM_ID_PATTERN });
}

function validateSecrets(out, value, path, { required }) {
  if (!requireObject(out, value, path, { required })) return;
  checkKnownKeys(out, value, path, ["apiKey"]);
  const keyPath = joinPath(path, "apiKey");
  if (!requireObject(out, value.apiKey, keyPath)) return;
  checkKnownKeys(out, value.apiKey, keyPath, ["mode", "env", "flag", "fallbackFlag", "file"]);
  const modeOk = checkEnum(out, value.apiKey.mode, joinPath(keyPath, "mode"), SECRET_MODES, { required: true });
  checkString(out, value.apiKey.env, joinPath(keyPath, "env"), { required: modeOk && value.apiKey.mode === "env", pattern: ENV_NAME_PATTERN });
  checkString(out, value.apiKey.flag, joinPath(keyPath, "flag"), { required: modeOk && value.apiKey.mode === "flag", pattern: FLAG_PATTERN });
  checkString(out, value.apiKey.fallbackFlag, joinPath(keyPath, "fallbackFlag"), { pattern: FLAG_PATTERN });
  checkString(out, value.apiKey.file, joinPath(keyPath, "file"), { pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ });
}

function validateIntrospection(out, value, path) {
  if (!requireObject(out, value, path, { required: false })) return;
  checkKnownKeys(out, value, path, ["entrypoint", "argv", "parser"]);
  checkString(out, value.entrypoint, joinPath(path, "entrypoint"), { required: true, pattern: /^[^\s]+$/ });
  checkStringList(out, value.argv, joinPath(path, "argv"), { required: true, unique: false });
  checkEnum(out, value.parser, joinPath(path, "parser"), INTROSPECTION_PARSERS, { required: true });
}

// metricsMap.map gives ordered sources per canonical camelCase key (01 §16.1).
// A Prometheus source is {name, kind}; kind is counter, gauge or histogram and
// no other spelling is accepted. Derived and JSON sources use derive/pick/ratio.
function validateMetricsMap(out, value, path) {
  if (!requireObject(out, value, path)) return;
  checkKnownKeys(out, value, path, ["path", "format", "map"]);
  checkUrlPath(out, value.path, joinPath(path, "path"), { required: true });
  checkEnum(out, value.format, joinPath(path, "format"), METRIC_FORMATS, { required: true });
  const mapPath = joinPath(path, "map");
  if (!requireObject(out, value.map, mapPath)) return;
  for (const [key, sources] of Object.entries(value.map)) {
    const keyPath = joinPath(mapPath, key);
    if (!CANONICAL_KEY_PATTERN.test(key)) out.add(keyPath, "pattern", `Canonical metric keys are camelCase (got "${key}").`);
    if (!Array.isArray(sources) || sources.length === 0) {
      out.add(keyPath, "type", `${keyPath} must be a non-empty list of sources.`);
      continue;
    }
    sources.forEach((source, index) => {
      const sourcePath = joinPath(keyPath, index);
      if (!requireObject(out, source, sourcePath)) return;
      checkKnownKeys(out, source, sourcePath, ["name", "kind", "scale", "label", "derive", "pick", "ratio"]);
      const forms = ["name", "derive", "pick", "ratio"].filter((field) => source[field] !== undefined);
      if (forms.length !== 1) {
        out.add(sourcePath, "source_form", `${sourcePath} needs exactly one of name, derive, pick or ratio.`);
      }
      if (source.name !== undefined) {
        checkString(out, source.name, joinPath(sourcePath, "name"), { pattern: /^[A-Za-z_:][A-Za-z0-9_:]*$/ });
        checkEnum(out, source.kind, joinPath(sourcePath, "kind"), METRIC_KINDS, { required: true });
      } else if (source.kind !== undefined) {
        checkEnum(out, source.kind, joinPath(sourcePath, "kind"), METRIC_KINDS);
      }
      if (source.scale !== undefined && (typeof source.scale !== "number" || !Number.isFinite(source.scale))) {
        out.add(joinPath(sourcePath, "scale"), "type", "scale must be a finite number.");
      }
      checkString(out, source.label, joinPath(sourcePath, "label"), { pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ });
      checkString(out, source.derive, joinPath(sourcePath, "derive"));
      checkString(out, source.pick, joinPath(sourcePath, "pick"));
      if (source.ratio !== undefined) {
        const ratioPath = joinPath(sourcePath, "ratio");
        if (!Array.isArray(source.ratio) || source.ratio.length !== 2 || source.ratio.some((item) => typeof item !== "string" || !item.trim())) {
          out.add(ratioPath, "type", "ratio must be a list of two source names.");
        }
      }
    });
  }
}

function validateLogPhases(out, value, path) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    out.add(path, "type", `${path} must be a list.`);
    return;
  }
  value.forEach((phase, index) => {
    const phasePath = joinPath(path, index);
    if (!requireObject(out, phase, phasePath)) return;
    checkKnownKeys(out, phase, phasePath, ["match", "phase", "percent", "stageText", "fact"]);
    checkRegex(out, phase.match, joinPath(phasePath, "match"));
    checkEnum(out, phase.phase, joinPath(phasePath, "phase"), LIFECYCLE_PHASES, { required: true });
    if (phase.percent !== undefined && (typeof phase.percent !== "number" || phase.percent < 0 || phase.percent > 100)) {
      out.add(joinPath(phasePath, "percent"), "range", "percent must be a number between 0 and 100.");
    }
    checkLocalizedText(out, phase.stageText, joinPath(phasePath, "stageText"));
  });
}

// logFacts and errorSignatures are shaped by ENG-24 and 02's error-signature
// schema; here each entry only has to be an object whose regexes compile.
function validatePatternEntries(out, value, path, { idRequired }) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    out.add(path, "type", `${path} must be a list.`);
    return;
  }
  const seen = new Set();
  value.forEach((entry, index) => {
    const entryPath = joinPath(path, index);
    if (!requireObject(out, entry, entryPath)) return;
    if (checkString(out, entry.id, joinPath(entryPath, "id"), { required: idRequired, pattern: /^[a-z][a-z0-9_.-]*$/ })) {
      if (seen.has(entry.id)) out.add(joinPath(entryPath, "id"), "duplicate", `${path} repeats id "${entry.id}".`);
      seen.add(entry.id);
    }
    for (const key of ["match", "regex"]) {
      if (entry[key] !== undefined) checkRegex(out, entry[key], joinPath(entryPath, key));
    }
  });
}

function validateTemplate(out, value, path) {
  if (!requireObject(out, value, path)) return;
  const argsPath = joinPath(path, "args");
  if (!Array.isArray(value.args)) {
    out.add(argsPath, "type", `${argsPath} must be a list.`);
    return;
  }
  value.args.forEach((item, index) => {
    if (typeof item === "string") return;
    if (!isPlainObject(item)) out.add(joinPath(argsPath, index), "type", "A template item is a string token or an object.");
  });
}

function validateFull(out, obj, { newEngine }) {
  checkKnownKeys(out, obj, "", DESCRIPTOR_FIELDS);
  if (checkInteger(out, obj.schemaVersion, "schemaVersion", { required: true, min: 1 }) && !SUPPORTED_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
    out.add("schemaVersion", "unsupported_schema_version", `schemaVersion ${obj.schemaVersion} is newer than this platform understands.`);
  }
  if (checkString(out, obj.asOf, "asOf", { required: true, pattern: DATE_PATTERN }) && !Number.isFinite(Date.parse(obj.asOf))) {
    out.add("asOf", "pattern", "asOf must be a calendar date (YYYY-MM-DD).");
  }
  checkInteger(out, obj.staleAfterDays, "staleAfterDays", { required: true, min: 1, max: 3650 });
  checkLocalizedText(out, obj.label, "label", { required: true });
  checkLocalizedText(out, obj.description, "description");
  checkEnum(out, obj.family, "family", FAMILIES, { required: true });
  const adapterOk = checkEnum(out, obj.adapter, "adapter", ADAPTERS, { required: true });
  const tierOk = checkInteger(out, obj.tier, "tier", { required: true, min: 1, max: 3 });
  checkEnum(out, obj.status, "status", STATUSES, { required: true });
  const hostManagerOk = checkEnum(out, obj.hostManager, "hostManager", HOST_MANAGERS, { required: true });

  if (adapterOk) {
    const tier1Adapter = TIER1_ADAPTERS.includes(obj.adapter);
    if (newEngine && !OVERRIDE_ADAPTERS.includes(obj.adapter)) {
      out.add("adapter", "adapter_not_allowed", `An override can add engines only with adapter ${OVERRIDE_ADAPTERS.join(" or ")}; tier-1 adapters are reserved.`);
    } else if (tier1Adapter && obj.id !== obj.adapter) {
      out.add("adapter", "tier1_adapter_reserved", `Adapter "${obj.adapter}" belongs to the built-in engine "${obj.adapter}".`);
    }
    if (tierOk && tier1Adapter !== (obj.tier === 1)) {
      out.add("tier", "tier_mismatch", "Tier 1 is exactly the vllm, sglang and llamacpp adapters.");
    }
    if (hostManagerOk) {
      const expected = obj.adapter === "external" ? "entry" : TIER1_HOST_MANAGER[obj.adapter];
      if (expected && obj.hostManager !== expected) {
        out.add("hostManager", "host_manager_mismatch", `Adapter "${obj.adapter}" runs on hostManager "${expected}".`);
      } else if (!expected && obj.hostManager === "entry") {
        out.add("hostManager", "host_manager_mismatch", "Only the external adapter is hosted by the entry.");
      }
    }
  }

  const external = obj.adapter === "external";
  if (requireObject(out, obj.legacy, "legacy", { required: false })) {
    checkKnownKeys(out, obj.legacy, "legacy", ["engineLabel", "managerEngineField"]);
    checkString(out, obj.legacy.engineLabel, "legacy.engineLabel", { pattern: /^[a-z][a-z0-9-]*$/ });
    checkString(out, obj.legacy.managerEngineField, "legacy.managerEngineField", { pattern: /^[a-z][a-z0-9-]*$/ });
  }
  checkStringList(out, obj.artifactFormats, "artifactFormats", { required: true, nonEmpty: !external, values: ARTIFACT_FORMATS });
  if (external) {
    if (obj.runtimes !== undefined) validateRuntimes(out, obj.runtimes, "runtimes");
  } else {
    validateRuntimes(out, obj.runtimes, "runtimes");
  }
  validateHost(out, obj.host, "host");
  if (external) {
    if (obj.api !== undefined) validateApi(out, obj.api, "api");
  } else {
    validateApi(out, obj.api, "api");
  }
  if (requireObject(out, obj.apiSurface, "apiSurface", { required: false })) {
    checkKnownKeys(out, obj.apiSurface, "apiSurface", API_SURFACE_KEYS);
    for (const key of API_SURFACE_KEYS) checkBoolean(out, obj.apiSurface[key], joinPath("apiSurface", key));
  }
  if (requireObject(out, obj.apiQuirks, "apiQuirks", { required: false })) {
    checkKnownKeys(out, obj.apiQuirks, "apiQuirks", ["reasoningField"]);
    if (obj.apiQuirks.reasoningField !== null) checkString(out, obj.apiQuirks.reasoningField, "apiQuirks.reasoningField", { pattern: /^[a-z][a-z0-9_]*$/ });
  }
  checkString(out, obj.catalog, "catalog", { pattern: CATALOG_PATTERN });
  validateMemoryModel(out, obj.memoryModel, "memoryModel");
  validateCapabilities(out, obj.capabilities, "capabilities");
  checkStringList(out, obj.knowledgeKeys, "knowledgeKeys", { pattern: /^[a-z][A-Za-z0-9]*$/ });
  validateSecrets(out, obj.secrets, "secrets", { required: !external });
  checkStringList(out, obj.managedFlags, "managedFlags", { pattern: FLAG_PATTERN });
  checkStringList(out, obj.extraEnvAllow, "extraEnvAllow", { pattern: ENV_PREFIX_PATTERN });
  validateIntrospection(out, obj.introspection, "introspection");
  if (obj.metricsMap !== undefined) validateMetricsMap(out, obj.metricsMap, "metricsMap");
  validateLogPhases(out, obj.logPhases, "logPhases");
  validatePatternEntries(out, obj.logFacts, "logFacts", { idRequired: false });
  validatePatternEntries(out, obj.errorSignatures, "errorSignatures", { idRequired: true });

  if (obj.adapter === "docker-template") validateTemplate(out, obj.template, "template");
  else if (obj.template !== undefined) out.add("template", "field_not_applicable", "template is used only by the docker-template adapter.");
  if (external) requireObject(out, obj.external, "external", { required: false });
  else if (obj.external !== undefined) out.add("external", "field_not_applicable", "external is used only by the external adapter.");
}

// An override of an engine that already exists may touch only the fields in
// OVERRIDE_FIELDS; anything else (adapter, host, secrets...) rejects the file.
function validateOverridePatch(out, obj) {
  for (const key of Object.keys(obj)) {
    if (OVERRIDE_METADATA_FIELDS.includes(key) || OVERRIDE_FIELDS.includes(key)) continue;
    out.add(key, "override_field_forbidden", `An override may change only ${OVERRIDE_FIELDS.join(", ")} (not "${key}").`);
  }
  checkInteger(out, obj.schemaVersion, "schemaVersion", { min: 1, max: Math.max(...SUPPORTED_SCHEMA_VERSIONS) });
  checkString(out, obj.asOf, "asOf", { pattern: DATE_PATTERN });
  checkInteger(out, obj.staleAfterDays, "staleAfterDays", { min: 1, max: 3650 });
  checkEnum(out, obj.status, "status", STATUSES);
  if (obj.label !== undefined) checkLocalizedText(out, obj.label, "label", { partial: true });
  if (obj.runtimes !== undefined) validateRuntimes(out, obj.runtimes, "runtimes", { partial: true });
  if (obj.metricsMap !== undefined) validateMetricsMap(out, obj.metricsMap, "metricsMap");
  validateLogPhases(out, obj.logPhases, "logPhases");
  validatePatternEntries(out, obj.logFacts, "logFacts", { idRequired: false });
  validatePatternEntries(out, obj.errorSignatures, "errorSignatures", { idRequired: true });
}

/**
 * validateDescriptor(obj, { mode: "bundled"|"override"|"draft", knownIds? })
 *   → { ok, errors: [{ path, code, message }], kind: "descriptor"|"override" }
 *
 * "bundled" checks a complete descriptor. "override" and "draft" treat an id
 * that already exists (a tier-1 id, or one of knownIds) as a partial override
 * limited to OVERRIDE_FIELDS, and anything else as a new engine that must use
 * a data-driven adapter. Nothing here touches the filesystem.
 */
function validateDescriptor(obj, options = {}) {
  const mode = options.mode || "bundled";
  if (!MODES.includes(mode)) throw new TypeError(`validateDescriptor mode must be one of ${MODES.join(", ")}.`);
  const out = createCollector();
  if (!isPlainObject(obj)) {
    out.add("", "type", `A descriptor must be a JSON object, not ${describeValue(obj)}.`);
    return { ok: false, errors: out.errors, kind: "descriptor" };
  }
  checkString(out, obj.id, "id", { required: true, pattern: ENGINE_ID_PATTERN });
  const knownIds = new Set([...TIER1_ENGINE_IDS, ...(options.knownIds || [])]);
  const isOverride = mode !== "bundled" && typeof obj.id === "string" && knownIds.has(obj.id);
  if (isOverride) validateOverridePatch(out, obj);
  else validateFull(out, obj, { newEngine: mode !== "bundled" });
  return { ok: out.errors.length === 0, errors: out.errors, kind: isOverride ? "override" : "descriptor" };
}

module.exports = {
  ADAPTERS,
  ARTIFACT_FORMATS,
  ENGINE_ID_PATTERN,
  MEMORY_MODEL_KINDS,
  METRIC_KINDS,
  OVERRIDE_ADAPTERS,
  OVERRIDE_FIELDS,
  ROLES,
  STATUSES,
  TIER1_ENGINE_IDS,
  isPlainObject,
  validateDescriptor,
};
