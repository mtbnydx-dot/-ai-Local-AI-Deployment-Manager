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
      imagePlatform: "linux/amd64",
    },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
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
    runtimeApiKeyRef: "runtime-secret-ref",
    name: "qwen-local",
    dtype: "auto",
    maxModelLen: 65536,
    maxNumSeqs: 1,
    gpuMemoryUtilization: 0.9,
    vramReservationMb: 12000,
    gpuAdmissionLeaseId: "lease-vllm",
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

  const { runArgs, activePublishArgs, secretEnv } = buildVllmRuntimeCommand(job, opts);

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
  assert.ok(!runArgs.includes("--sleep-on-idle"));
  assert.ok(runArgs.includes("--load-format"));
  assert.ok(!runArgs.includes("--quantization"));
  assert.ok(runArgs.includes("--tensor-parallel-size"));
  // 08 P0-4: the key travels through the docker child env, never argv.
  assert.ok(!runArgs.includes("--api-key"));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("VLLM_API_KEY") - 1, runArgs.indexOf("VLLM_API_KEY") + 1), ["-e", "VLLM_API_KEY"]);
  assert.ok(runArgs.indexOf("VLLM_API_KEY") < runArgs.indexOf("vllm/custom:pinned"));
  assert.equal(secretEnv.VLLM_API_KEY, "secret-key");
  assert.ok(!runArgs.some((arg) => String(arg).includes("secret-key")));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--platform"), runArgs.indexOf("--platform") + 2), ["--platform", "linux/amd64"]);
  assert.deepEqual(runArgs.slice(runArgs.indexOf("--pull"), runArgs.indexOf("--pull") + 2), ["--pull", "never"]);
  assert.ok(runArgs.includes("ai.manager.api-key-ref=runtime-secret-ref"));
  assert.ok(!runArgs.some((arg) => String(arg).startsWith("ai.manager.api-key=secret-key")));
  assert.deepEqual(runArgs.slice(runArgs.indexOf("ai.manager.job=serve-job-1") - 1, runArgs.indexOf("ai.manager.job=serve-job-1") + 1), ["--label", "ai.manager.job=serve-job-1"]);
  assert.ok(runArgs.includes("ai.manager.gpu-ids=0,1"));
  assert.ok(runArgs.includes("ai.manager.vram-reservation-mb=12000"));
  assert.ok(runArgs.includes("ai.manager.gpu-admission-lease=lease-vllm"));
  assert.ok(runArgs.includes("ai.manager.max-model-len=65536"));
  // The vLLM argv holds no key to redact; SGLang still carries --api-key, so
  // the marker check runs on an SGLang argv.
  const sglangArgs = ["run", "-d", "--entrypoint", "sglang", "lmsysorg/sglang:pinned", "serve", "--api-key", "secret-key"];
  assert.ok(redactDockerArgs(sglangArgs, opts).join(" ").includes("--api-key <redacted>"));
  assert.ok(!redactDockerArgs(runArgs, opts).join(" ").includes("secret-key"));
  assert.ok(logs.some((line) => line.includes("GGUF mode")));
});

