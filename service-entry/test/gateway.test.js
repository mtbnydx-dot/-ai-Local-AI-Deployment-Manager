const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const test = require("node:test");
const zlib = require("node:zlib");

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
});

test("rejects unknown gateway routes", () => {
  assert.equal(entry.parseGatewayRoute("/gateway/unknown/openai/v1/models"), null);
  assert.equal(entry.parseGatewayRoute("/api/status"), null);
});

test("standalone billing page is limited to direct loopback requests", () => {
  assert.equal(entry.isStrictLocalBillingPageRequest({
    headers: { host: "127.0.0.1:5176" },
    socket: { remoteAddress: "127.0.0.1" },
  }), true);
  assert.equal(entry.isStrictLocalBillingPageRequest({
    headers: { host: "127.0.0.1:5176", "x-forwarded-for": "203.0.113.7" },
    socket: { remoteAddress: "127.0.0.1" },
  }), false);
  assert.equal(entry.isStrictLocalBillingPageRequest({
    headers: { host: "192.168.1.26:5176" },
    socket: { remoteAddress: "192.168.1.20" },
  }), false);
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
      "x-service-entry-instance-id": "forged-instance",
      "x-service-entry-instance-signature": "forged-signature",
    },
    { socket: { remoteAddress: "192.168.1.100" } },
    { instanceId: "vision" },
  );

  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers.authorization, "Bearer service-key");
  assert.equal(headers["anthropic-api-key"], "service-key");
  assert.equal(headers["x-api-key"], "service-key");
  assert.equal(headers["x-service-entry-gateway"], "1");
  assert.equal(headers["x-service-entry-instance-id"], "vision");
  assert.notEqual(headers["x-service-entry-instance-signature"], "forged-signature");
  assert.equal(headers["x-forwarded-for"], "192.168.1.99, 192.168.1.100");
  assert.equal(core.resolveServiceEntrySelectedInstance({
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  }, { token: entry.security.getTrustToken() }), "vision");
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
    "resolved-local-model",
  );

  assert.equal(event.path, "/gateway/auto/claude/v1/messages");
  assert.equal(event.kind, "claude");
  assert.equal(event.requestedEngine, "auto");
  assert.equal(event.resolvedEngine, "vllm");
  assert.equal(event.model, "local-model");
  assert.equal(event.resolvedModel, "resolved-local-model");
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

    const missingResponse = await fetch(`http://127.0.0.1:${port}/docs/server.js`);
    assert.equal(missingResponse.status, 404);

    const billingResponse = await fetch(`http://127.0.0.1:${port}/billing`);
    assert.equal(billingResponse.status, 200);
    assert.match(await billingResponse.text(), /<title>模型计费中心<\/title>/);
    assert.match(String(billingResponse.headers.get("content-security-policy")), /default-src 'none'/);

    const forwardedBillingResponse = await fetch(`http://127.0.0.1:${port}/billing`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    assert.equal(forwardedBillingResponse.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
  assert.equal(entry.selectGatewayManager(catalogs, "typo-does-not-exist"), null);
});

test("service API keys are scoped to the manager that authenticated them", async () => {
  const managers = [entry.findManager("vllm"), entry.findManager("llama")];
  const vllmAuth = { ok: true, matchedManager: "vllm", client: null };
  assert.deepEqual(
    entry.selectGatewayManagersForAuth("auto", vllmAuth, managers).map((manager) => manager.id),
    ["vllm"],
  );
  assert.deepEqual(
    entry.selectGatewayManagersForAuth("vllm", vllmAuth, managers).map((manager) => manager.id),
    ["vllm"],
  );
  assert.deepEqual(entry.selectGatewayManagersForAuth("llama", vllmAuth, managers), []);
  assert.deepEqual(
    entry.selectGatewayManagersForAuth("auto", { ok: true, matchedManager: "" }, managers).map((manager) => manager.id),
    ["vllm", "llama"],
  );

  const state = { status: 0, body: null };
  const response = {
    writeHead(status) { state.status = status; },
    end(body) { state.body = JSON.parse(body); },
  };
  await entry.sendAggregatedModelList(
    { headers: {} },
    response,
    "llama",
    vllmAuth,
  );
  assert.equal(state.status, 403);
  assert.equal(state.body.error.code, "manager_forbidden");
});

