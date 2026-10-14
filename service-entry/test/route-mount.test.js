"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// The route-mount table (07 §2.7). Every upstream port the entry knows points
// at a port nothing listens on, so no request can reach a real local service.
// The entry reads its ports when it is loaded, which is why setup() runs
// before require("../server").
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

let entry = null;
let tempDir = "";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function setup() {
  if (entry) return entry;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-route-mount-"));
  for (const name of CLEARED_ENV) delete process.env[name];
  for (const name of ["VLLM_MANAGER_PORT", "LLAMA_MANAGER_PORT", "TTS_GATEWAY_PORT", "SEARCH_GATEWAY_PORT", "PLATFORM_MCP_PORT"]) {
    process.env[name] = String(await unusedPort());
  }
  // Long caches keep the two servers' answers comparable call to call.
  process.env.SERVICE_ENTRY_STATUS_CACHE_MS = "600000";
  process.env.SERVICE_ENTRY_MODEL_CACHE_MS = "600000";
  process.env.MODEL_ACCESS_STATS_CACHE_MS = "600000";
  process.env.PLATFORM_MCP_ENV_FILE = path.join(tempDir, "platform-mcp.env");
  process.env.AI_BILLING_DB = path.join(tempDir, "billing.sqlite");
  entry = require("../server");
  entry.setEntryGatewayAccessSink(async () => {});
  return entry;
}

test.after(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function quietLogger() {
  const lines = [];
  return { lines, log: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
}

async function startEntry(t, routes = null) {
  const server = entry.createServiceEntryServer(routes ? { routes } : {});
  const port = await listen(server);
  t.after(() => new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return { server, port };
}

function raw(port, pathname, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

function openStream(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (response) => {
      response.setEncoding("utf8");
      const stream = { status: response.statusCode, text: "", ended: false, close: () => request.destroy() };
      const waiters = new Set();
      stream.waitFor = (predicate, timeoutMs = 2000) => new Promise((done, fail) => {
        const check = () => {
          if (!predicate(stream)) return false;
          waiters.delete(check);
          clearTimeout(timer);
          done(stream);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          fail(new Error(`timed out; stream so far: ${stream.text}`));
        }, timeoutMs);
        if (!check()) waiters.add(check);
      });
      response.on("data", (chunk) => {
        stream.text += chunk;
        for (const check of [...waiters]) check();
      });
      response.on("end", () => {
        stream.ended = true;
        for (const check of [...waiters]) check();
      });
      resolve(stream);
    });
    request.on("error", reject);
  });
}

function fakeRequest(pathname, method = "GET") {
  const url = new URL(pathname, "http://127.0.0.1:5176");
  const req = { method, url: pathname, headers: { host: "127.0.0.1:5176" }, socket: { remoteAddress: "127.0.0.1" }, on() {} };
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, write() {}, end() {}, on() {}, once() {} };
  return [req, res, url];
}

function jsonModule(name, claims, options = {}) {
  const seen = [];
  return {
    seen,
    closed: 0,
    name,
    ...(options.feature ? { feature: options.feature } : {}),
    mount(ctx) {
      const definition = this;
      return {
        async handle(req, res, url) {
          seen.push(url.pathname);
          if (!claims.includes(url.pathname)) return false;
          ctx.sendJson(res, { ok: true, module: name, path: url.pathname });
          return true;
        },
        close() {
          definition.closed += 1;
        },
      };
    },
  };
}

test("ROUTE_MODULES starts with the event bus and every entry is a route module", async () => {
  await setup();
  assert.equal(entry.ROUTE_MODULES[0], "./lib/events");
  for (const spec of entry.ROUTE_MODULES) {
    const definition = require(path.join(__dirname, "..", spec));
    assert.equal(typeof definition.mount, "function", spec);
    assert.equal(typeof definition.name, "string", spec);
  }
  assert.equal(entry.getRouteMounts(), null, "nothing is mounted until startServiceEntry() runs");
});

test("modules run in table order and the first one that answers wins", async (t) => {
  await setup();
  const first = jsonModule("first", ["/api/shared"], { feature: "alpha" });
  const second = jsonModule("second", ["/api/shared", "/api/second"], { feature: "beta" });
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx, modules: [first, second] });
  assert.deepEqual(routes.modules.map((item) => item.name), ["first", "second"]);
  assert.deepEqual(ctx.features, { alpha: true, beta: true });
  const { port } = await startEntry(t, routes);

  const shared = await raw(port, "/api/shared");
  assert.equal(JSON.parse(shared.body).module, "first");
  assert.equal(second.seen.includes("/api/shared"), false, "a later module never sees a claimed request");
  const own = await raw(port, "/api/second");
  assert.equal(JSON.parse(own.body).module, "second");
  assert.deepEqual(first.seen, ["/api/shared", "/api/second"]);

  // Declined paths fall through to the inline routes unchanged.
  const status = await raw(port, "/api/security");
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).security.exposure, "local");
});

