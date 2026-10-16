"use strict";

// Legacy manager key routes as forwarders (docs/overhaul/05-public.md §6.8):
// signed manager-form calls to the entry's /internal/access/*, answered in
// the legacy shapes the manager UIs read.

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("..");
const internalAuth = require("../internal-auth");
const { createLegacyKeyForwarder } = require("../legacy-key-forwarder");

const TOKEN = "fake-internal-token-for-forwarder-tests";
const BASE = "http://127.0.0.1:5176";

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text, body: null };
}

// A fake entry: checks every call is a valid manager-form signature for
// vllm-manager, records it and answers from `answer(method, pathname, body)`.
function fakeEntry(answer) {
  const calls = [];
  const fetchFn = async (href, init = {}) => {
    const url = new URL(href);
    const raw = init.body === undefined ? undefined : Buffer.from(String(init.body));
    const req = { method: init.method, url: `${url.pathname}${url.search}`, headers: init.headers, socket: { remoteAddress: "127.0.0.1" } };
    const verified = internalAuth.verifyInternalRequest(req, raw, TOKEN, { pathPrefixes: ["/internal/access/"] });
    assert.deepEqual(verified, { ok: true, managerId: "vllm-manager" }, `${init.method} ${url.pathname} is signed by the manager`);
    const body = raw ? JSON.parse(raw.toString("utf8")) : null;
    calls.push({ method: init.method, pathname: url.pathname, query: url.searchParams.get("managerId"), body });
    const [status, json] = await answer(init.method, url.pathname, body);
    return jsonResponse(status, json);
  };
  return { calls, fetchFn };
}

function forwarder(entry, options = {}) {
  return createLegacyKeyForwarder({ managerId: "vllm-manager", baseUrl: BASE, readKey: () => TOKEN, fetchFn: entry.fetchFn, ...options });
}

// A redacted legacy client, as the entry renders one.
const CLIENT = Object.freeze(core.redactServiceClient(core.normalizeServiceClient({
  id: "laptop",
  name: "Laptop",
  keyPreview: "sk-plat…9xZk",
  createdAt: "2026-10-01T00:00:00.000Z",
})));

test("legacy CRUD forwards to the entry and returns the legacy shapes", async () => {
  const entry = fakeEntry((method, pathname) => {
    if (method === "GET") return [200, { version: 1, updatedAt: "2026-10-02T00:00:00.000Z", clients: [CLIENT] }];
    if (method === "POST" && pathname.endsWith("/rotate")) return [200, { ok: true, apiKey: "sk-plat-fake-rotated", client: CLIENT }];
    if (method === "POST") return [200, { ok: true, apiKey: "sk-plat-fake-created", client: CLIENT }];
    if (method === "PATCH") return [200, { ok: true, client: { ...CLIENT, name: "Renamed" } }];
    if (method === "DELETE") return [200, { ok: true, removed: 1, id: "laptop" }];
    return [404, { ok: false, code: "not_found" }];
  });
  const keys = forwarder(entry);

  assert.deepEqual(await keys.getServiceClientsLedger(), { version: 1, updatedAt: "2026-10-02T00:00:00.000Z", clients: [CLIENT] });
  assert.deepEqual(await keys.createServiceClient({ name: "Laptop", allowedModels: ["qwen"] }), { ok: true, apiKey: "sk-plat-fake-created", client: CLIENT });
  assert.deepEqual(await keys.updateServiceClient("laptop", { name: "Renamed" }), { ok: true, client: { ...CLIENT, name: "Renamed" } });
  assert.deepEqual(await keys.rotateServiceClientKey("laptop"), { ok: true, apiKey: "sk-plat-fake-rotated", client: CLIENT });
  assert.deepEqual(await keys.deleteServiceClient("laptop"), { ok: true, removed: 1, id: "laptop" });

  assert.deepEqual(entry.calls.map((call) => `${call.method} ${call.pathname}`), [
    "GET /internal/access/legacy-clients",
    "POST /internal/access/legacy-clients",
    "PATCH /internal/access/legacy-clients/laptop",
    "POST /internal/access/legacy-clients/laptop/rotate",
    "DELETE /internal/access/legacy-clients/laptop",
  ]);
  assert.ok(entry.calls.every((call) => call.query === "vllm-manager"), "every call names its manager");
  assert.deepEqual(entry.calls[1].body, { name: "Laptop", allowedModels: ["qwen"] });
  // The redacted ledger passes the manager's own redactor unchanged.
  assert.deepEqual(core.redactServiceClientsLedger(await keys.getServiceClientsLedger()).clients[0], CLIENT);
});

