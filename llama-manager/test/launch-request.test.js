const test = require("node:test");
const assert = require("node:assert/strict");
const { createLlamaStartRuntimeRequest } = require("../lib/launch-request");

test("llama launch request keeps hetero GPU plan and tensor split in sync", async () => {
  const runCalls = [];
  const request = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080 },
    cleanRequired: (value, name) => {
      if (!value) throw new Error(`${name} required`);
      return String(value);
    },
    deriveName: (model) => model.split(/[\\/]/).pop(),
    positiveInt: (value, fallback) => Number(value || fallback),
    normalizeGpuLayers: (value) => (value == null || value === "" ? -1 : Number(value)),
    normalizeLlamaCacheType: (value) => value || "q8_0",
    normalizeOnOffAuto: (value) => value || "auto",
    normalizeLaunchGpuSelection: async (ids) => ({ gpuDeviceIds: ids, selectedCount: ids.length, warnings: ["hetero"] }),
    normalizeGpuIds: (value) => String(value || "").split(",").filter(Boolean),
    normalizeLlamaSplitMode: (value) => value || "layer",
    cleanOptionalLaunchArg: (value) => String(value || "").trim(),
    normalizeClientPreset: (value) => value || "openai",
    normalizeLlamaReasoningFormat: (value) => value || "none",
    normalizeDefaultTrueBoolean: (value) => value !== false,
    normalizeNetworkAccess: (value) => value || "local",
    getLanAddress: () => "192.168.1.27",
    getGpuStatus: async () => ({ gpus: [{ id: "0" }, { id: "1" }] }),
    buildLlamaGpuPlan: () => ({ mainGpu: "0", mainGpuHostId: "host-0" }),
    suggestTensorSplit: () => "2,1",
    createJob: (type, title, meta) => ({ id: "serve-llama", type, title, meta }),
    runStartJob: (_job, options) => {
      runCalls.push(options);
      return Promise.resolve();
    },
    failJob: () => {},
  });

  const result = await request({
    body: {
      model: "D:/AI/models/model.gguf",
      gpuDeviceIds: "0,1",
      multiGpuMode: "layer",
      networkAccess: "lan",
      reasoning: "on",
    },
  });

  assert.equal(result.job.id, "serve-llama");
  assert.equal(result.job.meta.tensorSplit, "2,1");
  assert.equal(result.job.meta.mainGpu, "0");
  assert.equal(result.job.meta.mainGpuHostId, "host-0");
  assert.equal(result.job.meta.serviceUrl, "http://192.168.1.27:8080/v1");
  assert.equal(runCalls[0].tensorSplit, "2,1");
  assert.equal(runCalls[0].reasoning, "on");
});
