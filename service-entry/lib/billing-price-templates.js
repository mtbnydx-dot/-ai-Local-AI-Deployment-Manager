"use strict";

const CATALOG_VERSION = "2026-08-11.1";
const SNAPSHOT_DATE = "2026-08-11";
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_BATCH_ITEMS = 50;
const MAX_MARKUP_BPS = 1_000_000n;
const MAX_CREDITS_PER_USD = 1_000_000n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

class BillingPriceTemplateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "BillingPriceTemplateError";
    this.code = code;
    this.status = status;
  }
}

const OPENAI_SOURCE = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const GEMINI_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing?hl=en";
const DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";

const OPENAI_NOTES = [
  "Standard API tier snapshot; Batch/Flex and Fast processing multipliers are not applied by this template.",
  "OpenAI cache-write pricing is retained as reference metadata; the local gateway currently bills only input, cached-input reads, and output tokens.",
];

const BASE_TEMPLATES = [
  openAiTemplate("openai:gpt-5.6-sol:standard:le-272k", "gpt-5.6-sol", "GPT-5.6 Sol", "Input up to and including 272K tokens", 0, 272000, "5.00", "0.50", "6.25", "30.00"),
  openAiTemplate("openai:gpt-5.6-sol:standard:gt-272k", "gpt-5.6-sol", "GPT-5.6 Sol", "Input above 272K tokens", 272001, null, "10.00", "1.00", "12.50", "45.00"),
  openAiTemplate("openai:gpt-5.6-terra:standard:le-272k", "gpt-5.6-terra", "GPT-5.6 Terra", "Input up to and including 272K tokens", 0, 272000, "2.00", "0.20", "2.50", "12.00"),
  openAiTemplate("openai:gpt-5.6-terra:standard:gt-272k", "gpt-5.6-terra", "GPT-5.6 Terra", "Input above 272K tokens", 272001, null, "4.00", "0.40", "5.00", "18.00"),
  openAiTemplate("openai:gpt-5.6-luna:standard:le-272k", "gpt-5.6-luna", "GPT-5.6 Luna", "Input up to and including 272K tokens", 0, 272000, "0.20", "0.02", "0.25", "1.20"),
  openAiTemplate("openai:gpt-5.6-luna:standard:gt-272k", "gpt-5.6-luna", "GPT-5.6 Luna", "Input above 272K tokens", 272001, null, "0.40", "0.04", "0.50", "1.80"),
  anthropicTemplate({
    id: "anthropic:claude-opus-5:standard:current",
    modelId: "claude-opus-5",
    modelLabel: "Claude Opus 5",
    input: "5.00",
    cached: "0.50",
    cacheWrite5m: "6.25",
    cacheWrite1h: "10.00",
    output: "25.00",
  }),
  anthropicTemplate({
    id: "anthropic:claude-sonnet-5:standard:introductory",
    modelId: "claude-sonnet-5",
    modelLabel: "Claude Sonnet 5 (introductory price)",
    input: "2.00",
    cached: "0.20",
    cacheWrite5m: "2.50",
    cacheWrite1h: "4.00",
    output: "10.00",
    effectiveTo: "2026-09-01",
    notes: ["Introductory pricing is scheduled to end when the 2026-09-01 price becomes effective."],
  }),
  anthropicTemplate({
    id: "anthropic:claude-sonnet-5:standard:2026-09-01",
    modelId: "claude-sonnet-5",
    modelLabel: "Claude Sonnet 5 (from 2026-09-01)",
    input: "3.00",
    cached: "0.30",
    cacheWrite5m: "3.75",
    cacheWrite1h: "6.00",
    output: "15.00",
    effectiveFrom: "2026-09-01",
    notes: ["Future official price snapshot; do not apply before its effective date."],
  }),
  anthropicTemplate({
    id: "anthropic:claude-haiku-4-5:standard:current",
    modelId: "claude-haiku-4-5",
    modelLabel: "Claude Haiku 4.5",
    input: "1.00",
    cached: "0.10",
    cacheWrite5m: "1.25",
    cacheWrite1h: "2.00",
    output: "5.00",
  }),
  simpleTemplate({
    id: "google:gemini-3.5-flash:standard:current",
    provider: "google",
    providerLabel: "Google",
    modelId: "gemini-3.5-flash",
    modelLabel: "Gemini 3.5 Flash",
    input: "1.50",
    cached: "0.15",
    output: "9.00",
    sourceUrl: GEMINI_SOURCE,
    contextLabel: "Standard Gemini API pricing band",
    cacheNotes: "Cached-input read rate is mapped. Cache-write operations are not represented by local token usage telemetry.",
    storageNotes: "Context-cache storage is not included in the generated local price rule and must be accounted for separately if used.",
  }),
  simpleTemplate({
    id: "google:gemini-3.5-flash-lite:standard:current",
    provider: "google",
    providerLabel: "Google",
    modelId: "gemini-3.5-flash-lite",
    modelLabel: "Gemini 3.5 Flash-Lite",
    input: "0.30",
    cached: "0.03",
    output: "2.50",
    sourceUrl: GEMINI_SOURCE,
    contextLabel: "Standard Gemini API pricing band",
    cacheNotes: "Cached-input read rate is mapped. Cache-write operations are not represented by local token usage telemetry.",
    storageNotes: "Context-cache storage is not included in the generated local price rule and must be accounted for separately if used.",
  }),
  simpleTemplate({
    id: "deepseek:deepseek-v4-flash:standard:current",
    provider: "deepseek",
    providerLabel: "DeepSeek",
    modelId: "deepseek-v4-flash",
    modelLabel: "DeepSeek V4 Flash",
    input: "0.14",
    cached: "0.0028",
    output: "0.28",
    sourceUrl: DEEPSEEK_SOURCE,
    contextLabel: "Up to 1M tokens",
    contextMax: 1000000,
    cacheNotes: "The official cache-hit input rate is mapped to cached-input reads; cache writes are not separately billed by this gateway.",
    storageNotes: "No separate cache-storage charge is included in this local template.",
  }),
  simpleTemplate({
    id: "deepseek:deepseek-v4-pro:standard:current",
    provider: "deepseek",
    providerLabel: "DeepSeek",
    modelId: "deepseek-v4-pro",
    modelLabel: "DeepSeek V4 Pro",
    input: "0.435",
    cached: "0.003625",
    output: "0.87",
    sourceUrl: DEEPSEEK_SOURCE,
    contextLabel: "Up to 1M tokens",
    contextMax: 1000000,
    cacheNotes: "The official cache-hit input rate is mapped to cached-input reads; cache writes are not separately billed by this gateway.",
    storageNotes: "No separate cache-storage charge is included in this local template.",
  }),
];

