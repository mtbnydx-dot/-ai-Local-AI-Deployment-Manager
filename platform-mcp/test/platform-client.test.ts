import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { FixedHttpClient } from "../src/http-client.js";
import { LocalPlatformClient } from "../src/platform-client.js";
import { cleanText, redactUnknown } from "../src/redaction.js";

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function config() {
  return loadConfig({
    requireApiKey: true,
    env: {
      AI_ROOT: "D:\\AI",
      PLATFORM_MCP_API_KEY: "test-platform-mcp-key-0123456789abcdef",
      PLATFORM_MCP_SERVICE_ENTRY_URL: "http://127.0.0.1:5176",
      PLATFORM_MCP_VLLM_MANAGER_URL: "http://127.0.0.1:5177",
      PLATFORM_MCP_LLAMA_MANAGER_URL: "http://127.0.0.1:5178",
      PLATFORM_MCP_SEARCH_GATEWAY_URL: "http://127.0.0.1:5180",
      PLATFORM_MCP_SEARCH_GATEWAY_API_KEY: "test-search-gateway-key-0123456789abcdef",
      PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE: "12",
    },
  });
}

describe("configuration boundaries", () => {
  it("accepts loopback upstreams and a strong HTTP key", () => {
    const value = config();
    assert.equal(value.host, "127.0.0.1");
    assert.equal(value.port, 5190);
    assert.equal(value.allowedHosts.includes("host.docker.internal"), true);
    assert.equal(value.searchRateLimitPerMinute, 12);
  });

  it("rejects non-loopback binds, upstreams, weak keys, and escaped audit paths", () => {
    assert.throws(() => loadConfig({ env: { PLATFORM_MCP_HOST: "0.0.0.0", PLATFORM_MCP_API_KEY: "x".repeat(40) } }), /loopback/);
    assert.throws(() => loadConfig({ env: { PLATFORM_MCP_API_KEY: "x".repeat(40), PLATFORM_MCP_SERVICE_ENTRY_URL: "http://192.168.1.9:5176" } }), /loopback/);
    assert.throws(() => loadConfig({ env: { PLATFORM_MCP_API_KEY: "weak" } }), /32 characters/);
    assert.throws(() => loadConfig({ env: {
      PLATFORM_MCP_API_KEY: "x".repeat(40),
      PLATFORM_MCP_SEARCH_RATE_LIMIT_PER_MINUTE: "0",
    } }), /SEARCH_RATE_LIMIT/);
    assert.throws(() => loadConfig({ env: {
      PLATFORM_MCP_API_KEY: "x".repeat(40),
      PLATFORM_MCP_SEARCH_GATEWAY_API_KEY: "weak",
    } }), /SEARCH_GATEWAY_API_KEY/);
    assert.throws(() => loadConfig({ env: {
      AI_ROOT: "D:\\AI",
      PLATFORM_MCP_API_KEY: "x".repeat(40),
      PLATFORM_MCP_AUDIT_LOG: "C:\\outside\\audit.jsonl",
    } }), /below AI_ROOT/);
  });
});

