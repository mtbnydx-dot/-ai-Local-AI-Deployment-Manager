"use strict";

// The entry side of the legacy manager key routes and the direct-call key
// check (docs/overhaul/05-public.md §6.8, §7.2, §13.1; PUB-10): a manager's
// legacy-key-forwarder talks to lib/access-routes.js over a real loopback
// socket, signed with internal-auth, against a real keys store.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const core = require("../../manager-core");
const internalAuth = require("../../manager-core/internal-auth");
const { createKeysStore } = require("../lib/keys-store");
const { createAccessRoutes } = require("../lib/access-routes");

const TOKEN = "fake-trust-token-for-access-internal-tests";
const MANAGERS = [{ id: "vllm", billingId: "vllm-manager" }, { id: "llama", billingId: "llama-manager" }];
const LAPTOP_KEY = "sk-vllm-fake-migrated-laptop-key-0000000000";

let tempDir;
let store;
let storeAvailable = true;
let server;
let baseUrl;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) reject(Object.assign(new Error("too large"), { status: 413 }));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function forwarder(managerId = "vllm-manager", options = {}) {
  return core.createLegacyKeyForwarder({ managerId, baseUrl, readKey: () => TOKEN, verifyCacheMs: 0, ...options });
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-access-internal-"));
  store = createKeysStore({ DatabaseSync, file: path.join(tempDir, "platform-access.sqlite") });
  // A client migrated from vllm's service-clients.json (05 §6.7).
  store.importKeys([{
    id: "vllm.laptop",
    name: "Laptop",
    status: "active",
    class: "friend",
    scopes: ["models.read", "chat", "completions", "responses", "embeddings", "messages", "audio.speech", "audio.clone", "search", "mcp", "self.read"],
    models: ["*"],
    fleetAllow: ["vllm:*"],
    listeners: ["public", "admin"],
    limits: { rpm: 60, tpm: null, maxConcurrent: 4, maxQueued: 16, queueTimeoutSeconds: 30, requestTimeoutSeconds: 600, dailyTokens: null, monthlyTokens: null, dailyRequests: null, maxOutputTokens: null },
    billing: { scope: "vllm-manager", clientId: "laptop" },
    ttsOwner: "vllm:laptop",
    legacy: { managerId: "vllm", clientId: "laptop", source: "service-clients" },
    keyHash: core.hashServiceApiKey(LAPTOP_KEY),
    preview: "sk-vllm…0000",
    createdAt: "2026-09-01T00:00:00.000Z",
  }], { actor: "migration" });
  const routes = createAccessRoutes({
    getAccessStore: () => {
      if (!storeAvailable) throw Object.assign(new Error("closed"), { code: "access_store_unavailable" });
      return store;
    },
    getManagers: () => MANAGERS,
    getTrustToken: () => TOKEN,
    readRequestBody: readBody,
    sendJson,
  });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!(await routes.handle(req, res, url))) sendJson(res, { ok: false, code: "not_found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // A database file still held on Windows; the OS temp cleanup takes it.
  }
});

const LEGACY_CLIENT_FIELDS = Object.keys(core.redactServiceClient(core.normalizeServiceClient({ id: "shape" }))).sort();

