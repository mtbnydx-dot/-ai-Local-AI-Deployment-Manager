const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const core = require("..");

test("network helpers normalize local, lan, and host values", () => {
  assert.equal(core.normalizeRemoteAddress("::ffff:192.168.1.2"), "192.168.1.2");
  assert.equal(core.isLocalAddress("127.0.0.1"), true);
  assert.equal(core.isLocalAddress("192.168.1.2"), false);
  assert.equal(core.isExternalAddress("192.168.1.9", "192.168.1.2"), true);
  assert.equal(core.isExternalAddress("192.168.1.2", "192.168.1.2"), false);
  assert.equal(core.extractHostname("http://192.168.1.2:5177/path"), "192.168.1.2");
});

test("secret records migrate legacy plaintext to hash-only shape", () => {
  const record = core.normalizeSecretRecord({ apiKey: "sk-local-secret" });
  assert.equal(record.secret, "");
  assert.equal(record.hash, core.hashSecret("sk-local-secret"));
  assert.equal(record.preview, "sk-loca...cret");
  assert.equal(core.isSecretAccepted("sk-local-secret", record), true);
  assert.equal(core.isSecretAccepted("wrong", record), false);
  const migrated = core.normalizeSecretRecord({}, { apiKey: "sk-legacy" });
  assert.equal(migrated.hash, core.hashSecret("sk-legacy"));
});

test("gateway helpers extract common auth fields", () => {
  assert.equal(core.serviceApiKeySource({ authorization: "Bearer sk-test" }), "authorization-bearer");
  assert.equal(core.extractServiceApiKey({ authorization: "Bearer sk-test" }), "sk-test");
  assert.equal(core.extractServiceApiKey({ authorization: "sk-raw" }, { acceptRawAuthorization: true }), "sk-raw");
  assert.equal(core.extractServiceApiKey({ "anthropic-api-key": "sk-anthropic" }), "sk-anthropic");
  assert.equal(core.resolveOpenAiGatewayModel("root-alias", {
    servedModels: [{ id: "Qwen/Qwen3-27B" }],
  }, {
    rootMappings: [{ id: "Qwen/Qwen3-27B", root: "root-alias" }],
  }), "Qwen/Qwen3-27B");
});

test("gateway helpers format Claude upstream errors and expected disconnects", async () => {
  assert.deepEqual(core.claudeError("api_error", "failed"), {
    type: "error",
    error: { type: "api_error", message: "failed" },
  });
  assert.equal(core.upstreamErrorMessage({ error: { message: "quota exceeded" } }, ""), "quota exceeded");
  assert.equal(core.upstreamErrorMessage(null, "", "fallback"), "fallback");
  assert.equal(core.isExpectedStreamDisconnect({ name: "AbortError" }), true);
  assert.equal(core.isExpectedStreamDisconnect({ code: "ERR_STREAM_PREMATURE_CLOSE" }), true);
  assert.equal(core.isExpectedStreamDisconnect(new Error("boom")), false);

  const state = { status: 0, body: null };
  const res = {
    status(code) {
      state.status = code;
      return this;
    },
    json(body) {
      state.body = body;
      return body;
    },
  };
  await core.sendClaudeUpstreamError(res, {
    status: 429,
    text: async () => JSON.stringify({ error: { message: "too many requests" } }),
  });
  assert.equal(state.status, 429);
  assert.equal(state.body.error.message, "too many requests");
});

