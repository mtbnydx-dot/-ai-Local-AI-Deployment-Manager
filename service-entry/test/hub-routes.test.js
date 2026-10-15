"use strict";

// Model hub routes (docs/overhaul/03-hub.md §13, §13.1, §14, HUB-1) through
// the real entry: the 05 guard, the viewer registry, the central sendJson
// redaction and signed machine principals. The hub lives in a temp directory;
// every upstream port points at nothing (entry-harness), and the signing key
// is the in-memory entry token of this test process.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../../manager-core/internal-auth");
const { createModelStorage } = require("../../manager-core");
const { createModelHub, defaultSettings } = require("../../manager-core/model-hub");
const hubRoutes = require("../lib/hub-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const LAN = "192.168.1.50";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startHub(t, { corruptSettings = false } = {}) {
  const root = tempDir(t, "hub-routes-");
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const hfCli = path.join(root, "venvs", "download-cli", "Scripts", "hf.exe");
  fs.mkdirSync(path.dirname(hfCli), { recursive: true });
  fs.writeFileSync(hfCli, "");
  if (corruptSettings) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "settings.json"), "{ torn");
  }
  const hub = createModelHub({ aiRoot: root, dataDir, env: {}, hfCli, modelScopeCli: "modelscope", logger: quietLogger(), heartbeatMs: 3_600_000 });
  await hub.start();
  t.after(() => hub.stop());
  return { hub, root, dataDir, settingsFile: path.join(dataDir, "settings.json") };
}

async function mountEntry(t, { hub = null } = {}) {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: quietLogger(), ...(hub ? { hub } : {}) });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  // The console owner is a paired session since PUB-5.
  const owner = await ownerSession(entry, port);
  return { entry, ctx, port, owner, token: entry.security.getTrustToken() };
}

// A request signed in 05's machine form; `sign` overrides what is signed.
function signed(port, method, pathWithQuery, options = {}) {
  const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  const sign = { method, pathWithQuery, principal: options.principal, body: body || "", now: options.now ?? Date.now(), ...(options.sign || {}) };
  const headers = { ...internalAuth.buildMachineHeaders(options.token, sign), ...(options.headers || {}) };
  return request(port, pathWithQuery, { method, headers, peer: options.peer, ...(body !== undefined ? { body } : {}) });
}

function readSettingsFile(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// --- reads ---------------------------------------------------------------------

test("the owner reads the full status and settings; a LAN viewer gets the redacted status", async (t) => {
  const { hub, root, dataDir, settingsFile } = await startHub(t, { corruptSettings: true });
  const { port, owner: session } = await mountEntry(t, { hub });

  const owner = await request(port, "/api/hub/status", { owner: session });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.ok, true);
  assert.equal(owner.json.owner, "hub");
  assert.equal(owner.json.state, "running");
  assert.equal(owner.json.dataDir, dataDir);
  assert.equal(owner.json.cli.hf.path, path.join(root, "venvs", "download-cli", "Scripts", "hf.exe"));
  assert.deepEqual(owner.json.dataErrors.map((error) => [error.name, error.code, error.file]), [["settings.json", "corrupt", settingsFile]]);

  const viewer = await request(port, "/api/hub/status", { peer: LAN });
  assert.equal(viewer.status, 200);
  const expected = JSON.parse(owner.text);
  delete expected.dataDir;
  for (const info of Object.values(expected.cli)) delete info.path;
  for (const error of expected.dataErrors) delete error.file;
  assert.deepEqual(viewer.json, expected, "exactly cli.*.path, dataDir and dataErrors[].file are dropped");
  assert.equal(viewer.text.includes(root), false, "no host path reaches a viewer");
  assert.equal(viewer.text.includes(root.split(path.sep).join("\\\\")), false);

  const head = await request(port, "/api/hub/status", { method: "HEAD", peer: LAN });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");

  const ownerSettings = await request(port, "/api/hub/settings", { owner: session });
  assert.equal(ownerSettings.status, 200);
  assert.deepEqual(ownerSettings.json, { ok: true, settings: defaultSettings() });
  const viewerSettings = await request(port, "/api/hub/settings", { peer: LAN });
  assert.deepEqual(viewerSettings.json, ownerSettings.json, "settings hold no secret; viewers see them as they are");
});

// --- writes --------------------------------------------------------------------

