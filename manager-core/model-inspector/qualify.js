"use strict";

// Qualification suite (docs/overhaul/02-models.md section 13, MOD-16).
//
// Runs fixed, tiny checks against ONE running instance with the instance's own
// endpoint and runtime key, so a model that "launched" is proven to answer:
// models, chat, reasoning-split, tool-call, json-output, vision, needle,
// speculative and throughput. The suite is pure manager-core code; the manager
// route (model-inspector-routes.js POST /api/qualify) wraps it in a
// `model-qualify` job via startQualifyJob(), builds the host record and hands
// it to host-records.js, which signs and pushes it to the entry (the only
// writer of service-entry/data/model-host-records.json).
//
// Rules the checks keep:
// - Requests use temperature 0, fixed prompts and no user data. The API key is
//   only ever a request header; no result, log line or job field carries it.
// - Output previews are cut to 240 characters and pass through the one
//   redactor (secret-redactor.js, marker <redacted>).
// - Without `needle` the whole run fits a 120 s budget; a check that cannot
//   start inside it is skipped, never half-run. A server that stops answering
//   ends the run: the check in flight fails, the rest are skipped and the
//   result is `partial`.
// - A failed check never removes a declared fact from the card; it only links
//   the root cause when an error signature matches the engine's answer.

const crypto = require("node:crypto");
const { redactSecrets } = require("../secret-redactor");

const CHECK_IDS = Object.freeze(["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "needle", "speculative", "throughput"]);
// Auto-qualify (section 13): the light set, about a minute of model time.
const LIGHT_CHECKS = Object.freeze(["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "throughput"]);
const QUALIFY_JOB_TYPE = "model-qualify";
const STATUSES = Object.freeze(["pass", "warn", "fail", "skip"]);
const DEFAULT_BUDGET_MS = 120_000;
const REQUEST_TIMEOUT_MS = 45_000;
const NEEDLE_TIMEOUT_MS = 600_000;
const PREVIEW_CHARS = 240;
const SPECULATIVE_WARN_BELOW = 0.3;
const NEEDLE_DEPTHS = Object.freeze([0.5, 0.9]);
const PONG_PROMPT = "Reply with the single word: pong";
const REASONING_PROMPT = "What is 12 + 30? Think it through briefly, then give the number.";
const THROUGHPUT_PROMPT = "Write one short paragraph about the sea.";
const WEATHER_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: { type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
  },
});
const WEATHER_RESULT = JSON.stringify({ city: "Paris", temperature_c: 18, condition: "cloudy" });
// A 32x32 solid red PNG (8-bit RGB), embedded so the vision check needs no file.
const RED_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const RED_PNG_DATA_URL = `data:image/png;base64,${RED_PNG_BASE64}`;
const OFF_VALUES = new Set(["", "off", "none", "disabled", "false", "0", "null"]);
const REASONING_TAG_LEAK = /<\/?think(?:ing)?>|<\|channel\|>|<\|start\|>assistant/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bilingual(zh, en) {
  return { zh, en };
}

/** One-line preview of model output: collapsed whitespace, redacted, at most 240 characters. */
function preview(value, max = PREVIEW_CHARS) {
  const text = redactSecrets(String(value ?? "")).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorText(error) {
  return preview(error?.message || String(error || "unknown error"), 160);
}

// --- requests ---------------------------------------------------------------

/** The server did not answer at all (refused, reset, closed): the run ends here. */
class QualifyTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "QualifyTransportError";
    this.code = "server_unreachable";
  }
}

class QualifyTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "QualifyTimeoutError";
    this.code = "request_timeout";
  }
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createClient({ fetchImpl, baseUrl, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
  async function send(method, path, body, requestTimeoutMs) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeoutMs || timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) throw new QualifyTimeoutError(`${method} ${path} timed out`);
      throw new QualifyTransportError(`${method} ${path} could not connect`);
    }
    return response;
  }

  async function request(method, path, body, requestTimeoutMs) {
    const response = await send(method, path, body, requestTimeoutMs);
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (isTimeoutError(error)) throw new QualifyTimeoutError(`${method} ${path} timed out`);
      throw new QualifyTransportError(`${method} ${path} was cut off`);
    }
    return { ok: response.ok, status: response.status, text, data: parseJson(text) };
  }

  // A streamed chat completion: the text, the reasoning and the time to the first token.
  async function stream(path, body, requestTimeoutMs) {
    const started = Date.now();
    const response = await send("POST", path, { ...body, stream: true, stream_options: { include_usage: true } }, requestTimeoutMs);
    if (!response.ok || !response.body?.getReader) {
      const text = await response.text().catch(() => "");
      return { ok: false, status: response.status, text, content: "", reasoning: "", ttftMs: null, usage: null };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage = null;
    let firstAt = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = done ? "" : lines.pop() || "";
        for (const line of lines) {
          const payload = line.trim().replace(/^data:\s*/, "");
          if (!payload || payload === "[DONE]") continue;
          const chunk = parseJson(payload);
          if (!chunk) continue;
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta || {};
          const piece = typeof delta.content === "string" ? delta.content : "";
          const thought = typeof delta.reasoning_content === "string" ? delta.reasoning_content : (typeof delta.reasoning === "string" ? delta.reasoning : "");
          if (!firstAt && (piece || thought)) firstAt = Date.now();
          content += piece;
          reasoning += thought;
        }
        if (done) break;
      }
    } catch (error) {
      if (isTimeoutError(error)) throw new QualifyTimeoutError(`POST ${path} timed out`);
      throw new QualifyTransportError(`POST ${path} was cut off`);
    }
    return { ok: true, status: response.status, text: "", content, reasoning, ttftMs: firstAt ? firstAt - started : null, usage };
  }

  return {
    get: (path, requestTimeoutMs) => request("GET", path, undefined, requestTimeoutMs),
    post: (path, body, requestTimeoutMs) => request("POST", path, body, requestTimeoutMs),
    stream,
  };
}

function messageOf(response) {
  const message = response?.data?.choices?.[0]?.message;
  return isPlainObject(message) ? message : {};
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : String(part?.text || ""))).join("");
  return "";
}

