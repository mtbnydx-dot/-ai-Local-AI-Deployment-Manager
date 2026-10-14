"use strict";

// Importers (docs/overhaul/04-telemetry.md §18, TEL-18). Every §18 source is
// written, from the sanitised fixture, to the file the platform keeps it in
// (an AI root in a temp folder) and imported into a real in-process store.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite = require("node:sqlite");
const importers = require("../telemetry/importers");
const { openTelemetryStore } = require("../telemetry/store");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "telemetry", "importers", "import-sources.json"), "utf8"));
const NOW = Date.parse(FIXTURE.now);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RAW_CUTOFF = NOW - 30 * DAY_MS;
const UTC = 0;

// --- harness -------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function lines(entries) {
  return `${entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")}\n`;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

function buildServiceUsage(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE service_usage_events (
    event_id TEXT PRIMARY KEY, at TEXT NOT NULL, manager TEXT NOT NULL, client_id TEXT NOT NULL, model TEXT NOT NULL,
    status INTEGER NOT NULL, ok INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL, generation_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL, request_id TEXT NOT NULL DEFAULT '', usage_source TEXT NOT NULL DEFAULT 'missing',
    stream INTEGER NOT NULL DEFAULT 0, terminal_state TEXT NOT NULL DEFAULT 'completed', cached_tokens INTEGER DEFAULT NULL)`);
  const insert = db.prepare(`INSERT INTO service_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.event_id, row.at, row.manager, row.client_id, row.model, row.status, row.ok, row.prompt_tokens, row.generation_tokens,
      row.total_tokens, row.request_id, row.usage_source, row.stream, row.terminal_state, row.cached_tokens);
  }
  db.close();
}

// The fixture, written where the platform keeps each file.
function writeSources(root) {
  for (const [id, history] of Object.entries(FIXTURE.metricsHistory)) writeJson(path.join(root, `${id}-manager`, "logs", "metrics-history.json"), history);
  for (const [id, ledger] of Object.entries(FIXTURE.statsLedger)) writeJson(path.join(root, `${id}-manager`, "logs", "stats-ledger.json"), ledger);
  write(path.join(root, "vllm-manager", "logs", "service-gateway-access.log"), lines(FIXTURE.accessLogs.vllm));
  write(path.join(root, "service-entry", "logs", "gateway-access.log"), lines(FIXTURE.accessLogs.entry));
  buildServiceUsage(path.join(root, "vllm-manager", "logs", "service-usage.sqlite"), FIXTURE.serviceUsage.vllm);
  for (const [id, ledger] of Object.entries(FIXTURE.jobsLedger)) writeJson(path.join(root, `${id}-manager`, "logs", "jobs-ledger.json"), ledger);
  write(path.join(root, "service-entry", "logs", "process-exit.log"), lines(FIXTURE.processExit.entry));
  write(path.join(root, "vllm-manager", "logs", "process-exit.log"), lines(FIXTURE.processExit.vllm));
  for (const [id, manifest] of Object.entries(FIXTURE.auditManifests)) writeJson(path.join(root, "audit-logs", id, "manifest.json"), manifest);
  fs.mkdirSync(path.join(root, "audit-logs", "audit-without-manifest"), { recursive: true });
  for (const [id, history] of Object.entries(FIXTURE.benchmarks)) writeJson(path.join(root, `${id}-manager`, "logs", "benchmark-history.json"), history);
  write(path.join(root, "audit-logs", "platform-mcp.jsonl"), lines(FIXTURE.mcpAudit));
}

async function setup(t, { sources = true, inProcess = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-importers-"));
  const root = path.join(base, "ai-root");
  const dbFile = path.join(base, "db", "telemetry.sqlite");
  fs.mkdirSync(root, { recursive: true });
  if (sources) writeSources(root);
  const store = await openTelemetryStore({ file: dbFile, inProcess, logger: null });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await store.close({ flushMs: 0 });
    }
  };
  t.after(async () => {
    await close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const run = (options = {}) => importers.runImport({ aiRoot: root, store, now: NOW, timezoneOffsetMinutes: UTC, dryRun: false, ...options });
  return { base, root, dbFile, store, run, close };
}

function readDb(dbFile, fn) {
  const db = new sqlite.DatabaseSync(dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Every row of every table, as one hash: equal hashes mean nothing was written.
function snapshot(dbFile) {
  return readDb(dbFile, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const counts = {};
    const hash = crypto.createHash("sha256");
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      counts[table] = rows.length;
      hash.update(table).update(JSON.stringify(rows));
    }
    return { counts, hash: hash.digest("hex") };
  });
}

function tree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path.relative(root, full)}/`);
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out.push(`${path.relative(root, full)} ${stat.size} ${Math.floor(stat.mtimeMs)} ${sha256(fs.readFileSync(full).toString("latin1"))}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

function summary(report) {
  return { rowsIn: report.rowsIn, rowsWritten: report.rowsWritten, rowsSkipped: report.rowsSkipped };
}

function byId(result) {
  return Object.fromEntries(result.reports.map((report) => [report.source, report]));
}

function importRequestId(label, lineNo, at) {
  return `imp_${sha256(`${label}\n${lineNo}\n${at}`).slice(0, 20)}`;
}

