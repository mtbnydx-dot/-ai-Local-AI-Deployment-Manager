"use strict";

// GpuCollector (docs/overhaul/04-telemetry.md §8). Runs in the entry.
//
// Every intervalMs (10 s) it runs
//   nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits
// through execFile (never a shell) with a 5 s timeout and writes one
// gpu_samples row per GPU through store.insertGpuSamples.
//
// - Fallback chain: the full field list first; if nvidia-smi rejects it, the
//   same list with the pre-535 spelling clocks_throttle_reasons.active, then
//   both spellings without temperature.memory/utilization.memory, and finally
//   the legacy gpu-runtime.js query. The query that worked is cached for one
//   hour; when it fails the chain is walked again in the same tick. A missing
//   binary, a permission error or a timeout ends the walk, since no other
//   field list can fix those. Only a step reached through field errors (the
//   driver rejecting the lists above it) is cached: a step that answered
//   after a transient driver error ("Unknown Error", GPU busy) serves that
//   tick alone, and the cached query survives such an error, so one hiccup
//   cannot lock in a poorer field list for an hour.
// - "N/A", "[N/A]" and the other bracketed placeholders ("[Not Supported]")
//   parse to NULL, never to 0. power_limit_w prefers enforced.power.limit.
// - The throttle mask is decoded with THROTTLE_REASONS; bits outside the
//   table stay visible as "bit_0x…" (the host reports 0x400 today).
//   throttle_mask keeps bits 0-52 only, so it is always a JS-safe integer
//   (see storedMask); `throttle` lists every bit.
// - Per-process VRAM: one --query-compute-apps call per minute. When every
//   used_memory is [N/A], which is what Windows WDDM reports (F10), procs
//   stays NULL and the call is disabled for one hour. An empty process list
//   is stored as [] only on a host that has reported per-process numbers
//   before; otherwise it cannot tell "no process" from "cannot measure" and
//   procs stays NULL. Per-instance VRAM in the UI comes from
//   vramReservationMb instead.
// - energy_wh = power_w × min(Δt, 2 × intervalMs) / 3600 (energy.js), so a
//   gap in the samples is never filled in beyond two intervals.
// - nvidia-smi missing, or three failed ticks in a row: the interval backs off
//   to 60 s and status().state becomes "degraded" (the telemetry_stale alert
//   reads it). The first good sample restores the interval and "ok".
// - Store writes never hold up sampling: at most one insert batch is in
//   flight, rows sampled meanwhile wait (bounded) for the next batch, and the
//   next tick is scheduled as soon as nvidia-smi has answered. A batch the
//   store could not take for now (busy, worker restarting or crashed) goes
//   back to the queue, so a store restart costs no samples and no energy.
//
// The cached query, the per-process pause and each GPU's last sample time are
// kept in collector_state ("collector.gpu"), so an entry restart neither
// re-probes the chain nor loses the energy integration for more than one
// interval. `events` (ENT-EV) is accepted for the shared collector signature
// but unused: telemetry publishes only telemetry.live, alerts and
// notification (§12), which are built from latest() and status().
// The managers keep their own getGpuStatus() for admission.

const childProcess = require("node:child_process");
const { integrateEnergyWh } = require("../energy");
const { redactSecrets } = require("../../secret-redactor");

const NVIDIA_SMI = "nvidia-smi";
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DEFAULT_INTERVAL_MS = 10_000;
const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 1024 * 1024;
const QUERY_CACHE_MS = HOUR_MS;
const PROCS_EVERY_MS = MINUTE_MS;
const PROCS_PAUSE_MS = HOUR_MS;
const FAILURES_BEFORE_BACKOFF = 3;
const BACKOFF_INTERVAL_MS = MINUTE_MS;
const STATE_NAME = "collector.gpu";
// gpu_samples.procs is capped at 8 KiB (schema.js), so the list keeps the
// biggest users and short names.
const MAX_PROCS_PER_GPU = 48;
const MAX_PROCESS_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 300;
// Rows waiting while an insert batch is in flight; past this the oldest are
// dropped and counted (about three hours of a two-GPU host at 10 s).
const MAX_PENDING_ROWS = 2048;
// How long stop() waits for queued rows (the store's own close default).
const STOP_FLUSH_MS = 2000;