function reasoningOf(message) {
  const value = message.reasoning_content ?? message.reasoning;
  return typeof value === "string" ? value : "";
}

function httpFailure(response, what) {
  const reason = response.data?.error?.message || response.data?.message || response.text || "";
  return {
    status: "fail",
    detail: bilingual(`${what} 返回 HTTP ${response.status}：${preview(reason, 120)}`, `${what} answered HTTP ${response.status}: ${preview(reason, 120)}`),
    errorText: String(reason),
  };
}

// --- plan ---------------------------------------------------------------------

/** A launch value by catalog id; the launch store keeps either the plain value or {value, source}. */
function launchValue(launch, id) {
  const raw = launch?.values?.[id] ?? launch?.spec?.values?.[id];
  return isPlainObject(raw) && Object.hasOwn(raw, "value") ? raw.value : raw;
}

function enabledValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  return !OFF_VALUES.has(String(value).trim().toLowerCase());
}

/** The chat-template kwarg that switches thinking, when the card knows it. */
function thinkingKwarg(card) {
  const kwarg = card?.template?.thinking?.kwarg;
  return typeof kwarg === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(kwarg) ? kwarg : null;
}

function contextLengthOf(launch, instance) {
  const value = Number(launchValue(launch, "contextLength") ?? instance?.contextLength ?? instance?.maxModelLen);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function skipReason(id, { card, launch, instance }) {
  const engineId = instance?.engineId || launch?.spec?.engineId || null;
  if (id === "reasoning-split") {
    const format = card?.template?.reasoningFormat;
    if (!format || format === "none" || format === "unknown") {
      return bilingual("模型模板没有思考内容格式。", "The model's template has no reasoning format.");
    }
  }
  if (id === "tool-call") {
    const parser = launchValue(launch, "toolCallParser");
    const format = card?.template?.toolFormat;
    const parserSet = enabledValue(parser) || launchValue(launch, "autoToolChoice") === true;
    const llamaTemplate = engineId === "llamacpp" && typeof format === "string" && format !== "none" && format !== "unknown";
    if (!parserSet && !llamaTemplate) {
      return bilingual("没有设置工具调用解析器。", "No tool-call parser is set for this launch.");
    }
  }
  if (id === "vision") {
    const inputs = Array.isArray(card?.modalities?.input) ? card.modalities.input : [];
    if (!inputs.includes("image")) return bilingual("模型不接受图片输入。", "The model does not take image input.");
    if (launchValue(launch, "vllm.languageModelOnly") === true || launchValue(launch, "llamacpp.textOnly") === true) {
      return bilingual("本次启动只加载文本部分。", "This launch loads the text part only.");
    }
  }
  if (id === "speculative" && !enabledValue(launchValue(launch, "speculative.method"))) {
    return bilingual("没有开启推测解码。", "Speculative decoding is off.");
  }
  if (id === "needle" && !contextLengthOf(launch, instance)) {
    return bilingual("不知道本次启动的上下文长度。", "The launch's context length is unknown.");
  }
  return null;
}

/**
 * The checks of one run in execution order: [{id, skip}] where `skip` is a
 * bilingual reason when the check does not apply. `checks` limits the set
 * (default: every check but needle); needle:true adds the long-context check.
 */
function planChecks({ checks, needle, card, launch, instance } = {}) {
  const wanted = Array.isArray(checks) && checks.length
    ? new Set(checks.filter((id) => CHECK_IDS.includes(id)))
    : new Set(CHECK_IDS.filter((id) => id !== "needle"));
  if (needle === true) wanted.add("needle");
  else if (!Array.isArray(checks) || !checks.length) wanted.delete("needle");
  const context = { card, launch, instance };
  return CHECK_IDS.filter((id) => wanted.has(id)).map((id) => ({ id, skip: skipReason(id, context) }));
}

// --- the checks -----------------------------------------------------------------

function chatBody(run, extra = {}) {
  return { model: run.model, temperature: 0, stream: false, ...extra };
}

function withThinking(run, on, extra = {}) {
  const body = chatBody(run, extra);
  if (run.thinkingKwarg) body.chat_template_kwargs = { [run.thinkingKwarg]: on };
  return body;
}

async function checkModels(run) {
  const listed = await run.client.get("/v1/models");
  if (!listed.ok) return httpFailure(listed, "GET /v1/models");
  const entries = Array.isArray(listed.data?.data) ? listed.data.data : [];
  const entry = run.model ? entries.find((item) => item?.id === run.model) : entries[0];
  if (!entry) {
    const ids = entries.map((item) => String(item?.id || "")).filter(Boolean).slice(0, 5).join(", ");
    return {
      status: "fail",
      detail: bilingual(`服务没有列出模型 ${run.model || "(未知)"}；已列出：${preview(ids, 100) || "无"}`, `The server does not list model ${run.model || "(unknown)"}; it lists: ${preview(ids, 100) || "nothing"}`),
    };
  }
  let reported = Number(entry.max_model_len ?? entry.context_length);
  if (!Number.isFinite(reported) || reported <= 0) {
    reported = null;
    if (run.engineId === "llamacpp") {
      const props = await run.client.get("/props").catch(() => null);
      const nCtx = Number(props?.data?.default_generation_settings?.n_ctx ?? props?.data?.n_ctx);
      if (props?.ok && Number.isFinite(nCtx) && nCtx > 0) reported = nCtx;
    }
  }
  const expected = run.contextLength;
  const metrics = { servedModel: String(entry.id), ...(reported ? { reportedContext: reported } : {}), ...(expected ? { launchContext: expected } : {}) };
  run.engineFacts.reportedContext = reported;
  if (reported && expected && reported < expected) {
    return {
      status: "warn",
      detail: bilingual(`服务报告的上下文 ${reported} 低于启动值 ${expected}。`, `The server reports a context of ${reported}, below the launch value ${expected}.`),
      metrics,
    };
  }
  return {
    status: "pass",
    detail: bilingual(`服务已列出模型 ${entry.id}${reported ? `，上下文 ${reported}` : ""}。`, `The server lists model ${entry.id}${reported ? ` with a context of ${reported}` : ""}.`),
    metrics,
  };
}

async function checkChat(run) {
  const response = await run.client.post("/v1/chat/completions", withThinking(run, false, { messages: [{ role: "user", content: PONG_PROMPT }], max_tokens: 64 }));
  if (!response.ok) return httpFailure(response, "chat completion");
  const message = messageOf(response);
  const content = textOfContent(message.content).trim();
  if (/pong/i.test(content)) {
    return { status: "pass", detail: bilingual(`回答：${preview(content, 60)}`, `Answer: ${preview(content, 60)}`) };
  }
  if (!content) {
    const thoughtOnly = reasoningOf(message).trim() !== "";
    return {
      status: "fail",
      detail: thoughtOnly
        ? bilingual("回答为空：64 个 token 都用在了思考上。", "The answer is empty: the 64 tokens went into thinking.")
        : bilingual("回答为空。", "The answer is empty."),
    };
  }
  return { status: "fail", detail: bilingual(`回答里没有 pong：${preview(content, 100)}`, `The answer does not contain pong: ${preview(content, 100)}`) };
}

async function checkReasoningSplit(run) {
  const on = await run.client.post("/v1/chat/completions", withThinking(run, true, { messages: [{ role: "user", content: REASONING_PROMPT }], max_tokens: 768 }));
  if (!on.ok) return httpFailure(on, "reasoning request");
  const onMessage = messageOf(on);
  const onContent = textOfContent(onMessage.content);
  if (REASONING_TAG_LEAK.test(onContent)) {
    return { status: "fail", detail: bilingual(`思考标签泄漏进了回答：${preview(onContent, 100)}`, `Reasoning tags leaked into the answer: ${preview(onContent, 100)}`) };
  }
  if (!reasoningOf(onMessage).trim()) {
    return { status: "fail", detail: bilingual("开启思考后，思考内容字段为空。", "With thinking on, the reasoning field is empty.") };
  }
  const metrics = { reasoningChars: reasoningOf(onMessage).length };
  if (!run.thinkingKwarg) {
    return { status: "pass", detail: bilingual("思考内容已与回答分开（模板没有可关闭思考的开关）。", "Reasoning is kept out of the answer (the template has no switch to turn thinking off)."), metrics };
  }
  const off = await run.client.post("/v1/chat/completions", withThinking(run, false, { messages: [{ role: "user", content: REASONING_PROMPT }], max_tokens: 256 }));
  if (!off.ok) return httpFailure(off, "reasoning-off request");
  const offMessage = messageOf(off);
  if (REASONING_TAG_LEAK.test(textOfContent(offMessage.content))) {
    return { status: "fail", detail: bilingual("关闭思考后，思考标签仍出现在回答里。", "With thinking off, reasoning tags still appear in the answer."), metrics };
  }
  if (reasoningOf(offMessage).trim()) {
    return { status: "fail", detail: bilingual("关闭思考后，思考内容字段仍不为空。", "With thinking off, the reasoning field is still not empty."), metrics };
  }
  return { status: "pass", detail: bilingual("思考内容与回答分开，关闭思考后字段为空。", "Reasoning is kept out of the answer and is empty with thinking off."), metrics };
}

async function checkToolCall(run) {
  const messages = [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }];
  const first = await run.client.post("/v1/chat/completions", withThinking(run, false, { messages, tools: [WEATHER_TOOL], tool_choice: "auto", max_tokens: 512 }));
  if (!first.ok) return httpFailure(first, "tool request");
  const choice = first.data?.choices?.[0] || {};
  const message = messageOf(first);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = calls.find((item) => item?.function?.name === "get_weather");
  if (choice.finish_reason !== "tool_calls" || !call) {
    return {
      status: "fail",
      detail: bilingual(
        `没有得到 get_weather 工具调用（finish_reason=${choice.finish_reason ?? "无"}）：${preview(textOfContent(message.content), 100)}`,
        `No get_weather tool call came back (finish_reason=${choice.finish_reason ?? "none"}): ${preview(textOfContent(message.content), 100)}`,
      ),
    };
  }
  const rawArguments = call.function.arguments;
  let args = rawArguments;
  if (typeof rawArguments === "string") {
    args = parseJson(rawArguments);
    if (args === null) {
      return { status: "fail", detail: bilingual(`工具参数不是合法 JSON：${preview(rawArguments, 100)}`, `The tool arguments are not valid JSON: ${preview(rawArguments, 100)}`) };
    }
  }
  if (!isPlainObject(args) || typeof args.city !== "string" || !args.city.trim()) {
    return { status: "fail", detail: bilingual("工具参数里没有 city。", "The tool arguments carry no city.") };
  }
  const followUp = [
    ...messages,
    { role: "assistant", content: message.content ?? null, tool_calls: calls },
    { role: "tool", tool_call_id: call.id ?? "call_0", content: WEATHER_RESULT },
  ];
  const second = await run.client.post("/v1/chat/completions", withThinking(run, false, { messages: followUp, tools: [WEATHER_TOOL], tool_choice: "none", max_tokens: 256 }));
  if (!second.ok) return httpFailure(second, "tool follow-up request");
  const answer = textOfContent(messageOf(second).content).trim();
  if (!answer) {
    return { status: "fail", detail: bilingual("收到工具结果后，模型没有给出文字回答。", "After the tool result, the model returned no text.") };
  }
  return {
    status: "pass",
    detail: bilingual(`工具调用往返成功：get_weather(${preview(args.city, 40)})。`, `Tool round trip works: get_weather(${preview(args.city, 40)}).`),
    metrics: { toolCalls: calls.length },
  };
}

