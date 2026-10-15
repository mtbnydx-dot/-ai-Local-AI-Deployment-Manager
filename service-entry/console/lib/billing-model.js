// The billing console's pure model (07 §6.11, CON-27): what the /api/billing/*
// answers are allowed to show, how amounts are formatted and what a form may
// send. Nothing here touches the DOM, storage or the network, so Node tests
// drive it directly (test/console/billing-model.test.js).
//
// Rules carried over from the classic page (billing.html), which stays the
// must-keep fallback at /billing/classic:
//   - Every record is rebuilt from an allowlist of fields. Unknown fields
//     (keyHash, apiKey, token …) never reach the page.
//   - Amounts stay exact. Microcredits (1 credit = 1,000,000) are strings and
//     BigInt end to end; nothing goes through Number.
//   - Free text is stripped of control characters and secret-shaped runs.
//   - A form sends canonical decimal strings, never what the user typed.

export const MAX_ITEMS = 500;
export const MANAGER_IDS = Object.freeze(["vllm-manager", "llama-manager"]);
export const MODES = Object.freeze(["shadow", "hard"]);
export const CUSTOMER_STATUSES = Object.freeze(["active", "suspended", "closed"]);
export const MAX_INT64 = 9223372036854775807n;
export const TERMINAL_STATES = Object.freeze({
  completed: "ok",
  failed: "fail",
  timeout: "fail",
  cancelled: "warn",
  disconnected: "warn",
  ambiguous: "warn",
});

const SECRET_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|pk|rk)-[A-Za-z0-9._-]{8,}|\b(?:api[_ -]?key|keyhash|token|secret)\s*[:=]\s*\S+)/gi;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_DETAIL_KEYS = ["code", "name", "status", "planId", "managerId", "model", "modelPattern", "enforcementMode", "amountCredits", "reason", "replacesPriceId"];

// ---------------------------------------------------------------------------
// Text and number primitives
// ---------------------------------------------------------------------------

export function safeText(value, maxLength = 500) {
  return String(value ?? "").replace(CONTROL, "").slice(0, Number.isInteger(maxLength) ? maxLength : 500);
}

/** Free text from the API: control characters out, secret-shaped runs replaced by `redacted`. */
export function safeNarrative(value, maxLength = 500, redacted = "[redacted]") {
  return safeText(value, maxLength).replace(SECRET_PATTERN, redacted);
}

export function safeId(value) {
  const text = safeText(value, 160).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(text) ? text : "";
}

export function safeKeyPreview(value) {
  const text = safeText(value, 80).trim();
  return !text || /[\s<>]/.test(text) ? "" : text;
}