test("vLLM runtime argv is fixed and never carries the API key or HF token value (08 P0-4)", () => {
  const previousHfToken = process.env.HF_TOKEN;
  process.env.HF_TOKEN = "fixture-hf-token-value";
  try {
    const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
      CONFIG: { containerName: "vllm-local", managerId: "vllm-manager", hfCache: "C:/cache/hf", modelsRoot: "C:/store", image: "vllm/default:fixed" },
      MANAGER_LABEL_KEY: "ai.manager", MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine", MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
      appendLog: () => {}, scheduleJobsSave: () => {}, dockerGpuArg: () => "device=0",
      dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`], publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
      windowsPathToContainerPath: (value) => value, normalizeGpuIds: (value) => value, getLanAddress: () => "127.0.0.1",
      resolveLaunchModel: () => ({ modelArg: "/models/qwen", effectiveLoadFormat: "auto", localPath: "C:/store/qwen" }),
      effectiveLaunchQuantization: () => ({ value: "", modelConfigMethod: "" }),
      resolveVllmRuntimePreset: () => ({}),
    });
    const baseOpts = {
      model: "C:/store/qwen", loadFormat: "auto", quantization: "", port: 8001, networkAccess: "local",
      serviceHost: "127.0.0.1", gpuDeviceIds: ["0"], name: "qwen-local", dtype: "auto",
      maxModelLen: 32768, maxNumSeqs: 4, gpuMemoryUtilization: 0.9, tokenizer: "", kvCacheDtype: "auto",
      cpuOffloadGb: 0, kvOffloadingSize: 0, languageModelOnly: false, tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
    };
    const expectedArgv = (envFlags, labelArgs = []) => [
      "run", "-d", "--pull", "never", "--name", "vllm-local", "--restart", "on-failure:3",
      "--label", "ai.manager=vllm-manager", "--label", "ai.manager.engine=vllm", "--label", "ai.manager.job=serve-argv",
      "--label", "ai.manager.instance=primary", "--label", "ai.manager.instance-mode=replace", "--label", "ai.manager.model=qwen-local",
      "--label", "ai.manager.port=8001", "--label", "ai.manager.gpu-ids=0", "--label", "ai.manager.vram-reservation-mb=0",
      "--label", "ai.manager.max-model-len=32768", "--label", "ai.manager.max-num-seqs=4", "--label", "ai.manager.max-num-batched-tokens=0",
      "--label", "ai.manager.gpu-memory-utilization=0.9", "--label", "ai.manager.gpu-admission-lease=",
      "--gpus", "device=0", "--ipc=host",
      "--health-cmd", "curl -fsS http://127.0.0.1:8000/health || exit 1", "--health-interval", "30s", "--health-timeout", "5s",
      "--health-retries", "3", "--health-start-period", "60m",
      "-p", "127.0.0.1:8001:8000", "-v", "C:/cache/hf:/root/.cache/huggingface", "-v", "C:/store:/models",
      ...labelArgs,
      ...envFlags,
      "vllm/default:fixed", "--model", "/models/qwen", "--served-model-name", "qwen-local", "--dtype", "auto",
      "--max-model-len", "32768", "--max-num-seqs", "4", "--gpu-memory-utilization", "0.9",
    ];

    const withoutKey = buildVllmRuntimeCommand({ id: "serve-argv", meta: {} }, baseOpts);
    assert.deepEqual(withoutKey.runArgs, expectedArgv(["-e", "HF_TOKEN"]));
    assert.deepEqual(withoutKey.secretEnv, { HF_TOKEN: "fixture-hf-token-value" });

    const key = "fixture-vllm-key-0123456789";
    const withKey = buildVllmRuntimeCommand({ id: "serve-argv", meta: {} }, { ...baseOpts, vllmApiKey: key, runtimeApiKeyRef: "fixture-ref-01" });
    assert.deepEqual(withKey.runArgs, expectedArgv(
      ["-e", "HF_TOKEN", "-e", "VLLM_API_KEY"],
      ["--label", "ai.manager.api-key-ref=fixture-ref-01"],
    ));
    assert.deepEqual(withKey.secretEnv, { HF_TOKEN: "fixture-hf-token-value", VLLM_API_KEY: key });
    for (const arg of withKey.runArgs) {
      assert.ok(!String(arg).includes(key));
      assert.ok(!String(arg).includes("fixture-hf-token-value"));
    }
  } finally {
    if (previousHfToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previousHfToken;
  }
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

test("SGLang runtime command emits the validated Qwen3.8 DSpark contract", () => {
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
    CONFIG: {
      containerName: "vllm-local",
      managerId: "vllm-manager",
      hfCache: "D:/AI/cache/huggingface",
      modelsRoot: "D:/AI/models",
      vllmCache: "D:/AI/cache/vllm-qwen38",
      sglangCache: "D:/AI/cache/sglang-qwen38",
      image: "vllm/default:fixed",
      imagePlatform: "linux/amd64",
    },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {},
    scheduleJobsSave: () => {},
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: () => ({ modelArg: "/models/Qwen-Qwen3.8-27B-FP8", effectiveLoadFormat: "auto", localPath: "D:/AI/models/Qwen-Qwen3.8-27B-FP8" }),
    effectiveLaunchQuantization: () => ({ value: "fp8", modelConfigMethod: "fp8" }),
    resolveVllmRuntimePreset: () => ({
      id: "qwen3.8-sglang-dspark",
      label: "Qwen3.8 / SGLang / DSpark",
      engine: "sglang",
      image: "lmsysorg/sglang@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attentionBackend: "flashinfer",
      reasoningParser: "qwen3",
      toolCallParser: "qwen3_coder",
      enableAutoToolChoice: true,
      chunkedPrefillSize: 8192,
      mambaSchedulerStrategy: "extra_buffer",
      disablePrefillCudaGraph: true,
      mmFeatureTransport: "cpu",
      speculativeAlgorithm: "DSPARK",
      draftModel: "D:/AI/models/RadixArk-Qwen3.8-27B-DSpark",
      dsparkBlockSize: 7,
      draftModelQuantization: "unquant",
    }),
  });
  const job = { id: "serve-dspark", meta: {} };
  const opts = {
    engine: "sglang", model: "D:/AI/models/Qwen-Qwen3.8-27B-FP8", name: "qwen3.8-27b",
    port: 8000, networkAccess: "local", serviceHost: "127.0.0.1", gpuDeviceIds: ["0"],
    dtype: "auto", quantization: "fp8", loadFormat: "auto", maxModelLen: 262144,
    maxNumSeqs: 4, gpuMemoryUtilization: 0.8, kvCacheDtype: "auto", cpuOffloadGb: 0,
    kvOffloadingSize: 0, mmProcessorCacheGb: 0, tensorParallelSize: 1,
    pipelineParallelSize: 1, dataParallelSize: 1, enablePrefixCaching: true,
  };

  const result = buildVllmRuntimeCommand(job, opts);
  const args = result.runArgs;
  assert.equal(result.runtimeEngine, "sglang");
  assert.ok(args.includes("ai.manager.engine=sglang"));
  assert.deepEqual(args.slice(args.indexOf("--entrypoint"), args.indexOf("--entrypoint") + 3), [
    "--entrypoint", "sglang", "lmsysorg/sglang@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--speculative-algorithm"), args.indexOf("--speculative-algorithm") + 2), ["--speculative-algorithm", "DSPARK"]);
  assert.deepEqual(args.slice(args.indexOf("--speculative-dspark-block-size"), args.indexOf("--speculative-dspark-block-size") + 2), ["--speculative-dspark-block-size", "7"]);
  assert.deepEqual(args.slice(args.indexOf("--mamba-scheduler-strategy"), args.indexOf("--mamba-scheduler-strategy") + 2), ["--mamba-scheduler-strategy", "extra_buffer"]);
  assert.deepEqual(args.slice(args.indexOf("--attention-backend"), args.indexOf("--attention-backend") + 2), ["--attention-backend", "flashinfer"]);
  assert.deepEqual(args.slice(args.indexOf("--mm-feature-transport"), args.indexOf("--mm-feature-transport") + 2), ["--mm-feature-transport", "cpu"]);
  assert.ok(args.includes("--disable-prefill-cuda-graph"));
  assert.ok(args.includes("--enable-metrics"));
  assert.ok(args.includes("--sleep-on-idle"));
  assert.ok(args.includes("D:/AI/cache/sglang-qwen38:/root/.cache"));
  assert.equal(job.meta.draftModel, "D:/AI/models/RadixArk-Qwen3.8-27B-DSpark");
});

test("SGLang runtime command emits the validated Flash-Next SM120 long-context contract", () => {
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
    CONFIG: {
      containerName: "vllm-local",
      managerId: "vllm-manager",
      hfCache: "D:/AI/cache/huggingface",
      modelsRoot: "D:/AI/models",
      sglangCache: "D:/AI/cache/sglang-qwen38",
      image: "vllm/default:fixed",
      imagePlatform: "linux/amd64",
    },
    MANAGER_LABEL_KEY: "ai.manager",
    MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine",
    MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {},
    scheduleJobsSave: () => {},
    dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`],
    publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    normalizeGpuIds: (value) => value,
    getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: () => ({
      modelArg: "/models/RadixArk-Qwen3.8-Flash-Next-NVFP4",
      effectiveLoadFormat: "auto",
      localPath: "D:/AI/models/RadixArk-Qwen3.8-Flash-Next-NVFP4",
    }),
    effectiveLaunchQuantization: () => ({ value: "modelopt_fp4", modelConfigMethod: "modelopt_fp4" }),
    resolveVllmRuntimePreset: () => ({
      id: "qwen3.8-flash-next-sglang-sm120",
      label: "Qwen3.8 Flash-Next / SGLang / SM120",
      engine: "sglang",
      image: "local/sglang:qwen38flashnext-sm120-dac5523d",
      quantization: "modelopt_fp4",
      maxRunningRequests: 1,
      effectiveMaxRunningRequests: 1,
      maxTotalTokens: 262144,
      pageSize: 64,
      chunkedPrefillSize: 4096,
      fp4GemmBackend: "flashinfer_cutlass",
      attentionBackend: "triton",
      pleOffloadEmbedding: true,
      linearAttnPrefillBackend: "triton",
      linearAttnDecodeBackend: "flashinfer",
      mambaSsmDtype: "bfloat16",
      mambaRadixCacheStrategy: "extra_buffer",
      mambaTrackInterval: 64,
      maxMambaCacheSize: 8,
      disableThinkingByDefault: true,
      defaultChatTemplateKwargs: JSON.stringify({ enable_thinking: false }),
      forceTrustRemoteCode: true,
      reasoningParser: "qwen3",
      toolCallParser: "qwen3_coder",
      enableAutoToolChoice: true,
    }),
  });
  const job = { id: "serve-flash-next", meta: {} };
  const { runArgs } = buildVllmRuntimeCommand(job, {
    engine: "sglang", model: "D:/AI/models/RadixArk-Qwen3.8-Flash-Next-NVFP4", name: "qwen3.8-flash-next",
    port: 8000, networkAccess: "local", serviceHost: "127.0.0.1", gpuDeviceIds: ["0"],
    dtype: "auto", quantization: "modelopt_fp4", loadFormat: "auto", maxModelLen: 262144,
    maxNumSeqs: 4, gpuMemoryUtilization: 0.995, kvCacheDtype: "auto", cpuOffloadGb: 0,
    kvOffloadingSize: 0, tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
    trustRemoteCode: true, enablePrefixCaching: true,
  });

  const pair = (flag) => runArgs.slice(runArgs.indexOf(flag), runArgs.indexOf(flag) + 2);
  assert.deepEqual(pair("--max-running-requests"), ["--max-running-requests", "1"]);
  assert.deepEqual(pair("--max-total-tokens"), ["--max-total-tokens", "262144"]);
  assert.deepEqual(pair("--page-size"), ["--page-size", "64"]);
  assert.deepEqual(pair("--chunked-prefill-size"), ["--chunked-prefill-size", "4096"]);
  assert.deepEqual(pair("--quantization"), ["--quantization", "modelopt_fp4"]);
  assert.deepEqual(pair("--fp4-gemm-backend"), ["--fp4-gemm-backend", "flashinfer_cutlass"]);
  assert.deepEqual(pair("--attention-backend"), ["--attention-backend", "triton"]);
  assert.deepEqual(pair("--linear-attn-prefill-backend"), ["--linear-attn-prefill-backend", "triton"]);
  assert.deepEqual(pair("--linear-attn-decode-backend"), ["--linear-attn-decode-backend", "flashinfer"]);
  assert.deepEqual(pair("--mamba-ssm-dtype"), ["--mamba-ssm-dtype", "bfloat16"]);
  assert.deepEqual(pair("--mamba-radix-cache-strategy"), ["--mamba-radix-cache-strategy", "extra_buffer"]);
  assert.deepEqual(pair("--mamba-track-interval"), ["--mamba-track-interval", "64"]);
  assert.deepEqual(pair("--max-mamba-cache-size"), ["--max-mamba-cache-size", "8"]);
  assert.deepEqual(pair("--default-chat-template-kwargs"), ["--default-chat-template-kwargs", JSON.stringify({ enable_thinking: false })]);
  assert.ok(runArgs.includes("--ple-offload-embedding"));
  assert.ok(!runArgs.includes("--kv-cache-dtype"));
  assert.ok(!runArgs.includes("--mamba-scheduler-strategy"));
  assert.ok(runArgs.includes("ai.sglang.effective-max-running-requests=1"));
  assert.equal(job.meta.effectiveMaxRunningRequests, 1);
});

