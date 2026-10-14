"use strict";

// Audit-of-audit log helpers (docs/overhaul/04 §16.4).
//
// Every audit action through the entry or a manager appends one row to
// audit_access_log, and each row's hash covers the row before it:
//
//   hash = sha256(prev_hash + "\n" + canonical JSON {at, source, actor, session,
//                 client_ip, user_agent, action, target, outcome, detail})
//
// prev_hash is 64 zeros for the first row. The store worker appends rows (and
// takes its hash from here); the entry's audit API reads them back through
// the two worker-side queries at the end of this file and checks the chain
// with verifyChain(). Everything is pure apart from those two queries, which
// receive the worker's database handle.

const crypto = require("node:crypto");

const GENESIS_HASH = "0".repeat(64);
// The hashed fields, in hash order (§16.4).
const AUDIT_HASH_FIELDS = Object.freeze([
  "at", "source", "actor", "session", "client_ip", "user_agent", "action", "target", "outcome", "detail",
]);
// camelCase spellings a caller may use for the snake_case columns.
const FIELD_ALIASES = Object.freeze({ client_ip: "clientIp", user_agent: "userAgent" });
const AUDIT_ACTIONS = Object.freeze([
  "login_ok", "login_failed", "logout", "list_exports", "view_markdown", "list_chats", "search", "view_chat",
  "chat_versions", "link_lookup", "export_manual", "export_scheduled", "export_failed", "export_skipped", "prune",
  "settings_change", "verify",
]);
const AUDIT_OUTCOMES = Object.freeze(["ok", "denied", "error"]);

const VERIFY_PAGE_ROWS = 1000;
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

function fieldOf(entry, field) {
  const direct = entry[field];
  if (direct !== undefined) return direct;
  const alias = FIELD_ALIASES[field];
  return alias ? entry[alias] : undefined;
}

// A detail object is hashed as the JSON text the store keeps for it; text is
// hashed as is, so the hash of a stored row never depends on how it is read.
function normalizeField(field, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (field === "detail" && typeof value === "object") return JSON.stringify(value);
  return value;
}

// The canonical object of one row, with every hashed field present (null when
// unset) in hash order. `entry` is a stored row (client_ip) or a row about to
// be stored (clientIp).
function canonicalAuditRow(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const row = {};
  for (const field of AUDIT_HASH_FIELDS) row[field] = normalizeField(field, fieldOf(source, field));
  return row;
}

function canonicalAuditJson(entry) {
  return JSON.stringify(canonicalAuditRow(entry));
}

function chainHash(prevHash, row) {
  return crypto.createHash("sha256").update(`${prevHash}\n${canonicalAuditJson(row)}`, "utf8").digest("hex");
}

// Recomputes the chain over `rows`, oldest first. The result is
// {ok, rows, firstBrokenSeq, lastHash, reason?}: firstBrokenSeq is the seq of
// the first row whose prev_hash does not continue the chain or whose hash does
// not match its content (null when intact). A deleted row shows up as the
// next row's prev_hash mismatch. options.prevHash continues a chain that
// started in an earlier page of rows (default: the genesis hash).
function verifyChain(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let expectedPrev = typeof options.prevHash === "string" && options.prevHash ? options.prevHash : GENESIS_HASH;
  let firstBrokenSeq = null;
  let reason = null;
  for (const row of list) {
    const prev = row.prev_hash ?? row.prevHash;
    const seq = Number(row.seq);
    let broken = null;
    if (prev !== expectedPrev) broken = "prev_hash_mismatch";
    else if (chainHash(prev, row) !== row.hash) broken = "hash_mismatch";
    if (broken) {
      firstBrokenSeq = Number.isFinite(seq) ? seq : null;
      reason = broken;
      break;
    }
    expectedPrev = row.hash;
  }
  const result = { ok: reason === null, rows: list.length, firstBrokenSeq, lastHash: expectedPrev };
  if (reason) result.reason = reason;
  return result;
}

