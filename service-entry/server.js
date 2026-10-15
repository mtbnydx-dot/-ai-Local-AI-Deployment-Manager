const http = require("node:http");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { pipeline, Readable, Transform } = require("node:stream");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const core = require("../manager-core");
const { createEntrySecurity } = require("./lib/security");
const { createGatewayPipeline, scopeForGatewayPath } = require("./lib/gateway-pipeline");
const { createLimiter } = require("./lib/limiter");
const { lookupPublicError, newRequestId, sendPublicError } = require("./lib/public-errors");
const { startListeners, tagListener } = require("./lib/listeners");
const { createPublicListener } = require("./lib/public-listener");
const { createPublicApi, modelReadOf, parseGatewayRoute } = require("./lib/public-api");
const { createMeRoutes } = require("./lib/me-routes");
const telemetryQuery = require("../manager-core/telemetry/query");
const { createPortalRoutes } = require("./lib/portal-routes");
const { createPublicData, startStatusSampler } = require("./lib/status-sampler");
const { createExposureScanner } = require("./lib/exposure-scan");
const { createSecurityOverview } = require("./lib/security-overview");
const { createBillingStore } = require("./lib/billing-store");
const { createBillingHttpHandler, strictLocalBillingAdmin } = require("./lib/billing-http");
const { summarizeServiceKeys, redactKeySummary } = require("./lib/key-overview");
const { ACCESS_STORE_FILENAME, createKeysStore } = require("./lib/keys-store");
const keyMigration = require("./lib/key-migration");
const { parseAuxGatewayRoute, buildAuxUpstreamPath, parseEnvFileValue } = require("./lib/aux-gateway");
const { ttsSynthesisRoute, countTtsCharacters, ttsEngineFromBody, createWavDurationProbe, createJsonCollector, parseTtsJsonDuration } = require("./lib/tts-usage");
const { signedTtsHeaders, createTtsReconciler } = require("./lib/tts-bridge");
const { createEventBus } = require("./lib/events");
const { createRequestAuth, redactInstancesEventForViewer, redactStatusEventForViewer } = require("./lib/request-auth");
const { createViewerRegistry } = require("./lib/viewer-allowlist");
const { createMachineAuth } = require("./lib/machine-auth");
const { createAdminAuth, registerSessionRoutes } = require("./lib/admin-session");
const { redactManagerReadForViewer } = require("./lib/mgmt-proxy");
const platformRoutes = require("./lib/platform-routes");
const { createModelHub, discoverHubClis } = require("../manager-core/model-hub");
const { createTelemetryRuntime } = require("./lib/telemetry-runtime");
const { inferSourceProgram } = require("../manager-core/telemetry/source-program");
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
// The telemetry runtime (04): the gateway recorder (TEL-5), the store and the
// collectors. It is set by startTelemetry() and cleared by stopTelemetry();
// while it is null, or disabled (TELEMETRY_ENABLED=0), the gateway runs
// exactly as before.
let telemetry = null;
// The one limiter (05 §9, lib/limiter.js): rpm/tpm buckets, the per-IP
// pre-auth bucket, quotas, the public share gate, and the persistent bans.
// 401 风暴防护：同一客户端地址在窗口内连续鉴权失败即临时封禁（落在访问库里，
// 重启不丢，再次触发时间逐级加长），公网扫描者拿到的是廉价的 429 而不是每次
// 一遍密钥库读取 + 访问日志。Settings are read live from the access config;
// SERVICE_ENTRY_RATE_LIMIT_RPM still wins for the keyless ADMIN gateway.
const gatewayLimiter = createLimiter({
  store: () => getAccessStore(),
  config: () => security.accessConfig(),
  gatewayRpm: () => Number(process.env.SERVICE_ENTRY_RATE_LIMIT_RPM || 0),
  // security.ban in the telemetry events (04 §9 source 6).
  onBan: (ban) => telemetry?.recordSecurityBan?.(ban),
});
const authGuard = gatewayLimiter.bans;
const GATEWAY_ACCESS_LOG = path.join(ROOT, "logs", "gateway-access.log");
// SERVICE_ENTRY_DATA_DIR moves every file the entry keeps under service-entry/data
// (the SQLite stores, the hub, fleet and storage settings). Tests start many
// entries at once, and each one gets its own temp directory so that no two
// processes open the same database.
const DATA_DIR = process.env.SERVICE_ENTRY_DATA_DIR ? path.resolve(process.env.SERVICE_ENTRY_DATA_DIR) : path.join(ROOT, "data");
const FLEET_SETTINGS_FILE = path.join(DATA_DIR, "fleet-settings.json");
const BILLING_DB_FILE = process.env.AI_BILLING_DB || path.join(DATA_DIR, "platform-billing.sqlite");
// The platform access store lives beside the billing ledger (05 §6).
const ACCESS_DB_FILE = path.join(path.dirname(BILLING_DB_FILE), ACCESS_STORE_FILENAME);
const ACCESS_STORE_RETRY_MS = 30_000;
const FLEET_API_MAX_BODY_BYTES = boundedByteLimit(process.env.SERVICE_ENTRY_FLEET_MAX_BODY_BYTES, 1024 * 1024, 64 * 1024, 4 * 1024 * 1024);
const GATEWAY_MAX_BODY_BYTES = boundedByteLimit(process.env.SERVICE_ENTRY_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
const TTS_GATEWAY_MAX_BODY_BYTES = boundedByteLimit(process.env.SERVICE_ENTRY_TTS_MAX_BODY_BYTES, 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024);
const TTS_UI_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
// /gateway/* answers anyone who can reach it, so an offline upstream is named
// generically; which component on which port goes to the access log only.
const UPSTREAM_DOWN_MESSAGE = "上游服务未运行 / Upstream service is not running";
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
// The credential headers a manager reads (gateway-utils extractServiceApiKey).
const ENTRY_KEY_HEADERS = ["authorization", "x-api-key", "api-key", "anthropic-api-key", "anthropic_api_key"];
// Client headers of these families never reach a manager (05 §7.1).
const ENTRY_RESERVED_HEADER_PREFIXES = ["x-service-entry-", "x-ai-internal-", "x-ai-billing-"];
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
    // The id this manager's billing client sends; migrated keys keep billing
    // under it (05 §6.4).
    billingId: process.env.VLLM_MANAGER_ID || "vllm-manager",
    envPort: "VLLM_MANAGER_PORT",
    envHost: "VLLM_MANAGER_HOST",
    // Fallback when platform.json cannot be read: loopback, like the config default (V21).
    defaultHost: process.env.VLLM_MANAGER_HOST || "127.0.0.1",
    mode: "safetensors / FP8 / NVFP4 / 工具调用 / 高吞吐",
    accent: "blue",
  },
  {
    id: "llama",
    name: "llama.cpp Manager",
    root: path.join(AI_ROOT, "llama-manager"),
    port: Number(process.env.LLAMA_MANAGER_PORT || 5178),
    billingId: process.env.LLAMA_MANAGER_ID || "llama-manager",
    envPort: "LLAMA_MANAGER_PORT",
    envHost: "LLAMA_MANAGER_HOST",
    defaultHost: process.env.LLAMA_MANAGER_HOST || "127.0.0.1",
    mode: "GGUF / 异构双卡 / 长上下文实验",
    accent: "teal",
  },
];

const security = createEntrySecurity({
  host: HOST,
  aiRoot: AI_ROOT,
  managers: MANAGERS,
  getLanAddress: core.getLanAddress,
  // Gateway keys live in the platform access store (05 §6, PUB-8).
  keysStore: () => getAccessStore(),
});

// Entry backends are route modules (07 §2.7), mounted once at startup in this
// order; the first module whose handle() returns true answers the request.
// Each package adds one line. Contract (CommonJS):
//   module.exports = { name, feature /* optional; turns on bootstrap features.<feature> */,
//     mount(ctx) { return { handle: async (req, res, url) => false /* true = handled */, close() {} }; } };
// ctx is one shared object (createRouteContext); modules read ctx.relay at call time.
const ROUTE_MODULES = [
  "./lib/events", // ENT-EV1  /api/events, /api/events/recent
  "./lib/mgmt-proxy", // ENT-EV2  /api/m/:managerId/*
  "./lib/manager-event-relay", // ENT-EV3  no routes; starts the relay and sets ctx.relay
  "./lib/telemetry-runtime", // 04 TEL-6  /internal/telemetry/* (ADMIN only; managers' signed ingest)
  "./lib/console-routes", // CON-2  shell, /c/<buildId>/*, /classic, /billing/classic, /api/console/bootstrap
  "./lib/engine-routes", // 01 ENG-19  /api/engines, /api/engines/external/endpoints
  "./lib/hub-routes", // 03 HUB-1  /api/hub/* (reads ctx.hub)
  "./lib/telemetry-routes", // 04 TEL-11/18  /api/telemetry/* (query, export, settings, import)
  "./lib/audit-http", // 04 TEL-16  /api/audit/*
  "./lib/access-routes", // 05 PUB-18  /api/access/*, /api/public/{settings,announcements,models}
  "./lib/access-internal-routes", // 05 PUB-10  /internal/access/* (verify, legacy manager key forwarders)
  "./lib/model-card-routes", // 02 MOD-15  /api/models/{inspect,:id/*}, /api/launch/recommend
  "./lib/knowledge-routes", // 02 MOD-15  /api/knowledge/*
  "./lib/platform-routes", // 06 OPS-13  /api/platform/* (status, components, doctor, config, operations), events bridge
];

let server = null;
let listeners = null;
let routeMounts = null;
// The model hub (03), built once by startServiceEntry() and stopped by
// shutdownSoon(). null in tests and when it could not be built.
let modelHub = null;
let billingStore = null;
let accessStore = null;
let accessStoreFailure = null;
// The status sampler behind the portal JSON documents (05 §12.2); it writes into the access store.
let statusSampler = null;
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

// The platform access store (05 §6). Opening is retried at most every 30 s
// after a failure; the throw means "store unavailable" to every caller, which
// fails closed for auth and never reads as "no keys".
function getAccessStore() {
  if (accessStore) return accessStore;
  if (accessStoreFailure && Date.now() - accessStoreFailure.at < ACCESS_STORE_RETRY_MS) throw accessStoreFailure.error;
  try {
    accessStore = createKeysStore({
      DatabaseSync,
      file: ACCESS_DB_FILE,
      // An admin ban or unban (06 §13.3) reaches the in-memory ban list.
      onChange: (change) => {
        if (change?.type === "ban") gatewayLimiter.bans.refresh();
      },
    });
    accessStoreFailure = null;
    return accessStore;
  } catch (error) {
    accessStoreFailure = { at: Date.now(), error };
    console.error(core.redactSecrets(`service-entry: the access store could not be opened (${error?.code || "access_store_unavailable"}): ${error?.cause?.message || error?.message || error}`));
    throw error;
  }
}

function closeAccessStore() {
  if (statusSampler) {
    statusSampler.stop();
    statusSampler = null;
  }
  if (!accessStore) return;
  try {
    accessStore.close();
  } catch {
    // Shutting down; the OS closes the SQLite handle if this fails.
  }
  accessStore = null;
}

// Imports the managers' legacy keys into the access store (05 §6.7). It runs
// once (access_meta['migration.v1']) unless `force`; the managers' files are
// only read. Tests pass their own store, managers and billing store.
async function migrateLegacyKeys(options = {}) {
  const store = options.store || getAccessStore();
  const managers = (options.managers || MANAGERS).map(({ id, billingId, root }) => ({ id, billingId, root }));
  const billing = options.billingStore || getBillingStore();
  return keyMigration.runKeyMigration({
    store,
    managers,
    listBindings: () => keyMigration.listBillingBindings(billing),
    force: options.force === true,
    actor: "migration",
  });
}

// The dry run of migrateLegacyKeys (05 §13.1 migration/plan): the same inputs,
// nothing written.
async function planLegacyKeys(options = {}) {
  const store = options.store || getAccessStore();
  const managers = (options.managers || MANAGERS).map(({ id, billingId, root }) => ({ id, billingId, root }));
  const billing = options.billingStore || getBillingStore();
  return keyMigration.planLegacyKeyMigration({
    store,
    managers,
    listBindings: () => keyMigration.listBillingBindings(billing),
  });
}

// Entry start: open the access store and migrate before listening. Neither
// failure stops the entry; the store is retried by its next caller and an
// incomplete migration by the next start.
async function prepareAccessStore(options = {}) {
  const log = options.logger || console;
  let store;
  try {
    store = getAccessStore();
  } catch (error) {
    return { ok: false, code: error?.code || "access_store_unavailable" };
  }
  // Persistent bans are loaded before the entry listens (05 §9.3).
  gatewayLimiter.bans.refresh();
  try {
    const outcome = await migrateLegacyKeys({ ...options, store });
    if (outcome.ran) logKeyMigration(outcome, log);
    return { ok: true, migration: outcome };
  } catch (error) {
    log.error(core.redactSecrets(`service-entry: legacy key migration failed; it runs again at the next start: ${error?.message || error}`));
    return { ok: false, code: "key_migration_failed" };
  }
}

// One line, ids and codes only: the report itself is in access_meta.
function logKeyMigration(outcome, log = console) {
  const counts = outcome.report?.counts || {};
  const codes = Array.from(new Set((outcome.report?.warnings || []).map((item) => item.code))).sort();
  const line = `service-entry: legacy key migration imported ${counts.inserted || 0} key(s), skipped ${counts.skipped || 0}`
    + `${codes.length ? `, warnings: ${codes.join(", ")}` : ""}${outcome.complete ? "" : "; incomplete, it runs again at the next start"}`;
  if (codes.length || !outcome.complete) log.warn(line);
  else log.log(line);
}

