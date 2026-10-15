"use strict";

// The supervisor control API (06 §5.14): HTTP/1.1 + JSON over a Windows named
// pipe (a Unix socket under os.tmpdir() on other test hosts), so no browser
// can reach it and no TCP port is added. Every request needs
// `Authorization: Bearer <token>`; the token is 32 random bytes, regenerated
// at each supervisor start and kept in the secret store (namespace
// platform-control, name token), never in a plain file. A request carrying
// Origin or Sec-Fetch-Site is refused with 403 before the token is looked at.
// Bodies are limited to 64 KiB.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const TOKEN_NAMESPACE = "platform-control";
const TOKEN_NAME = "token";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

function controlError(status, code, message, extra = {}) {
  return Object.assign(new Error(message || code), { status, code, extra });
}

/** \\.\pipe\local-ai-platform-<sha256(lower(AI_ROOT)).slice(0,12)>, or <tmpdir>/….sock off Windows. */
function controlEndpoint(aiRoot, { platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  const root = path.resolve(String(aiRoot || path.join(__dirname, "../..")));
  const hash = crypto.createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 12);
  return platform === "win32" ? `\\\\.\\pipe\\local-ai-platform-${hash}` : path.join(tmpdir, `local-ai-platform-${hash}.sock`);
}

function createControlToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function defaultTokenStore(aiRoot) {
  // Lazy: a CLI that only reads logs never loads the secret store.
  const { createSecretStore } = require("../secret-store");
  return createSecretStore({ aiRoot, namespace: TOKEN_NAMESPACE });
}

/** { read() -> token | "", write(token) -> Promise } over the secret store. */
function createControlTokenStore({ aiRoot, store } = {}) {
  let backing = store || null;
  const open = () => (backing ||= defaultTokenStore(aiRoot));
  return {
    read() { return String(open().get(TOKEN_NAME) || ""); },
    async write(token) { await open().set(TOKEN_NAME, token); },
  };
}

function tokenMatches(header, token) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ""));
  if (!match || !token) return false;
  const left = crypto.createHash("sha256").update(match[1]).digest();
  const right = crypto.createHash("sha256").update(String(token)).digest();
  return crypto.timingSafeEqual(left, right);
}

