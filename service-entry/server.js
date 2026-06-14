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

function createServiceEntryServer() {
  return http.createServer(handleRequest);
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveFile(res, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
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

async function buildManagerStatus(manager) {
  const baseUrl = `http://127.0.0.1:${manager.port}`;
  const pidFile = path.join(manager.root, ".manager.pid");
  const pid = await core.readPidFilePid(pidFile);
  const [portListening, health, exposure, clients, externalAccess] = await Promise.all([
    core.isPortListening("127.0.0.1", manager.port),
    fetchJson(`${baseUrl}/api/manager/health`),
    fetchJson(`${baseUrl}/api/service-exposure`),
    fetchJson(`${baseUrl}/api/service-clients`),
    fetchJson(`${baseUrl}/api/external-access?limit=20`),
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
    exposure: exposure.data || null,
    clients: clients.data || null,
    externalAccess: externalAccess.data || null,
    error: health.error || exposure.error || clients.error || externalAccess.error || "",
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
  };
}

function buildManagerGatewayUrls(manager) {
  const localBase = `http://127.0.0.1:${PORT}`;
  const lanBase = HOST === "127.0.0.1" ? null : `http://${core.getLanAddress()}:${PORT}`;
  return {
    openAi: `${localBase}/gateway/${manager.id}/openai/v1`,
    claude: `${localBase}/gateway/${manager.id}/claude`,
    openCode: manager.id === "vllm" ? `${localBase}/gateway/${manager.id}/opencode/v1` : null,
    lanOpenAi: lanBase ? `${lanBase}/gateway/${manager.id}/openai/v1` : null,
    lanClaude: lanBase ? `${lanBase}/gateway/${manager.id}/claude` : null,
    lanOpenCode: lanBase && manager.id === "vllm" ? `${lanBase}/gateway/${manager.id}/opencode/v1` : null,
  };
}

async function proxyGatewayRequest(req, res, url) {
  const route = parseGatewayRoute(url.pathname);
  if (!route) return sendJson(res, core.openAiGatewayError("not_found", "Unknown gateway route."), 404);
  if (req.method === "OPTIONS") {
    res.writeHead(204, gatewayCorsHeaders(req));
    return res.end();
  }
  const manager = await resolveGatewayManager(route.engine, route.protocol);
  if (!manager) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, null, 503, Date.now(), null, "No matching manager is available.")).catch(() => {});
    return sendJson(res, core.openAiGatewayError("manager_unavailable", "No matching manager is available."), 503);
  }
  if (!(await core.isPortListening("127.0.0.1", manager.port))) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, 503, Date.now(), null, `${manager.name} is not listening on port ${manager.port}.`)).catch(() => {});
    return sendJson(res, core.openAiGatewayError("manager_offline", `${manager.name} is not listening on port ${manager.port}.`), 503);
  }
  const targetPath = buildManagerGatewayPath(route);
  if (!targetPath) return sendJson(res, core.openAiGatewayError("protocol_not_supported", `${manager.name} does not support ${route.protocol}.`), 404);
  const target = new URL(`http://127.0.0.1:${manager.port}${targetPath}`);
  target.search = url.search;
  const startedAt = Date.now();
  let body = null;
  try {
    body = ["GET", "HEAD"].includes(req.method) ? undefined : await readRequestBody(req, 64 * 1024 * 1024);
    const upstream = await fetch(target, {
      method: req.method,
      headers: buildProxyHeaders(req.headers, req),
      body,
      signal: AbortSignal.timeout(Number(process.env.SERVICE_ENTRY_GATEWAY_TIMEOUT_MS || 30 * 60 * 1000)),
    });
    res.writeHead(upstream.status, buildResponseHeaders(upstream.headers, req));
    res.once("finish", () => {
      appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, upstream.status, startedAt, body, "")).catch(() => {});
    });
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
    console.log(`gateway ${route.engine}/${route.protocol} -> ${manager.id} ${upstream.status} ${Date.now() - startedAt}ms ${targetPath}`);
  } catch (error) {
    appendEntryGatewayAccessLog(buildEntryGatewayAccessEntry(req, route, manager, error.status || 502, startedAt, body, error.message)).catch(() => {});
    if (!res.headersSent) {
      sendJson(res, core.openAiGatewayError("gateway_proxy_error", error.message), error.status || (error.name === "TimeoutError" ? 504 : 502));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function buildEntryGatewayAccessEntry(req, route, manager, status, startedAt, body, error) {
  const parsedBody = parseRequestJsonBody(body);
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
    durationMs: Date.now() - startedAt,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolSchemaCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolUseCount: 0,
    error: String(error || "").slice(0, 240),
  };
}

function parseRequestJsonBody(body) {
  if (!body || !Buffer.isBuffer(body)) return null;
  const text = body.toString("utf8", 0, Math.min(body.length, 1024 * 1024));
  const data = parseJsonSafe(text, null);
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

async function appendEntryGatewayAccessLog(entry) {
  await fs.mkdir(path.dirname(GATEWAY_ACCESS_LOG), { recursive: true });
  await fs.appendFile(GATEWAY_ACCESS_LOG, `${JSON.stringify(entry)}\n`, "utf8");
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
    recent: events.slice(-limit).reverse(),
  };
}

async function readEntryGatewayAccessEvents(maxLines = 12000) {
  try {
    const text = await fs.readFile(GATEWAY_ACCESS_LOG, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => parseJsonSafe(line, null))
      .filter((entry) => entry && typeof entry === "object");
  } catch {
    return [];
  }
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

async function resolveGatewayManager(engine, protocol) {
  if (protocol === "opencode") return findManager("vllm");
  if (engine !== "auto") return findManager(engine);
  const statuses = await Promise.all(MANAGERS.map(async (manager) => ({
    manager,
    listening: await core.isPortListening("127.0.0.1", manager.port),
    status: await fetchJson(`http://127.0.0.1:${manager.port}/api/status`),
  })));
  const running = statuses.find((item) => item.listening && item.status.data?.container?.running);
  if (running) return running.manager;
  const listening = statuses.find((item) => item.listening);
  return listening?.manager || findManager("vllm");
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
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key,anthropic-api-key,api-key",
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
    return { ok: true, alreadyRunning: true, status: await buildManagerStatus(manager) };
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
  return { ok: ready, pid: child.pid, ready, status: await buildManagerStatus(manager) };
}

async function stopManager(manager) {
  const baseUrl = `http://127.0.0.1:${manager.port}`;
  const stopped = await postJson(`${baseUrl}/api/manager/shutdown`);
  return { ok: stopped.ok, stopped, status: await buildManagerStatus(manager) };
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

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
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

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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
  createServiceEntryServer,
  findManager,
  handleRequest,
  parseGatewayRoute,
  startServiceEntry,
};
