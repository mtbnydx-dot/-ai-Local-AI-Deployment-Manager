const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const core = require("../../manager-core");
const entry = require("../server");

test("parses gateway routes and maps them to manager paths", () => {
  const openAiRoute = entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions");
  assert.deepEqual(openAiRoute, {
    engine: "auto",
    protocol: "openai",
    rest: "v1/chat/completions",
  });
  assert.equal(entry.buildManagerGatewayPath(openAiRoute), "/serve/v1/chat/completions");

  const openAiPropsRoute = entry.parseGatewayRoute("/gateway/auto/openai/v1/props");
  assert.deepEqual(openAiPropsRoute, {
    engine: "auto",
    protocol: "openai",
    rest: "v1/props",
  });
  assert.equal(entry.buildManagerGatewayPath(openAiPropsRoute), "/serve/v1/props");

  const claudeRoute = entry.parseGatewayRoute("/gateway/vllm/claude/v1/messages");
  assert.deepEqual(claudeRoute, {
    engine: "vllm",
    protocol: "claude",
    rest: "v1/messages",
  });
  assert.equal(entry.buildManagerGatewayPath(claudeRoute), "/claude/v1/messages");

  const opencodeRoute = entry.parseGatewayRoute("/gateway/auto/opencode/v1/models");
  assert.deepEqual(opencodeRoute, {
    engine: "auto",
    protocol: "opencode",
    rest: "v1/models",
  });
  assert.equal(entry.buildManagerGatewayPath(opencodeRoute), "/opencode/v1/models");

  const subscriptionRoute = entry.parseGatewayRoute("/gateway/subscription/codex/v1/responses");
  assert.deepEqual(subscriptionRoute, {
    engine: "subscription",
    protocol: "codex",
    rest: "v1/responses",
  });
  assert.equal(core.buildSubscriptionProxyPath(subscriptionRoute.protocol, subscriptionRoute.rest), "/v1/responses");
});

test("rejects unknown gateway routes", () => {
  assert.equal(entry.parseGatewayRoute("/gateway/unknown/openai/v1/models"), null);
  assert.equal(entry.parseGatewayRoute("/gateway/auto/codex/v1/responses"), null);
  assert.equal(entry.parseGatewayRoute("/api/status"), null);
});

