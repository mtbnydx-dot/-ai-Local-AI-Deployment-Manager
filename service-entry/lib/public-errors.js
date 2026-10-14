"use strict";

// Public error taxonomy and content negotiation (docs/overhaul/05-public.md §10).
//
// Every error a public caller can see (PUBLIC listener, ADMIN /gateway/*,
// portal) comes from the one table below, so the OpenAI shape, the Anthropic
// shape and the browser page can never disagree about status or meaning.
//
// Messages are stable English constants; the portal translates by `code`. They
// never carry paths, ports, manager names, env names or file names. Whatever
// detail a caller passes in (`opts.detail`) is redacted and handed back for the
// server log only; it is never serialized into a response.
//
// A browser gets an HTML page only when wantsHtml(req) holds. The page is
// rendered from service-entry/portal/error.html with every value escaped, no
// script, and a CSP that would block one anyway.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { redactSecrets } = require("../../manager-core/secret-redactor");

const ERROR_TEMPLATE_PATH = path.join(__dirname, "..", "portal", "error.html");
const FALLBACK_CODE = "internal_error";
const DOCS_ERRORS_PATH = "/docs/errors";
const DOCS_API_PATH = "/docs/quickstart";
const STATUS_PATH = "/status";
const LANGUAGES = Object.freeze(["zh-CN", "en-US"]);
const DEFAULT_LANGUAGE = "en-US";
// A 429 always carries retry-after (§9.6). Callers pass the real reset time;
// this is only the floor when one forgets. `overloaded` uses 5 s (§9.5).
const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 30 * 24 * 60 * 60;
const MAX_DETAIL_LENGTH = 500;
const MAX_PARAM_LENGTH = 128;
const REQUEST_ID_RE = /^(?:req|mgr)_[a-z2-7]{20}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// Headers that carry a key (the ones core.extractServiceApiKey reads). Their
// presence marks an API client, which never gets an HTML page.
const API_KEY_HEADERS = Object.freeze(["authorization", "x-api-key", "api-key", "anthropic-api-key", "anthropic_api_key"]);

// API path prefixes answer JSON unless wantsHtml; then the page says "this is
// an API endpoint" instead of showing a bare error.
const API_PATH_RE = /^\/(?:v1|anthropic|vllm|llama|gateway)(?:\/|$)/;
// Portal shell routes (§3.2). There a tie between text/html and
// application/json goes to HTML; everywhere else it goes to JSON.
const PORTAL_PATH_RE = /^\/(?:status|models(?:\/[^/]+)?|docs(?:\/[^/]+)?|me|playground|announcements)?\/?$/;
// Anthropic-protocol routes (§8.1, §8.4): /anthropic/*, the /v1/messages
// aliases (also under the /vllm and /llama aliases) and /gateway/*/claude/*.
const ANTHROPIC_PATH_RE = /^\/(?:anthropic(?:\/|$)|(?:(?:vllm|llama)\/)?v1\/messages(?:\/|$)|gateway\/(?:external\/[^/]+|[^/]+)\/claude(?:\/|$))/;

const COMMON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});

// The page loads no script and no inline style, so the policy can be this
// tight; style-src 'self' admits the portal stylesheet only.
const HTML_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  ...COMMON_HEADERS,
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
});

// Page chrome, per language. Code-specific copy lives in the taxonomy.
const PAGE_LABELS = Object.freeze({
  "zh-CN": Object.freeze({
    statusLabel: "错误",
    stepsLabel: "下一步",
    codeLabel: "错误代码",
    requestIdLabel: "请求 ID",
    linksLabel: "相关链接",
    statusLinkLabel: "服务状态",
    docsLinkLabel: "查看此错误的说明",
    apiDocsLinkLabel: "API 文档",
    homeLinkLabel: "首页",
  }),
  "en-US": Object.freeze({
    statusLabel: "Error",
    stepsLabel: "What to do",
    codeLabel: "Error code",
    requestIdLabel: "Request ID",
    linksLabel: "Related links",
    statusLinkLabel: "Service status",
    docsLinkLabel: "About this error",
    apiDocsLinkLabel: "API docs",
    homeLinkLabel: "Home",
  }),
});

