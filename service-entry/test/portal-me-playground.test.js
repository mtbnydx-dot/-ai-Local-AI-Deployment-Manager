"use strict";

// PUB-17: the pure modules behind My Key and the playground
// (service-entry/portal/lib/{sse,playground,me-view}.js, api.js additions).
// They have no DOM dependency; fetch and the clock are replaced here. The
// pages themselves are covered by tests/public-portal.spec.cjs.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const LIB = path.join(__dirname, "..", "portal", "lib");
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href);

function streamOf(parts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      controller.close();
    },
  });
}

function collect() {
  const events = [];
  return { events, push: (event) => events.push(event) };
}

// ---- sse.js ---------------------------------------------------------------------

test("sse: events split on LF, CRLF and CR, with comments, names, ids and multi-line data", async () => {
  const { createSseParser } = await load("sse.js");
  const text = ": keep-alive\ndata: one\n\nevent: delta\nid: 7\ndata: a\ndata: b\n\r\ndata:two\r\r\ndata\n\n";
  const got = collect();
  const parser = createSseParser(got.push);
  parser.push(text);
  parser.end();
  assert.deepEqual(got.events, [
    { event: "message", data: "one", id: "" },
    { event: "delta", data: "a\nb", id: "7" },
    { event: "message", data: "two", id: "7" },
    { event: "message", data: "", id: "7" },
  ]);
});

test("sse: the result does not depend on where the chunks are cut", async () => {
  const { createSseParser } = await load("sse.js");
  const text = "\ufeffdata: {\"a\":1}\r\n\r\nevent: x\r\ndata: {\"b\":\"é\"}\r\n\r\ndata: [DONE]\r\n\r\n";
  const whole = collect();
  const one = createSseParser(whole.push);
  one.push(text);
  one.end();
  assert.equal(whole.events.length, 3);
  assert.equal(whole.events[0].data, "{\"a\":1}");
  for (let size = 1; size <= 7; size += 1) {
    const got = collect();
    const parser = createSseParser(got.push);
    for (let at = 0; at < text.length; at += size) parser.push(text.slice(at, at + size));
    parser.end();
    assert.deepEqual(got.events, whole.events, `chunks of ${size}`);
  }
});

test("sse: an event without its closing blank line is delivered at the end of the stream", async () => {
  const { createSseParser } = await load("sse.js");
  const got = collect();
  const parser = createSseParser(got.push);
  parser.push("data: last");
  assert.equal(got.events.length, 0);
  parser.end();
  assert.deepEqual(got.events, [{ event: "message", data: "last", id: "" }]);
});

test("sse: readSseStream decodes UTF-8 split inside a character and reports every event", async () => {
  const { readSseStream } = await load("sse.js");
  const bytes = new TextEncoder().encode("data: 你好\n\ndata: [DONE]\n\n");
  const cut = bytes.indexOf(0xe4) + 1; // inside the first Han character
  const got = collect();
  await readSseStream(streamOf([bytes.slice(0, cut), bytes.slice(cut)]), got.push);
  assert.deepEqual(got.events.map((event) => event.data), ["你好", "[DONE]"]);
});

test("sse: an abort stops the read, rejects with an AbortError and keeps what was delivered", async () => {
  const { readSseStream } = await load("sse.js");
  const encoder = new TextEncoder();
  let release;
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("data: first\n\n"));
      await new Promise((resolve) => { release = resolve; });
    },
    cancel() {
      release?.();
    },
  });
  const controller = new AbortController();
  const got = collect();
  const reading = readSseStream(body, (event) => {
    got.push(event);
    controller.abort();
  }, { signal: controller.signal });
  await assert.rejects(reading, (error) => error.name === "AbortError");
  assert.deepEqual(got.events.map((event) => event.data), ["first"]);
});

test("sse: a response without a body is refused", async () => {
  const { readSseStream } = await load("sse.js");
  await assert.rejects(readSseStream(null, () => {}), TypeError);
});

