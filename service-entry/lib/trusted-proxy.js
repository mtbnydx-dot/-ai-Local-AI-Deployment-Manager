"use strict";

// Trusted proxies and client identity (docs/overhaul/05-public.md §4).
//
// Who is really calling is decided from the listener a request arrived on and
// the socket peer, never from a header alone:
//   - ADMIN (5176, LAN-bound or not) never honours forwarded headers (00 D8).
//     A request without a listener tag is treated as ADMIN, so code that
//     forgets to tag fails closed.
//   - PUBLIC (5186) honours exactly one configured header, and only when the
//     socket peer is inside trustedProxies.cidrs. A LAN device that sends
//     X-Forwarded-For: 127.0.0.1 is still identified by its socket address.
//
// Pure functions: the CIDR list and header names come from the access config
// (public-config.js); nothing here reads env or files.

const { normalizeIp, parseIp, parseIpRule, ipMatchesRule } = require("./key-policy");

// Every header a reverse proxy (Caddy, cloudflared, a CDN) or this entry's own
// hop may add. The presence of any of them marks a request as proxied, which
// can only demote it (no management, no billing admin), never promote it. One
// shared list: security.js re-exports it as FORWARDED_HEADERS, and
// billing-http.js and machine-auth.js import it from there.
const FORWARDING_HEADERS = Object.freeze([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "cf-ray",
  "x-service-entry-gateway",
]);

const LISTENER_KINDS = Object.freeze(["admin", "public"]);
const COUNTRY_RE = /^[A-Z]{2}$/;
const HEADER_NAME_RE = /^[a-z0-9-]{1,64}$/;

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.map((item) => String(item ?? "")).join(",");
  return value === undefined || value === null ? "" : String(value);
}

// The socket address in canonical form: IPv4-mapped IPv6 becomes IPv4 and
// brackets and zone ids are dropped. Anything unparseable is kept as given
// (trimmed), so an odd test double never turns into an empty identity.
function normalizeSocketAddress(value) {
  const text = String(value ?? "").trim();
  return normalizeIp(text) || text;
}

/**
 * Parses CIDR entries ("IP" or "IP/prefix"; IPv4, IPv6 and IPv4-mapped IPv6)
 * into matchers. A comma or semicolon separated string is accepted too.
 * Invalid entries are reported in `issues`, never thrown, so one typo cannot
 * take the entry down. Each Cidr is frozen: { text, family, prefix, network }.
 */
function parseCidrList(list) {
  const entries = Array.isArray(list) ? list : String(list ?? "").split(/[;,]/);
  const cidrs = [];
  const issues = [];
  const seen = new Set();
  for (const raw of entries) {
    const item = String(raw ?? "").trim();
    if (!item) continue;
    const rule = parseIpRule(item);
    if (!rule) {
      issues.push(`Not an IP address or CIDR range: ${item.slice(0, 80)}`);
      continue;
    }
    if (seen.has(rule.text)) continue;
    seen.add(rule.text);
    cidrs.push(Object.freeze({ text: rule.text, family: rule.family, prefix: rule.prefix, network: rule.network }));
  }
  return { cidrs, issues };
}

function ipInCidrs(ip, cidrs) {
  const address = parseIp(ip);
  if (!address || !Array.isArray(cidrs)) return false;
  return cidrs.some((cidr) => cidr && ipMatchesRule(address, cidr));
}

function hasForwardingHeaders(headers) {
  return FORWARDING_HEADERS.some((name) => headerValue(headers, name).trim() !== "");
}

// One address out of a header value: a bare IP, "IPv4:port" or "[IPv6]:port".
// Returns the canonical text or "".
function parseHeaderAddress(value) {
  let text = String(value ?? "").trim();
  if (!text || text.length > 100) return "";
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  return normalizeIp(text);
}