test("connection guide snapshot builds OpenAI, Claude, OpenWebUI, and ccswitch hints", () => {
  const guide = core.buildConnectionGuideSnapshot({
    runtime: {
      container: { running: true },
      models: [{ id: "local-model" }],
    },
    endpoint: {
      localUrl: "http://127.0.0.1:8080/v1",
      compat: {
        openai: { baseUrl: "http://127.0.0.1:8080/v1" },
        claude: { baseUrl: "http://127.0.0.1:5177/claude", modelAlias: "claude-opus-4-7" },
      },
    },
    managerLocal: "http://127.0.0.1:5177",
    managerLan: "http://192.168.1.27:5177",
    claudeModelAliases: ["claude-sonnet-4-5"],
    generatedAt: "2026-06-15T00:00:00.000Z",
  });
  assert.equal(guide.ok, true);
  assert.equal(guide.manager.lan, "http://192.168.1.27:5177");
  assert.equal(guide.openai.baseUrl, "http://127.0.0.1:5177/serve/v1");
  assert.equal(guide.openai.lanBaseUrl, "http://192.168.1.27:5177/serve/v1");
  assert.equal(guide.openai.directBaseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(guide.openwebui.baseUrl, "http://192.168.1.27:5177/serve/v1");
  assert.equal(guide.openwebui.model, "local-model");
  assert.equal(guide.claude.modelAlias, "claude-opus-4-7");
  assert.equal(guide.ccswitch.providerBaseUrl, "http://192.168.1.27:5177/claude");
});

test("compatibility endpoints normalize local, LAN, and Claude URLs", () => {
  const endpoint = core.buildCompatibilityEndpoints({
    servicePort: 8000,
    boundHost: "0.0.0.0",
    displayHost: "192.168.1.27",
    lanHost: null,
    managerPort: 5177,
    managerHost: "0.0.0.0",
    getLanAddress: () => "192.168.1.27",
    claudeModelAlias: "claude-opus-4-7",
  });
  assert.equal(endpoint.openai.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(endpoint.openai.serviceBaseUrl, "http://192.168.1.27:8000/v1");
  assert.equal(endpoint.openai.lanBaseUrl, "http://192.168.1.27:8000/v1");
  assert.equal(endpoint.openai.chatCompletionsUrl, "http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(endpoint.claude.baseUrl, "http://127.0.0.1:5177/claude");
  assert.equal(endpoint.claude.publicBaseUrl, "http://192.168.1.27:5177/claude");
  assert.equal(endpoint.claude.modelAlias, "claude-opus-4-7");

  const local = core.buildCompatibilityEndpoints({
    servicePort: 8080,
    boundHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    managerPort: 5178,
    managerHost: "127.0.0.1",
    getLanAddress: () => "192.168.1.27",
  });
  assert.equal(local.openai.lanBaseUrl, null);
  assert.equal(local.claude.publicBaseUrl, null);
  assert.equal(Object.hasOwn(local.claude, "modelAlias"), false);

  const ipv6 = core.buildCompatibilityEndpoints({
    servicePort: 8000,
    boundHost: "[::]",
    displayHost: "[::1]",
    lanHost: "fe80::1",
    managerPort: 5177,
    managerHost: "[::]",
    getLanAddress: () => "fe80::1",
  });
  assert.equal(ipv6.openai.lanBaseUrl, "http://[fe80::1]:8000/v1");
  assert.equal(ipv6.claude.publicBaseUrl, "http://[fe80::1]:5177/claude");
});

test("compatibility helpers build reports and fetch shared remote metadata", async () => {
  const findings = [
    core.compatibilityFinding("ok", "local", "ready"),
    core.compatibilityFinding("warn", "license", "token needed"),
  ];
  const report = core.buildCompatibilityReport({
    model: "owner/model",
    findings,
    recommendations: { maxModelLen: 32768 },
    generatedAt: "2026-06-15T00:00:00.000Z",
  });
  assert.equal(report.ok, true);
  assert.equal(report.severity, "warn");
  assert.equal(report.recommendations.maxModelLen, 32768);

  const calls = [];
  const remoteFindings = [];
  const remote = await core.fetchRemoteCompatibilityInfo({
    model: "owner/model:Q4_K_M",
    modelInfoId: "owner/model",
    findings: remoteFindings,
    getHuggingFaceModelInfo: async (id) => {
      calls.push(id);
      return { label: "Owner Model", lastModified: "2026-06-01", gated: true, hasGguf: false };
    },
    onInfo: (info, targetFindings) => targetFindings.push(core.compatibilityFinding("warn", "extra", String(info.hasGguf))),
  });
  assert.deepEqual(calls, ["owner/model"]);
  assert.equal(remote.gated, true);
  assert.deepEqual(remoteFindings.map((item) => item.severity), ["ok", "warn", "warn"]);

  const skipped = await core.fetchRemoteCompatibilityInfo({
    model: "owner/model",
    local: { path: "D:/AI/models/model" },
    findings: [],
    getHuggingFaceModelInfo: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(skipped, null);
});

test("capture helpers parse last, unique, and average values safely", () => {
  const text = [
    "ctx=4,096",
    "ctx=8,192",
    "eval time = 10 ms",
    "eval time = 20 ms",
    "task 1 done",
    "task 2 done",
    "task 1 retried",
  ].join("\n");
  assert.equal(core.lastCapture("model=qwen model=llama", /model=(\w+)/), "llama");
  assert.equal(core.lastIntegerMatch(text, /ctx=([\d,]+)/i), 8192);
  assert.equal(core.lastFloatMatch(text, /eval time = ([\d.]+) ms/i), 20);
  assert.equal(core.countUniqueCaptures(text, /task\s+(\d+)/i), 2);
  assert.equal(core.averageCapture(text, /eval time = ([\d.]+) ms/i, 0.001), 0.015);
});

test("manager security guard preserves host, gateway, remote, and origin policy", () => {
  function makeResponse() {
    const state = { statusCode: 200, json: null, next: 0 };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json = value;
        return value;
      },
    };
    return { res, state, next: () => { state.next += 1; } };
  }
  const makeReq = (overrides = {}) => ({
    method: "GET",
    path: "/api/status",
    originalUrl: "/api/status",
    headers: { host: "127.0.0.1:5177" },
    local: false,
    ...overrides,
  });

  const vllm = core.createManagerSecurityGuard({
    host: "127.0.0.1",
    getLanAddress: () => "192.168.1.27",
    isLocalRequest: (req) => Boolean(req.local),
    gatewayKinds: ["openai", "claude", "opencode"],
    allowRemoteManagement: false,
    blockRemoteReads: true,
  }).managerSecurityGuard;

  let response = makeResponse();
  vllm(makeReq({ headers: { host: "evil.example" } }), response.res, response.next);
  assert.equal(response.state.statusCode, 403);
  assert.match(response.state.json.error, /Host/);

  response = makeResponse();
  vllm(makeReq({ headers: { host: "192.168.1.27:5177" } }), response.res, response.next);
  assert.equal(response.state.statusCode, 403);
  assert.match(response.state.json.error, /管理后台默认仅允许本机访问/);

  response = makeResponse();
  vllm(makeReq({
    path: "/claude/v1/messages",
    originalUrl: "/claude/v1/messages",
    headers: { host: "192.168.1.27:5177" },
  }), response.res, response.next);
  assert.equal(response.state.next, 1);

  response = makeResponse();
  vllm(makeReq({
    local: true,
    method: "POST",
    headers: { host: "127.0.0.1:5177", origin: "https://evil.example" },
  }), response.res, response.next);
  assert.equal(response.state.statusCode, 403);
  assert.match(response.state.json.error, /Origin/);

  const llama = core.createManagerSecurityGuard({
    host: "127.0.0.1",
    getLanAddress: () => "192.168.1.27",
    isLocalRequest: (req) => Boolean(req.local),
    gatewayKinds: ["openai", "claude"],
    allowRemoteManagement: false,
    blockRemoteReads: false,
    remoteManagementError: "remote writes disabled",
  }).managerSecurityGuard;

  response = makeResponse();
  llama(makeReq({ headers: { host: "192.168.1.27:5178" } }), response.res, response.next);
  assert.equal(response.state.next, 1);

  response = makeResponse();
  llama(makeReq({ method: "POST", headers: { host: "192.168.1.27:5178" } }), response.res, response.next);
  assert.equal(response.state.statusCode, 403);
  assert.equal(response.state.json.error, "remote writes disabled");
});

test("Claude route registrar wires compatibility endpoints", () => {
  const routes = [];
  const app = {
    get: (pathName, handler) => routes.push({ method: "GET", pathName, handler }),
    post: (pathName, handler) => routes.push({ method: "POST", pathName, handler }),
  };
  const handlers = {
    models: () => "models",
    messages: () => "messages",
    countTokens: () => "count",
  };
  const registered = core.registerClaudeRoutes(app, handlers);
  assert.deepEqual(registered.modelRoutes, core.DEFAULT_CLAUDE_MODEL_ROUTES);
  assert.deepEqual(registered.messageRoutes, core.DEFAULT_CLAUDE_MESSAGE_ROUTES);
  assert.deepEqual(registered.countTokenRoutes, core.DEFAULT_CLAUDE_COUNT_TOKEN_ROUTES);
  assert.equal(routes.length, 10);
  assert.equal(routes.find((route) => route.pathName === "/claude/v1/messages/v1/messages").handler, handlers.messages);
  assert.equal(routes.find((route) => route.pathName === "/v1/messages/count_tokens").method, "POST");
  assert.throws(() => core.registerClaudeRoutes(app, { models: handlers.models }), /messages handler/);
});

test("Prometheus helpers parse labels and aggregate metrics", () => {
  const metrics = core.parsePrometheusMetrics([
    'vllm:requests_total{model_name="qwen",status="ok"} 2',
    'vllm:requests_total{model_name="qwen",status="error"} 1',
    'vllm:latency_seconds_sum 9',
    'vllm:latency_seconds_count 3',
    'bad_metric NaN',
  ].join("\n"));
  assert.equal(metrics.length, 4);
  assert.equal(core.parsePrometheusLabels('a="b\\"c",path="x\\\\y"').a, 'b"c');
  assert.equal(core.sumMetric(metrics, "vllm:requests_total"), 3);
  assert.deepEqual(core.sumByLabel(metrics, "vllm:requests_total", "status"), { ok: 2, error: 1 });
  assert.equal(core.histogramAverage(metrics, "vllm:latency_seconds"), 3);
  assert.equal(core.tokensPerSecondFromSeconds(0.5), 2);
  assert.equal(core.weightedAverage([{ value: 2, weight: 3 }, { value: 10, weight: 1 }], (item) => item.value, (item) => item.weight), 4);
});

test("stats helpers aggregate model totals and calculate API value", () => {
  const totals = core.aggregateStats([
    {
      tokens: { prompt: 100, generation: 40, cachedPrompt: 20 },
      requests: { total: 3, error: 1, aborted: 0 },
      speed: { recentPromptTokensPerSecond: 10, recentOutputTokensPerSecond: 4, recentRequestsPerMinute: 2 },
      latency: { avgE2eSeconds: 2, avgTtftSeconds: 0.5, avgTimePerOutputTokenSeconds: 0.1 },
      context: { activeTokens: 1000, capacityTokens: 4000 },
    },
    {
      tokens: { prompt: 50, generation: 10, cachedPrompt: 0 },
      requests: { total: 1, error: 0, aborted: 0 },
      speed: { recentPromptTokensPerSecond: 5, recentOutputTokensPerSecond: 1, recentRequestsPerMinute: 1 },
      latency: { avgE2eSeconds: 6, avgTtftSeconds: 1, avgTimePerOutputTokenSeconds: 0.2 },
      context: { activeTokens: 500, capacityTokens: 1000 },
    },
  ], 10);
  assert.deepEqual(totals.tokens, { prompt: 150, generation: 50, cachedPrompt: 20, total: 200 });
  assert.deepEqual(totals.requests, { total: 4, success: 3, error: 1, aborted: 0 });
  assert.equal(totals.speed.lifetimeTokensPerSecond, 20);
  assert.equal(totals.context.kvUsagePercent, 0.3);

  const cost = core.calculateCost({ prompt: 1_000_000, generation: 500_000, cachedPrompt: 250_000 }, {
    id: "test",
    inputPerM: 2,
    cachedInputPerM: 0.5,
    outputPerM: 10,
  });
  assert.equal(cost.standardCost, 7);
  assert.equal(cost.cachedEquivalentCost, 6.625);
});

test("stats helpers build empty summaries and recent rate samples", () => {
  const empty = core.emptyStatsSummary({ exists: true }, { port: 5177 }, {
    stoppedNote: "runtime stopped",
    missingNote: "runtime missing",
  });
  assert.equal(empty.source, "http://127.0.0.1:5177/metrics");
  assert.equal(empty.totals.tokens.total, 0);
  assert.equal(empty.note, "runtime stopped");

  const missing = core.emptyStatsSummary(null, null, {
    stoppedNote: "runtime stopped",
    missingNote: "runtime missing",
  });
  assert.equal(missing.source, null);
  assert.equal(missing.note, "runtime missing");

  const samples = new Map();
  assert.deepEqual(core.calculateRecentRates(samples, "model-a", 10, {
    promptTokens: 100,
    generationTokens: 20,
    requestCount: 2,
  }, true), {
    recentPromptTokensPerSecond: 0,
    recentOutputTokensPerSecond: 0,
    recentRequestsPerMinute: 0,
  });
  const rates = core.calculateRecentRates(samples, "model-a", 20, {
    promptTokens: 160,
    generationTokens: 50,
    requestCount: 5,
  }, true);
  assert.equal(rates.recentPromptTokensPerSecond, 6);
  assert.equal(rates.recentOutputTokensPerSecond, 3);
  assert.equal(rates.recentRequestsPerMinute, 18);
});

test("stats ledger helpers merge runtime deltas and rebuild summaries", () => {
  const ledger = { models: {}, runtimes: {}, updatedAt: "2026-06-15T00:00:00.000Z" };
  const model = {
    name: "local-model",
    root: "root-model",
    tokens: { prompt: 100, generation: 40, cachedPrompt: 10 },
    requests: { total: 3, success: 2, error: 1, aborted: 0 },
    context: { activeTokens: 1024, capacityTokens: 4096, kvUsagePercent: 0.25, maxModelLen: 4096 },
    latency: { avgE2eSeconds: 1.2 },
    speed: { averageOutputTokensPerSecond: 45 },
  };
  const current = core.runtimeCountersFromStatsModel(model);
  const previous = core.emptyRuntimeCounters();
  const delta = core.diffRuntimeCounters(current, previous);
  core.mergeStatsLedgerModelDelta(ledger, model, delta, {
    processStartSeconds: 42,
    facts: { maxModelLen: 4096 },
  }, "collect", { now: "2026-06-15T00:01:00.000Z" });

  assert.deepEqual(core.maxRuntimeCounters({ prompt: 5, generation: 1 }, { prompt: 9, generation: 0 }), { prompt: 9, generation: 1 });
  assert.equal(ledger.models["local-model"].tokens.total, 140);
  assert.equal(ledger.models["local-model"].last.updatedAt, "2026-06-15T00:01:00.000Z");

  const summary = core.statsLedgerToSummary(ledger);
  assert.equal(summary.models[0].name, "local-model");
  assert.equal(summary.totals.tokens.total, 140);
  assert.equal(summary.totals.context.kvUsagePercent, 0.25);

  const merged = core.mergeLiveAndStatsLedger({
    source: "live",
    uptimeSeconds: 10,
    models: [{
      ...summary.models[0],
      tokens: { ...summary.models[0].tokens, total: 200, prompt: 120, generation: 80 },
      context: { activeTokens: 512, capacityTokens: 4096, kvUsagePercent: 0.125 },
      requests: { ...summary.models[0].requests, running: 1, waiting: 2 },
    }],
  }, ledger);
  assert.equal(merged.source, "live");
  assert.equal(merged.models[0].context.kvUsagePercent, 0.125);
  assert.equal(merged.models[0].requests.running, 1);
});

test("runtime fact hints can match persisted jobs", () => {
  const needles = core.normalizeRuntimeFactHints(["Qwen3.6-27B"]);
  assert.equal(core.jobMatchesRuntimeFactHints({
    meta: {
      model: "D:/AI/models/sakamakismile-Qwen3.6-27B-Text-NVFP4-MTP",
    },
  }, needles), true);
  assert.equal(core.jobMatchesRuntimeFactHints({
    meta: {
      servedModels: [{ id: "other/model", root: "other-root" }],
    },
  }, needles), false);
});

test("stats helpers build client usage summaries with sessions and shares", () => {
  const totals = {
    tokens: { prompt: 1000, generation: 500, cachedPrompt: 100, total: 1500 },
    requests: { total: 10, success: 8, error: 1, aborted: 1 },
  };
  const ledger = {
    clients: {
      claude: {
        tokens: { prompt: 400, generation: 100, cachedPrompt: 25, total: 500 },
        requests: { total: 4, success: 3, error: 1, streamed: 2 },
        tools: { schemaCount: 3, toolUseCount: 2 },
        compression: { applied: 1, savedTokens: 120 },
        latency: { totalMs: 1000, maxMs: 700 },
        models: {
          "model-a": {
            tokens: { prompt: 300, generation: 100 },
            requests: { total: 3, success: 2, error: 1, streamed: 1 },
            tools: { schemas: 2, toolUse: 1 },
            compression: { applied: 1, savedTokens: 120 },
            latency: { totalMs: 800, maxMs: 500 },
          },
        },
        session: { currentId: "claude-task-1", switches: 2 },
        sessions: {
          "claude-task-1": {
            id: "claude-task-1",
            label: "Task 1",
            source: "cowork",
            lastSeenAt: "2026-06-15T01:00:00.000Z",
            tokens: { prompt: 100, generation: 50 },
            requests: { total: 2 },
            models: { "model-a": {} },
          },
        },
      },
    },
  };

  const summary = core.buildClientUsageSummary(totals, ledger, {
    claude: { label: "Claude bridge", description: "Claude requests" },
    other: { id: "chat", label: "Chat", description: "Direct traffic" },
    note: "split note",
  });

  assert.equal(summary.clients.length, 2);
  assert.equal(summary.clients[0].label, "Claude bridge");
  assert.equal(summary.clients[0].tokens.total, 500);
  assert.equal(summary.clients[0].tools.schemas, 3);
  assert.equal(summary.clients[0].models[0].tokens.total, 400);
  assert.equal(summary.clients[0].session.currentId, "claude-task-1");
  assert.equal(summary.clients[0].sessions[0].modelCount, 1);
  assert.equal(summary.clients[0].share.tokens, 500 / 1500);
  assert.equal(summary.clients[1].id, "chat");
  assert.equal(summary.clients[1].tokens.total, 1000);
  assert.equal(summary.clients[1].requests.success, 5);
  assert.equal(summary.note, "split note");
});

test("stats helpers apply Claude bridge usage with sessions, compression, and aliases", () => {
  let client = core.applyClaudeBridgeUsage(null, {
    requestedModel: "claude-opus-4-7",
    model: "Qwen3.6-27B",
    ok: true,
    stream: true,
    usage: { input_tokens: 320, output_tokens: 80 },
    latencyMs: 1250,
    toolSchemaCount: 4,
    toolUseCount: 2,
    stopReason: "tool_use",
    compression: {
      applied: true,
      originalPromptTokens: 900,
      compressedPromptTokens: 260,
      savedTokens: 640,
      summarizedMessageCount: 12,
      recentMessageCount: 4,
      contextLimit: 262144,
      triggerRatio: 0.9,
    },
    session: {
      id: "task-1",
      label: "Local coding task",
      source: "cowork",
      fingerprint: "fp-1",
    },
  }, {
    id: "claude",
    label: "Claude bridge",
    defaultOk: false,
    trackSessions: true,
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(client.tokens.total, 400);
  assert.equal(client.requests.success, 1);
  assert.equal(client.requests.streamed, 1);
  assert.equal(client.tools.schemas, 4);
  assert.equal(client.tools.toolUse, 2);
  assert.equal(client.compression.applied, 1);
  assert.equal(client.compression.savedTokens, 640);
  assert.equal(client.compression.summarizedMessages, 12);
  assert.equal(client.models["Qwen3.6-27B"].tokens.total, 400);
  assert.equal(client.aliases["claude-opus-4-7"], 1);
  assert.equal(client.session.currentId, "task-1");
  assert.equal(client.session.resets, 1);
  assert.equal(client.sessions["task-1"].compression.recentMessages, 4);
  assert.equal(client.sessions["task-1"].models["Qwen3.6-27B"].requests.streamed, 1);

  client = core.applyClaudeBridgeUsage(client, {
    requestedModel: "claude-opus-4-7",
    model: "",
    ok: false,
    error: "upstream failed",
    latencyMs: 100,
    session: { id: "task-2", label: "Second task", source: "code" },
  }, {
    id: "claude",
    label: "Claude bridge",
    defaultOk: false,
    trackSessions: true,
    now: "2026-06-15T00:01:00.000Z",
  });

  assert.equal(client.requests.total, 2);
  assert.equal(client.requests.error, 1);
  assert.equal(client.models.unknown.requests.error, 1);
  assert.equal(client.aliases["claude-opus-4-7"], 2);
  assert.equal(client.session.currentId, "task-2");
  assert.equal(client.session.switches, 1);
  assert.equal(client.session.resets, 2);
  assert.equal(client.sessions["task-2"].last.error, "upstream failed");
});

test("service exposure checks support vLLM runtime API keys and engine-specific warnings", () => {
  const checks = core.buildServiceExposureChecks({
    exposureMode: "lan",
    requireApiKey: true,
    exposeClaude: true,
    allowManagerRemote: true,
    rateLimitRpm: 120,
    maxConcurrentRequests: 4,
  }, {
    docker: { ok: true },
    container: { running: true },
    endpoint: { lanUrl: "http://192.168.1.2:8000", lanHost: "192.168.1.2" },
    runtime: { apiKeyRequired: true },
    clientsLedger: { clients: [] },
    remoteManagementAllowed: false,
  }, {
    allowRuntimeApiKey: true,
    warnDirectContainerWhen: "lan-bound-without-runtime-api-key",
    remoteRequiresClaudeExposure: true,
    remoteEnvVar: "VLLM_MANAGER_ALLOW_REMOTE=1",
    copy: {
      runtimeApiKeyOk: "运行中的 vLLM 容器已启用 Bearer Token。",
      remoteTitle: "Claude 桥远程访问",
    },
  });

  assert.equal(checks.find((item) => item.title === "API Key")?.status, "ok");
  assert.match(checks.find((item) => item.title === "API Key")?.detail || "", /vLLM 容器/);
  assert.equal(checks.some((item) => item.title === "直连容器端口"), false);
  assert.equal(checks.find((item) => item.title === "Claude 桥远程访问")?.status, "warn");
});

test("service exposure checks warn for llama direct LAN ports and summarize clients", () => {
  const nowMs = Date.parse("2026-06-15T00:00:00.000Z");
  const clientsLedger = {
    clients: [
      { id: "active", enabled: true, expiresAt: "2026-06-16T00:00:00.000Z" },
      { id: "expired", enabled: true, expiresAt: "2026-06-14T00:00:00.000Z" },
      { id: "disabled", enabled: false },
    ],
  };
  assert.deepEqual(core.buildServiceClientsSummary(clientsLedger, { nowMs }), { total: 3, active: 1 });

  const checks = core.buildServiceExposureChecks({
    exposureMode: "lan",
    requireApiKey: true,
    apiKeyHash: "hash",
    rateLimitRpm: 900,
    maxConcurrentRequests: 8,
  }, {
    docker: { ok: true },
    container: { running: true },
    endpoint: { lanUrl: "http://192.168.1.2:8080", lanHost: "192.168.1.2" },
    clientsLedger,
    remoteManagementAllowed: true,
  }, {
    warnDirectContainerWhen: "lan-bound",
    copy: {
      directContainerWarn: "llama.cpp 容器 LAN 端口不经过管理器网关鉴权。",
    },
  });

  assert.equal(checks.find((item) => item.title === "API Key")?.status, "ok");
  assert.equal(checks.find((item) => item.title === "直连容器端口")?.status, "warn");
  assert.equal(checks.find((item) => item.title === "网关限流")?.status, "warn");
});

test("service exposure payload snapshot builds shared manager and service addresses", () => {
  const payload = core.buildServiceExposurePayloadSnapshot({
    exposureMode: "lan",
    requireApiKey: true,
    apiKeyHash: "secret-hash",
    apiKeyPreview: "sk-test...1234",
    rateLimitRpm: 120,
    maxConcurrentRequests: 4,
  }, {
    docker: { ok: true, text: "Docker 27" },
    container: { running: true, status: "running" },
    endpoint: {
      boundHost: "0.0.0.0",
      localHost: "127.0.0.1",
      lanHost: "192.168.1.2",
      lanUrl: "http://192.168.1.2:8000",
      localUrl: "http://127.0.0.1:8000",
      port: 8000,
      publishedHosts: ["127.0.0.1", "192.168.1.2"],
      compat: {
        openai: { baseUrl: "http://127.0.0.1:8000/v1", lanBaseUrl: "http://192.168.1.2:8000/v1" },
      },
    },
    runtime: {
      apiKeyRequired: true,
      servedModels: [{ id: "local-model", max_model_len: 65536 }],
    },
    clientsLedger: { clients: [{ id: "client-1", enabled: true }] },
  }, {
    managerHost: "0.0.0.0",
    managerPort: 5177,
    lanAddress: "192.168.1.2",
    remoteManagementAllowed: true,
    defaultServicePort: 8000,
    claudeMessagesPath: "/claude/v1/messages",
    openCodeBasePath: "/opencode/v1",
    runtimeApiKeySupported: true,
    checkOptions: { allowRuntimeApiKey: true },
  });

  assert.equal(payload.settings.hasApiKey, true);
  assert.equal(payload.settings.apiKeyHash, "");
  assert.equal(payload.actual.manager.lanBaseUrl, "http://192.168.1.2:5177");
  assert.equal(payload.actual.service.openAiGatewayLanBaseUrl, "http://192.168.1.2:5177/serve/v1");
  assert.equal(payload.actual.service.claudeLocalBaseUrl, "http://127.0.0.1:5177/claude");
  assert.equal(payload.actual.service.claudeLanBaseUrl, "http://192.168.1.2:5177/claude");
  assert.equal(payload.actual.service.claudeLocalMessagesUrl, "http://127.0.0.1:5177/claude/v1/messages");
  assert.equal(payload.actual.service.claudeLanMessagesUrl, "http://192.168.1.2:5177/claude/v1/messages");
  assert.equal(payload.actual.service.openCodeBaseUrl, "http://127.0.0.1:5177/opencode/v1");
  assert.equal(payload.actual.service.maxModelLen, 65536);
  assert.equal(payload.actual.service.apiKeyRequired, true);
  assert.equal(payload.actual.service.clients.total, 1);
  assert.equal(payload.checks.find((item) => item.title === "API Key")?.status, "ok");
});

test("service exposure store migrates secrets and keeps engine defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "service-exposure-store-"));
  const file = path.join(dir, "settings.json");
  await fs.writeFile(file, JSON.stringify({
    exposureMode: "lan",
    apiKey: "legacy-secret",
    exposeOpenCode: undefined,
  }), "utf8");

  const vllmStore = core.createServiceExposureSettingsStore({
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    normalizeOptions: { allowExposeOpenCode: true, exposeOpenCodeDefault: true },
  });

  const loaded = await vllmStore.getServiceExposureSettings();
  assert.equal(loaded.apiKey, "");
  assert.equal(loaded.apiKeyHash, core.hashServiceApiKey("legacy-secret"));
  assert.equal(loaded.exposeOpenCode, true);
  assert.equal(vllmStore.redactServiceExposureSettings(loaded).hasApiKey, true);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).apiKey, "");

  const saved = await vllmStore.saveServiceExposureSettings({ exposureMode: "reverse-proxy" }, loaded);
  assert.equal(saved.apiKeyHash, loaded.apiKeyHash);
  assert.equal(saved.exposureMode, "reverse-proxy");

  const llamaFile = path.join(dir, "llama-settings.json");
  const llamaStore = core.createServiceExposureSettingsStore({
    file: llamaFile,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    normalizeOptions: { allowExposeOpenCode: false, exposeOpenCodeDefault: false },
  });
  const llamaSettings = await llamaStore.saveServiceExposureSettings({ exposureMode: "lan", exposeOpenCode: true });
  assert.equal(llamaSettings.exposeOpenCode, false);
});

test("service gateway middleware enforces auth, CORS, limits, and emits metadata logs", async () => {
  function makeResponse() {
    const events = new Map();
    const headers = new Map();
    const state = { statusCode: 200, json: null, ended: false };
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      status(code) {
        this.statusCode = code;
        state.statusCode = code;
        return this;
      },
      json(value) {
        this.headersSent = true;
        state.json = value;
        return value;
      },
      end() {
        this.writableEnded = true;
        state.ended = true;
      },
      setHeader(key, value) {
        headers.set(String(key).toLowerCase(), value);
      },
      getHeader(key) {
        return headers.get(String(key).toLowerCase());
      },
      setTimeout(_timeout, handler) {
        this.timeoutHandler = handler;
      },
      once(event, handler) {
        const handlers = events.get(event) || [];
        handlers.push(handler);
        events.set(event, handlers);
        return this;
      },
      trigger(event) {
        for (const handler of events.get(event) || []) handler();
      },
    };
    return { res, state, headers };
  }

  const logs = [];
  const rateBuckets = new Map();
  const concurrencyBuckets = new Map();
  const middleware = core.createServiceGatewayMiddleware({
    gatewayName: "test-manager",
    supportedKinds: ["openai", "claude"],
    getServiceExposureSettings: async () => ({
      enabled: true,
      exposureMode: "lan",
      requireApiKey: true,
      allowedOrigins: ["http://client.local"],
      exposeOpenAI: true,
      exposeClaude: true,
      rateLimitRpm: 3,
      maxConcurrentRequests: 2,
      requestTimeoutSeconds: 45,
      apiKey: "",
      apiKeyHash: "",
    }),
    getServiceClientsLedger: async () => ({ clients: [{ id: "client-1", enabled: true }] }),
    resolveServiceClientForApiKey: async (key) => (key === "sk-client" ? {
      id: "client-1",
      enabled: true,
      rateLimitRpm: 3,
      maxConcurrentRequests: 2,
      requestTimeoutSeconds: 45,
    } : null),
    rateBuckets,
    concurrencyBuckets,
    appendAccessLog: async (entry) => logs.push(entry),
  });

  let response = makeResponse();
  await middleware({
    method: "POST",
    originalUrl: "/serve/v1/chat/completions",
    headers: { origin: "http://client.local" },
    socket: { remoteAddress: "192.168.1.50" },
    body: { model: "requested", stream: true },
  }, response.res, () => {});
  assert.equal(response.state.statusCode, 401);
  assert.equal(response.state.json.error.code, "unauthorized");

  response = makeResponse();
  let nextCalled = 0;
  const req = {
    method: "POST",
    originalUrl: "/serve/v1/chat/completions",
    headers: { authorization: "Bearer sk-client", origin: "http://client.local" },
    socket: { remoteAddress: "192.168.1.50" },
    body: { model: "requested", stream: true },
  };
  await middleware(req, response.res, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
  assert.equal(req.serviceGateway.kind, "openai");
  assert.equal(req.serviceGateway.clientId, "client-1");
  assert.equal(response.headers.get("x-local-llm-gateway"), "test-manager");
  assert.equal(response.headers.get("access-control-allow-origin"), "http://client.local");
  req.serviceGatewayAccessUsage = { resolvedModel: "actual", inputTokens: 5, outputTokens: 8, toolUseCount: 1 };
  response.res.statusCode = 200;
  response.res.trigger("finish");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].resolvedModel, "actual");
  assert.equal(logs[0].totalTokens, 13);

  let liveSettings = {
    enabled: false,
    exposureMode: "lan",
    requireApiKey: false,
    exposeOpenAI: true,
    exposeClaude: true,
    rateLimitRpm: 120,
    maxConcurrentRequests: 4,
    requestTimeoutSeconds: 600,
  };
  const toggleMiddleware = core.createServiceGatewayMiddleware({
    gatewayName: "toggle-manager",
    supportedKinds: ["openai", "claude"],
    getServiceExposureSettings: async () => liveSettings,
    getServiceClientsLedger: async () => ({ clients: [] }),
    resolveServiceClientForApiKey: async () => null,
    rateBuckets: new Map(),
    concurrencyBuckets: new Map(),
    appendAccessLog: async () => {},
  });

  response = makeResponse();
  nextCalled = 0;
  await toggleMiddleware({
    method: "POST",
    originalUrl: "/serve/v1/chat/completions",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    body: {},
  }, response.res, () => { nextCalled += 1; });
  assert.equal(nextCalled, 0);
  assert.equal(response.state.statusCode, 404);
  assert.equal(response.state.json.error.code, "endpoint_disabled");

  liveSettings = { ...liveSettings, enabled: true, exposeClaude: false };
  response = makeResponse();
  await toggleMiddleware({
    method: "POST",
    originalUrl: "/claude/v1/messages",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    body: {},
  }, response.res, () => { nextCalled += 1; });
  assert.equal(response.state.statusCode, 404);
  assert.equal(response.state.json.error.code, "endpoint_disabled");
});

