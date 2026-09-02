import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Server } from "node:http";
import { describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NoopAuditLogger } from "../src/audit.js";
import { createPlatformMcpApp } from "../src/app.js";
import type { PlatformMcpConfig } from "../src/config.js";
import { FixturePlatformDataSource } from "./fixtures.js";

const API_KEY = "evaluation-platform-mcp-key-0123456789";

function evaluationConfig(): PlatformMcpConfig {
  return {
    host: "127.0.0.1",
    port: 5190,
    apiKey: API_KEY,
    requireAuth: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    aiRoot: "D:\\AI",
    serviceEntryUrl: new URL("http://127.0.0.1:5176"),
    managers: [{ id: "vllm", name: "vLLM Manager", baseUrl: new URL("http://127.0.0.1:5177") }, {
      id: "llama", name: "llama.cpp Manager", baseUrl: new URL("http://127.0.0.1:5178"),
    }],
    searchGatewayUrl: new URL("http://127.0.0.1:5180"),
    searchGatewayApiKey: "evaluation-search-gateway-key-0123456789",
    searchRateLimitPerMinute: 20,
    timeoutMs: 1000,
    maxResponseChars: 25000,
    maxUpstreamBytes: 1024 * 1024,
    auditLogPath: "D:\\AI\\audit-logs\\platform-mcp-evaluation.jsonl",
  };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name} returned a tool error`);
  return result.structuredContent as T;
}

describe("stable MCP evaluation answers", () => {
  it("solves and verifies all ten read-only questions through MCP tools", async () => {
    const mcp = createPlatformMcpApp({
      config: evaluationConfig(),
      dataSource: new FixturePlatformDataSource(),
      auditLogger: new NoopAuditLogger(),
    });
    let httpServer: Server;
    const endpoint = await new Promise<URL>((resolveUrl) => {
      httpServer = serve({ fetch: mcp.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        resolveUrl(new URL(`http://127.0.0.1:${info.port}/mcp`));
      }) as Server;
    });
    const client = new Client({ name: "evaluation-verifier", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${API_KEY}` } },
    });
    await client.connect(transport);

    try {
      const overview = await call<any>(client, "local_ai_get_overview");
      const running = await call<any>(client, "local_ai_list_running_models", { engine: "all" });
      const gpu = await call<any>(client, "local_ai_get_gpu_status");
      const performance = await call<any>(client, "local_ai_get_performance", { engine: "all", include_models: true });
      const diagnostics = await call<any>(client, "local_ai_get_diagnostics", { engine: "all", warnings_only: true });
      const search = await call<any>(client, "local_ai_get_search_health");
      const webSearch = await call<any>(client, "local_ai_search_web", {
        query: "Model Context Protocol TypeScript SDK v2",
        max_results: 1,
        engines: ["github"],
      });
      const jobs = await call<any>(client, "local_ai_list_jobs", {
        engine: "vllm",
        status: "failed",
        job_type: "serve",
      });
      const route = await call<any>(client, "local_ai_preview_route", {
        model: "qwen-qwen3.8-27b-fp8",
        capability: "tools",
      });
      const memory = await call<any>(client, "local_ai_estimate_memory", {
        engine: "vllm",
        params_b: 27,
        context_tokens: 32768,
        precision: "fp8_int8",
      });
      const security = await call<any>(client, "local_ai_get_security_posture", {
        engine: "all",
        warnings_only: true,
      });

      const localModels: any[] = [];
      let offset = 0;
      do {
        const page = await call<any>(client, "local_ai_list_local_models", {
          engine: "all", inventory: "local", limit: 1, offset,
        });
        localModels.push(...page.data.models);
        if (!page.data.has_more) break;
        offset = page.data.next_offset;
      } while (offset !== null);

      const runningByEngine = new Map(running.data.instances.map((instance: any) => [instance.engine, instance.models.length]));
      const idleOnlineEngine = overview.data.managers.find((manager: any) => manager.online && (runningByEngine.get(manager.id) || 0) === 0)?.id;
      const warnedModel = localModels.find((model) => model.verification_status === "warn")?.id;
      const onlyRunningModel = running.data.instances.flatMap((instance: any) => instance.models)[0];
      const vllmPerf = performance.data.managers.find((manager: any) => manager.engine === "vllm");
      const warnedIdle = diagnostics.data.managers.find((manager: any) => manager.checks.length > 0 && (runningByEngine.get(manager.engine) || 0) === 0)?.engine;
      const hitRate = Math.round((Number(vllmPerf.cache.prefixHits) / Number(vllmPerf.cache.prefixQueries)) * 100);

      assert.equal(vllmPerf.facts.maxModelLen, onlyRunningModel.max_model_len);
      assert.equal(overview.data.gpu.allocatable_mb, gpu.data.gpu.allocatable_mb);
      assert.equal(overview.data.search.mode, search.data.search.mode);
      assert.equal(search.data.search.healthy, true);
      assert.equal(search.data.search.auth_required, true);
      assert.equal(memory.data.free_gpu_gb, gpu.data.gpu.free_mb / 1024);
      assert.equal(route.data.selected, true);

      const derivedAnswers = [
        idleOnlineEngine,
        warnedModel,
        String(onlyRunningModel.max_model_len),
        webSearch.data.results[0]?.title,
        jobs.data.jobs[0]?.id,
        route.data.manager?.id,
        memory.data.status,
        warnedIdle,
        security.data.overall,
        `${hitRate}%`,
      ];

      const currentDir = dirname(fileURLToPath(import.meta.url));
      const xmlPath = resolve(currentDir, "..", "..", "evaluation", "evaluation.xml");
      const xml = await readFile(xmlPath, "utf8");
      const expectedAnswers = [...xml.matchAll(/<answer>([^<]+)<\/answer>/g)].map((match) => match[1]);
      assert.equal(expectedAnswers.length, 10);
      assert.deepEqual(derivedAnswers, expectedAnswers);
    } finally {
      await client.close();
      await mcp.close();
      await new Promise<void>((resolveClose, reject) => httpServer.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
