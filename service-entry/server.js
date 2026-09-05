const http = require("node:http");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline, Readable, Transform } = require("node:stream");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const core = require("../manager-core");
const { createEntrySecurity } = require("./lib/security");
const { createBillingStore } = require("./lib/billing-store");
const { createBillingHttpHandler, strictLocalBillingAdmin } = require("./lib/billing-http");
const { summarizeServiceKeys, redactKeySummary } = require("./lib/key-overview");
const { parseAuxGatewayRoute, buildAuxUpstreamPath, parseEnvFileValue } = require("./lib/aux-gateway");
const { ttsSynthesisRoute, countTtsCharacters, ttsEngineFromBody, createWavDurationProbe, createJsonCollector, parseTtsJsonDuration } = require("./lib/tts-usage");
const { signedTtsHeaders, createTtsReconciler } = require("./lib/tts-bridge");
const {
  DEFAULT_CLAUDE_MODEL_ALIASES,
  GENERIC_MODEL_IDS,
  buildFleetSnapshot,
  flattenCatalogModels,
  normalizeFleetSettings,
  normalizeManagerInstances,
  rewriteRequestModelBody,
  selectFleetTarget,
} = require("./lib/model-fleet");

const HOST = process.env.SERVICE_ENTRY_HOST || "127.0.0.1";
const PORT = Number(process.env.SERVICE_ENTRY_PORT || 5176);
const PLATFORM_MCP_PORT = Number(process.env.PLATFORM_MCP_PORT || 5190);
const TTS_GATEWAY_PORT = Number(process.env.TTS_GATEWAY_PORT || 7000);
const SEARCH_GATEWAY_PORT = Number(process.env.SEARCH_GATEWAY_PORT || 5180);
const ROOT = __dirname;
const AI_ROOT = path.dirname(ROOT);
const PLATFORM_MCP_ENV_FILE = process.env.PLATFORM_MCP_ENV_FILE || path.join(AI_ROOT, ".runtime", "platform-mcp", "server.env");
const PROCESS_EXIT_LOG = path.join(ROOT, "logs", "process-exit.log");
// 401 风暴防护：同一客户端地址在窗口内连续鉴权失败即临时封禁，公网扫描者
// 拿到的是廉价的 429 而不是每次一遍密钥库读取 + 访问日志。
const authGuard = core.createAuthFailureGuard({
  maxFailures: Number(process.env.SERVICE_ENTRY_AUTH_FAIL_LIMIT || 20),
  windowMs: Number(process.env.SERVICE_ENTRY_AUTH_FAIL_WINDOW_SECONDS || 60) * 1000,
  banMs: Number(process.env.SERVICE_ENTRY_AUTH_BAN_SECONDS || 600) * 1000,
});
const GATEWAY_ACCESS_LOG = path.join(ROOT, "logs", "gateway-access.log");
const FLEET_SETTINGS_FILE = path.join(ROOT, "data", "fleet-settings.json");
const BILLING_DB_FILE = process.env.AI_BILLING_DB || path.join(ROOT, "data", "platform-billing.sqlite");
const FLEET_API_MAX_BODY_BYTES = boundedByteLimit(process.env.SERVICE_ENTRY_FLEET_MAX_BODY_BYTES, 1024 * 1024, 64 * 1024, 4 * 1024 * 1024);
const GATEWAY_MAX_BODY_BYTES = boundedByteLimit(process.env.SERVICE_ENTRY_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
const TTS_GATEWAY_MAX_BODY_BYTES = boundedByteLimit(process.env.SERVICE_ENTRY_TTS_MAX_BODY_BYTES, 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
const TTS_UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
// A JSON body exists simultaneously as stream chunks, a concatenated Buffer,
// a UTF-8 string and parsed objects. Account conservatively for that real peak
// instead of treating one raw byte as one byte of process memory.
const configuredBodyMemoryMultiplier = Number(process.env.SERVICE_ENTRY_BODY_MEMORY_MULTIPLIER || 4);
const GATEWAY_BODY_MEMORY_MULTIPLIER = Number.isFinite(configuredBodyMemoryMultiplier)
  ? Math.min(8, Math.max(2, configuredBodyMemoryMultiplier))
  : 4;
const GATEWAY_TOTAL_BUFFER_BYTES = boundedByteLimit(
  process.env.SERVICE_ENTRY_TOTAL_BUFFER_BYTES,
  128 * 1024 * 1024,
  Math.min(512 * 1024 * 1024, GATEWAY_MAX_BODY_BYTES * GATEWAY_BODY_MEMORY_MULTIPLIER),
  512 * 1024 * 1024,
);
let gatewayBufferedBodyBytes = 0;
const entryRateBuckets = new Map();
const entryConcurrencyBuckets = new Map();
const entryConcurrencyQueues = new Map();
const ttsReconciler = createTtsReconciler({ getStore: () => getBillingStore(), getToken: () => security.getTrustToken(), getPort: () => TTS_GATEWAY_PORT, getKey: () => String(process.env.TTS_UPSTREAM_API_KEY || "").trim() });
let fleetSettingsCache = { mtimeMs: Number.NaN, value: null };
const MODEL_DISCOVERY_CACHE_MS = Math.max(250, Number(process.env.SERVICE_ENTRY_MODEL_CACHE_MS || 3000));
const MANAGER_STATUS_CACHE_MS = Math.max(500, Number(process.env.SERVICE_ENTRY_STATUS_CACHE_MS || 5000));
const PUBLIC_BASE_URL = String(process.env.SERVICE_ENTRY_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
const CLAUDE_COMPAT_MODEL_ALIASES = Array.from(new Set([
  ...(process.env.AI_CLAUDE_MODEL_ALIASES || DEFAULT_CLAUDE_MODEL_ALIASES.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  "local",
]));
const SERVICE_ENTRY_INSTANCE_HEADER = core.SERVICE_ENTRY_INSTANCE_HEADER || "x-service-entry-instance-id";
const SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER = core.SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER || "x-service-entry-instance-signature";
// Headers a client must never be able to set: they are how a manager decides
// whether a loopback hop really came from this process.
const TRUST_HEADER_NAMES = [
  core.GATEWAY_MARKER_HEADER,
  core.GATEWAY_CLIENT_HEADER,
  core.GATEWAY_TIMESTAMP_HEADER,
  core.GATEWAY_SIGNATURE_HEADER,
  SERVICE_ENTRY_INSTANCE_HEADER,
  SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER,
];

const MANAGERS = [
  {
    id: "vllm",
    name: "vLLM Manager",
    root: path.join(AI_ROOT, "vllm-manager"),
    port: Number(process.env.VLLM_MANAGER_PORT || 5177),
    envPort: "VLLM_MANAGER_PORT",
    envHost: "VLLM_MANAGER_HOST",
    defaultHost: process.env.VLLM_MANAGER_HOST || "0.0.0.0",
    mode: "safetensors / FP8 / NVFP4 / 工具调用 / 高吞吐",
    accent: "blue",
  },
  {
    id: "llama",
    name: "llama.cpp Manager",
    root: path.join(AI_ROOT, "llama-manager"),
    port: Number(process.env.LLAMA_MANAGER_PORT || 5178),
    envPort: "LLAMA_MANAGER_PORT",
    envHost: "LLAMA_MANAGER_HOST",
    defaultHost: process.env.LLAMA_MANAGER_HOST || "0.0.0.0",
    mode: "GGUF / 异构双卡 / 长上下文实验",
    accent: "teal",
  },
];

const security = createEntrySecurity({
  host: HOST,
  aiRoot: AI_ROOT,
  managers: MANAGERS,
  getLanAddress: core.getLanAddress,
});

let server = null;
let billingStore = null;
const managerModelCache = new Map();
const managerStatusCache = new Map();
// Manager liveness rarely flips, so a short probe cache turns the per-request
// TCP connect probe into an in-memory lookup for the common steady-state case.
const PORT_PROBE_CACHE_MS = Math.max(250, Number(process.env.SERVICE_ENTRY_PORT_PROBE_CACHE_MS || 2000));
const portProbeCache = new Map();
const GENERIC_MODEL_ID_SET = new Set(GENERIC_MODEL_IDS.map((value) => String(value || "").toLowerCase()));

function getBillingStore() {
  if (billingStore) return billingStore;
  billingStore = createBillingStore({
    DatabaseSync,
    file: BILLING_DB_FILE,
    defaultEnforcementMode: "shadow",
  });
  return billingStore;
}

const handleBillingHttpRequest = createBillingHttpHandler({
  getStore: getBillingStore,
  readRequestBody,
  sendJson,
  verifyBillingRequest: core.verifyBillingRequest,
  getTrustToken: security.getTrustToken,
  isLocalAddress: core.isLocalAddress,
  extractHostname: core.extractHostname,
});

async function isManagerPortListening(port) {
  const now = Date.now();
  const cached = portProbeCache.get(port);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = core.isPortListening("127.0.0.1", port).catch(() => false);
  portProbeCache.set(port, { value: cached?.value ?? false, expiresAt: cached?.expiresAt ?? 0, promise });
  try {
    const value = await promise;
    portProbeCache.set(port, { value, expiresAt: now + PORT_PROBE_CACHE_MS, promise: null });
    return value;
  } catch (error) {
    portProbeCache.delete(port);
    throw error;
  }
}

function createServiceEntryServer() {
  const httpServer = http.createServer(handleRequest);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  let reconciliationTimer;
  httpServer.once("listening", () => {
    reconciliationTimer = setInterval(() => ttsReconciler.flush().catch((error) => console.warn(`TTS reconciliation: ${error.message}`)), 5000);
    reconciliationTimer.unref();
  });
  httpServer.once("close", () => clearInterval(reconciliationTimer));
  return httpServer;
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    // Host whitelist + Origin check for mutating requests. Without this any page
    // the user has open can drive the entry over loopback.
    const guard = security.checkRequest(req, url);
    if (!guard.ok) return sendJson(res, { error: guard.message, code: guard.code }, guard.status);
    // 反向代理（deploy/public 的 Caddy）转发进来的请求只允许走 /gateway/*：
    // 控制台页面、管理 API、计费和文档都不该出现在公网上。
    if (!url.pathname.startsWith("/gateway/") && security.isProxiedRequest(req)) {
      return sendJson(res, { error: "Only /gateway/* endpoints are served through the public proxy.", code: "public_proxy_gateway_only" }, 404);
    }
    if (await handleBillingHttpRequest(req, res, url)) return;
    if (req.method === "GET" && (url.pathname === "/billing" || url.pathname === "/billing/")) {
      if (!isStrictLocalBillingPageRequest(req)) {
        return sendJson(res, { error: "Billing administration is available only through localhost.", code: "billing_admin_local_only" }, 403);
      }
      return serveFile(res, path.join(ROOT, "billing.html"), "text/html; charset=utf-8", {
        "content-security-policy": "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveFile(res, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
    }
    // 平台设计令牌（与两个管理器、TTS 工作台同一份色板）。
    if (req.method === "GET" && url.pathname === "/shared-js/tokens.css") {
      return serveFile(res, path.join(ROOT, "..", "shared-public", "js", "tokens.css"), "text/css; charset=utf-8", {
        "cache-control": "public, max-age=3600",
      });
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && url.pathname.startsWith("/docs/")) {
      return serveDoc(res, url.pathname);
    }
    if (isTtsGatewayPath(url.pathname)) {
      return proxyTtsGatewayRequest(req, res, url);
    }
    if (parseAuxGatewayRoute(url.pathname)) {
      return proxyAuxGatewayRequest(req, res, url);
    }
    if (url.pathname.startsWith("/gateway/")) {
      // 免鉴权健康检查：公网监控探活用，不暴露模型或配置信息。
      if (req.method === "GET" && (url.pathname === "/gateway/health" || url.pathname === "/gateway/health/")) {
        return sendJson(res, { ok: true, service: "local-ai-gateway", time: new Date().toISOString() }, 200, gatewayCorsHeaders(req));
      }
      // 需 Key 的状态页：可用模型、在线组件、本 Key 的限流余量和配额。
      if (req.method === "GET" && (url.pathname === "/gateway/status" || url.pathname === "/gateway/status/")) {
        return handleGatewayStatus(req, res, url);
      }
      return proxyGatewayRequest(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/api/keys") {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const managers = await Promise.all(MANAGERS.map((manager) => buildManagerStatus(manager, { force: url.searchParams.get("fresh") === "1" })));
      return sendJson(res, { ok: true, keys: summarizeServiceKeys(managers) });
    }
    if (req.method === "GET" && url.pathname === "/api/security") {
      const allowed = security.checkManagementAccess(req);
      const securityState = allowed.ok ? await security.describe() : security.describePublic();
      return sendJson(res, { ok: true, security: securityState });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const detailed = security.checkManagementAccess(req).ok;
      const [managers, mcp, tts, search] = await Promise.all([
        Promise.all(MANAGERS.map(buildManagerStatus)),
        buildPlatformMcpStatus(),
        buildTtsStatus(),
        buildSearchGatewayStatus(),
      ]);
      const payload = {
        ok: true,
        security: { ...(await security.describe()), authGuard: authGuard.describe() },
        entry: {
          host: HOST,
          port: PORT,
          lanAddress: core.getLanAddress(),
          pid: process.pid,
          uptimeSeconds: process.uptime(),
          gateway: buildEntryGatewayUrls(),
          gatewayAccess: await collectEntryGatewayAccessStats({ limit: 20, maxLines: 2000 }),
          exitLog: PROCESS_EXIT_LOG,
        },
        managers,
        mcp,
        tts,
        search,
        keys: summarizeServiceKeys(managers),
        components: summarizeComponents(managers, mcp, tts, search),
      };
      return sendJson(res, detailed ? payload : redactStatusForRemote(payload));
    }
    if (req.method === "GET" && url.pathname === "/api/mcp/status") {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      return sendJson(res, await buildPlatformMcpStatus());
    }
    if (req.method === "GET" && url.pathname === "/api/fleet") {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      return sendJson(res, await buildServiceEntryFleetSnapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/fleet/settings") {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      let body;
      try {
        body = await readJsonObjectBody(req, FLEET_API_MAX_BODY_BYTES);
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message, code: "invalid_request" }, error.status || 400);
      }
      const currentSettings = await getFleetSettings();
      const settings = await saveFleetSettings({ ...currentSettings, ...(body.settings || body) });
      const fleet = await buildServiceEntryFleetSnapshot(settings);
      return sendJson(res, { ok: true, settings, fleet });
    }
    if (req.method === "POST" && url.pathname === "/api/fleet/route-preview") {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      let body;
      try {
        body = await readJsonObjectBody(req, FLEET_API_MAX_BODY_BYTES);
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message, code: "invalid_request" }, error.status || 400);
      }
      return sendJson(res, await buildFleetRoutePreview(body));
    }
    if (req.method === "GET" && url.pathname === "/api/gateway-access") {
      const access = await collectEntryGatewayAccessStats({
        limit: url.searchParams.get("limit"),
        maxLines: url.searchParams.get("maxLines"),
      });
      return sendJson(res, security.checkManagementAccess(req).ok ? access : redactAccessForRemote(access));
    }
    const managerStartMatch = url.pathname.match(/^\/api\/managers\/([^/]+)\/start$/);
    if (req.method === "POST" && managerStartMatch) {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const manager = findManager(managerStartMatch[1]);
      if (!manager) return sendJson(res, { ok: false, error: "Unknown manager." }, 404);
      return sendJson(res, await startDetachedManager(manager));
    }
    const managerStopMatch = url.pathname.match(/^\/api\/managers\/([^/]+)\/stop$/);
    if (req.method === "POST" && managerStopMatch) {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const manager = findManager(managerStopMatch[1]);
      if (!manager) return sendJson(res, { ok: false, error: "Unknown manager." }, 404);
      return sendJson(res, await stopManager(manager));
    }
    if (req.method === "POST" && url.pathname === "/api/stop-all") {
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const stopped = await Promise.all(MANAGERS.map((manager) => postJson(`http://127.0.0.1:${manager.port}/api/manager/shutdown`)));
      sendJson(res, { ok: true, stopped });
      return shutdownSoon();
    }
    if (req.method === "POST" && (url.pathname === "/api/shutdown" || url.pathname === "/api/manager/shutdown")) {
      // Same gate as the other lifecycle endpoints; this one used to be open,
      // so any LAN device could stop the whole gateway.
      const allowed = security.checkManagementAccess(req);
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      sendJson(res, { ok: true });
      return shutdownSoon();
    }
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    console.error(`service-entry error: ${error.stack || error.message}`);
    // Do not echo internal error text to the caller.
    sendJson(res, { error: "Service entry error." }, 500);
  }
}

// LAN callers get the operational picture without host paths, PIDs, or the
// per-client access detail that made the unauthenticated status route a leak.
function redactStatusForRemote(payload) {
  return {
    ...payload,
    security: {
      ...security.describePublic(payload.security),
      authGuard: payload.security?.authGuard ? { enabled: true, bannedCount: payload.security.authGuard.bannedCount } : undefined,
    },
    entry: {
      ...payload.entry,
      pid: undefined,
      exitLog: undefined,
      gatewayAccess: redactAccessForRemote(payload.entry.gatewayAccess),
    },
    keys: redactKeySummary(payload.keys),
    mcp: payload.mcp ? { ...payload.mcp, tools: undefined, policy: undefined } : payload.mcp,
    managers: (payload.managers || []).map((manager) => ({
      ...manager,
      root: undefined,
      process: manager.process ? { ...manager.process, pidFile: undefined, pid: undefined, health: undefined } : null,
      clients: undefined,
      externalAccess: undefined,
    })),
  };
}

function redactAccessForRemote(access) {
  if (!access || typeof access !== "object") return access;
  return {
    ...access,
    logPath: undefined,
    clients: undefined,
    recent: undefined,
  };
}

async function startServiceEntry() {
  if (server) return server;
  // Open and migrate the billing database before publishing trust or accepting
  // traffic. A broken ledger must fail startup instead of silently bypassing
  // quota enforcement after managers begin forwarding requests.
  getBillingStore();
  // Publish the trust token before accepting traffic so managers started
  // independently can verify proxied requests from the first one.
  await security.issueTrustToken().catch((error) => {
    console.warn(`Unable to publish gateway trust token: ${error.message}`);
  });
  server = createServiceEntryServer();
  server.on("error", (error) => {
    const detail = error?.code === "EADDRINUSE"
      ? `端口 ${PORT} 已被占用，无法启动统一入口。`
      : (error?.message || String(error));
    console.error(`Service entry listen failed: ${detail}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const state = security.policy();
    console.log(`Service entry listening on http://${HOST}:${PORT}`);
    console.log(`  gateway auth: ${state.requireApiKey ? "required" : "disabled"} (SERVICE_ENTRY_REQUIRE_API_KEY=${state.requireApiKeyMode})`);
    console.log(`  lan admin:    ${state.allowLanAdmin ? "allowed" : "local only"} (SERVICE_ENTRY_ALLOW_LAN_ADMIN)`);
    console.log(`  cors:         ${state.corsMode}${state.allowedOrigins.length ? ` (${state.allowedOrigins.join(", ")})` : ""}`);
    if (state.lanMode && !state.requireApiKey) {
      console.warn("  WARNING: listening off-loopback with API key enforcement disabled.");
    }
    if (!state.requireApiKey) {
      console.warn("  HINT: 不受信环境请设置 SERVICE_ENTRY_REQUIRE_API_KEY=1，避免网页跨站盲打本地推理。");
    }
  });
  return server;
}

if (require.main === module) {
  core.installProcessExitLogging({
    label: "service-entry",
    file: PROCESS_EXIT_LOG,
    onSignal: async () => {
      await security.revokeTrustToken().catch(() => {});
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  });
  startServiceEntry().catch((error) => {
    console.error(`Service entry failed to start: ${error.message}`);
    process.exit(1);
  });
}

function isStrictLocalBillingPageRequest(req) {
  return strictLocalBillingAdmin(req, {
    isLocalAddress: core.isLocalAddress,
    extractHostname: core.extractHostname,
  });
}

async function serveFile(res, filePath, contentType, extraHeaders = {}) {
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(content);
}

async function serveDoc(res, pathname) {
  const name = path.basename(String(pathname || ""));
  const allowed = new Set([
    "client-setup-guide.md",
    "billing-guide.md",
    "mcp-platform-guide.md",
    "model-service-platform-workplan.md",
    "service-runbook.md",
  ]);
  if (!allowed.has(name)) return sendJson(res, { error: "Document not found" }, 404);
  return serveFile(res, path.join(AI_ROOT, "docs", name), "text/markdown; charset=utf-8");
}

async function buildManagerStatus(manager, options = {}) {
  const now = Date.now();
  const cached = managerStatusCache.get(manager.id);
  if (!options.force && cached?.value) {
    if (cached.expiresAt <= now && !cached.promise) {
      buildManagerStatus(manager, { force: true }).catch(() => {});
    }
    return cached.value;
  }
  if (!options.force && cached?.promise) return cached.promise;
  const promise = buildManagerStatusFresh(manager);
  managerStatusCache.set(manager.id, {
    value: cached?.value || null,
    expiresAt: cached?.expiresAt || 0,
    promise,
  });
  try {
    const value = await promise;
    managerStatusCache.set(manager.id, { value, expiresAt: Date.now() + MANAGER_STATUS_CACHE_MS, promise: null });
    return value;
  } catch (error) {
    managerStatusCache.delete(manager.id);
    throw error;
  }
}

async function buildPlatformMcpStatus(options = {}) {
  const port = Number(options.port || PLATFORM_MCP_PORT);
  const checkPort = options.isPortListening || core.isPortListening;
  const getJson = options.fetchJson || fetchJson;
  const listening = await checkPort("127.0.0.1", port);
  const base = {
    configured: true,
    host: "127.0.0.1",
    port,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    infoEndpoint: `http://127.0.0.1:${port}/info`,
    listening: Boolean(listening),
    healthy: false,
    readOnly: true,
    authRequired: true,
    version: null,
    error: "",
  };
  if (!listening) return base;
  const health = await getJson(`http://127.0.0.1:${port}/health`, 2500);
  const data = health.data && typeof health.data === "object" ? health.data : {};
  const healthy = Boolean(health.ok && data.ok && data.service === "local-ai-platform-mcp");
  // 工具清单来自 /info（需 Bearer）。密钥只从平台根下的 server.env 读取，不外传。
  let tools = [];
  let policy = null;
  if (healthy) {
    const key = await readPlatformMcpKey(options.envFile);
    if (key) {
      const info = await getJson(`http://127.0.0.1:${port}/info`, 2500, { authorization: `Bearer ${key}` });
      const infoData = info.data && typeof info.data === "object" ? info.data : {};
      tools = Array.isArray(infoData.tools) ? infoData.tools.map((item) => String(item).slice(0, 80)).slice(0, 64) : [];
      policy = infoData.policy && typeof infoData.policy === "object" ? infoData.policy : null;
    }
  }
  return {
    ...base,
    healthy,
    readOnly: data.read_only !== false,
    authRequired: data.auth_required !== false,
    version: typeof data.version === "string" ? data.version.slice(0, 40) : null,
    tools,
    toolCount: tools.length,
    policy,
    gatewayUrl: `http://127.0.0.1:${PORT}/gateway/mcp`,
    error: healthy
      ? ""
      : String(health.error || "MCP health check failed or returned an unexpected service identity.").slice(0, 200),
  };
}

async function readPlatformMcpKey(envFile = PLATFORM_MCP_ENV_FILE) {
  const fromEnv = String(process.env.PLATFORM_MCP_API_KEY || "").trim();
  if (fromEnv.length >= 16) return fromEnv;
  try {
    const text = await fs.readFile(envFile, "utf8");
    const key = parseEnvFileValue(text, "PLATFORM_MCP_API_KEY");
    return key.length >= 16 ? key : "";
  } catch {
    return "";
  }
}

async function buildSearchGatewayStatus(options = {}) {
  const port = Number(options.port || SEARCH_GATEWAY_PORT);
  const checkPort = options.isPortListening || core.isPortListening;
  const getJson = options.fetchJson || fetchJson;
  const listening = await checkPort("127.0.0.1", port);
  const base = {
    id: "search",
    name: "搜索网关",
    host: "127.0.0.1",
    port,
    listening: Boolean(listening),
    healthy: false,
    authRequired: true,
    upstreamBaseUrl: "",
    upstreamViaEntry: false,
    searchMode: "",
    version: null,
    gatewayUrl: `http://127.0.0.1:${PORT}/gateway/search/v1`,
    startCommand: "start-search-gateway.cmd（需要 Docker Desktop）",
    error: listening ? "" : `Search gateway is not listening on port ${port}.`,
  };
  if (!listening) return base;
  const health = await getJson(`http://127.0.0.1:${port}/health`, 4000);
  const data = health.data && typeof health.data === "object" ? health.data : {};
  const healthy = Boolean(health.ok && data.ok && data.service === "local-ai-search-gateway");
  const upstream = String(data.upstreamBaseUrl || "").slice(0, 200);
  return {
    ...base,
    healthy,
    authRequired: data.authRequired !== false,
    upstreamBaseUrl: upstream,
    upstreamViaEntry: /:5176\/gateway\//.test(upstream) || upstream.includes(`:${PORT}/gateway/`),
    searchMode: String(data.searchMode || "").slice(0, 20),
    version: typeof data.version === "string" ? data.version.slice(0, 40) : null,
    searchState: data.searchState && typeof data.searchState === "object" ? data.searchState : null,
    error: healthy ? "" : String(health.error || "Search gateway health check failed.").slice(0, 200),
  };
}

// 一张离线清单：入口首页横幅和桌面通知都从这里取，谁离线、怎么拉起。
function summarizeComponents(managers = [], mcp = null, tts = null, search = null) {
  const items = [];
  for (const manager of managers) {
    items.push({
      id: manager.id,
      name: manager.name,
      kind: "manager",
      online: Boolean(manager.process?.portListening),
      healthy: Boolean(manager.ok),
      startable: true,
      startCommand: `${manager.id === "vllm" ? "vllm-manager" : "llama-manager"}\\start-manager.cmd 或 start-service-entry.cmd`,
      error: manager.error || "",
    });
  }
  if (tts) items.push({ id: "tts", name: "TTS 语音平台", kind: "tts", online: Boolean(tts.listening), healthy: Boolean(tts.healthy), startable: false, startCommand: "start-tts-platform.cmd", error: tts.error || "" });
  if (mcp) items.push({ id: "mcp", name: "MCP 工具服务", kind: "mcp", online: Boolean(mcp.listening), healthy: Boolean(mcp.healthy), startable: false, startCommand: "start-platform-mcp.cmd", error: mcp.error || "" });
  if (search) items.push({ id: "search", name: "搜索网关", kind: "search", online: Boolean(search.listening), healthy: Boolean(search.healthy), startable: false, startCommand: "start-search-gateway.cmd（需要 Docker Desktop）", error: search.error || "" });
  const offline = items.filter((item) => !item.online);
  const unhealthy = items.filter((item) => item.online && !item.healthy);
  return {
    total: items.length,
    online: items.length - offline.length,
    offline: offline.map((item) => item.id),
    unhealthy: unhealthy.map((item) => item.id),
    items,
    allCommand: "start-platform.cmd all",
  };
}

async function buildTtsStatus(options = {}) {
  const port = Number(options.port || TTS_GATEWAY_PORT);
  const checkPort = options.isPortListening || core.isPortListening;
  const getJson = options.fetchJson || fetchTtsJson;
  const listening = await checkPort("127.0.0.1", port);
  const gateway = buildEntryGatewayUrls();
  const base = {
    id: "tts",
    name: "TTS 语音克隆平台",
    host: "127.0.0.1",
    port,
    listening: Boolean(listening),
    healthy: false,
    availableCount: 0,
    totalCount: 0,
    engines: [],
    error: listening ? "" : `TTS gateway is not listening on port ${port}.`,
    gatewayUrls: {
      local: gateway.tts,
      localOpenAi: gateway.ttsOpenAi,
      lan: gateway.lanTts,
      lanOpenAi: gateway.lanTtsOpenAi,
      public: gateway.publicTts,
      publicOpenAi: gateway.publicTtsOpenAi,
    },
  };
  if (!listening) return base;
  const health = await getJson(`http://127.0.0.1:${port}/api/engines`, 10_000);
  const engines = Array.isArray(health.data)
    ? health.data.map((item) => ({
      id: String(item?.id || "").slice(0, 80),
      name: String(item?.name || item?.id || "").slice(0, 160),
      type: String(item?.type || "").slice(0, 40),
      available: Boolean(item?.available),
      detail: typeof item?.detail === "string" ? item.detail.slice(0, 200) : "",
    }))
    : [];
  const availableCount = engines.filter((item) => item.available).length;
  return {
    ...base,
    healthy: Boolean(health.ok && Array.isArray(health.data)),
    availableCount,
    totalCount: engines.length,
    engines,
    error: health.ok && Array.isArray(health.data)
      ? ""
      : String(health.error || "TTS engine health check failed.").slice(0, 240),
  };
}

async function buildManagerStatusFresh(manager) {
  const baseUrl = `http://127.0.0.1:${manager.port}`;
  const pidFile = path.join(manager.root, ".manager.pid");
  const pid = await core.readPidFilePid(pidFile);
  const [portListening, health, runtimeStatus, exposure, clients, externalAccess] = await Promise.all([
    core.isPortListening("127.0.0.1", manager.port),
    fetchJson(`${baseUrl}/api/manager/health`, 5000),
    fetchJson(`${baseUrl}/api/status`, 8000),
    fetchJson(`${baseUrl}/api/service-exposure`, 8000),
    fetchJson(`${baseUrl}/api/service-clients`, 5000),
    fetchJson(`${baseUrl}/api/external-access?limit=20`, 8000),
  ]);
  const pidAlive = pid ? core.isProcessAlive(pid) : false;
  return {
    ...manager,
    ok: Boolean(health.ok && exposure.ok),
    baseUrl,
    servicePageUrl: `${baseUrl}/#exposure`,
    launchPageUrl: `${baseUrl}/#service`,
    statsPageUrl: `${baseUrl}/#stats`,
    logsPageUrl: `${baseUrl}/#logs`,
    externalPageUrl: `${baseUrl}/#external-access`,
    gatewayUrls: buildManagerGatewayUrls(manager),
    process: {
      pidFile,
      pid,
      pidAlive,
      portListening,
      stalePidFile: Boolean(pid && !pidAlive),
      health: health.data || null,
    },
    runtime: runtimeStatus.data || null,
    exposure: exposure.data || null,
    clients: clients.data || null,
    externalAccess: externalAccess.data || null,
    error: health.error || runtimeStatus.error || exposure.error || clients.error || externalAccess.error || "",
  };
}

function findManager(id) {
  const key = String(id || "").toLowerCase();
  return MANAGERS.find((manager) => manager.id === key) || null;
}

function selectGatewayManagersForAuth(engine = "auto", auth = null, managers = MANAGERS) {
  const requestedEngine = String(engine || "auto").trim().toLowerCase();
  const matchedManager = String(auth?.matchedManager || "").trim().toLowerCase();
  return (Array.isArray(managers) ? managers : [])
    .filter((manager) => requestedEngine === "auto" || manager.id === requestedEngine)
    .filter((manager) => !matchedManager || manager.id === matchedManager);
}

function buildEntryGatewayUrls() {
  const localBase = `http://127.0.0.1:${PORT}`;
  const lanBase = HOST === "127.0.0.1" ? null : `http://${core.getLanAddress()}:${PORT}`;
  return {
    localBase,
    lanBase,
    autoOpenAi: `${localBase}/gateway/auto/openai/v1`,
    autoClaude: `${localBase}/gateway/auto/claude`,
    autoOpenCode: `${localBase}/gateway/auto/opencode/v1`,
    tts: `${localBase}/gateway/tts/`,
    ttsOpenAi: `${localBase}/gateway/tts/openai/v1`,
    search: `${localBase}/gateway/search/v1`,
    mcp: `${localBase}/gateway/mcp`,
    status: `${localBase}/gateway/status`,
    lanAutoOpenAi: lanBase ? `${lanBase}/gateway/auto/openai/v1` : null,
    lanAutoClaude: lanBase ? `${lanBase}/gateway/auto/claude` : null,
    lanAutoOpenCode: lanBase ? `${lanBase}/gateway/auto/opencode/v1` : null,
    lanTts: lanBase ? `${lanBase}/gateway/tts/` : null,
    lanTtsOpenAi: lanBase ? `${lanBase}/gateway/tts/openai/v1` : null,
    publicOpenAi: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/auto/openai/v1` : null,
    publicClaude: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/auto/claude` : null,
    publicOpenCode: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/auto/opencode/v1` : null,
    publicTts: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/tts/` : null,
    publicTtsOpenAi: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/tts/openai/v1` : null,
  };
}

function buildManagerGatewayUrls(manager) {
  const localBase = `http://127.0.0.1:${PORT}`;
  const lanBase = HOST === "127.0.0.1" ? null : `http://${core.getLanAddress()}:${PORT}`;
  return {
    openAi: `${localBase}/gateway/${manager.id}/openai/v1`,
    claude: `${localBase}/gateway/${manager.id}/claude`,
    openCode: `${localBase}/gateway/${manager.id}/opencode/v1`,
    lanOpenAi: lanBase ? `${lanBase}/gateway/${manager.id}/openai/v1` : null,
    lanClaude: lanBase ? `${lanBase}/gateway/${manager.id}/claude` : null,
    lanOpenCode: lanBase ? `${lanBase}/gateway/${manager.id}/opencode/v1` : null,
  };
}

function isTtsGatewayPath(pathname) {
  return /^\/gateway\/tts(?:\/|$)/.test(String(pathname || ""));
}

function parseTtsGatewayRoute(pathname) {
  const match = String(pathname || "").match(/^\/gateway\/tts(?:\/(.*))?$/);
  if (!match) return null;
  return {
    engine: "tts",
    protocol: "tts",
    rest: decodeURIComponent(sanitizeGatewayRest(match[1] || "")),
  };
}

function buildTtsGatewayPath(route) {
  const rest = String(route?.rest || "").replace(/^\/+/, "");
  const openAi = rest.match(/^openai\/v1(?:\/(.*))?$/i);
  if (openAi) {
    const suffix = sanitizeGatewayRest(openAi[1] || "");
    return `/v1${suffix ? `/${suffix}` : ""}`;
  }
  const safe = sanitizeGatewayRest(rest);
  return safe ? `/${safe}` : "/";
}

function isTtsUiShellRequest(req, route) {
  return ["GET", "HEAD"].includes(String(req?.method || "GET").toUpperCase())
    && ["", "index.html", "app.js", "app.css", "tokens.css"].includes(String(route?.rest || "").replace(/^\/+|\/+$/g, ""));
}

function isTtsModelManagementRequest(req, route) {
  const method = String(req?.method || "GET").toUpperCase();
  const rest = String(route?.rest || "").replace(/^\/+|\/+$/g, "");
  return method === "POST" && /^api\/models\/[a-z0-9_-]+\/actions\/(install|start|wake|unload|stop)$/i.test(rest);
}

function createTtsBodyLimiter(maxBytes = TTS_GATEWAY_MAX_BODY_BYTES) {
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`TTS request body exceeds ${maxBytes} bytes.`);
        error.code = "request_body_too_large";
        error.status = 413;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  return limiter;
}

function buildTtsProxyHeaders(headers, req) {
  const output = buildProxyHeaders(headers, req);
  const sensitive = new Set([
    "authorization", "x-api-key", "api-key", "anthropic-api-key",
    ...TRUST_HEADER_NAMES.map((name) => String(name || "").toLowerCase()),
  ]);
  for (const key of Object.keys(output)) {
    if (sensitive.has(key.toLowerCase()) || key.toLowerCase().startsWith("x-tts-context")) delete output[key];
  }
  const upstreamKey = String(process.env.TTS_UPSTREAM_API_KEY || "").trim();
  if (upstreamKey) output.authorization = `Bearer ${upstreamKey}`;
  output["x-forwarded-prefix"] = "/gateway/tts";
  const auth = req?.serviceEntryAuth;
  const route = parseTtsGatewayRoute(new URL(req?.url || "/gateway/tts/", "http://localhost").pathname);
  Object.assign(output, signedTtsHeaders(security.getTrustToken(), {
    owner: auth?.client?.id ? `${auth.matchedManager}:${auth.client.id}` : "",
    requestId: req?.ttsRequestId || "",
    method: req?.method || "GET", path: route ? buildTtsGatewayPath(route) : "/",
    policy: auth?.client || {},
  }));
  return output;
}

async function acquireEntryConcurrency(req, res, auth) {
  const policy = auth.client || { maxConcurrentRequests: 16, maxQueuedRequests: 128, queueTimeoutSeconds: 60 };
  const key = auth.client?.id ? `${auth.matchedManager}:${auth.client.id}` : security.resolveClientAddress(req) || "anonymous";
  const slot = await core.waitForServiceGatewayConcurrency(policy, key, entryConcurrencyBuckets, entryConcurrencyQueues, res, Math.min(7200, Number(policy.requestTimeoutSeconds || 600)) * 1000);
  if (!slot.ok) {
    if (!slot.aborted && !res.writableEnded) sendJson(res, { detail: slot.message, code: slot.code }, slot.statusCode || 429, gatewayCorsHeaders(req));
    return false;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot.concurrency.release();
    core.resolveNextServiceGatewayWaiter(policy, key, entryConcurrencyBuckets, entryConcurrencyQueues);
  };
  res.once("finish", release);
  res.once("close", release);
  return true;
}

function ttsRequestTimeoutMs(req, route) {
  const rest = String(route?.rest || "").replace(/^\/+|\/+$/g, "");
  const quick = ["GET", "HEAD"].includes(String(req?.method || "GET").toUpperCase())
    && (rest === "" || rest === "index.html" || rest === "api/engines" || rest === "api/voices" || rest === "openai/v1/models");
  const configured = quick
    ? process.env.SERVICE_ENTRY_TTS_HEALTH_TIMEOUT_MS
    : process.env.SERVICE_ENTRY_TTS_TIMEOUT_MS;
  return Math.max(1000, Number(configured || (quick ? 10_000 : 10 * 60 * 1000)));
}

async function proxyTtsGatewayRequest(req, res, url) {
  const route = parseTtsGatewayRoute(url.pathname);
  if (!route) return sendJson(res, { detail: "Unknown TTS gateway route." }, 404);
  if (buildTtsGatewayPath(route).startsWith("/internal/")) return sendJson(res, { detail: "Not found" }, 404);
  if (req.method === "GET" && url.pathname === "/gateway/tts") {
    res.writeHead(308, { location: `/gateway/tts/${url.search || ""}`, ...gatewayCorsHeaders(req) });
    return res.end();
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, gatewayCorsHeaders(req));
    return res.end();
  }
  if (isTtsModelManagementRequest(req, route) && !isStrictLocalBillingPageRequest(req)) {
    return sendJson(res, {
      detail: "TTS model lifecycle operations are available only through a direct localhost connection.",
      code: "tts_model_management_local_only",
    }, 403, gatewayCorsHeaders(req));
  }

  const startedAt = Date.now();
  let auth = { ok: true, clientId: "", client: null, authRequired: false };
  if (!isTtsUiShellRequest(req, route)) {
    const ban = checkAuthBan(req);
    if (ban) {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 429, startedAt, null, ban.message)).catch(() => {});
      return sendJson(res, { detail: ban.message, code: "auth_banned" }, 429, { ...gatewayCorsHeaders(req), "retry-after": String(ban.retryAfterSeconds) });
    }
    auth = await security.authorizeGatewayRequest(req);
    if (!auth.ok) {
      noteAuthResult(req, auth);
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, auth.status, startedAt, null, auth.message)).catch(() => {});
      const headers = { ...gatewayCorsHeaders(req), ...(auth.status === 401 ? { "www-authenticate": "Bearer" } : {}) };
      return sendJson(res, { detail: auth.message, code: auth.code }, auth.status, headers);
    }
    noteAuthResult(req, auth);
    req.serviceEntryAuth = auth;
  }

  const rate = core.enterServiceRateLimit(
    { rateLimitRpm: Number(auth.client?.rateLimitRpm || process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 600) },
    auth.client?.id ? `${auth.matchedManager}:${auth.client.id}` : security.resolveClientAddress(req) || "anonymous",
    entryRateBuckets,
  );
  if (!rate.ok) {
    const message = `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 429, startedAt, null, message)).catch(() => {});
    return sendJson(res, { detail: message, code: "rate_limit_exceeded" }, 429, {
      ...gatewayCorsHeaders(req),
      "retry-after": String(rate.retryAfterSeconds),
    });
  }

  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > TTS_GATEWAY_MAX_BODY_BYTES) {
    const message = `TTS request body exceeds ${TTS_GATEWAY_MAX_BODY_BYTES} bytes.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 413, startedAt, null, message)).catch(() => {});
    return sendJson(res, { detail: message, code: "request_body_too_large" }, 413, gatewayCorsHeaders(req));
  }
  // TTS 用量计费（F3）：持客户端 Key 的合成请求按秒数 / 字符数进账本，并检查每日秒数配额。
  const synthesis = ttsSynthesisRoute({ rest: buildTtsGatewayPath(route).slice(1) }, req.method);
  const meter = synthesis && auth.client?.id
    ? { clientId: auth.client.id, managerId: auth.matchedManager || "tts", endpoint: synthesis.endpoint, kind: synthesis.kind, characters: 0, engine: "unknown" }
    : null;
  if (!(await isManagerPortListening(TTS_GATEWAY_PORT))) {
    const message = `TTS gateway is not listening on port ${TTS_GATEWAY_PORT}.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 503, startedAt, null, message)).catch(() => {});
    return sendJson(res, { detail: message, code: "tts_gateway_offline" }, 503, gatewayCorsHeaders(req));
  }

  if (!(await acquireEntryConcurrency(req, res, auth))) return;
  let targetPath;
  try {
    targetPath = buildTtsGatewayPath(route);
  } catch (error) {
    return sendJson(res, { detail: error.message, code: error.code || "invalid_gateway_path" }, error.status || 400, gatewayCorsHeaders(req));
  }
  const target = new URL(`http://127.0.0.1:${TTS_GATEWAY_PORT}${targetPath}`);
  target.search = url.search;
  const hasBody = !["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase());
  const upstreamControl = createUpstreamControl(req, res, { timeoutMs: Math.min(ttsRequestTimeoutMs(req, route), Number(auth.client?.requestTimeoutSeconds || 7200) * 1000) });
  let bodyLimitError = null;
  let releaseTtsBody = () => {};
  try {
    let body;
    if (hasBody && meter) {
      // Metered synthesis bodies are small JSON documents: buffer them so the
      // text length is known before the upstream call.
      requireGatewayJsonContentType(req);
      const held = await readRequestBody(req, TTS_GATEWAY_MAX_BODY_BYTES, { trackGlobal: true, holdReservation: true, memoryMultiplier: GATEWAY_BODY_MEMORY_MULTIPLIER });
      releaseTtsBody = held.release;
      const buffered = held.buffer;
      let parsed = parseJsonSafe(buffered ? buffered.toString("utf8") : "", null);
      if (!parsed || typeof parsed !== "object") throw Object.assign(new Error("Invalid synthesis JSON"), { status: 400 });
      if (meter.kind === "retry") {
        const infoTarget = new URL(target);
        infoTarget.pathname = infoTarget.pathname.replace(/\/retry$/, "");
        const infoReq = { ...req, method: "GET", url: `/gateway/tts${infoTarget.pathname}`, headers: req.headers, serviceEntryAuth: auth };
        const info = await fetch(infoTarget, { headers: buildTtsProxyHeaders(req.headers, infoReq), signal: upstreamControl.signal });
        if (!info.ok) throw Object.assign(new Error("Retry job unavailable"), { status: info.status });
        parsed = (await info.json()).request;
      }
      meter.characters = countTtsCharacters(parsed, meter.kind);
      meter.engine = ttsEngineFromBody(parsed);
      meter.requestId = crypto.randomUUID();
      const copies = meter.kind === "batch" ? Math.max(1, new Set(parsed.engines || []).size) : 1;
      const estimatedMs = Math.ceil(Math.max(1000 * copies, meter.characters * 250 / Math.max(0.5, Number(parsed.speed) || 1)));
      const authorization = getBillingStore().authorizeTtsRequest({ ...meter, estimatedMs });
      if (!authorization.allowed) {
        upstreamControl.clear();
        return sendJson(res, { detail: "TTS billing allowance is insufficient for this request.", code: authorization.code }, authorization.code === "billing_insufficient_balance" ? 402 : 429, gatewayCorsHeaders(req));
      }
      req.ttsRequestId = meter.requestId;
      body = buffered;
    } else if (hasBody) {
      const limiter = createTtsBodyLimiter();
      limiter.once("error", (error) => { bodyLimitError = error; });
      body = Readable.toWeb(req.pipe(limiter));
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildTtsProxyHeaders(req.headers, req),
      body,
      ...(hasBody && !meter ? { duplex: "half" } : {}),
      signal: upstreamControl.signal,
      redirect: "manual",
    });
    const responseHeaders = buildResponseHeaders(upstream.headers, req);
    if (isTtsUiShellRequest(req, route)) {
      responseHeaders["content-security-policy"] = TTS_UI_CSP;
      responseHeaders["permissions-policy"] = "camera=(), microphone=(self), geolocation=()";
    }
    res.writeHead(upstream.status, responseHeaders);
    res.once("finish", () => {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, upstream.status, startedAt, null, "")).catch(() => {});
    });
    if (meter?.requestId) {
      if (!upstream.ok) recordTtsUsageSafely({ ...meter, status: upstream.status, ok: false, audioMs: 0, durationSource: "missing" });
      res.once("finish", () => ttsReconciler.flush().catch(() => {}));
    }
    forwardUpstreamBody(upstream, res, upstreamControl);
  } catch (error) {
    upstreamControl.clear();
    const failure = bodyLimitError || error?.cause || error;
    const status = Number(failure?.status || (error?.name === "TimeoutError" ? 504 : 502));
    const message = status === 413 ? failure.message : "TTS gateway upstream is unavailable.";
    // Ambiguous transport failures retain their reservation until a durable completion receipt arrives.
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, status, startedAt, null, failure?.message || message)).catch(() => {});
    if (!res.headersSent) {
      sendJson(res, { detail: message, code: failure?.code || "tts_gateway_proxy_error" }, status, gatewayCorsHeaders(req));
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    releaseTtsBody();
  }
}

