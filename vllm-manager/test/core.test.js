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
    { role: "user", content: "Goal: fix Docker error at D:\\AI\\models. Must preserve the audit password rule. Run `docker logs vllm-local`." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_logs", name: "read_logs", input: { container: "vllm-local" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_logs", content: "error: configured model not available on http://127.0.0.1:8000/v1" }] },
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vllm-manager-path-"));
  const file = path.join(dir, "tool.exe");
  await fs.writeFile(file, "");

  assert.equal(manager.firstExisting(["docker", file, "fallback"]), file);
  assert.equal(manager.firstExisting(["docker"]), "docker");
});

test("writeJsonFile leaves valid JSON after concurrent writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vllm-manager-json-"));
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

test("dockerGpuArg isolates selected GPUs and falls back to all", () => {
  assert.equal(manager.dockerGpuArg([]), "all");
  assert.equal(manager.dockerGpuArg(["0", "1"]), "device=0,1");
  assert.equal(manager.dockerGpuArg("1, 2"), "device=1,2");
  assert.equal(manager.dockerGpuArg(["abc"]), "all");
});

test("portPublishArg binds loopback unless LAN access is requested", () => {
  assert.equal(manager.portPublishArg(8000, "local"), "127.0.0.1:8000:8000");
  assert.equal(manager.portPublishArg(9000, "lan", "192.168.50.10"), "192.168.50.10:9000:8000");
  assert.deepEqual(manager.dockerPublishArgs(9000, "lan", "192.168.50.10"), [
    "127.0.0.1:9000:8000",
    "192.168.50.10:9000:8000",
  ]);
});

test("parseDockerPortPublish prefers LAN binding while preserving local binding", () => {
  const parsed = manager.parseDockerPortPublish("127.0.0.1:9000->8000/tcp, 192.168.50.10:9000->8000/tcp");
  assert.equal(parsed.port, 9000);
  assert.equal(parsed.host, "192.168.50.10");
  assert.equal(parsed.localHost, "127.0.0.1");
  assert.equal(parsed.lanHost, "192.168.50.10");
  assert.equal(parsed.bindings.length, 2);
});

test("normalizeDtype accepts vLLM dtypes and rejects junk", () => {
  assert.equal(manager.normalizeDtype(""), "auto");
  assert.equal(manager.normalizeDtype("BFloat16"), "bfloat16");
  assert.throws(() => manager.normalizeDtype("fp64; rm -rf /"), /dtype/);
});

test("normalizeQuantization enforces a safe charset", () => {
  assert.equal(manager.normalizeQuantization(""), "");
  assert.equal(manager.normalizeQuantization("AWQ"), "awq");
  assert.equal(manager.normalizeQuantization("compressed-tensors"), "compressed-tensors");
  assert.throws(() => manager.normalizeQuantization("awq marlin"), /quantization/);
});

test("service exposure settings normalize and redact secrets", () => {
  const settings = manager.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "reverse-proxy",
    requireApiKey: true,
    apiKey: "sk-local-secret",
    publicBaseUrl: "https://models.example.test/base/",
    allowedOrigins: "https://a.example\nhttps://b.example",
    rateLimitRpm: 99999,
    maxConcurrentRequests: 0,
    requestTimeoutSeconds: 3,
  });

  assert.equal(settings.exposureMode, "reverse-proxy");
  assert.equal(settings.publicBaseUrl, "https://models.example.test/base");
  assert.deepEqual(settings.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(settings.rateLimitRpm, 5000);
  assert.equal(settings.maxConcurrentRequests, 1);
  assert.equal(settings.requestTimeoutSeconds, 10);
  assert.equal(settings.apiKey, "");
  assert.equal(settings.apiKeyHash, manager.hashServiceApiKey("sk-local-secret"));
  const redacted = manager.redactServiceExposureSettings(settings);
  assert.equal(redacted.apiKey, "");
  assert.equal(redacted.apiKeyHash, "");
  assert.equal(redacted.hasApiKey, true);
  assert.equal(redacted.apiKeyPreview, "sk-loca...cret");
});

test("service exposure checks catch unsafe external launch state", () => {
  const settings = manager.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "lan",
    requireApiKey: true,
  });
  const checks = manager.buildServiceExposureChecks(settings, {
    docker: { ok: true },
    container: { running: true, exists: true, status: "running" },
    endpoint: { networkAccess: "local" },
    runtime: { apiKeyRequired: false },
  });

  assert.ok(checks.some((check) => check.status === "warn" && /局域网/.test(check.title)));
  assert.ok(checks.some((check) => check.status === "fail" && /API Key/.test(check.title)));
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
    servedModels: [{ id: "Qwen/Qwen3-27B" }],
  }), "Qwen/Qwen3-27B");
});

