"use strict";

// The usage tap (docs/overhaul/05-public.md §8.6): a pass-through Transform
// that reads the token usage out of an upstream response while the bytes go
// to the client unchanged.
//
//   createUsageTap({ protocol, endpoint, stream, estimatedInputTokens, ... })
//     -> { transform, result: Promise<{ inputTokens, cachedInputTokens,
//          outputTokens, source, terminal }> }
//
// - OpenAI SSE goes through core.createOpenAiSseUsageParser (the manager has
//   already forced include_usage, V9); Anthropic SSE reads
//   message_start.message.usage and message_delta.usage; a non-stream answer
//   is read from a bounded copy (MAX_JSON_BYTES) and its `usage`.
// - The tap never delays, reorders or changes bytes: every chunk is passed on
//   first, and the parsing is a side channel whose failures are swallowed.
// - It resolves on `finish` or `close`, whichever comes first. A client abort
//   (or an upstream failure mid-stream) therefore keeps the partial counts.
// - Where 04's GatewayRecorder sniffer reads the same usage this module stays
//   a thin adapter over the shared normalizers (contract C5); it adds only
//   what 05 needs: the cached count, the terminal state and the abort partial.

const { Transform } = require("node:stream");
const core = require("../../manager-core");

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const CHARS_PER_TOKEN = 4;

function count(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isEventStream(contentType) {
  return /text\/event-stream/i.test(String(contentType || ""));
}

// The data payloads of one SSE event block.
function eventData(eventText) {
  const lines = [];
  for (const line of eventText.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    if ((separator < 0 ? line : line.slice(0, separator)) !== "data") continue;
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    lines.push(value);
  }
  return lines.join("\n").trim();
}

function findBoundary(text) {
  let boundary = null;
  for (const separator of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const index = text.indexOf(separator);
    if (index >= 0 && (!boundary || index < boundary.index)) boundary = { index, length: separator.length };
  }
  return boundary;
}

// Anthropic Messages stream: input tokens arrive in message_start, output
// tokens in message_delta (cumulative). Text deltas are counted as a fallback
// estimate for a stream cut off before its message_delta.
function createAnthropicSseParser() {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let discarding = false;
  let inputTokens;
  let cachedTokens;
  let outputTokens;
  let sampleChars = 0;

  const readUsage = (usage, fromStart) => {
    if (!usage || typeof usage !== "object") return;
    if (usage.input_tokens !== undefined && (fromStart || inputTokens === undefined)) inputTokens = count(usage.input_tokens);
    const cached = usage.cache_read_input_tokens ?? usage.cached_tokens;
    if (cached !== undefined) cachedTokens = count(cached);
    // message_start carries a placeholder output count; only message_delta is final.
    if (!fromStart && usage.output_tokens !== undefined) outputTokens = count(usage.output_tokens);
  };

  const processEvent = (eventText) => {
    const payload = eventData(eventText);
    if (!payload || payload === "[DONE]") return;
    if (!payload.includes('"usage"') && !payload.includes('"delta"')) return;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (data.type === "message_start") readUsage(data.message?.usage, true);
    else if (data.type === "message_delta") readUsage(data.usage, false);
    else if (data.type === "content_block_delta") {
      const delta = data.delta || {};
      sampleChars += String(delta.text ?? delta.thinking ?? delta.partial_json ?? "").length;
    }
  };

  const drain = () => {
    if (discarding) {
      const boundary = findBoundary(pending);
      if (!boundary) {
        pending = pending.slice(-3);
        return;
      }
      pending = pending.slice(boundary.index + boundary.length);
      discarding = false;
    }
    let boundary = findBoundary(pending);
    while (boundary) {
      const eventText = pending.slice(0, boundary.index);
      if (eventText.length <= MAX_SSE_EVENT_BYTES) processEvent(eventText);
      pending = pending.slice(boundary.index + boundary.length);
      boundary = findBoundary(pending);
    }
    if (pending.length > MAX_SSE_EVENT_BYTES) {
      pending = pending.slice(-3);
      discarding = true;
    }
  };

  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      drain();
    },
    finish() {
      pending += decoder.decode();
      drain();
      if (!discarding && pending.trim()) processEvent(pending);
      pending = "";
      const reported = inputTokens !== undefined || outputTokens !== undefined;
      return {
        reported,
        inputTokens: inputTokens ?? 0,
        cachedTokens: cachedTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        outputKnown: outputTokens !== undefined,
        estimatedOutputTokens: Math.ceil(sampleChars / CHARS_PER_TOKEN),
      };
    },
  };
}

