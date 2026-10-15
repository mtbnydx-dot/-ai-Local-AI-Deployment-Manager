const crypto = require("node:crypto");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { parseJsonSafe, waitForWritable } = require("./common-utils");
const { normalizeRemoteAddress } = require("./network");
const { newDirectRequestId } = require("./telemetry/ids");
const { classifyOutcome } = require("./telemetry/error-class");
const {
  GATEWAY_CLIENT_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  createGatewayTrustReader,
  resolveRequestOrigin,
} = require("./gateway-trust");
const {
  buildEffectiveServiceSettings,
  enterServiceConcurrency,
  enterServiceRateLimit,
  hasActiveServiceClients,
  hasGlobalServiceApiKey,
  globalServiceBillingClientId,
  hashServiceApiKey,
  isGlobalServiceApiKeyAccepted,
  resolveEffectiveCorsMode,
  DEFAULT_GATEWAY_MAX_CONCURRENT,
} = require("./service-policy");

const SERVICE_ENTRY_INSTANCE_HEADER = "x-service-entry-instance-id";
const SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER = "x-service-entry-instance-signature";

function normalizeServiceEntryInstanceId(value) {
  const text = String(Array.isArray(value) ? value[0] : value || "").trim();
  if (!text || text.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(text)) return "";
  return text;
}

function signServiceEntryInstance(token, instanceId, clientAddress, timestamp) {
  const selected = normalizeServiceEntryInstanceId(instanceId);
  if (!token || !selected || !clientAddress || !timestamp) return "";
  return crypto.createHmac("sha256", String(token))
    .update(`instance\n${selected}\n${String(clientAddress)}\n${String(timestamp)}`, "utf8")
    .digest("base64url");
}

function buildServiceEntryInstanceHeaders(token, instanceId, trustHeaders = {}) {
  const selected = normalizeServiceEntryInstanceId(instanceId);
  const clientAddress = gatewayHeaderValue(trustHeaders, GATEWAY_CLIENT_HEADER);
  const timestamp = gatewayHeaderValue(trustHeaders, GATEWAY_TIMESTAMP_HEADER);
  const signature = signServiceEntryInstance(token, selected, clientAddress, timestamp);
  if (!signature) return {};
  return {
    [SERVICE_ENTRY_INSTANCE_HEADER]: selected,
    [SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER]: signature,
  };
}

function safeGatewaySignatureEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return Boolean(a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
}

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

function findServedModelByRoot(requestedModel, runtime = {}) {
  const value = String(requestedModel || "").trim().toLowerCase();
  if (!value) return "";
  const entries = [...(runtime.servedModels || []), ...(runtime.models || [])];
  const matched = entries.find((item) => item && typeof item === "object"
    && String(item.root || "").trim().toLowerCase() === value);
  return String(matched?.id || "");
}

function pushUniqueModelAlias(result, seen, alias) {
  const value = String(alias || "").trim();
  if (!value) return;
  const key = value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  result.push(value);
}

// Short versioned aliases a client may send for a served model ("Qwen3.6-27B"
// also answers to "qwen3.6"). The stems are alias data, not a branch per model
// family (D5): a lower-case name stem, an optional letter before the version
// (DeepSeek's "r") and the alias prefix.
const VERSIONED_ALIAS_STEMS = Object.freeze([
  { stem: "qwen", infix: "", prefix: "qwen" },
  { stem: "llama", infix: "", prefix: "llama" },
  { stem: "gemma", infix: "", prefix: "gemma" },
  { stem: "deepseek", infix: "r", prefix: "deepseek-r" },
].map((item) => Object.freeze({
  prefix: item.prefix,
  regex: new RegExp(`(?:^|[^a-z0-9])${item.stem}[-_\\s]?${item.infix ? `${item.infix}[-_\\s]?(\\d+)` : "(\\d+(?:\\.\\d+)?)"}`, "i"),
})));

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
    for (const { regex, prefix } of VERSIONED_ALIAS_STEMS) {
      const version = text.match(regex);
      if (version) pushUniqueModelAlias(result, seen, `${prefix}${version[1]}`);
    }
  }
  return result;
}

function buildOpenAiGatewayAliasList({ aliases = [], models = [], runtime = {} } = {}) {
  const result = [];
  const seen = new Set();
  const suppliedModelIds = Array.isArray(models)
    ? models.map((model) => (typeof model === "string" ? model : model?.id)).filter(Boolean)
    : [];
  const runtimeModelIds = servedModelIds(runtime);
  const modelIds = suppliedModelIds.length ? suppliedModelIds : runtimeModelIds;
  // Configured generic aliases are public API names. Dynamic aliases, however,
  // must come only from the caller's authorized model subset rather than the
  // runtime's wider inventory.
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    pushUniqueModelAlias(result, seen, alias);
  }
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
  const servedRootMatch = findServedModelByRoot(value, runtime);
  if (servedRootMatch) return servedRootMatch;
  const rootMappings = typeof options.getRootMappings === "function" ? options.getRootMappings(runtime) : options.rootMappings;
  const rootMatch = (Array.isArray(rootMappings) ? rootMappings : [])
    .find((entry) => entry?.root === value || String(entry?.root || "").toLowerCase() === value.toLowerCase());
  return rootMatch?.id || "";
}

function buildOpenAiGatewayModelList({ models = [], runtime = {}, aliases = [], owner = "local-manager" } = {}) {
  const fallback = models[0] || runtime.servedModels?.[0] || runtime.models?.[0] || {};
  const allAliases = buildOpenAiGatewayAliasList({ aliases, models, runtime });
  const aliasModels = allAliases.map((id) => ({
    id,
    object: "model",
    created: fallback.created || Math.floor(Date.now() / 1000),
    owned_by: owner,
  }));
  const data = uniqueModelsById([...aliasModels, ...models]).map((model) => {
    const publicModel = {
      id: String(model?.id || ""),
      object: String(model?.object || "model"),
      owned_by: String(model?.owned_by || model?.ownedBy || owner),
    };
    if (Number.isFinite(Number(model?.created))) publicModel.created = Number(model.created);
    const capabilities = Array.isArray(model?.capabilities)
      ? model.capabilities.map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => ["text", "vision", "audio", "embedding", "rerank", "tools"].includes(item))
      : [];
    if (capabilities.length) publicModel.capabilities = Array.from(new Set(capabilities));
    return publicModel;
  });
  return { object: "list", data };
}

const OPENAI_GATEWAY_REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_OPENAI_SSE_USAGE_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_OPENAI_SSE_ESTIMATE_SAMPLE_BYTES = 1024 * 1024;
const OPENAI_BILLING_TEXT_LIMIT = 4 * 1024 * 1024;
const OPENAI_BILLING_MAX_ESTIMATED_TOKENS = 100_000_000;
const OPENAI_BILLING_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function normalizeOpenAiGatewayRequestId(value) {
  const text = String(Array.isArray(value) ? value[0] : value || "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > 128 || !/^[a-zA-Z0-9._:/-]+$/.test(text)) return "";
  return text;
}

// The verified entry hop of a request (hop v2, 05 PUB-10), or null when the
// request is direct ingress: no hop, a v1 hop or a bad signature.
function verifiedEntryHop(req) {
  try {
    const origin = resolveGatewayRequestOrigin(req);
    if (!origin.viaGateway || !origin.trusted || origin.version !== 2) return null;
    return origin;
  } catch {
    return null;
  }
}

// An id the entry minted rides on the signed hop and wins over any header; a
// direct call keeps a valid client id and otherwise gets a `mgr_` id (04 §5.1).
function ensureOpenAiGatewayRequestId(req) {
  const hopId = req?.serviceGateway?.requestId ? "" : normalizeOpenAiGatewayRequestId(verifiedEntryHop(req)?.requestId);
  const existing = hopId || normalizeOpenAiGatewayRequestId(
    req?.serviceGateway?.requestId || req?.headers?.[OPENAI_GATEWAY_REQUEST_ID_HEADER],
  );
  const requestId = existing || newDirectRequestId();
  if (req && typeof req === "object") {
    if (!req.serviceGateway || typeof req.serviceGateway !== "object") req.serviceGateway = {};
    req.serviceGateway.requestId = requestId;
  }
  return requestId;
}

function mergeOpenAiGatewayRequestId(headers, requestId) {
  const merged = {};
  if (headers && typeof headers.forEach === "function" && !(headers instanceof Array)) {
    headers.forEach((value, key) => {
      if (String(key).toLowerCase() !== OPENAI_GATEWAY_REQUEST_ID_HEADER) merged[key] = value;
    });
  } else {
    for (const [key, value] of Object.entries(headers || {})) {
      if (String(key).toLowerCase() !== OPENAI_GATEWAY_REQUEST_ID_HEADER) merged[key] = value;
    }
  }
  merged[OPENAI_GATEWAY_REQUEST_ID_HEADER] = requestId;
  return merged;
}

function readOpenAiUsageToken(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "number" && typeof value !== "string") continue;
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= 0) return number;
  }
  return undefined;
}

