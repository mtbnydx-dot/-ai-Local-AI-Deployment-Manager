"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const gateway = require("../gateway-utils");

function makeResponse() {
  const emitter = new EventEmitter();
  const state = {
    statusCode: 200,
    headers: {},
    json: null,
    sent: "",
    chunks: [],
  };
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    status(code) {
      state.statusCode = code;
      this.statusCode = code;
      return this;
    },
    json(value) {
      state.json = value;
      this.headersSent = true;
      return value;
    },
    type(value) {
      state.headers["content-type"] = value;
      return this;
    },
    send(value) {
      state.sent = value;
      this.headersSent = true;
      return value;
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    write(chunk) {
      state.chunks.push(Buffer.from(chunk));
      this.headersSent = true;
      return true;
    },
    end() {
      this.writableEnded = true;
      this.headersSent = true;
      return this;
    },
    once(name, listener) {
      emitter.once(name, listener);
      return this;
    },
    off(name, listener) {
      emitter.off(name, listener);
      return this;
    },
    emit(name, ...args) {
      return emitter.emit(name, ...args);
    },
  };
  return { res, state };
}

function runtime() {
  return {
    container: { running: true },
    endpoint: { port: 8000 },
    servedModels: [{ id: "actual-model" }],
  };
}

function createHandlers(fetchFn, usageEvents, extraOptions = {}) {
  return gateway.createOpenAiGatewayHandlers({
    aliases: ["local-current"],
    getRunningModelSummary: async () => runtime(),
    getUpstreamHeaders: (_runtime, headers = {}) => ({ ...headers, authorization: "Bearer local" }),
    serviceClientAllowsModel: () => true,
    recordUsage: async (clientId, event) => usageEvents.push({ clientId, event }),
    setAccessUsage: (req, usage) => { req.accessUsage = usage; },
    isExpectedStreamDisconnect: gateway.isExpectedStreamDisconnect,
    fetchFn,
    ...extraOptions,
  });
}

function responseHeaders(contentType) {
  return {
    get(name) {
      return String(name).toLowerCase() === "content-type" ? contentType : "";
    },
  };
}

test("OpenAI usage normalization unifies chat, Responses, cached, zero, and missing values", () => {
  const normalized = gateway.normalizeOpenAiUsage({
    input_tokens: 12,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 4 },
  });
  assert.equal(normalized.usageSource, "reported");
  assert.equal(normalized.inputTokens, 12);
  assert.equal(normalized.outputTokens, 5);
  assert.equal(normalized.totalTokens, 17);
  assert.equal(normalized.cachedTokens, 4);
  assert.equal(normalized.usage.prompt_tokens, 12);
  assert.equal(normalized.usage.completion_tokens, 5);
  assert.equal(normalized.usage.cached_tokens, 4);

  const zeros = gateway.normalizeOpenAiUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(zeros.usageSource, "reported");
  assert.equal(zeros.totalTokens, 0);

  const missing = gateway.normalizeOpenAiUsage({ prompt_tokens: null, completion_tokens: "" });
  assert.equal(missing.usageSource, "missing");
  assert.equal(missing.usage, null);
});

test("non-stream OpenAI proxy propagates requestId and records normalized usage once", async () => {
  const usageEvents = [];
  const fetchCalls = [];
  const handlers = createHandlers(async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: responseHeaders("application/json"),
      text: async () => JSON.stringify({
        id: "resp-1",
        usage: {
          input_tokens: 13,
          output_tokens: 6,
          total_tokens: 19,
          input_tokens_details: { cached_tokens: 3 },
        },
      }),
    };
  }, usageEvents);
  const request = {
    headers: { "x-request-id": "client-request-1" },
    body: {
      model: "local-current",
      stream: false,
      stream_options: { include_usage: false, preserve: "yes" },
    },
    serviceGateway: { clientId: "client-1", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleResponses(request, response.res);

  assert.equal(response.state.statusCode, 200);
  assert.equal(response.state.headers["x-request-id"], "client-request-1");
  assert.equal(request.serviceGateway.requestId, "client-request-1");
  assert.equal(fetchCalls[0].options.headers["x-request-id"], "client-request-1");
  const upstreamBody = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(upstreamBody.stream_options, { include_usage: false, preserve: "yes" });
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].clientId, "client-1");
  assert.deepEqual({
    requestId: usageEvents[0].event.requestId,
    usageSource: usageEvents[0].event.usageSource,
    stream: usageEvents[0].event.stream,
    terminalState: usageEvents[0].event.terminalState,
    promptTokens: usageEvents[0].event.promptTokens,
    generationTokens: usageEvents[0].event.generationTokens,
    totalTokens: usageEvents[0].event.totalTokens,
    cachedTokens: usageEvents[0].event.cachedTokens,
  }, {
    requestId: "client-request-1",
    usageSource: "reported",
    stream: false,
    terminalState: "completed",
    promptTokens: 13,
    generationTokens: 6,
    totalTokens: 19,
    cachedTokens: 3,
  });
  assert.deepEqual(request.accessUsage, { resolvedModel: "actual-model", inputTokens: 13, outputTokens: 6 });
});

