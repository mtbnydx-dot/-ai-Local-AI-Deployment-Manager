"use strict";

// ResponseSniffer (04 §6.2): reads usage, finish reason, first-token time and
// engine timings from a gateway response while it is forwarded. It sees a
// copy of the bytes and never changes them, and it never throws into the
// response path.
//
// createResponseSniffer({ protocol, stream, contentType, estimatedInputTokens, status })
//   push(chunk, tMs)  chunk: Buffer | Uint8Array | string; tMs: monotonic ms
//                     (performance.now()) when the chunk arrived
//   finish() → { usage, finishReason, firstTokenAt, engineTimings, upstreamError, bytes, skippedEvents }
//
// Content retention: event text is dropped as soon as the event is parsed,
// non-stream JSON is held (at most 2 MiB) only until finish(), and nothing
// returned carries prompt or completion text. The only body text that leaves
// is `upstreamError.text`, at most 4 KiB of an error body for classifyOutcome;
// it is non-enumerable, so serialising the result drops it.

const { performance } = require("node:perf_hooks");
const { TextDecoder } = require("node:util");
const {
  normalizeOpenAiUsage,
  extractOpenAiUsagePayload,
  createOpenAiStreamOutputEstimator,
  observeOpenAiStreamDelta,
} = require("../gateway-utils");

const MAX_SSE_EVENT_BYTES = 64 * 1024;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const MAX_ESTIMATED_TOKENS = 100_000_000;
const LLM_PROTOCOLS = new Set(["openai", "opencode", "claude", "external"]);
// After the first token only events that carry one of these are parsed.
const RESULT_KEYS = ['"usage"', '"finish_reason"', '"stop_reason"', '"timings"', '"error"'];
// The keys createOpenAiSseUsageParser looks for before it feeds its output
// estimator; the same filter keeps the estimate identical to the managers'.
const ESTIMATOR_KEYS = ['"usage"', '"delta"', '"content"', '"arguments"', '"reasoning"'];
const SSE_SEPARATORS = ["\r\n\r\n", "\n\n", "\r\r"];

const FINISH_REASONS = new Map([
  ["stop", "stop"], ["eos", "stop"], ["end_turn", "stop"], ["stop_sequence", "stop"],
  ["length", "length"], ["max_tokens", "length"], ["max_output_tokens", "length"], ["model_length", "length"],
  ["tool_calls", "tool_calls"], ["function_call", "tool_calls"], ["tool_use", "tool_calls"],
  ["content_filter", "content_filter"], ["refusal", "content_filter"],
  ["abort", "abort"], ["cancelled", "abort"],
  ["error", "error"], ["failed", "error"],
]);

