"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const {
  KeysStoreError,
  SCHEMA_VERSION,
  banDurationSeconds,
  createKeysStore,
  normalizeKeyInput,
  quotaPeriods,
} = require("../lib/keys-store");
const { evaluateKey } = require("../lib/key-policy");

const START = Date.parse("2026-10-14T00:00:00.000Z");
const CUSTOMER_ID = "0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";

// Every table and column of 05-public.md §6.1, schemaVersion 1.
const EXPECTED_SCHEMA = {
  access_meta: ["key", "value"],
  api_keys: [
    "key_id", "name", "key_hash", "key_preview", "prev_key_hash", "prev_key_expires_at", "status", "class", "customer_id", "holder",
    "scopes", "models", "fleet_allow", "listeners", "rpm", "tpm", "max_concurrent", "max_queued", "queue_timeout_s", "request_timeout_s",
    "daily_tokens", "monthly_tokens", "daily_requests", "max_output_tokens", "allowed_origins", "allowed_ips", "labels", "expires_at",
    "notes", "billing_scope", "billing_client_id", "tts_owner", "legacy", "created_at", "created_by", "updated_at", "revoked_at",
    "last_used_at", "last_used_ip", "last_used_country",
  ],
  key_usage_counters: ["key_id", "period", "requests", "input_tokens", "cached_input_tokens", "output_tokens", "errors", "updated_at"],
  security_bans: ["subject", "kind", "reason", "source", "strikes", "created_at", "expires_at", "created_by"],
  access_audit: ["id", "at", "actor", "actor_ip", "action", "target_type", "target_id", "details"],
  admin_sessions: ["session_id", "secret_hash", "role", "created_at", "last_seen_at", "expires_at", "created_ip", "user_agent", "revoked_at"],
  admin_tokens: ["token_id", "name", "token_hash", "role", "created_at", "created_by", "last_used_at", "revoked_at"],
  admin_pair_codes: ["code_hash", "expires_at", "used_at", "created_by", "lan"],
  admin_elevations: ["elevation_id", "session_id", "scope", "secret_hash", "created_at", "expires_at", "revoked_at"],
  announcements: [
    "id", "severity", "title_zh", "title_en", "body_zh", "body_en", "starts_at", "ends_at", "audience", "published",
    "created_at", "updated_at", "created_by",
  ],
  public_model_meta: [
    "model_id", "display_name_zh", "display_name_en", "description_zh", "description_en", "aliases", "hidden", "recommended",
    "sort", "updated_at",
  ],
  status_samples: ["minute", "overall", "models"],
};

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const MISSING_ID = `k_${"a".repeat(20)}`;

// Stores and raw connections are closed before the temp dir is removed;
// Windows refuses to delete an open SQLite file.
function makeStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "service-entry-access-"));
  const file = path.join(dir, "platform-access.sqlite");
  const clock = { ms: START };
  const opened = [];
  const open = (extra = {}) => {
    const store = createKeysStore({ file, DatabaseSync, now: () => new Date(clock.ms), tzOffsetMinutes: 0, ...options, ...extra });
    opened.push(store);
    return store;
  };
  const raw = () => {
    const db = new DatabaseSync(file);
    opened.push(db);
    return db;
  };
  const store = open();
  t.after(() => {
    for (const item of opened) {
      try { item.close(); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, file, dir, clock, open, raw };
}

function friend(overrides = {}) {
  return {
    name: "Alice laptop",
    class: "friend",
    holder: "Alice",
    scopes: ["models.read", "chat", "messages", "self.read", "self.rotate"],
    models: ["qwen3.8-*"],
    listeners: ["public"],
    limits: { rpm: 30, tpm: 100000, maxConcurrent: 2, dailyTokens: 2000000, maxOutputTokens: 8192 },
    labels: { preset: "friend" },
    expiresAt: "2027-01-12T00:00:00.000Z",
    ...overrides,
  };
}

function expectStoreError(fn, code, status) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof KeysStoreError, `expected KeysStoreError ${code}, got ${caught}`);
  assert.equal(caught.code, code);
  if (status !== undefined) assert.equal(caught.status, status);
  return caught;
}

test("the §6.1 schema, including admin_elevations, is created idempotently", (t) => {
  const { store, clock, open, raw } = makeStore(t);
  assert.deepEqual(store.getPragmas(), { journalMode: "wal", foreignKeys: 1, synchronous: 1, busyTimeoutMs: 5000 });
  assert.equal(store.getMeta("schemaVersion"), String(SCHEMA_VERSION));
  assert.equal(store.getMeta("firstStartAt"), new Date(START).toISOString());
  const { key } = store.createKey(friend());
  store.close();

  // Reopening twice later changes nothing: same tables, same rows, same first start.
  clock.ms += 86_400_000;
  open().close();
  const reopened = open();
  assert.equal(reopened.getMeta("firstStartAt"), new Date(START).toISOString());
  assert.equal(reopened.getKey(key.id).name, "Alice laptop");
  reopened.close();

  const db = raw();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, Object.keys(EXPECTED_SCHEMA).sort());
  for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.deepEqual(actual, columns, table);
  }
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(triggers, ["access_audit_no_delete", "access_audit_no_update"]);
  assert.deepEqual(
    db.prepare("SELECT key FROM access_meta ORDER BY key").all().map((row) => row.key),
    ["firstStartAt", "schemaVersion"],
  );

  // admin_elevations belongs to a session and only knows the audit scope.
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(admin_elevations)").all();
  assert.equal(foreignKeys.length, 1);
  assert.equal(foreignKeys[0].table, "admin_sessions");
  assert.equal(foreignKeys[0].from, "session_id");
  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(
    () => db.prepare("INSERT INTO admin_elevations VALUES ('e1', 'missing', 'audit', 'h', 'a', 'b', NULL)").run(),
    /FOREIGN KEY/,
  );
  db.prepare("INSERT INTO admin_sessions VALUES ('s1', 'h', 'owner', 'a', 'a', 'b', NULL, NULL, NULL)").run();
  db.prepare("INSERT INTO admin_elevations VALUES ('e1', 's1', 'audit', 'h', 'a', 'b', NULL)").run();
  assert.throws(
    () => db.prepare("INSERT INTO admin_elevations VALUES ('e2', 's1', 'billing', 'h', 'a', 'b', NULL)").run(),
    /CHECK/,
  );
});

