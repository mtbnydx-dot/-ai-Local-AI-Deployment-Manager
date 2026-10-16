"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const { createEntrySecurity } = require("../lib/security");
const {
  createBuiltinViewerRegistry,
  createRequestAuth,
  redactInstancesEventForViewer,
  redactStatusEventForViewer,
} = require("../lib/request-auth");

const SWITCH_ENV = ["SERVICE_ENTRY_ALLOW_LAN_ADMIN", "SERVICE_ENTRY_REQUIRE_API_KEY", "SERVICE_ENTRY_TRUSTED_PROXIES"];

const cleaned = new WeakSet();

function withCleanEnv(t) {
  if (cleaned.has(t)) return;
  cleaned.add(t);
  const saved = Object.fromEntries(SWITCH_ENV.map((name) => [name, process.env[name]]));
  for (const name of SWITCH_ENV) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function req(remoteAddress, headers = {}, method = "GET") {
  return { method, headers: { host: "127.0.0.1:5176", ...headers }, socket: { remoteAddress } };
}

function quiet() {
  const lines = [];
  return { lines, warn: (line) => lines.push(String(line)) };
}

function seam(t, options = {}) {
  withCleanEnv(t);
  const security = createEntrySecurity({ host: "0.0.0.0", managers: [], getLanAddress: () => "192.168.0.10" });
  return createRequestAuth({ security, logger: quiet(), ...options });
}

// What 05's createViewerRegistry() looks like from the outside: it records
// every call so the replay can be checked argument by argument.
function stubRegistry() {
  const calls = [];
  const record = (method) => (args) => { calls.push({ method, args }); };
  return {
    calls,
    registerRoute: record("registerRoute"),
    registerReadOnlyPost: record("registerReadOnlyPost"),
    registerAdminOnly: record("registerAdminOnly"),
    registerEventType: record("registerEventType"),
    match: (method, pathname) => (pathname === "/api/stub" ? { access: "viewer", entry: { owner: "05", redact: (body) => ({ ...body, stubbed: true }) }, params: {} } : null),
    viewerEventTypes: () => ["status"],
    redactEvent: (type, data) => (type === "status" ? { stub: true } : null),
    inventory: () => calls.map((call) => call.args),
    freeze: () => { calls.push({ method: "freeze" }); },
  };
}

test("legacy matrix: loopback is owner, a LAN-bound entry makes LAN the owner too, SERVICE_ENTRY_ALLOW_LAN_ADMIN=0 makes it a redacting viewer", (t) => {
  const auth = seam(t);
  const defaultLan = req("192.168.0.59");
  assert.deepEqual(auth.principal(defaultLan), { role: "owner", principal: "lan", via: "lan", redact: false }, "a LAN-bound entry: LAN is the owner by default");
  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "0";
  assert.equal(auth.mode, "loopback-trust");

  const local = req("127.0.0.1");
  assert.deepEqual(auth.principal(local), { role: "owner", principal: "loopback", via: "loopback", redact: false });
  assert.deepEqual(auth.checkWrite(local), { ok: true });
  assert.equal(auth.eventTypesFor(auth.principal(local)), "*");

  const lan = req("192.168.0.60");
  assert.deepEqual(auth.principal(lan), { role: "viewer", principal: "lan", via: "lan", redact: true });
  const denied = auth.checkWrite(lan);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "management_local_only");
  assert.deepEqual([...auth.eventTypesFor(auth.principal(lan))].sort(), ["instances", "status"]);

  // Forwarded headers demote even a loopback socket (a reverse proxy).
  const proxied = req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" });
  assert.equal(auth.principal(proxied).role, "viewer");
  assert.equal(auth.principal(proxied).via, "proxy");
  assert.equal(auth.checkWrite(proxied).ok, false);

  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "1";
  const lanAdmin = req("192.168.0.61");
  assert.deepEqual(auth.principal(lanAdmin), { role: "owner", principal: "lan", via: "lan", redact: false });
  assert.deepEqual(auth.checkWrite(lanAdmin), { ok: true });
  assert.equal(auth.eventTypesFor(auth.principal(lanAdmin)), "*");
  assert.equal(auth.eventTypesFor({ role: "none" }).size, 0);
});

