"use strict";

// The public API surface (05 §8, PUB-12): the route mapping table, the
// max_tokens injection and rejection, public aliases with the engine filter,
// the enriched /v1/models (golden) and /gateway/status.
//
// The pure parts run on fixtures. The request flow runs the real entry
// in-process on PUBLIC with two fake managers on the ports the entry
// reads at load; the access store and telemetry live in a temp dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { listen, loadEntry, request } = require("./helpers/entry-harness");
const { scopeForGatewayPath } = require("../lib/gateway-pipeline");
const modelFleet = require("../lib/model-fleet");
const {
  anthropicModelsDocument,
  applyOutputCap,
  buildModelEntries,
  formatCredits,
  gatewayPathFor,
  mapPublicRoute,
  modelReadOf,
  openAiModelsDocument,
  parseGatewayRoute,
} = require("../lib/public-api");
const { classifyPublicRoute } = require("../lib/public-listener");

const GOLDEN_PATH = path.join(__dirname, "golden", "v1-models.json");

// ---- the route mapping table (§8.1) -------------------------------------------

// [method, public path, family, scope, engine, protocol, errors, ADMIN-form path]
const ROUTES = [
  ["GET", "/v1/models", "models", "models.read", "auto", "openai", "openai", "/gateway/auto/openai/v1/models"],
  ["GET", "/v1/models/qwen3.8-35b-a3b", "model", "models.read", "auto", "openai", "openai", "/gateway/auto/openai/v1/models/qwen3.8-35b-a3b"],
  ["GET", "/v1/models/org/name", "model", "models.read", "auto", "openai", "openai", "/gateway/auto/openai/v1/models/org/name"],
  ["POST", "/v1/chat/completions", "inference", "chat", "auto", "openai", "openai", "/gateway/auto/openai/v1/chat/completions"],
  ["POST", "/v1/completions", "inference", "completions", "auto", "openai", "openai", "/gateway/auto/openai/v1/completions"],
  ["POST", "/v1/responses", "inference", "responses", "auto", "openai", "openai", "/gateway/auto/openai/v1/responses"],
  ["POST", "/v1/embeddings", "inference", "embeddings", "auto", "openai", "openai", "/gateway/auto/openai/v1/embeddings"],
  ["POST", "/v1/rerank", "inference", "embeddings", "auto", "openai", "openai", "/gateway/auto/openai/v1/rerank"],
  ["POST", "/v1/score", "inference", "embeddings", "auto", "openai", "openai", "/gateway/auto/openai/v1/score"],
  ["POST", "/v1/audio/speech", "tts", "audio.speech", "auto", null, "openai", "/gateway/tts/openai/v1/audio/speech"],
  ["POST", "/anthropic/v1/messages", "messages", "messages", "auto", "claude", "anthropic", "/gateway/auto/claude/v1/messages"],
  ["POST", "/anthropic/v1/messages/count_tokens", "messages", "messages", "auto", "claude", "anthropic", "/gateway/auto/claude/v1/messages/count_tokens"],
  ["GET", "/anthropic/v1/models", "models", "models.read", "auto", "claude", "anthropic", "/gateway/auto/claude/v1/models"],
  ["GET", "/anthropic/v1/models/qwen-chat", "model", "models.read", "auto", "claude", "anthropic", "/gateway/auto/claude/v1/models/qwen-chat"],
  ["POST", "/v1/messages", "messages", "messages", "auto", "claude", "anthropic", "/gateway/auto/claude/v1/messages"],
  ["POST", "/v1/messages/count_tokens", "messages", "messages", "auto", "claude", "anthropic", "/gateway/auto/claude/v1/messages/count_tokens"],
  ["GET", "/vllm/v1/models", "models", "models.read", "vllm", "openai", "openai", "/gateway/vllm/openai/v1/models"],
  ["POST", "/vllm/v1/chat/completions", "inference", "chat", "vllm", "openai", "openai", "/gateway/vllm/openai/v1/chat/completions"],
  ["POST", "/vllm/v1/messages", "messages", "messages", "vllm", "claude", "anthropic", "/gateway/vllm/claude/v1/messages"],
  ["GET", "/llama/v1/models", "models", "models.read", "llama", "openai", "openai", "/gateway/llama/openai/v1/models"],
  ["POST", "/llama/v1/completions", "inference", "completions", "llama", "openai", "openai", "/gateway/llama/openai/v1/completions"],
  ["POST", "/llama/v1/embeddings", "inference", "embeddings", "llama", "openai", "openai", "/gateway/llama/openai/v1/embeddings"],
  ["GET", "/gateway/status", "status", "models.read", "auto", null, "openai", "/gateway/status"],
  ["GET", "/gateway/me", "me", "self.read", "auto", null, "openai", "/gateway/me"],
  ["GET", "/v1/me", "me", "self.read", "auto", null, "openai", "/gateway/me"],
  ["GET", "/v1/me/usage", "me", "self.read", "auto", null, "openai", "/gateway/me/usage"],
  ["GET", "/v1/me/usage.csv", "me", "self.read", "auto", null, "openai", "/gateway/me/usage.csv"],
  ["GET", "/v1/me/requests", "me", "self.read", "auto", null, "openai", "/gateway/me/requests"],
  ["POST", "/v1/me/rotate", "me", "self.rotate", "auto", null, "openai", "/gateway/me/rotate"],
  ["PUT", "/v1/me/origins", "me", "self.origins", "auto", null, "openai", "/gateway/me/origins"],
  ["POST", "/gateway/tts/openai/v1/audio/speech", "tts", "audio.speech", "auto", null, "openai", "/gateway/tts/openai/v1/audio/speech"],
  ["POST", "/gateway/auto/openai/v1/chat/completions", "gateway", "chat", "auto", "openai", "openai", "/gateway/auto/openai/v1/chat/completions"],
  ["POST", "/gateway/vllm/claude/v1/messages", "gateway", "messages", "vllm", "claude", "anthropic", "/gateway/vllm/claude/v1/messages"],
  ["POST", "/gateway/llama/opencode/v1/chat/completions", "gateway", "chat", "llama", "opencode", "openai", "/gateway/llama/opencode/v1/chat/completions"],
  ["GET", "/gateway/auto/openai/v1/models", "gateway", "models.read", "auto", "openai", "openai", "/gateway/auto/openai/v1/models"],
  ["POST", "/gateway/auto/openai/v1/embeddings", "gateway", "embeddings", "auto", "openai", "openai", "/gateway/auto/openai/v1/embeddings"],
  ["POST", "/gateway/sglang/openai/v1/chat/completions", "gateway", "chat", "auto", "openai", "openai", "/gateway/sglang/openai/v1/chat/completions"],
  ["GET", "/gateway/external/my-api/openai/v1/models", "gateway", "models.read", "auto", "openai", "openai", "/gateway/external/my-api/openai/v1/models"],
];