const PRICE_TEMPLATE_CATALOG = deepFreeze(BASE_TEMPLATES.map(normalizeCatalogTemplate));
const TEMPLATE_BY_ID = new Map(PRICE_TEMPLATE_CATALOG.map((template) => [template.id, template]));

function openAiTemplate(id, modelId, modelLabel, contextLabel, contextMin, contextMax, input, cached, cacheWrite, output) {
  return simpleTemplate({
    id,
    provider: "openai",
    providerLabel: "OpenAI",
    modelId,
    modelLabel,
    input,
    cached,
    cacheWrite,
    output,
    sourceUrl: OPENAI_SOURCE,
    contextLabel,
    contextMin,
    contextMax,
    cacheNotes: "The official cache-write rate is retained as reference only; the generated local rule maps cached-input reads.",
    storageNotes: "No separate cache-storage charge is included in this local template.",
    notes: OPENAI_NOTES,
  });
}

function anthropicTemplate({ id, modelId, modelLabel, input, cached, cacheWrite5m, cacheWrite1h, output, effectiveFrom = null, effectiveTo = null, notes = [] }) {
  return simpleTemplate({
    id,
    provider: "anthropic",
    providerLabel: "Anthropic",
    modelId,
    modelLabel,
    input,
    cached,
    cacheWrite5m,
    cacheWrite1h,
    output,
    sourceUrl: ANTHROPIC_SOURCE,
    contextLabel: "Standard context pricing",
    effectiveFrom,
    effectiveTo,
    cacheNotes: "5-minute and 1-hour cache-write rates are reference metadata; only cached-input reads are mapped to the local price rule.",
    storageNotes: "No separate cache-storage charge is included in this local template.",
    notes,
  });
}

