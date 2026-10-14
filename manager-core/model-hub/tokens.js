"use strict";

// Temporary Hugging Face token vault (03 §12, 08 P0-9). A token the user
// types for one download lives only in this process's memory; one the user
// asks to remember is also written to the secret store (06 OPS-3,
// namespace "hf"). The vault hands out an opaque tokenRef and nothing else:
// the ref is what jobs, plans and APIs carry, never the token itself.
//
// This file keeps no secret on disk of its own and never logs a token.
// values() feeds the hub's secret redactor (03 §17).

const crypto = require("node:crypto");
const { HubError } = require("./errors");

const SECRET_NAMESPACE = "hf";
const TOKEN_REF_PREFIX = "dlt_";
const TOKEN_REF_PATTERN = /^dlt_[a-z2-7]{16}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
// 03 §12: a token is released 7 days after its job failed.
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// A token put for a plan is not yet on any job. Sweeping must not drop it
// before the plan (cached for 10 minutes) is enqueued.
const UNREFERENCED_GRACE_MS = 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 512;
const RELEASED_STATES = new Set(["ready", "cancelled"]);

function randomBase32(chars) {
  const bytes = crypto.randomBytes(Math.ceil((chars * 5) / 8));
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < chars) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return output;
}

function newTokenRef() {
  return `${TOKEN_REF_PREFIX}${randomBase32(16)}`;
}

function isTokenRef(value) {
  return typeof value === "string" && TOKEN_REF_PATTERN.test(value);
}

function isoToMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * createTokenVault({ secretStore, clock, logger, graceMs }) →
 *   { put(token, { remember }) → Promise<tokenRef>, resolve(ref) → string|null,
 *     release(ref) → Promise<boolean>, values() → string[], has(ref) → boolean,
 *     sweep(jobs) → Promise<string[]> }
 * secretStore is the namespace-first view of 06 OPS-3
 * (`createSecretVault`: get/set/remove/list(namespace, …)); null means "remember
 * token" is unavailable and `remember` gives 422 `remember_unavailable`.
 */
