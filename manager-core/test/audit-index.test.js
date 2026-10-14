"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");
const { openAuditIndex, EXPORT_JSON } = require("../telemetry/audit-index");

const FIXTURES = path.join(__dirname, "fixtures", "telemetry", "audit-index");
const FULL = { auditId: "20261001-full", mode: "full", createdAt: "2026-10-01T04:00:00.000Z", fixture: "export-full.json" };
const INCREMENTAL = { auditId: "20261005-inc", mode: "incremental", createdAt: "2026-10-05T04:00:00.000Z", fixture: "export-incremental.json" };
const quiet = { warn() {}, log() {}, error() {} };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-index-"));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return dir;
}

function writeExport(auditRoot, item, { manifest = true } = {}) {
  const dir = path.join(auditRoot, item.auditId);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, item.fixture), path.join(dir, EXPORT_JSON));
  const body = { auditId: item.auditId, mode: item.mode, createdAt: item.createdAt };
  if (manifest) fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(body));
  return { dir, manifest: body };
}

function openIndex(t, dir, options = {}) {
  const index = openAuditIndex({ file: path.join(dir, ".index", "audit-index.sqlite"), logger: quiet, ...options });
  t.after(() => index.close());
  return index;
}

test("indexing an export reads the fixture in a worker and fills chats, messages and the stats", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  const full = writeExport(dir, FULL);
  const result = await index.indexExport(full.dir, full.manifest);
  assert.deepEqual({ auditId: result.auditId, chats: result.chats, messages: result.messages }, { auditId: FULL.auditId, chats: 3, messages: 5 });
  const stats = index.stats();
  assert.equal(stats.chats, 3);
  assert.equal(stats.messages, 5, "the duplicated history message is stored once");
  assert.equal(stats.building, false);
  assert.ok(Date.parse(stats.lastIndexedAt) > 0);

  const chat = index.getChat("chat-alpha");
  assert.equal(chat.auditId, FULL.auditId);
  assert.equal(chat.isLatest, true);
  assert.equal(chat.chat.title, "部署笔记 Deployment notes");
  assert.deepEqual(chat.chat.models, ["qwen3-8b"]);
  assert.equal(chat.chat.userEmail, "alice@example.invalid");
  assert.deepEqual(chat.messages.map((m) => m.id), ["a-1", "a-2"]);
  assert.equal(chat.messages[1].content, "使用 docker compose 启动 vLLM，然后检查健康端点。");
  assert.equal(chat.messages[1].contentType, "markdown");
  assert.equal(chat.messages[1].parentId, "a-1");
  assert.equal(chat.messages[1].timestamp, "2026-09-30T08:00:30.000Z");
  // A chat without models takes them from its messages.
  assert.deepEqual(index.getChat("chat-beta").chat.models, ["llama-3-70b"]);
  assert.equal(index.getChat("nope"), null);
});

test("indexing is idempotent: the same export twice leaves the same rows", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  const full = writeExport(dir, FULL);
  await index.indexExport(full.dir, full.manifest);
  await index.indexExport(full.dir, full.manifest);
  const stats = index.stats();
  assert.equal(stats.chats, 3);
  assert.equal(stats.versions, 3);
  assert.equal(stats.messages, 5);
  assert.equal(index.searchChats({ q: "docker compose" }).rows.length, 1);
});