// ---- playground.js ----------------------------------------------------------------

const MODELS_DOC = {
  object: "list",
  data: [
    {
      id: "chat-a", display_name: "Chat A", aliases: ["a"], state: "ready", max_output_tokens: 4096, context_length: 8192,
      capabilities: { chat: true, vision: true, embeddings: false, audio_speech: false },
      controls: { reasoning_toggle: { on: { chat_template_kwargs: { enable_thinking: true } }, off: { chat_template_kwargs: { enable_thinking: false } } } },
      pricing: { unit: "credits_per_million_tokens", input: "0.25", cached_input: "0.02", output: "1.00" },
    },
    { id: "chat-b", capabilities: { chat: true }, limits: { max_output_tokens: 2048 } },
    { id: "embed", capabilities: { chat: false, embeddings: true } },
    { id: "voice", capabilities: { audio_speech: true } },
    { id: "", capabilities: { chat: true } },
    null,
  ],
};

test("playground: the model list keeps chat models only, with caps, prices and the reasoning patch", async () => {
  const p = await load("playground.js");
  const models = p.readPlaygroundModels(MODELS_DOC);
  assert.deepEqual(models.map((model) => model.id), ["chat-a", "chat-b"]);
  assert.equal(models[0].name, "Chat A");
  assert.equal(models[0].maxOutput, 4096);
  assert.deepEqual(models[0].pricing, { unit: "credits_per_million_tokens", input: "0.25", cachedInput: "0.02", output: "1.00" });
  assert.deepEqual(models[0].reasoningToggle.off, { chat_template_kwargs: { enable_thinking: false } });
  assert.equal(models[1].reasoningToggle, null);
  assert.equal(models[1].maxOutput, 2048);
  assert.equal(models[1].name, "chat-b");
  assert.deepEqual(p.readPlaygroundModels({}), []);
  assert.equal(p.pickModel(models, "A").id, "chat-a");
  assert.equal(p.pickModel(models, "CHAT-B").id, "chat-b");
  assert.equal(p.pickModel(models, "nothing").id, "chat-a");
  assert.equal(p.pickModel([], "x"), null);
  assert.equal(p.maxTokensCap(models[1]), 2048);
  assert.equal(p.maxTokensCap(null), 8192);
});

test("playground: numbers are clamped into their range and bad text falls back", async () => {
  const p = await load("playground.js");
  assert.equal(p.clampNumber("5", 0, 2, 0.7), 2);
  assert.equal(p.clampNumber("-1", 0, 2, 0.7), 0);
  assert.equal(p.clampNumber("0.3", 0, 2, 0.7), 0.3);
  for (const bad of ["", "abc", null, undefined]) assert.equal(p.clampNumber(bad, 0, 2, 0.7), 0.7);
});

