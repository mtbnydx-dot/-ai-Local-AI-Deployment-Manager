"use strict";

// Model hub routes (03 §13), mounted for /api/hub/ by one line in the entry's
// route-mount table. HUB-1 serves GET /api/hub/status and GET/PUT
// /api/hub/settings; HUB-8 adds the library list, detail, rescan, verify and
// identify routes and the task poll. The later hub packages add their rows to
// HUB_ROUTES; a path may name segments (/api/hub/library/:id).
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
const { HubError, toEnvelope } = require("../../manager-core/model-hub/errors");

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

// 03 §13.1: a viewer sees the library with root-relative paths ("Library
// F/Qwen-Qwen3.8-27B-FP8"), never the absolute path or an alias. The entry
// carries the display forms (displayPath, aliasDisplay) next to the real ones;
// the viewer copy swaps them in and drops the extras.
function redactLibraryEntryForViewer(entry) {
  if (!isPlainObject(entry)) return entry;
  const out = omit(omit(omit(entry, "displayPath"), "aliasDisplay"), "internal");
  out.path = typeof entry.displayPath === "string" ? entry.displayPath : String(entry.rootLabel || "(library)") + "/" + String(entry.relativePath || "");
  out.aliases = Array.isArray(entry.aliasDisplay) ? entry.aliasDisplay.map((item) => String(item)) : [];
  return out;
}

// A viewer sees the roots by label; the folder behind a root stays private.
function redactLibraryRootForViewer(root) {
  return isPlainObject(root) ? omit(root, "path") : root;
}

function redactLibraryListForViewer(body) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  if (Array.isArray(body.entries)) out.entries = body.entries.map(redactLibraryEntryForViewer);
  if (Array.isArray(body.roots)) out.roots = body.roots.map(redactLibraryRootForViewer);
  return out;
}

function redactLibraryDetailForViewer(body) {
  if (!isPlainObject(body)) return body;
  return isPlainObject(body.entry) ? { ...body, entry: redactLibraryEntryForViewer(body.entry) } : body;
}

// A task keeps its progress and a short error message; error.detail (a stack
// or a path) is dropped.
function redactHubTask(task) {
  if (!isPlainObject(task)) return task;
  return isPlainObject(task.error) ? { ...task, error: omit(task.error, "detail") } : task;
}

function redactHubTaskBodyForViewer(body) {
  if (!isPlainObject(body)) return body;
  return isPlainObject(body.task) ? { ...body, task: redactHubTask(body.task) } : body;
}

// The `library` event for viewers: entry ids and task progress only.
function redactLibraryEventForViewer(data) {
  if (!isPlainObject(data)) return null;
  if (data.kind === "task") return { ...data, task: redactHubTask(data.task) };
  return data;
}

// 03 §12: the GET auth rows give a viewer only whether the login works and
// whether access is granted; names, orgs and the authorization link stay with
// the owner.
function redactHfAuthForViewer(body) {
  return isPlainObject(body) ? { ok: body.ok, connected: Boolean(body.connected) } : body;
}

function redactHfAccessForViewer(body) {
  return isPlainObject(body) ? { ok: body.ok, granted: Boolean(body.granted), status: body.status } : body;
}

// Every route this module serves.
const HUB_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hub/status", handler: "status" }),
  Object.freeze({ method: "GET", path: "/api/hub/settings", handler: "getSettings" }),
  Object.freeze({ method: "PUT", path: "/api/hub/settings", handler: "putSettings" }),
  Object.freeze({ method: "GET", path: "/api/hub/library", handler: "libraryList" }),
  Object.freeze({ method: "POST", path: "/api/hub/library/rescan", handler: "libraryRescan" }),
  Object.freeze({ method: "GET", path: "/api/hub/library/:id", handler: "libraryGet" }),
  Object.freeze({ method: "POST", path: "/api/hub/library/:id/verify", handler: "libraryVerify" }),
  Object.freeze({ method: "POST", path: "/api/hub/library/:id/identify", handler: "libraryIdentify" }),
  Object.freeze({ method: "GET", path: "/api/hub/tasks/:id", handler: "taskGet" }),
  Object.freeze({ method: "GET", path: "/api/hub/auth/huggingface", handler: "authStatus" }),
  Object.freeze({ method: "POST", path: "/api/hub/auth/huggingface/login", handler: "authLogin" }),
  Object.freeze({ method: "GET", path: "/api/hub/auth/huggingface/access", handler: "authAccess" }),
  Object.freeze({ method: "POST", path: "/api/hub/sources/probe", handler: "sourcesProbe" }),
]);

