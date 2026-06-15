const crypto = require("node:crypto");
const {
  buildEffectiveServiceSettings,
  enterServiceConcurrency,
  enterServiceRateLimit,
  hasActiveServiceClients,
  hasGlobalServiceApiKey,
  isGlobalServiceApiKeyAccepted,
} = require("./service-policy");

function serviceApiKeySource(headers = {}) {
  const auth = String(headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return "authorization-bearer";
  if (auth) return "authorization-raw";
  if (headers["x-api-key"]) return "x-api-key";
  if (headers["anthropic-api-key"]) return "anthropic-api-key";
  if (headers["anthropic_api_key"]) return "anthropic_api_key";
  if (headers["api-key"]) return "api-key";
  return "";
}

function extractServiceApiKey(headers = {}, options = {}) {
  const auth = String(headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  if (options.acceptRawAuthorization && auth && !/^Bearer\s+/i.test(auth)) return auth.trim();
  return String(
    headers["x-api-key"]
    || headers["anthropic-api-key"]
    || headers["anthropic_api_key"]
    || headers["api-key"]
    || "",
  ).trim();
}

function openAiGatewayError(code, message) {
  return {
    error: {
      message: String(message || "Service gateway error."),
      type: String(code || "gateway_error"),
      code: String(code || "gateway_error"),
    },
  };
}

function claudeError(type, message) {
  return {
    type: "error",
    error: {
      type: String(type || "api_error"),
      message: String(message || "Claude compatibility bridge error."),
    },
  };
}

function claudeGatewayError(type, message) {
  return claudeError(type, message);
}

function upstreamErrorMessage(data, text, fallback = "Upstream model service returned an error.") {
  return data?.error?.message || data?.message || text || fallback;
}

async function sendClaudeUpstreamError(res, upstream, options = {}) {
  const text = await upstream.text().catch(() => "");
  const data = parseJsonSafe(text, null);
  return res
    .status(upstream.status)
    .json(claudeError(options.type || "api_error", upstreamErrorMessage(data, text, options.fallback)));
}

function isExpectedStreamDisconnect(error, res = null) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || error?.cause?.code || "");
  return Boolean(
    res?.destroyed
    || res?.writableEnded
    || error?.name === "AbortError"
    || code === "UND_ERR_ABORTED"
    || code === "ERR_STREAM_PREMATURE_CLOSE"
    || message === "terminated"
    || message.includes("aborted")
    || message.includes("premature close")
  );
}

function parseJsonSafe(text, fallback = null) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function uniqueModelsById(models) {
  const seen = new Set();
  const result = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = String(model?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(model);
  }
  return result;
}

function servedModelIds(runtime = {}) {
  return (runtime.servedModels || runtime.models || [])
    .map((item) => (typeof item === "string" ? item : item?.id))
    .filter(Boolean);
}

function resolveOpenAiGatewayModel(requestedModel, runtime = {}, options = {}) {
  const aliases = Array.isArray(options.aliases) ? options.aliases : [];
  const served = servedModelIds(runtime);
  const fallback = served[0] || "";
  const value = String(requestedModel || "").trim();
  if (!value) return fallback;
  const bareValue = value.split("/").pop();
  if (aliases.some((alias) => alias.toLowerCase() === value.toLowerCase() || alias.toLowerCase() === bareValue.toLowerCase())) return fallback;
  const exact = served.find((id) => id === value || id.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const rootMappings = typeof options.getRootMappings === "function" ? options.getRootMappings(runtime) : options.rootMappings;
  const rootMatch = (Array.isArray(rootMappings) ? rootMappings : [])
    .find((entry) => entry?.root === value || String(entry?.root || "").toLowerCase() === value.toLowerCase());
  return rootMatch?.id || "";
}

function buildOpenAiGatewayModelList({ models = [], runtime = {}, aliases = [], owner = "local-manager" } = {}) {
  const fallback = models[0] || runtime.servedModels?.[0] || runtime.models?.[0] || {};
  const aliasModels = aliases.map((id) => ({
    id,
    object: "model",
    created: fallback.created || Math.floor(Date.now() / 1000),
    owned_by: owner,
    root: fallback.id || "",
    parent: fallback.id || null,
    max_model_len: fallback.max_model_len || fallback.maxModelLen || null,
  }));
  return { object: "list", data: uniqueModelsById([...aliasModels, ...models]) };
}

function createServiceUpstreamControl(req, res) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(req.serviceGateway?.timeoutMs || 600000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortOnClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", abortOnClose);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      res.off?.("close", abortOnClose);
    },
  };
}

