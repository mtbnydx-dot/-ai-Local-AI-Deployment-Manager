"use strict";

// The one limiter (docs/overhaul/05-public.md §9): token buckets for rpm and
// tpm, the per-IP pre-auth bucket, persistent bans with escalation, the
// daily/monthly quotas, the public share cap that keeps the owner from being
// starved, and the response headers that report all of it.
//
// It owns no transport. The gateway pipeline (gateway-pipeline.js) and the
// entry (server.js) call it at the points of the §8.2 lifecycle:
//
//   preAuth(identity)            step 4  per-IP bucket before the key check
//   checkBan(identity)           step 3  IP / CIDR ban => 429 auth_banned
//   noteAuthResult(identity, r)  step 6  a 401 counts toward a ban
//   enter({ caller, ... })       step 11 rpm bucket
//   admitBody({ ticket, ... })   step 11 tpm bucket, then the quotas
//   settle(reservation, usage)   step 15 tpm refund / debit, release in-flight
//   shareGate                    step 13 FIFO semaphore for non-owner traffic
//   headers(ticket, ...)         §9.6   x-ratelimit-*, x-quota-*, anthropic-*
//
// Everything that reads the clock takes `now()` (milliseconds), so tests run
// on a fake clock. Settings are read live through `config` (a function or an
// object; the AccessConfig of public-config.js, or just its `public` section),
// so a changed value applies without a restart.

const core = require("../../manager-core");
const { maskAddress } = require("../../manager-core/auth-failure-guard");
const keyPolicy = require("./key-policy");
const { ipInCidrs } = require("./trusted-proxy");

const DEFAULT_MAX_ENTRIES = 50_000;
const USAGE_CACHE_MS = 2000;
const STORE_RETRY_MS = 30_000;
const FALLBACK_OUTPUT_TOKENS = 4096;
const FALLBACK_GATEWAY_RPM = 600;
const SHARE_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILURE_ENTRIES = 5000;

// §3.4 defaults, used for any value the live config does not carry.
const DEFAULTS = Object.freeze({
  defaults: Object.freeze({ rpm: 60, tpm: 200000, maxOutputTokens: 8192 }),
  share: Object.freeze({ maxConcurrent: 4, maxQueued: 16, queueTimeoutSeconds: 30, ownerActiveMaxConcurrent: 2 }),
  preAuth: Object.freeze({ rpm: 120, burst: 30 }),
  authFailure: Object.freeze({ limit: 20, windowSeconds: 60, banSeconds: 600, maxBanSeconds: 86400 }),
  gatewayRpm: FALLBACK_GATEWAY_RPM,
});

// Message lines the pipeline can show next to the taxonomy code.
const BAN_MESSAGE = (seconds) => `Too many failed authentication attempts. Retry after ${seconds}s.`;

