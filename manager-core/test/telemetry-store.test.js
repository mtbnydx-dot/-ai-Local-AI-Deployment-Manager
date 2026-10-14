"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sqlite = require("node:sqlite");
const schema = require("../telemetry/schema");
const storeWorker = require("../telemetry/store-worker");
const { openTelemetryStore, TelemetryStoreError, STORE_WORKER } = require("../telemetry/store");

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const cleanups = new WeakMap();

// Windows keeps an open database file locked, so every store a test opens is
// closed (and file modes restored) before its temp folder is removed.
function tempDir(t, prefix = "telemetry-store-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tasks = [];
  cleanups.set(t, tasks);
  t.after(async () => {
    for (const task of tasks.reverse()) {
      try { await task(); } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return dir;
}

function cleanup(t, task) {
  cleanups.get(t).push(task);
}

function quietLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push({ level, message });
  return { lines, log: push("log"), warn: push("warn"), error: push("error") };
}

function requestId(index, prefix = "req_") {
  let value = index;
  let text = "";
  for (let position = 0; position < 20; position += 1) {
    text = BASE32[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `${prefix}${text}`;
}

function requestRow(index, overrides = {}) {
  const receivedAt = overrides.receivedAt ?? NOW - 60_000 + index;
  return {
    requestId: requestId(index),
    ingress: "entry",
    receivedAt,
    endedAt: receivedAt + 120,
    managerId: "vllm",
    fleetId: "vllm:inst-1",
    engineId: "vllm",
    protocol: "openai",
    op: "chat",
    route: "auto",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    modelRequested: "demo-model",
    modelResolved: "demo-model",
    stream: true,
    keyId: "k_test",
    clientIp: "192.0.2.10",
    userAgent: "test-agent/1.0",
    sourceProgram: "curl",
    status: 200,
    terminalState: "completed",
    errorClass: "none",
    durationMs: 120,
    ttftMs: 30,
    decodeTps: 55.5,
    promptTokens: 10,
    outputTokens: 20,
    usageSource: "reported",
    finishReason: "stop",
    bytesOut: 1234,
    extra: { toolSchemaCount: 0 },
    ...overrides,
  };
}

function readDb(file, operation) {
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function columnsOf(db, table) {
  return db.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value AS dflt, pk FROM pragma_table_info(?) ORDER BY cid")
    .all(table)
    .map((row) => ({ ...row }));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const EXPECTED_TABLES = [
  "alert_rules", "alert_state", "audit_access_log", "collector_state", "control_counts_1m", "coverage_1m",
  "events", "gpu_rollup_1d", "gpu_rollup_1h", "gpu_rollup_1m", "gpu_samples", "import_runs", "lifetime_baseline",
  "requests", "rollup_1d", "rollup_1h", "rollup_1m", "rollup_dirty", "runtime_rollup_1d", "runtime_rollup_1h",
  "runtime_rollup_1m", "runtime_samples", "schema_meta",
];

const EXPECTED_REQUEST_COLUMNS = [
  "id", "request_id", "client_request_id", "manager_request_id", "ingress", "received_at", "ended_at",
  "manager_id", "fleet_id", "engine_id", "runtime_id", "launch_id", "protocol", "op", "route", "method", "path",
  "model_requested", "model_resolved", "stream", "key_id", "customer_id", "auth_source", "client_ip",
  "client_country", "user_agent", "origin_host", "source_program", "owui_user_id", "owui_chat_id", "status",
  "terminal_state", "error_class", "error_code", "queue_ms", "upstream_headers_ms", "ttft_ms", "duration_ms",
  "decode_tps", "prompt_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "usage_source",
  "finish_reason", "bytes_out", "engine_prompt_ms", "engine_decode_tps", "engine_cached_tokens", "extra",
];

test("the §4.2 DDL is created and stats() reports the §4.1 PRAGMAs", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "data", "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  const stats = await store.stats();
  await store.close();

  assert.equal(stats.ok, true);
  assert.equal(stats.store, "ok");
  assert.equal(stats.mode, "worker");
  assert.equal(stats.thread, "worker");
  assert.equal(stats.schemaVersion, schema.SCHEMA_VERSION);
  assert.deepEqual(stats.pragmas, {
    busy_timeout: 5000,
    auto_vacuum: 2,
    journal_mode: "wal",
    synchronous: 1,
    foreign_keys: 1,
    temp_store: 2,
    cache_size: -16000,
    journal_size_limit: 67108864,
  });
  assert.deepEqual(stats.pragmaMismatches, []);
  assert.equal(stats.dbBytes, stats.pageCount * stats.pageSize);
  for (const table of EXPECTED_TABLES) {
    const key = table.replace(/_([a-z0-9])/g, (match, letter) => letter.toUpperCase());
    assert.equal(stats.rows[key], table === "schema_meta" ? 3 : 0, `row count for ${table}`);
  }

  readDb(file, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => row.name);
    assert.deepEqual(tables, EXPECTED_TABLES);
    assert.deepEqual(columnsOf(db, "requests").map((column) => column.name), EXPECTED_REQUEST_COLUMNS);
    const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => row.name);
    assert.deepEqual(indexes, [
      "events_at", "events_fleet", "events_type", "requests_err", "requests_fleet", "requests_ip", "requests_key",
      "requests_mgr_rid", "requests_model", "requests_owui", "requests_received", "runtime_samples_at",
    ]);
    const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(triggers, ["audit_access_log_no_delete", "audit_access_log_no_update"]);
    // The three request grains share one definition, PK included, and none has a rowid.
    const minute = columnsOf(db, "rollup_1m");
    assert.deepEqual(columnsOf(db, "rollup_1h"), minute);
    assert.deepEqual(columnsOf(db, "rollup_1d"), minute);
    assert.equal(minute.filter((column) => column.pk > 0).length, 12);
    for (const table of ["rollup_1m", "rollup_1h", "rollup_1d", "runtime_samples", "gpu_samples", "runtime_rollup_1m", "gpu_rollup_1h", "coverage_1m"]) {
      const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table).sql;
      assert.match(sql, /WITHOUT ROWID$/, `${table} is WITHOUT ROWID`);
    }
    assert.deepEqual(columnsOf(db, "runtime_samples").filter((column) => column.pk > 0).map((column) => column.name), ["at", "fleet_id", "model"]);
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM schema_meta").all().map((row) => [row.key, row.value]));
    assert.equal(meta.schemaVersion, "1");
    assert.ok(meta.createdAt && meta.lastOpenedAt);
  });
});

test("migrations run from an empty file and from v0 without losing rows, and reopen idempotently", async (t) => {
  const dir = tempDir(t);
  const emptyFile = path.join(dir, "empty.sqlite");
  fs.writeFileSync(emptyFile, "");
  const fromEmpty = await openTelemetryStore({ file: emptyFile, logger: quietLogger() });
  assert.deepEqual(fromEmpty.info.migration, { from: 0, to: 1, applied: [1] });
  await fromEmpty.close();

  // v0: a file created before the schema existed. It holds schema_meta at
  // version 0, a collector_state row and an unrelated table.
  const v0File = path.join(dir, "v0.sqlite");
  const legacy = new sqlite.DatabaseSync(v0File);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schemaVersion', '0');
    CREATE TABLE collector_state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO collector_state VALUES ('events.offsets', '{"vllm":42}', 1);
    CREATE TABLE operator_notes (id INTEGER PRIMARY KEY, note TEXT);
    INSERT INTO operator_notes (note) VALUES ('keep me');
  `);
  legacy.close();

  const store = await openTelemetryStore({ file: v0File, logger: quietLogger() });
  assert.deepEqual(store.info.migration, { from: 0, to: 1, applied: [1] });
  assert.deepEqual(await store.getState("events.offsets"), { vllm: 42 });
  const inserted = await store.insertRequests([requestRow(1)]);
  assert.equal(inserted.accepted, 1);
  await store.close();

  const again = await openTelemetryStore({ file: v0File, logger: quietLogger() });
  assert.deepEqual(again.info.migration, { from: 1, to: 1, applied: [] });
  assert.equal((await again.stats()).rows.requests, 1);
  await again.close();

  readDb(v0File, (db) => {
    assert.deepEqual(db.prepare("SELECT note FROM operator_notes").all().map((row) => row.note), ["keep me"]);
    assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get().value, "1");
  });
});

test("a database from a newer build opens without downgrading its schema version", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  await (await openTelemetryStore({ file, inProcess: true, logger: quietLogger() })).close();
  const db = new sqlite.DatabaseSync(file);
  db.exec("UPDATE schema_meta SET value = '99' WHERE key = 'schemaVersion'");
  db.close();

  const logger = quietLogger();
  const store = await openTelemetryStore({ file, logger });
  assert.equal(store.state, "ready");
  assert.equal((await store.stats()).schemaVersion, 99);
  assert.ok(logger.lines.some((line) => line.level === "warn" && /newer than this build/.test(line.message)));
  await store.close();
});

test("worker round trip and a 10k-row batch insert complete in under 1 s", async (t) => {
  const dir = tempDir(t);
  const store = await openTelemetryStore({ file: path.join(dir, "telemetry.sqlite"), logger: quietLogger() });
  cleanup(t, () => store.close());

  const roundTripStarted = performance.now();
  assert.equal(await store.getState("missing"), null);
  const roundTripMs = performance.now() - roundTripStarted;

  const rows = Array.from({ length: 10_000 }, (unused, index) => requestRow(index));
  const insertStarted = performance.now();
  const result = await store.insertRequests(rows);
  const insertMs = performance.now() - insertStarted;
  t.diagnostic(`round trip ${roundTripMs.toFixed(1)} ms; 10k-row insert ${insertMs.toFixed(1)} ms`);

  assert.deepEqual(result, { accepted: 10_000, duplicates: 0, rejected: 0, dropped: 0, errors: [] });
  assert.ok(roundTripMs < 1000, `round trip took ${roundTripMs} ms`);
  assert.ok(insertMs < 1000, `10k-row insert took ${insertMs} ms`);

  // Replays are idempotent on request_id.
  const replay = await store.insertRequests(rows.slice(0, 500));
  assert.equal(replay.accepted, 0);
  assert.equal(replay.duplicates, 500);
  const stats = await store.stats();
  assert.equal(stats.rows.requests, 10_000);
  assert.deepEqual(stats.writes.requests, { accepted: 10_000, duplicates: 500, rejected: 0, dropped: 0 });
});

test("rows are normalised, validated and capped before the INSERT", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });

  const snake = {
    request_id: requestId(2, "mgr_"), ingress: "direct", received_at: new Date(NOW).toISOString(), ended_at: NOW + 5,
    protocol: "openai", op: "models", method: "GET", path: "/serve/v1/models?api_key=should-not-stay",
    status: "200", terminal_state: "completed", error_class: "none", duration_ms: 5, stream: false,
  };
  const result = await store.insertRequests([
    requestRow(1, { extra: { routeReason: "x".repeat(4000) } }),
    snake,
    requestRow(3, { terminalState: "exploded" }),
    requestRow(4, { status: undefined }),
    requestRow(5, { durationMs: "not a number" }),
    "not a row",
  ]);
  assert.equal(result.accepted, 2);
  assert.equal(result.rejected, 4);
  assert.deepEqual(result.errors, [
    { index: 2, code: "invalid_value", field: "terminal_state" },
    { index: 3, code: "missing_field", field: "status" },
    { index: 4, code: "invalid_value", field: "duration_ms" },
    { index: 5, code: "invalid_row" },
  ]);
  await assert.rejects(store.insertRequests({ not: "an array" }), (error) => error instanceof TelemetryStoreError && error.code === "invalid_rows");
  await store.close();

  readDb(file, (db) => {
    const rows = db.prepare("SELECT request_id, received_at, path, stream, status, source_program, extra, usage_source FROM requests ORDER BY id").all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].extra, null, "oversized extra JSON is dropped, not truncated");
    assert.equal(rows[0].stream, 1);
    assert.deepEqual({ ...rows[1] }, {
      request_id: requestId(2, "mgr_"),
      received_at: NOW,
      path: "/serve/v1/models",
      stream: 0,
      status: 200,
      source_program: "unknown",
      extra: null,
      usage_source: null,
    });
  });
});

test("samples and events insert idempotently, and event payloads are redacted", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  const fakeKey = ["sk", "fake0test0key0for0telemetry"].join("-");

  const runtime = {
    at: NOW, fleetId: "llama:inst-2", model: "demo-model", managerId: "llama", engineId: "llamacpp",
    runtimeKey: "llamacpp@b0000|lch_test", intervalMs: 10_000, scrapeOk: true, dOutputTokens: 400, outputTps: 40,
    hist: { ttft: { le: [100, 500, "+Inf"], d: [1, 2, 3] } },
  };
  assert.equal((await store.insertRuntimeSamples([runtime, runtime])).duplicates, 1);
  const gpu = { at: NOW, gpuIndex: 0, name: "Test GPU", utilPct: 87.5, memUsedMb: 1000, powerW: 300, procs: null };
  assert.deepEqual(
    await store.insertGpuSamples([gpu, { ...gpu, at: NOW + 10_000 }, gpu]),
    { accepted: 2, duplicates: 1, rejected: 0, dropped: 0, errors: [] },
  );
  const events = await store.insertEvents([
    { type: "launch.failed", severity: "critical", source: "vllm", title: `Launch failed with --api-key ${fakeKey}`, data: { message: `Authorization: Bearer ${fakeKey}` }, dedupeKey: "launch:lch_1:failed" },
    { type: "launch.failed", severity: "critical", source: "vllm", title: "duplicate", dedupeKey: "launch:lch_1:failed" },
    { type: "alert.firing", severity: "loud", source: "telemetry", title: "bad severity" },
    { type: "telemetry.degraded", source: "telemetry", title: "Collector degraded", data: { blob: "y".repeat(20_000) } },
  ]);
  assert.equal(events.accepted, 2);
  assert.equal(events.duplicates, 1);
  assert.deepEqual(events.errors, [{ index: 2, code: "invalid_value", field: "severity" }]);
  await store.close();

  readDb(file, (db) => {
    const sample = db.prepare("SELECT scrape_ok, reset, idle, d_output_tokens, hist FROM runtime_samples").get();
    assert.deepEqual({ ...sample, hist: JSON.parse(sample.hist) }, {
      scrape_ok: 1, reset: 0, idle: 0, d_output_tokens: 400, hist: runtime.hist,
    });
    const stored = db.prepare("SELECT at, severity, title, data FROM events ORDER BY id").all();
    assert.equal(stored.length, 2);
    assert.ok(stored[0].at > 0, "a missing event time defaults to now");
    for (const row of stored) {
      assert.equal(`${row.title}${row.data}`.includes(fakeKey), false, "secret survived in the store");
    }
    assert.match(stored[0].title, /<redacted>/);
    assert.equal(stored[1].severity, "info");
    assert.deepEqual(JSON.parse(stored[1].data), { _truncated: true });
  });
});

test("audit_access_log is hash-chained and its triggers reject UPDATE and DELETE", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  const first = await store.appendAuditAccess({
    at: NOW, source: "entry", actor: "session:abcd1234", session: "0123456789ab", clientIp: "198.51.100.7",
    userAgent: "test-agent/1.0", action: "search", outcome: "ok", detail: { querySha256: "f".repeat(64), queryLength: 5 },
  });
  const second = await store.appendAuditAccess({ at: NOW + 1, source: "vllm", actor: "legacy-local", action: "list_exports", outcome: "denied" });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  await assert.rejects(store.appendAuditAccess({ source: "entry", actor: "x", action: "login_ok", outcome: "maybe" }), { code: "invalid_value" });
  // Retention never touches the audit-of-audit log.
  assert.equal((await store.runRetention(NOW + 3650 * DAY_MS)).ok, true);
  await store.close();

  const db = new sqlite.DatabaseSync(file);
  try {
    const rows = db.prepare("SELECT * FROM audit_access_log ORDER BY seq").all();
    assert.equal(rows.length, 2);
    let previous = "0".repeat(64);
    for (const row of rows) {
      const canonical = JSON.stringify({
        at: row.at, source: row.source, actor: row.actor, session: row.session, client_ip: row.client_ip,
        user_agent: row.user_agent, action: row.action, target: row.target, outcome: row.outcome, detail: row.detail,
      });
      const expected = crypto.createHash("sha256").update(`${previous}\n${canonical}`).digest("hex");
      assert.equal(row.prev_hash, previous);
      assert.equal(row.hash, expected);
      previous = row.hash;
    }
    assert.equal(rows[0].hash, first.hash);
    assert.equal(rows[1].hash, second.hash);
    assert.throws(() => db.exec("UPDATE audit_access_log SET outcome = 'ok' WHERE seq = 2"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM audit_access_log WHERE seq = 1"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM audit_access_log"), /append-only/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_access_log").get().n, 2);
  } finally {
    db.close();
  }
});

test("retention deletes in batches, keeps forever data and masks client data after ipDays", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: quietLogger(), retention: { batchRows: 1000, yieldMs: 1 } });

  const old = Array.from({ length: 3500 }, (unused, index) => requestRow(index, { receivedAt: NOW - 31 * DAY_MS + index }));
  const recent = Array.from({ length: 20 }, (unused, index) => requestRow(10_000 + index, { receivedAt: NOW - DAY_MS }));
  const masked = [
    requestRow(20_000, { receivedAt: NOW - 10 * DAY_MS, clientIp: "192.0.2.15", owuiUserId: "u-1", owuiChatId: "c-1" }),
    requestRow(20_001, { receivedAt: NOW - 10 * DAY_MS, clientIp: "2001:db8:1:2::5" }),
    requestRow(20_002, { receivedAt: NOW - 10 * DAY_MS, clientIp: "::ffff:203.0.113.9" }),
  ];
  assert.equal((await store.insertRequests([...old, ...recent, ...masked])).accepted, 3523);
  await store.insertRuntimeSamples([
    { at: NOW - 49 * 3_600_000, fleetId: "vllm:a", managerId: "vllm", runtimeKey: "k", scrapeOk: 1 },
    { at: NOW - 3_600_000, fleetId: "vllm:a", managerId: "vllm", runtimeKey: "k", scrapeOk: 1 },
  ]);
  await store.insertGpuSamples([{ at: NOW - 49 * 3_600_000, gpuIndex: 0 }, { at: NOW - 60_000, gpuIndex: 0 }]);
  await store.insertEvents([
    { at: NOW - 401 * DAY_MS, type: "telemetry.degraded", source: "telemetry", title: "old generic" },
    { at: NOW - 401 * DAY_MS, type: "launch.ready", source: "vllm", title: "old launch" },
    { at: NOW - 401 * DAY_MS, type: "security.ban", source: "entry", title: "old ban" },
    { at: NOW - 401 * DAY_MS, type: "audit.export", source: "entry", title: "old audit" },
    { at: NOW - 91 * DAY_MS, type: "mcp.tool_call", source: "mcp", title: "old tool call" },
    { at: NOW - 60 * DAY_MS, type: "mcp.tool_call", source: "mcp", title: "recent tool call" },
  ]);
  await store.close();

  // Rollup rows are written directly: the rollup job ships in TEL-10.
  const db = new sqlite.DatabaseSync(file);
  const rollup = db.prepare(`INSERT INTO rollup_1m (bucket, requests, completed, client_aborts, streams, prompt_tokens, cached_tokens,
    output_tokens, estimated_usage, finish_length, finish_tool, duration_ms_sum, ttft_ms_sum, ttft_n, decode_tps_sum, decode_tps_n)
    VALUES (?, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`);
  rollup.run(NOW - 15 * DAY_MS);
  rollup.run(NOW - 13 * DAY_MS);
  db.prepare(`INSERT INTO rollup_1d (bucket, requests, completed, client_aborts, streams, prompt_tokens, cached_tokens,
    output_tokens, estimated_usage, finish_length, finish_tool, duration_ms_sum, ttft_ms_sum, ttft_n, decode_tps_sum, decode_tps_n)
    VALUES (?, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`).run(NOW - 5000 * DAY_MS);
  db.prepare("INSERT INTO coverage_1m (bucket, component) VALUES (?, 'recorder'), (?, 'recorder')").run(NOW - 20 * DAY_MS, NOW);
  db.close();

  const reopened = await openTelemetryStore({ file, inProcess: true, logger: quietLogger(), retention: { batchRows: 1000, yieldMs: 1 } });
  cleanup(t, () => reopened.close());
  const result = await reopened.runRetention(NOW, { ipDays: 7 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleted, {
    requests: 3500,
    runtime_samples: 1,
    gpu_samples: 1,
    rollup_1m: 1,
    coverage_1m: 1,
    events: 2,
  });
  assert.equal(result.batches.requests, 4, "3500 rows in batches of 1000");
  assert.equal(result.masked, 3);
  assert.equal(result.ttl.ipDays, 7);
  assert.equal(result.ttl.requestsDays, 30);
  assert.equal(result.optimized, true);

  const stats = await reopened.stats();
  assert.equal(stats.rows.requests, 23);
  assert.equal(stats.rows.rollup1d, 1, "daily rollups are kept forever");
  assert.equal(stats.retention.lastRunAt, NOW);
  assert.equal(stats.retention.maskedThrough, NOW - 7 * DAY_MS);

  readDb(file, (check) => {
    const titles = check.prepare("SELECT title FROM events ORDER BY id").all().map((row) => row.title);
    assert.deepEqual(titles, ["old launch", "old ban", "old audit", "recent tool call"]);
    const privacy = check.prepare("SELECT client_ip, user_agent, owui_user_id, owui_chat_id FROM requests WHERE received_at = ? ORDER BY id")
      .all(NOW - 10 * DAY_MS).map((row) => ({ ...row }));
    assert.deepEqual(privacy, [
      { client_ip: "192.0.2.x", user_agent: null, owui_user_id: null, owui_chat_id: null },
      { client_ip: "2001:db8:…", user_agent: null, owui_user_id: null, owui_chat_id: null },
      { client_ip: "203.0.113.x", user_agent: null, owui_user_id: null, owui_chat_id: null },
    ]);
    const fresh = check.prepare("SELECT client_ip, user_agent FROM requests WHERE received_at = ? LIMIT 1").get(NOW - DAY_MS);
    assert.deepEqual({ ...fresh }, { client_ip: "192.0.2.10", user_agent: "test-agent/1.0" });
  });

  // A second pass finds nothing new and does not optimize again the same day.
  const second = await reopened.runRetention(NOW + 60_000, { ipDays: 7 });
  assert.deepEqual(second.deleted, {});
  assert.equal(second.masked, 0);
  assert.equal(second.optimized, false);
});

test("retention yields between batches so queued writes run in between", async (t) => {
  const dir = tempDir(t);
  const store = await openTelemetryStore({
    file: path.join(dir, "telemetry.sqlite"),
    logger: quietLogger(),
    retention: { batchRows: 500, yieldMs: 25 },
  });
  cleanup(t, () => store.close());
  const old = Array.from({ length: 2000 }, (unused, index) => requestRow(index, { receivedAt: NOW - 40 * DAY_MS + index }));
  await store.insertRequests(old);

  const order = [];
  const retention = store.runRetention(NOW).then((result) => { order.push("retention"); return result; });
  const insert = store.insertEvents([{ type: "telemetry.test", source: "telemetry", title: "queued write" }])
    .then((result) => { order.push("insert"); return result; });
  const [retentionResult, insertResult] = await Promise.all([retention, insert]);
  assert.deepEqual(order, ["insert", "retention"]);
  assert.equal(insertResult.accepted, 1);
  assert.equal(retentionResult.deleted.requests, 2000);
  assert.equal(retentionResult.batches.requests, 4);
  // A pass that is still yielding refuses a second, overlapping pass.
  await store.insertRequests(old.map((row, index) => ({ ...row, requestId: requestId(50_000 + index) })));
  const concurrent = await Promise.all([store.runRetention(NOW), store.runRetention(NOW)]);
  assert.equal(concurrent[0].deleted.requests, 2000);
  assert.deepEqual(concurrent[1], { ok: false, skipped: true, reason: "retention_running" });
});

async function assertDegraded(store, logger) {
  assert.equal(store.state, "unavailable");
  const insert = await store.insertRequests([requestRow(1), requestRow(2)]);
  assert.deepEqual(insert, { accepted: 0, duplicates: 0, rejected: 0, dropped: 2, errors: [], error: "telemetry_store_unavailable" });
  assert.equal((await store.insertEvents([{ type: "x.y", source: "entry", title: "t" }])).dropped, 1);
  assert.deepEqual(await store.setState("rollup.1m", { watermark: 1 }), { ok: false, dropped: true });
  assert.equal(await store.getState("rollup.1m"), null);
  assert.deepEqual(await store.runRetention(NOW), { ok: false, skipped: true, reason: "store_unavailable" });
  assert.deepEqual(await store.runRollups(NOW), { ok: false, skipped: true, reason: "store_unavailable" });
  await assert.rejects(store.call("summary", {}), { code: "telemetry_store_unavailable" });
  await assert.rejects(store.appendAuditAccess({ source: "entry", actor: "x", action: "verify", outcome: "ok" }), { code: "telemetry_store_unavailable" });
  const stats = await store.stats();
  assert.equal(stats.ok, false);
  assert.equal(stats.store, "unavailable");
  assert.deepEqual(stats.degraded, ["store_unavailable"]);
  assert.equal(stats.error.code, "telemetry_store_unavailable");
  assert.deepEqual(stats.dropped, { requests: 2, runtimeSamples: 0, gpuSamples: 0, events: 1, state: 1 });
  assert.ok(logger.lines.some((line) => line.level === "error" && /Telemetry store unavailable/.test(line.message)));
  assert.deepEqual(await store.close(), { ok: true, timedOut: false });
  await assert.rejects(store.insertRequests([]), { code: "telemetry_store_closed" });
  return stats;
}

test("degraded mode when the database path is not writable", async (t) => {
  const dir = tempDir(t);
  // The parent "folder" is a regular file, so the database cannot be created.
  const blocker = path.join(dir, "not-a-folder");
  fs.writeFileSync(blocker, "x");
  for (const inProcess of [false, true]) {
    const logger = quietLogger();
    const store = await openTelemetryStore({ file: path.join(blocker, "telemetry.sqlite"), inProcess, logger });
    const stats = await assertDegraded(store, logger);
    assert.equal(stats.mode, inProcess ? "in-process" : "worker");
    assert.equal(stats.error.cause, "telemetry_store_cannot_open");
  }
  assert.equal(fs.readFileSync(blocker, "utf8"), "x");
});

test("degraded mode on a read-only or corrupt file leaves the file untouched", async (t) => {
  const dir = tempDir(t);
  const corrupt = path.join(dir, "corrupt.sqlite");
  fs.writeFileSync(corrupt, "this file is not a database ".repeat(64));
  const corruptHash = sha256File(corrupt);
  const corruptLogger = quietLogger();
  const corruptStats = await assertDegraded(await openTelemetryStore({ file: corrupt, logger: corruptLogger }), corruptLogger);
  assert.equal(corruptStats.error.cause, "telemetry_store_corrupt");
  assert.equal(sha256File(corrupt), corruptHash, "a corrupt file is never rewritten or recreated");

  const readOnly = path.join(dir, "readonly.sqlite");
  await (await openTelemetryStore({ file: readOnly, inProcess: true, logger: quietLogger() })).close();
  fs.chmodSync(readOnly, 0o444);
  cleanup(t, () => fs.chmodSync(readOnly, 0o666));
  let writable = true;
  try { fs.accessSync(readOnly, fs.constants.W_OK); } catch { writable = false; }
  if (writable) {
    t.diagnostic("read-only attribute not enforced for this user; skipping the read-only case");
    return;
  }
  const readOnlyHash = sha256File(readOnly);
  const logger = quietLogger();
  const stats = await assertDegraded(await openTelemetryStore({ file: readOnly, logger }), logger);
  assert.equal(stats.error.cause, "telemetry_store_readonly");
  assert.equal(sha256File(readOnly), readOnlyHash);
});

test("synchronous SQLite never runs on the main thread except with inProcess", async (t) => {
  const dir = tempDir(t);
  const Original = sqlite.DatabaseSync;
  let mainThreadHandles = 0;
  sqlite.DatabaseSync = class CountingDatabaseSync extends Original {
    constructor(...args) {
      mainThreadHandles += 1;
      super(...args);
    }
  };
  t.after(() => { sqlite.DatabaseSync = Original; });

  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  await store.insertRequests([requestRow(1)]);
  await store.insertRuntimeSamples([{ at: NOW, fleetId: "vllm:a", managerId: "vllm", runtimeKey: "k", scrapeOk: 1 }]);
  await store.insertGpuSamples([{ at: NOW, gpuIndex: 0 }]);
  await store.insertEvents([{ type: "x.y", source: "entry", title: "t" }]);
  await store.appendAuditAccess({ source: "entry", actor: "system:cli", action: "verify", outcome: "ok" });
  await store.setState("a", 1);
  await store.getState("a");
  await store.runRetention(NOW);
  await store.runRollups(NOW);
  await assert.rejects(store.call("definitelyNotAQuery"), { code: "unknown_query" });
  const workerStats = await store.stats();
  await store.close();
  assert.equal(workerStats.thread, "worker");
  assert.equal(mainThreadHandles, 0, "the worker store opened a SQLite handle on the main thread");

  // The spy is live: inProcess is the one mode that opens SQLite here.
  const inProcess = await openTelemetryStore({ file, inProcess: true, logger: quietLogger() });
  assert.equal((await inProcess.stats()).thread, "main");
  await inProcess.close();
  assert.equal(mainThreadHandles, 1);

  // The core itself refuses to open on the main thread without the flag.
  assert.throws(() => storeWorker.createStoreCore({ file }), { code: "telemetry_main_thread" });
  assert.equal(mainThreadHandles, 1);
});

test("call() dispatches named queries inside the worker", async (t) => {
  const dir = tempDir(t);
  const queryModule = path.join(dir, "fixture-queries.js");
  fs.writeFileSync(queryModule, [
    '"use strict";',
    "exports.countRequests = (db, params) => db.prepare('SELECT COUNT(*) AS n FROM requests WHERE received_at >= ?').get(params.from).n;",
    "exports.whereAmI = () => (require('node:worker_threads').isMainThread ? 'main' : 'worker');",
    "exports.LIMIT = 5;",
    "",
  ].join("\n"));
  const store = await openTelemetryStore({ file: path.join(dir, "telemetry.sqlite"), queryModule, logger: quietLogger() });
  cleanup(t, () => store.close());
  await store.insertRequests([requestRow(1), requestRow(2, { receivedAt: NOW - DAY_MS })]);
  assert.equal(await store.call("countRequests", { from: NOW - 60 * 60_000 }), 1);
  assert.equal(await store.call("whereAmI"), "worker");
  for (const name of ["LIMIT", "constructor", "toString", "__proto__", "count Requests", 42]) {
    await assert.rejects(store.call(name, {}), { code: "unknown_query" }, String(name));
  }
});

test("state round trip, flush on close and closed-store errors", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  assert.deepEqual(await store.setState("rollup.1m", { watermark: NOW, dirty: [1, 2] }), { ok: true });
  assert.deepEqual(await store.getState("rollup.1m"), { watermark: NOW, dirty: [1, 2] });
  await assert.rejects(store.setState("", 1), { code: "invalid_state_name" });
  await assert.rejects(store.insertRequests([{ requestId: requestId(1), callback() {} }]), { code: "invalid_argument" });

  const pendingWrite = store.insertRequests(Array.from({ length: 2000 }, (unused, index) => requestRow(index)));
  const closed = await store.close();
  assert.deepEqual(closed, { ok: true, timedOut: false });
  assert.equal((await pendingWrite).accepted, 2000, "close() lets a queued write finish");
  await assert.rejects(store.getState("rollup.1m"), (error) => error instanceof TelemetryStoreError && error.code === "telemetry_store_closed");
  assert.deepEqual(await store.close(), { ok: true, timedOut: false });
  readDb(file, (db) => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requests").get().n, 2000));
});

test("a crashed worker restarts with backoff and calls in between are retryable", async (t) => {
  const dir = tempDir(t);
  const logger = quietLogger();
  const store = await openTelemetryStore({ file: path.join(dir, "telemetry.sqlite"), logger, restartMinMs: 50, restartMaxMs: 200 });
  cleanup(t, () => store.close());
  assert.equal((await store.insertRequests([requestRow(1)])).accepted, 1);

  await store[STORE_WORKER]().terminate();
  await waitFor(() => store.state !== "ready" || store[STORE_WORKER]() === null);
  const during = await store.insertRequests([requestRow(2)]).then(() => null, (error) => error);
  if (during) {
    assert.equal(during.retryable, true);
    assert.ok(["telemetry_store_restarting", "telemetry_store_crashed"].includes(during.code), during.code);
  }

  await waitFor(() => store.state === "ready" && store[STORE_WORKER]() !== null);
  assert.equal((await store.insertRequests([requestRow(3)])).accepted, 1);
  const stats = await store.stats();
  assert.equal(stats.restarts, 1);
  assert.equal(stats.rows.requests, during ? 2 : 3);
  assert.ok(logger.lines.some((line) => /restarting in 50 ms/.test(line.message)));
});

test("the backup snapshots the telemetry database with VACUUM INTO while the store is open", async (t) => {
  const backupScript = fs.readFileSync(path.join(REPO_ROOT, "scripts", "backup-platform.ps1"), "utf8");
  assert.match(backupScript, /Add-File \$telemetryDb 'service-entry\\data\\telemetry\.sqlite' 'sqlite'/);
  assert.match(backupScript, /'service-entry\\data\\telemetry\.sqlite'/);

  const dir = tempDir(t);
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, logger: quietLogger() });
  cleanup(t, () => store.close());
  await store.insertRequests(Array.from({ length: 50 }, (unused, index) => requestRow(index)));
  await store.appendAuditAccess({ source: "entry", actor: "system:cli", action: "verify", outcome: "ok" });

  const snapshot = path.join(dir, "backup", "telemetry.sqlite");
  execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "sqlite-snapshot.js"), file, snapshot], { stdio: "pipe" });
  readDb(snapshot, (db) => {
    assert.equal(Object.values(db.prepare("PRAGMA integrity_check").get())[0], "ok");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM requests").get().n, 50);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_access_log").get().n, 1);
  });
});

test("store-worker helpers: TTL clamping, IP masking and the audit hash", () => {
  assert.deepEqual(storeWorker.normalizeTtl({}), { ...schema.TTL_DEFAULTS });
  assert.deepEqual(storeWorker.normalizeTtl({ requestsDays: 1, ipDays: 400, samplesHours: "x", eventsDays: 90.7 }), {
    ...schema.TTL_DEFAULTS, requestsDays: 7, ipDays: 7, eventsDays: 90,
  });
  assert.equal(storeWorker.maskClientIp("192.0.2.200"), "192.0.2.x");
  assert.equal(storeWorker.maskClientIp("192.0.2.x"), "192.0.2.x");
  assert.equal(storeWorker.maskClientIp("2001:db8::1"), "2001:db8:…");
  assert.equal(storeWorker.maskClientIp("unknown"), "…");
  const row = { at: 1, source: "entry", actor: "a", action: "verify", outcome: "ok" };
  assert.equal(
    storeWorker.auditCanonicalJson(row),
    '{"at":1,"source":"entry","actor":"a","session":null,"client_ip":null,"user_agent":null,"action":"verify","target":null,"outcome":"ok","detail":null}',
  );
  assert.equal(storeWorker.auditChainHash(storeWorker.GENESIS_HASH, row).length, 64);
});
