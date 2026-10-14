"use strict";

// Management proxy (07 §2.10, 00 §5).
//
// ANY /api/m/<managerId>/<rest> on the entry is the manager's
// http://127.0.0.1:<port>/api/<rest>, query string kept, so the console
// reaches both managers through one same-origin route instead of their ports
// (/api/m/vllm/engines is the vLLM manager's /api/engines).
//
// Access is decided here through the request-auth seam (07 §2.9): a read
// needs the owner or a registered viewer route, anything else needs
// auth.checkWrite(). A refused request never reaches a manager.
//
// Only an allowlist of request headers travels upstream, plus an
// x-request-id the proxy always mints itself. Cookies, credentials, CSRF
// tokens, Origin and every x-forwarded-* stay at the entry, so the managers'
// own isLocalRequest gate still sees a plain loopback caller. Owner responses
// stream through unchanged, event streams with no buffering and no timeout. A
// redacting principal's JSON is buffered and passed through the matched
// viewer entry's redaction, because a piped body bypasses the central
// sendJson redaction.
//
// The module also provides the entry's in-process manager client (the same
// mapping, buffered JSON), which entry backends use for their own manager
// calls instead of building manager URLs.

const http = require("node:http");
const { REDACTED, redactSecrets } = require("../../manager-core/secret-redactor");
// 00 §3 and §9.9: req_ plus 20 lowercase base32 characters, minted by the entry.
const { newRequestId } = require("../../manager-core/telemetry/ids");

const PREFIX = "/api/m/";
const UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30000;
// Manager actions answer when they are done: POST /api/docker/start waits up
// to 120 s for Docker Desktop, /api/test and benchmarks run a real completion
// (up to 180 s). A write therefore gets a longer idle deadline than a read, so
// the console is not told 504 while the action is still running.
const DEFAULT_WRITE_TIMEOUT_MS = 300000;
const REQUEST_BODY_LIMIT_BYTES = 2 << 20;
const RESPONSE_LIMIT_BYTES = 4 << 20;
// content-length is recomputed from the buffered body; x-request-id is minted.
const FORWARDED_REQUEST_HEADERS = Object.freeze(["accept", "content-type", "content-length", "last-event-id"]);
const READ_METHODS = new Set(["GET", "HEAD"]);
// A successful request with one of these methods changed nothing, so the
// relay is not asked for an early instances poll.
const NON_MUTATING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_ID_RE = /^req_[a-z2-7]{20}$/;
// 07 §2.9: the proxied manager reads a viewer may call. Other specs register
// their own (01: engines, engines/:id/schema, runtimes/:rid/flags).
const VIEWER_READS = Object.freeze(["status", "instances", "running-models", "models", "stats", "jobs", "tools/health"]);
// Declared admin-only for the 05 inventory; a registered viewer read is more
// specific and wins over this wildcard.
const ADMIN_ONLY_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function managerTable(managers) {
  const table = new Map();
  for (const item of Array.isArray(managers) ? managers : []) {
    const id = String(item?.id || "").trim();
    const port = Number(item?.port);
    if (!id || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    table.set(id, port);
  }
  return table;
}

// The request target as the client sent it, before WHATWG URL parsing
// resolves dot segments, turns backslashes into slashes and so on.
function rawRequestPath(req) {
  const target = String(req?.url || "");
  const end = target.search(/[?#]/);
  return end < 0 ? target : target.slice(0, end);
}

// "" when a raw path segment is safe to hand to a manager, otherwise why not.
function segmentProblem(segment) {
  if (!segment) return "empty";
  if (segment.includes("\\")) return "backslash";
  if (/%(2f|5c)/i.test(segment)) return "encoded_separator";
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return "bad_encoding";
  }
  if (decoded === "." || decoded === "..") return "dot_segment";
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return "control_character";
  return "";
}

function routeError(status, code, message) {
  return { error: { status, code, message } };
}

// null when the request is not for the proxy; otherwise the upstream target
// or the error to answer with.
function resolveRoute(req, url, table) {
  const raw = rawRequestPath(req);
  if (!url.pathname.startsWith(PREFIX) && !raw.startsWith(PREFIX)) return null;
  const invalid = routeError(400, "invalid_path", "The manager path is not valid: no empty, dot or encoded-separator segments.");
  // URL parsing moved the path onto /api/m/ (or off it), so the client sent
  // dot segments, backslashes or an absolute-form target.
  if (!raw.startsWith(PREFIX) || !url.pathname.startsWith(PREFIX)) return invalid;
  const segments = raw.slice(PREFIX.length).split("/");
  if (segments.some((segment) => segmentProblem(segment))) return invalid;
  const managerId = decodeURIComponent(segments[0]);
  const port = table.get(managerId);
  if (!port) return routeError(404, "unknown_manager", "No manager is registered under this id.");
  if (segments.length < 2) return invalid;
  // The parsed pathname is the same path, percent-encoded where an HTTP
  // request line needs it.
  const base = `${PREFIX}${segments[0]}/`;
  if (!url.pathname.startsWith(base)) return invalid;
  const rest = url.pathname.slice(base.length);
  return { managerId, port, rest, upstreamPath: `/api/${rest}${url.search}` };
}

function errorBody(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function writeJson(res, status, text, requestId) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-request-id": requestId,
  });
  res.end(text);
}

