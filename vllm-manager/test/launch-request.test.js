const test = require("node:test");
const assert = require("node:assert/strict");
const { createVllmStartRuntimeRequest } = require("../lib/launch-request");

test("vLLM launch request builds serve job metadata and run options", async () => {
  const runCalls = [];
  const compatibilityCalls = [];
  let compatibilityOk = true;
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local" },
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
    normalizeSpeculativeMode: (value) => value || "off",
    checkModelCompatibility: async (input) => {
      compatibilityCalls.push(input);
      return compatibilityOk
        ? { ok: true, findings: [] }
        : { ok: false, findings: [{ severity: "fail", title: "权重分片缺失", detail: "missing shard 2" }] };
    },
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
      port: "8123",
      maxModelLen: "262144",
      maxNumSeqs: "4",
      gpuDeviceIds: "0,1",
      multiGpuMode: "tensor",
      tensorParallelSize: "2",
      toolCallParser: "auto",
      clientPreset: "claude",
      enableAutoToolChoice: true,
      networkAccess: "lan",
      apiKey: "sk-local",
      speculativeMode: "auto",
      numSpeculativeTokens: "2",
    },
  });

  assert.equal(result.job.id, "serve-1");
  assert.equal(result.job.meta.tensorParallelSize, 2);
  assert.equal(result.job.meta.port, 8123);
  assert.equal(result.job.meta.maxModelLen, 262144);
  assert.equal(result.job.meta.maxNumSeqs, 4);
  assert.equal(result.job.meta.toolCallParser, "qwen3_coder");
  assert.equal(result.job.meta.enableAutoToolChoice, true);
  assert.equal(result.job.meta.hasApiKey, true);
  assert.equal(result.job.meta.serviceHost, "192.168.1.27");
  assert.equal(runCalls[0].vllmApiKey, "sk-local");
  assert.equal(runCalls[0].serviceUrl, "http://192.168.1.27:8123/v1");
  assert.equal(runCalls[0].speculativeMode, "auto");
  assert.equal(runCalls[0].numSpeculativeTokens, 2);
  assert.equal(compatibilityCalls[0].remote, false);
  assert.equal(compatibilityCalls[0].model, "Qwen/Qwen3.6-27B");
  compatibilityOk = false;
  await assert.rejects(
    () => request({ body: { model: "D:/models/broken" } }),
    (error) => error.status === 422 && /权重分片缺失/.test(error.message),
  );
});

test("vLLM parallel launch never invents a port", async () => {
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
  });
  await assert.rejects(
    () => request({ body: { model: "model", instanceMode: "parallel", instanceId: "code" } }),
    (error) => error.status === 400 && /不会自动修改端口/.test(error.message),
  );
});

test("vLLM launch request rejects unsafe numeric values before creating a job", async () => {
  const request = createVllmStartRuntimeRequest({
    CONFIG: { defaultPort: 8000, containerName: "vllm-local" },
    cleanRequired: (value) => String(value || "model"),
    deriveName: () => "model",
  });
  await assert.rejects(
    () => request({ body: { model: "model", maxModelLen: "NaN" } }),
    (error) => error.status === 400 && /maxModelLen/.test(error.message),
  );
  await assert.rejects(
    () => request({ body: { model: "model", gpuMemoryUtilization: "1.5" } }),
    (error) => error.status === 400 && /gpuMemoryUtilization/.test(error.message),
  );
});
