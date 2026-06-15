const fsp = require("node:fs/promises");
const path = require("node:path");
const { isExternalAddress, normalizeRemoteAddress } = require("./network");

function normalizeAccessEvent(entry = {}, lanAddress = "") {
  const remoteAddress = normalizeRemoteAddress(entry.remoteAddress);
  const status = Number(entry.status || 0);
  const inputTokens = Number(entry.inputTokens || 0);
  const outputTokens = Number(entry.outputTokens || 0);
  const totalTokens = Number(entry.totalTokens || inputTokens + outputTokens);
  const atMs = Date.parse(entry.at || "");
  return {
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
    durationMs: Number(entry.durationMs || 0),
    inputTokens,
    outputTokens,
    totalTokens,
    stopReason: String(entry.stopReason || ""),
    toolSchemaCount: Number(entry.toolSchemaCount || 0),
    toolUseCount: Number(entry.toolUseCount || 0),
    error: String(entry.error || ""),
  };
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
    }))
    .sort((a, b) => b.count - a.count || String(b.lastAt || "").localeCompare(String(a.lastAt || "")))
    .slice(0, Number(options.limit || 30));
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

async function appendAccessLog(file, entry) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

async function readAccessLogEvents(file, maxLines = 12000, parseJsonSafe = parseJsonLine) {
  try {
    const text = await fsp.readFile(file, "utf8");
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

function parseJsonLine(line, fallback = null) {
  try {
    return JSON.parse(line);
  } catch {
    return fallback;
  }
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

function createServiceGatewayAccessLogStore(options = {}) {
  const file = options.file;
  const parseJsonSafe = options.parseJsonSafe || parseJsonLine;

  async function appendServiceGatewayAccessLog(entry) {
    return appendAccessLog(file, entry);
  }

  async function readServiceGatewayAccessEvents(maxLines = 12000) {
    return readAccessLogEvents(file, maxLines, parseJsonSafe);
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

  return {
    appendServiceGatewayAccessLog,
    readServiceGatewayAccessEvents,
    collectExternalAccessStats,
    normalizeServiceGatewayAccessEvent: normalizeAccessEvent,
    summarizeAccessEvents,
    groupAccessEvents,
    buildAccessTimeline,
  };
}

module.exports = {
  normalizeAccessEvent,
  normalizeServiceGatewayAccessEvent: normalizeAccessEvent,
  summarizeAccessEvents,
  summarizeAccessWindow,
  groupAccessEvents,
  percentile,
  appendAccessLog,
  readAccessLogEvents,
  buildAccessTimeline,
  buildExternalAccessStats,
  createServiceGatewayAccessLogStore,
};