test("a store from a newer schema or a corrupt file fails closed", (t) => {
  const { store, file, dir, open } = makeStore(t);
  store.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE access_meta SET value='2' WHERE key='schemaVersion'").run();
  db.close();
  expectStoreError(() => open(), "access_store_unsupported_version", 503);

  const corrupt = path.join(dir, "corrupt.sqlite");
  fs.writeFileSync(corrupt, Buffer.alloc(4096, 0x5a));
  const error = expectStoreError(() => createKeysStore({ file: corrupt, DatabaseSync }), "access_store_unavailable", 503);
  assert.doesNotMatch(error.message, /corrupt\.sqlite|[A-Z]:\\/);
});

test("the access audit is append-only: UPDATE and DELETE are rejected", (t) => {
  const { store, raw } = makeStore(t);
  const entry = store.appendAudit({
    actor: "session:3f2a",
    actorIp: "::ffff:127.0.0.1",
    action: "settings.update",
    targetType: "settings",
    targetId: "public",
    details: { fields: ["public.defaults.rpm"] },
  });
  assert.equal(entry.actorIp, "127.0.0.1");
  assert.deepEqual(entry.details, { fields: ["public.defaults.rpm"] });

  const db = raw();
  assert.throws(() => db.prepare("UPDATE access_audit SET actor='someone-else'").run(), /access_audit is append-only/);
  assert.throws(() => db.prepare("DELETE FROM access_audit").run(), /access_audit is append-only/);
  assert.throws(() => db.prepare("DELETE FROM access_audit WHERE id=?").run(entry.id), /access_audit is append-only/);
  assert.equal(db.prepare("SELECT actor FROM access_audit WHERE id=?").get(entry.id).actor, "session:3f2a");

  // Credential-named fields are refused; secret- or hash-shaped strings are redacted.
  expectStoreError(() => store.appendAudit({ actor: "cli", action: "x.y", targetType: "key", details: { keyHash: "abc" } }), "audit_sensitive_field");
  expectStoreError(() => store.appendAudit({ actor: "cli", action: "x.y", targetType: "key", details: { nested: { csrfToken: "abc" } } }), "audit_sensitive_field");
  const redacted = store.appendAudit({
    actor: "cli",
    action: "x.y",
    targetType: "key",
    details: { note: `sk-${"plat-"}${"A".repeat(32)}`, digest: sha256("x"), dailyTokens: 5 },
  });
  assert.equal(redacted.details.note, "<redacted>");
  assert.equal(redacted.details.digest, "<redacted>");
  assert.equal(redacted.details.dailyTokens, 5);
  expectStoreError(() => store.appendAudit({ actor: "cli", action: "Bad Action", targetType: "key" }), "invalid_field");
  store.appendAudit({ actor: "cli", action: "x.z", targetType: "key" });

  // Three rows, newest first: a page of two, then the oldest.
  const page = store.listAudit({ limit: 2 });
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  const rest = store.listAudit({ cursor: page.nextCursor });
  assert.deepEqual(rest.items.map((item) => item.id), [entry.id]);
  assert.equal(store.listAudit({ action: "settings.update" }).items.length, 1);
  assert.equal(store.listAudit({ targetId: "public" }).items.length, 1);
});

test("createKey returns a one-time secret and a redacted KeyRecord", (t) => {
  const { store } = makeStore(t);
  const { key, secret } = store.createKey(friend(), { actor: "session:3f2a", ip: "127.0.0.1" });
  assert.match(secret, /^sk-plat-[A-Za-z0-9_-]{43}$/);
  assert.match(key.id, /^k_[a-z2-7]{20}$/);
  assert.equal(key.preview, `sk-plat-${secret.slice(8, 9)}…${secret.slice(-4)}`);
  assert.deepEqual(key, {
    id: key.id,
    name: "Alice laptop",
    preview: key.preview,
    status: "active",
    class: "friend",
    customerId: null,
    holder: "Alice",
    scopes: ["models.read", "chat", "messages", "self.read", "self.rotate"],
    models: ["qwen3.8-*"],
    fleetAllow: [],
    listeners: ["public"],
    limits: {
      rpm: 30, tpm: 100000, maxConcurrent: 2, maxQueued: null, queueTimeoutSeconds: null, requestTimeoutSeconds: null,
      dailyTokens: 2000000, monthlyTokens: null, dailyRequests: null, maxOutputTokens: 8192,
    },
    allowedOrigins: [],
    allowedIps: [],
    labels: { preset: "friend" },
    expiresAt: "2027-01-12T00:00:00.000Z",
    notes: null,
    billing: { scope: "platform", clientId: key.id },
    ttsOwner: `platform:${key.id}`,
    legacy: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    createdBy: "session:3f2a",
    updatedAt: "2026-10-14T00:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    lastUsedCountry: null,
    rotation: null,
  });
  assert.deepEqual(store.getKey(key.id), key);
  assert.equal(store.getKey(MISSING_ID), null);
  assert.equal(store.getKey("not a key id"), null);
  const audit = store.listAudit().items;
  assert.equal(audit[0].action, "key.create");
  assert.equal(audit[0].actor, "session:3f2a");
  assert.equal(audit[0].actorIp, "127.0.0.1");
  assert.ok(!JSON.stringify(audit).includes(secret.slice(8)));

  // Defaults: both listeners, no limits, active.
  const plain = store.createKey({ name: "Bare", class: "internal", scopes: ["chat"], models: ["*"] }).key;
  assert.deepEqual(plain.listeners, ["public", "admin"]);
  assert.ok(Object.values(plain.limits).every((value) => value === null));

  // Explicit ids and billing principals are create-only (legacy forwarders).
  const legacy = store.createKey({
    id: "vllm.bob",
    name: "Bob",
    class: "friend",
    scopes: ["chat"],
    models: ["*"],
    fleetAllow: ["vllm:*"],
    billing: { scope: "vllm-manager", clientId: "bob" },
    ttsOwner: "vllm:bob",
    legacy: { managerId: "vllm", clientId: "bob", source: "service-clients", keyHash: sha256("ignored") },
  }).key;
  assert.equal(legacy.id, "vllm.bob");
  assert.deepEqual(legacy.billing, { scope: "vllm-manager", clientId: "bob" });
  assert.deepEqual(legacy.legacy, { managerId: "vllm", clientId: "bob", source: "service-clients" });
  expectStoreError(() => store.createKey({ id: "vllm.bob", name: "Again", class: "friend", scopes: [], models: [] }), "key_conflict", 409);
  expectStoreError(() => store.createKey({
    id: "llama.bob", name: "Dup principal", class: "friend", scopes: [], models: [],
    billing: { scope: "vllm-manager", clientId: "bob" }, ttsOwner: "vllm:bob",
  }), "key_conflict", 409);
});