export function safeHttpUrl(value) {
  const text = safeText(value, 500).trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

export function normalizeCurrency(value) {
  const text = safeText(value, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : "USD";
}

export function normalizeDecimal(value) {
  const text = String(value);
  const negative = text.startsWith("-");
  const parts = (negative ? text.slice(1) : text).split(".");
  const integer = parts[0].replace(/^0+(?=\d)/, "") || "0";
  const fraction = (parts[1] || "").replace(/0+$/, "");
  const result = integer + (fraction ? `.${fraction}` : "");
  return negative && result !== "0" ? `-${result}` : result;
}

export function decimalFromApi(value, fallback, allowNegative = false) {
  const text = String(value ?? "").trim();
  const expression = allowNegative ? /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/ : /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
  return expression.test(text) ? normalizeDecimal(text) : fallback;
}

export function integerFromApi(value, fallback, allowNegative = false) {
  const text = String(value ?? "").trim();
  const expression = allowNegative ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/;
  return expression.test(text) ? text : fallback;
}

/** Microcredits (an integer string) as a canonical credits decimal: "1750000" → "1.75". */
export function microcreditsToCredits(value, fallback, allowNegative = false) {
  const raw = integerFromApi(value, "", allowNegative);
  if (raw === "") return fallback;
  const negative = raw.startsWith("-");
  const padded = (negative ? raw.slice(1) : raw).padStart(7, "0");
  const integerPart = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-6).replace(/0+$/, "");
  const output = integerPart + (fraction ? `.${fraction}` : "");
  return negative && output !== "0" ? `-${output}` : output;
}

export function creditsFromApi(creditValue, microcreditValue, fallback, allowNegative = false) {
  const direct = decimalFromApi(creditValue, "", allowNegative);
  return direct !== "" ? direct : microcreditsToCredits(microcreditValue, fallback, allowNegative);
}

export function decimalIsZero(value) {
  return /^-?0(?:\.0+)?$/.test(String(value));
}

function groupInteger(digits, locale) {
  try {
    return BigInt(digits).toLocaleString(locale);
  } catch {
    return "0";
  }
}

export function formatInteger(value, locale = "en-US") {
  return groupInteger(integerFromApi(value, "0", true), locale);
}

/** A canonical decimal with grouped integer digits and the fraction untouched ("-9007199254.740993"). */
export function formatDecimal(value, locale = "en-US") {
  const raw = decimalFromApi(value, "0", true);
  const negative = raw.startsWith("-");
  const parts = (negative ? raw.slice(1) : raw).split(".");
  return `${negative ? "-" : ""}${groupInteger(parts[0], locale)}${parts[1] ? `.${parts[1]}` : ""}`;
}

export function formatSignedDecimal(value, locale = "en-US") {
  const raw = decimalFromApi(value, "0", true);
  return `${raw.startsWith("-") || decimalIsZero(raw) ? "" : "+"}${formatDecimal(raw, locale)}`;
}

export function sumIntegers(values) {
  return values.reduce((total, value) => total + BigInt(integerFromApi(value, "0")), 0n).toString();
}

/** Sum of canonical decimals with `scale` fraction digits, exact. */
export function sumDecimals(values, scale = 6) {
  const factor = 10n ** BigInt(scale);
  const total = values.reduce((sum, value) => {
    const raw = decimalFromApi(value, "0", true);
    const negative = raw.startsWith("-");
    const parts = (negative ? raw.slice(1) : raw).split(".");
    const units = BigInt(parts[0]) * factor + BigInt((parts[1] || "").padEnd(scale, "0").slice(0, scale) || "0");
    return sum + (negative ? -units : units);
  }, 0n);
  return microcreditsToCredits(total.toString(), "0", true);
}

export function createIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === "function") return `manual-${globalThis.crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `manual-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * `{ items, total, truncated, count }` of a list answer (`count` is how many records the page held): a bare array, `{ items }`,
 * `{ <key> }` or `{ data: { <key> } }`, rebuilt record by record.
 */
export function normalizeList(payload, key, normalizer) {
  let source = payload;
  if (!Array.isArray(source) && source && Array.isArray(source[key])) source = source[key];
  if (!Array.isArray(source) && source && source.data && Array.isArray(source.data[key])) source = source.data[key];
  if (!Array.isArray(source) && source && Array.isArray(source.items)) source = source.items;
  if (!Array.isArray(source) || typeof normalizer !== "function") return { items: [], total: 0, truncated: false, count: 0 };
  const items = source.slice(0, MAX_ITEMS).map(normalizer).filter(Boolean);
  const reported = Number(payload?.total ?? payload?.pagination?.total ?? payload?.meta?.total ?? source.length);
  const total = Number.isFinite(reported) ? Math.max(source.length, reported) : source.length;
  return { items, total, truncated: total > items.length, count: source.length };
}

export function normalizeSummary(value) {
  const source = record(value);
  const tts = record(source.tts).period;
  return {
    activeCustomers: integerFromApi(source.activeCustomers ?? source.activeCustomerCount ?? source.customers, ""),
    activeCredentials: integerFromApi(source.activeCredentials ?? source.credentialCount, ""),
    availableCredits: creditsFromApi(source.availableCredits ?? source.balanceCredits, source.availableMicrocredits ?? source.balanceMicrocredits, ""),
    periodTokens: integerFromApi(source.periodTokens ?? source.totalTokens ?? record(source.usage).tokens, ""),
    periodSpend: creditsFromApi(
      source.periodCostCredits ?? source.periodSpendCredits,
      source.periodCostMicrocredits ?? source.periodSpendMicrocredits ?? source.debitedMicrocredits,
      "",
    ),
    tts: tts && typeof tts === "object"
      ? {
        requests: Number(tts.requests) || 0,
        audioSeconds: Number(tts.audioSeconds) || 0,
        characters: Number(tts.characters) || 0,
        charged: microcreditsToCredits(String(tts.chargedMicrocredits || "0"), "0"),
      }
      : null,
  };
}