test("normalizes CLIProxyAPI configuration and exposes local, LAN, and public endpoints", () => {
  const config = core.normalizeSubscriptionProxyConfig({
    CLIPROXY_BASE_URL: "http://127.0.0.1:8317/v1/",
    CLIPROXY_ENABLED: "true",
    CLIPROXY_STATUS_TIMEOUT_MS: "3000",
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:8317");
  assert.equal(config.enabled, true);
  assert.equal(config.upstreamScope, "loopback");
  assert.equal(config.authMode, "passthrough");

  const urls = core.buildSubscriptionProxyGatewayUrls({
    entryHost: "0.0.0.0",
    entryPort: 5176,
    lanAddress: "192.168.1.27",
    publicBaseUrl: "https://ai.example.com/",
  });
  assert.equal(urls.local.openAi, "http://127.0.0.1:5176/gateway/subscription/openai/v1");
  assert.equal(urls.lan.claude, "http://192.168.1.27:5176/gateway/subscription/claude");
  assert.equal(urls.public.codex, "https://ai.example.com/gateway/subscription/codex/v1");
});

test("rejects unsafe subscription proxy paths and base URLs containing credentials", () => {
  assert.throws(
    () => core.buildSubscriptionProxyPath("openai", "v1/%2e%2e/models"),
    /unsafe segment/,
  );
  assert.throws(
    () => core.normalizeSubscriptionProxyBaseUrl("http://user:secret@127.0.0.1:8317"),
    /must not contain credentials/,
  );
});

test("proxy headers keep auth fields and remove hop-by-hop fields", () => {
  const headers = entry.buildProxyHeaders(
    {
      host: "192.168.1.27:5176",
      connection: "keep-alive",
      "content-length": "10",
      authorization: "Bearer service-key",
      "anthropic-api-key": "service-key",
      "x-api-key": "service-key",
      "content-type": "application/json",
      "x-forwarded-for": "192.168.1.99",
    },
    { socket: { remoteAddress: "192.168.1.100" } },
  );

  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers.authorization, "Bearer service-key");
  assert.equal(headers["anthropic-api-key"], "service-key");
  assert.equal(headers["x-api-key"], "service-key");
  assert.equal(headers["x-service-entry-gateway"], "1");
  assert.equal(headers["x-forwarded-for"], "192.168.1.99, 192.168.1.100");
});

test("gateway access entries contain metadata but not prompt content", () => {
  const route = entry.parseGatewayRoute("/gateway/auto/claude/v1/messages");
  const manager = entry.findManager("vllm");
  const body = Buffer.from(JSON.stringify({
    model: "local-model",
    messages: [{ role: "user", content: "secret prompt content" }],
    stream: true,
    tools: [{ name: "shell", input_schema: { type: "object" } }],
  }));
  const event = entry.buildEntryGatewayAccessEntry(
    {
      socket: { remoteAddress: "::ffff:192.168.1.50" },
      method: "POST",
      url: "/gateway/auto/claude/v1/messages?debug=1",
      headers: {
        authorization: "Bearer service-key",
        "user-agent": "WorkBuddy/5.1.7",
        origin: "http://127.0.0.1:3000",
        referer: "http://127.0.0.1:3000/chat",
      },
    },
    route,
    manager,
    200,
    Date.now() - 25,
    body,
    "",
  );

  assert.equal(event.path, "/gateway/auto/claude/v1/messages");
  assert.equal(event.kind, "claude");
  assert.equal(event.requestedEngine, "auto");
  assert.equal(event.resolvedEngine, "vllm");
  assert.equal(event.model, "local-model");
  assert.equal(event.stream, true);
  assert.equal(event.authSource, "authorization-bearer");
  assert.equal(event.userAgent, "WorkBuddy/5.1.7");
  assert.equal(event.origin, "http://127.0.0.1:3000");
  assert.equal(event.refererHost, "127.0.0.1:3000");
  assert.equal(event.toolSchemaCount, 1);
  assert.equal(Object.hasOwn(event, "messages"), false);
  assert.equal(JSON.stringify(event).includes("secret prompt content"), false);
});

test("entry server serves only whitelisted docs", async () => {
  const server = entry.createServiceEntryServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const okResponse = await fetch(`http://127.0.0.1:${port}/docs/client-setup-guide.md`);
    assert.equal(okResponse.status, 200);
    assert.match(await okResponse.text(), /# 客户端连接指南/);

    const subscriptionResponse = await fetch(`http://127.0.0.1:${port}/docs/subscription-proxy-guide.md`);
    assert.equal(subscriptionResponse.status, 200);
    assert.match(await subscriptionResponse.text(), /# 订阅反代指南/);

    const missingResponse = await fetch(`http://127.0.0.1:${port}/docs/server.js`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("subscription proxy status distinguishes ready and API-key-required states", async () => {
  const config = core.normalizeSubscriptionProxyConfig({
    CLIPROXY_BASE_URL: "http://127.0.0.1:8317",
  });
  const ready = await entry.probeSubscriptionProxy({
    config,
    fetchImpl: async () => new Response(JSON.stringify({
      object: "list",
      data: [{ id: "gpt-subscription" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.models, ["gpt-subscription"]);
  assert.match(ready.declaration, /本机、局域网和可选公网/);

  const authRequired = await entry.probeSubscriptionProxy({
    config,
    fetchImpl: async () => new Response("", { status: 401 }),
  });
  assert.equal(authRequired.state, "auth-required");
  assert.equal(authRequired.reachable, true);
  assert.match(authRequired.credentialBoundary, /不读取或保存 OAuth/);
});

test("subscription gateway forwards path, body, and caller authentication to CLIProxyAPI", async () => {
  const captured = {};
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured.path = req.url;
    captured.authorization = req.headers.authorization;
    captured.apiKey = req.headers["x-api-key"];
    captured.gateway = req.headers["x-service-entry-gateway"];
    captured.body = Buffer.concat(chunks).toString("utf8");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-proxy", object: "chat.completion" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gateway = entry.createServiceEntryServer({
    subscriptionProxyConfig: core.normalizeSubscriptionProxyConfig({
      CLIPROXY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    }),
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/gateway/subscription/openai/v1/chat/completions?trace=1`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer caller-owned-key",
          "x-api-key": "caller-owned-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "subscription-model",
          messages: [{ role: "user", content: "do not log this prompt" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "chatcmpl-proxy");
    assert.equal(captured.path, "/v1/chat/completions?trace=1");
    assert.equal(captured.authorization, "Bearer caller-owned-key");
    assert.equal(captured.apiKey, "caller-owned-key");
    assert.equal(captured.gateway, "1");
    assert.match(captured.body, /subscription-model/);
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("subscription gateway preserves SSE streaming responses", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: [DONE]\n\n"), 5);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const gateway = entry.createServiceEntryServer({
    subscriptionProxyConfig: core.normalizeSubscriptionProxyConfig({
      CLIPROXY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    }),
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/gateway/subscription/claude/v1/messages`,
      {
        method: "POST",
        headers: {
          "anthropic-api-key": "caller-owned-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "subscription-model", stream: true, messages: [] }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(await response.text(), "data: first\n\ndata: [DONE]\n\n");
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("auto gateway selects the manager that owns the requested model", () => {
  const vllm = entry.findManager("vllm");
  const llama = entry.findManager("llama");
  const catalogs = [
    {
      manager: vllm,
      listening: true,
      running: true,
      models: [{ id: "qwen-vllm" }],
      modelIds: new Set(["qwen-vllm"]),
      aliases: new Set(["qwen3.6"]),
    },
    {
      manager: llama,
      listening: true,
      running: true,
      models: [{ id: "gemma-gguf" }],
      modelIds: new Set(["gemma-gguf"]),
      aliases: new Set(["gemma4"]),
    },
  ];
  assert.equal(entry.selectGatewayManager(catalogs, "gemma-gguf").id, "llama");
  assert.equal(entry.selectGatewayManager(catalogs, "qwen3.6").id, "vllm");
  assert.equal(entry.selectGatewayManager(catalogs, "auto").id, "vllm");
});

test("auto model catalog merges both engines without duplicate ids", () => {
  const data = entry.mergeManagerModelCatalogs([
    {
      manager: entry.findManager("vllm"),
      models: [{ id: "shared" }, { id: "vllm-only", owned_by: "vllm" }],
    },
    {
      manager: entry.findManager("llama"),
      models: [{ id: "shared" }, { id: "llama-only", owned_by: "llama.cpp" }],
    },
  ]);
  assert.deepEqual(data.map((model) => model.id), ["shared", "vllm-only", "llama-only"]);
  assert.deepEqual(data.map((model) => model.manager_engine), ["vllm", "vllm", "llama"]);
});

test("auto OpenAI model list route is detected without matching chat routes", () => {
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "GET" },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/models"),
  ), true);
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "POST" },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions"),
  ), false);
});
