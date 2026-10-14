"use strict";

// Telemetry routes (04 §11), mounted for /api/telemetry/ by one line in the
// entry's route-mount table. TEL-18 serves the import endpoints; the query
// and settings endpoints of TEL-11 and the later packages add their rows
// here. A path this module does not serve falls through to the entry's 404.
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
  registerTelemetryRoutes(auth.viewerRegistry, warn);
  const routes = createImportRoutes({
    auth,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    getStore: () => (ctx.telemetry && ctx.telemetry.store) || null,
    getBus: () => ctx.bus || null,
    aiRoot: ctx.aiRoot,
    managers: Array.isArray(ctx.managers) ? ctx.managers.map((manager) => ({ id: manager.id })) : undefined,
    entryRoot: ctx.rootDir,
    logger,
    now: typeof ctx.now === "function" ? ctx.now : Date.now,
  });
  return {
    handle: routes.handle,
    close() {
      routes.close();
    },
  };
}

module.exports = {
  IMPORT_PATH,
  MAX_BODY_BYTES,
  TELEMETRY_ADMIN_ONLY_ROUTES,
  createImportRoutes,
  importNotification,
  mount,
  name: "telemetry",
  registerTelemetryRoutes,
  resolveCaller,
};
