"use strict";

function normalizeRuntimeInstanceMode(value) {
  return String(value || "replace").toLowerCase() === "parallel" ? "parallel" : "replace";
}

function normalizeRuntimeInstanceId(value, fallback = "model") {
  const normalized = String(value || fallback || "model")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return normalized || "model";
}

function buildRuntimeContainerName(baseName, instanceMode, instanceId) {
  if (normalizeRuntimeInstanceMode(instanceMode) !== "parallel") return String(baseName);
  return `${String(baseName)}-${normalizeRuntimeInstanceId(instanceId)}`.slice(0, 63).replace(/-+$/g, "");
}

module.exports = {
  normalizeRuntimeInstanceMode,
  normalizeRuntimeInstanceId,
  buildRuntimeContainerName,
};