async function streamRawOpenAiGatewayResponse(upstream, res, upstreamControl, options = {}) {
  const {
    req = null,
    model = "",
    recordUsage = async () => {},
    setAccessUsage = () => {},
    isExpectedStreamDisconnect = () => false,
  } = options;
  res.status(upstream.status);
  res.setHeader("content-type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", upstream.headers.get("cache-control") || "no-cache");
  res.setHeader("connection", "keep-alive");
  let streamError = null;
  try {
    for await (const chunk of upstream.body || []) {
      if (!res.writableEnded) res.write(Buffer.from(chunk));
    }
  } catch (error) {
    streamError = error;
  } finally {
    upstreamControl.clear();
  }
  await recordUsage(req?.serviceGateway?.clientId, {
    ok: upstream.ok && !streamError,
    status: streamError ? 499 : upstream.status,
    model,
  }).catch(() => {});
  if (req) {
    setAccessUsage(req, {
      resolvedModel: model,
      error: streamError ? streamError.message : "",
    });
  }
  if (streamError && !isExpectedStreamDisconnect(streamError, res) && !res.writableEnded) {
    res.write(`\ndata: ${JSON.stringify(openAiGatewayError("gateway_error", `Upstream stream failed: ${streamError.message}`))}\n\n`);
  }
  if (!res.writableEnded) res.end();
}