test("the route mapping table of 05 §8.1", () => {
  for (const [method, pathname, family, scope, engine, protocol, errors, gatewayPath] of ROUTES) {
    const mapped = mapPublicRoute(method, pathname);
    assert.ok(mapped && !mapped.methodNotAllowed, `${method} ${pathname}`);
    assert.deepEqual(
      { family: mapped.family, scope: mapped.scope, engine: mapped.engine, protocol: mapped.protocol, errors: mapped.errors, gatewayPath: mapped.gatewayPath },
      { family, scope, engine, protocol, errors, gatewayPath },
      `${method} ${pathname}`,
    );
    assert.equal(gatewayPathFor(pathname), gatewayPath, `gatewayPathFor ${pathname}`);
    // The listener classifies the same row as a key route carrying the mapping.
    const classified = classifyPublicRoute(method, pathname);
    assert.equal(classified.kind, "key", `${method} ${pathname}`);
    assert.equal(classified.gatewayPath, gatewayPath);
    assert.equal(classified.api.family, family);
  }
});

test("engine ids and external endpoints ride beside the engine filter", () => {
  assert.deepEqual(mapPublicRoute("POST", "/gateway/sglang/openai/v1/chat/completions").engineId, "sglang");
  assert.equal(mapPublicRoute("GET", "/gateway/external/my-api/openai/v1/models").externalId, "my-api");
  assert.deepEqual(parseGatewayRoute("/gateway/auto/openai/v1/models"), { engine: "auto", protocol: "openai", rest: "v1/models" });
  assert.deepEqual(parseGatewayRoute("/gateway/llama/claude/v1/messages"), { engine: "llama", protocol: "claude", rest: "v1/messages" });
  assert.deepEqual(parseGatewayRoute("/gateway/sglang/opencode/v1/models"), { engine: "auto", engineId: "sglang", protocol: "opencode", rest: "v1/models" });
  assert.deepEqual(parseGatewayRoute("/gateway/external/my-api/openai/v1/models"), { engine: "auto", externalId: "my-api", protocol: "openai", rest: "v1/models" });
  // The other gateway namespaces are never engine ids.
  for (const bad of ["/gateway/tts/openai/v1/models", "/gateway/mcp/openai/x", "/gateway/search/openai/x", "/gateway/status/openai/x", "/gateway/auto/nonsense/v1", "/gateway/auto", "/gateway/external/openai/v1", "/api/status"]) {
    assert.equal(parseGatewayRoute(bad), null, bad);
  }
});

test("scopes in the mapping equal what the pipeline judges for the ADMIN-form path", () => {
  for (const [method, pathname, , scope, , , , gatewayPath] of ROUTES) {
    const mapped = mapPublicRoute(method, pathname);
    if (["tts", "status", "me", "gateway", "models", "model", "inference", "messages"].includes(mapped.family) && !gatewayPath.startsWith("/gateway/me")) {
      const route = parseGatewayRoute(gatewayPath);
      assert.equal(scopeForGatewayPath(gatewayPath, method, route), scope, `${method} ${pathname}`);
    }
  }
});

test("a known path with the wrong method answers 405 with the allowed ones; unknown paths are not routes", () => {
  const wrong = [
    ["GET", "/v1/chat/completions", "POST"],
    ["PUT", "/v1/models", "GET"],
    ["DELETE", "/anthropic/v1/messages", "POST"],
    ["GET", "/v1/audio/speech", "POST"],
    ["POST", "/gateway/status", "GET"],
    ["GET", "/v1/me/rotate", "POST"],
    ["POST", "/llama/v1/models", "GET"],
  ];
  for (const [method, pathname, allowed] of wrong) {
    const mapped = mapPublicRoute(method, pathname);
    assert.equal(mapped.methodNotAllowed, true, `${method} ${pathname}`);
    assert.ok(mapped.allow.split(", ").includes(allowed), mapped.allow);
    assert.ok(mapped.allow.split(", ").includes("OPTIONS"), "the preflight is always allowed");
    assert.equal(classifyPublicRoute(method, pathname).kind, "method_not_allowed");
  }
  // OPTIONS goes through everywhere, HEAD wherever GET does.
  assert.equal(mapPublicRoute("OPTIONS", "/v1/chat/completions").methodNotAllowed, undefined);
  assert.equal(mapPublicRoute("HEAD", "/v1/models").methodNotAllowed, undefined);
  for (const pathname of [
    "/v1", "/v1/", "/v1/files", "/v1/chat", "/v1/models/", "/v2/models", "/anthropic/v1/chat/completions", "/anthropic/v1/embeddings", "/vllm/v1/audio/speech",
    "/llama/v1/me", "/v1/me/other", "/gateway/tts/api/voices", "/gateway/mcp", "/gateway/search/v1/x", "/v1/../api/status", "/v1//models", "/api/status", "/internal/billing/authorize",
  ]) {
    const mapped = mapPublicRoute("GET", pathname);
    // "/v1/models/" names the list (a trailing slash is ignored); the rest are not routes.
    if (pathname === "/v1/models/") assert.equal(mapped?.family, "models");
    else assert.equal(mapped, null, pathname);
  }
});

