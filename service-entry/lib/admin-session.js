"use strict";

// Admin authentication on the ADMIN listener (05 §5.1-§5.6).
//
// A loopback caller without credentials is a viewer (00 §9.8). Writes and
// owner-only reads need one of:
//   - the session cookie lai_admin=<sessionId>.<secret>, obtained by pairing
//     (a single-use code, or the one-time first-run auto-pair), plus the
//     x-csrf-token header on every non-GET;
//   - an admin tool token (Authorization: Bearer pat_…), role owner;
//   - a machine signature (machine-auth.js), held to its fixed scope.
// A LAN socket is an owner only with admin.allowLanOwner, and only through
// pairing. The store keeps sha256 of every secret; cookies, CSRF tokens and
// pair codes are never logged.
//
// createAdminAuth() also owns the single pre-dispatch guard (deny-by-default
// for viewers through the viewer registry, CSRF, machine scope) and the
// session API routes (handle()), so a server without route modules serves
// them as well. The audit elevation cookie lai_elev (Path=/api) is bound to
// one live session and dies with it.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../../manager-core");
const { FORWARDING_HEADERS } = require("./machine-auth");

const SESSION_COOKIE = "lai_admin";
const ELEVATION_COOKIE = "lai_elev";
const CSRF_HEADER = "x-csrf-token";
const TOOL_TOKEN_PREFIX = "pat_";
const PAIR_CODE_LENGTH = 10;
const PAIR_CODE_TTL_SECONDS = 120;
const PAIR_CODE_MAX_TTL_SECONDS = 600;
const ELEVATION_TTL_SECONDS = 1800;
const ELEVATION_MAX_TTL_SECONDS = 3600;
const RENEW_INTERVAL_MS = 60 * 60 * 1000;
const PAIR_RATE_LIMIT = 10;
const PAIR_RATE_WINDOW_MS = 60 * 1000;
const MAX_SESSION_BODY_BYTES = 16 * 1024;
const READ_METHODS = new Set(["GET", "HEAD"]);
const ROLES = new Set(["owner", "viewer"]);
// Exposure-scan findings that close the auto-pair window while red (§5.2).
const AUTO_PAIR_BLOCKERS = Object.freeze(["legacy_proxy", "admin_bind"]);
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const SESSION_ID_RE = /^[a-z2-7]{26}$/;
const ELEVATION_ID_RE = /^[a-z2-7]{26}$/;
const COOKIE_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const TOOL_TOKEN_RE = /^pat_[a-z2-7]{32}$/;
const PAIR_CODE_RE = /^[A-Z2-7]{10}$/;
const TOKEN_ID_RE = /^[a-z2-7]{16}$/;
const PAIR_PATH = "/api/session/pair";
const PAIR_CODES_PATH = "/api/session/pair-codes";
const LOGOUT_PATH = "/api/session/logout";
const PAIR_COMMAND_PLATFORM = "platform admin pair";
const PAIR_COMMAND_NODE = "node service-entry\\scripts\\admin-pair.js --open";

const DEFAULT_ADMIN = Object.freeze({
  firstRunAutoPair: true,
  firstRunWindowMinutes: 30,
  sessionDays: 180,
  loopbackViewer: true,
  lanAnonymousViewer: true,
  allowLanOwner: false,
});

class AdminAuthError extends Error {
  constructor(status, code, message, hint) {
    super(message);
    this.status = status;
    this.code = code;
    if (hint) this.hint = hint;
  }
}

function base32(buffer, length) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function sameHex(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function headerText(headers, name) {
  const value = headers?.[name];
  return String(Array.isArray(value) ? value[0] : value ?? "").trim();
}

function hasForwardingHeaders(req) {
  return FORWARDING_HEADERS.some((name) => req?.headers?.[name] !== undefined);
}

// The first value of each cookie name; malformed pairs are skipped.
function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !out.has(name)) out.set(name, part.slice(index + 1).trim());
  }
  return out;
}

// "<id>.<secret>" from one of our cookies, or null.
function splitCookieValue(value, idPattern) {
  const text = String(value || "");
  const dot = text.indexOf(".");
  if (dot <= 0) return null;
  const id = text.slice(0, dot);
  const secret = text.slice(dot + 1);
  return idPattern.test(id) && COOKIE_SECRET_RE.test(secret) ? { id, secret } : null;
}

