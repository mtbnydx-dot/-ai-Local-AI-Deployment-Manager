"use strict";

// Manager -> entry telemetry ingest client (docs/overhaul/04 §6.7, TEL-6).
//
// Runs inside the managers. It reports three kinds of rows to the entry's
// loopback endpoints:
//
//   requests     -> POST /internal/telemetry/requests      direct-ingress rows
//   events       -> POST /internal/telemetry/events        legacy config events
//   audit-access -> POST /internal/telemetry/audit-access  legacy /api/audit/* actions
//
// This module never signs anything: `internalClient` is createInternalClient()
// from internal-auth.js, which signs every request and owns the path prefixes.
//
// Delivery is at least once and in order. Reports go through one serial
// queue. When the entry cannot be reached (network failure, 5xx, 401, 429)
// the rows are appended to a JSONL spool, one {kind,row} line per row, and
// replayed in batches of up to 200 on the next success or on flush(). While
// the spool is not empty new rows join its tail, so order is preserved. The
// spool is capped (default 20 MiB); past the cap the oldest lines are dropped
// and counted. Requests replay idempotently (the entry inserts with
// INSERT OR IGNORE on request_id).
//
// Nothing here throws into the caller and nothing logs a row.

const fs = require("node:fs");
const path = require("node:path");
const { newDirectRequestId } = require("./ids");
const { classifyGatewayRoute } = require("./route-class");

const KIND_PATHS = Object.freeze({
  requests: "/internal/telemetry/requests",
  events: "/internal/telemetry/events",
  "audit-access": "/internal/telemetry/audit-access",
});
const BATCH_ROWS = 200;
const DEFAULT_MAX_SPOOL_BYTES = 20 * 1024 * 1024;
const DEFAULT_RETRY_MS = 30 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, max) {
  const out = String(value ?? "").trim();
  return out ? out.slice(0, max) : null;
}

// One manager access-log entry (gateway-utils buildServiceGatewayAccessLogEntry)
// as a `requests` row (04 §5.1: request_id is the manager's own mgr_ id, or a
// fresh one when the manager honoured a client id; manager_request_id is the id
// the manager used). `managerId` is only a hint: the entry sets the real one
// from the signed manager.
function directRequestRow(entry = {}, options = {}) {
  const managerRequestId = text(entry.requestId, 128);
  const endedAt = Number.isFinite(Date.parse(entry.at)) ? Date.parse(entry.at) : Date.now();
  const durationMs = Math.max(0, Math.round(Number(entry.durationMs) || 0));
  const route = classifyGatewayRoute(entry.method, entry.path);
  const protocol = route && route.protocol ? route.protocol : text(entry.kind, 32) || "external";
  const status = Number(entry.status) || 0;
  const input = Number(entry.inputTokens);
  const output = Number(entry.outputTokens);
  const hasUsage = (Number.isFinite(input) && input > 0) || (Number.isFinite(output) && output > 0);
  const requestId = managerRequestId && managerRequestId.startsWith("mgr_") ? managerRequestId : newDirectRequestId();
  const terminalState = ["completed", "failed", "client_abort", "timeout", "rejected"].includes(entry.terminalState)
    ? entry.terminalState
    : (status >= 400 ? "failed" : "completed");
  return {
    requestId,
    clientRequestId: text(entry.clientRequestId, 128),
    managerRequestId,
    ingress: "direct",
    receivedAt: endedAt - durationMs,
    endedAt,
    managerId: text(options.managerId, 80),
    fleetId: null,
    protocol,
    op: route && route.op ? route.op : "other",
    route: route && route.route ? route.route : null,
    method: text(entry.method, 16) || "POST",
    path: text(entry.path, 200) || "/",
    modelRequested: text(entry.model, 220),
    modelResolved: text(entry.resolvedModel, 220),
    stream: entry.stream === true ? 1 : 0,
    keyId: text(entry.keyId, 128),
    authSource: text(entry.authSource, 64),
    clientIp: text(entry.remoteAddress, 64),
    userAgent: text(entry.userAgent, 256),
    originHost: text(entry.refererHost, 253),
    sourceProgram: text(entry.sourceProgram, 64) || "unknown",
    status,
    terminalState,
    errorClass: text(entry.errorClass, 40) || (status >= 400 ? "unknown" : "none"),
    errorCode: null,
    queueMs: Number(entry.queuedMs) > 0 ? Math.round(Number(entry.queuedMs)) : null,
    ttftMs: Number(entry.firstByteMs) > 0 ? Math.round(Number(entry.firstByteMs)) : null,
    durationMs,
    promptTokens: hasUsage ? Math.max(0, Math.round(input) || 0) : null,
    outputTokens: hasUsage ? Math.max(0, Math.round(output) || 0) : null,
    usageSource: hasUsage ? "reported" : "missing",
    finishReason: text(entry.stopReason, 80),
  };
}

