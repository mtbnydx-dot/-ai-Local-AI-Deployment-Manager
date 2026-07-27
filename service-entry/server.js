const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const core = require("../manager-core");

const HOST = process.env.SERVICE_ENTRY_HOST || "127.0.0.1";
const PORT = Number(process.env.SERVICE_ENTRY_PORT || 5176);
const ROOT = __dirname;
const AI_ROOT = path.dirname(ROOT);
const GATEWAY_ACCESS_LOG = path.join(ROOT, "logs", "gateway-access.log");
const GATEWAY_MAX_BODY_BYTES = Math.max(1024 * 1024, Number(process.env.SERVICE_ENTRY_MAX_BODY_BYTES || 32 * 1024 * 1024));
const MODEL_DISCOVERY_CACHE_MS = Math.max(250, Number(process.env.SERVICE_ENTRY_MODEL_CACHE_MS || 3000));
const MANAGER_STATUS_CACHE_MS = Math.max(500, Number(process.env.SERVICE_ENTRY_STATUS_CACHE_MS || 5000));
const PUBLIC_BASE_URL = String(process.env.SERVICE_ENTRY_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
const ALLOWED_ORIGINS = String(process.env.SERVICE_ENTRY_ALLOWED_ORIGINS || "")
  .split(/[;,]/)
  .map((item) => item.trim())
  .filter(Boolean);

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

let server = null;
const managerModelCache = new Map();
const managerStatusCache = new Map();
// Manager liveness rarely flips, so a short probe cache turns the per-request
// TCP connect probe into an in-memory lookup for the common steady-state case.
const PORT_PROBE_CACHE_MS = Math.max(250, Number(process.env.SERVICE_ENTRY_PORT_PROBE_CACHE_MS || 2000));
const portProbeCache = new Map();

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
  return http.createServer(handleRequest);
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
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
    if (url.pathname.startsWith("/gateway/")) {
      return proxyGatewayRequest(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, {
        ok: true,
        entry: {
          host: HOST,
          port: PORT,
          lanAddress: core.getLanAddress(),
          pid: process.pid,
          uptimeSeconds: process.uptime(),
          gateway: buildEntryGatewayUrls(),
          gatewayAccess: await collectEntryGatewayAccessStats({ limit: 20, maxLines: 2000 }),
        },
        managers: await Promise.all(MANAGERS.map(buildManagerStatus)),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/gateway-access") {
      return sendJson(res, await collectEntryGatewayAccessStats({
        limit: url.searchParams.get("limit"),
        maxLines: url.searchParams.get("maxLines"),
      }));
    }
    const managerStartMatch = url.pathname.match(/^\/api\/managers\/([^/]+)\/start$/);
    if (req.method === "POST" && managerStartMatch) {
      if (!core.isLocalRequest(req)) return sendJson(res, { ok: false, error: "Start is only available from localhost." }, 403);
      const manager = findManager(managerStartMatch[1]);
      if (!manager) return sendJson(res, { ok: false, error: "Unknown manager." }, 404);
      return sendJson(res, await startDetachedManager(manager));
    }
    const managerStopMatch = url.pathname.match(/^\/api\/managers\/([^/]+)\/stop$/);
    if (req.method === "POST" && managerStopMatch) {
      if (!core.isLocalRequest(req)) return sendJson(res, { ok: false, error: "Stop is only available from localhost." }, 403);
      const manager = findManager(managerStopMatch[1]);
      if (!manager) return sendJson(res, { ok: false, error: "Unknown manager." }, 404);
      return sendJson(res, await stopManager(manager));
    }
    if (req.method === "POST" && url.pathname === "/api/stop-all") {
      if (!core.isLocalRequest(req)) return sendJson(res, { ok: false, error: "Stop is only available from localhost." }, 403);
      const stopped = await Promise.all(MANAGERS.map((manager) => postJson(`http://127.0.0.1:${manager.port}/api/manager/shutdown`)));
      sendJson(res, { ok: true, stopped });
      return shutdownSoon();
    }
    if (req.method === "POST" && (url.pathname === "/api/shutdown" || url.pathname === "/api/manager/shutdown")) {
      sendJson(res, { ok: true });
      return shutdownSoon();
    }
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message || "Service entry error." }, 500);
  }
}

function startServiceEntry() {
  if (server) return server;
  server = createServiceEntryServer();
  server.listen(PORT, HOST, () => {
    console.log(`Service entry listening on http://${HOST}:${PORT}`);
  });
  return server;
}

if (require.main === module) {
  startServiceEntry();
}

async function serveFile(res, filePath, contentType) {
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(content);
}

