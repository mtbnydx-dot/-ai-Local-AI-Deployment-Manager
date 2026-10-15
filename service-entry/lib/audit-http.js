"use strict";

// Entry audit API (docs/overhaul/04 §16.4, §16.5): /api/audit/* on the ADMIN
// listener.
//
// Access has three layers. The viewer role (a LAN device, or a loopback
// caller without a session) gets 401 admin_session_required on every route
// here, and the pre-dispatch guard says the same because every route is
// registered owner-only. The owner role is the first factor. Content routes
// (chats, a Markdown export, the access log) also need the audit session, a
// second factor created by POST /api/audit/login against the existing audit
// password sources, and read from `x-audit-session` or from an
// `Authorization: Bearer` token that is not a 05 `pat_` tool token. Sessions
// live in memory as sha256 hashes, last 12 h and slide on use. The password
// is never copied, logged or returned.
//
// Every action appends a hash-chained audit_access_log row (see
// manager-core/telemetry/audit-access-log.js). A content route writes its row
// before it answers and fails closed: if the row cannot be written the
// content is not sent. Login failures are throttled per IP.
//
// The conversation endpoints are served from the index of TEL-17
// (manager-core/telemetry/audit-index.js). mount() opens it on first use at
// <auditRoot>/.index/audit-index.sqlite and back-fills it from the existing
// exports in the background; they answer 503 audit_index_unavailable while
// there is no index (deps.index).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../../manager-core");
const { compilePath } = require("./viewer-allowlist");
const { groupAuditChains } = require("../../manager-core/telemetry/audit-chain");
const { openAuditIndex } = require("../../manager-core/telemetry/audit-index");
const { describeSearchQuery } = require("../../manager-core/telemetry/audit-access-log");
const { normalizeSchedule, createAuditScheduler } = require("../../manager-core/telemetry/audit-scheduler");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_PASSWORD_CHARS = 1024;
const MAX_NOTE_CHARS = 500;
const MAX_QUERY_CHARS = 200;
const MAX_CHAT_LIMIT = 100;
const DEFAULT_CHAT_LIMIT = 50;
const MAX_LOG_LIMIT = 500;
const USER_AGENT_LIMIT = 256;
const CONTAINER_CACHE_MS = 5000;
const REDACTED_PATH = "<redacted path>";
const READ_METHODS = new Set(["GET", "HEAD"]);
const SETTINGS_KEYS = Object.freeze(["schedule", "retention", "logQueryText"]);
const CHAT_PARAMS = Object.freeze(["q", "user", "model", "from", "to", "archived", "cursor", "limit"]);
const LOG_PARAMS = Object.freeze(["from", "to", "cursor", "limit"]);

// gate "owner": the owner role is enough. gate "audit": the audit session too.
// `action` is the audit_access_log action of the route (§16.4); a route
// without one is not logged.
const AUDIT_ROUTES = [
  { method: "GET", path: "/api/audit/status", gate: "owner", run: "status", action: null },
  { method: "POST", path: "/api/audit/login", gate: "owner", run: "login", action: "login_ok" },
  { method: "POST", path: "/api/audit/logout", gate: "owner", run: "logout", action: "logout" },
  { method: "GET", path: "/api/audit/exports", gate: "owner", run: "listExports", action: "list_exports" },
  { method: "GET", path: "/api/audit/exports/:auditId/markdown", gate: "audit", run: "markdown", action: "view_markdown" },
  { method: "POST", path: "/api/audit/export", gate: "owner", run: "exportNow", action: "export_manual" },
  { method: "GET", path: "/api/audit/chats", gate: "audit", run: "listChats", action: "list_chats" },
  { method: "GET", path: "/api/audit/chats/:chatId", gate: "audit", run: "viewChat", action: "view_chat" },
  { method: "GET", path: "/api/audit/chats/:chatId/versions", gate: "audit", run: "chatVersions", action: "chat_versions" },
  { method: "GET", path: "/api/audit/access-log", gate: "audit", run: "accessLog", action: null },
  { method: "GET", path: "/api/audit/access-log/verify", gate: "audit", run: "verifyLog", action: "verify" },
  { method: "GET", path: "/api/audit/settings", gate: "owner", run: "getSettings", action: null },
  { method: "PUT", path: "/api/audit/settings", gate: "owner", run: "putSettings", action: "settings_change" },
];
const COMPILED_ROUTES = AUDIT_ROUTES.map((route) => ({ ...route, compiled: compilePath(route.path) }));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function errorBody(code, message, hint, extra) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) }, ...(extra || {}) };
}

function matchRoute(method, pathname) {
  const wanted = String(method || "GET").toUpperCase();
  let pathMatched = false;
  for (const route of COMPILED_ROUTES) {
    const found = route.compiled.regex.exec(pathname);
    if (!found) continue;
    pathMatched = true;
    if (route.method !== wanted) continue;
    const params = {};
    route.compiled.names.forEach((name, position) => {
      try {
        params[name] = decodeURIComponent(found[position + 1]);
      } catch {
        params[name] = found[position + 1];
      }
    });
    return { route, params };
  }
  return pathMatched ? { methodMismatch: true } : null;
}