test("the principal is decided once per request", (t) => {
  let calls = 0;
  const security = {
    checkManagementAccess: () => {
      calls += 1;
      return { ok: true };
    },
  };
  withCleanEnv(t);
  const auth = createRequestAuth({ security });
  const one = req("127.0.0.1");
  auth.principal(one);
  auth.principal(one);
  assert.equal(calls, 1);
  auth.principal(req("127.0.0.1"));
  assert.equal(calls, 2);
  assert.throws(() => createRequestAuth({}), TypeError);
});

test("the built-in registry matches exact, parameter and prefix paths by specificity", () => {
  const registry = createBuiltinViewerRegistry();
  const redactManagerStatus = (body, ctx) => ({ managerId: ctx.params.managerId, via: ctx.via, state: body.state });
  registry.registerRoute({ owner: "07", path: "/api/fleet" });
  registry.registerRoute({ owner: "07", path: "/api/m/:managerId/status", redact: redactManagerStatus });
  registry.registerAdminOnly({ owner: "07", method: "GET", path: "/api/m/:managerId/*" });
  registry.registerRoute({ owner: "07", path: "/c/*" });
  registry.registerReadOnlyPost({ owner: "05", path: "/api/fleet/route-preview" });

  assert.equal(registry.match("GET", "/api/fleet").access, "viewer");
  assert.equal(registry.match("HEAD", "/api/fleet").access, "viewer", "HEAD follows GET");
  assert.equal(registry.match("POST", "/api/fleet"), null);
  assert.equal(registry.match("GET", "/api/fleet/extra"), null);
  assert.equal(registry.match("GET", "/api/unknown"), null);

  const status = registry.match("GET", "/api/m/vllm/status");
  assert.equal(status.access, "viewer", "the specific entry beats the admin-only wildcard");
  assert.deepEqual(status.params, { managerId: "vllm" });
  assert.equal(status.entry.owner, "07");
  assert.equal(status.entry.redact, redactManagerStatus);

  const config = registry.match("GET", "/api/m/llama/config");
  assert.equal(config.access, "admin");
  assert.deepEqual(config.params, { managerId: "llama", "*": "config" });

  assert.equal(registry.match("GET", "/c/abc123/app.js").access, "viewer");
  assert.equal(registry.match("GET", "/c"), null);
  assert.equal(registry.match("POST", "/api/fleet/route-preview").access, "viewer");

  assert.throws(() => registry.registerRoute({ owner: "07", path: "/api/fleet" }), /already registered/);
  assert.throws(() => registry.registerRoute({ path: "/api/x" }), /owner/);
  assert.throws(() => registry.registerRoute({ owner: "07", path: "api/x" }), /invalid path/);
  assert.throws(() => registry.registerRoute({ owner: "07", path: "/api/x", redact: "nope" }), /redact/);
  assert.equal(registry.inventory().length, 7, "five routes plus the two baseline event types");

  registry.freeze();
  assert.throws(() => registry.registerRoute({ owner: "07", path: "/api/late" }), /frozen/);
  assert.throws(() => registry.registerEventType({ owner: "04", type: "alerts" }), /frozen/);
});

test("the built-in registry carries the status and instances event baseline", () => {
  const logger = quiet();
  const registry = createBuiltinViewerRegistry({ logger });
  assert.deepEqual(registry.viewerEventTypes().sort(), ["instances", "status"]);
  assert.deepEqual(registry.redactEvent("status", { reason: "manager_down", managerId: "vllm", ok: false, offline: ["vllm", 3], error: "C:\\x" }), {
    reason: "manager_down", managerId: "vllm", ok: false, offline: ["vllm"],
  });
  assert.deepEqual(registry.redactEvent("instances", {
    managerId: "vllm", changed: ["a"], removed: ["b"], native: false,
    instances: [{ id: "a", state: "stopped", running: false, port: 8000, argv: ["--api-key", "x"] }],
  }), { managerId: "vllm", changed: ["a"], removed: ["b"], native: false, instances: [{ id: "a", state: "stopped", running: false }] });
  assert.deepEqual(registry.redactEvent("status", { truncated: true }), { truncated: true });
  assert.equal(registry.redactEvent("jobs", { managerId: "vllm", jobs: [] }), null, "unregistered types are dropped");

  registry.registerEventType({ owner: "03", type: "downloads", redact: () => { throw new Error("bug"); } });
  registry.registerEventType({ owner: "04", type: "alerts" });
  assert.equal(registry.redactEvent("downloads", {}), null, "a failing redaction drops the event");
  assert.equal(logger.lines.filter((line) => line.includes("downloads event redaction failed")).length, 1);
  assert.deepEqual(registry.redactEvent("alerts", { action: "firing" }), { action: "firing" }, "no redaction function passes the data");
  assert.deepEqual(registry.viewerEventTypes().sort(), ["alerts", "downloads", "instances", "status"]);

  assert.equal(redactStatusEventForViewer(null), null);
  assert.equal(redactInstancesEventForViewer("x"), null);
  assert.deepEqual(createBuiltinViewerRegistry({ baseline: false }).viewerEventTypes(), []);
});

