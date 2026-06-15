function createVllmStartRuntimeRequest(deps) {
  const {
    CONFIG,
    cleanRequired,
    deriveName,
    positiveInt,
    nonNegativeNumber,
    optionalNonNegativeNumber,
    normalizeDtype,
    normalizeQuantization,
    normalizeLoadFormat,
    cleanOptionalLaunchArg,
    normalizeKvCacheDtype,
    normalizeLaunchGpuSelection,
    normalizeGpuIds,
    normalizeClientPreset,
    normalizeReasoningParser,
    normalizeToolCallParser,
    inferToolCallParser,
    normalizeNetworkAccess,
    getLanAddress,
    createJob,
    runStartJob,
    failJob,
  } = deps;

  return async function startRuntimeRequest({ body = {} } = {}) {
    const model = cleanRequired(body.model, "model");
    const name = String(body.name || deriveName(model));
    const port = Number(body.port || CONFIG.defaultPort);
    const maxModelLen = Number(body.maxModelLen || 8192);
    const maxNumSeqs = positiveInt(body.maxNumSeqs, 4);
    const gpuMemoryUtilization = Number(body.gpuMemoryUtilization || 0.9);
    const cpuOffloadGb = nonNegativeNumber(body.cpuOffloadGb, 0);
    const kvOffloadingSize = nonNegativeNumber(body.kvOffloadingSize, 0);
    const mmProcessorCacheGb = optionalNonNegativeNumber(body.mmProcessorCacheGb);
    const dtype = normalizeDtype(body.dtype);
    const quantization = normalizeQuantization(body.quantization);
    const loadFormat = normalizeLoadFormat(body.loadFormat);
    const tokenizer = cleanOptionalLaunchArg(body.tokenizer);
    const hfConfigPath = cleanOptionalLaunchArg(body.hfConfigPath);
    const kvCacheDtype = normalizeKvCacheDtype(body.kvCacheDtype);
    const trustRemoteCode = Boolean(body.trustRemoteCode);
    const gpuSelection = await normalizeLaunchGpuSelection(normalizeGpuIds(body.gpuDeviceIds));
    const gpuDeviceIds = gpuSelection.gpuDeviceIds;
    const requestedMultiGpuMode = String(body.multiGpuMode || "single");
    const multiGpuMode = gpuSelection.selectedCount < 2 ? "single" : requestedMultiGpuMode;
    const visibleGpuCount = Math.max(1, gpuSelection.selectedCount || gpuDeviceIds.length || Number(body.gpuCount || 1));
    const tensorParallelSize = multiGpuMode === "tensor" ? positiveInt(body.tensorParallelSize, visibleGpuCount) : 1;
    const pipelineParallelSize = multiGpuMode === "pipeline" ? positiveInt(body.pipelineParallelSize, visibleGpuCount) : 1;
    const dataParallelSize = multiGpuMode === "data" ? positiveInt(body.dataParallelSize, visibleGpuCount) : 1;
    const distributedExecutorBackend = String(body.distributedExecutorBackend || "auto");
    const enableExpertParallel = Boolean(body.enableExpertParallel);
    const enablePrefixCaching = Boolean(body.enablePrefixCaching);
    const languageModelOnly = Boolean(body.languageModelOnly);
    const clientPreset = normalizeClientPreset(body.clientPreset);
    const reasoningParser = normalizeReasoningParser(body.reasoningParser);
    const requestedToolCallParser = normalizeToolCallParser(body.toolCallParser);
    const toolCallParser = requestedToolCallParser === "auto"
      ? inferToolCallParser(model, clientPreset)
      : requestedToolCallParser;
    const enableAutoToolChoice = Boolean(body.enableAutoToolChoice) && Boolean(toolCallParser);
    const networkAccess = normalizeNetworkAccess(body.networkAccess);
    const vllmApiKey = String(body.apiKey || "").trim();
    const lanAddress = getLanAddress();
    const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
    const serviceUrl = `http://${serviceHost}:${port}/v1`;

    const job = createJob("serve", `Start ${name}`, {
      model,
      name,
      port,
      maxModelLen,
      maxNumSeqs,
      gpuMemoryUtilization,
      cpuOffloadGb,
      kvOffloadingSize,
      mmProcessorCacheGb,
      dtype,
      quantization,
      loadFormat,
      tokenizer,
      hfConfigPath,
      kvCacheDtype,
      trustRemoteCode,
      gpuDeviceIds,
      multiGpuMode,
      tensorParallelSize,
      pipelineParallelSize,
      dataParallelSize,
      gpuWarnings: gpuSelection.warnings,
      distributedExecutorBackend,
      enableExpertParallel,
      enablePrefixCaching,
      languageModelOnly,
      clientPreset,
      reasoningParser,
      enableAutoToolChoice,
      toolCallParser,
      networkAccess,
      hasApiKey: Boolean(vllmApiKey),
      serviceHost,
      serviceUrl,
    });

    runStartJob(job, {
      model,
      name,
      port,
      maxModelLen,
      maxNumSeqs,
      gpuMemoryUtilization,
      cpuOffloadGb,
      kvOffloadingSize,
      mmProcessorCacheGb,
      dtype,
      quantization,
      loadFormat,
      tokenizer,
      hfConfigPath,
      kvCacheDtype,
      trustRemoteCode,
      gpuDeviceIds,
      multiGpuMode,
      tensorParallelSize,
      pipelineParallelSize,
      dataParallelSize,
      gpuWarnings: gpuSelection.warnings,
      distributedExecutorBackend,
      enableExpertParallel,
      enablePrefixCaching,
      languageModelOnly,
      clientPreset,
      reasoningParser,
      enableAutoToolChoice,
      toolCallParser,
      networkAccess,
      vllmApiKey,
      serviceHost,
      serviceUrl,
    }).catch((error) => failJob(job, error));

    return { job };
  };
}

module.exports = {
  createVllmStartRuntimeRequest,
};