test("a module that cannot mount is skipped with one log line and the others work", async (t) => {
  await setup();
  const logger = quietLogger();
  const ctx = entry.createRouteContext({ logger });
  const healthy = jsonModule("healthy", ["/api/healthy"], { feature: "healthy" });
  const routes = await entry.mountRouteModules({
    ctx,
    modules: [
      { name: "explodes", feature: "explodes", mount() { throw new Error("cannot open store"); } },
      "./lib/does-not-exist",
      { name: "handleless", mount: () => ({}) },
      { name: "async-fails", feature: "later", mount: async () => { throw new Error("async boom"); } },
      healthy,
    ],
  });
  assert.deepEqual(routes.modules.map((item) => item.name), ["healthy"]);
  assert.deepEqual(routes.failed.map((item) => item.name), ["explodes", "./lib/does-not-exist", "handleless", "async-fails"]);
  assert.deepEqual(ctx.features, { explodes: false, later: false, healthy: true });
  assert.equal(logger.lines.length, 4);
  for (const name of ["explodes", "does-not-exist", "handleless", "async-fails"]) {
    assert.equal(logger.lines.filter((line) => line.includes(name)).length, 1, name);
  }
  const { port } = await startEntry(t, routes);
  assert.equal(JSON.parse((await raw(port, "/api/healthy")).body).module, "healthy");
});

test("feature flags follow mounting for the real table", async () => {
  await setup();
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx });
  assert.equal(routes.failed.length, 0, JSON.stringify(routes.failed));
  assert.equal(ctx.features.events, true);
  assert.equal(ctx.relay, null, "no relay until ENT-EV3 is mounted");
  assert.deepEqual(ctx.managers.map((manager) => manager.id), ["vllm", "llama"]);
  for (const key of ["rootDir", "aiRoot", "security", "auth", "bus", "sendJson", "readJsonObjectBody", "logger", "now"]) {
    assert.ok(ctx[key], key);
  }
  routes.close();
});

test("no module answers /gateway/*", async (t) => {
  await setup();
  const routes = await entry.mountRouteModules({ ctx: entry.createRouteContext({ logger: quietLogger() }) });
  t.after(() => routes.close());
  for (const mounted of routes.modules) {
    assert.equal(await mounted.api.handle(...fakeRequest("/gateway/x")), false, mounted.name);
    assert.equal(await mounted.api.handle(...fakeRequest("/gateway/x", "POST")), false, mounted.name);
  }

  // The server never offers a /gateway/ request to a module at all.
  const greedy = {
    name: "greedy",
    seen: [],
    mount(ctx) {
      return {
        handle: async (req, res, url) => {
          greedy.seen.push(url.pathname);
          ctx.sendJson(res, { greedy: true });
          return true;
        },
      };
    },
  };
  const greedyRoutes = await entry.mountRouteModules({ ctx: entry.createRouteContext({ logger: quietLogger() }), modules: [greedy] });
  const { port } = await startEntry(t, greedyRoutes);
  const health = await raw(port, "/gateway/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).service, "local-ai-gateway");
  assert.deepEqual(greedy.seen, []);
  assert.equal(JSON.parse((await raw(port, "/api/anything")).body).greedy, true);
});

test("the host, origin and proxied-request guards run before any module", async (t) => {
  await setup();
  const probe = jsonModule("probe", ["/api/events", "/api/probe"]);
  const routes = await entry.mountRouteModules({ ctx: entry.createRouteContext({ logger: quietLogger() }), modules: [probe] });
  const { port } = await startEntry(t, routes);

  const badHost = await raw(port, "/api/probe", { headers: { host: "evil.example.com" } });
  assert.equal(badHost.status, 403);
  assert.equal(JSON.parse(badHost.body).code, "host_not_allowed");
  const crossSite = await raw(port, "/api/probe", { method: "POST", headers: { origin: "https://evil.example.com" } });
  assert.equal(crossSite.status, 403);
  assert.equal(JSON.parse(crossSite.body).code, "origin_not_allowed");
  const proxied = await raw(port, "/api/probe", { headers: { "x-forwarded-for": "203.0.113.5" } });
  assert.equal(proxied.status, 404);
  assert.equal(JSON.parse(proxied.body).code, "public_proxy_gateway_only");
  assert.deepEqual(probe.seen, []);
});

test("a module whose handler throws gets a 500 envelope and the entry keeps serving", async (t) => {
  await setup();
  const errors = t.mock.method(console, "error", () => {});
  const broken = { name: "broken", mount: () => ({ handle: async (req, res, url) => { if (url.pathname === "/api/broken") throw new Error("handler bug"); return false; } }) };
  const routes = await entry.mountRouteModules({ ctx: entry.createRouteContext({ logger: quietLogger() }), modules: [broken] });
  const { port } = await startEntry(t, routes);
  const response = await raw(port, "/api/broken");
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: { code: "internal_error", message: "Service entry error." } });
  assert.equal(response.body.includes("handler bug"), false);
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes("route module broken failed")));
  assert.equal((await raw(port, "/api/security")).status, 200);
});

