// The playground's pure parts (05 §12.6): the model list of a key, the one
// request object that is both sent and copied, the copy-as snippets, the
// streaming run with its TTFT / tok/s measurements, and the cost. Nothing here
// touches the DOM; `fetch` and the clock are arguments so tests can replace them.

import { ApiError, errorFromResponse } from "./api.js";
import { readSseStream } from "./sse.js";
import { readPricing } from "./format.js";

export { formatCredits } from "./format.js";

export const CHAT_PATH = "/chat/completions";
export const LOCAL_CHAT_URL = "/v1/chat/completions";
export const KEY_ENV = "API_KEY";
export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_SYSTEM_CHARS = 8000;
export const MAX_MESSAGE_CHARS = 32000;
// What a key may look like before it is written into text the reader copies.
const INSERTABLE_KEY_RE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * The chat models of the enriched /v1/models answer (05 §8.3): entries that
 * can chat, with the output cap, the price and the reasoning patch (only when
 * `controls.reasoning_toggle` exists).
 */
export function readPlaygroundModels(doc) {
  const list = Array.isArray(doc?.data) ? doc.data : [];
  const models = [];
  for (const entry of list) {
    if (!entry || typeof entry.id !== "string" || !entry.id) continue;
    const capabilities = plainObject(entry.capabilities) || {};
    if (capabilities.chat === false || (capabilities.audio_speech === true && capabilities.chat !== true) || (capabilities.embeddings === true && capabilities.chat !== true)) continue;
    const toggle = plainObject(plainObject(entry.controls)?.reasoning_toggle);
    const on = plainObject(toggle?.on);
    const off = plainObject(toggle?.off);
    models.push({
      id: entry.id,
      name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : entry.id,
      aliases: (Array.isArray(entry.aliases) ? entry.aliases : []).filter((alias) => typeof alias === "string"),
      state: typeof entry.state === "string" ? entry.state : "unknown",
      maxOutput: positive(entry.max_output_tokens) ?? positive(entry.limits?.max_output_tokens),
      context: positive(entry.context_length),
      pricing: readPricing(entry.pricing),
      reasoningToggle: on || off ? { on: on || {}, off: off || {} } : null,
      vision: capabilities.vision === true,
    });
  }
  return models;
}

/** The model whose id or alias is `wanted`, else the first one, else null. */
export function pickModel(models, wanted) {
  const needle = String(wanted || "").toLowerCase();
  if (needle) {
    const found = models.find((model) => model.id.toLowerCase() === needle) || models.find((model) => model.aliases.some((alias) => alias.toLowerCase() === needle));
    if (found) return found;
  }
  return models[0] || null;
}

/** The largest max_tokens the form may send for a model (the key's cap is already in max_output_tokens). */
export function maxTokensCap(model) {
  return model?.maxOutput || 8192;
}

/** The value of a number field clamped into [min, max]; `fallback` for text that is not a number. */
export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function mergePatch(target, patch) {
  for (const [name, value] of Object.entries(patch || {})) {
    if (plainObject(value) && plainObject(target[name])) target[name] = mergePatch({ ...target[name] }, value);
    else target[name] = value;
  }
  return target;
}

/**
 * The one request the playground sends and copies:
 *   { method, path, headers (no key), body }
 * `settings`: { model, system, messages [{role, content}], temperature, topP,
 * maxTokens, reasoning: "default" | "on" | "off" } and `model.reasoningToggle`.
 */
export function buildChatRequest(settings, model) {
  const messages = [];
  const system = String(settings.system || "").trim();
  if (system) messages.push({ role: "system", content: system });
  for (const message of settings.messages || []) messages.push({ role: message.role, content: message.content });
  const body = {
    model: String(settings.model),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: settings.temperature,
    top_p: settings.topP,
    max_tokens: settings.maxTokens,
  };
  const toggle = model?.reasoningToggle;
  if (toggle && (settings.reasoning === "on" || settings.reasoning === "off")) mergePatch(body, toggle[settings.reasoning]);
  return {
    method: "POST",
    path: CHAT_PATH,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body,
  };
}

// ---- copy as curl / Python / Node ----------------------------------------------