async function proxyGatewayRequest(req, res, url) {
  const route = parseGatewayRoute(url.pathname);
  if (!route) return sendJson(res, core.openAiGatewayError("not_found", "Unknown gateway route."), 404);
  if (req.method === "OPTIONS") {
    res.writeHead(204, gatewayCorsHeaders(req));
    return res.end();
  }
  const startedAt = Date.now();
  // Authentication happens here, before the loopback hop, so the managers no
  // longer have to infer trust from a proxied socket address.
  const ban = checkAuthBan(req);
  if (ban) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 429, startedAt, null, ban.message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("auth_banned", ban.message), 429, { ...gatewayCorsHeaders(req), "retry-after": String(ban.retryAfterSeconds) });
  }
  const auth = await security.authorizeGatewayRequest(req);
  noteAuthResult(req, auth);
  if (!auth.ok) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, auth.status, startedAt, null, auth.message)).catch(() => {});
    const headers = { ...gatewayCorsHeaders(req), ...(auth.status === 401 ? { "www-authenticate": "Bearer" } : {}) };
    return sendJson(res, core.openAiGatewayError(auth.code, auth.message), auth.status, headers);
  }
  req.serviceEntryAuth = auth;
  const authorizedManagers = selectGatewayManagersForAuth(route.engine, auth);
  if (!authorizedManagers.length) {
    const message = "This service API key is not authorized for the requested model manager.";
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 403, startedAt, null, message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("manager_forbidden", message), 403, gatewayCorsHeaders(req));
  }
  const rate = core.enterServiceRateLimit(
    { rateLimitRpm: Number(auth.client?.rateLimitRpm || process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 600) },
    // 无 Key 的代理请求按真实客户端地址分桶；用 socket 地址会让所有公网设备
    // 共享 Caddy 的 127.0.0.1 一个桶，一个滥用者就能耗尽全部配额。
    auth.client?.id ? `${auth.matchedManager}:${auth.client.id}` : security.resolveClientAddress(req) || "anonymous",
    entryRateBuckets,
  );
  if (!rate.ok) {
    const message = `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 429, startedAt, null, message)).catch(() => {});
    return sendJson(
      res,
      core.openAiGatewayError("rate_limit_exceeded", message),
      429,
      { ...gatewayCorsHeaders(req), "retry-after": String(rate.retryAfterSeconds) },
    );
  }
  if (isAggregatedModelListRequest(req, route)) {
    return sendAggregatedModelList(req, res, route.engine, auth, authorizedManagers);
  }
  try {
    requireGatewayJsonContentType(req);
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, error.status || 415, startedAt, null, error.message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError(error.code || "unsupported_media_type", error.message), error.status || 415, gatewayCorsHeaders(req));
  }
  let body;
  let releaseBodyBudget = () => {};
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      const heldBody = await readRequestBody(req, GATEWAY_MAX_BODY_BYTES, { holdReservation: true, trackGlobal: true });
      body = heldBody.buffer;
      releaseBodyBudget = heldBody.release;
      res.once("finish", releaseBodyBudget);
      res.once("close", releaseBodyBudget);
    }
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, error.status || 400, startedAt, null, error.message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError(error.code || "invalid_request", error.message), error.status || 400);
  }
  let requestBody = body;
  let contentEncoding = "";
  let releaseCompressedBodyBudget = () => {};
  let parsedBody;
  try {
    contentEncoding = normalizeRequestContentEncoding(req.headers["content-encoding"]);
    if (contentEncoding) {
      // Compression ratio is unknown until allocation has happened. Reserve the
      // full bounded decoded-body budget first so concurrent compressed requests
      // cannot each expand into an otherwise unaccounted 32-64 MiB object graph.
      const rawReservation = Number(requestBody?.length || 0) * GATEWAY_BODY_MEMORY_MULTIPLIER;
      const decodedReservation = GATEWAY_MAX_BODY_BYTES * GATEWAY_BODY_MEMORY_MULTIPLIER;
      releaseCompressedBodyBudget = reserveGatewayBodyMemory(Math.max(0, decodedReservation - rawReservation));
      res.once("finish", releaseCompressedBodyBudget);
      res.once("close", releaseCompressedBodyBudget);
    }
    parsedBody = parseRequestJsonBody(requestBody, {
      contentEncoding,
      maxBytes: GATEWAY_MAX_BODY_BYTES,
    });
    if (requestBody && parsedBody == null) {
      const invalid = new Error("Request body must be a valid JSON object.");
      invalid.code = "invalid_json";
      invalid.status = 400;
      throw invalid;
    }
    parsedBody = parsedBody || {};
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, error.status || 400, startedAt, null, error.message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError(error.code || "invalid_request", error.message), error.status || 400, gatewayCorsHeaders(req));
  }
  const requestMetadata = summarizeGatewayRequestBody(parsedBody);
  const requestedModel = String(parsedBody?.model || "").trim();
  let fleetSettings;
  try {
    fleetSettings = await getFleetSettings();
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 500, startedAt, requestMetadata, "Fleet settings are unavailable.")).catch(() => {});
    return sendJson(res, core.openAiGatewayError("fleet_settings_unavailable", "Fleet routing settings are unavailable."), 500);
  }
  const catalogs = await Promise.all(authorizedManagers.map((manager) => getManagerModelCatalog(manager)));
  const selection = selectFleetTarget(catalogs, {
    engine: route.engine,
    protocol: route.protocol,
    path: route.rest,
    route,
    body: parsedBody,
    requestedModel,
    claudeAliases: CLAUDE_COMPAT_MODEL_ALIASES,
    ...fleetSettings,
  });
  if (selection.error) {
    const status = Number(selection.status || 503);
    const message = selection.message || selection.reason || "No matching model service is available.";
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, status, startedAt, requestMetadata, message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError(selection.error, message), status, gatewayCorsHeaders(req));
  }
  const manager = selection.manager;
  const resolvedModel = String(selection.model?.id || "").trim();
  if (auth.client && !core.serviceClientAllowsModel(auth.client, resolvedModel)) {
    const message = "This service client is not allowed to use the selected model.";
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, 403, startedAt, requestMetadata, message, resolvedModel)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("model_forbidden", message), 403, gatewayCorsHeaders(req));
  }
  const genericModel = GENERIC_MODEL_ID_SET.has(requestedModel.toLowerCase());
  let bodyForUpstream = genericModel && ["openai", "opencode"].includes(route.protocol)
    ? rewriteRequestModelBody(requestBody, resolvedModel, parsedBody)
    : requestBody;
  if (!(await isManagerPortListening(manager.port))) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, 503, startedAt, requestMetadata, `${manager.name} is not listening on port ${manager.port}.`, resolvedModel)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("manager_offline", `${manager.name} is not listening on port ${manager.port}.`), 503);
  }
  let targetPath = "";
  try {
    targetPath = buildManagerGatewayPath(route);
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, error.status || 400, startedAt, requestMetadata, error.message, resolvedModel)).catch(() => {});
    return sendJson(res, core.openAiGatewayError(error.code || "invalid_gateway_path", error.message), error.status || 400, gatewayCorsHeaders(req));
  }
  if (!targetPath) return sendJson(res, core.openAiGatewayError("protocol_not_supported", `${manager.name} does not support ${route.protocol}.`), 404);
  const target = new URL(`http://127.0.0.1:${manager.port}${targetPath}`);
  target.search = url.search;
  const upstreamControl = createUpstreamControl(req, res);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildProxyHeaders(req.headers, req, {
        instanceId: selection.instance?.instanceId || selection.instance?.id || "",
        stripContentEncoding: Boolean(contentEncoding && genericModel && ["openai", "opencode"].includes(route.protocol)),
      }),
      body: bodyForUpstream,
      signal: upstreamControl.signal,
      redirect: "manual",
    });
    requestBody = undefined;
    bodyForUpstream = undefined;
    releaseBodyBudget();
    releaseCompressedBodyBudget();
    res.writeHead(upstream.status, buildResponseHeaders(upstream.headers, req));
    res.once("finish", () => {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, upstream.status, startedAt, requestMetadata, "", resolvedModel)).catch(() => {});
    });
    forwardUpstreamBody(upstream, res, upstreamControl);
  } catch (error) {
    upstreamControl.clear();
    requestBody = undefined;
    bodyForUpstream = undefined;
    releaseBodyBudget();
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, error.status || 502, startedAt, requestMetadata, error.message, resolvedModel)).catch(() => {});
    if (!res.headersSent) {
      sendJson(res, core.openAiGatewayError("gateway_proxy_error", "gateway_proxy_error: upstream unavailable"), error.status || (error.name === "TimeoutError" ? 504 : 502));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

// --- 401 storm guard ---------------------------------------------------------

// Local, non-proxied callers are never banned: a misconfigured local client
// should get a clear 401 every time rather than a ten-minute lockout.
function authGuardKey(req) {
  if (core.isLocalRequest(req) && !security.isProxiedRequest(req)) return "";
  return security.resolveClientAddress(req) || "";
}

function checkAuthBan(req) {
  const key = authGuardKey(req);
  if (!key) return null;
  const ban = authGuard.check(key);
  if (!ban.banned) return null;
  return {
    retryAfterSeconds: ban.retryAfterSeconds,
    message: `Too many failed authentication attempts. Retry after ${ban.retryAfterSeconds}s.`,
  };
}

function noteAuthResult(req, auth) {
  const key = authGuardKey(req);
  if (!key) return;
  if (auth?.ok) {
    authGuard.clear(key);
    return;
  }
  if (auth?.status === 401) authGuard.record(key);
}

// --- /gateway/status ---------------------------------------------------------

async function handleGatewayStatus(req, res, url) {
  const route = { engine: "auto", protocol: "status", rest: "status" };
  const startedAt = Date.now();
  const ban = checkAuthBan(req);
  if (ban) {
    return sendJson(res, core.openAiGatewayError("auth_banned", ban.message), 429, { ...gatewayCorsHeaders(req), "retry-after": String(ban.retryAfterSeconds) });
  }
  const auth = await security.authorizeGatewayRequest(req);
  noteAuthResult(req, auth);
  if (!auth.ok) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, auth.status, startedAt, null, auth.message)).catch(() => {});
    const headers = { ...gatewayCorsHeaders(req), ...(auth.status === 401 ? { "www-authenticate": "Bearer" } : {}) };
    return sendJson(res, core.openAiGatewayError(auth.code, auth.message), auth.status, headers);
  }
  const limitRpm = Number(auth.client?.rateLimitRpm || process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 600);
  const rateKey = auth.client?.id || security.resolveClientAddress(req) || "anonymous";
  const rate = core.enterServiceRateLimit({ rateLimitRpm: limitRpm }, rateKey, entryRateBuckets);
  if (!rate.ok) {
    return sendJson(res, core.openAiGatewayError("rate_limit_exceeded", `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`), 429, { ...gatewayCorsHeaders(req), "retry-after": String(rate.retryAfterSeconds) });
  }
  const authorizedManagers = selectGatewayManagersForAuth("auto", auth);
  const [catalogs, tts, search, mcp] = await Promise.all([
    Promise.all(authorizedManagers.map((manager) => getManagerModelCatalog(manager))),
    buildTtsStatus(),
    buildSearchGatewayStatus(),
    buildPlatformMcpStatus(),
  ]);
  const managers = catalogs.map((catalog) => ({
    id: catalog.manager?.id || catalog.id || "",
    name: catalog.manager?.name || catalog.name || "",
    online: Boolean(catalog.listening),
    running: Boolean(catalog.running),
    models: (catalog.models || []).map((model) => String(model?.id || "").trim()).filter(Boolean).slice(0, 100),
  }));
  const models = Array.from(new Set(managers.flatMap((manager) => manager.models)))
    .filter((id) => !auth.client || core.serviceClientAllowsModel(auth.client, id));
  let quotas = null;
  if (auth.client?.id && typeof getBillingStore().getTtsQuotaState === "function") {
    try {
      quotas = { tts: getBillingStore().getTtsQuotaState({ managerId: auth.matchedManager || "", clientId: auth.client.id }) };
    } catch {
      quotas = null;
    }
  }
  const payload = {
    ok: true,
    service: "local-ai-gateway",
    time: new Date().toISOString(),
    auth: {
      required: Boolean(auth.authRequired),
      clientId: auth.client?.id || "",
      matchedManager: auth.matchedManager || "",
      allowedModels: auth.client?.allowedModels || [],
    },
    rateLimit: { limitPerMinute: limitRpm, remaining: rate.remaining, windowSeconds: 60 },
    quotas,
    models,
    managers,
    tts: { online: Boolean(tts.listening && tts.healthy), availableEngines: (tts.engines || []).filter((item) => item.available).map((item) => item.id) },
    search: { online: Boolean(search.listening && search.healthy), mode: search.searchMode || "" },
    mcp: { online: Boolean(mcp.listening && mcp.healthy), readOnly: mcp.readOnly !== false, toolCount: mcp.toolCount || 0 },
    endpoints: {
      openai: "/gateway/auto/openai/v1",
      claude: "/gateway/auto/claude",
      tts: "/gateway/tts/openai/v1",
      search: "/gateway/search/v1",
      mcp: "/gateway/mcp",
    },
  };
  appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 200, startedAt, null, "")).catch(() => {});
  return sendJson(res, payload, 200, gatewayCorsHeaders(req));
}

