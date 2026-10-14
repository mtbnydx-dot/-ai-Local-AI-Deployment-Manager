"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createResponseSniffer, MAX_SSE_EVENT_BYTES, MAX_JSON_BODY_BYTES } = require("../telemetry/sniffer");
const { classifyOutcome } = require("../telemetry/error-class");
const gateway = require("../gateway-utils");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "telemetry", "sniffer");
const fixtures = fs.readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) }));

const ev = (value) => `data: ${JSON.stringify(value)}\n\n`;

function run(options, chunks) {
  const sniffer = createResponseSniffer(options);
  for (const chunk of chunks) sniffer.push(chunk.text, chunk.tMs);
  return sniffer.finish();
}

function comparable(result) {
  const { usage, finishReason, firstTokenAt, engineTimings, upstreamError, skippedEvents } = result;
  return {
    usage,
    finishReason,
    firstTokenAt,
    engineTimings,
    upstreamError: upstreamError ? { ...upstreamError } : null,
    skippedEvents,
  };
}

// The same bytes split into single-byte chunks, each stamped with the time
// of the chunk it came from, and as Uint8Array views instead of strings.
function byteChunks(chunks) {
  const output = [];
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.text, "utf8");
    for (let index = 0; index < bytes.length; index += 1) {
      output.push({ text: new Uint8Array(bytes.subarray(index, index + 1)), tMs: chunk.tMs });
    }
  }
  return output;
}

test("sniffer golden fixtures", () => {
  const expectedNames = [
    "anthropic-json.json", "anthropic-stream.json", "error-json.json", "llama-timings.json", "non-stream-json.json",
    "openai-stream-no-usage.json", "openai-stream-usage.json", "responses-stream.json", "stream-error-event.json",
    "truncated-stream.json",
  ];
  assert.deepEqual(fixtures.map((item) => item.name), expectedNames);
  for (const fixture of fixtures) {
    const result = run(fixture.options, fixture.chunks);
    assert.deepEqual(comparable(result), fixture.expected, fixture.name);
    const totalBytes = fixture.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
    assert.equal(result.bytes, totalBytes, `${fixture.name} counts every byte`);
    if (fixture.expectedErrorText) assert.equal(result.upstreamError.text, fixture.expectedErrorText, fixture.name);
  }
});

test("sniffer results do not depend on how the bytes are chunked", () => {
  for (const fixture of fixtures) {
    const whole = run(fixture.options, fixture.chunks);
    const split = run(fixture.options, byteChunks(fixture.chunks));
    assert.deepEqual(comparable(split), comparable(whole), fixture.name);
    assert.equal(split.bytes, whole.bytes);
  }
});

test("estimated usage equals the managers' createOpenAiSseUsageParser estimate", () => {
  const estimated = fixtures.filter((item) => item.expected.usage.source === "estimated");
  assert.ok(estimated.length >= 2);
  for (const fixture of estimated) {
    const parser = gateway.createOpenAiSseUsageParser({
      estimatedInputTokens: fixture.options.estimatedInputTokens,
      maxBufferBytes: MAX_SSE_EVENT_BYTES,
    });
    for (const chunk of fixture.chunks) parser.push(chunk.text);
    const reference = parser.finish();
    const { usage } = run(fixture.options, fixture.chunks);
    assert.equal(reference.usageSource, "estimated", fixture.name);
    assert.deepEqual(
      { promptTokens: usage.promptTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens },
      { promptTokens: reference.inputTokens, outputTokens: reference.outputTokens, totalTokens: reference.totalTokens },
      fixture.name,
    );
  }
});

