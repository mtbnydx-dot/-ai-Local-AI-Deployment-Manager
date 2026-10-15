"use strict";

// Artifact facts for launch plans (docs/overhaul/02-models.md §3.1, §10.1,
// MOD-9b). 01's PlanCtx `modelFacts(model)` hook lands here: a LaunchRequestV2
// `model:{ref?, card?}` becomes the card (a supplied card wins, so a prospective
// plan never needs the files), its family and content digest, and the artifact
// side of the memory estimate:
//
//   planFacts(model, { engineId, hostFacts, ... }) → Promise<PlanFacts | null>
//   PlanFacts = { cardId, card (summary), familyId, contentDigest,
//                 artifactFor(values, gpuIds) → MemoryInputs.artifact,
//                 memoryInputs(values, opts) → { inputs, artifact, values, paramsKey, assumptions } }
//
// `memoryInputs` builds the same MemoryInputs estimateFit hands to 01's
// memoryModels.estimate, so a plan and a fit of one card and values agree.
// The card is cached per cardId; artifactFor results per card, engine,
// paramsKey, GPU ids and the other effective values.

const path = require("node:path");

const cardSchema = require("./card-schema");
const fit = require("./fit");

const CARD_CACHE_MAX = 64;
const ARTIFACT_CACHE_MAX = 256;

const cardCache = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function looksLikeCard(card) {
  return isPlainObject(card) && isPlainObject(card.topology) && (isPlainObject(card.weights) || isPlainObject(card.context));
}

function inspectApi(options) {
  return typeof options.inspectLocal === "function" ? options.inspectLocal : require("./inspect").inspectLocal;
}

/**
 * The full ModelCard of a LaunchRequestV2 `model`: model.card as given, else the
 * folder or GGUF file model.ref names (through options.resolveModelPath when the
 * manager maps container paths and storage roots), else null. Never throws.
 */
async function resolveCard(model, options = {}) {
  const source = isPlainObject(model) ? model : typeof model === "string" ? { ref: model } : null;
  if (!source) return null;
  if (looksLikeCard(source.card)) {
    const card = source.card;
    if (card.cardId) remember(cardCache, card.cardId, card, CARD_CACHE_MAX);
    return card;
  }
  if (typeof source.cardId === "string" && source.cardId) {
    const cached = cardCache.get(source.cardId);
    if (cached) return cached;
    try {
      const known = require("./inspect").getCard(source.cardId);
      if (known) return remember(cardCache, source.cardId, known, CARD_CACHE_MAX);
    } catch {
      // fall through to the ref
    }
  }
  const ref = typeof source.ref === "string" ? source.ref.trim() : "";
  if (!ref) return null;
  let target = null;
  try {
    target = typeof options.resolveModelPath === "function" ? await options.resolveModelPath(ref) : (path.isAbsolute(ref) ? ref : null);
  } catch {
    target = null;
  }
  if (!target) return null;
  try {
    const card = await inspectApi(options)(String(target), { depth: "full" });
    if (!looksLikeCard(card)) return null;
    if (card.cardId) remember(cardCache, card.cardId, card, CARD_CACHE_MAX);
    return card;
  } catch {
    return null;
  }
}

function familyIdOf(card) {
  if (card.identity?.familyId) return card.identity.familyId;
  try {
    const knowledge = require("./knowledge");
    return knowledge.matchFamily(card, knowledge.loadKnowledge())?.entry?.id ?? null;
  } catch {
    return null;
  }
}

/** planFacts(model, { engineId, hostFacts, runtimeId, resolveModelPath, inspectLocal, fitOptions }) → Promise<PlanFacts|null>. */
async function planFacts(model, options = {}) {
  const card = await resolveCard(model, options);
  if (!card) return null;
  const engineId = String(options.engineId || "");
  const hostFacts = isPlainObject(options.hostFacts) ? options.hostFacts : { gpus: [] };
  const runtimeId = options.runtimeId ?? null;
  const fitOptions = isPlainObject(options.fitOptions) ? options.fitOptions : {};
  const artifacts = new Map();

  const input = (values, gpuIds, extra = {}) => ({
    card,
    engineId,
    runtimeId,
    values,
    gpuIds: Array.isArray(gpuIds) ? gpuIds.map(String) : [],
    host: hostFacts,
    budgetBasis: "now",
    instanceMode: extra.instanceMode,
    recipeMemory: extra.recipeMemory ?? null,
  });

  function memoryInputs(values, extra = {}) {
    const calibrationOptions = Object.hasOwn(extra, "calibration") ? { calibration: extra.calibration } : {};
    return fit.fitMemoryInputs(input(values, extra.gpuIds, extra), { ...fitOptions, ...calibrationOptions });
  }

  function artifactFor(values, gpuIds) {
    const prepared = memoryInputs(values, { gpuIds });
    const key = `${card.cardId || ""}|${card.contentDigest || ""}|${engineId}|${prepared.paramsKey}|${(gpuIds || []).join(",")}|${stable(prepared.values)}`;
    const hit = artifacts.get(key);
    if (hit) return hit;
    return remember(artifacts, key, prepared.artifact, ARTIFACT_CACHE_MAX);
  }

  return {
    cardId: card.cardId || null,
    card: cardSchema.projectCard(card, { view: "summary" }),
    familyId: familyIdOf(card),
    contentDigest: card.contentDigest ?? null,
    artifactFor,
    memoryInputs,
  };
}

function clearPlanFactsCache() {
  cardCache.clear();
}

module.exports = {
  clearPlanFactsCache,
  planFacts,
  resolveCard,
};