test("OpenAI gateway handlers proxy models and non-stream completions with usage metadata", async () => {
  const fetchCalls = [];
  const usageEvents = [];
  const handlers = core.createOpenAiGatewayHandlers({
    aliases: ["local-current"],
    owner: "test-manager",
    getRunningModelSummary: async () => ({
      container: { running: true },
      endpoint: { port: 8000 },
      servedModels: [{ id: "actual-model" }],
    }),
    getUpstreamHeaders: (_runtime, headers = {}) => ({ ...headers, authorization: "Bearer local-key" }),
    serviceClientAllowsModel: (_client, model) => model !== "blocked",
    recordUsage: async (clientId, event) => usageEvents.push({ clientId, event }),
    setAccessUsage: (req, usage) => { req.serviceGatewayAccessUsage = usage; },
    fetchFn: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      const body = url.endsWith("/v1/models")
        ? { data: [{ id: "actual-model", created: 42, max_model_len: 65536 }] }
        : { id: "chatcmpl-test", usage: { prompt_tokens: 7, completion_tokens: 11 } };
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : "") },
        text: async () => JSON.stringify(body),
      };
    },
  });

  function makeResponse() {
    const state = { statusCode: 200, json: [], sent: "", type: "" };
    const res = {
      writableEnded: false,
      headersSent: false,
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        this.headersSent = true;
        return value;
      },
      type(value) {
        state.type = value;
        return this;
      },
      send(value) {
        state.sent = value;
        this.headersSent = true;
        return value;
      },
      once() { return this; },
      off() { return this; },
    };
    return { res, state };
  }

  let response = makeResponse();
  await handlers.handleModels({}, response.res);
  assert.equal(response.state.json[0].object, "list");
  assert.equal(response.state.json[0].data[0].id, "local-current");
  assert.equal(response.state.json[0].data[0].owned_by, "test-manager");

  response = makeResponse();
  const req = {
    body: { model: "local-current", stream: false },
    serviceGateway: { clientId: "client-1", timeoutMs: 5000 },
  };
  await handlers.handleChatCompletions(req, response.res);
  assert.equal(response.state.statusCode, 200);
  assert.equal(response.state.type, "application/json");
  assert.equal(JSON.parse(fetchCalls[1].options.body).model, "actual-model");
  assert.equal(fetchCalls[1].options.headers.authorization, "Bearer local-key");
  assert.deepEqual(req.serviceGatewayAccessUsage, {
    resolvedModel: "actual-model",
    inputTokens: 7,
    outputTokens: 11,
  });
  assert.equal(usageEvents[0].clientId, "client-1");
  assert.equal(usageEvents[0].event.usage.prompt_tokens, 7);
});

test("file helpers resolve existing paths and keep queued JSON writes atomic", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-core-files-"));
  const tool = path.join(dir, "tool.exe");
  const json = path.join(dir, "nested", "ledger.json");
  const hashRoot = path.join(dir, "hashes");
  await fs.mkdir(path.join(hashRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(hashRoot, "a.txt"), "alpha");
  await fs.writeFile(path.join(hashRoot, "nested", "b.txt"), "beta");
  await fs.writeFile(tool, "");

  assert.equal(core.firstExisting(["docker", tool, "fallback"]), tool);
  assert.equal(core.firstExisting(["docker"]), "docker");
  assert.equal(core.looksLikePath("docker"), false);
  assert.equal(core.looksLikePath(tool), true);
  assert.equal(await core.sha256File(path.join(hashRoot, "a.txt")), "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8");
  assert.deepEqual((await core.hashFilesInDir(hashRoot)).map((item) => item.relative), ["a.txt", "nested/b.txt"]);

  await Promise.all(Array.from({ length: 8 }, (_item, index) => core.writeJsonFile(json, {
    index,
    nested: { ok: true },
  })));
  await core.flushFileWriteQueues();

  const parsed = JSON.parse(await fs.readFile(json, "utf8"));
  assert.equal(parsed.nested.ok, true);
  assert.equal(Number.isInteger(parsed.index), true);
  const leftovers = await fs.readdir(path.dirname(json));
  assert.equal(leftovers.some((name) => name.includes(".tmp-") || name.endsWith(".lock")), false);
});

test("manager lifecycle controls pid files, listen, health, and idempotent shutdown", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-lifecycle-"));
  const pidFile = path.join(dir, "manager.pid");
  const calls = [];
  let closed = 0;
  const fakeServer = {
    close(callback) {
      closed += 1;
      callback();
    },
  };
  const app = {
    listen(port, host, callback) {
      calls.push(["listen", host, port]);
      callback();
      return fakeServer;
    },
  };
  const lifecycle = core.createManagerLifecycle({
    app,
    host: "127.0.0.1",
    port: 5999,
    label: "Test Manager",
    pidFile,
    engine: "test-engine",
    managerId: "test-manager",
    logger: { log: (message) => calls.push(["log", message]), warn: (message) => calls.push(["warn", message]) },
    beforeStart: async () => calls.push(["beforeStart"]),
    afterPreparePid: async () => calls.push(["afterPreparePid"]),
    beforeListen: () => calls.push(["beforeListen"]),
    onShutdown: async ({ signal }) => calls.push(["shutdown", signal]),
  });

  const server = await lifecycle.startManager();
  assert.equal(server, fakeServer);
  assert.equal((await fs.readFile(pidFile, "utf8")).trim(), String(process.pid));
  assert.equal(lifecycle.getHttpServer(), fakeServer);
  assert.deepEqual(calls.filter((call) => call[0] !== "log"), [
    ["beforeStart"],
    ["afterPreparePid"],
    ["beforeListen"],
    ["listen", "127.0.0.1", 5999],
  ]);

  const health = await lifecycle.buildManagerHealth();
  assert.equal(health.engine, "test-engine");
  assert.equal(health.managerId, "test-manager");
  assert.equal(health.pidFileMatches, true);

  await lifecycle.shutdownManager("test");
  await lifecycle.shutdownManager("again");
  assert.equal(closed, 1);
  assert.equal(lifecycle.getHttpServer(), null);
  assert.equal(await core.readPidFilePid(pidFile), null);
  assert.equal(calls.filter((call) => call[0] === "shutdown").length, 1);

  const failingPidFile = path.join(dir, "failing.pid");
  let failingClosed = 0;
  const failingLifecycle = core.createManagerLifecycle({
    app: {
      listen(_port, _host, callback) {
        callback();
        return { close: (callback) => { failingClosed += 1; callback(); } };
      },
    },
    host: "127.0.0.1",
    port: 6000,
    label: "Failing Manager",
    pidFile: failingPidFile,
    logger: { log: () => {}, warn: () => {} },
    onShutdown: async () => {
      throw new Error("shutdown failed");
    },
  });
  await failingLifecycle.startManager();
  await assert.rejects(() => failingLifecycle.shutdownManager("fail"), /shutdown failed/);
  assert.equal(failingClosed, 1);
  assert.equal(await core.readPidFilePid(failingPidFile), null);
});

test("health probes build checks for directories and commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "health-probe-"));
  const calls = [];
  const probe = core.createHealthProbe({
    execFileAsync: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "missing") throw new Error("not found");
      return command === "warn"
        ? { stdout: "", stderr: "warning line\nsecond", error: true }
        : { stdout: "ok line\nsecond", stderr: "", error: false };
    },
  });

  assert.deepEqual(probe.healthCheck("id", "Label", "ok", 123), { id: "id", label: "Label", status: "ok", detail: "123", actions: [] });
  assert.equal((await probe.directoryHealth("dir", "Dir", path.join(dir, "created"))).status, "ok");
  assert.equal((await probe.commandHealth("cmd", "Command", "tool", ["--version"])).status, "ok");
  assert.equal((await probe.commandHealth("warn", "Warning", "warn")).status, "warn");
  assert.equal((await probe.commandHealth("missing", "Missing", "", ["--help"], "warn")).status, "warn");
  assert.equal(calls[0].options.timeout, 8000);
});

test("settings stores persist launch profiles, automation settings, and model notes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-core-settings-"));
  const automationStore = core.createAutomationSettingsStore({
    file: path.join(dir, "automation.json"),
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
  });
  const automation = await automationStore.saveAutomationSettings({
    idleUnloadEnabled: true,
    idleMinutes: 1,
    vramGuardEnabled: true,
    vramPercent: 130,
    vramAction: "unload",
  });
  assert.equal(automation.idleMinutes, 5);
  assert.equal(automation.vramPercent, 99);
  assert.equal(automation.vramAction, "unload");

  const profilesStore = core.createLaunchProfilesStore({
    file: path.join(dir, "profiles.json"),
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    defaultLaunchProfiles: () => [{ id: "builtin", name: "Builtin", source: "builtin", config: {} }],
    makeProfileId: (value) => String(value || "profile").toLowerCase().replace(/\s+/g, "-"),
    normalizeLaunchProfile: (value) => {
      if (!value?.name) return null;
      return {
        id: value.id,
        name: value.name,
        source: value.source === "builtin" ? "builtin" : "user",
        updatedAt: value.updatedAt || "now",
        config: value.config || {},
      };
    },
  });
  await profilesStore.saveLaunchProfile({ name: "Long Context", config: { maxModelLen: 65536 } });
  await profilesStore.saveLaunchProfile({ id: "long-context", name: "Long Context Updated", config: { maxModelLen: 131072 } });
  const profiles = await profilesStore.getLaunchProfiles();
  assert.equal(profiles.builtin.length, 1);
  assert.equal(profiles.profiles.length, 1);
  assert.equal(profiles.profiles[0].config.maxModelLen, 131072);
  assert.deepEqual(await profilesStore.deleteLaunchProfile("long-context"), { ok: true, removed: 1, id: "long-context" });

  const notesStore = core.createModelNotesStore({
    file: path.join(dir, "notes.json"),
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
  });
  const savedNote = await notesStore.saveModelNote({
    model: "owner/model",
    favorite: true,
    tags: Array.from({ length: 20 }, (_item, index) => `tag-${index}`),
    note: "x".repeat(700),
  });
  assert.equal(savedNote.note.favorite, true);
  assert.equal(savedNote.note.tags.length, 12);
  assert.ok(savedNote.note.note.length <= 500);
  const notes = await notesStore.getModelNotes();
  assert.equal(Object.keys(notes.notes).length, 1);
  assert.equal((await notesStore.deleteModelNote(savedNote.note.key)).removed, 1);

  const vllmCompressionStore = core.createClaudeCompressionSettingsStore({
    file: path.join(dir, "vllm-compression.json"),
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    normalizeOptions: {
      env: {
        AI_CLAUDE_CONTEXT_COMPRESSION: "off",
        AI_CLAUDE_CONTEXT_TRIGGER_PERCENT: "95",
      },
      useEnv: true,
      minMessagesMin: 8,
    },
  });
  const vllmCompression = await vllmCompressionStore.getClaudeCompressionSettings();
  assert.equal(vllmCompression.enabled, false);
  assert.equal(vllmCompression.triggerRatio, 0.95);
  const savedVllmCompression = await vllmCompressionStore.saveClaudeCompressionSettings({
    enabled: true,
    mode: "balanced",
    recentPercent: 35,
    minMessages: 2,
  });
  assert.equal(savedVllmCompression.mode, "balanced");
  assert.equal(savedVllmCompression.recentRatio, 0.35);
  assert.equal(savedVllmCompression.minMessages, 8);

  const llamaCompressionStore = core.createClaudeCompressionSettingsStore({
    file: path.join(dir, "llama-compression.json"),
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    normalizeOptions: {
      useEnv: false,
      forceMode: "cautious",
      triggerMin: 0.05,
      triggerMax: 0.98,
      recentMin: 0.05,
      recentMax: 0.98,
      summaryMin: 0.05,
      summaryMax: 0.98,
      minMessagesMin: 4,
      minMessagesMax: 40,
      includeUpdatedAt: true,
    },
  });
  const savedLlamaCompression = await llamaCompressionStore.saveClaudeCompressionSettings({
    enabled: false,
    mode: "aggressive",
    triggerRatio: 200,
    minMessages: 99,
  });
  assert.equal(savedLlamaCompression.enabled, false);
  assert.equal(savedLlamaCompression.mode, "cautious");
  assert.equal(savedLlamaCompression.triggerRatio, 0.98);
  assert.equal(savedLlamaCompression.minMessages, 40);
  assert.match(savedLlamaCompression.updatedAt, /^\d{4}-/);
});

test("docker helpers build and parse engine-specific publish args", () => {
  const vllm = core.createDockerPublishHelpers({ containerPort: 8000, getLanAddress: () => "192.168.50.10" });
  const llama = core.createDockerPublishHelpers({ containerPort: 8080, getLanAddress: () => "192.168.50.10" });

  assert.deepEqual(vllm.dockerPublishArgs(9000, "local"), ["127.0.0.1:9000:8000"]);
  assert.deepEqual(llama.dockerPublishArgs(9090, "local"), ["127.0.0.1:9090:8080"]);
  assert.deepEqual(vllm.dockerPublishArgs(9000, "lan", "192.168.50.20"), [
    "127.0.0.1:9000:8000",
    "192.168.50.20:9000:8000",
  ]);
  assert.deepEqual(llama.dockerPublishArgs(9090, "lan", "0.0.0.0"), [
    "127.0.0.1:9090:8080",
    "192.168.50.10:9090:8080",
  ]);
  assert.deepEqual(
    core.createDockerPublishHelpers({ containerPort: 8080, getLanAddress: () => "127.0.0.1" })
      .dockerPublishArgs(9090, "lan", "0.0.0.0"),
    ["0.0.0.0:9090:8080"],
  );

  const parsed = vllm.parseDockerPortPublish("127.0.0.1:9000->8000/tcp, 192.168.50.20:9000->8000/tcp");
  assert.equal(parsed.host, "192.168.50.20");
  assert.equal(parsed.localHost, "127.0.0.1");
  assert.equal(parsed.lanHost, "192.168.50.20");
  assert.equal(llama.parseDockerPortPublish("0.0.0.0:9090->8080/tcp").lanHost, "192.168.50.10");
});

