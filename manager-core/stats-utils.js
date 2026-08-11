const { weightedAverage } = require("./prometheus-utils");

function aggregateStats(models, uptimeSeconds) {
  const totalPrompt = models.reduce((sum, model) => sum + model.tokens.prompt, 0);
  const totalGeneration = models.reduce((sum, model) => sum + model.tokens.generation, 0);
  const totalCached = models.reduce((sum, model) => sum + model.tokens.cachedPrompt, 0);
  const totalRequests = models.reduce((sum, model) => sum + model.requests.total, 0);
  const totalErrors = models.reduce((sum, model) => sum + model.requests.error, 0);
  const totalAborted = models.reduce((sum, model) => sum + model.requests.aborted, 0);
  const totalTokens = totalPrompt + totalGeneration;
  const activeContext = models.reduce((sum, model) => sum + (model.context.activeTokens || 0), 0);
  const contextCapacity = models.reduce((sum, model) => sum + (model.context.capacityTokens || 0), 0) || null;

  return {
    tokens: {
      prompt: totalPrompt,
      generation: totalGeneration,
      cachedPrompt: totalCached,
      total: totalTokens,
    },
    requests: {
      total: totalRequests,
      success: Math.max(0, totalRequests - totalErrors - totalAborted),
      error: totalErrors,
      aborted: totalAborted,
    },
    speed: {
      recentPromptTokensPerSecond: models.reduce((sum, model) => sum + model.speed.recentPromptTokensPerSecond, 0),
      recentOutputTokensPerSecond: models.reduce((sum, model) => sum + model.speed.recentOutputTokensPerSecond, 0),
      recentRequestsPerMinute: models.reduce((sum, model) => sum + model.speed.recentRequestsPerMinute, 0),
      lifetimeTokensPerSecond: uptimeSeconds ? totalTokens / uptimeSeconds : 0,
    },
    latency: {
      avgE2eSeconds: weightedAverage(models, (model) => model.latency.avgE2eSeconds, (model) => model.requests.total),
      avgTtftSeconds: weightedAverage(models, (model) => model.latency.avgTtftSeconds, (model) => model.requests.total),
      avgTimePerOutputTokenSeconds: weightedAverage(models, (model) => model.latency.avgTimePerOutputTokenSeconds, (model) => model.requests.total),
    },
    context: {
      activeTokens: activeContext,
      capacityTokens: contextCapacity,
      kvUsagePercent: contextCapacity ? activeContext / contextCapacity : 0,
    },
  };
}

function emptyStatsSummary(container, endpoint, options = {}) {
  return {
    source: endpoint ? `http://127.0.0.1:${endpoint.port}/metrics` : null,
    processStartSeconds: null,
    uptimeSeconds: null,
    facts: {},
    totals: {
      tokens: { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
      requests: { total: 0, success: 0, error: 0, aborted: 0 },
      speed: {
        recentPromptTokensPerSecond: 0,
        recentOutputTokensPerSecond: 0,
        recentRequestsPerMinute: 0,
        lifetimeTokensPerSecond: 0,
      },
      latency: {},
      context: { activeTokens: 0, capacityTokens: null, kvUsagePercent: 0 },
      shares: {},
    },
    models: [],
    modelsByName: {},
    rawMetricCount: 0,
    note: container?.exists
      ? options.stoppedNote || "Managed runtime container is not running."
      : options.missingNote || "No managed runtime container is running.",
  };
}

function calculateRecentRates(samples, modelName, nowSeconds, counters, updateSamples) {
  const store = samples && typeof samples.get === "function" && typeof samples.set === "function"
    ? samples
    : null;
  const promptTokens = Number(counters?.promptTokens || 0);
  const generationTokens = Number(counters?.generationTokens || 0);
  const requestCount = Number(counters?.requestCount || 0);
  const previous = store?.get(modelName);
  const current = { time: nowSeconds, promptTokens, generationTokens, requestCount };
  if (store && updateSamples) store.set(modelName, current);
  if (!previous || nowSeconds <= previous.time) {
    return {
      recentPromptTokensPerSecond: 0,
      recentOutputTokensPerSecond: 0,
      recentRequestsPerMinute: 0,
    };
  }
  const elapsed = nowSeconds - previous.time;
  return {
    recentPromptTokensPerSecond: Math.max(0, promptTokens - Number(previous.promptTokens || 0)) / elapsed,
    recentOutputTokensPerSecond: Math.max(0, generationTokens - Number(previous.generationTokens || 0)) / elapsed,
    recentRequestsPerMinute: Math.max(0, requestCount - Number(previous.requestCount || 0)) / elapsed * 60,
  };
}

function calculateCost(tokens, profile) {
  const prompt = Number(tokens.prompt || 0);
  const output = Number(tokens.generation || 0);
  const cached = Math.min(prompt, Number(tokens.cachedPrompt || 0));
  const uncached = Math.max(0, prompt - cached);
  const standard = (prompt / 1_000_000) * profile.inputPerM
    + (output / 1_000_000) * profile.outputPerM;
  const cachedEquivalent = (uncached / 1_000_000) * profile.inputPerM
    + (cached / 1_000_000) * (profile.cachedInputPerM ?? profile.inputPerM)
    + (output / 1_000_000) * profile.outputPerM;
  return {
    ...profile,
    standardCost: standard,
    cachedEquivalentCost: cachedEquivalent,
  };
}

function clipText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 3)) + "...";
}