// Shown instead of the code's own copy when a browser opens an API path.
const API_ENDPOINT_COPY = Object.freeze({
  "zh-CN": Object.freeze({
    title: "这是 API 接口地址",
    explanation: "此地址供调用 API 的程序使用，不适合在浏览器中直接打开。",
    steps: Object.freeze([
      "在兼容 OpenAI 或 Anthropic 的客户端中把它设为 Base URL，并填入你的 API 密钥。",
      "文档里有常见客户端的可复制示例。",
    ]),
  }),
  "en-US": Object.freeze({
    title: "This is an API endpoint",
    explanation: "This address is meant for programs that call the API, not for opening in a browser.",
    steps: Object.freeze([
      "Set it as the base URL in an OpenAI- or Anthropic-compatible client, together with your API key.",
      "The docs have copy-paste examples for common clients.",
    ]),
  }),
});

function copy(title, explanation, steps) {
  return Object.freeze({ title, explanation, steps: Object.freeze(steps.slice()) });
}

function entry(code, http, types, message, zh, en, extra = {}) {
  const [status, anthropicStatus = status] = Array.isArray(http) ? http : [http];
  const [openaiType, anthropicType = openaiType] = Array.isArray(types) ? types : [types];
  return Object.freeze({
    code,
    status,
    anthropicStatus,
    openaiType,
    anthropicType,
    message,
    param: extra.param ?? null,
    retryAfterSeconds: extra.retryAfterSeconds ?? (status === 429 ? DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS : null),
    copy: Object.freeze({ "zh-CN": zh, "en-US": en }),
  });
}

const AUTH = "authentication_error";
const PERMISSION = "permission_error";
const INVALID = "invalid_request_error";
const RATE = "rate_limit_error";
const SERVER = ["server_error", "api_error"];

const STATUS_STEP_ZH = "查看状态页，稍后再试。";
const STATUS_STEP_EN = "Check the status page, then retry later.";
const REPORT_STEP_ZH = "如果持续失败，请把请求 ID 提供给服务管理员。";
const REPORT_STEP_EN = "If it keeps failing, give the request ID to the service owner.";
const RETRY_AFTER_STEP_ZH = "等待 retry-after 响应头给出的时间后再重试。";
const RETRY_AFTER_STEP_EN = "Wait for the time given in the retry-after header, then try again.";