test("streaming OpenAI proxy preserves SSE bytes while parsing split final usage", async () => {
  const usageEvents = [];
  const fetchCalls = [];
  const wire = Buffer.from([
    ": keepalive\r\n\r\n",
    "data: {\"id\":\"chunk-1\",\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\r\n\r\n",
    "event: response.completed\r\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":21,\"output_tokens\":8,\"total_tokens\":29,\"input_tokens_details\":{\"cached_tokens\":7}}}}\r\n\r\n",
    "data: [DONE]\r\n\r\n",
  ].join(""), "utf8");
  const cutPoints = [1, 8, 31, 64, 65, 93, 127, 181, wire.length - 3, wire.length];
  const handlers = createHandlers(async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: responseHeaders("text/event-stream; charset=utf-8"),
      body: {
        async *[Symbol.asyncIterator]() {
          let start = 0;
          for (const end of cutPoints) {
            if (end > start) yield wire.subarray(start, end);
            start = end;
          }
        },
      },
    };
  }, usageEvents);
  const request = {
    headers: {},
    body: {
      model: "local-current",
      stream: true,
      stream_options: { include_usage: false, preserve: "yes" },
    },
    serviceGateway: { clientId: "client-stream", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleChatCompletions(request, response.res);

  assert.deepEqual(Buffer.concat(response.state.chunks), wire);
  const requestId = request.serviceGateway.requestId;
  assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(response.state.headers["x-request-id"], requestId);
  assert.equal(fetchCalls[0].options.headers["x-request-id"], requestId);
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body).stream_options, {
    include_usage: true,
    preserve: "yes",
  });
  assert.equal(usageEvents.length, 1);
  assert.deepEqual({
    requestId: usageEvents[0].event.requestId,
    usageSource: usageEvents[0].event.usageSource,
    stream: usageEvents[0].event.stream,
    terminalState: usageEvents[0].event.terminalState,
    promptTokens: usageEvents[0].event.promptTokens,
    generationTokens: usageEvents[0].event.generationTokens,
    totalTokens: usageEvents[0].event.totalTokens,
    cachedTokens: usageEvents[0].event.cachedTokens,
  }, {
    requestId,
    usageSource: "reported",
    stream: true,
    terminalState: "completed",
    promptTokens: 21,
    generationTokens: 8,
    totalTokens: 29,
    cachedTokens: 7,
  });
  assert.deepEqual(request.accessUsage, {
    resolvedModel: "actual-model",
    inputTokens: 21,
    outputTokens: 8,
    error: "",
  });
});

test("non-stream upstream failures record one missing-usage lifecycle event", async () => {
  const usageEvents = [];
  const handlers = createHandlers(async () => {
    throw new Error("connection refused");
  }, usageEvents);
  const request = {
    headers: {},
    body: { model: "local-current", stream: false },
    serviceGateway: { clientId: "client-failed", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleChatCompletions(request, response.res);

  assert.equal(response.state.statusCode, 500);
  assert.equal(response.state.json.error.code, "gateway_error");
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].event.requestId, request.serviceGateway.requestId);
  assert.equal(usageEvents[0].event.usageSource, "missing");
  assert.equal(usageEvents[0].event.stream, false);
  assert.equal(usageEvents[0].event.terminalState, "failed");
  assert.equal(usageEvents[0].event.status, 500);
  assert.equal(Object.hasOwn(usageEvents[0].event, "usage"), false);
  assert.equal(Object.hasOwn(usageEvents[0].event, "promptTokens"), false);
  assert.equal(Object.hasOwn(usageEvents[0].event, "generationTokens"), false);
  assert.equal(Object.hasOwn(usageEvents[0].event, "totalTokens"), false);
});

