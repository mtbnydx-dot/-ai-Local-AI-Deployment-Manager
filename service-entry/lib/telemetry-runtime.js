"use strict";

// Telemetry runtime of the service entry (docs/overhaul/04-telemetry.md §3).
//
// One object owns the TelemetryStore (service-entry/data/telemetry.sqlite,
// worker thread), the gateway recorder (TEL-5) and the collectors that run in
// the entry (the EventCollector, TEL-9, and the RuntimeCollector, TEL-7) and
// the alert engine with its notifier (TEL-13). The GPU collector (TEL-8), the
// query routes (TEL-11) and the internal ingest (TEL-6) attach to the same
// object.
//
// - The GatewayRecorder (manager-core/telemetry/recorder.js) is created with
//   the runtime and writes through the store once it is open; rows that are
//   finalised before that, or while the store is unavailable, are buffered
//   and then dropped and counted, never blocking a response. `onRow` feeds
//   the legacy gateway-access.log from finalised rows (§6.5).

// - Events come in only through events.subscribe() on the ENT-EV bus; this
//   module never edits the bus. The notifier of the alert engine is its one
//   publisher, and only of "alerts" and "notification" (04 section 12). Manager `jobs` and
//   `instances` arrive through ENT-EV's manager relay.
// - Telemetry is never on a request's path. A store that cannot open leaves
//   the store in degraded mode (writes are counted and dropped), a collector
//   failure is logged, and the entry keeps serving.
// - TELEMETRY_ENABLED=0 (or telemetry.enabled=false) runs nothing.
// - Docker is reached the way the managers reach it (DOCKER_WSL_DISTRO,
//   DOCKER_EXE), and only through `docker events`; telemetry never starts
//   Docker Desktop or a WSL distro.

const fs = require("node:fs");
const path = require("node:path");
const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const { createEventCollector, dockerEventSourceFromEnv } = require("../../manager-core/telemetry/collectors/events");
const { createGatewayRecorder } = require("../../manager-core/telemetry/recorder");
const { createGatewayLatencyWindow, createRuntimeCollector } = require("../../manager-core/telemetry/collectors/runtime");
const { redactSecrets } = require("../../manager-core/secret-redactor");
const { createAlertEngine, createManagerHealthSource, diskRootsFrom, readDiskFree } = require("../../manager-core/telemetry/alerts");
const { createNotifier } = require("../../manager-core/telemetry/notify");
const internalAuth = require("../../manager-core/internal-auth");
const { isLocalAddress, normalizeRemoteAddress } = require("../../manager-core/network");
const { AUDIT_ACTIONS, AUDIT_OUTCOMES } = require("../../manager-core/telemetry/audit-access-log");

const DEFAULT_DB_FILE = "telemetry.sqlite";
const STOP_FLUSH_MS = 2000;
// Live settings (§20 "live") are re-read at most this often, so a request
// never pays for a platform.json stat.
const LIVE_SETTINGS_TTL_MS = 5000;

