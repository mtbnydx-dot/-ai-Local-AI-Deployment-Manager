"use strict";

// GatewayRecorder (docs/overhaul/04-telemetry.md §6): one `requests` row per
// gateway request, finalised exactly once, buffered in memory and written to
// the TelemetryStore in batches.
//
// createGatewayRecorder({ store, now, monotonic, lookupCustomer, onRow,
//   bufferMax = 10000, flushMs = 1000, onResponseDone, logger })
//   → { begin(req, res, init) → RecordHandle, inflight(), stats(), flush(), start(), stop() }
//
// `store` is a TelemetryStore or a function returning one (the entry opens
// the store after the recorder exists; rows wait in the buffer until then).
// `lookupCustomer(managerId, keyId)` is billing's cached read-only lookup
// (§5.3); `onRow(row, { req, res })` sees every recorded row, which is how
// the entry keeps feeding its legacy JSONL access log (§6.5).
//
// Finalisation is driven by P0-OBS-3's onResponseDone, the one finish/close
// listener pair per response: "completed" on finish, "client_abort" on a
// close before finish (499 when no header was sent). A safety timer
// (request timeout + 60 s) finalises a record that never ends as
// failed/internal, and stop() finalises what is still in flight. The handle's
// `done` promise resolves once with the row and never rejects.
//
// Control and static requests (route-class.js) produce no row unless their
// status is 401, 403, 429 or >= 500; every one of them increments
// control_counts_1m(route, status_class). While the recorder runs it marks
// each minute in coverage_1m(bucket, 'recorder') (§6.4).
//
// Telemetry is never on the request's critical path: nothing here throws
// into the caller, waits on the store, or touches the response status,
// headers or bytes. tap() is a pass-through Transform that forwards every
// chunk unchanged and only lets the sniffer look at a copy.

const { performance } = require("node:perf_hooks");
const { Transform } = require("node:stream");
const { onResponseDone: defaultOnResponseDone } = require("../gateway-utils");
const { redactSecrets } = require("../secret-redactor");
const { newRequestId, isTelemetryRequestId, normalizeClientRequestId } = require("./ids");
const { classifyGatewayRoute } = require("./route-class");
const { classifyOutcome, statusClass } = require("./error-class");
const { inferSourceProgram } = require("./source-program");
const { createResponseSniffer } = require("./sniffer");

const MINUTE_MS = 60_000;
const DEFAULT_BUFFER_MAX = 10_000;
const DEFAULT_FLUSH_MS = 1000;
// §4.1: one transaction per flush, at 1 s or 500 rows.
const BATCH_ROWS = 500;
const DEFAULT_STOP_FLUSH_MS = 2000;
// The entry's gateway timeout (SERVICE_ENTRY_GATEWAY_TIMEOUT_MS default) plus
// the 60 s grace of §6.1.
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const SAFETY_GRACE_MS = 60_000;
const MAX_TIMER_MS = 2_147_000_000;
// decode_tps needs at least this much time after the first token (§6.1).
const MIN_DECODE_WINDOW_MS = 100;
const RECORDED_CONTROL_STATUSES = new Set([401, 403, 429]);
const USER_AGENT_MAX = 240;
const SHORT_TEXT_MAX = 160;
const EXTRA_KEYS = new Set(["toolSchemaCount", "toolUseCount", "ttsCharacters", "audioMs", "routeReason", "dupOf"]);
const RETRYABLE_STORE_CODES = new Set(["telemetry_store_busy", "telemetry_store_restarting", "telemetry_store_crashed"]);

function headerText(headers, name, max = USER_AGENT_MAX) {
  const value = headers ? headers[name] : undefined;
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined || text === null ? "" : String(text).trim().slice(0, max);
}

function hostOf(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text).host.slice(0, SHORT_TEXT_MAX);
  } catch {
    return text.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].slice(0, SHORT_TEXT_MAX);
  }
}

function textOrNull(value, max = SHORT_TEXT_MAX) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function nonNegativeOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function roundMs(value) {
  return value === null || value === undefined ? null : Math.max(0, Math.round(value));
}

// "::ffff:192.0.2.1" is the IPv4 client on a dual-stack socket.
function normalizeClientIp(value) {
  const text = textOrNull(value, 64);
  if (!text) return null;
  return text.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1");
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[String(name).toLowerCase()];
}

function minuteOf(at) {
  return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}

