"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const control = require("../platform/control");
const { createSecretStore } = require("../secret-store");
const { createFakeDpapi } = require("./fixtures/secrets/fake-dpapi");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platform-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeSupervisor(overrides = {}) {
  const calls = [];
  const subscribers = new Set();
  const supervisor = {
    calls,
    publish(event) { for (const listener of subscribers) listener(event); },
    async status() { calls.push(["status"]); return { schemaVersion: 1, mode: "supervised" }; },
    async listComponents() { return [{ id: "entry", state: "ready" }]; },
    async describeComponent(id) {
      if (id !== "entry") throw control.controlError(404, "component_unknown", "Unknown component.");
      return { component: { id }, spec: { env: { A: "<redacted>" } } };
    },
    async startComponent(id, options) { calls.push(["start", id, options]); return { opId: "op_1" }; },
    async restart(ids, options) {
      calls.push(["restart", ids, options]);
      throw control.controlError(409, "component_busy", "Busy.", { blockers: [{ kind: "requests", source: "entry" }] });
    },
    async componentLogs(id, options) { calls.push(["logs", id, options]); return { lines: [], files: [] }; },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    ...overrides,
  };
  return supervisor;
}

async function serve(t, options = {}) {
  const aiRoot = options.aiRoot || tempRoot(t);
  const endpoint = control.controlEndpoint(aiRoot);
  const supervisor = options.supervisor || fakeSupervisor();
  const server = await control.startControlServer({ endpoint, token: options.token || "fixture-token-abcdefghijklmnopqrstuv", supervisor });
  t.after(() => server.close());
  return { aiRoot, endpoint, supervisor, server };
}

