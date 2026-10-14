"use strict";

// Platform access store (docs/overhaul/05-public.md §6): one node:sqlite file,
// service-entry/data/platform-access.sqlite, beside the billing database. It
// holds platform API keys, per-key usage counters, persistent bans, the
// append-only access audit, the admin session tables used by admin-session.js,
// announcements, public model metadata and status samples.
//
// Rules this module keeps:
//   - Only sha256(secret) is stored. A new secret is returned exactly once,
//     by createKey/rotateKey, and no read ever returns key_hash or
//     prev_key_hash: every key row leaves through keyFromRow.
//   - Revocation is terminal and there is no hard delete for keys.
//   - access_audit is append-only (enforced by triggers, not by convention).
//   - Opening is idempotent; a store that cannot be opened throws
//     access_store_unavailable so the caller can fail closed (§18).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { REDACTED, redactValue } = require("../../manager-core/secret-redactor");
const policy = require("./key-policy");

const SCHEMA_VERSION = 1;
const ACCESS_STORE_FILENAME = "platform-access.sqlite";
const SECRET_PREFIX = "sk-plat-";
const MAX_OVERLAP_SECONDS = 7 * 24 * 60 * 60;
const TOUCH_COALESCE_MS = 5000;
const DEFAULT_BAN_SECONDS = 600;
const DEFAULT_MAX_BAN_SECONDS = 86400;
const DEFAULT_STRIKE_DECAY_SECONDS = 86400;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 'k_<20 base32>' for new keys; '<managerId>.<clientId>' and
// '<managerId>.global' for keys migrated from the managers (§6.7).
const KEY_ID_RE = /^(?:k_[a-z2-7]{20}|[a-z][a-z0-9-]{0,31}\.[A-Za-z0-9._-]{1,80})$/;
const KEY_HASH_RE = /^[a-f0-9]{64}$/;
const BILLING_SCOPE_RE = /^(?:platform|[a-z0-9][a-z0-9._-]{0,63})$/;
const BILLING_CLIENT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TTS_OWNER_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z0-9._:-]{1,128}$/;
const LABEL_KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const META_KEY_RE = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const AUDIT_ACTION_RE = /^[a-z][a-z0-9_.-]{0,79}$/;
const AUDIT_TARGET_TYPE_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const HEX64_RUN_RE = /[a-f0-9]{64}/i;
const READ_ONLY_META = new Set(["schemaVersion"]);
const ANNOUNCEMENT_SEVERITIES = ["info", "maintenance", "incident"];
const ANNOUNCEMENT_AUDIENCES = ["all", "keys"];
const BAN_KINDS = ["ip", "cidr", "key"];
const BAN_SOURCES = ["auto", "admin"];

// Column, bounds and null meaning for every limit. A null rpm/tpm/concurrency
// limit inherits public.defaults; null token or request caps are unlimited.
const LIMIT_FIELDS = Object.freeze([
  { field: "rpm", column: "rpm", min: 1, max: 1_000_000 },
  { field: "tpm", column: "tpm", min: 1, max: 10_000_000_000 },
  { field: "maxConcurrent", column: "max_concurrent", min: 1, max: 1024 },
  { field: "maxQueued", column: "max_queued", min: 0, max: 10_000 },
  { field: "queueTimeoutSeconds", column: "queue_timeout_s", min: 1, max: 3600 },
  { field: "requestTimeoutSeconds", column: "request_timeout_s", min: 1, max: 86_400 },
  { field: "dailyTokens", column: "daily_tokens", min: 0, max: 1_000_000_000_000 },
  { field: "monthlyTokens", column: "monthly_tokens", min: 0, max: 1_000_000_000_000 },
  { field: "dailyRequests", column: "daily_requests", min: 0, max: 1_000_000_000 },
  { field: "maxOutputTokens", column: "max_output_tokens", min: 1, max: 10_000_000 },
]);

// Field names of KeyRecord that an admin may set on create or update.
const EDITABLE_KEY_FIELDS = Object.freeze([
  "name", "status", "class", "customerId", "holder", "scopes", "models", "fleetAllow", "listeners",
  "limits", "allowedOrigins", "allowedIps", "labels", "expiresAt", "notes",
]);
// Create-only fields: the identity and billing principal of a key never change.
const CREATE_ONLY_KEY_FIELDS = Object.freeze(["id", "billing", "ttsOwner", "legacy"]);
const LEGACY_FIELDS = Object.freeze(["managerId", "clientId", "source", "usage", "lastUsedAt"]);

// §6.1, schemaVersion 1. Every statement is idempotent.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS access_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_preview TEXT NOT NULL,
  prev_key_hash TEXT UNIQUE, prev_key_expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','disabled','revoked')),
  class TEXT NOT NULL CHECK (class IN ('owner','internal','friend','trial','customer')),
  customer_id TEXT, holder TEXT,
  scopes TEXT NOT NULL, models TEXT NOT NULL, fleet_allow TEXT NOT NULL DEFAULT '[]', listeners TEXT NOT NULL DEFAULT '["public","admin"]',
  rpm INTEGER, tpm INTEGER, max_concurrent INTEGER, max_queued INTEGER, queue_timeout_s INTEGER, request_timeout_s INTEGER,
  daily_tokens INTEGER, monthly_tokens INTEGER, daily_requests INTEGER, max_output_tokens INTEGER,
  allowed_origins TEXT NOT NULL DEFAULT '[]', allowed_ips TEXT NOT NULL DEFAULT '[]', labels TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT, notes TEXT,
  billing_scope TEXT NOT NULL, billing_client_id TEXT NOT NULL, tts_owner TEXT NOT NULL,
  legacy TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
  last_used_at TEXT, last_used_ip TEXT, last_used_country TEXT,
  UNIQUE (billing_scope, billing_client_id)
);
CREATE INDEX IF NOT EXISTS idx_api_keys_created ON api_keys(created_at, key_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_customer ON api_keys(customer_id);
CREATE TABLE IF NOT EXISTS key_usage_counters (key_id TEXT NOT NULL, period TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (key_id, period));
CREATE TABLE IF NOT EXISTS security_bans (subject TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('ip','cidr','key')),
  reason TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('auto','admin')), strikes INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, expires_at TEXT, created_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_security_bans_kind ON security_bans(kind, expires_at);
