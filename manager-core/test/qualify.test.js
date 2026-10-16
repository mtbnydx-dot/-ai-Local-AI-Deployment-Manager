"use strict";

// Qualification suite and host records (docs/overhaul/02-models.md section 13,
// MOD-16). A mock OpenAI-compatible server (node:http, ephemeral port) answers
// every check; the benchmark runner of 01 and engines/metrics.js run for real
// against it. The host-record push is signed by internal-auth.js and verified
// by a stub entry that uses the same module. Nothing here touches Docker, a
// live service or real data: temp directories and loopback ports only.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// The process-wide engine registry reads bundled data only.
const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qualify-reference-"));
process.env.AI_REFERENCE_DATA_DIR = EMPTY_DIR;
test.after(() => fs.rmSync(EMPTY_DIR, { recursive: true, force: true }));

const core = require("..");
const internalAuth = require("../internal-auth");
const { registerModelInspectorRoutes } = require("../model-inspector-routes");
const hostRecords = require("../model-inspector/host-records");
const qualify = require("../model-inspector/qualify");

const { runQualification, planChecks, buildHostRecord, startQualifyJob, createMetricsReader, RED_PNG_BASE64 } = qualify;
const DIGEST = `sha256:${"a".repeat(64)}`;
const CARD_ID = "mc_aaaaaaaaaaaaaaaaaaaa";
const LAUNCH_ID = "lch_aaaaaaaaaaaaaaaaaaaa";
const API_KEY = ("sk-" + "fake-test-key-0123456789abcdef");
const TRUST = "fake-trust-token-for-tests";

// ----- fixtures

function tempRoot(t, prefix = "qualify-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function card(overrides = {}) {
  return {
    cardId: CARD_ID,
    contentDigest: DIGEST,
    template: { toolFormat: "qwen-xml", reasoningFormat: "think-tags", thinking: { kwarg: "enable_thinking", defaultOn: true } },
    modalities: { input: ["text", "image"] },
    ...overrides,
  };
}

function launch(values = {}) {
  return {
    launchId: LAUNCH_ID,
    spec: { engineId: "vllm", runtimeId: "vllm@0.28.0", recipeId: null, model: { contentDigest: DIGEST, servedName: "test-model" }, values: { contextLength: 8192, toolCallParser: "qwen3_coder", ...values } },
    resolved: { paramsKey: "8192|4|auto|0" },
  };
}

function sseBody(res, { content = "", reasoning = "", usage = { prompt_tokens: 20, completion_tokens: 12 } } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunks = [];
  if (reasoning) chunks.push({ choices: [{ delta: { reasoning_content: reasoning } }] });
  if (content) chunks.push({ choices: [{ delta: { content } }] });
  chunks.push({ choices: [], usage });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function completion(message, finish = "stop") {
  return { choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

const promptOf = (body) => {
  const last = body.messages[body.messages.length - 1];
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
};

/** A well-behaved model; `behavior` overrides single answers. */
function wellBehaved(body, state) {
  const thinkingOn = body.chat_template_kwargs?.enable_thinking !== false;
  if (body.tools && body.messages.some((message) => message.role === "tool")) return { json: completion({ content: "It is cloudy and 18 C in Paris." }) };
  if (body.tools) {
    return { json: completion({ content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) } }] }, "tool_calls") };
  }
  if (body.response_format?.type === "json_object") return { json: completion({ content: '{"name":"qualify","ok":true}' }) };
  if (Array.isArray(body.messages.at(-1).content)) return { json: completion({ content: "Red" }) };
  const prompt = promptOf(body);
  if (prompt.includes("passkey")) {
    const key = /The passkey is (\d+)/.exec(prompt)?.[1] || "";
    return { sse: { content: key } };
  }
  if (prompt.includes("pong")) return { json: completion({ content: "pong" }) };
  if (prompt.includes("12 + 30")) return { json: completion(thinkingOn ? { reasoning_content: "12 plus 30 is 42.", content: "42" } : { content: "42" }) };
  // The speed-test prompt.
  state.counters.draft += 10;
  state.counters.accepted += Math.round(10 * state.acceptRate);
  return { sse: { content: "The sea is wide and deep." } };
}

async function startMock(t, { chat = wellBehaved, maxModelLen = 8192, models, acceptRate = 0.8, dieAfterChats = null } = {}) {
  const state = { requests: [], counters: { draft: 0, accepted: 0 }, acceptRate, chats: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : null;
      const pathname = req.url.split("?")[0];
      state.requests.push({ method: req.method, path: pathname, body, auth: req.headers.authorization });
      const json = (value, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && pathname === "/v1/models") return json(models ? models() : { data: [{ id: "test-model", max_model_len: maxModelLen }] });
      if (req.method === "GET" && pathname === "/props") return json({ default_generation_settings: { n_ctx: maxModelLen } });
      if (req.method === "GET" && pathname === "/metrics") {
        return res.end(`# TYPE vllm:spec_decode_num_draft_tokens_total counter\nvllm:spec_decode_num_draft_tokens_total{model_name="test-model"} ${state.counters.draft}\n# TYPE vllm:spec_decode_num_accepted_tokens_total counter\nvllm:spec_decode_num_accepted_tokens_total{model_name="test-model"} ${state.counters.accepted}\n`);
      }
      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        state.chats += 1;
        if (dieAfterChats !== null && state.chats > dieAfterChats) {
          res.socket.destroy();
          server.close();
          server.closeAllConnections?.();
          return undefined;
        }
        const answer = chat(body, state) || wellBehaved(body, state);
        if (answer.status) return json(answer.json || { error: { message: answer.message || "failed" } }, answer.status);
        if (answer.sse) {
          if (body.stream) return sseBody(res, answer.sse);
          return json(completion({ content: answer.sse.content }));
        }
        return json(answer.json);
      }
      return json({ error: { message: "not found" } }, 404);
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { port, state, server };
}

function benchmarkFor(port) {
  const runner = core.createBenchmarkRunner({
    defaultPort: port,
    getRunningModelSummary: async () => ({ container: { running: true }, endpoint: { port }, models: [{ id: "test-model" }] }),
    getHeaders: () => ({ authorization: `Bearer ${API_KEY}` }),
    appendLog: () => {},
    setJobProgress: () => {},
    finishJob: () => {},
  });
  return (input) => runner.runBenchmarkJob({ id: "j" }, input);
}

