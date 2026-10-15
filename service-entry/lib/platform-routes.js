"use strict";

// Platform routes at the entry (06 §10, OPS-13), mounted for /api/platform/*
// by one line in the entry's route-mount table.
//
//   GET    /api/platform/status                    PlatformStatus; probe-only without the supervisor, cached 2 s
//   GET    /api/platform/components[/:id]          live rows / {component, spec}
//   POST   /api/platform/components/:id/start|stop|restart
//   POST   /api/platform/supervisor/start          owner on loopback only
//   GET    /api/platform/components/:id/logs[/follow]
//   GET    /api/platform/doctor, POST /api/platform/doctor/fix
//   GET    /api/platform/operations/:opId
//   GET|PUT /api/platform/config, POST /api/platform/config/apply
//   GET    /api/platform/{version,deploys,schedules,pending-restarts,busy,setup}
//   DELETE /api/platform/pending-restarts/:id, POST /api/platform/restore-models, POST /api/platform/setup/:step
//
// The entry reaches the supervisor only through createControlClient (pipe and
// bearer token); no header of the caller is ever forwarded, and the client
// adds one x-request-id. Reads of platform.json go through manager-core's
// config module and the only writer is writePlatformConfig. Viewers reach
// exactly the three GET rows registered below, each with a redaction that
// picks fields instead of deleting them; every other row is declared
// owner-only. The bridge subscribes once to the supervisor's /v1/events and
// hands the envelopes to the bus with publish() and nothing else: this module
// never creates or extends events.js.
//
// Exports besides the route module: delegateManager and delegateStopAll (the
// existing /api/managers/:id/start|stop and /api/stop-all handlers call them,
// 06 §10.3) and the viewer redactions.

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const core = require("../../manager-core");
const { redactSecrets } = require("../../manager-core/secret-redactor");
const { newRequestId } = require("./public-errors");

const OWNER = "06";
const PREFIX = "/api/platform/";
const MAX_BODY_BYTES = 64 * 1024;
const STATUS_CACHE_MS = 2000;
const SUMMARY_STALE_MS = 5000;
const DOCTOR_CACHE_MS = 30000;
const REGISTRY_CACHE_MS = 5000;
const VERSION_CACHE_MS = 60000;
const NEWER_COMMITS_CACHE_MS = 5 * 60000;
const OPERATION_POLL_MS = 400;
const START_WAIT_MS = 60000;
const STOP_WAIT_MS = 30000;
const BRIDGE_MIN_RETRY_MS = 1000;
const BRIDGE_MAX_RETRY_MS = 30000;
const COMPONENT_ID = /^[a-z][a-z0-9-]{1,40}$/;
const OPERATION_ID = /^op_[a-z0-9]{1,40}$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,40}$/;
const LOG_STREAMS = new Set(["out", "err", "all"]);
const DOCTOR_GROUPS = new Set(["env", "runtime", "storage", "network", "security", "ops"]);
const MANAGER_COMPONENTS = Object.freeze({ "vllm-manager": "vllm", "llama-manager": "llama" });
const HELP_START_SUPERVISOR = "Start the platform supervisor (`platform start`, or Start supervisor on the System page).";

// --- small helpers -----------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(source, names) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const name of names) {
    if (source[name] !== undefined) out[name] = source[name];
  }
  return out;
}

function componentsApi() {
  return require("../../manager-core/platform/components");
}

function configApi() {
  return require("../../manager-core/platform/config");
}

// The id the registry uses for an id the console or an old caller may send
// (vllm -> vllm-manager).
function registryIdFor(id) {
  const text = String(id || "");
  const legacy = componentsApi().LEGACY_IDS || {};
  return Object.hasOwn(legacy, text) ? legacy[text] : text;
}

function platformError(status, code, message, extra = {}) {
  return Object.assign(new Error(message || code), { platformStatus: status, platformCode: code, extra });
}

function supervisorUnavailable(cause) {
  return Object.assign(platformError(503, "supervisor_unavailable", "The platform supervisor is not running.", {
    hint: HELP_START_SUPERVISOR,
    action: { id: "start-supervisor" },
  }), { code: "supervisor_unavailable", cause: cause?.code || null });
}

// --- viewer redactions (06 §10.1) ----------------------------------------------------

function redactLayerForViewer(layer) {
  return pick(layer, ["id", "status", "code", "mode"]);
}

