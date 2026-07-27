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
      dtype: "bfloat16",
      kvCacheDtype: "fp8",
      moeBackend: "flashinfer_b12x",
      generationConfig: "vllm",
      forceTrustRemoteCode: true,
      enableAutoToolChoice: true,
      toolCallParser: "qwen3_coder",
      maxNumBatchedTokens: 8192,
      defaultChatTemplateKwargs: JSON.stringify({ enable_thinking: false }),
      speculativeConfig: { method: "mtp", num_speculative_tokens: 3 },
      asyncScheduling: true,
    }),
  });

  const job = { id: "serve-job-1", meta: {} };
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
  assert.equal(job.meta.dtype, "bfloat16");
  assert.equal(job.meta.moeBackend, "flashinfer_b12x");
  assert.equal(job.meta.generationConfig, "vllm");
  assert.equal(job.meta.maxNumBatchedTokens, 8192);
  assert.ok(runArgs.includes("vllm/custom:pinned"));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--max-num-batched-tokens"), runArgs.indexOf("--max-num-batched-tokens") + 2), ["--max-num-batched-tokens", "8192"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--dtype"), runArgs.indexOf("--dtype") + 2), ["--dtype", "bfloat16"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--moe-backend"), runArgs.indexOf("--moe-backend") + 2), ["--moe-backend", "flashinfer_b12x"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--generation-config"), runArgs.indexOf("--generation-config") + 2), ["--generation-config", "vllm"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--default-chat-template-kwargs"), runArgs.indexOf("--default-chat-template-kwargs") + 2), ["--default-chat-template-kwargs", JSON.stringify({ enable_thinking: false })]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--speculative-config"), runArgs.indexOf("--speculative-config") + 2), ["--speculative-config", JSON.stringify({ method: "mtp", num_speculative_tokens: 3 })]);
  assert.ok(runArgs.includes("--async-scheduling"));
  assert.ok(runArgs.includes("--load-format"));
  assert.ok(!runArgs.includes("--quantization"));
  assert.ok(runArgs.includes("--tensor-parallel-size"));
  assert.ok(runArgs.includes("--api-key"));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("ai.manager.job=serve-job-1") - 1, runArgs.indexOf("ai.manager.job=serve-job-1") + 1), ["--label", "ai.manager.job=serve-job-1"]);
  assert.ok(redactDockerArgs(runArgs, opts).join(" ").includes("***"));
  assert.ok(!redactDockerArgs(runArgs, opts).join(" ").includes("secret-key"));
  assert.ok(logs.some((line) => line.includes("GGUF mode")));
});

test("runtime preset can leave quantization and KV cache dtype to checkpoint auto-detection", () => {
  const logs = [];
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
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
    scheduleJobsSave: () => {},
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: () => ({
      modelArg: "/models/qwen",
      effectiveLoadFormat: "auto",
      localPath: "D:/AI/models/qwen",
    }),
    effectiveLaunchQuantization: () => ({ value: "modelopt", modelConfigMethod: "modelopt" }),
    resolveVllmRuntimePreset: () => ({
      id: "qwen-auto",
      image: "vllm/custom:pinned",
      disableQuantizationArg: true,
      disableKvCacheDtypeArg: true,
    }),
  });

  const job = { meta: {} };
  const opts = {
    model: "D:/AI/models/qwen",
    loadFormat: "auto",
    quantization: "modelopt_fp4",
    port: 8000,
    networkAccess: "local",
    serviceHost: "127.0.0.1",
    gpuDeviceIds: ["0"],
    name: "qwen-local",
    dtype: "auto",
    maxModelLen: 262144,
    maxNumSeqs: 4,
    gpuMemoryUtilization: 0.91,
    tokenizer: "",
    kvCacheDtype: "fp8",
    cpuOffloadGb: 0,
    kvOffloadingSize: 0,
    enablePrefixCaching: false,
    languageModelOnly: false,
    tensorParallelSize: 1,
    pipelineParallelSize: 1,
    dataParallelSize: 1,
  };

  const { runArgs } = buildVllmRuntimeCommand(job, opts);

  assert.ok(!runArgs.includes("--quantization"));
  assert.ok(!runArgs.includes("--kv-cache-dtype"));
  assert.equal(job.meta.kvCacheDtype, "auto");
  assert.ok(logs.some((line) => line.includes("ignoring requested \"modelopt_fp4\"")));
  assert.ok(logs.some((line) => line.includes("ignoring requested \"fp8\"")));
});

test("vLLM runtime command emits --no-enable-prefix-caching only when disabling", () => {
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
    CONFIG: { containerName: "vllm-local", managerId: "vllm-manager", hfCache: "D:/AI/cache/huggingface", modelsRoot: "D:/AI/models", image: "vllm/default:fixed" },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_LABEL_KEY: "ai.manager.api-key",
    appendLog: () => {},
    scheduleJobsSave: () => {},
    dockerGpuArg: (ids) => `device=${ids.join(",")}`,
    dockerPublishArgs: (port, _networkAccess, host) => [`${host || "127.0.0.1"}:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "192.168.1.27",
    resolveLaunchModel: () => ({ modelArg: "/models/qwen/model.gguf", effectiveLoadFormat: "gguf", localPath: "D:/AI/models/qwen" }),
    effectiveLaunchQuantization: () => ({ value: "", modelConfigMethod: "" }),
    resolveVllmRuntimePreset: () => ({ id: "test-preset", label: "Test preset" }),
  });
  const baseOpts = {
    model: "D:/AI/models/qwen", loadFormat: "gguf", quantization: "", port: 8000, networkAccess: "local",
    serviceHost: "127.0.0.1", gpuDeviceIds: ["0"], name: "qwen-local", dtype: "auto",
    maxModelLen: 32768, maxNumSeqs: 4, gpuMemoryUtilization: 0.9, tokenizer: "", kvCacheDtype: "auto",
    cpuOffloadGb: 0, kvOffloadingSize: 0, languageModelOnly: false, tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
  };

  // Default (no disable): no prefix-caching flag at all -> vLLM keeps its default (on).
  const neither = buildVllmRuntimeCommand({ meta: {} }, { ...baseOpts });
  assert.ok(!neither.runArgs.includes("--no-enable-prefix-caching"));
  assert.ok(!neither.runArgs.includes("--enable-prefix-caching"));

  // Explicit enable still emits the enable flag for clarity / older vLLM.
  const enable = buildVllmRuntimeCommand({ meta: {} }, { ...baseOpts, enablePrefixCaching: true });
  assert.ok(enable.runArgs.includes("--enable-prefix-caching"));
  assert.ok(!enable.runArgs.includes("--no-enable-prefix-caching"));

  // User opts to disable: must emit --no-enable-prefix-caching.
  const disable = buildVllmRuntimeCommand({ meta: {} }, { ...baseOpts, disablePrefixCaching: true });
  assert.ok(disable.runArgs.includes("--no-enable-prefix-caching"));
  assert.ok(!disable.runArgs.includes("--enable-prefix-caching"));
});
