"use strict";

// File-level scrubbing of persisted ledgers (docs/overhaul/08 P0-5). The CLI
// scripts/scrub-job-ledgers.js wraps it; the managers heal their own jobs
// ledger on load. Results carry counts only, never the matched text.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { REDACTED, redactSecrets } = require("./secret-redactor");
const { writeJsonFile } = require("./file-utils");

// Secret stores hold the keys of running containers. Redacting one would
// destroy those keys, so a store is recognised by name or by shape and is
// never rewritten. Any top-level `secrets` object counts as a store shape
// (the runtime store writes `{ version, secrets: {…} }`).
const SECRET_STORE_NAMES = Object.freeze(["runtime-api-keys.json", "runtime-secrets.json"]);

function isSecretStoreShape(parsed) {
  return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && parsed.secrets && typeof parsed.secrets === "object" && !Array.isArray(parsed.secrets));
}

function isSecretStoreFile(file, parsed) {
  const name = path.basename(String(file || "")).toLowerCase();
  if (SECRET_STORE_NAMES.includes(name)) return true;
  return isSecretStoreShape(parsed);
}

// The exact values a store holds, so ledgers can be checked for them too.
// The values stay in memory and are never reported.
function collectSecretStoreValues(parsed) {
  if (!isSecretStoreShape(parsed)) return [];
  return Object.values(parsed.secrets)
    .map((entry) => (entry && typeof entry === "object" ? entry.secret : entry))
    .filter((value) => typeof value === "string" && value);
}

function countMarkers(text) {
  return text ? text.split(REDACTED).length - 1 : 0;
}

function redactDocument(value, options, state) {
  if (typeof value === "string") {
    const next = redactSecrets(value, options);
    if (next !== value) state.matches += Math.max(1, countMarkers(next) - countMarkers(value));
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => redactDocument(item, options, state));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = redactDocument(item, options, state);
  return output;
}

async function readLedger(file) {
  const text = (await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "");
  try {
    return { text, parsed: JSON.parse(text), valid: true };
  } catch {
    return { text, parsed: null, valid: false };
  }
}

function scanOptions(secrets) {
  return { secrets: Array.isArray(secrets) ? secrets : Array.from(secrets || []), patterns: true };
}

async function inspectLedger(file, { secrets = [] } = {}) {
  if (isSecretStoreFile(file, null)) return { result: { file, matches: 0, skipped: "secret_store" } };
  const { text, parsed, valid } = await readLedger(file);
  if (!valid) {
    // Unparseable files are never rewritten; their text is still counted.
    const state = { matches: 0 };
    redactDocument(text, scanOptions(secrets), state);
    return { result: { file, matches: state.matches, skipped: "invalid_json" } };
  }
  if (isSecretStoreFile(file, parsed)) return { result: { file, matches: 0, skipped: "secret_store" } };
  const state = { matches: 0 };
  const redacted = redactDocument(parsed, scanOptions(secrets), state);
  return { result: { file, matches: state.matches }, redacted };
}

/** Counts secret-like strings in one JSON ledger without changing it. */
async function scanLedgerFile(file, { secrets = [] } = {}) {
  return (await inspectLedger(file, { secrets })).result;
}

/**
 * Redacts one JSON ledger. Without apply it only counts. With apply a file
 * with matches is rewritten atomically (temp file + rename) and no plaintext
 * copy is kept. Secret stores and unparseable files are never written.
 */
async function scrubLedgerFile(file, { secrets = [], apply = false } = {}) {
  const { result, redacted } = await inspectLedger(file, { secrets });
  if (result.skipped || !apply || !result.matches) return { ...result, written: false };
  await writeJsonFile(file, redacted);
  return { ...result, written: true };
}

module.exports = {
  SECRET_STORE_NAMES,
  isSecretStoreFile,
  collectSecretStoreValues,
  scanLedgerFile,
  scrubLedgerFile,
};
