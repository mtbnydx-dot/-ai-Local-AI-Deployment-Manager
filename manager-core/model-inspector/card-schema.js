"use strict";

// ModelCard v1 (docs/overhaul/02-models.md §4.3) as JSON Schema draft 2020-12,
// validated by json-schema-lite.js. validateCard() also enforces the evidence
// rule of §4.3: every non-null fact under identity, topology, weights, context,
// quant, modalities, template, sampling, speculative, customCode and role is
// backed by at least one evidence entry for that field or for a field that
// contains it (one level below the section at least; evidence for a whole
// section backs nothing). Empty strings and empty lists are not facts.
//
// projectCard() gives the §4.4 projections: the summary used by lists and
// plan facts, and the full card with paths redacted for LAN viewers.

const { compileSchema } = require("./json-schema-lite");
const { CONFIDENCES, SOURCE_KINDS, confidenceOf, pointerFor } = require("./evidence");

const CARD_SCHEMA_ID = "modelcard/v1";
const ROLES = Object.freeze(["main", "draft", "mtp-head", "mmproj", "adapter", "embedding", "reranker", "tooling-only"]);
const FORMAT_KINDS = Object.freeze(["safetensors", "gguf", "pytorch-bin", "exl3", "none", "mixed"]);
const LAYOUTS = Object.freeze(["indexed", "unindexed-shards", "single", "gguf-split", "custom"]);
const LAYER_KINDS = Object.freeze(["full", "swa", "linear", "mla", "compressed", "none", "unknown"]);
const TEMPLATE_SOURCES = Object.freeze(["chat_template.jinja", "tokenizer_config.json", "chat_template.json", "gguf", "none"]);
const TOOL_FORMATS = Object.freeze([
  "qwen-xml-function", "hermes-json", "mistral", "deepseek-dsml", "deepseek-v3", "harmony", "gemma", "llama3-json", "pythonic", "unknown", "none",
]);
const REASONING_FORMATS = Object.freeze(["think-tags", "harmony-channels", "none", "unknown"]);
const MODALITIES = Object.freeze(["text", "image", "video", "audio", "embedding"]);
const EVIDENCE_SECTIONS = Object.freeze([
  "identity", "topology", "weights", "context", "quant", "modalities", "template", "sampling", "speculative", "customCode", "role",
]);
const SUPPORT = Object.freeze(["known", "unknown", "blocked"]);

const nullable = (schema) => ({ anyOf: [{ type: "null" }, schema] });
const count = { type: "integer", minimum: 0 };
const positive = { type: "integer", minimum: 1 };
const nullableCount = nullable(count);
const nullablePositive = nullable(positive);
const nullableString = nullable({ type: "string" });
const sha256Hex = { type: "string", pattern: "^[0-9a-f]{64}$" };
const prefixedDigest = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
const strictObject = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });

