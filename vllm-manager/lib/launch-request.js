const { isPennyroyalImage, pennyroyalRecipeMemory } = require("./pennyroyal");
const { createLaunchPlanner } = require("../../manager-core/engines/resolve-launch-plan");
const memoryModels = require("../../manager-core/engines/memory-models");

function createVllmStartRuntimeRequest(deps) {
  const {
    CONFIG,
    cleanRequired,
    resolveRequestedModel = value => value,
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
    // Defaults to the lease-warning log line the servers already write.
    reportGpuAdmissionWarning = (job, message) => reportGpuAdmissionError(job, new Error(message)),
    saveRuntimeApiKey = async () => "",
    deleteRuntimeApiKey = async () => {},
    normalizeRuntimeInstanceMode = (value) => String(value || "replace").toLowerCase() === "parallel" ? "parallel" : "replace",
    normalizeRuntimeInstanceId = (value, fallback) => String(value || fallback || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "model",
    buildRuntimeContainerName = (base, mode, id) => mode === "parallel" ? `${base}-${id}` : base,
    // Launch plan (01-engines ENG-7): the resolver, the engine registry and the
    // recipes default to the shared ones; the server adds the command preview
    // (the runtime-command builder's prepareLaunch), GPU telemetry, image
    // presence, the gpu-admission preview and the container listing.
    getEngineRegistry = null,
    getRecipeStore = null,
    paramCatalog = null,
    prepareLaunchCommand = null,
    getHostGpus = null,
    imagePresence = null,
    admissionPreview = null,
    listContainers = null,
    getIntrospection = null,
    modelStorage = null,
    calibrationFor = null,
  } = deps;

  /**
   * Today's /api/start normalisation of a legacy body, side-effect free: the
   * run options, job.meta and gpu-admission request before admission (the
   * R-* goldens pin all three). The resolver calls it for /api/start and for
   * POST /api/launch/plan alike; a v2 request reaches it as the legacy body
   * the alias table writes. calibrationFor(paramsKey) is the resolver's 02
   * calibration lookup for this request (01-engines §12), null until MOD-10.
   */
  async function normalizeStartBody(body = {}, { calibrationFor: lookupCalibration = null } = {}) {
    const model = resolveRequestedModel(cleanRequired(body.model, "model"));
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
    const sglangMaxTotalTokens = boundedNonNegativeInteger(body.sglangMaxTotalTokens, 0, "sglangMaxTotalTokens", 4_194_304);
    const sglangPageSize = boundedNonNegativeInteger(body.sglangPageSize, 0, "sglangPageSize", 4096);
    const sglangChunkedPrefillSize = boundedNonNegativeInteger(body.sglangChunkedPrefillSize, 0, "sglangChunkedPrefillSize", 4_194_304);
    const sglangFp4GemmBackend = normalizeOptionalChoice(body.sglangFp4GemmBackend, "sglangFp4GemmBackend", [
      "auto", "flashinfer_cudnn", "flashinfer_cutedsl", "flashinfer_cutlass", "flashinfer_trtllm", "marlin",
    ]);
    const sglangAttentionBackend = normalizeOptionalChoice(body.sglangAttentionBackend, "sglangAttentionBackend", [
      "triton", "qsa", "fa4", "flashinfer",
    ]);
    const sglangPleOffloadEmbedding = normalizeBooleanInput(body.sglangPleOffloadEmbedding);
    const sglangLinearAttnPrefillBackend = normalizeOptionalChoice(body.sglangLinearAttnPrefillBackend, "sglangLinearAttnPrefillBackend", [
      "triton", "cutedsl", "flashinfer",
    ]);
    const sglangLinearAttnDecodeBackend = normalizeOptionalChoice(body.sglangLinearAttnDecodeBackend, "sglangLinearAttnDecodeBackend", [
      "triton", "cutedsl", "flashinfer",
    ]);
    const sglangMambaSsmDtype = normalizeOptionalChoice(body.sglangMambaSsmDtype, "sglangMambaSsmDtype", [
      "float32", "bfloat16", "float16",
    ]);
    const sglangMambaRadixCacheStrategy = normalizeOptionalChoice(body.sglangMambaRadixCacheStrategy, "sglangMambaRadixCacheStrategy", [
      "auto", "no_buffer", "extra_buffer", "extra_buffer_lazy",
    ]);
    const sglangMambaTrackInterval = boundedNonNegativeInteger(body.sglangMambaTrackInterval, 0, "sglangMambaTrackInterval", 4_194_304);
    const sglangMaxMambaCacheSize = boundedNonNegativeInteger(body.sglangMaxMambaCacheSize, 0, "sglangMaxMambaCacheSize", 4096);
    const sglangDisableThinkingByDefault = normalizeBooleanInput(body.sglangDisableThinkingByDefault);
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
    // The engine's memory model (manager-core/engines/memory-models.js, 01 §12)
    // owns the admission request: vLLM reserves a fraction of the device;
    // SGLang's --mem-fraction-static is a fraction of the memory free at
    // engine start, and a capped KV pool (--max-total-tokens) lets admission
    // clamp to the safe budget and warn; the Pennyroyal recipe reserves its
    // measured footprint; an exact calibration replaces the SGLang fraction.
    const memoryValues = engine === "sglang"
      ? {
        contextLength: maxModelLen,
        concurrency: maxNumSeqs,
        kvCacheDtype: kvCacheDtype || "auto",
        "sglang.memFractionStatic": gpuMemoryUtilization,
        "sglang.maxTotalTokens": sglangMaxTotalTokens || 0,
        "sglang.chunkedPrefillSize": sglangChunkedPrefillSize,
        "sglang.maxMambaCacheSize": sglangMaxMambaCacheSize,
        tensorParallel: tensorParallelSize,
      }
      : {
        contextLength: maxModelLen,
        concurrency: maxNumSeqs,
        kvCacheDtype: kvCacheDtype || "auto",
        "vllm.gpuMemoryUtilization": gpuMemoryUtilization,
        "vllm.maxNumBatchedTokens": maxNumBatchedTokens,
        tensorParallel: tensorParallelSize,
        pipelineParallel: pipelineParallelSize,
      };
    const memoryKey = memoryModels.paramsKey({ engineId: engine, values: memoryValues });
    const calibration = typeof lookupCalibration === "function" ? (await lookupCalibration(memoryKey)) || null : null;
    const memory = memoryModels.estimate(engine, {
      values: memoryValues,
      mode: instanceMode,
      recipeMemory: engine === "sglang" && isPennyroyalImage(runtimeImage)
        ? pennyroyalRecipeMemory({ sglangMaxTotalTokens, maxModelLen })
        : null,
      calibration,
    });
    Object.assign(gpuAdmissionRequest, { requestedFraction: undefined }, memory.admissionRequest);
    const jobMeta = {
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
      sglangMaxTotalTokens,
      sglangPageSize,
      sglangChunkedPrefillSize,
      sglangFp4GemmBackend,
      sglangAttentionBackend,
      sglangPleOffloadEmbedding,
      sglangLinearAttnPrefillBackend,
      sglangLinearAttnDecodeBackend,
      sglangMambaSsmDtype,
      sglangMambaRadixCacheStrategy,
      sglangMambaTrackInterval,
      sglangMaxMambaCacheSize,
      sglangDisableThinkingByDefault,
      gpuAdmission: null,
    };
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
      runtimeApiKeyRef: "",
      serviceHost,
      serviceUrl,
      speculativeMode,
      numSpeculativeTokens,
      runtimeImage,
      draftModel,
      dsparkBlockSize,
      sglangMaxTotalTokens,
      sglangPageSize,
      sglangChunkedPrefillSize,
      sglangFp4GemmBackend,
      sglangAttentionBackend,
      sglangPleOffloadEmbedding,
      sglangLinearAttnPrefillBackend,
      sglangLinearAttnDecodeBackend,
      sglangMambaSsmDtype,
      sglangMambaRadixCacheStrategy,
      sglangMambaTrackInterval,
      sglangMaxMambaCacheSize,
      sglangDisableThinkingByDefault,
      modelCompatibility,
      vramReservationMb: 0,
      gpuAdmissionLeaseId: "",
      gpuAdmissionFinalized: false,
    };
    return { runOptions, jobMeta, admissionRequest: gpuAdmissionRequest, memory };
  }

  const planner = createLaunchPlanner({
    managerId: "vllm",
    normalize: normalizeStartBody,
    getEngineRegistry,
    getRecipeStore,
    paramCatalog,
    prepareLaunchCommand,
    getHostGpus,
    imagePresence,
    admissionPreview,
    listContainers,
    getIntrospection,
    modelStorage,
    calibrationFor,
  });

  async function startRuntimeRequest({ body = {} } = {}) {
    // alias → resolver → requestToLegacyRunOptions: what was planned is what runs.
    const plan = await planner.launch(body);
    const runOptions = planner.runOptions(plan);
    const gpuAdmissionRequest = plan.legacy.admissionRequest;
    const { name, engine, instanceMode, containerName, vllmApiKey } = runOptions;
    let { gpuDeviceIds } = runOptions;
    // SGLang requests with a KV pool cap (the fraction of free memory, or a
    // calibration) are the ones admission may clamp; job.meta.admission
    // reports that decision. The Pennyroyal measured request has no cap.
    const sglangClampable = engine === "sglang" && Object.hasOwn(gpuAdmissionRequest || {}, "poolCappedTokens");
    const admissionPolicy = plan.memory?.policy || "static-fraction-of-free";
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
        ...plan.legacy.jobMeta,
        gpuDeviceIds,
        gpuAdmission: admission,
        // A relaunch (ENG-13) records its launch with source "relaunch".
        ...(body?.source === "relaunch" ? { launchSource: "relaunch" } : {}),
      });
    } catch (error) {
      try {
        await admissionLease?.release?.("job-create-failed");
      } catch {} finally {
        try { await deleteRuntimeApiKey(runtimeApiKeyRef); } catch {}
      }
      throw error;
    }

    Object.assign(runOptions, {
      gpuDeviceIds,
      runtimeApiKeyRef,
      vramReservationMb: Number(admission?.requestedTotalMb || 0),
      gpuAdmissionLeaseId: String(admission?.id || ""),
      gpuAdmissionFinalized: Boolean(admissionLease),
    });
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
        ...(sglangClampable && admission ? { admission: summarizeFractionOfFreeAdmission(admission, admissionPolicy) } : {}),
      };
      if (sglangClampable && admission?.warning) reportGpuAdmissionWarning(job, admission.warning);
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

    return { job, plan: planner.summary(plan) };
  }

  startRuntimeRequest.planLaunch = (body) => planner.plan(body);
  return startRuntimeRequest;
}

// job.meta.admission for SGLang launches admitted by fraction of free memory.
// Lease reservations hold the reserved MiB in requestedMb and the unclamped
// request in estimateMb.
function summarizeFractionOfFreeAdmission(lease = {}, policy = "static-fraction-of-free") {
  const reservations = Array.isArray(lease.reservations) ? lease.reservations : [];
  const total = (read) => reservations.reduce((sum, reservation) => sum + (Number(read(reservation)) || 0), 0);
  return {
    verdict: lease.verdict === "warn" ? "warn" : "ok",
    requestedMb: total((reservation) => reservation?.estimateMb ?? reservation?.requestedMb),
    reservedMb: total((reservation) => reservation?.requestedMb),
    availableMb: total((reservation) => reservation?.availableMb),
    clamped: Boolean(lease.clamped),
    policy,
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

function normalizeOptionalChoice(value, name, allowedValues) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!new Set(allowedValues).has(normalized)) {
    const error = new Error(`${name} 必须是以下值之一：${allowedValues.join(", ")}。`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeBooleanInput(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
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
