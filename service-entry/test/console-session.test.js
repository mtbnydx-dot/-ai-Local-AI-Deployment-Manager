"use strict";

// The shared gateway pipeline (05 §8.1, PUB-8): platform keys from the
// access store, the owner's `console-session` on ADMIN (§5.8), scopes, model
// patterns and fleetAllow with the §10.2 codes, x-request-id on every answer
// and x-local-ai-route only for debug.route callers or the local owner.
//
// The entry runs in-process against two fake managers on ephemeral ports;
// every other upstream port is one nothing listens on, and the ledgers,
// access store and telemetry live in a temp dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { listen, loadEntry, ownerSession, request } = require("./helpers/entry-harness");
const {
  CONSOLE_SESSION_PRINCIPAL,
  CONSOLE_SESSION_SCOPES,
  createGatewayPipeline,
  hopPrincipal,
  keyMayUseManager,
  scopeForGatewayPath,
  scopeForModelRoute,
} = require("../lib/gateway-pipeline");

const REQUEST_ID = /^req_[a-z2-7]{20}$/;
const upstreamHits = [];
const servers = [];
let entry = null;
let adminPort = 0;
let publicPort = 0;
let dbFile = "";

// A manager that serves /api/instances and echoes the proxied requests.
// What the fake managers advertise in /api/manager/health (05 §7.1).
let fakeTrustVersion = 2;

function fakeManager(instances) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ instances }));
    }
    // A current manager: hop v2 capable, so platform keys are served (05 §7.1).
    if (url.pathname === "/api/manager/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(fakeTrustVersion ? { ok: true, gatewayTrust: { version: fakeTrustVersion, mode: "warn" } } : { ok: true }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        body = null;
      }
      upstreamHits.push({ path: url.pathname, headers: { ...req.headers }, body });
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "upstream-id" });
      res.end(JSON.stringify({ id: "cmpl-test", model: body?.model || null, choices: [] }));
    });
    return undefined;
  });
}

async function setup() {
  if (entry) return;
  const loaded = await loadEntry();
  entry = loaded.entry;
  dbFile = path.join(loaded.tempDir, "telemetry.sqlite");
  // The ports the entry read at load are free; the fake managers take them.
  const vllm = fakeManager([
    { id: "primary", primary: true, running: true, models: [{ id: "qwen-chat" }] },
    { id: "side", running: true, models: [{ id: "secret-model" }] },
  ]);
  const llama = fakeManager([{ id: "primary", primary: true, running: true, models: [{ id: "gemma-gguf" }] }]);
  await new Promise((resolve) => vllm.listen(Number(process.env.VLLM_MANAGER_PORT), "127.0.0.1", resolve));
  await new Promise((resolve) => llama.listen(Number(process.env.LLAMA_MANAGER_PORT), "127.0.0.1", resolve));
  const admin = http.createServer((req, res) => {
    const peer = req.headers["x-test-peer"];
    if (peer) {
      delete req.headers["x-test-peer"];
      Object.defineProperty(req.socket, "remoteAddress", { value: String(peer), configurable: true });
    }
    entry.handleRequest(req, res);
  });
  const pub = entry.createPublicServer();
  servers.push(vllm, llama, admin, pub);
  adminPort = await listen(admin);
  publicPort = await listen(pub);
}

test.after(async () => {
  await entry?.stopTelemetry();
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  entry?.closeAccessStore();
  try {
    entry?.getBillingStore().close();
  } catch {
    // Already closed.
  }
});

function withRequiredKey(t, value = "1") {
  const previous = process.env.SERVICE_ENTRY_REQUIRE_API_KEY;
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SERVICE_ENTRY_REQUIRE_API_KEY;
    else process.env.SERVICE_ENTRY_REQUIRE_API_KEY = previous;
  });
}

function chat(port, model, { owner, headers = {}, pathname = "/gateway/auto/openai/v1/chat/completions", peer } = {}) {
  entry.resetEntryRateLimitBuckets();
  return request(port, pathname, { method: "POST", owner, headers, peer, body: { model, messages: [{ role: "user", content: "hi" }] } });
}

function createKey(input) {
  return entry.getAccessStore().createKey({ class: "friend", models: ["*"], ...input, name: input.name || "test key" }, { actor: "test" });
}

