"use strict";

// Machine principals on the ADMIN listener, entry side (05 §5.7).
//
// Local processes (the hub shims, the supervisor, the CLI, platform-mcp) sign
// ADMIN /api/* calls with the entry trust token through the machine form of
// manager-core/internal-auth.js. This module checks those signatures before
// any route runs, holds each principal's fixed route scope and SSE event
// types, and remembers the verified principal per request for the
// request-auth seam. Only a valid signature makes a request a machine
// principal: a bare marker header such as x-hub-shim is never a credential,
// and a request without machine headers is judged on its other credentials.
//
// createEntryAdminAuth() is the PUB-25 form of 05's createAdminAuth: it adds
// the pre-dispatch guard (machine scope, then deny-by-default for viewers)
// on top of today's rule that a loopback caller is the owner and a LAN
// caller a viewer. PUB-5 replaces it with sessions and keeps the guard.

const crypto = require("node:crypto");
const core = require("../../manager-core");
const internalAuth = require("../../manager-core/internal-auth");
const { FORWARDED_HEADERS } = require("./security");

const MAX_BODY_BYTES = 1024 * 1024;
const FAILURE_SAMPLE_MS = 1000;
const READ_METHODS = new Set(["GET", "HEAD"]);
// 05 §4's FORWARDING_HEADERS: the entry's list plus cf-ray. A machine
// signature is accepted only on a direct loopback hop.
const FORWARDING_HEADERS = Object.freeze([...new Set([...FORWARDED_HEADERS, "cf-ray"])]);
const MACHINE_HEADER_NAMES = Object.freeze([
  internalAuth.MACHINE_PRINCIPAL_HEADER,
  internalAuth.MACHINE_TIMESTAMP_HEADER,
  internalAuth.MACHINE_SIGNATURE_HEADER,
  internalAuth.MACHINE_BODY_SHA256_HEADER,
  internalAuth.MACHINE_VERSION_HEADER,
]);
// The SSE types each principal receives; "*" is every type.
const PRINCIPAL_EVENT_TYPES = Object.freeze({
  "system:hub-shim:vllm": Object.freeze(["downloads", "library", "jobs"]),
  "system:hub-shim:llama": Object.freeze(["downloads", "library", "jobs"]),
  "system:supervisor": Object.freeze(["status", "notification", "platform", "alerts"]),
  "system:cli": "*",
  "system:mcp": Object.freeze([]),
});
// The fixed scopes of 05 §5.7 as data.
const HUB_SHIM_PREFIX = "/api/hub";
const EVENTS_PATH = "/api/events";
const SUPERVISOR_SCOPE = Object.freeze({
  writes: Object.freeze(["/api/shutdown", "/api/manager/shutdown"]),
  reads: Object.freeze(["/api/status", "/api/platform/busy"]),
  eventsClient: "supervisor",
});
// system:cli is owner-equivalent on /api/* except these.
const CLI_EXCLUDED_PREFIXES = Object.freeze(["/api/billing", "/api/audit", "/api/telemetry/requests"]);
const CLI_SESSION_PREFIX = "/api/session/";
const CLI_SESSION_ALLOWED = Object.freeze(["/api/session/pair-codes"]);

