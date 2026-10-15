"use strict";

// Telemetry routes (04 §11), mounted for /api/telemetry/ by one line in the
// entry's route-mount table. TEL-18 serves the import endpoints and TEL-11 the
// query, export and settings endpoints (createQueryRoutes below); the alert
// endpoints of TEL-13 add their rows later. A path this module does not
// serve falls through to the entry's 404.
//
//   POST /api/telemetry/import {sources, dryRun}  -> {ok, runId}
//   GET  /api/telemetry/import/:runId             -> progress, then the report
//
// Both are owner only (04 §11.8): never registered for viewers, declared
// admin-only so 05's route inventory lists them. Importers are explicit owner
// actions and the first run is a dry run, so `dryRun` is true unless the
// body says false. One run is active at a time. A finished run publishes
// exactly one `notification` on the event bus; there is no import event type.
// Runs live in memory (the last 20); the import_runs table in the store is
// what makes a repeated import write nothing.

const crypto = require("node:crypto");
const { redactSecrets } = require("../../manager-core/secret-redactor");
const importers = require("../../manager-core/telemetry/importers");

const OWNER = "04";
const IMPORT_PATH = "/api/telemetry/import";
const RUN_PATH = /^\/api\/telemetry\/import\/([A-Za-z0-9_-]{1,64})$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RUNS = 20;
const SYSTEM_OWNER_PRINCIPALS = new Set(["system:cli"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorBody(code, message, extra = {}) {
  const { hint, errors, details } = extra;
  return {
    ok: false,
    error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) },
    ...(Array.isArray(errors) && errors.length ? { errors } : {}),
  };
}

// Who is calling: the owner (and system:cli, which 05 makes owner-equivalent)
// may use these routes; nobody else does.
function resolveCaller(auth, req) {
  let who = {};
  try {
    who = auth.principal(req) || {};
  } catch {
    who = {};
  }
  const principal = String(who.principal || "");
  if (who.role === "owner") return "owner";
  if (who.role === "system" && SYSTEM_OWNER_PRINCIPALS.has(principal)) return "owner";
  if (who.role === "viewer" || who.role === "system") return "other";
  return "none";
}

// The retention and day-boundary settings of telemetry (04 §20), read from the
// platform config when it is installed; the importers' defaults otherwise.
function readTelemetrySettings(aiRoot, env) {
  try {
    const { readSection } = require("../../manager-core/platform/config");
    const result = readSection("telemetry", { aiRoot, env });
    const values = isPlainObject(result && result.values) ? result.values : {};
    return {
      retention: isPlainObject(values.retention) ? values.retention : undefined,
      timezoneOffsetMinutes: values.timezoneOffsetMinutes,
    };
  } catch {
    return {};
  }
}

function skippedTotal(report) {
  return Object.values(report.rowsSkipped || {}).reduce((sum, count) => sum + count, 0);
}

// 00 §9.6: {kind, severity, title{zh,en}, body{zh,en}, action?}.
function importNotification(run) {
  const report = run.report;
  if (run.state === "failed" || !report) {
    return {
      kind: "telemetry.import",
      severity: "error",
      title: { zh: "导入失败", en: "Import failed" },
      body: { zh: "遥测历史导入没有完成，请查看报告。", en: "The telemetry history import did not finish. See the report." },
      action: { label: { zh: "查看报告", en: "View report" }, apiCall: { method: "GET", path: `${IMPORT_PATH}/${run.runId}` } },
    };
  }
  const skipped = skippedTotal(report);
  const dry = run.dryRun;
  return {
    kind: "telemetry.import",
    severity: report.ok ? "success" : "warn",
    title: { zh: "导入完成", en: "Import finished" },
    body: {
      zh: `${dry ? "试运行，未写入任何数据。" : ""}读取 ${report.rowsIn} 行，${dry ? "可写入" : "写入"} ${report.rowsWritten} 行，跳过 ${skipped} 行。`,
      en: `${dry ? "Dry run, nothing was written. " : ""}Read ${report.rowsIn} rows, ${dry ? "would write" : "wrote"} ${report.rowsWritten}, skipped ${skipped}.`,
    },
    action: { label: { zh: "查看报告", en: "View report" }, apiCall: { method: "GET", path: `${IMPORT_PATH}/${run.runId}` } },
  };
}

function publicRun(run) {
  return {
    ok: true,
    runId: run.runId,
    state: run.state,
    dryRun: run.dryRun,
    sources: run.sources,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    progress: run.progress,
    report: run.report,
    ...(run.error ? { error: run.error } : {}),
  };
}

/**
 * createImportRoutes({ auth, sendJson, readJsonObjectBody, getStore, getBus,
 *   aiRoot, managers, entryRoot, env, logger, now, runImport, readSettings })
 * → { handle(req, res, url) → Promise<boolean>, runs(), close() }.
 * `getStore()` returns the TelemetryStore (or null while telemetry is off) and
 * `getBus()` the event bus; both are read per request.
 */