// The compat key summary of /api/keys and /api/status (05 §13.1): the same
// shape as before, read from the access store the entry opened before
// listening. A read never opens the database itself; while the store is not
// open (it failed at start, or the entry was never started, as in tests)
// the summary comes from what the managers report, as before P5.
function buildKeySummary(managers) {
  if (accessStore) {
    try {
      return keyMigration.summarizeStoreKeys(accessStore, managers);
    } catch (error) {
      console.error(core.redactSecrets(`service-entry: key summary from the access store failed; using the managers' lists: ${error?.message || error}`));
    }
  }
  return summarizeServiceKeys(managers);
}

const handleBillingHttpRequest = createBillingHttpHandler({
  getStore: getBillingStore,
  readRequestBody,
  sendJson,
  getTrustToken: security.getTrustToken,
  isLocalAddress: core.isLocalAddress,
  extractHostname: core.extractHostname,
});

// gatewayTrust.version from a manager's GET /api/manager/health (05 §7.1),
// cached 30 s per port (5 s after a failed probe). 0 means a legacy manager:
// the key is forwarded as before.
const MANAGER_TRUST_TTL_MS = 30 * 1000;
const MANAGER_TRUST_FAILURE_TTL_MS = 5 * 1000;
const managerTrustCache = new Map();

async function managerGatewayTrustVersion(manager) {
  const port = Number(manager?.port || 0);
  if (!port) return 0;
  const now = Date.now();
  const cached = managerTrustCache.get(port);
  if (cached && cached.expiresAt > now) return cached.version;
  if (cached?.promise) return cached.promise;
  const promise = fetchJson(`http://127.0.0.1:${port}/api/manager/health`, 2500)
    .then((health) => {
      const version = health.ok ? Math.max(0, Math.floor(Number(health.data?.gatewayTrust?.version) || 0)) : 0;
      managerTrustCache.set(port, { version, expiresAt: Date.now() + (health.ok ? MANAGER_TRUST_TTL_MS : MANAGER_TRUST_FAILURE_TTL_MS) });
      return version;
    })
    .catch(() => {
      managerTrustCache.set(port, { version: 0, expiresAt: Date.now() + MANAGER_TRUST_FAILURE_TTL_MS });
      return 0;
    });
  managerTrustCache.set(port, { version: cached?.version ?? 0, expiresAt: 0, promise });
  return promise;
}

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

// The entry-wide hooks of one listening server: the TTS reconciliation timer
// and, with a mount table, closing its modules before the server stops.
function decorateEntryServer(httpServer, routes = null) {
  let reconciliationTimer;
  httpServer.once("listening", () => {
    reconciliationTimer = setInterval(() => ttsReconciler.flush().catch((error) => console.warn(`TTS reconciliation: ${error.message}`)), 5000);
    reconciliationTimer.unref();
  });
  httpServer.once("close", () => clearInterval(reconciliationTimer));
  if (routes) {
    // Event streams never end on their own, so close() would wait on them
    // forever: the mounted modules (streams, timers, relay sockets) close first.
    const closeServer = httpServer.close.bind(httpServer);
    httpServer.close = (callback) => {
      routes.close();
      return closeServer(callback);
    };
    httpServer.once("close", () => routes.close());
  }
  return httpServer;
}

// The ADMIN server alone (tests, and the handler startListeners wraps). Its
// requests carry no listener tag, which counts as ADMIN.
function createServiceEntryServer(options = {}) {
  const routes = options.routes || null;
  const httpServer = http.createServer(routes ? (req, res) => handleRequest(req, res, routes) : handleRequest);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  return decorateEntryServer(httpServer, routes);
}

// The PUBLIC handler (05 §3.2): the route table of public-listener.js over
// this file's security and gateway code. `deps.gateway` and `deps.portal`
// replace the defaults (later packages and tests).
function createPublicHandler(deps = {}) {
  const listener = createPublicListener({
    security: deps.security || security,
    gateway: deps.gateway === undefined ? serveGatewayRouteOnPublic : deps.gateway,
    portal: deps.portal || null,
    data: deps.data || null,
    probeRecorder: deps.probeRecorder || null,
    preAuth: deps.preAuth === undefined ? answerPublicPreAuth : deps.preAuth,
    logger: deps.logger || console,
  });
  return listener.handle;
}

// A PUBLIC server whose requests are tagged public (tests; the entry itself
// binds through startListeners). deps as for createPublicHandler.
function createPublicServer(deps = {}) {
  const handle = createPublicHandler(deps);
  const lanBound = deps.lanBound === true;
  const httpServer = http.createServer((req, res) => {
    tagListener(req, "public", lanBound);
    handle(req, res);
  });
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  return httpServer;
}

// 05 §8.2 steps 3 and 4 on PUBLIC: a banned address, then the per-IP bucket
// that runs before any key is looked up (§9.2). True when it answered.
function answerPublicPreAuth(req, res) {
  const identity = security.identifyClient(req);
  const ban = gatewayLimiter.checkBan(identity);
  if (ban) {
    gatewayRecord(req)?.reject({ status: 429, code: "auth_banned" });
    sendPublicError(req, res, "auth_banned", { retryAfterSeconds: ban.retryAfterSeconds });
    return true;
  }
  const pre = gatewayLimiter.preAuth(identity);
  if (!pre.ok) {
    gatewayRecord(req)?.reject({ status: 429, code: "ip_rate_limited" });
    sendPublicError(req, res, "ip_rate_limited", { retryAfterSeconds: pre.retryAfterSeconds });
    return true;
  }
  return false;
}

// Key routes on PUBLIC run on their ADMIN-form path through the shared
// gateway pipeline (05 §8.1, lib/gateway-pipeline.js). The listener tag makes
// authorizeGatewayRequest demand a key, refusals use the 05 §10.2 codes, and
// the gateway CORS headers are empty on PUBLIC.
async function serveGatewayRouteOnPublic(req, res, url, route) {
  const target = new URL(route.gatewayPath + url.search, "http://public.invalid");
  req.url = `${target.pathname}${target.search}`;
  beginGatewayRecord(req, res, target);
  if (answerPublicPreAuth(req, res)) return undefined;
  return publicApi.handle(req, res, target, route);
}

// 05's access layer for one route context: the viewer registry with this
// file's registrations, machine auth over the entry trust token, and the
// admin auth whose guard runs before every route (05 §5.4, §5.7).
function createEntryAccess(options = {}) {
  const logger = options.logger || console;
  const viewerRegistry = createViewerRegistry({ logger });
  registerEntryRoutes(viewerRegistry);
  let bus = null;
  const machineAuth = createMachineAuth({
    getToken: () => security.getTrustToken(),
    viewerRegistry,
    logger,
    onFailure: (details) => {
      try {
        bus?.publish?.("security", { kind: "internal_auth_failed", ...details });
      } catch {
        // The bus never throws into a request; this is belt and braces.
      }
    },
  });
  // Sessions live in the access store; while it cannot be opened nobody is
  // the owner (fail closed) and signed machine principals still work.
  const adminAuth = createAdminAuth({
    store: () => getAccessStore(),
    config: () => security.accessConfig(),
    machineAuth,
    viewerRegistry,
    aiRoot: AI_ROOT,
    getLanAddress: core.getLanAddress,
    sendJson,
    readJsonObjectBody,
    logger,
  });
  return {
    viewerRegistry,
    machineAuth,
    adminAuth,
    attachBus(value) {
      bus = value || null;
    },
  };
}

// The access layer of each context made by createRouteContext(), kept out of
// ctx so modules keep asking ctx.auth (07 §2.9).
const entryAccessByContext = new WeakMap();
let fallbackEntryAccess = null;

function entryAccessFor(routes) {
  const access = routes?.ctx ? entryAccessByContext.get(routes.ctx) : null;
  if (access) return access;
  // A server without a mount table (tests, createServiceEntryServer()) still
  // runs the guard over this file's registrations.
  if (!fallbackEntryAccess) fallbackEntryAccess = createEntryAccess();
  return fallbackEntryAccess;
}

// The one ctx object every route module receives (07 §2.7). auth and bus are
// created here unless a caller (a test) supplies its own; a supplied auth is
// not what 05's guard consults, which keeps this context's own registry.
function createRouteContext(overrides = {}) {
  const access = createEntryAccess({ logger: overrides.logger || console });
  const auth = overrides.auth || createRequestAuth({ security, adminAuth: access.adminAuth, viewerRegistry: access.viewerRegistry });
  const bus = overrides.bus || createEventBus({ auth, logger: console });
  access.attachBus(bus);
  security.setEventSink((data) => bus.publish("security", data));
  // The exposure scan and the security views (05 §13.2, §13.3). Nothing runs
  // until the owner asks (or the checklist reads the cached report), and the
  // checklist of /api/security reads the last scan without starting one.
  const securityOverview = overrides.securityOverview || createSecurityOverview({
    getStore: () => getAccessStore(),
    getBus: () => bus,
    getConfig: () => security.accessConfig(),
  });
  const exposure = overrides.exposure || createExposureScanner({
    aiRoot: AI_ROOT,
    getConfig: () => security.accessConfig(),
    getSignals: () => securityOverview.signals(),
    logger: overrides.logger || console,
  });
  security.setExposureReport(() => exposure.cached());
  const ctx = {
    rootDir: ROOT,
    dataDir: DATA_DIR,
    aiRoot: AI_ROOT,
    managers: MANAGERS.map(({ id, port, billingId }) => ({ id, port, billingId })),
    security,
    getAccessStore,
    readRequestBody,
    relay: null,
    features: {},
    sendJson,
    readJsonObjectBody,
    // The host GPUs, for the model-card routes (02 MOD-15: compatibility, recommend, fit-grid).
    getGpus: getEntryGpus,
    // The billing store, for the request-detail join of telemetry-routes (04 §11.6).
    getBillingStore,
    // The access store (05 §6) and the legacy key migration, for access-routes.
    getAccessStore,
    accessMigration: {
      plan: () => planLegacyKeys(),
      apply: () => migrateLegacyKeys({ force: true }),
    },
    // For platform-routes (06 OPS-13): the gateway streams in flight (the idle
    // gate) and this file's own manager start, the fallback without a supervisor.
    gatewayInFlight: () => entryGatewayInFlight(),
    startManager: async (managerId) => {
      const manager = findManager(managerId);
      return manager ? startDetachedManager(manager) : null;
    },
    logger: console,
    now: Date.now,
    ...overrides,
    auth,
    bus,
    exposure,
    securityOverview,
  };
  entryAccessByContext.set(ctx, access);
  return ctx;
}

// Mounts each module in order. A module that cannot be loaded or whose
// mount() throws is skipped with one log line, and its feature stays off;
// the entry keeps serving everything else.
async function mountRouteModules(options = {}) {
  const ctx = options.ctx || createRouteContext();
  const specs = Array.isArray(options.modules) ? options.modules : ROUTE_MODULES;
  const load = typeof options.load === "function" ? options.load : (spec) => require(spec);
  const warn = typeof ctx.logger?.warn === "function" ? (line) => ctx.logger.warn(line) : (line) => console.warn(line);
  if (!ctx.features || typeof ctx.features !== "object") ctx.features = {};
  const modules = [];
  const failed = [];
  for (const spec of specs) {
    let definition = null;
    const label = typeof spec === "string" ? spec : String(spec?.name || "(unnamed)");
    try {
      definition = typeof spec === "string" ? load(spec) : spec;
      if (!definition || typeof definition.mount !== "function") throw new Error("it exports no mount(ctx)");
      const mounted = await definition.mount(ctx);
      if (!mounted || typeof mounted.handle !== "function") throw new Error("mount(ctx) returned no handle()");
      const name = String(definition.name || label);
      const feature = definition.feature ? String(definition.feature) : "";
      modules.push({ name, feature, api: mounted });
      if (feature) ctx.features[feature] = true;
    } catch (error) {
      const name = String(definition?.name || label);
      failed.push({ name, error: String(error?.message || error) });
      if (definition?.feature && ctx.features[definition.feature] !== true) ctx.features[String(definition.feature)] = false;
      warn(core.redactSecrets(`service-entry: route module ${name} was not mounted and is skipped: ${error?.message || error}`));
    }
  }
  let closed = false;
  return {
    ctx,
    modules,
    failed,
    close() {
      if (closed) return;
      closed = true;
      for (const mounted of [...modules].reverse()) {
        try {
          mounted.api.close?.();
        } catch (error) {
          warn(core.redactSecrets(`service-entry: route module ${mounted.name} failed to close: ${error?.message || error}`));
        }
      }
      try {
        ctx.bus?.close?.();
      } catch (error) {
        warn(core.redactSecrets(`service-entry: event bus failed to close: ${error?.message || error}`));
      }
    },
  };
}

// Runs after the host/origin, proxied-request and billing checks and before
// the inline routes. /gateway/* never reaches a module.
async function dispatchRouteModules(routes, req, res, url) {
  if (!routes?.modules?.length || url.pathname.startsWith("/gateway/")) return false;
  for (const mounted of routes.modules) {
    let handled = false;
    try {
      handled = await mounted.api.handle(req, res, url);
    } catch (error) {
      console.error(core.redactSecrets(`service-entry: route module ${mounted.name} failed: ${error?.stack || error?.message || error}`));
      if (!res.headersSent) {
        sendJson(res, { ok: false, error: { code: "internal_error", message: "Service entry error." } }, 500);
      } else {
        res.destroy();
      }
      return true;
    }
    if (handled === true || res.headersSent) return true;
  }
  return false;
}

// The admin_via_proxy security event goes to the bus of the route context the
// request is served from (a test's own server has its own).
let adminViaProxyBus = null;
function noteAdminViaProxy(routes, req, info) {
  const bus = routes?.ctx?.bus;
  if (bus && bus !== adminViaProxyBus) {
    adminViaProxyBus = bus;
    security.setEventSink((data) => bus.publish("security", data));
  }
  security.noteAdminViaProxy(req, info);
}

