"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const usageStore = require("../service-usage-store");

const LEGACY_USAGE_SCHEMA = `
  CREATE TABLE service_usage_events (
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
`;

test("service usage schema migrates legacy SQLite rows in place and is repeatable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "service-usage-migration-"));
  const file = path.join(dir, "usage.sqlite");
  const legacyDb = new DatabaseSync(file);
  legacyDb.exec(LEGACY_USAGE_SCHEMA);
  legacyDb.prepare(`
    INSERT INTO service_usage_events (
      event_id, at, manager, client_id, model, status, ok,
      prompt_tokens, generation_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-ok", "2026-08-01T00:00:00.000Z", "vllm-manager", "client-1", "model-a", 200, 1, 5, 7, 12);
  legacyDb.prepare(`
    INSERT INTO service_usage_events (
      event_id, at, manager, client_id, model, status, ok,
      prompt_tokens, generation_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-failed", "2026-08-01T00:01:00.000Z", "vllm-manager", "client-1", "model-a", 500, 0, 0, 0, 0);
  legacyDb.close();

  const store = usageStore.createServiceUsageStore({ DatabaseSync, file, managerId: "vllm-manager" });
  const db = store.getDb();
  const columns = db.prepare("PRAGMA table_info(service_usage_events)").all().map((row) => row.name);
  assert.equal(columns.includes("request_id"), true);
  assert.equal(columns.includes("usage_source"), true);
  assert.equal(columns.includes("stream"), true);
  assert.equal(columns.includes("terminal_state"), true);
  assert.equal(columns.includes("cached_tokens"), true);

  const rows = db.prepare(`
    SELECT event_id, request_id, usage_source, stream, terminal_state, cached_tokens,
           prompt_tokens, generation_tokens, total_tokens
    FROM service_usage_events ORDER BY event_id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      event_id: "legacy-failed",
      request_id: "",
      usage_source: "missing",
      stream: 0,
      terminal_state: "failed",
      cached_tokens: null,
      prompt_tokens: 0,
      generation_tokens: 0,
      total_tokens: 0,
    },
    {
      event_id: "legacy-ok",
      request_id: "",
      usage_source: "reported",
      stream: 0,
      terminal_state: "completed",
      cached_tokens: null,
      prompt_tokens: 5,
      generation_tokens: 7,
      total_tokens: 12,
    },
  ]);

  usageStore.ensureServiceUsageSchema(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM service_usage_events").get().count, 2);
  const indexNames = db.prepare("PRAGMA index_list(service_usage_events)").all().map((row) => row.name);
  assert.equal(indexNames.includes("idx_service_usage_request_idempotency"), true);
  store.close();
});

test("service usage persistence is request-idempotent and excludes private payload fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "service-usage-idempotency-"));
  const file = path.join(dir, "usage.sqlite");
  let uuidCounter = 0;
  const store = usageStore.createServiceUsageStore({
    DatabaseSync,
    file,
    managerId: "vllm-manager",
    randomUUID: () => `event-${++uuidCounter}`,
  });
  const first = {
    clientId: "client-1",
    requestId: "request-1",
    model: "model-a",
    status: 200,
    ok: true,
    promptTokens: 11,
    generationTokens: 4,
    totalTokens: 15,
    cachedTokens: 6,
    usageSource: "reported",
    stream: true,
    terminalState: "completed",
    prompt: "PRIVATE PROMPT MUST NOT BE STORED",
    response: "PRIVATE RESPONSE MUST NOT BE STORED",
    apiKey: "test-key-private-must-not-be-stored",
    requestBody: { messages: [{ content: "PRIVATE BODY MUST NOT BE STORED" }] },
  };
  const firstResult = store.persistUsageEvent(first);
  const duplicateResult = store.persistUsageEvent({
    ...first,
    promptTokens: 999,
    generationTokens: 999,
    totalTokens: 1998,
  });
  assert.equal(firstResult.changes, 1);
  assert.equal(duplicateResult.changes, 0);

  store.persistUsageEvent({
    clientId: "client-1",
    requestId: "request-missing-usage",
    model: "model-a",
    status: 499,
    ok: false,
    usageSource: "missing",
    stream: true,
    terminalState: "aborted",
  });

  const db = store.getDb();
  const directDuplicate = usageStore.persistServiceUsageEventToDb(db, first, {
    managerId: "vllm-manager",
    eventId: "different-event-id",
    now: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(directDuplicate.changes, 0);
  usageStore.persistServiceUsageEventToDb(db, first, {
    managerId: "llama-manager",
    eventId: "same-request-other-manager",
    now: "2026-08-02T00:00:01.000Z",
  });

  const rows = db.prepare(`
    SELECT manager, client_id, request_id, prompt_tokens, generation_tokens, total_tokens,
           cached_tokens, usage_source, stream, terminal_state
    FROM service_usage_events ORDER BY manager, request_id
  `).all();
  assert.equal(rows.length, 3);
  assert.deepEqual({ ...rows.find((row) => row.manager === "vllm-manager" && row.request_id === "request-1") }, {
    manager: "vllm-manager",
    client_id: "client-1",
    request_id: "request-1",
    prompt_tokens: 11,
    generation_tokens: 4,
    total_tokens: 15,
    cached_tokens: 6,
    usage_source: "reported",
    stream: 1,
    terminal_state: "completed",
  });
  assert.deepEqual({ ...rows.find((row) => row.request_id === "request-missing-usage") }, {
    manager: "vllm-manager",
    client_id: "client-1",
    request_id: "request-missing-usage",
    prompt_tokens: 0,
    generation_tokens: 0,
    total_tokens: 0,
    cached_tokens: null,
    usage_source: "missing",
    stream: 1,
    terminal_state: "aborted",
  });

  const columnNames = db.prepare("PRAGMA table_info(service_usage_events)").all().map((row) => row.name);
  for (const forbidden of ["prompt", "response", "api_key", "secret", "request_body", "response_body"]) {
    assert.equal(columnNames.includes(forbidden), false);
  }
  const serializedRows = JSON.stringify(db.prepare("SELECT * FROM service_usage_events").all());
  assert.equal(serializedRows.includes("PRIVATE PROMPT"), false);
  assert.equal(serializedRows.includes("PRIVATE RESPONSE"), false);
  assert.equal(serializedRows.includes("sk-private"), false);
  assert.equal(serializedRows.includes("PRIVATE BODY"), false);
  store.close();
});
