"use strict";

// LaunchStore (docs/overhaul/01-engines.md §15): one record per launch, keyed
// by the launch id the container carries in its ai.manager.launch-id label.
// A record keeps the LaunchSpec (engine, runtime, recipe, model, instance and
// catalog values), what the launch resolved to (redacted argv, labels), the
// job and container it ran as, and a short history. It is what idle wake,
// relaunch and restore read instead of re-deriving a launch from labels.
//
// The file is <manager>/logs/launch-store.json, written atomically. It holds
// at most maxRecords records; a starting, running or sleeping record (a live
// container label or a sleep-ledger record points at it) is never evicted.
// Plaintext secrets are never stored: the API key is only a reference into
// the runtime secret store (spec.secrets.apiKeyRef), every write is passed
// through the secret redactor, and there is no calibrations key (02 owns the
// only calibration store, 00 §9.1).
//
// Containers started before launch ids existed are adopted (§15.1): the
// launch-id label first, then P0-RT-2's wake matching order over the recent
// launches (container name, model path, served name), then the job label's
// entry in the jobs ledger, and last a partial record rebuilt from labels,
// which is listed but never woken. Adopted ids are derived from the container,
// so adopting the same container twice gives the same record.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJsonFile } = require("../file-utils");
const { redactValue } = require("../secret-redactor");
const { normalizeRuntimeInstanceMode } = require("../runtime-instance-utils");
const { BASE32_ALPHABET } = require("../telemetry/ids");
const { LAUNCH_LABEL_KEYS, labelsFromFlags } = require("./adapters/_docker-segments");
const legacyAliases = require("./legacy-aliases");
const registryModule = require("./registry");

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_RECORDS = 300;
const MAX_HISTORY = 40;
const LAUNCH_ID_PATTERN = /^lch_[a-z2-7]{20}$/;
const SOURCES = new Set(["ui", "api", "profile", "wake", "relaunch", "restore", "migration", "adopted"]);
const STATUSES = new Set(["planned", "starting", "running", "failed", "stopped", "sleeping"]);
const EVENTS = new Set(["started", "ready", "failed", "stopped", "slept", "woken", "adopted"]);
// A record a live container or a sleep-ledger record refers to.
const PROTECTED_STATUSES = new Set(["starting", "running", "sleeping"]);
// Field names that hold a secret value rather than a reference to one.
const SECRET_FIELD = /(?:api[-_]?key|token|secret|password)$/i;
const LEGACY_LABELS = Object.freeze({
  job: "ai.manager.job",
  engine: "ai.manager.engine",
  model: "ai.manager.model",
  port: "ai.manager.port",
  gpuIds: "ai.manager.gpu-ids",
  maxModelLen: "ai.manager.max-model-len",
  maxNumSeqs: "ai.manager.max-num-seqs",
  instance: "ai.manager.instance",
  instanceMode: "ai.manager.instance-mode",
});

const LAUNCH_CONFIG_PARTIAL = Object.freeze({
  code: "launch_config_partial",
  message: "该实例缺少完整启动配置，无法自动唤醒 / Instance lacks a complete launch config; cannot auto-wake",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value, max = 500) {
  return value === undefined || value === null ? "" : String(value).trim().slice(0, max);
}

function base32(bytes, chars = 20) {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < chars) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return output;
}

function isLaunchId(value) {
  return typeof value === "string" && LAUNCH_ID_PATTERN.test(value);
}

// ---- P0-RT-2 wake matching (08 P0-1), shared with idle-unload.js ----------