test("stream disconnect records one aborted lifecycle event without inventing zero tokens", async () => {
  const usageEvents = [];
  const settlements = [];
  const firstChunk = Buffer.from("data: {\"id\":\"chunk-before-abort\",\"choices\":[]}\n\n", "utf8");
  const handlers = createHandlers(async () => ({
    ok: true,
    status: 200,
    headers: responseHeaders("text/event-stream"),
    body: {
      async *[Symbol.asyncIterator]() {
        yield firstChunk;
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    },
  }), usageEvents, {
    authorizeBilling: async () => ({ ok: true, allowed: true, bound: true }),
    settleBilling: async (input) => {
      settlements.push(input);
      return { ok: true, settled: true };
    },
  });
  const request = {
    headers: {},
    body: { model: "local-current", stream: true },
    serviceGateway: { clientId: "client-aborted", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleChatCompletions(request, response.res);

  assert.deepEqual(Buffer.concat(response.state.chunks), firstChunk);
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].event.requestId, request.serviceGateway.requestId);
  assert.equal(usageEvents[0].event.usageSource, "missing");
  assert.equal(usageEvents[0].event.stream, true);
  assert.equal(usageEvents[0].event.terminalState, "aborted");
  assert.equal(usageEvents[0].event.status, 499);
  assert.equal(Object.hasOwn(usageEvents[0].event, "usage"), false);
  assert.equal(Object.hasOwn(usageEvents[0].event, "totalTokens"), false);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].usageSource, "missing");
  assert.equal(settlements[0].terminalState, "aborted");
  assert.equal(Object.hasOwn(settlements[0], "inputTokens"), false);
  assert.equal(Object.hasOwn(settlements[0], "outputTokens"), false);
  assert.equal(Object.hasOwn(settlements[0], "totalTokens"), false);
});

test("stream output followed by disconnect settles bounded estimated input and output usage", async () => {
  const usageEvents = [];
  const settlements = [];
  const contentChunk = Buffer.from(
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial private answer\"}}]}\n\n",
    "utf8",
  );
  const toolChunk = Buffer.from(
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"search\",\"arguments\":\"{\\\"query\\\":\\\"Brisbane\\\"}\"}}]}}]}\n\n",
    "utf8",
  );
  const wire = Buffer.concat([contentChunk, toolChunk]);
  const handlers = createHandlers(async () => ({
    ok: true,
    status: 200,
    headers: responseHeaders("text/event-stream"),
    body: {
      async *[Symbol.asyncIterator]() {
        yield contentChunk;
        yield toolChunk;
        const error = new Error("aborted after output");
        error.name = "AbortError";
        throw error;
      },
    },
  }), usageEvents, {
    authorizeBilling: async () => ({ ok: true, allowed: true, bound: true }),
    settleBilling: async (input) => {
      settlements.push(input);
      return { ok: true, settled: true };
    },
  });
  const request = {
    headers: {},
    body: {
      model: "local-current",
      messages: [{ role: "user", content: "private input must never be persisted" }],
      stream: true,
    },
    serviceGateway: { clientId: "client-estimated", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleChatCompletions(request, response.res);

  assert.deepEqual(Buffer.concat(response.state.chunks), wire);
  assert.equal(usageEvents.length, 1);
  const usage = usageEvents[0].event;
  assert.equal(usage.usageSource, "estimated");
  assert.equal(usage.terminalState, "aborted");
  assert.equal(usage.status, 499);
  assert.ok(usage.promptTokens > 0);
  assert.ok(usage.generationTokens > 0);
  assert.equal(usage.totalTokens, usage.promptTokens + usage.generationTokens);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].usageSource, "estimated");
  assert.equal(settlements[0].terminalState, "aborted");
  assert.equal(settlements[0].inputTokens, usage.promptTokens);
  assert.equal(settlements[0].outputTokens, usage.generationTokens);
  assert.equal(settlements[0].totalTokens, usage.totalTokens);
  const recordedMetadata = JSON.stringify({ usage, settlement: settlements[0] });
  assert.equal(recordedMetadata.includes("private input"), false);
  assert.equal(recordedMetadata.includes("partial private answer"), false);
  assert.equal(recordedMetadata.includes("Brisbane"), false);
});