CREATE TABLE IF NOT EXISTS access_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, actor_ip TEXT,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_access_audit_target ON access_audit(target_id, id);
CREATE INDEX IF NOT EXISTS idx_access_audit_action ON access_audit(action, id);
CREATE TRIGGER IF NOT EXISTS access_audit_no_update BEFORE UPDATE ON access_audit BEGIN SELECT RAISE(ABORT,'access_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS access_audit_no_delete BEFORE DELETE ON access_audit BEGIN SELECT RAISE(ABORT,'access_audit is append-only'); END;
CREATE TABLE IF NOT EXISTS admin_sessions (session_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_ip TEXT, user_agent TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS admin_tokens (token_id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS admin_pair_codes (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT NOT NULL, lan INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS admin_elevations (elevation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES admin_sessions(session_id),
  scope TEXT NOT NULL CHECK (scope IN ('audit')), secret_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_admin_elevations_session ON admin_elevations(session_id);
CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, severity TEXT NOT NULL CHECK (severity IN ('info','maintenance','incident')),
  title_zh TEXT NOT NULL, title_en TEXT NOT NULL, body_zh TEXT NOT NULL DEFAULT '', body_en TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL, ends_at TEXT, audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','keys')),
  published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS public_model_meta (model_id TEXT PRIMARY KEY, display_name_zh TEXT, display_name_en TEXT, description_zh TEXT,
  description_en TEXT, aliases TEXT NOT NULL DEFAULT '[]', hidden INTEGER NOT NULL DEFAULT 0, recommended INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS status_samples (minute TEXT PRIMARY KEY, overall TEXT NOT NULL, models TEXT NOT NULL);
`;

class KeysStoreError extends Error {
  constructor(code, message, status = 400, errors = []) {
    super(message);
    this.name = "KeysStoreError";
    this.code = code;
    this.status = status;
    // 00 §4.2 field errors: [{ field, code, message }].
    this.errors = errors;
  }
}

function invalid(errors, message = "Key fields are invalid.") {
  return new KeysStoreError("invalid_field", message, 400, errors);
}

function createKeysStore(options = {}) {
  const DatabaseSync = options.DatabaseSync || require("node:sqlite").DatabaseSync;
  if (typeof DatabaseSync !== "function") {
    throw new KeysStoreError("access_store_unavailable", "SQLite DatabaseSync is unavailable.", 503);
  }
  const file = normalizeDatabaseFile(options.file || ":memory:");
  const clock = typeof options.now === "function" ? options.now : () => new Date();
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  const busyTimeoutMs = boundedInteger(options.busyTimeoutMs ?? 5000, 100, 60_000, 5000);
  const tzOption = options.tzOffsetMinutes ?? process.env.BILLING_TZ_OFFSET_MINUTES ?? 0;
  const onChange = typeof options.onChange === "function" ? options.onChange : null;

  let db;
  try {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    configureDatabase(db, busyTimeoutMs);
    ensureSchema(db, toIso(clock()));
  } catch (error) {
    try { db?.close(); } catch {}
    if (error instanceof KeysStoreError) throw error;
    const wrapped = new KeysStoreError("access_store_unavailable", "Access store could not be opened.", 503);
    wrapped.cause = error;
    throw wrapped;
  }

  let closed = false;
  const statements = new Map();
  const touchState = new Map();

  function assertOpen() {
    if (closed) throw new KeysStoreError("access_store_closed", "Access store is closed.", 503);
  }

  function prepare(sql) {
    assertOpen();
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  function transaction(operation) {
    assertOpen();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function nowDate(value) {
    const date = toDate(value === undefined || value === null ? clock() : value);
    if (!date) throw new KeysStoreError("access_clock_invalid", "Access store time is invalid.", 500);
    return date;
  }

  function nowIso(value) {
    return nowDate(value).toISOString();
  }

  function tzOffset(override) {
    if (override !== undefined && override !== null) return clampTzOffsetMinutes(override);
    const value = typeof tzOption === "function" ? tzOption() : tzOption;
    return clampTzOffsetMinutes(value);
  }

  function notify(change) {
    if (!onChange) return;
    try { onChange(change); } catch {}
  }

  function bytes(count) {
    const value = randomBytes(count);
    if (!Buffer.isBuffer(value) || value.length < count) {
      throw new KeysStoreError("access_random_unavailable", "Random source returned too few bytes.", 500);
    }
    return value;
  }

  function newId(prefix) {
    return `${prefix}${base32(bytes(13)).slice(0, 20)}`;
  }

  function newSecret() {
    return `${SECRET_PREFIX}${bytes(32).toString("base64url")}`;
  }

  // ---- audit -------------------------------------------------------------

  function insertAudit({ actor, actorIp = null, action, targetType, targetId = null, details = {} }, at = nowIso()) {
    const row = {
      at,
      actor: actorText(actor),
      actorIp: optionalIp(actorIp),
      action: patternText(action, "action", AUDIT_ACTION_RE),
      targetType: patternText(targetType, "targetType", AUDIT_TARGET_TYPE_RE),
      targetId: targetId === null || targetId === undefined || targetId === "" ? null : plainText(targetId, "targetId", 1, 200),
      details: JSON.stringify(safeAuditDetails(details ?? {})),
    };
    const result = prepare(`
      INSERT INTO access_audit (at, actor, actor_ip, action, target_type, target_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.at, row.actor, row.actorIp, row.action, row.targetType, row.targetId, row.details);
    return Number(result.lastInsertRowid);
  }

  function appendAudit(input = {}) {
    const id = transaction(() => insertAudit(input));
    return auditFromRow(prepare("SELECT * FROM access_audit WHERE id=?").get(id));
  }

  function listAudit(query = {}) {
    const limit = clampLimit(query.limit, 100);
    const params = [];
    const where = [];
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== "") {
      const cursor = Number(query.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 1) throw invalid([{ field: "cursor", code: "invalid", message: "The cursor is invalid." }]);
      where.push("id < ?");
      params.push(cursor);
    }
    if (query.action) {
      where.push("action = ?");
      params.push(String(query.action));
    }
    if (query.targetId) {
      where.push("target_id = ?");
      params.push(String(query.targetId));
    }
    const sql = `SELECT * FROM access_audit${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    const rows = prepare(sql).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(auditFromRow);
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null };
  }

  // ---- keys --------------------------------------------------------------

  function getKeyRow(keyId) {
    return prepare("SELECT * FROM api_keys WHERE key_id=?").get(keyId) || null;
  }

  function requireKeyRow(keyIdInput) {
    const keyId = keyIdText(keyIdInput);
    const row = getKeyRow(keyId);
    if (!row) throw new KeysStoreError("key_not_found", "Key not found.", 404);
    return row;
  }

  function getKey(keyIdInput) {
    const keyId = String(keyIdInput ?? "");
    if (!KEY_ID_RE.test(keyId)) return null;
    const row = getKeyRow(keyId);
    return row ? keyFromRow(row, nowIso()) : null;
  }

  // Current hash, or the previous hash while its rotation overlap lasts.
  function findByHash(keyHashInput, at) {
    const keyHash = String(keyHashInput ?? "").trim().toLowerCase();
    if (!KEY_HASH_RE.test(keyHash)) return null;
    const atIso = nowIso(at);
    const row = prepare(`
      SELECT * FROM api_keys
      WHERE key_hash = ? OR (prev_key_hash = ? AND prev_key_expires_at > ?)
      LIMIT 1
    `).get(keyHash, keyHash, atIso);
    if (!row) return null;
    return { key: keyFromRow(row, atIso), matched: row.key_hash === keyHash ? "current" : "previous" };
  }

  function findBySecret(secret, at) {
    if (typeof secret !== "string") return null;
    const value = secret.trim();
    if (!value || value.length > 1024) return null;
    return findByHash(hashSecret(value), at);
  }

  function listKeys(query = {}) {
    const at = nowIso();
    const limit = clampLimit(query.limit, 50);
    const where = [];
    const params = [];
    if (query.status) {
      const status = String(query.status);
      if (status === "expired") {
        where.push("status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?");
        params.push(at);
      } else if (policy.KEY_STATUSES.includes(status)) {
        where.push("status = ?");
        params.push(status);
      } else {
        throw invalid([{ field: "status", code: "invalid", message: "Unknown status filter." }]);
      }
    }
    if (query.class) {
      if (!policy.KEY_CLASSES.includes(String(query.class))) {
        throw invalid([{ field: "class", code: "invalid", message: "Unknown class filter." }]);
      }
      where.push("class = ?");
      params.push(String(query.class));
    }
    if (query.customerId) {
      where.push("customer_id = ?");
      params.push(String(query.customerId).toLowerCase());
    }
    if (query.q) {
      const like = `%${String(query.q).trim().toLowerCase().slice(0, 120).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      where.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(COALESCE(holder, '')) LIKE ? ESCAPE '\\' OR lower(key_id) LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (query.expiringWithinDays !== undefined && query.expiringWithinDays !== null && query.expiringWithinDays !== "") {
      const days = Number(query.expiringWithinDays);
      if (!Number.isFinite(days) || days < 0 || days > 3650) {
        throw invalid([{ field: "expiringWithinDays", code: "invalid", message: "expiringWithinDays must be between 0 and 3650." }]);
      }
      where.push("expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?");
      params.push(at, new Date(Date.parse(at) + days * 86_400_000).toISOString());
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      where.push("(created_at < ? OR (created_at = ? AND key_id < ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.keyId);
    }
    const sql = `SELECT * FROM api_keys${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, key_id DESC LIMIT ?`;
    const rows = prepare(sql).all(...params, limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => keyFromRow(row, at)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.key_id) : null,
    };
  }

  function countKeys() {
    const at = nowIso();
    const counts = { total: 0, active: 0, disabled: 0, revoked: 0, expired: 0, byClass: {} };
    for (const keyClass of policy.KEY_CLASSES) counts.byClass[keyClass] = 0;
    for (const row of prepare("SELECT status, class, expires_at FROM api_keys").all()) {
      counts.total += 1;
      counts[row.status] += 1;
      counts.byClass[row.class] += 1;
      if (row.status === "active" && row.expires_at && row.expires_at <= at) counts.expired += 1;
    }
    return counts;
  }

  // Union of allowed origins across usable keys: the PUBLIC preflight cache
  // (§11) is built from it.
  function activeOrigins(at) {
    const atIso = nowIso(at);
    const origins = new Set();
    const rows = prepare(`
      SELECT allowed_origins FROM api_keys
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?) AND allowed_origins <> '[]'
    `).all(atIso);
    for (const row of rows) for (const origin of parseJsonArray(row.allowed_origins)) origins.add(origin);
    return Array.from(origins).sort();
  }

  function insertKeyRow(record, { keyHash, preview, prevHash = null, prevExpiresAt = null, createdAt, createdBy, updatedAt, lastUsedAt = null }) {
    const columns = keyColumns(record);
    prepare(`
      INSERT INTO api_keys (
        key_id, name, key_hash, key_preview, prev_key_hash, prev_key_expires_at, status, class, customer_id, holder,
        scopes, models, fleet_allow, listeners,
        rpm, tpm, max_concurrent, max_queued, queue_timeout_s, request_timeout_s,
        daily_tokens, monthly_tokens, daily_requests, max_output_tokens,
        allowed_origins, allowed_ips, labels, expires_at, notes,
        billing_scope, billing_client_id, tts_owner, legacy,
        created_at, created_by, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, columns.name, keyHash, preview, prevHash, prevExpiresAt, columns.status, columns.class, columns.customer_id, columns.holder,
      columns.scopes, columns.models, columns.fleet_allow, columns.listeners,
      columns.rpm, columns.tpm, columns.max_concurrent, columns.max_queued, columns.queue_timeout_s, columns.request_timeout_s,
      columns.daily_tokens, columns.monthly_tokens, columns.daily_requests, columns.max_output_tokens,
      columns.allowed_origins, columns.allowed_ips, columns.labels, columns.expires_at, columns.notes,
      record.billing.scope, record.billing.clientId, record.ttsOwner, record.legacy ? JSON.stringify(record.legacy) : null,
      createdAt, createdBy, updatedAt, lastUsedAt,
    );
  }

  function createKey(input = {}, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const ip = optionalIp(context.ip);
    const normalized = normalizeKeyInput(input, { mode: "create", at });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const keyId = normalized.id || newId("k_");
      const secret = newSecret();
      const keyHash = hashSecret(secret);
      const record = {
        ...normalized,
        id: keyId,
        billing: normalized.billing || { scope: "platform", clientId: keyId },
        ttsOwner: normalized.ttsOwner || `platform:${keyId}`,
      };
      try {
        transaction(() => {
          if (findHashOwner(keyHash)) throw retryableCollision();
          insertKeyRow(record, { keyHash, preview: previewSecret(secret), createdAt: at, createdBy: actor, updatedAt: at });
          insertAudit({ actor, actorIp: ip, action: "key.create", targetType: "key", targetId: keyId, details: { name: record.name, class: record.class } }, at);
        });
      } catch (error) {
        const conflict = constraintColumn(error);
        if (error?.retryable || conflict === "key_hash" || conflict === "prev_key_hash" || (conflict === "key_id" && !normalized.id)) continue;
        if (conflict === "key_id") throw new KeysStoreError("key_conflict", "A key with this id already exists.", 409);
        if (conflict === "billing") throw new KeysStoreError("key_conflict", "Another key already uses this billing principal.", 409);
        throw error;
      }
      notify({ type: "key", action: "create", id: keyId });
      return { key: keyFromRow(getKeyRow(keyId), at), secret };
    }
    throw new KeysStoreError("key_conflict", "Could not allocate a unique key.", 409);
  }

  function updateKey(keyIdInput, patch = {}, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const ip = optionalIp(context.ip);
    const row = requireKeyRow(keyIdInput);
    if (row.status === "revoked") throw new KeysStoreError("key_revoked", "A revoked key cannot be changed.", 409);
    const current = keyFromRow(row, at);
    const next = normalizeKeyInput(patch, { mode: "update", current, at });
    const changed = changedKeyFields(current, next);
    if (!changed.length) return current;
    const columns = keyColumns(next);
    transaction(() => {
      prepare(`
        UPDATE api_keys SET
          name=?, status=?, class=?, customer_id=?, holder=?, scopes=?, models=?, fleet_allow=?, listeners=?,
          rpm=?, tpm=?, max_concurrent=?, max_queued=?, queue_timeout_s=?, request_timeout_s=?,
          daily_tokens=?, monthly_tokens=?, daily_requests=?, max_output_tokens=?,
          allowed_origins=?, allowed_ips=?, labels=?, expires_at=?, notes=?, updated_at=?
        WHERE key_id=? AND status <> 'revoked'
      `).run(
        columns.name, columns.status, columns.class, columns.customer_id, columns.holder, columns.scopes, columns.models,
        columns.fleet_allow, columns.listeners,
        columns.rpm, columns.tpm, columns.max_concurrent, columns.max_queued, columns.queue_timeout_s, columns.request_timeout_s,
        columns.daily_tokens, columns.monthly_tokens, columns.daily_requests, columns.max_output_tokens,
        columns.allowed_origins, columns.allowed_ips, columns.labels, columns.expires_at, columns.notes, at,
        row.key_id,
      );
      insertAudit({ actor, actorIp: ip, action: "key.update", targetType: "key", targetId: row.key_id, details: { fields: changed } }, at);
    });
    notify({ type: "key", action: "update", id: row.key_id });
    return keyFromRow(getKeyRow(row.key_id), at);
  }

  // overlapSeconds > 0 keeps the old secret valid until now + overlap (≤ 7 d);
  // 0 retires it at once. A second rotation inside an overlap replaces the
  // previous secret with the current one.
  function rotateKey(keyIdInput, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const ip = optionalIp(context.ip);
    const overlapSeconds = context.overlapSeconds ?? 0;
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > MAX_OVERLAP_SECONDS) {
      throw invalid([{ field: "overlapSeconds", code: "out_of_range", message: `overlapSeconds must be an integer between 0 and ${MAX_OVERLAP_SECONDS}.` }]);
    }
    const row = requireKeyRow(keyIdInput);
    if (row.status === "revoked") throw new KeysStoreError("key_revoked", "A revoked key cannot be rotated.", 409);
    const prevExpiresAt = overlapSeconds > 0 ? new Date(Date.parse(at) + overlapSeconds * 1000).toISOString() : null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const secret = newSecret();
      const keyHash = hashSecret(secret);
      try {
        transaction(() => {
          if (findHashOwner(keyHash)) throw retryableCollision();
          prepare(`
            UPDATE api_keys SET key_hash=?, key_preview=?, prev_key_hash=?, prev_key_expires_at=?, updated_at=?
            WHERE key_id=? AND status <> 'revoked'
          `).run(keyHash, previewSecret(secret), overlapSeconds > 0 ? row.key_hash : null, prevExpiresAt, at, row.key_id);
          insertAudit({
            actor,
            actorIp: ip,
            action: context.self === true ? "key.rotate.self" : "key.rotate",
            targetType: "key",
            targetId: row.key_id,
            details: { overlapSeconds },
          }, at);
        });
      } catch (error) {
        const conflict = constraintColumn(error);
        if (error?.retryable || conflict === "key_hash" || conflict === "prev_key_hash") continue;
        throw error;
      }
      notify({ type: "key", action: "rotate", id: row.key_id });
      return { key: keyFromRow(getKeyRow(row.key_id), at), secret };
    }
    throw new KeysStoreError("key_conflict", "Could not allocate a unique key.", 409);
  }

  // Terminal. The hash stays, so a revoked secret is recognised and answered
  // with key_disabled instead of looking like a guess; the overlap ends.
  function revokeKey(keyIdInput, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const ip = optionalIp(context.ip);
    const reason = context.reason === undefined || context.reason === null || context.reason === ""
      ? null
      : plainText(context.reason, "reason", 1, 200);
    const row = requireKeyRow(keyIdInput);
    if (row.status === "revoked") return keyFromRow(row, at);
    transaction(() => {
      prepare(`
        UPDATE api_keys SET status='revoked', revoked_at=?, updated_at=?, prev_key_hash=NULL, prev_key_expires_at=NULL
        WHERE key_id=?
      `).run(at, at, row.key_id);
      insertAudit({ actor, actorIp: ip, action: "key.revoke", targetType: "key", targetId: row.key_id, details: reason ? { reason } : {} }, at);
    });
    notify({ type: "key", action: "revoke", id: row.key_id });
    return keyFromRow(getKeyRow(row.key_id), at);
  }

  // Imports keys whose hash already exists elsewhere (legacy manager clients,
  // §6.7) in one transaction. Idempotent: a record whose id, hash or billing
  // principal is already present is skipped, never overwritten.
  function importKeys(records, context = {}) {
    if (!Array.isArray(records)) throw invalid([{ field: "records", code: "invalid", message: "records must be an array." }]);
    const at = nowIso();
    const actor = actorText(context.actor ?? "migration");
    const ip = optionalIp(context.ip);
    const prepared = records.map((input, index) => normalizeImportRecord(input, index, at));
    const inserted = [];
    const skipped = [];
    transaction(() => {
      for (const item of prepared) {
        const { record } = item;
        let reason = "";
        if (getKeyRow(record.id)) reason = "key_id_exists";
        else if (findHashOwner(item.keyHash)) reason = "key_hash_exists";
        else if (prepare("SELECT 1 AS hit FROM api_keys WHERE billing_scope=? AND billing_client_id=?").get(record.billing.scope, record.billing.clientId)) {
          reason = "billing_principal_exists";
        }
        if (reason) {
          skipped.push({ id: record.id, reason });
          continue;
        }
        insertKeyRow(record, {
          keyHash: item.keyHash,
          preview: item.preview,
          createdAt: item.createdAt,
          createdBy: actor,
          updatedAt: at,
          lastUsedAt: item.lastUsedAt,
        });
        insertAudit({
          actor,
          actorIp: ip,
          action: "key.import",
          targetType: "key",
          targetId: record.id,
          details: { source: record.legacy?.source || "import" },
        }, at);
        inserted.push(record.id);
      }
    });
    if (inserted.length) notify({ type: "key", action: "import", ids: inserted.slice() });
    return { inserted, skipped };
  }

  function normalizeImportRecord(input, index, at) {
    if (!isPlainObject(input)) {
      throw invalid([{ field: `records[${index}]`, code: "invalid", message: "Each record must be an object." }]);
    }
    const { keyHash, preview, createdAt, lastUsedAt, ...fields } = input;
    const errors = [];
    const hash = String(keyHash ?? "").trim().toLowerCase();
    if (!KEY_HASH_RE.test(hash)) errors.push({ field: `records[${index}].keyHash`, code: "invalid", message: "keyHash must be 64 hex characters." });
    if (!fields.id) errors.push({ field: `records[${index}].id`, code: "required", message: "Imported keys need an id." });
    if (errors.length) throw invalid(errors);
    let record;
    try {
      record = normalizeKeyInput(fields, { mode: "create", at });
    } catch (error) {
      if (error instanceof KeysStoreError && error.errors.length) {
        error.errors = error.errors.map((item) => ({ ...item, field: `records[${index}].${item.field}` }));
      }
      throw error;
    }
    record.billing = record.billing || { scope: "platform", clientId: record.id };
    record.ttsOwner = record.ttsOwner || `platform:${record.id}`;
    const previewText = preview === undefined || preview === null || preview === "" ? "…" : plainText(String(preview), "preview", 1, 64);
    if (HEX64_RUN_RE.test(previewText)) throw invalid([{ field: `records[${index}].preview`, code: "invalid", message: "preview must not contain a hash." }]);
    return {
      record,
      keyHash: hash,
      preview: previewText,
      createdAt: optionalIsoDate(createdAt) || at,
      lastUsedAt: optionalIsoDate(lastUsedAt),
    };
  }

  function findHashOwner(keyHash) {
    return prepare("SELECT key_id FROM api_keys WHERE key_hash = ? OR prev_key_hash = ? LIMIT 1").get(keyHash, keyHash) || null;
  }

  // At most one write per key per 5 s; values that arrive inside the window
  // are kept and written by the next touch after it, or by flushTouches/close.
  function touchKey(keyIdInput, input = {}) {
    const keyId = keyIdText(keyIdInput);
    const atDate = nowDate(input.at);
    const entry = {
      at: atDate.toISOString(),
      ip: optionalIp(input.ip),
      country: COUNTRY_RE.test(String(input.country || "")) ? String(input.country) : null,
    };
    const state = touchState.get(keyId);
    if (state && atDate.getTime() - state.writtenAtMs < TOUCH_COALESCE_MS) {
      state.pending = entry;
      return false;
    }
    writeTouch(keyId, entry);
    touchState.set(keyId, { writtenAtMs: atDate.getTime(), pending: null });
    if (touchState.size > 50_000) {
      const oldest = touchState.keys().next().value;
      const stale = touchState.get(oldest);
      if (stale?.pending) writeTouch(oldest, stale.pending);
      touchState.delete(oldest);
    }
    return true;
  }

  function writeTouch(keyId, entry) {
    prepare(`
      UPDATE api_keys SET last_used_at=?, last_used_ip=COALESCE(?, last_used_ip), last_used_country=COALESCE(?, last_used_country)
      WHERE key_id=? AND (last_used_at IS NULL OR last_used_at < ?)
    `).run(entry.at, entry.ip, entry.country, keyId, entry.at);
  }

  function flushTouches() {
    let written = 0;
    for (const [keyId, state] of touchState) {
      if (!state.pending) continue;
      writeTouch(keyId, state.pending);
      state.writtenAtMs = Date.parse(state.pending.at);
      state.pending = null;
      written += 1;
    }
    return written;
  }

  // ---- usage counters ----------------------------------------------------

  function addUsage(keyIdInput, input = {}) {
    const keyId = keyIdText(keyIdInput);
    const atDate = nowDate(input.at);
    const amounts = {
      requests: counterAmount(input.requests, "requests"),
      inputTokens: counterAmount(input.inputTokens, "inputTokens"),
      cachedInputTokens: counterAmount(input.cachedInputTokens, "cachedInputTokens"),
      outputTokens: counterAmount(input.outputTokens, "outputTokens"),
      errors: counterAmount(input.errors, "errors"),
    };
    const periods = quotaPeriods(atDate, tzOffset(input.tzOffsetMinutes));
    const updatedAt = nowIso();
    const statement = prepare(`
      INSERT INTO key_usage_counters (key_id, period, requests, input_tokens, cached_input_tokens, output_tokens, errors, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key_id, period) DO UPDATE SET
        requests = requests + excluded.requests,
        input_tokens = input_tokens + excluded.input_tokens,
        cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        errors = errors + excluded.errors,
        updated_at = excluded.updated_at
    `);
    transaction(() => {
      for (const period of [periods.day.key, periods.month.key]) {
        statement.run(keyId, period, amounts.requests, amounts.inputTokens, amounts.cachedInputTokens, amounts.outputTokens, amounts.errors, updatedAt);
      }
    });
    return getUsage(keyId, { at: atDate, tzOffsetMinutes: input.tzOffsetMinutes });
  }

  function getUsage(keyIdInput, input = {}) {
    const keyId = keyIdText(keyIdInput);
    const periods = quotaPeriods(nowDate(input.at), tzOffset(input.tzOffsetMinutes));
    const statement = prepare("SELECT * FROM key_usage_counters WHERE key_id=? AND period=?");
    return {
      day: countersFromRow(statement.get(keyId, periods.day.key), periods.day.key),
      month: countersFromRow(statement.get(keyId, periods.month.key), periods.month.key),
      dayResetsAt: periods.day.end,
      monthResetsAt: periods.month.end,
      tzOffsetMinutes: periods.tzOffsetMinutes,
    };
  }

  // Day rows in [from, to] (quota-tz dates, YYYY-MM-DD), oldest first: the
  // counters fallback of /v1/me/usage.
  function listDailyUsage(keyIdInput, input = {}) {
    const keyId = keyIdText(keyIdInput);
    const from = DAY_RE.test(String(input.from || "")) ? String(input.from) : "0000-00-00";
    const to = DAY_RE.test(String(input.to || "")) ? String(input.to) : "9999-99-99";
    return prepare(`
      SELECT * FROM key_usage_counters WHERE key_id=? AND period >= ? AND period <= ? ORDER BY period ASC
    `).all(keyId, `d:${from}`, `d:${to}`).map((row) => ({ date: row.period.slice(2), ...countersFromRow(row, row.period) }));
  }

  // ---- bans --------------------------------------------------------------

  function getBanRow(subject) {
    return prepare("SELECT * FROM security_bans WHERE subject=?").get(subject) || null;
  }

  // Admin ban or unban of an IP, CIDR or key. Loopback is never banned.
  function upsertBan(input = {}, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor ?? input.createdBy);
    const ip = optionalIp(context.ip);
    const kind = enumValue(input.kind, BAN_KINDS, "kind");
    const subject = banSubject(input.subject, kind);
    const source = enumValue(input.source ?? "admin", BAN_SOURCES, "source");
    const reason = plainText(input.reason ?? "admin", "reason", 1, 200);
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === ""
      ? null
      : requiredIsoDate(input.expiresAt, "expiresAt");
    const strikes = boundedInteger(input.strikes ?? 1, 1, 1000, 1);
    transaction(() => {
      prepare(`
        INSERT INTO security_bans (subject, kind, reason, source, strikes, created_at, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subject) DO UPDATE SET kind=excluded.kind, reason=excluded.reason, source=excluded.source,
          strikes=excluded.strikes, created_at=excluded.created_at, expires_at=excluded.expires_at, created_by=excluded.created_by
      `).run(subject, kind, reason, source, strikes, at, expiresAt, actor);
      if (source === "admin") {
        insertAudit({ actor, actorIp: ip, action: "ban.upsert", targetType: "ban", targetId: subject, details: { kind, reason, expiresAt } }, at);
      }
    });
    notify({ type: "ban", action: "upsert", id: subject });
    return banFromRow(getBanRow(subject), at);
  }

  // Automatic ban after an auth-failure burst (§9.3). The duration is
  // banSeconds × 4^(strikes−1), capped at maxBanSeconds. Strikes reset to 1
  // when the previous ban ended more than decaySeconds (24 h) ago. An active
  // admin ban is never shortened, and loopback is never banned (null).
  function escalateBan(subjectInput, input = {}) {
    const atDate = nowDate(input.at);
    const at = atDate.toISOString();
    const kind = enumValue(input.kind ?? "ip", BAN_KINDS, "kind");
    let subject;
    try {
      subject = banSubject(subjectInput, kind);
    } catch (error) {
      if (error?.code === "ban_subject_protected") return null;
      throw error;
    }
    const banSeconds = boundedInteger(input.banSeconds ?? DEFAULT_BAN_SECONDS, 1, 31 * 86_400, DEFAULT_BAN_SECONDS);
    const maxBanSeconds = Math.max(banSeconds, boundedInteger(input.maxBanSeconds ?? DEFAULT_MAX_BAN_SECONDS, 1, 365 * 86_400, DEFAULT_MAX_BAN_SECONDS));
    const decaySeconds = boundedInteger(input.decaySeconds ?? DEFAULT_STRIKE_DECAY_SECONDS, 1, 365 * 86_400, DEFAULT_STRIKE_DECAY_SECONDS);
    const reason = plainText(input.reason ?? "auth_failures", "reason", 1, 200);
    const result = transaction(() => {
      const current = getBanRow(subject);
      if (current && current.source === "admin" && banActive(current, at)) return { row: current, changed: false };
      let strikes = 1;
      if (current && current.source === "auto") {
        const endedMs = Date.parse(current.expires_at || current.created_at);
        if (Number.isFinite(endedMs) && atDate.getTime() - endedMs < decaySeconds * 1000) {
          strikes = Math.min(1000, Number(current.strikes || 1) + 1);
        }
      }
      const seconds = banDurationSeconds(strikes, banSeconds, maxBanSeconds);
      const expiresAt = new Date(atDate.getTime() + seconds * 1000).toISOString();
      prepare(`
        INSERT INTO security_bans (subject, kind, reason, source, strikes, created_at, expires_at, created_by)
        VALUES (?, ?, ?, 'auto', ?, ?, ?, 'auto')
        ON CONFLICT(subject) DO UPDATE SET kind=excluded.kind, reason=excluded.reason, source='auto',
          strikes=excluded.strikes, created_at=excluded.created_at, expires_at=excluded.expires_at, created_by='auto'
      `).run(subject, kind, reason, strikes, at, expiresAt);
      return { row: getBanRow(subject), changed: true };
    });
    if (result.changed) notify({ type: "ban", action: "escalate", id: subject });
    return banFromRow(result.row, at);
  }

  function removeBan(subjectInput, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const ip = optionalIp(context.ip);
    const subject = normalizeBanSubjectLoose(subjectInput);
    if (!subject) return false;
    const removed = transaction(() => {
      const row = getBanRow(subject);
      if (!row) return false;
      prepare("DELETE FROM security_bans WHERE subject=?").run(subject);
      insertAudit({ actor, actorIp: ip, action: "ban.remove", targetType: "ban", targetId: subject, details: { kind: row.kind } }, at);
      return true;
    });
    if (removed) notify({ type: "ban", action: "remove", id: subject });
    return removed;
  }

  function listBans(query = {}) {
    const at = nowIso(query.now);
    const where = [];
    const params = [];
    if (!query.includeExpired) {
      where.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(at);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(enumValue(query.kind, BAN_KINDS, "kind"));
    }
    if (query.source) {
      where.push("source = ?");
      params.push(enumValue(query.source, BAN_SOURCES, "source"));
    }
    const limit = clampLimit(query.limit, 500, 5000);
    const sql = `SELECT * FROM security_bans${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, subject ASC LIMIT ?`;
    return prepare(sql).all(...params, limit).map((row) => banFromRow(row, at));
  }

  // The active ban covering a subject: an exact IP or key ban first, then any
  // CIDR ban that contains the IP.
  function activeBanFor(subjectInput, at) {
    const atIso = nowIso(at);
    const address = policy.parseIp(subjectInput);
    const subject = address ? address.text : String(subjectInput ?? "").trim();
    if (!subject) return null;
    const exact = getBanRow(subject);
    if (exact && banActive(exact, atIso)) return banFromRow(exact, atIso);
    if (!address) return null;
    const rows = prepare("SELECT * FROM security_bans WHERE kind='cidr' AND (expires_at IS NULL OR expires_at > ?)").all(atIso);
    const hit = rows.find((row) => policy.ipMatchesRule(address, row.subject));
    return hit ? banFromRow(hit, atIso) : null;
  }

  // Drops automatic bans whose strikes have decayed; admin bans stay until
  // removed.
  function pruneBans(input = {}) {
    const atDate = nowDate(input.at);
    const decaySeconds = boundedInteger(input.decaySeconds ?? DEFAULT_STRIKE_DECAY_SECONDS, 1, 365 * 86_400, DEFAULT_STRIKE_DECAY_SECONDS);
    const before = new Date(atDate.getTime() - decaySeconds * 1000).toISOString();
    return Number(prepare("DELETE FROM security_bans WHERE source='auto' AND expires_at IS NOT NULL AND expires_at <= ?").run(before).changes);
  }

  function banSubject(value, kind) {
    if (kind === "key") {
      const keyId = String(value ?? "").trim();
      if (!KEY_ID_RE.test(keyId)) throw invalid([{ field: "subject", code: "invalid", message: "A key ban needs a key id." }], "The ban subject is invalid.");
      return keyId;
    }
    if (kind === "ip") {
      const address = policy.parseIp(value);
      if (!address || String(value ?? "").includes("/")) {
        throw invalid([{ field: "subject", code: "invalid", message: "An IP ban needs one address." }], "The ban subject is invalid.");
      }
      if (policy.isLoopbackIp(address)) throw protectedSubject();
      return address.text;
    }
    const rule = policy.parseIpRule(value);
    if (!rule) throw invalid([{ field: "subject", code: "invalid", message: "A CIDR ban needs an address/prefix." }], "The ban subject is invalid.");
    if (cidrCoversLoopback(rule)) throw protectedSubject();
    return rule.text;
  }

  // ---- announcements, model metadata, status samples ---------------------

  function listAnnouncements(query = {}) {
    const where = [];
    const params = [];
    if (query.published !== undefined && query.published !== null) {
      where.push("published = ?");
      params.push(query.published ? 1 : 0);
    }
    if (query.activeAt !== undefined && query.activeAt !== null) {
      const at = nowIso(query.activeAt);
      where.push("starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)");
      params.push(at, at);
    }
    if (query.audience) {
      where.push("audience = ?");
      params.push(enumValue(query.audience, ANNOUNCEMENT_AUDIENCES, "audience"));
    }
    const sql = `SELECT * FROM announcements${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY starts_at DESC, id ASC LIMIT ?`;
    return prepare(sql).all(...params, clampLimit(query.limit, 100, 500)).map(announcementFromRow);
  }

  function getAnnouncement(idInput) {
    const row = prepare("SELECT * FROM announcements WHERE id=?").get(String(idInput ?? "")) || null;
    return row ? announcementFromRow(row) : null;
  }

  function createAnnouncement(input = {}, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const fields = normalizeAnnouncement(input, null, at);
    const id = newId("an_");
    transaction(() => {
      prepare(`
        INSERT INTO announcements (id, severity, title_zh, title_en, body_zh, body_en, starts_at, ends_at, audience, published, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, fields.severity, fields.titleZh, fields.titleEn, fields.bodyZh, fields.bodyEn, fields.startsAt, fields.endsAt,
        fields.audience, fields.published, at, at, actor);
      insertAudit({ actor, actorIp: optionalIp(context.ip), action: "announcement.create", targetType: "announcement", targetId: id, details: { severity: fields.severity } }, at);
    });
    notify({ type: "announcement", action: "create", id });
    return getAnnouncement(id);
  }

  function updateAnnouncement(idInput, patch = {}, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const row = prepare("SELECT * FROM announcements WHERE id=?").get(String(idInput ?? ""));
    if (!row) throw new KeysStoreError("announcement_not_found", "Announcement not found.", 404);
    const fields = normalizeAnnouncement(patch, row, at);
    transaction(() => {
      prepare(`
        UPDATE announcements SET severity=?, title_zh=?, title_en=?, body_zh=?, body_en=?, starts_at=?, ends_at=?, audience=?, published=?, updated_at=?
        WHERE id=?
      `).run(fields.severity, fields.titleZh, fields.titleEn, fields.bodyZh, fields.bodyEn, fields.startsAt, fields.endsAt,
        fields.audience, fields.published, at, row.id);
      insertAudit({ actor, actorIp: optionalIp(context.ip), action: "announcement.update", targetType: "announcement", targetId: row.id, details: { fields: Object.keys(patch).slice(0, 20) } }, at);
    });
    notify({ type: "announcement", action: "update", id: row.id });
    return getAnnouncement(row.id);
  }

  function removeAnnouncement(idInput, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const id = String(idInput ?? "");
    const removed = transaction(() => {
      const result = prepare("DELETE FROM announcements WHERE id=?").run(id);
      if (!Number(result.changes)) return false;
      insertAudit({ actor, actorIp: optionalIp(context.ip), action: "announcement.remove", targetType: "announcement", targetId: id, details: {} }, at);
      return true;
    });
    if (removed) notify({ type: "announcement", action: "remove", id });
    return removed;
  }

  function listModelMeta() {
    return prepare("SELECT * FROM public_model_meta ORDER BY sort ASC, model_id ASC").all().map(modelMetaFromRow);
  }

  function getModelMeta(modelIdInput) {
    const row = prepare("SELECT * FROM public_model_meta WHERE model_id=?").get(String(modelIdInput ?? "")) || null;
    return row ? modelMetaFromRow(row) : null;
  }

  function upsertModelMeta(modelIdInput, patch = {}, context = {}) {
    const at = nowIso();
    const actor = actorText(context.actor);
    const modelId = plainText(modelIdInput, "modelId", 1, 256);
    const current = getModelMeta(modelId);
    const next = normalizeModelMeta(patch, current);
    transaction(() => {
      prepare(`
        INSERT INTO public_model_meta (model_id, display_name_zh, display_name_en, description_zh, description_en, aliases, hidden, recommended, sort, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET display_name_zh=excluded.display_name_zh, display_name_en=excluded.display_name_en,
          description_zh=excluded.description_zh, description_en=excluded.description_en, aliases=excluded.aliases,
          hidden=excluded.hidden, recommended=excluded.recommended, sort=excluded.sort, updated_at=excluded.updated_at
      `).run(modelId, next.displayName.zh, next.displayName.en, next.description.zh, next.description.en, JSON.stringify(next.aliases),
        next.hidden ? 1 : 0, next.recommended ? 1 : 0, next.sort, at);
      insertAudit({ actor, actorIp: optionalIp(context.ip), action: "model_meta.update", targetType: "model", targetId: modelId, details: { fields: Object.keys(patch).slice(0, 20) } }, at);
    });
    notify({ type: "model_meta", action: "upsert", id: modelId });
    return getModelMeta(modelId);
  }

  function putSample(minuteInput, input = {}) {
    const minute = minuteKey(minuteInput);
    const overall = plainText(input.overall, "overall", 1, 32);
    const models = JSON.stringify(input.models ?? {});
    if (models.length > 256 * 1024) throw invalid([{ field: "models", code: "too_large", message: "The sample is too large." }]);
    prepare("INSERT INTO status_samples (minute, overall, models) VALUES (?, ?, ?) ON CONFLICT(minute) DO UPDATE SET overall=excluded.overall, models=excluded.models")
      .run(minute, overall, models);
    return { minute, overall, models: JSON.parse(models) };
  }

  function listSamples(fromMinute) {
    const from = fromMinute === undefined || fromMinute === null || fromMinute === "" ? "" : minuteKey(fromMinute);
    return prepare("SELECT * FROM status_samples WHERE minute >= ? ORDER BY minute ASC").all(from)
      .map((row) => ({ minute: row.minute, overall: row.overall, models: parseJson(row.models, {}) }));
  }

  function pruneSamples(beforeMinute) {
    return Number(prepare("DELETE FROM status_samples WHERE minute < ?").run(minuteKey(beforeMinute)).changes);
  }

  // ---- admin sessions (05 §5.3; the rules live in admin-session.js) -------
  //
  // Rows only: ids, hashes and times. Secrets never reach this module; the
  // caller hashes them first and audits the events, since it knows the actor.

  function sessionFromRow(row) {
    if (!row) return null;
    return {
      id: row.session_id,
      secretHash: row.secret_hash,
      role: row.role,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      createdIp: row.created_ip || null,
      userAgent: row.user_agent || null,
      revokedAt: row.revoked_at || null,
    };
  }

  // Inserts a session and marks access_meta.autoPairConsumed: any pairing
  // closes the first-run window. With `autoPair` the insert happens only
  // while that window is unconsumed and nothing was ever paired; false
  // means it was not.
  function createAdminSession(input = {}, { autoPair = false } = {}) {
    return transaction(() => {
      if (autoPair) {
        const consumed = prepare("SELECT value FROM access_meta WHERE key='autoPairConsumed'").get()?.value === "1";
        if (consumed || Number(prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n) > 0) return false;
      }
      prepare(`
        INSERT INTO admin_sessions (session_id, secret_hash, role, created_at, last_seen_at, expires_at, created_ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(input.id), String(input.secretHash), String(input.role || "owner"), String(input.createdAt),
        String(input.createdAt), String(input.expiresAt), optionalIp(input.createdIp), input.userAgent ? String(input.userAgent).slice(0, 300) : null,
      );
      prepare("INSERT INTO access_meta (key, value) VALUES ('autoPairConsumed', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      return true;
    });
  }

  function getAdminSession(sessionId) {
    return sessionFromRow(prepare("SELECT * FROM admin_sessions WHERE session_id=?").get(String(sessionId || "")));
  }

  function touchAdminSession(sessionId, { lastSeenAt, expiresAt }) {
    prepare("UPDATE admin_sessions SET last_seen_at=?, expires_at=? WHERE session_id=? AND revoked_at IS NULL")
      .run(String(lastSeenAt), String(expiresAt), String(sessionId || ""));
  }

  function listAdminSessions({ now: at } = {}) {
    return prepare("SELECT * FROM admin_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC, session_id LIMIT 500")
      .all(nowIso(at)).map(sessionFromRow);
  }

  function countAdminSessions() {
    return Number(prepare("SELECT COUNT(*) AS n FROM admin_sessions").get().n);
  }

  // Revokes the session and every elevation bound to it. False when it was
  // unknown or already revoked.
  function revokeAdminSession(sessionId, at) {
    const when = nowIso(at);
    const id = String(sessionId || "");
    return transaction(() => {
      const changes = Number(prepare("UPDATE admin_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL").run(when, id).changes);
      prepare("UPDATE admin_elevations SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL").run(when, id);
      return changes > 0;
    });
  }

  function insertPairCode({ codeHash, expiresAt, createdBy, lan = false }) {
    transaction(() => {
      prepare("DELETE FROM admin_pair_codes WHERE expires_at <= ?").run(nowIso());
      prepare("INSERT INTO admin_pair_codes (code_hash, expires_at, created_by, lan) VALUES (?, ?, ?, ?)")
        .run(String(codeHash), String(expiresAt), actorText(createdBy), lan ? 1 : 0);
    });
  }

  // Single use: the first caller marks the code used and gets its row; an
  // unknown, used or expired code gives null.
  function consumePairCode(codeHash, at) {
    const when = nowIso(at);
    return transaction(() => {
      const row = prepare("SELECT * FROM admin_pair_codes WHERE code_hash=?").get(String(codeHash || ""));
      if (!row || row.used_at || !(row.expires_at > when)) return null;
      prepare("UPDATE admin_pair_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL").run(when, row.code_hash);
      return { expiresAt: row.expires_at, createdBy: row.created_by, lan: Number(row.lan) === 1 };
    });
  }

  function tokenFromRow(row) {
    if (!row) return null;
    return {
      id: row.token_id,
      name: row.name,
      tokenHash: row.token_hash,
      role: row.role,
      createdAt: row.created_at,
      createdBy: row.created_by,
      lastUsedAt: row.last_used_at || null,
      revokedAt: row.revoked_at || null,
    };
  }

  function insertAdminToken({ id, name, tokenHash, role, createdAt, createdBy }) {
    prepare("INSERT INTO admin_tokens (token_id, name, token_hash, role, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(id), plainText(String(name ?? ""), "name", 1, 120), String(tokenHash), String(role), String(createdAt), actorText(createdBy));
  }

  function findAdminToken(tokenHash) {
    return tokenFromRow(prepare("SELECT * FROM admin_tokens WHERE token_hash=?").get(String(tokenHash || "")));
  }

  function touchAdminToken(tokenId, at) {
    prepare("UPDATE admin_tokens SET last_used_at=? WHERE token_id=?").run(nowIso(at), String(tokenId || ""));
  }

  function listAdminTokens() {
    return prepare("SELECT * FROM admin_tokens ORDER BY created_at DESC, token_id LIMIT 500").all().map(tokenFromRow);
  }

  function revokeAdminToken(tokenId, at) {
    return Number(prepare("UPDATE admin_tokens SET revoked_at=? WHERE token_id=? AND revoked_at IS NULL").run(nowIso(at), String(tokenId || "")).changes) > 0;
  }

  function insertElevation({ id, sessionId, scope, secretHash, createdAt, expiresAt }) {
    prepare("INSERT INTO admin_elevations (elevation_id, session_id, scope, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(String(id), String(sessionId), String(scope), String(secretHash), String(createdAt), String(expiresAt));
  }

  function getElevation(elevationId) {
    const row = prepare("SELECT * FROM admin_elevations WHERE elevation_id=?").get(String(elevationId || ""));
    if (!row) return null;
    return {
      id: row.elevation_id,
      sessionId: row.session_id,
      scope: row.scope,
      secretHash: row.secret_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at || null,
    };
  }

  function revokeElevation(elevationId, at) {
    return Number(prepare("UPDATE admin_elevations SET revoked_at=? WHERE elevation_id=? AND revoked_at IS NULL").run(nowIso(at), String(elevationId || "")).changes) > 0;
  }

  // ---- meta --------------------------------------------------------------

  function getMeta(keyInput) {
    const key = String(keyInput ?? "");
    if (!META_KEY_RE.test(key)) return null;
    const row = prepare("SELECT value FROM access_meta WHERE key=?").get(key);
    return row ? row.value : null;
  }

  function setMeta(keyInput, value) {
    const key = String(keyInput ?? "");
    if (!META_KEY_RE.test(key)) throw invalid([{ field: "key", code: "invalid", message: "Invalid meta key." }], "The meta key is invalid.");
    if (READ_ONLY_META.has(key)) throw new KeysStoreError("meta_read_only", "This meta value is managed by the store.", 400);
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    if (text.length > 1024 * 1024) throw invalid([{ field: "value", code: "too_large", message: "The meta value is too large." }]);
    prepare("INSERT INTO access_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, text);
  }

  function getPragmas() {
    return {
      journalMode: String(prepare("PRAGMA journal_mode").get()?.journal_mode || ""),
      foreignKeys: Number(prepare("PRAGMA foreign_keys").get()?.foreign_keys || 0),
      synchronous: Number(prepare("PRAGMA synchronous").get()?.synchronous || 0),
      busyTimeoutMs: Number(prepare("PRAGMA busy_timeout").get()?.timeout || 0),
    };
  }

  function close() {
    if (closed) return;
    try { flushTouches(); } catch {}
    statements.clear();
    db.close();
    closed = true;
  }

  const announcements = Object.freeze({
    list: listAnnouncements,
    get: getAnnouncement,
    create: createAnnouncement,
    update: updateAnnouncement,
    remove: removeAnnouncement,
  });
  const modelMeta = Object.freeze({ list: listModelMeta, get: getModelMeta, upsert: upsertModelMeta });
  const admin = Object.freeze({
    createSession: createAdminSession,
    getSession: getAdminSession,
    touchSession: touchAdminSession,
    listSessions: listAdminSessions,
    countSessions: countAdminSessions,
    revokeSession: revokeAdminSession,
    insertPairCode,
    consumePairCode,
    insertToken: insertAdminToken,
    findToken: findAdminToken,
    touchToken: touchAdminToken,
    listTokens: listAdminTokens,
    revokeToken: revokeAdminToken,
    insertElevation,
    getElevation,
    revokeElevation,
  });

  return {
    file,
    createKey,
    getKey,
    findBySecret,
    findByHash,
    listKeys,
    countKeys,
    activeOrigins,
    updateKey,
    rotateKey,
    revokeKey,
    importKeys,
    touchKey,
    flushTouches,
    addUsage,
    getUsage,
    listDailyUsage,
    upsertBan,
    escalateBan,
    removeBan,
    listBans,
    activeBanFor,
    pruneBans,
    appendAudit,
    listAudit,
    announcements,
    listAnnouncements,
    getAnnouncement,
    createAnnouncement,
    updateAnnouncement,
    removeAnnouncement,
    modelMeta,
    admin,
    listModelMeta,
    getModelMeta,
    upsertModelMeta,
    putSample,
    listSamples,
    pruneSamples,
    getMeta,
    setMeta,
    getPragmas,
    close,
  };
}

// ---- schema ----------------------------------------------------------------

function configureDatabase(db, busyTimeoutMs) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA synchronous = NORMAL;
  `);
}

function ensureSchema(db, at) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS access_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const current = db.prepare("SELECT value FROM access_meta WHERE key='schemaVersion'").get();
    if (current && !(Number(current.value) <= SCHEMA_VERSION)) {
      throw new KeysStoreError("access_store_unsupported_version", "The access store was written by a newer platform version.", 503);
    }
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT OR IGNORE INTO access_meta (key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
    db.prepare("INSERT OR IGNORE INTO access_meta (key, value) VALUES ('firstStartAt', ?)").run(at);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

// ---- key normalization -----------------------------------------------------

// Validates create input or an update patch into a KeyRecord-shaped object.
// mode "create" needs name, class, scopes and models; mode "update" merges
// the patch over `current`. Field errors use the 00 §4.2 shape and are
// thrown together as 400 invalid_field.
function normalizeKeyInput(input, options = {}) {
  const mode = options.mode === "update" ? "update" : "create";
  const current = options.current || null;
  const errors = [];
  if (!isPlainObject(input)) throw invalid([{ field: "", code: "invalid", message: "Key input must be an object." }]);
  const allowed = new Set(mode === "create" ? [...EDITABLE_KEY_FIELDS, ...CREATE_ONLY_KEY_FIELDS] : EDITABLE_KEY_FIELDS);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      errors.push({ field, code: CREATE_ONLY_KEY_FIELDS.includes(field) ? "read_only" : "unknown_field", message: `${field} cannot be set here.` });
    }
  }
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
  const base = mode === "update" && current ? current : {
    status: "active",
    customerId: null,
    holder: null,
    fleetAllow: [],
    listeners: ["public", "admin"],
    limits: Object.fromEntries(LIMIT_FIELDS.map((item) => [item.field, null])),
    allowedOrigins: [],
    allowedIps: [],
    labels: {},
    expiresAt: null,
    notes: null,
  };
  const out = {
    name: base.name,
    status: base.status,
    class: base.class,
    customerId: base.customerId ?? null,
    holder: base.holder ?? null,
    scopes: base.scopes,
    models: base.models,
    fleetAllow: base.fleetAllow,
    listeners: base.listeners,
    limits: { ...base.limits },
    allowedOrigins: base.allowedOrigins,
    allowedIps: base.allowedIps,
    labels: base.labels,
    expiresAt: base.expiresAt ?? null,
    notes: base.notes ?? null,
  };
  const collect = (field, fn) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof FieldError) errors.push({ field: error.field || field, code: error.code, message: error.message });
      else throw error;
    }
  };

  if (mode === "create" || has("name")) collect("name", () => { out.name = fieldText(input.name, "name", 1, 120); });
  if (has("status")) {
    collect("status", () => {
      if (!["active", "disabled"].includes(input.status)) throw new FieldError("status", "invalid", "status must be active or disabled; use revoke to revoke.");
      out.status = input.status;
    });
  }
  if (mode === "create" || has("class")) collect("class", () => { out.class = fieldEnum(input.class, policy.KEY_CLASSES, "class"); });
  if (has("customerId")) {
    collect("customerId", () => {
      if (input.customerId === null || input.customerId === "") out.customerId = null;
      else if (typeof input.customerId === "string" && UUID_RE.test(input.customerId.trim())) out.customerId = input.customerId.trim().toLowerCase();
      else throw new FieldError("customerId", "invalid", "customerId must be a billing customer UUID.");
    });
  }
  if (has("holder")) collect("holder", () => { out.holder = optionalFieldText(input.holder, "holder", 120); });
  if (mode === "create" || has("scopes")) {
    collect("scopes", () => { out.scopes = fieldList(input.scopes, "scopes", policy.SCOPES.length, (item) => fieldEnum(item, policy.SCOPES, "scopes")); });
  }
  if (mode === "create" || has("models")) {
    collect("models", () => { out.models = fieldList(input.models, "models", 200, (item) => patternItem(item, "models")); });
  }
  if (has("fleetAllow")) collect("fleetAllow", () => { out.fleetAllow = fieldList(input.fleetAllow, "fleetAllow", 200, (item) => patternItem(item, "fleetAllow")); });
  if (has("listeners")) {
    collect("listeners", () => {
      const listeners = fieldList(input.listeners, "listeners", policy.KEY_LISTENERS.length, (item) => fieldEnum(item, policy.KEY_LISTENERS, "listeners"));
      if (!listeners.length) throw new FieldError("listeners", "required", "A key needs at least one listener; disable it instead.");
      out.listeners = listeners;
    });
  }
  if (has("limits")) {
    collect("limits", () => {
      if (!isPlainObject(input.limits)) throw new FieldError("limits", "invalid", "limits must be an object.");
      for (const name of Object.keys(input.limits)) {
        const spec = LIMIT_FIELDS.find((item) => item.field === name);
        if (!spec) {
          errors.push({ field: `limits.${name}`, code: "unknown_field", message: `limits.${name} is not a limit.` });
          continue;
        }
        collect(`limits.${name}`, () => { out.limits[name] = limitValue(input.limits[name], spec); });
      }
    });
  }
  if (has("allowedOrigins")) {
    collect("allowedOrigins", () => {
      out.allowedOrigins = fieldList(input.allowedOrigins, "allowedOrigins", 50, (item) => {
        const origin = policy.normalizeOrigin(item);
        if (!origin) throw new FieldError("allowedOrigins", "invalid", "Origins are scheme://host[:port] with no path, or *.");
        return origin;
      });
    });
  }
  if (has("allowedIps")) {
    collect("allowedIps", () => {
      out.allowedIps = fieldList(input.allowedIps, "allowedIps", 100, (item) => {
        const rule = policy.normalizeIpRule(item);
        if (!rule) throw new FieldError("allowedIps", "invalid", "Allowed IPs are addresses or address/prefix ranges.");
        return rule;
      });
    });
  }
  if (has("labels")) collect("labels", () => { out.labels = labelsValue(input.labels); });
  if (has("expiresAt")) {
    collect("expiresAt", () => {
      if (input.expiresAt === null || input.expiresAt === "") out.expiresAt = null;
      else {
        const iso = optionalIsoDate(input.expiresAt);
        if (!iso) throw new FieldError("expiresAt", "invalid", "expiresAt must be an ISO date or null.");
        out.expiresAt = iso;
      }
    });
  }
  if (has("notes")) collect("notes", () => { out.notes = optionalFieldText(input.notes, "notes", 2000, { multiline: true }); });

  if (mode === "create") {
    if (has("id")) {
      collect("id", () => {
        const id = String(input.id ?? "").trim();
        if (!KEY_ID_RE.test(id)) throw new FieldError("id", "invalid", "id must be k_<20 base32> or <managerId>.<clientId>.");
        out.id = id;
      });
    }
    if (has("billing")) {
      collect("billing", () => {
        const billing = input.billing;
        if (!isPlainObject(billing)) throw new FieldError("billing", "invalid", "billing must be { scope, clientId }.");
        const scope = String(billing.scope ?? "").trim();
        const clientId = String(billing.clientId ?? "").trim();
        if (!BILLING_SCOPE_RE.test(scope)) throw new FieldError("billing.scope", "invalid", "billing.scope must be platform or a manager billing id.");
        if (!BILLING_CLIENT_RE.test(clientId)) throw new FieldError("billing.clientId", "invalid", "billing.clientId is invalid.");
        out.billing = { scope, clientId };
      });
    }
    if (has("ttsOwner")) {
      collect("ttsOwner", () => {
        const owner = String(input.ttsOwner ?? "").trim();
        if (!TTS_OWNER_RE.test(owner)) throw new FieldError("ttsOwner", "invalid", "ttsOwner must be <scope>:<clientId>.");
        out.ttsOwner = owner;
      });
    }
    if (has("legacy")) collect("legacy", () => { out.legacy = legacyValue(input.legacy); });
  }

  if (!errors.length) {
    if (out.class === "customer" && !out.customerId) {
      errors.push({ field: "customerId", code: "required", message: "Customer keys need a billing customer." });
    }
  }
  if (errors.length) throw invalid(errors);
  const wildcard = policy.checkWildcardOrigin(out);
  if (wildcard) {
    throw new KeysStoreError(wildcard, "A wildcard origin needs a friend or trial key with chat-only scopes.", 400, [
      { field: "allowedOrigins", code: wildcard, message: "A wildcard origin needs a friend or trial key with chat-only scopes." },
    ]);
  }
  return out;
}

class FieldError extends Error {
  constructor(field, code, message) {
    super(message);
    this.field = field;
    this.code = code;
  }
}

function fieldText(value, field, min, max, { multiline = false } = {}) {
  if (value === undefined || value === null) throw new FieldError(field, "required", `${field} is required.`);
  if (typeof value !== "string") throw new FieldError(field, "invalid", `${field} must be a string.`);
  const text = value.trim();
  const control = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (text.length < min) throw new FieldError(field, "required", `${field} is required.`);
  if (text.length > max) throw new FieldError(field, "too_long", `${field} is longer than ${max} characters.`);
  if (control.test(text)) throw new FieldError(field, "invalid", `${field} contains control characters.`);
  return text;
}

function optionalFieldText(value, field, max, options) {
  if (value === null || value === undefined || value === "") return null;
  const text = fieldText(value, field, 0, max, options);
  return text || null;
}

function fieldEnum(value, allowed, field) {
  if (typeof value !== "string" || !allowed.includes(value)) throw new FieldError(field, "invalid", `${field} has an unknown value.`);
  return value;
}

function fieldList(value, field, max, mapItem) {
  if (!Array.isArray(value)) throw new FieldError(field, "invalid", `${field} must be an array.`);
  if (value.length > max) throw new FieldError(field, "too_many", `${field} has more than ${max} entries.`);
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const mapped = mapItem(item);
    const key = String(mapped).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
  }
  return out;
}

function patternItem(value, field) {
  const text = fieldText(value, field, 1, 200);
  if (/\s/.test(text)) throw new FieldError(field, "invalid", `${field} patterns cannot contain spaces.`);
  if (text === "!") throw new FieldError(field, "invalid", `${field} has an empty exclude.`);
  return text;
}

function limitValue(value, spec) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < spec.min || number > spec.max) {
    throw new FieldError(`limits.${spec.field}`, "out_of_range", `limits.${spec.field} must be an integer between ${spec.min} and ${spec.max}, or null.`);
  }
  return number;
}

function labelsValue(value) {
  if (value === null) return {};
  if (!isPlainObject(value)) throw new FieldError("labels", "invalid", "labels must be an object of strings.");
  const entries = Object.entries(value);
  if (entries.length > 32) throw new FieldError("labels", "too_many", "labels has more than 32 entries.");
  const out = {};
  for (const [key, item] of entries) {
    if (!LABEL_KEY_RE.test(key)) throw new FieldError(`labels.${key}`, "invalid", "Label names are letters, digits, '.', '_', ':' or '-'.");
    if (isSensitiveKey(key)) throw new FieldError(`labels.${key}`, "invalid", "Labels cannot hold credentials.");
    out[key] = fieldText(item, `labels.${key}`, 0, 256);
    if (HEX64_RUN_RE.test(out[key])) throw new FieldError(`labels.${key}`, "invalid", "Labels cannot hold credentials.");
  }
  return out;
}

// Only the documented legacy fields survive, sanitized like audit details,
// so a legacy record can never smuggle a hash into a read.
function legacyValue(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new FieldError("legacy", "invalid", "legacy must be an object.");
  const out = {};
  for (const field of LEGACY_FIELDS) {
    if (value[field] === undefined) continue;
    try {
      out[field] = safeAuditDetails(value[field], 0, { dropSensitive: true });
    } catch {
      throw new FieldError(`legacy.${field}`, "invalid", `legacy.${field} is not plain data.`);
    }
  }
  if (JSON.stringify(out).length > 8192) throw new FieldError("legacy", "too_large", "legacy is too large.");
  return out;
}

function keyColumns(record) {
  const limits = record.limits || {};
  const columns = {
    name: record.name,
    status: record.status,
    class: record.class,
    customer_id: record.customerId ?? null,
    holder: record.holder ?? null,
    scopes: JSON.stringify(record.scopes || []),
    models: JSON.stringify(record.models || []),
    fleet_allow: JSON.stringify(record.fleetAllow || []),
    listeners: JSON.stringify(record.listeners || []),
    allowed_origins: JSON.stringify(record.allowedOrigins || []),
    allowed_ips: JSON.stringify(record.allowedIps || []),
    labels: JSON.stringify(record.labels || {}),
    expires_at: record.expiresAt ?? null,
    notes: record.notes ?? null,
  };
  for (const spec of LIMIT_FIELDS) columns[spec.column] = limits[spec.field] ?? null;
  return columns;
}

function changedKeyFields(current, next) {
  const changed = [];
  for (const field of EDITABLE_KEY_FIELDS) {
    if (field === "limits") {
      for (const spec of LIMIT_FIELDS) {
        if ((current.limits?.[spec.field] ?? null) !== (next.limits?.[spec.field] ?? null)) changed.push(`limits.${spec.field}`);
      }
      continue;
    }
    if (JSON.stringify(current[field] ?? null) !== JSON.stringify(next[field] ?? null)) changed.push(field);
  }
  return changed;
}

// The only way a key row leaves the store. key_hash and prev_key_hash are
// never copied.
function keyFromRow(row, at) {
  const limits = {};
  for (const spec of LIMIT_FIELDS) limits[spec.field] = row[spec.column] === null || row[spec.column] === undefined ? null : Number(row[spec.column]);
  const overlap = Boolean(row.prev_key_hash && row.prev_key_expires_at && row.prev_key_expires_at > at);
  return {
    id: row.key_id,
    name: row.name,
    preview: row.key_preview,
    status: row.status,
    class: row.class,
    customerId: row.customer_id ?? null,
    holder: row.holder ?? null,
    scopes: parseJsonArray(row.scopes),
    models: parseJsonArray(row.models),
    fleetAllow: parseJsonArray(row.fleet_allow),
    listeners: parseJsonArray(row.listeners),
    limits,
    allowedOrigins: parseJsonArray(row.allowed_origins),
    allowedIps: parseJsonArray(row.allowed_ips),
    labels: parseJsonObject(row.labels),
    expiresAt: row.expires_at ?? null,
    notes: row.notes ?? null,
    billing: { scope: row.billing_scope, clientId: row.billing_client_id },
    ttsOwner: row.tts_owner,
    legacy: row.legacy ? parseJson(row.legacy, null) : null,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    lastUsedIp: row.last_used_ip ?? null,
    lastUsedCountry: row.last_used_country ?? null,
    rotation: overlap ? { previousValidUntil: row.prev_key_expires_at } : null,
  };
}

// ---- other row mappers -----------------------------------------------------

function auditFromRow(row) {
  return {
    id: Number(row.id),
    at: row.at,
    actor: row.actor,
    actorIp: row.actor_ip ?? null,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id ?? null,
    details: parseJsonObject(row.details),
  };
}

function countersFromRow(row, period) {
  return {
    period,
    requests: Number(row?.requests || 0),
    inputTokens: Number(row?.input_tokens || 0),
    cachedInputTokens: Number(row?.cached_input_tokens || 0),
    outputTokens: Number(row?.output_tokens || 0),
    errors: Number(row?.errors || 0),
  };
}

function banActive(row, at) {
  return !row.expires_at || row.expires_at > at;
}

function banFromRow(row, at) {
  return {
    subject: row.subject,
    kind: row.kind,
    reason: row.reason,
    source: row.source,
    strikes: Number(row.strikes || 1),
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    createdBy: row.created_by,
    active: banActive(row, at),
  };
}

function announcementFromRow(row) {
  return {
    id: row.id,
    severity: row.severity,
    title: { zh: row.title_zh, en: row.title_en },
    body: { zh: row.body_zh, en: row.body_en },
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? null,
    audience: row.audience,
    published: Number(row.published) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function modelMetaFromRow(row) {
  return {
    modelId: row.model_id,
    displayName: { zh: row.display_name_zh ?? null, en: row.display_name_en ?? null },
    description: { zh: row.description_zh ?? null, en: row.description_en ?? null },
    aliases: parseJsonArray(row.aliases),
    hidden: Number(row.hidden) === 1,
    recommended: Number(row.recommended) === 1,
    sort: Number(row.sort || 0),
    updatedAt: row.updated_at,
  };
}

function normalizeAnnouncement(input, row, at) {
  if (!isPlainObject(input)) throw invalid([{ field: "", code: "invalid", message: "Announcement input must be an object." }]);
  const allowed = new Set(["severity", "title", "body", "startsAt", "endsAt", "audience", "published"]);
  const errors = [];
  for (const field of Object.keys(input)) if (!allowed.has(field)) errors.push({ field, code: "unknown_field", message: `${field} cannot be set.` });
  const has = (field) => input[field] !== undefined;
  const out = {
    severity: row?.severity ?? "info",
    titleZh: row?.title_zh,
    titleEn: row?.title_en,
    bodyZh: row?.body_zh ?? "",
    bodyEn: row?.body_en ?? "",
    startsAt: row?.starts_at ?? at,
    endsAt: row?.ends_at ?? null,
    audience: row?.audience ?? "all",
    published: Number(row?.published ?? 0),
  };
  const run = (field, fn) => {
    try { fn(); } catch (error) {
      if (error instanceof FieldError) errors.push({ field: error.field || field, code: error.code, message: error.message });
      else throw error;
    }
  };
  if (has("severity")) run("severity", () => { out.severity = fieldEnum(input.severity, ANNOUNCEMENT_SEVERITIES, "severity"); });
  if (!row || has("title")) {
    run("title", () => {
      if (!isPlainObject(input.title)) throw new FieldError("title", "required", "title needs zh and en text.");
      out.titleZh = fieldText(input.title.zh, "title.zh", 1, 200);
      out.titleEn = fieldText(input.title.en, "title.en", 1, 200);
    });
  }
  if (has("body")) {
    run("body", () => {
      if (!isPlainObject(input.body)) throw new FieldError("body", "invalid", "body needs zh and en text.");
      out.bodyZh = input.body.zh === undefined ? out.bodyZh : fieldText(input.body.zh, "body.zh", 0, 4000, { multiline: true });
      out.bodyEn = input.body.en === undefined ? out.bodyEn : fieldText(input.body.en, "body.en", 0, 4000, { multiline: true });
    });
  }
  if (has("startsAt")) run("startsAt", () => { out.startsAt = requiredFieldDate(input.startsAt, "startsAt"); });
  if (has("endsAt")) run("endsAt", () => { out.endsAt = input.endsAt === null || input.endsAt === "" ? null : requiredFieldDate(input.endsAt, "endsAt"); });
  if (has("audience")) run("audience", () => { out.audience = fieldEnum(input.audience, ANNOUNCEMENT_AUDIENCES, "audience"); });
  if (has("published")) run("published", () => {
    if (typeof input.published !== "boolean") throw new FieldError("published", "invalid", "published must be true or false.");
    out.published = input.published ? 1 : 0;
  });
  if (!errors.length && out.endsAt && out.endsAt <= out.startsAt) {
    errors.push({ field: "endsAt", code: "out_of_range", message: "endsAt must be after startsAt." });
  }
  if (errors.length) throw invalid(errors, "Announcement fields are invalid.");
  return out;
}

function normalizeModelMeta(input, current) {
  if (!isPlainObject(input)) throw invalid([{ field: "", code: "invalid", message: "Model metadata must be an object." }]);
  const allowed = new Set(["displayName", "description", "aliases", "hidden", "recommended", "sort"]);
  const errors = [];
  for (const field of Object.keys(input)) if (!allowed.has(field)) errors.push({ field, code: "unknown_field", message: `${field} cannot be set.` });
  const out = {
    displayName: { ...(current?.displayName || { zh: null, en: null }) },
    description: { ...(current?.description || { zh: null, en: null }) },
    aliases: current?.aliases || [],
    hidden: current?.hidden || false,
    recommended: current?.recommended || false,
    sort: current?.sort || 0,
  };
  const run = (field, fn) => {
    try { fn(); } catch (error) {
      if (error instanceof FieldError) errors.push({ field: error.field || field, code: error.code, message: error.message });
      else throw error;
    }
  };
  for (const [field, max] of [["displayName", 120], ["description", 2000]]) {
    if (input[field] === undefined) continue;
    run(field, () => {
      if (!isPlainObject(input[field])) throw new FieldError(field, "invalid", `${field} needs zh and en text.`);
      for (const lang of ["zh", "en"]) {
        if (input[field][lang] !== undefined) out[field][lang] = optionalFieldText(input[field][lang], `${field}.${lang}`, max, { multiline: field === "description" });
      }
    });
  }
  if (input.aliases !== undefined) run("aliases", () => { out.aliases = fieldList(input.aliases, "aliases", 20, (item) => fieldText(item, "aliases", 1, 128)); });
  for (const field of ["hidden", "recommended"]) {
    if (input[field] === undefined) continue;
    run(field, () => {
      if (typeof input[field] !== "boolean") throw new FieldError(field, "invalid", `${field} must be true or false.`);
      out[field] = input[field];
    });
  }
  if (input.sort !== undefined) run("sort", () => {
    if (!Number.isSafeInteger(input.sort) || Math.abs(input.sort) > 1_000_000) throw new FieldError("sort", "out_of_range", "sort must be an integer.");
    out.sort = input.sort;
  });
  if (errors.length) throw invalid(errors, "Model metadata is invalid.");
  return out;
}

// ---- shared helpers --------------------------------------------------------

// Quota periods in the quota time zone (§3.4, §9.4): 'd:YYYY-MM-DD' and
// 'm:YYYY-MM', with the UTC instants at which each resets.
function quotaPeriods(at, tzOffsetMinutes = 0) {
  const date = toDate(at) || new Date();
  const offset = clampTzOffsetMinutes(tzOffsetMinutes);
  const offsetMs = offset * 60 * 1000;
  const shifted = new Date(date.getTime() + offsetMs);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const dayStart = Date.UTC(year, month, day) - offsetMs;
  const monthStart = Date.UTC(year, month, 1) - offsetMs;
  const monthEnd = Date.UTC(year, month + 1, 1) - offsetMs;
  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    tzOffsetMinutes: offset,
    day: { key: `d:${year}-${mm}-${dd}`, start: new Date(dayStart).toISOString(), end: new Date(dayStart + 86_400_000).toISOString() },
    month: { key: `m:${year}-${mm}`, start: new Date(monthStart).toISOString(), end: new Date(monthEnd).toISOString() },
  };
}

function banDurationSeconds(strikes, banSeconds = DEFAULT_BAN_SECONDS, maxBanSeconds = DEFAULT_MAX_BAN_SECONDS) {
  const count = Math.max(1, Math.floor(Number(strikes) || 1));
  let seconds = Math.max(1, Math.floor(Number(banSeconds) || DEFAULT_BAN_SECONDS));
  const cap = Math.max(seconds, Math.floor(Number(maxBanSeconds) || DEFAULT_MAX_BAN_SECONDS));
  for (let strike = 1; strike < count && seconds < cap; strike += 1) seconds *= 4;
  return Math.min(seconds, cap);
}

function cidrCoversLoopback(rule) {
  if (rule.family === 6) return policy.ipMatchesRule("::1", rule);
  // Any overlap with 127.0.0.0/8: the rule contains it, or lies inside it.
  return policy.ipMatchesRule("127.0.0.1", rule) || (rule.prefix >= 8 && (rule.network >> 24n) === 127n);
}

function protectedSubject() {
  return new KeysStoreError("ban_subject_protected", "Loopback addresses are never banned.", 400);
}

function retryableCollision() {
  const error = new Error("hash collision");
  error.retryable = true;
  return error;
}

function constraintColumn(error) {
  const message = String(error?.message || "");
  if (!/UNIQUE constraint failed/i.test(message)) return "";
  if (/api_keys\.billing_scope/.test(message)) return "billing";
  if (/api_keys\.prev_key_hash/.test(message)) return "prev_key_hash";
  if (/api_keys\.key_hash/.test(message)) return "key_hash";
  if (/api_keys\.key_id/.test(message)) return "key_id";
  return "other";
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function previewSecret(secret) {
  const body = String(secret).startsWith(SECRET_PREFIX) ? String(secret).slice(SECRET_PREFIX.length) : String(secret);
  return `${SECRET_PREFIX}${body.slice(0, 1)}…${body.slice(-4)}`;
}

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function encodeCursor(createdAt, keyId) {
  return Buffer.from(JSON.stringify({ c: createdAt, k: keyId })).toString("base64url");
}

function decodeCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof parsed?.c === "string" && typeof parsed?.k === "string" && KEY_ID_RE.test(parsed.k)) {
      return { createdAt: parsed.c, keyId: parsed.k };
    }
  } catch {}
  throw invalid([{ field: "cursor", code: "invalid", message: "The cursor is invalid." }]);
}

