"use strict";

// /api/platform/* at the entry (06 §10, §14, OPS-13) through the real entry: the
// 05 guard, the viewer registry, the central sendJson redaction and the
// route-mount table. The supervisor is a fake HTTP server on a temp control
// endpoint (a unique named pipe or socket per test root); nothing here talks to
// a real supervisor, manager, Docker or the network. Every readiness probe,
// listener scan, doctor run and process start is a fake injected through
// ctx.platformDeps, and every root is a temp directory.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../../manager-core/internal-auth");
const { controlEndpoint, createControlClient } = require("../../manager-core/platform/control");
const configApi = require("../../manager-core/platform/config");
const platformRoutes = require("../lib/platform-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry, unusedPort } = require("./helpers/entry-harness");

const LAN = "192.168.1.50";
const FAKE_TOKEN = "control-token-for-tests";
const FAKE_HF = "hf_notarealtoken0000";
const FIXTURES = path.join(__dirname, "fixtures", "platform");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// A supervisor on the control endpoint of `aiRoot`. routes maps "METHOD /v1/path"
// to a function(request) -> {status, json}; push() writes an SSE event.
async function startFakeSupervisor(t, aiRoot, routes = {}) {
  const seen = [];
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    const text = await readAll(req);
    const url = new URL(req.url, "http://control");
    const entry = { method: req.method, url: req.url, pathname: url.pathname, headers: { ...req.headers }, body: text ? JSON.parse(text) : null };
    seen.push(entry);
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "no" } }));
      return;
    }
    if (url.pathname === "/v1/events" || url.pathname.endsWith("/logs/follow")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    const answer = handler ? await handler(entry) : { status: 404, json: { ok: false, error: { code: "not_found", message: "x" } } };
    res.writeHead(answer.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.json ?? {}));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlEndpoint(aiRoot), resolve);
  });
  t.after(() => new Promise((resolve) => {
    for (const stream of streams) stream.end();
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  let counter = 0;
  return {
    seen,
    routes,
    streams,
    // SSE like control.js: event: <type>, data: the whole event.
    push(type, data) {
      counter += 1;
      for (const stream of streams) stream.write(`id: ${counter}\nevent: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString(), data })}\n\n`);
    },
  };
}

function memoryVault() {
  const values = new Map();
  return {
    values,
    has: (namespace, name) => values.has(`${namespace}/${name}`),
    list: (namespace) => [...values.keys()].filter((key) => key.startsWith(`${namespace}/`)).map((key) => ({ name: key.slice(namespace.length + 1), updatedAt: "2026-10-20T10:00:00.000Z" })),
    get: (namespace, name) => values.get(`${namespace}/${name}`) ?? null,
    async set(namespace, name, value) { values.set(`${namespace}/${name}`, value); },
    async remove(namespace, name) { values.delete(`${namespace}/${name}`); },
  };
}

// Readiness probes answer ok for the entry's health document and nothing else
// is a candidate: only listeners the fake scan reports can be "ready".
function fakeFetch(calls = []) {
  return async (url) => {
    calls.push(String(url));
    const text = JSON.stringify({ ok: true, service: "local-ai-gateway" });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  };
}

const ENTRY_LISTENER = { pid: 4242, port: 5176, protocol: "tcp", address: "127.0.0.1" };

async function mountPlatform(t, { supervisor = true, routes: supervisorRoutes = {}, deps = {}, ctxExtra = {}, modules = ["./lib/platform-routes"] } = {}) {
  const { entry } = await loadEntry();
  const root = tempDir(t, "platform-routes-");
  const fake = supervisor ? await startFakeSupervisor(t, root, supervisorRoutes) : null;
  const fetchCalls = [];
  const ctx = entry.createRouteContext({
    logger: quietLogger(),
    aiRoot: root,
    platformDeps: {
      control: createControlClient({ aiRoot: root, token: FAKE_TOKEN }),
      secrets: memoryVault(),
      fetch: fakeFetch(fetchCalls),
      listListeners: async () => [ENTRY_LISTENER],
      execFile: (file, args, options, callback) => callback(new Error("no commands in tests")),
      instances: [],
      getBuildId: () => ({ commit: "abc123def456", contentHash: "feedbeef0001" }),
      countNewerCommits: async () => ({ available: false, behind: 0, head: null, deployed: null, ref: null }),
      computeLiveDrift: () => [],
      readVersion: () => ({ version: "0.1.0-git-abc123def456", commit: "abc123def456" }),
      bridge: false,
      ...deps,
    },
    ...ctxExtra,
  });
  const routes = await entry.mountRouteModules({ ctx, modules });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, routes, port, owner, root, fake, fetchCalls, registry: ctx.auth.viewerRegistry };
}

function signed(entry, port, method, pathWithQuery, { principal, body, peer } = {}) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const headers = internalAuth.buildMachineHeaders(entry.security.getTrustToken(), {
    method, pathWithQuery, principal, body: text || "", now: Date.now(),
  });
  return request(port, pathWithQuery, { method, headers, peer, ...(text !== undefined ? { body: text } : {}) });
}

function supervisorStatus() {
  return {
    schemaVersion: 1,
    at: "2026-10-20T10:00:00.000Z",
    build: { commit: "abc123def456", contentHash: "feedbeef0001" },
    mode: "supervised",
    supervisor: { running: true, pid: 777, startedAt: "2026-10-20T09:00:00.000Z", profile: "core", endpoint: "pipe" },
    readiness: {
      overall: "degraded",
      layers: [
        { id: "environment", status: "ok" },
        { id: "runtime", status: "ok", detail: "Docker 28.4.0 · driver 581.15" },
        { id: "components", status: "ok", detail: "5/5 ready" },
        { id: "serving", status: "warn", code: "no_model_serving", action: { id: "restore-models", label: { "zh-CN": "启动上次的模型", "en-US": "Start last used model" } } },
        { id: "exposure", status: "ok", mode: "local" },
      ],
    },
    components: [{
      id: "entry", legacyId: "entry", kind: "node", profile: "core", label: { "zh-CN": "入口服务", "en-US": "Entry" }, desired: "running", state: "ready", owner: "supervisor",
      pid: 5120, ports: [{ name: "admin", port: 5176, bind: "127.0.0.1" }], uptimeSec: 7380, restarts: { count: 2, windowCount: 1 },
      lastExit: { code: 1, at: "2026-10-20T08:00:00.000Z", reason: "crash" }, health: { live: true, checkedAt: "2026-10-20T10:00:00.000Z" },
      pendingRestart: null, message: "started from C:\\platform\\entry",
    }],
    models: { serving: 1, instances: [{ managerId: "vllm", instanceId: "i1", state: "ready", models: ["demo-model"] }] },
    ops: { nightly: { ok: false, streak: 3, since: "2026-10-17" }, backup: { ageHours: 4.5, ok: true, files: ["backups/20261020-0400/a.json"] }, pendingRestarts: [{ id: "entry", reason: "x", queuedAt: "t", deadline: "t" }] },
  };
}

// --- the access matrix (06 §10.1, §14) ----------------------------------------------