function sendError(res, status, requestId, code, message, extra) {
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  writeJson(res, status, JSON.stringify(errorBody(code, message, extra)), requestId);
}

function upstreamHeaders(incoming, requestId, body) {
  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (name === "content-length") continue;
    const value = incoming?.[name];
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  if (body) headers["content-length"] = String(body.length);
  headers["x-request-id"] = requestId;
  return headers;
}

// Upstream response headers minus hop-by-hop ones, cookies and CORS (the
// entry's own policy governs its origin); x-request-id is always the proxy's.
function passThroughHeaders(headers, requestId, stream) {
  const named = new Set(String(headers?.connection || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key) || named.has(key)) continue;
    if (key === "set-cookie" || key === "x-request-id" || key.startsWith("access-control-")) continue;
    out[key] = value;
  }
  out["x-request-id"] = requestId;
  if (stream) {
    out["cache-control"] = "no-store";
    out["x-accel-buffering"] = "no";
    // An ended stream closes its socket, so server.close() never waits on an
    // idle keep-alive connection a closed EventSource left behind.
    out.connection = "close";
  }
  return out;
}

function isEventStream(headers) {
  return /^text\/event-stream\b/i.test(String(headers?.["content-type"] || ""));
}

// Buffers a request body up to `limit`. An oversized body is discarded rather
// than cut off, so the 413 reaches a client that is still sending.
function readRequestBody(req, limit) {
  // 05's guard already read a signed request's body into req.rawBody (05 §5.7).
  if (Buffer.isBuffer(req.rawBody)) {
    return Promise.resolve(req.rawBody.length > limit ? { tooLarge: true } : { body: req.rawBody });
  }
  return new Promise((resolve) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onGone);
      req.off("close", onGone);
      resolve(value);
    };
    function onData(chunk) {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        settle({ tooLarge: true });
        req.resume();
        return;
      }
      chunks.push(chunk);
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

// --- viewer redaction for the proxied manager reads (07 §2.9) ---------------

const VIEWER_DROPPED_KEYS = new Set([
  // Credentials.
  "authorization", "cookie", "cookies", "set-cookie", "password", "passwd", "credential", "credentials", "secrets",
  "keyhash", "keyprefix",
  // Host paths, command lines and process detail.
  "path", "paths", "root", "dir", "cwd", "mounts", "volumes", "binds", "argv", "args", "command", "commandline",
  "cmdline", "cmd", "env", "environment", "extraenv", "logs", "hostname", "machinename", "computername", "username",
  // Client details that are not one of CLIENT_DETAIL_NAMES' forms.
  "serviceclients", "recentclients", "externalaccess", "byclient", "callers",
]);

