"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../../manager-core/internal-auth");
const { createMachineAuth, machineEventTypes, machineScopeAllows } = require("../lib/machine-auth");
const { createViewerRegistry } = require("../lib/viewer-allowlist");
const entryCall = require("../scripts/entry-call");
const { loadEntry, quietLogger, request, serveEntry, spyModule } = require("./helpers/entry-harness");

// 05 §5.7: machine principals on the ADMIN listener. Every request here goes
// to an in-process entry on an ephemeral port; shutdown-like routes are
// answered by a spy module, so nothing ever stops. Hub-scope requests use
// /api/hub/spy-downloads, which no hub route serves (HUB-7 answers
// /api/hub/downloads itself), so they reach the spy.

const LAN = "192.168.1.50";
const SPY_CLAIMS = [
  "/api/hub/",
  "/api/hub",
  "/api/manager/shutdown",
  "/api/shutdown",
  "/api/platform/busy",
  "/api/stop-all",
  "/api/session/pair-codes",
  "/api/session/list",
  "/api/audit/",
  "/api/telemetry/requests",
];

function tempRoot(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function mountEntry(t) {
  const { entry } = await loadEntry();
  const spy = spyModule(SPY_CLAIMS);
  const ctx = entry.createRouteContext({ logger: quietLogger() });
  // The spy stands in for the platform module (OPS-13), whose own tests cover
  // /api/platform/busy; the scope table is what this file asserts.
  const modules = entry.ROUTE_MODULES.filter((spec) => spec !== "./lib/platform-routes");
  const routes = await entry.mountRouteModules({ ctx, modules: [...modules, spy] });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  return { entry, ctx, spy, port, token: entry.security.getTrustToken() };
}

// A request signed in the machine form. `sign` overrides what is signed, so
// a test can sign one thing and send another.
function signed(port, method, pathWithQuery, options = {}) {
  const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  const sign = { method, pathWithQuery, principal: options.principal, body: body || "", now: options.now ?? Date.now(), ...(options.sign || {}) };
  const headers = { ...internalAuth.buildMachineHeaders(options.token, sign), ...(options.headers || {}) };
  return request(port, pathWithQuery, { method, headers, peer: options.peer, ...(body !== undefined ? { body } : {}) });
}

// --- the scope and event-type tables -------------------------------------------

test("the principal × route scope matrix of 05 §5.7", async () => {
  const { entry } = await loadEntry();
  const registry = createViewerRegistry();
  entry.registerEntryRoutes(registry);
  const cases = [
    ["system:hub-shim:vllm", "GET", "/api/hub/downloads", true],
    ["system:hub-shim:llama", "POST", "/api/hub/downloads", true],
    ["system:hub-shim:vllm", "DELETE", "/api/hub/downloads/dl_1", true],
    ["system:hub-shim:vllm", "GET", "/api/hub", true],
    ["system:hub-shim:llama", "GET", "/api/events?types=downloads", true],
    ["system:hub-shim:vllm", "GET", "/api/hubs", false],
    ["system:hub-shim:vllm", "POST", "/api/events", false],
    ["system:hub-shim:vllm", "GET", "/api/status", false],
    ["system:hub-shim:llama", "POST", "/api/manager/shutdown", false],
    ["system:supervisor", "POST", "/api/shutdown", true],
    ["system:supervisor", "POST", "/api/manager/shutdown", true],
    ["system:supervisor", "GET", "/api/platform/busy", true],
    ["system:supervisor", "GET", "/api/status", true],
    ["system:supervisor", "HEAD", "/api/status", true],
    ["system:supervisor", "GET", "/api/events?client=supervisor", true],
    ["system:supervisor", "GET", "/api/events?client=console", false],
    ["system:supervisor", "GET", "/api/events/recent", false],
    ["system:supervisor", "GET", "/api/fleet", false],
    ["system:supervisor", "GET", "/api/shutdown", false],
    ["system:supervisor", "POST", "/api/stop-all", false],
    ["system:cli", "POST", "/api/stop-all", true],
    ["system:cli", "GET", "/api/keys", true],
    ["system:cli", "POST", "/api/managers/vllm/start", true],
    ["system:cli", "POST", "/api/session/pair-codes", true],
    ["system:cli", "GET", "/api/events", true],
    ["system:cli", "GET", "/api/session/list", false],
    ["system:cli", "DELETE", "/api/session/abcd1234", false],
    ["system:cli", "GET", "/api/billing", false],
    ["system:cli", "GET", "/api/billing/overview", false],
    ["system:cli", "GET", "/api/audit/sessions", false],
    ["system:cli", "GET", "/api/telemetry/requests?limit=5", false],
    ["system:cli", "GET", "/api/telemetry/requests/req_1", false],
    ["system:cli", "GET", "/billing", false],
    ["system:cli", "GET", "/", false],
    ["system:mcp", "GET", "/api/status", true],
    ["system:mcp", "GET", "/api/fleet", true],
    ["system:mcp", "POST", "/api/fleet/route-preview", true],
    ["system:mcp", "GET", "/api/security", true],
    ["system:mcp", "GET", "/api/keys", false],
    ["system:mcp", "POST", "/api/fleet/settings", false],
    ["system:mcp", "GET", "/api/hub/downloads", false],
    ["system:mcp", "POST", "/api/manager/shutdown", false],
    ["system:root", "GET", "/api/status", false],
  ];
  for (const [principal, method, target, expected] of cases) {
    assert.equal(machineScopeAllows(principal, method, new URL(target, "http://127.0.0.1"), registry), expected, `${principal} ${method} ${target}`);
  }
  assert.equal(machineScopeAllows("system:mcp", "GET", new URL("http://127.0.0.1/api/status")), false, "without a registry system:mcp reaches nothing");

  assert.deepEqual([...machineEventTypes("system:hub-shim:vllm")].sort(), ["downloads", "jobs", "library"]);
  assert.deepEqual([...machineEventTypes("system:supervisor")].sort(), ["alerts", "notification", "platform", "status"]);
  assert.equal(machineEventTypes("system:cli"), "*");
  assert.deepEqual([...machineEventTypes("system:mcp")], []);
  assert.deepEqual([...machineEventTypes("system:root")], []);
});

// --- the guard through the real entry ------------------------------------------

test("signed principals reach exactly their scope; out of scope is 403 principal_scope_denied", async (t) => {
  const { spy, port, token } = await mountEntry(t);
  const allowed = [
    ["system:hub-shim:vllm", "GET", "/api/hub/spy-downloads"],
    ["system:hub-shim:llama", "POST", "/api/hub/spy-downloads", { repo: "demo/model" }],
    ["system:supervisor", "POST", "/api/manager/shutdown"],
    ["system:supervisor", "POST", "/api/shutdown"],
    ["system:supervisor", "GET", "/api/platform/busy"],
    ["system:cli", "POST", "/api/stop-all", {}],
  ];
  for (const [principal, method, target, body] of allowed) {
    const response = await signed(port, method, target, { principal, token, body });
    assert.equal(response.status, 200, `${principal} ${method} ${target}: ${response.text}`);
    const seen = spy.seen.at(-1);
    assert.deepEqual({ path: seen.path, role: seen.role, principal: seen.principal }, { path: target, role: "system", principal });
    if (body !== undefined) assert.deepEqual(seen.body, body, "the route reads the pre-read body");
  }

  const denied = [
    ["system:hub-shim:llama", "GET", "/api/status"],
    ["system:hub-shim:vllm", "POST", "/api/manager/shutdown"],
    ["system:supervisor", "POST", "/api/stop-all"],
    ["system:supervisor", "GET", "/api/fleet"],
    ["system:cli", "GET", "/api/billing/overview"],
    ["system:cli", "GET", "/api/audit/sessions"],
    ["system:cli", "GET", "/api/telemetry/requests"],
    ["system:cli", "GET", "/api/session/list"],
    ["system:cli", "GET", "/billing"],
    ["system:mcp", "GET", "/api/keys"],
    ["system:mcp", "POST", "/api/hub/spy-downloads"],
  ];
  const before = spy.seen.length;
  for (const [principal, method, target] of denied) {
    const response = await signed(port, method, target, { principal, token, ...(method === "POST" ? { body: {} } : {}) });
    assert.equal(response.status, 403, `${principal} ${method} ${target}`);
    assert.equal(response.json.error.code, "principal_scope_denied");
  }
  assert.equal(spy.seen.length, before, "no out-of-scope call reached a route");

  // The CLI mints pair codes (the session API answers before any module).
  const minted = await signed(port, "POST", "/api/session/pair-codes", { principal: "system:cli", token, body: { ttlSeconds: 120 } });
  assert.equal(minted.status, 200, minted.text);
  assert.match(minted.json.url, /^http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Z2-7]{10}$/);

  // Real routes: the CLI is owner-equivalent, system:mcp reads viewer routes
  // unredacted and its signed POST body reaches the route preview.
  assert.equal((await signed(port, "GET", "/api/keys", { principal: "system:cli", token })).status, 200);
  const status = await signed(port, "GET", "/api/status", { principal: "system:supervisor", token });
  assert.equal(status.status, 200);
  assert.equal(typeof status.json.entry.pid, "number", "the supervisor reads the status unredacted");
  const preview = await signed(port, "POST", "/api/fleet/route-preview", { principal: "system:mcp", token, body: { model: "demo-model" } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.request.requestedModel, "demo-model");
  assert.equal(preview.json.request.path, "v1/chat/completions", "system:mcp gets the body unredacted");
  const fleet = await signed(port, "GET", "/api/fleet", { principal: "system:mcp", token });
  assert.equal(fleet.status, 200);
  assert.ok(Object.hasOwn(fleet.json, "gatewayBase"));
});

test("a bad, stale, misplaced or tampered signature is 401 and never falls back to other credentials", async (t) => {
  const { spy, port, token } = await mountEntry(t);
  const principal = "system:hub-shim:vllm";
  const cases = [
    ["61 s old", { now: Date.now() - 61_000 }, "internal_signature_expired"],
    ["61 s ahead", { now: Date.now() + 61_000 }, "internal_signature_expired"],
    ["wrong token", { token: "not-the-entry-token" }, "internal_signature_invalid"],
    ["query swapped", { sign: { pathWithQuery: "/api/hub/spy-downloads?state=done" } }, "internal_signature_invalid"],
    ["method swapped", { sign: { method: "POST" } }, "internal_signature_invalid"],
    ["principal swapped", { headers: { "x-ai-internal-principal": "system:hub-shim:llama" } }, "internal_signature_invalid"],
    ["unknown principal", { headers: { "x-ai-internal-principal": "system:root" } }, "internal_signature_invalid"],
    ["no signature", { headers: { "x-ai-internal-signature": "" } }, "internal_signature_invalid"],
    ["LAN socket", { peer: LAN }, "internal_signature_invalid"],
  ];
  for (const [label, options, code] of cases) {
    const response = await signed(port, "GET", "/api/hub/spy-downloads?state=active", { principal, token, ...options });
    assert.equal(response.status, 401, label);
    assert.equal(response.json.error.code, code, label);
    assert.equal(response.text.includes(token), false, label);
  }
  // A lone principal header is an incomplete signature, not an anonymous call.
  const partial = await request(port, "/api/hub/spy-downloads", { headers: { "x-ai-internal-principal": principal } });
  assert.equal(partial.status, 401);
  // Proxied requests stop at the proxied-request guard before any of this.
  const proxied = await signed(port, "GET", "/api/hub/spy-downloads", { principal, token, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(proxied.status, 404);
  assert.equal(proxied.json.code, "public_proxy_gateway_only");
  // cf-ray is in the shared forwarding list (05 §4), so it stops there too.
  const ray = await signed(port, "GET", "/api/hub/spy-downloads?state=active", { principal, token, headers: { "cf-ray": "8d2f0c1e3a" } });
  assert.equal(ray.status, 404);
  assert.equal(ray.json.code, "public_proxy_gateway_only");
  assert.deepEqual(spy.seen, []);
});

test("a body digest mismatch is 401 before the handler runs; an oversized body is 413", async (t) => {
  const { spy, port, token } = await mountEntry(t);
  const principal = "system:hub-shim:llama";
  const mismatch = await signed(port, "POST", "/api/hub/spy-downloads", { principal, token, body: '{"repo":"other/model"}', sign: { body: '{"repo":"demo/model"}' } });
  assert.equal(mismatch.status, 401);
  assert.equal(mismatch.json.error.code, "internal_signature_invalid");

  const big = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
  const oversized = await signed(port, "POST", "/api/hub/spy-downloads", { principal, token, body: big });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, "request_too_large");
  assert.deepEqual(spy.seen, [], "neither request reached the route");

  const good = await signed(port, "POST", "/api/hub/spy-downloads", { principal, token, body: '{"repo":"demo/model"}' });
  assert.equal(good.status, 200);
  assert.deepEqual(spy.seen.map((item) => item.body), [{ repo: "demo/model" }]);
});

test("a bare x-hub-shim header grants nothing", async (t) => {
  const { spy, port } = await mountEntry(t);
  const lan = await request(port, "/api/hub/spy-downloads", { peer: LAN, headers: { "x-hub-shim": "1" } });
  assert.equal(lan.status, 401);
  assert.equal(lan.json.error.code, "admin_session_required", "a LAN caller stays an anonymous viewer");
  assert.deepEqual(spy.seen, []);

  // On loopback it is judged like any request without credentials: a
  // viewer since PUB-5, never a machine principal, so the write is refused.
  const loopback = await request(port, "/api/hub/spy-downloads", { method: "POST", body: {}, headers: { "x-hub-shim": "vllm" } });
  assert.equal(loopback.status, 401);
  assert.equal(loopback.json.error.code, "admin_session_required");
  assert.deepEqual(spy.seen, []);
});

// --- event streams --------------------------------------------------------------

function streamFor(port, token, principal, pathWithQuery) {
  const received = [];
  let opened = false;
  const client = internalAuth.createInternalClient({ principal, baseUrl: `http://127.0.0.1:${port}`, readKey: () => token });
  const failures = [];
  const handle = client.sse(pathWithQuery, (event) => received.push(event.event), {
    reconnect: false,
    onOpen: () => { opened = true; },
    onError: (error) => failures.push(error),
  });
  return { received, failures, close: () => handle.close(), get opened() { return opened; } };
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function publishEveryType(bus) {
  bus.publish("jobs", { managerId: "vllm", jobs: [{ id: "job-1" }] });
  bus.publish("downloads", { kind: "progress", jobs: [{ id: "dl_1" }] });
  bus.publish("library", { changed: ["demo"] });
  bus.publish("instances", { managerId: "vllm", changed: ["primary"], removed: [] });
  bus.publish("telemetry.live", { gpu: [] });
  bus.publish("security", { kind: "test" });
  bus.publish("access", { kind: "test" });
  bus.publish("notification", { kind: "test", severity: "info", title: { zh: "测试", en: "Test" } });
  bus.publish("platform", { kind: "test" });
  bus.publish("alerts", { action: "firing", alert: { ruleId: "r1" } });
  bus.publish("status", { reason: "manager_up", managerId: "vllm" });
}

test("machine event streams carry only their principal's types", async (t) => {
  const { ctx, port, token } = await mountEntry(t);
  const supervisor = streamFor(port, token, "system:supervisor", "/api/events?client=supervisor");
  const hub = streamFor(port, token, "system:hub-shim:vllm", "/api/events");
  const mcp = streamFor(port, token, "system:mcp", "/api/events");
  t.after(() => [supervisor, hub, mcp].forEach((stream) => stream.close()));
  await waitFor(() => supervisor.opened && hub.opened && mcp.opened, "three open streams");
  await waitFor(() => ctx.bus.stats().clients === 3, "three subscribers");
  assert.equal(ctx.bus.subscriberCount({ principal: "system:supervisor" }), 1, "the supervisor is known by its verified principal");

  publishEveryType(ctx.bus);
  ctx.bus.publish("library", { marker: true });
  await waitFor(() => supervisor.received.includes("status") && hub.received.filter((type) => type === "library").length === 2, "the last events");
  assert.deepEqual(supervisor.received, ["notification", "platform", "alerts", "status"]);
  assert.deepEqual(hub.received, ["jobs", "downloads", "library", "library"]);
  assert.deepEqual(mcp.received, [], "system:mcp gets no event types");

  // The supervisor's stream needs its own client label.
  const other = await signed(port, "GET", "/api/events?client=console", { principal: "system:supervisor", token });
  assert.equal(other.status, 403);
});

// --- failure reporting --------------------------------------------------------------

test("failed signatures are reported as security internal_auth_failed, at most once a second", async (t) => {
  let clock = 1_000_000;
  const reports = [];
  const machine = createMachineAuth({ getToken: () => "fake-entry-token-0123456789", now: () => clock, onFailure: (details) => reports.push(details) });
  const headers = internalAuth.buildMachineHeaders("some-other-token-0123456789", { method: "GET", pathWithQuery: "/api/hub/x", principal: "system:hub-shim:vllm", now: clock });
  const req = { method: "GET", url: "/api/hub/x", headers, socket: { remoteAddress: "127.0.0.1" } };
  const url = new URL("http://127.0.0.1/api/hub/x");
  for (let index = 0; index < 3; index += 1) assert.equal(machine.verifySignature(req, url).code, "internal_signature_invalid");
  assert.equal(reports.length, 1);
  clock += 1000;
  machine.verifySignature(req, url);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1], { code: "internal_signature_invalid", principal: "system:hub-shim:vllm", method: "GET", path: "/api/hub/x", suppressed: 2 });
  assert.equal(JSON.stringify(reports).includes(headers["x-ai-internal-signature"]), false, "the signature is never reported");
  assert.equal(machine.principalOf(req), "", "a failed request has no principal");

  // Through the entry the report becomes a security event.
  const { ctx, port, token } = await mountEntry(t);
  const events = [];
  const off = ctx.bus.subscribe((envelope) => events.push(envelope), { types: ["security"] });
  t.after(off);
  await signed(port, "GET", "/api/hub/x", { principal: "system:hub-shim:llama", token: `${token}x` });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.kind, "internal_auth_failed");
  assert.equal(events[0].data.principal, "system:hub-shim:llama");
  assert.equal(JSON.stringify(events[0]).includes(token), false);
});