function raw(endpoint, { method = "GET", path: target = "/v1/status", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: endpoint, path: target, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("controlEndpoint hashes the lower-cased root into a pipe name (a socket off Windows)", () => {
  const root = path.resolve(os.tmpdir(), "Fixture-Root");
  const pipe = control.controlEndpoint(root, { platform: "win32" });
  assert.match(pipe, /^\\\\\.\\pipe\\local-ai-platform-[0-9a-f]{12}$/);
  assert.equal(control.controlEndpoint(root.toUpperCase(), { platform: "win32" }), control.controlEndpoint(root.toLowerCase(), { platform: "win32" }));
  assert.equal(control.controlEndpoint(root, { platform: "linux", tmpdir: os.tmpdir() }), path.join(os.tmpdir(), `local-ai-platform-${pipe.slice(-12)}.sock`));
  assert.match(control.createControlToken(), /^[A-Za-z0-9_-]{43}$/);
});

test("a pipe server and client round-trip with the token", async (t) => {
  const { endpoint, supervisor } = await serve(t);
  const client = control.createControlClient({ endpoint, token: "fixture-token-abcdefghijklmnopqrstuv" });
  const status = await client.request("GET", "/v1/status", { requestId: "req_fixture" });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { schemaVersion: 1, mode: "supervised" });
  const started = await client.request("POST", "/v1/components/entry/start", { body: { wait: false } });
  assert.equal(started.status, 202);
  assert.deepEqual(started.json, { ok: true, opId: "op_1" });
  assert.deepEqual(supervisor.calls.find((call) => call[0] === "start"), ["start", "entry", { wait: false }]);
  const busy = await client.request("POST", "/v1/components/entry/restart", { body: { when: "now" } });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, "component_busy");
  assert.deepEqual(busy.json.blockers, [{ kind: "requests", source: "entry" }]);
  const unknown = await client.request("GET", "/v1/components/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "component_unknown");
  const logs = await client.request("GET", "/v1/components/entry/logs?stream=err&tail=20");
  assert.equal(logs.status, 200);
  assert.deepEqual(supervisor.calls.find((call) => call[0] === "logs"), ["logs", "entry", { stream: "err", tail: 20, legacy: false }]);
  assert.equal((await client.request("POST", "/v1/doctor/fix", { body: { checkId: "x", fixId: "y", confirm: true } })).json.error.code, "not_implemented");
  assert.equal((await client.request("GET", "/v1/nothing")).status, 404);
  assert.equal((await client.request("DELETE", "/v1/status")).status, 405);
  assert.equal(await client.available(), true);
});

test("a request with Origin or Sec-Fetch-Site gets 403, a bad token 401, an oversized body 413", async (t) => {
  const token = "fixture-token-abcdefghijklmnopqrstuv";
  const { endpoint, supervisor } = await serve(t, { token });
  const auth = { authorization: `Bearer ${token}` };
  const origin = await raw(endpoint, { headers: { ...auth, origin: "http://127.0.0.1:5176" } });
  assert.equal(origin.status, 403);
  assert.equal(origin.json.error.code, "origin_forbidden");
  const fetchSite = await raw(endpoint, { headers: { ...auth, "sec-fetch-site": "same-origin" } });
  assert.equal(fetchSite.status, 403);
  assert.equal((await raw(endpoint, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await raw(endpoint, {})).status, 401);
  assert.ok(!supervisor.calls.some((call) => call[0] === "status"), "refused requests never reach the supervisor");
  const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
  const tooLarge = await raw(endpoint, { method: "POST", path: "/v1/components/entry/start", headers: { ...auth, "content-type": "application/json", "content-length": Buffer.byteLength(big) }, body: big });
  assert.equal(tooLarge.status, 413);
  const invalid = await raw(endpoint, { method: "POST", path: "/v1/components/entry/start", headers: { ...auth, "content-type": "application/json" }, body: "{nope" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "invalid_json");
});

test("the client re-reads the token after a 401 and reports supervisor_unavailable without a server", async (t) => {
  const { endpoint } = await serve(t, { token: "fresh-token-abcdefghijklmnopqrstuvwx" });
  const tokens = ["stale-token", "fresh-token-abcdefghijklmnopqrstuvwx"];
  let reads = 0;
  const client = control.createControlClient({ endpoint, readToken: () => tokens[Math.min(reads++, 1)] });
  assert.equal((await client.request("GET", "/v1/status")).status, 200);
  assert.equal(reads, 2);
  const offline = control.createControlClient({ endpoint: control.controlEndpoint(tempRoot(t)), token: "x" });
  await assert.rejects(offline.request("GET", "/v1/status"), (error) => error.code === "supervisor_unavailable" && error.status === 503);
  assert.equal(await offline.available(), false);
  const tokenless = control.createControlClient({ endpoint, readToken: () => "" });
  await assert.rejects(tokenless.request("GET", "/v1/status"), (error) => error.code === "supervisor_unavailable");
});

test("a second server on the same endpoint fails with EADDRINUSE (single instance)", async (t) => {
  const { aiRoot, endpoint } = await serve(t);
  await assert.rejects(control.startControlServer({ endpoint, token: "another-token", supervisor: fakeSupervisor() }), (error) => error.code === "EADDRINUSE");
  assert.equal(control.controlEndpoint(aiRoot), endpoint);
});

test("the event stream relays supervisor events over the pipe", async (t) => {
  const token = "fixture-token-abcdefghijklmnopqrstuv";
  const { endpoint, supervisor } = await serve(t, { token });
  const client = control.createControlClient({ endpoint, token });
  const received = [];
  const stream = client.events((event) => received.push(event));
  t.after(() => stream.close());
  for (let attempt = 0; attempt < 50 && !received.length; attempt += 1) {
    supervisor.publish({ type: "component", at: "2026-10-14T08:00:00.000Z", data: { id: "entry", state: "ready", prev: "starting", reason: null } });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(received[0].type, "component");
  assert.equal(received[0].data.data.id, "entry");
});

test("the control token lives in the secret store and never in a plain file", async (t) => {
  const aiRoot = tempRoot(t);
  const store = createSecretStore({ aiRoot, namespace: control.TOKEN_NAMESPACE, dpapi: createFakeDpapi() });
  const tokens = control.createControlTokenStore({ aiRoot, store });
  const token = control.createControlToken();
  await tokens.write(token);
  assert.equal(tokens.read(), token);
  const files = fs.readdirSync(path.join(aiRoot, ".runtime", "secrets"));
  assert.deepEqual(files.filter((name) => name.endsWith(".json")), ["platform-control.json"]);
  for (const name of files) assert.ok(!fs.readFileSync(path.join(aiRoot, ".runtime", "secrets", name), "utf8").includes(token));
  const { endpoint } = await serve(t, { aiRoot, token });
  const client = control.createControlClient({ aiRoot, endpoint, tokenStore: store });
  assert.equal((await client.request("GET", "/v1/status")).status, 200);
});
