const fsp = require("node:fs/promises");
const path = require("node:path");
const { isExternalAddress, normalizeRemoteAddress } = require("./network");
const accessLogQueues = new Map();

function normalizeAccessEvent(entry = {}, lanAddress = "") {
  const remoteAddress = normalizeRemoteAddress(entry.remoteAddress);
  const status = Number(entry.status || 0);
  const inputTokens = Number(entry.inputTokens || 0);
  const outputTokens = Number(entry.outputTokens || 0);
  const totalTokens = Number(entry.totalTokens || inputTokens + outputTokens);
  const atMs = Date.parse(entry.at || "");
  const userAgent = truncateAccessMeta(entry.userAgent || entry.user_agent || "");
  const origin = truncateAccessMeta(entry.origin || "");
  const refererHost = normalizeAccessHost(entry.refererHost || entry.referer || entry.referrer || "");
  const normalized = {
    at: entry.at || null,
    atMs: Number.isFinite(atMs) ? atMs : 0,
    remoteAddress,
    external: isExternalAddress(remoteAddress, lanAddress),
    method: String(entry.method || "").toUpperCase(),
    path: String(entry.path || ""),
    kind: String(entry.kind || ""),
    status,
    ok: status >= 200 && status < 400,
    statusFamily: status ? `${Math.floor(status / 100)}xx` : "unknown",
    model: String(entry.model || ""),
    resolvedModel: String(entry.resolvedModel || ""),
    stream: Boolean(entry.stream),
    authSource: String(entry.authSource || ""),
    clientId: String(entry.clientId || ""),
    userAgent,
    origin,
    refererHost,
    durationMs: Number(entry.durationMs || 0),
    queuedMs: Number(entry.queuedMs || 0),
    inputTokens,
    outputTokens,
    totalTokens,
    stopReason: String(entry.stopReason || ""),
    toolSchemaCount: Number(entry.toolSchemaCount || 0),
    toolUseCount: Number(entry.toolUseCount || 0),
    error: String(entry.error || ""),
  };
  normalized.sourceProgram = inferAccessSourceProgram({
    ...entry,
    ...normalized,
  });
  return normalized;
}

function summarizeAccessEvents(events, now = Date.now()) {
  const total = events.length;
  const success = events.filter((entry) => entry.ok).length;
  const error = total - success;
  const durations = events.map((entry) => Number(entry.durationMs || 0)).filter((value) => value >= 0).sort((a, b) => a - b);
  const tokens = events.reduce((acc, entry) => {
    acc.input += Number(entry.inputTokens || 0);
    acc.output += Number(entry.outputTokens || 0);
    acc.total += Number(entry.totalTokens || 0);
    return acc;
  }, { input: 0, output: 0, total: 0 });
  return {
    requests: {
      total,
      success,
      error,
      errorRate: total ? error / total : 0,
      streamed: events.filter((entry) => entry.stream).length,
      authFailures: events.filter((entry) => entry.status === 401 || entry.status === 403).length,
      rateLimited: events.filter((entry) => entry.status === 429).length,
      clientErrors: events.filter((entry) => entry.status >= 400 && entry.status < 500).length,
      serverErrors: events.filter((entry) => entry.status >= 500).length,
    },
    tokens,
    clients: {
      unique: new Set(events.map((entry) => entry.remoteAddress).filter(Boolean)).size,
    },
    latency: {
      avgMs: total ? events.reduce((sum, entry) => sum + Number(entry.durationMs || 0), 0) / total : 0,
      avgQueuedMs: total ? events.reduce((sum, entry) => sum + Number(entry.queuedMs || 0), 0) / total : 0,
      queuedRequests: events.filter((entry) => Number(entry.queuedMs || 0) > 0).length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.at(-1) || 0,
    },
    windows: {
      m5: summarizeAccessWindow(events, now, 5 * 60 * 1000),
      m15: summarizeAccessWindow(events, now, 15 * 60 * 1000),
      h1: summarizeAccessWindow(events, now, 60 * 60 * 1000),
      h24: summarizeAccessWindow(events, now, 24 * 60 * 60 * 1000),
    },
    firstAt: events[0]?.at || null,
    lastAt: events.at(-1)?.at || null,
  };
}