function sendJson(res, status, body) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function errorBody(code, message, extra = {}) {
  return { ok: false, error: { code, message: message || code, ...(extra.hint ? { hint: extra.hint } : {}) }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "hint")) };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(controlError(413, "body_too_large", `Request bodies are limited to ${limit} bytes.`));
      return;
    }
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        chunks.length = 0;
        req.resume();
        reject(controlError(413, "body_too_large", `Request bodies are limited to ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Routes (§5.14 table) over the supervisor's API

function requireMethod(supervisor, name) {
  if (typeof supervisor?.[name] !== "function") throw controlError(501, "not_implemented", "This control operation is not available in this supervisor.");
  return supervisor[name].bind(supervisor);
}

function integer(value, fallback, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : fallback;
}

const ROUTES = [
  ["GET", /^\/v1\/status$/, (s) => requireMethod(s, "status")().then((status) => ({ json: status }))],
  ["GET", /^\/v1\/components$/, async (s) => ({ json: { components: await requireMethod(s, "listComponents")() } })],
  ["GET", /^\/v1\/components\/([a-z][a-z0-9-]{1,31})$/, async (s, ctx, [id]) => ({ json: await requireMethod(s, "describeComponent")(id) })],
  ["POST", /^\/v1\/components\/([a-z][a-z0-9-]{1,31})\/start$/, async (s, ctx, [id]) => {
    const result = await requireMethod(s, "startComponent")(id, { wait: ctx.body.wait === true });
    return { status: ctx.body.wait === true ? 200 : 202, json: { ok: true, ...result } };
  }],
  ["POST", /^\/v1\/components\/([a-z][a-z0-9-]{1,31})\/stop$/, async (s, ctx, [id]) => {
    const result = await requireMethod(s, "stopComponent")(id, { wait: ctx.body.wait === true, models: ctx.body.models === true, confirm: ctx.body.confirm === true });
    return { status: ctx.body.wait === true ? 200 : 202, json: { ok: true, ...result } };
  }],
  ["POST", /^\/v1\/components\/([a-z][a-z0-9-]{1,31})\/restart$/, async (s, ctx, [id]) => {
    const when = ctx.body.when === "idle" ? "idle" : "now";
    const result = await requireMethod(s, "restart")([id], { when, force: ctx.body.force === true });
    return { status: 202, json: { ok: true, ...result } };
  }],
  ["POST", /^\/v1\/profiles\/([a-z]+)\/start$/, async (s, ctx, [profile]) => {
    const result = await requireMethod(s, "startProfile")(profile, { runtimeOverrides: ctx.body.runtimeOverrides, restoreModels: ctx.body.restoreModels });
    return { status: 202, json: { ok: true, ...result } };
  }],
  ["POST", /^\/v1\/stop$/, async (s, ctx) => {
    const result = await requireMethod(s, "stopScope")({ scope: ctx.body.scope || "all", models: ctx.body.models === true, confirm: ctx.body.confirm === true, exitSupervisor: ctx.body.exitSupervisor });
    return { status: 202, json: { ok: true, ...result } };
  }],
  ["GET", /^\/v1\/components\/([a-z][a-z0-9-]{1,31})\/logs$/, async (s, ctx, [id]) => ({
    json: await requireMethod(s, "componentLogs")(id, {
      stream: ["out", "err", "all"].includes(ctx.query.get("stream")) ? ctx.query.get("stream") : "all",
      tail: integer(ctx.query.get("tail"), 200, 5000),
      legacy: ctx.query.get("legacy") === "1",
    }),
  })],
  ["GET", /^\/v1\/components\/([a-z][a-z0-9-]{1,31})\/logs\/follow$/, async (s, ctx, [id]) => {
    const follow = requireMethod(s, "followLogs");
    const stream = ["out", "err", "all"].includes(ctx.query.get("stream")) ? ctx.query.get("stream") : "all";
    return { sse: (send) => follow(id, { stream }, (line) => send("log", line)) };
  }],
  ["GET", /^\/v1\/idle$/, async (s) => ({ json: await requireMethod(s, "idle")() })],
  ["GET", /^\/v1\/pending-restarts$/, async (s) => ({ json: { pendingRestarts: await requireMethod(s, "pendingRestarts")() } })],
  ["DELETE", /^\/v1\/pending-restarts\/([a-z][a-z0-9-]{1,31})$/, async (s, ctx, [id]) => ({ json: await requireMethod(s, "cancelPendingRestart")(id) })],
  ["POST", /^\/v1\/restore-models$/, async (s, ctx) => ({ status: 202, json: { ok: true, ...(await requireMethod(s, "restoreModels")(ctx.body)) } })],
  ["POST", /^\/v1\/doctor\/fix$/, async (s, ctx) => ({ status: 202, json: { ok: true, ...(await requireMethod(s, "runFix")(ctx.body)) } })],
  ["POST", /^\/v1\/setup\/([a-z][a-z0-9-]{0,40})$/, async (s, ctx, [step]) => ({ status: 202, json: { ok: true, ...(await requireMethod(s, "runSetupStep")(step, ctx.body)) } })],
  ["GET", /^\/v1\/operations$/, async (s) => ({ json: { operations: await requireMethod(s, "operations")() } })],
  ["GET", /^\/v1\/operations\/(op_[a-z0-9]{1,40})$/, async (s, ctx, [opId]) => ({ json: await requireMethod(s, "operation")(opId) })],
  ["GET", /^\/v1\/events$/, async (s) => {
    const subscribe = requireMethod(s, "subscribe");
    return { sse: (send) => subscribe((event) => send(event.type, event)) };
  }],
  ["POST", /^\/v1\/reexec$/, async (s) => ({ status: 202, json: { ok: true, ...(await requireMethod(s, "reexec")()) } })],
  ["POST", /^\/v1\/shutdown$/, async (s, ctx) => ({ status: 202, json: { ok: true, ...(await requireMethod(s, "shutdown")({ leaveChildren: ctx.body.leaveChildren !== false })) } })],
];

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const [verb, pattern, handler] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (verb === method) return { handler, params: match.slice(1) };
  }
  return { handler: null, pathMatched };
}

function openSse(req, res, attach) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  let counter = 0;
  const send = (type, data) => {
    if (res.writableEnded) return;
    counter += 1;
    res.write(`id: ${counter}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let cleanup = null;
  try { cleanup = attach(send); } catch (error) {
    send("error", { code: error.code || "internal_error" });
    res.end();
    return;
  }
  const close = () => {
    const handle = cleanup;
    cleanup = null;
    if (typeof handle === "function") handle();
    else if (handle && typeof handle.close === "function") handle.close();
  };
  req.on("close", close);
  res.on("close", close);
}

/**
 * startControlServer({ endpoint, token, supervisor, maxBodyBytes, platform, log })
 * -> Promise<{ endpoint, server, close() }>. Rejects with code EADDRINUSE when
 * another supervisor owns the endpoint (single instance, §5.1).
 */
async function startControlServer(options = {}) {
  const endpoint = options.endpoint || controlEndpoint(options.aiRoot, { platform: options.platform });
  const limit = Math.max(1, Number(options.maxBodyBytes) || MAX_BODY_BYTES);
  const getToken = typeof options.token === "function" ? options.token : () => options.token;
  const supervisor = options.supervisor;
  const log = typeof options.log === "function" ? options.log : () => {};
  if (!getToken()) throw new Error("The control server needs a token.");

  const server = http.createServer(async (req, res) => {
    try {
      // A browser always sends one of these; the pipe is for local tools only.
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
        req.resume();
        sendJson(res, 403, errorBody("origin_forbidden", "Browser requests are not accepted on the control channel."));
        return;
      }
      if (!tokenMatches(req.headers.authorization, getToken())) {
        req.resume();
        sendJson(res, 401, errorBody("unauthorized", "A valid control token is required."));
        return;
      }
      const url = new URL(req.url || "/", "http://control.local");
      const method = String(req.method || "GET").toUpperCase();
      const { handler, params, pathMatched } = matchRoute(method, url.pathname);
      if (!handler) {
        req.resume();
        sendJson(res, pathMatched ? 405 : 404, errorBody(pathMatched ? "method_not_allowed" : "not_found", pathMatched ? "Method not allowed." : "Unknown control route."));
        return;
      }
      const raw = await readBody(req, limit);
      let body = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString("utf8")); } catch { throw controlError(400, "invalid_json", "The request body is not valid JSON."); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw controlError(400, "invalid_json", "The request body must be a JSON object.");
      }
      const requestId = String(req.headers["x-request-id"] || "");
      const result = await handler(supervisor, { body, query: url.searchParams, requestId: REQUEST_ID_PATTERN.test(requestId) ? requestId : null }, params);
      if (result?.sse) {
        openSse(req, res, result.sse);
        return;
      }
      sendJson(res, result?.status || 200, result?.json ?? { ok: true });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500 && status !== 501 && status !== 503) log({ code: "control_error", message: String(error?.message || error) });
      sendJson(res, status, errorBody(error?.code || "internal_error", status === 500 ? "Internal supervisor error." : error.message, error?.extra || {}));
    }
  });
  server.keepAliveTimeout = 1000;

  const listen = () => new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  try {
    await listen();
  } catch (error) {
    const platform = options.platform || process.platform;
    if (error.code !== "EADDRINUSE" || platform === "win32" || !(await staleSocket(endpoint))) throw error;
    fs.rmSync(endpoint, { force: true });
    await listen();
  }
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    endpoint,
    server,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

