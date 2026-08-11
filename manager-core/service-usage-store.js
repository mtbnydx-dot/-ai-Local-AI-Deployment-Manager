"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SERVICE_USAGE_SOURCE_VALUES = new Set(["reported", "estimated", "missing"]);
const SERVICE_USAGE_TERMINAL_STATE_VALUES = new Set(["completed", "failed", "aborted", "timed_out"]);
const SERVICE_USAGE_EVENT_INSERT_SQL = `
  INSERT OR IGNORE INTO service_usage_events (
    event_id, at, manager, client_id, model, status, ok,
    prompt_tokens, generation_tokens, total_tokens,
    request_id, usage_source, stream, terminal_state, cached_tokens
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SERVICE_USAGE_EVENT_COLUMN_MIGRATIONS = [
  ["request_id", "ALTER TABLE service_usage_events ADD COLUMN request_id TEXT NOT NULL DEFAULT ''"],
  ["usage_source", "ALTER TABLE service_usage_events ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'missing'"],
  ["stream", "ALTER TABLE service_usage_events ADD COLUMN stream INTEGER NOT NULL DEFAULT 0"],
  ["terminal_state", "ALTER TABLE service_usage_events ADD COLUMN terminal_state TEXT NOT NULL DEFAULT 'completed'"],
  ["cached_tokens", "ALTER TABLE service_usage_events ADD COLUMN cached_tokens INTEGER DEFAULT NULL"],
];

function serviceUsageTableColumns(db) {
  const statement = db.prepare("PRAGMA table_info(service_usage_events)");
  if (!statement || typeof statement.all !== "function") return null;
  return new Set(statement.all().map((row) => String(row?.name || "")).filter(Boolean));
}

function migrateServiceUsageEventColumns(db) {
  const columns = serviceUsageTableColumns(db);
  if (!columns?.size) return;
  const added = new Set();
  for (const [name, sql] of SERVICE_USAGE_EVENT_COLUMN_MIGRATIONS) {
    if (columns.has(name)) continue;
    db.exec(sql);
    columns.add(name);
    added.add(name);
  }
  if (added.has("usage_source")) {
    db.exec(`
      UPDATE service_usage_events
      SET usage_source = 'reported'
      WHERE prompt_tokens > 0 OR generation_tokens > 0 OR total_tokens > 0
    `);
  }
  if (added.has("terminal_state")) {
    db.exec(`
      UPDATE service_usage_events
      SET terminal_state = CASE WHEN ok = 1 THEN 'completed' ELSE 'failed' END
    `);
  }
}

function ensureServiceUsageSchema(db) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_clients (
      client_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      key_preview TEXT NOT NULL,
      allowed_models TEXT NOT NULL,
      rate_limit_rpm INTEGER NOT NULL,
      max_concurrent_requests INTEGER NOT NULL,
      request_timeout_seconds INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      notes TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_usage_events (
      event_id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      manager TEXT NOT NULL,
      client_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      generation_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      request_id TEXT NOT NULL DEFAULT '',
      usage_source TEXT NOT NULL DEFAULT 'missing',
      stream INTEGER NOT NULL DEFAULT 0,
      terminal_state TEXT NOT NULL DEFAULT 'completed',
      cached_tokens INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_usage_client_at ON service_usage_events(client_id, at);
  `);
  migrateServiceUsageEventColumns(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_usage_request_idempotency
      ON service_usage_events(manager, client_id, request_id)
      WHERE request_id <> '';
  `);
}

function persistServiceClientsToDb(db, ledger = {}, options = {}) {
  if (!db) return;
  const updatedAt = options.now || new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO service_clients (client_id, name, enabled, key_preview, allowed_models, rate_limit_rpm, max_concurrent_requests, request_timeout_seconds, expires_at, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      name=excluded.name,
      enabled=excluded.enabled,
      key_preview=excluded.key_preview,
      allowed_models=excluded.allowed_models,
      rate_limit_rpm=excluded.rate_limit_rpm,
      max_concurrent_requests=excluded.max_concurrent_requests,
      request_timeout_seconds=excluded.request_timeout_seconds,
      expires_at=excluded.expires_at,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  `);
  for (const client of ledger.clients || []) {
    stmt.run(
      client.id,
      client.name,
      client.enabled ? 1 : 0,
      client.keyPreview || "",
      JSON.stringify(client.allowedModels || []),
      client.rateLimitRpm,
      client.maxConcurrentRequests,
      client.requestTimeoutSeconds,
      client.expiresAt || "",
      client.notes || "",
      updatedAt,
    );
  }
}

function normalizeServiceUsageInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeServiceUsageOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeServiceUsageText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function buildServiceUsageEventRow(event = {}, options = {}) {
  const managerId = normalizeServiceUsageText(options.managerId || event.manager || "", 128);
  const clientId = normalizeServiceUsageText(event.clientId || "", 256);
  const requestId = normalizeServiceUsageText(event.requestId || event.request_id || "", 256);
  const promptTokens = normalizeServiceUsageInteger(event.promptTokens, 0);
  const generationTokens = normalizeServiceUsageInteger(event.generationTokens, 0);
  const suppliedTotalTokens = normalizeServiceUsageOptionalInteger(event.totalTokens);
  const totalTokens = suppliedTotalTokens === null ? promptTokens + generationTokens : suppliedTotalTokens;
  const cachedTokens = normalizeServiceUsageOptionalInteger(
    event.cachedTokens
    ?? event.usage?.cached_tokens
    ?? event.usage?.prompt_tokens_details?.cached_tokens
    ?? event.usage?.input_tokens_details?.cached_tokens,
  );
  const requestedUsageSource = String(event.usageSource || event.usage_source || "").trim().toLowerCase();
  const usageSource = SERVICE_USAGE_SOURCE_VALUES.has(requestedUsageSource) ? requestedUsageSource : "missing";
  const requestedTerminalState = String(event.terminalState || event.terminal_state || "").trim().toLowerCase();
  const terminalState = SERVICE_USAGE_TERMINAL_STATE_VALUES.has(requestedTerminalState)
    ? requestedTerminalState
    : (event.ok === false ? "failed" : "completed");
  const explicitEventId = normalizeServiceUsageText(options.eventId || event.eventId || event.event_id || "", 256);
  const eventId = explicitEventId || (requestId
    ? `req_${crypto.createHash("sha256").update(`${managerId}\n${clientId}\n${requestId}`, "utf8").digest("hex")}`
    : (options.randomUUID || crypto.randomUUID)());
  return {
    eventId,
    at: String(options.now || new Date().toISOString()),
    managerId,
    clientId,
    model: normalizeServiceUsageText(event.model || "", 512),
    status: normalizeServiceUsageInteger(event.status, 0),
    ok: event.ok === false ? 0 : 1,
    promptTokens,
    generationTokens,
    totalTokens,
    requestId,
    usageSource,
    stream: event.stream === true ? 1 : 0,
    terminalState,
    cachedTokens,
  };
}

function serviceUsageEventSqlValues(row) {
  return [
    row.eventId,
    row.at,
    row.managerId,
    row.clientId,
    row.model,
    row.status,
    row.ok,
    row.promptTokens,
    row.generationTokens,
    row.totalTokens,
    row.requestId,
    row.usageSource,
    row.stream,
    row.terminalState,
    row.cachedTokens,
  ];
}

function persistServiceUsageEventToDb(db, event = {}, options = {}) {
  if (!db || !event.clientId) return;
  const row = buildServiceUsageEventRow(event, options);
  return db.prepare(SERVICE_USAGE_EVENT_INSERT_SQL).run(...serviceUsageEventSqlValues(row));
}

function deleteServiceClientFromDb(db, id) {
  if (!db) return;
  db.prepare("DELETE FROM service_clients WHERE client_id = ?").run(String(id || ""));
}

function createServiceUsageStore(options = {}) {
  const DatabaseSync = options.DatabaseSync;
  const file = options.file || "";
  const managerId = options.managerId || "";
  let db = null;
  let stmts = null;

  function getDb() {
    if (!DatabaseSync || !file) return null;
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    ensureServiceUsageSchema(db);
    // Prepare once and reuse. These run on every inference request, so
    // re-preparing per call would re-block the event loop needlessly.
    stmts = {
      upsertClient: db.prepare(`
        INSERT INTO service_clients (client_id, name, enabled, key_preview, allowed_models, rate_limit_rpm, max_concurrent_requests, request_timeout_seconds, expires_at, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          name=excluded.name,
          enabled=excluded.enabled,
          key_preview=excluded.key_preview,
          allowed_models=excluded.allowed_models,
          rate_limit_rpm=excluded.rate_limit_rpm,
          max_concurrent_requests=excluded.max_concurrent_requests,
          request_timeout_seconds=excluded.request_timeout_seconds,
          expires_at=excluded.expires_at,
          notes=excluded.notes,
          updated_at=excluded.updated_at
      `),
      insertUsageEvent: db.prepare(SERVICE_USAGE_EVENT_INSERT_SQL),
      deleteClient: db.prepare("DELETE FROM service_clients WHERE client_id = ?"),
    };
    return db;
  }

  function getStatements() {
    if (!stmts) getDb();
    return stmts;
  }

  return {
    getDb,
    persistClients(ledger) {
      const stmt = getStatements()?.upsertClient;
      if (!stmt) return;
      const updatedAt = new Date().toISOString();
      for (const client of ledger.clients || []) {
        stmt.run(
          client.id,
          client.name,
          client.enabled ? 1 : 0,
          client.keyPreview || "",
          JSON.stringify(client.allowedModels || []),
          client.rateLimitRpm,
          client.maxConcurrentRequests,
          client.requestTimeoutSeconds,
          client.expiresAt || "",
          client.notes || "",
          updatedAt,
        );
      }
    },
    persistUsageEvent(event) {
      const stmt = getStatements()?.insertUsageEvent;
      if (!stmt || !event.clientId) return;
      const row = buildServiceUsageEventRow(event, {
        managerId,
        randomUUID: options.randomUUID,
      });
      return stmt.run(...serviceUsageEventSqlValues(row));
    },
    deleteClient(id) {
      const stmt = getStatements()?.deleteClient;
      if (!stmt) return;
      stmt.run(String(id || ""));
    },
    close() {
      if (db && typeof db.close === "function") db.close();
      db = null;
      stmts = null;
    },
  };
}

module.exports = {
  SERVICE_USAGE_EVENT_INSERT_SQL,
  buildServiceUsageEventRow,
  createServiceUsageStore,
  deleteServiceClientFromDb,
  ensureServiceUsageSchema,
  migrateServiceUsageEventColumns,
  persistServiceClientsToDb,
  persistServiceUsageEventToDb,
};
