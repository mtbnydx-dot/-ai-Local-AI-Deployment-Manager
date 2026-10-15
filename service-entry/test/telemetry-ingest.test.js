"use strict";

// TEL-6 (docs/overhaul/04-telemetry.md §6.7, §16.4): the managers' signed
// ingest into the entry. A real loopback HTTP server fronts the runtime's
// handleInternal over a real in-process store in a temp directory; the
// managers' side is the real ingest client over the real internal client.
// Nothing here touches the live services, ports or data.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const sqlite = require("node:sqlite");

// The default trust reader of gateway-trust.js is built lazily from these.
const TOKEN = "fake-trust-token-for-telemetry-ingest-tests";
process.env.AI_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tel6-root-"));
process.env.SERVICE_GATEWAY_TRUST_TOKEN = TOKEN;

const core = require("../../manager-core");
const trust = require("../../manager-core/gateway-trust");
const internalAuth = require("../../manager-core/internal-auth");
const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const { createTelemetryIngestClient, directRequestRow } = require("../../manager-core/telemetry/ingest-client");
const { verifyChain } = require("../../manager-core/telemetry/audit-access-log");
const runtimeModule = require("../lib/telemetry-runtime");

const MANAGERS = [
  { id: "vllm", billingId: "vllm-manager" },
  { id: "llama", billingId: "llama-manager" },
];

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tel6-${label}-`));
}

async function startEntry(options = {}) {
  const dir = tempDir("entry");
  const file = path.join(dir, "telemetry.sqlite");
  const runtime = runtimeModule.createTelemetryRuntime({
    aiRoot: dir,
    dataDir: dir,
    managers: MANAGERS,
    env: {},
    docker: false,
    logger: null,
    config: {},
    openStore: () => openTelemetryStore({ file, inProcess: true, logger: null }),
    getTrustToken: () => TOKEN,
    ...options,
  });
  await runtime.start();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    runtime.handleInternal(req, res, url).then((handled) => {
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end("{}");
      }
    }, () => {
      res.statusCode = 500;
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    file,
    runtime,
    baseUrl,
    store: runtime.store,
    query(sql, ...args) {
      const db = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        return db.prepare(sql).all(...args);
      } finally {
        db.close();
      }
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await runtime.stop({ flushMs: 0 });
    },
  };
}

function managerClient(entry, managerId = "vllm-manager", extra = {}) {
  const gate = { down: false };
  const internalClient = internalAuth.createInternalClient({
    managerId,
    baseUrl: entry.baseUrl,
    readKey: () => TOKEN,
    fetchFn: (...args) => (gate.down ? Promise.reject(new Error("connect ECONNREFUSED")) : fetch(...args)),
    ...extra,
  });
  return { gate, internalClient };
}

function ingestClient(entry, options = {}) {
  const { gate, internalClient } = managerClient(entry, options.managerId, options.clientOptions);
  const spoolFile = options.spoolFile || path.join(tempDir("spool"), "logs", "telemetry-spool.jsonl");
  const client = createTelemetryIngestClient({
    managerId: options.managerId || "vllm-manager",
    internalClient,
    spoolFile,
    maxSpoolBytes: options.maxSpoolBytes,
    retryMs: 3_600_000,
  });
  return { gate, client, spoolFile };
}

function rawPost(entry, pathname, bodyText, headers) {
  return fetch(`${entry.baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: bodyText })
    .then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
}

function signed(pathname, bodyText, managerId = "vllm-manager", token = TOKEN) {
  return internalAuth.buildInternalRequestHeaders(token, "POST", pathname, managerId, bodyText);
}

