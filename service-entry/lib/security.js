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
//
// Client identity comes from trusted-proxy.js (05 §4): the ADMIN listener
// never honours forwarded headers, and the PUBLIC listener honours the one
// configured header only from trustedProxies.cidrs. Those settings are read
// through the access config adapter (public-config.js), i.e. OPS-3's
// readSection with env > platform.json > default.

const path = require("node:path");
const core = require("../../manager-core");
const { FORWARDING_HEADERS, hasForwardingHeaders, ipInCidrs, resolveClientIdentity } = require("./trusted-proxy");
const { createAccessConfigSource } = require("./public-config");
const keyPolicy = require("./key-policy");
const { lookupPublicError } = require("./public-errors");

const MANAGEMENT_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const KEY_STORE_CACHE_MS = 5000;
const KEY_STORE_ISSUE_LOG_MS = 60_000;

// Gateway callers may be anyone on the LAN or the internet, so their error
// text never carries paths, ports or env switches. The detail goes to the
// server log (redacted) instead.
const GATEWAY_UNAVAILABLE_MESSAGE = "服务暂时不可用 / Service temporarily unavailable";

// The single shared list of forwarding headers (trusted-proxy.js). Their
// presence marks a request as proxied, which can only demote it (no
// management, no billing admin), never promote it. billing-http.js and
// machine-auth.js import it from here, so the gates cannot disagree again.
const FORWARDED_HEADERS = FORWARDING_HEADERS;

function isForwardedRequest(req) {
  return hasForwardingHeaders(req?.headers || {});
}

// "admin" or "public": the listener a request arrived on (listeners.js tags
// req.listener = { kind, lanBound }). An untagged request is an ADMIN one, so
// code that calls the handler directly keeps today's behaviour (05 §3.1).
function listenerKindOf(req) {
  const listener = req?.listener;
  const kind = typeof listener === "string" ? listener : listener?.kind;
  return kind === "public" ? "public" : "admin";
}

// Hosts the PUBLIC listener always answers to besides the configured ones:
// the loopback names, and OpenWebUI in Docker (05 §3.3).
const PUBLIC_BASE_HOSTS = ["127.0.0.1", "localhost", "host.docker.internal"];
const ADMIN_VIA_PROXY_THROTTLE_MS = 1000;