test("key input is validated field by field with 00 §4.2 errors", (t) => {
  const { store } = makeStore(t);
  const error = expectStoreError(() => store.createKey({
    class: "friend",
    scopes: ["chat", "admin"],
    models: "qwen",
    listeners: [],
    limits: { rpm: 0, tpm: 1.5, burst: 3 },
    allowedOrigins: ["https://app.example.com/path"],
    allowedIps: ["10.0.0.0/33"],
    labels: { "bad label": "x" },
    expiresAt: "tomorrow",
    secret: "sk-plat-nope",
  }), "invalid_field", 400);
  const fields = error.errors.map((item) => item.field).sort();
  assert.deepEqual(fields, [
    "allowedIps", "allowedOrigins", "expiresAt", "labels.bad label", "limits.burst", "limits.rpm", "limits.tpm",
    "listeners", "models", "name", "scopes", "secret",
  ]);
  assert.ok(error.errors.every((item) => item.code && item.message));
  assert.equal(error.errors.find((item) => item.field === "name").code, "required");
  assert.equal(error.errors.find((item) => item.field === "secret").code, "unknown_field");

  const customer = expectStoreError(() => store.createKey(friend({ class: "customer" })), "invalid_field");
  assert.deepEqual(customer.errors.map((item) => [item.field, item.code]), [["customerId", "required"]]);
  assert.equal(store.createKey(friend({ class: "customer", customerId: CUSTOMER_ID.toUpperCase() })).key.customerId, CUSTOMER_ID);

  // Origins and IPs are stored canonical and de-duplicated.
  const { key } = store.createKey(friend({
    allowedOrigins: ["https://App.example.com/", "https://app.example.com", "http://localhost:5173"],
    allowedIps: ["::ffff:10.1.2.3/104", "10.0.0.0/8", "192.168.1.7/32"],
  }));
  assert.deepEqual(key.allowedOrigins, ["https://app.example.com", "http://localhost:5173"]);
  assert.deepEqual(key.allowedIps, ["10.0.0.0/8", "192.168.1.7"]);
  assert.deepEqual(store.activeOrigins(), ["http://localhost:5173", "https://app.example.com"]);

  // Pure validation is exported for the routes.
  assert.equal(normalizeKeyInput(friend(), { mode: "create" }).name, "Alice laptop");
});

test("wildcard origins need a restricted friend or trial key, on create and on update", (t) => {
  const { store } = makeStore(t);
  const ok = store.createKey(friend({ scopes: ["models.read", "chat"], allowedOrigins: ["*"] })).key;
  assert.deepEqual(ok.allowedOrigins, ["*"]);
  const tooBroad = expectStoreError(
    () => store.createKey(friend({ scopes: ["chat", "embeddings"], allowedOrigins: ["*"] })),
    "wildcard_origin_requires_restricted_key",
    400,
  );
  assert.equal(tooBroad.errors[0].field, "allowedOrigins");
  expectStoreError(
    () => store.createKey(friend({ class: "internal", scopes: ["chat"], allowedOrigins: ["*"] })),
    "wildcard_origin_requires_restricted_key",
  );
  expectStoreError(() => store.updateKey(ok.id, { scopes: ["chat", "audio.speech"] }), "wildcard_origin_requires_restricted_key");
  expectStoreError(() => store.updateKey(ok.id, { class: "owner" }), "wildcard_origin_requires_restricted_key");
  assert.deepEqual(store.getKey(ok.id).scopes, ["models.read", "chat"]);
});

test("updateKey merges a patch and audits changed field names only", (t) => {
  const { store, clock } = makeStore(t);
  const { key } = store.createKey(friend());
  clock.ms += 60_000;
  const updated = store.updateKey(key.id, {
    limits: { rpm: 10, dailyTokens: null },
    models: ["qwen3.8-*", "!*-7b"],
    notes: "VIP\nsecond line",
    status: "disabled",
  }, { actor: "session:3f2a", ip: "127.0.0.1" });
  assert.equal(updated.limits.rpm, 10);
  assert.equal(updated.limits.tpm, 100000);
  assert.equal(updated.limits.dailyTokens, null);
  assert.equal(updated.status, "disabled");
  assert.equal(updated.notes, "VIP\nsecond line");
  assert.equal(updated.updatedAt, new Date(START + 60_000).toISOString());
  const audit = store.listAudit({ action: "key.update" }).items;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0].details, { fields: ["status", "models", "limits.rpm", "limits.dailyTokens", "notes"] });
  assert.ok(!JSON.stringify(audit[0].details).includes("VIP"));

  // No-op patches write nothing.
  store.updateKey(key.id, { limits: { rpm: 10 } });
  assert.equal(store.listAudit({ action: "key.update" }).items.length, 1);

  for (const patch of [{ id: "k_aaaaaaaaaaaaaaaaaaaa" }, { billing: { scope: "platform", clientId: "x" } }, { preview: "x" }, { status: "revoked" }]) {
    expectStoreError(() => store.updateKey(key.id, patch), "invalid_field");
  }
  expectStoreError(() => store.updateKey(MISSING_ID, { name: "x" }), "key_not_found", 404);
});

