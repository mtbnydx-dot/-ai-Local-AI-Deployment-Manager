const test = require("node:test");
const assert = require("node:assert/strict");
const { createVllmStartRuntimeRequest } = require("../lib/launch-request");

test("vLLM launch request builds serve job metadata and run options", async () => {
  const runCalls = [];
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000 },
    cleanRequired: (value, name) => {
      if (!value) throw new Error(`${name} required`);
      return String(value);
    },
    deriveName: (model) => model.split("/").pop(),
    positiveInt: (value, fallback) => Number(value || fallback),
    nonNegativeNumber: (value, fallback) => Math.max(0, Number(value || fallback)),
    optionalNonNegativeNumber: (value) => (value == null || value === "" ? null : Math.max(0, Number(value))),
    normalizeDtype: (value) => value || "auto",
    normalizeQuantization: (value) => value || "",
    normalizeLoadFormat: (value) => value || "auto",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeKvCacheDtype: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: ["mixed GPUs"] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeClientPreset: (value) => value || "openai",
    normalizeReasoningParser: (value) => value || "",
    normalizeToolCallParser: (value) => value || "",
    inferToolCallParser: () => "qwen3_coder",
    normalizeNetworkAccess: (value) => value || "local",
    getLanAddress: () => "192.168.1.27",
    createJob: (type, title, meta) => ({ id: "serve-1", type, title, meta }),
    runStartJob: (_job, options) => {
      runCalls.push(options);
      return Promise.resolve();
    },
    failJob: () => {},
  });

  const result = await request({
    body: {
      model: "Qwen/Qwen3.6-27B",
      gpuDeviceIds: "0,1",
      multiGpuMode: "tensor",
      tensorParallelSize: "2",
      toolCallParser: "auto",
      clientPreset: "claude",
      enableAutoToolChoice: true,
      networkAccess: "lan",
      apiKey: "sk-local",
    },
  });

  assert.equal(result.job.id, "serve-1");
  assert.equal(result.job.meta.tensorParallelSize, 2);
  assert.equal(result.job.meta.toolCallParser, "qwen3_coder");
  assert.equal(result.job.meta.enableAutoToolChoice, true);
  assert.equal(result.job.meta.hasApiKey, true);
  assert.equal(result.job.meta.serviceHost, "192.168.1.27");
  assert.equal(runCalls[0].vllmApiKey, "sk-local");
  assert.equal(runCalls[0].serviceUrl, "http://192.168.1.27:8000/v1");
});
