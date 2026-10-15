"use strict";

// The per-manager callbacks 02 plugs into 01 (docs/overhaul/02-models.md §3.1,
// MOD-9b). managerHooks() returns all four at once and every one is a safe
// no-op until its package lands, so a manager wires them with one spread line:
//
//   modelFacts(model, { engineId, hostFacts, runtimeId })  PlanCtx.modelFacts (planFacts; MOD-9b)
//   calibrationFor(card, engineId, runtimeId, paramsKey)   PlanCtx.calibrationFor (null until MOD-10)
//   afterReady(args)                                       supervisor hooks.afterReady (no-op until MOD-10)
//   classifyFailure(logText, { engineId, phase })          supervisor hooks.classifyFailure (null until MOD-12)

const fs = require("node:fs");
const path = require("node:path");

const { planFacts } = require("./plan-facts");

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

/**
 * managerHooks({ managerId, dataDir, gpuStatus, modelStorage?, modelsRoot?, resolveModelPath?, inspectLocal? })
 *   → { modelFacts, calibrationFor, afterReady, classifyFailure }.
 * resolveModelPath(ref) maps the manager's model reference (container path,
 * storage-relative name) to a host path, or returns null for a ref that is not
 * on disk. dataDir and gpuStatus are for the calibration hooks of MOD-10.
 */
function managerHooks(options = {}) {
  const { inspectLocal = null } = options;
  const resolveModelPath = typeof options.resolveModelPath === "function" ? options.resolveModelPath : storageResolver(options);
  return {
    modelFacts: (model, factsOptions = {}) => planFacts(model, {
      ...factsOptions,
      ...(typeof resolveModelPath === "function" ? { resolveModelPath } : {}),
      ...(typeof inspectLocal === "function" ? { inspectLocal } : {}),
    }),
    calibrationFor: () => null,
    afterReady: async () => null,
    classifyFailure: () => null,
  };
}

module.exports = { managerHooks, storageResolver };
