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
// The pre-dispatch guard that runs these checks, and the sessions and
// viewers around them, live in admin-session.js (createAdminAuth).

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

module.exports = {
  FORWARDING_HEADERS,
  MACHINE_HEADER_NAMES,
  MAX_BODY_BYTES,
  PRINCIPAL_EVENT_TYPES,
  createMachineAuth,
  machineEventTypes,
  machineScopeAllows,
};
