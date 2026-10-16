"use strict";

// The shared gateway pipeline (docs/overhaul/05-public.md §8.1, §8.2, §5.8).
//
// ADMIN /gateway/* and the PUBLIC key routes run the same request flow here.
// It was extracted from server.js proxyGatewayRequest; server.js keeps the
// transport helpers (body reading, the hop headers, the telemetry record,
// the access log) and injects them as `io`, so this module owns the order of
// the checks and the policy, not the plumbing.
//
// Who the caller is, in order (§8.1):
//   1. an API-key header: the platform access store via
//      security.authorizeGatewayRequest (a key always wins over a cookie);
//   2. on ADMIN only, the owner's console session (`console-session`, §5.8):
//      a valid lai_admin owner session, CSRF on non-GET, a fixed scope set;
//   3. the keyless rules (exposure.requireApiKey; PUBLIC and forwarded
//      requests always need a key).
// PUBLIC deletes the cookie on receipt (public-listener.js), so step 2 can
// never happen there.
//
// The limiter (lib/limiter.js, 05 §9) runs inside it: the ban check before
// authentication, the rpm bucket after it, then (once the model is chosen) the
// tpm bucket and the quotas, and the public share gate before the upstream
// call. The public surface (public-api.js, PUB-12) adds alias resolution,
// the engineId / external routes and the key's max_tokens cap between the
// model choice and the limiter. The usage tap (usage-tap.js, PUB-11) reads the usage out of the
// response on its way to the client and settles the tpm reservation, adds the
// key's counters once and records who used what (step 15); the hop v2
// principal (PUB-10) is hopPrincipal below.

const crypto = require("node:crypto");
const core = require("../../manager-core");
const keyPolicy = require("./key-policy");
const { createLimiter } = require("./limiter");
const modelFleet = require("./model-fleet");
const { applyOutputCap } = require("./public-api");
const { hasApiKeyHeader, lookupPublicError, sendPublicError } = require("./public-errors");
const { createUsageTap } = require("./usage-tap");

// §5.8: the chat family, the TTS family and debug.route (the playground shows
// x-local-ai-route). Never mcp or search.
const CONSOLE_SESSION_SCOPES = Object.freeze([
  "models.read", "chat", "completions", "responses", "messages",
  "audio.speech", "audio.clone",
  "debug.route",
]);
// The hop v2 principal of a console-session caller (§5.8): not billed (b:null),
// TTS owner-wide (t:""), recorded as client `console`.
const CONSOLE_SESSION_PRINCIPAL = Object.freeze({ k: "console", b: null, c: "console", t: "", l: "admin", p: "console-session" });

// The legacy ADMIN gateway codes and their 05 §10.2 equivalents. ADMIN keeps
// the legacy code (and shape) for the checks it always had; PUBLIC answers
// only in taxonomy codes.
const PUBLIC_CODE_FOR = Object.freeze({
  unauthorized: "invalid_api_key",
  key_store_unreadable: "auth_unavailable",
  manager_forbidden: "model_not_allowed",
  model_forbidden: "model_not_allowed",
  model_not_available: "model_not_found",
  capability_not_available: "model_unavailable",
  fleet_settings_unavailable: "service_unavailable",
  manager_offline: "service_unavailable",
  invalid_gateway_path: "invalid_request",
  invalid_content_encoding: "invalid_request",
  protocol_not_supported: "not_found",
  request_body_too_large: "request_too_large",
  gateway_body_budget_exhausted: "overloaded",
  gateway_proxy_error: "upstream_error",
  request_timeout: "upstream_timeout",
});

// The checks this pipeline added to the ADMIN gateway answer in the 05 §10.2
// shape there too; every other ADMIN refusal keeps its legacy body.
const TAXONOMY_ON_ADMIN = new Set([
  "missing_api_key", "invalid_api_key", "key_expired", "key_disabled", "scope_denied",
  "model_not_allowed", "origin_not_allowed", "ip_not_allowed", "csrf_invalid", "auth_unavailable",
  // The public surface's request checks (05 §8.2 steps 9 and 10).
  "max_tokens_exceeded", "unknown_engine",
  // The limiter's checks (05 §9): new on ADMIN as well, so distinct codes.
  "request_exceeds_tpm", "tokens_rate_limit_exceeded", "insufficient_quota", "overloaded",
]);

// The rate-limit families the upstream may have sent itself: ours replace them.
const LIMIT_HEADER_RE = /^(?:x-ratelimit-|x-quota-|anthropic-ratelimit-)/i;