// §8 decode table. `hardware` marks the reasons the gpu.hw_throttle_share
// alert metric counts (§13.1).
const THROTTLE_REASONS = Object.freeze([
  Object.freeze({ bit: 0x1, slug: "gpu_idle", hardware: false }),
  Object.freeze({ bit: 0x2, slug: "app_clocks", hardware: false }),
  Object.freeze({ bit: 0x4, slug: "sw_power_cap", hardware: false }),
  Object.freeze({ bit: 0x8, slug: "hw_slowdown", hardware: true }),
  Object.freeze({ bit: 0x10, slug: "sync_boost", hardware: false }),
  Object.freeze({ bit: 0x20, slug: "sw_thermal", hardware: false }),
  Object.freeze({ bit: 0x40, slug: "hw_thermal", hardware: true }),
  Object.freeze({ bit: 0x80, slug: "hw_power_brake", hardware: true }),
  Object.freeze({ bit: 0x100, slug: "display_clocks", hardware: false }),
]);

const FULL_FIELDS = Object.freeze([
  "index", "uuid", "name", "memory.total", "memory.used", "utilization.gpu", "utilization.memory",
  "temperature.gpu", "temperature.memory", "power.draw", "power.limit", "enforced.power.limit", "fan.speed",
  "clocks.sm", "clocks.mem", "clocks.max.sm", "pstate", "clocks_event_reasons.active",
]);
const REDUCED_FIELDS = Object.freeze(FULL_FIELDS.filter((field) => field !== "temperature.memory" && field !== "utilization.memory"));

function withThrottleSpelling(fields) {
  return Object.freeze(fields.map((field) => (field === "clocks_event_reasons.active" ? "clocks_throttle_reasons.active" : field)));
}

// The same field list as gpu-runtime.js tries first.
const LEGACY_FIELDS = Object.freeze([
  "index", "name", "compute_cap", "memory.total", "memory.used", "utilization.gpu", "temperature.gpu",
  "power.draw", "power.limit", "fan.speed",
]);

const QUERY_CHAIN = Object.freeze([
  FULL_FIELDS,
  withThrottleSpelling(FULL_FIELDS),
  REDUCED_FIELDS,
  withThrottleSpelling(REDUCED_FIELDS),
  LEGACY_FIELDS,
]);

// Per-process query; the plain variant (no gpu_uuid) is the fallback for a
// driver that rejects gpu_uuid, and can then only be attributed to a single
// GPU.
const PROCS_FIELDS = Object.freeze(["gpu_uuid", "pid", "process_name", "used_memory"]);
const PROCS_PLAIN_FIELDS = Object.freeze(["pid", "process_name", "used_memory"]);

// nvidia-smi field → gpu_samples key (camelCase, as the store accepts it).
// Fields without an entry (compute_cap) are read and ignored. Both power
// limits land in internal keys; powerLimitW is chosen after parsing.
const FIELD_COLUMNS = Object.freeze({
  index: Object.freeze({ key: "gpuIndex", kind: "index" }),
  uuid: Object.freeze({ key: "gpuUuid", kind: "text" }),
  name: Object.freeze({ key: "name", kind: "text" }),
  "memory.total": Object.freeze({ key: "memTotalMb", kind: "number" }),
  "memory.used": Object.freeze({ key: "memUsedMb", kind: "number" }),
  "utilization.gpu": Object.freeze({ key: "utilPct", kind: "number" }),
  "utilization.memory": Object.freeze({ key: "memUtilPct", kind: "number" }),
  "temperature.gpu": Object.freeze({ key: "tempC", kind: "number" }),
  "temperature.memory": Object.freeze({ key: "memTempC", kind: "number" }),
  "power.draw": Object.freeze({ key: "powerW", kind: "number" }),
  "power.limit": Object.freeze({ key: "configuredPowerLimitW", kind: "number" }),
  "enforced.power.limit": Object.freeze({ key: "enforcedPowerLimitW", kind: "number" }),
  "fan.speed": Object.freeze({ key: "fanPct", kind: "number" }),
  "clocks.sm": Object.freeze({ key: "smClockMhz", kind: "number" }),
  "clocks.mem": Object.freeze({ key: "memClockMhz", kind: "number" }),
  "clocks.max.sm": Object.freeze({ key: "smClockMaxMhz", kind: "number" }),
  pstate: Object.freeze({ key: "pstate", kind: "text" }),
  "clocks_event_reasons.active": Object.freeze({ key: "throttleMask", kind: "mask" }),
  "clocks_throttle_reasons.active": Object.freeze({ key: "throttleMask", kind: "mask" }),
});

// Every parsed row carries all of these, NULL when the query did not ask.
const SAMPLE_KEYS = Object.freeze([
  "gpuIndex", "gpuUuid", "name", "utilPct", "memUtilPct", "memUsedMb", "memTotalMb", "tempC", "memTempC",
  "powerW", "powerLimitW", "fanPct", "smClockMhz", "memClockMhz", "smClockMaxMhz", "pstate", "throttleMask", "throttle",
]);