function createImportRoutes(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function") {
    throw new TypeError("createImportRoutes needs the request-auth seam");
  }
  const sendJson = typeof options.sendJson === "function" ? options.sendJson : (res, data, status = 200) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const readJsonObjectBody = options.readJsonObjectBody;
  const getStore = typeof options.getStore === "function" ? options.getStore : () => null;
  const getBus = typeof options.getBus === "function" ? options.getBus : () => null;
  const runImport = typeof options.runImport === "function" ? options.runImport : importers.runImport;
  const readSettings = typeof options.readSettings === "function" ? options.readSettings : () => readTelemetrySettings(options.aiRoot, options.env);
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const logger = options.logger || console;
  const runs = new Map();
  let closed = false;

  function warn(line) {
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  }

  function sendError(res, status, code, message, extra) {
    sendJson(res, errorBody(code, message, extra), status);
  }

  function activeRun() {
    for (const run of runs.values()) if (run.state === "running") return run;
    return null;
  }

  function remember(run) {
    runs.set(run.runId, run);
    while (runs.size > MAX_RUNS) {
      const oldest = [...runs.values()].find((candidate) => candidate.state !== "running");
      if (!oldest) break;
      runs.delete(oldest.runId);
    }
  }

  function publish(run) {
    if (closed) return;
    const bus = getBus();
    if (!bus || typeof bus.publish !== "function") return;
    try {
      if (!bus.publish("notification", importNotification(run))) warn("telemetry-routes: the import notification was not accepted by the event bus");
    } catch (error) {
      warn(`telemetry-routes: the import notification failed: ${error && error.message ? error.message : error}`);
    }
  }

  // Runs the import in the background; the response has already been sent.
  function execute(run, store) {
    const settings = readSettings() || {};
    run.promise = (async () => {
      try {
        const report = await runImport({
          sources: run.sources,
          aiRoot: options.aiRoot,
          store,
          dryRun: run.dryRun,
          managers: options.managers,
          entryRoot: options.entryRoot,
          env: options.env,
          retention: settings.retention,
          timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
          now: clock(),
          onProgress: (progress) => {
            run.progress = progress;
          },
        });
        run.report = report;
        run.state = "done";
      } catch (error) {
        run.state = "failed";
        run.error = { code: String((error && error.code) || "import_failed").slice(0, 80) };
        warn(`telemetry-routes: the import failed (${run.error.code})`);
      }
      run.finishedAt = new Date(clock()).toISOString();
      run.progress = null;
      publish(run);
    })();
  }

  async function postImport(req, res) {
    let body;
    try {
      body = await readJsonObjectBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (Number(error && error.status) === 413) sendError(res, 413, "request_too_large", `The request body may be at most ${MAX_BODY_BYTES} bytes.`);
      else sendError(res, 400, "invalid_json", "The request body must be a JSON object.");
      return;
    }
    const errors = [];
    let sources = [...importers.IMPORT_SOURCES];
    if (body.sources !== undefined) {
      if (!Array.isArray(body.sources) || !body.sources.length) errors.push({ field: "sources", code: "invalid_import_sources" });
      else if (body.sources.some((item) => !importers.IMPORT_SOURCES.includes(item))) errors.push({ field: "sources", code: "unknown_import_source" });
      else sources = importers.IMPORT_SOURCES.filter((id) => body.sources.includes(id));
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") errors.push({ field: "dryRun", code: "invalid_value" });
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The import request is not valid.", { errors });
      return;
    }
    const store = getStore();
    if (!store || (store.state && store.state !== "ready")) {
      sendError(res, 503, "telemetry_unavailable", "Telemetry is not running, so there is nothing to import into.", { hint: "Check that telemetry is enabled and the store opened." });
      return;
    }
    const active = activeRun();
    if (active) {
      sendError(res, 409, "import_in_progress", "An import is already running.", { details: { runId: active.runId } });
      return;
    }
    const run = {
      runId: `run_${crypto.randomBytes(8).toString("hex")}`,
      state: "running",
      dryRun: body.dryRun !== false,
      sources,
      startedAt: new Date(clock()).toISOString(),
      finishedAt: null,
      progress: null,
      report: null,
      error: null,
      promise: null,
    };
    remember(run);
    execute(run, store);
    sendJson(res, { ok: true, runId: run.runId });
  }

  function getRun(res, runId) {
    const run = runs.get(runId);
    if (!run) {
      sendError(res, 404, "import_run_not_found", "No import run has this id.", { hint: "Runs are kept until the entry restarts." });
      return;
    }
    sendJson(res, publicRun(run));
  }

  async function handle(req, res, url) {
    const pathname = String(url && url.pathname ? url.pathname : "");
    const match = RUN_PATH.exec(pathname);
    if (pathname !== IMPORT_PATH && !match) return false;
    const requested = String(req.method || "GET").toUpperCase();
    const method = requested === "HEAD" ? "GET" : requested;
    const allowed = match ? "GET" : "POST";
    if (method !== allowed) {
      sendJson(res, errorBody("method_not_allowed", `${requested} is not supported on ${pathname}.`), 405, { allow: allowed });
      return true;
    }
    const caller = resolveCaller(auth, req);
    if (caller !== "owner") {
      req.resume?.();
      if (caller === "none") sendError(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" });
      else sendError(res, 403, "owner_required", "Only the console owner can import telemetry history.");
      return true;
    }
    if (method === "POST") {
      let allowedWrite;
      try {
        allowedWrite = auth.checkWrite(req) || {};
      } catch {
        allowedWrite = { ok: false, status: 401, code: "admin_session_required" };
      }
      if (!allowedWrite.ok) {
        req.resume?.();
        sendError(res, Number(allowedWrite.status) || 403, String(allowedWrite.code || "management_local_only"), String(allowedWrite.message || "This action needs the console owner."));
        return true;
      }
      await postImport(req, res);
      return true;
    }
    getRun(res, match[1]);
    return true;
  }

  return {
    handle,
    runs: () => [...runs.values()].map(publicRun),
    // The run in flight (tests await it).
    idle: () => Promise.allSettled([...runs.values()].map((run) => run.promise).filter(Boolean)),
    close() {
      closed = true;
    },
  };
}

// Owner-only routes are declared so 05's inventory lists them; a viewer is
// held to the registered routes and gets none of these.
const TELEMETRY_ADMIN_ONLY_ROUTES = Object.freeze([
  Object.freeze({ method: "POST", path: IMPORT_PATH }),
  Object.freeze({ method: "GET", path: `${IMPORT_PATH}/:runId` }),
]);

function registerTelemetryRoutes(registry, warn = () => {}) {
  for (const route of TELEMETRY_ADMIN_ONLY_ROUTES) {
    try {
      registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path });
    } catch (error) {
      warn(`telemetry-routes: ${route.method} ${route.path} was not declared and stays owner-only: ${error && error.message ? error.message : error}`);
    }
  }
}