function cookieHeader(name, value, { path: cookiePath = "/", maxAge }) {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function clearSessionCookie() {
  return cookieHeader(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}

function clearElevationCookie() {
  return cookieHeader(ELEVATION_COOKIE, "", { path: "/api", maxAge: 0 });
}

// Adds Set-Cookie lines without dropping the ones already set.
function appendSetCookie(res, cookies) {
  if (!res || typeof res.getHeader !== "function" || res.headersSent) return;
  const existing = res.getHeader("set-cookie");
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader("set-cookie", [...list, ...(Array.isArray(cookies) ? cookies : [cookies])]);
}

// `platform admin pair` once the root platform.cmd exists (06), else the
// script this package ships (05 §5.2).
function selectPairCommand({ aiRoot, exists = fs.existsSync } = {}) {
  try {
    if (aiRoot && exists(path.join(aiRoot, "platform.cmd"))) return PAIR_COMMAND_PLATFORM;
  } catch {
    // An unreadable root reads as "no launcher".
  }
  return PAIR_COMMAND_NODE;
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

// The page a browser gets when it opens an owner-only page without a session:
// the §5.2 copy with the pairing command, no script and no data.
function pairingPage(pairCommand) {
  const cmd = `<code>${escapeHtml(pairCommand)}</code>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>需要配对 / Pairing required</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:48px 16px;background:#f6f7f9;color:#1d232b}main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #d8dde4;border-radius:10px;padding:24px}code{background:#eef1f5;padding:2px 6px;border-radius:4px;word-break:break-all}@media (prefers-color-scheme:dark){body{background:#14171c;color:#e6e9ee}main{background:#1c2027;border-color:#2c323c}code{background:#262c35}}</style>
</head><body><main>
<h1>需要配对 / Pairing required</h1>
<p>此浏览器尚未与本机控制台配对。请从平台启动器打开控制台（会自动配对），或在终端运行 ${cmd}。</p>
<p lang="en">This browser is not paired with the console yet. Open the console from the platform launcher (pairs automatically) or run ${cmd} in a terminal.</p>
</main></body></html>`;
}

function wantsHtml(req) {
  return String(req?.method || "GET").toUpperCase() === "GET"
    && (headerText(req?.headers, "sec-fetch-dest") === "document" || /\btext\/html\b/.test(headerText(req?.headers, "accept")));
}

// A small JSON object body reader for the session routes. A body the guard
// already buffered (a signed request) is used first.
function readSmallJson(req, limit = MAX_SESSION_BODY_BYTES) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(parseJsonObject(req.rawBody, limit));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new AdminAuthError(413, "request_too_large", "The request body is too large."));
        req.resume?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(parseJsonObject(Buffer.concat(chunks), limit));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function parseJsonObject(buffer, limit) {
  if (buffer.length > limit) throw new AdminAuthError(413, "request_too_large", "The request body is too large.");
  const text = buffer.toString("utf8").trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AdminAuthError(400, "invalid_request", "The request body must be a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminAuthError(400, "invalid_request", "The request body must be a JSON object.");
  return value;
}

function createAdminAuth(options = {}) {
  const machineAuth = options.machineAuth;
  const viewerRegistry = options.viewerRegistry;
  if (!machineAuth || typeof machineAuth.verifySignature !== "function") throw new TypeError("createAdminAuth needs machine auth");
  if (!viewerRegistry || typeof viewerRegistry.match !== "function") throw new TypeError("createAdminAuth needs the viewer registry");
  const getStore = typeof options.store === "function" ? options.store : () => options.store || null;
  const getConfig = typeof options.config === "function"
    ? options.config
    : options.config && typeof options.config.get === "function" ? () => options.config.get() : () => options.config || {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  const scanState = typeof options.scanState === "function" ? options.scanState : () => null;
  const aiRoot = options.aiRoot || "";
  const fileExists = typeof options.fileExists === "function" ? options.fileExists : fs.existsSync;
  const getLanAddress = typeof options.getLanAddress === "function" ? options.getLanAddress : core.getLanAddress;
  const sendJson = typeof options.sendJson === "function" ? options.sendJson : null;
  const readJson = typeof options.readJsonObjectBody === "function" ? options.readJsonObjectBody : readSmallJson;
  const sendError = typeof options.sendError === "function" ? options.sendError : writeError;
  const logger = options.logger || console;
  const principals = new WeakMap();
  const pairAttempts = new Map();
  let csrfKeyCache = { store: null, key: null };
  let lastStoreWarning = 0;

  function clockMs() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  function config() {
    let value = {};
    try {
      value = getConfig() || {};
    } catch {
      value = {};
    }
    const admin = { ...DEFAULT_ADMIN, ...(value.admin || {}) };
    const port = Number(value.listeners?.admin?.port) || 5176;
    return { admin, port, lanBound: value.adminLanBound === true };
  }

  // One warning a minute: a missing store means "no sessions", which keeps
  // every caller a viewer (fail closed) and must not flood the log.
  function warnStore(error) {
    const at = clockMs();
    if (at - lastStoreWarning < 60_000) return;
    lastStoreWarning = at;
    try {
      logger.warn?.(core.redactSecrets(`admin-session: the access store is unavailable; nobody is the owner until it opens: ${error?.code || error?.message || error}`));
    } catch {
      // Logging must not break a request.
    }
  }

  function store({ required = false } = {}) {
    let value = null;
    try {
      value = getStore();
    } catch (error) {
      warnStore(error);
      if (required) throw new AdminAuthError(503, "auth_unavailable", "Admin sessions are unavailable right now.");
      return null;
    }
    if (!value || !value.admin) {
      if (required) throw new AdminAuthError(503, "auth_unavailable", "Admin sessions are unavailable right now.");
      return null;
    }
    return value;
  }

  function bytes(count) {
    const value = randomBytes(count);
    if (!Buffer.isBuffer(value) || value.length < count) throw new AdminAuthError(500, "internal_error", "The random source failed.");
    return value;
  }

  function newId() {
    return base32(bytes(17), 26);
  }

  function newSecret() {
    return bytes(32).toString("base64url");
  }

  // The CSRF key: 32 random bytes in access_meta, created on first use. It
  // is not a credential; it only binds a token to one session id.
  function csrfKey(target) {
    if (csrfKeyCache.store === target && csrfKeyCache.key) return csrfKeyCache.key;
    let hex = target.getMeta("csrfKey");
    if (!/^[0-9a-f]{64}$/.test(String(hex || ""))) {
      hex = bytes(32).toString("hex");
      target.setMeta("csrfKey", hex);
    }
    csrfKeyCache = { store: target, key: Buffer.from(hex, "hex") };
    return csrfKeyCache.key;
  }

  function csrfTokenFor(target, sessionId) {
    return crypto.createHmac("sha256", csrfKey(target)).update(String(sessionId)).digest("base64url");
  }

  function isLoopback(req) {
    return core.isLocalRequest(req) && !hasForwardingHeaders(req);
  }

  function clientIp(req) {
    return core.normalizeRemoteAddress ? core.normalizeRemoteAddress(req?.socket?.remoteAddress || "") : String(req?.socket?.remoteAddress || "");
  }

  function audit(target, entry) {
    try {
      target.appendAudit(entry);
    } catch (error) {
      try {
        logger.warn?.(core.redactSecrets(`admin-session: the access audit could not be written: ${error?.message || error}`));
      } catch {
        // Logging must not break a request.
      }
    }
  }

  // The live session behind the lai_admin cookie, or null.
  function sessionFromCookie(req) {
    const parsed = splitCookieValue(parseCookies(req?.headers?.cookie).get(SESSION_COOKIE), SESSION_ID_RE);
    if (!parsed) return null;
    const target = store();
    if (!target) return null;
    let row = null;
    try {
      row = target.admin.getSession(parsed.id);
    } catch (error) {
      warnStore(error);
      return null;
    }
    if (!row || row.revokedAt || !(Date.parse(row.expiresAt) > clockMs())) return null;
    if (!sameHex(sha256Hex(parsed.secret), row.secretHash)) return null;
    return { row, secret: parsed.secret, store: target };
  }

  function toolTokenFrom(req) {
    const header = headerText(req?.headers, "authorization");
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match || !TOOL_TOKEN_RE.test(match[1])) return null;
    const target = store();
    if (!target) return null;
    let row = null;
    try {
      row = target.admin.findToken(sha256Hex(match[1]));
    } catch (error) {
      warnStore(error);
      return null;
    }
    if (!row || row.revokedAt || !ROLES.has(row.role)) return null;
    try {
      // At most one write an hour per token.
      if (!row.lastUsedAt || clockMs() - Date.parse(row.lastUsedAt) > RENEW_INTERVAL_MS) target.admin.touchToken(row.id, iso(clockMs()));
    } catch {
      // A missed last-used stamp is harmless.
    }
    return row;
  }

  // Who is calling (05 §5.1). Cached per request.
  function authenticate(req) {
    const key = req && typeof req === "object" ? req : null;
    if (key && principals.has(key)) return principals.get(key);
    const result = identify(req);
    if (key) principals.set(key, result);
    return result;
  }

  function identify(req) {
    const machine = machineAuth.principalOf(req);
    if (machine) return { role: "system", principal: machine, via: "hmac", redact: false };
    if (hasForwardingHeaders(req) || req?.listener === "public") return { role: "none", principal: "", via: "none", redact: true };
    const local = core.isLocalRequest(req);
    const network = local ? "loopback" : "lan";
    const { admin } = config();
    const lanOwner = local || admin.allowLanOwner === true;
    const token = toolTokenFrom(req);
    if (token) {
      const owner = token.role === "owner" && lanOwner;
      return { role: owner ? "owner" : "viewer", principal: `token:${token.id}`, via: "token", network, tokenId: token.id, redact: !owner };
    }
    const session = sessionFromCookie(req);
    if (session) {
      const owner = session.row.role === "owner" && lanOwner;
      return {
        role: owner ? "owner" : "viewer",
        principal: `session:${session.row.id.slice(0, 8)}`,
        via: "session",
        network,
        sessionId: session.row.id,
        redact: !owner,
        ...(owner ? {} : { lanSession: true }),
      };
    }
    const anonymous = local ? admin.loopbackViewer !== false : admin.lanAnonymousViewer !== false;
    return anonymous
      ? { role: "viewer", principal: network, via: network, network, redact: true }
      : { role: "none", principal: "", via: "none", network, redact: true };
  }

  // true when the request passes the CSRF rule: a GET or HEAD, no session,
  // or x-csrf-token equal to hmac(csrfKey, sessionId).
  function requireCsrf(req) {
    if (READ_METHODS.has(String(req?.method || "GET").toUpperCase())) return true;
    const who = authenticate(req);
    if (who.via !== "session") return true;
    const target = store();
    if (!target) return false;
    const sent = headerText(req?.headers, CSRF_HEADER);
    if (!sent) return false;
    try {
      return sameHex(sent, csrfTokenFor(target, who.sessionId));
    } catch {
      return false;
    }
  }

  function refusal(who, write) {
    if (who.lanSession) {
      return {
        ok: false, role: who.role, principal: who.principal, redact: true, status: 403, code: "lan_owner_disabled",
        message: "Owner access from the LAN is turned off (admin.allowLanOwner).",
      };
    }
    return {
      ok: false, role: who.role, principal: who.principal, redact: true, status: 401, code: "admin_session_required",
      message: write ? "This action needs the console owner. Pair this browser first." : "This page needs the console owner. Pair this browser first.",
      hint: "pair",
    };
  }

  function requestUrl(req) {
    try {
      return new URL(String(req?.url || "/"), "http://127.0.0.1");
    } catch {
      return new URL("http://127.0.0.1/");
    }
  }

  // The compat gate (00 §5): owner (session plus CSRF on non-GET, or an owner
  // token) or a machine principal inside its scope.
  function checkManagementAccess(req, { write = false } = {}) {
    const who = authenticate(req);
    if (who.role === "system") {
      const scope = machineAuth.authorize(who.principal, req?.method, requestUrl(req));
      if (!scope.ok) return { ...scope, role: "system", principal: who.principal, redact: false };
      return { ok: true, role: "system", principal: who.principal, redact: false };
    }
    if (who.role === "owner") {
      if (!requireCsrf(req)) {
        return {
          ok: false, role: who.role, principal: who.principal, redact: false, status: 403, code: "csrf_invalid",
          message: "The CSRF token is missing or stale. Reload the page and try again.", hint: "reload",
        };
      }
      return { ok: true, role: "owner", principal: who.principal, redact: false };
    }
    return refusal(who, write);
  }

  function eventTypesFor(who) {
    const role = who?.role;
    if (role === "system") return machineAuth.eventTypesFor(String(who?.principal || ""));
    if (role === "owner") return "*";
    if (role === "viewer") return new Set(viewerRegistry.viewerEventTypes());
    return new Set();
  }

  function newSessionRow(req, at) {
    const { admin } = config();
    return {
      id: newId(),
      secret: newSecret(),
      createdAt: iso(at),
      expiresAt: iso(at + admin.sessionDays * 86400 * 1000),
      maxAge: admin.sessionDays * 86400,
      createdIp: clientIp(req) || null,
      userAgent: headerText(req?.headers, "user-agent").slice(0, 300) || null,
    };
  }

  function sessionCookie(row) {
    return cookieHeader(SESSION_COOKIE, `${row.id}.${row.secret}`, { path: "/", maxAge: row.maxAge });
  }

  // The first-run window (§5.2): open while auto-pair is on, nothing was ever
  // paired, it was never consumed and firstStartAt + window is ahead.
  function autoPairWindowOpen(target) {
    const { admin } = config();
    if (admin.firstRunAutoPair === false || !target) return false;
    try {
      if (target.getMeta("autoPairConsumed") === "1") return false;
      if (target.admin.countSessions() > 0) return false;
      const firstStartAt = Date.parse(String(target.getMeta("firstStartAt") || ""));
      return Number.isFinite(firstStartAt) && firstStartAt + admin.firstRunWindowMinutes * 60 * 1000 > clockMs();
    } catch (error) {
      warnStore(error);
      return false;
    }
  }

  function scanAllowsAutoPair() {
    let state = null;
    try {
      state = scanState();
    } catch {
      // A failing scan is "unavailable", which passes (§5.2).
      return true;
    }
    if (!state || state.available === false) return true;
    const red = new Set(Array.isArray(state.red) ? state.red : state.red instanceof Set ? [...state.red] : []);
    return !AUTO_PAIR_BLOCKERS.some((id) => red.has(id));
  }

  // Every request condition of §5.2 item 2, each one required.
  function autoPairRequestEligible(req) {
    if (req?.listener && req.listener !== "admin") return false;
    if (!isLoopback(req)) return false;
    if (String(req?.method || "").toUpperCase() !== "GET") return false;
    if (requestUrl(req).pathname !== "/") return false;
    const { port } = config();
    const host = headerText(req?.headers, "host").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    if (headerText(req?.headers, "sec-fetch-site") !== "none") return false;
    if (headerText(req?.headers, "sec-fetch-mode") !== "navigate") return false;
    if (headerText(req?.headers, "sec-fetch-dest") !== "document") return false;
    return scanAllowsAutoPair();
  }

  function maybeAutoPair(req) {
    if (!autoPairRequestEligible(req)) return null;
    const target = store();
    if (!autoPairWindowOpen(target)) return null;
    const at = clockMs();
    const row = newSessionRow(req, at);
    let created = false;
    try {
      created = target.admin.createSession({ ...row, secretHash: sha256Hex(row.secret), role: "owner" }, { autoPair: true });
    } catch (error) {
      warnStore(error);
      return null;
    }
    if (!created) return null;
    audit(target, { actor: `session:${row.id.slice(0, 8)}`, actorIp: row.createdIp, action: "session.pair", targetType: "session", targetId: row.id.slice(0, 8), details: { via: "auto" } });
    principals.set(req, { role: "owner", principal: `session:${row.id.slice(0, 8)}`, via: "session", network: "loopback", sessionId: row.id, redact: false });
    return { setCookie: sessionCookie(row) };
  }

  function normalizePairCode(value) {
    return String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
  }

  function pairWithCode(req, code) {
    const invalid = { ok: false, status: 400, code: "pair_code_invalid", message: "The pairing code is not valid. Ask for a new one." };
    const text = normalizePairCode(code);
    if (!PAIR_CODE_RE.test(text) || hasForwardingHeaders(req) || (req?.listener && req.listener !== "admin")) return invalid;
    const target = store({ required: true });
    const at = clockMs();
    const used = target.admin.consumePairCode(sha256Hex(text), iso(at));
    if (!used) return invalid;
    const local = core.isLocalRequest(req);
    if (!local) {
      // A loopback code is not redeemable from the LAN (it is burned).
      if (!used.lan) return invalid;
      const { admin, lanBound } = config();
      if (!admin.allowLanOwner || !lanBound) {
        return { ok: false, status: 403, code: "lan_owner_disabled", message: "Owner access from the LAN is turned off (admin.allowLanOwner)." };
      }
    }
    const row = newSessionRow(req, at);
    target.admin.createSession({ ...row, secretHash: sha256Hex(row.secret), role: "owner" });
    audit(target, { actor: `session:${row.id.slice(0, 8)}`, actorIp: row.createdIp, action: "session.pair", targetType: "session", targetId: row.id.slice(0, 8), details: { via: "code", lan: !local } });
    principals.set(req, { role: "owner", principal: `session:${row.id.slice(0, 8)}`, via: "session", network: local ? "loopback" : "lan", sessionId: row.id, redact: false });
    return { ok: true, setCookie: sessionCookie(row), csrfToken: csrfTokenFor(target, row.id), sessionId: row.id };
  }

  function mintPairCode({ actor, ttlSeconds = PAIR_CODE_TTL_SECONDS, lan = false } = {}) {
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > PAIR_CODE_MAX_TTL_SECONDS) {
      throw new AdminAuthError(400, "invalid_request", `ttlSeconds must be a whole number from 1 to ${PAIR_CODE_MAX_TTL_SECONDS}.`);
    }
    const { admin, port, lanBound } = config();
    let host = "127.0.0.1";
    if (lan) {
      if (!admin.allowLanOwner || !lanBound) {
        throw new AdminAuthError(403, "lan_owner_disabled", "A LAN pairing code needs listeners.admin.lan and admin.allowLanOwner.");
      }
      host = String(getLanAddress() || "").trim();
      if (!host) throw new AdminAuthError(409, "lan_address_unknown", "This machine has no LAN address to pair from.");
    }
    const target = store({ required: true });
    const code = base32(bytes(7), PAIR_CODE_LENGTH).toUpperCase();
    const at = clockMs();
    const expiresAt = iso(at + ttl * 1000);
    target.admin.insertPairCode({ codeHash: sha256Hex(code), expiresAt, createdBy: actor || "system", lan: Boolean(lan) });
    audit(target, { actor: actor || "system", action: "session.pair_code", targetType: "session", details: { ttlSeconds: ttl, lan: Boolean(lan) } });
    return { code, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/#pair=${code}`, expiresAt };
  }

  function issueToolToken({ name, role = "owner", actor } = {}) {
    if (!ROLES.has(role)) throw new AdminAuthError(400, "invalid_request", "role must be owner or viewer.");
    const label = String(name ?? "").trim();
    if (!label || label.length > 120) throw new AdminAuthError(400, "invalid_request", "name must be 1 to 120 characters.");
    const target = store({ required: true });
    const id = base32(bytes(10), 16);
    const token = `${TOOL_TOKEN_PREFIX}${base32(bytes(20), 32)}`;
    target.admin.insertToken({ id, name: label, tokenHash: sha256Hex(token), role, createdAt: iso(clockMs()), createdBy: actor || "system" });
    audit(target, { actor: actor || "system", action: "admin_token.create", targetType: "admin_token", targetId: id, details: { role } });
    return { id, token };
  }

  // Audit elevation (§5.6): only an owner session may elevate.
  function issueElevation(req, res, { scope = "audit", ttlSeconds = ELEVATION_TTL_SECONDS } = {}) {
    const who = authenticate(req);
    if (who.role !== "owner" || who.via !== "session") {
      throw new AdminAuthError(403, "elevation_requires_session", "Only a paired console session can unlock this.");
    }
    if (scope !== "audit") throw new AdminAuthError(400, "invalid_request", "Unknown elevation scope.");
    const ttl = Math.min(ELEVATION_MAX_TTL_SECONDS, Math.max(1, Math.floor(Number(ttlSeconds) || ELEVATION_TTL_SECONDS)));
    const target = store({ required: true });
    const at = clockMs();
    const id = newId();
    const secret = newSecret();
    const expiresAt = iso(at + ttl * 1000);
    target.admin.insertElevation({ id, sessionId: who.sessionId, scope, secretHash: sha256Hex(secret), createdAt: iso(at), expiresAt });
    appendSetCookie(res, cookieHeader(ELEVATION_COOKIE, `${id}.${secret}`, { path: "/api", maxAge: ttl }));
    audit(target, { actor: who.principal, actorIp: clientIp(req) || null, action: "session.elevate", targetType: "session", targetId: who.sessionId.slice(0, 8), details: { scope, ttlSeconds: ttl } });
    return { expiresAt };
  }

  function elevationFrom(req) {
    const parsed = splitCookieValue(parseCookies(req?.headers?.cookie).get(ELEVATION_COOKIE), ELEVATION_ID_RE);
    if (!parsed) return null;
    const target = store();
    if (!target) return null;
    try {
      const row = target.admin.getElevation(parsed.id);
      if (!row || !sameHex(sha256Hex(parsed.secret), row.secretHash)) return null;
      return { row, store: target };
    } catch (error) {
      warnStore(error);
      return null;
    }
  }

  // The cookie, an unexpired and unrevoked row, and the same live session.
  function checkElevation(req, scope = "audit") {
    const who = authenticate(req);
    if (who.role !== "owner" || who.via !== "session") return false;
    const found = elevationFrom(req);
    if (!found) return false;
    const { row } = found;
    return row.scope === scope && !row.revokedAt && Date.parse(row.expiresAt) > clockMs() && row.sessionId === who.sessionId;
  }

  function revokeElevation(req, res = null) {
    const found = elevationFrom(req);
    let revoked = false;
    if (found) {
      try {
        revoked = found.store.admin.revokeElevation(found.row.id, iso(clockMs()));
      } catch (error) {
        warnStore(error);
      }
    }
    if (res) appendSetCookie(res, clearElevationCookie());
    return revoked;
  }

  function listSessions(req = null) {
    const target = store({ required: true });
    const current = req ? authenticate(req).sessionId : null;
    return target.admin.listSessions({ now: iso(clockMs()) }).map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      createdIp: row.createdIp,
      userAgent: row.userAgent,
      current: row.id === current,
    }));
  }

  function revokeSession(id, { actor } = {}) {
    const target = store({ required: true });
    const revoked = SESSION_ID_RE.test(String(id || "")) && target.admin.revokeSession(String(id), iso(clockMs()));
    if (revoked) audit(target, { actor: actor || "system", action: "session.revoke", targetType: "session", targetId: String(id).slice(0, 8) });
    return revoked;
  }

  function listToolTokens() {
    const target = store({ required: true });
    return target.admin.listTokens().map(({ tokenHash, ...rest }) => rest);
  }

  function revokeToolToken(id, { actor } = {}) {
    const target = store({ required: true });
    const revoked = TOKEN_ID_RE.test(String(id || "")) && target.admin.revokeToken(String(id), iso(clockMs()));
    if (revoked) audit(target, { actor: actor || "system", action: "admin_token.revoke", targetType: "admin_token", targetId: String(id) });
    return revoked;
  }

  // Ends the caller's session and its elevations; the cookies to clear come
  // back for the route to send.
  function logout(req) {
    const who = authenticate(req);
    const setCookie = [clearSessionCookie(), clearElevationCookie()];
    if (who.via !== "session" || !who.sessionId) return { ok: false, setCookie };
    const target = store({ required: true });
    target.admin.revokeSession(who.sessionId, iso(clockMs()));
    audit(target, { actor: who.principal, actorIp: clientIp(req) || null, action: "session.logout", targetType: "session", targetId: who.sessionId.slice(0, 8) });
    principals.set(req, { role: "viewer", principal: who.network, via: who.network, network: who.network, redact: true });
    return { ok: true, setCookie };
  }

  // The GET /api/session body (§5.6). csrfToken only for a session caller.
  function sessionInfo(req) {
    const who = authenticate(req);
    const target = store();
    const body = {
      ok: true,
      role: who.role,
      via: who.via,
      paired: who.via === "session",
      autoPairAvailable: autoPairWindowOpen(target),
      pairCommand: selectPairCommand({ aiRoot, exists: fileExists }),
    };
    if (who.via === "session" && target) {
      try {
        body.csrfToken = csrfTokenFor(target, who.sessionId);
      } catch (error) {
        warnStore(error);
      }
    }
    return body;
  }

  // Sliding renewal, at most once an hour: a new expiry and a fresh cookie.
  function maybeRenew(req, res, who) {
    if (who.via !== "session") return;
    const found = sessionFromCookie(req);
    if (!found) return;
    const at = clockMs();
    if (at - Date.parse(found.row.lastSeenAt) < RENEW_INTERVAL_MS) return;
    const { admin } = config();
    const maxAge = admin.sessionDays * 86400;
    try {
      found.store.admin.touchSession(found.row.id, { lastSeenAt: iso(at), expiresAt: iso(at + maxAge * 1000) });
      appendSetCookie(res, cookieHeader(SESSION_COOKIE, `${found.row.id}.${found.secret}`, { path: "/", maxAge }));
    } catch (error) {
      warnStore(error);
    }
  }

  // 10 pair attempts a minute per socket address.
  function pairRateLimited(req) {
    const key = clientIp(req) || "unknown";
    const at = clockMs();
    const entry = pairAttempts.get(key);
    if (!entry || at >= entry.resetAt) {
      pairAttempts.set(key, { count: 1, resetAt: at + PAIR_RATE_WINDOW_MS });
      if (pairAttempts.size > 1000) {
        for (const [name, value] of pairAttempts) if (at >= value.resetAt) pairAttempts.delete(name);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > PAIR_RATE_LIMIT;
  }

  function answerUnauthorized(req, res, who) {
    req.resume?.();
    if (!who.lanSession && wantsHtml(req) && !res.headersSent) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
      res.end(pairingPage(selectPairCommand({ aiRoot, exists: fileExists })));
      return true;
    }
    const answer = refusal(who, !READ_METHODS.has(String(req.method || "GET").toUpperCase()));
    sendError(res, answer.status, answer.code, answer.message, answer.hint);
    return true;
  }

  // The single pre-dispatch check (§5.4, §5.6, §5.7). true means it answered.
  // A signed request is verified (signature, scope, body digest) and never
  // falls back to other credentials. An owner passes, a session owner's
  // non-GET only with its CSRF token. A viewer passes only on a viewer entry,
  // and req.viewer then carries the entry's redaction for sendJson. The pair
  // and logout routes are reachable without the owner role.
  async function guard(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (pathname.startsWith("/gateway/") || pathname.startsWith("/internal/")) return false;
    const method = String(req.method || "GET").toUpperCase();
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
      if (!READ_METHODS.has(method)) {
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
      principals.delete(req);
      return false;
    }
    if (method === "POST" && pathname === PAIR_PATH) {
      if (pairRateLimited(req)) {
        req.resume?.();
        sendError(res, 429, "rate_limited", "Too many pairing attempts. Wait a minute and try again.");
        return true;
      }
      return false;
    }
    let who = authenticate(req);
    if (who.role !== "owner" && method === "GET" && pathname === "/") {
      const paired = maybeAutoPair(req);
      if (paired) {
        appendSetCookie(res, paired.setCookie);
        who = authenticate(req);
      }
    }
    maybeRenew(req, res, who);
    if (method === "POST" && pathname === LOGOUT_PATH && who.via === "session") {
      if (requireCsrf(req)) return false;
      req.resume?.();
      sendError(res, 403, "csrf_invalid", "The CSRF token is missing or stale. Reload the page and try again.", "reload");
      return true;
    }
    if (who.role === "owner") {
      if (requireCsrf(req)) return false;
      req.resume?.();
      sendError(res, 403, "csrf_invalid", "The CSRF token is missing or stale. Reload the page and try again.", "reload");
      return true;
    }
    if (who.role === "viewer") {
      let found = null;
      try {
        found = viewerRegistry.match(req.method, pathname);
      } catch {
        found = null;
      }
      if (found && found.access === "viewer") {
        req.viewer = { redact: found.entry?.redact || null, ctx: { via: who.network || who.via, params: found.params || {} } };
        return false;
      }
    }
    return answerUnauthorized(req, res, who);
  }

  function respond(res, payload, status = 200) {
    if (sendJson) return sendJson(res, payload, status);
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    }
    return res.end(JSON.stringify(payload));
  }

  function respondError(res, error) {
    if (error instanceof AdminAuthError) {
      return respond(res, { ok: false, error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } }, error.status);
    }
    try {
      logger.error?.(core.redactSecrets(`admin-session: a session route failed: ${error?.message || error}`));
    } catch {
      // Logging must not break a request.
    }
    return respond(res, { ok: false, error: { code: "internal_error", message: "Service entry error." } }, 500);
  }

  function requireOwner(req, res) {
    const allowed = checkManagementAccess(req, { write: !READ_METHODS.has(String(req.method || "GET").toUpperCase()) });
    if (allowed.ok) return allowed;
    respond(res, { ok: false, error: { code: allowed.code, message: allowed.message, ...(allowed.hint ? { hint: allowed.hint } : {}) } }, allowed.status);
    return null;
  }

  async function readBody(req) {
    try {
      return await readJson(req, MAX_SESSION_BODY_BYTES);
    } catch (error) {
      if (error instanceof AdminAuthError) throw error;
      throw new AdminAuthError(Number(error?.status) === 413 ? 413 : 400, Number(error?.status) === 413 ? "request_too_large" : "invalid_request", "The request body must be a JSON object.");
    }
  }

  // The session API (§5.6). true when it answered.
  async function handle(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (!pathname.startsWith("/api/session") && !pathname.startsWith("/api/admin-tokens")) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      if (pathname === "/api/session" && READ_METHODS.has(method)) {
        respond(res, sessionInfo(req));
        return true;
      }
      if (pathname === PAIR_PATH && method === "POST") {
        const body = await readBody(req);
        const result = pairWithCode(req, body.code);
        if (!result.ok) {
          respond(res, { ok: false, error: { code: result.code, message: result.message } }, result.status);
          return true;
        }
        appendSetCookie(res, result.setCookie);
        respond(res, { ok: true, csrfToken: result.csrfToken });
        return true;
      }
      if (pathname === PAIR_CODES_PATH && method === "POST") {
        const allowed = requireOwner(req, res);
        if (!allowed) return true;
        const who = authenticate(req);
        if (who.role === "owner" && who.via !== "session" && who.via !== "token") throw new AdminAuthError(401, "admin_session_required", "Pair this browser first.");
        const body = await readBody(req);
        const ttlSeconds = body.ttlSeconds === undefined ? PAIR_CODE_TTL_SECONDS : body.ttlSeconds;
        const minted = mintPairCode({ actor: allowed.principal, ttlSeconds, lan: body.lan === true });
        respond(res, { ok: true, ...minted });
        return true;
      }
      if (pathname === LOGOUT_PATH && method === "POST") {
        const result = logout(req);
        appendSetCookie(res, result.setCookie);
        if (!result.ok) throw new AdminAuthError(401, "admin_session_required", "There is no session to end.");
        respond(res, { ok: true });
        return true;
      }
      if (pathname === "/api/session/list" && READ_METHODS.has(method)) {
        if (!requireOwner(req, res)) return true;
        respond(res, { ok: true, items: listSessions(req) });
        return true;
      }
      const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(pathname);
      if (sessionMatch && method === "DELETE") {
        const allowed = requireOwner(req, res);
        if (!allowed) return true;
        if (!revokeSession(decodeURIComponent(sessionMatch[1]), { actor: allowed.principal })) throw new AdminAuthError(404, "not_found", "No such session.");
        respond(res, { ok: true });
        return true;
      }
      if (pathname === "/api/admin-tokens") {
        if (READ_METHODS.has(method)) {
          if (!requireOwner(req, res)) return true;
          respond(res, { ok: true, items: listToolTokens() });
          return true;
        }
        if (method === "POST") {
          const allowed = requireOwner(req, res);
          if (!allowed) return true;
          const body = await readBody(req);
          const issued = issueToolToken({ name: body.name, role: body.role === undefined ? "owner" : body.role, actor: allowed.principal });
          respond(res, { ok: true, ...issued });
          return true;
        }
      }
      const tokenMatch = /^\/api\/admin-tokens\/([^/]+)$/.exec(pathname);
      if (tokenMatch && method === "DELETE") {
        const allowed = requireOwner(req, res);
        if (!allowed) return true;
        if (!revokeToolToken(decodeURIComponent(tokenMatch[1]), { actor: allowed.principal })) throw new AdminAuthError(404, "not_found", "No such admin token.");
        respond(res, { ok: true });
        return true;
      }
    } catch (error) {
      respondError(res, error);
      return true;
    }
    return false;
  }

  return {
    mode: "session",
    authenticate,
    guard,
    handle,
    checkManagementAccess,
    eventTypesFor,
    requireCsrf,
    sessionInfo,
    pairWithCode,
    mintPairCode,
    maybeAutoPair,
    issueToolToken,
    issueElevation,
    checkElevation,
    revokeElevation,
    listSessions,
    revokeSession,
    listToolTokens,
    revokeToolToken,
    logout,
  };
}

