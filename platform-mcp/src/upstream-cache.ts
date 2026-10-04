/**
 * Short-lived read-through cache with in-flight coalescing for idempotent
 * upstream GETs.
 *
 * One agent turn routinely calls several tools that read the same manager
 * endpoint: `/api/fleet` backs the overview, the running-model list, GPU
 * status, and the memory estimate, and the search gateway's `/health` backs
 * the overview, the search health check, and the security posture. Without
 * this, a single question costs the managers three or four identical requests.
 *
 * Failures are coalesced but never stored, so a manager that comes back up is
 * visible on the next call instead of after the TTL.
 */

export type UpstreamCacheStats = {
  hits: number;
  misses: number;
  coalesced: number;
  entries: number;
};

type Entry = {
  storedAt: number;
  value: unknown;
};

export class UpstreamCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private coalesced = 0;

  constructor(options: { ttlMs: number; maxEntries?: number; now?: () => number }) {
    this.ttlMs = Math.max(0, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries ?? 64);
    this.now = options.now ?? Date.now;
  }

  async run<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.ttlMs > 0) {
      const entry = this.entries.get(key);
      if (entry && this.now() - entry.storedAt < this.ttlMs) {
        this.hits += 1;
        return clone(entry.value) as T;
      }
      if (entry) this.entries.delete(key);
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.coalesced += 1;
      return clone(await pending) as T;
    }

    this.misses += 1;
    // The shared promise is what later callers await, so it has to be
    // registered before the first `await` yields to them.
    const task = loader();
    this.inflight.set(key, task as Promise<unknown>);
    try {
      const value = await task;
      if (this.ttlMs > 0) this.store(key, value);
      return clone(value) as T;
    } finally {
      this.inflight.delete(key);
    }
  }

  stats(): UpstreamCacheStats {
    return { hits: this.hits, misses: this.misses, coalesced: this.coalesced, entries: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
  }

  private store(key: string, value: unknown): void {
    this.entries.set(key, { storedAt: this.now(), value });
    // Insertion order makes the oldest key the first one Map iterates.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Hands every caller its own copy. Upstream payloads are passed to mappers
 * that are expected to only read them, but a shared reference would turn any
 * future mutation into a cross-tool bug that only appears under caching.
 */
function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}