function normalizeClientModelBucket(value) {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  const requestsTotal = Number(item.requests?.total || 0);
  const latencyTotal = Number(item.latency?.totalMs || 0);
  return {
    tokens: {
      prompt,
      generation,
      total: Number(item.tokens?.total || prompt + generation),
    },
    requests: {
      total: requestsTotal,
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      aborted: Number(item.requests?.aborted || 0),
      streamed: Number(item.requests?.streamed || 0),
    },
    tools: {
      schemas: Number(item.tools?.schemas ?? item.tools?.schemaCount ?? 0),
      toolUse: Number(item.tools?.toolUse ?? item.tools?.toolUseCount ?? 0),
    },
    compression: {
      applied: Number(item.compression?.applied || 0),
      originalPromptTokens: Number(item.compression?.originalPromptTokens || 0),
      compressedPromptTokens: Number(item.compression?.compressedPromptTokens || 0),
      savedTokens: Number(item.compression?.savedTokens || 0),
      summarizedMessages: Number(item.compression?.summarizedMessages || 0),
      recentMessages: Number(item.compression?.recentMessages || 0),
      last: item.compression?.last || {},
    },
    latency: {
      totalMs: latencyTotal,
      avgMs: Number(item.latency?.avgMs || (requestsTotal ? latencyTotal / requestsTotal : 0)),
      maxMs: Number(item.latency?.maxMs || 0),
    },
  };
}

function mergeClientModelBucket(previous, delta = {}) {
  const bucket = previous && typeof previous === "object" ? previous : {};
  const normalized = normalizeClientModelBucket(bucket);
  bucket.tokens = normalized.tokens;
  bucket.requests = normalized.requests;
  bucket.tools = normalized.tools;
  bucket.compression = normalized.compression;
  bucket.latency = normalized.latency;

  const prompt = Number(delta.prompt || 0);
  const generation = Number(delta.generation || 0);
  const latencyMs = Math.max(0, Number(delta.latencyMs || 0));
  const compression = delta.compression && typeof delta.compression === "object" ? delta.compression : {};
  bucket.tokens.prompt += prompt;
  bucket.tokens.generation += generation;
  bucket.tokens.total = bucket.tokens.prompt + bucket.tokens.generation;
  bucket.requests.total += 1;
  if (delta.ok === false) bucket.requests.error += 1;
  else bucket.requests.success += 1;
  if (delta.stream) bucket.requests.streamed += 1;
  bucket.tools.schemas += Number(delta.toolSchemaCount || 0);
  bucket.tools.toolUse += Number(delta.toolUseCount || 0);
  if (compression.applied) {
    bucket.compression.applied += 1;
    bucket.compression.originalPromptTokens += Number(compression.originalPromptTokens || 0);
    bucket.compression.compressedPromptTokens += Number(compression.compressedPromptTokens || 0);
    bucket.compression.savedTokens += Number(compression.savedTokens || 0);
    bucket.compression.summarizedMessages += Number(compression.summarizedMessageCount || 0);
    bucket.compression.recentMessages += Number(compression.recentMessageCount || 0);
  }
  bucket.latency.totalMs += latencyMs;
  bucket.latency.maxMs = Math.max(bucket.latency.maxMs || 0, latencyMs);
  bucket.latency.avgMs = bucket.requests.total ? bucket.latency.totalMs / bucket.requests.total : 0;
  return bucket;
}

