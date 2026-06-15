function createLlamaStartRuntimeRequest(deps) {
  const {
    CONFIG,
    cleanRequired,
    deriveName,
    positiveInt,
    normalizeGpuLayers,
    normalizeLlamaCacheType,
    normalizeOnOffAuto,
    normalizeLaunchGpuSelection,
    normalizeGpuIds,
    normalizeLlamaSplitMode,
    cleanOptionalLaunchArg,
    normalizeClientPreset,
    normalizeLlamaReasoningFormat,
    normalizeDefaultTrueBoolean,
    normalizeNetworkAccess,
    getLanAddress,
    getGpuStatus,
    buildLlamaGpuPlan,
    suggestTensorSplit,
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
    const gpuMemoryUtilization = Number(body.gpuMemoryUtilization || 0.92);
    const gpuLayers = normalizeGpuLayers(body.gpuLayers);
    const batchSize = positiveInt(body.batchSize, 2048);
    const ubatchSize = positiveInt(body.ubatchSize, 512);
    const cacheTypeK = normalizeLlamaCacheType(body.cacheTypeK || body.kvCacheDtype);
    const cacheTypeV = normalizeLlamaCacheType(body.cacheTypeV || body.kvCacheDtype);
    const flashAttention = normalizeOnOffAuto(body.flashAttention);
    const noMmap = Boolean(body.noMmap);
    const gpuSelection = await normalizeLaunchGpuSelection(normalizeGpuIds(body.gpuDeviceIds));
    const gpuDeviceIds = gpuSelection.gpuDeviceIds;
    const requestedMultiGpuMode = normalizeLlamaSplitMode(body.multiGpuMode || body.splitMode);
    const multiGpuMode = gpuSelection.selectedCount < 2 ? "none" : requestedMultiGpuMode;
    const visibleGpuCount = Math.max(1, gpuSelection.selectedCount || gpuDeviceIds.length || Number(body.gpuCount || 1));
    const tensorSplit = multiGpuMode === "none" ? "" : cleanOptionalLaunchArg(body.tensorSplit);
    const clientPreset = normalizeClientPreset(body.clientPreset);
    const reasoning = normalizeOnOffAuto(body.reasoning);
    const reasoningFormat = normalizeLlamaReasoningFormat(body.reasoningFormat || body.reasoningParser);
    const textOnlyMode = normalizeDefaultTrueBoolean(body.textOnlyMode, body.languageModelOnly);
    const networkAccess = normalizeNetworkAccess(body.networkAccess);
    const lanAddress = getLanAddress();
    const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
    const serviceUrl = `http://${serviceHost}:${port}/v1`;
    const gpu = await getGpuStatus().catch(() => ({ gpus: [] }));
    const gpuPlan = buildLlamaGpuPlan(gpu, gpuDeviceIds, gpuMemoryUtilization, multiGpuMode, body.mainGpu);
    const mainGpu = gpuPlan.mainGpu;
    const effectiveTensorSplit = tensorSplit || suggestTensorSplit(gpu.gpus || [], gpuDeviceIds, gpuMemoryUtilization, multiGpuMode);

    const job = createJob("serve", `Start ${name}`, {
      model,
      name,
      port,
      maxModelLen,
      maxNumSeqs,
      gpuMemoryUtilization,
      gpuLayers,
      batchSize,
      ubatchSize,
      cacheTypeK,
      cacheTypeV,
      flashAttention,
      noMmap,
      gpuDeviceIds,
      multiGpuMode,
      visibleGpuCount,
      tensorSplit: effectiveTensorSplit,
      mainGpu,
      mainGpuHostId: gpuPlan.mainGpuHostId,
      gpuPlan,
      gpuWarnings: gpuSelection.warnings,
      clientPreset,
      reasoning,
      reasoningFormat,
      textOnlyMode,
      languageModelOnly: textOnlyMode,
      networkAccess,
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
      gpuLayers,
      batchSize,
      ubatchSize,
      cacheTypeK,
      cacheTypeV,
      flashAttention,
      noMmap,
      gpuDeviceIds,
      multiGpuMode,
      visibleGpuCount,
      tensorSplit: effectiveTensorSplit,
      mainGpu,
      mainGpuHostId: gpuPlan.mainGpuHostId,
      gpuPlan,
      gpuWarnings: gpuSelection.warnings,
      clientPreset,
      reasoning,
      reasoningFormat,
      textOnlyMode,
      languageModelOnly: textOnlyMode,
      networkAccess,
      serviceHost,
      serviceUrl,
    }).catch((error) => failJob(job, error));

    return { job };
  };
}

module.exports = {
  createLlamaStartRuntimeRequest,
};