function summarizeAccessWindow(events, now, windowMs) {
  const start = now - windowMs;
  const scoped = events.filter((entry) => entry.atMs >= start);
  const total = scoped.length;
  const success = scoped.filter((entry) => entry.ok).length;
  const error = total - success;
  const totalTokens = scoped.reduce((sum, entry) => sum + Number(entry.totalTokens || 0), 0);
  return {
    total,
    success,
    error,
    errorRate: total ? error / total : 0,
    uniqueClients: new Set(scoped.map((entry) => entry.remoteAddress).filter(Boolean)).size,
    requestsPerMinute: total / Math.max(1, windowMs / 60000),
    totalTokens,
  };
}

function groupAccessEvents(events, keyFn, options = {}) {
  const groups = new Map();
  for (const entry of events) {
    const key = String(keyFn(entry) || "-");
    const item = groups.get(key) || {
      key,
      label: key,
      count: 0,
      success: 0,
      error: 0,
      streamed: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      firstAt: entry.at,
      lastAt: entry.at,
      statuses: {},
      methods: {},
      kinds: {},
      paths: {},
      models: {},
      authSources: {},
      remoteAddresses: {},
      sourcePrograms: {},
      userAgents: {},
      origins: {},
      refererHosts: {},
    };
    item.count += 1;
    if (entry.ok) item.success += 1;
    else item.error += 1;
    if (entry.stream) item.streamed += 1;
    item.totalTokens += Number(entry.totalTokens || 0);
    item.inputTokens += Number(entry.inputTokens || 0);
    item.outputTokens += Number(entry.outputTokens || 0);
    item.totalDurationMs += Number(entry.durationMs || 0);
    item.maxDurationMs = Math.max(item.maxDurationMs, Number(entry.durationMs || 0));
    item.firstAt = !item.firstAt || entry.atMs < Date.parse(item.firstAt) ? entry.at : item.firstAt;
    item.lastAt = !item.lastAt || entry.atMs > Date.parse(item.lastAt) ? entry.at : item.lastAt;
    incrementCounter(item.statuses, String(entry.status || 0));
    incrementCounter(item.methods, entry.method || "-");
    incrementCounter(item.kinds, entry.kind || "-");
    incrementCounter(item.paths, entry.path || "-");
    incrementCounter(item.models, entry.model || entry.resolvedModel || "-");
    incrementCounter(item.authSources, entry.authSource || "none");
    incrementCounter(item.remoteAddresses, entry.remoteAddress || "-");
    incrementCounter(item.sourcePrograms, entry.sourceProgram || "unknown");
    incrementCounter(item.userAgents, entry.userAgent || "none");
    incrementCounter(item.origins, entry.origin || "none");
    incrementCounter(item.refererHosts, entry.refererHost || "none");
    groups.set(key, item);
  }
  return Array.from(groups.values())
    .map((item) => ({
      ...item,
      avgDurationMs: item.count ? item.totalDurationMs / item.count : 0,
      errorRate: item.count ? item.error / item.count : 0,
      topStatus: topCounterEntry(item.statuses),
      topPath: topCounterEntry(item.paths),
      topModel: topCounterEntry(item.models),
      topAuthSource: topCounterEntry(item.authSources),
      topRemoteAddress: topCounterEntry(item.remoteAddresses),
      topSourceProgram: topCounterEntry(item.sourcePrograms),
      topUserAgent: topCounterEntry(item.userAgents),
      topOrigin: topCounterEntry(item.origins),
      topRefererHost: topCounterEntry(item.refererHosts),
    }))
    .sort((a, b) => b.count - a.count || String(b.lastAt || "").localeCompare(String(a.lastAt || "")))
    .slice(0, Number(options.limit || 30));
}