test("a model read is a list or one model, on OpenAI and (when asked) Anthropic routes", () => {
  assert.deepEqual(modelReadOf("GET", { protocol: "openai", rest: "v1/models" }), { kind: "list" });
  assert.deepEqual(modelReadOf("GET", { protocol: "opencode", rest: "models" }), { kind: "list" });
  assert.deepEqual(modelReadOf("GET", { protocol: "openai", rest: "v1/models/org%2Fname" }), { kind: "one", id: "org/name" });
  assert.equal(modelReadOf("GET", { protocol: "claude", rest: "v1/models" }), null);
  assert.deepEqual(modelReadOf("GET", { protocol: "claude", rest: "v1/models" }, { anthropic: true }), { kind: "list" });
  assert.equal(modelReadOf("POST", { protocol: "openai", rest: "v1/models" }), null);
  assert.equal(modelReadOf("GET", { protocol: "openai", rest: "v1/chat/completions" }), null);
});

// ---- max_tokens (§8.2 step 10) --------------------------------------------------

test("applyOutputCap injects the cap, keeps explicit values within it and rejects values above it", () => {
  const chat = applyOutputCap({ model: "m", messages: [] }, { cap: 512, scope: "chat", rest: "v1/chat/completions" });
  assert.equal(chat.ok, true);
  assert.equal(chat.injected, "max_tokens");
  assert.equal(chat.body.max_tokens, 512);
  assert.equal(chat.body.model, "m");

  const responses = applyOutputCap({ model: "m", input: "hi" }, { cap: 512, scope: "responses", rest: "v1/responses" });
  assert.equal(responses.injected, "max_output_tokens");
  assert.equal(responses.body.max_output_tokens, 512);
  const messages = applyOutputCap({ model: "m", messages: [] }, { cap: 300, scope: "messages", rest: "v1/messages" });
  assert.equal(messages.body.max_tokens, 300);
  assert.equal(applyOutputCap({ prompt: "x" }, { cap: 99.9, scope: "completions", rest: "v1/completions" }).body.max_tokens, 99);

  // Within the cap, and any one of the three fields counts as "given".
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const given = { model: "m", [field]: 512 };
    const kept = applyOutputCap(given, { cap: 512, scope: "chat", rest: "v1/chat/completions" });
    assert.equal(kept.ok, true, field);
    assert.equal(kept.injected, null);
    assert.equal(kept.body, given, "the body is the caller's object when nothing changed");
  }

  // Above the cap: refused with the field's name, first the one that is too big.
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const over = applyOutputCap({ model: "m", [field]: 513 }, { cap: 512, scope: "chat", rest: "v1/chat/completions" });
    assert.equal(over.ok, false, field);
    assert.equal(over.param, field);
    assert.equal(over.cap, 512);
  }
  const mixed = applyOutputCap({ max_tokens: 10, max_completion_tokens: 9000 }, { cap: 512, scope: "chat", rest: "v1/chat/completions" });
  assert.equal(mixed.param, "max_completion_tokens");
  assert.equal(String(mixed.requested), "9000");
});

test("applyOutputCap leaves non-token endpoints, no cap and odd bodies alone", () => {
  const embeddings = { model: "e", input: "x" };
  assert.equal(applyOutputCap(embeddings, { cap: 10, scope: "embeddings", rest: "v1/embeddings" }).body, embeddings);
  const counting = { model: "m", messages: [] };
  const counted = applyOutputCap(counting, { cap: 10, scope: "messages", rest: "v1/messages/count_tokens" });
  assert.equal(counted.body, counting);
  assert.equal(counted.injected, null);
  const none = { model: "m" };
  assert.equal(applyOutputCap(none, { cap: null, scope: "chat", rest: "v1/chat/completions" }).body, none);
  assert.equal(applyOutputCap(none, { cap: 0, scope: "chat", rest: "v1/chat/completions" }).body, none);
  assert.equal(applyOutputCap(none, { cap: 10, scope: "models.read", rest: "v1/models" }).body, none);
  assert.equal(applyOutputCap(null, { cap: 10, scope: "chat", rest: "x" }).body, null);
  const list = [1];
  assert.equal(applyOutputCap(list, { cap: 10, scope: "chat", rest: "x" }).body, list);
  // An unparseable explicit value is the upstream's to judge.
  assert.equal(applyOutputCap({ max_tokens: "lots" }, { cap: 10, scope: "chat", rest: "v1/chat/completions" }).ok, true);
});

// ---- the enriched model list (§8.3) ----------------------------------------------

test("formatCredits writes microcredits per million as credits with two to six decimals", () => {
  assert.equal(formatCredits("500000"), "0.50");
  assert.equal(formatCredits("50000"), "0.05");
  assert.equal(formatCredits("2000000"), "2.00");
  assert.equal(formatCredits("52000"), "0.052");
  assert.equal(formatCredits(1234567), "1.234567");
  assert.equal(formatCredits("0"), "0.00");
  assert.equal(formatCredits(""), null);
  assert.equal(formatCredits("abc"), null);
});

