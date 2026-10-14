"use strict";

// The ModelCard evidence model (docs/overhaul/02-models.md §4.2). Every fact
// on a card names where it came from and how sure the inspector is:
//   declared          the checkpoint states it (a config field, a GGUF key, a file)
//   detected          derived by a rule from declared data (shapes, patterns, arithmetic)
//   name-heuristic    from a folder or repo name; never enough for compatibility
//   verified-on-host  a qualification check passed on this host
// confidenceOf(card, pointer) answers with the best of these, or null when
// nothing backs the fact (shown as "unknown / 未知").
//
// Detectors write facts through a FactSet: set(pointer, value, source,
// confidence) stores the value at the JSON pointer and records its evidence
// in one call, so a value can never land on a card without evidence.

const CONFIDENCES = Object.freeze(["verified-on-host", "declared", "detected", "name-heuristic"]);
const CONFIDENCE_RANK = Object.freeze({ "verified-on-host": 4, declared: 3, detected: 2, "name-heuristic": 1 });
const SOURCE_KINDS = Object.freeze([
  "file", "http", "gguf", "tensor-table", "knowledge", "template", "probe", "qualification", "observation", "name",
]);
const POINTER_PATTERN = /^(?:\/[^/]+)+$/;
// Evidence keeps short values only; arrays and objects are on the card itself.
const MAX_EVIDENCE_STRING = 256;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pointerTokens(pointer) {
  if (typeof pointer !== "string" || !POINTER_PATTERN.test(pointer)) {
    throw new TypeError(`Evidence needs a JSON pointer such as "/identity/modelType", not ${JSON.stringify(pointer)}.`);
  }
  return pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function pointerFor(...tokens) {
  return tokens.map((token) => `/${String(token).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function normalizeSource(source) {
  const kind = source?.kind;
  if (!SOURCE_KINDS.includes(kind)) throw new TypeError(`Unknown evidence source kind ${JSON.stringify(kind)}.`);
  const ref = source.ref === undefined || source.ref === null ? null : String(source.ref);
  return { kind, ref };
}

function normalizeNote(note) {
  if (note === undefined || note === null || note === "") return undefined;
  if (typeof note === "string") return note;
  if (isPlainObject(note) && typeof note.zh === "string" && typeof note.en === "string") return { zh: note.zh, en: note.en };
  throw new TypeError("An evidence note is a string or {zh, en}.");
}

function evidenceValue(value) {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= MAX_EVIDENCE_STRING) return value;
  return undefined;
}

/** One normalized evidence entry (02 §4.2); throws on a malformed one. */
function evidenceEntry({ fact, value, source, confidence, note } = {}) {
  pointerTokens(fact);
  if (!CONFIDENCES.includes(confidence)) throw new TypeError(`Unknown evidence confidence ${JSON.stringify(confidence)}.`);
  const entry = { fact };
  const kept = evidenceValue(value);
  if (kept !== undefined) entry.value = kept;
  entry.source = normalizeSource(source);
  entry.confidence = confidence;
  const normalizedNote = normalizeNote(note);
  if (normalizedNote !== undefined) entry.note = normalizedNote;
  return entry;
}

/** Appends an evidence entry to card.evidence and returns it. */
function addEvidence(card, input) {
  const entry = evidenceEntry(input);
  if (!Array.isArray(card.evidence)) card.evidence = [];
  card.evidence.push(entry);
  return entry;
}

// Evidence for "/topology/attention" also backs "/topology/attention/kinds/full".
function pointerCovers(evidenceFact, pointer) {
  return pointer === evidenceFact || pointer.startsWith(`${evidenceFact}/`);
}

/**
 * The highest-ranked confidence among the evidence for `pointer` (or for a
 * fact that contains it), or null when nothing backs it.
 */
function confidenceOf(card, pointer) {
  let best = null;
  for (const entry of Array.isArray(card?.evidence) ? card.evidence : []) {
    if (!entry || typeof entry.fact !== "string" || !pointerCovers(entry.fact, pointer)) continue;
    if (!best || (CONFIDENCE_RANK[entry.confidence] || 0) > (CONFIDENCE_RANK[best] || 0)) best = entry.confidence;
  }
  return best;
}

function readPointer(root, tokens) {
  let node = root;
  for (const token of tokens) {
    if (!isPlainObject(node) || !Object.hasOwn(node, token)) return undefined;
    node = node[token];
  }
  return node;
}

/**
 * The detectors' write side. `data` is the card body being built; `evidence`,
 * `warnings` and `errors` become the card's lists in the order written, so a
 * card is reproducible from the same files.
 */
function createFactSet() {
  const data = {};
  const evidence = [];
  const warnings = [];
  const errors = [];

  /**
   * Stores `value` at `pointer` and records its evidence. null and undefined
   * mean "not known" and store nothing. Returns whether a value was stored.
   */
  function set(pointer, value, source, confidence, note) {
    if (value === undefined || value === null) return false;
    const tokens = pointerTokens(pointer);
    const entry = evidenceEntry({ fact: pointer, value, source, confidence, note });
    let node = data;
    for (const token of tokens.slice(0, -1)) {
      if (!isPlainObject(node[token])) node[token] = {};
      node = node[token];
    }
    node[tokens[tokens.length - 1]] = value;
    evidence.push(entry);
    return true;
  }

  /** Records evidence for a fact without changing the stored value. */
  function support(pointer, source, confidence, note) {
    evidence.push(evidenceEntry({ fact: pointer, source, confidence, note }));
  }

  function get(pointer) {
    return readPointer(data, pointerTokens(pointer));
  }

  function warn(code, message, extra = {}) {
    if (!warnings.some((item) => item.code === code && item.file === extra.file)) warnings.push({ code, message, ...extra });
  }

  function error(code, file, message, extra = {}) {
    if (!errors.some((item) => item.code === code && item.file === file)) errors.push({ code, file: file ?? null, message, ...extra });
  }

  return { data, evidence, warnings, errors, set, support, get, warn, error };
}

module.exports = {
  CONFIDENCES,
  CONFIDENCE_RANK,
  SOURCE_KINDS,
  addEvidence,
  confidenceOf,
  createFactSet,
  evidenceEntry,
  pointerCovers,
  pointerFor,
  pointerTokens,
};
