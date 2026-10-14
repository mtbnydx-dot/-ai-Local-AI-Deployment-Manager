"use strict";

// Model hub routes (03 §13), mounted for /api/hub/ by one line in the entry's
// route-mount table. HUB-1 serves GET /api/hub/status and GET/PUT
// /api/hub/settings; the later hub packages add their rows to HUB_ROUTES.
// A path this module does not serve falls through to the entry's 404.
//
// Access (03 §13.1). Proxied requests never get here (the entry's proxied-
// request guard answers 404), and 05's pre-dispatch guard has already
// verified any machine signature and held viewers to registered routes. This
// module then decides per principal:
//   - the owner, and system:cli, which 05 makes owner-equivalent, reaches
//     every route; a write still goes through auth.checkWrite();
//   - a signed hub shim (system:hub-shim:<managerId>) reaches SHIM_ROUTES
//     only, anything else is 403 principal_route_forbidden;
//   - a viewer, and system:mcp, reaches the GET rows of HUB_VIEWER_ROUTES.
//     Their redaction is applied centrally by the entry's sendJson (05 §5.4),
//     or here when the caller arrived without the guard's req.viewer.
// Errors use the 00 §4.2 envelope. Request bodies are capped at 64 KiB.

const { redactSecrets } = require("../../manager-core/secret-redactor");

const OWNER = "03";
const PREFIX = "/api/hub/";
const MAX_BODY_BYTES = 64 * 1024;
const READ_METHODS = new Set(["GET", "HEAD"]);
const SHIM_PRINCIPAL_RE = /^system:hub-shim:(vllm|llama)$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function omit(object, key) {
  const out = { ...object };
  delete out[key];
  return out;
}

// 03 §13.1: the viewer copy of the status drops cli.*.path, dataDir and
// dataErrors[].file; everything else is counts, states and codes.
function redactHubStatusForViewer(body) {
  if (!isPlainObject(body)) return body;
  const out = omit(body, "dataDir");
  if (isPlainObject(body.cli)) {
    out.cli = Object.fromEntries(Object.entries(body.cli).map(([name, info]) => [name, isPlainObject(info) ? omit(info, "path") : info]));
  }
  if (Array.isArray(body.dataErrors)) out.dataErrors = body.dataErrors.map((item) => (isPlainObject(item) ? omit(item, "file") : item));
  return out;
}

// Every route this module serves.
const HUB_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hub/status", handler: "status" }),
  Object.freeze({ method: "GET", path: "/api/hub/settings", handler: "getSettings" }),
  Object.freeze({ method: "PUT", path: "/api/hub/settings", handler: "putSettings" }),
]);

// The viewer registrations of 03 §13.1, registered at mount. Settings hold
// no secret, so their viewer copy is the owner's.
const HUB_VIEWER_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hub/status", redact: redactHubStatusForViewer }),
  Object.freeze({ method: "GET", path: "/api/hub/settings", redact: null }),
]);

// Declared owner-only, so 05's route inventory sees them.
const HUB_ADMIN_ONLY_ROUTES = Object.freeze([
  Object.freeze({ method: "PUT", path: "/api/hub/settings" }),
]);

// The hub calls a manager shim may make (03 §15 table); the shim rows of
// later packages are added here with their routes.
const SHIM_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hub/settings" }),
  Object.freeze({ method: "PUT", path: "/api/hub/settings" }),
]);

function routeKey(method, path) {
  return `${String(method || "GET").toUpperCase()} ${path}`;
}

const SHIM_ROUTE_KEYS = new Set(SHIM_ROUTES.map((route) => routeKey(route.method, route.path)));

function errorBody(code, message, extra = {}) {
  const { hint, docs, details, errors } = extra;
  return {
    ok: false,
    error: { code, message, ...(hint ? { hint } : {}), ...(docs ? { docs } : {}), ...(details ? { details } : {}) },
    ...(Array.isArray(errors) && errors.length ? { errors } : {}),
  };
}

/**
 * Who is calling, in the terms of 03 §13.1:
 * { kind: "owner"|"shim"|"reader"|"viewer"|"machine"|"none", principal, managerId?, redact }.
 * "reader" is system:mcp (viewer routes, unredacted as 05 serves it);
 * "machine" is any other machine principal, which reaches no hub route.
 */