export function normalizeCustomer(value) {
  const source = record(value);
  const id = safeId(source.customerId ?? source.id);
  if (!id) return null;
  const status = String(source.status || "").toLowerCase();
  const mode = String(source.enforcementMode || "").toLowerCase();
  return {
    id,
    name: safeText(source.name || id, 80),
    externalRef: safeText(source.externalRef, 80),
    status: CUSTOMER_STATUSES.includes(status) ? status : "active",
    planId: safeId(source.planId),
    enforcementMode: MODES.includes(mode) ? mode : "shadow",
    balance: creditsFromApi(source.balanceCredits, source.balanceMicrocredits, "0", true),
    available: creditsFromApi(source.availableCredits, source.availableMicrocredits, "0", true),
    creditLimit: creditsFromApi(source.creditLimit, source.creditLimitMicrocredits, "0"),
    monthlyTokenLimit: integerFromApi(source.monthlyTokenLimit, "0"),
    monthlyRequestLimit: integerFromApi(source.monthlyRequestLimit, "0"),
    monthTokens: integerFromApi(source.periodTokens ?? source.monthTokens ?? source.usageTokens, "0"),
    updatedAt: safeText(source.updatedAt || source.createdAt, 80),
  };
}

export function normalizePlan(value) {
  const source = record(value);
  const id = safeId(source.planId ?? source.id);
  if (!id) return null;
  const mode = String(source.enforcementMode || "").toLowerCase();
  return {
    id,
    code: safeText(source.code || id, 32),
    name: safeText(source.name || source.code || id, 80),
    currency: normalizeCurrency(source.currency || "USD"),
    monthlyPrice: creditsFromApi(source.monthlyPrice, source.monthlyPriceMicrocredits, "0"),
    includedCredits: creditsFromApi(source.includedCredits, source.includedMicrocredits, "0"),
    monthlyTokenLimit: integerFromApi(source.monthlyTokenLimit, "0"),
    monthlyRequestLimit: integerFromApi(source.monthlyRequestLimit, "0"),
    enforcementMode: MODES.includes(mode) ? mode : "shadow",
    active: source.active !== false,
    updatedAt: safeText(source.updatedAt || source.createdAt, 80),
  };
}

export function normalizePrice(value) {
  const source = record(value);
  const id = safeId(source.priceId ?? source.id);
  const modelPattern = safeText(source.modelPattern ?? source.model, 160);
  if (!id && !modelPattern) return null;
  return {
    id: id || `${safeId(source.managerId)}:${modelPattern}`,
    planId: safeId(source.planId),
    managerId: safeText(source.managerId || "*", 40),
    modelPattern: modelPattern || "*",
    input: integerFromApi(source.inputMicrocreditsPerMillion ?? source.inputPerMillionMicrocredits, "0"),
    cachedInput: integerFromApi(source.cachedInputMicrocreditsPerMillion ?? source.cachedInputPerMillionMicrocredits, ""),
    output: integerFromApi(source.outputMicrocreditsPerMillion ?? source.outputPerMillionMicrocredits, "0"),
    active: source.active !== false,
    templateId: safeId(source.templateId ?? source.sourceTemplateId),
    templateProvider: safeText(source.templateProvider ?? source.provider, 60),
    sourceLabel: safeText(source.sourceLabel ?? source.source, 100),
    snapshotDate: safeText(source.snapshotDate ?? source.sourceSnapshot ?? source.sourceSnapshotDate, 80),
    effectiveAt: safeText(source.effectiveAt ?? source.effectiveFrom ?? source.createdAt, 80),
    updatedAt: safeText(source.updatedAt || source.createdAt, 80),
  };
}

export function normalizeCredential(value) {
  const source = record(value);
  const customerId = safeId(source.customerId);
  const serviceClientId = safeId(source.serviceClientId ?? source.clientId);
  if (!customerId || !serviceClientId) return null;
  return {
    id: safeId(source.bindingId ?? source.id) || `${customerId}:${serviceClientId}`,
    customerId,
    managerId: safeText(source.managerId, 40),
    serviceClientId,
    label: safeText(source.label || source.clientName, 100),
    keyPreview: safeKeyPreview(source.keyPreview),
    active: source.active !== false && source.enabled !== false,
    updatedAt: safeText(source.updatedAt || source.createdAt, 80),
  };
}

