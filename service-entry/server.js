const http = require("node:http");
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
const ROOT = __dirname;
const AI_ROOT = path.dirname(ROOT);
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
  return httpServer;
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    // Host whitelist + Origin check for mutating requests. Without this any page
    // the user has open can drive the entry over loopback.
    const guard = security.checkRequest(req, url);
    if (!guard.ok) return sendJson(res, { error: guard.message, code: guard.code }, guard.status);
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
    if (url.pathname.startsWith("/gateway/")) {
      return proxyGatewayRequest(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/api/security") {
      const allowed = security.checkManagementAccess(req);
      const securityState = allowed.ok ? await security.describe() : security.describePublic();
      return sendJson(res, { ok: true, security: securityState });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const detailed = security.checkManagementAccess(req).ok;
      const [managers, mcp, tts] = await Promise.all([
        Promise.all(MANAGERS.map(buildManagerStatus)),
        buildPlatformMcpStatus(),
        buildTtsStatus(),
      ]);
      const payload = {
        ok: true,
        security: await security.describe(),
        entry: {
          host: HOST,
          port: PORT,
          lanAddress: core.getLanAddress(),
          pid: process.pid,
          uptimeSeconds: process.uptime(),
          gateway: buildEntryGatewayUrls(),
          gatewayAccess: await collectEntryGatewayAccessStats({ limit: 20, maxLines: 2000 }),
        },
        managers,
        mcp,
        tts,
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
    security: security.describePublic(payload.security),
    entry: {
      ...payload.entry,
      pid: undefined,
      gatewayAccess: redactAccessForRemote(payload.entry.gatewayAccess),
    },
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
  return {
    ...base,
    healthy: Boolean(health.ok && data.ok && data.service === "local-ai-platform-mcp"),
    readOnly: data.read_only !== false,
    authRequired: data.auth_required !== false,
    version: typeof data.version === "string" ? data.version.slice(0, 40) : null,
    error: health.ok && data.service === "local-ai-platform-mcp"
      ? ""
      : String(health.error || "MCP health check failed or returned an unexpected service identity.").slice(0, 200),
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
    rest: match[1] || "",
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
    && ["", "index.html"].includes(String(route?.rest || "").replace(/^\/+|\/+$/g, ""));
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
    if (sensitive.has(key.toLowerCase())) delete output[key];
  }
  const upstreamKey = String(process.env.TTS_UPSTREAM_API_KEY || "").trim();
  if (upstreamKey) output.authorization = `Bearer ${upstreamKey}`;
  output["x-forwarded-prefix"] = "/gateway/tts";
  return output;
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
    auth = await security.authorizeGatewayRequest(req);
    if (!auth.ok) {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, auth.status, startedAt, null, auth.message)).catch(() => {});
      const headers = { ...gatewayCorsHeaders(req), ...(auth.status === 401 ? { "www-authenticate": "Bearer" } : {}) };
      return sendJson(res, { detail: auth.message, code: auth.code }, auth.status, headers);
    }
    req.serviceEntryAuth = auth;
  }

  const rate = core.enterServiceRateLimit(
    { rateLimitRpm: Number(auth.client?.rateLimitRpm || process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 600) },
    auth.client?.id || req.socket?.remoteAddress || "anonymous",
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
  if (!(await isManagerPortListening(TTS_GATEWAY_PORT))) {
    const message = `TTS gateway is not listening on port ${TTS_GATEWAY_PORT}.`;
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 503, startedAt, null, message)).catch(() => {});
    return sendJson(res, { detail: message, code: "tts_gateway_offline" }, 503, gatewayCorsHeaders(req));
  }

  let targetPath;
  try {
    targetPath = buildTtsGatewayPath(route);
  } catch (error) {
    return sendJson(res, { detail: error.message, code: error.code || "invalid_gateway_path" }, error.status || 400, gatewayCorsHeaders(req));
  }
  const target = new URL(`http://127.0.0.1:${TTS_GATEWAY_PORT}${targetPath}`);
  target.search = url.search;
  const hasBody = !["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase());
  const upstreamControl = createUpstreamControl(req, res, { timeoutMs: ttsRequestTimeoutMs(req, route) });
  let bodyLimitError = null;
  try {
    let body;
    if (hasBody) {
      const limiter = createTtsBodyLimiter();
      limiter.once("error", (error) => { bodyLimitError = error; });
      body = Readable.toWeb(req.pipe(limiter));
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildTtsProxyHeaders(req.headers, req),
      body,
      ...(hasBody ? { duplex: "half" } : {}),
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
    forwardUpstreamBody(upstream, res, upstreamControl);
  } catch (error) {
    upstreamControl.clear();
    const failure = bodyLimitError || error?.cause || error;
    const status = Number(failure?.status || (error?.name === "TimeoutError" ? 504 : 502));
    const message = status === 413 ? failure.message : "TTS gateway upstream is unavailable.";
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, status, startedAt, null, failure?.message || message)).catch(() => {});
    if (!res.headersSent) {
      sendJson(res, { detail: message, code: failure?.code || "tts_gateway_proxy_error" }, status, gatewayCorsHeaders(req));
    } else if (!res.writableEnded) {
      res.end();
    }
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
  const auth = await security.authorizeGatewayRequest(req);
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
    auth.client?.id || req.socket?.remoteAddress || "anonymous",
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

function forwardUpstreamBody(upstream, res, upstreamControl) {
  if (!upstream?.body) {
    upstreamControl.clear();
    if (!res.writableEnded) res.end();
    return;
  }
  const stream = typeof upstream.body.getReader === "function"
    ? Readable.fromWeb(upstream.body)
    : upstream.body;
  pipeline(stream, res, () => upstreamControl.clear());
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
    remoteAddress: req.socket?.remoteAddress || "",
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

async function collectEntryGatewayAccessStats(options = {}) {
  const limit = Math.min(500, Math.max(20, Number(options.limit || 120)));
  const maxLines = Math.min(50000, Math.max(limit, Number(options.maxLines || 12000)));
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
  const request = buildFleetRouteRequest(input, settings);
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
  if (req?.socket?.remoteAddress) {
    output["x-forwarded-for"] = req.socket.remoteAddress;
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

async function fetchJson(url, timeoutMs = 2500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || 2500)) });
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
  buildTtsStatus,
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
  resetEntryRateLimitBuckets() {
    entryRateBuckets.clear();
  },
  shutdownSoon,
  startServiceEntry,
};
