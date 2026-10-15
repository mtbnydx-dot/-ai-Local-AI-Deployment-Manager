"use strict";

// The usage tap (05 §8.6, PUB-11): usage from OpenAI SSE, Anthropic SSE and
// JSON; the bytes are never altered; an abort keeps the partial counts.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PassThrough, Readable, Writable, pipeline } = require("node:stream");
const test = require("node:test");

const { MAX_JSON_BYTES, createUsageTap } = require("../lib/usage-tap");

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const sse = (data, event = "") => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

// Runs `chunks` through the tap into a sink; resolves with the sink's bytes and the tap result.
async function run(options, chunks) {
  const tap = createUsageTap(options);
  const received = [];
  const sink = new Writable({ write(chunk, _enc, cb) { received.push(Buffer.from(chunk)); cb(); } });
  await new Promise((resolve, reject) => {
    pipeline(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), tap.transform, sink, (error) => (error ? reject(error) : resolve()));
  });
  return { bytes: Buffer.concat(received), result: await tap.result };
}

const OPENAI_STREAM = [
  sse({ choices: [{ delta: { content: "hel" } }] }),
  sse({ choices: [{ delta: { content: "lo" } }] }),
  sse({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38, prompt_tokens_details: { cached_tokens: 12 } } }),
  sse("[DONE]"),
];

test("OpenAI SSE: reported usage, cached tokens, bytes identical (hash equality)", async () => {
  const input = OPENAI_STREAM.join("");
  // Split mid-event so the parser has to join chunks.
  const chunks = [input.slice(0, 25), input.slice(25, 140), input.slice(140)];
  const { bytes, result } = await run({ protocol: "openai", stream: true, estimatedInputTokens: 5 }, chunks);
  assert.equal(sha(bytes), sha(Buffer.from(input)));
  assert.deepEqual(result, { inputTokens: 30, cachedInputTokens: 12, outputTokens: 8, source: "upstream", terminal: "completed" });
});

test("OpenAI SSE without a usage chunk falls back to an estimate", async () => {
  const { result } = await run({ protocol: "openai", stream: true, estimatedInputTokens: 9 }, [OPENAI_STREAM[0], OPENAI_STREAM[1], OPENAI_STREAM[3]]);
  assert.equal(result.source, "estimate");
  assert.equal(result.inputTokens, 9);
  assert.ok(result.outputTokens > 0);
});

test("Anthropic SSE: input from message_start, output from message_delta, cache reads counted", async () => {
  const events = [
    sse({ type: "message_start", message: { usage: { input_tokens: 40, cache_read_input_tokens: 16, output_tokens: 1 } } }, "message_start"),
    sse({ type: "content_block_delta", delta: { type: "text_delta", text: "abcd" } }, "content_block_delta"),
    sse({ type: "message_delta", usage: { output_tokens: 25 } }, "message_delta"),
    sse({ type: "message_stop" }, "message_stop"),
  ].join("").replace(/\n/g, "\r\n");
  const { bytes, result } = await run({ protocol: "anthropic", stream: true }, [events.slice(0, 77), events.slice(77)]);
  assert.equal(sha(bytes), sha(Buffer.from(events)), "CRLF framing passes through unchanged");
  assert.deepEqual(result, { inputTokens: 40, cachedInputTokens: 16, outputTokens: 25, source: "upstream", terminal: "completed" });
});

test("non-stream JSON, OpenAI and Anthropic shapes", async () => {
  const openai = JSON.stringify({ id: "x", usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  const a = await run({ protocol: "openai", stream: false }, [openai]);
  assert.deepEqual(a.result, { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, source: "upstream", terminal: "completed" });
  assert.equal(a.bytes.toString(), openai);

  const claude = JSON.stringify({ type: "message", usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 5 } });
  const b = await run({ protocol: "anthropic", stream: false }, [claude.slice(0, 20), claude.slice(20)]);
  assert.deepEqual(b.result, { inputTokens: 11, cachedInputTokens: 5, outputTokens: 4, source: "upstream", terminal: "completed" });
});

test("a body without usage, an oversized body or garbage gives source none and still passes through", async () => {
  const empty = await run({ protocol: "openai", stream: false }, [JSON.stringify({ ok: true })]);
  assert.equal(empty.result.source, "none");
  const garbage = await run({ protocol: "openai", stream: false }, ["not json"]);
  assert.equal(garbage.result.source, "none");
  assert.equal(garbage.bytes.toString(), "not json");
  const big = Buffer.alloc(MAX_JSON_BYTES + 10, 0x20);
  const tail = JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const oversized = await run({ protocol: "openai", stream: false }, [big, tail]);
  assert.equal(oversized.result.source, "none", "past the 4 MB bound nothing is parsed");
  assert.equal(oversized.bytes.length, big.length + tail.length);
});

test("a stream request answered with JSON (an error) is read as JSON, and a 4xx ends as upstream_error", async () => {
  const body = JSON.stringify({ error: { message: "bad" }, usage: { prompt_tokens: 3, completion_tokens: 0 } });
  const { result } = await run({ protocol: "openai", stream: true, contentType: "application/json", status: 400 }, [body]);
  assert.equal(result.source, "upstream");
  assert.equal(result.inputTokens, 3);
  assert.equal(result.terminal, "upstream_error");
});

test("an abort keeps the partial counts and ends as client_abort", async () => {
  const tap = createUsageTap({ protocol: "anthropic", stream: true });
  const source = new PassThrough();
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const done = new Promise((resolve) => pipeline(source, tap.transform, sink, () => resolve()));
  source.write(sse({ type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 1 } } }, "message_start"));
  source.write(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(40) } }, "content_block_delta"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The client leaves: the sink is destroyed, the pipeline tears the tap down.
  sink.destroy();
  await done;
  const result = await tap.result;
  assert.equal(result.terminal, "client_abort");
  assert.equal(result.inputTokens, 50);
  assert.equal(result.outputTokens, 10, "the streamed text is estimated when message_delta never came");
  assert.equal(result.source, "estimate");
});

test("an OpenAI abort after the usage chunk keeps the reported counts; a timeout is reported as such", async () => {
  const tap = createUsageTap({ protocol: "openai", stream: true, abortReason: () => "timeout" });
  const source = new PassThrough();
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const done = new Promise((resolve) => pipeline(source, tap.transform, sink, () => resolve()));
  source.write(OPENAI_STREAM[2]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  source.destroy(new Error("terminated"));
  await done;
  const result = await tap.result;
  assert.deepEqual([result.inputTokens, result.outputTokens, result.source, result.terminal], [30, 8, "upstream", "timeout"]);
});

test("an upstream failure mid-stream is upstream_error, and the result settles once", async () => {
  const tap = createUsageTap({ protocol: "openai", stream: true });
  const source = new PassThrough();
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const done = new Promise((resolve) => pipeline(source, tap.transform, sink, () => resolve()));
  source.write(OPENAI_STREAM[0]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failure = new Error("socket hang up");
  failure.code = "UND_ERR_SOCKET";
  source.destroy(failure);
  await done;
  assert.equal((await tap.result).terminal, "upstream_error");
});