test("auto model catalog merges both engines without duplicate ids", () => {
  const data = entry.mergeManagerModelCatalogs([
    {
      manager: entry.findManager("vllm"),
      models: [{
        id: "shared",
        root: "/models/private-path",
        container_name: "vllm-local",
        instance_id: "primary",
      }, {
        id: "vllm-only",
        owned_by: "vllm",
        created: 42,
        capabilities: ["text", "tools", "private-capability"],
        aliases: ["internal-alias"],
      }],
    },
    {
      manager: entry.findManager("llama"),
      models: [{ id: "shared" }, { id: "llama-only", owned_by: "llama.cpp" }],
    },
  ]);
  assert.deepEqual(data.map((model) => model.id), ["shared", "vllm-only", "llama-only"]);
  assert.equal(data[0].root, undefined);
  assert.equal(data[0].container_name, undefined);
  assert.equal(data[0].instance_id, undefined);
  assert.equal(data[0].manager_engine, undefined);
  assert.equal(data[1].aliases, undefined);
  assert.equal(data[1].created, 42);
  assert.deepEqual(data[1].capabilities, ["text", "tools"]);
});

test("unified model list routes are sanitized for auto and direct engines without matching chat routes", () => {
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "GET" },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/models"),
  ), true);
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "GET" },
    entry.parseGatewayRoute("/gateway/vllm/openai/v1/models"),
  ), true);
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "GET" },
    entry.parseGatewayRoute("/gateway/llama/opencode/v1/models"),
  ), true);
  assert.equal(entry.isAggregatedModelListRequest(
    { method: "POST" },
    entry.parseGatewayRoute("/gateway/auto/openai/v1/chat/completions"),
  ), false);
});

test("manager catalog discovers a model that exists only in a running parallel instance", () => {
  const catalog = entry.buildManagerCatalog(entry.findManager("llama"), {
    instances: [
      {
        id: "primary",
        primary: true,
        running: false,
        models: [{ id: "old-primary" }],
      },
      {
        id: "vision",
        primary: false,
        instanceMode: "parallel",
        running: true,
        containerName: "llama-local-vision",
        port: 8082,
        localBaseUrl: "http://127.0.0.1:8082/v1",
        models: [{ id: "Qwen3-VL-8B-Instruct" }],
      },
    ],
  });

  assert.equal(catalog.running, true);
  assert.equal(catalog.instances.length, 2);
  assert.equal(catalog.instances[0].instanceId, "primary");
  assert.equal(catalog.instances[0].running, false);
  assert.equal(catalog.instances[0].lifecycleState, "stopped");
  assert.equal(catalog.instances[1].instanceId, "vision");
  assert.deepEqual(catalog.models.map((model) => model.id), ["Qwen3-VL-8B-Instruct"]);
  assert.ok(catalog.models[0].capabilities.includes("vision"));
});

test("fleet selection routes parallel models and fails closed for unknown auto models", () => {
  const vllm = entry.buildManagerCatalog(entry.findManager("vllm"), {
    instances: [{
      id: "primary",
      primary: true,
      running: true,
      models: [{ id: "text-model", capabilities: ["language"] }],
    }],
  });
  const llama = entry.buildManagerCatalog(entry.findManager("llama"), {
    instances: [{
      id: "vision",
      primary: false,
      running: true,
      models: [{ id: "vision-model", capabilities: ["language", "vision"] }],
    }],
  });

  const selected = entry.selectFleetTarget([vllm, llama], {
    engine: "auto",
    protocol: "openai",
    path: "v1/chat/completions",
    body: { model: "vision-model" },
  });
  assert.equal(Boolean(selected.error), false);
  assert.equal(selected.manager.id, "llama");
  assert.equal(selected.instance.instanceId, "vision");
  assert.equal(selected.model.id, "vision-model");

  const unknown = entry.selectFleetTarget([vllm, llama], {
    engine: "auto",
    protocol: "opencode",
    path: "v1/chat/completions",
    body: { model: "not-loaded" },
  });
  assert.equal(unknown.error, "model_not_available");
  assert.equal(unknown.status, 404);
});

test("generic request model rewrite preserves all private request fields", () => {
  const original = Buffer.from(JSON.stringify({
    model: "local-current",
    messages: [{ role: "user", content: "private prompt" }],
    metadata: { private: true },
  }));
  const rewritten = JSON.parse(entry.rewriteRequestModelBody(original, "resident-vision-model").toString("utf8"));
  assert.equal(rewritten.model, "resident-vision-model");
  assert.deepEqual(rewritten.messages, [{ role: "user", content: "private prompt" }]);
  assert.deepEqual(rewritten.metadata, { private: true });
});

