"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const sqlite = require("node:sqlite");
const core = require("../../manager-core");
const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const accessLog = require("../../manager-core/telemetry/audit-access-log");
const { createAuditScheduler } = require("../../manager-core/telemetry/audit-scheduler");
const { AUDIT_ROUTES, createAuditHttp, createAuditSessions, createLoginThrottle } = require("../lib/audit-http");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const PASSWORD = "correct horse battery staple";
const START = Date.UTC(2026, 9, 14, 12, 0, 0);
const HOUR_MS = 3_600_000;

const CONTENT_ROUTES = AUDIT_ROUTES.filter((route) => route.gate === "audit");

function sampleHistory() {
  return [
    { auditId: "20261001-full", mode: "full", createdAt: "2026-10-01T04:00:00.000Z", chatCount: 5, messageCount: 20 },
    { auditId: "20261013-inc", mode: "incremental", createdAt: "2026-10-13T09:00:00.000Z", chatCount: 2, messageCount: 6 },
    { auditId: "20261014-empty", mode: "incremental", createdAt: "2026-10-14T09:00:00.000Z", chatCount: 0, messageCount: 0 },
  ];
}

function writeExportTree(auditRoot) {
  for (const item of sampleHistory()) {
    const dir = path.join(auditRoot, item.auditId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      auditId: item.auditId, mode: item.mode, createdAt: item.createdAt, summary: { chat_count: item.chatCount, message_count: item.messageCount, incremental: item.mode === "incremental" },
    }));
    fs.writeFileSync(path.join(dir, "openwebui-chats-full.md"), `# Export ${item.auditId}\n\nHello\n`);
  }
}

function createFakeConfig() {
  let version = 1;
  const values = {
    root: "",
    schedule: { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" },
    retention: { maxExports: 30, maxAgeDays: 90, rebaselineDays: 7, maxChains: 8 },
    logQueryText: false,
  };
  const config = {
    writes: [],
    readSection(name) {
      assert.equal(name, "audit");
      return { values: JSON.parse(JSON.stringify(values)), etag: `v${version}`, errors: [] };
    },
    async writeSection(name, patch, options = {}) {
      config.writes.push({ name, patch: JSON.parse(JSON.stringify(patch)), options });
      if (options.etag !== undefined && options.etag !== `v${version}`) {
        return { ok: false, status: 409, code: "config_conflict", error: { code: "config_conflict", message: "The settings changed." }, etag: `v${version}`, errors: [] };
      }
      const changed = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === "object") {
          for (const [inner, innerValue] of Object.entries(value)) {
            if (!(inner in values[key])) {
              return { ok: false, status: 400, code: "config_invalid", error: { code: "config_invalid", message: "unknown key" }, errors: [{ field: `audit.${key}.${inner}`, code: "unknown_key" }] };
            }
            values[key][inner] = innerValue;
            changed.push(`audit.${key}.${inner}`);
          }
        } else {
          values[key] = value;
          changed.push(`audit.${key}`);
        }
      }
      version += 1;
      return { ok: true, etag: `v${version}`, changed, restartRequired: [], errors: [] };
    },
  };
  return config;
}