function normalizePathKey(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

// Where a released instance ran. A record without one (written before wake
// kept placement) is treated as the primary replace slot, under the guard.
function normalizeWakePlacement(value) {
  if (!value || typeof value !== "object") return null;
  const mode = String(value.instanceMode || "").trim().toLowerCase();
  if (mode !== "replace" && mode !== "parallel") return null;
  return {
    instanceMode: mode,
    instanceId: String(value.instanceId || "").trim().slice(0, 64),
    containerName: String(value.containerName || "").trim().slice(0, 200),
  };
}

// The launch record keeps the host path while a running instance reports the
// container path, so toContainerPath maps one onto the other for matching.
function pathMatches(entryModel, instancePath, toContainerPath) {
  if (!entryModel || !instancePath) return false;
  let mapped = "";
  try {
    mapped = typeof toContainerPath === "function" ? toContainerPath(entryModel) : "";
  } catch {
    mapped = "";
  }
  return [entryModel, mapped].some((candidate) => candidate && normalizePathKey(candidate) === instancePath);
}

/**
 * P0's matching order over the recent launches: container name, then model
 * path, then served name. The primary slot is shared by every model ever
 * launched into it, so a container-name match must also agree on the served
 * name when one is known. -> the matching entry or null.
 */
function matchRecentLaunch(launches, instance = {}, { toContainerPath } = {}) {
  const list = (Array.isArray(launches) ? launches : []).filter((entry) => entry && entry.config && entry.config.model);
  const containerName = String(instance.containerName || "");
  const served = String(instance.model || "");
  const instancePath = normalizePathKey(instance.name);
  return (containerName && list.find((item) => item.containerName === containerName
    && (!served || item.name === served || item.config.name === served)))
    || (instancePath && list.find((item) => pathMatches(item.model, instancePath, toContainerPath)))
    || (served && list.find((item) => String(item.config.name || "") === served))
    || null;
}

/** The wake placement of a recent-launch entry (P0's placementFor). */
function recentLaunchPlacement(entry = {}, instance = {}) {
  if (entry.instanceMode) {
    return normalizeWakePlacement({
      instanceMode: entry.instanceMode,
      instanceId: entry.instanceId,
      containerName: entry.containerName,
    });
  }
  // Launch records written before placement was kept: use where the
  // instance is actually running.
  if (instance.instanceMode) {
    return normalizeWakePlacement({
      instanceMode: instance.instanceMode,
      instanceId: instance.instanceId || (instance.id && instance.id !== "primary" ? instance.id : ""),
      containerName: instance.containerName,
    });
  }
  return null;
}

// ---- Spec shaping -----------------------------------------------------------

function withoutSecretFields(value) {
  if (Array.isArray(value)) return value.map((item) => withoutSecretFields(item));
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "calibrations" || SECRET_FIELD.test(key)) continue;
    output[key] = withoutSecretFields(item);
  }
  return output;
}

function normalizeSpec(spec = {}) {
  const source = isPlainObject(spec) ? spec : {};
  const model = isPlainObject(source.model) ? source.model : {};
  const instance = isPlainObject(source.instance) ? source.instance : {};
  const secrets = isPlainObject(source.secrets) ? source.secrets : {};
  const port = Number(instance.port);
  const normalized = {
    engineId: text(source.engineId, 64) || "unknown",
    runtimeId: text(source.runtimeId, 200) || null,
    recipeId: text(source.recipeId, 200) || null,
    model: {
      ref: text(model.ref, 1000),
      servedName: text(model.servedName, 300),
      contentDigest: text(model.contentDigest, 100) || null,
    },
    instance: {
      mode: normalizeRuntimeInstanceMode(instance.mode),
      id: text(instance.id, 64),
      port: Number.isInteger(port) && port > 0 ? port : null,
      networkAccess: instance.networkAccess === "lan" ? "lan" : "local",
      gpuIds: (Array.isArray(instance.gpuIds) ? instance.gpuIds : []).map((id) => text(id, 16)).filter(Boolean),
    },
    values: withoutSecretFields(isPlainObject(source.values) ? clone(source.values) : {}),
    extraArgs: (Array.isArray(source.extraArgs) ? source.extraArgs : []).map((arg) => String(arg)),
    extraEnv: withoutSecretFields(isPlainObject(source.extraEnv) ? clone(source.extraEnv) : {}),
    secrets: { apiKeyRef: /^[A-Za-z0-9_-]{8,160}$/.test(text(secrets.apiKeyRef, 200)) ? text(secrets.apiKeyRef, 200) : "" },
  };
  // A legacy launch can name an image outside the manifest; /api/start takes it as runtimeImage.
  const runtimeImage = text(source.runtimeImage, 512);
  if (runtimeImage) normalized.runtimeImage = runtimeImage;
  return normalized;
}

