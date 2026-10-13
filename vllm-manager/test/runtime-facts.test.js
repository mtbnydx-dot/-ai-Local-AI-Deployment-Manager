const test = require("node:test");
const assert = require("node:assert/strict");
const manager = require("../server");

test("runtime facts of a parallel instance come from its own container and serve jobs", async () => {
  const dockerLogs = {
    "vllm-local": "INFO GPU KV cache size: 999,000 tokens\n",
    "vllm-local-code": "INFO GPU KV cache size: 111,000 tokens\n",
  };
  const dockerCalls = [];
  const docker = async (args) => {
    dockerCalls.push(args);
    return { stdout: dockerLogs[args.at(-1)] || "", stderr: "" };
  };
  // Both containers serve the same model, so model hints alone cannot tell
  // their jobs apart.
  const jobs = new Map([
    ["legacy", { id: "legacy", type: "serve", meta: { model: "Qwen/Qwen3.6-27B" }, logs: ["Model loading took 12.5 GiB memory and 30.0 seconds"] }],
    ["primary", { id: "primary", type: "serve", meta: { model: "Qwen/Qwen3.6-27B", containerName: "vllm-local" }, logs: ["Maximum concurrency for 8,192 tokens per request: 3.50x"] }],
    ["parallel", { id: "parallel", type: "serve", meta: { model: "Qwen/Qwen3.6-27B", containerName: "vllm-local-code" }, logs: ["Maximum concurrency for 4,096 tokens per request: 7.25x"] }],
    ["download", { id: "download", type: "download", meta: { containerName: "vllm-local-code" }, logs: ["Model loading took 99.0 GiB memory and 1.0 seconds"] }],
  ]);
  const readFacts = manager.createLatestRuntimeFactsReader({
    docker,
    getJobs: () => jobs.values(),
    primaryContainerName: "vllm-local",
  });

  const parallel = await readFacts(["Qwen/Qwen3.6-27B"], { containerName: "vllm-local-code" });
  assert.equal(parallel.kvCacheTokens, 111000);
  assert.equal(parallel.maxContextTokens, 4096);
  assert.equal(parallel.maxConcurrency, 7.25);
  assert.equal(parallel.modelLoadMemoryGiB, null);

  const primary = await readFacts(["Qwen/Qwen3.6-27B"], { containerName: "vllm-local" });
  assert.equal(primary.kvCacheTokens, 999000);
  assert.equal(primary.maxContextTokens, 8192);
  assert.equal(primary.maxConcurrency, 3.5);
  assert.equal(primary.modelLoadMemoryGiB, 12.5);

  // Without a container the primary is read, as before.
  assert.deepEqual(await readFacts(["Qwen/Qwen3.6-27B"]), primary);
  assert.deepEqual(dockerCalls.map((args) => args.at(-1)), ["vllm-local-code", "vllm-local", "vllm-local"]);
  assert.deepEqual(dockerCalls[0].slice(0, 3), ["logs", "--tail", "2000"]);
});
