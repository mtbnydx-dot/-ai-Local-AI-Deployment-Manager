"use strict";

// ExternalHost (01 §13, §20): the RuntimeHost for registered OpenAI-compatible
// endpoints. There is no create and no stop; the host only answers three
// questions about an endpoint record: is it healthy (GET {base}/models, 3 s,
// plus Ollama's /api/ps), which models does it offer (allow list and aliases
// applied), and what exactly may be sent upstream (resolveUpstream).
//
// Every call that leaves the machine goes through guardedFetch: the target
// host is checked again (a name that now resolves to a link-local or metadata
// address is refused), redirects are never followed, and the response size is
// capped. Client headers are never forwarded except the allowlist below; the
// stored key (secret store namespace engines.external, name = endpointId) is
// the only authorization an upstream sees.

const dns = require("node:dns");
const net = require("node:net");

const adapter = require("../adapters/external");

const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_INTERVAL_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FORWARDED_HEADERS = Object.freeze(["content-type", "accept", "x-request-id"]);
const MAX_HEADER_VALUE = 512;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hostError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

// The key of an endpoint, or "" when none is stored. A secret store failure
// is thrown to the caller as secret_store_unavailable.
function readKey(secrets, endpoint) {
  if (!endpoint?.apiKeyRef || !secrets || typeof secrets.get !== "function") return "";
  try {
    const value = secrets.get(adapter.SECRET_NAMESPACE, endpoint.endpointId);
    return typeof value === "string" ? value : "";
  } catch {
    throw hostError("secret_store_unavailable", "The secret store could not be read.", 503);
  }
}