function createFakeIndex() {
  const index = {
    calls: [],
    async searchChats(query) {
      index.calls.push(["searchChats", query]);
      return { rows: [{ chatId: "chat-1", title: "Hello", versions: 2 }], nextCursor: null };
    },
    async getChat(chatId, options) {
      index.calls.push(["getChat", chatId, options]);
      if (chatId === "missing") return null;
      return {
        chat: { chatId, title: "Hello" },
        messages: [{ id: "m1", parentId: null, role: "user", model: "", timestamp: "2026-10-14T08:00:00.000Z", content: "hi <b>there</b>", contentType: "markdown" }],
        auditId: "20261013-inc",
        isLatest: true,
      };
    },
    async chatVersions(chatId) {
      index.calls.push(["chatVersions", chatId]);
      return chatId === "missing" ? { versions: [] } : { versions: [{ auditId: "20261013-inc", createdAt: "2026-10-13T09:00:00.000Z", messageCount: 2, updatedAt: "2026-10-13T08:00:00.000Z" }] };
    },
    stats() {
      return { chats: 2, messages: 5, lastIndexedAt: "2026-10-14T09:00:00.000Z" };
    },
  };
  return index;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// An audit API on its own server. The caller's role and CSRF state come from
// request headers, so one server serves a viewer and an owner.
async function startAudit(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-http-"));
  const auditRoot = path.join(dir, "audit");
  writeExportTree(auditRoot);
  const clock = { value: START };
  const now = () => clock.value;
  const realStore = await openTelemetryStore({ file: path.join(dir, "telemetry.sqlite"), logger: quietLogger() });
  const health = { failing: false };
  const store = {
    appendAuditAccess: async (entry) => {
      if (health.failing) throw new Error("the store is down");
      return realStore.appendAuditAccess(entry);
    },
    call: (...args) => realStore.call(...args),
    getState: (...args) => realStore.getState(...args),
    setState: (...args) => realStore.setState(...args),
    insertEvents: (...args) => realStore.insertEvents(...args),
  };
  const config = createFakeConfig();
  const exportCalls = [];
  const realAuditStore = core.createAuditStore({
    auditRoot,
    auditPasswordFile: path.join(auditRoot, "audit-admin-password.txt"),
    envPassword: PASSWORD,
    openWebuiContainer: "open-webui",
    serviceContainer: "service-entry",
    getContainerStatus: async () => ({ exists: true, running: true }),
    docker: async () => ({ stdout: "", stderr: "" }),
  });
  const auditStore = {
    ...realAuditStore,
    async exportOpenWebuiAudit(reason, context) {
      exportCalls.push({ reason, context });
      return options.exportResult ? options.exportResult(reason, context) : {
        ok: true, auditId: "20261014-new", auditDir: path.join(auditRoot, "20261014-new"), mode: context.full ? "full" : "incremental",
        chatCount: 4, messageCount: 9, pruned: [],
      };
    },
  };
  const containerState = { exists: true, running: true };
  const containerStatus = async () => ({ ...containerState });
  const scheduler = createAuditScheduler({
    auditStore, store, config: () => config.readSection("audit").values, now, containerStatus, logger: { warn() {}, log() {} },
  });
  const index = options.index === undefined ? createFakeIndex() : options.index;
  const auth = {
    principal: (req) => ({ role: String(req.headers["x-test-role"] || "owner"), principal: "loopback", via: "loopback" }),
    checkWrite: (req) => (req.headers["x-test-csrf"] === "ok" ? { ok: true } : { ok: false, status: 403, code: "csrf_invalid", message: "CSRF token missing." }),
  };
  const logs = [];
  const audit = createAuditHttp({
    auth,
    store,
    auditStore,
    scheduler,
    index,
    config,
    now,
    openWebuiContainer: "open-webui",
    containerStatus,
    logger: { warn: (line) => logs.push(String(line)), log() {}, error() {} },
    createReadStream: options.createReadStream,
    loginFailureLimit: options.loginFailureLimit,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    audit.handle(req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    }, (error) => {
      res.writeHead(500);
      res.end(String(error?.stack || error));
    });
  });
  const port = await listen(server);
  let closed = false;
  async function shutdown() {
    if (closed) return;
    closed = true;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await realStore.close();
  }
  t.after(async () => {
    await shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });

  async function call(method, pathname, { role, headers = {}, body, rawBody, csrf = true } = {}) {
    const text = rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = { ...headers };
      if (role) outgoing["x-test-role"] = role;
      if (csrf && method !== "GET") outgoing["x-test-csrf"] = "ok";
      if (text !== null) {
        outgoing["content-type"] = "application/json";
        outgoing["content-length"] = String(Buffer.byteLength(text));
      }
      const outgoingRequest = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: outgoing, agent: false }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const payload = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = payload ? JSON.parse(payload) : null; } catch { json = null; }
          resolve({ status: response.statusCode, headers: response.headers, text: payload, json });
        });
        response.on("error", reject);
      });
      outgoingRequest.on("error", reject);
      outgoingRequest.end(text === null ? undefined : text);
    });
  }

  async function login(password = PASSWORD) {
    const response = await call("POST", "/api/audit/login", { body: { password } });
    return response;
  }

  async function unlocked() {
    const response = await login();
    assert.equal(response.status, 200);
    return { "x-audit-session": response.json.token };
  }

  async function rows(limit = 500) {
    return (await store.call("auditAccessLog", { limit })).rows.reverse();
  }

  return { port, call, login, unlocked, rows, clock, config, index, exportCalls, containerState, store, realStore, health, scheduler, auditStore, dir, auditRoot, logs, shutdown };
}

test("a viewer gets 401 admin_session_required on every route, and an unknown one", async (t) => {
  const api = await startAudit(t);
  const samples = AUDIT_ROUTES.map((route) => ({
    method: route.method,
    path: route.path.replace(":auditId", "20261013-inc").replace(":chatId", "chat-1"),
  }));
  samples.push({ method: "GET", path: "/api/audit/nope" });
  assert.ok(samples.length >= 14);
  for (const role of ["viewer", "none"]) {
    for (const sample of samples) {
      const response = await api.call(sample.method, sample.path, { role, body: sample.method === "GET" ? undefined : {} });
      assert.equal(response.status, 401, `${role} ${sample.method} ${sample.path}`);
      assert.equal(response.json.error.code, "admin_session_required");
      assert.equal(response.json.ok, false);
    }
  }
  // Even a viewer holding a valid audit session gets nothing.
  const headers = await api.unlocked();
  const viewer = await api.call("GET", "/api/audit/chats", { role: "viewer", headers });
  assert.equal(viewer.status, 401);
  // No index call was made, and the viewer's attempts left no trace in the trail.
  assert.equal(api.index.calls.length, 0);
  assert.deepEqual((await api.rows()).map((row) => row.action), ["login_ok"]);
});