// The fleet of the golden: what normalizeManagerInstances makes of manager
// payloads, so the shapes are the ones the entry really sees.
function fixtureCatalogs() {
  const vllm = { id: "vllm", name: "vLLM manager" };
  const llama = { id: "llama", name: "llama.cpp manager" };
  const vllmInstances = modelFleet.normalizeManagerInstances(vllm, {
    instances: [
      {
        id: "primary", primary: true, running: true, status: "running", engineId: "sglang", port: 8000, containerName: "engine-a",
        apiSurface: { chat: true, completions: true, responses: false, messages: true, embeddings: false },
        capabilities: { maxContext: 262144, reasoning: true },
        models: [{
          id: "qwen3.8-35b-a3b", family: "qwen3.8", parameters: "35B-A3B", quantization: "fp8", max_model_len: 131072, max_output_tokens: 16384, created: 1760400000,
          capabilities: ["text", "vision", "tools"],
          controls: { reasoningToggle: { on: { chat_template_kwargs: { enable_thinking: true } }, off: { chat_template_kwargs: { enable_thinking: false } } } },
        }],
      },
      { id: "embed", running: true, status: "running", port: 8001, models: [{ id: "bge-m3", family: "bge", parameters: "568M", quantization: "fp16", max_model_len: 8192, capabilities: ["embedding"] }] },
      { id: "warming", running: true, status: "starting", port: 8002, models: [{ id: "next-model-7b" }] },
      { id: "nap", running: false, status: "exited", lifecycle: { state: "sleeping" }, port: 8003, models: [{ id: "sleepy-model-8b", lastKnown: true }] },
      { id: "gone", running: false, status: "exited", port: 8004, models: [{ id: "stopped-model-8b" }] },
      { id: "private", running: true, status: "running", port: 8005, models: [{ id: "private-model-8b" }, { id: "hidden-model-8b" }, { id: "D:\\models\\raw-path-model" }] },
    ],
  });
  const llamaInstances = modelFleet.normalizeManagerInstances(llama, {
    instances: [{ id: "primary", primary: true, running: true, status: "running", port: 8100, models: [{ id: "gemma-3-4b-it-q4_k_m", context_length: 32768, quantization: "Q4_K_M", capabilities: ["text"] }] }],
  });
  return [
    { manager: vllm, listening: true, running: true, instances: vllmInstances, models: modelFleet.flattenCatalogModels(vllmInstances) },
    { manager: llama, listening: true, running: true, instances: llamaInstances, models: modelFleet.flattenCatalogModels(llamaInstances) },
  ];
}

const META = [
  { modelId: "qwen3.8-35b-a3b", displayName: { zh: "通义千问 3.8 35B A3B", en: "Qwen3.8 35B A3B" }, description: { zh: null, en: null }, aliases: ["qwen3.8", "chat"], hidden: false, recommended: true, sort: -1, updatedAt: "2026-10-01T00:00:00.000Z" },
  { modelId: "hidden-model-8b", displayName: { zh: null, en: null }, description: { zh: null, en: null }, aliases: [], hidden: true, recommended: false, sort: 0, updatedAt: "2026-10-01T00:00:00.000Z" },
];
const PRICES = new Map([["qwen3.8-35b-a3b", { input: "500000", cachedInput: "50000", output: "2000000" }]]);

function goldenEntries(overrides = {}) {
  return buildModelEntries({
    catalogs: fixtureCatalogs(),
    metaList: META,
    limits: { rpm: 30, tpm: 100000, outputCap: 8192 },
    showPrices: true,
    getPrice: (model) => PRICES.get(model.id) || null,
    ttsModels: [{ id: "tts-demo", name: "Demo voice" }],
    language: "en-US",
    modelOk: (model) => model.id !== "private-model-8b",
    ...overrides,
  });
}

test("the enriched /v1/models matches the golden and carries no engine, manager, instance or port", () => {
  const document = openAiModelsDocument(goldenEntries());
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN_PATH, text);
  assert.deepEqual(document, JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")));

  assert.deepEqual(document.data.map((entry) => entry.id), ["qwen3.8-35b-a3b", "bge-m3", "gemma-3-4b-it-q4_k_m", "next-model-7b", "sleepy-model-8b", "tts-demo"]);
  const keys = [];
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((item) => walk(item, trail));
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        keys.push(key);
        walk(item, `${trail}.${key}`);
      }
    }
    return undefined;
  };
  walk(document, "");
  for (const key of keys) assert.doesNotMatch(key, /engine|manager|instance|port|container|runtime|host|path|image|gpu/i, `field ${key}`);
  const raw = JSON.stringify(document);
  assert.doesNotMatch(raw, /sglang|vllm|llama\.cpp|"llama"|engine-a|8000|8100|raw-path-model|private-model|hidden-model|stopped-model/, "no internals, no filtered models");
  for (const entry of document.data) assert.equal(entry.owned_by, "local");
});