describe("safe upstream mapping", () => {
  const responses = new Map<string, unknown>([
    ["http://127.0.0.1:5176/api/status", {
      entry: { host: "127.0.0.1", port: 5176, uptimeSeconds: 120 },
      managers: [{ id: "vllm", name: "vLLM Manager", process: { portListening: true }, runtime: { container: { running: true } }, error: "" }],
    }],
    ["http://127.0.0.1:5176/api/fleet", {
      updatedAt: "2026-08-15T00:00:00.000Z",
      gatewayBase: "http://127.0.0.1:5176/gateway/auto/openai/v1",
      gpuMemory: { totalMb: 100, usedMb: 60, freeMb: 40, reserveMb: 10, allocatableMb: 30, warningThresholdPct: 90, gpus: [{ id: "0", totalMb: 100, usedMb: 60, freeMb: 40 }] },
      instances: [{ id: "primary", engine: "vllm", containerName: "vllm-local", running: true, lifecycleState: "ready", status: "healthy", port: 8000, models: [{ id: "safe-model", root: "D:\\secret\\model", maxModelLen: 4096, capabilities: ["text"] }] }],
    }],
    ["http://127.0.0.1:5180/health", { ok: true, searchMode: "hybrid", authRequired: true, maxResults: 10, upstreamBaseUrl: "http://secret-upstream" }],
    ["http://127.0.0.1:5180/search?q=MCP+v2&max_results=2&safesearch=1&language=en&time_range=month&engines=github&categories=it", {
      ok: true,
      query: "MCP v2",
      searchedAt: "2026-08-15T00:01:00.000Z",
      backend: "http://secret-search-backend",
      answers: ["token=answer-secret"],
      results: [{
        title: "MCP SDK",
        url: "https://github.com/modelcontextprotocol/typescript-sdk#readme",
        content: "See D:\\secret\\notes and token=result-secret",
        engine: "github",
        score: 1,
        category: "it",
        publishedDate: "2026-07-28",
      }, {
        title: "Credential URL",
        url: "https://user:password@example.com/private",
        content: "must be rejected",
      }, {
        title: "Local file",
        url: "file:///D:/secret/file.txt",
        content: "must be rejected",
      }, {
        title: "Private manager",
        url: "http://127.0.0.1:5177/api/status",
        content: "must be rejected",
      }, {
        title: "Private DNS",
        url: "http://manager.internal/status",
        content: "must be rejected",
      }],
    }],
    ["http://127.0.0.1:5177/api/models", { local: [{ id: "safe-model", label: "Safe Model", path: "D:\\secret\\model", size: 1234, modified: "2026-08-14T00:00:00.000Z", modelFormat: "safetensors", runnable: true, verificationStatus: "warn", verificationIssues: [{ title: "Credential", detail: "token=supersecret" }] }], cached: [] }],
    ["http://127.0.0.1:5178/api/models", { local: [], cached: [] }],
    ["http://127.0.0.1:5177/api/jobs?fields=summary", [{
      id: "serve-secret",
      type: "serve",
      title: "Launch D:\\secret\\model",
      status: "failed",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:02:00.000Z",
      progress: { percent: 25 },
      error: "token=job-secret at D:\\secret\\model",
      pid: 4242,
      command: "powershell secret.ps1",
      metadata: { apiKey: "job-api-secret" },
    }]],
    ["http://127.0.0.1:5178/api/jobs?fields=summary", []],
    ["POST http://127.0.0.1:5176/api/fleet/route-preview", {
      ok: true,
      status: 200,
      capability: "tools",
      reason: "capability_match",
      request: { engine: "auto", protocol: "openai", requestedModel: "safe-model" },
      manager: { id: "vllm", name: "vLLM Manager", apiKeyPreview: "secret-preview" },
      instance: { instanceId: "primary", status: "healthy", port: 8000, root: "D:\\secret\\instance" },
      model: { id: "safe-model", capabilities: ["text", "tools"], root: "D:\\secret\\model" },
      clientId: "secret-client",
    }],
    ["POST http://127.0.0.1:5177/api/memory-estimate", {
      plan: {
        status: "ok",
        weightsGb: 25.15,
        kvGb: 8,
        overheadPerGpuGb: 3,
        perGpuGb: 36.15,
        root: "D:\\secret\\model",
      },
      recommendations: {
        status: "ok",
        summary: "Fits on the selected GPU",
        overflowPerGpuGb: 0,
        cpuOffloadGb: 0,
        kvOffloadingSize: 0,
        suggestions: ["Keep a runtime reserve."],
        apiKey: "memory-secret",
      },
    }],
    ["http://127.0.0.1:5176/api/security", {
      security: {
        lanMode: true,
        apiKeyEnforced: true,
        allowLanAdmin: false,
        corsMode: "allowlist",
        trustTokenActive: true,
        keyStore: { readable: true, apiKeyPreview: "entry-secret" },
        configIssues: [],
        warnings: [{ title: "Entry policy review", message: "Inspect D:\\secret\\entry" }],
      },
    }],
    ["http://127.0.0.1:5177/api/service-exposure", {
      settings: {
        enabled: true,
        exposureMode: "reverse-proxy",
        requireApiKey: true,
        rateLimitRpm: 30,
        maxConcurrentRequests: 2,
        apiKey: "manager-secret",
      },
      configHealth: { ok: true },
      actual: {
        manager: { remoteManagementAllowed: false, clientId: "manager-client-secret" },
        service: {
          boundHost: "0.0.0.0",
          dockerPublishedHosts: [],
          runtimeApiKeyRequired: false,
          running: true,
          root: "D:\\secret\\runtime",
        },
      },
      checks: [{ status: "warn", title: "Direct runtime exposure bypasses API key", detail: "token=exposure-secret" }],
    }],
    ["http://127.0.0.1:5178/api/service-exposure", {
      settings: {
        enabled: true,
        exposureMode: "reverse-proxy",
        requireApiKey: true,
        rateLimitRpm: 30,
        maxConcurrentRequests: 2,
      },
      configHealth: { ok: true },
      actual: {
        manager: { remoteManagementAllowed: false },
        service: { boundHost: "127.0.0.1", dockerPublishedHosts: [], runtimeApiKeyRequired: true, running: false },
      },
      checks: [{ status: "ok", title: "API key authentication is enabled" }],
    }],
  ]);
  const requests: Array<{ url: string; method: string; authorization: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const key = input instanceof URL ? input.href : String(input);
    const method = String(init?.method || "GET").toUpperCase();
    const authorization = new Headers(init?.headers).get("authorization") || "";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: key, method, authorization, body });
    const value = responses.get(method === "GET" ? key : `${method} ${key}`);
    return value === undefined ? jsonResponse({ error: "missing fixture" }, 404) : jsonResponse(value);
  };
  const client = new LocalPlatformClient(config(), new FixedHttpClient({ timeoutMs: 1000, maxResponseBytes: 1024 * 1024, fetchImpl }));

  it("combines overview sources without leaking manager paths or upstream URLs", async () => {
    const overview = await client.getOverview();
    assert.equal(overview.ok, true);
    assert.equal(overview.data.running_model_count, 1);
    assert.equal(overview.data.gpu?.allocatable_mb, 30);
    assert.equal(overview.data.search.mode, "hybrid");
    const rendered = JSON.stringify(overview);
    assert.equal(rendered.includes("D:\\secret"), false);
    assert.equal(rendered.includes("secret-upstream"), false);
  });

  it("paginates inventory and redacts credential-like log text", async () => {
    const output = await client.listLocalModels({ engine: "vllm", inventory: "local", limit: 1, offset: 0 });
    assert.equal(output.data.count, 1);
    assert.equal(output.data.models[0]?.issues[0]?.includes("supersecret"), false);
    assert.match(output.data.models[0]?.issues[0] || "", /token=\*\*\*/);
    assert.equal(JSON.stringify(output).includes("D:\\secret"), false);
  });

  it("performs authenticated web search while rejecting unsafe URLs and redacting snippets", async () => {
    const output = await client.searchWeb({
      query: "MCP v2",
      maxResults: 2,
      language: "en",
      timeRange: "month",
      engines: ["github"],
      categories: ["it"],
      safesearch: 1,
    });
    assert.equal(output.data.count, 1);
    assert.equal(output.data.results[0]?.url, "https://github.com/modelcontextprotocol/typescript-sdk");
    const rendered = JSON.stringify(output);
    assert.equal(rendered.includes("secret-search-backend"), false);
    assert.equal(rendered.includes("D:\\secret"), false);
    assert.equal(rendered.includes("result-secret"), false);
    assert.equal(rendered.includes("answer-secret"), false);
    assert.equal(rendered.includes("127.0.0.1"), false);
    assert.equal(rendered.includes("manager.internal"), false);
    const request = requests.find((item) => item.url.includes("/search?q=MCP+v2"));
    assert.equal(request?.authorization, "Bearer test-search-gateway-key-0123456789abcdef");
  });

  it("returns paginated job summaries without process, command, metadata, path, or credential fields", async () => {
    const output = await client.listJobs({ engine: "all", status: "failed", jobType: "serve", limit: 10, offset: 0 });
    assert.equal(output.data.count, 1);
    assert.equal(output.data.jobs[0]?.id, "serve-secret");
    assert.equal(output.data.jobs[0]?.progress_percent, 25);
    const rendered = JSON.stringify(output);
    assert.equal(rendered.includes("4242"), false);
    assert.equal(rendered.includes("powershell"), false);
    assert.equal(rendered.includes("job-api-secret"), false);
    assert.equal(rendered.includes("D:\\secret"), false);
    assert.equal(rendered.includes("job-secret"), false);
  });

  it("previews a route and estimates memory without leaking upstream-only fields", async () => {
    const route = await client.previewRoute({ model: "safe-model", engine: "auto", protocol: "openai", capability: "tools" });
    assert.equal(route.data.manager?.id, "vllm");
    assert.equal(route.data.model?.id, "safe-model");
    const routeText = JSON.stringify(route);
    assert.equal(routeText.includes("secret-preview"), false);
    assert.equal(routeText.includes("secret-client"), false);
    assert.equal(routeText.includes("D:\\secret"), false);

    const estimate = await client.estimateMemory({
      engine: "vllm",
      paramsB: 27,
      contextTokens: 32768,
      precision: "fp8_int8",
      bytesPerParam: null,
      parallelSequences: 2,
      gpuMemoryUtilization: 0.85,
      cpuOffloadGb: 0,
      kvOffloadGb: 0,
      speculativeMode: "off",
      speculativeTokens: 3,
    });
    assert.equal(estimate.data.status, "ok");
    assert.equal(estimate.data.bytes_per_param, 1);
    assert.equal(JSON.stringify(estimate).includes("memory-secret"), false);
    const request = requests.find((item) => item.url.endsWith("/api/memory-estimate"));
    assert.equal(request?.method, "POST");
    assert.equal((JSON.parse(request?.body || "{}") as { contextTokens?: number }).contextTokens, 65536);
  });

  it("combines exposure posture without returning raw hosts, client IDs, paths, or key previews", async () => {
    const output = await client.getSecurityPosture({ engine: "all", warningsOnly: true });
    assert.equal(output.data.overall, "warn");
    assert.equal(output.data.managers.find((manager) => manager.engine === "vllm")?.direct_runtime_exposed, true);
    assert.equal(output.data.managers.find((manager) => manager.engine === "llama")?.service_scope, "loopback");
    assert.equal(output.data.findings.some((finding) => finding.title === "Entry policy review"), true);
    const rendered = JSON.stringify(output);
    assert.equal(rendered.includes("0.0.0.0"), false);
    assert.equal(rendered.includes("entry-secret"), false);
    assert.equal(rendered.includes("manager-client-secret"), false);
    assert.equal(rendered.includes("D:\\secret"), false);
  });
});