function simpleTemplate({
  id,
  provider,
  providerLabel,
  modelId,
  modelLabel,
  input,
  cached,
  cacheWrite = null,
  cacheWrite5m = null,
  cacheWrite1h = null,
  output,
  sourceUrl,
  contextLabel,
  contextMin = null,
  contextMax = null,
  effectiveFrom = null,
  effectiveTo = null,
  cacheNotes,
  storageNotes,
  notes = [],
}) {
  return {
    id,
    catalogVersion: CATALOG_VERSION,
    provider,
    providerLabel,
    modelId,
    modelLabel,
    tier: "standard",
    currency: "USD",
    unit: "per_1m_tokens",
    rates: {
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      outputUsdPerMillion: output,
      cacheWriteUsdPerMillion: cacheWrite,
      cacheWrite5mUsdPerMillion: cacheWrite5m,
      cacheWrite1hUsdPerMillion: cacheWrite1h,
      cacheStorageUsdPerMillionTokenHour: null,
    },
    context: {
      label: contextLabel,
      minInputTokens: contextMin,
      maxInputTokens: contextMax,
    },
    sourceUrl,
    snapshotDate: SNAPSHOT_DATE,
    effectiveFrom,
    effectiveTo,
    cacheNotes,
    storageNotes,
    notes,
  };
}

function normalizeCatalogTemplate(template) {
  return {
    ...template,
    notes: [...template.notes],
    rates: { ...template.rates },
    context: { ...template.context },
  };
}

function listPriceTemplates(filters = {}) {
  assertPlainObject(filters, "filters");
  rejectUnknownKeys(filters, ["templateId", "provider", "modelId", "tier", "effectiveAt"], "template filters");
  const templateId = optionalFilter(filters.templateId, "templateId", 160);
  const provider = optionalFilter(filters.provider, "provider", 40)?.toLowerCase();
  const modelId = optionalFilter(filters.modelId, "modelId", 160);
  const tier = optionalFilter(filters.tier, "tier", 40)?.toLowerCase();
  const effectiveAt = filters.effectiveAt === undefined ? null : parseEffectiveAt(filters.effectiveAt, "effectiveAt");
  const result = PRICE_TEMPLATE_CATALOG.filter((template) => {
    if (templateId && template.id !== templateId) return false;
    if (provider && template.provider !== provider) return false;
    if (modelId && template.modelId !== modelId) return false;
    if (tier && template.tier !== tier) return false;
    return !effectiveAt || isTemplateEffective(template, effectiveAt);
  });
  return Object.freeze([...result]);
}

function getPriceTemplate(templateId) {
  const id = requiredText(templateId, "templateId", 160);
  return TEMPLATE_BY_ID.get(id) || null;
}