test("a machine principal is not the owner, and a write needs CSRF", async (t) => {
  const api = await startAudit(t);
  assert.equal((await api.call("GET", "/api/audit/status", { role: "system" })).status, 403);
  const noCsrf = await api.call("POST", "/api/audit/login", { body: { password: PASSWORD }, csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, "csrf_invalid");
  const put = await api.call("PUT", "/api/audit/settings", { body: { logQueryText: true }, csrf: false });
  assert.equal(put.status, 403);
  assert.equal(api.config.writes.length, 0);
  assert.equal((await api.call("GET", "/api/audit/status")).status, 200);
  assert.equal((await api.call("GET", "/api/audit/nope")).status, 404);
  assert.equal((await api.call("DELETE", "/api/audit/chats")).status, 405);
});

test("an owner without the audit session gets 401 on every content route and the attempt is logged", async (t) => {
  const api = await startAudit(t);
  for (const route of CONTENT_ROUTES) {
    const pathname = route.path.replace(":auditId", "20261013-inc").replace(":chatId", "chat-1");
    const response = await api.call(route.method, pathname);
    assert.equal(response.status, 401, `${route.method} ${pathname}`);
    assert.equal(response.json.error.code, "audit_session_required");
  }
  assert.equal(api.index.calls.length, 0, "no content was looked up");
  const logged = await api.rows();
  assert.deepEqual(
    logged.map((row) => [row.action, row.outcome, row.detail.reason]),
    [
      ["view_markdown", "denied", "audit_session_required"],
      ["list_chats", "denied", "audit_session_required"],
      ["view_chat", "denied", "audit_session_required"],
      ["chat_versions", "denied", "audit_session_required"],
      ["verify", "denied", "audit_session_required"],
    ],
  );
  // The owner-only routes need no audit session and carry no content.
  for (const pathname of ["/api/audit/status", "/api/audit/exports", "/api/audit/settings"]) {
    assert.equal((await api.call("GET", pathname)).status, 200, pathname);
  }
});

test("x-audit-session and a non-pat bearer both open the content routes; a pat_ bearer does not", async (t) => {
  const api = await startAudit(t);
  const token = (await api.login()).json.token;
  const viaHeader = await api.call("GET", "/api/audit/chats", { headers: { "x-audit-session": token } });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.json.rows[0].chatId, "chat-1");
  const viaBearer = await api.call("GET", "/api/audit/chats", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(viaBearer.status, 200);
  const tool = await api.call("GET", "/api/audit/chats", { headers: { authorization: "Bearer pat_0123456789abcdef" } });
  assert.equal(tool.status, 401);
  // A tool token carries the owner role; the audit session still comes from the header.
  const both = await api.call("GET", "/api/audit/chats", { headers: { authorization: "Bearer pat_0123456789abcdef", "x-audit-session": token } });
  assert.equal(both.status, 200);
  // The header is preferred: a wrong header is not rescued by a good bearer.
  const preferred = await api.call("GET", "/api/audit/chats", { headers: { "x-audit-session": "wrong", authorization: `Bearer ${token}` } });
  assert.equal(preferred.status, 401);
  assert.equal((await api.call("GET", "/api/audit/chats", { headers: { "x-audit-session": "x".repeat(64) } })).status, 401);
});

test("login: the password is never stored or echoed, sessions are hashed, and logout ends one", async (t) => {
  const api = await startAudit(t);
  const wrong = await api.login("not the password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, "audit_password_invalid");
  assert.equal((await api.call("POST", "/api/audit/login", { body: {} })).status, 401);
  assert.equal((await api.call("POST", "/api/audit/login", { body: { password: 12345 } })).status, 401);

  const ok = await api.login();
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ok.json.expiresAt, new Date(START + 12 * HOUR_MS).toISOString());
  assert.equal(ok.text.includes(PASSWORD), false);

  const logged = await api.rows();
  assert.deepEqual(logged.map((row) => [row.action, row.outcome]), [
    ["login_failed", "denied"], ["login_failed", "denied"], ["login_failed", "denied"], ["login_ok", "ok"],
  ]);
  const sessionId = crypto.createHash("sha256").update(ok.json.token).digest("hex").slice(0, 12);
  assert.equal(logged[3].session, sessionId);
  const dump = JSON.stringify(logged);
  assert.equal(dump.includes(PASSWORD), false);
  assert.equal(dump.includes("not the password"), false);
  assert.equal(dump.includes(ok.json.token), false);
  assert.equal(logged[3].actor, "legacy-local");
  assert.equal(logged[3].source, "entry");
  assert.equal(logged[3].clientIp, "127.0.0.1");

  const headers = { "x-audit-session": ok.json.token };
  assert.equal((await api.call("GET", "/api/audit/chats", { headers })).status, 200);
  const out = await api.call("POST", "/api/audit/logout", { headers });
  assert.equal(out.status, 200);
  assert.equal((await api.call("GET", "/api/audit/chats", { headers })).status, 401);
  const after = await api.rows();
  assert.equal(after.some((row) => row.action === "logout" && row.session === sessionId), true);
});

test("login throttling: five failures a minute per IP give 429 audit_login_throttled, and every failure is logged", async (t) => {
  const api = await startAudit(t);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await api.login(`guess ${attempt}`);
    assert.equal(response.status, 401, `attempt ${attempt + 1}`);
  }
  const throttled = await api.login(PASSWORD);
  assert.equal(throttled.status, 429, "even the right password waits");
  assert.equal(throttled.json.error.code, "audit_login_throttled");
  assert.ok(Number(throttled.headers["retry-after"]) >= 1 && Number(throttled.headers["retry-after"]) <= 60);
  assert.equal((await api.login("another guess")).status, 429);

  const logged = await api.rows();
  assert.equal(logged.filter((row) => row.action === "login_failed" && row.detail.reason === "invalid_password").length, 5);
  assert.equal(logged.filter((row) => row.action === "login_failed" && row.detail.reason === "throttled").length, 2);
  assert.equal(logged.every((row) => row.action === "login_failed" && row.outcome === "denied"), true);

  // Throttled attempts do not extend the window.
  api.clock.value += 61_000;
  const recovered = await api.login();
  assert.equal(recovered.status, 200);
  assert.equal((await api.rows()).at(-1).action, "login_ok");
});