async function handleRequest(req, res, routes = null) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    // Every gateway request is recorded from here on, refusals included, and
    // answers with the x-request-id the record minted (04 §6.5).
    const gatewayRec = url.pathname.startsWith("/gateway/") ? beginGatewayRecord(req, res, url) : null;
    // Every gateway answer carries an x-request-id (05 §8.2), also while
    // telemetry is off and no record minted one.
    if (url.pathname.startsWith("/gateway/") && !gatewayRec) ensureGatewayRequestId(req, res);
    // Host whitelist + Origin check for mutating requests. Without this any page
    // the user has open can drive the entry over loopback.
    const hostCheck = security.checkRequest(req, url);
    if (!hostCheck.ok) {
      gatewayRec?.reject({ status: hostCheck.status, code: hostCheck.code });
      return sendJson(res, { error: hostCheck.message, code: hostCheck.code }, hostCheck.status);
    }
    // 反向代理（deploy/public 的 Caddy）转发进来的请求只允许走 /gateway/*：
    // 控制台页面、管理 API、计费和文档都不该出现在公网上。
    if (security.isProxiedRequest(req)) {
      // A forwarded header on ADMIN means a tunnel or proxy is pointed at the
      // wrong port (05 §3.3). Either way the event names it for the console.
      if (!url.pathname.startsWith("/gateway/")) {
        noteAdminViaProxy(routes, req, { pathClass: "admin", outcome: "public_proxy_gateway_only" });
        return sendJson(res, { error: "Only /gateway/* endpoints are served through the public proxy.", code: "public_proxy_gateway_only" }, 404);
      }
      // admin.legacyProxyGateway: "serve" keeps old tunnels working (the
      // client is the socket address and a key is required, see security.js);
      // "reject" tells them to use the PUBLIC listener.
      if (security.accessConfig().admin.legacyProxyGateway === "reject") {
        noteAdminViaProxy(routes, req, { pathClass: "gateway", outcome: "use_public_listener" });
        gatewayRec?.reject({ status: 421, code: "use_public_listener" });
        return sendJson(res, { error: "This address is for the console. Use the public listener for API traffic.", code: "use_public_listener" }, 421);
      }
      noteAdminViaProxy(routes, req, { pathClass: "gateway", outcome: "served_legacy" });
    }
    // 05's pre-dispatch guard: a signed machine request is verified and held
    // to its scope, and a viewer reaches only registered routes, with the
    // entry's redaction set on req.viewer for sendJson.
    const { adminAuth } = entryAccessFor(routes);
    // The gateway pipeline asks this route context who owns a console
    // session (05 §5.8).
    req.serviceEntryAdminAuth = adminAuth;
    if (await adminAuth.guard(req, res, url)) return;
    // The session API (05 §5.6) comes before every other route.
    if (await adminAuth.handle(req, res, url)) return;
    if (await handleBillingHttpRequest(req, res, url)) return;
    if (await dispatchRouteModules(routes, req, res, url)) return;
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
      // The key's own view (05 §8.5); the same handler serves PUBLIC /v1/me.
      if (url.pathname === "/gateway/me" || url.pathname.startsWith("/gateway/me/")) {
        return meRoutes.handle(req, res, url);
      }
      return proxyGatewayRequest(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/api/keys") {
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const managers = await Promise.all(MANAGERS.map((manager) => buildManagerStatus(manager, { force: url.searchParams.get("fresh") === "1" })));
      return sendJson(res, { ok: true, keys: buildKeySummary(managers) });
    }
    // Viewer copies of /api/security, /api/status, /api/fleet, the route
    // preview and /api/gateway-access come from their registered redaction,
    // which sendJson applies (registerEntryRoutes).
    if (req.method === "GET" && url.pathname === "/api/security") {
      return sendJson(res, { ok: true, security: await security.describe() });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
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
          gatewayAccess: await collectEntryGatewayAccessStats({ limit: 20 }),
          exitLog: PROCESS_EXIT_LOG,
        },
        managers,
        mcp,
        tts,
        search,
        keys: buildKeySummary(managers),
        components: summarizeComponents(managers, mcp, tts, search),
        // The last supervisor answer (06 §10.3); never waits for it.
        platform: routes?.ctx?.platform?.summary?.() ?? null,
      };
      return sendJson(res, payload);
    }
    if (req.method === "GET" && url.pathname === "/api/mcp/status") {
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      return sendJson(res, await buildPlatformMcpStatus());
    }
    if (req.method === "GET" && url.pathname === "/api/fleet") {
      return sendJson(res, await buildServiceEntryFleetSnapshot());
    }
    if (req.method === "POST" && url.pathname === "/api/fleet/settings") {
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      let body;
      try {
        body = await readJsonObjectBody(req, FLEET_API_MAX_BODY_BYTES);
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message, code: "invalid_request" }, error.status || 400);
      }
      const currentSettings = await getFleetSettings();
      const settings = await saveFleetSettings({ ...currentSettings, ...(body.settings || body) });
      telemetry?.recordConfigChange("fleet", { before: currentSettings, after: settings });
      const fleet = await buildServiceEntryFleetSnapshot(settings);
      return sendJson(res, { ok: true, settings, fleet });
    }
    if (req.method === "POST" && url.pathname === "/api/fleet/route-preview") {
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
        window: url.searchParams.get("window"),
      });
      return sendJson(res, access);
    }
    const managerStartMatch = url.pathname.match(/^\/api\/managers\/([^/]+)\/start$/);
    if (req.method === "POST" && managerStartMatch) {
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const manager = findManager(managerStartMatch[1]);
      if (!manager) return sendJson(res, { ok: false, error: "Unknown manager." }, 404);
      // The supervisor owns the manager when it is up (06 §10.3).
      const delegated = await routes?.ctx?.platform?.delegateManager?.(manager.id, "start");
      if (delegated?.delegated) {
        const status = await buildManagerStatus(manager, { force: true });
        return sendJson(res, { ok: delegated.ok, delegated: "supervisor", ready: Boolean(status?.ok), opId: delegated.opId, ...(delegated.error ? { error: delegated.error } : {}), status }, delegated.ok ? 200 : 502);
      }
      return sendJson(res, await startDetachedManager(manager));
    }
    const managerStopMatch = url.pathname.match(/^\/api\/managers\/([^/]+)\/stop$/);
    if (req.method === "POST" && managerStopMatch) {
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      const manager = findManager(managerStopMatch[1]);
      if (!manager) return sendJson(res, { ok: false, error: "Unknown manager." }, 404);
      const delegated = await routes?.ctx?.platform?.delegateManager?.(manager.id, "stop");
      if (delegated?.delegated) {
        const status = await buildManagerStatus(manager, { force: true });
        return sendJson(res, { ok: delegated.ok, delegated: "supervisor", stopped: { ok: delegated.ok, via: "supervisor" }, opId: delegated.opId, ...(delegated.error ? { error: delegated.error } : {}), status }, delegated.ok ? 200 : 502);
      }
      return sendJson(res, await stopManager(manager));
    }
    if (req.method === "POST" && url.pathname === "/api/stop-all") {
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
      if (!allowed.ok) return sendJson(res, { ok: false, error: allowed.message, code: allowed.code }, allowed.status);
      // With the supervisor up, one stop of the core profile stops the entry and
      // both managers, and the supervisor stops restarting them (06 §10.3).
      const delegated = await routes?.ctx?.platform?.delegateStopAll?.();
      if (delegated?.delegated && delegated.ok) {
        return sendJson(res, { ok: true, delegated: "supervisor", opId: delegated.opId, stopped: MANAGERS.map((manager) => ({ id: manager.id, via: "supervisor", ok: true })) });
      }
      const stopped = await Promise.all(MANAGERS.map((manager) => postJson(`http://127.0.0.1:${manager.port}/api/manager/shutdown`)));
      sendJson(res, { ok: true, stopped });
      return shutdownSoon();
    }
    if (req.method === "POST" && (url.pathname === "/api/shutdown" || url.pathname === "/api/manager/shutdown")) {
      // Same gate as the other lifecycle endpoints; this one used to be open,
      // so any LAN device could stop the whole gateway.
      const allowed = adminAuth.checkManagementAccess(req, { write: req.method !== "GET" });
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
    platform: platformRoutes.redactPlatformSummaryForViewer(payload.platform),
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

function redactSecurityForViewer(body) {
  return { ...body, security: security.describePublic(body?.security) };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pickFields(source, names) {
  const input = plainObject(source);
  const out = {};
  for (const name of names) {
    if (input[name] !== undefined) out[name] = input[name];
  }
  return out;
}

const VIEWER_INSTANCE_FIELDS = ["id", "fleetId", "instanceId", "instanceMode", "primary", "managerId", "managerName", "engine", "manager_engine", "running", "status", "lifecycleState", "gpuIds", "priority"];
const VIEWER_MODEL_FIELDS = ["id", "manager_engine", "instance_id", "capabilities", "maxModelLen", "max_model_len", "lastKnown"];

function redactFleetModelForViewer(model) {
  return typeof model === "string" ? { id: model } : pickFields(model, VIEWER_MODEL_FIELDS);
}

// The viewer copy of GET /api/fleet and of POST /api/fleet/route-preview
// (05 §5.4). Model ids, states, capabilities, GPU numbers and the routing
// settings stay; paths, ports, container names, images, URLs, env, argv and
// pids go. Fields are picked rather than deleted, so a field a manager adds
// later stays hidden, and the generic viewer scrub runs last.
function redactFleetForViewer(body) {
  const input = plainObject(body);
  let out;
  if (input.request !== undefined || input.manager !== undefined || input.instance !== undefined) {
    const manager = plainObject(input.manager);
    const instance = plainObject(input.instance);
    out = {
      ...pickFields(input, ["ok", "status", "error", "message", "capability", "reason", "policy"]),
      request: pickFields(input.request, ["engine", "protocol", "requestedModel"]),
      manager: input.manager ? pickFields(manager, ["id", "name"]) : null,
      instance: input.instance ? pickFields(instance, ["id", "instanceId", "primary", "status"]) : null,
      model: input.model ? pickFields(input.model, ["id", "capabilities"]) : null,
    };
  } else {
    out = {
      ...pickFields(input, ["ok", "updatedAt", "error"]),
      settings: pickFields(input.settings, ["mode", "reserveMb", "maxUtilizationPct", "preferEngine"]),
      gpuMemory: input.gpuMemory ? {
        ...pickFields(input.gpuMemory, ["totalMb", "usedMb", "freeMb", "reserveMb", "allocatableMb", "availableMb", "warningThresholdPct"]),
        gpus: (Array.isArray(input.gpuMemory.gpus) ? input.gpuMemory.gpus : []).map((gpu) => pickFields(gpu, ["id", "index", "name", "totalMb", "usedMb", "freeMb", "allocatableMb", "availableMb"])),
      } : null,
      instances: (Array.isArray(input.instances) ? input.instances : []).map((instance) => ({
        ...pickFields(instance, VIEWER_INSTANCE_FIELDS),
        models: (Array.isArray(instance?.models) ? instance.models : []).map(redactFleetModelForViewer),
      })),
      slots: (Array.isArray(input.slots) ? input.slots : []).map((slot) => pickFields(slot, ["id", "label", "role", "capability", "state", "status", "managerId"])),
      routing: pickFields(input.routing, ["mode", "genericModelIds", "capabilityCounts"]),
    };
  }
  return redactManagerReadForViewer(out);
}

// Documents GET /docs/<name> serves; each is also a viewer route.
const SERVED_DOCS = Object.freeze([
  "client-setup-guide.md",
  "billing-guide.md",
  "mcp-platform-guide.md",
  "model-service-platform-workplan.md",
  "service-runbook.md",
]);

// 05 §5.4 baseline registrations (PUB-25) and the inline routes of this file.
// Every GET the entry answers is declared here or by its route module; what
// a viewer may not read is admin-only, which deny-by-default enforces anyway.
function registerEntryRoutes(registry) {
  const owner = "05";
  for (const path of ["/", "/index.html", "/favicon.ico", "/shared-js/*", ...SERVED_DOCS.map((name) => `/docs/${name}`)]) {
    registry.registerRoute({ owner, path });
  }
  // GET /api/session answers the caller's own role; the rest of the
  // session API is owner-only (PUB-5).
  registerSessionRoutes(registry);
  registry.registerRoute({ owner, path: "/api/status", redact: redactStatusForRemote });
  registry.registerRoute({ owner, path: "/api/security", redact: redactSecurityForViewer });
  registry.registerRoute({ owner, path: "/api/fleet", redact: redactFleetForViewer });
  registry.registerReadOnlyPost({ owner, path: "/api/fleet/route-preview", redact: redactFleetForViewer });
  registry.registerEventType({ owner, type: "status", redact: redactStatusEventForViewer });
  registry.registerEventType({ owner, type: "instances", redact: redactInstancesEventForViewer });
  // 04 §11.8 owns this one (TEL-12 facade) and keeps today's remote redaction.
  registry.registerRoute({ owner: "04", path: "/api/gateway-access", redact: redactAccessForRemote });

  const adminReads = [
    "/api/keys", "/api/access/*", "/api/public/*", "/api/security/*",
    "/api/mcp/status", "/billing", "/billing/", "/api/billing/*",
  ];
  for (const path of adminReads) registry.registerAdminOnly({ owner, method: "GET", path });
  const adminWrites = [
    ["POST", "/api/fleet/settings"],
    ["POST", "/api/managers/:managerId/start"],
    ["POST", "/api/managers/:managerId/stop"],
    ["POST", "/api/stop-all"],
    ["POST", "/api/shutdown"],
    ["POST", "/api/manager/shutdown"],
    ["POST", "/api/billing/*"],
    ["PATCH", "/api/billing/*"],
  ];
  for (const [method, path] of adminWrites) registry.registerAdminOnly({ owner, method, path });
}

async function startServiceEntry() {
  if (server) return server;
  // Open and migrate the billing database before publishing trust or accepting
  // traffic. A broken ledger must fail startup instead of silently bypassing
  // quota enforcement after managers begin forwarding requests.
  getBillingStore();
  // The access store opens and the managers' legacy keys migrate before the
  // entry listens (05 §6, §6.7); a failure of either leaves the entry up.
  await prepareAccessStore();
  // Publish the trust token before accepting traffic so managers started
  // independently can verify proxied requests from the first one.
  await security.issueTrustToken().catch((error) => {
    console.warn(`Unable to publish gateway trust token: ${error.message}`);
  });
  // The request-auth seam and the event bus come first, then every route
  // module; a module that fails to mount never stops the entry. The model
  // hub is built before the mount (its routes read ctx.hub) and started after
  // listen, so loading its files never delays the port.
  const ctx = createRouteContext();
  modelHub = createEntryHub({ events: ctx.bus });
  ctx.hub = modelHub;
  routeMounts = await mountRouteModules({ ctx });
  // Every module has registered its viewer routes; a later one would be a bug.
  routeMounts.ctx.auth.viewerRegistry.freeze();
  // The gateway recorder, the store and the collectors (04). A store that
  // cannot open leaves telemetry degraded; it never stops the entry.
  await startTelemetry({
    managers: MANAGERS,
    managerClient: routeMounts.ctx.managerClient,
    getFleetCatalogs: () => getFleetCatalogs(),
    events: routeMounts.ctx.bus,
    // The alert engine reads the audit schedule from ctx.audit once audit-http has built it.
    getAudit: () => routeMounts?.ctx?.audit || null,
    processExitLog: PROCESS_EXIT_LOG,
  }).then((runtime) => {
    // The telemetry routes (TEL-18) read the store through ctx at request time.
    routeMounts.ctx.telemetry = runtime;
  }).catch((error) => {
    console.warn(core.redactSecrets(`service-entry: telemetry did not start: ${error?.message || error}`));
  });
  // Two listeners in one process (05 §3.1): ADMIN keeps today's handler and
  // PUBLIC answers only its own route table. ADMIN failing to bind is fatal;
  // PUBLIC failing leaves ADMIN up and the console shows it red.
  const config = security.accessConfig();
  const publicHandler = createPublicHandler({
    portal: createPortalRoutes({ aiRoot: AI_ROOT, logger: console }),
    data: createPublicPortalData(),
    probeRecorder: routeMounts.ctx.exposure?.recorder || null,
  });
  try {
    listeners = await startListeners({
      config,
      adminHandler: (req, res) => handleRequest(req, res, routeMounts),
      publicHandler,
      decorate: (kind, httpServer) => {
        if (kind === "admin") decorateEntryServer(httpServer, routeMounts);
      },
      onPublicUnavailable: (error) => {
        try {
          routeMounts.ctx.bus.publish("platform", { kind: "public_listener_unavailable", code: error.code });
        } catch {
          // The bus never stops the entry.
        }
      },
    });
  } catch (error) {
    const detail = error?.code === "EADDRINUSE"
      ? `端口 ${config.listeners.admin.port} 已被占用，无法启动统一入口。`
      : (error?.message || String(error));
    console.error(`Service entry listen failed: ${detail}`);
    process.exit(1);
  }
  server = listeners.admin;
  server.on("error", (error) => {
    console.error(`Service entry server error: ${error?.message || error}`);
  });
  logStartupSummary(security.policy(), { host: listeners.binds.admin.host, port: listeners.binds.admin.port });
  if (listeners.public) {
    console.log(`Public listener on http://${listeners.binds.public.host}:${listeners.binds.public.port}`);
  }
  modelHub?.start().catch((error) => {
    console.warn(core.redactSecrets(`Model hub failed to start; its routes answer hub_unavailable: ${error?.message || error}`));
  });
  return server;
}

// The portal's JSON documents (05 §12.2): the status sampler over the fleet
// catalogs and the access store, and the four documents built from it. An
// access store that cannot open leaves the documents out (the portal pages then
// show their error state); it never stops the entry. Telemetry numbers appear
// once the telemetry runtime offers statusStats().
function createPublicPortalData() {
  try {
    const store = getAccessStore();
    const config = () => security.accessConfig();
    const telemetry = { statusStats: async (options) => routeMounts?.ctx?.telemetry?.statusStats?.(options) ?? null };
    statusSampler = startStatusSampler({ getCatalogs: () => getFleetCatalogs(), telemetry, store, config, logger: console });
    return createPublicData({
      sampler: statusSampler,
      getCatalogs: () => getFleetCatalogs(),
      store,
      config,
      getBuildId: () => core.platform.getBuildId({ aiRoot: AI_ROOT }),
    });
  } catch (error) {
    console.warn(core.redactSecrets(`The portal data could not start; its JSON routes answer 404: ${error?.message || error}`));
    return null;
  }
}

// Gateway requests holding or waiting for a concurrency slot right now.
function entryGatewayInFlight(buckets = entryConcurrencyBuckets, queues = entryConcurrencyQueues) {
  let count = 0;
  for (const value of buckets.values()) count += Math.max(0, Number(value) || 0);
  for (const queue of queues.values()) count += Array.isArray(queue) ? queue.filter((waiter) => waiter && !waiter.cancelled).length : 0;
  return count;
}

/**
 * The runtime load the hub's idle-only queue reads (03 §8):
 * { busy, known, detail[] }. Busy while any fleet model has running or
 * waiting requests, any instance is loading (weights compete with the
 * download for the disk) or the gateway has requests in flight. A manager
 * that is unreachable counts as not busy and makes the result known: false.
 */
function summarizeRuntimeLoad(catalogs = [], { gatewayInFlight = 0 } = {}) {
  let busy = false;
  let known = true;
  const detail = [];
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    const managerId = String(catalog?.manager?.id || "");
    if (!catalog || catalog.listening === false || catalog.error) {
      known = false;
      detail.push({ managerId, known: false });
      continue;
    }
    let requests = 0;
    for (const model of Array.isArray(catalog.models) ? catalog.models : []) {
      const running = Number(model?.runningRequests);
      const waiting = Number(model?.waitingRequests);
      requests += (Number.isFinite(running) ? running : 0) + (Number.isFinite(waiting) ? waiting : 0);
    }
    const loading = (Array.isArray(catalog.instances) ? catalog.instances : [])
      .filter((instance) => String(instance?.lifecycleState || instance?.lifecycle?.state || "").toLowerCase() === "loading").length;
    if (requests > 0 || loading > 0) busy = true;
    detail.push({ managerId, known: true, requests, loading });
  }
  const inFlight = Math.max(0, Number(gatewayInFlight) || 0);
  if (inFlight > 0) busy = true;
  detail.push({ source: "gateway", inFlight });
  return { busy, known, detail };
}

async function getEntryRuntimeLoad() {
  const catalogs = await getFleetCatalogs().catch(() => []);
  return summarizeRuntimeLoad(catalogs, { gatewayInFlight: entryGatewayInFlight() });
}

let entryGpuRuntime = null;

// [{ id, name, totalMb, freeMb, computeCap }] from nvidia-smi (03 §3.1);
// an empty list when there is no NVIDIA GPU or the query fails.
async function getEntryGpus() {
  if (!entryGpuRuntime) entryGpuRuntime = core.createGpuRuntime({ execFileAsync: promisify(execFile) });
  const status = await entryGpuRuntime.getGpuStatus().catch(() => ({ gpus: [] }));
  return (Array.isArray(status?.gpus) ? status.gpus : []).map((gpu) => ({
    id: String(gpu.id ?? gpu.index ?? ""),
    name: String(gpu.name || ""),
    totalMb: Number.isFinite(gpu.totalMb) ? gpu.totalMb : null,
    freeMb: Number.isFinite(gpu.totalMb) && Number.isFinite(gpu.usedMb) ? Math.max(0, gpu.totalMb - gpu.usedMb) : null,
    computeCap: gpu.computeCap || null,
  }));
}

// The compatibility rows of 02 (03 §10) are evaluated against this host's GPUs;
// runtimes, facts and knowledge come from 02's own defaults.
async function getEntryCompatibilityContext() {
  return { host: { gpus: await getEntryGpus() } };
}

// The entry's one model hub (03 §3): data under service-entry/data/hub, the
// download CLIs in the managers' discovery order. Building it touches no
// file; a hub that cannot be built leaves its routes answering 503.
function createEntryHub({ events = null } = {}) {
  try {
    const { hfCli, modelScopeCli } = discoverHubClis({ aiRoot: AI_ROOT, env: process.env });
    const hfHome = process.env.HF_HOME || path.join(AI_ROOT, "cache", "huggingface");
    // The same storage registry the managers use (03 §3): roots and aliases
    // live in the shared model-storage.json; the hub reads them for the
    // library (03 §9) and never writes it.
    const modelsRoot = process.env.VLLM_MODELS_ROOT || path.join(AI_ROOT, "models");
    const modelStorage = core.createModelStorage({
      modelsRoot,
      file: process.env.MODEL_STORAGE_FILE || path.join(DATA_DIR, "model-storage.json"),
    });
    const fsStore = core.createModelFilesystemStore({ storage: modelStorage, modelsRoot, hfCache: hfHome, listRoots: () => modelStorage.roots() });
    return createModelHub({
      aiRoot: AI_ROOT,
      dataDir: path.join(DATA_DIR, "hub"),
      hfHome,
      modelStorage,
      fsStore,
      hfCli,
      modelScopeCli,
      events,
      managers: MANAGERS.map(({ id, port }) => ({ id, port })),
      // The idle-only queue (03 §8) and the fit (03 §10) read the platform
      // through these two providers.
      getRuntimeLoad: getEntryRuntimeLoad,
      getGpus: getEntryGpus,
      // 02's model inspector (core.models): the fit, the remote cards and the
      // compatibility rows of search, repository detail and the plan (03 §10).
      models: core.models,
      getCompatibilityContext: getEntryCompatibilityContext,
      // Cancel-and-delete refuses a folder a running container mounts (03 §8).
      getBusyPaths: core.createStorageBusyPathProbe({ aiRoot: AI_ROOT }),
      logger: console,
    });
  } catch (error) {
    console.warn(core.redactSecrets(`Model hub could not be created; its routes answer hub_unavailable: ${error?.message || error}`));
    return null;
  }
}

// Stops the hub (flushing its files) within `timeoutMs`; never throws.
async function stopModelHub(hub, { reason = "shutdown", timeoutMs = 5000 } = {}) {
  if (!hub || typeof hub.stop !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => hub.stop({ reason })),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    console.warn(core.redactSecrets(`Model hub did not stop cleanly: ${error?.message || error}`));
  } finally {
    clearTimeout(timer);
  }
}

