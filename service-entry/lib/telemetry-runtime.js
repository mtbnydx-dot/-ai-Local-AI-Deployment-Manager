"use strict";

// The entry's telemetry runtime (docs/overhaul/04-telemetry.md §3, §6, §20).
//
// createTelemetryRuntime({ aiRoot, dataDir, managers, auth, getBillingStore,
//   events, getFleetCatalogs, docker, execFile, config, secretStore })
//   → { start(), stop(), recorder, handleHttp(req, res, url) → bool,
//       handleInternal(req, res, url) → bool, status(), recordEvent(event),
//       recordSecurityBan(ban), keepJsonlAccessLog() }
//
// It owns the TelemetryStore (a worker thread over node:sqlite) and the
// GatewayRecorder. Settings come from readSection("telemetry") (06 OPS-3,
// env > platform.json > default); `config` may replace that read with a
// function or a plain values object (tests). With telemetry.enabled false
// (TELEMETRY_ENABLED=0) there is no store and `recorder` is null, so the
// gateway runs exactly as it did before telemetry existed.
//
// The store opens in start(); a store that cannot open leaves telemetry in
// degraded mode (writes discarded and counted) and never stops the entry.
// stop() finalises in-flight records, flushes (2 s cap) and closes the store.
// handleHttp and handleInternal answer nothing yet: the query routes (TEL-11)
// and the manager ingest (TEL-6) mount here later.

const path = require("node:path");
const core = require("../../manager-core");
const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const { createGatewayRecorder } = require("../../manager-core/telemetry/recorder");

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  dbPath: "",
  sampleIntervalMs: 10_000,
  timezoneOffsetMinutes: null,
  keepJsonlAccessLog: true,
  maxDbMb: 2048,
  retention: Object.freeze({}),
});
// Live settings (§20 "live") are re-read at most this often, so a request
// never pays for a platform.json stat.
const LIVE_SETTINGS_TTL_MS = 5000;
const DEFAULT_STOP_FLUSH_MS = 2000;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createTelemetryRuntime(options = {}) {
  const aiRoot = options.aiRoot ? path.resolve(options.aiRoot) : path.resolve(__dirname, "..", "..");
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : path.join(aiRoot, "service-entry", "data");
  const env = options.env || process.env;
  const logger = options.logger === undefined ? console : options.logger;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const getBillingStore = typeof options.getBillingStore === "function" ? options.getBillingStore : null;

  function readSettings() {
    let values = {};
    try {
      if (typeof options.config === "function") values = plainObject(options.config());
      else if (options.config && typeof options.config === "object") values = options.config;
      else values = plainObject(core.platform.readSection("telemetry", { aiRoot, env }).values);
    } catch (error) {
      warn(`telemetry settings could not be read; using defaults: ${error && error.message}`);
      values = {};
    }
    return { ...DEFAULT_SETTINGS, ...values, retention: { ...plainObject(values.retention) } };
  }

  function warn(message) {
    if (!logger) return;
    const method = typeof logger.warn === "function" ? logger.warn : logger.log;
    if (typeof method === "function") method.call(logger, core.redactSecrets(`service-entry: ${message}`));
  }

  const settings = readSettings();
  const enabled = settings.enabled !== false;
  let live = { at: now(), settings };
  let store = null;
  let started = false;
  let stopped = false;

  function liveSettings() {
    if (now() - live.at >= LIVE_SETTINGS_TTL_MS) live = { at: now(), settings: readSettings() };
    return live.settings;
  }

  function databaseFile() {
    const configured = String(settings.dbPath || "").trim();
    if (!configured) return path.join(dataDir, "telemetry.sqlite");
    return path.isAbsolute(configured) ? configured : path.resolve(aiRoot, configured);
  }

  // Billing's cached credential → customer lookup (TEL-14, §5.3).
  function lookupCustomer(managerId, keyId) {
    if (!getBillingStore || !managerId || !keyId) return null;
    const billing = getBillingStore();
    return billing && typeof billing.lookupCustomerForCredential === "function"
      ? billing.lookupCustomerForCredential(managerId, keyId)
      : null;
  }

  const recorder = enabled
    ? createGatewayRecorder({
      store: () => store,
      lookupCustomer,
      onRow: typeof options.onRow === "function" ? options.onRow : null,
      bufferMax: options.bufferMax,
      flushMs: options.flushMs,
      now,
      logger,
    })
    : null;

  async function start() {
    if (!enabled || started || stopped) return status();
    started = true;
    try {
      store = await openTelemetryStore({
        file: databaseFile(),
        inProcess: options.inProcess === true,
        logger,
        // The worker runs the rollup (30 s) and retention (1 h) jobs itself.
        jobs: {
          enabled: true,
          ttl: settings.retention,
          maxDbMb: settings.maxDbMb,
          timezoneOffsetMinutes: settings.timezoneOffsetMinutes ?? null,
          sampleIntervalMs: settings.sampleIntervalMs,
          ...plainObject(options.jobs),
        },
      });
    } catch (error) {
      store = null;
      warn(`telemetry store could not be opened; requests are not recorded: ${error && error.message}`);
    }
    recorder.start();
    return status();
  }

  async function stop({ flushMs = DEFAULT_STOP_FLUSH_MS } = {}) {
    if (stopped) return { ok: true };
    stopped = true;
    if (!enabled) return { ok: true };
    const deadline = now() + Math.max(0, Number(flushMs) || 0);
    const flushed = await recorder.stop({ flushMs });
    const remaining = Math.max(0, deadline - now());
    let closed = { ok: true, timedOut: false };
    if (store) closed = await store.close({ flushMs: remaining }).catch(() => ({ ok: false, timedOut: true }));
    return { ok: true, timedOut: Boolean(flushed.timedOut || closed.timedOut) };
  }

  // One event row (§4.2 events). Until TEL-9's EventCollector exists the
  // entry writes the few events it produces itself through here.
  function recordEvent(event) {
    if (!store || stopped || !event || typeof event !== "object") return Promise.resolve(null);
    return store.insertEvents([{ at: now(), source: "entry", ...event }]).catch(() => null);
  }

  // createAuthFailureGuard({ onBan }) → security.ban (§9 source 6).
  function recordSecurityBan(ban = {}) {
    const until = String(ban.until || "");
    return recordEvent({
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
    });
  }

  function status() {
    return {
      enabled,
      started,
      stopped,
      store: !enabled ? "disabled" : store ? store.state : started ? "unavailable" : "not_started",
      recorder: recorder ? recorder.stats() : null,
      keepJsonlAccessLog: keepJsonlAccessLog(),
    };
  }

  // telemetry.keepJsonlAccessLog (§6.5): the legacy gateway-access.log is fed
  // from recorded rows until P8 turns it off.
  function keepJsonlAccessLog() {
    return liveSettings().keepJsonlAccessLog !== false;
  }

  return {
    enabled,
    recorder,
    start,
    stop,
    status,
    recordEvent,
    recordSecurityBan,
    keepJsonlAccessLog,
    handleHttp: async () => false,
    handleInternal: async () => false,
    get store() {
      return store;
    },
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  createTelemetryRuntime,
};
