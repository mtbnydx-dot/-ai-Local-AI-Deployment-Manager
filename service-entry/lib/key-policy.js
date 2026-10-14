"use strict";

// Platform key policy (docs/overhaul/05-public.md §6.3, §11). Pure: no I/O,
// no logging and no state. The gateway pipeline judges a presented key with
// evaluateKey/modelAllowed/fleetAllowed, and the key store validates admin
// input with the same normalizers, so a key the admin API accepts is checked
// by the code that later serves it.
//
// Patterns are case-insensitive globs where `*` matches any run of
// characters. They are matched without regular expressions, so a hostile
// pattern cannot cause catastrophic backtracking.

const net = require("node:net");

const SCOPES = Object.freeze([
  "models.read",
  "chat",
  "completions",
  "responses",
  "embeddings",
  "messages",
  "audio.speech",
  "audio.clone",
  "search",
  "mcp",
  "self.read",
  "self.rotate",
  "self.origins",
  "debug.route",
]);
// Never routable on the PUBLIC listener, whatever the key says (§6.3).
const ADMIN_ONLY_SCOPES = Object.freeze(["audio.clone", "mcp"]);
const KEY_CLASSES = Object.freeze(["owner", "internal", "friend", "trial", "customer"]);
const KEY_STATUSES = Object.freeze(["active", "disabled", "revoked"]);
const KEY_LISTENERS = Object.freeze(["public", "admin"]);
// A wildcard Origin is allowed only on low-risk keys (§11).
const WILDCARD_ORIGIN_SCOPES = Object.freeze(["models.read", "chat", "messages", "completions", "self.read"]);
const WILDCARD_ORIGIN_CLASSES = Object.freeze(["friend", "trial"]);

function deny(code, reason, param = null) {
  return param ? { ok: false, code, reason, param } : { ok: false, code, reason };
}

function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value) return Date.parse(value);
  return Date.now();
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

// evaluateKey(key, { now, listener, ip, origin, scope }) checks, in order:
// status, expiry, listener, allowed IPs, scope, origin. The first failure
// answers. `code` is the public error code (§10.2); `reason` is the precise
// cause for logs and telemetry and is never shown to the caller.
function evaluateKey(key, options = {}) {
  if (!key || typeof key !== "object") return deny("invalid_api_key", "key_missing");
  if (key.status !== "active") {
    return deny("key_disabled", key.status === "revoked" ? "key_revoked" : "key_disabled");
  }
  if (isExpired(key.expiresAt, options.now)) return deny("key_expired", "key_expired");
  const listener = options.listener ? String(options.listener) : "";
  if (listener && !listOf(key.listeners).includes(listener)) {
    return deny("scope_denied", "listener_not_allowed", "listener");
  }
  if (!ipAllowed(key, options.ip)) return deny("ip_not_allowed", "ip_not_allowed");
  const scope = options.scope ? String(options.scope) : "";
  if (scope) {
    if (!listOf(key.scopes).includes(scope)) return deny("scope_denied", "scope_missing", scope);
    if (listener === "public" && ADMIN_ONLY_SCOPES.includes(scope)) {
      return deny("scope_denied", "scope_admin_only", scope);
    }
    if (listener === "public" && scope === "search" && options.exposeSearch !== true) {
      return deny("scope_denied", "search_not_exposed", scope);
    }
  }
  if (!originAllowed(key, options.origin)) return deny("origin_not_allowed", "origin_not_allowed");
  return { ok: true };
}

// An unparseable expiry counts as expired: the key fails closed.
function isExpired(expiresAt, now) {
  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return false;
  const at = Date.parse(String(expiresAt));
  if (!Number.isFinite(at)) return true;
  return at <= timeMs(now);
}

// Glob match, case-insensitive. Only `*` is special. A leading `!` is not
// interpreted here; modelAllowed and fleetAllowed treat it as an exclude.
function matchPattern(pattern, value) {
  const glob = String(pattern ?? "").trim().toLowerCase();
  const text = String(value ?? "").trim().toLowerCase();
  if (!glob) return false;
  if (!glob.includes("*")) return glob === text;
  const parts = glob.split("*");
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!text.startsWith(first)) return false;
  let position = first.length;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const found = text.indexOf(part, position);
    if (found === -1) return false;
    position = found + part.length;
  }
  return text.length - position >= last.length && text.endsWith(last);
}