test("trigram search finds CJK and English, case-insensitively, and returns one row per chat", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  const full = writeExport(dir, FULL);
  await index.indexExport(full.dir, full.manifest);

  const cjk = index.searchChats({ q: "健康端点" });
  assert.deepEqual(cjk.rows.map((r) => r.chatId), ["chat-alpha"]);
  assert.equal(cjk.rows[0].title, "部署笔记 Deployment notes");
  assert.equal(cjk.rows[0].auditId, FULL.auditId);
  assert.equal(cjk.rows[0].versions, 1);
  assert.deepEqual(cjk.rows[0].models, ["qwen3-8b"]);
  assert.equal(cjk.rows[0].messageCount, 2);

  assert.deepEqual(index.searchChats({ q: "QUARTERLY BUDGET" }).rows.map((r) => r.chatId), ["chat-beta"]);
  // Substring in the middle of a word, and a phrase with a space.
  assert.deepEqual(index.searchChats({ q: "docker compose" }).rows.map((r) => r.chatId), ["chat-alpha"]);
  assert.deepEqual(index.searchChats({ q: "uarterl" }).rows.map((r) => r.chatId), ["chat-beta"]);
  // FTS syntax characters in the query are plain text.
  assert.deepEqual(index.searchChats({ q: 'budget" OR chat' }).rows, []);
  assert.deepEqual(index.searchChats({ q: "nothing-like-this" }).rows, []);
  // A title-only hit works for a chat whose messages do not match.
  assert.deepEqual(index.searchChats({ q: "Deployment notes" }).rows.map((r) => r.chatId), ["chat-alpha"]);
});

test("queries under 3 characters fall back to LIKE on titles only", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  const full = writeExport(dir, FULL);
  await index.indexExport(full.dir, full.manifest);
  assert.deepEqual(index.searchChats({ q: "旧对" }).rows.map((r) => r.chatId), ["chat-gamma"]);
  // "你好" is only in a message body, so a short query does not see it.
  assert.deepEqual(index.searchChats({ q: "你好" }).rows, []);
  // LIKE wildcards are literal.
  assert.deepEqual(index.searchChats({ q: "%" }).rows, []);
  assert.deepEqual(index.searchChats({ q: "_" }).rows, []);
});

test("filters: user, model, archived, time range, and cursor paging", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  for (const item of [FULL, INCREMENTAL]) {
    const written = writeExport(dir, item);
    await index.indexExport(written.dir, written.manifest);
  }
  const ids = (query) => index.searchChats(query).rows.map((r) => r.chatId);
  assert.deepEqual(ids({}), ["chat-alpha", "chat-delta", "chat-beta", "chat-gamma"], "newest update first, one row per chat");
  assert.deepEqual(ids({ user: "u-1" }), ["chat-alpha", "chat-gamma"]);
  assert.deepEqual(ids({ user: "carol" }), ["chat-delta"]);
  assert.deepEqual(ids({ user: "bob@example" }), ["chat-beta"]);
  assert.deepEqual(ids({ model: "llama-3-70b" }), ["chat-beta"]);
  assert.deepEqual(ids({ archived: true }), ["chat-gamma"]);
  assert.deepEqual(ids({ archived: false }), ["chat-alpha", "chat-delta", "chat-beta"]);
  assert.deepEqual(ids({ from: Date.UTC(2026, 9, 1) }), ["chat-alpha", "chat-delta"]);
  assert.deepEqual(ids({ to: Date.UTC(2026, 8, 30) }), ["chat-beta", "chat-gamma"]);

  const first = index.searchChats({ limit: 3 });
  assert.equal(first.rows.length, 3);
  assert.ok(first.nextCursor);
  const second = index.searchChats({ limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.rows.map((r) => r.chatId), ["chat-gamma"]);
  assert.equal(second.nextCursor, null);
  assert.throws(() => index.searchChats({ cursor: "###" }), { code: "invalid_cursor" });
});