test("the enriched list states, capabilities, limits and prices follow §8.3", () => {
  const byId = new Map(goldenEntries().map((entry) => [entry.id, entry]));
  const qwen = byId.get("qwen3.8-35b-a3b");
  assert.equal(qwen.state, "ready");
  assert.equal(qwen.context_length, 262144, "the instance's declared maxContext wins");
  assert.equal(qwen.max_output_tokens, 8192, "min(model maximum 16384, key cap 8192)");
  assert.deepEqual(qwen.pricing, { unit: "credits_per_million_tokens", input: "0.50", cached_input: "0.05", output: "2.00" });
  assert.deepEqual(qwen.capabilities, { chat: true, completions: true, responses: false, messages: true, embeddings: false, vision: true, tools: true, reasoning: true, audio_speech: false });
  assert.deepEqual(Object.keys(qwen.controls), ["reasoning_toggle"]);
  assert.deepEqual(qwen.limits, { rpm: 30, tpm: 100000, max_output_tokens: 8192 });
  assert.deepEqual(qwen.aliases, ["qwen3.8", "chat"]);
  assert.equal(byId.get("next-model-7b").state, "starting");
  assert.equal(byId.get("sleepy-model-8b").state, "sleeping");
  assert.equal(byId.get("bge-m3").capabilities.embeddings, true);
  assert.equal(byId.get("bge-m3").capabilities.chat, false);
  assert.equal(byId.get("bge-m3").max_output_tokens, null, "an embedding model generates no tokens");
  assert.equal(byId.get("bge-m3").pricing, undefined, "no price, no pricing");
  assert.equal(byId.get("bge-m3").controls, undefined, "controls only when the model card declares the toggle");
  assert.equal(byId.get("tts-demo").capabilities.audio_speech, true);
  assert.equal(byId.get("tts-demo").state, "ready");
  assert.equal(byId.has("stopped-model-8b"), false, "a stopped instance offers nothing");
  assert.equal(byId.has("hidden-model-8b"), false, "hidden by the owner");
  assert.equal(byId.has("private-model-8b"), false, "the key may not use it");

  // showPrices false drops every price; the zh display name follows the language.
  assert.equal(goldenEntries({ showPrices: false }).some((entry) => entry.pricing), false);
  assert.equal(goldenEntries({ language: "zh-CN" })[0].display_name, "通义千问 3.8 35B A3B");
  // No TTS entries unless asked for; no cap and no model maximum is null.
  assert.equal(goldenEntries({ ttsModels: [] }).some((entry) => entry.id === "tts-demo"), false);
  assert.equal(goldenEntries({ limits: {} }).find((entry) => entry.id === "next-model-7b").max_output_tokens, null);
  // The engine filter of /vllm/v1 narrows by the instance's manager.
  const onlyLlama = goldenEntries({ ttsModels: [], instanceOk: (catalog) => catalog.manager.id === "llama" });
  assert.deepEqual(onlyLlama.map((entry) => entry.id), ["gemma-3-4b-it-q4_k_m"]);
});

test("the Anthropic list carries the same models in the Anthropic shape", () => {
  const document = anthropicModelsDocument(goldenEntries({ ttsModels: [] }));
  assert.equal(document.has_more, false);
  assert.equal(document.first_id, "qwen3.8-35b-a3b");
  assert.equal(document.last_id, document.data.at(-1).id);
  assert.deepEqual(document.data[0], {
    type: "model", id: "qwen3.8-35b-a3b", display_name: "Qwen3.8 35B A3B", created_at: "2025-10-14T00:00:00.000Z", max_input_tokens: 262144, max_tokens: 8192,
  });
});

// ---- the request flow ---------------------------------------------------------------

const ORIGIN = "https://app.example.com";
const servers = [];
const hits = [];
let entry = null;
let publicPort = 0;
let holdUpstream = false;
const held = [];

function fakeManager(managerId, instances) {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/instances") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ instances }));
    }
    if (url.pathname === "/api/manager/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, gatewayTrust: { version: 2, mode: "warn" } }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        body = null;
      }
      hits.push({ manager: managerId, method: req.method, path: url.pathname, headers: { ...req.headers }, body });
      const answer = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "cmpl-test", model: body?.model || null, choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      };
      if (holdUpstream && url.pathname.endsWith("/chat/completions")) held.push(answer);
      else answer();
    });
    return undefined;
  });
}

async function setup() {
  if (entry) return;
  const loaded = await loadEntry();
  entry = loaded.entry;
  const vllm = fakeManager("vllm", [
    { id: "primary", primary: true, running: true, status: "running", engineId: "vllm", models: [{ id: "qwen-chat", max_model_len: 32768 }] },
    { id: "sg", running: true, status: "running", engineId: "sglang", models: [{ id: "sg-model" }] },
    { id: "side", running: true, status: "running", models: [{ id: "secret-model" }] },
    { id: "embed", running: true, status: "running", models: [{ id: "bge-embed", capabilities: ["embedding"] }] },
  ]);
  const llama = fakeManager("llama", [{ id: "primary", primary: true, running: true, status: "running", models: [{ id: "gemma-gguf" }] }]);
  await new Promise((resolve) => vllm.listen(Number(process.env.VLLM_MANAGER_PORT), "127.0.0.1", resolve));
  await new Promise((resolve) => llama.listen(Number(process.env.LLAMA_MANAGER_PORT), "127.0.0.1", resolve));
  const pub = entry.createPublicServer();
  servers.push(vllm, llama, pub);
  publicPort = await listen(pub);
  const store = entry.getAccessStore();
  store.modelMeta.upsert("qwen-chat", { displayName: { en: "Qwen Chat", zh: "千问对话" }, aliases: ["chat", "default-chat"] }, { actor: "test" });
  store.modelMeta.upsert("gemma-gguf", { aliases: ["gemma"], sort: 5 }, { actor: "test" });
  store.modelMeta.upsert("sg-model", { hidden: true }, { actor: "test" });
}

test.after(async () => {
  holdUpstream = false;
  while (held.length) held.shift()();
  await entry?.stopTelemetry();
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  entry?.closeAccessStore();
  try {
    entry?.getBillingStore().close();
  } catch {
    // Already closed.
  }
});

let keySeq = 0;
function createKey(input = {}) {
  keySeq += 1;
  const { key, secret } = entry.getAccessStore().createKey({
    class: "friend",
    models: ["*"],
    scopes: ["models.read", "chat", "completions", "responses", "messages", "embeddings"],
    ...input,
    name: `public api key ${keySeq}`,
  }, { actor: "test" });
  return { id: key.id, secret };
}

function call(key, pathname, { method = "GET", body, headers = {}, claude = false } = {}) {
  const auth = claude ? { "x-api-key": key.secret } : { authorization: `Bearer ${key.secret}` };
  return request(publicPort, pathname, { method, headers: { host: "127.0.0.1", ...auth, ...headers }, body });
}

function chat(key, body = {}, pathname = "/v1/chat/completions", headers = {}) {
  return call(key, pathname, { method: "POST", headers, body: { model: "qwen-chat", messages: [{ role: "user", content: "hi" }], ...body } });
}