function previewPriceTemplateApplications(input = {}, options = {}) {
  assertPlainObject(input, "template application");
  assertPlainObject(options, "template application options");
  rejectUnknownKeys(input, ["items", "creditsPerUsd", "markupBps", "effectiveAt"], "template application");
  rejectUnknownKeys(options, ["clock"], "template application options");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_BATCH_ITEMS) {
    throw new BillingPriceTemplateError("billing_template_batch_size", `items must contain between 1 and ${MAX_BATCH_ITEMS} entries.`);
  }
  const creditsPerUsd = normalizeDecimal(input.creditsPerUsd ?? "1", "creditsPerUsd", { allowZero: false, maxWhole: MAX_CREDITS_PER_USD });
  const markupBps = boundedIntegerString(input.markupBps ?? "10000", "markupBps", 1n, MAX_MARKUP_BPS);
  const effectiveAt = input.effectiveAt === undefined
    ? clockDate(options.clock).toISOString()
    : parseEffectiveAt(input.effectiveAt, "effectiveAt");
  const seenScopes = new Set();
  const items = input.items.map((item, index) => {
    assertPlainObject(item, `items[${index}]`);
    rejectUnknownKeys(item, ["templateId", "managerId", "modelPattern", "planId"], `items[${index}]`);
    for (const key of ["managerId", "modelPattern", "planId"]) {
      if (!Object.hasOwn(item, key)) {
        throw new BillingPriceTemplateError("billing_template_explicit_scope_required", `items[${index}].${key} must be explicitly provided.`);
      }
    }
    const templateId = requiredText(item.templateId, `items[${index}].templateId`, 160);
    const template = TEMPLATE_BY_ID.get(templateId);
    if (!template) throw new BillingPriceTemplateError("billing_template_not_found", `Unknown price template: ${templateId}.`, 404);
    if (!isTemplateEffective(template, effectiveAt)) {
      throw new BillingPriceTemplateError("billing_template_not_effective", `Price template ${templateId} is not effective at ${effectiveAt}.`, 409);
    }
    const managerId = normalizeManagerId(item.managerId, `items[${index}].managerId`);
    const modelPattern = requiredText(item.modelPattern, `items[${index}].modelPattern`, 256);
    const planId = normalizePlanId(item.planId, `items[${index}].planId`);
    const scopeKey = `${planId || ""}\u0000${managerId}\u0000${modelPattern}`;
    if (seenScopes.has(scopeKey)) {
      throw new BillingPriceTemplateError("billing_template_duplicate_scope", `Duplicate price scope at items[${index}].`);
    }
    seenScopes.add(scopeKey);
    return deepFreeze({
      templateId,
      catalogVersion: template.catalogVersion,
      provider: template.provider,
      modelId: template.modelId,
      managerId,
      modelPattern,
      planId,
      inputPerMillionMicrocredits: convertUsdPerMillionToMicrocredits(template.rates.inputUsdPerMillion, { creditsPerUsd, markupBps }),
      cachedInputPerMillionMicrocredits: convertUsdPerMillionToMicrocredits(template.rates.cachedInputUsdPerMillion, { creditsPerUsd, markupBps }),
      outputPerMillionMicrocredits: convertUsdPerMillionToMicrocredits(template.rates.outputUsdPerMillion, { creditsPerUsd, markupBps }),
      fixedRequestMicrocredits: "0",
      sourceUrl: template.sourceUrl,
      snapshotDate: template.snapshotDate,
      effectiveFrom: template.effectiveFrom,
      effectiveTo: template.effectiveTo,
      unmappedRates: {
        cacheWriteUsdPerMillion: template.rates.cacheWriteUsdPerMillion,
        cacheWrite5mUsdPerMillion: template.rates.cacheWrite5mUsdPerMillion,
        cacheWrite1hUsdPerMillion: template.rates.cacheWrite1hUsdPerMillion,
        cacheStorageUsdPerMillionTokenHour: template.rates.cacheStorageUsdPerMillionTokenHour,
      },
      cacheNotes: template.cacheNotes,
      storageNotes: template.storageNotes,
    });
  });
  return deepFreeze({
    catalogVersion: CATALOG_VERSION,
    currency: "CREDITS",
    creditsPerUsd,
    markupBps,
    rounding: "ceil_to_microcredit",
    effectiveAt,
    items,
  });
}

function convertUsdPerMillionToMicrocredits(usdPerMillion, options = {}) {
  assertPlainObject(options, "conversion options");
  rejectUnknownKeys(options, ["creditsPerUsd", "markupBps"], "conversion options");
  const usd = decimalFraction(usdPerMillion, "usdPerMillion", { allowZero: true, maxWhole: 1_000_000n });
  const credits = decimalFraction(options.creditsPerUsd ?? "1", "creditsPerUsd", { allowZero: false, maxWhole: MAX_CREDITS_PER_USD });
  const markup = BigInt(boundedIntegerString(options.markupBps ?? "10000", "markupBps", 1n, MAX_MARKUP_BPS));
  const numerator = usd.numerator * credits.numerator * 1_000_000n * markup;
  const denominator = usd.denominator * credits.denominator * 10_000n;
  const result = ceilDivide(numerator, denominator);
  if (result > MAX_INT64) {
    throw new BillingPriceTemplateError("billing_template_rate_overflow", "Converted price exceeds the signed 64-bit billing limit.");
  }
  return result.toString();
}

