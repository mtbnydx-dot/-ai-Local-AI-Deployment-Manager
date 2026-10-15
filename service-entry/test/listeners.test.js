"use strict";

// The structural part of 05 §17.2 (PUB-6): two listeners, the PUBLIC route
// table, the Host rules and the ADMIN forwarded-header policy. Everything
// runs on port 0 over loopback; no upstream is reachable (entry-harness points
// every manager port at a closed one). The key flow (a v2 principal reaching a
// fake manager, limits, CORS; items 4-8, PUB-12) starts at "the key flow" below,
// with fake managers on the ports the entry read at load.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadEntry, request } = require("./helpers/entry-harness");
const { resolveBinds, startListeners } = require("../lib/listeners");
const { classifyPublicRoute, gatewayPathFor } = require("../lib/public-listener");
const { createEntrySecurity } = require("../lib/security");
const core = require("../../manager-core");

let loaded;
test.before(async () => {
  loaded = await loadEntry();
});
test.after(() => {
  loaded?.entry.closeAccessStore?.();
});

function accessConfig(overrides = {}) {
  return {
    listeners: {
      admin: { host: "127.0.0.1", port: 0, lan: false, ...overrides.admin },
      public: { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "", ...overrides.public },
    },
  };
}

async function boot(t, { config = accessConfig(), adminHandler, publicHandler, extra = {} } = {}) {
  const { entry } = loaded;
  const started = await startListeners({
    config,
    adminHandler: adminHandler || ((req, res) => entry.handleRequest(req, res)),
    publicHandler: publicHandler || entry.createPublicHandler(),
    logger: { log() {}, warn() {}, error() {} },
    ...extra,
  });
  t.after(async () => {
    started.admin.closeAllConnections?.();
    started.public?.closeAllConnections?.();
    await started.close();
  });
  return started;
}

const adminPort = (started) => started.binds.admin.port;
const publicPort = (started) => started.binds.public.port;
// The PUBLIC listener sees a normal Host (127.0.0.1 is on its allowlist).
const asPublic = (started, pathname, options = {}) => request(publicPort(started), pathname, { ...options, headers: { host: "127.0.0.1", ...options.headers } });
const asAdmin = (started, pathname, options = {}) => request(adminPort(started), pathname, options);

test("resolveBinds: loopback defaults, lan and wildcard hosts bind wildcards", () => {
  const defaults = resolveBinds(accessConfig({ admin: { port: 5176 }, public: { port: 5186 } }));
  assert.deepEqual([defaults.admin.host, defaults.admin.port, defaults.admin.lanBound], ["127.0.0.1", 5176, false]);
  assert.deepEqual([defaults.public.host, defaults.public.port, defaults.public.lanBound, defaults.public.enabled], ["127.0.0.1", 5186, false, true]);
  // The built-in defaults are what the specs say.
  const fromSchema = resolveBinds({ listeners: { admin: { host: "127.0.0.1", port: 5176, lan: false }, public: { enabled: true, host: "127.0.0.1", port: 5186 } } });
  assert.equal(fromSchema.admin.port, 5176);

  const lan = resolveBinds(accessConfig({ admin: { port: 5176, lan: true } }));
  assert.deepEqual([lan.admin.host, lan.admin.lanBound], ["0.0.0.0", true]);
  const wildcardAdmin = resolveBinds(accessConfig({ admin: { host: "0.0.0.0" } }));
  assert.deepEqual([wildcardAdmin.admin.host, wildcardAdmin.admin.lanBound], ["0.0.0.0", true]);
  const wildcardPublic = resolveBinds(accessConfig({ public: { host: "0.0.0.0" } }));
  assert.deepEqual([wildcardPublic.public.host, wildcardPublic.public.lanBound], ["0.0.0.0", true]);
  assert.equal(resolveBinds(accessConfig({ public: { enabled: false } })).public.enabled, false);
});

test("two servers on their own ports; each request is tagged with its listener", async (t) => {
  const seen = [];
  const tagger = (kind) => (req, res) => {
    seen.push({ kind, listener: req.listener });
    res.end("ok");
  };
  const started = await boot(t, { adminHandler: tagger("admin"), publicHandler: tagger("public") });
  assert.notEqual(adminPort(started), publicPort(started));
  assert.equal(started.binds.admin.host, "127.0.0.1");
  assert.equal(started.binds.public.host, "127.0.0.1");
  await asAdmin(started, "/");
  await asPublic(started, "/");
  assert.deepEqual(seen.map((item) => item.listener), [{ kind: "admin", lanBound: false }, { kind: "public", lanBound: false }]);
  assert.equal(Object.isFrozen(seen[0].listener), true);
});

