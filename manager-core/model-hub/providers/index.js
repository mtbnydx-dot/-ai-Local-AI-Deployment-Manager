"use strict";

// The hub's provider registry (03 §3.1, §4). A *source* (transport) is
// huggingface, hf-mirror or modelscope; a *namespace* is huggingface or
// modelscope. get(id) returns one concrete source. forNamespace(ns, policy)
// returns what the hub should ask for a namespace's metadata under the
// current sources policy: the official API with a one-shot mirror fallback
// (no credentials, reported as a warning), or the mirror alone.
//
// Providers are built on demand from the live settings, so a changed
// endpoint takes effect on the next call; the shared caches key on the
// endpoint and never on a token.

const { createSingleFlightCache } = require("../../single-flight-cache");
const { defaultSettings } = require("../settings");
const { ProviderError, isNetworkClassError } = require("./http");
const { createHuggingFaceProvider } = require("./huggingface");
const { createHfMirrorProvider } = require("./hf-mirror");
const { createModelScopeProvider } = require("./modelscope");

const PROVIDER_IDS = Object.freeze(["huggingface", "hf-mirror", "modelscope"]);
const NAMESPACES = Object.freeze(["huggingface", "modelscope"]);
const MIRROR_FALLBACK_CODE = "mirror_fallback";
// 03 §4.2: search 90 s, manifest 5 min, readme 30 min.
const CACHE_TTL_MS = Object.freeze({ search: 90 * 1000, manifest: 5 * 60 * 1000, readme: 30 * 60 * 1000 });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createDefaultCaches(clock) {
  const now = () => clock.now();
  return {
    search: createSingleFlightCache({ ttlMs: CACHE_TTL_MS.search, maxEntries: 48, now }),
    manifest: createSingleFlightCache({ ttlMs: CACHE_TTL_MS.manifest, maxEntries: 120, now }),
    readme: createSingleFlightCache({ ttlMs: CACHE_TTL_MS.readme, maxEntries: 60, now }),
  };
}

function mirrorFallbackWarning(primary, fallback, error) {
  return {
    code: MIRROR_FALLBACK_CODE,
    message: {
      zh: "Hugging Face 官方接口不可达，本次结果来自镜像站。",
      en: "The official Hugging Face API could not be reached; this result comes from the mirror.",
    },
    detail: `${error.code}${error.status ? ` (HTTP ${error.status})` : ""}`,
    from: primary.apiBase,
    to: fallback.apiBase,
  };
}

/**
 * Wraps the official provider with a one-shot retry against the mirror for
 * network-class failures (unreachable, timeout, 429, 502-504). The retry
 * carries no credentials, its result says where it came from (fetchedFrom)
 * and carries a mirror_fallback warning. Any other failure, and a
 * caller-initiated abort, is rethrown untouched. When the mirror fails too,
 * the original error is thrown with the mirror's code in details.fallback.
 */
function withMirrorFallback(primary, fallback) {
  async function run(operation, args) {
    try {
      return await primary[operation](...args);
    } catch (error) {
      if (!isNetworkClassError(error)) throw error;
      let result;
      try {
        result = await fallback[operation](...args);
      } catch (fallbackError) {
        error.details = { ...(error.details || {}), fallback: { code: String(fallbackError?.code || "error"), status: fallbackError?.status ?? null } };
        throw error;
      }
      return { ...result, warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), mirrorFallbackWarning(primary, fallback, error)] };
    }
  }
  return {
    id: primary.id,
    namespace: primary.namespace,
    apiBase: primary.apiBase,
    fileBase: primary.fileBase,
    sendsCredentials: primary.sendsCredentials,
    fetchImpl: primary.fetchImpl,
    fileUrl: primary.fileUrl,
    fallback,
    search: (...args) => run("search", args),
    getRepo: (...args) => run("getRepo", args),
    getReadme: (...args) => run("getReadme", args),
  };
}

/**
 * createProviders({ settings, fetchImpl, getHfToken, cache, clock,
 * timeoutMs }) → { get(id), forNamespace(namespace, policy), ids }.
 *
 * `settings` is the hub settings service (sync get()), a function returning
 * the settings, or a plain settings object. `getHfToken` (sync or async)
 * feeds the huggingface provider only. `cache` is `{ search, manifest,
 * readme }`, null to disable caching, or omitted for the default TTLs.
 */
function createProviders(options = {}) {
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getHfToken = typeof options.getHfToken === "function" ? options.getHfToken : () => "";
  const cache = options.cache === null ? null : options.cache || createDefaultCaches(clock);
  const timeoutMs = options.timeoutMs;
  const instances = new Map();

  function currentSources() {
    const defaults = defaultSettings().sources;
    const source = options.settings;
    const value = typeof source === "function" ? source() : typeof source?.get === "function" ? source.get() : source;
    if (value && typeof value.then === "function") throw new TypeError("createProviders needs synchronous settings");
    const sources = isPlainObject(value?.sources) ? value.sources : isPlainObject(value) ? value : {};
    return {
      policy: ["huggingface", "hf-mirror", "auto"].includes(sources.policy) ? sources.policy : defaults.policy,
      hfEndpoint: String(sources.hfEndpoint || defaults.hfEndpoint),
      mirrorEndpoint: String(sources.mirrorEndpoint || defaults.mirrorEndpoint),
      modelScopeEndpoint: String(sources.modelScopeEndpoint || defaults.modelScopeEndpoint),
    };
  }

  function memo(id, endpoint, build) {
    const key = `${id}|${endpoint}`;
    if (!instances.has(key)) instances.set(key, build());
    return instances.get(key);
  }

  function get(id) {
    const sources = currentSources();
    if (id === "huggingface") {
      return memo(id, sources.hfEndpoint, () => createHuggingFaceProvider({
        id, endpoint: sources.hfEndpoint, fetchImpl, getToken: getHfToken, cache, clock, timeoutMs,
      }));
    }
    if (id === "hf-mirror") {
      return memo(id, sources.mirrorEndpoint, () => createHfMirrorProvider({ endpoint: sources.mirrorEndpoint, fetchImpl, cache, clock, timeoutMs }));
    }
    if (id === "modelscope") {
      // Without an injected fetch, metadata goes through the system-proxy fallback.
      return memo(id, sources.modelScopeEndpoint, () => createModelScopeProvider({ endpoint: sources.modelScopeEndpoint, fetchImpl: options.fetchImpl, cache, clock, timeoutMs }));
    }
    throw new ProviderError("unknown_provider", `Unknown provider "${String(id).slice(0, 40)}".`, { baseCode: "unknown", details: { provider: String(id).slice(0, 40) } });
  }

  function forNamespace(namespace, policy) {
    if (!NAMESPACES.includes(namespace)) {
      throw new ProviderError("unknown_provider", `Unknown namespace "${String(namespace).slice(0, 40)}".`, { baseCode: "unknown", details: { namespace: String(namespace).slice(0, 40) } });
    }
    if (namespace === "modelscope") return get("modelscope");
    const effective = policy || currentSources().policy;
    if (effective === "hf-mirror") return get("hf-mirror");
    // "huggingface" and "auto": official first, the mirror as the fallback.
    return withMirrorFallback(get("huggingface"), get("hf-mirror"));
  }

  return { get, forNamespace, ids: PROVIDER_IDS, cache };
}

module.exports = {
  CACHE_TTL_MS,
  MIRROR_FALLBACK_CODE,
  NAMESPACES,
  PROVIDER_IDS,
  createProviders,
  withMirrorFallback,
};