test("the throttle and the session store work on a fake clock", () => {
  let clock = 1000;
  const throttle = createLoginThrottle({ now: () => clock, limit: 3, windowMs: 10_000 });
  assert.equal(throttle.blockedFor("a"), 0);
  throttle.fail("a"); throttle.fail("a");
  assert.equal(throttle.blockedFor("a"), 0);
  assert.equal(throttle.fail("a"), 3);
  assert.equal(throttle.blockedFor("a"), 10);
  assert.equal(throttle.blockedFor("b"), 0);
  clock += 6000;
  assert.equal(throttle.blockedFor("a"), 4);
  clock += 5000;
  assert.equal(throttle.blockedFor("a"), 0);
  throttle.fail("a");
  throttle.reset("a");
  assert.equal(throttle.fail("a"), 1);

  const sessions = createAuditSessions({ now: () => clock, ttlMs: 1000 });
  const first = sessions.create();
  assert.equal(sessions.validate(first.token).ok, true);
  clock += 900;
  assert.equal(sessions.validate(first.token).ok, true, "use slides the window");
  clock += 900;
  assert.equal(sessions.validate(first.token).ok, true);
  clock += 1001;
  assert.deepEqual(sessions.validate(first.token), { ok: false, reason: "expired" });
  assert.deepEqual(sessions.validate(""), { ok: false, reason: "missing" });
  assert.equal(sessions.size, 0);
  const second = sessions.create();
  assert.equal(sessions.destroy(second.token), true);
  assert.equal(sessions.destroy(second.token), false);
  for (let count = 0; count < 100; count += 1) sessions.create();
  assert.ok(sessions.size <= 64);
});

test("a session expires after 12 hours without use and slides while it is used", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  api.clock.value += 11 * HOUR_MS;
  assert.equal((await api.call("GET", "/api/audit/chats", { headers })).status, 200);
  api.clock.value += 11 * HOUR_MS;
  assert.equal((await api.call("GET", "/api/audit/chats", { headers })).status, 200, "used within 12 hours of the last use");
  api.clock.value += 12 * HOUR_MS + 1000;
  const expired = await api.call("GET", "/api/audit/chats", { headers });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, "audit_session_required");
  assert.match(expired.json.error.message, /expired/i);
  const last = (await api.rows()).at(-1);
  assert.deepEqual([last.action, last.outcome, last.detail.reason], ["list_chats", "denied", "audit_session_expired"]);
});

test("the Markdown export streams, and the error paths answer without crashing", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  const ok = await api.call("GET", "/api/audit/exports/20261013-inc/markdown", { headers });
  assert.equal(ok.status, 200);
  assert.match(ok.headers["content-type"], /^text\/markdown/);
  assert.equal(ok.headers["x-content-type-options"], "nosniff");
  assert.equal(ok.text, "# Export 20261013-inc\n\nHello\n");

  const missing = await api.call("GET", "/api/audit/exports/20250101-gone/markdown", { headers });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "audit_file_missing");
  const invalid = await api.call("GET", "/api/audit/exports/..%2F..%2Fsecret/markdown", { headers });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "invalid_audit_id");

  const logged = await api.rows();
  const views = logged.filter((row) => row.action === "view_markdown");
  assert.deepEqual(views.map((row) => row.outcome), ["ok", "error", "error"]);
  assert.deepEqual(views.map((row) => row.detail?.code ?? null), [null, "audit_file_missing", "invalid_audit_id"]);
  assert.equal(views[0].target, "20261013-inc");
});