test("the access matrix: owner, loopback viewer, LAN viewer, proxied, machine principals", async (t) => {
  const app = await mountPlatform(t, { routes: { "GET /v1/status": () => ({ status: 200, json: supervisorStatus() }) } });

  const owner = await request(app.port, "/api/platform/status", { owner: app.owner });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.mode, "supervised");
  assert.equal(owner.json.components[0].pid, 5120, "the owner sees the full status");
  assert.ok(owner.json.readiness.layers.some((layer) => layer.detail), "layer detail stays for the owner");

  const forbidden = [/"pid"/, /lastExit/, /"bind"/, /"owner"/, /"message"/, /"detail"/, /"action"/, /"files"/, /[A-Za-z]:\\\\/, /"cwd"|"argv"|"command"/];
  for (const peer of [undefined, LAN]) {
    const viewer = await request(app.port, "/api/platform/status", { peer });
    assert.equal(viewer.status, 200, `viewer ${peer || "loopback"}`);
    for (const pattern of forbidden) assert.doesNotMatch(viewer.text, pattern, `${peer || "loopback"} viewer copy matches ${pattern}`);
    assert.equal(viewer.json.readiness.overall, "degraded");
    assert.deepEqual(viewer.json.readiness.layers.find((layer) => layer.id === "serving"), { id: "serving", status: "warn", code: "no_model_serving" });
    assert.deepEqual(viewer.json.components[0], {
      id: "entry", legacyId: "entry", kind: "node", profile: "core", desired: "running", state: "ready", uptimeSec: 7380,
      label: { "zh-CN": "入口服务", "en-US": "Entry" }, restarts: { count: 2 }, ports: [{ name: "admin", port: 5176 }],
    });
    assert.equal(viewer.json.supervisor.pid, undefined);
    assert.equal(viewer.json.models.serving, 1);
    assert.equal(viewer.json.models.instances, undefined);

    const components = await request(app.port, "/api/platform/components", { peer });
    assert.equal(components.status, 200);
    for (const pattern of forbidden) assert.doesNotMatch(components.text, pattern);
    assert.equal(components.json.components[0].spec, undefined, "no spec for a viewer");

    const version = await request(app.port, "/api/platform/version", { peer });
    assert.equal(version.status, 200);
    assert.deepEqual(Object.keys(version.json).sort(), ["build", "node", "version"]);
    assert.deepEqual(version.json.build, { commit: "abc123def456", contentHash: "feedbeef0001" });
  }

  // Everything else is owner-only.
  for (const peer of [undefined, LAN]) {
    for (const [method, target] of [
      ["GET", "/api/platform/config"], ["GET", "/api/platform/doctor"], ["GET", "/api/platform/components/entry"], ["GET", "/api/platform/components/entry/logs"],
      ["GET", "/api/platform/busy"], ["GET", "/api/platform/deploys"], ["GET", "/api/platform/schedules"], ["GET", "/api/platform/pending-restarts"],
      ["GET", "/api/platform/setup"], ["GET", "/api/platform/operations/op_1"],
      ["POST", "/api/platform/components/entry/restart"], ["POST", "/api/platform/supervisor/start"], ["PUT", "/api/platform/config"],
    ]) {
      const response = await request(app.port, target, { method, peer, body: method === "GET" ? undefined : {} });
      assert.equal(response.status, 401, `${peer || "loopback"} viewer ${method} ${target}`);
      assert.equal(response.json.error.code, "admin_session_required");
    }
  }

  // The proxied listener is gateway-only (server.js, 05 §3.3).
  const proxied = await request(app.port, "/api/platform/status", { headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(proxied.status, 404);
  assert.equal(proxied.json.code, "public_proxy_gateway_only");

  // A session without the CSRF token cannot write.
  const noCsrf = await request(app.port, "/api/platform/components/entry/restart", { method: "POST", headers: { cookie: app.owner.cookie }, body: {} });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.json.error.code, "csrf_invalid");

  // /api/platform/busy: system:supervisor (signed) and the owner; a viewer gets 401.
  const busy = await signed(app.entry, app.port, "GET", "/api/platform/busy", { principal: "system:supervisor" });
  assert.equal(busy.status, 200);
  assert.deepEqual(busy.json, { blockers: [] });
  const ownerBusy = await request(app.port, "/api/platform/busy", { owner: app.owner });
  assert.equal(ownerBusy.status, 200);
  const supervisorStatusCall = await signed(app.entry, app.port, "GET", "/api/platform/status", { principal: "system:supervisor" });
  assert.equal(supervisorStatusCall.status, 403, "the supervisor's scope is the busy probe, shutdown and its event stream");
  assert.equal(supervisorStatusCall.json.error.code, "principal_scope_denied");
  const mcp = await signed(app.entry, app.port, "GET", "/api/platform/config", { principal: "system:mcp" });
  assert.equal(mcp.status, 403, "system:mcp reaches viewer rows only");
  const mcpStatus = await signed(app.entry, app.port, "GET", "/api/platform/status", { principal: "system:mcp" });
  assert.equal(mcpStatus.status, 200);
  assert.doesNotMatch(mcpStatus.text, /"pid"/, "system:mcp gets the viewer copy");
});

test("an unknown platform path is 404 and a wrong method is 405", async (t) => {
  const app = await mountPlatform(t, { supervisor: false });
  const missing = await request(app.port, "/api/platform/nothing", { owner: app.owner });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "not_found");
  const wrong = await request(app.port, "/api/platform/status", { method: "POST", owner: app.owner, body: {} });
  assert.equal(wrong.status, 405);
});

// --- registry cases ---------------------------------------------------------------------

test("every platform row is registered: three viewer GETs with a redaction, the rest owner-only", async (t) => {
  const app = await mountPlatform(t, { supervisor: false });
  const inventory = app.registry.inventory().filter((item) => item.owner === "06");
  const viewerRows = inventory.filter((item) => item.access === "viewer" && item.method !== "EVENT").map((item) => `${item.method} ${item.path}`).sort();
  assert.deepEqual(viewerRows, ["GET /api/platform/components", "GET /api/platform/status", "GET /api/platform/version"]);
  for (const route of platformRoutes.ROUTES) {
    const row = inventory.find((item) => item.method === route.method && item.path === route.path);
    assert.ok(row, `${route.method} ${route.path} is registered`);
    assert.equal(row.access, route.access);
    if (route.access === "viewer") {
      const found = app.registry.match(route.method, route.path);
      assert.equal(typeof found.entry.redact, "function", `${route.path} has a redaction`);
    }
  }
  // Every GET the module answers is either registered with a redaction or owner-only.
  for (const route of platformRoutes.ROUTES.filter((item) => item.method === "GET")) {
    const found = app.registry.match("GET", route.path.replace(":id", "entry").replace(":opId", "op_1"));
    assert.ok(found, `${route.path} is known to the registry`);
    if (found.access === "viewer") assert.equal(typeof found.entry.redact, "function");
  }
  assert.ok(inventory.some((item) => item.method === "EVENT" && item.path === "platform"), "the platform event type is registered for viewers");
  assert.equal(app.registry.match("GET", "/api/platform/busy").access, "admin");
});

test("the viewer redactions pick fields and are idempotent", () => {
  const status = supervisorStatus();
  const once = platformRoutes.redactStatusForViewer(status);
  assert.deepEqual(platformRoutes.redactStatusForViewer(once), once);
  assert.doesNotMatch(JSON.stringify(once), /"pid"|lastExit|"bind"|"owner"|"message"|"files"|[A-Za-z]:\\\\/);
  assert.deepEqual(once.ops, { nightly: { ok: false, streak: 3, since: "2026-10-17" }, backup: { ageHours: 4.5, ok: true } });

  // The platform event: status redacted, component keeps {id, state, prev}, operations are dropped.
  assert.deepEqual(platformRoutes.redactPlatformEventForViewer({ kind: "component", id: "entry", state: "ready", prev: "starting", reason: "x", pid: 4 }), { kind: "component", id: "entry", state: "ready", prev: "starting" });
  assert.equal(platformRoutes.redactPlatformEventForViewer({ kind: "operation", opId: "op_1", line: "doing C:\\x" }), null);
  const event = platformRoutes.redactPlatformEventForViewer({ kind: "status", full: true, status });
  assert.equal(event.kind, "status");
  assert.doesNotMatch(JSON.stringify(event), /"pid"|lastExit|"bind"/);
  assert.equal(platformRoutes.redactPlatformEventForViewer({ kind: "other" }), null);

  assert.deepEqual(platformRoutes.redactPlatformSummaryForViewer({ supervisor: { running: true, pid: 4 }, readiness: { overall: "ok", layers: [{ id: "runtime", status: "ok", detail: "Docker 28" }] } }), {
    supervisor: { running: true }, readiness: { overall: "ok", layers: [{ id: "runtime", status: "ok" }] },
  });
  assert.equal(platformRoutes.redactPlatformSummaryForViewer(null), null);
});

