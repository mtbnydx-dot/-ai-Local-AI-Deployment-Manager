"use strict";

// Request-auth seam (07 §2.9).
//
// Every entry module asks this one object who the caller is, whether it may
// write, which event types it may receive and how a viewer's body is
// redacted. Modules never call security.checkManagementAccess themselves.
//
// Until 05's admin sessions (PUB-5) and viewer allowlist (PUB-25) land, the
// seam reproduces today's rule: owner iff checkManagementAccess passes,
// otherwise a viewer whose reads are redacted. It carries a built-in subset
// of 05's registry with the same method names. When 05 lands it passes its
// adminAuth and registry in (here or through attach()); the seam then only
// delegates, and registrations already made here are replayed into 05's
// registry before 05 freezes it. Modules need no change either way.

const core = require("../../manager-core");

const ROLES = new Set(["owner", "system", "viewer", "none"]);
const REGISTRATION_METHODS = Object.freeze(["registerRoute", "registerReadOnlyPost", "registerAdminOnly", "registerEventType"]);
const REGISTRY_METHODS = Object.freeze([
  ...REGISTRATION_METHODS,
  "match",
  "viewerEventTypes",
  "redactEvent",
  "inventory",
  "freeze",
]);
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

// 05 §5.4 baseline, `status` event: the event is an invalidation hint
// ({reason, managerId?, ok?, offline?}, 07 §15.2), never a full snapshot, so
// the viewer copy is an allowlist of those fields.
function redactStatusEventForViewer(data) {
  if (!isPlainObject(data)) return null;
  const out = {};
  if (data.truncated === true) out.truncated = true;
  if (typeof data.reason === "string") out.reason = data.reason;
  if (typeof data.managerId === "string") out.managerId = data.managerId;
  if (typeof data.ok === "boolean") out.ok = data.ok;
  if (Array.isArray(data.offline)) out.offline = stringList(data.offline);
  return out;
}

// 05 §5.4 baseline, `instances` event: ids and states only.
function redactInstancesEventForViewer(data) {
  if (!isPlainObject(data)) return null;
  const out = {};
  if (data.truncated === true) out.truncated = true;
  if (typeof data.managerId === "string") out.managerId = data.managerId;
  if (Array.isArray(data.changed)) out.changed = stringList(data.changed);
  if (Array.isArray(data.removed)) out.removed = stringList(data.removed);
  if (typeof data.native === "boolean") out.native = data.native;
  if (Array.isArray(data.instances)) {
    out.instances = data.instances.filter(isPlainObject).map((item) => {
      const state = typeof item.lifecycle?.state === "string" ? item.lifecycle.state : typeof item.state === "string" ? item.state : undefined;
      return {
        id: String(item.id ?? ""),
        ...(state ? { state } : {}),
        ...(typeof item.running === "boolean" ? { running: item.running } : {}),
      };
    });
  }
  return out;
}

