"use strict";

// Terminal state and error taxonomy for gateway requests (04 §5.4).
//
// classifyOutcome({ phase, status, code, upstreamErrorText, aborted,
// timedOut, streamError }) → { terminalState, errorClass, errorCode }
//
// `phase` is where the request ended: "pre_upstream" (refused by the entry
// or the manager before any upstream call), "upstream" (the upstream call or
// its non-2xx answer) or "stream" (after 2xx headers). `code` is the machine
// code of the refusal or of the upstream error body (`error.code` or
// `error.type`). Rules are checked in table order and the first match wins.
//
// `upstreamErrorText` is at most 4 KiB of a non-2xx upstream body. It is only
// matched against the context-overflow pattern; nothing returned here echoes
// it, and callers must not store it.

const TERMINAL_STATES = Object.freeze(["completed", "failed", "client_abort", "timeout", "rejected"]);

const ERROR_CLASSES = Object.freeze([
  "none",
  "client_abort",
  "upstream_timeout",
  "auth_failed",
  "auth_banned",
  "forbidden",
  "rate_limited",
  "quota_denied",
  "billing_unavailable",
  "no_runtime",
  "config_error",
  "context_overflow",
  "bad_request",
  "upstream_unreachable",
  "upstream_5xx",
  "stream_error",
  "internal",
]);

const ERROR_CODE_PATTERN = /^[a-z0-9_.-]{1,64}$/;
const UPSTREAM_ERROR_TEXT_LIMIT = 4096;
const CONTEXT_OVERFLOW_PATTERN = /maximum context|context length|too many tokens|prompt is too long|exceeds .*context/i;

const TIMEOUT_CODES = new Set(["request_timeout", "timed_out", "und_err_headers_timeout", "und_err_body_timeout"]);
const AUTH_FAILED_CODES = new Set(["unauthorized", "invalid_api_key"]);
const FORBIDDEN_CODES = new Set([
  "manager_forbidden", "model_forbidden", "origin_not_allowed", "local_only", "scope_forbidden",
  "tts_model_management_local_only",
]);
const RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded", "concurrency_queue_timeout", "concurrency_queue_full", "tpm_limit_exceeded",
  "concurrency_limit_exceeded",
]);
// Billing quota codes (gateway-utils billingGatewayRejection) and the TTS
// allowance codes (billing-store authorizeTtsRequest), answered with 402/429.
const QUOTA_CODES = new Set([
  "billing_quota_exhausted", "billing_insufficient_balance", "insufficient_quota",
  "request_limit_exceeded", "token_limit_exceeded", "spend_limit_exceeded",
  "billing_period_credit_limit", "billing_period_token_limit", "billing_period_request_limit",
  "billing_tts_daily_limit", "billing_customer_inactive", "billing_plan_inactive", "billing_plan_missing",
]);
// Manager, model and fleet-selection failures (service-entry model-fleet.js).
// service_unavailable is what the entry and managers answer today when the
// manager port or the model service is down.
const NO_RUNTIME_CODES = new Set([
  "manager_offline", "tts_gateway_offline", "no_matching_model", "model_not_loaded", "fleet_settings_unavailable",
  "model_not_available", "capability_not_available", "instance_not_available", "service_unavailable",
]);
const CONFIG_ERROR_CODES = new Set([
  "api_key_not_configured", "key_store_unreadable", "price_not_configured", "billing_price_not_configured",
]);
// Failures to reach the upstream at all: fetch errors and refused connections.
const UNREACHABLE_CODES = new Set([
  "gateway_proxy_error", "tts_gateway_proxy_error", "fetch_failed", "econnrefused", "enotfound",
  "ehostunreach", "enetunreach", "eai_again", "econnreset", "und_err_connect_timeout", "und_err_socket",
]);
const BAD_REQUEST_STATUSES = new Set([400, 404, 405, 413, 415, 422]);

function normalizeCode(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  // A bare number is an HTTP status echoed in the body (vLLM sends "code": 400).
  return /^\d+$/.test(text) ? "" : text.slice(0, 128);
}

function statusClass(status) {
  const value = Number(status) || 0;
  if (value >= 200 && value < 600) return `${Math.floor(value / 100)}xx`;
  return "none";
}

function outcome(terminalState, errorClass, code) {
  if (errorClass === "none") return { terminalState, errorClass, errorCode: null };
  return { terminalState, errorClass, errorCode: ERROR_CODE_PATTERN.test(code) ? code : errorClass };
}

function classifyOutcome(input = {}) {
  const phase = ["pre_upstream", "upstream", "stream"].includes(input.phase) ? input.phase : "upstream";
  const status = Number(input.status) || 0;
  const code = normalizeCode(input.code);
  const key = code.toLowerCase();
  const aborted = input.aborted === true || status === 499;
  const timedOut = input.timedOut === true;
  const streamError = Boolean(input.streamError);
  const text = String(input.upstreamErrorText || "").slice(0, UPSTREAM_ERROR_TEXT_LIMIT);
  const isTimeout = timedOut || status === 504 || TIMEOUT_CODES.has(key);

  if (!aborted && !timedOut && status > 0 && status < 400 && !streamError) return outcome("completed", "none", code);
  if (aborted && !isTimeout) return outcome("client_abort", "client_abort", code);
  if (isTimeout) return outcome("timeout", "upstream_timeout", code);
  if (status === 401 || AUTH_FAILED_CODES.has(key)) return outcome("rejected", "auth_failed", code);
  if (key === "auth_banned") return outcome("rejected", "auth_banned", code);
  if (FORBIDDEN_CODES.has(key)) return outcome("rejected", "forbidden", code);
  if (RATE_LIMIT_CODES.has(key)) return outcome("rejected", "rate_limited", code);
  if (status === 402 || (status === 429 && QUOTA_CODES.has(key))) {
    return outcome("rejected", "quota_denied", code);
  }
  if (key === "billing_unavailable") return outcome("rejected", "billing_unavailable", code);
  if (NO_RUNTIME_CODES.has(key)) return outcome("rejected", "no_runtime", code);
  if (CONFIG_ERROR_CODES.has(key)) return outcome("rejected", "config_error", code);
  // A 403 or 429 whose code the table does not list still counts by status.
  if (status === 403) return outcome("rejected", "forbidden", code);
  if (status === 429) return outcome("rejected", "rate_limited", code);
  if (status === 400 && (key === "context_length_exceeded" || CONTEXT_OVERFLOW_PATTERN.test(text))) {
    return outcome("failed", "context_overflow", code);
  }
  // The table names 400/404/405/413/415/422; any other 4xx is a bad request too.
  if (status >= 400 && status < 500) {
    return outcome(phase === "pre_upstream" ? "rejected" : "failed", "bad_request", code);
  }
  if (phase !== "stream" && UNREACHABLE_CODES.has(key)) return outcome("failed", "upstream_unreachable", code);
  if (status >= 500 && phase !== "pre_upstream") return outcome("failed", "upstream_5xx", code);
  if (streamError && status > 0 && status < 400) return outcome("failed", "stream_error", code);
  return outcome("failed", "internal", code);
}

module.exports = {
  TERMINAL_STATES,
  ERROR_CLASSES,
  statusClass,
  classifyOutcome,
};
