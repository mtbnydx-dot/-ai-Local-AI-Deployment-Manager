"use strict";

// Telemetry store schema (docs/overhaul/04-telemetry.md §4). Pure data: the
// worker in store-worker.js applies the PRAGMAs and runs MIGRATIONS at open.
//
// Rules for later migrations: append a new { version, up } entry, never edit
// a released one, and never drop a column or table that holds data. Every
// statement in v1 uses IF NOT EXISTS, so a v0 file (a database created before
// the schema existed, possibly holding a few of these tables already) migrates
// in place without losing rows.

const SCHEMA_VERSION = 1;

// Applied on every open, in this order. auto_vacuum only takes effect while
// the file has no tables yet, which is why it runs before the migrations;
// an older file keeps its mode and stats() reports the mismatch. `expect` is
// what the PRAGMA reads back when it took effect.
const PRAGMAS = Object.freeze([
  Object.freeze({ name: "busy_timeout", value: "5000", expect: 5000 }),
  Object.freeze({ name: "auto_vacuum", value: "INCREMENTAL", expect: 2 }),
  Object.freeze({ name: "journal_mode", value: "WAL", expect: "wal" }),
  Object.freeze({ name: "synchronous", value: "NORMAL", expect: 1 }),
  Object.freeze({ name: "foreign_keys", value: "ON", expect: 1 }),
  Object.freeze({ name: "temp_store", value: "MEMORY", expect: 2 }),
  Object.freeze({ name: "cache_size", value: "-16000", expect: -16000 }),
  Object.freeze({ name: "journal_size_limit", value: "67108864", expect: 67108864 }),
]);

// §4.3 defaults; platform.json telemetry.retention.* overrides them (§20).
const TTL_DEFAULTS = Object.freeze({
  requestsDays: 30,
  ipDays: 30,
  samplesHours: 48,
  minuteDays: 14,
  hourDays: 400,
  eventsDays: 400,
});

// Bounds the retention job clamps to. OPS-3's config validator rejects values
// outside the documented ranges; these keep a bad call from wiping the store.
const TTL_LIMITS = Object.freeze({
  requestsDays: Object.freeze([7, 365]),
  ipDays: Object.freeze([1, 365]),
  samplesHours: Object.freeze([12, 336]),
  minuteDays: Object.freeze([1, 365]),
  hourDays: Object.freeze([1, 3650]),
  eventsDays: Object.freeze([1, 3650]),
});

