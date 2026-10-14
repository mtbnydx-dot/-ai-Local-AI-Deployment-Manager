// Query cache (07 §3.5). Pure and DOM-free; ui/hooks.js binds it to Preact.
//
// Keys are arrays such as ["m", "vllm", "jobs"]. Concurrent fetches of one
// key share a single promise, a fresh entry is served from memory for its
// TTL, and invalidate() takes a key prefix so one event can mark a family of
// views stale. The cache never rewrites server state optimistically: data
// comes from a fetch, an event payload (set) or nothing.

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const name of Object.keys(value).sort()) {
      if (value[name] !== undefined) out[name] = normalize(value[name]);
    }
    return out;
  }
  return value;
}

/** JSON of `parts` with object keys sorted, so equal queries give equal keys. */
export function stableKey(parts) {
  return JSON.stringify(normalize(Array.isArray(parts) ? parts : [parts]));
}

function startsWith(keyParts, prefixParts) {
  if (prefixParts.length > keyParts.length) return false;
  return prefixParts.every((part, index) => stableKey([part]) === stableKey([keyParts[index]]));
}

/**
 * @returns {{ fetch, get, set, invalidate, subscribe, gc, keys }}
 */
export function createQueryCache({ now = Date.now } = {}) {
  const entries = new Map();

  function entryOf(key) {
    const id = stableKey(key);
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        key: Array.isArray(key) ? [...key] : [key],
        data: undefined,
        error: null,
        status: "idle",
        updatedAt: null,
        ttlMs: 0,
        invalidated: false,
        generation: 0,
        promise: null,
        subscribers: new Set(),
        touchedAt: now(),
      };
      entries.set(id, entry);
    }
    entry.touchedAt = now();
    return entry;
  }

  function snapshot(entry) {
    const age = entry.updatedAt === null ? Infinity : now() - entry.updatedAt;
    return {
      data: entry.data,
      error: entry.error,
      status: entry.status,
      updatedAt: entry.updatedAt,
      stale: entry.invalidated || entry.updatedAt === null || age >= entry.ttlMs,
      invalidated: entry.invalidated,
      fetching: Boolean(entry.promise),
    };
  }

  function emit(entry) {
    const view = snapshot(entry);
    for (const fn of [...entry.subscribers]) {
      try {
        fn(view);
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
  }

  /** Runs `fn` unless a fresh value exists; concurrent calls share one promise. */
  function fetchQuery(key, fn, { ttlMs = 5000, force = false } = {}) {
    const entry = entryOf(key);
    entry.ttlMs = ttlMs;
    if (entry.promise) return entry.promise;
    if (!force && entry.status === "success" && !snapshot(entry).stale) return Promise.resolve(entry.data);
    if (entry.status !== "success") entry.status = "loading";
    const generation = entry.generation;
    // fn runs now; a synchronous throw becomes a rejection.
    const promise = new Promise((resolve) => resolve(fn()))
      .then((data) => {
        entry.data = data;
        entry.error = null;
        entry.status = "success";
        entry.updatedAt = now();
        // An invalidation that arrived while the request ran still stands.
        entry.invalidated = entry.generation !== generation;
        return data;
      }, (error) => {
        entry.error = error;
        entry.status = "error";
        // The attempt answers the invalidation; the next poll or event retries.
        if (entry.generation === generation) entry.invalidated = false;
        throw error;
      })
      .finally(() => {
        if (entry.promise === promise) entry.promise = null;
        emit(entry);
      });
    entry.promise = promise;
    emit(entry);
    return promise;
  }

  function get(key) {
    return snapshot(entryOf(key));
  }

  /** Stores data from an event or a mutation answer; an updater gets the previous data. */
  function set(key, dataOrUpdater) {
    const entry = entryOf(key);
    entry.data = typeof dataOrUpdater === "function" ? dataOrUpdater(entry.data) : dataOrUpdater;
    entry.error = null;
    entry.status = "success";
    entry.updatedAt = now();
    entry.invalidated = false;
    emit(entry);
  }

  /**
   * Marks every key starting with `prefix` stale (`exact` limits it to the
   * key itself) and tells subscribers, which refetch. Returns the count.
   */
  function invalidate(prefix = [], { exact = false } = {}) {
    const parts = Array.isArray(prefix) ? prefix : [prefix];
    const id = stableKey(parts);
    let count = 0;
    for (const [entryId, entry] of entries) {
      if (exact ? entryId !== id : !startsWith(entry.key, parts)) continue;
      entry.invalidated = true;
      entry.generation += 1;
      count += 1;
      emit(entry);
    }
    return count;
  }

  function subscribe(key, fn) {
    const entry = entryOf(key);
    entry.subscribers.add(fn);
    return () => {
      entry.subscribers.delete(fn);
      entry.touchedAt = now();
    };
  }

  /** Drops entries nobody watches or fetches that were idle for `maxIdleMs`. */
  function gc(maxIdleMs = 300000) {
    let removed = 0;
    const limit = now() - maxIdleMs;
    for (const [id, entry] of entries) {
      if (entry.subscribers.size || entry.promise || entry.touchedAt > limit) continue;
      entries.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** The keys currently held, for event fan-out over parameterised keys. */
  function keys(prefix = []) {
    const parts = Array.isArray(prefix) ? prefix : [prefix];
    return [...entries.values()].filter((entry) => startsWith(entry.key, parts)).map((entry) => [...entry.key]);
  }

  return { fetch: fetchQuery, get, set, invalidate, subscribe, gc, keys };
}

/** A value with change notification (role, connection state): { get(), set(value), subscribe(fn) → off }. */
export function createSignal(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of [...listeners]) {
        try {
          fn(value);
        } catch {
          // One broken listener must not starve the others.
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