test("registrations made through the seam are replayed into a stub 05 registry", (t) => {
  const auth = seam(t);
  const redact = (body) => body;
  auth.viewerRegistry.registerRoute({ owner: "07", path: "/api/events/recent" });
  auth.viewerRegistry.registerRoute({ owner: "07", method: "GET", path: "/api/m/:managerId/status", redact });
  auth.viewerRegistry.registerAdminOnly({ owner: "07", method: "POST", path: "/api/m/:managerId/*" });
  auth.viewerRegistry.registerReadOnlyPost({ owner: "07", path: "/api/fleet/route-preview" });
  auth.viewerRegistry.registerEventType({ owner: "03", type: "downloads", redact });

  // A module that kept the registry object at mount time.
  const kept = auth.viewerRegistry;
  const stub = stubRegistry();
  auth.attach({ viewerRegistry: stub });

  assert.deepEqual(stub.calls.map((call) => call.method), [
    "registerRoute", "registerRoute", "registerAdminOnly", "registerReadOnlyPost", "registerEventType",
  ], "same order, baseline left to 05's own PUB-25 registrations");
  assert.deepEqual(stub.calls[0].args, { owner: "07", path: "/api/events/recent" });
  assert.deepEqual(stub.calls[1].args, { owner: "07", method: "GET", path: "/api/m/:managerId/status", redact });
  assert.equal(stub.calls[1].args.redact, redact, "the same redaction function is handed over");
  assert.deepEqual(stub.calls[2].args, { owner: "07", method: "POST", path: "/api/m/:managerId/*" });
  assert.deepEqual(stub.calls[4].args, { owner: "03", type: "downloads", redact });

  // From now on everything goes to 05's registry, through the same object.
  kept.registerRoute({ owner: "01", path: "/api/m/:managerId/engines" });
  assert.equal(stub.calls.at(-1).args.path, "/api/m/:managerId/engines");
  assert.equal(kept.match("GET", "/api/stub").entry.owner, "05");
  assert.deepEqual(kept.viewerEventTypes(), ["status"]);
  kept.freeze();
  assert.equal(stub.calls.at(-1).method, "freeze");

  // With the baseline included, 05 can also adopt the seam's event baseline.
  const withBaseline = seam(t);
  const second = stubRegistry();
  withBaseline.attach({ viewerRegistry: second, includeBaseline: true });
  assert.deepEqual(second.calls.map((call) => call.args.type), ["status", "instances"]);

  // Passing 05's registry at creation replays the same way.
  const builtin = createBuiltinViewerRegistry();
  builtin.registerRoute({ owner: "07", path: "/api/events" });
  const third = stubRegistry();
  withCleanEnv(t);
  createRequestAuth({ security: createEntrySecurity({ host: "127.0.0.1", managers: [] }), builtinRegistry: builtin, viewerRegistry: third });
  assert.deepEqual(third.calls.map((call) => call.args.path), ["/api/events"]);
});