const lastHit = (since) => hits.slice(since).at(-1);

test("a key lists the enriched models it may use, and only those", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ models: ["qwen-*", "gemma-gguf"], limits: { rpm: 30, tpm: 100000, maxOutputTokens: 4096 } });
  const answer = await call(key, "/v1/models");
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.json.object, "list");
  assert.deepEqual(answer.json.data.map((item) => item.id), ["qwen-chat", "gemma-gguf"]);
  const qwen = answer.json.data[0];
  assert.equal(qwen.object, "model");
  assert.equal(qwen.owned_by, "local");
  assert.equal(qwen.display_name, "Qwen Chat");
  assert.deepEqual(qwen.aliases, ["chat", "default-chat"]);
  assert.equal(qwen.context_length, 32768);
  assert.equal(qwen.max_output_tokens, 4096);
  assert.equal(qwen.state, "ready");
  assert.deepEqual(qwen.limits, { rpm: 30, tpm: 100000, max_output_tokens: 4096 });
  assert.doesNotMatch(answer.text, /sglang|"vllm"|"llama"|secret-model|sg-model|"port"|"engine"|127\.0\.0\.1/);
  assert.match(answer.headers["x-request-id"], /^req_[a-z2-7]{20}$/);
  assert.equal(answer.headers["x-ratelimit-limit-requests"], "30");
  assert.equal(answer.headers["cache-control"], "no-store");

  // One model by id, by public alias, and a missing one.
  const one = await call(key, "/v1/models/qwen-chat");
  assert.equal(one.status, 200);
  assert.equal(one.json.id, "qwen-chat");
  assert.equal(one.json.object, "model");
  assert.equal((await call(key, "/v1/models/gemma")).json.id, "gemma-gguf");
  const missing = await call(key, "/v1/models/secret-model");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "model_not_found");
  assert.equal(missing.json.error.param, "model");
  assert.equal((await call(key, "/v1/models/sg-model")).status, 404, "not allowed by the key");

  // The engine-filtered aliases list only what that manager hosts; the answer
  // never says which manager it was.
  const onVllm = await call(createKey({ models: ["*"] }), "/vllm/v1/models");
  assert.deepEqual(onVllm.json.data.map((item) => item.id), ["bge-embed", "qwen-chat", "secret-model"]);
  const onLlama = await call(createKey({ models: ["*"] }), "/llama/v1/models");
  assert.deepEqual(onLlama.json.data.map((item) => item.id), ["gemma-gguf"]);
  const onSglang = await call(createKey({ models: ["*"] }), "/gateway/sglang/openai/v1/models");
  assert.equal(onSglang.status, 200);
  assert.deepEqual(onSglang.json.data.map((item) => item.id), [], "sg-model is hidden from listings");
  const onVllmEngine = await call(createKey({ models: ["*"] }), "/gateway/vllm/openai/v1/models");
  assert.deepEqual(onVllmEngine.json.data.map((item) => item.id), ["bge-embed", "qwen-chat", "secret-model"]);

  // Without the scope it is scope_denied, in the OpenAI shape.
  const noScope = await call(createKey({ scopes: ["chat"] }), "/v1/models");
  assert.equal(noScope.status, 403);
  assert.equal(noScope.json.error.code, "scope_denied");
});