function redactLabel(label) {
  if (!isPlainObject(label)) return undefined;
  const out = {};
  for (const [name, value] of Object.entries(label)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

// A component row as a viewer sees it: id, label, state, desired, profile,
// uptime and the restart count. No pid, bind address, owner, last exit,
// message, pending restart or health detail.
function redactComponentForViewer(row) {
  if (!isPlainObject(row)) return null;
  const out = pick(row, ["id", "legacyId", "kind", "profile", "desired", "state", "uptimeSec"]);
  const label = redactLabel(row.label);
  if (label) out.label = label;
  out.restarts = { count: Number(row.restarts?.count) || 0 };
  if (Array.isArray(row.ports)) out.ports = row.ports.filter(isPlainObject).map((port) => pick(port, ["name", "port"]));
  return out;
}

function redactStatusForViewer(status) {
  if (!isPlainObject(status)) return null;
  const readiness = isPlainObject(status.readiness)
    ? {
      overall: status.readiness.overall,
      layers: (Array.isArray(status.readiness.layers) ? status.readiness.layers : []).filter(isPlainObject).map(redactLayerForViewer),
    }
    : null;
  const nightly = isPlainObject(status.ops?.nightly) ? pick(status.ops.nightly, ["ok", "streak", "since"]) : null;
  const backup = isPlainObject(status.ops?.backup) ? pick(status.ops.backup, ["ageHours", "ok"]) : null;
  return {
    ...pick(status, ["schemaVersion", "at", "mode"]),
    build: isPlainObject(status.build) ? pick(status.build, ["commit", "contentHash"]) : null,
    supervisor: isPlainObject(status.supervisor) ? pick(status.supervisor, ["running", "startedAt", "profile", "endpoint"]) : null,
    readiness,
    components: (Array.isArray(status.components) ? status.components : []).map(redactComponentForViewer).filter(Boolean),
    models: { serving: Number(status.models?.serving) || 0 },
    ops: { nightly, backup },
  };
}

function redactComponentsForViewer(body) {
  const list = Array.isArray(body?.components) ? body.components : [];
  return { components: list.map(redactComponentForViewer).filter(Boolean) };
}

function redactVersionForViewer(body) {
  const input = isPlainObject(body) ? body : {};
  return {
    build: isPlainObject(input.build) ? pick(input.build, ["commit", "contentHash"]) : null,
    version: typeof input.version === "string" ? input.version : null,
    node: typeof input.node === "string" ? input.node : null,
  };
}

// The `platform` SSE type for viewers: status through the status redaction,
// component keeps {id, state, prev}, operations are dropped.
function redactPlatformEventForViewer(data) {
  if (!isPlainObject(data)) return null;
  if (data.kind === "status") {
    const status = redactStatusForViewer(data.status);
    return status ? { kind: "status", full: data.full === true, status } : null;
  }
  if (data.kind === "component") {
    return { kind: "component", ...pick(data, ["id", "state", "prev"]) };
  }
  return null;
}

// The `platform` field of /api/status for a viewer (server.js).
function redactPlatformSummaryForViewer(summary) {
  if (!isPlainObject(summary)) return summary === undefined ? undefined : null;
  return {
    supervisor: { running: summary.supervisor?.running === true },
    readiness: isPlainObject(summary.readiness)
      ? {
        overall: summary.readiness.overall,
        layers: (Array.isArray(summary.readiness.layers) ? summary.readiness.layers : []).filter(isPlainObject).map(redactLayerForViewer),
      }
      : null,
  };
}

// --- the route table -----------------------------------------------------------------

const P = PREFIX.slice(0, -1);
// access: "viewer" rows are registered for viewers with a redaction; every
// other row is owner-only (the registry's deny-by-default made explicit).
const ROUTES = Object.freeze([
  { method: "GET", path: `${P}/status`, pattern: /^\/api\/platform\/status$/, access: "viewer", redact: redactStatusForViewer, run: "status" },
  { method: "GET", path: `${P}/components`, pattern: /^\/api\/platform\/components$/, access: "viewer", redact: redactComponentsForViewer, run: "components" },
  { method: "GET", path: `${P}/version`, pattern: /^\/api\/platform\/version$/, access: "viewer", redact: redactVersionForViewer, run: "version" },
  { method: "GET", path: `${P}/components/:id`, pattern: /^\/api\/platform\/components\/([^/]+)$/, access: "admin", run: "component" },
  { method: "POST", path: `${P}/components/:id/start`, pattern: /^\/api\/platform\/components\/([^/]+)\/start$/, access: "admin", run: "componentStart" },
  { method: "POST", path: `${P}/components/:id/stop`, pattern: /^\/api\/platform\/components\/([^/]+)\/stop$/, access: "admin", run: "componentStop" },
  { method: "POST", path: `${P}/components/:id/restart`, pattern: /^\/api\/platform\/components\/([^/]+)\/restart$/, access: "admin", run: "componentRestart" },
  { method: "GET", path: `${P}/components/:id/logs`, pattern: /^\/api\/platform\/components\/([^/]+)\/logs$/, access: "admin", run: "logs" },
  { method: "GET", path: `${P}/components/:id/logs/follow`, pattern: /^\/api\/platform\/components\/([^/]+)\/logs\/follow$/, access: "admin", run: "logsFollow" },
  { method: "POST", path: `${P}/supervisor/start`, pattern: /^\/api\/platform\/supervisor\/start$/, access: "admin", run: "supervisorStart" },
  { method: "GET", path: `${P}/doctor`, pattern: /^\/api\/platform\/doctor$/, access: "admin", run: "doctor" },
  { method: "POST", path: `${P}/doctor/fix`, pattern: /^\/api\/platform\/doctor\/fix$/, access: "admin", run: "doctorFix" },
  { method: "GET", path: `${P}/operations/:opId`, pattern: /^\/api\/platform\/operations\/([^/]+)$/, access: "admin", run: "operation" },
  { method: "GET", path: `${P}/config`, pattern: /^\/api\/platform\/config$/, access: "admin", run: "configGet" },
  { method: "PUT", path: `${P}/config`, pattern: /^\/api\/platform\/config$/, access: "admin", run: "configPut" },
  { method: "POST", path: `${P}/config/apply`, pattern: /^\/api\/platform\/config\/apply$/, access: "admin", run: "configApply" },
  { method: "GET", path: `${P}/deploys`, pattern: /^\/api\/platform\/deploys$/, access: "admin", run: "deploys" },
  { method: "GET", path: `${P}/schedules`, pattern: /^\/api\/platform\/schedules$/, access: "admin", run: "schedules" },
  { method: "GET", path: `${P}/pending-restarts`, pattern: /^\/api\/platform\/pending-restarts$/, access: "admin", run: "pendingList" },
  { method: "DELETE", path: `${P}/pending-restarts/:id`, pattern: /^\/api\/platform\/pending-restarts\/([^/]+)$/, access: "admin", run: "pendingCancel" },
  { method: "POST", path: `${P}/restore-models`, pattern: /^\/api\/platform\/restore-models$/, access: "admin", run: "restoreModels" },
  { method: "GET", path: `${P}/setup`, pattern: /^\/api\/platform\/setup$/, access: "admin", run: "setupGet" },
  { method: "POST", path: `${P}/setup/:step`, pattern: /^\/api\/platform\/setup\/([^/]+)$/, access: "admin", run: "setupStep" },
  // system:supervisor or the owner (06 §5.11); never a viewer.
  { method: "GET", path: `${P}/busy`, pattern: /^\/api\/platform\/busy$/, access: "admin", run: "busy" },
]);

/**
 * Registers the viewer rows, the owner-only rows and the `platform` event type
 * in 05's registry (00 §9.8). A row that cannot be registered stays
 * owner-only (deny by default) and is logged.
 */
function registerPlatformRoutes(registry, warn = () => {}) {
  const attempts = [];
  for (const route of ROUTES) {
    if (route.access === "viewer") {
      attempts.push(() => registry.registerRoute({ owner: OWNER, method: route.method, path: route.path, redact: route.redact }));
    } else {
      attempts.push(() => registry.registerAdminOnly({ owner: OWNER, method: route.method, path: route.path }));
    }
  }
  attempts.push(() => registry.registerEventType({ owner: OWNER, type: "platform", redact: redactPlatformEventForViewer }));
  for (const attempt of attempts) {
    try {
      attempt();
    } catch (error) {
      warn(`platform-routes: a viewer registry entry was not registered and stays owner-only: ${error?.message || error}`);
    }
  }
}

// --- delegation (06 §10.3) -------------------------------------------------------------

function errorFromBody(json, fallbackCode, fallbackMessage) {
  const error = isPlainObject(json?.error) ? json.error : null;
  return { code: String(error?.code || fallbackCode), message: String(error?.message || fallbackMessage) };
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitForOperation(control, opId, { timeoutMs, pollMs, sleep, now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let result;
    try {
      result = await control.request("GET", `/v1/operations/${opId}`, { timeoutMs: 5000, requestId: newRequestId() });
    } catch (error) {
      return { ok: false, state: "unknown", error: { code: "supervisor_unavailable", message: "The supervisor stopped answering while the operation ran." } };
    }
    const state = result.json?.state;
    if (result.status === 200 && state === "ok") return { ok: true, state };
    if (result.status === 200 && state === "failed") {
      const log = Array.isArray(result.json?.log) ? result.json.log : [];
      return { ok: false, state, error: { code: "operation_failed", message: String(log[log.length - 1] || "The operation failed.") } };
    }
    if (result.status >= 400 && result.status !== 429) return { ok: false, state: "unknown", error: errorFromBody(result.json, "operation_unknown", "The operation is not known.") };
    if (now() >= deadline) return { ok: false, state: "running", error: { code: "operation_timeout", message: "The operation is still running." } };
    await sleep(pollMs);
  }
}

/**
 * Starts or stops a manager through the supervisor when it answers. Resolves
 * { delegated: false } when the supervisor is not reachable (the caller runs
 * its own code), otherwise { delegated: true, ok, opId, state, error? }.
 * options: { control, aiRoot, sleep, now, pollMs, timeoutMs }.
 */
async function delegateManager(managerId, action, options = {}) {
  const verb = String(action || "");
  if (verb !== "start" && verb !== "stop") throw new TypeError("delegateManager handles start and stop");
  const control = options.control || core.platform.control.createControlClient({ aiRoot: options.aiRoot });
  const componentId = registryIdFor(managerId);
  let result;
  try {
    result = await control.request("POST", `/v1/components/${componentId}/${verb}`, { body: {}, timeoutMs: 5000, requestId: newRequestId() });
  } catch {
    return { delegated: false, reason: "supervisor_unavailable" };
  }
  if (result.status === 401 || result.status === 403) return { delegated: false, reason: "supervisor_unauthorized" };
  if (result.status >= 200 && result.status < 300) {
    const opId = typeof result.json?.opId === "string" ? result.json.opId : null;
    if (!opId) return { delegated: true, ok: result.json?.ok !== false, opId: null, state: "ok", status: result.status };
    const outcome = await waitForOperation(control, opId, {
      timeoutMs: Number(options.timeoutMs) || (verb === "start" ? START_WAIT_MS : STOP_WAIT_MS),
      pollMs: Number(options.pollMs) || OPERATION_POLL_MS,
      sleep: options.sleep || sleepMs,
      now: options.now || Date.now,
    });
    return { delegated: true, opId, status: result.status, ...outcome };
  }
  return { delegated: true, ok: false, opId: null, state: "refused", status: result.status, error: errorFromBody(result.json, "supervisor_refused", `The supervisor answered ${result.status}.`) };
}

/**
 * /api/stop-all with the supervisor up: POST /v1/stop {scope:"core"} stops the
 * entry and both managers, today's semantics. { delegated: false } when the
 * supervisor is not reachable.
 */
async function delegateStopAll(options = {}) {
  const control = options.control || core.platform.control.createControlClient({ aiRoot: options.aiRoot });
  let result;
  try {
    result = await control.request("POST", "/v1/stop", { body: { scope: "core" }, timeoutMs: 5000, requestId: newRequestId() });
  } catch {
    return { delegated: false, reason: "supervisor_unavailable" };
  }
  if (result.status === 401 || result.status === 403) return { delegated: false, reason: "supervisor_unauthorized" };
  if (result.status >= 200 && result.status < 300) {
    return { delegated: true, ok: result.json?.ok !== false, opId: typeof result.json?.opId === "string" ? result.json.opId : null, status: result.status };
  }
  return { delegated: true, ok: false, opId: null, status: result.status, error: errorFromBody(result.json, "supervisor_refused", `The supervisor answered ${result.status}.`) };
}

// --- the handler ---------------------------------------------------------------------

function createPlatformRoutes(deps = {}) {
  const aiRoot = path.resolve(String(deps.aiRoot || path.join(__dirname, "..", "..")));
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const clock = typeof deps.now === "function" ? deps.now : Date.now;
  const auth = deps.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function") {
    throw new TypeError("platform-routes: the request-auth seam (ctx.auth) is required");
  }
  const sendJsonImpl = deps.sendJson;
  const readJsonBody = deps.readJsonObjectBody;
  const sleep = deps.sleep || sleepMs;

  const warn = (line) => {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks a request.
    }
  };
  const nowMs = () => {
    const value = clock();
    return value instanceof Date ? value.getTime() : Number(value);
  };

  // --- supervisor gateway ---

  let sharedControl = null;
  function control() {
    if (deps.control) return deps.control;
    sharedControl ||= core.platform.control.createControlClient({ aiRoot, ...(deps.controlOptions || {}) });
    return sharedControl;
  }

  // A fresh client reads the token again, which is what a reconnect after a
  // supervisor restart needs.
  function freshControl() {
    return deps.control || core.platform.control.createControlClient({ aiRoot, ...(deps.controlOptions || {}) });
  }

  async function supervisor(method, pathWithQuery, options = {}) {
    let result;
    try {
      result = await control().request(method, pathWithQuery, {
        ...(options.body !== undefined ? { body: options.body } : {}),
        timeoutMs: options.timeoutMs || 5000,
        requestId: options.requestId || newRequestId(),
      });
    } catch (error) {
      if (error?.code === "invalid_control_path") throw error;
      throw supervisorUnavailable(error);
    }
    // A token the supervisor refuses after the client's own retry is a
    // supervisor we cannot drive: report it as not available.
    if (result.status === 401 || result.status === 403) throw supervisorUnavailable({ code: "unauthorized" });
    return result;
  }

  // --- status ---

  let statusCache = { at: 0, value: null, pending: null };
  let seen = { at: 0, running: null, readiness: null };
  let summaryRefresh = null;

  function noteSupervisor(status) {
    seen = {
      at: nowMs(),
      running: true,
      readiness: isPlainObject(status?.readiness) ? { overall: status.readiness.overall, layers: Array.isArray(status.readiness.layers) ? status.readiness.layers : [] } : null,
    };
  }

  function noteSupervisorMissing() {
    seen = { at: nowMs(), running: false, readiness: null };
  }

  function loadConfigForRead() {
    return configApi().loadPlatformConfig({ aiRoot, env, ...(vault() ? { secrets: vault() } : {}) });
  }

  let vaultInstance = null;
  function vault() {
    if (deps.secrets !== undefined) return deps.secrets;
    if (vaultInstance === null) {
      try {
        vaultInstance = require("../../manager-core/secret-store").createSecretVault({ aiRoot });
      } catch {
        vaultInstance = false;
      }
    }
    return vaultInstance || undefined;
  }

  let registryCache = { at: 0, value: null };
  function loadRegistry(fresh = false) {
    if (!fresh && registryCache.value && nowMs() - registryCache.at < REGISTRY_CACHE_MS) return registryCache.value;
    const config = loadConfigForRead();
    const registry = componentsApi().loadComponentRegistry({ aiRoot, config, now: nowMs() });
    registryCache = { at: nowMs(), value: { config, registry } };
    return registryCache.value;
  }

  function resolveSpecs({ config, registry }) {
    const resolved = [];
    for (const spec of registry.components) {
      try {
        resolved.push(componentsApi().resolveComponent(spec, { aiRoot, config }));
      } catch (error) {
        warn(`platform-routes: ${spec.id} could not be resolved: ${error?.message || error}`);
      }
    }
    return resolved;
  }

  function accessKeys() {
    if (typeof deps.getKeys === "function") {
      try {
        return deps.getKeys() || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function probeStatus() {
    const { config, registry } = loadRegistry(true);
    let build = null;
    try {
      build = (deps.getBuildId || ((options) => core.platform.getBuildId(options)))({ aiRoot });
    } catch {
      build = null;
    }
    return core.platform.status.probePlatformStatus({
      aiRoot,
      components: resolveSpecs({ config, registry }),
      config,
      build,
      listListeners: deps.listListeners || (() => core.platform.winproc.listListeners()),
      fetch: deps.fetch,
      execFile: deps.execFile,
      now: clock,
      keys: accessKeys(),
      ...(deps.instances !== undefined ? { instances: deps.instances } : {}),
    });
  }

  async function getStatus({ fresh = false } = {}) {
    if (!fresh && statusCache.value && nowMs() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
    if (statusCache.pending) return statusCache.pending;
    const pending = (async () => {
      let value = null;
      try {
        const result = await supervisor("GET", "/v1/status", { timeoutMs: 3000 });
        if (result.status === 200 && isPlainObject(result.json)) {
          value = result.json;
          noteSupervisor(value);
        }
      } catch (error) {
        if (error?.code !== "supervisor_unavailable") throw error;
      }
      if (!value) {
        noteSupervisorMissing();
        value = await probeStatus();
      }
      statusCache = { at: nowMs(), value, pending: null };
      return value;
    })();
    statusCache = { ...statusCache, pending };
    try {
      return await pending;
    } finally {
      if (statusCache.pending === pending) statusCache = { ...statusCache, pending: null };
    }
  }

  // The `platform` field of /api/status: the last supervisor answer, never a
  // wait. null until one has been seen.
  async function refreshSummary() {
    if (summaryRefresh) return summaryRefresh;
    summaryRefresh = (async () => {
      try {
        const result = await supervisor("GET", "/v1/status", { timeoutMs: 1500 });
        if (result.status === 200 && isPlainObject(result.json)) {
          noteSupervisor(result.json);
          statusCache = { at: nowMs(), value: result.json, pending: statusCache.pending };
        } else {
          noteSupervisorMissing();
        }
      } catch {
        noteSupervisorMissing();
      } finally {
        summaryRefresh = null;
      }
    })();
    return summaryRefresh;
  }

  function summary() {
    if (!seen.at || nowMs() - seen.at > SUMMARY_STALE_MS) refreshSummary().catch(() => {});
    if (!seen.at) return null;
    return { supervisor: { running: seen.running === true }, readiness: seen.readiness };
  }

  // --- the response helpers ---

  function send(res, body, status = 200, headers = {}) {
    return sendJsonImpl(res, body, status, headers);
  }

  function sendError(res, status, code, message, extra = {}) {
    const { hint, docs, action, ...rest } = extra;
    const error = { code, message, ...(hint ? { hint } : {}), ...(docs ? { docs } : {}), ...(action ? { action } : {}) };
    return send(res, { ok: false, error, ...(action ? { action } : {}), ...rest }, status);
  }

  function sendThrown(res, error) {
    if (error?.platformCode) {
      const { hint, action, ...rest } = error.extra || {};
      return sendError(res, error.platformStatus, error.platformCode, error.message, { hint, action, ...rest });
    }
    if (error?.status && error.status >= 400 && error.status < 500 && error.expose !== false) {
      return sendError(res, error.status, "invalid_request", String(error.message || "Invalid request."));
    }
    warn(`platform-routes: a request failed: ${error?.stack || error?.message || error}`);
    return sendError(res, 500, "internal_error", "Service entry error.");
  }

  // Forwards a supervisor answer. Its error envelopes keep their code and
  // status (component_busy with blockers, confirm_required, ...).
  function sendSupervisorResult(res, result, successStatus) {
    const json = isPlainObject(result.json) ? result.json : {};
    if (result.status >= 200 && result.status < 300) return send(res, Object.keys(json).length ? json : { ok: true }, successStatus || result.status);
    if (isPlainObject(json.error)) return send(res, { ok: false, ...json }, result.status);
    return sendError(res, result.status, "supervisor_error", `The supervisor answered ${result.status}.`);
  }

  async function readBody(req) {
    try {
      return await readJsonBody(req, MAX_BODY_BYTES);
    } catch (error) {
      throw platformError(error?.status || 400, "invalid_request", String(error?.message || "Request body must be a JSON object."));
    }
  }

  function componentIdOf(raw) {
    const text = String(raw || "");
    if (!COMPONENT_ID.test(text)) throw platformError(404, "component_unknown", "Unknown component.");
    const id = registryIdFor(text);
    let known = [];
    try {
      known = loadRegistry().registry.components.map((spec) => spec.id);
    } catch {
      known = [];
    }
    if (!known.includes(id)) throw platformError(404, "component_unknown", `Unknown component "${text}".`);
    return id;
  }

  function boolOf(value) {
    return value === true;
  }

  // --- handlers ---

  const handlers = {
    async status(req, res, url) {
      return { body: await getStatus({ fresh: url.searchParams.get("fresh") === "1" }) };
    },

    async components() {
      const status = await getStatus();
      return { body: { components: status.components || [] } };
    },

    async component(req, res, url, [rawId]) {
      const id = componentIdOf(rawId);
      let result = null;
      try {
        result = await supervisor("GET", `/v1/components/${id}`);
      } catch (error) {
        if (error?.code !== "supervisor_unavailable") throw error;
      }
      if (result) return { raw: result };
      const { config, registry } = loadRegistry();
      const spec = registry.components.find((item) => item.id === id);
      const resolved = componentsApi().resolveComponent(spec, { aiRoot, config });
      const status = await getStatus();
      const component = (status.components || []).find((row) => row.id === id) || null;
      return { body: { component, spec: redactSpec(resolved) } };
    },

    async componentStart(req, res, url, [rawId]) {
      const id = componentIdOf(rawId);
      const body = await readBody(req);
      const wait = boolOf(body.wait);
      try {
        const result = await supervisor("POST", `/v1/components/${id}/start`, { body: { wait }, timeoutMs: wait ? START_WAIT_MS + 30000 : 5000 });
        return { raw: result, status: wait ? 200 : 202 };
      } catch (error) {
        const managerId = MANAGER_COMPONENTS[id];
        if (error?.code !== "supervisor_unavailable" || !managerId || typeof deps.startManager !== "function") throw error;
        // No supervisor: the manager is started the way it always was, now
        // bound to the configured host (V21).
        const started = await deps.startManager(managerId);
        if (!started) throw error;
        return { body: { ok: started.ok !== false, fallback: "detached", ...pick(started, ["ready", "pid", "alreadyRunning"]) } };
      }
    },

    async componentStop(req, res, url, [rawId]) {
      const id = componentIdOf(rawId);
      const body = await readBody(req);
      const wait = boolOf(body.wait);
      const result = await supervisor("POST", `/v1/components/${id}/stop`, {
        body: { wait, models: boolOf(body.models), confirm: boolOf(body.confirm) },
        timeoutMs: wait ? STOP_WAIT_MS + 30000 : 5000,
      });
      return { raw: result, status: wait ? 200 : 202 };
    },

    async componentRestart(req, res, url, [rawId]) {
      const id = componentIdOf(rawId);
      const body = await readBody(req);
      if (body.when !== undefined && body.when !== "now" && body.when !== "idle") {
        throw platformError(400, "invalid_request", 'when must be "now" or "idle".');
      }
      const result = await supervisor("POST", `/v1/components/${id}/restart`, {
        body: { when: body.when === "idle" ? "idle" : "now", force: boolOf(body.force), wait: boolOf(body.wait) },
        timeoutMs: body.wait === true ? 120000 : 5000,
      });
      return { raw: result, status: 202 };
    },

    async logs(req, res, url, [rawId]) {
      const id = componentIdOf(rawId);
      const stream = url.searchParams.get("stream") || "all";
      if (!LOG_STREAMS.has(stream)) throw platformError(400, "invalid_request", "stream is out, err or all.");
      const tail = intParam(url.searchParams.get("tail"), 200, 1, 5000);
      const legacy = url.searchParams.get("legacy") === "1" ? "1" : "0";
      const result = await supervisor("GET", `/v1/components/${id}/logs?stream=${stream}&tail=${tail}&legacy=${legacy}`, { timeoutMs: 10000 });
      return { raw: result };
    },

    async logsFollow(req, res, url, [rawId]) {
      const id = componentIdOf(rawId);
      const stream = url.searchParams.get("stream") || "all";
      if (!LOG_STREAMS.has(stream)) throw platformError(400, "invalid_request", "stream is out, err or all.");
      // The component and the supervisor are checked before the stream opens,
      // so a failure is a JSON error and not a dead stream.
      const probe = await supervisor("GET", `/v1/components/${id}`);
      if (probe.status !== 200) return { raw: probe };
      return { stream: { id, stream } };
    },

    async supervisorStart(req, res) {
      const who = auth.principal(req);
      const owner = who.role === "owner" || who.principal === "system:cli";
      if (!owner || !isLoopbackRequest(req)) {
        throw platformError(403, "loopback_only", "The supervisor is started by the owner from this computer.", { hint: "Run `platform start` in a terminal on this computer." });
      }
      if (await control().available?.().catch(() => false)) return { body: { ok: true, alreadyRunning: true }, status: 200 };
      const script = path.join(aiRoot, "scripts", "platformctl.js");
      if (!deps.spawn && !fs.existsSync(script)) throw platformError(500, "supervisor_start_failed", "The platform CLI is not installed in this folder.");
      try {
        const child = (deps.spawn || childProcess.spawn)(deps.nodeExe || env.NODE_EXE || process.execPath || "node", [script, "supervise", "--profile", "none"], {
          cwd: aiRoot,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          env: { ...env, AI_ROOT: aiRoot },
        });
        child.on?.("error", (error) => warn(`platform-routes: the supervisor could not be spawned: ${error?.message || error}`));
        child.unref?.();
      } catch (error) {
        throw platformError(500, "supervisor_start_failed", `The supervisor could not be started (${error?.code || "error"}).`);
      }
      return { body: { ok: true }, status: 202 };
    },

    async doctor(req, res, url) {
      const raw = url.searchParams.get("group");
      const groups = raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : null;
      if (groups && groups.some((group) => !DOCTOR_GROUPS.has(group))) throw platformError(400, "invalid_request", `group is one of ${[...DOCTOR_GROUPS].join(", ")}.`);
      const deep = ["1", "true"].includes(url.searchParams.get("deep") || "");
      const fresh = ["1", "true"].includes(url.searchParams.get("fresh") || "");
      return { body: await runDoctorCached({ groups, deep, fresh }) };
    },

    async doctorFix(req) {
      const body = await readBody(req);
      if (typeof body.checkId !== "string" || !body.checkId || typeof body.fixId !== "string" || !body.fixId) {
        throw platformError(400, "invalid_request", "checkId and fixId are required.");
      }
      // The last doctor run knows the fix's risk. A manual fix is refused
      // here; the supervisor repeats the rule for fixes this cache never saw.
      const known = knownFix(body.checkId, body.fixId);
      if (known?.risk === "manual") {
        throw platformError(400, "fix_manual_only", "This fix is manual: run the command shown, the platform never runs it.", { command: known.command || null, docs: known.docs || null });
      }
      if (known?.risk === "confirm" && body.confirm !== true) {
        throw platformError(400, "confirm_required", "This fix needs confirmation (confirm: true).");
      }
      const result = await supervisor("POST", "/v1/doctor/fix", { body: { checkId: body.checkId, fixId: body.fixId, confirm: body.confirm === true }, timeoutMs: 10000 });
      return { raw: result, status: 202 };
    },

    async operation(req, res, url, [opId]) {
      if (!OPERATION_ID.test(opId)) throw platformError(404, "operation_unknown", "Unknown operation.");
      return { raw: await supervisor("GET", `/v1/operations/${opId}`) };
    },

    async configGet() {
      const loaded = loadConfigForRead();
      const description = configApi().describeEffectiveConfig(loaded, { includeSecrets: true });
      let overrideErrors = [];
      try {
        overrideErrors = loadRegistry(true).registry.errors || [];
      } catch {
        overrideErrors = [];
      }
      return { body: { ok: true, ...description, overrideErrors }, headers: { etag: quoteEtag(description.etag) } };
    },

    async configPut(req) {
      const who = auth.principal(req);
      const body = await readBody(req);
      const set = body.set === undefined ? {} : body.set;
      const unset = body.unset === undefined ? [] : body.unset;
      const secrets = body.secrets === undefined ? {} : body.secrets;
      if (!isPlainObject(set) || !Array.isArray(unset) || !unset.every((key) => typeof key === "string") || !isPlainObject(secrets)) {
        throw platformError(400, "config_invalid", "set and secrets are objects and unset is a list of keys.", { errors: [{ field: "$body", code: "invalid_type", message: "set and secrets are objects and unset is a list of keys." }] });
      }
      if (!Object.keys(set).length && !unset.length && !Object.keys(secrets).length) {
        throw platformError(400, "invalid_request", "There is nothing to change.");
      }
      const api = configApi();
      const schema = api.loadPlatformSchema();
      const secretErrors = [];
      for (const [key, value] of Object.entries(secrets)) {
        const leaf = schema.leaves.get(key);
        if (!leaf || !leaf.secret) secretErrors.push({ field: key, code: "not_secret", message: `${key} is not a secret setting; send it in set.` });
        else if (value !== null && (typeof value !== "string" || !value.trim())) secretErrors.push({ field: key, code: "invalid_type", message: `${key} needs a non-empty string, or null to clear it.` });
      }
      if (secretErrors.length) throw platformError(400, "config_invalid", "Some secrets are not valid.", { errors: secretErrors });
      const actor = String(who.principal || "console");
      const etag = parseIfMatch(req.headers["if-match"]);
      let changed = [];
      let restartRequired = [];
      let etagAfter = etag;
      if (Object.keys(set).length || unset.length) {
        const written = await api.writePlatformConfig({ aiRoot, env, set, unset, ...(etag ? { etag } : {}), actor, schema });
        if (!written.ok) throw configFailure(written);
        changed = written.changed || [];
        restartRequired = written.restartRequired || [];
        etagAfter = written.etag;
      }
      for (const [key, value] of Object.entries(secrets)) {
        const stored = await api.setSecretLeaf(key, value, { aiRoot, actor, schema, ...(vault() ? { secrets: vault() } : {}) });
        if (!stored.ok) throw configFailure(stored, { changed });
        changed = [...changed, key];
        restartRequired = [...new Set([...restartRequired, ...(stored.restartRequired || [])])];
      }
      if (!etagAfter || etagAfter === etag) {
        try {
          etagAfter = loadConfigForRead().etag;
        } catch {
          // The write succeeded; the etag is a convenience.
        }
      }
      registryCache = { at: 0, value: null };
      return { body: { ok: true, etag: etagAfter, changed, restartRequired }, headers: etagAfter ? { etag: quoteEtag(etagAfter) } : {} };
    },

    async configApply(req) {
      const body = await readBody(req);
      const when = body.when === undefined ? "idle" : body.when;
      if (when !== "idle" && when !== "now") throw platformError(400, "invalid_request", 'when must be "idle" or "now".');
      if (!Array.isArray(body.restart) || !body.restart.length || !body.restart.every((id) => typeof id === "string")) {
        throw platformError(400, "invalid_request", "restart is a list of component ids.");
      }
      const ids = [...new Set(body.restart.map((id) => componentIdOf(id)))];
      // The entry restarts last: it drops this connection.
      ids.sort((left, right) => Number(left === "entry") - Number(right === "entry"));
      const force = body.force === true;
      if (when === "now" && !force) {
        const idle = await supervisor("GET", "/v1/idle");
        if (idle.status === 200 && idle.json?.idle === false) {
          return { body: { ok: false, error: { code: "component_busy", message: "The platform is busy; restart later, queue it for idle or force it." }, blockers: idle.json.blockers || [] }, status: 409 };
        }
      }
      const results = [];
      for (const id of ids) {
        const result = await supervisor("POST", `/v1/components/${id}/restart`, { body: { when, force }, timeoutMs: 10000 });
        if (result.status < 200 || result.status >= 300) return { raw: result };
        results.push({ id, ...pick(result.json, ["opId", "queued", "blockers"]) });
      }
      const opIds = results.map((item) => item.opId).filter(Boolean);
      return { body: { ok: true, opId: opIds[0] || null, opIds, results }, status: 202 };
    },

    async version() {
      return { body: await buildVersion() };
    },

    async deploys(req, res, url) {
      const limit = intParam(url.searchParams.get("limit"), 20, 1, 200);
      const list = (deps.listDeployments || ((root, options) => core.platform.listDeployments(root, options)))(aiRoot, { limit });
      return { body: { deployments: list } };
    },

    async schedules() {
      const schedules = core.platform.schedules;
      const nightly = schedules.readNightly(aiRoot, { now: clock });
      const backup = schedules.readBackup(aiRoot, { now: clock });
      let tasks = null;
      try {
        const report = await runDoctorCached({ ids: ["ops.autostart", "ops.nightly", "ops.backup"], groups: null, deep: false, fresh: false });
        const byId = new Map((report.checks || []).map((check) => [check.id, check]));
        tasks = {
          autostart: byId.get("ops.autostart")?.data || null,
          nightly: byId.get("ops.nightly")?.data?.task || null,
          backup: byId.get("ops.backup")?.data?.task || null,
        };
      } catch {
        tasks = null;
      }
      return {
        body: {
          nightly: {
            latest: nightly.available ? pick(nightly, ["ok", "passed", "failed", "at", "ageHours"]) : null,
            trend: nightly.trend,
            streak: nightly.streak,
            since: nightly.since,
          },
          backup: {
            latest: backup.available ? pick(backup, ["stamp", "at", "format", "formatOk", "warnings"]) : null,
            ageHours: backup.ageHours,
            files: backup.files,
          },
          tasks,
        },
      };
    },

    async pendingList() {
      return { raw: await supervisor("GET", "/v1/pending-restarts") };
    },

    async pendingCancel(req, res, url, [rawId]) {
      return { raw: await supervisor("DELETE", `/v1/pending-restarts/${componentIdOf(rawId)}`) };
    },

    async restoreModels(req) {
      const body = await readBody(req);
      if (body.managers !== undefined && (!Array.isArray(body.managers) || !body.managers.every((id) => typeof id === "string"))) {
        throw platformError(400, "invalid_request", "managers is a list of manager ids.");
      }
      const result = await supervisor("POST", "/v1/restore-models", {
        body: { ...(body.managers ? { managers: body.managers } : {}), dryRun: body.dryRun === true },
        timeoutMs: 15000,
      });
      return { raw: result, status: 202 };
    },

    async setupGet() {
      const api = setupApi();
      if (!api) throw platformError(501, "setup_unavailable", "The setup wizard is not part of this build.");
      const doctor = lastDoctor();
      return { body: await api.describeSetup({ aiRoot, env, doctor }) };
    },

    async setupStep(req, res, url, [step]) {
      if (!STEP_ID.test(step)) throw platformError(404, "setup_step_unknown", "Unknown setup step.");
      const body = await readBody(req);
      return { raw: await supervisor("POST", `/v1/setup/${step}`, { body, timeoutMs: 15000 }), status: 202 };
    },

    async busy() {
      return { body: collectBusy() };
    },
  };

  // --- pieces of the handlers ---

  function intParam(value, fallback, min, max) {
    const number = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function quoteEtag(etag) {
    return `"${String(etag || "").replace(/"/g, "")}"`;
  }

  function parseIfMatch(header) {
    const text = String(Array.isArray(header) ? header[0] : header || "").trim();
    if (!text || text === "*") return "";
    return text.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  }

  function isLoopbackRequest(req) {
    try {
      return core.isLocalRequest(req);
    } catch {
      return false;
    }
  }

  function redactSpec(spec) {
    const copy = JSON.parse(JSON.stringify(spec));
    const hide = (env_) => Object.fromEntries(Object.keys(env_).sort().map((name) => [name, "<redacted>"]));
    if (isPlainObject(copy.env)) copy.env = hide(copy.env);
    if (Array.isArray(copy.members)) {
      for (const member of copy.members) if (isPlainObject(member?.env)) member.env = hide(member.env);
    }
    return copy;
  }

  function configFailure(result, extra = {}) {
    const code = result.code || result.error?.code || "config_invalid";
    const hint = code === "config_conflict" ? "reload" : code === "config_locked" ? "retry" : undefined;
    return platformError(result.status || 400, code, result.error?.message || "The settings could not be saved.", {
      ...(hint ? { hint } : {}),
      errors: result.errors || [],
      ...(result.etag ? { etag: result.etag } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...extra,
    });
  }

  // Single flight per request shape, cached for 30 s; fresh=1 skips the cache.
  const doctorRuns = new Map();
  let doctorLast = null;

  function lastDoctor() {
    return doctorLast ? doctorLast.report : null;
  }

  function knownFix(checkId, fixId) {
    const check = (doctorLast?.report?.checks || []).find((item) => item.id === checkId);
    return check?.fix && check.fix.id === fixId ? check.fix : null;
  }

  async function runDoctorCached({ groups, ids, deep, fresh }) {
    const key = JSON.stringify([groups || null, ids || null, deep === true]);
    const entry = doctorRuns.get(key);
    if (entry?.pending) return entry.pending;
    if (!fresh && entry?.report && nowMs() - entry.at < DOCTOR_CACHE_MS) return entry.report;
    const runner = deps.runDoctor || ((options) => core.platform.doctor.runDoctor(options));
    const pending = Promise.resolve().then(() => runner({
      aiRoot, env, deep: deep === true, now: clock,
      ...(groups ? { groups } : {}),
      ...(ids ? { ids } : {}),
    }));
    doctorRuns.set(key, { ...(entry || {}), pending });
    try {
      const report = await pending;
      const stored = { report, at: nowMs(), pending: null };
      doctorRuns.set(key, stored);
      if (!ids) doctorLast = stored;
      return report;
    } catch (error) {
      doctorRuns.set(key, { ...(entry || {}), pending: null });
      throw error;
    }
  }

  let versionCache = { at: 0, value: null };
  let newerCommits = { at: 0, value: null };
  let driftCache = { at: 0, value: null };

  async function buildVersion() {
    const timeNow = nowMs();
    if (versionCache.value && timeNow - versionCache.at < VERSION_CACHE_MS) return versionCache.value;
    const platform = core.platform;
    let version = null;
    try {
      version = (deps.readVersion || ((root) => platform.readVersion(root)))(aiRoot);
    } catch {
      version = null;
    }
    let build = null;
    try {
      build = (deps.getBuildId || ((options) => platform.getBuildId(options)))({ aiRoot });
    } catch {
      build = null;
    }
    if (!newerCommits.value || timeNow - newerCommits.at > NEWER_COMMITS_CACHE_MS) {
      try {
        const counted = await (deps.countNewerCommits || ((root) => platform.countNewerCommits(root)))(aiRoot);
        newerCommits = { at: timeNow, value: counted };
      } catch {
        newerCommits = { at: timeNow, value: { available: false, behind: null } };
      }
    }
    if (!driftCache.value || timeNow - driftCache.at > VERSION_CACHE_MS) {
      try {
        const drift = (deps.computeLiveDrift || ((root) => platform.computeLiveDrift(root)))(aiRoot);
        driftCache = { at: timeNow, value: { count: Array.isArray(drift) ? drift.length : 0, checkedAt: new Date(timeNow).toISOString() } };
      } catch {
        driftCache = { at: timeNow, value: { count: 0, checkedAt: null } };
      }
    }
    const value = {
      version: version?.version || null,
      build: build ? { commit: build.commit || null, contentHash: build.contentHash || null } : null,
      node: process.version,
      packages: readPackages(),
      newerCommits: newerCommits.value,
      drift: driftCache.value,
    };
    versionCache = { at: timeNow, value };
    return value;
  }

  function readPackages() {
    let dirs = [];
    try {
      dirs = (loadRegistry().registry.packages || []).map((item) => item.dir);
    } catch {
      dirs = [];
    }
    const out = [];
    for (const dir of dirs) {
      try {
        const text = fs.readFileSync(path.join(aiRoot, dir, "package.json"), "utf8").replace(/^﻿/, "");
        out.push({ dir, version: String(JSON.parse(text).version || "") || null });
      } catch {
        out.push({ dir, version: null });
      }
    }
    return out;
  }

  let setupModule;
  function setupApi() {
    if (deps.setup !== undefined) return deps.setup;
    if (setupModule === undefined) {
      try {
        const loaded = require("../../manager-core/platform/setup");
        setupModule = typeof loaded?.describeSetup === "function" ? loaded : null;
      } catch {
        setupModule = null;
      }
    }
    return setupModule;
  }

  // Entry-side blockers for the idle gate (06 §5.11): hub transfers and
  // in-flight gateway streams. The supervisor adds the managers' own.
  function collectBusy() {
    const blockers = [];
    const hub = typeof deps.getHub === "function" ? deps.getHub() : null;
    if (hub && typeof hub.busy === "function") {
      try {
        const busy = hub.busy() || {};
        const downloads = Number(busy.downloads) || 0;
        const verifying = Number(busy.verifying) || 0;
        if (downloads > 0) blockers.push({ kind: "download", source: "entry", id: "hub:downloads", title: `${downloads} download${downloads === 1 ? "" : "s"} in progress`, since: null });
        if (verifying > 0) blockers.push({ kind: "download", source: "entry", id: "hub:verifying", title: `${verifying} download verification${verifying === 1 ? "" : "s"} in progress`, since: null });
      } catch {
        blockers.push({ kind: "unknown", source: "entry", id: "hub:unknown", title: "The download queue could not be read", since: null });
      }
    }
    if (typeof deps.gatewayInFlight === "function") {
      try {
        const inFlight = Math.max(0, Number(deps.gatewayInFlight()) || 0);
        if (inFlight > 0) blockers.push({ kind: "requests", source: "entry", id: "gateway", title: `${inFlight} gateway request${inFlight === 1 ? "" : "s"} in flight`, since: null });
      } catch {
        blockers.push({ kind: "unknown", source: "entry", id: "gateway:unknown", title: "The gateway load could not be read", since: null });
      }
    }
    return { blockers };
  }

  // --- the request entry point ---

  function matchRoute(method, pathname) {
    let pathMatched = false;
    for (const route of ROUTES) {
      const found = route.pattern.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (route.method === method || (method === "HEAD" && route.method === "GET")) {
        return { route, params: found.slice(1).map((value) => { try { return decodeURIComponent(value); } catch { return value; } }) };
      }
    }
    return { route: null, pathMatched };
  }

  // Who may call a row. Viewer rows are open to any caller the guard let
  // through; the rest need the owner (session plus CSRF, or a token) or a
  // machine principal inside its scope. A viewer on an owner-only row is a 401
  // here too, so the module is safe when the guard is not in front of it.
  function authorise(req, route) {
    const who = auth.principal(req);
    if (route.access === "viewer") {
      if (who.role === "none") return { ok: false, status: 401, code: "admin_session_required", message: "This page needs the console owner. Pair this browser first.", hint: "pair" };
      return { ok: true, who };
    }
    const checked = auth.checkWrite(req);
    if (!checked.ok) return checked;
    return { ok: true, who };
  }

  function wantsRedaction(who) {
    return who.role === "viewer" || who.role === "none" || who.principal === "system:mcp";
  }

  function openLogStream(req, res, { id, stream }) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    let closed = false;
    let subscription = null;
    const finish = () => {
      if (closed) return;
      closed = true;
      try { subscription?.close(); } catch { /* already closed */ }
      try { res.end(); } catch { /* socket gone */ }
      streams.delete(finish);
    };
    streams.add(finish);
    subscription = freshControl().events((event) => {
      if (closed || res.writableEnded) return;
      const data = event.data;
      const name = /^[a-z-]{1,20}$/.test(String(event.type)) ? event.type : "log";
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }, {
      path: `/v1/components/${id}/logs/follow?stream=${stream}`,
      onError: () => {
        if (!closed && !res.writableEnded) res.write('event: error\ndata: {"code":"supervisor_unavailable"}\n\n');
        finish();
      },
    });
    req.on("close", finish);
  }

  const streams = new Set();

  async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const method = String(req.method || "GET").toUpperCase();
    const { route, params, pathMatched } = matchRoute(method, url.pathname);
    if (!route) {
      req.resume?.();
      if (pathMatched) sendError(res, 405, "method_not_allowed", "This method is not supported here.");
      else sendError(res, 404, "not_found", "Unknown platform route.");
      return true;
    }
    try {
      const allowed = authorise(req, route);
      if (!allowed.ok) {
        req.resume?.();
        sendError(res, allowed.status, allowed.code, allowed.message, { hint: allowed.hint });
        return true;
      }
      const outcome = await handlers[route.run](req, res, url, params);
      if (outcome?.stream) {
        openLogStream(req, res, outcome.stream);
        return true;
      }
      if (outcome?.raw) {
        sendSupervisorResult(res, outcome.raw, outcome.status);
        return true;
      }
      let body = outcome.body;
      if (route.redact && wantsRedaction(allowed.who)) body = route.redact(body);
      send(res, body, outcome.status || 200, outcome.headers || {});
    } catch (error) {
      req.resume?.();
      if (!res.headersSent) sendThrown(res, error);
      else res.destroy?.();
    }
    return true;
  }

  // --- the events bridge (06 §5.10) ---

  const bus = deps.bus;
  let bridgeClosed = false;
  let bridgeTimer = null;
  let bridgeSub = null;
  let bridgeRetryMs = BRIDGE_MIN_RETRY_MS;
  let bridgeWarned = 0;

  function unwrapEvent(event) {
    const data = event?.data;
    if (isPlainObject(data) && typeof data.type === "string" && Object.hasOwn(data, "data")) return data.data;
    return data;
  }

  function publishBridged(type, data, options) {
    try {
      const published = bus.publish(type, data, options);
      if (published === null && bridgeWarned < 5) {
        bridgeWarned += 1;
        warn(`platform-routes: the bus refused a ${type} event from the supervisor`);
      }
    } catch (error) {
      warn(`platform-routes: publishing a ${type} event failed: ${error?.message || error}`);
    }
  }

  function onSupervisorEvent(event) {
    bridgeRetryMs = BRIDGE_MIN_RETRY_MS;
    const payload = unwrapEvent(event);
    if (!isPlainObject(payload)) return;
    const type = String(event?.type || "");
    if (type === "status") {
      if (isPlainObject(payload.status)) {
        noteSupervisor(payload.status);
        statusCache = { at: nowMs(), value: payload.status, pending: statusCache.pending };
      }
      publishBridged("platform", { ...payload, kind: "status" }, { source: "platform" });
    } else if (type === "component" || type === "operation") {
      publishBridged("platform", { ...payload, kind: type }, { source: "platform" });
    } else if (type === "notification") {
      publishBridged("notification", payload, { source: "platform" });
    }
  }

  function scheduleBridgeRetry() {
    if (bridgeClosed || bridgeTimer) return;
    const delay = bridgeRetryMs;
    bridgeRetryMs = Math.min(bridgeRetryMs * 2, BRIDGE_MAX_RETRY_MS);
    bridgeTimer = setTimeout(() => {
      bridgeTimer = null;
      connectBridge();
    }, delay);
    bridgeTimer.unref?.();
  }

  function connectBridge() {
    if (bridgeClosed) return;
    try {
      bridgeSub = freshControl().events(onSupervisorEvent, {
        path: "/v1/events",
        onError: () => {
          bridgeSub = null;
          scheduleBridgeRetry();
        },
      });
    } catch {
      bridgeSub = null;
      scheduleBridgeRetry();
    }
  }

  function startBridge() {
    if (!bus || typeof bus.publish !== "function" || deps.bridge === false) return;
    connectBridge();
  }

  function close() {
    bridgeClosed = true;
    if (bridgeTimer) clearTimeout(bridgeTimer);
    bridgeTimer = null;
    try { bridgeSub?.close(); } catch { /* already closed */ }
    bridgeSub = null;
    for (const finish of [...streams]) finish();
  }

  return {
    handle,
    close,
    startBridge,
    getStatus,
    summary,
    refresh: refreshSummary,
    registerRoutes: (registry) => registerPlatformRoutes(registry, warn),
    delegateManager: (managerId, action, options = {}) => delegateManager(managerId, action, { control: control(), aiRoot, sleep, now: clock, pollMs: deps.pollMs, ...options }),
    delegateStopAll: (options = {}) => delegateStopAll({ control: control(), aiRoot, ...options }),
    setupAvailable: () => Boolean(setupApi()),
  };
}

// --- route module (07 §2.7) -----------------------------------------------------------

function mount(ctx) {
  const auth = ctx?.auth;
  if (!auth || typeof auth.principal !== "function" || typeof auth.checkWrite !== "function" || !auth.viewerRegistry) {
    throw new Error("platform-routes: ctx.auth is missing");
  }
  const overrides = isPlainObject(ctx.platformDeps) ? ctx.platformDeps : {};
  const routes = createPlatformRoutes({
    aiRoot: ctx.aiRoot,
    auth,
    bus: ctx.bus,
    sendJson: ctx.sendJson,
    readJsonObjectBody: ctx.readJsonObjectBody,
    logger: ctx.logger,
    now: ctx.now,
    // Read at call time: the hub is built after the context and the managers
    // start through the entry's own code.
    getHub: () => ctx.hub || null,
    gatewayInFlight: typeof ctx.gatewayInFlight === "function" ? ctx.gatewayInFlight : undefined,
    startManager: typeof ctx.startManager === "function" ? ctx.startManager : undefined,
    getKeys: () => {
      const store = typeof ctx.getAccessStore === "function" ? ctx.getAccessStore() : null;
      const counts = store && typeof store.countKeys === "function" ? store.countKeys() : null;
      return counts ? { activeKeys: Math.max(0, Number(counts.active || 0) - Number(counts.expired || 0)) } : null;
    },
    ...overrides,
  });
  routes.registerRoutes(auth.viewerRegistry);
  if (ctx.features && typeof ctx.features === "object") ctx.features.setup = routes.setupAvailable();
  ctx.platform = {
    delegateManager: routes.delegateManager,
    delegateStopAll: routes.delegateStopAll,
    summary: routes.summary,
    refresh: routes.refresh,
    getStatus: routes.getStatus,
  };
  routes.startBridge();
  return {
    handle: routes.handle,
    close() {
      routes.close();
      if (ctx.platform) ctx.platform = null;
    },
  };
}

module.exports = {
  PREFIX,
  ROUTES,
  createPlatformRoutes,
  delegateManager,
  delegateStopAll,
  feature: "platform",
  mount,
  name: "platform",
  redactComponentForViewer,
  redactComponentsForViewer,
  redactPlatformEventForViewer,
  redactPlatformSummaryForViewer,
  redactStatusForViewer,
  redactVersionForViewer,
  registerPlatformRoutes,
};
