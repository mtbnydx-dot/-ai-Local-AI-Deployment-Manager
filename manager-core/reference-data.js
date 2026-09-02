"use strict";

// Reference tables that go stale on their own schedule -- third-party model
// pricing and relative GPU throughput -- used to be literals in server.js with
// a hand-written "as of" date and no way to update them short of editing code.
//
// They now live in manager-core/data/*.json, and a user copy under
// <AI_ROOT>/config/ overrides the bundled one. Both carry an asOf date, so the
// UI can say "this comparison is based on prices from N months ago" instead of
// presenting stale numbers as current.

const fs = require("node:fs");
const path = require("node:path");

const BUNDLED_DIR = path.join(__dirname, "data");
const DAY_MS = 24 * 60 * 60 * 1000;

function userDataDir() {
  const root = process.env.AI_ROOT || path.dirname(__dirname);
  return process.env.AI_REFERENCE_DATA_DIR || path.join(root, "config");
}

function readJsonIfPresent(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!String(text).trim()) return { ok: false, value: null, error: "file is empty" };
    return { ok: true, value: JSON.parse(text), error: "" };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, value: null, error: "" };
    return { ok: false, value: null, error: error.message };
  }
}

function ageInDays(asOf, now = Date.now()) {
  const parsed = Date.parse(String(asOf || ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / DAY_MS));
}

function describeFreshness(data, now = Date.now()) {
  const days = ageInDays(data?.asOf, now);
  const staleAfterDays = Number(data?.staleAfterDays || 0);
  const stale = days !== null && staleAfterDays > 0 && days > staleAfterDays;
  return {
    asOf: data?.asOf || "",
    ageDays: days,
    staleAfterDays: staleAfterDays || null,
    stale,
    // Rendered directly by the stats view so the caveat travels with the number.
    notice: stale
      ? `参考数据来自 ${data.asOf}（${days} 天前），已超过建议更新周期 ${staleAfterDays} 天，成本对比仅供粗略参考。`
      : "",
  };
}

function loadReferenceFile(name, now = Date.now()) {
  const bundledPath = path.join(BUNDLED_DIR, name);
  const userPath = path.join(userDataDir(), name);
  const bundled = readJsonIfPresent(bundledPath);
  const user = readJsonIfPresent(userPath);
  const value = user.ok ? user.value : bundled.value;
  return {
    name,
    ok: Boolean(value),
    value: value || null,
    source: user.ok ? "user" : "bundled",
    bundledPath,
    userPath,
    // A user file that exists but does not parse must be reported rather than
    // silently ignored, otherwise an edit that breaks JSON looks like a no-op.
    error: user.error || (user.ok ? "" : bundled.error),
    freshness: describeFreshness(value, now),
  };
}

let pricingCache = null;
let gpuCache = null;

function loadModelPricing(options = {}) {
  if (pricingCache && !options.force) return pricingCache;
  const loaded = loadReferenceFile("model-pricing.json", options.now);
  const data = loaded.value || {};
  pricingCache = {
    ...loaded,
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
    unit: data.unit || "USD per 1M tokens",
    sources: Array.isArray(data.sources) ? data.sources : [],
  };
  return pricingCache;
}

function loadGpuPerformance(options = {}) {
  if (gpuCache && !options.force) return gpuCache;
  const loaded = loadReferenceFile("gpu-performance.json", options.now);
  const data = loaded.value || {};
  gpuCache = {
    ...loaded,
    defaultFactor: Number(data.defaultFactor ?? 1) || 1,
    factors: Array.isArray(data.factors) ? data.factors : [],
    notes: data.notes || "",
  };
  return gpuCache;
}

function clearReferenceDataCache() {
  pricingCache = null;
  gpuCache = null;
}

// Shape the browser consumes; keeps the matching rules on the server so the
// table can be updated without shipping new frontend code.
function buildReferenceDataPayload(options = {}) {
  const pricing = loadModelPricing(options);
  const gpu = loadGpuPerformance(options);
  return {
    ok: true,
    pricing: {
      asOf: pricing.value?.asOf || "",
      unit: pricing.unit,
      sources: pricing.sources,
      profiles: pricing.profiles,
      source: pricing.source,
      userPath: pricing.userPath,
      freshness: pricing.freshness,
      error: pricing.error,
    },
    gpuPerformance: {
      asOf: gpu.value?.asOf || "",
      defaultFactor: gpu.defaultFactor,
      factors: gpu.factors,
      notes: gpu.notes,
      source: gpu.source,
      userPath: gpu.userPath,
      freshness: gpu.freshness,
      error: gpu.error,
    },
  };
}

function registerReferenceDataRoutes(app, options = {}) {
  app.get(options.route || "/api/reference-data", (req, res) => {
    res.json(buildReferenceDataPayload({ force: options.alwaysReload === true }));
  });
}

module.exports = {
  BUNDLED_DIR,
  ageInDays,
  describeFreshness,
  loadReferenceFile,
  loadModelPricing,
  loadGpuPerformance,
  clearReferenceDataCache,
  buildReferenceDataPayload,
  registerReferenceDataRoutes,
  userDataDir,
};