test("a viewer's event stream receives platform events through the registered redaction", async (t) => {
  const app = await mountPlatform(t, { supervisor: false });
  const registry = app.registry;
  const component = registry.redactEvent("platform", { kind: "component", id: "entry", state: "ready", prev: "starting", pid: 9 });
  assert.deepEqual(component, { kind: "component", id: "entry", state: "ready", prev: "starting" });
  assert.equal(registry.redactEvent("platform", { kind: "operation", opId: "op_1" }), null);
  assert.deepEqual(registry.viewerEventTypes().filter((type) => type === "platform"), ["platform"]);
});

// --- probe-only fallback ----------------------------------------------------------------

test("without a supervisor the status is probe-only and components start through the entry's own code", async (t) => {
  const started = [];
  const app = await mountPlatform(t, {
    supervisor: false,
    ctxExtra: { startManager: async (managerId) => { started.push(managerId); return { ok: true, pid: 4321, ready: true, status: { root: "C:\\private\\root" } }; } },
  });
  const status = await request(app.port, "/api/platform/status", { owner: app.owner });
  assert.equal(status.status, 200);
  assert.equal(status.json.mode, "probe");
  assert.equal(status.json.supervisor.running, false);
  const entryRow = status.json.components.find((row) => row.id === "entry");
  assert.equal(entryRow.state, "ready");
  assert.equal(entryRow.pid, 4242);
  assert.equal(status.json.components.find((row) => row.id === "vllm-manager").state, "stopped");
  assert.equal(status.json.readiness.overall !== "down", true, "the entry answers, so the platform is not down");
  assert.deepEqual(status.json.build, { commit: "abc123def456", contentHash: "feedbeef0001" });

  // 2 s cache: a second call does not probe again; fresh=1 does.
  const before = app.fetchCalls.length;
  await request(app.port, "/api/platform/status", { owner: app.owner });
  assert.equal(app.fetchCalls.length, before, "cached for 2 s");
  await request(app.port, "/api/platform/status?fresh=1", { owner: app.owner });
  assert.ok(app.fetchCalls.length > before, "fresh=1 probes again");

  const list = await request(app.port, "/api/platform/components", { owner: app.owner });
  assert.equal(list.status, 200);
  assert.ok(list.json.components.some((row) => row.id === "llama-manager"));

  // A manager start falls back to the entry's detached start, by registry id or legacy id.
  const start = await request(app.port, "/api/platform/components/vllm-manager/start", { method: "POST", owner: app.owner, body: {} });
  assert.equal(start.status, 200);
  assert.equal(start.json.ok, true);
  assert.equal(start.json.fallback, "detached");
  assert.equal(start.json.pid, 4321);
  assert.doesNotMatch(start.text, /private/, "the manager's status is not echoed");
  const legacy = await request(app.port, "/api/platform/components/llama/start", { method: "POST", owner: app.owner, body: {} });
  assert.equal(legacy.status, 200);
  assert.deepEqual(started, ["vllm", "llama"]);

  // Anything else needs the supervisor, with the hint and the start-supervisor action.
  for (const [target, body] of [["/api/platform/components/platform-mcp/start", {}], ["/api/platform/components/vllm-manager/stop", {}], ["/api/platform/components/entry/restart", { when: "idle" }]]) {
    const response = await request(app.port, target, { method: "POST", owner: app.owner, body });
    assert.equal(response.status, 503, target);
    assert.equal(response.json.error.code, "supervisor_unavailable");
    assert.ok(response.json.error.hint);
    assert.deepEqual(response.json.error.action, { id: "start-supervisor" });
    assert.deepEqual(response.json.action, { id: "start-supervisor" });
    assert.equal(response.json.ok, false);
  }

  // The per-component read works from the registry, with env values hidden.
  const one = await request(app.port, "/api/platform/components/vllm-manager", { owner: app.owner });
  assert.equal(one.status, 200);
  assert.equal(one.json.component.id, "vllm-manager");
  assert.ok(Object.keys(one.json.spec.env).length > 0);
  assert.ok(Object.values(one.json.spec.env).every((value) => value === "<redacted>"));
  const unknown = await request(app.port, "/api/platform/components/no-such-thing", { owner: app.owner });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "component_unknown");
  const badId = await request(app.port, "/api/platform/components/..%2Fx", { owner: app.owner });
  assert.equal(badId.status, 404);
});

test("with a supervisor the status and component reads come from it and its errors pass through", async (t) => {
  const app = await mountPlatform(t, {
    routes: {
      "GET /v1/status": () => ({ status: 200, json: supervisorStatus() }),
      "GET /v1/components/entry": () => ({ status: 200, json: { component: supervisorStatus().components[0], spec: { id: "entry", env: { AI_ROOT: "<redacted>" } } } }),
      "POST /v1/components/entry/restart": (call) => (call.body.when === "idle"
        ? { status: 202, json: { ok: true, queued: ["entry"], blockers: [{ kind: "download", id: "d1" }] } }
        : { status: 409, json: { ok: false, error: { code: "component_busy", message: "busy" }, blockers: [{ kind: "requests", source: "entry", id: "gateway", title: "2 requests" }] } }),
      "POST /v1/components/vllm-manager/start": () => ({ status: 202, json: { ok: true, opId: "op_start1" } }),
      "POST /v1/components/vllm-manager/stop": (call) => (call.body.models ? { status: 400, json: { ok: false, error: { code: "confirm_required", message: "type stop" }, containers: ["c1"] } } : { status: 202, json: { ok: true, opId: "op_stop1" } }),
      "POST /v1/components/docker/start": () => ({ status: 400, json: { ok: false, error: { code: "detect_only_component", message: "no" } } }),
      "GET /v1/components/entry/logs": (call) => ({ status: 200, json: { lines: [{ stream: "out", text: `tail ${call.url}` }], files: [] } }),
      "GET /v1/operations/op_start1": () => ({ status: 200, json: { opId: "op_start1", kind: "start", state: "running", progress: 0.5, log: [], result: null } }),
    },
  });
  const status = await request(app.port, "/api/platform/status", { owner: app.owner });
  assert.equal(status.json.mode, "supervised");
  assert.equal(status.json.supervisor.pid, 777);

  const one = await request(app.port, "/api/platform/components/entry", { owner: app.owner });
  assert.equal(one.json.spec.env.AI_ROOT, "<redacted>");

  const busy = await request(app.port, "/api/platform/components/entry/restart", { method: "POST", owner: app.owner, body: { when: "now" } });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, "component_busy");
  assert.equal(busy.json.blockers[0].kind, "requests");
  const idle = await request(app.port, "/api/platform/components/entry/restart", { method: "POST", owner: app.owner, body: { when: "idle" } });
  assert.equal(idle.status, 202);
  assert.deepEqual(idle.json.queued, ["entry"]);
  const badWhen = await request(app.port, "/api/platform/components/entry/restart", { method: "POST", owner: app.owner, body: { when: "later" } });
  assert.equal(badWhen.status, 400);

  const start = await request(app.port, "/api/platform/components/vllm/start", { method: "POST", owner: app.owner, body: {} });
  assert.equal(start.status, 202);
  assert.deepEqual(start.json, { ok: true, opId: "op_start1" });
  assert.ok(app.fake.seen.some((call) => call.url === "/v1/components/vllm-manager/start"), "the legacy id maps to the registry id");
  const models = await request(app.port, "/api/platform/components/vllm-manager/stop", { method: "POST", owner: app.owner, body: { models: true } });
  assert.equal(models.status, 400);
  assert.equal(models.json.error.code, "confirm_required");
  assert.deepEqual(models.json.containers, ["c1"]);
  const detect = await request(app.port, "/api/platform/components/docker/start", { method: "POST", owner: app.owner, body: {} });
  assert.equal(detect.status, 400);
  assert.equal(detect.json.error.code, "detect_only_component");

  const logs = await request(app.port, "/api/platform/components/entry/logs?stream=err&tail=50&legacy=1", { owner: app.owner });
  assert.equal(logs.status, 200);
  assert.match(logs.json.lines[0].text, /stream=err&tail=50&legacy=1/);
  const badStream = await request(app.port, "/api/platform/components/entry/logs?stream=../x", { owner: app.owner });
  assert.equal(badStream.status, 400);

  const operation = await request(app.port, "/api/platform/operations/op_start1", { owner: app.owner });
  assert.equal(operation.json.state, "running");
  const badOp = await request(app.port, "/api/platform/operations/not-an-op", { owner: app.owner });
  assert.equal(badOp.status, 404);
  const gone = await request(app.port, "/api/platform/operations/op_missing", { owner: app.owner });
  assert.equal(gone.status, 404);
});

