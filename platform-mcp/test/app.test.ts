import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NoopAuditLogger } from "../src/audit.js";
import { createPlatformMcpApp } from "../src/app.js";
import type { PlatformMcpConfig } from "../src/config.js";
import { SERVER_VERSION, TOOL_NAMES } from "../src/constants.js";
import { SearchRateLimiter } from "../src/tools.js";
import { FixturePlatformDataSource } from "./fixtures.js";

const API_KEY = "test-platform-mcp-key-0123456789abcdef";

function testConfig(): PlatformMcpConfig {
  return {
    host: "127.0.0.1",
    port: 5190,
    apiKey: API_KEY,
    requireAuth: true,
    allowedHosts: ["127.0.0.1", "localhost", "::1", "host.docker.internal"],
    aiRoot: "D:\\AI",
    serviceEntryUrl: new URL("http://127.0.0.1:5176"),
    managers: [{ id: "vllm", name: "vLLM Manager", baseUrl: new URL("http://127.0.0.1:5177") }, {
      id: "llama", name: "llama.cpp Manager", baseUrl: new URL("http://127.0.0.1:5178"),
    }],
    searchGatewayUrl: new URL("http://127.0.0.1:5180"),
    searchGatewayApiKey: "test-search-gateway-key-0123456789abcdef",
    searchRateLimitPerMinute: 20,
    timeoutMs: 1000,
    maxResponseChars: 25000,
    maxUpstreamBytes: 1024 * 1024,
    auditLogPath: "D:\\AI\\audit-logs\\platform-mcp-test.jsonl",
  };
}