function firstLineOf(file) {
  return fs.readFileSync(file, "utf8").split("\n")[0];
}

function cell(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

// --- the sources ---------------------------------------------------------------

test("IMPORT_SOURCES lists the nine §18 sources, access-logs before service-usage", () => {
  assert.deepEqual([...importers.IMPORT_SOURCES], [
    "metrics-history", "stats-ledger", "access-logs", "service-usage", "jobs-ledger", "process-exit", "audit-manifests", "benchmarks", "mcp-audit",
  ]);
  assert.ok(importers.IMPORT_SOURCES.indexOf("access-logs") < importers.IMPORT_SOURCES.indexOf("service-usage"));
});

test("every source imports from its fixture and the report lists what was skipped, and why", async (t) => {
  const { run, dbFile } = await setup(t);
  const result = await run();
  const reports = byId(result);

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.sources, [...importers.IMPORT_SOURCES]);
  assert.deepEqual(summary(reports["metrics-history"]), {
    rowsIn: 12, rowsWritten: 9, rowsSkipped: { invalid_row: 1, no_importable_fields: 1, open_bucket: 1 },
  });
  assert.deepEqual(summary(reports["stats-ledger"]), { rowsIn: 3, rowsWritten: 2, rowsSkipped: { empty_counters: 1 } });
  assert.deepEqual(summary(reports["access-logs"]), {
    rowsIn: 14,
    rowsWritten: 10,
    rowsSkipped: { invalid_json: 1, invalid_timestamp: 1, not_gateway_path: 1, control_route: 1 },
  });
  assert.deepEqual(summary(reports["service-usage"]), {
    rowsIn: 4, rowsWritten: 1, rowsSkipped: { older_than_raw_ttl: 1, no_usage: 1, no_matching_row: 1 },
  });
  assert.deepEqual(summary(reports["jobs-ledger"]), {
    rowsIn: 12, rowsWritten: 9, rowsSkipped: { automation_other: 1, download_job: 1, unsupported_job_type: 1 },
  });
  assert.deepEqual(summary(reports["process-exit"]), { rowsIn: 8, rowsWritten: 7, rowsSkipped: { unrecognised_line: 1 } });
  assert.deepEqual(summary(reports["audit-manifests"]), { rowsIn: 3, rowsWritten: 2, rowsSkipped: { no_manifest: 1 } });
  assert.deepEqual(summary(reports.benchmarks), { rowsIn: 3, rowsWritten: 3, rowsSkipped: {} });
  assert.deepEqual(summary(reports["mcp-audit"]), { rowsIn: 3, rowsWritten: 2, rowsSkipped: { older_than_events_ttl: 1 } });
  for (const report of result.reports) {
    const skipped = Object.values(report.rowsSkipped).reduce((sum, count) => sum + count, 0);
    assert.equal(report.rowsIn, report.rowsWritten + skipped, `${report.source}: every row is written or skipped for a reason`);
    assert.deepEqual(Object.keys(report).filter((key) => !["error"].includes(key)).sort(),
      ["files", "rangeFrom", "rangeTo", "rowsIn", "rowsSkipped", "rowsWritten", "source", "warnings"], `${report.source}: the §18 report shape`);
  }
  assert.equal(result.rowsIn, result.reports.reduce((sum, report) => sum + report.rowsIn, 0));
  assert.equal(result.rowsWritten, result.reports.reduce((sum, report) => sum + report.rowsWritten, 0));
  assert.equal(result.rowsSkipped.control_route, 1);
  assert.deepEqual([reports["access-logs"].files, reports["metrics-history"].files, reports["stats-ledger"].files], [2, 1, 2]);
  assert.equal(reports["access-logs"].rangeFrom, "2026-08-01T10:00:10.000Z");
  assert.equal(reports["access-logs"].rangeTo, "2026-10-13T11:10:00.000Z");
  assert.ok(reports["metrics-history"].warnings.some((line) => /Throughput, latency and speculative/.test(line)));
  assert.ok(reports["stats-ledger"].warnings.some((line) => /no time axis/.test(line)));

  const counts = snapshot(dbFile).counts;
  assert.equal(counts.requests, 5);
  assert.equal(counts.lifetime_baseline, 2);
  assert.equal(counts.events, 9 + 7 + 2 + 3 + 2);
  assert.equal(counts.import_runs > 0, true);
});

