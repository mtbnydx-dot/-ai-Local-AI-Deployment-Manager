"use strict";

// Data-driven model capability lookup. Both managers used to decide parsers,
// speculative modes and special runtime images from substrings of the model
// name; the matrix keys on what the checkpoint declares about itself first
// (config.json model_type / architectures, GGUF general.architecture) and only
// falls back to names, counting those hits so they can be driven to zero.

const { loadReferenceFile } = require("./reference-data");

const MATRIX_FILE = "model-capabilities.json";

let matrixCache = null;
const nameHeuristicHits = new Map();

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeArchitecture(value) {
  return normalizeIdentity(value).replace(/[^a-z0-9_]/g, "");
}

function compileEntry(entry, index) {
  const match = entry.match || {};
  const toRegex = (patterns) => (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    ...entry,
    order: index,
    compiled: {
      modelTypes: new Set((match.modelTypes || []).map(normalizeIdentity)),
      architectures: new Set((match.architectures || []).map(normalizeArchitecture)),
      architecturePatterns: toRegex(match.architecturePatterns),
      ggufArchitectures: new Set((match.ggufArchitectures || []).map(normalizeIdentity)),
      namePatterns: toRegex(match.namePatterns),
    },
  };
}

function loadModelCapabilityMatrix(options = {}) {
  if (matrixCache && !options.force) return matrixCache;
  const loaded = loadReferenceFile(MATRIX_FILE, options.now);
  const data = loaded.value && typeof loaded.value === "object" ? loaded.value : {};
  const entries = (Array.isArray(data.entries) ? data.entries : [])
    .filter((entry) => entry && typeof entry === "object" && entry.id)
    .map(compileEntry);
  matrixCache = {
    ...loaded,
    asOf: data.asOf || "",
    notes: data.notes || "",
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
  };
  return matrixCache;
}

function clearModelCapabilityMatrixCache() {
  matrixCache = null;
}

function configIdentity(config = {}) {
  const nested = [config, config.text_config, config.language_config, config.llm_config].filter(Boolean);
  const modelTypes = nested.map((item) => normalizeIdentity(item.model_type)).filter(Boolean);
  const architectures = nested
    .flatMap((item) => (Array.isArray(item.architectures) ? item.architectures : []))
    .map(normalizeArchitecture)
    .filter(Boolean);
  return { modelTypes, architectures };
}