// --- search gateway / MCP proxies -------------------------------------------

const AUX_UPSTREAMS = {
  search: { port: () => SEARCH_GATEWAY_PORT, name: "Search gateway", offlineCode: "search_gateway_offline", timeoutMs: 10 * 60 * 1000 },
  mcp: { port: () => PLATFORM_MCP_PORT, name: "MCP server", offlineCode: "mcp_offline", timeoutMs: 10 * 60 * 1000 },
};

async function auxUpstreamCredential(service) {
  if (service === "mcp") return readPlatformMcpKey();
  const configured = String(process.env.SERVICE_ENTRY_SEARCH_GATEWAY_KEY || process.env.SEARCH_GATEWAY_API_KEY || "").trim();
  if (configured) return configured;
  // start-search-gateway.cmd seeds the search key from the last public service
  // key file; read the same file so the entry can present it.
  try {
    const text = await fs.readFile(path.join(AI_ROOT, "vllm-manager", "logs", ".last-public-service-key.txt"), "utf8");
    return text.trim();
  } catch {
    return "";
  }
}

function buildAuxProxyHeaders(headers, req, credential) {
  const out = {};
  const drop = new Set(["host", "connection", "content-length", "authorization", "x-api-key", "api-key", "cookie", ...TRUST_HEADER_NAMES]);
  for (const [name, value] of Object.entries(headers || {})) {
    const key = String(name).toLowerCase();
    if (drop.has(key) || key.startsWith("proxy-")) continue;
    if (Array.isArray(value)) out[key] = value.join(", ");
    else if (value !== undefined) out[key] = String(value);
  }
  if (credential) out.authorization = `Bearer ${credential}`;
  out["x-forwarded-for"] = security.resolveClientAddress(req) || "";
  return out;
}