test("legacy manager UI CRUD returns the legacy shapes through the entry", async () => {
  const vllm = forwarder();
  const listed = await vllm.getServiceClientsLedger();
  assert.equal(listed.version, 1);
  assert.deepEqual(listed.clients.map((client) => client.id), ["laptop"]);
  assert.deepEqual(Object.keys(listed.clients[0]).sort(), LEGACY_CLIENT_FIELDS, "the redacted legacy client, no more and no less");
  assert.deepEqual(
    [listed.clients[0].rateLimitRpm, listed.clients[0].maxConcurrentRequests, listed.clients[0].allowedModels, listed.clients[0].keyPreview],
    [60, 4, [], "sk-vllm…0000"],
  );

  const created = await vllm.createServiceClient({ name: "Office PC", allowedModels: "qwen-chat, gemma", rateLimitRpm: 30, maxConcurrentRequests: 2 });
  assert.deepEqual(Object.keys(created).sort(), ["apiKey", "client", "ok"]);
  assert.equal(created.ok, true);
  assert.match(created.apiKey, /^sk-/);
  assert.equal(created.client.id, "office-pc");
  assert.deepEqual(created.client.allowedModels, ["qwen-chat", "gemma"]);
  assert.equal(JSON.stringify(created.client).includes(created.apiKey), false, "the secret is only in apiKey");
  // The record: key_id <manager>.<slug>, the legacy billing principal and TTS owner.
  const record = store.getKey("vllm.office-pc");
  assert.deepEqual(record.billing, { scope: "vllm-manager", clientId: "office-pc" });
  assert.equal(record.ttsOwner, "vllm:office-pc");
  assert.deepEqual(record.fleetAllow, ["vllm:*"]);
  assert.deepEqual(record.models, ["qwen-chat", "gemma"]);
  assert.equal(record.limits.rpm, 30);
  assert.deepEqual(record.legacy, { managerId: "vllm", clientId: "office-pc", source: "service-clients" });

  // The created key works for a direct call to its manager, by hash.
  const verified = await vllm.verifyAccessKey(core.hashServiceApiKey(created.apiKey), { kind: "openai" });
  assert.equal(verified.ok, true);
  assert.equal(verified.keyId, "vllm.office-pc");
  assert.deepEqual([verified.principal.b, verified.principal.c, verified.principal.k], ["vllm-manager", "office-pc", "vllm.office-pc"]);
  assert.deepEqual(verified.models, ["qwen-chat", "gemma"]);
  assert.equal(verified.limits.rpm, 30);
  assert.equal(verified.limits.maxConcurrent, 2);
  // ... and not for the other manager (fleetAllow vllm:*).
  assert.deepEqual(await forwarder("llama-manager").verifyAccessKey(core.hashServiceApiKey(created.apiKey)), { ok: false, code: "manager_forbidden" });

  const renamed = await vllm.updateServiceClient("office-pc", { name: "Office", enabled: false });
  assert.deepEqual(Object.keys(renamed).sort(), ["client", "ok"]);
  assert.deepEqual([renamed.client.name, renamed.client.enabled, renamed.client.rateLimitRpm], ["Office", false, 30]);
  assert.equal(store.getKey("vllm.office-pc").status, "disabled");
  assert.deepEqual(await vllm.verifyAccessKey(core.hashServiceApiKey(created.apiKey)), { ok: false, code: "key_disabled" });
  await vllm.updateServiceClient("office-pc", { enabled: true });

  const rotated = await vllm.rotateServiceClientKey("office-pc");
  assert.deepEqual(Object.keys(rotated).sort(), ["apiKey", "client", "ok"]);
  assert.notEqual(rotated.apiKey, created.apiKey);
  assert.equal((await vllm.verifyAccessKey(core.hashServiceApiKey(created.apiKey))).ok, false, "the old secret stops at once");
  assert.equal((await vllm.verifyAccessKey(core.hashServiceApiKey(rotated.apiKey))).ok, true);

  // DELETE revokes; the client is gone from the list, as a deleted one was.
  assert.deepEqual(await vllm.deleteServiceClient("office-pc"), { ok: true, removed: 1, id: "office-pc" });
  assert.equal(store.getKey("vllm.office-pc").status, "revoked");
  assert.deepEqual((await vllm.getServiceClientsLedger()).clients.map((client) => client.id), ["laptop"]);
  assert.deepEqual(await vllm.deleteServiceClient("office-pc"), { ok: true, removed: 0, id: "office-pc" });
  assert.deepEqual(await vllm.verifyAccessKey(core.hashServiceApiKey(rotated.apiKey)), { ok: false, code: "key_disabled" });
  // A re-created client with the same name gets a fresh id; the revoked one keeps its billing principal.
  const again = await vllm.createServiceClient({ name: "Office PC" });
  assert.equal(again.client.id, "office-pc-2");

  // A manager sees and changes only its own legacy clients.
  const llama = forwarder("llama-manager");
  assert.deepEqual((await llama.getServiceClientsLedger()).clients, []);
  assert.deepEqual(await llama.deleteServiceClient("laptop"), { ok: true, removed: 0, id: "laptop" });
  await assert.rejects(llama.updateServiceClient("laptop", { name: "x" }), (error) => error.status === 404);
  assert.equal(store.getKey("vllm.laptop").status, "active");
});

