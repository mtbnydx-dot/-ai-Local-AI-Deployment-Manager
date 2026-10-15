"use strict";

// Access routes (docs/overhaul/05-public.md §13.1), mounted by one line in the
// entry's route-mount table. PUB-10 serves the internal endpoints the
// managers call; the owner's /api/access/* and /api/public/* rows are added
// here by the later access packages.
//
//   POST   /internal/access/verify                          {keyHash, kind?} -> verify answer (§7.2)
//   GET    /internal/access/legacy-clients                  -> {version, updatedAt, clients:[redacted]}
//   POST   /internal/access/legacy-clients                  legacy client input -> {ok, apiKey, client}
//   PATCH  /internal/access/legacy-clients/:clientId        -> {ok, client}
//   POST   /internal/access/legacy-clients/:clientId/rotate -> {ok, apiKey, client}
//   DELETE /internal/access/legacy-clients/:clientId        -> {ok, removed, id} (revokes; §6.8)
//   PUT    /internal/access/legacy-global                   {keyHash, preview, limits} -> {ok, keyId}
//   DELETE /internal/access/legacy-global                   -> {ok, removed}
//
// Every call is a manager-form internal request (manager-core/internal-auth.js):
// loopback only, signed by a manager billing id, which also names the manager
// whose legacy keys the call may touch. The plaintext of an existing key never
// crosses the hop; created and rotated secrets are returned once to the
// manager UI that asked, exactly as the legacy routes did.

const internalAuth = require("../../manager-core/internal-auth");
const servicePolicy = require("../../manager-core/service-policy");
const keyPolicy = require("./key-policy");
const { LEGACY_SCOPES, listStoreKeys } = require("./key-migration");
const { hopPrincipal, keyMayUseManager } = require("./gateway-pipeline");

const OWNER = "05";
const ACCESS_INTERNAL_PREFIX = "/internal/access/";
const VERIFY_PATH = "/internal/access/verify";
const LEGACY_CLIENTS_PATH = "/internal/access/legacy-clients";
const LEGACY_GLOBAL_PATH = "/internal/access/legacy-global";
const LEGACY_CLIENT_RE = /^\/internal\/access\/legacy-clients\/([^/]+)(\/rotate)?$/;
const MAX_BODY_BYTES = 64 * 1024;
const KEY_HASH_RE = /^[a-f0-9]{64}$/;
const SOURCE_CLIENTS = "service-clients";
const SOURCE_GLOBAL = "service-exposure";
const LEGACY_LISTENERS = Object.freeze(["public", "admin"]);
const ACTOR = "legacy-manager-ui";
// What a direct manager call of each gateway kind needs (any one of them).
const DIRECT_KIND_SCOPES = Object.freeze({
  openai: ["chat", "completions", "responses", "embeddings"],
  opencode: ["chat", "completions", "responses"],
  claude: ["messages"],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function routeError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseBody(raw) {
  if (!raw || !raw.length) return {};
  let data = null;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    data = null;
  }
  if (!isPlainObject(data)) throw routeError(400, "invalid_request", "Request body must be a JSON object.");
  return data;
}

function decodeClientId(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    throw routeError(400, "invalid_request", "The client id is not valid.");
  }
}

// The legacy slug rule of uniqueServiceClientId (service-policy.js).
function clientSlug(value) {
  return String(value || "client")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "client";
}

// The legacy "all models" was an empty list; the store says ["*"].
function legacyModelsToKey(allowedModels) {
  const items = servicePolicy.normalizeCsvList(allowedModels)
    .filter((item) => item.length <= 200 && !/\s/.test(item) && item !== "!");
  if (!items.length || items.includes("*")) return ["*"];
  return [...new Set(items)];
}