const NUMBER_CELL = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:%|W|MiB|MHz|C)?$/i;
const FATAL_EXEC_CODES = new Set(["nvidia_smi_missing", "nvidia_smi_denied", "nvidia_smi_timeout"]);
// nvidia-smi exits with 2 ("a supplied argument or flag is invalid") and
// prints `Field "x" is not a valid field to query.` for a field the driver
// does not know. Only this moves the cached query down the chain.
const INVALID_ARGUMENT_EXIT = 2;
const INVALID_FIELD_TEXT = /is not a valid field/i;

function clampInt(value, min, max, fallback) {
  const number = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function finiteOrNull(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function normalizeFields(fields) {
  const list = Array.isArray(fields) ? fields : String(fields ?? "").split(",");
  return list.map((field) => String(field).trim()).filter(Boolean);
}

// nvidia-smi placeholders: "N/A", "[N/A]", "[Not Supported]", "[Unknown
// Error]", "[Insufficient Permissions]". All of them mean "no value".
function cellText(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^n\/a$/i.test(text) || /^\[.*\]$/.test(text)) return null;
  return text;
}

// nounits output is a bare number; a unit suffix (a query run without
// nounits) is tolerated, anything else is NULL.
function cellNumber(raw) {
  const text = cellText(raw);
  if (text === null) return null;
  const match = NUMBER_CELL.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

// A 64-bit mask as nvidia-smi prints it ("0x0000000000000400"), a number or
// a bigint. Returns a non-negative bigint or null.
function maskValue(mask) {
  if (mask === null || mask === undefined) return null;
  if (typeof mask === "bigint") return mask >= 0n ? mask : BigInt.asUintN(64, mask);
  if (typeof mask === "number") return Number.isSafeInteger(mask) && mask >= 0 ? BigInt(mask) : null;
  const text = cellText(mask);
  if (text === null || !/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) return null;
  try {
    return BigInt.asUintN(64, BigInt(text));
  } catch {
    return null;
  }
}

// Reason slugs for a throttle mask, table order first, then each bit the
// table does not know as "bit_0x<hex>" from the lowest up. An empty or
// unreadable mask gives [].
function decodeThrottle(mask) {
  const value = maskValue(mask);
  if (value === null || value === 0n) return [];
  const reasons = [];
  let unknown = value;
  for (const reason of THROTTLE_REASONS) {
    const bit = BigInt(reason.bit);
    if (value & bit) {
      reasons.push(reason.slug);
      unknown &= ~bit;
    }
  }
  for (let bit = 1n; unknown; bit <<= 1n) {
    if (unknown & bit) {
      reasons.push(`bit_0x${bit.toString(16)}`);
      unknown &= ~bit;
    }
  }
  return reasons;
}

// The throttleMask a row carries, in memory and in gpu_samples.throttle_mask:
// bits 0-52 of the mask as a Number. node:sqlite throws ERR_OUT_OF_RANGE on
// a default read of any INTEGER beyond ±(2^53 - 1), so a single 64-bit mask
// would break every plain SELECT of that GPU's rows (rollups included). The
// only NVML reason above bit 52 is the old "Unknown" bit 63, and `throttle`
// still lists it (bit_0x8000000000000000), so no reason is lost.
function storedMask(value) {
  return value === null ? null : Number(BigInt.asUintN(53, value));
}

// Splits one CSV line into exactly fields.length cells. nvidia-smi does not
// quote, so a comma inside a name or a process path yields surplus cells;
// they are folded back into `textField` when the query has one.
function splitCells(line, fieldCount, textIndex) {
  const parts = line.split(",");
  if (parts.length > fieldCount && textIndex >= 0) {
    const surplus = parts.length - fieldCount;
    parts.splice(textIndex, surplus + 1, parts.slice(textIndex, textIndex + surplus + 1).join(","));
  }
  if (parts.length !== fieldCount) return null;
  return parts.map((part) => part.trim());
}

// Parses `--query-gpu=<fields> --format=csv,noheader,nounits` output into
// gpu_samples rows (without `at`, energyWh and procs). Lines that are not
// GPU rows (error text, "No devices were found") are skipped, and a GPU
// index seen twice keeps its first row. throttleMask is a safe integer (bits
// 0-52, see storedMask) and `throttle` is decoded from the full mask.
function parseNvidiaSmiTelemetry(stdout, fields) {
  const fieldList = normalizeFields(fields);
  if (!fieldList.length) return [];
  const nameIndex = fieldList.indexOf("name");
  const rows = [];
  const seen = new Set();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitCells(line, fieldList.length, nameIndex);
    if (!cells) continue;
    const row = Object.fromEntries(SAMPLE_KEYS.map((key) => [key, null]));
    const extra = { configuredPowerLimitW: null, enforcedPowerLimitW: null, throttleMask: null };
    fieldList.forEach((field, index) => {
      const column = FIELD_COLUMNS[field];
      if (!column) return;
      const raw = cells[index];
      if (column.kind === "index") {
        row.gpuIndex = /^\d{1,4}$/.test(raw) ? Number(raw) : null;
      } else if (column.kind === "number") {
        const value = cellNumber(raw);
        if (column.key in extra) extra[column.key] = value;
        else row[column.key] = value;
      } else if (column.kind === "mask") {
        extra.throttleMask = maskValue(raw);
      } else {
        row[column.key] = cellText(raw);
      }
    });
    if (row.gpuIndex === null || seen.has(row.gpuIndex)) continue;
    seen.add(row.gpuIndex);
    row.powerLimitW = extra.enforcedPowerLimitW ?? extra.configuredPowerLimitW;
    row.throttleMask = storedMask(extra.throttleMask);
    row.throttle = extra.throttleMask === null ? null : decodeThrottle(extra.throttleMask).join(",");
    rows.push(row);
  }
  return rows;
}

function processBaseName(text) {
  const name = cellText(text);
  if (name === null) return null;
  const parts = name.split(/[\\/]/);
  return (parts[parts.length - 1] || name).slice(0, MAX_PROCESS_NAME_CHARS);
}

// Parses `--query-compute-apps=<PROCS_FIELDS or PROCS_PLAIN_FIELDS>` output.
// Only the executable's base name is kept, so no install or user path ends
// up in the store.
function parseComputeApps(stdout, fields) {
  const fieldList = normalizeFields(fields);
  const position = (name) => fieldList.indexOf(name);
  const entries = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitCells(line, fieldList.length, position("process_name"));
    if (!cells) continue;
    const pidText = cells[position("pid")];
    if (!/^\d+$/.test(pidText || "")) continue;
    entries.push({
      gpuUuid: position("gpu_uuid") >= 0 ? cellText(cells[position("gpu_uuid")]) : null,
      pid: Number(pidText),
      name: processBaseName(cells[position("process_name")]),
      usedMb: cellNumber(cells[position("used_memory")]),
    });
  }
  return entries;
}

