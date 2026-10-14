"use strict";

// Viewer-access registry (05 §5.4).
//
// Viewers (a LAN device today; a loopback caller without a session once
// PUB-5 lands) and the machine principal system:mcp may call only routes that
// a route-owning package registered here. Everything else is owner-only: the
// entry's pre-dispatch guard answers 401 admin_session_required before any
// route code runs, so a forgotten registration fails closed. Each viewer
// entry names its redaction, which the shared sendJson applies through
// res.req.viewer; no route has to remember it.
//
// Packages register while the entry starts (route modules at mount time,
// server.js its inline routes). startServiceEntry() then calls freeze(), and
// a later registration throws. inventory() lists every declaration,
// admin-only ones included, for the route-coverage test.

const core = require("../../manager-core");

const VIEWER = "viewer";
const ADMIN = "admin";
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// "/api/fleet" exact, "/api/m/:managerId/status" with named segments, "/c/*"
// for everything below a prefix. Returns null for anything else.
function compilePath(pattern) {
  const text = String(pattern || "");
  if (!text.startsWith("/") || /[?#\s\\]/.test(text)) return null;
  const segments = text.split("/").slice(1);
  const names = [];
  const parts = [];
  let literals = 0;
  let wildcard = false;
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

function normalizeMethod(value, fallback) {
  return String(value || fallback).trim().toUpperCase();
}

function createViewerRegistry(options = {}) {
  const logger = options.logger || console;
  const routes = [];
  const events = new Map();
  let frozen = false;

  function assertOpen(method) {
    if (frozen) throw new Error(`the viewer registry is frozen; ${method}() must run while the entry starts`);
  }

  function assertRedact(method, redact) {
    if (redact !== undefined && redact !== null && typeof redact !== "function") {
      throw new TypeError(`${method}() redact must be a function`);
    }
  }

  function addRoute(method, input, { access, httpMethod, allowed }) {
    assertOpen(method);
    const args = isPlainObject(input) ? input : {};
    const owner = String(args.owner || "").trim();
    const compiled = compilePath(args.path);
    if (!owner) throw new TypeError(`${method}() needs an owner`);
    if (!allowed.has(httpMethod)) throw new TypeError(`${method}() cannot register method ${args.method}`);
    if (!compiled) throw new TypeError(`${method}() got an invalid path: ${args.path}`);
    assertRedact(method, args.redact);
    const path = String(args.path);
    const taken = routes.find((route) => route.method === httpMethod && route.path === path);
    // Declaring an admin-only route twice changes nothing, so the owner that
    // implements a route 05's baseline already declared may declare it too.
    if (taken && taken.access === ADMIN && access === ADMIN) return;
    if (taken) throw new Error(`${httpMethod} ${path} is already registered by ${taken.owner}`);
    routes.push({
      owner,
      method: httpMethod,
      path,
      access,
      redact: access === VIEWER && typeof args.redact === "function" ? args.redact : null,
      compiled,
    });
  }

  // A viewer-readable GET (HEAD follows it). redact(body, { via, params })
  // returns the copy a viewer receives; null means the body is shown as is.
  function registerRoute(args) {
    const httpMethod = normalizeMethod(isPlainObject(args) ? args.method : "", "GET");
    addRoute("registerRoute", args, { access: VIEWER, httpMethod, allowed: new Set(["GET"]) });
  }

  // A POST that has no side effects, such as the fleet route preview.
  function registerReadOnlyPost(args) {
    addRoute("registerReadOnlyPost", args, { access: VIEWER, httpMethod: "POST", allowed: new Set(["POST"]) });
  }

  // An explicit owner-only declaration. It changes nothing at run time (deny
  // by default already applies) but makes the route part of the inventory.
  function registerAdminOnly(args) {
    const httpMethod = normalizeMethod(isPlainObject(args) ? args.method : "", "GET");
    addRoute("registerAdminOnly", args, { access: ADMIN, httpMethod, allowed: HTTP_METHODS });
  }

  function registerEventType(input) {
    assertOpen("registerEventType");
    const args = isPlainObject(input) ? input : {};
    const owner = String(args.owner || "").trim();
    const type = String(args.type || "").trim();
    if (!owner) throw new TypeError("registerEventType() needs an owner");
    if (!type) throw new TypeError("registerEventType() needs a type");
    assertRedact("registerEventType", args.redact);
    const taken = events.get(type);
    if (taken) throw new Error(`event type ${type} is already registered by ${taken.owner}`);
    events.set(type, { owner, type, redact: typeof args.redact === "function" ? args.redact : null });
  }

  // The most specific entry wins: an exact path before a wildcard, then more
  // literal segments. An admin-only entry beats an equally specific viewer
  // entry. HEAD follows GET.
  function match(method, pathname) {
    const requested = normalizeMethod(method, "GET");
    const wanted = requested === "HEAD" ? "GET" : requested;
    const target = String(pathname || "");
    let best = null;
    for (const route of routes) {
      if (route.method !== wanted) continue;
      const found = route.compiled.regex.exec(target);
      if (!found) continue;
      if (best) {
        const a = route.compiled;
        const b = best.route.compiled;
        if (a.wildcard !== b.wildcard) {
          if (a.wildcard) continue;
        } else if (a.literals !== b.literals) {
          if (a.literals < b.literals) continue;
        } else if (!(route.access === ADMIN && best.route.access !== ADMIN)) {
          continue;
        }
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
  // bus hands in frozen envelope data, so a redaction builds a new object.
  function redactEvent(type, data, ctx = {}) {
    const entry = events.get(String(type || ""));
    if (!entry) return null;
    if (!entry.redact) return data;
    try {
      const result = entry.redact(data, ctx);
      return result === undefined ? null : result;
    } catch (error) {
      try {
        logger.warn?.(core.redactSecrets(`viewer-allowlist: the ${type} event redaction failed; viewers do not get the event: ${error?.message || error}`));
      } catch {
        // Logging must not break a stream.
      }
      return null;
    }
  }

  function inventory() {
    return [
      ...routes.map(({ owner, method, path, access }) => ({ owner, method, path, access })),
      ...[...events.values()].map(({ owner, type }) => ({ owner, method: "EVENT", path: type, access: VIEWER })),
    ];
  }

  function freeze() {
    frozen = true;
  }

  return {
    registerRoute,
    registerReadOnlyPost,
    registerAdminOnly,
    registerEventType,
    match,
    viewerEventTypes,
    redactEvent,
    inventory,
    freeze,
    get frozen() {
      return frozen;
    },
  };
}

module.exports = {
  ADMIN,
  VIEWER,
  compilePath,
  createViewerRegistry,
};