test("vLLM runtime supports the current positional serve syntax and persistent cache", () => {
  const { buildVllmRuntimeCommand } = createVllmRuntimeCommandBuilder({
    CONFIG: { containerName: "vllm-local", managerId: "vllm-manager", hfCache: "D:/AI/cache/huggingface", modelsRoot: "D:/AI/models", vllmCache: "D:/AI/cache/vllm-qwen38", image: "vllm/default:fixed" },
    MANAGER_LABEL_KEY: "ai.manager", MANAGER_ENGINE_LABEL_KEY: "ai.manager.engine", MANAGER_APIKEY_REF_LABEL_KEY: "ai.manager.api-key-ref",
    appendLog: () => {}, scheduleJobsSave: () => {}, dockerGpuArg: () => "device=0",
    dockerPublishArgs: (port) => [`127.0.0.1:${port}:8000`], publishArgsToDockerRunArgs: (args) => args.flatMap((arg) => ["-p", arg]),
    windowsPathToContainerPath: (value) => String(value).replace("D:/AI/models", "/models").replaceAll("\\", "/"),
    normalizeGpuIds: (value) => value, getLanAddress: () => "127.0.0.1",
    resolveLaunchModel: () => ({ modelArg: "/models/Qwen-Qwen3.8-27B-FP8", effectiveLoadFormat: "auto", localPath: "D:/AI/models/Qwen-Qwen3.8-27B-FP8" }),
    effectiveLaunchQuantization: () => ({ value: "fp8", modelConfigMethod: "fp8" }),
    resolveVllmRuntimePreset: () => ({ id: "qwen3.8-vllm-fp8", image: "vllm/qwen38:fixed", positionalModel: true, speculativeConfig: { method: "mtp", num_speculative_tokens: 3 } }),
  });
  const { runArgs } = buildVllmRuntimeCommand({ id: "serve-vllm", meta: {} }, {
    model: "D:/AI/models/Qwen-Qwen3.8-27B-FP8", name: "qwen3.8-27b", port: 8000,
    networkAccess: "local", serviceHost: "127.0.0.1", gpuDeviceIds: ["0"], dtype: "auto",
    quantization: "fp8", loadFormat: "auto", maxModelLen: 262144, maxNumSeqs: 4,
    gpuMemoryUtilization: 0.8, kvCacheDtype: "auto", cpuOffloadGb: 0, kvOffloadingSize: 0,
    tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
  });
  const imageIndex = runArgs.indexOf("vllm/qwen38:fixed");
  assert.equal(runArgs[imageIndex + 1], "/models/Qwen-Qwen3.8-27B-FP8");
  assert.equal(runArgs.includes("--model"), false);
  assert.ok(runArgs.includes("D:/AI/cache/vllm-qwen38:/root/.cache/vllm"));
});