test("is_latest follows the newest export, and versions lists every export of a chat", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  // Indexed newest first, as the back-fill does: the older export must not take the flag.
  const incremental = writeExport(dir, INCREMENTAL);
  const full = writeExport(dir, FULL);
  await index.indexExport(incremental.dir, incremental.manifest);
  await index.indexExport(full.dir, full.manifest);

  const latest = index.getChat("chat-alpha");
  assert.equal(latest.auditId, INCREMENTAL.auditId);
  assert.equal(latest.isLatest, true);
  assert.equal(latest.messages.length, 4);
  assert.equal(latest.messages[3].content, '[{"type":"text","text":"降低 max-model-len 或启用 fp8 KV cache。"}]', "structured content is kept as JSON text");
  const older = index.getChat("chat-alpha", { auditId: FULL.auditId });
  assert.equal(older.isLatest, false);
  assert.equal(older.messages.length, 2);
  assert.equal(index.getChat("chat-alpha", { auditId: "missing" }), null);

  assert.deepEqual(index.chatVersions("chat-alpha").versions, [
    { auditId: INCREMENTAL.auditId, createdAt: INCREMENTAL.createdAt, messageCount: 4, updatedAt: "2026-10-04T09:00:00.000Z" },
    { auditId: FULL.auditId, createdAt: FULL.createdAt, messageCount: 2, updatedAt: "2026-09-30T08:05:00.000Z" },
  ]);
  assert.equal(index.chatVersions("chat-beta").versions.length, 1);
  assert.deepEqual(index.chatVersions("nope").versions, []);

  const hit = index.searchChats({ q: "显存不足" }).rows[0];
  assert.equal(hit.auditId, INCREMENTAL.auditId);
  assert.equal(hit.versions, 2);
  assert.deepEqual(index.searchChats({ q: "duplicate listing" }).rows, [], "the duplicate history message was never stored");

  const db = new sqlite.DatabaseSync(index.file, { readOnly: true });
  try {
    const flags = db.prepare("SELECT audit_id, is_latest FROM chats WHERE chat_id = 'chat-alpha' ORDER BY audit_id").all().map((r) => [r.audit_id, r.is_latest]);
    assert.deepEqual(flags, [[FULL.auditId, 0], [INCREMENTAL.auditId, 1]]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fts").get().n, db.prepare("SELECT COUNT(*) AS n FROM messages").get().n);
  } finally {
    db.close();
  }
});

test("pruning removes the export's index rows, its search hits, and hands is_latest back", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  for (const item of [FULL, INCREMENTAL]) {
    const written = writeExport(dir, item);
    await index.indexExport(written.dir, written.manifest);
  }
  assert.equal((await index.removeExport(INCREMENTAL.auditId)).removed, true);
  assert.equal(index.getChat("chat-delta"), null, "a chat only in the pruned export is gone");
  assert.deepEqual(index.searchChats({ q: "显存不足" }).rows, []);
  assert.deepEqual(index.searchChats({ q: "Résumé" }).rows, []);
  const alpha = index.getChat("chat-alpha");
  assert.equal(alpha.auditId, FULL.auditId);
  assert.equal(alpha.isLatest, true);
  assert.equal(index.chatVersions("chat-alpha").versions.length, 1);
  assert.equal((await index.removeExport(INCREMENTAL.auditId)).removed, false, "removing twice is harmless");

  await index.removeExport(FULL.auditId);
  const db = new sqlite.DatabaseSync(index.file, { readOnly: true });
  try {
    for (const table of ["exports", "chats", "messages", "fts"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  } finally {
    db.close();
  }
  assert.equal(index.stats().chats, 0);
  await assert.rejects(() => index.removeExport("../escape"), { code: "audit_id_invalid" });
});

test("back-fill indexes existing exports newest first, skips indexed ones, and drops pruned ones", async (t) => {
  const dir = tempDir(t);
  const auditRoot = path.join(dir, "audit");
  writeExport(auditRoot, FULL);
  writeExport(auditRoot, INCREMENTAL);
  // An export folder without the JSON, a hidden folder and a stray file are ignored.
  fs.mkdirSync(path.join(auditRoot, "20261006-empty"), { recursive: true });
  fs.mkdirSync(path.join(auditRoot, ".index"), { recursive: true });
  fs.writeFileSync(path.join(auditRoot, "audit-admin-password.txt"), "not-a-real-password");
  const index = openIndex(t, dir);

  const first = await index.backfill(auditRoot);
  assert.deepEqual(first.indexed, [INCREMENTAL.auditId, FULL.auditId]);
  assert.deepEqual(first.failed, []);
  assert.equal(index.stats().chats, 4);
  assert.equal(index.stats().exports, 2);
  assert.equal(index.getChat("chat-alpha").auditId, INCREMENTAL.auditId);

  const second = await index.backfill(auditRoot);
  assert.deepEqual(second.indexed, []);
  assert.equal(second.skipped, 2);

  // A manager pruned the incremental behind the index's back.
  fs.rmSync(path.join(auditRoot, INCREMENTAL.auditId), { recursive: true, force: true });
  const third = await index.backfill(auditRoot);
  assert.deepEqual(third.removed, [INCREMENTAL.auditId]);
  assert.equal(index.getChat("chat-alpha").auditId, FULL.auditId);
  assert.equal(index.getChat("chat-delta"), null);

  // A missing audit root is an empty back-fill, not an error.
  assert.deepEqual((await index.backfill(path.join(dir, "no-such-root"))).indexed, []);
});

test("back-fill takes the creation time from the manifest, falls back to the file time, and reports a broken export without stopping", async (t) => {
  const dir = tempDir(t);
  const auditRoot = path.join(dir, "audit");
  writeExport(auditRoot, FULL, { manifest: false });
  const broken = path.join(auditRoot, "20261007-broken");
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, EXPORT_JSON), "{ not json");
  fs.writeFileSync(path.join(broken, "manifest.json"), JSON.stringify({ createdAt: "2026-10-07T00:00:00.000Z" }));
  const index = openIndex(t, dir);
  const summary = await index.backfill(auditRoot);
  assert.deepEqual(summary.indexed, [FULL.auditId]);
  assert.deepEqual(summary.failed, [{ auditId: "20261007-broken", code: "audit_export_invalid" }]);
  assert.equal(index.stats().chats, 3);
  assert.ok(index.chatVersions("chat-alpha").versions[0].createdAt);
});