// §10.2, in table order. Docs anchor for each code: /docs/errors#<code>.
const PUBLIC_ERROR_TAXONOMY = Object.freeze([
  entry("missing_api_key", 401, AUTH,
    "Missing API key. Send it in the Authorization header as 'Bearer <key>'.",
    copy("需要 API 密钥", "此接口需要 API 密钥，但请求中没有携带。", [
      "在 Authorization 请求头中以 Bearer <密钥> 的形式发送密钥。",
      "Anthropic 客户端也可以用 x-api-key 请求头发送。",
      "如果还没有密钥，请向服务管理员申请。",
    ]),
    copy("API key required", "This endpoint needs an API key, and the request did not include one.", [
      "Send the key in the Authorization header as Bearer <key>.",
      "Anthropic clients can send it in the x-api-key header instead.",
      "If you have no key yet, ask the service owner for one.",
    ])),
  entry("invalid_api_key", 401, AUTH,
    "Invalid API key. Check the key; it may be mistyped or may have been rotated.",
    copy("API 密钥无效", "请求中的密钥与任何有效密钥都不匹配，可能输错了，也可能已被轮换。", [
      "从管理员分享的位置重新复制密钥，注意不要带多余空格。",
      "如果密钥已轮换，请改用新密钥。",
      "同一地址多次认证失败会被暂时封禁。",
    ]),
    copy("API key not recognized", "The key in the request does not match any active key. It may be mistyped or may have been rotated.", [
      "Copy the key again from where the owner shared it, without extra spaces.",
      "If the key was rotated, use the new one.",
      "Repeated failures from one address are blocked for a while.",
    ])),
  entry("key_expired", 401, AUTH,
    "This API key has expired. Ask the service owner to renew it.",
    copy("API 密钥已过期", "此密钥已超过有效期，无法继续使用。", ["请联系服务管理员续期或签发新密钥。"]),
    copy("API key expired", "This key has passed its expiry date and no longer works.", [
      "Ask the service owner to renew the key or issue a new one.",
    ])),
  entry("key_disabled", 403, PERMISSION,
    "This API key is disabled or has been revoked.",
    copy("API 密钥已停用", "服务管理员已停用或吊销此密钥。", ["请联系服务管理员确认能否恢复，或申请新密钥。"]),
    copy("API key disabled", "The service owner has disabled or revoked this key.", [
      "Ask the service owner whether the key can be re-enabled, or request a new one.",
    ])),
  entry("scope_denied", 403, PERMISSION,
    "This API key is not allowed to use this endpoint.",
    copy("此密钥无权访问该接口", "密钥有效，但不包含访问此接口的权限。", [
      "在“我的密钥”页面查看密钥可用的接口。",
      "如需使用，请让服务管理员为密钥添加相应权限。",
    ]),
    copy("Endpoint not allowed for this key", "The key is valid but does not include permission for this endpoint.", [
      "Check which endpoints your key may use on the My Key page.",
      "Ask the service owner to add the permission if you need it.",
    ])),
  entry("model_not_allowed", 403, PERMISSION,
    "This API key is not allowed to use the requested model.",
    copy("此密钥无权使用该模型", "密钥有效，但不允许使用请求的模型。", [
      "通过 /v1/models 查看密钥可用的模型。",
      "如需使用，请让服务管理员把该模型加入密钥的允许列表。",
    ]),
    copy("Model not allowed for this key", "The key is valid but may not use the requested model.", [
      "List the models your key may use at /v1/models.",
      "Ask the service owner to add the model to your key.",
    ]),
    { param: "model" }),
  entry("origin_not_allowed", 403, PERMISSION,
    "Requests from this web origin are not allowed for this API key. Add the origin under My Key.",
    copy("网页来源不被允许", "此密钥不接受来自发起请求的网页来源。", [
      "在“我的密钥”中添加该网页的来源。",
      "服务端程序不发送来源，不受此限制。",
    ]),
    copy("Web origin not allowed", "This key does not accept requests from the web page that sent this one.", [
      "Add the page's origin under My Key.",
      "Server-side clients send no origin and are not affected.",
    ])),
  entry("ip_not_allowed", 403, PERMISSION,
    "Requests from this IP address are not allowed for this API key.",
    copy("IP 地址不被允许", "此密钥只接受来自指定 IP 地址的请求，而本次请求来自其他地址。", [
      "请从允许的网络调用，或让服务管理员添加你的地址。",
    ]),
    copy("IP address not allowed", "This key accepts requests only from specific IP addresses, and this request came from another one.", [
      "Call from an allowed network, or ask the service owner to add your address.",
    ])),
  entry("csrf_invalid", 403, PERMISSION,
    "The console session check failed. Reload the console and try again.",
    copy("控制台会话校验失败", "控制台请求缺少安全令牌，或令牌已经过期。", [
      "刷新控制台页面后重试。",
      "如果反复出现，请重新配对控制台。",
    ]),
    copy("Console session check failed", "The console request was missing its security token, or the token is out of date.", [
      "Reload the console page and try again.",
      "If it keeps happening, pair the console again.",
    ])),
  entry("model_not_found", 404, [INVALID, "not_found_error"],
    "The requested model does not exist or is not published. List the available models at /v1/models.",
    copy("找不到模型", "没有已发布的模型使用请求中的名称。", [
      "通过 /v1/models 查看可用模型，并准确复制模型 id。",
      "模型也可能暂时离线，请查看状态页。",
    ]),
    copy("Model not found", "No published model has the requested name.", [
      "List the available models at /v1/models and copy the id exactly.",
      "The model may also be offline for now; see the status page.",
    ])),
  entry("not_found", 404, [INVALID, "not_found_error"],
    "The requested resource was not found.",
    copy("页面不存在", "此地址下没有任何内容。", ["检查地址是否输错。", "从首页或文档页重新进入。"]),
    copy("Page not found", "There is nothing at this address.", [
      "Check the address for typos.",
      "Start again from the home page or the docs.",
    ])),
  entry("method_not_allowed", 405, [INVALID, "not_found_error"],
    "This HTTP method is not allowed for this endpoint.",
    copy("不支持的请求方法", "此地址不接受该 HTTP 方法。", ["请查阅 API 文档，确认此接口要求的方法。"]),
    copy("Method not allowed", "This address does not accept this HTTP method.", [
      "Check the API docs for the method this endpoint expects.",
    ])),
  entry("invalid_request", 400, INVALID,
    "The request is invalid.",
    copy("请求无效", "请求缺少必填字段，或包含服务无法接受的值。", [
      "对照 API 文档检查请求内容。",
      "向管理员求助时请附上请求 ID。",
    ]),
    copy("Invalid request", "The request is missing a required field or has a value the service cannot accept.", [
      "Compare the request with the API docs.",
      "Quote the request ID if you ask the owner for help.",
    ])),
  entry("invalid_json", 400, INVALID,
    "The request body is not valid JSON.",
    copy("JSON 格式错误", "请求体无法解析为 JSON。", ["请发送合法的 JSON 对象，并把 content-type 设为 application/json。"]),
    copy("Invalid JSON", "The request body could not be parsed as JSON.", [
      "Send a valid JSON object with content-type application/json.",
    ])),
  entry("max_tokens_exceeded", 400, INVALID,
    "The requested maximum output tokens exceed the limit for this API key.",
    copy("超出输出长度上限", "请求的最大输出长度超过了此密钥的上限。", [
      "把 max_tokens（或 max_completion_tokens）降到“我的密钥”中显示的上限以内，或者不填，自动使用上限。",
    ]),
    copy("Output limit exceeded", "The requested maximum output length is above the limit for this key.", [
      "Lower max_tokens (or max_completion_tokens) to the limit shown on My Key, or leave it out to use the limit.",
    ])),
  entry("request_exceeds_tpm", 400, INVALID,
    "This request needs more tokens than the per-minute token limit of this API key allows. Reduce the input or the maximum output tokens.",
    copy("单个请求超过每分钟令牌上限", "这一个请求需要的令牌数就超过了密钥每分钟的上限，按原样发送永远无法成功。", [
      "缩短输入，或降低最大输出长度。",
      "如需更高的每分钟令牌上限，请联系服务管理员。",
    ]),
    copy("Request larger than the token rate limit", "This single request needs more tokens than the key may use per minute, so it can never succeed as sent.", [
      "Shorten the input or lower the maximum output.",
      "Ask the service owner for a higher tokens-per-minute limit.",
    ])),
  entry("unknown_engine", 400, INVALID,
    "Unknown engine in the request path.",
    copy("未知引擎", "请求路径中指定的引擎不存在。", ["改用 auto 路由，或在文档中核对引擎名称。"]),
    copy("Unknown engine", "The engine named in the request path does not exist.", [
      "Use the auto route, or check the engine name in the docs.",
    ])),
  entry("request_too_large", 413, [INVALID, "request_too_large"],
    "The request body is too large.",
    copy("请求体过大", "请求体超过了服务允许的大小。", ["减少单次请求的数据量，例如减少或压缩图片。"]),
    copy("Request too large", "The request body is larger than the service accepts.", [
      "Send less data in one request, for example fewer or smaller images.",
    ])),
  entry("unsupported_media_type", 415, INVALID,
    "Unsupported content type. Send the request body as JSON with content-type application/json.",
    copy("不支持的内容类型", "此接口不接受该请求体的内容类型。", ["请以 JSON 发送，并把 content-type 设为 application/json。"]),
    copy("Unsupported content type", "The request body has a content type this endpoint does not accept.", [
      "Send JSON with content-type application/json.",
    ])),
  entry("ip_rate_limited", 429, RATE,
    "Too many requests from this address. Retry after the time in the retry-after header.",
    copy("该地址请求过于频繁", "此网络地址在短时间内发送了过多请求。", [RETRY_AFTER_STEP_ZH]),
    copy("Too many requests from this address", "This network address sent too many requests in a short time.", [RETRY_AFTER_STEP_EN])),
  entry("auth_banned", 429, RATE,
    "Too many failed authentication attempts from this address. Retry after the time in the retry-after header.",
    copy("已被暂时封禁", "此地址认证失败的次数过多，已被暂时封禁。", [
      RETRY_AFTER_STEP_ZH,
      "重试前请确认客户端发送的是正确的密钥。",
    ]),
    copy("Temporarily blocked", "Too many failed authentication attempts came from this address, so it is blocked for a while.", [
      RETRY_AFTER_STEP_EN,
      "Check that your client sends the right key before retrying.",
    ])),
  entry("rate_limit_exceeded", 429, RATE,
    "Request rate limit reached for this API key. Back off and retry after the time in the retry-after header.",
    copy("已达到请求频率上限", "此密钥每分钟的请求数超过了上限。", [RETRY_AFTER_STEP_ZH, "在“我的密钥”中查看限额。"]),
    copy("Request rate limit reached", "This key sent more requests per minute than its limit allows.", [
      RETRY_AFTER_STEP_EN,
      "Check the limits on My Key.",
    ])),
  entry("tokens_rate_limit_exceeded", 429, RATE,
    "Token rate limit reached for this API key. Back off and retry after the time in the retry-after header.",
    copy("已达到令牌速率上限", "此密钥每分钟使用的令牌数超过了上限。", [RETRY_AFTER_STEP_ZH, "缩短请求，或降低最大输出长度。"]),
    copy("Token rate limit reached", "This key used more tokens per minute than its limit allows.", [
      RETRY_AFTER_STEP_EN,
      "Send shorter requests or lower the maximum output.",
    ])),
  entry("concurrency_limit_exceeded", 429, RATE,
    "Too many concurrent requests for this API key. Wait for a running request to finish.",
    copy("并发请求过多", "此密钥正在进行的请求数已达上限。", ["等待正在进行的请求完成后再发送新的请求。"]),
    copy("Too many requests at once", "This key already has as many requests running as it is allowed.", [
      "Wait for a running request to finish before sending another.",
    ])),
  entry("insufficient_quota", 429, ["insufficient_quota", RATE],
    "The quota for this API key is used up. It resets at the start of the next period.",
    copy("额度已用完", "此密钥的每日、每月或计费额度已经用完。", [
      "等待额度重置，retry-after 响应头给出了剩余时间。",
      "如需更多额度，请联系服务管理员。",
    ]),
    copy("Quota used up", "This key has used up its daily, monthly or billing quota.", [
      "Wait for the quota to reset; the retry-after header gives the time.",
      "Ask the service owner for a larger quota.",
    ])),
  entry("overloaded", [503, 529], ["server_error", "overloaded_error"],
    "The service is at capacity. Retry shortly.",
    copy("服务繁忙", "公共容量当前已全部占用。", ["请几秒后重试。"]),
    copy("Service at capacity", "All public capacity is in use right now.", ["Retry in a few seconds."]),
    { retryAfterSeconds: 5 }),
  entry("model_unavailable", 503, SERVER,
    "The requested model is not available right now. Check the service status page.",
    copy("模型暂不可用", "请求的模型存在，但当前没有运行。", [STATUS_STEP_ZH]),
    copy("Model not available", "The requested model exists but is not running right now.", [STATUS_STEP_EN])),
  entry("service_unavailable", 503, SERVER,
    "The service is temporarily unavailable. Check the service status page.",
    copy("服务暂时不可用", "服务暂时无法处理请求。", [STATUS_STEP_ZH]),
    copy("Service unavailable", "The service is temporarily unable to handle requests.", [STATUS_STEP_EN])),
  entry("auth_unavailable", 503, SERVER,
    "Authentication is temporarily unavailable. Retry shortly.",
    copy("认证暂不可用", "当前无法校验密钥，出于安全考虑暂时拒绝请求。", [STATUS_STEP_ZH]),
    copy("Authentication unavailable", "Keys cannot be checked right now, so requests are refused for safety.", [STATUS_STEP_EN])),
  entry("billing_unavailable", 503, SERVER,
    "Billing is temporarily unavailable. Retry shortly.",
    copy("计费暂不可用", "当前无法记录用量，计费请求已暂停。", [STATUS_STEP_ZH]),
    copy("Billing unavailable", "Usage cannot be recorded right now, so billed requests are paused.", [STATUS_STEP_EN])),
  entry("upstream_error", 502, SERVER,
    "The model service returned an error. Quote the request_id when reporting it.",
    copy("模型服务出错", "模型服务在处理请求时返回了错误。", ["重试请求。", REPORT_STEP_ZH]),
    copy("Model service error", "The model service returned an error while handling the request.", ["Retry the request.", REPORT_STEP_EN])),
  entry("upstream_timeout", 504, SERVER,
    "The model service did not respond in time. Quote the request_id when reporting it.",
    copy("模型服务超时", "模型服务未能及时响应。", ["长时间生成请使用 stream: true。", REPORT_STEP_ZH]),
    copy("Model service timed out", "The model service did not answer in time.", ["Use stream: true for long generations.", REPORT_STEP_EN])),
  entry("internal_error", 500, SERVER,
    "Internal error. Quote the request_id when reporting it.",
    copy("内部错误", "服务内部出现了问题。", ["重试请求。", REPORT_STEP_ZH]),
    copy("Internal error", "Something went wrong inside the service.", ["Retry the request.", REPORT_STEP_EN])),
]);

