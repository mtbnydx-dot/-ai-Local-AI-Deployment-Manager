const path = require("path");

function createVllmRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_LABEL_KEY,
    appendLog,
    scheduleJobsSave,
    dockerGpuArg,
    dockerPublishArgs,
    publishArgsToDockerRunArgs,
    windowsPathToContainerPath,
    normalizeGpuIds,
    getLanAddress,
    resolveLaunchModel,
    effectiveLaunchQuantization,
    resolveVllmRuntimePreset,
  } = deps;

  function formatDockerPublishArgs(publishArgs) {
    return publishArgs.map((arg) => `-p ${arg}`).join(" ");
  }

  function redactDockerArgs(args, opts = {}) {
    if (!opts.vllmApiKey) return args;
    return args.map((arg) => arg.includes(opts.vllmApiKey) ? arg.replaceAll(opts.vllmApiKey, "***") : arg);
  }

  function buildVllmRuntimeCommand(job, opts) {
    const launch = resolveLaunchModel(opts.model, opts.loadFormat);
    const modelArg = launch.modelArg;
    const quantization = effectiveLaunchQuantization(opts.quantization, launch);
    const runtimePreset = resolveVllmRuntimePreset(opts, launch);
    const runtimeImage = runtimePreset.image || CONFIG.image;
    const effectiveKvCacheDtype = runtimePreset.kvCacheDtype || opts.kvCacheDtype;
    const effectiveReasoningParser = runtimePreset.reasoningParser || opts.reasoningParser;
    const effectiveToolCallParser = runtimePreset.toolCallParser || opts.toolCallParser;
    const effectiveAutoToolChoice = Boolean(runtimePreset.enableAutoToolChoice || opts.enableAutoToolChoice);

    if (quantization.modelConfigMethod && opts.quantization && quantization.value !== opts.quantization) {
      appendLog(job, `Quantization override: model config declares "${quantization.modelConfigMethod}", ignoring requested "${opts.quantization}".`);
    }
    if (runtimePreset.id) {
      job.meta = {
        ...job.meta,
        runtimePreset: runtimePreset.id,
        runtimeImage,
        runtimeNotes: runtimePreset.notes || [],
        kvCacheDtype: effectiveKvCacheDtype,
        trustRemoteCode: Boolean(opts.trustRemoteCode || runtimePreset.forceTrustRemoteCode),
        enablePrefixCaching: Boolean(opts.enablePrefixCaching && !runtimePreset.disablePrefixCaching),
        languageModelOnly: Boolean(opts.languageModelOnly && !runtimePreset.disableLanguageModelOnly),
        enforceEager: Boolean(runtimePreset.enforceEager),
        reasoningParser: effectiveReasoningParser,
        toolCallParser: effectiveToolCallParser,
        enableAutoToolChoice: effectiveAutoToolChoice,
      };
      scheduleJobsSave();
      appendLog(job, `Runtime preset: ${runtimePreset.label || runtimePreset.id}; using image ${runtimeImage}.`);
      for (const note of runtimePreset.notes || []) appendLog(job, `Runtime preset note: ${note}`);
      if (runtimePreset.kvCacheDtype && runtimePreset.kvCacheDtype !== opts.kvCacheDtype) {
        appendLog(job, `KV cache dtype override: ${opts.kvCacheDtype || "auto"} -> ${runtimePreset.kvCacheDtype}.`);
      }
    }
    if (launch.effectiveLoadFormat === "gguf") {
      appendLog(job, `GGUF mode: using ${modelArg}`);
      if (launch.selectedGgufFile && launch.ggufFiles.length > 1) {
        appendLog(job, `Multiple GGUF files found; selected largest file: ${path.basename(launch.selectedGgufFile)}`);
      }
      if (!opts.tokenizer) {
        appendLog(job, "GGUF warning: tokenizer is empty. vLLM can try GGUF tokenizer conversion, but a base Hugging Face tokenizer is usually faster and more stable.");
      }
    }

    const activePublishArgs = dockerPublishArgs(opts.port, opts.networkAccess, opts.serviceHost);
    appendLog(job, `Docker publish: ${formatDockerPublishArgs(activePublishArgs)}`);
    const runArgs = [
      "run", "-d",
      "--name", CONFIG.containerName,
      "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
      "--label", `${MANAGER_ENGINE_LABEL_KEY}=vllm`,
      "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
      "--ipc=host",
      ...publishArgsToDockerRunArgs(activePublishArgs),
      "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
      "-v", `${CONFIG.modelsRoot}:/models`,
    ];
    if (opts.vllmApiKey) {
      runArgs.push("--label", `${MANAGER_APIKEY_LABEL_KEY}=${opts.vllmApiKey}`);
    }
    if (opts.networkAccess === "lan" && !opts.vllmApiKey) {
      appendLog(job, `安全警告：服务将通过 Docker 发布到 ${opts.serviceHost || getLanAddress()}（局域网可访问），但没有设置 API Key。同一网络内的任何设备都可以调用该模型。建议在启动参数中填写 API Key。`);
    }
    const selectedGpuIds = normalizeGpuIds(opts.gpuDeviceIds);
    if (selectedGpuIds.length) {
      appendLog(job, `GPU isolation: --gpus device=${selectedGpuIds.join(",")}`);
    }
    if (process.env.HF_TOKEN) runArgs.push("-e", `HF_TOKEN=${process.env.HF_TOKEN}`);
    for (const [key, value] of Object.entries(runtimePreset.env || {})) {
      if (value !== undefined && value !== null && value !== "") runArgs.push("-e", `${key}=${value}`);
    }

    runArgs.push(
      runtimeImage,
      "--model", modelArg,
      "--served-model-name", opts.name,
      "--dtype", opts.dtype,
      "--max-model-len", String(opts.maxModelLen),
      "--max-num-seqs", String(opts.maxNumSeqs),
      "--gpu-memory-utilization", String(opts.gpuMemoryUtilization)
    );
    if (quantization.value) runArgs.push("--quantization", quantization.value);
    if (launch.effectiveLoadFormat === "gguf") {
      if (opts.quantization || quantization.value) {
        appendLog(job, `Ignoring quantization "${opts.quantization || quantization.value}" because GGUF already contains quantized weights.`);
      }
      const quantIndex = runArgs.indexOf("--quantization");
      if (quantIndex >= 0) runArgs.splice(quantIndex, 2);
      runArgs.push("--load-format", "gguf");
    }
    if (opts.tokenizer) runArgs.push("--tokenizer", windowsPathToContainerPath(opts.tokenizer));
    if (opts.hfConfigPath) runArgs.push("--hf-config-path", windowsPathToContainerPath(opts.hfConfigPath));
    if (effectiveKvCacheDtype && effectiveKvCacheDtype !== "auto") runArgs.push("--kv-cache-dtype", effectiveKvCacheDtype);
    if (opts.cpuOffloadGb > 0) runArgs.push("--cpu-offload-gb", String(opts.cpuOffloadGb));
    if (opts.kvOffloadingSize > 0) runArgs.push("--kv-offloading-size", String(opts.kvOffloadingSize));
    if (opts.mmProcessorCacheGb !== null && opts.mmProcessorCacheGb !== undefined) {
      runArgs.push("--mm-processor-cache-gb", String(opts.mmProcessorCacheGb));
    }
    if (opts.enablePrefixCaching && runtimePreset.disablePrefixCaching) {
      appendLog(job, "Runtime preset disabled prefix caching for this architecture.");
    } else if (opts.enablePrefixCaching) {
      runArgs.push("--enable-prefix-caching");
    }
    if (opts.languageModelOnly && runtimePreset.disableLanguageModelOnly) {
      appendLog(job, "Runtime preset disabled --language-model-only because this architecture is not a plain language-only model.");
    } else if (opts.languageModelOnly) {
      runArgs.push("--language-model-only");
    }
    if (opts.trustRemoteCode || runtimePreset.forceTrustRemoteCode) runArgs.push("--trust-remote-code");
    if (opts.tensorParallelSize > 1) runArgs.push("--tensor-parallel-size", String(opts.tensorParallelSize));
    if (opts.pipelineParallelSize > 1) runArgs.push("--pipeline-parallel-size", String(opts.pipelineParallelSize));
    if (opts.dataParallelSize > 1) runArgs.push("--data-parallel-size", String(opts.dataParallelSize));
    if (opts.distributedExecutorBackend && opts.distributedExecutorBackend !== "auto") {
      runArgs.push("--distributed-executor-backend", opts.distributedExecutorBackend);
    }
    if (opts.enableExpertParallel) runArgs.push("--enable-expert-parallel");
    if (runtimePreset.enforceEager) runArgs.push("--enforce-eager");
    if (runtimePreset.attentionBackend) runArgs.push("--attention-backend", runtimePreset.attentionBackend);
    if (runtimePreset.overrideGenerationConfig) runArgs.push("--override-generation-config", runtimePreset.overrideGenerationConfig);
    if (runtimePreset.defaultChatTemplateKwargs) runArgs.push("--default-chat-template-kwargs", runtimePreset.defaultChatTemplateKwargs);
    if (effectiveReasoningParser && effectiveReasoningParser !== "auto") {
      runArgs.push("--reasoning-parser", effectiveReasoningParser);
    }
    if (effectiveAutoToolChoice && effectiveToolCallParser) {
      runArgs.push("--enable-auto-tool-choice", "--tool-call-parser", effectiveToolCallParser);
    }
    if (opts.vllmApiKey) runArgs.push("--api-key", opts.vllmApiKey);

    return { runArgs, activePublishArgs };
  }

  return {
    buildVllmRuntimeCommand,
    formatDockerPublishArgs,
    redactDockerArgs,
  };
}

module.exports = { createVllmRuntimeCommandBuilder };