describe("HTTP security guards", () => {
  const mcp = createPlatformMcpApp({
    config: testConfig(),
    dataSource: new FixturePlatformDataSource(),
    auditLogger: new NoopAuditLogger(),
  });

  after(async () => mcp.close());

  it("exposes only a safe unauthenticated health response", async () => {
    const response = await mcp.app.request("http://127.0.0.1:5190/health", {
      headers: { host: "127.0.0.1:5190" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.version, SERVER_VERSION);
    assert.equal(body.auth_required, true);
    assert.equal(JSON.stringify(body).includes(API_KEY), false);
  });

  it("publishes a redacted 0.5.0 capability manifest after authentication", async () => {
    const response = await mcp.app.request("http://127.0.0.1:5190/info", {
      headers: { host: "127.0.0.1:5190", authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      version: string;
      tools: string[];
      policy: Record<string, unknown>;
    };
    assert.equal(body.version, SERVER_VERSION);
    assert.deepEqual(body.tools, [...TOOL_NAMES]);
    assert.equal(body.policy.read_only, true);
    assert.equal(body.policy.web_search, true);
    assert.equal(JSON.stringify(body).includes(API_KEY), false);
  });

  it("requires bearer authentication on MCP and info endpoints", async () => {
    const info = await mcp.app.request("http://127.0.0.1:5190/info", {
      headers: { host: "127.0.0.1:5190" },
    });
    const protocol = await mcp.app.request("http://127.0.0.1:5190/mcp", {
      method: "POST",
      headers: { host: "127.0.0.1:5190", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(info.status, 401);
    assert.equal(protocol.status, 401);
    assert.match(protocol.headers.get("www-authenticate") || "", /^Bearer/i);
  });

  it("rejects untrusted Host and Origin values", async () => {
    const badHost = await mcp.app.request("http://127.0.0.1:5190/health", {
      headers: { host: "attacker.example" },
    });
    const badOrigin = await mcp.app.request("http://127.0.0.1:5190/health", {
      headers: { host: "127.0.0.1:5190", origin: "https://attacker.example" },
    });
    assert.equal(badHost.status, 403);
    assert.equal(badOrigin.status, 403);
  });
});

describe("dual-era MCP protocol", () => {
  const mcp = createPlatformMcpApp({
    config: testConfig(),
    dataSource: new FixturePlatformDataSource(),
    auditLogger: new NoopAuditLogger(),
  });
  let httpServer: Server;
  let endpoint: URL;

  before(async () => {
    endpoint = await new Promise<URL>((resolve) => {
      httpServer = serve({ fetch: mcp.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        resolve(new URL(`http://127.0.0.1:${info.port}/mcp`));
      }) as Server;
    });
  });

  after(async () => {
    await mcp.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  });

  function transport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "x-mcp-client-id": "node-integration-test",
        },
      },
    });
  }

  it("serves legacy 2025 clients with sixteen read-only tools", async () => {
    const client = new Client({ name: "legacy-test", version: "1.0.0" });
    await client.connect(transport());
    try {
      assert.equal(client.getProtocolEra(), "legacy");
      const listing = await client.listTools();
      assert.equal(listing.tools.length, 16);
      assert.deepEqual(listing.tools.map((tool) => tool.name), [...TOOL_NAMES]);
      assert.equal(listing.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
      assert.equal(listing.tools.every((tool) => tool.annotations?.destructiveHint === false), true);
      assert.deepEqual(
        listing.tools.filter((tool) => tool.annotations?.openWorldHint === true).map((tool) => tool.name),
        ["local_ai_search_web", "local_ai_research_web", "local_ai_open_web_page", "local_ai_read_search_result", "local_ai_find_in_search_result"],
      );

      const result = await client.callTool({ name: "local_ai_get_overview", arguments: {} });
      const structured = result.structuredContent as { data: { running_model_count: number } };
      assert.equal(structured.data.running_model_count, 1);
      assert.equal(result.isError, undefined);
    } finally {
      await client.close();
    }
  });

  it("negotiates and serves the 2026-07-28 protocol", async () => {
    const client = new Client(
      { name: "modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport());
    try {
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      const result = await client.callTool({
        name: "local_ai_list_local_models",
        arguments: { engine: "vllm", inventory: "local", limit: 1, offset: 1, response_format: "json" },
      });
      const structured = result.structuredContent as { data: { count: number; has_more: boolean; models: Array<{ id: string }> } };
      assert.equal(structured.data.count, 1);
      assert.equal(structured.data.has_more, false);
      assert.equal(structured.data.models[0]?.id, "RadixArk-Qwen3.8-27B-DSpark");

      const search = await client.callTool({
        name: "local_ai_search_web",
        arguments: { query: "Model Context Protocol SDK v2", max_results: 1 },
      });
      const searchData = search.structuredContent as { data: { count: number; results: Array<{ url: string }> } };
      assert.equal(searchData.data.count, 1);
      assert.match(searchData.data.results[0]?.url || "", /^https:\/\//);

      const research = await client.callTool({
        name: "local_ai_research_web",
        arguments: {
          queries: [{ id: "sdk", query: "Model Context Protocol TypeScript SDK" }, { id: "spec", query: "MCP 2026 specification" }],
          max_sources: 8,
        },
      });
      const researchData = research.structuredContent as {
        data: { search_id: string; query_coverage: unknown[]; results: Array<{ result_id: string }> };
      };
      assert.equal(researchData.data.query_coverage.length, 2);
      assert.equal(researchData.data.results[0]?.result_id, "r1");

      const opened = await client.callTool({
        name: "local_ai_open_web_page",
        arguments: { urls: ["https://modelcontextprotocol.io/specification/2026-07-28"] },
      });
      const openedData = opened.structuredContent as { data: { readable_count: number; documents: Array<{ request_id: string; content: string }> } };
      assert.equal(openedData.data.readable_count, 1);
      assert.equal(openedData.data.documents[0]?.request_id, "u1");
      assert.match(openedData.data.documents[0]?.content || "", /public page content/i);

      const read = await client.callTool({
        name: "local_ai_read_search_result",
        arguments: { search_id: researchData.data.search_id, result_ids: ["r1"], max_chars_per_result: 2000 },
      });
      const readData = read.structuredContent as { data: { readable_count: number; documents: Array<{ content: string }> } };
      assert.equal(readData.data.readable_count, 1);
      assert.match(readData.data.documents[0]?.content || "", /stable v2 SDK/i);

      const find = await client.callTool({
        name: "local_ai_find_in_search_result",
        arguments: { search_id: researchData.data.search_id, result_id: "r1", pattern: "stable v2 SDK" },
      });
      const findData = find.structuredContent as { data: { match_count: number; matches: Array<{ context: string }> } };
      assert.equal(findData.data.match_count, 1);
      assert.match(findData.data.matches[0]?.context || "", /2026-07-28 MCP specification/i);

      const jobs = await client.callTool({
        name: "local_ai_list_jobs",
        arguments: { engine: "vllm", status: "failed", job_type: "serve" },
      });
      assert.equal((jobs.structuredContent as { data: { jobs: Array<{ id: string }> } }).data.jobs[0]?.id, "serve-1");

      const route = await client.callTool({
        name: "local_ai_preview_route",
        arguments: { model: "qwen-qwen3.8-27b-fp8", capability: "tools" },
      });
      assert.equal((route.structuredContent as { data: { manager: { id: string } } }).data.manager.id, "vllm");

      const memory = await client.callTool({
        name: "local_ai_estimate_memory",
        arguments: { engine: "vllm", params_b: 27, context_tokens: 32768, precision: "fp8_int8" },
      });
      assert.equal((memory.structuredContent as { data: { status: string } }).data.status, "ok");

      const security = await client.callTool({
        name: "local_ai_get_security_posture",
        arguments: { warnings_only: true },
      });
      assert.equal((security.structuredContent as { data: { overall: string } }).data.overall, "warn");
    } finally {
      await client.close();
    }
  });

  it("rejects invalid tool arguments before invoking platform data", async () => {
    const client = new Client({ name: "validation-test", version: "1.0.0" });
    await client.connect(transport());
    try {
      const result = await client.callTool({ name: "local_ai_list_local_models", arguments: { limit: 5000 } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /invalid|limit|arguments/i);

      const invalidMemory = await client.callTool({
        name: "local_ai_estimate_memory",
        arguments: { engine: "vllm", params_b: 27, precision: "custom" },
      });
      assert.equal(invalidMemory.isError, true);
      assert.match(JSON.stringify(invalidMemory.content), /bytes_per_param|required|invalid/i);

      const privatePage = await client.callTool({
        name: "local_ai_open_web_page",
        arguments: { urls: ["http://127.0.0.1:5177/api/status"] },
      });
      assert.equal(privatePage.isError, true);
      assert.match(JSON.stringify(privatePage.content), /public|private|local|invalid/i);
    } finally {
      await client.close();
    }
  });
});

describe("web-search rate limiting", () => {
  it("uses an independent fixed window per MCP client", () => {
    const limiter = new SearchRateLimiter(1);
    assert.deepEqual(limiter.consume("client-a", 1_000), { ok: true });
    assert.deepEqual(limiter.consume("client-b", 1_001), { ok: true });
    assert.deepEqual(limiter.consume("client-a", 2_000), { ok: false, retryAfterSeconds: 59 });
    assert.deepEqual(limiter.consume("client-a", 61_000), { ok: true });
  });

  it("enforces a server-wide ceiling when callers rotate client IDs", () => {
    const limiter = new SearchRateLimiter(1);
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual(limiter.consume(`rotating-${index}`, 1_000 + index), { ok: true });
    }
    assert.deepEqual(limiter.consume("rotating-4", 2_000), { ok: false, retryAfterSeconds: 59 });
    assert.deepEqual(limiter.consume("rotating-5", 61_000), { ok: true });
  });

  it("charges multi-query and multi-page workflows by bounded work units", () => {
    const limiter = new SearchRateLimiter(5);
    assert.deepEqual(limiter.consume("research-client", 1_000, 4), { ok: true });
    assert.deepEqual(limiter.consume("research-client", 2_000, 2), { ok: false, retryAfterSeconds: 59 });
    assert.deepEqual(limiter.consume("research-client", 2_500, 1), { ok: true });
  });
});