test("a PUBLIC bind failure leaves ADMIN up and reports public_listener_unavailable", async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const logged = [];
  const reported = [];
  const started = await boot(t, {
    config: accessConfig({ public: { port: blocker.address().port } }),
    extra: { logger: { log() {}, warn() {}, error: (line) => logged.push(line) }, onPublicUnavailable: (error) => reported.push(error) },
  });
  assert.equal(started.public, null);
  assert.equal(started.publicError.code, "EADDRINUSE");
  assert.match(logged.join("\n"), /public_listener_unavailable/);
  assert.equal(reported.length, 1);
  assert.equal((await asAdmin(started, "/gateway/health")).status, 200);
  await started.close();
});

test("an ADMIN bind failure rejects; PUBLIC disabled never binds", async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(
    startListeners({ config: accessConfig({ admin: { port: blocker.address().port } }), adminHandler: (req, res) => res.end("x"), logger: { error() {} } }),
    (error) => error.code === "EADDRINUSE" && /already in use/.test(error.message),
  );
  const started = await boot(t, { config: accessConfig({ public: { enabled: false } }) });
  assert.equal(started.public, null);
  assert.equal(started.publicError, null);
  assert.equal(started.binds.public, undefined);
});

test("every ADMIN route is a 404 on PUBLIC (05 §17.2 item 1)", async (t) => {
  const started = await boot(t);
  const adminRoutes = [
    ["GET", "/api/status"],
    ["GET", "/api/keys"],
    ["POST", "/api/stop-all"],
    ["GET", "/api/events"],
    ["GET", "/api/session"],
    ["GET", "/billing"],
    ["GET", "/billing/classic"],
    ["POST", "/internal/billing/authorize"],
    ["GET", "/internal/access/keys"],
    ["GET", "/docs/service-runbook.md"],
    ["GET", "/gateway/mcp"],
    ["POST", "/gateway/mcp"],
    ["GET", "/gateway/tts/"],
    ["GET", "/gateway/tts/api/voices"],
    ["GET", "/gateway/search/v1/search"],
    ["GET", "/classic"],
    ["GET", "/c/abc123/app.js"],
    ["GET", "/shared-js/tokens.css"],
    ["GET", "/index.html"],
  ];
  for (const [method, pathname] of adminRoutes) {
    const answer = await asPublic(started, pathname, { method, body: method === "POST" ? {} : undefined });
    assert.equal(answer.status, 404, `${method} ${pathname}`);
    assert.doesNotMatch(answer.text, /api_key|stop|billing_/i, `${method} ${pathname} leaks nothing`);
  }
});

test("PUBLIC serves /healthz, /gateway/health and /robots.txt without a key", async (t) => {
  const started = await boot(t);
  const health = await asPublic(started, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.text, "ok");
  assert.match(health.headers["content-type"], /^text\/plain/);
  const gateway = await asPublic(started, "/gateway/health");
  assert.equal(gateway.status, 200);
  assert.equal(gateway.json.ok, true);
  const robots = await asPublic(started, "/robots.txt");
  assert.equal(robots.status, 200);
  for (const prefix of ["/v1/", "/anthropic/", "/me", "/playground"]) assert.match(robots.text, new RegExp(`Disallow: ${prefix}`));
  // The same on ADMIN, unchanged.
  assert.equal((await asAdmin(started, "/gateway/health")).status, 200);
  // Every PUBLIC answer carries a minted request id.
  assert.match(health.headers["x-request-id"], /^req_[0-9a-z]{20}$/i);
});