const MODEL_CARD_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CARD_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: [
    "schema", "cardId", "contentDigest", "inspectorVersion", "knowledgeDigest", "inspectedAt", "ref", "origin", "format", "role",
    "identity", "topology", "weights", "context", "quant", "modalities", "template", "parsers", "sampling", "speculative",
    "compatibleWith", "customCode", "support", "remote", "evidence", "warnings", "errors",
  ],
  $defs: {
    i18n: strictObject({ zh: { type: "string" }, en: { type: "string" } }),
    bytesByKey: { type: "object", additionalProperties: count },
    kindFull: strictObject({ kvHeads: nullablePositive, kDim: nullablePositive, vDim: nullablePositive }),
    kindSwa: strictObject({ window: nullablePositive, kvHeads: nullablePositive, kDim: nullablePositive, vDim: nullablePositive }),
    kindLinear: {
      type: "object",
      required: ["variant"],
      additionalProperties: false,
      properties: {
        variant: { enum: ["gated-deltanet", "mamba2", "mamba"] },
        convKernel: nullablePositive,
        kHeads: nullablePositive,
        vHeads: nullablePositive,
        kDim: nullablePositive,
        vDim: nullablePositive,
        nHeads: nullablePositive,
        headDim: nullablePositive,
        stateSize: nullablePositive,
        groups: nullablePositive,
        dInner: nullablePositive,
        ssmDtype: nullableString,
      },
    },
    kindMla: strictObject({ kvLoraRank: positive, ropeDim: nullablePositive }),
    kindCompressed: strictObject({
      window: nullablePositive,
      latentDim: nullablePositive,
      ratios: { type: "array", items: count },
      indexer: nullable(strictObject({ heads: nullablePositive, kDim: nullablePositive, topK: nullablePositive })),
    }),
    kindIndexer: strictObject({ compressRatio: positive, kDim: nullablePositive, kvHeads: nullablePositive, heads: nullablePositive }),
    message: { type: "object", required: ["code", "message"], properties: { code: { type: "string", pattern: "^[a-z][a-z0-9_]*$" }, message: { $ref: "#/$defs/i18n" } } },
  },
  properties: {
    schema: { const: CARD_SCHEMA_ID },
    cardId: { type: "string", pattern: "^mc_[a-z2-7]{20}$" },
    contentDigest: nullable(prefixedDigest),
    inspectorVersion: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    knowledgeDigest: nullable(prefixedDigest),
    inspectedAt: { type: "string", minLength: 1 },
    ref: {
      oneOf: [
        strictObject({ kind: { const: "local" }, path: { type: "string", minLength: 1 }, displayPath: { type: "string" }, file: nullableString }),
        strictObject({
          kind: { enum: ["hf", "modelscope"] },
          repo: { type: "string", minLength: 1 },
          revision: { type: "string", minLength: 1 },
          sha: nullableString,
          gated: { type: "boolean" },
        }),
      ],
    },
    origin: nullable(strictObject({ source: { type: "string" }, repo: { type: "string" }, revisionSha: nullableString })),
    format: strictObject({
      kind: { enum: FORMAT_KINDS },
      weightFiles: count,
      weightBytes: count,
      complete: { type: "boolean" },
      missing: { type: "array", items: { type: "string" } },
      layout: nullable({ enum: LAYOUTS }),
    }),
    role: nullable(strictObject({ value: { enum: ROLES }, runnable: { type: "boolean" } })),
    identity: strictObject({
      modelType: nullableString,
      textModelType: nullableString,
      architectures: nullable({ type: "array", items: { type: "string" } }),
      ggufArchitecture: nullableString,
      transformersVersion: nullableString,
      baseModel: nullableString,
      displayName: nullableString,
      familyId: nullableString,
      familyLabel: nullable({ $ref: "#/$defs/i18n" }),
      matchedBy: { type: "string" },
    }),
    topology: strictObject({
      paramsTotal: nullableCount,
      paramsActive: nullableCount,
      hiddenSize: nullablePositive,
      vocabSize: nullablePositive,
      layers: nullablePositive,
      heads: nullablePositive,
      kvHeads: nullablePositive,
      headDim: nullablePositive,
      attention: nullable(strictObject({
        histogram: { type: "object", propertyNames: { enum: LAYER_KINDS }, additionalProperties: positive },
        runs: { type: "array", minItems: 1, items: strictObject({ kind: { enum: LAYER_KINDS }, count: positive }) },
        kinds: strictObject({
          full: nullable({ $ref: "#/$defs/kindFull" }),
          swa: nullable({ $ref: "#/$defs/kindSwa" }),
          linear: nullable({ $ref: "#/$defs/kindLinear" }),
          mla: nullable({ $ref: "#/$defs/kindMla" }),
          compressed: nullable({ $ref: "#/$defs/kindCompressed" }),
          indexer: nullable({ $ref: "#/$defs/kindIndexer" }),
        }),
      })),
      moe: nullable(strictObject({
        experts: positive,
        active: nullablePositive,
        shared: nullableCount,
        expertBytes: nullableCount,
        nonExpertBytes: nullableCount,
        expertBytesPerLayer: nullable({ type: "array", items: count }),
      })),
      mtp: nullable(strictObject({ layers: nullableCount, tensorCount: nullableCount, bytes: nullableCount })),
      ple: nullable(strictObject({ layers: nullable({ type: "array", items: count }), bytes: nullableCount, dtype: nullableString })),
    }),
    weights: nullable(strictObject({
      exact: { type: "boolean" },
      totalBytes: count,
      tensorBytes: nullableCount,
      byDtype: { $ref: "#/$defs/bytesByKey" },
      byClass: nullable(strictObject(Object.fromEntries(["dense", "experts", "embedding", "lmHead", "vision", "audio", "mtp", "ple", "other"].map((key) => [key, count])))),
      expertsByLayer: nullable({ type: "array", items: count }),
    })),
    context: strictObject({
      native: nullablePositive,
      ropeScaling: nullable(strictObject({ type: nullableString, factor: nullable({ type: "number" }), originalContext: nullablePositive })),
      slidingWindow: nullablePositive,
    }),
    quant: strictObject({
      method: nullable({ type: "string", pattern: "^[a-z0-9][a-z0-9_.-]*$" }),
      algo: nullableString,
      weightBits: nullable({ type: "number", exclusiveMinimum: 0 }),
      groupSize: nullablePositive,
      activation: nullable({ enum: ["dynamic", "static", "none"] }),
      kvScheme: nullableString,
      excludedModules: nullableCount,
      ggufFileType: nullableCount,
      ggufTensorTypes: nullable({ type: "object", additionalProperties: count }),
    }),
    modalities: strictObject({
      input: { type: "array", items: { enum: MODALITIES }, uniqueItems: true },
      output: nullable({ type: "array", items: { enum: MODALITIES }, uniqueItems: true }),
      visionTower: nullable({ type: "boolean" }),
      audioTower: nullable({ type: "boolean" }),
      projectorFiles: { type: "array", items: { type: "string" } },
    }),
    template: {
      type: "object",
      additionalProperties: false,
      required: ["source", "sha256", "bytes", "signatureId", "exact", "toolFormat", "reasoningFormat", "thinking", "systemRole"],
      properties: {
        source: { enum: TEMPLATE_SOURCES },
        sha256: nullable(sha256Hex),
        bytes: nullableCount,
        signatureId: nullableString,
        exact: nullable({ type: "boolean" }),
        toolFormat: nullable({ enum: TOOL_FORMATS }),
        reasoningFormat: nullable({ enum: REASONING_FORMATS }),
        thinking: nullable({ type: "object" }),
        systemRole: nullable({ type: "boolean" }),
        // Only with includeTemplate (owner views, 02 §5).
        text: { type: "string" },
      },
    },
    parsers: nullable({ type: "object", additionalProperties: { type: "object", additionalProperties: nullableString } }),
    sampling: nullable({
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        temperature: nullable({ type: "number" }),
        top_p: nullable({ type: "number" }),
        top_k: nullable({ type: "number" }),
        min_p: nullable({ type: "number" }),
        repetition_penalty: nullable({ type: "number" }),
        source: { enum: ["generation_config.json", "gguf", "knowledge"] },
      },
    }),
    speculative: strictObject({
      nativeMtp: nullable({ type: "boolean" }),
      draftOf: nullableString,
      compatibleDrafts: nullable({ type: "array", items: { type: "string" } }),
    }),
    compatibleWith: nullable({
      type: "object",
      additionalProperties: false,
      properties: { hiddenSize: nullablePositive, vocabSize: nullablePositive, targetLayers: nullablePositive, baseModel: nullableString, projectionDim: nullablePositive },
    }),
    customCode: strictObject({
      autoMap: nullable({ type: "object" }),
      files: { type: "array", items: { type: "string" } },
      trustRemoteCodeRequired: { type: "boolean" },
    }),
    support: { enum: SUPPORT },
    remote: nullable({ type: "object" }),
    evidence: {
      type: "array",
      items: {
        type: "object",
        required: ["fact", "source", "confidence"],
        additionalProperties: false,
        properties: {
          fact: { type: "string", pattern: "^(?:/[^/]+)+$" },
          value: { type: ["string", "number", "boolean"] },
          source: strictObject({ kind: { enum: SOURCE_KINDS }, ref: nullableString }),
          confidence: { enum: CONFIDENCES },
          note: { anyOf: [{ type: "string" }, { $ref: "#/$defs/i18n" }] },
        },
      },
    },
    warnings: { type: "array", items: { $ref: "#/$defs/message" } },
    errors: {
      type: "array",
      items: { allOf: [{ $ref: "#/$defs/message" }, { type: "object", required: ["file"], properties: { file: nullableString } }] },
    },
  },
});

