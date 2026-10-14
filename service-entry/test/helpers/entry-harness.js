"use strict";

// Loads service-entry/server.js for an in-process test. Every upstream port
// the entry knows points at a port nothing listens on, so no request can
// reach a real local service, and the billing ledger lives in a temp dir.
// The entry reads its ports when it is loaded, which is why loadEntry()
// sets them before require("../../server").
//
// serveEntry() answers through entry.handleRequest() and lets a request
// claim a peer address with the x-test-peer header (removed before the
// entry sees the request), so LAN callers can be exercised over real HTTP.
// Every request uses its own connection, so a claimed address never leaks
// into the next request.

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const CLEARED_ENV = [
  "SERVICE_ENTRY_HOST",
  "SERVICE_ENTRY_REQUIRE_API_KEY",
  "SERVICE_ENTRY_ALLOW_LAN_ADMIN",
  "SERVICE_ENTRY_ALLOWED_ORIGINS",
  "SERVICE_ENTRY_ALLOWED_HOSTS",
  "SERVICE_ENTRY_PUBLIC_BASE_URL",
  "SERVICE_ENTRY_TRUSTED_PROXIES",
  "SERVICE_ENTRY_RATE_LIMIT_RPM",
];
const UPSTREAM_PORT_ENV = ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"];
const PEER_HEADER = "x-test-peer";

let loaded = null;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function loadEntry() {
  if (loaded) return loaded;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-access-"));
  for (const name of CLEARED_ENV) delete process.env[name];
  for (const name of UPSTREAM_PORT_ENV) process.env[name] = String(await unusedPort());
  process.env.SERVICE_ENTRY_STATUS_CACHE_MS = "600000";
  process.env.SERVICE_ENTRY_MODEL_CACHE_MS = "600000";
  process.env.PLATFORM_MCP_ENV_FILE = path.join(tempDir, "platform-mcp.env");
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  const entry = require("../../server");
  entry.setEntryGatewayAccessSink(async () => {});
  loaded = { entry, tempDir };
  process.once("exit", () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // A ledger file still open on Windows; the OS temp cleanup takes it.
    }
  });
  return loaded;
}

function quietLogger() {
  const lines = [];
  return { lines, log: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
}

async function serveEntry(t, entry, routes = null) {
  const server = http.createServer((req, res) => {
    const peer = req.headers[PEER_HEADER];
    if (peer) {
      delete req.headers[PEER_HEADER];
      Object.defineProperty(req.socket, "remoteAddress", { value: String(peer), configurable: true });
    }
    entry.handleRequest(req, res, routes);
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return port;
}

// `owner` (an ownerSession()) sends the owner's cookie and CSRF token.
function request(port, pathname, { method = "GET", headers = {}, body, peer, owner } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const outgoing = {
      host: "127.0.0.1:5176",
      ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      ...(owner ? owner.headers(method) : {}),
      ...headers,
      ...(peer ? { [PEER_HEADER]: peer } : {}),
    };
    const call = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: outgoing, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    call.on("error", reject);
    call.end(payload || undefined);
  });
}

// A paired owner session for tests that act as the console owner (05 §5.2):
// a pair code minted with a system:cli signature, redeemed like the console
// does. Loopback without a session is only a viewer since PUB-5. One session
// per entry module is enough: sessions live in the entry's access store.
// headers(method) carries the cookie, plus x-csrf-token for a non-GET.
const ownerSessions = new WeakMap();

async function ownerSession(entry, port) {
  if (ownerSessions.has(entry)) return ownerSessions.get(entry);
  const internalAuth = require("../../../manager-core/internal-auth");
  const body = JSON.stringify({});
  const minted = await request(port, "/api/session/pair-codes", {
    method: "POST",
    body,
    headers: internalAuth.buildMachineHeaders(entry.security.getTrustToken(), {
      method: "POST", pathWithQuery: "/api/session/pair-codes", principal: "system:cli", body, now: Date.now(),
    }),
  });
  if (minted.status !== 200) throw new Error(`minting a pair code failed: HTTP ${minted.status} ${minted.text}`);
  const paired = await request(port, "/api/session/pair", { method: "POST", body: { code: minted.json.code } });
  if (paired.status !== 200) throw new Error(`pairing failed: HTTP ${paired.status} ${paired.text}`);
  const setCookie = [].concat(paired.headers["set-cookie"] || []).find((line) => line.startsWith("lai_admin="));
  const cookie = String(setCookie || "").split(";")[0];
  const session = {
    cookie,
    csrfToken: paired.json.csrfToken,
    headers(method = "GET") {
      return String(method).toUpperCase() === "GET" || String(method).toUpperCase() === "HEAD"
        ? { cookie }
        : { cookie, "x-csrf-token": paired.json.csrfToken };
    },
  };
  ownerSessions.set(entry, session);
  return session;
}

// A route module that records who reached it. It answers every path in
// `claims` (exact, or a prefix ending in "/") with what the request-auth
// seam says about the caller and the body it read.
function spyModule(claims) {
  const seen = [];
  return {
    seen,
    name: "spy",
    mount(ctx) {
      return {
        async handle(req, res, url) {
          const claimed = claims.some((claim) => (claim.endsWith("/") ? url.pathname.startsWith(claim) : url.pathname === claim));
          if (!claimed) return false;
          let body = null;
          if (!["GET", "HEAD"].includes(req.method)) body = await ctx.readJsonObjectBody(req, 64 * 1024);
          const who = ctx.auth.principal(req);
          seen.push({ method: req.method, path: url.pathname, role: who.role, principal: who.principal, body });
          ctx.sendJson(res, { ok: true, spy: true, role: who.role, principal: who.principal, body });
          return true;
        },
      };
    },
  };
}

module.exports = {
  listen,
  loadEntry,
  ownerSession,
  quietLogger,
  request,
  serveEntry,
  spyModule,
  unusedPort,
};