async function serveDoc(res, pathname) {
  const name = path.basename(String(pathname || ""));
  const allowed = new Set([
    "client-setup-guide.md",
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

function buildEntryGatewayUrls() {
  const localBase = `http://127.0.0.1:${PORT}`;
  const lanBase = HOST === "127.0.0.1" ? null : `http://${core.getLanAddress()}:${PORT}`;
  return {
    localBase,
    lanBase,
    autoOpenAi: `${localBase}/gateway/auto/openai/v1`,
    autoClaude: `${localBase}/gateway/auto/claude`,
    autoOpenCode: `${localBase}/gateway/auto/opencode/v1`,
    lanAutoOpenAi: lanBase ? `${lanBase}/gateway/auto/openai/v1` : null,
    lanAutoClaude: lanBase ? `${lanBase}/gateway/auto/claude` : null,
    lanAutoOpenCode: lanBase ? `${lanBase}/gateway/auto/opencode/v1` : null,
    publicOpenAi: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/auto/openai/v1` : null,
    publicClaude: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/auto/claude` : null,
    publicOpenCode: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/gateway/auto/opencode/v1` : null,
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

async function proxyGatewayRequest(req, res, url) {
  const route = parseGatewayRoute(url.pathname);
  if (!route) return sendJson(res, core.openAiGatewayError("not_found", "Unknown gateway route."), 404);
  if (req.method === "OPTIONS") {
    res.writeHead(204, gatewayCorsHeaders(req));
    return res.end();
  }
  if (isAggregatedModelListRequest(req, route)) {
    return sendAggregatedModelList(req, res);
  }
  const startedAt = Date.now();
  let body;
  try {
    body = ["GET", "HEAD"].includes(req.method) ? undefined : await readRequestBody(req, GATEWAY_MAX_BODY_BYTES);
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, error.status || 400, startedAt, null, error.message)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("invalid_request", error.message), error.status || 400);
  }
  const parsedBody = parseRequestJsonBody(body);
  const requestedModel = String(parsedBody?.model || "").trim();
  const manager = await resolveGatewayManager(route.engine, route.protocol, requestedModel);
  if (!manager) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 503, startedAt, body, "No matching manager is available.")).catch(() => {});
    return sendJson(res, core.openAiGatewayError("manager_unavailable", "No matching manager is available."), 503);
  }
  if (!(await isManagerPortListening(manager.port))) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, 503, Date.now(), null, `${manager.name} is not listening on port ${manager.port}.`)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("manager_offline", `${manager.name} is not listening on port ${manager.port}.`), 503);
  }
  const targetPath = buildManagerGatewayPath(route);
  if (!targetPath) return sendJson(res, core.openAiGatewayError("protocol_not_supported", `${manager.name} does not support ${route.protocol}.`), 404);
  const target = new URL(`http://127.0.0.1:${manager.port}${targetPath}`);
  target.search = url.search;
  const upstreamControl = createUpstreamControl(req, res);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildProxyHeaders(req.headers, req),
      body,
      signal: upstreamControl.signal,
    });
    res.writeHead(upstream.status, buildResponseHeaders(upstream.headers, req));
    res.once("finish", () => {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, upstream.status, startedAt, body, "")).catch(() => {});
    });
    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body);
      stream.once("end", upstreamControl.clear);
      stream.once("error", upstreamControl.clear);
      stream.pipe(res);
    } else {
      upstreamControl.clear();
      res.end();
    }
    console.log(`gateway ${route.engine}/${route.protocol} -> ${manager.id} ${upstream.status} ${Date.now() - startedAt}ms ${targetPath}`);
  } catch (error) {
    upstreamControl.clear();
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, error.status || 502, startedAt, body, error.message)).catch(() => {});
    if (!res.headersSent) {
      sendJson(res, core.openAiGatewayError("gateway_proxy_error", error.message), error.status || (error.name === "TimeoutError" ? 504 : 502));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function isAggregatedModelListRequest(req, route) {
  if (req.method !== "GET" || route.engine !== "auto" || route.protocol !== "openai") return false;
  return buildManagerGatewayPath(route).replace(/\/$/, "") === "/serve/v1/models";
}

async function sendAggregatedModelList(req, res) {
  const catalogs = await Promise.all(MANAGERS.map((manager) => getManagerModelCatalog(manager)));
  const data = mergeManagerModelCatalogs(catalogs);
  if (!data.length) {
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
      data.push({
        ...model,
        id,
        object: model.object || "model",
        owned_by: model.owned_by || catalog.manager.id,
        manager_engine: catalog.manager.id,
      });
    }
  }
  return data;
}

