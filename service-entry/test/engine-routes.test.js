"use strict";

// Engine routes at the entry (01-engines §20, §21.2, §21.3, ENG-19) through the
// real entry: the 05 guard, the viewer registry, the central sendJson redaction
// and the manager relay table. The managers are fake HTTP servers on
// ephemeral ports (the second one is offline); the external endpoint host
// uses a fake fetch, so nothing leaves the process. The registry file lives in
// a temp directory and the secret store is an in-memory vault.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createExternalHost } = require("../../manager-core/engines/hosts/external");
const engineRoutes = require("../lib/engine-routes");
const { loadEntry, ownerSession, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const LAN = "192.168.1.50";
const FAKE_KEY = "sk-test-fake-0000";
const NAMESPACE = "engines.external";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A fake vllm manager: records the paths it was asked for and answers /api/engines.
async function startFakeManager(t, { managerId = "vllm", engines = [], errors = [] } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/engines") {
      res.end(JSON.stringify({ ok: true, managerId, generatedAt: "2026-10-20T10:00:00.000Z", engines, errors }));
    } else {
      res.end(JSON.stringify({ ok: true, path: req.url, facts: { "model.localPath": "D:\\models\\qwen" } }));
    }
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { port, seen };
}

// An in-memory stand-in for the secret vault: get is synchronous, set and remove are async.
function memoryVault() {
  const values = new Map();
  return {
    values,
    get: (namespace, name) => values.get(`${namespace}/${name}`) ?? null,
    async set(namespace, name, value) { values.set(`${namespace}/${name}`, value); },
    async remove(namespace, name) { values.delete(`${namespace}/${name}`); },
  };
}

function fakeResponse(status, body) {
  const text = JSON.stringify(body ?? null);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

async function mountEngines(t, { fetchTable = {}, engines, errors, withVllm = true, lookup = async () => [{ address: "93.184.216.34" }] } = {}) {
  const { entry } = await loadEntry();
  const root = tempDir(t, "engine-routes-");
  const file = path.join(root, "data", "external-endpoints.json");
  const vault = memoryVault();
  const fetchCalls = [];
  const fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });
    const answer = fetchTable[String(url)];
    if (!answer) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return answer;
  };
  const externalHost = createExternalHost({ secrets: vault, fetch, lookup });
  const vllm = withVllm ? await startFakeManager(t, { engines, errors }) : null;
  const managers = [
    { id: "vllm", port: vllm ? vllm.port : await unusedPort() },
    { id: "llama", port: await unusedPort() },
  ];
  const ctx = entry.createRouteContext({
    logger: quietLogger(),
    managers,
    engineSecrets: vault,
    externalEndpointsFile: file,
    externalHost,
    externalHealthMonitor: false,
  });
  const routes = await entry.mountRouteModules({ ctx, modules: ["./lib/mgmt-proxy", "./lib/engine-routes"] });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  const owner = await ownerSession(entry, port);
  return { entry, ctx, port, owner, file, vault, vllm, fetchCalls, externalHost, registry: ctx.auth.viewerRegistry };
}