test("docker helpers classify image tags and publish bind errors", () => {
  assert.equal(core.isPinnedImageReference("vllm/vllm-openai:v0.21.0"), true);
  assert.equal(core.isPinnedImageReference("vllm/vllm-openai:latest"), false);
  assert.equal(core.isPinnedImageReference("repo/image@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), true);
  assert.equal(core.isDockerPublishBindError({ stderr: "port is already allocated" }), true);
  assert.equal(core.isDockerPublishBindError({ stderr: "model config failed" }), false);
});

test("docker runtime wraps CLI checks, image status, and Desktop startup", async () => {
  const responses = [
    { stdout: "Docker version 27.0.0\n" },
    { stdout: "27.0.0\n" },
    { stdout: "sha256:abc\t2048\t[\"repo/image:tag\"]\t[\"repo/image@sha256:digest\"]\n" },
  ];
  const calls = [];
  const runtime = core.createDockerRuntime({
    dockerExe: "docker-test",
    execFileCommand: (file, args, options, callback) => {
      calls.push([file, args, options.rejectOnError]);
      const response = responses.shift();
      callback(response?.error || null, response?.stdout || "", response?.stderr || "");
    },
  });
  const version = await runtime.getDockerVersion();
  assert.equal(version.ok, true);
  assert.equal(version.text, "Docker version 27.0.0 · daemon 27.0.0");
  const image = await runtime.getImageStatus("repo/image:tag");
  assert.equal(image.ok, true);
  assert.equal(image.id, "sha256:abc");
  assert.equal(image.text, "repo/image:tag\t2.0 KB");
  assert.deepEqual(calls.map((call) => call[0]), ["docker-test", "docker-test", "docker-test"]);

  const startupResponses = [
    { error: new Error("daemon missing"), stderr: "open //./pipe/dockerDesktopLinuxEngine" },
    { stdout: "27.0.1\n" },
  ];
  const spawned = [];
  const startupRuntime = core.createDockerRuntime({
    dockerExe: "docker-test",
    dockerDesktopExe: "Docker Desktop.exe",
    fsExists: () => true,
    delay: async () => {},
    spawnCommand: (file, args, options) => {
      spawned.push([file, args, options.detached]);
      return { unref: () => spawned.push(["unref"]) };
    },
    execFileCommand: (_file, _args, _options, callback) => {
      const response = startupResponses.shift();
      callback(response?.error || null, response?.stdout || "", response?.stderr || "");
    },
  });
  const readiness = await startupRuntime.ensureDockerDaemonRunning(5000);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.alreadyRunning, false);
  assert.deepEqual(spawned[0], ["Docker Desktop.exe", [], true]);
  assert.equal(core.formatDockerDaemonError("open //./pipe/dockerDesktopLinuxEngine"), "Docker Desktop 引擎未就绪。请先用页面的一键 Docker 按钮启动 Docker Desktop，等状态变为可用后再启动模型。");
  assert.equal(core.normalizeDockerContainerName("/llama-local,other"), "llama-local");
  assert.equal(core.normalizeDockerTimestamp("0001-01-01T00:00:00Z"), null);
  assert.equal(core.timestampToSeconds("2026-06-15T00:00:00.000Z"), 1781481600);
});

test("GPU runtime parses nvidia-smi and normalizes selected device ids", async () => {
  const parsed = core.parseNvidiaSmiGpuCsv([
    "0, NVIDIA RTX PRO 6000 Blackwell, 97871, 12000, 80, 59",
    "1, NVIDIA GeForce RTX 5090, 32607, 4000, 20, 45",
  ].join("\n"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.totalMb, 130478);
  assert.equal(parsed.usedMb, 16000);
  assert.equal(parsed.util, 50);
  assert.equal(parsed.gpus[0].id, "0");

  const runtime = core.createGpuRuntime({
    execFileAsync: async () => ({ stdout: "0, GPU A, 100, 10, 10, 40\n1, GPU B, 50, 5, 30, 41\n" }),
  });
  const status = await runtime.getGpuStatus();
  assert.equal(status.ok, true);
  assert.equal(status.name, "2 GPUs");

  const selected = await runtime.normalizeLaunchGpuSelection(["9", "1"]);
  assert.deepEqual(selected.gpuDeviceIds, ["1"]);
  assert.equal(selected.selectedCount, 1);
  assert.match(selected.warnings[0], /已忽略不存在的 GPU/);

  const fallback = await runtime.normalizeLaunchGpuSelection(["9"]);
  assert.deepEqual(fallback.gpuDeviceIds, ["0"]);
  assert.equal(fallback.warnings.length, 2);

  const missing = core.parseNvidiaSmiGpuCsv("");
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.gpus, []);
});

test("service policy normalizes exposure settings and migrates secrets", () => {
  const vllm = core.normalizeServiceExposureSettings({
    enabled: true,
    exposureMode: "lan",
    apiKey: "sk-local-secret",
    allowedOrigins: "192.168.1.2\n192.168.1.2, laptop",
    publicBaseUrl: "https://llm.example.com/",
    rateLimitRpm: 99999,
  }, {}, { allowExposeOpenCode: true, exposeOpenCodeDefault: true });
  assert.equal(vllm.exposureMode, "lan");
  assert.equal(vllm.requireApiKey, true);
  assert.equal(vllm.apiKey, "");
  assert.equal(vllm.apiKeyHash, core.hashServiceApiKey("sk-local-secret"));
  assert.equal(vllm.apiKeyPreview, "sk-loca...cret");
  assert.equal(vllm.publicBaseUrl, "https://llm.example.com");
  assert.deepEqual(vllm.allowedOrigins, ["192.168.1.2", "laptop"]);
  assert.equal(vllm.rateLimitRpm, 5000);
  assert.equal(vllm.exposeOpenCode, true);

  const llama = core.normalizeServiceExposureSettings({ exposeOpenCode: true }, {}, { allowExposeOpenCode: false });
  assert.equal(llama.exposeOpenCode, false);
  assert.equal(core.redactServiceExposureSettings(vllm).apiKeyHash, "");
  assert.equal(core.redactServiceExposureSettings(vllm).hasApiKey, true);
});

test("service policy normalizes clients and enforces rate/concurrency buckets", () => {
  const ledger = core.normalizeServiceClientsLedger({
    clients: [{
      id: "client-1",
      name: "Client One",
      allowedModels: "model-a, model-a\nmodel-b",
      rateLimitRpm: 2,
      maxConcurrentRequests: 1,
      requestTimeoutSeconds: 99999,
      expiresAt: "2026-06-14T00:00:00Z",
      usage: { requests: { total: 3 }, tokens: { prompt: 5, generation: 7 } },
    }],
  });
  assert.equal(ledger.clients.length, 1);
  assert.deepEqual(ledger.clients[0].allowedModels, ["model-a", "model-b"]);
  assert.equal(ledger.clients[0].requestTimeoutSeconds, 7200);
  assert.equal(ledger.clients[0].usage.tokens.total, 12);
  assert.equal(core.redactServiceClientsLedger(ledger).clients[0].keyHash, undefined);

  const buckets = new Map();
  assert.deepEqual(core.enterServiceRateLimit({ rateLimitRpm: 2 }, "client", buckets, 1000), { ok: true, remaining: 1 });
  assert.deepEqual(core.enterServiceRateLimit({ rateLimitRpm: 2 }, "client", buckets, 1500), { ok: true, remaining: 0 });
  assert.equal(core.enterServiceRateLimit({ rateLimitRpm: 2 }, "client", buckets, 2000).ok, false);

  const concurrent = new Map();
  const first = core.enterServiceConcurrency({ maxConcurrentRequests: 1 }, "client", concurrent);
  assert.equal(first.ok, true);
  assert.equal(core.enterServiceConcurrency({ maxConcurrentRequests: 1 }, "client", concurrent).ok, false);
  first.release();
  assert.equal(core.enterServiceConcurrency({ maxConcurrentRequests: 1 }, "client", concurrent).ok, true);
});

test("service policy manages service client records and model permissions", () => {
  const randomBytes = () => Buffer.alloc(24, 1);
  let result = core.createServiceClientRecord({
    clients: [{ id: "laptop", name: "Existing", keyHash: "old" }],
  }, {
    name: "Laptop",
    allowedModels: "served-root",
  }, {
    engine: "vllm",
    randomBytes,
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(result.apiKey.startsWith("sk-vllm-"), true);
  assert.equal(result.client.id, "laptop-2");
  assert.equal(result.client.keyHash, core.hashServiceApiKey(result.apiKey));
  assert.deepEqual(result.client.allowedModels, ["served-root"]);
  assert.equal(core.resolveServiceClientForApiKey(result.ledger, result.apiKey, { nowMs: Date.parse("2026-06-15T00:00:01Z") }).id, "laptop-2");
  assert.equal(core.serviceClientAllowsModel(result.client, "served-model", { roots: ["served-root"] }), true);
  assert.equal(core.serviceClientAllowsModel(result.client, "blocked-model", { roots: ["blocked-root"] }), false);

  const originalHash = result.client.keyHash;
  let update = core.updateServiceClientRecord(result.ledger, "laptop-2", {
    enabled: false,
    keyHash: "attempted-overwrite",
    allowedModels: "*",
  }, { now: "2026-06-15T00:01:00.000Z" });
  assert.equal(update.client.enabled, false);
  assert.equal(update.client.keyHash, originalHash);
  assert.equal(core.resolveServiceClientForApiKey(update.ledger, result.apiKey), null);
  assert.equal(core.serviceClientAllowsModel(update.client, "anything"), true);

  const rotate = core.rotateServiceClientKeyRecord(update.ledger, "laptop-2", {
    engine: "llama",
    randomBytes: () => Buffer.alloc(24, 2),
    now: "2026-06-15T00:02:00.000Z",
  });
  assert.equal(rotate.apiKey.startsWith("sk-llama-"), true);
  assert.notEqual(rotate.client.keyHash, originalHash);

  const deleted = core.deleteServiceClientRecord(rotate.ledger, "laptop-2");
  assert.equal(deleted.removed, 1);
  assert.equal(deleted.ledger.clients.some((client) => client.id === "laptop-2"), false);
});

test("service clients store persists JSON and syncs usage store hooks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "service-clients-store-"));
  const file = path.join(dir, "clients.json");
  const usageCalls = [];
  const store = core.createServiceClientsStore({
    file,
    managerId: "vllm-manager",
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    usageStore: {
      persistClients: (ledger) => usageCalls.push(["clients", ledger.clients.length]),
      persistUsageEvent: (event) => usageCalls.push(["usage", event.clientId, event.promptTokens]),
      deleteClient: (id) => usageCalls.push(["delete", id]),
    },
  });

  const created = await store.createServiceClient({ name: "Client One", rateLimitRpm: 7 });
  assert.equal(created.ok, true);
  assert.match(created.apiKey, /^sk-vllm-/);
  assert.equal(Object.prototype.hasOwnProperty.call(created.client, "keyHash"), false);
  assert.equal((await store.getServiceClientsLedger()).clients.length, 1);

  const updated = await store.updateServiceClient(created.client.id, { notes: "updated" });
  assert.equal(updated.client.notes, "updated");
  const rotated = await store.rotateServiceClientKey(created.client.id);
  assert.match(rotated.apiKey, /^sk-vllm-/);
  assert.notEqual(rotated.apiKey, created.apiKey);
  assert.equal((await store.resolveServiceClientForApiKey(rotated.apiKey)).id, created.client.id);

  await store.recordServiceClientGatewayUsage(created.client.id, {
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    status: 200,
  });
  assert.equal((await store.getServiceClientsLedger()).clients[0].usage.tokens.prompt, 3);

  const deleted = await store.deleteServiceClient(created.client.id);
  assert.equal(deleted.removed, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(usageCalls.map((call) => call[0]), ["clients", "clients", "clients", "clients", "usage", "clients", "delete"]);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).clients.length, 0);
});

test("service policy applies client gateway usage without prompt content", () => {
  let result = core.applyServiceClientUsage({
    id: "client-1",
    name: "Laptop",
    keyHash: "hash",
    usage: { requests: { total: 1, success: 1 }, tokens: { prompt: 10, generation: 4 } },
    updatedAt: "2026-06-14T00:00:00.000Z",
  }, {
    ok: true,
    status: 200,
    model: "model-a",
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  }, { now: "2026-06-15T00:00:00.000Z" });

  assert.equal(result.client.usage.requests.total, 2);
  assert.equal(result.client.usage.requests.success, 2);
  assert.equal(result.client.usage.tokens.prompt, 30);
  assert.equal(result.client.usage.tokens.generation, 12);
  assert.equal(result.client.usage.tokens.total, 42);
  assert.equal(result.client.lastUsedAt, "2026-06-15T00:00:00.000Z");
  assert.equal(result.client.updatedAt, "2026-06-14T00:00:00.000Z");
  assert.deepEqual(result.event, {
    clientId: "client-1",
    model: "model-a",
    status: 200,
    ok: true,
    promptTokens: 20,
    generationTokens: 8,
    totalTokens: 28,
  });

  result = core.applyServiceClientUsage(result.client, {
    ok: false,
    status: 403,
    model: "blocked",
    promptTokens: 3,
  }, { now: "2026-06-15T00:01:00.000Z" });

  assert.equal(result.client.usage.requests.total, 3);
  assert.equal(result.client.usage.requests.error, 1);
  assert.equal(result.client.usage.lastStatus, 403);
  assert.equal(result.event.totalTokens, 3);
});

test("service usage store persists client rows and usage events without prompt content", () => {
  const statements = [];
  const db = {
    schema: "",
    exec(sql) {
      this.schema += sql;
    },
    prepare(sql) {
      const statement = { sql, runs: [] };
      statements.push(statement);
      return {
        run: (...args) => {
          statement.runs.push(args);
        },
      };
    },
  };

  core.ensureServiceUsageSchema(db);
  core.persistServiceClientsToDb(db, {
    clients: [{
      id: "client-1",
      name: "Client 1",
      enabled: true,
      keyPreview: "sk-test...1234",
      allowedModels: ["local"],
      rateLimitRpm: 60,
      maxConcurrentRequests: 2,
      requestTimeoutSeconds: 120,
      expiresAt: "",
      notes: "note",
    }],
  }, { now: "2026-06-15T00:00:00.000Z" });
  core.persistServiceUsageEventToDb(db, {
    clientId: "client-1",
    model: "local",
    status: 200,
    ok: true,
    promptTokens: 5,
    generationTokens: 7,
    totalTokens: 12,
  }, {
    eventId: "evt-1",
    now: "2026-06-15T00:01:00.000Z",
    managerId: "vllm-manager",
  });
  core.deleteServiceClientFromDb(db, "client-1");

  assert.match(db.schema, /CREATE TABLE IF NOT EXISTS service_clients/);
  assert.equal(statements.length, 3);
  assert.deepEqual(statements[0].runs[0].slice(0, 4), ["client-1", "Client 1", 1, "sk-test...1234"]);
  assert.deepEqual(statements[1].runs[0], ["evt-1", "2026-06-15T00:01:00.000Z", "vllm-manager", "client-1", "local", 200, 1, 5, 7, 12]);
  assert.deepEqual(statements[2].runs[0], ["client-1"]);
});

test("service policy route registrar wires exposure and client routes", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
    patch(pathname, handler) { routes.set(`PATCH ${pathname}`, handler); },
    delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); },
  };
  const calls = [];
  core.registerServicePolicyRoutes(app, {
    getServiceExposureSettings: async () => ({ enabled: true }),
    saveServiceExposureSettings: async (input, previous) => {
      calls.push(["saveExposure", input.enabled, previous.enabled]);
      return { enabled: input.enabled };
    },
    buildServiceExposurePayload: async (settings) => ({ payload: settings.enabled }),
    getServiceClientsLedger: async () => ({ clients: [{ id: "client-1" }] }),
    redactServiceClientsLedger: (ledger) => ({ count: ledger.clients.length }),
    createServiceClient: async (input) => ({ created: input.name }),
    updateServiceClient: async (id, input) => ({ updated: id, name: input.name }),
    rotateServiceClientKey: async (id) => ({ rotated: id }),
    deleteServiceClient: async (id) => ({ deleted: id }),
  });

  assert.equal(routes.size, 7);
  const json = [];
  const res = { json(value) { json.push(value); } };
  await routes.get("GET /api/service-exposure")({}, res);
  await routes.get("POST /api/service-exposure")({ body: { enabled: false } }, res);
  await routes.get("GET /api/service-clients")({}, res);
  await routes.get("POST /api/service-clients")({ body: { name: "Laptop" } }, res);
  await routes.get("PATCH /api/service-clients/:id")({ params: { id: "client-1" }, body: { name: "New" } }, res);
  await routes.get("POST /api/service-clients/:id/rotate")({ params: { id: "client-1" } }, res);
  await routes.get("DELETE /api/service-clients/:id")({ params: { id: "client-1" } }, res);

  assert.deepEqual(calls, [["saveExposure", false, true]]);
  assert.deepEqual(json, [
    { payload: true },
    { payload: false },
    { count: 1 },
    { created: "Laptop" },
    { updated: "client-1", name: "New" },
    { rotated: "client-1" },
    { deleted: "client-1" },
  ]);
});

