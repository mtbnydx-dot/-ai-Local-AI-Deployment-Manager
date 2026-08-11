const crypto = require("node:crypto");
const http = require("node:http");
const { Readable } = require("node:stream");

const DEFAULT_UPSTREAM_BASE_URL = "http://host.docker.internal:18080/v1";
const DEFAULT_SEARCH_BACKEND_URL = "http://searxng:8080";
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function envConfig(env = process.env) {
  return {
    // Loopback by default. The compose file sets 0.0.0.0 explicitly because a
    // container must bind all of its own interfaces; host exposure is then
    // controlled by SEARCH_GATEWAY_BIND on the published port.
    host: env.SEARCH_GATEWAY_HOST || "127.0.0.1",
    port: numberInRange(env.SEARCH_GATEWAY_PORT, 1, 65535, 5180),
    upstreamBaseUrl: trimTrailingSlash(env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL),
    upstreamApiKey: env.UPSTREAM_API_KEY || "",
    gatewayApiKey: env.SEARCH_GATEWAY_API_KEY || "",
    // Escape hatch for a trusted single-user machine. Without it, a gateway
    // with no key configured refuses every request instead of allowing them:
    // this process holds the upstream credential, so an open instance would
    // launder unauthenticated callers into authenticated model requests.
    allowNoKey: parseBool(env.SEARCH_GATEWAY_ALLOW_NO_KEY, false),
    searchBackendUrl: trimTrailingSlash(env.SEARCH_BACKEND_URL || DEFAULT_SEARCH_BACKEND_URL),
    searchMode: normalizeSearchPolicy(env.SEARCH_MODE || "auto"),
    maxResults: numberInRange(env.SEARCH_MAX_RESULTS, 1, 10, 5),
    timeoutMs: numberInRange(env.SEARCH_GATEWAY_TIMEOUT_MS, 1000, 30 * 60 * 1000, 10 * 60 * 1000),
    searchTimeoutMs: numberInRange(env.SEARCH_BACKEND_TIMEOUT_MS, 1000, 120000, 15000),
    failOpen: parseBool(env.SEARCH_FAIL_OPEN, true),
  };
}

function createSearchGatewayServer(config = envConfig(), deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("global fetch is required; use Node.js 20+.");

  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, config, fetchImpl);
    } catch (error) {
      sendJson(res, 500, openAiError("gateway_error", error.message || "Search gateway error."));
    }
  });
}

async function handleRequest(req, res, config, fetchImpl) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth(req, res, url, config, fetchImpl);
  }
  if (req.method === "GET" && (url.pathname === "/search" || url.pathname === "/v1/search")) {
    if (!authorizeGateway(req, config)) return sendAuthError(res, req);
    return handleDirectSearch(req, res, url, config, fetchImpl);
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!authorizeGateway(req, config)) return sendAuthError(res, req);
    return handleChatCompletions(req, res, url, config, fetchImpl);
  }
  if (url.pathname.startsWith("/v1/")) {
    if (!authorizeGateway(req, config)) return sendAuthError(res, req);
    return proxyOpenAiRequest(req, res, url, config, fetchImpl);
  }
  sendJson(res, 404, openAiError("not_found", "Unknown search gateway route."));
}

async function handleHealth(req, res, url, config, fetchImpl) {
  const payload = {
    ok: true,
    service: "local-ai-search-gateway",
    upstreamBaseUrl: config.upstreamBaseUrl,
    searchBackendUrl: config.searchBackendUrl,
    searchMode: config.searchMode,
    maxResults: config.maxResults,
    authRequired: Boolean(config.gatewayApiKey),
  };
  if (url.searchParams.get("deep") === "1") {
    payload.upstream = await probeJson(`${config.upstreamBaseUrl}/models`, buildUpstreamHeaders(req.headers, config), config.timeoutMs, fetchImpl);
    payload.search = await probeJson(`${config.searchBackendUrl}/search?q=health&format=json`, {}, config.searchTimeoutMs, fetchImpl);
    payload.ok = Boolean(payload.upstream.ok && payload.search.ok);
  }
  sendJson(res, payload.ok ? 200 : 503, payload, req);
}

async function handleDirectSearch(req, res, url, config, fetchImpl) {
  const query = String(url.searchParams.get("q") || "").trim();
  if (!query) return sendJson(res, 400, { ok: false, error: "Missing q query parameter." }, req);
  const options = searchOptionsFromInput({
    query,
    max_results: url.searchParams.get("max_results"),
    language: url.searchParams.get("language"),
    time_range: url.searchParams.get("time_range"),
    engines: url.searchParams.get("engines"),
    categories: url.searchParams.get("categories"),
  }, config);
  const result = await searchWeb(query, options, config, fetchImpl);
  sendJson(res, 200, { ok: true, ...result }, req);
}

