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

test("model-check keeps retired Muse Glimmer blocked without deleting local files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vllm-manager-muse-glimmer-"));
  try {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
      model_type: "muse_glimmer",
      architectures: ["MuseGlimmerForConditionalGeneration"],
      transformers_version: "5.15.0.dev0",
    }));
    const report = await manager.checkModelCompatibility({ model: dir, remote: false });
    const finding = report.findings.find((item) => item.title === "Muse Glimmer 已弃用");
    assert.equal(finding?.severity, "fail");
    assert.match(finding.detail, /retired/);
    assert.equal(await fs.stat(path.join(dir, "config.json")).then((stat) => stat.isFile()), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime image metadata declares the pinned Transformers versions", () => {
  assert.equal(manager.knownRuntimeImageMetadata(manager.CONFIG.image)?.transformersVersion, "5.15.1");
  assert.equal(manager.knownRuntimeImageMetadata(manager.CONFIG.sglangImage)?.version, "0.5.17");
  assert.equal(manager.knownRuntimeImageMetadata(manager.CONFIG.qwenMoeImage)?.transformersVersion, "5.12.1");
  assert.equal(manager.knownRuntimeImageMetadata(manager.CONFIG.gemmaImage)?.transformersVersion, "5.10.2");
});

test("runtime image pulls are pinned to the configured linux/amd64 platform", () => {
  assert.deepEqual(manager.buildVllmImagePullOptions({
    VLLM_IMAGE_PULL_RETRIES: "4",
    VLLM_IMAGE_PULL_RETRY_DELAY_MS: "1250",
  }), {
    attempts: 4,
    initialDelayMs: 1250,
    platform: manager.CONFIG.imagePlatform,
  });
  assert.equal(manager.CONFIG.imagePlatform, "linux/amd64");
});

test("model-check ignores the legacy Muse override and keeps the retirement block", async () => {
  const previous = process.env.VLLM_ALLOW_MUSE_GLIMMER;
  try {
    process.env.VLLM_ALLOW_MUSE_GLIMMER = "1";
    const report = await manager.checkModelCompatibility({
      model: "meta-models/Muse-Glimmer-30B",
      runtimeImage: "custom/vllm:v0.26.0",
      remote: false,
    });
    const finding = report.findings.find((item) => item.title === "Muse Glimmer 已弃用");
    assert.equal(finding?.severity, "fail");
    assert.match(finding.detail, /no longer bypasses/);
    assert.equal(report.findings.some((item) => item.title === "Muse Glimmer 高风险绕过已启用"), false);
  } finally {
    if (previous === undefined) delete process.env.VLLM_ALLOW_MUSE_GLIMMER;
    else process.env.VLLM_ALLOW_MUSE_GLIMMER = previous;
  }
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
    allowedHeaders: "User-Agent\nX-Client-Version\ninvalid header",
    rateLimitRpm: 99999,
    maxConcurrentRequests: 0,
    requestTimeoutSeconds: 3,
  });

  assert.equal(settings.exposureMode, "reverse-proxy");
  assert.equal(settings.publicBaseUrl, "https://models.example.test/base");
  assert.equal(settings.corsMode, "restricted");
  assert.deepEqual(settings.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.deepEqual(settings.allowedHeaders, ["user-agent", "x-client-version"]);
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
  assert.equal(manager.resolveOpenAiGatewayModel("qwen3.6 35b", {
    servedModels: [{ id: "Qwen/Qwen3-27B" }],
  }), "");
});

