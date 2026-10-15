"use strict";

// Trust chain between service-entry and the managers.
//
// service-entry is the single policy enforcement point: it terminates the
// client connection, applies auth/rate policy, then proxies to a manager over
// loopback. Because the manager only ever sees 127.0.0.1 for those hops, it
// cannot judge locality from the socket alone -- that is what let LAN traffic
// pass a manager configured as "local only".
//
// So service-entry signs every proxied request with a shared token and states
// the real client address. Managers verify the signature before believing it.
// A loopback request that claims to come from the gateway but cannot prove it
// is treated as remote (fail-closed), which keeps a forged header from
// downgrading the check.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeJsonFile } = require("./file-utils");
const { isLocalAddress, normalizeRemoteAddress } = require("./network");
const { secureLocalSecretFile } = require("./runtime-secret-store");

const GATEWAY_MARKER_HEADER = "x-service-entry-gateway";
const GATEWAY_CLIENT_HEADER = "x-service-entry-client";
const GATEWAY_TIMESTAMP_HEADER = "x-service-entry-ts";
const GATEWAY_SIGNATURE_HEADER = "x-service-entry-signature";
// Hop v2 (05 §7.1): the same marker, client and ts, plus the request id, the
// caller's principal and 04's request context, all covered by one signature.
const GATEWAY_REQUEST_ID_HEADER = "x-request-id";
const GATEWAY_PRINCIPAL_HEADER = "x-service-entry-principal";
const GATEWAY_CONTEXT_HEADER = "x-service-entry-context";
const GATEWAY_SIGNATURE_V2_HEADER = "x-service-entry-signature-v2";
const GATEWAY_TRUST_VERSION = 2;
const TRUST_FILE_NAME = ".gateway-trust.json";
const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_V2_MAX_SKEW_MS = 60 * 1000;
const ENTRY_REQUEST_ID_RE = /^req_[a-z2-7]{20}$/;
const CONTEXT_PREFIX = "v1.";
const MAX_CONTEXT_HEADER_BYTES = 512;
const MAX_PRINCIPAL_HEADER_BYTES = 1024;
// Trust-token rotation closes an authorization boundary. Default readers must
// observe the published file on the next request; caching remains opt-in.
const DEFAULT_TOKEN_CACHE_MS = 0;

function gatewayTrustFile(root) {
  return path.join(String(root || process.cwd()), TRUST_FILE_NAME);
}

function generateGatewayTrustToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// service-entry calls this at boot. The token is regenerated per entry process
// so a stale file from a previous run cannot authorize a new one.
async function issueGatewayTrustToken(options = {}) {
  const file = options.file || gatewayTrustFile(options.root);
  const token = options.token || generateGatewayTrustToken();
  const payload = {
    version: 1,
    token,
    pid: process.pid,
    issuedAt: new Date().toISOString(),
  };
  await writeJsonFile(file, payload);
  await secureLocalSecretFile(file);
  return { token, file };
}

async function revokeGatewayTrustToken(options = {}) {
  const file = options.file || gatewayTrustFile(options.root);
  await fsp.rm(file, { force: true }).catch(() => {});
}

// Managers read the token lazily. The published file wins so a long-running
// manager follows service-entry token rotation after the entry is restarted;
// the env value remains a bootstrap fallback when no file is available.
function createGatewayTrustReader(options = {}) {
  const file = options.file || gatewayTrustFile(options.root);
  const envName = options.envName || "SERVICE_GATEWAY_TRUST_TOKEN";
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? DEFAULT_TOKEN_CACHE_MS));
  let cache = { token: "", mtimeMs: undefined, expiresAt: 0 };

  return function readGatewayTrustToken() {
    const now = Date.now();
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (cache.token && cache.mtimeMs === mtimeMs && (cacheTtlMs === 0 || cache.expiresAt > now)) {
      return cache.token;
    }
    let token = "";
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      token = String(parsed?.token || "").trim();
    } catch {
      token = String(process.env[envName] || "").trim();
    }
    cache = { token, mtimeMs, expiresAt: cacheTtlMs > 0 ? now + cacheTtlMs : 0 };
    return token;
  };
}

