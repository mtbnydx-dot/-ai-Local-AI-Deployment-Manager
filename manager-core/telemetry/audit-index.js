"use strict";

// Conversation index of the audit exports (docs/overhaul/04 §16.5, TEL-17).
//
// <auditRoot>/.index/audit-index.sqlite holds one row per (chat, export) in
// `chats`, the messages of that chat version in `messages`, and an FTS5
// `fts` table with the trigram tokenizer (CJK substring search for queries
// of 3 or more characters) linked to `messages` by rowid. It lives apart from
// telemetry.sqlite because it holds conversation content and shares the
// audit folder's protection. It is rebuilt from the exports at any time.
//
// Reading an export (up to about 10 MB of JSON) and inserting it runs in a
// short-lived worker thread per export, so the entry's event loop never parses
// it. `inProcess: true` does the same work on the calling thread (unit tests
// and sandboxes without worker support). Queries are short and run on the
// caller's own read connection.
//
// `is_latest` marks the newest export (by export creation time) that contains
// the chat. `exports` is an addition to the spec's three tables: it records
// which exports are indexed, with their creation time, for `versions`,
// back-fill and `is_latest`.
//
// No row or error here ever carries a password; errors carry a code and no
// conversation text.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const WORKER_KIND = "audit-index";
const EXPORT_JSON = "openwebui-chats-full.json";
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 10_000;
const MIN_FTS_CHARS = 3;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS exports (
     audit_id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     mode TEXT,
     chat_count INTEGER NOT NULL DEFAULT 0,
     message_count INTEGER NOT NULL DEFAULT 0,
     indexed_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS chats (
     chat_id TEXT NOT NULL,
     audit_id TEXT NOT NULL,
     user_id TEXT,
     user_name TEXT,
     user_email TEXT,
     user_role TEXT,
     title TEXT,
     models TEXT NOT NULL DEFAULT '[]',
     created_at TEXT,
     updated_at TEXT,
     message_count INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     is_latest INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (chat_id, audit_id)
   )`,
  "CREATE INDEX IF NOT EXISTS chats_latest ON chats (is_latest, updated_at DESC, chat_id)",
  "CREATE INDEX IF NOT EXISTS chats_audit ON chats (audit_id)",
  `CREATE TABLE IF NOT EXISTS messages (
     chat_id TEXT NOT NULL,
     audit_id TEXT NOT NULL,
     msg_id TEXT,
     parent_id TEXT,
     role TEXT,
     model TEXT,
     ts TEXT,
     content_sha256 TEXT,
     content TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, audit_id)",
  "CREATE INDEX IF NOT EXISTS messages_audit ON messages (audit_id)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, content, tokenize='trigram')",
];