test("a header-less loopback request to PUBLIC reaches only the portal routes and key routes", async (t) => {
  const reached = [];
  const portal = { handle: (req, res, url, route) => { reached.push(`portal:${route.kind}:${url.pathname}`); res.end("portal"); return true; } };
  const gateway = (req, res, url, route) => { reached.push(`key:${req.method} ${url.pathname} -> ${route.gatewayPath}`); res.end("key"); };
  const publicHandler = loaded.entry.createPublicHandler({ portal, gateway });
  const started = await boot(t, { publicHandler });
  for (const pathname of ["/", "/status", "/models", "/models/qwen3", "/docs", "/docs/getting-started", "/me", "/playground", "/announcements", "/assets/abc123/app.js", "/portal-config.json", "/status.json", "/catalog.json", "/announcements.json"]) {
    assert.equal((await asPublic(started, pathname)).text, "portal", pathname);
  }
  for (const [method, pathname] of [["POST", "/v1/chat/completions"], ["GET", "/v1/models"], ["POST", "/anthropic/v1/messages"], ["POST", "/v1/messages"], ["GET", "/vllm/v1/models"], ["POST", "/llama/v1/completions"],
    ["POST", "/gateway/auto/openai/v1/chat/completions"], ["POST", "/gateway/qwen-vllm/claude/v1/messages"], ["GET", "/gateway/external/my-api/openai/v1/models"], ["GET", "/gateway/status"], ["GET", "/gateway/me"], ["POST", "/gateway/tts/openai/v1/audio/speech"], ["POST", "/v1/audio/speech"]]) {
    assert.equal((await asPublic(started, pathname, { method, body: method === "POST" ? {} : undefined })).text, "key", `${method} ${pathname}`);
  }
  assert.ok(reached.includes("key:POST /v1/chat/completions -> /gateway/auto/openai/v1/chat/completions"));
  assert.ok(reached.includes("key:POST /anthropic/v1/messages -> /gateway/auto/claude/v1/messages"));
  assert.ok(reached.includes("key:POST /v1/audio/speech -> /gateway/tts/openai/v1/audio/speech"));
  const before = reached.length;
  for (const [method, pathname] of [["POST", "/"], ["GET", "/v2/models"], ["GET", "/gateway/tts/openai/v1/voices"], ["GET", "/gateway/health/../mcp"], ["GET", "/assets/x/../../server.js"], ["GET", "/docs/a.md"], ["GET", "//api/status"]]) {
    assert.equal((await asPublic(started, pathname, { method, body: method === "POST" ? {} : undefined })).status, 404, `${method} ${pathname}`);
  }
  assert.equal(reached.length, before, "unlisted paths reach no handler");
});

test("classifyPublicRoute is exhaustive for the table of 05 §3.2", () => {
  assert.equal(classifyPublicRoute("GET", "/healthz").kind, "healthz");
  assert.equal(classifyPublicRoute("POST", "/healthz").kind, "not_found");
  assert.equal(classifyPublicRoute("GET", "/gateway/search/v1/x").kind, "not_found");
  assert.equal(classifyPublicRoute("GET", "/gateway/mcp").kind, "not_found");
  assert.equal(classifyPublicRoute("POST", "/gateway/tts/openai/v1/audio/speech").kind, "key");
  assert.equal(classifyPublicRoute("GET", "/gateway/tts/api/voices").kind, "not_found");
  assert.equal(classifyPublicRoute("POST", "/v1/rerank").kind, "key");
  assert.equal(gatewayPathFor("/vllm/v1/models"), "/gateway/vllm/openai/v1/models");
  assert.equal(gatewayPathFor("/llama/v1/chat/completions"), "/gateway/llama/openai/v1/chat/completions");
  assert.equal(gatewayPathFor("/anthropic/v1/models"), "/gateway/auto/claude/v1/models");
});

test("without a key, PUBLIC key routes fail closed through the entry's gateway code", async (t) => {
  const started = await boot(t);
  for (const [method, pathname] of [["POST", "/v1/chat/completions"], ["GET", "/v1/models"], ["GET", "/gateway/status"]]) {
    const answer = await asPublic(started, pathname, { method, body: method === "POST" ? { model: "auto", messages: [] } : undefined });
    assert.ok([401, 503].includes(answer.status), `${method} ${pathname} -> ${answer.status}`);
    assert.equal(answer.headers["access-control-allow-origin"], undefined);
    assert.equal(answer.headers["access-control-allow-credentials"], undefined);
  }
  // A key-less caller is not rescued by a loopback socket or a forged cookie.
  const forged = await asPublic(started, "/v1/models", { headers: { cookie: "lai_admin=forged", "x-forwarded-for": "127.0.0.1" } });
  assert.ok([401, 503].includes(forged.status));
});