function truncateAccessMeta(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeAccessHost(value) {
  const text = truncateAccessMeta(value);
  if (!text) return "";
  try {
    return new URL(text).host || text;
  } catch {
    return text.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].slice(0, 160);
  }
}

function inferAccessSourceProgram(entry = {}) {
  const explicit = truncateAccessMeta(entry.sourceProgram || "");
  if (explicit) return explicit;
  const userAgent = truncateAccessMeta(entry.userAgent || "");
  const ua = userAgent.toLowerCase();
  const pathValue = String(entry.path || "").toLowerCase();
  const kind = String(entry.kind || "").toLowerCase();
  if (/workbuddy/.test(ua)) return "WorkBuddy";
  if (/open[-_\s]?webui/.test(ua)) return "OpenWebUI";
  if (/chatbox/.test(ua)) return "Chatbox";
  if (/lobe[-_\s]?chat|lobehub/.test(ua)) return "LobeChat";
  if (/claude/.test(ua) || kind === "claude" || pathValue.startsWith("/claude") || pathValue.includes("/claude/")) return "Claude 兼容客户端";
  if (/opencode/.test(ua) || kind === "opencode" || pathValue.includes("/opencode")) return "OpenCode";
  if (/openai[-_\s]?python/.test(ua)) return "OpenAI Python SDK";
  if (/openai[-_\s]?(node|js)|openai\/js/.test(ua)) return "OpenAI Node SDK";
  if (/python-requests|httpx|aiohttp|python\//.test(ua)) return "Python 客户端";
  if (/curl\//.test(ua)) return "curl";
  if (/powershell|microsoft powershell/.test(ua)) return "PowerShell";
  if (/node\.js|node-fetch|undici|axios/.test(ua)) return "Node.js 客户端";
  if (/go-http-client/.test(ua)) return "Go 客户端";
  if (/okhttp|java\//.test(ua)) return "Java/OkHttp 客户端";
  const originHost = normalizeAccessHost(entry.origin || entry.refererHost || "");
  if (originHost) return `浏览器 · ${originHost}`;
  if (/mozilla|chrome|safari|edg\//.test(ua)) return "浏览器客户端";
  if (kind === "openai" || pathValue.includes("/serve/v1") || pathValue.includes("/openai/")) return "OpenAI 兼容客户端";
  return "未知来源";
}

function incrementCounter(counter, key) {
  counter[key] = Number(counter[key] || 0) + 1;
}

function topCounterEntry(counter = {}) {
  return Object.entries(counter).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || ["-", 0];
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index] || 0;
}

async function appendAccessLog(file, entry, options = {}) {
  const key = path.resolve(file);
  const previous = accessLogQueues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await rotateAccessLogIfNeeded(file, options);
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  });
  accessLogQueues.set(key, task);
  try {
    await task;
  } finally {
    if (accessLogQueues.get(key) === task) accessLogQueues.delete(key);
  }
}

async function readAccessLogEvents(file, maxLines = 12000, parseJsonSafe = parseJsonLine) {
  try {
    const text = await readFileTail(file, Math.max(1024 * 1024, Math.min(32 * 1024 * 1024, maxLines * 1024)));
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

async function readRotatedAccessLogEvents(file, maxLines = 12000, parseJsonSafe = parseJsonLine, maxFiles = 5) {
  const limit = Math.min(100000, Math.max(1, Number(maxLines || 12000)));
  const rotatedFiles = Math.min(20, Math.max(0, Number(maxFiles || 5)));
  const events = [];
  for (let index = 0; index <= rotatedFiles && events.length < limit; index += 1) {
    const candidate = index === 0 ? file : `${file}.${index}`;
    const remaining = limit - events.length;
    const rows = await readAccessLogEvents(candidate, remaining, parseJsonSafe);
    events.push(...rows);
  }
  return events.slice(0, limit);
}

async function rotateAccessLogIfNeeded(file, options = {}) {
  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes || process.env.MODEL_GATEWAY_LOG_MAX_BYTES || 32 * 1024 * 1024));
  const maxFiles = Math.min(20, Math.max(1, Number(options.maxFiles || process.env.MODEL_GATEWAY_LOG_MAX_FILES || 5)));
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (stat.size < maxBytes) return false;
  await fsp.rm(`${file}.${maxFiles}`, { force: true }).catch(() => {});
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    await fsp.rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => {});
  }
  await fsp.rename(file, `${file}.1`);
  return true;
}