function minuteKey(value) {
  if (value instanceof Date || typeof value === "number") {
    const date = toDate(value);
    if (date) return date.toISOString().slice(0, 16);
  }
  const text = String(value ?? "");
  if (MINUTE_RE.test(text)) return text.slice(0, 16);
  throw invalid([{ field: "minute", code: "invalid", message: "minute must be YYYY-MM-DDTHH:MM." }]);
}

// Field names that may hold a credential. "token" counts only as the last
// word, so counter names such as dailyTokens stay usable.
function isSensitiveKey(value) {
  const key = String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!key) return false;
  if (/(?:hash|secret|password|passwd|cookie|csrf|authorization|bearer|privatekey|apikey)/.test(key)) return true;
  return /token$/.test(key);
}

// Audit details carry names and small values only. Credential-named fields
// are refused (dropped with dropSensitive, for imported legacy data); any
// string that looks like a key or a hash is redacted.
function safeAuditDetails(value, depth = 0, options = {}) {
  if (depth > 5) throw invalid([{ field: "details", code: "too_deep", message: "Audit details are too deeply nested." }]);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid([{ field: "details", code: "invalid", message: "Audit numbers must be finite." }]);
    return value;
  }
  if (typeof value === "string") {
    const text = value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
    const redacted = redactValue(text);
    return HEX64_RUN_RE.test(redacted) ? REDACTED : redacted;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw invalid([{ field: "details", code: "too_many", message: "Audit arrays are too large." }]);
    return value.map((item) => safeAuditDetails(item, depth + 1, options));
  }
  if (!isPlainObject(value)) throw invalid([{ field: "details", code: "invalid", message: "Audit details must be plain JSON data." }]);
  const entries = Object.entries(value);
  if (entries.length > 50) throw invalid([{ field: "details", code: "too_many", message: "Audit objects are too large." }]);
  const out = {};
  for (const [key, item] of entries) {
    if (isSensitiveKey(key)) {
      if (options.dropSensitive) continue;
      throw new KeysStoreError("audit_sensitive_field", "Credential fields are not allowed in audit details.", 400);
    }
    out[key.slice(0, 80)] = safeAuditDetails(item, depth + 1, options);
  }
  return out;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseJsonArray(text) {
  const value = parseJson(text, []);
  return Array.isArray(value) ? value : [];
}