// Audit sessions (§16.5): sha256(token) -> expiry, 12 h, sliding.
function createAuditSessions({ now = Date.now, ttlMs = SESSION_TTL_MS, randomBytes = crypto.randomBytes } = {}) {
  const sessions = new Map();

  function purge() {
    const t = now();
    for (const [key, session] of sessions) if (session.expiresAt <= t) sessions.delete(key);
    // Room for the session about to be created.
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  return {
    create() {
      purge();
      const token = randomBytes(32).toString("base64url");
      const hash = sha256Hex(token);
      const expiresAt = now() + ttlMs;
      sessions.set(hash, { expiresAt });
      return { token, id: hash.slice(0, 12), expiresAt };
    },
    // {ok, id, expiresAt} or {ok:false, reason: "missing" | "expired"}.
    validate(token) {
      if (!token) return { ok: false, reason: "missing" };
      const hash = sha256Hex(token);
      const session = sessions.get(hash);
      if (!session) return { ok: false, reason: "expired" };
      if (session.expiresAt <= now()) {
        sessions.delete(hash);
        return { ok: false, reason: "expired" };
      }
      session.expiresAt = now() + ttlMs;
      return { ok: true, id: hash.slice(0, 12), expiresAt: session.expiresAt };
    },
    destroy(token) {
      return Boolean(token) && sessions.delete(sha256Hex(token));
    },
    get size() {
      return sessions.size;
    },
  };
}

// 5 failures per minute per IP; the sixth attempt gets 429 until the oldest
// failure leaves the window. A throttled attempt does not extend the window.
function createLoginThrottle({ now = Date.now, limit = LOGIN_FAILURE_LIMIT, windowMs = LOGIN_WINDOW_MS } = {}) {
  const failures = new Map();

  function recent(ip) {
    const t = now();
    const list = (failures.get(ip) || []).filter((at) => t - at < windowMs);
    if (list.length) failures.set(ip, list);
    else failures.delete(ip);
    return list;
  }

  return {
    // Seconds to wait, or 0 when an attempt is allowed.
    blockedFor(ip) {
      const list = recent(ip);
      if (list.length < limit) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000));
    },
    fail(ip) {
      const list = recent(ip);
      list.push(now());
      failures.set(ip, list);
      if (failures.size > 1024) failures.delete(failures.keys().next().value);
      return list.length;
    },
    reset(ip) {
      failures.delete(ip);
    },
  };
}

function headerValue(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

// The audit session token of a request: x-audit-session first, then a bearer
// that is not a 05 `pat_` tool token (07's audit-session.js sends the bearer).
function auditTokenOf(req) {
  const direct = headerValue(req, "x-audit-session").trim();
  if (direct) return direct;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue(req, "authorization").trim());
  const bearer = match ? match[1].trim() : "";
  return bearer && !bearer.startsWith("pat_") ? bearer : "";
}

function clientAddress(req) {
  const address = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/i, "");
  return address.slice(0, 64) || null;
}

function parseTime(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(number) ? Math.floor(number) : undefined;
}

function boundedLimit(value, fallback, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : fallback;
}

function defaultReadJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error("Request body is too large.");
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!isPlainObject(parsed)) throw new Error("not an object");
        return resolve(parsed);
      } catch {
        const error = new Error("Request body must be a JSON object.");
        error.status = 400;
        return reject(error);
      }
    });
    req.on("error", reject);
  });
}

function defaultSendJson(res, data, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

// A docker-ps lookup of one container: {exists, running}. It throws when
// Docker cannot be asked, so "no Docker" is never read as "no container".
function createContainerStatusReader(docker) {
  return async function readContainerStatus(name) {
    const out = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{json .}}"], { rejectOnError: false });
    if (out.error) throw new Error(String(out.stderr || out.error.message || "docker ps failed").trim().slice(0, 200));
    const line = String(out.stdout || "").trim().split(/\r?\n/)[0];
    if (!line) return { exists: false, running: false };
    const info = JSON.parse(line);
    return { exists: true, running: String(info.State || "").toLowerCase() === "running" };
  };
}

function settingsFromSection(read) {
  const values = read && isPlainObject(read.values) ? read.values : isPlainObject(read?.value) ? read.value : {};
  const retention = isPlainObject(values.retention) ? values.retention : {};
  return {
    schedule: normalizeSchedule(values.schedule),
    retention: {
      maxExports: retention.maxExports,
      maxAgeDays: retention.maxAgeDays,
      rebaselineDays: retention.rebaselineDays,
      maxChains: retention.maxChains,
    },
    logQueryText: values.logQueryText === true,
    root: typeof values.root === "string" ? values.root : "",
    etag: read?.etag,
  };
}