async function handleChatCompletions(req, res, url, config, fetchImpl) {
  const rawBody = await readRequestBody(req, MAX_BODY_BYTES);
  const body = parseJsonBuffer(rawBody);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, openAiError("invalid_request_error", "Request body must be a JSON object."), req);
  }

  const policy = resolveSearchPolicy(req.headers, body, config);
  const needsSearch = policy === "always" || (policy === "auto" && shouldAutoSearch(body));
  if (!needsSearch) {
    const cleanBody = stripGatewayFields(body);
    return proxyOpenAiRequest(req, res, url, config, fetchImpl, Buffer.from(JSON.stringify(cleanBody)));
  }

  const userText = extractLatestUserText(body.messages);
  const options = searchOptionsFromInput(body.search_options || body.searchOptions || {}, config);
  const query = options.query || buildSearchQuery(userText);
  let searchResult = null;
  let searchError = "";
  if (query) {
    try {
      searchResult = await searchWeb(query, options, config, fetchImpl);
    } catch (error) {
      searchError = error.message || "Search failed.";
      if (!config.failOpen) {
        return sendJson(res, 502, openAiError("search_backend_error", searchError), req);
      }
    }
  }

  const augmentedBody = buildAugmentedChatBody(body, {
    query,
    searchedAt: new Date().toISOString(),
    results: searchResult?.results || [],
    answers: searchResult?.answers || [],
    searchError,
  });
  const responseHeaders = {
    "x-web-search-used": "true",
    "x-web-search-query": encodeURIComponent(query || ""),
  };
  return proxyOpenAiRequest(req, res, url, config, fetchImpl, Buffer.from(JSON.stringify(augmentedBody)), responseHeaders);
}