test("bound billing authorizes before inference and settles the exact reported usage once", async () => {
  const usageEvents = [];
  const authorizations = [];
  const settlements = [];
  let upstreamCalls = 0;
  const handlers = createHandlers(async () => {
    upstreamCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: responseHeaders("application/json"),
      text: async () => JSON.stringify({
        usage: {
          prompt_tokens: 31,
          completion_tokens: 9,
          total_tokens: 40,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      }),
    };
  }, usageEvents, {
    authorizeBilling: async (input) => {
      authorizations.push(input);
      return { ok: true, allowed: true, bound: true, enforcementMode: "shadow" };
    },
    settleBilling: async (input) => {
      settlements.push(input);
      return { ok: true, settled: true };
    },
  });
  const request = {
    headers: { "x-request-id": "external-request-7" },
    body: {
      model: "local-current",
      messages: [{ role: "user", content: "请简短回答这个问题" }],
      max_tokens: 256,
      stream: false,
    },
    serviceGateway: { clientId: "paid-client", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleChatCompletions(request, response.res);

  assert.equal(upstreamCalls, 1);
  assert.equal(authorizations.length, 1);
  assert.match(authorizations[0].requestId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(authorizations[0].requestId, "external-request-7");
  assert.equal(authorizations[0].externalRequestId, "external-request-7");
  assert.equal(authorizations[0].clientId, "paid-client");
  assert.equal(authorizations[0].model, "actual-model");
  assert.equal(authorizations[0].maxOutputTokens, 256);
  assert.ok(authorizations[0].estimatedInputTokens > 0);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].requestId, authorizations[0].requestId);
  assert.equal(settlements[0].externalRequestId, "external-request-7");
  assert.equal(settlements[0].inputTokens, 31);
  assert.equal(settlements[0].outputTokens, 9);
  assert.equal(settlements[0].totalTokens, 40);
  assert.equal(settlements[0].cachedInputTokens, 5);
  assert.equal(settlements[0].usageSource, "reported");
  assert.equal(settlements[0].terminalState, "completed");
});

test("hard billing rejection stops inference and records a single quota failure without settling", async () => {
  const usageEvents = [];
  const settlements = [];
  let upstreamCalls = 0;
  const handlers = createHandlers(async () => {
    upstreamCalls += 1;
    throw new Error("must not reach upstream");
  }, usageEvents, {
    authorizeBilling: async () => ({
      ok: false,
      allowed: false,
      bound: true,
      code: "insufficient_quota",
    }),
    settleBilling: async (input) => {
      settlements.push(input);
      return { ok: true };
    },
  });
  const request = {
    headers: {},
    body: { model: "local-current", messages: [{ role: "user", content: "hello" }] },
    serviceGateway: { clientId: "quota-client", timeoutMs: 5000 },
  };
  const response = makeResponse();

  await handlers.handleChatCompletions(request, response.res);

  assert.equal(upstreamCalls, 0);
  assert.equal(response.state.statusCode, 429);
  assert.equal(response.state.json.error.code, "insufficient_quota");
  assert.equal(usageEvents.length, 1);
  assert.equal(usageEvents[0].event.status, 429);
  assert.equal(usageEvents[0].event.usageSource, "missing");
  assert.equal(settlements.length, 0);
});

test("streaming response ends before a slow billing settle", async () => {
  const usageEvents = [];
  let endedAt = 0;
  let settledAt = 0;
  const handlers = createHandlers(async () => ({
    ok: true,
    status: 200,
    headers: responseHeaders("text/event-stream"),
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("data: {\"choices\":[]}\n\n", "utf8");
      },
    },
  }), usageEvents, {
    authorizeBilling: async () => ({ ok: true, allowed: true, bound: true }),
    settleBilling: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      settledAt = Date.now();
      return { ok: true, settled: true };
    },
  });
  const request = {
    headers: {},
    body: { model: "local-current", stream: true, messages: [{ role: "user", content: "hi" }] },
    serviceGateway: { clientId: "settle-client", timeoutMs: 5000 },
  };
  const response = makeResponse();
  const originalEnd = response.res.end;
  response.res.end = function end() {
    endedAt = Date.now();
    return originalEnd.apply(this, arguments);
  };
  await handlers.handleChatCompletions(request, response.res);
  assert.ok(endedAt > 0);
  assert.ok(settledAt >= endedAt);
});