function normalizeOpenAiUsage(rawUsage, options = {}) {
  const source = rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage) ? rawUsage : null;
  if (!source) {
    return {
      usage: null,
      usageSource: "missing",
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      cachedTokens: undefined,
    };
  }

  const inputTokens = readOpenAiUsageToken(source, [
    "prompt_tokens", "promptTokens", "input_tokens", "inputTokens",
  ]);
  const outputTokens = readOpenAiUsageToken(source, [
    "completion_tokens", "completionTokens", "output_tokens", "outputTokens",
  ]);
  const reportedTotalTokens = readOpenAiUsageToken(source, ["total_tokens", "totalTokens"]);
  const cachedTokens = readOpenAiUsageToken(source, [
    "cached_tokens", "cachedTokens", "cached_prompt_tokens", "cachedPromptTokens", "cache_read_input_tokens",
  ]) ?? readOpenAiUsageToken(source.prompt_tokens_details, ["cached_tokens", "cachedTokens"])
    ?? readOpenAiUsageToken(source.input_tokens_details, ["cached_tokens", "cachedTokens"])
    ?? readOpenAiUsageToken(source.promptTokensDetails, ["cached_tokens", "cachedTokens"])
    ?? readOpenAiUsageToken(source.inputTokensDetails, ["cached_tokens", "cachedTokens"]);
  const hasReportedTokens = [inputTokens, outputTokens, reportedTotalTokens, cachedTokens]
    .some((value) => value !== undefined);
  if (!hasReportedTokens) {
    return {
      usage: null,
      usageSource: "missing",
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      cachedTokens: undefined,
    };
  }

  const totalTokens = reportedTotalTokens !== undefined
    ? reportedTotalTokens
    : (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const usage = { ...source };
  if (inputTokens !== undefined) {
    usage.prompt_tokens = inputTokens;
    usage.input_tokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    usage.completion_tokens = outputTokens;
    usage.output_tokens = outputTokens;
  }
  if (totalTokens !== undefined) usage.total_tokens = totalTokens;
  if (cachedTokens !== undefined) usage.cached_tokens = cachedTokens;
  return {
    usage,
    usageSource: options.estimated === true ? "estimated" : "reported",
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens,
  };
}

function extractOpenAiUsagePayload(data) {
  if (!data || typeof data !== "object") return null;
  return data.usage || data.response?.usage || null;
}

function findSseEventBoundary(text) {
  let boundary = null;
  for (const separator of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const index = text.indexOf(separator);
    if (index >= 0 && (!boundary || index < boundary.index)) boundary = { index, length: separator.length };
  }
  return boundary;
}

function createOpenAiStreamOutputEstimator(options = {}) {
  const configuredSampleBytes = Number(options.maxSampleBytes || DEFAULT_OPENAI_SSE_ESTIMATE_SAMPLE_BYTES);
  const maxSampleBytes = Number.isFinite(configuredSampleBytes)
    ? Math.max(4096, Math.min(OPENAI_BILLING_TEXT_LIMIT, Math.floor(configuredSampleBytes)))
    : DEFAULT_OPENAI_SSE_ESTIMATE_SAMPLE_BYTES;
  const channelWordContinuation = new Map();
  let sampledBytes = 0;
  let overflowBytes = 0;
  let cjkCharacters = 0;
  let wordRuns = 0;
  let punctuationCharacters = 0;
  let observedOutput = false;

  const observeText = (value, channel = "output") => {
    if (typeof value !== "string" || !value.length) return;
    observedOutput = true;
    const totalBytes = Buffer.byteLength(value, "utf8");
    const remaining = Math.max(0, maxSampleBytes - sampledBytes);
    const channelKey = channelWordContinuation.has(channel) || channelWordContinuation.size < 256
      ? String(channel)
      : "overflow";
    let inWord = channelWordContinuation.get(channelKey) === true;
    let usedBytes = 0;
    const observeCodeUnit = (code, char) => {
      const isCjk = code >= 0x3400 && code <= 0x9fff;
      const isAsciiAlphaNumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      const isWordCharacter = isAsciiAlphaNumeric || char === "_" || char === "." || char === "/" || char === ":" || char === "-";
      if (isCjk) cjkCharacters += 1;
      if (isWordCharacter) {
        if (!inWord) wordRuns += 1;
        inWord = true;
      } else {
        inWord = false;
      }
      if (!/\s/.test(char) && !isAsciiAlphaNumeric && char !== "_" && !isCjk) punctuationCharacters += 1;
    };
    for (let index = 0; index < value.length && usedBytes < remaining; index += 1) {
      const code = value.charCodeAt(index);
      const pairedSurrogate = code >= 0xd800 && code <= 0xdbff
        && index + 1 < value.length
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff;
      const encodedBytes = code <= 0x7f ? 1 : (code <= 0x7ff ? 2 : (pairedSurrogate ? 4 : 3));
      if (usedBytes + encodedBytes > remaining) break;
      observeCodeUnit(code, value[index]);
      if (pairedSurrogate) {
        index += 1;
        observeCodeUnit(value.charCodeAt(index), value[index]);
      }
      usedBytes += encodedBytes;
    }
    sampledBytes += usedBytes;
    overflowBytes = Math.min(
      OPENAI_BILLING_MAX_ESTIMATED_TOKENS * 4,
      overflowBytes + Math.max(0, totalBytes - usedBytes),
    );
    channelWordContinuation.set(channelKey, inWord);
  };

  return {
    observeText,
    hasObservedOutput() {
      return observedOutput;
    },
    estimateTokens() {
      if (!observedOutput) return 0;
      const sampledEstimate = Math.ceil(cjkCharacters * 0.9 + wordRuns * 1.3 + punctuationCharacters * 0.35);
      const overflowEstimate = Math.ceil(overflowBytes / 4);
      return Math.min(
        OPENAI_BILLING_MAX_ESTIMATED_TOKENS,
        Math.max(1, sampledEstimate + overflowEstimate),
      );
    },
  };
}

function observeOpenAiStreamContent(estimator, value, channel, depth = 0) {
  if (!estimator || value === null || value === undefined || depth > 3) return;
  if (typeof value === "string") {
    estimator.observeText(value, channel);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 256); index += 1) {
      observeOpenAiStreamContent(estimator, value[index], `${channel}.${index}`, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const key of ["text", "content", "value", "output_text", "transcript"]) {
    if (value[key] !== undefined) observeOpenAiStreamContent(estimator, value[key], `${channel}.${key}`, depth + 1);
  }
}

function observeOpenAiStreamFunction(estimator, value, channel) {
  if (!value || typeof value !== "object") return;
  if (typeof value.name === "string") estimator.observeText(value.name, `${channel}.name`);
  if (typeof value.arguments === "string") estimator.observeText(value.arguments, `${channel}.arguments`);
}

function observeOpenAiStreamDelta(estimator, data) {
  if (!estimator || !data || typeof data !== "object") return;
  const choices = Array.isArray(data.choices) ? data.choices.slice(0, 256) : [];
  for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
    const choice = choices[choiceIndex];
    if (!choice || typeof choice !== "object") continue;
    if (typeof choice.text === "string") estimator.observeText(choice.text, `choice.${choiceIndex}.text`);
    const delta = choice.delta;
    if (!delta || typeof delta !== "object") continue;
    observeOpenAiStreamContent(estimator, delta.content, `choice.${choiceIndex}.content`);
    observeOpenAiStreamContent(estimator, delta.reasoning_content, `choice.${choiceIndex}.reasoning_content`);
    observeOpenAiStreamContent(estimator, delta.reasoning, `choice.${choiceIndex}.reasoning`);
    observeOpenAiStreamContent(estimator, delta.reasoning_text, `choice.${choiceIndex}.reasoning_text`);
    observeOpenAiStreamContent(estimator, delta.refusal, `choice.${choiceIndex}.refusal`);
    observeOpenAiStreamContent(estimator, delta.audio?.transcript, `choice.${choiceIndex}.audio.transcript`);
    observeOpenAiStreamFunction(estimator, delta.function_call, `choice.${choiceIndex}.function_call`);
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.slice(0, 256) : [];
    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
      const toolCall = toolCalls[toolIndex];
      observeOpenAiStreamFunction(estimator, toolCall?.function || toolCall, `choice.${choiceIndex}.tool.${toolIndex}`);
    }
  }

  const eventType = String(data.type || "").trim().toLowerCase();
  if (typeof data.delta === "string" && (!eventType || eventType.includes("delta"))) {
    estimator.observeText(data.delta, `event.${eventType || "delta"}`);
  } else if (data.delta && typeof data.delta === "object" && (!eventType || eventType.includes("delta"))) {
    observeOpenAiStreamContent(estimator, data.delta, `event.${eventType || "delta"}`);
    observeOpenAiStreamFunction(estimator, data.delta, `event.${eventType || "delta"}.function`);
  }
  if (typeof data.arguments_delta === "string") estimator.observeText(data.arguments_delta, `event.${eventType}.arguments`);
  if (eventType.endsWith(".added") && data.item && typeof data.item === "object") {
    observeOpenAiStreamFunction(estimator, data.item, `event.${eventType}.item`);
  }
}

