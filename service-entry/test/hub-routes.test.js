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
const { createModelHub, defaultSettings } = require("../../manager-core/model-hub");
const hubRoutes = require("../lib/hub-routes");
const { loadEntry, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

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
  return { entry, ctx, port, token: entry.security.getTrustToken() };
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
  const { port } = await mountEntry(t, { hub });

  const owner = await request(port, "/api/hub/status");
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

  const ownerSettings = await request(port, "/api/hub/settings");
  assert.equal(ownerSettings.status, 200);
  assert.deepEqual(ownerSettings.json, { ok: true, settings: defaultSettings() });
  const viewerSettings = await request(port, "/api/hub/settings", { peer: LAN });
  assert.deepEqual(viewerSettings.json, ownerSettings.json, "settings hold no secret; viewers see them as they are");
});

// --- writes --------------------------------------------------------------------

test("the owner saves a partial patch; viewers, invalid patches and bad bodies change nothing", async (t) => {
  const { hub, settingsFile } = await startHub(t);
  const { port } = await mountEntry(t, { hub });

  const saved = await request(port, "/api/hub/settings", { method: "PUT", body: { transfer: { maxConcurrent: 2 } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.settings.transfer.maxConcurrent, 2);
  assert.equal(saved.json.settings.sources.policy, "huggingface", "a patch keeps every other setting");
  assert.deepEqual(readSettingsFile(settingsFile), saved.json.settings);

  const wrapped = await request(port, "/api/hub/settings", { method: "PUT", body: { settings: { queue: { idleOnly: true } } } });
  assert.equal(wrapped.status, 200);
  assert.equal(wrapped.json.settings.queue.idleOnly, true);
  const current = readSettingsFile(settingsFile);

  const lan = await request(port, "/api/hub/settings", { method: "PUT", peer: LAN, body: { transfer: { maxConcurrent: 4 } } });
  assert.equal(lan.status, 401);
  assert.equal(lan.json.error.code, "admin_session_required");

  const invalid = await request(port, "/api/hub/settings", { method: "PUT", body: { transfer: { maxConcurrent: 9 }, sources: { mirrorEndpoint: "http://mirror.example" }, bogus: 1 } });
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

  const malformed = await request(port, "/api/hub/settings", { method: "PUT", body: "{ not json" });
  assert.deepEqual([malformed.status, malformed.json.ok, malformed.json.error.code], [400, false, "invalid_json"]);
  const list = await request(port, "/api/hub/settings", { method: "PUT", body: "[1]" });
  assert.deepEqual([list.status, list.json.error.code], [400, "invalid_json"]);
  const oversized = await request(port, "/api/hub/settings", { method: "PUT", body: { pad: "x".repeat(70 * 1024) } });
  assert.deepEqual([oversized.status, oversized.json.error.code], [413, "request_too_large"]);

  const wrongMethod = await request(port, "/api/hub/settings", { method: "POST", body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, "method_not_allowed");
  assert.equal(wrongMethod.headers.allow, "GET, PUT");

  const crossSite = await request(port, "/api/hub/settings", { method: "PUT", headers: { origin: "https://evil.example" }, body: { verify: { sha256: false } } });
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

test("the mount registers both routes for viewers, declares PUT owner-only and turns on features.hub", async (t) => {
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
    { owner: "03", method: "PUT", path: "/api/hub/settings", access: "admin" },
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
  const { ctx, port } = await mountEntry(t);
  assert.equal(ctx.features.hub, false);
  assert.equal(ctx.auth.viewerRegistry.match("GET", "/api/hub/status").access, "viewer", "the registrations do not depend on the hub");
  for (const [method, target] of [["GET", "/api/hub/status"], ["GET", "/api/hub/settings"], ["PUT", "/api/hub/settings"]]) {
    const response = await request(port, target, { method, ...(method === "PUT" ? { body: {} } : {}) });
    assert.equal(response.status, 503, `${method} ${target}`);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.error.code, "hub_unavailable");
    assert.equal(typeof response.json.error.hint, "string");
  }
  const later = await request(port, "/api/hub/downloads");
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