export function normalizeUsage(value) {
  const source = record(value);
  return {
    id: safeId(source.usageId ?? source.id) || `${safeText(source.period, 40)}:${safeId(source.customerId)}:${safeText(source.at, 40)}`,
    customerId: safeId(source.customerId),
    managerId: safeText(source.managerId, 40),
    model: safeText(source.model ?? source.modelId, 160),
    at: safeText(source.at ?? source.createdAt, 80),
    requests: integerFromApi(source.requests ?? source.requestCount, "1"),
    httpStatus: integerFromApi(source.status ?? source.responseStatus, ""),
    ok: source.ok === true ? true : source.ok === false ? false : null,
    terminalState: safeText(source.terminalState, 40),
    inputTokens: integerFromApi(source.inputTokens, "0"),
    outputTokens: integerFromApi(source.outputTokens, "0"),
    totalTokens: integerFromApi(source.totalTokens ?? source.tokens, "0"),
    projected: creditsFromApi(source.projectedCostCredits, source.projectedChargeMicrocredits ?? source.projectedMicrocredits, ""),
    debited: creditsFromApi(source.debitedCredits, source.debitedMicrocredits ?? source.chargedMicrocredits, ""),
    cost: creditsFromApi(source.costCredits, source.costMicrocredits, "0"),
  };
}

export function normalizeUsageSummaryRow(value) {
  const source = record(value);
  const month = safeText(source.month, 7);
  const day = safeText(source.day, 10);
  return {
    customerId: safeId(source.customerId),
    customerName: safeText(source.customerName, 80),
    model: safeText(source.model, 160),
    month: /^\d{4}-\d{2}$/.test(month) ? month : "",
    day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "",
    requests: integerFromApi(source.requests, "0"),
    ok: integerFromApi(source.ok, "0"),
    inputTokens: integerFromApi(source.inputTokens, "0"),
    cachedInputTokens: integerFromApi(source.cachedInputTokens, "0"),
    outputTokens: integerFromApi(source.outputTokens, "0"),
    totalTokens: integerFromApi(source.totalTokens, "0"),
    projectedMicrocredits: integerFromApi(source.projectedMicrocredits, "0"),
    chargedMicrocredits: integerFromApi(source.chargedMicrocredits, "0"),
  };
}

/**
 * A usage/summary answer (TEL-14) must carry `rows` and `groupBy` arrays. Any
 * other shape (an entry without the route behind a generic stub) is null, so
 * the panel stays hidden instead of passing raw records off as aggregates.
 */
export function normalizeUsageSummary(payload) {
  if (!payload || typeof payload !== "object" || payload.ok === false) return null;
  if (!Array.isArray(payload.rows) || !Array.isArray(payload.groupBy)) return null;
  const offset = Number(payload.tzOffsetMinutes);
  return {
    from: safeText(payload.from, 40),
    to: safeText(payload.to, 40),
    tzOffsetMinutes: Number.isInteger(offset) && Math.abs(offset) <= 840 ? offset : 0,
    rows: payload.rows.slice(0, MAX_ITEMS).map(normalizeUsageSummaryRow),
    totals: normalizeUsageSummaryRow(payload.totals),
    truncated: payload.truncated === true || payload.rows.length > MAX_ITEMS,
  };
}

function normalizeLedger(value) {
  const source = record(value);
  return {
    id: safeId(source.entryId ?? source.id),
    customerId: safeId(source.customerId),
    type: safeText(source.type ?? source.entryType, 60),
    delta: creditsFromApi(source.amountCredits ?? source.deltaCredits, source.deltaMicrocredits, "0", true),
    balanceAfter: creditsFromApi(source.balanceAfterCredits, source.balanceAfterMicrocredits, "", true),
    reason: source.reason,
    idempotencyKey: safeId(source.idempotencyKey),
    requestId: safeId(source.requestId),
    at: safeText(source.createdAt || source.at, 80),
  };
}