function normalizeHistoryEntry(entry = {}, clock = Date.now) {
  const event = text(entry.event, 20);
  if (!EVENTS.has(event)) return null;
  const at = entry.at && Date.parse(entry.at) ? entry.at : new Date(clock()).toISOString();
  return { at, event, detail: text(entry.detail, 300) };
}

function normalizeRecord(value, clock = Date.now) {
  if (!isPlainObject(value) || !isLaunchId(value.launchId)) return null;
  const record = {
    launchId: value.launchId,
    managerId: text(value.managerId, 64),
    createdAt: value.createdAt && Date.parse(value.createdAt) ? value.createdAt : new Date(clock()).toISOString(),
    source: SOURCES.has(value.source) ? value.source : "api",
    status: STATUSES.has(value.status) ? value.status : "stopped",
    spec: normalizeSpec(value.spec),
    resolved: withoutSecretFields(isPlainObject(value.resolved) ? clone(value.resolved) : {}),
    jobId: text(value.jobId, 120),
    containerName: text(value.containerName, 200),
    history: (Array.isArray(value.history) ? value.history : [])
      .map((entry) => normalizeHistoryEntry(entry, clock))
      .filter(Boolean)
      .slice(-MAX_HISTORY),
  };
  if (value.partial === true) record.partial = true;
  return record;
}

function mergePatch(target, patch) {
  const output = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (key === "__proto__") continue;
    output[key] = isPlainObject(value) && isPlainObject(output[key]) && key !== "values"
      ? mergePatch(output[key], value)
      : clone(value);
  }
  return output;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// ---- Store ------------------------------------------------------------------

/**
 * createLaunchStore({ file, managerId, maxRecords = 300, clock = Date.now,
 *   random = crypto.randomBytes, registry?, normalizeConfig?, toContainerPath?,
 *   secretValues?, protectedLaunchIds?, writeJsonFile?, log? })
 *
 * normalizeConfig is the manager's normalizeLaunchConfig, so a config rebuilt
 * from a spec has the shape recent launches and sleep records always had.
 * secretValues lists the live runtime keys, which the redactor removes from
 * every write. Without a file the store lives in memory only.
 */
