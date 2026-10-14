"use strict";

// The PUBLIC listener's router (05 §3.2). The route table is exhaustive and
// structural: /api/*, /internal/*, /billing*, /classic*, the admin /docs/*.md,
// the TTS UI, /gateway/mcp* and /gateway/search/* are simply not in it, so
// they answer 404 here whatever the ADMIN listener serves.
//
// PUB-6 owns the skeleton: the Host allowlist, the cookie rule, /healthz,
// /gateway/health, /robots.txt and the route classification. What answers a
// route is injected, so later packages plug in without touching the table:
//   deps.gateway(req, res, url, route)   key routes (the shared pipeline, 08)
//   deps.portal.handle(req, res, url, route) -> boolean   portal shell,
//                                        /assets/<buildId>/*, the *.json routes
//   deps.data.respond(pathname, req) -> object|null   the four portal JSON
//                                        documents (status-sampler.js, PUB-14)
// A route nobody serves yet answers like any unknown path (404) for the
// portal, and 503 service_unavailable for the key routes.

const core = require("../../manager-core");
const { newRequestId, sendPublicError } = require("./public-errors");

const PORTAL_SHELL_PATHS = new Set(["/", "/status", "/models", "/docs", "/me", "/playground", "/announcements"]);
const PORTAL_JSON_PATHS = new Set(["/portal-config.json", "/status.json", "/catalog.json", "/announcements.json"]);
const MODEL_PAGE_RE = /^\/models\/[^/]+$/;
const DOC_PAGE_RE = /^\/docs\/[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_RE = /^\/assets\/[A-Za-z0-9._-]+\/.+$/;
const ENGINE_ID = "[A-Za-z0-9][A-Za-z0-9._@-]{0,63}";
// tts, mcp and search are gateway namespaces of their own, never engine ids.
const GATEWAY_KEY_RE = new RegExp(`^/gateway/(?:auto|vllm|llama|external/${ENGINE_ID}|(?!(?:tts|mcp|search|health|status|me)/)${ENGINE_ID})/(?:openai|claude|opencode)(?:/.*)?$`);
const GATEWAY_FIXED_KEY_PATHS = new Set(["/gateway/status", "/gateway/me", "/gateway/tts/openai/v1/audio/speech"]);
const API_PREFIX_RE = /^\/(?:v1|anthropic\/v1|vllm\/v1|llama\/v1)(?:\/.*)?$/;
// The portal documents are public and cheap; status, catalog and announcements
// are rebuilt at most every 15 s anyway (05 §12.2). portal-config follows the
// Host (LAN-only deployments) and the build id.
const JSON_CACHE = {
  "/status.json": { "cache-control": "public, max-age=15" },
  "/catalog.json": { "cache-control": "public, max-age=15" },
  "/announcements.json": { "cache-control": "public, max-age=15" },
  "/portal-config.json": { "cache-control": "no-cache", vary: "host" },
};
const ROBOTS_TXT = "User-agent: *\nDisallow: /v1/\nDisallow: /anthropic/\nDisallow: /me\nDisallow: /playground\n";

// The kind of a PUBLIC request: "healthz", "gateway_health", "robots",
// "portal" (shell), "asset", "json" (portal data), "key" (needs an API key)
// or "not_found". Pure; only the method and the path decide.
function classifyPublicRoute(method, pathname) {
  const verb = String(method || "GET").toUpperCase();
  const path = String(pathname || "/");
  const read = verb === "GET" || verb === "HEAD";
  if (read) {
    if (path === "/healthz") return { kind: "healthz" };
    if (path === "/gateway/health") return { kind: "gateway_health" };
    if (path === "/robots.txt") return { kind: "robots" };
    if (PORTAL_SHELL_PATHS.has(path) || MODEL_PAGE_RE.test(path) || DOC_PAGE_RE.test(path)) return { kind: "portal" };
    if (ASSET_RE.test(path) && !path.includes("..")) return { kind: "asset" };
    if (PORTAL_JSON_PATHS.has(path)) return { kind: "json" };
  }
  if (API_PREFIX_RE.test(path) || GATEWAY_FIXED_KEY_PATHS.has(path) || GATEWAY_KEY_RE.test(path)) {
    return { kind: "key", gatewayPath: gatewayPathFor(path) };
  }
  return { kind: "not_found" };
}

// The ADMIN-form path the existing gateway code understands (08 §8.1 keeps
// the engine filter of each public prefix). Until the shared pipeline lands,
// /v1/* is /gateway/auto/openai/v1/* and the Anthropic routes use the claude
// protocol.
function gatewayPathFor(path) {
  if (path.startsWith("/gateway/")) return path;
  if (path === "/v1/audio/speech") return "/gateway/tts/openai/v1/audio/speech";
  if (/^\/v1\/messages(?:\/.*)?$/.test(path)) return `/gateway/auto/claude${path}`;
  if (path.startsWith("/anthropic/v1")) return `/gateway/auto/claude${path.slice("/anthropic".length)}`;
  if (path.startsWith("/vllm/v1")) return `/gateway/vllm/openai${path.slice("/vllm".length)}`;
  if (path.startsWith("/llama/v1")) return `/gateway/llama/openai${path.slice("/llama".length)}`;
  return `/gateway/auto/openai${path}`;
}

function sendText(req, res, status, text, headers = {}) {
  const payload = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(payload.length),
    ...headers,
  });
  res.end(String(req.method || "").toUpperCase() === "HEAD" ? undefined : payload);
}