async function proxyAuxGatewayRequest(req, res, url) {
  const route = parseAuxGatewayRoute(url.pathname);
  if (!route) return sendJson(res, core.openAiGatewayError("not_found", "Unknown gateway route."), 404);
  if (req.method === "OPTIONS") {
    res.writeHead(204, gatewayCorsHeaders(req));
    return res.end();
  }
  const upstreamSpec = AUX_UPSTREAMS[route.service];
  const startedAt = Date.now();
  const ban = checkAuthBan(req);
  if (ban) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 429, startedAt, null, ban.message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("auth_banned", ban.message), 429, { ...gatewayCorsHeaders(req), "retry-after": String(ban.retryAfterSeconds) });
  }
  const auth = await security.authorizeGatewayRequest(req);
  noteAuthResult(req, auth);
  if (!auth.ok) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, auth.status, startedAt, null, auth.message)).catch(() => {});
    const headers = { ...gatewayCorsHeaders(req), ...(auth.status === 401 ? { "www-authenticate": "Bearer" } : {}) };
    return sendJson(res, core.openAiGatewayError(auth.code, auth.message), auth.status, headers);
  }
  req.serviceEntryAuth = auth;
  const rate = core.enterServiceRateLimit(
    { rateLimitRpm: Number(auth.client?.rateLimitRpm || process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 600) },
    auth.client?.id ? `${auth.matchedManager}:${auth.client.id}` : security.resolveClientAddress(req) || "anonymous",
    entryRateBuckets,
  );
  if (!rate.ok) {
    const message = `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 429, startedAt, null, message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("rate_limit_exceeded", message), 429, { ...gatewayCorsHeaders(req), "retry-after": String(rate.retryAfterSeconds) });
  }
  let targetPath;
  try {
    targetPath = buildAuxUpstreamPath(route);
  } catch (error) {
    return sendJson(res, core.openAiGatewayError(error.code || "invalid_gateway_path", error.message), error.status || 400, gatewayCorsHeaders(req));
  }
  const port = upstreamSpec.port();
  if (!(await isManagerPortListening(port))) {
    const message = `${upstreamSpec.name} is not listening on port ${port}.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 503, startedAt, null, message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError(upstreamSpec.offlineCode, message), 503, gatewayCorsHeaders(req));
  }
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > GATEWAY_MAX_BODY_BYTES) {
    const message = `Request body exceeds ${GATEWAY_MAX_BODY_BYTES} bytes.`;
    return sendJson(res, core.openAiGatewayError("request_body_too_large", message), 413, gatewayCorsHeaders(req));
  }
  if (!(await acquireEntryConcurrency(req, res, auth))) return;
  const credential = await auxUpstreamCredential(route.service);
  const target = new URL(`http://127.0.0.1:${port}${targetPath}`);
  target.search = url.search;
  const hasBody = !["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase());
  const upstreamControl = createUpstreamControl(req, res, { timeoutMs: upstreamSpec.timeoutMs });
  let bodyLimitError = null;
  try {
    let body;
    if (hasBody) {
      const limiter = createTtsBodyLimiter(GATEWAY_MAX_BODY_BYTES);
      limiter.once("error", (error) => { bodyLimitError = error; });
      body = Readable.toWeb(req.pipe(limiter));
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildAuxProxyHeaders(req.headers, req, credential),
      body,
      ...(hasBody ? { duplex: "half" } : {}),
      signal: upstreamControl.signal,
      redirect: "manual",
    });
    res.writeHead(upstream.status, buildResponseHeaders(upstream.headers, req));
    res.once("finish", () => {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, upstream.status, startedAt, null, "")).catch(() => {});
    });
    forwardUpstreamBody(upstream, res, upstreamControl);
  } catch (error) {
    upstreamControl.clear();
    const failure = bodyLimitError || error?.cause || error;
    const status = Number(failure?.status || (error?.name === "TimeoutError" ? 504 : 502));
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, status, startedAt, null, failure?.message || "upstream unavailable")).catch(() => {});
    if (!res.headersSent) {
      sendJson(res, core.openAiGatewayError(failure?.code || "gateway_proxy_error", status === 413 ? failure.message : `${upstreamSpec.name} upstream is unavailable.`), status, gatewayCorsHeaders(req));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function requireGatewayJsonContentType(req) {
  const method = String(req?.method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  const contentType = String(req?.headers?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Gateway mutating requests must use Content-Type: application/json.");
    error.code = "unsupported_media_type";
    error.status = 415;
    throw error;
  }
}

function forwardUpstreamBody(upstream, res, upstreamControl, transform = null) {
  if (!upstream?.body) {
    upstreamControl.clear();
    if (!res.writableEnded) res.end();
    if (transform && typeof transform.end === "function") transform.end();
    return;
  }
  const stream = typeof upstream.body.getReader === "function"
    ? Readable.fromWeb(upstream.body)
    : upstream.body;
  if (transform) pipeline(stream, transform, res, () => upstreamControl.clear());
  else pipeline(stream, res, () => upstreamControl.clear());
}

// Billing writes never break a synthesis response: failures are logged and
// the request is still served.
function recordTtsUsageSafely(input) {
  try {
    getBillingStore().recordTtsUsage({
      requestId: input.requestId || crypto.randomUUID(),
      managerId: input.managerId,
      clientId: input.clientId,
      engine: input.engine,
      endpoint: input.endpoint,
      characters: input.characters,
      audioMs: input.audioMs,
      durationSource: input.durationSource,
      status: input.status,
      ok: input.ok,
      externalRequestId: input.externalRequestId || undefined,
    });
  } catch (error) {
    console.warn(`TTS usage not recorded: ${error.message}`);
  }
}

function isAggregatedModelListRequest(req, route) {
  if (req.method !== "GET" || !["openai", "opencode"].includes(route.protocol)) return false;
  const rest = String(route.rest || "").replace(/^\/+|\/+$/g, "");
  return rest === "models" || rest === "v1/models";
}

async function sendAggregatedModelList(req, res, engine = "auto", auth = null, scopedManagers = null) {
  const managers = Array.isArray(scopedManagers)
    ? scopedManagers
    : selectGatewayManagersForAuth(engine, auth);
  if (!managers.length) {
    return sendJson(res, core.openAiGatewayError(
      "manager_forbidden",
      "This service API key is not authorized for the requested model manager.",
    ), 403, gatewayCorsHeaders(req));
  }
  const catalogs = await Promise.all(managers.map((manager) => getManagerModelCatalog(manager)));
  const visible = mergeManagerModelCatalogs(catalogs);
  const data = auth?.client
    ? visible.filter((model) => core.serviceClientAllowsModel(auth.client, model.id))
    : visible;
  if (!data.length) {
    if (visible.length && auth?.client) {
      return sendJson(res, core.openAiGatewayError("model_forbidden", "This service client is not allowed to list models on the selected fleet."), 403, gatewayCorsHeaders(req));
    }
    return sendJson(res, core.openAiGatewayError("service_unavailable", "No running model service reported any models."), 503, gatewayCorsHeaders(req));
  }
  return sendJson(res, { object: "list", data }, 200, gatewayCorsHeaders(req));
}

function mergeManagerModelCatalogs(catalogs = []) {
  const data = [];
  const seen = new Set();
  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      const id = String(model.id || "").trim();
      const key = id.toLowerCase();
      if (!id || seen.has(key)) continue;
      seen.add(key);
      const publicModel = {
        id,
        object: "model",
        owned_by: String(model.owned_by || catalog.manager.id || "local").slice(0, 80),
      };
      if (model.created !== null && model.created !== "" && Number.isFinite(Number(model.created))) {
        publicModel.created = Number(model.created);
      }
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities.map((item) => String(item || "").trim().toLowerCase()).filter((item) => ["text", "vision", "audio", "embedding", "rerank", "tools"].includes(item))
        : [];
      if (capabilities.length) publicModel.capabilities = Array.from(new Set(capabilities));
      data.push(publicModel);
    }
  }
  return data;
}

