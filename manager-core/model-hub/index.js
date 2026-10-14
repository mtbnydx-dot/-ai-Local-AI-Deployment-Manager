"use strict";

// Model hub (03): the one engine-agnostic download and library service. It
// runs inside service-entry (5176), because engine deploys restart the
// managers and a manager restart used to kill every download.
//
// createModelHub() only wires objects and touches no file. start() prepares
// the data directory (sweeping temp files a crash left), loads the settings
// and stamps downloads.json; stop() flushes everything and is what the
// entry's shutdown awaits. This is the HUB-1 skeleton: store, settings, the
// downloadsOwner flag and the status. Search, plan, queue, transfer, verify
// and library come with the later HUB packages and hang off the same object.

const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("../secret-redactor");
const { firstExisting, looksLikePath } = require("../file-utils");
const { createHubStore, hubWriterIsLive, HUB_FILES, STORE_SCHEMA_VERSION } = require("./store");
const hubSettings = require("./settings");
const { readHubConfig } = require("./config");
const hubErrors = require("./errors");
const { createLibrary } = require("./library");

const DEFAULT_AI_ROOT = path.resolve(__dirname, "..", "..");
// downloads.json is re-stamped this often while the hub runs; readers treat
// a stamp older than two minutes as a stopped hub (03 §8).
const HEARTBEAT_MS = 30 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The download CLIs in the managers' discovery order (03 §3.1): the
 * HF_CLI/MODELSCOPE_CLI override, then the download-cli, ai312 and ai311
 * venvs, then PATH.
 */
function discoverHubClis({ aiRoot = DEFAULT_AI_ROOT, env = process.env } = {}) {
  const venv = (...parts) => path.join(aiRoot, "venvs", ...parts);
  return {
    hfCli: firstExisting([
      env.HF_CLI,
      venv("download-cli", "Scripts", "hf.exe"),
      venv("ai312", "Scripts", "hf.exe"),
      venv("ai311", "Scripts", "hf.exe"),
      "hf",
      venv("ai312", "Scripts", "huggingface-cli.exe"),
      venv("ai311", "Scripts", "huggingface-cli.exe"),
      "huggingface-cli",
    ]),
    modelScopeCli: firstExisting([
      env.MODELSCOPE_CLI,
      venv("download-cli", "Scripts", "modelscope.exe"),
      venv("ai312", "Scripts", "modelscope.exe"),
      venv("ai311", "Scripts", "modelscope.exe"),
      "modelscope",
    ]),
  };
}

// path is the configured command; found is false for a missing file and
// null for a bare command name left to PATH. The version probe belongs to
// the transfer engine (HUB-5), so it stays null here.
function cliInfo(command) {
  const text = String(command || "");
  if (!text) return { path: null, found: false, version: null };
  return { path: text, found: looksLikePath(text) ? fs.existsSync(text) : null, version: null };
}

/**
 * createModelHub({ aiRoot, dataDir, hfHome, hfCli, modelScopeCli, secretStore,
 * events, managers, models, env, clock, logger, ... }) → Hub (03 §3.1).
 * modelStorage (with fsStore, fit, providers, libraryOptions) switches the
 * library registry on (HUB-8, 03 §9); without it hub.library is null. The
 * options the later packages consume (fetchImpl, getRuntimeLoad, getGpus,
 * getCompatibilityContext, spawnImpl, platform) are accepted and kept on the
 * options object until then.
 */