test("verify: a migrated key by hash, with the scope of the gateway kind", async () => {
  const vllm = forwarder();
  const answer = await vllm.verifyAccessKey(core.hashServiceApiKey(LAPTOP_KEY), { kind: "claude" });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.principal, { k: "vllm.laptop", b: "vllm-manager", c: "laptop", t: "vllm:laptop", l: "direct", p: "key", mc: 4 });
  assert.deepEqual(await vllm.verifyAccessKey(core.hashServiceApiKey("sk-vllm-fake-unknown")), { ok: false, code: "invalid_api_key" });
  const { key, secret } = store.createKey({ name: "list only", class: "friend", scopes: ["models.read"], models: ["*"], fleetAllow: ["vllm:*"] }, { actor: "test" });
  assert.deepEqual(await vllm.verifyAccessKey(core.hashServiceApiKey(secret), { kind: "openai" }), { ok: false, code: "scope_denied" });
  store.revokeKey(key.id, { actor: "test" });
});

test("the global key of /api/service-exposure becomes <manager>.global and is revoked when cleared", async () => {
  const vllm = forwarder();
  const first = "sk-vllm-fake-global-key-first";
  await vllm.forwardGlobalKey({ apiKey: first, rateLimitRpm: 120 }, {});
  const global = store.getKey("vllm.global");
  assert.deepEqual([global.status, global.class, global.billing.scope, global.legacy.source], ["active", "owner", "vllm-manager", "service-exposure"]);
  assert.equal(global.billing.clientId, `global-${core.hashServiceApiKey(first).slice(0, 24)}`);
  assert.equal(global.limits.rpm, 120);
  assert.equal((await vllm.verifyAccessKey(core.hashServiceApiKey(first))).ok, true);
  // Setting the same key again is a no-op; a new key replaces the old one.
  assert.equal((await vllm.forwardGlobalKey({ apiKey: first }, {})).unchanged, true);
  const second = "sk-vllm-fake-global-key-second";
  await vllm.forwardGlobalKey({ apiKey: second }, {});
  assert.equal(store.getKey("vllm.global").status, "revoked");
  const replacement = store.getKey(`vllm.global-${core.hashServiceApiKey(second).slice(0, 8)}`);
  assert.equal(replacement.status, "active");
  assert.equal((await vllm.verifyAccessKey(core.hashServiceApiKey(first))).ok, false);
  assert.equal((await vllm.verifyAccessKey(core.hashServiceApiKey(second))).ok, true);
  assert.deepEqual(await vllm.clearGlobalKey(), { ok: true, removed: 1 });
  assert.equal((await vllm.verifyAccessKey(core.hashServiceApiKey(second))).ok, false);
  // The legacy global key never lists as a client.
  assert.deepEqual((await vllm.getServiceClientsLedger()).clients.some((client) => client.id.startsWith("global")), false);
});

test("internal access needs a valid manager signature, its own manager and a store", async () => {
  const unsigned = await fetch(`${baseUrl}/internal/access/legacy-clients?managerId=vllm-manager`);
  assert.equal(unsigned.status, 401);
  assert.equal((await unsigned.json()).code, "internal_manager_not_allowed", "no signed manager, no access");

  const forged = await fetch(`${baseUrl}/internal/access/verify`, {
    method: "POST",
    headers: internalAuth.buildInternalRequestHeaders("fake-wrong-token", "POST", "/internal/access/verify", "vllm-manager", "{}"),
    body: "{}",
  });
  assert.equal(forged.status, 401);

  const client = internalAuth.createInternalClient({ managerId: "vllm-manager", baseUrl, readKey: () => TOKEN });
  const mismatch = await client.request("GET", "/internal/access/legacy-clients?managerId=llama-manager");
  assert.deepEqual([mismatch.status, mismatch.json.code], [403, "internal_manager_mismatch"]);
  const unknownPath = await client.request("GET", "/internal/access/everything");
  assert.equal(unknownPath.status, 404);
  const outsider = internalAuth.createInternalClient({ managerId: "other-manager", baseUrl, readKey: () => TOKEN });
  assert.equal((await outsider.request("GET", "/internal/access/legacy-clients")).status, 401);

  storeAvailable = false;
  try {
    await assert.rejects(forwarder().getServiceClientsLedger(), (error) => error.status === 503 && error.code === "key_store_unavailable");
    assert.deepEqual(await forwarder().verifyAccessKey(core.hashServiceApiKey(LAPTOP_KEY)), { ok: false, code: "key_store_unavailable", unavailable: true });
  } finally {
    storeAvailable = true;
  }
});