let counter = 0;
function accessEntry(extra = {}) {
  counter += 1;
  return {
    at: new Date(Date.UTC(2026, 9, 14, 10, 0, counter)).toISOString(),
    requestId: `mgr_${String(counter).padStart(20, "a")}`,
    clientRequestId: "",
    viaEntry: false,
    keyId: "legacy-client",
    remoteAddress: "192.168.1.20",
    method: "POST",
    path: "/v1/chat/completions",
    kind: "openai",
    status: 200,
    terminalState: "completed",
    model: "demo-model",
    resolvedModel: "demo-model",
    stream: true,
    authSource: "bearer",
    userAgent: "curl/8.0",
    durationMs: 1200,
    inputTokens: 10,
    outputTokens: 20,
    errorClass: "none",
    firstByteMs: 80,
    ...extra,
  };
}

function auditEntry(action, at, extra = {}) {
  return { at, source: "vllm-manager", actor: "legacy-local", clientIp: "127.0.0.1", userAgent: "unit", action, outcome: "ok", ...extra };
}

test("a signed direct row is stored with the signed manager's id, and replaying it is idempotent", async () => {
  const entry = await startEntry();
  try {
    const { client } = ingestClient(entry);
    const row = directRequestRow(accessEntry(), { managerId: "llama" });
    await client.report("requests", [row]);
    await client.report("requests", [row]);
    const rows = entry.query("SELECT request_id, manager_request_id, ingress, manager_id, protocol, op, key_id, status, terminal_state FROM requests");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ingress, "direct");
    assert.equal(rows[0].request_id, row.requestId);
    assert.ok(rows[0].request_id.startsWith("mgr_"));
    assert.equal(rows[0].manager_request_id, row.managerRequestId);
    // The body claimed "llama"; the signature says vllm-manager.
    assert.equal(rows[0].manager_id, "vllm");
    assert.equal(rows[0].protocol, "openai");
    assert.equal(rows[0].op, "chat");
    assert.equal(client.stats().sent, 2);
    assert.equal(client.stats().duplicates, 1);
    assert.equal(client.stats().spooled, 0);
  } finally {
    await entry.close();
  }
});

test("a wrong signature, path, manager or body gives 401; unrelated prefixes are not handled", async () => {
  const entry = await startEntry();
  try {
    const body = JSON.stringify({ rows: [directRequestRow(accessEntry(), {})] });
    const target = "/internal/telemetry/requests";
    assert.equal((await rawPost(entry, target, body, signed(target, body))).status, 200);

    const wrongToken = await rawPost(entry, target, body, signed(target, body, "vllm-manager", "another-fake-token"));
    assert.equal(wrongToken.status, 401);
    assert.equal(wrongToken.json.error.code, "telemetry_unauthorized");

    assert.equal((await rawPost(entry, target, body, {})).status, 401, "unsigned");
    assert.equal((await rawPost(entry, target, body, signed(target, body, "intruder-manager"))).status, 401, "unknown manager");
    const forgedPrincipal = { ...signed(target, body), "x-ai-billing-manager": "llama-manager" };
    assert.equal((await rawPost(entry, target, body, forgedPrincipal)).status, 401, "principal not covered by the signature");
    // Signed for one telemetry path, sent to another.
    assert.equal((await rawPost(entry, "/internal/telemetry/events", body, signed(target, body))).status, 401);
    // Signed for a billing path, sent to the telemetry path.
    assert.equal((await rawPost(entry, target, body, signed("/internal/billing/usage", body))).status, 401);
    // Body changed after signing.
    assert.equal((await rawPost(entry, target, `${body} `, signed(target, body))).status, 401);

    // Not a telemetry path: handleInternal leaves it to the other modules.
    const res = { writeHead() { throw new Error("must not answer"); } };
    const handled = await entry.runtime.handleInternal({ method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: {} }, res, new URL("http://x/internal/billing/usage"));
    assert.equal(handled, false);
    assert.equal(await entry.runtime.handleInternal({ method: "POST", headers: {} }, res, new URL("http://x/api/telemetry/live")), false);

    const unknown = await rawPost(entry, "/internal/telemetry/other", body, signed("/internal/telemetry/other", body));
    assert.equal(unknown.status, 404);
  } finally {
    await entry.close();
  }
});