async function lastUpstream(fromIndex) {
  return upstreamHits.slice(fromIndex).at(-1) || null;
}

function telemetryRows(marker) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM requests WHERE user_agent = ? ORDER BY id").all(marker);
  } finally {
    db.close();
  }
}

async function rowsFor(marker) {
  const deadline = Date.now() + 4000;
  let rows = [];
  while (Date.now() < deadline) {
    await entry.getTelemetry()?.recorder?.flush();
    rows = fs.existsSync(dbFile) ? telemetryRows(marker) : [];
    if (rows.length) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return rows;
}

// --- unit: the pipeline's policy helpers -------------------------------------

test("scopes per gateway route follow 05 §6.3", () => {
  assert.equal(scopeForModelRoute({ protocol: "openai", rest: "v1/models" }, "GET"), "models.read");
  assert.equal(scopeForModelRoute({ protocol: "openai", rest: "v1/chat/completions" }, "POST"), "chat");
  assert.equal(scopeForModelRoute({ protocol: "openai", rest: "v1/completions" }, "POST"), "completions");
  assert.equal(scopeForModelRoute({ protocol: "openai", rest: "v1/responses" }, "POST"), "responses");
  for (const rest of ["v1/embeddings", "v1/rerank", "v1/score"]) assert.equal(scopeForModelRoute({ protocol: "openai", rest }, "POST"), "embeddings");
  assert.equal(scopeForModelRoute({ protocol: "claude", rest: "v1/messages" }, "POST"), "messages");
  assert.equal(scopeForModelRoute({ protocol: "claude", rest: "v1/models" }, "GET"), "models.read");
  assert.equal(scopeForModelRoute({ protocol: "opencode", rest: "v1/chat/completions" }, "POST"), "chat");
  assert.equal(scopeForGatewayPath("/gateway/status", "GET"), "models.read");
  assert.equal(scopeForGatewayPath("/gateway/tts/openai/v1/audio/speech", "POST"), "audio.speech");
  assert.equal(scopeForGatewayPath("/gateway/tts/api/voices", "GET"), "audio.clone");
  assert.equal(scopeForGatewayPath("/gateway/search/v1/search", "POST"), "search");
  assert.equal(scopeForGatewayPath("/gateway/mcp", "POST"), "mcp");
  assert.deepEqual([...CONSOLE_SESSION_SCOPES].sort(), ["audio.clone", "audio.speech", "chat", "completions", "debug.route", "messages", "models.read", "responses"]);
});

test("fleetAllow scopes a key to managers, and the hop principal follows §5.8 and §7.1", () => {
  assert.equal(keyMayUseManager({ fleetAllow: [] }, "llama"), true);
  assert.equal(keyMayUseManager({ fleetAllow: ["vllm:*"] }, "vllm"), true);
  assert.equal(keyMayUseManager({ fleetAllow: ["vllm:*"] }, "llama"), false);
  assert.equal(keyMayUseManager({ fleetAllow: ["vllm:primary", "!vllm:side"] }, "vllm"), true);
  assert.equal(keyMayUseManager({ fleetAllow: ["*"] }, "llama"), true);

  assert.deepEqual(hopPrincipal({ ok: true, kind: "console-session" }), { k: "console", b: null, c: "console", t: "", l: "admin", p: "console-session" });
  assert.deepEqual(CONSOLE_SESSION_PRINCIPAL, { k: "console", b: null, c: "console", t: "", l: "admin", p: "console-session" });
  assert.equal(hopPrincipal({ ok: true, kind: "keyless" }), null);
  const key = { id: "vllm.egg", billing: { scope: "vllm-manager", clientId: "egg" }, ttsOwner: "vllm:egg", limits: { maxOutputTokens: 8192, maxConcurrent: 2 } };
  assert.deepEqual(hopPrincipal({ ok: true, kind: "key", key }, "public"), { k: "vllm.egg", b: "vllm-manager", c: "egg", t: "vllm:egg", l: "public", p: "key", mo: 8192, mc: 2 });
});

test("resolveCaller: key header wins, then the owner session with CSRF, then the keyless rules", async () => {
  const calls = [];
  const security = {
    listenerKind: (req) => req.listener?.kind || "admin",
    authorizeGatewayRequest: async (req, options) => {
      calls.push(options.scope);
      if (req.headers.authorization) return { ok: true, kind: "key", key: { id: "k_test" }, scopes: ["chat"] };
      return { ok: true, kind: "keyless" };
    },
  };
  const session = (role = "owner", csrf = true) => ({
    authenticate: () => ({ role, via: "session", sessionId: "s1234567" }),
    requireCsrf: () => csrf,
  });
  let adminAuth = session();
  const pipeline = createGatewayPipeline({ security, getAdminAuth: () => adminAuth });
  const cookie = { cookie: "lai_admin=abc.def" };

  const owner = await pipeline.resolveCaller({ method: "POST", headers: { ...cookie } }, { scope: "chat" });
  assert.deepEqual([owner.ok, owner.kind, owner.principal], [true, "console-session", "console-session"]);
  assert.equal(calls.length, 0, "the console session needs no store lookup");
  const keyed = await pipeline.resolveCaller({ method: "POST", headers: { ...cookie, authorization: "Bearer sk-x" } }, { scope: "chat" });
  assert.equal(keyed.kind, "key", "a key header always wins over the cookie");
  for (const scope of ["mcp", "search", "embeddings"]) {
    const denied = await pipeline.resolveCaller({ method: "POST", headers: { ...cookie } }, { scope });
    assert.deepEqual([denied.ok, denied.status, denied.code, denied.param], [false, 403, "scope_denied", scope]);
  }
  adminAuth = session("owner", false);
  const noCsrf = await pipeline.resolveCaller({ method: "POST", headers: { ...cookie } }, { scope: "chat" });
  assert.deepEqual([noCsrf.status, noCsrf.code], [403, "csrf_invalid"]);
  // A viewer session (a LAN session without allowLanOwner) is no console
  // session: the keyless rules decide.
  adminAuth = session("viewer");
  assert.equal((await pipeline.resolveCaller({ method: "POST", headers: { ...cookie } }, { scope: "chat" })).kind, "keyless");
  // PUBLIC never looks at the cookie.
  adminAuth = session();
  assert.equal((await pipeline.resolveCaller({ method: "POST", headers: { ...cookie }, listener: { kind: "public" } }, { scope: "chat" })).kind, "keyless");
});

// --- integration over HTTP ----------------------------------------------------

test("x-request-id is on every gateway answer, refusals included, while telemetry is off", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  const refused = await chat(adminPort, "qwen-chat", { headers: { "x-request-id": "client-supplied-1" } });
  assert.equal(refused.status, 401);
  assert.match(refused.headers["x-request-id"], REQUEST_ID);
  assert.equal(refused.json.request_id, refused.headers["x-request-id"]);
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "0";
  const served = await chat(adminPort, "qwen-chat");
  assert.equal(served.status, 200);
  assert.match(served.headers["x-request-id"], REQUEST_ID, "the upstream's own id never reaches the caller");
  const listed = await request(adminPort, "/gateway/auto/openai/v1/models");
  assert.match(listed.headers["x-request-id"], REQUEST_ID);
  const onPublic = await request(publicPort, "/v1/models");
  assert.equal(onPublic.status, 401);
  assert.match(onPublic.headers["x-request-id"], REQUEST_ID);
});