async function proxyOpenAiRequest(req, res, url, config, fetchImpl, bodyOverride = null, extraResponseHeaders = {}) {
  const targetUrl = new URL(`${config.upstreamBaseUrl}${url.pathname.replace(/^\/v1/, "")}`);
  targetUrl.search = url.search;
  const body = bodyOverride || (["GET", "HEAD"].includes(req.method) ? undefined : await readRequestBody(req, MAX_BODY_BYTES));
  const upstream = await fetchImpl(targetUrl, {
    method: req.method,
    headers: buildUpstreamHeaders(req.headers, config, body),
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const headers = responseHeadersFromFetch(upstream.headers, req, extraResponseHeaders);
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

async function searchWeb(query, options, config, fetchImpl = globalThis.fetch) {
  const searchUrl = new URL(`${config.searchBackendUrl}/search`);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("safesearch", String(options.safesearch ?? 1));
  if (options.language) searchUrl.searchParams.set("language", options.language);
  if (options.time_range) searchUrl.searchParams.set("time_range", options.time_range);
  if (options.engines) searchUrl.searchParams.set("engines", options.engines);
  if (options.categories) searchUrl.searchParams.set("categories", options.categories);

  const response = await fetchImpl(searchUrl, {
    headers: { accept: "application/json", "user-agent": "local-ai-search-gateway/0.1" },
    signal: AbortSignal.timeout(config.searchTimeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Search backend returned ${response.status}: ${clipText(text, 400)}`);
  }
  const data = parseJsonText(text);
  const results = normalizeSearchResults(data.results || [], options.maxResults || config.maxResults);
  const answers = normalizeAnswers(data.answers || []);
  return {
    query,
    searchedAt: new Date().toISOString(),
    count: results.length,
    results,
    answers,
    backend: config.searchBackendUrl,
  };
}

function resolveSearchPolicy(headers = {}, body = {}, config = envConfig()) {
  const headerValue = headers["x-web-search"] || headers["X-Web-Search"];
  const bodyValue = body.web_search ?? body.webSearch ?? body.search;
  return normalizeSearchPolicy(headerValue ?? bodyValue ?? config.searchMode);
}

function normalizeSearchPolicy(value) {
  if (value === true) return "always";
  if (value === false) return "off";
  const text = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "always", "force"].includes(text)) return "always";
  if (["0", "false", "no", "off", "none", "never"].includes(text)) return "off";
  return "auto";
}

function shouldAutoSearch(body = {}) {
  const text = extractLatestUserText(body.messages).toLowerCase();
  if (!text) return false;
  if (/(不要搜索|不用联网|无需联网|不要联网|do not search|no web|no internet|offline only)/i.test(text)) return false;

  const currentYear = new Date().getFullYear();
  const hasRecentYear = Array.from(text.matchAll(/\b(20\d{2})\b/g))
    .some((match) => Number(match[1]) >= currentYear - 1);
  if (hasRecentYear) return true;

  return /(最新|今天|今日|昨天|刚刚|现在|当前|联网|上网|搜索|搜一下|查一下|网上|网页|新闻|价格|股价|汇率|天气|版本|发布|更新|排名|current|latest|today|yesterday|now|recent|news|search|web|internet|online|price|stock|weather|release|version|changelog|ranking)/i.test(text);
}

function buildAugmentedChatBody(body, context) {
  const cleanBody = stripGatewayFields(body);
  const messages = Array.isArray(cleanBody.messages) ? cleanBody.messages : [];
  const searchMessage = {
    role: "system",
    content: formatSearchContext(context),
  };
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt]?.role === "system") insertAt += 1;
  return {
    ...cleanBody,
    messages: [
      ...messages.slice(0, insertAt),
      searchMessage,
      ...messages.slice(insertAt),
    ],
  };
}

function formatSearchContext(context) {
  const lines = [
    "Web search context for this request:",
    `- Search time: ${context.searchedAt || new Date().toISOString()}`,
    `- Query: ${context.query || "(none)"}`,
    "- Use these results only when they are relevant to the user's question.",
    "- Answer in the user's language. Cite web evidence with bracket numbers like [1] and include source URLs when useful.",
    "- If the results are insufficient or the search failed, say that clearly instead of inventing facts.",
  ];
  if (context.searchError) {
    lines.push(`- Search error: ${context.searchError}`);
  }
  if (Array.isArray(context.answers) && context.answers.length) {
    lines.push("", "Direct answers:");
    context.answers.forEach((answer, index) => lines.push(`A${index + 1}. ${clipText(answer, 600)}`));
  }
  if (Array.isArray(context.results) && context.results.length) {
    lines.push("", "Search results:");
    context.results.forEach((item, index) => {
      lines.push(`[${index + 1}] ${item.title || "(untitled)"}`);
      lines.push(`URL: ${item.url || ""}`);
      if (item.publishedDate) lines.push(`Published: ${item.publishedDate}`);
      if (item.engine) lines.push(`Engine: ${item.engine}`);
      if (item.content) lines.push(`Snippet: ${clipText(item.content, 700)}`);
      lines.push("");
    });
  } else if (!context.searchError) {
    lines.push("", "Search returned no usable results.");
  }
  return lines.join("\n").trim();
}

function stripGatewayFields(body) {
  const copy = { ...body };
  delete copy.web_search;
  delete copy.webSearch;
  delete copy.search;
  delete copy.search_options;
  delete copy.searchOptions;
  if (copy.metadata && typeof copy.metadata === "object" && !Array.isArray(copy.metadata)) {
    copy.metadata = { ...copy.metadata };
    delete copy.metadata.web_search;
    delete copy.metadata.webSearch;
  }
  return copy;
}

function extractLatestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return contentToText(message.content);
  }
  return "";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return part.text || part.input_text || "";
  }).filter(Boolean).join("\n");
}

function buildSearchQuery(text) {
  const cleaned = String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[“”"']/g, " ")
    .replace(/\b(please|can you|could you|search|look up|find|latest|current|today|now)\b/gi, " ")
    .replace(/(请|帮我|麻烦|搜索|搜一下|查一下|联网|上网|最新|今天|当前|现在|一下)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clipText(cleaned || text || "", 240).trim();
}

function searchOptionsFromInput(input = {}, config = envConfig()) {
  return {
    query: typeof input.query === "string" ? input.query.trim() : "",
    maxResults: numberInRange(input.max_results ?? input.maxResults, 1, 10, config.maxResults),
    language: cleanToken(input.language, 24),
    time_range: cleanToken(input.time_range ?? input.timeRange, 24),
    engines: cleanCsv(input.engines),
    categories: cleanCsv(input.categories),
    safesearch: input.safesearch ?? 1,
  };
}

function normalizeSearchResults(results, limit) {
  return results
    .filter((item) => item && typeof item === "object" && item.url)
    .slice(0, limit)
    .map((item) => ({
      title: clipText(String(item.title || item.url || ""), 240),
      url: String(item.url || ""),
      content: clipText(String(item.content || item.snippet || ""), 900),
      engine: Array.isArray(item.engines) ? item.engines.join(", ") : String(item.engine || ""),
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
      category: String(item.category || ""),
      publishedDate: String(item.publishedDate || item.published_date || ""),
    }));
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((answer) => {
    if (typeof answer === "string") return answer;
    if (!answer || typeof answer !== "object") return "";
    return answer.answer || answer.content || answer.text || answer.value || JSON.stringify(answer);
  }).map((answer) => clipText(String(answer || ""), 700)).filter(Boolean).slice(0, 3);
}

function buildUpstreamHeaders(incoming = {}, config = envConfig(), body = null) {
  const output = {
    accept: incoming.accept || "application/json",
    "user-agent": incoming["user-agent"] || "local-ai-search-gateway/0.1",
    "x-search-gateway": "1",
  };
  if (body) output["content-type"] = "application/json";
  if (config.upstreamApiKey) {
    output.authorization = `Bearer ${config.upstreamApiKey}`;
  } else if (incoming.authorization) {
    output.authorization = incoming.authorization;
  } else if (incoming["x-api-key"]) {
    output["x-api-key"] = incoming["x-api-key"];
  } else if (incoming["api-key"]) {
    output["api-key"] = incoming["api-key"];
  }
  return output;
}

function authorizeGateway(req, config = envConfig()) {
  if (!config.gatewayApiKey) {
    // Fail closed unless the operator opted out, or the listener is loopback
    // only and therefore no more reachable than the model service itself.
    if (config.allowNoKey) return true;
    return isLoopbackHost(config.host) && isLoopbackAddress(req?.socket?.remoteAddress);
  }
  const presented = bearerToken(req.headers.authorization)
    || stringHeader(req.headers["x-api-key"])
    || stringHeader(req.headers["api-key"]);
  return safeEqual(presented, config.gatewayApiKey);
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host || "").toLowerCase());
}

function isLoopbackAddress(value) {
  const address = String(value || "").replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "::1", "localhost", ""].includes(address);
}

function bearerToken(value) {
  const text = stringHeader(value);
  const match = text.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function stringHeader(value) {
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sendAuthError(res, req) {
  sendJson(res, 401, openAiError("unauthorized", "Missing or invalid search gateway API key."), req, {
    "www-authenticate": 'Bearer realm="local-ai-search-gateway"',
  });
}

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function parseJsonBuffer(buffer) {
  if (!buffer) return null;
  return parseJsonText(buffer.toString("utf8"));
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function probeJson(url, headers, timeoutMs, fetchImpl) {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function sendJson(res, status, payload, req = null, extraHeaders = {}) {
  res.writeHead(status, {
    ...corsHeaders(req),
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function responseHeadersFromFetch(headers, req, extraHeaders = {}) {
  const output = { ...corsHeaders(req), ...extraHeaders };
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "transfer-encoding", "content-encoding"].includes(lower)) continue;
    output[key] = value;
  }
  output["cache-control"] = output["cache-control"] || "no-store";
  return output;
}

function corsHeaders(req = null) {
  const origin = req?.headers?.origin || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key,api-key,x-web-search",
    "access-control-expose-headers": "x-web-search-used,x-web-search-query",
  };
}

function openAiError(code, message) {
  return {
    error: {
      message,
      type: code,
      code,
    },
  };
}

function numberInRange(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < min || integer > max) return fallback;
  return integer;
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function cleanToken(value, limit) {
  const text = String(value || "").trim();
  if (!text || !/^[\w.-]+$/.test(text)) return "";
  return text.slice(0, limit);
}

function cleanCsv(value) {
  return String(value || "")
    .split(",")
    .map((part) => cleanToken(part, 64))
    .filter(Boolean)
    .join(",");
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function clipText(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

if (require.main === module) {
  const config = envConfig();
  const server = createSearchGatewayServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Search gateway listening on http://${config.host}:${config.port}/v1 -> ${config.upstreamBaseUrl}`);
    console.log(`Search backend: ${config.searchBackendUrl}, mode=${config.searchMode}`);
  });
}

module.exports = {
  authorizeGateway,
  buildAugmentedChatBody,
  buildSearchQuery,
  contentToText,
  createSearchGatewayServer,
  envConfig,
  extractLatestUserText,
  formatSearchContext,
  normalizeSearchPolicy,
  normalizeAnswers,
  normalizeSearchResults,
  resolveSearchPolicy,
  searchOptionsFromInput,
  shouldAutoSearch,
  stripGatewayFields,
};