async function checkJsonOutput(run) {
  const response = await run.client.post("/v1/chat/completions", withThinking(run, false, {
    messages: [{ role: "user", content: 'Return a JSON object with the keys "name" (a string) and "ok" (a boolean).' }],
    response_format: { type: "json_object" },
    max_tokens: 256,
  }));
  if (!response.ok) return httpFailure(response, "json request");
  const content = textOfContent(messageOf(response).content).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || !isPlainObject(parsed)) {
    return { status: "fail", detail: bilingual(`回答不是 JSON 对象：${preview(content, 100)}`, `The answer is not a JSON object: ${preview(content, 100)}`) };
  }
  return { status: "pass", detail: bilingual("回答是合法的 JSON 对象。", "The answer is a valid JSON object.") };
}

async function checkVision(run) {
  const response = await run.client.post("/v1/chat/completions", withThinking(run, false, {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is the dominant colour of this image? Answer with one word." },
        { type: "image_url", image_url: { url: RED_PNG_DATA_URL } },
      ],
    }],
    max_tokens: 32,
  }));
  if (!response.ok) return httpFailure(response, "vision request");
  const content = textOfContent(messageOf(response).content).trim();
  if (/\bred\b/i.test(content)) {
    return { status: "pass", detail: bilingual(`图片理解正确：${preview(content, 40)}`, `The image was read correctly: ${preview(content, 40)}`) };
  }
  return { status: "fail", detail: bilingual(`没有认出红色图片：${preview(content, 100) || "回答为空"}`, `The red image was not recognised: ${preview(content, 100) || "empty answer"}`) };
}

