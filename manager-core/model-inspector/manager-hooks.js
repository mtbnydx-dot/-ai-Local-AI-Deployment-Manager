"use strict";

// The per-manager callbacks 02 plugs into 01 (docs/overhaul/02-models.md §3.1,
// MOD-9b). managerHooks() returns all four at once and every one is a safe
// no-op until its package lands, so a manager wires them with one spread line:
//
//   modelFacts(model, { engineId, hostFacts, runtimeId })  PlanCtx.modelFacts (planFacts; MOD-9b)
//   calibrationFor(card, engineId, runtimeId, paramsKey)   PlanCtx.calibrationFor (calibration store; MOD-10)
//   afterReady(args)                                       supervisor hooks.afterReady (records one observation; MOD-10)
//   classifyFailure(logText, { engineId, phase })          supervisor hooks.classifyFailure (null until MOD-12)

const fs = require("node:fs");
const path = require("node:path");

const { createCalibrationStore } = require("./calibration");
const { observationFromFacts } = require("./observations");
const { planFacts } = require("./plan-facts");

const CALIBRATION_FILE = "memory-calibration.json";
const DEFAULT_SAMPLE_GAP_MS = 10000;

/**
 * A resolveModelPath(ref) over a manager's model storage: a container path maps
 * back to the host, an absolute path must lie in a storage root, and a relative
 * name is looked up under modelsRoot. Null when the ref is not on disk.
 */
function storageResolver({ modelStorage = null, modelsRoot = null } = {}) {
  return (ref) => {
    try {
      const input = modelStorage && typeof modelStorage.fromContainerPath === "function" ? modelStorage.fromContainerPath(ref) : String(ref);
      if (path.isAbsolute(input)) {
        const resolved = modelStorage && typeof modelStorage.resolvePath === "function" ? modelStorage.resolvePath(input) : input;
        return fs.existsSync(resolved) ? resolved : null;
      }
      if (!modelsRoot) return null;
      const candidate = path.resolve(String(modelsRoot), input);
      const relative = path.relative(path.resolve(String(modelsRoot)), candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      return fs.existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The GPU ids a launch used, from its plan (gpuIds, gpus, or the memory.perGpuMb keys); [] means every GPU. */
function planGpuIds(plan) {
  const raw = Array.isArray(plan?.gpuIds) ? plan.gpuIds
    : Array.isArray(plan?.gpus) ? plan.gpus
      : Object.keys(isPlainObject(plan?.memory?.perGpuMb) ? plan.memory.perGpuMb : {});
  return raw.map((item) => String(item?.index ?? item?.id ?? item)).filter((item) => item && item !== "undefined");
}

/** One reading of the launch's GPUs: { total, byGpu: { id: usedMb } } or null. */
async function sampleGpus(gpuStatus, ids) {
  if (typeof gpuStatus !== "function") return null;
  const status = await gpuStatus();
  const gpus = Array.isArray(status?.gpus) ? status.gpus : [];
  const selected = ids.length ? gpus.filter((gpu) => ids.includes(String(gpu.id ?? gpu.index))) : gpus;
  const byGpu = {};
  for (const gpu of selected) {
    const used = Number(gpu.usedMb);
    if (Number.isFinite(used)) byGpu[String(gpu.id ?? gpu.index)] = used;
  }
  const values = Object.values(byGpu);
  return values.length ? { total: values.reduce((sum, value) => sum + value, 0), byGpu } : null;
}

/**
 * managerHooks({ managerId, dataDir, gpuStatus, modelStorage?, modelsRoot?, resolveModelPath?, inspectLocal? })
 *   → { modelFacts, calibrationFor, afterReady, classifyFailure }.
 * resolveModelPath(ref) maps the manager's model reference (container path,
 * storage-relative name) to a host path, or returns null for a ref that is not
 * on disk. dataDir holds memory-calibration.json and gpuStatus() → { gpus:[{id|index, usedMb}] }
 * is sampled by afterReady (sampleGapMs, sleep, log and calibrationStore are test seams).
 */
function managerHooks(options = {}) {
  const { inspectLocal = null } = options;
  const warned = new Set();
  const sink = typeof options.log === "function" ? options.log : (message) => console.warn(`[model-inspector] ${message}`);
  const warnOnce = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    sink(message);
  };
  // One calibration store per manager (<dataDir>/memory-calibration.json); none without a dataDir.
  const calibrationStore = options.calibrationStore
    || (options.dataDir ? createCalibrationStore({ file: path.join(String(options.dataDir), CALIBRATION_FILE), log: warnOnce }) : null);
  const sleep = typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sampleGapMs = Number.isFinite(Number(options.sampleGapMs)) && Number(options.sampleGapMs) >= 0 ? Number(options.sampleGapMs) : DEFAULT_SAMPLE_GAP_MS;
  const recorded = new Set();

  /**
   * supervisor hooks.afterReady (01 §14): samples the launch's GPU memory twice,
   * sampleGapMs apart, takes the larger reading, builds the observation from
   * the supervisor's logFacts (no log is read here) and appends it once per
   * launch. Any failure is logged once and swallowed: it never fails the job.
   */
  async function afterReady(args = {}) {
    try {
      if (!calibrationStore || !isPlainObject(args)) return null;
      const launchKey = args.launchId || null;
      if (launchKey && recorded.has(launchKey)) return null;
      const ids = planGpuIds(args.plan);
      let best = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0 && sampleGapMs > 0) await sleep(sampleGapMs);
        let reading = null;
        try {
          reading = await sampleGpus(options.gpuStatus, ids);
        } catch {
          reading = null;
        }
        if (reading && (!best || reading.total > best.total)) best = reading;
      }
      const observation = observationFromFacts(args, { gpuUsedNowMb: best ? best.byGpu : null });
      if (!observation.contentDigest || !observation.runtimeId || !observation.paramsKey) return null;
      if (launchKey) recorded.add(launchKey);
      return calibrationStore.record(observation);
    } catch (error) {
      warnOnce(`calibration afterReady failed (ignored): ${error?.message || error}`);
      return null;
    }
  }

  const resolveModelPath = typeof options.resolveModelPath === "function" ? options.resolveModelPath : storageResolver(options);
  return {
    modelFacts: (model, factsOptions = {}) => planFacts(model, {
      ...factsOptions,
      ...(typeof resolveModelPath === "function" ? { resolveModelPath } : {}),
      ...(typeof inspectLocal === "function" ? { inspectLocal } : {}),
    }),
    calibrationFor: (card, engineId, runtimeId, paramsKey) => {
      try {
        return calibrationStore ? calibrationStore.calibrationFor(card, engineId, runtimeId, paramsKey) : null;
      } catch (error) {
        warnOnce(`calibration lookup failed (ignored): ${error?.message || error}`);
        return null;
      }
    },
    afterReady,
    classifyFailure: () => null,
  };
}

module.exports = { managerHooks, storageResolver };
