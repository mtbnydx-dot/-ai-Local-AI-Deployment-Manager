"use strict";

// Calls from the supervisor and the CLI to the entry as machine principals
// (06 §5.16, 00 §9.7). Every call is signed with the machine form of
// manager-core/internal-auth.js (method, path with query, principal,
// timestamp, sha256(body)); no bare marker header is ever sent. The HMAC key
// is the entry trust token that internal-auth reads, and a 401 re-reads it
// once, because a restarted entry mints a new one.
//
// Without the key (a pre-PUB-5 entry, or the token is unreadable) GET probes
// go unsigned, a shutdown POST is tried once unsigned and logged as
// entry_shutdown_unsigned, and every other write fails with
// internal_key_unavailable so the caller can degrade (pairing prints the hint).

const internalAuth = require("../internal-auth");

const ENTRY_PRINCIPALS = Object.freeze(["system:supervisor", "system:cli"]);
const SHUTDOWN_PATHS = Object.freeze(["/api/manager/shutdown", "/api/shutdown"]);
const DEFAULT_TIMEOUT_MS = 5000;

function keyUnavailable(error) {
  return error?.code === "internal_key_unavailable";
}

/**
 * createEntryClient({ aiRoot, principal, baseUrl, fetch, now, readKey, log })
 * -> { principal, baseUrl, request(method, path, { body, timeoutMs }) -> {status, json, signed},
 *      events(types, onEnvelope, { client, onError, retryMs }) -> { close() } }
 */
function createEntryClient(options = {}) {
  const principal = String(options.principal || "");
  if (!ENTRY_PRINCIPALS.includes(principal)) throw new Error("The entry client signs as system:supervisor or system:cli.");
  const baseUrl = internalAuth.normalizeInternalBaseUrl(options.baseUrl || internalAuth.DEFAULT_INTERNAL_BASE_URL, { label: "Service entry" });
  const fetchImpl = options.fetch || ((...args) => fetch(...args));
  const log = typeof options.log === "function" ? options.log : () => {};
  // One signing client per timeout; internal-auth fixes the timeout per client.
  const clients = new Map();

  function signer(timeoutMs) {
    const key = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    if (!clients.has(key)) {
      clients.set(key, internalAuth.createInternalClient({
        aiRoot: options.aiRoot, baseUrl, principal, timeoutMs: key, fetchFn: fetchImpl, readKey: options.readKey,
        trustFile: options.trustFile,
      }));
    }
    return clients.get(key);
  }

  async function unsigned(method, target, body, timeoutMs) {
    const payload = body === undefined || body === null ? undefined : JSON.stringify(body);
    const response = await fetchImpl(`${baseUrl}${target}`, {
      method,
      headers: { accept: "application/json", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      body: payload,
      signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
    });
    const text = await response.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, json, signed: false };
  }

  async function request(method, pathWithQuery, requestOptions = {}) {
    const verb = String(method || "GET").toUpperCase();
    const target = String(pathWithQuery || "");
    const { body, timeoutMs = DEFAULT_TIMEOUT_MS } = requestOptions || {};
    try {
      const result = await signer(timeoutMs).request(verb, target, body);
      return { ...result, signed: true };
    } catch (error) {
      if (!keyUnavailable(error)) throw error;
      const pathname = target.split("?")[0];
      if (verb === "GET" || verb === "HEAD") return unsigned(verb, target, undefined, timeoutMs);
      if (verb === "POST" && SHUTDOWN_PATHS.includes(pathname)) {
        // Works on a pre-PUB-5 entry. A PUB-5 entry answers 401 and the
        // launcher falls through to its identity-checked kill.
        log({ code: "entry_shutdown_unsigned", path: pathname, principal });
        return unsigned(verb, target, body, timeoutMs);
      }
      throw error;
    }
  }

  // GET /api/events?client=<client>&types=a,b as one signed SSE subscription
  // with 1 s -> 30 s backoff; each envelope is the parsed `data` of an event.
  function events(types, onEnvelope, eventOptions = {}) {
    if (typeof onEnvelope !== "function") throw new TypeError("events() needs an envelope callback.");
    const query = new URLSearchParams();
    if (eventOptions.client) query.set("client", String(eventOptions.client));
    const list = (Array.isArray(types) ? types : String(types || "").split(",")).map((type) => String(type).trim()).filter(Boolean);
    if (list.length) query.set("types", list.join(","));
    const target = `/api/events${query.toString() ? `?${query.toString().replace(/%2C/gi, ",")}` : ""}`;
    return signer(DEFAULT_TIMEOUT_MS).sse(target, (event) => {
      if (!event || event.data === null || typeof event.data !== "object") return;
      onEnvelope({ ...event.data, ...(event.id !== null && event.id !== undefined ? { id: event.id } : {}) });
    }, { retryMs: eventOptions.retryMs, maxRetryMs: eventOptions.maxRetryMs, onError: eventOptions.onError, onOpen: eventOptions.onOpen });
  }

  return { principal, baseUrl, request, events };
}

module.exports = { ENTRY_PRINCIPALS, createEntryClient };
