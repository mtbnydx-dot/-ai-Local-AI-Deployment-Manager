const test = require("node:test");
const assert = require("node:assert/strict");
const { createLlamaStartRuntimeRequest } = require("../lib/launch-request");

test("llama launch request keeps hetero GPU plan and tensor split in sync", async () => {
  const runCalls = [];
  const request = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: "llama-local" },
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
      port: "8180",
      gpuDeviceIds: "0,1",
      multiGpuMode: "layer",
      networkAccess: "lan",
      reasoning: "on",
      mmproj: "D:/AI/models/mmproj.gguf",
      speculativeMode: "draft-mtp",
      numSpeculativeTokens: "4",
      apiKey: "llama-key",
    },
  });

  assert.equal(result.job.id, "serve-llama");
  assert.equal(result.job.meta.tensorSplit, "2,1");
  assert.equal(result.job.meta.port, 8180);
  assert.equal(result.job.meta.mainGpu, "0");
  assert.equal(result.job.meta.mainGpuHostId, "host-0");
  assert.equal(result.job.meta.serviceUrl, "http://192.168.1.27:8180/v1");
  assert.equal(runCalls[0].tensorSplit, "2,1");
  assert.equal(runCalls[0].reasoning, "on");
  assert.equal(runCalls[0].mmproj, "D:/AI/models/mmproj.gguf");
  assert.equal(runCalls[0].speculativeMode, "draft-mtp");
  assert.equal(runCalls[0].numSpeculativeTokens, 4);
  assert.equal(runCalls[0].llamaApiKey, "llama-key");
});

test("llama parallel launch never invents a port", async () => {
  const request = createLlamaStartRuntimeRequest({
    CONFIG: { defaultPort: 8080, containerName: "llama-local" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
  });
  await assert.rejects(
    () => request({ body: { model: "model", instanceMode: "parallel", instanceId: "chat" } }),
    (error) => error.status === 400 && /不会自动修改端口/.test(error.message),
  );
});