// The default access settings source: OPS-3's readSection over the entry's
// AI root (env > <AI_ROOT>/config/platform.json > schema default).
function defaultReadSection(aiRoot) {
  return (name) => core.platform.readSection(name, { ...(aiRoot ? { aiRoot } : {}), env: process.env });
}

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
  // The platform access store (05 §6): the store, or a getter that returns it
  // and throws while it cannot be opened. Gateway keys are read only there.
  const keysStoreOption = options.keysStore || null;
  let keyStoreCache = { value: null, expiresAt: 0, promise: null };
  let keyStoreIssueLog = { detail: "", at: 0 };
  const logError = typeof options.logError === "function" ? options.logError : console.error;
  const warn = typeof options.warn === "function" ? options.warn : console.warn;
  // Security events (05 §15): the entry wires the event bus here. Never throws.
  let eventSink = typeof options.onEvent === "function" ? options.onEvent : null;
  const eventThrottle = new Map();
  // Access settings (05 §3.4): an injected source, an injected readSection, or
  // OPS-3's readSection over options.aiRoot. Re-read live (2 s cache).
  const accessSource = options.accessConfig && typeof options.accessConfig.get === "function"
    ? options.accessConfig
    : createAccessConfigSource({ readSection: typeof options.readSection === "function" ? options.readSection : defaultReadSection(options.aiRoot) });
  let warnedAccessIssues = "";
  // The latest exposure report (05 §13.2), a function returning the cached
  // ExposureReport or null. PUB-19 supplies the scan; until then the
  // checklist's proxy-target and firewall items stay manual.
  let exposureReport = typeof options.exposureReport === "function" ? options.exposureReport : null;

  // One warning per distinct set of problems: the settings are re-read while
  // the entry runs, and a bad value must not flood the log.
  function accessConfig() {
    const config = accessSource.get();
    if (config.issues.length) {
      const signature = JSON.stringify(config.issues);
      if (signature !== warnedAccessIssues) {
        warnedAccessIssues = signature;
        warn(`access settings: ignoring invalid values (defaults in force): ${config.issues.map((issue) => `${issue.env || issue.field}: ${issue.message}`).join("; ")}`);
      }
    }
    return config;
  }

  // Reachable from off-box: anything other than a loopback bind. The constructor
  // host is the legacy switch; listeners.admin.lan (or a wildcard
  // listeners.admin.host) from the access settings counts the same (05 §3.1).
  const hostLanBound = !["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
  function adminLanBound() {
    return hostLanBound || accessConfig().adminLanBound === true;
  }

  // One security event per kind and path class per second: a scanner pointed
  // at the wrong port must not flood the ring buffer.
  function emitEvent(data) {
    if (!eventSink) return;
    const key = `${data.kind}:${data.pathClass || ""}:${data.outcome || ""}`;
    const now = Date.now();
    if (now - (eventThrottle.get(key) || 0) < ADMIN_VIA_PROXY_THROTTLE_MS) return;
    eventThrottle.set(key, now);
    if (eventThrottle.size > 64) eventThrottle.clear();
    try {
      eventSink(data);
    } catch {
      // Events never throw into a request.
    }
  }

  // A forwarded header on ADMIN means a tunnel or proxy is pointed at the
  // wrong port (05 §3.3). Header names only, never values.
  function noteAdminViaProxy(req, { pathClass = "", outcome = "" } = {}) {
    emitEvent({
      kind: "admin_via_proxy",
      pathClass,
      outcome,
      headers: FORWARDING_HEADERS.filter((name) => String(req?.headers?.[name] ?? "").trim() !== ""),
      lanBound: adminLanBound(),
    });
  }

  function policy() {
    const lanMode = adminLanBound();
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

  function lanAddress() {
    try {
      return String(getLanAddress() || "").toLowerCase();
    } catch {
      // Interface enumeration failed; loopback names still apply.
      return "";
    }
  }

  // The ADMIN Host allowlist (05 §3.3): the loopback names, the LAN address
  // when ADMIN is LAN-bound, and admin.extraHosts. The public host is not
  // admitted here, so a tunnel pointed at ADMIN gets 403 host_not_allowed.
  function allowedHostnames(kind = "admin") {
    if (kind === "public") return publicHostnames();
    const names = new Set(["127.0.0.1", "localhost", "::1"]);
    const lan = lanAddress();
    if (lan && adminLanBound()) names.add(lan);
    if (hostLanBound && !["0.0.0.0", "::", "[::]"].includes(host.toLowerCase())) names.add(host.toLowerCase());
    for (const name of accessConfig().admin?.extraHosts || []) {
      const hostname = core.extractHostname(String(name));
      if (hostname) names.add(hostname.toLowerCase());
    }
    return names;
  }

  // The PUBLIC Host allowlist (05 §3.3): the public base URL's host, the
  // loopback names, host.docker.internal, the LAN address when PUBLIC is
  // LAN-bound, and public.extraHosts. Anything else is answered with 421.
  function publicHostnames() {
    const config = accessConfig();
    const names = new Set(PUBLIC_BASE_HOSTS);
    if (config.publicHost) names.add(String(config.publicHost).toLowerCase());
    const lan = lanAddress();
    if (lan && config.publicLanBound) names.add(lan);
    for (const name of config.public?.extraHosts || []) {
      const hostname = core.extractHostname(String(name));
      if (hostname) names.add(hostname.toLowerCase());
    }
    return names;
  }

  // --- Host / Origin guard (S2) -------------------------------------------

  // The exact origins of the ADMIN console (05 §3.3): scheme, host and port.
  // A page on another port of the same host (the PUBLIC listener on 5186, a
  // local dev server) is cross-origin and may not drive the console, which a
  // hostname-only check allowed. The port is the configured ADMIN port and
  // the port the request actually arrived on.
  function adminOrigins(req) {
    const config = accessConfig();
    const ports = new Set([Number(config.listeners?.admin?.port) || 5176]);
    const localPort = Number(req?.socket?.localPort);
    if (Number.isInteger(localPort) && localPort > 0) ports.add(localPort);
    const hosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    const lan = lanAddress();
    if (lan) hosts.add(lan.includes(":") ? `[${lan}]` : lan);
    for (const name of config.admin?.extraHosts || []) hosts.add(String(name).toLowerCase());
    const origins = new Set();
    for (const name of hosts) for (const port of ports) origins.add(`http://${name}:${port}`);
    return origins;
  }

  function normalizeOrigin(origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.origin === "null") return "";
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
    } catch {
      return "";
    }
  }

  function checkRequest(req, url) {
    const hostname = core.extractHostname(req.headers?.host);
    if (!hostname || !allowedHostnames().has(hostname)) {
      return { ok: false, status: 403, code: "host_not_allowed", message: `Host is not allowed: ${hostname || "(empty)"}` };
    }
    const method = String(req.method || "GET").toUpperCase();
    const origin = String(req.headers?.origin || "").trim();
    // Cross-site POSTs from a page the user happens to have open are the
    // realistic attack here, so mutating requests must carry a same-site
    // Origin: an exact console origin for the ADMIN routes, and (until the
    // gateway pipeline owns its CORS policy) an allowed hostname for /gateway/*.
    if (!MANAGEMENT_SAFE_METHODS.has(method) && origin) {
      const rejected = { ok: false, status: 403, code: "origin_not_allowed", message: "Cross-site request rejected (Origin check failed)." };
      if (origin === "null") return rejected;
      if (isGatewayPath(url)) {
        const originHost = core.extractHostname(origin);
        if (!originHost || !allowedHostnames().has(originHost)) return rejected;
      } else {
        const normalized = normalizeOrigin(origin);
        if (!normalized || !adminOrigins(req).has(normalized)) return rejected;
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
  // promote every public client to "local". Any forwarded header marks the
  // request as proxied, from any peer; this can demote but never promote.
  function isProxiedRequest(req) {
    return isForwardedRequest(req);
  }

  // True when the socket peer is inside trustedProxies.cidrs.
  function trustsPeer(address) {
    return ipInCidrs(address, accessConfig().trustedCidrs);
  }

  // 请求的客户端身份（05 §4）。按请求到达的监听端口判断：ADMIN（5176，未标记的
  // 请求也按 ADMIN 处理）永远只用 socket 地址；PUBLIC 只在 socket 对端属于
  // trustedProxies.cidrs 时才采信配置的那一个请求头（默认 cf-connecting-ip，
  // X-Forwarded-For 从右往左跳过可信代理）。局域网设备伪造的转发头一律忽略，
  // 否则任何人都能骗过日志、限流和计费归属，甚至让管理器把它当成本机。
  function identifyClient(req) {
    const config = accessConfig();
    return resolveClientIdentity(req, {
      listener: req?.listener,
      cidrs: config.trustedCidrs,
      clientIpHeader: config.trustedProxies.clientIpHeader,
      countryHeader: config.trustedProxies.countryHeader,
    });
  }

  function resolveClientAddress(req) {
    return identifyClient(req).ip;
  }

  // Management is localhost-only unless the LAN-admin switch is on; proxied
  // requests are never management-eligible regardless of that switch. This
  // is only the network half of the rule: since PUB-5 the entry asks
  // admin-session.js, which also requires an owner credential (a paired
  // session, an owner token or a machine signature).
  function checkManagementAccess(req) {
    if (isProxiedRequest(req)) {
      noteAdminViaProxy(req, { pathClass: "management", outcome: "management_local_only" });
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
      // Routing is metadata about the request the caller just made, so a
      // browser client is allowed to read which engine served it.
      "access-control-expose-headers": "x-request-id, x-client-request-id, x-local-ai-route",
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

  // --- Legacy manager key files (reporting only) ------------------------------

  // Gateway auth reads the access store since PUB-8. describe() still reports
  // the managers' own key files when no store is wired (tests, tools).
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
          issues.push({ manager: manager.id, file: exposureFile, message: core.redactSecrets(String(error.message || "")) });
        }
        try {
          clients = await core.readJsonFile(clientsFile, null);
        } catch (error) {
          issues.push({ manager: manager.id, file: clientsFile, message: core.redactSecrets(String(error.message || "")) });
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

  // PUBLIC always requires a key on model routes (05 §3.3), and so does a
  // forwarded request that reached ADMIN's /gateway/* (admin.legacyProxyGateway
  // "serve"): its client is unknown, so it is never treated as the local owner.
  function keyRequiredFor(req) {
    return listenerKindOf(req) === "public" || isForwardedRequest(req);
  }

  // --- Gateway authentication: the platform access store (05 §6) -----------

  // The store is wired by the entry (server.js getAccessStore); a getter that
  // throws, or no store at all, means "unavailable", never "no keys".
  function accessStore() {
    const value = typeof keysStoreOption === "function" ? keysStoreOption() : keysStoreOption;
    if (!value || typeof value.findBySecret !== "function") {
      const error = new Error("The access store is not available.");
      error.code = "access_store_unavailable";
      throw error;
    }
    return value;
  }

  // Every gateway request hits this while the store is broken, so the same
  // detail is logged once a minute at most. The detail stays in the log; the
  // caller only learns auth_unavailable.
  function logAccessStoreFailure(error) {
    const detail = `${error?.code || "access_store_unavailable"}: ${error?.cause?.message || error?.message || error}`;
    const now = Date.now();
    if (detail === keyStoreIssueLog.detail && now - keyStoreIssueLog.at < KEY_STORE_ISSUE_LOG_MS) return;
    keyStoreIssueLog = { detail, at: now };
    logError(core.redactSecrets(`gateway auth: the access store could not be read, refusing gateway requests: ${detail}`));
  }

  function gatewayDenial(code, extra = {}) {
    const item = lookupPublicError(code);
    return { ok: false, status: item ? item.status : 500, code, message: item ? item.message : GATEWAY_UNAVAILABLE_MESSAGE, ...extra };
  }

  // A key caller in the shape the gateway code has always read (clientId,
  // client, matchedManager), plus the key itself. A migrated global key keeps
  // its legacy shape (no client: unmetered, default policy); its TTS owner is
  // the key's own (V5 fix).
  function keyCaller(key, listener, matched) {
    const legacy = key.legacy && typeof key.legacy === "object" ? key.legacy : null;
    const legacyGlobal = legacy?.source === "service-exposure";
    const clientId = legacy ? (legacyGlobal ? "" : String(legacy.clientId || "")) : key.id;
    const limits = key.limits || {};
    const models = Array.isArray(key.models) ? key.models : [];
    const client = clientId
      ? {
        id: clientId,
        enabled: key.status === "active",
        // Display only (/gateway/status); enforcement reads key.models.
        allowedModels: models.length === 1 && models[0] === "*" ? [] : [...models],
        rateLimitRpm: limits.rpm ?? undefined,
        maxConcurrentRequests: limits.maxConcurrent ?? undefined,
        maxQueuedRequests: limits.maxQueued ?? undefined,
        queueTimeoutSeconds: limits.queueTimeoutSeconds ?? undefined,
        requestTimeoutSeconds: limits.requestTimeoutSeconds ?? undefined,
      }
      : null;
    return {
      ok: true,
      kind: "key",
      principal: "key",
      listener,
      key,
      keyId: key.id,
      customerId: key.customerId || "",
      scopes: Array.isArray(key.scopes) ? [...key.scopes] : [],
      ttsOwner: String(key.ttsOwner || ""),
      matched,
      clientId,
      client,
      authRequired: true,
      matchedManager: legacy ? String(legacy.managerId || "") : "",
    };
  }

  function keylessCaller(listener) {
    return { ok: true, kind: "keyless", principal: "", listener, key: null, clientId: "", client: null, authRequired: false, matchedManager: "" };
  }

  // authorizeGatewayRequest(req, { scope }) -> caller | { ok:false, status, code, message }
  // The key comes from the access store (05 §6.2). A broken store fails
  // closed with 503 auth_unavailable, whatever the keyless rules say. Without
  // a key the keyless rules decide (exposure.requireApiKey; PUBLIC and
  // forwarded requests always need one). A presented key is judged by
  // key-policy: status, expiry, listener, allowed IPs and, when the route
  // names one, the scope. The codes are 05 §10.2's.
  async function authorizeGatewayRequest(req, options = {}) {
    const listener = listenerKindOf(req);
    const requireApiKey = policy().requireApiKey || keyRequiredFor(req);
    const presentedKey = core.extractServiceApiKey(req.headers || {}, { acceptRawAuthorization: true });
    let store;
    let found = null;
    try {
      store = accessStore();
      if (presentedKey) found = store.findBySecret(presentedKey, new Date());
    } catch (error) {
      logAccessStoreFailure(error);
      return gatewayDenial("auth_unavailable");
    }
    if (!presentedKey) return requireApiKey ? gatewayDenial("missing_api_key") : keylessCaller(listener);
    // An unknown key on a keyless loopback stays keyless, as it always was:
    // local tools send placeholder keys.
    if (!found) return requireApiKey ? gatewayDenial("invalid_api_key") : keylessCaller(listener);
    const scope = options && typeof options === "object" && options.scope ? String(options.scope) : "";
    const verdict = keyPolicy.evaluateKey(found.key, {
      now: new Date(),
      listener,
      ip: resolveClientAddress(req),
      scope,
      exposeSearch: accessConfig().public?.exposeSearch === true,
    });
    if (!verdict.ok) return gatewayDenial(verdict.code, { reason: verdict.reason, param: verdict.param || null, keyId: found.key.id });
    return keyCaller(found.key, listener, found.matched);
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

  // Hop v2 (05 §7.1): v1 plus the request id, the caller's principal and 04's
  // context, signed for the manager-side method and path.
  function entryHeaders(req, { method, pathname, requestId, principal = null, context = null } = {}) {
    return core.buildEntryHeaders(trustToken, {
      method: method || req?.method || "GET",
      pathname,
      clientIp: resolveClientAddress(req),
      requestId,
      principal,
      context,
    }, Date.now());
  }

  // --- Reporting ------------------------------------------------------------

  // Surfaces what is actually enforced right now, so the UI can stop inferring
  // it from settings that may not have loaded.
  // What the access store holds, for describe(): readable, the number of
  // usable keys, and the managers whose migrated keys are among them.
  function describeAccessStore() {
    try {
      const store = accessStore();
      const counts = typeof store.countKeys === "function" ? store.countKeys() : null;
      const managers = new Set();
      if (typeof store.listKeys === "function") {
        for (const key of store.listKeys({ status: "active", limit: 200 }).items || []) {
          const managerId = key?.legacy?.managerId;
          if (managerId) managers.add(String(managerId));
        }
      }
      const activeKeys = counts ? Math.max(0, Number(counts.active || 0) - Number(counts.expired || 0)) : managers.size;
      return { readable: true, issues: [], managersWithKeys: [...managers], activeKeys };
    } catch (error) {
      return { readable: false, issues: [{ file: "", message: core.redactSecrets(String(error?.code || "access_store_unavailable")) }], managersWithKeys: [], activeKeys: 0 };
    }
  }

  async function describeManagerKeyFiles() {
    try {
      const { stores, issues } = await loadKeyStores();
      return {
        readable: !issues.length,
        issues,
        managersWithKeys: stores
          .filter((store) => core.hasGlobalServiceApiKey(store.settings || {})
            || core.hasActiveServiceClients(core.normalizeServiceClientsLedger(store.clients || {})))
          .map((store) => store.manager.id),
      };
    } catch (error) {
      return { readable: false, managersWithKeys: [], issues: [{ file: "", message: error.message }] };
    }
  }

  async function describe() {
    const current = policy();
    const keyStatus = keysStoreOption ? describeAccessStore() : await describeManagerKeyFiles();
    const enforced = current.requireApiKey && keyStatus.readable && (keyStatus.activeKeys ?? keyStatus.managersWithKeys.length) > 0;
    const publicBaseUrl = envText("SERVICE_ENTRY_PUBLIC_BASE_URL");
    let report = null;
    try {
      report = exposureReport ? await exposureReport() : null;
    } catch {
      report = null;
    }
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
      trustedProxies: accessConfig().trustedProxies.cidrs.slice(),
      trustTokenActive: Boolean(trustToken),
      keyStore: keyStatus,
      configIssues: core.listConfigHealthIssues(),
      warnings: buildWarnings(current, keyStatus, enforced),
      publicChecklist: buildPublicChecklist(current, keyStatus, enforced, publicBaseUrl, report),
      switches: {
        SERVICE_ENTRY_REQUIRE_API_KEY: "auto | 1 | 0 — auto 表示仅在局域网模式下强制；不受信环境请设为 1",
        SERVICE_ENTRY_ALLOW_LAN_ADMIN: "0 | 1 — 允许局域网设备访问管理端点",
        SERVICE_ENTRY_ALLOWED_ORIGINS: "逗号分隔的浏览器 Origin 白名单，留空表示不允许跨域",
        SERVICE_ENTRY_ALLOWED_HOSTS: "额外的 Host 白名单（反代域名）",
        SERVICE_ENTRY_TRUSTED_PROXIES: "逗号分隔的可信反向代理 IP / CIDR，只有它们带来的转发头会被采信；默认仅回环",
      },
    };
  }

  // The go-live checklist for a LAN or public deployment. Each item is a fact
  // the entry can verify itself; items it cannot verify (firewall, Caddy path
  // restriction) are listed as "manual" so the operator still sees them.
  function buildPublicChecklist(current, keyStatus, enforced, publicBaseUrl = "", report = null) {
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
    // proxy-target and firewall come from the exposure scan (05 §13.2) when
    // one has run; without it they stay manual items, as before.
    const checks = new Map((Array.isArray(report?.checks) ? report.checks : []).map((check) => [check?.id, check]));
    const fromChecks = (ids, fallbackState, fallbackDetail) => {
      const found = ids.map((id) => checks.get(id)).filter(Boolean);
      const known = found.filter((check) => ["ok", "warn", "fail"].includes(check.state));
      if (!known.length) return { state: fallbackState, detail: fallbackDetail };
      const rank = { ok: 0, warn: 1, fail: 2 };
      const worst = known.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a));
      const evidence = typeof worst.evidence === "string" && worst.evidence ? worst.evidence : fallbackDetail;
      return { state: worst.state, detail: evidence };
    };
    const target = fromChecks(["tunnel_target", "legacy_proxy"], "manual",
      "公网转发目标应是 5186（PUBLIC 监听）而不是 5177/5178；在“公网访问”页运行检查可自动验证。");
    push("proxy-target", target.state, "公网转发只指向 PUBLIC 监听", target.detail);
    const firewall = fromChecks(["firewall_profiles", "wildcard_listeners"], "manual",
      "路由器 / 防火墙只开放 80/443；5176/5177/5178/7000/5180/5190 不得对公网开放。运行检查可读取本机防火墙状态。");
    push("firewall", firewall.state, "路由器 / 防火墙只开放 80/443", firewall.detail);
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
        detail: "网关会以 401 拒绝全部请求。请在任一管理器的“对外服务”页生成密钥。",
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
    isTrustedProxy: trustsPeer,
    resolveClientAddress,
    identifyClient,
    accessConfig,
    // Re-reads the settings now (after the console saved them), instead of at the next 2 s tick.
    refreshAccessConfig() {
      return accessSource.refresh();
    },
    publicHostnames,
    noteAdminViaProxy,
    // A new sink is a new subscription: the per-path throttle starts over.
    setEventSink(sink) {
      eventSink = typeof sink === "function" ? sink : null;
      eventThrottle.clear();
    },
    listenerKind: listenerKindOf,
    corsHeaders,
    authorizeGatewayRequest,
    loadKeyStores,
    invalidateKeyStores,
    issueTrustToken,
    revokeTrustToken,
    getTrustToken,
    trustHeaders,
    entryHeaders,
    describe,
    describePublic,
    // PUB-19 supplies the scan: a function returning the cached report or null.
    setExposureReport(fn) {
      exposureReport = typeof fn === "function" ? fn : null;
    },
  };
}

module.exports = {
  FORWARDED_HEADERS,
  listenerKindOf,
  createEntrySecurity,
  normalizeRequireApiKeyMode,
};
