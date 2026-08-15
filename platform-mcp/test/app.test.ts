import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NoopAuditLogger } from "../src/audit.js";
import { createPlatformMcpApp } from "../src/app.js";
import type { PlatformMcpConfig } from "../src/config.js";
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
    assert.equal(body.auth_required, true);
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

  it("serves legacy 2025 clients with seven read-only tools", async () => {
    const client = new Client({ name: "legacy-test", version: "1.0.0" });
    await client.connect(transport());
    try {
      assert.equal(client.getProtocolEra(), "legacy");
      const listing = await client.listTools();
      assert.equal(listing.tools.length, 7);
      assert.equal(listing.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
      assert.equal(listing.tools.every((tool) => tool.annotations?.destructiveHint === false), true);

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
    } finally {
      await client.close();
    }
  });
});