function splitPatterns(patterns) {
  const includes = [];
  const excludes = [];
  for (const raw of listOf(patterns)) {
    const pattern = String(raw ?? "").trim();
    if (!pattern) continue;
    if (pattern.startsWith("!")) {
      const rest = pattern.slice(1).trim();
      if (rest) excludes.push(rest);
    } else {
      includes.push(pattern);
    }
  }
  return { includes, excludes };
}

function anyMatch(patterns, candidates) {
  return patterns.some((pattern) => candidates.some((candidate) => matchPattern(pattern, candidate)));
}

// modelAllowed(key, { id, root, aliases }): exact names first, then globs,
// then `!pattern` excludes, which always win. `[]` allows nothing and `["*"]`
// allows everything. An exclude that matches any of the model's names (id,
// root or alias) removes the model.
function modelAllowed(key, model = {}) {
  const descriptor = typeof model === "string" ? { id: model } : (model || {});
  const candidates = [descriptor.id, descriptor.root, ...listOf(descriptor.aliases)]
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (!candidates.length) return false;
  const { includes, excludes } = splitPatterns(key?.models);
  if (!includes.length) return false;
  const exact = includes.filter((pattern) => !pattern.includes("*")).map((pattern) => pattern.toLowerCase());
  const included = candidates.some((candidate) => exact.includes(candidate))
    || anyMatch(includes.filter((pattern) => pattern.includes("*")), candidates);
  if (!included) return false;
  return !anyMatch(excludes, candidates);
}

// fleetAllowed(key, fleetId) on `${managerId}:${instanceId}` or
// `external:<id>`. Unlike models, an empty include list means every fleet
// member; `!pattern` excludes still apply.
function fleetAllowed(key, fleetId) {
  const id = String(fleetId ?? "").trim().toLowerCase();
  const { includes, excludes } = splitPatterns(key?.fleetAllow);
  if (!id) return includes.length === 0 && excludes.length === 0;
  if (includes.length && !anyMatch(includes, [id])) return false;
  return !anyMatch(excludes, [id]);
}

function wildcardOriginAllowed(key = {}) {
  if (!WILDCARD_ORIGIN_CLASSES.includes(key.class)) return false;
  return listOf(key.scopes).every((scope) => WILDCARD_ORIGIN_SCOPES.includes(scope));
}

// Returns null when the origin list is acceptable for this key, or the
// §11 error code when it holds `*` on a key that may not have it.
function checkWildcardOrigin(key = {}) {
  if (!listOf(key.allowedOrigins).includes("*")) return null;
  return wildcardOriginAllowed(key) ? null : "wildcard_origin_requires_restricted_key";
}