// "/api/fleet" exact, "/api/m/:managerId/status" with named segments, "/c/*"
// for a prefix. Returns null for anything else.
function compilePath(pattern) {
  const text = String(pattern || "");
  if (!text.startsWith("/") || /[?#\s\\]/.test(text)) return null;
  const segments = text.split("/").slice(1);
  const names = [];
  let literals = 0;
  let wildcard = false;
  const parts = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "*" && index === segments.length - 1) {
      wildcard = true;
      names.push("*");
      parts.push("(.*)");
    } else if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      names.push(segment.slice(1));
      parts.push("([^/]+)");
    } else if (segment.includes("*") || segment.includes(":")) {
      return null;
    } else {
      literals += 1;
      parts.push(segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  return { regex: new RegExp(`^/${parts.join("/")}$`), names, literals, wildcard };
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// The subset of 05's createViewerRegistry() that entry modules need before
// PUB-25 lands, with the same method names and match() result shape.
function createBuiltinViewerRegistry(options = {}) {
  const logger = options.logger || console;
  const routes = [];
  const events = new Map();
  const registrations = [];
  let frozen = false;

  function guardOpen(method) {
    if (frozen) throw new Error(`viewer registry is frozen; ${method}() must run during startup`);
  }

  function record(method, args, baseline) {
    registrations.push({ method, args: { ...args }, baseline: Boolean(baseline) });
  }

  function addRoute(method, input, access, baseline = false) {
    guardOpen(method);
    const args = isPlainObject(input) ? input : {};
    const owner = String(args.owner || "").trim();
    const httpMethod = String(args.method || (method === "registerReadOnlyPost" ? "POST" : "GET")).toUpperCase();
    const compiled = compilePath(args.path);
    if (!owner) throw new TypeError(`${method}() needs an owner`);
    if (!HTTP_METHODS.has(httpMethod)) throw new TypeError(`${method}() got an unknown method: ${args.method}`);
    if (!compiled) throw new TypeError(`${method}() got an invalid path: ${args.path}`);
    if (args.redact !== undefined && args.redact !== null && typeof args.redact !== "function") {
      throw new TypeError(`${method}() redact must be a function`);
    }
    if (routes.some((route) => route.method === httpMethod && route.path === args.path)) {
      throw new Error(`${httpMethod} ${args.path} is already registered`);
    }
    routes.push({
      owner,
      method: httpMethod,
      path: String(args.path),
      access,
      redact: typeof args.redact === "function" ? args.redact : null,
      compiled,
      order: routes.length,
    });
    record(method, args, baseline);
  }

  function registerRoute(args) {
    addRoute("registerRoute", args, "viewer");
  }

  function registerReadOnlyPost(args) {
    addRoute("registerReadOnlyPost", { ...(isPlainObject(args) ? args : {}), method: "POST" }, "viewer");
  }

  function registerAdminOnly(args) {
    addRoute("registerAdminOnly", args, "admin");
  }

  function registerEventType(input, baseline = false) {
    guardOpen("registerEventType");
    const args = isPlainObject(input) ? input : {};
    const owner = String(args.owner || "").trim();
    const type = String(args.type || "").trim();
    if (!owner) throw new TypeError("registerEventType() needs an owner");
    if (!type) throw new TypeError("registerEventType() needs a type");
    if (args.redact !== undefined && args.redact !== null && typeof args.redact !== "function") {
      throw new TypeError("registerEventType() redact must be a function");
    }
    if (events.has(type)) throw new Error(`event type ${type} is already registered`);
    events.set(type, { owner, type, redact: typeof args.redact === "function" ? args.redact : null });
    record("registerEventType", args, baseline);
  }

  // The most specific entry wins: no wildcard first, then more literal
  // segments, then registration order. HEAD follows GET.
  function match(method, pathname) {
    const wanted = String(method || "GET").toUpperCase() === "HEAD" ? "GET" : String(method || "GET").toUpperCase();
    const target = String(pathname || "");
    let best = null;
    for (const route of routes) {
      if (route.method !== wanted) continue;
      const found = route.compiled.regex.exec(target);
      if (!found) continue;
      if (best) {
        const a = route.compiled;
        const b = best.route.compiled;
        const better = (a.wildcard !== b.wildcard && !a.wildcard)
          || (a.wildcard === b.wildcard && a.literals > b.literals);
        if (!better) continue;
      }
      best = { route, found };
    }
    if (!best) return null;
    const params = {};
    best.route.compiled.names.forEach((name, index) => {
      params[name] = decodeParam(best.found[index + 1]);
    });
    const { owner, method: routeMethod, path, access, redact } = best.route;
    return { access, entry: { owner, method: routeMethod, path, access, redact }, params };
  }

  function viewerEventTypes() {
    return [...events.keys()];
  }

  // A registered type passes through its redaction (none means unchanged);
  // an unregistered type, or a redaction that throws, drops the event. The
  // bus hands in its frozen envelope data, so a redaction builds a new object.
  function redactEvent(type, data, ctx = {}) {
    const entry = events.get(String(type || ""));
    if (!entry) return null;
    if (!entry.redact) return data;
    try {
      const result = entry.redact(data, ctx);
      return result === undefined ? null : result;
    } catch (error) {
      try {
        logger.warn?.(core.redactSecrets(`request-auth: ${type} event redaction failed; the event is dropped for viewers: ${error?.message || error}`));
      } catch {
        // Logging must not break the stream.
      }
      return null;
    }
  }

  function inventory() {
    return [
      ...routes.map(({ owner, method, path, access }) => ({ owner, method, path, access })),
      ...[...events.values()].map(({ owner, type }) => ({ owner, method: "EVENT", path: type, access: "viewer" })),
    ];
  }

  function freeze() {
    frozen = true;
  }

  // Re-issues every registration made here, in order, on 05's registry.
  // The preloaded baseline is skipped by default: 05's PUB-25 registers its
  // own copy of it.
  function replayInto(target, replayOptions = {}) {
    if (!target || target === api) return 0;
    const includeBaseline = Boolean(replayOptions.includeBaseline);
    let replayed = 0;
    for (const item of registrations) {
      if (item.baseline && !includeBaseline) continue;
      if (typeof target[item.method] !== "function") {
        throw new TypeError(`target viewer registry has no ${item.method}()`);
      }
      target[item.method]({ ...item.args });
      replayed += 1;
    }
    return replayed;
  }

  const api = {
    registerRoute,
    registerReadOnlyPost,
    registerAdminOnly,
    registerEventType: (args) => registerEventType(args),
    match,
    viewerEventTypes,
    redactEvent,
    inventory,
    freeze,
    replayInto,
    registrations: () => registrations.map((item) => ({ method: item.method, args: { ...item.args }, baseline: item.baseline })),
  };

  if (options.baseline !== false) {
    registerEventType({ owner: "05", type: "status", redact: redactStatusEventForViewer }, true);
    registerEventType({ owner: "05", type: "instances", redact: redactInstancesEventForViewer }, true);
  }
  return api;
}

function createRequestAuth(options = {}) {
  const security = options.security;
  if (!security || typeof security.checkManagementAccess !== "function") {
    throw new TypeError("createRequestAuth needs the entry security object");
  }
  const logger = options.logger || console;
  const builtin = options.builtinRegistry || createBuiltinViewerRegistry({ logger });
  let adminAuth = options.adminAuth || null;
  let registry = builtin;
  // Several modules may ask about the same request; authenticate it once.
  let principals = new WeakMap();

  // A stable object, so a module that kept ctx.auth.viewerRegistry at mount
  // time still reaches 05's registry after attach().
  const viewerRegistry = {};
  for (const method of REGISTRY_METHODS) {
    viewerRegistry[method] = (...args) => {
      const fn = registry[method];
      if (typeof fn !== "function") throw new TypeError(`the viewer registry has no ${method}()`);
      return fn.apply(registry, args);
    };
  }

  function attach(attachOptions = {}) {
    const opts = isPlainObject(attachOptions) ? attachOptions : {};
    if (opts.viewerRegistry && opts.viewerRegistry !== registry) {
      builtin.replayInto(opts.viewerRegistry, { includeBaseline: Boolean(opts.includeBaseline) });
      registry = opts.viewerRegistry;
    }
    if (opts.adminAuth) adminAuth = opts.adminAuth;
    principals = new WeakMap();
    return api;
  }

  function legacyPrincipal(req) {
    const access = security.checkManagementAccess(req);
    const proxied = typeof security.isProxiedRequest === "function" && security.isProxiedRequest(req);
    const via = proxied ? "proxy" : core.isLocalRequest(req) ? "loopback" : "lan";
    return access?.ok
      ? { role: "owner", principal: via, via, redact: false }
      : { role: "viewer", principal: via, via, redact: true };
  }

  function normalizePrincipal(value) {
    if (!isPlainObject(value)) return { role: "none", principal: "", via: "none", redact: true };
    const role = ROLES.has(value.role) ? value.role : "none";
    return {
      ...value,
      role,
      principal: typeof value.principal === "string" ? value.principal : "",
      via: typeof value.via === "string" ? value.via : "none",
      redact: role === "none" ? true : Boolean(value.redact),
    };
  }

  function principal(req) {
    const key = req && typeof req === "object" ? req : null;
    if (key && principals.has(key)) return principals.get(key);
    let result;
    if (adminAuth) {
      try {
        result = normalizePrincipal(adminAuth.authenticate(req));
      } catch (error) {
        logger.warn?.(core.redactSecrets(`request-auth: authenticate failed; treating the caller as unauthenticated: ${error?.message || error}`));
        result = normalizePrincipal(null);
      }
    } else {
      result = legacyPrincipal(req);
    }
    if (key) principals.set(key, result);
    return result;
  }

  function normalizeCheck(result) {
    if (result?.ok) return { ok: true };
    return {
      ok: false,
      status: Number(result?.status) || 403,
      code: String(result?.code || "management_local_only"),
      message: String(result?.message || "This action needs the console owner."),
    };
  }

  function checkWrite(req) {
    if (adminAuth) {
      try {
        return normalizeCheck(adminAuth.checkManagementAccess(req, { write: true }));
      } catch (error) {
        logger.warn?.(core.redactSecrets(`request-auth: write check failed; refusing the request: ${error?.message || error}`));
        return normalizeCheck({ status: 401, code: "admin_session_required" });
      }
    }
    return normalizeCheck(security.checkManagementAccess(req));
  }

  function eventTypesFor(who) {
    const subject = normalizePrincipal(who);
    if (adminAuth && typeof adminAuth.eventTypesFor === "function") return adminAuth.eventTypesFor(who);
    if (subject.role === "owner") return "*";
    if (subject.role === "viewer") return new Set(viewerRegistry.viewerEventTypes());
    return new Set();
  }

  // For responses that bypass the central sendJson redaction (piped proxy
  // bodies). Throws when a redacting principal has no viewer entry for the
  // path, so the caller answers 500 rather than sending an unredacted body.
  function redactFor(req, pathname, body) {
    const who = principal(req);
    if (!who.redact) return body;
    const found = viewerRegistry.match(req?.method || "GET", pathname);
    if (!found || found.access !== "viewer") {
      const error = new Error(`no viewer registration covers ${pathname}`);
      error.code = "viewer_route_not_registered";
      throw error;
    }
    const redact = found.entry?.redact;
    return typeof redact === "function" ? redact(body, { via: who.via, params: found.params || {} }) : body;
  }

  const api = {
    principal,
    checkWrite,
    eventTypesFor,
    viewerRegistry,
    redactFor,
    attach,
    // "session" once 05's admin auth is attached (bootstrap auth.mode, 07 §2.5);
    // PUB-25's admin auth still trusts loopback and says so through its mode.
    get mode() {
      if (!adminAuth) return "loopback-trust";
      return typeof adminAuth.mode === "string" && adminAuth.mode ? adminAuth.mode : "session";
    },
  };
  if (options.viewerRegistry) attach({ viewerRegistry: options.viewerRegistry });
  return api;
}

module.exports = {
  createBuiltinViewerRegistry,
  createRequestAuth,
  redactInstancesEventForViewer,
  redactStatusEventForViewer,
};
