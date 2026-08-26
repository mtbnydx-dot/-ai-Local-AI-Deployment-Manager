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
    normalizeRuntimeEngine = (value) => String(value || "vllm").trim().toLowerCase() === "sglang" ? "sglang" : "vllm",
    checkModelCompatibility = null,
    getLanAddress,
    createJob,
    runStartJob,
    failJob,
    acquireGpuAdmission = null,
    acquireGpuAdmissionAfterPrepare = null,
    reportGpuAdmissionError = () => {},
    saveRuntimeApiKey = async () => "",
    deleteRuntimeApiKey = async () => {},
    normalizeRuntimeInstanceMode = (value) => String(value || "replace").toLowerCase() === "parallel" ? "parallel" : "replace",
    normalizeRuntimeInstanceId = (value, fallback) => String(value || fallback || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "model",
    buildRuntimeContainerName = (base, mode, id) => mode === "parallel" ? `${base}-${id}` : base,
  } = deps;

  return async function startRuntimeRequest({ body = {} } = {}) {
    const model = cleanRequired(body.model, "model");
    const name = String(body.name || deriveName(model));
    const engine = normalizeRuntimeEngine(body.engine);
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
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      const error = new Error("port 必须是 1024 到 65535 之间的整数。");
      error.status = 400;
      throw error;
    }
    const maxModelLen = boundedPositiveInteger(body.maxModelLen, 8192, "maxModelLen", 4_194_304);
    const maxNumSeqs = boundedPositiveInteger(body.maxNumSeqs, 4, "maxNumSeqs", 1024);
    const maxNumBatchedTokens = boundedNonNegativeInteger(body.maxNumBatchedTokens, 0, "maxNumBatchedTokens", 4_194_304);
    const gpuMemoryUtilization = boundedNumber(
      body.gpuMemoryUtilization,
      instanceMode === "parallel" ? 0.7 : 0.92,
      "gpuMemoryUtilization",
      0.05,
      1,
    );
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
    const requestedGpuDeviceIds = normalizeGpuIds(body.gpuDeviceIds);
    const gpuSelectionExplicit = requestedGpuDeviceIds.length > 0;
    const gpuSelection = await normalizeLaunchGpuSelection(requestedGpuDeviceIds);
    let gpuDeviceIds = gpuSelection.gpuDeviceIds;
    const requestedMultiGpuMode = String(body.multiGpuMode || "single");
    const multiGpuMode = gpuSelection.selectedCount < 2 ? "single" : requestedMultiGpuMode;
    const visibleGpuCount = Math.max(1, gpuSelection.selectedCount || gpuDeviceIds.length || Number(body.gpuCount || 1));
    const tensorParallelSize = multiGpuMode === "tensor" ? positiveInt(body.tensorParallelSize, visibleGpuCount) : 1;
    const pipelineParallelSize = multiGpuMode === "pipeline" ? positiveInt(body.pipelineParallelSize, visibleGpuCount) : 1;
    const dataParallelSize = multiGpuMode === "data" ? positiveInt(body.dataParallelSize, visibleGpuCount) : 1;
    const distributedExecutorBackend = String(body.distributedExecutorBackend || "auto");
    const enableExpertParallel = Boolean(body.enableExpertParallel);
    const disablePrefixCaching = Boolean(body.disablePrefixCaching);
    const enablePrefixCaching = Object.hasOwn(body, "enablePrefixCaching")
      ? Boolean(body.enablePrefixCaching)
      : !disablePrefixCaching;
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
    const runtimeImage = normalizeRuntimeImage(body.runtimeImage);
    const draftModel = String(body.draftModel || "").trim();
    const dsparkBlockSize = boundedPositiveInteger(body.dsparkBlockSize, 7, "dsparkBlockSize", 32);
    const lanAddress = getLanAddress();
    const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
    const serviceUrl = `http://${serviceHost}:${port}/v1`;

    let modelCompatibility = null;
    if (typeof checkModelCompatibility === "function") {
      modelCompatibility = await checkModelCompatibility({
        ...body,
        model,
        loadFormat,
        quantization,
        speculativeMode,
        engine,
        draftModel,
        remote: false,
      });
      if (!modelCompatibility?.ok) {
        const blockingFindings = (modelCompatibility?.findings || [])
          .filter((item) => item.severity === "fail");
        const details = blockingFindings
          .map((item) => `${item.title}: ${item.detail}`)
          .join("；");
        const error = new Error(`模型启动前校验失败：${details || "模型文件或运行时不兼容"}`);
        error.status = 422;
        if (blockingFindings.some((item) => /Muse Glimmer/i.test(`${item.title || ""} ${item.detail || ""}`))) {
          error.code = "muse_glimmer_vllm_unsupported";
        }
        error.findings = modelCompatibility?.findings || [];
        throw error;
      }
    }

    const gpuAdmissionRequest = {
        managerId: CONFIG.managerId,
        engine,
        instanceMode,
        instanceId,
        containerName,
        model,
        gpuIds: gpuDeviceIds,
        useAllGpus: multiGpuMode !== "single",
        requestedFraction: gpuMemoryUtilization,
        estimatePolicy: "vllm_gpu_memory_utilization",
        maxModelLen,
        maxNumSeqs,
        maxNumBatchedTokens,
      };
    let admissionLease = null;
    if (instanceMode === "parallel" && typeof acquireGpuAdmission === "function") {
      admissionLease = await acquireGpuAdmission(gpuAdmissionRequest);
    } else if (instanceMode === "replace"
      && typeof acquireGpuAdmission === "function"
      && typeof acquireGpuAdmissionAfterPrepare !== "function") {
      const error = new Error("GPU replacement admission is unavailable; the existing model was not changed.");
      error.code = "vram_admission_unavailable";
      error.status = 503;
      throw error;
    }
    let admission = admissionLease?.summary || null;
    if (!gpuDeviceIds.length && admission?.reservations?.length) {
      // Docker interprets an empty selection as "all GPUs". Bind the runtime to
      // exactly the devices that the atomic admission controller reserved.
      gpuDeviceIds = Array.from(new Set(admission.reservations
        .map((reservation) => String(reservation.gpuIndex ?? reservation.gpuId ?? "").trim())
        .filter(Boolean)));
    }
    let runtimeApiKeyRef = "";
    try {
      if (vllmApiKey) runtimeApiKeyRef = await saveRuntimeApiKey(vllmApiKey);
    } catch (error) {
      try { await admissionLease?.release?.("api-key-store-failed"); } catch {}
      throw error;
    }
    let job;
    try {
      job = createJob("serve", `Start ${name}`, {
        model,
        engine,
        name,
        instanceMode,
        instanceId,
        containerName,
        port,
        maxModelLen,
        maxNumSeqs,
        maxNumBatchedTokens,
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
        gpuSelectionExplicit,
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
        runtimeImage,
        draftModel,
        dsparkBlockSize,
        gpuAdmission: admission,
      });
    } catch (error) {
      try {
        await admissionLease?.release?.("job-create-failed");
      } catch {} finally {
        try { await deleteRuntimeApiKey(runtimeApiKeyRef); } catch {}
      }
      throw error;
    }

    const runOptions = {
      model,
      engine,
      name,
      instanceMode,
      instanceId,
      containerName,
      port,
      maxModelLen,
      maxNumSeqs,
      maxNumBatchedTokens,
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
      gpuSelectionExplicit,
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
      runtimeApiKeyRef,
      serviceHost,
      serviceUrl,
      speculativeMode,
      numSpeculativeTokens,
      runtimeImage,
      draftModel,
      dsparkBlockSize,
      modelCompatibility,
      vramReservationMb: Number(admission?.requestedTotalMb || 0),
      gpuAdmissionLeaseId: String(admission?.id || ""),
      gpuAdmissionFinalized: Boolean(admissionLease),
    };
    let stopAdmissionHeartbeat = () => {};
    const attachAdmissionLease = (lease) => {
      admissionLease = lease || null;
      admission = admissionLease?.summary || null;
      if (!gpuDeviceIds.length && admission?.reservations?.length) {
        gpuDeviceIds = Array.from(new Set(admission.reservations
          .map((reservation) => String(reservation.gpuIndex ?? reservation.gpuId ?? "").trim())
          .filter(Boolean)));
      }
      job.meta = {
        ...(job.meta || {}),
        gpuDeviceIds,
        gpuAdmission: admission,
      };
      runOptions.gpuDeviceIds = gpuDeviceIds;
      runOptions.vramReservationMb = Number(admission?.requestedTotalMb || 0);
      runOptions.gpuAdmissionLeaseId = String(admission?.id || "");
      runOptions.gpuAdmissionFinalized = Boolean(admissionLease);
      stopAdmissionHeartbeat();
      stopAdmissionHeartbeat = admissionLease?.startHeartbeat?.({
        onError: (error) => reportGpuAdmissionError(job, error),
      }) || (() => {});
      return admissionLease;
    };
    if (admissionLease) attachAdmissionLease(admissionLease);
    if (instanceMode === "replace" && typeof acquireGpuAdmissionAfterPrepare === "function") {
      runOptions.gpuAdmissionRequest = gpuAdmissionRequest;
      runOptions.prepareGpuAdmission = async (prepare) => {
        const prepared = await acquireGpuAdmissionAfterPrepare(gpuAdmissionRequest, prepare);
        attachAdmissionLease(prepared?.lease);
        return prepared?.context;
      };
    }
    Promise.resolve()
      .then(() => runStartJob(job, runOptions))
      .then(async () => {
        stopAdmissionHeartbeat();
        if (job.status === "success") {
          try {
            await admissionLease?.commit?.({ jobId: job.id, containerName });
          } catch (error) {
            reportGpuAdmissionError(job, error);
          }
        } else {
          try {
            await admissionLease?.release?.(`job-${job.status || "finished-without-success"}`);
          } catch (error) {
            reportGpuAdmissionError(job, error);
          } finally {
            try {
              await deleteRuntimeApiKey(runtimeApiKeyRef);
            } catch (error) {
              reportGpuAdmissionError(job, error);
            }
          }
        }
      }, async (error) => {
        stopAdmissionHeartbeat();
        persistAsyncRuntimeFailure(job, error);
        try {
          await admissionLease?.release?.("start-failed");
        } catch (releaseError) {
          reportGpuAdmissionError(job, releaseError);
        } finally {
          try { await deleteRuntimeApiKey(runtimeApiKeyRef); } catch {}
        }
        failJob(job, error);
      });

    return { job };
  };
}

function persistAsyncRuntimeFailure(job, error) {
  if (!job || typeof job !== "object") return;
  const errorCode = String(error?.code || "runtime_error")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_") || "runtime_error";
  const findings = Array.isArray(error?.findings)
    ? error.findings.map((item) => ({
      severity: String(item?.severity || "error").trim().toLowerCase(),
      title: String(item?.title || "Runtime error").trim(),
      detail: String(item?.detail || item?.message || "").trim(),
    }))
    : [];
  job.meta = {
    ...(job.meta || {}),
    errorCode,
    findings,
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

function boundedNonNegativeInteger(value, fallback, name, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    const error = new Error(`${name} 必须是 0 到 ${max} 之间的整数。`);
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

function normalizeRuntimeImage(value) {
  const image = String(value || "").trim();
  if (!image) return "";
  if (!/^[a-z0-9][a-z0-9._/:@-]{0,511}$/i.test(image)) {
    const error = new Error("runtimeImage 必须是合法的 Docker 镜像引用，且不能包含空格或命令选项。");
    error.status = 400;
    throw error;
  }
  return image;
}

module.exports = {
  createVllmStartRuntimeRequest,
  normalizeRuntimeImage,
  persistAsyncRuntimeFailure,
};