test("first-token time is the arrival time of the chunk that completes the first content event", () => {
  const role = ev({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  const empty = ev({ choices: [{ index: 0, delta: { content: "", reasoning_content: "" }, finish_reason: null }] });
  const content = ev({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] });
  const cut = Math.floor(content.length / 2);
  const result = run({ protocol: "openai", stream: true, contentType: "text/event-stream" }, [
    { text: role, tMs: 100 },
    { text: empty, tMs: 150 },
    { text: content.slice(0, cut), tMs: 200 },
    { text: content.slice(cut), tMs: 260 },
    { text: ev({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }] }), tMs: 300 },
  ]);
  assert.equal(result.firstTokenAt, 260);
  assert.equal(result.finishReason, "stop");

  // Legacy completions stream text instead of a delta.
  const completions = run({ protocol: "openai", stream: true, contentType: "text/event-stream" }, [
    { text: ev({ choices: [{ index: 0, text: "", finish_reason: null }] }), tMs: 10 },
    { text: ev({ choices: [{ index: 0, text: "Once", finish_reason: null }] }), tMs: 42 },
  ]);
  assert.equal(completions.firstTokenAt, 42);

  // Without a time the sniffer stamps the chunk itself.
  const sniffer = createResponseSniffer({ protocol: "openai", stream: true, contentType: "text/event-stream" });
  sniffer.push(content);
  assert.equal(typeof sniffer.finish().firstTokenAt, "number");
});

test("an oversized SSE event is skipped and the stream after it is still read", () => {
  const huge = ev({ choices: [{ index: 0, delta: { content: "z".repeat(MAX_SSE_EVENT_BYTES + 10) }, finish_reason: null }] });
  const tail = ev({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 70000, total_tokens: 70009 } });
  // The second chunk takes the pending event past 64 KiB before its end has
  // arrived, so the sniffer discards until the next event boundary.
  const cut = huge.length - 5;
  assert.ok(cut > MAX_SSE_EVENT_BYTES && huge.slice(cut).endsWith("\n\n"));
  const chunks = [
    { text: huge.slice(0, 40000), tMs: 1 },
    { text: huge.slice(40000, cut), tMs: 2 },
    { text: huge.slice(cut), tMs: 3 },
    { text: ev({ choices: [{ index: 0, delta: { content: "small" }, finish_reason: "length" }] }), tMs: 4 },
    { text: tail, tMs: 5 },
  ];
  const result = run({ protocol: "openai", stream: true, contentType: "text/event-stream" }, chunks);
  assert.equal(result.skippedEvents, 1);
  assert.equal(result.firstTokenAt, 4, "the skipped event is not parsed");
  assert.equal(result.finishReason, "length");
  assert.equal(result.usage.source, "reported");
  assert.equal(result.usage.outputTokens, 70000);
  assert.equal(result.bytes, chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0));

  // A complete oversized event inside one chunk is skipped the same way.
  const single = run({ protocol: "openai", stream: true, contentType: "text/event-stream" }, [{ text: huge + tail, tMs: 1 }]);
  assert.equal(single.skippedEvents, 1);
  assert.equal(single.usage.outputTokens, 70000);
});

test("a non-stream body over 2 MiB is not parsed and its usage is missing", () => {
  const body = JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "y".repeat(MAX_JSON_BODY_BYTES) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  const result = run({ protocol: "openai", stream: false, contentType: "application/json" }, [
    { text: body.slice(0, 1024 * 1024), tMs: 1 },
    { text: body.slice(1024 * 1024), tMs: 2 },
  ]);
  assert.equal(result.usage.source, "missing");
  assert.equal(result.finishReason, null);
  assert.equal(result.bytes, Buffer.byteLength(body));
});