function createOpenAiGatewayHandlers(options = {}) {
  const {
    aliases = [],
    owner = "local-manager",
    getRunningModelSummary,
    getUpstreamHeaders = () => ({}),
    serviceClientAllowsModel = () => true,
    recordUsage = async () => {},
    upstreamErrorMessage = (data, text) => data?.error?.message || data?.message || String(text || "Upstream request failed."),
    isExpectedStreamDisconnect = () => false,
    setAccessUsage = () => {},
    getRootMappings = () => [],
    fetchFn = (...args) => fetch(...args),
  } = options;

  async function handleModels(_req, res) {
    try {
      const runtime = await getRunningModelSummary();
      if (!runtime.container.running) {
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const response = await fetchFn(`http://127.0.0.1:${runtime.endpoint.port}/v1/models`, {
        signal: AbortSignal.timeout(5000),
        headers: getUpstreamHeaders(runtime),
      });
      const text = await response.text();
      const data = parseJsonSafe(text, {});
      if (!response.ok) {
        return res.status(response.status).json(openAiGatewayError("upstream_error", upstreamErrorMessage(data, text)));
      }
      const models = Array.isArray(data.data) ? data.data : [];
      return res.json(buildOpenAiGatewayModelList({ models, runtime, aliases, owner }));
    } catch (error) {
      return res.status(500).json(openAiGatewayError("gateway_error", error.message));
    }
  }

  async function handleCompletionProxy(req, res, upstreamPath) {
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    try {
      const runtime = await getRunningModelSummary();
      if (!runtime.container.running) {
        setAccessUsage(req, { error: "Model service is not running." });
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const model = resolveOpenAiGatewayModel(String(body.model || ""), runtime, { aliases, getRootMappings });
      if (!model) {
        setAccessUsage(req, { error: "Configured model is not available on this local gateway." });
        await recordUsage(req.serviceGateway?.clientId, { ok: false, status: 400, model: String(body.model || "") }).catch(() => {});
        return res.status(400).json(openAiGatewayError("model_not_available", "Configured model is not available on this local gateway."));
      }
      if (!serviceClientAllowsModel(req.serviceGateway?.client, model, runtime)) {
        setAccessUsage(req, { resolvedModel: model, error: "This service client is not allowed to use the requested model." });
        await recordUsage(req.serviceGateway?.clientId, { ok: false, status: 403, model }).catch(() => {});
        return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to use the requested model."));
      }
      body.model = model;
      const stream = body.stream === true;
      const upstreamControl = createServiceUpstreamControl(req, res);
      try {
        const upstream = await fetchFn(`http://127.0.0.1:${runtime.endpoint.port}/v1/${upstreamPath}`, {
          method: "POST",
          headers: getUpstreamHeaders(runtime, { "content-type": "application/json" }),
          body: JSON.stringify(body),
          signal: upstreamControl.signal,
        });
        if (stream) {
          return streamRawOpenAiGatewayResponse(upstream, res, upstreamControl, {
            req,
            model,
            recordUsage,
            setAccessUsage,
            isExpectedStreamDisconnect,
          });
        }
        const text = await upstream.text();
        upstreamControl.clear();
        const data = parseJsonSafe(text, null);
        setAccessUsage(req, {
          resolvedModel: model,
          inputTokens: Number(data?.usage?.prompt_tokens || data?.usage?.promptTokens || 0),
          outputTokens: Number(data?.usage?.completion_tokens || data?.usage?.completionTokens || 0),
        });
        await recordUsage(req.serviceGateway?.clientId, {
          ok: upstream.ok,
          status: upstream.status,
          model,
          usage: data?.usage,
        }).catch(() => {});
        res.status(upstream.status);
        res.type(upstream.headers.get("content-type") || "application/json");
        return res.send(text);
      } catch (error) {
        upstreamControl.clear();
        throw error;
      }
    } catch (error) {
      setAccessUsage(req, { error: error.message });
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const timedOut = error?.name === "AbortError";
      return res.status(timedOut ? 504 : 500).json(openAiGatewayError(
        timedOut ? "request_timeout" : "gateway_error",
        timedOut ? "Upstream request timed out." : error.message,
      ));
    }
  }

  return {
    handleModels,
    handleChatCompletions: (req, res) => handleCompletionProxy(req, res, "chat/completions"),
    handleCompletions: (req, res) => handleCompletionProxy(req, res, "completions"),
    handleCompletionProxy,
    resolveModel: (requestedModel, runtime) => resolveOpenAiGatewayModel(requestedModel, runtime, { aliases, getRootMappings }),
  };
}

function getServiceGatewayKind(req, supportedKinds = ["openai", "claude"]) {
  const pathname = String(req.originalUrl || req.url || "").split("?")[0];
  const kind = pathname.startsWith("/serve/v1/") ? "openai"
    : pathname.startsWith("/opencode/v1/") ? "opencode"
      : (pathname.startsWith("/claude/") || pathname.startsWith("/v1/messages") || pathname.startsWith("/v1/claude/")) ? "claude"
        : "";
  return kind && supportedKinds.includes(kind) ? kind : "";
}

function isServiceKindEnabled(settings = {}, kind) {
  if (settings.enabled === false) return false;
  if (kind === "openai") return settings.exposeOpenAI !== false;
  if (kind === "claude") return settings.exposeClaude !== false;
  if (kind === "opencode") return settings.exposeOpenCode !== false;
  return true;
}

function appendVaryHeader(current, value) {
  const entries = String(current || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.some((item) => item.toLowerCase() === value.toLowerCase())) entries.push(value);
  return entries.join(", ");
}

function isServiceOriginAllowed(origin, allowedOrigins = []) {
  const entries = allowedOrigins.map((item) => String(item || "").trim()).filter(Boolean);
  if (!entries.length) return true;
  if (entries.includes("*")) return true;
  return entries.some((entry) => entry === origin);
}

function applyServiceCorsHeaders(req, res, settings = {}, allowHeaders = "authorization,content-type,x-api-key,api-key,anthropic-api-key,anthropic_api_key,anthropic-version,x-requested-with") {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return { ok: true };
  if (!isServiceOriginAllowed(origin, settings.allowedOrigins || [])) {
    return { ok: false, message: `Origin is not allowed: ${origin}` };
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", appendVaryHeader(res.getHeader("vary"), "Origin"));
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", allowHeaders);
  res.setHeader("access-control-max-age", "600");
  return { ok: true };
}

function isLocalRequester(req) {
  const address = String(req.socket?.remoteAddress || req.ip || "").replace(/^::ffff:/, "");
  return ["127.0.0.1", "::1", "localhost", ""].includes(address);
}

function serviceClientFingerprint(req, apiKey = "") {
  const raw = apiKey || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "unknown";
  return crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24);
}

function serviceGatewayReject(res, status, code, message, headers = {}) {
  if (res.headersSent) return res.end();
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  return res.status(status).json(openAiGatewayError(code, message));
}

function buildServiceGatewayAccessLogEntry(req, res, kind, startedAt, authSource) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const usage = req.serviceGatewayAccessUsage || {};
  const inputTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.generationTokens ?? 0);
  return {
    at: new Date().toISOString(),
    remoteAddress: req.socket?.remoteAddress || req.ip || "",
    method: req.method,
    path: String(req.originalUrl || req.url || "").split("?")[0],
    kind,
    status: res.statusCode,
    model: typeof body.model === "string" ? body.model.slice(0, 160) : "",
    resolvedModel: String(usage.resolvedModel || "").slice(0, 220),
    stream: body.stream === true,
    authSource,
    clientId: req.serviceGateway?.clientId || "",
    durationMs: Date.now() - startedAt,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    stopReason: String(usage.stopReason || "").slice(0, 80),
    toolSchemaCount: Number(usage.toolSchemaCount || 0),
    toolUseCount: Number(usage.toolUseCount || 0),
    error: String(usage.error || "").slice(0, 240),
  };
}

function attachServiceGatewayAccessLog(req, res, kind, appendAccessLog) {
  const startedAt = Date.now();
  const authSource = serviceApiKeySource(req.headers || {});
  res.once("finish", () => {
    const entry = buildServiceGatewayAccessLogEntry(req, res, kind, startedAt, authSource);
    appendAccessLog(entry).catch(() => {});
  });
}