function codeError(code, message, cause) {
  const error = new Error(message || code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

function iso(value) {
  if (value === null || value === undefined || value === "") return null;
  const millis = typeof value === "number" ? (value > 1e12 ? value : value * 1000) : Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function likePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function chars(value) {
  return Array.from(String(value)).length;
}

function initSchema(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const current = Number(db.prepare("PRAGMA user_version").get().user_version || 0);
  if (current > SCHEMA_VERSION) throw codeError("audit_index_too_new", "The audit index was written by a newer version.");
  for (const statement of SCHEMA) db.exec(statement);
  if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function openDatabase(file, { create = true } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  if (create) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

function inTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

// Recomputes is_latest for the given chats from the exports table.
function refreshLatest(db, chatIds) {
  const pick = db.prepare(
    `SELECT c.audit_id AS audit_id FROM chats c JOIN exports e ON e.audit_id = c.audit_id
      WHERE c.chat_id = ? ORDER BY e.created_at DESC, e.audit_id DESC LIMIT 1`,
  );
  const clear = db.prepare("UPDATE chats SET is_latest = 0 WHERE chat_id = ? AND is_latest = 1");
  const set = db.prepare("UPDATE chats SET is_latest = 1 WHERE chat_id = ? AND audit_id = ?");
  for (const chatId of chatIds) {
    const newest = pick.get(chatId);
    clear.run(chatId);
    if (newest) set.run(chatId, newest.audit_id);
  }
}

function deleteExportRows(db, auditId) {
  const chatIds = db.prepare("SELECT DISTINCT chat_id FROM chats WHERE audit_id = ?").all(auditId).map((row) => row.chat_id);
  db.prepare("DELETE FROM fts WHERE rowid IN (SELECT rowid FROM messages WHERE audit_id = ?)").run(auditId);
  db.prepare("DELETE FROM messages WHERE audit_id = ?").run(auditId);
  db.prepare("DELETE FROM chats WHERE audit_id = ?").run(auditId);
  const removed = db.prepare("DELETE FROM exports WHERE audit_id = ?").run(auditId);
  return { chatIds, removed: Number(removed.changes) > 0 };
}

function cleanAuditId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || /[\\/\0]/.test(id) || id === "." || id === "..") throw codeError("audit_id_invalid", "The audit id is not valid.");
  return id;
}

function modelsOf(chat, messages) {
  const found = [];
  const add = (value) => {
    const name = typeof value === "string" ? value.trim() : "";
    if (name && !found.includes(name)) found.push(name);
  };
  if (Array.isArray(chat.models)) chat.models.forEach(add);
  if (!found.length) messages.forEach((message) => add(message.model));
  return found;
}

// Reads <auditDir>/openwebui-chats-full.json and replaces the rows of that
// export. Used by the worker and by the in-process path.
function applyIndexExport(db, { auditDir, manifest = {}, indexedAt }) {
  const auditId = cleanAuditId(manifest.auditId || path.basename(auditDir));
  const file = path.join(auditDir, EXPORT_JSON);
  let raw;
  let stat;
  try {
    raw = fs.readFileSync(file, "utf8");
    stat = fs.statSync(file);
  } catch (error) {
    throw codeError(error?.code === "ENOENT" ? "audit_file_missing" : "audit_file_unreadable", `The export file ${EXPORT_JSON} could not be read.`);
  }
  let data;
  try {
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    throw codeError("audit_export_invalid", `${EXPORT_JSON} is not valid JSON.`);
  }
  raw = "";
  if (!data || typeof data !== "object" || !Array.isArray(data.chats)) throw codeError("audit_export_invalid", `${EXPORT_JSON} has no chats list.`);
  const createdAt = iso(manifest.createdAt) || iso(data.exported_at_utc) || stat.mtime.toISOString();
  const mode = text(manifest.mode) || (data.since_updated_at != null ? "incremental" : "full");

  const insertChat = db.prepare(
    `INSERT INTO chats (chat_id, audit_id, user_id, user_name, user_email, user_role, title, models, created_at, updated_at, message_count, archived, is_latest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages (chat_id, audit_id, msg_id, parent_id, role, model, ts, content_sha256, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare("INSERT INTO fts (rowid, title, content) VALUES (?, ?, ?)");

  return inTransaction(db, () => {
    const previous = deleteExportRows(db, auditId);
    const touched = new Set(previous.chatIds);
    let chatCount = 0;
    let messageCount = 0;
    const seenChats = new Set();
    const chatRows = [];
    for (const chat of data.chats) {
      if (!chat || typeof chat !== "object") continue;
      const chatId = text(chat.id);
      if (!chatId || seenChats.has(chatId)) continue;
      seenChats.add(chatId);
      const title = text(chat.title) || "";
      const seenMessages = new Set();
      const messages = [];
      for (const message of Array.isArray(chat.messages) ? chat.messages : []) {
        if (!message || typeof message !== "object") continue;
        const msgId = text(message.id);
        // The export lists history messages twice (list and dict form).
        if (msgId && seenMessages.has(msgId)) continue;
        if (msgId) seenMessages.add(msgId);
        messages.push(message);
      }
      for (const message of messages) {
        const content = contentText(message.content);
        const info = insertMessage.run(
          chatId,
          auditId,
          text(message.id),
          text(message.parent_id),
          text(message.role),
          text(message.model),
          iso(message.timestamp),
          text(message.content_sha256) || crypto.createHash("sha256").update(content).digest("hex"),
          content,
        );
        insertFts.run(info.lastInsertRowid, title, content);
      }
      chatRows.push([chatId, chat, title, messages]);
      messageCount += messages.length;
      chatCount += 1;
    }
    db.prepare(
      `INSERT INTO exports (audit_id, created_at, mode, chat_count, message_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(auditId, createdAt, mode, chatCount, messageCount, indexedAt);
    for (const [chatId, chat, title, messages] of chatRows) {
      insertChat.run(
        chatId,
        auditId,
        text(chat.user_id),
        text(chat.user_name),
        text(chat.user_email),
        text(chat.user_role),
        title,
        JSON.stringify(modelsOf(chat, messages)),
        iso(chat.created_at),
        iso(chat.updated_at),
        messages.length,
        chat.archived ? 1 : 0,
      );
      touched.add(chatId);
    }
    refreshLatest(db, touched);
    return { auditId, chats: chatCount, messages: messageCount, createdAt, mode };
  });
}

function removeExportFrom(db, auditId) {
  const id = cleanAuditId(auditId);
  return inTransaction(db, () => {
    const { chatIds, removed } = deleteExportRows(db, id);
    refreshLatest(db, chatIds);
    return { auditId: id, removed, chats: chatIds.length };
  });
}

function runInWorker(task) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(__filename, { workerData: { kind: WORKER_KIND, ...task } });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.once("message", (message) => {
      if (message?.ok) finish(resolve, message.result);
      else finish(reject, codeError(message?.error?.code || "audit_index_failed", message?.error?.message || "Indexing failed."));
    });
    worker.once("error", (error) => finish(reject, codeError("audit_index_worker_failed", "The indexing worker failed.", error)));
    worker.once("exit", (code) => finish(reject, codeError("audit_index_worker_failed", `The indexing worker exited with code ${code}.`)));
  });
}

