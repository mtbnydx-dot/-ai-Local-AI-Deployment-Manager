"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");
const schema = require("../telemetry/schema");
const storeWorker = require("../telemetry/store-worker");
const { openTelemetryStore } = require("../telemetry/store");
const log = require("../telemetry/audit-access-log");

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-access-log-"));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return dir;
}

function quietLogger() {
  const nothing = () => {};
  return { log: nothing, warn: nothing, error: nothing };
}

// Rows built by hand with the module's own hash, in the shape SELECT returns.
function buildChain(count, start = 1) {
  const rows = [];
  let prev = log.GENESIS_HASH;
  for (let index = 0; index < count; index += 1) {
    const row = {
      seq: start + index,
      at: NOW + index * 1000,
      source: index % 2 ? "vllm" : "entry",
      actor: "session:abcd1234",
      session: "0123456789ab",
      client_ip: "198.51.100.7",
      user_agent: "test-agent/1.0",
      action: "view_chat",
      target: `chat-${index}`,
      outcome: "ok",
      detail: JSON.stringify({ index }),
    };
    row.prev_hash = prev;
    row.hash = log.chainHash(prev, row);
    rows.push(row);
    prev = row.hash;
  }
  return rows;
}

test("the canonical row has every hashed field, in hash order, with null for unset ones", () => {
  assert.deepEqual(Object.keys(log.canonicalAuditRow({})), [...log.AUDIT_HASH_FIELDS]);
  assert.equal(
    log.canonicalAuditJson({ at: 1, source: "entry", actor: "a", action: "verify", outcome: "ok" }),
    '{"at":1,"source":"entry","actor":"a","session":null,"client_ip":null,"user_agent":null,"action":"verify","target":null,"outcome":"ok","detail":null}',
  );
  // camelCase entries hash like the stored snake_case row, and an object
  // detail hashes as the JSON text the store keeps.
  const entry = { at: 5, source: "entry", actor: "a", clientIp: "203.0.113.4", userAgent: "ua", action: "search", outcome: "ok", detail: { queryLength: 3 } };
  const stored = { at: 5, source: "entry", actor: "a", client_ip: "203.0.113.4", user_agent: "ua", action: "search", outcome: "ok", detail: '{"queryLength":3}' };
  assert.equal(log.canonicalAuditJson(entry), log.canonicalAuditJson(stored));
  assert.equal(log.chainHash(log.GENESIS_HASH, entry), log.chainHash(log.GENESIS_HASH, stored));
  assert.match(log.chainHash(log.GENESIS_HASH, stored), /^[0-9a-f]{64}$/);
  // The worker appends with this very function, so the two cannot drift.
  assert.equal(storeWorker.auditChainHash(log.GENESIS_HASH, stored), log.chainHash(log.GENESIS_HASH, stored));
  assert.equal(storeWorker.GENESIS_HASH, log.GENESIS_HASH);
});

test("verifyChain accepts an intact chain and an empty one", () => {
  assert.deepEqual(log.verifyChain([]), { ok: true, rows: 0, firstBrokenSeq: null, lastHash: log.GENESIS_HASH });
  const rows = buildChain(5);
  const result = log.verifyChain(rows);
  assert.equal(result.ok, true);
  assert.equal(result.rows, 5);
  assert.equal(result.firstBrokenSeq, null);
  assert.equal(result.lastHash, rows[4].hash);
});

test("verifyChain finds a changed field, a deleted row and a swapped pair", () => {
  const rows = buildChain(6);

  const edited = rows.map((row) => ({ ...row }));
  edited[3].outcome = "denied";
  assert.deepEqual(
    (({ ok, rows: count, firstBrokenSeq, reason }) => ({ ok, count, firstBrokenSeq, reason }))(log.verifyChain(edited)),
    { ok: false, count: 6, firstBrokenSeq: 4, reason: "hash_mismatch" },
  );

  // A row removed from the middle breaks the next row's link.
  const gap = rows.filter((row) => row.seq !== 3);
  const gapResult = log.verifyChain(gap);
  assert.equal(gapResult.ok, false);
  assert.equal(gapResult.firstBrokenSeq, 4);
  assert.equal(gapResult.reason, "prev_hash_mismatch");

  // Fixing the hash of an edited row still breaks the link after it.
  const forged = rows.map((row) => ({ ...row }));
  forged[1].actor = "session:someone-else";
  forged[1].hash = log.chainHash(forged[1].prev_hash, forged[1]);
  const forgedResult = log.verifyChain(forged);
  assert.equal(forgedResult.firstBrokenSeq, 3);
  assert.equal(forgedResult.reason, "prev_hash_mismatch");

  const swapped = [rows[0], rows[2], rows[1], ...rows.slice(3)];
  assert.equal(log.verifyChain(swapped).firstBrokenSeq, 3);

  // A chain that starts after the first row needs the hash it continues from.
  assert.equal(log.verifyChain(rows.slice(2)).firstBrokenSeq, 3);
  assert.equal(log.verifyChain(rows.slice(2), { prevHash: rows[1].hash }).ok, true);
});

test("search terms are recorded as a hash and a length unless logQueryText is on", () => {
  const hidden = log.describeSearchQuery("quarterly revenue");
  assert.deepEqual(hidden, {
    querySha256: crypto.createHash("sha256").update("quarterly revenue").digest("hex"),
    queryLength: 17,
  });
  assert.equal(JSON.stringify(hidden).includes("revenue"), false);
  assert.equal(log.describeSearchQuery("quarterly revenue", { logQueryText: true }).query, "quarterly revenue");
  assert.equal(log.describeSearchQuery("", {}).queryLength, 0);
  assert.equal(log.describeSearchQuery("x".repeat(1000), { logQueryText: true }).query.length, 256);
});

