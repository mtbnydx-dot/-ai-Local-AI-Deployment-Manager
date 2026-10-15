"use strict";

// Model hub (03): the one engine-agnostic download and library service. It
// runs inside service-entry (5176), because engine deploys restart the
// managers and a manager restart used to kill every download.
//
// createModelHub() only wires objects and touches no file. start() prepares
// the data directory (sweeping temp files a crash left), loads the settings
// and stamps downloads.json; stop() flushes everything and is what the
// entry's shutdown awaits. HUB-1 built the skeleton (store, settings, the
// downloadsOwner flag, the status); HUB-7 adds the persistent download queue
// (queue.js) with its transfer engine, progress monitor and verifier, and
// enqueue from a plan body. Search and plan come with HUB-10 and hang off the
// same object.

const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("../secret-redactor");
const { firstExisting, looksLikePath } = require("../file-utils");
const { createHubStore, hubWriterIsLive, HUB_FILES, STORE_SCHEMA_VERSION } = require("./store");
const hubSettings = require("./settings");
const { readHubConfig } = require("./config");
const hubErrors = require("./errors");
const { createLibrary } = require("./library");
const { createTokenVault } = require("./tokens");
const { createHubAuth } = require("./auth");
const { createSourceProbe } = require("./sources");
const { createProviders } = require("./providers");
const { createCliTransferEngine } = require("./transfer");
const { createTransferMonitor } = require("./progress");
const { createArtifactVerifier } = require("./verify");
const { createDownloadQueue } = require("./queue");
const { runHubMigration } = require("./migrate");
const { computeUsage, createDiskGuard, reserveBytes, runCleanup } = require("./disk");
const { REPO_RE } = require("./auth");
const { compileIncludePatterns, resolveSelection } = require("./selection");
const { badRequest, fromProviderError, isPlainObject, nonEmpty } = require("./hub-util");
const { createFitService } = require("./fit");
const { createDiscovery } = require("./search");
const { createPlanCache, createPlanner } = require("./plan");
const { createRunAfter, normalizeRunAfterRequest } = require("./run-after");

const DEFAULT_AI_ROOT = path.resolve(__dirname, "..", "..");
// downloads.json is re-stamped this often while the hub runs; readers treat
// a stamp older than two minutes as a stopped hub (03 §8).
const HEARTBEAT_MS = 30 * 1000;
// Temporary tokens no job needs any more are released at start and then this
// often (03 §12).
const TOKEN_SWEEP_MS = 60 * 60 * 1000;

