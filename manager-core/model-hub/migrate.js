"use strict";

// Migration from the managers' download settings and ledgers (03 §16,
// HUB-12). Idempotent: every step is recorded in migrations.json and a rerun
// skips the steps that are done. The managers' own files are only read and
// copied, never edited; their 60-record cap evicts the imported records
// naturally.
//
//   settings-v1  hub settings absent → fromLegacy(llama ⊕ vllm), vLLM wins
//   ledgers-v1   every `type: "download"` job not yet imported (by legacyIds)
//                becomes a hub job
//   snapshot-v1  copies of both ledgers and settings files under migration/
//   library-v1   imported ready jobs are linked to library entries, then a
//                full rescan starts (the 03 §9.3 backfill)
//   notify-v1    one `notification` event
//
// runHubMigration runs before the queue loads downloads.json (the queue owns
// the file while it runs), so the entry calls it from the hub start-up.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const hubErrors = require("./errors");
const { newJobId } = require("./queue");
const { redactSecrets } = require("../secret-redactor");
const { fromLegacy } = require("./settings");

const MIGRATION_SCHEMA_VERSION = 1;
const STEP_IDS = Object.freeze(["settings-v1", "ledgers-v1", "snapshot-v1", "library-v1", "notify-v1"]);
const MANAGERS = Object.freeze([
  Object.freeze({ id: "vllm", dir: "vllm-manager" }),
  Object.freeze({ id: "llama", dir: "llama-manager" }),
]);
const LEDGER_NAME = "jobs-ledger";
const SETTINGS_NAME = "download-settings";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LOG_LINES = 50;
const WEIGHT_RE = /\.(?:gguf|safetensors|bin|pt|pth|ckpt)$/i;
const DEFAULT_ENDPOINTS = Object.freeze({
  huggingface: "https://huggingface.co",
  "hf-mirror": "https://hf-mirror.com",
  modelscope: "https://www.modelscope.cn",
});
const RUNNING_STATES = new Set(["running", "interrupted", "queued", "paused"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isBilingual(value) {
  return isPlainObject(value) && nonEmpty(value.zh) && nonEmpty(value.en);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function volumeOf(localDir) {
  const match = /^([A-Za-z]:)/.exec(String(localDir || ""));
  return match ? match[1].toUpperCase() : null;
}

// --- reading the managers' files (read-only) ----------------------------------

function readJsonFile(file) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) return { exists: true, value: null, error: "too large" };
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, value: null, error: null };
    return { exists: true, value: null, error: error?.code || "unreadable" };
  }
  try {
    return { exists: true, value: JSON.parse(stripBom(text)), error: null };
  } catch {
    return { exists: true, value: null, error: "corrupt" };
  }
}

function managerFiles(aiRoot, ledgerFiles, settingsFiles) {
  return MANAGERS.map((manager) => ({
    id: manager.id,
    ledger: ledgerFiles?.[manager.id] || path.join(aiRoot, manager.dir, "logs", `${LEDGER_NAME}.json`),
    settings: settingsFiles?.[manager.id] || path.join(aiRoot, manager.dir, "logs", `${SETTINGS_NAME}.json`),
  }));
}

// --- mapping one legacy job ----------------------------------------------------