// What the audit log records for a search: the hash and length of the text,
// or the text itself when audit.logQueryText is on (§16.4).
function describeSearchQuery(text, { logQueryText = false } = {}) {
  const query = String(text ?? "");
  const detail = {
    querySha256: crypto.createHash("sha256").update(query, "utf8").digest("hex"),
    queryLength: query.length,
  };
  if (logQueryText) detail.query = query.slice(0, 256);
  return detail;
}

function parseDetail(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A stored row as the API returns it.
function publicAuditRow(row) {
  const atMs = Number(row.at);
  return {
    seq: Number(row.seq),
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
    atMs: Number.isFinite(atMs) ? atMs : null,
    source: row.source,
    actor: row.actor,
    session: row.session ?? null,
    clientIp: row.client_ip ?? null,
    userAgent: row.user_agent ?? null,
    action: row.action,
    target: row.target ?? null,
    outcome: row.outcome,
    detail: parseDetail(row.detail),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function timeBound(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

// ---------------------------------------------------------------------------
// Worker-side queries. store.call("auditAccessLog" | "auditAccessVerify", params)
// runs these next to the database handle; the worker lists them as built-in
// queries, so they work before query.js (TEL-11) exists and alongside it.

// Newest first. params: {from, to, cursor, limit}, from/to in epoch ms and
// cursor the seq of the last row of the previous page. Returns
// {rows, nextCursor}.
function auditAccessLog(db, params = {}) {
  const input = params && typeof params === "object" ? params : {};
  const requested = Math.floor(Number(input.limit));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT;
  const where = [];
  const args = [];
  const from = timeBound(input.from);
  const to = timeBound(input.to);
  const cursor = timeBound(input.cursor);
  if (from !== null) { where.push("at >= ?"); args.push(from); }
  if (to !== null) { where.push("at <= ?"); args.push(to); }
  if (cursor !== null) { where.push("seq < ?"); args.push(cursor); }
  const sql = `SELECT seq, at, source, actor, session, client_ip, user_agent, action, target, outcome, detail, prev_hash, hash
    FROM audit_access_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`;
  const found = db.prepare(sql).all(...args, limit + 1);
  const page = found.slice(0, limit);
  return {
    rows: page.map(publicAuditRow),
    nextCursor: found.length > limit && page.length ? page[page.length - 1].seq : null,
  };
}

// Recomputes the whole chain in pages of rows. Returns verifyChain's result
// plus the total row count; it stops at the first broken row.
function auditAccessVerify(db) {
  const select = db.prepare(`SELECT seq, at, source, actor, session, client_ip, user_agent, action, target, outcome, detail, prev_hash, hash
    FROM audit_access_log WHERE seq > ? ORDER BY seq ASC LIMIT ?`);
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM audit_access_log").get().n);
  let afterSeq = 0;
  let prevHash = GENESIS_HASH;
  for (;;) {
    const page = select.all(afterSeq, VERIFY_PAGE_ROWS);
    if (!page.length) break;
    const checked = verifyChain(page, { prevHash });
    if (!checked.ok) return { ok: false, rows: total, firstBrokenSeq: checked.firstBrokenSeq, reason: checked.reason, lastHash: null };
    prevHash = checked.lastHash;
    afterSeq = Number(page[page.length - 1].seq);
    if (page.length < VERIFY_PAGE_ROWS) break;
  }
  return { ok: true, rows: total, firstBrokenSeq: null, lastHash: prevHash };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_HASH_FIELDS,
  AUDIT_OUTCOMES,
  GENESIS_HASH,
  auditAccessLog,
  auditAccessVerify,
  canonicalAuditJson,
  canonicalAuditRow,
  chainHash,
  describeSearchQuery,
  publicAuditRow,
  queries: Object.freeze({ auditAccessLog, auditAccessVerify }),
  verifyChain,
};