test("a non-loopback socket is rejected before its body is read", async () => {
  const entry = await startEntry();
  try {
    const target = "/internal/telemetry/requests";
    const body = JSON.stringify({ rows: [] });
    let read = false;
    const req = {
      method: "POST",
      url: target,
      headers: Object.fromEntries(Object.entries(signed(target, body)).map(([k, v]) => [k.toLowerCase(), v])),
      socket: { remoteAddress: "203.0.113.7" },
      resume() { read = true; },
      [Symbol.asyncIterator]() {
        throw new Error("the body must not be read");
      },
    };
    const sent = {};
    const res = {
      writeHead(status) { sent.status = status; },
      end(text) { sent.body = JSON.parse(text); },
    };
    assert.equal(await entry.runtime.handleInternal(req, res, new URL(`http://x${target}`)), true);
    assert.equal(sent.status, 401);
    assert.equal(sent.body.error.code, "telemetry_unauthorized");
    assert.equal(read, true);
  } finally {
    await entry.close();
  }
});

test("rows are validated: other ingress, a req_ id, too many rows and a huge body are refused", async () => {
  const entry = await startEntry();
  try {
    const target = "/internal/telemetry/requests";
    const good = directRequestRow(accessEntry(), {});
    const viaEntry = { ...directRequestRow(accessEntry(), {}), ingress: "entry" };
    const wrongId = { ...directRequestRow(accessEntry(), {}), requestId: "req_abcdefghijklmnopqrst" };
    const mixed = JSON.stringify({ rows: [good, viaEntry, wrongId, "junk"] });
    const answer = await rawPost(entry, target, mixed, signed(target, mixed));
    assert.equal(answer.status, 400);
    assert.equal(answer.json.error.code, "invalid_rows");
    assert.equal(answer.json.accepted, 1, "the valid row is still accepted");
    assert.deepEqual(answer.json.errors.map((item) => item.index), [1, 2, 3]);
    assert.equal(entry.query("SELECT COUNT(*) AS n FROM requests")[0].n, 1);

    const many = JSON.stringify({ rows: Array.from({ length: 201 }, () => good) });
    const tooMany = await rawPost(entry, target, many, signed(target, many));
    assert.equal(tooMany.status, 413);
    assert.equal(tooMany.json.error.code, "payload_too_large");

    const huge = JSON.stringify({ rows: [{ ...good, pad: "x".repeat(1024 * 1024) }] });
    const tooBig = await rawPost(entry, target, huge, signed(target, huge));
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.error.code, "payload_too_large");

    const notRows = JSON.stringify({ nope: true });
    assert.equal((await rawPost(entry, target, notRows, signed(target, notRows))).status, 400);
  } finally {
    await entry.close();
  }
});