test("console-session: the owner's cookie and CSRF on ADMIN is unbilled owner traffic recorded as the console", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  await entry.stopTelemetry();
  await entry.startTelemetry({
    config: { enabled: true, dbPath: dbFile, keepJsonlAccessLog: false },
    dataDir: path.dirname(dbFile),
    inProcess: true,
    jobs: { enabled: false },
    flushMs: 40,
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => entry.stopTelemetry());
  const owner = await ownerSession(entry, adminPort);

  const before = upstreamHits.length;
  const served = await chat(adminPort, "qwen-chat", { owner, headers: { "user-agent": "pub8/console" } });
  assert.equal(served.status, 200, served.text);
  assert.match(served.headers["x-request-id"], REQUEST_ID);
  // The playground shows the route: console-session carries debug.route.
  assert.match(String(served.headers["x-local-ai-route"]), /^vllm primary qwen-chat /);
  const hit = await lastUpstream(before);
  assert.equal(hit.path, "/serve/v1/chat/completions");
  assert.equal(hit.headers.authorization, undefined, "no key travels: b:null, owner traffic");
  assert.equal(hit.headers.cookie !== undefined && hit.headers.cookie.includes("lai_admin"), true, "the cookie is the caller's own header, as before");
  const [row] = await rowsFor("pub8/console");
  assert.ok(row, "the request is a telemetry row");
  assert.equal(row.key_id, null);
  assert.equal(row.auth_source, "console-session");

  // GET needs no CSRF token.
  const listed = await request(adminPort, "/gateway/auto/openai/v1/models", { owner });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.data.some((model) => model.id === "qwen-chat"));
});

