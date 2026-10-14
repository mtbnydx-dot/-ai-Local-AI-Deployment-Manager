"use strict";

// Layered model knowledge (docs/overhaul/02-models.md §8, D5): model families,
// chat template signatures and error signatures are data, merged from five
// layers by entry id, validated per kind, and reported at
// GET /api/knowledge/status. Loading never throws: an unreadable or corrupt
// file, an invalid entry or an unsafe regular expression is skipped and
// reported, and the rest of the knowledge stays in force.
//
// Layers, low to high (§8.1, contract change C4):
//   1 bundled     manager-core/data/knowledge/{families,template-signatures,error-signatures}.json
//                 (+ the engine descriptors' errorSignatures[] additions, §8.1)
//   2 legacy-v1   <AI_ROOT>/config/model-capabilities.json, converted at load by
//                 migrate-v1.js (MOD-6); never rewritten
//   3 pack        <AI_ROOT>/config/knowledge.d/packs/*.json (imported packs sit below
//                 the owner's own files)
//   4 user        <AI_ROOT>/config/knowledge.d/*.json (any kind per file)
//   5 model       <AI_ROOT>/config/knowledge.d/models/*.json and the read-only
//                 <modelDir>/.platform/model.json; entries apply to the models they
//                 select (match: {contentDigest} | {repo} | {path}), not globally
//
// A later layer replaces a whole entry with the same id, unless the entry sets
// "$merge": "deep" (objects merge key by key, arrays and scalars replace);
// {"id": "x", "$delete": true} hides a lower layer's entry. Families are
// evaluated by priority, then specificity, then layer, then file order.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ageInDays, userDataDir } = require("../reference-data");
const { compileSchema } = require("./json-schema-lite");
const { DEFAULT_TENSOR_CLASSES } = require("./detectors/topology");

const KINDS = Object.freeze(["families", "template-signatures", "error-signatures"]);
const SCHEMA_VERSIONS = Object.freeze({ families: 2, "template-signatures": 1, "error-signatures": 1 });
const LAYERS = Object.freeze([
  Object.freeze({ name: "bundled", rank: 1 }),
  Object.freeze({ name: "legacy-v1", rank: 2 }),
  Object.freeze({ name: "pack", rank: 3 }),
  Object.freeze({ name: "user", rank: 4 }),
  Object.freeze({ name: "model", rank: 5 }),
]);
const LAYER_RANK = Object.freeze(Object.fromEntries(LAYERS.map((layer) => [layer.name, layer.rank])));

const BUNDLED_KNOWLEDGE_DIR = path.join(__dirname, "..", "data", "knowledge");
const BUNDLED_SCHEMA_DIR = path.join(BUNDLED_KNOWLEDGE_DIR, "schema");
const LEGACY_V1_FILE = "model-capabilities.json";
const HITS_FILE = "knowledge-hits.json";
const MODEL_DIR_OVERRIDE = path.join(".platform", "model.json");

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_FILE = 5000;
const REGEX_MAX_LENGTH = 300;
const REGEX_FLAGS_ALLOWED = Object.freeze(["i", "m", "s"]);
// Log scanning limits (§8.1): consumers (root-cause.js) cut each line and scan the tail only.
const LOG_LINE_MAX = 2000;
const LOG_LINES_MAX = 4000;
const DEFAULT_RECHECK_MS = 2000;
const DEFAULT_FLUSH_MS = 60 * 1000;
const MODEL_DIR_CACHE_MAX = 64;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Header fields that only describe freshness: an invalid value is dropped and
// reported without discarding the file.
const SOFT_HEADER_PATHS = new Set(["/asOf", "/staleAfterDays"]);
// Default regex flags per kind: log lines and names are matched case-insensitively,
// chat template text is matched as written.
const DEFAULT_FLAGS = Object.freeze({ families: "i", "template-signatures": "", "error-signatures": "i" });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digestOf(value) {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

// Objects merge key by key, arrays and scalars replace (§8.1 "$merge": "deep").
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const merged = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? deepMerge(merged[key], value) : clone(value);
  }
  return merged;
}

function withoutKeys(object, keys) {
  const copy = {};
  for (const [key, value] of Object.entries(object)) {
    if (!keys.includes(key)) copy[key] = value;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Regular-expression safety (§8.1): every pattern from any layer is checked
// before it is compiled.

/**
 * Why `source` may not be used as a pattern, or null when it is safe: longer
 * than 300 characters, a backreference, a nested quantifier such as (a+)+, a
 * flag outside i/m/s, or not a valid expression at all.
 * -> null | {code, message}
 */
function checkRegexSafety(source, flags = "") {
  if (typeof source !== "string" || !source.length) return { code: "regex_invalid", message: "A pattern must be a non-empty string." };
  if (source.length > REGEX_MAX_LENGTH) return { code: "regex_too_long", message: `A pattern may have at most ${REGEX_MAX_LENGTH} characters.` };
  const flagText = typeof flags === "string" ? flags : "";
  if ([...flagText].some((flag, index) => !REGEX_FLAGS_ALLOWED.includes(flag) || flagText.indexOf(flag) !== index)) {
    return { code: "regex_flags", message: `Pattern flags may only be ${REGEX_FLAGS_ALLOWED.join(", ")}, each once.` };
  }
  const scanned = scanRegexStructure(source);
  if (scanned) return scanned;
  try {
    new RegExp(source, flagText);
  } catch (error) {
    return { code: "regex_invalid", message: `The pattern does not compile: ${error.message}` };
  }
  return null;
}

// One pass over the pattern: backreferences, and a group that repeats an atom
// that itself repeats ((a+)+, ((a+)b)*, (a{2,})+), which backtracks without bound.
function scanRegexStructure(source) {
  const frames = [{ repeats: false }];
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1] || "";
      if (!inClass && (/[1-9]/.test(next) || next === "k")) {
        return { code: "regex_backreference", message: "Backreferences are not allowed in knowledge patterns." };
      }
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      if (source[index + 1] === "^") index += 1;
      if (source[index + 1] === "]") index += 1;
    } else if (char === "(") {
      frames.push({ repeats: false });
    } else if (char === ")") {
      const frame = frames.length > 1 ? frames.pop() : { repeats: false };
      const quantifier = quantifierAt(source, index + 1);
      if (quantifier && frame.repeats) {
        return { code: "regex_nested_quantifier", message: "Nested quantifiers such as (a+)+ are not allowed in knowledge patterns." };
      }
      frames[frames.length - 1].repeats ||= Boolean(quantifier) || frame.repeats;
    } else {
      const quantifier = quantifierAt(source, index);
      if (quantifier) {
        frames[frames.length - 1].repeats = true;
        index += quantifier.length - 1;
      }
    }
  }
  return null;
}

// The repeating quantifier at `index` (* + {n,} {n,m} with m > 1) or null; ? and {n}/{0,1} do not repeat.
function quantifierAt(source, index) {
  const char = source[index];
  if (char === "*" || char === "+") return char;
  if (char !== "{") return null;
  const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(index, index + 24));
  if (!match) return null;
  const repeats = match[2] ? match[3] === "" || Number(match[3]) > 1 : Number(match[1]) > 1;
  return repeats ? match[0] : null;
}

const regexCache = new Map();
const REGEX_CACHE_MAX = 512;