test("events are stored under the signed manager and deduplicated", async () => {
  const entry = await startEntry();
  try {
    const { client } = ingestClient(entry);
    const event = { at: Date.now(), type: "config.keys", severity: "info", title: "Service keys changed", data: { changed: ["clients"] }, dedupeKey: "config.keys:1", source: "forged" };
    await client.report("events", [event]);
    await client.report("events", [event]);
    const rows = entry.query("SELECT type, source, manager_id, title FROM events WHERE type = 'config.keys'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "vllm");
    assert.equal(rows[0].manager_id, "vllm");
    assert.equal(client.stats().duplicates, 1);
  } finally {
    await entry.close();
  }
});

test("spooled audit rows replay in arrival order with their original time, hash-chained", async () => {
  const entry = await startEntry();
  try {
    const { gate, client, spoolFile } = ingestClient(entry);
    const t0 = Date.now() - 60_000;
    gate.down = true;
    await client.report("audit-access", [auditEntry("login_ok", t0)]);
    await client.report("audit-access", [auditEntry("list_exports", t0 + 1000)]);
    await client.report("audit-access", [auditEntry("view_markdown", t0 + 2000, { target: "audit_1" })]);
    assert.equal(fs.readFileSync(spoolFile, "utf8").trim().split("\n").length, 3);
    assert.equal(entry.query("SELECT COUNT(*) AS n FROM audit_access_log")[0].n, 0);

    gate.down = false;
    // New rows queue behind the spooled ones.
    await client.report("audit-access", [auditEntry("logout", t0 + 3000)]);
    assert.equal(fs.existsSync(spoolFile), false, "the spool is empty after a replay");
    const rows = entry.query("SELECT seq, at, source, actor, session, client_ip, user_agent, action, target, outcome, detail, prev_hash, hash FROM audit_access_log ORDER BY seq");
    assert.deepEqual(rows.map((row) => row.action), ["login_ok", "list_exports", "view_markdown", "logout"]);
    assert.deepEqual(rows.map((row) => row.at), [t0, t0 + 1000, t0 + 2000, t0 + 3000]);
    assert.equal(rows[0].source, "vllm-manager");
    assert.equal(rows[0].actor, "legacy-local");
    assert.equal(rows[2].target, "audit_1");
    for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
    const verdict = await entry.store.call("auditAccessVerify", {});
    assert.equal(verdict.ok, true);
    assert.equal(verdict.rows, 4);
    assert.equal(verifyChain(rows).ok, true);
    assert.equal(client.stats().replayed, 4, "the row that arrived last queued behind the spool");
  } finally {
    await entry.close();
  }
});

test("a 401, a 5xx and a replay that fails midway keep order and lose nothing", async () => {
  const entry = await startEntry();
  try {
    // A manager whose key the entry no longer accepts: 401 spools.
    const stale = ingestClient(entry, { clientOptions: { readKey: () => "rotated-away-fake-token" } });
    await stale.client.report("requests", [directRequestRow(accessEntry(), {})]);
    assert.equal(stale.client.stats().spooled, 1);
    assert.equal(entry.query("SELECT COUNT(*) AS n FROM requests")[0].n, 0);

    // The entry answers 503 while its store is closed; the spool holds, then drains.
    const { client, gate } = ingestClient(entry);
    const rows = [accessEntry(), accessEntry(), accessEntry()].map((item) => directRequestRow(item, {}));
    gate.down = true;
    await client.report("requests", rows);
    assert.equal(client.stats().spooled, 3);
    // A failed flush leaves the spool untouched.
    assert.equal(await client.flush(), false);
    assert.equal(client.stats().spooled, 3);
    gate.down = false;
    assert.equal(await client.flush(), true);
    const stored = entry.query("SELECT request_id FROM requests ORDER BY id");
    assert.deepEqual(stored.map((row) => row.request_id), rows.map((row) => row.requestId));
  } finally {
    await entry.close();
  }
});

test("replay sends batches of at most 200 rows, oldest first", async () => {
  const entry = await startEntry();
  try {
    const seen = [];
    const { gate, client } = ingestClient(entry, {
      clientOptions: {
        fetchFn: (url, init) => {
          if (gate.down) return Promise.reject(new Error("connect ECONNREFUSED"));
          seen.push(JSON.parse(init.body).rows.length);
          return fetch(url, init);
        },
      },
    });
    gate.down = true;
    const rows = Array.from({ length: 450 }, () => directRequestRow(accessEntry(), {}));
    await client.report("requests", rows);
    gate.down = false;
    assert.equal(await client.flush(), true);
    assert.deepEqual(seen, [200, 200, 50]);
    assert.equal(entry.query("SELECT COUNT(*) AS n FROM requests")[0].n, 450);
  } finally {
    await entry.close();
  }
});

test("the spool cap drops the oldest lines and counts them", async () => {
  const entry = await startEntry();
  try {
    const { gate, client, spoolFile } = ingestClient(entry, { maxSpoolBytes: 4096 });
    gate.down = true;
    const rows = Array.from({ length: 40 }, (_, i) => directRequestRow(accessEntry({ userAgent: `agent-${i}-${"u".repeat(80)}` }), {}));
    for (const row of rows) await client.report("requests", [row]);
    const size = fs.statSync(spoolFile).size;
    assert.ok(size <= 4096, `spool is ${size} bytes`);
    const stats = client.stats();
    assert.ok(stats.droppedFromSpool > 0);
    const lines = fs.readFileSync(spoolFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).row.requestId);
    assert.equal(lines.length + stats.droppedFromSpool, 40);
    assert.deepEqual(lines, rows.slice(40 - lines.length).map((row) => row.requestId), "the newest rows survive, in order");
    gate.down = false;
    assert.equal(await client.flush(), true);
    assert.equal(entry.query("SELECT COUNT(*) AS n FROM requests")[0].n, lines.length);
  } finally {
    await entry.close();
  }
});

