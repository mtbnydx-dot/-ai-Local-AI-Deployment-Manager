const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manager = require("../server");

test("Claude bridge converts Anthropic tools and messages to OpenAI shape", () => {
  const tools = manager.anthropicToolsToOpenAi([
    {
      name: "search_web",
      description: "Search the web",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ]);

  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "search_web");
  assert.deepEqual(manager.anthropicToolChoiceToOpenAi({ type: "tool", name: "search_web" }, tools), {
    type: "function",
    function: { name: "search_web" },
  });

  const messages = manager.anthropicMessagesToOpenAi({
    system: "Keep responses concise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Look up Qwen tool calling." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will search." },
          { type: "tool_use", id: "toolu_1", name: "search_web", input: { query: "Qwen tool calling" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Result body" }] }] },
    ],
  });

  assert.equal(messages[0].role, "system");
  const assistant = messages.find((message) => message.role === "assistant");
  assert.equal(assistant.tool_calls[0].id, "toolu_1");
  assert.equal(assistant.tool_calls[0].function.name, "search_web");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { query: "Qwen tool calling" });
  const toolResult = messages.find((message) => message.role === "tool");
  assert.equal(toolResult.tool_call_id, "toolu_1");
  assert.equal(toolResult.content, "Result body");
});

test("Claude bridge converts OpenAI tool calls back to Anthropic tool_use blocks", () => {
  const response = manager.openAiResponseToClaude({
    id: "chatcmpl_test",
    model: "local-qwen",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Checking now.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"D:/AI/models\"}" },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, "fallback-model");

  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content[1], {
    type: "tool_use",
    id: "call_1",
    name: "read_file",
    input: { path: "D:/AI/models" },
  });
});

test("Prometheus parser handles escaped labels and ignores non-finite metrics", () => {
  const metrics = manager.parsePrometheusMetrics(`
# HELP ignored line
tokens_total{model_name="qwen\\\\coder",note="a\\\"b"} 42
tokens_total{model_name="bad"} NaN
latency_seconds_sum 1.5e+2
`);

  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].labels.model_name, "qwen\\coder");
  assert.equal(metrics[0].labels.note, "a\"b");
  assert.equal(metrics[0].value, 42);
  assert.equal(metrics[1].value, 150);
});

test("Context compression keeps protected facts and tool pairs", () => {
  const summary = manager.buildClaudeCompressionSummary([
    { role: "user", content: "Goal: fix Docker error at D:\\AI\\models. Must preserve the audit password rule. Run `docker logs llama-local`." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_logs", name: "read_logs", input: { container: "llama-local" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_logs", content: "error: configured model not available on http://127.0.0.1:8001/v1" }] },
  ], {
    summaryBudget: 900,
    originalPromptTokens: 7000,
    contextLimit: 8192,
    settings: { triggerRatio: 0.9, recentRatio: 0.2, summaryRatio: 0.2 },
  });

  assert.ok(summary.tokens > 0);
  assert.ok(summary.protectedItems > 0);
  assert.match(summary.text, /tool_use read_logs/);
  assert.match(summary.text, /configured model not available/i);
});

test("firstExisting handles path candidates without treating commands as absolute paths", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llama-manager-path-"));
  const file = path.join(dir, "tool.exe");
  await fs.writeFile(file, "");

  assert.equal(manager.firstExisting(["docker", file, "fallback"]), file);
  assert.equal(manager.firstExisting(["docker"]), "docker");
});

test("writeJsonFile leaves valid JSON after concurrent writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llama-manager-json-"));
  const file = path.join(dir, "stats-ledger.json");

  await Promise.all(Array.from({ length: 8 }, (_item, index) => manager.writeJsonFile(file, {
    index,
    nested: { ok: true },
  })));

  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(parsed.nested.ok, true);
  assert.equal(Number.isInteger(parsed.index), true);
  const leftovers = await fs.readdir(dir);
  assert.equal(leftovers.some((name) => name.includes(".tmp-") || name.endsWith(".lock")), false);
});

test("persisted jobs are normalized before llama ledger writes", () => {
  const normalized = manager.normalizePersistedJob({
    id: "job-1",
    type: "download",
    title: "Download",
    status: "running",
    logs: Array.from({ length: 510 }, (_item, index) => `line ${index}`),
    progress: { percent: 42 },
  });

  assert.equal(normalized.id, "job-1");
  assert.equal(normalized.logs.length, 500);
  assert.equal(normalized.logs[0], "line 10");
  assert.equal(normalized.progress.percent, 42);
});

test("docker publish args keep local gateway and bind LAN IP for Docker traffic", () => {
  assert.equal(manager.portPublishArg(8080, "local"), "127.0.0.1:8080:8080");
  assert.equal(manager.portPublishArg(9090, "lan", "192.168.50.10"), "192.168.50.10:9090:8080");
  assert.deepEqual(manager.dockerPublishArgs(9090, "lan", "192.168.50.10"), [
    "127.0.0.1:9090:8080",
    "192.168.50.10:9090:8080",
  ]);
});

test("parseDockerPortPublish prefers LAN binding while preserving local binding", () => {
  const parsed = manager.parseDockerPortPublish("127.0.0.1:9090->8080/tcp, 192.168.50.10:9090->8080/tcp");
  assert.equal(parsed.port, 9090);
  assert.equal(parsed.host, "192.168.50.10");
  assert.equal(parsed.localHost, "127.0.0.1");
  assert.equal(parsed.lanHost, "192.168.50.10");
  assert.equal(parsed.bindings.length, 2);
});