test("indexing errors carry a code, leave the index unchanged, and never include conversation text", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  const full = writeExport(dir, FULL);
  await index.indexExport(full.dir, full.manifest);
  await assert.rejects(() => index.indexExport(path.join(dir, "nowhere"), { auditId: "x" }), { code: "audit_file_missing" });
  const bad = path.join(dir, "bad");
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, EXPORT_JSON), JSON.stringify({ chats: "no" }));
  await assert.rejects(() => index.indexExport(bad, { auditId: "bad" }), { code: "audit_export_invalid" });
  fs.writeFileSync(path.join(bad, EXPORT_JSON), '{"chats": [{"id": "secret-chat", "title": "SECRET TITLE", "messages": [');
  await assert.rejects(() => index.indexExport(bad, { auditId: "bad" }), (error) => error.code === "audit_export_invalid" && !/SECRET/.test(error.message));
  assert.equal(index.stats().exports, 1);
  assert.equal(index.stats().chats, 3);
});

test("an export re-indexed with fewer chats drops the chats it no longer holds", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir);
  const full = writeExport(dir, FULL);
  await index.indexExport(full.dir, full.manifest);
  const data = JSON.parse(fs.readFileSync(path.join(full.dir, EXPORT_JSON), "utf8"));
  data.chats = data.chats.filter((chat) => chat.id !== "chat-gamma");
  fs.writeFileSync(path.join(full.dir, EXPORT_JSON), JSON.stringify(data));
  await index.indexExport(full.dir, full.manifest);
  assert.equal(index.getChat("chat-gamma"), null);
  assert.equal(index.stats().chats, 2);
  assert.deepEqual(index.searchChats({ q: "旧对" }).rows, []);
});

test("the in-process path gives the same result as the worker, and a closed index refuses work", async (t) => {
  const dir = tempDir(t);
  const index = openIndex(t, dir, { inProcess: true });
  const full = writeExport(dir, FULL);
  const result = await index.indexExport(full.dir, full.manifest);
  assert.equal(result.chats, 3);
  assert.deepEqual(index.searchChats({ q: "健康端点" }).rows.map((r) => r.chatId), ["chat-alpha"]);
  await index.close();
  await assert.rejects(() => index.indexExport(full.dir, full.manifest), { code: "audit_index_closed" });
  assert.throws(() => index.stats(), { code: "audit_index_closed" });
});

test("an index file from a newer version is refused and left untouched", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "future.sqlite");
  const db = new sqlite.DatabaseSync(file);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openAuditIndex({ file, logger: quiet }), { code: "audit_index_too_new" });
});
