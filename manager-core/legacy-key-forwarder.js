"use strict";

// Legacy manager key routes as forwarders to the platform key store
// (docs/overhaul/05-public.md §6.8, §7.2).
//
// The manager UIs keep /api/service-clients* and the global key of
// /api/service-exposure, but the keys live in the entry's store. Every call
// here is a signed manager-form request (manager-core/internal-auth.js) to
// the entry's /internal/access/* endpoints, and every answer keeps the legacy
// shape the manager UIs read:
//   create / rotate  -> { ok, apiKey, client }
//   update           -> { ok, client }
//   list             -> { version, updatedAt, clients: [redacted] }
//   delete (revoke)  -> { ok, removed, id }
// The legacy files are never rewritten. When the entry cannot be reached the
// call fails with 503 key_store_unavailable instead of writing them.
//
// verifyAccessKey() is the direct-call key check of §7.2: the manager hashes
// the presented key and only the hash crosses the hop. Answers are cached for
// 5 s per hash.

const { createInternalClient } = require("./internal-auth");
const { hashServiceApiKey, previewServiceApiKey } = require("./service-policy");

const LEGACY_CLIENTS_PATH = "/internal/access/legacy-clients";
const LEGACY_GLOBAL_PATH = "/internal/access/legacy-global";
const VERIFY_PATH = "/internal/access/verify";
const DEFAULT_VERIFY_CACHE_MS = 5000;
const MAX_VERIFY_CACHE_ENTRIES = 1000;
const KEY_HASH_RE = /^[a-f0-9]{64}$/;

