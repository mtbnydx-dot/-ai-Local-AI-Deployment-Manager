"use strict";

const {
  CATALOG_VERSION,
  listPriceTemplates,
  previewPriceTemplateApplications,
} = require("./billing-price-templates");

const MAX_BILLING_BODY_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "x-service-entry-gateway",
];
const MICROCREDITS_PER_CREDIT = 1_000_000n;
const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
}

function billingHttpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function creditsToMicrocredits(value, field = "credits", options = {}) {
  const text = String(value ?? "").trim();
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match || (!options.allowNegative && match[1])) {
    throw billingHttpError(400, "invalid_amount", `${field} must be a decimal with at most 6 fractional digits.`);
  }
  const fractional = String(match[3] || "").padEnd(6, "0");
  let amount = (BigInt(match[2]) * MICROCREDITS_PER_CREDIT) + BigInt(fractional || "0");
  if (match[1]) amount = -amount;
  if ((!options.allowZero && amount === 0n) || amount > SQLITE_MAX_INTEGER || amount < -SQLITE_MAX_INTEGER) {
    throw billingHttpError(400, "invalid_amount", `${field} is outside the supported range.`);
  }
  return amount.toString();
}

function moveCreditFields(input, mappings, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const output = { ...source };
  for (const [creditField, microcreditField] of Object.entries(mappings)) {
    if (source[creditField] === undefined) continue;
    output[microcreditField] = creditsToMicrocredits(source[creditField], creditField, options[creditField] || { allowZero: true });
    delete output[creditField];
  }
  return output;
}

function zeroMeansUnset(value) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === "" || /^0+$/.test(String(value).trim())) return null;
  return value;
}

function adaptCustomerInput(input) {
  const output = moveCreditFields(input, { creditLimit: "creditLimitMicrocredits" }, { creditLimit: { allowZero: true } });
  if (output.creditLimitMicrocredits !== undefined) output.creditLimitMicrocredits = zeroMeansUnset(output.creditLimitMicrocredits);
  if (output.monthlyTokenLimit !== undefined) output.monthlyTokenLimit = zeroMeansUnset(output.monthlyTokenLimit);
  if (output.monthlyRequestLimit !== undefined) output.monthlyRequestLimit = zeroMeansUnset(output.monthlyRequestLimit);
  return output;
}

function adaptPlanInput(input) {
  const output = moveCreditFields(input, {
    monthlyPrice: "monthlyPriceMicrocredits",
    includedCredits: "includedMicrocredits",
  }, {
    monthlyPrice: { allowZero: true },
    includedCredits: { allowZero: true },
  });
  // The workbench documents zero quota fields as "not configured". Preserve
  // zero for the plan's price, but turn quota zeroes into NULL so a freshly
  // created Hard plan does not accidentally reject every request.
  if (output.includedMicrocredits !== undefined) output.includedMicrocredits = zeroMeansUnset(output.includedMicrocredits);
  if (output.monthlyTokenLimit !== undefined) output.monthlyTokenLimit = zeroMeansUnset(output.monthlyTokenLimit);
  if (output.monthlyRequestLimit !== undefined) output.monthlyRequestLimit = zeroMeansUnset(output.monthlyRequestLimit);
  return output;
}

function adaptAdjustmentInput(input) {
  return moveCreditFields(input, { amountCredits: "deltaMicrocredits" }, {
    amountCredits: { allowNegative: true, allowZero: false },
  });
}

function adaptPriceInput(input) {
  const source = isPlainObject(input) ? input : {};
  const managerId = String(source.managerId ?? "").trim();
  if (!managerId) throw billingHttpError(400, "invalid_manager_id", "managerId is required for billing prices.");
  return {
    ...source,
    managerId,
    model: source.model ?? source.modelPattern,
    inputPerMillionMicrocredits: source.inputPerMillionMicrocredits ?? source.inputMicrocreditsPerMillion,
    outputPerMillionMicrocredits: source.outputPerMillionMicrocredits ?? source.outputMicrocreditsPerMillion,
    ...(source.cachedInputMicrocreditsPerMillion !== undefined
      ? { cachedInputPerMillionMicrocredits: source.cachedInputMicrocreditsPerMillion }
      : {}),
  };
}