function sendJsonBody(req, res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": String(payload.length),
    ...headers,
  });
  res.end(String(req.method || "").toUpperCase() === "HEAD" ? undefined : payload);
}

/**
 * createPublicListener({ security, gateway, portal, data, logger }) -> { handle(req, res) }
 *   security  createEntrySecurity() result: publicHostnames()
 *   data      createPublicData() result; answers /status.json, /catalog.json,
 *             /announcements.json and /portal-config.json
 * The returned handle never rejects.
 */
function createPublicListener({ security, gateway = null, portal = null, data = null, logger = console } = {}) {
  if (!security || typeof security.publicHostnames !== "function") throw new TypeError("createPublicListener needs the entry security (publicHostnames).");

  async function handle(req, res) {
    // PUBLIC has no ambient credentials: neither sessions nor console-session
    // exist here, so the cookie never reaches any handler.
    delete req.headers.cookie;
    const requestId = newRequestId();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    try {
      // Only an origin-form target is a path here. "//host/x" and "/\host"
      // would parse as another host, and an absolute-form target is no route.
      const target = String(req.url || "/");
      if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return sendPublicError(req, res, "not_found", { requestId });
      let url;
      try {
        url = new URL(target, "http://public.invalid");
      } catch {
        return sendPublicError(req, res, "invalid_request", { requestId });
      }
      const hostname = core.extractHostname(req.headers.host);
      if (!hostname || !security.publicHostnames().has(hostname)) {
        // 421: this listener does not serve that name. No detail is echoed.
        return sendJsonBody(req, res, 421, {
          error: { message: "This host is not served here.", type: "invalid_request_error", code: "host_not_allowed", param: null },
          request_id: requestId,
        });
      }

      const route = classifyPublicRoute(req.method, url.pathname);
      switch (route.kind) {
        case "healthz":
          return sendText(req, res, 200, "ok");
        case "gateway_health":
          return sendJsonBody(req, res, 200, { ok: true, service: "local-ai-gateway", time: new Date().toISOString() });
        case "robots":
          return sendText(req, res, 200, ROBOTS_TXT, { "cache-control": "public, max-age=3600" });
        case "json":
          if (data && typeof data.respond === "function") {
            let body;
            try {
              body = await data.respond(url.pathname, req);
            } catch (error) {
              logger?.error?.(core.redactSecrets(`public data ${url.pathname}: ${error?.message || error}`));
              return sendPublicError(req, res, "service_unavailable", { requestId });
            }
            if (body) return sendJsonBody(req, res, 200, body, JSON_CACHE[url.pathname] || {});
          }
        // falls through: the portal handler may serve it
        case "portal":
        case "asset":
          if (portal && typeof portal.handle === "function" && (await portal.handle(req, res, url, route)) === true) return undefined;
          if (res.headersSent) return undefined;
          return sendPublicError(req, res, "not_found", { requestId });
        case "key":
          if (typeof gateway !== "function") return sendPublicError(req, res, "service_unavailable", { requestId });
          return await gateway(req, res, url, route);
        default:
          return sendPublicError(req, res, "not_found", { requestId });
      }
    } catch (error) {
      logger?.error?.(core.redactSecrets(`public listener: ${error?.stack || error?.message || error}`));
      if (!res.headersSent) return sendPublicError(req, res, "internal_error", { requestId });
      res.destroy();
      return undefined;
    }
  }

  return { handle };
}

module.exports = {
  classifyPublicRoute,
  createPublicListener,
  gatewayPathFor,
};
