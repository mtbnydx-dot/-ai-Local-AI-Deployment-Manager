const assert = require("node:assert/strict");
const test = require("node:test");

const entry = require("../server");

test("parses gateway routes and maps them to manager paths", () => {
  const openAiRoute = entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions");
  assert.deepEqual(openAiRoute, {
    engine: "auto",
    protocol: "openai",
    rest: "v1/chat/completions",
  });
  assert.equal(entry.buildManagerGatewayPath(openAiRoute), "/serve/v1/chat/completions");

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
});

test("rejects unknown gateway routes", () => {
  assert.equal(entry.parseGatewayRoute("/gateway/unknown/openai/v1/models"), null);
  assert.equal(entry.parseGatewayRoute("/api/status"), null);
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
      headers: { authorization: "Bearer service-key" },
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

    const missingResponse = await fetch(`http://127.0.0.1:${port}/docs/server.js`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