function localAdminInput(input) {
  return { ...(isPlainObject(input) ? input : {}), actorId: "local-admin" };
}

function strictLocalBillingAdmin(req, options = {}) {
  const headers = req?.headers || {};
  if (FORWARDED_HEADERS.some((name) => String(headers[name] || "").trim())) return false;
  const hostname = options.extractHostname(headers.host);
  if (!LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase())) return false;
  return options.isLocalAddress(req?.socket?.remoteAddress || req?.ip || "");
}

function boundedListLimit(value, fallback = 100) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (!/^\d{1,4}$/.test(text)) throw billingHttpError(400, "invalid_limit", "limit must be an integer between 1 and 500.");
  return Math.min(500, Math.max(1, Number(text)));
}

function boundedOffset(value) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (!/^\d{1,9}$/.test(text)) throw billingHttpError(400, "invalid_offset", "offset must be a non-negative integer.");
  return Math.min(1_000_000, Number(text));
}

function cleanRouteId(value, label = "id") {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(text)) {
    throw billingHttpError(400, "invalid_id", `${label} is invalid.`);
  }
  return text;
}

function listOptions(url) {
  return {
    limit: boundedListLimit(url.searchParams.get("limit")),
    offset: boundedOffset(url.searchParams.get("offset")),
  };
}

function usageOptions(url) {
  const window = String(url.searchParams.get("window") || "month").trim().toLowerCase();
  if (!["day", "month", "all"].includes(window)) {
    throw billingHttpError(400, "invalid_window", "window must be day, month, or all.");
  }
  const customerId = String(url.searchParams.get("customerId") || "").trim();
  const tzRaw = url.searchParams.get("tzOffsetMinutes");
  const tzOffsetMinutes = tzRaw == null || tzRaw === ""
    ? undefined
    : Number(tzRaw);
  if (tzOffsetMinutes !== undefined && !Number.isFinite(tzOffsetMinutes)) {
    throw billingHttpError(400, "invalid_tz_offset", "tzOffsetMinutes must be a number of minutes.");
  }
  return {
    ...listOptions(url),
    window,
    ...(customerId ? { customerId: cleanRouteId(customerId, "customerId") } : {}),
    ...(tzOffsetMinutes !== undefined ? { tzOffsetMinutes } : {}),
  };
}

function booleanQuery(value, field) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true"].includes(normalized)) return true;
  if (["0", "false"].includes(normalized)) return false;
  throw billingHttpError(400, "invalid_boolean", `${field} must be true or false.`);
}

function priceOptions(url) {
  const options = listOptions(url);
  if (url.searchParams.has("planId")) {
    const planId = String(url.searchParams.get("planId") || "").trim();
    options.planId = planId ? cleanRouteId(planId, "planId") : null;
  }
  if (url.searchParams.has("active")) options.active = booleanQuery(url.searchParams.get("active"), "active");
  return options;
}

function templateFilters(url) {
  const filters = {};
  for (const field of ["provider", "modelId", "tier", "effectiveAt"]) {
    if (url.searchParams.has(field)) filters[field] = String(url.searchParams.get(field) || "").trim();
  }
  return filters;
}