function createGatewayRecorder(options = {}) {
  const storeOption = options.store;
  const getStore = typeof storeOption === "function" ? storeOption : () => storeOption || null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const monotonic = typeof options.monotonic === "function" ? options.monotonic : () => performance.now();
  const lookupCustomer = typeof options.lookupCustomer === "function" ? options.lookupCustomer : null;
  const onRow = typeof options.onRow === "function" ? options.onRow : null;
  const onResponseDone = typeof options.onResponseDone === "function" ? options.onResponseDone : defaultOnResponseDone;
  const bufferMax = Math.max(1, Math.floor(Number(options.bufferMax) || DEFAULT_BUFFER_MAX));
  const flushMs = Math.max(10, Math.floor(Number(options.flushMs) || DEFAULT_FLUSH_MS));
  const logger = options.logger === undefined ? console : options.logger;

  const handles = new Set();
  const buffer = [];
  const controlCounts = new Map();
  const counters = {
    begun: 0,
    rows: 0,
    controls: 0,
    written: 0,
    duplicates: 0,
    discarded: 0,
    dropped: 0,
    rowErrors: 0,
    flushes: 0,
    flushErrors: 0,
  };
  let flushChain = Promise.resolve();
  let flushing = false;
  let soonTimer = null;
  let flushTimer = null;
  let coveredBucket = null;
  let lastFlushAt = null;
  let lastError = null;
  const loggedErrors = new Set();

  function logOnce(key, message) {
    if (!logger || loggedErrors.has(key)) return;
    loggedErrors.add(key);
    const method = typeof logger.warn === "function" ? logger.warn : logger.log;
    if (typeof method === "function") method.call(logger, redactSecrets(String(message)));
  }

  function noteError(code, message) {
    lastError = { code: String(code || "telemetry_error"), at: now() };
    logOnce(`${code}`, message);
  }

  // ---------------------------------------------------------------- buffer

  function enqueueRow(row) {
    buffer.push(row);
    if (buffer.length > bufferMax) {
      const excess = buffer.length - bufferMax;
      buffer.splice(0, excess);
      counters.dropped += excess;
    }
    if (buffer.length >= BATCH_ROWS && !soonTimer && flushTimer) {
      soonTimer = setImmediate(() => {
        soonTimer = null;
        if (!flushing) flush();
      });
      soonTimer.unref?.();
    }
  }

  function countControl(at, route, status) {
    const key = `${minuteOf(at)}\n${route}\n${statusClass(status)}`;
    controlCounts.set(key, (controlCounts.get(key) || 0) + 1);
    counters.controls += 1;
  }

  function takeControlRows() {
    const rows = [];
    for (const [key, count] of controlCounts) {
      const [bucket, route, cls] = key.split("\n");
      rows.push({ bucket: Number(bucket), route, statusClass: cls, count });
    }
    controlCounts.clear();
    return rows;
  }

  function restoreControlRows(rows) {
    for (const row of rows) {
      const key = `${row.bucket}\n${row.route}\n${row.statusClass}`;
      controlCounts.set(key, (controlCounts.get(key) || 0) + row.count);
    }
  }

  function retryable(result) {
    return Boolean(result && (result.retryable === true || RETRYABLE_STORE_CODES.has(result.error)));
  }

  async function callStore(store, method, rows) {
    try {
      return await store[method](rows);
    } catch (error) {
      return { error: (error && error.code) || "telemetry_store_error", retryable: Boolean(error && error.retryable) };
    }
  }

  async function writeControlCounts(store) {
    if (!controlCounts.size || typeof store.recordControlCounts !== "function") return;
    const rows = takeControlRows();
    const result = await callStore(store, "recordControlCounts", rows);
    if (retryable(result)) restoreControlRows(rows);
    else if (result && result.error) noteError(result.error, `Telemetry control counts were not written (${result.error}).`);
  }

  async function writeCoverage(store) {
    const bucket = minuteOf(now());
    if (bucket === coveredBucket || typeof store.recordCoverage !== "function") return;
    const result = await callStore(store, "recordCoverage", [{ bucket, component: "recorder" }]);
    if (result && !result.error && (result.accepted || result.duplicates)) coveredBucket = bucket;
  }

  async function writeRows(store) {
    while (buffer.length) {
      const batch = buffer.splice(0, BATCH_ROWS);
      const result = await callStore(store, "insertRequests", batch);
      if (retryable(result)) {
        // The store is restarting or locked: keep the rows, oldest first, and
        // try again on the next flush.
        buffer.unshift(...batch);
        if (buffer.length > bufferMax) {
          const excess = buffer.length - bufferMax;
          buffer.splice(0, excess);
          counters.dropped += excess;
        }
        noteError(result.error, `Telemetry rows are waiting for the store (${result.error}).`);
        return;
      }
      counters.written += Number(result && result.accepted) || 0;
      counters.duplicates += Number(result && result.duplicates) || 0;
      counters.rowErrors += Number(result && result.rejected) || 0;
      counters.discarded += Number(result && result.dropped) || 0;
      if (result && result.error) noteError(result.error, `Telemetry rows were discarded (${result.error}).`);
    }
  }

  async function runFlush() {
    const store = getStore();
    if (!store) return;
    flushing = true;
    try {
      await writeControlCounts(store);
      await writeCoverage(store);
      await writeRows(store);
      counters.flushes += 1;
      lastFlushAt = now();
    } catch (error) {
      counters.flushErrors += 1;
      noteError("telemetry_flush_failed", `Telemetry flush failed: ${error && error.message}`);
    } finally {
      flushing = false;
    }
  }

  // Flushes run one after another; a flush started after a row was buffered
  // has written it (or kept it for a retry) when its promise resolves.
  function flush() {
    const run = flushChain.then(runFlush, runFlush);
    flushChain = run.catch(() => {});
    return run.then(() => undefined, () => undefined);
  }

  // ---------------------------------------------------------------- records

  function begin(req, res, init = {}) {
    const headers = (req && req.headers) || {};
    const method = String(init.method || (req && req.method) || "GET").toUpperCase();
    const path = String(init.path || String((req && req.url) || "/").split("?")[0]).slice(0, 2000);
    const classified = classifyGatewayRoute(method, path) || { kind: "traffic", protocol: "other", op: "other", route: null };
    const kind = init.kind || classified.kind;
    const protocol = String(init.protocol || classified.protocol || "other");
    const op = String(init.op || classified.op || "other");
    const requestId = isTelemetryRequestId(init.requestId) ? init.requestId : newRequestId();
    const clientRequestId = init.clientRequestId !== undefined
      ? normalizeClientRequestId(init.clientRequestId)
      : normalizeClientRequestId(headers["x-request-id"]);
    const receivedAt = Number(now());
    const startT = monotonic();
    const userAgent = init.userAgent !== undefined ? String(init.userAgent || "").slice(0, USER_AGENT_MAX) : headerText(headers, "user-agent");
    const originHeader = headerText(headers, "origin", 400) || headerText(headers, "referer", 400);
    const originHost = init.originHost !== undefined ? String(init.originHost || "") : hostOf(originHeader);
    const owui = init.owui && typeof init.owui === "object" ? init.owui : {};

    const state = {
      finalized: false,
      route: textOrNull(init.route !== undefined ? init.route : classified.route, 80),
      ingress: String(init.ingress || "entry"),
      clientIp: normalizeClientIp(init.clientIp !== undefined ? init.clientIp : req && req.socket && req.socket.remoteAddress),
      clientCountry: textOrNull(init.clientCountry, 8),
      keyId: textOrNull(init.keyId),
      customerId: textOrNull(init.customerId),
      authSource: textOrNull(init.authSource, 64),
      authManagerId: textOrNull(init.authManagerId, 64),
      sourceProgram: textOrNull(init.sourceProgram, 64) || inferSourceProgram({
        userAgent,
        origin: headerText(headers, "origin", 400),
        referer: headerText(headers, "referer", 400),
        protocol,
        path,
        xTitle: headerText(headers, "x-title", 200) || headerText(headers, "x-ai-client", 200),
      }) || "unknown",
      owuiUserId: textOrNull(owui.userId !== undefined ? owui.userId : headerText(headers, "x-openwebui-user-id", 200)),
      owuiChatId: textOrNull(owui.chatId !== undefined ? owui.chatId : headerText(headers, "x-openwebui-chat-id", 200)),
      managerId: null,
      fleetId: null,
      engineId: null,
      runtimeId: null,
      launchId: null,
      modelRequested: null,
      modelResolved: null,
      stream: false,
      estimatedInputTokens: 0,
      extra: {},
      rejected: null,
      failure: null,
      entryQueueMs: null,
      managerQueueMs: null,
      dispatchedAt: null,
      headersAt: null,
      upstreamStatus: null,
      sse: false,
      sniffer: null,
      tapped: false,
      streamError: false,
      timedOut: false,
    };
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    const ensureSniffer = (contentType = "") => {
      if (!state.sniffer) {
        state.sniffer = createResponseSniffer({
          protocol,
          stream: state.stream,
          contentType,
          estimatedInputTokens: state.estimatedInputTokens,
          status: state.upstreamStatus || 0,
        });
      }
      return state.sniffer;
    };

    const handle = {
      requestId,
      clientRequestId,
      kind,
      protocol,
      op,
      done,
      get finalized() {
        return state.finalized;
      },
      setAuth(auth = {}) {
        if (state.finalized || !auth || typeof auth !== "object") return handle;
        if (auth.keyId !== undefined) state.keyId = textOrNull(auth.keyId);
        if (auth.customerId !== undefined) state.customerId = textOrNull(auth.customerId);
        if (auth.authSource !== undefined) state.authSource = textOrNull(auth.authSource, 64);
        if (auth.authManagerId !== undefined) state.authManagerId = textOrNull(auth.authManagerId, 64);
        return handle;
      },
      setRouting(routing = {}) {
        if (state.finalized || !routing || typeof routing !== "object") return handle;
        for (const name of ["managerId", "fleetId", "engineId", "runtimeId", "launchId"]) {
          if (routing[name] !== undefined) state[name] = textOrNull(routing[name], 128);
        }
        if (routing.modelRequested !== undefined) state.modelRequested = textOrNull(routing.modelRequested);
        if (routing.modelResolved !== undefined) state.modelResolved = textOrNull(routing.modelResolved);
        if (routing.stream !== undefined) state.stream = routing.stream === true;
        if (routing.estimatedInputTokens !== undefined) state.estimatedInputTokens = Number(routing.estimatedInputTokens) || 0;
        if (routing.routeReason) state.extra.routeReason = String(routing.routeReason).slice(0, 80);
        return handle;
      },
      setExtra(fields = {}) {
        if (state.finalized || !fields || typeof fields !== "object") return handle;
        for (const [name, value] of Object.entries(fields)) {
          if (!EXTRA_KEYS.has(name) || value === undefined || value === null) continue;
          state.extra[name] = typeof value === "number" ? value : String(value).slice(0, 80);
        }
        return handle;
      },
      // Time spent waiting for an entry concurrency slot (§6.1 queue_ms).
      queued(ms) {
        const value = nonNegativeOrNull(ms);
        if (!state.finalized && value !== null) state.entryQueueMs = (state.entryQueueMs || 0) + value;
        return handle;
      },
      // A refusal before any upstream call; the status that counts is the one
      // the response finally carries.
      reject({ status, code } = {}) {
        if (!state.finalized) state.rejected = { status: Number(status) || 0, code: textOrNull(code, 128) || "" };
        return handle;
      },
      dispatched() {
        if (!state.finalized && state.dispatchedAt === null) state.dispatchedAt = monotonic();
        return handle;
      },
      headers(status, upstreamHeaders) {
        if (state.finalized) return handle;
        state.upstreamStatus = Number(status) || 0;
        state.headersAt = monotonic();
        const queued = nonNegativeOrNull(readHeader(upstreamHeaders, "x-local-llm-queued-ms"));
        if (queued !== null) state.managerQueueMs = queued;
        const contentType = String(readHeader(upstreamHeaders, "content-type") || "");
        state.sse = contentType.toLowerCase().includes("text/event-stream");
        state.sniffer = null;
        ensureSniffer(contentType);
        return handle;
      },
      tap() {
        state.tapped = true;
        return new Transform({
          transform(chunk, _encoding, callback) {
            if (!state.finalized) {
              try {
                ensureSniffer().push(chunk, monotonic());
              } catch {
                // The sniffer is a side channel; the chunk is forwarded anyway.
              }
            }
            callback(null, chunk);
          },
          destroy(error, callback) {
            // The upstream body failed (or the pipeline was torn down after the
            // client left, which finalisation has already seen).
            if (error && !state.finalized) state.streamError = true;
            callback(error);
          },
        });
      },
      fail({ status, code, phase } = {}) {
        if (!state.finalized) {
          state.failure = {
            status: Number(status) || 0,
            code: textOrNull(code, 128) || "",
            phase: ["pre_upstream", "upstream", "stream"].includes(phase) ? phase : null,
          };
        }
        return handle;
      },
      // The entry's upstream timer fired (createUpstreamControl).
      timedOut() {
        if (!state.finalized) state.timedOut = true;
        return handle;
      },
    };

    function phaseOf() {
      if (state.failure && state.failure.phase) return state.failure.phase;
      if (state.rejected && state.dispatchedAt === null) return "pre_upstream";
      if (state.upstreamStatus !== null) return state.upstreamStatus >= 400 ? "upstream" : "stream";
      if (state.failure) return state.dispatchedAt !== null ? "upstream" : "pre_upstream";
      return "pre_upstream";
    }

    function buildRow(terminalState, endT, forced) {
      const headersSent = Boolean(res && res.headersSent);
      const responseStatus = Number(res && res.statusCode) || 0;
      const sniffed = state.sniffer ? state.sniffer.finish() : null;
      const upstreamError = sniffed && sniffed.upstreamError;
      const code = (state.failure && state.failure.code) || (state.rejected && state.rejected.code) || (upstreamError && upstreamError.code) || "";
      const phase = phaseOf();
      let status;
      let outcome;
      if (forced) {
        status = headersSent ? responseStatus : 0;
        outcome = { terminalState: "failed", errorClass: "internal", errorCode: forced };
      } else if (terminalState === "client_abort") {
        status = headersSent ? responseStatus : 499;
        outcome = state.streamError && !state.timedOut
          ? classifyOutcome({ phase: "stream", status, code, streamError: true })
          : classifyOutcome({ phase, status, code, aborted: !state.timedOut, timedOut: state.timedOut });
      } else {
        status = responseStatus || (state.failure && state.failure.status) || (state.rejected && state.rejected.status) || 0;
        outcome = classifyOutcome({
          phase,
          status,
          code,
          upstreamErrorText: upstreamError ? upstreamError.text : "",
          streamError: state.streamError && phase === "stream",
          timedOut: state.timedOut,
        });
      }
      const durationMs = Math.max(0, endT - startT);
      const usage = sniffed && state.upstreamStatus !== null && sniffed.usage && sniffed.usage.source !== "missing"
        ? sniffed.usage
        : null;
      const llm = ["openai", "opencode", "claude", "external"].includes(protocol);
      const usageSource = state.upstreamStatus === null || !llm ? null : usage ? usage.source : "missing";
      const outputTokens = usage ? usage.outputTokens : null;
      const firstTokenAt = sniffed ? sniffed.firstTokenAt : null;
      const stream = state.sse || state.stream;
      const ttftMs = state.sse && firstTokenAt !== null && state.dispatchedAt !== null ? firstTokenAt - state.dispatchedAt : null;
      let decodeTps = null;
      if (state.sse && firstTokenAt !== null && Number.isFinite(outputTokens) && outputTokens >= 2) {
        const window = endT - firstTokenAt;
        if (window >= MIN_DECODE_WINDOW_MS) decodeTps = Math.round(((outputTokens - 1) / (window / 1000)) * 100) / 100;
      }
      let finishReason = sniffed ? sniffed.finishReason : null;
      if (!finishReason && outcome.terminalState === "client_abort") finishReason = "abort";
      else if (!finishReason && (outcome.terminalState === "failed" || outcome.terminalState === "timeout") && state.upstreamStatus !== null) finishReason = "error";
      const timings = sniffed && sniffed.engineTimings;
      const queueParts = [state.entryQueueMs, state.managerQueueMs].filter((value) => value !== null);
      let customerId = state.customerId;
      if (!customerId && state.keyId && lookupCustomer) {
        try {
          const found = lookupCustomer(state.authManagerId || state.managerId || "", state.keyId);
          customerId = textOrNull(found && typeof found === "object" ? found.customerId : found);
        } catch {
          customerId = null;
        }
      }
      return {
        requestId,
        clientRequestId: clientRequestId || null,
        managerRequestId: state.dispatchedAt !== null ? requestId : null,
        ingress: state.ingress,
        receivedAt,
        endedAt: receivedAt + Math.round(durationMs),
        managerId: state.managerId,
        fleetId: state.fleetId,
        engineId: state.engineId,
        runtimeId: state.runtimeId,
        launchId: state.launchId,
        protocol,
        op,
        route: state.route,
        method,
        path: path.slice(0, 200),
        modelRequested: state.modelRequested,
        modelResolved: state.modelResolved,
        stream: stream ? 1 : 0,
        keyId: state.keyId,
        customerId,
        authSource: state.authSource,
        clientIp: state.clientIp,
        clientCountry: state.clientCountry,
        userAgent: userAgent || null,
        originHost: originHost || null,
        sourceProgram: state.sourceProgram,
        owuiUserId: state.owuiUserId,
        owuiChatId: state.owuiChatId,
        status,
        terminalState: outcome.terminalState,
        errorClass: outcome.errorClass,
        errorCode: outcome.errorCode,
        queueMs: queueParts.length ? roundMs(queueParts.reduce((sum, value) => sum + value, 0)) : null,
        upstreamHeadersMs: state.headersAt !== null && state.dispatchedAt !== null ? roundMs(state.headersAt - state.dispatchedAt) : null,
        ttftMs: roundMs(ttftMs),
        durationMs: Math.round(durationMs),
        decodeTps,
        promptTokens: usage ? usage.promptTokens : null,
        cachedTokens: usage ? usage.cachedTokens : null,
        outputTokens,
        reasoningTokens: usage ? usage.reasoningTokens : null,
        usageSource,
        finishReason,
        bytesOut: state.tapped && sniffed ? sniffed.bytes : null,
        enginePromptMs: timings ? timings.promptMs : null,
        engineDecodeTps: timings ? timings.decodeTps : null,
        engineCachedTokens: timings && Number.isFinite(timings.cachedTokens) ? Math.round(timings.cachedTokens) : null,
        extra: Object.keys(state.extra).length ? { ...state.extra } : null,
      };
    }

    function finalize(terminalState, forced = null) {
      if (state.finalized) return;
      state.finalized = true;
      clearTimeout(safetyTimer);
      handles.delete(handle);
      let row = null;
      try {
        row = buildRow(terminalState, monotonic(), forced);
      } catch (error) {
        noteError("telemetry_row_failed", `Telemetry could not build a request row: ${error && error.message}`);
      }
      if (row) {
        const recorded = kind === "traffic" || RECORDED_CONTROL_STATUSES.has(row.status) || row.status >= 500;
        if (kind !== "traffic") countControl(row.receivedAt, state.route || "other", row.status);
        if (recorded) {
          counters.rows += 1;
          enqueueRow(row);
          if (onRow) {
            try {
              onRow(row, { req, res });
            } catch (error) {
              noteError("telemetry_on_row_failed", `Telemetry row consumer failed: ${error && error.message}`);
            }
          }
        }
      }
      resolveDone(row);
    }

    handle.finalizeForShutdown = () => finalize("client_abort", "entry_shutdown");

    counters.begun += 1;
    handles.add(handle);
    const timeoutMs = Math.max(1000, Number(init.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
    const safetyTimer = setTimeout(() => finalize("client_abort", "internal"), Math.min(MAX_TIMER_MS, timeoutMs + SAFETY_GRACE_MS));
    safetyTimer.unref?.();
    if (res) {
      try {
        onResponseDone(res, ({ terminalState }) => finalize(terminalState === "client_abort" ? "client_abort" : "completed"));
      } catch (error) {
        noteError("telemetry_begin_failed", `Telemetry could not watch a response: ${error && error.message}`);
      }
    }
    return handle;
  }

  // ---------------------------------------------------------------- lifecycle

  function start() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      if (!flushing) flush();
    }, flushMs);
    flushTimer.unref?.();
    flush();
  }

  // Stops the timers, finalises what is still in flight (failed/internal,
  // code entry_shutdown) and flushes, bounded by flushMs.
  async function stop({ flushMs: capMs = DEFAULT_STOP_FLUSH_MS } = {}) {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    if (soonTimer) clearImmediate(soonTimer);
    soonTimer = null;
    for (const handle of Array.from(handles)) handle.finalizeForShutdown();
    const wait = Math.max(0, Number(capMs) || 0);
    let timer;
    const flushed = await Promise.race([
      flush().then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), wait); }),
    ]);
    clearTimeout(timer);
    return { ok: true, timedOut: !flushed, buffered: buffer.length };
  }

  function stats() {
    return {
      inflight: handles.size,
      buffered: buffer.length,
      controlPending: controlCounts.size,
      ...counters,
      coveredBucket,
      lastFlushAt,
      lastError,
      running: Boolean(flushTimer),
    };
  }

  return {
    begin,
    inflight: () => handles.size,
    stats,
    flush,
    start,
    stop,
  };
}

module.exports = {
  BATCH_ROWS,
  createGatewayRecorder,
};