test("the log follow stream is validated first and then relayed as SSE", async (t) => {
  const app = await mountPlatform(t, {
    routes: { "GET /v1/components/entry": () => ({ status: 200, json: { component: { id: "entry" }, spec: {} } }) },
  });
  const missing = await request(app.port, "/api/platform/components/nope/logs/follow", { owner: app.owner });
  assert.equal(missing.status, 404);

  const lines = [];
  await new Promise((resolve, reject) => {
    const call = http.request({ host: "127.0.0.1", port: app.port, path: "/api/platform/components/entry/logs/follow?stream=out", headers: { host: "127.0.0.1:5176", ...app.owner.headers("GET") }, agent: false }, (response) => {
      assert.equal(response.statusCode, 200);
      assert.match(response.headers["content-type"], /text\/event-stream/);
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        lines.push(chunk);
        if (chunk.includes("hello")) {
          call.destroy();
          resolve();
        }
      });
      // The supervisor stream is up once the entry subscribed; then a line flows.
      const timer = setInterval(() => {
        if (app.fake.streams.size) {
          app.fake.push("log", { stream: "out", text: "hello" });
          clearInterval(timer);
        }
      }, 25);
      timer.unref();
    });
    call.on("error", (error) => (error.code === "ECONNRESET" ? resolve() : reject(error)));
    call.end();
  });
  assert.match(lines.join(""), /event: log\ndata: .*hello/);
});

// --- no client header reaches the pipe ---------------------------------------------------

test("no client header reaches the control pipe: only the token, accept, content type and a minted request id", async (t) => {
  const app = await mountPlatform(t, {
    routes: {
      "GET /v1/status": () => ({ status: 200, json: supervisorStatus() }),
      "POST /v1/components/entry/restart": () => ({ status: 202, json: { ok: true, opId: "op_1" } }),
    },
  });
  const hostile = {
    cookie: app.owner.cookie,
    "x-csrf-token": app.owner.csrfToken,
    "x-request-id": "req_ATTACKERCHOSENVALUE0",
    "x-service-entry-context": "{\"rid\":\"x\"}",
    "x-service-gateway-signature": "forged",
    "x-hub-shim": "1",
    "x-client-header": "keep-out",
    authorization: "Bearer client-supplied-token",
    origin: "http://127.0.0.1:5176",
  };
  for (const [method, target, body] of [["GET", "/api/platform/status?fresh=1"], ["POST", "/api/platform/components/entry/restart", { when: "idle" }]]) {
    const response = await request(app.port, target, { method, headers: hostile, body });
    assert.equal(response.status, method === "GET" ? 200 : 202, `${method} ${target}: ${response.text}`);
  }
  assert.ok(app.fake.seen.length >= 2);
  const allowed = new Set(["host", "authorization", "accept", "content-type", "content-length", "x-request-id", "connection"]);
  for (const call of app.fake.seen) {
    for (const name of Object.keys(call.headers)) assert.ok(allowed.has(name), `header ${name} reached the pipe on ${call.method} ${call.url}`);
    assert.equal(call.headers.authorization, `Bearer ${FAKE_TOKEN}`, "only the control token authenticates");
    assert.match(call.headers["x-request-id"], /^req_[a-z0-9]{20}$/, "the entry mints the request id");
    assert.notEqual(call.headers["x-request-id"], hostile["x-request-id"]);
  }
});

// --- config -------------------------------------------------------------------------------

test("GET /config describes the effective config with an etag header and secrets as {set}", async (t) => {
  const app = await mountPlatform(t, { supervisor: false });
  const response = await request(app.port, "/api/platform/config", { owner: app.owner });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.ok(response.json.groups.length > 3);
  assert.equal(response.headers.etag, `"${response.json.etag}"`);
  assert.equal(response.json.etag, "none", "no platform.json yet");
  const items = response.json.groups.flatMap((group) => group.items);
  const token = items.find((item) => item.key === "hf.token");
  assert.ok(token?.secret, "a secret leaf shows only its state");
  assert.equal(token.secret.set, false);
  assert.equal(token.value, undefined);
  assert.ok(items.find((item) => item.key === "managers.bindHost"));
});

test("PUT /config validates, writes through writePlatformConfig and returns restartRequired; secrets go through the store", async (t) => {
  const vault = memoryVault();
  const app = await mountPlatform(t, { supervisor: false, deps: { secrets: vault } });
  const put = (body, headers = {}) => request(app.port, "/api/platform/config", { method: "PUT", owner: app.owner, headers, body });

  const first = await request(app.port, "/api/platform/config", { owner: app.owner });
  const etag = first.headers.etag;

  // Validation: a bad type is config_invalid with errors[].
  const invalid = await put({ set: { "managers.vllm.port": "not-a-port" } }, { "if-match": etag });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "config_invalid");
  assert.ok(invalid.json.errors.some((error) => error.field === "managers.vllm.port"));
  assert.equal(fs.existsSync(configApi.platformConfigFile({ aiRoot: app.root })), false, "nothing was written");

  // A secret in `set` is refused.
  const viaSet = await put({ set: { "hf.token": FAKE_HF } }, { "if-match": etag });
  assert.equal(viaSet.status, 400);
  assert.equal(viaSet.json.error.code, "secret_via_store");
  assert.doesNotMatch(viaSet.text, new RegExp(FAKE_HF));

  // A good write: atomic, with the new etag, the changed keys and who must restart.
  const written = await put({ set: { "managers.vllm.port": 5199 } }, { "if-match": etag });
  assert.equal(written.status, 200, written.text);
  assert.equal(written.json.ok, true);
  assert.deepEqual(written.json.changed, ["managers.vllm.port"]);
  assert.ok(written.json.restartRequired.includes("vllm-manager"));
  assert.notEqual(written.json.etag, "none");
  assert.equal(written.headers.etag, `"${written.json.etag}"`);
  const file = configApi.platformConfigFile({ aiRoot: app.root });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).managers.vllm.port, 5199);
  const log = fs.readFileSync(path.join(app.root, "logs", "platform", "config-changes.jsonl"), "utf8");
  assert.match(log, /managers\.vllm\.port/);
  assert.doesNotMatch(log, /5199/, "the change log holds keys, never values");
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false, "no temp file is left behind");

  // The stale etag conflicts and carries the current one.
  const conflict = await put({ set: { "managers.vllm.port": 5200 } }, { "if-match": etag });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "config_conflict");
  assert.equal(conflict.json.etag, written.json.etag);

  // Secrets: set through the store, never echoed, then cleared with null.
  const secret = await put({ secrets: { "hf.token": FAKE_HF } });
  assert.equal(secret.status, 200, secret.text);
  assert.deepEqual(secret.json.changed, ["hf.token"]);
  assert.doesNotMatch(secret.text, new RegExp(FAKE_HF));
  assert.ok([...vault.values.values()].includes(FAKE_HF), "the value is in the store");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(FAKE_HF));
  const described = await request(app.port, "/api/platform/config", { owner: app.owner });
  assert.doesNotMatch(described.text, new RegExp(FAKE_HF));
  assert.equal(described.json.groups.flatMap((group) => group.items).find((item) => item.key === "hf.token").secret.set, true);
  const cleared = await put({ secrets: { "hf.token": null } });
  assert.equal(cleared.status, 200);
  assert.equal(vault.values.size, 0);
  const notSecret = await put({ secrets: { "managers.bindHost": "x" } });
  assert.equal(notSecret.status, 400);
  assert.equal(notSecret.json.error.code, "config_invalid");

  // Shape errors.
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ set: [] })).status, 400);
  assert.equal((await put({ unset: [1] })).status, 400);
  const unset = await put({ unset: ["managers.vllm.port"] });
  assert.equal(unset.status, 200);
  assert.deepEqual(unset.json.changed, ["managers.vllm.port"]);
});