function normalizeFinishReason(value) {
  const raw = value && typeof value === "object" ? value.type : value;
  if (raw === null || raw === undefined || raw === "") return null;
  return FINISH_REASONS.get(String(raw).trim().toLowerCase()) || "other";
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonEmpty(value) {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object");
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(chunk);
}

function findSseBoundary(text) {
  let boundary = null;
  for (const separator of SSE_SEPARATORS) {
    const index = text.indexOf(separator);
    if (index >= 0 && (!boundary || index < boundary.index)) boundary = { index, length: separator.length };
  }
  return boundary;
}

// The data payload of one SSE event (data lines joined by "\n").
function sseEventData(eventText) {
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
  return dataLines.join("\n").trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readReasoningTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  for (const source of [usage.completion_tokens_details, usage.output_tokens_details, usage]) {
    const value = finiteOrNull(source?.reasoning_tokens);
    if (value !== null && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function usageResult(source, normalized, rawUsage = null) {
  if (source === "missing") {
    return { source, promptTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
  }
  return {
    source,
    promptTokens: normalized.inputTokens ?? null,
    cachedTokens: normalized.cachedTokens ?? null,
    outputTokens: normalized.outputTokens ?? null,
    reasoningTokens: readReasoningTokens(rawUsage),
    totalTokens: normalized.totalTokens ?? null,
  };
}

function machineCode(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || /^\d+$/.test(text)) return null;
  return text.slice(0, 128);
}

// { code, type } of an OpenAI, Anthropic, vLLM or entry error body, plus the
// non-enumerable classification text.
function buildUpstreamError(data, text) {
  const error = data && typeof data === "object"
    ? (data.error && typeof data.error === "object" ? data.error : data)
    : {};
  const result = {
    code: machineCode(error.code) || machineCode(error.type) || machineCode(data?.code) || null,
    type: machineCode(error.type),
  };
  const message = typeof data?.error === "string" ? data.error : (error.message || error.detail || data?.detail || text || "");
  Object.defineProperty(result, "text", {
    value: Buffer.from(String(message), "utf8").subarray(0, MAX_ERROR_TEXT_BYTES).toString("utf8"),
    enumerable: false,
  });
  return result;
}

function isErrorPayload(data) {
  if (!data || typeof data !== "object") return false;
  if (data.object === "error" || data.type === "error") return true;
  return Boolean(data.error) && !Array.isArray(data.choices);
}

function selectMode(contentType, stream) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/event-stream")) return "sse";
  if (type.includes("json")) return "json";
  if (!type) return stream ? "sse" : "json";
  return "raw";
}

function createResponseSniffer(options = {}) {
  const protocol = String(options.protocol || "openai").toLowerCase();
  const status = Number(options.status) || 0;
  const mode = selectMode(options.contentType, options.stream === true);
  const readsUsage = LLM_PROTOCOLS.has(protocol);
  const estimatedInputTokens = Number.isSafeInteger(Number(options.estimatedInputTokens))
    ? Math.max(0, Math.min(MAX_ESTIMATED_TOKENS, Number(options.estimatedInputTokens)))
    : 0;
  // Other protocols (TTS, search, MCP) are only counted, and their bodies are
  // read only for an error code.
  const buffersJson = readsUsage || status === 0 || status >= 400;
  const decoder = new TextDecoder("utf-8");
  const estimator = readsUsage && mode === "sse" ? createOpenAiStreamOutputEstimator() : null;
  const errorChunks = [];
  let errorBytes = 0;
  let jsonChunks = [];
  let jsonBytes = 0;
  let jsonOverflow = false;
  let pending = "";
  let discarding = false;
  let disabled = false;
  let finished = false;
  let bytes = 0;
  let skippedEvents = 0;
  let lastAt = null;
  let firstTokenAt = null;
  let finishReason = null;
  let engineTimings = null;
  let upstreamError = null;
  let reported = null; // { normalized, raw } of the latest OpenAI usage
  let claudeStartUsage = null;
  let claudeDeltaUsage = null;

  const markFirstToken = (tMs) => {
    if (firstTokenAt === null) firstTokenAt = tMs;
  };

  const readOpenAiChoices = (data, tMs) => {
    const choices = Array.isArray(data.choices) ? data.choices.slice(0, 256) : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : null;
      if (delta && (nonEmpty(delta.content) || nonEmpty(delta.reasoning_content) || nonEmpty(delta.reasoning)
        || nonEmpty(delta.tool_calls) || nonEmpty(delta.function_call))) {
        markFirstToken(tMs);
      } else if (typeof choice.text === "string" && choice.text.length) {
        markFirstToken(tMs);
      }
      const reason = normalizeFinishReason(choice.finish_reason);
      if (reason) finishReason = reason;
    }
  };

  // Anthropic Messages events and OpenAI Responses events are told apart by
  // their `type`.
  const readTypedEvent = (data, tMs) => {
    const type = typeof data.type === "string" ? data.type : "";
    if (!type) return;
    if (type === "message_start") {
      claudeStartUsage = data.message?.usage && typeof data.message.usage === "object" ? data.message.usage : null;
    } else if (type === "content_block_delta") {
      markFirstToken(tMs);
    } else if (type === "message_delta") {
      if (data.usage && typeof data.usage === "object") claudeDeltaUsage = { ...(claudeDeltaUsage || {}), ...data.usage };
      const reason = normalizeFinishReason(data.delta?.stop_reason);
      if (reason) finishReason = reason;
    } else if (type.startsWith("response.") && type.endsWith(".delta") && nonEmpty(data.delta)) {
      markFirstToken(tMs);
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      finishReason = responsesFinishReason(data.response, type) || finishReason;
    }
  };

  const readUsageAndTimings = (data) => {
    const rawUsage = extractOpenAiUsagePayload(data);
    // Anthropic message_* events carry usage too; they are merged separately.
    if (rawUsage && data.type !== "message_delta" && data.type !== "message_start") {
      const normalized = normalizeOpenAiUsage(rawUsage);
      if (normalized.usageSource !== "missing") reported = { normalized, raw: rawUsage };
    }
    if (data.timings && typeof data.timings === "object") {
      engineTimings = {
        promptMs: finiteOrNull(data.timings.prompt_ms),
        decodeTps: finiteOrNull(data.timings.predicted_per_second),
        cachedTokens: finiteOrNull(data.timings.cache_n),
      };
    }
  };

  const processSseEvent = (eventText, tMs) => {
    const payload = sseEventData(eventText);
    if (!payload || payload === "[DONE]") return;
    const forResult = readsUsage
      ? firstTokenAt === null || RESULT_KEYS.some((key) => payload.includes(key))
      : payload.includes('"error"');
    const forEstimate = Boolean(estimator) && ESTIMATOR_KEYS.some((key) => payload.includes(key));
    if (!forResult && !forEstimate) return;
    const data = parseJson(payload);
    if (!data || typeof data !== "object") return;
    if (forEstimate) observeOpenAiStreamDelta(estimator, data);
    if (isErrorPayload(data)) {
      upstreamError = buildUpstreamError(data, "");
      return;
    }
    if (!readsUsage) return;
    readOpenAiChoices(data, tMs);
    readTypedEvent(data, tMs);
    readUsageAndTimings(data);
  };

  const drainSse = (tMs) => {
    if (discarding) {
      const boundary = findSseBoundary(pending);
      if (!boundary) {
        pending = pending.slice(-3);
        return;
      }
      pending = pending.slice(boundary.index + boundary.length);
      discarding = false;
    }
    let boundary = findSseBoundary(pending);
    while (boundary) {
      const eventText = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary.length);
      if (Buffer.byteLength(eventText, "utf8") > MAX_SSE_EVENT_BYTES) skippedEvents += 1;
      else processSseEvent(eventText, tMs);
      boundary = findSseBoundary(pending);
    }
    if (Buffer.byteLength(pending, "utf8") > MAX_SSE_EVENT_BYTES) {
      // Keep the tail so a separator split across chunks is still found.
      pending = pending.slice(-3);
      discarding = true;
      skippedEvents += 1;
    }
  };

  const captureErrorText = (buffer) => {
    if (errorBytes >= MAX_ERROR_TEXT_BYTES) return;
    const slice = buffer.subarray(0, MAX_ERROR_TEXT_BYTES - errorBytes);
    errorChunks.push(Buffer.from(slice));
    errorBytes += slice.length;
  };

  function push(chunk, tMs) {
    if (finished || chunk === undefined || chunk === null) return;
    try {
      const buffer = toBuffer(chunk);
      bytes += buffer.length;
      const at = typeof tMs === "number" && Number.isFinite(tMs) ? tMs : performance.now();
      lastAt = at;
      if (disabled) return;
      if (status >= 400) captureErrorText(buffer);
      if (mode === "raw") return;
      if (mode === "json") {
        if (jsonOverflow || !buffersJson) return;
        if (jsonBytes + buffer.length > MAX_JSON_BODY_BYTES) {
          jsonOverflow = true;
          jsonChunks = [];
          return;
        }
        jsonChunks.push(Buffer.from(buffer));
        jsonBytes += buffer.length;
        return;
      }
      const decoded = decoder.decode(buffer, { stream: true });
      if (!decoded) return;
      pending += decoded;
      drainSse(at);
    } catch {
      // Sniffing is a side channel; the response bytes were already forwarded.
      disabled = true;
      pending = "";
      jsonChunks = [];
    }
  }

  const finishJson = () => {
    if (jsonOverflow || !jsonChunks.length) return;
    const text = Buffer.concat(jsonChunks).toString("utf8");
    jsonChunks = [];
    const data = parseJson(text);
    if (!data || typeof data !== "object") return;
    if (status >= 400 || isErrorPayload(data)) {
      upstreamError = buildUpstreamError(data, text);
      return;
    }
    if (!readsUsage) return;
    // Anthropic non-stream messages keep usage at the top level, like OpenAI.
    readUsageAndTimings(data);
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    finishReason = normalizeFinishReason(choice?.finish_reason)
      || normalizeFinishReason(data.stop_reason)
      || (data.object === "response" ? responsesFinishReason(data, "") : null);
  };

  function finish() {
    if (!finished) {
      finished = true;
      try {
        if (!disabled && mode === "sse") {
          pending += decoder.decode();
          drainSse(lastAt ?? performance.now());
          if (!discarding && pending.trim()) processSseEvent(pending, lastAt ?? performance.now());
        } else if (!disabled && mode === "json") {
          finishJson();
        }
      } catch {
        // Keep whatever was read before the failure.
      }
      pending = "";
      jsonChunks = [];
      if (!upstreamError && status >= 400 && errorBytes) {
        const text = Buffer.concat(errorChunks).toString("utf8");
        upstreamError = buildUpstreamError(parseJson(text), text);
      }
      errorChunks.length = 0;
    }
    return {
      usage: resolveUsage(),
      finishReason,
      firstTokenAt,
      engineTimings,
      upstreamError,
      bytes,
      skippedEvents,
    };
  }

  function resolveUsage() {
    if (!readsUsage) return usageResult("missing");
    if (claudeDeltaUsage) {
      const merged = { ...(claudeStartUsage || {}), ...claudeDeltaUsage };
      const normalized = normalizeOpenAiUsage(merged);
      if (normalized.usageSource !== "missing") return usageResult("reported", normalized, merged);
    }
    if (reported) return usageResult("reported", reported.normalized, reported.raw);
    const estimatedOutputTokens = estimator ? estimator.estimateTokens() : 0;
    if (estimatedOutputTokens > 0) {
      const startInput = Number(claudeStartUsage?.input_tokens);
      const promptTokens = Number.isSafeInteger(startInput) && startInput > 0 ? startInput : estimatedInputTokens;
      const normalized = normalizeOpenAiUsage({
        prompt_tokens: promptTokens,
        completion_tokens: estimatedOutputTokens,
        total_tokens: Math.min(MAX_ESTIMATED_TOKENS, promptTokens + estimatedOutputTokens),
      }, { estimated: true });
      return usageResult("estimated", normalized);
    }
    return usageResult("missing");
  }

  return { push, finish };
}

// Finish reason of an OpenAI Responses object (non-stream body, or the
// `response` of a response.completed / .incomplete / .failed event).
function responsesFinishReason(response, eventType) {
  if (!response || typeof response !== "object") return null;
  const status = String(response.status || eventType.replace(/^response\./, "") || "");
  if (status === "incomplete") return normalizeFinishReason(response.incomplete_details?.reason) || "length";
  if (status === "failed") return "error";
  if (status === "cancelled") return "abort";
  if (status !== "completed") return null;
  const output = Array.isArray(response.output) ? response.output : [];
  return output.some((item) => item?.type === "function_call") ? "tool_calls" : "stop";
}

module.exports = {
  MAX_SSE_EVENT_BYTES,
  MAX_JSON_BODY_BYTES,
  normalizeFinishReason,
  createResponseSniffer,
};