// Only the real warning goes to stderr. The hint is advice for a default
// loopback install, and log tooling classifies every stderr line as an error.
function logStartupSummary(state, { host = HOST, port = PORT, log = console.log, warn = console.warn } = {}) {
  log(`Service entry listening on http://${host}:${port}`);
  log(`  gateway auth: ${state.requireApiKey ? "required" : "disabled"} (SERVICE_ENTRY_REQUIRE_API_KEY=${state.requireApiKeyMode})`);
  log(`  lan admin:    ${state.allowLanAdmin ? "allowed" : "local only"} (SERVICE_ENTRY_ALLOW_LAN_ADMIN)`);
  log(`  cors:         ${state.corsMode}${state.allowedOrigins.length ? ` (${state.allowedOrigins.join(", ")})` : ""}`);
  if (state.lanMode && !state.requireApiKey) {
    warn("  WARNING: listening off-loopback with API key enforcement disabled.");
  }
  if (!state.requireApiKey) {
    log("  HINT: 不受信环境请设置 SERVICE_ENTRY_REQUIRE_API_KEY=1，避免网页跨站盲打本地推理。");
  }
}

if (require.main === module) {
  core.installProcessExitLogging({
    label: "service-entry",
    file: PROCESS_EXIT_LOG,
    onSignal: async () => {
      await stopModelHub(modelHub);
      await security.revokeTrustToken().catch(() => {});
      const closing = listeners ? listeners.close() : server ? new Promise((resolve) => server.close(resolve)) : null;
      // In-flight records are finalised and flushed (2 s cap) even when open
      // streams keep the server from closing.
      await stopTelemetry();
      if (closing) await closing;
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
  if (!SERVED_DOCS.includes(name)) return sendJson(res, { error: "Document not found" }, 404);
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

// `platform start <registry id>` (06 §10.3); the entry's short ids (vllm, tts,
// mcp, search) map to the registry ids through the legacy table.
function platformStartCommand(id) {
  const legacy = core.platform.LEGACY_IDS || {};
  return `platform start ${Object.hasOwn(legacy, id) ? legacy[id] : id}`;
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
      startCommand: platformStartCommand(manager.id),
      error: manager.error || "",
    });
  }
  if (tts) items.push({ id: "tts", name: "TTS 语音平台", kind: "tts", online: Boolean(tts.listening), healthy: Boolean(tts.healthy), startable: false, startCommand: platformStartCommand("tts"), error: tts.error || "" });
  if (mcp) items.push({ id: "mcp", name: "MCP 工具服务", kind: "mcp", online: Boolean(mcp.listening), healthy: Boolean(mcp.healthy), startable: false, startCommand: platformStartCommand("mcp"), error: mcp.error || "" });
  if (search) items.push({ id: "search", name: "搜索网关", kind: "search", online: Boolean(search.listening), healthy: Boolean(search.healthy), startable: false, startCommand: platformStartCommand("search"), error: search.error || "" });
  const offline = items.filter((item) => !item.online);
  const unhealthy = items.filter((item) => item.online && !item.healthy);
  return {
    total: items.length,
    online: items.length - offline.length,
    offline: offline.map((item) => item.id),
    unhealthy: unhealthy.map((item) => item.id),
    items,
    allCommand: "platform start full",
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

// The managers a gateway caller may reach (a key: its fleetAllow; a legacy
// result: its matchedManager). Kept for callers and tests of the old name.
function selectGatewayManagersForAuth(engine = "auto", auth = null, managers = MANAGERS) {
  return gatewayPipeline.managersFor(auth, engine, managers);
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

// The TTS proxy logs only requests worth keeping: anything that is not a
// read, every error, and billable synthesis under /gateway/tts/openai/v1/*.
// Successful job polls and static GETs from the TTS UI were 99.8 % of the
// entry access log and buried everything else.
function shouldLogTtsAccess(req, res) {
  const method = String(req?.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  if (Number(res?.statusCode || 0) >= 400) return true;
  const pathname = String(req?.url || "").split("?")[0];
  return /^\/gateway\/tts\/openai\/v1(?:\/|$)/i.test(pathname);
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
    // The key's TTS owner (05 §6.4); "" is owner-wide (keyless loopback and
    // the console session, §5.8).
    owner: typeof auth?.ttsOwner === "string" ? auth.ttsOwner : auth?.client?.id ? `${auth.matchedManager}:${auth.client.id}` : "",
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
    if (!slot.aborted && !res.writableEnded) sendTtsRefusal(req, res, slot.statusCode || 429, slot.message, slot.code, gatewayCorsHeaders(req));
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

// A TTS refusal: the TTS gateway's {detail, code} body on ADMIN, the 05 §10.2
// taxonomy on PUBLIC (the OpenAI shape with a stable message, §10.1).
const TTS_PUBLIC_CODES = Object.freeze({
  request_body_too_large: "request_too_large",
  tts_gateway_offline: "service_unavailable",
  tts_gateway_proxy_error: "upstream_error",
  invalid_gateway_path: "invalid_request",
  concurrency_queue_full: "concurrency_limit_exceeded",
  concurrency_queue_timeout: "concurrency_limit_exceeded",
});

function sendTtsRefusal(req, res, status, detail, code, headers = {}) {
  if (security.listenerKind(req) !== "public") return sendJson(res, { detail, code }, status, headers);
  const text = String(code || "");
  const publicCode = TTS_PUBLIC_CODES[text]
    || (/^billing_/.test(text) && [402, 429].includes(status) ? "insufficient_quota" : text);
  const known = lookupPublicError(publicCode);
  return gatewayPipeline.sendRefusal(req, res, {
    status,
    code: known ? publicCode : (status >= 500 ? "upstream_error" : "invalid_request"),
    message: detail,
    headers,
    retryAfterSeconds: Number(headers["retry-after"]) || null,
  });
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
  const access = prepareEntryAccess(req, route, startedAt);
  const rec = gatewayRecord(req);
  let auth = { ok: true, clientId: "", client: null, authRequired: false };
  if (!isTtsUiShellRequest(req, route)) {
    const ban = gatewayPipeline.checkBan(req);
    if (ban) {
      denyEntryRequest(req, access, { status: 429, message: ban.message, code: "auth_banned", log: shouldLogTtsAccess });
      return sendTtsRefusal(req, res, 429, ban.message, "auth_banned", { ...gatewayCorsHeaders(req), "retry-after": String(ban.retryAfterSeconds) });
    }
    auth = await gatewayPipeline.authorize(req, { scope: scopeForGatewayPath(url.pathname, req.method) });
    if (!auth.ok) {
      denyEntryRequest(req, access, { status: auth.status, message: auth.message, code: auth.code, log: shouldLogTtsAccess });
      const headers = { ...gatewayCorsHeaders(req), ...(auth.status === 401 ? { "www-authenticate": "Bearer" } : {}) };
      // The TTS gateway keeps its {detail, code} shape on ADMIN; the code is 05 §10.2's.
      return sendTtsRefusal(req, res, auth.status, auth.message, auth.code, headers);
    }
  }

  const rate = gatewayPipeline.enterRate(req, res, auth);
  if (!rate.ok) {
    const message = `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`;
    denyEntryRequest(req, access, { status: 429, message, code: "rate_limit_exceeded", log: shouldLogTtsAccess });
    return sendTtsRefusal(req, res, 429, message, "rate_limit_exceeded", {
      ...gatewayCorsHeaders(req),
      "retry-after": String(rate.retryAfterSeconds),
    });
  }

  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > TTS_GATEWAY_MAX_BODY_BYTES) {
    const message = `TTS request body exceeds ${TTS_GATEWAY_MAX_BODY_BYTES} bytes.`;
    denyEntryRequest(req, access, { status: 413, message, code: "request_body_too_large", log: shouldLogTtsAccess });
    return sendTtsRefusal(req, res, 413, message, "request_body_too_large", gatewayCorsHeaders(req));
  }
  // TTS 用量计费（F3）：持客户端 Key 的合成请求按秒数 / 字符数进账本，并检查每日秒数配额。
  const synthesis = ttsSynthesisRoute({ rest: buildTtsGatewayPath(route).slice(1) }, req.method);
  const meter = synthesis && auth.client?.id
    ? { clientId: auth.client.id, managerId: auth.matchedManager || "tts", endpoint: synthesis.endpoint, kind: synthesis.kind, characters: 0, engine: "unknown" }
    : null;
  if (!(await isManagerPortListening(TTS_GATEWAY_PORT))) {
    denyEntryRequest(req, access, { status: 503, message: `TTS gateway is not listening on port ${TTS_GATEWAY_PORT}.`, code: "tts_gateway_offline", log: shouldLogTtsAccess });
    return sendTtsRefusal(req, res, 503, UPSTREAM_DOWN_MESSAGE, "service_unavailable", gatewayCorsHeaders(req));
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
  watchEntryAccess(req, res, access, shouldLogTtsAccess);
  let bodyLimitError = null;
  let dispatched = false;
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
      rec?.setRouting({ modelRequested: meter.engine, modelResolved: meter.engine });
      rec?.setExtra({ ttsCharacters: meter.characters });
      meter.requestId = crypto.randomUUID();
      const copies = meter.kind === "batch" ? Math.max(1, new Set(parsed.engines || []).size) : 1;
      const estimatedMs = Math.ceil(Math.max(1000 * copies, meter.characters * 250 / Math.max(0.5, Number(parsed.speed) || 1)));
      const authorization = getBillingStore().authorizeTtsRequest({ ...meter, estimatedMs });
      if (!authorization.allowed) {
        upstreamControl.clear();
        access.error = String(authorization.code || "");
        const deniedStatus = authorization.code === "billing_insufficient_balance" ? 402 : 429;
        rec?.reject({ status: deniedStatus, code: authorization.code });
        return sendTtsRefusal(req, res, deniedStatus, "TTS billing allowance is insufficient for this request.", authorization.code, gatewayCorsHeaders(req));
      }
      req.ttsRequestId = meter.requestId;
      body = buffered;
    } else if (hasBody) {
      const limiter = createTtsBodyLimiter();
      limiter.once("error", (error) => { bodyLimitError = error; });
      body = Readable.toWeb(req.pipe(limiter));
    }
    dispatched = true;
    rec?.dispatched();
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildTtsProxyHeaders(req.headers, req),
      body,
      ...(hasBody && !meter ? { duplex: "half" } : {}),
      signal: upstreamControl.signal,
      redirect: "manual",
    });
    rec?.headers(upstream.status, upstream.headers);
    const responseHeaders = buildResponseHeaders(upstream.headers, req);
    if (isTtsUiShellRequest(req, route)) {
      responseHeaders["content-security-policy"] = TTS_UI_CSP;
      responseHeaders["permissions-policy"] = "camera=(), microphone=(self), geolocation=()";
    }
    res.writeHead(upstream.status, responseHeaders);
    if (meter?.requestId) {
      if (!upstream.ok) recordTtsUsageSafely({ ...meter, status: upstream.status, ok: false, audioMs: 0, durationSource: "missing" });
      res.once("finish", () => ttsReconciler.flush().catch(() => {}));
    }
    forwardUpstreamBody(upstream, res, upstreamControl, rec?.tap());
  } catch (error) {
    upstreamControl.clear();
    const failure = bodyLimitError || error?.cause || error;
    const status = Number(failure?.status || (error?.name === "TimeoutError" ? 504 : 502));
    const message = status === 413 ? failure.message : "TTS gateway upstream is unavailable.";
    // Ambiguous transport failures retain their reservation until a durable completion receipt arrives.
    access.error = failure?.message || message;
    rec?.fail({ status, code: failure?.code || "tts_gateway_proxy_error", phase: dispatched ? "upstream" : "pre_upstream" });
    if (!res.headersSent) {
      sendTtsRefusal(req, res, status, message, failure?.code || "tts_gateway_proxy_error", gatewayCorsHeaders(req));
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    releaseTtsBody();
  }
}

// The model gateway runs through the shared pipeline (05 §8.1,
// lib/gateway-pipeline.js); this file supplies the transport helpers.
const gatewayPipeline = createGatewayPipeline({
  security,
  getAdminAuth: (req) => req?.serviceEntryAdminAuth || entryAccessFor(null).adminAuth,
  getManagers: () => MANAGERS,
  getCatalogs: (managers) => Promise.all(managers.map((manager) => getManagerModelCatalog(manager))),
  getFleetSettings: () => getFleetSettings(),
  selectFleetTarget: (catalogs, request) => selectFleetTarget(catalogs, request),
  resolveModelAlias: (requested, context) => publicApi.resolveAlias(requested, context),
  limiter: gatewayLimiter,
  keysStore: () => getAccessStore(),
  logger: console,
  io: {
    prepareAccess: prepareEntryAccess,
    record: gatewayRecord,
    deny: denyEntryRequest,
    watch: (req, res, access) => watchEntryAccess(req, res, access),
    recordAuth: recordGatewayAuth,
    entryContext: buildEntryHopContext,
    recordRouting: recordGatewayRouting,
    corsHeaders: gatewayCorsHeaders,
    sendJson,
    isModelListRequest: isAggregatedModelListRequest,
    sendModelList: sendAggregatedModelList,
    readJsonBody: readGatewayJsonBody,
    summarizeBody: summarizeGatewayRequestBody,
    claudeAliases: CLAUDE_COMPAT_MODEL_ALIASES,
    isGenericModel: (model) => GENERIC_MODEL_ID_SET.has(String(model || "").toLowerCase()),
    rewriteModelBody: rewriteRequestModelBody,
    isPortListening: isManagerPortListening,
    upstreamDownMessage: UPSTREAM_DOWN_MESSAGE,
    buildManagerPath: buildManagerGatewayPath,
    createUpstreamControl: (req, res) => createUpstreamControl(req, res),
    fetch: (target, init) => fetch(target, init),
    buildProxyHeaders,
    managerTrustVersion: managerGatewayTrustVersion,
    buildResponseHeaders,
    forwardBody: forwardUpstreamBody,
  },
});

async function proxyGatewayRequest(req, res, url) {
  return gatewayPipeline.handle(req, res, { url, route: parseGatewayRoute(url.pathname) });
}

// The public surface (05 §8, lib/public-api.js): the route dispatch of the
// PUBLIC key routes, the enriched model lists and the alias resolution. This
// file supplies the transport handlers and the data the lists join.
let publicTtsModelsCache = { until: 0, value: [] };

// The /v1/me family (05 §8.5, lib/me-routes.js): the key's own view on PUBLIC
// and /gateway/me on ADMIN. Usage and recent requests come from the telemetry
// store when it is ready (04 query layer, restricted to the key), else the
// key's counters.
function meTelemetryStore() {
  const store = routeMounts?.ctx?.telemetry?.store;
  return store && (!store.state || store.state === "ready") && typeof store.call === "function" ? store : null;
}

const meRoutes = createMeRoutes({
  pipeline: () => gatewayPipeline,
  limiter: gatewayLimiter,
  keysStore: () => getAccessStore(),
  config: () => security.accessConfig(),
  billing: () => {
    try {
      return getBillingStore();
    } catch {
      return null;
    }
  },
  telemetry: {
    timeseries: async (params, { tzOffsetMinutes } = {}) => {
      const store = meTelemetryStore();
      if (!store) return null;
      return store.call("timeseries", telemetryQuery.parseQuery("timeseries", params, { now: Date.now(), tzOffsetMinutes }));
    },
    requests: async (params) => {
      const store = meTelemetryStore();
      if (!store) return null;
      return store.call("listRequests", telemetryQuery.parseQuery("requests", params, { now: Date.now() }));
    },
  },
  listModels: (req, caller) => publicApi.availableModels({ req, caller, managers: gatewayPipeline.managersFor(caller, "auto") }),
  sendJson,
  corsHeaders: (req, caller) => (caller?.key && security.listenerKind(req) === "public" ? security.publicCorsHeaders(req, caller.key) : gatewayCorsHeaders(req)),
  record: gatewayRecord,
  clientIp: (req) => security.resolveClientAddress(req),
  onKeyChanged: () => security.invalidatePublicOrigins?.(),
  logger: console,
});

const publicApi = createPublicApi({
  pipeline: () => gatewayPipeline,
  getCatalogs: (managers) => Promise.all(managers.map((manager) => getManagerModelCatalog(manager))),
  store: () => getAccessStore(),
  config: () => security.accessConfig(),
  limiter: gatewayLimiter,
  sendJson,
  getPrice: (caller, model, managerId) => resolvePublicModelPrice(caller, model, managerId),
  getTtsModels: async () => {
    // A list call must not probe the TTS gateway every time.
    if (publicTtsModelsCache.until > Date.now()) return publicTtsModelsCache.value;
    const tts = await buildTtsStatus();
    const value = (tts.engines || []).filter((item) => item.available && item.id).map((item) => ({ id: String(item.id), name: String(item.name || item.label || item.id) }));
    publicTtsModelsCache = { until: Date.now() + 10_000, value };
    return value;
  },
  handlers: {
    gateway: (req, res, url) => proxyGatewayRequest(req, res, url),
    status: (req, res, url) => handleGatewayStatus(req, res, url),
    tts: (req, res, url) => proxyTtsGatewayRequest(req, res, url),
    me: (req, res, url) => meRoutes.handle(req, res, url),
  },
  logger: console,
});

// The price a key's plan puts on a model (05 §8.3): the plan of the customer
// the key is bound to, else the default plan (prices with no plan). Null when
// billing has no price or cannot be read.
function resolvePublicModelPrice(caller, model, managerId) {
  try {
    const billing = getBillingStore();
    const binding = caller?.key?.billing;
    const customer = binding?.scope && binding?.clientId ? billing.lookupCustomerForCredential(binding.scope, binding.clientId) : null;
    const planId = customer?.customerId ? billing.getCustomer(customer.customerId)?.planId || null : null;
    return billing.resolveModelPrice({ planId, managerId: String(managerId || ""), model: String(model?.id || "") });
  } catch {
    return null;
  }
}

// Reads, decodes and parses a model-gateway JSON body under the entry's body
// budgets. Throws an Error with status and code; the result's release()
// returns the budgets (also on finish/close).
async function readGatewayJsonBody(req, res) {
  requireGatewayJsonContentType(req);
  let requestBody;
  let releaseBodyBudget = () => {};
  if (!["GET", "HEAD"].includes(req.method)) {
    const heldBody = await readRequestBody(req, GATEWAY_MAX_BODY_BYTES, { holdReservation: true, trackGlobal: true });
    requestBody = heldBody.buffer;
    releaseBodyBudget = heldBody.release;
    res.once("finish", releaseBodyBudget);
    res.once("close", releaseBodyBudget);
  }
  let releaseCompressedBodyBudget = () => {};
  const release = () => {
    releaseBodyBudget();
    releaseCompressedBodyBudget();
  };
  try {
    const contentEncoding = normalizeRequestContentEncoding(req.headers["content-encoding"]);
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
    let parsedBody = parseRequestJsonBody(requestBody, {
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
    return { requestBody, parsedBody, contentEncoding, release };
  } catch (error) {
    release();
    throw error;
  }
}

// --- 401 storm guard ---------------------------------------------------------

// Thin entry points over the limiter (lib/limiter.js, 05 §9.3) for the
// handlers that run their own checks. Loopback and the trusted proxies'
// own addresses are never banned: a misconfigured local client should get a
// clear 401 every time rather than a lockout.
function checkAuthBan(req) {
  return gatewayPipeline.checkBan(req);
}

function noteAuthResult(req, auth) {
  return gatewayLimiter.noteAuthResult(security.identifyClient(req), auth);
}

// --- /gateway/status ---------------------------------------------------------

async function handleGatewayStatus(req, res, url) {
  const route = { engine: "auto", protocol: "status", rest: "status" };
  const startedAt = Date.now();
  const access = prepareEntryAccess(req, route, startedAt);
  const ban = checkAuthBan(req);
  if (ban) {
    gatewayRecord(req)?.reject({ status: 429, code: "auth_banned" });
    return gatewayPipeline.sendRefusal(req, res, { status: 429, code: "auth_banned", message: ban.message, retryAfterSeconds: ban.retryAfterSeconds, headers: gatewayCorsHeaders(req) });
  }
  const auth = await gatewayPipeline.authorize(req, { scope: scopeForGatewayPath(url.pathname, req.method) });
  if (!auth.ok) {
    denyEntryRequest(req, access, { status: auth.status, message: auth.message, code: auth.code });
    return gatewayPipeline.sendRefusal(req, res, { ...auth, headers: gatewayCorsHeaders(req) });
  }
  // A status read is a control request: it looks at the caller's rpm bucket
  // (and honours it) but takes no token from it (05 §8.1, V6).
  const rate = gatewayPipeline.enterRate(req, res, auth, { peek: true });
  if (!rate.ok) {
    gatewayRecord(req)?.reject({ status: 429, code: "rate_limit_exceeded" });
    return gatewayPipeline.sendRefusal(req, res, {
      status: 429,
      code: "rate_limit_exceeded",
      message: `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`,
      retryAfterSeconds: rate.retryAfterSeconds,
      headers: gatewayCorsHeaders(req),
    });
  }
  const authorizedManagers = gatewayPipeline.managersFor(auth, "auto");
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
    // Only the models this caller may use (05 §8.1).
    models: (catalog.models || [])
      .filter((model) => gatewayPipeline.modelVisible(auth, model, catalog.manager?.id || catalog.id))
      .map((model) => String(model?.id || "").trim()).filter(Boolean).slice(0, 100),
  }));
  const models = Array.from(new Set(managers.flatMap((manager) => manager.models)));
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
    rateLimit: { limitPerMinute: rate.ticket?.rpm?.limit ?? null, remaining: rate.ticket?.rpm?.remaining ?? null, windowSeconds: 60 },
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
  // A successful status read is a control request: counted, not logged (04 §5.5).
  if (!gatewayRecord(req)) appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 200, startedAt, null, "")).catch(() => {});
  return sendJson(res, payload, 200, gatewayCorsHeaders(req));
}