test("PUT /config answers config_locked when another writer holds the lock", { timeout: 20000 }, async (t) => {
  const app = await mountPlatform(t, { supervisor: false });
  const file = configApi.platformConfigFile({ aiRoot: app.root });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const response = await request(app.port, "/api/platform/config", { method: "PUT", owner: app.owner, body: { set: { "managers.vllm.port": 5301 } } });
  fs.rmSync(`${file}.lock`, { force: true });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, "config_locked");
  assert.equal(response.json.error.hint, "retry");
});

test("config/apply restarts through the supervisor, the entry last, and refuses a busy now", async (t) => {
  let idle = false;
  const app = await mountPlatform(t, {
    routes: {
      "GET /v1/idle": () => ({ status: 200, json: { idle, blockers: idle ? [] : [{ kind: "download", source: "entry", id: "hub:downloads", title: "1 download" }] } }),
      "POST /v1/components/entry/restart": (call) => ({ status: 202, json: { ok: true, opId: `op_entry_${call.body.when}` } }),
      "POST /v1/components/vllm-manager/restart": (call) => ({ status: 202, json: { ok: true, queued: ["vllm-manager"], when: call.body.when } }),
    },
  });
  const apply = (body) => request(app.port, "/api/platform/config/apply", { method: "POST", owner: app.owner, body });

  const queued = await apply({ restart: ["entry", "vllm"], when: "idle" });
  assert.equal(queued.status, 202);
  assert.equal(queued.json.opId, "op_entry_idle");
  const restarts = app.fake.seen.filter((call) => call.method === "POST").map((call) => call.url);
  assert.deepEqual(restarts, ["/v1/components/vllm-manager/restart", "/v1/components/entry/restart"], "the entry goes last");
  assert.ok(app.fake.seen.filter((call) => call.method === "POST").every((call) => call.body.when === "idle"));

  const refused = await apply({ restart: ["entry"], when: "now" });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, "component_busy");
  assert.equal(refused.json.blockers[0].kind, "download");
  idle = true;
  const now = await apply({ restart: ["entry"], when: "now" });
  assert.equal(now.status, 202);
  assert.equal((await apply({ restart: ["nope"], when: "idle" })).status, 404);
  assert.equal((await apply({ restart: [] })).status, 400);
  assert.equal((await apply({ restart: ["entry"], when: "soon" })).status, 400);
});

// --- doctor -------------------------------------------------------------------------------

test("the doctor runs in-process single-flight, is cached for 30 s, and fix refuses manual", async (t) => {
  let runs = 0;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const report = {
    schemaVersion: 1, at: "2026-10-20T10:00:00.000Z", durationMs: 4, summary: { ok: 1, warn: 0, fail: 2, info: 0, skip: 0 },
    checks: [
      { id: "ops.autostart", group: "ops", status: "info", title: { "zh-CN": "x", "en-US": "Autostart" }, detail: "off", data: {}, fix: { id: "enable", risk: "manual", command: "platform autostart enable", docs: "/docs/x" }, actions: ["enable"] },
      { id: "runtime.docker-daemon", group: "runtime", status: "fail", title: { "zh-CN": "x", "en-US": "Docker" }, detail: "down", data: {}, fix: { id: "start-docker", risk: "confirm" }, actions: ["start-docker"] },
      { id: "env.python", group: "env", status: "fail", title: { "zh-CN": "x", "en-US": "Python" }, detail: "missing", data: {}, fix: { id: "install-python", risk: "auto" }, actions: ["install-python"] },
    ],
  };
  const app = await mountPlatform(t, {
    routes: { "POST /v1/doctor/fix": () => ({ status: 202, json: { ok: true, opId: "op_fix1" } }) },
    deps: { runDoctor: async (options) => { runs += 1; app.lastDoctorOptions = options; await gate; return report; } },
  });
  const calls = [1, 2, 3].map(() => request(app.port, "/api/platform/doctor?group=ops,runtime&deep=0", { owner: app.owner }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  release();
  const answers = await Promise.all(calls);
  assert.equal(runs, 1, "three concurrent calls share one run");
  for (const answer of answers) assert.equal(answer.status, 200);
  assert.deepEqual(app.lastDoctorOptions.groups, ["ops", "runtime"]);
  assert.equal(app.lastDoctorOptions.deep, false);
  assert.equal(app.lastDoctorOptions.aiRoot, app.root);

  await request(app.port, "/api/platform/doctor?group=ops,runtime", { owner: app.owner });
  assert.equal(runs, 1, "cached");
  await request(app.port, "/api/platform/doctor?group=ops,runtime&fresh=1", { owner: app.owner });
  assert.equal(runs, 2, "fresh=1 runs again");
  assert.equal((await request(app.port, "/api/platform/doctor?group=bogus", { owner: app.owner })).status, 400);

  // The doctor result the console shows is the cached report; fixes consult its risks.
  const fix = (body) => request(app.port, "/api/platform/doctor/fix", { method: "POST", owner: app.owner, body });
  const manual = await fix({ checkId: "ops.autostart", fixId: "enable", confirm: true });
  assert.equal(manual.status, 400);
  assert.equal(manual.json.error.code, "fix_manual_only");
  assert.equal(manual.json.command, "platform autostart enable");
  assert.equal(app.fake.seen.some((call) => call.url === "/v1/doctor/fix"), false, "a manual fix never reaches the supervisor");
  const unconfirmed = await fix({ checkId: "runtime.docker-daemon", fixId: "start-docker" });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.error.code, "confirm_required");
  const confirmed = await fix({ checkId: "runtime.docker-daemon", fixId: "start-docker", confirm: true });
  assert.equal(confirmed.status, 202);
  assert.deepEqual(confirmed.json, { ok: true, opId: "op_fix1" });
  assert.deepEqual(app.fake.seen.at(-1).body, { checkId: "runtime.docker-daemon", fixId: "start-docker", confirm: true });
  assert.equal((await fix({ checkId: "env.python", fixId: "install-python" })).status, 202, "an auto fix needs no confirm");
  assert.equal((await fix({ fixId: "x" })).status, 400);
});

// --- version, deploys, schedules, pending restarts, restore, setup -------------------------

test("version, deploys and schedules read the ops modules; viewers get the three-field version", async (t) => {
  const deps = {
    listDeployments: (root, options) => [{ stamp: "20261020-0900", commit: "abc123def456", branch: "main", deployedAt: "2026-10-20T09:00:00.000Z", counts: { created: 1, updated: 2, unchanged: 3, pruned: 0 }, limit: options.limit }],
    countNewerCommits: async () => ({ available: true, behind: 2, head: "def", deployed: "abc", ref: "refs/heads/main" }),
    computeLiveDrift: () => [{ path: "a.js" }, { path: "b.js" }],
    runDoctor: async () => ({ checks: [{ id: "ops.autostart", data: { registered: true, method: "task" } }, { id: "ops.nightly", data: { task: { name: "Nightly", state: "Ready" } } }, { id: "ops.backup", data: { task: null } }] }),
  };
  const app = await mountPlatform(t, { supervisor: false, deps });
  fs.mkdirSync(path.join(app.root, "packages-fixture"), { recursive: true });
  const nightly = path.join(app.root, "artifacts", "nightly");
  fs.mkdirSync(nightly, { recursive: true });
  const report = (ok, passed, failed) => JSON.stringify({ ok, passed, failed, finishedAt: "2026-10-20T03:00:00Z" });
  fs.writeFileSync(path.join(nightly, "20261019-0300.json"), `\uFEFF${report(false, 5, 2)}`);
  fs.writeFileSync(path.join(nightly, "20261020-0300.json"), report(false, 4, 3));
  fs.writeFileSync(path.join(nightly, "latest.json"), report(false, 4, 3));
  const backup = path.join(app.root, "backups", "20261020-0400");
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, "backup-manifest.json"), JSON.stringify({ format: "local-ai-platform-backup-v2", at: "2026-10-20T04:00:00Z", files: [{}, {}, {}], warnings: [] }));

  const version = await request(app.port, "/api/platform/version", { owner: app.owner });
  assert.equal(version.status, 200);
  assert.equal(version.json.version, "0.1.0-git-abc123def456");
  assert.equal(version.json.node, process.version);
  assert.deepEqual(version.json.newerCommits, { available: true, behind: 2, head: "def", deployed: "abc", ref: "refs/heads/main" });
  assert.equal(version.json.drift.count, 2);
  assert.ok(Array.isArray(version.json.packages));
  const viewerVersion = await request(app.port, "/api/platform/version");
  assert.deepEqual(Object.keys(viewerVersion.json).sort(), ["build", "node", "version"]);

  const deploys = await request(app.port, "/api/platform/deploys?limit=5", { owner: app.owner });
  assert.equal(deploys.json.deployments[0].limit, 5);
  assert.equal(deploys.json.deployments[0].stamp, "20261020-0900");

  const schedules = await request(app.port, "/api/platform/schedules", { owner: app.owner });
  assert.equal(schedules.status, 200);
  assert.equal(schedules.json.nightly.streak, 2);
  assert.equal(schedules.json.nightly.trend.length, 2);
  assert.equal(schedules.json.nightly.latest.failed, 3);
  assert.equal(schedules.json.backup.latest.stamp, "20261020-0400");
  assert.equal(schedules.json.backup.files, 3);
  assert.deepEqual(schedules.json.tasks.autostart, { registered: true, method: "task" });
  assert.equal(schedules.json.tasks.nightly.name, "Nightly");
});