// Who called, from where and with what (07 §2.9 "client details"). Each name
// is also dropped as a plural, with a "top" prefix and with - or _ in it, so
// the access groups in a manager's stats (manager-core/access-log.js:
// remoteAddresses, userAgents, origins, refererHosts, sourcePrograms and
// topRemoteAddress, topUserAgent, topOrigin, topRefererHost,
// topSourceProgram) go along with the single fields.
const CLIENT_DETAIL_NAMES = new Set([
  "client", "clientid", "clientip", "clientaddress", "clientname", "remoteaddress", "remoteip", "remotehost", "ip",
  "useragent", "origin", "referer", "referrer", "refererhost", "referrerhost", "sourceprogram", "forwardedfor",
  "xforwardedfor", "xrealip",
]);

function isClientDetailKey(key) {
  const bare = key.toLowerCase().replace(/[-_]/g, "").replace(/^top/, "");
  return CLIENT_DETAIL_NAMES.has(bare) || CLIENT_DETAIL_NAMES.has(bare.replace(/(es|s)$/, ""));
}

// A manager's access summary (recentAccess in GET /api/stats, built by
// access-log.js buildRecentAccessStats) is grouped by caller: its source
// groups are keyed by a program label that carries the caller's origin host
// ("Browser · host"), and `recent` lists single requests. A viewer keeps the
// counts only.
const ACCESS_SUMMARY_KEYS = new Set(["recentaccess"]);
const ACCESS_SUMMARY_KEPT = Object.freeze(["ok", "updatedAt", "windowMs", "startAt", "endAt", "totals", "error"]);

function viewerDropsKey(key) {
  if (key === "__proto__" || VIEWER_DROPPED_KEYS.has(key.toLowerCase()) || isClientDetailKey(key)) return true;
  return /token$/i.test(key) // token, hfToken, trustToken
    || /secret$/i.test(key) // clientSecret
    || /api[-_]?keys?$/i.test(key) // apiKey, api_key, x-api-key, VLLM_API_KEY
    || /(service|admin|public|private|access|master|signing|hmac)[-_]?keys?$/i.test(key)
    || /^p?pids?$/i.test(key) || /^pid[A-Z_-]/.test(key) || /[a-z0-9]Pids?$/.test(key) || /[_-]pids?$/i.test(key)
    || /[a-z0-9](Path|Paths|Root|Roots|Dir|Dirs|Directory|File|Files)$/.test(key);
}

