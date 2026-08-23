import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TOOL_NAMES } from "../dist/src/constants.js";

const endpoint = new URL(process.env.PLATFORM_MCP_VALIDATE_URL || "http://127.0.0.1:5190/mcp");
const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (endpoint.protocol !== "http:" || !allowedHosts.has(endpoint.hostname.toLowerCase()) || endpoint.pathname !== "/mcp") {
  throw new Error("Live validation is restricted to the loopback HTTP /mcp endpoint.");
}

const aiRoot = path.resolve(process.env.AI_ROOT || path.resolve(process.cwd(), ".."));
const keyFile = path.resolve(
  process.env.PLATFORM_MCP_VALIDATE_KEY_FILE || path.join(aiRoot, ".runtime", "platform-mcp", "server.env"),
);
const relativeKeyFile = path.relative(aiRoot, keyFile);
if (relativeKeyFile.startsWith("..") || path.isAbsolute(relativeKeyFile)) {
  throw new Error("The MCP validation key file must stay below AI_ROOT.");
}
const environmentText = await readFile(keyFile, "utf8");
const keyLine = environmentText.split(/\r?\n/).find((line) => line.startsWith("PLATFORM_MCP_API_KEY="));
const apiKey = keyLine?.slice("PLATFORM_MCP_API_KEY=".length).trim() || "";
if (apiKey.length < 32) throw new Error("The MCP validation key file is missing a valid API key.");

const argumentsByTool = {
  local_ai_get_overview: {},
  local_ai_list_running_models: { engine: "all" },
  local_ai_get_gpu_status: {},
  local_ai_list_local_models: { engine: "all", inventory: "local", limit: 3 },
  local_ai_get_performance: { engine: "all", include_models: false },
  local_ai_get_diagnostics: { engine: "all", warnings_only: true },
  local_ai_get_search_health: {},
  local_ai_search_web: {
    query: "Model Context Protocol",
    max_results: 4,
    safesearch: 1,
  },
  local_ai_research_web: {
    queries: [
      { id: "official", query: "Model Context Protocol official documentation" },
      { id: "sdk", query: "Model Context Protocol TypeScript SDK official" },
    ],
    max_sources: 6,
    preferred_domains: ["modelcontextprotocol.io", "github.com"],
    safesearch: 1,
  },
  local_ai_open_web_page: {
    urls: ["https://modelcontextprotocol.io/specification/2026-07-28"],
    max_chars_per_url: 3000,
    max_total_chars: 3000,
  },
  local_ai_read_search_result: null,
  local_ai_find_in_search_result: null,
  local_ai_list_jobs: { engine: "all", limit: 5 },
  local_ai_preview_route: { engine: "auto", protocol: "openai", capability: "tools" },
  local_ai_estimate_memory: {
    engine: "vllm",
    params_b: 27,
    context_tokens: 32768,
    precision: "fp8_int8",
  },
  local_ai_get_security_posture: { engine: "all", warnings_only: true },
};

const client = new Client(
  { name: "local-ai-platform-live-validator", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-mcp-client-id": "release-validation",
    },
  },
});

await client.connect(transport);
try {
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name), [...TOOL_NAMES]);
  assert.equal(listing.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
  assert.equal(listing.tools.every((tool) => tool.annotations?.destructiveHint === false), true);

  const checks = [];
  let searchResultCount = 0;
  let searchQuality = "empty";
  let searchRequestedEngines = [];
  let researchResultCount = 0;
  let researchQuality = "empty";
  let researchSearchId = "";
  let researchFirstResultId = "";
  let openedPageCount = 0;
  let readablePageCount = 0;
  let findPattern = "Model Context Protocol";
  let pageMatchCount = 0;
  let routeSelected = false;
  let securityOverall = "unknown";
  for (const tool of listing.tools) {
    const argumentsForTool = tool.name === "local_ai_read_search_result"
      ? {
        search_id: researchSearchId,
        result_ids: [researchFirstResultId],
        max_chars_per_result: 3000,
        max_total_chars: 3000,
      }
      : tool.name === "local_ai_find_in_search_result"
        ? {
          search_id: researchSearchId,
          result_id: researchFirstResultId,
          pattern: findPattern,
          max_matches: 3,
        }
      : argumentsByTool[tool.name];
    const result = await client.callTool({ name: tool.name, arguments: argumentsForTool });
    assert.notEqual(result.isError, true, `${tool.name} returned a tool error.`);
    assert.equal(typeof result.structuredContent, "object", `${tool.name} omitted structured content.`);
    const output = result.structuredContent;
    assert.equal(output.ok, true, `${tool.name} reported ok=false.`);
    checks.push({ name: tool.name, ok: output.ok, partial: output.partial });
    if (tool.name === "local_ai_search_web") {
      searchResultCount = Number(output.data?.count || 0);
      searchQuality = String(output.data?.quality || "empty");
      searchRequestedEngines = Array.isArray(output.data?.engine_status?.requested)
        ? output.data.engine_status.requested.map(String)
        : [];
    }
    if (tool.name === "local_ai_research_web") {
      researchResultCount = Number(output.data?.count || 0);
      researchQuality = String(output.data?.quality || "empty");
      researchSearchId = String(output.data?.search_id || "");
      researchFirstResultId = String(output.data?.results?.[0]?.result_id || "");
    }
    if (tool.name === "local_ai_open_web_page") openedPageCount = Number(output.data?.readable_count || 0);
    if (tool.name === "local_ai_read_search_result") {
      readablePageCount = Number(output.data?.readable_count || 0);
      const content = String(output.data?.documents?.[0]?.content || "");
      const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length >= 4);
      if (firstLine) findPattern = firstLine.slice(0, 80);
    }
    if (tool.name === "local_ai_find_in_search_result") pageMatchCount = Number(output.data?.match_count || 0);
    if (tool.name === "local_ai_preview_route") routeSelected = output.data?.selected === true;
    if (tool.name === "local_ai_get_security_posture") securityOverall = String(output.data?.overall || "unknown");
  }
  assert.ok(searchResultCount > 0, "The live web search returned no results.");
  assert.ok(["good", "mixed"].includes(searchQuality), `The live web search quality was ${searchQuality}.`);
  assert.deepEqual(searchRequestedEngines, ["searchtoday"]);
  assert.ok(researchResultCount > 0, "The live multi-query research returned no results.");
  assert.ok(["good", "mixed"].includes(researchQuality), `The live research quality was ${researchQuality}.`);
  assert.ok(openedPageCount > 0, "The live explicit-public-page reader returned no readable page.");
  assert.ok(readablePageCount > 0, "The live selected-page reader returned no readable page.");
  assert.ok(pageMatchCount > 0, "The live page find returned no matching passage.");
  assert.equal(routeSelected, true, "The live route preview selected no tools-capable route.");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    protocol: client.getNegotiatedProtocolVersion(),
    tool_count: checks.length,
    web_search_results: searchResultCount,
    web_search_quality: searchQuality,
    web_search_engines: searchRequestedEngines,
    research_results: researchResultCount,
    research_quality: researchQuality,
    opened_pages: openedPageCount,
    readable_pages: readablePageCount,
    page_matches: pageMatchCount,
    route_selected: routeSelected,
    security_overall: securityOverall,
    checks,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