test("rows written by the store verify, list newest first with a cursor, and a tampered copy is detected", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  for (let index = 0; index < 7; index += 1) {
    await store.appendAuditAccess({
      at: NOW + index * 60_000,
      source: index === 3 ? "llama" : "entry",
      actor: "session:abcd1234",
      session: "0123456789ab",
      clientIp: "203.0.113.9",
      userAgent: "test-agent/1.0",
      action: index % 2 ? "view_chat" : "list_chats",
      target: `chat-${index}`,
      outcome: "ok",
      detail: { index, querySha256: "f".repeat(64), queryLength: 5 },
    });
  }

  // The entry reads the chain through the worker's built-in queries.
  const verified = await store.call("auditAccessVerify", {});
  assert.equal(verified.ok, true);
  assert.equal(verified.rows, 7);
  assert.equal(verified.firstBrokenSeq, null);

  const first = await store.call("auditAccessLog", { limit: 3 });
  assert.deepEqual(first.rows.map((row) => row.seq), [7, 6, 5]);
  assert.equal(first.nextCursor, 5);
  assert.equal(first.rows[0].at, new Date(NOW + 6 * 60_000).toISOString());
  assert.deepEqual(first.rows[0].detail, { index: 6, querySha256: "f".repeat(64), queryLength: 5 });
  assert.equal(first.rows[0].clientIp, "203.0.113.9");
  const second = await store.call("auditAccessLog", { limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.rows.map((row) => row.seq), [4, 3, 2]);
  const last = await store.call("auditAccessLog", { limit: 3, cursor: second.nextCursor });
  assert.deepEqual(last.rows.map((row) => row.seq), [1]);
  assert.equal(last.nextCursor, null);
  const windowed = await store.call("auditAccessLog", { from: NOW + 2 * 60_000, to: NOW + 4 * 60_000 });
  assert.deepEqual(windowed.rows.map((row) => row.seq), [5, 4, 3]);
  await assert.rejects(store.call("noSuchQuery", {}), { code: "unknown_query" });
  await store.close();

  // The same rows pass verifyChain outside the worker.
  const db = new sqlite.DatabaseSync(file);
  try {
    const rows = db.prepare("SELECT * FROM audit_access_log ORDER BY seq").all();
    assert.equal(log.verifyChain(rows).ok, true);
  } finally {
    db.close();
  }

  // A copy edited behind the triggers' back is caught by the same query.
  const tampered = path.join(dir, "tampered.sqlite");
  fs.copyFileSync(file, tampered);
  const copy = new sqlite.DatabaseSync(tampered);
  try {
    copy.exec("DROP TRIGGER audit_access_log_no_update");
    copy.exec("UPDATE audit_access_log SET actor = 'session:forged' WHERE seq = 4");
    const result = log.auditAccessVerify(copy);
    assert.equal(result.ok, false);
    assert.equal(result.rows, 7);
    assert.equal(result.firstBrokenSeq, 4);
    assert.equal(result.reason, "hash_mismatch");
    // Deleting a row is found at the row after it.
    copy.exec("UPDATE audit_access_log SET actor = 'session:abcd1234' WHERE seq = 4");
    assert.equal(log.auditAccessVerify(copy).ok, true);
    copy.exec("DROP TRIGGER audit_access_log_no_delete");
    copy.exec("DELETE FROM audit_access_log WHERE seq = 2");
    const gap = log.auditAccessVerify(copy);
    assert.equal(gap.ok, false);
    assert.equal(gap.firstBrokenSeq, 3);
  } finally {
    copy.close();
  }
});

test("verification pages through a long chain and reports the first broken row on a later page", (t) => {
  const db = new sqlite.DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const migration of schema.MIGRATIONS) migration.up(db);
  const insert = db.prepare(`INSERT INTO audit_access_log
    (seq, at, source, actor, session, client_ip, user_agent, action, target, outcome, detail, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = buildChain(2305);
  db.exec("BEGIN");
  for (const row of rows) {
    insert.run(row.seq, row.at, row.source, row.actor, row.session, row.client_ip, row.user_agent, row.action, row.target, row.outcome, row.detail, row.prev_hash, row.hash);
  }
  db.exec("COMMIT");
  const intact = log.auditAccessVerify(db);
  assert.equal(intact.ok, true);
  assert.equal(intact.rows, 2305);
  assert.equal(intact.lastHash, rows[2304].hash);

  db.exec("DROP TRIGGER audit_access_log_no_update");
  db.exec("UPDATE audit_access_log SET target = 'edited' WHERE seq = 2100");
  const broken = log.auditAccessVerify(db);
  assert.equal(broken.ok, false);
  assert.equal(broken.firstBrokenSeq, 2100);
  assert.equal(broken.rows, 2305);
});

test("a list request clamps its limit and ignores a malformed bound", (t) => {
  const db = new sqlite.DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const migration of schema.MIGRATIONS) migration.up(db);
  assert.deepEqual(log.auditAccessLog(db, {}), { rows: [], nextCursor: null });
  assert.deepEqual(log.auditAccessLog(db, { limit: 99999, from: "not a number", cursor: "x" }), { rows: [], nextCursor: null });
  assert.equal(log.auditAccessVerify(db).ok, true);
  assert.equal(log.auditAccessVerify(db).rows, 0);
});