// --- query routes (TEL-11) --------------------------------------------------------
//
//   GET /api/telemetry/live | summary | timeseries | breakdown | events | energy
//       | lifecycle | launches | baseline | status      owner, or viewer (redacted)
//   GET /api/telemetry/requests, /requests/:requestId, /export   owner only
//   GET|PUT /api/telemetry/settings                              owner only
//
// The query itself runs in the store worker (manager-core/telemetry/query.js);
// this module parses and validates parameters, decides who may ask what, adds
// what only the entry knows (billing, the audit link, collector states) and
// streams exports. Unknown parameters answer 400 unknown_parameter.
//
// A viewer (a LAN device, or a loopback caller without an owner session)
// reaches the §11.8 routes only. The pre-dispatch guard of 05 already held it
// to the registered routes and set req.viewer, so sendJson redacts; this
// module also redacts and pre-checks when it runs without that guard (the
// request-auth seam before PUB-5), which is what "a LAN viewer gets the same
// redacted output" rests on.

const { once } = require("node:events");
const { accessLogCsvCell } = require("../../manager-core/access-log");
const query = require("../../manager-core/telemetry/query");
const viewerRedaction = require("./telemetry-viewer");

const QUERY_ENDPOINT_PATH = /^\/api\/telemetry\/([a-z][a-z-]{1,24})$/;
const DETAIL_PATH = /^\/api\/telemetry\/requests\/([A-Za-z0-9._:-]{1,128})$/;
const VIEWER_QUERIES = Object.freeze({
  summary: "summary",
  timeseries: "timeseries",
  breakdown: "breakdown",
  events: "listEvents",
  energy: "energy",
  lifecycle: "lifecycle",
  launches: "launches",
  baseline: "baseline",
});
const OWNER_QUERIES = Object.freeze({ requests: "listRequests" });
const GET_ENDPOINTS = new Set(["live", "status", "export", "settings", ...Object.keys(VIEWER_QUERIES), ...Object.keys(OWNER_QUERIES)]);
const OWNER_ONLY_ENDPOINTS = new Set(["requests", "export", "settings"]);
const SETTINGS_BODY_BYTES = 64 * 1024;
const STATS_CACHE_MS = 10_000;
const EXPORT_PAGE_ROWS = 1000;
const WEBHOOK_FORMATS = Object.freeze(["generic", "feishu", "dingtalk", "wecom", "slack"]);
const WEBHOOK_SEVERITIES = Object.freeze(["info", "warning", "critical"]);
const WEBHOOK_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WEBHOOK_SECRET_NAMESPACE = "webhooks";
const SETTINGS_FIELDS = Object.freeze(["enabled", "sampleIntervalMs", "timezoneOffsetMinutes", "keepJsonlAccessLog", "maxDbMb", "exportMaxRows", "retention", "energy", "alerts"]);
const ERROR_STATUS = Object.freeze({
  request_not_found: 404,
  query_timeout: 500,
  unknown_query: 500,
});
const STORE_UNAVAILABLE = /^telemetry_store_/;
const QUERY_ERROR_CODES = new Set([
  "unknown_parameter", "duplicate_parameter", "invalid_value", "invalid_range", "range_too_large", "out_of_range",
  "missing_parameter", "unknown_metric", "unknown_dimension", "unknown_sort", "unknown_annotation", "invalid_cursor",
  "group_by_not_allowed", "filter_not_available",
]);

function mapState(value) {
  return viewerRedaction.collectorState(value);
}

function isLoopbackHost(host) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || /^127\./.test(name) || name === "0.0.0.0" || name === "::";
}

// The fallback of assertSafeWebhookUrl (04 §13.3) for builds where notify.js
// (TEL-13) is not there yet: http or https, no userinfo, no loopback, no
// link-local address. Returns a reason, or "" when the URL is acceptable.
function localWebhookCheck(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return "The webhook URL is not a valid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "The webhook URL must use http or https.";
  if (parsed.username || parsed.password) return "The webhook URL must not contain a user name or password.";
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return "The webhook URL must not point at this machine.";
  if (/^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return "The webhook URL must not point at a link-local address.";
  return "";
}

function webhookUrlProblem(raw) {
  try {
    const notify = require("../../manager-core/telemetry/notify");
    if (typeof notify.assertSafeWebhookUrl === "function") {
      try {
        notify.assertSafeWebhookUrl(String(raw));
        return "";
      } catch (error) {
        return String((error && error.message) || "The webhook URL is not allowed.");
      }
    }
  } catch (error) {
    if (!error || error.code !== "MODULE_NOT_FOUND") return "The webhook URL could not be checked.";
  }
  return localWebhookCheck(raw);
}

// https://hooks.example.test/<path> -> https://hooks.example.test/…
function maskWebhookUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "…";
  }
}

