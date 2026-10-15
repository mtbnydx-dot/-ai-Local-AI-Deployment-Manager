"use strict";

// The PUBLIC listener's router (05 §3.2). The route table is exhaustive and
// structural: /api/*, /internal/*, /billing*, /classic*, the admin /docs/*.md,
// the TTS UI, /gateway/mcp* and /gateway/search/* are simply not in it, so
// they answer 404 here whatever the ADMIN listener serves.
//
// PUB-6 owns the skeleton: the Host allowlist, the cookie rule, /healthz,
// /gateway/health, /robots.txt and the route classification. What answers a
// route is injected, so later packages plug in without touching the table:
//   deps.gateway(req, res, url, route)   key routes (the shared pipeline, 08);
//                                        route.gatewayPath is the ADMIN-form path
//                                        and route.api the §8.1 mapping
//                                        (lib/public-api.js, PUB-12)
//   deps.portal.handle(req, res, url, route) -> boolean   portal shell,
//                                        /assets/<buildId>/*, the *.json routes
//                                        (lib/portal-routes.js, PUB-15: the asset
//                                        snapshot, import map, CSP and 410)
//   deps.portal.errorStylesheets() -> string[]   optional: the portal CSS for the
//                                        server-rendered 404 page
//   deps.preAuth(req, res, route) -> boolean   the ban check and the per-IP
//                                  bucket (05 §9.2) before the JSON routes;
//                                  true when it answered. Key routes run it in
//                                  the gateway handler, after the record starts.
//   deps.data.respond(pathname, req) -> object|null   the four portal JSON
//                                        documents (status-sampler.js, PUB-14)
//   deps.probeRecorder.observe(nonce, observation)   the external probe's nonce
//                                        recorder (exposure-scan.js, PUB-19): a
//                                        GET /status.json?probe=<nonce> that the
//                                        probe registered is recorded with the
//                                        socket and header PUBLIC saw
// A route nobody serves yet answers like any unknown path (404) for the
// portal, and 503 service_unavailable for the key routes.

const core = require("../../manager-core");
const { gatewayPathFor, mapPublicRoute } = require("./public-api");
const { newRequestId, sendPublicError } = require("./public-errors");

const PORTAL_SHELL_PATHS = new Set(["/", "/status", "/models", "/docs", "/me", "/playground", "/announcements"]);
const PORTAL_JSON_PATHS = new Set(["/portal-config.json", "/status.json", "/catalog.json", "/announcements.json"]);
// The external probe (05 §13.3) asks for this document with ?probe=<nonce>.
const PROBE_JSON_PATH = "/status.json";
const MODEL_PAGE_RE = /^\/models\/[^/]+$/;
const DOC_PAGE_RE = /^\/docs\/[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_RE = /^\/assets\/[A-Za-z0-9._-]+\/.+$/;
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
// "portal" (shell), "asset", "json" (portal data), "key" (needs an API key),
// "method_not_allowed" (a key route with the wrong method; `allow` lists the
// right ones) or "not_found". Pure; only the method and the path decide. A
// key route carries its §8.1 mapping as `api` and the ADMIN-form path as
// `gatewayPath`.
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
  const api = mapPublicRoute(verb, path);
  if (!api) return { kind: "not_found" };
  if (api.methodNotAllowed) return { kind: "method_not_allowed", allow: api.allow };
  return { kind: "key", gatewayPath: api.gatewayPath, api };
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
function createPublicListener({ security, gateway = null, portal = null, data = null, preAuth = null, probeRecorder = null, logger = console } = {}) {
  if (!security || typeof security.publicHostnames !== "function") throw new TypeError("createPublicListener needs the entry security (publicHostnames).");

  // The portal CSS for the HTML error pages; never throws.
  function portalStylesheets() {
    try {
      return typeof portal?.errorStylesheets === "function" ? portal.errorStylesheets() : [];
    } catch {
      return [];
    }
  }

  // §13.3: remembers how a probe request arrived (which socket, which trusted
  // header). Only nonces the admin probe registered are kept; it never throws
  // and never changes the response.
  function recordProbe(req, url) {
    try {
      const nonce = url.searchParams.get("probe");
      if (!nonce || !probeRecorder || typeof probeRecorder.observe !== "function" || typeof security.identifyClient !== "function") return;
      const identity = security.identifyClient(req);
      probeRecorder.observe(nonce, {
        socketIp: identity.socketIp,
        viaProxy: identity.viaProxy,
        headerUsed: identity.headerUsed,
        country: identity.country,
        forwardedOnUntrusted: identity.forwardedOnUntrusted,
      });
    } catch {
      // The probe is advisory.
    }
  }

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
      const notFound = () => sendPublicError(req, res, "not_found", { requestId, stylesheets: portalStylesheets() });
      switch (route.kind) {
        case "healthz":
          return sendText(req, res, 200, "ok");
        case "gateway_health":
          return sendJsonBody(req, res, 200, { ok: true, service: "local-ai-gateway", time: new Date().toISOString() });
        case "robots":
          return sendText(req, res, 200, ROBOTS_TXT, { "cache-control": "public, max-age=3600" });
        case "json":
          if (url.pathname === PROBE_JSON_PATH) recordProbe(req, url);
          if (typeof preAuth === "function" && (await preAuth(req, res, route)) === true) return undefined;
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
          return notFound();
        case "method_not_allowed":
          return sendPublicError(req, res, "method_not_allowed", { requestId, headers: { allow: route.allow } });
        case "key":
          if (typeof gateway !== "function") return sendPublicError(req, res, "service_unavailable", { requestId });
          return await gateway(req, res, url, route);
        default:
          return notFound();
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