test("pending restarts, restore-models and setup steps go to the supervisor; setup state needs the wizard module", async (t) => {
  const app = await mountPlatform(t, {
    routes: {
      "GET /v1/pending-restarts": () => ({ status: 200, json: { pendingRestarts: [{ id: "entry", reason: "x", queuedAt: "t", deadline: "t" }] } }),
      "DELETE /v1/pending-restarts/entry": () => ({ status: 200, json: { ok: true } }),
      "POST /v1/restore-models": (call) => ({ status: 202, json: { ok: true, opId: "op_restore", plan: { dry: call.body.dryRun === true } } }),
      "POST /v1/setup/images": (call) => ({ status: 202, json: { ok: true, opId: "op_setup", echo: call.body } }),
    },
    deps: { setup: { describeSetup: async ({ aiRoot }) => ({ steps: [{ id: "images", state: "todo" }], completedAt: null, root: path.basename(aiRoot) }) } },
  });
  assert.equal((await request(app.port, "/api/platform/pending-restarts", { owner: app.owner })).json.pendingRestarts[0].id, "entry");
  assert.equal((await request(app.port, "/api/platform/pending-restarts/entry", { method: "DELETE", owner: app.owner })).json.ok, true);
  const restore = await request(app.port, "/api/platform/restore-models", { method: "POST", owner: app.owner, body: { managers: ["vllm"], dryRun: true } });
  assert.equal(restore.status, 202);
  assert.deepEqual(restore.json.plan, { dry: true });
  assert.deepEqual(app.fake.seen.at(-1).body, { managers: ["vllm"], dryRun: true });
  assert.equal((await request(app.port, "/api/platform/restore-models", { method: "POST", owner: app.owner, body: { managers: "vllm" } })).status, 400);
  const step = await request(app.port, "/api/platform/setup/images", { method: "POST", owner: app.owner, body: { pull: ["a"] } });
  assert.equal(step.status, 202);
  assert.deepEqual(step.json.echo, { pull: ["a"] });
  assert.equal((await request(app.port, "/api/platform/setup/BAD%20STEP", { method: "POST", owner: app.owner, body: {} })).status, 404);
  const setup = await request(app.port, "/api/platform/setup", { owner: app.owner });
  assert.equal(setup.status, 200);
  assert.equal(setup.json.steps[0].id, "images");
  assert.equal(app.ctx.features.setup, true);

  const bare = await mountPlatform(t, { supervisor: false, deps: { setup: null } });
  const missing = await request(bare.port, "/api/platform/setup", { owner: bare.owner });
  assert.equal(missing.status, 501);
  assert.equal(missing.json.error.code, "setup_unavailable");
  assert.equal(bare.ctx.features.setup, false);
});

test("supervisor/start is for the owner on loopback and spawns the CLI detached without a profile", async (t) => {
  const spawned = [];
  const spawn = (file, args, options) => {
    spawned.push({ file, args, options });
    return { on() {}, unref() {} };
  };
  const app = await mountPlatform(t, { supervisor: false, deps: { spawn, nodeExe: process.execPath } });
  const started = await request(app.port, "/api/platform/supervisor/start", { method: "POST", owner: app.owner, body: {} });
  assert.equal(started.status, 202);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, process.execPath);
  assert.deepEqual(spawned[0].args, [path.join(app.root, "scripts", "platformctl.js"), "supervise", "--profile", "none"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, "ignore");
  assert.equal(spawned[0].options.cwd, app.root);

  // Not from the LAN: the module itself refuses a non-loopback socket, even for the owner.
  const sent = [];
  const lanRoutes = platformRoutes.createPlatformRoutes({
    aiRoot: app.root, auth: { principal: () => ({ role: "owner", principal: "session:abcd1234" }), checkWrite: () => ({ ok: true }) },
    sendJson: (res, body, status) => sent.push({ body, status }), readJsonObjectBody: async () => ({}), logger: quietLogger(), spawn, control: { request: async () => { throw new Error("down"); } },
  });
  const lanRequest = { method: "POST", url: "/api/platform/supervisor/start", headers: {}, socket: { remoteAddress: LAN }, resume() {}, on() {} };
  assert.equal(await lanRoutes.handle(lanRequest, { headersSent: false }, new URL("http://127.0.0.1:5176/api/platform/supervisor/start")), true);
  assert.equal(sent[0].status, 403);
  assert.equal(sent[0].body.error.code, "loopback_only");
  assert.equal(spawned.length, 1);
  const remote = await signed(app.entry, app.port, "POST", "/api/platform/supervisor/start", { principal: "system:cli", body: {}, peer: LAN });
  assert.ok([401, 403].includes(remote.status), "a machine principal from the LAN never gets this far");
  assert.equal(spawned.length, 1);

  // Already running: nothing is spawned.
  const running = await mountPlatform(t, { deps: { spawn }, routes: { "GET /v1/status": () => ({ status: 200, json: supervisorStatus() }) } });
  const again = await request(running.port, "/api/platform/supervisor/start", { method: "POST", owner: running.owner, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.json.alreadyRunning, true);
  assert.equal(spawned.length, 1);
});

// --- busy ----------------------------------------------------------------------------------

test("busy reports hub transfers and in-flight gateway streams as blockers", async (t) => {
  let downloads = 0;
  let inFlight = 0;
  const app = await mountPlatform(t, {
    supervisor: false,
    ctxExtra: { hub: { busy: () => ({ downloads, verifying: downloads ? 1 : 0 }) }, gatewayInFlight: () => inFlight },
  });
  const read = () => request(app.port, "/api/platform/busy", { owner: app.owner });
  assert.deepEqual((await read()).json, { blockers: [] });
  downloads = 2;
  inFlight = 3;
  const blockers = (await read()).json.blockers;
  assert.deepEqual(blockers.map((item) => [item.kind, item.id]), [["download", "hub:downloads"], ["download", "hub:verifying"], ["requests", "gateway"]]);
  assert.match(blockers[0].title, /2 downloads/);
  assert.match(blockers[2].title, /3 gateway requests/);
  app.ctx.hub = { busy() { throw new Error("queue unreadable"); } };
  const unknown = (await read()).json.blockers;
  assert.equal(unknown[0].kind, "unknown", "a hub that cannot be read fails closed");
});

// --- the events bridge ----------------------------------------------------------------------

function waitFor(predicate, { timeoutMs = 4000, stepMs = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let value;
      try { value = predicate(); } catch (error) { clearInterval(timer); reject(error); return; }
      if (value) { clearInterval(timer); resolve(value); } else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting")); }
    }, stepMs);
  });
}