test("a Markdown file that vanishes or fails to read answers 404 or 500 JSON, or ends the connection once bytes were sent", async (t) => {
  let mode = "enoent";
  const api = await startAudit(t, {
    createReadStream() {
      const stream = new PassThrough();
      setImmediate(() => {
        if (mode === "enoent") stream.emit("error", Object.assign(new Error("gone"), { code: "ENOENT" }));
        else if (mode === "eacces") stream.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));
        else {
          stream.emit("open");
          stream.write("partial ");
          setImmediate(() => stream.emit("error", Object.assign(new Error("disk fault"), { code: "EIO" })));
        }
      });
      return stream;
    },
  });
  const headers = await api.unlocked();
  const url = "/api/audit/exports/20261013-inc/markdown";
  const gone = await api.call("GET", url, { headers });
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error.code, "audit_file_missing");
  mode = "eacces";
  const denied = await api.call("GET", url, { headers });
  assert.equal(denied.status, 500);
  assert.equal(denied.json.error.code, "audit_file_unreadable");
  mode = "midstream";
  const cut = await api.call("GET", url, { headers }).then((response) => response, (error) => ({ error }));
  assert.ok(cut.error || cut.text !== "partial \n", "the connection ended instead of finishing a broken body");
  // The server is still serving.
  mode = "enoent";
  assert.equal((await api.call("GET", "/api/audit/status")).status, 200);
});

test("every audit action appends a hash-chained row, verify recomputes the chain, and a tampered copy fails it", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  assert.equal((await api.call("GET", "/api/audit/exports", { headers })).status, 200);
  assert.equal((await api.call("GET", "/api/audit/exports/20261013-inc/markdown", { headers })).status, 200);
  assert.equal((await api.call("POST", "/api/audit/export", { headers, body: { mode: "incremental", note: "before the audit" } })).status, 200);
  assert.equal((await api.call("GET", "/api/audit/chats", { headers })).status, 200);
  assert.equal((await api.call("GET", "/api/audit/chats?q=refund", { headers })).status, 200);
  assert.equal((await api.call("GET", "/api/audit/chats/chat-1?auditId=20261013-inc", { headers })).status, 200);
  assert.equal((await api.call("GET", "/api/audit/chats/chat-1/versions", { headers })).status, 200);
  const settings = await api.call("GET", "/api/audit/settings");
  assert.equal((await api.call("PUT", "/api/audit/settings", { body: { etag: settings.json.etag, schedule: { incrementalEveryMinutes: 120 } } })).status, 200);
  const verified = await api.call("GET", "/api/audit/access-log/verify", { headers });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.ok, true);
  assert.equal(verified.json.firstBrokenSeq, null);
  assert.equal(await api.call("POST", "/api/audit/logout", { headers }).then((response) => response.status), 200);

  const logged = await api.rows();
  assert.deepEqual(logged.map((row) => row.action), [
    "login_ok", "list_exports", "view_markdown", "export_manual", "list_chats", "search", "view_chat", "chat_versions", "settings_change", "verify", "logout",
  ]);
  assert.ok(logged.every((row) => row.outcome === "ok" && row.source === "entry"));
  assert.equal(verified.json.rows, 9, "verify counts the rows written before it ran");
  // The chain links each row to the one before.
  let previous = accessLog.GENESIS_HASH;
  for (const row of logged) {
    assert.equal(row.prevHash, previous);
    previous = row.hash;
  }
  assert.equal(logged[3].target, "20261014-new");
  assert.deepEqual(logged[3].detail, { mode: "incremental", skipped: false, reason: null, noteLength: 16 });
  assert.equal(logged[6].target, "chat-1");
  assert.equal(JSON.stringify(logged).includes("before the audit"), false, "the export note is not logged");

  // The endpoint is the same check that fails on a copy edited behind the triggers.
  await api.shutdown();
  const copyFile = path.join(api.dir, "tampered.sqlite");
  fs.copyFileSync(path.join(api.dir, "telemetry.sqlite"), copyFile);
  const copy = new sqlite.DatabaseSync(copyFile);
  try {
    assert.equal(accessLog.auditAccessVerify(copy).ok, true);
    copy.exec("DROP TRIGGER audit_access_log_no_update");
    copy.exec("UPDATE audit_access_log SET target = 'someone-else' WHERE seq = 3");
    const broken = accessLog.auditAccessVerify(copy);
    assert.equal(broken.ok, false);
    assert.equal(broken.firstBrokenSeq, 3);
  } finally {
    copy.close();
  }
});