test("service exposure settings normalize and redact secrets", () => {
  const settings = manager.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "reverse-proxy",
    requireApiKey: true,
    apiKey: "sk-local-secret",
    publicBaseUrl: "ftp://not-accepted.example",
    allowedOrigins: ["https://a.example", "", "https://b.example"],
    rateLimitRpm: -1,
    maxConcurrentRequests: 999,
    requestTimeoutSeconds: 99_999,
  });

  assert.equal(settings.exposureMode, "reverse-proxy");
  assert.equal(settings.publicBaseUrl, "");
  assert.deepEqual(settings.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(settings.rateLimitRpm, 1);
  assert.equal(settings.maxConcurrentRequests, 256);
  assert.equal(settings.requestTimeoutSeconds, 7200);
  assert.equal(settings.apiKey, "");
  assert.equal(settings.apiKeyHash, manager.hashServiceApiKey("sk-local-secret"));
  const redacted = manager.redactServiceExposureSettings(settings);
  assert.equal(redacted.apiKey, "");
  assert.equal(redacted.apiKeyHash, "");
  assert.equal(redacted.hasApiKey, true);
  assert.equal(redacted.apiKeyPreview, "sk-loca...cret");
});

test("llama service exposure checks treat manager gateway API key as enforceable", () => {
  const settings = manager.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "lan",
    requireApiKey: true,
    apiKey: "sk-local-secret",
  });
  const checks = manager.buildServiceExposureChecks(settings, {
    docker: { ok: true },
    container: { running: true, exists: true, status: "running" },
    endpoint: { networkAccess: "lan" },
  });

  assert.ok(checks.some((check) => check.status === "ok" && /API Key/.test(check.title)));
});

test("service gateway auth, rate limit, concurrency, and model aliasing", () => {
  assert.equal(manager.isServiceApiKeyAccepted("sk-test", "sk-test"), true);
  assert.equal(manager.isServiceApiKeyAccepted("sk-test", "sk-other"), false);

  const settings = manager.normalizeServiceExposureSettings({
    rateLimitRpm: 2,
    maxConcurrentRequests: 1,
  });
  const rateBuckets = new Map();
  assert.equal(manager.enterServiceRateLimit(settings, "client", rateBuckets, 1000).ok, true);
  assert.equal(manager.enterServiceRateLimit(settings, "client", rateBuckets, 2000).ok, true);
  assert.equal(manager.enterServiceRateLimit(settings, "client", rateBuckets, 3000).ok, false);

  const concurrencyBuckets = new Map();
  const first = manager.enterServiceConcurrency(settings, "client", concurrencyBuckets);
  assert.equal(first.ok, true);
  assert.equal(manager.enterServiceConcurrency(settings, "client", concurrencyBuckets).ok, false);
  first.release();
  assert.equal(manager.enterServiceConcurrency(settings, "client", concurrencyBuckets).ok, true);

  assert.equal(manager.resolveOpenAiGatewayModel("local-current", {
    servedModels: [{ id: "model.gguf" }],
  }), "model.gguf");
});

test("service client policy overrides limits and restricts models", () => {
  const client = manager.normalizeServiceClient({
    id: "openwebui",
    name: "OpenWebUI",
    keyHash: manager.hashServiceApiKey("sk-test"),
    allowedModels: ["model.gguf"],
    rateLimitRpm: 9,
    maxConcurrentRequests: 2,
    requestTimeoutSeconds: 45,
  });
  const effective = manager.buildEffectiveServiceSettings({
    rateLimitRpm: 120,
    maxConcurrentRequests: 4,
    requestTimeoutSeconds: 600,
  }, client);

  assert.equal(effective.rateLimitRpm, 9);
  assert.equal(effective.maxConcurrentRequests, 2);
  assert.equal(effective.requestTimeoutSeconds, 45);
  assert.equal(manager.serviceClientAllowsModel(client, "model.gguf"), true);
  assert.equal(manager.serviceClientAllowsModel(client, "other.gguf"), false);
});

test("extractHostname normalizes Host headers for the manager guard", () => {
  assert.equal(manager.extractHostname("127.0.0.1:5178"), "127.0.0.1");
  assert.equal(manager.extractHostname("LOCALHOST:5178"), "localhost");
  assert.equal(manager.extractHostname("[::1]:5178"), "::1");
  assert.equal(manager.extractHostname("http://evil.example.com"), "evil.example.com");
  assert.equal(manager.extractHostname(""), "");
});

test("memory estimate helper recommends llama.cpp RAM fallback when GPU overflows", () => {
  const estimate = manager.buildLlamaMemoryEstimate({
    paramsB: 70,
    contextTokens: 32768,
    bytesPerParam: 0.75,
    kvBytes: 2,
    arch: { layers: 80, kvHeads: 8, headDim: 128 },
    gpuLayers: "all",
    gpuMemoryUtilization: 0.9,
    selectedGpus: [{ id: "0", name: "Small GPU", totalGb: 12, usedGb: 2 }],
  });

  assert.equal(estimate.ok, true);
  assert.equal(estimate.plan.status, "fail");
  assert.ok(estimate.recommendations.recommendedGpuLayers < estimate.recommendations.totalLayers);
  assert.match(estimate.recommendations.suggestions.join(" "), /GPU layers/);
});

test("memory estimate helper keeps llama.cpp hetero split advice visible", () => {
  const estimate = manager.buildLlamaMemoryEstimate({
    paramsB: 27,
    contextTokens: 32768,
    bytesPerParam: 0.56,
    arch: { layers: 48, kvHeads: 8, headDim: 128 },
    selectedGpus: [
      { id: "0", totalGb: 24, usedGb: 4 },
      { id: "1", totalGb: 96, usedGb: 8 },
    ],
  });

  assert.equal(estimate.ok, true);
  assert.equal(estimate.plan.allocations.length, 2);
  assert.match(estimate.recommendations.suggestions.join(" "), /tensor split/);
});