function createServiceGatewayMiddleware(options = {}) {
  const {
    gatewayName = "local-manager",
    supportedKinds = ["openai", "claude"],
    getServiceExposureSettings,
    getServiceClientsLedger,
    resolveServiceClientForApiKey,
    rateBuckets,
    concurrencyBuckets,
    appendAccessLog = async () => {},
    corsAllowHeaders,
    acceptRawAuthorization = false,
  } = options;

  return async function serviceGatewayMiddleware(req, res, next) {
    try {
      const settings = await getServiceExposureSettings();
      const kind = getServiceGatewayKind(req, supportedKinds);
      if (!kind) return next();
      attachServiceGatewayAccessLog(req, res, kind, appendAccessLog);
      const cors = applyServiceCorsHeaders(req, res, settings, corsAllowHeaders);
      if (!cors.ok) return serviceGatewayReject(res, 403, "origin_not_allowed", cors.message);
      if (req.method === "OPTIONS") return res.status(204).end();
      if (!isServiceKindEnabled(settings, kind)) {
        return serviceGatewayReject(res, 404, "endpoint_disabled", `${kind} gateway is disabled by service exposure settings.`);
      }
      if (settings.enabled && settings.exposureMode === "local" && !isLocalRequester(req)) {
        return serviceGatewayReject(res, 403, "local_only", "Service exposure mode is local-only.");
      }
      const presentedKey = extractServiceApiKey(req.headers || {}, { acceptRawAuthorization });
      const clientsLedger = await getServiceClientsLedger();
      const serviceClient = await resolveServiceClientForApiKey(presentedKey);
      const globalKeyAccepted = isGlobalServiceApiKeyAccepted(presentedKey, settings);
      if (settings.enabled && settings.requireApiKey) {
        if (!hasGlobalServiceApiKey(settings) && !hasActiveServiceClients(clientsLedger)) {
          return serviceGatewayReject(res, 503, "api_key_not_configured", "API key is required, but no service API key is configured.");
        }
        if (!globalKeyAccepted && !serviceClient) {
          return serviceGatewayReject(res, 401, "unauthorized", "Missing or invalid service API key.", { "www-authenticate": "Bearer" });
        }
      }
      const effectiveSettings = buildEffectiveServiceSettings(settings, serviceClient);
      const clientKey = serviceClient?.id || serviceClientFingerprint(req, presentedKey);
      const rate = enterServiceRateLimit(effectiveSettings, clientKey, rateBuckets);
      if (!rate.ok) {
        return serviceGatewayReject(res, 429, "rate_limit_exceeded", `Rate limit exceeded. Retry after ${rate.retryAfterSeconds}s.`, { "retry-after": String(rate.retryAfterSeconds) });
      }
      const concurrency = enterServiceConcurrency(effectiveSettings, clientKey, concurrencyBuckets);
      if (!concurrency.ok) {
        return serviceGatewayReject(res, 429, "concurrency_limit_exceeded", "Too many concurrent requests for this service key.");
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        concurrency.release();
      };
      res.once("finish", release);
      res.once("close", release);
      const timeoutMs = Math.min(7200, Math.max(10, Number(effectiveSettings.requestTimeoutSeconds || 600))) * 1000;
      req.serviceGateway = { kind, settings: effectiveSettings, baseSettings: settings, client: serviceClient, clientId: serviceClient?.id || "", clientKey, timeoutMs };
      res.setHeader("x-local-llm-gateway", gatewayName);
      res.setTimeout?.(timeoutMs, () => {
        if (!res.headersSent) res.status(504).json(openAiGatewayError("request_timeout", "Service gateway request timed out."));
        if (!res.writableEnded) res.end();
      });
      return next();
    } catch (error) {
      return serviceGatewayReject(res, 500, "gateway_error", error.message);
    }
  };
}

module.exports = {
  serviceApiKeySource,
  extractServiceApiKey,
  openAiGatewayError,
  claudeError,
  claudeGatewayError,
  upstreamErrorMessage,
  sendClaudeUpstreamError,
  isExpectedStreamDisconnect,
  uniqueModelsById,
  servedModelIds,
  resolveOpenAiGatewayModel,
  buildOpenAiGatewayModelList,
  createServiceUpstreamControl,
  streamRawOpenAiGatewayResponse,
  createOpenAiGatewayHandlers,
  getServiceGatewayKind,
  isServiceKindEnabled,
  appendVaryHeader,
  isServiceOriginAllowed,
  applyServiceCorsHeaders,
  isLocalRequester,
  serviceClientFingerprint,
  serviceGatewayReject,
  buildServiceGatewayAccessLogEntry,
  createServiceGatewayMiddleware,
};
