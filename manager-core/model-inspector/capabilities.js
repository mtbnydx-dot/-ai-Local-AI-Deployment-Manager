"use strict";

// Published capabilities (docs/overhaul/02-models.md section 16, MOD-18).
//
// deriveCapabilities(card, launchValues, hostRecord) turns what a ModelCard says
// the artifact can do, narrowed by what this launch loaded and by what a
// qualification run on this host measured, into the boolean object of 00 section
// 4.1 (`Instance.capabilities`). capabilityTokens(caps) is the same answer in the
// token vocabulary of service-entry/lib/model-fleet.js (text|vision|audio|
// embedding|rerank|tools), which /api/models and the fleet entries carry.
//
// Nothing here knows a model family: every fact comes from the card, the launch
// values (01 catalog ids) or a host record.

const OFF_VALUES = new Set(["", "off", "none", "disabled", "false", "0", "null"]);
// The fleet routing vocabulary, in the order model-fleet.js publishes it.
const TOKEN_ORDER = Object.freeze(["text", "vision", "audio", "embedding", "rerank", "tools"]);
// A failed host-record check removes this capability (section 16); other checks prove nothing about a published flag.
const CHECK_CAPABILITY = Object.freeze({ "tool-call": "tools", vision: "vision", "reasoning-split": "reasoning" });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueOf(values, id) {
  const raw = isPlainObject(values) ? values[id] : undefined;
  return isPlainObject(raw) && Object.hasOwn(raw, "value") ? raw.value : raw;
}

function enabled(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  return !OFF_VALUES.has(String(value).trim().toLowerCase());
}

function engineIsLlama(values, engineId) {
  if (engineId) return String(engineId) === "llamacpp";
  return isPlainObject(values) && Object.keys(values).some((key) => key.startsWith("llamacpp."));
}

function inputs(card) {
  return Array.isArray(card?.modalities?.input) ? card.modalities.input : [];
}

/**
 * True when the launch loads the language part only: vllm.languageModelOnly or
 * llamacpp.textOnly set, or llama.cpp with no mmproj and no explicit textOnly=false
 * (textOnly defaults on in the catalog, so an unset launch loads no projector).
 */
function launchIsTextOnly(values, llama) {
  if (valueOf(values, "vllm.languageModelOnly") === true || valueOf(values, "llamacpp.textOnly") === true) return true;
  return llama && valueOf(values, "llamacpp.textOnly") !== false && !enabled(valueOf(values, "llamacpp.mmproj"));
}

function reasoningOf(card, values, llama) {
  if (llama) {
    const format = valueOf(values, "llamacpp.reasoningFormat");
    if (format !== undefined && !enabled(format)) return false;
  }
  if (enabled(valueOf(values, "reasoningParser"))) return true;
  const format = card?.template?.reasoningFormat;
  return format === "think-tags" || format === "harmony-channels";
}