function parseJsonObject(text) {
  const value = parseJson(text, {});
  return isPlainObject(value) ? value : {};
}

function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function toIso(value) {
  return (toDate(value) || new Date()).toISOString();
}

function optionalIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function requiredIsoDate(value, field) {
  const iso = optionalIsoDate(value);
  if (!iso) throw invalid([{ field, code: "invalid", message: `${field} must be an ISO date.` }]);
  return iso;
}

function requiredFieldDate(value, field) {
  const iso = optionalIsoDate(value);
  if (!iso) throw new FieldError(field, "invalid", `${field} must be an ISO date.`);
  return iso;
}

function plainText(value, field, min, max) {
  try {
    return fieldText(typeof value === "number" ? String(value) : value, field, min, max);
  } catch (error) {
    if (error instanceof FieldError) throw invalid([{ field: error.field, code: error.code, message: error.message }]);
    throw error;
  }
}

function patternText(value, field, pattern) {
  const text = String(value ?? "");
  if (!pattern.test(text)) throw invalid([{ field, code: "invalid", message: `${field} is invalid.` }]);
  return text;
}

function actorText(value) {
  if (value === undefined || value === null || value === "") return "system";
  return plainText(String(value), "actor", 1, 128);
}

function optionalIp(value) {
  return policy.normalizeIp(value) || null;
}