test("the Anthropic list and an Anthropic error use the Anthropic shapes", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ models: ["qwen-*"], limits: { maxOutputTokens: 1000 } });
  const list = await call(key, "/anthropic/v1/models", { claude: true });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.data.map((item) => [item.type, item.id]), [["model", "qwen-chat"]]);
  assert.equal(list.json.has_more, false);
  assert.equal(list.json.first_id, "qwen-chat");
  assert.match(list.json.data[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
  const one = await call(key, "/anthropic/v1/models/qwen-chat", { claude: true });
  assert.equal(one.json.type, "model");

  const over = await call(key, "/anthropic/v1/messages", { method: "POST", claude: true, body: { model: "qwen-chat", max_tokens: 5000, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(over.status, 400);
  assert.equal(over.json.type, "error");
  assert.equal(over.json.error.type, "invalid_request_error");
  assert.match(over.json.request_id, /^req_[a-z2-7]{20}$/);
  assert.equal(over.json.error.code, undefined, "the Anthropic shape has no code field");

  // A refusal of the limiter on an Anthropic route: Anthropic shape, retry-after, Anthropic rate headers.
  const limited = createKey({ limits: { rpm: 1, tpm: null, maxOutputTokens: 100 } });
  const ask = () => call(limited, "/v1/messages", { method: "POST", claude: true, body: { model: "qwen-chat", max_tokens: 10, messages: [{ role: "user", content: "hi" }] } });
  const accepted = await ask();
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.headers["anthropic-ratelimit-requests-limit"], "1");
  const refused = await ask();
  assert.equal(refused.status, 429);
  assert.equal(refused.json.type, "error");
  assert.equal(refused.json.error.type, "rate_limit_error");
  assert.ok(Number(refused.headers["retry-after"]) >= 1);

  for (const [method, pathname] of [["POST", "/anthropic/v1/messages"], ["POST", "/v1/messages"], ["GET", "/anthropic/v1/models"], ["POST", "/vllm/v1/messages"]]) {
    const denied = await request(publicPort, pathname, { method, headers: { host: "127.0.0.1" }, body: method === "POST" ? {} : undefined });
    assert.equal(denied.status, 401, `${method} ${pathname}`);
    assert.equal(denied.json.type, "error", `${method} ${pathname}`);
    assert.equal(denied.json.error.type, "authentication_error");
  }
  const wrongMethod = await request(publicPort, "/anthropic/v1/messages", { headers: { host: "127.0.0.1" } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.type, "error");
  assert.match(wrongMethod.headers.allow, /POST/);
  const openai = await request(publicPort, "/v1/chat/completions", { headers: { host: "127.0.0.1" } });
  assert.equal(openai.status, 405);
  assert.equal(openai.json.error.code, "method_not_allowed");
});

test("max_tokens: a missing value gets the key's cap, a value above it is refused with its name", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ limits: { maxOutputTokens: 256 } });

  let before = hits.length;
  const injected = await chat(key);
  assert.equal(injected.status, 200, injected.text);
  assert.equal(lastHit(before).body.max_tokens, 256, "the cap was injected into the forwarded body");
  assert.equal(lastHit(before).body.model, "qwen-chat");

  before = hits.length;
  const within = await chat(key, { max_tokens: 100 });
  assert.equal(within.status, 200);
  assert.equal(lastHit(before).body.max_tokens, 100);

  before = hits.length;
  const over = await chat(key, { max_completion_tokens: 257 });
  assert.equal(over.status, 400);
  assert.equal(over.json.error.code, "max_tokens_exceeded");
  assert.equal(over.json.error.param, "max_completion_tokens");
  assert.equal(over.json.error.type, "invalid_request_error");
  assert.match(over.json.request_id, /^req_[a-z2-7]{20}$/);
  assert.equal(hits.length, before, "nothing reached the manager");
  assert.doesNotMatch(over.text, /\d{4,5}|[A-Za-z]:\\/);

  // /v1/responses uses max_output_tokens; embeddings take neither.
  before = hits.length;
  const responses = await call(key, "/v1/responses", { method: "POST", body: { model: "qwen-chat", input: "hi" } });
  assert.equal(responses.status, 200, responses.text);
  assert.equal(lastHit(before).body.max_output_tokens, 256);
  assert.equal(lastHit(before).body.max_tokens, undefined);
  before = hits.length;
  const embeddings = await call(key, "/v1/embeddings", { method: "POST", body: { model: "bge-embed", input: "hi" } });
  assert.equal(embeddings.status, 200, embeddings.text);
  assert.equal(lastHit(before).body.max_tokens, undefined);
  assert.equal(lastHit(before).body.max_output_tokens, undefined);

  // A key with no cap of its own on PUBLIC uses public.defaults; an owner key none.
  before = hits.length;
  assert.equal((await chat(createKey({ class: "owner" }))).status, 200);
  assert.equal(lastHit(before).body.max_tokens, undefined, "owner keys are not capped by the defaults");
  before = hits.length;
  assert.equal((await chat(createKey({}))).status, 200);
  assert.equal(lastHit(before).body.max_tokens, 8192, "public.defaults.maxOutputTokens");

  // A compressed body is re-serialized without its content-encoding.
  const zlib = require("node:zlib");
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify({ model: "qwen-chat", messages: [{ role: "user", content: "hi" }] })));
  before = hits.length;
  const gz = await request(publicPort, "/v1/chat/completions", { method: "POST", body: raw, headers: { host: "127.0.0.1", authorization: `Bearer ${key.secret}`, "content-encoding": "gzip" } });
  assert.equal(gz.status, 200, gz.text);
  assert.equal(lastHit(before).body.max_tokens, 256);
  assert.equal(lastHit(before).headers["content-encoding"], undefined);
});

test("public aliases resolve before routing and keep the engine filter", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ limits: { maxOutputTokens: 100 } });

  let before = hits.length;
  const viaAlias = await chat(key, { model: "chat" });
  assert.equal(viaAlias.status, 200, viaAlias.text);
  assert.equal(lastHit(before).manager, "vllm");
  assert.equal(lastHit(before).body.model, "qwen-chat", "the body is rewritten to the model id");
  before = hits.length;
  assert.equal((await chat(key, { model: "DEFAULT-CHAT" })).status, 200, "aliases are case-insensitive");
  assert.equal(lastHit(before).body.model, "qwen-chat");

  // On /vllm/v1 the alias of a vllm model works; the alias of a llama model does not.
  before = hits.length;
  assert.equal((await chat(key, { model: "chat" }, "/vllm/v1/chat/completions")).status, 200);
  assert.equal(lastHit(before).manager, "vllm");
  const crossed = await chat(key, { model: "gemma" }, "/vllm/v1/chat/completions");
  assert.equal(crossed.status, 404, "the engine filter is kept after the alias is resolved");
  assert.equal(crossed.json.error.code, "model_not_found");
  const crossedBack = await chat(key, { model: "chat" }, "/llama/v1/chat/completions");
  assert.equal(crossedBack.status, 404);
  before = hits.length;
  assert.equal((await chat(key, { model: "gemma" }, "/llama/v1/chat/completions")).status, 200);
  assert.equal(lastHit(before).manager, "llama");
  assert.equal(lastHit(before).body.model, "gemma-gguf");

  // An alias never hides a real model: a model whose id is the alias wins.
  entry.getAccessStore().modelMeta.upsert("gemma-gguf", { aliases: ["gemma", "qwen-chat"] }, { actor: "test" });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  before = hits.length;
  assert.equal((await chat(key, { model: "qwen-chat" })).status, 200);
  assert.equal(lastHit(before).manager, "vllm");
  assert.equal(lastHit(before).body.model, "qwen-chat");

  // A key that may not use the target is refused with the target's error.
  const narrow = createKey({ models: ["gemma-*"], limits: { maxOutputTokens: 100 } });
  const denied = await chat(narrow, { model: "chat" });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "model_not_allowed");
  assert.equal((await chat(narrow, { model: "gemma" })).status, 200);
});

