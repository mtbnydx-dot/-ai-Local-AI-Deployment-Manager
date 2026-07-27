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
    normalizeSpeculativeMode = (value) => String(value || "off").trim().toLowerCase(),
    checkModelCompatibility = null,
    getLanAddress,
    createJob,
    runStartJob,
    failJob,
    normalizeRuntimeInstanceMode = (value) => String(value || "replace").toLowerCase() === "parallel" ? "parallel" : "replace",
    normalizeRuntimeInstanceId = (value, fallback) => String(value || fallback || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "model",
    buildRuntimeContainerName = (base, mode, id) => mode === "parallel" ? `${base}-${id}` : base,
  } = deps;

  return async function startRuntimeRequest({ body = {} } = {}) {
    const model = cleanRequired(body.model, "model");
    const name = String(body.name || deriveName(model));
    const instanceMode = normalizeRuntimeInstanceMode(body.instanceMode);
    const instanceId = normalizeRuntimeInstanceId(body.instanceId, name);
    const containerName = buildRuntimeContainerName(CONFIG.containerName, instanceMode, instanceId);
    const hasExplicitPort = body.port !== undefined && body.port !== null && String(body.port).trim() !== "";
    if (instanceMode === "parallel" && !hasExplicitPort) {
      const error = new Error("并行实例必须明确填写独立端口；管理器不会自动修改端口或其他启动参数。");
      error.status = 400;
      throw error;
    }
    const port = Number(hasExplicitPort ? body.port : CONFIG.defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const error = new Error("port 必须是 1 到 65535 之间的整数。");
      error.status = 400;
      throw error;
    }
    const maxModelLen = boundedPositiveInteger(body.maxModelLen, 8192, "maxModelLen", 4_194_304);
    const maxNumSeqs = boundedPositiveInteger(body.maxNumSeqs, 4, "maxNumSeqs", 1024);
    const gpuMemoryUtilization = boundedNumber(body.gpuMemoryUtilization, 0.9, "gpuMemoryUtilization", 0.05, 1);
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
    const disablePrefixCaching = Boolean(body.disablePrefixCaching);
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
    const speculativeMode = normalizeSpeculativeMode(body.speculativeMode, "off");
    const numSpeculativeTokens = positiveInt(body.numSpeculativeTokens, 1);
    const lanAddress = getLanAddress();
    const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
    const serviceUrl = `http://${serviceHost}:${port}/v1`;

    if (typeof checkModelCompatibility === "function") {
      const compatibility = await checkModelCompatibility({
        ...body,
        model,
        loadFormat,
        quantization,
        speculativeMode,
        remote: false,
      });
      if (!compatibility?.ok) {
        const details = (compatibility?.findings || [])
          .filter((item) => item.severity === "fail")
          .map((item) => `${item.title}: ${item.detail}`)
          .join("；");
        const error = new Error(`模型启动前校验失败：${details || "模型文件或运行时不兼容"}`);
        error.status = 422;
        error.findings = compatibility?.findings || [];
        throw error;
      }
    }

    const job = createJob("serve", `Start ${name}`, {
      model,
      name,
      instanceMode,
      instanceId,
      containerName,
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
      disablePrefixCaching,
      languageModelOnly,
      clientPreset,
      reasoningParser,
      enableAutoToolChoice,
      toolCallParser,
      networkAccess,
      hasApiKey: Boolean(vllmApiKey),
      serviceHost,
      serviceUrl,
      speculativeMode,
      numSpeculativeTokens,
    });

    runStartJob(job, {
      model,
      name,
      instanceMode,
      instanceId,
      containerName,
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
      disablePrefixCaching,
      languageModelOnly,
      clientPreset,
      reasoningParser,
      enableAutoToolChoice,
      toolCallParser,
      networkAccess,
      vllmApiKey,
      serviceHost,
      serviceUrl,
      speculativeMode,
      numSpeculativeTokens,
    }).catch((error) => failJob(job, error));

    return { job };
  };
}

function boundedPositiveInteger(value, fallback, name, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    const error = new Error(`${name} 必须是 1 到 ${max} 之间的整数。`);
    error.status = 400;
    throw error;
  }
  return number;
}

function boundedNumber(value, fallback, name, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`${name} 必须是 ${min} 到 ${max} 之间的数字。`);
    error.status = 400;
    throw error;
  }
  return number;
}

module.exports = {
  createVllmStartRuntimeRequest,
};