/**
 * Compiles a knowledge pattern once -> {ok, regexp?, code?, message?}. The
 * result is shared, so callers must not use the `g` or `y` flags (not allowed).
 */
function compileSafeRegex(source, flags = "i") {
  const key = `${flags}/${source}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  const problem = checkRegexSafety(source, flags);
  const result = problem ? { ok: false, ...problem } : { ok: true, regexp: new RegExp(source, flags) };
  if (regexCache.size >= REGEX_CACHE_MAX) regexCache.delete(regexCache.keys().next().value);
  regexCache.set(key, result);
  return result;
}

/** The lines of a log that may be scanned: the last 4000, each cut to 2000 characters. */
function prepareLogLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const tail = lines.length > LOG_LINES_MAX ? lines.slice(lines.length - LOG_LINES_MAX) : lines;
  return tail.map((line) => (line.length > LOG_LINE_MAX ? line.slice(0, LOG_LINE_MAX) : line));
}

// ---------------------------------------------------------------------------
// Schemas (manager-core/data/knowledge/schema/*.json): compiled once.

const schemaCache = new Map();

function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { ok: false, code: "not_a_file", message: "Not a regular file." };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, code: "file_too_large", message: `The file is larger than ${MAX_FILE_BYTES} bytes.` };
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!text.trim()) return { ok: false, code: "empty_file", message: "The file is empty." };
  try {
    return { ok: true, value: JSON.parse(text), size: stat.size };
  } catch (error) {
    return { ok: false, code: "invalid_json", message: `The file is not valid JSON: ${error.message}` };
  }
}

function safeReadJson(file) {
  try {
    return readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, missing: true, code: "missing", message: "The file does not exist." };
    return { ok: false, code: "unreadable", message: `The file could not be read: ${error.code || error.message}` };
  }
}

function compileKindSchemas(schema) {
  const defs = schema.$defs || {};
  const reduce = (property) => (isPlainObject(property) && property.type ? { type: property.type } : {});
  const headerProperties = { ...schema.properties };
  for (const name of ["entries", "tensorClasses", "capabilityIdAliases"]) {
    if (headerProperties[name]) headerProperties[name] = reduce(headerProperties[name]);
  }
  const compiled = {
    header: compileSchema({ ...schema, properties: headerProperties }),
    entry: compileSchema({ $ref: "#/$defs/entry", $defs: defs }),
  };
  if (defs.scopedEntry) compiled.scopedEntry = compileSchema({ $ref: "#/$defs/scopedEntry", $defs: defs });
  if (defs.tensorClass) compiled.tensorClass = compileSchema({ $ref: "#/$defs/tensorClass", $defs: defs });
  return compiled;
}

/** The compiled schemas per kind -> {schemas, errors[]}; a kind whose schema file is broken has none. */
function loadSchemas(schemaDir = BUNDLED_SCHEMA_DIR) {
  if (schemaCache.has(schemaDir)) return schemaCache.get(schemaDir);
  const schemas = {};
  const errors = [];
  for (const kind of KINDS) {
    const file = path.join(schemaDir, `${kind}.json`);
    const read = safeReadJson(file);
    if (!read.ok) {
      errors.push({ file: `schema/${kind}.json`, entryId: "", code: "schema_unavailable", message: read.message });
      continue;
    }
    try {
      schemas[kind] = compileKindSchemas(read.value);
    } catch (error) {
      errors.push({ file: `schema/${kind}.json`, entryId: "", code: "schema_unavailable", message: error.message });
    }
  }
  const value = { schemas, errors };
  schemaCache.set(schemaDir, value);
  return value;
}

function describeErrors(result, limit = 3) {
  return result.errors.slice(0, limit).map((item) => `${item.path || "/"} ${item.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// Entry preparation: aliases, defaults and the extra checks the schemas cannot express.

function snakeCaseFromId(id) {
  const code = String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(code) ? code.slice(0, 64) : "";
}

// `stage` is the deprecated spelling of `phase` (01 descriptors still use it).
function normalizeStage(entry) {
  if (!Object.hasOwn(entry, "stage")) return { entry };
  const copy = withoutKeys(entry, ["stage"]);
  if (copy.phase === undefined) {
    copy.phase = entry.stage;
  } else if (copy.phase !== entry.stage) {
    return { entry, problem: { code: "phase_stage_conflict", message: `phase (${copy.phase}) and its deprecated alias stage (${entry.stage}) disagree.` } };
  }
  return { entry: copy };
}

function applyDefaults(kind, entry, options = {}) {
  if (kind !== "error-signatures") return entry;
  const copy = { ...entry };
  if (copy.code === undefined && typeof copy.id === "string") {
    const code = snakeCaseFromId(copy.id);
    if (code) copy.code = code;
  }
  if (copy.engines === undefined) copy.engines = options.defaultEngines ? [...options.defaultEngines] : ["*"];
  if (copy.severity === undefined) copy.severity = "error";
  if (copy.rootCause === undefined) copy.rootCause = false;
  return copy;
}

function patternsOf(kind, entry) {
  if (kind === "families") {
    const match = isPlainObject(entry.match) ? entry.match : {};
    const patterns = [...(match.namePatterns || []), ...(match.architecturePatterns || [])];
    for (const clause of match.where || []) {
      if (clause?.op === "matches" && typeof clause.value === "string") patterns.push(clause.value);
    }
    return patterns;
  }
  if (kind === "template-signatures") return Array.isArray(entry.features?.regex) ? entry.features.regex : [];
  return typeof entry.regex === "string" ? [entry.regex] : [];
}

function checkEntryPatterns(kind, entry) {
  const flags = typeof entry.flags === "string" ? entry.flags : DEFAULT_FLAGS[kind];
  for (const source of patternsOf(kind, entry)) {
    const problem = checkRegexSafety(source, flags);
    if (problem) return { code: "unsafe_regex", message: `${problem.message} (${JSON.stringify(String(source).slice(0, 60))})` };
  }
  return null;
}

function checkSuggestionParams(entry, paramIds) {
  if (!paramIds || !Array.isArray(entry.suggestions)) return null;
  for (const suggestion of entry.suggestions) {
    if (suggestion?.kind === "param" && typeof suggestion.param === "string" && !paramIds.has(suggestion.param)) {
      return { code: "unknown_param", message: `Suggestion parameter ${suggestion.param} is not in any engine parameter catalog.` };
    }
  }
  return null;
}

function normalizeSha(entry) {
  if (!Array.isArray(entry.sha256)) return entry;
  return { ...entry, sha256: entry.sha256.map((hash) => hash.toLowerCase()) };
}

// ---------------------------------------------------------------------------
// Matching.

function normalizePathKey(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function pointerGet(object, pointer) {
  let current = object;
  for (const token of String(pointer).split("/").slice(1)) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
}

function whereHolds(clause, card) {
  const actual = pointerGet(card, clause.path);
  const { value } = clause;
  switch (clause.op) {
    case "exists": return (actual !== undefined && actual !== null) === (value !== false);
    case "eq": return actual === value;
    case "ne": return actual !== value;
    case "in": return Array.isArray(value) && value.includes(actual);
    case "includes": return Array.isArray(actual) && actual.includes(value);
    case "gt": return typeof actual === "number" && actual > value;
    case "gte": return typeof actual === "number" && actual >= value;
    case "lt": return typeof actual === "number" && actual < value;
    case "lte": return typeof actual === "number" && actual <= value;
    case "matches": {
      const compiled = typeof value === "string" ? compileSafeRegex(value, "i") : null;
      return Boolean(compiled?.ok) && typeof actual === "string" && compiled.regexp.test(actual);
    }
    default: return false;
  }
}

function clauseHolds(clause, card) {
  const checks = [
    ["templateSignature", card.template?.signatureId],
    ["quantMethod", card.quant?.method],
    ["role", card.role?.value],
  ];
  for (const [key, actual] of checks) {
    if (clause[key] !== undefined && !(Array.isArray(clause[key]) && clause[key].includes(actual))) return false;
  }
  return true;
}

function cardNames(card) {
  const repo = typeof card.ref?.repo === "string" ? card.ref.repo : "";
  const names = [card.identity?.displayName, repo, repo.split("/").pop()];
  const local = card.ref?.file || card.ref?.path;
  if (local) names.push(path.basename(String(local).replace(/\\/g, "/")));
  return names.filter((name) => typeof name === "string" && name);
}

function hasDeclaredIdentity(card) {
  const identity = card.identity || {};
  return Boolean(identity.modelType || identity.textModelType || identity.ggufArchitecture || (Array.isArray(identity.architectures) && identity.architectures.length));
}

// How one family entry fares against a card: null (no match) or the clauses it satisfied.
function evaluateFamily(entry, card) {
  const match = entry.match || {};
  const identity = card.identity || {};
  const types = [identity.modelType, identity.textModelType].filter(Boolean);
  const architectures = Array.isArray(identity.architectures) ? identity.architectures : [];
  const lists = {
    modelTypes: () => types.some((type) => match.modelTypes.includes(type)),
    architectures: () => architectures.some((name) => match.architectures.includes(name)),
    architecturePatterns: () => architectures.some((name) => match.architecturePatterns.some((source) => {
      const compiled = compileSafeRegex(source, "i");
      return compiled.ok && compiled.regexp.test(name);
    })),
    ggufArchitectures: () => Boolean(identity.ggufArchitecture) && match.ggufArchitectures.includes(identity.ggufArchitecture),
  };
  const gated = Object.keys(lists).filter((key) => match[key]?.length);
  const satisfied = gated.filter((key) => lists[key]());
  const byName = !hasDeclaredIdentity(card) && Boolean(match.namePatterns?.length);
  // Declared identity gates an entry. Name patterns are the last resort: only a
  // card that declares no identity at all is matched by its name.
  if (!byName && (gated.length ? !satisfied.length : Boolean(match.namePatterns?.length))) return null;

  const matchedBy = byName ? [] : [...satisfied];
  let templateClause = false;
  for (const clause of match.require || []) {
    if (!clauseHolds(clause, card)) return null;
    templateClause ||= clause.templateSignature !== undefined;
    matchedBy.push(...Object.keys(clause));
  }
  for (const clause of match.where || []) {
    if (!whereHolds(clause, card)) return null;
    matchedBy.push(`where:${clause.path}`);
  }

  if (byName) {
    const hit = cardNames(card).some((name) => match.namePatterns.some((source) => {
      const compiled = compileSafeRegex(source, "i");
      return compiled.ok && compiled.regexp.test(name);
    }));
    if (!hit) return null;
    return { matchedBy: ["namePatterns", ...new Set(matchedBy)], confidence: "name-heuristic", clauses: matchedBy.length + 1 };
  }
  return {
    matchedBy: [...new Set(matchedBy)],
    confidence: satisfied.length && !templateClause ? "declared" : "detected",
    clauses: matchedBy.length,
  };
}

function scopedSelects(match, card) {
  if (!isPlainObject(match)) return false;
  if (match.contentDigest) return typeof card.contentDigest === "string" && match.contentDigest === card.contentDigest;
  if (match.repo) {
    const wanted = String(match.repo).toLowerCase();
    return [card.ref?.repo, card.origin?.repo].some((repo) => typeof repo === "string" && repo.toLowerCase() === wanted);
  }
  if (match.path) return card.ref?.kind === "local" && Boolean(card.ref.path) && normalizePathKey(card.ref.path) === normalizePathKey(match.path);
  return false;
}

/**
 * matchFamily(card, knowledge) -> {entry, matchedBy[], matchedByText, confidence,
 * knowledgeConfidence, layer, file}. Declared identity (modelTypes,
 * architectures, architecturePatterns, ggufArchitectures) gates an entry;
 * require/where clauses discriminate entries that share a model_type; the most
 * specific passing entry wins (priority, then satisfied clauses, then layer, then
 * file order). Name patterns are consulted only when the card declares no
 * identity, and count as a name-heuristic hit. Per-model overrides that select
 * the card are applied last. A card nothing matches gives {entry: null}.
 */
function matchFamilyIn(knowledge, card, extraScoped = []) {
  const none = { entry: null, matchedBy: [], matchedByText: "", confidence: null, knowledgeConfidence: null, layer: null, file: null };
  if (!isPlainObject(card)) return none;
  let best = null;
  for (const record of knowledge.records.families) {
    const verdict = evaluateFamily(record.entry, card);
    if (!verdict) continue;
    const candidate = { record, verdict };
    if (!best || compareCandidates(candidate, best) < 0) best = candidate;
  }
  let result = best
    ? {
      entry: best.record.entry,
      matchedBy: best.verdict.matchedBy,
      confidence: best.verdict.confidence,
      layer: best.record.layer,
      file: best.record.file,
    }
    : { entry: null, matchedBy: [], confidence: null, layer: null, file: null };
  if (best?.verdict.confidence === "name-heuristic") knowledge.recordHit?.("families", best.record.id);

  const scoped = [...extraScoped, ...knowledge.scoped.filter((record) => scopedSelects(record.entry.match, card))];
  for (const record of scoped) {
    const patch = record.patch;
    const body = withoutKeys(patch, ["$merge"]);
    const byId = knowledge.records.families.find((family) => family.id === patch.id)?.entry || null;
    const base = result.entry && result.entry.id === patch.id ? result.entry : byId;
    const entry = patch.$merge === "deep" && base ? deepMerge(base, body) : clone(body);
    result = {
      entry: deepFreeze(entry),
      matchedBy: [...new Set([...result.matchedBy, "model-override"])],
      confidence: "declared",
      layer: "model",
      file: record.file,
    };
  }
  if (!result.entry) return none;
  return {
    ...result,
    matchedByText: result.matchedBy.join("+"),
    knowledgeConfidence: result.entry.confidence || null,
  };
}

function compareCandidates(left, right) {
  const priority = (right.record.entry.priority || 0) - (left.record.entry.priority || 0);
  if (priority) return priority;
  const clauses = right.verdict.clauses - left.verdict.clauses;
  if (clauses) return clauses;
  const layer = right.record.layerRank - left.record.layerRank;
  if (layer) return layer;
  return left.record.order - right.record.order;
}

// ---------------------------------------------------------------------------
// Display paths: status and errors never carry absolute paths.

function createPathDisplayer({ aiRoot, configDir, bundledDir }) {
  const roots = [
    [aiRoot, "<AI_ROOT>"],
    [configDir, "<config>"],
    [bundledDir, "<bundled>"],
  ].filter(([dir]) => dir);
  return function display(file) {
    const target = path.resolve(String(file || ""));
    for (const [dir, label] of roots) {
      const relative = path.relative(dir, target);
      if (relative === "") return label;
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return `${label}/${relative.split(path.sep).join("/")}`;
    }
    return path.basename(target);
  };
}

function defaultAiRoot(env = process.env) {
  return env.AI_ROOT ? path.resolve(env.AI_ROOT) : path.resolve(__dirname, "..", "..");
}

function listJsonFiles(dir) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    return { files, error: null };
  } catch (error) {
    return { files: [], error: error.code === "ENOENT" || error.code === "ENOTDIR" ? null : error };
  }
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${path.basename(file)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${path.basename(file)}:-`;
  }
}

// ---------------------------------------------------------------------------
// The loader.

/**
 * createKnowledgeLoader(options) -> {load, status, matchFamily, errorSignatures,
 * familyIdForCapabilityId, tensorClasses, entries, recordHeuristicHit,
 * flushHits, close, sourceDirs}
 *
 * options (all optional; tests inject temp directories):
 *   bundledDir, schemaDir   the bundled knowledge and its schemas
 *   configDir               <AI_ROOT>/config (default: reference-data's user data dir)
 *   cacheDir                where knowledge-hits.json lives (default <AI_ROOT>/cache)
 *   aiRoot                  only used to shorten displayed paths
 *   registry                engine registry for errorSignatureAdditions(); undefined = the
 *                           process-wide registry, null = none
 *   paramIds                Set (or function returning one) of launch-parameter catalog ids
 *                           that error-signature suggestions may name; default: every
 *                           engine catalog; null skips the check
 *   convertV1               (v1Json) -> {families, capabilityIdAliases?, warnings?}
 *                           default: migrate-v1.js when it exists (MOD-6)
 *   recheckMs               how often load() looks at the files for edits (default 2000)
 *   flushIntervalMs         heuristic-hit flush period (default 60000)
 *   now                     () => ms, for tests
 */
function createKnowledgeLoader(options = {}) {
  const bundledDir = options.bundledDir || BUNDLED_KNOWLEDGE_DIR;
  const schemaDir = options.schemaDir || BUNDLED_SCHEMA_DIR;
  const configDir = options.configDir || userDataDir();
  const aiRoot = options.aiRoot || defaultAiRoot();
  const cacheDir = options.cacheDir || path.join(aiRoot, "cache");
  const hitsFile = options.hitsFile || path.join(cacheDir, HITS_FILE);
  const knowledgeDir = path.join(configDir, "knowledge.d");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const recheckMs = Number.isFinite(options.recheckMs) ? options.recheckMs : DEFAULT_RECHECK_MS;
  const flushIntervalMs = Number.isFinite(options.flushIntervalMs) ? options.flushIntervalMs : DEFAULT_FLUSH_MS;
  const display = createPathDisplayer({ aiRoot, configDir, bundledDir });

  let state = null;
  let checkedAt = 0;
  let lastGoodDigest = null;
  let paramIdCache;
  const pendingHits = new Map();
  let hitsTimer = null;
  let hitsError = "";
  const modelDirCache = new Map();

  // ----- registry and parameter catalogs (both optional, both lazy)

  let registryOverride;

  function engineRegistry() {
    const configured = registryOverride === undefined ? options.registry : registryOverride;
    if (configured === null) return null;
    if (configured) return configured;
    try {
      return require("../engines").getEngineRegistry();
    } catch {
      return null;
    }
  }

  function paramIds() {
    if (options.paramIds === null) return null;
    if (options.paramIds) return typeof options.paramIds === "function" ? options.paramIds() : options.paramIds;
    if (paramIdCache !== undefined) return paramIdCache;
    try {
      const engines = require("../engines");
      const catalog = engines.getParamCatalog();
      const ids = new Set();
      for (const engineId of catalog.engineIds()) {
        for (const id of catalog.loadCatalog(engineId).byId.keys()) ids.add(id);
      }
      paramIdCache = ids.size ? ids : null;
    } catch {
      paramIdCache = null;
    }
    return paramIdCache;
  }

  function descriptorAdditions() {
    const registry = engineRegistry();
    if (!registry || typeof registry.errorSignatureAdditions !== "function") return { entries: [], error: null };
    try {
      const raw = registry.errorSignatureAdditions();
      const entries = [];
      if (Array.isArray(raw)) {
        for (const item of raw) entries.push(item);
      } else if (isPlainObject(raw)) {
        // { <engineId>: [entries] } is accepted next to the flat list.
        for (const [engineId, list] of Object.entries(raw)) {
          for (const item of Array.isArray(list) ? list : []) entries.push(isPlainObject(item) ? { engineId, ...item } : item);
        }
      }
      return { entries, error: null };
    } catch (error) {
      return { entries: [], error };
    }
  }

  function convertV1Function() {
    if (typeof options.convertV1 === "function") return options.convertV1;
    // migrate-v1.js lands with MOD-6; until then a v1 file is reported, not converted.
    try {
      return require("./migrate-v1").convertCapabilitiesV1;
    } catch {
      return null;
    }
  }

  // ----- loading

  function buildState() {
    const { schemas, errors: schemaErrors } = loadSchemas(schemaDir);
    const build = {
      schemas,
      records: { families: new Map(), "template-signatures": new Map(), "error-signatures": new Map() },
      scoped: [],
      tensorClasses: { rank: 0, value: null },
      aliases: new Map(),
      layers: new Map(LAYERS.map((layer) => [layer.name, { layer: layer.name, files: [], accepted: [], deleted: [], path: "" }])),
      errors: [],
      order: 0,
      paramIds: null,
      paramIdsLoaded: false,
    };
    build.layers.get("bundled").path = display(bundledDir);
    build.layers.get("legacy-v1").path = display(configDir);
    build.layers.get("pack").path = display(path.join(knowledgeDir, "packs"));
    build.layers.get("user").path = display(knowledgeDir);
    build.layers.get("model").path = display(path.join(knowledgeDir, "models"));
    for (const item of schemaErrors) build.errors.push({ ...item, layer: "bundled", severity: "error" });

    const guarded = (label, work) => {
      try {
        work();
      } catch (error) {
        build.errors.push({ layer: "", file: label, entryId: "", code: "load_failed", message: `Loading ${label} failed: ${error.message}`, severity: "error" });
      }
    };
    guarded("bundled", () => loadBundled(build));
    guarded("engine descriptors", () => loadDescriptorAdditions(build));
    guarded("legacy-v1", () => loadLegacyV1(build));
    guarded("packs", () => loadDirectory(build, "pack", path.join(knowledgeDir, "packs")));
    guarded("user", () => loadDirectory(build, "user", knowledgeDir));
    guarded("models", () => loadDirectory(build, "model", path.join(knowledgeDir, "models")));
    return finalize(build);
  }

  function lookupParamIds(build) {
    if (!build.paramIdsLoaded) {
      build.paramIdsLoaded = true;
      try {
        build.paramIds = paramIds();
      } catch {
        build.paramIds = null;
      }
    }
    return build.paramIds;
  }

  // A "virtual" record is a source that is not one file of the layer's directory (engine descriptors, a listing failure).
  function newFileRecord(build, layerName, file, label, virtual = false) {
    const record = { name: label || path.basename(file), kind: "", entries: 0, errors: [], warnings: [], asOf: "", staleAfterDays: null, virtual };
    build.layers.get(layerName).files.push(record);
    return record;
  }

  function fileLabel(build, layerName, record) {
    return record.virtual ? record.name : `${build.layers.get(layerName).path}/${record.name}`;
  }

  function reportFile(build, layerName, fileRecord, code, message, entryId = "", severity = "error") {
    const item = { entryId, code, message };
    if (severity !== "error") item.severity = severity;
    (severity === "error" ? fileRecord.errors : fileRecord.warnings).push(item);
    build.errors.push({ layer: layerName, file: fileLabel(build, layerName, fileRecord), entryId, code, message, severity });
  }

  function loadBundled(build) {
    for (const kind of KINDS) {
      const file = path.join(bundledDir, `${kind}.json`);
      const record = newFileRecord(build, "bundled", file);
      const read = safeReadJson(file);
      if (!read.ok) {
        reportFile(build, "bundled", record, read.code, read.message);
        continue;
      }
      ingestFile(build, "bundled", record, read.value, { expectedKind: kind });
    }
  }

  function loadDescriptorAdditions(build) {
    const { entries, error } = descriptorAdditions();
    if (error) {
      const record = newFileRecord(build, "bundled", "", "engine descriptors", true);
      record.kind = "error-signatures";
      reportFile(build, "bundled", record, "descriptor_additions_failed", `The engine registry could not list its errorSignatures additions: ${error.message}`);
      return;
    }
    if (!entries.length) return;
    const record = newFileRecord(build, "bundled", "", "engine descriptors", true);
    record.kind = "error-signatures";
    const bundledCodes = new Set([...build.records["error-signatures"].values()].map((item) => item.entry.code));
    const seen = new Set();
    entries.forEach((raw, index) => {
      if (!isPlainObject(raw)) {
        reportFile(build, "bundled", record, "invalid_entry", "An errorSignatures addition must be an object.", `#${index}`);
        return;
      }
      const engineId = typeof raw.engineId === "string" ? raw.engineId : "";
      const defaultEngines = Array.isArray(raw.engines) && raw.engines.length ? raw.engines : engineId ? [engineId] : ["*"];
      const entry = withoutKeys(raw, ["engineId"]);
      ingestEntry(build, "bundled", record, "error-signatures", entry, index, {
        seen,
        defaultEngines,
        source: "engine-descriptor",
        beforeSet: (candidate) => {
          // An addition may not reuse a bundled entry's code or id: the bundled data wins.
          if (bundledCodes.has(candidate.code)) return { code: "duplicate_code", message: `Code ${candidate.code} already belongs to a bundled knowledge entry; the addition was dropped.` };
          if (build.records["error-signatures"].has(candidate.id)) return { code: "duplicate_id", message: `Id ${candidate.id} already belongs to a bundled knowledge entry; the addition was dropped.` };
          return null;
        },
      });
    });
  }

  function loadLegacyV1(build) {
    const file = path.join(configDir, LEGACY_V1_FILE);
    if (!fs.existsSync(file)) return;
    const record = newFileRecord(build, "legacy-v1", file);
    record.kind = "families";
    const read = safeReadJson(file);
    if (!read.ok) {
      reportFile(build, "legacy-v1", record, read.code, read.message);
      return;
    }
    const convert = convertV1Function();
    if (!convert) {
      reportFile(build, "legacy-v1", record, "converter_unavailable", "model-capabilities.json is still read by the v1 capability matrix; it joins the layers once the migration module is available.", "", "info");
      return;
    }
    let converted;
    try {
      converted = convert(read.value);
    } catch (error) {
      reportFile(build, "legacy-v1", record, "conversion_failed", `The v1 file could not be converted: ${error.message}`);
      return;
    }
    const families = isPlainObject(converted?.families) ? { ...converted.families } : null;
    if (!families) {
      reportFile(build, "legacy-v1", record, "conversion_failed", "The v1 converter returned no families file.");
      return;
    }
    if (isPlainObject(converted.capabilityIdAliases) && families.capabilityIdAliases === undefined) families.capabilityIdAliases = converted.capabilityIdAliases;
    for (const warning of Array.isArray(converted.warnings) ? converted.warnings : []) {
      reportFile(build, "legacy-v1", record, "v1_warning", String(warning?.message || warning).slice(0, 300), "", "warning");
    }
    ingestFile(build, "legacy-v1", record, families, { expectedKind: "families" });
  }

  function loadDirectory(build, layerName, dir) {
    const listing = listJsonFiles(dir);
    if (listing.error) {
      const record = newFileRecord(build, layerName, dir, display(dir), true);
      reportFile(build, layerName, record, "unreadable", `The directory could not be listed: ${listing.error.code || listing.error.message}`);
      return;
    }
    for (const file of listing.files) {
      const record = newFileRecord(build, layerName, file);
      const read = safeReadJson(file);
      if (!read.ok) {
        reportFile(build, layerName, record, read.code, read.message);
        continue;
      }
      ingestFile(build, layerName, record, read.value, {});
    }
  }

  /**
   * One parsed file: header, then tensor classes and aliases (families), then
   * each entry on its own. Nothing here throws.
   */
  function ingestFile(build, layerName, record, value, { expectedKind } = {}) {
    if (!isPlainObject(value)) {
      reportFile(build, layerName, record, "not_an_object", "A knowledge file must be a JSON object.");
      return;
    }
    const kind = value.kind;
    if (!KINDS.includes(kind)) {
      reportFile(build, layerName, record, "unknown_kind", `kind must be one of ${KINDS.join(", ")}.`);
      return;
    }
    record.kind = kind;
    if (expectedKind && kind !== expectedKind) {
      reportFile(build, layerName, record, "kind_mismatch", `This file must have kind ${expectedKind}, not ${kind}.`);
      return;
    }
    if (layerName === "model" && kind !== "families") {
      reportFile(build, layerName, record, "kind_not_scoped", "Per-model overrides can only carry families entries.");
      return;
    }
    const schemas = build.schemas[kind];
    if (!schemas) {
      reportFile(build, layerName, record, "schema_unavailable", `The ${kind} schema could not be loaded, so this file was skipped.`);
      return;
    }
    const header = schemas.header(value);
    const fatal = header.errors.filter((item) => !SOFT_HEADER_PATHS.has(item.path));
    if (fatal.length) {
      reportFile(build, layerName, record, "invalid_header", describeErrors({ errors: fatal }));
      return;
    }
    const softBad = new Set(header.errors.map((item) => item.path));
    for (const item of header.errors) reportFile(build, layerName, record, "invalid_metadata", `${item.path} ${item.message}; ignored.`, "", "warning");
    record.asOf = softBad.has("/asOf") || typeof value.asOf !== "string" ? "" : value.asOf;
    record.staleAfterDays = softBad.has("/staleAfterDays") || !Number.isInteger(value.staleAfterDays) ? null : value.staleAfterDays;

    if (kind === "families") {
      ingestTensorClasses(build, layerName, record, value.tensorClasses);
      ingestAliases(build, layerName, record, value.capabilityIdAliases);
    }
    let entries = value.entries;
    if (entries.length > MAX_ENTRIES_PER_FILE) {
      reportFile(build, layerName, record, "too_many_entries", `Only the first ${MAX_ENTRIES_PER_FILE} entries are read.`);
      entries = entries.slice(0, MAX_ENTRIES_PER_FILE);
    }
    const seen = new Set();
    entries.forEach((raw, index) => ingestEntry(build, layerName, record, kind, raw, index, { seen }));
  }

  function ingestTensorClasses(build, layerName, record, classes) {
    if (classes === undefined) return;
    const validate = build.schemas.families?.tensorClass;
    if (!Array.isArray(classes) || !validate) {
      reportFile(build, layerName, record, "invalid_tensor_classes", "tensorClasses must be a list of {class, patterns}.", "tensorClasses");
      return;
    }
    const accepted = [];
    classes.forEach((item, index) => {
      const where = `tensorClasses[${index}]`;
      const verdict = validate(item);
      if (!verdict.ok) {
        reportFile(build, layerName, record, "invalid_entry", describeErrors(verdict), where);
        return;
      }
      const unsafe = item.patterns.map((source) => checkRegexSafety(source, "")).find(Boolean);
      if (unsafe) {
        reportFile(build, layerName, record, "unsafe_regex", unsafe.message, where);
        return;
      }
      accepted.push(clone(item));
    });
    // The highest layer that supplies a usable table replaces the lower ones.
    const rank = LAYER_RANK[layerName];
    if (accepted.length && rank >= build.tensorClasses.rank) build.tensorClasses = { rank, value: accepted };
  }

  function ingestAliases(build, layerName, record, aliases) {
    if (aliases === undefined) return;
    if (!isPlainObject(aliases)) {
      reportFile(build, layerName, record, "invalid_aliases", "capabilityIdAliases must be an object of id -> family id.", "capabilityIdAliases");
      return;
    }
    for (const [from, to] of Object.entries(aliases)) {
      if (UNSAFE_KEYS.has(from) || !ID_PATTERN.test(from) || typeof to !== "string" || !ID_PATTERN.test(to)) {
        reportFile(build, layerName, record, "invalid_alias", "An alias maps one id to one family id.", `capabilityIdAliases.${String(from).slice(0, 40)}`);
        continue;
      }
      build.aliases.set(from, to);
    }
  }

  function ingestEntry(build, layerName, record, kind, raw, index, ctx) {
    const report = (code, message, entryId) => reportFile(build, layerName, record, code, message, entryId);
    if (!isPlainObject(raw)) {
      report("invalid_entry", "An entry must be a JSON object.", `#${index}`);
      return;
    }
    const id = raw.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      report("invalid_id", "id must be 1-64 characters: letters, digits, dot, underscore or hyphen.", typeof id === "string" ? id.slice(0, 64) : `#${index}`);
      return;
    }
    if (ctx.seen.has(id)) {
      report("duplicate_id", `Id ${id} appears twice in this file; the first entry is kept.`, id);
      return;
    }
    ctx.seen.add(id);

    const layer = build.layers.get(layerName);
    const records = build.records[kind];
    if (raw.$delete !== undefined && raw.$delete !== true) {
      report("invalid_delete", "$delete must be true.", id);
      return;
    }
    if (raw.$delete === true) {
      if (layerName === "model") {
        report("delete_not_scoped", "A per-model override cannot hide an entry; delete it in the layer that defines it.", id);
        return;
      }
      if (records.delete(id)) layer.deleted.push(id);
      record.entries += 1;
      return;
    }
    if (raw.$merge !== undefined && raw.$merge !== "deep") {
      report("invalid_merge", 'only "$merge": "deep" is supported.', id);
      return;
    }

    const staged = normalizeStage(withoutKeys(raw, ["$merge"]));
    if (staged.problem) {
      report(staged.problem.code, staged.problem.message, id);
      return;
    }
    const schemas = build.schemas[kind];
    if (layerName === "model") {
      ingestScoped(build, layerName, record, schemas, raw, staged.entry, ctx);
      return;
    }
    const base = records.get(id)?.entry;
    const merged = raw.$merge === "deep" && base ? deepMerge(base, staged.entry) : staged.entry;
    const candidate = normalizeSha(applyDefaults(kind, merged, ctx));
    const verdict = schemas.entry(candidate);
    if (!verdict.ok) {
      report("invalid_entry", describeErrors(verdict), id);
      return;
    }
    const unsafe = checkEntryPatterns(kind, candidate);
    if (unsafe) {
      report(unsafe.code, unsafe.message, id);
      return;
    }
    if (kind === "error-signatures") {
      const badParam = checkSuggestionParams(candidate, lookupParamIds(build));
      if (badParam) {
        report(badParam.code, badParam.message, id);
        return;
      }
    }
    const blocked = typeof ctx.beforeSet === "function" ? ctx.beforeSet(candidate) : null;
    if (blocked) {
      report(blocked.code, blocked.message, id);
      return;
    }
    build.order += 1;
    const previous = records.get(id);
    records.set(id, {
      id,
      entry: deepFreeze(candidate),
      layer: layerName,
      layerRank: LAYER_RANK[layerName],
      file: fileLabel(build, layerName, record),
      source: ctx.source || "file",
      order: build.order,
      overrides: previous ? [...previous.overrides, previous.layer] : [],
    });
    record.entries += 1;
    layer.accepted.push(candidate);
  }

  // A per-model entry: validated on its own, kept as a patch, applied by matchFamily to the cards it selects.
  function ingestScoped(build, layerName, record, schemas, raw, patch, ctx) {
    const verdict = schemas.scopedEntry(patch);
    if (!verdict.ok) {
      reportFile(build, layerName, record, "invalid_entry", describeErrors(verdict), patch.id);
      return;
    }
    const unsafe = checkEntryPatterns("families", patch);
    if (unsafe) {
      reportFile(build, layerName, record, unsafe.code, unsafe.message, patch.id);
      return;
    }
    build.order += 1;
    const layer = build.layers.get(layerName);
    const stored = withoutKeys(patch, []);
    if (raw.$merge === "deep") stored.$merge = "deep";
    build.scoped.push({
      id: patch.id,
      entry: deepFreeze({ id: patch.id, match: clone(patch.match) }),
      patch: deepFreeze(stored),
      layer: layerName,
      layerRank: LAYER_RANK[layerName],
      file: fileLabel(build, layerName, record),
      order: build.order,
    });
    record.entries += 1;
    layer.accepted.push(stored);
  }

  function finalize(build) {
    const records = {};
    for (const kind of KINDS) records[kind] = [...build.records[kind].values()];
    const tensorClasses = build.tensorClasses.value || DEFAULT_TENSOR_CLASSES.map((item) => ({ class: item.class, patterns: [...item.patterns], ...(item.layerGroup ? { layerGroup: item.layerGroup } : {}) }));
    const aliases = Object.fromEntries(build.aliases);
    const merged = {
      families: records.families.map((item) => item.entry),
      templateSignatures: records["template-signatures"].map((item) => item.entry),
      errorSignatures: records["error-signatures"].map((item) => item.entry),
      scoped: build.scoped.map((item) => item.patch),
      tensorClasses,
      aliases,
    };
    const digest = digestOf(merged);

    const layers = LAYERS.map(({ name }) => {
      const layer = build.layers.get(name);
      const files = layer.files.map((file) => {
        const age = file.asOf ? ageInDays(file.asOf, now()) : null;
        const stale = age !== null && file.staleAfterDays !== null && age > file.staleAfterDays;
        return {
          name: file.name,
          kind: file.kind,
          entries: file.entries,
          errors: file.errors,
          warnings: file.warnings,
          asOf: file.asOf,
          staleAfterDays: file.staleAfterDays,
          ageDays: age,
          stale,
        };
      });
      return { layer: name, path: layer.path, files, deleted: layer.deleted, digest: digestOf(layer.accepted) };
    });

    const knowledge = {
      loadedAt: new Date(now()).toISOString(),
      digest,
      records,
      scoped: build.scoped,
      tensorClasses: deepFreeze(tensorClasses),
      capabilityIdAliases: deepFreeze(aliases),
      layers,
      errors: build.errors,
    };
    Object.defineProperty(knowledge, "recordHit", { value: recordHeuristicHit, enumerable: false });
    return knowledge;
  }

  // ----- staleness: pick up edited files without a restart

  function sourceSignature() {
    const parts = [];
    for (const kind of KINDS) parts.push(fileStamp(path.join(bundledDir, `${kind}.json`)));
    parts.push(fileStamp(path.join(configDir, LEGACY_V1_FILE)));
    for (const dir of [knowledgeDir, path.join(knowledgeDir, "packs"), path.join(knowledgeDir, "models")]) {
      const listing = listJsonFiles(dir);
      parts.push(`${path.basename(dir)}:${listing.error ? "!" : listing.files.map(fileStamp).join(",")}`);
    }
    const { entries, error } = descriptorAdditions();
    parts.push(error ? "additions:!" : `additions:${sha256Hex(stableStringify(entries)).slice(0, 16)}`);
    return parts.join("|");
  }

  function load(loadOptions = {}) {
    const time = now();
    if (state && !loadOptions.force && time - checkedAt < recheckMs) return state.knowledge;
    checkedAt = time;
    let signature = "";
    try {
      signature = sourceSignature();
    } catch {
      signature = `unreadable:${time}`;
    }
    if (state && !loadOptions.force && state.signature === signature) return state.knowledge;
    let knowledge;
    try {
      knowledge = buildState();
    } catch (error) {
      // buildState guards every step; this is the last line of defence for startup.
      knowledge = emptyKnowledge(error);
    }
    if (!knowledge.errors.some((item) => item.severity === "error")) lastGoodDigest = knowledge.digest;
    state = { knowledge, signature };
    return knowledge;
  }

  function emptyKnowledge(error) {
    const knowledge = {
      loadedAt: new Date(now()).toISOString(),
      digest: digestOf({}),
      records: { families: [], "template-signatures": [], "error-signatures": [] },
      scoped: [],
      tensorClasses: DEFAULT_TENSOR_CLASSES,
      capabilityIdAliases: {},
      layers: LAYERS.map(({ name }) => ({ layer: name, path: "", files: [], deleted: [], digest: digestOf([]) })),
      errors: [{ layer: "", file: "", entryId: "", code: "load_failed", message: `Loading the knowledge layers failed: ${error?.message || error}`, severity: "error" }],
    };
    Object.defineProperty(knowledge, "recordHit", { value: recordHeuristicHit, enumerable: false });
    return knowledge;
  }

  // ----- heuristic hits (§8.1): persisted to <AI_ROOT>/cache/knowledge-hits.json

  function readHits() {
    try {
      const parsed = JSON.parse(fs.readFileSync(hitsFile, "utf8"));
      const counts = isPlainObject(parsed?.hits) ? parsed.hits : {};
      return Object.fromEntries(Object.entries(counts).filter(([key, count]) => !UNSAFE_KEYS.has(key) && Number.isFinite(count) && count > 0));
    } catch {
      return {};
    }
  }

  function recordHeuristicHit(kind, id) {
    const key = `${kind}:${id}`;
    pendingHits.set(key, (pendingHits.get(key) || 0) + 1);
    if (!hitsTimer && flushIntervalMs > 0) {
      hitsTimer = setInterval(() => flushHits(), flushIntervalMs);
      hitsTimer.unref?.();
    }
  }

  /** Adds the hits counted since the last flush to the file (read-modify-write, so two managers add up). */
  function flushHits() {
    if (!pendingHits.size) return { ok: true, written: 0 };
    const delta = new Map(pendingHits);
    pendingHits.clear();
    try {
      const counts = readHits();
      for (const [key, count] of delta) counts[key] = (counts[key] || 0) + count;
      fs.mkdirSync(path.dirname(hitsFile), { recursive: true });
      const tmp = `${hitsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date(now()).toISOString(), hits: counts }, null, 2)}\n`);
      fs.renameSync(tmp, hitsFile);
      hitsError = "";
      return { ok: true, written: delta.size };
    } catch (error) {
      // Counters are statistics: keep them for the next flush and report the failure in the status.
      for (const [key, count] of delta) pendingHits.set(key, (pendingHits.get(key) || 0) + count);
      hitsError = error.code || error.message;
      return { ok: false, error: hitsError };
    }
  }

  /**
   * Binds the engine registry whose errorSignatureAdditions() feed the bundled
   * layer: a manager hands over the registry it built, so the process-wide
   * loader reads the same descriptors the manager runs.
   */
  function setRegistry(registry) {
    registryOverride = registry || null;
    state = null;
  }

  function close() {
    if (hitsTimer) clearInterval(hitsTimer);
    hitsTimer = null;
    flushHits();
  }

  // ----- public views

  /** {domain: "models", layers[], errors[], digest, ...} for GET /api/knowledge/status. Never throws. */
  function status() {
    let knowledge;
    try {
      knowledge = load();
    } catch (error) {
      knowledge = emptyKnowledge(error);
    }
    const counts = readHits();
    for (const [key, count] of pendingHits) counts[key] = (counts[key] || 0) + count;
    const byEntry = Object.entries(counts)
      .map(([key, count]) => {
        const split = key.indexOf(":");
        return { kind: key.slice(0, split), id: key.slice(split + 1), count };
      })
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    const staleFiles = knowledge.layers.flatMap((layer) => layer.files.filter((file) => file.stale).map((file) => `${layer.path}/${file.name}`));
    return {
      domain: "models",
      layers: knowledge.layers,
      errors: knowledge.errors.map(({ layer, file, entryId, code, message, severity }) => ({ layer, file, entryId, code, message, severity })),
      digest: knowledge.digest,
      lastGoodDigest,
      loadedAt: knowledge.loadedAt,
      staleFiles,
      heuristicHits: { total: byEntry.reduce((sum, item) => sum + item.count, 0), entries: byEntry, error: hitsError },
      entriesWithoutFixture: knowledge.records.families
        .filter((item) => item.layer === "bundled" && !(Array.isArray(item.entry.fixtures) && item.entry.fixtures.length))
        .map((item) => item.id),
      counts: {
        families: knowledge.records.families.length,
        templateSignatures: knowledge.records["template-signatures"].length,
        errorSignatures: knowledge.records["error-signatures"].length,
        modelOverrides: knowledge.scoped.length,
      },
    };
  }

  // <modelDir>/.platform/model.json is read-only per-model knowledge next to the weights.
  function modelDirOverrides(card) {
    if (card?.ref?.kind !== "local" || typeof card.ref.path !== "string" || !card.ref.path) return [];
    const dir = card.ref.path;
    const file = path.join(dir, MODEL_DIR_OVERRIDE);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    const cached = modelDirCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.records;
    const records = [];
    const read = safeReadJson(file);
    const schemas = loadSchemas(schemaDir).schemas.families;
    if (read.ok && isPlainObject(read.value) && read.value.kind === "families" && Array.isArray(read.value.entries) && schemas?.scopedEntry) {
      for (const raw of read.value.entries.slice(0, 50)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) continue;
        // The folder it sits in is the selector: no match needed (a given one is ignored).
        const patch = { ...withoutKeys(raw, ["$delete"]), match: { path: dir } };
        const staged = normalizeStage(patch);
        if (staged.problem || !schemas.scopedEntry(staged.entry).ok || checkEntryPatterns("families", staged.entry)) continue;
        records.push({ id: raw.id, entry: { id: raw.id, match: { path: dir } }, patch: deepFreeze(staged.entry), layer: "model", layerRank: LAYER_RANK.model, file: "<model>/.platform/model.json", order: 0 });
      }
    }
    if (modelDirCache.size >= MODEL_DIR_CACHE_MAX) modelDirCache.delete(modelDirCache.keys().next().value);
    modelDirCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, records });
    return records;
  }

  function matchFamily(card, knowledge) {
    const target = knowledge || load();
    return matchFamilyIn(target, card, knowledge ? [] : modelDirOverrides(card));
  }

  /**
   * The error signatures that apply to an engine, engine-specific entries
   * before the generic ones ("engines": ["*"]), each in merge order. With no
   * engineId, every signature. Entries are frozen views with a precompiled
   * non-enumerable `regexp` (null when the pattern is unusable).
   */
  function errorSignatures(engineId) {
    const knowledge = load();
    const wanted = typeof engineId === "string" && engineId ? engineId : null;
    const specific = [];
    const generic = [];
    for (const record of knowledge.records["error-signatures"]) {
      const engines = record.entry.engines || ["*"];
      const isGeneric = engines.includes("*");
      if (wanted && !isGeneric && !engines.includes(wanted)) continue;
      const view = { ...record.entry, layer: record.layer, file: record.file };
      const compiled = compileSafeRegex(record.entry.regex, typeof record.entry.flags === "string" ? record.entry.flags : DEFAULT_FLAGS["error-signatures"]);
      Object.defineProperty(view, "regexp", { value: compiled.ok ? compiled.regexp : null, enumerable: false });
      Object.freeze(view);
      (wanted && !isGeneric ? specific : generic).push(view);
    }
    return wanted ? [...specific, ...generic] : generic;
  }

  /** v1 capability id -> familyId through capabilityIdAliases; a family id maps to itself; else null. */
  function familyIdForCapabilityId(id) {
    if (typeof id !== "string" || !id || UNSAFE_KEYS.has(id)) return null;
    const knowledge = load();
    if (Object.hasOwn(knowledge.capabilityIdAliases, id)) return knowledge.capabilityIdAliases[id];
    return knowledge.records.families.some((item) => item.id === id) ? id : null;
  }

  /** The merged entries of one kind with their layer and file (for GET /api/knowledge). */
  function entries(kind) {
    if (!KINDS.includes(kind)) return [];
    const knowledge = load();
    return knowledge.records[kind].map((item) => ({ ...clone(item.entry), layer: item.layer, file: item.file, overrides: [...item.overrides] }));
  }

  return {
    bundledDir,
    configDir,
    knowledgeDir,
    hitsFile,
    close,
    entries,
    errorSignatures,
    familyIdForCapabilityId,
    flushHits,
    load,
    matchFamily,
    recordHeuristicHit,
    setRegistry,
    status,
    tensorClasses: () => load().tensorClasses,
    display,
  };
}

