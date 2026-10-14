"use strict";

// Telemetry store core and worker entry (docs/overhaul/04-telemetry.md §2-§4).
//
// The DatabaseSync handle lives here. store.js runs this file as a
// worker_threads worker, so the gateway event loop never executes a
// synchronous SQLite call. Only unit tests load the core on the main thread,
// through openTelemetryStore({ inProcess: true }); createStoreCore refuses to
// open on the main thread without that flag.
//
// Worker protocol: the worker posts {type:"ready", ok, info|error} once, then
// answers every {type:"call", id, method, args} with {type:"result", id, ok,
// result|error}. Log lines go to the parent as {type:"log", level, message};
// the worker never writes to a log sink itself.
//
// Background jobs (§2, §10, §4.3): with `jobs.enabled` the worker itself runs
// the rollup job every 30 s and the retention job every hour, so neither
// needs a call from the gateway's event loop. They are off by default (tests
// and tools open the store without them); configureJobs() changes them live.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const schema = require("./schema");
const rollups = require("./rollups");
const { redactSecrets, redactValue } = require("../secret-redactor");
const { maskAddress } = require("../auth-failure-guard");

const WORKER_KIND = "telemetry-store";
const CORE_METHODS = Object.freeze([
  "insertRequests",
  "insertRuntimeSamples",
  "insertGpuSamples",
  "insertEvents",
  "appendAuditAccess",
  "call",
  "runRollups",
  "runRetention",
  "configureJobs",
  "getState",
  "setState",
  "stats",
  "close",
]);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// §4.3: batches of 5000 rows, 20 ms between batches, incremental_vacuum(2000)
// after each pass and PRAGMA optimize once a day. Unit tests shrink the batch.
const RETENTION_DEFAULTS = Object.freeze({
  batchRows: 5000,
  yieldMs: 20,
  vacuumPages: 2000,
  optimizeEveryMs: DAY_MS,
});
// The worker's own schedule (§2: RollupJob 30 s, RetentionJob 1 h). The first
// rollup runs soon after open to catch up after a restart; the first
// retention pass waits until one is due, but never runs during startup.
// maxDbMb, timezoneOffsetMinutes and ttl are the telemetry.* settings (§20);
// timezoneOffsetMinutes null means the host offset.
const JOB_DEFAULTS = Object.freeze({
  enabled: false,
  rollupEveryMs: 30_000,
  retentionEveryMs: HOUR_MS,
  firstRollupDelayMs: 5_000,
  firstRetentionDelayMs: 60_000,
  rollupBudgetMs: rollups.DEFAULT_BUDGET_MS,
  sampleIntervalMs: 10_000,
  maxDbMb: 2048,
  timezoneOffsetMinutes: null,
  ttl: null,
});
const JOB_TIMINGS = Object.freeze([
  "rollupEveryMs", "retentionEveryMs", "firstRollupDelayMs", "firstRetentionDelayMs", "rollupBudgetMs", "sampleIntervalMs",
]);
// §4.3 size guard: when the file outgrows telemetry.maxDbMb, raw requests
// older than this and samples older than this go first.
const SIZE_GUARD = Object.freeze({ requestsDays: 7, samplesHours: 12 });
const MAX_ROW_ERRORS = 20;
const MAX_STATE_BYTES = 256 * 1024;
const GENESIS_HASH = "0".repeat(64);
// The canonical audit row of §16.4, in hash order.
const AUDIT_HASH_FIELDS = Object.freeze([
  "at", "source", "actor", "session", "client_ip", "user_agent", "action", "target", "outcome", "detail",
]);
// Column rewrites applied before validation. The path column never keeps a
// query string (§4.2).
const COLUMN_TRANSFORMS = Object.freeze({
  requests: Object.freeze({
    path: (value) => (typeof value === "string" ? value.split("?")[0] : value),
  }),
});
// SQLite primary result codes that abort a whole batch instead of one row.
const FATAL_SQLITE_CODES = new Set([1, 5, 6, 7, 8, 10, 11, 13, 14, 26]);
// Error codes for transient failures: the rows were not written, and the
// caller may keep and resend them (busy_timeout ran out on a lock).
const RETRYABLE_CODES = new Set(["telemetry_store_busy"]);
// The requests columns cleared after ipDays (§4.3, §21). client_ip is masked,
// the others become NULL.
const MASKED_REQUEST_COLUMNS = Object.freeze(["client_ip", "user_agent", "owui_user_id", "owui_chat_id"]);
// A requests row that still holds client data. Masked addresses end in ".x"
// or "…" (maskClientIp).
const UNMASKED_REQUEST_SQL = `(user_agent IS NOT NULL OR owui_user_id IS NOT NULL OR owui_chat_id IS NOT NULL
  OR (client_ip IS NOT NULL AND client_ip NOT LIKE '%.x' AND client_ip NOT LIKE '%…'))`;
// A supplied value that cannot be stored in its column. normalizeRow rejects
// the row instead of silently storing the column default.
const INVALID = Symbol("invalidValue");
// Decimal text accepted where a number is expected ("12", "-3.5", "1e3").
const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
// Masked client addresses: "a.b.c.x" or the first two IPv6 groups and "…".
const MASKED_IP_SHAPE = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.x|[0-9a-f]{0,4}:[0-9a-f]{0,4}:…)$/i;

function storeError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function sqlitePrimaryCode(error) {
  const errcode = Number(error && error.errcode);
  return Number.isInteger(errcode) ? errcode & 0xff : null;
}

function errorCode(error) {
  const primary = sqlitePrimaryCode(error);
  if (primary === 13) return "telemetry_disk_full";
  if (primary === 5 || primary === 6) return "telemetry_store_busy";
  if (primary === 8) return "telemetry_store_readonly";
  if (primary === 11 || primary === 26) return "telemetry_store_corrupt";
  if (primary === 14) return "telemetry_store_cannot_open";
  if (primary !== null) return "telemetry_store_error";
  if (error && error.syscall) return "telemetry_store_cannot_open";
  const code = error && typeof error.code === "string" ? error.code : "";
  if (/^[a-z][a-z0-9_]*$/.test(code)) return code;
  return "telemetry_store_error";
}