const TAXONOMY_BY_CODE = new Map(PUBLIC_ERROR_TAXONOMY.map((item) => [item.code, item]));

function publicErrorCodes() {
  return PUBLIC_ERROR_TAXONOMY.map((item) => item.code);
}

function lookupPublicError(code) {
  return TAXONOMY_BY_CODE.get(String(code || "")) || null;
}

function newRequestId(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(20);
  let id = "req_";
  // 256 is a multiple of 32, so masking keeps every letter equally likely.
  for (const byte of bytes) id += BASE32_ALPHABET[byte & 31];
  return id;
}

function validRequestId(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && REQUEST_ID_RE.test(text) ? text : "";
}

function normalizeRetryAfter(value) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
}

// `param` names a request field or endpoint (`model`, `daily_tokens`,
// `/v1/embeddings`). Anything else is dropped rather than echoed.
function normalizeParam(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.length > MAX_PARAM_LENGTH || !/^[A-Za-z0-9_.:/[\]-]+$/.test(text)) return null;
  return text;
}

function normalizeDetail(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : safeStringify(value);
  return redactSecrets(String(text || "")).slice(0, MAX_DETAIL_LENGTH);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// publicError(code, { param, retryAfterSeconds, detail, requestId })
//   -> { code, status, anthropicStatus, headers, openai, anthropic, detail }
// An unknown code renders as internal_error so an internal name never leaks;
// the original code stays in `detail` for the log.
function publicError(code, opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const known = lookupPublicError(code);
  const item = known || TAXONOMY_BY_CODE.get(FALLBACK_CODE);
  const requestId = validRequestId(options.requestId) || newRequestId();
  const param = normalizeParam(options.param) ?? item.param;
  const retryAfter = normalizeRetryAfter(options.retryAfterSeconds) ?? item.retryAfterSeconds;
  const detailParts = [];
  if (!known) detailParts.push(`unmapped error code: ${normalizeDetail(code) || "(empty)"}`);
  const detail = normalizeDetail(options.detail);
  if (detail) detailParts.push(detail);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...COMMON_HEADERS,
    "x-request-id": requestId,
  };
  if (retryAfter !== null) headers["retry-after"] = String(retryAfter);
  return {
    code: item.code,
    status: item.status,
    anthropicStatus: item.anthropicStatus,
    headers,
    openai: {
      error: { message: item.message, type: item.openaiType, code: item.code, param },
      request_id: requestId,
    },
    anthropic: {
      type: "error",
      error: { type: item.anthropicType, message: item.message },
      request_id: requestId,
    },
    detail: detailParts.join("; ").slice(0, MAX_DETAIL_LENGTH),
  };
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

function hasApiKeyHeader(headers = {}) {
  return API_KEY_HEADERS.some((name) => headerValue(headers, name).trim() !== "");
}

// Accept / Accept-Language lists: "a;q=0.8, b" -> [{ value, q, index }].
// Ranges with q=0 are kept, because "not acceptable" must win over a wildcard.
function parseQualityList(header) {
  const items = [];
  String(header || "").split(",").forEach((part, index) => {
    const [rawValue, ...params] = part.split(";");
    const value = rawValue.trim().toLowerCase();
    if (!value) return;
    let q = 1;
    for (const param of params) {
      const match = param.trim().match(/^q\s*=\s*([0-9.]+)$/i);
      if (match) {
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
      }
    }
    items.push({ value, q, index });
  });
  return items;
}

// RFC 9110 §12.5.1: the most specific matching range decides the quality.
// A missing Accept header means */*.
function acceptQuality(acceptHeader, mediaType) {
  const ranges = parseQualityList(acceptHeader);
  if (!ranges.length) return 1;
  const [type, subtype] = String(mediaType).toLowerCase().split("/");
  let best = null;
  for (const range of ranges) {
    const [rangeType, rangeSubtype = ""] = range.value.split("/").map((part) => part.trim());
    let specificity = -1;
    if (rangeType === type && rangeSubtype === subtype) specificity = 2;
    else if (rangeType === type && rangeSubtype === "*") specificity = 1;
    else if (rangeType === "*" && rangeSubtype === "*") specificity = 0;
    if (specificity < 0) continue;
    if (!best || specificity > best.specificity) best = { specificity, q: range.q };
  }
  return best ? best.q : 0;
}

// wantsHtml(req) = method === "GET" && !hasApiKeyHeader && accepts(text/html)
// ranks above accepts(application/json) (§10.3). `portal: true` is the portal
// route variant: a tie goes to HTML there, and only an explicit JSON
// preference keeps JSON.
function wantsHtml(req, options = {}) {
  const portal = Boolean(options?.portal);
  if (String(req?.method || "").toUpperCase() !== "GET") return false;
  const headers = req?.headers || {};
  if (hasApiKeyHeader(headers)) return false;
  const accept = headerValue(headers, "accept");
  const html = acceptQuality(accept, "text/html");
  if (html <= 0) return false;
  const json = acceptQuality(accept, "application/json");
  return portal ? html >= json : html > json;
}

// zh or en from Accept-Language, highest quality first; anything else (or no
// header) reads English.
function pickLanguage(acceptLanguage) {
  const ranked = parseQualityList(acceptLanguage)
    .filter((item) => item.q > 0)
    .sort((a, b) => (b.q - a.q) || (a.index - b.index));
  for (const item of ranked) {
    const primary = item.value.split("-")[0];
    if (primary === "zh") return "zh-CN";
    if (primary === "en") return "en-US";
  }
  return DEFAULT_LANGUAGE;
}

function requestPathname(req) {
  const url = String(req?.url || "/");
  const pathname = url.split(/[?#]/)[0] || "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function isApiPath(pathname) {
  return API_PATH_RE.test(String(pathname || ""));
}

function isPortalPath(pathname) {
  return !isApiPath(pathname) && PORTAL_PATH_RE.test(String(pathname || ""));
}

function protocolForPath(pathname) {
  return ANTHROPIC_PATH_RE.test(String(pathname || "")) ? "anthropic" : "openai";
}

function normalizeProtocol(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "anthropic" || text === "claude") return "anthropic";
  if (text === "openai" || text === "opencode") return "openai";
  return "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

// Stylesheets must be same-origin paths (the portal CSS under /assets/<id>/).
function safeStylesheets(list) {
  return (Array.isArray(list) ? list : [])
    .map((href) => String(href || "").trim())
    .filter((href) => /^\/(?!\/)[A-Za-z0-9._~/-]*$/.test(href))
    .slice(0, 4);
}

let cachedTemplate = null;

// Template comments are for maintainers; they name source files, so they are
// stripped before anything reaches a public caller.
function loadErrorTemplate() {
  if (cachedTemplate === null) {
    cachedTemplate = fs.readFileSync(ERROR_TEMPLATE_PATH, "utf8").replace(/<!--[\s\S]*?-->\r?\n?/g, "");
  }
  return cachedTemplate;
}

// renderErrorPage({ code, status, requestId, lang, variant, stylesheets }) -> html
// `variant: "api"` is the "this is an API endpoint" page for browsers that open
// an API path. Placeholders are filled in one pass, so a value that looks like
// a placeholder stays literal text.
function renderErrorPage(options = {}) {
  const item = lookupPublicError(options.code) || TAXONOMY_BY_CODE.get(FALLBACK_CODE);
  const lang = LANGUAGES.includes(options.lang) ? options.lang : DEFAULT_LANGUAGE;
  const labels = PAGE_LABELS[lang];
  const api = options.variant === "api";
  const text = api ? API_ENDPOINT_COPY[lang] : item.copy[lang];
  const status = Number.isInteger(options.status) ? options.status : item.status;
  const values = {
    ...labels,
    lang,
    status,
    title: text.title,
    explanation: text.explanation,
    code: item.code,
    requestId: options.requestId || "",
    statusHref: STATUS_PATH,
    docsHref: api ? DOCS_API_PATH : `${DOCS_ERRORS_PATH}#${item.code}`,
    docsLinkLabel: api ? labels.apiDocsLinkLabel : labels.docsLinkLabel,
  };
  // The only markup slots; both are built from escaped values here.
  const markup = {
    stylesheets: safeStylesheets(options.stylesheets)
      .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
      .join("\n"),
    steps: text.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("\n"),
  };
  const template = options.template ?? loadErrorTemplate();
  return template.replace(/\{\{([A-Za-z]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(markup, key)) return markup[key];
    if (Object.prototype.hasOwnProperty.call(values, key)) return escapeHtml(values[key]);
    return "";
  });
}

function mergeVary(existing, additions) {
  const names = [];
  for (const part of [existing, ...additions].join(",").split(",")) {
    const name = part.trim();
    if (name && !names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.join(", ");
}

// sendPublicError(req, res, code, { param, retryAfterSeconds, detail, requestId,
//   protocol, headers, stylesheets, log }) -> { sent, code, status, requestId, protocol, format }
// The protocol follows the path (Anthropic routes get the Anthropic shape and
// 529 for overloaded) unless opts.protocol says otherwise. HTML is sent only
// when wantsHtml(req) holds. opts.headers (CORS, rate-limit headers) are kept,
// but never override the content headers set here.
function sendPublicError(req, res, code, opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const pathname = requestPathname(req);
  const requestId = validRequestId(options.requestId)
    || validRequestId(req?.requestId)
    || validRequestId(typeof res?.getHeader === "function" ? res.getHeader("x-request-id") : "")
    || newRequestId();
  const error = publicError(code, { ...options, requestId });
  const protocol = normalizeProtocol(options.protocol) || protocolForPath(pathname);
  const status = protocol === "anthropic" ? error.anthropicStatus : error.status;
  const apiPath = isApiPath(pathname);
  let format = wantsHtml(req, { portal: isPortalPath(pathname) }) ? "html" : "json";
  let body = "";
  if (format === "html") {
    try {
      body = renderErrorPage({
        code: error.code,
        status,
        requestId,
        lang: pickLanguage(headerValue(req?.headers, "accept-language")),
        variant: apiPath ? "api" : "error",
        stylesheets: options.stylesheets,
      });
    } catch {
      // A missing template must not turn an error into a crash; JSON still
      // tells the caller what happened.
      format = "json";
    }
  }
  if (format === "json") body = JSON.stringify(protocol === "anthropic" ? error.anthropic : error.openai);

  const result = { sent: false, code: error.code, status, requestId, protocol, format };
  if (typeof options.log === "function") {
    try {
      options.log({ code: error.code, status, requestId, protocol, format, detail: error.detail });
    } catch {
      // Logging is best effort and must not change the response.
    }
  }
  if (!res || res.headersSent || res.writableEnded) {
    if (res && !res.writableEnded && typeof res.end === "function") res.end();
    return result;
  }

  const headers = {};
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value !== undefined && value !== null) headers[String(name).toLowerCase()] = value;
  }
  const ownHeaders = format === "html"
    ? { ...HTML_HEADERS, "x-request-id": requestId, ...(error.headers["retry-after"] ? { "retry-after": error.headers["retry-after"] } : {}) }
    : error.headers;
  Object.assign(headers, ownHeaders);
  headers.vary = mergeVary(headers.vary || "", ["Accept", "Accept-Language"]);
  const payload = Buffer.from(body, "utf8");
  headers["content-length"] = String(payload.length);
  res.writeHead(status, headers);
  res.end(String(req?.method || "").toUpperCase() === "HEAD" ? undefined : payload);
  result.sent = true;
  return result;
}

module.exports = {
  ERROR_TEMPLATE_PATH,
  PUBLIC_ERROR_TAXONOMY,
  acceptQuality,
  escapeHtml,
  hasApiKeyHeader,
  isApiPath,
  isPortalPath,
  lookupPublicError,
  newRequestId,
  pickLanguage,
  protocolForPath,
  publicError,
  publicErrorCodes,
  renderErrorPage,
  sendPublicError,
  wantsHtml,
};