// --- search gateway / MCP proxies -------------------------------------------

const AUX_UPSTREAMS = {
  search: { port: () => SEARCH_GATEWAY_PORT, name: "Search gateway", timeoutMs: 10 * 60 * 1000 },
  mcp: { port: () => PLATFORM_MCP_PORT, name: "MCP server", timeoutMs: 10 * 60 * 1000 },
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
  const requestId = String(gatewayRecord(req)?.requestId || "");
  if (requestId) drop.add("x-request-id");
  for (const [name, value] of Object.entries(headers || {})) {
    const key = String(name).toLowerCase();
    if (drop.has(key) || key.startsWith("proxy-")) continue;
    if (Array.isArray(value)) out[key] = value.join(", ");
    else if (value !== undefined) out[key] = String(value);
  }
  if (credential) out.authorization = `Bearer ${credential}`;
  out["x-forwarded-for"] = security.resolveClientAddress(req) || "";
  if (requestId) out["x-request-id"] = requestId;
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
  const access = prepareEntryAccess(req, route, startedAt);
  const rec = gatewayRecord(req);
  const ban = checkAuthBan(req);
  if (ban) {
    denyEntryRequest(req, access, { status: 429, message: ban.message, code: "auth_banned" });
    return sendJson(res, core.openAiGatewayError("auth_banned", ban.message), 429, { ...gatewayCorsHeaders(req), "retry-after": String(ban.retryAfterSeconds) });
  }
  const auth = await gatewayPipeline.authorize(req, { scope: scopeForGatewayPath(url.pathname, req.method) });
  if (!auth.ok) {
    denyEntryRequest(req, access, { status: auth.status, message: auth.message, code: auth.code });
    return gatewayPipeline.sendRefusal(req, res, { ...auth, headers: gatewayCorsHeaders(req) });
  }
  const rate = gatewayPipeline.enterRate(req, res, auth);
  if (!rate.ok) {
    const message = `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`;
    denyEntryRequest(req, access, { status: 429, message, code: "rate_limit_exceeded" });
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
    denyEntryRequest(req, access, { status: 503, message: `${upstreamSpec.name} is not listening on port ${port}.`, code: "manager_offline" });
    return sendJson(res, core.openAiGatewayError("service_unavailable", UPSTREAM_DOWN_MESSAGE), 503, gatewayCorsHeaders(req));
  }
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > GATEWAY_MAX_BODY_BYTES) {
    const message = `Request body exceeds ${GATEWAY_MAX_BODY_BYTES} bytes.`;
    rec?.reject({ status: 413, code: "request_body_too_large" });
    return sendJson(res, core.openAiGatewayError("request_body_too_large", message), 413, gatewayCorsHeaders(req));
  }
  if (!(await acquireEntryConcurrency(req, res, auth))) return;
  const credential = await auxUpstreamCredential(route.service);
  const target = new URL(`http://127.0.0.1:${port}${targetPath}`);
  target.search = url.search;
  const hasBody = !["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase());
  const upstreamControl = createUpstreamControl(req, res, { timeoutMs: upstreamSpec.timeoutMs });
  watchEntryAccess(req, res, access);
  let bodyLimitError = null;
  let dispatched = false;
  try {
    let body;
    if (hasBody) {
      const limiter = createTtsBodyLimiter(GATEWAY_MAX_BODY_BYTES);
      limiter.once("error", (error) => { bodyLimitError = error; });
      body = Readable.toWeb(req.pipe(limiter));
    }
    dispatched = true;
    rec?.dispatched();
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildAuxProxyHeaders(req.headers, req, credential),
      body,
      ...(hasBody ? { duplex: "half" } : {}),
      signal: upstreamControl.signal,
      redirect: "manual",
    });
    rec?.headers(upstream.status, upstream.headers);
    res.writeHead(upstream.status, buildResponseHeaders(upstream.headers, req));
    forwardUpstreamBody(upstream, res, upstreamControl, rec?.tap());
  } catch (error) {
    upstreamControl.clear();
    const failure = bodyLimitError || error?.cause || error;
    const status = Number(failure?.status || (error?.name === "TimeoutError" ? 504 : 502));
    access.error = failure?.message || "upstream unavailable";
    rec?.fail({ status, code: failure?.code || (error?.name === "TimeoutError" ? "request_timeout" : "gateway_proxy_error"), phase: dispatched ? "upstream" : "pre_upstream" });
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

// `transform` is one pass-through Transform or a list of them (the usage tap
// and the telemetry tap), applied in order.
function forwardUpstreamBody(upstream, res, upstreamControl, transform = null) {
  const transforms = (Array.isArray(transform) ? transform : [transform]).filter(Boolean);
  if (!upstream?.body) {
    upstreamControl.clear();
    if (!res.writableEnded) res.end();
    for (const item of transforms) if (typeof item.end === "function") item.end();
    return;
  }
  const stream = typeof upstream.body.getReader === "function"
    ? Readable.fromWeb(upstream.body)
    : upstream.body;
  if (transforms.length) pipeline(stream, ...transforms, res, () => upstreamControl.clear());
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

// ADMIN lists the OpenAI-form models itself and proxies a single-model read.
// PUBLIC answers every model read from the enriched catalog (05 §8.3): lists
// and retrievals, OpenAI and Anthropic form alike.
function isAggregatedModelListRequest(req, route) {
  if (security.listenerKind(req) === "public") return modelReadOf(req.method, route, { anthropic: true }) !== null;
  return modelReadOf(req.method, route)?.kind === "list" && req.method === "GET";
}

async function sendAggregatedModelList(req, res, engine = "auto", auth = null, scopedManagers = null, route = null) {
  if (security.listenerKind(req) === "public") {
    const managers = Array.isArray(scopedManagers) ? scopedManagers : gatewayPipeline.managersFor(auth, engine);
    return publicApi.sendModels(req, res, { route: route || { engine, protocol: "openai", rest: "v1/models" }, caller: auth, managers, headers: gatewayCorsHeaders(req) });
  }
  const managers = Array.isArray(scopedManagers)
    ? scopedManagers
    : gatewayPipeline.managersFor(auth, engine);
  if (!managers.length) {
    return gatewayPipeline.sendRefusal(req, res, {
      status: 403,
      code: "manager_forbidden",
      message: "This service API key is not authorized for the requested model manager.",
      headers: gatewayCorsHeaders(req),
    });
  }
  const catalogs = await Promise.all(managers.map((manager) => getManagerModelCatalog(manager)));
  const visible = mergeManagerModelCatalogs(catalogs);
  // A key sees only the models and fleet members it may use (05 §6.3).
  const filtered = Boolean(auth?.key || auth?.client);
  const data = filtered
    ? mergeManagerModelCatalogs(catalogs.map((catalog) => ({
      ...catalog,
      models: (catalog.models || []).filter((model) => gatewayPipeline.modelVisible(auth, model, catalog.manager?.id)),
    })))
    : visible;
  if (!data.length) {
    if (visible.length && filtered) {
      return gatewayPipeline.sendRefusal(req, res, {
        status: 403,
        code: auth.key ? "model_not_allowed" : "model_forbidden",
        message: "This service client is not allowed to list models on the selected fleet.",
        headers: gatewayCorsHeaders(req),
      });
    }
    return gatewayPipeline.sendRefusal(req, res, { status: 503, code: "service_unavailable", message: "No running model service reported any models.", headers: gatewayCorsHeaders(req) });
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

// The caller's address for the access log, read when the request starts: a
// socket that is already destroyed (client abort) may no longer report its peer.
function entryAccessOrigin(req) {
  return {
    remoteAddress: security.resolveClientAddress(req),
    socketAddress: String(req?.socket?.remoteAddress || ""),
  };
}

// One access entry per proxied request, written when the response is done:
// "completed" on finish, or "client_abort" when the client hung up first, with
// 499 if no header was sent yet. A streaming client that disconnects never
// emits finish, so those requests used to vanish from the log. `shouldLog`
// lets the TTS proxy skip routine polls.
function logEntryGatewayAccessWhenDone(req, res, buildEntry, shouldLog = null) {
  const origin = entryAccessOrigin(req);
  core.onResponseDone(res, ({ terminalState }) => {
    const status = terminalState === "client_abort" && !res.headersSent ? 499 : res.statusCode;
    if (typeof shouldLog === "function" && !shouldLog(req, { statusCode: status })) return;
    appendEntryGatewayAccessLog(buildEntry({ status, terminalState, origin })).catch(() => {});
  });
}

// --- request telemetry (04 TEL-5) ---------------------------------------------

// The entry's request id when no telemetry record minted one: a PUBLIC
// request already has one (public-listener.js), an ADMIN one gets req_ now.
function ensureGatewayRequestId(req, res) {
  if (!req.requestId) req.requestId = newRequestId();
  res.setHeader("x-request-id", req.requestId);
  return req.requestId;
}

function telemetryRecorder() {
  return telemetry && telemetry.recorder ? telemetry.recorder : null;
}

function gatewayRecord(req) {
  return req?.telemetryRecord || null;
}

// 04 §5.2: the entry's context for the signed manager hop. It holds only what
// neither the principal nor the request id carries: the source-program slug
// and the trusted-proxy country. Never the key, the customer or the user agent.
function buildEntryHopContext(req) {
  const headers = req?.headers || {};
  const text = (name) => String(Array.isArray(headers[name]) ? headers[name][0] : headers[name] || "");
  const context = {
    v: 1,
    src: inferSourceProgram({
      userAgent: text("user-agent"),
      origin: text("origin"),
      referer: text("referer"),
      path: String(req?.originalUrl || req?.url || "").split("?")[0],
      xTitle: text("x-title") || text("x-ai-client"),
    }) || "unknown",
  };
  try {
    const country = security.identifyClient(req).country;
    if (country) context.cc = country;
  } catch {
    // No country is a valid context.
  }
  return context;
}

// One record per gateway request, started before any check so that a refusal
// is a row too. The id is minted here, always: a client x-request-id is kept
// as client_request_id and echoed as x-client-request-id, never forwarded or
// used as a key (04 §5.1, contract change C1). Returns null while telemetry
// is off, which leaves every code path below on its previous behaviour.
function beginGatewayRecord(req, res, url) {
  const recorder = telemetryRecorder();
  if (!recorder) return null;
  let rec = null;
  try {
    let clientIp = "";
    try {
      clientIp = security.resolveClientAddress(req) || "";
    } catch {
      clientIp = "";
    }
    rec = recorder.begin(req, res, {
      ingress: "entry",
      method: req.method,
      path: url.pathname,
      clientIp: clientIp || undefined,
    });
    res.setHeader("x-request-id", rec.requestId);
    req.requestId = rec.requestId;
    if (rec.clientRequestId) res.setHeader("x-client-request-id", rec.clientRequestId);
  } catch (error) {
    console.warn(core.redactSecrets(`service-entry: telemetry could not start a request record: ${error?.message || error}`));
    return null;
  }
  req.telemetryRecord = rec;
  // What the legacy access log needs beyond the row itself; the handlers fill
  // it in as the request is routed.
  req.entryAccess = { route: null, manager: null, metadata: null, resolvedModel: "", error: "", startedAt: Date.now(), origin: entryAccessOrigin(req) };
  return rec;
}

// The per-request access context shared by a handler, the legacy access-log
// writers and the telemetry row feed.
function prepareEntryAccess(req, route, startedAt) {
  const access = req.entryAccess || { manager: null, metadata: null, resolvedModel: "", error: "", origin: null };
  access.route = route;
  access.startedAt = startedAt;
  access.origin = access.origin || entryAccessOrigin(req);
  req.entryAccess = access;
  return access;
}

// A refusal before any upstream call (04 §6.1 rec.reject). With a record the
// finalised row feeds the access log; without one the entry is written now.
function denyEntryRequest(req, access, { status, message = "", code = "", manager = null, metadata = null, resolvedModel = "", log = null }) {
  access.manager = manager;
  access.metadata = metadata;
  access.resolvedModel = resolvedModel;
  access.error = message;
  const rec = gatewayRecord(req);
  if (rec) {
    rec.reject({ status, code });
    return;
  }
  if (typeof log === "function" && !log(req, { statusCode: status })) return;
  appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, access.route, manager, status, access.startedAt, metadata, message, resolvedModel)).catch(() => {});
}

// Success and failure after dispatch are written when the response is done.
// With a record the row does that (one finish/close listener pair per response
// is the recorder's, not a second one here).
function watchEntryAccess(req, res, access, shouldLog = null) {
  if (gatewayRecord(req)) return;
  logEntryGatewayAccessWhenDone(req, res, ({ status, terminalState, origin }) => buildEntryGatewayAccessEntry(
    req, access.route, access.manager, status, access.startedAt, access.metadata, access.error, access.resolvedModel, { terminalState, origin },
  ), shouldLog);
}

// The credential's identity for the row (04 §5.3). A key that failed
// authentication is never recorded, not even as a hash.
function recordGatewayAuth(req, auth, identity = {}) {
  const rec = gatewayRecord(req);
  if (!rec || !auth?.ok) return;
  // The owner's console (05 §5.8, §15): no key, recorded as the console.
  if (auth.kind === "console-session") {
    rec.setAuth({ keyId: null, customerId: null, authSource: "console-session", authManagerId: null, ...identity });
    return;
  }
  let keyId = String(auth.keyId || auth.client?.id || "");
  if (!keyId && auth.authRequired) {
    try {
      keyId = core.globalServiceBillingClientId({ apiKey: core.extractServiceApiKey(req.headers || {}, { acceptRawAuthorization: true }) });
    } catch {
      keyId = "";
    }
  }
  const matched = findManager(auth.matchedManager);
  rec.setAuth({
    keyId,
    customerId: auth.customerId || "",
    authSource: core.serviceApiKeySource(req.headers || {}),
    authManagerId: auth.key?.billing?.scope || matched?.billingId || auth.matchedManager || "",
    ...identity,
  });
}

const RECORDED_ENGINE_IDS = new Set(["vllm", "sglang", "llamacpp"]);

// legacy engine fields: "vllm"/"sglang" inside vllm-manager, "llama" in the
// llama manager (00 §3).
function recordedEngineId(instance, manager) {
  const raw = String(instance?.engineId || "").trim().toLowerCase();
  const engine = raw === "llama" ? "llamacpp" : raw;
  if (RECORDED_ENGINE_IDS.has(engine)) return engine;
  return manager?.id === "llama" ? "llamacpp" : "";
}

function recordGatewayRouting(req, selection, resolvedModel, requestedModel, metadata) {
  const rec = gatewayRecord(req);
  if (!rec) return;
  const manager = selection.manager;
  const instance = selection.instance || null;
  const instanceId = String(instance?.instanceId || instance?.id || "");
  rec.setRouting({
    managerId: manager?.id || "",
    fleetId: instance?.fleetId || (manager?.id && instanceId ? `${manager.id}:${instanceId}` : ""),
    engineId: recordedEngineId(instance, manager),
    runtimeId: instance?.runtimeId || "",
    launchId: instance?.launchId || "",
    modelRequested: requestedModel,
    modelResolved: resolvedModel,
    stream: metadata?.stream === true,
    routeReason: selection.reason || "",
  });
  rec.setExtra({ toolSchemaCount: metadata?.toolSchemaCount || 0 });
}

// The recorder's onRow: keeps the legacy gateway-access.log fed, now from the
// finalised row (real tokens, the minted request id, the terminal state), for
// one more release (04 §6.5). telemetry.keepJsonlAccessLog=false turns it off.
function handleTelemetryRow(row, { req } = {}) {
  if (!req || !telemetry?.keepJsonlAccessLog()) return;
  const access = req.entryAccess || {};
  if (isTtsGatewayPath(String(req.url || "").split("?")[0]) && !shouldLogTtsAccess(req, { statusCode: row.status })) return;
  const entry = buildEntryGatewayAccessEntry(
    req, access.route || null, access.manager || null, row.status, access.startedAt || row.receivedAt,
    access.metadata || null, access.error || "", access.resolvedModel || "",
    { terminalState: row.terminalState, origin: access.origin || undefined, row },
  );
  appendEntryGatewayAccessLog(entry).catch(() => {});
}

// Starts the recorder and its store; called before the entry listens. With
// telemetry.enabled false (TELEMETRY_ENABLED=0) nothing is recorded.
async function startTelemetry(options = {}) {
  if (telemetry) return telemetry;
  // Smoke runs (AI_FRONTEND_SMOKE=1) start next to whatever listens on the
  // default ports, so they run no recorder and no collectors.
  if (process.env.AI_FRONTEND_SMOKE === "1") return null;
  const runtime = createTelemetryRuntime({
    aiRoot: AI_ROOT,
    dataDir: DATA_DIR,
    getBillingStore,
    // /internal/telemetry/* (TEL-6): verified with the entry trust token.
    getTrustToken: () => security.getTrustToken(),
    readRequestBody,
    sendJson,
    ...options,
    onRow: handleTelemetryRow,
  });
  await runtime.start();
  telemetry = runtime;
  return runtime;
}

// Finalises in-flight records, flushes (2 s cap) and closes the store.
async function stopTelemetry(options = {}) {
  const runtime = telemetry;
  telemetry = null;
  if (!runtime) return { ok: true };
  // Telemetry never holds up shutdown for long.
  let guard = null;
  try {
    return await Promise.race([
      runtime.stop(options),
      new Promise((resolve) => {
        guard = setTimeout(() => resolve({ ok: true, timedOut: true }), 3000);
        guard.unref?.();
      }),
    ]);
  } catch (error) {
    console.warn(core.redactSecrets(`service-entry: telemetry did not stop cleanly: ${error?.message || error}`));
    return { ok: false };
  } finally {
    clearTimeout(guard);
  }
}

function buildEntryGatewayAccessEntry(req, route, manager, status, startedAt, body, error, resolvedModel = "", details = {}) {
  const parsedBody = Buffer.isBuffer(body)
    ? parseRequestJsonBody(body)
    : body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  const headers = req.headers || {};
  const origin = details.origin || entryAccessOrigin(req);
  // A finalised telemetry row (04 §6.5) carries the minted request id, the
  // real token counts and the measured duration.
  const row = details.row || null;
  const promptTokens = Math.max(0, Number(row?.promptTokens) || 0);
  const completionTokens = Math.max(0, Number(row?.outputTokens) || 0);
  return {
    at: new Date().toISOString(),
    requestId: row ? row.requestId : core.normalizeOpenAiGatewayRequestId(headers["x-request-id"]),
    remoteAddress: origin.remoteAddress,
    socketAddress: origin.socketAddress,
    method: req.method,
    path: String(req.url || "").split("?")[0],
    kind: route?.protocol || "",
    requestedEngine: route?.engine || "",
    resolvedEngine: manager?.id || "",
    status: Number(status || 0),
    terminalState: details.terminalState || "completed",
    model: typeof parsedBody?.model === "string" ? parsedBody.model.slice(0, 160) : "",
    resolvedModel: String(resolvedModel || "").slice(0, 160),
    stream: parsedBody?.stream === true,
    authSource: core.serviceApiKeySource(req.headers || {}),
    clientId: String(req.serviceEntryAuth?.clientId || "").slice(0, 120),
    userAgent: headerValue(headers, "user-agent"),
    origin: headerValue(headers, "origin"),
    refererHost: headerHost(headers, "referer"),
    durationMs: row ? row.durationMs : Date.now() - startedAt,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: promptTokens + completionTokens,
    toolSchemaCount: Number.isFinite(Number(parsedBody?.toolSchemaCount))
      ? Math.max(0, Number(parsedBody.toolSchemaCount))
      : Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolUseCount: 0,
    // Upstream and transport errors can echo request text; nothing secret
    // reaches the log file.
    error: core.redactSecrets(String(error || "")).slice(0, 240),
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

// Where entry access events go. Tests swap it to capture events instead of
// reading the shared log tree.
let entryGatewayAccessSink = (entry) => core.appendAccessLog(GATEWAY_ACCESS_LOG, entry);

async function appendEntryGatewayAccessLog(entry) {
  return entryGatewayAccessSink(entry);
}

function setEntryGatewayAccessSink(sink) {
  const previous = entryGatewayAccessSink;
  if (typeof sink === "function") entryGatewayAccessSink = sink;
  return () => {
    entryGatewayAccessSink = previous;
  };
}

// 状态页每 5 秒都会带上网关访问统计；窗口聚合交给短 TTL 单飞缓存。
const ENTRY_ACCESS_STATS_CACHE_MS = Math.max(0, Number(process.env.MODEL_ACCESS_STATS_CACHE_MS ?? 10_000));
const entryAccessStatsCache = core.createSingleFlightCache({ ttlMs: ENTRY_ACCESS_STATS_CACHE_MS, maxEntries: 16 });
// 04 §17.2: the facade is computed over an explicit time window (default 1 h).
const ENTRY_ACCESS_DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const ENTRY_ACCESS_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const ENTRY_ACCESS_PAGE_ROWS = 500;
const ENTRY_ACCESS_MAX_ROWS = 20000;
const ENTRY_ACCESS_STORE_LABEL = "telemetry.sqlite";

// "30m", "1h", "2d" (or bare milliseconds); anything else is the 1 h default.
function parseEntryAccessWindow(value) {
  const match = String(value ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return ENTRY_ACCESS_DEFAULT_WINDOW_MS;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] || "ms"];
  const ms = Number(match[1]) * unit;
  if (!Number.isFinite(ms) || ms <= 0) return ENTRY_ACCESS_DEFAULT_WINDOW_MS;
  return Math.min(ENTRY_ACCESS_MAX_WINDOW_MS, Math.max(60_000, Math.round(ms)));
}

// options: { limit, window, maxLines (accepted and ignored), store, now }.
async function collectEntryGatewayAccessStats(options = {}) {
  const limit = Math.min(500, Math.max(20, Number(options.limit || 120)));
  const windowMs = parseEntryAccessWindow(options.window);
  const store = options.store || telemetry?.store || null;
  const run = () => collectEntryGatewayAccessStatsFresh({ limit, windowMs, store, now: options.now });
  // An injected store (tests) is never cached across calls.
  if (ENTRY_ACCESS_STATS_CACHE_MS > 0 && !options.store && !options.now) {
    return entryAccessStatsCache.get(`gateway:${limit}:${windowMs}`, run);
  }
  return run();
}

// A requests row of the telemetry store as the legacy access-log entry the
// core summarisers expect.
function requestRowToAccessEntry(row) {
  const failed = row.errorClass && row.errorClass !== "none";
  return {
    at: row.receivedAt,
    requestId: row.requestId,
    clientRequestId: row.clientRequestId || "",
    remoteAddress: row.clientIp || "",
    method: row.method,
    path: row.path,
    kind: row.protocol,
    status: row.status,
    terminalState: row.terminalState,
    model: row.modelRequested || "",
    resolvedModel: row.modelResolved || "",
    stream: row.stream,
    authSource: row.authSource || "",
    clientId: row.keyId || "",
    userAgent: row.userAgent || "",
    origin: row.originHost || "",
    durationMs: row.durationMs,
    queuedMs: row.queueMs,
    inputTokens: row.promptTokens,
    outputTokens: row.outputTokens,
    error: failed ? String(row.errorCode || row.errorClass) : "",
    ingress: row.ingress,
  };
}

// Polling of the TTS workbench is not an access worth listing (the legacy log
// skipped it too); the store keeps it as control counts, this guards a stray row.
function isTtsPollRow(entry) {
  if (!isTtsGatewayPath(entry.path)) return false;
  return !shouldLogTtsAccess({ method: entry.method, url: entry.path }, { statusCode: entry.status });
}

async function readEntryAccessEventsFromStore(store, fromMs, toMs) {
  const entries = [];
  let cursor = null;
  while (entries.length < ENTRY_ACCESS_MAX_ROWS) {
    const page = await store.call("listRequests", {
      from: fromMs, to: toMs, limit: ENTRY_ACCESS_PAGE_ROWS, filters: {}, cursor, rangeExplicit: true,
    });
    for (const row of page.rows || []) {
      if (row.extra && row.extra.dupOf) continue;
      entries.push(requestRowToAccessEntry(row));
    }
    if (!page.nextCursor) break;
    try {
      const decoded = JSON.parse(Buffer.from(String(page.nextCursor), "base64url").toString("utf8"));
      cursor = { t: Number(decoded.t), id: Number(decoded.id) };
    } catch {
      break;
    }
  }
  return entries;
}

async function collectEntryGatewayAccessStatsFresh({ limit, windowMs, store, now: nowOption }) {
  const now = Number.isFinite(Number(nowOption)) ? Number(nowOption) : Date.now();
  const lanAddress = core.getLanAddress();
  const storeReady = Boolean(store) && (!store.state || store.state === "ready");
  let entries;
  if (storeReady) {
    try {
      entries = await readEntryAccessEventsFromStore(store, now - windowMs, now + 1);
    } catch {
      entries = null;
    }
  }
  // Telemetry off or its store unavailable: the legacy log, cut to the window.
  const fromStore = Array.isArray(entries);
  if (!fromStore) entries = await readEntryGatewayAccessEvents(12000);
  const events = entries
    .filter((entry) => !isTtsPollRow(entry))
    .map((entry) => {
      const event = core.normalizeAccessEvent(entry, lanAddress);
      // 04 §17.2: public ingress counts as external whatever the address.
      if (entry.ingress === "public") event.external = true;
      return event;
    })
    .filter((entry) => entry.atMs >= now - windowMs && entry.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
  const external = events.filter((entry) => entry.external);
  const local = events.filter((entry) => !entry.external);
  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    logPath: fromStore ? ENTRY_ACCESS_STORE_LABEL : GATEWAY_ACCESS_LOG,
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

// options: requestId, instanceId, stripContentEncoding, and for a manager
// that advertises gatewayTrust.version >= 2 (05 §7.1): hopVersion: 2 with
// pathname (the manager-side path the hop is signed for), method, principal
// and context (default req.serviceEntryPrincipal / req.serviceEntryContext).
function buildProxyHeaders(headers, req = null, options = {}) {
  const output = {};
  const stripped = new Set([
    "host", "connection", "content-length", "transfer-encoding", "upgrade",
    "keep-alive", "te", "trailer", "proxy-connection", "proxy-authenticate", "proxy-authorization",
    ...TRUST_HEADER_NAMES,
  ]);
  if (options.stripContentEncoding) stripped.add("content-encoding");
  // With a request record the inbound x-request-id is never forwarded; the id
  // the entry minted replaces it (04 §5.1, contract change C1). A v2 hop always
  // carries the entry's req_ id: it is part of the signature.
  const wantsV2 = Number(options.hopVersion || 0) >= 2;
  const requestId = String(options.requestId || gatewayRecord(req)?.requestId || (wantsV2 ? req?.requestId : "") || "");
  const hopV2 = wantsV2 && core.ENTRY_REQUEST_ID_RE.test(requestId);
  if (requestId) stripped.add("x-request-id");
  // A v2 manager trusts the signed principal, so the key never crosses the
  // hop; a legacy manager still checks it and gets it as before.
  if (hopV2) for (const name of ENTRY_KEY_HEADERS) stripped.add(name);
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    // Trust headers are dropped before being re-issued below, so a client
    // cannot forge the address this process vouches for, nor any header of
    // the entry's own hop or internal signing families.
    if (stripped.has(lower) || lower.startsWith("proxy-")) continue;
    if (ENTRY_RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    output[key] = value;
  }
  const trustHeaders = hopV2
    ? security.entryHeaders(req, {
      method: options.method || req?.method,
      pathname: options.pathname,
      requestId,
      principal: options.principal !== undefined ? options.principal : req?.serviceEntryPrincipal || null,
      context: options.context !== undefined ? options.context : req?.serviceEntryContext || null,
    })
    : security.trustHeaders(req);
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
  if (requestId) output["x-request-id"] = requestId;
  return output;
}

function buildResponseHeaders(headers, req) {
  const output = gatewayCorsHeaders(req);
  const rec = gatewayRecord(req);
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "transfer-encoding", "content-encoding", "keep-alive", "te", "trailer"].includes(lower) || lower.startsWith("proxy-")) continue;
    // The caller sees the id of the record, whatever the upstream echoed.
    if (rec && (lower === "x-request-id" || lower === "x-client-request-id")) continue;
    output[key] = value;
  }
  if (rec) {
    output["x-request-id"] = rec.requestId;
    if (rec.clientRequestId) output["x-client-request-id"] = rec.clientRequestId;
  } else if (req?.requestId) {
    output["x-request-id"] = req.requestId;
  }
  output["cache-control"] = output["cache-control"] || "no-store";
  return output;
}

// Default-deny: an Origin is only echoed when it was explicitly configured.
// The previous version reflected whatever the caller sent, which let any page
// the user visited read and write the local gateway.
function gatewayCorsHeaders(req) {
  // PUBLIC has no ambient CORS: per-key origins are the pipeline's (05 §11),
  // and the env origins of the keyless ADMIN gateway never apply there.
  if (security.listenerKind(req) === "public") {
    // The one ambient answer is the preflight (05 §11): it carries no key, so
    // the union of the active keys' origins decides.
    return String(req.method || "").toUpperCase() === "OPTIONS" ? security.publicPreflightHeaders(req) : {};
  }
  return security.corsHeaders(req);
}

function createUpstreamControl(req, res, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.SERVICE_ENTRY_GATEWAY_TIMEOUT_MS || 30 * 60 * 1000));
  const timer = setTimeout(() => {
    gatewayRecord(req)?.timedOut();
    controller.abort(new Error("Gateway request timed out."));
  }, timeoutMs);
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
  // The pre-dispatch guard already read a signed request's body to check its
  // digest (05 §5.7); the stream is spent, so every reader starts here.
  if (Buffer.isBuffer(req?.rawBody)) {
    if (req.rawBody.length > maxBytes) {
      const error = new Error("Request body too large for service-entry gateway.");
      error.code = "request_body_too_large";
      error.status = 413;
      throw error;
    }
    const buffer = req.rawBody.length ? req.rawBody : undefined;
    return options.holdReservation ? { buffer, release: () => {} } : buffer;
  }
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

// The host and port a manager started by this process binds come from
// platform.json (env > file > default; 127.0.0.1 unless managers.bindHost says
// otherwise, 06 §10.3, V21). options: { aiRoot, env, spawn, readyTimeoutMs } for tests.
function managerBindFor(manager, options = {}) {
  try {
    const section = core.platform.readSection("managers", { aiRoot: options.aiRoot || AI_ROOT, ...(options.env ? { env: options.env } : {}) });
    const entry = section.values?.[manager.id];
    const port = Number(entry?.port);
    const host = typeof entry?.host === "string" && entry.host ? entry.host : manager.defaultHost;
    return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : manager.port };
  } catch {
    return { host: manager.defaultHost, port: manager.port };
  }
}

