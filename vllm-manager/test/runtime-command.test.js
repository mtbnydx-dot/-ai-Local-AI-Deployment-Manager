const test = require("node:test");
const assert = require("node:assert/strict");
const { createVllmRuntimeCommandBuilder } = require("../lib/runtime-command");

test("vLLM runtime command builds Docker args and redacts API keys", () => {
  const logs = [];
  let saved = false;
  const { buildVllmRuntimeCommand, redactDockerArgs } = createVllmRuntimeCommandBuilder({
    CONFIG: {
      containerName: "vllm-local",
      managerId: "vllm-manager",
      hfCache: "D:/AI/cache/huggingface",
      modelsRoot: "D:/AI/models",
      image: "vllm/default:fixed",
    },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_LABEL_KEY: "ai.manager.api-key",
    appendLog: (_job, line) => logs.push(line),
    scheduleJobsSave: () => { saved = true; },
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "192.168.1.27",
    resolveLaunchModel: () => ({
      modelArg: "/models/qwen/model.gguf",
      effectiveLoadFormat: "gguf",
      selectedGgufFile: "D:/AI/models/qwen/model.gguf",
      ggufFiles: [
        { path: "D:/AI/models/qwen/small.gguf", size: 1 },
        { path: "D:/AI/models/qwen/model.gguf", size: 2 },
      ],
      localPath: "D:/AI/models/qwen",
    }),
    effectiveLaunchQuantization: () => ({ value: "awq", modelConfigMethod: "" }),
    resolveVllmRuntimePreset: () => ({
      id: "test-preset",
      label: "Test preset",
      image: "vllm/custom:pinned",
      env: { VLLM_TEST: "1" },
      notes: ["preset note"],
      kvCacheDtype: "fp8",
      forceTrustRemoteCode: true,
      enableAutoToolChoice: true,
      toolCallParser: "qwen3_coder",
    }),
  });

  const job = { meta: {} };
  const opts = {
    model: "D:/AI/models/qwen",
    loadFormat: "gguf",
    quantization: "awq",
    port: 8000,
    networkAccess: "lan",
    serviceHost: "192.168.1.27",
    gpuDeviceIds: ["0", "1"],
    vllmApiKey: "secret-key",
    name: "qwen-local",
    dtype: "auto",
    maxModelLen: 65536,
    maxNumSeqs: 1,
    gpuMemoryUtilization: 0.9,
    tokenizer: "D:/AI/models/qwen/tokenizer",
    kvCacheDtype: "auto",
    cpuOffloadGb: 0,
    kvOffloadingSize: 0,
    enablePrefixCaching: true,
    languageModelOnly: false,
    tensorParallelSize: 2,
    pipelineParallelSize: 1,
    dataParallelSize: 1,
  };

  const { runArgs, activePublishArgs } = buildVllmRuntimeCommand(job, opts);

  assert.deepEqual(activePublishArgs, ["192.168.1.27:8000:8000"]);
  assert.equal(saved, true);
  assert.equal(job.meta.runtimePreset, "test-preset");
  assert.ok(runArgs.includes("vllm/custom:pinned"));
  assert.ok(runArgs.includes("--load-format"));
  assert.ok(!runArgs.includes("--quantization"));
  assert.ok(runArgs.includes("--tensor-parallel-size"));
  assert.ok(runArgs.includes("--api-key"));
  assert.ok(redactDockerArgs(runArgs, opts).join(" ").includes("***"));
  assert.ok(!redactDockerArgs(runArgs, opts).join(" ").includes("secret-key"));
  assert.ok(logs.some((line) => line.includes("GGUF mode")));
});