const FILLER = "The grass is green. The sky is blue. The sun is yellow. Here we go again. ";

function needleHaystack(contextLength, depth, passkey) {
  // About 3 characters per token is a safe over-estimate of the prompt size, so the prompt stays inside the context.
  const target = Math.max(256, Math.floor(contextLength * 0.85) - 256) * 3;
  const repeat = Math.max(1, Math.floor(target / FILLER.length));
  const cut = Math.floor(repeat * depth);
  return `${FILLER.repeat(cut)}The passkey is ${passkey}. Remember it. ${FILLER.repeat(repeat - cut)}What is the passkey? Reply with the number only.`;
}

async function checkNeedle(run) {
  const keys = ["48213", "90547"];
  const ttft = {};
  const misses = [];
  for (const [index, depth] of NEEDLE_DEPTHS.entries()) {
    const prompt = needleHaystack(run.contextLength, depth, keys[index]);
    const answer = await run.client.stream("/v1/chat/completions", withThinking(run, false, { messages: [{ role: "user", content: prompt }], max_tokens: 32 }), NEEDLE_TIMEOUT_MS);
    if (!answer.ok) return httpFailure(answer, `needle request at ${Math.round(depth * 100)}%`);
    ttft[String(Math.round(depth * 100))] = answer.ttftMs;
    if (!answer.content.includes(keys[index])) misses.push(Math.round(depth * 100));
  }
  const metrics = { ttftMs: ttft };
  if (misses.length) {
    return {
      status: "fail",
      detail: bilingual(`在上下文 ${misses.join("%、")}% 处的密钥没有被找回。`, `The passkey at ${misses.join("%, ")}% of the context was not recalled.`),
      metrics,
    };
  }
  return { status: "pass", detail: bilingual("上下文 50% 和 90% 处的密钥都被准确找回。", "The passkeys at 50% and 90% of the context were recalled exactly."), metrics };
}

async function runWorkload(run) {
  if (typeof run.benchmark !== "function") return { skipped: bilingual("没有可用的压测执行器。", "No benchmark runner is available.") };
  const before = typeof run.metrics === "function" ? await Promise.resolve(run.metrics()).catch(() => null) : null;
  let benchmark;
  try {
    benchmark = await run.benchmark({
      requests: run.light ? 1 : 3,
      concurrency: 1,
      maxTokens: 256,
      stream: true,
      prompt: THROUGHPUT_PROMPT,
      model: run.model,
      port: run.port,
    });
  } catch (error) {
    return { error };
  }
  const after = typeof run.metrics === "function" ? await Promise.resolve(run.metrics()).catch(() => null) : null;
  return { benchmark, before, after };
}

function throughputResult(workload) {
  if (workload.skipped) return { status: "skip", detail: workload.skipped };
  if (workload.error) {
    return {
      status: "fail",
      detail: bilingual(`速度测试失败：${errorText(workload.error)}`, `The speed test failed: ${errorText(workload.error)}`),
      errorText: String(workload.error?.message || ""),
    };
  }
  const benchmark = workload.benchmark || {};
  const successful = Number(benchmark.successfulRequests) || 0;
  const metrics = {
    requests: Number(benchmark.requests) || 0,
    successfulRequests: successful,
    tokensPerSecond: Math.round((Number(benchmark.avgTokensPerSecond) || 0) * 100) / 100,
    wallTokensPerSecond: Math.round((Number(benchmark.wallTokensPerSecond) || 0) * 100) / 100,
    ttftMs: Math.round(Number(benchmark.avgTtftMs) || 0),
  };
  if (successful < 1) return { status: "fail", detail: bilingual("没有成功的测速请求。", "No speed-test request succeeded."), metrics };
  const text = `${metrics.tokensPerSecond} tok/s，首字 ${metrics.ttftMs} ms`;
  const textEn = `${metrics.tokensPerSecond} tok/s, first token ${metrics.ttftMs} ms`;
  const failed = Number(benchmark.failedRequests) || 0;
  return failed
    ? { status: "warn", detail: bilingual(`${text}；${failed} 个请求失败。`, `${textEn}; ${failed} request(s) failed.`), metrics }
    : { status: "pass", detail: bilingual(`${text}。`, `${textEn}.`), metrics };
}