test("PUBLIC deletes the cookie header before any handler sees it", async (t) => {
  const seen = [];
  const gateway = (req, res) => { seen.push({ cookie: req.headers.cookie, hasCookieRaw: req.rawHeaders.some((name) => name.toLowerCase() === "cookie") }); res.end("ok"); };
  const portal = { handle: (req, res) => { seen.push({ cookie: req.headers.cookie }); res.end("ok"); return true; } };
  const started = await boot(t, { publicHandler: loaded.entry.createPublicHandler({ gateway, portal }) });
  await asPublic(started, "/v1/models", { headers: { cookie: "lai_admin=secret-session" } });
  await asPublic(started, "/", { headers: { cookie: "lai_admin=secret-session" } });
  assert.equal(seen.length, 2);
  assert.equal(seen.every((item) => item.cookie === undefined), true);
  // The PUBLIC answers never set one.
  const answer = await asPublic(started, "/healthz", { headers: { cookie: "lai_admin=secret-session" } });
  assert.equal(answer.headers["set-cookie"], undefined);
});

test("the public host is rejected on ADMIN with 403 host_not_allowed and admitted on PUBLIC", async (t) => {
  const readSection = (name) => core.platform.readSection(name, { aiRoot: fs.mkdtempSync(path.join(os.tmpdir(), "listeners-host-")), env: { SERVICE_ENTRY_PUBLIC_BASE_URL: "https://models.example.com", SERVICE_ENTRY_ALLOWED_HOSTS: "relay.example.com" } });
  const security = createEntrySecurity({ host: "127.0.0.1", managers: [], readSection });
  const started = await boot(t, { publicHandler: loaded.entry.createPublicHandler({ security }) });

  const onAdmin = await asAdmin(started, "/gateway/health", { headers: { host: "models.example.com" } });
  assert.equal(onAdmin.status, 403);
  assert.equal(onAdmin.json.code, "host_not_allowed");
  for (const host of ["models.example.com", "relay.example.com:443", "localhost:5186", "host.docker.internal:5186", "127.0.0.1:5186"]) {
    assert.equal((await asPublic(started, "/healthz", { headers: { host } })).status, 200, host);
  }
  for (const host of ["evil.example.com", "192.168.0.10", "[::1]:5186"]) {
    const answer = await asPublic(started, "/healthz", { headers: { host } });
    assert.equal(answer.status, 421, host);
    assert.equal(answer.json.error.code, "host_not_allowed");
    assert.doesNotMatch(answer.text, /models\.example\.com|5186|127\.0\.0\.1/, "no allowlist detail is echoed");
  }
});