test("console-session: a POST without CSRF is 403 csrf_invalid in the route's protocol shape", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  const owner = await ownerSession(entry, adminPort);
  const cookieOnly = { cookie: owner.cookie };
  const before = upstreamHits.length;
  const openai = await chat(adminPort, "qwen-chat", { headers: cookieOnly });
  assert.equal(openai.status, 403);
  assert.deepEqual([openai.json.error.code, openai.json.error.type], ["csrf_invalid", "permission_error"]);
  assert.equal(openai.json.request_id, openai.headers["x-request-id"]);
  const anthropic = await chat(adminPort, "qwen-chat", { headers: cookieOnly, pathname: "/gateway/auto/claude/v1/messages" });
  assert.equal(anthropic.status, 403);
  assert.deepEqual([anthropic.json.type, anthropic.json.error.type], ["error", "permission_error"]);
  const wrong = await chat(adminPort, "qwen-chat", { headers: { ...cookieOnly, "x-csrf-token": "not-the-token" } });
  assert.equal(wrong.json.error.code, "csrf_invalid");
  assert.equal(upstreamHits.length, before, "nothing reached a manager");
});

test("console-session: a key header wins over the cookie; mcp and search are scope_denied", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  const owner = await ownerSession(entry, adminPort);
  const { key, secret } = createKey({ name: "precedence", scopes: ["models.read", "chat"], models: ["qwen-*"] });

  const before = upstreamHits.length;
  const keyed = await chat(adminPort, "qwen-chat", { owner, headers: { authorization: `Bearer ${secret}` } });
  assert.equal(keyed.status, 200);
  // A v2 manager gets the key's signed principal instead of the key (05 §7.1).
  const keyedHit = await lastUpstream(before);
  assert.equal(keyedHit.headers.authorization, undefined);
  const keyedPrincipal = JSON.parse(Buffer.from(keyedHit.headers["x-service-entry-principal"], "base64url").toString("utf8"));
  assert.equal(keyedPrincipal.k, key.id, "the key, not the session, is the caller");
  // The key's own rules apply even with an owner cookie beside it.
  const notAllowed = await chat(adminPort, "gemma-gguf", { owner, headers: { authorization: `Bearer ${secret}` } });
  assert.deepEqual([notAllowed.status, notAllowed.json.error.code, notAllowed.json.error.param], [403, "model_not_allowed", "model"]);
  const badKey = await chat(adminPort, "qwen-chat", { owner, headers: { authorization: "Bearer sk-plat-not-a-key" } });
  assert.deepEqual([badKey.status, badKey.json.error.code], [401, "invalid_api_key"], "an invalid key never falls back to the session");
  assert.equal(key.id.startsWith("k_"), true);

  for (const [method, pathname] of [["POST", "/gateway/mcp"], ["GET", "/gateway/search/v1/health"]]) {
    const denied = await request(adminPort, pathname, { method, owner, body: method === "POST" ? {} : undefined });
    assert.deepEqual([denied.status, denied.json?.error?.code], [403, "scope_denied"], `${method} ${pathname}`);
  }
  // The TTS family is in the session's scopes: the request passes auth and
  // meets the (offline) TTS gateway instead.
  const tts = await request(adminPort, "/gateway/tts/api/voices", { owner });
  assert.equal(tts.status, 503);
  assert.equal(tts.json.code, "service_unavailable");
});