const OLLAMA = { endpointId: "ollama-local", label: "Ollama (this PC)", kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1" };

async function createOwned(app, body = OLLAMA) {
  return request(app.port, "/api/engines/external/endpoints", { method: "POST", owner: app.owner, body });
}

test("the aggregate calls /api/m/:managerId/engines for both managers and lists an offline manager in errors[]", async (t) => {
  const app = await mountEngines(t, {
    engines: [{ engineId: "vllm", adapter: "vllm" }, { engineId: "sglang", adapter: "sglang" }],
    errors: [{ source: "bundled", engineId: "", path: "", code: "invalid_json", message: "bad", file: "<AI_ROOT>/config/engines/broken.json" }],
  });
  await createOwned(app);
  const response = await request(app.port, "/api/engines", { owner: app.owner });
  assert.equal(response.status, 200);
  const body = response.json;
  assert.equal(body.ok, true);
  assert.deepEqual(app.vllm.seen, ["/api/engines"]);
  assert.deepEqual(body.engines.map((engine) => [engine.engineId, engine.managerId]), [["vllm", "vllm"], ["sglang", "vllm"]]);
  assert.deepEqual(body.managers.map((item) => [item.managerId, item.ok]), [["vllm", true], ["llama", false]]);
  const offline = body.errors.find((item) => item.managerId === "llama");
  assert.equal(offline.code, "manager_unreachable");
  assert.ok(offline.message);
  // The managers' own registry errors are passed on, tagged with the manager.
  const registryError = body.errors.find((item) => item.code === "invalid_json");
  assert.equal(registryError.managerId, "vllm");
  assert.ok(registryError.file);
  // The external engine is part of the answer; the owner sees the full record without any key.
  assert.equal(body.external.engineId, "external");
  assert.equal(body.external.endpoints.length, 1);
  assert.equal(body.external.endpoints[0].baseUrl, OLLAMA.baseUrl);
  assert.equal(body.external.endpoints[0].hostClass, "loopback");
});

test("a LAN viewer reads the aggregate with errors[].file dropped and endpoints reduced", async (t) => {
  const app = await mountEngines(t, {
    engines: [{ engineId: "vllm" }],
    errors: [{ source: "bundled", code: "invalid_json", message: "bad", file: "<AI_ROOT>/config/engines/broken.json" }],
  });
  await createOwned(app, { ...OLLAMA, apiKey: FAKE_KEY });
  const response = await request(app.port, "/api/engines", { peer: LAN });
  assert.equal(response.status, 200);
  assert.ok(response.json.errors.length >= 2);
  for (const item of response.json.errors) assert.equal("file" in item, false);
  assert.deepEqual(Object.keys(response.json.external.endpoints[0]).sort(), ["enabled", "endpointId", "health", "hostClass", "kind", "label"]);
  assert.equal(response.json.external.endpoints[0].hostClass, "loopback");
  for (const secret of ["baseUrl", "apiKeyRef", "127.0.0.1", FAKE_KEY, "broken.json"]) assert.equal(response.text.includes(secret), false, secret);
  const list = await request(app.port, "/api/engines/external/endpoints", { peer: LAN });
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.json.endpoints[0]).sort(), ["enabled", "endpointId", "health", "hostClass", "kind", "label"]);
  assert.equal(list.text.includes("baseUrl"), false);
  assert.equal(list.text.includes("apiKeyRef"), false);
  // The owner's list is the full record, still without key values.
  const full = await request(app.port, "/api/engines/external/endpoints", { owner: app.owner });
  assert.equal(full.json.endpoints[0].baseUrl, OLLAMA.baseUrl);
  assert.equal(full.json.endpoints[0].apiKeyRef, `${NAMESPACE}:ollama-local`);
  assert.equal(full.text.includes(FAKE_KEY), false);
});

test("CRUD is owner-only: viewers and sessionless callers are refused, writes need the CSRF token", async (t) => {
  const app = await mountEngines(t);
  const created = await createOwned(app);
  assert.equal(created.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 50)); // the registration's own background health check
  app.fetchCalls.length = 0;
  const writes = [
    ["POST", "/api/engines/external/endpoints", OLLAMA],
    ["PATCH", "/api/engines/external/endpoints/ollama-local", { label: "x" }],
    ["DELETE", "/api/engines/external/endpoints/ollama-local?confirm=1", undefined],
    ["POST", "/api/engines/external/endpoints/ollama-local/test", {}],
  ];
  for (const [method, pathname, body] of writes) {
    const lan = await request(app.port, pathname, { method, peer: LAN, body });
    assert.equal(lan.status, 401, `LAN ${method} ${pathname}`);
    assert.equal(lan.json.error.code, "admin_session_required");
    const bare = await request(app.port, pathname, { method, body });
    assert.equal(bare.status, 401, `sessionless ${method} ${pathname}`);
    const noCsrf = await request(app.port, pathname, { method, body, headers: { cookie: app.owner.cookie } });
    assert.ok(noCsrf.status === 401 || noCsrf.status === 403, `no CSRF ${method} ${pathname}: ${noCsrf.status}`);
  }
  // Nothing changed.
  const after = await request(app.port, "/api/engines/external/endpoints", { owner: app.owner });
  assert.deepEqual(after.json.endpoints.map((item) => [item.endpointId, item.label]), [["ollama-local", "Ollama (this PC)"]]);
  assert.equal(app.fetchCalls.length, 0);
});