function legacyLimitsToKey(client, current = {}) {
  return {
    ...current,
    rpm: Math.round(client.rateLimitRpm),
    tpm: current.tpm ?? null,
    maxConcurrent: Math.round(client.maxConcurrentRequests),
    maxQueued: Math.round(client.maxQueuedRequests),
    queueTimeoutSeconds: Math.round(client.queueTimeoutSeconds),
    requestTimeoutSeconds: Math.round(client.requestTimeoutSeconds),
    dailyTokens: current.dailyTokens ?? null,
    monthlyTokens: current.monthlyTokens ?? null,
    dailyRequests: current.dailyRequests ?? null,
    maxOutputTokens: current.maxOutputTokens ?? null,
  };
}

// The redacted legacy client of a store key, through the legacy normalizer,
// so the manager UI gets exactly the fields and defaults it always got.
function legacyClientFromKey(key) {
  const legacy = isPlainObject(key.legacy) ? key.legacy : {};
  const limits = isPlainObject(key.limits) ? key.limits : {};
  const models = Array.isArray(key.models) ? key.models : [];
  const client = servicePolicy.normalizeServiceClient({
    id: legacy.clientId || key.id,
    name: key.name,
    enabled: key.status === "active",
    keyPreview: key.preview,
    allowedModels: models.length === 1 && models[0] === "*" ? [] : models,
    rateLimitRpm: limits.rpm ?? undefined,
    maxConcurrentRequests: limits.maxConcurrent ?? undefined,
    maxQueuedRequests: limits.maxQueued ?? undefined,
    queueTimeoutSeconds: limits.queueTimeoutSeconds ?? undefined,
    requestTimeoutSeconds: limits.requestTimeoutSeconds ?? undefined,
    expiresAt: key.expiresAt || "",
    notes: key.notes || "",
    createdAt: key.createdAt,
    updatedAt: key.updatedAt || key.createdAt,
    lastUsedAt: key.lastUsedAt || legacy.lastUsedAt || null,
    usage: legacy.usage,
  });
  return servicePolicy.redactServiceClient(client);
}

// The key fields a legacy client input maps to (create and update share it).
function keyFieldsFromLegacy(client, current = null) {
  const fields = {
    name: client.name,
    status: client.enabled === false ? "disabled" : "active",
    models: legacyModelsToKey(client.allowedModels),
    limits: legacyLimitsToKey(client, current?.limits || {}),
    expiresAt: client.expiresAt || null,
    notes: client.notes || null,
  };
  return fields;
}

/**
 * createAccessRoutes(deps) -> { handle(req, res, url) -> Promise<boolean> }
 *   getAccessStore   () -> the keys store (throws while it is unavailable)
 *   getManagers      () -> [{ id, billingId }]
 *   getTrustToken    () -> the entry's in-memory trust token
 *   readRequestBody  (req, maxBytes) -> Buffer|undefined
 *   sendJson         (res, body, status)
 */