test("an entry-routed request (valid v2 hop) is not reported by the manager; a direct one is", () => {
  const PATHNAME = "/serve/v1/chat/completions";
  const principal = { k: "key_abc123", b: "vllm-manager", c: "egg", t: "", l: "public", p: "key" };
  const hop = trust.buildEntryHeaders(TOKEN, {
    method: "POST",
    pathname: PATHNAME,
    clientIp: "203.0.113.9",
    requestId: "req_abcdefghijklmnopqrst",
    principal,
    context: { v: 1, src: "openwebui", cc: "CN" },
  }, Date.now());
  function response() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headersSent = false;
    res.write = () => { res.headersSent = true; return true; };
    res.end = () => {
      res.headersSent = true;
      res.emit("finish");
      res.emit("close");
    };
    return res;
  }
  function run(headers) {
    const req = { method: "POST", originalUrl: PATHNAME, headers: { "user-agent": "curl/8.0", ...headers }, socket: { remoteAddress: "127.0.0.1" }, body: { model: "m" } };
    const logged = [];
    const reported = [];
    const res = response();
    // The gateway middleware mints or adopts the request id before the log is attached.
    core.ensureOpenAiGatewayRequestId(req);
    core.attachServiceGatewayAccessLog(req, res, "openai", (item) => logged.push(item), (item) => reported.push(item));
    res.end();
    return { logged, reported };
  }
  const routed = run(hop);
  assert.equal(routed.logged.length, 1);
  assert.equal(routed.logged[0].viaEntry, true);
  assert.equal(routed.reported.length, 0, "the entry already records this request");

  // A forged hop (tampered context) is direct ingress.
  const forged = run({ ...hop, [trust.GATEWAY_CONTEXT_HEADER]: `v1.${Buffer.from(JSON.stringify({ v: 1, src: "x" })).toString("base64url")}` });
  assert.equal(forged.reported.length, 1);

  const direct = run({});
  assert.equal(direct.reported.length, 1);
  const row = directRequestRow(direct.reported[0], { managerId: "vllm-manager" });
  assert.equal(row.ingress, "direct");
  assert.ok(row.requestId.startsWith("mgr_"));
  assert.equal(row.managerRequestId, direct.logged[0].requestId);
  assert.equal(row.protocol, "openai");

  // A reporter that throws never reaches the response path.
  const req = { method: "POST", originalUrl: PATHNAME, headers: {}, socket: { remoteAddress: "127.0.0.1" }, body: {} };
  const res = response();
  core.attachServiceGatewayAccessLog(req, res, "openai", () => {}, () => { throw new Error("reporter failed"); });
  assert.doesNotThrow(() => res.end());
});