function createOpenAiSseUsageParser(options = {}) {
  const decoder = new TextDecoder("utf-8");
  const configuredMaxBufferBytes = Number(options.maxBufferBytes || DEFAULT_OPENAI_SSE_USAGE_BUFFER_BYTES);
  const maxBufferBytes = Number.isFinite(configuredMaxBufferBytes)
    ? Math.max(4096, configuredMaxBufferBytes)
    : DEFAULT_OPENAI_SSE_USAGE_BUFFER_BYTES;
  const estimatedInputTokens = Number.isSafeInteger(Number(options.estimatedInputTokens))
    ? Math.max(0, Math.min(OPENAI_BILLING_MAX_ESTIMATED_TOKENS, Number(options.estimatedInputTokens)))
    : 0;
  const outputEstimator = createOpenAiStreamOutputEstimator({ maxSampleBytes: options.maxEstimateSampleBytes });
  let pending = "";
  let pendingForwarded = true;
  let disabled = false;
  let discardingOversizedEvent = false;
  let latestUsage = null;

  const processEvent = (eventText, forwarded) => {
    if (!eventText) return;
    const dataLines = [];
    for (const line of eventText.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      if (field !== "data") continue;
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") return;
    if (
      !payload.includes('"usage"')
      && !payload.includes('"delta"')
      && !payload.includes('"content"')
      && !payload.includes('"arguments"')
      && !payload.includes('"reasoning"')
    ) return;
    const data = parseJsonSafe(payload, null);
    const normalized = normalizeOpenAiUsage(extractOpenAiUsagePayload(data));
    if (normalized.usageSource !== "missing") latestUsage = normalized;
    if (forwarded) observeOpenAiStreamDelta(outputEstimator, data);
  };

  const drain = (latestChunkForwarded = true) => {
    if (discardingOversizedEvent) {
      const discardedBoundary = findSseEventBoundary(pending);
      if (!discardedBoundary) {
        pending = pending.slice(-3);
        return;
      }
      pending = pending.slice(discardedBoundary.index + discardedBoundary.length);
      pendingForwarded = pending ? latestChunkForwarded : true;
      discardingOversizedEvent = false;
    }
    let boundary = findSseEventBoundary(pending);
    while (boundary) {
      const eventText = pending.slice(0, boundary.index);
      if (Buffer.byteLength(eventText, "utf8") <= maxBufferBytes) processEvent(eventText, pendingForwarded);
      pending = pending.slice(boundary.index + boundary.length);
      pendingForwarded = pending ? latestChunkForwarded : true;
      boundary = findSseEventBoundary(pending);
    }
    if (Buffer.byteLength(pending, "utf8") > maxBufferBytes) {
      pending = pending.slice(-3);
      discardingOversizedEvent = true;
    }
  };

  return {
    push(chunk, pushOptions = {}) {
      if (disabled || chunk === undefined || chunk === null) return;
      try {
        const forwarded = pushOptions.forwarded !== false;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const decoded = decoder.decode(bytes, { stream: true });
        if (decoded) {
          pendingForwarded = pending ? (pendingForwarded && forwarded) : forwarded;
          pending += decoded;
          drain(forwarded);
        }
      } catch {
        pending = "";
        disabled = true;
      }
    },
    finish() {
      try {
        if (!disabled) {
          pending += decoder.decode();
          drain(pendingForwarded);
          if (!discardingOversizedEvent && pending.trim()) processEvent(pending, pendingForwarded);
        }
      } catch {
        // Parsing is side-channel only; the original SSE bytes were already forwarded.
      }
      pending = "";
      if (latestUsage) return latestUsage;
      const estimatedOutputTokens = outputEstimator.estimateTokens();
      if (estimatedOutputTokens > 0) {
        return normalizeOpenAiUsage({
          prompt_tokens: estimatedInputTokens,
          completion_tokens: estimatedOutputTokens,
          total_tokens: Math.min(
            OPENAI_BILLING_MAX_ESTIMATED_TOKENS,
            estimatedInputTokens + estimatedOutputTokens,
          ),
        }, { estimated: true });
      }
      return normalizeOpenAiUsage(null);
    },
  };
}

function includeOpenAiStreamUsage(requestBody) {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody) || requestBody.stream !== true) {
    return requestBody;
  }
  const existing = requestBody.stream_options
    && typeof requestBody.stream_options === "object"
    && !Array.isArray(requestBody.stream_options)
    ? requestBody.stream_options
    : {};
  return {
    ...requestBody,
    stream_options: {
      ...existing,
      include_usage: true,
    },
  };
}