function modelNameCandidates(model = "") {
  const normalizedPath = String(model || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const parts = normalizedPath.split("/").filter(Boolean);
  const basename = parts.at(-1) || "";
  const repository = parts.length > 1 ? `${parts.at(-2)}/${basename}` : basename;
  return Array.from(new Set([basename, repository].filter(Boolean)));
}

// Returns how the entry matched ("modelType" | "architecture" | "gguf" | "name")
// or "" when it does not. Declared identity beats names: a repository called
// "qwen3-flash-next-awq" that declares model_type qwen2 is treated as qwen2.
function entryMatchKind(entry, subject = {}) {
  const compiled = entry.compiled;
  const identity = configIdentity(subject.config || {});
  if (identity.modelTypes.some((type) => compiled.modelTypes.has(type))) return "modelType";
  if (identity.architectures.some((arch) => compiled.architectures.has(arch))) return "architecture";
  if (identity.architectures.some((arch) => compiled.architecturePatterns.some((pattern) => pattern.test(arch)))) return "architecture";
  const gguf = normalizeIdentity(subject.ggufArchitecture);
  if (gguf && compiled.ggufArchitectures.has(gguf)) return "gguf";
  const hasDeclaredIdentity = identity.modelTypes.length || identity.architectures.length || gguf;
  if (hasDeclaredIdentity && subject.allowNameFallback === false) return "";
  const names = modelNameCandidates(subject.model);
  if (names.some((name) => compiled.namePatterns.some((pattern) => pattern.test(name)))) return "name";
  return "";
}

function recordNameHeuristic(entry, subject) {
  nameHeuristicHits.set(entry.id, (nameHeuristicHits.get(entry.id) || 0) + 1);
  if (typeof subject.onNameHeuristic === "function") subject.onNameHeuristic({ id: entry.id, model: subject.model });
}

function resolveModelCapabilityEntry(subject = {}, options = {}) {
  const matrix = loadModelCapabilityMatrix(options);
  // A declared identity that matches an entry must win over an earlier entry
  // that only matches by name, otherwise ordering would re-introduce the very
  // name heuristics the matrix exists to retire.
  let nameMatch = null;
  for (const entry of matrix.entries) {
    const kind = entryMatchKind(entry, subject);
    if (!kind) continue;
    if (kind === "name") {
      if (!nameMatch) nameMatch = entry;
      continue;
    }
    return { entry, id: entry.id, label: entry.label || entry.id, matchedBy: kind, heuristic: false, confidence: entry.confidence || "documented" };
  }
  if (nameMatch) {
    recordNameHeuristic(nameMatch, subject);
    return { entry: nameMatch, id: nameMatch.id, label: nameMatch.label || nameMatch.id, matchedBy: "name", heuristic: true, confidence: nameMatch.confidence || "documented" };
  }
  return { entry: null, id: "", label: "", matchedBy: "", heuristic: false, confidence: "" };
}

function matchesCapabilityEntry(id, subject = {}, options = {}) {
  const entry = loadModelCapabilityMatrix(options).byId.get(id);
  if (!entry) return false;
  return Boolean(entryMatchKind(entry, subject));
}

function getCapabilityEntry(id, options = {}) {
  return loadModelCapabilityMatrix(options).byId.get(id) || null;
}

function quantMatches(rule, quantMethod, model = "") {
  if (!rule) return false;
  const haystack = `${normalizeIdentity(quantMethod)} ${normalizeIdentity(model)}`;
  return String(rule).split("|").map((item) => item.trim().toLowerCase()).filter(Boolean).some((item) => haystack.includes(item));
}

// Flattens the engine section of an entry for a concrete checkpoint: quant-
// dependent parser choices and speculative defaults are resolved here so the
// callers only see plain values plus the reason behind them.
function resolveEngineCapabilities(entry, engine, context = {}) {
  const section = entry?.[engine];
  if (!section) return null;
  const quantMethod = context.quantMethod || "";
  const model = context.model || "";
  const result = { ...section };
  delete result.toolCallParserByQuant;
  for (const [rule, parser] of Object.entries(section.toolCallParserByQuant || {})) {
    if (quantMatches(rule, quantMethod, model)) result.toolCallParser = parser;
  }
  const speculative = section.speculative || null;
  if (speculative) {
    let auto = String(speculative.auto || "off");
    let reason = speculative.reason || "";
    if (speculative.autoOffForQuant && quantMatches(speculative.autoOffForQuant, quantMethod, model)) {
      auto = "off";
      reason = `Automatic ${String(speculative.auto || "").toUpperCase()} stays off for ${quantMethod || "this quantization"} checkpoints; ${speculative.reason || "enable it explicitly after validating acceptance."}`;
    }
    result.speculative = { ...speculative, auto, reason };
  }
  if (section.image && section.imageRequiresQuant && !quantMatches(section.imageRequiresQuant, quantMethod, model)) {
    result.image = "";
    result.imageSkippedReason = `${section.image} is only used for ${section.imageRequiresQuant} weights.`;
  }
  return result;
}

function getNameHeuristicStats() {
  return Array.from(nameHeuristicHits.entries())
    .map(([id, hits]) => ({ id, hits }))
    .sort((a, b) => b.hits - a.hits);
}

function describeModelCapabilityMatrix(options = {}) {
  const matrix = loadModelCapabilityMatrix(options);
  return {
    asOf: matrix.asOf,
    source: matrix.source,
    userPath: matrix.userPath,
    freshness: matrix.freshness,
    error: matrix.error,
    entries: matrix.entries.map((entry) => ({
      id: entry.id,
      label: entry.label || entry.id,
      confidence: entry.confidence || "documented",
      match: entry.match || {},
      contextMax: entry.contextMax || null,
      vllm: entry.vllm || null,
      sglang: entry.sglang || null,
      llama: entry.llama || null,
      download: entry.download || null,
      notes: Array.isArray(entry.notes) ? entry.notes : [],
    })),
    nameHeuristicHits: getNameHeuristicStats(),
  };
}

module.exports = {
  MODEL_CAPABILITY_MATRIX_FILE: MATRIX_FILE,
  clearModelCapabilityMatrixCache,
  configIdentity,
  describeModelCapabilityMatrix,
  getCapabilityEntry,
  getNameHeuristicStats,
  loadModelCapabilityMatrix,
  matchesCapabilityEntry,
  modelNameCandidates,
  resolveEngineCapabilities,
  resolveModelCapabilityEntry,
};