function normalizeClaudeClientSession(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    currentId: String(item.currentId || ""),
    currentLabel: String(item.currentLabel || ""),
    currentSource: String(item.currentSource || ""),
    currentFingerprint: String(item.currentFingerprint || ""),
    startedAt: item.startedAt || null,
    lastSeenAt: item.lastSeenAt || null,
    switches: Number(item.switches || 0),
    resets: Number(item.resets || 0),
    lastResetAt: item.lastResetAt || null,
    lastResetReason: item.lastResetReason || null,
    contextClearedAt: item.contextClearedAt || null,
  };
}

function normalizeClaudeClientSessionBucket(value, fallbackId = "") {
  const item = value && typeof value === "object" ? value : {};
  const modelBucket = normalizeClientModelBucket(item);
  return {
    id: String(item.id || fallbackId || ""),
    label: String(item.label || ""),
    source: String(item.source || ""),
    fingerprint: String(item.fingerprint || ""),
    startedAt: item.startedAt || null,
    lastSeenAt: item.lastSeenAt || null,
    tokens: modelBucket.tokens,
    requests: modelBucket.requests,
    tools: modelBucket.tools,
    compression: modelBucket.compression,
    latency: modelBucket.latency,
    models: item.models && typeof item.models === "object" ? item.models : {},
    last: item.last || {},
  };
}

function normalizeClaudeClientSessions(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const [id, bucket] of Object.entries(source)) {
    const normalized = normalizeClaudeClientSessionBucket(bucket, id);
    if (normalized.id) result[normalized.id] = normalized;
  }
  return result;
}

function normalizeClientUsageCounters(value, id, label) {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  const requestsTotal = Number(item.requests?.total || 0);
  const latencyTotal = Number(item.latency?.totalMs || 0);
  return {
    id: item.id || id,
    label: item.label || label,
    tokens: {
      prompt,
      generation,
      cachedPrompt: Number(item.tokens?.cachedPrompt || 0),
      total: Number(item.tokens?.total || prompt + generation),
    },
    requests: {
      total: requestsTotal,
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      aborted: Number(item.requests?.aborted || 0),
      streamed: Number(item.requests?.streamed || 0),
    },
    tools: {
      schemas: Number(item.tools?.schemas ?? item.tools?.schemaCount ?? 0),
      toolUse: Number(item.tools?.toolUse ?? item.tools?.toolUseCount ?? 0),
    },
    compression: {
      applied: Number(item.compression?.applied || 0),
      originalPromptTokens: Number(item.compression?.originalPromptTokens || 0),
      compressedPromptTokens: Number(item.compression?.compressedPromptTokens || 0),
      savedTokens: Number(item.compression?.savedTokens || 0),
      summarizedMessages: Number(item.compression?.summarizedMessages || 0),
      recentMessages: Number(item.compression?.recentMessages || 0),
      last: item.compression?.last || {},
    },
    latency: {
      totalMs: latencyTotal,
      avgMs: Number(item.latency?.avgMs || (requestsTotal ? latencyTotal / requestsTotal : 0)),
      maxMs: Number(item.latency?.maxMs || 0),
    },
    models: item.models && typeof item.models === "object" ? item.models : {},
    aliases: item.aliases && typeof item.aliases === "object" ? item.aliases : {},
    session: normalizeClaudeClientSession(item.session),
    sessions: normalizeClaudeClientSessions(item.sessions),
    last: item.last || {},
  };
}

function normalizeClaudeTaskSession(session) {
  if (!session || typeof session !== "object") return null;
  const id = String(session.id || "").trim();
  if (!id) return null;
  return {
    id: clipText(id, 120),
    label: clipText(String(session.label || "Claude task").replace(/\s+/g, " ").trim(), 120),
    source: clipText(String(session.source || "unknown").trim(), 40),
    fingerprint: clipText(String(session.fingerprint || "").trim(), 128),
    explicit: Boolean(session.explicit),
  };
}

function trimClaudeClientSessions(sessions, keepId, limit = 30) {
  const entries = Object.entries(sessions || {})
    .sort((a, b) => Date.parse(b[1]?.lastSeenAt || 0) - Date.parse(a[1]?.lastSeenAt || 0));
  for (const [id] of entries.slice(limit)) {
    if (id !== keepId) delete sessions[id];
  }
}