test("the owner saves a partial patch; viewers, invalid patches and bad bodies change nothing", async (t) => {
  const { hub, settingsFile } = await startHub(t);
  const { port, owner } = await mountEntry(t, { hub });

  const saved = await request(port, "/api/hub/settings", { method: "PUT", owner, body: { transfer: { maxConcurrent: 2 } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.settings.transfer.maxConcurrent, 2);
  assert.equal(saved.json.settings.sources.policy, "huggingface", "a patch keeps every other setting");
  assert.deepEqual(readSettingsFile(settingsFile), saved.json.settings);

  const wrapped = await request(port, "/api/hub/settings", { method: "PUT", owner, body: { settings: { queue: { idleOnly: true } } } });
  assert.equal(wrapped.status, 200);
  assert.equal(wrapped.json.settings.queue.idleOnly, true);
  const current = readSettingsFile(settingsFile);

  const lan = await request(port, "/api/hub/settings", { method: "PUT", peer: LAN, body: { transfer: { maxConcurrent: 4 } } });
  assert.equal(lan.status, 401);
  assert.equal(lan.json.error.code, "admin_session_required");

  const invalid = await request(port, "/api/hub/settings", { method: "PUT", owner, body: { transfer: { maxConcurrent: 9 }, sources: { mirrorEndpoint: "http://mirror.example" }, bogus: 1 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.ok, false);
  assert.equal(invalid.json.error.code, "settings_invalid");
  assert.equal(typeof invalid.json.error.message, "string");
  assert.deepEqual(invalid.json.errors.map((error) => [error.field, error.code]), [
    ["transfer.maxConcurrent", "out_of_range"],
    ["sources.mirrorEndpoint", "invalid_format"],
    ["bogus", "unknown_key"],
  ]);
  for (const error of invalid.json.errors) assert.equal(typeof error.message, "string");

  const malformed = await request(port, "/api/hub/settings", { method: "PUT", owner, body: "{ not json" });
  assert.deepEqual([malformed.status, malformed.json.ok, malformed.json.error.code], [400, false, "invalid_json"]);
  const list = await request(port, "/api/hub/settings", { method: "PUT", owner, body: "[1]" });
  assert.deepEqual([list.status, list.json.error.code], [400, "invalid_json"]);
  const oversized = await request(port, "/api/hub/settings", { method: "PUT", owner, body: { pad: "x".repeat(70 * 1024) } });
  assert.deepEqual([oversized.status, oversized.json.error.code], [413, "request_too_large"]);

  const wrongMethod = await request(port, "/api/hub/settings", { method: "POST", owner, body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, "method_not_allowed");
  assert.equal(wrongMethod.headers.allow, "GET, PUT");

  const crossSite = await request(port, "/api/hub/settings", { method: "PUT", owner, headers: { origin: "https://evil.example" }, body: { verify: { sha256: false } } });
  assert.equal(crossSite.status, 403);

  assert.deepEqual(readSettingsFile(settingsFile), current, "no refused request wrote anything");
});

// --- machine principals -------------------------------------------------------

test("a signed hub shim reaches SHIM_ROUTES only; a bad or missing signature never writes", async (t) => {
  const { hub, settingsFile } = await startHub(t);
  const { port, token } = await mountEntry(t, { hub });
  const principal = "system:hub-shim:vllm";

  const read = await signed(port, "GET", "/api/hub/settings", { principal, token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.settings, defaultSettings());

  // The shim's signed body carries origin (03 §15); it is not a setting.
  const write = await signed(port, "PUT", "/api/hub/settings", {
    principal: "system:hub-shim:llama",
    token,
    body: { origin: { kind: "manager-shim", managerId: "llama", clientLocal: true }, sources: { policy: "hf-mirror" } },
  });
  assert.equal(write.status, 200, write.text);
  assert.equal(write.json.settings.sources.policy, "hf-mirror");
  assert.equal(Object.hasOwn(readSettingsFile(settingsFile), "origin"), false);

  const status = await signed(port, "GET", "/api/hub/status", { principal, token });
  assert.equal(status.status, 403);
  assert.deepEqual(status.json, { ok: false, error: { code: "principal_route_forbidden", message: `${principal} may not call GET /api/hub/status.` } });

  const before = readSettingsFile(settingsFile);
  const refused = [
    ["wrong key", { token: "not-the-entry-token-000000" }, 401, "internal_signature_invalid"],
    ["61 s old", { now: Date.now() - 61_000 }, 401, "internal_signature_expired"],
    ["modified body", { sign: { body: JSON.stringify({ transfer: { maxConcurrent: 1 } }) } }, 401, "internal_signature_invalid"],
    ["LAN socket", { peer: LAN }, 401, "internal_signature_invalid"],
  ];
  for (const [label, options, code, errorCode] of refused) {
    const response = await signed(port, "PUT", "/api/hub/settings", { principal, token, body: { transfer: { maxConcurrent: 4 } }, ...options });
    assert.equal(response.status, code, label);
    assert.equal(response.json.error.code, errorCode, label);
  }
  // A bare x-hub-shim header is no credential: from the LAN it is an
  // anonymous viewer, which cannot write.
  const bare = await request(port, "/api/hub/settings", { method: "PUT", peer: LAN, headers: { "x-hub-shim": "vllm" }, body: { transfer: { maxConcurrent: 4 } } });
  assert.equal(bare.status, 401);
  assert.equal(bare.json.error.code, "admin_session_required");
  assert.deepEqual(readSettingsFile(settingsFile), before);
});

test("system:mcp reads the viewer routes, system:cli is the owner and the supervisor reaches no hub route", async (t) => {
  const { hub, dataDir } = await startHub(t);
  const { port, token } = await mountEntry(t, { hub });

  const mcp = await signed(port, "GET", "/api/hub/status", { principal: "system:mcp", token });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.json.dataDir, dataDir, "05 serves system:mcp viewer routes unredacted");
  const mcpWrite = await signed(port, "PUT", "/api/hub/settings", { principal: "system:mcp", token, body: { verify: { sha256: false } } });
  assert.deepEqual([mcpWrite.status, mcpWrite.json.error.code], [403, "principal_scope_denied"]);

  const cli = await signed(port, "PUT", "/api/hub/settings", { principal: "system:cli", token, body: { verify: { sha256: false } } });
  assert.equal(cli.status, 200);
  assert.equal(cli.json.settings.verify.sha256, false);

  const supervisor = await signed(port, "GET", "/api/hub/status", { principal: "system:supervisor", token });
  assert.deepEqual([supervisor.status, supervisor.json.error.code], [403, "principal_scope_denied"]);
});

test("proxied requests never reach the hub routes", async (t) => {
  const { hub } = await startHub(t);
  const { port } = await mountEntry(t, { hub });
  for (const [method, body] of [["GET", undefined], ["PUT", { verify: { sha256: false } }]]) {
    const response = await request(port, method === "GET" ? "/api/hub/status" : "/api/hub/settings", { method, body, headers: { "x-forwarded-for": "203.0.113.7" } });
    assert.equal(response.status, 404);
    assert.equal(response.json.code, "public_proxy_gateway_only");
  }
});

// --- registration and mounting ---------------------------------------------------

test("the mount registers the viewer routes and events, declares the writes owner-only and turns on features.hub", async (t) => {
  const { hub } = await startHub(t);
  const { entry, ctx } = await mountEntry(t, { hub });
  assert.ok(entry.ROUTE_MODULES.includes("./lib/hub-routes"));
  assert.ok(entry.ROUTE_MODULES.indexOf("./lib/hub-routes") > entry.ROUTE_MODULES.indexOf("./lib/manager-event-relay"));
  assert.equal(ctx.features.hub, true);

  const registry = ctx.auth.viewerRegistry;
  const status = registry.match("GET", "/api/hub/status");
  assert.deepEqual([status.access, status.entry.owner], ["viewer", "03"]);
  assert.equal(status.entry.redact, hubRoutes.redactHubStatusForViewer);
  const settings = registry.match("GET", "/api/hub/settings");
  assert.deepEqual([settings.access, settings.entry.redact], ["viewer", null]);
  assert.deepEqual(registry.inventory().filter((item) => item.path.startsWith("/api/hub/")), [
    { owner: "03", method: "GET", path: "/api/hub/status", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/settings", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/library", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/library/:id", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/tasks/:id", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/storage/usage", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/auth/huggingface", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/auth/huggingface/access", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/downloads", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/downloads/history", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/downloads/:id", access: "viewer" },
    { owner: "03", method: "GET", path: "/api/hub/downloads/:id/resume-check", access: "viewer" },
    { owner: "03", method: "PUT", path: "/api/hub/settings", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/rescan", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/:id/verify", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/:id/identify", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/:id/check-update", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/:id/update", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/:id/import", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/library/:id/cleanup-residue", access: "admin" },
    { owner: "03", method: "DELETE", path: "/api/hub/library/:id", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/storage/cleanup", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/auth/huggingface/login", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/sources/probe", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/reorder", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/pause-all", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/resume-all", access: "admin" },
    { owner: "03", method: "DELETE", path: "/api/hub/downloads/:id", access: "admin" },
    { owner: "03", method: "GET", path: "/api/hub/downloads/:id/logs", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/:id/pause", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/:id/resume", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/:id/retry", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/:id/start-now", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/:id/cancel", access: "admin" },
    { owner: "03", method: "POST", path: "/api/hub/downloads/:id/priority", access: "admin" },
  ]);
  assert.deepEqual(registry.inventory().filter((item) => item.method === "EVENT" && (item.path === "library" || item.path === "downloads")), [
    { owner: "03", method: "EVENT", path: "library", access: "viewer" },
    { owner: "03", method: "EVENT", path: "downloads", access: "viewer" },
  ]);

  // HUB_VIEWER_ROUTES (or the owner-only list) covers every GET the module
  // serves, and the shim list names served routes only.
  const key = (route) => `${route.method} ${route.path}`;
  const declared = new Set([...hubRoutes.HUB_VIEWER_ROUTES, ...hubRoutes.HUB_ADMIN_ONLY_ROUTES].map(key));
  for (const route of hubRoutes.HUB_ROUTES.filter((item) => item.method === "GET")) assert.ok(declared.has(key(route)), key(route));
  const served = new Set(hubRoutes.HUB_ROUTES.map(key));
  for (const route of hubRoutes.SHIM_ROUTES) assert.ok(served.has(key(route)), key(route));
});

test("without a hub the routes answer 503 hub_unavailable, features.hub stays off and other hub paths fall through", async (t) => {
  const { ctx, port, owner } = await mountEntry(t);
  assert.equal(ctx.features.hub, false);
  assert.equal(ctx.auth.viewerRegistry.match("GET", "/api/hub/status").access, "viewer", "the registrations do not depend on the hub");
  for (const [method, target] of [["GET", "/api/hub/status"], ["GET", "/api/hub/settings"], ["PUT", "/api/hub/settings"], ["GET", "/api/hub/downloads"], ["POST", "/api/hub/downloads"]]) {
    const response = await request(port, target, { method, owner, ...(method !== "GET" ? { body: {} } : {}) });
    assert.equal(response.status, 503, `${method} ${target}`);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.error.code, "hub_unavailable");
    assert.equal(typeof response.json.error.hint, "string");
  }
  const later = await request(port, "/api/hub/search", { owner });
  assert.equal(later.status, 404, "a route of a later package is not answered here");
  assert.deepEqual(later.json, { error: "Not found" });
});

// --- module units ---------------------------------------------------------------

test("redactHubStatusForViewer drops exactly cli paths, dataDir and dataErrors[].file", () => {
  const body = {
    ok: true,
    owner: "hub",
    cli: { hf: { path: "C:\\tools\\hf.exe", found: true, version: null }, modelscope: { path: "modelscope", found: null, version: null } },
    dataDir: "C:\\data\\hub",
    dataErrors: [{ file: "C:\\data\\hub\\settings.json", name: "settings.json", code: "corrupt", message: "settings.json is not valid JSON." }],
    configErrors: [],
  };
  const copy = JSON.parse(JSON.stringify(body));
  assert.deepEqual(hubRoutes.redactHubStatusForViewer(body), {
    ok: true,
    owner: "hub",
    cli: { hf: { found: true, version: null }, modelscope: { found: null, version: null } },
    dataErrors: [{ name: "settings.json", code: "corrupt", message: "settings.json is not valid JSON." }],
    configErrors: [],
  });
  assert.deepEqual(body, copy, "the redaction builds a new value");
});

test("createHubRoutes redacts for a viewer that did not pass the entry guard and refuses unknown callers", async () => {
  const sent = [];
  const fakeAuth = (role, extra = {}) => ({
    principal: () => ({ role, principal: role === "viewer" ? "lan" : "", redact: role !== "owner" }),
    checkWrite: () => ({ ok: false, status: 403, code: "management_local_only", message: "Owner only." }),
    viewerRegistry: { match: (method, pathname) => (pathname === "/api/hub/status" ? { access: "viewer", entry: { redact: hubRoutes.redactHubStatusForViewer }, params: {} } : null) },
    redactFor: (req, pathname, body) => hubRoutes.redactHubStatusForViewer(body),
    ...extra,
  });
  const hub = { status: () => ({ ok: true, dataDir: "C:\\data\\hub", cli: {}, dataErrors: [] }), settings: { get: async () => ({}), update: async () => ({ ok: true, settings: {} }) } };
  const sendJson = (res, data, status = 200) => sent.push({ status, data });
  const fakeReq = (method) => ({ method, headers: {}, resume() {} });
  const url = (pathname) => new URL(pathname, "http://127.0.0.1");

  const viewerRoutes = hubRoutes.createHubRoutes({ hub, auth: fakeAuth("viewer"), sendJson });
  assert.equal(await viewerRoutes.handle(fakeReq("GET"), {}, url("/api/hub/status")), true);
  assert.deepEqual(sent.pop(), { status: 200, data: { ok: true, cli: {}, dataErrors: [] } });
  assert.equal(await viewerRoutes.handle(fakeReq("PUT"), {}, url("/api/hub/settings")), true);
  assert.deepEqual([sent.at(-1).status, sent.pop().data.error.code], [403, "management_local_only"]);
  assert.equal(await viewerRoutes.handle(fakeReq("GET"), {}, url("/api/hub/settings")), true);
  assert.deepEqual([sent.at(-1).status, sent.pop().data.error.code], [401, "admin_session_required"], "an unregistered read stays owner-only");

  const nobody = hubRoutes.createHubRoutes({ hub, auth: fakeAuth("none"), sendJson });
  await nobody.handle(fakeReq("GET"), {}, url("/api/hub/status"));
  assert.deepEqual([sent.at(-1).status, sent.pop().data.error.code], [401, "admin_session_required"]);

  assert.equal(await viewerRoutes.handle(fakeReq("GET"), {}, url("/api/hub/unknown")), false);
  assert.equal(await viewerRoutes.handle(fakeReq("GET"), {}, url("/gateway/x")), false);
  assert.equal(await viewerRoutes.handle(fakeReq("GET"), {}, url("/api/hubx/status")), false);
  assert.deepEqual(sent, []);
});

// --- shutdown --------------------------------------------------------------------

test("shutdownSoon stops the hub before the process exits, and a hung stop cannot block the exit", async (t) => {
  const { entry } = await loadEntry();
  const order = [];
  const hub = { stop: async ({ reason }) => { order.push(`stop:${reason}`); } };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shutdown did not exit")), 5000);
    entry.shutdownSoon({ server: null, hub, delayMs: 0, graceMs: 200, exit: (code) => { clearTimeout(timer); order.push(`exit:${code}`); resolve(); } });
  });
  assert.deepEqual(order, ["stop:shutdown", "exit:0"]);

  const hung = { stop: () => new Promise(() => {}) };
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("a hung hub blocked the exit")), 5000);
    entry.shutdownSoon({ server: null, hub: hung, delayMs: 0, graceMs: 200, exit: (value) => { clearTimeout(timer); resolve(value); } });
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 4000);

  // A real hub is flushed and stopped.
  const real = await startHub(t);
  await new Promise((resolve) => entry.shutdownSoon({ server: null, hub: real.hub, delayMs: 0, graceMs: 2000, exit: resolve }));
  assert.equal(real.hub.state, "stopped");
  assert.equal(JSON.parse(fs.readFileSync(path.join(real.dataDir, "downloads.json"), "utf8")).writerPid, process.pid);
});

// --- downloads (HUB-7, 03 §13) ------------------------------------------------------

const FAKE_HF_TOKEN = "hf_fakeRouteTokenForTestsOnly0000000";

// A transfer engine that never spawns; a test ends an attempt with exit(code).
function fakeTransferEngine() {
  const started = [];
  return {
    started,
    start(job, hooks) {
      const handle = {
        jobId: job.id,
        stopReason: null,
        done: false,
        exit(code = 0) {
          if (handle.done) return;
          handle.done = true;
          hooks.onExit({ code, stopReason: handle.stopReason, stderrTail: [] });
        },
        stop(reason) {
          handle.stopReason = handle.stopReason || reason;
          setImmediate(() => handle.exit(null));
          return Promise.resolve();
        },
        stderrTail: () => [],
      };
      started.push(handle);
      hooks.onSpawn({ pid: 4321, startedAt: new Date().toISOString() });
      hooks.onLine("stdout", `fake transfer of ${job.artifact.repo}`);
      return handle;
    },
    async findOrphans() {
      return [];
    },
  };
}

function fakeManifest(repo) {
  return {
    repo,
    revision: "main",
    revisionSha: "d".repeat(40),
    gated: false,
    files: [
      { path: "Model-Q4_K_M.gguf", size: 4096, sha256: "e".repeat(64) },
      { path: "Model-Q8_0.gguf", size: 8192, sha256: "f".repeat(64) },
      { path: "README.md", size: 10, sha256: null },
    ],
  };
}

async function startDownloadHub(t) {
  const root = tempDir(t, "hub-downloads-");
  const models = path.join(root, "models");
  fs.mkdirSync(models, { recursive: true });
  const engine = fakeTransferEngine();
  const providers = { forNamespace: () => ({ getRepo: async (repo) => fakeManifest(repo) }), get: () => null };
  const modelStorage = createModelStorage({ modelsRoot: models, file: path.join(root, "service-entry", "data", "model-storage.json") });
  const hub = createModelHub({
    aiRoot: root,
    dataDir: path.join(root, "service-entry", "data", "hub"),
    env: {},
    hfCli: "hf",
    modelScopeCli: "modelscope",
    logger: quietLogger(),
    heartbeatMs: 3_600_000,
    transferEngine: engine,
    providers,
    modelStorage,
    disk: { volumeOf: () => "X:", freeBytes: async () => 1e12, reserveBytes: () => 0 },
    verifier: { verifyArtifact: async () => ({ ok: true, verifiedFiles: [] }) },
    readConfig: () => ({ downloadsOwner: "hub", source: "default", errors: [] }),
  });
  await hub.start();
  t.after(() => hub.stop());
  return { hub, root, models, engine };
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

function escapedPath(value) {
  return JSON.stringify(value).slice(1, -1);
}

test("download routes: enqueue, list, detail, history, logs, resume-check and every queue operation, with viewer redaction", async (t) => {
  const { hub, root, models, engine } = await startDownloadHub(t);
  const { port, owner, ctx } = await mountEntry(t, { hub });
  const plan = { provider: "huggingface", repo: "org/Model-GGUF", selection: { artifactKey: "gguf:|Q4_K_M" } };

  // Viewers never write; the owner enqueues (201) with a token that only the vault keeps.
  const viewerWrite = await request(port, "/api/hub/downloads", { method: "POST", peer: LAN, body: plan });
  assert.equal(viewerWrite.status, 401);
  const created = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { ...plan, credential: { hfToken: FAKE_HF_TOKEN } } });
  assert.equal(created.status, 201, created.text);
  const job = created.json.job;
  assert.equal(job.origin.kind, "console");
  assert.equal(job.transfer.options.credentialMode, "temp-token");
  assert.equal(created.text.includes(FAKE_HF_TOKEN), false, "no token in any response");
  await until(() => engine.started.length === 1);

  const duplicate = await request(port, "/api/hub/downloads", { method: "POST", owner, body: plan });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, "already_downloading");
  assert.equal(duplicate.json.error.details.existingJobId, job.id);
  const bad = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { repo: "org/Model-GGUF", selection: { artifactKey: "gguf:|NOPE" } } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.ok, false);
  const lanToken = await request(port, "/api/hub/downloads", { method: "POST", peer: LAN, owner, body: { ...plan, credential: { hfToken: FAKE_HF_TOKEN } } });
  assert.ok([401, 403].includes(lanToken.status), "a LAN caller never sends a token");

  // Owner reads are complete; viewer reads are redacted.
  const ownerList = await request(port, "/api/hub/downloads", { owner });
  assert.equal(ownerList.status, 200);
  const ownerJob = ownerList.json.jobs.find((item) => item.id === job.id);
  assert.equal(ownerJob.target.localDir, path.join(models, "org-Model-GGUF"));
  assert.equal(ownerJob.transfer.pid, 4321);
  assert.match(ownerJob.transfer.options.tokenRef, /^dlt_/);
  assert.equal(ownerList.json.aggregate.activeCount, 1);
  const viewerList = await request(port, "/api/hub/downloads", { peer: LAN });
  assert.equal(viewerList.status, 200);
  const viewerJob = viewerList.json.jobs.find((item) => item.id === job.id);
  assert.equal(viewerJob.target.localDir, `${ownerJob.target.rootLabel}/org-Model-GGUF`);
  assert.equal(Object.hasOwn(viewerJob.transfer, "pid"), false);
  assert.equal(Object.hasOwn(viewerJob.transfer.options, "tokenRef"), false);
  assert.equal(viewerList.text.includes(root), false, "no host path reaches a viewer");
  assert.equal(viewerList.text.includes(escapedPath(root)), false);
  const viewerDetail = await request(port, `/api/hub/downloads/${job.id}`, { peer: LAN });
  assert.equal(viewerDetail.status, 200);
  assert.equal(viewerDetail.json.job.target.localDir, viewerJob.target.localDir);
  assert.equal((await request(port, "/api/hub/downloads/dl_nosuchjobnosuchj", { owner })).status, 404);
  assert.equal((await request(port, "/api/hub/downloads?state=bogus", { owner })).status, 400);

  // Logs are owner-only; the resume check is root-relative for viewers.
  const logs = await request(port, `/api/hub/downloads/${job.id}/logs?tail=5`, { owner });
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.lines) && logs.json.total >= 1);
  assert.equal((await request(port, `/api/hub/downloads/${job.id}/logs`, { peer: LAN })).status, 401);
  const ownerCheck = await request(port, `/api/hub/downloads/${job.id}/resume-check`, { owner });
  assert.equal(ownerCheck.status, 200);
  assert.equal(ownerCheck.json.localDir, path.join(models, "org-Model-GGUF"));
  const viewerCheck = await request(port, `/api/hub/downloads/${job.id}/resume-check`, { peer: LAN });
  assert.equal(viewerCheck.json.localDir, viewerJob.target.localDir);
  assert.equal(viewerCheck.text.includes(escapedPath(root)), false);

  // Queue operations.
  const second = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { ...plan, selection: { artifactKey: "gguf:|Q8_0" }, target: { outputName: "second" } } });
  assert.equal(second.status, 201, second.text);
  const third = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { ...plan, selection: { artifactKey: "gguf:|Q8_0" }, target: { outputName: "third" } } });
  const secondId = second.json.job.id;
  const thirdId = third.json.job.id;
  const reordered = await request(port, "/api/hub/downloads/reorder", { method: "POST", owner, body: { ids: [thirdId, secondId] } });
  assert.equal(reordered.status, 200, reordered.text);
  assert.ok(reordered.json.jobs[0].queueOrder < reordered.json.jobs[1].queueOrder);
  assert.equal((await request(port, "/api/hub/downloads/reorder", { method: "POST", owner, body: { ids: "x" } })).status, 400);
  const priority = await request(port, `/api/hub/downloads/${secondId}/priority`, { method: "POST", owner, body: { priority: "high" } });
  assert.equal(priority.json.job.priority, "high");
  const startNow = await request(port, `/api/hub/downloads/${thirdId}/start-now`, { method: "POST", owner, body: { force: true } });
  assert.equal(startNow.status, 200, startNow.text);
  await until(() => engine.started.length === 2);
  const paused = await request(port, `/api/hub/downloads/${job.id}/pause`, { method: "POST", owner, body: {} });
  assert.equal(paused.json.job.state, "paused");
  const resumed = await request(port, `/api/hub/downloads/${job.id}/resume`, { method: "POST", owner, body: { refreshTransferOptions: true } });
  assert.equal(resumed.status, 200, resumed.text);
  assert.ok(["queued", "waiting", "resolving", "downloading"].includes(resumed.json.job.state));
  assert.equal((await request(port, `/api/hub/downloads/${job.id}/resume`, { method: "POST", owner, body: { refreshTransferOptions: "yes" } })).status, 400);
  const retryActive = await request(port, `/api/hub/downloads/${job.id}/retry`, { method: "POST", owner, body: {} });
  assert.equal(retryActive.status, 409);
  assert.equal(retryActive.json.error.code, "invalid_state");
  const pauseAll = await request(port, "/api/hub/downloads/pause-all", { method: "POST", owner, body: {} });
  assert.equal(pauseAll.status, 200);
  assert.equal(pauseAll.json.affected, 3);
  const resumeAll = await request(port, "/api/hub/downloads/resume-all", { method: "POST", owner, body: {} });
  assert.equal(resumeAll.json.affected, 3);

  const wrongConfirm = await request(port, `/api/hub/downloads/${secondId}/cancel`, { method: "POST", owner, body: { deletePartial: true, confirm: "nope" } });
  assert.equal(wrongConfirm.status, 400);
  assert.equal(wrongConfirm.json.error.code, "confirm_required");
  const cancelled = await request(port, `/api/hub/downloads/${secondId}/cancel`, { method: "POST", owner, body: { deletePartial: true, confirm: "second" } });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.job.state, "cancelled");
  assert.equal(typeof cancelled.json.reclaimedBytes, "number");
  assert.equal(fs.existsSync(path.join(models, "second")), false);
  const terminal = await request(port, "/api/hub/downloads?include=terminal", { owner });
  assert.ok(terminal.json.jobs.some((item) => item.id === secondId));
  assert.equal((await request(port, "/api/hub/downloads", { owner })).json.jobs.some((item) => item.id === secondId), false);
  assert.equal((await request(port, `/api/hub/downloads/${secondId}`, { method: "DELETE", peer: LAN })).status, 401);
  const removed = await request(port, `/api/hub/downloads/${secondId}`, { method: "DELETE", owner });
  assert.deepEqual(removed.json, { ok: true });
  const history = await request(port, "/api/hub/downloads/history", { owner });
  assert.equal(history.status, 200);
  assert.equal(history.json.records[0].id, secondId);
  const viewerHistory = await request(port, "/api/hub/downloads/history?q=second", { peer: LAN });
  assert.equal(viewerHistory.json.records[0].target.localDir, `${ownerJob.target.rootLabel}/second`);
  assert.equal(viewerHistory.text.includes(escapedPath(root)), false);

  // The downloads event reaches viewers through the registered redactor.
  const event = { kind: "job", jobs: [ownerJob], aggregate: ownerList.json.aggregate };
  const redacted = ctx.auth.viewerRegistry.redactEvent("downloads", JSON.parse(JSON.stringify(event)), {});
  assert.equal(redacted.jobs[0].target.localDir, viewerJob.target.localDir);
  assert.equal(Object.hasOwn(redacted.jobs[0].transfer, "pid"), false);
  assert.equal(JSON.stringify(redacted).includes(escapedPath(root)), false);
});