test("the access log lists newest first with a cursor and refuses odd parameters", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  for (let count = 0; count < 5; count += 1) await api.call("GET", "/api/audit/exports", { headers });
  const first = await api.call("GET", "/api/audit/access-log?limit=4", { headers });
  assert.equal(first.status, 200);
  assert.equal(first.json.rows.length, 4);
  assert.equal(first.json.rows[0].action, "list_exports");
  assert.equal(typeof first.json.nextCursor, "string");
  const second = await api.call("GET", `/api/audit/access-log?limit=4&cursor=${first.json.nextCursor}`, { headers });
  assert.equal(second.json.rows.length, 2);
  assert.equal(second.json.rows.at(-1).action, "login_ok");
  assert.equal(second.json.nextCursor, null);
  assert.ok(second.json.rows.every((row) => row.seq < Number(first.json.nextCursor) + 1));
  assert.equal((await api.call("GET", "/api/audit/access-log?cursor=abc", { headers })).status, 400);
  assert.equal((await api.call("GET", "/api/audit/access-log?when=now", { headers })).json.error.code, "unknown_parameter");
  assert.equal((await api.call("GET", "/api/audit/access-log?from=yesterday", { headers })).json.error.code, "invalid_time");
  const windowed = await api.call("GET", `/api/audit/access-log?from=${START + 1}&to=${START + 2}`, { headers });
  assert.deepEqual(windowed.json.rows, []);
});

test("search text is logged as a hash and a length, in full only when logQueryText is on", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  const term = "customer refund dispute";
  await api.call("GET", `/api/audit/chats?q=${encodeURIComponent(term)}&limit=9999&user=someone&model=m1&archived=true`, { headers });
  assert.deepEqual(api.index.calls[0][1], { q: term, user: "someone", model: "m1", from: null, to: null, archived: true, cursor: "", limit: 100 });
  let rows = await api.rows();
  let search = rows.at(-1);
  assert.equal(search.action, "search");
  assert.deepEqual(search.detail, {
    querySha256: crypto.createHash("sha256").update(term).digest("hex"), queryLength: term.length, results: 1,
  });
  assert.equal(JSON.stringify(rows).includes("refund"), false);

  await api.call("PUT", "/api/audit/settings", { body: { logQueryText: true } });
  await api.call("GET", `/api/audit/chats?q=${encodeURIComponent(term)}`, { headers });
  rows = await api.rows();
  search = rows.at(-1);
  assert.equal(search.detail.query, term);
  assert.equal(api.index.calls[1][1].limit, 50);

  await api.call("GET", "/api/audit/chats", { headers });
  assert.equal((await api.rows()).at(-1).action, "list_chats");
  assert.equal((await api.call("GET", "/api/audit/chats?bogus=1", { headers })).json.error.code, "unknown_parameter");
  assert.equal((await api.call("GET", `/api/audit/chats?q=${"x".repeat(201)}`, { headers })).json.error.code, "invalid_query");
  assert.equal((await api.call("GET", "/api/audit/chats?from=notatime", { headers })).json.error.code, "invalid_time");
});

test("chat and version lookups answer 404 for an unknown chat, and 503 while there is no index", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  const found = await api.call("GET", "/api/audit/chats/chat-1?auditId=20261013-inc", { headers });
  assert.equal(found.status, 200);
  assert.equal(found.json.messages[0].contentType, "markdown");
  assert.deepEqual(api.index.calls.at(-1), ["getChat", "chat-1", { auditId: "20261013-inc" }]);
  assert.equal((await api.call("GET", "/api/audit/chats/missing", { headers })).status, 404);
  assert.equal((await api.call("GET", "/api/audit/chats/missing/versions", { headers })).json.error.code, "chat_not_found");
  const versions = await api.call("GET", "/api/audit/chats/chat-1/versions", { headers });
  assert.equal(versions.json.versions[0].auditId, "20261013-inc");

  const bare = await startAudit(t, { index: null });
  const bareHeaders = await bare.unlocked();
  for (const pathname of ["/api/audit/chats", "/api/audit/chats/chat-1", "/api/audit/chats/chat-1/versions"]) {
    const response = await bare.call("GET", pathname, { headers: bareHeaders });
    assert.equal(response.status, 503, pathname);
    assert.equal(response.json.error.code, "audit_index_unavailable");
  }
  const status = await bare.call("GET", "/api/audit/status");
  assert.equal(status.json.index.available, false);
});

test("content is not served when its access row cannot be written", async (t) => {
  const api = await startAudit(t);
  const headers = await api.unlocked();
  api.health.failing = true;
  for (const pathname of ["/api/audit/chats", "/api/audit/chats/chat-1", "/api/audit/exports/20261013-inc/markdown", "/api/audit/chats/chat-1/versions"]) {
    const response = await api.call("GET", pathname, { headers });
    assert.equal(response.status, 503, pathname);
    assert.equal(response.json.error.code, "audit_log_unavailable");
    assert.equal(response.text.includes("Hello"), false);
  }
  assert.ok(api.logs.some((line) => /access row/.test(line)));
  api.health.failing = false;
  assert.equal((await api.call("GET", "/api/audit/chats", { headers })).status, 200);
});