test("manager audit actions (legacy /api/audit/*) reach the entry's audit_access_log in order", async () => {
  const entry = await startEntry();
  try {
    const { gate, client } = ingestClient(entry);
    const routes = new Map();
    const app = {
      get: (route, handler) => routes.set(`GET ${route}`, handler),
      post: (route, handler) => routes.set(`POST ${route}`, handler),
    };
    let authed = false;
    core.registerAuditRoutes(app, {
      auditRoot: "audit",
      managerName: "vllm-manager",
      verifyAuditPassword: async (password) => password === "pw",
      createAuditSession: () => ({ token: "t" }),
      getAuditAuth: () => ({ token: "t" }),
      destroyAuditSession: () => {},
      requireAuditAuth: () => (authed ? { ok: true } : { ok: false, status: 401, message: "no" }),
      listAuditExports: async () => [],
      onAccess: (item) => client.report("audit-access", [item]),
    });
    function call(key, body = {}) {
      return new Promise((resolve) => {
        const req = { body, params: {}, headers: { "user-agent": "audit-ui" }, socket: { remoteAddress: "127.0.0.1" } };
        const res = {
          statusCode: 200,
          status(code) { this.statusCode = code; return this; },
          json(payload) { resolve({ status: this.statusCode, payload }); return this; },
        };
        routes.get(key)(req, res);
      });
    }
    gate.down = true;
    assert.equal((await call("POST /api/audit/login", { password: "bad" })).status, 401);
    authed = true;
    assert.equal((await call("POST /api/audit/login", { password: "pw" })).status, 200);
    gate.down = false;
    assert.equal((await call("GET /api/audit/exports")).status, 200);
    await call("POST /api/audit/logout");
    await client.flush();
    const rows = entry.query("SELECT action, outcome, source, client_ip, user_agent FROM audit_access_log ORDER BY seq");
    assert.deepEqual(rows.map((row) => `${row.action}:${row.outcome}`), ["login_failed:denied", "login_ok:ok", "list_exports:ok", "logout:ok"]);
    assert.equal(rows[0].source, "vllm-manager");
    assert.equal(rows[0].user_agent, "audit-ui");
    assert.equal((await entry.store.call("auditAccessVerify", {})).ok, true);
  } finally {
    await entry.close();
  }
});

test("a failing onAccess never changes the audit route's answer", async () => {
  const routes = new Map();
  const app = { get: (r, h) => routes.set(`GET ${r}`, h), post: (r, h) => routes.set(`POST ${r}`, h) };
  core.registerAuditRoutes(app, {
    managerName: "vllm-manager",
    requireAuditAuth: () => ({ ok: true }),
    listAuditExports: async () => [1],
    onAccess: () => { throw new Error("boom"); },
  });
  const answer = await new Promise((resolve) => {
    routes.get("GET /api/audit/exports")({ headers: {}, params: {} }, { json: resolve, status() { return this; } });
  });
  assert.deepEqual(answer.exports, [1]);
});

test("telemetry off acknowledges and drops; no store answers 503; the module mounts one ADMIN-only prefix", async () => {
  const off = await startEntry({ env: { TELEMETRY_ENABLED: "0" } });
  try {
    const target = "/internal/telemetry/requests";
    const body = JSON.stringify({ rows: [directRequestRow(accessEntry(), {})] });
    const answer = await rawPost(off, target, body, signed(target, body));
    assert.equal(answer.status, 200);
    assert.equal(answer.json.accepted, 0);
    assert.equal((await rawPost(off, target, body, {})).status, 401, "still authenticated");
  } finally {
    await off.close();
  }

  const mounted = await runtimeModule.mount({ telemetry: null });
  const sent = {};
  const res = { writeHead(status) { sent.status = status; }, end() {} };
  assert.equal(await mounted.handle({ resume() {} }, res, new URL("http://x/api/models")), false);
  assert.equal(await mounted.handle({ resume() {} }, res, new URL("http://x/internal/telemetry/requests")), true);
  assert.equal(sent.status, 503);

  const entry = require("../server");
  assert.ok(entry.ROUTE_MODULES.includes("./lib/telemetry-runtime"));
  assert.ok(entry.ROUTE_MODULES.indexOf("./lib/telemetry-runtime") > entry.ROUTE_MODULES.indexOf("./lib/manager-event-relay"));
});