test("a signed shim enqueues as manager-shim and reaches only the shim download routes", async (t) => {
  const { hub, engine } = await startDownloadHub(t);
  const { port, token } = await mountEntry(t, { hub });
  const principal = "system:hub-shim:llama";
  const body = { provider: "huggingface", repo: "org/Shim-GGUF", selection: { artifactKey: "gguf:|Q4_K_M" }, origin: { kind: "console", managerId: "vllm", clientLocal: false } };
  const created = await signed(port, "POST", "/api/hub/downloads", { principal, token, body });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual([created.json.job.origin.kind, created.json.job.origin.managerId, created.json.job.ownerManagerId], ["manager-shim", "llama", "llama"]);
  await until(() => engine.started.length === 1);
  const list = await signed(port, "GET", "/api/hub/downloads?owner=llama&include=terminal&limit=60", { principal, token });
  assert.equal(list.status, 200);
  assert.equal(list.json.jobs.length, 1);
  const id = created.json.job.id;
  assert.equal((await signed(port, "GET", `/api/hub/downloads/${id}/logs`, { principal, token })).status, 200);
  const forbidden = await signed(port, "POST", `/api/hub/downloads/${id}/start-now`, { principal, token, body: {} });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, "principal_route_forbidden");
  const noToken = await signed(port, "POST", "/api/hub/downloads", { principal, token, body: { ...body, repo: "org/Other-GGUF", credential: { hfToken: FAKE_HF_TOKEN } } });
  assert.equal(noToken.status, 403, "clientLocal false never forwards a token");
  assert.equal(noToken.json.error.code, "token_requires_local");
  const cancel = await signed(port, "POST", `/api/hub/downloads/${id}/cancel`, { principal, token, body: {} });
  assert.equal(cancel.status, 200, cancel.text);
});

test("the rollback flag (hub.downloadsOwner = manager) makes POST /api/hub/downloads answer 409 hub_disabled (HUB-12)", async (t) => {
  const root = tempDir(t, "hub-routes-rollback-");
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const hub = createModelHub({ aiRoot: root, dataDir, env: { AI_HUB_DOWNLOADS_OWNER: "manager" }, modelScopeCli: "modelscope", logger: quietLogger(), heartbeatMs: 3_600_000 });
  await hub.start();
  t.after(() => hub.stop());
  const { port, owner } = await mountEntry(t, { hub });
  const response = await request(port, "/api/hub/downloads", { method: "POST", owner, body: { provider: "huggingface", repo: "org/Model-GGUF" } });
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.error.code, "hub_disabled");
});