async function readFileTail(file, maxBytes = 8 * 1024 * 1024) {
  const stat = await fsp.stat(file);
  const length = Math.min(stat.size, Math.max(1, Number(maxBytes) || 1));
  const start = Math.max(0, stat.size - length);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstLineBreak = text.indexOf("\n");
      text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

function parseJsonLine(line, fallback = null) {
  try {
    return JSON.parse(line);
  } catch {
    return fallback;
  }
}

function normalizeAccessLogQuery(query = {}) {
  const limit = Math.min(5000, Math.max(1, Number(query.limit || 200)));
  const maxLines = Math.min(100000, Math.max(limit, Number(query.maxLines || 50000)));
  const parseTime = (value) => {
    const time = Date.parse(String(value || ""));
    return Number.isFinite(time) ? time : null;
  };
  return {
    keyword: String(query.keyword || query.q || "").trim().toLowerCase().slice(0, 240),
    fromMs: query.fromMs !== undefined ? query.fromMs : parseTime(query.from || query.startAt),
    toMs: query.toMs !== undefined ? query.toMs : parseTime(query.to || query.endAt),
    status: String(query.status || "").trim().toLowerCase(),
    kind: String(query.kind || "").trim().toLowerCase(),
    source: String(query.source || query.sourceProgram || "").trim().toLowerCase(),
    clientId: String(query.clientId || "").trim().toLowerCase(),
    external: String(query.external || "").trim().toLowerCase(),
    limit,
    maxLines,
  };
}

function accessEventMatchesQuery(event, query = {}) {
  if (query.fromMs !== null && event.atMs < query.fromMs) return false;
  if (query.toMs !== null && event.atMs > query.toMs) return false;
  if (query.kind && String(event.kind || "").toLowerCase() !== query.kind) return false;
  if (query.source && !String(event.sourceProgram || "").toLowerCase().includes(query.source)) return false;
  if (query.clientId && !String(event.clientId || "").toLowerCase().includes(query.clientId)) return false;
  if (["true", "external", "1"].includes(query.external) && !event.external) return false;
  if (["false", "local", "0"].includes(query.external) && event.external) return false;
  if (query.status) {
    const statuses = query.status.split(",").map((item) => item.trim()).filter(Boolean);
    if (!statuses.some((status) => status === String(event.status) || status === event.statusFamily)) return false;
  }
  if (!query.keyword) return true;
  return [
    event.at, event.remoteAddress, event.method, event.path, event.kind, event.status, event.model,
    event.resolvedModel, event.authSource, event.clientId, event.sourceProgram, event.userAgent,
    event.origin, event.refererHost, event.error,
  ].join(" ").toLowerCase().includes(query.keyword);
}

function queryAccessLogEvents(events, query = {}, lanAddress = "") {
  const filters = normalizeAccessLogQuery(query);
  const matched = (Array.isArray(events) ? events : [])
    .map((entry) => entry?.atMs !== undefined ? entry : normalizeAccessEvent(entry, lanAddress))
    .filter((entry) => entry.atMs > 0)
    .filter((entry) => accessEventMatchesQuery(entry, filters))
    .sort((a, b) => b.atMs - a.atMs);
  return {
    ok: true,
    filters: {
      keyword: filters.keyword,
      from: filters.fromMs === null ? "" : new Date(filters.fromMs).toISOString(),
      to: filters.toMs === null ? "" : new Date(filters.toMs).toISOString(),
      status: filters.status,
      kind: filters.kind,
      source: filters.source,
      clientId: filters.clientId,
      external: filters.external,
    },
    total: matched.length,
    returned: Math.min(filters.limit, matched.length),
    maxLines: filters.maxLines,
    events: matched.slice(0, filters.limit),
  };
}

function accessLogCsvCell(value) {
  let text = String(value ?? "");
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const ACCESS_LOG_EXPORT_FIELDS = [
  "at", "remoteAddress", "external", "sourceProgram", "clientId", "method", "path", "kind", "status",
  "model", "resolvedModel", "stream", "authSource", "durationMs", "queuedMs", "inputTokens", "outputTokens",
  "totalTokens", "stopReason", "toolSchemaCount", "toolUseCount", "userAgent", "origin", "refererHost", "error",
];

function formatAccessLogExport(events, format = "csv") {
  const normalizedFormat = String(format || "csv").toLowerCase() === "jsonl" ? "jsonl" : "csv";
  if (normalizedFormat === "jsonl") {
    return {
      format: normalizedFormat,
      contentType: "application/x-ndjson; charset=utf-8",
      extension: "jsonl",
      text: events.map((entry) => JSON.stringify(entry)).join("\n") + (events.length ? "\n" : ""),
    };
  }
  const rows = [ACCESS_LOG_EXPORT_FIELDS.map(accessLogCsvCell).join(",")];
  for (const event of events) rows.push(ACCESS_LOG_EXPORT_FIELDS.map((field) => accessLogCsvCell(event[field])).join(","));
  return {
    format: normalizedFormat,
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
    text: `\uFEFF${rows.join("\r\n")}\r\n`,
  };
}

function buildAccessTimeline(events, now = Date.now(), options = {}) {
  const bucketMs = Number(options.bucketMs || 5 * 60 * 1000);
  const windowMs = Number(options.windowMs || 2 * 60 * 60 * 1000);
  const start = now - windowMs;
  const buckets = new Map();
  for (let time = Math.floor(start / bucketMs) * bucketMs; time <= now; time += bucketMs) {
    buckets.set(time, {
      at: new Date(time).toISOString(),
      total: 0,
      success: 0,
      error: 0,
      totalTokens: 0,
      avgDurationMs: 0,
      durationTotalMs: 0,
    });
  }
  for (const entry of events) {
    if (entry.atMs < start) continue;
    const key = Math.floor(entry.atMs / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    if (entry.ok) bucket.success += 1;
    else bucket.error += 1;
    bucket.totalTokens += Number(entry.totalTokens || 0);
    bucket.durationTotalMs += Number(entry.durationMs || 0);
  }
  return Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    avgDurationMs: bucket.total ? bucket.durationTotalMs / bucket.total : 0,
  }));
}