async function run(mock, { cardOverrides, launchValues, checks, needle, light, extra = {} } = {}) {
  return runQualification({
    instance: { port: mock.port, apiKey: API_KEY, servedModel: "test-model", engineId: "vllm" },
    card: card(cardOverrides),
    launch: launch(launchValues),
    metrics: createMetricsReader({ port: mock.port, apiKey: API_KEY, engineId: "vllm" }),
    benchmark: benchmarkFor(mock.port),
    checks,
    needle,
    light,
    ...extra,
  });
}

const statusOf = (result, check) => result.results.find((item) => item.check === check)?.status;
const detailOf = (result, check) => result.results.find((item) => item.check === check)?.detail;

// ----- the checks

test("a well-behaved model passes every check of the default set, in order, with the key only as a header", async (t) => {
  const mock = await startMock(t);
  const result = await run(mock, { launchValues: { "speculative.method": "mtp" } });
  assert.deepEqual(result.results.map((item) => `${item.check}:${item.status}`), [
    "models:pass", "chat:pass", "reasoning-split:pass", "tool-call:pass", "json-output:pass", "vision:pass", "speculative:pass", "throughput:pass",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.summary, { pass: 8, warn: 0, fail: 0, skip: 0 });
  for (const item of result.results) {
    assert.equal(typeof item.detail.zh, "string");
    assert.equal(typeof item.detail.en, "string");
  }
  // Every request carried the instance's key as a header, and it appears nowhere in the result.
  assert.ok(mock.state.requests.every((request) => request.auth === `Bearer ${API_KEY}`));
  assert.ok(!JSON.stringify(result).includes(API_KEY));
  // temperature 0 and fixed prompts.
  const chats = mock.state.requests.filter((request) => request.path === "/v1/chat/completions" && request.body.stream !== true);
  assert.ok(chats.every((request) => request.body.temperature === 0));
  // The chat check asks for thinking off through the card's kwarg.
  assert.equal(chats[0].body.chat_template_kwargs.enable_thinking, false);
  assert.ok(result.durationMs >= 0 && Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
});

test("models: the served id must be listed; a lower reported context warns; llama.cpp reads /props", async (t) => {
  const missing = await startMock(t, { models: () => ({ data: [{ id: "another-model" }] }) });
  const failed = await run(missing, { checks: ["models"] });
  assert.equal(statusOf(failed, "models"), "fail");
  assert.match(detailOf(failed, "models").en, /another-model/);

  const lower = await startMock(t, { maxModelLen: 4096 });
  const warned = await run(lower, { checks: ["models"] });
  assert.equal(statusOf(warned, "models"), "warn");
  assert.equal(warned.results[0].metrics.reportedContext, 4096);
  assert.equal(warned.results[0].metrics.launchContext, 8192);

  const same = await startMock(t, { maxModelLen: 8192 });
  assert.equal(statusOf(await run(same, { checks: ["models"] }), "models"), "pass");

  // llama.cpp: no max_model_len on /v1/models, the context is n_ctx of /props.
  const llama = await startMock(t, { models: () => ({ data: [{ id: "test-model" }] }), maxModelLen: 2048 });
  const props = await runQualification({
    instance: { port: llama.port, apiKey: API_KEY, servedModel: "test-model", engineId: "llamacpp" },
    card: card(),
    launch: launch(),
    checks: ["models"],
  });
  assert.equal(statusOf(props, "models"), "warn");
  assert.ok(llama.state.requests.some((request) => request.path === "/props"));

  const broken = await startMock(t, { models: () => ({ error: "boom" }) });
  assert.equal(statusOf(await run(broken, { checks: ["models"] }), "models"), "fail");
});

test("chat: pong passes; a wrong or empty answer fails, and a thinking-only answer says so", async (t) => {
  assert.equal(statusOf(await run(await startMock(t), { checks: ["chat"] }), "chat"), "pass");
  const wrong = await startMock(t, { chat: () => ({ json: completion({ content: "ping" }) }) });
  const wrongResult = await run(wrong, { checks: ["chat"] });
  assert.equal(statusOf(wrongResult, "chat"), "fail");
  assert.match(detailOf(wrongResult, "chat").en, /ping/);
  const thinking = await startMock(t, { chat: () => ({ json: completion({ content: "", reasoning_content: "hmm, let me think" }) }) });
  const thinkingResult = await run(thinking, { checks: ["chat"] });
  assert.equal(statusOf(thinkingResult, "chat"), "fail");
  assert.match(detailOf(thinkingResult, "chat").en, /thinking/);
  const refused = await startMock(t, { chat: () => ({ status: 400, message: "bad request" }) });
  const refusedResult = await run(refused, { checks: ["chat"] });
  assert.equal(statusOf(refusedResult, "chat"), "fail");
  assert.match(detailOf(refusedResult, "chat").en, /HTTP 400/);
});

test("reasoning-split: <think> leakage, empty reasoning and reasoning with thinking off fail", async (t) => {
  assert.equal(statusOf(await run(await startMock(t), { checks: ["reasoning-split"] }), "reasoning-split"), "pass");

  const leak = await startMock(t, { chat: (body) => (promptOf(body).includes("12 + 30") ? { json: completion({ content: "<think>12+30</think>42", reasoning_content: "x" }) } : null) });
  const leaked = await run(leak, { checks: ["reasoning-split"] });
  assert.equal(statusOf(leaked, "reasoning-split"), "fail");
  assert.match(detailOf(leaked, "reasoning-split").en, /leaked/);

  const empty = await startMock(t, { chat: (body) => (promptOf(body).includes("12 + 30") ? { json: completion({ content: "42" }) } : null) });
  const emptied = await run(empty, { checks: ["reasoning-split"] });
  assert.equal(statusOf(emptied, "reasoning-split"), "fail");
  assert.match(detailOf(emptied, "reasoning-split").en, /reasoning field is empty/);

  const stubborn = await startMock(t, { chat: (body) => (promptOf(body).includes("12 + 30") ? { json: completion({ content: "42", reasoning: "always thinking" }) } : null) });
  const stuck = await run(stubborn, { checks: ["reasoning-split"] });
  assert.equal(statusOf(stuck, "reasoning-split"), "fail");
  assert.match(detailOf(stuck, "reasoning-split").en, /thinking off/);
  // Both requests were made: thinking on, then off through the card's kwarg.
  const kwargs = stubborn.state.requests.filter((request) => request.body?.chat_template_kwargs).map((request) => request.body.chat_template_kwargs.enable_thinking);
  assert.deepEqual(kwargs, [true, false]);

  // Without a kwarg only the thinking-on half runs.
  const noKwarg = await startMock(t);
  const plain = await run(noKwarg, { cardOverrides: { template: { toolFormat: null, reasoningFormat: "harmony-channels", thinking: null } }, checks: ["reasoning-split"] });
  assert.equal(statusOf(plain, "reasoning-split"), "pass");
  assert.equal(noKwarg.state.requests.filter((request) => request.path === "/v1/chat/completions").length, 1);
});

test("tool-call: the round trip passes; invalid JSON, a missing call, a missing city and a silent second turn fail", async (t) => {
  const ok = await run(await startMock(t), { checks: ["tool-call"] });
  assert.equal(statusOf(ok, "tool-call"), "pass");

  const toolCall = (args, finish = "tool_calls", name = "get_weather") => ({
    json: completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }] }, finish),
  });
  const cases = [
    ["invalid tool JSON", (body) => (body.tools && !body.messages.some((message) => message.role === "tool") ? toolCall("{city: Paris") : null), /not valid JSON/],
    ["no tool call", (body) => (body.tools ? { json: completion({ content: "I cannot do that." }) } : null), /No get_weather tool call/],
    ["the wrong finish_reason", (body) => (body.tools && !body.messages.some((message) => message.role === "tool") ? toolCall('{"city":"Paris"}', "stop") : null), /finish_reason=stop/],
    ["no city", (body) => (body.tools && !body.messages.some((message) => message.role === "tool") ? toolCall('{"town":"Paris"}') : null), /no city/],
    ["a silent second turn", (body) => (body.messages.some((message) => message.role === "tool") ? { json: completion({ content: "" }) } : null), /no text/],
  ];
  for (const [label, chat, pattern] of cases) {
    const mock = await startMock(t, { chat });
    const result = await run(mock, { checks: ["tool-call"] });
    assert.equal(statusOf(result, "tool-call"), "fail", label);
    assert.match(detailOf(result, "tool-call").en, pattern, label);
  }
  // The second turn carries the assistant tool call and the tool result.
  const mock = await startMock(t);
  await run(mock, { checks: ["tool-call"] });
  const second = mock.state.requests.filter((request) => request.body?.tools).at(-1).body;
  assert.deepEqual(second.messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(second.messages[2].tool_call_id, "call_1");
});