// Canonical `scheme://host[:port]` for http(s) origins, `*` for the wildcard,
// "" for anything else (paths, credentials, other schemes, garbage).
function normalizeOrigin(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text === "*") return "*";
  if (text.length > 2048) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password || url.search || url.hash) return "";
  // `https://a.example/` and `https://a.example` share an origin; anything
  // after the authority (a path, an empty `?` or `#`) is rejected.
  if (url.pathname !== "/" || /[?#]/.test(text)) return "";
  return url.origin;
}

// The request Origin header is matched exactly against the stored canonical
// origins. A missing Origin (curl, SDKs) is allowed; "null" or an
// unparseable value must be listed literally, which normalization prevents.
function originAllowed(key, origin) {
  const raw = String(origin ?? "").trim();
  if (!raw) return true;
  const allowed = listOf(key?.allowedOrigins);
  if (allowed.includes("*")) return true;
  const canonical = normalizeOrigin(raw);
  if (!canonical || canonical === "*") return false;
  return allowed.includes(canonical);
}

function ipv4ToBigInt(text) {
  return text.split(".").reduce((total, part) => (total << 8n) | BigInt(Number(part)), 0n);
}

function parseIpv6Groups(text) {
  let source = text;
  let embedded = null;
  const lastColon = source.lastIndexOf(":");
  if (source.slice(lastColon + 1).includes(".")) {
    const ipv4 = source.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) return null;
    const value = Number(ipv4ToBigInt(ipv4));
    embedded = [Math.floor(value / 65536), value % 65536];
    source = `${source.slice(0, lastColon + 1)}0:0`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right].map((group) => parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  if (embedded) {
    groups[6] = embedded[0];
    groups[7] = embedded[1];
  }
  return groups;
}

function formatIpv6(groups) {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

// Parses an address into { family, value: BigInt, text: canonical }. IPv4
// mapped IPv6 (`::ffff:10.0.0.5`) becomes IPv4, so a rule written for IPv4
// matches a dual-stack socket address. Brackets and zone ids are dropped.
function parseIp(value) {
  let text = String(value ?? "").trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (net.isIPv4(text)) {
    const canonical = text.split(".").map((part) => String(Number(part))).join(".");
    return { family: 4, value: ipv4ToBigInt(canonical), text: canonical };
  }
  if (!net.isIPv6(text)) return null;
  const groups = parseIpv6Groups(text.toLowerCase());
  if (!groups) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return { family: 4, value: ipv4ToBigInt(ipv4), text: ipv4 };
  }
  const numeric = groups.reduce((total, group) => (total << 16n) | BigInt(group), 0n);
  return { family: 6, value: numeric, text: formatIpv6(groups) };
}

function normalizeIp(value) {
  return parseIp(value)?.text || "";
}

// Parses "IP" or "IP/prefix" into { family, network, prefix, text } with the
// host bits cleared. Returns null for anything invalid.
function parseIpRule(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const slash = text.indexOf("/");
  const address = parseIp(slash === -1 ? text : text.slice(0, slash));
  if (!address) return null;
  const width = address.family === 4 ? 32 : 128;
  let prefix = width;
  if (slash !== -1) {
    const prefixText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    // A mapped IPv6 rule keeps its meaning: ::ffff:10.0.0.0/104 is 10.0.0.0/8.
    const mappedSource = address.family === 4 && !net.isIPv4(String(text.slice(0, slash)).replace(/^\[|\]$/g, ""));
    if (mappedSource) {
      if (prefix < 96 || prefix > 128) return null;
      prefix -= 96;
    }
    if (prefix > width) return null;
  }
  const shift = BigInt(width - prefix);
  const network = (address.value >> shift) << shift;
  const networkText = address.family === 4
    ? [24n, 16n, 8n, 0n].map((bits) => String((network >> bits) & 255n)).join(".")
    : formatIpv6(Array.from({ length: 8 }, (_, index) => Number((network >> BigInt((7 - index) * 16)) & 0xffffn)));
  return {
    family: address.family,
    network,
    prefix,
    text: prefix === width ? networkText : `${networkText}/${prefix}`,
  };
}

function normalizeIpRule(value) {
  return parseIpRule(value)?.text || "";
}

function ipMatchesRule(ip, rule) {
  const address = typeof ip === "object" && ip ? ip : parseIp(ip);
  const parsedRule = typeof rule === "object" && rule ? rule : parseIpRule(rule);
  if (!address || !parsedRule || address.family !== parsedRule.family) return false;
  const width = address.family === 4 ? 32 : 128;
  const shift = BigInt(width - parsedRule.prefix);
  return (address.value >> shift) === (parsedRule.network >> shift);
}

// `[]` allows every address. With rules present, a missing or invalid client
// address is denied.
function ipAllowed(key, ip) {
  const rules = listOf(key?.allowedIps);
  if (!rules.length) return true;
  const address = parseIp(ip);
  if (!address) return false;
  return rules.some((rule) => ipMatchesRule(address, rule));
}

function isLoopbackIp(value) {
  const address = typeof value === "object" && value ? value : parseIp(value);
  if (!address) return false;
  if (address.family === 4) return (address.value >> 24n) === 127n;
  return address.value === 1n;
}

module.exports = {
  ADMIN_ONLY_SCOPES,
  KEY_CLASSES,
  KEY_LISTENERS,
  KEY_STATUSES,
  SCOPES,
  WILDCARD_ORIGIN_CLASSES,
  WILDCARD_ORIGIN_SCOPES,
  checkWildcardOrigin,
  evaluateKey,
  fleetAllowed,
  ipAllowed,
  ipMatchesRule,
  isExpired,
  isLoopbackIp,
  matchPattern,
  modelAllowed,
  normalizeIp,
  normalizeIpRule,
  normalizeOrigin,
  originAllowed,
  parseIp,
  parseIpRule,
  wildcardOriginAllowed,
};