function estimateOpenAiRequestInputTokens(requestBody) {
  if (!requestBody || typeof requestBody !== "object") return 0;
  const seen = new WeakSet();
  let visitedNodes = 0;
  let utf8Bytes = 0;
  let mediaTokens = 0;
  let explicitTokenIds = 0;
  const ignoredKeys = new Set([
    "model", "stream", "stream_options", "temperature", "top_p", "top_k",
    "max_tokens", "max_completion_tokens", "max_output_tokens", "seed", "n",
    "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs",
  ]);
  const mediaKeys = new Set(["image_url", "input_image", "audio", "input_audio", "video_url"]);

  const visit = (value, key = "", depth = 0) => {
    if (value === null || value === undefined || depth > 8 || visitedNodes >= 4_000) return;
    const normalizedKey = String(key || "").toLowerCase();
    if (ignoredKeys.has(normalizedKey)) return;
    if (typeof value === "string") {
      if (mediaKeys.has(normalizedKey) || /^data:(?:image|audio|video)\//i.test(value)) {
        mediaTokens = Math.min(OPENAI_BILLING_MAX_ESTIMATED_TOKENS, mediaTokens + 1024);
        return;
      }
      utf8Bytes += Buffer.byteLength(value, "utf8");
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    visitedNodes += 1;
    if (Array.isArray(value)) {
      if (normalizedKey === "input" && value.length && value.every((item) => Number.isSafeInteger(item) && item >= 0)) {
        explicitTokenIds = Math.min(OPENAI_BILLING_MAX_ESTIMATED_TOKENS, explicitTokenIds + value.length);
      } else {
        for (const item of value) visit(item, normalizedKey, depth + 1);
      }
      return;
    }
    const objectType = String(value.type || "").trim().toLowerCase();
    const mediaObject = ["image", "image_url", "input_image", "audio", "input_audio", "video", "video_url"].includes(objectType);
    if (mediaObject) {
      mediaTokens = Math.min(OPENAI_BILLING_MAX_ESTIMATED_TOKENS, mediaTokens + 1024);
    }
    for (const childKey in value) {
      if (!Object.hasOwn(value, childKey)) continue;
      if (mediaObject && ["url", "image_url", "audio", "input_audio", "video_url", "data"].includes(String(childKey).toLowerCase())) continue;
      visit(value[childKey], childKey, depth + 1);
    }
  };

  visit(requestBody);
  const textTokens = Math.ceil((utf8Bytes / 4) * 1.1);
  return Math.min(
    OPENAI_BILLING_MAX_ESTIMATED_TOKENS,
    explicitTokenIds + mediaTokens + (utf8Bytes ? Math.max(1, textTokens) : 0),
  );
}

function resolveOpenAiMaxOutputTokens(requestBody, upstreamPath = "") {
  const endpoint = String(upstreamPath || "").toLowerCase();
  if (["embeddings", "pooling", "score", "rerank", "classify"].includes(endpoint)) return 0;
  for (const key of ["max_completion_tokens", "max_output_tokens", "max_tokens"]) {
    const value = Number(requestBody?.[key]);
    if (Number.isSafeInteger(value) && value >= 0) return Math.min(1_000_000, value);
  }
  return OPENAI_BILLING_DEFAULT_MAX_OUTPUT_TOKENS;
}

function billingGatewayRejection(result = {}) {
  const rawCode = String(result?.code || "billing_unavailable").trim().toLowerCase();
  const quotaCodes = new Set([
    "insufficient_quota", "request_limit_exceeded", "token_limit_exceeded", "spend_limit_exceeded",
    "billing_insufficient_balance", "billing_period_credit_limit", "billing_period_token_limit", "billing_period_request_limit",
  ]);
  const suspendedCodes = new Set([
    "customer_suspended", "credential_disabled", "billing_customer_inactive", "billing_plan_inactive", "billing_credential_unbound",
  ]);
  if (quotaCodes.has(rawCode)) {
    return { status: 429, code: rawCode, message: "Billing quota is exhausted for this API key." };
  }
  if (suspendedCodes.has(rawCode)) {
    return { status: 403, code: rawCode, message: "The billing account for this API key is suspended." };
  }
  if (["price_not_configured", "billing_price_not_configured"].includes(rawCode)) {
    return { status: 503, code: rawCode, message: "Billing price is not configured for this model." };
  }
  return { status: 503, code: "billing_unavailable", message: "Billing authorization is temporarily unavailable." };
}

function createOpenAiUsageFinalizer(options = {}) {
  const {
    recordUsage = async () => {},
    clientId = "",
    requestId = "",
    settleBilling = null,
    getBillingContext = () => null,
    enqueuePendingBilling = null,
    onBillingError = () => {},
  } = options;
  let finalized = false;
  return async function finalizeUsage(event = {}) {
    if (finalized) return false;
    finalized = true;
    const normalized = event.normalizedUsage || normalizeOpenAiUsage(event.usage, {
      estimated: event.usageSource === "estimated",
    });
    const usageSource = event.usageSource === "estimated" || event.usageSource === "reported"
      ? event.usageSource
      : normalized.usageSource;
    const payload = {
      ok: event.ok === true,
      status: Number(event.status || 0),
      model: String(event.model || ""),
      requestId,
      usageSource,
      stream: event.stream === true,
      terminalState: String(event.terminalState || (event.ok === true ? "completed" : "failed")),
    };
    if (normalized.usage) payload.usage = normalized.usage;
    if (normalized.inputTokens !== undefined) payload.promptTokens = normalized.inputTokens;
    if (normalized.outputTokens !== undefined) payload.generationTokens = normalized.outputTokens;
    if (normalized.totalTokens !== undefined) payload.totalTokens = normalized.totalTokens;
    if (normalized.cachedTokens !== undefined) payload.cachedTokens = normalized.cachedTokens;
    try {
      await recordUsage(clientId, payload);
    } catch {
      // Usage persistence must not change the proxied API response.
    }
    const billingContext = typeof getBillingContext === "function" ? getBillingContext() : null;
    if (billingContext?.deferred && typeof enqueuePendingBilling === "function") {
      enqueuePendingBilling({
        authorizeInput: billingContext.authorizeInput || null,
        settleInput: {
          ...billingContext,
          model: payload.model,
          status: payload.status,
          ok: payload.ok,
          terminalState: payload.terminalState,
          usageSource: payload.usageSource,
          stream: payload.stream,
          ...(payload.promptTokens !== undefined ? { inputTokens: payload.promptTokens } : {}),
          ...(payload.generationTokens !== undefined ? { outputTokens: payload.generationTokens } : {}),
          ...(payload.totalTokens !== undefined ? { totalTokens: payload.totalTokens } : {}),
          ...(payload.cachedTokens !== undefined ? { cachedInputTokens: payload.cachedTokens } : {}),
        },
      });
      return true;
    }
    if (billingContext && typeof settleBilling === "function") {
      try {
        const settlement = await settleBilling({
          ...billingContext,
          model: payload.model,
          status: payload.status,
          ok: payload.ok,
          terminalState: payload.terminalState,
          usageSource: payload.usageSource,
          stream: payload.stream,
          ...(payload.promptTokens !== undefined ? { inputTokens: payload.promptTokens } : {}),
          ...(payload.generationTokens !== undefined ? { outputTokens: payload.generationTokens } : {}),
          ...(payload.totalTokens !== undefined ? { totalTokens: payload.totalTokens } : {}),
          ...(payload.cachedTokens !== undefined ? { cachedInputTokens: payload.cachedTokens } : {}),
        });
        if (!settlement?.ok) onBillingError({ phase: "settle", requestId: billingContext.requestId, code: settlement?.code || "billing_unavailable" });
      } catch (error) {
        onBillingError({ phase: "settle", requestId: billingContext.requestId, code: error?.code || "billing_unavailable" });
      }
    }
    return true;
  };
}

function createServiceUpstreamControl(req, res) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(req.serviceGateway?.timeoutMs || 600000));
  let abortReason = "";
  const timer = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, timeoutMs);
  const abortOnClose = () => {
    if (!res.writableEnded) {
      abortReason = "client_disconnect";
      controller.abort();
    }
  };
  res.once("close", abortOnClose);
  return {
    signal: controller.signal,
    get abortReason() {
      return abortReason;
    },
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
    resolvedInstance = "",
    requestId = "",
    finalizeUsage = null,
    estimatedInputTokens = 0,
  } = options;
  const effectiveRequestId = requestId || (req ? ensureOpenAiGatewayRequestId(req) : "");
  const usageParser = createOpenAiSseUsageParser({ estimatedInputTokens });
  const finishUsage = typeof finalizeUsage === "function"
    ? finalizeUsage
    : createOpenAiUsageFinalizer({
      recordUsage,
      clientId: req?.serviceGateway?.clientId,
      requestId: effectiveRequestId,
    });
  res.status(upstream.status);
  if (effectiveRequestId) res.setHeader(OPENAI_GATEWAY_REQUEST_ID_HEADER, effectiveRequestId);
  res.setHeader("content-type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", upstream.headers.get("cache-control") || "no-cache");
  res.setHeader("connection", "keep-alive");
  let streamError = null;
  try {
    for await (const chunk of upstream.body || []) {
      const bytes = Buffer.from(chunk);
      let forwarded = false;
      try {
        if (!res.writableEnded) {
          const canContinue = res.write(bytes);
          forwarded = true;
          if (!canContinue) await waitForWritable(res);
        }
      } finally {
        usageParser.push(bytes, { forwarded });
      }
    }
  } catch (error) {
    streamError = error;
  } finally {
    upstreamControl.clear();
  }
  const normalizedUsage = usageParser.finish();
  const timedOut = upstreamControl.abortReason === "timeout";
  const clientDisconnected = upstreamControl.abortReason === "client_disconnect" || Boolean(res.destroyed);
  const expectedDisconnect = Boolean(streamError && isExpectedStreamDisconnect(streamError, res));
  const interrupted = Boolean(streamError || timedOut || clientDisconnected);
  const terminalState = timedOut
    ? "timed_out"
    : ((clientDisconnected || expectedDisconnect) ? "aborted" : (streamError || !upstream.ok ? "failed" : "completed"));
  if (req) {
    setAccessUsage(req, {
      resolvedModel: model,
      ...(resolvedInstance ? { resolvedInstance } : {}),
      ...(normalizedUsage.inputTokens !== undefined ? { inputTokens: normalizedUsage.inputTokens } : {}),
      ...(normalizedUsage.outputTokens !== undefined ? { outputTokens: normalizedUsage.outputTokens } : {}),
      error: streamError ? streamError.message : "",
    });
  }
  if (streamError && !expectedDisconnect && !res.writableEnded) {
    res.write(`\ndata: ${JSON.stringify(openAiGatewayError("gateway_error", `Upstream stream failed: ${streamError.message}`))}\n\n`);
  }
  if (!res.writableEnded) res.end();
  await finishUsage({
    ok: upstream.ok && !interrupted,
    status: timedOut ? 504 : ((streamError || clientDisconnected) ? 499 : upstream.status),
    model,
    normalizedUsage,
    stream: true,
    terminalState,
  });
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
    authorizeBilling = null,
    settleBilling = null,
    enqueuePendingBilling = null,
    onBillingError = () => {},
    upstreamErrorMessage = (data, text) => data?.error?.message || data?.message || String(text || "Upstream request failed."),
    isExpectedStreamDisconnect = () => false,
    setAccessUsage = () => {},
    getRootMappings = () => [],
    prepareRequestBody = (body) => body,
    fetchFn = (...args) => fetch(...args),
    authorizeCacheTtlMs = 3000,
    billingProcessStartedAt = Date.now(),
    billingColdStartGraceMs = Number(process.env.BILLING_COLD_START_GRACE_MS || 30000),
  } = options;
  const authorizeMemo = new Map();
  const authorizeTtlMs = Math.max(0, Number(authorizeCacheTtlMs) || 0);
  const coldStartGraceMs = Math.max(0, Number(billingColdStartGraceMs) || 0);

  function runtimeInstanceEntry(runtime, discoveredIndex) {
    const labels = runtime?.container?.labels || {};
    const labelId = normalizeServiceEntryInstanceId(labels["ai.manager.instance"]);
    const explicitId = normalizeServiceEntryInstanceId(runtime?.instanceId || runtime?.id);
    const containerName = normalizeServiceEntryInstanceId(runtime?.container?.name);
    const instanceMode = String(runtime?.instanceMode || labels["ai.manager.instance-mode"] || "").trim().toLowerCase();
    const primary = runtime?.primary === true || explicitId === "primary" || instanceMode === "replace"
      || (discoveredIndex === 0 && instanceMode !== "parallel");
    const instanceId = primary
      ? "primary"
      : labelId || explicitId || containerName || `instance-${discoveredIndex}`;
    return {
      runtime,
      instanceId,
      aliases: new Set([instanceId, labelId, explicitId, containerName].filter(Boolean).map((item) => item.toLowerCase())),
    };
  }

  async function getAvailableRuntimeEntries() {
    if (typeof listRunningModelSummaries === "function") {
      const runtimes = await listRunningModelSummaries();
      const running = (Array.isArray(runtimes) ? runtimes : [])
        .map((runtime, index) => runtimeInstanceEntry(runtime, index))
        .filter((entry) => entry.runtime?.container?.running);
      if (running.length) return running;
    }
    const primary = await getRunningModelSummary();
    return primary ? [runtimeInstanceEntry(primary, 0)] : [];
  }

  async function getRequestRuntimeEntries(req) {
    const requestedInstanceId = normalizeServiceEntryInstanceId(req?.serviceGateway?.selectedInstanceId);
    if (!requestedInstanceId) return getAvailableRuntimeEntries();
    const selected = await selectRuntime("", requestedInstanceId);
    return selected ? [selected] : [];
  }

  function runtimeHasRequestedModel(runtime, requestedModel) {
    const value = String(requestedModel || "").trim();
    if (!value) return false;
    const served = servedModelIds(runtime);
    if (served.some((id) => id === value || id.toLowerCase() === value.toLowerCase())) return true;
    if (findOpenAiGatewayDynamicAlias(value, served)) return true;
    if (findServedModelByRoot(value, runtime)) return true;
    const roots = getRootMappings(runtime) || [];
    return roots.some((entry) => entry?.root === value || String(entry?.root || "").toLowerCase() === value.toLowerCase());
  }

  async function selectRuntime(requestedModel = "", requestedInstanceId = "") {
    const entries = await getAvailableRuntimeEntries();
    if (!entries.length) return null;
    const selectedInstanceId = normalizeServiceEntryInstanceId(requestedInstanceId);
    if (selectedInstanceId) {
      return entries.find((entry) => entry.aliases.has(selectedInstanceId.toLowerCase())) || null;
    }
    const value = String(requestedModel || "").trim();
    const bareValue = value.split("/").pop();
    if (!value || aliases.some((alias) => alias.toLowerCase() === value.toLowerCase() || alias.toLowerCase() === bareValue.toLowerCase())) {
      return entries[0];
    }
    return entries.find((entry) => runtimeHasRequestedModel(entry.runtime, value)) || entries[0];
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

  async function discoverAuthorizedModels(req, runtimes) {
    const results = await Promise.allSettled(runtimes.map((item) => fetchRuntimeModels(item)));
    const discovered = results.flatMap((result, index) => result.status === "fulfilled"
      ? result.value.map((model) => ({ model, runtime: runtimes[index] }))
      : []);
    const allowed = discovered.filter(({ model, runtime }) => serviceClientAllowsModel(
      req?.serviceGateway?.client,
      String(model?.id || ""),
      runtime,
    ));
    return {
      results,
      discoveredCount: discovered.length,
      models: uniqueModelsById(allowed.map((entry) => entry.model)),
      runtime: allowed[0]?.runtime || runtimes[0] || null,
    };
  }

  async function handleModels(req, res) {
    try {
      const requestedInstanceId = normalizeServiceEntryInstanceId(req?.serviceGateway?.selectedInstanceId);
      const entries = await getRequestRuntimeEntries(req);
      if (requestedInstanceId && !entries.length) {
        return res.status(503).json(openAiGatewayError(
          "instance_not_available",
          `Selected runtime instance ${requestedInstanceId} is not available.`,
        ));
      }
      const runtimes = entries.map((entry) => entry.runtime);
      const runtime = runtimes[0];
      if (!runtime?.container?.running) {
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const discovery = await discoverAuthorizedModels(req, runtimes);
      const { results, models } = discovery;
      if (!models.length) {
        if (discovery.discoveredCount && req?.serviceGateway?.client) {
          return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to list models on the selected runtime."));
        }
        const firstError = results.find((item) => item.status === "rejected")?.reason;
        return res.status(503).json(openAiGatewayError(
          "service_unavailable",
          firstError?.message || "Running model services did not return any models yet.",
        ));
      }
      return res.json(buildOpenAiGatewayModelList({ models, runtime: discovery.runtime, aliases, owner }));
    } catch (error) {
      return res.status(500).json(openAiGatewayError("gateway_error", error.message));
    }
  }

  async function handleProps(req, res) {
    try {
      const requestedInstanceId = normalizeServiceEntryInstanceId(req?.serviceGateway?.selectedInstanceId);
      const entries = await getRequestRuntimeEntries(req);
      if (requestedInstanceId && !entries.length) {
        return res.status(503).json(openAiGatewayError(
          "instance_not_available",
          `Selected runtime instance ${requestedInstanceId} is not available.`,
        ));
      }
      const runtimes = entries.map((entry) => entry.runtime);
      const runtime = runtimes[0];
      if (!runtime?.container?.running) {
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const discovery = await discoverAuthorizedModels(req, runtimes);
      const { results, models } = discovery;
      if (!models.length) {
        if (discovery.discoveredCount && req?.serviceGateway?.client) {
          return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to list models on the selected runtime."));
        }
        const firstError = results.find((item) => item.status === "rejected")?.reason;
        return res.status(503).json(openAiGatewayError(
          "service_unavailable",
          firstError?.message || "Running model services did not return any models yet.",
        ));
      }
      const modelList = buildOpenAiGatewayModelList({ models, runtime: discovery.runtime, aliases, owner });
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
    const requestId = ensureOpenAiGatewayRequestId(req);
    const billingRequestId = crypto.randomUUID();
    if (req?.serviceGateway && typeof req.serviceGateway === "object") req.serviceGateway.billingRequestId = billingRequestId;
    res.setHeader?.(OPENAI_GATEWAY_REQUEST_ID_HEADER, requestId);
    let stream = body.stream === true;
    let resolvedInstance = "";
    let resolvedModel = String(body.model || "");
    let upstreamAbortReason = "";
    let billingAuthorization = null;
    // On a hop v2 the billing principal is the entry's: clientId = principal.c
    // charged against the binding of credentialManagerId = principal.b (05 §6.4).
    const credentialManagerId = String(req.serviceGateway?.credentialManagerId || "");
    const billingPrincipal = credentialManagerId ? { credentialManagerId } : {};
    const finalizeUsage = createOpenAiUsageFinalizer({
      recordUsage,
      clientId: req.serviceGateway?.clientId,
      requestId,
      settleBilling,
      enqueuePendingBilling,
      getBillingContext: () => {
        if (billingAuthorization?.ok !== true || billingAuthorization?.allowed === false) return null;
        if (billingAuthorization.deferred) {
          return {
            deferred: true,
            authorizeInput: billingAuthorization.authorizeInput || null,
            requestId: billingRequestId,
            externalRequestId: requestId,
            clientId: req.serviceGateway?.clientId || "",
            ...billingPrincipal,
          };
        }
        if (billingAuthorization.bound === true) {
          return {
            requestId: billingRequestId,
            externalRequestId: requestId,
            clientId: req.serviceGateway?.clientId || "",
            ...billingPrincipal,
          };
        }
        return null;
      },
      onBillingError,
    });
    const finishUsage = (event = {}) => finalizeUsage({
      model: resolvedModel,
      stream,
      ...event,
    });
    try {
      const requestedInstanceId = normalizeServiceEntryInstanceId(req.serviceGateway?.selectedInstanceId);
      const selectedRuntime = await selectRuntime(body.model, requestedInstanceId);
      if (!selectedRuntime && requestedInstanceId) {
        const message = `Selected runtime instance ${requestedInstanceId} is not available.`;
        await finishUsage({ ok: false, status: 503, terminalState: "failed" });
        setAccessUsage(req, { error: message });
        return res.status(503).json(openAiGatewayError("instance_not_available", message));
      }
      const runtime = selectedRuntime?.runtime;
      resolvedInstance = requestedInstanceId ? String(selectedRuntime?.instanceId || "") : "";
      if (!runtime?.container?.running) {
        await finishUsage({ ok: false, status: 503, terminalState: "failed" });
        setAccessUsage(req, { error: "Model service is not running." });
        return res.status(503).json(openAiGatewayError("service_unavailable", "Model service is not running."));
      }
      const model = resolveOpenAiGatewayModel(String(body.model || ""), runtime, { aliases, getRootMappings });
      if (!model) {
        await finishUsage({ ok: false, status: 400, terminalState: "failed" });
        setAccessUsage(req, {
          ...(resolvedInstance ? { resolvedInstance } : {}),
          error: "Configured model is not available on this local gateway.",
        });
        return res.status(400).json(openAiGatewayError("model_not_available", "Configured model is not available on this local gateway."));
      }
      resolvedModel = model;
      if (!serviceClientAllowsModel(req.serviceGateway?.client, model, runtime)) {
        await finishUsage({ ok: false, status: 403, terminalState: "failed" });
        setAccessUsage(req, {
          resolvedModel: model,
          ...(resolvedInstance ? { resolvedInstance } : {}),
          error: "This service client is not allowed to use the requested model.",
        });
        return res.status(403).json(openAiGatewayError("model_forbidden", "This service client is not allowed to use the requested model."));
      }
      body.model = model;
      const prepared = await prepareRequestBody(body, runtime, model, { req, upstreamPath });
      let requestBody = prepared && typeof prepared === "object" && !Array.isArray(prepared)
        ? { ...prepared, model }
        : body;
      requestBody = includeOpenAiStreamUsage(requestBody);
      stream = requestBody.stream === true;
      const estimatedInputTokens = (stream || typeof authorizeBilling === "function")
        ? estimateOpenAiRequestInputTokens(requestBody)
        : 0;
      if (req.serviceGateway?.clientId && typeof authorizeBilling === "function") {
        const clientId = req.serviceGateway.clientId;
        const memoKey = credentialManagerId ? `${credentialManagerId}
${clientId}` : clientId;
        const memo = authorizeTtlMs > 0 ? authorizeMemo.get(memoKey) : null;
        if (memo && memo.ok === true && memo.allowed !== false && (Date.now() - memo.at) <= authorizeTtlMs) {
          billingAuthorization = { ...memo.result, cached: true };
        } else {
          try {
            billingAuthorization = await authorizeBilling({
              requestId: billingRequestId,
              externalRequestId: requestId,
              clientId,
              ...billingPrincipal,
              model,
              endpoint: `/v1/${upstreamPath}`,
              stream,
              estimatedInputTokens,
              maxOutputTokens: resolveOpenAiMaxOutputTokens(requestBody, upstreamPath),
            });
          } catch (error) {
            billingAuthorization = { ok: false, allowed: false, code: error?.code || "billing_unavailable" };
          }
        }
        const authorizeCode = String(billingAuthorization?.code || "").toLowerCase();
        if (authorizeCode === "billing_unavailable") {
          const knownMode = String(billingAuthorization?.enforcementMode || memo?.enforcementMode || "").toLowerCase();
          const inColdStart = Date.now() - billingProcessStartedAt < coldStartGraceMs;
          if (knownMode === "shadow" || inColdStart) {
            billingAuthorization = {
              ok: true,
              allowed: true,
              bound: false,
              deferred: true,
              code: "billing_unavailable_shadow",
              enforcementMode: knownMode || "shadow",
              authorizeInput: {
                requestId: billingRequestId,
                externalRequestId: requestId,
                clientId,
                ...billingPrincipal,
                model,
                endpoint: `/v1/${upstreamPath}`,
                stream,
                estimatedInputTokens,
                maxOutputTokens: resolveOpenAiMaxOutputTokens(requestBody, upstreamPath),
              },
            };
          }
        }
        if (billingAuthorization?.ok === true && billingAuthorization?.allowed !== false && authorizeTtlMs > 0) {
          authorizeMemo.set(memoKey, {
            at: Date.now(),
            enforcementMode: String(billingAuthorization.enforcementMode || "").toLowerCase(),
            ok: true,
            allowed: true,
            result: billingAuthorization,
          });
        }
        if (billingAuthorization?.ok !== true || billingAuthorization?.allowed === false) {
          const rejection = billingGatewayRejection(billingAuthorization);
          await finishUsage({ ok: false, status: rejection.status, terminalState: "failed" });
          setAccessUsage(req, {
            resolvedModel: model,
            ...(resolvedInstance ? { resolvedInstance } : {}),
            error: rejection.message,
          });
          onBillingError({ phase: "authorize", requestId: billingRequestId, code: rejection.code });
          return res.status(rejection.status).json(openAiGatewayError(rejection.code, rejection.message));
        }
      }
      const upstreamControl = createServiceUpstreamControl(req, res);
      try {
        const upstreamHeaders = mergeOpenAiGatewayRequestId(
          getUpstreamHeaders(runtime, { "content-type": "application/json", [OPENAI_GATEWAY_REQUEST_ID_HEADER]: requestId }),
          requestId,
        );
        const upstream = await fetchFn(`http://127.0.0.1:${runtime.endpoint.port}/v1/${upstreamPath}`, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(requestBody),
          signal: upstreamControl.signal,
        });
        if (stream) {
          return await streamRawOpenAiGatewayResponse(upstream, res, upstreamControl, {
            req,
            model,
            recordUsage,
            setAccessUsage,
            isExpectedStreamDisconnect,
            resolvedInstance,
            requestId,
            finalizeUsage: finishUsage,
            estimatedInputTokens,
          });
        }
        const text = await upstream.text();
        upstreamControl.clear();
        const data = parseJsonSafe(text, null);
        const normalizedUsage = normalizeOpenAiUsage(extractOpenAiUsagePayload(data));
        setAccessUsage(req, {
          resolvedModel: model,
          ...(resolvedInstance ? { resolvedInstance } : {}),
          ...(normalizedUsage.inputTokens !== undefined ? { inputTokens: normalizedUsage.inputTokens } : {}),
          ...(normalizedUsage.outputTokens !== undefined ? { outputTokens: normalizedUsage.outputTokens } : {}),
        });
        res.status(upstream.status);
        res.type(upstream.headers.get("content-type") || "application/json");
        res.send(text);
        await finishUsage({
          ok: upstream.ok,
          status: upstream.status,
          normalizedUsage,
          terminalState: upstream.ok ? "completed" : "failed",
        });
        return;
      } catch (error) {
        upstreamAbortReason = upstreamControl.abortReason;
        upstreamControl.clear();
        throw error;
      }
    } catch (error) {
      const disconnected = upstreamAbortReason === "client_disconnect" || Boolean(res.destroyed);
      const timedOut = upstreamAbortReason === "timeout" || (!disconnected && error?.name === "AbortError");
      await finishUsage({
        ok: false,
        status: disconnected ? 499 : (timedOut ? 504 : 500),
        terminalState: disconnected ? "aborted" : (timedOut ? "timed_out" : "failed"),
      });
      setAccessUsage(req, { ...(resolvedInstance ? { resolvedInstance } : {}), error: error.message });
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      const responseTimedOut = error?.name === "AbortError";
      return res.status(responseTimedOut ? 504 : 500).json(openAiGatewayError(
        responseTimedOut ? "request_timeout" : "gateway_error",
        responseTimedOut ? "Upstream request timed out." : error.message,
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

// Response headers a cross-origin client may read. Never "*".
const SERVICE_CORS_EXPOSE_HEADERS = "x-request-id, x-local-ai-route, retry-after";

// An Origin that names the host the request was sent to is the manager's own
// page; browsers send Origin on same-origin POSTs too.
function isSameOriginRequest(req, origin) {
  const host = String(req.headers?.host || "").trim().toLowerCase();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

// Deny by default (docs/overhaul/08 P0-21). Restricted mode admits same-origin
// requests and the configured origins only. "open" reflects any origin, and
// only while an API key is required. Credentials are never allowed, and a
// Private Network Access preflight is granted only with allowPrivateNetwork.
function applyServiceCorsHeaders(req, res, settings = {}, allowHeaders = DEFAULT_SERVICE_CORS_ALLOW_HEADERS) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return { ok: true };
  const openCors = resolveEffectiveCorsMode(settings) === "open";
  // A "*" entry means any origin, so it follows the same API-key rule as open.
  const configuredOrigins = (Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : [])
    .filter((item) => openCors || String(item || "").trim() !== "*");
  if (!openCors && !isSameOriginRequest(req, origin) && !isServiceOriginAllowed(origin, configuredOrigins, false)) {
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
  res.setHeader("access-control-expose-headers", SERVICE_CORS_EXPOSE_HEADERS);
  if (settings.allowPrivateNetwork === true
    && String(req.headers["access-control-request-private-network"] || "").toLowerCase() === "true") {
    res.setHeader("access-control-allow-private-network", "true");
  }
  return { ok: true, mode: openCors ? "open" : "restricted", allowedHeaders: resolvedHeaders };
}

// Managers run with cwd set to their own root, so the platform root (where
// service-entry publishes the trust token) is one level up.
let gatewayTrustReader = null;

function defaultGatewayTrustReader() {
  if (!gatewayTrustReader) {
    gatewayTrustReader = createGatewayTrustReader({
      root: process.env.AI_ROOT || path.dirname(process.cwd()),
    });
  }
  return gatewayTrustReader();
}

function configureGatewayTrust(reader) {
  gatewayTrustReader = typeof reader === "function" ? reader : null;
}

// The caller's real address: the socket address for direct clients, and the
// address service-entry vouched for on a signed loopback hop. A loopback
// request carrying the gateway marker without a valid signature stays
// untrusted, so it can never be mistaken for a local client.
function resolveGatewayRequestOrigin(req, options = {}) {
  return resolveRequestOrigin(req, {
    readGatewayTrustToken: options.readGatewayTrustToken || defaultGatewayTrustReader,
    ...options,
  });
}

function resolveServiceEntrySelectedInstance(req, options = {}) {
  const instanceId = normalizeServiceEntryInstanceId(gatewayHeaderValue(req?.headers || {}, SERVICE_ENTRY_INSTANCE_HEADER));
  const signature = gatewayHeaderValue(req?.headers || {}, SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER, 512);
  if (!instanceId || !signature) return "";
  const readToken = options.readGatewayTrustToken || defaultGatewayTrustReader;
  const token = options.token || (typeof readToken === "function" ? readToken() : "");
  const origin = resolveGatewayRequestOrigin(req, { ...options, token });
  if (!origin.viaGateway || !origin.trusted) return "";
  const clientAddress = gatewayHeaderValue(req.headers || {}, GATEWAY_CLIENT_HEADER);
  const timestamp = gatewayHeaderValue(req.headers || {}, GATEWAY_TIMESTAMP_HEADER);
  const expected = signServiceEntryInstance(token, instanceId, clientAddress, timestamp);
  return safeGatewaySignatureEqual(signature, expected) ? instanceId : "";
}

function isLocalRequester(req, options = {}) {
  const origin = resolveGatewayRequestOrigin(req, options);
  if (origin.viaGateway && !origin.trusted) return false;
  return ["127.0.0.1", "::1", "localhost", "", "unknown"].includes(origin.address);
}

// Rate-limit bucket key. Falls back to the resolved origin rather than a raw
// X-Forwarded-For, which a client could rotate to mint a fresh bucket per
// request and defeat the limit entirely.
function serviceClientFingerprint(req, apiKey = "", options = {}) {
  const raw = apiKey || resolveGatewayRequestOrigin(req, options).address || "unknown";
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

// Calls callback({ terminalState }) exactly once: "completed" on finish, or
// "client_abort" when the connection closes before the response finished
// (a client that hangs up mid-stream never emits finish).
function onResponseDone(res, callback) {
  let settled = false;
  const settle = (terminalState) => {
    if (settled) return;
    settled = true;
    res.removeListener?.("finish", onFinish);
    res.removeListener?.("close", onClose);
    try {
      callback({ terminalState });
    } catch {
      // Logging callbacks must never break the response path.
    }
  };
  const onFinish = () => settle("completed");
  const onClose = () => settle(res.writableFinished ? "completed" : "client_abort");
  if (res.writableFinished) {
    queueMicrotask(() => settle("completed"));
    return;
  }
  res.once("finish", onFinish);
  res.once("close", onClose);
}

// The caller's address for the access log. A request proxied by a trusted
// service-entry hop logs the client the entry vouched for; anything else logs
// the socket peer. Read when the request starts, because a socket that is
// already destroyed may no longer report its peer.
function resolveAccessLogOrigin(req) {
  const fallback = normalizeRemoteAddress(req?.socket?.remoteAddress || req?.ip || "");
  try {
    const origin = resolveGatewayRequestOrigin(req);
    const hop = origin.viaGateway && origin.trusted && origin.version === 2 ? origin : null;
    return {
      address: origin.address || fallback,
      socketAddress: origin.socketAddress || fallback,
      // A verified hop v2 carries the identity the entry vouched for.
      viaEntry: Boolean(hop),
      hopRequestId: hop ? String(hop.requestId || "") : "",
      keyId: hop && hop.principal && typeof hop.principal.k === "string" ? hop.principal.k : "",
      // An unparseable or unknown-version context is no context (04 §5.2).
      sourceProgram: hop && hop.context && hop.context.v === 1 && typeof hop.context.src === "string"
        ? hop.context.src.slice(0, 64)
        : "",
    };
  } catch {
    return { address: fallback, socketAddress: fallback, viaEntry: false, hopRequestId: "", keyId: "", sourceProgram: "" };
  }
}

function buildServiceGatewayAccessLogEntry(req, res, kind, startedAt, authSource, details = {}) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const usage = req.serviceGatewayAccessUsage || {};
  const inputTokens = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.generationTokens ?? 0);
  const headers = req.headers || {};
  const terminalState = details.terminalState || "completed";
  const origin = details.origin || resolveAccessLogOrigin(req);
  const status = terminalState === "client_abort" && !res.headersSent ? 499 : res.statusCode;
  const requestId = normalizeOpenAiGatewayRequestId(
    req.serviceGateway?.requestId || origin.hopRequestId || headers[OPENAI_GATEWAY_REQUEST_ID_HEADER],
  );
  // The id a direct client sent. Behind the entry the client's id is kept by
  // the entry (client_request_id), not forwarded.
  const clientRequestId = origin.viaEntry ? "" : normalizeOpenAiGatewayRequestId(headers[OPENAI_GATEWAY_REQUEST_ID_HEADER]);
  const legacyClientId = req.serviceGateway?.clientId || "";
  const outcome = classifyOutcome({
    status,
    code: usage.errorCode || "",
    aborted: terminalState === "client_abort",
    timedOut: terminalState === "timeout" || terminalState === "timed_out",
    streamError: Boolean(usage.error) && status > 0 && status < 400,
    phase: usage.resolvedModel || usage.resolvedInstance ? "upstream" : "pre_upstream",
  });
  return {
    at: new Date().toISOString(),
    requestId,
    clientRequestId,
    viaEntry: Boolean(origin.viaEntry),
    keyId: origin.keyId || legacyClientId,
    // Only a verified hop sets the slug; direct rows are classified from the
    // user agent when the row is normalised (same rules, access-log.js).
    ...(origin.sourceProgram ? { sourceProgram: origin.sourceProgram } : {}),
    errorClass: outcome.errorClass,
    firstByteMs: Number(details.firstByteMs) > 0 ? Math.round(Number(details.firstByteMs)) : 0,
    remoteAddress: origin.address,
    socketAddress: origin.socketAddress,
    method: req.method,
    path: String(req.originalUrl || req.url || "").split("?")[0],
    kind,
    // 499 (client closed request) when the client left before any header.
    status,
    terminalState,
    model: typeof body.model === "string" ? body.model.slice(0, 160) : "",
    resolvedModel: String(usage.resolvedModel || "").slice(0, 220),
    resolvedInstance: String(usage.resolvedInstance || "").slice(0, 128),
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

// reportDirect(entry): direct-ingress rows (no valid v2 hop) are also sent to
// the entry (04 §6.7, TEL-6). A request the entry routed is recorded by the
// entry, so it is never reported here as well.
function attachServiceGatewayAccessLog(req, res, kind, appendAccessLog, reportDirect = null) {
  const startedAt = Date.now();
  const authSource = serviceApiKeySource(req.headers || {});
  const origin = resolveAccessLogOrigin(req);
  // firstByteMs: the first res.write or res.end, whichever comes first.
  let firstByteMs = 0;
  for (const method of ["write", "end"]) {
    const original = res[method];
    if (typeof original !== "function") continue;
    res[method] = function firstByteProbe(...args) {
      if (!firstByteMs) firstByteMs = Math.max(1, Date.now() - startedAt);
      return original.apply(this, args);
    };
  }
  onResponseDone(res, ({ terminalState }) => {
    const entry = buildServiceGatewayAccessLogEntry(req, res, kind, startedAt, authSource, { terminalState, origin, firstByteMs });
    const pending = appendAccessLog(entry);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
    if (typeof reportDirect === "function" && !entry.viaEntry) {
      try {
        const reported = reportDirect(entry);
        if (reported && typeof reported.catch === "function") reported.catch(() => {});
      } catch {
        // Telemetry reporting never reaches the response path.
      }
    }
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

// --- Gateway-only modes (05 §7.2) --------------------------------------------

const GATEWAY_ONLY_MODES = Object.freeze(["off", "warn", "enforce"]);
const DEFAULT_GATEWAY_ONLY_MODE = "warn";
const GATEWAY_ONLY_MODE_TTL_MS = 10 * 1000;
const DEFAULT_GATEWAY_BACKSTOP_CONCURRENCY = 64;
const ENTRY_BACKSTOP_CLIENT_KEY = "entry:backstop";
const DIRECT_CALL_LOG_INTERVAL_MS = 60 * 1000;
const GATEWAY_ONLY_MESSAGE = "Use the platform endpoint (port 5176 locally, 5186 public).";
const DIRECT_DEPRECATION_LINK = '</docs/migrate-public>; rel="deprecation"';

function normalizeGatewayOnlyMode(value, fallback = DEFAULT_GATEWAY_ONLY_MODE) {
  const text = String(value ?? "").trim().toLowerCase();
  return GATEWAY_ONLY_MODES.includes(text) ? text : fallback;
}

// public.managersGatewayOnly through OPS-3's readSection (env
// MANAGER_GATEWAY_ONLY > platform.json > "warn"), read at most every 10 s so
// a change applies without a restart. A config that cannot be read keeps the
// last good mode, or the default.
function createGatewayOnlyModeReader(options = {}) {
  const ttlMs = Math.max(0, Number(options.ttlMs ?? GATEWAY_ONLY_MODE_TTL_MS));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const readSection = typeof options.readSection === "function"
    ? options.readSection
    : (name, readOptions) => require("./platform/config").readSection(name, readOptions);
  let cached = { mode: "", at: 0 };
  return function readGatewayOnlyMode() {
    const at = now();
    if (cached.mode && at - cached.at < ttlMs) return cached.mode;
    let mode = cached.mode || DEFAULT_GATEWAY_ONLY_MODE;
    try {
      const section = readSection("public", { aiRoot: options.aiRoot, env: options.env });
      mode = normalizeGatewayOnlyMode(section?.values?.managersGatewayOnly, mode);
    } catch {
      // Keep the previous mode; the next read after the window retries.
    }
    cached = { mode, at };
    return mode;
  };
}

// A platform key verified by the entry (POST /internal/access/verify) in the
// shape the legacy checks below already understand.
function verifiedAccessClient(verified = {}) {
  const limits = verified.limits && typeof verified.limits === "object" ? verified.limits : {};
  const models = Array.isArray(verified.models) ? verified.models.map((item) => String(item || "")).filter(Boolean) : [];
  const principal = verified.principal && typeof verified.principal === "object" ? verified.principal : {};
  const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined);
  return {
    id: String(principal.c || verified.keyId || ""),
    keyId: String(verified.keyId || ""),
    name: String(verified.keyId || ""),
    enabled: true,
    allowedModels: models.includes("*") ? [] : models,
    rateLimitRpm: positive(limits.rpm),
    maxConcurrentRequests: positive(limits.maxConcurrent),
    maxQueuedRequests: Number.isFinite(Number(limits.maxQueued)) && limits.maxQueued !== null ? Number(limits.maxQueued) : undefined,
    queueTimeoutSeconds: positive(limits.queueTimeoutSeconds),
    requestTimeoutSeconds: positive(limits.requestTimeoutSeconds),
    expiresAt: verified.expiresAt || "",
  };
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
    // 05 §7.2. Without a reader the middleware keeps the legacy behaviour
    // ("off"); the managers pass createGatewayOnlyModeReader().
    getGatewayOnlyMode = null,
    // (keyHash, { kind }) -> Promise<verify answer>; see legacy-key-forwarder.
    verifyAccessKey = null,
    backstopConcurrency = process.env.MANAGER_GATEWAY_BACKSTOP_CONCURRENCY,
    onDirectGatewayCall = null,
    // (accessLogEntry) -> void; reports a direct-ingress row to the entry (TEL-6).
    reportDirectRequest = null,
  } = options;
  const backstopSettings = {
    maxConcurrentRequests: clampServiceGatewayNumber(backstopConcurrency, 1, 256, DEFAULT_GATEWAY_BACKSTOP_CONCURRENCY),
  };
  let directLog = { at: 0, suppressed: 0 };

  function currentGatewayOnlyMode() {
    if (typeof getGatewayOnlyMode !== "function") return "off";
    try {
      return normalizeGatewayOnlyMode(getGatewayOnlyMode());
    } catch {
      return DEFAULT_GATEWAY_ONLY_MODE;
    }
  }

  // At most one log line a minute; the line counts the calls it stands for.
  function noteDirectCall(req, kind, origin) {
    if (typeof onDirectGatewayCall !== "function") return;
    const at = Date.now();
    if (at - directLog.at < DIRECT_CALL_LOG_INTERVAL_MS) {
      directLog.suppressed += 1;
      return;
    }
    const suppressed = directLog.suppressed;
    directLog = { at, suppressed: 0 };
    try {
      onDirectGatewayCall({
        event: "direct_manager_gateway",
        kind,
        path: String(req.originalUrl || req.url || "").split("?")[0].slice(0, 200),
        remoteAddress: origin.address,
        suppressed,
      });
    } catch {
      // Logging never breaks the request.
    }
  }

  // The key of a direct call: the entry's key store first (the plaintext
  // never leaves this process, only its hash), the legacy files when the
  // store cannot be asked. `unavailable` is set when the store could not
  // answer and the mode does not allow the file fallback.
  async function resolveDirectCredential(presentedKey, kind, settings, mode) {
    if (presentedKey && typeof verifyAccessKey === "function") {
      let verified;
      try {
        verified = await verifyAccessKey(hashServiceApiKey(presentedKey), { kind });
      } catch (error) {
        verified = { ok: false, code: error?.code || "key_store_unavailable", unavailable: true };
      }
      if (!verified?.unavailable) {
        if (verified?.ok !== true) return { decided: true, client: null, clientId: "", credentialManagerId: "", accepted: false };
        const principal = verified.principal && typeof verified.principal === "object" ? verified.principal : {};
        const billed = Boolean(principal.b);
        return {
          decided: true,
          client: verifiedAccessClient(verified),
          clientId: billed ? String(principal.c || "") : "",
          credentialManagerId: billed ? String(principal.b) : "",
          keyId: String(verified.keyId || ""),
          accepted: true,
        };
      }
      // §18: with the entry down, "off" falls back to the legacy files and
      // "warn" denies.
      if (mode !== "off") return { unavailable: true };
    }
    const serviceClient = await resolveServiceClientForApiKey(presentedKey);
    const globalKeyAccepted = isGlobalServiceApiKeyAccepted(presentedKey, settings);
    return {
      decided: false,
      client: serviceClient,
      clientId: serviceClient?.id || (globalKeyAccepted ? globalServiceBillingClientId(settings) : ""),
      credentialManagerId: "",
      accepted: Boolean(serviceClient) || globalKeyAccepted,
    };
  }

  function armRelease(res, slot, settings, clientKey) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.concurrency.release();
      resolveNextServiceGatewayWaiter(settings, clientKey, concurrencyBuckets, concurrencyQueues);
    };
    res.once("finish", release);
    res.once("close", release);
  }

  function armTimeout(res, timeoutMs) {
    res.setTimeout?.(timeoutMs, () => {
      if (!res.headersSent) res.status(504).json(openAiGatewayError("request_timeout", "Service gateway request timed out."));
      if (!res.writableEnded) res.end();
    });
  }

  // A verified hop v2: the entry already authenticated, authorized and
  // rate-limited the caller, so its principal is trusted. Only a backstop
  // concurrency cap per manager applies here; the exposure settings govern
  // direct calls only (05 §6.8).
  async function admitEntryHop(req, res, next, kind, settings, origin) {
    if (req.method === "OPTIONS") return res.status(204).end();
    const principal = origin.principal && typeof origin.principal === "object" ? origin.principal : null;
    const effectiveSettings = { ...settings, ...backstopSettings };
    const timeoutMs = Math.min(7200, Math.max(10, Number(settings.requestTimeoutSeconds || 600))) * 1000;
    const slot = await waitForServiceGatewayConcurrency(effectiveSettings, ENTRY_BACKSTOP_CLIENT_KEY, concurrencyBuckets, concurrencyQueues, res, timeoutMs);
    if (!slot.ok) {
      if (slot.aborted || res.writableEnded) return undefined;
      return serviceGatewayReject(res, slot.statusCode || 429, slot.code, slot.message);
    }
    armRelease(res, slot, effectiveSettings, ENTRY_BACKSTOP_CLIENT_KEY);
    // b:null (console-session) and keyless ADMIN callers are not billed.
    const billed = Boolean(principal?.b);
    req.serviceGateway = {
      kind,
      settings: effectiveSettings,
      baseSettings: settings,
      client: null,
      clientId: billed ? String(principal.c || "") : "",
      credentialManagerId: billed ? String(principal.b) : "",
      keyId: String(principal?.k || ""),
      principal,
      context: origin.context || null,
      entryHop: origin.version,
      requestId: origin.requestId,
      clientKey: ENTRY_BACKSTOP_CLIENT_KEY,
      timeoutMs,
      queuedMs: slot.queuedMs || 0,
      selectedInstanceId: resolveServiceEntrySelectedInstance(req),
    };
    res.setHeader("x-local-llm-gateway", gatewayName);
    res.setHeader("x-local-llm-queued-ms", String(slot.queuedMs || 0));
    armTimeout(res, timeoutMs);
    return next();
  }

  return async function serviceGatewayMiddleware(req, res, next) {
    try {
      const settings = await getServiceExposureSettings();
      const kind = getServiceGatewayKind(req, supportedKinds);
      if (!kind) return next();
      attachServiceGatewayAccessLog(req, res, kind, appendAccessLog, reportDirectRequest);
      const origin = resolveGatewayRequestOrigin(req);
      if (origin.viaGateway && origin.trusted && origin.version === 2) {
        return await admitEntryHop(req, res, next, kind, settings, origin);
      }
      // A valid v1 hop (an older entry) keeps the legacy path in every mode.
      // Everything else is a direct call: no marker, or a forged or expired one.
      const direct = !(origin.viaGateway && origin.trusted);
      const mode = direct ? currentGatewayOnlyMode() : "off";
      const cors = applyServiceCorsHeaders(req, res, settings, corsAllowHeaders);
      if (!cors.ok) return serviceGatewayReject(res, 403, "origin_not_allowed", cors.message);
      if (req.method === "OPTIONS") return res.status(204).end();
      if (direct && mode === "enforce") {
        return serviceGatewayReject(res, 403, "gateway_only", GATEWAY_ONLY_MESSAGE);
      }
      if (direct && mode === "warn") {
        res.setHeader("deprecation", "true");
        res.setHeader("link", DIRECT_DEPRECATION_LINK);
        noteDirectCall(req, kind, origin);
      }
      if (!isServiceKindEnabled(settings, kind)) {
        return serviceGatewayReject(res, 404, "endpoint_disabled", `${kind} gateway is disabled by service exposure settings.`);
      }
      if (settings.enabled && settings.exposureMode === "local" && !isLocalRequester(req)) {
        return serviceGatewayReject(res, 403, "local_only", "Service exposure mode is local-only.");
      }
      const presentedKey = extractServiceApiKey(req.headers || {}, { acceptRawAuthorization });
      const credential = await resolveDirectCredential(presentedKey, kind, settings, mode);
      if (credential.unavailable) {
        return serviceGatewayReject(res, 503, "key_store_unavailable", "The platform key store is unavailable; try again shortly.");
      }
      const serviceClient = credential.client;
      if (settings.enabled && settings.requireApiKey) {
        // With the entry's store in play the legacy files no longer say
        // whether any key exists, so a missing key is simply a 401.
        if (!credential.decided && typeof verifyAccessKey !== "function") {
          const clientsLedger = await getServiceClientsLedger();
          if (!hasGlobalServiceApiKey(settings) && !hasActiveServiceClients(clientsLedger)) {
            return serviceGatewayReject(res, 503, "api_key_not_configured", "API key is required, but no service API key is configured.");
          }
        }
        if (!credential.accepted) {
          return serviceGatewayReject(res, 401, "unauthorized", "Missing or invalid service API key.", { "www-authenticate": "Bearer" });
        }
      }
      const effectiveSettings = buildEffectiveServiceSettings(settings, serviceClient);
      const clientKey = serviceClient?.keyId ? `key:${serviceClient.keyId}` : serviceClient?.id || serviceClientFingerprint(req, presentedKey);
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
      armRelease(res, concurrencySlot, effectiveSettings, clientKey);
      req.serviceGateway = {
        kind,
        settings: effectiveSettings,
        baseSettings: settings,
        client: serviceClient,
        clientId: credential.clientId,
        ...(credential.credentialManagerId ? { credentialManagerId: credential.credentialManagerId } : {}),
        ...(credential.keyId ? { keyId: credential.keyId } : {}),
        clientKey,
        timeoutMs,
        queuedMs: concurrencySlot.queuedMs || 0,
        selectedInstanceId: resolveServiceEntrySelectedInstance(req),
      };
      res.setHeader("x-local-llm-gateway", gatewayName);
      res.setHeader("x-local-llm-queued-ms", String(concurrencySlot.queuedMs || 0));
      armTimeout(res, timeoutMs);
      return next();
    } catch (error) {
      return serviceGatewayReject(res, 500, "gateway_error", error.message);
    }
  };
}

module.exports = {
  waitForServiceGatewayConcurrency,
  resolveNextServiceGatewayWaiter,
  SERVICE_ENTRY_INSTANCE_HEADER,
  SERVICE_ENTRY_INSTANCE_SIGNATURE_HEADER,
  normalizeServiceEntryInstanceId,
  signServiceEntryInstance,
  buildServiceEntryInstanceHeaders,
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
  findServedModelByRoot,
  deriveOpenAiGatewayModelAliases,
  buildOpenAiGatewayAliasList,
  resolveOpenAiGatewayModel,
  buildOpenAiGatewayModelList,
  OPENAI_GATEWAY_REQUEST_ID_HEADER,
  normalizeOpenAiGatewayRequestId,
  ensureOpenAiGatewayRequestId,
  mergeOpenAiGatewayRequestId,
  normalizeOpenAiUsage,
  extractOpenAiUsagePayload,
  createOpenAiStreamOutputEstimator,
  observeOpenAiStreamDelta,
  createOpenAiSseUsageParser,
  includeOpenAiStreamUsage,
  estimateOpenAiRequestInputTokens,
  resolveOpenAiMaxOutputTokens,
  billingGatewayRejection,
  createOpenAiUsageFinalizer,
  createServiceUpstreamControl,
  streamRawOpenAiGatewayResponse,
  createOpenAiGatewayHandlers,
  getServiceGatewayKind,
  isServiceKindEnabled,
  appendVaryHeader,
  isServiceOriginAllowed,
  SERVICE_CORS_EXPOSE_HEADERS,
  applyServiceCorsHeaders,
  configureGatewayTrust,
  resolveGatewayRequestOrigin,
  resolveServiceEntrySelectedInstance,
  isLocalRequester,
  serviceClientFingerprint,
  serviceGatewayReject,
  onResponseDone,
  buildServiceGatewayAccessLogEntry,
  attachServiceGatewayAccessLog,
  GATEWAY_ONLY_MODES,
  DEFAULT_GATEWAY_BACKSTOP_CONCURRENCY,
  normalizeGatewayOnlyMode,
  createGatewayOnlyModeReader,
  createServiceGatewayMiddleware,
};