function updateClaudeClientSession(client, session, delta = {}, options = {}) {
  if (!session?.id) return;
  const now = options.now || new Date().toISOString();
  client.session = normalizeClaudeClientSession(client.session);
  client.sessions = normalizeClaudeClientSessions(client.sessions);

  const previousId = client.session.currentId;
  const switched = Boolean(previousId && previousId !== session.id);
  const firstSeen = !previousId;
  if (firstSeen || switched) {
    if (switched) client.session.switches += 1;
    client.session.resets += 1;
    client.session.lastResetAt = now;
    client.session.lastResetReason = firstSeen ? "initial-task" : "new-task-detected";
    client.session.contextClearedAt = now;
    client.session.startedAt = now;
  }

  client.session.currentId = session.id;
  client.session.currentLabel = session.label;
  client.session.currentSource = session.source;
  client.session.currentFingerprint = session.fingerprint;
  client.session.lastSeenAt = now;

  const bucket = normalizeClaudeClientSessionBucket(client.sessions[session.id], session.id);
  bucket.id = session.id;
  bucket.label = session.label || bucket.label;
  bucket.source = session.source || bucket.source;
  bucket.fingerprint = session.fingerprint || bucket.fingerprint;
  bucket.startedAt = bucket.startedAt || now;
  bucket.lastSeenAt = now;

  mergeClientModelBucket(bucket, delta);
  if (delta.compression?.applied) {
    bucket.compression.last = {
      at: now,
      savedTokens: Number(delta.compression.savedTokens || 0),
      summarizedMessageCount: Number(delta.compression.summarizedMessageCount || 0),
      recentMessageCount: Number(delta.compression.recentMessageCount || 0),
      triggerRatio: Number(delta.compression.triggerRatio || 0),
    };
  }
  if (delta.model) {
    bucket.models[delta.model] = mergeClientModelBucket(bucket.models[delta.model], delta);
  }
  bucket.last = {
    at: now,
    model: delta.model,
    requestedModel: delta.requestedModel,
    ok: delta.ok !== false,
    stream: Boolean(delta.stream),
    promptTokens: Number(delta.prompt || 0),
    outputTokens: Number(delta.generation || 0),
    toolSchemaCount: Number(delta.toolSchemaCount || 0),
    toolUseCount: Number(delta.toolUseCount || 0),
    compressionApplied: Boolean(delta.compression?.applied),
    compressionSavedTokens: Number(delta.compression?.savedTokens || 0),
    stopReason: delta.stopReason || null,
    error: delta.error || null,
    latencyMs: Number(delta.latencyMs || 0),
  };
  client.sessions[session.id] = bucket;
  trimClaudeClientSessions(client.sessions, session.id, Number(options.sessionLimit || 30));
}