function keyIdText(value) {
  const keyId = String(value ?? "").trim();
  if (!KEY_ID_RE.test(keyId)) throw invalid([{ field: "keyId", code: "invalid", message: "The key id is invalid." }], "The key id is invalid.");
  return keyId;
}

function enumValue(value, allowed, field) {
  const text = String(value ?? "");
  if (!allowed.includes(text)) throw invalid([{ field, code: "invalid", message: `${field} has an unknown value.` }]);
  return text;
}

function normalizeBanSubjectLoose(value) {
  const rule = policy.parseIpRule(value);
  if (rule) return rule.text;
  const text = String(value ?? "").trim();
  return KEY_ID_RE.test(text) ? text : "";
}

function counterAmount(value, field) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid([{ field, code: "out_of_range", message: `${field} must be a non-negative integer.` }]);
  }
  return value;
}

function clampLimit(value, fallback, max = 200) {
  const number = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clampTzOffsetMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(number)));
}

function normalizeDatabaseFile(value) {
  const text = String(value || "").trim();
  if (!text) throw new KeysStoreError("access_store_unavailable", "Access store file is required.", 503);
  return text === ":memory:" ? text : path.resolve(text);
}

module.exports = {
  ACCESS_STORE_FILENAME,
  KEY_ID_RE,
  KeysStoreError,
  LIMIT_FIELDS,
  MAX_OVERLAP_SECONDS,
  SCHEMA_VERSION,
  SECRET_PREFIX,
  banDurationSeconds,
  createKeysStore,
  normalizeKeyInput,
  quotaPeriods,
};