function createAccessRoutes(deps = {}) {
  const { getAccessStore, getManagers, getTrustToken, readRequestBody, sendJson } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  for (const [name, value] of Object.entries({ getAccessStore, getManagers, getTrustToken, readRequestBody, sendJson })) {
    if (typeof value !== "function") throw new Error(`access-routes: ${name} is missing`);
  }

  function managers() {
    return (getManagers() || [])
      .filter((manager) => manager?.id)
      .map((manager) => ({ id: String(manager.id), billingId: String(manager.billingId || `${manager.id}-manager`).toLowerCase() }));
  }

  function storeOrThrow() {
    try {
      const store = getAccessStore();
      if (!store) throw new Error("no store");
      return store;
    } catch {
      throw routeError(503, "key_store_unavailable", "The platform key store is unavailable.");
    }
  }

  // The keys a manager's legacy routes own: its migrated or forwarded
  // clients (or its global key), revoked ones excluded as a deleted client was.
  function legacyKeys(store, manager, source) {
    return listStoreKeys(store).filter((key) => key.status !== "revoked"
      && isPlainObject(key.legacy)
      && key.legacy.managerId === manager.id
      && key.legacy.source === source);
  }

  function findLegacyClient(store, manager, clientId) {
    return legacyKeys(store, manager, SOURCE_CLIENTS).find((key) => String(key.legacy.clientId) === clientId) || null;
  }

  // POST /internal/access/verify (§7.2): a direct manager call's key, by hash.
  // A verdict is always 200 with ok true or false; only a malformed request
  // is a 4xx, so the manager can tell "no" from "cannot ask".
  function verify(store, manager, body) {
    const keyHash = String(body.keyHash || "").trim().toLowerCase();
    if (!KEY_HASH_RE.test(keyHash)) throw routeError(400, "invalid_request", "keyHash must be 64 hex characters.");
    const found = store.findByHash(keyHash);
    if (!found) return { ok: false, code: "invalid_api_key" };
    const key = found.key;
    const verdict = keyPolicy.evaluateKey(key, { now: now() });
    if (!verdict.ok) return { ok: false, code: verdict.code };
    if (!keyMayUseManager(key, manager.id)) return { ok: false, code: "manager_forbidden" };
    const kindScopes = DIRECT_KIND_SCOPES[String(body.kind || "")];
    if (kindScopes && !kindScopes.some((scope) => (key.scopes || []).includes(scope))) {
      return { ok: false, code: "scope_denied" };
    }
    const limits = isPlainObject(key.limits) ? key.limits : {};
    return {
      ok: true,
      keyId: key.id,
      principal: { ...hopPrincipal({ ok: true, kind: "key", key }, "admin"), l: "direct" },
      models: Array.isArray(key.models) ? key.models : [],
      fleetAllow: Array.isArray(key.fleetAllow) ? key.fleetAllow : [],
      limits: {
        maxConcurrent: limits.maxConcurrent ?? null,
        rpm: limits.rpm ?? null,
        maxOutputTokens: limits.maxOutputTokens ?? null,
        maxQueued: limits.maxQueued ?? null,
        queueTimeoutSeconds: limits.queueTimeoutSeconds ?? null,
        requestTimeoutSeconds: limits.requestTimeoutSeconds ?? null,
      },
      expiresAt: key.expiresAt || null,
    };
  }

  function listLegacyClients(store, manager) {
    const keys = legacyKeys(store, manager, SOURCE_CLIENTS);
    const updatedAt = keys.reduce((latest, key) => (key.updatedAt && key.updatedAt > latest ? key.updatedAt : latest), "") || null;
    return { version: 1, updatedAt, clients: keys.map(legacyClientFromKey) };
  }

  // A created client gets key_id <managerId>.<slug>, the legacy billing
  // principal (<billingId>, <slug>) and TTS owner <managerId>:<slug> (§6.4,
  // §6.8). The slug follows the legacy rule and skips ids, billing
  // principals and legacy client ids already taken, revoked keys included.
  function createLegacyClient(store, manager, body) {
    const name = String(body.name || "Local service client").slice(0, 80);
    const client = servicePolicy.normalizeServiceClient({ ...body, id: "input", name });
    const base = clientSlug(body.id || name);
    const taken = new Set(listStoreKeys(store)
      .filter((key) => isPlainObject(key.legacy) && key.legacy.managerId === manager.id)
      .map((key) => String(key.legacy.clientId || "")));
    for (let index = 1; index < 1000; index += 1) {
      const slug = index === 1 ? base : `${base}-${index}`;
      const keyId = `${manager.id}.${slug}`;
      if (taken.has(slug) || store.getKey(keyId)) continue;
      try {
        const { key, secret } = store.createKey({
          ...keyFieldsFromLegacy(client),
          id: keyId,
          class: "friend",
          scopes: [...LEGACY_SCOPES],
          fleetAllow: [`${manager.id}:*`],
          listeners: [...LEGACY_LISTENERS],
          billing: { scope: manager.billingId, clientId: slug },
          ttsOwner: `${manager.id}:${slug}`,
          legacy: { managerId: manager.id, clientId: slug, source: SOURCE_CLIENTS },
        }, { actor: ACTOR });
        return { ok: true, apiKey: secret, client: legacyClientFromKey(key) };
      } catch (error) {
        if (error?.code === "key_conflict") continue;
        throw error;
      }
    }
    throw routeError(409, "key_conflict", "Could not allocate a unique client id.");
  }

  function updateLegacyClient(store, manager, clientId, body) {
    const current = findLegacyClient(store, manager, clientId);
    if (!current) throw routeError(404, "client_not_found", "Service client not found.");
    const previous = servicePolicy.normalizeServiceClient({ ...legacyClientFromKey(current), id: clientId });
    const merged = servicePolicy.normalizeServiceClient({ ...previous, ...body, id: clientId });
    const key = store.updateKey(current.id, keyFieldsFromLegacy(merged, current), { actor: ACTOR });
    return { ok: true, client: legacyClientFromKey(key) };
  }

  function rotateLegacyClient(store, manager, clientId) {
    const current = findLegacyClient(store, manager, clientId);
    if (!current) throw routeError(404, "client_not_found", "Service client not found.");
    const { key, secret } = store.rotateKey(current.id, { actor: ACTOR, overlapSeconds: 0 });
    return { ok: true, apiKey: secret, client: legacyClientFromKey(key) };
  }

  // DELETE maps to revoke (§6.8): no hard delete exists. Unknown ids answer
  // removed: 0, as the legacy ledger did.
  function deleteLegacyClient(store, manager, clientId) {
    const current = findLegacyClient(store, manager, clientId);
    if (!current) return { ok: true, removed: 0, id: clientId };
    store.revokeKey(current.id, { actor: ACTOR, reason: "legacy client deleted" });
    return { ok: true, removed: 1, id: clientId };
  }

  // The global key of a manager's /api/service-exposure, as <managerId>.global
  // (§6.7, §6.8). Setting a new key revokes the previous one; the record
  // carries the hash the manager computed, never the plaintext.
  function setLegacyGlobal(store, manager, body) {
    const keyHash = String(body.keyHash || "").trim().toLowerCase();
    if (!KEY_HASH_RE.test(keyHash)) throw routeError(400, "invalid_request", "keyHash must be 64 hex characters.");
    const existing = store.findByHash(keyHash);
    if (existing) {
      const legacy = isPlainObject(existing.key.legacy) ? existing.key.legacy : {};
      if (existing.key.status !== "revoked" && legacy.source === SOURCE_GLOBAL && legacy.managerId === manager.id) {
        return { ok: true, keyId: existing.key.id, unchanged: true };
      }
      throw routeError(409, "key_hash_exists", "This key is already used by another key.");
    }
    const billingClientId = `global-${keyHash.slice(0, 24)}`;
    const limitInput = servicePolicy.normalizeServiceClient({ ...(isPlainObject(body.limits) ? body.limits : {}), id: "limits" });
    const naturalId = `${manager.id}.global`;
    const keyId = store.getKey(naturalId) ? `${manager.id}.global-${keyHash.slice(0, 8)}` : naturalId;
    for (const key of legacyKeys(store, manager, SOURCE_GLOBAL)) {
      store.revokeKey(key.id, { actor: ACTOR, reason: "legacy global key replaced" });
    }
    const preview = String(body.preview || "").slice(0, 64) || undefined;
    const result = store.importKeys([{
      id: keyId,
      name: `Global key (${manager.id})`,
      status: "active",
      class: "owner",
      scopes: [...LEGACY_SCOPES],
      models: ["*"],
      fleetAllow: [`${manager.id}:*`],
      listeners: [...LEGACY_LISTENERS],
      limits: legacyLimitsToKey(limitInput),
      billing: { scope: manager.billingId, clientId: billingClientId },
      ttsOwner: `${manager.id}:${billingClientId}`,
      legacy: { managerId: manager.id, clientId: billingClientId, source: SOURCE_GLOBAL },
      keyHash,
      ...(preview ? { preview } : {}),
    }], { actor: ACTOR });
    if (!result.inserted.includes(keyId)) {
      throw routeError(409, String(result.skipped?.[0]?.reason || "key_conflict"), "The global key could not be stored.");
    }
    return { ok: true, keyId };
  }

  function clearLegacyGlobal(store, manager) {
    const keys = legacyKeys(store, manager, SOURCE_GLOBAL);
    for (const key of keys) store.revokeKey(key.id, { actor: ACTOR, reason: "legacy global key cleared" });
    return { ok: true, removed: keys.length };
  }

  function dispatch(method, pathname, store, manager, body) {
    if (pathname === VERIFY_PATH) return method === "POST" ? verify(store, manager, body) : null;
    if (pathname === LEGACY_CLIENTS_PATH) {
      if (method === "GET") return listLegacyClients(store, manager);
      if (method === "POST") return createLegacyClient(store, manager, body);
      return null;
    }
    if (pathname === LEGACY_GLOBAL_PATH) {
      if (method === "PUT") return setLegacyGlobal(store, manager, body);
      if (method === "DELETE") return clearLegacyGlobal(store, manager);
      return null;
    }
    const match = LEGACY_CLIENT_RE.exec(pathname);
    if (!match) return null;
    const clientId = decodeClientId(match[1]);
    if (match[2]) return method === "POST" ? rotateLegacyClient(store, manager, clientId) : null;
    if (method === "PATCH") return updateLegacyClient(store, manager, clientId, body);
    if (method === "DELETE") return deleteLegacyClient(store, manager, clientId);
    return null;
  }

  function knownRoute(pathname) {
    return pathname === VERIFY_PATH || pathname === LEGACY_CLIENTS_PATH || pathname === LEGACY_GLOBAL_PATH
      || LEGACY_CLIENT_RE.test(pathname);
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith(ACCESS_INTERNAL_PREFIX)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      if (!knownRoute(url.pathname)) throw routeError(404, "not_found", "Not found.");
      let raw;
      try {
        raw = await readRequestBody(req, MAX_BODY_BYTES);
      } catch (error) {
        throw routeError(error?.status === 413 ? 413 : 400, error?.status === 413 ? "request_too_large" : "invalid_request", "The request body could not be read.");
      }
      const known = managers();
      const verified = internalAuth.verifyInternalRequest(req, raw, getTrustToken(), {
        pathname: url.pathname,
        pathPrefixes: [ACCESS_INTERNAL_PREFIX],
        allowedManagers: known.map((manager) => manager.billingId),
        now: now(),
      });
      if (!verified.ok) throw routeError(401, verified.code || "internal_signature_invalid", "Internal request authentication failed.");
      const manager = known.find((item) => item.billingId === verified.managerId);
      const named = String(url.searchParams.get("managerId") || "").trim().toLowerCase();
      if (!manager || (named && named !== manager.billingId && named !== manager.id)) {
        throw routeError(403, "internal_manager_mismatch", "The signed manager does not match the request.");
      }
      const body = parseBody(raw);
      const store = storeOrThrow();
      const result = dispatch(method, url.pathname, store, manager, body);
      if (!result) throw routeError(405, "method_not_allowed", "Method not allowed.");
      sendJson(res, result, 200);
    } catch (error) {
      const status = Number(error?.status || 500);
      const safe = status >= 400 && status < 600 && error?.code;
      sendJson(res, {
        ok: false,
        code: safe ? String(error.code) : "access_error",
        message: safe ? String(error.message || "") : "The access request failed.",
        ...(Array.isArray(error?.errors) && error.errors.length ? { errors: error.errors } : {}),
      }, safe ? status : 500);
    }
    return true;
  }

  return { handle };
}

// Route-module entry point (server.js ROUTE_MODULES).
function mount(ctx = {}) {
  const security = ctx.security || {};
  return createAccessRoutes({
    getAccessStore: ctx.getAccessStore,
    getManagers: () => ctx.managers || [],
    getTrustToken: () => (typeof security.getTrustToken === "function" ? security.getTrustToken() : ""),
    readRequestBody: ctx.readRequestBody,
    sendJson: ctx.sendJson,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
}

module.exports = {
  ACCESS_INTERNAL_PREFIX,
  LEGACY_CLIENTS_PATH,
  LEGACY_GLOBAL_PATH,
  OWNER,
  VERIFY_PATH,
  createAccessRoutes,
  legacyClientFromKey,
  mount,
  name: "access",
};