test("generic model ids pick among the models the key may use, on the engine of the route", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ models: ["gemma-*"], limits: { maxOutputTokens: 100 } });
  const before = hits.length;
  assert.equal((await chat(key, { model: "auto" })).status, 200);
  assert.equal(lastHit(before).manager, "llama");
  assert.equal(lastHit(before).body.model, "gemma-gguf");
  const wrongEngine = await chat(key, { model: "auto" }, "/vllm/v1/chat/completions");
  assert.equal(wrongEngine.status, 403);
  assert.equal(wrongEngine.json.error.code, "model_not_allowed");
});

test("/gateway/<engineId>/… needs an engine the fleet knows; /gateway/external/<id>/… a registered endpoint", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ limits: { maxOutputTokens: 100 } });
  const typo = await chat(key, { model: "auto" }, "/gateway/sglnag/openai/v1/chat/completions");
  assert.equal(typo.status, 400);
  assert.equal(typo.json.error.code, "unknown_engine");
  assert.equal(typo.json.error.param, "engine");

  const before = hits.length;
  const sglang = await chat(key, { model: "sg-model" }, "/gateway/sglang/openai/v1/chat/completions");
  assert.equal(sglang.status, 200, sglang.text);
  assert.equal(lastHit(before).manager, "vllm");
  assert.equal(lastHit(before).body.model, "sg-model");
  // qwen-chat runs on vllm, not on sglang.
  assert.equal((await chat(key, { model: "qwen-chat" }, "/gateway/sglang/openai/v1/chat/completions")).status, 404);
  assert.equal((await chat(key, { model: "qwen-chat" }, "/gateway/vllm/openai/v1/chat/completions")).status, 200);
  // llamacpp is the llama manager's engine.
  assert.equal((await chat(key, { model: "gemma-gguf" }, "/gateway/llamacpp/openai/v1/chat/completions")).status, 200);
  // A known engine with nothing running answers like any unavailable model.
  const tabby = await chat(key, { model: "auto" }, "/gateway/tabbyapi/openai/v1/chat/completions");
  assert.ok([404, 503].includes(tabby.status), String(tabby.status));
  const external = await chat(key, { model: "auto" }, "/gateway/external/not-registered/openai/v1/chat/completions");
  assert.ok([404, 503].includes(external.status), String(external.status));
});

test("/gateway/status takes no token, shows only the models the key may use, and still honours an empty bucket", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey({ models: ["qwen-*"], scopes: ["models.read", "chat"], limits: { rpm: 3, tpm: null, maxOutputTokens: 100 } });

  const remainders = [];
  for (let index = 0; index < 5; index += 1) {
    const status = await call(key, "/gateway/status");
    assert.equal(status.status, 200, status.text);
    remainders.push(status.headers["x-ratelimit-remaining-requests"]);
    assert.equal(status.json.rateLimit.limitPerMinute, 3);
    assert.equal(status.json.rateLimit.remaining, 3, "the bucket is untouched");
  }
  assert.deepEqual(remainders, ["3", "3", "3", "3", "3"]);

  // Traffic takes tokens; the status reports them without taking another.
  assert.equal((await chat(key)).status, 200);
  const after = await call(key, "/gateway/status");
  assert.equal(after.json.rateLimit.remaining, 2);
  assert.equal((await call(key, "/gateway/status")).json.rateLimit.remaining, 2);

  // Models are filtered before they are listed, in both places.
  assert.deepEqual(after.json.models, ["qwen-chat"]);
  assert.deepEqual(after.json.managers.map((manager) => manager.models), [["qwen-chat"], []].slice(0, after.json.managers.length));
  assert.doesNotMatch(JSON.stringify(after.json.managers), /secret-model|gemma-gguf|sg-model/);
  assert.equal(after.json.ok, true);
  assert.equal(after.json.service, "local-ai-gateway");
  assert.ok(after.json.endpoints.openai);

  // An empty bucket still answers 429 (and still does not take).
  assert.equal((await chat(key)).status, 200);
  assert.equal((await chat(key)).status, 200);
  const empty = await call(key, "/gateway/status");
  assert.equal(empty.status, 429);
  assert.equal(empty.json.error.code, "rate_limit_exceeded");
  assert.ok(Number(empty.headers["retry-after"]) >= 1);

  // The scope is models.read.
  assert.equal((await call(createKey({ scopes: ["chat"] }), "/gateway/status")).json.error.code, "scope_denied");
  assert.equal((await request(publicPort, "/gateway/status", { headers: { host: "127.0.0.1" } })).json.error.code, "missing_api_key");
});

test("PUBLIC answers only routes of its table, with the right method", async () => {
  await setup();
  entry.resetEntryRateLimitBuckets();
  const key = createKey();
  const before = hits.length;
  for (const pathname of ["/v1/files", "/v1/chat", "/v1/models/", "/anthropic/v1/chat/completions", "/vllm/v1/audio/speech"]) {
    const answer = await call(key, pathname, pathname === "/v1/models/" ? {} : { method: "POST", body: {} });
    if (pathname === "/v1/models/") assert.equal(answer.status, 200);
    else assert.equal(answer.status, 404, pathname);
  }
  assert.equal(hits.length, before, "an unknown path never reaches a manager");
  // /v1/me is a route of the table, served by me-routes.js (PUB-13): it needs self.read.
  const noSelf = await call(key, "/v1/me");
  assert.equal(noSelf.status, 403);
  assert.equal(noSelf.json.error.code, "scope_denied");
  assert.equal((await call(createKey({ scopes: ["self.read"] }), "/v1/me")).status, 200);
  // Speech is off when public.exposeTts is false.
  const speech = await call(createKey({ scopes: ["audio.speech"] }), "/v1/audio/speech", { method: "POST", body: { model: "tts-1", input: "hi" } });
  assert.ok([503, 429, 502, 404].includes(speech.status) && speech.json?.error, `speech: ${speech.status} ${speech.text}`);
  assert.equal(typeof speech.json.error.code, "string", "TTS refusals use the public error shape");
  assert.equal(speech.json.detail, undefined);
});