function applyClaudeBridgeUsage(previousClient, event = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const client = normalizeClientUsageCounters(
    previousClient,
    options.id || "claude",
    options.label || "Claude compatible bridge",
  );
  const usage = event.usage || {};
  const prompt = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const generation = Number(usage.output_tokens || usage.completion_tokens || 0);
  const requestedModel = String(event.requestedModel || "");
  const modelFallback = options.modelFallback === "requested" ? requestedModel : "";
  const model = String(event.model || modelFallback || "unknown");
  const ok = event.ok === undefined ? options.defaultOk !== false : Boolean(event.ok);
  const latencyMs = Math.max(0, Number(event.latencyMs || 0));
  const compression = event.compression && typeof event.compression === "object" ? event.compression : {};
  const toolSchemaCount = Number(event.toolSchemaCount || 0);
  const toolUseCount = Number(event.toolUseCount || 0);

  const delta = {
    prompt,
    generation,
    ok,
    stream: Boolean(event.stream),
    toolSchemaCount,
    toolUseCount,
    compression,
    latencyMs,
    model,
    requestedModel,
    stopReason: event.stopReason || null,
    error: event.error ? String(event.error).slice(0, 300) : null,
  };

  client.requests.total += 1;
  if (ok) client.requests.success += 1;
  else client.requests.error += 1;
  if (event.stream) client.requests.streamed += 1;
  client.tokens.prompt += prompt;
  client.tokens.generation += generation;
  client.tokens.total = client.tokens.prompt + client.tokens.generation;
  client.tools.schemas += toolSchemaCount;
  client.tools.toolUse += toolUseCount;
  if (compression.applied) {
    client.compression.applied += 1;
    client.compression.originalPromptTokens += Number(compression.originalPromptTokens || 0);
    client.compression.compressedPromptTokens += Number(compression.compressedPromptTokens || 0);
    client.compression.savedTokens += Number(compression.savedTokens || 0);
    client.compression.summarizedMessages += Number(compression.summarizedMessageCount || 0);
    client.compression.recentMessages += Number(compression.recentMessageCount || 0);
  }
  if (compression.applied || options.compressionLast === "always") {
    client.compression.last = {
      at: now,
      applied: Boolean(compression.applied),
      originalPromptTokens: Number(compression.originalPromptTokens || 0),
      compressedPromptTokens: Number(compression.compressedPromptTokens || 0),
      savedTokens: Number(compression.savedTokens || 0),
      summarizedMessageCount: Number(compression.summarizedMessageCount || 0),
      recentMessageCount: Number(compression.recentMessageCount || 0),
      contextLimit: Number(compression.contextLimit || 0),
      triggerRatio: Number(compression.triggerRatio || 0),
    };
  }
  client.latency.totalMs += latencyMs;
  client.latency.maxMs = Math.max(client.latency.maxMs || 0, latencyMs);
  client.latency.avgMs = client.requests.total ? client.latency.totalMs / client.requests.total : 0;
  client.models[model] = mergeClientModelBucket(client.models[model], delta);
  if (requestedModel) {
    client.aliases[requestedModel] = Number(client.aliases[requestedModel] || 0) + 1;
  }
  if (options.trackSessions !== false) {
    updateClaudeClientSession(client, normalizeClaudeTaskSession(event.session), delta, {
      now,
      sessionLimit: options.sessionLimit,
    });
  }
  client.last = {
    at: now,
    updatedAt: now,
    model,
    requestedModel,
    ok,
    stream: Boolean(event.stream),
    promptTokens: prompt,
    outputTokens: generation,
    toolSchemaCount,
    toolUseCount,
    compressionApplied: Boolean(compression.applied),
    compressionSavedTokens: Number(compression.savedTokens || 0),
    stopReason: event.stopReason || null,
    error: event.error ? String(event.error).slice(0, 300) : null,
    latencyMs,
    sessionId: event.session?.id || null,
    sessionSource: event.session?.source || null,
  };
  return client;
}

function clientSessionsToSummary(sessions) {
  return Object.values(normalizeClaudeClientSessions(sessions))
    .sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: item.label,
      source: item.source,
      startedAt: item.startedAt,
      lastSeenAt: item.lastSeenAt,
      tokens: item.tokens,
      requests: item.requests,
      tools: item.tools,
      compression: item.compression,
      latency: item.latency,
      last: item.last,
      modelCount: Object.keys(item.models || {}).length,
    }));
}

function clientCountersToSummary(counters, meta = {}) {
  const item = normalizeClientUsageCounters(counters, meta.id || "client", meta.label || "Client");
  const models = Object.entries(item.models || {})
    .map(([name, value]) => ({ name, ...normalizeClientModelBucket(value) }))
    .sort((a, b) => b.tokens.total - a.tokens.total);
  return {
    id: meta.id || item.id,
    label: meta.label || item.label,
    description: meta.description || "",
    tokens: item.tokens,
    requests: item.requests,
    tools: item.tools,
    compression: item.compression,
    latency: item.latency,
    models,
    aliases: item.aliases || {},
    session: item.session || {},
    sessions: clientSessionsToSummary(item.sessions),
    last: item.last || {},
  };
}

function subtractClientFromTotals(totals, client, meta = {}) {
  const prompt = Math.max(0, Number(totals?.tokens?.prompt || 0) - Number(client.tokens?.prompt || 0));
  const generation = Math.max(0, Number(totals?.tokens?.generation || 0) - Number(client.tokens?.generation || 0));
  const cachedPrompt = Math.max(0, Number(totals?.tokens?.cachedPrompt || 0) - Number(client.tokens?.cachedPrompt || 0));
  const totalRequests = Math.max(0, Number(totals?.requests?.total || 0) - Number(client.requests?.total || 0));
  const error = Math.max(0, Number(totals?.requests?.error || 0) - Number(client.requests?.error || 0));
  const aborted = Math.max(0, Number(totals?.requests?.aborted || 0) - Number(client.requests?.aborted || 0));
  return {
    id: meta.id || "chat-direct",
    label: meta.label || "Chat / direct API",
    description: meta.description || "",
    tokens: {
      prompt,
      generation,
      cachedPrompt,
      total: prompt + generation,
    },
    requests: {
      total: totalRequests,
      success: Math.max(0, totalRequests - error - aborted),
      error,
      aborted,
      streamed: 0,
    },
    tools: { schemas: 0, toolUse: 0 },
    compression: { applied: 0, savedTokens: 0, last: {} },
    latency: { totalMs: 0, avgMs: 0, maxMs: 0 },
    models: [],
    aliases: {},
    session: {},
    sessions: [],
    last: {},
  };
}