function createAuditHttp(deps = {}) {
  const {
    auth,
    store,
    auditStore,
    scheduler,
    index = null,
    config,
  } = deps;
  if (!auth || typeof auth.principal !== "function") throw new TypeError("createAuditHttp needs the request-auth seam");
  if (!auditStore) throw new TypeError("createAuditHttp needs the audit store");
  if (!store || typeof store.appendAuditAccess !== "function") throw new TypeError("createAuditHttp needs the telemetry store");
  if (!scheduler || typeof scheduler.runExport !== "function") throw new TypeError("createAuditHttp needs the audit scheduler");
  if (!config || typeof config.readSection !== "function" || typeof config.writeSection !== "function") {
    throw new TypeError("createAuditHttp needs readSection and writeSection");
  }
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const logger = deps.logger || console;
  const sendJson = typeof deps.sendJson === "function" ? deps.sendJson : defaultSendJson;
  const readJsonObjectBody = typeof deps.readJsonObjectBody === "function" ? deps.readJsonObjectBody : defaultReadJsonBody;
  const openReadStream = typeof deps.createReadStream === "function" ? deps.createReadStream : fs.createReadStream;
  const containerName = String(deps.openWebuiContainer || "open-webui");
  const readContainer = typeof deps.containerStatus === "function" ? deps.containerStatus : null;
  const sessions = deps.sessions || createAuditSessions({ now, ttlMs: deps.sessionTtlMs, randomBytes: deps.randomBytes });
  const throttle = deps.throttle || createLoginThrottle({ now, limit: deps.loginFailureLimit, windowMs: deps.loginWindowMs });
  let containerCache = null;

  function warn(message) {
    try {
      logger.warn?.(core.redactSecrets(`audit-http: ${message}`));
    } catch {
      // Logging never breaks a request.
    }
  }

  function settings() {
    return settingsFromSection(config.readSection("audit"));
  }

  function respond(res, status, body, headers) {
    sendJson(res, body, status, headers);
  }

  function fail(res, status, code, message, hint, extra, headers) {
    respond(res, status, errorBody(code, message, hint, extra), headers);
  }

  function actorOf(req) {
    const principal = String(auth.principal(req)?.principal || "");
    return /^(?:session|token|system):/.test(principal) ? principal : "legacy-local";
  }

  // Appends one audit_access_log row for this request. false when it could not
  // be written; the caller decides whether that stops the answer.
  async function logAccess(req, entry) {
    try {
      await store.appendAuditAccess({
        at: now(),
        source: "entry",
        actor: actorOf(req),
        session: entry.session || null,
        clientIp: clientAddress(req),
        userAgent: headerValue(req, "user-agent").slice(0, USER_AGENT_LIMIT) || null,
        action: entry.action,
        target: entry.target ?? null,
        outcome: entry.outcome || "ok",
        detail: entry.detail ?? null,
      });
      return true;
    } catch (error) {
      warn(`the ${entry.action} access row could not be written (${error?.code || error?.message || "error"})`);
      return false;
    }
  }

  async function containerState() {
    if (!readContainer) return { exists: false, running: false, error: "docker_unavailable" };
    const t = now();
    if (containerCache && t - containerCache.at < CONTAINER_CACHE_MS) return containerCache.value;
    let value;
    try {
      const status = await readContainer(containerName);
      value = { exists: Boolean(status?.exists), running: Boolean(status?.running) };
    } catch {
      value = { exists: false, running: false, error: "docker_unavailable" };
    }
    containerCache = { at: t, value };
    return value;
  }

  // --- handlers -------------------------------------------------------------
  // Each returns {status, body, audit?, stream?}; finish() logs and sends.

  async function status() {
    const [container, schedule, retention] = await Promise.all([containerState(), scheduler.describe(), scheduler.retention()]);
    const indexStats = typeof index?.stats === "function" ? await Promise.resolve(index.stats()).catch(() => null) : null;
    const chains = groupAuditChains(retention.exports).map((chain) => ({ ...chain }));
    return {
      status: 200,
      body: {
        ok: true,
        passwordFile: REDACTED_PATH,
        openWebuiContainer: container,
        schedule: {
          enabled: schedule.enabled,
          incrementalEveryMinutes: schedule.incrementalEveryMinutes,
          fullAtLocal: schedule.fullAtLocal,
          needsRebaseline: schedule.needsRebaseline,
          running: schedule.running,
          nextIncrementalAt: schedule.nextIncrementalAt,
          nextFullAt: schedule.nextFullAt,
        },
        lastRuns: {
          lastRunAt: schedule.lastRunAt,
          lastOkAt: schedule.lastOkAt,
          lastError: schedule.lastError,
          lastSkip: schedule.lastSkip,
          incremental: schedule.lastRuns.incremental,
          full: schedule.lastRuns.full,
        },
        chains,
        retention: { policy: retention.policy, plan: retention.plan },
        index: {
          available: Boolean(index),
          chats: Number(indexStats?.chats || 0),
          messages: Number(indexStats?.messages || 0),
          lastIndexedAt: indexStats?.lastIndexedAt ?? null,
          ...(indexStats?.building ? { building: true } : {}),
        },
      },
    };
  }

  async function login(req) {
    const ip = clientAddress(req) || "unknown";
    const wait = throttle.blockedFor(ip);
    if (wait > 0) {
      req.resume?.();
      return {
        status: 429,
        headers: { "retry-after": String(wait) },
        body: errorBody("audit_login_throttled", "Too many failed audit logins.", `Try again in ${wait} seconds.`),
        audit: { action: "login_failed", outcome: "denied", detail: { reason: "throttled", retryAfterSeconds: wait } },
      };
    }
    const body = await readJsonObjectBody(req, MAX_JSON_BODY_BYTES);
    const password = typeof body.password === "string" ? body.password.slice(0, MAX_PASSWORD_CHARS) : "";
    let valid = false;
    try {
      valid = password ? await auditStore.verifyAuditPassword(password) : false;
    } catch (error) {
      warn(`the audit password could not be checked (${error?.code || "error"})`);
      return {
        status: 500,
        body: errorBody("audit_unavailable", "The audit password could not be checked.", "Check the audit password file."),
        audit: { action: "login_failed", outcome: "error", detail: { reason: "password_check_failed" } },
      };
    }
    if (!valid) {
      const failures = throttle.fail(ip);
      return {
        status: 401,
        body: errorBody("audit_password_invalid", "The audit password is not correct."),
        audit: { action: "login_failed", outcome: "denied", detail: { reason: "invalid_password", failuresInWindow: failures } },
      };
    }
    throttle.reset(ip);
    const session = sessions.create();
    return {
      status: 200,
      body: { ok: true, token: session.token, expiresAt: new Date(session.expiresAt).toISOString() },
      audit: { action: "login_ok", outcome: "ok", session: session.id },
    };
  }

  async function logout(req) {
    const token = auditTokenOf(req);
    const found = token ? sessions.validate(token) : { ok: false };
    const destroyed = token ? sessions.destroy(token) : false;
    return {
      status: 200,
      body: { ok: true },
      audit: { action: "logout", outcome: "ok", session: found.ok ? found.id : null, detail: { hadSession: destroyed } },
    };
  }

  async function listExports() {
    const exports = await auditStore.listAuditExports();
    const chainOf = new Map();
    for (const chain of groupAuditChains(exports)) for (const id of chain.auditIds) chainOf.set(id, chain.fullAuditId);
    // The folder path stays on the host; the list names exports by id.
    const rows = exports.map(({ auditDir, ...item }) => ({
      ...item,
      chainId: chainOf.get(item.auditId) ?? null,
      skippedEmpty: item.mode === "incremental" && Number(item.chatCount || 0) === 0,
    }));
    let lastHeartbeatAt = null;
    try {
      lastHeartbeatAt = (await auditStore.readAuditCursor())?.lastHeartbeatAt ?? null;
    } catch {
      // The cursor is advisory here.
    }
    return {
      status: 200,
      body: { ok: true, exports: rows, lastHeartbeatAt },
      audit: { action: "list_exports", outcome: "ok", detail: { count: rows.length } },
    };
  }

  async function markdown(req, params) {
    const auditId = params.auditId;
    let file;
    try {
      file = await auditStore.getAuditMarkdownPath(auditId);
    } catch (error) {
      const missing = Number(error?.status) === 404;
      const invalid = Number(error?.status) === 400;
      const code = invalid ? "invalid_audit_id" : "audit_file_missing";
      return {
        status: invalid ? 400 : missing ? 404 : 500,
        body: errorBody(code, invalid ? "That is not a valid audit id." : "The audit Markdown file was not found.", "List the exports and choose one that exists."),
        audit: { action: "view_markdown", outcome: "error", target: String(auditId).slice(0, 200), detail: { code } },
      };
    }
    return { status: 200, stream: { file }, audit: { action: "view_markdown", outcome: "ok", target: auditId } };
  }

  async function exportNow(req) {
    const body = await readJsonObjectBody(req, MAX_JSON_BODY_BYTES);
    const mode = body.mode === undefined ? "full" : body.mode;
    if (mode !== "full" && mode !== "incremental") {
      return { status: 400, body: errorBody("invalid_mode", "mode must be \"full\" or \"incremental\"."), audit: { action: "export_manual", outcome: "error", detail: { code: "invalid_mode" } } };
    }
    const note = typeof body.note === "string" ? body.note.slice(0, MAX_NOTE_CHARS) : "";
    const result = await scheduler.runExport({ mode, trigger: "manual", note, actor: actorOf(req) });
    const reply = { ok: Boolean(result.ok), mode: result.mode };
    if (result.auditId) reply.auditId = result.auditId;
    if (result.skipped) reply.skipped = true;
    if (result.reason) reply.reason = result.reason;
    for (const key of ["chatCount", "messageCount", "totalChatCount", "rebaseline", "empty"]) if (result[key] !== undefined) reply[key] = result[key];
    if (Array.isArray(result.pruned) && result.pruned.length) reply.pruned = result.pruned;
    const failed = !result.ok && !result.skipped;
    if (failed) reply.error = { code: "audit_export_failed", message: String(result.error || "The export failed.") };
    return {
      status: failed ? 500 : 200,
      body: reply,
      audit: {
        action: "export_manual",
        outcome: failed ? "error" : "ok",
        target: result.auditId || null,
        detail: { mode: result.mode, skipped: Boolean(result.skipped), reason: result.reason || null, noteLength: note.length },
      },
    };
  }

  function unknownParameter(url, allowed) {
    for (const key of url.searchParams.keys()) if (!allowed.includes(key)) return key;
    return null;
  }

  function badParameter(action, code, message, extra) {
    const spec = { status: 400, body: errorBody(code, message) };
    if (action) spec.audit = { action, outcome: "error", detail: { code, ...(extra || {}) } };
    return spec;
  }

  function indexMissing(action) {
    return {
      status: 503,
      body: errorBody("audit_index_unavailable", "The conversation index is not available yet.", "It is built from the audit exports; try again shortly."),
      audit: { action, outcome: "error", detail: { code: "audit_index_unavailable" } },
    };
  }

  async function listChats(req, params, url) {
    const query = String(url.searchParams.get("q") || "");
    const action = query ? "search" : "list_chats";
    const unknown = unknownParameter(url, CHAT_PARAMS);
    if (unknown) return badParameter(action, "unknown_parameter", `Unknown parameter: ${unknown}`);
    if (query.length > MAX_QUERY_CHARS) return badParameter(action, "invalid_query", "q is too long.");
    const from = parseTime(url.searchParams.get("from"));
    const to = parseTime(url.searchParams.get("to"));
    if (from === undefined || to === undefined) return badParameter(action, "invalid_time", "from and to must be ISO times or epoch milliseconds.");
    const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_CHAT_LIMIT, MAX_CHAT_LIMIT);
    const archivedText = String(url.searchParams.get("archived") || "").toLowerCase();
    const archived = archivedText === "true" || archivedText === "1" ? true : archivedText === "false" || archivedText === "0" ? false : null;
    if (!index || typeof index.searchChats !== "function") return indexMissing(action);
    const found = await index.searchChats({
      q: query,
      user: String(url.searchParams.get("user") || ""),
      model: String(url.searchParams.get("model") || ""),
      from,
      to,
      archived,
      cursor: String(url.searchParams.get("cursor") || ""),
      limit,
    });
    const rows = Array.isArray(found) ? found : Array.isArray(found?.rows) ? found.rows : [];
    const detail = query ? describeSearchQuery(query, { logQueryText: settings().logQueryText }) : { limit };
    return {
      status: 200,
      body: { ok: true, rows, nextCursor: Array.isArray(found) ? null : found?.nextCursor ?? null, ...(found?.index ? { index: found.index } : {}) },
      audit: { action, outcome: "ok", detail: { ...detail, results: rows.length } },
    };
  }

  async function viewChat(req, params, url) {
    const chatId = params.chatId;
    const unknown = unknownParameter(url, ["auditId"]);
    if (unknown) return badParameter("view_chat", "unknown_parameter", `Unknown parameter: ${unknown}`);
    if (!index || typeof index.getChat !== "function") return indexMissing("view_chat");
    const auditId = String(url.searchParams.get("auditId") || "");
    const found = await index.getChat(chatId, auditId ? { auditId } : {});
    if (!found) {
      return {
        status: 404,
        body: errorBody("chat_not_found", "That conversation is not in the index."),
        audit: { action: "view_chat", outcome: "error", target: chatId.slice(0, 200), detail: { code: "chat_not_found" } },
      };
    }
    return {
      status: 200,
      body: { ok: true, ...found },
      audit: { action: "view_chat", outcome: "ok", target: chatId.slice(0, 200), detail: { auditId: found.auditId ?? (auditId || null), messages: Array.isArray(found.messages) ? found.messages.length : 0 } },
    };
  }

  async function chatVersions(req, params) {
    const chatId = params.chatId;
    if (!index || typeof index.chatVersions !== "function") return indexMissing("chat_versions");
    const found = await index.chatVersions(chatId);
    const versions = Array.isArray(found) ? found : Array.isArray(found?.versions) ? found.versions : [];
    if (!versions.length) {
      return {
        status: 404,
        body: errorBody("chat_not_found", "That conversation is not in the index."),
        audit: { action: "chat_versions", outcome: "error", target: chatId.slice(0, 200), detail: { code: "chat_not_found" } },
      };
    }
    return {
      status: 200,
      body: { ok: true, versions },
      audit: { action: "chat_versions", outcome: "ok", target: chatId.slice(0, 200), detail: { versions: versions.length } },
    };
  }

  async function accessLog(req, params, url) {
    const unknown = unknownParameter(url, LOG_PARAMS);
    if (unknown) return badParameter(null, "unknown_parameter", `Unknown parameter: ${unknown}`);
    const from = parseTime(url.searchParams.get("from"));
    const to = parseTime(url.searchParams.get("to"));
    if (from === undefined || to === undefined) return badParameter(null, "invalid_time", "from and to must be ISO times or epoch milliseconds.");
    const cursor = String(url.searchParams.get("cursor") || "");
    if (cursor && !/^\d{1,15}$/.test(cursor)) return badParameter(null, "invalid_cursor", "cursor is not a cursor this API issued.");
    const page = await store.call("auditAccessLog", {
      from,
      to,
      cursor: cursor ? Number(cursor) : null,
      limit: boundedLimit(url.searchParams.get("limit"), 100, MAX_LOG_LIMIT),
    });
    return {
      status: 200,
      body: { ok: true, rows: page.rows, nextCursor: page.nextCursor === null || page.nextCursor === undefined ? null : String(page.nextCursor) },
    };
  }

  async function verifyLog() {
    const result = await store.call("auditAccessVerify", {});
    const body = { ok: Boolean(result.ok), rows: result.rows, firstBrokenSeq: result.firstBrokenSeq ?? null };
    if (result.reason) body.reason = result.reason;
    return {
      status: 200,
      body,
      audit: { action: "verify", outcome: result.ok ? "ok" : "error", detail: { rows: result.rows, firstBrokenSeq: body.firstBrokenSeq } },
    };
  }

  function settingsBody(current) {
    return { schedule: current.schedule, retention: current.retention, logQueryText: current.logQueryText, etag: current.etag };
  }

  async function getSettings() {
    return { status: 200, body: { ok: true, ...settingsBody(settings()) } };
  }

  async function putSettings(req) {
    const body = await readJsonObjectBody(req, MAX_JSON_BODY_BYTES);
    const patch = {};
    for (const key of SETTINGS_KEYS) if (body[key] !== undefined) patch[key] = body[key];
    const unknown = Object.keys(body).filter((key) => key !== "etag" && !SETTINGS_KEYS.includes(key));
    if (unknown.length || !Object.keys(patch).length) {
      return {
        status: 400,
        body: errorBody("invalid_settings", unknown.length ? `Unknown settings: ${unknown.join(", ")}` : "Send schedule, retention or logQueryText.", null, { errors: unknown.map((field) => ({ field, code: "unknown_key" })) }),
        audit: { action: "settings_change", outcome: "error", detail: { code: "invalid_settings" } },
      };
    }
    for (const key of ["schedule", "retention"]) {
      if (patch[key] !== undefined && !isPlainObject(patch[key])) {
        return { status: 400, body: errorBody("invalid_settings", `${key} must be an object.`), audit: { action: "settings_change", outcome: "error", detail: { code: "invalid_settings" } } };
      }
    }
    const etag = body.etag !== undefined ? String(body.etag) : headerValue(req, "if-match").replace(/^"|"$/g, "") || undefined;
    const result = await config.writeSection("audit", patch, { etag, actor: actorOf(req) });
    if (!result || !result.ok) {
      const status = Number(result?.status) || 400;
      const code = result?.error?.code || result?.code || "config_invalid";
      return {
        status,
        body: errorBody(code, result?.error?.message || "The settings were not saved.", null, { errors: result?.errors || [], etag: result?.etag }),
        audit: { action: "settings_change", outcome: "error", detail: { code, keys: Object.keys(patch) } },
      };
    }
    const current = settings();
    return {
      status: 200,
      body: { ok: true, ...settingsBody({ ...current, etag: result.etag ?? current.etag }), changed: result.changed || [], restartRequired: result.restartRequired || [] },
      // Key names only; the values are not part of the audit trail.
      audit: { action: "settings_change", outcome: "ok", detail: { changed: result.changed || [] } },
    };
  }

  const HANDLERS = { status, login, logout, listExports, markdown, exportNow, listChats, viewChat, chatVersions, accessLog, verifyLog, getSettings, putSettings };

  // --- sending --------------------------------------------------------------

  function streamMarkdown(res, file) {
    const stream = openReadStream(file);
    let opened = false;
    res.on("close", () => stream.destroy?.());
    stream.once("open", () => {
      opened = true;
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
      });
      stream.pipe(res);
    });
    stream.on("error", (error) => {
      if (!opened && !res.headersSent) {
        const missing = error?.code === "ENOENT";
        fail(res, missing ? 404 : 500, missing ? "audit_file_missing" : "audit_file_unreadable",
          missing ? "The audit Markdown file was not found." : "The audit Markdown file could not be read.");
        return;
      }
      // Part of the file may be on the wire already; end the connection.
      res.destroy?.();
    });
  }

  async function finish(req, res, route, outcome, session) {
    const spec = outcome || { status: 204 };
    const audit = spec.audit || null;
    if (audit) {
      const written = await logAccess(req, { ...audit, session: audit.session !== undefined ? audit.session : session?.id });
      // The row comes first, and content is not served without it.
      if (!written && route.gate === "audit" && spec.status < 400) {
        return fail(res, 503, "audit_log_unavailable", "The audit access log could not be written, so no content is served.", "Check the telemetry store.");
      }
    }
    if (spec.stream) return streamMarkdown(res, spec.stream.file);
    return respond(res, spec.status, spec.body ?? {}, spec.headers);
  }

  // --- the entry point --------------------------------------------------------

  async function handle(req, res, url) {
    const pathname = String(url?.pathname || "");
    if (!pathname.startsWith("/api/audit/")) return false;
    const who = auth.principal(req);
    if (who.role === "viewer" || who.role === "none") {
      req.resume?.();
      fail(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", "pair");
      return true;
    }
    if (who.role !== "owner") {
      req.resume?.();
      fail(res, 403, "owner_required", "The audit API is for the console owner.");
      return true;
    }
    const matched = matchRoute(req.method, pathname);
    if (!matched) {
      req.resume?.();
      fail(res, 404, "not_found", "No such audit route.");
      return true;
    }
    if (matched.methodMismatch) {
      req.resume?.();
      fail(res, 405, "method_not_allowed", "That method is not allowed on this audit route.");
      return true;
    }
    const { route, params } = matched;
    if (!READ_METHODS.has(req.method)) {
      const check = auth.checkWrite(req);
      if (!check?.ok) {
        req.resume?.();
        fail(res, Number(check?.status) || 403, String(check?.code || "owner_required"), String(check?.message || "This action needs the console owner."));
        return true;
      }
    }
    let session = null;
    if (route.gate === "audit") {
      const found = sessions.validate(auditTokenOf(req));
      if (!found.ok) {
        req.resume?.();
        // A denied attempt is part of the trail, for the routes that have an action.
        if (route.action) await logAccess(req, { action: route.action, outcome: "denied", detail: { reason: found.reason === "expired" ? "audit_session_expired" : "audit_session_required" } });
        fail(res, 401, "audit_session_required", found.reason === "expired" ? "The audit login expired." : "Enter the audit password first.", "POST /api/audit/login");
        return true;
      }
      session = found;
    }
    try {
      const outcome = await HANDLERS[route.run](req, params, url, session);
      await finish(req, res, route, outcome, session);
    } catch (error) {
      const status = Number(error?.status);
      if (status >= 400 && status < 500) {
        // A malformed body: the caller's mistake, not a failure.
        fail(res, status, status === 413 ? "payload_too_large" : "invalid_request", String(error.message || "Invalid request."));
        return true;
      }
      warn(`${route.run} failed: ${error?.stack || error?.message || error}`);
      if (route.action) await logAccess(req, { action: route.action, outcome: "error", session: session?.id, detail: { code: "internal_error" } });
      if (!res.headersSent) fail(res, 500, "internal_error", "Service entry error.");
      else res.destroy?.();
    }
    return true;
  }

  return {
    handle,
    logAccess,
    sessions,
    // For other entry modules (telemetry request detail): has this request
    // an audit session?
    checkSession(req) {
      return sessions.validate(auditTokenOf(req));
    },
  };
}