test("status describes the chain, the schedule and the retention plan without a path or any content", async (t) => {
  const api = await startAudit(t);
  const status = await api.call("GET", "/api/audit/status");
  assert.equal(status.status, 200);
  const body = status.json;
  assert.equal(body.ok, true);
  assert.equal(body.passwordFile, "<redacted path>");
  assert.deepEqual(body.openWebuiContainer, { exists: true, running: true });
  assert.equal(body.schedule.enabled, true);
  assert.equal(body.schedule.incrementalEveryMinutes, 60);
  assert.equal(body.schedule.fullAtLocal, "04:00");
  assert.equal(typeof body.schedule.nextIncrementalAt, "string");
  assert.equal(body.chains.length, 1);
  assert.deepEqual(
    (({ fullAuditId, incrementals, chats, messages, active }) => ({ fullAuditId, incrementals, chats, messages, active }))(body.chains[0]),
    { fullAuditId: "20261001-full", incrementals: 2, chats: 7, messages: 26, active: true },
  );
  assert.equal(body.retention.policy.maxChains, 8);
  // The newest export is always kept, and the baseline is 13 days old.
  assert.deepEqual(body.retention.plan.remove, []);
  assert.equal(body.retention.plan.needsRebaseline, true);
  assert.equal(body.schedule.needsRebaseline, true);
  assert.deepEqual(body.index, { available: true, chats: 2, messages: 5, lastIndexedAt: "2026-10-14T09:00:00.000Z" });
  assert.ok(body.lastRuns && "lastError" in body.lastRuns);
  assert.equal(status.text.includes(api.dir), false, "no path of this machine");
  assert.equal(status.text.includes(PASSWORD), false);
  assert.equal(status.text.includes("auditDir"), false);

  api.containerState.exists = false;
  api.containerState.running = false;
  api.clock.value += 10_000;
  assert.deepEqual((await api.call("GET", "/api/audit/status")).json.openWebuiContainer, { exists: false, running: false });
  assert.equal((await api.rows()).length, 0, "status is not an audit action");
});

test("the export list adds the chain and the empty-incremental flag and hides the folders", async (t) => {
  const api = await startAudit(t);
  const response = await api.call("GET", "/api/audit/exports");
  assert.equal(response.status, 200);
  const byId = Object.fromEntries(response.json.exports.map((item) => [item.auditId, item]));
  assert.equal(byId["20261013-inc"].chainId, "20261001-full");
  assert.equal(byId["20261001-full"].chainId, "20261001-full");
  assert.equal(byId["20261014-empty"].skippedEmpty, true);
  assert.equal(byId["20261013-inc"].skippedEmpty, false);
  assert.equal(response.text.includes(api.dir), false);
  assert.equal("auditDir" in byId["20261013-inc"], false);
  assert.equal(byId["20261013-inc"].chatCount, 2);
});

test("a manual export runs through the scheduler, and a missing container is a skip, not a failure", async (t) => {
  const api = await startAudit(t);
  const full = await api.call("POST", "/api/audit/export", { body: { mode: "full", note: "quarterly" } });
  assert.equal(full.status, 200);
  assert.equal(full.json.ok, true);
  assert.equal(full.json.auditId, "20261014-new");
  assert.equal(full.json.mode, "full");
  assert.deepEqual(api.exportCalls[0].reason, "manual");
  assert.equal(api.exportCalls[0].context.full, true);
  assert.equal(api.exportCalls[0].context.note, "quarterly");
  assert.equal((await api.call("POST", "/api/audit/export", { body: {} })).json.mode, "full");
  assert.equal((await api.call("POST", "/api/audit/export", { body: { mode: "weekly" } })).status, 400);

  api.containerState.exists = false;
  const skipped = await api.call("POST", "/api/audit/export", { body: { mode: "incremental" } });
  assert.equal(skipped.status, 200);
  assert.deepEqual([skipped.json.ok, skipped.json.skipped, skipped.json.reason], [false, true, "openwebui_missing"]);
  assert.equal(api.exportCalls.length, 2, "no export was attempted without the container");
  const rows = await api.rows();
  assert.deepEqual(rows.filter((row) => row.action === "export_manual").map((row) => row.outcome), ["ok", "ok", "error", "ok"]);
});

test("a failed manual export answers 500 with the code and is logged as an error", async (t) => {
  const api = await startAudit(t, { exportResult: () => ({ ok: false, error: "docker cp failed" }) });
  const response = await api.call("POST", "/api/audit/export", { body: { mode: "full" } });
  assert.equal(response.status, 500);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, "audit_export_failed");
  const row = (await api.rows()).at(-1);
  assert.deepEqual([row.action, row.outcome], ["export_manual", "error"]);
  const status = await api.call("GET", "/api/audit/status");
  assert.equal(status.json.lastRuns.lastError, "docker cp failed");
});