function signGatewayRequest(token, clientAddress, timestamp) {
  return crypto
    .createHmac("sha256", String(token || ""))
    .update(`${normalizeRemoteAddress(clientAddress)}\n${String(timestamp || "")}`, "utf8")
    .digest("base64url");
}

function buildGatewayTrustHeaders(token, clientAddress, now = Date.now()) {
  const headers = { [GATEWAY_MARKER_HEADER]: "1" };
  if (!token) return headers;
  const address = normalizeRemoteAddress(clientAddress);
  const timestamp = String(now);
  headers[GATEWAY_CLIENT_HEADER] = address;
  headers[GATEWAY_TIMESTAMP_HEADER] = timestamp;
  headers[GATEWAY_SIGNATURE_HEADER] = signGatewayRequest(token, address, timestamp);
  return headers;
}

function headerText(headers = {}, name) {
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyGatewayRequest(req, token, options = {}) {
  const headers = req?.headers || {};
  const address = headerText(headers, GATEWAY_CLIENT_HEADER);
  const timestamp = headerText(headers, GATEWAY_TIMESTAMP_HEADER);
  const signature = headerText(headers, GATEWAY_SIGNATURE_HEADER);
  if (!token || !address || !timestamp || !signature) return { ok: false, clientAddress: "" };
  const maxSkewMs = Math.max(1000, Number(options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS));
  const now = Number(options.now ?? Date.now());
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > maxSkewMs) return { ok: false, clientAddress: "" };
  if (!safeEqualText(signature, signGatewayRequest(token, address, timestamp))) return { ok: false, clientAddress: "" };
  return { ok: true, clientAddress: normalizeRemoteAddress(address) };
}

function hasGatewayMarker(req) {
  return Boolean(headerText(req?.headers || {}, GATEWAY_MARKER_HEADER));
}

