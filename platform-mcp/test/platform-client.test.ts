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
    },
  });
}

describe("configuration boundaries", () => {
  it("accepts loopback upstreams and a strong HTTP key", () => {
    const value = config();
    assert.equal(value.host, "127.0.0.1");
    assert.equal(value.port, 5190);
    assert.equal(value.allowedHosts.includes("host.docker.internal"), true);
  });

  it("rejects non-loopback binds, upstreams, weak keys, and escaped audit paths", () => {
    assert.throws(() => loadConfig({ env: { PLATFORM_MCP_HOST: "0.0.0.0", PLATFORM_MCP_API_KEY: "x".repeat(40) } }), /loopback/);
    assert.throws(() => loadConfig({ env: { PLATFORM_MCP_API_KEY: "x".repeat(40), PLATFORM_MCP_SERVICE_ENTRY_URL: "http://192.168.1.9:5176" } }), /loopback/);
    assert.throws(() => loadConfig({ env: { PLATFORM_MCP_API_KEY: "weak" } }), /32 characters/);
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
    ["http://127.0.0.1:5177/api/models", { local: [{ id: "safe-model", label: "Safe Model", path: "D:\\secret\\model", size: 1234, modified: "2026-08-14T00:00:00.000Z", modelFormat: "safetensors", runnable: true, verificationStatus: "warn", verificationIssues: [{ title: "Credential", detail: "token=supersecret" }] }], cached: [] }],
    ["http://127.0.0.1:5178/api/models", { local: [], cached: [] }],
  ]);
  const fetchImpl: typeof fetch = async (input) => {
    const key = input instanceof URL ? input.href : String(input);
    const value = responses.get(key);
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
});