test("settings: GET returns the sections with an etag; PUT goes through writeSection(\"audit\") and logs the keys only", async (t) => {
  const api = await startAudit(t);
  const read = await api.call("GET", "/api/audit/settings");
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.schedule, { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" });
  assert.equal(read.json.retention.maxChains, 8);
  assert.equal(read.json.logQueryText, false);
  assert.equal(read.json.etag, "v1");
  assert.equal("root" in read.json, false);

  const write = await api.call("PUT", "/api/audit/settings", {
    body: { etag: "v1", schedule: { incrementalEveryMinutes: 30, fullAtLocal: "03:30" }, retention: { maxChains: 5 }, logQueryText: true },
  });
  assert.equal(write.status, 200);
  assert.equal(write.json.etag, "v2");
  assert.deepEqual(write.json.changed.sort(), [
    "audit.logQueryText", "audit.retention.maxChains", "audit.schedule.fullAtLocal", "audit.schedule.incrementalEveryMinutes",
  ]);
  assert.equal(write.json.schedule.incrementalEveryMinutes, 30);
  assert.equal(write.json.logQueryText, true);
  assert.equal(api.config.writes.length, 1);
  assert.equal(api.config.writes[0].name, "audit");
  assert.deepEqual(api.config.writes[0].patch, { schedule: { incrementalEveryMinutes: 30, fullAtLocal: "03:30" }, retention: { maxChains: 5 }, logQueryText: true });
  assert.equal(api.config.writes[0].options.etag, "v1");
  assert.equal(api.config.writes[0].options.actor, "legacy-local");

  const change = (await api.rows()).at(-1);
  assert.deepEqual([change.action, change.outcome], ["settings_change", "ok"]);
  assert.deepEqual(change.detail.changed.sort(), write.json.changed.sort());
  assert.equal(JSON.stringify(change).includes("03:30"), false, "values are not part of the trail");

  // A stale etag is a conflict, an unknown key a 400, and neither changes anything.
  const stale = await api.call("PUT", "/api/audit/settings", { body: { etag: "v1", logQueryText: false } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "config_conflict");
  assert.equal(stale.json.etag, "v2");
  assert.equal((await api.call("PUT", "/api/audit/settings", { body: { schedule: { cron: "* * * * *" } } })).status, 400);
  assert.equal((await api.call("PUT", "/api/audit/settings", { body: { root: "elsewhere" } })).status, 400);
  assert.equal((await api.call("PUT", "/api/audit/settings", { body: {} })).status, 400);
  assert.equal((await api.call("PUT", "/api/audit/settings", { body: { schedule: "daily" } })).status, 400);
  assert.equal((await api.call("GET", "/api/audit/settings")).json.logQueryText, true);
  const outcomes = (await api.rows()).filter((row) => row.action === "settings_change").map((row) => row.outcome);
  assert.deepEqual(outcomes, ["ok", "error", "error", "error", "error", "error"]);

  // The If-Match header carries the etag too.
  const viaHeader = await api.call("PUT", "/api/audit/settings", { headers: { "if-match": "\"v2\"" }, body: { logQueryText: false } });
  assert.equal(viaHeader.status, 200);
  assert.equal(api.config.writes.at(-1).options.etag, "v2");
});

test("a malformed or oversized body is a 400 or 413, not a failure", async (t) => {
  const api = await startAudit(t);
  const bad = await api.call("POST", "/api/audit/login", { rawBody: "[not an object" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_request");
  const big = await api.call("POST", "/api/audit/login", { body: { password: "x".repeat(40_000) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, "payload_too_large");
  assert.equal((await api.call("GET", "/api/audit/status")).status, 200);
  assert.deepEqual((await api.rows()).map((row) => row.action), [], "a malformed body is not a login attempt");
});

test("the real entry registers every audit route owner-only and answers a LAN viewer 401 before the module runs", async (t) => {
  const { entry } = await loadEntry();
  assert.ok(entry.ROUTE_MODULES.includes("./lib/audit-http"), "the module is in the mount table");
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx, modules: ["./lib/audit-http"] });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  assert.equal(ctx.features.audit, true);
  const inventory = ctx.auth.viewerRegistry.inventory().filter((item) => item.path.startsWith("/api/audit/"));
  assert.deepEqual(
    inventory.map((item) => `${item.method} ${item.path} ${item.access}`).sort(),
    AUDIT_ROUTES.map((route) => `${route.method} ${route.path} admin`).sort(),
  );
  const port = await serveEntry(t, entry, routes);
  for (const route of AUDIT_ROUTES) {
    const pathname = route.path.replace(":auditId", "20261013-inc").replace(":chatId", "chat-1");
    const lan = await request(port, pathname, { method: route.method, peer: "192.0.2.50", body: route.method === "GET" ? undefined : {} });
    assert.equal(lan.status, 401, `${route.method} ${pathname}`);
    assert.equal(lan.json.error.code, "admin_session_required");
  }
  // The paired owner reaches the module, which owns the 404.
  const unknown = await request(port, "/api/audit/nope", { owner: await ownerSession(entry, port) });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "not_found");
  assert.equal(typeof ctx.audit.checkSession, "function");
});