function stripEtag(value) {
  return String(value || "").trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

function headerOf(req, name) {
  const value = req && req.headers ? req.headers[name] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

/**
 * createQueryRoutes({ auth, sendJson, readJsonObjectBody, getStore, getRuntime,
 *   getBillingStore, getAudit, config, secrets, aiRoot, env, logger, now })
 * → { handle(req, res, url) → Promise<boolean> }. Everything is read per
 * request, so a store that opens late or restarts needs no re-mount.
 */
function createQueryRoutes(options = {}) {
  const auth = options.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function") {
    throw new TypeError("createQueryRoutes needs the request-auth seam");
  }
  const sendJsonRaw = typeof options.sendJson === "function" ? options.sendJson : (res, data, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(data));
  };
  const readJsonObjectBody = options.readJsonObjectBody;
  const getStore = typeof options.getStore === "function" ? options.getStore : () => null;
  const getRuntime = typeof options.getRuntime === "function" ? options.getRuntime : () => null;
  const getBillingStore = typeof options.getBillingStore === "function" ? options.getBillingStore : () => null;
  const getAudit = typeof options.getAudit === "function" ? options.getAudit : () => null;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const logger = options.logger || console;
  const env = options.env || process.env;
  let vault;
  let statsCache = null;

  function warn(line) {
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  }

  function configApi() {
    if (options.config) return options.config;
    const platform = require("../../manager-core/platform/config");
    return {
      readSection: (name) => platform.readSection(name, { aiRoot: options.aiRoot, env }),
      writeSection: (name, patch, writeOptions) => platform.writeSection(name, patch, { aiRoot: options.aiRoot, env, ...writeOptions }),
    };
  }

  function secretVault() {
    if (options.secrets) return options.secrets;
    if (vault !== undefined) return vault;
    try {
      vault = require("../../manager-core/secret-store").createSecretVault({ aiRoot: options.aiRoot });
    } catch {
      vault = null;
    }
    return vault;
  }

  function settingValues() {
    try {
      const section = configApi().readSection("telemetry");
      return { values: isPlainObject(section && section.values) ? section.values : {}, etag: section && section.etag ? String(section.etag) : "", errors: (section && section.errors) || [] };
    } catch {
      return { values: {}, etag: "", errors: [{ code: "settings_unavailable" }] };
    }
  }

  function queryOptions() {
    const { values } = settingValues();
    const offset = values.timezoneOffsetMinutes;
    return {
      now: clock(),
      tzOffsetMinutes: Number.isInteger(offset) && offset % 60 === 0 && offset >= -720 && offset <= 840 ? offset : undefined,
      energy: isPlainObject(values.energy) ? values.energy : {},
      sampleIntervalMs: values.sampleIntervalMs,
      minuteDays: isPlainObject(values.retention) ? values.retention.minuteDays : undefined,
      exportMaxRows: values.exportMaxRows,
    };
  }

  function sendJson(res, data, status = 200, headers = {}) {
    sendJsonRaw(res, data, status, headers);
  }

  function sendError(res, status, code, message, extra) {
    sendJson(res, errorBody(code, message, extra), status);
  }

  // Maps a thrown error to the §4.2 envelope. Nothing from the error beyond
  // its code, message and field is sent.
  function fail(res, error) {
    const code = String((error && error.code) || "");
    const message = String((error && error.message) || "The request failed.");
    if (QUERY_ERROR_CODES.has(code) || (error && error.name === "QueryError" && Number(error.status) === 400)) {
      sendError(res, 400, code || "invalid_request", message, { hint: error.hint, errors: error.field ? [{ field: error.field, code, message }] : undefined });
      return;
    }
    if (ERROR_STATUS[code]) {
      sendError(res, ERROR_STATUS[code], code, message, { hint: error.hint });
      return;
    }
    if (STORE_UNAVAILABLE.test(code)) {
      sendError(res, 503, "telemetry_unavailable", "Telemetry is not available right now.", { hint: "Check /api/telemetry/status." });
      return;
    }
    warn(`telemetry-routes: a query failed (${code || "error"}): ${message}`);
    sendError(res, 500, "internal_error", "The telemetry query failed.");
  }

  function readyStore() {
    const store = getStore();
    if (!store || (store.state && store.state !== "ready")) return null;
    return store;
  }

  async function call(name, params) {
    const store = readyStore();
    if (!store) {
      const error = new Error("Telemetry is not running.");
      error.code = "telemetry_store_unavailable";
      throw error;
    }
    return store.call(name, params);
  }

  // Who is asking: owner (a human session or token), machine (an owner-like
  // system principal), viewer, or nobody.
  function callerOf(req) {
    let who = {};
    try {
      who = auth.principal(req) || {};
    } catch {
      who = {};
    }
    const principal = String(who.principal || "");
    if (who.role === "owner") return { kind: "owner", machine: false, principal };
    if (who.role === "system" && SYSTEM_OWNER_PRINCIPALS.has(principal)) return { kind: "owner", machine: true, principal };
    if (who.role === "viewer" || who.role === "system") return { kind: "viewer", machine: false, principal };
    return { kind: "none", machine: false, principal };
  }

  // Sends a body. A non-owner gets the endpoint's redaction unless the
  // central one (req.viewer) is going to run in sendJson.
  function respond(req, res, endpoint, caller, body, status = 200, headers = {}) {
    let out = body;
    const central = Boolean(req.viewer && typeof req.viewer.redact === "function");
    if (caller.kind !== "owner" && !central) {
      const entry = viewerRedaction.VIEWER_ENDPOINTS.get(endpoint);
      if (entry) out = entry.redact(out);
    }
    sendJson(res, out, status, headers);
  }

  function collectorStates() {
    const runtime = getRuntime();
    const store = getStore();
    const status = runtime && typeof runtime.status === "function" ? runtime.status() : {};
    const collectors = (runtime && runtime.collectors) || {};
    const recorder = status.recorder;
    const detail = status.collectors || {};
    return {
      recorder: recorder ? (recorder.running ? "ok" : "degraded") : "degraded",
      runtime: detail.runtime ? mapState(detail.runtime) : "degraded",
      gpu: collectors.gpu && typeof collectors.gpu.status === "function" ? mapState(collectors.gpu.status()) : "degraded",
      events: detail.events ? mapState(detail.events) : "degraded",
      store: store && store.state === "ready" ? "ok" : "degraded",
    };
  }

  // --- live ---------------------------------------------------------------------

  async function live(req, res, caller) {
    const runtime = getRuntime();
    const inflight = runtime && runtime.recorder && typeof runtime.recorder.inflight === "function" ? runtime.recorder.inflight() : 0;
    const mem = { now: clock(), inflight, collectors: collectorStates() };
    let body;
    if (readyStore()) {
      body = await call("live", mem);
    } else {
      body = {
        ok: true,
        at: nowIso(clock),
        windowSeconds: 60,
        gateway: { inflight, requestsPerMin: 0, outputTokensPerSec: 0, errorRate5m: null, ttftP95Ms5m: null, clientAborts5m: 0 },
        instances: [],
        gpus: [],
        alerts: { firing: 0, critical: 0 },
        collectors: { ...mem.collectors, store: "degraded" },
      };
    }
    respond(req, res, "live", caller, body);
  }

  // --- generic query endpoints --------------------------------------------------

  async function runQuery(req, res, url, endpoint, caller) {
    const entry = viewerRedaction.VIEWER_ENDPOINTS.get(endpoint);
    if (caller.kind !== "owner" && entry && entry.precheck) {
      const denied = entry.precheck(url.searchParams);
      if (denied) {
        sendError(res, denied.status, denied.code, denied.message, { hint: denied.hint });
        return;
      }
    }
    const q = query.parseQuery(endpoint, url.searchParams, queryOptions());
    const name = VIEWER_QUERIES[endpoint] || OWNER_QUERIES[endpoint];
    const body = await call(name, q);
    if (endpoint === "summary" && caller.kind === "owner") addBilled(body, q);
    respond(req, res, endpoint, caller, body);
  }

  // billedMicrocredits is owner-only (04 §11.2): the billing store's own
  // summary over the same window, as a decimal string.
  function addBilled(body, q) {
    const billing = getBillingStore();
    if (!billing || typeof billing.summarizeUsage !== "function") return;
    const span = q.to - q.from;
    const windows = [["current", q.from, q.to]];
    if (body.previous) windows.push(["previous", q.from - span, q.from]);
    for (const [name, from, to] of windows) {
      let billed = null;
      try {
        const result = billing.summarizeUsage({ kind: "llm", groupBy: [], from: new Date(from).toISOString(), to: new Date(to).toISOString(), tzOffsetMinutes: q.tzOffsetMinutes });
        billed = result && result.totals ? String(result.totals.chargedMicrocredits ?? "0") : null;
      } catch (error) {
        warn(`telemetry-routes: the billing summary was skipped (${(error && error.code) || "error"})`);
      }
      body[name].billedMicrocredits = billed;
    }
  }

  // --- request detail ------------------------------------------------------------

  async function requestDetail(req, res, url, requestId) {
    for (const key of url.searchParams.keys()) {
      sendError(res, 400, "unknown_parameter", `Unknown parameter: ${String(key).slice(0, 60)}.`);
      return;
    }
    const body = await call("getRequest", { requestId });
    const request = body.request;
    body.billing = billingFor(request);
    body.audit = await auditFor(req, request);
    sendJson(res, body);
  }

  function billingFor(request) {
    const billing = getBillingStore();
    if (!billing || typeof billing.getUsageByExternalRequestId !== "function") return null;
    const ids = [request.requestId, request.managerRequestId].filter(Boolean);
    let found = null;
    try {
      found = billing.getUsageByExternalRequestId(ids);
    } catch (error) {
      warn(`telemetry-routes: the billing join was skipped (${(error && error.code) || "error"})`);
      return null;
    }
    if (!found) return null;
    const usage = found.usage || {};
    return {
      usage: {
        usageId: usage.usageId,
        chargedMicrocredits: usage.chargedMicrocredits,
        projectedMicrocredits: usage.projectedMicrocredits,
        usageSource: usage.usageSource,
        terminalState: usage.terminalState,
        decisionCode: usage.decisionCode,
      },
      reservation: found.reservation || null,
    };
  }

  function messageTimeMs(value) {
    if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  // The link to the OpenWebUI audit (04 §11.6): resolved only with a valid
  // audit session, and every lookup of candidates is logged.
  async function auditFor(req, request) {
    const linkable = request.sourceProgram === "openwebui" || Boolean(request.owuiChatId);
    const locked = { unlocked: false, linkable, chatId: null, candidates: [] };
    const audit = getAudit();
    if (!audit || typeof audit.checkSession !== "function") return locked;
    let session = null;
    try {
      session = audit.checkSession(req);
    } catch {
      session = null;
    }
    if (!session) return locked;
    const out = { unlocked: true, linkable, chatId: request.owuiChatId || null, candidates: [] };
    let outcome = "ok";
    try {
      const index = audit.index || null;
      if (index && request.modelResolved) {
        const received = Date.parse(request.receivedAt);
        const hits = await index.searchChats({ model: request.modelResolved, from: new Date(received - 120_000).toISOString(), limit: 25 });
        for (const hit of (hits && hits.rows) || []) {
          const found = await index.getChat(hit.chatId, { auditId: hit.auditId });
          if (!found) continue;
          const message = (found.messages || []).find((item) => item.role === "user" && messageTimeMs(item.timestamp) !== null && Math.abs(messageTimeMs(item.timestamp) - received) <= 120_000);
          if (message) {
            out.candidates.push({ chatId: hit.chatId, title: hit.title || "", auditId: hit.auditId, messageId: message.id, offsetSeconds: Math.round((messageTimeMs(message.timestamp) - received) / 1000) });
          }
        }
      }
    } catch (error) {
      outcome = "error";
      warn(`telemetry-routes: the audit link lookup failed (${(error && error.code) || "error"})`);
    }
    try {
      if (typeof audit.logAccess === "function") await audit.logAccess(req, { action: "link_lookup", target: request.requestId, outcome, detail: { candidates: out.candidates.length } });
    } catch {
      // The lookup answer does not depend on the log line.
    }
    return out;
  }

  // --- export --------------------------------------------------------------------

  function exportName(q) {
    const stamp = new Date(clock()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    return `telemetry-${q.kind}-${stamp}.${q.format === "jsonl" ? "jsonl" : "csv"}`;
  }

  async function exportRoute(req, res, url) {
    const q = query.parseQuery("export", url.searchParams, queryOptions());
    const counted = await call("exportCount", q);
    const cap = Math.max(1, Number(q.maxRows) || 200_000);
    const truncated = counted.total > cap;
    const csv = q.format !== "jsonl";
    res.writeHead(200, {
      "content-type": csv ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="${exportName(q)}"`,
      "x-telemetry-total": String(counted.total),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    let written = 0;
    let after = null;
    let columns = null;
    try {
      while (written < cap && !closed) {
        const page = await call("exportPage", { ...q, after, pageRows: Math.min(EXPORT_PAGE_ROWS, cap - written) });
        let chunk = "";
        if (csv && columns === null) chunk = `﻿${page.columns.map(accessLogCsvCell).join(",")}\r\n`;
        columns = page.columns;
        for (const row of page.rows) {
          if (csv) chunk += `${row.map(accessLogCsvCell).join(",")}\r\n`;
          else chunk += `${JSON.stringify(Object.fromEntries(columns.map((name, index) => [name, row[index]])))}\n`;
        }
        if (chunk && !closed && !res.write(chunk)) await once(res, "drain");
        written += page.rows.length;
        after = page.next;
        if (!after) break;
      }
      if (!closed) {
        if (!csv && truncated) res.write('{"_truncated":true}\n');
        res.end();
      }
    } catch (error) {
      // The status line is gone; cut the stream so the client sees a failure.
      warn(`telemetry-routes: an export stopped (${(error && error.code) || "error"})`);
      res.destroy();
    }
  }

  // --- status --------------------------------------------------------------------

  async function statusBody() {
    const runtime = getRuntime();
    const store = getStore();
    const states = collectorStates();
    const runtimeStatus = runtime && typeof runtime.status === "function" ? runtime.status() : {};
    const detail = runtimeStatus.collectors || {};
    const recorderStats = runtimeStatus.recorder || (runtime && runtime.recorder && runtime.recorder.stats ? runtime.recorder.stats() : null);
    const collectors = {
      recorder: { state: states.recorder, lastOkAt: recorderStats && recorderStats.lastFlushAt ? new Date(recorderStats.lastFlushAt).toISOString() : null, lastError: recorderStats ? recorderStats.lastError || null : null, intervalMs: null },
      runtime: { state: states.runtime, lastOkAt: detail.runtime && detail.runtime.lastTickAt ? new Date(detail.runtime.lastTickAt).toISOString() : null, lastError: detail.runtime ? detail.runtime.lastError || null : null, intervalMs: detail.runtime ? detail.runtime.intervalMs || null : null },
      gpu: { state: states.gpu, lastOkAt: null, lastError: null, intervalMs: null },
      events: { state: states.events, lastOkAt: null, lastError: detail.events ? detail.events.lastError || null : null, intervalMs: null },
      store: { state: states.store, lastOkAt: null, lastError: runtimeStatus.lastError || null, intervalMs: null },
    };
    const gpuCollector = runtime && runtime.collectors && runtime.collectors.gpu;
    if (gpuCollector && typeof gpuCollector.status === "function") {
      const gpu = gpuCollector.status();
      collectors.gpu = { state: states.gpu, lastOkAt: gpu.lastOkAt ? new Date(gpu.lastOkAt).toISOString() : null, lastError: gpu.lastError ? String(gpu.lastError.code || gpu.lastError.message || "error") : null, intervalMs: gpu.intervalMs || null };
    }
    const degraded = Object.entries(states).filter(([, state]) => state !== "ok").map(([name]) => `${name}_degraded`);
    const body = {
      ok: true,
      schemaVersion: null,
      dbBytes: null,
      walBytes: null,
      rows: {},
      collectors,
      recorder: { inflight: recorderStats ? recorderStats.inflight || 0 : 0, buffered: recorderStats ? recorderStats.buffered || 0 : 0, dropped: recorderStats ? recorderStats.dropped || 0 : 0 },
      rollup: { watermark1m: null, dirty: 0 },
      retention: { lastRunAt: null, deleted: null },
      imports: [],
      degraded,
    };
    if (!readyStore()) {
      body.degraded.push("store_unavailable");
      return body;
    }
    const at = clock();
    if (!statsCache || at - statsCache.at > STATS_CACHE_MS) {
      statsCache = { at, stats: await store.stats({ rows: true }) };
    }
    const stats = statsCache.stats || {};
    body.schemaVersion = stats.schemaVersion ?? null;
    body.dbBytes = stats.dbBytes ?? null;
    body.walBytes = stats.walBytes ?? null;
    body.rows = stats.rows || {};
    if (Array.isArray(stats.pragmaMismatches) && stats.pragmaMismatches.length) body.degraded.push("pragma_mismatch");
    const rollup = await call("rollupStatus", {});
    body.rollup = { watermark1m: rollup.watermark1m, dirty: rollup.dirty };
    const retention = (await store.getState("retention")) || {};
    body.retention = { lastRunAt: retention.lastRunAt ? new Date(retention.lastRunAt).toISOString() : null, deleted: retention.deleted ?? null };
    body.imports = (await call("importRuns", {})).runs;
    return body;
  }

  // --- settings ------------------------------------------------------------------

  async function webhookViews(webhooks) {
    const secrets = secretVault();
    const out = [];
    for (const hook of Array.isArray(webhooks) ? webhooks : []) {
      if (!isPlainObject(hook) || !hook.id) continue;
      let set = false;
      try {
        set = Boolean(secrets && (await secrets.has(WEBHOOK_SECRET_NAMESPACE, hook.id)));
      } catch {
        set = false;
      }
      out.push({ id: hook.id, format: hook.format, url: maskWebhookUrl(hook.url), minSeverity: hook.minSeverity, secret: { set } });
    }
    return out;
  }

  async function getSettings(res) {
    const { values, etag, errors } = settingValues();
    if (errors.some((error) => error && error.code === "unknown_section")) {
      sendError(res, 503, "settings_unavailable", "The telemetry settings are not available in this build.");
      return;
    }
    const alerts = isPlainObject(values.alerts) ? values.alerts : {};
    const body = {
      ok: true,
      etag,
      enabled: values.enabled,
      energy: values.energy,
      retention: values.retention,
      sampleIntervalMs: values.sampleIntervalMs,
      timezoneOffsetMinutes: values.timezoneOffsetMinutes,
      keepJsonlAccessLog: values.keepJsonlAccessLog,
      maxDbMb: values.maxDbMb,
      exportMaxRows: values.exportMaxRows,
      alerts: { webhooks: await webhookViews(alerts.webhooks) },
    };
    sendJson(res, body, 200, { etag: `"${etag}"` });
  }

  // Validates the webhook list of a patch and splits the write-only secrets
  // off. `existing` lets a client send back the masked URL it read.
  function prepareWebhooks(list, existing) {
    const errors = [];
    const hooks = [];
    const secrets = new Map();
    if (!Array.isArray(list)) return { errors: [{ field: "alerts.webhooks", code: "invalid_type" }], hooks, secrets };
    if (list.length > 20) errors.push({ field: "alerts.webhooks", code: "out_of_range" });
    const seen = new Set();
    list.forEach((item, index) => {
      const field = `alerts.webhooks[${index}]`;
      if (!isPlainObject(item)) {
        errors.push({ field, code: "invalid_type" });
        return;
      }
      for (const key of Object.keys(item)) {
        if (!["id", "url", "format", "minSeverity", "secret"].includes(key)) errors.push({ field: `${field}.${key}`, code: "unknown_key" });
      }
      const id = typeof item.id === "string" ? item.id : "";
      if (!WEBHOOK_ID.test(id)) errors.push({ field: `${field}.id`, code: "invalid_format" });
      else if (seen.has(id)) errors.push({ field: `${field}.id`, code: "duplicate" });
      seen.add(id);
      const format = item.format === undefined ? "generic" : item.format;
      if (!WEBHOOK_FORMATS.includes(format)) errors.push({ field: `${field}.format`, code: "invalid_value" });
      const minSeverity = item.minSeverity === undefined ? "warning" : item.minSeverity;
      if (!WEBHOOK_SEVERITIES.includes(minSeverity)) errors.push({ field: `${field}.minSeverity`, code: "invalid_value" });
      let url = typeof item.url === "string" ? item.url.trim() : "";
      const previous = existing.get(id);
      if (previous && url === maskWebhookUrl(previous.url)) url = previous.url;
      if (!url || url.length > 2048) errors.push({ field: `${field}.url`, code: "invalid_format" });
      else if (webhookUrlProblem(url)) errors.push({ field: `${field}.url`, code: "unsafe_url", message: webhookUrlProblem(url) });
      if (item.secret !== undefined && item.secret !== null && (typeof item.secret !== "string" || item.secret.length > 512)) {
        errors.push({ field: `${field}.secret`, code: "invalid_value" });
      } else if (item.secret !== undefined && id) {
        secrets.set(id, typeof item.secret === "string" && item.secret ? item.secret : null);
      }
      hooks.push({ id, url, format, minSeverity });
    });
    return { errors, hooks, secrets };
  }

  async function putSettings(req, res) {
    const allowedWrite = (() => {
      try {
        return auth.checkWrite(req) || {};
      } catch {
        return { ok: false, status: 401, code: "admin_session_required" };
      }
    })();
    if (!allowedWrite.ok) {
      req.resume?.();
      sendError(res, Number(allowedWrite.status) || 403, String(allowedWrite.code || "management_local_only"), String(allowedWrite.message || "This action needs the console owner."));
      return;
    }
    const ifMatch = stripEtag(headerOf(req, "if-match"));
    if (!ifMatch) {
      req.resume?.();
      sendError(res, 428, "etag_required", "Send the etag you read in If-Match.", { hint: "GET /api/telemetry/settings first." });
      return;
    }
    let body;
    try {
      body = await readJsonObjectBody(req, SETTINGS_BODY_BYTES);
    } catch (error) {
      if (Number(error && error.status) === 413) sendError(res, 413, "request_too_large", `The request body may be at most ${SETTINGS_BODY_BYTES} bytes.`);
      else sendError(res, 400, "invalid_json", "The request body must be a JSON object.");
      return;
    }
    const errors = [];
    for (const key of Object.keys(body)) if (!SETTINGS_FIELDS.includes(key)) errors.push({ field: key, code: "unknown_key" });
    const patch = {};
    for (const key of SETTINGS_FIELDS) if (key !== "alerts" && body[key] !== undefined) patch[key] = body[key];
    const current = settingValues().values;
    const existing = new Map((isPlainObject(current.alerts) && Array.isArray(current.alerts.webhooks) ? current.alerts.webhooks : []).filter((hook) => isPlainObject(hook) && hook.id).map((hook) => [hook.id, hook]));
    let secrets = new Map();
    let removed = [];
    if (body.alerts !== undefined) {
      if (!isPlainObject(body.alerts) || Object.keys(body.alerts).some((key) => key !== "webhooks")) {
        errors.push({ field: "alerts", code: "invalid_type" });
      } else if (body.alerts.webhooks !== undefined) {
        const prepared = prepareWebhooks(body.alerts.webhooks, existing);
        errors.push(...prepared.errors);
        secrets = prepared.secrets;
        patch.alerts = { webhooks: prepared.hooks };
        removed = [...existing.keys()].filter((id) => !prepared.hooks.some((hook) => hook.id === id));
      }
    }
    if (errors.length) {
      sendError(res, 400, "invalid_request", "The settings were not saved because some values are not valid.", { errors: errors.map((error) => ({ ...error, message: error.message || `${error.field}: ${error.code}` })) });
      return;
    }
    let result;
    try {
      result = await configApi().writeSection("telemetry", patch, { etag: ifMatch, actor: "owner" });
    } catch (error) {
      warn(`telemetry-routes: saving the settings failed (${(error && error.code) || "error"})`);
      sendError(res, 500, "settings_write_failed", "The settings could not be saved.");
      return;
    }
    if (!result || result.ok !== true) {
      const code = result && result.code === "config_conflict" ? "etag_mismatch" : String((result && result.code) || "config_invalid");
      const status = result && result.code === "config_conflict" ? 409 : Number(result && result.status) || 400;
      sendJson(res, {
        ok: false,
        error: { code, message: String((result && result.error && result.error.message) || "The settings were not saved."), ...(code === "etag_mismatch" ? { hint: "Reload the settings and try again." } : {}) },
        ...(result && Array.isArray(result.errors) && result.errors.length ? { errors: result.errors } : {}),
        ...(result && result.etag ? { etag: result.etag } : {}),
      }, status);
      return;
    }
    // The values reach platform.json first; the signing secrets go to the
    // secret store only, and are never echoed or logged.
    const warnings = [];
    const secretStore = secretVault();
    for (const [id, value] of secrets) {
      try {
        if (!secretStore) throw Object.assign(new Error("no secret store"), { code: "secret_store_unavailable" });
        if (value === null) await secretStore.clear(WEBHOOK_SECRET_NAMESPACE, id);
        else await secretStore.set(WEBHOOK_SECRET_NAMESPACE, id, value);
      } catch (error) {
        warnings.push({ code: "secret_store_unavailable", id });
        warn(`telemetry-routes: the signing secret of webhook ${id} was not stored (${(error && error.code) || "error"})`);
      }
    }
    for (const id of removed) {
      try {
        if (secretStore) await secretStore.clear(WEBHOOK_SECRET_NAMESPACE, id);
      } catch {
        // A leftover secret of a deleted webhook is harmless and is cleared on the next delete.
      }
    }
    const runtime = getRuntime();
    if (runtime && typeof runtime.recordConfigChange === "function") runtime.recordConfigChange("telemetry", { changed: result.changed || [] }, { actor: "owner" });
    sendJson(res, { ok: true, etag: result.etag, changed: result.changed || [], restartRequired: result.restartRequired || [], ...(warnings.length ? { warnings } : {}) }, 200, { etag: `"${result.etag}"` });
  }

  // --- dispatch ------------------------------------------------------------------

  async function handle(req, res, url) {
    const pathname = String(url && url.pathname ? url.pathname : "");
    const detail = DETAIL_PATH.exec(pathname);
    const named = detail ? null : QUERY_ENDPOINT_PATH.exec(pathname);
    const endpoint = detail ? "request-detail" : named ? named[1] : "";
    if (!endpoint || (!detail && !GET_ENDPOINTS.has(endpoint))) return false;
    const requested = String(req.method || "GET").toUpperCase();
    const method = requested === "HEAD" ? "GET" : requested;
    const allowed = endpoint === "settings" ? ["GET", "PUT"] : ["GET"];
    if (!allowed.includes(method)) {
      req.resume?.();
      sendJson(res, errorBody("method_not_allowed", `${requested} is not supported on ${pathname}.`), 405, { allow: allowed.join(", ") });
      return true;
    }
    const caller = callerOf(req);
    const ownerOnly = detail || OWNER_ONLY_ENDPOINTS.has(endpoint);
    // Request rows hold addresses and audit links: not for machine principals either.
    const needsHuman = detail || endpoint === "requests";
    if (caller.kind === "none" || (ownerOnly && (caller.kind !== "owner" || (needsHuman && caller.machine)))) {
      req.resume?.();
      sendError(res, 401, "admin_session_required", "This needs the console owner. Open the console on this machine.", { hint: "pair" });
      return true;
    }
    try {
      if (detail) await requestDetail(req, res, url, detail[1]);
      else if (endpoint === "live") await live(req, res, caller);
      else if (endpoint === "status") respond(req, res, "status", caller, await statusBody());
      else if (endpoint === "export") await exportRoute(req, res, url);
      else if (endpoint === "settings") {
        if (method === "PUT") await putSettings(req, res);
        else await getSettings(res);
      } else await runQuery(req, res, url, endpoint, caller);
    } catch (error) {
      if (res.headersSent) {
        warn(`telemetry-routes: ${endpoint} failed after the headers were sent (${(error && error.code) || "error"})`);
        res.destroy();
      } else fail(res, error);
    }
    return true;
  }

  return { handle };
}

// Owner-only routes are declared so 05's inventory lists them; the viewer
// routes of §11.8 are registered next to them (telemetry-viewer.js).
function registerAllTelemetryRoutes(registry, warn) {
  registerTelemetryRoutes(registry, warn);
  viewerRedaction.registerTelemetryViewerRoutes(registry, warn);
}

// Route module (07 §2.7). server.js puts the telemetry runtime on
// ctx.telemetry after the mount, so the store is read per request.
function mount(ctx) {
  const auth = ctx && ctx.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("telemetry-routes: ctx.auth is missing");
  }
  const logger = ctx.logger || console;
  const warn = (line) => {
    try {
      (typeof logger.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the mount.
    }
  };
  registerAllTelemetryRoutes(auth.viewerRegistry, warn);
  const getStore = () => (ctx.telemetry && ctx.telemetry.store) || null;
  const imports = createImportRoutes({
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    getStore,
    getBus: () => ctx.bus || null,
    aiRoot: ctx.aiRoot,
    managers: Array.isArray(ctx.managers) ? ctx.managers.map((manager) => ({ id: manager.id })) : undefined,
    entryRoot: ctx.rootDir,
    logger,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
  const queries = createQueryRoutes({
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    getStore,
    getRuntime: () => ctx.telemetry || null,
    getBillingStore: () => (typeof ctx.getBillingStore === "function" ? ctx.getBillingStore() : ctx.billingStore || null),
    getAudit: () => ctx.audit || null,
    config: ctx.telemetryConfig,
    secrets: ctx.secretStore,
    aiRoot: ctx.aiRoot,
    logger,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
  return {
    async handle(req, res, url) {
      if (await imports.handle(req, res, url)) return true;
      return queries.handle(req, res, url);
    },
    close() {
      imports.close();
    },
  };
}

module.exports = {
  IMPORT_PATH,
  MAX_BODY_BYTES,
  TELEMETRY_ADMIN_ONLY_ROUTES,
  createImportRoutes,
  createQueryRoutes,
  importNotification,
  localWebhookCheck,
  maskWebhookUrl,
  mount,
  name: "telemetry",
  registerTelemetryRoutes,
  resolveCaller,
};