function buildExternalAccessStats(input = {}) {
  const limit = Math.min(500, Math.max(20, Number(input.limit || 160)));
  const maxLines = Math.min(50000, Math.max(limit, Number(input.maxLines || 12000)));
  const now = Number(input.now || Date.now());
  const lanAddress = String(input.lanAddress || "");
  const host = String(input.host || "127.0.0.1");
  const port = Number(input.port || 0);
  const settings = input.settings || {};
  const container = input.container || {};
  const endpoint = input.endpoint || {};
  const events = Array.isArray(input.events) ? input.events : [];
  const normalized = events
    .map((entry) => normalizeAccessEvent(entry, lanAddress))
    .filter((entry) => entry.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
  const external = normalized.filter((entry) => entry.external);
  const local = normalized.filter((entry) => !entry.external);
  const managerLanBaseUrl = host === "127.0.0.1" ? null : `http://${lanAddress}:${port}`;
  const claudeBasePath = String(input.claudeBasePath || "/claude").replace(/\/$/, "") || "/claude";
  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    logPath: input.logPath || "",
    maxLines,
    privacy: input.privacy || "只记录访问元数据：时间、来源 IP、路径、状态、模型名、认证头类型、延迟和 token 计数；不记录提示词或响应正文。",
    service: {
      managerLanBaseUrl,
      claudeBaseUrl: managerLanBaseUrl ? `${managerLanBaseUrl}${claudeBasePath}` : null,
      openAiGatewayBaseUrl: managerLanBaseUrl ? `${managerLanBaseUrl}/serve/v1` : null,
      openAiContainerBaseUrl: endpoint.lanUrl || null,
      exposureMode: settings.exposureMode,
      requireApiKey: Boolean(settings.requireApiKey),
      rateLimitRpm: Number(settings.rateLimitRpm || 0),
      maxConcurrentRequests: Number(settings.maxConcurrentRequests || 0),
      maxQueuedRequests: Number(settings.maxQueuedRequests || 0),
      queueTimeoutSeconds: Number(settings.queueTimeoutSeconds || 0),
      running: Boolean(container.running),
      containerStatus: container.status || "",
      lanAddress,
    },
    totals: summarizeAccessEvents(normalized, now),
    external: summarizeAccessEvents(external, now),
    local: summarizeAccessEvents(local, now),
    clients: groupAccessEvents(external, (entry) => entry.remoteAddress || "unknown", { limit: 40 }),
    paths: groupAccessEvents(normalized, (entry) => entry.path || "-", { limit: 30 }),
    models: groupAccessEvents(normalized.filter((entry) => entry.model || entry.resolvedModel), (entry) => entry.model || entry.resolvedModel || "-", { limit: 30 }),
    resolvedModels: groupAccessEvents(normalized.filter((entry) => entry.resolvedModel), (entry) => entry.resolvedModel || "-", { limit: 20 }),
    authSources: groupAccessEvents(normalized, (entry) => entry.authSource || "none", { limit: 20 }),
    kinds: groupAccessEvents(normalized, (entry) => entry.kind || "-", { limit: 10 }),
    statuses: groupAccessEvents(normalized, (entry) => String(entry.status || 0), { limit: 20 }),
    timeline: buildAccessTimeline(external, now),
    recent: normalized.slice(-limit).reverse(),
  };
}

