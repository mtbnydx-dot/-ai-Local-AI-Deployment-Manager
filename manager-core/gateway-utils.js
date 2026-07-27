const crypto = require("node:crypto");
const { parseJsonSafe } = require("./common-utils");
const {
  buildEffectiveServiceSettings,
  enterServiceConcurrency,
  enterServiceRateLimit,
  hasActiveServiceClients,
  hasGlobalServiceApiKey,
  isGlobalServiceApiKeyAccepted,
  DEFAULT_GATEWAY_MAX_CONCURRENT,
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

const DEFAULT_OPENAI_BASE_URL_HINT_ROUTES = [
  "/v1",
  "/v1/",
  "/v1/models",
  "/v1/chat/completions",
  "/v1/completions",
  "/models",
  "/chat/completions",
  "/completions",
];

function buildGatewayBaseUrl(req, basePath = "/serve/v1") {
  const host = String(req?.headers?.host || "127.0.0.1").trim() || "127.0.0.1";
  const protoHeader = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = protoHeader || req?.protocol || "http";
  const path = String(basePath || "/serve/v1").startsWith("/") ? String(basePath || "/serve/v1") : `/${basePath}`;
  return `${protocol}://${host}${path.replace(/\/$/, "")}`;
}

function wrongOpenAiBaseUrlError(req, options = {}) {
  const correctBaseUrl = options.correctBaseUrl || buildGatewayBaseUrl(req, options.openAiGatewayPath || "/serve/v1");
  const requestedPath = String(req?.originalUrl || req?.url || "").split("?")[0] || "/";
  return openAiGatewayError(
    "wrong_base_url",
    `Wrong OpenAI-compatible base URL. Use ${correctBaseUrl} as the Base URL; do not use ${requestedPath} directly on the manager.`,
  );
}

function registerOpenAiBaseUrlHintRoutes(app, options = {}) {
  const routes = options.routes || DEFAULT_OPENAI_BASE_URL_HINT_ROUTES;
  const handler = (req, res) => {
    const status = Number(options.status || 400);
    return res.status(status).json(wrongOpenAiBaseUrlError(req, options));
  };
  for (const route of routes) {
    if (typeof app.all === "function") app.all(route, handler);
    else {
      app.get?.(route, handler);
      app.post?.(route, handler);
      app.options?.(route, handler);
    }
  }
  return routes.slice();
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

function pushUniqueModelAlias(result, seen, alias) {
  const value = String(alias || "").trim();
  if (!value) return;
  const key = value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  result.push(value);
}

function deriveOpenAiGatewayModelAliases(modelId) {
  const id = String(typeof modelId === "string" ? modelId : modelId?.id || "").trim();
  if (!id) return [];
  const result = [];
  const seen = new Set();
  const bare = id.split(/[\\/]/).pop().trim();
  if (bare && bare !== id) pushUniqueModelAlias(result, seen, bare);
  const candidates = [id, bare].filter(Boolean);
  for (const candidate of candidates) {
    const text = candidate.toLowerCase();
    const qwen = text.match(/(?:^|[^a-z0-9])qwen[-_\s]?(\d+(?:\.\d+)?)/i);
    if (qwen) pushUniqueModelAlias(result, seen, `qwen${qwen[1]}`);
    const llama = text.match(/(?:^|[^a-z0-9])llama[-_\s]?(\d+(?:\.\d+)?)/i);
    if (llama) pushUniqueModelAlias(result, seen, `llama${llama[1]}`);
    const gemma = text.match(/(?:^|[^a-z0-9])gemma[-_\s]?(\d+(?:\.\d+)?)/i);
    if (gemma) pushUniqueModelAlias(result, seen, `gemma${gemma[1]}`);
    const deepseek = text.match(/(?:^|[^a-z0-9])deepseek[-_\s]?r[-_\s]?(\d+)/i);
    if (deepseek) pushUniqueModelAlias(result, seen, `deepseek-r${deepseek[1]}`);
  }
  return result;
}

function buildOpenAiGatewayAliasList({ aliases = [], models = [], runtime = {} } = {}) {
  const result = [];
  const seen = new Set();
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    pushUniqueModelAlias(result, seen, alias);
  }
  const modelIds = [
    ...servedModelIds(runtime),
    ...(Array.isArray(models) ? models.map((model) => (typeof model === "string" ? model : model?.id)).filter(Boolean) : []),
  ];
  for (const id of modelIds) {
    for (const alias of deriveOpenAiGatewayModelAliases(id)) {
      pushUniqueModelAlias(result, seen, alias);
    }
  }
  return result;
}

function findOpenAiGatewayDynamicAlias(requestedModel, modelIds = []) {
  const value = String(requestedModel || "").trim();
  if (!value) return "";
  const bareValue = value.split(/[\\/]/).pop();
  for (const id of modelIds) {
    for (const alias of deriveOpenAiGatewayModelAliases(id)) {
      if (alias.toLowerCase() === value.toLowerCase() || alias.toLowerCase() === bareValue.toLowerCase()) {
        return id;
      }
    }
  }
  return "";
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
  const dynamicAlias = findOpenAiGatewayDynamicAlias(value, served);
  if (dynamicAlias) return dynamicAlias;
  const rootMappings = typeof options.getRootMappings === "function" ? options.getRootMappings(runtime) : options.rootMappings;
  const rootMatch = (Array.isArray(rootMappings) ? rootMappings : [])
    .find((entry) => entry?.root === value || String(entry?.root || "").toLowerCase() === value.toLowerCase());
  return rootMatch?.id || fallback;
}

function buildOpenAiGatewayModelList({ models = [], runtime = {}, aliases = [], owner = "local-manager" } = {}) {
  const fallback = models[0] || runtime.servedModels?.[0] || runtime.models?.[0] || {};
  const allAliases = buildOpenAiGatewayAliasList({ aliases, models, runtime });
  const aliasModels = allAliases.map((id) => ({
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
    listRunningModelSummaries,
    getUpstreamHeaders = () => ({}),
    serviceClientAllowsModel = () => true,
    recordUsage = async () => {},
    upstreamErrorMessage = (data, text) => data?.error?.message || data?.message || String(text || "Upstream request failed."),
    isExpectedStreamDisconnect = () => false,
    setAccessUsage = () => {},
    getRootMappings = () => [],
    prepareRequestBody = (body) => body,
    fetchFn = (...args) => fetch(...args),
  } = options;

  async function getAvailableRuntimes() {
    if (typeof listRunningModelSummaries === "function") {
      const runtimes = await listRunningModelSummaries();
      const running = (Array.isArray(runtimes) ? runtimes : []).filter((runtime) => runtime?.container?.running);
      if (running.length) return running;
    }
    const primary = await getRunningModelSummary();
    return primary ? [primary] : [];
  }

  function runtimeHasRequestedModel(runtime, requestedModel) {
    const value = String(requestedModel || "").trim();
    if (!value) return false;
    const served = servedModelIds(runtime);
    if (served.some((id) => id === value || id.toLowerCase() === value.toLowerCase())) return true;
    if (findOpenAiGatewayDynamicAlias(value, served)) return true;
    const roots = getRootMappings(runtime) || [];
    return roots.some((entry) => entry?.root === value || String(entry?.root || "").toLowerCase() === value.toLowerCase());
  }

  async function selectRuntime(requestedModel = "") {
    const runtimes = await getAvailableRuntimes();
    if (!runtimes.length) return null;
    const value = String(requestedModel || "").trim();
    const bareValue = value.split("/").pop();
    if (!value || aliases.some((alias) => alias.toLowerCase() === value.toLowerCase() || alias.toLowerCase() === bareValue.toLowerCase())) {
      return runtimes[0];
    }
    return runtimes.find((runtime) => runtimeHasRequestedModel(runtime, value)) || runtimes[0];
  }

  async function fetchRuntimeModels(runtime) {
    const response = await fetchFn(`http://127.0.0.1:${runtime.endpoint.port}/v1/models`, {
      signal: AbortSignal.timeout(5000),
      headers: getUpstreamHeaders(runtime),
    });
    const text = await response.text();
    const data = parseJsonSafe(text, {});
    if (!response.ok) throw Object.assign(new Error(upstreamErrorMessage(data, text)), { status: response.status });
    return Array.isArray(data.data) ? data.data : [];
  }

  async function handleModels(_req, res) {
    try {
      const runtimes = await getAvailableRuntimes();
      const runtime = runtimes[0];
      if (!runtime?.container?.running) {
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const results = await Promise.allSettled(runtimes.map((item) => fetchRuntimeModels(item)));
      const models = uniqueModelsById(results.filter((item) => item.status === "fulfilled").flatMap((item) => item.value));
      if (!models.length) {
        const firstError = results.find((item) => item.status === "rejected")?.reason;
        return res.status(503).json(openAiGatewayError(
          "service_unavailable",
          firstError?.message || "Running model services did not return any models yet.",
        ));
      }
      return res.json(buildOpenAiGatewayModelList({ models, runtime, aliases, owner }));
    } catch (error) {
      return res.status(500).json(openAiGatewayError("gateway_error", error.message));
    }
  }

  async function handleProps(_req, res) {
    try {
      const runtimes = await getAvailableRuntimes();
      const runtime = runtimes[0];
      if (!runtime?.container?.running) {
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const results = await Promise.allSettled(runtimes.map((item) => fetchRuntimeModels(item)));
      const models = uniqueModelsById(results.filter((item) => item.status === "fulfilled").flatMap((item) => item.value));
      if (!models.length) {
        const firstError = results.find((item) => item.status === "rejected")?.reason;
        return res.status(503).json(openAiGatewayError(
          "service_unavailable",
          firstError?.message || "Running model services did not return any models yet.",
        ));
      }
      const modelList = buildOpenAiGatewayModelList({ models, runtime, aliases, owner });
      return res.json({
        object: "gateway.props",
        type: "openai-compatible",
        basePath: "/serve/v1",
        defaultModel: aliases[0] || modelList.data[0]?.id || "",
        models: modelList.data.map((model) => model.id).filter(Boolean),
        capabilities: {
          models: true,
          chatCompletions: true,
          completions: true,
          responses: true,
          embeddings: true,
          pooling: true,
          scoring: true,
          reranking: true,
          classification: true,
          streaming: true,
        },
      });
    } catch (error) {
      return res.status(500).json(openAiGatewayError("gateway_error", error.message));
    }
  }

  async function handleCompletionProxy(req, res, upstreamPath) {
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    try {
      const runtime = await selectRuntime(body.model);
      if (!runtime?.container?.running) {
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
      const prepared = await prepareRequestBody(body, runtime, model, { req, upstreamPath });
      const requestBody = prepared && typeof prepared === "object" && !Array.isArray(prepared)
        ? { ...prepared, model }
        : body;
      const stream = requestBody.stream === true;
      const upstreamControl = createServiceUpstreamControl(req, res);
      try {
        const upstream = await fetchFn(`http://127.0.0.1:${runtime.endpoint.port}/v1/${upstreamPath}`, {
          method: "POST",
          headers: getUpstreamHeaders(runtime, { "content-type": "application/json" }),
          body: JSON.stringify(requestBody),
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
    handleProps,
    handleChatCompletions: (req, res) => handleCompletionProxy(req, res, "chat/completions"),
    handleCompletions: (req, res) => handleCompletionProxy(req, res, "completions"),
    handleResponses: (req, res) => handleCompletionProxy(req, res, "responses"),
    handleEmbeddings: (req, res) => handleCompletionProxy(req, res, "embeddings"),
    handlePooling: (req, res) => handleCompletionProxy(req, res, "pooling"),
    handleScore: (req, res) => handleCompletionProxy(req, res, "score"),
    handleRerank: (req, res) => handleCompletionProxy(req, res, "rerank"),
    handleClassify: (req, res) => handleCompletionProxy(req, res, "classify"),
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

const DEFAULT_SERVICE_CORS_ALLOW_HEADERS = "authorization,content-type,user-agent,x-api-key,api-key,anthropic-api-key,anthropic_api_key,anthropic-version,x-requested-with";

function isServiceOriginAllowed(origin, allowedOrigins = [], allowWhenEmpty = true) {
  const entries = allowedOrigins.map((item) => String(item || "").trim()).filter(Boolean);
  if (!entries.length) return allowWhenEmpty;
  if (entries.includes("*")) return true;
  return entries.some((entry) => entry === origin);
}

function normalizeServiceCorsHeaderNames(value) {
  return Array.from(new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(item))));
}

function applyServiceCorsHeaders(req, res, settings = {}, allowHeaders = DEFAULT_SERVICE_CORS_ALLOW_HEADERS) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return { ok: true };
  const configuredOrigins = Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : [];
  const corsMode = settings.corsMode
    ? String(settings.corsMode).toLowerCase()
    : configuredOrigins.length ? "restricted" : "open";
  const openCors = corsMode !== "restricted";
  if (!openCors && !isServiceOriginAllowed(origin, configuredOrigins, false)) {
    return { ok: false, message: `Origin is not allowed: ${origin}` };
  }
  const requestedHeaders = normalizeServiceCorsHeaderNames(req.headers["access-control-request-headers"]);
  const defaultHeaders = normalizeServiceCorsHeaderNames(allowHeaders || DEFAULT_SERVICE_CORS_ALLOW_HEADERS);
  const configuredHeaders = Array.isArray(settings.allowedHeaders)
    ? settings.allowedHeaders.flatMap(normalizeServiceCorsHeaderNames)
    : normalizeServiceCorsHeaderNames(settings.allowedHeaders);
  const resolvedHeaders = openCors && requestedHeaders.length
    ? requestedHeaders
    : Array.from(new Set([...defaultHeaders, ...configuredHeaders]));
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", appendVaryHeader(res.getHeader("vary"), "Origin"));
  res.setHeader("vary", appendVaryHeader(res.getHeader("vary"), "Access-Control-Request-Headers"));
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", resolvedHeaders.join(","));
  res.setHeader("access-control-max-age", "600");
  if (openCors) {
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-expose-headers", "*");
  }
  if (String(req.headers["access-control-request-private-network"] || "").toLowerCase() === "true") {
    res.setHeader("access-control-allow-private-network", "true");
  }
  return { ok: true, mode: openCors ? "open" : "restricted", allowedHeaders: resolvedHeaders };
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

function gatewayHeaderValue(headers = {}, name, maxLength = 240) {
  return String(headers[name] || headers[String(name || "").toLowerCase()] || "").trim().slice(0, maxLength);
}

function gatewayHeaderHost(headers = {}, name) {
  const value = gatewayHeaderValue(headers, name);
  if (!value) return "";
  try {
    return new URL(value).host || value;
  } catch {
    return value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].slice(0, 160);
  }
}

function buildServiceGatewayAccessLogEntry(req, res, kind, startedAt, authSource) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const usage = req.serviceGatewayAccessUsage || {};
  const inputTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.generationTokens ?? 0);
  const headers = req.headers || {};
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
    userAgent: gatewayHeaderValue(headers, "user-agent"),
    origin: gatewayHeaderValue(headers, "origin"),
    refererHost: gatewayHeaderHost(headers, "referer"),
    durationMs: Date.now() - startedAt,
    queuedMs: Number(req.serviceGateway?.queuedMs || 0),
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

function clampServiceGatewayNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function serviceGatewayQueueLimit(settings) {
  const concurrency = clampServiceGatewayNumber(settings.maxConcurrentRequests, 1, 256, DEFAULT_GATEWAY_MAX_CONCURRENT);
  return clampServiceGatewayNumber(settings.maxQueuedRequests, 0, 4096, Math.min(256, concurrency * 32));
}

function serviceGatewayQueueTimeoutMs(settings, requestTimeoutMs) {
  const seconds = clampServiceGatewayNumber(settings.queueTimeoutSeconds, 1, 600, 30);
  return Math.min(requestTimeoutMs, seconds * 1000);
}

function removeServiceGatewayWaiter(queue, waiter) {
  const index = queue.indexOf(waiter);
  if (index >= 0) queue.splice(index, 1);
}

function resolveNextServiceGatewayWaiter(settings, clientKey, concurrencyBuckets, concurrencyQueues) {
  const queue = concurrencyQueues.get(clientKey);
  if (!queue) return;
  while (queue.length) {
    const waiter = queue.shift();
    if (!waiter || waiter.cancelled) continue;
    const concurrency = enterServiceConcurrency(settings, clientKey, concurrencyBuckets);
    if (!concurrency.ok) {
      queue.unshift(waiter);
      break;
    }
    waiter.resolve(concurrency);
    break;
  }
  if (!queue.length) concurrencyQueues.delete(clientKey);
}

async function waitForServiceGatewayConcurrency(settings, clientKey, concurrencyBuckets, concurrencyQueues, res, requestTimeoutMs) {
  const concurrency = enterServiceConcurrency(settings, clientKey, concurrencyBuckets);
  if (concurrency.ok) return { ok: true, concurrency, queuedMs: 0 };

  const queueLimit = serviceGatewayQueueLimit(settings);
  if (queueLimit <= 0) {
    return {
      ok: false,
      statusCode: 429,
      code: "concurrency_limit_exceeded",
      message: "Too many concurrent requests for this service key.",
    };
  }

  const queue = concurrencyQueues.get(clientKey) || [];
  if (queue.length >= queueLimit) {
    return {
      ok: false,
      statusCode: 429,
      code: "concurrency_queue_full",
      message: "Too many queued requests for this service key.",
    };
  }

  concurrencyQueues.set(clientKey, queue);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof res.off === "function") res.off("close", onClose);
      resolve(result);
    };
    const waiter = {
      cancelled: false,
      resolve(nextConcurrency) {
        settle({ ok: true, concurrency: nextConcurrency, queuedMs: Date.now() - startedAt });
      },
    };
    const onClose = () => {
      waiter.cancelled = true;
      removeServiceGatewayWaiter(queue, waiter);
      if (!queue.length) concurrencyQueues.delete(clientKey);
      settle({ ok: false, aborted: true });
    };
    timer = setTimeout(() => {
      waiter.cancelled = true;
      removeServiceGatewayWaiter(queue, waiter);
      if (!queue.length) concurrencyQueues.delete(clientKey);
      settle({
        ok: false,
        statusCode: 429,
        code: "concurrency_queue_timeout",
        message: "Timed out waiting for a service gateway concurrency slot.",
      });
    }, serviceGatewayQueueTimeoutMs(settings, requestTimeoutMs));
    if (typeof res.once === "function") res.once("close", onClose);
    queue.push(waiter);
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
    concurrencyQueues = new Map(),
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
      const timeoutMs = Math.min(7200, Math.max(10, Number(effectiveSettings.requestTimeoutSeconds || 600))) * 1000;
      const concurrencySlot = await waitForServiceGatewayConcurrency(effectiveSettings, clientKey, concurrencyBuckets, concurrencyQueues, res, timeoutMs);
      if (!concurrencySlot.ok) {
        if (concurrencySlot.aborted || res.writableEnded) return undefined;
        return serviceGatewayReject(res, concurrencySlot.statusCode || 429, concurrencySlot.code, concurrencySlot.message);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        concurrencySlot.concurrency.release();
        resolveNextServiceGatewayWaiter(effectiveSettings, clientKey, concurrencyBuckets, concurrencyQueues);
      };
      res.once("finish", release);
      res.once("close", release);
      req.serviceGateway = { kind, settings: effectiveSettings, baseSettings: settings, client: serviceClient, clientId: serviceClient?.id || "", clientKey, timeoutMs, queuedMs: concurrencySlot.queuedMs || 0 };
      res.setHeader("x-local-llm-gateway", gatewayName);
      res.setHeader("x-local-llm-queued-ms", String(concurrencySlot.queuedMs || 0));
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
  DEFAULT_OPENAI_BASE_URL_HINT_ROUTES,
  buildGatewayBaseUrl,
  wrongOpenAiBaseUrlError,
  registerOpenAiBaseUrlHintRoutes,
  claudeError,
  claudeGatewayError,
  upstreamErrorMessage,
  sendClaudeUpstreamError,
  isExpectedStreamDisconnect,
  uniqueModelsById,
  servedModelIds,
  deriveOpenAiGatewayModelAliases,
  buildOpenAiGatewayAliasList,
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