// A Unix socket file left by a dead process refuses connections.
function staleSocket(endpoint) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  });
}

// ---------------------------------------------------------------------------
// Client

function unavailable(error) {
  return controlError(503, "supervisor_unavailable", "The platform supervisor is not running.", { cause: error?.code || null });
}

/**
 * createControlClient({ aiRoot, endpoint, token | readToken, timeoutMs, tokenStore })
 * -> { endpoint, request(method, path, { body, timeoutMs, requestId }) -> {status, json},
 *      events(onEvent, { path, onError }) -> { close() }, available() }
 * The client sends no headers of its caller: only the token, the JSON type
 * and an optional x-request-id. A 401 re-reads the token once (the
 * supervisor restarted).
 */
function createControlClient(options = {}) {
  const endpoint = options.endpoint || controlEndpoint(options.aiRoot, { platform: options.platform });
  const defaultTimeout = Math.max(100, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const store = options.readToken ? null : options.token ? null : createControlTokenStore({ aiRoot: options.aiRoot, store: options.tokenStore });
  const readToken = typeof options.readToken === "function" ? options.readToken : options.token ? () => options.token : () => store.read();
  let token = null;

  function currentToken(reload) {
    if (token === null || reload) {
      try { token = String(readToken() || ""); } catch { token = ""; }
    }
    return token;
  }

  function send(method, pathWithQuery, payload, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: endpoint, path: pathWithQuery, method, headers, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch {}
          resolve({ status: res.statusCode, json });
        });
        res.on("error", reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("Control request timed out."), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      req.end(payload);
    });
  }

  function headersFor(value, payload, requestId) {
    return {
      authorization: `Bearer ${value}`,
      accept: "application/json",
      ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      ...(requestId && REQUEST_ID_PATTERN.test(String(requestId)) ? { "x-request-id": String(requestId) } : {}),
    };
  }

  async function request(method, pathWithQuery, requestOptions = {}) {
    const verb = String(method || "GET").toUpperCase();
    const target = String(pathWithQuery || "");
    if (!target.startsWith("/v1/")) throw controlError(400, "invalid_control_path", "Control paths start with /v1/.");
    const payload = requestOptions.body === undefined || verb === "GET" ? undefined : JSON.stringify(requestOptions.body);
    const timeoutMs = Math.max(100, Number(requestOptions.timeoutMs) || defaultTimeout);
    let value = currentToken(false);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!value) throw unavailable({ code: "token_unavailable" });
      let result;
      try {
        result = await send(verb, target, payload, headersFor(value, payload, requestOptions.requestId), timeoutMs);
      } catch (error) {
        throw unavailable(error);
      }
      if (result.status === 401 && attempt === 1) {
        value = currentToken(true);
        continue;
      }
      return result;
    }
    throw unavailable(null);
  }

  // SSE over the pipe; one connection, no reconnect (callers own the policy).
  function events(onEvent, eventOptions = {}) {
    const target = eventOptions.path || "/v1/events";
    let closed = false;
    let req = null;
    const report = (error) => { if (!closed && typeof eventOptions.onError === "function") eventOptions.onError(error); };
    const value = currentToken(false);
    if (!value) {
      queueMicrotask(() => report(unavailable({ code: "token_unavailable" })));
      return { close() { closed = true; } };
    }
    req = http.request({ socketPath: endpoint, path: target, method: "GET", headers: { authorization: `Bearer ${value}`, accept: "text/event-stream" }, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        report(controlError(res.statusCode, res.statusCode === 401 ? "unauthorized" : "control_stream_refused", `Control stream answered ${res.statusCode}.`));
        return;
      }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let type = "message";
          const data = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (!data.length || closed) continue;
          let parsed = data.join("\n");
          try { parsed = JSON.parse(parsed); } catch {}
          try { onEvent({ type, data: parsed }); } catch {}
        }
      });
      res.on("end", () => report(controlError(503, "control_stream_closed", "The control stream ended.")));
    });
    req.on("error", (error) => report(unavailable(error)));
    req.end();
    return {
      close() {
        closed = true;
        try { req?.destroy(); } catch {}
      },
    };
  }

  async function available() {
    try {
      const result = await request("GET", "/v1/status", { timeoutMs: Math.min(defaultTimeout, 2000) });
      return result.status === 200;
    } catch {
      return false;
    }
  }

  return { endpoint, request, events, available };
}

module.exports = {
  MAX_BODY_BYTES,
  TOKEN_NAMESPACE,
  TOKEN_NAME,
  controlEndpoint,
  createControlToken,
  createControlTokenStore,
  startControlServer,
  createControlClient,
  controlError,
};