test("the bridge publishes supervisor events as platform and notification envelopes with source platform", async (t) => {
  const app = await mountPlatform(t, { deps: { bridge: true } });
  const seen = [];
  app.ctx.bus.subscribe((envelope) => seen.push(envelope), { types: ["platform", "notification"] });
  await waitFor(() => app.fake.streams.size === 1);

  app.fake.push("component", { id: "entry", state: "ready", prev: "starting", reason: null });
  app.fake.push("operation", { opId: "op_1", kind: "start", state: "running", progress: 0.1, line: "entry: starting" });
  app.fake.push("status", { full: true, status: supervisorStatus() });
  app.fake.push("notification", {
    kind: "component.failed", severity: "error", title: { zh: "组件失败", en: "Component failed" }, body: { zh: "x", en: "x" },
    action: { label: { zh: "查看", en: "View" }, href: "/system" }, dedupeKey: "component.failed:entry",
  });
  app.fake.push("notification", { kind: "bad", severity: "nonsense", title: "no" });
  await waitFor(() => seen.length >= 4);

  assert.deepEqual(seen.map((item) => [item.type, item.source, item.data.kind]), [
    ["platform", "platform", "component"], ["platform", "platform", "operation"], ["platform", "platform", "status"], ["notification", "platform", "component.failed"],
  ]);
  assert.equal(seen[0].data.id, "entry");
  assert.equal(seen[1].data.opId, "op_1");
  assert.equal(seen[2].data.full, true);
  assert.equal(seen[2].data.status.mode, "supervised");
  assert.equal(seen[3].data.dedupeKey, "component.failed:entry", "extra keys pass through");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen.length, 4, "an envelope the bus refuses is dropped, not published");

  // The status event refreshes the cache behind /api/status.
  const summary = app.ctx.platform.summary();
  assert.equal(summary.supervisor.running, true);
  assert.equal(summary.readiness.overall, "degraded");
});

test("the bridge calls publish() and nothing else on the bus, and the module never touches events.js", async () => {
  const published = [];
  const touched = [];
  const bus = new Proxy({ publish: (type, data, options) => { published.push([type, data.kind, options]); return {}; } }, {
    get(target, property) {
      touched.push(String(property));
      return target[property];
    },
  });
  const controlLike = {
    request: async () => ({ status: 503, json: null }),
    events(onEvent) {
      queueMicrotask(() => {
        onEvent({ type: "component", data: { type: "component", at: "t", data: { id: "entry", state: "ready", prev: "starting" } } });
        onEvent({ type: "notification", data: { type: "notification", at: "t", data: { kind: "x", severity: "info", title: { zh: "a", en: "a" } } } });
        onEvent({ type: "unknown-type", data: { type: "unknown-type", at: "t", data: { x: 1 } } });
      });
      return { close() {} };
    },
  };
  const routes = platformRoutes.createPlatformRoutes({
    aiRoot: os.tmpdir(), auth: { principal: () => ({}), checkWrite: () => ({ ok: true }) }, bus, sendJson: () => {}, readJsonObjectBody: async () => ({}), control: controlLike, logger: quietLogger(),
  });
  routes.startBridge();
  await new Promise((resolve) => setTimeout(resolve, 30));
  routes.close();
  assert.deepEqual(published.map((item) => [item[0], item[1], item[2].source]), [["platform", "component", "platform"], ["notification", "x", "platform"]]);
  assert.deepEqual([...new Set(touched)].sort(), ["publish"]);

  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "platform-routes.js"), "utf8");
  assert.doesNotMatch(source, /require\([^)]*events[^)]*\)/, "platform-routes never requires events.js");
  assert.doesNotMatch(source, /createEventBus/);
});

test("the bridge retries with a backoff while there is no supervisor and stops on close", async (t) => {
  let attempts = 0;
  const routes = platformRoutes.createPlatformRoutes({
    aiRoot: os.tmpdir(), auth: { principal: () => ({}), checkWrite: () => ({ ok: true }) }, bus: { publish: () => ({}) }, sendJson: () => {}, readJsonObjectBody: async () => ({}), logger: quietLogger(),
    control: { request: async () => ({ status: 503, json: null }), events(onEvent, options) { attempts += 1; queueMicrotask(() => options.onError(new Error("down"))); return { close() {} }; } },
  });
  routes.startBridge();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, 1, "the first retry waits about a second");
  routes.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, 1);
});

// --- delegation from the existing entry handlers ----------------------------------------------

test("manager start and stop go through the supervisor when it answers, and wait for its operation", async (t) => {
  let polls = 0;
  const app = await mountPlatform(t, {
    modules: ["./lib/platform-routes"],
    routes: {
      "POST /v1/components/vllm-manager/start": () => ({ status: 202, json: { ok: true, opId: "op_s1" } }),
      "POST /v1/components/llama-manager/stop": () => ({ status: 202, json: { ok: true, opId: "op_s2" } }),
      "POST /v1/components/vllm-manager/stop": () => ({ status: 409, json: { ok: false, error: { code: "component_busy", message: "busy" } } }),
      "GET /v1/operations/op_s1": () => { polls += 1; return { status: 200, json: { opId: "op_s1", state: polls < 3 ? "running" : "ok" } }; },
      "GET /v1/operations/op_s2": () => ({ status: 200, json: { opId: "op_s2", state: "failed", log: ["llama-manager: stopping", "llama-manager: kill failed"] } }),
    },
    deps: { pollMs: 5 },
  });
  const started = await request(app.port, "/api/managers/vllm/start", { method: "POST", owner: app.owner, body: {} });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.delegated, "supervisor");
  assert.equal(started.json.opId, "op_s1");
  assert.ok(polls >= 3, "it polled the operation until it finished");
  assert.ok(started.json.status, "the legacy status key stays");

  const failed = await request(app.port, "/api/managers/llama/stop", { method: "POST", owner: app.owner, body: {} });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.ok, false);
  assert.match(failed.json.error.message, /kill failed/);

  const refused = await request(app.port, "/api/managers/vllm/stop", { method: "POST", owner: app.owner, body: {} });
  assert.equal(refused.status, 502);
  assert.equal(refused.json.error.code, "component_busy");

  assert.equal((await request(app.port, "/api/managers/nope/start", { method: "POST", owner: app.owner, body: {} })).status, 404);
  // A viewer is still refused before any delegation.
  const before = app.fake.seen.length;
  assert.equal((await request(app.port, "/api/managers/vllm/start", { method: "POST", body: {} })).status, 401);
  assert.equal(app.fake.seen.length, before);
});

