const path = require("path");

function createVllmRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_REF_LABEL_KEY,
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
    const secrets = [opts.vllmApiKey, process.env.HF_TOKEN]
      .map((value) => String(value || ""))
      .filter((value) => value.length >= 6);
    if (!secrets.length) return args;
    return args.map((arg) => secrets.reduce((value, secret) => String(value).replaceAll(secret, "***"), String(arg)));
  }

  function buildVllmRuntimeCommand(job, opts) {
    const launch = resolveLaunchModel(opts.model, opts.loadFormat);
    const modelArg = launch.modelArg;
    const quantization = effectiveLaunchQuantization(opts.quantization, launch);
    const runtimePreset = resolveVllmRuntimePreset(opts, launch);
    const runtimeEngine = normalizeRuntimeEngine(runtimePreset.engine || opts.engine);
    const runtimeImage = runtimePreset.image || CONFIG.image;
    const effectiveDtype = runtimePreset.dtype || opts.dtype;
    const effectiveKvCacheDtype = runtimePreset.kvCacheDtype || opts.kvCacheDtype;
    const effectiveKvCacheDtypeArg = runtimePreset.disableKvCacheDtypeArg ? "" : effectiveKvCacheDtype;
    const effectiveReasoningParser = runtimePreset.reasoningParser || opts.reasoningParser;
    const effectiveToolCallParser = runtimePreset.toolCallParser || opts.toolCallParser;
    const effectiveAutoToolChoice = Boolean(runtimePreset.enableAutoToolChoice || opts.enableAutoToolChoice);
    const effectiveMaxNumBatchedTokens = Math.max(
      positiveInteger(opts.maxNumBatchedTokens),
      positiveInteger(runtimePreset.maxNumBatchedTokens)
    );

    if (quantization.modelConfigMethod && opts.quantization && quantization.value !== opts.quantization) {
      appendLog(job, `Quantization override: model config declares "${quantization.modelConfigMethod}", ignoring requested "${opts.quantization}".`);
    }
    if (runtimePreset.id) {
      job.meta = {
        ...job.meta,
        runtimePreset: runtimePreset.id,
        engine: runtimeEngine,
        runtimeImage,
        runtimeNotes: runtimePreset.notes || [],
        dtype: effectiveDtype,
        kvCacheDtype: runtimePreset.disableKvCacheDtypeArg ? "auto" : effectiveKvCacheDtype,
        trustRemoteCode: Boolean(opts.trustRemoteCode || runtimePreset.forceTrustRemoteCode),
        enablePrefixCaching: Boolean(opts.enablePrefixCaching && !runtimePreset.disablePrefixCaching),
        // vLLM enables prefix caching by default. The form exposes a *disable*
        // toggle (and presets can force it), so we emit the explicit disable
        // flag instead of relying on "no flag" which still leaves caching on.
        disablePrefixCaching: Boolean(opts.disablePrefixCaching || runtimePreset.disablePrefixCaching),
        languageModelOnly: Boolean(opts.languageModelOnly && !runtimePreset.disableLanguageModelOnly),
        enforceEager: Boolean(runtimePreset.enforceEager),
        reasoningParser: effectiveReasoningParser,
        toolCallParser: effectiveToolCallParser,
        enableAutoToolChoice: effectiveAutoToolChoice,
        moeBackend: runtimePreset.moeBackend || "",
        generationConfig: runtimePreset.generationConfig || "",
        speculativeConfig: runtimePreset.speculativeConfig || null,
        draftModel: runtimePreset.draftModel || opts.draftModel || "",
        dsparkBlockSize: runtimePreset.dsparkBlockSize || opts.dsparkBlockSize || null,
        reasoningParserPlugin: runtimePreset.reasoningParserPlugin || "",
        ...(effectiveMaxNumBatchedTokens ? { maxNumBatchedTokens: effectiveMaxNumBatchedTokens } : {}),
      };
      scheduleJobsSave();
      appendLog(job, `Runtime preset: ${runtimePreset.label || runtimePreset.id}; using ${runtimeEngine} image ${runtimeImage}.`);
      for (const note of runtimePreset.notes || []) appendLog(job, `Runtime preset note: ${note}`);
      if (runtimePreset.kvCacheDtype && runtimePreset.kvCacheDtype !== opts.kvCacheDtype) {
        appendLog(job, `KV cache dtype override: ${opts.kvCacheDtype || "auto"} -> ${runtimePreset.kvCacheDtype}.`);
      }
      if (runtimePreset.dtype && runtimePreset.dtype !== opts.dtype) {
        appendLog(job, `Dtype override: ${opts.dtype || "auto"} -> ${runtimePreset.dtype}.`);
      }
      if (runtimePreset.generationConfig) {
        appendLog(job, `Generation config override: using ${runtimePreset.generationConfig}.`);
      }
      if (runtimePreset.disableKvCacheDtypeArg && opts.kvCacheDtype && opts.kvCacheDtype !== "auto") {
        appendLog(job, `KV cache dtype override: ignoring requested "${opts.kvCacheDtype}" so vLLM can auto-detect this checkpoint.`);
      }
      if (runtimePreset.disableQuantizationArg && quantization.value) {
        appendLog(job, `Quantization override: ignoring requested "${opts.quantization || quantization.value}" so vLLM can auto-detect this checkpoint.`);
      }
      if (runtimePreset.unsupportedReason) {
        appendLog(job, `Runtime preset blocked: ${runtimePreset.unsupportedReason}`);
        throw new Error(runtimePreset.unsupportedReason);
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
    const selectedGpuIds = normalizeGpuIds(opts.gpuDeviceIds);
    const vramReservationMb = Math.max(0, Math.round(Number(opts.vramReservationMb || 0)));
    const runArgs = [
      "run", "-d",
      ...(CONFIG.imagePlatform ? ["--platform", CONFIG.imagePlatform] : []),
      "--pull", "never",
      "--name", opts.containerName || CONFIG.containerName,
      "--restart", "on-failure:3",
      "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
      "--label", `${MANAGER_ENGINE_LABEL_KEY}=${runtimeEngine}`,
      "--label", `ai.manager.job=${job.id}`,
      "--label", `ai.manager.instance=${opts.instanceId || "primary"}`,
      "--label", `ai.manager.instance-mode=${opts.instanceMode || "replace"}`,
      "--label", `ai.manager.model=${opts.name || ""}`,
      "--label", `ai.manager.port=${opts.port}`,
      "--label", `ai.manager.gpu-ids=${selectedGpuIds.join(",")}`,
      "--label", `ai.manager.vram-reservation-mb=${vramReservationMb}`,
      "--label", `ai.manager.max-model-len=${opts.maxModelLen}`,
      "--label", `ai.manager.max-num-seqs=${opts.maxNumSeqs}`,
      "--label", `ai.manager.max-num-batched-tokens=${effectiveMaxNumBatchedTokens || 0}`,
      "--label", `ai.manager.gpu-memory-utilization=${opts.gpuMemoryUtilization}`,
      "--label", `ai.manager.gpu-admission-lease=${opts.gpuAdmissionLeaseId || ""}`,
      "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
      "--ipc=host",
      "--health-cmd", "curl -fsS http://127.0.0.1:8000/health || exit 1",
      "--health-interval", "30s",
      "--health-timeout", "5s",
      "--health-retries", "3",
      "--health-start-period", `${Math.min(60, Math.max(5, Math.round(Math.max(5 * 60 * 1000, Number(process.env.VLLM_START_TIMEOUT_MS || 60 * 60 * 1000)) / 60000)))}m`,
      ...publishArgsToDockerRunArgs(activePublishArgs),
      "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
      "-v", `${CONFIG.modelsRoot}:/models`,
    ];
    if (runtimeEngine === "sglang" && CONFIG.sglangCache) {
      runArgs.push("-v", `${CONFIG.sglangCache}:/root/.cache`);
    } else if (CONFIG.vllmCache) {
      runArgs.push("-v", `${CONFIG.vllmCache}:/root/.cache/vllm`);
    }
    if (opts.runtimeApiKeyRef && MANAGER_APIKEY_REF_LABEL_KEY) {
      runArgs.push("--label", `${MANAGER_APIKEY_REF_LABEL_KEY}=${opts.runtimeApiKeyRef}`);
    }
    if (opts.networkAccess === "lan" && !opts.vllmApiKey) {
      appendLog(job, `安全警告：服务将通过 Docker 发布到 ${opts.serviceHost || getLanAddress()}（局域网可访问），但没有设置 API Key。同一网络内的任何设备都可以调用该模型。建议在启动参数中填写 API Key。`);
    }
    if (selectedGpuIds.length) {
      appendLog(job, `GPU isolation: --gpus device=${selectedGpuIds.join(",")}`);
    }
    if (process.env.HF_TOKEN) runArgs.push("-e", `HF_TOKEN=${process.env.HF_TOKEN}`);
    for (const [key, value] of Object.entries(runtimePreset.env || {})) {
      if (value !== undefined && value !== null && value !== "") runArgs.push("-e", `${key}=${value}`);
    }

    if (runtimeEngine === "sglang") {
      runArgs.push("--entrypoint", "sglang", runtimeImage);
      appendSglangServeArgs(runArgs, {
        ...opts,
        modelArg,
        runtimePreset,
        effectiveReasoningParser,
        effectiveToolCallParser,
        effectiveAutoToolChoice,
      });
      return { runArgs, activePublishArgs, runtimeImage, runtimePreset, runtimeEngine };
    }

    runArgs.push(runtimeImage);
    if (runtimePreset.positionalModel) runArgs.push(modelArg);
    else runArgs.push("--model", modelArg);
    runArgs.push(
      "--served-model-name", opts.name,
      "--dtype", effectiveDtype,
      "--max-model-len", String(opts.maxModelLen),
      "--max-num-seqs", String(opts.maxNumSeqs),
      "--gpu-memory-utilization", String(opts.gpuMemoryUtilization)
    );
    if (effectiveMaxNumBatchedTokens) {
      runArgs.push("--max-num-batched-tokens", String(effectiveMaxNumBatchedTokens));
    }
    if (quantization.value && !runtimePreset.disableQuantizationArg) runArgs.push("--quantization", quantization.value);
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
    if (effectiveKvCacheDtypeArg && effectiveKvCacheDtypeArg !== "auto") runArgs.push("--kv-cache-dtype", effectiveKvCacheDtypeArg);
    if (opts.cpuOffloadGb > 0) runArgs.push("--cpu-offload-gb", String(opts.cpuOffloadGb));
    if (opts.kvOffloadingSize > 0) runArgs.push("--kv-offloading-size", String(opts.kvOffloadingSize));
    if (opts.mmProcessorCacheGb !== null && opts.mmProcessorCacheGb !== undefined) {
      runArgs.push("--mm-processor-cache-gb", String(opts.mmProcessorCacheGb));
    }
    if (opts.disablePrefixCaching || runtimePreset.disablePrefixCaching) {
      runArgs.push("--no-enable-prefix-caching");
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
    if (runtimePreset.asyncScheduling) runArgs.push("--async-scheduling");
    if (runtimePreset.attentionBackend) runArgs.push("--attention-backend", runtimePreset.attentionBackend);
    if (runtimePreset.moeBackend) runArgs.push("--moe-backend", runtimePreset.moeBackend);
    if (runtimePreset.linearBackend) runArgs.push("--linear-backend", runtimePreset.linearBackend);
    if (runtimePreset.generationConfig) runArgs.push("--generation-config", runtimePreset.generationConfig);
    if (runtimePreset.overrideGenerationConfig) runArgs.push("--override-generation-config", runtimePreset.overrideGenerationConfig);
    if (runtimePreset.defaultChatTemplateKwargs) runArgs.push("--default-chat-template-kwargs", runtimePreset.defaultChatTemplateKwargs);
    if (runtimePreset.speculativeConfig) runArgs.push("--speculative-config", JSON.stringify(runtimePreset.speculativeConfig));
    if (runtimePreset.safetensorsLoadStrategy) {
      runArgs.push("--safetensors-load-strategy", runtimePreset.safetensorsLoadStrategy);
    }
    if (runtimePreset.reasoningParserPlugin) {
      runArgs.push("--reasoning-parser-plugin", windowsPathToContainerPath(runtimePreset.reasoningParserPlugin));
    }
    if (effectiveReasoningParser && effectiveReasoningParser !== "auto") {
      runArgs.push("--reasoning-parser", effectiveReasoningParser);
    }
    if (effectiveAutoToolChoice && effectiveToolCallParser) {
      runArgs.push("--enable-auto-tool-choice", "--tool-call-parser", effectiveToolCallParser);
    }
    if (opts.vllmApiKey) runArgs.push("--api-key", opts.vllmApiKey);

    return { runArgs, activePublishArgs, runtimeImage, runtimePreset, runtimeEngine };
  }

  function appendSglangServeArgs(runArgs, options = {}) {
    const { runtimePreset = {} } = options;
    runArgs.push(
      "serve",
      "--model-path", options.modelArg,
      "--served-model-name", options.name,
      "--host", "0.0.0.0",
      "--port", "8000",
      "--tp-size", String(Math.max(1, Number(options.tensorParallelSize || 1))),
      "--mem-fraction-static", String(options.gpuMemoryUtilization),
      "--max-running-requests", String(options.maxNumSeqs),
      "--context-length", String(options.maxModelLen),
      "--chunked-prefill-size", String(runtimePreset.chunkedPrefillSize || 8192),
      "--enable-metrics",
      "--sleep-on-idle"
    );
    if (runtimePreset.mambaSchedulerStrategy) {
      runArgs.push("--mamba-scheduler-strategy", runtimePreset.mambaSchedulerStrategy);
    }
    if (runtimePreset.attentionBackend) runArgs.push("--attention-backend", runtimePreset.attentionBackend);
    if (runtimePreset.disablePrefillCudaGraph) runArgs.push("--disable-prefill-cuda-graph");
    if (runtimePreset.mmFeatureTransport) runArgs.push("--mm-feature-transport", runtimePreset.mmFeatureTransport);
    if (options.disablePrefixCaching || runtimePreset.disablePrefixCaching) runArgs.push("--disable-radix-cache");
    if (options.trustRemoteCode || runtimePreset.forceTrustRemoteCode) runArgs.push("--trust-remote-code");
    if (options.effectiveReasoningParser && options.effectiveReasoningParser !== "auto") {
      runArgs.push("--reasoning-parser", options.effectiveReasoningParser);
    }
    if (options.effectiveAutoToolChoice && options.effectiveToolCallParser) {
      runArgs.push("--tool-call-parser", options.effectiveToolCallParser);
    }
    if (runtimePreset.speculativeAlgorithm === "DSPARK") {
      runArgs.push(
        "--speculative-algorithm", "DSPARK",
        "--speculative-draft-model-path", windowsPathToContainerPath(runtimePreset.draftModel),
        "--speculative-dspark-block-size", String(runtimePreset.dsparkBlockSize || 7),
        "--speculative-draft-model-quantization", runtimePreset.draftModelQuantization || "unquant"
      );
    }
    if (options.vllmApiKey) runArgs.push("--api-key", options.vllmApiKey);
  }

  return {
    buildVllmRuntimeCommand,
    formatDockerPublishArgs,
    redactDockerArgs,
  };
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeRuntimeEngine(value) {
  return String(value || "vllm").trim().toLowerCase() === "sglang" ? "sglang" : "vllm";
}

module.exports = { createVllmRuntimeCommandBuilder, normalizeRuntimeEngine };