// Tables pruned by age (§4.3). `*_1d`, audit_access_log, lifetime_baseline
// and import_runs are kept forever and are deliberately absent.
const RETENTION_TARGETS = Object.freeze([
  Object.freeze({ table: "requests", column: "received_at", ttl: "requestsDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "runtime_samples", column: "at", ttl: "samplesHours", unitMs: 3_600_000 }),
  Object.freeze({ table: "gpu_samples", column: "at", ttl: "samplesHours", unitMs: 3_600_000 }),
  Object.freeze({ table: "rollup_1m", column: "bucket", ttl: "minuteDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "runtime_rollup_1m", column: "bucket", ttl: "minuteDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "gpu_rollup_1m", column: "bucket", ttl: "minuteDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "control_counts_1m", column: "bucket", ttl: "minuteDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "coverage_1m", column: "bucket", ttl: "minuteDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "rollup_1h", column: "bucket", ttl: "hourDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "runtime_rollup_1h", column: "bucket", ttl: "hourDays", unitMs: 86_400_000 }),
  Object.freeze({ table: "gpu_rollup_1h", column: "bucket", ttl: "hourDays", unitMs: 86_400_000 }),
]);

// Event types outside the eventsDays TTL (§4.3).
const EVENT_RETENTION = Object.freeze({
  foreverPrefixes: Object.freeze(["launch.", "instance.", "container.", "manager.", "audit.", "config."]),
  foreverTypes: Object.freeze(["security.ban"]),
  fixedDays: Object.freeze({ "mcp.tool_call": 90 }),
});

// CHECK-constrained columns of the tables the store inserts into. The worker
// validates them before the INSERT so a bad row is reported, not ignored.
const ENUMS = Object.freeze({
  requests: Object.freeze({
    terminal_state: Object.freeze(["completed", "failed", "client_abort", "timeout", "rejected"]),
    usage_source: Object.freeze(["reported", "estimated", "missing"]),
  }),
  events: Object.freeze({ severity: Object.freeze(["info", "warning", "critical"]) }),
  audit_access_log: Object.freeze({ outcome: Object.freeze(["ok", "denied", "error"]) }),
});

// Text caps per column (characters; JSON columns in UTF-8 bytes). Columns not
// listed are capped at DEFAULT_TEXT_LIMIT. `oversize` says what an oversized
// JSON value becomes: null, or a small marker object.
const DEFAULT_TEXT_LIMIT = 512;
const TEXT_LIMITS = Object.freeze({
  requests: Object.freeze({ path: 200, request_id: 128, client_request_id: 128, manager_request_id: 128 }),
  events: Object.freeze({ title: 512 }),
  audit_access_log: Object.freeze({ target: 512 }),
});
const JSON_COLUMNS = Object.freeze({
  requests: Object.freeze({ extra: Object.freeze({ maxBytes: 2048, oversize: null }) }),
  runtime_samples: Object.freeze({ hist: Object.freeze({ maxBytes: 32768, oversize: null }) }),
  gpu_samples: Object.freeze({ procs: Object.freeze({ maxBytes: 8192, oversize: null }) }),
  events: Object.freeze({ data: Object.freeze({ maxBytes: 16384, oversize: { _truncated: true } }) }),
  audit_access_log: Object.freeze({ detail: Object.freeze({ maxBytes: 4096, oversize: { _truncated: true } }) }),
});

// rollup_1h and rollup_1d repeat the rollup_1m DDL verbatim (§4.2), so the
// three grains are generated from one definition. CREATE TABLE … AS SELECT
// would drop the primary key.
function requestRollupTable(name) {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  bucket INTEGER NOT NULL,
  manager_id TEXT NOT NULL DEFAULT '', fleet_id TEXT NOT NULL DEFAULT '', engine_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', key_id TEXT NOT NULL DEFAULT '', customer_id TEXT NOT NULL DEFAULT '',
  source_program TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT '',
  status_class TEXT NOT NULL DEFAULT '', error_class TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL, completed INTEGER NOT NULL, client_aborts INTEGER NOT NULL, streams INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, estimated_usage INTEGER NOT NULL,
  finish_length INTEGER NOT NULL, finish_tool INTEGER NOT NULL,
  duration_ms_sum INTEGER NOT NULL, ttft_ms_sum INTEGER NOT NULL, ttft_n INTEGER NOT NULL,
  decode_tps_sum REAL NOT NULL, decode_tps_n INTEGER NOT NULL,
  ttft_hist TEXT, duration_hist TEXT, decode_hist TEXT,
  source TEXT NOT NULL DEFAULT 'live',
  PRIMARY KEY (bucket, manager_id, fleet_id, engine_id, model, key_id, customer_id, source_program, protocol, status_class, error_class, source)
) WITHOUT ROWID;`;
}

// §4.2 describes the runtime rollups in a comment only. Columns: the
// (bucket, fleet_id, model) key; the last seen manager and engine (for
// filters without a join); counters; sums of every d_* column; avg and max
// of the gauges; ratios and p50/p95/p99 recomputed from the sums and the
// merged histogram JSON (same shape as runtime_samples.hist).
function runtimeRollupTable(name) {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  bucket INTEGER NOT NULL, fleet_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  manager_id TEXT NOT NULL DEFAULT '', engine_id TEXT,
  sample_count INTEGER NOT NULL, scrape_failures INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0,
  idle_seconds REAL NOT NULL DEFAULT 0, interval_ms_sum INTEGER NOT NULL DEFAULT 0,
  d_prompt_tokens INTEGER, d_cached_tokens INTEGER, d_output_tokens INTEGER, d_requests INTEGER,
  d_errors INTEGER, d_aborts INTEGER, d_finish_length INTEGER,
  d_spec_draft_tokens INTEGER, d_spec_accepted_tokens INTEGER,
  running_avg REAL, running_max REAL, waiting_avg REAL, waiting_max REAL,
  kv_usage_avg REAL, kv_usage_max REAL, kv_capacity_tokens INTEGER,
  prefix_hit_rate REAL, spec_accept_rate REAL,
  ttft_p50_ms REAL, ttft_p95_ms REAL, ttft_p99_ms REAL,
  e2e_p50_ms REAL, e2e_p95_ms REAL, e2e_p99_ms REAL,
  itl_p50_ms REAL, itl_p95_ms REAL, itl_p99_ms REAL,
  tpot_p50_ms REAL, tpot_p95_ms REAL, tpot_p99_ms REAL,
  queue_p50_ms REAL, queue_p95_ms REAL, queue_p99_ms REAL,
  latency_source TEXT, hist TEXT, energy_wh REAL,
  PRIMARY KEY (bucket, fleet_id, model)
) WITHOUT ROWID;`;
}

// §4.2 comment: util avg and max, mem_used max, temp avg and max, power avg
// and max, energy sums and throttle seconds per decoded reason.
function gpuRollupTable(name) {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  bucket INTEGER NOT NULL, gpu_index INTEGER NOT NULL, gpu_uuid TEXT, name TEXT,
  sample_count INTEGER NOT NULL,
  util_pct_avg REAL, util_pct_max REAL, mem_used_mb_max REAL, mem_total_mb REAL,
  temp_c_avg REAL, temp_c_max REAL, power_w_avg REAL, power_w_max REAL,
  energy_wh REAL NOT NULL DEFAULT 0, idle_energy_wh REAL NOT NULL DEFAULT 0,
  throttle_seconds TEXT,
  PRIMARY KEY (bucket, gpu_index)
) WITHOUT ROWID;`;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collector_state (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coverage_1m (bucket INTEGER NOT NULL, component TEXT NOT NULL, PRIMARY KEY (bucket, component)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  client_request_id TEXT,
  manager_request_id TEXT,
  ingress TEXT NOT NULL,
  received_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  manager_id TEXT, fleet_id TEXT, engine_id TEXT, runtime_id TEXT, launch_id TEXT,
  protocol TEXT NOT NULL,
  op TEXT NOT NULL,
  route TEXT,
  method TEXT NOT NULL, path TEXT NOT NULL,
  model_requested TEXT, model_resolved TEXT, stream INTEGER NOT NULL DEFAULT 0,
  key_id TEXT, customer_id TEXT, auth_source TEXT,
  client_ip TEXT, client_country TEXT, user_agent TEXT, origin_host TEXT,
  source_program TEXT NOT NULL DEFAULT 'unknown',
  owui_user_id TEXT, owui_chat_id TEXT,
  status INTEGER NOT NULL,
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed','failed','client_abort','timeout','rejected')),
  error_class TEXT NOT NULL,
  error_code TEXT,
  queue_ms INTEGER, upstream_headers_ms INTEGER, ttft_ms INTEGER, duration_ms INTEGER NOT NULL,
  decode_tps REAL,
  prompt_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  usage_source TEXT CHECK (usage_source IN ('reported','estimated','missing')),
  finish_reason TEXT,
  bytes_out INTEGER,
  engine_prompt_ms REAL, engine_decode_tps REAL, engine_cached_tokens INTEGER,
  extra TEXT
);
CREATE INDEX IF NOT EXISTS requests_received ON requests(received_at);
CREATE INDEX IF NOT EXISTS requests_key ON requests(key_id, received_at);
CREATE INDEX IF NOT EXISTS requests_fleet ON requests(fleet_id, received_at);
CREATE INDEX IF NOT EXISTS requests_model ON requests(model_resolved, received_at);
CREATE INDEX IF NOT EXISTS requests_err ON requests(error_class, received_at) WHERE error_class <> 'none';
CREATE INDEX IF NOT EXISTS requests_ip ON requests(client_ip, received_at) WHERE client_ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_mgr_rid ON requests(manager_request_id) WHERE manager_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_owui ON requests(owui_chat_id) WHERE owui_chat_id IS NOT NULL;
${requestRollupTable("rollup_1m")}
${requestRollupTable("rollup_1h")}
${requestRollupTable("rollup_1d")}
CREATE TABLE IF NOT EXISTS control_counts_1m (bucket INTEGER NOT NULL, route TEXT NOT NULL, status_class TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (bucket, route, status_class)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rollup_dirty (grain TEXT NOT NULL, bucket INTEGER NOT NULL, PRIMARY KEY (grain, bucket)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS runtime_samples (
  at INTEGER NOT NULL, fleet_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  manager_id TEXT NOT NULL, engine_id TEXT, runtime_id TEXT, launch_id TEXT, runtime_key TEXT NOT NULL,
  interval_ms INTEGER, scrape_ok INTEGER NOT NULL, error_code TEXT, reset INTEGER NOT NULL DEFAULT 0, idle INTEGER NOT NULL DEFAULT 0,
  d_prompt_tokens INTEGER, d_cached_tokens INTEGER, d_output_tokens INTEGER, d_requests INTEGER,
  d_errors INTEGER, d_aborts INTEGER, d_finish_length INTEGER,
  prompt_tps REAL, output_tps REAL, rpm REAL,
  running REAL, waiting REAL, kv_usage REAL, kv_capacity_tokens INTEGER,
  prefix_hit_rate REAL,
  d_spec_draft_tokens INTEGER, d_spec_accepted_tokens INTEGER, spec_accept_rate REAL,
  ttft_p50_ms REAL, ttft_p95_ms REAL, ttft_p99_ms REAL, e2e_p50_ms REAL, e2e_p95_ms REAL,
  itl_p50_ms REAL, itl_p95_ms REAL, tpot_p50_ms REAL, queue_p95_ms REAL,
  latency_source TEXT,
  hist TEXT,
  energy_wh REAL,
  PRIMARY KEY (fleet_id, model, at)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS runtime_samples_at ON runtime_samples(at);
${runtimeRollupTable("runtime_rollup_1m")}
${runtimeRollupTable("runtime_rollup_1h")}
${runtimeRollupTable("runtime_rollup_1d")}

CREATE TABLE IF NOT EXISTS gpu_samples (
  at INTEGER NOT NULL, gpu_index INTEGER NOT NULL, gpu_uuid TEXT, name TEXT,
  util_pct REAL, mem_util_pct REAL, mem_used_mb REAL, mem_total_mb REAL, temp_c REAL, mem_temp_c REAL,
  power_w REAL, power_limit_w REAL, fan_pct REAL, sm_clock_mhz REAL, mem_clock_mhz REAL, sm_clock_max_mhz REAL, pstate TEXT,
  throttle_mask INTEGER, throttle TEXT,
  energy_wh REAL,
  procs TEXT,
  PRIMARY KEY (gpu_index, at)
) WITHOUT ROWID;
${gpuRollupTable("gpu_rollup_1m")}
${gpuRollupTable("gpu_rollup_1h")}
${gpuRollupTable("gpu_rollup_1d")}

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  source TEXT NOT NULL, manager_id TEXT, fleet_id TEXT, launch_id TEXT, request_id TEXT,
  title TEXT NOT NULL, data TEXT, dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_type ON events(type, at);
CREATE INDEX IF NOT EXISTS events_fleet ON events(fleet_id, at);

CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id TEXT PRIMARY KEY, builtin INTEGER NOT NULL, enabled INTEGER NOT NULL,
  metric TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '{}',
  op TEXT NOT NULL CHECK (op IN ('>','>=','<','<=')), threshold REAL NOT NULL, clear_threshold REAL,
  window_s INTEGER NOT NULL, for_s INTEGER NOT NULL, min_samples INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL, channels TEXT NOT NULL, cooldown_s INTEGER NOT NULL DEFAULT 1800,
  title_zh TEXT NOT NULL, title_en TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS alert_state (
  rule_id TEXT NOT NULL, scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok','pending','firing')),
  since INTEGER NOT NULL, last_eval_at INTEGER NOT NULL, last_value REAL,
  fired_at INTEGER, resolved_at INTEGER, last_notified_at INTEGER, fire_count INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER, acked_by TEXT, silenced_until INTEGER,
  PRIMARY KEY (rule_id, scope_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS audit_access_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  session TEXT,
  client_ip TEXT, user_agent TEXT,
  action TEXT NOT NULL,
  target TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  detail TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS audit_access_log_no_update BEFORE UPDATE ON audit_access_log BEGIN SELECT RAISE(ABORT, 'audit_access_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_access_log_no_delete BEFORE DELETE ON audit_access_log BEGIN SELECT RAISE(ABORT, 'audit_access_log is append-only'); END;

CREATE TABLE IF NOT EXISTS lifetime_baseline (manager_id TEXT NOT NULL, model TEXT NOT NULL, engine TEXT, first_seen INTEGER, last_seen INTEGER,
  prompt_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, requests INTEGER, errors INTEGER,
  source TEXT NOT NULL, imported_at INTEGER NOT NULL, PRIMARY KEY (manager_id, model, source)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS import_runs (id INTEGER PRIMARY KEY, source TEXT NOT NULL, file_key TEXT NOT NULL, started_at INTEGER NOT NULL,
  finished_at INTEGER, rows_in INTEGER, rows_written INTEGER, rows_skipped INTEGER, status TEXT NOT NULL, detail TEXT,
  UNIQUE (source, file_key));
`;

// Each migration runs inside the open transaction (store-worker.js), which
// also records schema_meta.schemaVersion.
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    up(db) {
      db.exec(SCHEMA_V1);
    },
  }),
]);

module.exports = {
  SCHEMA_VERSION,
  MIGRATIONS,
  TTL_DEFAULTS,
  TTL_LIMITS,
  PRAGMAS,
  RETENTION_TARGETS,
  EVENT_RETENTION,
  ENUMS,
  DEFAULT_TEXT_LIMIT,
  TEXT_LIMITS,
  JSON_COLUMNS,
};