function procsList(entries) {
  return entries
    .map(({ pid, name, usedMb }) => ({ pid, name, usedMb }))
    .sort((left, right) => (right.usedMb ?? -1) - (left.usedMb ?? -1) || left.pid - right.pid)
    .slice(0, MAX_PROCS_PER_GPU);
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

// `fieldError` marks nvidia-smi rejecting the field list itself, the only
// failure another list in the chain can fix for good.
function execFailure(error, stdout, stderr) {
  const code = error && error.code;
  let reason = "nvidia_smi_failed";
  if (code === "ENOENT") reason = "nvidia_smi_missing";
  else if (code === "EACCES" || code === "EPERM") reason = "nvidia_smi_denied";
  else if (code === "ETIMEDOUT" || (error && (error.killed || error.signal))) reason = "nvidia_smi_timeout";
  const detail = firstLine(stderr) || firstLine(stdout) || firstLine(error && error.message) || reason;
  const fatal = FATAL_EXEC_CODES.has(reason);
  return {
    ok: false,
    fatal,
    fieldError: !fatal && (code === INVALID_ARGUMENT_EXIT || INVALID_FIELD_TEXT.test(`${stdout ?? ""}\n${stderr ?? ""}`)),
    error: { code: reason, message: redactSecrets(detail).slice(0, MAX_ERROR_CHARS) },
  };
}

function normalizeLogger(logger) {
  const target = logger === undefined ? console : logger;
  return (level, message) => {
    if (!target) return;
    const text = redactSecrets(String(message));
    if (typeof target === "function") {
      target(level, text);
      return;
    }
    const method = typeof target[level] === "function" ? target[level] : target.log;
    if (typeof method === "function") method.call(target, text);
  };
}

// The §11.1 `gpus[]` item.
function liveGpu(row) {
  return {
    index: row.gpuIndex,
    util: row.utilPct,
    memUsedMb: row.memUsedMb,
    memTotalMb: row.memTotalMb,
    tempC: row.tempC,
    powerW: row.powerW,
    powerLimitW: row.powerLimitW,
    throttle: row.throttle ? row.throttle.split(",") : [],
  };
}

// options: { store, execFile, intervalMs = 10000, now, events, logger,
// timers: { setTimeout, clearTimeout }, stopFlushMs = 2000 }. `execFile` has
// the child_process.execFile signature (a promise-returning function
// resolving to { stdout } works too). Tests drive tick() directly or inject
// timers.
function createGpuCollector(options = {}) {
  const store = options.store || null;
  const execFile = typeof options.execFile === "function" ? options.execFile : childProcess.execFile;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timers = options.timers && typeof options.timers.setTimeout === "function"
    ? options.timers
    : { setTimeout, clearTimeout };
  const log = normalizeLogger(options.logger);
  const stopFlushMs = clampInt(options.stopFlushMs, 0, MINUTE_MS, STOP_FLUSH_MS);

  let baseIntervalMs = clampInt(options.intervalMs, 1000, HOUR_MS, DEFAULT_INTERVAL_MS);
  let intervalMs = baseIntervalMs;
  let state = "idle";
  let running = false;
  let stopped = false;
  // Bumped by start() and stop(). A timer callback of an earlier run sees a
  // stale generation and does not reschedule, so start() right after an
  // unawaited stop() never leaves two sampling loops behind.
  let generation = 0;
  let timer = null;
  let lastTickStartedAt = null;
  let inflight = null;
  let stateLoaded = false;
  let consecutiveFailures = 0;
  let lastOkAt = null;
  let lastAttemptAt = null;
  let lastError = null;
  // { step, fields, cachedUntil } for the query that last worked.
  let query = null;
  // memoryReported: true once nvidia-smi gave a per-process number, false
  // once it gave only [N/A] (WDDM), null before either.
  const procs = {
    fields: null, nextAt: 0, pausedUntil: 0, pauseReason: null, memoryReported: null, lastAt: null, lastError: null,
  };
  // gpuIndex → { at, intervalMs } of that GPU's previous sample. intervalMs
  // is the base interval in force then, so changing the interval does not
  // cut a gap that was scheduled under the old one.
  const lastSample = new Map();
  let latestSample = null;
  // Store writes: one batch in flight (`writing`); rows sampled meanwhile
  // wait in pendingRows for the batch `pendingFlush` will send.
  let pendingRows = [];
  let pendingFlush = null;
  let writing = null;
  const counters = { ticks: 0, written: 0, dropped: 0, storeErrors: 0 };

  function clock() {
    const value = Math.floor(Number(now()));
    return Number.isFinite(value) ? value : Date.now();
  }

  function run(args) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(result);
      };
      // execFile's own timeout kills the child; this guard also covers an
      // injected execFile that never calls back.
      const guard = setTimeout(() => finish(execFailure({ code: "ETIMEDOUT", message: "nvidia-smi timed out" })), EXEC_TIMEOUT_MS + 1000);
      guard.unref?.();
      const callback = (error, stdout, stderr) => {
        if (error) finish(execFailure(error, stdout, stderr));
        else finish({ ok: true, stdout: String(stdout ?? "") });
      };
      let returned;
      try {
        returned = execFile(NVIDIA_SMI, args, {
          timeout: EXEC_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: EXEC_MAX_BUFFER,
          encoding: "utf8",
        }, callback);
      } catch (error) {
        finish(execFailure(error));
        return;
      }
      if (returned && typeof returned.then === "function") {
        returned.then(
          (out) => finish({ ok: true, stdout: String((out && typeof out === "object" ? out.stdout : out) ?? "") }),
          (error) => finish(execFailure(error, error && error.stdout, error && error.stderr)),
        );
      }
    });
  }

  async function runQuery(fields) {
    const out = await run([`--query-gpu=${fields.join(",")}`, "--format=csv,noheader,nounits"]);
    if (!out.ok) return out;
    const rows = parseNvidiaSmiTelemetry(out.stdout, fields);
    if (!rows.length) {
      return {
        ok: false,
        fatal: false,
        fieldError: INVALID_FIELD_TEXT.test(out.stdout),
        error: { code: "no_gpu", message: redactSecrets(firstLine(out.stdout) || "nvidia-smi reported no GPU").slice(0, MAX_ERROR_CHARS) },
      };
    }
    return { ok: true, rows };
  }

  // The cached query first. A field error drops it and the chain is walked
  // from the top, skipping the step that just failed. Any other non-fatal
  // failure keeps it: the chain is still walked for this tick's sample, but
  // whatever answers is not cached. A step is cached only when every step
  // tried before it failed with a field error.
  async function sample(at) {
    let skip = -1;
    let cacheable = true;
    let last = null;
    if (query && at < query.cachedUntil) {
      const cached = await runQuery(query.fields);
      if (cached.ok || cached.fatal) return cached;
      last = cached;
      skip = query.step;
      if (cached.fieldError) query = null;
      else cacheable = false;
    } else {
      query = null;
    }
    for (let step = 0; step < QUERY_CHAIN.length; step += 1) {
      if (step === skip) continue;
      const attempt = await runQuery(QUERY_CHAIN[step]);
      if (attempt.ok) {
        if (cacheable) query = { step, fields: QUERY_CHAIN[step], cachedUntil: at + QUERY_CACHE_MS };
        return attempt;
      }
      last = attempt;
      if (attempt.fatal) break;
      if (!attempt.fieldError) cacheable = false;
    }
    return last || { ok: false, fatal: false, error: { code: "nvidia_smi_failed", message: "nvidia-smi query failed" } };
  }

  // The cached variant, or gpu_uuid first and the plain list after it. The
  // same rule as the GPU chain: the plain list is kept only when the driver
  // rejected gpu_uuid, and the kept variant is dropped only on a field error.
  async function queryProcs() {
    const variants = procs.fields ? [procs.fields] : [PROCS_FIELDS, PROCS_PLAIN_FIELDS];
    let cacheable = true;
    let last = null;
    for (const fields of variants) {
      const out = await run([`--query-compute-apps=${fields.join(",")}`, "--format=csv,noheader,nounits"]);
      if (out.ok) {
        if (cacheable) procs.fields = fields;
        return { ok: true, fields, entries: parseComputeApps(out.stdout, fields) };
      }
      last = out;
      if (out.fatal) break;
      if (!out.fieldError) cacheable = false;
    }
    if (last && last.fieldError) procs.fields = null;
    return last;
  }

  // Once a minute, unless paused. With uuids the entries go to their GPU;
  // without them only a single-GPU host can be attributed. GPUs with no
  // compute process get [] once the host has shown it reports numbers.
  async function attachProcs(rows, at) {
    if (at < procs.nextAt || at < procs.pausedUntil) return;
    procs.nextAt = at + PROCS_EVERY_MS;
    const result = await queryProcs();
    if (!result.ok) {
      procs.lastError = result.error;
      return;
    }
    procs.lastAt = at;
    procs.lastError = null;
    const { entries } = result;
    if (entries.length && entries.every((entry) => entry.usedMb === null)) {
      if (procs.memoryReported !== false) {
        log("log", "GPU telemetry: nvidia-smi reports no per-process memory (WDDM); the per-process query is paused for 1 hour.");
      }
      procs.memoryReported = false;
      procs.pausedUntil = at + PROCS_PAUSE_MS;
      procs.pauseReason = "per_process_memory_unavailable";
      return;
    }
    procs.pausedUntil = 0;
    procs.pauseReason = null;
    if (entries.some((entry) => entry.usedMb !== null)) procs.memoryReported = true;
    // No compute process on a host that never reported a number (WDDM with
    // nothing running) cannot be told from "cannot measure": NULL, not [].
    if (!entries.length && procs.memoryReported !== true) return;
    const withUuid = result.fields.includes("gpu_uuid");
    for (const row of rows) {
      if (withUuid && row.gpuUuid) {
        row.procs = procsList(entries.filter((entry) => entry.gpuUuid === row.gpuUuid));
      } else if (rows.length === 1) {
        row.procs = procsList(entries);
      }
    }
  }

  function onFailure(failure, at) {
    consecutiveFailures += 1;
    lastError = { ...failure.error, at };
    const backoff = failure.error.code === "nvidia_smi_missing" || consecutiveFailures >= FAILURES_BEFORE_BACKOFF;
    if (!backoff || stopped) return;
    if (state !== "degraded") {
      log("warn", `GPU telemetry degraded (${failure.error.code}): ${failure.error.message}. Sampling every ${Math.round(Math.max(BACKOFF_INTERVAL_MS, baseIntervalMs) / 1000)} s until nvidia-smi answers again.`);
    }
    state = "degraded";
    intervalMs = Math.max(BACKOFF_INTERVAL_MS, baseIntervalMs);
  }

  function onSuccess(at) {
    if (state === "degraded") log("log", "GPU telemetry recovered.");
    consecutiveFailures = 0;
    lastOkAt = at;
    if (!stopped) state = "ok";
    intervalMs = baseIntervalMs;
  }

  async function loadState(at) {
    if (stateLoaded) return;
    stateLoaded = true;
    if (!store || typeof store.getState !== "function") return;
    let saved = null;
    try {
      saved = await store.getState(STATE_NAME);
    } catch {
      return;
    }
    if (!saved || typeof saved !== "object") return;
    const savedQuery = typeof saved.query === "string" ? saved.query : "";
    const step = QUERY_CHAIN.findIndex((fields) => fields.join(",") === savedQuery);
    const cachedUntil = finiteOrNull(saved.queryCachedUntil);
    if (step >= 0 && cachedUntil !== null && cachedUntil > at) {
      query = { step, fields: QUERY_CHAIN[step], cachedUntil: Math.min(cachedUntil, at + QUERY_CACHE_MS) };
    }
    const pausedUntil = finiteOrNull(saved.procsPausedUntil);
    if (pausedUntil !== null && pausedUntil > at) {
      procs.pausedUntil = Math.min(pausedUntil, at + PROCS_PAUSE_MS);
      procs.pauseReason = typeof saved.procsPauseReason === "string" ? saved.procsPauseReason : "per_process_memory_unavailable";
    }
    if (typeof saved.procsMemoryReported === "boolean") procs.memoryReported = saved.procsMemoryReported;
    if (saved.lastSampleAt && typeof saved.lastSampleAt === "object") {
      for (const [index, value] of Object.entries(saved.lastSampleAt)) {
        const sampleAt = finiteOrNull(value);
        if (/^\d{1,4}$/.test(index) && sampleAt !== null && sampleAt < at) {
          lastSample.set(Number(index), { at: sampleAt, intervalMs: baseIntervalMs });
        }
      }
    }
  }

  async function saveState() {
    if (!store || typeof store.setState !== "function") return;
    try {
      await store.setState(STATE_NAME, {
        query: query ? query.fields.join(",") : null,
        queryCachedUntil: query ? query.cachedUntil : null,
        procsPausedUntil: procs.pausedUntil || null,
        procsPauseReason: procs.pauseReason,
        procsMemoryReported: procs.memoryReported,
        lastSampleAt: Object.fromEntries(Array.from(lastSample, ([index, entry]) => [index, entry.at])),
      });
    } catch {}
  }

  // Returns the rows to queue again: the whole batch when the store says
  // "not now" (busy past busy_timeout resolves retryable:true; a worker that
  // is restarting or crashed rejects with a retryable error), as the
  // recorder keeps its buffer for the same errors. A re-sent row the crashed
  // worker had already committed is ignored as a duplicate (gpu_index, at).
  // Anything else is final: written, rejected or dropped and counted.
  async function writeRows(rows) {
    if (!rows.length || typeof store.insertGpuSamples !== "function") return [];
    try {
      const result = await store.insertGpuSamples(rows);
      if (result && result.retryable === true) {
        counters.storeErrors += 1;
        return rows;
      }
      counters.written += Number(result && result.accepted) || 0;
      counters.dropped += (Number(result && result.dropped) || 0) + (Number(result && result.rejected) || 0);
    } catch (error) {
      counters.storeErrors += 1;
      if (error && error.retryable === true) return rows;
      counters.dropped += rows.length;
    }
    return [];
  }

  // Past MAX_PENDING_ROWS the oldest waiting rows are dropped and counted.
  function capPending() {
    const overflow = pendingRows.length - MAX_PENDING_ROWS;
    if (overflow > 0) {
      pendingRows.splice(0, overflow);
      counters.dropped += overflow;
    }
  }

  // Rows handed back by a retryable failure go ahead of the ones sampled
  // meanwhile and leave with the next batch: the one already waiting on this
  // write, or else the next tick's. They are never retried in a loop.
  function flushPending() {
    const batch = pendingRows;
    pendingRows = [];
    pendingFlush = null;
    const current = (async () => {
      const retry = await writeRows(batch);
      if (retry.length) {
        pendingRows = retry.concat(pendingRows);
        capPending();
      }
      await saveState();
    })();
    writing = current;
    return current.finally(() => {
      if (writing === current) writing = null;
    });
  }

  function scheduleFlush() {
    if (!pendingFlush) pendingFlush = (writing || Promise.resolve()).then(flushPending);
    return pendingFlush;
  }

  // Queues rows for the store without waiting for it, so a slow or busy
  // store worker never delays sampling. Rows that arrive while a batch is in
  // flight go out together once it settles. Resolves once these rows were
  // written, dropped, or handed back to the queue by a retryable failure.
  function persist(rows) {
    if (!store) return Promise.resolve();
    pendingRows.push(...rows);
    capPending();
    return scheduleFlush();
  }

  async function runTick() {
    const at = clock();
    await loadState(at);
    counters.ticks += 1;
    lastAttemptAt = at;
    const result = await sample(at);
    if (!result.ok) {
      onFailure(result, at);
      return { ok: false, at, error: result.error.code };
    }
    const rows = result.rows.map((row) => {
      const current = { at, ...row, energyWh: null, procs: null };
      // Both samples carry the base interval in force when they were taken;
      // the cap uses the larger one (energy.js).
      const previous = lastSample.get(row.gpuIndex) || null;
      current.energyWh = integrateEnergyWh(previous, { at, powerW: row.powerW, intervalMs: baseIntervalMs });
      lastSample.set(row.gpuIndex, { at, intervalMs: baseIntervalMs });
      return current;
    });
    await attachProcs(rows, at);
    onSuccess(at);
    latestSample = { at, rows: rows.map((row) => ({ ...row })) };
    if (stopped) return { ok: true, at, rows, written: false };
    return { ok: true, at, rows, persisted: persist(rows) };
  }

  // One sampling pass; concurrent callers share the pass in flight. It
  // settles once nvidia-smi has answered, before the rows are stored.
  function sampleOnce() {
    if (!inflight) {
      inflight = runTick().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  // One sample now, resolved after its rows reached the store.
  async function tick() {
    const { persisted, ...result } = await sampleOnce();
    if (persisted) await persisted;
    return result;
  }

  // Sends the waiting rows (one more attempt for any a retryable failure
  // handed back) and resolves once nothing is in flight. Rows the store
  // hands back again stay queued for the next tick.
  async function flush() {
    if (store && pendingRows.length) scheduleFlush();
    while (pendingFlush || writing) await (pendingFlush || writing);
  }

  // The next tick is due intervalMs after the previous one started, so the
  // exec time does not stretch the sampling period. The store write is not
  // awaited here.
  function schedule(delayMs, runId) {
    if (!running || runId !== generation) return;
    const handle = timers.setTimeout(async () => {
      if (timer === handle) timer = null;
      if (!running || runId !== generation) return;
      const startedAt = clock();
      lastTickStartedAt = startedAt;
      try {
        await sampleOnce();
      } catch (error) {
        log("error", `GPU telemetry tick failed: ${error && error.message ? error.message : error}`);
      }
      schedule(Math.max(0, intervalMs - (clock() - startedAt)), runId);
    }, delayMs);
    timer = handle;
    if (handle && typeof handle.unref === "function") handle.unref();
  }

  function start() {
    if (running) return api;
    running = true;
    stopped = false;
    generation += 1;
    lastTickStartedAt = null;
    if (state === "idle" || state === "stopped") state = "starting";
    schedule(0, generation);
    return api;
  }

  // Waits for the tick in flight and, for at most stopFlushMs, for the
  // queued rows, so a wedged store cannot hold up the entry's shutdown.
  async function stop() {
    running = false;
    stopped = true;
    generation += 1;
    state = "stopped";
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (inflight) await inflight.catch(() => {});
    if (!pendingFlush && !writing && !pendingRows.length) return;
    let guard = null;
    await Promise.race([
      flush(),
      new Promise((resolve) => {
        guard = setTimeout(resolve, stopFlushMs);
        guard.unref?.();
      }),
    ]);
    clearTimeout(guard);
  }

  // A live telemetry.sampleIntervalMs change (§20). A wait already scheduled
  // is re-timed to the new interval, counted from the last tick's start; a
  // degraded collector keeps its backoff until it recovers.
  function setIntervalMs(value) {
    baseIntervalMs = clampInt(value, 1000, HOUR_MS, baseIntervalMs);
    if (state !== "degraded") intervalMs = baseIntervalMs;
    if (running && timer && lastTickStartedAt !== null) {
      timers.clearTimeout(timer);
      timer = null;
      schedule(Math.max(0, intervalMs - (clock() - lastTickStartedAt)), generation);
    }
    return baseIntervalMs;
  }

  function status() {
    return {
      name: "gpu",
      state,
      intervalMs,
      lastOkAt,
      lastAttemptAt,
      lastError: lastError ? { ...lastError } : null,
      consecutiveFailures,
      query: query ? { step: query.step, fields: query.fields.join(","), cachedUntil: query.cachedUntil } : null,
      procs: {
        enabled: !(procs.pausedUntil > clock()),
        pausedUntil: procs.pausedUntil || null,
        reason: procs.pauseReason,
        memoryReported: procs.memoryReported,
        lastAt: procs.lastAt,
        lastError: procs.lastError ? { ...procs.lastError } : null,
      },
      gpus: latestSample ? latestSample.rows.length : 0,
      pendingRows: pendingRows.length,
      ...counters,
    };
  }

  // The last good sample in the §11.1 `gpus[]` shape, plus the stored rows.
  // Both are JSON-safe.
  function latest() {
    if (!latestSample) return null;
    return {
      at: latestSample.at,
      gpus: latestSample.rows.map(liveGpu),
      samples: latestSample.rows.map((row) => ({ ...row })),
    };
  }

  const api = { start, stop, tick, flush, status, latest, setIntervalMs };
  return api;
}

module.exports = {
  THROTTLE_REASONS,
  QUERY_CHAIN,
  PROCS_FIELDS,
  PROCS_PLAIN_FIELDS,
  createGpuCollector,
  parseNvidiaSmiTelemetry,
  parseComputeApps,
  decodeThrottle,
};
