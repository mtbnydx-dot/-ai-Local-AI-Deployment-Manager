"use strict";

// The structural part of 05 §17.2 (PUB-6): two listeners, the PUBLIC route
// table, the Host rules and the ADMIN forwarded-header policy. Everything
// runs on port 0 over loopback; no upstream is reachable (entry-harness points
// every manager port at a closed one). The key flow (a v2 principal reaching a
// fake manager, limits, CORS) belongs to the packages that build the pipeline.

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