function speculativeResult(workload) {
  if (workload.skipped) return { status: "skip", detail: workload.skipped };
  if (workload.error) return { status: "skip", detail: bilingual("速度测试失败，无法计算接受率。", "The speed test failed, so no acceptance rate was measured.") };
  const { before, after } = workload;
  if (!before || !after) return { status: "skip", detail: bilingual("读不到推测解码指标。", "The speculative-decoding counters could not be read.") };
  const drafted = Number(after.specDraftTokensTotal) - Number(before.specDraftTokensTotal);
  const accepted = Number(after.specAcceptedTokensTotal) - Number(before.specAcceptedTokensTotal);
  if (!Number.isFinite(drafted) || !Number.isFinite(accepted) || drafted < 0 || accepted < 0) {
    return { status: "skip", detail: bilingual("指标计数器不可用或已重置。", "The counters are missing or were reset.") };
  }
  if (drafted === 0) {
    return { status: "warn", detail: bilingual("测速期间没有产生草稿 token。", "No draft tokens were produced during the speed test."), metrics: { draftTokens: 0, acceptedTokens: accepted } };
  }
  const acceptance = Math.round((accepted / drafted) * 1000) / 1000;
  const metrics = { acceptance, draftTokens: drafted, acceptedTokens: accepted };
  const percent = (acceptance * 100).toFixed(1);
  return acceptance < SPECULATIVE_WARN_BELOW
    ? { status: "warn", detail: bilingual(`草稿接受率 ${percent}%，偏低。`, `Draft acceptance is ${percent}%, which is low.`), metrics }
    : { status: "pass", detail: bilingual(`草稿接受率 ${percent}%。`, `Draft acceptance is ${percent}%.`), metrics };
}

const CHECKS = Object.freeze({
  models: checkModels,
  chat: checkChat,
  "reasoning-split": checkReasoningSplit,
  "tool-call": checkToolCall,
  "json-output": checkJsonOutput,
  vision: checkVision,
  needle: checkNeedle,
});

// --- the run ---------------------------------------------------------------------

function rootCauseOf(text, engineId) {
  if (!text) return null;
  try {
    const { classifyFailure } = require("./root-cause");
    const found = classifyFailure(String(text), { engineId, phase: "api" });
    if (!found || !found.signatureId) return null;
    return { code: found.code, signatureId: found.signatureId, hint: found.hint, title: found.title };
  } catch {
    return null;
  }
}

function summarizeResults(results) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) summary[result.status] += 1;
  return summary;
}

/**
 * runQualification({instance, card, launch, fetchImpl, metrics, benchmark,
 *   onProgress, checks, needle, light, budgetMs, now, timeoutMs}) -> QualificationResult
 *
 * instance: {port, apiKey, servedModel, engineId, contextLength?}. card: the
 * ModelCard. launch: the launch record or its values ({values|spec.values}).
 * metrics(): -> {specDraftTokensTotal, specAcceptedTokensTotal} | null.
 * benchmark(input): -> the benchmark result of createBenchmarkRunner().runBenchmarkJob.
 *
 * QualificationResult: {ok (no failed check), partial, startedAt, finishedAt,
 *   durationMs, results: [{check, status, detail:{zh,en}, metrics, rootCause?}],
 *   summary: {pass, warn, fail, skip}, observed: {engineFacts}}.
 */