// X-Forwarded-For, walked right to left: every hop a trusted proxy appended is
// skipped, and the first hop that is not trusted is the client. When every hop
// is trusted, the leftmost one is. An unparseable hop stops the walk, because
// whatever stands left of it was written by the client, not by a proxy.
function walkForwardedFor(value, cidrs) {
  const hops = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!hops.length) return "";
  let leftmostTrusted = "";
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const address = parseHeaderAddress(hops[index]);
    if (!address) return "";
    if (!ipInCidrs(address, cidrs)) return address;
    leftmostTrusted = address;
  }
  return leftmostTrusted;
}

function forwardedProto(headers) {
  const first = headerValue(headers, "x-forwarded-proto").split(",")[0].trim().toLowerCase();
  if (first === "https" || first === "http") return first;
  const visitor = headerValue(headers, "cf-visitor").trim();
  if (visitor) {
    try {
      const scheme = String(JSON.parse(visitor)?.scheme || "").toLowerCase();
      if (scheme === "https" || scheme === "http") return scheme;
    } catch {
      // A malformed cf-visitor names no scheme.
    }
  }
  return "http";
}

function listenerKind(listener) {
  const kind = typeof listener === "string" ? listener : listener?.kind;
  return LISTENER_KINDS.includes(kind) ? kind : "admin";
}

/**
 * The client identity of a request (§4). `listener` is req.listener
 * ({ kind: "admin"|"public", lanBound }) or just the kind; anything else is
 * treated as "admin". `cidrs` are parseCidrList() results.
 *
 * Returns { ip, socketIp, viaProxy, headerUsed, country, missingHeader,
 * forwardedOnUntrusted, proto }. `ip` is what the entry logs, rate-limits on
 * and vouches to the managers.
 */
function resolveClientIdentity(req, { listener, cidrs = [], clientIpHeader = "cf-connecting-ip", countryHeader = "cf-ipcountry" } = {}) {
  const headers = req?.headers || {};
  const socketIp = normalizeSocketAddress(req?.socket?.remoteAddress);
  const forwarded = hasForwardingHeaders(headers);
  const direct = { ip: socketIp, socketIp, viaProxy: false, headerUsed: "", country: "", missingHeader: false, forwardedOnUntrusted: false, proto: "http" };
  // ADMIN never honours forwarded headers (D8); their presence is reported.
  if (listenerKind(listener ?? req?.listener) === "admin") return { ...direct, forwardedOnUntrusted: forwarded };
  // A socket outside the trusted ranges is its own client. A forwarded header
  // from it is a spoof attempt: counted by the caller, never believed.
  if (!ipInCidrs(socketIp, cidrs)) return { ...direct, forwardedOnUntrusted: forwarded };

  const header = String(clientIpHeader || "").trim().toLowerCase();
  let ip = "";
  if (HEADER_NAME_RE.test(header)) {
    // cf-connecting-ip, x-real-ip and any other configured name carry exactly
    // one address; a list there is invalid, not a choice.
    ip = header === "x-forwarded-for"
      ? walkForwardedFor(headerValue(headers, header), cidrs)
      : parseHeaderAddress(headerValue(headers, header));
  }
  const countryName = String(countryHeader || "").trim().toLowerCase();
  const country = HEADER_NAME_RE.test(countryName) ? headerValue(headers, countryName).trim() : "";
  return {
    ip: ip || socketIp,
    socketIp,
    viaProxy: forwarded || Boolean(ip),
    headerUsed: ip ? header : "",
    // Normal for a local tool that calls the public port directly.
    missingHeader: !ip,
    country: COUNTRY_RE.test(country) ? country : "",
    forwardedOnUntrusted: false,
    proto: forwardedProto(headers),
  };
}

module.exports = {
  FORWARDING_HEADERS,
  LISTENER_KINDS,
  hasForwardingHeaders,
  ipInCidrs,
  normalizeSocketAddress,
  parseCidrList,
  resolveClientIdentity,
};