test("listKeys filters, searches and pages with a cursor", (t) => {
  const { store, clock } = makeStore(t);
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    clock.ms = START + index * 1000;
    ids.push(store.createKey(friend({
      name: `Key ${index}`,
      holder: index === 3 ? "Zoë 100%_match" : "Alice",
      class: index === 4 ? "trial" : "friend",
      expiresAt: new Date(START + (index + 1) * 86_400_000).toISOString(),
    })).key.id);
  }
  clock.ms = START + 10_000;
  store.updateKey(ids[1], { status: "disabled" });
  store.revokeKey(ids[2]);

  const first = store.listKeys({ limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), [ids[4], ids[3]]);
  const second = store.listKeys({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.id), [ids[2], ids[1]]);
  const third = store.listKeys({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map((item) => item.id), [ids[0]]);
  assert.equal(third.nextCursor, null);
  expectStoreError(() => store.listKeys({ cursor: "garbage" }), "invalid_field");

  assert.deepEqual(store.listKeys({ status: "active" }).items.map((item) => item.id), [ids[4], ids[3], ids[0]]);
  assert.deepEqual(store.listKeys({ status: "disabled" }).items.map((item) => item.id), [ids[1]]);
  assert.deepEqual(store.listKeys({ status: "revoked" }).items.map((item) => item.id), [ids[2]]);
  assert.deepEqual(store.listKeys({ class: "trial" }).items.map((item) => item.id), [ids[4]]);
  assert.deepEqual(store.listKeys({ q: "100%_" }).items.map((item) => item.id), [ids[3]]);
  assert.deepEqual(store.listKeys({ q: "KEY 0" }).items.map((item) => item.id), [ids[0]]);
  assert.deepEqual(store.listKeys({ expiringWithinDays: 2 }).items.map((item) => item.id).sort(), [ids[0], ids[1]].sort());
  expectStoreError(() => store.listKeys({ status: "sleeping" }), "invalid_field");

  clock.ms = START + 2.5 * 86_400_000;
  assert.deepEqual(store.listKeys({ status: "expired" }).items.map((item) => item.id), [ids[0]]);
  assert.deepEqual(store.countKeys(), {
    total: 5, active: 3, disabled: 1, revoked: 1, expired: 1,
    byClass: { owner: 0, internal: 0, friend: 4, trial: 1, customer: 0 },
  });
});

test("hash lookup finds current and previous keys only within the rotation overlap", (t) => {
  const { store, clock } = makeStore(t);
  const created = store.createKey(friend());
  const first = created.secret;
  assert.deepEqual(store.findBySecret(first).matched, "current");
  assert.equal(store.findByHash(sha256(first)).key.id, created.key.id);
  assert.equal(store.findByHash(sha256(first).toUpperCase()).matched, "current");

  const rotated = store.rotateKey(created.key.id, { overlapSeconds: 3600, actor: "session:3f2a" });
  const second = rotated.secret;
  assert.notEqual(second, first);
  assert.deepEqual(rotated.key.rotation, { previousValidUntil: "2026-10-14T01:00:00.000Z" });
  assert.notEqual(rotated.key.preview, created.key.preview);
  assert.equal(store.findBySecret(first).matched, "previous");
  assert.equal(store.findBySecret(second).matched, "current");
  assert.equal(store.findByHash(sha256(first)).matched, "previous");
  assert.deepEqual(store.listAudit({ action: "key.rotate" }).items[0].details, { overlapSeconds: 3600 });

  clock.ms = START + 3599_999;
  assert.equal(store.findBySecret(first).matched, "previous");
  clock.ms = START + 3600_000;
  assert.equal(store.findBySecret(first), null);
  assert.equal(store.findByHash(sha256(first)), null);
  assert.equal(store.getKey(created.key.id).rotation, null);
  // findBySecret also takes an explicit time.
  assert.equal(store.findBySecret(first, START + 1000).matched, "previous");
  assert.equal(store.findBySecret(second).matched, "current");

  // Overlap 0 retires the old secret immediately.
  const third = store.rotateKey(created.key.id, { overlapSeconds: 0 }).secret;
  assert.equal(store.findBySecret(second), null);
  assert.equal(store.findBySecret(third).matched, "current");

  // A second rotation inside an overlap keeps only the latest previous secret.
  const fourth = store.rotateKey(created.key.id, { overlapSeconds: 600 }).secret;
  const fifth = store.rotateKey(created.key.id, { overlapSeconds: 600, self: true }).secret;
  assert.equal(store.findBySecret(third), null);
  assert.equal(store.findBySecret(fourth).matched, "previous");
  assert.equal(store.findBySecret(fifth).matched, "current");
  assert.equal(store.listAudit({ action: "key.rotate.self" }).items.length, 1);

  for (const overlapSeconds of [-1, 604801, 1.5, "3600"]) {
    expectStoreError(() => store.rotateKey(created.key.id, { overlapSeconds }), "invalid_field");
  }
  assert.equal(store.rotateKey(created.key.id, { overlapSeconds: 604800 }).key.rotation.previousValidUntil, new Date(clock.ms + 604800_000).toISOString());

  assert.equal(store.findBySecret("sk-plat-unknown"), null);
  assert.equal(store.findBySecret(""), null);
  assert.equal(store.findBySecret(null), null);
  assert.equal(store.findByHash("abc"), null);
  assert.equal(store.findByHash(sha256("unknown")), null);
});

test("revocation is terminal and there is no hard delete for keys", (t) => {
  const { store, clock } = makeStore(t);
  const { key, secret } = store.createKey(friend());
  store.rotateKey(key.id, { overlapSeconds: 3600 });
  clock.ms += 1000;
  const revoked = store.revokeKey(key.id, { actor: "session:3f2a", reason: "lost laptop" });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedAt, new Date(START + 1000).toISOString());
  assert.equal(revoked.rotation, null);
  assert.equal(store.findBySecret(secret), null);
  assert.deepEqual(store.listAudit({ action: "key.revoke" }).items[0].details, { reason: "lost laptop" });

  expectStoreError(() => store.updateKey(key.id, { status: "active" }), "key_revoked", 409);
  expectStoreError(() => store.updateKey(key.id, { name: "renamed" }), "key_revoked", 409);
  expectStoreError(() => store.rotateKey(key.id), "key_revoked", 409);
  assert.equal(store.revokeKey(key.id).status, "revoked");
  assert.equal(store.listAudit({ action: "key.revoke" }).items.length, 1);

  // A revoked secret is still recognised, so the caller answers key_disabled.
  const current = store.createKey(friend({ name: "Second" }));
  store.revokeKey(current.key.id);
  const found = store.findBySecret(current.secret);
  assert.equal(found.key.status, "revoked");
  assert.equal(evaluateKey(found.key, { now: clock.ms, listener: "public", scope: "chat" }).code, "key_disabled");

  const keyDeleters = Object.keys(store).filter((name) => /key/i.test(name) && /delete|remove|purge|drop/i.test(name));
  assert.deepEqual(keyDeleters, []);
});

