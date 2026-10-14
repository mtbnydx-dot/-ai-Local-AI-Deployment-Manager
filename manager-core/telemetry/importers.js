"use strict";

// Importers (docs/overhaul/04-telemetry.md §18, TEL-18). They bring the
// history the platform already keeps on disk into the telemetry store:
//
//   metrics-history  GPU samples and request-counter deltas -> gpu_rollup_*,
//                    runtime_rollup_1h/_1d (throughput, latency and
//                    speculative fields are polling artefacts, never imported)
//   stats-ledger     lifetime counters -> lifetime_baseline (no time axis)
//   access-logs      manager and entry access logs -> requests; rows older
//                    than the raw TTL go straight into rollup_1h/rollup_1d
//   service-usage    tokens and usage_source onto the imported manager rows
//   jobs-ledger      launch.* events and gpu.guard events
//   process-exit     manager.* events;  audit-manifests -> audit.export;
//   benchmarks       benchmark.run;     mcp-audit -> mcp.tool_call
//
// Rules shared by every source:
// - Read-only on the sources. A file is only ever read (service-usage.sqlite
//   is read from a temporary copy), so its bytes never change.
// - Idempotent. import_runs(source, file_key) records what was applied, and
//   events and requests carry a dedupe key, so a second run writes 0 rows.
//   An access log is resumed from the offset its last chunk ended at.
// - runImport({dryRun: true}) reports the counts it would write and writes
//   nothing (worker-side steps run in a transaction that is rolled back).
// - Nothing here reads a prompt, a response or a secret: the access logs hold
//   metadata only, and paths in reports are labels relative to the AI root.
//
// Two halves live in this file. The main-thread half (runImport and the
// per-source runners) reads files and talks to the TelemetryStore. The
// worker half (WORKER_CALLS) is invoked through store.call() and runs next to
// the SQLite handle; store-worker.js resolves its names after query.js's.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const schema = require("./schema");
const rollups = require("./rollups");
const { classifyGatewayRoute } = require("./route-class");
const { classifyOutcome, statusClass } = require("./error-class");
const { inferSourceProgram } = require("./source-program");
const { normalizeClientRequestId } = require("./ids");
const { integrateEnergyWh } = require("./energy");
const { redactSecrets } = require("../secret-redactor");

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Source ids, in the order a run executes them (access-logs before
// service-usage, which backfills the rows access-logs wrote).
const IMPORT_SOURCES = Object.freeze([
  "metrics-history",
  "stats-ledger",
  "access-logs",
  "service-usage",
  "jobs-ledger",
  "process-exit",
  "audit-manifests",
  "benchmarks",
  "mcp-audit",
]);

const ACCESS_LOG_ROTATIONS = 5;
const CHUNK_LINES = 2000;
const MATCH_WINDOW_MS = 2000;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_WARNINGS = 20;
const MCP_EVENT_DAYS = 90;
// metrics-history is sampled at most once a minute (createMetricsHistoryStore).
const METRICS_INTERVAL_MS = MINUTE_MS;
const IMPORT_RUN_DONE = "done";
const FLEET_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}:[^\s]{1,120}$/;
const EXISTING_TABLES = Object.freeze({ requests: "request_id", events: "dedupe_key" });
const WORKER_BATCH = 500;

// ------------------------------------------------------------ small helpers

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function intOrNull(value) {
  const number = finite(value);
  return number === null ? null : Math.round(number);
}

function nonNegativeInt(value) {
  const number = intOrNull(value);
  return number === null ? 0 : Math.max(0, number);
}