function buildEntryGatewayAccessEntry(req, route, manager, status, startedAt, body, error, resolvedModel = "") {
  const parsedBody = Buffer.isBuffer(body)
    ? parseRequestJsonBody(body)
    : body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  const headers = req.headers || {};
  return {
    at: new Date().toISOString(),
    remoteAddress: security.resolveClientAddress(req),
    method: req.method,
    path: String(req.url || "").split("?")[0],
    kind: route?.protocol || "",
    requestedEngine: route?.engine || "",
    resolvedEngine: manager?.id || "",
    status: Number(status || 0),
    model: typeof parsedBody?.model === "string" ? parsedBody.model.slice(0, 160) : "",
    resolvedModel: String(resolvedModel || "").slice(0, 160),
    stream: parsedBody?.stream === true,
    authSource: core.serviceApiKeySource(req.headers || {}),
    clientId: String(req.serviceEntryAuth?.clientId || "").slice(0, 120),
    userAgent: headerValue(headers, "user-agent"),
    origin: headerValue(headers, "origin"),
    refererHost: headerHost(headers, "referer"),
    durationMs: Date.now() - startedAt,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolSchemaCount: Number.isFinite(Number(parsedBody?.toolSchemaCount))
      ? Math.max(0, Number(parsedBody.toolSchemaCount))
      : Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolUseCount: 0,
    error: String(error || "").slice(0, 240),
  };
}