test("registration stores the key in engines.external only and returns no key", async (t) => {
  const app = await mountEngines(t);
  const created = await createOwned(app, { ...OLLAMA, apiKey: FAKE_KEY });
  assert.equal(created.status, 201);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.endpoint.endpointId, "ollama-local");
  assert.equal(created.json.endpoint.apiKeyRef, `${NAMESPACE}:ollama-local`);
  assert.equal(created.text.includes(FAKE_KEY), false);
  assert.equal(app.vault.get(NAMESPACE, "ollama-local"), FAKE_KEY);
  const stored = fs.readFileSync(app.file, "utf8");
  assert.equal(stored.includes(FAKE_KEY), false);
  assert.equal(stored.includes("apiKey\""), false);
  const record = JSON.parse(stored);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.endpoints[0].apiKeyRef, `${NAMESPACE}:ollama-local`);
  assert.deepEqual([...app.vault.values.keys()], [`${NAMESPACE}/ollama-local`]);
  // The key reaches the upstream only through resolveUpstream.
  assert.equal(app.externalHost.resolveUpstream(record.endpoints[0], "/models").headers.authorization, `Bearer ${FAKE_KEY}`);
  // A duplicate is a conflict and does not touch the stored key.
  const again = await createOwned(app, { ...OLLAMA, apiKey: "sk-test-other" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "endpoint_exists");
  assert.equal(app.vault.get(NAMESPACE, "ollama-local"), FAKE_KEY);
});

test("registration rejects the SSRF cases and bad fields with a list of errors and saves nothing", async (t) => {
  const app = await mountEngines(t);
  const refuse = async (body) => {
    const response = await createOwned(app, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.error.code, "endpoint_invalid");
    return response.json.errors.map((item) => `${item.path}:${item.code}`);
  };
  assert.ok((await refuse({ ...OLLAMA, baseUrl: "http://169.254.169.254/latest" })).includes("baseUrl:blocked_address"));
  assert.ok((await refuse({ ...OLLAMA, baseUrl: "http://[fe80::1]/v1" })).includes("baseUrl:blocked_address"));
  assert.ok((await refuse({ ...OLLAMA, baseUrl: "http://0.0.0.0:11434/v1" })).includes("baseUrl:blocked_address"));
  assert.ok((await refuse({ ...OLLAMA, baseUrl: "http://user:pw@127.0.0.1:11434/v1" })).includes("baseUrl:credentials_in_url"));
  assert.ok((await refuse({ ...OLLAMA, baseUrl: "http://api.example.com/v1" })).includes("baseUrl:plaintext_remote"));
  assert.ok((await refuse({ ...OLLAMA, endpointId: "Bad Id" })).includes("endpointId:invalid_endpoint_id"));
  assert.ok((await refuse({ ...OLLAMA, apiKey: "has a space" })).includes("apiKey:invalid_api_key"));
  assert.ok((await refuse({ ...OLLAMA, mystery: true })).includes("mystery:unknown_field"));
  assert.equal(fs.existsSync(app.file), false);
  assert.equal(app.vault.values.size, 0);
});

test("a host name that resolves to a metadata address is refused at registration", async (t) => {
  const app = await mountEngines(t, { lookup: async () => [{ address: "169.254.169.254" }] });
  const response = await createOwned(app, { endpointId: "rebind", baseUrl: "https://models.example.com/v1", apiKey: FAKE_KEY });
  assert.equal(response.status, 400);
  assert.ok(response.json.errors.some((item) => item.path === "baseUrl" && item.code === "blocked_address"));
  assert.equal(fs.existsSync(app.file), false);
  assert.equal(app.vault.values.size, 0);
  assert.equal(app.fetchCalls.length, 0);
});