function int(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function accessConfigOf(config) {
  const value = typeof config === "function" ? config() : config;
  return value && typeof value === "object" ? value : {};
}

// The `public` section of an AccessConfig, or the object itself when a bare
// section was given.
function publicSection(config) {
  const value = accessConfigOf(config);
  return value.public && typeof value.public === "object" ? value.public : value;
}

function section(config, name) {
  const source = publicSection(config)[name];
  return { ...DEFAULTS[name], ...(source && typeof source === "object" ? source : {}) };
}

// ---------------------------------------------------------------------------
// 9.1 Token buckets

/**
 * createTokenBucketMap({ maxEntries }) -> { take, peek, adjust, ... }
 *   take(key, { capacity, refillPerSec, cost = 1, now })
 *     -> { ok, remaining, limit, resetSeconds, retryAfterSeconds, exceedsCapacity }
 *   peek(key, spec)    the same answer without taking anything
 *   adjust(key, delta, { now })   may go negative; capped at capacity
 * `now` is milliseconds. A key's bucket starts full. Entries are evicted LRU.
 */
function createTokenBucketMap({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const limit = int(maxEntries, DEFAULT_MAX_ENTRIES, 1, 10_000_000);
  const entries = new Map();

  function refill(entry, at, capacity, refillPerSec) {
    const elapsed = Math.max(0, at - entry.at) / 1000;
    entry.tokens = Math.min(capacity, entry.tokens + elapsed * refillPerSec);
    entry.at = Math.max(entry.at, at);
    entry.capacity = capacity;
    entry.refillPerSec = refillPerSec;
  }

  function view(entry, capacity, refillPerSec, cost, ok, exceedsCapacity) {
    const missing = Math.max(0, capacity - entry.tokens);
    const resetSeconds = refillPerSec > 0 ? Math.ceil(missing / refillPerSec - 1e-9) : 0;
    let retryAfterSeconds = 0;
    if (!ok && !exceedsCapacity) {
      retryAfterSeconds = refillPerSec > 0 ? Math.max(1, Math.ceil((cost - entry.tokens) / refillPerSec - 1e-9)) : MAX_RETRY_AFTER_SECONDS;
    }
    return {
      ok,
      exceedsCapacity: Boolean(exceedsCapacity),
      remaining: Math.max(0, Math.floor(entry.tokens + 1e-9)),
      limit: capacity,
      resetSeconds: Math.max(0, resetSeconds),
      retryAfterSeconds,
    };
  }

  function spec(input = {}) {
    const capacity = Math.max(1, Number(input.capacity) || 1);
    const refillPerSec = Math.max(0, Number(input.refillPerSec) || 0);
    const cost = Number.isFinite(Number(input.cost)) ? Math.max(0, Number(input.cost)) : 1;
    const at = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    return { capacity, refillPerSec, cost, at };
  }

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  function take(key, input) {
    const { capacity, refillPerSec, cost, at } = spec(input);
    const entry = entries.get(key) || { tokens: capacity, at, capacity, refillPerSec };
    refill(entry, at, capacity, refillPerSec);
    touch(key, entry);
    // A request larger than the whole bucket can never succeed.
    if (cost > capacity) return view(entry, capacity, refillPerSec, cost, false, true);
    if (entry.tokens + 1e-9 >= cost) {
      entry.tokens = Math.max(0, entry.tokens - cost);
      return view(entry, capacity, refillPerSec, cost, true, false);
    }
    return view(entry, capacity, refillPerSec, cost, false, false);
  }

  function peek(key, input) {
    const { capacity, refillPerSec, cost, at } = spec(input);
    const stored = entries.get(key);
    const entry = stored ? { ...stored } : { tokens: capacity, at, capacity, refillPerSec };
    refill(entry, at, capacity, refillPerSec);
    if (cost > capacity) return view(entry, capacity, refillPerSec, cost, false, true);
    return view(entry, capacity, refillPerSec, cost, entry.tokens + 1e-9 >= cost, false);
  }

  // Positive delta refunds, negative debits. A bucket that does not exist
  // (evicted, or never taken from) has nothing to adjust.
  function adjust(key, delta, { now } = {}) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (Number.isFinite(Number(now))) refill(entry, Number(now), entry.capacity, entry.refillPerSec);
    entry.tokens = Math.min(entry.capacity, entry.tokens + (Number(delta) || 0));
    return Math.floor(entry.tokens);
  }

  return {
    take,
    peek,
    adjust,
    delete: (key) => entries.delete(key),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

// ---------------------------------------------------------------------------
// 9.3 Auth failures and bans

/**
 * createPersistentBanGuard({ store, config, now, onBan, logger }) -> guard
 * The semantics of core.createAuthFailureGuard, with the bans kept in the
 * access store (security_bans) so a restart does not forget them.
 *   store    a keys-store, or a function returning one (the entry opens it
 *            lazily). Bans are loaded when the store is first available and
 *            checked from memory afterwards: an exact map for IPs and keys,
 *            a short list sorted by prefix length for CIDRs.
 *   config   authFailure { limit, windowSeconds, banSeconds, maxBanSeconds }
 *            and `trustedCidrs`, live.
 *   check(ip) -> { banned, ... }        record(ip) -> { banned, ... }
 *   clear(ip)                           refresh()  reload after an admin change
 * Loopback addresses and the trusted proxies' own addresses are never banned.
 */
function createPersistentBanGuard({ store = null, config = {}, now = Date.now, onBan = null, logger = console } = {}) {
  const failures = new Map();
  let banned = new Map();
  let cidrBans = [];
  const volatileBans = new Map();
  let loaded = false;
  let lastLoadFailureAt = -Infinity;
  let bansIssued = 0;
  let blockedRequests = 0;

  function resolveStore() {
    const value = typeof store === "function" ? store() : store;
    if (!value || typeof value.escalateBan !== "function" || typeof value.listBans !== "function") {
      const error = new Error("The access store is not available.");
      error.code = "access_store_unavailable";
      throw error;
    }
    return value;
  }

  function settings() {
    const failure = section(config, "authFailure");
    return {
      limit: int(failure.limit, DEFAULTS.authFailure.limit, 1, 10_000),
      windowMs: int(failure.windowSeconds, DEFAULTS.authFailure.windowSeconds, 1, 86400) * 1000,
      banSeconds: int(failure.banSeconds, DEFAULTS.authFailure.banSeconds, 1, 2_592_000),
      maxBanSeconds: int(failure.maxBanSeconds, DEFAULTS.authFailure.maxBanSeconds, 1, 2_592_000),
    };
  }

  function untilOf(ban) {
    const time = ban.expiresAt ? Date.parse(ban.expiresAt) : Infinity;
    return Number.isFinite(time) ? time : Infinity;
  }

  function load(at = now()) {
    let rows;
    try {
      rows = resolveStore().listBans({ now: new Date(at), limit: 5000 });
    } catch (error) {
      if (at - lastLoadFailureAt >= STORE_RETRY_MS) {
        lastLoadFailureAt = at;
        logger?.warn?.(`bans: the persistent ban list could not be loaded (${error?.code || "error"}); only this process's bans apply`);
      }
      return false;
    }
    const exact = new Map();
    const rules = [];
    for (const row of rows) {
      const until = untilOf(row);
      if (until <= at) continue;
      if (row.kind === "cidr") {
        const rule = keyPolicy.parseIpRule(row.subject);
        if (rule) rules.push({ rule, subject: row.subject, until, source: row.source, strikes: row.strikes, kind: "cidr" });
      } else {
        exact.set(row.subject, { until, source: row.source, strikes: row.strikes, kind: row.kind, subject: row.subject });
      }
    }
    // Longest prefix first: the most specific ban explains the refusal.
    rules.sort((a, b) => b.rule.prefix - a.rule.prefix);
    banned = exact;
    cidrBans = rules;
    loaded = true;
    return true;
  }

  function ensureLoaded(at) {
    if (loaded || !store) return;
    if (at - lastLoadFailureAt < STORE_RETRY_MS) return;
    load(at);
  }

  function isProtected(ip) {
    const text = String(ip || "").trim();
    if (!text) return true;
    if (keyPolicy.isLoopbackIp(text)) return true;
    const cidrs = accessConfigOf(config).trustedCidrs;
    return Array.isArray(cidrs) && ipInCidrs(text, cidrs);
  }

  function normalize(ip) {
    const address = keyPolicy.parseIp(ip);
    return address ? address.text : String(ip || "").trim();
  }

  function verdict(entry, at) {
    blockedRequests += 1;
    const seconds = Number.isFinite(entry.until) ? Math.ceil((entry.until - at) / 1000) : MAX_RETRY_AFTER_SECONDS;
    return {
      banned: true,
      subject: entry.subject,
      kind: entry.kind,
      source: entry.source,
      until: Number.isFinite(entry.until) ? new Date(entry.until).toISOString() : null,
      retryAfterSeconds: Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds)),
    };
  }

  function lookup(subject, at) {
    const own = banned.get(subject);
    if (own && own.until > at) return own;
    const volatile = volatileBans.get(subject);
    if (volatile && volatile.until > at) return volatile;
    return null;
  }

  // check(ip) -> { banned: false } | { banned: true, retryAfterSeconds, ... }
  function check(ipInput, at = now()) {
    ensureLoaded(at);
    if (isProtected(ipInput)) return { banned: false };
    const ip = normalize(ipInput);
    const exact = lookup(ip, at);
    if (exact) return verdict(exact, at);
    const address = keyPolicy.parseIp(ip);
    if (address) {
      for (const item of cidrBans) {
        if (item.until > at && keyPolicy.ipMatchesRule(address, item.rule)) return verdict({ ...item, subject: item.subject }, at);
      }
    }
    return { banned: false };
  }

  // An admin ban of a key (kind "key"): the subject is the key id.
  function checkKey(keyId, at = now()) {
    ensureLoaded(at);
    const entry = lookup(String(keyId || ""), at);
    return entry && entry.kind === "key" ? verdict(entry, at) : { banned: false };
  }

  function pruneFailures(at, windowMs) {
    for (const [key, stamps] of failures) {
      if (!stamps.some((stamp) => stamp > at - windowMs)) failures.delete(key);
    }
    if (failures.size <= MAX_FAILURE_ENTRIES) return;
    let drop = failures.size - MAX_FAILURE_ENTRIES;
    for (const key of failures.keys()) {
      if (drop-- <= 0) break;
      failures.delete(key);
    }
  }

  // The ban for a burst of failures: persisted with escalation, or (store
  // unavailable) held in this process for banSeconds.
  function issue(ip, at, { limit, banSeconds, maxBanSeconds }) {
    let ban = null;
    try {
      ban = resolveStore().escalateBan(ip, { kind: "ip", at: new Date(at), banSeconds, maxBanSeconds, reason: "auth_failures" });
    } catch (error) {
      if (store) logger?.warn?.(`bans: a ban could not be stored (${error?.code || "error"}); it applies to this process only`);
    }
    if (ban) {
      const entry = { until: untilOf(ban), source: ban.source, strikes: ban.strikes, kind: "ip", subject: ban.subject };
      banned.set(ip, entry);
      volatileBans.delete(ip);
      return { entry, persisted: true };
    }
    const previous = volatileBans.get(ip);
    const strikes = previous && at - previous.until < 24 * 3600 * 1000 ? previous.strikes + 1 : 1;
    let seconds = banSeconds;
    for (let strike = 1; strike < strikes && seconds < maxBanSeconds; strike += 1) seconds *= 4;
    const entry = { until: at + Math.min(seconds, maxBanSeconds) * 1000, source: "auto", strikes, kind: "ip", subject: ip };
    volatileBans.set(ip, entry);
    return { entry, persisted: false, limit };
  }

  // record(ip) counts one failed authentication. Reaching the limit inside
  // the window bans the address (§9.3).
  function record(ipInput, at = now()) {
    if (isProtected(ipInput)) return { banned: false, protected: true, failures: 0, remaining: 0, retryAfterSeconds: 0 };
    const ip = normalize(ipInput);
    const config_ = settings();
    ensureLoaded(at);
    const stamps = (failures.get(ip) || []).filter((stamp) => stamp > at - config_.windowMs);
    stamps.push(at);
    if (stamps.length < config_.limit) {
      failures.set(ip, stamps);
      if (failures.size > MAX_FAILURE_ENTRIES) pruneFailures(at, config_.windowMs);
      return { banned: false, failures: stamps.length, remaining: config_.limit - stamps.length, retryAfterSeconds: 0 };
    }
    failures.delete(ip);
    const { entry } = issue(ip, at, config_);
    bansIssued += 1;
    const retryAfterSeconds = Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((entry.until - at) / 1000)));
    if (typeof onBan === "function") {
      try {
        onBan({
          ip,
          ipMasked: maskAddress(ip),
          until: Number.isFinite(entry.until) ? new Date(entry.until).toISOString() : null,
          failures: config_.limit,
          strikes: entry.strikes,
        });
      } catch {
        // Reporting a ban never affects the ban itself.
      }
    }
    return { banned: true, failures: config_.limit, remaining: 0, retryAfterSeconds, strikes: entry.strikes };
  }

  function clear(ipInput) {
    failures.delete(normalize(ipInput));
  }

  function reset() {
    failures.clear();
    volatileBans.clear();
    bansIssued = 0;
    blockedRequests = 0;
  }

  function describe(at = now()) {
    ensureLoaded(at);
    const active = [];
    for (const entry of [...banned.values(), ...volatileBans.values(), ...cidrBans]) {
      if (entry.until > at) active.push(entry);
    }
    const current = settings();
    return {
      enabled: true,
      maxFailures: current.limit,
      windowSeconds: Math.round(current.windowMs / 1000),
      banSeconds: current.banSeconds,
      maxBanSeconds: current.maxBanSeconds,
      tracked: failures.size,
      bannedCount: active.length,
      banned: active.slice(0, 20).map((entry) => ({
        client: entry.kind === "ip" ? maskAddress(entry.subject) : entry.subject,
        until: Number.isFinite(entry.until) ? new Date(entry.until).toISOString() : null,
        source: entry.source,
        strikes: entry.strikes,
      })),
      bansIssued,
      blockedRequests,
    };
  }

  // Eager load when a store object is handed over directly (tests, the entry
  // after it has opened the store); a getter loads on first use.
  if (store && typeof store !== "function") load(now());

  return { check, checkKey, record, clear, reset, describe, refresh: () => load(now()), isProtected, maskAddress };
}