test("json-output: a JSON object passes; prose and arrays fail", async (t) => {
  assert.equal(statusOf(await run(await startMock(t), { checks: ["json-output"] }), "json-output"), "pass");
  for (const content of ["Sure! Here is the JSON: {}", "[1, 2]", "```json\n{}\n```"]) {
    const mock = await startMock(t, { chat: (body) => (body.response_format ? { json: completion({ content }) } : null) });
    assert.equal(statusOf(await run(mock, { checks: ["json-output"] }), "json-output"), "fail", content);
  }
});

test("vision: the embedded 32x32 red PNG is sent and the answer must contain red", async (t) => {
  const mock = await startMock(t);
  assert.equal(statusOf(await run(mock, { checks: ["vision"] }), "vision"), "pass");
  const part = mock.state.requests.find((request) => request.path === "/v1/chat/completions").body.messages[0].content.find((item) => item.type === "image_url");
  assert.equal(part.image_url.url, `data:image/png;base64,${RED_PNG_BASE64}`);
  const png = Buffer.from(RED_PNG_BASE64, "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  const blue = await startMock(t, { chat: (body) => (Array.isArray(body.messages.at(-1).content) ? { json: completion({ content: "Blue" }) } : null) });
  assert.equal(statusOf(await run(blue, { checks: ["vision"] }), "vision"), "fail");
  // "hundred" is not "red".
  const word = await startMock(t, { chat: (body) => (Array.isArray(body.messages.at(-1).content) ? { json: completion({ content: "hundred" }) } : null) });
  assert.equal(statusOf(await run(word, { checks: ["vision"] }), "vision"), "fail");
});

test("needle (opt-in): passkeys at 50 percent and 90 percent of the context, TTFT recorded", async (t) => {
  const mock = await startMock(t);
  const result = await run(mock, { checks: ["needle"] });
  assert.equal(statusOf(result, "needle"), "pass");
  assert.deepEqual(Object.keys(result.results[0].metrics.ttftMs), ["50", "90"]);
  const prompts = mock.state.requests.filter((request) => request.body?.stream === true).map((request) => request.body.messages[0].content);
  assert.equal(prompts.length, 2);
  for (const [index, depth] of [0.5, 0.9].entries()) {
    const at = prompts[index].indexOf("The passkey is") / prompts[index].length;
    assert.ok(Math.abs(at - depth) < 0.05, `passkey at ${at}`);
    // About 3 characters per token is an over-estimate of the size: the prompt fits the 8192 context.
    assert.ok(prompts[index].length / 3 < 8192);
  }
  const forgetful = await startMock(t, { chat: (body) => (promptOf(body).includes("passkey") ? { sse: { content: "I do not know." } } : null) });
  const failed = await run(forgetful, { checks: ["needle"] });
  assert.equal(statusOf(failed, "needle"), "fail");
  // needle is off unless asked for, and `needle: true` adds it to the default set.
  assert.ok(!planChecks({}).some((item) => item.id === "needle"));
  assert.ok(planChecks({ needle: true }).some((item) => item.id === "needle"));
});

test("throughput runs the benchmark runner (3 requests, concurrency 1, 256 tokens, streaming); the light set asks for 1", async (t) => {
  const mock = await startMock(t);
  const result = await run(mock, { checks: ["throughput"] });
  assert.equal(statusOf(result, "throughput"), "pass");
  assert.equal(result.results[0].metrics.requests, 3);
  assert.equal(result.results[0].metrics.successfulRequests, 3);
  assert.ok(result.results[0].metrics.tokensPerSecond > 0);
  const streamed = mock.state.requests.filter((request) => request.body?.stream === true);
  assert.equal(streamed.length, 3);
  assert.ok(streamed.every((request) => request.body.max_tokens === 256));

  const light = await startMock(t);
  const lightResult = await run(light, { checks: ["throughput"], light: true });
  assert.equal(lightResult.results[0].metrics.requests, 1);

  const broken = await startMock(t, { chat: (body) => (body.stream ? { status: 500, message: "engine error" } : null) });
  const brokenResult = await run(broken, { checks: ["throughput"] });
  assert.equal(statusOf(brokenResult, "throughput"), "fail");
  assert.match(detailOf(brokenResult, "throughput").en, /speed test failed/);
});

test("speculative: acceptance from the canonical counters of engines/metrics.js, recorded without a threshold; below 0.3 warns", async (t) => {
  const good = await startMock(t, { acceptRate: 0.8 });
  const result = await run(good, { launchValues: { "speculative.method": "mtp" }, checks: ["speculative", "throughput"] });
  assert.equal(statusOf(result, "speculative"), "pass");
  const speculative = result.results.find((item) => item.check === "speculative");
  assert.equal(speculative.metrics.draftTokens, 30);
  assert.equal(speculative.metrics.acceptedTokens, 24);
  assert.equal(speculative.metrics.acceptance, 0.8);
  // The counters were scraped from the descriptor's metrics endpoint with the instance key.
  const scrapes = good.state.requests.filter((request) => request.path === "/metrics");
  assert.equal(scrapes.length, 2);
  assert.ok(scrapes.every((request) => request.auth === `Bearer ${API_KEY}`));

  const poor = await startMock(t, { acceptRate: 0.1 });
  const poorResult = await run(poor, { launchValues: { "speculative.method": "mtp" }, checks: ["speculative"] });
  assert.equal(statusOf(poorResult, "speculative"), "warn");
  assert.equal(poorResult.results[0].metrics.acceptance, 0.1);
  // Selecting speculative alone still measures around the speed-test workload, but reports no throughput row.
  assert.deepEqual(poorResult.results.map((item) => item.check), ["speculative"]);

  const none = await startMock(t, { acceptRate: 0 });
  const noneResult = await run(none, { launchValues: { "speculative.method": "mtp" }, checks: ["speculative"] });
  assert.equal(statusOf(noneResult, "speculative"), "warn", "a counter that did not move is a warning, not a pass");
  none.state.counters.draft = 0;

  // The reader maps through engines/metrics.js: both canonical keys, null when the endpoint is missing.
  const reader = createMetricsReader({ port: good.port, apiKey: API_KEY, engineId: "vllm" });
  assert.deepEqual(await reader(), { specDraftTokensTotal: 30, specAcceptedTokensTotal: 24 });
  const unreachable = createMetricsReader({ port: 1, apiKey: API_KEY, engineId: "vllm", timeoutMs: 200 });
  assert.equal(await unreachable(), null);
});

test("checks that do not apply are skipped with a reason", async (t) => {
  const mock = await startMock(t);
  const result = await run(mock, {
    cardOverrides: { template: { toolFormat: null, reasoningFormat: "none", thinking: null }, modalities: { input: ["text"] } },
    launchValues: { toolCallParser: "" },
  });
  const byCheck = Object.fromEntries(result.results.map((item) => [item.check, item.status]));
  assert.equal(byCheck["reasoning-split"], "skip");
  assert.equal(byCheck["tool-call"], "skip");
  assert.equal(byCheck.vision, "skip");
  assert.equal(byCheck.speculative, "skip", "speculative decoding is off");
  const asked = await run(mock, { checks: ["speculative", "vision"], cardOverrides: { modalities: { input: ["text", "image"] } }, launchValues: { "vllm.languageModelOnly": true } });
  assert.deepEqual(asked.results.map((item) => `${item.check}:${item.status}`), ["vision:skip", "speculative:skip"]);
  assert.match(detailOf(asked, "vision").en, /text part only/);
  // llama.cpp: a template with a tool format counts as a tool parser.
  const llama = planChecks({ card: card(), launch: launch({ toolCallParser: "" }), instance: { engineId: "llamacpp" }, checks: ["tool-call"] });
  assert.equal(llama[0].skip, null);
  const vllm = planChecks({ card: card(), launch: launch({ toolCallParser: "" }), instance: { engineId: "vllm" }, checks: ["tool-call"] });
  assert.ok(vllm[0].skip);
  // A parser or auto tool choice enables the check for any engine.
  assert.equal(planChecks({ card: card(), launch: launch({ toolCallParser: "", autoToolChoice: true }), instance: { engineId: "vllm" }, checks: ["tool-call"] })[0].skip, null);
});

test("a server that dies mid-run ends it: the check in flight fails, the rest are skipped, the result is partial", async (t) => {
  const mock = await startMock(t, { dieAfterChats: 2 });
  const progress = [];
  const result = await run(mock, { extra: { onProgress: (event) => progress.push(`${event.check}:${event.status}`) } });
  assert.equal(result.partial, true);
  assert.equal(result.ok, false);
  const byCheck = Object.fromEntries(result.results.map((item) => [item.check, item.status]));
  assert.equal(byCheck.models, "pass");
  assert.equal(byCheck.chat, "pass");
  assert.equal(byCheck["reasoning-split"], "fail");
  assert.match(detailOf(result, "reasoning-split").en, /stopped answering/);
  for (const check of ["tool-call", "json-output", "vision", "throughput"]) assert.equal(byCheck[check], "skip", check);
  assert.ok(progress.includes("chat:pass"));
  assert.ok(progress.includes("throughput:skip"));
});

test("the 120 s budget skips what cannot start; needle is outside the budget", async (t) => {
  const mock = await startMock(t);
  let clock = 1_000_000;
  const result = await run(mock, {
    extra: { now: () => { clock += 70_000; return clock; } },
  });
  const byCheck = Object.fromEntries(result.results.map((item) => [item.check, item.status]));
  assert.equal(byCheck.models, "pass");
  assert.ok(Object.values(byCheck).slice(2).every((status) => status === "skip"), JSON.stringify(byCheck));
  assert.match(detailOf(result, "chat").en, /budget/);
  assert.equal(result.budgetMs, 120_000);

  let later = 1_000_000;
  const needle = await run(await startMock(t), { checks: ["chat", "needle"], extra: { now: () => { later += 200_000; return later; } } });
  assert.equal(statusOf(needle, "chat"), "skip");
  assert.equal(statusOf(needle, "needle"), "pass", "needle ignores the budget");
});

test("previews are truncated to 240 characters and redacted; a failing check links a matching error signature", async (t) => {
  assert.equal(qualify.preview("x".repeat(500)).length, 240);
  assert.ok(!qualify.preview(`token ${API_KEY} end`).includes(API_KEY));
  const leaky = await startMock(t, { chat: () => ({ json: completion({ content: `ping ${API_KEY} ${"y".repeat(400)}` }) }) });
  const result = await run(leaky, { checks: ["chat"] });
  assert.equal(statusOf(result, "chat"), "fail");
  assert.ok(!JSON.stringify(result).includes(API_KEY));
  assert.ok(detailOf(result, "chat").en.length < 300);

  const oom = await startMock(t, { chat: () => ({ status: 500, message: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB" }) });
  const failed = await run(oom, { checks: ["chat"] });
  assert.equal(statusOf(failed, "chat"), "fail");
  assert.ok(failed.results[0].rootCause === undefined || typeof failed.results[0].rootCause.signatureId === "string");
});

// ----- host record

test("buildHostRecord carries the launch identity and normalizes to the stored shape", async (t) => {
  const mock = await startMock(t);
  const result = await run(mock, { checks: ["models", "chat"] });
  const record = buildHostRecord({
    result,
    card: card(),
    instance: { engineId: "vllm", runtimeId: "vllm@0.28.0" },
    launch: launch(),
    fleetId: "vllm:primary",
    host: { gpu: "Test GPU", computeCap: "12.0", driver: null },
    peakMb: { 0: 4096 },
  });
  assert.match(record.id, /^qr_[a-z2-7]{20}$/);
  assert.equal(record.contentDigest, DIGEST);
  assert.equal(record.paramsKey, "8192|4|auto|0");
  const { record: normalized, errors } = hostRecords.normalizeHostRecord(record);
  assert.deepEqual(errors, []);
  assert.deepEqual(normalized.results.map((item) => item.check), ["models", "chat"]);
  assert.deepEqual(normalized.observed.peakMb, { 0: 4096 });
  // Rebuilt from known fields only: extra and secret-looking fields are dropped.
  const dirty = hostRecords.normalizeHostRecord({ ...record, apiKey: API_KEY, extra: true, host: { ...record.host, secret: API_KEY } });
  assert.equal(dirty.record.apiKey, undefined);
  assert.equal(dirty.record.extra, undefined);
  assert.equal(dirty.record.host.secret, undefined);
});

test("normalizeHostRecord reports field errors for every invalid part", () => {
  const bad = hostRecords.normalizeHostRecord({ contentDigest: "nope", cardId: "x", engineId: "BAD", runtimeId: "", fleetId: "elsewhere:1", at: "yesterday", durationMs: -1, results: [{ check: "unknown", status: "pass" }] });
  assert.equal(bad.record, null);
  const fields = bad.errors.map((error) => error.field);
  for (const field of ["contentDigest", "cardId", "engineId", "runtimeId", "fleetId", "at", "durationMs"]) assert.ok(fields.includes(field), field);
  assert.ok(fields.some((field) => field.startsWith("results[0]")));
  assert.equal(hostRecords.normalizeHostRecord(null).errors[0].field, "$");
});

test("the store appends atomically, drops duplicates, keeps 50 per digest and survives a corrupt file", async (t) => {
  const root = tempRoot(t);
  const file = path.join(root, "data", "model-host-records.json");
  const store = hostRecords.createHostRecordStore({ file });
  assert.deepEqual(await store.all(), []);
  const make = (index, extra = {}) => ({
    id: qualify.newRecordId(),
    contentDigest: DIGEST,
    cardId: CARD_ID,
    engineId: "vllm",
    runtimeId: "vllm@0.28.0",
    recipeId: null,
    paramsKey: "k",
    launchId: null,
    fleetId: "vllm:primary",
    host: { gpu: null, computeCap: null, driver: null },
    at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    durationMs: 1,
    results: [{ check: "chat", status: "pass", detail: { zh: "好", en: "ok" }, metrics: {} }],
    observed: { peakMb: {}, engineFacts: {} },
    ...extra,
  });
  const first = make(0);
  assert.equal((await store.append(first)).duplicate, false);
  assert.equal((await store.append(first)).duplicate, true, "the same id again is a no-op");
  // Writes are serialised: parallel appends all land.
  await Promise.all(Array.from({ length: 55 }, (_, index) => store.append(make(index + 1))));
  const kept = await store.list(DIGEST);
  assert.equal(kept.length, 50);
  assert.ok(!kept.some((record) => record.id === first.id), "the oldest records go first");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.records.length, 50);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
  assert.equal(await store.has({ contentDigest: DIGEST, runtimeId: "vllm@0.28.0", recipeId: null, paramsKey: "k" }), true);
  assert.equal(await store.has({ contentDigest: DIGEST, runtimeId: "vllm@0.28.0", recipeId: null, paramsKey: "other" }), false);
  assert.equal(await store.has({ contentDigest: DIGEST, runtimeId: "vllm@0.28.0", recipeId: "some-recipe", paramsKey: "k" }), false);
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(await store.all(), []);
  assert.equal((await store.append(make(99))).duplicate, false, "the next write replaces a corrupt file");
});

test("a pass adds verified-on-host evidence for the card; a fail adds none", () => {
  const record = {
    id: "qr_aaaaaaaaaaaaaaaaaaaa",
    contentDigest: DIGEST,
    runtimeId: "vllm@0.28.0",
    results: [
      { check: "tool-call", status: "pass" },
      { check: "reasoning-split", status: "pass" },
      { check: "vision", status: "fail" },
      { check: "throughput", status: "pass" },
    ],
  };
  const entries = hostRecords.evidenceForRecord(record);
  assert.deepEqual(entries.map((entry) => entry.fact), ["/capabilities/tools", "/template/reasoningFormat"]);
  assert.ok(entries.every((entry) => entry.confidence === "verified-on-host" && entry.source.kind === "qualification" && entry.source.ref === record.id));
  const original = card({ evidence: [{ fact: "/identity/modelType", source: { kind: "file", ref: null }, confidence: "declared" }] });
  const shown = hostRecords.withHostEvidence(original, [record, { ...record, contentDigest: `sha256:${"b".repeat(64)}` }]);
  assert.equal(original.evidence.length, 1, "the cached card is not changed");
  assert.equal(shown.evidence.length, 3);
  assert.equal(hostRecords.withHostEvidence(shown, [record]).evidence.length, 3, "idempotent");
  assert.equal(core.models.evidence.confidenceOf(shown, "/capabilities/tools"), "verified-on-host");
});

// ----- the signed, retried push

async function startStubEntry(t, script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const verified = internalAuth.verifyInternalRequest(req, raw, TRUST, {
        pathname: req.url,
        pathPrefixes: ["/internal/models/"],
        allowedManagers: ["vllm-manager", "llama-manager"],
      });
      seen.push({ method: req.method, path: req.url, verified, body: raw.length ? JSON.parse(raw.toString("utf8")) : null });
      const [status, body] = verified.ok ? script(seen.length, seen.at(-1)) : [401, { ok: false, error: { code: "internal_auth_failed" } }];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

function signedClient(baseUrl, token = TRUST) {
  return internalAuth.createInternalClient({ managerId: "vllm-manager", baseUrl, readKey: () => token });
}

const SAMPLE = { id: "qr_aaaaaaaaaaaaaaaaaaaa", contentDigest: DIGEST, fleetId: "vllm:primary" };

test("the push is signed by internal-auth.js and retried after 1, 4 and 16 seconds", async (t) => {
  const entry = await startStubEntry(t, (count) => (count < 3 ? [503, { ok: false }] : [200, { ok: true, id: SAMPLE.id }]));
  const delays = [];
  const outcome = await hostRecords.pushHostRecord({
    internalClient: signedClient(entry.baseUrl),
    record: SAMPLE,
    jobId: "job-1",
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(outcome, { ok: true, attempts: 3, id: SAMPLE.id, status: 200 });
  assert.deepEqual(delays, [1000, 4000]);
  assert.equal(entry.seen.length, 3);
  assert.ok(entry.seen.every((call) => call.method === "POST" && call.path === "/internal/models/host-records" && call.verified.ok && call.verified.managerId === "vllm-manager"));
  assert.deepEqual(entry.seen[0].body, { ...SAMPLE, jobId: "job-1" });
});

test("after three retries the push gives up; a forged signature and a final refusal are not retried past what they deserve", async (t) => {
  const dead = await startStubEntry(t, () => [500, { ok: false }]);
  const delays = [];
  const given = await hostRecords.pushHostRecord({ internalClient: signedClient(dead.baseUrl), record: SAMPLE, jobId: "job-1", sleep: async (ms) => { delays.push(ms); } });
  assert.equal(given.ok, false);
  assert.equal(given.attempts, 4);
  assert.deepEqual(delays, [1000, 4000, 16000]);
  assert.deepEqual(hostRecords.PUSH_RETRY_DELAYS_MS, [1000, 4000, 16000]);

  // A refusal that retrying cannot change is final.
  const refusing = await startStubEntry(t, () => [422, { ok: false, error: { code: "invalid_record" } }]);
  const refused = await hostRecords.pushHostRecord({ internalClient: signedClient(refusing.baseUrl), record: SAMPLE, jobId: "job-1", sleep: async () => {} });
  assert.deepEqual([refused.ok, refused.attempts, refused.final, refused.code], [false, 1, true, "invalid_record"]);

  // A job the entry has not registered yet is retried (a very short run can end first).
  const racing = await startStubEntry(t, (count) => (count === 1 ? [409, { ok: false, error: { code: "job_mismatch" } }] : [200, { ok: true, id: SAMPLE.id }]));
  const raced = await hostRecords.pushHostRecord({ internalClient: signedClient(racing.baseUrl), record: SAMPLE, jobId: "job-1", sleep: async () => {} });
  assert.equal(raced.ok, true);
  assert.equal(raced.attempts, 2);

  // A wrong token never verifies at the entry (the 401 is retried with a fresh key, then reported).
  const strict = await startStubEntry(t, () => [200, { ok: true }]);
  const forged = await hostRecords.pushHostRecord({ internalClient: signedClient(strict.baseUrl, "not-the-trust-token"), record: SAMPLE, jobId: "job-1", delaysMs: [], sleep: async () => {} });
  assert.equal(forged.ok, false);
  assert.ok(strict.seen.every((call) => call.verified.ok === false));

  // No client, no push; a transport failure is retried too.
  assert.equal((await hostRecords.pushHostRecord({ record: SAMPLE, jobId: "j" })).code, "no_internal_client");
  const unreachable = await hostRecords.pushHostRecord({ internalClient: signedClient("http://127.0.0.1:1"), record: SAMPLE, jobId: "job-1", delaysMs: [1], sleep: async () => {} });
  assert.deepEqual([unreachable.ok, unreachable.attempts], [false, 2]);
});

// ----- the manager job and route

function jobsLedger() {
  const jobs = [];
  return {
    jobs,
    createJob: (type, title, meta = {}) => {
      const job = { id: `job-${jobs.length + 1}`, type, title, status: "running", meta: { ...meta }, logs: [] };
      jobs.push(job);
      return job;
    },
    appendLog: (job, data) => { job.logs.push(String(data)); },
    finishJob: (job, meta = {}) => { job.status = "success"; job.meta = { ...job.meta, ...meta }; },
    failJob: (job, error) => { job.status = "failed"; job.error = error.message; },
    setJobProgress: (job, progress) => { job.progress = progress; },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
}

function instanceFor(mock, extra = {}) {
  return {
    id: "primary",
    running: true,
    port: mock.port,
    engineId: "vllm",
    runtime: { id: "vllm@0.28.0" },
    recipeId: null,
    launchId: LAUNCH_ID,
    gpuIds: ["0"],
    models: [{ id: "test-model", maxModelLen: 8192 }],
    ...extra,
  };
}

async function routeFixture(t, { local = true, listJobs, instance, launchRecord = launch({ "speculative.method": "mtp" }), pushTo = null, found = true, chat, routeExtra = {} } = {}) {
  const mock = await startMock(t, chat ? { chat } : {});
  const ledger = jobsLedger();
  const registryModule = require("../engines/registry");
  const registered = new Map();
  const app = { get: (route, handler) => registered.set(`GET ${route}`, handler), post: (route, handler) => registered.set(`POST ${route}`, handler) };
  const delays = [];
  const entry = pushTo ? await pushTo() : null;
  const context = registerModelInspectorRoutes(app, {
    managerId: "vllm",
    isLocalRequest: () => local,
    jobs: ledger,
    registry: registryModule.getEngineRegistry(),
    findInstance: async (id) => (found && id === "primary" ? { instance: instance || instanceFor(mock), container: { name: "c" }, state: {} } : null),
    apiKeyFor: () => API_KEY,
    launchOf: () => launchRecord,
    listJobs: listJobs ? () => listJobs(mock) : () => ledger.jobs,
    getGpuStatus: async () => ({ gpus: [{ id: "0", name: "Test GPU", computeCap: "12.0", usedMb: 4096 }, { id: "1", name: "Other", usedMb: 1 }] }),
    getCard: (cardId) => (cardId === CARD_ID ? card() : null),
    internalClient: entry ? () => signedClient(entry.baseUrl) : null,
    qualify: { retryDelaysMs: [1000, 4000, 16000], sleep: async (ms) => { delays.push(ms); } },
    ...routeExtra,
  });
  async function post(body, headers = {}) {
    const res = fakeResponse();
    await registered.get("POST /api/qualify")({ headers, body }, res);
    await Promise.all([...context.qualifyRuns]);
    return res;
  }
  return { mock, ledger, context, post, registered, entry, delays };
}

test("POST /api/qualify runs a model-qualify job, keeps the record on the job and pushes it signed", async (t) => {
  const f = await routeFixture(t, {
    pushTo: () => startStubEntry(t, () => [200, { ok: true, id: "qr_x" }]),
  });
  assert.ok(f.registered.has("POST /api/qualify"));
  const res = await f.post({ instanceId: "primary", cardId: CARD_ID });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, jobId: "job-1", managerId: "vllm" });
  const job = f.ledger.jobs[0];
  assert.equal(job.type, "model-qualify");
  assert.equal(job.status, "success");
  assert.equal(job.meta.fleetId, "vllm:primary");
  assert.equal(job.meta.contentDigest, DIGEST);
  assert.equal(job.meta.pushed, true);
  assert.ok(!JSON.stringify(job).includes(API_KEY), "the instance key is never in the job");
  assert.ok(!JSON.stringify(job).includes("Bearer"));
  // The result holds the record until the entry has it; the signed push carried it.
  const record = job.result.hostRecord;
  assert.equal(record.fleetId, "vllm:primary");
  assert.equal(record.launchId, LAUNCH_ID);
  assert.equal(record.runtimeId, "vllm@0.28.0");
  assert.equal(record.paramsKey, "8192|4|auto|0");
  assert.deepEqual(record.host, { gpu: "Test GPU", computeCap: "12.0", driver: null });
  assert.deepEqual(record.observed.peakMb, { 0: 4096 }, "only this instance's GPUs");
  assert.deepEqual(record.results.map((item) => item.check), ["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "speculative", "throughput"]);
  assert.equal(f.entry.seen.length, 1);
  assert.equal(f.entry.seen[0].verified.ok, true);
  assert.equal(f.entry.seen[0].body.jobId, "job-1");
  assert.equal(f.entry.seen[0].body.id, record.id);
  assert.equal(job.progress.state, "ok");
  assert.ok(job.logs.some((line) => line.includes("stored by the entry")));
});

test("when the push fails the record stays in job.result.hostRecord for the import", async (t) => {
  const f = await routeFixture(t, { pushTo: () => startStubEntry(t, () => [500, { ok: false }]) });
  const res = await f.post({ instanceId: "primary", cardId: CARD_ID, checks: ["models", "chat"] });
  assert.equal(res.statusCode, 202);
  const job = f.ledger.jobs[0];
  assert.equal(job.status, "success", "the qualification itself succeeded");
  assert.equal(job.meta.pushed, false);
  assert.equal(job.result.pushed, false);
  assert.equal(job.result.hostRecord.results.length, 2);
  assert.deepEqual(f.delays, [1000, 4000, 16000]);
  assert.equal(f.entry.seen.length, 4);
  assert.ok(job.logs.some((line) => line.includes("kept on the job")));
});

test("without an internal client the record is kept on the job; a dead engine fails the job after reporting", async (t) => {
  const none = await routeFixture(t);
  await none.post({ instanceId: "primary", cardId: CARD_ID, checks: ["chat"] });
  assert.equal(none.ledger.jobs[0].result.hostRecord.results[0].check, "chat");

  const f = await routeFixture(t, { pushTo: () => startStubEntry(t, () => [200, { ok: true, id: "qr_x" }]) });
  f.mock.server.close();
  f.mock.server.closeAllConnections?.();
  await f.post({ instanceId: "primary", cardId: CARD_ID, checks: ["models", "chat"] });
  const job = f.ledger.jobs[0];
  assert.equal(job.status, "failed");
  assert.equal(job.failure.code, "qualify_server_stopped");
  assert.equal(job.result.partial, true);
  assert.equal(f.entry.seen.length, 1, "the partial record is still reported");
});

test("requests are validated, local-only and refused while the instance is busy with a qualification or a benchmark", async (t) => {
  const remote = await routeFixture(t, { local: false });
  const forbidden = await remote.post({ instanceId: "primary", cardId: CARD_ID });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(remote.ledger.jobs.length, 0);

  const f = await routeFixture(t);
  const invalid = await f.post({ instanceId: "", cardId: "x", checks: ["nope"], needle: "yes" });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body.errors.map((error) => error.field).sort(), ["cardId", "checks", "instanceId", "needle"]);

  assert.equal((await f.post({ instanceId: "elsewhere", cardId: CARD_ID })).body.error.code, "instance_not_found");
  assert.equal((await f.post({ instanceId: "primary", cardId: "mc_bbbbbbbbbbbbbbbbbbbb" })).body.error.code, "card_not_found");

  // Another card than the one the instance runs.
  const mismatch = await routeFixture(t, { launchRecord: { ...launch(), spec: { ...launch().spec, model: { contentDigest: `sha256:${"c".repeat(64)}` } } } });
  assert.equal((await mismatch.post({ instanceId: "primary", cardId: CARD_ID })).statusCode, 409);

  // A running benchmark on the same port, or a qualification of the same instance.
  for (const [type, meta] of [["benchmark", "port"], ["benchmark", "instanceId"], ["model-qualify", "instanceId"]]) {
    const busy = await routeFixture(t, { listJobs: (mock) => [{ id: "other", type, status: "running", meta: meta === "port" ? { port: mock.port } : { instanceId: "primary", port: 1 } }] });
    const refused = await busy.post({ instanceId: "primary", cardId: CARD_ID });
    assert.equal(refused.statusCode, 409, type);
    assert.equal(refused.body.error.code, "instance_busy");
    assert.equal(refused.body.jobId, "other");
    assert.equal(busy.ledger.jobs.length, 0, "no job is created for a refused request");
  }
  // A finished benchmark, or one on another port, does not block.
  const free = await routeFixture(t, { listJobs: () => [{ id: "old", type: "benchmark", status: "success", meta: { port: 1 } }, { id: "elsewhere", type: "benchmark", status: "running", meta: { port: 2 } }] });
  assert.equal((await free.post({ instanceId: "primary", cardId: CARD_ID, checks: ["models"] })).statusCode, 202);

  // A stopped instance is not qualified.
  const stopped = await routeFixture(t, { instance: instanceFor({ port: 1 }, { running: false }) });
  assert.equal((await stopped.post({ instanceId: "primary", cardId: CARD_ID })).body.error.code, "instance_not_running");
});

test("two requests for one instance cannot overlap; the second is busy until the first job ends", async (t) => {
  // The jobs list is empty (a fresh ledger entry shows up late), so only the manager's own in-flight guard can refuse.
  const f = await routeFixture(t, { listJobs: () => [] });
  const call = async () => {
    const res = fakeResponse();
    await f.registered.get("POST /api/qualify")({ headers: {}, body: { instanceId: "primary", cardId: CARD_ID, checks: ["models"] } }, res);
    return res;
  };
  const answers = await Promise.all([call(), call()]);
  assert.deepEqual(answers.map((res) => res.statusCode).sort(), [202, 409]);
  await Promise.all([...f.context.qualifyRuns]);
  const again = await f.post({ instanceId: "primary", cardId: CARD_ID, checks: ["models"] });
  assert.equal(again.statusCode, 202, "free again once the run ended");
});

test("the light set of auto-qualify and the namespace exports", () => {
  assert.deepEqual([...qualify.LIGHT_CHECKS], ["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "throughput"]);
  assert.deepEqual([...qualify.CHECK_IDS], ["models", "chat", "reasoning-split", "tool-call", "json-output", "vision", "needle", "speculative", "throughput"]);
  assert.equal(core.models.qualify.CHECK_IDS, qualify.CHECK_IDS);
  assert.equal(core.models.qualify.startQualifyJob, startQualifyJob);
  assert.equal(core.models.hostRecords.pushHostRecord, hostRecords.pushHostRecord);
});

test("a benchmark is refused while a qualification runs on its port, and the other way round", async () => {
  const routes = new Map();
  const app = new Proxy({}, { get: (_, verb) => (route, handler) => routes.set(`${String(verb).toUpperCase()} ${route}`, handler) });
  const jobs = [{ id: "q1", type: "model-qualify", status: "running", meta: { instanceId: "primary", port: 8001 } }];
  const created = [];
  core.registerToolsRoutes(app, {
    normalizeBenchmarkRequest: (body) => ({ port: Number(body.port || 8000) }),
    createJob: (type, title, meta) => { const job = { id: `b${created.length + 1}`, type, meta }; created.push(job); return job; },
    runBenchmarkJob: async () => {},
    failJob: () => {},
    qualificationRunning: (config) => qualify.runningQualification(() => jobs, { port: config.port }),
  });
  const post = async (body) => {
    const res = fakeResponse();
    await routes.get("POST /api/tools/benchmark")({ body }, res);
    return res;
  };
  const refused = await post({ port: 8001 });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, "instance_busy");
  assert.equal(refused.body.jobId, "q1");
  assert.equal(created.length, 0);
  assert.equal((await post({ port: 8002 })).statusCode, 200, "another instance is free");
  jobs[0].status = "success";
  assert.equal((await post({ port: 8001 })).statusCode, 200, "free once the qualification ended");
  assert.equal(qualify.runningQualification(() => [{ type: "benchmark", status: "running", meta: { port: 8001 } }], { port: 8001 }), null);
});

test("MOD-18: a failed tool check unpublishes tools on the launch record, a passing run keeps them", async (t) => {
  const { createLaunchStore } = require("../engines/launch-store");
  const { createEngineRegistry } = require("../engines/registry");
  const root = tempRoot(t, "qualify-caps-");
  const registry = createEngineRegistry({ overrideDir: path.join(root, "config"), env: {} });
  const launchStore = createLaunchStore({ file: path.join(root, "launch-store.json"), managerId: "vllm", registry });
  launchStore.create({
    engineId: "vllm",
    model: { ref: "fixture-model", servedName: "test-model" },
    instance: { mode: "replace", id: "primary", port: 8000, gpuIds: ["0"] },
    values: { contextLength: 8192, toolCallParser: "qwen3_coder" },
  }, { launchId: LAUNCH_ID, source: "ui", status: "running", containerName: "c" });
  const changed = [];
  const routeExtra = { launchStore, onCapabilities: () => changed.push("changed") };

  const ok = await routeFixture(t, { routeExtra });
  await ok.post({ instanceId: "primary", cardId: CARD_ID, checks: ["chat", "tool-call"] });
  assert.equal(launchStore.get(LAUNCH_ID).resolved.capabilities.tools, true);
  assert.equal(launchStore.get(LAUNCH_ID).resolved.capabilities.vision, true);

  const broken = await routeFixture(t, {
    routeExtra,
    chat: (body, state) => (body.tools ? { json: completion({ content: "I will not call a tool." }) } : wellBehaved(body, state)),
  });
  await broken.post({ instanceId: "primary", cardId: CARD_ID, checks: ["chat", "tool-call"] });
  const published = launchStore.get(LAUNCH_ID).resolved.capabilities;
  assert.equal(published.tools, false, "a failed tool-call check unpublishes tools");
  assert.equal(published.vision, true);
  assert.equal(published.text, true);
  assert.deepEqual(changed, ["changed", "changed"]);
});
