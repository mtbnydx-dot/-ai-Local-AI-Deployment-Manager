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

module.exports = {
  normalizeAccessEvent,
  summarizeAccessEvents,
  summarizeAccessWindow,
  groupAccessEvents,
  percentile,
};
