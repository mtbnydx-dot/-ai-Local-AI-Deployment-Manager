const path = require("path");

function createLlamaRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_LABEL_KEY,
    appendLog,
    dockerGpuArg,
    dockerPublishArgs,
    publishArgsToDockerRunArgs,
    normalizeGpuIds,
    normalizeDefaultTrueBoolean,
    windowsPathToContainerPath,
    resolveLaunchModel,
  } = deps;

  function formatDockerPublishArgs(publishArgs) {
    return publishArgs.map((arg) => `-p ${arg}`).join(" ");
  }

  function redactDockerArgs(args, opts = {}) {
    if (!opts.llamaApiKey) return args;
    return args.map((arg) => String(arg).includes(opts.llamaApiKey) ? String(arg).replaceAll(opts.llamaApiKey, "***") : arg);
  }

  function buildLlamaRuntimeCommand(job, opts) {
    const launch = resolveLaunchModel(opts.model, "gguf");
    const modelArg = launch.modelArg;
    const remoteRepo = !path.isAbsolute(opts.model)
      && /^[^/\s]+\/[^/\s]+/.test(opts.model)
      && !String(opts.model).toLowerCase().endsWith(".gguf");

    if (remoteRepo) {
      appendLog(job, `Remote GGUF repo mode: ${opts.model}`);
    } else {
      appendLog(job, `GGUF model: using ${modelArg}`);
    }
    if (launch.selectedGgufFile && launch.ggufFiles.length > 1) {
      appendLog(job, `Multiple GGUF files found; selected largest file: ${path.basename(launch.selectedGgufFile)}`);
    }
    const textOnlyMode = normalizeDefaultTrueBoolean(opts.textOnlyMode, opts.languageModelOnly);
    const explicitMmproj = String(opts.mmproj || "").trim();
    const autoMmproj = launch.ggufFiles.find((item) => /(?:^|[\\/])mmproj[^\\/]*\.gguf$/i.test(String(item.path || item.name || "")))?.path || "";
    const mmproj = explicitMmproj || autoMmproj;
    if (textOnlyMode) {
      appendLog(job, "Text-only mode: no mmproj/projector will be loaded.");
    } else if (mmproj) {
      appendLog(job, `Multimodal projector: ${mmproj}`);
    } else if (!remoteRepo) {
      throw new Error("Multimodal mode requires an mmproj GGUF file in the model directory or an explicit mmproj path.");
    } else {
      appendLog(job, "Multimodal projector: llama.cpp will auto-resolve mmproj from the remote Hugging Face repository.");
    }
    if ((opts.gpuDeviceIds || []).length > 1) {
      appendLog(job, `Heterogeneous GPU split: mode=${opts.multiGpuMode}, tensor-split=${opts.tensorSplit || "auto"}, main-gpu=${opts.mainGpu}`);
      if (opts.gpuPlan?.summary) appendLog(job, `GPU plan: ${opts.gpuPlan.summary}`);
      if (opts.gpuPlan?.mainGpuHostId !== undefined) appendLog(job, `Host GPU ${opts.gpuPlan.mainGpuHostId} is visible as llama.cpp main-gpu ${opts.mainGpu}`);
    }

    const activePublishArgs = dockerPublishArgs(opts.port, opts.networkAccess, opts.serviceHost);
    appendLog(job, `Docker publish: ${formatDockerPublishArgs(activePublishArgs)}`);
    const runArgs = [
      "run", "-d",
      "--name", opts.containerName || CONFIG.containerName,
      "--restart", "on-failure:3",
      "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
      "--label", `${MANAGER_ENGINE_LABEL_KEY}=llama`,
      "--label", `ai.manager.instance=${opts.instanceId || "primary"}`,
      "--label", `ai.manager.instance-mode=${opts.instanceMode || "replace"}`,
      "--label", `ai.manager.model=${opts.name || ""}`,
      "--label", `ai.manager.port=${opts.port}`,
      "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
      "--ipc=host",
      ...publishArgsToDockerRunArgs(activePublishArgs),
      "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
      "-v", `${CONFIG.modelsRoot}:/models`,
    ];
    if (opts.llamaApiKey && MANAGER_APIKEY_LABEL_KEY) runArgs.push("--label", `${MANAGER_APIKEY_LABEL_KEY}=${opts.llamaApiKey}`);
    const gpuVisibility = normalizeGpuIds(opts.gpuDeviceIds).join(",");
    if (gpuVisibility) {
      runArgs.push(
        "-e", `NVIDIA_VISIBLE_DEVICES=${gpuVisibility}`,
        "-e", `CUDA_VISIBLE_DEVICES=${gpuVisibility}`,
        "-e", "NVIDIA_DRIVER_CAPABILITIES=compute,utility"
      );
    }
    if (process.env.HF_TOKEN) runArgs.push("-e", `HF_TOKEN=${process.env.HF_TOKEN}`);

    runArgs.push(CONFIG.image);
    if (remoteRepo) runArgs.push("--hf-repo", opts.model);
    else runArgs.push("--model", modelArg);
    const totalContextSize = Math.max(1, Number(opts.maxModelLen || 1)) * Math.max(1, Number(opts.maxNumSeqs || 1));
    appendLog(job, `Context budget: ${opts.maxModelLen} tokens per slot x ${opts.maxNumSeqs} slots = --ctx-size ${totalContextSize}.`);
    runArgs.push(
      "--alias", opts.name,
      "--host", "0.0.0.0",
      "--port", "8080",
      "--ctx-size", String(totalContextSize),
      "--parallel", String(opts.maxNumSeqs),
      "--batch-size", String(opts.batchSize),
      "--ubatch-size", String(opts.ubatchSize),
      "--n-gpu-layers", opts.gpuLayers,
      "--split-mode", opts.multiGpuMode,
      "--main-gpu", String(opts.mainGpu),
      "--cache-type-k", opts.cacheTypeK,
      "--cache-type-v", opts.cacheTypeV,
      "--flash-attn", opts.flashAttention,
      "--reasoning", opts.reasoning,
      "--reasoning-format", opts.reasoningFormat,
      "--metrics",
      "--jinja"
    );
    if (!textOnlyMode && mmproj) runArgs.push("--mmproj", windowsPathToContainerPath(mmproj));
    const speculativeMode = normalizeLlamaSpeculativeMode(opts.speculativeMode, opts.model);
    if (speculativeMode !== "none") {
      runArgs.push("--spec-type", speculativeMode);
      if (speculativeMode.startsWith("draft-")) {
        runArgs.push("--spec-draft-n-max", String(clampSpeculativeTokens(opts.numSpeculativeTokens)));
      }
    }
    if (opts.llamaApiKey) runArgs.push("--api-key", opts.llamaApiKey);
    if (opts.tensorSplit && opts.multiGpuMode !== "none") runArgs.push("--tensor-split", opts.tensorSplit);
    if (opts.noMmap) runArgs.push("--no-mmap");

    return { runArgs, activePublishArgs, runtimeImage: CONFIG.image };
  }

  return {
    buildLlamaRuntimeCommand,
    formatDockerPublishArgs,
    redactDockerArgs,
  };
}

function normalizeLlamaSpeculativeMode(value, model = "") {
  const mode = String(value || "auto").trim().toLowerCase().replaceAll("_", "-");
  if (mode === "off" || mode === "none") return "none";
  if (mode === "auto") return /(?:^|[-_/.])mtp(?:$|[-_/.])/i.test(String(model || "")) ? "draft-mtp" : "none";
  return new Set(["draft-mtp", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"]).has(mode)
    ? mode
    : "none";
}

function clampSpeculativeTokens(value) {
  const number = Number(value || 3);
  return Math.min(16, Math.max(1, Number.isFinite(number) ? Math.floor(number) : 3));
}

module.exports = { clampSpeculativeTokens, createLlamaRuntimeCommandBuilder, normalizeLlamaSpeculativeMode };