function toolsOf(card, values, llama) {
  if (llama) {
    const format = card?.template?.toolFormat;
    const known = typeof format === "string" && format !== "none" && format !== "unknown";
    const mode = valueOf(values, "toolCallParser");
    return known || String(mode ?? "").trim().toLowerCase() === "auto" || valueOf(values, "autoToolChoice") === true;
  }
  return enabled(valueOf(values, "toolCallParser")) || valueOf(values, "autoToolChoice") === true;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function recordsOf(hostRecord) {
  return (Array.isArray(hostRecord) ? hostRecord : [hostRecord]).filter((record) => isPlainObject(record) && Array.isArray(record.results));
}

/**
 * deriveCapabilities(card, launchValues, hostRecord, {engineId?}) →
 *   {text, vision, audio, embedding, rerank, tools, reasoning, maxContext}
 * launchValues is the launch's catalog values ({id: value} or {id: {value}}),
 * hostRecord one host record (or a list) for this launch, or null.
 */
function deriveCapabilities(card, launchValues, hostRecord, options = {}) {
  // No launch values at all describes the model in a library listing (what it can do, not what a
  // launch loaded): the template's tool format decides `tools`, no projector is assumed missing.
  const library = !isPlainObject(launchValues);
  const values = library ? {} : launchValues;
  const llama = !library && engineIsLlama(values, options.engineId);
  const role = card?.role?.value ?? "main";
  const runnable = card?.role?.runnable !== false;
  const isMain = role === "main" && runnable;
  const caps = {
    text: isMain,
    vision: false,
    audio: false,
    embedding: role === "embedding" && runnable,
    rerank: role === "reranker" && runnable,
    tools: false,
    reasoning: false,
    maxContext: positiveInt(valueOf(values, "contextLength")) ?? positiveInt(card?.context?.native),
  };
  if (isMain) {
    const textOnly = launchIsTextOnly(values, llama);
    caps.vision = inputs(card).includes("image") && !textOnly;
    caps.audio = inputs(card).includes("audio") && !textOnly;
    caps.tools = toolsOf(card, values, llama || library);
    caps.reasoning = reasoningOf(card, values, llama);
  }
  // A failed check on this host unpublishes what it tested; the declared facts stay on the card.
  for (const record of recordsOf(hostRecord)) {
    for (const result of record.results) {
      const key = CHECK_CAPABILITY[result?.check];
      if (key && result.status === "fail") caps[key] = false;
    }
  }
  return caps;
}

/** The fleet routing tokens of a capabilities object: text|vision|audio|embedding|rerank|tools, in that order. */
function capabilityTokens(caps) {
  if (!isPlainObject(caps)) return [];
  return TOKEN_ORDER.filter((token) => caps[token] === true);
}

/**
 * annotateLocalModels(collections, {inspectLocal, concurrency?}) → Promise<collections>
 * Adds `capabilities` (the fleet tokens) and `capabilitySource:"card"` to each
 * `collections.local` model whose folder or file inspects to a card (quick depth,
 * served from the inspector cache). A model that cannot be inspected is returned
 * unchanged. Never throws.
 */
async function annotateLocalModels(collections, options = {}) {
  const list = Array.isArray(collections?.local) ? collections.local : null;
  if (!list) return collections;
  const inspect = typeof options.inspectLocal === "function" ? options.inspectLocal : require("./inspect").inspectLocal;
  const limit = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || 4)));
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const index = next++;
      const model = list[index];
      out[index] = model;
      try {
        if (!model?.path) continue;
        const card = await inspect(String(model.path), { depth: "quick" });
        if (!card || typeof card !== "object") continue;
        out[index] = { ...model, capabilities: capabilityTokens(deriveCapabilities(card, null, null)), capabilitySource: "card" };
      } catch {
        // A model the inspector cannot read keeps its listing as is.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return { ...collections, local: out };
}

/**
 * publishLaunchCapabilities({launchStore, launchId, card, hostRecord?}) →
 *   capabilities | null. Derives the capabilities of a stored launch and writes
 *   them to record.resolved.capabilities, which the instance catalog (01 ENG-13)
 *   publishes on every instance summary. Never throws.
 */
function publishLaunchCapabilities({ launchStore, launchId, card, hostRecord = null } = {}) {
  try {
    if (!launchStore || typeof launchStore.get !== "function" || typeof launchStore.update !== "function" || !launchId) return null;
    const record = launchStore.get(launchId);
    if (!record) return null;
    const caps = deriveCapabilities(card, record.spec?.values, hostRecord, { engineId: record.spec?.engineId });
    launchStore.update(launchId, { resolved: { capabilities: caps } });
    return caps;
  } catch {
    return null;
  }
}

module.exports = {
  TOKEN_ORDER,
  CHECK_CAPABILITY,
  deriveCapabilities,
  capabilityTokens,
  annotateLocalModels,
  publishLaunchCapabilities,
};
