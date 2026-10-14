"use strict";
// Sliding-window guard against credential guessing on the public gateway.
//
// A client address that produces more than `maxFailures` authentication
// failures inside `windowMs` is banned for `banMs`. The state is in-memory and
// per process; the point is to turn a 401 storm from a public IP into a cheap
// 429 instead of a key-store read plus an access-log line per attempt.
//
// `onBan({ ip, ipMasked, until, failures })` runs once per ban issued, so the
// entry can record a security.ban telemetry event (04 §9). It runs after the
// ban is in place and can neither throw into record() nor undo the ban.

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_BAN_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function maskAddress(address) {
  const text = String(address || "");
  if (!text) return "";
  if (text.includes(":")) {
    const parts = text.split(":");
    return `${parts.slice(0, 2).join(":")}:…`;
  }
  const parts = text.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : text;
}

function createAuthFailureGuard(options = {}) {
  const maxFailures = clampInt(options.maxFailures, 1, 10_000, DEFAULT_MAX_FAILURES);
  const windowMs = clampInt(options.windowMs, 1000, 24 * 60 * 60 * 1000, DEFAULT_WINDOW_MS);
  const banMs = clampInt(options.banMs, 1000, 7 * 24 * 60 * 60 * 1000, DEFAULT_BAN_MS);
  const maxEntries = clampInt(options.maxEntries, 100, 1_000_000, DEFAULT_MAX_ENTRIES);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const onBan = typeof options.onBan === "function" ? options.onBan : null;
  const entries = new Map();
  let bansIssued = 0;
  let blockedRequests = 0;

  function normalizeKey(key) {
    return String(key || "").trim() || "unknown";
  }

  function prune(at) {
    for (const [key, entry] of entries) {
      const active = (entry.bannedUntil && entry.bannedUntil > at) || entry.failures.some((stamp) => stamp > at - windowMs);
      if (!active) entries.delete(key);
    }
    if (entries.size <= maxEntries) return;
    // Still too many after pruning: drop the oldest tracked keys first.
    const excess = entries.size - maxEntries;
    let dropped = 0;
    for (const key of entries.keys()) {
      if (dropped >= excess) break;
      entries.delete(key);
      dropped += 1;
    }
  }

  function check(key, at = now()) {
    const entry = entries.get(normalizeKey(key));
    if (!entry || !entry.bannedUntil || entry.bannedUntil <= at) return { banned: false };
    blockedRequests += 1;
    return {
      banned: true,
      until: new Date(entry.bannedUntil).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.bannedUntil - at) / 1000)),
    };
  }

  function record(key, at = now()) {
    const normalized = normalizeKey(key);
    const entry = entries.get(normalized) || { failures: [], bannedUntil: 0 };
    entry.failures = entry.failures.filter((stamp) => stamp > at - windowMs);
    entry.failures.push(at);
    let banned = false;
    if (entry.failures.length >= maxFailures) {
      entry.bannedUntil = at + banMs;
      entry.failures = [];
      banned = true;
      bansIssued += 1;
    }
    entries.set(normalized, entry);
    if (entries.size > maxEntries) prune(at);
    if (banned && onBan) {
      try {
        onBan({ ip: normalized, ipMasked: maskAddress(normalized), until: new Date(entry.bannedUntil).toISOString(), failures: maxFailures });
      } catch {
        // Reporting a ban never affects the ban itself.
      }
    }
    return {
      banned,
      failures: banned ? maxFailures : entry.failures.length,
      remaining: banned ? 0 : Math.max(0, maxFailures - entry.failures.length),
      retryAfterSeconds: banned ? Math.ceil(banMs / 1000) : 0,
    };
  }

  function clear(key) {
    entries.delete(normalizeKey(key));
  }

  function reset() {
    entries.clear();
    bansIssued = 0;
    blockedRequests = 0;
  }

  function describe(at = now()) {
    prune(at);
    const banned = [];
    for (const [key, entry] of entries) {
      if (entry.bannedUntil && entry.bannedUntil > at) {
        banned.push({ client: maskAddress(key), until: new Date(entry.bannedUntil).toISOString() });
      }
    }
    return {
      enabled: true,
      maxFailures,
      windowSeconds: Math.round(windowMs / 1000),
      banSeconds: Math.round(banMs / 1000),
      tracked: entries.size,
      bannedCount: banned.length,
      banned: banned.slice(0, 20),
      bansIssued,
      blockedRequests,
    };
  }

  return { check, record, clear, reset, describe, maskAddress };
}

module.exports = {
  createAuthFailureGuard,
  maskAddress,
};