function isTemplateEffective(template, atInput) {
  const at = Date.parse(atInput);
  if (!Number.isFinite(at)) throw new BillingPriceTemplateError("billing_template_invalid_date", "effectiveAt must be a valid ISO date or timestamp.");
  const from = template.effectiveFrom ? Date.parse(template.effectiveFrom) : Number.NEGATIVE_INFINITY;
  const to = template.effectiveTo ? Date.parse(template.effectiveTo) : Number.POSITIVE_INFINITY;
  return at >= from && at < to;
}

function normalizeDecimal(value, name, rules) {
  const fraction = decimalFraction(value, name, rules);
  if (fraction.denominator === 1n) return fraction.numerator.toString();
  const raw = String(value).trim();
  const [whole, decimals = ""] = raw.split(".");
  const compact = decimals.replace(/0+$/, "");
  return compact ? `${whole}.${compact}` : whole;
}

function decimalFraction(value, name, { allowZero, maxWhole }) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new BillingPriceTemplateError("billing_template_invalid_decimal", `${name} must be a decimal string or integer.`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new BillingPriceTemplateError("billing_template_invalid_decimal", `${name} must use a decimal string when it has a fractional part.`);
  }
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(raw)) {
    throw new BillingPriceTemplateError("billing_template_invalid_decimal", `${name} must be a non-negative decimal with at most 9 fractional digits and no exponent.`);
  }
  const [whole, fractional = ""] = raw.split(".");
  const numerator = BigInt(`${whole}${fractional}`);
  const denominator = 10n ** BigInt(fractional.length);
  if (!allowZero && numerator === 0n) throw new BillingPriceTemplateError("billing_template_invalid_decimal", `${name} must be greater than zero.`);
  if (BigInt(whole) > maxWhole) throw new BillingPriceTemplateError("billing_template_invalid_decimal", `${name} exceeds the supported maximum.`);
  return { numerator, denominator };
}

function boundedIntegerString(value, name, min, max) {
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new BillingPriceTemplateError("billing_template_invalid_integer", `${name} must be an integer string.`);
  const integer = BigInt(raw);
  if (integer < min || integer > max) throw new BillingPriceTemplateError("billing_template_invalid_integer", `${name} must be between ${min} and ${max}.`);
  return integer.toString();
}

function parseEffectiveAt(value, name) {
  const raw = requiredText(value, name, 40);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new BillingPriceTemplateError("billing_template_invalid_date", `${name} must be a valid ISO date or timestamp.`);
  return new Date(timestamp).toISOString();
}

function clockDate(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BillingPriceTemplateError("billing_template_invalid_clock", "Template clock returned an invalid date.", 500);
  return date;
}

function normalizeManagerId(value, name) {
  const managerId = requiredText(value, name, 64);
  if (!MANAGER_RE.test(managerId)) throw new BillingPriceTemplateError("billing_template_invalid_scope", `${name} contains unsupported characters.`);
  return managerId.toLowerCase();
}

function normalizePlanId(value, name) {
  if (value === null) return null;
  const planId = requiredText(value, name, 36).toLowerCase();
  if (!UUID_RE.test(planId)) throw new BillingPriceTemplateError("billing_template_invalid_plan_id", `${name} must be null or a UUID.`);
  return planId;
}

function optionalFilter(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, maxLength);
}

function requiredText(value, name, maxLength) {
  if (typeof value !== "string") throw new BillingPriceTemplateError("billing_template_invalid_text", `${name} must be a string.`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new BillingPriceTemplateError("billing_template_invalid_text", `${name} must contain between 1 and ${maxLength} characters.`);
  return result;
}

function rejectUnknownKeys(value, allowed, name) {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allow.has(key));
  if (unknown.length) throw new BillingPriceTemplateError("billing_template_unknown_field", `${name} contains unknown fields: ${unknown.join(", ")}.`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BillingPriceTemplateError("billing_template_invalid_object", `${name} must be a plain object.`);
  }
}

function ceilDivide(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  BillingPriceTemplateError,
  CATALOG_VERSION,
  MAX_BATCH_ITEMS,
  PRICE_TEMPLATE_CATALOG,
  convertUsdPerMillionToMicrocredits,
  getPriceTemplate,
  isTemplateEffective,
  listPriceTemplates,
  previewPriceTemplateApplications,
};