function createTelemetryIngestClient(options = {}) {
  const managerId = String(options.managerId || "").trim();
  const internalClient = options.internalClient;
  if (!internalClient || typeof internalClient.request !== "function") {
    throw new TypeError("createTelemetryIngestClient needs an internalClient (createInternalClient).");
  }
  const spoolFile = options.spoolFile ? path.resolve(String(options.spoolFile)) : "";
  const maxSpoolBytes = Math.max(1024, Number(options.maxSpoolBytes) || DEFAULT_MAX_SPOOL_BYTES);
  const batchRows = Math.max(1, Math.min(BATCH_ROWS, Number(options.batchRows) || BATCH_ROWS));
  const retryMs = Math.max(100, Number(options.retryMs) || DEFAULT_RETRY_MS);
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;

  const stats = {
    reported: 0,
    sent: 0,
    duplicates: 0,
    rejected: 0,
    spooled: 0,
    replayed: 0,
    droppedFromSpool: 0,
    droppedInvalid: 0,
    failures: 0,
    lastError: null,
  };
  let queue = Promise.resolve();
  let timer = null;
  let closed = false;

  function noteError(error) {
    stats.failures += 1;
    stats.lastError = String((error && (error.code || error.message)) || error || "error").slice(0, 120);
  }

  // ---- spool (JSONL, one {kind,row} per line, oldest first) ----------------

  function readSpoolLines() {
    if (!spoolFile) return [];
    try {
      return fs.readFileSync(spoolFile, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  function writeSpoolLines(lines) {
    if (!spoolFile) return;
    try {
      if (!lines.length) {
        fs.rmSync(spoolFile, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(spoolFile), { recursive: true });
      const tmp = `${spoolFile}.tmp`;
      fs.writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
      fs.renameSync(tmp, spoolFile);
    } catch (error) {
      noteError(error);
    }
  }

  function spoolBytes() {
    try {
      return fs.statSync(spoolFile).size;
    } catch {
      return 0;
    }
  }

  function enforceCap(lines) {
    let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    let drop = 0;
    while (bytes > maxSpoolBytes && drop < lines.length) {
      bytes -= Buffer.byteLength(lines[drop]) + 1;
      drop += 1;
    }
    if (drop) stats.droppedFromSpool += drop;
    return drop ? lines.slice(drop) : lines;
  }

  function appendSpool(kind, rows) {
    if (!spoolFile || !rows.length) {
      stats.droppedFromSpool += rows.length;
      return;
    }
    const fresh = rows.map((row) => JSON.stringify({ kind, row }));
    stats.spooled += fresh.length;
    const existing = readSpoolLines();
    const all = existing.concat(fresh);
    const kept = enforceCap(all);
    if (kept.length === all.length && existing.length === all.length - fresh.length) {
      try {
        fs.mkdirSync(path.dirname(spoolFile), { recursive: true });
        fs.appendFileSync(spoolFile, `${fresh.join("\n")}\n`, "utf8");
        return;
      } catch (error) {
        noteError(error);
        return;
      }
    }
    writeSpoolLines(kept);
  }

  // ---- transport ------------------------------------------------------------

  // "ok" delivered (or finally refused), "retry" the entry did not take the batch.
  async function post(kind, rows) {
    let response;
    try {
      response = await internalClient.request("POST", KIND_PATHS[kind], { rows });
    } catch (error) {
      noteError(error);
      return "retry";
    }
    const status = Number(response && response.status) || 0;
    const json = response && response.json;
    if (status === 200) {
      stats.sent += rows.length;
      if (isPlainObject(json)) stats.duplicates += Number(json.duplicates) || 0;
      return "ok";
    }
    if (status === 400) {
      // invalid_rows: the valid rows were accepted, the rest never will be.
      stats.sent += rows.length;
      stats.rejected += Array.isArray(json && json.errors) ? json.errors.length : 0;
      return "ok";
    }
    if (status === 413) {
      if (rows.length > 1) {
        const half = Math.ceil(rows.length / 2);
        if ((await post(kind, rows.slice(0, half))) !== "ok") return "retry";
        return post(kind, rows.slice(half));
      }
      stats.droppedInvalid += 1;
      return "ok";
    }
    // 401 (key rotated, clock skew), 429, 5xx and anything unexpected.
    noteError(`http_${status}`);
    return "retry";
  }

  function scheduleRetry() {
    if (timer || closed || !spoolFile) return;
    timer = setTimer(() => {
      timer = null;
      enqueue(replay).catch(() => {});
    }, retryMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  // Sends the spool oldest first, one same-kind batch at a time, and removes
  // each delivered batch before the next. Stops at the first failure.
  async function replay() {
    let lines = readSpoolLines();
    if (!lines.length) return true;
    while (lines.length) {
      let kind = "";
      const rows = [];
      let consumed = 0;
      for (const line of lines) {
        let entry = null;
        try { entry = JSON.parse(line); } catch { entry = null; }
        if (!entry || !KIND_PATHS[entry.kind] || !isPlainObject(entry.row)) {
          if (!rows.length) {
            consumed += 1;
            stats.droppedInvalid += 1;
            continue;
          }
          break;
        }
        if (kind && entry.kind !== kind) break;
        if (rows.length >= batchRows) break;
        kind = entry.kind;
        rows.push(entry.row);
        consumed += 1;
      }
      if (!rows.length) {
        lines = lines.slice(consumed);
        writeSpoolLines(lines);
        continue;
      }
      if ((await post(kind, rows)) !== "ok") {
        scheduleRetry();
        return false;
      }
      stats.replayed += rows.length;
      lines = lines.slice(consumed);
      writeSpoolLines(lines);
    }
    return true;
  }

  async function deliver(kind, rows) {
    if (spoolBytes() > 0) {
      // Older rows are waiting; this batch joins the tail so order holds.
      appendSpool(kind, rows);
      await replay();
      return;
    }
    for (let i = 0; i < rows.length; i += batchRows) {
      const batch = rows.slice(i, i + batchRows);
      if ((await post(kind, batch)) !== "ok") {
        appendSpool(kind, rows.slice(i));
        scheduleRetry();
        return;
      }
    }
  }

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  // Never rejects. The promise settles when the rows were delivered or spooled.
  function report(kind, rows) {
    const list = Array.isArray(rows) ? rows.filter(isPlainObject) : [];
    if (!KIND_PATHS[kind] || !list.length || closed) return Promise.resolve();
    stats.reported += list.length;
    return enqueue(() => deliver(kind, list)).catch((error) => { noteError(error); });
  }

  // Replays whatever is spooled; resolves true when the spool is empty.
  function flush() {
    return enqueue(replay).catch((error) => {
      noteError(error);
      return false;
    });
  }

  function close() {
    closed = true;
    if (timer) clearTimer(timer);
    timer = null;
    return queue;
  }

  return {
    managerId,
    report,
    flush,
    close,
    stats: () => ({ ...stats, spoolBytes: spoolFile ? spoolBytes() : 0, spoolFile: spoolFile ? path.basename(spoolFile) : "" }),
  };
}

module.exports = {
  BATCH_ROWS,
  DEFAULT_MAX_SPOOL_BYTES,
  KIND_PATHS,
  createTelemetryIngestClient,
  directRequestRow,
};