// --- Hop v2 -----------------------------------------------------------------

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64UrlJson(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(text || ""))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// The manager-side path a hop is signed for. The query is not part of it:
// the entry forwards the client's query unchanged.
function hopPathname(value) {
  const text = String(value || "");
  const end = text.search(/[?#]/);
  return end < 0 ? text : text.slice(0, end);
}

// The principal header: base64url(JSON), or "" for a keyless caller.
function encodeEntryPrincipal(principal) {
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) return "";
  const encoded = base64UrlJson(principal);
  return encoded.length <= MAX_PRINCIPAL_HEADER_BYTES ? encoded : "";
}

// The context header: "v1." + base64url(JSON) of 04's object, at most 512
// bytes. A context that does not fit is not sent (the hop stays valid and the
// manager sees no context) rather than failing the request.
function encodeEntryContext(context) {
  if (typeof context === "string") {
    return context.startsWith(CONTEXT_PREFIX) && context.length <= MAX_CONTEXT_HEADER_BYTES ? context : "";
  }
  if (!context || typeof context !== "object" || Array.isArray(context)) return "";
  const encoded = `${CONTEXT_PREFIX}${base64UrlJson(context)}`;
  return encoded.length <= MAX_CONTEXT_HEADER_BYTES ? encoded : "";
}

function decodeEntryContext(header) {
  const text = String(header || "");
  if (!text) return { context: null, invalid: false };
  if (!text.startsWith(CONTEXT_PREFIX) || text.length > MAX_CONTEXT_HEADER_BYTES) return { context: null, invalid: true };
  const context = parseBase64UrlJson(text.slice(CONTEXT_PREFIX.length));
  return context ? { context, invalid: false } : { context: null, invalid: true };
}

function signGatewayRequestV2(token, { method, pathname, clientIp, ts, requestId, principal, context } = {}) {
  return crypto
    .createHmac("sha256", String(token || ""))
    .update([
      "v2",
      String(method || "GET").toUpperCase(),
      hopPathname(pathname),
      normalizeRemoteAddress(clientIp),
      String(ts ?? ""),
      String(requestId || ""),
      String(principal || "-"),
      sha256Hex(context || ""),
    ].join("\n"), "utf8")
    .digest("base64url");
}

// The only builder of the entry -> manager hop: v1 exactly as before, plus v2
// when the request id is an entry-minted req_ id. `principal` is the 05 §7.1
// object (null for keyless ADMIN callers) and `context` is 04's object; both
// are serialized here, so 04 attaches its context without touching this file.
function buildEntryHeaders(token, input = {}, now = Date.now()) {
  const headers = buildGatewayTrustHeaders(token, input.clientIp, now);
  const requestId = String(input.requestId || "");
  if (!token || !ENTRY_REQUEST_ID_RE.test(requestId)) return headers;
  const principal = encodeEntryPrincipal(input.principal);
  const context = encodeEntryContext(input.context);
  headers[GATEWAY_REQUEST_ID_HEADER] = requestId;
  if (principal) headers[GATEWAY_PRINCIPAL_HEADER] = principal;
  if (context) headers[GATEWAY_CONTEXT_HEADER] = context;
  headers[GATEWAY_SIGNATURE_V2_HEADER] = signGatewayRequestV2(token, {
    method: input.method,
    pathname: input.pathname,
    clientIp: headers[GATEWAY_CLIENT_HEADER],
    ts: headers[GATEWAY_TIMESTAMP_HEADER],
    requestId,
    principal,
    context,
  });
  return headers;
}

function requestPathname(req) {
  const raw = String(req?.originalUrl || req?.url || "");
  if (raw.startsWith("/")) return hopPathname(raw);
  try {
    return new URL(raw).pathname;
  } catch {
    return "";
  }
}

function hopResult(fields) {
  return {
    ok: false,
    version: 0,
    clientAddress: "",
    requestId: "",
    principal: null,
    context: null,
    reason: "",
    ...fields,
  };
}

// verifyEntryRequest(req, { token | readGatewayTrustToken, now, maxSkewMs })
//   -> { ok, version: 0|1|2, clientAddress, requestId, principal, context, reason }
// version 0: no marker (direct ingress). version 1: a v1-only hop (an older
// entry), never with a principal. version 2: principal and context are set
// only when the v2 signature verifies. ok:false means the caller treats the
// request as untrusted; a failed v2 hop is never downgraded to v1.
function verifyEntryRequest(req, options = {}) {
  const headers = req?.headers || {};
  const socketAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  if (!hasGatewayMarker(req)) {
    return hopResult({ ok: true, version: 0, clientAddress: socketAddress, reason: "direct" });
  }
  const v2Signature = headerText(headers, GATEWAY_SIGNATURE_V2_HEADER);
  const version = v2Signature ? 2 : 1;
  if (!isLocalAddress(socketAddress)) {
    // The marker is only meaningful on the loopback hop. Anything else forged it.
    return hopResult({ version, clientAddress: socketAddress, reason: "marker_not_loopback" });
  }
  const readToken = typeof options.readGatewayTrustToken === "function" ? options.readGatewayTrustToken : null;
  const token = options.token || (readToken ? readToken() : "");
  if (!token) return hopResult({ version, clientAddress: socketAddress, reason: "token_unavailable" });
  const now = Number(options.now ?? Date.now());
  if (version === 1) {
    const v1 = verifyGatewayRequest(req, token, { now, maxSkewMs: options.v1MaxSkewMs ?? DEFAULT_MAX_SKEW_MS });
    if (!v1.ok) return hopResult({ version, clientAddress: socketAddress, reason: "signature_invalid" });
    return hopResult({ ok: true, version, clientAddress: v1.clientAddress, reason: "v1" });
  }
  const clientIp = headerText(headers, GATEWAY_CLIENT_HEADER);
  const timestamp = headerText(headers, GATEWAY_TIMESTAMP_HEADER);
  const requestId = headerText(headers, GATEWAY_REQUEST_ID_HEADER);
  const principalHeader = headerText(headers, GATEWAY_PRINCIPAL_HEADER);
  const contextHeader = headerText(headers, GATEWAY_CONTEXT_HEADER);
  if (!clientIp || !timestamp || !ENTRY_REQUEST_ID_RE.test(requestId)) {
    return hopResult({ version, clientAddress: socketAddress, reason: "signature_invalid" });
  }
  const issuedAt = Number(timestamp);
  const maxSkewMs = Math.max(1000, Number(options.maxSkewMs ?? DEFAULT_V2_MAX_SKEW_MS));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(now) || Math.abs(now - issuedAt) > maxSkewMs) {
    return hopResult({ version, clientAddress: socketAddress, reason: "signature_expired" });
  }
  const expected = signGatewayRequestV2(token, {
    method: req?.method,
    pathname: requestPathname(req),
    clientIp,
    ts: timestamp,
    requestId,
    principal: principalHeader,
    context: contextHeader,
  });
  if (!safeEqualText(v2Signature, expected)) {
    return hopResult({ version, clientAddress: socketAddress, reason: "signature_invalid" });
  }
  // Signed by the entry, so a principal that does not parse is an entry bug;
  // the hop is refused rather than served without an identity.
  const principal = principalHeader ? parseBase64UrlJson(principalHeader) : null;
  if (principalHeader && !principal) {
    return hopResult({ version, clientAddress: socketAddress, reason: "principal_invalid" });
  }
  const decoded = decodeEntryContext(contextHeader);
  return hopResult({
    ok: true,
    version,
    clientAddress: normalizeRemoteAddress(clientIp),
    requestId,
    principal,
    context: decoded.context,
    reason: decoded.invalid ? "context_invalid" : "v2",
  });
}

