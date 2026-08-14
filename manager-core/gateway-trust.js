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
const TRUST_FILE_NAME = ".gateway-trust.json";
const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;
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

// Single source of truth for "who is really calling". Used for the local-only
// check and as the rate-limit key, so an attacker cannot widen either one by
// setting headers.
function resolveRequestOrigin(req, options = {}) {
  const socketAddress = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  if (!hasGatewayMarker(req)) {
    return { address: socketAddress, socketAddress, viaGateway: false, trusted: true };
  }
  if (!isLocalAddress(socketAddress)) {
    // The marker is only meaningful on the loopback hop. Anything else forged it.
    return { address: socketAddress, socketAddress, viaGateway: true, trusted: false };
  }
  const readToken = typeof options.readGatewayTrustToken === "function" ? options.readGatewayTrustToken : null;
  const token = options.token || (readToken ? readToken() : "");
  const verified = verifyGatewayRequest(req, token, options);
  if (!verified.ok) {
    return { address: socketAddress, socketAddress, viaGateway: true, trusted: false };
  }
  return { address: verified.clientAddress, socketAddress, viaGateway: true, trusted: true };
}

module.exports = {
  GATEWAY_MARKER_HEADER,
  GATEWAY_CLIENT_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  GATEWAY_SIGNATURE_HEADER,
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
  resolveRequestOrigin,
};