function normalizeTemplate(value) {
  const source = record(value);
  const id = safeId(source.templateId ?? source.id);
  if (!id) return null;
  const rates = record(source.rates);
  const context = record(source.context);
  const rate = (...candidates) => decimalFromApi(candidates.find((candidate) => candidate !== undefined && candidate !== null), "");
  return {
    id,
    provider: safeText(source.providerLabel ?? source.provider ?? source.vendor, 60) || "Other",
    model: safeText(source.modelId ?? source.model ?? source.name, 160) || id,
    displayName: safeText(source.modelLabel ?? source.displayName ?? source.label ?? source.name, 180),
    tier: safeText(source.tier ?? source.serviceTier ?? source.status, 80),
    contextLabel: safeText(context.label ?? source.contextLabel, 120),
    currency: normalizeCurrency(source.currency || "USD"),
    input: rate(rates.inputUsdPerMillion, source.inputUsdPerMillion, source.inputPerMillionUsd, source.inputUsd),
    cachedInput: rate(rates.cachedInputUsdPerMillion, source.cachedInputUsdPerMillion, source.cachedInputPerMillionUsd, source.cachedInputUsd),
    output: rate(rates.outputUsdPerMillion, source.outputUsdPerMillion, source.outputPerMillionUsd, source.outputUsd),
    sourceLabel: safeText(source.sourceLabel ?? source.source, 120),
    sourceUrl: safeHttpUrl(source.sourceUrl ?? source.url),
    snapshotDate: safeText(source.snapshotDate ?? source.snapshot ?? source.publishedAt, 80),
    effectiveFrom: safeText(source.effectiveFrom ?? source.effectiveAt, 80),
    effectiveTo: safeText(source.effectiveTo, 80),
    suggestedModelPattern: safeText(source.suggestedModelPattern ?? source.localModelPattern, 160),
    notes: source.notes,
    cacheNotes: source.cacheNotes,
    storageNotes: source.storageNotes,
    cacheWrite: rate(rates.cacheWriteUsdPerMillion, rates.cacheWriteUsd),
    cacheWrite5m: rate(rates.cacheWrite5mUsdPerMillion),
    cacheWrite1h: rate(rates.cacheWrite1hUsdPerMillion),
    cacheStorage: rate(rates.cacheStorageUsdPerMillionTokenHour, rates.cacheStorageUsdPerMillionHour, rates.storageUsdPerMillionHour),
    active: source.active !== false,
  };
}

function auditSummary(source, redacted) {
  if (typeof source.summary === "string" || typeof source.message === "string") return safeNarrative(source.summary || source.message, 500, redacted);
  const details = record(source.details);
  const parts = [];
  for (const key of AUDIT_DETAIL_KEYS) {
    if (details[key] === undefined || details[key] === null || details[key] === "") continue;
    parts.push(`${key}=${safeNarrative(details[key], 140, redacted)}`);
  }
  return safeNarrative(parts.join(" · "), 500, redacted);
}

/** The normalizers that shape free text, which needs the locale's redaction marker. */
export function createTextNormalizers(redacted = "[redacted]") {
  return {
    ledger(value) {
      const entry = normalizeLedger(value);
      return { ...entry, reason: safeNarrative(entry.reason, 500, redacted) };
    },
    audit(value) {
      const source = record(value);
      return {
        id: safeId(source.eventId ?? source.auditId ?? source.id),
        action: safeText(source.action, 100),
        actor: safeText(source.actorId ?? source.actor ?? "system", 100),
        target: safeText([safeText(source.targetType, 60), safeId(source.targetId)].filter(Boolean).join(" · "), 180),
        customerId: safeId(source.customerId),
        summary: auditSummary(source, redacted),
        at: safeText(source.createdAt || source.at, 80),
      };
    },
    template(value) {
      const template = normalizeTemplate(value);
      if (!template) return null;
      return {
        ...template,
        notes: safeNarrative(template.notes, 400, redacted),
        cacheNotes: safeNarrative(template.cacheNotes, 400, redacted),
        storageNotes: safeNarrative(template.storageNotes, 400, redacted),
      };
    },
  };
}

/** The bindable service clients of one manager from GET /api/status (names, ids, state and key previews only). */
export function availableClients(managers, managerId) {
  if (!MANAGER_IDS.includes(managerId)) return [];
  const statusId = managerId.replace(/-manager$/, "");
  const manager = (Array.isArray(managers) ? managers : []).find((item) => safeText(item?.id, 40) === statusId);
  const list = Array.isArray(manager?.clients?.clients) ? manager.clients.clients : [];
  const clients = list.slice(0, MAX_ITEMS).map((item) => {
    const id = safeId(item?.id);
    return id ? { id, name: safeText(item.name || id, 80), enabled: item.enabled !== false, keyPreview: safeKeyPreview(item.keyPreview), global: false } : null;
  }).filter(Boolean);
  const exposure = record(record(manager?.exposure).settings);
  const globalId = safeId(exposure.billingClientId);
  if (globalId && exposure.hasApiKey === true && !clients.some((item) => item.id === globalId)) {
    clients.unshift({ id: globalId, name: "", enabled: exposure.enabled !== false, keyPreview: safeKeyPreview(exposure.apiKeyPreview), global: true });
  }
  return clients.slice(0, MAX_ITEMS);
}

// ---------------------------------------------------------------------------
// Labels and derived values
// ---------------------------------------------------------------------------

/** "vllm-manager" | "vllm" → "vLLM Manager"; these names are products, not copy. */
export function managerName(value) {
  if (value === "vllm-manager" || value === "vllm") return "vLLM Manager";
  if (value === "llama-manager" || value === "llama") return "llama.cpp Manager";
  return safeText(value || "", 60);
}

