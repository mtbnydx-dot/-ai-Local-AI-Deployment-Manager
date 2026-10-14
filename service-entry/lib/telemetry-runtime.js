"use strict";

// Telemetry runtime of the service entry (docs/overhaul/04-telemetry.md §3).
//
// One object owns the TelemetryStore (service-entry/data/telemetry.sqlite,
// worker thread) and the collectors that run in the entry. This first
// version (TEL-9) runs the EventCollector; the gateway recorder (TEL-5),
// the runtime and GPU collectors (TEL-7, TEL-8), the query routes (TEL-11)
// and the internal ingest (TEL-6) attach to the same object.
//
// - Events come in only through events.subscribe() on the ENT-EV bus; this
//   module never publishes and never edits the bus. Manager `jobs` and
//   `instances` arrive through ENT-EV's manager relay.
// - Telemetry is never on a request's path. A store that cannot open leaves
//   the store in degraded mode (writes are counted and dropped), a collector
//   failure is logged, and the entry keeps serving.
// - TELEMETRY_ENABLED=0 (or telemetry.enabled=false) runs nothing.
// - Docker is reached the way the managers reach it (DOCKER_WSL_DISTRO,
//   DOCKER_EXE), and only through `docker events`; telemetry never starts
//   Docker Desktop or a WSL distro.

const path = require("node:path");
const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const { createEventCollector, dockerEventSourceFromEnv } = require("../../manager-core/telemetry/collectors/events");
const { redactSecrets } = require("../../manager-core/secret-redactor");

const DEFAULT_DB_FILE = "telemetry.sqlite";
const STOP_FLUSH_MS = 2000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function envFlag(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (["0", "false", "no", "off"].includes(text)) return false;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  return null;
}

// The `telemetry` section as readSection("telemetry") returns it, or {}
// while 04's schema fragment is not installed (unknown_section).
function readTelemetrySection(aiRoot, env) {
  try {
    const { readSection } = require("../../manager-core/platform/config");
    const result = readSection("telemetry", { aiRoot, env });
    return isPlainObject(result?.values) ? result.values : {};
  } catch {
    return {};
  }
}

/**
 * Effective settings: env > platform.json > default (D9). `config` is the
 * telemetry section when the caller already has it.
 */
function resolveTelemetryConfig({ config, env = process.env, aiRoot, dataDir } = {}) {
  const section = isPlainObject(config) ? config : readTelemetrySection(aiRoot, env);
  const enabledEnv = envFlag(env.TELEMETRY_ENABLED);
  const enabled = enabledEnv !== null ? enabledEnv : section.enabled !== false;
  const configuredPath = String(env.AI_TELEMETRY_DB || section.dbPath || "").trim();
  const dbPath = configuredPath ? path.resolve(configuredPath) : path.join(dataDir, DEFAULT_DB_FILE);
  return { enabled, dbPath };
}

// PLATFORM_MCP_AUDIT_LOG is read the way platform-mcp reads it: env, else
// <AI_ROOT>/audit-logs/platform-mcp.jsonl, and only inside the AI root.
function mcpAuditLogFile(aiRoot, env) {
  const root = path.resolve(aiRoot);
  const file = path.resolve(String(env.PLATFORM_MCP_AUDIT_LOG || path.join(root, "audit-logs", "platform-mcp.jsonl")));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return file;
}

/**
 * The log tails of the EventCollector: process-exit.log of the entry and of
 * each manager (<manager root>/logs/process-exit.log) and the platform-mcp
 * audit log.
 */
function buildTailFiles({ aiRoot, managers = [], processExitLog = "", env = process.env } = {}) {
  const tails = [];
  if (processExitLog) tails.push({ id: "process-exit:entry", kind: "process-exit", managerId: "entry", file: processExitLog });
  for (const manager of Array.isArray(managers) ? managers : []) {
    const id = String(manager?.id || "").trim();
    const root = String(manager?.root || "").trim();
    if (!id || !root) continue;
    tails.push({ id: `process-exit:${id}`, kind: "process-exit", managerId: id, file: path.join(root, "logs", "process-exit.log") });
  }
  const mcpLog = aiRoot ? mcpAuditLogFile(aiRoot, env) : "";
  if (mcpLog) tails.push({ id: "mcp", kind: "mcp", file: mcpLog });
  return tails;
}

function normalizeLogger(logger) {
  const target = logger === undefined ? console : logger;
  return (level, message) => {
    if (!target) return;
    const line = redactSecrets(String(message));
    const method = typeof target[level] === "function" ? target[level] : target.log;
    if (typeof method === "function") method.call(target, line);
  };
}