// Fields that legitimately differ between two calls of the same route.
function normalizeVolatile(text) {
  return text
    .replace(/"uptimeSeconds":[0-9.e+-]+/g, '"uptimeSeconds":0')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<time>");
}

test("legacy routes are byte-identical with every module mounted", async (t) => {
  await setup();
  const plain = await startEntry(t);
  const routes = await entry.mountRouteModules({ ctx: entry.createRouteContext({ logger: quietLogger() }) });
  assert.ok(routes.modules.length >= 1);
  const mounted = await startEntry(t, routes);
  const routesToCompare = [
    "/api/status",
    "/api/fleet",
    "/billing",
    "/api/security",
    "/api/gateway-access",
    "/api/keys",
    "/shared-js/tokens.css",
    "/docs/not-a-doc.md",
    "/api/no-such-route",
  ];
  // Warm the entry's caches once so both servers read the same snapshot.
  for (const pathname of routesToCompare) await raw(plain.port, pathname);
  for (const pathname of routesToCompare) {
    const before = await raw(plain.port, pathname);
    const after = await raw(mounted.port, pathname);
    assert.equal(after.status, before.status, pathname);
    const headers = (response) => {
      const copy = { ...response.headers };
      delete copy.date;
      delete copy["keep-alive"];
      delete copy.connection;
      if (copy["content-length"]) copy["content-length"] = "<len>";
      return copy;
    };
    assert.deepEqual(headers(after), headers(before), pathname);
    // These three stamp the time they were built (updatedAt, uptime).
    const exact = !["/api/status", "/api/fleet", "/api/keys"].includes(pathname);
    if (exact) {
      assert.ok(after.body.equals(before.body), `${pathname} body differs`);
    } else {
      assert.equal(normalizeVolatile(after.body.toString("utf8")), normalizeVolatile(before.body.toString("utf8")), pathname);
    }
  }
  assert.equal((await raw(plain.port, "/api/events")).status, 404, "without the table there is no event route");
});

test("/api/events and /api/events/recent are served through the real entry", async (t) => {
  await setup();
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx });
  const { port } = await startEntry(t, routes);
  const stream = await openStream(port, "/api/events?client=console");
  assert.equal(stream.status, 200);
  assert.equal(ctx.bus.subscriberCount({ client: "console" }), 1);
  const envelope = ctx.bus.publish("status", { reason: "manager_up", managerId: "vllm" });
  await stream.waitFor((s) => s.text.includes(`id: ${envelope.id}\n`));
  assert.ok(stream.text.includes("event: status\n"));
  const recent = await raw(port, "/api/events/recent");
  const body = JSON.parse(recent.body);
  assert.equal(body.ok, true);
  assert.equal(body.lastId, envelope.id);
  assert.equal(body.events[0].data.managerId, "vllm");
  stream.close();
});

test("closing the server closes every module and ends open event streams", async (t) => {
  await setup();
  const tracker = jsonModule("tracker", []);
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  const routes = await entry.mountRouteModules({ ctx, modules: ["./lib/events", tracker] });
  const { server, port } = await startEntry(t, routes);
  const stream = await openStream(port, "/api/events");
  assert.equal(ctx.bus.stats().clients, 1);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server.close() hung on the open stream")), 3000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await stream.waitFor((s) => s.ended);
  assert.equal(tracker.closed, 1);
  assert.equal(ctx.bus.stats().clients, 0);
  assert.equal(ctx.bus.publish("status", { reason: "late" }), null, "the bus is closed with the server");
  routes.close();
  assert.equal(tracker.closed, 1, "close is idempotent");
});