function forwarderError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function keyStoreUnavailable() {
  return forwarderError(503, "key_store_unavailable", "The platform key store is unavailable; try again when service-entry is running.");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createLegacyKeyForwarder(options = {}) {
  const managerId = String(options.managerId || "").trim().toLowerCase();
  if (!managerId) throw new Error("A legacy key forwarder needs the manager's billing id.");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const verifyCacheMs = Math.max(0, Number(options.verifyCacheMs ?? DEFAULT_VERIFY_CACHE_MS));
  const client = options.internalClient || createInternalClient({
    managerId,
    aiRoot: options.aiRoot ?? options.root,
    baseUrl: options.baseUrl || process.env.AI_BILLING_BASE_URL || undefined,
    timeoutMs: options.timeoutMs,
    readKey: options.readKey,
    fetchFn: options.fetchFn,
  });
  const query = `?managerId=${encodeURIComponent(managerId)}`;
  const verifyCache = new Map();

  // One signed call. Transport failures and 5xx answers are the store being
  // unavailable; a 4xx answer is the entry's verdict and keeps its code.
  async function call(method, pathname, body) {
    let answer;
    try {
      answer = await client.request(method, `${pathname}${query}`, body);
    } catch {
      throw keyStoreUnavailable();
    }
    const status = Number(answer?.status || 0);
    const json = plainObject(answer?.json);
    if (status >= 200 && status < 300) return json;
    if (status >= 400 && status < 500 && status !== 401) {
      throw forwarderError(status, String(json.code || "invalid_request"), String(json.message || json.error || "The key request was rejected."));
    }
    throw keyStoreUnavailable();
  }

  function clientPath(id, suffix = "") {
    return `${LEGACY_CLIENTS_PATH}/${encodeURIComponent(String(id || ""))}${suffix}`;
  }

  async function getServiceClientsLedger() {
    const ledger = await call("GET", LEGACY_CLIENTS_PATH);
    return {
      version: 1,
      updatedAt: ledger.updatedAt || null,
      clients: Array.isArray(ledger.clients) ? ledger.clients : [],
    };
  }

  async function createServiceClient(input = {}) {
    const result = await call("POST", LEGACY_CLIENTS_PATH, plainObject(input));
    return { ok: true, apiKey: String(result.apiKey || ""), client: plainObject(result.client) };
  }

  async function updateServiceClient(id, input = {}) {
    const result = await call("PATCH", clientPath(id), plainObject(input));
    return { ok: true, client: plainObject(result.client) };
  }

  async function rotateServiceClientKey(id) {
    const result = await call("POST", clientPath(id, "/rotate"), {});
    return { ok: true, apiKey: String(result.apiKey || ""), client: plainObject(result.client) };
  }

  async function deleteServiceClient(id) {
    const result = await call("DELETE", clientPath(id));
    return { ok: true, removed: Number(result.removed || 0), id: String(result.id ?? id) };
  }

  // The global key of /api/service-exposure becomes <managerId>.global in the
  // store. Only its hash, display preview and the manager's limits are sent.
  async function setGlobalKey({ keyHash, preview, limits } = {}) {
    const hash = String(keyHash || "").trim().toLowerCase();
    if (!KEY_HASH_RE.test(hash)) throw forwarderError(400, "invalid_request", "A global key hash is required.");
    const source = plainObject(limits);
    const carried = {};
    for (const field of ["rateLimitRpm", "maxConcurrentRequests", "maxQueuedRequests", "queueTimeoutSeconds", "requestTimeoutSeconds"]) {
      if (source[field] !== undefined) carried[field] = source[field];
    }
    return call("PUT", LEGACY_GLOBAL_PATH, { keyHash: hash, preview: String(preview || ""), limits: carried });
  }

  async function clearGlobalKey() {
    return call("DELETE", LEGACY_GLOBAL_PATH);
  }

  // The /api/service-exposure hook: a key set or cleared there is forwarded
  // before the manager saves its file; any other change is not a key change.
  async function forwardGlobalKey(body = {}, current = {}) {
    const input = plainObject(body);
    if (input.clearApiKey) return clearGlobalKey();
    const apiKey = String(input.apiKey ?? "").trim();
    if (!apiKey) return null;
    return setGlobalKey({
      keyHash: hashServiceApiKey(apiKey),
      preview: previewServiceApiKey(apiKey),
      limits: { ...plainObject(current), ...input },
    });
  }

  // POST /internal/access/verify. Returns the entry's answer; when the entry
  // cannot answer, { ok:false, code:"key_store_unavailable", unavailable:true }
  // so the caller can apply its mode's fallback (§7.2, §18).
  async function verifyAccessKey(keyHash, verifyOptions = {}) {
    const hash = String(keyHash || "").trim().toLowerCase();
    if (!KEY_HASH_RE.test(hash)) return { ok: false, code: "invalid_api_key" };
    const kind = String(verifyOptions.kind || "");
    const cacheKey = `${hash}\n${kind}`;
    const at = now();
    const cached = verifyCache.get(cacheKey);
    if (cached && at - cached.at < verifyCacheMs) return cached.answer;
    let answer;
    try {
      answer = await call("POST", VERIFY_PATH, { keyHash: hash, ...(kind ? { kind } : {}) });
    } catch (error) {
      if (error?.code === "key_store_unavailable") return { ok: false, code: "key_store_unavailable", unavailable: true };
      answer = { ok: false, code: String(error?.code || "invalid_api_key") };
    }
    if (verifyCacheMs > 0) {
      if (verifyCache.size >= MAX_VERIFY_CACHE_ENTRIES) verifyCache.clear();
      verifyCache.set(cacheKey, { at, answer });
    }
    return answer;
  }

  return {
    managerId,
    getServiceClientsLedger,
    createServiceClient,
    updateServiceClient,
    rotateServiceClientKey,
    deleteServiceClient,
    setGlobalKey,
    clearGlobalKey,
    forwardGlobalKey,
    verifyAccessKey,
  };
}

module.exports = {
  LEGACY_CLIENTS_PATH,
  LEGACY_GLOBAL_PATH,
  VERIFY_PATH,
  createLegacyKeyForwarder,
};