const FILE_URL_RE = /\bfile:\/\/[^\s"'<>|,;]*/gi;
const WINDOWS_PATH_RE = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?,;]*/g;
const UNC_PATH_RE = /\\\\[^\s"'<>|,;]+/g;
const POSIX_HOST_PATH_RE = /(^|[\s"'=(,:])\/(?:home|Users|root|mnt|media|wsl)(?=$|[/\s"'<>|,;])[^\s"'<>|,;]*/g;

// Absolute host paths become the redactor's marker, then secret-shaped text
// goes through the platform redactor.
function scrubViewerString(text) {
  let out = text;
  if (out.includes(":") || out.includes("\\")) {
    out = out
      .replace(FILE_URL_RE, REDACTED)
      .replace(WINDOWS_PATH_RE, (match, lead) => `${lead}${REDACTED}`)
      .replace(UNC_PATH_RE, REDACTED);
  }
  if (out.includes("/")) out = out.replace(POSIX_HOST_PATH_RE, (match, lead) => `${lead}${REDACTED}`);
  return redactSecrets(out);
}

function redactViewerValue(value, depth) {
  if (typeof value === "string") return scrubViewerString(value);
  // Manager JSON is shallow; anything this deep is not worth showing.
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((item) => redactViewerValue(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (viewerDropsKey(key)) continue;
    const name = scrubViewerString(key);
    if (name === "__proto__") continue;
    out[name] = ACCESS_SUMMARY_KEYS.has(key.toLowerCase()) && isPlainObject(item)
      ? redactAccessSummary(item, depth + 1)
      : redactViewerValue(item, depth + 1);
  }
  return out;
}

function redactAccessSummary(summary, depth) {
  const out = {};
  for (const key of ACCESS_SUMMARY_KEPT) {
    if (Object.prototype.hasOwnProperty.call(summary, key)) out[key] = redactViewerValue(summary[key], depth + 1);
  }
  return out;
}

// The registered redaction for the proxied manager reads: strips host paths,
// PIDs, command lines, client details (addresses, user agents, origins,
// referrers, source programs, per-caller access groups) and key-shaped fields
// (apiKey, *Token, authorization), and redacts secret-shaped text. It builds
// a new value.
function redactManagerReadForViewer(body) {
  return redactViewerValue(body, 0);
}

function registerViewerRoutes(registry, warn) {
  const registrations = [
    ...VIEWER_READS.map((name) => () => registry.registerRoute({
      owner: "07",
      method: "GET",
      path: `/api/m/:managerId/${name}`,
      redact: redactManagerReadForViewer,
    })),
    ...ADMIN_ONLY_METHODS.map((method) => () => registry.registerAdminOnly({ owner: "07", method, path: "/api/m/:managerId/*" })),
  ];
  for (const register of registrations) {
    try {
      register();
    } catch (error) {
      // An entry that cannot be registered stays owner-only (deny by default).
      warn(`mgmt-proxy: a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

function loggerWarn(logger) {
  return (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging must never break a request.
    }
  };
}

function loggerInfo(logger) {
  return (line) => {
    try {
      if (typeof logger?.log === "function") logger.log(redactSecrets(String(line)));
    } catch {
      // Logging must never break a request.
    }
  };
}

// --- the proxy ---------------------------------------------------------------

function createMgmtProxy(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new TypeError("createMgmtProxy needs the request-auth seam");
  }
  const table = managerTable(options.managers);
  const requestTimeoutMs = positiveInt(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
  const writeTimeoutMs = positiveInt(options.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS);
  const bodyLimit = positiveInt(options.maxBodyBytes, REQUEST_BODY_LIMIT_BYTES);
  const responseLimit = positiveInt(options.maxResponseBytes, RESPONSE_LIMIT_BYTES);
  const httpRequest = typeof options.httpRequest === "function" ? options.httpRequest : http.request;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const warn = loggerWarn(options.logger || console);
  const info = loggerInfo(options.logger || console);
  // `relay` is the ENT-EV3 relay or a function returning it; the mount passes
  // () => ctx.relay, because the relay mounts after the proxy.
  const relaySource = options.relay ?? null;
  const inflight = new Set();
  const outages = new Map();
  const warnedOnce = new Set();
  let closed = false;

  function warnOnce(key, line) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    warn(line);
  }

  function clockMs() {
    try {
      const value = Number(now());
      if (Number.isFinite(value)) return value;
    } catch {
      // Fall through.
    }
    return Date.now();
  }

  // One line when a manager stops answering, one when it is back; the
  // console polling a stopped manager never floods the log.
  function noteDown(managerId, reason) {
    if (outages.has(managerId)) return;
    outages.set(managerId, clockMs());
    warn(`mgmt-proxy: the ${managerId} manager is not answering (${reason}); further failures are not logged until it answers again`);
  }

  function noteUp(managerId) {
    if (!outages.has(managerId)) return;
    const seconds = Math.max(0, Math.round((clockMs() - outages.get(managerId)) / 1000));
    outages.delete(managerId);
    info(`mgmt-proxy: the ${managerId} manager answers again after ${seconds} s`);
  }

  function currentRelay() {
    try {
      if (relaySource && typeof relaySource.poke === "function") return relaySource;
      return typeof relaySource === "function" ? relaySource() : null;
    } catch {
      return null;
    }
  }

  // After a successful write the relay polls instances at once, so a start
  // or stop shows up within one poll. Without ENT-EV3 there is nothing to do.
  function poke(managerId) {
    const relay = currentRelay();
    if (!relay || typeof relay.poke !== "function") return;
    try {
      const pending = relay.poke(managerId);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (error) {
      warnOnce("poke", `mgmt-proxy: relay.poke failed; later failures are not logged: ${error?.message || error}`);
    }
  }

  // { ok, redact } or the auth result's refusal. A read needs the owner or a
  // registered viewer route; anything else, and an unregistered read, needs
  // auth.checkWrite() (owner plus CSRF once 05's sessions land).
  function decideAccess(req, method, pathname) {
    const who = auth.principal(req) || {};
    if (READ_METHODS.has(method)) {
      if (who.role === "owner" && !who.redact) return { ok: true, redact: false };
      if (who.role && who.role !== "none") {
        let found = null;
        try {
          found = auth.viewerRegistry.match(method, pathname);
        } catch {
          found = null;
        }
        // A principal 05 serves unredacted (system:mcp) keeps the raw body.
        if (found && found.access === "viewer") return { ok: true, redact: who.redact !== false };
      }
    }
    const allowed = auth.checkWrite(req) || {};
    if (allowed.ok) return { ok: true, redact: false };
    return {
      ok: false,
      status: Number(allowed.status) || 403,
      code: String(allowed.code || "management_local_only"),
      message: String(allowed.message || "This action needs the console owner."),
    };
  }

  function finishRedacted(job, status, text) {
    const { req, res, requestId } = job;
    if (job.method === "HEAD" || !text.length) {
      res.writeHead(status, {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      });
      res.end();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendError(res, 502, requestId, "response_not_redactable", "The manager answered with a body the viewer redaction cannot read.");
      return;
    }
    let out;
    try {
      out = JSON.stringify(auth.redactFor(req, job.pathname, parsed));
    } catch (error) {
      warnOnce(`redact:${job.pathname}`, `mgmt-proxy: the viewer redaction for ${job.pathname} failed; the body is not sent: ${error?.message || error}`);
      out = undefined;
    }
    if (typeof out !== "string") {
      sendError(res, 500, requestId, "internal_error", "Service entry error.");
      return;
    }
    writeJson(res, status, out, requestId);
  }

  // Redacting principals: buffered, bounded, never an event stream.
  function relayRedacted(job, upstream, response) {
    const { res, requestId } = job;
    const status = response.statusCode || 502;
    if (isEventStream(response.headers)) {
      job.own = true;
      upstream.destroy();
      sendError(res, 502, requestId, "response_not_redactable", "Event streams from a manager are not available to viewers.");
      return;
    }
    const chunks = [];
    let total = 0;
    response.on("data", (chunk) => {
      if (job.own) return;
      total += chunk.length;
      if (total > job.responseLimit) {
        job.own = true;
        chunks.length = 0;
        upstream.destroy();
        sendError(res, 502, requestId, "response_too_large", "The manager response is too large to redact for viewers.");
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      if (job.own) return;
      job.own = true;
      finishRedacted(job, status, Buffer.concat(chunks, total).toString("utf8"));
    });
    response.on("close", () => {
      if (job.own || job.clientGone || response.complete) return;
      job.own = true;
      sendError(res, 502, requestId, "manager_unreachable", `The ${job.route.managerId} manager closed the connection mid-response.`, {
        managerId: job.route.managerId,
        hint: "Retry; if it keeps failing, check the manager's log.",
      });
    });
  }

  // Owners: status, headers and bytes as the manager sent them.
  function relayPassThrough(job, upstream, response) {
    const { res, requestId, method } = job;
    const status = response.statusCode || 502;
    const stream = isEventStream(response.headers);
    // A live stream has no deadline; it ends when either side goes away.
    if (stream) upstream.setTimeout(0);
    job.piping = true;
    job.stream = stream;
    res.writeHead(status, passThroughHeaders(response.headers, requestId, stream));
    if (stream) {
      res.socket?.setNoDelay?.(true);
      res.flushHeaders?.();
    }
    let poked = false;
    const pokeOnce = () => {
      if (poked || closed) return;
      poked = true;
      if (status >= 200 && status < 300 && !NON_MUTATING_METHODS.has(method)) poke(job.route.managerId);
    };
    response.on("end", pokeOnce);
    response.on("close", () => {
      // The manager went away mid-body: the client must not see a clean end.
      if (!response.complete && !res.writableEnded) res.destroy();
      pokeOnce();
    });
    response.pipe(res);
  }

  function startUpstream(job) {
    const { req, res, route, method, requestId } = job;
    let upstream;
    try {
      upstream = httpRequest({
        host: UPSTREAM_HOST,
        port: route.port,
        method,
        path: route.upstreamPath,
        headers: upstreamHeaders(req.headers, requestId, job.body),
        // One socket per proxied request, so a stream or an abort never
        // affects another request.
        agent: false,
      });
    } catch {
      sendError(res, 400, requestId, "invalid_request", "The request cannot be forwarded to the manager.");
      return;
    }
    const flight = {
      res,
      upstream,
      stop() {
        job.own = true;
        upstream.destroy();
        try {
          // An event stream ends cleanly (EventSource reconnects). Any other
          // response cut short is destroyed, so a partly piped body never
          // looks complete to the client.
          if (job.stream && res.headersSent) res.end();
          else if (!res.writableEnded) res.destroy();
        } catch {
          // Already gone.
        }
      },
    };
    inflight.add(flight);
    const settle = () => inflight.delete(flight);
    let timedOut = false;
    const timeoutMs = READ_METHODS.has(method) ? requestTimeoutMs : writeTimeoutMs;
    upstream.setTimeout(timeoutMs, () => {
      timedOut = true;
      upstream.destroy(new Error(`no answer within ${timeoutMs} ms`));
    });
    upstream.on("error", (error) => {
      settle();
      if (job.own || job.clientGone) return;
      job.own = true;
      if (job.piping || res.headersSent) {
        res.destroy();
        return;
      }
      const { managerId } = route;
      if (timedOut) {
        noteDown(managerId, "timed out");
        sendError(res, 504, requestId, "manager_timeout", `The ${managerId} manager did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s.`, {
          managerId,
          hint: "The manager may be busy loading a model; retry in a moment.",
        });
        return;
      }
      noteDown(managerId, error?.code || error?.message || "connection failed");
      sendError(res, 502, requestId, "manager_unreachable", `The ${managerId} manager is not running or not answering.`, {
        managerId,
        hint: `Start it (POST /api/managers/${managerId}/start) and retry.`,
      });
    });
    upstream.on("response", (response) => {
      noteUp(route.managerId);
      response.on("close", settle);
      if (job.redact) relayRedacted(job, upstream, response);
      else relayPassThrough(job, upstream, response);
    });
    // The client left: close the upstream too (an event stream otherwise
    // stays open on the manager).
    res.on("close", () => {
      if (!res.writableFinished) {
        job.clientGone = true;
        upstream.destroy();
      }
      settle();
    });
    upstream.end(job.body && job.body.length ? job.body : undefined);
  }

  async function handle(req, res, url) {
    const route = resolveRoute(req, url, table);
    if (!route) return false;
    const requestId = newRequestId();
    if (route.error) {
      req.resume();
      sendError(res, route.error.status, requestId, route.error.code, route.error.message);
      return true;
    }
    if (closed) {
      req.resume();
      sendError(res, 503, requestId, "mgmt_proxy_closed", "The service entry is shutting down.");
      return true;
    }
    const method = String(req.method || "GET").toUpperCase();
    const access = decideAccess(req, method, url.pathname);
    if (!access.ok) {
      req.resume();
      sendError(res, access.status, requestId, access.code, access.message);
      return true;
    }
    let body = null;
    if (READ_METHODS.has(method)) {
      req.resume();
    } else {
      const read = await readRequestBody(req, bodyLimit);
      // The client is gone; nothing went upstream.
      if (read.aborted) return true;
      if (read.tooLarge) {
        sendError(res, 413, requestId, "body_too_large", `The request body is larger than ${bodyLimit} bytes.`);
        return true;
      }
      body = read.body;
    }
    if (closed) {
      sendError(res, 503, requestId, "mgmt_proxy_closed", "The service entry is shutting down.");
      return true;
    }
    startUpstream({
      req,
      res,
      route,
      method,
      body,
      requestId,
      pathname: url.pathname,
      redact: access.redact,
      responseLimit,
      own: false,
      piping: false,
      stream: false,
      clientGone: false,
    });
    return true;
  }

  // Server close: every upstream request and proxied stream ends here.
  function close() {
    if (closed) return;
    closed = true;
    for (const flight of [...inflight]) flight.stop();
    inflight.clear();
  }

  return { handle, close, stats: () => ({ inflight: inflight.size, down: [...outages.keys()] }) };
}

// --- in-process manager client ---------------------------------------------

// `target` is the <rest> of /api/m/:managerId/<rest> ("engines",
// "/engines/vllm/schema?model=x"); each segment is re-encoded canonically.
function clientUpstreamPath(target, query) {
  const text = String(target ?? "").replace(/^\/+/, "");
  const cut = text.indexOf("?");
  const pathText = cut < 0 ? text : text.slice(0, cut);
  const segments = pathText.split("/");
  if (segments.some((segment) => segmentProblem(segment))) return null;
  const encoded = segments.map((segment) => encodeURIComponent(decodeURIComponent(segment)));
  const search = new URLSearchParams(cut < 0 ? "" : text.slice(cut + 1));
  if (isPlainObject(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return `/api/${encoded.join("/")}${qs ? `?${qs}` : ""}`;
}

function failureCode(status, data) {
  if (typeof data?.error?.code === "string" && data.error.code) return data.error.code;
  if (typeof data?.code === "string" && data.code) return data.code;
  return `http_${status}`;
}

function failureMessage(data) {
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.error === "string") return data.error;
  return "";
}

// request() never throws. It resolves to
//   { ok, status, data, requestId, managerId }                      on any HTTP answer (ok = 2xx)
//   + { code, message }                                              when ok is false
// status 0 means no HTTP answer: unknown_manager, invalid_path,
// manager_unreachable, manager_timeout, response_too_large or aborted.
function createManagerClient(options = {}) {
  const table = managerTable(options.managers);
  const defaultTimeoutMs = positiveInt(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
  const defaultWriteTimeoutMs = positiveInt(options.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS);
  const responseLimit = positiveInt(options.maxResponseBytes, RESPONSE_LIMIT_BYTES);
  const httpRequest = typeof options.httpRequest === "function" ? options.httpRequest : http.request;
  const inflight = new Set();
  let closed = false;

  function request(managerId, target, requestOptions = {}) {
    const opts = isPlainObject(requestOptions) ? requestOptions : {};
    const id = String(managerId ?? "");
    const requestId = REQUEST_ID_RE.test(String(opts.requestId || "")) ? String(opts.requestId) : newRequestId();
    const failed = (code, message, extra = {}) => ({ ok: false, status: 0, code, message, data: null, requestId, managerId: id, ...extra });
    const port = table.get(id);
    if (!port) return Promise.resolve(failed("unknown_manager", "No manager is registered under this id."));
    const upstreamPath = clientUpstreamPath(target, opts.query);
    if (!upstreamPath) return Promise.resolve(failed("invalid_path", "The manager path is not valid."));
    if (closed) return Promise.resolve(failed("aborted", "The service entry is shutting down."));
    const method = String(opts.method || "GET").toUpperCase();
    let body = null;
    if (opts.body !== undefined && !READ_METHODS.has(method)) {
      try {
        body = Buffer.from(JSON.stringify(opts.body) ?? "null");
      } catch {
        return Promise.resolve(failed("invalid_request", "The request body cannot be serialised as JSON."));
      }
    } else if (!READ_METHODS.has(method)) {
      body = Buffer.alloc(0);
    }
    const timeoutMs = positiveInt(opts.timeoutMs, READ_METHODS.has(method) ? defaultTimeoutMs : defaultWriteTimeoutMs);
    return new Promise((resolve) => {
      const headers = { accept: "application/json", "x-request-id": requestId };
      if (body) {
        if (body.length) headers["content-type"] = "application/json";
        headers["content-length"] = String(body.length);
      }
      let settled = false;
      let reason = "";
      let upstream = null;
      const flight = { stop: () => abort("aborted") };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inflight.delete(flight);
        opts.signal?.removeEventListener?.("abort", onAbort);
        resolve(result);
      };
      function abort(why) {
        reason = reason || why;
        upstream?.destroy();
        if (!upstream) finish(failed("aborted", "The request was aborted."));
      }
      const onAbort = () => abort("aborted");
      const timer = setTimeout(() => abort("timeout"), timeoutMs);
      timer.unref?.();
      inflight.add(flight);
      if (opts.signal?.aborted) {
        abort("aborted");
        return;
      }
      opts.signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        upstream = httpRequest({ host: UPSTREAM_HOST, port, method, path: upstreamPath, headers, agent: false });
      } catch {
        finish(failed("invalid_request", "The request cannot be sent to the manager."));
        return;
      }
      upstream.on("error", (error) => {
        if (reason === "timeout") finish(failed("manager_timeout", `The ${id} manager did not answer within ${timeoutMs} ms.`));
        else if (reason === "too_large") finish(failed("response_too_large", "The manager response is too large."));
        else if (reason) finish(failed("aborted", "The request was aborted."));
        else finish(failed("manager_unreachable", `The ${id} manager is not running or not answering.`, { error: String(error?.code || error?.message || "") }));
      });
      upstream.on("response", (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > responseLimit) {
            reason = "too_large";
            upstream.destroy();
            finish(failed("response_too_large", "The manager response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks, total).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = null;
          }
          const status = response.statusCode || 0;
          const ok = status >= 200 && status < 300;
          finish({
            ok,
            status,
            data,
            requestId,
            managerId: id,
            ...(ok ? {} : { code: failureCode(status, data), message: failureMessage(data) }),
          });
        });
        response.on("close", () => {
          if (!response.complete) finish(failed(reason === "timeout" ? "manager_timeout" : "manager_unreachable", `The ${id} manager closed the connection mid-response.`));
        });
      });
      // Backstop: whatever ended the socket, the promise always settles.
      upstream.on("close", () => {
        if (!settled) finish(failed(reason === "timeout" ? "manager_timeout" : reason ? "aborted" : "manager_unreachable", `The ${id} manager closed the connection.`));
      });
      upstream.end(body && body.length ? body : undefined);
    });
  }

  function close() {
    closed = true;
    for (const flight of [...inflight]) flight.stop();
  }

  return {
    request,
    get: (managerId, target, requestOptions = {}) => request(managerId, target, { ...requestOptions, method: "GET" }),
    post: (managerId, target, body, requestOptions = {}) => request(managerId, target, { ...requestOptions, method: "POST", body }),
    close,
  };
}

// Route module (07 §2.7). The proxy reads ctx.relay at call time, because the
// relay (ENT-EV3) mounts after it; ctx.managerClient is the shared client.
function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || !auth.viewerRegistry) throw new Error("mgmt-proxy: ctx.auth is missing");
  const logger = ctx.logger || console;
  const managers = Array.isArray(ctx.managers) ? ctx.managers : [];
  registerViewerRoutes(auth.viewerRegistry, loggerWarn(logger));
  const proxy = createMgmtProxy({ managers, auth, relay: () => ctx.relay, logger, now: ctx.now });
  const client = createManagerClient({ managers });
  if (!ctx.managerClient) ctx.managerClient = client;
  return {
    handle: proxy.handle,
    close() {
      proxy.close();
      client.close();
    },
  };
}

module.exports = {
  FORWARDED_REQUEST_HEADERS,
  REQUEST_ID_RE,
  VIEWER_READS,
  createManagerClient,
  createMgmtProxy,
  feature: "mgmtProxy",
  mount,
  name: "mgmt",
  newRequestId,
  redactManagerReadForViewer,
};