test("content negotiation: a browser gets an HTML 404 on PUBLIC, an API client gets JSON", async (t) => {
  const started = await boot(t);
  const browser = await asPublic(started, "/nowhere", { headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(browser.status, 404);
  assert.match(browser.headers["content-type"], /text\/html/);
  const api = await asPublic(started, "/v1/nowhere-else-is-a-key-route-so-use-api", { headers: { accept: "application/json" } });
  assert.ok(api.status === 404 || api.status === 401 || api.status === 503);
  const client = await asPublic(started, "/nowhere", { headers: { accept: "application/json" } });
  assert.equal(client.status, 404);
  assert.match(client.headers["content-type"], /application\/json/);
  assert.equal(client.json.error.code, "not_found");
});

test("ADMIN plus a forwarded header: 404 on non-gateway paths with an event, /gateway/health still served", async (t) => {
  const { entry } = loaded;
  const events = [];
  entry.security.setEventSink((event) => events.push(event));
  t.after(() => entry.security.setEventSink(null));
  const started = await boot(t);

  const blocked = await asAdmin(started, "/api/status", { headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(blocked.status, 404);
  assert.equal(blocked.json.code, "public_proxy_gateway_only");
  const event = events.find((item) => item.kind === "admin_via_proxy" && item.pathClass === "admin");
  assert.ok(event, "admin_via_proxy was emitted");
  assert.deepEqual(event.headers, ["x-forwarded-for"]);
  assert.equal(JSON.stringify(events).includes("203.0.113.9"), false, "header values stay out of events");

  const health = await asAdmin(started, "/gateway/health", { headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(health.status, 200);
  // Without a forwarded header nothing is emitted.
  const before = events.length;
  assert.equal((await asAdmin(started, "/gateway/health")).status, 200);
  assert.equal(events.length, before);
});

test("admin.legacyProxyGateway: serve keeps a keyed gateway path working, reject answers 421 use_public_listener", async (t) => {
  const { entry } = loaded;
  const events = [];
  entry.security.setEventSink((event) => events.push(event));
  const original = entry.security.accessConfig;
  t.after(() => {
    entry.security.accessConfig = original;
    entry.security.setEventSink(null);
  });
  const started = await boot(t);
  const forwarded = { "x-forwarded-for": "203.0.113.9" };

  // serve (the schema default): the request reaches the gateway code, which
  // requires a key for a forwarded caller and so refuses this one.
  assert.equal(original().admin.legacyProxyGateway, "serve");
  const served = await asAdmin(started, "/gateway/auto/openai/v1/models", { headers: forwarded });
  assert.ok([401, 503].includes(served.status), `served status ${served.status}`);
  assert.ok(events.some((item) => item.kind === "admin_via_proxy" && item.pathClass === "gateway" && item.outcome === "served_legacy"));

  entry.security.accessConfig = () => {
    const config = original();
    return Object.freeze({ ...config, admin: Object.freeze({ ...config.admin, legacyProxyGateway: "reject" }) });
  };
  for (const pathname of ["/gateway/auto/openai/v1/models", "/gateway/health"]) {
    const rejected = await asAdmin(started, pathname, { headers: forwarded });
    assert.equal(rejected.status, 421, pathname);
    assert.equal(rejected.json.code, "use_public_listener");
  }
  assert.ok(events.some((item) => item.outcome === "use_public_listener"));
  // A direct (header-less) caller is not affected by the setting.
  assert.equal((await asAdmin(started, "/gateway/health")).status, 200);
});

test("close() stops both servers", async (t) => {
  const started = await boot(t);
  await started.close();
  assert.equal(started.admin.listening, false);
  assert.equal(started.public.listening, false);
  await assert.rejects(request(adminPort(started), "/gateway/health"));
});

test("createPublicServer tags requests as public", async (t) => {
  const { entry } = loaded;
  const server = entry.createPublicServer({ gateway: (req, res) => res.end(JSON.stringify(req.listener)) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const answer = await request(server.address().port, "/v1/models", { headers: { host: "127.0.0.1" } });
  assert.deepEqual(answer.json, { kind: "public", lanBound: false });
  assert.ok(server instanceof http.Server);
});

// ---- the key flow (05 §17.2 items 4-8, PUB-12) ------------------------------------

// Two fake managers on the ports the entry read at load. They answer the
// catalog, advertise hop v2 and record every proxied request; a chat request
// waits for release while `hold` is set.
const CORS_ORIGIN = "https://app.example.com";
const upstream = { hits: [], held: [], hold: false, servers: [], ready: false };

test.after(async () => {
  upstream.hold = false;
  while (upstream.held.length) upstream.held.shift()();
  for (const server of upstream.servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

function fakeManager(managerId, models) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ instances: [{ id: "primary", primary: true, running: true, status: "running", models }] }));
    }
    if (url.pathname === "/api/manager/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, gatewayTrust: { version: 2, mode: "warn" } }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstream.hits.push({ manager: managerId, method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "cmpl-test", choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
      };
      if (upstream.hold && url.pathname.endsWith("/chat/completions")) upstream.held.push(answer);
      else answer();
    });
    return undefined;
  });
}

async function withFleet(t) {
  const { entry } = loaded;
  if (!upstream.ready) {
    const vllm = fakeManager("vllm", [{ id: "qwen-chat" }]);
    const llama = fakeManager("llama", [{ id: "gemma-gguf" }]);
    await new Promise((resolve) => vllm.listen(Number(process.env.VLLM_MANAGER_PORT), "127.0.0.1", resolve));
    await new Promise((resolve) => llama.listen(Number(process.env.LLAMA_MANAGER_PORT), "127.0.0.1", resolve));
    upstream.servers.push(vllm, llama);
    upstream.ready = true;
  }
  for (const id of ["vllm", "llama"]) await entry.getManagerModelCatalog(entry.findManager(id), { force: true });
  entry.resetManagerTrustCache();
  entry.resetEntryRateLimitBuckets();
  t.after(() => {
    upstream.hold = false;
    while (upstream.held.length) upstream.held.shift()();
  });
}

let listenerKeySeq = 0;
function makeKey(input = {}) {
  listenerKeySeq += 1;
  const { key, secret } = loaded.entry.getAccessStore().createKey({
    class: "friend",
    models: ["*"],
    scopes: ["models.read", "chat", "messages"],
    ...input,
    name: `listeners key ${listenerKeySeq}`,
  }, { actor: "test" });
  return { id: key.id, secret };
}

const withKey = (key, headers = {}) => ({ authorization: `Bearer ${key.secret}`, ...headers });
const chatBody = (body = {}) => ({ model: "qwen-chat", messages: [{ role: "user", content: "hi" }], ...body });
const waitFor = async (check, label) => {
  for (let index = 0; index < 300; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("a PUBLIC request with a key reaches the fake manager with a signed v2 principal and context, without the key (05 §17.2 item 4)", async (t) => {
  await withFleet(t);
  const { entry } = loaded;
  const started = await boot(t);
  const key = makeKey({ limits: { maxOutputTokens: 64, maxConcurrent: 3 } });
  const before = upstream.hits.length;
  const answer = await asPublic(started, "/v1/chat/completions", {
    method: "POST",
    body: chatBody(),
    headers: withKey(key, { "user-agent": "openai-python/1.50.0", "x-title": "Open WebUI", "x-api-key": key.secret, "api-key": key.secret, "x-service-entry-principal": "forged", "x-service-entry-context": "v1.forged" }),
  });
  assert.equal(answer.status, 200, answer.text);
  const hit = upstream.hits.slice(before).find((item) => item.url === "/serve/v1/chat/completions");
  assert.ok(hit, "the request reached the fake manager");
  assert.equal(hit.manager, "vllm");
  for (const name of ["authorization", "x-api-key", "api-key", "anthropic-api-key"]) assert.equal(hit.headers[name], undefined, `${name} never reaches a v2 manager`);
  assert.doesNotMatch(JSON.stringify(hit.headers), new RegExp(key.secret.slice(-12)), "the key is nowhere in the hop");
  assert.equal(hit.headers["x-request-id"], answer.headers["x-request-id"], "the request id of the hop is the one the client got");
  assert.match(hit.headers["x-request-id"], /^req_[a-z2-7]{20}$/);

  const token = entry.security.getTrustToken();
  const hop = { method: "POST", originalUrl: hit.url, headers: hit.headers, socket: { remoteAddress: "127.0.0.1" } };
  const verified = core.verifyEntryRequest(hop, { token });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.version, 2);
  assert.equal(verified.requestId, answer.headers["x-request-id"]);
  assert.equal(verified.principal.k, key.id);
  assert.equal(verified.principal.l, "public");
  assert.equal(verified.principal.p, "key");
  assert.equal(verified.principal.mo, 64);
  assert.equal(verified.principal.mc, 3);
  assert.ok(verified.context, "the context travels on the hop");
  assert.equal(verified.context.v, 1);
  assert.equal(verified.context.src, "openwebui", "the source program from the client hint");
  assert.equal(JSON.stringify(verified.context).includes(key.secret), false);
  assert.notEqual(hit.headers["x-service-entry-principal"], "forged");
  assert.notEqual(hit.headers["x-service-entry-context"], "v1.forged");
  // The context is covered by the signature: swapping it fails the hop.
  const swapped = core.verifyEntryRequest({ ...hop, headers: { ...hit.headers, "x-service-entry-context": `v1.${Buffer.from(JSON.stringify({ v: 1, src: "curl" })).toString("base64url")}` } }, { token });
  assert.equal(swapped.ok, false);
  // The body is the client's, plus the cap.
  assert.deepEqual(JSON.parse(hit.body), { model: "qwen-chat", messages: [{ role: "user", content: "hi" }], max_tokens: 64 });
});

test("rate-limit headers are present, and rpm, tpm, quota and concurrency refuse with four distinct codes (item 5)", async (t) => {
  await withFleet(t);
  const started = await boot(t);
  const post = (key, body = chatBody()) => asPublic(started, "/v1/chat/completions", { method: "POST", body, headers: withKey(key) });

  // rpm
  const rpmKey = makeKey({ limits: { rpm: 2, tpm: null, maxOutputTokens: 16 } });
  const first = await post(rpmKey);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers["x-ratelimit-limit-requests"], "2");
  assert.equal(first.headers["x-ratelimit-remaining-requests"], "1");
  assert.match(first.headers["x-ratelimit-reset-requests"], /^\d+s$/);
  assert.equal((await post(rpmKey)).status, 200);
  const rpm = await post(rpmKey);
  assert.equal(rpm.status, 429);
  assert.equal(rpm.json.error.code, "rate_limit_exceeded");
  assert.ok(Number(rpm.headers["retry-after"]) >= 1);
  assert.equal(rpm.headers["x-ratelimit-remaining-requests"], "0");

  // tpm: the first request holds its reservation while it runs.
  upstream.hold = true;
  const tpmKey = makeKey({ limits: { rpm: 100, tpm: 700, maxOutputTokens: 600, maxConcurrent: 5 } });
  const running = post(tpmKey);
  await waitFor(() => upstream.held.length === 1, "the first request upstream");
  const tpm = await post(tpmKey);
  assert.equal(tpm.status, 429);
  assert.equal(tpm.json.error.code, "tokens_rate_limit_exceeded");
  assert.equal(tpm.headers["x-ratelimit-limit-tokens"], "700");
  assert.ok(Number(tpm.headers["retry-after"]) >= 1);
  upstream.hold = false;
  while (upstream.held.length) upstream.held.shift()();
  assert.equal((await running).status, 200);

  // quota: one request a day.
  const quotaKey = makeKey({ limits: { rpm: 100, tpm: null, dailyRequests: 1, maxOutputTokens: 16 } });
  assert.equal((await post(quotaKey)).status, 200);
  await waitFor(() => loaded.entry.getAccessStore().getUsage(quotaKey.id).day?.requests === 1, "the counters");
  const quota = await post(quotaKey);
  assert.equal(quota.status, 429);
  assert.equal(quota.json.error.code, "insufficient_quota");
  assert.equal(quota.json.error.param, "daily_requests");
  assert.ok(Number(quota.headers["retry-after"]) >= 1);

  // concurrency: one at a time, no queue.
  upstream.hold = true;
  const concurrencyKey = makeKey({ limits: { rpm: 100, tpm: null, maxConcurrent: 1, maxQueued: 0, maxOutputTokens: 16 } });
  const busy = post(concurrencyKey);
  await waitFor(() => upstream.held.length === 1, "the busy request upstream");
  const concurrency = await post(concurrencyKey);
  assert.equal(concurrency.status, 429);
  assert.equal(concurrency.json.error.code, "concurrency_limit_exceeded");
  assert.match(concurrency.headers["x-ratelimit-limit-requests"], /^\d+$/, "the headers ride on the refusal too");
  upstream.hold = false;
  while (upstream.held.length) upstream.held.shift()();
  assert.equal((await busy).status, 200);
  // The slot is free again.
  assert.equal((await post(concurrencyKey)).status, 200);

  const codes = [rpm, tpm, quota, concurrency].map((answer) => answer.json.error.code);
  assert.equal(new Set(codes).size, 4, `distinct codes: ${codes.join(", ")}`);
  for (const answer of [rpm, tpm, quota, concurrency]) assert.equal(answer.json.error.type, answer.json.error.code === "insufficient_quota" ? "insufficient_quota" : "rate_limit_error");
});

test("CORS: the preflight and the actual request follow the key's origins and never carry credentials (item 6)", async (t) => {
  await withFleet(t);
  const started = await boot(t);
  const key = makeKey({ allowedOrigins: [CORS_ORIGIN], limits: { maxOutputTokens: 16 } });
  const plain = makeKey({ limits: { maxOutputTokens: 16 } });

  const preflight = await asPublic(started, "/v1/chat/completions", {
    method: "OPTIONS",
    headers: { origin: CORS_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, x-stainless-lang" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], CORS_ORIGIN);
  assert.match(preflight.headers["access-control-allow-methods"], /POST/);
  assert.match(preflight.headers["access-control-allow-headers"], /x-stainless-lang/);
  assert.equal(preflight.headers.vary, "Origin");
  const strangerPreflight = await asPublic(started, "/v1/chat/completions", { method: "OPTIONS", headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" } });
  assert.equal(strangerPreflight.status, 204);
  assert.equal(strangerPreflight.headers["access-control-allow-origin"], undefined);
  assert.equal(strangerPreflight.headers["access-control-allow-methods"], undefined);

  const actual = await asPublic(started, "/v1/chat/completions", { method: "POST", body: chatBody(), headers: withKey(key, { origin: CORS_ORIGIN }) });
  assert.equal(actual.status, 200, actual.text);
  assert.equal(actual.headers["access-control-allow-origin"], CORS_ORIGIN);
  assert.match(actual.headers["access-control-expose-headers"], /x-request-id/);
  assert.match(actual.headers["access-control-expose-headers"], /x-ratelimit-/);
  const foreign = await asPublic(started, "/v1/chat/completions", { method: "POST", body: chatBody(), headers: withKey(key, { origin: "https://evil.example.com" }) });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.error.code, "origin_not_allowed");
  assert.equal(foreign.headers["access-control-allow-origin"], undefined);
  const noOrigins = await asPublic(started, "/v1/chat/completions", { method: "POST", body: chatBody(), headers: withKey(plain, { origin: CORS_ORIGIN }) });
  assert.equal(noOrigins.status, 403, "a key with no origins serves no browser");

  for (const answer of [preflight, strangerPreflight, actual, foreign, noOrigins]) {
    assert.equal(answer.headers["access-control-allow-credentials"], undefined);
    assert.equal(answer.headers["access-control-allow-private-network"], undefined);
  }
});

test("a browser Accept on an unknown or API PUBLIC path gets an HTML page; an API client gets JSON (item 7)", async (t) => {
  const started = await boot(t);
  const html = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  for (const pathname of ["/nowhere", "/v1/nowhere", "/anthropic/v1/nowhere", "/vllm/v1/files"]) {
    const browser = await asPublic(started, pathname, { headers: html });
    assert.equal(browser.status, 404, pathname);
    assert.match(browser.headers["content-type"], /text\/html/, pathname);
    assert.match(browser.text, /req_[a-z2-7]{20}/, "the page quotes the request id");
    const client = await asPublic(started, pathname, { headers: { accept: "application/json" } });
    assert.equal(client.status, 404, pathname);
    assert.match(client.headers["content-type"], /application\/json/);
    if (pathname.startsWith("/anthropic/")) {
      assert.equal(client.json.type, "error");
      assert.equal(client.json.error.type, "not_found_error");
    } else {
      assert.equal(client.json.error.code, "not_found");
    }
    assert.equal(client.json.request_id, client.headers["x-request-id"]);
  }
  // An API path with a wrong method, and an Anthropic one, in their own shapes.
  const wrong = await asPublic(started, "/v1/chat/completions", { headers: html });
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers["content-type"], /text\/html/);
  const wrongJson = await asPublic(started, "/anthropic/v1/messages", { headers: { accept: "application/json" } });
  assert.equal(wrongJson.status, 405);
  assert.equal(wrongJson.json.type, "error");
  // A request that carries a key header is an API client whatever it accepts.
  const keyed = await asPublic(started, "/v1/nowhere", { headers: { ...html, authorization: "Bearer sk-plat-fake" } });
  assert.match(keyed.headers["content-type"], /application\/json/);
});

test("signed system principals on ADMIN: the supervisor may stop a manager, an unsigned caller may not, hub-shim is out of scope (item 8)", async (t) => {
  const { entry } = loaded;
  const internalAuth = require("../../manager-core/internal-auth");
  const seen = [];
  // The shutdown route is a spy: nothing is stopped.
  const spy = {
    name: "shutdown-spy",
    mount(ctx) {
      return {
        async handle(req, res, url) {
          if (req.method !== "POST" || url.pathname !== "/api/manager/shutdown") return false;
          const who = ctx.auth.principal(req);
          seen.push({ role: who.role, principal: who.principal });
          ctx.sendJson(res, { ok: true });
          return true;
        },
      };
    },
  };
  const ctx = entry.createRouteContext({ logger: { log() {}, warn() {}, error() {} } });
  const routes = await entry.mountRouteModules({ ctx, modules: [...entry.ROUTE_MODULES, spy] });
  t.after(() => routes.close());
  const started = await boot(t, { adminHandler: (req, res) => entry.handleRequest(req, res, routes) });
  const token = entry.security.getTrustToken();
  const target = "/api/manager/shutdown";
  const signedAs = (principal) => asAdmin(started, target, {
    method: "POST",
    body: "{}",
    headers: internalAuth.buildMachineHeaders(token, { method: "POST", pathWithQuery: target, principal, body: "{}", now: Date.now() }),
  });

  const supervisor = await signedAs("system:supervisor");
  assert.equal(supervisor.status, 200, supervisor.text);
  assert.deepEqual(seen, [{ role: "system", principal: "system:supervisor" }]);

  const unsigned = await asAdmin(started, target, { method: "POST", body: {} });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.json.error.code, "admin_session_required");

  const shim = await signedAs("system:hub-shim:vllm");
  assert.equal(shim.status, 403);
  assert.equal(shim.json.error.code, "principal_scope_denied");
  assert.equal(seen.length, 1, "only the supervisor's call reached the route");
});
