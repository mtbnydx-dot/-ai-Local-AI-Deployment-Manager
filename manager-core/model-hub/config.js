"use strict";

// The hub's one platform flag (03 §3): hub.downloadsOwner, "hub" (the hub
// queues and runs every model download) or "manager" (rollback: the managers
// use their legacy controllers and the hub serves the library and search
// read-only). The managers and the entry read the same value.
//
// The key is declared by the hub's platform-config fragment
// (data/platform-config.d/hub.schema.json, env AI_HUB_DOWNLOADS_OWNER), so
// 06's readSection resolves it with the platform precedence: env > file
// (<AI_ROOT>/config/platform.json) > default "hub". An invalid value is
// reported and the next source is used. Should the platform config be
// unusable (its schema rejected the fragment), the same precedence is applied
// here directly, so the flag can always be read.

const fs = require("node:fs");
const path = require("node:path");

const DOWNLOADS_OWNERS = Object.freeze(["hub", "manager"]);
const DEFAULT_DOWNLOADS_OWNER = "hub";
const DOWNLOADS_OWNER_KEY = "hub.downloadsOwner";
const DOWNLOADS_OWNER_ENV = "AI_HUB_DOWNLOADS_OWNER";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ownerError(source, message, extra = {}) {
  return { field: DOWNLOADS_OWNER_KEY, code: "invalid_value", source, message, ...extra };
}

function normalizeOwner(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return DOWNLOADS_OWNERS.includes(text) ? text : "";
}

function fromPlatformConfig(platformConfig, aiRoot, env) {
  const section = platformConfig.readSection("hub", { ...(aiRoot ? { aiRoot } : {}), env });
  if (section.errors.some((error) => error.code === "unknown_section")) return null;
  const owner = normalizeOwner(section.values?.downloadsOwner);
  if (!owner) return null;
  return {
    downloadsOwner: owner,
    source: section.sources?.[DOWNLOADS_OWNER_KEY] || "default",
    errors: section.errors.map(({ field, code, source, env: name, message }) => ({ field, code, ...(source ? { source } : {}), ...(name ? { env: name } : {}), message })),
  };
}

// The same precedence without 06's loader.
function readDirectly(aiRoot, env) {
  const errors = [];
  const fromEnv = env?.[DOWNLOADS_OWNER_ENV];
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== "") {
    const owner = normalizeOwner(fromEnv);
    if (owner) return { downloadsOwner: owner, source: "env", errors };
    errors.push(ownerError("env", `${DOWNLOADS_OWNER_ENV} must be "hub" or "manager"; it is ignored.`, { env: DOWNLOADS_OWNER_ENV }));
  }
  const root = path.resolve(String(aiRoot || env?.AI_ROOT || path.join(__dirname, "..", "..")));
  let text = null;
  try {
    text = fs.readFileSync(path.join(root, "config", "platform.json"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push({ field: "$file", code: "read_error", message: `platform.json could not be read (${error?.code || "error"}); defaults are in force.` });
  }
  if (text !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      errors.push({ field: "$file", code: "parse_error", message: `platform.json is not valid JSON (${error.message}); defaults are in force.` });
    }
    const value = isPlainObject(parsed) && isPlainObject(parsed.hub) ? parsed.hub.downloadsOwner : undefined;
    if (value !== undefined) {
      if (typeof value === "string" && DOWNLOADS_OWNERS.includes(value)) return { downloadsOwner: value, source: "file", errors };
      errors.push(ownerError("file", `${DOWNLOADS_OWNER_KEY} must be "hub" or "manager"; the default is used.`));
    }
  }
  return { downloadsOwner: DEFAULT_DOWNLOADS_OWNER, source: "default", errors };
}

/**
 * readHubConfig(aiRoot, env) → { downloadsOwner: "hub"|"manager",
 * source: "env"|"file"|"default", errors: [{ field, code, source?, message }] }.
 * Never throws.
 */
function readHubConfig(aiRoot, env = process.env, options = {}) {
  const variables = env || {};
  try {
    const platformConfig = options.platformConfig || require("../platform/config");
    const resolved = fromPlatformConfig(platformConfig, aiRoot, variables);
    if (resolved) return resolved;
  } catch {
    // Fall through to the direct read.
  }
  return readDirectly(aiRoot, variables);
}

module.exports = {
  DEFAULT_DOWNLOADS_OWNER,
  DOWNLOADS_OWNERS,
  DOWNLOADS_OWNER_ENV,
  DOWNLOADS_OWNER_KEY,
  readHubConfig,
};