/** Tone of a usage row's terminal state; `ok` null (unknown) has no tone. */
export function usageState(usage) {
  const known = TERMINAL_STATES[usage.terminalState];
  if (known) return { state: usage.terminalState, tone: known };
  if (usage.ok === true) return { state: "success", tone: "ok" };
  if (usage.ok === false) return { state: "failure", tone: "fail" };
  return { state: "unknown", tone: "" };
}

/** `selectable` and the reason code (active | inactive | future | expired) of a template at `now` (ms). */
export function templateAvailability(template, now = Date.now()) {
  if (!template.active) return { selectable: false, code: "inactive" };
  const from = template.effectiveFrom ? new Date(template.effectiveFrom).getTime() : NaN;
  const to = template.effectiveTo ? new Date(template.effectiveTo).getTime() : NaN;
  if (Number.isFinite(from) && now < from) return { selectable: false, code: "future" };
  if (Number.isFinite(to) && now >= to) return { selectable: false, code: "expired" };
  return { selectable: true, code: "active" };
}

export function filterCustomers(customers, { query = "", planId = "", mode = "", status = "" } = {}) {
  const needle = safeText(query, 80).trim().toLowerCase();
  return customers.filter((customer) => {
    const haystack = `${customer.name} ${customer.externalRef} ${customer.id}`.toLowerCase();
    return (!needle || haystack.includes(needle))
      && (!planId || customer.planId === planId)
      && (!mode || customer.enforcementMode === mode)
      && (!status || customer.status === status);
  });
}

export function filterPrices(prices, { managerId = "", planId = "", provider = "", query = "" } = {}) {
  const needle = safeText(query, 160).trim().toLowerCase();
  return prices.filter((price) => (!managerId || price.managerId === managerId)
    && (!planId || price.planId === planId)
    && (!provider || price.templateProvider === provider)
    && (!needle || price.modelPattern.toLowerCase().includes(needle)));
}

export function filterTemplates(templates, { provider = "", query = "" } = {}) {
  const needle = safeText(query, 100).trim().toLowerCase();
  return templates.filter((template) => {
    const haystack = `${template.provider} ${template.model} ${template.displayName} ${template.id}`.toLowerCase();
    return (!provider || template.provider === provider) && (!needle || haystack.includes(needle));
  });
}

// ---------------------------------------------------------------------------
// Usage summary (TEL-14): period labels and the daily chart
// ---------------------------------------------------------------------------