function serializeError(error) {
  const cause = error && typeof error.code === "string" ? error.code : undefined;
  const output = {
    code: errorCode(error),
    message: redactSecrets(String((error && error.message) || error || "Telemetry store error")),
  };
  if (cause && cause !== output.code) output.cause = cause;
  const primary = sqlitePrimaryCode(error);
  if (primary !== null) output.sqliteCode = primary;
  if (error && error.field) output.field = error.field;
  return output;
}

function snakeToCamel(name) {
  return String(name).replace(/_([a-z0-9])/g, (match, letter) => letter.toUpperCase());
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// The number a caller supplied, or null when it supplied none. Only numbers
// and numeric text count: Number() reads null, "", false and [] as 0, which
// would turn an unset TTL key into its minimum and delete data for good.
function suppliedNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && NUMERIC_TEXT.test(value.trim())) return Number(value.trim());
  return null;
}

function toEpochMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (NUMERIC_TEXT.test(text)) return Math.round(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toReal(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

// Only time columns read date text; anywhere else V8's lenient Date.parse
// would store "status 200" as a year-200 timestamp instead of rejecting it.
function toInteger(value, isTime) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value;
  if (isTime) return toEpochMs(value);
  const number = suppliedNumber(value);
  return number === null ? null : Math.round(number);
}

function isTimeColumn(name) {
  return name === "at" || name.endsWith("_at");
}

function toText(value, maxChars) {
  if (typeof value === "string") return value.length > maxChars ? value.slice(0, maxChars) : value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

// Oversized JSON follows the column rule (dropped or replaced by a marker);
// a value JSON cannot represent (a cycle, a function) is INVALID.
function toJsonText(value, rule) {
  let text;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      text = value;
    } catch {
      text = JSON.stringify(value);
    }
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return INVALID;
    }
  }
  if (text === undefined) return INVALID;
  if (Buffer.byteLength(text, "utf8") <= rule.maxBytes) return text;
  return rule.oversize === null ? null : JSON.stringify(rule.oversize);
}

function parseDefault(text) {
  if (text === null || text === undefined) return undefined;
  const value = String(text).trim();
  if (/^'.*'$/s.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^null$/i.test(value)) return undefined;
  return undefined;
}

function columnKind(type) {
  const text = String(type || "").toUpperCase();
  if (text.includes("INT")) return "integer";
  if (/REAL|FLOA|DOUB/.test(text)) return "real";
  return "text";
}

function rowError(code, field) {
  return storeError(code, field ? `${code}: ${field}` : code, field ? { field } : {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskClientIp(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  // "[v6]:port", "[v6]" and "v4:port" lose the brackets and port first:
  // maskAddress splits on ":" and would keep "a.b.c.d:443" whole.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(text);
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
  if (bracketed) text = bracketed[1];
  else if (withPort) text = withPort[1];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped) text = mapped[1];
  const masked = maskAddress(text);
  // The retention query recognises masked values by their suffix, so
  // anything maskAddress cannot shape into a masked address (not an address
  // at all, or one with a stray port) becomes "…".
  return MASKED_IP_SHAPE.test(masked) ? masked : "…";
}

function auditCanonicalJson(row) {
  const canonical = {};
  for (const field of AUDIT_HASH_FIELDS) {
    const value = row[field];
    canonical[field] = value === undefined ? null : typeof value === "bigint" ? Number(value) : value;
  }
  return JSON.stringify(canonical);
}

// §16.4: hash = sha256(prev_hash + "\n" + canonical JSON of the stored row).
function auditChainHash(prevHash, row) {
  return crypto.createHash("sha256").update(`${prevHash}\n${auditCanonicalJson(row)}`, "utf8").digest("hex");
}

// An unset key (null, "", a config section with holes) keeps its default;
// only a supplied number is clamped to the key's range.
function normalizeTtl(ttl) {
  const input = ttl && typeof ttl === "object" ? ttl : {};
  const output = {};
  for (const [key, fallback] of Object.entries(schema.TTL_DEFAULTS)) {
    const [min, max] = schema.TTL_LIMITS[key];
    const number = suppliedNumber(input[key]);
    output[key] = number === null ? fallback : Math.min(max, Math.max(min, Math.floor(number)));
  }
  output.ipDays = Math.min(output.ipDays, output.requestsDays);
  return output;
}

// Merges a jobs patch into `previous`. Unset keys keep their value, like
// normalizeTtl. An invalid time zone offset throws invalid_timezone_offset
// when `strict` (configureJobs); at open it is logged and the previous value
// is kept, so a bad setting never takes the store down.
function normalizeJobs(input, previous, { strict = false, log = () => {} } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const output = { ...previous };
  if (typeof source.enabled === "boolean") output.enabled = source.enabled;
  for (const key of JOB_TIMINGS) {
    const number = suppliedNumber(source[key]);
    if (number !== null && number >= 0) output[key] = Math.floor(number);
  }
  // Timers below 10 ms would spin the worker.
  output.rollupEveryMs = Math.max(10, output.rollupEveryMs);
  output.retentionEveryMs = Math.max(10, output.retentionEveryMs);
  const maxDbMb = suppliedNumber(source.maxDbMb);
  if (maxDbMb !== null && maxDbMb > 0) output.maxDbMb = maxDbMb;
  if (source.ttl !== undefined && source.ttl !== null) output.ttl = normalizeTtl(source.ttl);
  if (!output.ttl) output.ttl = normalizeTtl(null);
  const hasOffset = Object.prototype.hasOwnProperty.call(source, "timezoneOffsetMinutes");
  if (hasOffset || output.timezoneOffsetMinutes === null || output.timezoneOffsetMinutes === undefined) {
    try {
      output.timezoneOffsetMinutes = rollups.normalizeTimezoneOffset(hasOffset ? source.timezoneOffsetMinutes : null);
    } catch (error) {
      if (strict) throw error;
      if (!Number.isInteger(output.timezoneOffsetMinutes)) output.timezoneOffsetMinutes = rollups.hostTimezoneOffsetMinutes();
      log("warn", `${error.message} Keeping ${output.timezoneOffsetMinutes}.`);
    }
  }
  return output;
}

function pickPositiveNumbers(input, defaults) {
  const output = { ...defaults };
  if (!input || typeof input !== "object") return output;
  for (const key of Object.keys(defaults)) {
    const number = suppliedNumber(input[key]);
    if (number !== null && number >= 0) output[key] = Math.floor(number);
  }
  output.batchRows = Math.max(1, output.batchRows);
  return output;
}

function resolveDatabaseFile(file) {
  if (typeof file !== "string" || !file.trim()) {
    throw storeError("telemetry_file_required", "The telemetry store needs a database file path.");
  }
  return file === ":memory:" ? file : path.resolve(file);
}

function optionalModule(file) {
  // A later package ships these modules; until then the store answers with a
  // clear "unavailable" instead of a crash.
  if (!fs.existsSync(file)) return null;
  return require(file);
}

function readSchemaVersion(db) {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_meta'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get();
  const version = Number.parseInt(row && row.value, 10);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function applyPragmas(db) {
  for (const pragma of schema.PRAGMAS) db.exec(`PRAGMA ${pragma.name} = ${pragma.value}`);
}

// All pending migrations and the open markers commit in one transaction. The
// lastOpenedAt write on every open doubles as the writability probe: a
// read-only file or folder fails here and the store goes degraded.
function migrate(db) {
  const from = readSchemaVersion(db);
  const pending = schema.MIGRATIONS
    .filter((migration) => migration.version > from)
    .sort((left, right) => left.version - right.version);
  const at = String(Date.now());
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) migration.up(db);
    const upsert = db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    if (pending.length) upsert.run("schemaVersion", String(pending[pending.length - 1].version));
    db.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('createdAt', ?)").run(at);
    upsert.run("lastOpenedAt", at);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { from, to: readSchemaVersion(db), applied: pending.map((migration) => migration.version) };
}

function isWithoutRowid(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table);
  return /\bWITHOUT\s+ROWID\s*;?\s*$/i.test((row && row.sql) || "");
}

function tableColumns(db, table) {
  return db.prepare('SELECT name, type, "notnull" AS required, dflt_value AS dflt, pk FROM pragma_table_info(?) ORDER BY cid')
    .all(table)
    .map((row) => ({ name: row.name, type: row.type, notnull: Number(row.required) === 1, dflt: row.dflt, pk: Number(row.pk) }));
}

// Column specs come from the live table, so a later migration that adds a
// column is picked up without touching this file. camelCase and snake_case
// keys are both accepted (camelCase wins when both are present).
function buildTableSpec(db, table, { exclude = [] } = {}) {
  const withoutRowid = isWithoutRowid(db, table);
  const all = tableColumns(db, table);
  if (!all.length) throw storeError("telemetry_schema_missing", `Telemetry table ${table} is missing.`);
  const pkCount = all.filter((column) => column.pk > 0).length;
  const enums = schema.ENUMS[table] || {};
  const limits = schema.TEXT_LIMITS[table] || {};
  const jsonColumns = schema.JSON_COLUMNS[table] || {};
  const transforms = COLUMN_TRANSFORMS[table] || {};
  const columns = all
    .filter((column) => !exclude.includes(column.name))
    .filter((column) => !(!withoutRowid && pkCount === 1 && column.pk === 1 && columnKind(column.type) === "integer"))
    .map((column) => ({
      name: column.name,
      key: snakeToCamel(column.name),
      kind: columnKind(column.type),
      time: isTimeColumn(column.name),
      required: column.notnull && (column.dflt === null || column.dflt === undefined),
      fallback: parseDefault(column.dflt),
      choices: enums[column.name] || null,
      json: jsonColumns[column.name] || null,
      maxChars: limits[column.name] || schema.DEFAULT_TEXT_LIMIT,
      transform: transforms[column.name] || null,
    }));
  const keyColumns = withoutRowid ? all.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name) : ["rowid"];
  const index = Object.fromEntries(columns.map((column, position) => [column.name, position]));
  return { table, columns, keyColumns, withoutRowid, index };
}