function shellSingle(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

function keyText(key, includeKey, quote) {
  return includeKey && INSERTABLE_KEY_RE.test(String(key || "")) ? String(key) : quote;
}

/** Whether `key` can be put into a snippet at all (plain key characters only). */
export function keyIsInsertable(key) {
  return INSERTABLE_KEY_RE.test(String(key || ""));
}

/** The curl command that sends `request` (the key is $API_KEY unless includeKey). */
export function renderCurl(request, { baseUrl, key = "", includeKey = false } = {}) {
  const url = `${String(baseUrl || "").replace(/\/+$/, "")}${request.path}`;
  const token = keyText(key, includeKey, `$${KEY_ENV}`);
  return [
    `curl -N "${url}" \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Accept: text/event-stream" \\`,
    `  -d ${shellSingle(JSON.stringify(request.body, null, 2))}`,
  ].join("\n");
}

function pythonLiteral(value, depth = 0) {
  const pad = "    ".repeat(depth + 1);
  const end = "    ".repeat(depth);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => `${pad}${pythonLiteral(item, depth + 1)},`).join("\n")}\n${end}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([name, item]) => `${pad}${JSON.stringify(name)}: ${pythonLiteral(item, depth + 1)},`).join("\n")}\n${end}}`;
}

const PYTHON_ARGS = ["model", "messages", "temperature", "top_p", "max_tokens", "stream", "stream_options"];

/** The Python (openai package) program that sends `request`. */
export function renderPython(request, { baseUrl, key = "", includeKey = false } = {}) {
  const apiKey = includeKey && keyIsInsertable(key) ? JSON.stringify(String(key)) : `os.environ["${KEY_ENV}"]`;
  const args = [];
  const extra = {};
  for (const [name, value] of Object.entries(request.body)) {
    if (PYTHON_ARGS.includes(name)) args.push(`    ${name}=${pythonLiteral(value, 1)},`);
    else extra[name] = value;
  }
  if (Object.keys(extra).length) args.push(`    extra_body=${pythonLiteral(extra, 1)},`);
  return [
    "import os",
    "from openai import OpenAI",
    "",
    `client = OpenAI(base_url=${JSON.stringify(String(baseUrl || "").replace(/\/+$/, ""))}, api_key=${apiKey})`,
    "",
    "stream = client.chat.completions.create(",
    ...args,
    ")",
    "for chunk in stream:",
    "    if chunk.choices and chunk.choices[0].delta.content:",
    "        print(chunk.choices[0].delta.content, end=\"\", flush=True)",
  ].join("\n");
}

/** The Node (openai package) program that sends `request`. */
export function renderNode(request, { baseUrl, key = "", includeKey = false } = {}) {
  const apiKey = includeKey && keyIsInsertable(key) ? JSON.stringify(String(key)) : `process.env.${KEY_ENV}`;
  const body = JSON.stringify(request.body, null, 2).split("\n").map((line, index) => (index ? `  ${line}` : line)).join("\n");
  return [
    "import OpenAI from \"openai\";",
    "",
    `const client = new OpenAI({ baseURL: ${JSON.stringify(String(baseUrl || "").replace(/\/+$/, ""))}, apiKey: ${apiKey} });`,
    "",
    `const stream = await client.chat.completions.create(${body});`,
    "for await (const chunk of stream) {",
    "  process.stdout.write(chunk.choices[0]?.delta?.content ?? \"\");",
    "}",
  ].join("\n");
}

export const SNIPPET_RENDERERS = Object.freeze({ curl: renderCurl, python: renderPython, node: renderNode });

// ---- cost -----------------------------------------------------------------------

/**
 * Credits for one answer: price (per million tokens) x usage. Cached input
 * tokens are billed at the cached price when there is one. Returns null when
 * there is no price or no usage.
 */
export function computeCost(pricing, usage) {
  if (!pricing || !usage || pricing.unit !== "credits_per_million_tokens") return null;
  const input = Number(usage.inputTokens);
  const output = Number(usage.outputTokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (pricing.input === null || pricing.input === undefined || pricing.output === null || pricing.output === undefined) return null;
  const inputPrice = Number(pricing.input);
  const outputPrice = Number(pricing.output);
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  const cached = Math.min(input, Math.max(0, Number(usage.cachedTokens) || 0));
  const cachedPrice = pricing.cachedInput !== null && pricing.cachedInput !== undefined && Number.isFinite(Number(pricing.cachedInput)) ? Number(pricing.cachedInput) : inputPrice;
  return ((input - cached) * inputPrice + cached * cachedPrice + output * outputPrice) / 1_000_000;
}

// ---- the streaming run ------------------------------------------------------------

function usageOf(raw) {
  const usage = plainObject(raw);
  if (!usage) return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0);
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    cachedTokens: Number.isFinite(cached) ? cached : 0,
  };
}

function streamError(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : typeof error?.type === "string" && error.type ? error.type : "upstream_error";
  return new ApiError(typeof error?.message === "string" ? error.message : "The stream ended with an error", { status: 200, code });
}

/**
 * runChat({ request, key, signal, onDelta, fetchImpl, now }) -> metrics
 *   onDelta({ content, reasoning }) is called for every streamed piece.
 *   metrics: { stopped, finishReason, ttftMs, durationMs, inputTokens,
 *              cachedTokens, outputTokens, estimated, tokensPerSecond }
 * An abort (the Stop button) resolves with stopped: true and the metrics so far;
 * an HTTP error or a stream error rejects with an ApiError.
 */
export async function runChat({ request, key, signal, onDelta = () => {}, fetchImpl = globalThis.fetch, now = () => globalThis.performance.now() }) {
  const startedAt = now();
  let firstTokenAt = null;
  let deltas = 0;
  let usage = null;
  let finishReason = "";
  let stopped = false;

  const piece = (content, reasoning) => {
    if (!content && !reasoning) return;
    if (firstTokenAt === null) firstTokenAt = now();
    deltas += 1;
    onDelta({ content: content || "", reasoning: reasoning || "" });
  };

  try {
    let response;
    try {
      response = await fetchImpl(LOCAL_CHAT_URL, {
        method: request.method,
        credentials: "omit",
        signal,
        headers: { ...request.headers, authorization: `Bearer ${key}` },
        body: JSON.stringify(request.body),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError("Network error", { code: "network_error" });
    }
    if (!response.ok) throw await errorFromResponse(response);

    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("application/json")) {
      // A server that ignored stream:true answers one JSON document.
      const doc = await response.json();
      const message = doc?.choices?.[0]?.message;
      piece(typeof message?.content === "string" ? message.content : "", typeof (message?.reasoning_content ?? message?.reasoning) === "string" ? (message.reasoning_content ?? message.reasoning) : "");
      finishReason = doc?.choices?.[0]?.finish_reason || "";
      usage = usageOf(doc?.usage);
    } else {
      await readSseStream(response.body, (event) => {
        const text = event.data.trim();
        if (!text || text === "[DONE]") return;
        let chunk;
        try {
          chunk = JSON.parse(text);
        } catch {
          return;
        }
        if (chunk?.error) throw streamError(chunk.error);
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
        const delta = plainObject(choice?.delta) || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        piece(typeof delta.content === "string" ? delta.content : "", typeof reasoning === "string" ? reasoning : "");
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
        const seen = usageOf(chunk?.usage);
        if (seen) usage = seen;
      }, { signal });
    }
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) stopped = true;
    else throw error;
  }

  const endedAt = now();
  const estimated = !usage;
  const outputTokens = usage ? usage.outputTokens : deltas;
  const decodeMs = firstTokenAt === null ? 0 : endedAt - firstTokenAt;
  return {
    stopped,
    finishReason,
    ttftMs: firstTokenAt === null ? null : Math.max(0, Math.round(firstTokenAt - startedAt)),
    durationMs: Math.max(0, Math.round(endedAt - startedAt)),
    inputTokens: usage ? usage.inputTokens : null,
    cachedTokens: usage ? usage.cachedTokens : null,
    outputTokens,
    estimated,
    tokensPerSecond: outputTokens > 0 && decodeMs >= 50 ? Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10 : null,
  };
}