/**
 * options: { aiRoot, dataDir, managers, managerClient, events, config, env,
 * logger, docker, processExitLog, platformConfigFile, openStore, now, timers }.
 * - managers: the entry's MANAGERS ({id, root, port}).
 * - managerClient: the entry's shared manager client (mgmt-proxy) with
 *   get(managerId, target) → {ok, status, data}.
 * - events: the ENT-EV bus.
 * - docker: a docker event source ({precheck, open}), false to skip docker,
 *   or {spawn, execFile} for the default one built from the environment.
 * Returns { start(), stop(), recorder, handleHttp, handleInternal, status(),
 * recordConfigChange(section, change, extra) }.
 */
function createTelemetryRuntime(options = {}) {
  const env = options.env || process.env;
  const aiRoot = options.aiRoot ? path.resolve(options.aiRoot) : "";
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(__dirname, "..", "data");
  const log = normalizeLogger(options.logger);
  const openStore = typeof options.openStore === "function" ? options.openStore : openTelemetryStore;
  const settings = resolveTelemetryConfig({ config: options.config, env, aiRoot, dataDir });
  const managers = Array.isArray(options.managers) ? options.managers : [];
  const client = options.managerClient && typeof options.managerClient.get === "function" ? options.managerClient : null;

  let store = null;
  let events = null;
  let starting = null;
  let stopped = false;
  let lastError = null;

  function dockerSource() {
    if (options.docker === false) return null;
    if (options.docker && typeof options.docker.open === "function") return options.docker;
    const extra = isPlainObject(options.docker) ? options.docker : {};
    return dockerEventSourceFromEnv(env, extra);
  }

  function platformConfigFile() {
    if (options.platformConfigFile !== undefined) return options.platformConfigFile || "";
    if (!aiRoot) return "";
    try {
      return require("../../manager-core/platform/config").platformConfigFile({ aiRoot, env });
    } catch {
      return "";
    }
  }

  async function startCollectors() {
    try {
      store = await openStore({ file: settings.dbPath, logger: options.logger === undefined ? console : options.logger });
    } catch (error) {
      lastError = String(error?.message || error);
      log("error", `Telemetry is off for this run: the store could not be opened (${lastError}).`);
      return;
    }
    if (stopped) {
      await store.close({ flushMs: 0 }).catch(() => {});
      return;
    }
    events = createEventCollector({
      store,
      events: options.events || null,
      managers: client ? { ids: managers.map((manager) => manager.id), get: (managerId, target) => client.get(managerId, target) } : null,
      dockerEvents: dockerSource(),
      tailFiles: buildTailFiles({ aiRoot, managers, processExitLog: options.processExitLog || "", env }),
      platformConfigFile: platformConfigFile(),
      now: options.now,
      timers: options.timers,
      logger: options.logger,
    });
    events.start();
  }

  function start() {
    if (!settings.enabled) return Promise.resolve(api);
    if (!starting) {
      stopped = false;
      starting = startCollectors().catch((error) => {
        lastError = String(error?.message || error);
        log("error", `Telemetry failed to start: ${lastError}`);
      }).then(() => api);
    }
    return starting;
  }

  async function stop({ flushMs = STOP_FLUSH_MS } = {}) {
    stopped = true;
    if (starting) await starting;
    starting = null;
    const collector = events;
    events = null;
    if (collector) await collector.stop().catch(() => {});
    const current = store;
    store = null;
    if (current) await current.close({ flushMs }).catch(() => {});
  }

  // Config writers call this after a successful write; it never throws.
  function recordConfigChange(section, change, extra = {}) {
    try {
      return events ? events.recordConfigChange(section, change, extra) : null;
    } catch {
      return null;
    }
  }

  function status() {
    return {
      enabled: settings.enabled,
      store: store ? store.state : settings.enabled ? "stopped" : "disabled",
      lastError,
      collectors: { events: events ? events.status() : null },
    };
  }

  const api = {
    start,
    stop,
    // The gateway recorder arrives with TEL-5; until then nothing records.
    recorder: null,
    // /api/telemetry/* (TEL-11) and /internal/telemetry/* (TEL-6).
    handleHttp: async () => false,
    handleInternal: async () => false,
    status,
    recordConfigChange,
    get collectors() {
      return { events };
    },
    get store() {
      return store;
    },
  };
  return api;
}

module.exports = {
  buildTailFiles,
  createTelemetryRuntime,
  mcpAuditLogFile,
  resolveTelemetryConfig,
};