function addClientShare(client, totalTokens, totalRequests) {
  return {
    ...client,
    share: {
      tokens: Math.min(1, Number(client.tokens?.total || 0) / totalTokens),
      requests: Math.min(1, Number(client.requests?.total || 0) / totalRequests),
    },
  };
}

function buildClientUsageSummary(totals, ledger = {}, options = {}) {
  const clients = ledger && typeof ledger === "object" ? ledger.clients || {} : {};
  const claude = clientCountersToSummary(clients.claude, {
    id: options.claude?.id || "claude",
    label: options.claude?.label || "Claude compatible bridge",
    description: options.claude?.description || "",
  });
  const other = subtractClientFromTotals(totals, claude, {
    id: options.other?.id || "chat-direct",
    label: options.other?.label || "Chat / direct API",
    description: options.other?.description || "",
  });
  const totalTokens = Math.max(1, Number(totals?.tokens?.total || 0));
  const totalRequests = Math.max(1, Number(totals?.requests?.total || 0));
  return {
    totals: {
      tokens: totals?.tokens || { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
      requests: totals?.requests || { total: 0, success: 0, error: 0, aborted: 0 },
    },
    clients: [
      addClientShare(claude, totalTokens, totalRequests),
      addClientShare(other, totalTokens, totalRequests),
    ],
    note: options.note || "",
  };
}

function emptyRuntimeCounters() {
  return {
    prompt: 0,
    generation: 0,
    cachedPrompt: 0,
    requests: 0,
    success: 0,
    error: 0,
    aborted: 0,
  };
}

function runtimeCountersFromStatsModel(model = {}) {
  return {
    prompt: Number(model.tokens?.prompt || 0),
    generation: Number(model.tokens?.generation || 0),
    cachedPrompt: Number(model.tokens?.cachedPrompt || 0),
    requests: Number(model.requests?.total || 0),
    success: Number(model.requests?.success || 0),
    error: Number(model.requests?.error || 0),
    aborted: Number(model.requests?.aborted || 0),
  };
}

function diffRuntimeCounters(current, previous) {
  const result = {};
  for (const key of Object.keys(current || {})) {
    result[key] = Math.max(0, Number(current?.[key] || 0) - Number(previous?.[key] || 0));
  }
  return result;
}

function maxRuntimeCounters(current, previous) {
  const result = {};
  for (const key of Object.keys(current || {})) {
    result[key] = Math.max(Number(current?.[key] || 0), Number(previous?.[key] || 0));
  }
  return result;
}

function mergeStatsLedgerModelDelta(ledger, model = {}, delta = {}, summary = {}, reason = "collect", options = {}) {
  const models = ledger.models && typeof ledger.models === "object" ? ledger.models : {};
  ledger.models = models;
  const existing = models[model.name] || {
    name: model.name,
    root: model.root || "",
    tokens: { prompt: 0, generation: 0, cachedPrompt: 0, total: 0 },
    requests: { total: 0, success: 0, error: 0, aborted: 0 },
    last: {},
  };
  existing.root = model.root || existing.root || "";
  existing.tokens.prompt += Number(delta.prompt || 0);
  existing.tokens.generation += Number(delta.generation || 0);
  existing.tokens.cachedPrompt += Number(delta.cachedPrompt || 0);
  existing.tokens.total = existing.tokens.prompt + existing.tokens.generation;
  existing.requests.total += Number(delta.requests || 0);
  existing.requests.success += Number(delta.success || 0);
  existing.requests.error += Number(delta.error || 0);
  existing.requests.aborted += Number(delta.aborted || 0);
  existing.last = {
    updatedAt: options.now || new Date().toISOString(),
    reason,
    processStartSeconds: summary.processStartSeconds,
    maxModelLen: model.maxModelLen || model.context?.maxModelLen || null,
    context: model.context || {},
    latency: model.latency || {},
    averages: model.averages || {},
    speed: model.speed || {},
    cache: model.cache || {},
    facts: summary.facts || {},
  };
  models[model.name] = existing;
  return existing;
}

function statsLedgerToSummary(ledger = {}) {
  const models = Object.values(ledger.models || {}).map((item) => statsLedgerModelToStatsModel(item));
  return {
    source: "persistent ledger",
    processStartSeconds: null,
    uptimeSeconds: null,
    facts: {},
    totals: aggregateStats(models, null),
    models,
    modelsByName: Object.fromEntries(models.map((model) => [model.name, model])),
    rawMetricCount: 0,
    note: ledger.updatedAt
      ? `Historical usage persisted at ${ledger.updatedAt}.`
      : "No historical usage has been captured yet.",
  };
}

function statsLedgerModelToStatsModel(item = {}) {
  return {
    name: item.name,
    root: item.root || "",
    maxModelLen: item.last?.maxModelLen || item.last?.context?.maxModelLen || null,
    tokens: {
      prompt: Number(item.tokens?.prompt || 0),
      generation: Number(item.tokens?.generation || 0),
      cachedPrompt: Number(item.tokens?.cachedPrompt || 0),
      total: Number(item.tokens?.total || 0),
      promptBySource: {},
    },
    requests: {
      total: Number(item.requests?.total || 0),
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
      aborted: Number(item.requests?.aborted || 0),
      byFinishReason: {},
      running: 0,
      waiting: 0,
    },
    latency: item.last?.latency || {},
    averages: item.last?.averages || {},
    speed: {
      recentPromptTokensPerSecond: 0,
      recentOutputTokensPerSecond: 0,
      recentRequestsPerMinute: 0,
      averageOutputTokensPerSecond: item.last?.speed?.averageOutputTokensPerSecond || 0,
      lifetimeTokensPerSecond: null,
    },
    cache: item.last?.cache || {},
    context: item.last?.context || { activeTokens: 0, capacityTokens: null, kvUsagePercent: 0 },
  };
}

function mergeLiveAndStatsLedger(liveSummary, ledger) {
  const historical = statsLedgerToSummary(ledger);
  const liveModels = Array.isArray(liveSummary?.models) ? liveSummary.models : [];
  const liveByName = Object.fromEntries(liveModels.map((model) => [model.name, model]));
  const mergedModels = historical.models.map((model) => ({
    ...model,
    context: liveByName[model.name]?.context || model.context,
    latency: liveByName[model.name]?.latency || model.latency,
    averages: liveByName[model.name]?.averages || model.averages,
    speed: liveByName[model.name]?.speed || model.speed,
    cache: liveByName[model.name]?.cache || model.cache,
    requests: {
      ...model.requests,
      running: liveByName[model.name]?.requests?.running || 0,
      waiting: liveByName[model.name]?.requests?.waiting || 0,
    },
  }));
  for (const model of liveModels) {
    if (!mergedModels.some((item) => item.name === model.name)) mergedModels.push(model);
  }
  return {
    ...historical,
    source: liveSummary?.source || historical.source,
    processStartSeconds: liveSummary?.processStartSeconds || null,
    uptimeSeconds: liveSummary?.uptimeSeconds || null,
    facts: liveSummary?.facts || historical.facts,
    totals: aggregateStats(mergedModels, liveSummary?.uptimeSeconds || null),
    models: mergedModels.sort((a, b) => b.tokens.total - a.tokens.total),
    modelsByName: Object.fromEntries(mergedModels.map((model) => [model.name, model])),
    rawMetricCount: liveSummary?.rawMetricCount || 0,
    note: historical.note,
  };
}

module.exports = {
  applyClaudeBridgeUsage,
  aggregateStats,
  calculateRecentRates,
  calculateCost,
  buildClientUsageSummary,
  clientCountersToSummary,
  clientSessionsToSummary,
  diffRuntimeCounters,
  emptyStatsSummary,
  emptyRuntimeCounters,
  normalizeClaudeClientSession,
  normalizeClaudeClientSessions,
  normalizeClaudeTaskSession,
  normalizeClientModelBucket,
  normalizeClientUsageCounters,
  maxRuntimeCounters,
  mergeClientModelBucket,
  mergeLiveAndStatsLedger,
  mergeStatsLedgerModelDelta,
  runtimeCountersFromStatsModel,
  statsLedgerModelToStatsModel,
  statsLedgerToSummary,
  subtractClientFromTotals,
  updateClaudeClientSession,
};