function summarizeGatewayRequestBody(parsedBody = {}) {
  return {
    model: typeof parsedBody?.model === "string" ? parsedBody.model.slice(0, 160) : "",
    stream: parsedBody?.stream === true,
    toolSchemaCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
  };
}

function headerValue(headers = {}, name, maxLength = 240) {
  return String(headers[name] || headers[String(name || "").toLowerCase()] || "").trim().slice(0, maxLength);
}

function headerHost(headers = {}, name) {
  const value = headerValue(headers, name);
  if (!value) return "";
  try {
    return new URL(value).host || value;
  } catch {
    return value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].slice(0, 160);
  }
}

function normalizeRequestContentEncoding(value = "") {
  const encodings = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item !== "identity");
  if (!encodings.length) return "";
  if (encodings.length !== 1 || !["gzip", "deflate", "br"].includes(encodings[0])) {
    const error = new Error("Unsupported request Content-Encoding. Use gzip, deflate, br, or identity.");
    error.code = "unsupported_content_encoding";
    error.status = 415;
    throw error;
  }
  return encodings[0];
}

function decodeRequestBody(body, contentEncoding = "", maxBytes = GATEWAY_MAX_BODY_BYTES) {
  if (!body || !Buffer.isBuffer(body)) return body;
  const encoding = normalizeRequestContentEncoding(contentEncoding);
  if (!encoding) return body;
  const maxOutputLength = Math.max(1, Math.floor(Number(maxBytes) || GATEWAY_MAX_BODY_BYTES));
  try {
    if (encoding === "gzip") return zlib.gunzipSync(body, { maxOutputLength });
    if (encoding === "deflate") return zlib.inflateSync(body, { maxOutputLength });
    return zlib.brotliDecompressSync(body, { maxOutputLength });
  } catch (cause) {
    const tooLarge = cause?.code === "ERR_BUFFER_TOO_LARGE";
    const error = new Error(tooLarge
      ? "Decoded request body is too large for the service-entry gateway."
      : `Invalid ${encoding} request body.`);
    error.code = tooLarge ? "request_body_too_large" : "invalid_content_encoding";
    error.status = tooLarge ? 413 : 400;
    error.cause = cause;
    throw error;
  }
}

