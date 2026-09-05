"use strict";

// service-entry is the single policy enforcement point for the unified gateway.
//
// Previously it was a bare proxy: no Host/Origin checks, reflected CORS, and it
// relied on each manager to authenticate. That layering is what let a LAN
// client reach a manager configured as "local only", because the manager saw
// the proxy's loopback address. Auth now runs here, before the hop, and the
// managers verify a signed trust header instead of guessing from the socket.
//
// Two escape hatches are deliberate and configurable, because this platform is
// also used on trusted home LANs:
//   SERVICE_ENTRY_REQUIRE_API_KEY = auto | 1 | 0
//   SERVICE_ENTRY_ALLOW_LAN_ADMIN = 0 | 1

const path = require("node:path");
const core = require("../../manager-core");

const MANAGEMENT_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const KEY_STORE_CACHE_MS = 5000;

function envText(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function envFlag(name, fallback = false) {
  const value = envText(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeRequireApiKeyMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(mode)) return "off";
  if (["1", "true", "yes", "on"].includes(mode)) return "on";
  return "auto";
}

function createEntrySecurity(options = {}) {
  const host = String(options.host || "127.0.0.1");
  const aiRoot = options.aiRoot || path.dirname(__dirname);
  const managers = Array.isArray(options.managers) ? options.managers : [];
  const getLanAddress = typeof options.getLanAddress === "function" ? options.getLanAddress : () => "";
  // Minted in memory up front so proxied requests are always signed. Publishing
  // it to disk can fail (permissions, read-only root) and that must not leave
  // the hop unsigned -- an unsigned hop is treated as untrusted downstream,
  // which would break every local-mode request instead of just the managers
  // that were started outside this process.
  let trustToken = options.trustToken || core.generateGatewayTrustToken();
  let keyStoreCache = { value: null, expiresAt: 0, promise: null };

  // Reachable from off-box: anything other than a loopback bind.
  const lanMode = !["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());

  function policy() {
    const requireApiKeyMode = normalizeRequireApiKeyMode(envText("SERVICE_ENTRY_REQUIRE_API_KEY", "auto"));
    const allowLanAdmin = envFlag("SERVICE_ENTRY_ALLOW_LAN_ADMIN", false);
    const allowedOrigins = envText("SERVICE_ENTRY_ALLOWED_ORIGINS")
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    // 配置了公网 Base URL 即声明了公网暴露：即使入口只绑回环（流量经 Caddy
    // 转发进来），auto 模式也必须要求 API Key，否则公网 /gateway 就是无鉴权算力。
    const publicMode = Boolean(core.extractHostname(envText("SERVICE_ENTRY_PUBLIC_BASE_URL")));
    return {
      lanMode,
      publicMode,
      host,
      // "auto" only demands a key when the entry is actually reachable off-box
      // (LAN bind or declared public deployment), so a loopback-only install
      // stays zero-config.
      requireApiKey: requireApiKeyMode === "on" || (requireApiKeyMode === "auto" && (lanMode || publicMode)),
      requireApiKeyMode,
      allowLanAdmin,
      allowedOrigins,
      corsMode: allowedOrigins.length ? "restricted" : "deny",
    };
  }

  function allowedHostnames() {
    const names = new Set(["127.0.0.1", "localhost", "::1", host.toLowerCase()]);
    try {
      const lan = String(getLanAddress() || "").toLowerCase();
      if (lan) names.add(lan);
    } catch {
      // Interface enumeration failed; loopback names still apply.
    }
    // 配置了公网 Base URL 就意味着 Caddy 会带着该域名的 Host 转发过来；
    // 不自动放行的话，照 deploy/public 部署会全站 403。
    const publicHost = core.extractHostname(envText("SERVICE_ENTRY_PUBLIC_BASE_URL"));
    if (publicHost) names.add(publicHost);
    const extra = envText("SERVICE_ENTRY_ALLOWED_HOSTS")
      .split(/[;,]/)
      .map((item) => core.extractHostname(item.trim()))
      .filter(Boolean);
    for (const name of extra) names.add(name);
    return names;
  }

  // --- Host / Origin guard (S2) -------------------------------------------

  function checkRequest(req, url) {
    const hostname = core.extractHostname(req.headers?.host);
    if (!hostname || !allowedHostnames().has(hostname)) {
      return { ok: false, status: 403, code: "host_not_allowed", message: `Host is not allowed: ${hostname || "(empty)"}` };
    }
    const method = String(req.method || "GET").toUpperCase();
    const origin = String(req.headers?.origin || "").trim();
    // Cross-site POSTs from a page the user happens to have open are the
    // realistic attack here, so mutating requests must carry a same-site Origin.
    if (!MANAGEMENT_SAFE_METHODS.has(method) && origin) {
      const originHost = core.extractHostname(origin);
      if (origin === "null" || !originHost || !allowedHostnames().has(originHost)) {
        return { ok: false, status: 403, code: "origin_not_allowed", message: "Cross-site request rejected (Origin check failed)." };
      }
    }
    return { ok: true };
  }

  function isGatewayPath(url) {
    return String(url?.pathname || "").startsWith("/gateway/");
  }

  // --- Management endpoint guard (S1) --------------------------------------

  // Requests that came through a reverse proxy (Caddy in deploy/public) reach
  // this process from 127.0.0.1, so the socket address alone would wrongly
  // promote every public client to "local". Any forwarded-* header marks the
  // request as proxied; headers can only be added by the proxy, so this can
  // demote but never promote.
  const PROXY_FORWARD_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
  function isProxiedRequest(req) {
    const headers = req?.headers || {};
    return PROXY_FORWARD_HEADERS.some((name) => String(headers[name] || "").trim());
  }

  // 请求的真实客户端地址：代理转发的请求取 X-Forwarded-For 的最后一跳（Caddy 默认
  // 会丢弃不可信的来路 XFF、只写入真实对端，所以最后一项永远是最近一级可信代理
  // 写入的地址）；直连请求用 socket 对端。本机伪造转发头只会把自己降级成远端，
  // 方向安全。
  function resolveClientAddress(req) {
    if (isProxiedRequest(req)) {
      const chain = String(req?.headers?.["x-forwarded-for"] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (chain.length) return chain[chain.length - 1];
      const realIp = String(req?.headers?.["x-real-ip"] || "").trim();
      if (realIp) return realIp;
    }
    return req?.socket?.remoteAddress || "";
  }

  // Management is localhost-only unless the LAN-admin switch is on; proxied
  // requests are never management-eligible regardless of that switch.
  function checkManagementAccess(req) {
    if (isProxiedRequest(req)) {
      return {
        ok: false,
        status: 403,
        code: "management_local_only",
        message: "Management endpoints are not available through a reverse proxy. Open the console directly on this machine.",
      };
    }
    if (core.isLocalRequest(req)) return { ok: true };
    if (policy().allowLanAdmin) return { ok: true };
    return {
      ok: false,
      status: 403,
      code: "management_local_only",
      message: "Management endpoints are local-only. Set SERVICE_ENTRY_ALLOW_LAN_ADMIN=1 to allow LAN devices.",
    };
  }

  // --- CORS (S4) ------------------------------------------------------------

  // Default is deny: no allow-origin header unless an origin was explicitly
  // configured. This matches the managers, which never reflected.
  function corsHeaders(req) {
    const origin = String(req.headers?.origin || "").trim();
    const { allowedOrigins } = policy();
    const base = {
      "access-control-allow-methods": "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-api-key,anthropic-version,api-key",
      "access-control-max-age": "600",
    };
    if (!origin) return base;
    const allowed = allowedOrigins.includes("*") || allowedOrigins.includes(origin);
    if (!allowed) return { ...base, vary: "Origin" };
    return {
      ...base,
      "access-control-allow-origin": allowedOrigins.includes("*") ? "*" : origin,
      ...(allowedOrigins.includes("*") ? {} : { "access-control-allow-credentials": "true" }),
      vary: "Origin",
    };
  }

  // --- Gateway authentication (moved up from the managers) ------------------

  // Keys still live in the manager stores so existing clients and the manager
  // UIs keep working; the entry just reads them and decides before proxying.
  async function loadKeyStores() {
    const now = Date.now();
    if (keyStoreCache.value && keyStoreCache.expiresAt > now) return keyStoreCache.value;
    if (keyStoreCache.promise) return keyStoreCache.promise;
    const promise = (async () => {
      const stores = [];
      const issues = [];
      for (const manager of managers) {
        const exposureFile = path.join(manager.root, "logs", "service-exposure-settings.json");
        const clientsFile = path.join(manager.root, "logs", "service-clients.json");
        let settings = null;
        let clients = null;
        try {
          settings = await core.readJsonFile(exposureFile, null);
        } catch (error) {
          issues.push({ manager: manager.id, file: exposureFile, message: error.message });
        }
        try {
          clients = await core.readJsonFile(clientsFile, null);
        } catch (error) {
          issues.push({ manager: manager.id, file: clientsFile, message: error.message });
        }
        stores.push({ manager, settings, clients });
      }
      return { stores, issues };
    })();
    keyStoreCache = { value: keyStoreCache.value, expiresAt: keyStoreCache.expiresAt, promise };
    try {
      const value = await promise;
      keyStoreCache = { value, expiresAt: Date.now() + KEY_STORE_CACHE_MS, promise: null };
      return value;
    } catch (error) {
      keyStoreCache = { value: null, expiresAt: 0, promise: null };
      throw error;
    }
  }

  function invalidateKeyStores() {
    keyStoreCache = { value: null, expiresAt: 0, promise: null };
  }

  async function authorizeGatewayRequest(req) {
    const current = policy();
    const presentedKey = core.extractServiceApiKey(req.headers || {}, { acceptRawAuthorization: true });
    const { stores, issues } = await loadKeyStores();

    // A corrupt key store must never read as "no keys configured", which would
    // otherwise let an unauthenticated request through.
    if (issues.length) {
      return {
        ok: false,
        status: 503,
        code: "key_store_unreadable",
        message: `Service key store could not be read: ${issues.map((item) => item.file).join(", ")}`,
      };
    }

    if (!current.requireApiKey && !presentedKey) {
      return { ok: true, clientId: "", client: null, authRequired: false, matchedManager: "" };
    }

    const configured = stores.filter((store) => {
      const hasGlobal = core.hasGlobalServiceApiKey(store.settings || {});
      const hasClients = core.hasActiveServiceClients(core.normalizeServiceClientsLedger(store.clients || {}));
      return hasGlobal || hasClients;
    });
    if (!configured.length) {
      if (!current.requireApiKey) return { ok: true, clientId: "", client: null, authRequired: false, matchedManager: "" };
      return {
        ok: false,
        status: 503,
        code: "api_key_not_configured",
        message: "An API key is required but none is configured. Generate one in a manager's service page, or set SERVICE_ENTRY_REQUIRE_API_KEY=0 to disable.",
      };
    }
    if (!presentedKey) {
      return { ok: false, status: 401, code: "unauthorized", message: "Missing service API key." };
    }
    for (const store of configured) {
      if (core.isGlobalServiceApiKeyAccepted(presentedKey, store.settings || {})) {
        return { ok: true, clientId: "", client: null, authRequired: true, matchedManager: store.manager.id };
      }
      const client = core.resolveServiceClientForApiKey(store.clients || {}, presentedKey);
      if (client) {
        return {
          ok: true,
          clientId: client.id,
          client: {
            id: client.id,
            enabled: client.enabled !== false,
            allowedModels: Array.isArray(client.allowedModels) ? [...client.allowedModels] : [],
            rateLimitRpm: client.rateLimitRpm,
            maxConcurrentRequests: client.maxConcurrentRequests,
            maxQueuedRequests: client.maxQueuedRequests,
            queueTimeoutSeconds: client.queueTimeoutSeconds,
            requestTimeoutSeconds: client.requestTimeoutSeconds,
          },
          authRequired: true,
          matchedManager: store.manager.id,
        };
      }
    }
    if (!current.requireApiKey) return { ok: true, clientId: "", client: null, authRequired: false, matchedManager: "" };
    return { ok: false, status: 401, code: "unauthorized", message: "Invalid service API key." };
  }

  // --- Trust token ----------------------------------------------------------

  // Publishes the in-memory token so managers started outside this process can
  // verify proxied requests. Managers we spawn get it through the environment.
  async function issueTrustToken() {
    return core.issueGatewayTrustToken({ root: aiRoot, token: trustToken });
  }

  function getTrustToken() {
    return trustToken;
  }

  async function revokeTrustToken() {
    await core.revokeGatewayTrustToken({ root: aiRoot });
  }

  function trustHeaders(req) {
    // 向管理器担保真实客户端地址。原来担保的是 socket 对端——经 Caddy 转发的
    // 公网请求会被担保成 127.0.0.1，管理器把公网客户端当成本机：local-only
    // 暴露模式失效、限流指纹和外部访问统计全部塌缩成一个"本机"。
    return core.buildGatewayTrustHeaders(trustToken, resolveClientAddress(req), Date.now());
  }

  // --- Reporting ------------------------------------------------------------

  // Surfaces what is actually enforced right now, so the UI can stop inferring
  // it from settings that may not have loaded.
  async function describe() {
    const current = policy();
    let keyStatus = { readable: true, managersWithKeys: [], issues: [] };
    try {
      const { stores, issues } = await loadKeyStores();
      keyStatus = {
        readable: !issues.length,
        issues,
        managersWithKeys: stores
          .filter((store) => core.hasGlobalServiceApiKey(store.settings || {})
            || core.hasActiveServiceClients(core.normalizeServiceClientsLedger(store.clients || {})))
          .map((store) => store.manager.id),
      };
    } catch (error) {
      keyStatus = { readable: false, managersWithKeys: [], issues: [{ file: "", message: error.message }] };
    }
    const enforced = current.requireApiKey && keyStatus.readable && keyStatus.managersWithKeys.length > 0;
    const publicBaseUrl = envText("SERVICE_ENTRY_PUBLIC_BASE_URL");
    return {
      lanMode: current.lanMode,
      publicMode: current.publicMode,
      publicBaseUrl: current.publicMode ? publicBaseUrl : "",
      exposure: current.publicMode ? "public" : current.lanMode ? "lan" : "local",
      host,
      requireApiKey: current.requireApiKey,
      requireApiKeyMode: current.requireApiKeyMode,
      apiKeyEnforced: enforced,
      allowLanAdmin: current.allowLanAdmin,
      corsMode: current.corsMode,
      allowedOrigins: current.allowedOrigins,
      trustTokenActive: Boolean(trustToken),
      keyStore: keyStatus,
      configIssues: core.listConfigHealthIssues(),
      warnings: buildWarnings(current, keyStatus, enforced),
      publicChecklist: buildPublicChecklist(current, keyStatus, enforced, publicBaseUrl),
      switches: {
        SERVICE_ENTRY_REQUIRE_API_KEY: "auto | 1 | 0 — auto 表示仅在局域网模式下强制；不受信环境请设为 1",
        SERVICE_ENTRY_ALLOW_LAN_ADMIN: "0 | 1 — 允许局域网设备访问管理端点",
        SERVICE_ENTRY_ALLOWED_ORIGINS: "逗号分隔的浏览器 Origin 白名单，留空表示不允许跨域",
        SERVICE_ENTRY_ALLOWED_HOSTS: "额外的 Host 白名单（反代域名）",
      },
    };
  }

  // The go-live checklist for a LAN or public deployment. Each item is a fact
  // the entry can verify itself; items it cannot verify (firewall, Caddy path
  // restriction) are listed as "manual" so the operator still sees them.
  function buildPublicChecklist(current, keyStatus, enforced, publicBaseUrl = "") {
    const items = [];
    const push = (id, state, title, detail) => items.push({ id, state, title, detail });
    const exposed = current.lanMode || current.publicMode;
    push("api-key", enforced ? "ok" : exposed ? "fail" : "info",
      "API Key 强制且有可用密钥",
      enforced
        ? `已强制；持有密钥的管理器：${keyStatus.managersWithKeys.join(", ")}`
        : current.requireApiKey
          ? "已要求 API Key，但没有可用密钥或密钥库不可读，网关会拒绝全部请求。"
          : "未强制 API Key。设置 SERVICE_ENTRY_REQUIRE_API_KEY=1，并在管理器“对外服务”页生成密钥。");
    push("lan-admin", current.allowLanAdmin ? (exposed ? "fail" : "warn") : "ok",
      "管理端点仅限本机",
      current.allowLanAdmin ? "SERVICE_ENTRY_ALLOW_LAN_ADMIN=1，局域网设备可以启停管理器。公网部署必须关闭。" : "管理 API 只接受本机直连；经代理转发的请求一律拒绝。");
    push("cors", current.allowedOrigins.includes("*") ? "fail" : "ok",
      "CORS 未放开为任意来源",
      current.allowedOrigins.length ? `允许的 Origin：${current.allowedOrigins.join(", ")}` : "未配置跨域来源（默认拒绝）。");
    if (current.publicMode) {
      const https = /^https:\/\//i.test(publicBaseUrl);
      push("https", https ? "ok" : "fail", "公网地址使用 HTTPS", https ? publicBaseUrl : `SERVICE_ENTRY_PUBLIC_BASE_URL=${publicBaseUrl || "(空)"} 不是 https://，密钥会明文传输。`);
      push("loopback-bind", current.lanMode ? "warn" : "ok",
        "公网流量只经反向代理进入",
        current.lanMode
          ? `入口同时监听 ${current.host}，局域网设备可绕过 Caddy 直连。公网部署建议入口只绑 127.0.0.1。`
          : "入口只绑回环，公网请求必须经 Caddy 转发，且只放行 /gateway/*。");
    }
    push("rate-limit", "ok", "限流与 401 风暴防护",
      `每客户端 ${envText("SERVICE_ENTRY_RATE_LIMIT_RPM", "600")} 请求/分钟；连续鉴权失败会被临时封禁（SERVICE_ENTRY_AUTH_FAIL_LIMIT / SERVICE_ENTRY_AUTH_BAN_SECONDS）。`);
    push("caddy-paths", "manual", "Caddy 只转发 /gateway/*",
      "deploy/public/Caddyfile 已按路径收紧；用 scripts/setup-public.ps1 生成 .env 并校验配置。");
    push("firewall", "manual", "路由器 / 防火墙只开放 80/443",
      "5176/5177/5178/7000/5180/5190 不得对公网开放；模型容器使用本地网络模式。");
    return items;
  }

  function describePublic(full = null) {
    const source = full && typeof full === "object" ? full : policy();
    return {
      lanMode: Boolean(source.lanMode),
      publicMode: Boolean(source.publicMode),
      exposure: source.exposure || (source.publicMode ? "public" : source.lanMode ? "lan" : "local"),
      requireApiKey: Boolean(source.requireApiKey),
      requireApiKeyMode: source.requireApiKeyMode || "auto",
      apiKeyEnforced: Boolean(source.apiKeyEnforced),
      allowLanAdmin: Boolean(source.allowLanAdmin),
      corsMode: source.corsMode || "deny",
    };
  }

  function buildWarnings(current, keyStatus, enforced) {
    const warnings = [];
    if (current.lanMode && !current.requireApiKey) {
      warnings.push({
        level: "fail",
        title: "局域网模式未强制 API Key",
        detail: "统一入口正在监听非回环地址，但 SERVICE_ENTRY_REQUIRE_API_KEY=0 关闭了鉴权，局域网任意设备可直接调用模型。",
      });
    }
    if (current.publicMode && !current.requireApiKey) {
      warnings.push({
        level: "fail",
        title: "公网模式未强制 API Key",
        detail: "已配置 SERVICE_ENTRY_PUBLIC_BASE_URL，但 SERVICE_ENTRY_REQUIRE_API_KEY=0 显式关闭了鉴权——公网任何人都能免费调用模型。",
      });
    }
    if (current.requireApiKey && !enforced && keyStatus.readable) {
      warnings.push({
        level: "fail",
        title: "要求 API Key 但没有可用密钥",
        detail: "网关会以 503 拒绝全部请求。请在任一管理器的“对外服务”页生成密钥。",
      });
    }
    if (!keyStatus.readable) {
      warnings.push({
        level: "fail",
        title: "密钥库无法读取",
        detail: "配置文件损坏或不可读，网关已 fail-closed 拒绝全部请求。",
      });
    }
    if (current.allowLanAdmin) {
      warnings.push({
        level: "warn",
        title: "局域网管理已开启",
        detail: "SERVICE_ENTRY_ALLOW_LAN_ADMIN=1，局域网设备可以启停管理器。仅在可信网络中使用。",
      });
    }
    if (current.allowedOrigins.includes("*")) {
      warnings.push({
        level: "warn",
        title: "CORS 允许任意 Origin",
        detail: "SERVICE_ENTRY_ALLOWED_ORIGINS 含 *，任意网页脚本都可以调用网关。",
      });
    }
    return warnings;
  }

  return {
    policy,
    allowedHostnames,
    checkRequest,
    checkManagementAccess,
    isProxiedRequest,
    resolveClientAddress,
    corsHeaders,
    authorizeGatewayRequest,
    loadKeyStores,
    invalidateKeyStores,
    issueTrustToken,
    revokeTrustToken,
    getTrustToken,
    trustHeaders,
    describe,
    describePublic,
  };
}

module.exports = {
  createEntrySecurity,
  normalizeRequireApiKeyMode,
};