function headerText(headers, name) {
  const value = headers?.[name];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function hasMachineHeaders(req) {
  return MACHINE_HEADER_NAMES.some((name) => headerText(req?.headers, name));
}

function hasForwardingHeaders(req) {
  return FORWARDING_HEADERS.some((name) => req?.headers?.[name] !== undefined);
}

function underPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// The fixed route scope of 05 §5.7 for a verified principal. system:mcp
// reaches every viewer-registered route (GET and read-only POST) through the
// registry; the others have their table rows.
function machineScopeAllows(principal, method, url, viewerRegistry = null) {
  const verb = String(method || "GET").toUpperCase();
  const read = READ_METHODS.has(verb);
  const pathname = String(url?.pathname || "");
  const searchParams = url?.searchParams || new URLSearchParams();
  if (principal === "system:hub-shim:vllm" || principal === "system:hub-shim:llama") {
    return underPrefix(pathname, HUB_SHIM_PREFIX) || (read && pathname === EVENTS_PATH);
  }
  if (principal === "system:supervisor") {
    if (verb === "POST") return SUPERVISOR_SCOPE.writes.includes(pathname);
    if (!read) return false;
    if (SUPERVISOR_SCOPE.reads.includes(pathname)) return true;
    const client = searchParams.get("client");
    return pathname === EVENTS_PATH && (client === null || client === SUPERVISOR_SCOPE.eventsClient);
  }
  if (principal === "system:cli") {
    if (!pathname.startsWith("/api/")) return false;
    if (CLI_EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
    return !pathname.startsWith(CLI_SESSION_PREFIX) || CLI_SESSION_ALLOWED.includes(pathname);
  }
  if (principal === "system:mcp") {
    if (!viewerRegistry || typeof viewerRegistry.match !== "function") return false;
    try {
      return viewerRegistry.match(verb, pathname)?.access === "viewer";
    } catch {
      return false;
    }
  }
  return false;
}

function machineEventTypes(principal) {
  const types = Object.hasOwn(PRINCIPAL_EVENT_TYPES, principal) ? PRINCIPAL_EVENT_TYPES[principal] : null;
  if (types === "*") return "*";
  return new Set(Array.isArray(types) ? types : []);
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Buffers the body of a signed request. An oversized body is drained, never
// cut off, so the 413 reaches a client that is still sending.
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req?.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume?.();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      req.off?.("data", onData);
      req.off?.("end", onEnd);
      req.off?.("error", onGone);
      req.off?.("close", onGone);
      resolve(value);
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) {
        chunks.length = 0;
        settle({ tooLarge: true });
        req.resume?.();
        return;
      }
      chunks.push(buffer);
    }
    function onEnd() {
      settle({ body: Buffer.concat(chunks, total) });
    }
    function onGone() {
      settle({ aborted: true });
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onGone);
    req.on("close", onGone);
  });
}

