"use strict";

// Small TTL cache with single-flight loading. Concurrent callers of the same
// key share one in-flight promise; a fresh value is served without touching
// the loader. Designed for the hot status paths where every poll used to
// spawn docker/nvidia-smi processes or re-read log files.
function createSingleFlightCache(options = {}) {
  const defaultTtlMs = Math.max(0, Number(options.ttlMs || 2000));
  const maxEntries = Math.max(1, Number(options.maxEntries || 200));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const entries = new Map();

  function pruneIfNeeded() {
    if (entries.size <= maxEntries) return;
    // Map preserves insertion order; drop the oldest entries first.
    const excess = entries.size - maxEntries;
    let dropped = 0;
    for (const key of entries.keys()) {
      if (dropped >= excess) break;
      entries.delete(key);
      dropped += 1;
    }
  }

  async function get(key, loader, getOptions = {}) {
    const cacheKey = String(key);
    const ttlMs = Math.max(0, Number(getOptions.ttlMs ?? defaultTtlMs));
    const at = now();
    const cached = entries.get(cacheKey);
    if (!getOptions.force && cached) {
      if (cached.expiresAt > at && "value" in cached) return cached.value;
      if (cached.promise) return cached.promise;
    }
    const promise = Promise.resolve().then(loader);
    entries.set(cacheKey, {
      ...(cached && "value" in cached ? { value: cached.value } : {}),
      expiresAt: cached?.expiresAt || 0,
      promise,
    });
    pruneIfNeeded();
    try {
      const value = await promise;
      entries.set(cacheKey, { value, expiresAt: now() + ttlMs, promise: null });
      return value;
    } catch (error) {
      // A failed load must not pin the error; the next caller retries.
      const current = entries.get(cacheKey);
      if (current?.promise === promise) {
        if ("value" in current) entries.set(cacheKey, { value: current.value, expiresAt: current.expiresAt, promise: null });
        else entries.delete(cacheKey);
      }
      throw error;
    }
  }

  function invalidate(key) {
    if (key === undefined) {
      entries.clear();
      return;
    }
    entries.delete(String(key));
  }

  function wrap(key, fn, wrapOptions = {}) {
    return (...args) => get(
      args.length ? `${key}:${JSON.stringify(args)}` : key,
      () => fn(...args),
      wrapOptions,
    );
  }

  return { get, invalidate, wrap, size: () => entries.size };
}

module.exports = { createSingleFlightCache };
