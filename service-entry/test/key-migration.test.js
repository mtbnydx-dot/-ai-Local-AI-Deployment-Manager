"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const migration = require("../lib/key-migration");
const { createKeysStore } = require("../lib/keys-store");
const { evaluateKey, fleetAllowed } = require("../lib/key-policy");
const { summarizeServiceKeys } = require("../lib/key-overview");
const { createBillingStore } = require("../lib/billing-store");

// Legacy key migration (05-public.md §6.7, PUB-4). The golden file holds the
// plan, the store rows and the report for the fixture below; regenerate it
// with UPDATE_GOLDEN=1 only when §6.7 itself changes, and review the diff.
const GOLDEN_PATH = path.join(__dirname, "golden", "key-migration.json");
const AT = "2026-10-14T08:00:00.000Z";
const CUSTOMER_DAVE = "0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const CUSTOMER_SHARED = "7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Obviously fake secrets; only their hashes appear in the fixture.
const SECRETS = {
  global: "fixture-vllm-global-secret-0001",
  alice: "fixture-vllm-alice-secret-0001",
  bob: "fixture-vllm-bob-secret-0001",
  carol: "fixture-vllm-carol-secret-0001",
  dave: "fixture-vllm-dave-secret-0001",
  odd: "fixture-vllm-odd-secret-0001",
  shared: "fixture-shared-secret-0001",
  reserved: "fixture-vllm-reserved-secret-0001",
  llamaAlice: "fixture-llama-alice-secret-0001",
  erin: "fixture-llama-erin-secret-0001",
};

function client(id, secret, fields = {}) {
  return {
    id,
    name: id,
    enabled: true,
    keyHash: sha256(secret),
    keyPreview: `${secret.slice(0, 7)}...${secret.slice(-4)}`,
    allowedModels: [],
    rateLimitRpm: 480,
    maxConcurrentRequests: 16,
    maxQueuedRequests: 128,
    queueTimeoutSeconds: 30,
    requestTimeoutSeconds: 600,
    expiresAt: "",
    notes: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: null,
    ...fields,
  };
}

// Two managers covering every §6.7 rule the acceptance names: duplicate ids
// across managers (alice), a duplicate hash within a manager (twin) and across
// managers (shared / shared-copy), an odd id, a disabled, an expired and a
// bound client, a global key, plus an unusable hash, a reserved id, dropped
// origins and model patterns, and open CORS.
function fixtureManagers() {
  return [
    {
      id: "vllm",
      billingId: "vllm-manager",
      settings: {
        version: 1,
        enabled: true,
        exposureMode: "reverse-proxy",
        requireApiKey: true,
        apiKey: "",
        apiKeyHash: sha256(SECRETS.global),
        apiKeyPreview: "fixture...0001",
        corsMode: "restricted",
        allowedOrigins: ["https://chat.example.com", "*", "https://app.example.com/path"],
        rateLimitRpm: 600,
        maxConcurrentRequests: 8,
        maxQueuedRequests: 64,
        queueTimeoutSeconds: 20,
        requestTimeoutSeconds: 900,
      },
      clients: {
        version: 1,
        updatedAt: "2026-10-01T00:00:00.000Z",
        clients: [
          client("alice", SECRETS.alice, {
            name: "Alice laptop",
            allowedModels: ["qwen3.8-35b-a3b"],
            rateLimitRpm: 30,
            maxConcurrentRequests: 2,
            expiresAt: "2027-01-12T00:00:00.000Z",
            notes: "Weekend projects",
            lastUsedAt: "2026-10-01T12:00:00.000Z",
            usage: { requests: { total: 12, success: 11, error: 1 }, tokens: { prompt: 900, generation: 300, total: 1200 }, lastStatus: 200, lastModel: "qwen3.8-35b-a3b", lastAt: "2026-10-01T12:00:00.000Z" },
          }),
          client("bob", SECRETS.bob, { name: "Bob (paused)", enabled: false }),
          client("carol", SECRETS.carol, { name: "Carol trial", expiresAt: "2026-09-01T00:00:00.000Z" }),
          client("dave", SECRETS.dave, { name: "Dave Co", allowedModels: ["qwen3.8-35b-a3b", "gemma-4-31b"] }),
          client("Odd Client #1", SECRETS.odd, { name: "Odd\u0007 client" }),
          client("shared", SECRETS.shared, { name: "Shared desktop" }),
          client("twin", SECRETS.alice, { name: "Twin of alice" }),
          client("broken", SECRETS.bob, { name: "Broken hash", keyHash: "not-a-sha256-hash" }),
          client("global", SECRETS.reserved, { name: "Client named global" }),
        ],
      },
    },
    {
      id: "llama",
      billingId: "llama-manager",
      settings: {
        version: 1,
        exposureMode: "lan",
        requireApiKey: true,
        apiKey: "",
        apiKeyHash: "",
        apiKeyPreview: "",
        corsMode: "open",
        allowedOrigins: ["https://ignored.example.com"],
      },
      clients: {
        version: 1,
        clients: [
          client("alice", SECRETS.llamaAlice, { name: "Alice on llama" }),
          client("shared-copy", SECRETS.shared, { name: "Shared desktop (llama)" }),
          client("erin", SECRETS.erin, { name: "Erin", allowedModels: ["qwen3.8-*", "two words"] }),
        ],
      },
    },
  ];
}