test("signed service-entry instance selection recognizes primary, label, and container aliases", () => {
  assert.equal(manager.runtimeMatchesServiceGatewayInstance({
    container: { name: manager.CONFIG.containerName, labels: {} },
  }, "primary"), true);
  assert.equal(manager.runtimeMatchesServiceGatewayInstance({
    container: { name: "vllm-local-vision", labels: { "ai.manager.instance": "vision" } },
  }, "vision"), true);
  assert.equal(manager.runtimeMatchesServiceGatewayInstance({
    container: { name: "vllm-local-vision", labels: { "ai.manager.instance": "vision" } },
  }, "audio"), false);
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

test("model config capability summary keeps automatic MTP off for Qwen ModelOpt NVFP4", () => {
  const summary = manager.summarizeModelConfigCapabilities({
    architectures: ["Qwen3_5MoeForConditionalGeneration"],
    model_type: "qwen3_5_moe",
    text_config: { model_type: "qwen3_5_moe_text", mtp_num_hidden_layers: 1 },
    quantization_config: { quant_method: "modelopt" },
  }, "nv-community/Qwen3.6-35B-A3B-NVFP4");

  assert.equal(summary.speculative.nativeMtp, false);
  assert.equal(summary.speculative.nativeMtpLayers, 1);
  assert.equal(summary.speculative.nativeMtpTensorCount, 0);
  assert.equal(summary.speculative.enabled, false);
  assert.equal(summary.speculative.mode, "off");
  assert.match(summary.speculative.reason, /MTP/i);
});

test("model config capability summary enables MTP only when the local checkpoint contains MTP tensors", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vllm-manager-qwen38-mtp-"));
  try {
    await fs.writeFile(path.join(dir, "model.safetensors.index.json"), JSON.stringify({
      weight_map: {
        "model.layers.0.self_attn.q_proj.weight": "model-00001-of-00002.safetensors",
        "mtp.layers.0.self_attn.q_proj.weight": "model-00002-of-00002.safetensors",
      },
    }));
    const summary = manager.summarizeModelConfigCapabilities({
      architectures: ["Qwen3_8ForConditionalGeneration"],
      model_type: "qwen3_8",
      mtp_num_hidden_layers: 1,
      quantization_config: { quant_method: "fp8" },
    }, "Qwen/Qwen3.8-27B-FP8", dir);
    assert.equal(summary.speculative.nativeMtp, true);
    assert.equal(summary.speculative.nativeMtpTensorCount, 1);
    assert.equal(summary.speculative.enabled, true);
    assert.equal(summary.speculative.mode, "mtp");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Qwen3.8 detection does not confuse Qwen3-8B and DSpark container paths still require local evidence", () => {
  assert.equal(manager.isQwen38Model("Qwen/Qwen3.8-27B"), true);
  assert.equal(manager.isQwen38Model("Qwen/Qwen3-8B"), false);
  assert.equal(manager.resolveDsparkDraftModel("/models/not-a-real-dspark-checkpoint").ok, false);
});

test("runtime metrics use vLLM counters and SGLang native speculative gauges without mixing semantics", () => {
  const vllmMetrics = manager.parsePrometheusMetrics([
    'vllm:prompt_tokens_total{model_name="qwen"} 1000',
    'vllm:generation_tokens_total{model_name="qwen"} 500',
    'vllm:request_success_total{model_name="qwen",finished_reason="stop"} 5',
    'vllm:prefix_cache_queries_total{model_name="qwen"} 1000',
    'vllm:prefix_cache_hits_total{model_name="qwen"} 600',
    'vllm:spec_decode_num_drafts_total{model_name="qwen"} 100',
    'vllm:spec_decode_num_draft_tokens_total{model_name="qwen"} 300',
    'vllm:spec_decode_num_accepted_tokens_total{model_name="qwen"} 240',
    'vllm:cache_config_info{model_name="qwen",block_size="16",mamba_block_size="32"} 1',
  ].join("\n"));
  const [vllm] = manager.buildModelStats(vllmMetrics, { qwen: { id: "qwen", max_model_len: 262144 } }, {}, Date.now() / 1000, { updateSamples: false, engine: "vllm", runtimeVersion: "0.1.dev-test" });
  assert.equal(vllm.engine, "vllm");
  assert.equal(vllm.runtimeVersion, "0.1.dev-test");
  assert.equal(vllm.cache.prefixHitRate, 0.6);
  assert.equal(vllm.cache.alignmentBlockSize, 32);
  assert.equal(vllm.speculative.acceptanceRate, 0.8);
  assert.equal(vllm.speculative.acceptedTokensPerCycle, 2.4);
  assert.equal(vllm.speculative.draftTokensPerCycle, 3);
  assert.equal(vllm.speculative.source, "vllm_counters");

  const sglangMetrics = manager.parsePrometheusMetrics([
    'sglang:prompt_tokens_total{model_name="qwen"} 100',
    'sglang:cached_tokens_total{model_name="qwen"} 25',
    'sglang:generation_tokens_total{model_name="qwen"} 50',
    'sglang:num_requests_total{model_name="qwen"} 4',
    'sglang:num_aborted_requests_total{model_name="qwen"} 1',
    'sglang:spec_verify_calls_total{model_name="qwen"} 10',
    'sglang:spec_accept_rate{model_name="qwen"} 0.75',
    'sglang:spec_accept_length{model_name="qwen"} 4.2',
    'sglang:spec_cap_length{model_name="qwen"} 5',
    'sglang:spec_block_accept_length{model_name="qwen"} 4.5',
    'sglang:spec_num_steps{model_name="qwen"} 1',
    'sglang:spec_num_draft_tokens{model_name="qwen"} 7',
    'sglang:gen_throughput{model_name="qwen"} 212.4',
    'sglang:max_total_num_tokens{model_name="qwen"} 373883',
    'sglang:inter_token_latency_seconds_sum{model_name="qwen"} 1',
    'sglang:inter_token_latency_seconds_count{model_name="qwen"} 100',
  ].join("\n"));
  const [sglang] = manager.buildModelStats(sglangMetrics, { qwen: { id: "qwen", max_model_len: 262144 } }, {}, Date.now() / 1000, { updateSamples: false, engine: "sglang", runtimeVersion: "0.5.17" });
  assert.equal(sglang.engine, "sglang");
  assert.equal(sglang.runtimeVersion, "0.5.17");
  assert.equal(sglang.requests.total, 4);
  assert.equal(sglang.requests.aborted, 1);
  assert.equal(sglang.requests.success, 3);
  assert.equal(sglang.cache.prefixHitRate, 0.25);
  assert.equal(sglang.cache.source, "sglang_cached_token_counters");
  assert.equal(sglang.speculative.enabled, true);
  assert.equal(sglang.speculative.acceptanceRate, 0.75);
  assert.equal(sglang.speculative.meanAcceptLength, 4.2);
  assert.equal(sglang.speculative.configuredDraftTokens, 7);
  assert.equal(sglang.speculative.mode, "nextn");
  assert.equal(sglang.speculative.source, "sglang_gauges");
  assert.equal(sglang.speed.recentOutputTokensPerSecond, 212.4);
  assert.equal(sglang.speed.averageOutputTokensPerSecond, 100);
  assert.equal(sglang.context.capacityTokens, 373883);

  const [dspark] = manager.buildModelStats(sglangMetrics, { qwen: { id: "qwen", max_model_len: 262144 } }, {}, Date.now() / 1000, {
    updateSamples: false,
    engine: "sglang",
    speculativeMode: "dspark",
  });
  assert.equal(dspark.speculative.mode, "dspark");

  const facts = manager.buildSglangRuntimeFacts(sglangMetrics, [{ max_model_len: 262144 }], {
    "ai.runtime.kv-dtype": "fp8_e4m3",
    "ai.runtime.kv-scale": "unit",
    "ai.runtime.storage": "nvme-ple",
    "ai.runtime.ple-dtype": "fp8_e4m3",
    "ai.runtime.speculative": "nextn",
    "ai.runtime.thinking": "strict-toggle",
    "ai.runtime.cache": "persistent-ext4",
    "ai.runtime.context-length": "262144",
    "ai.runtime.max-total-tokens": "220000",
    "ai.runtime.chunked-prefill": "4096",
    "ai.runtime.fp4-backend": "flashinfer_cutlass",
    "ai.runtime.moe-backend": "flashinfer_cutlass",
  });
  assert.equal(facts.kvCacheTokens, 373883);
  assert.equal(facts.runtimeConfig.kvCacheQuantized, true);
  assert.equal(facts.runtimeConfig.kvScaleMode, "unit");
  assert.equal(facts.runtimeConfig.storageMode, "nvme-ple");
  assert.equal(facts.runtimeConfig.pleDtype, "fp8_e4m3");
  assert.equal(facts.runtimeConfig.speculativeMode, "nextn");
  assert.equal(facts.runtimeConfig.thinkingMode, "strict-toggle");
  assert.equal(facts.runtimeConfig.cacheMode, "persistent-ext4");
  assert.equal(facts.runtimeConfig.contextLength, 262144);
  assert.equal(facts.runtimeConfig.maxTotalTokens, 220000);
  assert.equal(facts.runtimeConfig.chunkedPrefillSize, 4096);
  assert.equal(facts.runtimeConfig.fp4Backend, "flashinfer_cutlass");
  assert.equal(facts.runtimeConfig.moeBackend, "flashinfer_cutlass");
});

test("Docker creation timestamps provide a stable process fallback for runtimes without process_start_time_seconds", () => {
  assert.equal(manager.parseDockerCreatedAtSeconds("2026-08-15 19:20:31 +1000 AEST"), 1786785631);
  assert.equal(manager.parseDockerCreatedAtSeconds(""), null);
  assert.equal(manager.parseDockerCreatedAtSeconds("not-a-date"), null);
});

test("SGLang speed keeps the last real gauge and falls back to the active average", () => {
  const liveMetrics = manager.parsePrometheusMetrics([
    'sglang:generation_tokens_total{model_name="qwen-speed-cache"} 200',
    'sglang:gen_throughput{model_name="qwen-speed-cache"} 145.5',
  ].join("\n"));
  const [live] = manager.buildModelStats(liveMetrics, { "qwen-speed-cache": { id: "qwen-speed-cache" } }, {}, 1000, {
    updateSamples: true,
    engine: "sglang",
  });
  assert.equal(live.speed.recentOutputTokensPerSecond, 145.5);
  assert.equal(live.speed.outputSource, "sglang_live_gauge");

  const idleMetrics = manager.parsePrometheusMetrics([
    'sglang:generation_tokens_total{model_name="qwen-speed-cache"} 2200',
    'sglang:gen_throughput{model_name="qwen-speed-cache"} 0',
  ].join("\n"));
  const [recent] = manager.buildModelStats(idleMetrics, { "qwen-speed-cache": { id: "qwen-speed-cache" } }, {}, 1005, {
    updateSamples: true,
    engine: "sglang",
  });
  assert.equal(recent.speed.recentOutputTokensPerSecond, 145.5);
  assert.equal(recent.speed.outputSource, "sglang_recent_gauge");

  const [stillRecent] = manager.buildModelStats(idleMetrics, { "qwen-speed-cache": { id: "qwen-speed-cache" } }, {}, 1061, {
    updateSamples: true,
    engine: "sglang",
  });
  assert.equal(stillRecent.speed.recentOutputTokensPerSecond, 145.5);
  assert.equal(stillRecent.speed.outputSource, "sglang_recent_gauge");

  const averageOnlyMetrics = manager.parsePrometheusMetrics([
    'sglang:generation_tokens_total{model_name="qwen-average-only"} 1000',
    'sglang:gen_throughput{model_name="qwen-average-only"} 0',
    'sglang:inter_token_latency_seconds_sum{model_name="qwen-average-only"} 10',
    'sglang:inter_token_latency_seconds_count{model_name="qwen-average-only"} 1000',
  ].join("\n"));
  const [averageOnly] = manager.buildModelStats(averageOnlyMetrics, { "qwen-average-only": { id: "qwen-average-only" } }, {}, 2000, {
    updateSamples: true,
    engine: "sglang",
    runtimeSampleKey: "fresh-runtime",
  });
  assert.equal(averageOnly.speed.recentOutputTokensPerSecond, 100);
  assert.equal(averageOnly.speed.outputSource, "sglang_active_average");
});

test("local model config request accepts the frontend local source", async () => {
  const result = await manager.getModelConfigRequest({ model: "D:/AI/models/not-present-for-test", source: "local" });
  assert.equal(result.found, false);
  assert.equal(result.source, "local");
  assert.match(result.reason, /本地模型目录|Hugging Face/);
});

test("Qwen request defaults fill safe sampling values without overriding the client", () => {
  assert.deepEqual(manager.applyVllmRequestDefaults({ model: "Qwen3.6-35B" }), {
    model: "Qwen3.6-35B",
    temperature: 1,
    top_p: 0.95,
    top_k: 20,
  });
  assert.deepEqual(manager.applyVllmRequestDefaults({
    model: "Qwen3.6-35B",
    temperature: 0,
    top_p: 0.8,
    top_k: 7,
    chat_template_kwargs: { enable_thinking: false },
  }), {
    model: "Qwen3.6-35B",
    temperature: 0,
    top_p: 0.8,
    top_k: 7,
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.deepEqual(manager.applyVllmRequestDefaults({ model: "Llama-3" }), { model: "Llama-3" });
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

test("Qwen3.6 MoE NVFP4 uses the nightly runtime preset", () => {
  const qwenMoeConfig = {
    architectures: ["Qwen3_5MoeForConditionalGeneration"],
    model_type: "qwen3_5_moe",
    quantization_config: {
      quant_method: "modelopt",
      quant_algo: "MIXED_PRECISION",
      kv: { quant_algo: "W4A16_NVFP4" },
    },
  };

  assert.equal(manager.isQwen36MoeNvfp4Model("D:/AI/models/nv-community-Qwen3.6-35B-A3B-NVFP4", qwenMoeConfig), true);
  const qwenDenseConfig = {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    model_type: "qwen3_5",
    quantization_config: {
      quant_method: "modelopt",
      quant_algo: "MIXED_PRECISION",
      lm_head: { quant_algo: "W4A16_NVFP4" },
    },
  };
  assert.equal(manager.isQwen36MoeNvfp4Model("D:/AI/models/nv-community-Qwen3.6-27B-NVFP4", qwenDenseConfig), false);
  assert.equal(manager.isQwen36DenseNvfp4Model("D:/AI/models/nv-community-Qwen3.6-27B-NVFP4", qwenDenseConfig), true);
  assert.equal(manager.isQwen36MoeNvfp4Model("D:/AI/models/unsloth-Qwen3.6-27B-NVFP4", {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    quantization_config: { quant_method: "compressed-tensors" },
  }), false);
  assert.equal(manager.isQwen36DenseNvfp4Model("D:/AI/models/unsloth-Qwen3.6-27B-NVFP4", {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    quantization_config: { quant_method: "compressed-tensors" },
  }), false);
  assert.equal(manager.isQwen36MoeNvfp4Model("D:/AI/models/Qwen-Qwen3.6-27B-FP8", {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    model_type: "qwen3_5",
    quantization_config: { quant_method: "fp8" },
  }), false);
  assert.equal(manager.isQwen36DenseNvfp4Model("D:/AI/models/Qwen-Qwen3.6-27B-FP8", {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    model_type: "qwen3_5",
    quantization_config: { quant_method: "fp8" },
  }), false);

  const preset = manager.resolveVllmRuntimePreset({
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    kvCacheDtype: "auto",
    hostGpus: [{ id: "0", name: "NVIDIA RTX PRO 5000 Blackwell", computeCap: "12.0" }],
  }, {});

  assert.equal(preset.id, "qwen3.6-moe-nvfp4");
  assert.equal(preset.image, manager.CONFIG.qwenMoeImage);
  assert.equal(preset.forceTrustRemoteCode, true);
  assert.equal(preset.attentionBackend, "flashinfer");
  assert.equal(preset.moeBackend, "flashinfer_b12x");
  assert.equal(preset.dtype, "bfloat16");
  assert.equal(preset.generationConfig, "vllm");
  assert.equal(preset.kvCacheDtype, "fp8");
  assert.equal(preset.disableQuantizationArg, undefined);
  assert.equal(preset.disableKvCacheDtypeArg, undefined);
  assert.equal(preset.defaultChatTemplateKwargs, undefined);
  assert.equal(preset.toolCallParser, "qwen3_xml");
  assert.equal(preset.maxNumBatchedTokens, 8192);

  const nonSm12Preset = manager.resolveVllmRuntimePreset({
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    kvCacheDtype: "auto",
    hostGpus: [{ id: "0", name: "NVIDIA RTX 4090", computeCap: "8.9" }],
  }, {});

  assert.equal(nonSm12Preset.moeBackend, "marlin");
  assert.equal(nonSm12Preset.dtype, undefined);

  const densePreset = manager.resolveVllmRuntimePreset({
    model: "nvidia/Qwen3.6-27B-NVFP4",
    kvCacheDtype: "auto",
  }, {});

  assert.equal(densePreset.id, "qwen3.6-dense-nvfp4");
  assert.equal(densePreset.attentionBackend, "TRITON_ATTN");
  assert.equal(densePreset.disableQuantizationArg, true);
  assert.equal(densePreset.disableKvCacheDtypeArg, true);
  assert.equal(densePreset.defaultChatTemplateKwargs, undefined);
  assert.equal(densePreset.toolCallParser, "qwen3_xml");
  assert.equal(densePreset.maxNumBatchedTokens, 8192);
});

test("DiffusionGemma is blocked by default on Windows Docker WSL", () => {
  const diffusionConfig = {
    architectures: ["DiffusionGemmaForBlockDiffusion"],
    model_type: "diffusion_gemma",
  };

  assert.equal(manager.isDiffusionGemmaModel("D:/AI/models/nv-community-diffusiongemma-26B-A4B-it-NVFP4", diffusionConfig), true);
  assert.equal(manager.resolveVllmRuntimePreset({
    model: "D:/AI/models/nv-community-diffusiongemma-26B-A4B-it-NVFP4",
  }, { localPath: "" }).id, "diffusion-gemma");
  assert.match(manager.diffusionGemmaWindowsBlockReason("win32", {}), /UVA.*device-side assert/);
  assert.equal(manager.diffusionGemmaWindowsBlockReason("win32", { VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: "1" }), "");
  assert.equal(manager.diffusionGemmaWindowsBlockReason("linux", {}), "");
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