// ---------------------------------------------------------------------------
// The process-wide loader and the module-level API of §3.1 / §3.2.

let defaultLoader = null;
const statusProviders = new Map();

function getKnowledgeLoader() {
  if (!defaultLoader) defaultLoader = createKnowledgeLoader();
  return defaultLoader;
}

function clearKnowledgeCache() {
  if (defaultLoader) defaultLoader.close();
  defaultLoader = null;
  schemaCache.clear();
  regexCache.clear();
}

/** loadKnowledge({force}) -> the merged Knowledge of the process-wide loader. Never throws. */
function loadKnowledge(options = {}) {
  return getKnowledgeLoader().load(options);
}

/** The models domain of GET /api/knowledge/status for the process-wide loader. */
function knowledgeStatus() {
  return getKnowledgeLoader().status();
}

function matchFamily(card, knowledge) {
  return getKnowledgeLoader().matchFamily(card, knowledge);
}

function errorSignatures(engineId) {
  return getKnowledgeLoader().errorSignatures(engineId);
}

function familyIdForCapabilityId(id) {
  return getKnowledgeLoader().familyIdForCapabilityId(id);
}

/**
 * Other loaders (engines, recipes, launch-params, platform) expose their
 * status in the same endpoint: registerStatusProvider("recipes", () =>
 * ({layers, errors, digest?})). Registering a domain again replaces it.
 */