// The session API's viewer-registry declarations (05 §5.4, §5.6). GET
// /api/session answers the caller's own role, so it is a viewer route; the
// pair and logout routes are let through by the guard itself.
function registerSessionRoutes(registry) {
  const owner = "05";
  registry.registerRoute({ owner, path: "/api/session" });
  registry.registerAdminOnly({ owner, method: "GET", path: "/api/session/list" });
  registry.registerAdminOnly({ owner, method: "GET", path: "/api/admin-tokens" });
  for (const [method, routePath] of [
    ["POST", PAIR_PATH],
    ["POST", PAIR_CODES_PATH],
    ["POST", LOGOUT_PATH],
    ["DELETE", "/api/session/:sessionId"],
    ["POST", "/api/admin-tokens"],
    ["DELETE", "/api/admin-tokens/:tokenId"],
  ]) {
    registry.registerAdminOnly({ owner, method, path: routePath });
  }
}

module.exports = {
  AdminAuthError,
  AUTO_PAIR_BLOCKERS,
  CSRF_HEADER,
  ELEVATION_COOKIE,
  PAIR_COMMAND_NODE,
  PAIR_COMMAND_PLATFORM,
  SESSION_COOKIE,
  createAdminAuth,
  parseCookies,
  registerSessionRoutes,
  selectPairCommand,
};