function createModelHub(options = {}) {
  const aiRoot = path.resolve(String(options.aiRoot || DEFAULT_AI_ROOT));
  const dataDir = path.resolve(String(options.dataDir || path.join(aiRoot, "service-entry", "data", "hub")));
  const env = options.env || process.env;
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const logger = options.logger || console;
  const heartbeatMs = Number(options.heartbeatMs) > 0 ? Number(options.heartbeatMs) : HEARTBEAT_MS;
  const store = options.store || createHubStore({ dataDir, clock });
  const settings = hubSettings.createSettingsService({ store, env });
  const hfHome = path.resolve(String(options.hfHome || path.join(aiRoot, "cache", "huggingface")));
  const hfCli = String(options.hfCli || "");
  const modelScopeCli = String(options.modelScopeCli || "");
  const secretStore = options.secretStore || null;
  const models = options.models || null;
  const library = options.modelStorage
    ? createLibrary({
      store,
      modelStorage: options.modelStorage,
      fsStore: options.fsStore || null,
      hfHome,
      fit: options.fit || null,
      models,
      providers: options.providers || null,
      events: options.events || null,
      getSettings: () => settings.get(),
      aiRoot,
      clock,
      logger,
      ...(isPlainObject(options.libraryOptions) ? options.libraryOptions : {}),
    })
    : null;
  const readConfig = typeof options.readConfig === "function" ? options.readConfig : () => readHubConfig(aiRoot, env);

  let state = "idle";
  let startPromise = null;
  let stopPromise = null;
  let startedAt = null;
  let startError = null;
  let heartbeat = null;
  let downloads = { schemaVersion: STORE_SCHEMA_VERSION, jobs: [] };
  let migrationSteps = [];
  let storeErrors = [];
  let transferErrors = { data: null, errors: [], freshness: null, source: "bundled" };

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the hub.
    }
  }

  function dataError(result, name, extra) {
    return { file: result.file, name, code: result.error.code, message: `${result.error.message}${extra ? ` ${extra}` : ""}` };
  }

  // The error taxonomy's data file (03 §6.3). A bad entry is dropped and
  // reported in status dataErrors; it never stops the hub.
  function loadTransferErrors() {
    const userDir = env.AI_REFERENCE_DATA_DIR || path.join(aiRoot, "config");
    try {
      transferErrors = hubErrors.loadTransferErrorData({ userDir, now: clock.now() });
    } catch (error) {
      transferErrors = { data: null, errors: [{ file: "", name: hubErrors.TRANSFER_ERRORS_FILE, code: "unreadable", message: "The error taxonomy data could not be loaded." }], freshness: null, source: "bundled" };
      warn(`model hub: transfer error data failed to load: ${error?.message || error}`);
    }
    if (transferErrors.errors.length) warn(`model hub: ${transferErrors.errors.length} entr${transferErrors.errors.length === 1 ? "y" : "ies"} in ${hubErrors.TRANSFER_ERRORS_FILE} were dropped (see status dataErrors).`);
    if (typeof options.registerStatusProvider === "function") {
      try {
        options.registerStatusProvider("hub-transfer-errors", () => ({
          ok: transferErrors.errors.length === 0,
          source: transferErrors.source,
          asOf: transferErrors.data?.asOf || "",
          stale: Boolean(transferErrors.freshness?.stale),
          errors: transferErrors.errors.map(({ code, message }) => ({ code, message })),
        }));
      } catch (error) {
        warn(`model hub: could not register the hub-transfer-errors status provider: ${error?.message || error}`);
      }
    }
  }

  async function doStart() {
    state = "starting";
    storeErrors = [];
    const swept = await store.init();
    if (swept.removedTemps.length) warn(`model hub: removed ${swept.removedTemps.length} temp file(s) an interrupted write left in the data directory.`);
    settings.load();
    loadTransferErrors();

    // The queue (HUB-7) owns the jobs; until then they are carried over as
    // they are. A corrupt ledger is kept aside, never overwritten.
    const current = store.readDownloads();
    if (current.error) {
      try {
        fs.copyFileSync(current.file, `${current.file}.corrupt`);
      } catch {
        // The original stays in place until the next write.
      }
      storeErrors.push(dataError(current, HUB_FILES.downloads, "It was copied to downloads.json.corrupt and the hub starts with an empty queue."));
      downloads = { schemaVersion: STORE_SCHEMA_VERSION, jobs: [] };
    } else {
      downloads = { schemaVersion: current.value.schemaVersion, jobs: current.value.jobs };
    }

    const migrations = store.read("migrations");
    if (migrations.error) storeErrors.push(dataError(migrations, HUB_FILES.migrations));
    migrationSteps = Array.isArray(migrations.value?.steps) ? migrations.value.steps.filter(isPlainObject) : [];

    await store.writeDownloads(downloads);
    if (library) {
      library.start();
      // The first scan runs in the background, so a large library never
      // delays the hub; GET /library shows the persisted registry meanwhile.
      if (settings.get().library?.rescanOnStart !== false) {
        library.rescan().catch((error) => warn(`model hub: the start scan failed: ${error?.message || error}`));
      }
    }
    heartbeat = setInterval(() => {
      if (state !== "running") return;
      store.writeDownloads(downloads).catch((error) => warn(`model hub: downloads.json heartbeat failed: ${error?.message || error}`));
    }, heartbeatMs);
    heartbeat.unref?.();
    startedAt = new Date(clock.now()).toISOString();
    state = "running";
  }

  function start() {
    if (startPromise) return startPromise;
    if (stopPromise) return Promise.resolve();
    startPromise = doStart().catch((error) => {
      state = "failed";
      startError = { code: String(error?.code || "hub_start_failed"), message: redactSecrets(String(error?.message || error)) };
      warn(`model hub: start failed: ${error?.message || error}`);
      throw error;
    });
    return startPromise;
  }

  // Idempotent; never rejects. Pending writes settle first, then
  // downloads.json is written synchronously so the stamp is on disk even if
  // the process exits right after.
  function stop({ reason = "shutdown" } = {}) {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      const wasRunning = state === "running";
      state = "stopping";
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      try {
        await library?.stop();
      } catch (error) {
        warn(`model hub: stopping the library failed (${reason}): ${error?.message || error}`);
      }
      try {
        await store.flush();
      } catch {
        // A failed write was already reported by its caller.
      }
      if (wasRunning) {
        try {
          store.writeDownloads(downloads, { sync: true });
        } catch (error) {
          warn(`model hub: final downloads.json write failed (${reason}): ${error?.message || error}`);
        }
      }
      state = "stopped";
    })();
    return stopPromise;
  }

  async function settled() {
    if (state === "starting" && startPromise) await startPromise.catch(() => {});
  }

  function migrationDone() {
    return migrationSteps.length > 0 && migrationSteps.every((step) => step.done === true);
  }

  // GET /api/hub/status (03 §13). Queue counts stay 0 until the queue lands
  // (HUB-7). The viewer copy drops cli paths, dataDir and dataErrors[].file.
  function status() {
    const config = readConfig();
    return {
      ok: true,
      state,
      owner: config.downloadsOwner,
      ownerSource: config.source,
      active: 0,
      queued: 0,
      waiting: 0,
      speedBps: 0,
      cli: { hf: cliInfo(hfCli), modelscope: cliInfo(modelScopeCli) },
      dataDir,
      dataErrors: [...storeErrors, ...settings.errors(), ...transferErrors.errors, ...(library ? library.errors() : [])],
      configErrors: Array.isArray(config.errors) ? config.errors : [],
      migration: { done: migrationDone() },
      features: { runAfter: false, rememberToken: Boolean(secretStore), models: Boolean(models) },
      startedAt,
      ...(startError ? { startError } : {}),
    };
  }

  return {
    dataDir,
    hfHome,
    start,
    stop,
    status,
    config: () => readConfig(),
    // The loaded error taxonomy data (null before start), for the transfer
    // engine's classifyTransferFailure/retryDecision calls.
    transferErrorData: () => transferErrors.data,
    settings: {
      async get() {
        await settled();
        return settings.get();
      },
      // A hub that is not running (not started yet, failed or stopping)
      // writes nothing.
      async update(patch) {
        await settled();
        if (state !== "running") return { ok: false, code: "hub_unavailable", message: "The model hub is not running." };
        return settings.update(patch);
      },
    },
    // The registry (03 §9), null until a modelStorage is given. Later
    // packages add checkUpdate, update, importCache, remove and cleanupResidue.
    library,
    // GET /api/hub/tasks/:id: library tasks (rescan, verify), in memory.
    tasks: { get: (id) => (library ? library.getTask(id) : null) },
    // 06 OPS-13's busy probe; the queue fills in downloads (HUB-7).
    busy: () => ({ downloads: 0, verifying: library ? library.activeVerifications() : 0 }),
    get state() {
      return state;
    },
  };
}

module.exports = {
  HEARTBEAT_MS,
  createModelHub,
  discoverHubClis,
  hubWriterIsLive,
  readHubConfig,
  HUB_SETTINGS_SCHEMA: hubSettings.HUB_SETTINGS_SCHEMA,
  defaultSettings: hubSettings.defaultSettings,
  fromLegacy: hubSettings.fromLegacy,
  toLegacy: hubSettings.toLegacy,
  validateSettings: hubSettings.validateSettings,
};