function resolveHubPrincipal(auth, req) {
  let who = {};
  try {
    who = auth.principal(req) || {};
  } catch {
    who = {};
  }
  const principal = String(who.principal || "");
  if (who.role === "owner") return { kind: "owner", principal, redact: Boolean(who.redact) };
  if (who.role === "system") {
    const shim = SHIM_PRINCIPAL_RE.exec(principal);
    if (shim) return { kind: "shim", principal, managerId: shim[1], redact: false };
    if (principal === "system:cli") return { kind: "owner", principal, redact: false };
    if (principal === "system:mcp") return { kind: "reader", principal, redact: false };
    return { kind: "machine", principal, redact: false };
  }
  if (who.role === "viewer") return { kind: "viewer", principal, redact: true };
  return { kind: "none", principal, redact: true };
}

function defaultSendJson(res, data, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

// A minimal JSON object reader for use outside the entry; the entry passes
// its own readJsonObjectBody, which also takes the guard's pre-read body.
async function defaultReadJsonObjectBody(req, maxBytes) {
  let buffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
  if (!buffer) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("Request body too large.");
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
  }
  if (buffer.length > maxBytes) {
    const error = new Error("Request body too large.");
    error.status = 413;
    throw error;
  }
  if (!buffer.length) return {};
  let data = null;
  try {
    data = JSON.parse(buffer.toString("utf8"));
  } catch {
    data = null;
  }
  if (!isPlainObject(data)) {
    const error = new Error("Request body must be a JSON object.");
    error.status = 400;
    throw error;
  }
  return data;
}

/**
 * createHubRoutes({ hub, auth, sendJson, readJsonObjectBody, logger })
 * → { handle(req, res, url) → Promise<boolean> }. `auth` is the entry's
 * request-auth seam (07 §2.9); `hub` may be null, and the routes then answer
 * 503 hub_unavailable.
 */