// Route module (07 §2.7). Mounting registers the routes as owner-only and
// builds nothing else: the stores open on first use. The scheduler starts only
// in a real entry, never in a unit-test process or a frontend smoke run.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || !auth.viewerRegistry) throw new Error("audit-http: ctx.auth is missing");
  const logger = ctx.logger || console;
  for (const route of AUDIT_ROUTES) {
    auth.viewerRegistry.registerAdminOnly({ owner: "04", method: route.method, path: route.path });
  }

  let runtime = null;
  let ownedStore = null;

  function openStore() {
    // The telemetry runtime (TEL-5/11) publishes its store as ctx.telemetryStore;
    // before it exists the audit API opens the same file itself.
    if (ctx.telemetryStore) return Promise.resolve(ctx.telemetryStore);
    if (!ownedStore) {
      const { openTelemetryStore } = require("../../manager-core/telemetry/store");
      const file = process.env.AI_TELEMETRY_DB || path.join(ctx.dataDir || path.join(ctx.rootDir || path.join(ctx.aiRoot || ".", "service-entry"), "data"), "telemetry.sqlite");
      ownedStore = openTelemetryStore({ file, logger });
      ownedStore.then((opened) => {
        if (!ctx.telemetryStore) ctx.telemetryStore = opened;
      }, () => {});
    }
    return ownedStore;
  }

  // A store whose calls open the real one on first use.
  const lazyStore = {};
  for (const method of ["appendAuditAccess", "call", "getState", "setState", "insertEvents"]) {
    lazyStore[method] = async (...args) => (await openStore())[method](...args);
  }

  // The index file and its folder are created on first use, so a mounted but
  // unused audit API leaves nothing behind. A failure to open it is logged once
  // and leaves the conversation routes answering 503.
  let lazyIndex = null;
  function createLazyIndex(auditRoot) {
    let opened = null;
    let failed = false;
    function open() {
      if (opened || failed) return opened;
      try {
        opened = openAuditIndex({ file: path.join(auditRoot, ".index", "audit-index.sqlite"), logger });
        if (backgroundAllowed) {
          opened.backfill(auditRoot).then((summary) => {
            if (summary.indexed.length || summary.removed.length || summary.failed.length) {
              logger.log?.(`audit-http: index back-fill indexed ${summary.indexed.length}, removed ${summary.removed.length}, failed ${summary.failed.length} export(s)`);
            }
          }, (error) => logger.warn?.(core.redactSecrets(`audit-http: index back-fill failed: ${error?.code || error?.message || error}`)));
        }
      } catch (error) {
        failed = true;
        logger.warn?.(core.redactSecrets(`audit-http: the conversation index could not be opened: ${error?.code || error?.message || error}`));
      }
      return opened;
    }
    function need() {
      const instance = open();
      if (!instance) throw Object.assign(new Error("The conversation index is not available."), { code: "audit_index_unavailable" });
      return instance;
    }
    lazyIndex = {
      warm: open,
      indexExport: async (...args) => need().indexExport(...args),
      removeExport: async (...args) => need().removeExport(...args),
      searchChats: async (...args) => need().searchChats(...args),
      getChat: async (...args) => need().getChat(...args),
      chatVersions: async (...args) => need().chatVersions(...args),
      // Never opens the index just to report on it.
      stats: async () => (opened || failed ? opened?.stats() ?? null : null),
      close: async () => opened?.close(),
    };
    return lazyIndex;
  }

  function buildRuntime() {
    const aiRoot = ctx.aiRoot || process.env.AI_ROOT || ".";
    const platform = core.platform;
    const config = ctx.auditConfig || {
      readSection: (name) => platform.readSection(name, { aiRoot }),
      writeSection: (name, patch, options) => platform.writeSection(name, patch, { aiRoot, ...options }),
    };
    const current = () => settingsFromSection(config.readSection("audit"));
    const auditRoot = current().root || process.env.AI_AUDIT_ROOT || path.join(aiRoot, "audit-logs");
    const passwordFile = process.env.AI_AUDIT_PASSWORD_FILE || path.join(auditRoot, "audit-admin-password.txt");
    const wslDistro = String(process.env.DOCKER_WSL_DISTRO || "").trim();
    if (wslDistro && !/^[A-Za-z0-9._-]+$/.test(wslDistro)) throw new Error("DOCKER_WSL_DISTRO contains unsupported characters.");
    const runtimeDocker = core.createDockerRuntime({
      dockerExe: wslDistro ? (process.env.WSL_EXE || "wsl.exe") : core.firstExisting([process.env.DOCKER_EXE, "docker"]),
      dockerArgsPrefix: wslDistro ? ["-d", wslDistro, "--exec", "docker"] : [],
      runtimeName: wslDistro ? `WSL ${wslDistro}` : "Docker Desktop",
    });
    const openWebuiContainer = process.env.OPEN_WEBUI_CONTAINER || "open-webui";
    const containerStatus = createContainerStatusReader(runtimeDocker.docker);
    // The retention limits are read per call, so a settings change applies
    // to the next export without a restart.
    const auditStoreOptions = {
      auditRoot,
      auditPasswordFile: passwordFile,
      legacyPasswordFiles: ["vllm-manager", "llama-manager"].map((name) => path.join(aiRoot, name, "logs", "audit-admin-password.txt")),
      openWebuiContainer,
      serviceContainer: "service-entry",
      managerName: "service-entry",
      docker: runtimeDocker.docker,
      getContainerStatus: containerStatus,
      logger,
      onLog: (line) => logger.log?.(core.redactSecrets(String(line))),
      get auditMaxExports() { return current().retention.maxExports; },
      get auditMaxAgeDays() { return current().retention.maxAgeDays; },
      get auditRebaselineDays() { return current().retention.rebaselineDays; },
      get auditMaxChains() { return current().retention.maxChains; },
    };
    const auditStore = core.createAuditStore(auditStoreOptions);
    const index = ctx.auditIndex || createLazyIndex(auditRoot);
    const scheduler = createAuditScheduler({
      auditStore,
      index,
      store: lazyStore,
      config: current,
      now: ctx.now,
      events: ctx.bus,
      containerStatus: () => containerStatus(openWebuiContainer),
      logger,
    });
    const http = createAuditHttp({
      auth,
      sendJson: ctx.sendJson,
      readJsonObjectBody: ctx.readJsonObjectBody,
      store: lazyStore,
      auditStore,
      scheduler,
      index,
      config,
      now: ctx.now,
      logger,
      openWebuiContainer,
      containerStatus,
    });
    return { http, scheduler, index };
  }

  function getRuntime() {
    if (!runtime) {
      runtime = buildRuntime();
      // Other entry modules ask this object for the audit session and the log.
      ctx.audit = { checkSession: runtime.http.checkSession, logAccess: runtime.http.logAccess, sessions: runtime.http.sessions, index: runtime.index, scheduler: runtime.scheduler };
    }
    return runtime;
  }

  const backgroundAllowed = ctx.auditScheduler !== false
    && process.env.AI_FRONTEND_SMOKE !== "1"
    && !process.env.NODE_TEST_CONTEXT;
  if (backgroundAllowed) {
    try {
      getRuntime().scheduler.start();
      lazyIndex?.warm();
    } catch (error) {
      logger.warn?.(core.redactSecrets(`audit-http: the export scheduler was not started: ${error?.message || error}`));
    }
  }

  return {
    handle: (req, res, url) => (String(url?.pathname || "").startsWith("/api/audit/") ? getRuntime().http.handle(req, res, url) : false),
    close() {
      runtime?.scheduler.stop();
      lazyIndex?.close().catch(() => {});
      if (ownedStore) {
        ownedStore.then((opened) => opened.close?.(), () => {});
      }
    },
  };
}

module.exports = {
  AUDIT_ROUTES,
  createAuditHttp,
  createAuditSessions,
  createContainerStatusReader,
  createLoginThrottle,
  feature: "audit",
  mount,
  name: "audit",
};