function parseRequestJsonBody(body, options = {}) {
  if (!body || !Buffer.isBuffer(body)) return null;
  const decoded = decodeRequestBody(body, options.contentEncoding, options.maxBytes);
  const text = decoded.toString("utf8");
  const data = parseJsonSafe(text, null);
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

async function appendEntryGatewayAccessLog(entry) {
  return core.appendAccessLog(GATEWAY_ACCESS_LOG, entry);
}

// 状态页每 5 秒都会带上网关访问统计；重读日志尾部并全量聚合交给短 TTL 单飞缓存。
const ENTRY_ACCESS_STATS_CACHE_MS = Math.max(0, Number(process.env.MODEL_ACCESS_STATS_CACHE_MS ?? 10_000));
const entryAccessStatsCache = core.createSingleFlightCache({ ttlMs: ENTRY_ACCESS_STATS_CACHE_MS, maxEntries: 16 });

async function collectEntryGatewayAccessStats(options = {}) {
  const limit = Math.min(500, Math.max(20, Number(options.limit || 120)));
  const maxLines = Math.min(50000, Math.max(limit, Number(options.maxLines || 12000)));
  if (ENTRY_ACCESS_STATS_CACHE_MS > 0) {
    return entryAccessStatsCache.get(`gateway:${limit}:${maxLines}`, () => collectEntryGatewayAccessStatsFresh(limit, maxLines));
  }
  return collectEntryGatewayAccessStatsFresh(limit, maxLines);
}

async function collectEntryGatewayAccessStatsFresh(limit, maxLines) {
  const lanAddress = core.getLanAddress();
  const events = (await readEntryGatewayAccessEvents(maxLines))
    .map((entry) => core.normalizeAccessEvent(entry, lanAddress))
    .filter((entry) => entry.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
  const external = events.filter((entry) => entry.external);
  const local = events.filter((entry) => !entry.external);
  const now = Date.now();
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    logPath: GATEWAY_ACCESS_LOG,
    privacy: "service-entry 只记录统一网关访问元数据，不记录提示词或响应正文。",
    totals: core.summarizeAccessEvents(events, now),
    external: core.summarizeAccessEvents(external, now),
    local: core.summarizeAccessEvents(local, now),
    clients: core.groupAccessEvents(external, (entry) => entry.remoteAddress || "unknown", { limit: 40 }),
    paths: core.groupAccessEvents(events, (entry) => entry.path || "-", { limit: 30 }),
    models: core.groupAccessEvents(events.filter((entry) => entry.model || entry.resolvedModel), (entry) => entry.model || entry.resolvedModel || "-", { limit: 30 }),
    authSources: core.groupAccessEvents(events, (entry) => entry.authSource || "none", { limit: 20 }),
    kinds: core.groupAccessEvents(events, (entry) => entry.kind || "-", { limit: 10 }),
    statuses: core.groupAccessEvents(events, (entry) => String(entry.status || 0), { limit: 20 }),
    timeline: core.buildAccessTimeline(events, now),
    recent: events.slice(-limit).reverse(),
  };
}

async function readEntryGatewayAccessEvents(maxLines = 12000) {
  return core.readAccessLogEvents(GATEWAY_ACCESS_LOG, maxLines, parseJsonSafe);
}

function parseGatewayRoute(pathname) {
  const match = String(pathname || "").match(/^\/gateway\/(vllm|llama|auto)\/(openai|claude|opencode)(?:\/(.*))?$/);
  if (!match) return null;
  return {
    engine: match[1],
    protocol: match[2],
    rest: String(match[3] || ""),
  };
}

async function resolveGatewayManager(engine, protocol, requestedModel = "") {
  if (engine !== "auto") return findManager(engine);
  const catalogs = await getFleetCatalogs();
  return selectGatewayManager(catalogs, requestedModel);
}

function selectGatewayManager(catalogs = [], requestedModel = "") {
  const value = String(requestedModel || "").trim().toLowerCase();
  if (value && !["auto", "current", "default", "local-current"].includes(value)) {
    const exact = catalogs.find((catalog) => catalog.modelIds.has(value) || catalog.aliases.has(value));
    return exact?.manager || null;
  }
  return catalogs.find((catalog) => catalog.running && catalog.models.length)?.manager
    || catalogs.find((catalog) => catalog.listening)?.manager
    || null;
}

async function getManagerModelCatalog(manager, options = {}) {
  const now = Date.now();
  const cached = managerModelCache.get(manager.id);
  if (!options.force && cached?.value) {
    if (cached.expiresAt <= now && !cached.promise) {
      getManagerModelCatalog(manager, { force: true }).catch(() => {});
    }
    return cached.value;
  }
  if (!options.force && cached?.promise) return cached.promise;
  const promise = (async () => {
    const listening = await core.isPortListening("127.0.0.1", manager.port);
    if (!listening) return emptyManagerCatalog(manager, false);
    const instances = await fetchJson(`http://127.0.0.1:${manager.port}/api/instances`, 5000);
    if (instances.ok) {
      return buildManagerCatalog(manager, instances.data || {}, {
        listening,
        source: "instances",
      });
    }
    // Older managers do not expose /api/instances. Keep the primary-runtime
    // fallback so an incremental upgrade does not take the unified gateway down.
    const runtime = await fetchJson(`http://127.0.0.1:${manager.port}/api/running-models`, 5000);
    if (!runtime.ok && !runtime.data) {
      return emptyManagerCatalog(manager, listening, runtime.error || instances.error || "Model discovery failed.");
    }
    return buildManagerCatalog(manager, runtime.data || {}, {
      listening,
      source: "running-models",
      error: runtime.error || "",
    });
  })();
  managerModelCache.set(manager.id, { promise, value: cached?.value || null, expiresAt: cached?.expiresAt || 0 });
  try {
    const value = await promise;
    managerModelCache.set(manager.id, { value, expiresAt: Date.now() + MODEL_DISCOVERY_CACHE_MS, promise: null });
    return value;
  } catch (error) {
    const value = emptyManagerCatalog(manager, true, error.message);
    managerModelCache.set(manager.id, { value, expiresAt: Date.now() + 500, promise: null });
    return value;
  }
}

function buildManagerCatalog(manager, payload = {}, options = {}) {
  const instances = normalizeManagerInstances(manager, payload);
  const models = flattenCatalogModels(instances).map((model) => ({
    ...model,
    aliases: Array.from(new Set([
      ...(Array.isArray(model.aliases) ? model.aliases : []),
      ...core.deriveOpenAiGatewayModelAliases(model.id),
    ].map((alias) => String(alias || "").trim()).filter(Boolean))),
  }));
  const modelIds = new Set(models.map((model) => String(model.id || "").trim().toLowerCase()).filter(Boolean));
  const aliases = new Set(core.buildOpenAiGatewayAliasList({
    models,
    runtime: { servedModels: models },
  }).map((alias) => alias.toLowerCase()));
  return {
    manager,
    listening: options.listening !== false,
    running: Boolean(instances.some((instance) => instance.running) && models.length),
    instances,
    models,
    modelIds,
    aliases,
    source: String(options.source || "instances"),
    error: String(options.error || ""),
  };
}

async function getFleetCatalogs(options = {}) {
  return Promise.all(MANAGERS.map((manager) => getManagerModelCatalog(manager, options)));
}

async function getFleetSettings() {
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(FLEET_SETTINGS_FILE)).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (fleetSettingsCache.value && fleetSettingsCache.mtimeMs === mtimeMs) return fleetSettingsCache.value;
  const stored = await core.readJsonFile(FLEET_SETTINGS_FILE, {});
  const value = normalizeFleetSettings(stored || {});
  fleetSettingsCache = { mtimeMs, value };
  return value;
}

async function saveFleetSettings(input = {}) {
  const settings = normalizeFleetSettings(input);
  await core.writeJsonFile(FLEET_SETTINGS_FILE, settings);
  let mtimeMs = Date.now();
  try {
    mtimeMs = (await fs.stat(FLEET_SETTINGS_FILE)).mtimeMs;
  } catch {
    // Keep the in-memory value even if the follow-up stat fails.
  }
  fleetSettingsCache = { mtimeMs, value: settings };
  return settings;
}

async function getFleetResources() {
  return Promise.all(MANAGERS.map(async (manager) => {
    const response = await fetchJson(`http://127.0.0.1:${manager.port}/api/resources`, 5000);
    if (response.ok && response.data && typeof response.data === "object") {
      return { manager_engine: manager.id, ...response.data };
    }
    return { manager_engine: manager.id, error: response.error || "Manager resources are unavailable." };
  }));
}

async function buildServiceEntryFleetSnapshot(settingsOverride = null) {
  const [settings, catalogs, resources] = await Promise.all([
    settingsOverride ? Promise.resolve(normalizeFleetSettings(settingsOverride)) : getFleetSettings(),
    getFleetCatalogs(),
    getFleetResources(),
  ]);
  return buildFleetSnapshot({
    catalogs,
    resources,
    settings,
    gatewayBase: buildEntryGatewayUrls().autoOpenAi,
  });
}

async function buildFleetRoutePreview(input = {}) {
  const settings = await getFleetSettings();
  const catalogs = await getFleetCatalogs();
  const request = { ...buildFleetRouteRequest(input, settings), dryRun: true };
  const target = selectFleetTarget(catalogs, request);
  return serializeFleetRouteTarget(target, request);
}

function buildFleetRouteRequest(input = {}, settings = {}) {
  const source = input.request && typeof input.request === "object" && !Array.isArray(input.request)
    ? input.request
    : input;
  const route = source.route && typeof source.route === "object" ? source.route : {};
  const body = source.body && typeof source.body === "object" && !Array.isArray(source.body)
    ? { ...source.body }
    : {};
  if (body.model === undefined && source.model !== undefined) body.model = source.model;
  const requestedCapability = String(source.capability || input.capability || "").trim().toLowerCase();
  if (requestedCapability === "vision" && !body.messages) {
    body.messages = [{ role: "user", content: [{ type: "input_image", image_url: "preview://image" }] }];
  } else if (requestedCapability === "audio" && !body.messages) {
    body.messages = [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "preview" } }] }];
  } else if (requestedCapability === "tools" && !Array.isArray(body.tools)) {
    body.tools = [{ type: "function", function: { name: "preview", parameters: { type: "object" } } }];
  }
  const defaultPath = requestedCapability === "embedding"
    ? "v1/embeddings"
    : requestedCapability === "rerank" ? "v1/rerank" : "v1/chat/completions";
  return {
    engine: String(source.engine || route.engine || "auto").toLowerCase(),
    protocol: String(source.protocol || route.protocol || "openai").toLowerCase(),
    path: String(source.path || route.rest || defaultPath),
    route,
    body,
    requestedModel: source.requestedModel ?? body.model ?? "",
    capability: requestedCapability === "language" ? "text" : requestedCapability || undefined,
    claudeAliases: CLAUDE_COMPAT_MODEL_ALIASES,
    ...settings,
  };
}

function serializeFleetRouteTarget(target = {}, request = {}) {
  return {
    ok: !target.error,
    status: Number(target.status || (target.error ? 503 : 200)),
    error: String(target.error || ""),
    message: String(target.message || (target.error ? target.reason : "") || ""),
    capability: String(target.capability || ""),
    reason: String(target.reason || ""),
    policy: target.policy && typeof target.policy === "object" ? { ...target.policy } : null,
    request: {
      engine: request.engine,
      protocol: request.protocol,
      path: request.path,
      requestedModel: String(request.requestedModel || ""),
    },
    manager: target.manager ? {
      id: target.manager.id,
      name: target.manager.name,
      port: target.manager.port,
    } : null,
    instance: target.instance ? {
      id: target.instance.id,
      instanceId: target.instance.instanceId,
      primary: Boolean(target.instance.primary),
      containerName: target.instance.containerName,
      port: target.instance.port,
      status: target.instance.status,
    } : null,
    model: target.model ? {
      id: target.model.id,
      root: target.model.root || "",
      capabilities: Array.isArray(target.model.capabilities) ? target.model.capabilities : [],
    } : null,
  };
}

function emptyManagerCatalog(manager, listening, error = "") {
  return {
    manager,
    listening,
    running: false,
    instances: [],
    models: [],
    modelIds: new Set(),
    aliases: new Set(),
    source: "unavailable",
    error,
  };
}

function sanitizeGatewayRest(rest) {
  const parts = String(rest || "").split("/").filter((part) => part !== "");
  const safe = [];
  for (const part of parts) {
    let decoded = part;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      const error = new Error("Invalid gateway path encoding.");
      error.code = "invalid_gateway_path";
      error.status = 400;
      throw error;
    }
    const lower = decoded.toLowerCase();
    if (
      decoded === ".."
      || decoded === "."
      || decoded.includes("\\")
      || decoded.includes("/")
      || decoded.includes("\0")
      || lower.includes("%2e")
      || lower.includes("%2f")
      || lower.includes("%5c")
    ) {
      const error = new Error("Invalid gateway path.");
      error.code = "invalid_gateway_path";
      error.status = 400;
      throw error;
    }
    safe.push(encodeURIComponent(decoded));
  }
  return safe.join("/");
}

