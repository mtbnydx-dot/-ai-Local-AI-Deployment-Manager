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
// Later packages plug in here: the limiter (PUB-9), the usage tap and
// counters (PUB-11) and the hop v2 principal (PUB-10, hopPrincipal below).

const core = require("../../manager-core");
const keyPolicy = require("./key-policy");
const modelFleet = require("./model-fleet");
const { hasApiKeyHeader, lookupPublicError, sendPublicError } = require("./public-errors");

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
]);

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
 *   keysStore, limiter, usageTap, telemetry, billing, tts, config
 *                   accepted for the later packages (PUB-9/10/11); unused here
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

  function listenerOf(req) {
    return security.listenerKind(req) === "public" ? "public" : "admin";
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
    if (listenerOf(req) === "public" || !req?.headers?.cookie || hasApiKeyHeader(req.headers)) return null;
    const adminAuth = getAdminAuth(req);
    if (!adminAuth || typeof adminAuth.authenticate !== "function") return null;
    let who;
    try {
      who = adminAuth.authenticate(req);
    } catch {
      return null;
    }
    if (!who || who.via !== "session" || who.role !== "owner" || !who.sessionId) return null;
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
      sessionId: who.sessionId,
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
    io.noteAuthResult?.(req, caller);
    if (!caller.ok) return caller;
    req.serviceEntryAuth = caller;
    req.serviceEntryPrincipal = hopPrincipal(caller, listenerOf(req));
    io.recordAuth?.(req, caller);
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

  // The entry's rpm bucket for a caller (PUB-9 replaces this with the limiter).
  function rateLimitFor(req, caller) {
    const envRpm = Number(process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 0);
    if (caller?.kind === "console-session") {
      let rpm = 600;
      try {
        rpm = Number(security.accessConfig().admin?.gatewayRpm) || rpm;
      } catch {
        // The schema default stands.
      }
      return { key: `console:${caller.sessionId}`, rpm: envRpm || rpm };
    }
    if (caller?.client?.id) {
      return { key: `${caller.matchedManager || "platform"}:${caller.client.id}`, rpm: Number(caller.client.rateLimitRpm || envRpm || 600) };
    }
    return { key: security.resolveClientAddress(req) || "anonymous", rpm: envRpm || 600 };
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
    const ban = io.checkAuthBan(req);
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
    const rate = io.enterRateLimit(rateLimitFor(req, caller));
    if (!rate.ok) {
      return refuse(req, res, access, {
        status: 429,
        code: "rate_limit_exceeded",
        message: `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`,
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }
    if (io.isModelListRequest(req, route)) {
      return io.sendModelList(req, res, route.engine, caller, authorizedManagers);
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
    const { parsedBody, contentEncoding } = body;
    let requestBody = body.requestBody;
    const requestMetadata = io.summarizeBody(parsedBody);
    const requestedModel = String(parsedBody?.model || "").trim();
    rec?.setRouting({ modelRequested: requestedModel, stream: requestMetadata.stream });
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
    io.recordRouting(req, selection, resolvedModel, requestedModel, requestMetadata);
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
          stripContentEncoding: Boolean(contentEncoding && rewriteModel),
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
      // Which engine and instance served the request: `auto` routing is
      // otherwise opaque. Only for debug.route callers and the local owner.
      if (routeHeaderAllowed(req, caller)) {
        responseHeaders["x-local-ai-route"] = [manager?.id || "", instanceId, resolvedModel || "", selection.reason || ""]
          .map(sanitizeRoutePart)
          .join(" ");
      }
      res.writeHead(upstream.status, responseHeaders);
      io.forwardBody(upstream, res, upstreamControl, rec?.tap());
    } catch (error) {
      upstreamControl.clear();
      requestBody = undefined;
      bodyForUpstream = undefined;
      body.release();
      access.error = error.message;
      const timeout = error.name === "TimeoutError";
      rec?.fail({ status: error.status || (timeout ? 504 : 502), code: timeout ? "request_timeout" : "gateway_proxy_error", phase: "upstream" });
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
    rateLimitFor,
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