test("usage counters UPSERT and roll over the day and month in the quota tz offset", (t) => {
  // UTC+8: local midnight of 1 November is 2026-10-31T16:00Z.
  const { store, clock } = makeStore(t, { tzOffsetMinutes: 480 });
  const { key } = store.createKey(friend());
  clock.ms = Date.parse("2026-10-31T15:59:59.000Z");
  store.addUsage(key.id, { requests: 1, inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 });
  const before = store.addUsage(key.id, { requests: 1, inputTokens: 50, outputTokens: 5, errors: 1 });
  assert.deepEqual(before.day, { period: "d:2026-10-31", requests: 2, inputTokens: 150, cachedInputTokens: 40, outputTokens: 15, errors: 1 });
  assert.deepEqual(before.month, { period: "m:2026-10", requests: 2, inputTokens: 150, cachedInputTokens: 40, outputTokens: 15, errors: 1 });
  assert.equal(before.dayResetsAt, "2026-10-31T16:00:00.000Z");
  assert.equal(before.monthResetsAt, "2026-10-31T16:00:00.000Z");
  assert.equal(before.tzOffsetMinutes, 480);

  clock.ms = Date.parse("2026-10-31T16:00:00.000Z");
  const after = store.addUsage(key.id, { requests: 1, inputTokens: 7 });
  assert.deepEqual(after.day, { period: "d:2026-11-01", requests: 1, inputTokens: 7, cachedInputTokens: 0, outputTokens: 0, errors: 0 });
  assert.deepEqual(after.month, { period: "m:2026-11", requests: 1, inputTokens: 7, cachedInputTokens: 0, outputTokens: 0, errors: 0 });
  assert.equal(after.dayResetsAt, "2026-11-01T16:00:00.000Z");
  assert.equal(after.monthResetsAt, "2026-11-30T16:00:00.000Z");

  // Reading an earlier instant still sees the old periods.
  const earlier = store.getUsage(key.id, { at: "2026-10-31T10:00:00.000Z" });
  assert.equal(earlier.day.requests, 2);
  assert.equal(earlier.month.inputTokens, 150);
  assert.deepEqual(store.listDailyUsage(key.id, { from: "2026-10-31", to: "2026-11-01" }).map((row) => [row.date, row.requests]), [
    ["2026-10-31", 2],
    ["2026-11-01", 1],
  ]);
  assert.deepEqual(store.listDailyUsage(key.id, { from: "2026-11-01" }).map((row) => row.date), ["2026-11-01"]);

  // UTC−5 per call: 2026-11-01T04:59:59Z is still 31 October locally.
  assert.equal(store.addUsage(key.id, { at: "2026-11-01T04:59:59.000Z", requests: 1, tzOffsetMinutes: -300 }).day.period, "d:2026-10-31");
  assert.equal(store.getUsage(key.id, { at: "2026-11-01T05:00:00.000Z", tzOffsetMinutes: -300 }).day.period, "d:2026-11-01");
  assert.equal(store.getUsage(MISSING_ID).day.requests, 0);

  for (const bad of [{ requests: -1 }, { inputTokens: 1.5 }, { outputTokens: "3" }]) {
    expectStoreError(() => store.addUsage(key.id, bad), "invalid_field");
  }
  expectStoreError(() => store.addUsage("bad id", { requests: 1 }), "invalid_field");
});

test("the quota tz option may be a live function and periods are computed purely", (t) => {
  let offset = 0;
  const { store } = makeStore(t, { tzOffsetMinutes: () => offset });
  const { key } = store.createKey(friend());
  assert.equal(store.getUsage(key.id, { at: "2026-10-14T20:00:00.000Z" }).day.period, "d:2026-10-14");
  offset = 300;
  assert.equal(store.getUsage(key.id, { at: "2026-10-14T20:00:00.000Z" }).day.period, "d:2026-10-15");

  assert.deepEqual(quotaPeriods("2026-12-31T23:30:00.000Z", 60), {
    tzOffsetMinutes: 60,
    day: { key: "d:2027-01-01", start: "2026-12-31T23:00:00.000Z", end: "2027-01-01T23:00:00.000Z" },
    month: { key: "m:2027-01", start: "2026-12-31T23:00:00.000Z", end: "2027-01-31T23:00:00.000Z" },
  });
  assert.equal(quotaPeriods("2026-10-14T00:00:00.000Z", 100_000).tzOffsetMinutes, 840);
  assert.equal(quotaPeriods("2026-10-14T00:00:00.000Z", "nonsense").tzOffsetMinutes, 0);
});

test("bans escalate by strikes up to the cap and strikes decay after 24 h", (t) => {
  const { store, clock, open } = makeStore(t);
  const options = { banSeconds: 600, maxBanSeconds: 86400 };
  const durations = [];
  for (let strike = 1; strike <= 5; strike += 1) {
    const ban = store.escalateBan("203.0.113.5", options);
    assert.equal(ban.strikes, strike);
    assert.equal(ban.source, "auto");
    assert.equal(ban.kind, "ip");
    durations.push((Date.parse(ban.expiresAt) - clock.ms) / 1000);
    assert.equal(store.activeBanFor("203.0.113.5").subject, "203.0.113.5");
    assert.equal(store.activeBanFor("::ffff:203.0.113.5").strikes, strike);
    clock.ms = Date.parse(ban.expiresAt) + 1000;
    assert.equal(store.activeBanFor("203.0.113.5"), null);
  }
  assert.deepEqual(durations, [600, 2400, 9600, 38400, 86400]);
  assert.deepEqual([1, 2, 3, 4, 5, 50].map((strikes) => banDurationSeconds(strikes, 600, 86400)), [600, 2400, 9600, 38400, 86400, 86400]);

  // Just under 24 h after the last ban ended, the next ban still escalates.
  const last = store.listBans({ includeExpired: true })[0];
  clock.ms = Date.parse(last.expiresAt) + 86_399_000;
  assert.equal(store.escalateBan("203.0.113.5", options).strikes, 6);
  // 24 h after a ban ends without a new one, strikes start again at 1.
  clock.ms = Date.parse(store.activeBanFor("203.0.113.5").expiresAt) + 86_400_000;
  const fresh = store.escalateBan("203.0.113.5", options);
  assert.equal(fresh.strikes, 1);
  assert.equal((Date.parse(fresh.expiresAt) - clock.ms) / 1000, 600);

  // Bans persist across a reopen.
  store.close();
  const reopened = open();
  assert.equal(reopened.activeBanFor("203.0.113.5").strikes, 1);
});

