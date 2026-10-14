"use strict";

// Manager -> entry billing calls. The names below are kept for existing
// callers; signing and verification live in internal-auth.js (the manager
// form of the one internal scheme), which reproduces the billing signature
// byte for byte.
const {
  BILLING_PATH_PREFIX,
  MANAGER_PRINCIPAL_HEADER,
  MANAGER_TIMESTAMP_HEADER,
  MANAGER_SIGNATURE_HEADER,
  MANAGER_VERSION_HEADER,
  bodySha256Hex,
  normalizeInternalManagerId,
  signInternal,
  buildInternalRequestHeaders,
  verifyInternalRequest,
  normalizeInternalBaseUrl,
  createInternalClient,
} = require("./internal-auth");

const BILLING_MANAGER_HEADER = MANAGER_PRINCIPAL_HEADER;
const BILLING_TIMESTAMP_HEADER = MANAGER_TIMESTAMP_HEADER;
const BILLING_SIGNATURE_HEADER = MANAGER_SIGNATURE_HEADER;
const BILLING_VERSION_HEADER = MANAGER_VERSION_HEADER;
const DEFAULT_BILLING_BASE_URL = "http://127.0.0.1:5176";
const DEFAULT_BILLING_TIMEOUT_MS = 3000;

function normalizeBillingManagerId(value) {
  return normalizeInternalManagerId(value);
}

function normalizeBillingPath(value) {
  const pathname = String(value || "").split("?")[0];
  if (!pathname.startsWith(BILLING_PATH_PREFIX)) return "";
  return pathname;
}

function billingBodyHash(body) {
  return bodySha256Hex(body);
}

function signBillingRequest(token, method, pathname, managerId, timestamp, body) {
  return signInternal(token, {
    method: String(method || "POST"),
    path: normalizeBillingPath(pathname),
    principal: normalizeBillingManagerId(managerId),
    ts: String(timestamp || ""),
    bodySha256: billingBodyHash(body),
  });
}

function buildBillingRequestHeaders(token, method, pathname, managerId, body, now = Date.now()) {
  if (!normalizeBillingPath(pathname)) return {};
  return buildInternalRequestHeaders(token, method, pathname, managerId, body, now);
}

// Billing keeps its historical billing_* codes. A path outside the billing
// prefix was reported as a missing signature before, and still is.
function verifyBillingRequest(req, rawBody, token, options = {}) {
  const verified = verifyInternalRequest(req, rawBody, token, { ...options, pathPrefixes: [BILLING_PATH_PREFIX] });
  if (verified.ok) return verified;
  if (verified.code === "internal_path_not_allowed") return { ok: false, code: "billing_signature_missing" };
  return { ok: false, code: String(verified.code).replace(/^internal_/, "billing_") };
}

function normalizeBillingBaseUrl(value) {
  return normalizeInternalBaseUrl(value || DEFAULT_BILLING_BASE_URL, { label: "Billing service" });
}

function boundedBillingTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(10000, Math.max(250, Math.floor(number))) : DEFAULT_BILLING_TIMEOUT_MS;
}

function normalizeBillingResponse(data, response, fallbackCode) {
  const item = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    ...item,
    ok: item.ok === true && response.ok,
    allowed: item.allowed !== false && response.ok,
    status: response.status,
    code: String(item.code || (response.ok ? "" : fallbackCode || "billing_error")),
    message: String(item.message || item.error || (response.ok ? "" : "Billing service rejected the request.")),
  };
}

function billingUnavailable(error) {
  const messages = {
    internal_key_unavailable: "Billing trust is unavailable.",
    internal_timeout: "Billing service timed out.",
  };
  return {
    ok: false,
    allowed: false,
    status: 503,
    code: "billing_unavailable",
    message: messages[error?.code] || "Billing service is unavailable.",
  };
}

function createBillingClient(options = {}) {
  const managerId = normalizeBillingManagerId(options.managerId);
  if (!managerId) throw new Error("A valid billing manager id is required.");
  const baseUrl = normalizeBillingBaseUrl(options.baseUrl || process.env.AI_BILLING_BASE_URL || DEFAULT_BILLING_BASE_URL);
  const timeoutMs = boundedBillingTimeout(options.timeoutMs ?? process.env.AI_BILLING_TIMEOUT_MS);
  // The internal client reads the trust token per request, signs in the
  // manager form and retries once on 401 after re-reading a rotated token.
  const internalClient = createInternalClient({
    managerId,
    baseUrl,
    timeoutMs,
    aiRoot: options.root,
    trustFile: options.trustFile,
    readKey: options.readToken,
    fetchFn: options.fetchFn,
  });

  async function post(pathname, input = {}, postOptions = {}) {
    const normalizedPath = normalizeBillingPath(pathname);
    if (!normalizedPath) throw new Error("Billing request path is not allowed.");
    const payload = {
      ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
      managerId,
    };
    const body = JSON.stringify(payload);
    const attempts = Math.min(3, Math.max(1, Number(postOptions.attempts || 1)));
    let lastResult = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { status, json } = await internalClient.request("POST", normalizedPath, body);
        lastResult = normalizeBillingResponse(json, { ok: status >= 200 && status < 300, status }, "billing_rejected");
        if (status < 500 || attempt === attempts) return lastResult;
      } catch (error) {
        lastResult = billingUnavailable(error);
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
    return lastResult;
  }

  return {
    managerId,
    baseUrl,
    authorize(input) {
      return post("/internal/billing/authorize", input, { attempts: 1 });
    },
    settle(input) {
      return post("/internal/billing/settle", input, { attempts: 3 });
    },
  };
}

module.exports = {
  BILLING_MANAGER_HEADER,
  BILLING_TIMESTAMP_HEADER,
  BILLING_SIGNATURE_HEADER,
  BILLING_VERSION_HEADER,
  DEFAULT_BILLING_BASE_URL,
  DEFAULT_BILLING_TIMEOUT_MS,
  normalizeBillingManagerId,
  billingBodyHash,
  signBillingRequest,
  buildBillingRequestHeaders,
  verifyBillingRequest,
  normalizeBillingBaseUrl,
  createBillingClient,
};