function buildRecentAccessStats(input = {}) {
  const limit = Math.min(100, Math.max(5, Number(input.limit || 30)));
  const maxLines = Math.min(50000, Math.max(limit, Number(input.maxLines || 5000)));
  const now = Number(input.now || Date.now());
  const windowMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(input.windowMs || 60 * 60 * 1000)));
  const lanAddress = String(input.lanAddress || "");
  const events = Array.isArray(input.events) ? input.events : [];
  const normalized = events
    .map((entry) => normalizeAccessEvent(entry, lanAddress))
    .filter((entry) => entry.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
  const startMs = now - windowMs;
  const scoped = normalized.filter((entry) => entry.atMs >= startMs && entry.atMs <= now);
  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    windowMs,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(now).toISOString(),
    maxLines,
    privacy: input.privacy || "最近调用来源只统计网关访问元数据，不记录提示词或响应正文。",
    totals: summarizeAccessEvents(scoped, now),
    sources: groupAccessEvents(scoped, (entry) => entry.sourceProgram || "未知来源", { limit }),
    paths: groupAccessEvents(scoped, (entry) => entry.path || "-", { limit: Math.min(limit, 20) }),
    models: groupAccessEvents(scoped.filter((entry) => entry.model || entry.resolvedModel), (entry) => entry.model || entry.resolvedModel || "-", { limit: Math.min(limit, 20) }),
    recent: scoped.slice(-limit).reverse(),
  };
}

