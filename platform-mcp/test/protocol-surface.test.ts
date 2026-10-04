import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NoopAuditLogger } from "../src/audit.js";
import { createPlatformMcpApp } from "../src/app.js";
import type { PlatformMcpConfig } from "../src/config.js";
import { OPS_TOOL_NAMES, TOOL_NAMES, WEB_TOOL_NAMES } from "../src/constants.js";
import type { PlatformDataSource } from "../src/platform-client.js";
import { UpstreamRequestError } from "../src/http-client.js";
import { FixturePlatformDataSource, HOSTILE_PAGE_TEXT } from "./fixtures.js";

const API_KEY = "test-platform-mcp-key-0123456789abcdef";

function testConfig(overrides: Partial<PlatformMcpConfig> = {}): PlatformMcpConfig {
  return {
    host: "127.0.0.1",
    port: 5190,
    apiKey: API_KEY,
    requireAuth: true,
    allowedHosts: ["127.0.0.1", "localhost", "::1", "host.docker.internal"],
    aiRoot: "D:\\AI",
    serviceEntryUrl: new URL("http://127.0.0.1:5176"),
    managers: [
      { id: "vllm", name: "vLLM Manager", baseUrl: new URL("http://127.0.0.1:5177") },
      { id: "llama", name: "llama.cpp Manager", baseUrl: new URL("http://127.0.0.1:5178") },
    ],
    searchGatewayUrl: new URL("http://127.0.0.1:5180"),
    searchGatewayApiKey: "test-search-gateway-key-0123456789abcdef",
    searchRateLimitPerMinute: 20,
    localRateLimitPerMinute: 120,
    timeoutMs: 1000,
    maxResponseChars: 25000,
    maxUpstreamBytes: 1024 * 1024,
    cacheTtlMs: 0,
    outputSchemaDetail: "compact",
    toolProfile: "all",
    auditLogPath: "D:\\AI\\audit-logs\\platform-mcp-test.jsonl",
    ...overrides,
  };
}