function transferOptionsOf(meta, legacySettings, hubSettings) {
  const sources = isPlainObject(hubSettings?.sources) ? hubSettings.sources : {};
  const endpointOf = (source) => {
    if (source === "hf-mirror") return nonEmpty(sources.mirrorEndpoint) ? sources.mirrorEndpoint : DEFAULT_ENDPOINTS["hf-mirror"];
    if (source === "modelscope") return nonEmpty(sources.modelScopeEndpoint) ? sources.modelScopeEndpoint : DEFAULT_ENDPOINTS.modelscope;
    return nonEmpty(sources.hfEndpoint) ? sources.hfEndpoint : DEFAULT_ENDPOINTS.huggingface;
  };
  const modelScope = String(meta.source || "") === "modelscope";
  const recorded = isPlainObject(meta.transfer) ? meta.transfer : null;
  let source;
  let xetOn;
  let endpoint = null;
  let hadToken = false;
  if (recorded) {
    // 08 P0-DL-2: the flags recorded at enqueue.
    source = modelScope ? "modelscope" : recorded.hfMirror ? "hf-mirror" : "huggingface";
    xetOn = Boolean(recorded.hfTransfer);
    endpoint = source === "hf-mirror" && nonEmpty(recorded.hfEndpoint) ? recorded.hfEndpoint : null;
    hadToken = nonEmpty(recorded.tokenRef);
  } else {
    const gated = false;
    source = modelScope ? "modelscope" : legacySettings?.hfMirror && !gated ? "hf-mirror" : "huggingface";
    xetOn = Boolean(legacySettings?.hfTransfer);
  }
  return {
    source,
    endpoint: endpoint || endpointOf(source),
    xet: xetOn ? "high-performance" : "default",
    // A legacy tokenRef points into a manager's in-memory map and cannot be
    // recovered (03 §16): the job waits for a token on resume.
    credentialMode: hadToken ? "temp-token" : "cached-login",
    tokenRef: null,
    remember: false,
  };
}

function artifactOf(meta, localDir) {
  const repo = String(meta.model || "");
  const provider = String(meta.source || "") === "modelscope" ? "modelscope" : "huggingface";
  const manifest = Array.isArray(meta.fileManifest) ? meta.fileManifest : [];
  const files = [];
  for (const item of manifest) {
    if (!isPlainObject(item)) continue;
    const filePath = String(item.path || item.name || "").trim().replaceAll("\\", "/");
    if (!filePath || filePath.startsWith("/") || filePath.split("/").includes("..")) continue;
    const sha256 = /^[0-9a-f]{64}$/i.test(String(item.sha256 || "")) ? String(item.sha256).toLowerCase() : null;
    files.push({
      path: filePath,
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
      sha256,
      ...(sha256 ? {} : { gitOid: nonEmpty(item.gitOid) ? item.gitOid : null }),
      role: WEIGHT_RE.test(filePath) ? "weight" : "sidecar",
    });
  }
  const precision = nonEmpty(meta.precision) ? meta.precision : "";
  const weights = files.filter((file) => file.role === "weight");
  const format = weights.some((file) => /\.gguf$/i.test(file.path)) || /gguf/i.test(`${precision} ${repo}`)
    ? "gguf"
    : weights.length ? "safetensors" : "unknown";
  const totalBytes = files.length
    ? files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
    : Number(meta.expectedBytes) || 0;
  return {
    provider,
    repo,
    revision: "main",
    revisionSha: null,
    artifactKey: precision ? `${format === "gguf" ? "gguf" : "legacy"}:|${precision}` : "legacy:",
    kind: "legacy-import",
    format,
    quant: precision || null,
    companions: [],
    files,
    totalBytes,
    // Without a stored manifest the selection is rebuilt with
    // selectionFromLegacy on a fresh manifest when the job is resumed.
    ...(files.length ? {} : {
      manifestPending: true,
      legacySelection: { precision, includeExtras: Array.isArray(meta.includeExtras) ? meta.includeExtras.map(String) : [] },
    }),
  };
}

