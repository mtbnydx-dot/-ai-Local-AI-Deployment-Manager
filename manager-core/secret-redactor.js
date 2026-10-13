"use strict";

// The platform's only secret redactor (docs/overhaul/08-p0-fixes.md §3).
// Pure: no I/O, no logging. Every log sink, ledger and later subsystem imports
// this module, and "<redacted>" is the only marker it produces.

const REDACTED = "<redacted>";

// Checked in this order after the exact secrets. `keep` is the capture group
// that survives in front of the marker (the flag, key name or variable name).
const SECRET_PATTERNS = Object.freeze([
  // 1. CLI flags: --api-key xyz, --hf-token=xyz, --token "x y".
  Object.freeze({
    id: "cli-flag",
    pattern: /(--(?:api-key|hf-token|token|admin-api-key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
    keep: 1,
  }),
  // 2. key: value / key=value. An HTTP auth scheme (Bearer/Basic/Token) stays in
  //    front of the marker so "Authorization: Bearer x" never leaves the
  //    credential behind the scheme word.
  Object.freeze({
    id: "key-value",
    pattern: /(["']?(?:api[_-]?key|hf[_-]?token|access[_-]?token|authorization|x-api-key)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?)([^"'\s,}]+)/gi,
    keep: 1,
  }),
  // 3. Bearer credentials anywhere.
  Object.freeze({ id: "bearer", pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keep: 1 }),
  // 4. NAME_API_KEY=value, NAME_TOKEN=value, NAME_SECRET=value. The name-only
  //    "-e VLLM_API_KEY" form has no "=" and stays readable.
  Object.freeze({ id: "env-assignment", pattern: /(\b[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET)=)(\S+)/gi, keep: 1 }),
  // 5. OpenAI-style keys. "sk-learn" is too short to match.
  Object.freeze({ id: "sk-key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/gi, keep: 0 }),
  // 6. Hugging Face tokens. "hf_hub_download" stops at the underscore.
  Object.freeze({ id: "hf-token", pattern: /\bhf_[A-Za-z0-9]{20,}/gi, keep: 0 }),
]);

// Every pattern above needs one of these substrings, so text without any of
// them skips the pattern pass. Log lines are redacted on every ledger save.
const PATTERN_HINT = /--|api|token|auth|bearer|secret|sk-|hf_/i;

function toSecretList(secrets) {
  if (secrets === undefined || secrets === null) return [];
  if (typeof secrets === "string") return [secrets];
  if (typeof secrets[Symbol.iterator] === "function") return Array.from(secrets);
  return [];
}

function normalizeSecrets(secrets, minSecretLength, placeholder) {
  const minimum = Number.isFinite(Number(minSecretLength)) ? Number(minSecretLength) : 8;
  const unique = new Set();
  for (const item of toSecretList(secrets)) {
    if (typeof item !== "string") continue;
    if (item.length < minimum || item.length === 0) continue;
    // A secret that is part of the marker would make redaction non-idempotent.
    if (placeholder.includes(item)) continue;
    unique.add(item);
  }
  // Longest first, so a secret that contains another one is replaced whole.
  return Array.from(unique).sort((left, right) => right.length - left.length);
}

function redactNormalized(text, secretList, placeholder, patterns) {
  let output = text;
  for (const secret of secretList) {
    if (output.includes(secret)) output = output.split(secret).join(placeholder);
  }
  if (patterns === false || !PATTERN_HINT.test(output)) return output;
  for (const entry of SECRET_PATTERNS) {
    output = entry.keep
      ? output.replace(entry.pattern, (match, kept) => `${kept}${placeholder}`)
      : output.replace(entry.pattern, () => placeholder);
  }
  return output;
}

function resolveOptions(options = {}) {
  const placeholder = typeof options.placeholder === "string" && options.placeholder
    ? options.placeholder
    : REDACTED;
  return {
    placeholder,
    patterns: options.patterns !== false,
    secretList: normalizeSecrets(options.secrets, options.minSecretLength ?? 8, placeholder),
  };
}

/**
 * Redact known secret values and secret-shaped substrings. Non-strings are
 * returned unchanged. patterns:false = exact secrets only (API responses,
 * where the patterns could hit model ids).
 */
function redactSecrets(text, options = {}) {
  if (typeof text !== "string" || !text) return text;
  const resolved = resolveOptions(options);
  return redactNormalized(text, resolved.secretList, resolved.placeholder, resolved.patterns);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactWalk(value, resolved, seen) {
  if (typeof value === "string") {
    return value ? redactNormalized(value, resolved.secretList, resolved.placeholder, resolved.patterns) : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    let changed = false;
    const output = value.map((item) => {
      const next = redactWalk(item, resolved, seen);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? output : value;
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  let changed = false;
  const output = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const [key, item] of Object.entries(value)) {
    const next = redactWalk(item, resolved, seen);
    if (next !== item) changed = true;
    output[key] = next;
  }
  return changed ? output : value;
}

/**
 * Deep-redacts strings inside plain objects and arrays (for job.meta,
 * error.details). Never mutates: a changed branch is copied, and an unchanged
 * value is returned as the same reference.
 */
function redactValue(value, options = {}) {
  return redactWalk(value, resolveOptions(options), new WeakSet());
}

/**
 * Bound redactor. getSecrets() is called on every redact, so rotated keys are
 * covered; a throwing getSecrets falls back to the patterns alone.
 */
function createSecretRedactor({ getSecrets = () => [], placeholder = REDACTED, patterns = true, minSecretLength = 8 } = {}) {
  function currentOptions() {
    let secrets = [];
    try {
      secrets = typeof getSecrets === "function" ? getSecrets() : [];
    } catch {
      secrets = [];
    }
    return { secrets, placeholder, patterns, minSecretLength };
  }
  return {
    redact(text) {
      if (typeof text !== "string" || !text) return text;
      return redactSecrets(text, currentOptions());
    },
    redactValue(value) {
      return redactValue(value, currentOptions());
    },
  };
}

module.exports = {
  REDACTED,
  SECRET_PATTERNS,
  redactSecrets,
  redactValue,
  createSecretRedactor,
};