test("job route registrar handles download and engine-specific cancel actions", async () => {
  function makeApp() {
    const routes = new Map();
    return {
      routes,
      app: {
        get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
        post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
      },
    };
  }
  function makeResponse() {
    const state = { statusCode: 200, json: [] };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
    };
    return { res, state };
  }

  const downloadJob = { id: "download-1", type: "download", status: "running" };
  const serveJob = { id: "serve-1", type: "serve", status: "running" };
  const jobs = new Map([
    [downloadJob.id, downloadJob],
    [serveJob.id, serveJob],
  ]);
  const { app, routes } = makeApp();
  const calls = [];
  core.registerJobRoutes(app, {
    jobs,
    beforeReadJobs: () => calls.push("read"),
    cancelDownloadJob: async (job) => {
      job.status = "cancelled";
      calls.push(`cancel:${job.id}`);
    },
    pauseDownloadJob: (job) => {
      job.status = "paused";
      calls.push(`pause:${job.id}`);
    },
    resumeDownloadJob: (job) => {
      job.status = "running";
      calls.push(`resume:${job.id}`);
      return job;
    },
  });

  assert.equal(routes.size, 5);
  let response = makeResponse();
  await routes.get("GET /api/jobs")({}, response.res);
  assert.deepEqual(response.state.json[0].map((job) => job.id), ["serve-1", "download-1"]);

  response = makeResponse();
  await routes.get("GET /api/jobs/:id")({ params: { id: "missing" } }, response.res);
  assert.equal(response.state.statusCode, 404);
  assert.equal(response.state.json[0].error, "Job not found");

  response = makeResponse();
  await routes.get("POST /api/jobs/:id/cancel")({ params: { id: "download-1" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, id: "download-1", status: "cancelled" });

  response = makeResponse();
  await routes.get("POST /api/jobs/:id/pause")({ params: { id: "download-1" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, id: "download-1", status: "paused" });

  response = makeResponse();
  await routes.get("POST /api/jobs/:id/resume")({ params: { id: "download-1" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, id: "download-1", status: "running" });

  response = makeResponse();
  await routes.get("POST /api/jobs/:id/cancel")({ params: { id: "serve-1" } }, response.res);
  assert.equal(response.state.statusCode, 400);
  assert.match(response.state.json[0].error, /下载任务/);
  assert.deepEqual(calls, ["read", "read", "cancel:download-1", "pause:download-1", "resume:download-1"]);

  const custom = makeApp();
  core.registerJobRoutes(custom.app, {
    jobs,
    cancelDownloadJob: async () => {},
    pauseDownloadJob: () => {},
    resumeDownloadJob: (job) => job,
    cancelNonDownloadJob: async (_req, res, job) => {
      job.status = "cancelled";
      return res.json({ ok: true, id: job.id, status: job.status });
    },
  });
  response = makeResponse();
  await custom.routes.get("POST /api/jobs/:id/cancel")({ params: { id: "serve-1" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, id: "serve-1", status: "cancelled" });
});

test("audit route registrar keeps auth gates and manager metadata centralized", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
  };
  function makeResponse() {
    const state = { statusCode: 200, type: "", json: [] };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      type(value) {
        state.type = value;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
    };
    return { res, state };
  }

  let authorized = false;
  let destroyedToken = "";
  let exportMeta = null;
  core.registerAuditRoutes(app, {
    auditRoot: "D:/AI/audit-logs",
    auditPasswordFile: "D:/AI/audit-logs/audit-admin-password.txt",
    openWebuiContainer: "open-webui",
    managerName: "vllm-manager",
    getAuditPassword: async () => "secret",
    getContainerStatus: async (name) => ({ name, running: true }),
    verifyAuditPassword: async (password) => password === "secret",
    createAuditSession: () => ({ token: "session-token", expiresAt: 123 }),
    getAuditAuth: () => ({ token: "session-token" }),
    destroyAuditSession: (token) => { destroyedToken = token; },
    requireAuditAuth: () => (authorized ? { ok: true } : { ok: false, status: 401, message: "auth required" }),
    listAuditExports: async () => [{ auditId: "audit-1" }],
    getAuditMarkdownPath: async (auditId) => `D:/AI/audit-logs/${auditId}/openwebui-chats-full.md`,
    streamMarkdownFile: (file, res) => {
      res.type("text/markdown; charset=utf-8");
      return res.json({ streamed: file });
    },
    exportOpenWebuiAudit: async (reason, meta) => {
      exportMeta = { reason, meta };
      return { ok: true, auditId: "audit-2" };
    },
  });

  assert.equal(routes.size, 6);
  let response = makeResponse();
  await routes.get("GET /api/audit/status")({}, response.res);
  assert.equal(response.state.json[0].container.running, true);
  assert.equal(response.state.json[0].requiresPassword, true);

  response = makeResponse();
  await routes.get("POST /api/audit/login")({ body: { password: "bad" } }, response.res);
  assert.equal(response.state.statusCode, 401);
  assert.match(response.state.json[0].error, /审计密码/);

  response = makeResponse();
  await routes.get("POST /api/audit/login")({ body: { password: "secret" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, token: "session-token", expiresAt: 123 });

  response = makeResponse();
  await routes.get("POST /api/audit/logout")({}, response.res);
  assert.equal(destroyedToken, "session-token");

  response = makeResponse();
  await routes.get("GET /api/audit/exports")({}, response.res);
  assert.equal(response.state.statusCode, 401);
  authorized = true;

  response = makeResponse();
  await routes.get("GET /api/audit/exports")({}, response.res);
  assert.deepEqual(response.state.json[0].exports, [{ auditId: "audit-1" }]);

  response = makeResponse();
  await routes.get("GET /api/audit/exports/:auditId/markdown")({ params: { auditId: "audit-1" } }, response.res);
  assert.equal(response.state.type, "text/markdown; charset=utf-8");
  assert.match(response.state.json[0].streamed, /audit-1/);

  response = makeResponse();
  await routes.get("POST /api/audit/export")({ body: { note: "manual note" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, auditId: "audit-2" });
  assert.deepEqual(exportMeta, {
    reason: "manual",
    meta: { manager: "vllm-manager", requestedBy: "local-admin", note: "manual note" },
  });
});

test("audit store handles passwords, sessions, exports, and docker audit flow", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-store-"));
  const auditRoot = path.join(dir, "audit");
  const passwordFile = path.join(auditRoot, "audit-admin-password.txt");
  const legacyFile = path.join(dir, "legacy-password.txt");
  await fs.writeFile(legacyFile, " legacy-secret \n", "utf8");
  const dockerCalls = [];
  const store = core.createAuditStore({
    auditRoot,
    auditPasswordFile: passwordFile,
    legacyPasswordFiles: [legacyFile],
    openWebuiContainer: "open-webui",
    serviceContainer: "vllm-local",
    managerName: "test-manager",
    randomBytes: (size) => Buffer.alloc(size, 1),
    getContainerStatus: async () => ({ exists: true, running: true }),
    docker: async (args) => {
      dockerCalls.push(args);
      if (args[0] === "exec" && args[2] === "python") {
        return { stdout: "{\"chat_count\":2,\"message_count\":3,\"files\":[\"openwebui-chats-full.md\"]}\n", stderr: "" };
      }
      if (args[0] === "cp" && String(args[1]).includes(":/tmp/openwebui_audit_")) {
        await fs.writeFile(path.join(args[2], "openwebui-chats-full.md"), "# audit\n", "utf8");
      }
      return { stdout: "", stderr: "" };
    },
  });

  const generated = await store.getAuditPassword();
  assert.equal(generated.length > 20, true);
  assert.equal(await store.verifyAuditPassword(generated), true);
  assert.equal(await store.verifyAuditPassword("legacy-secret"), true);
  const session = store.createAuditSession();
  assert.equal(store.requireAuditAuth({ get: () => `Bearer ${session.token}` }).ok, true);
  store.destroyAuditSession(session.token);
  assert.equal(store.requireAuditAuth({ get: () => `Bearer ${session.token}` }).ok, false);

  const exported = await store.exportOpenWebuiAudit("manual", { manager: "override-manager" });
  assert.equal(exported.ok, true);
  assert.equal(exported.chatCount, 2);
  assert.equal(dockerCalls.some((args) => args[0] === "exec" && args[2] === "python"), true);
  const manifest = JSON.parse(await fs.readFile(path.join(exported.auditDir, "manifest.json"), "utf8"));
  assert.equal(manifest.manager, "override-manager");
  assert.equal(manifest.serviceContainer, "vllm-local");

  const exports = await store.listAuditExports();
  assert.equal(exports[0].auditId, exported.auditId);
  assert.equal(exports[0].messageCount, 3);
  assert.equal(await store.getAuditMarkdownPath(exported.auditId), path.join(exported.auditDir, "openwebui-chats-full.md"));
  await assert.rejects(() => store.getAuditMarkdownPath("../escape"), /Invalid audit id/);
});

test("Open WebUI audit exporter script is exposed from core", () => {
  assert.ok(core.OPENWEBUI_AUDIT_EXPORTER.includes("openwebui-chats-full.md"));
  assert.ok(core.OPENWEBUI_AUDIT_EXPORTER.includes("openwebui-db-hashes.json"));
});

test("tools route registrar wires health, profile, benchmark, and note actions", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
    delete(pathname, handler) { routes.set(`DELETE ${pathname}`, handler); },
  };
  function makeResponse() {
    const state = { statusCode: 200, json: [] };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
    };
    return { res, state };
  }

  const calls = [];
  core.registerToolsRoutes(app, {
    collectHealthReport: async () => ({ score: 98 }),
    getLaunchProfiles: async () => [{ id: "long-context" }],
    saveLaunchProfile: async (input) => ({ saved: input.name }),
    deleteLaunchProfile: async (id) => ({ deleted: id }),
    checkModelCompatibility: async (input) => ({ runnable: Boolean(input.model) }),
    summarizeRuntimeLogs: async (input) => ({ tail: input.tail }),
    getAutomationSettings: async () => ({ idleUnloadMinutes: 60 }),
    saveAutomationSettings: async (input) => ({ saved: input.enabled }),
    createJob: (type, title, meta) => ({ id: "job-1", type, title, meta, status: "running" }),
    normalizeBenchmarkRequest: (input) => ({ prompt: input.prompt || "hi" }),
    runBenchmarkJob: async (job, meta) => calls.push(["benchmark", job.title, meta.prompt]),
    failJob: (job, error) => calls.push(["failed", job.id, error.message]),
    benchmarkTitle: "Benchmark local llama.cpp model",
    verifyDownloadedModel: async (input) => ({ ok: true, model: input.model }),
    buildConnectionGuide: async () => ({ baseUrl: "http://127.0.0.1:5177" }),
    buildClaudeCompressionInsights: async () => ({ threshold: 90 }),
    getModelNotes: async () => ({ notes: {} }),
    saveModelNote: async () => {
      const error = new Error("duplicate note");
      error.status = 409;
      throw error;
    },
    deleteModelNote: async (id) => ({ deleted: id }),
  });

  assert.equal(routes.size, 15);
  let response = makeResponse();
  await routes.get("GET /api/tools/health")({}, response.res);
  assert.deepEqual(response.state.json[0], { score: 98 });

  response = makeResponse();
  await routes.get("GET /api/tools/log-summary")({ query: { tail: "123" } }, response.res);
  assert.deepEqual(response.state.json[0], { tail: 123 });

  response = makeResponse();
  await routes.get("POST /api/tools/benchmark")({ body: { prompt: "speed" } }, response.res);
  assert.equal(response.state.json[0].job.title, "Benchmark local llama.cpp model");
  assert.deepEqual(calls, [["benchmark", "Benchmark local llama.cpp model", "speed"]]);

  response = makeResponse();
  await routes.get("POST /api/download/verify")({ body: { model: "repo/model" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, model: "repo/model" });

  response = makeResponse();
  await routes.get("POST /api/tools/model-notes")({ body: { id: "note-1" } }, response.res);
  assert.equal(response.state.statusCode, 409);
  assert.equal(response.state.json[0].error, "duplicate note");

  response = makeResponse();
  await routes.get("DELETE /api/tools/model-notes/:id")({ params: { id: "note-1" } }, response.res);
  assert.deepEqual(response.state.json[0], { deleted: "note-1" });
});

test("benchmark runner normalizes requests and records samples", async () => {
  const calls = [];
  const job = { logs: [], meta: {} };
  const runner = core.createBenchmarkRunner({
    defaultPort: 8080,
    defaultPrompt: "default prompt",
    runtimeLabel: "test runtime",
    requestDetail: "testing",
    getRunningModelSummary: async () => ({
      container: { running: true },
      endpoint: { port: 9000 },
      models: [{ id: "model-a" }],
      token: "secret",
    }),
    getHeaders: (runtime) => ({ authorization: `Bearer ${runtime.token}` }),
    upstreamErrorMessage: (data, text) => data.error?.message || text,
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return {
        ok: true,
        text: async () => JSON.stringify({
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          choices: [{ message: { content: "hello world" } }],
        }),
      };
    },
    appendLog: (target, line) => target.logs.push(line),
    setJobProgress: (target, progress) => { target.progress = progress; },
    finishJob: (target, meta) => { target.status = "success"; target.meta = meta; },
  });

  assert.deepEqual(runner.normalizeBenchmarkRequest({ requests: 20, maxTokens: 1 }), {
    port: 8080,
    model: "",
    requests: 5,
    maxTokens: 16,
    prompt: "default prompt",
  });
  const result = await runner.runBenchmarkJob(job, { requests: 2, maxTokens: 32 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(calls[0].request.headers.authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0].request.body).model, "model-a");
  assert.equal(result.samples.length, 2);
  assert.equal(job.status, "success");
  assert.equal(job.meta.benchmark.model, "model-a");
  assert.match(job.logs[0], /Run 1:/);
});

test("model route registrar wires shared and optional model download endpoints", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
  };
  function makeResponse() {
    const state = { statusCode: 200, json: [] };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
    };
    return { res, state };
  }

  let startDownloadImpl = async (body) => ({ job: { id: "job-1", model: body.model } });

  core.registerModelRoutes(app, {
    listModels: async () => ({ local: ["local"], cached: ["cached"] }),
    deleteLocalModel: async (body) => ({ deleted: body.name }),
    searchRemoteModels: async (query) => ({ source: query.source || "huggingface", models: [] }),
    startDownload: async (body) => startDownloadImpl(body),
    estimateDownload: async (query) => ({ model: query.model, bytes: 123 }),
    getModelConfig: async (query) => ({ model: query.model, hiddenSize: 4096 }),
    getModelReadme: async (query) => ({ model: query.model, readme: "# Model" }),
    checkPort: async (query) => ({ port: Number(query.port), available: true }),
    getRecentLaunches: () => ({ launches: [{ model: "m" }] }),
    getDownloadSettings: () => ({ queueMode: true }),
    saveDownloadSettings: async (body) => ({ queueMode: Boolean(body.queueMode) }),
    resolveModelLink: async (body) => ({ model: body.url, outputName: "model" }),
  });

  assert.equal(routes.size, 12);
  let response = makeResponse();
  await routes.get("GET /api/models")({}, response.res);
  assert.deepEqual(response.state.json[0], { local: ["local"], cached: ["cached"] });

  response = makeResponse();
  await routes.get("GET /api/remote-models")({ query: { source: "modelscope" } }, response.res);
  assert.deepEqual(response.state.json[0], { source: "modelscope", models: [] });

  response = makeResponse();
  await routes.get("POST /api/download")({ body: { model: "owner/model" } }, response.res);
  assert.deepEqual(response.state.json[0], { job: { id: "job-1", model: "owner/model" } });

  startDownloadImpl = async () => {
    const error = new Error("bad source");
    error.status = 400;
    throw error;
  };
  response = makeResponse();
  await routes.get("POST /api/download")({ body: { model: "owner/model" } }, response.res);
  assert.equal(response.state.statusCode, 400);
  assert.deepEqual(response.state.json[0], { error: "bad source" });

  response = makeResponse();
  await routes.get("GET /api/download/estimate")({ query: { model: "owner/model" } }, response.res);
  assert.deepEqual(response.state.json[0], { model: "owner/model", bytes: 123 });

  response = makeResponse();
  await routes.get("POST /api/download/settings")({ body: { queueMode: false } }, response.res);
  assert.deepEqual(response.state.json[0], { queueMode: false });

  response = makeResponse();
  await routes.get("POST /api/resolve-model-link")({ body: { url: "https://huggingface.co/owner/model" } }, response.res);
  assert.deepEqual(response.state.json[0], { model: "https://huggingface.co/owner/model", outputName: "model" });
});

test("runtime route registrar centralizes docker, unload, logs, and test actions", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
  };
  function makeResponse() {
    const state = { statusCode: 200, json: [], sent: "", type: "" };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
      type(value) {
        state.type = value;
        return this;
      },
      send(value) {
        state.sent = value;
        return value;
      },
    };
    return { res, state };
  }

  core.registerRuntimeRoutes(app, {
    startRuntime: async ({ body }) => ({ job: { id: body.model } }),
    startDockerDesktop: async ({ query }) => ({ ok: true, dryRun: query.dryRun === "1" }),
    stopRuntime: async () => ({ ok: true, stopped: true }),
    unloadRunningModel: async ({ body }) => ({ ok: true, modelId: body.modelId }),
    readRuntimeLogs: async ({ query }) => `tail=${query.tail}`,
    testRuntimeCompletion: async ({ body }) => ({
      status: 202,
      type: "application/json",
      body: JSON.stringify({ model: body.model }),
    }),
  });

  assert.equal(routes.size, 6);
  let response = makeResponse();
  await routes.get("POST /api/start")({ body: { model: "serve-model" } }, response.res);
  assert.deepEqual(response.state.json[0], { job: { id: "serve-model" } });

  response = makeResponse();
  await routes.get("POST /api/docker/start")({ query: { dryRun: "1" }, body: {} }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, dryRun: true });

  response = makeResponse();
  await routes.get("POST /api/running-models/unload")({ body: { modelId: "local-model" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, modelId: "local-model" });

  response = makeResponse();
  await routes.get("GET /api/logs")({ query: { tail: "42" } }, response.res);
  assert.equal(response.state.type, "text/plain");
  assert.equal(response.state.sent, "tail=42");

  response = makeResponse();
  await routes.get("POST /api/test")({ body: { model: "current" } }, response.res);
  assert.equal(response.state.statusCode, 202);
  assert.equal(response.state.type, "application/json");
  assert.deepEqual(JSON.parse(response.state.sent), { model: "current" });

  const errorRoutes = new Map();
  core.registerRuntimeRoutes({
    post(pathname, handler) { errorRoutes.set(`POST ${pathname}`, handler); },
  }, {
    startDockerDesktop: async () => {
      const error = new Error("docker missing");
      error.status = 404;
      throw error;
    },
  });
  response = makeResponse();
  await errorRoutes.get("POST /api/docker/start")({ query: {}, body: {} }, response.res);
  assert.equal(response.state.statusCode, 404);
  assert.deepEqual(response.state.json[0], { error: "docker missing" });
});

test("integration route registrar wires Claude setup and GPU planning", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
  };
  function makeResponse() {
    const state = { statusCode: 200, json: [] };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
    };
    return { res, state };
  }

  core.registerIntegrationRoutes(app, {
    getGpuPlan: async ({ query }) => ({ mode: query.mode || "layer" }),
    getClaudeSetup: async () => ({ ok: true, method: "get" }),
    setupClaude: async ({ body }) => ({ ok: true, method: "post", provider: body.provider }),
  });

  assert.equal(routes.size, 3);
  let response = makeResponse();
  await routes.get("GET /api/gpu-plan")({ query: { mode: "row" } }, response.res);
  assert.deepEqual(response.state.json[0], { mode: "row" });

  response = makeResponse();
  await routes.get("GET /api/claude/setup")({ query: {} }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, method: "get" });

  response = makeResponse();
  await routes.get("POST /api/claude/setup")({ body: { provider: "local" } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, method: "post", provider: "local" });

  const errorRoutes = new Map();
  core.registerIntegrationRoutes({
    get(pathname, handler) { errorRoutes.set(`GET ${pathname}`, handler); },
  }, {
    getGpuPlan: async () => {
      const error = new Error("gpu unavailable");
      error.status = 503;
      throw error;
    },
  });
  response = makeResponse();
  await errorRoutes.get("GET /api/gpu-plan")({ query: {} }, response.res);
  assert.equal(response.state.statusCode, 503);
  assert.deepEqual(response.state.json[0], { error: "gpu unavailable" });
});