// Single source of truth for "who is really calling". Used for the local-only
// check and as the rate-limit key, so an attacker cannot widen either one by
// setting headers. v2 hops use a 60 s window; v1 keeps its 5 min window
// (`maxSkewMs` still names the v1 window, as it always did).
function resolveRequestOrigin(req, options = {}) {
  const socketAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  const verified = verifyEntryRequest(req, {
    token: options.token,
    readGatewayTrustToken: options.readGatewayTrustToken,
    now: options.now,
    v1MaxSkewMs: options.maxSkewMs,
    maxSkewMs: options.v2MaxSkewMs,
  });
  const hop = {
    version: verified.version,
    requestId: verified.requestId,
    principal: verified.principal,
    context: verified.context,
    reason: verified.reason,
  };
  if (verified.version === 0) {
    return { address: socketAddress, socketAddress, viaGateway: false, trusted: true, ...hop };
  }
  if (!verified.ok) {
    return { address: socketAddress, socketAddress, viaGateway: true, trusted: false, ...hop };
  }
  return { address: verified.clientAddress, socketAddress, viaGateway: true, trusted: true, ...hop };
}

module.exports = {
  GATEWAY_MARKER_HEADER,
  GATEWAY_CLIENT_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  GATEWAY_SIGNATURE_HEADER,
  GATEWAY_REQUEST_ID_HEADER,
  GATEWAY_PRINCIPAL_HEADER,
  GATEWAY_CONTEXT_HEADER,
  GATEWAY_SIGNATURE_V2_HEADER,
  GATEWAY_TRUST_VERSION,
  ENTRY_REQUEST_ID_RE,
  TRUST_FILE_NAME,
  gatewayTrustFile,
  generateGatewayTrustToken,
  issueGatewayTrustToken,
  revokeGatewayTrustToken,
  createGatewayTrustReader,
  signGatewayRequest,
  buildGatewayTrustHeaders,
  verifyGatewayRequest,
  hasGatewayMarker,
  signGatewayRequestV2,
  encodeEntryPrincipal,
  encodeEntryContext,
  buildEntryHeaders,
  verifyEntryRequest,
  resolveRequestOrigin,
};