function errorOf(legacy, meta, logs, data) {
  const stored = nonEmpty(meta.errorCode) ? String(meta.errorCode) : "";
  const known = stored && hubErrors.isDownloadErrorCode(stored);
  let code;
  let description;
  if (known) {
    code = stored;
    description = hubErrors.describeHubError(code, data);
  } else {
    const classified = hubErrors.classifyDownloadFailure({
      text: logs.join("\n"),
      exitCode: Number.isInteger(legacy.exitCode) ? legacy.exitCode : null,
      meta,
    });
    code = classified.code;
    description = hubErrors.describeHubError(code, data);
  }
  const title = description.title;
  const hint = known && isBilingual(meta.errorHint) ? { zh: meta.errorHint.zh, en: meta.errorHint.en } : description.hint;
  const retryable = known && typeof meta.errorRetryable === "boolean" ? meta.errorRetryable : description.retryable;
  const original = nonEmpty(legacy.error) ? redactSecrets(String(legacy.error)).slice(0, 500) : "";
  return {
    code,
    baseCode: description.baseCode,
    class: description.class,
    retryable,
    title: { ...title },
    hint,
    actions: [...(description.actions || [])],
    ...(original ? { detail: original } : {}),
    at: legacy.finishedAt || legacy.updatedAt || legacy.createdAt || null,
  };
}

function isoOf(value, fallback) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

/**
 * mapLegacyJob(legacy, { managerId, legacySettings, hubSettings, modelStorage,
 * errorData, nowIso, id, queueOrder }) → hub DownloadJob | null (03 §16).
 * Pure apart from the storage lookups; null when the record is not a download
 * or has no usable target directory.
 */
function mapLegacyJob(legacy, options = {}) {
  if (!isPlainObject(legacy) || legacy.type !== "download" || !nonEmpty(String(legacy.id || ""))) return null;
  const meta = isPlainObject(legacy.meta) ? legacy.meta : {};
  if (!nonEmpty(meta.localDir) || !path.isAbsolute(meta.localDir)) return null;
  const modelStorage = options.modelStorage || null;
  let localDir = path.resolve(meta.localDir);
  if (modelStorage && typeof modelStorage.followAliases === "function") {
    try {
      localDir = path.resolve(modelStorage.followAliases(localDir));
    } catch {
      // The recorded path stays as it is.
    }
  }
  let root = null;
  if (modelStorage && typeof modelStorage.rootFor === "function") {
    try {
      root = modelStorage.rootFor(localDir);
    } catch {
      root = null;
    }
  }
  const at = options.nowIso || new Date().toISOString();
  const createdAt = isoOf(legacy.createdAt, at);
  const updatedAt = isoOf(legacy.updatedAt, createdAt);
  const status = String(legacy.status || "");
  const logs = (Array.isArray(legacy.logs) ? legacy.logs : []).map((line) => redactSecrets(String(line ?? ""))).filter(Boolean).slice(-LOG_LINES);
  const artifact = artifactOf(meta, localDir);
  const bytesTotal = artifact.totalBytes || Number(meta.expectedBytes) || 0;
  const percent = Math.max(0, Math.min(100, Number(legacy.progress?.percent) || 0));
  const bytesDone = status === "success"
    ? bytesTotal
    : Number.isFinite(Number(legacy.progress?.bytesDone)) ? Number(legacy.progress.bytesDone) : Math.round((percent / 100) * bytesTotal);

  let state;
  let pausedBy = null;
  let error = null;
  if (status === "success") state = "ready";
  else if (status === "cancelled") state = "cancelled";
  else if (status === "failed") {
    state = "failed";
    error = errorOf(legacy, meta, logs, options.errorData);
  } else {
    // running, interrupted, queued, paused and anything unknown: no automatic
    // restart after an upgrade (open decision O2).
    state = "paused";
    pausedBy = "migration";
  }
  const terminal = state === "ready" || state === "cancelled" || state === "failed";
  const finishedAt = terminal ? isoOf(legacy.finishedAt, updatedAt) : null;
  const startedAt = status === "queued" ? null : createdAt;
  const options_ = transferOptionsOf(meta, options.legacySettings, options.hubSettings);
  const retryMax = Number.isFinite(Number(options.legacySettings?.autoRetryCount)) ? Number(options.legacySettings.autoRetryCount) : 0;
  const ownerManagerId = options.managerId === "llama" || options.managerId === "vllm"
    ? options.managerId
    : artifact.format === "gguf" ? "llama" : "vllm";
  const lastLogAt = updatedAt;
  logs.push(state === "paused"
    ? "Imported from the manager ledger; paused until resumed."
    : "Imported from the manager ledger.");

  const job = {
    schemaVersion: 1,
    id: options.id || newJobId(),
    legacyIds: [String(legacy.id)],
    createdAt,
    updatedAt: state === "paused" ? at : updatedAt,
    startedAt,
    finishedAt,
    origin: { kind: "migration", managerId: ownerManagerId, requestId: null },
    ownerManagerId,
    state,
    waitReason: null,
    phaseHistory: [{ phase: state, at: finishedAt || at }],
    priority: ["high", "normal", "low"].includes(meta.priority) ? meta.priority : "normal",
    queueOrder: Number.isFinite(options.queueOrder) ? options.queueOrder : Date.parse(createdAt),
    pausedBy,
    autoResume: false,
    artifact,
    target: {
      rootId: root?.id || null,
      rootLabel: root?.label || null,
      outputName: nonEmpty(meta.outputName) ? meta.outputName : path.basename(localDir),
      localDir,
      volume: volumeOf(localDir),
    },
    transfer: {
      engine: "cli",
      cli: options_.source === "modelscope" ? "modelscope" : "hf",
      attempt: 0,
      batches: 1,
      batchIndex: 0,
      pid: null,
      pidStartedAt: null,
      options: options_,
      optionsHistory: [],
    },
    progress: {
      bytesDone,
      bytesTotal,
      percent: state === "ready" ? 100 : percent,
      speedBps: 0,
      speedEmaBps: 0,
      etaSeconds: null,
      filesDone: 0,
      filesTotal: artifact.files.length,
      files: [],
      verify: { filesDone: 0, filesTotal: 0, bytesDone: 0 },
      samples: [],
      lastGrowthAt: null,
      updatedAt: lastLogAt,
    },
    retry: { count: 0, max: Math.max(0, Math.floor(retryMax)), nextAt: null, history: [] },
    error,
    advice: null,
    runAfter: null,
    result: null,
    bypassIdleOnce: false,
    forceSlot: false,
    logs,
  };
  return job;
}