function buildEntryGatewayAccessEntry(req, route, manager, status, startedAt, body, error) {
  const parsedBody = parseRequestJsonBody(body);
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
    resolvedModel: "",
    stream: parsedBody?.stream === true,
    authSource: core.serviceApiKeySource(req.headers || {}),
    clientId: "",
    userAgent: headerValue(headers, "user-agent"),
    origin: headerValue(headers, "origin"),
    refererHost: headerHost(headers, "referer"),
    durationMs: Date.now() - startedAt,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolSchemaCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolUseCount: 0,
    error: String(error || "").slice(0, 240),
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

function parseRequestJsonBody(body) {
  if (!body || !Buffer.isBuffer(body)) return null;
  const text = body.toString("utf8", 0, Math.min(body.length, 1024 * 1024));
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
  const catalogs = await Promise.all(MANAGERS.map((manager) => getManagerModelCatalog(manager)));
  return selectGatewayManager(catalogs, requestedModel) || findManager("vllm");
}

function selectGatewayManager(catalogs = [], requestedModel = "") {
  const value = String(requestedModel || "").trim().toLowerCase();
  if (value && !["auto", "current", "default", "local-current"].includes(value)) {
    const exact = catalogs.find((catalog) => catalog.modelIds.has(value) || catalog.aliases.has(value));
    if (exact) return exact.manager;
  }
  return catalogs.find((catalog) => catalog.running && catalog.models.length)?.manager
    || catalogs.find((catalog) => catalog.listening)?.manager
    || null;
}

async function getManagerModelCatalog(manager, options = {}) {
  const now = Date.now();
  const cached = managerModelCache.get(manager.id);
  if (!options.force && cached?.value && cached.expiresAt > now) return cached.value;
  if (!options.force && cached?.promise) return cached.promise;
  const promise = (async () => {
    const listening = await core.isPortListening("127.0.0.1", manager.port);
    if (!listening) return emptyManagerCatalog(manager, false);
    const runtime = await fetchJson(`http://127.0.0.1:${manager.port}/api/running-models`, 5000);
    const data = runtime.data || {};
    const rawModels = Array.isArray(data.servedModels) && data.servedModels.length
      ? data.servedModels
      : Array.isArray(data.models) ? data.models : [];
    const models = rawModels
      .map((model) => typeof model === "string" ? { id: model, object: "model" } : model)
      .filter((model) => String(model?.id || "").trim());
    const modelIds = new Set(models.map((model) => String(model.id).toLowerCase()));
    const aliases = new Set(core.buildOpenAiGatewayAliasList({ models, runtime: data }).map((alias) => alias.toLowerCase()));
    return {
      manager,
      listening,
      running: Boolean(data.container?.running && models.length),
      models,
      modelIds,
      aliases,
      error: runtime.error || "",
    };
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

function emptyManagerCatalog(manager, listening, error = "") {
  return { manager, listening, running: false, models: [], modelIds: new Set(), aliases: new Set(), error };
}

function buildManagerGatewayPath(route) {
  const rest = route.rest.replace(/^\/+/, "");
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

function buildProxyHeaders(headers, req = null) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "upgrade"].includes(lower)) continue;
    output[key] = value;
  }
  output["x-service-entry-gateway"] = "1";
  if (req?.socket?.remoteAddress) {
    output["x-forwarded-for"] = headers["x-forwarded-for"]
      ? `${headers["x-forwarded-for"]}, ${req.socket.remoteAddress}`
      : req.socket.remoteAddress;
  }
  return output;
}

function buildResponseHeaders(headers, req) {
  const output = gatewayCorsHeaders(req);
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "transfer-encoding", "content-encoding"].includes(lower)) continue;
    output[key] = value;
  }
  output["cache-control"] = output["cache-control"] || "no-store";
  return output;
}

function gatewayCorsHeaders(req) {
  const origin = String(req.headers.origin || "");
  const allowedOrigin = !origin || !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)
    ? origin || (ALLOWED_ORIGINS.includes("*") ? "*" : "")
    : "";
  return {
    ...(allowedOrigin ? { "access-control-allow-origin": allowedOrigin } : {}),
    ...(origin ? { vary: "Origin" } : {}),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-api-key,api-key",
  };
}

function createUpstreamControl(req, res) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(process.env.SERVICE_ENTRY_GATEWAY_TIMEOUT_MS || 30 * 60 * 1000));
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

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large for service-entry gateway.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
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
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function shutdownSoon() {
  setTimeout(() => {
    if (server) {
      server.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  }, 100);
}

module.exports = {
  MANAGERS,
  buildEntryGatewayAccessEntry,
  buildEntryGatewayUrls,
  buildManagerGatewayPath,
  buildManagerGatewayUrls,
  buildProxyHeaders,
  collectEntryGatewayAccessStats,
  createUpstreamControl,
  createServiceEntryServer,
  emptyManagerCatalog,
  findManager,
  getManagerModelCatalog,
  handleRequest,
  isAggregatedModelListRequest,
  mergeManagerModelCatalogs,
  parseGatewayRoute,
  resolveGatewayManager,
  selectGatewayManager,
  sendAggregatedModelList,
  startServiceEntry,
};