function createMachineAuth(options = {}) {
  const getToken = typeof options.getToken === "function" ? options.getToken : () => "";
  const now = typeof options.now === "function" ? options.now : Date.now;
  const maxSkewMs = Number(options.maxSkewMs) > 0 ? Number(options.maxSkewMs) : internalAuth.DEFAULT_INTERNAL_MAX_SKEW_MS;
  const maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Math.floor(Number(options.maxBodyBytes)) : MAX_BODY_BYTES;
  const failureSampleMs = Number(options.failureSampleMs) >= 0 ? Number(options.failureSampleMs) : FAILURE_SAMPLE_MS;
  const onFailure = typeof options.onFailure === "function" ? options.onFailure : null;
  const logger = options.logger || console;
  const viewerRegistry = options.viewerRegistry || null;
  const verified = new WeakMap();
  let lastFailureAt = -Infinity;
  let suppressed = 0;

  function clock() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  // One security.internal_auth_failed per second at most; the count of the
  // ones skipped in between rides on the next. Never the token or signature.
  function noteFailure(req, url, code) {
    if (!onFailure) return;
    const at = clock();
    if (at - lastFailureAt < failureSampleMs) {
      suppressed += 1;
      return;
    }
    lastFailureAt = at;
    const claimed = headerText(req?.headers, internalAuth.MACHINE_PRINCIPAL_HEADER);
    const details = {
      code,
      principal: internalAuth.isMachinePrincipal(claimed) ? claimed : "",
      method: String(req?.method || "GET").toUpperCase(),
      path: String(url?.pathname || "").slice(0, 200),
      suppressed,
    };
    suppressed = 0;
    try {
      onFailure(details);
    } catch (error) {
      try {
        logger.warn?.(core.redactSecrets(`machine-auth: reporting a failed signature failed: ${error?.message || error}`));
      } catch {
        // Logging must not break a request.
      }
    }
  }

  function fail(req, url, code) {
    noteFailure(req, url, code);
    return {
      ok: false,
      status: 401,
      code,
      message: code === "internal_signature_expired"
        ? "The machine signature has expired; sign the request again."
        : "The machine signature is not valid for this request.",
    };
  }

  // Checks the signed headers. A non-GET body is checked by verifyBody()
  // once the scope is known, before any route reads it.
  function verifySignature(req, url) {
    if (!core.isLocalRequest(req) || hasForwardingHeaders(req)) return fail(req, url, "internal_signature_invalid");
    let token = "";
    try {
      token = String(getToken() || "");
    } catch {
      token = "";
    }
    const result = internalAuth.verifyMachineSignature(req, token, { now: clock(), maxSkewMs });
    if (!result.ok) {
      return fail(req, url, result.code === "internal_signature_expired" ? "internal_signature_expired" : "internal_signature_invalid");
    }
    return { ok: true, principal: result.principal, bodySha256: result.bodySha256 };
  }

  // Reads a signed non-GET body (≤ maxBodyBytes) and compares its digest with
  // the signed one. On success the buffer is req.rawBody, which every entry
  // body reader uses first.
  async function verifyBody(req, url, bodySha256) {
    const read = await readBody(req, maxBodyBytes);
    if (read.aborted) return { ok: false, aborted: true };
    if (read.tooLarge) {
      return { ok: false, status: 413, code: "request_too_large", message: `A signed request body may be at most ${maxBodyBytes} bytes.` };
    }
    if (sha256Hex(read.body) !== bodySha256) return fail(req, url, "internal_signature_invalid");
    req.rawBody = read.body;
    return { ok: true };
  }

  function authorize(principal, method, url) {
    if (machineScopeAllows(principal, method, url, viewerRegistry)) return { ok: true };
    return {
      ok: false,
      status: 403,
      code: "principal_scope_denied",
      message: `${principal || "This principal"} may not call ${String(method || "GET").toUpperCase()} ${String(url?.pathname || "")}.`,
    };
  }

  return {
    hasCredentials: hasMachineHeaders,
    verifySignature,
    verifyBody,
    authorize,
    remember(req, principal) {
      if (req && typeof req === "object" && internalAuth.isMachinePrincipal(principal)) verified.set(req, principal);
    },
    principalOf(req) {
      return req && typeof req === "object" ? verified.get(req) || "" : "";
    },
    eventTypesFor: machineEventTypes,
  };
}

function writeError(res, status, code, message, hint) {
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy?.();
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }));
}

// Paths the guard leaves to their own authentication: the key-checked
// gateway and the manager-signed /internal/* calls.
function guardExempt(pathname) {
  return pathname.startsWith("/gateway/") || pathname.startsWith("/internal/");
}