test("service client policy overrides limits and restricts models", () => {
  const client = manager.normalizeServiceClient({
    id: "openwebui",
    name: "OpenWebUI",
    keyHash: manager.hashServiceApiKey("sk-test"),
    allowedModels: ["Qwen/Qwen3-27B"],
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
  assert.equal(manager.serviceClientAllowsModel(client, "served-id", {
    servedModels: [{ id: "served-id", root: "Qwen/Qwen3-27B" }],
  }), true);
  assert.equal(manager.serviceClientAllowsModel(client, "Other/Model", {
    servedModels: [{ id: "Other/Model" }],
  }), false);
});

test("extractHostname normalizes Host headers for the security guard", () => {
  assert.equal(manager.extractHostname("127.0.0.1:5177"), "127.0.0.1");
  assert.equal(manager.extractHostname("LOCALHOST:5177"), "localhost");
  assert.equal(manager.extractHostname("[::1]:5177"), "::1");
  assert.equal(manager.extractHostname("http://evil.example.com"), "evil.example.com");
  assert.equal(manager.extractHostname(""), "");
});

test("streamOpenAiAsClaude streams tool_use blocks incrementally", async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Checking." } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"pa" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"D:/AI\"}" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const upstream = {
    body: (async function* generate() {
      for (const frame of frames) yield Buffer.from(frame, "utf8");
    })(),
  };
  const written = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    headers: null,
    writeHead(status, headers) { this.headers = { status, ...headers }; },
    write(chunk) { written.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
  };

  await manager.streamOpenAiAsClaude(upstream, res, "local-test", { startedAt: Date.now() });

  const text = written.join("");
  assert.equal(res.writableEnded, true);
  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"text_delta","text":"Checking."/);
  assert.match(text, /"type":"tool_use","id":"call_1","name":"read_file"/);
  // arguments must arrive as separate incremental input_json_delta frames
  const argDeltas = text.match(/"type":"input_json_delta"/g) || [];
  assert.ok(argDeltas.length >= 2, `expected >=2 incremental arg deltas, got ${argDeltas.length}`);
  assert.match(text, /"stop_reason":"tool_use"/);
  assert.match(text, /"input_tokens":12,"output_tokens":6/);
  assert.match(text, /event: message_stop/);
});

test("normalizeModelConfig extracts dims, native context, and nested text_config", () => {
  const dense = manager.normalizeModelConfig({
    architectures: ["Qwen3ForCausalLM"],
    model_type: "qwen3",
    max_position_embeddings: 40960,
    num_hidden_layers: 64,
    num_attention_heads: 64,
    num_key_value_heads: 8,
    hidden_size: 5120,
    torch_dtype: "bfloat16",
  });
  assert.equal(dense.maxPositionEmbeddings, 40960);
  assert.equal(dense.numKeyValueHeads, 8);
  assert.equal(dense.headDim, 80); // derived hidden_size / num_attention_heads
  assert.equal(dense.quantMethod, "");

  const vision = manager.normalizeModelConfig({
    architectures: ["Gemma3ForConditionalGeneration"],
    vision_config: { hidden_size: 1152 },
    text_config: { num_hidden_layers: 48, num_attention_heads: 32, num_key_value_heads: 16, head_dim: 256, max_position_embeddings: 131072 },
    quantization_config: { quant_method: "compressed-tensors" },
  });
  assert.equal(vision.numHiddenLayers, 48);
  assert.equal(vision.headDim, 256);
  assert.equal(vision.maxPositionEmbeddings, 131072);
  assert.equal(vision.quantMethod, "compressed-tensors");
  assert.equal(vision.isMultimodal, true);
});

test("memory estimate helper uses shared vLLM semantics for DP and TP", () => {
  const base = {
    paramsB: 27,
    contextTokens: 65536,
    bytesPerParam: 0.5,
    kvBytes: 2,
    arch: { layers: 64, kvHeads: 8, headDim: 128 },
    gpuMemoryUtilization: 0.9,
    selectedGpus: [
      { id: "0", name: "RTX 5090", totalGb: 24, usedGb: 2 },
      { id: "1", name: "RTX PRO 6000", totalGb: 96, usedGb: 10 },
    ],
  };
  const dataParallel = manager.buildVllmMemoryEstimate({ ...base, multiGpuMode: "data", tensorParallelSize: 2 });
  const tensorParallel = manager.buildVllmMemoryEstimate({ ...base, multiGpuMode: "tensor", tensorParallelSize: 2 });

  assert.equal(dataParallel.ok, true);
  assert.equal(dataParallel.plan.memorySplitFactor, 1);
  assert.equal(tensorParallel.plan.memorySplitFactor, 2);
  assert.ok(dataParallel.plan.perGpuGb > tensorParallel.plan.perGpuGb);
  assert.match(dataParallel.recommendations.suggestions.join(" "), /Data Parallel/);
});

test("streamOpenAiAsClaude reports upstream failures as SSE error events", async () => {
  const upstream = {
    body: (async function* generate() {
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`, "utf8");
      throw new Error("connection reset");
    })(),
  };
  const written = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) { written.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
  };

  await manager.streamOpenAiAsClaude(upstream, res, "local-test", { startedAt: Date.now() });

  const text = written.join("");
  assert.equal(res.writableEnded, true);
  assert.match(text, /event: error/);
  assert.match(text, /connection reset/);
});