// null means "not supplied" (the column default applies); INVALID means a
// value was supplied but does not fit the column, e.g. stream: "yes".
function coerceColumn(column, raw) {
  if (raw === undefined || raw === null) return null;
  const value = column.transform ? column.transform(raw) : raw;
  if (value === undefined || value === null) return null;
  if (column.kind === "integer" || column.kind === "real") {
    // An empty cell (CSV or log imports) counts as absent, not as invalid.
    if (typeof value === "string" && !value.trim()) return null;
    const number = column.kind === "integer" ? toInteger(value, column.time) : toReal(value);
    return number === null ? INVALID : number;
  }
  if (column.json) return toJsonText(value, column.json);
  const text = toText(value, column.maxChars);
  return text === null ? INVALID : text;
}

function normalizeRow(spec, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw rowError("invalid_row");
  const values = new Array(spec.columns.length);
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    let raw = row[column.key];
    if (raw === undefined) raw = row[column.name];
    let value = coerceColumn(column, raw);
    if (value === INVALID) throw rowError("invalid_value", column.name);
    if (value === null && column.fallback !== undefined) value = column.fallback;
    if (value === null && column.required) {
      throw rowError(raw === undefined || raw === null ? "missing_field" : "invalid_value", column.name);
    }
    if (value !== null && column.choices && !column.choices.includes(value)) throw rowError("invalid_value", column.name);
    values[index] = value;
  }
  return values;
}

// `busy` counts rows a lock kept out; the caller was told to retry them, so
// they are not part of `dropped`.
function emptyWriteCounters() {
  return { accepted: 0, duplicates: 0, rejected: 0, dropped: 0, busy: 0 };
}

