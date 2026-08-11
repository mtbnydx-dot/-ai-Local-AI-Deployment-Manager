"use strict";

const crypto = require("node:crypto");
const { createGatewayTrustReader } = require("./gateway-trust");
const { isLocalAddress, normalizeRemoteAddress } = require("./network");

const BILLING_MANAGER_HEADER = "x-ai-billing-manager";
const BILLING_TIMESTAMP_HEADER = "x-ai-billing-ts";
const BILLING_SIGNATURE_HEADER = "x-ai-billing-signature";
const BILLING_VERSION_HEADER = "x-ai-billing-version";
const DEFAULT_BILLING_BASE_URL = "http://127.0.0.1:5176";
const DEFAULT_BILLING_TIMEOUT_MS = 3000;
const DEFAULT_BILLING_MAX_SKEW_MS = 60 * 1000;

function headerText(headers = {}, name) {
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return Boolean(a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
}

function normalizeBillingManagerId(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/.test(text)) return "";
  return text;
}

function normalizeBillingPath(value) {
  const pathname = String(value || "").split("?")[0];
  if (!pathname.startsWith("/internal/billing/")) return "";
  return pathname;
}

function billingBodyHash(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function signBillingRequest(token, method, pathname, managerId, timestamp, body) {
  return crypto
    .createHmac("sha256", String(token || ""))
    .update([
      String(method || "POST").toUpperCase(),
      normalizeBillingPath(pathname),
      normalizeBillingManagerId(managerId),
      String(timestamp || ""),
      billingBodyHash(body),
    ].join("\n"), "utf8")
    .digest("base64url");
}

function buildBillingRequestHeaders(token, method, pathname, managerId, body, now = Date.now()) {
  const normalizedManagerId = normalizeBillingManagerId(managerId);
  const normalizedPath = normalizeBillingPath(pathname);
  const timestamp = String(now);
  if (!token || !normalizedManagerId || !normalizedPath) return {};
  return {
    "content-type": "application/json",
    "accept": "application/json",
    [BILLING_MANAGER_HEADER]: normalizedManagerId,
    [BILLING_TIMESTAMP_HEADER]: timestamp,
    [BILLING_SIGNATURE_HEADER]: signBillingRequest(token, method, normalizedPath, normalizedManagerId, timestamp, body),
    [BILLING_VERSION_HEADER]: "1",
  };
}

function verifyBillingRequest(req, rawBody, token, options = {}) {
  const socketAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  if (!isLocalAddress(socketAddress)) return { ok: false, code: "billing_loopback_required" };
  const managerId = normalizeBillingManagerId(headerText(req?.headers || {}, BILLING_MANAGER_HEADER));
  const allowedManagers = new Set((options.allowedManagers || ["vllm-manager", "llama-manager"])
    .map(normalizeBillingManagerId)
    .filter(Boolean));
  if (!managerId || !allowedManagers.has(managerId)) return { ok: false, code: "billing_manager_not_allowed" };
  const pathname = normalizeBillingPath(options.pathname || req?.url || "");
  const timestamp = headerText(req?.headers || {}, BILLING_TIMESTAMP_HEADER);
  const signature = headerText(req?.headers || {}, BILLING_SIGNATURE_HEADER);
  const version = headerText(req?.headers || {}, BILLING_VERSION_HEADER);
  if (!token || !pathname || !timestamp || !signature || version !== "1") {
    return { ok: false, code: "billing_signature_missing" };
  }
  const issuedAt = Number(timestamp);
  const now = Number(options.now ?? Date.now());
  const maxSkewMs = Math.max(1000, Number(options.maxSkewMs ?? DEFAULT_BILLING_MAX_SKEW_MS));
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > maxSkewMs) {
    return { ok: false, code: "billing_signature_expired" };
  }
  const expected = signBillingRequest(token, req?.method || "POST", pathname, managerId, timestamp, rawBody);
  if (!safeEqualText(signature, expected)) return { ok: false, code: "billing_signature_invalid" };
  return { ok: true, managerId };
}

function normalizeBillingBaseUrl(value) {
  const text = String(value || DEFAULT_BILLING_BASE_URL).trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Billing service URL is invalid.");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)) {
    throw new Error("Billing service must use an HTTP loopback URL.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error("Billing service URL must not contain credentials, a path, a query, or a fragment.");
  }
  return parsed.origin;
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

function createBillingClient(options = {}) {
  const managerId = normalizeBillingManagerId(options.managerId);
  if (!managerId) throw new Error("A valid billing manager id is required.");
  const baseUrl = normalizeBillingBaseUrl(options.baseUrl || process.env.AI_BILLING_BASE_URL || DEFAULT_BILLING_BASE_URL);
  const timeoutMs = boundedBillingTimeout(options.timeoutMs ?? process.env.AI_BILLING_TIMEOUT_MS);
  const readToken = options.readToken || createGatewayTrustReader({
    root: options.root,
    file: options.trustFile,
    cacheTtlMs: 0,
  });
  const fetchFn = options.fetchFn || ((...args) => fetch(...args));

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
      const token = String(readToken() || "").trim();
      if (!token) {
        lastResult = {
          ok: false,
          allowed: false,
          status: 503,
          code: "billing_unavailable",
          message: "Billing trust is unavailable.",
        };
      } else {
        try {
          const response = await fetchFn(`${baseUrl}${normalizedPath}`, {
            method: "POST",
            headers: buildBillingRequestHeaders(token, "POST", normalizedPath, managerId, body),
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = await response.text();
          let data = null;
          try { data = text ? JSON.parse(text) : {}; } catch {}
          lastResult = normalizeBillingResponse(data, response, "billing_rejected");
          if (response.status < 500 || attempt === attempts) return lastResult;
        } catch (error) {
          lastResult = {
            ok: false,
            allowed: false,
            status: 503,
            code: "billing_unavailable",
            message: error?.name === "TimeoutError" ? "Billing service timed out." : "Billing service is unavailable.",
          };
        }
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