function createHubRoutes(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new TypeError("createHubRoutes needs the request-auth seam");
  }
  const hub = options.hub || null;
  const sendJson = typeof options.sendJson === "function" ? options.sendJson : defaultSendJson;
  const readJsonObjectBody = typeof options.readJsonObjectBody === "function" ? options.readJsonObjectBody : defaultReadJsonObjectBody;
  const logger = options.logger || console;
  const maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : MAX_BODY_BYTES;

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  }

  function sendError(res, status, code, message, extra) {
    sendJson(res, errorBody(code, message, extra), status);
  }

  // A redacting caller that did not come through 05's guard has no
  // req.viewer, so sendJson would not redact; the registered redaction is
  // applied here instead. A body no viewer entry covers is never sent.
  function sendRead(req, res, pathname, body, who) {
    if (!who.redact || req.viewer) {
      sendJson(res, body);
      return;
    }
    let out;
    try {
      out = auth.redactFor(req, pathname, body);
    } catch (error) {
      warn(`hub-routes: no viewer redaction for ${pathname}; the body is not sent: ${error?.message || error}`);
      sendError(res, 500, "internal_error", "Service entry error.");
      return;
    }
    sendJson(res, out);
  }

  // null when allowed, otherwise [status, code, message, extra].
  function refusal(req, route, who) {
    const write = !READ_METHODS.has(route.method);
    if (who.kind === "none") {
      return [401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" }];
    }
    if (who.kind === "shim" && !SHIM_ROUTE_KEYS.has(routeKey(route.method, route.path))) {
      return [403, "principal_route_forbidden", `${who.principal} may not call ${route.method} ${route.path}.`];
    }
    if (who.kind === "machine") {
      return [403, "principal_route_forbidden", `${who.principal || "This principal"} may not call ${route.method} ${route.path}.`];
    }
    if (write) {
      if (who.kind === "reader") return [403, "principal_route_forbidden", `${who.principal} may only read hub routes.`];
      let allowed = null;
      try {
        allowed = auth.checkWrite(req) || {};
      } catch {
        allowed = { ok: false, status: 401, code: "admin_session_required" };
      }
      if (allowed.ok) return null;
      return [Number(allowed.status) || 403, String(allowed.code || "management_local_only"), String(allowed.message || "This action needs the console owner.")];
    }
    if (who.kind === "viewer" || who.kind === "reader") {
      let found = null;
      try {
        found = auth.viewerRegistry.match(route.method, route.path);
      } catch {
        found = null;
      }
      if (!found || found.access !== "viewer") {
        return [401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" }];
      }
    }
    return null;
  }

  const handlers = {
    status(req, res, url, who) {
      sendRead(req, res, url.pathname, hub.status(), who);
    },

    async getSettings(req, res, url, who) {
      const settings = await hub.settings.get();
      sendRead(req, res, url.pathname, { ok: true, settings }, who);
    },

    // PUT takes a partial patch, bare or as { settings }, and answers the
    // full settings (03 §14). A shim's signed body also carries origin
    // (03 §15), which is request metadata, not a setting.
    async putSettings(req, res) {
      let body;
      try {
        body = await readJsonObjectBody(req, maxBodyBytes);
      } catch (error) {
        if (Number(error?.status) === 413) {
          sendError(res, 413, "request_too_large", `The request body may be at most ${maxBodyBytes} bytes.`);
        } else {
          sendError(res, 400, "invalid_json", "The request body must be a JSON object.");
        }
        return;
      }
      const patch = isPlainObject(body.settings) ? { ...body.settings } : { ...body };
      delete patch.origin;
      let result;
      try {
        result = await hub.settings.update(patch);
      } catch (error) {
        warn(`hub-routes: saving the hub settings failed: ${error?.message || error}`);
        sendError(res, 500, "settings_write_failed", "The hub settings could not be saved.", { hint: "Check that the service-entry data folder is writable, then try again." });
        return;
      }
      if (result?.ok) {
        sendJson(res, { ok: true, settings: result.settings });
        return;
      }
      if (result?.code === "settings_invalid") {
        sendError(res, 400, "settings_invalid", "Some hub settings are not valid; nothing was saved.", { errors: result.errors });
        return;
      }
      sendError(res, 503, "hub_unavailable", "The model hub is not running.", { hint: "Restart service-entry and check its log for the hub start error." });
    },
  };

  async function handle(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (!pathname.startsWith(PREFIX)) return false;
    const rows = HUB_ROUTES.filter((route) => route.path === pathname);
    if (!rows.length) return false;
    const requested = String(req.method || "GET").toUpperCase();
    const method = requested === "HEAD" ? "GET" : requested;
    const route = rows.find((row) => row.method === method);
    if (!route) {
      sendJson(res, errorBody("method_not_allowed", `${requested} is not supported on ${pathname}.`), 405, { allow: rows.map((row) => row.method).join(", ") });
      return true;
    }
    const who = resolveHubPrincipal(auth, req);
    const refused = refusal(req, route, who);
    if (refused) {
      req.resume?.();
      sendError(res, ...refused);
      return true;
    }
    if (!hub) {
      req.resume?.();
      sendError(res, 503, "hub_unavailable", "The model hub is not running.", { hint: "Restart service-entry and check its log for the hub start error." });
      return true;
    }
    await handlers[route.handler](req, res, url, who);
    return true;
  }

  return { handle };
}

// Registers HUB_VIEWER_ROUTES and the owner-only declarations in 05's
// registry. An entry that cannot be registered stays owner-only (deny by
// default) and is logged.
function registerHubRoutes(registry, warn = () => {}) {
  const registrations = [
    ...HUB_VIEWER_ROUTES.map((route) => () => registry.registerRoute({ owner: OWNER, method: route.method, path: route.path, ...(route.redact ? { redact: route.redact } : {}) })),
    ...HUB_ADMIN_ONLY_ROUTES.map((route) => () => registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path })),
  ];
  for (const register of registrations) {
    try {
      register();
    } catch (error) {
      warn(`hub-routes: a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

// Route module (07 §2.7). server.js builds the hub and puts it on ctx.hub
// before mounting. The mount turns on the console's hub area (bootstrap
// features.hub) only when a hub is behind the routes.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("hub-routes: ctx.auth is missing");
  }
  const logger = ctx.logger || console;
  const warn = (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the mount.
    }
  };
  registerHubRoutes(auth.viewerRegistry, warn);
  const hub = ctx.hub || null;
  const routes = createHubRoutes({ hub, auth, sendJson: ctx.sendJson, readJsonObjectBody: ctx.readJsonObjectBody, logger });
  if (!ctx.features || typeof ctx.features !== "object") ctx.features = {};
  ctx.features.hub = Boolean(hub);
  return {
    handle: routes.handle,
    close() {
      // The hub belongs to server.js, which stops it in shutdownSoon().
    },
  };
}

module.exports = {
  HUB_ADMIN_ONLY_ROUTES,
  HUB_ROUTES,
  HUB_VIEWER_ROUTES,
  MAX_BODY_BYTES,
  SHIM_ROUTES,
  createHubRoutes,
  mount,
  name: "hub",
  redactHubStatusForViewer,
  registerHubRoutes,
  resolveHubPrincipal,
};