test("metrics-history: GPU fields reach the GPU rollups, throughput and latency are not imported", async (t) => {
  const { run, dbFile } = await setup(t);
  await run({ sources: ["metrics-history"] });
  readDb(dbFile, (db) => {
    const hours = db.prepare("SELECT * FROM gpu_rollup_1h ORDER BY bucket").all();
    assert.deepEqual(hours.map((row) => new Date(row.bucket).toISOString()), [
      "2026-09-20T06:00:00.000Z", "2026-09-20T07:00:00.000Z", "2026-10-12T22:00:00.000Z", "2026-10-13T08:00:00.000Z", "2026-10-13T09:00:00.000Z",
    ], "the open hour (10:00) is not written");
    assert.ok(hours.every((row) => row.gpu_index === 0), "a single GPU is index 0");
    const h08 = hours.find((row) => row.bucket === Date.UTC(2026, 9, 13, 8));
    assert.equal(h08.sample_count, 2, "the sample without GPU fields is not counted");
    assert.equal(h08.util_pct_avg, 70);
    assert.equal(h08.util_pct_max, 80);
    assert.equal(h08.mem_used_mb_max, 20100);
    assert.equal(h08.mem_total_mb, 24576);
    assert.equal(h08.temp_c_avg, 67.5);
    assert.equal(h08.power_w_max, 360);
    assert.ok(Math.abs(h08.energy_wh - 22) < 1e-6, "power integrated over gaps capped at two sample intervals");
    const h07 = hours.find((row) => row.bucket === Date.UTC(2026, 8, 20, 7));
    assert.ok(Math.abs(h07.idle_energy_wh - 2) < 1e-6, "util 0 counts as idle energy");

    const minutes = db.prepare("SELECT bucket FROM gpu_rollup_1m ORDER BY bucket").all().map((row) => new Date(row.bucket).toISOString());
    assert.deepEqual(minutes, [
      "2026-10-12T22:10:00.000Z", "2026-10-12T22:40:00.000Z", "2026-10-13T08:10:00.000Z", "2026-10-13T08:40:00.000Z",
      "2026-10-13T09:10:00.000Z", "2026-10-13T09:40:00.000Z",
    ], "minutes older than 14 days exist only as hours and days");
    assert.deepEqual(db.prepare("SELECT bucket, sample_count FROM gpu_rollup_1d").all().map((row) => ({ ...row })), [{ bucket: Date.UTC(2026, 9, 12), sample_count: 2 }],
      "only the day the file covers completely");

    const runtime = db.prepare("SELECT * FROM runtime_rollup_1h ORDER BY bucket").all();
    assert.deepEqual(runtime.map((row) => [new Date(row.bucket).toISOString(), row.sample_count, row.resets, row.d_requests]), [
      ["2026-09-20T06:00:00.000Z", 1, 0, 10],
      ["2026-09-20T07:00:00.000Z", 1, 0, 10],
      ["2026-10-12T22:00:00.000Z", 2, 1, 10],
      ["2026-10-13T08:00:00.000Z", 2, 0, 70],
      ["2026-10-13T09:00:00.000Z", 2, 1, 20],
    ], "deltas per (engine, model), a container change or a decrease is a reset without a delta");
    assert.ok(runtime.every((row) => row.fleet_id === "vllm:primary" && row.model === "model-a" && row.manager_id === "vllm"));
    for (const row of runtime) {
      for (const column of ["d_prompt_tokens", "d_output_tokens", "d_cached_tokens", "d_spec_draft_tokens", "d_spec_accepted_tokens",
        "ttft_p50_ms", "e2e_p50_ms", "itl_p50_ms", "tpot_p50_ms", "queue_p95_ms", "spec_accept_rate", "kv_usage_avg"]) {
        assert.equal(row[column], null, `${column} is a polling artefact or a lifetime average and stays empty`);
      }
    }
    assert.deepEqual(db.prepare("SELECT d_requests, resets FROM runtime_rollup_1d").all().map((row) => ({ ...row })), [{ d_requests: 10, resets: 1 }]);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM gpu_samples").n, 0, "samples are never reconstructed");
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM runtime_samples").n, 0);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM requests").n, 0);
  });
});

test("metrics-history: a sample that sums several GPUs goes to gpu_index -1", async (t) => {
  const { root, run, dbFile } = await setup(t, { sources: false });
  const sample = (at, count) => ({ at, engine: "llama", container: "llama-a", model: "model-b", requests: { total: 1 },
    gpu: { usedMb: 100, totalMb: 200, utilizationPercent: 10, powerWatts: 50, count } });
  writeJson(path.join(root, "llama-manager", "logs", "metrics-history.json"), { version: 1, samples: [
    sample("2026-10-13T08:10:00.000Z", 2), sample("2026-10-13T09:10:00.000Z", 2), sample("2026-10-13T10:10:00.000Z", 2),
  ] });
  await run({ sources: ["metrics-history"] });
  readDb(dbFile, (db) => {
    assert.deepEqual(db.prepare("SELECT DISTINCT gpu_index FROM gpu_rollup_1h").all().map((row) => ({ ...row })), [{ gpu_index: -1 }]);
  });
});