test("manager route registrar preserves config, status, memory, and compression behavior", async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); },
  };
  function makeResponse() {
    const state = { statusCode: 200, json: [] };
    const res = {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(value) {
        state.json.push(value);
        return value;
      },
    };
    return { res, state };
  }

  const jobs = new Map([
    ["old", { id: "old" }],
    ["new", { id: "new" }],
  ]);
  core.registerManagerRoutes(app, {
    config: { containerName: "model-container", image: "repo/image:v1", modelsRoot: "D:/AI/models" },
    host: "127.0.0.1",
    port: 5177,
    engine: "vllm",
    jobs,
    getLanAddress: () => "192.168.1.27",
    getConfigExtras: () => ({ defaultVllmImagePinned: true }),
    hasHfToken: () => true,
    isLocalRequest: (req) => Boolean(req.local),
    shutdownManager: async () => {},
    buildManagerHealth: async (engine) => ({ ok: true, engine }),
    getDockerVersion: async () => ({ ok: true }),
    getGpuStatus: async () => ({ devices: [{ id: "0" }] }),
    getContainerStatus: async (name) => ({ name, running: true }),
    getImageStatus: async (image) => ({ image, present: true }),
    getRunningModelSummary: async () => ({
      servedModels: ["model-a"],
      models: [{ id: "model-a" }],
      endpoint: "http://127.0.0.1:8000/v1",
      apiKeyRequired: true,
    }),
    getManagerResourceSummary: async () => ({ vramUsedPct: 42 }),
    buildStatusExtras: () => ({ gpuPlan: { mode: "layer" } }),
    buildMemoryEstimate: (input) => {
      if (input.bad) throw new Error("bad estimate");
      return { ok: true, contextTokens: input.contextTokens };
    },
    collectStats: async () => ({ totalTokens: 10 }),
    collectExternalAccessStats: async (options) => ({ options }),
    buildExternalAccessOptions: (query) => ({ limit: Number(query.limit || 160) }),
    getClaudeCompressionSettings: async () => ({ enabled: true }),
    saveClaudeCompressionSettings: async (input) => ({ saved: input.enabled }),
  });

  assert.equal(routes.size, 11);
  let response = makeResponse();
  await routes.get("GET /api/config")({}, response.res);
  assert.equal(response.state.json[0].lanAddress, "192.168.1.27");
  assert.equal(response.state.json[0].hasHfToken, true);
  assert.equal(response.state.json[0].defaultVllmImagePinned, true);

  response = makeResponse();
  await routes.get("POST /api/manager/shutdown")({ local: false }, response.res);
  assert.equal(response.state.statusCode, 403);

  response = makeResponse();
  await routes.get("GET /api/status")({}, response.res);
  assert.equal(response.state.json[0].container.name, "model-container");
  assert.equal(response.state.json[0].apiKeyRequired, true);
  assert.deepEqual(response.state.json[0].gpuPlan, { mode: "layer" });
  assert.deepEqual(response.state.json[0].jobs.map((job) => job.id), ["new", "old"]);

  response = makeResponse();
  await routes.get("POST /api/memory-estimate")({ body: { contextTokens: 8192 } }, response.res);
  assert.deepEqual(response.state.json[0], { ok: true, contextTokens: 8192 });

  response = makeResponse();
  await routes.get("POST /api/memory-estimate")({ body: { bad: true } }, response.res);
  assert.equal(response.state.statusCode, 400);
  assert.deepEqual(response.state.json[0], { ok: false, error: "bad estimate" });

  response = makeResponse();
  await routes.get("GET /api/external-access")({ query: { limit: "44" } }, response.res);
  assert.deepEqual(response.state.json[0], { options: { limit: 44 } });

  response = makeResponse();
  await routes.get("POST /api/claude/context-compression")({ body: { enabled: false } }, response.res);
  assert.deepEqual(response.state.json[0], { saved: false });
});

test("Claude bridge converts Anthropic messages and tools to OpenAI chat format", () => {
  const messages = core.anthropicMessagesToOpenAi({
    system: [{ type: "text", text: "You are local." }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will call a tool." },
          { type: "tool_use", id: "toolu_1", name: "search", input: { query: "qwen" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }],
      },
    ],
  });
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].content[1].image_url.url, "data:image/png;base64,abc");
  assert.equal(messages[2].tool_calls[0].function.name, "search");
  assert.deepEqual(JSON.parse(messages[2].tool_calls[0].function.arguments), { query: "qwen" });
  assert.equal(messages[3].role, "tool");
  assert.equal(messages[3].tool_call_id, "toolu_1");

  const tools = core.anthropicToolsToOpenAi([
    { name: "search", description: "web search", input_schema: { type: "object", properties: { query: { type: "string" } } } },
  ]);
  assert.equal(tools[0].type, "function");
  assert.equal(core.anthropicToolChoiceToOpenAi({ type: "tool", name: "search" }, tools).function.name, "search");
});

test("Claude bridge builds OpenAI chat payloads with tools, stream options, and Qwen thinking defaults", () => {
  const payload = core.buildOpenAiChatBodyFromClaude({
    max_tokens: 2048,
    temperature: "0.3",
    stop_sequences: ["</stop>"],
    stream: true,
    disable_parallel_tool_use: true,
    tool_choice: { type: "tool", name: "search" },
    tools: [
      { name: "search", description: "web search", input_schema: { type: "object", properties: { query: { type: "string" } } } },
    ],
    messages: [{ role: "user", content: "hello" }],
  }, "Qwen3-local");

  assert.equal(payload.model, "Qwen3-local");
  assert.equal(payload.max_tokens, 2048);
  assert.equal(payload.temperature, 0.3);
  assert.deepEqual(payload.stop, ["</stop>"]);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.tools[0].function.name, "search");
  assert.equal(payload.tool_choice.function.name, "search");
  assert.equal(payload.chat_template_kwargs.enable_thinking, false);

  const explicitThinking = core.buildOpenAiChatBodyFromClaude({
    chat_template_kwargs: { enable_thinking: true },
    messages: [{ role: "user", content: "hello" }],
  }, "Qwen3-local", { defaultMaxTokens: 999 });
  assert.equal(explicitThinking.max_tokens, 999);
  assert.equal(explicitThinking.chat_template_kwargs.enable_thinking, true);

  const llamaPayload = core.buildOpenAiChatBodyFromClaude({
    messages: [{ role: "user", content: "hello" }],
  }, "llama-local", { disableQwenThinking: false });
  assert.equal(llamaPayload.chat_template_kwargs, undefined);
});

test("Claude bridge converts OpenAI tool calls back to Anthropic content", () => {
  const response = core.openAiResponseToClaude({
    id: "chatcmpl_1",
    model: "local-model",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "calling",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  }, "fallback");
  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content[1], { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } });
  assert.deepEqual(response.usage, { input_tokens: 12, output_tokens: 4 });
});

test("Claude bridge normalizes tool argument edge cases", () => {
  assert.deepEqual(core.parseToolArguments("42"), { value: 42 });
  assert.deepEqual(core.parseToolArguments("[1,2]"), { value: [1, 2] });
  assert.deepEqual(core.parseToolArguments("{bad"), { raw: "{bad" });
  assert.deepEqual(core.parseToolArguments({ ok: true }), { ok: true });
  assert.equal(core.mapOpenAiStopReason("length"), "max_tokens");
  assert.equal(core.mapOpenAiStopReason("content_filter"), "stop_sequence");
});

test("Claude compression preserves hard instructions, errors, and tool pairs", () => {
  const messages = [
    { role: "user", content: "Goal: fix Docker error at D:\\AI\\models. Must preserve audit password rules. Run `docker logs vllm-local`." },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_logs", name: "read_logs", input: { container: "vllm-local" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_logs", content: "error: configured model not available on http://127.0.0.1:8000/v1" }] },
  ];
  const split = core.splitClaudeMessagesForCompression(messages, 1);
  assert.ok(split.recentMessages.length >= 2);
  assert.ok(split.recentMessages.some((message) => core.anthropicMessageToSummaryText(message).includes("tool_use")));

  const summary = core.buildClaudeCompressionSummary(messages, {
    language: "en-US",
    summaryBudget: 900,
    originalPromptTokens: 7000,
    contextLimit: 8192,
    settings: { triggerRatio: 0.9, recentRatio: 0.2, summaryRatio: 0.2 },
  });
  assert.ok(summary.tokens > 0);
  assert.ok(summary.protectedItems > 0);
  assert.match(summary.text, /tool_use read_logs/);
  assert.match(summary.text, /configured model not available/i);
  assert.match(core.appendClaudeCompressionSummary("system", "summary"), /system\n\nsummary/);
});

