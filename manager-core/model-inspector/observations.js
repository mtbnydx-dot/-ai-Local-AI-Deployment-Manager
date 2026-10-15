"use strict";

// Observations (docs/overhaul/02-models.md §10.6, MOD-10): turns what a ready
// launch measured into a calibration record. The engine-reported facts come
// from 01's logFacts (weightsGiB, kvGiB, kvTokens, maxConcurrency; llama.cpp
// modelBufferMiB{dev}, kvBufferMiB{dev}, computeBufferMiB{dev}; 01 §16.2) that
// the supervisor extracted while it read the logs for readiness. This module
// never reads or parses a log.
//
//   observationFromFacts(afterReadyArgs, { gpuUsedNowMb, estimate? }) → Observation
//     afterReadyArgs   the supervisor's hooks.afterReady context
//     gpuUsedNowMb     the larger of the post-ready samples of the launch's
//                      GPUs: a number (their sum) or { gpuId: usedMb }
//     estimate         { perGpuMb, breakdown, policy }; default plan.memory

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Numeric facts only: scalars and per-device maps of numbers. */
function sanitizeLogFacts(facts) {
  const out = {};
  for (const [id, value] of Object.entries(isPlainObject(facts) ? facts : {})) {
    if (isPlainObject(value)) {
      const map = {};
      for (const [device, amount] of Object.entries(value)) {
        const number = finiteOrNull(amount);
        if (number !== null) map[device] = number;
      }
      if (Object.keys(map).length) out[id] = map;
    } else {
      const number = typeof value === "number" ? finiteOrNull(value) : null;
      if (number !== null) out[id] = number;
    }
  }
  return out;
}

function sumOf(value) {
  if (isPlainObject(value)) {
    const numbers = Object.values(value).map(finiteOrNull).filter((item) => item !== null);
    return numbers.length ? numbers.reduce((sum, item) => sum + item, 0) : null;
  }
  return finiteOrNull(value);
}

function gpuKeysOf(plan, estimate) {
  const fromEstimate = Object.keys(isPlainObject(estimate?.perGpuMb) ? estimate.perGpuMb : {});
  if (fromEstimate.length) return fromEstimate;
  const ids = Array.isArray(plan?.gpuIds) ? plan.gpuIds : [];
  const keys = ids.map((id) => String(id?.index ?? id?.id ?? id)).filter(Boolean);
  return keys.length ? keys : ["0"];
}

function paramsKeyOf(args, engineId) {
  const given = text(args.paramsKey);
  if (given) return given;
  if (!isPlainObject(args.plan)) return null;
  // The one key builder is 01's; loaded lazily so this file has no load-time dependency on engines.
  const engines = require("../engines");
  return engines.paramsKey(args.plan, engineId);
}

function observationFromFacts(args = {}, { gpuUsedNowMb = null, estimate = null, now = null } = {}) {
  const plan = isPlainObject(args.plan) ? args.plan : null;
  const engineId = text(args.engineId) || text(plan?.engineId);
  const planEstimate = isPlainObject(estimate) ? estimate : isPlainObject(plan?.memory) ? plan.memory : {};
  const before = finiteOrNull(args.gpuUsedBeforeMb);
  const after = sumOf(gpuUsedNowMb);
  const delta = before !== null && after !== null ? Math.max(0, after - before) : null;

  // The supervisor's "before" is one number for the launch's GPUs, so the
  // growth is split evenly across them (tensor/pipeline shards are symmetric).
  const perGpuMb = {};
  if (delta !== null) {
    const keys = isPlainObject(gpuUsedNowMb) && Object.keys(gpuUsedNowMb).length ? Object.keys(gpuUsedNowMb) : gpuKeysOf(plan, planEstimate);
    for (const key of keys) perGpuMb[key] = Math.round((delta / keys.length) * 100) / 100;
  }

  return {
    contentDigest: text(args.contentDigest) || text(plan?.memory?.artifact?.contentDigest) || text(plan?.model?.contentDigest),
    engineId,
    runtimeId: text(args.runtimeId) || text(plan?.runtimeId) || text(plan?.runtime?.runtimeId),
    recipeId: text(plan?.recipe?.recipeId) || text(plan?.recipe?.id) || text(plan?.recipeId),
    paramsKey: paramsKeyOf(args, engineId),
    launchId: text(args.launchId),
    estimated: {
      perGpuMb: isPlainObject(planEstimate.perGpuMb) ? { ...planEstimate.perGpuMb } : {},
      breakdown: isPlainObject(planEstimate.breakdown) ? { ...planEstimate.breakdown } : {},
      policy: text(planEstimate.policy),
    },
    measured: {
      perGpuMb,
      gpuUsedDeltaMb: delta,
      logFacts: sanitizeLogFacts(args.logFacts),
    },
    at: now || new Date().toISOString(),
  };
}

module.exports = { observationFromFacts, sanitizeLogFacts };