// The scope a model-gateway route needs (05 §6.3). Model listings need
// models.read; every other OpenAI path is chat unless it names one of the
// other families; Claude routes are messages; opencode is chat.
function scopeForModelRoute(route = {}, method = "GET") {
  const verb = String(method || "GET").toUpperCase();
  const rest = String(route.rest || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  const listing = (verb === "GET" || verb === "HEAD") && (rest === "models" || rest === "v1/models" || rest.startsWith("v1/models/") || rest.startsWith("models/"));
  if (listing) return "models.read";
  if (route.protocol === "claude") return "messages";
  if (route.protocol === "opencode") return "chat";
  const tail = rest.replace(/^v1\//, "");
  if (tail === "completions") return "completions";
  if (tail === "responses" || tail.startsWith("responses/")) return "responses";
  if (tail === "embeddings" || tail === "rerank" || tail === "score") return "embeddings";
  if (tail === "messages" || tail.startsWith("messages/")) return "messages";
  return "chat";
}

// The scope of any /gateway/* path the entry serves (null: no scope, e.g. the
// unauthenticated health route or the TTS UI shell).
function scopeForGatewayPath(pathname, method = "GET", route = null) {
  const path = String(pathname || "");
  if (path === "/gateway/status" || path === "/gateway/status/") return "models.read";
  if (path === "/gateway/me" || path.startsWith("/gateway/me/")) return "self.read";
  if (path.startsWith("/gateway/tts/openai/v1/audio/speech")) return "audio.speech";
  if (path === "/gateway/tts" || path.startsWith("/gateway/tts/")) return "audio.clone";
  if (path === "/gateway/search" || path.startsWith("/gateway/search/")) return "search";
  if (path === "/gateway/mcp" || path.startsWith("/gateway/mcp/")) return "mcp";
  if (route && route.protocol) return scopeForModelRoute(route, method);
  return null;
}

function fleetIdOf(managerId, instanceId) {
  return `${String(managerId || "").toLowerCase()}:${String(instanceId || "primary")}`;
}

// Whether any fleet member of a manager may be allowed by the key's
// fleetAllow (05 §6.3). Only the include patterns count here; an exclude of
// one instance is applied per candidate during selection.
function keyMayUseManager(key, managerId) {
  const patterns = (Array.isArray(key?.fleetAllow) ? key.fleetAllow : [])
    .map((item) => String(item || "").trim())
    .filter((item) => item && !item.startsWith("!"));
  if (!patterns.length) return true;
  const id = String(managerId || "").toLowerCase();
  return patterns.some((pattern) => {
    const colon = pattern.indexOf(":");
    const managerPart = colon < 0 ? pattern : pattern.slice(0, colon);
    return keyPolicy.matchPattern(managerPart, id);
  });
}

// The hop v2 principal (05 §7.1) for a caller, or null for a keyless one.
// It rides on req.serviceEntryPrincipal; buildProxyHeaders signs it into the
// hop for a manager that advertises gatewayTrust.version >= 2 (PUB-10).
function hopPrincipal(caller, listener = "admin") {
  if (!caller || caller.ok !== true) return null;
  if (caller.kind === "console-session") return { ...CONSOLE_SESSION_PRINCIPAL };
  if (caller.kind !== "key" || !caller.key) return null;
  const key = caller.key;
  const limits = key.limits || {};
  return {
    k: key.id,
    b: key.billing?.scope || null,
    c: key.billing?.clientId || "",
    t: String(key.ttsOwner || ""),
    l: listener === "public" ? "public" : "admin",
    p: "key",
    ...(Number.isFinite(limits.maxOutputTokens) ? { mo: limits.maxOutputTokens } : {}),
    ...(Number.isFinite(limits.maxConcurrent) ? { mc: limits.maxConcurrent } : {}),
  };
}

// What a reservation is settled with when nothing settled it sooner: the
// usage the tap left on the request (PUB-11), nothing used when the answer
// was a failure, otherwise null (the admission estimate stays charged).
function settlementUsage(req, res) {
  if (req?.serviceEntryUsage) return req.serviceEntryUsage;
  return Number(res?.statusCode) >= 400 ? { inputTokens: 0, outputTokens: 0 } : null;
}

function sanitizeRoutePart(value) {
  return String(value ?? "").replace(/[^\w.:@/-]+/g, "_");
}

/**
 * createGatewayPipeline(deps) -> { handle, authorize, resolveCaller, ... }
 *   security        createEntrySecurity() result
 *   getAdminAuth    (req) -> admin-session auth of this request's route context
 *   getManagers     () -> MANAGERS
 *   getCatalogs     (managers) -> Promise<catalog[]>
 *   getFleetSettings () -> Promise<settings>
 *   io              server.js transport helpers (see handle())
 *   limiter         createLimiter() result (lib/limiter.js); a memory-only one is
 *                   made when absent (tests)
 *   usageTap        createUsageTap-compatible factory (default: lib/usage-tap.js)
 *   keysStore       the platform key store (object or getter): addUsage and touchKey
 *   logger          optional, for warnings
 *   telemetry, billing, tts, config
 *                   accepted for the later packages; unused here
 */
function createGatewayPipeline(deps = {}) {
  const security = deps.security;
  if (!security || typeof security.authorizeGatewayRequest !== "function") throw new TypeError("createGatewayPipeline needs the entry security.");
  const getAdminAuth = typeof deps.getAdminAuth === "function" ? deps.getAdminAuth : () => null;
  const getManagers = typeof deps.getManagers === "function" ? deps.getManagers : () => [];
  const getCatalogs = deps.getCatalogs;
  const getFleetSettings = deps.getFleetSettings;
  const selectFleetTarget = typeof deps.selectFleetTarget === "function" ? deps.selectFleetTarget : modelFleet.selectFleetTarget;
  const io = deps.io || {};
  const makeUsageTap = typeof deps.usageTap === "function" ? deps.usageTap : createUsageTap;
  // (requested, { catalogs, caller, route }) -> model id | "": public_model_meta aliases (05 §8.1).
  const resolveModelAlias = typeof deps.resolveModelAlias === "function" ? deps.resolveModelAlias : null;
  const limiter = deps.limiter || createLimiter({
    config: () => (typeof security.accessConfig === "function" ? security.accessConfig() : {}),
  });

  function listenerOf(req) {
    return security.listenerKind(req) === "public" ? "public" : "admin";
  }

  // The client identity the limiter judges (05 §4): ip, socketIp and the
  // trusted-proxy flags. A stub security without it still yields an ip.
  function identityOf(req) {
    if (typeof security.identifyClient === "function") return security.identifyClient(req);
    const ip = typeof security.resolveClientAddress === "function" ? security.resolveClientAddress(req) : "";
    return { ip, socketIp: ip, missingHeader: false };
  }

  function hasScope(caller, scope) {
    if (!scope) return true;
    if (caller.kind === "console-session") return CONSOLE_SESSION_SCOPES.includes(scope);
    if (caller.kind === "key") return Array.isArray(caller.scopes) && caller.scopes.includes(scope);
    // Keyless callers and legacy-shaped results carry every gateway scope.
    return true;
  }

  // The owner's console session on ADMIN (05 §5.8), or null. Only with no
  // key header; a cookie that is invalid, expired, or not an owner session
  // falls back to the keyless rules.
  function consoleSessionOf(req) {
    // A browser console request with no cookie is the implicit owner (this
    // machine or the LAN, admin-session.js): it must say it is same-origin.
    const sameOriginBrowser = String(req?.headers?.["sec-fetch-site"] || "").toLowerCase() === "same-origin";
    if (listenerOf(req) === "public" || (!req?.headers?.cookie && !sameOriginBrowser) || hasApiKeyHeader(req.headers)) return null;
    const adminAuth = getAdminAuth(req);
    if (!adminAuth || typeof adminAuth.authenticate !== "function") return null;
    let who;
    try {
      who = adminAuth.authenticate(req);
    } catch {
      return null;
    }
    const implicit = who?.implicit === true && sameOriginBrowser;
    if (!who || who.role !== "owner" || !(implicit || (who.via === "session" && who.sessionId))) return null;
    let csrfOk = false;
    try {
      csrfOk = adminAuth.requireCsrf(req) === true;
    } catch {
      csrfOk = false;
    }
    return {
      ok: true,
      kind: "console-session",
      principal: "console-session",
      listener: "admin",
      sessionId: who.sessionId || `implicit-${who.network || "local"}`,
      scopes: [...CONSOLE_SESSION_SCOPES],
      key: null,
      keyId: "",
      customerId: "",
      ttsOwner: "",
      clientId: "",
      client: null,
      authRequired: false,
      matchedManager: "",
      csrfOk,
    };
  }

  // resolveCaller(req, { scope }) -> caller | { ok:false, status, code, message, param }
  async function resolveCaller(req, { scope = "" } = {}) {
    const session = consoleSessionOf(req);
    if (session) {
      if (!session.csrfOk) return denial("csrf_invalid");
      if (!hasScope(session, scope)) return denial("scope_denied", { param: scope });
      return session;
    }
    const caller = await security.authorizeGatewayRequest(req, { scope });
    if (!caller || caller.ok !== true) return caller || denial("auth_unavailable");
    // A key's scope is judged by key-policy inside authorizeGatewayRequest;
    // this catches stores or stubs that did not.
    if (!hasScope(caller, scope)) return denial("scope_denied", { param: scope });
    // An admin ban of this key (05 §9.3).
    if (caller.kind === "key" && caller.key?.id) {
      const banned = limiter.checkKeyBan(caller.key.id);
      if (banned) return denial("auth_banned", { message: banned.message, retryAfterSeconds: banned.retryAfterSeconds });
    }
    return caller;
  }

  function denial(code, extra = {}) {
    const item = lookupPublicError(code);
    return { ok: false, status: item ? item.status : 500, code, message: item ? item.message : "Request refused.", ...extra };
  }

  // authorize(req, { scope }): resolveCaller plus the bookkeeping every
  // gateway route does: the 401-storm guard, req.serviceEntryAuth, the hop
  // principal and the telemetry identity.
  async function authorize(req, { scope = "" } = {}) {
    const caller = await resolveCaller(req, { scope });
    limiter.noteAuthResult(identityOf(req), caller);
    if (!caller.ok) return caller;
    req.serviceEntryAuth = caller;
    req.serviceEntryPrincipal = hopPrincipal(caller, listenerOf(req));
    // 04 §5.2: the context rides the same signed hop as the principal.
    req.serviceEntryContext = io.entryContext ? io.entryContext(req) : null;
    io.recordAuth?.(req, caller, {
      listener: listenerOf(req),
      principal: caller.kind === "console-session" ? "console-session" : "key",
      country: identityOf(req).country || "",
      endUser: endUserOf(req, caller),
    });
    return caller;
  }

  // The managers a caller may reach for a route engine. A key is held to its
  // fleetAllow; a legacy-shaped result (tests, stubs) to its matchedManager.
  function managersFor(caller, engine = "auto", managers = getManagers()) {
    const requested = String(engine || "auto").trim().toLowerCase();
    const list = (Array.isArray(managers) ? managers : []).filter((manager) => requested === "auto" || manager.id === requested);
    if (caller?.key) return list.filter((manager) => keyMayUseManager(caller.key, manager.id));
    const matched = String(caller?.matchedManager || "").trim().toLowerCase();
    return matched ? list.filter((manager) => manager.id === matched) : list;
  }

  // Whether a caller may use one model of one fleet member (05 §6.3).
  function modelVisible(caller, model, managerId) {
    if (!caller) return true;
    const descriptor = typeof model === "string" ? { id: model } : (model || {});
    if (caller.key) {
      const instanceId = descriptor.instance_id || descriptor.instanceId || "primary";
      return keyPolicy.fleetAllowed(caller.key, fleetIdOf(managerId, instanceId)) && keyPolicy.modelAllowed(caller.key, descriptor);
    }
    if (caller.client) return core.serviceClientAllowsModel(caller.client, String(descriptor.id || ""));
    return true;
  }

  // selectFleetTarget's filterCandidate (05 §8.1), or null when the caller
  // may use every model.
  function candidateFilter(caller) {
    if (!caller || (!caller.key && !caller.client)) return null;
    return (candidate) => {
      const instanceId = candidate?.instance?.instanceId || candidate?.instance?.id || candidate?.model?.instance_id || "primary";
      if (caller.key) {
        return keyPolicy.fleetAllowed(caller.key, fleetIdOf(candidate?.managerId, instanceId))
          && keyPolicy.modelAllowed(caller.key, candidate?.model || {});
      }
      return core.serviceClientAllowsModel(caller.client, String(candidate?.model?.id || ""));
    };
  }

  // x-local-ai-route goes to callers with debug.route (a key with the scope,
  // console-session) and to direct loopback callers on ADMIN (05 §5 "admin
  // and debug keys only once D8 lands").
  function routeHeaderAllowed(req, caller) {
    if (caller?.kind === "console-session") return true;
    if (caller?.kind === "key") {
      if (Array.isArray(caller.scopes) && caller.scopes.includes("debug.route")) return true;
    }
    return listenerOf(req) === "admin" && core.isLocalRequest(req) && !security.isProxiedRequest(req);
  }

  // The ban check every gateway handler starts with (05 §8.2 step 3): null,
  // or { retryAfterSeconds, message } for a banned address.
  function checkBan(req) {
    return limiter.checkBan(identityOf(req));
  }

  // The §9.6 headers for what the request's ticket has seen so far.
  function rateHeaders(req) {
    const ticket = req?.serviceEntryRateTicket;
    if (!ticket) return {};
    return limiter.headers(ticket, { protocol: req.serviceEntryRateProtocol || "" });
  }

  // Puts them on the response; a later refusal or the proxied answer carries
  // them. Headers the response already holds are replaced.
  function applyRateHeaders(req, res) {
    if (!res || res.headersSent || typeof res.setHeader !== "function") return;
    for (const [name, value] of Object.entries(rateHeaders(req))) res.setHeader(name, value);
  }

  // Takes one request from the caller's rpm bucket (05 §9.1) and reports the
  // limits. Every gateway route, the model gateway and the TTS, search and
  // status routes, calls it right after authentication.
  // peek: report the bucket without taking a token (/gateway/status, 05 §8.1).
  function enterRate(req, res, caller, { protocol = "", peek = false } = {}) {
    const entered = limiter.enter({ caller, identity: identityOf(req), listener: listenerOf(req), peek });
    req.serviceEntryRateTicket = entered.ticket;
    req.serviceEntryRateProtocol = protocol;
    applyRateHeaders(req, res);
    applyCors(req, res, caller);
    return entered;
  }

  // PUBLIC CORS of an authenticated request (05 §11): the Origin has passed
  // the key's allowed_origins in key-policy, so it is echoed with the exposed
  // headers. Never credentials, never private-network. {} elsewhere.
  function corsFor(req, caller) {
    if (listenerOf(req) !== "public" || caller?.kind !== "key" || !caller.key || typeof security.publicCorsHeaders !== "function") return {};
    return { ...security.publicCorsHeaders(req, caller.key) };
  }

  function applyCors(req, res, caller) {
    if (!res || res.headersSent || typeof res.setHeader !== "function") return;
    for (const [name, value] of Object.entries(corsFor(req, caller))) res.setHeader(name, value);
  }

  // The hashed Open WebUI user of a key labelled app=openwebui (05 §15), else "".
  function endUserOf(req, caller) {
    if (caller?.kind !== "key" || String(caller.key?.labels?.app || "").toLowerCase() !== "openwebui") return "";
    const raw = req.headers?.["x-openwebui-user-id"];
    const text = String(Array.isArray(raw) ? raw[0] : raw || "").trim();
    return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
  }

  function keysStoreOf() {
    const value = typeof deps.keysStore === "function" ? deps.keysStore() : deps.keysStore;
    return value && typeof value.addUsage === "function" ? value : null;
  }

  // Step 15 (05 §8.2): what the key used, once per request, whichever way the
  // request ended: the counters and the last-used stamp. `usage` is the tap's
  // result, or null when nothing came back (a failed dispatch). Never throws
  // into the response.
  function noteKeyUsed(req, caller, usage, { failed = false } = {}) {
    if (req.serviceEntryCounted) return;
    req.serviceEntryCounted = true;
    if (caller?.kind !== "key" || !caller.key?.id) return;
    try {
      const identity = identityOf(req);
      const store = keysStoreOf();
      if (!store) return;
      store.addUsage(caller.key.id, {
        requests: 1,
        inputTokens: usage?.inputTokens || 0,
        cachedInputTokens: usage?.cachedInputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        errors: failed ? 1 : 0,
        tzOffsetMinutes: typeof limiter.quotaTzOffset === "function" ? limiter.quotaTzOffset() : undefined,
      });
      limiter.invalidateUsage?.(caller.key.id);
      store.touchKey?.(caller.key.id, { ip: identity.ip, country: identity.country || "" });
    } catch (error) {
      deps.logger?.warn?.(core.redactSecrets(`gateway usage counters: ${error?.message || error}`));
    }
  }

  // The usage tap on the way to the client (step 15). Returns the Transform
  // forwardBody puts in the response path; when its result arrives the tpm
  // reservation is settled with the real usage and the counters are added.
  function tapUsage(req, caller, { route, upstream, parsedBody, upstreamControl, scope }) {
    const failedStatus = upstream.status >= 400;
    let tap;
    try {
      let estimatedInputTokens = 0;
      try {
        estimatedInputTokens = core.estimateOpenAiRequestInputTokens(parsedBody) || 0;
      } catch {
        estimatedInputTokens = 0;
      }
      tap = makeUsageTap({
        protocol: route.protocol === "claude" ? "anthropic" : "openai",
        endpoint: scope,
        stream: parsedBody?.stream === true,
        estimatedInputTokens,
        contentType: upstream.headers?.get?.("content-type") || undefined,
        status: upstream.status,
        abortReason: () => upstreamControl?.abortReason || "",
        onResult: (usage) => {
          const measured = usage && usage.source !== "none";
          req.serviceEntryUsage = measured
            ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
            : (failedStatus ? { inputTokens: 0, outputTokens: 0 } : null);
          if (req.serviceEntryReservation) limiter.settle(req.serviceEntryReservation, req.serviceEntryUsage);
          noteKeyUsed(req, caller, usage, { failed: failedStatus || usage?.terminal === "upstream_error" || usage?.terminal === "timeout" });
        },
      });
    } catch {
      return null;
    }
    return tap.transform;
  }

  // Owner traffic (05 §9.5): everything on ADMIN, console-session included,
  // and PUBLIC keys of class owner.
  function isOwnerTraffic(req, caller) {
    return listenerOf(req) === "admin" || caller?.kind === "console-session" || caller?.key?.class === "owner";
  }

  // Sends a refusal. PUBLIC answers only in 05 §10.2 codes, in the protocol
  // shape of the route (OpenAI or Anthropic, §10.1), mapping legacy codes onto
  // the taxonomy. ADMIN uses that shape for the access checks of this
  // pipeline (TAXONOMY_ON_ADMIN) and keeps the legacy body otherwise.
  function sendRefusal(req, res, { status, code, message = "", param = null, retryAfterSeconds = null, headers = {} }) {
    const listener = listenerOf(req);
    const extra = { ...headers };
    const effectiveStatus = Number(status || lookupPublicError(code)?.status || 500);
    if (effectiveStatus === 401) extra["www-authenticate"] = "Bearer";
    if (listener === "public" || TAXONOMY_ON_ADMIN.has(code)) {
      const publicCode = lookupPublicError(code) ? code : (PUBLIC_CODE_FOR[code] || code);
      return sendPublicError(req, res, publicCode, { param, retryAfterSeconds, headers: extra, detail: message });
    }
    if (retryAfterSeconds) extra["retry-after"] = String(retryAfterSeconds);
    return io.sendJson(res, core.openAiGatewayError(code, message), effectiveStatus, extra);
  }

  // A refusal before any upstream call: recorded, then answered.
  function refuse(req, res, access, info) {
    io.deny?.(req, access, {
      status: info.status,
      message: info.message || "",
      code: info.code,
      manager: info.manager || null,
      metadata: info.metadata || null,
      resolvedModel: info.resolvedModel || "",
    });
    return sendRefusal(req, res, { ...info, headers: { ...io.corsHeaders(req), ...(info.headers || {}) } });
  }

  // handle(req, res, { url, route }) — the model gateway
  // (/gateway/{auto,vllm,llama}/{openai,claude,opencode}/*), on both
  // listeners. `route` is server.js parseGatewayRoute(url.pathname).
  async function handle(req, res, { url, route } = {}) {
    if (!route) return sendRefusal(req, res, { status: 404, code: "not_found", message: "Unknown gateway route." });
    if (req.method === "OPTIONS") {
      res.writeHead(204, io.corsHeaders(req));
      return res.end();
    }
    const startedAt = Date.now();
    const access = io.prepareAccess(req, route, startedAt);
    const rec = io.record(req);
    // Authentication happens here, before the loopback hop, so the managers
    // no longer have to infer trust from a proxied socket address.
    const ban = checkBan(req);
    if (ban) {
      return refuse(req, res, access, { status: 429, code: "auth_banned", message: ban.message, retryAfterSeconds: ban.retryAfterSeconds });
    }
    const caller = await authorize(req, { scope: scopeForModelRoute(route, req.method) });
    if (!caller.ok) return refuse(req, res, access, caller);
    const authorizedManagers = managersFor(caller, route.engine);
    if (!authorizedManagers.length) {
      // The ADMIN code is kept (gateway.test.js "keys scoped to manager");
      // PUBLIC answers model_not_allowed.
      return refuse(req, res, access, {
        status: 403,
        code: "manager_forbidden",
        message: "This service API key is not authorized for the requested model manager.",
        param: "model",
      });
    }
    // /gateway/<engineId>/… names an engine the fleet must know (00 §5);
    // a typo is a 400, not an empty fleet.
    if (route.engineId) {
      const known = modelFleet.knownEngineIds(await getCatalogs(managersFor(null, "auto")));
      if (!known.has(String(route.engineId).toLowerCase())) {
        return refuse(req, res, access, { status: 400, code: "unknown_engine", param: "engine", message: "Unknown engine id." });
      }
    }
    const rate = enterRate(req, res, caller, { protocol: route.protocol });
    if (!rate.ok) {
      return refuse(req, res, access, {
        status: 429,
        code: "rate_limit_exceeded",
        message: `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`,
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }
    if (io.isModelListRequest(req, route)) {
      return io.sendModelList(req, res, route.engine, caller, authorizedManagers, route);
    }
    // From here on the request is model work: the owner's counts against the
    // public share (05 §9.5) until the response is done.
    const ownerTraffic = isOwnerTraffic(req, caller);
    if (ownerTraffic) {
      const ownerEnd = limiter.shareGate.ownerBegin();
      res.once("finish", ownerEnd);
      res.once("close", ownerEnd);
    }
    let body;
    try {
      body = await io.readJsonBody(req, res);
    } catch (error) {
      return refuse(req, res, access, {
        status: error.status || 400,
        code: error.code || "invalid_request",
        message: error.message,
      });
    }
    const { contentEncoding } = body;
    let parsedBody = body.parsedBody;
    let requestBody = body.requestBody;
    // Set when the body the client sent is no longer the body we forward
    // (an alias or the output cap): it is re-serialized, uncompressed.
    let bodyChanged = false;
    const requestMetadata = io.summarizeBody(parsedBody);
    const clientModel = String(parsedBody?.model || "").trim();
    let requestedModel = clientModel;
    rec?.setRouting({ modelRequested: clientModel, stream: requestMetadata.stream });
    rec?.setExtra({ toolSchemaCount: requestMetadata.toolSchemaCount });
    let fleetSettings;
    try {
      fleetSettings = await getFleetSettings();
    } catch {
      io.deny?.(req, access, { status: 500, message: "Fleet settings are unavailable.", code: "fleet_settings_unavailable", metadata: requestMetadata });
      return sendRefusal(req, res, { status: 500, code: "fleet_settings_unavailable", message: "Fleet routing settings are unavailable." });
    }
    // A key's fleetAllow is applied per candidate, over every manager of the
    // route, so a model the key may not use answers model_not_allowed rather
    // than "not found".
    const catalogs = await getCatalogs(caller.key ? managersFor(null, route.engine) : authorizedManagers);
    // A public alias names a model; it is resolved before routing and the
    // body is rewritten to the model id (05 §8.1). The engine filter of the
    // route is untouched, so /vllm/v1 plus an alias stays on vllm.
    const aliasTarget = resolveModelAlias && requestedModel ? String(resolveModelAlias(requestedModel, { catalogs, caller, route }) || "").trim() : "";
    if (aliasTarget && aliasTarget.toLowerCase() !== requestedModel.toLowerCase() && parsedBody && typeof parsedBody === "object") {
      requestedModel = aliasTarget;
      parsedBody = { ...parsedBody, model: aliasTarget };
      bodyChanged = true;
    }
    const selection = selectFleetTarget(catalogs, {
      engine: route.engine,
      protocol: route.protocol,
      path: route.rest,
      route,
      body: parsedBody,
      requestedModel,
      claudeAliases: io.claudeAliases,
      filterCandidate: candidateFilter(caller),
      ...fleetSettings,
    });
    if (selection.error) {
      return refuse(req, res, access, {
        status: Number(selection.status || 503),
        code: selection.error,
        message: selection.message || selection.reason || "No matching model service is available.",
        param: selection.error === "model_not_allowed" || selection.error === "model_not_available" ? "model" : null,
        metadata: requestMetadata,
      });
    }
    const manager = selection.manager;
    const resolvedModel = String(selection.model?.id || "").trim();
    io.recordRouting(req, selection, resolvedModel, clientModel, requestMetadata);
    // 05 §8.2 step 10: a missing max_tokens gets the key's cap, an explicit
    // one above it is refused.
    const modelScope = scopeForModelRoute(route, req.method);
    const capped = applyOutputCap(parsedBody, { cap: rate.ticket?.limits?.outputCap, scope: modelScope, rest: route.rest });
    if (!capped.ok) {
      return refuse(req, res, access, {
        status: 400,
        code: "max_tokens_exceeded",
        param: capped.param,
        message: `${capped.param} ${capped.requested} is above the limit of this key (${capped.cap}).`,
        metadata: requestMetadata,
        resolvedModel,
      });
    }
    if (capped.injected) {
      parsedBody = capped.body;
      bodyChanged = true;
    }
    if (bodyChanged && !["GET", "HEAD"].includes(req.method)) requestBody = Buffer.from(JSON.stringify(parsedBody), "utf8");
    // tpm, then the daily/monthly caps (05 §9.1, §9.4). The reservation is
    // settled when the response is done; the usage tap (PUB-11) settles it
    // earlier with the real usage.
    const admitted = limiter.admitBody({ ticket: rate.ticket, caller, body: parsedBody, scope: modelScope });
    applyRateHeaders(req, res);
    if (!admitted.ok) {
      return refuse(req, res, access, {
        status: admitted.status,
        code: admitted.code,
        param: admitted.param || null,
        retryAfterSeconds: admitted.retryAfterSeconds || null,
        message: admitted.code === "request_exceeds_tpm" ? "The request is larger than the token rate limit of this key." : "A quota of this key is used up.",
        metadata: requestMetadata,
        resolvedModel,
      });
    }
    if (admitted.reservation) {
      req.serviceEntryReservation = admitted.reservation;
      const settleOnEnd = () => limiter.settle(admitted.reservation, settlementUsage(req, res));
      res.once("finish", settleOnEnd);
      res.once("close", settleOnEnd);
    }
    // Step 12: the key's own concurrency queue (PUBLIC keys). The slot is
    // held until the response is done.
    const concurrency = await limiter.acquireConcurrency({ ticket: rate.ticket, res });
    if (!concurrency.ok) {
      body.release();
      if (concurrency.aborted) return undefined;
      return refuse(req, res, access, {
        status: concurrency.status,
        code: concurrency.code,
        retryAfterSeconds: concurrency.retryAfterSeconds,
        message: "Too many concurrent requests for this key.",
        metadata: requestMetadata,
        resolvedModel,
      });
    }
    // "close" follows "finish" on a response that completed.
    res.once("close", concurrency.release);
    const genericModel = io.isGenericModel(requestedModel);
    const rewriteModel = genericModel && ["openai", "opencode"].includes(route.protocol);
    let bodyForUpstream = rewriteModel ? io.rewriteModelBody(requestBody, resolvedModel, parsedBody) : requestBody;
    if (!(await io.isPortListening(manager.port))) {
      io.deny?.(req, access, { status: 503, message: `${manager.name} is not listening on port ${manager.port}.`, code: "manager_offline", manager, metadata: requestMetadata, resolvedModel });
      return sendRefusal(req, res, { status: 503, code: "service_unavailable", message: io.upstreamDownMessage });
    }
    let targetPath = "";
    try {
      targetPath = io.buildManagerPath(route);
    } catch (error) {
      return refuse(req, res, access, { status: error.status || 400, code: error.code || "invalid_gateway_path", message: error.message, manager, metadata: requestMetadata, resolvedModel });
    }
    if (!targetPath) return sendRefusal(req, res, { status: 404, code: "protocol_not_supported", message: `${manager.name} does not support ${route.protocol}.` });
    // The public share (05 §9.5): non-owner PUBLIC requests wait for a slot,
    // fewer of them while the owner is working.
    if (!ownerTraffic) {
      const gate = new AbortController();
      const abortWait = () => gate.abort();
      res.once("close", abortWait);
      const slot = await limiter.shareGate.acquire({ signal: gate.signal });
      res.off("close", abortWait);
      if (!slot.ok) {
        if (slot.reason === "aborted") {
          body.release();
          return undefined;
        }
        body.release();
        return refuse(req, res, access, {
          status: 503,
          code: "overloaded",
          retryAfterSeconds: limiter.shareGate.retryAfterSeconds,
          message: "Public capacity is full.",
          manager,
          metadata: requestMetadata,
          resolvedModel,
        });
      }
      res.once("finish", slot.release);
      res.once("close", slot.release);
    }
    const target = new URL(`http://127.0.0.1:${manager.port}${targetPath}`);
    target.search = url.search;
    // Hop v2 (05 §7.1) when the manager advertises it: the key is stripped
    // and the signed principal stands in for it. A legacy manager still gets
    // the key, so a platform-only key (one it never knew) cannot be served.
    const hopVersion = typeof io.managerTrustVersion === "function" ? Number(await io.managerTrustVersion(manager)) || 0 : 0;
    if (hopVersion < 2 && caller.kind === "key" && caller.key && !caller.key.legacy) {
      io.deny?.(req, access, { status: 503, message: `${manager.name} does not accept platform keys yet.`, code: "manager_upgrade_required", manager, metadata: requestMetadata, resolvedModel });
      return sendRefusal(req, res, { status: 503, code: "service_unavailable", message: io.upstreamDownMessage });
    }
    const upstreamControl = io.createUpstreamControl(req, res);
    Object.assign(access, { manager, metadata: requestMetadata, resolvedModel, error: "" });
    io.watch(req, res, access);
    const instanceId = selection.instance?.instanceId || selection.instance?.id || "";
    try {
      rec?.dispatched();
      const upstream = await io.fetch(target, {
        method: req.method,
        headers: io.buildProxyHeaders(req.headers, req, {
          instanceId,
          stripContentEncoding: Boolean(contentEncoding && (rewriteModel || bodyChanged)),
          hopVersion,
          method: req.method,
          pathname: target.pathname,
        }),
        body: bodyForUpstream,
        signal: upstreamControl.signal,
        redirect: "manual",
      });
      requestBody = undefined;
      bodyForUpstream = undefined;
      body.release();
      rec?.headers(upstream.status, upstream.headers);
      const responseHeaders = io.buildResponseHeaders(upstream.headers, req);
      // Our §9.6 headers replace whatever the upstream sent in those families.
      for (const name of Object.keys(responseHeaders)) {
        if (LIMIT_HEADER_RE.test(name)) delete responseHeaders[name];
      }
      Object.assign(responseHeaders, rateHeaders(req));
      // PUBLIC CORS is ours alone (05 §11): nothing the upstream sent in that
      // family survives.
      if (listenerOf(req) === "public") {
        for (const name of Object.keys(responseHeaders)) {
          if (/^access-control-/i.test(name)) delete responseHeaders[name];
        }
        const cors = corsFor(req, caller);
        if (cors.vary) {
          const existing = Object.keys(responseHeaders).find((name) => name.toLowerCase() === "vary");
          if (!existing) responseHeaders.vary = cors.vary;
          else if (!/\borigin\b/i.test(String(responseHeaders[existing]))) responseHeaders[existing] = `${responseHeaders[existing]}, Origin`;
          delete cors.vary;
        }
        Object.assign(responseHeaders, cors);
      }
      // Which engine and instance served the request: `auto` routing is
      // otherwise opaque. Only for debug.route callers and the local owner.
      if (routeHeaderAllowed(req, caller)) {
        responseHeaders["x-local-ai-route"] = [manager?.id || "", instanceId, resolvedModel || "", selection.reason || ""]
          .map(sanitizeRoutePart)
          .join(" ");
      }
      res.writeHead(upstream.status, responseHeaders);
      const usageTransform = tapUsage(req, caller, { route, upstream, parsedBody, upstreamControl, scope: scopeForModelRoute(route, req.method) });
      const transforms = [usageTransform, rec?.tap()].filter(Boolean);
      io.forwardBody(upstream, res, upstreamControl, transforms.length > 1 ? transforms : (transforms[0] || null));
    } catch (error) {
      upstreamControl.clear();
      requestBody = undefined;
      bodyForUpstream = undefined;
      body.release();
      access.error = error.message;
      const timeout = error.name === "TimeoutError";
      rec?.fail({ status: error.status || (timeout ? 504 : 502), code: timeout ? "request_timeout" : "gateway_proxy_error", phase: "upstream" });
      noteKeyUsed(req, caller, null, { failed: true });
      if (!res.headersSent) {
        sendRefusal(req, res, {
          status: error.status || (timeout ? 504 : 502),
          code: listenerOf(req) === "public" && timeout ? "request_timeout" : "gateway_proxy_error",
          message: "gateway_proxy_error: upstream unavailable",
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    return undefined;
  }

  return {
    handle,
    authorize,
    resolveCaller,
    managersFor,
    modelVisible,
    candidateFilter,
    routeHeaderAllowed,
    listenerOf,
    checkBan,
    enterRate,
    rateHeaders,
    limiter,
    sendRefusal,
    hopPrincipal,
  };
}

module.exports = {
  CONSOLE_SESSION_PRINCIPAL,
  CONSOLE_SESSION_SCOPES,
  createGatewayPipeline,
  hopPrincipal,
  keyMayUseManager,
  scopeForGatewayPath,
  scopeForModelRoute,
};
