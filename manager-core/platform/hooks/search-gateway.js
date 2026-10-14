"use strict";

// Hook of the search-gateway component (docs/overhaul/06-ops.md §3.4). It ports
// start-search-gateway.cmd:12-24. The keys come from the secret store through
// childEnv (search.apiKey, search.upstreamApiKey, V22); this hook reads no file
// and picks only the upstream the search container will call, in this order:
//   1. search.upstreamBaseUrl, when set;
//   2. the PUBLIC listener, http://host.docker.internal:<public port>/v1, when
//      it is enabled and an upstream key is set;
//   3. the entry admin route, when listeners.admin.lan is on;
//   4. the vLLM manager, only when managers.vllm.host is a wildcard address.
// When none applies the component is blocked{reason:"search-upstream-unreachable"}
// and doctor check net.search-upstream says why (V23). The container reaches
// the host through host.docker.internal, which is not loopback.

const CONTAINER_HOST = "host.docker.internal";
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);
const UPSTREAM_KEY_ENV = "UPSTREAM_API_KEY";
const UPSTREAM_KEY_SECRET = { namespace: "platform", name: "search.upstreamApiKey" };

function value(config, key) {
  if (typeof config?.get === "function") return config.get(key);
  return config?.values?.[key];
}

function hasUpstreamKey(ctx) {
  if (String(ctx.component?.env?.[UPSTREAM_KEY_ENV] || "").trim()) return true;
  try {
    return Boolean(ctx.secrets?.has?.(UPSTREAM_KEY_SECRET.namespace, UPSTREAM_KEY_SECRET.name));
  } catch {
    return false;
  }
}

/** -> { url, source } or null. source: "setting" | "public" | "admin-lan" | "vllm-manager". */
function chooseUpstream(ctx) {
  const config = ctx.config;
  const configured = String(value(config, "search.upstreamBaseUrl") || "").trim();
  if (configured) return { url: configured, source: "setting" };
  if (value(config, "listeners.public.enabled") === true && hasUpstreamKey(ctx)) {
    return { url: `http://${CONTAINER_HOST}:${value(config, "listeners.public.port")}/v1`, source: "public" };
  }
  if (value(config, "listeners.admin.lan") === true) {
    return { url: `http://${CONTAINER_HOST}:${value(config, "listeners.admin.port")}/gateway/auto/openai/v1`, source: "admin-lan" };
  }
  if (WILDCARD_HOSTS.has(String(value(config, "managers.vllm.host") || "").trim())) {
    return { url: `http://${CONTAINER_HOST}:${value(config, "managers.vllm.port")}/serve/v1`, source: "vllm-manager" };
  }
  return null;
}

/**
 * ctx: { config (loaded platform config), component? (the resolved entry),
 * secrets? (vault) }. -> { env: { UPSTREAM_BASE_URL }, upstream: { source } }
 * or { env: {}, blocked: { reason: "search-upstream-unreachable" } }.
 */
async function prepare(ctx = {}) {
  const upstream = chooseUpstream(ctx);
  if (!upstream) return { env: {}, blocked: { reason: "search-upstream-unreachable" } };
  return { env: { UPSTREAM_BASE_URL: upstream.url }, upstream: { source: upstream.source } };
}

module.exports = { CONTAINER_HOST, chooseUpstream, prepare };