// --- entry-call.js ---------------------------------------

function captured() {
  const out = { text: "", write(chunk) { out.text += chunk; return true; } };
  return out;
}

function writeTrustFile(dir, token) {
  fs.writeFileSync(path.join(dir, ".gateway-trust.json"), JSON.stringify({ token }), "utf8");
}

test("entry-call.js signs as system:cli with the trust file of its AI root", async (t) => {
  delete process.env.SERVICE_GATEWAY_TRUST_TOKEN;
  const { spy, port, token } = await mountEntry(t);
  const root = tempRoot(t, "entry-call-");
  writeTrustFile(root, token);

  const stdout = captured();
  const stderr = captured();
  const ok = await entryCall.main(["POST", "/api/stop-all", "--port", String(port), "--ai-root", root, "--body", "{\"reason\":\"test\"}"], { stdout, stderr, env: {} });
  assert.equal(ok, 0, stderr.text);
  assert.deepEqual(JSON.parse(stdout.text).spy, true);
  assert.deepEqual(spy.seen.at(-1), { method: "POST", path: "/api/stop-all", role: "system", principal: "system:cli", body: { reason: "test" } });

  const refused = await entryCall.main(["GET", "/api/billing/overview", "--port", String(port), "--ai-root", root, "--quiet"], { stdout: captured(), stderr, env: {} });
  assert.equal(refused, 1);
  assert.match(stderr.text, /HTTP 403 principal_scope_denied/);

  const empty = tempRoot(t, "entry-call-empty-");
  const missing = captured();
  assert.equal(await entryCall.main(["GET", "/api/status", "--port", String(port), "--ai-root", empty], { stdout: captured(), stderr: missing, env: {} }), 2);
  assert.match(missing.text, /internal_key_unavailable/);

  const usage = captured();
  assert.equal(await entryCall.main(["GET", "/gateway/health"], { stdout: captured(), stderr: usage, env: {} }), 2);
  assert.match(usage.text, /must start with \/api\//);
  assert.equal(entryCall.parseArgs(["get", "/api/status"], { SERVICE_ENTRY_PORT: "6123", AI_ROOT: root }).port, 6123);
  for (const text of [stdout.text, stderr.text, missing.text]) assert.equal(text.includes(token), false);
});