// "/api/hub/library/:id" → a matcher for the pathname; named segments are one
// path segment each.
function compileRoutePath(pattern) {
  const names = [];
  const parts = pattern.split("/").slice(1).map((segment) => {
    if (segment.startsWith(":")) {
      names.push(segment.slice(1));
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp(`^/${parts.join("/")}$`), names };
}

const ROUTE_MATCHERS = HUB_ROUTES.map((route) => ({ route, ...compileRoutePath(route.path) }));

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Every row whose path matches the pathname, with the named segments of the
// first match (a literal segment and a named one never both match the same
// request in this table).
function matchRoutes(pathname) {
  const rows = [];
  let params = {};
  for (const matcher of ROUTE_MATCHERS) {
    const found = matcher.regex.exec(pathname);
    if (!found) continue;
    if (!rows.length) params = Object.fromEntries(matcher.names.map((name, index) => [name, decodeSegment(found[index + 1])]));
    rows.push(matcher.route);
  }
  return { rows, params };
}

// The viewer registrations of 03 §13.1, registered at mount. Settings hold
// no secret, so their viewer copy is the owner's.
const HUB_VIEWER_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hub/status", redact: redactHubStatusForViewer }),
  Object.freeze({ method: "GET", path: "/api/hub/settings", redact: null }),
  Object.freeze({ method: "GET", path: "/api/hub/library", redact: redactLibraryListForViewer }),
  Object.freeze({ method: "GET", path: "/api/hub/library/:id", redact: redactLibraryDetailForViewer }),
  Object.freeze({ method: "GET", path: "/api/hub/tasks/:id", redact: redactHubTaskBodyForViewer }),
  Object.freeze({ method: "GET", path: "/api/hub/auth/huggingface", redact: redactHfAuthForViewer }),
  Object.freeze({ method: "GET", path: "/api/hub/auth/huggingface/access", redact: redactHfAccessForViewer }),
]);

// Event types a viewer may receive (03 §13.1), with their redaction.
const HUB_VIEWER_EVENTS = Object.freeze([
  Object.freeze({ type: "library", redact: redactLibraryEventForViewer }),
]);

// Declared owner-only, so 05's route inventory sees them.
const HUB_ADMIN_ONLY_ROUTES = Object.freeze([
  Object.freeze({ method: "PUT", path: "/api/hub/settings" }),
  Object.freeze({ method: "POST", path: "/api/hub/library/rescan" }),
  Object.freeze({ method: "POST", path: "/api/hub/library/:id/verify" }),
  Object.freeze({ method: "POST", path: "/api/hub/library/:id/identify" }),
  Object.freeze({ method: "POST", path: "/api/hub/auth/huggingface/login" }),
  Object.freeze({ method: "POST", path: "/api/hub/sources/probe" }),
]);

// The hub calls a manager shim may make (03 §15 table); the shim rows of
// later packages are added here with their routes.
const SHIM_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/hub/settings" }),
  Object.freeze({ method: "PUT", path: "/api/hub/settings" }),
  // Login and probe are things the managers already did locally; the login
  // (like a token) additionally needs the signed origin.clientLocal (03 §12).
  Object.freeze({ method: "GET", path: "/api/hub/auth/huggingface" }),
  Object.freeze({ method: "POST", path: "/api/hub/auth/huggingface/login" }),
  Object.freeze({ method: "GET", path: "/api/hub/auth/huggingface/access" }),
  Object.freeze({ method: "POST", path: "/api/hub/sources/probe" }),
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
  const network = typeof who.network === "string" ? who.network : "";
  const via = typeof who.via === "string" ? who.via : "";
  if (who.role === "owner") return { kind: "owner", principal, network, via, redact: Boolean(who.redact) };
  if (who.role === "system") {
    const shim = SHIM_PRINCIPAL_RE.exec(principal);
    if (shim) return { kind: "shim", principal, managerId: shim[1], redact: false };
    if (principal === "system:cli") return { kind: "owner", principal, network: "", via, redact: false };
    if (principal === "system:mcp") return { kind: "reader", principal, redact: false };
    return { kind: "machine", principal, redact: false };
  }
  if (who.role === "viewer") return { kind: "viewer", principal, redact: true };
  return { kind: "none", principal, redact: true };
}