// The PUB-25 admin auth: today's loopback-owner rule plus machine principals
// and the viewer registry. Same method names as 05's createAdminAuth, so the
// request-auth seam delegates to it unchanged.
function createEntryAdminAuth(options = {}) {
  const security = options.security;
  const machineAuth = options.machineAuth;
  const viewerRegistry = options.viewerRegistry;
  if (!security || typeof security.checkManagementAccess !== "function") throw new TypeError("createEntryAdminAuth needs the entry security object");
  if (!machineAuth || typeof machineAuth.verifySignature !== "function") throw new TypeError("createEntryAdminAuth needs machine auth");
  if (!viewerRegistry || typeof viewerRegistry.match !== "function") throw new TypeError("createEntryAdminAuth needs the viewer registry");
  const sendError = typeof options.sendError === "function" ? options.sendError : writeError;

  // Today's rule (until PUB-5): the owner iff checkManagementAccess passes,
  // otherwise a viewer whose reads are redacted.
  function legacy(req) {
    const proxied = typeof security.isProxiedRequest === "function" && security.isProxiedRequest(req);
    const via = proxied ? "proxy" : core.isLocalRequest(req) ? "loopback" : "lan";
    const access = security.checkManagementAccess(req) || {};
    const who = access.ok
      ? { role: "owner", principal: via, via, redact: false }
      : { role: "viewer", principal: via, via, redact: true };
    return { who, access };
  }

  // A machine principal the guard verified for this request comes first.
  function authenticate(req) {
    const principal = machineAuth.principalOf(req);
    if (principal) return { role: "system", principal, via: "hmac", redact: false };
    return legacy(req).who;
  }

  function requestUrl(req) {
    try {
      return new URL(String(req?.url || "/"), "http://127.0.0.1");
    } catch {
      return new URL("http://127.0.0.1/");
    }
  }

  function checkManagementAccess(req, { write = false } = {}) {
    const principal = machineAuth.principalOf(req);
    if (principal) {
      const scope = machineAuth.authorize(principal, req?.method, requestUrl(req));
      if (!scope.ok) return { ...scope, role: "system", principal, redact: false };
      return { ok: true, role: "system", principal, redact: false };
    }
    const { who, access } = legacy(req);
    if (access.ok) return { ok: true, role: who.role, principal: who.principal, redact: false };
    return {
      ok: false,
      role: who.role,
      principal: who.principal,
      redact: true,
      status: Number(access.status) || 403,
      code: String(access.code || "management_local_only"),
      message: String(access.message || (write ? "This action needs the console owner." : "This page needs the console owner.")),
    };
  }

  function eventTypesFor(who) {
    const role = who?.role;
    if (role === "system") return machineAuth.eventTypesFor(String(who?.principal || ""));
    if (role === "owner") return "*";
    if (role === "viewer") return new Set(viewerRegistry.viewerEventTypes());
    return new Set();
  }

  // The single pre-dispatch check (05 §5.4, §5.7). true means it answered.
  // A signed request is verified (signature, then scope, then body digest)
  // and never falls back to other credentials. An unsigned owner passes. A
  // viewer passes only on a viewer entry, and req.viewer then carries the
  // entry's redaction for sendJson.
  async function guard(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (guardExempt(pathname)) return false;
    if (machineAuth.hasCredentials(req)) {
      const signature = machineAuth.verifySignature(req, url);
      if (!signature.ok) {
        req.resume?.();
        sendError(res, signature.status, signature.code, signature.message);
        return true;
      }
      const scope = machineAuth.authorize(signature.principal, req.method, url);
      if (!scope.ok) {
        req.resume?.();
        sendError(res, scope.status, scope.code, scope.message);
        return true;
      }
      if (!READ_METHODS.has(String(req.method || "GET").toUpperCase())) {
        const body = await machineAuth.verifyBody(req, url, signature.bodySha256);
        // The client went away mid-body; there is nobody to answer.
        if (body.aborted) {
          res.destroy?.();
          return true;
        }
        if (!body.ok) {
          sendError(res, body.status, body.code, body.message);
          return true;
        }
      }
      machineAuth.remember(req, signature.principal);
      return false;
    }
    const who = authenticate(req);
    if (who.role === "owner") return false;
    if (who.role === "viewer") {
      let found = null;
      try {
        found = viewerRegistry.match(req.method, pathname);
      } catch {
        found = null;
      }
      if (found && found.access === "viewer") {
        req.viewer = { redact: found.entry?.redact || null, ctx: { via: who.via, params: found.params || {} } };
        return false;
      }
    }
    req.resume?.();
    sendError(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", "pair");
    return true;
  }

  return {
    // The console's bootstrap auth.mode (07 §2.5) until PUB-5's sessions.
    mode: "loopback-trust",
    authenticate,
    checkManagementAccess,
    eventTypesFor,
    guard,
  };
}

module.exports = {
  FORWARDING_HEADERS,
  MACHINE_HEADER_NAMES,
  MAX_BODY_BYTES,
  PRINCIPAL_EVENT_TYPES,
  createEntryAdminAuth,
  createMachineAuth,
  machineEventTypes,
  machineScopeAllows,
};