function createOpenAiParser(estimatedInputTokens) {
  const parser = core.createOpenAiSseUsageParser({ estimatedInputTokens });
  return {
    push(chunk) {
      parser.push(chunk, { forwarded: true });
    },
    finish() {
      const usage = parser.finish();
      return {
        reported: usage.usageSource === "reported",
        estimated: usage.usageSource === "estimated",
        inputTokens: count(usage.inputTokens),
        cachedTokens: count(usage.cachedTokens),
        outputTokens: count(usage.outputTokens),
      };
    },
  };
}

// A non-stream body: kept (up to the bound) and parsed once at the end.
function createJsonParser() {
  const chunks = [];
  let size = 0;
  let overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    },
    finish() {
      const none = { reported: false, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
      if (overflow || !chunks.length) return none;
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return none;
      }
      const usage = core.normalizeOpenAiUsage(core.extractOpenAiUsagePayload(data));
      if (usage.usageSource === "missing") return none;
      return {
        reported: true,
        inputTokens: count(usage.inputTokens),
        cachedTokens: count(usage.cachedTokens),
        outputTokens: count(usage.outputTokens),
      };
    },
  };
}

/**
 * createUsageTap(options) -> { transform, result }
 *   protocol               "openai" | "anthropic"
 *   endpoint               the scope or path the request used (informational)
 *   stream                 whether the request asked for a stream
 *   estimatedInputTokens   the admission estimate, used when nothing was reported
 *   contentType            the upstream content type: a stream request that
 *                          was answered with JSON (an error) is read as JSON
 *   status                 the upstream status (>= 400 ends as upstream_error)
 *   abortReason            () -> the upstream control's abort reason, if any
 *   onResult               (result) called synchronously when the result is known
 */
function createUsageTap(options = {}) {
  const protocol = options.protocol === "anthropic" ? "anthropic" : "openai";
  const estimatedInputTokens = count(options.estimatedInputTokens);
  const asStream = options.stream === true && (options.contentType === undefined || isEventStream(options.contentType));
  let parser;
  if (!asStream) parser = createJsonParser();
  else parser = protocol === "anthropic" ? createAnthropicSseParser() : createOpenAiParser(estimatedInputTokens);

  let settled = false;
  let finished = false;
  let failure = null;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  function terminalState() {
    const reason = typeof options.abortReason === "function" ? String(options.abortReason() || "") : "";
    if (reason === "timeout") return "timeout";
    if (reason === "client_disconnect") return "client_abort";
    if (finished && !failure) return Number(options.status) >= 400 ? "upstream_error" : "completed";
    // Closed before the end of the body: the client left (the pipeline then
    // destroys the stages with a premature-close error) or the upstream broke.
    if (!failure || failure.code === "ERR_STREAM_PREMATURE_CLOSE") return "client_abort";
    return "upstream_error";
  }

  function settle() {
    if (settled) return;
    settled = true;
    let summary;
    try {
      summary = parser.finish();
    } catch {
      summary = { reported: false, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    }
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let source = "none";
    if (summary.reported) {
      source = "upstream";
      inputTokens = summary.inputTokens;
      cachedInputTokens = summary.cachedTokens;
      outputTokens = summary.outputTokens;
      // Anthropic reports its output only at the end: a cut-off stream keeps
      // the reported input and an estimate of what was streamed.
      if (summary.outputKnown === false && summary.estimatedOutputTokens > 0) {
        outputTokens = summary.estimatedOutputTokens;
        source = "estimate";
      }
    } else if (summary.estimated || summary.estimatedOutputTokens > 0) {
      source = "estimate";
      inputTokens = summary.estimated ? summary.inputTokens : estimatedInputTokens;
      cachedInputTokens = 0;
      outputTokens = summary.estimated ? summary.outputTokens : summary.estimatedOutputTokens;
    }
    const outcome = { inputTokens, cachedInputTokens, outputTokens, source, terminal: terminalState() };
    resolveResult(outcome);
    // A promise reaction can run after the response has already finished, so
    // the pipeline settles through this synchronous hook.
    if (typeof options.onResult === "function") {
      try {
        options.onResult(outcome);
      } catch {
        // Never into the stream.
      }
    }
  }

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      // Parsing is a synchronous side channel, in order and before the next
      // chunk can be handed over; its failure never touches the bytes.
      if (!settled) {
        try {
          parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch {
          // Side channel only.
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      // Every byte has been seen: settle now, before the end reaches the
      // client, so the reservation is settled with the real usage and not by
      // the response's own finish. finish and close remain the fallbacks.
      finished = true;
      settle();
      callback();
    },
    destroy(error, callback) {
      if (error) failure = error;
      callback(error);
    },
  });
  transform.once("finish", settle);
  transform.once("close", settle);

  return { transform, result };
}

module.exports = {
  MAX_JSON_BYTES,
  createUsageTap,
};