describe("response safety primitives", () => {
  it("redacts bearer, provider, and named secret values", () => {
    const text = cleanText("Authorization: Bearer abc.def token=my-token hf_abcdefgh123456 sk-abcdefgh123456");
    assert.equal(text.includes("abc.def"), false);
    assert.equal(text.includes("my-token"), false);
    assert.equal(text.includes("hf_abcdefgh"), false);
    assert.equal(text.includes("sk-abcdefgh"), false);
  });

  it("removes secret-keyed fields recursively", () => {
    const value = redactUnknown({ ok: true, nested: { apiKey: "secret", label: "kept" } }) as Record<string, unknown>;
    assert.deepEqual(value, { ok: true, nested: { label: "kept" } });
  });

  it("rejects oversized upstream responses", async () => {
    const http = new FixedHttpClient({
      timeoutMs: 1000,
      maxResponseBytes: 20,
      fetchImpl: async () => jsonResponse({ value: "x".repeat(100) }),
    });
    await assert.rejects(http.getJson("test", new URL("http://127.0.0.1:9999"), "/data"), /safety limit/);
  });

  it("rejects protocol-relative upstream paths before making a request", async () => {
    const http = new FixedHttpClient({
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    await assert.rejects(http.getJson("test", new URL("http://127.0.0.1:9999"), "//attacker.example/data"), /absolute path/);
  });
});