function registerStatusProvider(domain, provider) {
  if (typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(domain) || domain === "models") {
    throw new TypeError(`Invalid knowledge status domain: ${domain}`);
  }
  if (typeof provider !== "function") throw new TypeError("A status provider is a function.");
  statusProviders.set(domain, provider);
  return () => {
    if (statusProviders.get(domain) === provider) statusProviders.delete(domain);
  };
}

/**
 * Every status domain: models (the given loader, default the process-wide one)
 * and the registered providers. A provider that throws is listed as
 * {domain, unavailable: true}; the result is always usable.
 */
function collectStatusDomains(loader = getKnowledgeLoader()) {
  const domains = [];
  try {
    domains.push(loader.status());
  } catch (error) {
    domains.push({ domain: "models", unavailable: true, layers: [], errors: [{ file: "", entryId: "", code: "status_failed", message: String(error?.message || error) }] });
  }
  for (const [domain, provider] of statusProviders) {
    try {
      const value = provider();
      domains.push({ layers: [], errors: [], ...(isPlainObject(value) ? value : {}), domain });
    } catch (error) {
      domains.push({ domain, unavailable: true, layers: [], errors: [{ file: "", entryId: "", code: "status_failed", message: String(error?.message || error) }] });
    }
  }
  return domains;
}

module.exports = {
  BUNDLED_KNOWLEDGE_DIR,
  BUNDLED_SCHEMA_DIR,
  KINDS,
  LAYERS,
  LOG_LINES_MAX,
  LOG_LINE_MAX,
  REGEX_MAX_LENGTH,
  SCHEMA_VERSIONS,
  checkRegexSafety,
  clearKnowledgeCache,
  collectStatusDomains,
  compileSafeRegex,
  createKnowledgeLoader,
  createPathDisplayer,
  deepMerge,
  defaultAiRoot,
  digestOf,
  errorSignatures,
  familyIdForCapabilityId,
  getKnowledgeLoader,
  knowledgeStatus,
  loadKnowledge,
  loadSchemas,
  matchFamily,
  prepareLogLines,
  registerStatusProvider,
};