// --- the runner -------------------------------------------------------------

function stepRecord(steps, id) {
  return steps.find((step) => step.id === id) || null;
}

/**
 * runHubMigration({ aiRoot, store, settings, modelStorage, library, logger,
 * events, clock, ledgerFiles, settingsFiles, errorData }) →
 * { ran: [stepId], skipped: [stepId], failed: [{ id, message }], steps }
 *
 * Call it before the queue loads downloads.json. A failed step stays undone
 * and is retried on the next start; later steps that depend on it wait.
 */
async function runHubMigration(options = {}) {
  const { aiRoot, store, settings } = options;
  if (!aiRoot) throw new TypeError("runHubMigration needs an aiRoot");
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") throw new TypeError("runHubMigration needs the hub store");
  const library = options.library || null;
  const modelStorage = options.modelStorage || null;
  const events = options.events || null;
  const logger = options.logger || console;
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const nowIso = () => new Date(clock.now()).toISOString();
  const files = managerFiles(path.resolve(String(aiRoot)), options.ledgerFiles, options.settingsFiles);

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the migration.
    }
  }

  const existing = store.read("migrations");
  let steps = [];
  if (existing.error) {
    warn(`model hub: migrations.json is unusable (${existing.error.code}); the migration starts over.`);
  } else if (Array.isArray(existing.value?.steps)) {
    steps = existing.value.steps.filter((step) => isPlainObject(step) && STEP_IDS.includes(step.id)).map((step) => clone(step));
  }
  const result = { ran: [], skipped: [], failed: [], steps };

  async function save() {
    await store.write("migrations", { schemaVersion: MIGRATION_SCHEMA_VERSION, steps });
  }

  async function record(id, counts, error = null) {
    const entry = { id, done: !error, at: nowIso(), counts: counts || {}, ...(error ? { error: String(error) } : {}) };
    const index = steps.findIndex((step) => step.id === id);
    if (index >= 0) steps[index] = entry;
    else steps.push(entry);
    await save();
    return entry;
  }

  const handlers = {
    async "settings-v1"() {
      // Hub settings that were already written win; the legacy files only
      // seed a hub that never saved settings.
      const loaded = settings.load();
      if (loaded.exists) return { applied: false, reason: "hub-settings-exist" };
      const merged = {};
      let read = 0;
      // llama first, vLLM last: the vLLM file is the live one and wins.
      for (const manager of [...files].reverse()) {
        const file = readJsonFile(manager.settings);
        if (file.error) {
          warn(`model hub: the ${manager.id} ${SETTINGS_NAME}.json is ${file.error}; its settings are not imported.`);
          continue;
        }
        if (!isPlainObject(file.value)) continue;
        Object.assign(merged, file.value);
        read += 1;
      }
      if (!read) return { applied: false, reason: "no-legacy-settings", sources: 0 };
      const patch = fromLegacy(merged, { current: loaded.settings });
      const updated = await settings.update(patch);
      if (!updated.ok) throw new Error(`the legacy settings were rejected (${updated.code})`);
      return { applied: true, sources: read };
    },

    async "ledgers-v1"() {
      const current = store.readDownloads();
      if (current.error) throw new Error(`downloads.json is ${current.error.code}`);
      const doc = current.value;
      const known = new Set();
      for (const job of doc.jobs) for (const legacyId of Array.isArray(job.legacyIds) ? job.legacyIds : []) known.add(String(legacyId));
      try {
        for (const item of store.readHistory().records) for (const legacyId of Array.isArray(item.legacyIds) ? item.legacyIds : []) known.add(String(legacyId));
      } catch {
        // A history file that cannot be read cannot block the import.
      }
      const hubSettings = settings.get();
      const at = nowIso();
      const imported = [];
      const counts = { imported: 0, paused: 0, ready: 0, failed: 0, cancelled: 0, alreadyImported: 0, skipped: 0 };
      let order = clock.now() - 1_000_000;
      const unreadable = [];
      for (const manager of files) {
        const ledger = readJsonFile(manager.ledger);
        if (ledger.error) {
          unreadable.push(`${manager.id} ${LEDGER_NAME}.json is ${ledger.error}`);
          continue;
        }
        const legacySettingsFile = readJsonFile(manager.settings);
        const legacySettings = isPlainObject(legacySettingsFile.value) ? legacySettingsFile.value : null;
        const jobs = Array.isArray(ledger.value) ? ledger.value : Array.isArray(ledger.value?.jobs) ? ledger.value.jobs : [];
        const downloads = jobs
          .filter((job) => isPlainObject(job) && job.type === "download")
          .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
        for (const legacy of downloads) {
          if (known.has(String(legacy.id))) {
            counts.alreadyImported += 1;
            continue;
          }
          order += 1;
          const job = mapLegacyJob(legacy, {
            managerId: manager.id,
            legacySettings,
            hubSettings,
            modelStorage,
            errorData: options.errorData,
            nowIso: at,
            queueOrder: order,
          });
          if (!job) {
            counts.skipped += 1;
            continue;
          }
          known.add(String(legacy.id));
          imported.push(job);
          counts.imported += 1;
          if (job.state === "paused") counts.paused += 1;
          else counts[job.state] += 1;
        }
      }
      if (imported.length) await store.writeDownloads({ ...doc, jobs: [...doc.jobs, ...imported] });
      // A rerun after a partial import adds to the counts of the first run.
      const earlier = stepRecord(steps, "ledgers-v1")?.counts;
      if (earlier) for (const key of ["imported", "paused", "ready", "failed", "cancelled"]) counts[key] += Number(earlier[key]) || 0;
      if (unreadable.length) {
        const error = new Error(unreadable.join("; "));
        error.counts = counts;
        throw error;
      }
      return counts;
    },

    async "snapshot-v1"() {
      await fsp.mkdir(store.migrationDir, { recursive: true });
      const stamp = nowIso().replace(/[:]/g, "-");
      const copied = [];
      for (const manager of files) {
        for (const [name, file] of [[LEDGER_NAME, manager.ledger], [SETTINGS_NAME, manager.settings]]) {
          if (!fs.existsSync(file)) continue;
          const target = path.join(store.migrationDir, `${manager.id}-${name}.${stamp}.json`);
          try {
            // Never replaces a snapshot an earlier run took.
            await fsp.copyFile(file, target, fs.constants.COPYFILE_EXCL);
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            continue;
          }
          copied.push(path.basename(target));
        }
      }
      return { files: copied.length };
    },

    async "library-v1"() {
      if (!library) return { linked: 0, unlinked: 0, rescan: false, reason: "no-library" };
      const current = store.readDownloads();
      if (current.error) throw new Error(`downloads.json is ${current.error.code}`);
      const doc = current.value;
      library.start?.();
      let linked = 0;
      let unlinked = 0;
      let changed = false;
      for (const job of doc.jobs) {
        if (job.origin?.kind !== "migration" || job.state !== "ready" || job.result?.libraryEntryId) continue;
        let registered = null;
        try {
          registered = await library.registerFromJob(job);
        } catch (error) {
          warn(`model hub: linking an imported download to the library failed: ${error?.message || error}`);
        }
        if (registered?.entryId) {
          job.result = { libraryEntryId: registered.entryId, verifiedFiles: 0, skippedFiles: 0, verifySeconds: 0 };
          linked += 1;
          changed = true;
        } else {
          unlinked += 1;
        }
      }
      if (changed) await store.writeDownloads(doc);
      // The full rescan runs in the background; the registry is persisted by
      // the library itself when it finishes.
      let rescan = false;
      try {
        await library.rescan();
        rescan = true;
      } catch (error) {
        warn(`model hub: the migration rescan did not start: ${error?.message || error}`);
      }
      return { linked, unlinked, rescan };
    },

    async "notify-v1"() {
      const ledgers = stepRecord(steps, "ledgers-v1");
      const total = Number(ledgers?.counts?.imported) || 0;
      const paused = Number(ledgers?.counts?.paused) || 0;
      if (!total || !events || typeof events.publish !== "function") return { emitted: false, imported: total };
      events.publish("notification", {
        kind: "hub.migration.imported",
        severity: "info",
        title: { zh: "下载任务已导入", en: "Downloads imported" },
        body: {
          zh: `已从管理器导入 ${total} 个下载任务（${paused} 个已暂停）`,
          en: `Imported ${total} downloads from the managers (${paused} paused)`,
        },
      });
      return { emitted: true, imported: total, paused };
    },
  };

  let blocked = false;
  for (const id of STEP_IDS) {
    if (stepRecord(steps, id)?.done === true) {
      result.skipped.push(id);
      continue;
    }
    if (blocked && (id === "library-v1" || id === "notify-v1")) continue;
    try {
      const counts = await handlers[id]();
      await record(id, counts);
      result.ran.push(id);
    } catch (error) {
      const message = redactSecrets(String(error?.message || error));
      warn(`model hub: migration step ${id} failed: ${message}`);
      try {
        await record(id, error?.counts || {}, message);
      } catch {
        // The step stays undone.
      }
      result.failed.push({ id, message });
      // The library link and the notification need the imported jobs.
      if (id === "ledgers-v1") blocked = true;
    }
  }
  result.steps = steps;
  return result;
}

module.exports = {
  MIGRATION_SCHEMA_VERSION,
  STEP_IDS,
  mapLegacyJob,
  runHubMigration,
};
