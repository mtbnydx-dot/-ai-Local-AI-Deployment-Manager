"use strict";

// Capabilities v1 -> families v2 (docs/overhaul/02-models.md section 8.5).
//
// convertCapabilitiesV1(v1Json) turns a model-capabilities.json (the format
// manager-core/data/model-capabilities.json used before the knowledge layers)
// into a families v2 file plus the capabilityIdAliases table (v1 id -> family
// id). The knowledge loader runs it on <AI_ROOT>/config/model-capabilities.json
// (layer 2, never rewritten) and scripts/migrate-capabilities-v1.js uses it to
// generate the bundled families.json.
//
// familyToV1Entry(family) is the inverse view: the model-capability-matrix shim
// projects every v2 family back to the v1 entry shape so /api/capability-data,
// the download precheck and the vLLM capability module keep reading what they
// always read. The two functions round-trip every v1 field, so the shim is
// equivalent to the old matrix by construction (knowledge-migration.test.js).

const ENGINES = Object.freeze([
  { v1: "vllm", v2: "vllm" },
  { v1: "sglang", v2: "sglang" },
  { v1: "llama", v2: "llamacpp" },
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
const MATCH_LISTS = ["modelTypes", "architectures", "architecturePatterns", "ggufArchitectures", "namePatterns"];
const KNOWN_ENTRY_KEYS = new Set(["id", "label", "confidence", "match", "contextMax", "vllm", "sglang", "llama", "download", "requires", "notes"]);
const BLOCKED_SUPPORT = new Set(["blocked", "unsupported"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function unique(list) {
  return [...new Set(list)];
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (isPlainObject(value)) return String(value.en ?? value.zh ?? Object.values(value).find((item) => typeof item === "string") ?? "");
  return "";
}

// ----- runtime ids: the legacy requires.runtime key is a runtime manifest key.

function runtimeRefs() {
  try {
    return require("../runtime-manifest").listRuntimes();
  } catch {
    return [];
  }
}

function defaultRuntimeIdForKey(key) {
  return runtimeRefs().find((ref) => ref.manifestKey === key)?.runtimeId || null;
}

function defaultKeyForRuntimeId(runtimeId) {
  return runtimeRefs().find((ref) => ref.runtimeId === runtimeId)?.manifestKey || null;
}

// ----- v1 -> v2

function convertSpeculative(entry) {
  const byEngine = {};
  const auto = {};
  for (const { v1, v2 } of ENGINES) {
    const speculative = entry[v1]?.speculative;
    if (!isPlainObject(speculative)) continue;
    byEngine[v2] = clone(speculative);
    if (typeof speculative.auto === "string") auto[v2] = speculative.auto;
  }
  const engines = Object.keys(byEngine);
  if (!engines.length) return null;
  const result = { auto, byEngine };
  const offRule = engines.map((key) => byEngine[key].autoOffForQuant).find((rule) => typeof rule === "string" && rule);
  if (offRule) result.autoOffForQuant = offRule;
  const reason = engines.map((key) => byEngine[key].reason).find((text) => typeof text === "string" && text);
  if (reason) result.reason = { en: reason };
  return result;
}

function convertEngine(section, confidence) {
  const out = {};
  const blocked = section.supported === false;
  out.support = blocked ? "blocked" : (confidence === "verified" ? "verified" : "documented");
  const parsers = {};
  if (typeof section.reasoningParser === "string") parsers.reasoning = section.reasoningParser;
  if (typeof section.toolCallParser === "string") parsers.tool = section.toolCallParser;
  if (Object.keys(parsers).length) out.parsers = parsers;
  if (isPlainObject(section.toolCallParserByQuant)) {
    out.parsersByQuant = Object.fromEntries(Object.entries(section.toolCallParserByQuant).map(([rule, tool]) => [rule, { tool }]));
  }
  if (typeof section.forceTrustRemoteCode === "boolean") out.trustRemoteCode = section.forceTrustRemoteCode;
  // The runtime image was only ever read through the shim; section 8.5 moves it to a 01 recipe.
  // Until the recipes carry it the family keeps a legacy pointer so the shim can answer.
  if (section.image !== undefined || section.imageRequiresQuant !== undefined) {
    out.legacyImage = {};
    if (section.image !== undefined) out.legacyImage.image = section.image;
    if (section.imageRequiresQuant !== undefined) out.legacyImage.requiresQuant = section.imageRequiresQuant;
  }
  const handled = new Set(["supported", "reasoningParser", "toolCallParser", "toolCallParserByQuant", "forceTrustRemoteCode", "image", "imageRequiresQuant", "speculative", "ggufArchitectures"]);
  for (const [key, value] of Object.entries(section)) {
    if (!handled.has(key)) out[key] = clone(value);
  }
  return out;
}

function convertEntry(entry, options, warnings) {
  const id = entry.id;
  for (const key of Object.keys(entry)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) warnings.push({ code: "unknown_key", id, message: `Entry ${id}: the v1 key "${key}" has no v2 counterpart and was not copied.` });
  }
  const label = typeof entry.label === "string" && entry.label ? entry.label : id;
  const family = { id, label: { zh: label, en: label } };
  if (typeof entry.confidence === "string") family.confidence = entry.confidence;

  const v1Match = isPlainObject(entry.match) ? entry.match : {};
  const match = {};
  for (const key of MATCH_LISTS) {
    const list = [...(Array.isArray(v1Match[key]) ? v1Match[key] : [])];
    if (key === "ggufArchitectures" && Array.isArray(entry.llama?.ggufArchitectures)) list.push(...entry.llama.ggufArchitectures);
    if (list.length) match[key] = unique(list);
  }
  family.match = match;
  if (entry.contextMax !== undefined && entry.contextMax !== null) family.contextMax = entry.contextMax;

  const speculative = convertSpeculative(entry);
  if (speculative) family.speculative = speculative;

  const engines = {};
  for (const { v1, v2 } of ENGINES) {
    if (isPlainObject(entry[v1])) engines[v2] = convertEngine(entry[v1], entry.confidence);
  }
  if (Object.keys(engines).length) family.engines = engines;

  if (isPlainObject(entry.download)) {
    family.download = clone(entry.download);
    if (family.download.level === "block") family.download.bypass = false;
  }

  if (isPlainObject(entry.requires)) {
    const requires = clone(entry.requires);
    if (typeof requires.runtime === "string") {
      const runtimeId = options.runtimeIdForKey(requires.runtime);
      if (runtimeId) {
        requires.runtimeId = runtimeId;
        delete requires.runtime;
      } else {
        warnings.push({ code: "runtime_unresolved", id, message: `Entry ${id}: requires.runtime "${requires.runtime}" is not a runtime manifest key; it was kept as written.` });
      }
    }
    family.requires = requires;
  }
  if (Array.isArray(entry.notes) && entry.notes.length) family.notes = clone(entry.notes);
  return family;
}

/**
 * convertCapabilitiesV1(v1Json, options) -> {families, capabilityIdAliases, warnings[]}
 * Throws when the input is not an object with an entries array. Entries without
 * a usable id are skipped with a warning; a repeated id keeps its first entry.
 * options.runtimeIdForKey(key) overrides the runtime manifest lookup (tests).
 */
function convertCapabilitiesV1(v1Json, options = {}) {
  if (!isPlainObject(v1Json) || !Array.isArray(v1Json.entries)) {
    throw new TypeError("A capabilities v1 file is an object with an entries array.");
  }
  const settings = { runtimeIdForKey: options.runtimeIdForKey || defaultRuntimeIdForKey };
  const warnings = [];
  const entries = [];
  const aliases = {};
  for (const entry of v1Json.entries) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
      warnings.push({ code: "invalid_entry", message: `An entry without a usable id was skipped (${String(entry?.id ?? "no id").slice(0, 40)}).` });
      continue;
    }
    if (Object.hasOwn(aliases, entry.id)) {
      warnings.push({ code: "duplicate_id", id: entry.id, message: `Entry ${entry.id} appears twice; the first one was kept.` });
      continue;
    }
    entries.push(convertEntry(entry, settings, warnings));
    aliases[entry.id] = entry.id;
  }
  const families = { schemaVersion: 2, kind: "families" };
  if (typeof v1Json.asOf === "string" && DATE_PATTERN.test(v1Json.asOf)) families.asOf = v1Json.asOf;
  if (Number.isInteger(v1Json.staleAfterDays) && v1Json.staleAfterDays > 0) families.staleAfterDays = v1Json.staleAfterDays;
  families.capabilityIdAliases = aliases;
  families.entries = entries;
  return { families, capabilityIdAliases: aliases, warnings };
}

// ----- v2 -> v1 view (used by the matrix shim)

function speculativeView(family, engineKey) {
  const speculative = family.speculative;
  if (!isPlainObject(speculative)) return undefined;
  if (isPlainObject(speculative.byEngine?.[engineKey])) return clone(speculative.byEngine[engineKey]);
  const auto = typeof speculative.auto === "string" ? speculative.auto : speculative.auto?.[engineKey];
  if (typeof auto !== "string" || !auto) return undefined;
  const view = { auto };
  const offRule = isPlainObject(speculative.autoOffForQuant) ? speculative.autoOffForQuant[engineKey] : speculative.autoOffForQuant;
  if (typeof offRule === "string" && offRule) view.autoOffForQuant = offRule;
  const reason = textOf(isPlainObject(speculative.reason) && speculative.reason[engineKey] !== undefined ? speculative.reason[engineKey] : speculative.reason);
  if (reason) view.reason = reason;
  return view;
}

function engineView(family, v2Key) {
  const section = family.engines?.[v2Key];
  const speculative = speculativeView(family, v2Key);
  if (!isPlainObject(section) && !speculative) return undefined;
  const view = {};
  const handled = new Set(["support", "parsers", "parsersByQuant", "trustRemoteCode", "legacyImage"]);
  for (const [key, value] of Object.entries(section || {})) {
    if (!handled.has(key)) view[key] = clone(value);
  }
  if (BLOCKED_SUPPORT.has(section?.support)) view.supported = false;
  if (section?.parsers?.reasoning) view.reasoningParser = section.parsers.reasoning;
  if (section?.parsers?.tool) view.toolCallParser = section.parsers.tool;
  if (isPlainObject(section?.parsersByQuant)) {
    const byQuant = {};
    for (const [rule, parsers] of Object.entries(section.parsersByQuant)) {
      if (parsers?.tool) byQuant[rule] = parsers.tool;
    }
    if (Object.keys(byQuant).length) view.toolCallParserByQuant = byQuant;
  }
  if (typeof section?.trustRemoteCode === "boolean") view.forceTrustRemoteCode = section.trustRemoteCode;
  if (isPlainObject(section?.legacyImage)) {
    if (section.legacyImage.image !== undefined) view.image = section.legacyImage.image;
    if (section.legacyImage.requiresQuant !== undefined) view.imageRequiresQuant = section.legacyImage.requiresQuant;
  }
  if (speculative) view.speculative = speculative;
  return view;
}

/**
 * familyToV1Entry(family, options) -> the v1 entry shape (id, label, confidence,
 * match, contextMax, vllm, sglang, llama, download, requires, notes). Sections
 * a family does not have are absent, as in a v1 file. Pure; clones its input.
 * options.keyForRuntimeId(runtimeId) overrides the runtime manifest lookup.
 */
function familyToV1Entry(family, options = {}) {
  const keyForRuntimeId = options.keyForRuntimeId || defaultKeyForRuntimeId;
  const entry = { id: family.id, label: textOf(family.label) || family.id };
  if (family.confidence) entry.confidence = family.confidence;
  const match = {};
  for (const key of MATCH_LISTS) {
    if (Array.isArray(family.match?.[key]) && family.match[key].length) match[key] = [...family.match[key]];
  }
  entry.match = match;
  if (family.contextMax !== undefined && family.contextMax !== null) entry.contextMax = family.contextMax;
  for (const { v1, v2 } of ENGINES) {
    const view = engineView(family, v2);
    if (view) entry[v1] = view;
  }
  if (isPlainObject(family.download)) {
    entry.download = {};
    if (family.download.level !== undefined) entry.download.level = family.download.level;
    if (family.download.reason !== undefined) entry.download.reason = family.download.reason;
  }
  if (isPlainObject(family.requires)) {
    const requires = clone(family.requires);
    if (typeof requires.runtimeId === "string") {
      const key = keyForRuntimeId(requires.runtimeId);
      if (key) {
        requires.runtime = key;
        delete requires.runtimeId;
      }
    }
    entry.requires = requires;
  }
  if (Array.isArray(family.notes) && family.notes.length) entry.notes = family.notes.map((note) => textOf(note)).filter(Boolean);
  return entry;
}

module.exports = {
  ENGINES,
  convertCapabilitiesV1,
  familyToV1Entry,
};