test("content retention: no prompt or completion text survives the sniffer", () => {
  const marker = "ZQXV-CONTENT-MARKER";
  const fragments = [`${marker}-reasoning`, `${marker}-content`, `${marker}-tool`];
  const openAi = [
    ev({ choices: [{ index: 0, delta: { reasoning_content: fragments[0] }, finish_reason: null }] }),
    ev({ choices: [{ index: 0, delta: { content: fragments[1] }, finish_reason: null }] }),
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: fragments[2] } }] }, finish_reason: "tool_calls" }] }),
  ].join("");
  const claude = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fragments[1] } })}\n\n`,
  ].join("");
  const cases = [
    [{ protocol: "openai", stream: true, contentType: "text/event-stream" }, openAi],
    [{ protocol: "opencode", stream: true, contentType: "text/event-stream" }, `${openAi}${ev({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`],
    [{ protocol: "claude", stream: true, contentType: "text/event-stream" }, claude],
    [{ protocol: "openai", stream: false, contentType: "application/json" }, JSON.stringify({ choices: [{ index: 0, message: { content: fragments[1] }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } })],
    [{ protocol: "tts", stream: false, contentType: "audio/wav", status: 200 }, `RIFF${marker}`],
  ];
  for (const [options, text] of cases) {
    const sniffer = createResponseSniffer(options);
    // Odd chunk sizes leave partial events pending between pushes.
    for (let index = 0; index < text.length; index += 37) sniffer.push(text.slice(index, index + 37), index);
    const result = sniffer.finish();
    assert.equal(JSON.stringify(result).includes(marker), false, `${options.protocol} result`);
    assert.equal(result.upstreamError, null);
    // Nothing reachable from the result object holds the text either.
    const strings = [];
    const visit = (value) => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") for (const key of Reflect.ownKeys(value)) visit(value[key]);
    };
    visit(result);
    assert.equal(strings.some((value) => value.includes(marker)), false);
  }
});

test("error bodies: classification text is capped at 4 KiB, non-enumerable, and feeds classifyOutcome", () => {
  const fixture = fixtures.find((item) => item.name === "error-json.json");
  const result = run(fixture.options, fixture.chunks);
  assert.equal(Object.keys(result.upstreamError).includes("text"), false);
  assert.equal(JSON.stringify(result).includes("maximum context length"), false);
  const outcome = classifyOutcome({
    phase: "upstream",
    status: fixture.options.status,
    code: result.upstreamError.code,
    upstreamErrorText: result.upstreamError.text,
  });
  assert.deepEqual(outcome, { terminalState: "failed", errorClass: "context_overflow", errorCode: "context_length_exceeded" });

  const long = run({ protocol: "openai", stream: false, contentType: "text/plain", status: 502 }, [
    { text: "upstream exploded ".repeat(1000), tMs: 1 },
  ]);
  assert.equal(long.upstreamError.code, null);
  assert.ok(Buffer.byteLength(long.upstreamError.text) <= 4096);
  assert.ok(long.upstreamError.text.startsWith("upstream exploded"));

  // vLLM's error object carries the HTTP status as `code`; the type is the code then.
  const vllm = run({ protocol: "openai", stream: false, contentType: "application/json", status: 400 }, [
    { text: JSON.stringify({ object: "error", message: "bad", type: "BadRequestError", param: null, code: 400 }), tMs: 1 },
  ]);
  assert.deepEqual({ ...vllm.upstreamError }, { code: "BadRequestError", type: "BadRequestError" });

  // The entry's own refusals ({detail, code}) and Anthropic stream errors.
  const entry = run({ protocol: "tts", stream: false, contentType: "application/json", status: 429 }, [
    { text: JSON.stringify({ detail: "TTS billing allowance is insufficient for this request.", code: "billing_tts_daily_limit" }), tMs: 1 },
  ]);
  assert.equal(entry.upstreamError.code, "billing_tts_daily_limit");
  const claude = run({ protocol: "claude", stream: true, contentType: "text/event-stream" }, [
    { text: `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`, tMs: 1 },
  ]);
  assert.deepEqual({ ...claude.upstreamError }, { code: "overloaded_error", type: "overloaded_error" });
});

test("non-LLM protocols are counted only, and the sniffer never throws", () => {
  const audio = run({ protocol: "tts", stream: false, contentType: "audio/wav", status: 200 }, [
    { text: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff]), tMs: 1 },
  ]);
  assert.equal(audio.bytes, 6);
  assert.equal(audio.usage.source, "missing");
  const mcp = run({ protocol: "mcp", stream: true, contentType: "text/event-stream", status: 200 }, [
    { text: ev({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "tool output" }] } }), tMs: 1 },
  ]);
  assert.equal(mcp.usage.source, "missing");
  assert.equal(mcp.firstTokenAt, null);

  const sniffer = createResponseSniffer({ protocol: "openai", stream: true, contentType: "text/event-stream" });
  assert.doesNotThrow(() => {
    sniffer.push(undefined);
    sniffer.push(null);
    sniffer.push("data: {not json}\n\n");
    sniffer.push(Buffer.from([0xc3]));
    sniffer.push(Buffer.from([0xa9, 0x0a, 0x0a]));
    sniffer.push(new ArrayBuffer(4));
  });
  const first = sniffer.finish();
  sniffer.push(ev({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  assert.deepEqual(sniffer.finish(), first, "pushes after finish are ignored");
});