test("stats-ledger: one lifetime_baseline row per (manager, model), no time series", async (t) => {
  const { run, dbFile } = await setup(t);
  await run({ sources: ["stats-ledger"] });
  readDb(dbFile, (db) => {
    assert.deepEqual(db.prepare("SELECT manager_id, model, engine, prompt_tokens, cached_tokens, output_tokens, requests, errors, source FROM lifetime_baseline ORDER BY manager_id").all().map((row) => ({ ...row })), [
      { manager_id: "llama", model: "model-b", engine: "llama", prompt_tokens: 300, cached_tokens: 0, output_tokens: 120, requests: 9, errors: 0, source: "stats-ledger" },
      { manager_id: "vllm", model: "model-a", engine: "vllm", prompt_tokens: 1000, cached_tokens: 200, output_tokens: 500, requests: 40, errors: 2, source: "stats-ledger" },
    ]);
    const row = cell(db, "SELECT first_seen, last_seen FROM lifetime_baseline WHERE model = 'model-a'");
    assert.equal(row.first_seen, Date.parse("2026-08-01T00:00:00.000Z"));
    assert.equal(row.last_seen, Date.parse("2026-10-13T09:00:00.000Z"));
    for (const table of ["rollup_1h", "rollup_1d", "runtime_rollup_1h", "gpu_rollup_1h"]) assert.equal(cell(db, `SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  });
});

test("stats-ledger: a grown ledger refreshes the baseline instead of adding rows", async (t) => {
  const { root, run, dbFile } = await setup(t);
  await run({ sources: ["stats-ledger"] });
  const file = path.join(root, "vllm-manager", "logs", "stats-ledger.json");
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  ledger.models["model-a"].requests.total = 55;
  writeJson(file, ledger);
  const again = byId(await run({ sources: ["stats-ledger"] }))["stats-ledger"];
  assert.equal(again.rowsWritten, 1, "only the changed model");
  assert.equal(again.rowsSkipped.unchanged, undefined);
  readDb(dbFile, (db) => {
    assert.equal(cell(db, "SELECT requests FROM lifetime_baseline WHERE model = 'model-a'").requests, 55);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM lifetime_baseline").n, 2);
  });
});

test("access-logs: rows get the §18 request ids, classification and dupOf; old rows land only in rollups", async (t) => {
  const { root, run, dbFile } = await setup(t);
  await run({ sources: ["access-logs"] });
  const managerFile = path.join(root, "vllm-manager", "logs", "service-gateway-access.log");
  const managerLabel = `vllm-manager/logs/service-gateway-access.log#${sha256(firstLineOf(managerFile)).slice(0, 8)}`;
  readDb(dbFile, (db) => {
    const rows = db.prepare("SELECT * FROM requests ORDER BY received_at, id").all();
    assert.equal(rows.length, 5);
    assert.ok(rows.every((row) => row.received_at >= RAW_CUTOFF), "no row older than the raw TTL is ever inserted raw");
    assert.ok(rows.every((row) => /^imp_[0-9a-f]{20}$/.test(row.request_id)));

    const first = rows.find((row) => row.request_id === importRequestId(managerLabel, 1, "2026-10-13T10:00:00.000Z"));
    assert.ok(first, "request_id = imp_ + sha256(fileLabel + lineNo + at)[0..20]");
    assert.deepEqual(
      [first.ingress, first.manager_id, first.protocol, first.op, first.route, first.method, first.path, first.model_resolved, first.key_id, first.status],
      ["import:manager", "vllm", "openai", "chat", "vllm", "POST", "/gateway/vllm/openai/v1/chat/completions", "model-a", "client-1", 200],
    );
    assert.equal(first.manager_request_id, "req_aaaaaaaaaaaaaaaaaaaa");
    assert.equal(first.client_ip, "192.0.2.10");
    assert.equal(first.received_at, Date.parse("2026-10-13T10:00:00.000Z") - 1200);
    assert.equal(first.ended_at, Date.parse("2026-10-13T10:00:00.000Z"));
    assert.equal(first.usage_source, "missing");
    assert.equal(first.prompt_tokens, null);
    assert.equal(first.terminal_state, "completed");
    assert.equal(first.error_class, "none");
    assert.equal(first.stream, 1);
    assert.equal(first.source_program, "openai-compat");
    assert.equal(first.extra, null);

    const claude = rows.find((row) => row.protocol === "claude");
    assert.deepEqual([claude.op, claude.prompt_tokens, claude.output_tokens, claude.usage_source, claude.finish_reason, claude.extra],
      ["messages", 10, 20, "reported", "stop", JSON.stringify({ toolSchemaCount: 2, toolUseCount: 1 })]);

    const entryRows = rows.filter((row) => row.ingress === "import:entry");
    assert.equal(entryRows.length, 3);
    const duplicate = entryRows.find((row) => row.model_requested === "model-a");
    assert.deepEqual(JSON.parse(duplicate.extra), { dupOf: first.request_id }, "an entry row matching a manager row (2 s, model, status) is flagged");
    assert.equal(duplicate.fleet_id, "vllm:primary");
    const auto = entryRows.find((row) => row.model_requested === "model-b");
    assert.deepEqual([auto.route, auto.manager_id, auto.source_program, auto.origin_host, auto.extra], ["auto", null, "browser", "192.0.2.5:3000", null]);
    const refused = entryRows.find((row) => row.status === 401);
    assert.deepEqual([refused.protocol, refused.op, refused.route, refused.terminal_state, refused.error_class], ["gateway", "other", "health", "rejected", "auth_failed"],
      "a control request with status 401 stays visible as a row (§5.5)");

    const hours = db.prepare("SELECT * FROM rollup_1h ORDER BY status_class").all();
    assert.deepEqual(hours.map((row) => [new Date(row.bucket).toISOString(), row.source, row.status_class, row.error_class, row.requests, row.prompt_tokens, row.output_tokens, row.manager_id, row.model]), [
      ["2026-08-01T10:00:00.000Z", "import", "2xx", "none", 1, 100, 50, "vllm", "model-a"],
      ["2026-08-01T10:00:00.000Z", "import", "5xx", "upstream_5xx", 1, 0, 0, "vllm", "model-a"],
    ], "rows older than the raw TTL go straight into rollup_1h with source = import");
    const days = db.prepare("SELECT * FROM rollup_1d ORDER BY status_class").all();
    assert.deepEqual(days.map((row) => [row.bucket, row.source, row.status_class, row.requests]), [
      [Date.UTC(2026, 7, 1), "import", "2xx", 1], [Date.UTC(2026, 7, 1), "import", "5xx", 1],
    ]);
    assert.equal(JSON.parse(hours[0].duration_hist).length > 0, true);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM requests WHERE received_at < ?", RAW_CUTOFF).n, 0);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM rollup_1m").n, 0, "the live rollup job owns the minute grain");

    assert.deepEqual(db.prepare("SELECT bucket, route, status_class, count FROM control_counts_1m ORDER BY bucket").all().map((row) => ({ ...row })), [
      { bucket: Date.UTC(2026, 9, 13, 10, 40), route: "vllm", status_class: "2xx", count: 1 },
      { bucket: Date.UTC(2026, 9, 13, 11, 5), route: "tts", status_class: "2xx", count: 2 },
    ], "control routes are counted (within 14 days), never inserted as rows");
  });
});

test("access-logs: the rollup job later folds imported raw rows with source = import", async (t) => {
  const { run, store, dbFile } = await setup(t);
  await run({ sources: ["access-logs"] });
  await store.runRollups(NOW, { timezoneOffsetMinutes: UTC });
  readDb(dbFile, (db) => {
    const sources = db.prepare("SELECT DISTINCT source FROM rollup_1m WHERE source <> 'coverage'").all().map((row) => row.source);
    assert.deepEqual(sources, ["import"]);
    const dup = cell(db, "SELECT SUM(requests) AS n FROM rollup_1m WHERE source = 'import'").n;
    assert.equal(dup, 4, "5 raw rows, minus the entry row flagged dupOf");
    assert.ok(cell(db, "SELECT COUNT(*) AS n FROM rollup_1h WHERE source = 'import' AND bucket = ?", Date.UTC(2026, 7, 1, 10)).n >= 2, "imported old hours survive the job");
  });
});

test("service-usage: tokens and usage_source are backfilled onto matched manager rows; the rest is reported, not inserted", async (t) => {
  const { run, dbFile } = await setup(t);
  const before = await run({ sources: ["access-logs"] });
  const rowsBefore = before.rowsWritten;
  const result = await run({ sources: ["service-usage"] });
  const report = byId(result)["service-usage"];
  assert.deepEqual(summary(report), { rowsIn: 4, rowsWritten: 1, rowsSkipped: { older_than_raw_ttl: 1, no_usage: 1, no_matching_row: 1 } });
  assert.ok(rowsBefore > 0);
  readDb(dbFile, (db) => {
    const row = cell(db, "SELECT prompt_tokens, cached_tokens, output_tokens, usage_source FROM requests WHERE ingress = 'import:manager' AND key_id = 'client-1'");
    assert.deepEqual({ ...row }, { prompt_tokens: 11, cached_tokens: 4, output_tokens: 22, usage_source: "reported" });
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM requests").n, 5, "unmatched usage events are not inserted");
    const entry = cell(db, "SELECT usage_source FROM requests WHERE ingress = 'import:entry' AND model_requested = 'model-a'");
    assert.equal(entry.usage_source, "missing", "entry rows are not backfilled");
  });
});

test("jobs-ledger: launch events with stage durations, gpu.guard for GPU warnings, no download jobs", async (t) => {
  const { run, dbFile } = await setup(t);
  await run({ sources: ["jobs-ledger"] });
  readDb(dbFile, (db) => {
    const counts = Object.fromEntries(db.prepare("SELECT type, COUNT(*) AS n FROM events GROUP BY type").all().map((row) => [row.type, row.n]));
    assert.deepEqual(counts, { "launch.started": 2, "launch.phase": 4, "launch.ready": 1, "launch.failed": 1, "gpu.guard": 1 });
    const ready = JSON.parse(cell(db, "SELECT data FROM events WHERE type = 'launch.ready'").data);
    assert.equal(ready.durationMs, 180_000);
    assert.deepEqual(ready.phases.map((phase) => [phase.phase, phase.durationMs]), [["pull image", 29_000], ["load weights", 120_000], ["readiness check", 30_000]]);
    const phase = JSON.parse(cell(db, "SELECT data FROM events WHERE type = 'launch.phase' AND title LIKE '%load weights%' ORDER BY at LIMIT 1").data);
    assert.equal(phase.prevPhase, "pull image");
    assert.equal(phase.prevDurationMs, 29_000);
    const failed = cell(db, "SELECT severity, data FROM events WHERE type = 'launch.failed'");
    assert.equal(failed.severity, "warning");
    assert.equal(JSON.parse(failed.data).errorSignature, "out_of_memory");
    const guard = cell(db, "SELECT severity, source, manager_id, dedupe_key, data FROM events WHERE type = 'gpu.guard'");
    assert.deepEqual([guard.severity, guard.source, guard.manager_id, guard.dedupe_key], ["warning", "vllm", "vllm", "guard:vllm:job-guard-temp"]);
    assert.deepEqual({ kind: JSON.parse(guard.data).kind, tempC: JSON.parse(guard.data).tempC, limitC: JSON.parse(guard.data).limitC }, { kind: "temperature", tempC: 86, limitC: 85 });
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM events WHERE dedupe_key LIKE 'job:vllm:job-download%'").n, 0);
    assert.ok(cell(db, "SELECT dedupe_key FROM events WHERE type = 'launch.ready'").dedupe_key.startsWith("job:vllm:job-serve-ok:"), "the live collector's dedupe keys");
  });
});

test("process-exit, audit-manifests, benchmarks and mcp-audit become manager.*, audit.export, benchmark.run and mcp.tool_call events", async (t) => {
  const { run, dbFile } = await setup(t);
  await run({ sources: ["process-exit", "audit-manifests", "benchmarks", "mcp-audit"] });
  readDb(dbFile, (db) => {
    const counts = Object.fromEntries(db.prepare("SELECT type, COUNT(*) AS n FROM events GROUP BY type").all().map((row) => [row.type, row.n]));
    assert.deepEqual(counts, {
      "manager.start": 4, "manager.exit": 1, "manager.hard_kill_suspected": 1, "manager.crash": 1,
      "audit.export": 2, "benchmark.run": 3, "mcp.tool_call": 2,
    });
    assert.equal(cell(db, "SELECT severity FROM events WHERE type = 'manager.crash'").severity, "critical");
    assert.equal(cell(db, "SELECT severity FROM events WHERE type = 'manager.hard_kill_suspected'").severity, "warning");

    const audit = db.prepare("SELECT * FROM events WHERE type = 'audit.export' ORDER BY at").all();
    assert.deepEqual(audit.map((row) => row.dedupe_key), ["audit:audit-fixture-1", "audit:audit-fixture-2"]);
    assert.deepEqual(JSON.parse(audit[0].data), { auditId: "audit-fixture-1", reason: "scheduled", mode: "full", manager: "local-manager", chatCount: 3, messageCount: 12, rebaseline: false, i18nKey: "obs.event.audit.export" });

    const bench = cell(db, "SELECT dedupe_key, manager_id, data FROM events WHERE type = 'benchmark.run' AND dedupe_key = 'bench:vllm:bench-1'");
    assert.equal(JSON.parse(bench.data).model, "model-a", "a model path is reduced to its last segment");
    assert.equal(JSON.parse(bench.data).metrics.wallTokensPerSecond, 410.5);

    assert.deepEqual(db.prepare("SELECT dedupe_key FROM events WHERE type = 'mcp.tool_call' ORDER BY at").all().map((row) => row.dedupe_key),
      ["mcp:6f1c2b1e-0000-4000-8000-000000000001", "mcp:6f1c2b1e-0000-4000-8000-000000000002"]);
    const all = JSON.stringify(db.prepare("SELECT title, data FROM events").all());
    assert.equal(all.includes("<AI_ROOT>"), false, "no path reaches an event");
  });
});

// --- idempotence, dry run, sources untouched -------------------------------------

test("a dry run writes nothing and reports what a real run writes; a second run writes 0 rows", async (t) => {
  const { run, dbFile } = await setup(t);
  const empty = snapshot(dbFile);

  const dry = await run({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(snapshot(dbFile), empty, "not one row, in any table, changed");
  assert.ok(dry.rowsWritten > 0, "a dry run reports the rows it would write");

  const real = await run();
  assert.notEqual(snapshot(dbFile).hash, empty.hash);
  const dryById = byId(dry);
  for (const report of real.reports) {
    // service-usage matches rows that access-logs wrote in the same run; a
    // dry run cannot see them.
    if (report.source === "service-usage") continue;
    assert.deepEqual(summary(dryById[report.source]), summary(report), `${report.source}: the dry run counts what the real run wrote`);
  }
  assert.ok(dryById["service-usage"].warnings.length > 0);

  const afterReal = snapshot(dbFile);
  const second = await run();
  assert.deepEqual(snapshot(dbFile), afterReal, "the second run changed no row");
  for (const report of second.reports) assert.equal(report.rowsWritten, 0, `${report.source}: the second run writes 0 rows`);
  assert.equal(second.rowsWritten, 0);
  const secondById = byId(second);
  for (const report of real.reports) {
    assert.equal(secondById[report.source].rowsIn, report.rowsIn, `${report.source}: the same rows are seen again`);
  }
  assert.equal(secondById["access-logs"].rowsSkipped.already_imported, 14);
  assert.equal(secondById["metrics-history"].rowsSkipped.already_imported, 12);

  const dryAfter = await run({ dryRun: true });
  assert.deepEqual(snapshot(dbFile), afterReal);
  assert.equal(dryAfter.rowsWritten, 0, "a dry run after the import has nothing left to write");
});

test("the source files are unchanged (hash before and after), and no file is added next to them", async (t) => {
  const { root, run } = await setup(t);
  const before = tree(root);
  assert.ok(before.length > 15);
  await run({ dryRun: true });
  assert.deepEqual(tree(root), before);
  await run();
  assert.deepEqual(tree(root), before);
  await run();
  assert.deepEqual(tree(root), before);
});

test("the report names no host path", async (t) => {
  const { base, root, run } = await setup(t);
  const text = JSON.stringify(await run());
  assert.equal(text.includes(root), false);
  assert.equal(text.includes(base), false);
  assert.equal(text.includes(root.split(path.sep).join("\\\\")), false);
  assert.equal(text.includes(os.tmpdir().split(path.sep).join("\\\\")), false);
});

test("access-logs resumes from the offset it ended at, and a rotated log is not imported twice", async (t) => {
  const { root, run, dbFile } = await setup(t);
  await run({ sources: ["access-logs"], chunkLines: 3 });
  const rowsAfterFirst = snapshot(dbFile).counts;
  assert.equal(rowsAfterFirst.requests, 5);
  assert.ok(rowsAfterFirst.import_runs >= 4, "one import_runs row per chunk");

  const managerFile = path.join(root, "vllm-manager", "logs", "service-gateway-access.log");
  const appended = { at: "2026-10-13T12:00:00.000Z", requestId: "req_dddddddddddddddddddd", method: "POST", path: "/serve/v1/chat/completions", status: 200,
    terminalState: "completed", model: "model-a", resolvedModel: "model-a", clientId: "client-5", durationMs: 100, inputTokens: 1, outputTokens: 2 };
  fs.appendFileSync(managerFile, `${JSON.stringify(appended)}\n`);
  const grown = byId(await run({ sources: ["access-logs"] }))["access-logs"];
  assert.equal(grown.rowsWritten, 1, "only the appended line");
  assert.equal(grown.rowsSkipped.already_imported, 14);
  assert.equal(snapshot(dbFile).counts.requests, 6);

  // The manager rotates its log: same content under a new name, then a fresh file.
  fs.renameSync(managerFile, `${managerFile}.1`);
  write(managerFile, lines([{ ...appended, at: "2026-10-13T13:00:00.000Z", requestId: "req_eeeeeeeeeeeeeeeeeeee" }]));
  const rotated = byId(await run({ sources: ["access-logs"] }))["access-logs"];
  assert.equal(rotated.rowsWritten, 1, "the rotated file keeps its cursor; only the new file's line is new");
  assert.equal(snapshot(dbFile).counts.requests, 7);
  const again = byId(await run({ sources: ["access-logs"] }))["access-logs"];
  assert.equal(again.rowsWritten, 0);
});

test("access-logs: a torn last line waits until it is complete", async (t) => {
  const { root, run, dbFile } = await setup(t, { sources: false });
  const file = path.join(root, "vllm-manager", "logs", "service-gateway-access.log");
  const entry = { at: "2026-10-13T12:00:00.000Z", method: "POST", path: "/serve/v1/chat/completions", status: 200, model: "model-a", clientId: "c", durationMs: 10 };
  const second = { ...entry, at: "2026-10-13T12:01:00.000Z" };
  const secondText = JSON.stringify(second);
  write(file, `${JSON.stringify(entry)}\n${secondText.slice(0, 30)}`);
  assert.equal((await run({ sources: ["access-logs"] })).rowsWritten, 1);
  fs.appendFileSync(file, `${secondText.slice(30)}\n`);
  assert.equal((await run({ sources: ["access-logs"] })).rowsWritten, 1);
  assert.equal(snapshot(dbFile).counts.requests, 2);
  fs.appendFileSync(file, JSON.stringify({ ...entry, at: "2026-10-13T12:02:00.000Z" }));
  assert.equal((await run({ sources: ["access-logs"] })).rowsWritten, 1, "a last line without a newline counts once it parses");
});

test("access-logs: rows older than the raw TTL are never inserted raw, whatever the TTL is", async (t) => {
  const { run, dbFile } = await setup(t);
  await run({ sources: ["access-logs"], retention: { requestsDays: 7, minuteDays: 14, hourDays: 400 } });
  readDb(dbFile, (db) => {
    const cutoff = NOW - 7 * DAY_MS;
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM requests WHERE received_at < ?", cutoff).n, 0);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM requests").n, 5, "all five recent rows are inside seven days too");
  });
  const second = await setup(t);
  await second.run({ sources: ["access-logs"], now: Date.parse("2026-11-30T00:00:00.000Z") });
  readDb(second.dbFile, (db) => {
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM requests").n, 0, "with a later clock every row is older than 30 days");
    assert.ok(cell(db, "SELECT SUM(requests) AS n FROM rollup_1h WHERE source = 'import'").n >= 5);
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM control_counts_1m").n, 0, "control counts only within 14 days");
  });
});

test("old hours beyond hourDays reach only the day grain", async (t) => {
  const { run, dbFile } = await setup(t);
  await run({ sources: ["access-logs"], retention: { requestsDays: 30, hourDays: 30 }, now: NOW + 100 * DAY_MS });
  readDb(dbFile, (db) => {
    assert.equal(cell(db, "SELECT COUNT(*) AS n FROM rollup_1h").n, 0);
    assert.ok(cell(db, "SELECT COUNT(*) AS n FROM rollup_1d WHERE source = 'import'").n >= 2);
  });
});

// --- unit pieces ------------------------------------------------------------------

test("canonicalManagerPath maps the manager's own gateway paths onto /gateway/<manager>/...", () => {
  const map = importers.canonicalManagerPath;
  assert.equal(map("/serve/v1/chat/completions", "vllm"), "/gateway/vllm/openai/v1/chat/completions");
  assert.equal(map("/opencode/v1/chat/completions", "llama"), "/gateway/llama/opencode/v1/chat/completions");
  assert.equal(map("/claude/v1/messages", "vllm"), "/gateway/vllm/claude/v1/messages");
  assert.equal(map("/v1/messages", "vllm"), "/gateway/vllm/claude/v1/messages");
  assert.equal(map("/v1/claude/messages", "vllm"), "/gateway/vllm/claude/v1/messages");
  assert.equal(map("/gateway/auto/openai/v1/models?x=1", "vllm"), "/gateway/auto/openai/v1/models");
  assert.equal(map("/health", "vllm"), "/health");
});

test("mapAccessEntry classifies like the live recorder", () => {
  const spec = { origin: "manager", managerId: "vllm", label: "x" };
  const traffic = importers.mapAccessEntry({ at: "2026-10-13T10:00:00.000Z", method: "post", path: "/serve/v1/chat/completions?x=1", status: 200, durationMs: 10 }, spec, 1);
  assert.equal(traffic.row.path, "/gateway/vllm/openai/v1/chat/completions");
  assert.equal(traffic.row.method, "POST");
  const aborted = importers.mapAccessEntry({ at: "2026-10-13T10:00:00.000Z", method: "POST", path: "/serve/v1/chat/completions", status: 499, terminalState: "client_abort" }, spec, 2);
  assert.deepEqual([aborted.row.terminal_state, aborted.row.error_class], ["client_abort", "client_abort"]);
  const control = importers.mapAccessEntry({ at: "2026-10-13T10:00:30.000Z", method: "GET", path: "/serve/v1/models", status: 200 }, spec, 3);
  assert.deepEqual(control.control, { bucket: Date.UTC(2026, 9, 13, 10, 0), route: "vllm", status_class: "2xx", at: Date.parse("2026-10-13T10:00:30.000Z") });
  assert.equal(importers.mapAccessEntry({ at: "x", method: "GET", path: "/serve/v1/models" }, spec, 4).skip, "invalid_timestamp");
  assert.equal(importers.mapAccessEntry({ at: "2026-10-13T10:00:30.000Z", method: "GET", path: "/nothing" }, spec, 5).skip, "not_gateway_path");
  assert.equal(importers.mapAccessEntry(null, spec, 6).skip, "invalid_row");
});

test("runImport rejects unknown or empty source lists and a missing store", async (t) => {
  const { run, store } = await setup(t, { sources: false });
  await assert.rejects(() => run({ sources: ["nope"] }), (error) => error.code === "unknown_import_source");
  await assert.rejects(() => run({ sources: [] }), (error) => error.code === "invalid_import_sources");
  await assert.rejects(() => importers.runImport({ aiRoot: os.tmpdir(), store: {} }), (error) => error.code === "invalid_store");
  await assert.rejects(() => importers.runImport({ store }), (error) => error.code === "invalid_ai_root");
  const empty = await run();
  assert.equal(empty.ok, true);
  assert.equal(empty.rowsIn, 0);
  assert.equal(empty.dryRun, false);
  assert.equal((await importers.runImport({ aiRoot: os.tmpdir(), store, sources: ["stats-ledger"], now: NOW })).dryRun, true, "a run is a dry run unless dryRun is false");
});

test("a source that fails is reported with a code and does not stop the others", async (t) => {
  const { root, run } = await setup(t, { sources: false });
  writeJson(path.join(root, "vllm-manager", "logs", "benchmark-history.json"), FIXTURE.benchmarks.vllm);
  let calls = 0;
  const flaky = {
    call: async (name, params) => {
      calls += 1;
      if (name === "importLookup" && params.source === "stats-ledger") throw Object.assign(new Error(`failed at ${root}`), { code: "telemetry_store_unavailable" });
      return null;
    },
    insertRequests: async () => ({ accepted: 0, duplicates: 0, rejected: 0 }),
    insertEvents: async (list) => ({ accepted: list.length, duplicates: 0, rejected: 0 }),
  };
  writeJson(path.join(root, "vllm-manager", "logs", "stats-ledger.json"), FIXTURE.statsLedger.vllm);
  const result = await importers.runImport({ aiRoot: root, store: flaky, sources: ["stats-ledger", "benchmarks"], dryRun: false, now: NOW });
  assert.ok(calls > 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ source: "stats-ledger", code: "telemetry_store_unavailable" }]);
  const reports = byId(result);
  assert.equal(reports["stats-ledger"].error, "telemetry_store_unavailable");
  assert.equal(reports.benchmarks.rowsWritten, 2);
  assert.equal(JSON.stringify(result).includes(root), false, "an error message with a path is never copied into the report");
});

test("the same import runs through the store worker thread", async (t) => {
  const { run, dbFile, close } = await setup(t, { inProcess: false });
  const first = await run({ sources: ["metrics-history", "stats-ledger", "access-logs", "service-usage", "jobs-ledger"] });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.rowsWritten, 9 + 2 + 10 + 1 + 9);
  const second = await run({ sources: ["metrics-history", "stats-ledger", "access-logs", "service-usage", "jobs-ledger"] });
  assert.equal(second.rowsWritten, 0);
  const dry = await run({ dryRun: true });
  assert.equal(dry.ok, true);
  await close();
  const counts = snapshot(dbFile).counts;
  assert.equal(counts.requests, 5);
  assert.equal(counts.gpu_rollup_1h, 5);
});