// Only the allowlisted client headers, then the stored key as Bearer.
function buildUpstreamHeaders(secrets, endpoint, incoming) {
  const headers = {};
  if (isPlainObject(incoming)) {
    for (const [name, value] of Object.entries(incoming)) {
      const key = name.toLowerCase();
      if (!FORWARDED_HEADERS.includes(key)) continue;
      const text = Array.isArray(value) ? value[0] : value;
      if (typeof text !== "string" || !text || text.length > MAX_HEADER_VALUE || /[\u0000-\u001f\u007f]/.test(text)) continue;
      headers[key] = text;
    }
  }
  const key = readKey(secrets, endpoint);
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

// base + a path below it. The path may carry a query string; it may not leave
// the base (no scheme, no host, no dot segments).
function joinUpstreamUrl(endpoint, path) {
  const text = String(path ?? "");
  if (!text.startsWith("/") || text.startsWith("//") || /[\\\u0000-\u001f\u007f\s#]/.test(text)) {
    throw hostError("invalid_path", "The upstream path must start with a single / and stay below the endpoint.", 400);
  }
  const cut = text.indexOf("?");
  const pathPart = cut < 0 ? text : text.slice(0, cut);
  const query = cut < 0 ? "" : text.slice(cut);
  for (const segment of pathPart.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw hostError("invalid_path", "The upstream path is not valid.", 400);
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw hostError("invalid_path", "The upstream path may not contain dot segments.", 400);
    }
  }
  return `${endpoint.baseUrl.replace(/\/+$/, "")}${pathPart}${query}`;
}

// Ollama keeps /api/ps beside /v1, not below it.
function ollamaRoot(endpoint) {
  const url = new URL(endpoint.baseUrl);
  return `${url.origin}${url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "")}`;
}

function parseOllamaPs(body) {
  const rows = Array.isArray(body?.models) ? body.models : [];
  const models = rows.filter(isPlainObject).map((row) => ({
    name: String(row.name || row.model || ""),
    sizeBytes: Number.isFinite(Number(row.size)) ? Number(row.size) : null,
    sizeVramBytes: Number.isFinite(Number(row.size_vram)) ? Number(row.size_vram) : null,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
  })).filter((row) => row.name);
  const totalVramBytes = models.reduce((sum, row) => sum + (row.sizeVramBytes || 0), 0);
  return { models, totalVramBytes };
}

// The ids the endpoint offers, with the allow list and aliases applied (01 §20).
function applyModelRules(endpoint, discoveredIds) {
  const rules = endpoint.models || {};
  const allow = Array.isArray(rules.allow) ? rules.allow : [];
  const aliases = isPlainObject(rules.aliases) ? rules.aliases : {};
  const discovered = rules.discover === false ? [] : discoveredIds;
  const ids = allow.length
    ? (rules.discover === false ? allow : discovered.filter((id) => allow.includes(id)))
    : discovered;
  const out = [...new Set(ids)].map((id) => ({ id, upstreamId: id, alias: false }));
  const known = new Set(out.map((item) => item.id));
  for (const [alias, target] of Object.entries(aliases)) {
    // An alias is offered when its target is offered, or when nothing is discovered (discover:false).
    if (known.has(alias)) continue;
    if (rules.discover === false || known.has(target)) {
      out.push({ id: alias, upstreamId: target, alias: true });
      known.add(alias);
    }
  }
  return out;
}

/**
 * createExternalHost({ secrets, fetch, lookup, now, timeoutMs, intervalMs, logger })
 * `secrets` is a vault with get(namespace, name) (manager-core/secret-store
 * createSecretVault). `fetch` and `lookup` exist for tests.
 */
function createExternalHost(options = {}) {
  const secrets = options.secrets || null;
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const lookup = typeof options.lookup === "function" ? options.lookup : defaultLookup;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : HEALTH_TIMEOUT_MS;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : HEALTH_INTERVAL_MS;
  const healthByEndpoint = new Map();
  let timer = null;
  let sweeping = false;

  // Refuses a link-local, metadata or unspecified address, and a host name that
  // resolves to one. A name that does not resolve throws dns_failed.
  async function assertAllowedTarget(url) {
    const target = new URL(url);
    if (adapter.isBlockedHost(target.hostname)) {
      throw hostError("blocked_address", "The endpoint address is link-local, metadata or unspecified.", 400);
    }
    const bare = target.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bare) || target.hostname === "localhost" || target.hostname.endsWith(".localhost")) return target;
    let found;
    try {
      found = await lookup(bare);
    } catch {
      throw hostError("dns_failed", "The endpoint host name could not be resolved.");
    }
    const addresses = (Array.isArray(found) ? found : [found]).map((item) => (typeof item === "string" ? item : item?.address)).filter(Boolean);
    if (!addresses.length) throw hostError("dns_failed", "The endpoint host name could not be resolved.");
    if (addresses.some((address) => adapter.isBlockedHost(address))) {
      throw hostError("blocked_address", "The endpoint host name resolves to a blocked address.", 400);
    }
    return target;
  }

  // The one place a request leaves for an endpoint.
  async function guardedFetch(url, init = {}) {
    const target = await assertAllowedTarget(url);
    if (typeof fetchImpl !== "function") throw hostError("fetch_unavailable", "No HTTP client is available.", 500);
    let response;
    try {
      response = await fetchImpl(target, {
        method: init.method || "GET",
        headers: init.headers || {},
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs || timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw hostError("timeout", "The endpoint did not answer in time.", 504);
      throw hostError("unreachable", "The endpoint could not be reached.");
    }
    if (response.status >= 300 && response.status < 400) throw hostError("redirect_blocked", "The endpoint answered with a redirect, which is not followed.");
    return response;
  }

  async function readJson(response) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw hostError("response_too_large", "The endpoint response is too large.");
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  /** → { url, headers }: what may be sent upstream for `path` (relative to baseUrl). */
  function resolveUpstream(endpoint, path, requestOptions = {}) {
    if (!isPlainObject(endpoint) || typeof endpoint.baseUrl !== "string") throw hostError("invalid_endpoint", "The endpoint has no baseUrl.", 400);
    return { url: joinUpstreamUrl(endpoint, path), headers: buildUpstreamHeaders(secrets, endpoint, requestOptions.headers) };
  }

  /** GET {base}/models → [{ id, upstreamId, alias }] with the allow and alias rules applied. */
  async function listModels(endpoint) {
    const upstream = resolveUpstream(endpoint, "/models", { headers: { accept: "application/json" } });
    if (endpoint.models?.discover === false) return applyModelRules(endpoint, []);
    const response = await guardedFetch(upstream.url, { headers: upstream.headers });
    if (response.status === 401 || response.status === 403) throw hostError("unauthorized", "The endpoint refused the key.", 401);
    if (!response.ok) throw hostError("bad_status", `The endpoint answered HTTP ${response.status}.`);
    const body = await readJson(response);
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const ids = rows.map((row) => (typeof row === "string" ? row : row?.id || row?.name)).filter((id) => typeof id === "string" && id);
    return applyModelRules(endpoint, ids);
  }

  /**
   * health(endpoint) → { state: ready|unauthorized|unreachable|error, ok, latencyMs, status,
   * models, checkedAt, error?, ollama? }. Never throws; `ollama` is {models, totalVramBytes}
   * for kind "ollama" when /api/ps answered.
   */
  async function health(endpoint) {
    const started = now();
    const result = { state: "error", ok: false, latencyMs: null, status: null, models: null, checkedAt: new Date(started).toISOString() };
    let upstream;
    try {
      upstream = resolveUpstream(endpoint, "/models", { headers: { accept: "application/json" } });
      const response = await guardedFetch(upstream.url, { headers: upstream.headers });
      result.latencyMs = Math.max(0, now() - started);
      result.status = response.status;
      if (response.ok) {
        const body = await readJson(response);
        const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
        result.models = rows ? rows.length : null;
        result.state = "ready";
        result.ok = true;
      } else if (response.status === 401 || response.status === 403) {
        result.state = "unauthorized";
        result.error = "unauthorized";
      } else {
        result.error = `http_${response.status}`;
      }
    } catch (error) {
      result.latencyMs = Math.max(0, now() - started);
      result.state = error?.code === "timeout" || error?.code === "unreachable" || error?.code === "dns_failed" ? "unreachable" : "error";
      result.error = String(error?.code || "error");
    }
    if (result.ok && endpoint.kind === "ollama") {
      try {
        const headers = buildUpstreamHeaders(secrets, endpoint, { accept: "application/json" });
        const ps = await guardedFetch(`${ollamaRoot(endpoint)}/api/ps`, { headers });
        if (ps.ok) result.ollama = parseOllamaPs(await readJson(ps));
      } catch {
        // /api/ps is display data; the endpoint stays ready without it.
      }
    }
    return result;
  }

  /** health() plus caching, for the 30 s monitor and the routes. */
  async function checkNow(endpoint) {
    const result = await health(endpoint);
    healthByEndpoint.set(endpoint.endpointId, result);
    return result;
  }

  function healthOf(endpointId) {
    return healthByEndpoint.get(endpointId) || null;
  }

  function forget(endpointId) {
    healthByEndpoint.delete(endpointId);
  }

  async function sweep(listEndpoints) {
    if (sweeping) return;
    sweeping = true;
    try {
      const endpoints = (await listEndpoints()).filter((item) => item && item.enabled !== false);
      const live = new Set(endpoints.map((item) => item.endpointId));
      for (const id of [...healthByEndpoint.keys()]) if (!live.has(id)) healthByEndpoint.delete(id);
      await Promise.all(endpoints.map((item) => checkNow(item).catch(() => {})));
    } catch {
      // A failed sweep keeps the last answers; the next tick tries again.
    } finally {
      sweeping = false;
    }
  }

  /** Checks all enabled endpoints now and then every 30 s. listEndpoints() → records. */
  function startMonitor(listEndpoints) {
    if (timer) return;
    sweep(listEndpoints);
    timer = setInterval(() => sweep(listEndpoints), intervalMs);
    timer.unref?.();
  }

  function stopMonitor() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** The fleet instance of an endpoint (01 §20): external:<endpointId>, state from health. */
  function buildInstance(endpoint, healthResult = healthOf(endpoint.endpointId)) {
    const declared = adapter.declaredCapabilities(null, { endpoint });
    const state = !healthResult ? "loading" : healthResult.ok ? "ready" : "stopped";
    return {
      fleetId: adapter.fleetIdOf(endpoint.endpointId),
      id: endpoint.endpointId,
      managerId: "entry",
      engineId: adapter.ENGINE_ID,
      engineFamily: "openai-server",
      label: endpoint.label,
      runtime: { id: `external@${endpoint.kind}`, version: null, image: null, digest: null },
      lifecycle: { state, phase: state === "ready" ? "ready" : "probe", percent: state === "ready" ? 100 : 0, since: healthResult?.checkedAt || null },
      capabilities: declared.capabilities,
      apiSurface: declared.apiSurface,
      vramReservationMb: 0,
      gpuIds: [],
    };
  }

  return {
    kind: "external",
    id: "external",
    assertAllowedTarget,
    guardedFetch,
    resolveUpstream,
    listModels,
    health,
    checkNow,
    healthOf,
    forget,
    startMonitor,
    stopMonitor,
    buildInstance,
    /** { ok, version, detail, started:false } for `endpoint`: GET {base}/models, 3 s. */
    async ready({ endpoint } = {}) {
      if (!endpoint) return { ok: false, version: null, detail: "no endpoint", started: false };
      const result = await health(endpoint);
      const probed = result.ok ? await adapter.probeVersion(endpoint, (url, init) => guardedFetch(url, init)).catch(() => null) : null;
      return { ok: result.ok, version: probed?.version || null, detail: result.ok ? "ready" : result.error || result.state, started: false };
    },
    async imagePresent() {
      return null;
    },
    /** An external endpoint is never created or removed by the platform. */
    async stop() {
      return { ok: false, status: 405, code: "external_not_managed", message: "An external endpoint is not managed by the platform; remove it from the registry instead." };
    },
  };
}

module.exports = {
  FORWARDED_HEADERS,
  HEALTH_INTERVAL_MS,
  HEALTH_TIMEOUT_MS,
  applyModelRules,
  createExternalHost,
  ollamaRoot,
  parseOllamaPs,
};