test("console-session: an invalid cookie falls back to the keyless rules, and PUBLIC ignores the cookie", async (t) => {
  await setup();
  withRequiredKey(t, "0");
  const owner = await ownerSession(entry, adminPort);
  const forged = await chat(adminPort, "qwen-chat", { headers: { cookie: "lai_admin=forgedsessionid.forgedsecret", "x-csrf-token": "x" } });
  assert.equal(forged.status, 200, "keyless loopback, as without a cookie");
  process.env.SERVICE_ENTRY_REQUIRE_API_KEY = "1";
  const forgedRequired = await chat(adminPort, "qwen-chat", { headers: { cookie: "lai_admin=forgedsessionid.forgedsecret" } });
  assert.deepEqual([forgedRequired.status, forgedRequired.json.error.code], [401, "missing_api_key"]);

  const before = upstreamHits.length;
  for (const pathname of ["/v1/chat/completions", "/gateway/auto/openai/v1/chat/completions"]) {
    const onPublic = await chat(publicPort, "qwen-chat", { owner, pathname });
    assert.deepEqual([onPublic.status, onPublic.json.error.code], [401, "missing_api_key"], pathname);
    assert.equal(onPublic.headers["set-cookie"], undefined);
  }
  assert.equal(upstreamHits.length, before);
});

test("keys: scopes, model patterns and fleetAllow are enforced with the 05 §10.2 codes", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  const listOnly = createKey({ name: "list only", scopes: ["models.read"] });
  const denied = await chat(adminPort, "qwen-chat", { headers: { authorization: `Bearer ${listOnly.secret}` } });
  assert.deepEqual([denied.status, denied.json.error.code, denied.json.error.param], [403, "scope_denied", "chat"]);
  const listed = await request(adminPort, "/gateway/auto/openai/v1/models", { headers: { authorization: `Bearer ${listOnly.secret}` } });
  assert.equal(listed.status, 200);

  // Model patterns: generic ids pick among the allowed models only; a listing
  // shows only them.
  const qwen = createKey({ name: "qwen only", scopes: ["models.read", "chat"], models: ["qwen-*"] });
  const qwenAuth = { authorization: `Bearer ${qwen.secret}` };
  for (let index = 0; index < 3; index += 1) {
    const before = upstreamHits.length;
    const picked = await chat(adminPort, "auto", { headers: qwenAuth });
    assert.equal(picked.status, 200);
    assert.equal((await lastUpstream(before)).body.model, "qwen-chat");
  }
  const qwenList = await request(adminPort, "/gateway/auto/openai/v1/models", { headers: qwenAuth });
  assert.deepEqual(qwenList.json.data.map((model) => model.id), ["qwen-chat"]);
  const excluded = await chat(adminPort, "gemma-gguf", { headers: qwenAuth });
  assert.deepEqual([excluded.status, excluded.json.error.code], [403, "model_not_allowed"]);
  const unknown = await chat(adminPort, "no-such-model", { headers: qwenAuth });
  assert.equal(unknown.status, 404, "a model nobody serves is still not found");

  // fleetAllow on instances: secret-model runs on vllm:side.
  const primaryOnly = createKey({ name: "primary only", scopes: ["models.read", "chat"], fleetAllow: ["vllm:primary"] });
  const side = await chat(adminPort, "secret-model", { headers: { authorization: `Bearer ${primaryOnly.secret}` } });
  assert.deepEqual([side.status, side.json.error.code], [403, "model_not_allowed"]);
  assert.equal((await chat(adminPort, "qwen-chat", { headers: { authorization: `Bearer ${primaryOnly.secret}` } })).status, 200);

  // A migrated key is scoped to its manager (fleetAllow ["vllm:*"]): the llama
  // route keeps the ADMIN code manager_forbidden; PUBLIC says model_not_allowed.
  const migrated = createKey({ name: "migrated", scopes: ["models.read", "chat"], fleetAllow: ["vllm:*"] });
  const migratedAuth = { authorization: `Bearer ${migrated.secret}` };
  const onAdmin = await chat(adminPort, "gemma-gguf", { headers: migratedAuth, pathname: "/gateway/llama/openai/v1/chat/completions" });
  assert.deepEqual([onAdmin.status, onAdmin.json.error.code], [403, "manager_forbidden"]);
  const onPublic = await chat(publicPort, "gemma-gguf", { headers: migratedAuth, pathname: "/llama/v1/chat/completions" });
  assert.deepEqual([onPublic.status, onPublic.json.error.code], [403, "model_not_allowed"]);
  const autoGemma = await chat(adminPort, "gemma-gguf", { headers: migratedAuth });
  assert.deepEqual([autoGemma.status, autoGemma.json.error.code], [403, "model_not_allowed"]);
});