function createLaunchStore(options = {}) {
  const file = options.file ? path.resolve(String(options.file)) : "";
  const managerId = registryModule.normalizeManagerId(options.managerId) || text(options.managerId, 64);
  const maxRecords = Math.max(1, Math.floor(Number(options.maxRecords) || DEFAULT_MAX_RECORDS));
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const random = typeof options.random === "function" ? options.random : crypto.randomBytes;
  const writeJsonFile = typeof options.writeJsonFile === "function" ? options.writeJsonFile : atomicWriteJsonFile;
  const normalizeConfig = typeof options.normalizeConfig === "function" ? options.normalizeConfig : (config) => config;
  const defaultToContainerPath = typeof options.toContainerPath === "function" ? options.toContainerPath : (value) => value;
  const secretValues = typeof options.secretValues === "function" ? options.secretValues : () => [];
  const protectedLaunchIds = typeof options.protectedLaunchIds === "function" ? options.protectedLaunchIds : () => [];
  const log = typeof options.log === "function" ? options.log : () => {};
  let launches = null;
  // One-shot migration markers (01 §22), kept next to the records.
  let migrations = {};
  let writing = Promise.resolve();

  function registry() {
    return options.registry || registryModule.getEngineRegistry();
  }

  function nowIso() {
    return new Date(clock()).toISOString();
  }

  function load() {
    if (launches) return launches;
    launches = [];
    if (!file) return launches;
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") log(`launch store unreadable: ${error.message}`);
      return launches;
    }
    try {
      const parsed = JSON.parse(raw.replace(/^﻿/, ""));
      const seen = new Set();
      if (isPlainObject(parsed?.migrations)) migrations = clone(parsed.migrations);
      for (const item of Array.isArray(parsed?.launches) ? parsed.launches : []) {
        const record = normalizeRecord(item, clock);
        // A launch still starting when the manager went away never finished;
        // its container, if any, is found again through its label.
        if (record?.status === "starting") {
          record.status = "failed";
          record.history = [...record.history, { at: nowIso(), event: "failed", detail: "interrupted" }].slice(-MAX_HISTORY);
        }
        if (record && !seen.has(record.launchId)) {
          seen.add(record.launchId);
          launches.push(record);
        }
      }
    } catch (error) {
      log(`launch store is corrupt and starts empty: ${error.message}`);
    }
    return launches;
  }

  function find(launchId) {
    return isLaunchId(launchId) ? load().find((record) => record.launchId === launchId) || null : null;
  }

  // Oldest unprotected records go first; protected ones may exceed the cap.
  function evict() {
    const list = load();
    if (list.length <= maxRecords) return;
    let pinned;
    try {
      pinned = new Set(Array.from(protectedLaunchIds() || []));
    } catch {
      pinned = new Set();
    }
    for (let index = list.length - 1; index >= 0 && list.length > maxRecords; index -= 1) {
      const record = list[index];
      if (PROTECTED_STATUSES.has(record.status) || pinned.has(record.launchId)) continue;
      list.splice(index, 1);
    }
  }

  function snapshot() {
    let secrets = [];
    try {
      secrets = Array.from(secretValues() || []);
    } catch {
      secrets = [];
    }
    const body = { schemaVersion: SCHEMA_VERSION, launches: load() };
    if (Object.keys(migrations).length) body.migrations = migrations;
    return redactValue(body, { secrets });
  }

  // Writes are chained, and each one takes the state at the time it runs.
  function persist() {
    evict();
    if (!file) return writing;
    writing = writing
      .then(() => writeJsonFile(file, snapshot()))
      .catch((error) => log(`launch store write failed: ${error.message}`));
    return writing;
  }

  function newLaunchId() {
    return `lch_${base32(random(13))}`;
  }

  // Deterministic: the same container is always adopted under the same id.
  function adoptedLaunchId(instance = {}) {
    const labels = isPlainObject(instance.labels) ? instance.labels : {};
    const material = [
      "adopted", managerId, text(instance.containerName, 200), text(labels[LEGACY_LABELS.job], 120),
      text(labels[LEGACY_LABELS.model] || instance.model, 300),
    ].join("\n");
    return `lch_${base32(crypto.createHash("sha256").update(material, "utf8").digest())}`;
  }

  function engineFor(legacyEngine) {
    try {
      return registry().fromLegacy(legacyEngine, managerId) || "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * A flat legacy config (normalised run options, job.meta, a recent-launch
   * config) -> LaunchSpec. Secret params never enter values; the key itself
   * is only ever a reference.
   */
  function specFromLegacyConfig(config = {}, extra = {}) {
    const source = isPlainObject(config) ? config : {};
    const engineId = extra.engineId || engineFor(source.engine);
    let values = {};
    try {
      values = legacyAliases.legacyConfigToValues(source, engineId);
    } catch {
      values = {};
    }
    const placement = extra.placement || null;
    return normalizeSpec({
      engineId,
      runtimeId: extra.runtimeId,
      recipeId: extra.recipeId,
      model: { ref: source.model, servedName: source.name },
      instance: {
        mode: placement?.instanceMode || source.instanceMode,
        id: placement ? placement.instanceId : source.instanceId,
        port: source.port,
        networkAccess: source.networkAccess,
        gpuIds: source.gpuDeviceIds,
      },
      values,
      secrets: { apiKeyRef: extra.apiKeyRef ?? source.runtimeApiKeyRef },
      runtimeImage: source.runtimeImage,
    });
  }

  /**
   * LaunchSpec -> the flat legacy config the start handler, recent launches
   * and sleep records speak (valuesToLegacyConfig plus the request fields).
   */
  function configFromSpec(spec) {
    const normalized = normalizeSpec(spec);
    const reg = registry();
    if (!reg.has?.(normalized.engineId)) throw new Error(`unknown engine ${normalized.engineId}`);
    const base = {
      model: normalized.model.ref,
      engine: reg.toLegacy(normalized.engineId),
      name: normalized.model.servedName,
      ...(normalized.instance.port ? { port: normalized.instance.port } : {}),
      networkAccess: normalized.instance.networkAccess,
      gpuDeviceIds: normalized.instance.gpuIds,
      ...(normalized.runtimeImage ? { runtimeImage: normalized.runtimeImage } : {}),
    };
    return normalizeConfig({ ...base, ...legacyAliases.valuesToLegacyConfig(normalized.values, normalized.engineId) });
  }

  function placementFromRecord(record) {
    return normalizeWakePlacement({
      instanceMode: record.spec.instance.mode,
      instanceId: record.spec.instance.id,
      containerName: record.containerName,
    });
  }

  function create(spec, createOptions = {}) {
    const list = load();
    const launchId = isLaunchId(createOptions.launchId) && !find(createOptions.launchId)
      ? createOptions.launchId
      : newLaunchId();
    const record = normalizeRecord({
      launchId,
      managerId,
      createdAt: createOptions.createdAt || nowIso(),
      source: createOptions.source || "api",
      status: createOptions.status || "starting",
      spec,
      resolved: createOptions.resolved || {},
      jobId: createOptions.jobId,
      containerName: createOptions.containerName,
      history: [{ at: createOptions.createdAt || nowIso(), event: createOptions.event || "started", detail: createOptions.detail || "" }],
      partial: createOptions.partial === true,
    }, clock);
    list.unshift(record);
    persist();
    return clone(record);
  }

  function get(launchId) {
    return clone(find(launchId));
  }

  function list({ limit = 50, status } = {}) {
    const max = Math.max(1, Math.min(maxRecords, Math.floor(Number(limit) || 50)));
    return clone(load().filter((record) => !status || record.status === status).slice(0, max));
  }

  /** Shallow patch; spec and resolved merge one object level at a time (values replace). */
  function update(launchId, patch = {}) {
    const record = find(launchId);
    if (!record) return null;
    const merged = normalizeRecord({
      ...record,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.jobId !== undefined ? { jobId: patch.jobId } : {}),
      ...(patch.containerName !== undefined ? { containerName: patch.containerName } : {}),
      spec: patch.spec ? mergePatch(record.spec, patch.spec) : record.spec,
      resolved: patch.resolved ? mergePatch(record.resolved, patch.resolved) : record.resolved,
      partial: patch.partial !== undefined ? patch.partial === true : record.partial === true,
    }, clock);
    Object.keys(record).forEach((key) => delete record[key]);
    Object.assign(record, merged);
    persist();
    return clone(record);
  }

  function appendEvent(launchId, event = {}) {
    const record = find(launchId);
    const entry = normalizeHistoryEntry(typeof event === "string" ? { event } : event, clock);
    if (!record || !entry) return null;
    record.history = [...record.history, entry].slice(-MAX_HISTORY);
    persist();
    return clone(record);
  }

  /**
   * Status change plus its history event, in one write. A launch that becomes
   * running supersedes any other running record of the same container (a
   * replace launch removed that container), so stale records do not pile up.
   */
  function markStatus(launchId, status, { event, detail = "", patch = {} } = {}) {
    const record = find(launchId);
    if (!record || !STATUSES.has(status)) return null;
    const entry = event ? normalizeHistoryEntry({ event, detail }, clock) : null;
    if (entry) record.history = [...record.history, entry].slice(-MAX_HISTORY);
    const updated = update(launchId, { ...patch, status });
    if (status === "running" && updated?.containerName) {
      for (const other of load()) {
        if (other.launchId === launchId || other.containerName !== updated.containerName) continue;
        if (other.status !== "running" && other.status !== "starting") continue;
        other.status = "stopped";
        other.history = [...other.history, { at: nowIso(), event: "stopped", detail: `replaced by ${launchId}` }].slice(-MAX_HISTORY);
      }
      persist();
    }
    return updated;
  }

  // §15.1 steps 2-6 for an instance without a usable launch-id label.
  function matchForAdoption(instance = {}, { jobsLedgerLookup, recentLaunches, toContainerPath } = {}) {
    const labels = isPlainObject(instance.labels) ? instance.labels : {};
    const entry = matchRecentLaunch(recentLaunches, instance, { toContainerPath: toContainerPath || defaultToContainerPath });
    if (entry) {
      const placement = recentLaunchPlacement(entry, instance);
      return {
        via: "recent-launch",
        config: entry.config,
        placement,
        spec: specFromLegacyConfig(entry.config, { engineId: engineFor(entry.config.engine ?? labels[LEGACY_LABELS.engine]), placement }),
      };
    }
    const jobId = text(labels[LEGACY_LABELS.job], 120);
    let job = null;
    if (jobId && typeof jobsLedgerLookup === "function") {
      try {
        job = jobsLedgerLookup(jobId);
      } catch {
        job = null;
      }
    }
    const meta = isPlainObject(job?.meta) ? job.meta : (isPlainObject(job) && job.model ? job : null);
    if (meta && meta.model) {
      const placement = normalizeWakePlacement({
        instanceMode: meta.instanceMode || instance.instanceMode,
        instanceId: meta.instanceId,
        containerName: meta.containerName || instance.containerName,
      });
      const spec = specFromLegacyConfig(meta, { engineId: engineFor(meta.engine ?? labels[LEGACY_LABELS.engine]), placement });
      let config = null;
      try {
        config = configFromSpec(spec);
      } catch {
        config = null;
      }
      if (config) return { via: "jobs-ledger", jobId, config, placement, spec };
    }
    // Labels only: enough to list and stop the instance, never to wake it.
    const contextLength = positiveNumber(labels[LEGACY_LABELS.maxModelLen]);
    const concurrency = positiveNumber(labels[LEGACY_LABELS.maxNumSeqs]);
    return {
      via: "labels",
      partial: true,
      jobId,
      config: null,
      placement: null,
      spec: normalizeSpec({
        engineId: engineFor(labels[LEGACY_LABELS.engine] ?? instance.engine),
        model: { ref: "", servedName: labels[LEGACY_LABELS.model] || instance.model },
        instance: {
          mode: labels[LEGACY_LABELS.instanceMode] || instance.instanceMode,
          id: labels[LEGACY_LABELS.instance] || "",
          port: labels[LEGACY_LABELS.port],
          gpuIds: text(labels[LEGACY_LABELS.gpuIds], 200).split(",").filter(Boolean),
        },
        values: {
          ...(contextLength ? { contextLength } : {}),
          ...(concurrency ? { concurrency } : {}),
        },
      }),
    };
  }

  function labelledLaunchId(instance = {}) {
    const value = text(isPlainObject(instance.labels) ? instance.labels[LAUNCH_LABEL_KEYS.launchId] : "", 64);
    return isLaunchId(value) ? value : "";
  }

  function adoptMatched(instance, match) {
    const launchId = labelledLaunchId(instance) || adoptedLaunchId(instance);
    const existing = find(launchId);
    if (existing && (!existing.partial || match.partial)) return clone(existing);
    if (existing) {
      // A partial record whose launch has since been found becomes complete.
      return markStatus(launchId, existing.status, {
        event: "adopted",
        detail: match.via,
        patch: { spec: match.spec, partial: false, jobId: match.jobId || existing.jobId },
      });
    }
    return create(match.spec, {
      launchId,
      source: "adopted",
      status: instance.running === false ? "stopped" : "running",
      jobId: match.jobId || text(instance.labels?.[LEGACY_LABELS.job], 120),
      containerName: instance.containerName,
      partial: match.partial === true,
      event: "adopted",
      detail: match.via,
    });
  }

  /** Adopts a container started by older code (§15.1); no relabel, no restart. */
  function adopt(instance = {}, lookups = {}) {
    return adoptMatched(instance, matchForAdoption(instance, lookups));
  }

  /** The record of a running instance: its launch-id label, else adoption. */
  function resolveForInstance(instance = {}, lookups = {}) {
    const record = find(labelledLaunchId(instance));
    return record ? clone(record) : adopt(instance, lookups);
  }

  /**
   * The wake plan of an instance about to be released (§15.3): the launch-id
   * label first, then P0-RT-2's order (container name, model path, served
   * name), then the jobs-ledger label. -> { launchId, config, spec, placement },
   * or null for a partial record (launch_config_partial).
   */
  function findWakePlan(instance = {}, lookups = {}) {
    const record = find(labelledLaunchId(instance));
    if (record && !record.partial) {
      try {
        return { launchId: record.launchId, config: configFromSpec(record.spec), spec: clone(record.spec), placement: placementFromRecord(record) };
      } catch (error) {
        log(`launch ${record.launchId} cannot be rebuilt for wake: ${error.message}`);
      }
    }
    const match = matchForAdoption(instance, lookups);
    if (match.partial || !match.config) return null;
    let launchId = "";
    try {
      launchId = adoptMatched(instance, match)?.launchId || "";
    } catch (error) {
      log(`launch adoption failed: ${error.message}`);
    }
    return { launchId, config: match.config, spec: clone(match.spec), placement: match.placement };
  }

  /**
   * The legacy recent-launch view: launches that reached ready, newest first,
   * one per model and served name, in the recent-launches.json entry shape.
   */
  function toRecentLaunches(limit = 8) {
    const max = Math.max(1, Math.floor(Number(limit) || 8));
    const entries = [];
    const seen = new Set();
    for (const record of load()) {
      if (record.partial || !["running", "stopped", "sleeping"].includes(record.status)) continue;
      const ready = [...record.history].reverse().find((entry) => entry.event === "ready" || entry.event === "adopted");
      if (!ready && record.source !== "migration") continue;
      let config;
      try {
        config = configFromSpec(record.spec);
      } catch {
        continue;
      }
      const name = record.spec.model.servedName || String(config.name || "");
      const key = `${record.spec.model.ref}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        model: record.spec.model.ref,
        name,
        launchedAt: ready?.at || record.createdAt,
        ...(record.spec.instance.mode ? {
          containerName: record.containerName,
          instanceMode: record.spec.instance.mode,
          instanceId: record.spec.instance.id,
        } : {}),
        config,
      });
      if (entries.length >= max) break;
    }
    return entries;
  }

  // Deterministic: the same recent-launch entry always migrates to the same id.
  function migratedLaunchId(entry = {}) {
    const material = [
      "migration", managerId, text(entry.model || entry.config?.model, 300),
      text(entry.name || entry.config?.name, 200), text(entry.launchedAt, 40),
    ].join("\n");
    return `lch_${base32(crypto.createHash("sha256").update(material, "utf8").digest())}`;
  }

  /**
   * One-time import of recent-launches.json (01 §22): each entry becomes a
   * stopped record with source "migration", oldest first so the newest ends up
   * first. The marker is stored in the file, so the import runs once even
   * after the records are evicted. -> { imported, already }
   */
  function importRecentLaunches(entries = []) {
    load();
    if (migrations.recentLaunches) return { imported: 0, already: true };
    const list = (Array.isArray(entries) ? entries : []).filter((entry) => isPlainObject(entry) && isPlainObject(entry.config) && entry.config.model);
    let imported = 0;
    for (const entry of [...list].reverse()) {
      const launchId = migratedLaunchId(entry);
      if (find(launchId)) continue;
      const placement = entry.instanceMode
        ? { instanceMode: entry.instanceMode === "parallel" ? "parallel" : "replace", instanceId: text(entry.instanceId, 120) }
        : null;
      const launchedAt = entry.launchedAt && Date.parse(entry.launchedAt) ? entry.launchedAt : undefined;
      create(specFromLegacyConfig({ ...entry.config, name: entry.name || entry.config.name }, { placement }), {
        launchId,
        source: "migration",
        status: "stopped",
        event: "adopted",
        detail: "recent-launches migration",
        createdAt: launchedAt,
        containerName: entry.containerName,
      });
      imported += 1;
    }
    migrations = { ...migrations, recentLaunches: nowIso() };
    persist();
    return { imported, already: false };
  }

  // ---- Launch lifecycle, called by the managers' start path ----------------

  /**
   * A serve job is about to build its command: create (once per job) the
   * record from the normalised run options and stamp job.meta.launchId, which
   * the builder emits as the ai.manager.launch-id label. -> launchId
   */
  function beginLaunch(job, runOptions = {}, { source = "api" } = {}) {
    const existing = find(job?.meta?.launchId);
    if (existing) return existing.launchId;
    const record = create(specFromLegacyConfig(runOptions), {
      source,
      status: "starting",
      jobId: job?.id,
      containerName: runOptions.containerName,
    });
    if (job && isPlainObject(job.meta)) job.meta.launchId = record.launchId;
    else if (job) job.meta = { launchId: record.launchId };
    return record.launchId;
  }

  /** The built command: engine, runtime and recipe from its labels, and the redacted argv. */
  function recordCommand(launchId, runArgs = [], { redact } = {}) {
    if (!find(launchId)) return null;
    const labels = labelsFromFlags(runArgs);
    const argv = (Array.isArray(runArgs) ? runArgs : []).map(String);
    const spec = {};
    if (labels[LAUNCH_LABEL_KEYS.engineId]) spec.engineId = labels[LAUNCH_LABEL_KEYS.engineId];
    if (labels[LAUNCH_LABEL_KEYS.runtimeId]) spec.runtimeId = labels[LAUNCH_LABEL_KEYS.runtimeId];
    spec.recipeId = labels[LAUNCH_LABEL_KEYS.recipe] || null;
    return update(launchId, {
      spec,
      resolved: { argvRedacted: typeof redact === "function" ? redact(argv) : argv },
    });
  }

  function flush() {
    return writing;
  }

  return {
    file,
    managerId,
    create,
    get,
    list,
    update,
    appendEvent,
    markStatus,
    resolveForInstance,
    findWakePlan,
    adopt,
    toRecentLaunches,
    importRecentLaunches,
    beginLaunch,
    recordCommand,
    specFromLegacyConfig,
    configFromSpec,
    flush,
  };
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  LAUNCH_CONFIG_PARTIAL,
  LAUNCH_ID_PATTERN,
  SCHEMA_VERSION,
  createLaunchStore,
  isLaunchId,
  matchRecentLaunch,
  normalizePathKey,
  normalizeWakePlacement,
  recentLaunchPlacement,
};
