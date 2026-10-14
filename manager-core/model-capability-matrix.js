"use strict";

// Data-driven model capability lookup. Both managers used to decide parsers,
// speculative modes and special runtime images from substrings of the model
// name; the matrix keys on what the checkpoint declares about itself first
// (config.json model_type / architectures, GGUF general.architecture) and only
// falls back to names, counting those hits so they can be driven to zero.
//
// Since MOD-6 this module is a shim over the layered families v2 knowledge
// (docs/overhaul/02-models.md section 8): every family is projected back to the
// v1 entry shape (model-inspector/migrate-v1.js familyToV1Entry), so the
// exports below, /api/capability-data, the download precheck and the vLLM
// capability module keep working unchanged while their callers migrate.
// Matching keeps the v1 rules (declared identity first in priority order, names
// as the last resort) and adds the v2 clauses: a family may require a chat
// template signature (subject.templateSignature) or other card facts.

const path = require("node:path");
const { describeFreshness } = require("./reference-data");
const knowledgeModule = require("./model-inspector/knowledge");
const { familyToV1Entry } = require("./model-inspector/migrate-v1");

const MATRIX_FILE = "model-capabilities.json";

let matrixCache = null;
const nameHeuristicHits = new Map();

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeArchitecture(value) {
  return normalizeIdentity(value).replace(/[^a-z0-9_]/g, "");
}

function compileEntry(record, index) {
  const family = record.entry;
  const entry = familyToV1Entry(family);
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
    familyId: family.id,
    layer: record.layer,
    clauses: { require: Array.isArray(family.match?.require) ? family.match.require : [], where: Array.isArray(family.match?.where) ? family.match.where : [] },
    compiled: {
      modelTypes: new Set((match.modelTypes || []).map(normalizeIdentity)),
      architectures: new Set((match.architectures || []).map(normalizeArchitecture)),
      architecturePatterns: toRegex(match.architecturePatterns),
      ggufArchitectures: new Set((match.ggufArchitectures || []).map(normalizeIdentity)),
      namePatterns: toRegex(match.namePatterns),
    },
  };
}

function legacyLayerStatus(knowledge) {
  const layer = knowledge.layers.find((item) => item.layer === "legacy-v1");
  const file = layer?.files[0] || null;
  const failure = knowledge.errors.find((item) => item.layer === "legacy-v1" && item.severity === "error");
  return { file, error: failure ? failure.message : "" };
}

function buildMatrix(loader, knowledge, now) {
  // Evaluation order of section 8.1: priority desc, then layer desc, then file order.
  const records = [...knowledge.records.families].sort((left, right) => (
    ((right.entry.priority || 0) - (left.entry.priority || 0))
    || (right.layerRank - left.layerRank)
    || (left.order - right.order)
  ));
  const entries = records.map(compileEntry);
  const legacy = legacyLayerStatus(knowledge);
  const userLoaded = Boolean(legacy.file && legacy.file.entries > 0);
  const bundled = knowledge.layers.find((item) => item.layer === "bundled")?.files.find((file) => file.kind === "families") || null;
  const source = userLoaded ? legacy.file : bundled;
  return {
    name: MATRIX_FILE,
    ok: entries.length > 0,
    source: userLoaded ? "user" : "bundled",
    bundledPath: path.join(loader.bundledDir, "families.json"),
    userPath: path.join(loader.configDir, MATRIX_FILE),
    error: legacy.error,
    freshness: describeFreshness({ asOf: source?.asOf || "", staleAfterDays: source?.staleAfterDays || 0 }, now),
    knowledge,
    asOf: source?.asOf || "",
    notes: "",
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

function loadModelCapabilityMatrix(options = {}) {
  if (options.force) knowledgeModule.clearKnowledgeCache();
  const loader = knowledgeModule.getKnowledgeLoader();
  const knowledge = loader.load();
  if (matrixCache && matrixCache.knowledge === knowledge && !options.force) return matrixCache;
  matrixCache = buildMatrix(loader, knowledge, options.now);
  return matrixCache;
}

function clearModelCapabilityMatrixCache() {
  matrixCache = null;
  knowledgeModule.clearKnowledgeCache();
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

// The v2 clauses of a family (section 8.2). `require` clauses read the template
// signature, quantization method and role the caller knows; `where` clauses read
// card facts (here the hidden size from config.json). A clause that cannot be
// shown to hold fails the family. Returns the clause keys that were proven (for
// matchedBy) or null.
function clauseMatches(entry, subject, identity) {
  const { require: required, where } = entry.clauses;
  if (!required.length && !where.length) return [];
  const nested = [subject.config, subject.config?.text_config, subject.config?.language_config, subject.config?.llm_config].filter(Boolean);
  const hiddenSize = nested.map((item) => item.hidden_size).find((value) => Number.isFinite(value));
  const card = {
    identity: { modelTypes: identity.modelTypes, modelType: identity.modelTypes[0], textModelType: identity.modelTypes[1] },
    template: { signatureId: subject.templateSignature || null },
    quant: { method: normalizeIdentity(subject.quantMethod || subject.config?.quantization_config?.quant_method) || null },
    role: { value: subject.role || null },
    topology: { hiddenSize },
  };
  const proven = [];
  for (const clause of required) {
    if (!knowledgeModule.clauseApplies(clause, card)) continue;
    if (!knowledgeModule.clauseHolds(clause, card)) return null;
    proven.push(...Object.keys(clause).filter((key) => key !== "forModelTypes"));
  }
  for (const clause of where) {
    if (!knowledgeModule.whereHolds(clause, card)) return null;
    proven.push(`where:${clause.path}`);
  }
  return proven;
}

// Returns how the entry matched ({kind: "modelType" | "architecture" | "gguf" | "name", clauses[]})
// or null when it does not. Declared identity beats names: a repository called
// "qwen3-flash-next-awq" that declares model_type qwen2 is treated as qwen2.
function entryMatch(entry, subject = {}) {
  const compiled = entry.compiled;
  const identity = configIdentity(subject.config || {});
  const gguf = normalizeIdentity(subject.ggufArchitecture);
  let kind = "";
  if (identity.modelTypes.some((type) => compiled.modelTypes.has(type))) kind = "modelType";
  else if (identity.architectures.some((arch) => compiled.architectures.has(arch))) kind = "architecture";
  else if (identity.architectures.some((arch) => compiled.architecturePatterns.some((pattern) => pattern.test(arch)))) kind = "architecture";
  else if (gguf && compiled.ggufArchitectures.has(gguf)) kind = "gguf";
  else {
    const hasDeclaredIdentity = identity.modelTypes.length || identity.architectures.length || gguf;
    if (hasDeclaredIdentity && subject.allowNameFallback === false) return null;
    if (modelNameCandidates(subject.model).some((name) => compiled.namePatterns.some((pattern) => pattern.test(name)))) kind = "name";
  }
  if (!kind) return null;
  const clauses = clauseMatches(entry, subject, identity);
  return clauses ? { kind, clauses } : null;
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
    const matched = entryMatch(entry, subject);
    if (!matched) continue;
    if (matched.kind === "name") {
      if (!nameMatch) nameMatch = entry;
      continue;
    }
    const matchedBy = [matched.kind, ...matched.clauses].join("+");
    return { entry, id: entry.id, label: entry.label || entry.id, matchedBy, heuristic: false, confidence: entry.confidence || "documented" };
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
  return Boolean(entryMatch(entry, subject));
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