test("x-local-ai-route goes only to debug.route keys and direct loopback callers on ADMIN", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  const plain = createKey({ name: "plain", scopes: ["chat"] });
  const debug = createKey({ name: "debug", scopes: ["chat", "debug.route"] });
  const plainAuth = { authorization: `Bearer ${plain.secret}` };

  const loopback = await chat(adminPort, "qwen-chat", { headers: plainAuth });
  assert.equal(loopback.status, 200);
  assert.ok(loopback.headers["x-local-ai-route"], "the local owner sees the route on ADMIN");
  const onPublic = await chat(publicPort, "qwen-chat", { headers: plainAuth, pathname: "/v1/chat/completions" });
  assert.equal(onPublic.status, 200);
  assert.equal(onPublic.headers["x-local-ai-route"], undefined);
  const debugPublic = await chat(publicPort, "qwen-chat", { headers: { authorization: `Bearer ${debug.secret}` }, pathname: "/v1/chat/completions" });
  assert.match(String(debugPublic.headers["x-local-ai-route"]), /^vllm primary qwen-chat /);
  // A forwarded caller on ADMIN (legacy tunnel) is not the local owner.
  const forwarded = await chat(adminPort, "qwen-chat", { headers: { ...plainAuth, "x-forwarded-for": "203.0.113.9" } });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers["x-local-ai-route"], undefined);
});

test("hop v2: a legacy manager still gets the key; a platform-only key cannot be served there", async (t) => {
  await setup();
  withRequiredKey(t, "1");
  const migrated = entry.getAccessStore().createKey({
    id: "vllm.hop-legacy",
    name: "migrated laptop",
    class: "friend",
    scopes: ["models.read", "chat"],
    models: ["*"],
    fleetAllow: ["vllm:*"],
    billing: { scope: "vllm-manager", clientId: "hop-legacy" },
    ttsOwner: "vllm:hop-legacy",
    legacy: { managerId: "vllm", clientId: "hop-legacy", source: "service-clients" },
  }, { actor: "test" });
  const platform = createKey({ name: "platform only", scopes: ["models.read", "chat"] });

  // v2-capable manager: neither key travels, the principal does.
  entry.resetManagerTrustCache();
  let before = upstreamHits.length;
  assert.equal((await chat(adminPort, "qwen-chat", { headers: { authorization: `Bearer ${migrated.secret}` } })).status, 200);
  const v2Hit = await lastUpstream(before);
  assert.equal(v2Hit.headers.authorization, undefined);
  assert.ok(v2Hit.headers["x-service-entry-signature-v2"]);
  const principal = JSON.parse(Buffer.from(v2Hit.headers["x-service-entry-principal"], "base64url").toString("utf8"));
  assert.deepEqual([principal.k, principal.b, principal.c], ["vllm.hop-legacy", "vllm-manager", "hop-legacy"]);

  // A legacy manager (no gatewayTrust): the migrated key is forwarded as
  // before, without a v2 signature; a platform-only key answers 503.
  fakeTrustVersion = 0;
  entry.resetManagerTrustCache();
  t.after(() => {
    fakeTrustVersion = 2;
    entry.resetManagerTrustCache();
  });
  before = upstreamHits.length;
  assert.equal((await chat(adminPort, "qwen-chat", { headers: { authorization: `Bearer ${migrated.secret}` } })).status, 200);
  const legacyHit = await lastUpstream(before);
  assert.equal(legacyHit.headers.authorization, `Bearer ${migrated.secret}`);
  assert.equal(legacyHit.headers["x-service-entry-signature-v2"], undefined);
  assert.equal(legacyHit.headers["x-service-entry-principal"], undefined);
  before = upstreamHits.length;
  const refused = await chat(adminPort, "qwen-chat", { headers: { authorization: `Bearer ${platform.secret}` } });
  assert.equal(refused.status, 503);
  assert.equal(upstreamHits.length, before, "nothing reached the legacy manager");
});