function createServiceGatewayAccessLogStore(options = {}) {
  const file = options.file;
  const parseJsonSafe = options.parseJsonSafe || parseJsonLine;

  async function appendServiceGatewayAccessLog(entry) {
    return appendAccessLog(file, entry);
  }

  async function readServiceGatewayAccessEvents(maxLines = 12000) {
    return readRotatedAccessLogEvents(
      file,
      maxLines,
      parseJsonSafe,
      Number(options.maxFiles || process.env.MODEL_GATEWAY_LOG_MAX_FILES || 5),
    );
  }

  async function collectExternalAccessStats(query = {}) {
    const limit = Math.min(500, Math.max(20, Number(query.limit || 160)));
    const maxLines = Math.min(50000, Math.max(limit, Number(query.maxLines || 12000)));
    const lanAddress = options.getLanAddress ? options.getLanAddress() : "";
    const [settings, container, events] = await Promise.all([
      Promise.resolve()
        .then(() => options.getServiceExposureSettings?.())
        .catch(() => options.normalizeServiceExposureSettings?.({}) || {}),
      Promise.resolve()
        .then(() => options.getContainerStatus?.())
        .catch(() => ({ running: false })),
      readServiceGatewayAccessEvents(maxLines),
    ]);
    const endpoint = options.getContainerEndpoint ? options.getContainerEndpoint(container) : {};
    return buildExternalAccessStats({
      limit,
      maxLines,
      now: Date.now(),
      logPath: file,
      host: options.host,
      port: options.port,
      lanAddress,
      settings,
      container,
      endpoint,
      events,
      claudeBasePath: options.claudeBasePath,
      privacy: options.privacy,
    });
  }

  async function collectRecentAccessStats(query = {}) {
    const limit = Math.min(100, Math.max(5, Number(query.limit || 30)));
    const maxLines = Math.min(50000, Math.max(limit, Number(query.maxLines || 5000)));
    const windowMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, Number(query.windowMs || 60 * 60 * 1000)));
    const lanAddress = options.getLanAddress ? options.getLanAddress() : "";
    const events = await readServiceGatewayAccessEvents(maxLines);
    return buildRecentAccessStats({
      limit,
      maxLines,
      windowMs,
      now: Number(query.now || Date.now()),
      lanAddress,
      events,
    });
  }

  async function searchServiceGatewayAccessLogs(query = {}) {
    const filters = normalizeAccessLogQuery(query);
    const events = await readServiceGatewayAccessEvents(filters.maxLines);
    const lanAddress = options.getLanAddress ? options.getLanAddress() : "";
    return queryAccessLogEvents(events, filters, lanAddress);
  }

  async function exportServiceGatewayAccessLogs(query = {}) {
    const maxLines = Math.min(100000, Math.max(1, Number(query.maxLines || query.limit || 100000)));
    const filters = normalizeAccessLogQuery({ ...query, maxLines, limit: 5000 });
    const lanAddress = options.getLanAddress ? options.getLanAddress() : "";
    const events = await readServiceGatewayAccessEvents(maxLines);
    const matched = events
      .map((entry) => normalizeAccessEvent(entry, lanAddress))
      .filter((entry) => entry.atMs > 0 && accessEventMatchesQuery(entry, filters))
      .sort((a, b) => b.atMs - a.atMs);
    const output = formatAccessLogExport(matched, query.format);
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = String(options.exportPrefix || "model-gateway").replace(/[^a-z0-9_-]+/gi, "-");
    return {
      ...output,
      count: matched.length,
      filename: `${prefix}-access-${date}.${output.extension}`,
    };
  }

  return {
    appendServiceGatewayAccessLog,
    readServiceGatewayAccessEvents,
    collectExternalAccessStats,
    collectRecentAccessStats,
    searchServiceGatewayAccessLogs,
    exportServiceGatewayAccessLogs,
    normalizeServiceGatewayAccessEvent: normalizeAccessEvent,
    summarizeAccessEvents,
    groupAccessEvents,
    buildAccessTimeline,
  };
}

module.exports = {
  normalizeAccessEvent,
  normalizeServiceGatewayAccessEvent: normalizeAccessEvent,
  inferAccessSourceProgram,
  summarizeAccessEvents,
  summarizeAccessWindow,
  groupAccessEvents,
  percentile,
  appendAccessLog,
  readFileTail,
  readAccessLogEvents,
  readRotatedAccessLogEvents,
  rotateAccessLogIfNeeded,
  buildAccessTimeline,
  buildExternalAccessStats,
  buildRecentAccessStats,
  normalizeAccessLogQuery,
  accessEventMatchesQuery,
  queryAccessLogEvents,
  formatAccessLogExport,
  createServiceGatewayAccessLogStore,
};