const validateShape = compileSchema(MODEL_CARD_SCHEMA);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFact(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// Leaf facts of a section: scalars and lists; objects recurse.
function collectFacts(value, pointer, out) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) collectFacts(child, `${pointer}${pointerFor(key)}`, out);
  } else if (isFact(value)) {
    out.push(pointer);
  }
  return out;
}

/** Facts (JSON pointers) under the evidence sections with no evidence behind them. */
function factsWithoutEvidence(card) {
  const facts = [];
  for (const section of EVIDENCE_SECTIONS) {
    if (card && card[section] !== null && card[section] !== undefined) collectFacts(card[section], pointerFor(section), facts);
  }
  const backed = (Array.isArray(card?.evidence) ? card.evidence : [])
    .map((entry) => entry?.fact)
    .filter((fact) => typeof fact === "string" && fact.split("/").length >= 3);
  return facts.filter((pointer) => !pointer.startsWith("/template/text") && !backed.some((fact) => pointer === fact || pointer.startsWith(`${fact}/`)));
}

/** validateCard(card) -> {ok, errors[]}: the schema plus the evidence rule. */
function validateCard(card) {
  const { errors } = validateShape(card, { maxErrors: 50 });
  const result = errors.map((error) => ({ path: error.path, code: `schema_${error.keyword}`, message: error.message }));
  if (isPlainObject(card)) {
    for (const pointer of factsWithoutEvidence(card)) {
      result.push({ path: pointer, code: "evidence_missing", message: "this fact has no evidence entry" });
    }
  }
  return { ok: result.length === 0, errors: result };
}

