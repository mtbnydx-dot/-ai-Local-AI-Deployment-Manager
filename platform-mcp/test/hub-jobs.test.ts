import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { FixedHttpClient } from "../src/http-client.js";
import { LocalPlatformClient } from "../src/platform-client.js";

// HUB-13a (03 §20): with the model hub owning downloads, a manager's
// /api/jobs?fields=summary carries hub jobs mapped by manager-core's
// toLegacyJob. listJobs must read them like any legacy job, without warnings.
// Paths are relative to the compiled file in dist/test.
const require = createRequire(import.meta.url);
const compat = require("../../../manager-core/model-hub/compat.js") as {
  toLegacyJob(job: unknown, options?: { summary?: boolean }): Record<string, unknown>;
};
const fixture = JSON.parse(readFileSync(new URL("../../../manager-core/test/fixtures/hub/hub-jobs.json", import.meta.url), "utf8")) as { jobs: unknown[] };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function config() {
  return loadConfig({
    requireApiKey: true,
    env: {
      AI_ROOT: "X:\\ai-root",
      PLATFORM_MCP_API_KEY: "test-platform-mcp-key-0123456789abcdef",
      PLATFORM_MCP_SERVICE_ENTRY_URL: "http://127.0.0.1:5176",
      PLATFORM_MCP_VLLM_MANAGER_URL: "http://127.0.0.1:5177",
      PLATFORM_MCP_LLAMA_MANAGER_URL: "http://127.0.0.1:5178",
      PLATFORM_MCP_SEARCH_GATEWAY_URL: "http://127.0.0.1:5180",
      PLATFORM_MCP_SEARCH_GATEWAY_API_KEY: "test-search-gateway-key-0123456789abcdef",
    },
  });
}

describe("hub download jobs through the manager job list", () => {
  const [downloading, failed] = fixture.jobs.map((job) => compat.toLegacyJob(job, { summary: true }));
  const responses = new Map<string, unknown>([
    ["http://127.0.0.1:5177/api/jobs?fields=summary", [failed]],
    ["http://127.0.0.1:5178/api/jobs?fields=summary", [downloading, {
      id: "serve-1", type: "serve", title: "Launch", status: "success",
      createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:01:00.000Z", progress: { percent: 100 }, error: null,
    }]],
  ]);
  const fetchImpl: typeof fetch = async (input) => {
    const key = input instanceof URL ? input.href : String(input);
    const value = responses.get(key);
    return value === undefined ? jsonResponse({ error: "missing fixture" }, 404) : jsonResponse(value);
  };
  const client = new LocalPlatformClient(config(), new FixedHttpClient({ timeoutMs: 1000, maxResponseBytes: 1024 * 1024, fetchImpl }));

  it("parses toLegacyJob output from both managers with no warnings", async () => {
    const output = await client.listJobs({ engine: "all", status: "all", jobType: "all", limit: 10, offset: 0 });
    assert.equal(output.ok, true);
    assert.equal(output.partial, false);
    assert.deepEqual(output.warnings, []);
    assert.deepEqual(output.data.jobs.map((job) => [job.engine, job.id, job.type, job.status]), [
      ["llama", "dl_7k2m4q9x3c5vb8np", "download", "running"],
      ["vllm", "dl_2b3c4d5e6f7g2h3j", "download", "failed"],
      ["llama", "serve-1", "serve", "success"],
    ]);
    const [running, broken] = output.data.jobs;
    assert.equal(running?.progress_percent, 41.2);
    assert.equal(running?.title, "Download unsloth/Qwen3-8B-GGUF (Hugging Face)");
    assert.equal(broken?.error, "需要登录 Hugging Face / Hugging Face login required");
  });

  it("filters hub jobs by the legacy status and type", async () => {
    const output = await client.listJobs({ engine: "all", status: "failed", jobType: "download", limit: 10, offset: 0 });
    assert.deepEqual(output.data.jobs.map((job) => job.id), ["dl_2b3c4d5e6f7g2h3j"]);
    assert.equal(JSON.stringify(output).includes("dlt_"), false);
  });
});