test("gzip JSON bodies route from decoded metadata without forwarding a stale encoding after rewrite", () => {
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({
    model: "local-current",
    messages: [{ role: "user", content: "compressed private prompt" }],
  })));
  const parsed = entry.parseRequestJsonBody(compressed, {
    contentEncoding: "gzip",
    maxBytes: 1024 * 1024,
  });
  assert.equal(parsed.model, "local-current");
  const rewritten = JSON.parse(entry.rewriteRequestModelBody(compressed, "resident-model", parsed).toString("utf8"));
  assert.equal(rewritten.model, "resident-model");
  assert.deepEqual(rewritten.messages, [{ role: "user", content: "compressed private prompt" }]);

  const headers = entry.buildProxyHeaders(
    { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(compressed.length) },
    { socket: { remoteAddress: "127.0.0.1" } },
    { stripContentEncoding: true },
  );
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(headers["content-length"], undefined);
  assert.throws(
    () => entry.parseRequestJsonBody(Buffer.from("not-gzip"), { contentEncoding: "gzip" }),
    (error) => error.status === 400 && error.code === "invalid_content_encoding",
  );
});

test("gateway parses the complete allowed JSON body before multimodal routing", () => {
  const body = Buffer.from(JSON.stringify({
    padding: "x".repeat(1024 * 1024 + 128),
    model: "vision-model",
    messages: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }],
  }));
  assert.ok(body.length > 1024 * 1024);
  const parsed = entry.parseRequestJsonBody(body);
  assert.equal(parsed.model, "vision-model");
  const catalog = entry.buildManagerCatalog(entry.findManager("vllm"), {
    instances: [{
      id: "vision",
      running: true,
      models: [{ id: "vision-model", capabilities: ["text", "vision"] }],
    }],
  });
  const selected = entry.selectFleetTarget([catalog], {
    engine: "vllm",
    protocol: "openai",
    path: "v1/chat/completions",
    body: parsed,
  });
  assert.equal(selected.error, null);
  assert.equal(selected.capability, "vision");
  assert.equal(selected.model.id, "vision-model");

  const audioBody = Buffer.from(JSON.stringify({
    padding: "y".repeat(1024 * 1024 + 128),
    model: "audio-model",
    input: [{ type: "input_audio", input_audio: { data: "AA" } }],
  }));
  const parsedAudio = entry.parseRequestJsonBody(audioBody);
  const audioCatalog = entry.buildManagerCatalog(entry.findManager("vllm"), {
    instances: [{
      id: "audio",
      running: true,
      models: [{ id: "audio-model", capabilities: ["audio"] }],
    }],
  });
  const selectedAudio = entry.selectFleetTarget([audioCatalog], {
    engine: "vllm",
    protocol: "openai",
    path: "v1/chat/completions",
    body: parsedAudio,
  });
  assert.equal(selectedAudio.error, null);
  assert.equal(selectedAudio.capability, "audio");
  assert.equal(selectedAudio.model.id, "audio-model");
});

test("gateway body reader enforces its byte ceiling before proxying", async () => {
  const request = Readable.from([Buffer.from("1234"), Buffer.from("5678")]);
  await assert.rejects(
    () => entry.readRequestBody(request, 6),
    (error) => error.status === 413 && error.code === "request_body_too_large",
  );
});

test("gateway global body budget accounts for transient JSON copies and releases after rejection", async () => {
  const overBudget = Readable.from([Buffer.from("12"), Buffer.from("3")]);
  await assert.rejects(
    () => entry.readRequestBody(overBudget, 20, {
      trackGlobal: true,
      holdReservation: true,
      memoryMultiplier: 4,
      globalBudgetBytes: 10,
    }),
    (error) => error.status === 503 && error.code === "gateway_body_budget_exhausted",
  );
  const accepted = await entry.readRequestBody(Readable.from([Buffer.from("ok")]), 20, {
    trackGlobal: true,
    holdReservation: true,
    memoryMultiplier: 4,
    globalBudgetBytes: 10,
  });
  assert.equal(accepted.buffer.toString("utf8"), "ok");
  accepted.release();
});