function createTokenVault({ secretStore = null, clock = Date, logger = console, graceMs = UNREFERENCED_GRACE_MS } = {}) {
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  // tokenRef -> { token, remembered, createdAt }
  const memory = new Map();
  // Remembered refs whose store removal failed; sweep retries them.
  const failedRemovals = new Set();

  function storeHas(tokenRef) {
    try {
      return Boolean(secretStore && typeof secretStore.get === "function" && secretStore.get(SECRET_NAMESPACE, tokenRef));
    } catch {
      return false;
    }
  }

  async function removeFromStore(tokenRef) {
    if (!secretStore) return false;
    try {
      const remove = typeof secretStore.remove === "function" ? secretStore.remove : secretStore.clear;
      await remove.call(secretStore, SECRET_NAMESPACE, tokenRef);
      failedRemovals.delete(tokenRef);
      return true;
    } catch (error) {
      failedRemovals.add(tokenRef);
      logger?.warn?.(`[hub] could not delete remembered token ${tokenRef}: ${error?.code || "error"}`);
      return false;
    }
  }

  async function put(token, { remember = false } = {}) {
    const value = typeof token === "string" ? token.trim() : "";
    // Printable ASCII only: the value goes into a child-process env var.
    if (!value || value.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
      throw new HubError("invalid_token", "The Hugging Face token is empty or contains invalid characters.", { status: 422 });
    }
    if (remember && (!secretStore || typeof secretStore.set !== "function")) {
      throw new HubError("remember_unavailable", "Remembering a token needs the secret store, which is not available on this host.", { status: 422 });
    }
    let tokenRef = newTokenRef();
    while (memory.has(tokenRef)) tokenRef = newTokenRef();
    if (remember) {
      // The store write comes first: a failed write must not leave a ref that
      // looks remembered.
      await secretStore.set(SECRET_NAMESPACE, tokenRef, value);
    }
    memory.set(tokenRef, { token: value, remembered: Boolean(remember), createdAt: now() });
    return tokenRef;
  }

  function resolve(tokenRef) {
    if (!isTokenRef(tokenRef)) return null;
    const entry = memory.get(tokenRef);
    if (entry) return entry.token;
    // A remembered token survives a restart: it is read back from the store.
    if (!secretStore || typeof secretStore.get !== "function") return null;
    let value = "";
    try {
      value = secretStore.get(SECRET_NAMESPACE, tokenRef) || "";
    } catch {
      value = "";
    }
    if (!value) return null;
    memory.set(tokenRef, { token: value, remembered: true, createdAt: now() });
    return value;
  }

  async function release(tokenRef) {
    if (!isTokenRef(tokenRef)) return false;
    const entry = memory.get(tokenRef);
    memory.delete(tokenRef);
    // Anything that might be in the store goes too, even when this process
    // never saw the ref (a remembered token from before a restart).
    const remembered = Boolean(entry?.remembered) || storeHas(tokenRef) || failedRemovals.has(tokenRef);
    if (remembered) await removeFromStore(tokenRef);
    return Boolean(entry) || remembered;
  }

  /** Every token the redactor must hide: the in-memory ones and the remembered ones. */
  function values() {
    const found = new Set();
    for (const entry of memory.values()) found.add(entry.token);
    try {
      const stored = secretStore && typeof secretStore.values === "function" ? secretStore.values([SECRET_NAMESPACE]) : [];
      for (const value of stored || []) if (typeof value === "string" && value) found.add(value);
    } catch {
      // The redactor still has the in-memory values.
    }
    return Array.from(found);
  }

  function has(tokenRef) {
    return Boolean(isTokenRef(tokenRef) && (memory.has(tokenRef) || storeHas(tokenRef)));
  }

  function storedRefs() {
    try {
      const listed = secretStore && typeof secretStore.list === "function" ? secretStore.list(SECRET_NAMESPACE) : [];
      return (listed || []).map((item) => ({
        name: typeof item === "string" ? item : item?.name,
        createdAt: typeof item === "object" ? isoToMs(item?.createdAt) : null,
      })).filter((item) => isTokenRef(item.name));
    } catch {
      return [];
    }
  }

  /**
   * Releases the tokens no job needs any more (03 §12): jobs that are `ready`
   * or `cancelled`, jobs that failed more than 7 days ago, and refs no job
   * carries (a removed job) once they are older than the grace period.
   * Resolves to the released refs.
   */
  async function sweep(jobs) {
    const nowMs = now();
    const keep = new Set();
    const drop = new Set();
    for (const job of jobs ? Array.from(jobs.values ? jobs.values() : jobs) : []) {
      const ref = job?.transfer?.options?.tokenRef;
      if (!isTokenRef(ref)) continue;
      const state = String(job.state || "");
      const finishedMs = isoToMs(job.finishedAt) ?? isoToMs(job.updatedAt);
      const expiredFailure = state === "failed" && finishedMs !== null && nowMs - finishedMs >= FAILED_RETENTION_MS;
      if (RELEASED_STATES.has(state) || expiredFailure) drop.add(ref);
      else keep.add(ref);
    }
    const unreferenced = [];
    for (const [ref, entry] of memory) {
      if (!keep.has(ref) && !drop.has(ref) && nowMs - entry.createdAt >= graceMs) unreferenced.push(ref);
    }
    for (const item of storedRefs()) {
      if (keep.has(item.name) || drop.has(item.name) || memory.has(item.name)) continue;
      // Without a creation time the entry is not provably old: leave it.
      if (item.createdAt !== null && nowMs - item.createdAt >= graceMs) unreferenced.push(item.name);
    }
    const released = [];
    for (const ref of [...drop, ...unreferenced]) {
      if (keep.has(ref)) continue;
      await release(ref);
      released.push(ref);
    }
    for (const ref of Array.from(failedRemovals)) {
      if (!keep.has(ref)) await removeFromStore(ref);
    }
    return released;
  }

  return { put, resolve, release, values, has, sweep };
}

module.exports = {
  FAILED_RETENTION_MS,
  SECRET_NAMESPACE,
  TOKEN_REF_PATTERN,
  UNREFERENCED_GRACE_MS,
  createTokenVault,
  isTokenRef,
};