test("delegateManager resolves {delegated:false} without a supervisor and rejects other actions", async (t) => {
  const root = tempDir(t, "platform-delegate-");
  const control = createControlClient({ aiRoot: root, token: FAKE_TOKEN });
  assert.deepEqual(await platformRoutes.delegateManager("vllm", "start", { control }), { delegated: false, reason: "supervisor_unavailable" });
  assert.deepEqual(await platformRoutes.delegateStopAll({ control }), { delegated: false, reason: "supervisor_unavailable" });
  await assert.rejects(() => platformRoutes.delegateManager("vllm", "restart", { control }), /start and stop/);
  // A supervisor that does not know our token is not a supervisor to delegate to.
  await startFakeSupervisor(t, root, {});
  const wrong = createControlClient({ aiRoot: root, token: "another-token" });
  assert.equal((await platformRoutes.delegateManager("vllm", "start", { control: wrong })).delegated, false);
});

test("stop-all delegates one core stop to the supervisor and keeps the response keys", async (t) => {
  const app = await mountPlatform(t, { routes: { "POST /v1/stop": (call) => ({ status: 202, json: { ok: true, opId: "op_stopall", scope: call.body.scope } }) } });
  const response = await request(app.port, "/api/stop-all", { method: "POST", owner: app.owner, body: {} });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.delegated, "supervisor");
  assert.equal(response.json.opId, "op_stopall");
  assert.deepEqual(response.json.stopped.map((item) => item.id), ["vllm", "llama"]);
  const call = app.fake.seen.find((item) => item.url === "/v1/stop");
  assert.deepEqual(call.body, { scope: "core" });
});

// --- /api/status ----------------------------------------------------------------------------

test("summarizeComponents keeps every legacy field except startCommand and allCommand", async () => {
  const { entry } = await loadEntry();
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, "status-components-legacy.json"), "utf8"));
  const actual = entry.summarizeComponents(fixture.managers, fixture.mcp, fixture.tts, fixture.search);
  const strip = (components) => ({ ...components, allCommand: undefined, items: components.items.map((item) => ({ ...item, startCommand: undefined })) });
  assert.deepEqual(strip(actual), strip(fixture.components));
  assert.deepEqual(actual.items.map((item) => item.startCommand), [
    "platform start vllm-manager", "platform start llama-manager", "platform start tts-gateway", "platform start platform-mcp", "platform start search-gateway",
  ]);
  assert.equal(actual.allCommand, "platform start full");
  assert.deepEqual(Object.keys(actual), Object.keys(fixture.components));
  for (const item of actual.items) assert.deepEqual(Object.keys(item), ["id", "name", "kind", "online", "healthy", "startable", "startCommand", "error"]);
});

test("/api/status keeps its legacy keys, gains platform, and shows viewers only the redacted summary", async (t) => {
  const app = await mountPlatform(t, { routes: { "GET /v1/status": () => ({ status: 200, json: supervisorStatus() }) }, ctxExtra: {} });
  const read = (options = {}) => request(app.port, "/api/status", options);

  const first = await read({ owner: app.owner });
  assert.equal(first.status, 200);
  const legacy = ["ok", "security", "entry", "managers", "mcp", "tts", "search", "keys", "components"];
  for (const key of legacy) assert.ok(Object.hasOwn(first.json, key), `legacy key ${key}`);
  assert.deepEqual(Object.keys(first.json).filter((key) => !legacy.includes(key)), ["platform"]);
  assert.equal(first.json.ok, true);
  assert.deepEqual(Object.keys(first.json.components), ["total", "online", "offline", "unhealthy", "items", "allCommand"]);
  assert.ok(Array.isArray(first.json.components.offline), "the nightly check reads .components.offline");
  assert.equal(first.json.platform, null, "nothing was known when the first request arrived");

  await app.ctx.platform.refresh();
  const second = await read({ owner: app.owner });
  assert.equal(second.json.platform.supervisor.running, true);
  assert.equal(second.json.platform.readiness.overall, "degraded");
  assert.ok(second.json.platform.readiness.layers.some((layer) => layer.detail), "the owner keeps layer detail");

  for (const peer of [undefined, LAN]) {
    const viewer = await read({ peer });
    assert.equal(viewer.status, 200);
    assert.deepEqual(viewer.json.platform, {
      supervisor: { running: true },
      readiness: { overall: "degraded", layers: supervisorStatus().readiness.layers.map(({ id, status, code, mode }) => ({ id, status, ...(code ? { code } : {}), ...(mode ? { mode } : {}) })) },
    });
    assert.doesNotMatch(JSON.stringify(viewer.json.platform), /Docker|driver|restore-models/);
  }
});

test("without a supervisor /api/status reports platform as not running once it has looked", async (t) => {
  const app = await mountPlatform(t, { supervisor: false });
  assert.equal(app.ctx.platform.summary(), null, "never blocks, and null before the first look");
  await app.ctx.platform.refresh();
  assert.deepEqual(app.ctx.platform.summary(), { supervisor: { running: false }, readiness: null });
  const status = await request(app.port, "/api/status", { owner: app.owner });
  assert.deepEqual(status.json.platform, { supervisor: { running: false }, readiness: null });
});

// --- startDetachedManager reads the bind from platform.json -----------------------------------

test("startDetachedManager binds the readSection host and port, all interfaces by default", async (t) => {
  const { entry } = await loadEntry();
  const aiRoot = tempDir(t, "detached-ai-root-");
  const managerRoot = tempDir(t, "detached-manager-");
  // Nothing is started: spawn is a fake that records what the entry would run.
  const spawned = [];
  const spawn = (file, args, options) => {
    spawned.push({ file, args, options });
    return { pid: 4321, on() {}, unref() {} };
  };
  const firstPort = await unusedPort();
  const secondPort = await unusedPort();
  const manager = { id: "vllm", name: "Fake Manager", root: managerRoot, port: firstPort, billingId: "fake", envPort: "VLLM_MANAGER_PORT", envHost: "VLLM_MANAGER_HOST", defaultHost: "127.0.0.1", mode: "", accent: "blue" };
  const run = (env) => entry.startDetachedManager(manager, { aiRoot, env, spawn, readyTimeoutMs: 1 });

  // The default 5177 belongs to a real manager on a developer machine and is
  // never probed: the port is configured, the host is not.
  const portWrite = await configApi.writePlatformConfig({ aiRoot, env: {}, set: { "managers.vllm.port": firstPort }, actor: "test" });
  assert.equal(portWrite.ok, true, JSON.stringify(portWrite.errors));
  const first = await run({});
  assert.equal(first.pid, 4321);
  const defaults = spawned[0];
  assert.equal(defaults.options.env.VLLM_MANAGER_HOST, "0.0.0.0", "managers.bindHost defaults to all interfaces, as before PUB-23");
  assert.equal(defaults.options.env.VLLM_MANAGER_PORT, String(firstPort));
  assert.equal(defaults.options.env.VLLM_MANAGER_ALLOW_REMOTE, "0");
  assert.equal(defaults.options.cwd, managerRoot);
  assert.deepEqual(defaults.args, ["server.js"]);
  assert.equal(defaults.options.detached, true);

  // The configured bind and port win over the manager's own defaults.
  const written = await configApi.writePlatformConfig({ aiRoot, env: {}, set: { "managers.bindHost": "0.0.0.0", "managers.vllm.port": secondPort }, actor: "test" });
  assert.equal(written.ok, true, JSON.stringify(written.errors));
  await run({});
  assert.equal(spawned[1].options.env.VLLM_MANAGER_HOST, "0.0.0.0");
  assert.equal(spawned[1].options.env.VLLM_MANAGER_PORT, String(secondPort));

  // A per-manager host and env win over the file, as everywhere in the config.
  await run({ VLLM_MANAGER_HOST: "127.0.0.2" });
  assert.equal(spawned[2].options.env.VLLM_MANAGER_HOST, "127.0.0.2");
});