function buildManagerGatewayPath(route) {
  const rest = sanitizeGatewayRest(route.rest);
  if (route.protocol === "openai") {
    const suffix = rest.replace(/^v1\/?/, "");
    return `/serve/v1${suffix ? `/${suffix}` : ""}`;
  }
  if (route.protocol === "claude") {
    return `/claude${rest ? `/${rest}` : ""}`;
  }
  if (route.protocol === "opencode") {
    const suffix = rest.replace(/^v1\/?/, "");
    return `/opencode/v1${suffix ? `/${suffix}` : ""}`;
  }
  return "";
}

function buildProxyHeaders(headers, req = null, options = {}) {
  const output = {};
  const stripped = new Set([
    "host", "connection", "content-length", "transfer-encoding", "upgrade",
    "keep-alive", "te", "trailer", "proxy-connection", "proxy-authenticate", "proxy-authorization",
    ...TRUST_HEADER_NAMES,
  ]);
  if (options.stripContentEncoding) stripped.add("content-encoding");
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    // Trust headers are dropped before being re-issued below, so a client
    // cannot forge the address this process vouches for.
    if (stripped.has(lower) || lower.startsWith("proxy-")) continue;
    output[key] = value;
  }
  const trustHeaders = security.trustHeaders(req);
  Object.assign(output, trustHeaders);
  const instanceId = String(options.instanceId || "").trim();
  if (instanceId) {
    Object.assign(output, core.buildServiceEntryInstanceHeaders(
      security.getTrustToken(),
      instanceId,
      trustHeaders,
    ));
  }
  const clientAddress = security.resolveClientAddress(req);
  if (clientAddress) {
    output["x-forwarded-for"] = clientAddress;
  }
  return output;
}

function buildResponseHeaders(headers, req) {
  const output = gatewayCorsHeaders(req);
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "transfer-encoding", "content-encoding", "keep-alive", "te", "trailer"].includes(lower) || lower.startsWith("proxy-")) continue;
    output[key] = value;
  }
  output["cache-control"] = output["cache-control"] || "no-store";
  return output;
}

// Default-deny: an Origin is only echoed when it was explicitly configured.
// The previous version reflected whatever the caller sent, which let any page
// the user visited read and write the local gateway.
function gatewayCorsHeaders(req) {
  return security.corsHeaders(req);
}

function createUpstreamControl(req, res, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.SERVICE_ENTRY_GATEWAY_TIMEOUT_MS || 30 * 60 * 1000));
  const timer = setTimeout(() => controller.abort(new Error("Gateway request timed out.")), timeoutMs);
  timer.unref?.();
  const abort = () => {
    if (!res.writableEnded) controller.abort(new Error("Client disconnected."));
  };
  req.once?.("aborted", abort);
  res.once?.("close", abort);
  let cleared = false;
  return {
    signal: controller.signal,
    clear: () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      req.off?.("aborted", abort);
      res.off?.("close", abort);
    },
  };
}

async function readRequestBody(req, maxBytes, options = {}) {
  const chunks = [];
  let total = 0;
  let reserved = 0;
  let released = false;
  const memoryMultiplier = options.trackGlobal
    ? Math.max(1, Number(options.memoryMultiplier || GATEWAY_BODY_MEMORY_MULTIPLIER))
    : 1;
  const globalBudgetBytes = Math.max(1, Number(options.globalBudgetBytes || GATEWAY_TOTAL_BUFFER_BYTES));
  const release = () => {
    if (released) return;
    released = true;
    if (options.trackGlobal && reserved > 0) {
      gatewayBufferedBodyBytes = Math.max(0, gatewayBufferedBodyBytes - reserved);
    }
  };
  try {
    for await (const rawChunk of req) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("Request body too large for service-entry gateway.");
        error.code = "request_body_too_large";
        error.status = 413;
        throw error;
      }
      const reservationBytes = chunk.length * memoryMultiplier;
      if (options.trackGlobal && gatewayBufferedBodyBytes + reservationBytes > globalBudgetBytes) {
        const error = new Error("Service-entry request buffer budget is busy; retry after active uploads finish.");
        error.code = "gateway_body_budget_exhausted";
        error.status = 503;
        throw error;
      }
      if (options.trackGlobal) {
        gatewayBufferedBodyBytes += reservationBytes;
        reserved += reservationBytes;
      }
      chunks.push(chunk);
    }
    const buffer = chunks.length ? Buffer.concat(chunks, total) : undefined;
    if (options.holdReservation) return { buffer, release };
    release();
    return buffer;
  } catch (error) {
    release();
    throw error;
  }
}

function reserveGatewayBodyMemory(bytes) {
  const reservation = Math.max(0, Math.ceil(Number(bytes) || 0));
  if (!reservation) return () => {};
  if (gatewayBufferedBodyBytes + reservation > GATEWAY_TOTAL_BUFFER_BYTES) {
    const error = new Error("Service-entry request buffer budget is busy; retry after active uploads finish.");
    error.code = "gateway_body_budget_exhausted";
    error.status = 503;
    throw error;
  }
  gatewayBufferedBodyBytes += reservation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gatewayBufferedBodyBytes = Math.max(0, gatewayBufferedBodyBytes - reservation);
  };
}

function boundedByteLimit(value, fallback, min, max) {
  const parsed = Number(value);
  const bytes = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, bytes));
}

async function readJsonObjectBody(req, maxBytes) {
  const buffer = await readRequestBody(req, maxBytes);
  if (!buffer?.length) return {};
  const data = parseJsonSafe(buffer.toString("utf8"), null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("Request body must be a JSON object.");
    error.status = 400;
    throw error;
  }
  return data;
}

async function startDetachedManager(manager) {
  if (await core.isPortListening("127.0.0.1", manager.port)) {
    return { ok: true, alreadyRunning: true, status: await buildManagerStatus(manager, { force: true }) };
  }
  await fs.mkdir(path.join(manager.root, "logs"), { recursive: true });
  const nodeExe = process.env.NODE_EXE || process.execPath || "node";
  const out = fsSync.openSync(path.join(manager.root, "logs", "manager.out.log"), "a");
  const err = fsSync.openSync(path.join(manager.root, "logs", "manager.err.log"), "a");
  const env = {
    ...process.env,
    [manager.envPort]: String(manager.port),
    [manager.envHost]: manager.defaultHost,
    // Env is a bootstrap fallback; managers prefer the published file so they
    // can follow entry token rotation without a manager restart.
    SERVICE_GATEWAY_TRUST_TOKEN: security.getTrustToken(),
    AI_ROOT: process.env.AI_ROOT || AI_ROOT,
  };
  if (manager.id === "vllm") env.VLLM_MANAGER_ALLOW_REMOTE = env.VLLM_MANAGER_ALLOW_REMOTE || "0";
  if (manager.id === "llama") env.LLAMA_MANAGER_ALLOW_REMOTE = env.LLAMA_MANAGER_ALLOW_REMOTE || "0";
  const child = spawn(nodeExe, ["server.js"], {
    cwd: manager.root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
    env,
  });
  child.on("error", (error) => {
    console.error(`无法启动 ${manager.name}: ${error.code === "ENOENT" ? "找不到 Node 可执行文件" : error.message}`);
  });
  fsSync.closeSync(out);
  fsSync.closeSync(err);
  child.unref();
  await fs.writeFile(path.join(manager.root, ".manager.pid"), `${child.pid}\n`, "utf8");
  const ready = await waitForManagerReady(manager, 12000);
  return { ok: ready, pid: child.pid, ready, status: await buildManagerStatus(manager, { force: true }) };
}

async function stopManager(manager) {
  const baseUrl = `http://127.0.0.1:${manager.port}`;
  const stopped = await postJson(`${baseUrl}/api/manager/shutdown`);
  return { ok: stopped.ok, stopped, status: await buildManagerStatus(manager, { force: true }) };
}

async function waitForManagerReady(manager, timeoutMs) {
  const startedAt = Date.now();
  const baseUrl = `http://127.0.0.1:${manager.port}`;
  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetchJson(`${baseUrl}/api/manager/health`);
    if (health.ok) return true;
    await delay(400);
  }
  return false;
}

async function fetchJson(url, timeoutMs = 2500, headers = undefined) {
  try {
    const response = await fetch(url, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || 2500)),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, data: parseJsonSafe(text, null), error: response.ok ? "" : text };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error.message };
  }
}

async function fetchTtsJson(url, timeoutMs = 2500) {
  try {
    const upstreamKey = String(process.env.TTS_UPSTREAM_API_KEY || "").trim();
    const response = await fetch(url, {
      headers: upstreamKey ? { authorization: `Bearer ${upstreamKey}` } : {},
      signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || 2500)),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, data: parseJsonSafe(text, null), error: response.ok ? "" : text };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error.message };
  }
}

async function postJson(url) {
  try {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(2000) });
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return { url, ok: false, status: 0, error: error.message };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sendJson(res, data, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function shutdownSoon(options = {}) {
  const targetServer = options.server !== undefined ? options.server : server;
  const exitProcess = typeof options.exit === "function" ? options.exit : (code) => process.exit(code);
  const graceMs = Math.max(100, Number(options.graceMs || process.env.SERVICE_ENTRY_SHUTDOWN_GRACE_MS || 5000));
  const delayMs = options.delayMs ?? 100;
  setTimeout(async () => {
    // Drop the published token so a stale file cannot authorize a later process.
    await security.revokeTrustToken().catch(() => {});
    const closeBillingStore = () => {
      if (!billingStore) return;
      try {
        billingStore.close();
      } catch {
        // The process is already shutting down; the OS will close this owned
        // SQLite connection if the explicit close fails.
      }
      billingStore = null;
    };
    let exited = false;
    const finish = (code = 0) => {
      if (exited) return;
      exited = true;
      Promise.resolve()
        .then(() => core.flushAllAccessLogs())
        .catch(() => {})
        .finally(() => {
          closeBillingStore();
          exitProcess(code);
        });
    };
    if (targetServer) {
      // Let already accepted settlement requests finish, then force-close
      // leftover SSE connections so shutdown cannot hang forever.
      let forceExit;
      targetServer.close(() => {
        clearTimeout(forceExit);
        finish(0);
      });
      forceExit = setTimeout(() => {
        try { targetServer.closeAllConnections(); } catch { /* Node < 18.2 */ }
        finish(0);
      }, graceMs);
      forceExit.unref?.();
    } else {
      finish(0);
    }
  }, delayMs);
}

module.exports = {
  MANAGERS,
  TTS_UI_CSP,
  buildEntryGatewayAccessEntry,
  buildEntryGatewayUrls,
  buildFleetRouteRequest,
  buildFleetSnapshot,
  buildManagerCatalog,
  buildPlatformMcpStatus,
  buildSearchGatewayStatus,
  buildAuxProxyHeaders,
  buildTtsStatus,
  authGuard,
  checkAuthBan,
  handleGatewayStatus,
  noteAuthResult,
  proxyAuxGatewayRequest,
  recordTtsUsageSafely,
  summarizeComponents,
  summarizeServiceKeys,
  buildTtsGatewayPath,
  buildTtsProxyHeaders,
  buildManagerGatewayPath,
  buildManagerGatewayUrls,
  buildProxyHeaders,
  buildServiceEntryFleetSnapshot,
  collectEntryGatewayAccessStats,
  createUpstreamControl,
  createTtsBodyLimiter,
  createServiceEntryServer,
  emptyManagerCatalog,
  findManager,
  flattenCatalogModels,
  forwardUpstreamBody,
  getFleetCatalogs,
  getBillingStore,
  getFleetSettings,
  getManagerModelCatalog,
  handleRequest,
  handleBillingHttpRequest,
  isAggregatedModelListRequest,
  isStrictLocalBillingPageRequest,
  isTtsModelManagementRequest,
  mergeManagerModelCatalogs,
  normalizeFleetSettings,
  normalizeManagerInstances,
  normalizeRequestContentEncoding,
  parseGatewayRoute,
  parseTtsGatewayRoute,
  parseRequestJsonBody,
  readRequestBody,
  requireGatewayJsonContentType,
  redactAccessForRemote,
  redactStatusForRemote,
  resolveGatewayManager,
  rewriteRequestModelBody,
  saveFleetSettings,
  security,
  selectGatewayManagersForAuth,
  selectFleetTarget,
  selectGatewayManager,
  serializeFleetRouteTarget,
  sendAggregatedModelList,
  flushTtsSettlements: () => ttsReconciler.flush(),
  resetEntryRateLimitBuckets() {
    entryRateBuckets.clear();
  },
  shutdownSoon,
  startServiceEntry,
};
