const DEFAULT_SUBSCRIPTION_PROXY_BASE_URL = "http://127.0.0.1:8317";
const SUBSCRIPTION_PROXY_DOCS_URL = "https://help.router-for.me/";

function normalizeSubscriptionProxyBaseUrl(value) {
  const raw = String(value || DEFAULT_SUBSCRIPTION_PROXY_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CLIPROXY_BASE_URL must be a valid http or https URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("CLIPROXY_BASE_URL must use http or https.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("CLIPROXY_BASE_URL must not contain credentials, query parameters, or fragments.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "") || "/";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeSubscriptionProxyConfig(env = process.env) {
  const enabledValue = String(env.CLIPROXY_ENABLED ?? "1").trim().toLowerCase();
  const enabled = !["0", "false", "off", "no"].includes(enabledValue);
  const baseUrl = normalizeSubscriptionProxyBaseUrl(env.CLIPROXY_BASE_URL);
  const parsed = new URL(baseUrl);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const timeoutValue = Number(env.CLIPROXY_STATUS_TIMEOUT_MS || 2500);
  const statusTimeoutMs = Math.min(10000, Math.max(250, Number.isFinite(timeoutValue) ? timeoutValue : 2500));
  return {
    enabled,
    provider: "CLIProxyAPI",
    baseUrl,
    statusTimeoutMs,
    authMode: "passthrough",
    upstreamScope: loopbackHosts.has(parsed.hostname.toLowerCase()) ? "loopback" : "remote",
    docsUrl: SUBSCRIPTION_PROXY_DOCS_URL,
  };
}

function buildSubscriptionProxyPath(protocol, rest = "") {
  if (!["openai", "claude", "codex", "opencode"].includes(String(protocol || "").toLowerCase())) {
    return "";
  }
  const raw = String(rest || "").replace(/^\/+/, "");
  const segments = raw ? raw.split("/") : [];
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Subscription proxy path contains invalid encoding.");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Subscription proxy path contains an unsafe segment.");
    }
  }
  const suffix = raw.replace(/^v1\/?/i, "");
  return `/v1${suffix ? `/${suffix}` : ""}`;
}

function buildSubscriptionProxyTarget(baseUrl, routePath, search = "") {
  const normalizedBase = normalizeSubscriptionProxyBaseUrl(baseUrl);
  const path = String(routePath || "");
  if (!path.startsWith("/v1")) throw new Error("Subscription proxy target path must start with /v1.");
  const target = new URL(`${normalizedBase}${path}`);
  target.search = String(search || "");
  return target;
}

function buildSubscriptionProxyGatewayUrls(options = {}) {
  const entryPort = Number(options.entryPort || 5176);
  const localBase = `http://127.0.0.1:${entryPort}`;
  const lanAddress = String(options.lanAddress || "").trim();
  const entryHost = String(options.entryHost || "127.0.0.1").trim();
  const lanBase = entryHost === "127.0.0.1" || entryHost === "localhost" || !lanAddress
    ? null
    : `http://${lanAddress}:${entryPort}`;
  const publicBase = String(options.publicBaseUrl || "").trim().replace(/\/+$/, "") || null;
  const forBase = (base) => base ? {
    openAi: `${base}/gateway/subscription/openai/v1`,
    claude: `${base}/gateway/subscription/claude`,
    codex: `${base}/gateway/subscription/codex/v1`,
    openCode: `${base}/gateway/subscription/opencode/v1`,
  } : null;
  return {
    local: forBase(localBase),
    lan: forBase(lanBase),
    public: forBase(publicBase),
  };
}

function extractSubscriptionProxyModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return rows
    .map((item) => typeof item === "string" ? item : item?.id)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

module.exports = {
  DEFAULT_SUBSCRIPTION_PROXY_BASE_URL,
  SUBSCRIPTION_PROXY_DOCS_URL,
  buildSubscriptionProxyGatewayUrls,
  buildSubscriptionProxyPath,
  buildSubscriptionProxyTarget,
  extractSubscriptionProxyModels,
  normalizeSubscriptionProxyBaseUrl,
  normalizeSubscriptionProxyConfig,
};