function openAuditIndex(options = {}) {
  const { file, logger = console, inProcess = false, now = Date.now } = options;
  if (!file || typeof file !== "string") throw new TypeError("openAuditIndex needs a file");
  const db = openDatabase(file);
  initSchema(db);
  let closed = false;
  let building = false;
  let backfillRun = null;
  let queue = Promise.resolve();

  const warn = (message) => logger?.warn?.(`audit-index: ${message}`);
  const enqueue = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };
  const live = () => {
    if (closed) throw codeError("audit_index_closed", "The audit index is closed.");
  };

  async function indexExport(auditDir, manifest = {}) {
    live();
    const task = { file, auditDir: String(auditDir), manifest: manifest && typeof manifest === "object" ? manifest : {}, indexedAt: new Date(now()).toISOString() };
    return enqueue(async () => {
      live();
      if (inProcess) return applyIndexExport(db, task);
      return runInWorker({ action: "index", ...task });
    });
  }

  async function removeExport(auditId) {
    live();
    return enqueue(async () => {
      live();
      return removeExportFrom(db, auditId);
    });
  }

  function stats() {
    live();
    const row = db.prepare("SELECT COUNT(DISTINCT chat_id) AS chats, COUNT(*) AS versions FROM chats").get();
    const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
    const exportsRow = db.prepare("SELECT COUNT(*) AS n, MAX(indexed_at) AS at FROM exports").get();
    return {
      chats: Number(row.chats),
      versions: Number(row.versions),
      messages: Number(messages),
      exports: Number(exportsRow.n),
      lastIndexedAt: exportsRow.at || null,
      building,
    };
  }

  function chatSummary(row) {
    let models = [];
    try { models = JSON.parse(row.models || "[]"); } catch {}
    return {
      chatId: row.chat_id,
      title: row.title || "",
      userId: row.user_id,
      userName: row.user_name,
      userEmail: row.user_email,
      models,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: Number(row.message_count),
      archived: Boolean(row.archived),
      auditId: row.audit_id,
    };
  }

  function encodeCursor(row) {
    return Buffer.from(JSON.stringify([row.updated_key, row.chat_id]), "utf8").toString("base64url");
  }

  function decodeCursor(value) {
    if (!value) return null;
    try {
      const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") return parsed;
    } catch {}
    throw codeError("invalid_cursor", "The cursor is not valid.");
  }

  // Candidate rows are filtered first and ranked per chat afterwards, so a
  // search that only matches an older version of a chat still finds the chat
  // and shows the newest version that matched.
  function searchChats(query = {}) {
    live();
    const q = String(query.q ?? "").trim();
    const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = [];
    const args = [];
    let prefix = "";
    if (q) {
      if (chars(q) >= MIN_FTS_CHARS) {
        prefix = "WITH hits AS (SELECT DISTINCT m.chat_id AS chat_id, m.audit_id AS audit_id FROM fts JOIN messages m ON m.rowid = fts.rowid WHERE fts MATCH ?) ";
        args.push(`"${q.replace(/"/g, '""')}"`);
        where.push("((c.chat_id, c.audit_id) IN (SELECT chat_id, audit_id FROM hits) OR c.title LIKE ? ESCAPE '\\')");
        args.push(likePattern(q));
      } else {
        where.push("c.title LIKE ? ESCAPE '\\'");
        args.push(likePattern(q));
      }
    }
    const user = String(query.user ?? "").trim();
    if (user) {
      where.push("(c.user_id = ? OR c.user_name LIKE ? ESCAPE '\\' OR c.user_email LIKE ? ESCAPE '\\')");
      args.push(user, likePattern(user), likePattern(user));
    }
    const model = String(query.model ?? "").trim();
    if (model) {
      where.push("EXISTS (SELECT 1 FROM json_each(c.models) WHERE json_each.value = ?)");
      args.push(model);
    }
    const from = iso(query.from);
    const to = iso(query.to);
    if (from) { where.push("c.updated_at >= ?"); args.push(from); }
    if (to) { where.push("c.updated_at <= ?"); args.push(to); }
    if (query.archived === true || query.archived === false) {
      where.push("c.archived = ?");
      args.push(query.archived ? 1 : 0);
    }
    const cursor = decodeCursor(query.cursor);
    const outerWhere = ["rn = 1"];
    const outerArgs = [];
    if (cursor) {
      outerWhere.push("(updated_key, chat_id) < (?, ?)");
      outerArgs.push(cursor[0], cursor[1]);
    }
    const sql = `${prefix}SELECT * FROM (
        SELECT c.*, COALESCE(c.updated_at, '') AS updated_key,
               ROW_NUMBER() OVER (PARTITION BY c.chat_id ORDER BY e.created_at DESC, c.audit_id DESC) AS rn,
               (SELECT COUNT(*) FROM chats x WHERE x.chat_id = c.chat_id) AS versions
          FROM chats c JOIN exports e ON e.audit_id = c.audit_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ) WHERE ${outerWhere.join(" AND ")}
      ORDER BY updated_key DESC, chat_id DESC LIMIT ?`;
    const found = db.prepare(sql).all(...args, ...outerArgs, limit + 1);
    const page = found.slice(0, limit);
    return {
      rows: page.map((row) => ({ ...chatSummary(row), versions: Number(row.versions) })),
      nextCursor: found.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  function getChat(chatId, options = {}) {
    live();
    const id = String(chatId ?? "");
    const wanted = options.auditId ? String(options.auditId) : "";
    const row = wanted
      ? db.prepare("SELECT * FROM chats WHERE chat_id = ? AND audit_id = ?").get(id, wanted)
      : db.prepare("SELECT * FROM chats WHERE chat_id = ? AND is_latest = 1").get(id);
    if (!row) return null;
    const messages = db.prepare(
      "SELECT msg_id, parent_id, role, model, ts, content FROM messages WHERE chat_id = ? AND audit_id = ? ORDER BY rowid",
    ).all(row.chat_id, row.audit_id).map((message) => ({
      id: message.msg_id,
      parentId: message.parent_id,
      role: message.role,
      model: message.model,
      timestamp: message.ts,
      content: message.content,
      contentType: "markdown",
    }));
    return { chat: chatSummary(row), messages, auditId: row.audit_id, isLatest: Boolean(row.is_latest) };
  }

  function chatVersions(chatId) {
    live();
    const rows = db.prepare(
      `SELECT c.audit_id AS audit_id, e.created_at AS created_at, c.message_count AS message_count, c.updated_at AS updated_at
         FROM chats c JOIN exports e ON e.audit_id = c.audit_id
        WHERE c.chat_id = ? ORDER BY e.created_at DESC, c.audit_id DESC`,
    ).all(String(chatId ?? ""));
    return {
      versions: rows.map((row) => ({
        auditId: row.audit_id,
        createdAt: row.created_at,
        messageCount: Number(row.message_count),
        updatedAt: row.updated_at,
      })),
    };
  }

  function listIndexed() {
    live();
    return db.prepare("SELECT audit_id FROM exports").all().map((row) => row.audit_id);
  }

  // Indexes every export under auditRoot that is not indexed yet, newest
  // first, and drops index rows of exports that no longer exist (pruned by a
  // manager that does not know the index). One run at a time.
  function backfill(auditRoot) {
    live();
    if (backfillRun) return backfillRun;
    building = true;
    backfillRun = (async () => {
      const summary = { indexed: [], removed: [], failed: [], skipped: 0 };
      try {
        let entries;
        try {
          entries = await fsp.readdir(auditRoot, { withFileTypes: true });
        } catch (error) {
          if (error?.code === "ENOENT") return summary;
          throw error;
        }
        const found = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const dir = path.join(auditRoot, entry.name);
          let stat;
          try { stat = await fsp.stat(path.join(dir, EXPORT_JSON)); } catch { continue; }
          let manifest = {};
          try {
            const parsed = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
            if (parsed && typeof parsed === "object") manifest = parsed;
          } catch {}
          found.push({
            auditId: entry.name,
            dir,
            manifest: { ...manifest, auditId: entry.name },
            createdMs: Date.parse(iso(manifest.createdAt) || "") || stat.mtimeMs,
          });
        }
        found.sort((a, b) => b.createdMs - a.createdMs || (a.auditId < b.auditId ? 1 : -1));
        const present = new Set(found.map((item) => item.auditId));
        for (const auditId of listIndexed()) {
          if (present.has(auditId)) continue;
          try {
            await removeExport(auditId);
            summary.removed.push(auditId);
          } catch (error) {
            warn(`stale export ${auditId} could not be removed (${error?.code || "error"})`);
          }
        }
        const done = new Set(listIndexed());
        for (const item of found) {
          if (closed) break;
          if (done.has(item.auditId)) {
            summary.skipped += 1;
            continue;
          }
          try {
            await indexExport(item.dir, item.manifest);
            summary.indexed.push(item.auditId);
          } catch (error) {
            summary.failed.push({ auditId: item.auditId, code: error?.code || "error" });
            warn(`export ${item.auditId} could not be indexed (${error?.code || "error"})`);
          }
        }
        return summary;
      } finally {
        building = false;
        backfillRun = null;
      }
    })();
    return backfillRun;
  }

  async function close() {
    if (closed) return;
    try { await queue; } catch {}
    closed = true;
    try { db.close(); } catch {}
  }

  return { file, indexExport, removeExport, searchChats, getChat, chatVersions, stats, backfill, close };
}

function runWorker() {
  const { file, auditDir, manifest, indexedAt } = workerData;
  let db = null;
  try {
    db = openDatabase(file, { create: false });
    const result = applyIndexExport(db, { auditDir, manifest, indexedAt });
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: { code: error?.code && /^audit_/.test(String(error.code)) ? error.code : "audit_index_failed", message: String(error?.message || "Indexing failed.") } });
  } finally {
    try { db?.close(); } catch {}
  }
}

if (!isMainThread && workerData && workerData.kind === WORKER_KIND) runWorker();

module.exports = {
  EXPORT_JSON,
  applyIndexExport,
  openAuditIndex,
};