test("with a stub 05 adminAuth, role, write check and event types come from it", (t) => {
  const seen = { authenticate: 0, write: [] };
  const adminAuth = {
    authenticate(request) {
      seen.authenticate += 1;
      if (request.headers.cookie === "lai_admin=good") return { role: "owner", principal: "session:abcd1234", via: "session", sessionId: "abcd1234", redact: false };
      if (request.headers["x-ai-internal-principal"]) return { role: "system", principal: "system:supervisor", via: "hmac", redact: false };
      // 00 §9.8: a loopback caller without a session is a viewer.
      return { role: "viewer", principal: "", via: "loopback", redact: true };
    },
    checkManagementAccess(request, options) {
      seen.write.push(options);
      if (request.headers.cookie !== "lai_admin=good") return { ok: false, status: 401, code: "admin_session_required", message: "Pair this browser first." };
      if (request.headers["x-csrf-token"] !== "token") return { ok: false, status: 403, code: "csrf_invalid", message: "Reload the page." };
      return { ok: true, role: "owner", principal: "session:abcd1234", redact: false };
    },
    eventTypesFor(principal) {
      if (principal.role === "owner") return "*";
      if (principal.role === "system") return new Set(["status", "notification", "platform", "alerts"]);
      return new Set(["status", "instances"]);
    },
  };
  const auth = seam(t, { adminAuth });
  assert.equal(auth.mode, "session");

  const loopback = req("127.0.0.1");
  assert.equal(auth.principal(loopback).role, "viewer", "loopback without a session is a viewer");
  assert.equal(auth.principal(loopback).redact, true);
  assert.deepEqual(auth.checkWrite(loopback), { ok: false, status: 401, code: "admin_session_required", message: "Pair this browser first." });
  assert.deepEqual(seen.write.at(-1), { write: true });

  const session = req("127.0.0.1", { cookie: "lai_admin=good" }, "POST");
  assert.equal(auth.principal(session).role, "owner");
  assert.equal(auth.principal(session).principal, "session:abcd1234");
  assert.equal(auth.checkWrite(session).code, "csrf_invalid");
  assert.deepEqual(auth.checkWrite(req("127.0.0.1", { cookie: "lai_admin=good", "x-csrf-token": "token" }, "POST")), { ok: true });
  assert.equal(auth.eventTypesFor(auth.principal(session)), "*");

  const supervisor = req("127.0.0.1", { "x-ai-internal-principal": "system:supervisor" });
  assert.deepEqual([...auth.eventTypesFor(auth.principal(supervisor))].sort(), ["alerts", "notification", "platform", "status"]);

  // A broken authenticate never turns into an owner.
  const broken = seam(t, { adminAuth: { ...adminAuth, authenticate: () => { throw new Error("db locked"); }, checkManagementAccess: () => { throw new Error("db locked"); } } });
  assert.equal(broken.principal(req("127.0.0.1")).role, "none");
  assert.equal(broken.checkWrite(req("127.0.0.1")).ok, false);

  // attach() switches a running seam over to 05.
  const late = seam(t);
  assert.equal(late.principal(req("127.0.0.1")).role, "owner");
  late.attach({ adminAuth });
  assert.equal(late.principal(req("127.0.0.1")).role, "viewer");
  assert.equal(late.mode, "session");
});

test("redactFor applies the matched viewer entry and refuses unregistered paths", (t) => {
  const auth = seam(t);
  process.env.SERVICE_ENTRY_ALLOW_LAN_ADMIN = "0";
  auth.viewerRegistry.registerRoute({
    owner: "07",
    path: "/api/m/:managerId/instances",
    redact: (body, ctx) => ({ managerId: ctx.params.managerId, via: ctx.via, ids: body.instances.map((item) => item.id) }),
  });
  auth.viewerRegistry.registerRoute({ owner: "07", path: "/api/m/:managerId/models" });
  const body = { instances: [{ id: "primary", pid: 4321, root: "C:\\models" }] };

  assert.equal(auth.redactFor(req("127.0.0.1"), "/api/m/vllm/instances", body), body, "owners get the body unchanged");
  assert.deepEqual(auth.redactFor(req("192.168.0.60"), "/api/m/vllm/instances", body), { managerId: "vllm", via: "lan", ids: ["primary"] });
  assert.equal(auth.redactFor(req("192.168.0.60"), "/api/m/vllm/models", body), body, "an entry without redaction is a static read");
  assert.throws(() => auth.redactFor(req("192.168.0.60"), "/api/m/vllm/config", body), (error) => error.code === "viewer_route_not_registered");
});