async function startDetachedManager(manager, options = {}) {
  const bind = managerBindFor(manager, options);
  if (await core.isPortListening("127.0.0.1", bind.port)) {
    return { ok: true, alreadyRunning: true, status: await buildManagerStatus(manager, { force: true }) };
  }
  await fs.mkdir(path.join(manager.root, "logs"), { recursive: true });
  const nodeExe = process.env.NODE_EXE || process.execPath || "node";
  const out = fsSync.openSync(path.join(manager.root, "logs", "manager.out.log"), "a");
  const err = fsSync.openSync(path.join(manager.root, "logs", "manager.err.log"), "a");
  const env = {
    ...process.env,
    [manager.envPort]: String(bind.port),
    [manager.envHost]: bind.host,
    // Env is a bootstrap fallback; managers prefer the published file so they
    // can follow entry token rotation without a manager restart.
    SERVICE_GATEWAY_TRUST_TOKEN: security.getTrustToken(),
    AI_ROOT: process.env.AI_ROOT || AI_ROOT,
  };
  if (manager.id === "vllm") env.VLLM_MANAGER_ALLOW_REMOTE = env.VLLM_MANAGER_ALLOW_REMOTE || "0";
  if (manager.id === "llama") env.LLAMA_MANAGER_ALLOW_REMOTE = env.LLAMA_MANAGER_ALLOW_REMOTE || "0";
  const child = (options.spawn || spawn)(nodeExe, ["server.js"], {
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
  const ready = await waitForManagerReady({ ...manager, port: bind.port }, options.readyTimeoutMs ?? 12000);
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

// Central viewer redaction (05 §5.4): the guard put the matched entry's
// redaction on req.viewer, and every JSON answer below 400 passes through it,
// so no route can forget it. A redaction that fails answers 500; the
// unredacted body is never sent.
function sendJson(res, data, status = 200, extraHeaders = {}) {
  let body = data;
  let code = status;
  const viewer = res?.req?.viewer;
  if (viewer && typeof viewer.redact === "function" && code < 400) {
    try {
      body = viewer.redact(data, viewer.ctx || {});
      if (body === undefined) throw new Error("the redaction returned nothing");
    } catch (error) {
      console.error(core.redactSecrets(`service-entry: viewer redaction failed; answering 500: ${error?.message || error}`));
      body = { ok: false, error: { code: "internal_error", message: "Service entry error." } };
      code = 500;
    }
  }
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function shutdownSoon(options = {}) {
  const targetServer = options.server !== undefined ? options.server : server;
  const hub = options.hub !== undefined ? options.hub : modelHub;
  const exitProcess = typeof options.exit === "function" ? options.exit : (code) => process.exit(code);
  const graceMs = Math.max(100, Number(options.graceMs || process.env.SERVICE_ENTRY_SHUTDOWN_GRACE_MS || 5000));
  const delayMs = options.delayMs ?? 100;
  setTimeout(async () => {
    // The hub goes first (03 §8): its in-process downloads become
    // interrupted and its files are flushed before anything else closes.
    await stopModelHub(hub, { reason: "shutdown", timeoutMs: graceMs });
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
        .then(() => stopTelemetry())
        .catch(() => {})
        .then(() => core.flushAllAccessLogs())
        .catch(() => {})
        .finally(() => {
          closeBillingStore();
          closeAccessStore();
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
  ROUTE_MODULES,
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
  buildEntryHopContext,
  managerGatewayTrustVersion,
  resetManagerTrustCache: () => managerTrustCache.clear(),
  buildServiceEntryFleetSnapshot,
  collectEntryGatewayAccessStats,
  entryGatewayInFlight,
  summarizeRuntimeLoad,
  createUpstreamControl,
  createTtsBodyLimiter,
  createRouteContext,
  createServiceEntryServer,
  // The bound listeners once startServiceEntry() ran: { admin, public, publicError, binds }.
  getListeners: () => listeners,
  createPublicServer,
  createPublicHandler,
  createPublicPortalData,
  dispatchRouteModules,
  emptyManagerCatalog,
  findManager,
  flattenCatalogModels,
  forwardUpstreamBody,
  getFleetCatalogs,
  getAccessStore,
  closeAccessStore,
  getBillingStore,
  buildKeySummary,
  migrateLegacyKeys,
  planLegacyKeys,
  prepareAccessStore,
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
  redactFleetForViewer,
  redactStatusForRemote,
  registerEntryRoutes,
  resolveGatewayManager,
  rewriteRequestModelBody,
  saveFleetSettings,
  security,
  selectGatewayManagersForAuth,
  selectFleetTarget,
  selectGatewayManager,
  serializeFleetRouteTarget,
  sendAggregatedModelList,
  setEntryGatewayAccessSink,
  shouldLogTtsAccess,
  logEntryGatewayAccessWhenDone,
  startTelemetry,
  stopTelemetry,
  getTelemetry: () => telemetry,
  logStartupSummary,
  mountRouteModules,
  // The live mount table (ctx.bus, ctx.auth) once startServiceEntry() ran.
  getRouteMounts: () => routeMounts,
  // The model hub once startServiceEntry() built it (03 §3).
  getModelHub: () => modelHub,
  flushTtsSettlements: () => ttsReconciler.flush(),
  // The one limiter (05 §9): buckets, bans, the public share gate.
  getLimiter: () => gatewayLimiter,
  resetEntryRateLimitBuckets() {
    gatewayLimiter.reset();
  },
  shutdownSoon,
  startServiceEntry,
  startDetachedManager,
};