const SOURCES_BY_NAMESPACE = Object.freeze({ huggingface: ["huggingface", "hf-mirror"], modelscope: ["modelscope"] });
const CREDENTIAL_MODES = Object.freeze(["cached-login", "none"]);
const XET_MODES = Object.freeze(["high-performance", "default", "off"]);
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

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
  // One provider registry for the hub: the library's update check and identify
  // (03 §9) use the same sources policy and caches as search and enqueue.
  const providers = options.providers || createProviders({ settings, fetchImpl: options.fetchImpl, clock });
  // 03 §10: the adapter over 02's core.models (and the bytes fallback while it is null).
  const fit = options.fit || createFitService({ models, getGpus: options.getGpus, getCompatibilityContext: options.getCompatibilityContext, clock, logger });
  const library = options.modelStorage
    ? createLibrary({
      store,
      modelStorage: options.modelStorage,
      fsStore: options.fsStore || null,
      hfHome,
      fit,
      models,
      providers,
      events: options.events || null,
      getSettings: () => settings.get(),
      aiRoot,
      clock,
      logger,
      // The library actions (03 §9.5) reach the queue, the drive and the
      // storage probe through these; they are only called after start.
      enqueue: (input, ctx) => enqueue(input, ctx),
      getJobs: () => queue.document().jobs,
      getBusyPaths: typeof options.getBusyPaths === "function" ? options.getBusyPaths : null,
      disk: { freeBytes: (target) => disk.freeBytes(target), reserveBytes: (free) => reserveBytes(free, settings.get()) },
      ...(isPlainObject(options.libraryOptions) ? options.libraryOptions : {}),
    })
    : null;
  // Temporary Hugging Face tokens (03 §12): memory-only unless the caller
  // asked to remember one and a secret store exists.
  const tokens = options.tokens || createTokenVault({ secretStore, clock, logger });
  const auth = createHubAuth({
    hfCli,
    hfHome,
    service: options.hfAuthService || null,
    providers,
    fetchImpl: options.fetchImpl,
    tokens,
    logger,
    ...(isPlainObject(options.hfAuthOptions) ? options.hfAuthOptions : {}),
  });
  const sources = createSourceProbe({ auth, fetchImpl: options.fetchImpl, clock, ...(isPlainObject(options.sourceProbeOptions) ? options.sourceProbeOptions : {}) });
  const tokenSweepMs = Number(options.tokenSweepMs) > 0 ? Number(options.tokenSweepMs) : TOKEN_SWEEP_MS;
  const readConfig = typeof options.readConfig === "function" ? options.readConfig : () => readHubConfig(aiRoot, env);
  const modelStorage = options.modelStorage || null;

  // The download queue (HUB-7, 03 §8) and what it drives: the CLI transfer
  // engine (03 §6), one progress monitor per attempt (§7.2) and the
  // completion pipeline (§7.4). Tests replace any of them.
  const disk = options.disk || createDiskGuard({ statfs: options.statfs });
  const engine = options.transferEngine || createCliTransferEngine({
    hfCli,
    modelScopeCli,
    hfHome,
    dataDir,
    spawnImpl: options.spawnImpl,
    platform: options.platform,
    tokens,
    modelStorage,
    env,
    clock,
  });
  const monitorFactory = typeof options.monitorFactory === "function"
    ? options.monitorFactory
    : (job, hooks) => createTransferMonitor(job, { hfHome, clock, settings: () => settings.get(), ...hooks });
  const verifier = options.verifier || createArtifactVerifier({ fsStore: options.fsStore || null, clock });
  // Download & Run (HUB-14, 03 §11): loopback plans and starts through the
  // hosting manager. Tests pass `runAfter: null` to switch it off or a fake.
  const runAfter = options.runAfter !== undefined
    ? options.runAfter
    : createRunAfter({ managers: options.managers, fetchImpl: options.fetchImpl, getEngines: options.getEngines, clock, logger });
  const queue = createDownloadQueue({
    store,
    engine,
    monitorFactory,
    verifier,
    library,
    settings: () => settings.get(),
    busySignal: typeof options.getRuntimeLoad === "function" ? options.getRuntimeLoad : null,
    disk,
    events: options.events || null,
    tokens,
    modelStorage,
    getBusyPaths: typeof options.getBusyPaths === "function" ? options.getBusyPaths : null,
    runAfter,
    errorData: () => transferErrors.data,
    clock,
    timers: options.timers,
    logger,
    ...(isPlainObject(options.queueOptions) ? options.queueOptions : {}),
  });

  // Search, repository detail and pasted links (03 §13.2, §13.3).
  const discovery = createDiscovery({ providers, fit, library, queue, auth, settings: () => settings.get(), clock, logger });

  let state = "idle";
  let startPromise = null;
  let stopPromise = null;
  let startedAt = null;
  let startError = null;
  let heartbeat = null;
  let tokenSweep = null;
  let downloads = { schemaVersion: STORE_SCHEMA_VERSION, jobs: [] };
  let migrationSteps = [];
  let storeErrors = [];
  let transferErrors = { data: null, errors: [], freshness: null, source: "bundled" };

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line), { secrets: tokens.values() }));
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

  // 03 §12: tokens of ready and cancelled jobs, of jobs that failed more than
  // seven days ago and of refs no job carries are released.
  async function sweepTokens() {
    try {
      return await tokens.sweep(downloads.jobs);
    } catch (error) {
      warn(`model hub: the token sweep failed: ${error?.message || error}`);
      return [];
    }
  }

  async function doStart() {
    state = "starting";
    storeErrors = [];
    const swept = await store.init();
    if (swept.removedTemps.length) warn(`model hub: removed ${swept.removedTemps.length} temp file(s) an interrupted write left in the data directory.`);
    settings.load();
    loadTransferErrors();

    // 03 §16: import the managers' settings and download ledgers once. It
    // runs before the queue takes downloads.json, and only while the hub owns
    // downloads (a rolled-back hub leaves the managers' controllers alone).
    // A failure is logged and retried on the next start; it never stops the
    // hub.
    if (options.aiRoot && options.migration !== false && readConfig().downloadsOwner === "hub") {
      try {
        const migrated = await runHubMigration({
          aiRoot,
          store,
          settings,
          modelStorage,
          library,
          logger,
          events: options.events || null,
          clock,
          errorData: transferErrors.data || undefined,
          ...(isPlainObject(options.migrationOptions) ? options.migrationOptions : {}),
        });
        migrationSteps = migrated.steps;
      } catch (error) {
        warn(`model hub: the migration from the managers failed: ${error?.message || error}`);
      }
    }

    // The queue owns the jobs. A corrupt ledger is kept aside, never
    // overwritten.
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
    queue.load(downloads);
    downloads = queue.document();

    const migrations = store.read("migrations");
    if (migrations.error) storeErrors.push(dataError(migrations, HUB_FILES.migrations));
    migrationSteps = Array.isArray(migrations.value?.steps) ? migrations.value.steps.filter(isPlainObject) : [];

    await store.writeDownloads(downloads);
    await sweepTokens();
    tokenSweep = setInterval(() => {
      if (state === "running") sweepTokens();
    }, tokenSweepMs);
    tokenSweep.unref?.();
    if (library) {
      library.start();
      // The first scan runs in the background, so a large library never
      // delays the hub; GET /library shows the persisted registry meanwhile.
      if (settings.get().library?.rescanOnStart !== false) {
        library.rescan().catch((error) => warn(`model hub: the start scan failed: ${error?.message || error}`));
      }
    }
    // Restart semantics (03 §8): orphans, interrupted jobs, auth waits,
    // retry timers and the delayed auto-resume.
    await queue.start();
    heartbeat = setInterval(() => {
      if (state !== "running") return;
      store.writeDownloads(queue.document()).catch((error) => warn(`model hub: downloads.json heartbeat failed: ${error?.message || error}`));
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
      if (tokenSweep) clearInterval(tokenSweep);
      tokenSweep = null;
      // In-process downloads become interrupted (autoResume) before the
      // final write below.
      try {
        await queue.stop({ reason });
      } catch (error) {
        warn(`model hub: stopping the download queue failed (${reason}): ${error?.message || error}`);
      }
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
          store.writeDownloads(queue.document(), { sync: true });
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

  function sourceEndpoint(source) {
    const sources = settings.get()?.sources || {};
    if (source === "hf-mirror") return String(sources.mirrorEndpoint || "https://hf-mirror.com");
    if (source === "modelscope") return String(sources.modelScopeEndpoint || "https://www.modelscope.cn");
    return String(sources.hfEndpoint || "https://huggingface.co");
  }

  /**
   * resolveRequest(input, ctx) → everything a plan body (03 §13.4) resolves
   * to, with no side effects: provider, repo, revision, the chosen source and
   * why, the fresh manifest, the resolved selection and its compiled include
   * patterns, the target from modelStorage.downloadTarget only (03 §17), the
   * credential mode and the transfer options. `ctx.credential` is what the
   * route made of credential.hfToken ({ tokenRef, remember }); the token
   * itself never reaches this function. enqueue and plan share it, so a plan
   * is exactly what the download will do.
   */
  async function resolveRequest(input, ctx = {}) {
    if (!modelStorage) throw new hubErrors.HubError("hub_unavailable", "The model storage registry is not available.", { status: 503 });
    const current = settings.get();
    const provider = input.provider === undefined || input.provider === null ? "huggingface" : String(input.provider);
    if (!["huggingface", "hf-mirror", "modelscope"].includes(provider)) throw badRequest("provider", "provider must be huggingface or modelscope.");
    const namespace = provider === "modelscope" ? "modelscope" : "huggingface";
    const repo = String(input.repo || "").trim();
    if (!REPO_RE.test(repo)) throw badRequest("repo", "repo must look like owner/name.");
    const revision = input.revision === undefined || input.revision === null || input.revision === "" ? "main" : String(input.revision);
    if (!REVISION_RE.test(revision)) throw badRequest("revision", "The revision is not valid.");
    if (input.selection !== undefined && input.selection !== null && !isPlainObject(input.selection)) throw badRequest("selection", "selection must be an object.");
    if (input.target !== undefined && input.target !== null && !isPlainObject(input.target)) throw badRequest("target", "target must be an object.");

    let source = input.source === undefined || input.source === null || input.source === "auto" ? "auto" : String(input.source);
    let sourceReason = source === "auto" ? "policy" : "explicit";
    if (source === "auto") {
      if (namespace === "modelscope") source = "modelscope";
      else source = provider === "hf-mirror" || current?.sources?.policy === "hf-mirror" ? "hf-mirror" : "huggingface";
    }
    if (!SOURCES_BY_NAMESPACE[namespace].includes(source)) throw badRequest("source", `source must be one of ${SOURCES_BY_NAMESPACE[namespace].join(", ")}.`);

    let manifest;
    let metadata;
    try {
      metadata = providers.forNamespace(namespace, source === "hf-mirror" ? "hf-mirror" : undefined);
      manifest = await metadata.getRepo(repo, { revision });
    } catch (error) {
      throw fromProviderError(error);
    }
    const notes = [];
    if (manifest?.gated && source === "hf-mirror" && current?.sources?.gatedUsesOfficial !== false) {
      source = "huggingface";
      sourceReason = "gated-official";
      notes.push("gated repository: downloading from the official endpoint");
    }
    const artifact = resolveSelection(manifest, input.selection || {});
    const include = compileIncludePatterns(artifact.files, manifest.files || []);

    const outputName = nonEmpty(input.target?.outputName) ? input.target.outputName.trim() : repo.replace("/", "-");
    let localDir;
    let root;
    try {
      localDir = modelStorage.downloadTarget(nonEmpty(input.target?.rootId) ? input.target.rootId : null, outputName);
      root = modelStorage.rootFor(localDir);
    } catch (error) {
      throw new hubErrors.HubError("invalid_target", String(error?.message || "The target folder is not usable."), { status: Number(error?.status) === 503 ? 503 : 400, details: { field: "target" } });
    }

    let credentialMode;
    let tokenRef = null;
    let remember = false;
    if (isPlainObject(ctx.credential) && nonEmpty(ctx.credential.tokenRef)) {
      if (source !== "huggingface") {
        throw new hubErrors.HubError("token_not_allowed_on_mirror", "Only the official Hugging Face endpoint receives a token.", { status: 422 });
      }
      credentialMode = "temp-token";
      tokenRef = ctx.credential.tokenRef;
      remember = Boolean(ctx.credential.remember);
    } else {
      const mode = input.credential?.mode;
      if (mode !== undefined && mode !== null && mode !== "auto" && !CREDENTIAL_MODES.includes(mode)) {
        throw badRequest("credential.mode", "credential.mode must be auto, cached-login or none (temp-token needs credential.hfToken).");
      }
      credentialMode = source === "huggingface" ? (mode === "none" ? "none" : "cached-login") : "none";
    }
    const xet = input.transfer?.xet === undefined || input.transfer?.xet === null ? (current?.transfer?.xet || "high-performance") : String(input.transfer.xet);
    if (!XET_MODES.includes(xet)) throw badRequest("transfer.xet", `transfer.xet must be one of ${XET_MODES.join(", ")}.`);
    const priority = input.priority === undefined || input.priority === null ? "normal" : String(input.priority);
    if (!["high", "normal", "low"].includes(priority)) throw badRequest("priority", "priority must be high, normal or low.");

    let volume = null;
    try {
      volume = disk.volumeOf(root?.path || localDir);
    } catch {
      volume = null;
    }
    return {
      provider, namespace, repo, revision, source, sourceReason, endpoint: sourceEndpoint(source), metadata, manifest, notes,
      artifact, include, outputName, localDir, root, volume, credentialMode, tokenRef, remember, xet, priority,
    };
  }

  // The plan cache and builder (03 §13.4); plans live 10 minutes.
  const plans = createPlanCache({ clock });
  const planner = createPlanner({ fit, disk, settings: () => settings.get(), queue, auth, discovery, runAfter, clock });

  /**
   * plan(input, ctx) → the 03 §13.4 body (without ok). No side effects: it
   * reads the manifest, the disk and the registry, and caches the plan under
   * a planId for 10 minutes. `ctx.credential` is { tokenRef, remember } from
   * a token the route put into the vault; the cached plan keeps the ref so a
   * download from the planId uses the same credential.
   */
  async function plan(input = {}, ctx = {}) {
    await settled();
    if (state !== "running") throw new hubErrors.HubError("hub_unavailable", "The model hub is not running.", { status: 503 });
    if (!isPlainObject(input)) throw badRequest("body", "The request body must be a plan object.");
    if (input.fit !== undefined && input.fit !== null && !isPlainObject(input.fit)) throw badRequest("fit", "fit must be an object.");
    checkRunAfter(input.runAfter);
    const resolved = await resolveRequest(input, ctx);
    const body = await planner.build(resolved, input, { withFit: true });
    const cached = plans.put({
      input: {
        provider: resolved.provider,
        repo: resolved.repo,
        revision: resolved.revision,
        selection: isPlainObject(input.selection) ? input.selection : {},
        target: { rootId: resolved.root?.id || null, outputName: resolved.outputName },
        source: resolved.source,
        transfer: { xet: resolved.xet },
        credential: { mode: resolved.credentialMode === "temp-token" ? "auto" : resolved.credentialMode },
        runAfter: checkRunAfter(input.runAfter),
        priority: resolved.priority,
      },
      credential: resolved.tokenRef ? { tokenRef: resolved.tokenRef, remember: resolved.remember } : null,
      revisionSha: resolved.manifest.revisionSha || null,
      localDir: resolved.localDir,
    });
    return { planId: cached.planId, expiresAt: cached.expiresAt, ...body };
  }

  // The runAfter request of a plan or a download: validated (400), and a hub
  // without Download & Run refuses it (422 run_after_unavailable).
  function checkRunAfter(value) {
    if (value === undefined || value === null) return null;
    const normalized = normalizeRunAfterRequest(value);
    if (!runAfter) throw new hubErrors.HubError("run_after_unavailable", "Download & Run is not available in this hub.", { status: 422, details: { reason: "not_configured" } });
    return normalized;
  }

  // enqueue from a cached plan: the target, the disk and the manifest SHA are
  // re-validated (03 §13.4), so a plan that no longer holds is refused
  // instead of silently downloading something else.
  async function resolvePlanRequest(input, ctx) {
    const entry = plans.get(String(input.planId).slice(0, 80));
    if (!entry) {
      throw new hubErrors.HubError("plan_not_found", "The plan is unknown or has expired; plan the download again.", { status: 404, details: { planId: String(input.planId).slice(0, 80) } });
    }
    const merged = {
      ...entry.input,
      allowDuplicate: input.allowDuplicate === true,
      ...(input.priority !== undefined && input.priority !== null ? { priority: input.priority } : {}),
      ...(input.runAfter !== undefined ? { runAfter: input.runAfter } : {}),
    };
    const credential = isPlainObject(ctx.credential) && nonEmpty(ctx.credential.tokenRef) ? ctx.credential : entry.credential;
    const resolved = await resolveRequest(merged, { ...ctx, credential });
    if ((resolved.manifest.revisionSha || null) !== entry.revisionSha || resolved.localDir !== entry.localDir) {
      plans.delete(entry.planId);
      throw new hubErrors.HubError("plan_changed", "The repository or the target changed since the plan; plan the download again.", {
        status: 409,
        details: { planId: entry.planId, revisionSha: resolved.manifest.revisionSha || null, plannedRevisionSha: entry.revisionSha },
      });
    }
    const revalidated = await planner.build(resolved, merged, { withFit: false });
    if (revalidated.blocking.length) {
      throw new hubErrors.HubError("plan_blocked", "The plan has blocking problems.", { status: 422, details: { blocking: revalidated.blocking } });
    }
    return { merged, resolved, planId: entry.planId };
  }

  /**
   * enqueue(input, ctx) → DownloadJob (03 §13 POST /downloads). `input` is a
   * planId (from plan()) or a plan body (03 §13.4): provider, repo, revision,
   * selection, target, source, transfer.xet, credential.mode, runAfter,
   * priority and allowDuplicate. `ctx` carries { origin, credential }, where
   * credential is what the route made of credential.hfToken ({ tokenRef,
   * remember }); the token itself never reaches this function. The manifest
   * is read fresh, the selection resolved and compiled, and the target comes
   * from modelStorage.downloadTarget only (03 §17).
   */
  async function enqueue(input = {}, ctx = {}) {
    await settled();
    if (state !== "running") throw new hubErrors.HubError("hub_unavailable", "The model hub is not running.", { status: 503 });
    if (readConfig().downloadsOwner === "manager") {
      throw new hubErrors.HubError("hub_disabled", "Downloads are handled by the managers (hub.downloadsOwner is \"manager\").", { status: 409 });
    }
    if (!isPlainObject(input)) throw badRequest("body", "The request body must be a plan object.");
    let request = input;
    let resolved;
    let planId = null;
    if (input.planId !== undefined && input.planId !== null) {
      ({ merged: request, resolved, planId } = await resolvePlanRequest(input, ctx));
    } else {
      resolved = await resolveRequest(input, ctx);
    }
    const { namespace, repo, revision, source, manifest, notes, artifact, include, outputName, localDir, root, volume, credentialMode, tokenRef, remember, xet, priority } = resolved;
    const origin = isPlainObject(ctx.origin) ? { ...ctx.origin } : { kind: "console" };
    const spec = {
      origin,
      ownerManagerId: origin.kind === "manager-shim" ? origin.managerId : null,
      priority,
      runAfter: checkRunAfter(request.runAfter),
      artifact: {
        provider: namespace,
        repo,
        revision,
        revisionSha: manifest.revisionSha || null,
        artifactKey: artifact.artifactKey,
        kind: artifact.kind,
        format: artifact.format,
        quant: artifact.quant ?? null,
        companions: artifact.companions || [],
        files: artifact.files.map((file) => ({
          path: file.path,
          size: Number(file.size) || 0,
          sha256: file.sha256 || null,
          ...(file.gitOid ? { gitOid: file.gitOid } : {}),
          role: file.role || "weight",
        })),
        totalBytes: artifact.totalBytes,
        ...(notes.length ? { notes } : {}),
      },
      target: { rootId: root?.id || null, rootLabel: root?.label || null, outputName, localDir, volume },
      transfer: {
        options: { source, endpoint: sourceEndpoint(source), xet: source === "modelscope" ? "default" : xet, credentialMode, tokenRef, remember },
        include,
      },
    };
    const job = await queue.enqueue(spec, { allowDuplicate: request.allowDuplicate === true, markerMetadata: ctx.markerMetadata || null });
    if (planId) plans.delete(planId);
    return job;
  }

  // GET /api/hub/status (03 §13). The viewer copy drops cli paths, dataDir
  // and dataErrors[].file.
  function status() {
    const config = readConfig();
    const counts = queue.counts();
    return {
      ok: true,
      state,
      owner: config.downloadsOwner,
      ownerSource: config.source,
      active: counts.active,
      queued: counts.queued,
      waiting: counts.waiting,
      speedBps: counts.speedBps,
      cli: { hf: cliInfo(hfCli), modelscope: cliInfo(modelScopeCli) },
      dataDir,
      dataErrors: [...storeErrors, ...settings.errors(), ...transferErrors.errors, ...(library ? library.errors() : [])],
      configErrors: Array.isArray(config.errors) ? config.errors : [],
      migration: { done: migrationDone() },
      features: { runAfter: Boolean(runAfter), rememberToken: Boolean(secretStore), models: Boolean(models) },
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
    // The temporary-token vault (03 §12). Routes put a token here and hand
    // the job only the tokenRef; the queue releases a ref when its job ends.
    tokens,
    sweepTokens,
    // 03 §12: login status, the local login window and the gated-access check
    // (first weight file). sources.probe is the informational speed probe.
    auth: { status: auth.status, login: auth.login, access: auth.access },
    sources: { probe: sources.probe },
    // The registry and its actions (03 §9): list, get, rescan, verify,
    // identify, checkUpdate, update, importCache, remove, cleanupResidue and
    // findByPath. Null until a modelStorage is given.
    library,
    // GET /api/hub/storage/usage and POST /api/hub/storage/cleanup (03 §13.5);
    // null without a model storage, like the library.
    storage: library && modelStorage
      ? {
        async usage(opts = {}) {
          await settled();
          return computeUsage({ modelStorage, library, queue, hfHome, settings: () => settings.get(), statfs: options.statfs, clock, refresh: opts.refresh === true });
        },
        async cleanup(input = {}) {
          await settled();
          return runCleanup({ library, queue, targets: input.targets, confirm: input.confirm });
        },
      }
      : null,
    // GET /api/hub/tasks/:id: library tasks (rescan, verify, import, delete), in memory.
    tasks: { get: (id) => (library ? library.getTask(id) : null) },
    // 03 §13.2-13.4: search, repository detail, the readme and file tree, pasted
    // links and the plan sheet. Search and detail are read-only and also work
    // while downloads belong to the managers.
    fit,
    search: async (query, ctx) => {
      await settled();
      return discovery.search(query, ctx);
    },
    getRepo: async (ref, opts) => {
      await settled();
      return discovery.getRepo(ref, opts);
    },
    getReadme: async (ref, opts) => {
      await settled();
      return discovery.getReadme(ref, opts);
    },
    listFiles: async (ref, opts) => {
      await settled();
      return discovery.listFiles(ref, opts);
    },
    resolveLink: (url) => discovery.resolveLink(url),
    plan,
    // POST /api/hub/downloads: a plan body or a planId (from plan()) becomes
    // a queued DownloadJob (03 §8, §13).
    enqueue,
    // The queue operations behind /api/hub/downloads/* (03 §13).
    jobs: {
      list: (query) => queue.list(query),
      get: (id) => queue.get(id),
      logs: (id, opts) => queue.logs(id, opts),
      history: (query) => queue.history(query),
      resumeCheck: (id) => queue.resumeCheck(id),
      pause: (id) => queue.pause(id),
      resume: (id, input = {}) => queue.resume(id, { ...input, sourceEndpoint }),
      retry: (id) => queue.retry(id),
      cancel: (id, input) => queue.cancel(id, input),
      setPriority: (id, priority) => queue.setPriority(id, priority),
      reorder: (ids) => queue.reorder(ids),
      startNow: (id, input) => queue.startNow(id, input),
      pauseAll: () => queue.pauseAll(),
      resumeAll: () => queue.resumeAll(),
      remove: (id) => queue.remove(id),
      // POST /downloads/:id/run { confirmReplace: true } (03 §11).
      confirmRunAfter: (id, input) => queue.confirmRunAfter(id, input),
      aggregate: () => queue.aggregate(),
      busyPaths: () => queue.busyPaths(),
    },
    queue,
    // 06 OPS-13's busy probe (blocker kind "download"): active transfers, and
    // verifications of the queue and of the library.
    busy: () => {
      const queueBusy = queue.busy();
      return { downloads: queueBusy.downloads, verifying: queueBusy.verifying + (library ? library.activeVerifications() : 0) };
    },
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