test("admin bans, CIDR matching, protected loopback and pruning", (t) => {
  const { store, clock } = makeStore(t);
  const cidr = store.upsertBan({ subject: "198.51.100.77/24", kind: "cidr", reason: "scanner" }, { actor: "session:3f2a", ip: "127.0.0.1" });
  assert.equal(cidr.subject, "198.51.100.0/24");
  assert.equal(cidr.expiresAt, null);
  assert.equal(cidr.source, "admin");
  assert.equal(store.activeBanFor("198.51.100.9").subject, "198.51.100.0/24");
  assert.equal(store.activeBanFor("::ffff:198.51.100.9").subject, "198.51.100.0/24");
  assert.equal(store.activeBanFor("198.51.101.9"), null);
  const v6 = store.upsertBan({ subject: "2001:db8:abcd::/48", kind: "cidr", reason: "scanner" });
  assert.equal(store.activeBanFor("2001:db8:abcd:1::5").subject, v6.subject);

  // An active admin ban is never shortened by an automatic one.
  store.upsertBan({ subject: "192.0.2.10", kind: "ip", reason: "abuse" });
  const kept = store.escalateBan("192.0.2.10", { banSeconds: 60 });
  assert.equal(kept.source, "admin");
  assert.equal(kept.expiresAt, null);

  const keyBan = store.upsertBan({ subject: "vllm.egg", kind: "key", reason: "leaked", expiresAt: "2026-10-15T00:00:00Z" });
  assert.equal(store.activeBanFor("vllm.egg").expiresAt, "2026-10-15T00:00:00.000Z");
  assert.equal(keyBan.kind, "key");

  for (const subject of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(store.escalateBan(subject), null, subject);
    expectStoreError(() => store.upsertBan({ subject, kind: "ip", reason: "x" }), "ban_subject_protected", 400);
  }
  for (const subject of ["0.0.0.0/0", "127.0.0.0/8", "127.5.0.0/16", "::/0"]) {
    expectStoreError(() => store.upsertBan({ subject, kind: "cidr", reason: "x" }), "ban_subject_protected", 400);
  }
  expectStoreError(() => store.upsertBan({ subject: "10.0.0.0/8", kind: "ip", reason: "x" }), "invalid_field");
  expectStoreError(() => store.upsertBan({ subject: "nonsense", kind: "cidr", reason: "x" }), "invalid_field");
  expectStoreError(() => store.upsertBan({ subject: "1.2.3.4", kind: "user", reason: "x" }), "invalid_field");

  assert.deepEqual(store.listAudit({ action: "ban.upsert" }).items.map((item) => item.targetId).sort(), [
    "192.0.2.10", "198.51.100.0/24", "2001:db8:abcd::/48", "vllm.egg",
  ]);
  assert.equal(store.removeBan("198.51.100.0/24", { actor: "session:3f2a" }), true);
  assert.equal(store.removeBan("198.51.100.0/24"), false);
  assert.equal(store.activeBanFor("198.51.100.9"), null);
  assert.equal(store.listAudit({ action: "ban.remove" }).items.length, 1);

  // Expired automatic bans are listed only on request and pruned after decay.
  store.escalateBan("203.0.113.8", { banSeconds: 60 });
  clock.ms += 120_000;
  assert.ok(!store.listBans().some((ban) => ban.subject === "203.0.113.8"));
  assert.ok(store.listBans({ includeExpired: true }).some((ban) => ban.subject === "203.0.113.8" && !ban.active));
  assert.deepEqual(store.listBans({ kind: "key" }).map((ban) => ban.subject), ["vllm.egg"]);
  assert.equal(store.pruneBans(), 0);
  clock.ms += 86_400_000;
  assert.equal(store.pruneBans(), 1);
  assert.ok(store.listBans({ includeExpired: true }).every((ban) => ban.source === "admin"));
});

test("touchKey coalesces writes to one per five seconds per key", (t) => {
  const { store, clock, open } = makeStore(t);
  const { key } = store.createKey(friend());
  assert.equal(store.touchKey(key.id, { ip: "203.0.113.9", country: "DE" }), true);
  assert.equal(store.getKey(key.id).lastUsedAt, new Date(START).toISOString());
  assert.equal(store.getKey(key.id).lastUsedIp, "203.0.113.9");
  assert.equal(store.getKey(key.id).lastUsedCountry, "DE");

  clock.ms = START + 2000;
  assert.equal(store.touchKey(key.id, { ip: "203.0.113.10", country: "FR" }), false);
  assert.equal(store.getKey(key.id).lastUsedAt, new Date(START).toISOString());
  clock.ms = START + 4999;
  assert.equal(store.touchKey(key.id, { country: "zz" }), false);
  clock.ms = START + 5000;
  assert.equal(store.touchKey(key.id, { ip: "garbage" }), true);
  const written = store.getKey(key.id);
  assert.equal(written.lastUsedAt, new Date(START + 5000).toISOString());
  assert.equal(written.lastUsedIp, "203.0.113.9");

  // A pending touch is flushed on close.
  clock.ms = START + 7000;
  assert.equal(store.touchKey(key.id, { ip: "198.51.100.1", country: "NL" }), false);
  store.close();
  const reopened = open();
  const flushed = reopened.getKey(key.id);
  assert.equal(flushed.lastUsedAt, new Date(START + 7000).toISOString());
  assert.equal(flushed.lastUsedIp, "198.51.100.1");
  assert.equal(flushed.lastUsedCountry, "NL");
  // touchKey never moves lastUsedAt backwards.
  reopened.touchKey(key.id, { at: START });
  assert.equal(reopened.getKey(key.id).lastUsedAt, new Date(START + 7000).toISOString());
});