// Manager -> entry ingest (04 §6.7, TEL-6).
const INTERNAL_PREFIX = "/internal/telemetry/";
const INGEST_KINDS = Object.freeze(["requests", "events", "audit-access"]);
const INGEST_MAX_BODY_BYTES = 1024 * 1024;
const INGEST_MAX_ROWS = 200;
const INGEST_FIELD_MAX = 512;
const INGEST_DETAIL_MAX = 4096;
const INGEST_CLOCK_SKEW_MS = 60 * 1000;
const DIRECT_REQUEST_ID_RE = /^mgr_[A-Za-z0-9._:-]{1,124}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const DEFAULT_INGEST_MANAGERS = Object.freeze([
  Object.freeze({ id: "vllm", billingId: "vllm-manager" }),
  Object.freeze({ id: "llama", billingId: "llama-manager" }),
]);

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
  // A relative path is under the platform root, not the process's cwd.
  const dbPath = configuredPath ? path.resolve(aiRoot || process.cwd(), configuredPath) : path.join(dataDir, DEFAULT_DB_FILE);
  const interval = Number(env.TELEMETRY_SAMPLE_INTERVAL_MS);
  const sampleIntervalMs = Number.isFinite(interval) && interval >= 5000 && interval <= 60_000
    ? Math.floor(interval)
    : Number.isFinite(section.sampleIntervalMs) ? section.sampleIntervalMs : 10_000;
  return {
    enabled,
    dbPath,
    sampleIntervalMs,
    keepJsonlAccessLog: section.keepJsonlAccessLog !== false,
    timezoneOffsetMinutes: Number.isFinite(section.timezoneOffsetMinutes) ? section.timezoneOffsetMinutes : null,
    maxDbMb: Number.isFinite(section.maxDbMb) ? section.maxDbMb : undefined,
    retention: isPlainObject(section.retention) ? { ...section.retention } : {},
  };
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
 * - getFleetCatalogs(): the entry's cached per-manager catalogs
 *   ({instances:[…]}, 00 §4.1); the RuntimeCollector runs when it is given.
 * - requestLatency({fleetId, model, fromMs, toMs}): gateway latency source for
 *   engines without histograms; by default a window over the recorded rows.
 * - docker: a docker event source ({precheck, open}), false to skip docker,
 *   or {spawn, execFile} for the default one built from the environment.
 * - alerts: false to run no alert engine; an object overrides its parts
 *   ({intervalMs, sources, fetch, lookup, sleep, consoleBase}). secretStore is
 *   the secret vault (get/has by namespace), getAudit() the entry's audit
 *   object ({scheduler}) and events the bus the notifier publishes on.
 * Returns { start(), stop(), recorder, handleHttp, handleInternal, status(),
 * recordConfigChange(section, change, extra) }.
 */
