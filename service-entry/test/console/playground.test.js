// CON-13 (07 §6.6): the pure parts of the Playground and its gateway request
// rules, run in Node. The page itself is covered in a browser by
// tests/frontend/console/console-playground.spec.js.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const playground = await import(pathToFileURL(path.join(CONSOLE_DIR, "routes", "playground.js")).href);
const { applyDelta, buildChatBody, computeStats, curlCommand, gatewayFetch, gatewayPath, mergePatch, pythonSnippet, reasoningToggleOf, toolCallJson } = playground;

const TOGGLE = { on: { chat_template_kwargs: { enable_thinking: true } }, off: { chat_template_kwargs: { enable_thinking: false } } };
const MESSAGES = [{ role: "user", content: "hi" }];

test("gatewayPath maps the target to a host-relative gateway path", () => {
  assert.equal(gatewayPath("auto"), "/gateway/auto/openai/v1");
  assert.equal(gatewayPath(undefined), "/gateway/auto/openai/v1");
  assert.equal(gatewayPath("engine:vllm"), "/gateway/vllm/openai/v1");
  assert.equal(gatewayPath("external:my ep"), "/gateway/external/my%20ep/openai/v1");
});

test("the reasoning patch is merged only when the card has the toggle", () => {
  assert.equal(reasoningToggleOf({ id: "m" }), null);
  assert.equal(reasoningToggleOf({ id: "m", controls: {} }), null);
  assert.deepEqual(reasoningToggleOf({ controls: { reasoningToggle: TOGGLE } }), TOGGLE);
  assert.deepEqual(reasoningToggleOf({ controls: { reasoning_toggle: TOGGLE } }), TOGGLE);

  const plain = buildChatBody({ model: "m", messages: MESSAGES, showReasoning: true, toggle: null });
  assert.equal("chat_template_kwargs" in plain, false);
  const off = buildChatBody({ model: "m", messages: MESSAGES, showReasoning: false, toggle: null });
  assert.equal("chat_template_kwargs" in off, false);

  assert.deepEqual(buildChatBody({ model: "m", messages: MESSAGES, showReasoning: true, toggle: TOGGLE }).chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(buildChatBody({ model: "m", messages: MESSAGES, showReasoning: false, toggle: TOGGLE }).chat_template_kwargs, { enable_thinking: false });
});

test("buildChatBody streams with usage, skips empty sampling fields and adds the tool preset", () => {
  const body = buildChatBody({ model: "m", messages: MESSAGES, system: " be brief ", temperature: "0.5", topP: "", maxTokens: "128.9", tools: true });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.messages[0], { role: "system", content: "be brief" });
  assert.equal(body.temperature, 0.5);
  assert.equal("top_p" in body, false);
  assert.equal(body.max_tokens, 128);
  assert.equal(body.tools[0].function.name, "get_weather");
  assert.equal(body.tool_choice, "auto");
  assert.equal("tools" in buildChatBody({ model: "m", messages: MESSAGES }), false);
});

test("mergePatch merges plain objects deeply without touching its inputs", () => {
  const base = { a: { b: 1 }, list: [1] };
  const merged = mergePatch(base, { a: { c: 2 }, list: [2] });
  assert.deepEqual(merged, { a: { b: 1, c: 2 }, list: [2] });
  assert.deepEqual(base, { a: { b: 1 }, list: [1] });
});

test("curl and Python exports carry $API_KEY and never a typed key", () => {
  const body = buildChatBody({ model: "m", messages: [{ role: "user", content: "it's fine" }] });
  const curl = curlCommand({ origin: "https://host.example", path: "/gateway/auto/openai/v1", body });
  assert.match(curl, /Authorization: Bearer \$API_KEY/);
  assert.match(curl, /gateway\/auto\/openai\/v1\/chat\/completions/);
  assert.match(curl, /it'\\''s fine/);
  const python = pythonSnippet({ origin: "https://host.example", path: "/gateway/auto/openai/v1", body });
  assert.match(python, /os\.environ\["API_KEY"\]/);
  assert.match(python, /model="m"/);
  assert.doesNotMatch(`${curl}${python}`, /sk-/);
});

test("applyDelta folds content, reasoning and indexed tool-call fragments", () => {
  let state = { content: "", reasoning: "", toolCalls: [] };
  state = applyDelta(state, { choices: [{ delta: { reasoning_content: "think " } }] });
  state = applyDelta(state, { choices: [{ delta: { content: "Hel" } }] });
  state = applyDelta(state, { choices: [{ delta: { content: "lo" } }] });
  state = applyDelta(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: "{\"city\":" } }] } }] });
  state = applyDelta(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] } }] });
  assert.equal(state.content, "Hello");
  assert.equal(state.reasoning, "think ");
  assert.deepEqual(state.toolCalls, [{ id: "c1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" }]);
  assert.deepEqual(JSON.parse(toolCallJson(state.toolCalls[0])), { id: "c1", name: "get_weather", arguments: { city: "Paris" } });
  assert.equal(applyDelta(state, { choices: [] }), state);
});

test("computeStats derives TTFT, total and tokens per second from usage", () => {
  const stats = computeStats({ startedAt: 1000, firstAt: 1200, endedAt: 3200, usage: { completion_tokens: 40 } });
  assert.deepEqual(stats, { ttftMs: 200, totalMs: 2200, tokens: 40, tokensPerSecond: 20 });
  const none = computeStats({ startedAt: 0, firstAt: null, endedAt: 500, usage: null });
  assert.deepEqual(none, { ttftMs: null, totalMs: 500, tokens: null, tokensPerSecond: null });
});

function fakeResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("gatewayFetch sends the csrf header and no authorization for an owner, and a key only when typed", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url, headers: init.headers, credentials: init.credentials });
    return fakeResponse(200, { data: [] });
  });
  const api = { csrfHeaders: () => ({ "x-csrf-token": "tok" }) };
  await gatewayFetch(api, "/gateway/auto/openai/v1/models", {});
  await gatewayFetch(api, "/gateway/auto/openai/v1/models", { key: "test-key-1" });
  assert.equal(seen[0].headers["x-csrf-token"], "tok");
  assert.equal("authorization" in seen[0].headers, false);
  assert.equal(seen[0].credentials, "same-origin");
  assert.equal(seen[1].headers.authorization, "Bearer test-key-1");
});

test("a 403 csrf_invalid re-reads /api/session and retries exactly once", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls += 1;
    return init.headers["x-csrf-token"] === "fresh" ? fakeResponse(200, { ok: true }) : fakeResponse(403, { error: { code: "csrf_invalid" } });
  });
  let token = "stale";
  const api = {
    csrfHeaders: () => ({ "x-csrf-token": token }),
    get: async (url) => {
      assert.equal(url, "/api/session");
      return { csrfToken: "fresh" };
    },
    setCsrfToken: (next) => { token = next; },
  };
  const response = await gatewayFetch(api, "/gateway/auto/openai/v1/chat/completions", { method: "POST", body: { a: 1 } });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);

  calls = 0;
  token = "stale";
  const stuck = { ...api, get: async () => ({ csrfToken: "still-wrong" }), setCsrfToken: (next) => { token = next; } };
  const failed = await gatewayFetch(stuck, "/gateway/auto/openai/v1/chat/completions", { method: "POST", body: {} });
  assert.equal(failed.status, 403);
  assert.equal(calls, 2);
});