function fixtureBindings() {
  return [
    { bindingId: "b1", managerId: "vllm-manager", serviceClientId: "dave", clientId: "dave", customerId: CUSTOMER_DAVE, active: true },
    { bindingId: "b2", managerId: "vllm-manager", serviceClientId: "bob", clientId: "bob", customerId: CUSTOMER_DAVE, active: false },
    { bindingId: "b3", managerId: "llama-manager", serviceClientId: "shared-copy", clientId: "shared-copy", customerId: CUSTOMER_SHARED, active: true },
  ];
}

function makeStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-migration-"));
  const store = createKeysStore({ file: path.join(dir, "platform-access.sqlite"), now: () => new Date(AT), ...options });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

function fixedNow() {
  return new Date(AT);
}

function rowsOf(store) {
  return migration.listStoreKeys(store).sort((left, right) => left.id.localeCompare(right.id));
}

function readGolden(compute) {
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify({ schemaVersion: 1, ...compute() }, null, 2)}\n`);
  }
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
}

function computeGolden(t) {
  const plan = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds: [] });
  const { store } = makeStore(t);
  const applied = migration.applyKeyMigration(store, plan, { now: fixedNow });
  return { plan, rows: rowsOf(store), report: applied.report };
}

function stateOf(store) {
  return {
    rows: rowsOf(store),
    audit: store.listAudit({ limit: 200 }).items,
    marker: store.getMeta(migration.MIGRATION_MARKER),
    report: store.getMeta(migration.MIGRATION_REPORT),
  };
}

test("the golden fixture plans exactly the expected rows and warnings", (t) => {
  const golden = readGolden(() => computeGolden(t));
  const plan = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds: [] });
  assert.deepEqual(plan, golden.plan);

  const byId = Object.fromEntries(plan.inserts.map((record) => [record.id, record]));
  assert.deepEqual(plan.inserts.map((record) => record.id), [
    "vllm.global", "vllm.alice", "vllm.bob", "vllm.carol", "vllm.dave", `vllm.m${sha256("Odd Client #1").slice(0, 8)}`,
    "vllm.shared", `vllm.m${sha256("global").slice(0, 8)}`, "llama.alice", "llama.erin",
  ]);
  // Duplicate ids across managers stay two keys with their own principals.
  assert.deepEqual(byId["vllm.alice"].billing, { scope: "vllm-manager", clientId: "alice" });
  assert.deepEqual(byId["llama.alice"].billing, { scope: "llama-manager", clientId: "alice" });
  assert.equal(byId["llama.alice"].ttsOwner, "llama:alice");
  // The same secret in both managers is one key that reaches both.
  assert.deepEqual(byId["vllm.shared"].fleetAllow, ["vllm:*", "llama:*"]);
  assert.deepEqual(byId["vllm.shared"].billing, { scope: "vllm-manager", clientId: "shared" });
  // Disabled, expired, bound and global keys.
  assert.equal(byId["vllm.bob"].status, "disabled");
  assert.equal(byId["vllm.bob"].class, "friend", "an inactive binding is no customer");
  assert.equal(byId["vllm.carol"].expiresAt, "2026-09-01T00:00:00.000Z");
  assert.equal(byId["vllm.dave"].class, "customer");
  assert.equal(byId["vllm.dave"].customerId, CUSTOMER_DAVE);
  assert.equal(byId["vllm.global"].class, "owner");
  assert.deepEqual(byId["vllm.global"].models, ["*"]);
  assert.deepEqual(byId["vllm.global"].billing, { scope: "vllm-manager", clientId: `global-${sha256(SECRETS.global).slice(0, 24)}` });
  assert.equal(byId["vllm.global"].ttsOwner, `vllm:global-${sha256(SECRETS.global).slice(0, 24)}`);
  // Scopes, models, limits, listeners and origins per §6.7.
  for (const record of plan.inserts) {
    assert.deepEqual(record.scopes, migration.LEGACY_SCOPES);
    assert.deepEqual(record.listeners, ["public", "admin"]);
    assert.equal(record.limits.tpm, null);
    assert.equal(record.limits.dailyTokens, null);
    assert.deepEqual(record.fleetAllow.slice(0, 1), [`${record.legacy.managerId}:*`]);
  }
  assert.deepEqual(byId["vllm.bob"].models, ["*"]);
  assert.deepEqual(byId["vllm.alice"].models, ["qwen3.8-35b-a3b"]);
  assert.deepEqual(byId["vllm.alice"].limits, {
    rpm: 30, tpm: null, maxConcurrent: 2, maxQueued: 128, queueTimeoutSeconds: 30, requestTimeoutSeconds: 600,
    dailyTokens: null, monthlyTokens: null, dailyRequests: null, maxOutputTokens: null,
  });
  assert.equal(byId["vllm.global"].limits.rpm, 600);
  assert.deepEqual(byId["vllm.alice"].allowedOrigins, ["https://chat.example.com"]);
  assert.deepEqual(byId["llama.alice"].allowedOrigins, []);
  assert.deepEqual(byId["llama.erin"].models, ["qwen3.8-*"]);

  assert.deepEqual(plan.warnings.map((warning) => `${warning.code}:${warning.keyId || warning.managerId}`), [
    "origin_not_migrated:vllm",
    "origin_not_migrated:vllm",
    "global_key_converted:vllm.global",
    `client_id_rewritten:vllm.m${sha256("Odd Client #1").slice(0, 8)}`,
    `client_id_rewritten:vllm.m${sha256("global").slice(0, 8)}`,
    "cors_open_not_migrated:llama",
    "duplicate_key_across_managers:vllm.shared",
    "model_pattern_dropped:llama.erin",
  ]);
  const duplicate = plan.warnings.find((warning) => warning.code === "duplicate_key_across_managers");
  assert.deepEqual(duplicate.duplicate, {
    managerId: "llama",
    clientId: "shared-copy",
    keyId: "llama.shared-copy",
    billing: { scope: "llama-manager", clientId: "shared-copy" },
    customerId: CUSTOMER_SHARED,
  });
  assert.deepEqual(plan.skipped.map((item) => `${item.keyId}:${item.reason}`), [
    "vllm.twin:duplicate_key_hash",
    "vllm.broken:unusable_hash",
  ]);
});

test("applying the plan imports rows that authenticate with the legacy secrets", (t) => {
  const golden = readGolden(() => computeGolden(t));
  const { store } = makeStore(t);
  const plan = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds: [] });
  const applied = migration.applyKeyMigration(store, plan, { now: fixedNow });
  assert.deepEqual(applied.inserted, plan.inserts.map((record) => record.id));
  assert.deepEqual(applied.skipped, []);
  assert.deepEqual(rowsOf(store), golden.rows);
  assert.deepEqual(applied.report, golden.report);
  assert.deepEqual(migration.readMigrationReport(store), golden.report);
  assert.equal(store.getMeta(migration.MIGRATION_MARKER), AT);
  assert.equal(store.listAudit({ action: "key.import", limit: 200 }).items.length, plan.inserts.length);

  const keyFor = (secret) => store.findBySecret(secret)?.key || null;
  assert.equal(keyFor(SECRETS.global).id, "vllm.global");
  assert.equal(keyFor(SECRETS.alice).id, "vllm.alice");
  assert.equal(keyFor(SECRETS.llamaAlice).id, "llama.alice");
  assert.equal(keyFor(SECRETS.shared).id, "vllm.shared");
  assert.equal(keyFor(SECRETS.odd).legacy.clientId, "Odd Client #1");
  assert.equal(keyFor(SECRETS.odd).name, "Odd client");
  assert.equal(keyFor(SECRETS.alice).preview, "fixture...0001");
  assert.equal(keyFor(SECRETS.alice).createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal(keyFor(SECRETS.alice).lastUsedAt, "2026-10-01T12:00:00.000Z");
  assert.equal(keyFor(SECRETS.alice).legacy.usage.requests.total, 12);

  const now = Date.parse(AT);
  assert.deepEqual(evaluateKey(keyFor(SECRETS.alice), { now, listener: "public", scope: "chat" }), { ok: true });
  assert.equal(evaluateKey(keyFor(SECRETS.bob), { now, scope: "chat" }).code, "key_disabled");
  assert.equal(evaluateKey(keyFor(SECRETS.carol), { now, scope: "chat" }).code, "key_expired");
  assert.equal(fleetAllowed(keyFor(SECRETS.shared), "llama:primary"), true);
  assert.equal(fleetAllowed(keyFor(SECRETS.alice), "llama:primary"), false, "a migrated key stays scoped to its manager");
  assert.equal(fleetAllowed(keyFor(SECRETS.alice), "vllm:primary"), true);

  // The report names keys and codes, never a hash.
  const report = applied.report;
  assert.equal(report.counts.inserted, plan.inserts.length);
  assert.deepEqual(report.keys.find((item) => item.keyId === "vllm.global"), {
    keyId: "vllm.global", name: "Global key (vllm)", source: "service-exposure", warnings: ["origin_not_migrated", "global_key_converted"],
  });
  assert.deepEqual(report.keys.find((item) => item.keyId === "vllm.shared").warnings, ["origin_not_migrated", "duplicate_key_across_managers"]);
  assert.deepEqual(report.keys.find((item) => item.keyId === "llama.alice").warnings, ["cors_open_not_migrated"]);
});

test("no hash appears in the plan's skips and warnings or in the report", (t) => {
  const { store } = makeStore(t);
  const plan = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds: [] });
  const applied = migration.applyKeyMigration(store, plan, { now: fixedNow });
  const hashes = Object.values(SECRETS).map(sha256);
  for (const [label, value] of [["skipped", plan.skipped], ["warnings", plan.warnings], ["report", applied.report], ["stored report", store.getMeta(migration.MIGRATION_REPORT)]]) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    assert.doesNotMatch(text, /[a-f0-9]{64}/i, label);
    for (const hash of hashes) assert.equal(text.includes(hash), false, label);
    for (const secret of Object.values(SECRETS)) assert.equal(text.includes(secret), false, label);
  }
});

test("a re-run is a no-op", (t) => {
  const { store } = makeStore(t);
  const first = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds: [] });
  migration.applyKeyMigration(store, first, { now: fixedNow });
  const before = stateOf(store);

  const existingKeyIds = migration.listStoreKeys(store).map((key) => key.id);
  const second = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds });
  assert.deepEqual(second.inserts, []);
  assert.deepEqual(second.warnings, first.warnings, "the warnings are recomputed, not lost");
  assert.equal(second.skipped.filter((item) => item.reason === "key_exists").length, first.inserts.length);
  const rerun = migration.applyKeyMigration(store, second, { now: () => new Date("2026-10-15T00:00:00.000Z") });
  assert.deepEqual(rerun.inserted, []);
  assert.deepEqual(stateOf(store), before);

  // Applying the original plan again skips every row inside the store.
  const replay = migration.applyKeyMigration(store, first, { now: () => new Date("2026-10-16T00:00:00.000Z") });
  assert.deepEqual(replay.inserted, []);
  assert.equal(replay.skipped.length, first.inserts.length);
  assert.ok(replay.skipped.every((item) => item.reason === "key_id_exists"));
  assert.deepEqual(stateOf(store), before);
});

test("planKeyMigration is pure and callable without a store", (t) => {
  const managers = fixtureManagers();
  const bindings = fixtureBindings();
  const snapshot = JSON.parse(JSON.stringify({ managers, bindings }));
  const one = migration.planKeyMigration({ managers, bindings, existingKeyIds: new Set(["vllm.alice"]) });
  const two = migration.planKeyMigration({ managers, bindings, existingKeyIds: ["vllm.alice"] });
  assert.deepEqual(one, two);
  assert.deepEqual({ managers, bindings }, snapshot, "the inputs are not mutated");
  assert.equal(one.inserts.some((record) => record.id === "vllm.alice"), false);
  assert.deepEqual(one.skipped.find((item) => item.keyId === "vllm.alice"), {
    keyId: "vllm.alice", managerId: "vllm", clientId: "alice", source: "service-clients", reason: "key_exists",
  });
  assert.deepEqual(migration.planKeyMigration({}), { inserts: [], skipped: [], warnings: [] });

  // Planning against a store's ids touches nothing in it.
  const { store } = makeStore(t);
  migration.planKeyMigration({ managers, bindings, existingKeyIds: migration.listStoreKeys(store).map((key) => key.id) });
  assert.equal(store.countKeys().total, 0);
  assert.equal(store.getMeta(migration.MIGRATION_MARKER), null);
  assert.equal(store.getMeta(migration.MIGRATION_REPORT), null);
});

test("planned records always pass the store's validation", () => {
  const managers = [{
    id: "vllm",
    billingId: "vllm-manager",
    settings: { apiKey: "fixture-plaintext-global-0001", corsMode: "restricted" },
    clients: [
      { id: "", keyHash: sha256("x") },
      { id: "ok", keyHash: sha256("ok"), name: "\u0000\u0001" },
      { id: "ok", keyHash: sha256("ok-again") },
      { id: "x".repeat(100), keyHash: sha256("long") },
    ],
  }, { id: "Bad Manager", clients: [{ id: "a", keyHash: sha256("a") }] }];
  const plan = migration.planKeyMigration({ managers });
  const ids = plan.inserts.map((record) => record.id);
  // A pre-hash settings file with a plaintext global key is hashed; the
  // plaintext never reaches the plan.
  assert.equal(plan.inserts[0].keyHash, sha256("fixture-plaintext-global-0001"));
  assert.equal(JSON.stringify(plan).includes("fixture-plaintext-global-0001"), false);
  assert.deepEqual(ids.slice(0, 2), ["vllm.global", "vllm.ok"]);
  assert.equal(plan.inserts[1].name, "ok", "a name of control characters falls back to the id");
  assert.equal(ids[2], `vllm.${"x".repeat(80)}`, "legacy ids are clipped to 80 characters as the managers did");
  assert.deepEqual(plan.skipped.map((item) => item.reason), ["missing_client_id", "duplicate_client_id", "invalid_manager"]);
});

function writeLegacyFiles(root, managers) {
  const roots = [];
  for (const manager of managers) {
    const managerRoot = path.join(root, `${manager.id}-manager`);
    fs.mkdirSync(path.join(managerRoot, "logs"), { recursive: true });
    fs.writeFileSync(path.join(managerRoot, "logs", "service-exposure-settings.json"), `${JSON.stringify(manager.settings, null, 2)}\n`);
    fs.writeFileSync(path.join(managerRoot, "logs", "service-clients.json"), `﻿${JSON.stringify(manager.clients)}`);
    roots.push({ id: manager.id, billingId: manager.billingId, root: managerRoot });
  }
  return roots;
}

function snapshotFiles(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = { bytes: fs.readFileSync(full), mtimeMs: fs.statSync(full).mtimeMs };
    }
  };
  walk(root);
  return files;
}

test("runKeyMigration reads the legacy files without changing a byte and runs once", async (t) => {
  const { store, dir } = makeStore(t);
  const legacyRoot = path.join(dir, "legacy");
  const managers = writeLegacyFiles(legacyRoot, fixtureManagers());
  const before = snapshotFiles(legacyRoot);

  const outcome = await migration.runKeyMigration({ store, managers, bindings: fixtureBindings(), now: fixedNow });
  assert.equal(outcome.ran, true);
  assert.equal(outcome.complete, true);
  const golden = readGolden(() => computeGolden(t));
  assert.deepEqual(outcome.plan, golden.plan, "files on disk plan exactly like the fixture");
  assert.deepEqual(rowsOf(store), golden.rows);
  assert.equal(store.getMeta(migration.MIGRATION_MARKER), AT);

  const after = snapshotFiles(legacyRoot);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const name of Object.keys(before)) {
    assert.ok(after[name].bytes.equals(before[name].bytes), `${name} is byte-identical`);
    assert.equal(after[name].mtimeMs, before[name].mtimeMs, `${name} was not rewritten`);
  }

  const state = stateOf(store);
  assert.deepEqual(await migration.runKeyMigration({ store, managers, bindings: fixtureBindings() }), { ran: false, reason: "already_migrated" });
  const forced = await migration.runKeyMigration({ store, managers, bindings: fixtureBindings(), force: true, now: () => new Date("2026-10-20T00:00:00.000Z") });
  assert.equal(forced.ran, true);
  assert.deepEqual(forced.inserted, []);
  assert.deepEqual(stateOf(store), state, "a forced re-run is a no-op");
});

test("an unreadable legacy file leaves that manager for the next start", async (t) => {
  const { store, dir } = makeStore(t);
  const legacyRoot = path.join(dir, "legacy");
  const managers = writeLegacyFiles(legacyRoot, fixtureManagers());
  const clientsFile = path.join(legacyRoot, "llama-manager", "logs", "service-clients.json");
  const good = fs.readFileSync(clientsFile);
  fs.writeFileSync(clientsFile, "{ not json");

  const partial = await migration.runKeyMigration({ store, managers, bindings: fixtureBindings(), now: fixedNow });
  assert.equal(partial.complete, false);
  assert.equal(store.getMeta(migration.MIGRATION_MARKER), null, "the next start runs again");
  assert.deepEqual(partial.report.warnings.at(-1), { code: "legacy_file_unreadable", managerId: "llama", file: "service-clients.json", reason: "invalid_json" });
  assert.equal(partial.report.complete, false);
  const ids = migration.listStoreKeys(store).map((key) => key.id);
  assert.equal(ids.some((id) => id.startsWith("llama.")), false);
  assert.deepEqual(store.getKey("vllm.shared").fleetAllow, ["vllm:*"]);

  fs.writeFileSync(clientsFile, good);
  const rest = await migration.runKeyMigration({ store, managers, bindings: fixtureBindings(), now: fixedNow });
  assert.equal(rest.complete, true);
  assert.deepEqual(rest.inserted, ["llama.alice", "llama.erin"]);
  assert.equal(store.getMeta(migration.MIGRATION_MARKER), AT);
  assert.equal(migration.readMigrationReport(store).counts.inserted, 2, "the report describes the run that imported rows");
});

test("without the billing bindings nothing is migrated", async (t) => {
  const { store, dir } = makeStore(t);
  const managers = writeLegacyFiles(path.join(dir, "legacy"), fixtureManagers());
  await assert.rejects(migration.runKeyMigration({
    store,
    managers,
    listBindings: () => {
      throw new Error("billing store is closed");
    },
  }), /billing store is closed/);
  assert.equal(store.countKeys().total, 0);
  assert.equal(store.getMeta(migration.MIGRATION_MARKER), null);
});

test("bindings are listed from the billing store", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-migration-billing-"));
  const billing = createBillingStore({ file: path.join(dir, "billing.sqlite") });
  t.after(() => {
    billing.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const customer = billing.createCustomer({ name: "Dave Co" });
  billing.bindCredential({ customerId: customer.customerId, managerId: "vllm-manager", serviceClientId: "dave" });
  const bindings = migration.listBillingBindings(billing);
  assert.equal(bindings.length, 1);
  const plan = migration.planKeyMigration({ managers: fixtureManagers(), bindings });
  const dave = plan.inserts.find((record) => record.id === "vllm.dave");
  assert.equal(dave.class, "customer");
  assert.equal(dave.customerId, customer.customerId);
});

test("the compat summary keeps the /api/keys shape and reads the store", (t) => {
  const nowMs = Date.parse(AT);
  const { store } = makeStore(t);
  const plan = migration.planKeyMigration({ managers: fixtureManagers(), bindings: fixtureBindings(), existingKeyIds: [] });
  migration.applyKeyMigration(store, plan, { now: fixedNow });
  store.revokeKey("vllm.carol", { actor: "test" });
  const platformKey = store.createKey({ name: "Platform friend", class: "friend", scopes: ["chat"], models: ["*"] }, { actor: "test" }).key;

  const statuses = [
    { id: "vllm", name: "vLLM Manager", baseUrl: "http://127.0.0.1:5177", servicePageUrl: "http://127.0.0.1:5177/#exposure", process: { portListening: true } },
    { id: "llama", name: "llama.cpp Manager", baseUrl: "http://127.0.0.1:5178", servicePageUrl: "http://127.0.0.1:5178/#exposure", process: { portListening: false } },
  ];
  const summary = migration.summarizeStoreKeys(store, statuses, { nowMs });
  // The same shape the legacy managers produced, field for field.
  const legacy = summarizeServiceKeys(fixtureManagers().map((manager, index) => ({
    ...statuses[index],
    exposure: { settings: { hasApiKey: Boolean(manager.settings.apiKeyHash) } },
    clients: manager.clients,
  })), { nowMs });
  assert.deepEqual(Object.keys(summary), Object.keys(legacy));
  assert.deepEqual(Object.keys(summary.perManager[0]), Object.keys(legacy.perManager[0]));
  assert.deepEqual(Object.keys(summary.clients[0]), Object.keys(legacy.clients[0]));
  assert.deepEqual(Object.keys(summary.attention[0]), Object.keys(legacy.attention[0]));

  assert.deepEqual(summary.globalKeys, ["vllm"]);
  assert.deepEqual(summary.perManager.map((item) => [item.manager, item.online, item.total]), [
    // alice, bob, dave, the odd id, shared and the client named global;
    // carol is revoked and the global key is not a client.
    ["vllm", true, 6],
    ["llama", false, 2],
    ["platform", true, 1],
  ]);
  const clients = Object.fromEntries(summary.clients.map((item) => [`${item.manager}:${item.id}`, item]));
  assert.equal(clients["vllm:carol"], undefined, "a revoked key is gone, as a deleted client was");
  assert.equal(clients["vllm:bob"].state, "disabled");
  assert.equal(clients["vllm:Odd Client #1"].name, "Odd client");
  assert.deepEqual(clients["vllm:bob"].allowedModels, [], "all models reads as the legacy empty list");
  assert.deepEqual(clients["vllm:alice"].allowedModels, ["qwen3.8-35b-a3b"]);
  assert.equal(clients["vllm:alice"].rateLimitRpm, 30);
  assert.equal(clients["vllm:alice"].managePageUrl, "http://127.0.0.1:5177/#exposure");
  assert.equal(clients[`platform:${platformKey.id}`].managerName, "平台密钥 / Platform keys");
  assert.equal(summary.clients.some((item) => item.id === "vllm.global" || item.name === "Global key (vllm)"), false);

  store.updateKey("vllm.global", { status: "disabled" }, { actor: "test" });
  assert.deepEqual(migration.summarizeStoreKeys(store, statuses, { nowMs }).globalKeys, []);
});

test("the entry migrates before listening and serves /api/keys from the access store", async (t) => {
  const { loadEntry, quietLogger, request, serveEntry } = require("./helpers/entry-harness");
  const { entry, tempDir } = await loadEntry();
  assert.deepEqual(entry.MANAGERS.map((manager) => [manager.id, manager.billingId]), [
    ["vllm", process.env.VLLM_MANAGER_ID || "vllm-manager"],
    ["llama", process.env.LLAMA_MANAGER_ID || "llama-manager"],
  ]);
  const store = entry.getAccessStore();
  assert.equal(path.dirname(store.file), path.dirname(path.resolve(process.env.AI_BILLING_DB)), "the access store sits beside the billing ledger");

  const legacyRoot = path.join(tempDir, "legacy");
  const managers = writeLegacyFiles(legacyRoot, fixtureManagers());
  const before = snapshotFiles(legacyRoot);
  const logger = quietLogger();
  const prepared = await entry.prepareAccessStore({ managers, logger });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.migration.ran, true);
  // The entry's billing ledger has no bindings, so dave stays a friend.
  assert.equal(store.getKey("vllm.dave").class, "friend");
  assert.equal(store.countKeys().total, 10);
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /legacy key migration imported 10 key\(s\), skipped 2, warnings: client_id_rewritten, cors_open_not_migrated/);
  for (const secret of Object.values(SECRETS)) assert.equal(logger.lines[0].includes(sha256(secret)), false);
  assert.deepEqual((await entry.prepareAccessStore({ managers, logger })).migration, { ran: false, reason: "already_migrated" });
  const forced = await entry.migrateLegacyKeys({ managers, force: true });
  assert.deepEqual(forced.inserted, []);
  for (const [name, file] of Object.entries(snapshotFiles(legacyRoot))) assert.ok(file.bytes.equals(before[name].bytes), name);

  const port = await serveEntry(t, entry);
  const response = await request(port, "/api/keys");
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  const keys = response.json.keys;
  assert.deepEqual(Object.keys(keys), [
    "updatedAt", "total", "active", "expired", "disabled", "unused", "expiringSoon", "globalKeys", "thresholds", "perManager", "attention", "clients",
  ]);
  assert.deepEqual(keys.globalKeys, ["vllm"]);
  assert.deepEqual(keys.perManager.map((item) => [item.manager, item.total]), [["vllm", 7], ["llama", 2]]);
  assert.equal(keys.total, 9);
  assert.equal(keys.disabled, 1);
  assert.equal(keys.expired, 1);
  assert.equal(JSON.stringify(keys).includes(sha256(SECRETS.alice)), false);

  const status = await request(port, "/api/status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.keys.perManager.map((item) => item.total), [7, 2], "/api/status carries the same summary");
  assert.equal(status.json.managers[0].billingId, entry.MANAGERS[0].billingId);

  // A read never opens the store: without it the summary is what the
  // (here offline) managers report, in the same shape.
  entry.closeAccessStore();
  const fallback = await request(port, "/api/keys");
  assert.equal(fallback.status, 200);
  assert.deepEqual(Object.keys(fallback.json.keys), Object.keys(keys));
  assert.equal(fallback.json.keys.total, 0);
  assert.equal(fs.existsSync(store.file), true);
});