function createTelemetryRuntime(options = {}) {
  const env = options.env || process.env;
  const aiRoot = options.aiRoot ? path.resolve(options.aiRoot) : "";
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(__dirname, "..", "data");
  const log = normalizeLogger(options.logger);
  const openStore = typeof options.openStore === "function" ? options.openStore : openTelemetryStore;
  const configOption = () => (typeof options.config === "function" ? options.config() : options.config);
  const settings = resolveTelemetryConfig({ config: configOption(), env, aiRoot, dataDir });
  const now = typeof options.now === "function" ? options.now : Date.now;
  const getBillingStore = typeof options.getBillingStore === "function" ? options.getBillingStore : null;
  let live = { at: now(), settings };
  const managers = Array.isArray(options.managers) ? options.managers : [];
  const client = options.managerClient && typeof options.managerClient.get === "function" ? options.managerClient : null;

  let store = null;
  let events = null;
  let runtimeCollector = null;
  let alertEngine = null;
  let alertNotifier = null;
  let started = false;
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

  // Billing's cached credential → customer lookup (TEL-14, §5.3).
  function lookupCustomer(managerId, keyId) {
    if (!getBillingStore || !managerId || !keyId) return null;
    const billing = getBillingStore();
    return billing && typeof billing.lookupCustomerForCredential === "function"
      ? billing.lookupCustomerForCredential(managerId, keyId)
      : null;
  }

  // The recorder exists from creation and writes to whichever store is open;
  // with telemetry off there is none, so the gateway runs as it did before.
  const getFleetCatalogs = typeof options.getFleetCatalogs === "function" ? options.getFleetCatalogs : null;
  // Engines without latency histograms (llama.cpp) take TTFT and e2e from the
  // gateway rows the recorder finalises (04 §7.2 step 6).
  const latencyWindow = settings.enabled && getFleetCatalogs && typeof options.requestLatency !== "function"
    ? createGatewayLatencyWindow({ now })
    : null;
  const onRow = typeof options.onRow === "function" ? options.onRow : null;
  const recorder = settings.enabled
    ? createGatewayRecorder({
      store: () => store,
      lookupCustomer,
      onRow: latencyWindow
        ? (row, context) => {
          try {
            latencyWindow.add(row);
          } catch {
            // A latency window problem never reaches the response path.
          }
          return onRow ? onRow(row, context) : undefined;
        }
        : onRow,
      bufferMax: options.bufferMax,
      flushMs: options.flushMs,
      now,
      logger: options.logger === undefined ? console : options.logger,
    })
    : null;

  async function startCollectors() {
    try {
      store = await openStore({
        file: settings.dbPath,
        logger: options.logger === undefined ? console : options.logger,
        inProcess: options.inProcess === true,
        // The worker runs the rollup (30 s) and retention (1 h) jobs itself.
        jobs: {
          enabled: true,
          ttl: settings.retention,
          maxDbMb: settings.maxDbMb,
          timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
          sampleIntervalMs: settings.sampleIntervalMs,
          ...(isPlainObject(options.jobs) ? options.jobs : {}),
        },
      });
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
    startRuntimeCollector();
    startAlerts();
  }

  // The entry's cached instances (00 §4.1) as the RuntimeCollector reads them.
  async function listFleetInstances() {
    const catalogs = await getFleetCatalogs();
    const out = [];
    for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
      for (const instance of Array.isArray(catalog?.instances) ? catalog.instances : []) {
        const models = Array.isArray(instance.models) ? instance.models.map((model) => String(model?.id || model || "")).filter(Boolean) : [];
        out.push({
          fleetId: instance.fleetId || `${instance.managerId || catalog.manager?.id}:${instance.instanceId || instance.id}`,
          managerId: String(instance.managerId || catalog.manager?.id || ""),
          instanceId: String(instance.instanceId || instance.id || ""),
          engineId: instance.engineId || null,
          runtimeId: instance.runtimeId || null,
          launchId: instance.launchId || null,
          lifecycleState: instance.lifecycleState || instance.lifecycle?.state || "",
          external: instance.external === true || instance.engineId === "external",
          model: models[0] || "",
          models,
        });
      }
    }
    return out;
  }

  function startRuntimeCollector() {
    if (!getFleetCatalogs || !client) return;
    runtimeCollector = createRuntimeCollector({
      store,
      listFleetInstances,
      fetchInstanceMetrics: (instance, { timeoutMs }) => client.get(
        instance.managerId,
        `/api/instances/${encodeURIComponent(instance.instanceId)}/metrics`,
        { timeoutMs },
      ),
      fetchManagerStats: (managerId, { timeoutMs }) => client.get(managerId, "/api/stats", { timeoutMs }),
      requestLatency: typeof options.requestLatency === "function" ? options.requestLatency : latencyWindow ? latencyWindow.query : null,
      intervalMs: settings.sampleIntervalMs,
      now: options.now,
      timers: options.timers,
      logger: options.logger,
      events: options.events || null,
    });
    runtimeCollector.start();
  }

  // --- alerts (TEL-13) ---

  let secretVault;
  function vault() {
    if (options.secretStore) return options.secretStore;
    if (secretVault === undefined) {
      try {
        secretVault = require("../../manager-core/secret-store").createSecretVault({ aiRoot });
      } catch {
        secretVault = null;
      }
    }
    return secretVault;
  }

  // The vault is opened on the first webhook that needs a secret, so a
  // platform without webhooks never touches it.
  const lazySecrets = {
    async has(namespace, key) {
      const target = vault();
      if (!target) throw new Error("no secret store");
      return target.has(namespace, key);
    },
    async get(namespace, key) {
      const target = vault();
      if (!target) throw new Error("no secret store");
      return target.get(namespace, key);
    },
  };

  let webhookCache = { at: 0, list: [] };
  // telemetry.alerts.webhooks (04 section 13.3), live: re-read at most every 5 s.
  function liveWebhooks() {
    if (webhookCache.at && now() - webhookCache.at < LIVE_SETTINGS_TTL_MS) return webhookCache.list;
    const given = configOption();
    const section = isPlainObject(given) && Object.keys(given).length ? given : readTelemetrySection(aiRoot, env);
    const list = isPlainObject(section.alerts) && Array.isArray(section.alerts.webhooks) ? section.alerts.webhooks : [];
    webhookCache = { at: now(), list };
    return list;
  }

  // The legacy GPU guards (manager-core/gpu-guard.js) are warn-only settings
  // per manager. Their limits seed gpu_temp_high and gpu_power_cap once (04
  // section 13.2); the strictest enabled limit of the managers wins. null
  // means the settings could not be read, which does not use up the migration.
  function readGuardSettings() {
    if (!managers.length) return null;
    let normalize;
    try {
      normalize = require("../../manager-core/settings-stores").normalizeAutomationSettings;
    } catch {
      return null;
    }
    let tempLimitC = null;
    let powerLimitPct = null;
    for (const manager of managers) {
      if (!manager || !manager.root) continue;
      let raw = {};
      try {
        raw = JSON.parse(fs.readFileSync(path.join(manager.root, "logs", "automation-settings.json"), "utf8").replace(/^\uFEFF/, ""));
      } catch (error) {
        if (error && error.code !== "ENOENT") return null;
      }
      const settings = normalize(raw);
      if (settings.tempGuardEnabled) tempLimitC = tempLimitC === null ? settings.tempLimitC : Math.min(tempLimitC, settings.tempLimitC);
      if (settings.powerGuardEnabled) powerLimitPct = powerLimitPct === null ? settings.powerLimitPct : Math.min(powerLimitPct, settings.powerLimitPct);
    }
    return { tempGuardEnabled: tempLimitC !== null, tempLimitC, powerGuardEnabled: powerLimitPct !== null, powerLimitPct };
  }

  // instance.down: a ready, non-external instance with three failed scrapes in
  // a row (the RuntimeCollector's streak), or one whose lifecycle is crashed.
  async function alertInstances() {
    const list = await listFleetInstances();
    const fleets = runtimeCollector ? (runtimeCollector.status().fleets || {}) : {};
    return list
      .filter((instance) => !instance.external)
      .map((instance) => {
        const lifecycleState = String(instance.lifecycleState || "").toLowerCase();
        return {
          fleetId: instance.fleetId,
          lifecycleState,
          expectedReady: lifecycleState === "ready",
          failures: fleets[instance.fleetId] ? fleets[instance.fleetId].consecutiveFailures || 0 : 0,
        };
      });
  }

  // audit.export_failed and audit.chain_risk from the audit scheduler (TEL-16).
  async function alertAudit() {
    const audit = typeof options.getAudit === "function" ? options.getAudit() : null;
    const scheduler = audit && audit.scheduler;
    if (!scheduler || typeof scheduler.describe !== "function" || typeof scheduler.retention !== "function") return null;
    const [described, kept] = await Promise.all([scheduler.describe(), scheduler.retention()]);
    const exports = Array.isArray(kept.exports) ? kept.exports : [];
    const hasFull = exports.some((item) => !item.mode || item.mode === "full");
    let chainRisk = Boolean(kept.plan && kept.plan.needsRebaseline) || (exports.length > 0 && !hasFull);
    // With no export at all and no schedule there is no chain to protect yet.
    if (!exports.length) chainRisk = described.enabled ? true : null;
    return { exportFailed: Boolean(described.lastError), chainRisk };
  }

  function alertCollectors() {
    const out = [];
    const t = now();
    for (const [name, collector] of Object.entries(api.collectors)) {
      if (!collector || typeof collector.status !== "function") continue;
      const status = collector.status() || {};
      const lastOkAt = Number.isFinite(status.lastOkAt) ? status.lastOkAt : Number.isFinite(status.lastTickAt) ? status.lastTickAt : null;
      let ok = status.state === "ok" || status.state === "idle";
      // A collector that is still ticking is fresh even while one of its
      // sources is degraded (no Docker for the events collector, one manager
      // down for the runtime collector); manager.down covers that.
      if (name === "events") ok = status.state !== "stopped";
      else if (name === "runtime" && Number.isFinite(status.lastTickAt) && Number.isFinite(status.intervalMs)) ok = ok || t - status.lastTickAt < 3 * status.intervalMs;
      out.push({ name, ok, ...(lastOkAt !== null ? { lastOkAt } : {}) });
    }
    if (recorder) out.push({ name: "recorder", ok: Boolean(recorder.stats().running) });
    return out;
  }

  function startAlerts() {
    const extra = isPlainObject(options.alerts) ? options.alerts : {};
    if (options.alerts === false || !store || typeof store.call !== "function") return;
    alertNotifier = createNotifier({
      events: options.events || null,
      webhooks: liveWebhooks,
      secretStore: lazySecrets,
      fetch: extra.fetch,
      lookup: extra.lookup,
      sleep: extra.sleep,
      now: options.now,
      logger: options.logger,
      record: (event) => (store ? store.insertEvents([event]) : null),
      consoleBase: extra.consoleBase,
    });
    const health = client ? createManagerHealthSource({ managers, get: (managerId, target, getOptions) => client.get(managerId, target, getOptions) }) : null;
    const sources = {
      ...(getFleetCatalogs ? { instances: alertInstances } : {}),
      ...(health ? { managers: () => health.poll() } : {}),
      ...(aiRoot
        ? { disks: () => readDiskFree(diskRootsFrom({ aiRoot, storageFile: env.MODEL_STORAGE_FILE || path.join(dataDir, "model-storage.json") })) }
        : {}),
      audit: alertAudit,
      collectors: alertCollectors,
      recorder: () => (recorder ? recorder.stats() : null),
      ...(isPlainObject(extra.sources) ? extra.sources : {}),
    };
    alertEngine = createAlertEngine({
      store: () => store,
      notify: alertNotifier,
      now: options.now,
      intervalMs: extra.intervalMs,
      sources,
      readGuard: readGuardSettings,
      timers: options.timers,
      logger: options.logger,
    });
    alertEngine.start();
  }

  function start() {
    if (!settings.enabled) return Promise.resolve(api);
    if (!starting) {
      stopped = false;
      started = true;
      if (recorder) recorder.start();
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
    const runtime = runtimeCollector;
    runtimeCollector = null;
    const engine = alertEngine;
    const notifier = alertNotifier;
    alertEngine = null;
    alertNotifier = null;
    if (engine) await engine.stop().catch(() => {});
    if (notifier) await notifier.close().catch(() => {});
    if (runtime) await runtime.stop({ flushMs }).catch(() => {});
    if (collector) await collector.stop().catch(() => {});
    // In-flight records are finalised and written before the store closes.
    const deadline = now() + Math.max(0, Number(flushMs) || 0);
    let flushed = { timedOut: false };
    if (recorder) flushed = (await recorder.stop({ flushMs }).catch(() => null)) || flushed;
    const current = store;
    store = null;
    let closed = { timedOut: false };
    if (current) closed = (await current.close({ flushMs: Math.max(0, deadline - now()) }).catch(() => ({ timedOut: true }))) || closed;
    return { ok: true, timedOut: Boolean(flushed.timedOut || closed.timedOut) };
  }

  // telemetry.keepJsonlAccessLog (§6.5, live): the legacy gateway-access.log is
  // fed from recorded rows until P8 turns it off.
  function keepJsonlAccessLog() {
    if (now() - live.at >= LIVE_SETTINGS_TTL_MS) {
      live = { at: now(), settings: resolveTelemetryConfig({ config: configOption(), env, aiRoot, dataDir }) };
    }
    return live.settings.keepJsonlAccessLog !== false;
  }

  // createAuthFailureGuard({ onBan }) → a security.ban event (§9 source 6).
  // Dedupe on address and expiry makes a replay idempotent.
  function recordSecurityBan(ban = {}) {
    if (!store || stopped) return Promise.resolve(null);
    const until = String(ban.until || "");
    return Promise.resolve(store.insertEvents([{
      at: now(),
      source: "entry",
      type: "security.ban",
      severity: "warning",
      title: "Client address banned after repeated authentication failures",
      data: {
        ip: String(ban.ip || ""),
        ipMasked: String(ban.ipMasked || ""),
        until,
        failures: Number(ban.failures) || 0,
        i18nKey: "obs.event.securityBan",
      },
      dedupeKey: `security.ban:${String(ban.ip || "")}:${until}`,
    }])).catch(() => null);
  }

  // Config writers call this after a successful write; it never throws.
  function recordConfigChange(section, change, extra = {}) {
    try {
      return events ? events.recordConfigChange(section, change, extra) : null;
    } catch {
      return null;
    }
  }

  // ---- /internal/telemetry/* (04 §6.7, TEL-6) --------------------------------

  const ingestManagers = managers.length
    ? managers.map((manager) => ({ id: String(manager.id || ""), billingId: String(manager.billingId || manager.id || "") }))
    : DEFAULT_INGEST_MANAGERS;
  const sendIngestJson = typeof options.sendJson === "function"
    ? options.sendJson
    : (res, body, status = 200) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
      res.end(text);
    };

  function ingestError(res, status, code, message, extra = {}) {
    sendIngestJson(res, { ok: false, error: { code, message }, ...extra }, status);
    return true;
  }

  function clampText(value, max = INGEST_FIELD_MAX) {
    return typeof value === "string" ? value.slice(0, max) : value;
  }

  // The caller's `at` is kept (arrival order, original time) unless it is not a
  // plausible millisecond clock.
  function plausibleAt(value) {
    const at = Number(value);
    return Number.isFinite(at) && at > 0 && at <= now() + INGEST_CLOCK_SKEW_MS ? Math.round(at) : now();
  }

  function directRequestRow(raw, manager) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: { code: "invalid_row" } };
    const requestId = raw.requestId ?? raw.request_id;
    if (String(raw.ingress ?? "") !== "direct") return { error: { code: "invalid_value", field: "ingress" } };
    if (typeof requestId !== "string" || !DIRECT_REQUEST_ID_RE.test(requestId)) return { error: { code: "invalid_value", field: "request_id" } };
    const row = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "id" || key === "extra") continue;
      row[key] = clampText(value);
    }
    row.requestId = requestId;
    row.ingress = "direct";
    // The signed manager decides the manager id; the body cannot claim another.
    row.managerId = manager.id;
    delete row.manager_id;
    return { row };
  }

  function eventRow(raw, manager) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: { code: "invalid_row" } };
    if (typeof raw.type !== "string" || !EVENT_TYPE_RE.test(raw.type)) return { error: { code: "invalid_value", field: "type" } };
    const title = clampText(raw.title, 200);
    if (typeof title !== "string" || !title) return { error: { code: "missing_field", field: "title" } };
    let data = raw.data ?? null;
    if (data !== null && JSON.stringify(data).length > INGEST_DETAIL_MAX) data = null;
    return {
      row: {
        at: plausibleAt(raw.at),
        type: raw.type,
        severity: ["info", "warning", "critical"].includes(raw.severity) ? raw.severity : "info",
        source: manager.id,
        managerId: manager.id,
        title,
        data,
        dedupeKey: typeof raw.dedupeKey === "string" && raw.dedupeKey ? raw.dedupeKey.slice(0, 200) : null,
      },
    };
  }

  function auditRow(raw, manager) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: { code: "invalid_row" } };
    if (!AUDIT_ACTIONS.includes(raw.action)) return { error: { code: "invalid_value", field: "action" } };
    const outcome = raw.outcome === undefined ? "ok" : raw.outcome;
    if (!AUDIT_OUTCOMES.includes(outcome)) return { error: { code: "invalid_value", field: "outcome" } };
    let detail = raw.detail ?? null;
    if (detail !== null && JSON.stringify(detail).length > INGEST_DETAIL_MAX) detail = null;
    return {
      row: {
        at: plausibleAt(raw.at),
        source: manager.billingId,
        actor: "legacy-local",
        session: null,
        clientIp: clampText(raw.clientIp ?? raw.client_ip ?? null, 64) || null,
        userAgent: clampText(raw.userAgent ?? raw.user_agent ?? null, 256) || null,
        action: raw.action,
        target: clampText(raw.target ?? null, 256) || null,
        outcome,
        detail,
      },
    };
  }

  async function ingest(kind, rows, manager) {
    const result = { accepted: 0, duplicates: 0, errors: [] };
    const valid = [];
    const build = kind === "requests" ? directRequestRow : kind === "events" ? eventRow : auditRow;
    rows.forEach((raw, index) => {
      const built = build(raw, manager);
      if (built.error) result.errors.push({ index, ...built.error });
      else valid.push({ index, row: built.row });
    });
    if (!valid.length) return result;
    if (kind === "audit-access") {
      // One append at a time, in arrival order: each row's hash covers the one before.
      for (const entry of valid) {
        await store.appendAuditAccess(entry.row);
        result.accepted += 1;
      }
      return result;
    }
    const written = kind === "requests"
      ? await store.insertRequests(valid.map((entry) => entry.row))
      : await store.insertEvents(valid.map((entry) => entry.row));
    if (Number(written?.dropped) > 0 && !Number(written?.accepted) && !Number(written?.duplicates)) {
      throw Object.assign(new Error("telemetry store is not accepting writes"), { code: "telemetry_store_unavailable" });
    }
    result.accepted = Number(written?.accepted) || 0;
    result.duplicates = Number(written?.duplicates) || 0;
    for (const error of Array.isArray(written?.errors) ? written.errors : []) {
      const source = valid[Number(error.index)];
      result.errors.push({ index: source ? source.index : Number(error.index) || 0, code: String(error.code || "invalid_row"), ...(error.field ? { field: String(error.field) } : {}) });
    }
    return result;
  }

  async function handleInternal(req, res, url) {
    const pathname = String(url && url.pathname ? url.pathname : "");
    if (!pathname.startsWith(INTERNAL_PREFIX)) return false;
    const kind = pathname.slice(INTERNAL_PREFIX.length);
    if (!INGEST_KINDS.includes(kind)) {
      req.resume?.();
      return ingestError(res, 404, "not_found", "Not found.");
    }
    if (String(req.method || "").toUpperCase() !== "POST") {
      req.resume?.();
      return ingestError(res, 405, "method_not_allowed", "Use POST.");
    }
    const unauthorized = () => ingestError(res, 401, "telemetry_unauthorized", "Telemetry ingest authentication failed.");
    // A non-loopback socket is refused before its body is read.
    if (!isLocalAddress(normalizeRemoteAddress(req.socket?.remoteAddress || req.ip || ""))) {
      req.resume?.();
      return unauthorized();
    }
    let raw;
    try {
      raw = typeof options.readRequestBody === "function"
        ? await options.readRequestBody(req, INGEST_MAX_BODY_BYTES)
        : await readBoundedBody(req, INGEST_MAX_BODY_BYTES);
    } catch (error) {
      if (Number(error?.status) === 413) return ingestError(res, 413, "payload_too_large", "The ingest body is larger than 1 MiB.");
      return ingestError(res, 400, "invalid_request", "The request body could not be read.");
    }
    raw = raw || Buffer.alloc(0);
    const token = typeof options.getTrustToken === "function" ? options.getTrustToken() : "";
    const verified = internalAuth.verifyInternalRequest(req, raw, token, {
      pathname,
      pathPrefixes: [INTERNAL_PREFIX],
      allowedManagers: ingestManagers.map((manager) => manager.billingId),
      now: now(),
    });
    if (!verified.ok) return unauthorized();
    const manager = ingestManagers.find((item) => item.billingId === verified.managerId);
    if (!manager) return unauthorized();
    let body = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = null;
    }
    const rows = body && typeof body === "object" && !Array.isArray(body) ? body.rows : null;
    if (!Array.isArray(rows)) return ingestError(res, 400, "invalid_rows", "The body must be {\"rows\": [...]}.");
    if (rows.length > INGEST_MAX_ROWS) return ingestError(res, 413, "payload_too_large", `At most ${INGEST_MAX_ROWS} rows per call.`);
    // Telemetry off: the managers' rows are acknowledged and not kept, so a
    // manager does not grow a spool for an entry that records nothing.
    if (!settings.enabled) {
      sendIngestJson(res, { ok: true, accepted: 0, duplicates: 0, disabled: true }, 200);
      return true;
    }
    if (!store || stopped) return ingestError(res, 503, "telemetry_unavailable", "The telemetry store is not available.");
    let result;
    try {
      result = await ingest(kind, rows, manager);
    } catch {
      return ingestError(res, 503, "telemetry_unavailable", "The telemetry store is not available.");
    }
    if (result.errors.length) {
      return ingestError(res, 400, "invalid_rows", "Some rows were rejected; the valid ones were accepted.", {
        accepted: result.accepted,
        duplicates: result.duplicates,
        errors: result.errors.slice(0, 50),
      });
    }
    sendIngestJson(res, { ok: true, accepted: result.accepted, duplicates: result.duplicates }, 200);
    return true;
  }

  function status() {
    return {
      enabled: settings.enabled,
      started,
      stopped,
      recorder: recorder ? recorder.stats() : null,
      keepJsonlAccessLog: keepJsonlAccessLog(),
      store: store ? store.state : settings.enabled ? "stopped" : "disabled",
      lastError,
      collectors: {
        events: events ? events.status() : null,
        runtime: runtimeCollector ? runtimeCollector.status() : null,
      },
      alerts: alertEngine ? alertEngine.status() : null,
    };
  }

  const api = {
    start,
    stop,
    enabled: settings.enabled,
    // null with telemetry off: the gateway then runs without records.
    recorder,
    recordSecurityBan,
    keepJsonlAccessLog,
    // /api/telemetry/* (TEL-11) and /internal/telemetry/* (TEL-6).
    handleHttp: async () => false,
    handleInternal,
    status,
    recordConfigChange,
    get collectors() {
      return { events, runtime: runtimeCollector };
    },
    // The alert engine (TEL-13); null while telemetry or the store is off.
    get alerts() {
      return alertEngine;
    },
    get store() {
      return store;
    },
  };
  return api;
}

// Fallback when no readRequestBody is injected (tests).
async function readBoundedBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// Route module (07 section 2.7) for /internal/telemetry/*, mounted by one line in
// the entry's table (ADMIN listener only, before the /api guards). server.js
// puts the runtime on ctx.telemetry once it is started.
function mount(ctx = {}) {
  return {
    async handle(req, res, url) {
      if (!String(url?.pathname || "").startsWith(INTERNAL_PREFIX)) return false;
      const runtime = ctx.telemetry;
      if (runtime && typeof runtime.handleInternal === "function") return runtime.handleInternal(req, res, url);
      req.resume?.();
      const body = JSON.stringify({ ok: false, error: { code: "telemetry_unavailable", message: "Telemetry is not running." } });
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return true;
    },
  };
}

module.exports = {
  INTERNAL_PREFIX,
  mount,
  name: "telemetry-internal",
  buildTailFiles,
  createTelemetryRuntime,
  mcpAuditLogFile,
  resolveTelemetryConfig,
};
