"use strict";

const crypto = require("crypto");

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clipText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeExposureMode(value) {
  const mode = String(value || "local").toLowerCase();
  return ["local", "lan", "reverse-proxy"].includes(mode) ? mode : "local";
}

function normalizeCsvList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  return Array.from(new Set(raw.map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizeUrlText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString().replace(/\/$/, "") : "";
  } catch {
    return "";
  }
}

function hashServiceApiKey(apiKey) {
  return crypto.createHash("sha256").update(String(apiKey || "")).digest("hex");
}

function previewServiceApiKey(apiKey) {
  const text = String(apiKey || "");
  return text ? `${text.slice(0, 7)}...${text.slice(-4)}` : "";
}

function normalizeServiceClientIdBase(value) {
  return String(value || "client")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "client";
}

function uniqueServiceClientId(ledger, value, options = {}) {
  const normalizedLedger = normalizeServiceClientsLedger(ledger);
  const base = normalizeServiceClientIdBase(value);
  const used = new Set((normalizedLedger.clients || []).map((client) => client.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  const suffix = options.suffix || crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

function normalizeServiceClientSecretEngine(engine) {
  return normalizeServiceClientIdBase(engine || "local").slice(0, 24) || "local";
}

function generateServiceClientSecret(engine = "local", options = {}) {
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  return `sk-${normalizeServiceClientSecretEngine(engine)}-${randomBytes(24).toString("base64url")}`;
}

function normalizeServiceExposureSecret(value = {}, previous = {}) {
  if (value.clearApiKey) return { hash: "", preview: "" };
  if (value.apiKey !== undefined) {
    const key = String(value.apiKey || "").trim();
    return key ? { hash: hashServiceApiKey(key), preview: previewServiceApiKey(key) } : { hash: "", preview: "" };
  }
  const previousHash = String(previous.apiKeyHash || "").trim();
  if (previousHash) return { hash: previousHash, preview: String(previous.apiKeyPreview || "") };
  const legacyKey = String(previous.apiKey || "").trim();
  return legacyKey ? { hash: hashServiceApiKey(legacyKey), preview: previewServiceApiKey(legacyKey) } : { hash: "", preview: "" };
}

function normalizeServiceExposureSettings(value = {}, previous = {}, options = {}) {
  const mode = normalizeExposureMode(value.exposureMode || value.mode || previous.exposureMode);
  const apiKeySecret = normalizeServiceExposureSecret(value, previous);
  const allowExposeOpenCode = options.allowExposeOpenCode !== false;
  const defaultExposeOpenCode = Boolean(options.exposeOpenCodeDefault);
  const exposeOpenCode = allowExposeOpenCode
    ? value.exposeOpenCode !== undefined
      ? Boolean(value.exposeOpenCode)
      : previous.exposeOpenCode !== undefined
        ? previous.exposeOpenCode !== false
        : defaultExposeOpenCode
    : false;
  return {
    version: 1,
    enabled: value.enabled !== undefined ? Boolean(value.enabled) : Boolean(previous.enabled),
    exposureMode: mode,
    requireApiKey: value.requireApiKey !== undefined ? Boolean(value.requireApiKey) : mode !== "local",
    apiKey: "",
    apiKeyHash: apiKeySecret.hash,
    apiKeyPreview: apiKeySecret.preview,
    exposeOpenAI: value.exposeOpenAI !== undefined ? Boolean(value.exposeOpenAI) : previous.exposeOpenAI !== false,
    exposeClaude: value.exposeClaude !== undefined ? Boolean(value.exposeClaude) : previous.exposeClaude !== false,
    exposeOpenCode,
    exposeMetrics: Boolean(value.exposeMetrics !== undefined ? value.exposeMetrics : previous.exposeMetrics),
    allowManagerRemote: Boolean(value.allowManagerRemote !== undefined ? value.allowManagerRemote : previous.allowManagerRemote),
    publicBaseUrl: normalizeUrlText(value.publicBaseUrl !== undefined ? value.publicBaseUrl : previous.publicBaseUrl),
    allowedOrigins: normalizeCsvList(value.allowedOrigins !== undefined ? value.allowedOrigins : previous.allowedOrigins).slice(0, 20),
    rateLimitRpm: clampNumber(value.rateLimitRpm !== undefined ? value.rateLimitRpm : previous.rateLimitRpm, 1, 5000, 120),
    maxConcurrentRequests: clampNumber(value.maxConcurrentRequests !== undefined ? value.maxConcurrentRequests : previous.maxConcurrentRequests, 1, 256, 4),
    requestTimeoutSeconds: clampNumber(value.requestTimeoutSeconds !== undefined ? value.requestTimeoutSeconds : previous.requestTimeoutSeconds, 10, 7200, 600),
    notes: String(value.notes !== undefined ? value.notes : previous.notes || "").slice(0, 2000),
    updatedAt: new Date().toISOString(),
  };
}

function redactServiceExposureSettings(settings = {}) {
  return {
    ...settings,
    apiKey: "",
    apiKeyHash: "",
    hasApiKey: hasGlobalServiceApiKey(settings),
    apiKeyPreview: String(settings.apiKeyPreview || ""),
  };
}

function normalizeServiceClientsLedger(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  const clients = Array.isArray(item.clients) ? item.clients.map(normalizeServiceClient).filter(Boolean) : [];
  return {
    version: 1,
    updatedAt: item.updatedAt || null,
    clients,
  };
}

function normalizeServiceClient(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id: clipText(id, 80),
    name: clipText(item.name || id, 80),
    enabled: item.enabled !== false,
    keyHash: String(item.keyHash || ""),
    keyPreview: String(item.keyPreview || ""),
    allowedModels: normalizeCsvList(item.allowedModels).slice(0, 24),
    rateLimitRpm: clampNumber(item.rateLimitRpm, 1, 5000, 120),
    maxConcurrentRequests: clampNumber(item.maxConcurrentRequests, 1, 256, 4),
    requestTimeoutSeconds: clampNumber(item.requestTimeoutSeconds, 10, 7200, 600),
    expiresAt: normalizeDateText(item.expiresAt),
    notes: clipText(item.notes || "", 500),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    lastUsedAt: item.lastUsedAt || null,
    usage: normalizeServiceClientUsage(item.usage),
  };
}

function serviceClientNotFoundError() {
  const error = new Error("Service client not found.");
  error.status = 404;
  return error;
}

function createServiceClientRecord(ledger, input = {}, options = {}) {
  const next = normalizeServiceClientsLedger(ledger);
  const now = options.now || new Date().toISOString();
  const apiKey = options.apiKey || generateServiceClientSecret(options.engine || "local", options);
  const name = clipText(input.name || "Local service client", 80);
  const id = uniqueServiceClientId(next, input.id || name, options);
  const client = normalizeServiceClient({
    id,
    name,
    enabled: input.enabled !== false,
    keyHash: hashServiceApiKey(apiKey),
    keyPreview: previewServiceApiKey(apiKey),
    allowedModels: input.allowedModels || [],
    rateLimitRpm: input.rateLimitRpm,
    maxConcurrentRequests: input.maxConcurrentRequests,
    requestTimeoutSeconds: input.requestTimeoutSeconds,
    expiresAt: input.expiresAt,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  });
  next.clients.push(client);
  return { ledger: next, apiKey, client };
}

function updateServiceClientRecord(ledger, id, input = {}, options = {}) {
  const next = normalizeServiceClientsLedger(ledger);
  const index = next.clients.findIndex((client) => client.id === id);
  if (index < 0) throw serviceClientNotFoundError();
  const previous = next.clients[index];
  const updated = normalizeServiceClient({
    ...previous,
    ...input,
    id: previous.id,
    keyHash: previous.keyHash,
    keyPreview: previous.keyPreview,
    updatedAt: options.now || new Date().toISOString(),
  });
  next.clients[index] = updated;
  return { ledger: next, client: updated };
}

function rotateServiceClientKeyRecord(ledger, id, options = {}) {
  const next = normalizeServiceClientsLedger(ledger);
  const index = next.clients.findIndex((client) => client.id === id);
  if (index < 0) throw serviceClientNotFoundError();
  const apiKey = options.apiKey || generateServiceClientSecret(options.engine || "local", options);
  const updated = normalizeServiceClient({
    ...next.clients[index],
    keyHash: hashServiceApiKey(apiKey),
    keyPreview: previewServiceApiKey(apiKey),
    updatedAt: options.now || new Date().toISOString(),
  });
  next.clients[index] = updated;
  return { ledger: next, apiKey, client: updated };
}

function deleteServiceClientRecord(ledger, id) {
  const next = normalizeServiceClientsLedger(ledger);
  const before = next.clients.length;
  next.clients = next.clients.filter((client) => client.id !== id);
  return { ledger: next, removed: before - next.clients.length, id };
}

function resolveServiceClientForApiKey(ledger, apiKey, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return null;
  const hash = hashServiceApiKey(key);
  const nowMs = options.nowMs ?? Date.now();
  const normalized = normalizeServiceClientsLedger(ledger);
  const client = (normalized.clients || []).find((item) => item.keyHash === hash);
  if (!client || client.enabled === false) return null;
  if (client.expiresAt && new Date(client.expiresAt).getTime() <= nowMs) return null;
  return client;
}

function serviceClientAllowsModel(client, model, options = {}) {
  if (!client) return true;
  const allowed = (client.allowedModels || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || allowed.includes("*")) return true;
  const value = String(model || "").toLowerCase();
  const roots = (options.roots || []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  return allowed.some((item) => item === value || roots.includes(item));
}

function normalizeServiceClientUsage(value = {}) {
  const item = value && typeof value === "object" ? value : {};
  const prompt = Number(item.tokens?.prompt || 0);
  const generation = Number(item.tokens?.generation || 0);
  const total = item.tokens?.total !== undefined ? Number(item.tokens.total || 0) : prompt + generation;
  return {
    requests: {
      total: Number(item.requests?.total || 0),
      success: Number(item.requests?.success || 0),
      error: Number(item.requests?.error || 0),
    },
    tokens: {
      prompt,
      generation,
      total,
    },
    lastStatus: Number(item.lastStatus || 0),
    lastModel: item.lastModel || "",
    lastAt: item.lastAt || null,
  };
}

function applyServiceClientUsage(client, event = {}, options = {}) {
  const normalized = normalizeServiceClient(client);
  if (!normalized) return null;
  const usage = normalizeServiceClientUsage(normalized.usage);
  const prompt = Number(event.usage?.prompt_tokens || event.usage?.input_tokens || event.promptTokens || 0);
  const generation = Number(event.usage?.completion_tokens || event.usage?.output_tokens || event.generationTokens || 0);
  const ok = event.ok !== false;
  usage.requests.total += 1;
  if (ok) usage.requests.success += 1;
  else usage.requests.error += 1;
  usage.tokens.prompt += prompt;
  usage.tokens.generation += generation;
  usage.tokens.total = usage.tokens.prompt + usage.tokens.generation;
  usage.lastStatus = Number(event.status || 0);
  usage.lastModel = String(event.model || "");
  usage.lastAt = options.now || new Date().toISOString();
  return {
    client: normalizeServiceClient({
      ...normalized,
      lastUsedAt: usage.lastAt,
      updatedAt: normalized.updatedAt,
      usage,
    }),
    event: {
      clientId: normalized.id,
      model: usage.lastModel,
      status: usage.lastStatus,
      ok,
      promptTokens: prompt,
      generationTokens: generation,
      totalTokens: prompt + generation,
    },
  };
}

function redactServiceClientsLedger(ledger = {}) {
  return {
    version: 1,
    updatedAt: ledger.updatedAt || null,
    clients: (ledger.clients || []).map(redactServiceClient),
  };
}

function redactServiceClient(client = {}) {
  return {
    id: client.id,
    name: client.name,
    enabled: client.enabled,
    keyPreview: client.keyPreview,
    allowedModels: client.allowedModels || [],
    rateLimitRpm: client.rateLimitRpm,
    maxConcurrentRequests: client.maxConcurrentRequests,
    requestTimeoutSeconds: client.requestTimeoutSeconds,
    expiresAt: client.expiresAt || "",
    notes: client.notes || "",
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    lastUsedAt: client.lastUsedAt || null,
    usage: normalizeServiceClientUsage(client.usage),
  };
}

function normalizeDateText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function isServiceApiKeyAccepted(presented, expected) {
  const left = Buffer.from(String(presented || ""));
  const right = Buffer.from(String(expected || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hasGlobalServiceApiKey(settings = {}) {
  return Boolean(settings.apiKeyHash || settings.apiKey);
}

function isGlobalServiceApiKeyAccepted(presented, settings = {}) {
  const key = String(presented || "").trim();
  if (!key) return false;
  if (settings.apiKeyHash) return hashServiceApiKey(key) === settings.apiKeyHash;
  return Boolean(settings.apiKey && isServiceApiKeyAccepted(key, settings.apiKey));
}

function hasActiveServiceClients(ledger = {}) {
  return (ledger.clients || []).some((client) => client.enabled !== false && (!client.expiresAt || new Date(client.expiresAt).getTime() > Date.now()));
}

function serviceCheck(status, title, detail) {
  return { status, title, detail };
}

const DEFAULT_SERVICE_EXPOSURE_COPY = {
  serviceTitle: "模型服务状态",
  serviceRunning: "模型服务正在运行。",
  serviceStopped: "当前没有运行中的模型服务，保存设置后仍需要启动模型。",
  dockerTitle: "Docker",
  dockerOk: "Docker daemon 可用。",
  dockerFail: "Docker 不可用，无法对外提供服务。",
  localNetworkTitle: "网络绑定",
  localNetworkOk: "当前只绑定本机，适合个人客户端。",
  localNetworkLan: ({ lanAddress }) => `当前 Docker 容器已经发布到 ${lanAddress}，局域网可访问。`,
  lanTitle: "局域网访问",
  lanOk: ({ lanAddress }) => `Docker 已把容器端口转发到本机地址 ${lanAddress}。`,
  lanMissing: "需要在启动表单里把服务访问范围改为“局域网设备可访问”并重启模型。",
  apiKeyTitle: "API Key",
  gatewayApiKeyOk: "管理器网关会强制 Bearer Token；对外推荐使用 /serve/v1 或 /claude。",
  runtimeApiKeyOk: "运行中的推理服务已启用 Bearer Token。",
  apiKeyMissing: "计划对外提供服务，但尚未配置可执行的 API Key。",
  directContainerTitle: "直连容器端口",
  directContainerWarn: "容器 LAN 端口不经过管理器网关鉴权；对外用户应连接管理器网关。",
  remoteTitle: "远程管理",
  remoteWarn: ({ envVar }) => `设置页计划开放管理器桥接，但当前进程未设置 ${envVar}。`,
  publicTitle: "公网入口",
  publicOk: "已填写公网/反代地址。",
  publicMissing: "反代模式需要填写 public base URL，建议由 Caddy/Nginx/Cloudflare Tunnel 处理 TLS 和鉴权。",
  rateTitle: "网关限流",
  rateDetail: ({ rateLimitRpm, maxConcurrentRequests }) => `管理器网关强制 ${rateLimitRpm} req/min、最大并发 ${maxConcurrentRequests}；直连容器端口不受此限制。`,
};

function serviceExposureCopy(copy, key, context = {}) {
  const value = { ...DEFAULT_SERVICE_EXPOSURE_COPY, ...(copy || {}) }[key];
  if (typeof value === "function") return value(context);
  return String(value || "");
}

function buildServiceClientsSummary(ledger = {}, options = {}) {
  const normalized = normalizeServiceClientsLedger(ledger);
  const nowMs = options.nowMs ?? Date.now();
  const active = normalized.clients.filter((client) => client.enabled !== false && (!client.expiresAt || new Date(client.expiresAt).getTime() > nowMs)).length;
  return {
    total: normalized.clients.length,
    active,
  };
}

function normalizeGatewayPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function joinBaseAndPath(baseUrl, routePath) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  const path = normalizeGatewayPath(routePath);
  return path ? `${base}${path}` : base;
}

function buildServiceExposurePayloadSnapshot(settings = {}, context = {}, options = {}) {
  const endpoint = context.endpoint || {};
  const runtime = context.runtime || {};
  const container = context.container || {};
  const clientsLedger = context.clientsLedger || {};
  const docker = context.docker || {};
  const managerHost = String(options.managerHost || "127.0.0.1");
  const managerPort = options.managerPort || options.port || 0;
  const lanAddress = options.lanAddress || endpoint.lanHost || "127.0.0.1";
  const managerLocalBaseUrl = options.managerLocalBaseUrl || `http://127.0.0.1:${managerPort}`;
  const managerLanBaseUrl = options.managerLanBaseUrl !== undefined
    ? options.managerLanBaseUrl
    : managerHost === "127.0.0.1"
      ? null
      : `http://${lanAddress}:${managerPort}`;
  const openAiGatewayPath = normalizeGatewayPath(options.openAiGatewayPath || "/serve/v1");
  const claudeBasePath = normalizeGatewayPath(options.claudeBasePath || "/claude");
  const claudeMessagesPath = normalizeGatewayPath(options.claudeMessagesPath || `${claudeBasePath}/v1/messages`);
  const openCodeBasePath = normalizeGatewayPath(options.openCodeBasePath || "");
  const defaultServicePort = options.defaultServicePort || endpoint.port || null;
  const enrichedContext = {
    ...context,
    endpoint,
    runtime,
    container,
    clientsLedger,
    docker,
    lanAddress,
    remoteManagementAllowed: Boolean(options.remoteManagementAllowed),
  };
  const checks = typeof options.buildChecks === "function"
    ? options.buildChecks(settings, enrichedContext)
    : buildServiceExposureChecks(settings, enrichedContext, options.checkOptions || {});

  return {
    settings: redactServiceExposureSettings(settings),
    actual: {
      manager: {
        localBaseUrl: managerLocalBaseUrl,
        lanBaseUrl: managerLanBaseUrl,
        host: managerHost,
        port: managerPort,
        remoteManagementAllowed: Boolean(options.remoteManagementAllowed),
      },
      service: {
        running: Boolean(container.running),
        containerStatus: container.status || "",
        boundHost: endpoint.boundHost || "127.0.0.1",
        localHost: endpoint.localHost || "127.0.0.1",
        lanHost: endpoint.lanHost || null,
        dockerPublishedHosts: endpoint.publishedHosts || [],
        port: endpoint.port || defaultServicePort,
        openAiGatewayLocalBaseUrl: joinBaseAndPath(managerLocalBaseUrl, openAiGatewayPath),
        openAiGatewayLanBaseUrl: managerLanBaseUrl ? joinBaseAndPath(managerLanBaseUrl, openAiGatewayPath) : null,
        openAiLocalBaseUrl: endpoint.compat?.openai?.baseUrl || endpoint.localUrl || "",
        openAiLanBaseUrl: endpoint.compat?.openai?.lanBaseUrl || null,
        claudeLocalBaseUrl: endpoint.compat?.claude?.baseUrl || joinBaseAndPath(managerLocalBaseUrl, claudeBasePath),
        claudeLanBaseUrl: endpoint.compat?.claude?.publicBaseUrl || (managerLanBaseUrl ? joinBaseAndPath(managerLanBaseUrl, claudeBasePath) : null),
        claudeLocalMessagesUrl: endpoint.compat?.claude?.messagesUrl || joinBaseAndPath(managerLocalBaseUrl, claudeMessagesPath),
        claudeLanMessagesUrl: managerLanBaseUrl ? joinBaseAndPath(managerLanBaseUrl, claudeMessagesPath) : null,
        claudePublicBaseUrl: endpoint.compat?.claude?.publicBaseUrl || null,
        openCodeBaseUrl: openCodeBasePath ? joinBaseAndPath(managerLocalBaseUrl, openCodeBasePath) : "",
        modelIds: (runtime.servedModels || []).map((model) => model.id).filter(Boolean),
        maxModelLen: runtime.servedModels?.[0]?.max_model_len || runtime.models?.[0]?.maxModelLen || null,
        apiKeyRequired: Boolean(options.runtimeApiKeySupported && runtime.apiKeyRequired),
        clients: buildServiceClientsSummary(clientsLedger),
      },
      docker,
    },
    checks,
  };
}

function buildServiceExposureChecks(settings = {}, context = {}, options = {}) {
  const checks = [];
  const mode = normalizeExposureMode(settings.exposureMode);
  const copy = options.copy || {};
  const lanAddress = context.endpoint?.lanHost || context.lanAddress || "127.0.0.1";
  const serviceRunning = Boolean(context.container?.running);
  const lanBound = Boolean(context.endpoint?.lanUrl);
  const runtimeApiKeyActive = Boolean(context.runtime?.apiKeyRequired);
  const gatewayApiKeyActive = Boolean(settings.requireApiKey && (hasGlobalServiceApiKey(settings) || hasActiveServiceClients(context.clientsLedger || {})));
  const allowRuntimeApiKey = options.allowRuntimeApiKey === true;
  const remoteManagementAllowed = Boolean(context.remoteManagementAllowed);
  const remoteRequiresClaudeExposure = options.remoteRequiresClaudeExposure === true;
  const rateLimitRpm = clampNumber(settings.rateLimitRpm, 1, 5000, 120);
  const maxConcurrentRequests = clampNumber(settings.maxConcurrentRequests, 1, 256, 4);

  checks.push(serviceCheck(
    serviceRunning ? "ok" : "warn",
    serviceExposureCopy(copy, "serviceTitle"),
    serviceExposureCopy(copy, serviceRunning ? "serviceRunning" : "serviceStopped"),
  ));
  checks.push(serviceCheck(
    context.docker?.ok ? "ok" : "fail",
    serviceExposureCopy(copy, "dockerTitle"),
    serviceExposureCopy(copy, context.docker?.ok ? "dockerOk" : "dockerFail"),
  ));

  if (mode === "local") {
    checks.push(serviceCheck(
      !lanBound ? "ok" : "warn",
      serviceExposureCopy(copy, "localNetworkTitle"),
      lanBound
        ? serviceExposureCopy(copy, "localNetworkLan", { lanAddress })
        : serviceExposureCopy(copy, "localNetworkOk", { lanAddress }),
    ));
  } else {
    checks.push(serviceCheck(
      lanBound ? "ok" : "warn",
      serviceExposureCopy(copy, "lanTitle"),
      lanBound
        ? serviceExposureCopy(copy, "lanOk", { lanAddress })
        : serviceExposureCopy(copy, "lanMissing", { lanAddress }),
    ));
    checks.push(serviceCheck(
      gatewayApiKeyActive || (allowRuntimeApiKey && runtimeApiKeyActive) ? "ok" : "fail",
      serviceExposureCopy(copy, "apiKeyTitle"),
      gatewayApiKeyActive
        ? serviceExposureCopy(copy, "gatewayApiKeyOk")
        : allowRuntimeApiKey && runtimeApiKeyActive
          ? serviceExposureCopy(copy, "runtimeApiKeyOk")
          : serviceExposureCopy(copy, "apiKeyMissing"),
    ));

    const directWarningMode = options.warnDirectContainerWhen || "lan-bound";
    const warnDirectContainer = directWarningMode === "lan-bound-without-runtime-api-key"
      ? lanBound && !runtimeApiKeyActive
      : directWarningMode !== "never" && lanBound;
    if (warnDirectContainer) {
      checks.push(serviceCheck(
        "warn",
        serviceExposureCopy(copy, "directContainerTitle"),
        serviceExposureCopy(copy, "directContainerWarn"),
      ));
    }
  }

  if (mode === "reverse-proxy") {
    checks.push(serviceCheck(
      settings.publicBaseUrl ? "ok" : "warn",
      serviceExposureCopy(copy, "publicTitle"),
      serviceExposureCopy(copy, settings.publicBaseUrl ? "publicOk" : "publicMissing"),
    ));
  }

  const shouldWarnRemote = settings.allowManagerRemote
    && !remoteManagementAllowed
    && (!remoteRequiresClaudeExposure || settings.exposeClaude);
  if (shouldWarnRemote) {
    checks.push(serviceCheck(
      "warn",
      serviceExposureCopy(copy, "remoteTitle"),
      serviceExposureCopy(copy, "remoteWarn", { envVar: options.remoteEnvVar || "MANAGER_ALLOW_REMOTE=1" }),
    ));
  }

  checks.push(serviceCheck(
    rateLimitRpm <= 600 ? "ok" : "warn",
    serviceExposureCopy(copy, "rateTitle"),
    serviceExposureCopy(copy, "rateDetail", { rateLimitRpm, maxConcurrentRequests }),
  ));
  return checks;
}

function buildEffectiveServiceSettings(settings, client) {
  if (!client) return settings;
  return {
    ...settings,
    rateLimitRpm: client.rateLimitRpm || settings.rateLimitRpm,
    maxConcurrentRequests: client.maxConcurrentRequests || settings.maxConcurrentRequests,
    requestTimeoutSeconds: client.requestTimeoutSeconds || settings.requestTimeoutSeconds,
  };
}

function enterServiceRateLimit(settings, clientKey, buckets, now = Date.now()) {
  const limit = clampNumber(settings.rateLimitRpm, 1, 5000, 120);
  const windowMs = 60 * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const previous = buckets.get(clientKey);
  const bucket = previous && previous.windowStart === windowStart ? previous : { windowStart, count: 0 };
  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  }
  bucket.count += 1;
  buckets.set(clientKey, bucket);
  if (buckets.size > 5000) pruneServiceRateBuckets(buckets, windowStart);
  return { ok: true, remaining: Math.max(0, limit - bucket.count) };
}

function pruneServiceRateBuckets(buckets, currentWindowStart) {
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket || bucket.windowStart < currentWindowStart) buckets.delete(key);
  }
}

function enterServiceConcurrency(settings, clientKey, buckets) {
  const limit = clampNumber(settings.maxConcurrentRequests, 1, 256, 4);
  const current = Number(buckets.get(clientKey) || 0);
  if (current >= limit) return { ok: false };
  buckets.set(clientKey, current + 1);
  return {
    ok: true,
    release: () => {
      const next = Math.max(0, Number(buckets.get(clientKey) || 0) - 1);
      if (next) buckets.set(clientKey, next);
      else buckets.delete(clientKey);
    },
  };
}

module.exports = {
  applyServiceClientUsage,
  buildEffectiveServiceSettings,
  buildServiceClientsSummary,
  buildServiceExposureChecks,
  buildServiceExposurePayloadSnapshot,
  createServiceClientRecord,
  deleteServiceClientRecord,
  enterServiceConcurrency,
  enterServiceRateLimit,
  generateServiceClientSecret,
  hasActiveServiceClients,
  hasGlobalServiceApiKey,
  hashServiceApiKey,
  isGlobalServiceApiKeyAccepted,
  isServiceApiKeyAccepted,
  normalizeCsvList,
  normalizeDateText,
  normalizeExposureMode,
  normalizeServiceClient,
  normalizeServiceClientIdBase,
  normalizeServiceClientsLedger,
  normalizeServiceClientUsage,
  normalizeServiceExposureSecret,
  normalizeServiceExposureSettings,
  normalizeUrlText,
  previewServiceApiKey,
  pruneServiceRateBuckets,
  redactServiceClient,
  redactServiceClientsLedger,
  redactServiceExposureSettings,
  resolveServiceClientForApiKey,
  rotateServiceClientKeyRecord,
  serviceCheck,
  serviceClientAllowsModel,
  uniqueServiceClientId,
  updateServiceClientRecord,
};