test("importKeys inserts pre-hashed legacy keys once and skips duplicates", (t) => {
  const { store } = makeStore(t);
  const legacySecret = "legacy-egg-test-secret-0001";
  const records = [{
    id: "vllm.egg",
    name: "egg",
    keyHash: sha256(legacySecret),
    preview: "sk-lega...0001",
    status: "disabled",
    class: "friend",
    scopes: ["models.read", "chat"],
    models: ["*"],
    fleetAllow: ["vllm:*"],
    billing: { scope: "vllm-manager", clientId: "egg" },
    ttsOwner: "vllm:egg",
    legacy: { managerId: "vllm", clientId: "egg", source: "service-clients", usage: { requests: { total: 3 } }, lastUsedAt: "2026-09-01T00:00:00.000Z" },
    createdAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: "2026-09-01T00:00:00.000Z",
  }];
  assert.deepEqual(store.importKeys(records, { actor: "migration" }), { inserted: ["vllm.egg"], skipped: [] });
  const imported = store.getKey("vllm.egg");
  assert.equal(imported.status, "disabled");
  assert.equal(imported.createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal(imported.createdBy, "migration");
  assert.equal(imported.lastUsedAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(imported.billing, { scope: "vllm-manager", clientId: "egg" });
  assert.equal(store.findBySecret(legacySecret).key.id, "vllm.egg");

  assert.deepEqual(store.importKeys(records), { inserted: [], skipped: [{ id: "vllm.egg", reason: "key_id_exists" }] });
  assert.deepEqual(store.importKeys([{ ...records[0], id: "llama.egg", billing: { scope: "llama-manager", clientId: "egg" } }]), {
    inserted: [],
    skipped: [{ id: "llama.egg", reason: "key_hash_exists" }],
  });
  assert.deepEqual(store.importKeys([{ ...records[0], id: "llama.egg2", keyHash: sha256("other") }]), {
    inserted: [],
    skipped: [{ id: "llama.egg2", reason: "billing_principal_exists" }],
  });
  const bad = expectStoreError(() => store.importKeys([{ ...records[0], id: "vllm.x", keyHash: "nothex" }]), "invalid_field");
  assert.equal(bad.errors[0].field, "records[0].keyHash");
  const badField = expectStoreError(() => store.importKeys([{ ...records[0], id: "vllm.y", keyHash: sha256("y"), scopes: ["root"] }]), "invalid_field");
  assert.equal(badField.errors[0].field, "records[0].scopes");
  assert.equal(store.listAudit({ action: "key.import" }).items.length, 1);
});

test("announcements, model metadata, status samples and meta values", (t) => {
  const { store, clock } = makeStore(t);
  const announcement = store.announcements.create({
    severity: "maintenance",
    title: { zh: "维护", en: "Maintenance" },
    body: { zh: "今晚维护", en: "Tonight" },
    startsAt: "2026-10-14T00:00:00Z",
    endsAt: "2026-10-15T00:00:00Z",
    published: true,
  }, { actor: "session:3f2a" });
  assert.match(announcement.id, /^an_[a-z2-7]{20}$/);
  assert.equal(announcement.title.en, "Maintenance");
  assert.deepEqual(store.announcements.list({ published: true, activeAt: START + 1000 }).map((item) => item.id), [announcement.id]);
  assert.deepEqual(store.listAnnouncements({ activeAt: "2026-10-16T00:00:00Z" }), []);
  assert.equal(store.updateAnnouncement(announcement.id, { published: false }).published, false);
  expectStoreError(() => store.announcements.update(announcement.id, { endsAt: "2026-10-13T00:00:00Z" }), "invalid_field");
  expectStoreError(() => store.announcements.create({ severity: "info" }), "invalid_field");
  assert.equal(store.announcements.remove(announcement.id), true);
  assert.equal(store.removeAnnouncement(announcement.id), false);

  const meta = store.modelMeta.upsert("qwen3.8-35b-a3b", { displayName: { en: "Qwen3.8 35B A3B" }, aliases: ["qwen3.8"], recommended: true });
  assert.deepEqual(meta.displayName, { zh: null, en: "Qwen3.8 35B A3B" });
  assert.deepEqual(store.upsertModelMeta("qwen3.8-35b-a3b", { hidden: true }).aliases, ["qwen3.8"]);
  assert.equal(store.getModelMeta("qwen3.8-35b-a3b").hidden, true);
  assert.equal(store.modelMeta.list().length, 1);
  expectStoreError(() => store.modelMeta.upsert("x", { hidden: "yes" }), "invalid_field");

  store.putSample("2026-10-14T00:00:30.000Z", { overall: "operational", models: { a: "ready" } });
  store.putSample(new Date(START + 60_000), { overall: "degraded", models: {} });
  clock.ms += 120_000;
  assert.deepEqual(store.listSamples("2026-10-14T00:01").map((item) => item.overall), ["degraded"]);
  assert.deepEqual(store.listSamples().map((item) => item.minute), ["2026-10-14T00:00", "2026-10-14T00:01"]);
  assert.equal(store.pruneSamples("2026-10-14T00:01"), 1);

  store.setMeta("migration.v1", "2026-10-14T00:00:00.000Z");
  store.setMeta("migration.report", { counts: { inserted: 1 } });
  assert.equal(store.getMeta("migration.v1"), "2026-10-14T00:00:00.000Z");
  assert.deepEqual(JSON.parse(store.getMeta("migration.report")), { counts: { inserted: 1 } });
  assert.equal(store.getMeta("missing"), null);
  expectStoreError(() => store.setMeta("schemaVersion", "9"), "meta_read_only");
  expectStoreError(() => store.setMeta("bad key!", "x"), "invalid_field");
});

test("the onChange hook reports key and ban changes without failing writes", (t) => {
  const changes = [];
  const { store } = makeStore(t, {
    onChange(change) {
      changes.push(change);
      throw new Error("listener bug");
    },
  });
  const { key } = store.createKey(friend());
  store.updateKey(key.id, { name: "Renamed" });
  store.rotateKey(key.id);
  store.revokeKey(key.id);
  store.escalateBan("203.0.113.5");
  assert.deepEqual(changes.map((change) => `${change.type}.${change.action}`), [
    "key.create", "key.update", "key.rotate", "key.revoke", "ban.escalate",
  ]);
});

test("no exported read returns a key hash", (t) => {
  const { store, clock } = makeStore(t);
  const created = store.createKey(friend({ allowedOrigins: ["https://app.example.com"] }), { actor: "session:3f2a", ip: "127.0.0.1" });
  const firstHash = sha256(created.secret);
  const rotated = store.rotateKey(created.key.id, { overlapSeconds: 3600 });
  const currentHash = sha256(rotated.secret);
  const legacyHash = sha256("legacy-import-test-secret-0001");
  store.importKeys([{
    id: "vllm.imported",
    name: "imported",
    keyHash: legacyHash,
    class: "friend",
    scopes: ["chat"],
    models: ["*"],
    billing: { scope: "vllm-manager", clientId: "imported" },
    ttsOwner: "vllm:imported",
    legacy: { managerId: "vllm", clientId: "imported", source: "service-clients", keyHash: legacyHash, usage: { hash: legacyHash } },
  }]);
  store.addUsage(created.key.id, { requests: 1, inputTokens: 5 });
  store.touchKey(created.key.id, { ip: "203.0.113.9", country: "DE" });
  store.escalateBan("203.0.113.5");
  store.upsertBan({ subject: created.key.id, kind: "key", reason: "test" });
  store.appendAudit({ actor: "cli", action: "test.event", targetType: "key", targetId: created.key.id, details: { note: firstHash } });
  const announcement = store.createAnnouncement({ title: { zh: "公告", en: "Notice" }, published: true });
  store.upsertModelMeta("qwen3.8", { aliases: ["q"] });
  store.putSample("2026-10-14T00:00", { overall: "operational", models: {} });
  store.setMeta("migration.v1", "done");
  const hashes = [firstHash, currentHash, legacyHash];
  const id = created.key.id;

  // Every export of the store, namespaces included, must appear here: a new
  // read added without a row fails this test.
  const calls = {
    file: () => store.file,
    createKey: () => store.createKey(friend({ name: "Another" })),
    getKey: () => [store.getKey(id), store.getKey("vllm.imported")],
    findBySecret: () => [store.findBySecret(rotated.secret), store.findBySecret(created.secret)],
    findByHash: () => [store.findByHash(currentHash), store.findByHash(firstHash), store.findByHash(legacyHash)],
    listKeys: () => [store.listKeys({}), store.listKeys({ q: "imported" }), store.listKeys({ status: "active", limit: 1 })],
    countKeys: () => store.countKeys(),
    activeOrigins: () => store.activeOrigins(),
    updateKey: () => store.updateKey(id, { notes: "updated" }),
    rotateKey: () => store.rotateKey("vllm.imported", { overlapSeconds: 60 }),
    revokeKey: () => store.revokeKey(store.createKey(friend({ name: "Doomed" })).key.id),
    importKeys: () => store.importKeys([]),
    touchKey: () => store.touchKey(id, {}),
    flushTouches: () => store.flushTouches(),
    addUsage: () => store.addUsage(id, { requests: 1 }),
    getUsage: () => store.getUsage(id),
    listDailyUsage: () => store.listDailyUsage(id, {}),
    upsertBan: () => store.upsertBan({ subject: "192.0.2.1", kind: "ip", reason: "x" }),
    escalateBan: () => store.escalateBan("203.0.113.6"),
    removeBan: () => store.removeBan("192.0.2.1"),
    listBans: () => store.listBans({ includeExpired: true }),
    activeBanFor: () => [store.activeBanFor("203.0.113.5"), store.activeBanFor(id)],
    pruneBans: () => store.pruneBans(),
    appendAudit: () => store.appendAudit({ actor: "cli", action: "test.read", targetType: "key" }),
    listAudit: () => store.listAudit({ limit: 200 }),
    "announcements.list": () => store.announcements.list(),
    "announcements.get": () => store.announcements.get(announcement.id),
    "announcements.create": () => store.announcements.create({ title: { zh: "二", en: "Two" } }),
    "announcements.update": () => store.announcements.update(announcement.id, { severity: "incident" }),
    "announcements.remove": () => store.announcements.remove("an_missing"),
    listAnnouncements: () => store.listAnnouncements(),
    getAnnouncement: () => store.getAnnouncement(announcement.id),
    createAnnouncement: () => store.createAnnouncement({ title: { zh: "三", en: "Three" } }),
    updateAnnouncement: () => store.updateAnnouncement(announcement.id, { published: false }),
    removeAnnouncement: () => store.removeAnnouncement("an_missing"),
    "modelMeta.list": () => store.modelMeta.list(),
    "modelMeta.get": () => store.modelMeta.get("qwen3.8"),
    "modelMeta.upsert": () => store.modelMeta.upsert("qwen3.8", { sort: 2 }),
    listModelMeta: () => store.listModelMeta(),
    getModelMeta: () => store.getModelMeta("qwen3.8"),
    upsertModelMeta: () => store.upsertModelMeta("qwen3.8", { sort: 3 }),
    putSample: () => store.putSample("2026-10-14T00:05", { overall: "operational", models: {} }),
    listSamples: () => store.listSamples(),
    pruneSamples: () => store.pruneSamples("2026-10-14T00:01"),
    getMeta: () => ["schemaVersion", "firstStartAt", "migration.v1"].map((name) => store.getMeta(name)),
    setMeta: () => store.setMeta("other", "x"),
    getPragmas: () => store.getPragmas(),
    close: () => store.close(),
  };
  const exported = [];
  for (const [name, value] of Object.entries(store)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const member of Object.keys(value)) exported.push(`${name}.${member}`);
    } else {
      exported.push(name);
    }
  }
  assert.deepEqual(exported.filter((name) => !(name in calls)), [], "every export is covered");
  assert.deepEqual(Object.keys(calls).filter((name) => !exported.includes(name)), [], "no stale rows");

  clock.ms += 1000;
  for (const [name, call] of Object.entries(calls)) {
    const output = JSON.stringify(call() ?? null);
    for (const hash of hashes) assert.ok(!output.includes(hash), `${name} leaked a key hash`);
    assert.doesNotMatch(output, /key_?hash|secret_hash|prev_key/i, name);
  }
});