test("token estimate stays fast on a 1MB prompt and close to the previous heuristic", () => {
  const large = "你好世界".repeat(80_000);
  const body = { model: "local-current", messages: [{ role: "user", content: large }] };
  const started = Date.now();
  const estimated = gateway.estimateOpenAiRequestInputTokens(body);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5, `estimate took ${elapsed}ms`);
  assert.ok(estimated > 0);
  const bytes = Buffer.byteLength(large, "utf8");
  const coarse = Math.ceil((bytes / 4) * 1.1);
  assert.ok(Math.abs(estimated - coarse) / coarse <= 0.15);
});

test("shadow clients are allowed when billing authorize is unavailable", async () => {
  const usageEvents = [];
  let upstreamCalls = 0;
  const handlers = createHandlers(async () => {
    upstreamCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: responseHeaders("application/json"),
      text: async () => JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    };
  }, usageEvents, {
    billingColdStartGraceMs: 0,
    authorizeBilling: async () => ({ ok: false, allowed: false, code: "billing_unavailable", enforcementMode: "shadow" }),
    settleBilling: async () => ({ ok: true }),
  });
  const request = {
    headers: {},
    body: { model: "local-current", messages: [{ role: "user", content: "hello" }] },
    serviceGateway: { clientId: "shadow-client", timeoutMs: 5000 },
  };
  const response = makeResponse();
  await handlers.handleChatCompletions(request, response.res);
  assert.equal(upstreamCalls, 1);
  assert.equal(response.state.statusCode, 200);
});

test("deferred billing enqueue happens instead of settle", async () => {
  const usageEvents = [];
  const pending = [];
  const handlers = createHandlers(async () => ({
    ok: true,
    status: 200,
    headers: responseHeaders("application/json"),
    text: async () => JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  }), usageEvents, {
    billingColdStartGraceMs: 0,
    authorizeBilling: async () => ({ ok: false, allowed: false, code: "billing_unavailable", enforcementMode: "shadow" }),
    settleBilling: async () => {
      throw new Error("settle should not run for deferred authorize");
    },
    enqueuePendingBilling: (event) => pending.push(event),
  });
  const request = {
    headers: {},
    body: { model: "local-current", messages: [{ role: "user", content: "hello" }] },
    serviceGateway: { clientId: "shadow-client", timeoutMs: 5000 },
  };
  const response = makeResponse();
  await handlers.handleChatCompletions(request, response.res);
  assert.equal(response.state.statusCode, 200);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].authorizeInput.clientId, "shadow-client");
  assert.ok(pending[0].settleInput);
});

test("hard billing stays closed when authorize is unavailable after cold start", async () => {
  const usageEvents = [];
  let upstreamCalls = 0;
  const handlers = createHandlers(async () => {
    upstreamCalls += 1;
    throw new Error("must not reach upstream");
  }, usageEvents, {
    billingProcessStartedAt: Date.now() - 60_000,
    billingColdStartGraceMs: 1000,
    authorizeBilling: async () => ({ ok: false, allowed: false, code: "billing_unavailable", enforcementMode: "hard" }),
    settleBilling: async () => ({ ok: true }),
  });
  const request = {
    headers: {},
    body: { model: "local-current", messages: [{ role: "user", content: "hello" }] },
    serviceGateway: { clientId: "hard-client", timeoutMs: 5000 },
  };
  const response = makeResponse();
  await handlers.handleChatCompletions(request, response.res);
  assert.equal(upstreamCalls, 0);
  assert.equal(response.state.statusCode, 503);
  assert.equal(response.state.json.error.code, "billing_unavailable");
});