test("playground: the request has the stream flags, the system prompt first and the reasoning patch merged", async () => {
  const p = await load("playground.js");
  const [model] = p.readPlaygroundModels(MODELS_DOC);
  const settings = { model: "chat-a", system: "  be brief  ", messages: [{ role: "user", content: "hi" }], temperature: 0.2, topP: 0.9, maxTokens: 64, reasoning: "off" };
  const request = p.buildChatRequest(settings, model);
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/chat/completions");
  assert.deepEqual(request.headers, { "content-type": "application/json", accept: "text/event-stream" });
  assert.deepEqual(request.body, {
    model: "chat-a",
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
    stream: true, stream_options: { include_usage: true }, temperature: 0.2, top_p: 0.9, max_tokens: 64,
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.equal(p.buildChatRequest({ ...settings, reasoning: "on" }, model).body.chat_template_kwargs.enable_thinking, true);
  assert.equal("chat_template_kwargs" in p.buildChatRequest({ ...settings, reasoning: "default" }, model).body, false);
  // A model without the toggle never gets the patch, whatever the form says.
  assert.equal("chat_template_kwargs" in p.buildChatRequest({ ...settings, reasoning: "on" }, { reasoningToggle: null }).body, false);
  assert.equal(p.buildChatRequest({ ...settings, system: "  " }, model).body.messages[0].role, "user");
});

function parseCurl(code) {
  const lines = code.split("\n");
  const url = /^curl -N "([^"]+)" \\$/.exec(lines[0])[1];
  const headers = {};
  for (const line of lines.slice(1)) {
    const match = /^ {2}-H "([^:]+): (.*)" \\$/.exec(line);
    if (match) headers[match[1].toLowerCase()] = match[2];
  }
  const start = code.indexOf("-d '") + 4;
  return { url, headers, body: JSON.parse(code.slice(start, code.lastIndexOf("'")).replace(/'\\''/g, "'")) };
}

test("playground: the curl command round-trips to the request and holds the key only when asked", async () => {
  const p = await load("playground.js");
  const request = p.buildChatRequest({
    model: "m", system: "It's \"odd\" $(x) `y`", messages: [{ role: "user", content: "a'b\nc" }], temperature: 1, topP: 1, maxTokens: 10, reasoning: "default",
  }, null);
  const plain = p.renderCurl(request, { baseUrl: "https://api.example.com/v1/", key: "sk-test-fake0001", includeKey: false });
  const parsed = parseCurl(plain);
  assert.equal(parsed.url, "https://api.example.com/v1/chat/completions");
  assert.deepEqual(parsed.body, request.body);
  assert.deepEqual(parsed.headers, { authorization: "Bearer $API_KEY", "content-type": "application/json", accept: "text/event-stream" });
  assert.equal(plain.includes("sk-test-fake0001"), false);
  const keyed = p.renderCurl(request, { baseUrl: "https://api.example.com/v1", key: "sk-test-fake0001", includeKey: true });
  assert.equal(parseCurl(keyed).headers.authorization, "Bearer sk-test-fake0001");
  assert.deepEqual(parseCurl(keyed).body, request.body);
  // A key with characters that could break out of the quotes is never written into the command.
  for (const bad of ["sk\" ; rm -rf /", "sk-$(id)", "sk-`id`", "sk space", ""]) {
    const text = p.renderCurl(request, { baseUrl: "https://x/v1", key: bad, includeKey: true });
    assert.equal(parseCurl(text).headers.authorization, "Bearer $API_KEY", bad);
    assert.equal(p.keyIsInsertable(bad), false, bad);
  }
});

test("playground: Python and Node samples carry the same fields and read the key from the environment", async () => {
  const p = await load("playground.js");
  const [model] = p.readPlaygroundModels(MODELS_DOC);
  const request = p.buildChatRequest({ model: "chat-a", system: "", messages: [{ role: "user", content: "hi \"there\"" }], temperature: 0.5, topP: 1, maxTokens: 32, reasoning: "off" }, model);
  const python = p.renderPython(request, { baseUrl: "https://api.example.com/v1", key: "sk-test-fake0001" });
  assert.match(python, /api_key=os\.environ\["API_KEY"\]/);
  assert.match(python, /base_url="https:\/\/api\.example\.com\/v1"/);
  assert.match(python, /model="chat-a"/);
  assert.match(python, /stream=True,/);
  assert.match(python, /"include_usage": True/);
  assert.match(python, /extra_body=\{[\s\S]*"enable_thinking": False/);
  assert.equal(python.includes("sk-test-fake0001"), false);
  assert.match(p.renderPython(request, { baseUrl: "https://x/v1", key: "sk-test-fake0001", includeKey: true }), /api_key="sk-test-fake0001"/);
  const node = p.renderNode(request, { baseUrl: "https://api.example.com/v1", key: "sk-test-fake0001" });
  assert.match(node, /apiKey: process\.env\.API_KEY/);
  assert.deepEqual(JSON.parse(/create\(([\s\S]*)\);\nfor await/.exec(node)[1]), request.body);
  assert.equal(node.includes("sk-test-fake0001"), false);
  assert.match(p.renderNode(request, { baseUrl: "https://x/v1", key: "sk-test-fake0001", includeKey: true }), /apiKey: "sk-test-fake0001"/);
  assert.deepEqual(Object.keys(p.SNIPPET_RENDERERS), ["curl", "python", "node"]);
});

test("playground: cost is price x usage, with cached input at the cached price", async () => {
  const p = await load("playground.js");
  const pricing = { unit: "credits_per_million_tokens", input: "0.25", cachedInput: "0.02", output: "1.00" };
  assert.equal(p.computeCost(pricing, { inputTokens: 1000, cachedTokens: 500, outputTokens: 200 }), (500 * 0.25 + 500 * 0.02 + 200) / 1e6);
  assert.equal(p.formatCredits(p.computeCost(pricing, { inputTokens: 1000, cachedTokens: 500, outputTokens: 200 })), "0.000335");
  // Without a cached price the cached tokens cost the input price; more cached than input is capped.
  assert.equal(p.computeCost({ ...pricing, cachedInput: null }, { inputTokens: 1000, cachedTokens: 300, outputTokens: 0 }), 1000 * 0.25 / 1e6);
  assert.equal(p.computeCost(pricing, { inputTokens: 10, cachedTokens: 99, outputTokens: 0 }), 10 * 0.02 / 1e6);
  assert.equal(p.computeCost(null, { inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(p.computeCost({ ...pricing, unit: "per_image" }, { inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(p.computeCost({ unit: "credits_per_million_tokens", input: "1", cachedInput: null, output: null }, { inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(p.computeCost(pricing, null), null);
  assert.equal(p.formatCredits(0), "0");
  assert.equal(p.formatCredits(1.5), "1.5");
  assert.equal(p.formatCredits(0.0000004), "<0.000001");
  assert.equal(p.formatCredits(-0.5), "-0.5");
  assert.equal(p.formatCredits("12.500000"), "12.5");
  assert.equal(p.formatCredits("nope"), "");
});

function sseResponse(parts, { status = 200, type = "text/event-stream" } = {}) {
  return new Response(streamOf(parts), { status, headers: { "content-type": type } });
}

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;

function clock(step) {
  let at = 0;
  return () => {
    at += step.shift() ?? 0;
    return at;
  };
}

test("playground: runChat streams the pieces and measures TTFT, tokens per second and usage", async () => {
  const p = await load("playground.js");
  const request = p.buildChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 1, topP: 1, maxTokens: 8, reasoning: "default" }, null);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return sseResponse([
      chunk({ role: "assistant", content: "" }),
      chunk({ reasoning_content: "think " }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  };
  const pieces = [];
  // Clock: start 0, first token at 200 ms, end at 700 ms.
  const result = await p.runChat({ request, key: "sk-test-fake0001", fetchImpl, now: clock([0, 200, 500]), onDelta: (delta) => pieces.push(delta) });
  assert.equal(calls[0].url, "/v1/chat/completions");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test-fake0001");
  assert.equal(calls[0].init.headers.accept, "text/event-stream");
  assert.deepEqual(JSON.parse(calls[0].init.body), request.body);
  assert.deepEqual(pieces, [{ content: "", reasoning: "think " }, { content: "Hel", reasoning: "" }, { content: "lo", reasoning: "" }]);
  assert.deepEqual(result, {
    stopped: false, finishReason: "stop", ttftMs: 200, durationMs: 700, inputTokens: 100, cachedTokens: 40, outputTokens: 50, estimated: false, tokensPerSecond: 100,
  });
});

test("playground: without a usage chunk the output tokens are an estimate and flagged so", async () => {
  const p = await load("playground.js");
  const request = p.buildChatRequest({ model: "m", messages: [], temperature: 1, topP: 1, maxTokens: 8 }, null);
  const result = await p.runChat({
    request, key: "k", now: clock([0, 100, 400]),
    fetchImpl: async () => sseResponse([chunk({ content: "a" }), chunk({ content: "b" }), chunk({ content: "c" }), "data: [DONE]\n\n"]),
  });
  assert.equal(result.estimated, true);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.inputTokens, null);
  assert.equal(result.tokensPerSecond, 7.5);
});

test("playground: a server that ignores stream:true and answers one JSON document still works", async () => {
  const p = await load("playground.js");
  const request = p.buildChatRequest({ model: "m", messages: [], temperature: 1, topP: 1, maxTokens: 8 }, null);
  const body = { choices: [{ message: { content: "whole answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  const pieces = [];
  const result = await p.runChat({
    request, key: "k", now: clock([0, 10, 100]), onDelta: (delta) => pieces.push(delta.content),
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(pieces, ["whole answer"]);
  assert.equal(result.outputTokens, 2);
  assert.equal(result.estimated, false);
});

test("playground: Stop resolves with the partial metrics and aborts the fetch", async () => {
  const p = await load("playground.js");
  const request = p.buildChatRequest({ model: "m", messages: [], temperature: 1, topP: 1, maxTokens: 8 }, null);
  const controller = new AbortController();
  let aborted = false;
  const fetchImpl = async (url, init) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
    });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(chunk({ content: "partial" })));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const pieces = [];
  const result = await p.runChat({
    request, key: "k", signal: controller.signal, fetchImpl, now: clock([0, 30, 90]),
    onDelta: (delta) => {
      pieces.push(delta.content);
      controller.abort();
    },
  });
  assert.deepEqual(pieces, ["partial"]);
  assert.equal(aborted, true);
  assert.equal(result.stopped, true);
  assert.equal(result.estimated, true);
  assert.equal(result.outputTokens, 1);
  assert.equal(result.ttftMs, 30);
  // Aborted before anything arrived: no first token, no speed.
  const early = new AbortController();
  early.abort();
  const none = await p.runChat({ request, key: "k", signal: early.signal, now: clock([0, 5]), fetchImpl: async (url, init) => { init.signal.throwIfAborted(); return sseResponse([]); } });
  assert.equal(none.stopped, true);
  assert.equal(none.ttftMs, null);
  assert.equal(none.tokensPerSecond, null);
});

test("playground: HTTP errors, network errors and in-stream errors become ApiError with a code", async () => {
  const p = await load("playground.js");
  const { ApiError } = await load("api.js");
  const request = p.buildChatRequest({ model: "m", messages: [], temperature: 1, topP: 1, maxTokens: 8 }, null);
  const limited = async () => new Response(JSON.stringify({ error: { message: "slow", code: "rate_limit_exceeded" }, request_id: "req_1" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } });
  await assert.rejects(p.runChat({ request, key: "k", fetchImpl: limited }), (error) => error instanceof ApiError && error.status === 429 && error.code === "rate_limit_exceeded" && error.requestId === "req_1" && error.retryAfter === 7);
  await assert.rejects(p.runChat({ request, key: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); } }), (error) => error instanceof ApiError && error.code === "network_error");
  const failing = async () => sseResponse([chunk({ content: "x" }), `data: ${JSON.stringify({ error: { message: "boom", type: "server_error" } })}\n\n`]);
  await assert.rejects(p.runChat({ request, key: "k", fetchImpl: failing }), (error) => error instanceof ApiError && error.code === "server_error" && error.message === "boom");
});

// ---- me-view.js -------------------------------------------------------------------

test("me-view: scope keys, spans and the expiry countdown", async () => {
  const v = await load("me-view.js");
  assert.equal(v.scopeKey("audio.speech"), "me.scope.audio_speech");
  assert.equal(v.scopeKey("models.read"), "me.scope.models_read");
  assert.deepEqual(v.splitSpan(2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 999), { days: 2, hours: 3, minutes: 4 });
  assert.deepEqual(v.splitSpan(-5), { days: 0, hours: 0, minutes: 0 });
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(v.expiryView(null, now).state, "never");
  assert.equal(v.expiryView("garbage", now).state, "never");
  const soon = v.expiryView("2026-10-17T15:30:00Z", now);
  assert.deepEqual([soon.state, soon.days, soon.hours, soon.minutes, soon.urgent], ["active", 3, 3, 30, true]);
  const later = v.expiryView("2026-10-21T12:00:01Z", now);
  assert.equal(later.urgent, false); // 7 days and a second: not under 7 days
  assert.equal(v.expiryView("2026-10-21T11:59:59Z", now).urgent, true);
  assert.deepEqual([v.expiryView("2026-10-14T12:00:00Z", now).state, v.expiryView("2026-10-14T12:00:00Z", now).urgent], ["expired", true]);
  assert.equal(v.secondsUntil("2026-10-14T12:00:09Z", now), 9);
  assert.equal(v.secondsUntil("2026-10-14T11:00:00Z", now), 0);
  assert.equal(v.secondsUntil(null, now), null);
});

test("me-view: the quota pace uses the length of the day and of the month that ends at the reset", async () => {
  const v = await load("me-view.js");
  const quota = { limit: 1000, used: 250, remaining: 750, pace: "ok", projected_exhaustion_at: null };
  const day = v.paceView(quota, "2026-10-15T00:00:00+08:00", "day", Date.parse("2026-10-14T12:00:00+08:00"));
  assert.equal(day.elapsedFraction, 0.5);
  assert.equal(day.usedFraction, 0.25);
  assert.equal(day.pace, "ok");
  // October has 31 days; February 2027 has 28; November has 30 (read in UTC and at an offset).
  const october = v.paceView(quota, "2026-11-01T00:00:00+08:00", "month", Date.parse("2026-10-16T12:00:00+08:00"));
  assert.equal(october.elapsedFraction, 0.5);
  const february = v.paceView(quota, "2027-03-01T00:00:00-05:00", "month", Date.parse("2027-02-15T00:00:00-05:00"));
  assert.equal(february.elapsedFraction, 0.5);
  const november = v.paceView(quota, "2026-12-01T00:00:00Z", "month", Date.parse("2026-11-16T00:00:00Z"));
  assert.equal(november.elapsedFraction, 0.5);
  // Outside the period it is clamped; a quota with no cap has no bar.
  assert.equal(v.paceView(quota, "2026-10-15T00:00:00Z", "day", Date.parse("2026-10-20T00:00:00Z")).elapsedFraction, 1);
  assert.equal(v.paceView(null, "2026-10-15T00:00:00Z", "day", 0), null);
  assert.equal(v.paceView({ limit: 0 }, "2026-10-15T00:00:00Z", "day", 0), null);
  const ahead = v.paceView({ limit: 100, used: 400, remaining: 0, pace: "exhausted", projected_exhaustion_at: "2026-10-14T13:00:00Z" }, "bad date", "day", 0);
  assert.equal(ahead.usedFraction, 1);
  assert.equal(ahead.elapsedFraction, null);
  assert.equal(ahead.pace, "exhausted");
  assert.equal(ahead.exhaustAt, Date.parse("2026-10-14T13:00:00Z"));
  assert.equal(v.paceView({ limit: 100, used: 1, pace: "weird" }, null, "day", 0).pace, "ok");
});

test("me-view: formatClock shows a time today and a date and time otherwise", async () => {
  const v = await load("me-view.js");
  const now = new Date(2026, 9, 14, 9, 0, 0).getTime();
  assert.equal(v.formatClock(new Date(2026, 9, 14, 14, 20, 0).getTime(), now, "en-US"), "14:20");
  assert.equal(v.formatClock(new Date(2026, 9, 14, 14, 20, 0).getTime(), now, "zh-CN"), "14:20");
  assert.match(v.formatClock(new Date(2026, 9, 16, 2, 5, 0).getTime(), now, "en-US"), /Oct 16, 02:05/);
  assert.equal(v.formatClock("nope", now), "");
});

test("me-view: origins follow the server's rules", async () => {
  const v = await load("me-view.js");
  const ok = (text) => v.checkOrigin(text);
  assert.deepEqual(ok("https://App.Example.com"), { ok: true, origin: "https://app.example.com" });
  assert.deepEqual(ok(" https://app.example.com:8443/ "), { ok: true, origin: "https://app.example.com:8443" });
  assert.deepEqual(ok("http://localhost:3000"), { ok: true, origin: "http://localhost:3000" });
  assert.deepEqual(ok("http://127.0.0.1"), { ok: true, origin: "http://127.0.0.1" });
  const reasons = {
    "": "empty", "   ": "empty", "*": "wildcard", "https://*.example.com": "wildcard",
    "https://app.example.com/x": "path", "https://app.example.com?x=1": "path", "https://app.example.com#top": "path", "https://app.example.com/?": "path",
    "http://app.example.com": "scheme", "ftp://app.example.com": "scheme", "http://127.0.0.2": "scheme", "http://localhost.evil.example": "scheme",
    "app.example.com": "invalid", "https://user:pw@app.example.com": "invalid", "https://": "invalid",
  };
  for (const [text, reason] of Object.entries(reasons)) assert.deepEqual(ok(text), { ok: false, reason }, JSON.stringify(text));
  const first = v.addOrigin([], "https://a.example.com");
  assert.deepEqual(first, { ok: true, list: ["https://a.example.com"], origin: "https://a.example.com" });
  assert.deepEqual(v.addOrigin(first.list, "HTTPS://A.EXAMPLE.COM/"), { ok: false, reason: "duplicate" });
  const full = Array.from({ length: 10 }, (_, index) => `https://s${index}.example.com`);
  assert.deepEqual(v.addOrigin(full, "https://more.example.com"), { ok: false, reason: "limit" });
  assert.equal(v.MAX_ORIGINS, 10);
  // Every origin the editor accepts is one the server's own normalizer accepts unchanged.
  const keyPolicy = require("../lib/key-policy");
  for (const text of ["https://App.Example.com", "https://app.example.com:8443/", "http://localhost:3000", "http://127.0.0.1"]) {
    assert.equal(keyPolicy.normalizeOrigin(ok(text).origin), ok(text).origin);
    assert.equal(keyPolicy.normalizeOrigin(text), ok(text).origin);
  }
  // The server also refuses what the editor calls a path or an invalid origin (it still lets a
  // "*" inside a host through, which the editor refuses on top: see the deviations).
  for (const text of Object.keys(reasons).filter((item) => item.trim() && !item.includes("*") && !item.includes("localhost.evil") && !item.includes("127.0.0.2") && !item.startsWith("http://app") && !item.startsWith("ftp"))) {
    const server = keyPolicy.normalizeOrigin(text);
    assert.ok(server === "" || server === "*", `${text} → ${server}`);
  }
});

test("me-view: the token chart is stacked by model with gaps, the biggest models first and the rest folded", async () => {
  const v = await load("me-view.js");
  const day = (n) => `2026-10-${String(n).padStart(2, "0")}`;
  const rows = [
    { date: day(10), model: "small", input_tokens: 10, output_tokens: 5 },
    { date: day(10), model: "big", input_tokens: 1000, output_tokens: 500 },
    { date: day(12), model: "big", input_tokens: 2000, output_tokens: 0 },
  ];
  const chart = v.buildTokenChart(rows);
  assert.equal(chart.stacked, true);
  assert.equal(chart.empty, false);
  assert.deepEqual(chart.series.map((item) => item.model), ["big", "small"]);
  assert.equal(chart.x.length, 3);
  assert.equal(chart.x[1] - chart.x[0], 86_400);
  assert.deepEqual(chart.series[0].values, [1500, null, 2000]);
  // A day with rows counts as zero for a model that did not appear; a day without rows stays a gap.
  assert.deepEqual(chart.series[1].values, [15, null, 0]);

  const many = Array.from({ length: 10 }, (_, index) => ({ date: day(10), model: `m${index}`, input_tokens: 100 - index, output_tokens: 0 }));
  const folded = v.buildTokenChart(many);
  assert.equal(folded.series.length, v.MAX_MODEL_SERIES + 1);
  assert.equal(folded.series.at(-1).id, "other");
  assert.equal(folded.series.at(-1).values[0], 100 - 7 + 100 - 8 + 100 - 9);

  const totals = v.buildTokenChart([{ date: day(1), input_tokens: 5, output_tokens: 5 }, { date: day(3), input_tokens: 1, output_tokens: 1 }]);
  assert.equal(totals.stacked, false);
  assert.deepEqual(totals.series, [{ id: "total", model: null, values: [10, null, 2] }]);
  assert.equal(v.buildTokenChart([]).empty, true);
  assert.equal(v.buildTokenChart(null).x.length, 0);
  assert.equal(v.buildTokenChart([{ date: day(1), requests: 0, input_tokens: 0, output_tokens: 0 }]).empty, true);
  assert.deepEqual(v.buildTokenChart([{ date: "garbage", input_tokens: 1 }]).x, []);
});

test("me-view: requests and errors per day, model rows summed, and the table rows", async () => {
  const v = await load("me-view.js");
  const rows = [
    { date: "2026-10-10", model: "a", requests: 3, errors: 1 },
    { date: "2026-10-10", model: "b", requests: 2, errors: 0 },
    { date: "2026-10-12", requests: 4, errors: 4 },
  ];
  const chart = v.buildRequestChart(rows);
  assert.deepEqual(chart.series.map((item) => item.id), ["requests", "errors"]);
  assert.deepEqual(chart.series[0].values, [5, null, 4]);
  assert.deepEqual(chart.series[1].values, [1, null, 4]);
  assert.equal(chart.empty, false);
  assert.equal(v.buildRequestChart([{ date: "2026-10-10", requests: 0, errors: 0 }]).empty, true);
  const table = v.chartTableRows(chart, "en-US");
  assert.equal(table.length, 3);
  assert.match(table[0][0], /Oct 10, 2026/);
  assert.deepEqual(table[1].slice(1), [null, null]);
  assert.deepEqual(table[2].slice(1), [4, 4]);
});

// ---- api.js additions ----------------------------------------------------------------

test("api: the My Key calls send the key in the Authorization header only, never in a URL", async (t) => {
  const api = await load("api.js");
  const calls = [];
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("usage.csv")) return new Response("\ufeffdate\r\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=\"usage-2026-10-01_2026-10-30.csv\"" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const key = "sk-test-fake0001";
  await api.getMe(key);
  await api.getMeUsage(key);
  await api.getMeUsage(key, { groupByModel: false });
  await api.getMeRequests(key, 500);
  await api.rotateOwnKey(key);
  await api.saveOwnOrigins(key, ["https://a.example.com"]);
  const csv = await api.fetchUsageCsv(key);
  assert.deepEqual(calls.map((call) => call.url), [
    "/v1/me", "/v1/me/usage?group_by=day,model", "/v1/me/usage?group_by=day", "/v1/me/requests?limit=100", "/v1/me/rotate", "/v1/me/origins", "/v1/me/usage.csv",
  ]);
  for (const call of calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${key}`);
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.url.includes(key), false);
  }
  assert.equal(calls[4].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[4].init.body), { confirm: true });
  assert.equal(calls[5].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[5].init.body), { origins: ["https://a.example.com"] });
  assert.equal(csv.filename, "usage-2026-10-01_2026-10-30.csv");
  assert.equal((await csv.blob.text()).includes("date"), true);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "scope_denied", message: "no" }, request_id: "req_9" }), { status: 403, headers: { "content-type": "application/json" } });
  await assert.rejects(api.fetchUsageCsv(key), (error) => error.status === 403 && error.code === "scope_denied" && error.requestId === "req_9");
});
