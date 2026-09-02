"use strict";

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildGgufInventory,
  estimateGgufKvBytes,
  gpuLayerFraction,
  selectGgufModel,
  findGgufFilesSync,
  findSiblingGgufFilesSync,
} = require("../../manager-core");

const LLAMA_CONTEXT_ESTIMATE_MAX_MB = 512 * 1024;

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
    normalizeLlamaReasoningEffort = (value) => {
      const effort = String(value || "default").trim().toLowerCase();
      return new Set(["default", "minimal", "low", "medium", "high", "xhigh", "max"]).has(effort) ? effort : "default";
    },
    normalizeLlamaReasoningBudget = (value) => {
      const number = Number(value ?? -1);
      return Number.isInteger(number) && number >= -1 && number <= 4_194_304 ? number : -1;
    },
    normalizeLlamaMmprojDevice = (value) => cleanOptionalLaunchArg(value) || "auto",
    normalizeDefaultTrueBoolean,
    normalizeNetworkAccess,
    getLanAddress,
    getGpuStatus,
    buildLlamaGpuPlan,
    suggestTensorSplit,
    createJob,
    runStartJob,
    failJob,
    acquireGpuAdmission = null,
    acquireGpuAdmissionAfterPrepare = null,
    reportGpuAdmissionError = () => {},
    estimateParallelVram = estimateLlamaParallelVram,
    saveRuntimeApiKey = async () => "",
    deleteRuntimeApiKey = async () => {},
    normalizeRuntimeInstanceMode = (value) => String(value || "replace").toLowerCase() === "parallel" ? "parallel" : "replace",
    normalizeRuntimeInstanceId = (value, fallback) => String(value || fallback || "model").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "model",
    buildRuntimeContainerName = (base, mode, id) => mode === "parallel" ? `${base}-${id}` : base,
    resolveLaunchModel = null,
    validateRuntimeCompatibility = null,
  } = deps;

  return async function startRuntimeRequest({ body = {} } = {}) {
    const model = cleanRequired(body.model, "model");
    const launchResolution = typeof resolveLaunchModel === "function" ? resolveLaunchModel(model, "gguf") : null;
    if (launchResolution?.selectedModel && typeof validateRuntimeCompatibility === "function") {
      const compatibility = await validateRuntimeCompatibility(launchResolution.selectedModel.architecture);
      if (compatibility?.supported === false) {
        const error = new Error(compatibility.message || `The configured llama.cpp runtime does not support ${launchResolution.selectedModel.architecture}.`);
        error.code = "llama_runtime_arch_unsupported";
        error.status = 409;
        error.runtimeCompatibility = compatibility;
        throw error;
      }
    }
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
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      const error = new Error("port 必须是 1024 到 65535 之间的整数。");
      error.status = 400;
      throw error;
    }
    const maxModelLen = boundedPositiveInteger(body.maxModelLen, 8192, "maxModelLen", 4_194_304);
    const maxNumSeqs = boundedPositiveInteger(body.maxNumSeqs, 4, "maxNumSeqs", 1024);
    const gpuMemoryUtilization = boundedNumber(
      body.gpuMemoryUtilization,
      instanceMode === "parallel" ? 0.7 : 0.92,
      "gpuMemoryUtilization",
      0.05,
      1,
    );
    const gpuLayers = normalizeGpuLayers(body.gpuLayers);
    const autoFit = String(gpuLayers).trim().toLowerCase() === "auto";
    const fitTargetMb = boundedNonNegativeInteger(
      body.fitTargetMb ?? body.fitTargetMib,
      autoFit ? 1024 : 0,
      "fitTargetMb",
      256 * 1024,
    );
    const fitCtx = boundedNonNegativeInteger(
      body.fitCtx,
      autoFit ? maxModelLen : 0,
      "fitCtx",
      maxModelLen,
    );
    const batchSize = boundedPositiveInteger(body.batchSize, 2048, "batchSize", 1_048_576);
    const ubatchSize = boundedPositiveInteger(body.ubatchSize, 512, "ubatchSize", 1_048_576);
    if (ubatchSize > batchSize) {
      const error = new Error("ubatchSize 不能大于 batchSize。");
      error.status = 400;
      throw error;
    }
    const cacheTypeK = normalizeLlamaCacheType(body.cacheTypeK || body.kvCacheDtype);
    const cacheTypeV = normalizeLlamaCacheType(body.cacheTypeV || body.kvCacheDtype);
    const flashAttention = normalizeOnOffAuto(body.flashAttention);
    const cacheReuse = boundedNonNegativeInteger(body.cacheReuse, 512, "cacheReuse", 4096);
    const noMmap = Boolean(body.noMmap);
    const noRepack = Boolean(body.noRepack);
    const gpuSelection = await normalizeLaunchGpuSelection(normalizeGpuIds(body.gpuDeviceIds));
    let gpuDeviceIds = gpuSelection.gpuDeviceIds;
    const requestedMultiGpuMode = normalizeLlamaSplitMode(body.multiGpuMode || body.splitMode);
    const multiGpuMode = gpuSelection.selectedCount < 2 ? "none" : requestedMultiGpuMode;
    const visibleGpuCount = Math.max(1, gpuSelection.selectedCount || gpuDeviceIds.length || Number(body.gpuCount || 1));
    const tensorSplit = multiGpuMode === "none" ? "" : cleanOptionalLaunchArg(body.tensorSplit);
    const clientPreset = normalizeClientPreset(body.clientPreset);
    const reasoning = normalizeOnOffAuto(body.reasoning);
    const reasoningFormat = normalizeLlamaReasoningFormat(body.reasoningFormat || body.reasoningParser);
    const reasoningEffort = normalizeLlamaReasoningEffort(body.reasoningEffort);
    const reasoningBudget = normalizeLlamaReasoningBudget(body.reasoningBudget);
    const textOnlyMode = normalizeDefaultTrueBoolean(body.textOnlyMode, body.languageModelOnly);
    const mmproj = cleanOptionalLaunchArg(body.mmproj);
    const mmprojDevice = normalizeLlamaMmprojDevice(body.mmprojDevice);
    const speculativeMode = String(body.speculativeMode || "auto").trim().toLowerCase();
    const draftModel = cleanOptionalLaunchArg(body.draftModel || body.specDraftModel);
    const numSpeculativeTokens = positiveInt(body.numSpeculativeTokens, 3);
    const temperature = boundedNumber(body.temperature, null, "temperature", 0, 5);
    const topP = boundedNumber(body.topP ?? body.top_p, null, "topP", 0, 1);
    const topK = boundedNonNegativeInteger(body.topK ?? body.top_k, null, "topK", 100_000);
    const llamaApiKey = String(body.apiKey || "").trim();
    const networkAccess = normalizeNetworkAccess(body.networkAccess);
    const lanAddress = getLanAddress();
    const serviceHost = networkAccess === "lan" ? lanAddress : "127.0.0.1";
    const serviceUrl = `http://${serviceHost}:${port}/v1`;
    const gpu = await getGpuStatus().catch(() => ({ gpus: [] }));
    let gpuPlan = buildLlamaGpuPlan(gpu, gpuDeviceIds, gpuMemoryUtilization, multiGpuMode, body.mainGpu);
    let mainGpu = gpuPlan.mainGpu;
    let effectiveTensorSplit = tensorSplit || suggestTensorSplit(gpu.gpus || [], gpuDeviceIds, gpuMemoryUtilization, multiGpuMode);

    const estimateGpuDeviceIds = gpuDeviceIds.length
      ? gpuDeviceIds
      : Array.isArray(gpuPlan.selectedGpuIds) ? gpuPlan.selectedGpuIds : [];
    const estimate = (typeof acquireGpuAdmission === "function" || typeof acquireGpuAdmissionAfterPrepare === "function")
      ? await estimateParallelVram({
        model,
        launch: launchResolution,
        mmproj,
        draftModel,
        textOnlyMode,
        speculativeMode,
        maxModelLen,
        maxNumSeqs,
        cacheTypeK,
        cacheTypeV,
        gpuLayers,
        fitTargetMb,
        fitCtx,
        gpuDeviceIds: estimateGpuDeviceIds,
        gpuPlan,
        tensorSplit: effectiveTensorSplit,
      })
      : null;
    const gpuAdmissionRequest = {
      managerId: CONFIG.managerId,
      engine: "llama",
      instanceMode,
      instanceId,
      containerName,
      model,
      resolvedModel: launchResolution?.selectedGgufFile || model,
      gpuIds: gpuDeviceIds,
      useAllGpus: multiGpuMode !== "none",
      // llama.cpp does not allocate a fixed fraction of VRAM. Once the local GGUF
      // estimate is available, reserving the UI utilization percentage as a floor
      // would turn an accurate ~24 GiB plan into an artificial ~83 GiB request.
      requestedFraction: estimate?.requestedMb > 0 ? null : (autoFit ? null : gpuMemoryUtilization),
      requestedMb: estimate?.requestedMb,
      requestedMbByGpu: estimate?.requestedMbByGpu,
      estimatePolicy: estimate?.estimatePolicy || "llama_estimate_unavailable",
      maxModelLen,
      maxNumSeqs,
      gpuLayers,
      fitTargetMb,
      fitCtx,
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
      gpuDeviceIds = Array.from(new Set(admission.reservations
        .map((reservation) => String(reservation.gpuIndex ?? reservation.gpuId ?? "").trim())
        .filter(Boolean)));
    }
    let runtimeApiKeyRef = "";
    try {
      if (llamaApiKey) runtimeApiKeyRef = await saveRuntimeApiKey(llamaApiKey);
    } catch (error) {
      try { await admissionLease?.release?.("api-key-store-failed"); } catch {}
      throw error;
    }
    let job;
    try {
      job = createJob("serve", `Start ${name}`, {
        model,
        resolvedModel: launchResolution?.selectedGgufFile || model,
        name,
        instanceMode,
        instanceId,
        containerName,
        port,
        maxModelLen,
        maxNumSeqs,
        gpuMemoryUtilization,
        gpuLayers,
        fitTargetMb,
        fitCtx,
        batchSize,
        ubatchSize,
        cacheTypeK,
        cacheTypeV,
        flashAttention,
        cacheReuse,
        noMmap,
        noRepack,
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
        reasoningEffort,
        reasoningBudget,
        textOnlyMode,
        languageModelOnly: textOnlyMode,
        networkAccess,
        serviceHost,
        serviceUrl,
        mmproj,
        mmprojDevice,
        draftModel,
        speculativeMode,
        numSpeculativeTokens,
        temperature,
        topP,
        topK,
        hasApiKey: Boolean(llamaApiKey),
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
      launch: launchResolution,
      name,
      instanceMode,
      instanceId,
      containerName,
      port,
      maxModelLen,
      maxNumSeqs,
      gpuMemoryUtilization,
      gpuLayers,
      fitTargetMb,
      fitCtx,
      batchSize,
      ubatchSize,
      cacheTypeK,
      cacheTypeV,
      flashAttention,
      cacheReuse,
      noMmap,
      noRepack,
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
      reasoningEffort,
      reasoningBudget,
      textOnlyMode,
      languageModelOnly: textOnlyMode,
      networkAccess,
      serviceHost,
      serviceUrl,
      mmproj,
      mmprojDevice,
      draftModel,
      speculativeMode,
      numSpeculativeTokens,
      temperature,
      topP,
      topK,
      llamaApiKey,
      runtimeApiKeyRef,
      vramReservationMb: Number(admission?.requestedTotalMb || 0),
      gpuAdmissionLeaseId: String(admission?.id || ""),
    };
    let stopAdmissionHeartbeat = () => {};
    const attachAdmissionLease = (lease) => {
      admissionLease = lease || null;
      admission = admissionLease?.summary || null;
      if (!gpuDeviceIds.length && admission?.reservations?.length) {
        gpuDeviceIds = Array.from(new Set(admission.reservations
          .map((reservation) => String(reservation.gpuIndex ?? reservation.gpuId ?? "").trim())
          .filter(Boolean)));
        gpuPlan = buildLlamaGpuPlan(gpu, gpuDeviceIds, gpuMemoryUtilization, multiGpuMode, body.mainGpu);
        mainGpu = gpuPlan.mainGpu;
        effectiveTensorSplit = tensorSplit || suggestTensorSplit(gpu.gpus || [], gpuDeviceIds, gpuMemoryUtilization, multiGpuMode);
      }
      job.meta = {
        ...(job.meta || {}),
        gpuDeviceIds,
        tensorSplit: effectiveTensorSplit,
        mainGpu,
        mainGpuHostId: gpuPlan.mainGpuHostId,
        gpuPlan,
        gpuAdmission: admission,
      };
      Object.assign(runOptions, {
        gpuDeviceIds,
        tensorSplit: effectiveTensorSplit,
        mainGpu,
        mainGpuHostId: gpuPlan.mainGpuHostId,
        gpuPlan,
        vramReservationMb: Number(admission?.requestedTotalMb || 0),
        gpuAdmissionLeaseId: String(admission?.id || ""),
      });
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

async function estimateLlamaParallelVram(options = {}) {
  const resolution = options.launch?.selectedModel
    ? options.launch
    : await resolveLocalGgufEstimate(options.model);
  const selectedModel = resolution.selectedModel;
  if (!selectedModel) throw vramEstimateError("model must resolve to one complete local GGUF model variant.");
  const modelBytes = Number(selectedModel.fileBytes || resolution.modelBytes || 0);
  const explicitMmproj = String(options.mmproj || "").trim();
  const autoMmproj = options.textOnlyMode === false ? resolution.mmprojFiles?.[0] : null;
  const mmprojBytes = options.textOnlyMode === false
    ? explicitMmproj ? await localGgufBytes(explicitMmproj, "mmproj") : Number(autoMmproj?.fileBytes || autoMmproj?.size || 0)
    : 0;
  const explicitDraft = String(options.draftModel || "").trim();
  const autoDraft = resolution.draftFiles?.[0];
  const useDraft = explicitDraft
    || String(options.speculativeMode || "").replaceAll("_", "-") === "draft-dflash"
    || (String(options.speculativeMode || "").toLowerCase() === "auto" && autoDraft);
  const draftBytes = useDraft
    ? explicitDraft ? await localGgufBytes(explicitDraft, "draft") : Number(autoDraft?.fileBytes || autoDraft?.size || 0)
    : 0;
  const layerFraction = gpuLayerFraction(options.gpuLayers, selectedModel.layers);
  const gpuModelBytes = Math.ceil(modelBytes * layerFraction);
  const modelMb = Math.ceil(gpuModelBytes / (1024 * 1024));
  const mmprojMb = Math.ceil(mmprojBytes / (1024 * 1024));
  const draftMb = Math.ceil(draftBytes / (1024 * 1024));
  const metadataKvBytes = estimateGgufKvBytes(selectedModel, {
    maxModelLen: options.maxModelLen,
    maxNumSeqs: options.maxNumSeqs,
    cacheTypeK: options.cacheTypeK,
    cacheTypeV: options.cacheTypeV,
  });
  const contextMb = metadataKvBytes === null
    ? Math.min(
      LLAMA_CONTEXT_ESTIMATE_MAX_MB,
      Math.max(2048, Math.ceil(Number(options.maxModelLen || 8192) * Number(options.maxNumSeqs || 1) * 0.25)),
    )
    : Math.min(LLAMA_CONTEXT_ESTIMATE_MAX_MB, Math.ceil((metadataKvBytes * layerFraction) / (1024 * 1024)));
  const runtimeOverheadMb = 2048;
  const gpuIds = Array.from(new Set((options.gpuDeviceIds || []).map(String).filter(Boolean)));
  const totalMb = modelMb + mmprojMb + draftMb + contextMb + runtimeOverheadMb;
  const estimatePolicy = metadataKvBytes === null
    ? "llama_local_gguf_size_plus_bounded_context"
    : "llama_gguf_metadata_layers_kv_sliding_window";
  if (!gpuIds.length) {
    return {
      requestedMb: totalMb,
      requestedMbByGpu: null,
      estimatePolicy,
      resolvedModel: selectedModel.path,
      modelMb,
      mmprojMb,
      draftMb,
      contextMb,
      runtimeOverheadMb,
      gpuLayerFraction: layerFraction,
    };
  }

  const autoFit = String(options.gpuLayers || "").trim().toLowerCase() === "auto";
  const fitTargetMb = Math.max(0, Math.floor(Number(options.fitTargetMb || 0)));
  if (autoFit && fitTargetMb > 0) {
    const selected = Array.isArray(options.gpuPlan?.selected) ? options.gpuPlan.selected : [];
    const requestedMbByGpu = {};
    for (const gpuId of gpuIds) {
      const gpu = selected.find((item) => String(item?.id ?? item?.index ?? "") === gpuId);
      const freeMb = Number(gpu?.freeMb || 0);
      if (!Number.isFinite(freeMb) || freeMb <= fitTargetMb) {
        throw vramEstimateError(`GPU ${gpuId} does not have enough reported free VRAM for fit-target ${fitTargetMb} MiB.`);
      }
      requestedMbByGpu[gpuId] = Math.max(2048, Math.min(totalMb, Math.floor(freeMb - fitTargetMb)));
    }
    return {
      requestedMb: Object.values(requestedMbByGpu).reduce((sum, value) => sum + value, 0),
      requestedMbByGpu,
      estimatePolicy: "llama_auto_fit_free_minus_target",
    };
  }

  const weights = parseTensorSplit(options.tensorSplit, gpuIds.length)
    || gpuIds.map(() => 1);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const requestedMbByGpu = {};
  gpuIds.forEach((gpuId, index) => {
    const share = weights[index] / weightTotal;
    const modelShareMb = metadataKvBytes === null
      ? Math.ceil((modelMb + mmprojMb + draftMb) * share)
      : Math.ceil((modelMb + mmprojMb + draftMb + contextMb) * share);
    requestedMbByGpu[gpuId] = modelShareMb + runtimeOverheadMb + (metadataKvBytes === null ? contextMb : 0);
  });
  return {
    requestedMb: totalMb,
    requestedMbByGpu,
    estimatePolicy,
    resolvedModel: selectedModel.path,
    modelMb,
    mmprojMb,
    draftMb,
    contextMb,
    runtimeOverheadMb,
    gpuLayerFraction: layerFraction,
  };
}

async function resolveLocalGgufEstimate(modelPath) {
  const resolved = path.resolve(String(modelPath || ""));
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw vramEstimateError("model must be a readable local GGUF file or directory for a parallel launch.");
  }
  const root = stat.isDirectory() ? resolved : path.dirname(resolved);
  const files = stat.isDirectory()
    ? findGgufFilesSync(root, 512)
    : findSiblingGgufFilesSync(resolved, 512);
  const inventory = buildGgufInventory(files);
  const requested = stat.isFile() ? resolved : "";
  const selectedModel = selectGgufModel(inventory, requested);
  if (!selectedModel || !selectedModel.complete) throw vramEstimateError("model does not resolve to a complete local GGUF variant.");
  if (stat.isFile()) {
    const requestedFile = inventory.files.find((file) => path.resolve(file.path) === resolved);
    if (requestedFile && requestedFile.role !== "model") throw vramEstimateError(`${requestedFile.role} component cannot be used as the target model.`);
  }
  return {
    selectedModel,
    selectedGgufFile: selectedModel.path,
    modelBytes: selectedModel.fileBytes,
    modelFiles: selectedModel.files,
    mmprojFiles: inventory.mmproj,
    draftFiles: inventory.drafts,
    ggufInventory: inventory,
  };
}

async function localGgufBytes(modelPath, kind) {
  const resolved = path.resolve(String(modelPath || ""));
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw vramEstimateError(`${kind} must be a readable local GGUF file or directory for a parallel launch.`);
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw vramEstimateError(`${kind} is not a regular local file or directory.`);

  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.gguf$/i.test(entry.name)) continue;
    if (kind === "model" && /mmproj/i.test(entry.name)) continue;
    const fileStat = await fsp.stat(path.join(resolved, entry.name));
    files.push({ name: entry.name, size: fileStat.size });
  }
  if (!files.length) throw vramEstimateError(`${kind} directory does not contain a readable GGUF file.`);

  const splitGroups = new Map();
  for (const file of files) {
    const match = file.name.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (!match) continue;
    const key = `${match[1].toLowerCase()}|${match[3]}`;
    const group = splitGroups.get(key) || { expected: Number(match[3]), parts: new Set(), bytes: 0 };
    group.parts.add(Number(match[2]));
    group.bytes += file.size;
    splitGroups.set(key, group);
  }
  if (splitGroups.size) {
    const completeGroups = Array.from(splitGroups.values()).filter((group) => group.parts.size === group.expected);
    if (completeGroups.length === 1 && splitGroups.size === 1) return completeGroups[0].bytes;
    throw vramEstimateError(`${kind} directory contains incomplete or ambiguous GGUF shard groups.`);
  }
  if (files.length === 1) return files[0].size;
  throw vramEstimateError(`${kind} directory contains multiple GGUF variants; select one file explicitly.`);
}

function parseTensorSplit(value, expected) {
  const parts = String(value || "").split(",").map(Number);
  if (parts.length !== expected || parts.some((item) => !Number.isFinite(item) || item <= 0)) return null;
  return parts;
}

function vramEstimateError(message) {
  const error = new Error(message);
  error.code = "vram_estimate_unavailable";
  error.status = 422;
  return error;
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

module.exports = {
  LLAMA_CONTEXT_ESTIMATE_MAX_MB,
  createLlamaStartRuntimeRequest,
  estimateLlamaParallelVram,
};