function floorTo(at, size) {
  return Math.floor(at / size) * size;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function events() {
  return require("./collectors/events");
}

function timestampOf(value) {
  return events().toMs(value);
}

function clipText(value, max) {
  return events().text(value, max);
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function labelOf(ctx, file) {
  const relative = path.relative(ctx.aiRoot, file);
  const label = inside(ctx.aiRoot, file) ? relative : path.basename(file);
  return label.split(path.sep).join("/");
}

function ttlFrom(input) {
  const ttl = { ...schema.TTL_DEFAULTS };
  if (isPlainObject(input)) {
    for (const key of Object.keys(ttl)) {
      const value = finite(input[key]);
      if (value !== null && value > 0) ttl[key] = value;
    }
  }
  return ttl;
}

// ------------------------------------------------------------ report

function newReport(source) {
  return { source, files: 0, rowsIn: 0, rowsWritten: 0, rowsSkipped: {}, rangeFrom: null, rangeTo: null, warnings: [] };
}

function addWarning(report, message) {
  const line = redactSecrets(String(message));
  if (report.warnings.length < MAX_WARNINGS && !report.warnings.includes(line)) report.warnings.push(line);
}

function countSkipped(rowsSkipped) {
  return Object.values(rowsSkipped).reduce((sum, value) => sum + value, 0);
}

// Counts of one unit of work (a file or a chunk of one). rowsIn always equals
// rowsWritten plus the skipped counts.
function newTally() {
  return { rowsIn: 0, rowsWritten: 0, rowsSkipped: {}, from: null, to: null };
}

function tallySkip(tally, reason, count = 1) {
  if (count <= 0) return;
  tally.rowsIn += count;
  tally.rowsSkipped[reason] = (tally.rowsSkipped[reason] || 0) + count;
}

function tallyWrite(tally, count = 1) {
  if (count <= 0) return;
  tally.rowsIn += count;
  tally.rowsWritten += count;
}

// Rows of an earlier run that this run saw again.
function tallyAlready(tally, count) {
  tallySkip(tally, "already_imported", count);
}

function tallySeen(tally, at) {
  if (!Number.isFinite(at)) return;
  if (tally.from === null || at < tally.from) tally.from = at;
  if (tally.to === null || at > tally.to) tally.to = at;
}

function mergeTally(report, tally) {
  report.rowsIn += tally.rowsIn;
  report.rowsWritten += tally.rowsWritten;
  for (const [reason, count] of Object.entries(tally.rowsSkipped)) {
    report.rowsSkipped[reason] = (report.rowsSkipped[reason] || 0) + count;
  }
  if (tally.from !== null && (report.rangeFrom === null || tally.from < report.rangeFrom)) report.rangeFrom = tally.from;
  if (tally.to !== null && (report.rangeTo === null || tally.to > report.rangeTo)) report.rangeTo = tally.to;
}

function isoOrNull(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function finalizeReport(report) {
  report.rangeFrom = isoOrNull(report.rangeFrom);
  report.rangeTo = isoOrNull(report.rangeTo);
  return report;
}

// ------------------------------------------------------------ file helpers

async function statFile(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// { ok, value } or { ok: false, code }. Never throws and never includes a
// path in the code.
async function readJsonSource(file, stat) {
  if (stat.size > MAX_JSON_BYTES) return { ok: false, code: "file_too_large" };
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    return { ok: false, code: `read_failed_${String(error && error.code ? error.code : "error").toLowerCase()}` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: "invalid_json" };
  }
}

// Complete lines from byte offset `start` up to `end`, as {text, offset,
// next, partial}. A last line without a newline is yielded with partial:
// true; the caller accepts it only when it parses.
async function* readLines(file, start, end) {
  const handle = await fsp.open(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let position = start;
    let carry = Buffer.alloc(0);
    let carryStart = start;
    while (position < end) {
      const want = Math.min(chunk.length, end - position);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : Buffer.from(chunk.subarray(0, bytesRead));
      let from = 0;
      for (;;) {
        const newline = data.indexOf(10, from);
        if (newline === -1) break;
        let lineEnd = newline;
        if (lineEnd > from && data[lineEnd - 1] === 13) lineEnd -= 1;
        yield { text: data.toString("utf8", from, lineEnd), offset: carryStart + from, next: carryStart + newline + 1, partial: false };
        from = newline + 1;
      }
      carry = data.subarray(from);
      carryStart += from;
    }
    if (carry.length) {
      let lineEnd = carry.length;
      if (carry[lineEnd - 1] === 13) lineEnd -= 1;
      yield { text: carry.toString("utf8", 0, lineEnd), offset: carryStart, next: carryStart + carry.length, partial: true };
    }
  } finally {
    await handle.close();
  }
}

async function readEdge(file, position, length) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// The first complete line of a file identifies its generation: a log that is
// rotated keeps its first line, so its label (and import cursor) survives the
// rename to .1, .2, ...
async function firstLineOf(file, stat) {
  if (stat.size === 0) return null;
  const head = await readEdge(file, 0, Math.min(stat.size, 8192));
  const newline = head.indexOf(10);
  return newline === -1 ? null : head.toString("utf8", 0, newline).replace(/\r$/, "");
}

async function lastLineOf(file, stat) {
  if (stat.size === 0) return null;
  const length = Math.min(stat.size, 16384);
  const tail = (await readEdge(file, stat.size - length, length)).toString("utf8").split("\n").map((line) => line.replace(/\r$/, ""));
  for (let index = tail.length - 1; index >= 0; index -= 1) if (tail[index].trim()) return tail[index];
  return null;
}

function fileKeyFor(label, stat, offset = 0) {
  return `${label}|${stat.size}|${Math.floor(stat.mtimeMs)}|${offset}`;
}

// ------------------------------------------------------------ context

function resolveManagers(aiRoot, input) {
  const list = Array.isArray(input) && input.length ? input : [{ id: "vllm" }, { id: "llama" }];
  const managers = [];
  for (const item of list) {
    const id = String(item && item.id ? item.id : "").trim();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) continue;
    const root = item.root ? path.resolve(String(item.root)) : path.join(aiRoot, `${id}-manager`);
    if (inside(aiRoot, root)) managers.push({ id, root });
  }
  return managers;
}

function envPathInside(aiRoot, value, fallback) {
  if (!value) return fallback;
  const file = path.resolve(String(value));
  return inside(aiRoot, file) ? file : fallback;
}

function createContext(options, store) {
  if (typeof options.aiRoot !== "string" || !options.aiRoot.trim()) throw codedError("invalid_ai_root", "runImport needs options.aiRoot.");
  const aiRoot = path.resolve(options.aiRoot);
  const env = isPlainObject(options.env) ? options.env : process.env;
  const clock = typeof options.now === "function" ? options.now : () => Number(options.now) || Date.now();
  const now = Number(clock());
  const ttl = ttlFrom(options.retention);
  const dryRun = options.dryRun !== false;
  const progressFn = typeof options.onProgress === "function" ? options.onProgress : null;
  const ctx = {
    aiRoot,
    store,
    dryRun,
    now,
    ttl,
    cutoffs: {
      requests: now - ttl.requestsDays * DAY_MS,
      minute: now - ttl.minuteDays * DAY_MS,
      hour: now - ttl.hourDays * DAY_MS,
      events: now - ttl.eventsDays * DAY_MS,
      mcp: now - MCP_EVENT_DAYS * DAY_MS,
    },
    timezoneOffsetMinutes: options.timezoneOffsetMinutes === undefined ? null : options.timezoneOffsetMinutes,
    managers: resolveManagers(aiRoot, options.managers),
    entryRoot: options.entryRoot ? path.resolve(String(options.entryRoot)) : path.join(aiRoot, "service-entry"),
    auditRoot: envPathInside(aiRoot, options.auditRoot || env.AI_AUDIT_ROOT, path.join(aiRoot, "audit-logs")),
    mcpAuditLog: envPathInside(aiRoot, options.mcpAuditLog || env.PLATFORM_MCP_AUDIT_LOG, path.join(aiRoot, "audit-logs", "platform-mcp.jsonl")),
    chunkLines: Math.max(1, Math.floor(Number(options.chunkLines)) || CHUNK_LINES),
    tempRoot: options.tempRoot ? path.resolve(String(options.tempRoot)) : os.tmpdir(),
    progress(source, extra = {}) {
      if (!progressFn) return;
      try {
        progressFn({ source, ...extra });
      } catch {
        // A progress listener never breaks an import.
      }
    },
  };
  ctx.sink = createSink(ctx);
  return ctx;
}

// What reaches the store. In a dry run nothing is written: row inserts are
// answered from a probe of the existing keys, and worker steps run in a
// transaction that is rolled back.
function createSink(ctx) {
  const store = ctx.store;
  const seen = { requests: new Set(), events: new Set() };

  async function existing(table, keys) {
    const found = new Set();
    for (let index = 0; index < keys.length; index += WORKER_BATCH) {
      const part = await store.call("importExisting", { table, keys: keys.slice(index, index + WORKER_BATCH) });
      for (const key of part) found.add(key);
    }
    return found;
  }

  async function insert(table, rows, keyOf, method) {
    if (!rows.length) return { accepted: 0, duplicates: 0, rejected: 0 };
    if (ctx.dryRun) {
      const keys = rows.map(keyOf).filter(Boolean);
      const present = keys.length ? await existing(table, keys) : new Set();
      let accepted = 0;
      let duplicates = 0;
      for (const row of rows) {
        const key = keyOf(row);
        if (key && (present.has(key) || seen[table].has(key))) duplicates += 1;
        else {
          accepted += 1;
          if (key) seen[table].add(key);
        }
      }
      return { accepted, duplicates, rejected: 0 };
    }
    for (let attempt = 0; ; attempt += 1) {
      const result = await store[method](rows);
      if (result && result.error && result.retryable && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        continue;
      }
      if (result && result.error) throw codedError(String(result.error));
      return {
        accepted: Number(result && result.accepted) || 0,
        duplicates: Number(result && result.duplicates) || 0,
        rejected: Number(result && result.rejected) || 0,
      };
    }
  }

  return {
    insertRequests: (rows) => insert("requests", rows, (row) => row.request_id, "insertRequests"),
    insertEvents: (list) => insert("events", list, (event) => event.dedupeKey || null, "insertEvents"),
    lookup: (params) => store.call("importLookup", params),
    apply: (params) => store.call("importApply", { ...params, dryRun: ctx.dryRun, timezoneOffsetMinutes: ctx.timezoneOffsetMinutes, cutoffs: ctx.cutoffs }),
    record: (params) => (ctx.dryRun ? Promise.resolve({ ok: true, dryRun: true }) : store.call("importRecord", params)),
  };
}

function runRow(ctx, source, fileKey, startedAt, tally, detail) {
  return {
    source,
    fileKey,
    startedAt,
    finishedAt: Date.now(),
    rowsIn: tally.rowsIn,
    rowsWritten: tally.rowsWritten,
    rowsSkipped: countSkipped(tally.rowsSkipped),
    status: IMPORT_RUN_DONE,
    detail: detail || null,
  };
}

// Counts of a file that an earlier run applied completely.
function markAlready(tally, previous) {
  tallyAlready(tally, Math.max(0, Number(previous && previous.rows_in) || 0));
}

// ------------------------------------------------------------ events

function eventCutoff(ctx, type) {
  const retention = schema.EVENT_RETENTION;
  if (retention.foreverTypes.includes(type) || retention.foreverPrefixes.some((prefix) => type.startsWith(prefix))) return -Infinity;
  if (retention.fixedDays[type]) return ctx.now - retention.fixedDays[type] * DAY_MS;
  return ctx.cutoffs.events;
}

// Writes event rows and tallies one row per event.
async function writeEvents(ctx, tally, list) {
  const keep = [];
  for (const event of list) {
    tallySeen(tally, event.at);
    if (event.at < eventCutoff(ctx, event.type)) tallySkip(tally, "older_than_events_ttl");
    else keep.push(event);
  }
  for (let index = 0; index < keep.length; index += 1000) {
    const batch = keep.slice(index, index + 1000);
    const result = await ctx.sink.insertEvents(batch);
    tallyWrite(tally, result.accepted);
    tallySkip(tally, "duplicate", result.duplicates);
    tallySkip(tally, "rejected_row", result.rejected);
  }
}

// ------------------------------------------------------------ metrics-history

function gpuOfSample(sample) {
  const gpu = isPlainObject(sample.gpu) ? sample.gpu : {};
  const row = {
    mem_used_mb: finite(gpu.usedMb),
    mem_total_mb: finite(gpu.totalMb),
    util_pct: finite(gpu.utilizationPercent),
    temp_c: finite(gpu.temperatureC),
    power_w: finite(gpu.powerWatts),
  };
  const present = Object.values(row).some((value) => value !== null);
  // The sample sums several GPUs when the manager recorded their count.
  const count = finite(gpu.count) || (Array.isArray(gpu.gpus) ? gpu.gpus.length : 0);
  return present ? { ...row, gpu_index: count > 1 ? -1 : 0 } : null;
}

function buildMetricsPlan(ctx, managerId, rawSamples) {
  const gpuFamily = rollups.FAMILIES.gpu;
  const samples = [];
  rawSamples.forEach((sample, index) => {
    if (!isPlainObject(sample)) return samples.push({ index, invalid: true });
    const at = timestampOf(sample.at);
    return samples.push(at === null ? { index, invalid: true } : { index, at, sample });
  });
  const valid = samples.filter((item) => !item.invalid).sort((a, b) => a.at - b.at || a.index - b.index);
  const plan = { samples, valid, firstAt: null, lastAt: null, gpu: { rows1m: [], rows1h: [] }, runtime: { rows1h: [] } };
  if (!valid.length) return plan;
  plan.firstAt = valid[0].at;
  plan.lastAt = valid[valid.length - 1].at;
  const closed = (bucket, size) => bucket + size <= plan.lastAt;

  // GPU: one rollup group per (minute, gpu_index), energy integrated from the
  // power readings (gaps are capped at two sample intervals, §8).
  const minutes = new Map();
  const previous = new Map();
  for (const item of valid) {
    const gpu = gpuOfSample(item.sample);
    item.gpu = Boolean(gpu);
    if (!gpu) continue;
    const last = previous.get(gpu.gpu_index);
    const energy = last ? integrateEnergyWh({ at: last }, { at: item.at, powerW: gpu.power_w }, { intervalMs: METRICS_INTERVAL_MS }) : null;
    previous.set(gpu.gpu_index, item.at);
    const bucket = floorTo(item.at, MINUTE_MS);
    const id = `${bucket}|${gpu.gpu_index}`;
    let group = minutes.get(id);
    if (!group) {
      group = { bucket, group: gpuFamily.newGroup({ gpu_index: gpu.gpu_index }) };
      minutes.set(id, group);
    }
    gpuFamily.addRaw(group.group, { ...gpu, energy_wh: energy === null ? 0 : energy, throttle: null }, METRICS_INTERVAL_MS);
  }
  const minuteRows = [...minutes.values()]
    .filter((entry) => closed(entry.bucket, MINUTE_MS))
    .sort((a, b) => a.bucket - b.bucket || a.group.key.gpu_index - b.group.key.gpu_index)
    .map((entry) => gpuFamily.finish(entry.group, entry.bucket));
  plan.gpu.rows1m = minuteRows.filter((row) => row.bucket >= ctx.cutoffs.minute);
  const hours = new Map();
  for (const row of minuteRows) {
    const bucket = floorTo(row.bucket, HOUR_MS);
    if (!closed(bucket, HOUR_MS) || bucket < ctx.cutoffs.hour) continue;
    const id = `${bucket}|${row.gpu_index}`;
    let group = hours.get(id);
    if (!group) {
      group = { bucket, group: gpuFamily.newGroup({ gpu_index: row.gpu_index }) };
      hours.set(id, group);
    }
    gpuFamily.fold(group.group, row);
  }
  plan.gpu.rows1h = [...hours.values()]
    .sort((a, b) => a.bucket - b.bucket || a.group.key.gpu_index - b.group.key.gpu_index)
    .map((entry) => gpuFamily.finish(entry.group, entry.bucket));

  // Runtime: requests.total deltas per (engine, model); a decrease or a new
  // container is a reset and has no delta.
  const series = new Map();
  const runtime = new Map();
  for (const item of valid) {
    const sample = item.sample;
    const model = events().modelLabel(sample.model);
    const engine = clipText(sample.engine, 32);
    const container = clipText(sample.container, 128);
    const total = isPlainObject(sample.requests) ? finite(sample.requests.total) : null;
    const id = `${engine}|${model}`;
    if (total === null) continue;
    const last = series.get(id);
    series.set(id, { container, total });
    if (!last) continue;
    const bucket = floorTo(item.at, HOUR_MS);
    const key = `${bucket}|${id}`;
    let entry = runtime.get(key);
    if (!entry) {
      entry = { bucket, model, engine, samples: 0, resets: 0, delta: null };
      runtime.set(key, entry);
    }
    entry.samples += 1;
    item.runtime = true;
    if (last.total === null || last.container !== container || total < last.total) entry.resets += 1;
    else entry.delta = (entry.delta || 0) + (total - last.total);
  }
  plan.runtime.rows1h = [...runtime.values()]
    .filter((entry) => closed(entry.bucket, HOUR_MS) && entry.bucket >= ctx.cutoffs.hour && (entry.delta !== null || entry.resets > 0))
    .sort((a, b) => a.bucket - b.bucket || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    .map((entry) => ({
      bucket: entry.bucket,
      fleet_id: `${managerId}:primary`,
      model: entry.model,
      manager_id: managerId,
      engine_id: entry.engine || null,
      sample_count: entry.samples,
      resets: entry.resets,
      d_requests: entry.delta,
    }));
  return plan;
}

async function importMetricsHistory(ctx) {
  const report = newReport("metrics-history");
  addWarning(report, "Throughput, latency and speculative fields are not imported: they are polling artefacts and lifetime averages.");
  for (const manager of ctx.managers) {
    const file = path.join(manager.root, "logs", "metrics-history.json");
    const stat = await statFile(file);
    if (!stat) continue;
    report.files += 1;
    const label = labelOf(ctx, file);
    const fileKey = fileKeyFor(label, stat);
    const tally = newTally();
    const startedAt = Date.now();
    const done = await ctx.sink.lookup({ source: "metrics-history", fileKey });
    if (done) {
      markAlready(tally, done);
      mergeTally(report, tally);
      continue;
    }
    const parsed = await readJsonSource(file, stat);
    if (!parsed.ok || !isPlainObject(parsed.value) || !Array.isArray(parsed.value.samples)) {
      addWarning(report, `${label}: ${parsed.ok ? "unexpected_shape" : parsed.code}`);
      continue;
    }
    const plan = buildMetricsPlan(ctx, manager.id, parsed.value.samples);
    let applied = { inserted: {} };
    if (plan.valid.length) {
      applied = await ctx.sink.apply({
        source: "metrics-history",
        gpu: { rows1m: plan.gpu.rows1m, rows1h: plan.gpu.rows1h, firstAt: plan.firstAt, lastAt: plan.lastAt },
        runtime: { rows1h: plan.runtime.rows1h, firstAt: plan.firstAt, lastAt: plan.lastAt },
      });
    }
    const insertedGpu = new Set((applied.inserted && applied.inserted.gpu_rollup_1h) || []);
    const insertedRuntime = new Set((applied.inserted && applied.inserted.runtime_rollup_1h) || []);
    for (const item of plan.samples) {
      if (item.invalid) {
        tallySkip(tally, "invalid_row");
        continue;
      }
      tallySeen(tally, item.at);
      const hour = floorTo(item.at, HOUR_MS);
      if (!item.gpu && !item.runtime) tallySkip(tally, "no_importable_fields");
      else if (hour < ctx.cutoffs.hour) tallySkip(tally, "older_than_ttl");
      else if (hour + HOUR_MS > plan.lastAt) tallySkip(tally, "open_bucket");
      else if (insertedGpu.has(hour) || insertedRuntime.has(hour)) tallyWrite(tally);
      else tallySkip(tally, "bucket_exists");
    }
    await ctx.sink.record(runRow(ctx, "metrics-history", fileKey, startedAt, tally, { samples: plan.valid.length }));
    mergeTally(report, tally);
    ctx.progress("metrics-history", { files: report.files, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
  }
  return report;
}

// ------------------------------------------------------------ stats-ledger

async function importStatsLedger(ctx) {
  const report = newReport("stats-ledger");
  addWarning(report, "Ledger totals have no time axis: they are stored as a lifetime baseline only.");
  for (const manager of ctx.managers) {
    const file = path.join(manager.root, "logs", "stats-ledger.json");
    const stat = await statFile(file);
    if (!stat) continue;
    report.files += 1;
    const label = labelOf(ctx, file);
    const fileKey = fileKeyFor(label, stat);
    const tally = newTally();
    const startedAt = Date.now();
    const done = await ctx.sink.lookup({ source: "stats-ledger", fileKey });
    if (done) {
      markAlready(tally, done);
      mergeTally(report, tally);
      continue;
    }
    const parsed = await readJsonSource(file, stat);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      addWarning(report, `${label}: ${parsed.ok ? "unexpected_shape" : parsed.code}`);
      continue;
    }
    const ledger = parsed.value;
    const createdAt = timestampOf(ledger.createdAt);
    const rows = [];
    const entries = isPlainObject(ledger.models) ? Object.entries(ledger.models) : [];
    for (const [key, item] of entries) {
      if (!isPlainObject(item)) {
        tallySkip(tally, "invalid_row");
        continue;
      }
      const model = events().modelLabel(item.name || key);
      const tokens = isPlainObject(item.tokens) ? item.tokens : {};
      const requests = isPlainObject(item.requests) ? item.requests : {};
      const last = isPlainObject(item.last) ? item.last : {};
      if (!model) {
        tallySkip(tally, "invalid_row");
        continue;
      }
      const row = {
        manager_id: manager.id,
        model,
        engine: events().slug(last.engine, 32) || null,
        first_seen: createdAt,
        last_seen: timestampOf(last.updatedAt) ?? timestampOf(ledger.updatedAt),
        prompt_tokens: nonNegativeInt(tokens.prompt),
        cached_tokens: nonNegativeInt(tokens.cachedPrompt),
        output_tokens: nonNegativeInt(tokens.generation),
        requests: nonNegativeInt(requests.total),
        errors: nonNegativeInt(requests.error),
        source: "stats-ledger",
        imported_at: ctx.now,
      };
      if (!row.prompt_tokens && !row.output_tokens && !row.requests) {
        tallySkip(tally, "empty_counters");
        continue;
      }
      tallySeen(tally, row.last_seen);
      rows.push(row);
    }
    if (rows.length) {
      const applied = await ctx.sink.apply({ source: "stats-ledger", baseline: rows });
      for (const outcome of applied.baseline || []) {
        if (outcome === "unchanged") tallySkip(tally, "unchanged");
        else tallyWrite(tally);
      }
    }
    await ctx.sink.record(runRow(ctx, "stats-ledger", fileKey, startedAt, tally, null));
    mergeTally(report, tally);
    ctx.progress("stats-ledger", { files: report.files, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
  }
  return report;
}

// ------------------------------------------------------------ access-logs

// The manager's own paths (manager-core gateway-utils getServiceGatewayKind)
// map onto the gateway paths route-class.js understands.
function canonicalManagerPath(pathname, managerId) {
  const clean = String(pathname || "").split("?")[0];
  if (clean.startsWith("/gateway/")) return clean;
  const serve = clean.match(/^\/serve\/v1(\/.*)?$/);
  if (serve) return `/gateway/${managerId}/openai/v1${serve[1] || ""}`;
  const opencode = clean.match(/^\/opencode\/v1(\/.*)?$/);
  if (opencode) return `/gateway/${managerId}/opencode/v1${opencode[1] || ""}`;
  const claude = clean.match(/^\/claude(\/.*)?$/);
  if (claude) return `/gateway/${managerId}/claude${claude[1] || ""}`;
  const claudeV1 = clean.match(/^\/v1\/claude(\/.*)?$/);
  if (claudeV1) return `/gateway/${managerId}/claude/v1${claudeV1[1] || ""}`;
  if (clean === "/v1/messages" || clean.startsWith("/v1/messages/")) return `/gateway/${managerId}/claude${clean}`;
  return clean;
}

function hostOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).host.slice(0, 120) || null;
  } catch {
    return null;
  }
}

const FINISH_REASONS = Object.freeze({
  stop: "stop", end_turn: "stop", stop_sequence: "stop",
  length: "length", max_tokens: "length",
  tool_calls: "tool_calls", tool_use: "tool_calls", function_call: "tool_calls",
  content_filter: "content_filter",
});

function finishReasonOf(value) {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return null;
  return FINISH_REASONS[key] || "other";
}

function importRequestId(label, lineNo, at) {
  return `imp_${sha256(`${label}\n${lineNo}\n${at}`).slice(0, 20)}`;
}

function fleetIdFor(managerId, resolvedInstance) {
  const value = String(resolvedInstance || "").trim();
  if (!value) return null;
  if (FLEET_ID_PATTERN.test(value)) return value;
  return managerId && /^[A-Za-z0-9._-]{1,120}$/.test(value) ? `${managerId}:${value}` : null;
}

// One access-log entry -> { skip } | { control: {bucket, route, statusClass,
// row?} } | { row }. `spec` is {origin: "manager"|"entry", managerId, label}.
function mapAccessEntry(entry, spec, lineNo) {
  if (!isPlainObject(entry)) return { skip: "invalid_row" };
  const atMs = Date.parse(String(entry.at || ""));
  if (!Number.isFinite(atMs)) return { skip: "invalid_timestamp" };
  const method = String(entry.method || "").toUpperCase();
  const rawPath = String(entry.path || "").split("?")[0];
  const canonical = spec.origin === "manager" ? canonicalManagerPath(rawPath, spec.managerId) : rawPath;
  const route = classifyGatewayRoute(method, canonical);
  if (!route) return { skip: "not_gateway_path" };
  const status = nonNegativeInt(entry.status);
  const durationMs = nonNegativeInt(entry.durationMs);
  const aborted = entry.terminalState === "client_abort" || status === 499;
  const code = /^[a-z0-9_.-]{1,64}$/.test(String(entry.error || "")) ? String(entry.error) : "";
  const outcome = classifyOutcome({ phase: status >= 400 ? "upstream" : "stream", status, code, aborted });
  // §5.5: a control request is only counted, unless its status keeps it
  // visible (auth storms and server errors).
  const visible = status === 401 || status === 403 || status === 429 || status >= 500;
  if (route.kind !== "traffic" && !visible) {
    return { control: { bucket: floorTo(atMs, MINUTE_MS), route: route.route, status_class: statusClass(status), at: atMs } };
  }
  const inputTokens = nonNegativeInt(entry.inputTokens);
  const outputTokens = nonNegativeInt(entry.outputTokens);
  const reported = inputTokens + outputTokens > 0;
  const toolSchemaCount = nonNegativeInt(entry.toolSchemaCount);
  const toolUseCount = nonNegativeInt(entry.toolUseCount);
  const extra = {};
  if (toolSchemaCount) extra.toolSchemaCount = toolSchemaCount;
  if (toolUseCount) extra.toolUseCount = toolUseCount;
  const userAgent = clipText(entry.userAgent, 240) || null;
  const managerId = spec.origin === "manager" ? spec.managerId : (/^(vllm|llama)$/.test(route.route) ? route.route : null);
  const model = clipText(entry.model, 160);
  const resolved = clipText(entry.resolvedModel, 220);
  const row = {
    request_id: importRequestId(spec.label, lineNo, String(entry.at)),
    client_request_id: null,
    manager_request_id: normalizeClientRequestId(entry.requestId) || null,
    ingress: spec.origin === "manager" ? "import:manager" : "import:entry",
    received_at: atMs - durationMs,
    ended_at: atMs,
    manager_id: managerId,
    fleet_id: fleetIdFor(managerId, entry.resolvedInstance),
    engine_id: null,
    runtime_id: null,
    launch_id: null,
    protocol: route.protocol,
    op: route.op,
    route: route.route,
    method: method || "GET",
    path: canonical.slice(0, 200),
    model_requested: model || null,
    model_resolved: resolved || model || null,
    stream: entry.stream ? 1 : 0,
    key_id: clipText(entry.clientId, 128) || null,
    customer_id: null,
    auth_source: clipText(entry.authSource, 64) || null,
    client_ip: clipText(entry.remoteAddress, 64) || null,
    client_country: null,
    user_agent: userAgent,
    origin_host: hostOf(entry.origin) || hostOf(entry.refererHost),
    source_program: inferSourceProgram({
      userAgent,
      origin: clipText(entry.origin, 240),
      referer: clipText(entry.refererHost, 240),
      protocol: route.protocol,
      path: rawPath,
      xTitle: "",
    }),
    owui_user_id: null,
    owui_chat_id: null,
    status,
    terminal_state: outcome.terminalState,
    error_class: outcome.errorClass,
    error_code: outcome.errorCode,
    queue_ms: intOrNull(entry.queuedMs) === null ? null : Math.max(0, intOrNull(entry.queuedMs)),
    upstream_headers_ms: null,
    ttft_ms: null,
    duration_ms: durationMs,
    decode_tps: null,
    prompt_tokens: reported ? inputTokens : null,
    cached_tokens: null,
    output_tokens: reported ? outputTokens : null,
    reasoning_tokens: null,
    usage_source: reported ? "reported" : "missing",
    finish_reason: finishReasonOf(entry.stopReason),
    bytes_out: null,
    engine_prompt_ms: null,
    engine_decode_tps: null,
    engine_cached_tokens: null,
    extra,
  };
  return { row };
}

// Manager rows of the time window, for the "entry row duplicates a manager
// row" match (§18): same model and status within 2 s; an identical request id
// wins when both sides have one.
async function buildManagerIndex(ctx, from, to) {
  const index = [];
  for (const manager of ctx.managers) {
    const base = path.join(manager.root, "logs", "service-gateway-access.log");
    for (const file of accessLogFiles(base)) {
      const stat = await statFile(file.path);
      if (!stat) continue;
      const first = await firstLineOf(file.path, stat);
      if (first === null) continue;
      const label = `${labelOf(ctx, base)}#${sha256(first).slice(0, 8)}`;
      let lineNo = 0;
      for await (const record of readLines(file.path, 0, stat.size)) {
        lineNo += 1;
        if (record.partial) continue;
        let entry;
        try {
          entry = JSON.parse(record.text);
        } catch {
          continue;
        }
        const t = isPlainObject(entry) ? Date.parse(String(entry.at || "")) : Number.NaN;
        if (!Number.isFinite(t) || t < from - MATCH_WINDOW_MS || t > to + MATCH_WINDOW_MS) continue;
        index.push({
          t,
          model: String(entry.resolvedModel || entry.model || "").toLowerCase(),
          requested: String(entry.model || "").toLowerCase(),
          status: nonNegativeInt(entry.status),
          rid: normalizeClientRequestId(entry.requestId),
          id: importRequestId(label, lineNo, String(entry.at)),
          used: false,
        });
      }
    }
  }
  index.sort((a, b) => a.t - b.t);
  return index;
}

function findDuplicate(index, row) {
  if (!index || !index.length) return null;
  let low = 0;
  let high = index.length;
  const wanted = row.ended_at - MATCH_WINDOW_MS;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (index[mid].t < wanted) low = mid + 1;
    else high = mid;
  }
  const model = String(row.model_resolved || "").toLowerCase();
  const requested = String(row.model_requested || "").toLowerCase();
  let best = null;
  for (let at = low; at < index.length && index[at].t <= row.ended_at + MATCH_WINDOW_MS; at += 1) {
    const candidate = index[at];
    if (candidate.used || candidate.status !== row.status) continue;
    const sameRequest = Boolean(candidate.rid) && candidate.rid === row.manager_request_id;
    const sameModel = candidate.model === model || candidate.requested === requested;
    if (!sameRequest && !sameModel) continue;
    const distance = Math.abs(candidate.t - row.ended_at) - (sameRequest ? MATCH_WINDOW_MS * 2 : 0);
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  if (!best) return null;
  best.candidate.used = true;
  return best.candidate.id;
}

function accessLogFiles(base) {
  const files = [];
  for (let rotation = ACCESS_LOG_ROTATIONS; rotation >= 1; rotation -= 1) files.push({ path: `${base}.${rotation}`, suffix: `.${rotation}` });
  files.push({ path: base, suffix: "" });
  return files;
}

async function planAccessLogs(ctx) {
  const groups = [];
  const sources = [
    ...ctx.managers.map((manager) => ({ origin: "manager", managerId: manager.id, base: path.join(manager.root, "logs", "service-gateway-access.log") })),
    { origin: "entry", managerId: null, base: path.join(ctx.entryRoot, "logs", "gateway-access.log") },
  ];
  for (const source of sources) {
    for (const file of accessLogFiles(source.base)) {
      const stat = await statFile(file.path);
      if (!stat || stat.size === 0) continue;
      const first = await firstLineOf(file.path, stat);
      if (first === null) continue;
      const baseLabel = labelOf(ctx, source.base);
      groups.push({
        ...source,
        file: file.path,
        stat,
        label: `${baseLabel}#${sha256(first).slice(0, 8)}`,
        display: `${baseLabel}${file.suffix}`,
      });
    }
  }
  return groups;
}

function addOldRequest(oldHours, family, row) {
  const bucket = floorTo(row.received_at, HOUR_MS);
  const key = family.keyOfRaw(row);
  key.source = "import";
  const id = `${bucket}|${JSON.stringify(family.key.map((name) => key[name]))}`;
  let entry = oldHours.get(id);
  if (!entry) {
    entry = { bucket, group: family.newGroup(key) };
    oldHours.set(id, entry);
  }
  family.addRaw(entry.group, row);
}

async function importAccessLogs(ctx) {
  const report = newReport("access-logs");
  const family = rollups.FAMILIES.requests;
  const files = await planAccessLogs(ctx);
  let managerIndex = null;

  // The entry logs' time window decides which manager rows are indexed.
  async function ensureManagerIndex() {
    if (managerIndex) return managerIndex;
    let from = Infinity;
    let to = -Infinity;
    for (const item of files.filter((entry) => entry.origin === "entry")) {
      for (const text of [await firstLineOf(item.file, item.stat), await lastLineOf(item.file, item.stat)]) {
        try {
          const at = Date.parse(String(JSON.parse(text).at || ""));
          if (Number.isFinite(at)) {
            from = Math.min(from, at);
            to = Math.max(to, at);
          }
        } catch {
          // A torn last line has no time.
        }
      }
    }
    managerIndex = Number.isFinite(from) ? await buildManagerIndex(ctx, from, to) : [];
    return managerIndex;
  }

  for (const item of files) {
    report.files += 1;
    const { stat, label } = item;
    const spec = { origin: item.origin, managerId: item.managerId, label };
    const cursorRow = await ctx.sink.lookup({ source: "access-logs", prefix: `${label}|` });
    const cursor = cursorRow && cursorRow.detail && Number.isFinite(Number(cursorRow.detail.endOffset)) ? cursorRow.detail : null;
    let start = 0;
    let lineNo = 0;
    let doneRows = 0;
    if (cursor && Number(cursor.endOffset) <= stat.size) {
      start = Number(cursor.endOffset);
      lineNo = Number(cursor.lines) || 0;
      doneRows = Number(cursor.rows) || 0;
      const previous = newTally();
      tallyAlready(previous, doneRows);
      mergeTally(report, previous);
    }
    if (start >= stat.size) continue;
    const index = item.origin === "entry" ? await ensureManagerIndex() : null;

    let batch = [];
    let chunkStart = start;
    const flush = async () => {
      if (!batch.length) return;
      const tally = newTally();
      const startedAt = Date.now();
      const raw = [];
      const oldHours = new Map();
      const control = new Map();
      for (const line of batch) {
        let entry;
        try {
          entry = JSON.parse(line.text);
        } catch {
          tallySkip(tally, "invalid_json");
          continue;
        }
        const mapped = mapAccessEntry(entry, spec, line.lineNo);
        if (mapped.skip) {
          tallySkip(tally, mapped.skip);
          continue;
        }
        if (mapped.control) {
          tallySeen(tally, mapped.control.at);
          if (mapped.control.at < ctx.cutoffs.minute) {
            tallySkip(tally, "control_route");
            continue;
          }
          const id = `${mapped.control.bucket}|${mapped.control.route}|${mapped.control.status_class}`;
          const counted = control.get(id) || { bucket: mapped.control.bucket, route: mapped.control.route, status_class: mapped.control.status_class, count: 0 };
          counted.count += 1;
          control.set(id, counted);
          tallyWrite(tally);
          continue;
        }
        const row = mapped.row;
        tallySeen(tally, row.ended_at);
        if (index) {
          const duplicateOf = findDuplicate(index, row);
          if (duplicateOf) row.extra = { ...row.extra, dupOf: duplicateOf };
        }
        if (row.received_at >= ctx.cutoffs.requests) {
          raw.push({ ...row, extra: Object.keys(row.extra).length ? JSON.stringify(row.extra) : null });
        } else if (row.extra.dupOf) {
          tallySkip(tally, "duplicate_of_manager_row");
        } else {
          addOldRequest(oldHours, family, row);
          tallyWrite(tally);
        }
      }
      if (raw.length) {
        const result = await ctx.sink.insertRequests(raw);
        tallyWrite(tally, result.accepted);
        tallySkip(tally, "duplicate", result.duplicates);
        tallySkip(tally, "rejected_row", result.rejected);
      }
      if (!ctx.dryRun) {
        const lastLine = batch[batch.length - 1];
        const hourRows = [...oldHours.values()].sort((a, b) => a.bucket - b.bucket).map((entry) => family.finish(entry.group, entry.bucket));
        const fileKey = fileKeyFor(label, stat, chunkStart);
        const applied = await ctx.sink.apply({
          source: "access-logs",
          guard: true,
          fileKey,
          requestRollups: hourRows,
          controlCounts: [...control.values()],
          run: runRow(ctx, "access-logs", fileKey, startedAt, tally, {
            endOffset: lastLine.next,
            lines: lastLine.lineNo,
            rows: doneRows + tally.rowsIn,
            display: item.display,
          }),
        });
        if (applied && applied.skipped) throw codedError("import_chunk_already_applied");
      }
      doneRows += tally.rowsIn;
      mergeTally(report, tally);
      chunkStart = batch[batch.length - 1].next;
      batch = [];
      ctx.progress("access-logs", { files: report.files, file: item.display, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
    };

    for await (const record of readLines(item.file, start, stat.size)) {
      if (record.partial) {
        try {
          JSON.parse(record.text);
        } catch {
          break;
        }
      }
      lineNo += 1;
      if (!record.text.trim()) continue;
      batch.push({ text: record.text, lineNo, next: record.next });
      if (batch.length >= ctx.chunkLines) await flush();
    }
    await flush();
  }
  return report;
}

// ------------------------------------------------------------ service-usage

// Copies the database (and its WAL) to a private folder and opens the copy, so
// the source files are never opened for writing or touched by SQLite.
async function readServiceUsage(ctx, file) {
  const { DatabaseSync } = require("node:sqlite");
  const dir = await fsp.mkdtemp(path.join(ctx.tempRoot, "telemetry-import-"));
  try {
    const copy = path.join(dir, "service-usage.sqlite");
    await fsp.copyFile(file, copy);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await fsp.copyFile(`${file}${suffix}`, `${copy}${suffix}`);
      } catch {
        // No WAL: the main file is complete.
      }
    }
    const db = new DatabaseSync(copy);
    try {
      return db.prepare(`SELECT event_id, at, client_id, model, status, request_id, usage_source, prompt_tokens,
        generation_tokens, cached_tokens FROM service_usage_events ORDER BY at, event_id`).all();
    } finally {
      db.close();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function importServiceUsage(ctx) {
  const report = newReport("service-usage");
  addWarning(report, "Usage events that match no imported manager row are reported, not inserted.");
  for (const manager of ctx.managers) {
    const file = path.join(manager.root, "logs", "service-usage.sqlite");
    const stat = await statFile(file);
    if (!stat) continue;
    report.files += 1;
    const label = labelOf(ctx, file);
    const fileKey = fileKeyFor(label, stat);
    const tally = newTally();
    const startedAt = Date.now();
    const done = await ctx.sink.lookup({ source: "service-usage", fileKey });
    if (done) {
      markAlready(tally, done);
      mergeTally(report, tally);
      continue;
    }
    let rows;
    try {
      rows = await readServiceUsage(ctx, file);
    } catch (error) {
      addWarning(report, `${label}: read_failed_${String(error && error.code ? error.code : "error").toLowerCase()}`);
      continue;
    }
    const items = [];
    for (const row of rows) {
      const at = timestampOf(row.at);
      if (at === null) {
        tallySkip(tally, "invalid_row");
        continue;
      }
      tallySeen(tally, at);
      const prompt = nonNegativeInt(row.prompt_tokens);
      const output = nonNegativeInt(row.generation_tokens);
      const usageSource = ["reported", "estimated", "missing"].includes(row.usage_source) ? row.usage_source : "missing";
      if (at < ctx.cutoffs.requests) tallySkip(tally, "older_than_raw_ttl");
      else if (usageSource === "missing" && prompt + output === 0) tallySkip(tally, "no_usage");
      else {
        items.push({
          managerId: manager.id,
          clientId: String(row.client_id || ""),
          model: String(row.model || ""),
          status: nonNegativeInt(row.status),
          at,
          requestId: normalizeClientRequestId(row.request_id),
          prompt,
          cached: intOrNull(row.cached_tokens),
          output,
          usageSource,
        });
      }
    }
    if (items.length) {
      const applied = await ctx.sink.apply({ source: "service-usage", backfill: items });
      for (const outcome of applied.backfill || []) {
        if (outcome === "updated") tallyWrite(tally);
        else if (outcome === "already") tallySkip(tally, "already_backfilled");
        else tallySkip(tally, "no_matching_row");
      }
    }
    await ctx.sink.record(runRow(ctx, "service-usage", fileKey, startedAt, tally, null));
    mergeTally(report, tally);
    ctx.progress("service-usage", { files: report.files, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
  }
  return report;
}

// ------------------------------------------------------------ event sources

const GUARD_TITLES = Object.freeze([
  [/^GPU temperature warning$/i, "temperature"],
  [/^GPU power limit warning$/i, "power"],
  [/^VRAM guard warning$/i, "vram"],
]);

function scalarData(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) && (typeof item === "number" || typeof item === "boolean")) out[key] = item;
    else if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) && typeof item === "string" && item.length <= 60) out[key] = item;
  }
  return out;
}

function guardEventFromJob(ctx, managerId, job) {
  const title = String(job.title || "");
  const match = GUARD_TITLES.find(([pattern]) => pattern.test(title));
  if (!match) return null;
  const id = clipText(job.id, 128);
  const at = timestampOf(job.createdAt) ?? timestampOf(job.updatedAt);
  if (!id || at === null) return null;
  return events().eventRow({
    at,
    type: "gpu.guard",
    severity: "warning",
    source: managerId,
    managerId,
    title,
    data: { kind: match[1], jobId: id, ...scalarData(job.meta) },
    dedupeKey: `guard:${managerId}:${id}`,
  });
}

async function importJobsLedger(ctx) {
  const report = newReport("jobs-ledger");
  addWarning(report, "Download jobs are not imported: the model hub owns them.");
  for (const manager of ctx.managers) {
    const file = path.join(manager.root, "logs", "jobs-ledger.json");
    const stat = await statFile(file);
    if (!stat) continue;
    report.files += 1;
    const label = labelOf(ctx, file);
    const fileKey = fileKeyFor(label, stat);
    const tally = newTally();
    const startedAt = Date.now();
    const done = await ctx.sink.lookup({ source: "jobs-ledger", fileKey });
    if (done) {
      markAlready(tally, done);
      mergeTally(report, tally);
      continue;
    }
    const parsed = await readJsonSource(file, stat);
    if (!parsed.ok || !isPlainObject(parsed.value) || !Array.isArray(parsed.value.jobs)) {
      addWarning(report, `${label}: ${parsed.ok ? "unexpected_shape" : parsed.code}`);
      continue;
    }
    const list = [];
    for (const job of parsed.value.jobs) {
      if (!isPlainObject(job)) {
        tallySkip(tally, "invalid_row");
        continue;
      }
      const type = String(job.type || "");
      if (type === "serve" || type === "start") {
        const produced = events().launchEventsFromJob(manager.id, job, { now: ctx.now });
        if (produced.length) list.push(...produced);
        else tallySkip(tally, "invalid_row");
      } else if (type === "automation") {
        const guard = guardEventFromJob(ctx, manager.id, job);
        if (guard) list.push(guard);
        else tallySkip(tally, "automation_other");
      } else if (/download/i.test(type)) {
        tallySkip(tally, "download_job");
      } else {
        tallySkip(tally, "unsupported_job_type");
      }
    }
    await writeEvents(ctx, tally, list);
    await ctx.sink.record(runRow(ctx, "jobs-ledger", fileKey, startedAt, tally, null));
    mergeTally(report, tally);
    ctx.progress("jobs-ledger", { files: report.files, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
  }
  return report;
}

// A line log read as a whole (the files are small, and every event has a
// dedupe key).
async function importLineLog(ctx, report, spec) {
  const stat = await statFile(spec.file);
  if (!stat) return;
  report.files += 1;
  const label = labelOf(ctx, spec.file);
  const fileKey = fileKeyFor(label, stat);
  const tally = newTally();
  const startedAt = Date.now();
  const done = await ctx.sink.lookup({ source: report.source, fileKey });
  if (done) {
    markAlready(tally, done);
    mergeTally(report, tally);
    return;
  }
  const list = [];
  const state = {};
  for await (const record of readLines(spec.file, 0, stat.size)) {
    if (!record.text.trim()) continue;
    if (record.partial) {
      try {
        JSON.parse(record.text);
      } catch {
        continue;
      }
    }
    const produced = spec.parse(record, state);
    if (produced.length) list.push(...produced);
    else tallySkip(tally, "unrecognised_line");
  }
  await writeEvents(ctx, tally, list);
  await ctx.sink.record(runRow(ctx, report.source, fileKey, startedAt, tally, null));
  mergeTally(report, tally);
  ctx.progress(report.source, { files: report.files, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
}

async function importProcessExit(ctx) {
  const report = newReport("process-exit");
  const targets = [
    { id: "entry", file: path.join(ctx.entryRoot, "logs", "process-exit.log") },
    ...ctx.managers.map((manager) => ({ id: manager.id, file: path.join(manager.root, "logs", "process-exit.log") })),
  ];
  for (const target of targets) {
    const spec = { id: `process-exit:${target.id}`, managerId: target.id };
    await importLineLog(ctx, report, {
      file: target.file,
      parse: (record, labels) => events().processExitRows(spec, labels, record.text, ctx.now),
    });
  }
  return report;
}

async function importMcpAudit(ctx) {
  const report = newReport("mcp-audit");
  const spec = { id: "mcp" };
  await importLineLog(ctx, report, {
    file: ctx.mcpAuditLog,
    parse: (record) => {
      const row = events().mcpToolCallRow(spec, record.text, record.offset, ctx.now);
      return row ? [row] : [];
    },
  });
  return report;
}

async function importAuditManifests(ctx) {
  const report = newReport("audit-manifests");
  let names;
  try {
    names = (await fsp.readdir(ctx.auditRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return report;
  }
  const tally = newTally();
  const list = [];
  for (const name of names) {
    const file = path.join(ctx.auditRoot, name, "manifest.json");
    const stat = await statFile(file);
    if (!stat) {
      tallySkip(tally, "no_manifest");
      continue;
    }
    report.files += 1;
    const parsed = await readJsonSource(file, stat);
    const manifest = parsed.ok ? parsed.value : null;
    const auditId = events().slug(isPlainObject(manifest) ? manifest.auditId || name : name, 128);
    const at = isPlainObject(manifest) ? timestampOf(manifest.createdAt) : null;
    if (!isPlainObject(manifest) || !auditId || at === null) {
      tallySkip(tally, "invalid_row");
      continue;
    }
    const summary = isPlainObject(manifest.summary) ? manifest.summary : {};
    list.push(events().eventRow({
      at,
      type: "audit.export",
      source: "entry",
      title: `Audit export: ${clipText(manifest.mode, 16) || "full"}`,
      data: {
        auditId,
        reason: clipText(manifest.reason, 120) || null,
        mode: clipText(manifest.mode, 16) || null,
        manager: clipText(manifest.manager, 64) || null,
        chatCount: nonNegativeInt(summary.chat_count ?? manifest.chatCount),
        messageCount: nonNegativeInt(summary.message_count ?? manifest.messageCount),
        rebaseline: Boolean(manifest.rebaseline),
      },
      dedupeKey: `audit:${auditId}`,
    }));
  }
  await writeEvents(ctx, tally, list);
  mergeTally(report, tally);
  return report;
}

async function importBenchmarks(ctx) {
  const report = newReport("benchmarks");
  for (const manager of ctx.managers) {
    const file = path.join(manager.root, "logs", "benchmark-history.json");
    const stat = await statFile(file);
    if (!stat) continue;
    report.files += 1;
    const label = labelOf(ctx, file);
    const fileKey = fileKeyFor(label, stat);
    const tally = newTally();
    const startedAt = Date.now();
    const done = await ctx.sink.lookup({ source: "benchmarks", fileKey });
    if (done) {
      markAlready(tally, done);
      mergeTally(report, tally);
      continue;
    }
    const parsed = await readJsonSource(file, stat);
    if (!parsed.ok || !isPlainObject(parsed.value) || !Array.isArray(parsed.value.runs)) {
      addWarning(report, `${label}: ${parsed.ok ? "unexpected_shape" : parsed.code}`);
      continue;
    }
    const list = [];
    for (const run of parsed.value.runs) {
      const row = events().benchmarkEventRow(manager.id, run);
      if (row) list.push(row);
      else tallySkip(tally, "invalid_row");
    }
    await writeEvents(ctx, tally, list);
    await ctx.sink.record(runRow(ctx, "benchmarks", fileKey, startedAt, tally, null));
    mergeTally(report, tally);
    ctx.progress("benchmarks", { files: report.files, rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
  }
  return report;
}

const RUNNERS = Object.freeze({
  "metrics-history": importMetricsHistory,
  "stats-ledger": importStatsLedger,
  "access-logs": importAccessLogs,
  "service-usage": importServiceUsage,
  "jobs-ledger": importJobsLedger,
  "process-exit": importProcessExit,
  "audit-manifests": importAuditManifests,
  benchmarks: importBenchmarks,
  "mcp-audit": importMcpAudit,
});

function normalizeSources(input) {
  if (input === undefined || input === null) return [...IMPORT_SOURCES];
  if (!Array.isArray(input) || !input.length) throw codedError("invalid_import_sources", "Choose at least one import source.");
  const wanted = new Set();
  for (const item of input) {
    if (!IMPORT_SOURCES.includes(item)) throw codedError("unknown_import_source", "Unknown import source.");
    wanted.add(item);
  }
  return IMPORT_SOURCES.filter((id) => wanted.has(id));
}

/**
 * runImport({ sources, aiRoot, store, dryRun = true, onProgress, now,
 *   retention, timezoneOffsetMinutes, managers, entryRoot, env })
 * → { ok, dryRun, startedAt, finishedAt, sources, reports, rowsIn,
 *     rowsWritten, rowsSkipped, rangeFrom, rangeTo, warnings, errors }
 *
 * `reports` holds one §18 report per source: { source, files, rowsIn,
 * rowsWritten, rowsSkipped: {reason: count}, rangeFrom, rangeTo, warnings }.
 * The top level sums them. A source that fails carries `error` (a code) and
 * does not stop the others. Sources are only ever read.
 */
async function runImport(options = {}) {
  const store = options.store;
  if (!store || typeof store.call !== "function" || typeof store.insertRequests !== "function" || typeof store.insertEvents !== "function") {
    throw codedError("invalid_store", "runImport needs a TelemetryStore.");
  }
  const sources = normalizeSources(options.sources);
  const ctx = createContext(options, store);
  const startedAt = Date.now();
  const reports = [];
  const errors = [];
  for (const id of sources) {
    ctx.progress(id, { state: "started" });
    let report;
    try {
      report = await RUNNERS[id](ctx);
    } catch (error) {
      report = newReport(id);
      const code = String((error && error.code) || "import_failed").slice(0, 80);
      report.error = code;
      addWarning(report, `Import stopped: ${code}`);
      errors.push({ source: id, code });
    }
    finalizeReport(report);
    reports.push(report);
    ctx.progress(id, { state: "finished", rowsIn: report.rowsIn, rowsWritten: report.rowsWritten });
  }
  const total = {
    ok: errors.length === 0,
    dryRun: ctx.dryRun,
    startedAt: isoOrNull(startedAt),
    finishedAt: isoOrNull(Date.now()),
    sources,
    reports,
    files: reports.reduce((sum, report) => sum + report.files, 0),
    rowsIn: reports.reduce((sum, report) => sum + report.rowsIn, 0),
    rowsWritten: reports.reduce((sum, report) => sum + report.rowsWritten, 0),
    rowsSkipped: {},
    rangeFrom: null,
    rangeTo: null,
    warnings: [],
    errors,
  };
  for (const report of reports) {
    for (const [reason, count] of Object.entries(report.rowsSkipped)) total.rowsSkipped[reason] = (total.rowsSkipped[reason] || 0) + count;
    if (report.rangeFrom && (!total.rangeFrom || report.rangeFrom < total.rangeFrom)) total.rangeFrom = report.rangeFrom;
    if (report.rangeTo && (!total.rangeTo || report.rangeTo > total.rangeTo)) total.rangeTo = report.rangeTo;
    for (const warning of report.warnings) if (total.warnings.length < MAX_WARNINGS && !total.warnings.includes(warning)) total.warnings.push(warning);
  }
  return total;
}

// ============================================================ worker half

function txn(db, dryRun, operation) {
  if (db.isTransaction) return operation();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function parseDetail(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runView(row) {
  return row ? { ...row, detail: parseDetail(row.detail) } : null;
}

// {source, fileKey} -> the finished run with that key; {source, prefix} -> the
// newest finished run whose key starts with the prefix (the import cursor of
// a growing log). null when there is none.
function importLookup(db, params) {
  const source = String(params.source || "");
  if (typeof params.fileKey === "string") {
    return runView(db.prepare("SELECT * FROM import_runs WHERE source = ? AND file_key = ? AND status = ?").get(source, params.fileKey, IMPORT_RUN_DONE));
  }
  if (typeof params.prefix === "string" && params.prefix) {
    return runView(db.prepare(`SELECT * FROM import_runs WHERE source = ? AND status = ? AND substr(file_key, 1, ?) = ?
      ORDER BY id DESC LIMIT 1`).get(source, IMPORT_RUN_DONE, params.prefix.length, params.prefix));
  }
  return null;
}

function importExisting(db, params) {
  const column = EXISTING_TABLES[String(params.table || "")];
  if (!column) throw codedError("unknown_import_table", "Unknown import table.");
  const keys = (Array.isArray(params.keys) ? params.keys : []).filter((key) => typeof key === "string").slice(0, 5000);
  if (!keys.length) return [];
  const found = db.prepare(`SELECT ${column} AS key FROM ${params.table} WHERE ${column} IN (${keys.map(() => "?").join(", ")})`).all(...keys);
  return found.map((row) => row.key);
}

function writeRun(db, run) {
  db.prepare(`INSERT INTO import_runs (source, file_key, started_at, finished_at, rows_in, rows_written, rows_skipped, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, file_key) DO UPDATE SET started_at = excluded.started_at, finished_at = excluded.finished_at,
      rows_in = excluded.rows_in, rows_written = excluded.rows_written, rows_skipped = excluded.rows_skipped,
      status = excluded.status, detail = excluded.detail`).run(
    String(run.source),
    String(run.fileKey),
    Number(run.startedAt) || Date.now(),
    Number(run.finishedAt) || Date.now(),
    nonNegativeInt(run.rowsIn),
    nonNegativeInt(run.rowsWritten),
    nonNegativeInt(run.rowsSkipped),
    String(run.status || IMPORT_RUN_DONE),
    run.detail === null || run.detail === undefined ? null : JSON.stringify(run.detail),
  );
}

function importRecord(db, params) {
  writeRun(db, params);
  return { ok: true };
}

// Adds `row` to the stored row with the same key (counters and histograms
// add), or inserts it. Used for rows that are applied exactly once.
function upsertFolded(db, family, table, row) {
  const key = {};
  for (const name of family.key) key[name] = row[name];
  const where = family.key.map((name) => `${name} = ?`).join(" AND ");
  const existing = db.prepare(`SELECT * FROM ${table} WHERE bucket = ? AND ${where}`).get(row.bucket, ...family.key.map((name) => row[name]));
  const group = family.newGroup(key);
  family.fold(group, row);
  if (existing) family.fold(group, existing);
  const out = family.finish(group, row.bucket);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${family.columns.join(", ")}) VALUES (${family.columns.map(() => "?").join(", ")})`)
    .run(...family.columns.map((name) => (out[name] === undefined ? null : out[name])));
}

function applyRequestRollups(db, calendar, cutoffs, rows) {
  const family = rollups.FAMILIES.requests;
  const days = new Map();
  let hours = 0;
  for (const row of rows) {
    if (Number(row.bucket) >= Number(cutoffs.hour)) {
      upsertFolded(db, family, "rollup_1h", row);
      hours += 1;
    }
    const day = calendar.dayOf(row.bucket);
    const key = JSON.stringify([day, ...family.key.map((name) => row[name])]);
    let entry = days.get(key);
    if (!entry) {
      const groupKey = {};
      for (const name of family.key) groupKey[name] = row[name];
      entry = { day, group: family.newGroup(groupKey) };
      days.set(key, entry);
    }
    family.fold(entry.group, row);
  }
  for (const entry of days.values()) upsertFolded(db, family, "rollup_1d", family.finish(entry.group, entry.day));
  return { rollup_1h: hours, rollup_1d: days.size };
}

function applyControlCounts(db, rows) {
  const statement = db.prepare(`INSERT INTO control_counts_1m (bucket, route, status_class, count) VALUES (?, ?, ?, ?)
    ON CONFLICT(bucket, route, status_class) DO UPDATE SET count = count + excluded.count`);
  for (const row of rows) statement.run(Number(row.bucket), String(row.route), String(row.status_class), Number(row.count));
  return rows.length;
}

// A day that the imported file covers completely: it starts within an hour
// of the first sample and ends at or before the last one.
function coveredDay(calendar, day, window) {
  return Number.isFinite(window.lastAt) && Number.isFinite(window.firstAt)
    && calendar.dayEnd(day) <= window.lastAt && window.firstAt <= day + HOUR_MS;
}

function insertIgnoring(db, table, columns, rows) {
  const statement = db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  const inserted = [];
  for (const row of rows) {
    const outcome = statement.run(...columns.map((name) => (row[name] === undefined ? null : row[name])));
    if (Number(outcome.changes) > 0) inserted.push(Number(row.bucket));
  }
  return inserted;
}

// Existing rows win: live collection and earlier imports are never replaced.
function applyGpu(db, calendar, gpu) {
  const family = rollups.FAMILIES.gpu;
  const inserted = {};
  inserted.gpu_rollup_1m = insertIgnoring(db, "gpu_rollup_1m", family.columns, gpu.rows1m || []);
  inserted.gpu_rollup_1h = insertIgnoring(db, "gpu_rollup_1h", family.columns, gpu.rows1h || []);
  const days = new Map();
  for (const row of gpu.rows1h || []) {
    const day = calendar.dayOf(row.bucket);
    if (!coveredDay(calendar, day, gpu)) continue;
    const key = `${day}|${row.gpu_index}`;
    let entry = days.get(key);
    if (!entry) {
      entry = { day, group: family.newGroup({ gpu_index: row.gpu_index }) };
      days.set(key, entry);
    }
    family.fold(entry.group, row);
  }
  const dayRows = [...days.values()].sort((a, b) => a.day - b.day || a.group.key.gpu_index - b.group.key.gpu_index)
    .map((entry) => family.finish(entry.group, entry.day));
  inserted.gpu_rollup_1d = insertIgnoring(db, "gpu_rollup_1d", family.columns, dayRows);
  return inserted;
}

const RUNTIME_ROLLUP_COLUMNS = Object.freeze([
  "bucket", "fleet_id", "model", "manager_id", "engine_id", "sample_count", "scrape_failures", "resets",
  "idle_seconds", "interval_ms_sum", "d_requests", "latency_source",
]);

function applyRuntime(db, calendar, runtime) {
  const rows = (runtime.rows1h || []).map((row) => ({ ...row, scrape_failures: 0, idle_seconds: 0, interval_ms_sum: 0, latency_source: "none" }));
  const inserted = {};
  inserted.runtime_rollup_1h = insertIgnoring(db, "runtime_rollup_1h", RUNTIME_ROLLUP_COLUMNS, rows);
  const days = new Map();
  for (const row of rows) {
    const day = calendar.dayOf(row.bucket);
    if (!coveredDay(calendar, day, runtime)) continue;
    const key = JSON.stringify([day, row.fleet_id, row.model]);
    let entry = days.get(key);
    if (!entry) {
      entry = { ...row, bucket: day, sample_count: 0, resets: 0, d_requests: null };
      days.set(key, entry);
    }
    entry.sample_count += Number(row.sample_count) || 0;
    entry.resets += Number(row.resets) || 0;
    if (row.d_requests !== null && row.d_requests !== undefined) entry.d_requests = (entry.d_requests || 0) + Number(row.d_requests);
  }
  inserted.runtime_rollup_1d = insertIgnoring(db, "runtime_rollup_1d", RUNTIME_ROLLUP_COLUMNS, [...days.values()].sort((a, b) => a.bucket - b.bucket));
  return inserted;
}

const BASELINE_FIELDS = Object.freeze(["engine", "first_seen", "last_seen", "prompt_tokens", "cached_tokens", "output_tokens", "requests", "errors"]);

function applyBaseline(db, rows) {
  const outcomes = [];
  const select = db.prepare("SELECT * FROM lifetime_baseline WHERE manager_id = ? AND model = ? AND source = ?");
  const insert = db.prepare(`INSERT INTO lifetime_baseline (manager_id, model, engine, first_seen, last_seen, prompt_tokens, cached_tokens,
    output_tokens, requests, errors, source, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE lifetime_baseline SET engine = ?, first_seen = ?, last_seen = ?, prompt_tokens = ?, cached_tokens = ?,
    output_tokens = ?, requests = ?, errors = ?, imported_at = ? WHERE manager_id = ? AND model = ? AND source = ?`);
  for (const row of rows) {
    const existing = select.get(row.manager_id, row.model, row.source);
    if (!existing) {
      insert.run(row.manager_id, row.model, row.engine, row.first_seen, row.last_seen, row.prompt_tokens, row.cached_tokens,
        row.output_tokens, row.requests, row.errors, row.source, row.imported_at);
      outcomes.push("inserted");
    } else if (BASELINE_FIELDS.some((name) => (existing[name] ?? null) !== (row[name] ?? null))) {
      update.run(row.engine, row.first_seen, row.last_seen, row.prompt_tokens, row.cached_tokens, row.output_tokens, row.requests,
        row.errors, row.imported_at, row.manager_id, row.model, row.source);
      outcomes.push("updated");
    } else {
      outcomes.push("unchanged");
    }
  }
  return outcomes;
}

const USAGE_COLUMNS = "id, received_at, usage_source, prompt_tokens, cached_tokens, output_tokens";

// Tokens and usage_source onto the imported manager row of the same request:
// by request id when both sides have one, else by (client, model, status)
// within 2 s.
function applyBackfill(db, items) {
  const byRequest = db.prepare(`SELECT ${USAGE_COLUMNS} FROM requests WHERE ingress = 'import:manager' AND manager_id IS ?
    AND manager_request_id = ? AND status = ? LIMIT 1`);
  const byWindow = db.prepare(`SELECT ${USAGE_COLUMNS} FROM requests WHERE ingress = 'import:manager' AND manager_id IS ? AND key_id IS ?
    AND status = ? AND ended_at BETWEEN ? AND ? AND (lower(model_requested) = ? OR lower(model_resolved) = ?)
    ORDER BY ABS(ended_at - ?) ASC, id ASC LIMIT 8`);
  const update = db.prepare("UPDATE requests SET prompt_tokens = ?, cached_tokens = ?, output_tokens = ?, usage_source = ? WHERE id = ?");
  const outcomes = [];
  const late = [];
  for (const item of items) {
    const model = String(item.model || "").toLowerCase();
    const clientId = item.clientId ? item.clientId : null;
    let candidates = [];
    if (item.requestId) {
      const found = byRequest.get(item.managerId, item.requestId, item.status);
      if (found) candidates = [found];
    }
    if (!candidates.length) {
      candidates = byWindow.all(item.managerId, clientId, item.status, item.at - MATCH_WINDOW_MS, item.at + MATCH_WINDOW_MS, model, model, item.at);
    }
    const same = (row) => (row.prompt_tokens ?? null) === item.prompt && (row.output_tokens ?? null) === item.output
      && (row.cached_tokens ?? null) === (item.cached ?? null) && row.usage_source === item.usageSource;
    if (candidates.some(same)) {
      outcomes.push("already");
      continue;
    }
    const open = candidates.find((row) => row.usage_source === null || row.usage_source === "missing");
    if (!open) {
      outcomes.push("unmatched");
      continue;
    }
    update.run(item.prompt, item.cached ?? null, item.output, item.usageSource, open.id);
    late.push({ at: open.received_at });
    outcomes.push("updated");
  }
  // The updated rows may already be rolled up: their minute is recomputed.
  if (late.length) rollups.markLate(db, "requests", late);
  return outcomes;
}

// One transaction of worker-side writes for a unit of imported data. The
// sections are independent; all are optional.
//   guard + fileKey   skip (and write nothing) when that chunk is already done
//   requestRollups    rollup_1h rows to add (and their days to rollup_1d)
//   controlCounts     control_counts_1m rows to add
//   gpu / runtime     rollup rows inserted when absent (+ covered days)
//   baseline          lifetime_baseline rows inserted or refreshed
//   backfill          usage onto imported manager rows
//   run               the import_runs row of this unit
// With dryRun the transaction is rolled back; the result is what would have
// been written.
function importApply(db, params) {
  const dryRun = params.dryRun === true;
  return txn(db, dryRun, () => {
    if (params.guard && typeof params.fileKey === "string") {
      if (importLookup(db, { source: params.source, fileKey: params.fileKey })) return { ok: true, skipped: true };
    }
    const offset = rollups.normalizeTimezoneOffset(params.timezoneOffsetMinutes);
    const calendar = rollups.calendarFromState(db, offset);
    const cutoffs = params.cutoffs || {};
    const result = { ok: true, skipped: false };
    if (Array.isArray(params.requestRollups) && params.requestRollups.length) {
      result.requestRollups = applyRequestRollups(db, calendar, cutoffs, params.requestRollups);
    }
    if (Array.isArray(params.controlCounts) && params.controlCounts.length) result.controlCounts = applyControlCounts(db, params.controlCounts);
    result.inserted = {};
    if (params.gpu) Object.assign(result.inserted, applyGpu(db, calendar, params.gpu));
    if (params.runtime) Object.assign(result.inserted, applyRuntime(db, calendar, params.runtime));
    if (Array.isArray(params.baseline) && params.baseline.length) result.baseline = applyBaseline(db, params.baseline);
    if (Array.isArray(params.backfill) && params.backfill.length) result.backfill = applyBackfill(db, params.backfill);
    if (isPlainObject(params.run)) writeRun(db, params.run);
    return result;
  });
}

const WORKER_CALLS = Object.freeze({ importApply, importExisting, importLookup, importRecord });

module.exports = {
  IMPORT_SOURCES,
  WORKER_CALLS,
  canonicalManagerPath,
  mapAccessEntry,
  runImport,
};