/** Boots the real HTTP handler and hands back a connected MCP client. */
function harness(options: {
  config?: Partial<PlatformMcpConfig>;
  dataSource?: PlatformDataSource;
  clientId?: string;
} = {}) {
  const mcp = createPlatformMcpApp({
    config: testConfig(options.config),
    dataSource: options.dataSource ?? new FixturePlatformDataSource(),
    auditLogger: new NoopAuditLogger(),
  });
  let httpServer: Server;
  let endpoint: URL;
  const clients: Client[] = [];

  return {
    async start() {
      endpoint = await new Promise<URL>((resolve) => {
        httpServer = serve({ fetch: mcp.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
          resolve(new URL(`http://127.0.0.1:${info.port}/mcp`));
        }) as Server;
      });
    },
    async stop() {
      for (const client of clients) await client.close().catch(() => {});
      await mcp.close();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    },
    endpoint: () => endpoint,
    async connect(clientId = options.clientId ?? "surface-test") {
      const client = new Client({ name: clientId, version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${API_KEY}`, "x-mcp-client-id": clientId } },
      }));
      clients.push(client);
      return client;
    },
  };
}

type ToolErrorPayload = {
  ok: boolean;
  error: {
    tool: string;
    category: string;
    retryable: boolean;
    retry_after_seconds: number | null;
    message: string;
    guidance: string;
    service: string | null;
    upstream_status: number | null;
  };
};

describe("tool profiles over the wire", () => {
  const kit = harness({ config: { toolProfile: "ops" } });
  before(() => kit.start());
  after(() => kit.stop());

  it("registers only the local tools, so the web schemas are not paid for", async () => {
    const client = await kit.connect();
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name), [...OPS_TOOL_NAMES]);
    assert.equal(listing.tools.some((tool) => tool.annotations?.openWorldHint === true), false);
  });

  it("refuses a tool the profile left out instead of answering it", async () => {
    const client = await kit.connect();
    await assert.rejects(
      () => client.callTool({ name: "local_ai_search_web", arguments: { query: "anything" } }),
      /local_ai_search_web/,
    );
  });

  it("reports the active profile in the capability manifest", async () => {
    const response = await fetch(new URL("/info", kit.endpoint()), {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const body = await response.json() as { tools: string[]; policy: Record<string, unknown> };
    assert.deepEqual(body.tools, [...OPS_TOOL_NAMES]);
    assert.equal(body.policy.tool_profile, "ops");
    assert.equal(body.policy.web_search, false, "the manifest must not advertise a tool it did not register");
  });
});

describe("compact output schemas over the wire", () => {
  const kit = harness();
  before(() => kit.start());
  after(() => kit.stop());

  it("advertises a schema small enough to be worth sending every session", async () => {
    const client = await kit.connect();
    const listing = await client.listTools();
    const total = listing.tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
    const schemas = listing.tools.reduce((sum, tool) => sum + JSON.stringify(tool.outputSchema ?? {}).length, 0);
    // Before this change: 16 tools, 77,433 characters, 44,985 of them output
    // schemas. The guard is loose enough to survive new tools and tight
    // enough to catch a regression back to fully expanded schemas.
    assert.ok(total < 70_000, `manifest grew to ${total} characters`);
    assert.ok(schemas < total * 0.4, `output schemas are ${schemas} of ${total} characters`);
  });

  it("still validates the payload it returns against the advertised root", async () => {
    const client = await kit.connect();
    const result = await client.callTool({ name: "local_ai_get_overview", arguments: {} });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { data: { running_model_count: number } };
    assert.equal(structured.data.running_model_count, 1);
  });

  it("states the payload shape in the description, where the schema used to", async () => {
    const client = await kit.connect();
    const listing = await client.listTools();
    const overview = listing.tools.find((tool) => tool.name === "local_ai_get_overview");
    assert.match(String(overview?.description), /Returns data=\{service_entry,managers,/);
  });

  it("sends the payload once when the caller asks for the structured channel", async () => {
    const client = await kit.connect();
    const result = await client.callTool({
      name: "local_ai_get_overview",
      arguments: { response_format: "structured" },
    });
    const text = String((result.content as Array<{ text: string }>)[0]?.text);
    assert.match(text, /see structuredContent/);
    assert.ok(text.length < 120, `text channel carried ${text.length} characters`);
    assert.ok(result.structuredContent, "the payload is still delivered");
  });
});

describe("failures an agent can act on", () => {
  class FailingDataSource extends FixturePlatformDataSource {
    constructor(private readonly failure: unknown) {
      super();
    }

    override async getOverview(): Promise<never> {
      throw this.failure;
    }
  }

  async function categoryFor(failure: unknown): Promise<ToolErrorPayload["error"]> {
    const kit = harness({ dataSource: new FailingDataSource(failure) });
    await kit.start();
    try {
      const client = await kit.connect();
      const result = await client.callTool({ name: "local_ai_get_overview", arguments: {} });
      assert.equal(result.isError, true);
      return (result.structuredContent as ToolErrorPayload).error;
    } finally {
      await kit.stop();
    }
  }

  it("tells a caller to wait when a manager is slow, not to give up", async () => {
    const error = await categoryFor(new UpstreamRequestError("vLLM Manager", "timed out after 1000 ms", 0, "timeout"));
    assert.equal(error.category, "timeout");
    assert.equal(error.retryable, true);
    assert.equal(error.service, "vLLM Manager");
  });

  it("tells a caller not to retry a request the service rejected", async () => {
    const error = await categoryFor(new UpstreamRequestError("vLLM Manager", "returned HTTP 400.", 400));
    assert.equal(error.category, "upstream_rejected");
    assert.equal(error.retryable, false);
    assert.equal(error.upstream_status, 400);
  });

  it("names the tool and carries advice in both channels", async () => {
    const kit = harness({ dataSource: new FailingDataSource(new Error("something broke")) });
    await kit.start();
    try {
      const client = await kit.connect();
      const result = await client.callTool({ name: "local_ai_get_overview", arguments: {} });
      const text = String((result.content as Array<{ text: string }>)[0]?.text);
      assert.match(text, /^local_ai_get_overview failed \(unknown\)\./);
      assert.match(text, /Not retryable as called\./);
      const structured = result.structuredContent as ToolErrorPayload;
      assert.equal(structured.ok, false, "a failure never reports ok");
      assert.equal(structured.error.tool, "local_ai_get_overview");
      assert.ok(structured.error.guidance.length > 20);
    } finally {
      await kit.stop();
    }
  });
});

describe("local read rate limit", () => {
  const kit = harness({ config: { localRateLimitPerMinute: 10 } });
  before(() => kit.start());
  after(() => kit.stop());

  it("bounds the local tools that used to have no limit at all", async () => {
    const client = await kit.connect("local-limit-test");
    let limited: ToolErrorPayload["error"] | null = null;
    for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
      const result = await client.callTool({ name: "local_ai_get_gpu_status", arguments: {} });
      if (result.isError) limited = (result.structuredContent as ToolErrorPayload).error;
    }
    assert.ok(limited, "the local bucket must eventually refuse");
    assert.equal(limited!.category, "rate_limited");
    assert.equal(limited!.retryable, true);
    assert.ok((limited!.retry_after_seconds ?? 0) > 0, "the caller is told how long to wait");
    assert.match(limited!.message, /local read rate limit/);
  });

  it("keeps the web bucket separate, so local reads cannot exhaust search", async () => {
    const client = await kit.connect("separate-bucket-test");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await client.callTool({ name: "local_ai_get_gpu_status", arguments: {} });
    }
    const search = await client.callTool({ name: "local_ai_search_web", arguments: { query: "mcp sdk" } });
    assert.equal(search.isError, undefined, "web search has its own budget");
  });
});

describe("resources and prompts", () => {
  const kit = harness();
  before(() => kit.start());
  after(() => kit.stop());

  it("publishes the read-only boundary as a resource, not only as prose in descriptions", async () => {
    const client = await kit.connect();
    const listing = await client.listResources();
    assert.deepEqual(
      listing.resources.map((resource) => resource.uri).sort(),
      ["localai://platform/overview", "localai://platform/policy", "localai://platform/running-models"],
    );
    const policy = await client.readResource({ uri: "localai://platform/policy" });
    const body = JSON.parse(String((policy.contents[0] as { text: string }).text)) as Record<string, unknown>;
    assert.equal(body.read_only, true);
    assert.equal(body.shell_access, false);
    assert.equal(body.file_access, false);
    assert.deepEqual(body.tools, [...TOOL_NAMES]);
  });

  it("serves the current platform state without spending a tool call", async () => {
    const client = await kit.connect();
    const resource = await client.readResource({ uri: "localai://platform/overview" });
    const body = JSON.parse(String((resource.contents[0] as { text: string }).text)) as {
      data: { running_model_count: number };
    };
    assert.equal(body.data.running_model_count, 1);
  });

  it("offers the multi-tool walks the descriptions only hint at", async () => {
    const client = await kit.connect();
    const listing = await client.listPrompts();
    assert.deepEqual(
      listing.prompts.map((prompt) => prompt.name).sort(),
      ["local_ai_capacity_check", "local_ai_config_regression", "local_ai_health_review"],
    );
    const prompt = await client.getPrompt({
      name: "local_ai_capacity_check",
      arguments: { model: "Qwen-Qwen3.8-27B-FP8", params_b: "27", context_tokens: "32768" },
    });
    const text = String((prompt.messages[0]?.content as { text: string }).text);
    assert.match(text, /local_ai_get_gpu_status/);
    assert.match(text, /local_ai_estimate_memory/);
    assert.match(text, /params_b=27/);
    assert.match(text, /context_tokens=32768/);
    // A released runtime's memory is free only while it stays released, and a
    // capacity answer that ignores that is wrong.
    assert.match(text, /local_ai_get_idle_state/);
  });

  it("tells the caller not to claim it applied a fix a read-only tool cannot apply", async () => {
    const client = await kit.connect();
    const prompt = await client.getPrompt({ name: "local_ai_health_review", arguments: { engine: "all" } });
    const text = String((prompt.messages[0]?.content as { text: string }).text);
    assert.match(text, /read-only: propose fixes, do not claim to have applied any/);
  });
});

describe("benchmark history and idle state tools", () => {
  const kit = harness();
  before(() => kit.start());
  after(() => kit.stop());

  it("lists recorded runs with the configuration each was measured against", async () => {
    const client = await kit.connect();
    const result = await client.callTool({
      name: "local_ai_list_benchmarks",
      arguments: { model: "Qwen-Qwen3.8-27B-FP8" },
    });
    const data = (result.structuredContent as {
      data: { total: number; runs: Array<{ id: string; config: Record<string, unknown> }> };
    }).data;
    assert.equal(data.total, 2);
    assert.equal(data.runs[0]?.id, "bench-2", "newest first");
    assert.equal(data.runs[0]?.config.maxNumSeqs, 64);
  });

  it("reports what differed and what it did to the numbers", async () => {
    const client = await kit.connect();
    const result = await client.callTool({
      name: "local_ai_compare_benchmarks",
      arguments: { run_ids: ["bench-1", "bench-2"] },
    });
    const data = (result.structuredContent as {
      data: {
        baseline_id: string;
        differing_config: Array<{ key: string; values: Array<{ run_id: string; value: unknown }> }>;
        metrics: Array<{ key: string; better: string; values: Array<{ run_id: string; improved: boolean | null }> }>;
      };
    }).data;
    assert.equal(data.baseline_id, "bench-1", "the first ID is the baseline");
    assert.deepEqual(data.differing_config.map((entry) => entry.key), ["maxNumSeqs"], "only the variable is shown");
    const throughput = data.metrics.find((metric) => metric.key === "wallTokensPerSecond");
    assert.equal(throughput?.better, "higher");
    assert.equal(throughput?.values.find((value) => value.run_id === "bench-2")?.improved, true);
    const ttft = data.metrics.find((metric) => metric.key === "avgTtftMs");
    assert.equal(ttft?.better, "lower");
    // The same run got faster overall and slower to first token; a comparison
    // that reported one direction for both would mislead.
    assert.equal(ttft?.values.find((value) => value.run_id === "bench-2")?.improved, false);
  });

  it("names run IDs it could not find instead of silently comparing fewer runs", async () => {
    const client = await kit.connect();
    const result = await client.callTool({
      name: "local_ai_compare_benchmarks",
      arguments: { run_ids: ["bench-1", "bench-404"] },
    });
    const payload = result.structuredContent as {
      partial: boolean;
      warnings: string[];
      data: { missing_run_ids: string[] };
    };
    assert.deepEqual(payload.data.missing_run_ids, ["bench-404"]);
    assert.equal(payload.partial, true);
    assert.ok(payload.warnings.some((warning) => warning.includes("missing_run_ids")));
  });

  it("reports released runtimes and whether each can be restored", async () => {
    const client = await kit.connect();
    const result = await client.callTool({ name: "local_ai_get_idle_state", arguments: {} });
    const data = (result.structuredContent as {
      data: {
        released_count: number;
        released_vram_mb: number;
        engines: Array<{ engine: string; enabled: boolean; idle_minutes: number | null }>;
        released: Array<{ model: string; restorable: boolean }>;
      };
    }).data;
    assert.equal(data.released_count, 1);
    assert.equal(data.released_vram_mb, 18432);
    assert.equal(data.released[0]?.restorable, true);
    assert.equal(data.engines.find((entry) => entry.engine === "vllm")?.enabled, true);
    assert.equal(data.engines.find((entry) => entry.engine === "llama")?.enabled, false);
  });

  it("stays read-only: there is no tool that wakes a released runtime", async () => {
    const client = await kit.connect();
    const listing = await client.listTools();
    assert.equal(
      listing.tools.some((tool) => /wake|restore|start|stop|release/.test(tool.name)),
      false,
    );
    assert.equal(listing.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
    assert.equal(
      [...WEB_TOOL_NAMES, ...OPS_TOOL_NAMES].length,
      listing.tools.length,
      "every registered tool belongs to a declared group",
    );
  });
});

describe("untrusted page content", () => {
  const kit = harness();
  before(() => kit.start());
  after(() => kit.stop());

  async function hostilePage() {
    const client = await kit.connect();
    return client.callTool({
      name: "local_ai_open_web_page",
      arguments: { urls: ["https://example.com/hostile"] },
    });
  }

  it("keeps an injected instruction inside the content field, where it is data", async () => {
    const result = await hostilePage();
    const payload = result.structuredContent as {
      ok: boolean;
      warnings: string[];
      data: { documents: Array<{ content: string }> };
    };
    assert.equal(payload.ok, true, "the page's own text must not decide the envelope");
    assert.equal(payload.data.documents[0]?.content, HOSTILE_PAGE_TEXT);
    assert.match(payload.data.documents[0]!.content, /Ignore all previous instructions/);
  });

  it("does not let the page forge a warning or flip the envelope", async () => {
    const result = await hostilePage();
    const payload = result.structuredContent as { ok: boolean; warnings: string[] };
    assert.equal(
      payload.warnings.some((warning) => /pre-authorized|lifecycle mutations are now permitted/i.test(warning)),
      false,
      "warnings come from the server, never from the page",
    );
    assert.ok(payload.warnings.some((warning) => /untrusted external content/i.test(warning)));
  });

  it("does not let a fenced block in the page break out of the text channel", async () => {
    const result = await hostilePage();
    const text = String((result.content as Array<{ text: string }>)[0]?.text);
    const fences = text.split("```").length - 1;
    assert.equal(fences, 2, `the payload must sit in exactly one fenced block, found ${fences} fence markers`);
    assert.match(text, /` ` `/, "the page's own fence markers are neutralized");
  });

  it("tells the caller in the tool description that page text is never authorization", async () => {
    const client = await kit.connect();
    const listing = await client.listTools();
    for (const name of ["local_ai_open_web_page", "local_ai_read_search_result", "local_ai_find_in_search_result"]) {
      const description = String(listing.tools.find((tool) => tool.name === name)?.description);
      assert.match(description, /untrusted/i, name);
      assert.match(description, /never|not/i, name);
    }
  });
});