function requireJsonContentType(req) {
  const contentType = String(req?.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw billingHttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
}

async function readBillingBody(req, readRequestBody) {
  requireJsonContentType(req);
  const raw = await readRequestBody(req, MAX_BILLING_BODY_BYTES);
  let data;
  try {
    if (!raw?.length) throw billingHttpError(400, "invalid_json", "Request body must be valid JSON.");
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    throw billingHttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isPlainObject(data)) throw billingHttpError(400, "invalid_request", "Request body must be a JSON object.");
  return { raw, data };
}

function storeMethod(store, name) {
  const fn = store?.[name];
  if (typeof fn !== "function") throw new Error(`Billing store method is unavailable: ${name}`);
  return fn.bind(store);
}

function internalStatus(result, operation) {
  if (result?.ok === true && result?.allowed !== false) return 200;
  const code = String(result?.code || "");
  if (operation === "authorize" && [
    "insufficient_quota", "request_limit_exceeded", "token_limit_exceeded", "spend_limit_exceeded",
    "billing_insufficient_balance", "billing_period_credit_limit", "billing_period_token_limit", "billing_period_request_limit",
  ].includes(code)) return 429;
  if ([
    "customer_suspended", "credential_disabled", "billing_customer_inactive", "billing_plan_inactive", "billing_credential_unbound",
  ].includes(code)) return 403;
  if (["idempotency_conflict", "request_already_settled"].includes(code)) return 409;
  if (["invalid_request"].includes(code)) return 400;
  if (["price_not_configured", "billing_price_not_configured"].includes(code)) return 503;
  return Number(result?.status || 503);
}

function publicError(error) {
  const status = Number(error?.status || 500);
  const safe = status >= 400 && status < 500;
  return {
    status,
    body: {
      ok: false,
      code: safe ? String(error?.code || "invalid_request") : "billing_error",
      message: safe ? String(error?.message || "Billing request is invalid.") : "Billing service error.",
    },
  };
}

function createBillingHttpHandler(options = {}) {
  const {
    getStore,
    readRequestBody,
    sendJson,
    verifyBillingRequest,
    getTrustToken,
    isLocalAddress,
    extractHostname,
  } = options;
  if (typeof getStore !== "function" || typeof readRequestBody !== "function" || typeof sendJson !== "function") {
    throw new Error("Billing HTTP handler dependencies are incomplete.");
  }

  async function handleInternal(req, res, url) {
    if (!url.pathname.startsWith("/internal/billing/")) return false;
    if (req.method !== "POST" || !["/internal/billing/authorize", "/internal/billing/settle"].includes(url.pathname)) {
      sendJson(res, { ok: false, code: "not_found", message: "Not found." }, 404);
      return true;
    }
    try {
      const { raw, data } = await readBillingBody(req, readRequestBody);
      const verified = verifyBillingRequest(req, raw, getTrustToken(), { pathname: url.pathname });
      if (!verified.ok) {
        sendJson(res, { ok: false, allowed: false, code: "billing_unauthorized", message: "Billing request authentication failed." }, 401);
        return true;
      }
      if (String(data.managerId || "").trim().toLowerCase() !== verified.managerId) {
        sendJson(res, { ok: false, allowed: false, code: "billing_manager_mismatch", message: "Billing manager identity does not match." }, 401);
        return true;
      }
      const store = getStore();
      const operation = url.pathname.endsWith("/authorize") ? "authorize" : "settle";
      const result = operation === "authorize"
        ? await storeMethod(store, "authorizeRequest")(data)
        : await storeMethod(store, "settleRequest")(data);
      sendJson(res, jsonSafe(result), internalStatus(result, operation));
    } catch (error) {
      const safe = publicError(error);
      sendJson(res, safe.body, safe.status);
    }
    return true;
  }

  async function handleAdmin(req, res, url) {
    if (!url.pathname.startsWith("/api/billing")) return false;
    if (!strictLocalBillingAdmin(req, { isLocalAddress, extractHostname })) {
      sendJson(res, { ok: false, code: "billing_admin_local_only", message: "Billing administration is available only through localhost." }, 403);
      return true;
    }
    try {
      const store = getStore();
      const method = String(req.method || "GET").toUpperCase();
      let result;
      if (method === "GET" && url.pathname === "/api/billing/overview") {
        result = await storeMethod(store, "getOverview")();
      } else if (method === "GET" && url.pathname === "/api/billing/templates") {
        result = { catalogVersion: CATALOG_VERSION, items: listPriceTemplates(templateFilters(url)) };
      } else if (method === "GET" && url.pathname === "/api/billing/customers") {
        result = await storeMethod(store, "listCustomers")(listOptions(url));
      } else if (method === "GET" && url.pathname === "/api/billing/plans") {
        result = await storeMethod(store, "listPlans")(listOptions(url));
      } else if (method === "GET" && url.pathname === "/api/billing/credentials") {
        result = await storeMethod(store, "listCredentialBindings")(listOptions(url));
      } else if (method === "GET" && url.pathname === "/api/billing/prices") {
        result = await storeMethod(store, "listPrices")(priceOptions(url));
      } else if (method === "GET" && url.pathname === "/api/billing/usage") {
        result = await storeMethod(store, "listUsage")(usageOptions(url));
      } else if (method === "GET" && url.pathname === "/api/billing/ledger") {
        result = await storeMethod(store, "listLedger")({
          ...listOptions(url),
          customerId: url.searchParams.get("customerId") ? cleanRouteId(url.searchParams.get("customerId"), "customerId") : "",
        });
      } else if (method === "GET" && url.pathname === "/api/billing/audit-events") {
        result = await storeMethod(store, "listAuditEvents")(listOptions(url));
      } else if (method === "POST" && url.pathname === "/api/billing/customers") {
        result = await storeMethod(store, "createCustomer")(localAdminInput(adaptCustomerInput((await readBillingBody(req, readRequestBody)).data)));
      } else if (method === "POST" && url.pathname === "/api/billing/plans") {
        result = await storeMethod(store, "createPlan")(localAdminInput(adaptPlanInput((await readBillingBody(req, readRequestBody)).data)));
      } else if (method === "POST" && url.pathname === "/api/billing/credentials") {
        result = await storeMethod(store, "bindCredential")(localAdminInput((await readBillingBody(req, readRequestBody)).data));
      } else if (method === "POST" && url.pathname === "/api/billing/prices") {
        result = await storeMethod(store, "upsertPrice")(localAdminInput(adaptPriceInput((await readBillingBody(req, readRequestBody)).data)));
      } else if (method === "POST" && url.pathname === "/api/billing/ledger/adjustments") {
        result = await storeMethod(store, "adjustBalance")(localAdminInput(adaptAdjustmentInput((await readBillingBody(req, readRequestBody)).data)));
      } else if (method === "POST" && url.pathname === "/api/billing/templates/preview") {
        result = previewPriceTemplateApplications((await readBillingBody(req, readRequestBody)).data);
      } else if (method === "POST" && url.pathname === "/api/billing/templates/apply") {
        result = await storeMethod(store, "applyPriceTemplates")((await readBillingBody(req, readRequestBody)).data);
      } else {
        const customerMatch = url.pathname.match(/^\/api\/billing\/customers\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)$/);
        const policyMatch = url.pathname.match(/^\/api\/billing\/customers\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)\/policy$/);
        const planMatch = url.pathname.match(/^\/api\/billing\/plans\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)$/);
        if (method === "PATCH" && policyMatch) {
          result = await storeMethod(store, "updateCustomerPolicy")(
            cleanRouteId(policyMatch[1], "customerId"),
            localAdminInput(adaptCustomerInput((await readBillingBody(req, readRequestBody)).data)),
          );
        } else if (method === "PATCH" && customerMatch) {
          result = await storeMethod(store, "updateCustomer")(
            cleanRouteId(customerMatch[1], "customerId"),
            localAdminInput(adaptCustomerInput((await readBillingBody(req, readRequestBody)).data)),
          );
        } else if (method === "PATCH" && planMatch) {
          result = await storeMethod(store, "updatePlan")(
            cleanRouteId(planMatch[1], "planId"),
            localAdminInput(adaptPlanInput((await readBillingBody(req, readRequestBody)).data)),
          );
        } else {
          throw billingHttpError(404, "not_found", "Billing API route not found.");
        }
      }
      const payload = Array.isArray(result)
        ? { ok: true, items: result }
        : result?.ok === undefined
          ? { ok: true, ...result }
          : result;
      sendJson(res, jsonSafe(payload), 200);
    } catch (error) {
      const safe = publicError(error);
      sendJson(res, safe.body, safe.status);
    }
    return true;
  }

  return async function handleBillingHttpRequest(req, res, url) {
    if (await handleInternal(req, res, url)) return true;
    return handleAdmin(req, res, url);
  };
}

module.exports = {
  MAX_BILLING_BODY_BYTES,
  strictLocalBillingAdmin,
  boundedListLimit,
  creditsToMicrocredits,
  adaptCustomerInput,
  adaptPlanInput,
  adaptAdjustmentInput,
  adaptPriceInput,
  localAdminInput,
  priceOptions,
  templateFilters,
  zeroMeansUnset,
  jsonSafe,
  createBillingHttpHandler,
};