test("Claude compression applies from core with context limits and summary metadata", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}. Goal: keep the Docker/vLLM task moving. Must preserve D:\\AI paths and error details. `.repeat(60),
  }));
  messages[8] = { role: "assistant", content: [{ type: "tool_use", id: "toolu_keep", name: "read_logs", input: { path: "D:\\AI\\logs" } }] };
  messages[9] = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_keep", content: "error: model failed on http://127.0.0.1:8000/v1" }] };

  const compression = core.applyClaudeContextCompression({
    system: "system rules",
    model: "local",
    max_tokens: 512,
    messages,
  }, {
    servedModels: [{ id: "local", max_model_len: 4096 }],
  }, "local", {
    enabled: true,
    mode: "cautious",
    triggerRatio: 0.2,
    recentRatio: 0.2,
    summaryRatio: 0.2,
    minMessages: 4,
  }, {
    language: "en-US",
    defaultMaxTokens: 1024,
  });

  assert.equal(compression.enabled, true);
  assert.equal(compression.contextLimit, 4096);
  assert.equal(compression.applied, true);
  assert.ok(compression.savedTokens > 0);
  assert.ok(compression.summaryTokens > 0);
  assert.ok(compression.protectedItems > 0);
  assert.ok(compression.recentMessageCount < messages.length);
  assert.match(core.anthropicContentToText(compression.body.system), /Automatic context compression summary/);
  assert.ok(compression.body.messages.some((message) => core.anthropicMessageToSummaryText(message).includes("tool_result")));
});

test("access events summarize request, latency, token, and group data", () => {
  const now = Date.parse("2026-06-14T12:10:00.000Z");
  const events = [
    core.normalizeAccessEvent({ at: "2026-06-14T12:00:00.000Z", remoteAddress: "192.168.1.9", status: 200, durationMs: 100, inputTokens: 10, outputTokens: 5, path: "/serve/v1/chat/completions", model: "local" }, "192.168.1.2"),
    core.normalizeAccessEvent({ at: "2026-06-14T12:01:00.000Z", remoteAddress: "127.0.0.1", status: 401, durationMs: 20, path: "/claude/messages" }, "192.168.1.2"),
  ];
  assert.equal(events[0].external, true);
  assert.equal(events[1].external, false);
  const summary = core.summarizeAccessEvents(events, now);
  assert.equal(summary.requests.total, 2);
  assert.equal(summary.requests.success, 1);
  assert.equal(summary.requests.authFailures, 1);
  assert.equal(summary.tokens.total, 15);
  const grouped = core.groupAccessEvents(events, (event) => event.path);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].count, 1);
});

test("service gateway access log store reads JSONL and builds external stats", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "service-access-log-"));
  const file = path.join(dir, "access.jsonl");
  const store = core.createServiceGatewayAccessLogStore({
    file,
    host: "0.0.0.0",
    port: 5177,
    getLanAddress: () => "192.168.1.2",
    getServiceExposureSettings: async () => ({
      exposureMode: "lan",
      requireApiKey: true,
      rateLimitRpm: 120,
      maxConcurrentRequests: 4,
    }),
    normalizeServiceExposureSettings: core.normalizeServiceExposureSettings,
    getContainerStatus: async () => ({ running: true, status: "running" }),
    getContainerEndpoint: () => ({ lanUrl: "http://192.168.1.2:8000" }),
    claudeBasePath: "/claude",
  });

  await store.appendServiceGatewayAccessLog({
    at: "2026-06-14T12:00:00.000Z",
    remoteAddress: "192.168.1.9",
    status: 200,
    durationMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    path: "/serve/v1/chat/completions",
    model: "requested",
    resolvedModel: "served",
    prompt: "should not be copied into stats",
  });
  await store.appendServiceGatewayAccessLog({
    at: "2026-06-14T12:01:00.000Z",
    remoteAddress: "127.0.0.1",
    status: 401,
    path: "/claude/messages",
  });

  const stats = await store.collectExternalAccessStats({ limit: 20, maxLines: 100 });
  assert.equal(stats.service.claudeBaseUrl, "http://192.168.1.2:5177/claude");
  assert.equal(stats.service.openAiContainerBaseUrl, "http://192.168.1.2:8000");
  assert.equal(stats.totals.requests.total, 2);
  assert.equal(stats.external.requests.total, 1);
  assert.equal(stats.local.requests.authFailures, 1);
  assert.equal(stats.resolvedModels[0].key, "served");
  assert.equal(Object.prototype.hasOwnProperty.call(stats.recent[0], "prompt"), false);
});

test("runtime wait resolves when served models appear", async () => {
  const job = { progress: {} };
  const progress = [];
  let finished = null;
  await core.waitForRuntimeReady({
    job,
    port: 8000,
    serviceUrl: "http://127.0.0.1:8000/v1",
    engineName: "vLLM",
    containerName: "vllm-local",
    startupTimeoutMs: 60_000,
    fetchServedModels: async () => [{ id: "local-model" }],
    getContainerStatus: async () => ({ exists: true, running: true }),
    docker: async () => ({ stdout: "", stderr: "" }),
    extractLogIssues: () => [],
    setJobProgress: (_job, value) => {
      job.progress = value;
      progress.push(value);
    },
    appendLog: () => {},
    finishJob: (_job, meta) => { finished = meta; },
    delayFn: async () => {},
  });

  assert.equal(progress.at(-1).state, "ok");
  assert.deepEqual(finished.servedModels, [{ id: "local-model" }]);
});

test("runtime wait reports container exit with extracted log issues", async () => {
  const job = { progress: { percent: 45 } };
  await assert.rejects(() => core.waitForRuntimeReady({
    job,
    port: 8080,
    serviceUrl: "http://127.0.0.1:8080/v1",
    engineName: "llama.cpp",
    containerName: "llama-local",
    startupTimeoutMs: 60_000,
    fetchServedModels: async () => [],
    getContainerStatus: async () => ({ exists: true, running: false, status: "Exited 1" }),
    docker: async () => ({ stdout: "error: failed to load model", stderr: "" }),
    extractLogIssues: (text) => text.includes("failed") ? ["failed to load model"] : [],
    setJobProgress: (_job, value) => { job.progress = value; },
    appendLog: () => {},
    finishJob: () => {},
    delayFn: async () => {},
  }), /container exited/);

  assert.equal(job.progress.state, "fail");
  assert.equal(job.progress.detail, "failed to load model");
});

test("runtime wait detects stalled logs before global timeout", async () => {
  let now = 0;
  const job = { progress: {} };
  await assert.rejects(() => core.waitForRuntimeReady({
    job,
    port: 8000,
    serviceUrl: "http://127.0.0.1:8000/v1",
    engineName: "vLLM",
    containerName: "vllm-local",
    startupTimeoutMs: 60_000,
    stallTimeoutMs: 9_000,
    pollIntervalMs: 5_000,
    logPollIntervalMs: 1,
    fetchServedModels: async () => [],
    getContainerStatus: async () => ({ exists: true, running: true }),
    docker: async () => ({ stdout: "still loading", stderr: "" }),
    extractLogIssues: () => [],
    setJobProgress: (_job, value) => { job.progress = value; },
    appendLog: () => {},
    finishJob: () => {},
    delayFn: async (ms) => { now += ms; },
    nowFn: () => now,
  }), /start stalled/);

  assert.equal(job.progress.stage, "启动停滞");
  assert.equal(job.progress.state, "fail");
});

test("runtime log summary reads Docker logs and keeps engine hooks", async () => {
  const calls = [];
  const summary = await core.summarizeDockerRuntimeLogs({
    containerName: "local",
    tail: 9999,
    docker: async (args, options) => {
      calls.push({ args, options });
      return {
        stdout: "loading weights\nRuntimeError: CUDA out of memory\napi server ready\n",
        stderr: "",
      };
    },
    classifyIssue: (message) => /memory/i.test(message) ? "error" : "warn",
    issueHint: (message) => `hint:${message.slice(0, 6)}`,
    detectStage: (text) => text.includes("ready") ? "API ready" : "starting",
    buildSuggestions: (issues, stage) => [`${stage}:${issues.length}`],
  });
  assert.deepEqual(calls[0].args, ["logs", "--tail", "2000", "local"]);
  assert.equal(calls[0].options.rejectOnError, false);
  assert.equal(summary.ok, false);
  assert.equal(summary.stage, "API ready");
  assert.equal(summary.lineCount, 3);
  assert.equal(summary.issues[0].severity, "error");
  assert.match(summary.issues[0].hint, /^hint:/);
  assert.deepEqual(summary.suggestions, ["API ready:1"]);
  assert.deepEqual(summary.recent, ["loading weights", "RuntimeError: CUDA out of memory", "api server ready"]);
});

test("runtime request helpers clamp logs and test OpenAI chat completions", async () => {
  const dockerCalls = [];
  const logs = await core.readDockerRuntimeLogs({
    containerName: "service",
    tail: 99999,
    docker: async (args, options) => {
      dockerCalls.push({ args, options });
      return { stdout: "out", stderr: "err" };
    },
  });
  assert.equal(logs, "outerr");
  assert.deepEqual(dockerCalls[0].args, ["logs", "--tail", "2000", "service"]);

  const fetchCalls = [];
  const response = await core.testOpenAiChatCompletion({
    port: 1234,
    model: "model-a",
    prompt: "ping",
    headers: { authorization: "Bearer secret" },
    fetchImpl: async (url, request) => {
      fetchCalls.push({ url, request });
      return { status: 200, text: async () => "{\"ok\":true}" };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, "{\"ok\":true}");
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.equal(fetchCalls[0].request.headers.authorization, "Bearer secret");
  assert.equal(JSON.parse(fetchCalls[0].request.body).prompt, undefined);
  assert.equal(JSON.parse(fetchCalls[0].request.body).messages[0].content, "ping");
  await assert.rejects(() => core.testOpenAiChatCompletion({ port: 1234 }), /model is required/);

  const handlerCalls = [];
  const handlers = core.createRuntimeRequestHandlers({
    dockerRuntime: {
      startDockerDesktop: async (query, timeoutMs) => {
        handlerCalls.push(["docker", query, timeoutMs]);
        return { ok: true, timeoutMs };
      },
    },
    docker: async (args) => {
      handlerCalls.push(["logs", args]);
      return { stdout: "log", stderr: "" };
    },
    containerName: "runtime",
    defaultPort: 8000,
    dockerStartTimeoutMs: 90000,
    defaultTail: 20,
    cleanRequired: (value, name) => {
      const text = String(value || "").trim();
      if (!text) throw new Error(`${name} missing`);
      return text;
    },
    prompt: "manager OK",
    getApiKey: async () => "sk-local",
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    fetchImpl: async (url, request) => {
      handlerCalls.push(["fetch", url, request.headers.authorization, JSON.parse(request.body)]);
      return { status: 200, text: async () => "done" };
    },
  });
  assert.deepEqual(await handlers.startDockerDesktopRequest({ query: { dryRun: "1" } }), { ok: true, timeoutMs: 90000 });
  assert.equal(await handlers.readRuntimeLogsRequest({ query: { tail: 12 } }), "log");
  const completion = await handlers.testRuntimeCompletionRequest({ body: { model: "model-a" } });
  assert.equal(completion.body, "done");
  assert.deepEqual(handlerCalls[0], ["docker", { dryRun: "1" }, 90000]);
  assert.deepEqual(handlerCalls[1], ["logs", ["logs", "--tail", "12", "runtime"]]);
  assert.equal(handlerCalls[2][1], "http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(handlerCalls[2][2], "Bearer sk-local");
  assert.equal(handlerCalls[2][3].messages[0].content, "manager OK");
});

test("runtime stop handlers stop and unload with audit payloads", async () => {
  const audits = [];
  let stops = 0;
  const handlers = core.createRuntimeStopHandlers({
    managerName: "test-manager",
    containerName: "test-container",
    getRunningModelSummary: async () => ({ models: [{ id: "model-a" }] }),
    stopRuntime: async () => {
      stops += 1;
      return { removed: true, containerName: "test-container" };
    },
    exportAudit: async (reason, payload) => {
      audits.push({ reason, payload });
      return { ok: true, reason };
    },
    unloadNote: "stop container only",
  });

  const stopped = await handlers.stopRuntimeRequest();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.audit.reason, "model-stop");
  assert.equal(audits[0].payload.previousModels[0].id, "model-a");

  const unloaded = await handlers.unloadRunningModelRequest({ body: { modelId: "model-a" } });
  assert.equal(unloaded.modelId, "model-a");
  assert.equal(unloaded.unloaded, true);
  assert.equal(unloaded.note, "stop container only");
  assert.equal(audits[1].reason, "model-unload");
  assert.equal(audits[1].payload.requestedModelId, "model-a");
  assert.equal(stops, 2);
});

test("vLLM memory plan treats CPU offload as a per-GPU budget", () => {
  const base = {
    paramsB: 27,
    contextTokens: 65536,
    bytesPerParam: 0.55,
    kvBytes: 1,
    selectedGpus: [
      { id: "0", totalGb: 24, usedGb: 2 },
      { id: "1", totalGb: 24, usedGb: 2 },
    ],
    utilization: 0.9,
    mode: "tensor",
    tensorParallelSize: 2,
    cpuOffloadGb: 0,
  };
  const noOffload = core.estimateVllmMemoryPlan(base);
  const offloaded = core.estimateVllmMemoryPlan({ ...base, cpuOffloadGb: 4 });
  assert.equal(offloaded.memorySplitFactor, 2);
  assert.ok(offloaded.weightPerGpuGb < noOffload.weightPerGpuGb);
  assert.ok(noOffload.weightPerGpuGb - offloaded.weightPerGpuGb > 3.9);
});

test("vLLM data parallel does not split per-GPU memory", () => {
  const plan = core.estimateVllmMemoryPlan({
    paramsB: 13,
    contextTokens: 8192,
    bytesPerParam: 2,
    selectedGpus: [
      { id: "0", totalGb: 48, usedGb: 4 },
      { id: "1", totalGb: 48, usedGb: 4 },
    ],
    mode: "data",
    tensorParallelSize: 2,
  });
  assert.equal(plan.memorySplitFactor, 1);
  assert.ok(plan.weightPerGpuBeforeOffloadGb > 20);
});

test("vLLM overflow recommends CPU or KV offload", () => {
  const plan = core.estimateVllmMemoryPlan({
    paramsB: 70,
    contextTokens: 131072,
    bytesPerParam: 2,
    kvBytes: 2,
    selectedGpus: [{ id: "0", totalGb: 24, usedGb: 2 }],
    utilization: 0.9,
  });
  assert.equal(plan.status, "fail");
  assert.ok(plan.overflowPerGpuGb > 0);
  assert.ok(plan.recommendedCpuOffloadGb > 0 || plan.recommendedKvOffloadGb > 0);
});

test("llama memory plan can reduce GPU layers for RAM fallback", () => {
  const plan = core.estimateLlamaMemoryPlan({
    paramsB: 70,
    contextTokens: 65536,
    bytesPerParam: 0.8,
    kvBytes: 1,
    selectedGpus: [{ id: "0", totalGb: 24, usedGb: 2 }],
    gpuLayers: "all",
  });
  assert.equal(plan.status, "fail");
  assert.ok(plan.recommendedGpuLayers < plan.totalLayers);
  assert.ok(plan.totalWeightsGb > plan.gpuWeightsGb || plan.recommendedGpuLayers < plan.requestedGpuLayers);
});

test("llama memory plan moves weights and KV to RAM when GPU layers are reduced", () => {
  const allGpu = core.estimateLlamaMemoryPlan({
    paramsB: 13,
    contextTokens: 32768,
    bytesPerParam: 0.56,
    kvBytes: 1,
    gpuLayers: "all",
    selectedGpus: [{ id: "0", totalGb: 48, usedGb: 4 }],
  });
  const halfGpu = core.estimateLlamaMemoryPlan({
    paramsB: 13,
    contextTokens: 32768,
    bytesPerParam: 0.56,
    kvBytes: 1,
    gpuLayers: Math.floor(allGpu.totalLayers / 2),
    selectedGpus: [{ id: "0", totalGb: 48, usedGb: 4 }],
  });

  assert.ok(halfGpu.gpuWeightsGb < allGpu.gpuWeightsGb);
  assert.ok(halfGpu.gpuKvGb < allGpu.gpuKvGb);
  assert.ok(halfGpu.cpuWeightsGb > allGpu.cpuWeightsGb);
  assert.ok(halfGpu.cpuKvGb > allGpu.cpuKvGb);
});

test("download helpers normalize precision aliases and GGUF include patterns", () => {
  assert.equal(core.cleanDownloadSource("HuggingFace"), "huggingface");
  assert.throws(() => core.cleanDownloadSource("ftp"), /Unsupported download source/);
  assert.equal(core.normalizeRemoteQuantFilter("Q4KM"), "Q4_K_M");
  assert.equal(core.normalizeRemoteQuantFilter("modelopt-fp4"), "NVFP4");
  assert.equal(core.normalizeRemoteQuantFilter("原始 BF16/FP16"), "");
  assert.deepEqual(core.normalizeDownloadModelReference("owner/model:IQ4_XS", ""), {
    model: "owner/model",
    precision: "IQ4_XS",
  });
  assert.deepEqual(core.buildDownloadIncludePatterns("Q4"), ["*Q4*.gguf", "*IQ4*.gguf"]);
  assert.deepEqual(core.buildDownloadIncludePatterns("Q8_0"), ["*Q8_0*.gguf"]);
  assert.equal(core.matchesDownloadPrecisionFile("model-Q4_K_M.gguf", "Q4"), true);
  assert.equal(core.matchesDownloadPrecisionFile("model-IQ4_XS.gguf", "IQ4"), true);
  assert.equal(core.matchesDownloadPrecisionFile("model-Q6_K.gguf", "Q4"), false);
  const siblings = [
    { rfilename: "model-Q4_K_M.gguf" },
    { rfilename: "model-Q8_0.gguf" },
    { rfilename: "tokenizer.json" },
  ];
  assert.deepEqual(core.filterDownloadSiblings(siblings, "Q8_0"), [{ rfilename: "model-Q8_0.gguf" }]);
  assert.deepEqual(core.selectDownloadSiblings(siblings, "Q8_0"), {
    siblings: [{ rfilename: "model-Q8_0.gguf" }],
    includePatterns: ["*Q8_0*.gguf"],
    filtered: true,
    matched: 1,
    total: 3,
  });
  assert.deepEqual(core.selectDownloadSiblings(siblings, "Q6_K"), {
    siblings: [],
    includePatterns: ["*Q6_K*.gguf"],
    filtered: true,
    matched: 0,
    total: 3,
  });

  const builder = core.createDownloadCommandBuilder({
    hfCli: "hf",
    modelScopeCli: "modelscope",
    hfCache: "cache-root",
    modelsRoot: "D:/models",
    env: { BASE: "1" },
    cleanRequired: core.cleanRequired,
    resolveModelPath: (value) => String(value).replace(/\\/g, "/"),
    safeOutputName: (value) => String(value).replace(/[\\/]/g, "__"),
  });
  const spec = builder.buildDownloadSpecFromJob({
    title: "Resume model",
    meta: { model: "owner/model", precision: "Q4", expectedBytes: 123 },
  });
  assert.equal(spec.command, "hf");
  assert.deepEqual(spec.args, ["download", "owner/model", "--include", "*Q4*.gguf", "--include", "*IQ4*.gguf", "--local-dir", "D:/models/owner__model"]);
  assert.equal(spec.options.env.HF_HOME, "cache-root");
  assert.equal(spec.options.meta.localDir, "D:/models/owner__model");
  assert.equal(spec.options.countExistingProgress, true);
});

test("remote model helpers share search, size, and quant filtering semantics", () => {
  assert.deepEqual(core.remoteSearchesWithQuant(["Qwen", ""], "Q4"), ["Qwen Q4_K_M", "Q4_K_M", "Qwen", ""]);
  assert.deepEqual(core.remoteSearchesWithQuant([""], "IQ4"), ["IQ4_XS"]);
  assert.equal(core.remoteQuantSearchTerm("quantized"), "");
  assert.equal(core.remoteQuantSearchTerm("modelopt-fp4"), "NVFP4");

  assert.equal(core.inferRemoteParamsB("Qwen3-A22B-Instruct"), 22);
  assert.equal(core.inferRemoteParamsB("TinyLlama-560M-GGUF"), 0.56);
  assert.equal(core.inferRemoteParamsB("no-size-here"), null);
  assert.equal(core.remoteSizeClass(8), "small");
  assert.equal(core.remoteSizeClass(14), "medium");
  assert.equal(core.remoteSizeClass(32), "large");
  assert.equal(core.remoteSizeClass(70), "xlarge");
  assert.deepEqual(core.inferRemoteQuantFormats({
    id: "owner/model-NVFP4",
    tags: ["fp8"],
    siblings: [{ rfilename: "weights-Q4_K_M.gguf" }],
  }), ["Q4_K_M", "NVFP4", "FP8", "GGUF"]);
  assert.deepEqual(core.inferRemoteQuantFormats({
    id: "owner/model-exl2",
    keywords: [["exl2", "EXL2"]],
  }), ["EXL2"]);

  assert.equal(core.isUncensoredText("abliterated no-filter uncens"), true);
  assert.equal(core.isUncensoredText("ordinary instruct model"), false);
  assert.equal(core.isAfterDate("2026-01-01", "2025-01-01"), true);
  assert.equal(core.isAfterDate("bad-date", "2025-01-01"), false);

  const model = {
    id: "maker/Example-27B-Q4_K_M-GGUF",
    paramsB: 27,
    hasGguf: true,
    hasQuantizedFiles: true,
    quantFormats: ["Q4_K_M", "GGUF", "FP16"],
  };
  assert.equal(core.remoteFamilyKey(model), "example-27b");
  assert.equal(core.matchesRemoteSizeFilter(model, "large"), true);
  assert.equal(core.matchesRemoteSizeFilter(model, "medium"), false);
  assert.equal(core.matchesRemoteSizeFilter({ id: "maker/Unknown-GGUF" }, "unknown"), true);
  assert.equal(core.matchesRemoteSizeFilter({ id: "maker/Unknown-GGUF" }, "small"), false);
  assert.equal(core.matchesRemoteQuantFilter(model, "GGUF"), true);
  assert.equal(core.matchesRemoteQuantFilter(model, "4bit"), true);
  assert.equal(core.matchesRemoteQuantFilter({ quantFormats: ["NVFP4"] }, "INT4"), true);
  assert.equal(core.matchesRemoteQuantFilter({ hasQuantizedFiles: false, quantFormats: ["BF16"] }, "quantized"), false);
  assert.deepEqual(Array.from(core.remoteQuantSet(model)).sort(), ["FP16", "GGUF", "Q4_K_M"]);
  assert.equal(core.hasQuantizedRemoteFiles(["BF16", "FP16"]), false);
  assert.equal(core.hasQuantizedRemoteFiles(["FP16", "Q4_K_M"]), true);
});

test("remote model selection parser keeps engine precision ordering configurable", () => {
  const base = {
    id: "Qwen/Qwen3.6-27B-Text-NVFP4-MTP-GGUF",
    author: "qwenlm",
    tags: ["text-generation"],
    siblings: [{ rfilename: "model-Q4_K_M.gguf" }],
    quantFormats: ["NVFP4", "Q4_K_M", "GGUF"],
  };
  const vllm = core.inferModelSelection(base);
  const llama = core.inferModelSelection({
    ...base,
    precisionOrder: ["Q4_K_M", "Q5_K_M", "Q8_0", "IQ4_XS", "NVFP4", "GGUF", "原始 BF16/FP16"],
  });

  assert.equal(vllm.developer, "Qwen");
  assert.equal(vllm.modelVersion, "Qwen3.6");
  assert.equal(vllm.spec, "27B Text");
  assert.equal(vllm.precision, "NVFP4");
  assert.equal(llama.precision, "Q4_K_M");
  assert.deepEqual(core.remotePrecisionLabelsFromValue("AWQ INT4 BF16"), ["AWQ", "INT4", "原始 BF16/FP16"]);
  assert.equal(core.normalizePrecisionToken("iq4-xs"), "IQ4XS");
  assert.equal(core.isSizeToken("8x7B"), true);
});

test("model filesystem store scans local, cached, and GGUF models safely", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-filesystem-store-"));
  const modelsRoot = path.join(dir, "models");
  const hfCache = path.join(dir, "cache");
  const localModel = path.join(modelsRoot, "Qwen-Test");
  const ggufDir = path.join(modelsRoot, "Tiny-GGUF", "sub");
  const cachedModel = path.join(hfCache, "hub", "models--org--cached-model");
  await fs.mkdir(localModel, { recursive: true });
  await fs.mkdir(ggufDir, { recursive: true });
  await fs.mkdir(cachedModel, { recursive: true });
  await fs.writeFile(path.join(localModel, "config.json"), "{}");
  await fs.writeFile(path.join(localModel, "weights.bin"), "12345");
  await fs.writeFile(path.join(ggufDir, "small.gguf"), "1");
  await fs.writeFile(path.join(ggufDir, "large.gguf"), "123456789");
  await fs.writeFile(path.join(cachedModel, "refs.json"), "{}");

  const store = core.createModelFilesystemStore({ modelsRoot, hfCache });
  const local = await store.listLocalModels();
  const cached = await store.listCachedModels();
  assert.equal(local.length, 2);
  assert.equal(local.find((item) => item.id === "Qwen-Test").hasConfig, true);
  assert.equal(local.find((item) => item.id === "Tiny-GGUF").ggufFiles[0].name, path.join("sub", "large.gguf"));
  assert.equal(cached[0].id, "org/cached-model");
  assert.equal(store.chooseGgufFile(local.find((item) => item.id === "Tiny-GGUF").ggufFiles).name, path.join("sub", "large.gguf"));
  assert.equal(store.looksLikeGgufReference("repo/model:q4_k_m"), true);
  assert.equal(store.describeLocalModelPath(localModel).ggufFiles.length, 0);
  assert.throws(() => store.resolveModelsRootChild(path.join(dir, "outside")), /inside models root/);

  const verifiedSafetensors = await store.verifyDownloadedModel({ localDir: localModel });
  assert.equal(verifiedSafetensors.ok, true);
  assert.equal(verifiedSafetensors.safetensors, 0);
  assert.equal(verifiedSafetensors.hasConfig, true);

  const verifiedGguf = await store.verifyDownloadedModel({ localDir: path.join(modelsRoot, "Tiny-GGUF") }, {
    buildIssues: (summary, makeFinding) => summary.gguf ? [] : [makeFinding("fail", "未发现 GGUF", "llama.cpp 需要 .gguf 权重。")],
  });
  assert.equal(verifiedGguf.ok, true);
  assert.equal(verifiedGguf.gguf, 2);
  assert.equal(verifiedGguf.largestFiles[0].name, path.join("sub", "large.gguf"));

  const missing = await store.verifyDownloadedModel({ outputName: "missing" });
  assert.equal(missing.status, "missing");
});

test("model reference helpers parse links and build safe names", () => {
  assert.deepEqual(core.parseModelReference("Qwen/Qwen3-8B"), {
    source: "huggingface",
    model: "Qwen/Qwen3-8B",
    url: "https://huggingface.co/Qwen/Qwen3-8B",
  });
  assert.deepEqual(core.parseModelReference("https://huggingface.co/models/Qwen/Qwen3-8B/tree/main"), {
    source: "huggingface",
    model: "Qwen/Qwen3-8B",
    url: "https://huggingface.co/Qwen/Qwen3-8B",
  });
  assert.deepEqual(core.parseModelReference("https://modelscope.cn/models/qwen/Qwen3-8B/summary"), {
    source: "modelscope",
    model: "qwen/Qwen3-8B",
    url: "https://modelscope.cn/models/qwen/Qwen3-8B",
  });
  assert.equal(core.encodeRepoId("owner/model with space"), "owner/model%20with%20space");
  assert.equal(core.deriveName("D:\\AI\\models\\Qwen3-8B\\"), "qwen3-8b");
  assert.equal(core.safeOutputName("owner/model:bad"), "owner__model-bad");
  assert.equal(core.cleanRequired("  value  ", "field"), "value");
  assert.throws(() => core.cleanRequired("", "field"), (error) => error.status === 400 && /field is required/.test(error.message));
  assert.throws(() => core.parseModelReference("not a model link"), (error) => error.status === 400);
});

test("common helpers parse JSON, quote shell values, and compact timestamps", () => {
  assert.deepEqual(core.parseJsonSafe("{\"ok\":true}", {}), { ok: true });
  assert.deepEqual(core.parseJsonSafe("{bad", { ok: false }), { ok: false });
  assert.equal(core.shellQuote("it's fine"), "'it'\\''s fine'");
  assert.equal(core.cleanOptionalLaunchArg("  --flag=value  "), "--flag=value");
  assert.equal(core.compactTimestamp("2026-06-15T01:02:03.456Z"), "20260615T010203Z");
  assert.deepEqual(core.normalizeGpuIds(["0", "1", "1", "bad"]), ["0", "1"]);
  assert.deepEqual(core.normalizeGpuIds("0, 2, x, 2"), ["0", "2"]);
  assert.equal(core.positiveInt("3.8", 1), 3);
  assert.equal(core.positiveInt("0", 7), 7);
  assert.equal(core.clampNumber("1.5", 0, 1, 0.5), 1);
  assert.equal(core.nonNegativeNumber("-1", 4), 4);
  assert.equal(core.optionalNonNegativeNumber(""), null);
  assert.equal(core.optionalNonNegativeNumber("2.5"), 2.5);
  assert.equal(core.normalizeNetworkAccess("LAN"), "lan");
  assert.equal(core.normalizeNetworkAccess("anything"), "local");
  assert.equal(core.normalizeKvCacheDtype("fp8_e5m2"), "fp8_e5m2");
  assert.equal(core.normalizeKvCacheDtype("weird"), "auto");
  assert.equal(core.normalizeClientPreset("claude-cowork"), "claude-cowork");
  assert.equal(core.normalizeClientPreset("unknown"), "generic");
});

test("job helpers normalize persistence, logs, issues, and byte labels", () => {
  assert.equal(core.formatBytes(1536), "1.5 KB");
  const normalized = core.normalizePersistedJob({
    id: 7,
    type: "download",
    status: "running",
    logs: ["a", "b", "c"],
    meta: { model: "x" },
    progress: { percent: 10 },
    createdAt: "2026-06-15T00:00:00.000Z",
  }, { maxLogLines: 2 });
  assert.equal(normalized.id, "7");
  assert.deepEqual(normalized.logs, ["b", "c"]);
  assert.deepEqual(normalized.meta, { model: "x" });

  core.markInterruptedJob(normalized, {
    now: "2026-06-15T00:01:00.000Z",
    maxLogLines: 2,
  });
  assert.equal(normalized.status, "interrupted");
  assert.equal(normalized.finishedAt, "2026-06-15T00:01:00.000Z");
  assert.deepEqual(normalized.logs, ["c", "Manager restarted; live process tracking was interrupted."]);

  const logJob = { logs: [] };
  assert.equal(core.appendJobLog(logJob, "one\n\ntwo\nthree", { maxLogLines: 2, now: "now" }), 3);
  assert.deepEqual(logJob.logs, ["two", "three"]);
  assert.equal(logJob.updatedAt, "now");

  const jobs = core.serializeJobs([
    { id: "old", createdAt: "2026-06-15T00:00:00.000Z", logs: ["x"] },
    { id: "new", createdAt: "2026-06-15T00:01:00.000Z", logs: ["y"] },
  ], { maxPersistedJobs: 1 });
  assert.deepEqual(jobs.map((job) => job.id), ["new"]);

  assert.deepEqual(core.extractLogIssues("ok\nRuntimeError: bad\nCUDA out of memory\nfine"), [
    "RuntimeError: bad",
    "CUDA out of memory",
  ]);
});

test("job state helpers centralize lifecycle mutations", () => {
  const job = core.createJobRecord("serve", "Launch", { model: "demo" }, {
    id: "job-1",
    now: "2026-06-15T00:00:00.000Z",
  });
  assert.equal(job.id, "job-1");
  assert.equal(job.status, "running");

  core.applyJobProgress(job, { percent: 25, stage: "Starting", issues: ["warn"] }, {
    now: "2026-06-15T00:00:10.000Z",
  });
  assert.equal(job.progress.percent, 25);
  assert.deepEqual(job.progress.issues, ["warn"]);

  core.markJobCancelRequested(job, "cancel", { now: "2026-06-15T00:00:20.000Z" });
  assert.equal(job.meta.cancelRequested, true);
  assert.equal(job.meta.cancelAction, "cancel");

  assert.equal(core.markJobSuccess(job, {
    meta: { servedModels: ["demo"] },
    serveDetail: "ready",
    now: "2026-06-15T00:00:30.000Z",
  }), true);
  assert.equal(job.status, "success");
  assert.equal(job.progress.percent, 100);
  assert.equal(job.progress.detail, "ready");
  assert.deepEqual(job.meta.servedModels, ["demo"]);
  assert.equal(core.markJobFailed(job, new Error("late failure")), false);

  const failed = core.createJobRecord("serve", "Launch", {}, {
    id: "job-2",
    now: "2026-06-15T00:01:00.000Z",
  });
  assert.equal(core.markJobFailed(failed, new Error("CUDA out of memory"), {
    now: "2026-06-15T00:01:10.000Z",
  }), true);
  assert.equal(failed.status, "failed");
  assert.equal(failed.progress.state, "fail");
  assert.deepEqual(failed.progress.issues, ["CUDA out of memory"]);

  const download = core.createJobRecord("download", "Download", { expectedBytes: 1000 }, {
    id: "job-3",
    now: "2026-06-15T00:02:00.000Z",
  });
  download.progress = { downloadedBytes: 300, totalBytes: 1000, speedBytesPerSec: 500, etaSeconds: 2 };
  core.markJobCancelRequested(download, "pause", { now: "2026-06-15T00:02:05.000Z" });
  assert.equal(core.markDownloadPaused(download, { now: "2026-06-15T00:02:10.000Z" }), true);
  assert.equal(download.status, "paused");
  assert.equal(download.meta.cancelRequested, false);
  assert.equal(download.progress.speedBytesPerSec, 0);

  core.prepareDownloadResume(download, { source: "huggingface" }, {
    now: "2026-06-15T00:02:20.000Z",
  });
  assert.equal(download.meta.source, "huggingface");
  assert.equal(download.finishedAt, null);

  core.markDownloadCancelled(download, { now: "2026-06-15T00:02:30.000Z" });
  assert.equal(download.status, "cancelled");
  assert.equal(download.finishedAt, "2026-06-15T00:02:30.000Z");
});

test("download job controller queues, pauses, resumes, and drains downloads", async () => {
  const jobs = new Map();
  const specs = new Map();
  const spawned = [];
  const stopped = [];
  let queueMode = false;
  let saveCount = 0;
  const createJob = (type, title, meta = {}) => {
    const job = core.createJobRecord(type, title, meta, { id: `job-${jobs.size + 1}` });
    jobs.set(job.id, job);
    return job;
  };
  const controller = core.createDownloadJobController({
    jobs,
    downloadSpecs: specs,
    createJob,
    spawnJobProcess: (job, command, args, options) => {
      job.status = "running";
      job.command = command;
      job.args = args;
      job.spawnOptions = options;
      spawned.push(job.id);
    },
    buildDownloadSpecFromJob: (job) => ({
      command: "hf",
      args: ["download", job.meta.model],
      options: { meta: { ...job.meta }, title: job.title },
    }),
    appendLog: (job, data) => {
      job.logs = [...(job.logs || []), String(data)];
    },
    stopProgressTracker: (job) => stopped.push(job.id),
    scheduleSave: () => {
      saveCount += 1;
    },
    getQueueMode: () => queueMode,
    setQueueMode: (value) => {
      queueMode = Boolean(value);
    },
    saveQueueMode: async () => {},
    resolvePartialPath: (value) => value,
    removePartialPath: async (target) => {
      stopped.push(`rm:${target}`);
    },
  });

  const first = controller.enqueueOrStartDownload("hf", ["download", "a"], { title: "A", meta: { model: "a" } });
  assert.equal(first.status, "running");
  assert.deepEqual(spawned, ["job-1"]);

  await controller.saveDownloadSettings({ queueMode: true });
  const second = controller.enqueueOrStartDownload("hf", ["download", "b"], { title: "B", meta: { model: "b", localDir: "partial-b" } });
  assert.equal(second.status, "queued");
  assert.equal(specs.has(second.id), true);

  controller.pauseDownloadJob(second);
  assert.equal(second.status, "paused");
  assert.equal(specs.has(second.id), false);
  assert.equal(stopped.includes(second.id), true);

  controller.resumeDownloadJob(second);
  assert.equal(second.status, "queued");
  assert.equal(specs.has(second.id), true);

  await controller.saveDownloadSettings({ queueMode: false });
  assert.equal(queueMode, false);
  assert.equal(second.status, "running");
  assert.deepEqual(spawned, ["job-1", "job-2"]);

  const third = createJob("download", "C", { model: "c", localDir: "partial-c" });
  third.status = "paused";
  await controller.cancelDownloadJob(third);
  assert.equal(third.status, "cancelled");
  assert.equal(stopped.includes("rm:partial-c"), true);
  assert.ok(saveCount >= 1);
});

test("jobs ledger store persists jobs and interrupts stale running work", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobs-ledger-store-"));
  const file = path.join(dir, "jobs.json");
  const jobs = new Map();
  const stopped = [];
  const finished = [];
  const store = core.createJobsLedgerStore({
    jobs,
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    maxLogLines: 3,
    maxPersistedJobs: 10,
    serveDetail: "API ready.",
    stopProgressTracker: (job) => stopped.push(job.id),
    onJobSuccess: (job) => finished.push(job.id),
  });

  const serve = store.createJob("serve", "Start model", { model: "local" });
  store.appendLog(serve, "line1\nline2\nline3\nline4");
  store.finishJob(serve, { ok: true });
  assert.equal(serve.status, "success");
  assert.equal(serve.progress.detail, "API ready.");
  assert.deepEqual(stopped, [serve.id]);
  assert.deepEqual(finished, [serve.id]);

  const running = store.createJob("download", "Download");
  store.clearJobsSaveTimer();
  await store.waitForJobsLedgerWrites();
  await store.saveJobsLedgerNow();
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.jobs.length, 2);
  assert.deepEqual(saved.jobs.find((job) => job.id === serve.id).logs, ["line2", "line3", "line4"]);

  const reloaded = new Map();
  const reloadStore = core.createJobsLedgerStore({
    jobs: reloaded,
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    maxLogLines: 3,
  });
  await reloadStore.loadJobsLedgerIntoMemory();
  assert.equal(reloaded.get(running.id).status, "interrupted");
});

test("stats ledger store persists deltas, Claude usage, and runtime facts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stats-ledger-store-"));
  const file = path.join(dir, "stats.json");
  const store = core.createStatsLedgerStore({
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    normalizeClients: core.normalizeStatsClientLedger,
    persistRuntimeFacts: true,
    claudeUsageOptions: {
      id: "claude",
      label: "Claude bridge",
      defaultOk: false,
      modelFallback: "unknown",
      trackSessions: true,
      compressionLast: "applied",
    },
  });

  await store.updateStatsLedger({
    processStartSeconds: 100,
    facts: { maxContextTokens: 8192, maxConcurrency: 2 },
    models: [{
      name: "org/model-a",
      root: "D:/AI/models/model-a",
      tokens: { prompt: 100, generation: 20, cachedPrompt: 5 },
      requests: { total: 2, success: 2, error: 0, aborted: 0 },
      context: { activeTokens: 512, capacityTokens: 16384, kvUsagePercent: 0.03, maxModelLen: 8192, concurrencyAtMaxLen: 2 },
    }],
  }, "collect");
  await store.updateStatsLedger({
    processStartSeconds: 100,
    facts: { modelLoadSeconds: 8 },
    models: [{
      name: "org/model-a",
      root: "D:/AI/models/model-a",
      tokens: { prompt: 140, generation: 30, cachedPrompt: 5 },
      requests: { total: 3, success: 3, error: 0, aborted: 0 },
      context: { activeTokens: 1024, capacityTokens: 16384, kvUsagePercent: 0.06, maxModelLen: 8192, concurrencyAtMaxLen: 2 },
    }],
  }, "collect");

  await store.recordClaudeBridgeUsage({
    requestedModel: "claude-opus-4-7",
    model: "org/model-a",
    ok: true,
    usage: { input_tokens: 32, output_tokens: 8 },
    sessionId: "task-1",
    compression: { applied: true, savedTokens: 100 },
  });

  const ledger = await store.loadStatsLedger();
  assert.equal(ledger.models["org/model-a"].tokens.prompt, 140);
  assert.equal(ledger.models["org/model-a"].tokens.generation, 30);
  assert.equal(ledger.clients.claude.tokens.total, 40);
  assert.equal(ledger.clients.claude.compression.savedTokens, 100);
  assert.equal(ledger.runtimeFacts["org/model-a"].facts.maxModelLen, 8192);

  const facts = await store.getPersistedRuntimeFacts(["model-a"]);
  assert.equal(facts.maxConcurrency, 2);
  assert.equal(facts.modelLoadSeconds, 8);

  const merged = core.mergeLiveAndStatsLedgerInactive({ models: [], uptimeSeconds: null, totals: { context: { activeTokens: 0, capacityTokens: null, kvUsagePercent: 0 } } }, ledger);
  assert.equal(merged.models[0].context.activeTokens, 0);
  assert.equal(merged.models[0].context.maxModelLen, 8192);
});

test("stats ledger store can protect llama counters from metric resets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stats-ledger-monotonic-"));
  const file = path.join(dir, "stats.json");
  const store = core.createStatsLedgerStore({
    file,
    readJsonFile: core.readJsonFile,
    writeJsonFile: core.writeJsonFile,
    monotonicRuntimeCounters: true,
  });
  const model = (prompt, generation) => ({
    name: "llama-model",
    tokens: { prompt, generation, cachedPrompt: 0 },
    requests: { total: 1, success: 1, error: 0, aborted: 0 },
  });

  await store.updateStatsLedger({ processStartSeconds: 5, models: [model(100, 20)] }, "collect");
  await store.updateStatsLedger({ processStartSeconds: 5, models: [model(80, 10)] }, "collect");

  const ledger = await store.loadStatsLedger();
  assert.equal(ledger.models["llama-model"].tokens.prompt, 100);
  assert.equal(ledger.models["llama-model"].tokens.generation, 20);
});

test("process job runner handles logs, exits, cancellation, and cleanup hooks", async () => {
  const children = [];
  const calls = [];
  const spawnCommand = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 9000 + children.length;
    children.push({ child, command, args, opts });
    return child;
  };
  const appendLog = (job, data) => core.appendJobLog(job, data, {
    maxLogLines: 10,
    now: "2026-06-15T00:03:00.000Z",
  });
  const runner = core.createProcessJobRunner({
    spawnCommand,
    appendLog,
    finishJob: (job) => core.markJobSuccess(job, { now: "2026-06-15T00:03:10.000Z" }),
    failJob: (job, error) => core.markJobFailed(job, error, { now: "2026-06-15T00:03:10.000Z" }),
    scheduleSave: (...args) => calls.push(["save", ...args]),
    startProgressTracker: (job, dir, expectedBytes) => calls.push(["progress", job.id, dir, expectedBytes]),
    terminate: (pid) => calls.push(["terminate", pid]),
    handleDownloadCancel: async (job) => core.markDownloadPaused(job, { now: "2026-06-15T00:03:20.000Z" }),
    onDone: (job) => calls.push(["done", job.id]),
  });

  const successJob = core.createJobRecord("download", "Download", {}, { id: "proc-1", now: "2026-06-15T00:03:00.000Z" });
  runner(successJob, "cmd", ["arg"], { progressDir: "D:/models", expectedBytes: 123 });
  children[0].child.stdout.emit("data", "hello\n");
  children[0].child.stderr.emit("data", "warn\n");
  children[0].child.emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successJob.status, "success");
  assert.equal(successJob.pid, 9000);
  assert.deepEqual(successJob.logs.slice(-3), ["> cmd arg", "hello", "warn"]);
  assert.deepEqual(calls.filter((call) => call[0] === "progress"), [["progress", "proc-1", "D:/models", 123]]);

  const pausedJob = core.createJobRecord("download", "Download", {}, { id: "proc-2", now: "2026-06-15T00:04:00.000Z" });
  runner(pausedJob, "cmd", [], {});
  pausedJob.cancel("pause");
  children[1].child.emit("close", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pausedJob.status, "paused");
  assert.equal(pausedJob.meta.cancelRequested, false);
  assert.deepEqual(calls.filter((call) => call[0] === "terminate"), [["terminate", 9001]]);

  const failedJob = core.createJobRecord("serve", "Serve", {}, { id: "proc-3", now: "2026-06-15T00:05:00.000Z" });
  runner(failedJob, "cmd", [], {});
  children[2].child.emit("close", 7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.error, "Process exited with code 7");
  assert.deepEqual(calls.filter((call) => call[0] === "done").map((call) => call[1]), ["proc-1", "proc-2", "proc-3"]);
});