/** First and last local day of a summary period and its zone as "UTC+08:00". */
export function summaryPeriod(summary) {
  const offsetMs = summary.tzOffsetMinutes * 60 * 1000;
  const localDay = (ms) => (Number.isFinite(ms) ? new Date(ms + offsetMs).toISOString().slice(0, 10) : "—");
  const minutes = Math.abs(summary.tzOffsetMinutes);
  return {
    from: localDay(Date.parse(summary.from)),
    to: localDay(Date.parse(summary.to) - 1),
    tz: `UTC${summary.tzOffsetMinutes < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
  };
}

/** One slot per local day of the period (days without usage stay empty), plus any day the rows name. */
export function summaryDayKeys(daily) {
  const keys = [];
  const from = Date.parse(daily.from);
  const to = Date.parse(daily.to);
  const offsetMs = daily.tzOffsetMinutes * 60 * 1000;
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    for (let at = from; at < to && keys.length < 62; at += DAY_MS) {
      const key = new Date(at + offsetMs).toISOString().slice(0, 10);
      if (!keys.includes(key)) keys.push(key);
    }
  }
  for (const item of daily.rows) {
    if (item.day && !keys.includes(item.day) && keys.length < 62) keys.push(item.day);
  }
  return keys.sort();
}

/**
 * The daily token chart: a viewBox 10 units per day by 100 high, bar heights
 * from BigInt ratios (the tallest is 100, any usage is at least 1), and the
 * first, middle and last day as axis ticks. null without days.
 */
export function dailyChart(daily) {
  const days = daily ? summaryDayKeys(daily) : [];
  if (!days.length) return null;
  const byDay = new Map(daily.rows.filter((item) => item.day).map((item) => [item.day, item]));
  const tokens = days.map((day) => BigInt(byDay.get(day)?.totalTokens || "0"));
  const peak = tokens.reduce((max, value) => (value > max ? value : max), 0n);
  const slot = 10;
  const bars = [];
  days.forEach((day, index) => {
    if (tokens[index] <= 0n) return;
    const height = Math.max(1, Number((tokens[index] * 1000n) / peak) / 10);
    bars.push({ day, x: index * slot + 1.5, y: 100 - height, width: slot - 3, height, row: byDay.get(day) });
  });
  return {
    days,
    width: days.length * slot,
    peak: peak.toString(),
    bars,
    ticks: Array.from(new Set([days[0], days[Math.floor((days.length - 1) / 2)], days[days.length - 1]])),
  };
}

// ---------------------------------------------------------------------------
// Validation: what a form may send
// ---------------------------------------------------------------------------

class Invalid {
  constructor(code, vars) {
    this.code = code;
    this.vars = vars;
  }
}

const bad = (code, vars = {}) => new Invalid(code, vars);

function textValue(raw, { min = 0, max = 0, pattern, required = true } = {}) {
  const text = String(raw ?? "");
  const value = text.trim();
  if (!value) return required ? bad("required") : "";
  if (ANY_CONTROL.test(text)) return bad("control");
  if (min && value.length < min) return bad("min", { min });
  if (max && value.length > max) return bad("max", { max });
  if (pattern && !pattern.test(value)) return bad("pattern");
  return value;
}

function decimalValue(raw, { allowNegative = false, allowZero = true } = {}) {
  const text = String(raw ?? "").trim();
  const expression = allowNegative ? /^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/ : /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/;
  if (!expression.test(text)) return bad("decimal");
  if (!allowZero && decimalIsZero(text)) return bad("zero");
  return text;
}

function integerValue(raw, maxDigits, maxValue) {
  const text = String(raw ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(text) || text.length > maxDigits) return bad("integer", { digits: maxDigits });
  if (maxValue !== undefined && BigInt(text) > maxValue) return bad("maxValue", { maxValue: maxValue.toString() });
  return text;
}

function enumValue(raw, allowed) {
  const text = String(raw ?? "").trim();
  return allowed.includes(text) ? text : bad("enum");
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._*?/:@+-]{0,159}$/;
const modelPatternValue = (raw) => textValue(raw, { min: 1, max: 160, pattern: MODEL_PATTERN });

function customerRef(raw, customers) {
  const id = safeId(raw);
  return id && customers.some((item) => item.id === id) ? id : bad("customer");
}

function planRef(raw, plans) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const id = safeId(text);
  return id && plans.some((item) => item.id === id && item.active) ? id : bad("plan");
}

/** `{ ok: true, value }` or `{ ok: false, errors: { field: { code, vars } } }` from per-field checks. */
function run(checks) {
  const value = {};
  const errors = {};
  for (const [name, check] of Object.entries(checks)) {
    const result = check();
    if (result instanceof Invalid) errors[name] = { code: result.code, vars: result.vars };
    else value[name] = result;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export function validateCustomer(values, { plans = [] } = {}) {
  return run({
    name: () => textValue(values.name, { min: 2, max: 80 }),
    externalRef: () => textValue(values.externalRef, { required: false, max: 80, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/ }),
    planId: () => planRef(values.planId, plans) || null,
    enforcementMode: () => enumValue(values.enforcementMode, MODES),
    creditLimit: () => decimalValue(values.creditLimit),
    monthlyTokenLimit: () => integerValue(values.monthlyTokenLimit, 24),
    monthlyRequestLimit: () => integerValue(values.monthlyRequestLimit, 24),
  });
}

/** `{ customerId, body }`; the PATCH goes to /api/billing/customers/:id/policy. */
export function validatePolicy(values, { customers = [], plans = [] } = {}) {
  const result = run({
    customerId: () => customerRef(values.customerId, customers),
    planId: () => planRef(values.planId, plans) || null,
    enforcementMode: () => enumValue(values.enforcementMode, MODES),
    creditLimit: () => decimalValue(values.creditLimit),
    monthlyTokenLimit: () => integerValue(values.monthlyTokenLimit, 24),
    monthlyRequestLimit: () => integerValue(values.monthlyRequestLimit, 24),
  });
  if (!result.ok) return result;
  const { customerId, ...body } = result.value;
  return { ok: true, value: { customerId, body } };
}

export function validateCredential(values, { customers = [], managers = [] } = {}) {
  const managerId = enumValue(values.managerId, MANAGER_IDS);
  return run({
    customerId: () => customerRef(values.customerId, customers),
    managerId: () => managerId,
    serviceClientId: () => {
      if (managerId instanceof Invalid) return bad("client");
      const id = safeId(values.serviceClientId);
      const client = availableClients(managers, managerId).find((item) => item.id === id);
      if (!client) return bad("client");
      return client.enabled ? id : bad("clientDisabled");
    },
  });
}

export function validateAdjustment(values, { customers = [] } = {}) {
  return run({
    customerId: () => customerRef(values.customerId, customers),
    amountCredits: () => decimalValue(values.amountCredits, { allowNegative: true, allowZero: false }),
    reason: () => textValue(values.reason, { min: 3, max: 500 }),
  });
}

export function validatePlan(values) {
  return run({
    code: () => textValue(values.code, { min: 2, max: 32, pattern: /^[A-Z0-9][A-Z0-9._-]{1,31}$/ }),
    name: () => textValue(values.name, { min: 2, max: 80 }),
    currency: () => textValue(values.currency, { min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    monthlyPrice: () => decimalValue(values.monthlyPrice),
    includedCredits: () => decimalValue(values.includedCredits),
    enforcementMode: () => enumValue(values.enforcementMode, MODES),
    monthlyTokenLimit: () => integerValue(values.monthlyTokenLimit, 24),
    monthlyRequestLimit: () => integerValue(values.monthlyRequestLimit, 24),
    active: () => true,
  });
}

export function validatePrice(values, { plans = [] } = {}) {
  return run({
    planId: () => planRef(values.planId, plans) || null,
    managerId: () => enumValue(values.managerId, MANAGER_IDS),
    modelPattern: () => modelPatternValue(values.modelPattern),
    inputMicrocreditsPerMillion: () => integerValue(values.inputMicrocreditsPerMillion, 19, MAX_INT64),
    cachedInputMicrocreditsPerMillion: () => integerValue(values.cachedInputMicrocreditsPerMillion, 19, MAX_INT64),
    outputMicrocreditsPerMillion: () => integerValue(values.outputMicrocreditsPerMillion, 19, MAX_INT64),
    active: () => enumValue(values.active, ["true", "false"]),
  });
}

/** The body of POST /api/billing/templates/{preview,apply}; errors also cover a missing or unavailable template. */
export function validateTemplateApply(values, { template, plans = [], now = Date.now() } = {}) {
  if (!template) return { ok: false, errors: { template: { code: "template", vars: {} } } };
  const availability = templateAvailability(template, now);
  if (!availability.selectable) return { ok: false, errors: { template: { code: "templateUnavailable", vars: { reason: availability.code } } } };
  const result = run({
    managerId: () => enumValue(values.managerId, MANAGER_IDS),
    planId: () => planRef(values.planId, plans) || null,
    modelPattern: () => modelPatternValue(values.modelPattern),
    creditsPerUsd: () => decimalValue(values.creditsPerUsd, { allowZero: false }),
    markupBps: () => {
      const bps = integerValue(values.markupBps, 12);
      return bps instanceof Invalid || BigInt(bps) > 0n ? bps : bad("markup");
    },
  });
  if (!result.ok) return result;
  const { managerId, planId, modelPattern, creditsPerUsd, markupBps } = result.value;
  return {
    ok: true,
    value: { items: [{ templateId: template.id, managerId, modelPattern, planId }], creditsPerUsd, markupBps },
  };
}

/** Identity of a template-apply body: a preview is valid only for the exact body it was made from. */
export function templateSignature(payload) {
  const item = payload.items[0];
  return [item.templateId, item.managerId, item.modelPattern, item.planId || "", payload.creditsPerUsd, payload.markupBps].join("\u001f");
}

/** The first priced item of a preview answer (the server's own integer microcredit rates). */
export function previewItem(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const item = items[0] || payload?.preview || payload || {};
  const price = item.price && typeof item.price === "object" ? item.price : item;
  return {
    modelPattern: safeText(item.modelPattern ?? price.modelPattern, 160),
    input: integerFromApi(price.inputPerMillionMicrocredits ?? price.inputMicrocreditsPerMillion, ""),
    cachedInput: integerFromApi(price.cachedInputPerMillionMicrocredits ?? price.cachedInputMicrocreditsPerMillion, ""),
    output: integerFromApi(price.outputPerMillionMicrocredits ?? price.outputMicrocreditsPerMillion, ""),
    effectiveAt: safeText(item.effectiveAt ?? price.effectiveAt ?? payload?.effectiveAt, 80),
    warning: payload?.warning ?? payload?.message ?? "",
  };
}