test("a remote http:// endpoint is accepted with the plaintext-remote acknowledgement", async (t) => {
  const app = await mountEngines(t);
  const created = await createOwned(app, { endpointId: "cloud", baseUrl: "http://api.example.com/v1", acknowledge: ["plaintext-remote"] });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.endpoint.acknowledged, ["plaintext-remote"]);
  assert.equal(created.json.endpoint.hostClass, "remote");
  // Moving the endpoint to another remote http address needs a new acknowledgement.
  const moved = await request(app.port, "/api/engines/external/endpoints/cloud", { method: "PATCH", owner: app.owner, body: { baseUrl: "http://other.example.com/v1" } });
  assert.equal(moved.status, 400);
  assert.ok(moved.json.errors.some((item) => item.code === "plaintext_remote"));
  const ok = await request(app.port, "/api/engines/external/endpoints/cloud", { method: "PATCH", owner: app.owner, body: { baseUrl: "http://other.example.com/v1", acknowledge: ["plaintext-remote"] } });
  assert.equal(ok.status, 200);
});

test("PATCH updates fields, sets, keeps and clears the key; DELETE needs confirm=1 and removes the key", async (t) => {
  const app = await mountEngines(t);
  await createOwned(app, { ...OLLAMA, apiKey: FAKE_KEY });

  const renamed = await request(app.port, "/api/engines/external/endpoints/ollama-local", {
    method: "PATCH", owner: app.owner, body: { label: "Ollama 2", models: { allow: ["qwen3:32b"] }, capabilities: { tools: true } },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.endpoint.label, "Ollama 2");
  assert.deepEqual(renamed.json.endpoint.models, { discover: true, allow: ["qwen3:32b"], aliases: {} });
  assert.equal(renamed.json.endpoint.capabilities.tools, true);
  assert.equal(renamed.json.endpoint.capabilities.text, true);
  assert.equal(renamed.json.endpoint.apiKeyRef, `${NAMESPACE}:ollama-local`);
  assert.equal(app.vault.get(NAMESPACE, "ollama-local"), FAKE_KEY);

  const rotated = await request(app.port, "/api/engines/external/endpoints/ollama-local", { method: "PATCH", owner: app.owner, body: { apiKey: "sk-test-rotated" } });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.text.includes("sk-test-rotated"), false);
  assert.equal(app.vault.get(NAMESPACE, "ollama-local"), "sk-test-rotated");

  for (const body of [{ endpointId: "other" }, { createdAt: "2020-01-01T00:00:00Z" }, { apiKeyRef: "x" }, { baseUrl: "http://169.254.169.254/v1" }, { apiKey: 5 }]) {
    const refused = await request(app.port, "/api/engines/external/endpoints/ollama-local", { method: "PATCH", owner: app.owner, body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  const missing = await request(app.port, "/api/engines/external/endpoints/nobody", { method: "PATCH", owner: app.owner, body: { label: "x" } });
  assert.equal(missing.status, 404);

  const cleared = await request(app.port, "/api/engines/external/endpoints/ollama-local", { method: "PATCH", owner: app.owner, body: { apiKey: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.endpoint.apiKeyRef, "");
  assert.equal(app.vault.values.size, 0);

  await request(app.port, "/api/engines/external/endpoints/ollama-local", { method: "PATCH", owner: app.owner, body: { apiKey: FAKE_KEY } });
  const unconfirmed = await request(app.port, "/api/engines/external/endpoints/ollama-local", { method: "DELETE", owner: app.owner });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.error.code, "confirm_required");
  assert.equal(app.vault.values.size, 1);
  const removed = await request(app.port, "/api/engines/external/endpoints/ollama-local?confirm=1", { method: "DELETE", owner: app.owner });
  assert.equal(removed.status, 200);
  assert.equal(app.vault.values.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(app.file, "utf8")).endpoints, []);
  assert.equal((await request(app.port, "/api/engines/external/endpoints/ollama-local?confirm=1", { method: "DELETE", owner: app.owner })).status, 404);
});

test("POST .../test is a GET-only probe: latency, models and Ollama's /api/ps", async (t) => {
  const app = await mountEngines(t, {
    fetchTable: {
      "http://127.0.0.1:11434/v1/models": fakeResponse(200, { data: [{ id: "qwen3:32b" }, { id: "llama3" }] }),
      "http://127.0.0.1:11434/api/ps": fakeResponse(200, { models: [{ name: "qwen3:32b", size: 10, size_vram: 8, expires_at: "2026-10-20T10:05:00Z" }] }),
    },
  });
  await createOwned(app, { ...OLLAMA, apiKey: FAKE_KEY });
  app.fetchCalls.length = 0;
  const probe = await request(app.port, "/api/engines/external/endpoints/ollama-local/test", { method: "POST", owner: app.owner, body: {} });
  assert.equal(probe.status, 200);
  assert.equal(probe.json.ok, true);
  assert.equal(typeof probe.json.latencyMs, "number");
  assert.deepEqual(probe.json.models, ["qwen3:32b", "llama3"]);
  assert.equal(probe.json.ollama.models[0].sizeVramBytes, 8);
  assert.equal(probe.text.includes(FAKE_KEY), false);
  assert.ok(app.fetchCalls.length >= 2);
  assert.ok(app.fetchCalls.every((call) => (call.init.method || "GET") === "GET" && call.init.body === undefined));
  assert.ok(app.fetchCalls.some((call) => call.init.headers.authorization === `Bearer ${FAKE_KEY}`));
  // A client Authorization header on the probe request is never forwarded.
  app.fetchCalls.length = 0;
  await request(app.port, "/api/engines/external/endpoints/ollama-local/test", { method: "POST", owner: app.owner, body: {}, headers: { authorization: "Bearer client-key" } });
  assert.ok(app.fetchCalls.every((call) => call.init.headers.authorization === `Bearer ${FAKE_KEY}`));

  const down = await createOwned(app, { ...OLLAMA, endpointId: "ollama-down", baseUrl: "http://127.0.0.1:1/v1" });
  assert.equal(down.status, 201);
  const failed = await request(app.port, "/api/engines/external/endpoints/ollama-down/test", { method: "POST", owner: app.owner, body: {} });
  assert.equal(failed.status, 200);
  assert.equal(failed.json.ok, false);
  assert.deepEqual(failed.json.models, []);
  assert.equal(failed.json.state, "unreachable");
  assert.equal((await request(app.port, "/api/engines/external/endpoints/nobody/test", { method: "POST", owner: app.owner, body: {} })).status, 404);
});

test("a corrupt registry file is reported, never overwritten", async (t) => {
  const app = await mountEngines(t);
  fs.mkdirSync(path.dirname(app.file), { recursive: true });
  fs.writeFileSync(app.file, "{ torn");
  const list = await request(app.port, "/api/engines/external/endpoints", { owner: app.owner });
  assert.equal(list.status, 503);
  assert.equal(list.json.error.code, "endpoint_store_corrupt");
  const created = await createOwned(app);
  assert.equal(created.status, 503);
  assert.equal(fs.readFileSync(app.file, "utf8"), "{ torn");
  assert.equal(app.vault.values.size, 0);
  // The aggregate still answers; the registry problem is one errors[] row.
  const aggregate = await request(app.port, "/api/engines", { owner: app.owner });
  assert.equal(aggregate.status, 200);
  assert.ok(aggregate.json.errors.some((item) => item.code === "endpoint_store_corrupt"));
});

test("methods and paths: wrong methods answer 405, unknown paths fall through", async (t) => {
  const app = await mountEngines(t);
  const wrong = await request(app.port, "/api/engines", { method: "POST", owner: app.owner, body: {} });
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers.allow, /GET/);
  assert.equal((await request(app.port, "/api/engines/external/endpoints/ollama-local", { owner: app.owner })).status, 405);
  assert.equal((await request(app.port, "/api/engines/external/nothing", { owner: app.owner })).status, 404);
  assert.equal((await request(app.port, "/api/engines/external/endpoints/a/b/c", { owner: app.owner })).status, 404);
});

// --- viewer registrations (§21.3) --------------------------------------------------

const SAMPLE_PATHS = {
  "/api/engines": "/api/engines",
  "/api/engines/external/endpoints": "/api/engines/external/endpoints",
  "/api/m/:managerId/engines": "/api/m/vllm/engines",
  "/api/m/:managerId/engines/:engineId/schema": "/api/m/vllm/engines/sglang/schema",
  "/api/m/:managerId/engines/:engineId/runtimes/:runtimeId/flags": "/api/m/vllm/engines/sglang/runtimes/sglang@0.5.17/flags",
  "/api/m/:managerId/instances": "/api/m/vllm/instances",
  "/api/m/:managerId/instances/:id/metrics": "/api/m/vllm/instances/vllm-local/metrics",
};

test("every viewerRoutes entry is registered for viewers with its redaction; logs and launch routes are owner-only", async (t) => {
  const app = await mountEngines(t);
  assert.deepEqual(engineRoutes.viewerRoutes.map((route) => route.path), Object.keys(SAMPLE_PATHS));
  for (const route of engineRoutes.viewerRoutes) {
    const found = app.registry.match("GET", SAMPLE_PATHS[route.path]);
    assert.ok(found, route.path);
    assert.equal(found.access, "viewer", route.path);
    if (route.path === "/api/m/:managerId/instances") continue; // 07 registered it first, with the same fleet redaction
    assert.equal(found.entry.owner, "01", route.path);
    assert.equal(found.entry.redact, route.redact, route.path);
  }
  for (const pathname of [
    "/api/m/vllm/instances/vllm-local/logs",
    "/api/m/vllm/instances/vllm-local/launch",
    "/api/m/vllm/launches",
    "/api/m/vllm/launches/lch_abc",
  ]) {
    assert.equal(app.registry.match("GET", pathname).access, "admin", pathname);
  }
  for (const route of [...engineRoutes.viewerRoutes, ...engineRoutes.adminOnlyRoutes]) {
    assert.ok(app.registry.inventory().some((item) => item.method === route.method && item.path === route.path), `${route.method} ${route.path} is in the inventory`);
  }
  for (const route of engineRoutes.adminOnlyRoutes) assert.equal(app.registry.match(route.method, route.path.replace(/:[A-Za-z]+/g, "x")).access, "admin", route.path);
  // Live: a viewer cannot read logs, the launch record or the launch list through the proxy.
  for (const pathname of ["/api/m/vllm/instances/vllm-local/logs", "/api/m/vllm/instances/vllm-local/launch", "/api/m/vllm/launches", "/api/m/vllm/launches/lch_abc"]) {
    const viewer = await request(app.port, pathname, { peer: LAN });
    assert.equal(viewer.status, 401, pathname);
  }
  assert.deepEqual(app.vllm.seen, []);
  // Live: the proxied engines read reaches a viewer with errors[].file dropped.
  const proxied = await request(app.port, "/api/m/vllm/engines", { peer: LAN });
  assert.equal(proxied.status, 200);
});

test("proxied viewer reads are redacted by the registered functions", async (t) => {
  const app = await mountEngines(t, {
    engines: [{ engineId: "vllm" }],
    errors: [{ source: "bundled", code: "invalid_json", message: "bad", file: "<AI_ROOT>/config/engines/broken.json" }],
  });
  const engines = await request(app.port, "/api/m/vllm/engines", { peer: LAN });
  assert.equal(engines.status, 200);
  assert.equal(engines.json.errors.length, 1);
  assert.equal("file" in engines.json.errors[0], false);
  assert.equal(engines.json.errors[0].code, "invalid_json");
  const owner = await request(app.port, "/api/m/vllm/engines", { owner: app.owner });
  assert.equal(owner.json.errors[0].file, "<AI_ROOT>/config/engines/broken.json");
  const metrics = await request(app.port, "/api/m/vllm/instances/vllm-local/metrics", { peer: LAN });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.text.includes("D:\\\\models"), false);
});

test("redaction functions follow §21.3", () => {
  const {
    redactEnginesForViewer, redactEndpointsBodyForViewer, redactManagerEnginesForViewer, redactEngineSchemaForViewer,
    redactInstanceMetricsForViewer, redactInstancesForViewer, redactEndpointForViewer,
  } = engineRoutes;
  const record = {
    endpointId: "lab", label: "Lab", kind: "openai", baseUrl: "https://gpu.example.com/v1", apiKeyRef: "engines.external:lab", enabled: true,
    models: { discover: true, allow: [], aliases: {} }, localGpu: false, createdAt: "2026-10-20T10:00:00.000Z", acknowledged: [],
    hostClass: "remote", health: { state: "ready", ok: true, latencyMs: 12, status: 200, models: 3, checkedAt: "2026-10-20T10:00:00.000Z", ollama: { models: [{ name: "x" }] } },
  };
  const reduced = redactEndpointForViewer(record);
  assert.deepEqual(reduced, { endpointId: "lab", label: "Lab", kind: "openai", enabled: true, hostClass: "remote", health: { state: "ready", latencyMs: 12, checkedAt: "2026-10-20T10:00:00.000Z" } });
  assert.deepEqual(redactEndpointForViewer(reduced), reduced, "idempotent");
  assert.equal(redactEndpointForViewer({ ...record, health: null }).health.state, "unknown");
  for (const [baseUrl, hostClass] of [["http://10.0.0.5/v1", "lan"], ["http://localhost:1/v1", "loopback"]]) {
    assert.equal(redactEndpointForViewer({ ...record, baseUrl, hostClass: undefined }).hostClass, hostClass);
  }

  const aggregate = {
    ok: true,
    engines: [{ engineId: "vllm", managerId: "vllm", runtimes: [{ image: "local/vllm:x" }] }],
    errors: [{ managerId: "vllm", code: "invalid_json", message: "m", file: "D:/cfg/a.json" }, { managerId: "llama", code: "manager_unreachable", message: "down" }],
    external: { engineId: "external", endpoints: [record] },
  };
  const viewerAggregate = redactEnginesForViewer(aggregate);
  assert.deepEqual(viewerAggregate.errors, [{ managerId: "vllm", code: "invalid_json", message: "m" }, { managerId: "llama", code: "manager_unreachable", message: "down" }]);
  assert.deepEqual(viewerAggregate.external.endpoints, [reduced]);
  assert.deepEqual(viewerAggregate.engines, aggregate.engines);
  assert.equal(aggregate.errors[0].file, "D:/cfg/a.json", "the input is not changed");
  assert.deepEqual(redactEndpointsBodyForViewer({ ok: true, endpoints: [record] }), { ok: true, endpoints: [reduced] });
  assert.deepEqual(redactManagerEnginesForViewer({ ok: true, managerId: "vllm", engines: [], errors: [{ code: "c", file: "x" }] }), { ok: true, managerId: "vllm", engines: [], errors: [{ code: "c" }] });

  const schema = {
    ok: true,
    params: [{ id: "contextLength" }],
    recipes: [
      { id: "a", profile: { id: "p", modelDir: "Qwen/Qwen3-32B", values: { contextLength: 4096 } } },
      { id: "b", profile: null },
      { id: "c" },
    ],
    facts: {
      "host.platform": "win32",
      "model.capabilityId": "qwen3",
      "model.localPath": "D:\\models\\Qwen3",
      "model.dirs": ["/models/a", "/models/b"],
      "model.architectures": ["Qwen3ForCausalLM"],
    },
  };
  const viewerSchema = redactEngineSchemaForViewer(schema);
  assert.equal("modelDir" in viewerSchema.recipes[0].profile, false);
  assert.deepEqual(viewerSchema.recipes[0].profile.values, { contextLength: 4096 });
  assert.equal(viewerSchema.recipes[1].profile, null);
  assert.deepEqual(viewerSchema.facts, { "host.platform": "win32", "model.capabilityId": "qwen3", "model.architectures": ["Qwen3ForCausalLM"] });
  assert.equal(schema.recipes[0].profile.modelDir, "Qwen/Qwen3-32B", "the input is not changed");
  const nested = redactEngineSchemaForViewer({ facts: { model: { familyId: "qwen", localPath: "/models/qwen/x", ggufFiles: ["/models/a.gguf"], sizeMb: 5, root: "x" } } });
  assert.deepEqual(nested.facts, { model: { familyId: "qwen", sizeMb: 5 } });

  const metrics = redactInstanceMetricsForViewer({ ok: true, instanceId: "i", facts: { modelPath: "D:\\m\\x", served: "qwen", logFile: "/var/log/x.log", count: 2 }, values: { a: 1 } });
  assert.deepEqual(metrics, { ok: true, instanceId: "i", facts: { served: "qwen", count: 2 }, values: { a: 1 } });

  const instances = redactInstancesForViewer({ ok: true, instances: [{ id: "i", model: "D:\\models\\qwen\\weights", launchId: "lch_1", lifecycle: { state: "ready" }, engineId: "vllm" }] });
  assert.equal(JSON.stringify(instances).includes("D:\\\\models"), false);
  assert.equal(instances.instances[0].lifecycle.state, "ready");
  assert.equal(instances.instances[0].engineId, "vllm");
});