async function runQualification(options = {}) {
  const instance = isPlainObject(options.instance) ? options.instance : {};
  const card = isPlainObject(options.card) ? options.card : {};
  const launch = isPlainObject(options.launch) ? options.launch : {};
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("runQualification needs fetch.");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : DEFAULT_BUDGET_MS;
  const port = Number(instance.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new TypeError("runQualification needs the instance port.");
  const engineId = String(instance.engineId || launch?.spec?.engineId || "") || null;
  const apiKey = typeof instance.apiKey === "string" ? instance.apiKey : "";
  const baseUrl = `http://127.0.0.1:${port}`;
  const run = {
    client: createClient({
      fetchImpl,
      baseUrl,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS,
    }),
    port,
    engineId,
    model: String(instance.servedModel || launch?.spec?.model?.servedName || ""),
    contextLength: contextLengthOf(launch, instance),
    thinkingKwarg: thinkingKwarg(card),
    light: options.light === true,
    metrics: options.metrics,
    benchmark: options.benchmark,
    engineFacts: {},
  };
  const plan = planChecks({ checks: options.checks, needle: options.needle, card, launch, instance });
  const startedAtMs = now();
  const deadline = startedAtMs + budgetMs;
  const results = new Map();
  let stopped = null;
  let done = 0;
  const total = plan.length;

  function progress(check, status) {
    if (typeof options.onProgress !== "function") return;
    try {
      options.onProgress({ check, status, index: done, total, percent: Math.round((done / Math.max(1, total)) * 100) });
    } catch {
      // A progress listener never breaks the run.
    }
  }

  function record(id, result) {
    const entry = { check: id, status: result.status, detail: result.detail, metrics: result.metrics || {} };
    if (result.status === "fail") {
      const cause = rootCauseOf(result.errorText, engineId);
      if (cause) entry.rootCause = cause;
    }
    results.set(id, entry);
    done += 1;
    progress(id, entry.status);
  }

  const stoppedResult = () => ({ status: "skip", detail: bilingual("服务停止应答，检查已中止。", "The server stopped answering, so the check was not run.") });
  const budgetResult = () => ({ status: "skip", detail: bilingual("120 秒时间预算已用完。", "The 120 s time budget is used up.") });

  function failedResult(error) {
    if (error instanceof QualifyTransportError) {
      stopped = error;
      return { status: "fail", detail: bilingual("服务停止应答（连接被拒绝或中断）。", "The server stopped answering (connection refused or dropped)."), errorText: error.message };
    }
    if (error instanceof QualifyTimeoutError) {
      return { status: "fail", detail: bilingual("请求超时。", "The request timed out."), errorText: error.message };
    }
    return { status: "fail", detail: bilingual(`检查出错：${errorText(error)}`, `The check errored: ${errorText(error)}`), errorText: String(error?.message || "") };
  }

  async function runOne(id, execute, { budgeted = true } = {}) {
    progress(id, "running");
    if (stopped) return record(id, stoppedResult());
    if (budgeted && now() >= deadline) return record(id, budgetResult());
    let result;
    try {
      result = await execute();
    } catch (error) {
      result = failedResult(error);
    }
    return record(id, result);
  }

  const planned = new Map(plan.map((item) => [item.id, item]));
  for (const item of plan) {
    if (item.skip) record(item.id, { status: "skip", detail: item.skip });
  }
  const active = (id) => planned.has(id) && !planned.get(id).skip;

  for (const id of ["models", "chat", "reasoning-split", "tool-call", "json-output", "vision"]) {
    if (active(id)) await runOne(id, () => CHECKS[id](run));
  }

  // Speculative acceptance is measured around the same workload as throughput.
  if (active("throughput") || active("speculative")) {
    const throughputId = "throughput";
    let workload = null;
    progress(throughputId, "running");
    if (stopped) workload = { skipped: bilingual("服务停止应答，检查已中止。", "The server stopped answering, so the check was not run.") };
    else if (now() >= deadline) workload = { skipped: bilingual("120 秒时间预算已用完。", "The 120 s time budget is used up.") };
    else workload = await runWorkload(run);
    if (workload.error) {
      // A dead server and a failing request look the same to the runner; ask once.
      const alive = await run.client.get("/v1/models", 3000).then(() => true, (error) => !(error instanceof QualifyTransportError));
      if (!alive) stopped = workload.error;
    }
    if (active("throughput")) record("throughput", throughputResult(workload));
    if (active("speculative")) record("speculative", speculativeResult(workload));
  }

  if (active("needle")) await runOne("needle", () => CHECKS.needle(run), { budgeted: false });

  const ordered = CHECK_IDS.filter((id) => results.has(id)).map((id) => results.get(id));
  const finishedAtMs = now();
  const summary = summarizeResults(ordered);
  return {
    ok: summary.fail === 0 && !stopped,
    partial: Boolean(stopped),
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    budgetMs,
    results: ordered,
    summary,
    observed: { engineFacts: { ...run.engineFacts, ...(run.model ? { servedModel: run.model } : {}) } },
  };
}

// --- speculative counters through engines/metrics.js -----------------------------

/**
 * A reader for the speculative-decoding counters of one instance: scrapes the
 * engine descriptor's metrics endpoint with the instance's key and maps it
 * through engines/metrics.js (the canonical specDraftTokensTotal /
 * specAcceptedTokensTotal of 01 section 16.1). Returns null when the engine
 * has no Prometheus endpoint or the scrape fails.
 */
function createMetricsReader({ fetchImpl, port, apiKey = "", engineId, registry, timeoutMs = 3000 } = {}) {
  const fetchFn = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  return async function readSpeculativeCounters() {
    try {
      const metrics = require("../engines/metrics");
      const source = registry || require("../engines/registry").getEngineRegistry();
      const descriptor = source.require(engineId);
      const map = descriptor?.metricsMap;
      if (!map?.path || map.format === "json") return null;
      const response = await fetchFn(`http://127.0.0.1:${port}${map.path}`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const summary = metrics.summarize(metrics.mapPrometheus(engineId, metrics.parsePrometheus(await response.text()), { descriptor }));
      return {
        specDraftTokensTotal: typeof summary.specDraftTokensTotal === "number" ? summary.specDraftTokensTotal : null,
        specAcceptedTokensTotal: typeof summary.specAcceptedTokensTotal === "number" ? summary.specAcceptedTokensTotal : null,
      };
    } catch {
      return null;
    }
  };
}

// --- host record ----------------------------------------------------------------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function newRecordId(random = crypto.randomBytes) {
  const bytes = random(15);
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 20) {
      bits -= 5;
      output += BASE32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return `qr_${output}`;
}

/**
 * The HostRecord of 02 section 13 for one finished run. `host` is
 * {gpu, computeCap, driver} (null when unknown); `peakMb` maps GPU id to the
 * memory in use when the run ended.
 */
function buildHostRecord({ result, card, instance, launch, fleetId, host, peakMb, id } = {}) {
  const spec = isPlainObject(launch?.spec) ? launch.spec : {};
  return {
    id: id || newRecordId(),
    contentDigest: card?.contentDigest || null,
    cardId: card?.cardId || null,
    engineId: instance?.engineId || spec.engineId || null,
    runtimeId: instance?.runtimeId || spec.runtimeId || null,
    recipeId: instance?.recipeId || spec.recipeId || null,
    paramsKey: launch?.resolved?.paramsKey || launch?.paramsKey || null,
    launchId: launch?.launchId || instance?.launchId || null,
    fleetId: fleetId || null,
    host: {
      gpu: host?.gpu ?? null,
      computeCap: host?.computeCap ?? null,
      driver: host?.driver ?? null,
    },
    at: result.finishedAt,
    durationMs: result.durationMs,
    results: result.results.map((item) => ({
      check: item.check,
      status: item.status,
      detail: item.detail,
      metrics: item.metrics || {},
      ...(item.rootCause ? { rootCause: item.rootCause } : {}),
    })),
    observed: {
      peakMb: isPlainObject(peakMb) ? peakMb : {},
      engineFacts: isPlainObject(result.observed?.engineFacts) ? result.observed.engineFacts : {},
    },
  };
}

// --- the manager job -----------------------------------------------------------------

class QualifyError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "QualifyError";
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const CARD_ID_RE = /^mc_[a-z2-7]{20}$/;

function requestFields(body) {
  const input = isPlainObject(body) ? body : {};
  const errors = [];
  const field = (name, code, message) => errors.push({ field: name, code, message });
  const instanceId = typeof input.instanceId === "string" ? input.instanceId.trim() : "";
  if (!instanceId || instanceId.length > 256) field("instanceId", "required", "instanceId is required.");
  const cardId = typeof input.cardId === "string" ? input.cardId.trim() : "";
  if (!CARD_ID_RE.test(cardId)) field("cardId", "invalid", "cardId must be a model card id (mc_…).");
  let checks;
  if (input.checks !== undefined && input.checks !== null) {
    if (!Array.isArray(input.checks) || input.checks.length > CHECK_IDS.length || input.checks.some((id) => !CHECK_IDS.includes(id))) {
      field("checks", "invalid", `checks must be a list of: ${CHECK_IDS.join(", ")}.`);
    } else {
      checks = [...new Set(input.checks)];
    }
  }
  if (input.needle !== undefined && typeof input.needle !== "boolean") field("needle", "invalid", "needle must be true or false.");
  if (input.light !== undefined && typeof input.light !== "boolean") field("light", "invalid", "light must be true or false.");
  return { errors, instanceId, cardId, checks, needle: input.needle === true, light: input.light === true };
}

function activeJob(job) {
  return job && (job.status === "running" || job.status === "queued");
}

function busyJob(listJobs, instance) {
  let jobs = [];
  try {
    jobs = typeof listJobs === "function" ? Array.from(listJobs() || []) : [];
  } catch {
    jobs = [];
  }
  const port = Number(instance.port);
  return jobs.find((job) => {
    if (!activeJob(job)) return false;
    const meta = isPlainObject(job.meta) ? job.meta : {};
    if (job.type === QUALIFY_JOB_TYPE) return meta.instanceId === instance.id;
    if (job.type === "benchmark") return meta.instanceId === instance.id || (Number.isFinite(port) && Number(meta.port) === port);
    return false;
  }) || null;
}

/** The running model-qualify job on this port (or instance id), for a benchmark route to refuse. */
function runningQualification(listJobs, { port, instanceId } = {}) {
  let jobs = [];
  try {
    jobs = typeof listJobs === "function" ? Array.from(listJobs() || []) : [];
  } catch {
    jobs = [];
  }
  return jobs.find((job) => activeJob(job) && job.type === QUALIFY_JOB_TYPE
    && ((instanceId && job.meta?.instanceId === instanceId) || (Number.isFinite(Number(port)) && Number(job.meta?.port) === Number(port)))) || null;
}

function peakFrom(gpuStatus, gpuIds) {
  const gpus = Array.isArray(gpuStatus?.gpus) ? gpuStatus.gpus : [];
  const wanted = new Set((Array.isArray(gpuIds) ? gpuIds : []).map(String));
  const peak = {};
  for (const gpu of gpus) {
    const id = String(gpu.id ?? gpu.index ?? "");
    if (!id || (wanted.size && !wanted.has(id))) continue;
    const used = Number(gpu.usedMb);
    if (Number.isFinite(used)) peak[id] = Math.round(used);
  }
  return peak;
}

function hostOf(gpuStatus, gpuIds) {
  const gpus = Array.isArray(gpuStatus?.gpus) ? gpuStatus.gpus : [];
  const wanted = new Set((Array.isArray(gpuIds) ? gpuIds : []).map(String));
  const gpu = gpus.find((item) => !wanted.size || wanted.has(String(item.id ?? item.index ?? ""))) || gpus[0];
  if (!gpu) return { gpu: null, computeCap: null, driver: null };
  return {
    gpu: gpu.name ? String(gpu.name) : null,
    computeCap: gpu.computeCap ? String(gpu.computeCap) : null,
    driver: gpu.driverVersion ? String(gpu.driverVersion) : null,
  };
}

/**
 * Validates a qualification request, creates the `model-qualify` job and
 * starts the run. Throws QualifyError (400 invalid_request, 404
 * instance_not_found / card_not_found, 409 instance_not_running /
 * instance_busy / card_mismatch, 503 qualify_unavailable /
 * runtime_key_unavailable) before any job exists. Returns {job, done}: done
 * resolves to the QualificationResult once the job is finished and never
 * rejects.
 *
 * context: {managerId, jobs:{createJob, appendLog, finishJob, failJob,
 * setJobProgress}, listJobs, findInstance(id) -> {instance, container, state},
 * apiKeyFor(found), launchOf(found), getCard(cardId), createBenchmark(target)
 * -> async (input) => benchmark, getGpuStatus, internalClient, pushHostRecord,
 * onHostRecord({record, card, launch, instance}) (publishes the capabilities),
 * fetchImpl, registry, inFlight (Map), now, sleep, retryDelaysMs}.
 */
async function startQualifyJob(body, context = {}) {
  const fields = requestFields(body);
  if (fields.errors.length) throw new QualifyError(400, "invalid_request", "The qualification request is not valid.", { errors: fields.errors });
  const { jobs } = context;
  if (!jobs || ["createJob", "appendLog", "finishJob", "failJob"].some((name) => typeof jobs[name] !== "function") || typeof context.findInstance !== "function") {
    throw new QualifyError(503, "qualify_unavailable", "Qualification is not available on this manager.");
  }
  const found = await context.findInstance(fields.instanceId);
  if (!found?.instance) throw new QualifyError(404, "instance_not_found", "This manager has no such instance.");
  const instance = found.instance;
  if (instance.running === false || ["stopped", "crashed", "sleeping"].includes(String(instance.lifecycle?.state || ""))) {
    throw new QualifyError(409, "instance_not_running", "The instance is not running.", { hint: "Start the model, then qualify it." });
  }
  const getCard = typeof context.getCard === "function" ? context.getCard : () => null;
  const card = getCard(fields.cardId);
  if (!card || !card.cardId) throw new QualifyError(404, "card_not_found", "No model card is known under this id.", { hint: "Inspect the model first." });
  let launch = null;
  try {
    launch = typeof context.launchOf === "function" ? await context.launchOf(found) : null;
  } catch {
    launch = null;
  }
  const launchDigest = launch?.spec?.model?.contentDigest;
  if (launchDigest && card.contentDigest && launchDigest !== card.contentDigest) {
    throw new QualifyError(409, "card_mismatch", "The card describes a different model than the one this instance runs.");
  }
  let apiKey = "";
  try {
    apiKey = typeof context.apiKeyFor === "function" ? String(await context.apiKeyFor(found) || "") : "";
  } catch {
    throw new QualifyError(503, "runtime_key_unavailable", "The instance's API key cannot be read.");
  }

  // From here to inFlight.set() nothing awaits, so two requests cannot both pass the check.
  const inFlight = context.inFlight instanceof Map ? context.inFlight : new Map();
  const busy = busyJob(context.listJobs, instance);
  if (inFlight.has(instance.id) || busy) {
    throw new QualifyError(409, "instance_busy", "Another qualification or benchmark is running on this instance.", { jobId: inFlight.get(instance.id) || busy?.id || null, hint: "Wait for it to finish." });
  }

  const managerId = context.managerId;
  const fleetId = `${managerId}:${instance.id}`;
  const spec = isPlainObject(launch?.spec) ? launch.spec : {};
  const target = {
    port: Number(instance.port || spec.instance?.port),
    apiKey,
    servedModel: String(instance.models?.[0]?.id || spec.model?.servedName || ""),
    engineId: instance.engineId || spec.engineId || null,
    runtimeId: instance.runtime?.id || spec.runtimeId || null,
    recipeId: instance.recipeId || spec.recipeId || null,
    launchId: instance.launchId || launch?.launchId || null,
    contextLength: Number(instance.models?.[0]?.maxModelLen) || null,
  };
  const plan = planChecks({ checks: fields.checks, needle: fields.needle, card, launch, instance: target });
  const job = jobs.createJob(QUALIFY_JOB_TYPE, `验证部署 / Qualify ${fleetId}`, {
    instanceId: instance.id,
    fleetId,
    managerId,
    cardId: card.cardId,
    contentDigest: card.contentDigest || null,
    engineId: target.engineId,
    runtimeId: target.runtimeId,
    recipeId: target.recipeId,
    launchId: target.launchId,
    paramsKey: launch?.resolved?.paramsKey || null,
    port: target.port,
    checks: plan.map((item) => item.id),
    needle: fields.needle,
    light: fields.light,
  });
  inFlight.set(instance.id, job.id);
  const done = executeQualifyJob({ job, found, target, card, launch, fleetId, plan, fields }, context).finally(() => {
    if (inFlight.get(instance.id) === job.id) inFlight.delete(instance.id);
  });
  return { job, done };
}

async function executeQualifyJob({ job, found, target, card, launch, fleetId, plan, fields }, context) {
  const { jobs } = context;
  const log = (line) => {
    try {
      jobs.appendLog(job, `${line}\n`);
    } catch {
      // The ledger is best effort.
    }
  };
  const progress = (value) => {
    try {
      jobs.setJobProgress?.(job, value);
    } catch {
      // Same.
    }
  };
  try {
    log(`Qualifying ${fleetId} (${plan.map((item) => item.id).join(", ")}).`);
    const fetchImpl = context.fetchImpl;
    const benchmark = typeof context.createBenchmark === "function" ? context.createBenchmark({ ...target, job }) : null;
    const metrics = createMetricsReader({ fetchImpl, port: target.port, apiKey: target.apiKey, engineId: target.engineId, registry: context.registry });
    const result = await runQualification({
      instance: target,
      card,
      launch,
      fetchImpl,
      metrics,
      benchmark,
      checks: fields.checks,
      needle: fields.needle,
      light: fields.light,
      now: context.now,
      budgetMs: context.budgetMs,
      timeoutMs: context.requestTimeoutMs,
      onProgress: ({ check, status, percent }) => {
        progress({ percent, stage: `验证 / Qualify: ${check}`, detail: status, state: "running" });
        if (status !== "running") log(`${check}: ${status}`);
      },
    });
    let gpuStatus = null;
    try {
      gpuStatus = typeof context.getGpuStatus === "function" ? await context.getGpuStatus() : null;
    } catch {
      gpuStatus = null;
    }
    const gpuIds = found.instance.gpuIds;
    const record = buildHostRecord({
      result,
      card,
      instance: target,
      launch,
      fleetId,
      host: hostOf(gpuStatus, gpuIds),
      peakMb: peakFrom(gpuStatus, gpuIds),
    });
    // The record stays on the job until the entry has stored it (section 13).
    job.result = { hostRecord: record, summary: result.summary, partial: result.partial, pushed: false };
    // 02 section 16: the record's failed checks unpublish capabilities on the running instance's launch.
    if (typeof context.onHostRecord === "function") {
      try {
        await context.onHostRecord({ record, card, launch, instance: target });
      } catch (error) {
        log(`Published capabilities not updated: ${error?.message || error}`);
      }
    }
    let pushed = null;
    const push = typeof context.pushHostRecord === "function" ? context.pushHostRecord : null;
    if (push) {
      progress({ percent: 99, stage: "报告结果 / Reporting the result", detail: "", state: "running" });
      pushed = await push({ record, jobId: job.id, log });
      if (pushed?.ok) job.result.pushed = true;
      log(pushed?.ok ? `Host record ${record.id} stored by the entry.` : `Host record ${record.id} kept on the job (${pushed?.code || "not delivered"}); import it from the entry.`);
    }
    log(`Done: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail, ${result.summary.skip} skip, ${result.durationMs} ms.`);
    const summary = { ...result.summary, partial: result.partial, durationMs: result.durationMs, hostRecordId: record.id, pushed: Boolean(pushed?.ok) };
    if (result.partial) {
      job.failure = {
        code: "qualify_server_stopped",
        signatureId: null,
        phase: "api",
        hint: bilingual("引擎在验证过程中停止应答，请查看实例日志。", "The engine stopped answering during qualification; check the instance logs."),
        logExcerpt: "",
      };
      job.meta = { ...(job.meta || {}), ...summary };
      jobs.failJob(job, new Error("The engine stopped answering during qualification."));
    } else {
      jobs.finishJob(job, summary);
      progress({ percent: 100, stage: "验证完成 / Qualification complete", detail: "", state: result.summary.fail ? "warn" : "ok" });
    }
    return result;
  } catch (error) {
    try {
      jobs.failJob(job, error);
    } catch {
      // Already finished.
    }
    return null;
  }
}

module.exports = {
  CHECK_IDS,
  DEFAULT_BUDGET_MS,
  LIGHT_CHECKS,
  QUALIFY_JOB_TYPE,
  QualifyError,
  RED_PNG_BASE64,
  STATUSES,
  buildHostRecord,
  createMetricsReader,
  newRecordId,
  planChecks,
  preview,
  requestFields,
  runQualification,
  runningQualification,
  startQualifyJob,
  summarizeResults,
};