function bestConfidence(card, pointers) {
  let best = null;
  for (const pointer of pointers) {
    const confidence = confidenceOf(card, pointer);
    if (confidence && (!best || CONFIDENCES.indexOf(confidence) < CONFIDENCES.indexOf(best))) best = confidence;
  }
  return best;
}

function basenameOf(value) {
  const text = String(value || "");
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

// A ref that is an absolute path, a drive path, a UNC path or climbs out of
// the model folder is dropped for viewers (02 §4.4).
function isOutsideRef(value) {
  if (typeof value !== "string") return false;
  return /^(?:[A-Za-z]:|[\\/])/.test(value) || value.includes("\\") || /(?:^|\/)\.\.(?:\/|#|$)/.test(value);
}

function summaryOf(card) {
  return {
    cardId: card.cardId,
    displayName: card.identity?.displayName || basenameOf(card.ref?.displayPath || card.ref?.repo || ""),
    role: card.role,
    familyId: card.identity?.familyId ?? null,
    familyLabel: card.identity?.familyLabel ?? null,
    format: { kind: card.format?.kind ?? null },
    quant: { method: card.quant?.method ?? null, algo: card.quant?.algo ?? null },
    weights: { totalBytes: card.weights?.totalBytes ?? null },
    topology: { paramsTotal: card.topology?.paramsTotal ?? null, paramsActive: card.topology?.paramsActive ?? null },
    context: { native: card.context?.native ?? null },
    modalities: { input: card.modalities?.input ?? [] },
    template: { toolFormat: card.template?.toolFormat ?? null, reasoningFormat: card.template?.reasoningFormat ?? null },
    support: card.support,
    confidence: {
      identity: bestConfidence(card, ["/identity/familyId", "/identity/modelType", "/identity/architectures", "/identity/ggufArchitecture"]),
      template: bestConfidence(card, ["/template/signatureId", "/template/source"]),
      weights: bestConfidence(card, ["/weights/totalBytes"]),
    },
  };
}

/**
 * projectCard(card, {view: "summary"|"full", redactPaths, includeTemplate})
 * summary: 02 §4.4 fields. full: the card; the template text only with
 * includeTemplate. redactPaths (LAN viewers): ref.path becomes displayPath
 * and evidence refs that point outside the model folder are dropped.
 */
function projectCard(card, { view = "summary", redactPaths = false, includeTemplate = false } = {}) {
  if (!isPlainObject(card)) return null;
  if (view === "summary") return summaryOf(card);
  const projected = JSON.parse(JSON.stringify(card));
  if (!includeTemplate && projected.template) delete projected.template.text;
  if (redactPaths) {
    if (projected.ref?.kind === "local") projected.ref.path = projected.ref.displayPath;
    for (const entry of projected.evidence || []) {
      if (entry.source && isOutsideRef(entry.source.ref)) entry.source.ref = null;
    }
    for (const item of [...(projected.errors || []), ...(projected.warnings || [])]) {
      if (typeof item.file === "string") item.file = basenameOf(item.file);
    }
  }
  return projected;
}

module.exports = {
  CARD_SCHEMA_ID,
  EVIDENCE_SECTIONS,
  FORMAT_KINDS,
  LAYOUTS,
  MODEL_CARD_SCHEMA,
  ROLES,
  TEMPLATE_SOURCES,
  factsWithoutEvidence,
  projectCard,
  validateCard,
};