// ---------------------------------------------------------------------------
// 9.5 Public share cap

/**
 * createShareGate({ config, now, setTimeout, clearTimeout }) -> gate
 * A FIFO semaphore for PUBLIC requests from non-owner classes. The effective
 * concurrency is share.maxConcurrent, reduced to share.ownerActiveMaxConcurrent
 * while owner traffic is in flight (ADMIN model requests, console-session,
 * keys of class owner; each calls ownerBegin()).
 *   acquire({ signal, timeoutMs }) -> Promise<{ ok: true, release }
 *                                           | { ok: false, reason: "queue_full" | "timeout" | "aborted" }>
 * A refusal is 503 overloaded with retry-after 5 (529 on Anthropic routes).
 */
function createShareGate({ config = {}, setTimeout: setTimer = null, clearTimeout: clearTimer = null } = {}) {
  const queue = [];
  let active = 0;
  let ownerActive = 0;

  function share() {
    const current = section(config, "share");
    return {
      maxConcurrent: int(current.maxConcurrent, DEFAULTS.share.maxConcurrent, 1, 256),
      maxQueued: int(current.maxQueued, DEFAULTS.share.maxQueued, 0, 4096),
      queueTimeoutSeconds: int(current.queueTimeoutSeconds, DEFAULTS.share.queueTimeoutSeconds, 1, 600),
      ownerActiveMaxConcurrent: int(current.ownerActiveMaxConcurrent, DEFAULTS.share.ownerActiveMaxConcurrent, 0, 256),
    };
  }

  function effective(current = share()) {
    return ownerActive > 0 ? Math.min(current.maxConcurrent, current.ownerActiveMaxConcurrent) : current.maxConcurrent;
  }

  function pump() {
    const limit = effective();
    while (queue.length && active < limit) {
      const waiter = queue.shift();
      waiter.settle(grant());
    }
  }

  function grant() {
    active += 1;
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        pump();
      },
    };
  }

  function acquire({ signal = null, timeoutMs = null } = {}) {
    const current = share();
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
    if (!queue.length && active < effective(current)) return Promise.resolve(grant());
    if (queue.length >= current.maxQueued) return Promise.resolve({ ok: false, reason: "queue_full" });
    const waitMs = timeoutMs !== null && timeoutMs !== undefined && Number.isFinite(Number(timeoutMs)) ? Math.max(1, Number(timeoutMs)) : current.queueTimeoutSeconds * 1000;
    return new Promise((resolve) => {
      let timer = null;
      let onAbort = null;
      const waiter = {
        settle(result) {
          if (timer !== null) (clearTimer || clearTimeout)(timer);
          if (onAbort) signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      };
      const leave = (reason) => {
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        waiter.settle({ ok: false, reason });
      };
      timer = (setTimer || setTimeout)(() => leave("timeout"), waitMs);
      timer?.unref?.();
      if (signal) {
        onAbort = () => leave("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
      queue.push(waiter);
    });
  }

  // ownerBegin() -> release. Idempotent; lowering the cap never evicts a
  // request that is already running, it only delays the queue.
  function ownerBegin() {
    ownerActive += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      ownerActive = Math.max(0, ownerActive - 1);
      pump();
    };
  }

  function snapshot() {
    const current = share();
    return {
      active,
      queued: queue.length,
      ownerActive,
      effectiveConcurrency: effective(current),
      maxConcurrent: current.maxConcurrent,
      maxQueued: current.maxQueued,
      ownerActiveMaxConcurrent: current.ownerActiveMaxConcurrent,
    };
  }

  return { acquire, ownerBegin, snapshot, retryAfterSeconds: SHARE_RETRY_AFTER_SECONDS };
}

// ---------------------------------------------------------------------------
// 9.6 Headers

function resetText(seconds) {
  return `${Math.max(0, Math.ceil(Number(seconds) || 0))}s`;
}

/**
 * rateLimitHeaders(ticket, { protocol, now }) -> { header: value }
 * The headers of §9.6 for what the ticket has seen so far: requests always,
 * tokens when a tpm bucket applied, quota remaining only when a cap exists.
 * Anthropic routes (`protocol: "claude"`) add anthropic-ratelimit-* with RFC
 * 3339 reset times.
 */
function rateLimitHeaders(ticket, { protocol = "", now = Date.now() } = {}) {
  const headers = {};
  if (!ticket) return headers;
  const anthropic = protocol === "claude" || protocol === "anthropic";
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const stamp = (seconds) => new Date(at + Math.max(0, Number(seconds) || 0) * 1000).toISOString();
  if (ticket.rpm) {
    headers["x-ratelimit-limit-requests"] = String(ticket.rpm.limit);
    headers["x-ratelimit-remaining-requests"] = String(Math.max(0, ticket.rpm.remaining));
    headers["x-ratelimit-reset-requests"] = resetText(ticket.rpm.resetSeconds);
    if (anthropic) {
      headers["anthropic-ratelimit-requests-limit"] = String(ticket.rpm.limit);
      headers["anthropic-ratelimit-requests-remaining"] = String(Math.max(0, ticket.rpm.remaining));
      headers["anthropic-ratelimit-requests-reset"] = stamp(ticket.rpm.resetSeconds);
    }
  }
  if (ticket.tpm) {
    headers["x-ratelimit-limit-tokens"] = String(ticket.tpm.limit);
    headers["x-ratelimit-remaining-tokens"] = String(Math.max(0, ticket.tpm.remaining));
    headers["x-ratelimit-reset-tokens"] = resetText(ticket.tpm.resetSeconds);
    if (anthropic) {
      headers["anthropic-ratelimit-tokens-limit"] = String(ticket.tpm.limit);
      headers["anthropic-ratelimit-tokens-remaining"] = String(Math.max(0, ticket.tpm.remaining));
      headers["anthropic-ratelimit-tokens-reset"] = stamp(ticket.tpm.resetSeconds);
    }
  }
  if (ticket.quota) {
    if (ticket.quota.dayTokens !== null && ticket.quota.dayTokens !== undefined) headers["x-quota-remaining-tokens-day"] = String(Math.max(0, ticket.quota.dayTokens));
    if (ticket.quota.monthTokens !== null && ticket.quota.monthTokens !== undefined) headers["x-quota-remaining-tokens-month"] = String(Math.max(0, ticket.quota.monthTokens));
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Token costs

function requestedMaxOutput(body) {
  for (const field of ["max_completion_tokens", "max_output_tokens", "max_tokens"]) {
    const value = positive(body?.[field]);
    if (value !== null) return Math.floor(value);
  }
  return null;
}

// §9.1: the admission cost of a request in tokens, and its parts.
function estimateAdmission(body, { cap = null, outputless = false } = {}) {
  const input = Math.max(0, Math.floor(core.estimateOpenAiRequestInputTokens(body) || 0));
  if (outputless) return { input, reservedOutput: 0, cost: input };
  const requested = requestedMaxOutput(body);
  const ceiling = cap !== null && cap !== undefined ? cap : Infinity;
  const reservedOutput = Math.floor(Math.min(requested ?? (cap ?? FALLBACK_OUTPUT_TOKENS), ceiling));
  return { input, reservedOutput, cost: input + reservedOutput };
}

// ---------------------------------------------------------------------------
// The limiter

function secondsUntil(iso, at) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 60;
  return Math.max(1, Math.ceil((time - at) / 1000));
}

/**
 * createLimiter({ store, config, now, onBan, logger, gatewayRpm }) -> limiter
 *   store       the access store (or a getter): bans and usage counters
 *   config      live AccessConfig (see the header); `trustedCidrs` feeds the
 *               "never ban a trusted proxy" rule
 *   gatewayRpm  () -> number|0: an override of admin.gatewayRpm (the entry
 *               passes SERVICE_ENTRY_RATE_LIMIT_RPM here)
 */
function createLimiter({ store = null, config = {}, now = Date.now, onBan = null, logger = console, gatewayRpm = null, setTimeout: setTimer = null, clearTimeout: clearTimer = null } = {}) {
  const buckets = createTokenBucketMap();
  const bans = createPersistentBanGuard({ store, config, now, onBan, logger });
  const shareGate = createShareGate({ config, setTimeout: setTimer, clearTimeout: clearTimer });
  // keyId -> { requests, tokens } held by requests that are still running.
  const inflight = new Map();
  const usageCache = new Map();
  let warnedUsageAt = -Infinity;

  function resolveStore() {
    return typeof store === "function" ? store() : store;
  }

  function gatewayRpmNow() {
    const override = typeof gatewayRpm === "function" ? Number(gatewayRpm()) : 0;
    if (Number.isFinite(override) && override > 0) return Math.floor(override);
    const configured = Number(accessConfigOf(config).admin?.gatewayRpm);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULTS.gatewayRpm;
  }

  // ---- pre-auth (§9.2) ----------------------------------------------------

  // The per-IP bucket before the key check. A request without the client-IP
  // header from a trusted socket shares the bucket of that socket, which
  // authFailure never bans.
  function preAuth(identity, { at = now() } = {}) {
    const settings = section(config, "preAuth");
    const rpm = int(settings.rpm, DEFAULTS.preAuth.rpm, 1, 100_000);
    const burst = int(settings.burst, DEFAULTS.preAuth.burst, 1, 10_000);
    const subject = identity?.missingHeader ? `proxy:${identity.socketIp || identity.ip || ""}` : `ip:${identity?.ip || identity?.socketIp || "anonymous"}`;
    const taken = buckets.take(`pre:${subject}`, { capacity: burst, refillPerSec: rpm / 60, cost: 1, now: at });
    if (taken.ok) return { ok: true };
    return { ok: false, code: "ip_rate_limited", status: 429, retryAfterSeconds: taken.retryAfterSeconds };
  }

  // ---- bans (§9.3) --------------------------------------------------------

  function checkBan(identity, { at = now() } = {}) {
    if (!identity || identity.missingHeader) return null;
    const verdict = bans.check(identity.ip, at);
    if (!verdict.banned) return null;
    return { code: "auth_banned", status: 429, retryAfterSeconds: verdict.retryAfterSeconds, message: BAN_MESSAGE(verdict.retryAfterSeconds) };
  }

  function checkKeyBan(keyId, { at = now() } = {}) {
    const verdict = bans.checkKey(keyId, at);
    if (!verdict.banned) return null;
    return { code: "auth_banned", status: 429, retryAfterSeconds: verdict.retryAfterSeconds, message: BAN_MESSAGE(verdict.retryAfterSeconds) };
  }

  // A success clears the address's failure window; a 401 counts toward a ban.
  function noteAuthResult(identity, result, { at = now() } = {}) {
    if (!identity || identity.missingHeader) return null;
    if (result?.ok) {
      bans.clear(identity.ip);
      return null;
    }
    if (result?.status === 401) return bans.record(identity.ip, at);
    return null;
  }

  // ---- rpm (§9.1) ---------------------------------------------------------

  // Which bucket and which limits a caller is held to. Keys carry their own
  // (a null limit means public.defaults on PUBLIC, except for owner keys);
  // console-session and keyless ADMIN callers use admin.gatewayRpm.
  function limitsFor(caller, listener, identity) {
    const defaults = section(config, "defaults");
    const gateway = gatewayRpmNow();
    if (caller?.kind === "console-session") {
      return { subject: `console:${caller.sessionId || "session"}`, rpm: gateway, tpm: null, outputCap: null, key: null };
    }
    if (caller?.key) {
      const key = caller.key;
      const limits = key.limits || {};
      const useDefaults = listener === "public" && key.class !== "owner";
      const rpm = positive(limits.rpm) ?? (useDefaults ? int(defaults.rpm, DEFAULTS.defaults.rpm, 1, 1_000_000) : gateway);
      const tpm = positive(limits.tpm) ?? (useDefaults ? int(defaults.tpm, DEFAULTS.defaults.tpm, 1, 1_000_000_000) : null);
      const outputCap = positive(limits.maxOutputTokens) ?? (useDefaults ? int(defaults.maxOutputTokens, DEFAULTS.defaults.maxOutputTokens, 1, 10_000_000) : null);
      return { subject: `key:${key.id}`, rpm: Math.floor(rpm), tpm: tpm === null ? null : Math.floor(tpm), outputCap, key };
    }
    if (caller?.client?.id) {
      const rpm = positive(caller.client.rateLimitRpm) ?? gateway;
      return { subject: `client:${caller.matchedManager || "platform"}:${caller.client.id}`, rpm: Math.floor(rpm), tpm: null, outputCap: null, key: null };
    }
    return { subject: `anon:${identity?.ip || identity?.socketIp || "anonymous"}`, rpm: gateway, tpm: null, outputCap: null, key: null };
  }

  /**
   * enter({ caller, identity, listener }) -> { ok, ticket, code?, status?, retryAfterSeconds? }
   * Takes one request from the caller's rpm bucket. The ticket carries what
   * the headers report and what admitBody() needs.
   */
  function enter({ caller = null, identity = null, listener = "admin", at = now() } = {}) {
    const limits = limitsFor(caller, listener, identity);
    const taken = buckets.take(`rpm:${limits.subject}`, { capacity: limits.rpm, refillPerSec: limits.rpm / 60, cost: 1, now: at });
    const ticket = {
      at,
      listener,
      limits,
      rpm: { limit: limits.rpm, remaining: taken.remaining, resetSeconds: taken.resetSeconds },
      tpm: null,
      quota: null,
    };
    if (taken.ok) return { ok: true, ticket };
    return { ok: false, ticket, status: 429, code: "rate_limit_exceeded", retryAfterSeconds: taken.retryAfterSeconds };
  }

  // ---- quotas (§9.4) ------------------------------------------------------

  function tzOffset() {
    const value = publicSection(config).quotaTzOffsetMinutes;
    return value === null || value === undefined ? undefined : Number(value);
  }

  function usageOf(keyId, at) {
    const cached = usageCache.get(keyId);
    if (cached && at - cached.at < USAGE_CACHE_MS && at >= cached.from && at < cached.until) return cached.value;
    const keysStore = resolveStore();
    const value = keysStore.getUsage(keyId, { at: new Date(at), tzOffsetMinutes: tzOffset() });
    const until = Math.min(Date.parse(value.dayResetsAt) || Infinity, Date.parse(value.monthResetsAt) || Infinity);
    usageCache.set(keyId, { at, from: at, until, value });
    if (usageCache.size > 5000) usageCache.delete(usageCache.keys().next().value);
    return value;
  }

  function held(keyId) {
    return inflight.get(keyId) || { requests: 0, tokens: 0 };
  }

  // The first exceeded cap, or null; plus the remaining token headroom.
  function checkQuotas(key, at) {
    const limits = key.limits || {};
    const caps = {
      dailyTokens: positive(limits.dailyTokens),
      monthlyTokens: positive(limits.monthlyTokens),
      dailyRequests: positive(limits.dailyRequests),
    };
    if (caps.dailyTokens === null && caps.monthlyTokens === null && caps.dailyRequests === null) return { exceeded: null, quota: null };
    let usage;
    try {
      usage = usageOf(key.id, at);
    } catch (error) {
      // Authentication read the same store a moment ago; if it fails here,
      // the cap cannot be judged and the request is not refused for it.
      if (at - warnedUsageAt > STORE_RETRY_MS) {
        warnedUsageAt = at;
        logger?.warn?.(`quota: usage counters could not be read (${error?.code || "error"}); quotas are not enforced until they can`);
      }
      return { exceeded: null, quota: null };
    }
    const reserved = held(key.id);
    const dayUsed = (usage.day?.inputTokens || 0) + (usage.day?.outputTokens || 0);
    const monthUsed = (usage.month?.inputTokens || 0) + (usage.month?.outputTokens || 0);
    const quota = {
      dayTokens: caps.dailyTokens === null ? null : caps.dailyTokens - dayUsed - reserved.tokens,
      monthTokens: caps.monthlyTokens === null ? null : caps.monthlyTokens - monthUsed - reserved.tokens,
    };
    if (quota.dayTokens !== null && quota.dayTokens <= 0) {
      return { exceeded: { param: "daily_tokens", retryAfterSeconds: secondsUntil(usage.dayResetsAt, at) }, quota };
    }
    if (quota.monthTokens !== null && quota.monthTokens <= 0) {
      return { exceeded: { param: "monthly_tokens", retryAfterSeconds: secondsUntil(usage.monthResetsAt, at) }, quota };
    }
    if (caps.dailyRequests !== null && (usage.day?.requests || 0) + reserved.requests >= caps.dailyRequests) {
      return { exceeded: { param: "daily_requests", retryAfterSeconds: secondsUntil(usage.dayResetsAt, at) }, quota };
    }
    return { exceeded: null, quota };
  }

  /**
   * admitBody({ ticket, caller, body, scope }) ->
   *   { ok: true, reservation|null } | { ok: false, status, code, param?, retryAfterSeconds? }
   * tpm first (400 request_exceeds_tpm when the cost can never fit, 429
   * tokens_rate_limit_exceeded otherwise), then the daily/monthly caps (429
   * insufficient_quota, with the tpm reservation handed back). A key with
   * neither a tpm limit nor a cap reserves nothing.
   */
  function admitBody({ ticket, caller = null, body = null, scope = "", at = now() } = {}) {
    const limits = ticket?.limits;
    const key = limits?.key;
    if (!ticket || !key || !body || typeof body !== "object") return { ok: true, reservation: null };
    const keyLimits = key.limits || {};
    const hasCap = positive(keyLimits.dailyTokens) !== null || positive(keyLimits.monthlyTokens) !== null || positive(keyLimits.dailyRequests) !== null;
    if (limits.tpm === null && !hasCap) return { ok: true, reservation: null };
    const estimate = estimateAdmission(body, { cap: limits.outputCap, outputless: scope === "embeddings" });
    let tpmKey = null;
    if (limits.tpm !== null) {
      tpmKey = `tpm:${limits.subject}`;
      const taken = buckets.take(tpmKey, { capacity: limits.tpm, refillPerSec: limits.tpm / 60, cost: estimate.cost, now: at });
      ticket.tpm = { limit: limits.tpm, remaining: taken.remaining, resetSeconds: taken.resetSeconds };
      if (taken.exceedsCapacity) return { ok: false, status: 400, code: "request_exceeds_tpm", param: null };
      if (!taken.ok) return { ok: false, status: 429, code: "tokens_rate_limit_exceeded", retryAfterSeconds: taken.retryAfterSeconds };
    }
    const quotas = checkQuotas(key, at);
    if (quotas.quota) ticket.quota = quotas.quota;
    if (quotas.exceeded) {
      if (tpmKey) {
        const remaining = buckets.adjust(tpmKey, estimate.cost, { now: at });
        if (remaining !== null) ticket.tpm.remaining = remaining;
      }
      return { ok: false, status: 429, code: "insufficient_quota", param: quotas.exceeded.param, retryAfterSeconds: quotas.exceeded.retryAfterSeconds };
    }
    const reservation = {
      keyId: key.id,
      tpmKey,
      cost: estimate.cost,
      input: estimate.input,
      reservedOutput: estimate.reservedOutput,
      ticket,
      settled: false,
    };
    const current = held(key.id);
    inflight.set(key.id, { requests: current.requests + 1, tokens: current.tokens + estimate.cost });
    return { ok: true, reservation };
  }

  /**
   * settle(reservation, usage, { at }) hands back the part of the tpm
   * reservation that was not used (or debits an overrun) and releases the
   * in-flight hold. usage { inputTokens, outputTokens } is what the upstream
   * reported; `null` keeps the admission estimate as the charge. Idempotent:
   * the first call wins, so the usage tap (PUB-11) and the pipeline's
   * finish/close fallback can both call it.
   */
  function settle(reservation, usage = null, { at = now() } = {}) {
    if (!reservation || reservation.settled) return false;
    reservation.settled = true;
    const current = held(reservation.keyId);
    const requests = Math.max(0, current.requests - 1);
    const tokens = Math.max(0, current.tokens - reservation.cost);
    if (requests === 0 && tokens === 0) inflight.delete(reservation.keyId);
    else inflight.set(reservation.keyId, { requests, tokens });
    if (usage && reservation.tpmKey) {
      const actual = Math.max(0, Math.floor(Number(usage.inputTokens) || 0)) + Math.max(0, Math.floor(Number(usage.outputTokens) || 0));
      buckets.adjust(reservation.tpmKey, reservation.cost - actual, { now: at });
    }
    return true;
  }

  // Counters are read through a 2 s cache (§9.4); the usage tap drops the
  // cached read after it writes, when it wants the next check to see it.
  function invalidateUsage(keyId) {
    if (keyId) usageCache.delete(String(keyId));
    else usageCache.clear();
  }

  function headers(ticket, { protocol = "", at = now() } = {}) {
    return rateLimitHeaders(ticket, { protocol, now: at });
  }

  function reset() {
    buckets.clear();
    inflight.clear();
    usageCache.clear();
  }

  function describe() {
    return { buckets: buckets.size, bans: bans.describe(), share: shareGate.snapshot() };
  }

  return {
    buckets,
    bans,
    shareGate,
    preAuth,
    checkBan,
    checkKeyBan,
    noteAuthResult,
    enter,
    admitBody,
    settle,
    invalidateUsage,
    headers,
    reset,
    describe,
  };
}

module.exports = {
  DEFAULTS,
  createLimiter,
  createPersistentBanGuard,
  createShareGate,
  createTokenBucketMap,
  estimateAdmission,
  rateLimitHeaders,
};
