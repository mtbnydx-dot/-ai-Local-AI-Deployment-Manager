"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
      total_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_service_usage_client_at ON service_usage_events(client_id, at);
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

function persistServiceUsageEventToDb(db, event = {}, options = {}) {
  if (!db || !event.clientId) return;
  const eventId = options.eventId || (options.randomUUID || crypto.randomUUID)();
  const at = options.now || new Date().toISOString();
  const managerId = options.managerId || "";
  db.prepare(`
    INSERT INTO service_usage_events (event_id, at, manager, client_id, model, status, ok, prompt_tokens, generation_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    at,
    managerId,
    String(event.clientId || ""),
    String(event.model || ""),
    Number(event.status || 0),
    event.ok === false ? 0 : 1,
    Number(event.promptTokens || 0),
    Number(event.generationTokens || 0),
    Number(event.totalTokens || 0),
  );
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

  function getDb() {
    if (!DatabaseSync || !file) return null;
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    ensureServiceUsageSchema(db);
    return db;
  }

  return {
    getDb,
    persistClients(ledger) {
      persistServiceClientsToDb(getDb(), ledger);
    },
    persistUsageEvent(event) {
      persistServiceUsageEventToDb(getDb(), event, { managerId });
    },
    deleteClient(id) {
      deleteServiceClientFromDb(getDb(), id);
    },
    close() {
      if (db && typeof db.close === "function") db.close();
      db = null;
    },
  };
}

module.exports = {
  createServiceUsageStore,
  deleteServiceClientFromDb,
  ensureServiceUsageSchema,
  persistServiceClientsToDb,
  persistServiceUsageEventToDb,
};
