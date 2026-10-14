// View models for the models pages. /catalog.json (no key) and the enriched
// /v1/models (with a key, 05 §8.3) describe the same models in two shapes;
// both become one plain object here, so the cards and the detail page read a
// single shape.

import { pickText } from "./i18n.js";
import { readPricing } from "./format.js";

const MODALITIES = ["text", "vision", "audio", "embedding", "rerank"];

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function limitsOf(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    rpm: positiveNumber(source.rpm),
    tpm: positiveNumber(source.tpm),
    concurrency: positiveNumber(source.concurrency ?? source.max_concurrent),
    maxOutput: positiveNumber(source.max_output_tokens),
  };
}

function modalitiesOf(capabilities) {
  const found = [];
  if (capabilities.vision) found.push("vision");
  if (capabilities.audio_speech) found.push("audio");
  if (capabilities.embeddings) found.push("embedding");
  if (!found.length || capabilities.chat || capabilities.completions) found.unshift("text");
  return found;
}

/** One /catalog.json model -> the view model (the language picks names and descriptions). */
export function fromCatalog(entry, lang) {
  const modalities = (Array.isArray(entry.modalities) ? entry.modalities : []).filter((name) => MODALITIES.includes(name));
  return {
    id: String(entry.id),
    name: pickText(entry.display_name, lang) || String(entry.id),
    description: pickText(entry.description, lang),
    family: text(entry.family),
    parameters: text(entry.parameters),
    quantization: text(entry.quantization),
    modalities: modalities.length ? modalities : ["text"],
    tools: entry.tools === true,
    reasoning: entry.reasoning === true,
    context: positiveNumber(entry.context),
    maxOutput: positiveNumber(entry.max_output),
    limits: limitsOf(entry.limits),
    pricing: readPricing(entry.prices),
    state: text(entry.state) || "unknown",
    aliases: (Array.isArray(entry.aliases) ? entry.aliases : []).filter((alias) => typeof alias === "string"),
    recommended: entry.recommended === true,
    available: null,
    perKey: false,
  };
}

/** One enriched /v1/models entry -> the view model; limits and prices are the key's own. */
export function fromKeyModel(entry) {
  const capabilities = entry.capabilities && typeof entry.capabilities === "object" ? entry.capabilities : {};
  return {
    id: String(entry.id),
    name: text(entry.display_name) || String(entry.id),
    description: "",
    family: text(entry.family),
    parameters: text(entry.parameters),
    quantization: text(entry.quantization),
    modalities: modalitiesOf(capabilities),
    tools: capabilities.tools === true,
    reasoning: capabilities.reasoning === true,
    context: positiveNumber(entry.context_length),
    maxOutput: positiveNumber(entry.max_output_tokens),
    limits: limitsOf(entry.limits),
    pricing: readPricing(entry.pricing),
    state: text(entry.state) || "unknown",
    aliases: (Array.isArray(entry.aliases) ? entry.aliases : []).filter((alias) => typeof alias === "string"),
    recommended: false,
    available: true,
    perKey: true,
  };
}

/**
 * The model list to show. Without a key (keyList null) it is the catalog. With
 * one, the catalog models the key can use are marked available and carry the
 * key's own limits and prices; the others stay listed as not available; a model
 * only the key list knows is appended.
 */
export function mergeModels(catalogList, keyList) {
  if (!Array.isArray(keyList)) return catalogList;
  const byId = new Map(keyList.map((model) => [model.id.toLowerCase(), model]));
  const seen = new Set();
  const merged = catalogList.map((model) => {
    const mine = byId.get(model.id.toLowerCase());
    if (!mine) return { ...model, available: false };
    seen.add(model.id.toLowerCase());
    return {
      ...model,
      available: true,
      perKey: true,
      context: mine.context ?? model.context,
      maxOutput: mine.maxOutput ?? model.maxOutput,
      limits: mine.limits,
      pricing: mine.pricing ?? model.pricing,
      state: mine.state === "unknown" ? model.state : mine.state,
    };
  });
  for (const model of keyList) {
    if (!seen.has(model.id.toLowerCase())) merged.push(model);
  }
  return merged;
}

/** Finds a model by id or alias (case-insensitive). */
export function findModel(list, id) {
  const needle = String(id || "").toLowerCase();
  return list.find((model) => model.id.toLowerCase() === needle)
    || list.find((model) => model.aliases.some((alias) => alias.toLowerCase() === needle))
    || null;
}

/** The filters of the models page: all selected filters must hold. */
export function passesFilters(model, filters) {
  if (filters.vision && !model.modalities.includes("vision")) return false;
  if (filters.tools && !model.tools) return false;
  if (filters.reasoning && !model.reasoning) return false;
  if (filters.available && model.available !== true) return false;
  return true;
}