function createStoreCore(options = {}) {
  if (isMainThread && options.allowMainThread !== true) {
    throw storeError(
      "telemetry_main_thread",
      "The telemetry store runs SQLite in a worker thread; only unit tests open it in-process (inProcess: true).",
    );
  }
  const log = typeof options.log === "function" ? options.log : () => {};
  const file = resolveDatabaseFile(options.file);
  const retentionOptions = pickPositiveNumbers(options.retention, RETENTION_DEFAULTS);
  // Unit tests inject a fake clock for the job schedule; the worker always
  // uses the real one (functions cannot cross the worker boundary).
  const clock = {
    now: Date.now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    ...(options.clock && typeof options.clock === "object" ? options.clock : {}),
  };
  let jobs = normalizeJobs(options.jobs, JOB_DEFAULTS, { log });
  const queryModuleFile = options.queryModule ? path.resolve(String(options.queryModule)) : path.join(__dirname, "query.js");
  const { DatabaseSync } = require("node:sqlite");

  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  let migration;
  try {
    applyPragmas(db);
    migration = migrate(db);
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
  if (migration.from > schema.SCHEMA_VERSION) {
    log("warn", `Telemetry database schema ${migration.from} is newer than this build (${schema.SCHEMA_VERSION}); writing additively.`);
  }

  let closed = false;
  // Set by beginClose(): a yielding retention pass stops at its next batch.
  let stopping = false;
  let retentionRunning = false;
  let rollupsRunning = false;
  const jobTimers = new Map();
  const jobRuns = { rollup: null, retention: null };
  let queryModule;
  // requests rows with received_at below this are masked as they are
  // inserted. It is the cutoff of the last masking pass, and a pass moves it
  // to its new cutoff before it scans, so an import of old rows or a write
  // that lands while the pass yields is never stored with raw client data
  // past ipDays. undefined: not read from collector_state yet; null: no pass
  // ran. A second store instance on the same file may hold an older value;
  // the next pass still masks its rows (maskInsertedSince).
  let maskBeforeMs;
  let maskedOnInsert = 0;
  const loggedFailures = new Set();
  const writes = {};
  const tableSpecs = new Map();
  const statements = new Map();

  function assertOpen() {
    if (closed) throw storeError("telemetry_store_closed", "The telemetry store is closed.");
  }

  function assertRunning() {
    assertOpen();
    if (stopping) throw storeError("telemetry_store_closed", "The telemetry store is closing.");
  }

  function prepared(key, sql) {
    let statement = statements.get(key);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(key, statement);
    }
    return statement;
  }

  function specFor(table) {
    let spec = tableSpecs.get(table);
    if (!spec) {
      spec = buildTableSpec(db, table);
      const names = spec.columns.map((column) => quoteIdentifier(column.name)).join(", ");
      const placeholders = spec.columns.map(() => "?").join(", ");
      spec.insert = db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`);
      tableSpecs.set(table, spec);
    }
    return spec;
  }

  function counters(table) {
    const key = snakeToCamel(table);
    if (!writes[key]) writes[key] = emptyWriteCounters();
    return writes[key];
  }

  function logFailureOnce(context, error) {
    const code = errorCode(error);
    const key = `${context}:${code}`;
    if (loggedFailures.has(key)) return;
    loggedFailures.add(key);
    log("error", `Telemetry ${context} failed (${code}): ${redactSecrets(String((error && error.message) || error))}`);
  }

  function transaction(operation) {
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

  function maskThreshold() {
    if (maskBeforeMs === undefined) {
      const through = Number((getState("retention") || {}).maskedThrough);
      maskBeforeMs = Number.isFinite(through) ? through : null;
    }
    return maskBeforeMs;
  }

  // Masks the client columns of a normalised requests row in place when it
  // is already older than the masking cutoff. Returns true when it did.
  function maskStaleRequest(spec, values) {
    const threshold = maskThreshold();
    if (threshold === null || !(Number(values[spec.index.received_at]) < threshold)) return false;
    let changed = false;
    for (const name of MASKED_REQUEST_COLUMNS) {
      const position = spec.index[name];
      if (position === undefined || values[position] === null) continue;
      const next = name === "client_ip" ? maskClientIp(values[position]) : null;
      if (next !== values[position]) changed = true;
      values[position] = next;
    }
    return changed;
  }

  // One transaction per call. A row that fails validation or a constraint is
  // rejected alone; a disk, lock or I/O failure drops the whole batch, which
  // is counted and reported instead of thrown (§22). A lock that outlasts
  // busy_timeout is reported as retryable, so the caller keeps the rows.
  // `afterInsert(spec, valuesOfInsertedRows)` runs inside the transaction.
  function insertRows(table, rows, { prepareRow, finishRow, afterInsert } = {}) {
    assertOpen();
    if (!Array.isArray(rows)) throw rowError("invalid_rows");
    const list = rows;
    const result = { accepted: 0, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    if (!list.length) return result;
    const spec = specFor(table);
    const tally = counters(table);
    const inserted = afterInsert ? [] : null;
    let masked = 0;
    const reject = (index, error) => {
      result.rejected += 1;
      if (result.errors.length < MAX_ROW_ERRORS) {
        const entry = { index, code: error.code && /^[a-z_]+$/.test(error.code) ? error.code : "constraint_failed" };
        if (error.field) entry.field = error.field;
        result.errors.push(entry);
      }
    };
    try {
      transaction(() => {
        for (let index = 0; index < list.length; index += 1) {
          let values;
          try {
            values = normalizeRow(spec, prepareRow ? prepareRow(list[index]) : list[index]);
          } catch (error) {
            reject(index, error);
            continue;
          }
          const rewritten = finishRow ? finishRow(spec, values) : false;
          try {
            const outcome = spec.insert.run(...values);
            if (Number(outcome.changes) > 0) {
              result.accepted += 1;
              if (rewritten) masked += 1;
              if (inserted) inserted.push(values);
            } else {
              result.duplicates += 1;
            }
          } catch (error) {
            if (FATAL_SQLITE_CODES.has(sqlitePrimaryCode(error))) throw error;
            reject(index, { code: "constraint_failed" });
          }
        }
        if (inserted && inserted.length) afterInsert(spec, inserted);
      });
    } catch (error) {
      logFailureOnce(`insert into ${table}`, error);
      const code = errorCode(error);
      const dropped = list.length - result.rejected;
      const retryable = RETRYABLE_CODES.has(code);
      tally.rejected += result.rejected;
      if (retryable) tally.busy += dropped;
      else tally.dropped += dropped;
      const failed = { accepted: 0, duplicates: 0, rejected: result.rejected, dropped, errors: result.errors, error: code };
      if (retryable) failed.retryable = true;
      return failed;
    }
    tally.accepted += result.accepted;
    tally.duplicates += result.duplicates;
    tally.rejected += result.rejected;
    maskedOnInsert += masked;
    return result;
  }

  // §10 late data: rows whose minute is already rolled mark it dirty, in the
  // insert's own transaction (rollups.markLate).
  function markLateRows(family, timeColumn) {
    return (spec, list) => {
      const at = spec.index[timeColumn];
      const gpu = family === "gpu" ? spec.index.gpu_index : undefined;
      rollups.markLate(db, family, list.map((values) => ({
        at: values[at],
        gpuIndex: gpu === undefined ? undefined : values[gpu],
      })));
    };
  }

  function prepareEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return event;
    const output = { ...event };
    if (output.at === undefined || output.at === null) output.at = Date.now();
    if (typeof output.title === "string") output.title = redactSecrets(output.title);
    if (output.data !== undefined && output.data !== null) {
      output.data = typeof output.data === "string" ? redactSecrets(output.data) : redactValue(output.data);
    }
    return output;
  }

  let auditSpec;
  function appendAuditAccess(entry) {
    assertOpen();
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw rowError("invalid_row");
    if (!auditSpec) auditSpec = buildTableSpec(db, "audit_access_log", { exclude: ["seq", "prev_hash", "hash"] });
    const input = { ...entry };
    if (input.at === undefined || input.at === null) input.at = Date.now();
    if (typeof input.target === "string") input.target = redactSecrets(input.target);
    if (input.detail !== undefined && input.detail !== null) {
      input.detail = typeof input.detail === "string" ? redactSecrets(input.detail) : redactValue(input.detail);
    }
    const values = normalizeRow(auditSpec, input);
    const row = {};
    auditSpec.columns.forEach((column, index) => { row[column.name] = values[index]; });
    const names = auditSpec.columns.map((column) => quoteIdentifier(column.name));
    const insert = prepared(
      "audit.insert",
      `INSERT INTO audit_access_log (${names.join(", ")}, prev_hash, hash) VALUES (${names.map(() => "?").join(", ")}, ?, ?)`,
    );
    return transaction(() => {
      const last = prepared("audit.last", "SELECT hash FROM audit_access_log ORDER BY seq DESC LIMIT 1").get();
      const prevHash = (last && last.hash) || GENESIS_HASH;
      const hash = auditChainHash(prevHash, row);
      const outcome = insert.run(...values, prevHash, hash);
      return { seq: Number(outcome.lastInsertRowid), hash };
    });
  }

  function stateName(name) {
    if (typeof name !== "string" || !name || name.length > 128) throw rowError("invalid_state_name");
    return name;
  }

  function getState(name) {
    assertOpen();
    const row = prepared("state.get", "SELECT value FROM collector_state WHERE name = ?").get(stateName(name));
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  function setState(name, value) {
    assertOpen();
    const key = stateName(name);
    const json = JSON.stringify(value === undefined ? null : value);
    if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) throw rowError("invalid_state_value");
    prepared(
      "state.set",
      "INSERT INTO collector_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, json, Date.now());
    return { ok: true };
  }

  function loadQueries() {
    if (queryModule === undefined) queryModule = optionalModule(queryModuleFile);
    return queryModule;
  }

  // Named queries live in query.js (TEL-11) and run here, next to the
  // handle. Only own function exports are callable; names are never
  // interpolated into SQL.
  async function call(queryName, params) {
    assertOpen();
    const queries = loadQueries();
    const name = typeof queryName === "string" ? queryName : "";
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || !queries || !Object.prototype.hasOwnProperty.call(queries, name)
      || typeof queries[name] !== "function") {
      throw storeError("unknown_query", "Unknown telemetry query.");
    }
    return queries[name](db, params === undefined ? {} : params);
  }

  // The rollup settings of one run: the job configuration, overridden by the
  // caller's options ({timezoneOffsetMinutes, ttl, sampleIntervalMs,
  // budgetMs}).
  function rollupSettings(options) {
    const input = options && typeof options === "object" ? options : {};
    const settings = {
      timezoneOffsetMinutes: jobs.timezoneOffsetMinutes,
      ttl: jobs.ttl,
      sampleIntervalMs: jobs.sampleIntervalMs,
      budgetMs: jobs.rollupBudgetMs,
    };
    if (Object.prototype.hasOwnProperty.call(input, "timezoneOffsetMinutes")) {
      settings.timezoneOffsetMinutes = rollups.normalizeTimezoneOffset(input.timezoneOffsetMinutes);
    }
    if (input.ttl !== undefined && input.ttl !== null) settings.ttl = normalizeTtl(input.ttl);
    for (const key of ["sampleIntervalMs", "budgetMs"]) {
      const number = suppliedNumber(input[key]);
      if (number !== null && number >= 0) settings[key] = number;
    }
    return settings;
  }

  // §10. Each rollups.runRollups step does a bounded amount of work; between
  // steps the worker yields, so inserts queued behind a long catch-up (after
  // a restart, or an import that dirtied many minutes) still run.
  async function runRollups(now, options) {
    assertRunning();
    const settings = rollupSettings(options);
    if (rollupsRunning) return { ok: false, skipped: true, reason: "rollups_running" };
    rollupsRunning = true;
    const at = toEpochMs(now) ?? clock.now();
    const started = Date.now();
    const totals = { closed: { "1m": 0, "1h": 0, "1d": 0 }, recomputed: { "1m": 0, "1h": 0, "1d": 0 }, droppedDirty: 0, steps: 0 };
    try {
      let step;
      for (;;) {
        assertRunning();
        step = rollups.runRollups(db, at, settings);
        totals.steps += 1;
        totals.droppedDirty += step.droppedDirty;
        for (const grain of rollups.GRAINS) {
          totals.closed[grain] += step.closed[grain];
          totals.recomputed[grain] += step.recomputed[grain];
        }
        if (!step.more) break;
        await delay(retentionOptions.yieldMs);
      }
      return {
        ok: true,
        at,
        durationMs: Date.now() - started,
        ...totals,
        dirtyPending: step.dirtyPending,
        watermarks: step.watermarks,
      };
    } catch (error) {
      if (closed || stopping) return { ok: false, aborted: true, reason: "store_closed" };
      logFailureOnce("rollups", error);
      return { ok: false, error: errorCode(error) };
    } finally {
      rollupsRunning = false;
    }
  }

  async function deleteInBatches(table, whereSql, params, tally) {
    const spec = specFor(table);
    const keys = spec.keyColumns.map(quoteIdentifier).join(", ");
    const statement = prepared(
      `retention:${table}:${whereSql}`,
      `DELETE FROM ${quoteIdentifier(table)} WHERE (${keys}) IN (SELECT ${keys} FROM ${quoteIdentifier(table)} WHERE ${whereSql} LIMIT ${retentionOptions.batchRows})`,
    );
    for (;;) {
      assertRunning();
      const changes = Number(statement.run(...params).changes);
      if (changes > 0) {
        tally.deleted[table] = (tally.deleted[table] || 0) + changes;
        tally.batches[table] = (tally.batches[table] || 0) + 1;
      }
      if (changes < retentionOptions.batchRows) return;
      await delay(retentionOptions.yieldMs);
    }
  }

  // Pages through `select` (keyset, one short transaction per page, a yield
  // between pages) and masks every row it returns. `cursor(row)` gives the
  // next page's parameters.
  async function maskPages(select, firstParams, cursor) {
    const update = prepared(
      "retention:mask:update",
      "UPDATE requests SET client_ip = ?, user_agent = NULL, owui_user_id = NULL, owui_chat_id = NULL WHERE id = ?",
    );
    let masked = 0;
    let params = firstParams;
    for (;;) {
      assertRunning();
      const rows = select.all(...params);
      if (!rows.length) return masked;
      transaction(() => {
        for (const row of rows) update.run(maskClientIp(row.client_ip), row.id);
      });
      masked += rows.length;
      if (rows.length < retentionOptions.batchRows) return masked;
      params = cursor(rows[rows.length - 1]);
      await delay(retentionOptions.yieldMs);
    }
  }

  // §4.3 and §21: the IP, user agent and OpenWebUI ids are kept for ipDays.
  // Keyset pages over (received_at, id) from the last pass's watermark, so a
  // pass reads only rows that crossed the cutoff since then.
  function maskCrossedCutoff(fromMs, cutoffMs) {
    const select = prepared("retention:mask:crossed", `
      SELECT id, received_at, client_ip FROM requests
      WHERE received_at < ? AND (received_at, id) > (?, ?) AND ${UNMASKED_REQUEST_SQL}
      ORDER BY received_at, id LIMIT ${retentionOptions.batchRows}`);
    return maskPages(select, [cutoffMs, fromMs - 1, 0], (last) => [cutoffMs, Number(last.received_at), Number(last.id)]);
  }

  // Rows inserted since the last pass that were already past the cutoff:
  // access-log imports, long spool replays, or a second store instance whose
  // insert-time check was stale. Insert order no longer matters: requests
  // ids only grow between passes (retention is the only delete), so this is
  // a rowid range scan over the new rows. The unary + keeps SQLite off the
  // received_at index, whose range below the cutoff holds every older row.
  function maskInsertedSince(fromId, cutoffMs) {
    const select = prepared("retention:mask:since", `
      SELECT id, client_ip FROM requests
      WHERE id > ? AND +received_at < ? AND ${UNMASKED_REQUEST_SQL}
      ORDER BY id LIMIT ${retentionOptions.batchRows}`);
    return maskPages(select, [fromId, cutoffMs], (last) => [Number(last.id), cutoffMs]);
  }

  // The oldest time each input still has rows for: raw requests, raw samples,
  // 1m and 1h rollups. Raised before a delete starts and never lowered, so
  // the rollup job never rebuilds a bucket from inputs a pass is pruning or
  // already pruned (the size guard deletes below the TTL).
  function raiseFloors(values) {
    const floors = getState("retention.floors") || {};
    let changed = false;
    for (const [name, value] of Object.entries(values)) {
      const current = Number(floors[name]);
      if (Number.isFinite(value) && (!Number.isFinite(current) || value > current)) {
        floors[name] = value;
        changed = true;
      }
    }
    if (changed) setState("retention.floors", floors);
  }

  function pragmaNumber(name) {
    return Number(Object.values(db.prepare(`PRAGMA ${name}`).get())[0]);
  }

  // §4.3 size guard: past telemetry.maxDbMb, raw requests older than 7 days
  // and samples older than 12 hours are deleted first (their rollups stay),
  // and a telemetry.retention.pressure warning is recorded.
  async function applySizeGuard(at, maxDbMb, tally) {
    const limitMb = suppliedNumber(maxDbMb);
    if (limitMb === null || !(limitMb > 0)) return null;
    const maxDbBytes = Math.floor(limitMb * 1024 * 1024);
    const dbBytes = pragmaNumber("page_count") * pragmaNumber("page_size");
    if (dbBytes <= maxDbBytes) return null;
    const requestsBefore = at - SIZE_GUARD.requestsDays * DAY_MS;
    const samplesBefore = at - SIZE_GUARD.samplesHours * HOUR_MS;
    raiseFloors({ requests: requestsBefore, samples: samplesBefore });
    const before = { ...tally.deleted };
    await deleteInBatches("requests", `${quoteIdentifier("received_at")} < ?`, [requestsBefore], tally);
    await deleteInBatches("runtime_samples", `${quoteIdentifier("at")} < ?`, [samplesBefore], tally);
    await deleteInBatches("gpu_samples", `${quoteIdentifier("at")} < ?`, [samplesBefore], tally);
    const deleted = {};
    for (const [table, count] of Object.entries(tally.deleted)) {
      if (count > (before[table] || 0)) deleted[table] = count - (before[table] || 0);
    }
    const pressure = { dbBytes, maxDbBytes, requestsBefore, samplesBefore, deleted };
    assertRunning();
    insertRows("events", [{
      at,
      type: "telemetry.retention.pressure",
      severity: "warning",
      source: "telemetry",
      title: "Telemetry database is over its size limit; older raw rows were deleted",
      data: pressure,
    }], { prepareRow: prepareEvent });
    log("warn", `Telemetry database is ${dbBytes} bytes, over its ${maxDbBytes}-byte limit; `
      + `deleted raw requests before ${new Date(requestsBefore).toISOString()} and samples before ${new Date(samplesBefore).toISOString()}.`);
    return pressure;
  }

  async function retentionPass(at, ttl, options = {}) {
    const started = Date.now();
    const previous = getState("retention") || {};
    const tally = { deleted: {}, batches: {} };
    const pressure = await applySizeGuard(at, options.maxDbMb, tally);
    raiseFloors({
      requests: at - ttl.requestsDays * DAY_MS,
      samples: at - ttl.samplesHours * HOUR_MS,
      minute: at - ttl.minuteDays * DAY_MS,
      hour: at - ttl.hourDays * DAY_MS,
    });
    for (const target of schema.RETENTION_TARGETS) {
      const cutoff = at - ttl[target.ttl] * target.unitMs;
      await deleteInBatches(target.table, `${quoteIdentifier(target.column)} < ?`, [cutoff], tally);
    }
    const forever = [
      ...schema.EVENT_RETENTION.foreverPrefixes.map((prefix) => `substr(type, 1, ${prefix.length}) <> '${prefix.replace(/'/g, "''")}'`),
      ...schema.EVENT_RETENTION.foreverTypes.map((type) => `type <> '${type.replace(/'/g, "''")}'`),
    ].join(" AND ");
    await deleteInBatches("events", `at < ? AND ${forever}`, [at - ttl.eventsDays * DAY_MS], tally);
    for (const [type, days] of Object.entries(schema.EVENT_RETENTION.fixedDays)) {
      await deleteInBatches("events", "type = ? AND at < ?", [type, at - days * DAY_MS], tally);
    }
    const ipCutoff = at - ttl.ipDays * DAY_MS;
    const watermark = Number(previous.maskedThrough);
    const maskFrom = Number.isFinite(watermark) ? Math.max(0, Math.min(watermark, ipCutoff)) : 0;
    // From here on, inserts below the new cutoff are masked on the way in:
    // the scans below may already be past their received_at or id.
    maskBeforeMs = ipCutoff;
    // Read after the deletes above, so a reused id (the newest rows were
    // deleted) is still above it. Rows inserted from here on are the next
    // pass's maskInsertedSince range.
    const maxId = Number(prepared("retention:mask:max", "SELECT max(id) AS id FROM requests").get().id) || 0;
    let masked = await maskCrossedCutoff(maskFrom, ipCutoff);
    // The first pass scanned every row from 0 already.
    const previousMaxId = Number(previous.maskedMaxId);
    const sinceId = Number.isFinite(previousMaxId) ? previousMaxId : Number.isFinite(watermark) ? 0 : null;
    if (sinceId !== null) masked += await maskInsertedSince(sinceId, ipCutoff);
    assertRunning();
    // Under pressure every free page goes back, so the file really shrinks.
    db.exec(pressure ? "PRAGMA incremental_vacuum" : `PRAGMA incremental_vacuum(${retentionOptions.vacuumPages})`);
    let lastOptimizeAt = Number(previous.lastOptimizeAt) || 0;
    let optimized = false;
    if (at - lastOptimizeAt >= retentionOptions.optimizeEveryMs) {
      db.exec("PRAGMA optimize");
      lastOptimizeAt = at;
      optimized = true;
    }
    const summary = {
      lastRunAt: at,
      durationMs: Date.now() - started,
      deleted: tally.deleted,
      batches: tally.batches,
      masked,
      // Every requests row below this is masked. It follows the current
      // cutoff, so it moves back when ipDays grows.
      maskedThrough: ipCutoff,
      // The highest requests id this pass checked; the next pass also masks
      // every newer row that is already past its cutoff.
      maskedMaxId: maxId,
      lastOptimizeAt,
      ttl,
    };
    setState("retention", summary);
    return { ok: true, ...summary, optimized, pressure };
  }

  // Deletes in batches and yields between them, so inserts queued behind a
  // long pass still run (each batch is its own short transaction). `ttl`
  // defaults to the job's telemetry.retention settings, and options.maxDbMb
  // to its telemetry.maxDbMb.
  async function runRetention(now, ttl, options) {
    assertRunning();
    if (retentionRunning) return { ok: false, skipped: true, reason: "retention_running" };
    retentionRunning = true;
    const input = options && typeof options === "object" ? options : {};
    const maxDbMb = suppliedNumber(input.maxDbMb) ?? jobs.maxDbMb;
    try {
      return await retentionPass(toEpochMs(now) ?? clock.now(), normalizeTtl(ttl === undefined ? jobs.ttl : ttl), { maxDbMb });
    } catch (error) {
      if (closed || stopping) return { ok: false, aborted: true, reason: "store_closed" };
      logFailureOnce("retention", error);
      return { ok: false, error: errorCode(error) };
    } finally {
      retentionRunning = false;
    }
  }

  // ---- background jobs (§2): rollups every 30 s, retention every hour.

  function cancelJob(name) {
    const timer = jobTimers.get(name);
    if (timer === undefined) return;
    jobTimers.delete(name);
    clock.clearTimeout(timer);
  }

  function stopJobs() {
    for (const name of Array.from(jobTimers.keys())) cancelJob(name);
  }

  function scheduleJob(name, delayMs, run) {
    cancelJob(name);
    if (!jobs.enabled || stopping || closed) return;
    const timer = clock.setTimeout(() => {
      jobTimers.delete(name);
      run();
    }, Math.max(0, delayMs));
    if (timer && typeof timer.unref === "function") timer.unref();
    jobTimers.set(name, timer);
  }

  function noteJobRun(name, result, started) {
    jobRuns[name] = {
      at: started,
      durationMs: Math.max(0, clock.now() - started),
      ok: Boolean(result && result.ok !== false),
      error: (result && result.error) || null,
    };
  }

  async function rollupJob() {
    const started = clock.now();
    try {
      noteJobRun("rollup", await runRollups(started), started);
    } catch (error) {
      logFailureOnce("scheduled rollups", error);
      noteJobRun("rollup", { ok: false, error: errorCode(error) }, started);
    } finally {
      scheduleJob("rollup", jobs.rollupEveryMs, rollupJob);
    }
  }

  async function retentionJob() {
    const started = clock.now();
    try {
      noteJobRun("retention", await runRetention(started, jobs.ttl, { maxDbMb: jobs.maxDbMb }), started);
    } catch (error) {
      logFailureOnce("scheduled retention", error);
      noteJobRun("retention", { ok: false, error: errorCode(error) }, started);
    } finally {
      scheduleJob("retention", jobs.retentionEveryMs, retentionJob);
    }
  }

  // The next retention pass is due an hour after the last one (state survives
  // restarts, so frequent deploys do not postpone it forever).
  function startJobs() {
    stopJobs();
    if (!jobs.enabled || stopping || closed) return;
    scheduleJob("rollup", jobs.firstRollupDelayMs, rollupJob);
    const lastRunAt = Number((getState("retention") || {}).lastRunAt);
    const due = Number.isFinite(lastRunAt) ? lastRunAt + jobs.retentionEveryMs - clock.now() : 0;
    scheduleJob("retention", Math.min(jobs.retentionEveryMs, Math.max(jobs.firstRetentionDelayMs, due)), retentionJob);
  }

  function describeJobs() {
    return {
      ...jobs,
      ttl: { ...jobs.ttl },
      scheduled: Array.from(jobTimers.keys()).sort(),
      lastRuns: { rollup: jobRuns.rollup, retention: jobRuns.retention },
    };
  }

  // Live settings (§20): telemetry.retention.*, maxDbMb and
  // timezoneOffsetMinutes apply without a restart. Unset keys keep their
  // value; an offset that is not a whole hour is refused.
  function configureJobs(patch) {
    assertRunning();
    jobs = normalizeJobs(patch, jobs, { strict: true, log });
    startJobs();
    return { ok: true, jobs: describeJobs() };
  }

  function fileSize(target) {
    try {
      return fs.statSync(target).size;
    } catch {
      return 0;
    }
  }

  // Exact row counts scan every table, which blocks the worker (and the
  // inserts queued behind it) for hundreds of ms on a full-size database, so
  // they are opt-in: stats({ rows: true }) for tests and diagnostics.
  function stats(options = {}) {
    assertOpen();
    const countRows = Boolean(options && options.rows === true);
    const pragmas = {};
    const pragmaMismatches = [];
    for (const pragma of schema.PRAGMAS) {
      const row = db.prepare(`PRAGMA ${pragma.name}`).get();
      const value = row ? Object.values(row)[0] : null;
      pragmas[pragma.name] = value;
      if (value !== pragma.expect) pragmaMismatches.push(pragma.name);
    }
    const pageCount = Number(Object.values(db.prepare("PRAGMA page_count").get())[0]);
    const pageSize = Number(Object.values(db.prepare("PRAGMA page_size").get())[0]);
    const freelistPages = Number(Object.values(db.prepare("PRAGMA freelist_count").get())[0]);
    let rows = null;
    if (countRows) {
      rows = {};
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      for (const { name } of tables) {
        rows[snakeToCamel(name)] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(name)}`).get().n);
      }
    }
    return {
      ok: true,
      store: "ok",
      thread: isMainThread ? "main" : "worker",
      file,
      sqliteVersion: db.prepare("SELECT sqlite_version() AS v").get().v,
      schemaVersion: readSchemaVersion(db),
      codeSchemaVersion: schema.SCHEMA_VERSION,
      migration,
      pragmas,
      pragmaMismatches,
      dbBytes: pageCount * pageSize,
      fileBytes: file === ":memory:" ? 0 : fileSize(file),
      walBytes: file === ":memory:" ? 0 : fileSize(`${file}-wal`),
      pageCount,
      pageSize,
      freelistPages,
      rows,
      rowsExact: countRows,
      writes: JSON.parse(JSON.stringify(writes)),
      retention: getState("retention"),
      masking: { maskBefore: maskThreshold(), maskedOnInsert },
      rollups: {
        ...(getState("rollup") || {}),
        watermarks: Object.fromEntries(rollups.GRAINS.map((grain) => [grain, (getState(`rollup.${grain}`) || {}).watermark ?? null])),
      },
      jobs: describeJobs(),
      degraded: [],
    };
  }

  // Called before close() while in-flight calls drain: a yielding retention
  // pass or rollup catch-up stops at its next batch boundary and resolves
  // { aborted: true }, and no scheduled job starts any more.
  function beginClose() {
    stopping = true;
    stopJobs();
    return { ok: true };
  }

  function close() {
    if (closed) return { ok: true };
    stopping = true;
    stopJobs();
    closed = true;
    try { db.exec("PRAGMA optimize"); } catch {}
    db.close();
    return { ok: true };
  }

  startJobs();

  return {
    info: { file, thread: isMainThread ? "main" : "worker", schemaVersion: migration.to, migration },
    insertRequests: (rows) => insertRows("requests", rows, {
      finishRow: maskStaleRequest,
      afterInsert: markLateRows("requests", "received_at"),
    }),
    insertRuntimeSamples: (rows) => insertRows("runtime_samples", rows, { afterInsert: markLateRows("runtime", "at") }),
    insertGpuSamples: (rows) => insertRows("gpu_samples", rows, { afterInsert: markLateRows("gpu", "at") }),
    insertEvents: (rows) => insertRows("events", rows, { prepareRow: prepareEvent }),
    appendAuditAccess,
    call,
    runRollups,
    runRetention,
    configureJobs,
    getState,
    setState,
    stats,
    beginClose,
    close,
  };
}

function startWorker() {
  const port = parentPort;
  const log = (level, message) => port.postMessage({ type: "log", level, message: redactSecrets(String(message)) });
  let core;
  try {
    core = createStoreCore({ ...(workerData.options || {}), log });
  } catch (error) {
    // Degraded open: report and exit. The parent never retries a file that
    // failed to open and never deletes or recreates it.
    port.postMessage({ type: "ready", ok: false, error: serializeError(error) });
    return;
  }
  port.postMessage({ type: "ready", ok: true, info: core.info });
  // Calls run in arrival order, but an async one (a retention pass) yields
  // and lets later calls run. "close" first stops such passes at their next
  // batch boundary and waits for them, so the handle never closes under one.
  const inflight = new Set();
  port.on("message", async (message) => {
    if (!message || message.type !== "call") return;
    const { id, method } = message;
    const task = (async () => {
      if (!CORE_METHODS.includes(method)) throw storeError("unknown_method", "Unknown telemetry store method.");
      const args = Array.isArray(message.args) ? message.args : [];
      if (method === "close") {
        core.beginClose();
        await Promise.allSettled(Array.from(inflight));
      }
      return core[method](...args);
    })();
    inflight.add(task);
    try {
      const result = await task;
      port.postMessage({ type: "result", id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
      port.postMessage({ type: "result", id, ok: false, error: serializeError(error) });
    } finally {
      inflight.delete(task);
    }
  });
}

if (!isMainThread && workerData && workerData.kind === WORKER_KIND) startWorker();

module.exports = {
  WORKER_KIND,
  CORE_METHODS,
  RETENTION_DEFAULTS,
  JOB_DEFAULTS,
  SIZE_GUARD,
  GENESIS_HASH,
  AUDIT_HASH_FIELDS,
  createStoreCore,
  serializeError,
  auditCanonicalJson,
  auditChainHash,
  maskClientIp,
  normalizeTtl,
  normalizeJobs,
};