test("an entry that is down answers 503 key_store_unavailable through the legacy routes", async () => {
  const keys = createLegacyKeyForwarder({
    managerId: "vllm-manager",
    baseUrl: BASE,
    readKey: () => TOKEN,
    fetchFn: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); },
  });
  await assert.rejects(keys.createServiceClient({ name: "x" }), (error) => error.status === 503 && error.code === "key_store_unavailable");

  const routes = new Map();
  const app = {};
  for (const verb of ["get", "post", "patch", "delete"]) app[verb] = (path, handler) => routes.set(`${verb.toUpperCase()} ${path}`, handler);
  core.registerServicePolicyRoutes(app, {
    getServiceExposureSettings: async () => ({}),
    saveServiceExposureSettings: async () => ({}),
    buildServiceExposurePayload: async () => ({}),
    redactServiceClientsLedger: core.redactServiceClientsLedger,
    getServiceClientsLedger: keys.getServiceClientsLedger,
    createServiceClient: keys.createServiceClient,
    updateServiceClient: keys.updateServiceClient,
    rotateServiceClientKey: keys.rotateServiceClientKey,
    deleteServiceClient: keys.deleteServiceClient,
    forwardGlobalKey: keys.forwardGlobalKey,
  });
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return value; } };
  await routes.get("POST /api/service-clients")({ body: { name: "x" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "key_store_unavailable");
  // A global key change is not saved locally when it cannot be forwarded.
  let saved = false;
  const exposure = new Map();
  core.registerServicePolicyRoutes({ ...app, get: (p, h) => exposure.set(`GET ${p}`, h), post: (p, h) => exposure.set(`POST ${p}`, h), patch() {}, delete() {} }, {
    getServiceExposureSettings: async () => ({}),
    saveServiceExposureSettings: async () => { saved = true; return {}; },
    buildServiceExposurePayload: async () => ({}),
    forwardGlobalKey: keys.forwardGlobalKey,
  });
  const exposureRes = { ...res, statusCode: 200, body: null };
  await exposure.get("POST /api/service-exposure")({ body: { apiKey: ("sk-" + "vllm-fake-global-key") } }, exposureRes);
  assert.deepEqual([exposureRes.statusCode, exposureRes.body.code, saved], [503, "key_store_unavailable", false]);
});

test("entry refusals keep their status and code", async () => {
  const entry = fakeEntry(() => [404, { ok: false, code: "client_not_found", message: "Service client not found." }]);
  await assert.rejects(forwarder(entry).updateServiceClient("ghost", {}), (error) => error.status === 404 && error.code === "client_not_found");
});

test("the global key is forwarded as a hash with the manager's limits, never as plaintext", async () => {
  const entry = fakeEntry((method) => [200, method === "PUT" ? { ok: true, keyId: "vllm.global" } : { ok: true, removed: 1 }]);
  const keys = forwarder(entry);
  const plaintext = ("sk-" + "vllm-fake-global-key-value");
  await keys.forwardGlobalKey({ apiKey: plaintext, rateLimitRpm: 90 }, { maxConcurrentRequests: 4, notes: "ignored" });
  await keys.forwardGlobalKey({ clearApiKey: true }, {});
  assert.equal(await keys.forwardGlobalKey({ enabled: true }, {}), null, "no key change, no call");
  assert.deepEqual(entry.calls.map((call) => `${call.method} ${call.pathname}`), ["PUT /internal/access/legacy-global", "DELETE /internal/access/legacy-global"]);
  assert.deepEqual(entry.calls[0].body, {
    keyHash: core.hashServiceApiKey(plaintext),
    preview: core.previewServiceApiKey(plaintext),
    limits: { rateLimitRpm: 90, maxConcurrentRequests: 4 },
  });
  assert.equal(JSON.stringify(entry.calls).includes(plaintext), false);
});

test("verifyAccessKey sends only the hash and caches each answer for 5 s", async () => {
  let clock = 1000;
  const answer = { ok: true, keyId: "vllm.laptop", principal: { k: "vllm.laptop", b: "vllm-manager", c: "laptop" }, models: ["*"], limits: {} };
  const entry = fakeEntry(() => [200, answer]);
  const keys = forwarder(entry, { now: () => clock });
  const hash = core.hashServiceApiKey("sk-vllm-fake-client");
  assert.deepEqual(await keys.verifyAccessKey(hash, { kind: "openai" }), answer);
  clock += 4999;
  assert.deepEqual(await keys.verifyAccessKey(hash, { kind: "openai" }), answer);
  assert.equal(entry.calls.length, 1, "cached inside 5 s");
  clock += 1;
  await keys.verifyAccessKey(hash, { kind: "openai" });
  assert.equal(entry.calls.length, 2);
  assert.deepEqual(entry.calls[0].body, { keyHash: hash, kind: "openai" });
  assert.deepEqual(await keys.verifyAccessKey("not-a-hash"), { ok: false, code: "invalid_api_key" });

  // The entry being down is reported, and not cached.
  let down = true;
  const flaky = forwarder({ fetchFn: async (...args) => { if (down) throw new Error("ECONNREFUSED"); return entry.fetchFn(...args); } }, { now: () => clock });
  assert.deepEqual(await flaky.verifyAccessKey(hash), { ok: false, code: "key_store_unavailable", unavailable: true });
  down = false;
  assert.deepEqual(await flaky.verifyAccessKey(hash), answer);
});