// --- local-only credentials (03 §12, §13.1) -------------------------------------

const LOOPBACK_ADDRESS_RE = /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/i;
const FORWARDING_HEADERS = Object.freeze(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via"]);

// The socket itself is on the loopback interface and no proxy header says
// otherwise. The principal's own network verdict is checked as well; this is
// the second, independent look.
function isLoopbackSocket(req) {
  const address = String(req?.socket?.remoteAddress || "");
  if (!LOOPBACK_ADDRESS_RE.test(address)) return false;
  const headers = req?.headers || {};
  return !FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/**
 * True when this caller may open the Hugging Face login window or send
 * credential.hfToken: an owner on a loopback, non-proxied socket (a LAN
 * owner session is not enough), the CLI principal (its signature already
 * needs a loopback socket), or a signed hub shim whose body says
 * origin.clientLocal is true, which is the manager verdict on its own
 * caller (03 §15).
 */
function tokenAllowed(req, who, body) {
  if (!who) return false;
  if (who.kind === "shim") return isPlainObject(body) && isPlainObject(body.origin) && body.origin.clientLocal === true;
  if (who.kind !== "owner") return false;
  if (!isLoopbackSocket(req)) return false;
  return who.network === "loopback" || who.via === "loopback" || who.via === "hmac";
}

function tokenRequiresLocal(what) {
  return new HubError("token_requires_local", `${what} is only available from this machine.`, {
    status: 403,
    hint: "Open the console on the machine that runs the platform, or use hf auth login in a local terminal.",
  });
}

/**
 * The credential of a request body, as the job transfer options carry it
 * (03 §12): null when the body has no credential.hfToken, otherwise
 * { credentialMode: "temp-token", tokenRef, remember } after the token went
 * into the vault. The token itself is never returned or logged.
 * Throws HubError: 403 token_requires_local (checked before anything else
 * about the token), 400 invalid_request, 422 invalid_token or 422
 * remember_unavailable. POST /plan, /downloads and /downloads/:id/resume
 * call this.
 */
async function acceptHubCredential({ hub, req, who, body }) {
  const credential = isPlainObject(body) ? body.credential : undefined;
  if (credential === undefined || credential === null) return null;
  if (!isPlainObject(credential)) {
    throw new HubError("invalid_request", "credential must be an object.", { status: 400, details: { field: "credential" } });
  }
  const hasToken = credential.hfToken !== undefined && credential.hfToken !== null && credential.hfToken !== "";
  if (hasToken && !tokenAllowed(req, who, body)) throw tokenRequiresLocal("A Hugging Face token");
  if (credential.remember !== undefined && typeof credential.remember !== "boolean") {
    throw new HubError("invalid_request", "credential.remember must be true or false.", { status: 400, details: { field: "credential.remember" } });
  }
  if (!hasToken) {
    if (credential.remember === true) {
      throw new HubError("invalid_request", "credential.remember needs credential.hfToken.", { status: 400, details: { field: "credential.hfToken" } });
    }
    return null;
  }
  if (typeof credential.hfToken !== "string") {
    throw new HubError("invalid_request", "credential.hfToken must be a string.", { status: 400, details: { field: "credential.hfToken" } });
  }
  if (!hub?.tokens) throw new HubError("hub_unavailable", "The model hub is not running.", { status: 503 });
  const remember = credential.remember === true;
  const tokenRef = await hub.tokens.put(credential.hfToken, { remember });
  return { credentialMode: "temp-token", tokenRef, remember };
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

  // A body for the POST routes: {} when empty; false after answering 4xx.
  async function readBody(req, res) {
    try {
      return await readJsonObjectBody(req, maxBodyBytes);
    } catch (error) {
      if (Number(error?.status) === 413) {
        sendError(res, 413, "request_too_large", `The request body may be at most ${maxBodyBytes} bytes.`);
      } else {
        sendError(res, 400, "invalid_json", "The request body must be a JSON object.");
      }
      return false;
    }
  }

  // The registry's own errors carry their status, code and hint; anything
  // else is an internal error whose text is logged, not sent.
  function sendLibraryError(res, error, what) {
    if (error && error.name === "LibraryError") {
      sendError(res, Number(error.status) || 400, error.code, error.message, { hint: error.hint, details: error.details });
      return;
    }
    warn(`hub-routes: ${what} failed: ${error?.message || error}`);
    sendError(res, 500, "internal_error", "Service entry error.");
  }

  // A HubError carries its status, code and hint (errors.js toEnvelope
  // redacts the text); anything else is an internal error that is logged, not
  // sent.
  function sendHubError(res, error, what) {
    if (error instanceof HubError) {
      const { status, body } = toEnvelope(error);
      sendJson(res, body, status);
      return;
    }
    warn(`hub-routes: ${what} failed: ${error?.message || error}`);
    sendError(res, 500, "internal_error", "Service entry error.");
  }

  function libraryOrFail(res) {
    if (hub.library) return hub.library;
    sendError(res, 503, "hub_unavailable", "The model library is not available.", { hint: "Restart service-entry and check its log for the hub start error." });
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

    async libraryList(req, res, url, who) {
      const library = libraryOrFail(res);
      if (!library) return;
      const query = {};
      for (const key of ["q", "rootId", "format", "provenance", "duplicates", "cursor", "limit"]) {
        const value = url.searchParams.get(key);
        if (value !== null) query[key] = value;
      }
      let result;
      try {
        result = await library.list(query);
      } catch (error) {
        sendLibraryError(res, error, "listing the library");
        return;
      }
      sendRead(req, res, url.pathname, { ok: true, ...result }, who);
    },

    async libraryGet(req, res, url, who, params) {
      const library = libraryOrFail(res);
      if (!library) return;
      const entry = library.get(params.id);
      if (!entry) {
        sendError(res, 404, "library_entry_not_found", "No such library entry.");
        return;
      }
      sendRead(req, res, url.pathname, { ok: true, entry }, who);
    },

    async libraryRescan(req, res) {
      const library = libraryOrFail(res);
      if (!library) return;
      const body = await readBody(req, res);
      if (body === false) return;
      try {
        const started = await library.rescan({ rootIds: body.rootIds === undefined ? null : body.rootIds });
        sendJson(res, { ok: true, taskId: started.taskId, task: started.task }, 202);
      } catch (error) {
        sendLibraryError(res, error, "starting a rescan");
      }
    },

    async libraryVerify(req, res, url, who, params) {
      const library = libraryOrFail(res);
      if (!library) return;
      const body = await readBody(req, res);
      if (body === false) return;
      if (body.checksums !== undefined && typeof body.checksums !== "boolean") {
        sendError(res, 400, "invalid_request", "checksums must be true or false.", { details: { field: "checksums" } });
        return;
      }
      try {
        const started = library.verify(params.id, { checksums: body.checksums === true });
        sendJson(res, { ok: true, taskId: started.taskId, task: started.task }, 202);
      } catch (error) {
        sendLibraryError(res, error, "starting a verification");
      }
    },

    async libraryIdentify(req, res, url, who, params) {
      const library = libraryOrFail(res);
      if (!library) return;
      const body = await readBody(req, res);
      if (body === false) return;
      for (const field of ["provider", "repo"]) {
        if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
          sendError(res, 400, "invalid_request", `${field} must be a string.`, { details: { field } });
          return;
        }
      }
      try {
        const entry = await library.identify(params.id, { provider: body.provider, repo: body.repo, force: body.force === true });
        sendJson(res, { ok: true, entry });
      } catch (error) {
        sendLibraryError(res, error, "identifying a library entry");
      }
    },

    async taskGet(req, res, url, who, params) {
      const task = hub.tasks?.get(params.id) || null;
      if (!task) {
        sendError(res, 404, "task_not_found", "No such task.");
        return;
      }
      sendRead(req, res, url.pathname, { ok: true, task }, who);
    },

    // 03 §12. The status never carries a token; a viewer gets { connected }.
    async authStatus(req, res, url, who) {
      let status;
      try {
        status = await hub.auth.status();
      } catch (error) {
        sendHubError(res, error, "reading the Hugging Face login status");
        return;
      }
      sendRead(req, res, url.pathname, { ok: true, ...status }, who);
    },

    // The login runs in a local PowerShell window; the token never passes
    // through this process. Loopback owner (or a clientLocal shim) only.
    async authLogin(req, res, url, who) {
      const body = await readBody(req, res);
      if (body === false) return;
      if (!tokenAllowed(req, who, body)) {
        sendHubError(res, tokenRequiresLocal("The Hugging Face login"), "login");
        return;
      }
      try {
        const launched = hub.auth.login();
        sendJson(res, { ok: true, launched: Boolean(launched?.launched), tokenUrl: launched?.tokenUrl || "https://huggingface.co/settings/tokens" });
      } catch (error) {
        sendHubError(res, error, "opening the Hugging Face login window");
      }
    },

    async authAccess(req, res, url, who) {
      const repo = url.searchParams.get("repo");
      if (!repo) {
        sendError(res, 400, "invalid_request", "repo is required.", { details: { field: "repo" } });
        return;
      }
      let result;
      try {
        result = await hub.auth.access({ repo, artifactKey: url.searchParams.get("artifactKey") || "", revision: url.searchParams.get("revision") || "main" });
      } catch (error) {
        sendHubError(res, error, "checking Hugging Face access");
        return;
      }
      sendRead(req, res, url.pathname, { ok: true, ...result }, who);
    },

    async sourcesProbe(req, res) {
      const body = await readBody(req, res);
      if (body === false) return;
      for (const field of ["repo", "artifactKey"]) {
        if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
          sendError(res, 400, "invalid_request", `${field} must be a string.`, { details: { field } });
          return;
        }
      }
      try {
        const result = await hub.sources.probe({ repo: body.repo || "", artifactKey: body.artifactKey || "", refresh: body.refresh === true });
        const { ok: reachable, ...rest } = result;
        sendJson(res, { ok: true, reachable, ...rest });
      } catch (error) {
        sendHubError(res, error, "probing the sources");
      }
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
    const { rows, params } = matchRoutes(pathname);
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
    await handlers[route.handler](req, res, url, who, params);
    return true;
  }

  return { handle, acceptCredential: (args) => acceptHubCredential({ hub, ...args }) };
}

// Registers HUB_VIEWER_ROUTES and the owner-only declarations in 05's
// registry. An entry that cannot be registered stays owner-only (deny by
// default) and is logged.
function registerHubRoutes(registry, warn = () => {}) {
  const registrations = [
    ...HUB_VIEWER_ROUTES.map((route) => () => registry.registerRoute({ owner: OWNER, method: route.method, path: route.path, ...(route.redact ? { redact: route.redact } : {}) })),
    ...HUB_ADMIN_ONLY_ROUTES.map((route) => () => registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path })),
    ...HUB_VIEWER_EVENTS.map((event) => () => registry.registerEventType({ owner: OWNER, type: event.type, redact: event.redact })),
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
  HUB_VIEWER_EVENTS,
  HUB_VIEWER_ROUTES,
  MAX_BODY_BYTES,
  SHIM_ROUTES,
  createHubRoutes,
  mount,
  name: "hub",
  acceptHubCredential,
  isLoopbackSocket,
  redactHfAccessForViewer,
  redactHfAuthForViewer,
  redactHubStatusForViewer,
  redactHubTaskBodyForViewer,
  redactLibraryDetailForViewer,
  redactLibraryEntryForViewer,
  redactLibraryEventForViewer,
  redactLibraryListForViewer,
  registerHubRoutes,
  resolveHubPrincipal,
  tokenAllowed,
};
