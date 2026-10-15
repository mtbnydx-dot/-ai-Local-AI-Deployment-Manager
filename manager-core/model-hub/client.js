"use strict";

// The managers' signed client for the entry's hub routes (03 §15).
//
// Every call is signed by manager-core/internal-auth.js in the machine form as
// principal system:hub-shim:<managerId>: the HMAC covers the method, the path
// with its query, the principal (which names the manager), the timestamp and
// sha256(body), and the key is the entry trust token read per call. There is
// no unauthenticated marker header. Each call carries x-request-id
// (propagated, or a fresh mgr_ id) and a timeout: 10 s, 1.5 s for job lists.
//
// Failures come back as a HubClientError with a legacy code: an unreachable
// entry (or no trust token yet) is hub_unavailable, a rejected signature is
// hub_auth_failed. The client never falls back to anything; the shim decides.

const defaultInternalAuth = require("../internal-auth");
const { newDirectRequestId, normalizeClientRequestId } = require("../telemetry/ids");

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_LIST_TIMEOUT_MS = 1500;
const JOB_LIST_LIMIT = 60;
const AUTH_LOG_INTERVAL_MS = 60 * 1000;
const MANAGER_IDS = Object.freeze(["vllm", "llama"]);

const COPY = Object.freeze({
  hub_unavailable: { zh: "统一入口未运行", en: "service-entry is not running" },
  hub_auth_failed: { zh: "统一入口拒绝了管理器的签名，请重启平台", en: "service-entry rejected the manager's signature; restart the platform" },
});

class HubClientError extends Error {
  constructor(code, status = 503) {
    const copy = COPY[code] || COPY.hub_unavailable;
    super(`${copy.zh} / ${copy.en}`);
    this.name = "HubClientError";
    this.code = code;
    this.status = status;
  }
}

function hubShimPrincipal(managerId) {
  return `system:hub-shim:${managerId}`;
}

function requestIdOf(value) {
  return normalizeClientRequestId(value) || newDirectRequestId();
}

/**
 * createHubClient({ baseUrl, managerId, internalAuth, timeoutMs }) →
 * { managerId, principal, request, listJobs, subscribeDownloads }.
 * Test seams: fetchFn, readKey, aiRoot, listTimeoutMs, logger, clock.
 */
function createHubClient(options = {}) {
  const managerId = String(options.managerId || "");
  if (!MANAGER_IDS.includes(managerId)) throw new Error("A hub client needs managerId \"vllm\" or \"llama\".");
  const internalAuth = options.internalAuth || defaultInternalAuth;
  const principal = hubShimPrincipal(managerId);
  const logger = options.logger || console;
  const clock = options.clock || Date;
  const common = {
    principal,
    baseUrl: options.baseUrl,
    aiRoot: options.aiRoot,
    trustFile: options.trustFile,
    readKey: options.readKey,
    fetchFn: options.fetchFn,
  };
  const client = internalAuth.createInternalClient({ ...common, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
  const listClient = internalAuth.createInternalClient({ ...common, timeoutMs: options.listTimeoutMs || DEFAULT_LIST_TIMEOUT_MS });
  let lastAuthLogAt = -Infinity;

  function logAuthFailure() {
    const now = clock.now();
    if (now - lastAuthLogAt < AUTH_LOG_INTERVAL_MS) return;
    lastAuthLogAt = now;
    try {
      logger.warn?.(`[hub-shim] service-entry rejected the ${managerId} manager's signature (hub_auth_failed); restart the platform.`);
    } catch {
      // Logging never breaks a request.
    }
  }

  async function send(target, method, pathWithQuery, body, requestOptions = {}) {
    let result;
    try {
      result = await target.request(method, pathWithQuery, body, {
        headers: { "x-request-id": requestIdOf(requestOptions.requestId) },
      });
    } catch {
      // Transport, timeout, no trust key yet, or a refused path: the entry
      // cannot serve this call. The cause never carries a token.
      throw new HubClientError("hub_unavailable");
    }
    // The internal client already re-read the key and retried once.
    if (result.status === 401) {
      logAuthFailure();
      throw new HubClientError("hub_auth_failed");
    }
    return result;
  }

  /** One signed call: { status, json }; throws HubClientError. */
  function request(method, pathWithQuery, body, requestOptions = {}) {
    return send(client, String(method || "GET").toUpperCase(), pathWithQuery, body, requestOptions);
  }

  /** This manager's downloads for the legacy job list (03 §15): { status, json }. */
  function listJobs(requestOptions = {}) {
    const query = new URLSearchParams({ owner: managerId, include: "terminal", limit: String(JOB_LIST_LIMIT) });
    return send(listClient, "GET", `/api/hub/downloads?${query}`, undefined, requestOptions);
  }

  /**
   * The one signed upstream SSE (03 §15): GET /api/events?types=downloads,
   * reconnecting with backoff 1–30 s. Returns { close() }.
   */
  function subscribeDownloads(onEvent, sseOptions = {}) {
    return client.sse("/api/events?types=downloads", onEvent, {
      retryMs: sseOptions.retryMs,
      maxRetryMs: sseOptions.maxRetryMs,
      onOpen: sseOptions.onOpen,
      onError: (error) => {
        if (error?.status === 401) logAuthFailure();
        try { sseOptions.onError?.(error); } catch {}
      },
    });
  }

  return { managerId, principal, request, listJobs, subscribeDownloads };
}

module.exports = {
  DEFAULT_LIST_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  HubClientError,
  JOB_LIST_LIMIT,
  createHubClient,
  hubShimPrincipal,
};
