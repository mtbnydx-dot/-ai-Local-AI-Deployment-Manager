const path = require("path");

function createLlamaRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_REF_LABEL_KEY,
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
    const secrets = [opts.llamaApiKey, process.env.HF_TOKEN]
      .map((value) => String(value || ""))
      .filter((value) => value.length >= 6);
    if (!secrets.length) return args;
    return args.map((arg) => secrets.reduce((value, secret) => String(value).replaceAll(secret, "***"), String(arg)));
  }

  function buildLlamaRuntimeCommand(job, opts) {
    const launch = opts.launch?.selectedModel ? opts.launch : resolveLaunchModel(opts.model, "gguf");
    const modelArg = launch.modelArg;
    const selectedArchitecture = String(launch.selectedModel?.architecture || "").trim().toLowerCase();
    const museGlimmer = selectedArchitecture === "muse-glimmer" || /muse[-_. ]glimmer/i.test(String(opts.model || ""));
    const runtimeImage = String(opts.runtimeImage || (museGlimmer ? CONFIG.museImage : "") || CONFIG.image);
    const supportsB10630Controls = runtimeImage === CONFIG.image;
    const reasoningEffort = String(opts.reasoningEffort || "default");
    const reasoningBudget = Number.isInteger(Number(opts.reasoningBudget)) ? Number(opts.reasoningBudget) : -1;
    const mmprojDevice = String(opts.mmprojDevice || "auto").trim() || "auto";
    const remoteRepo = !path.isAbsolute(opts.model)
      && /^[^/\s]+\/[^/\s]+/.test(opts.model)
      && !String(opts.model).toLowerCase().endsWith(".gguf");

    if (remoteRepo) {
      appendLog(job, `Remote GGUF repo mode: ${opts.model}`);
    } else {
      appendLog(job, `GGUF model: using ${modelArg}`);
    }
    if (launch.selectedGgufFile && (launch.ggufInventory?.models?.length || 0) > 1) {
      appendLog(job, `Multiple GGUF model variants found; selected: ${path.basename(launch.selectedGgufFile)}`);
    }
    if (museGlimmer && runtimeImage !== CONFIG.image) {
      appendLog(job, `Muse Glimmer runtime image: ${runtimeImage}`);
    }
    const textOnlyMode = normalizeDefaultTrueBoolean(opts.textOnlyMode, opts.languageModelOnly);
    const explicitMmproj = String(opts.mmproj || "").trim();
    const autoMmproj = launch.mmprojFiles?.[0]?.path
      || launch.ggufFiles.find((item) => item.role === "mmproj" || /(?:^|[\\/])mmproj[^\\/]*\.gguf$/i.test(String(item.path || item.name || "")))?.path
      || "";
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
    const explicitDraftModel = String(opts.draftModel || "").trim();
    const autoDraftModel = launch.draftFiles?.[0]?.path || "";
    const draftModel = explicitDraftModel || autoDraftModel;
    const speculativeMode = normalizeLlamaSpeculativeMode(opts.speculativeMode, opts.model, {
      draftModel,
      draftArchitecture: launch.draftFiles?.[0]?.architecture || "",
    });
    const temperature = optionalSamplingNumber(opts.temperature, museGlimmer ? 1 : null, 0, 5);
    const topP = optionalSamplingNumber(opts.topP ?? opts.top_p, museGlimmer ? 0.95 : null, 0, 1);
    const topK = optionalSamplingNumber(opts.topK ?? opts.top_k, museGlimmer ? 64 : null, 0, 100_000, true);
    const usesExternalDraft = (speculativeMode === "draft-dflash" || speculativeMode === "draft-simple") && Boolean(draftModel);
    if ((opts.gpuDeviceIds || []).length > 1) {
      appendLog(job, `Heterogeneous GPU split: mode=${opts.multiGpuMode}, tensor-split=${opts.tensorSplit || "auto"}, main-gpu=${opts.mainGpu}`);
      if (opts.gpuPlan?.summary) appendLog(job, `GPU plan: ${opts.gpuPlan.summary}`);
      if (opts.gpuPlan?.mainGpuHostId !== undefined) appendLog(job, `Host GPU ${opts.gpuPlan.mainGpuHostId} is visible as llama.cpp main-gpu ${opts.mainGpu}`);
    }

    const activePublishArgs = dockerPublishArgs(opts.port, opts.networkAccess, opts.serviceHost);
    appendLog(job, `Docker publish: ${formatDockerPublishArgs(activePublishArgs)}`);
    const gpuVisibility = normalizeGpuIds(opts.gpuDeviceIds).join(",");
    const vramReservationMb = Math.max(0, Math.round(Number(opts.vramReservationMb || 0)));
    const runArgs = [
      "run", "-d",
      "--name", opts.containerName || CONFIG.containerName,
      "--restart", "on-failure:3",
      "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
      "--label", `${MANAGER_ENGINE_LABEL_KEY}=llama`,
      "--label", `ai.manager.job=${job?.id || ""}`,
      "--label", `ai.manager.instance=${opts.instanceId || "primary"}`,
      "--label", `ai.manager.instance-mode=${opts.instanceMode || "replace"}`,
      "--label", `ai.manager.model=${opts.name || ""}`,
      "--label", `ai.manager.port=${opts.port}`,
      "--label", `ai.manager.gpu-ids=${gpuVisibility}`,
      "--label", `ai.manager.vram-reservation-mb=${vramReservationMb}`,
      "--label", `ai.manager.max-model-len=${opts.maxModelLen}`,
      "--label", `ai.manager.max-num-seqs=${opts.maxNumSeqs}`,
      "--label", `ai.manager.gpu-memory-utilization=${opts.gpuMemoryUtilization}`,
      "--label", `ai.manager.gpu-layers=${opts.gpuLayers}`,
      "--label", `ai.manager.cache-type-k=${opts.cacheTypeK || ""}`,
      "--label", `ai.manager.cache-type-v=${opts.cacheTypeV || ""}`,
      "--label", `ai.manager.tensor-split=${opts.tensorSplit || ""}`,
      "--label", `ai.manager.speculative-mode=${speculativeMode}`,
      "--label", `ai.manager.reasoning-effort=${supportsB10630Controls ? reasoningEffort : "default"}`,
      "--label", `ai.manager.reasoning-budget=${reasoningBudget}`,
      "--label", `ai.manager.mmproj-device=${supportsB10630Controls ? mmprojDevice : "auto"}`,
      "--label", `ai.manager.fit-target-mb=${Math.max(0, Number(opts.fitTargetMb || 0))}`,
      "--label", `ai.manager.fit-ctx=${Math.max(0, Number(opts.fitCtx || 0))}`,
      "--label", `ai.manager.mmproj=${Boolean(mmproj)}`,
      "--label", `ai.manager.draft-model=${usesExternalDraft}`,
      "--label", `ai.manager.text-only=${Boolean(textOnlyMode)}`,
      "--label", `ai.manager.gpu-admission-lease=${opts.gpuAdmissionLeaseId || ""}`,
      "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
      "--ipc=host",
      ...publishArgsToDockerRunArgs(activePublishArgs),
      "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
      "-v", `${CONFIG.modelsRoot}:/models`,
    ];
    if (opts.runtimeApiKeyRef && MANAGER_APIKEY_REF_LABEL_KEY) {
      runArgs.push("--label", `${MANAGER_APIKEY_REF_LABEL_KEY}=${opts.runtimeApiKeyRef}`);
    }
    if (gpuVisibility) {
      runArgs.push(
        "-e", `NVIDIA_VISIBLE_DEVICES=${gpuVisibility}`,
        "-e", `CUDA_VISIBLE_DEVICES=${gpuVisibility}`,
        "-e", "NVIDIA_DRIVER_CAPABILITIES=compute,utility"
      );
    }
    if (process.env.HF_TOKEN) runArgs.push("-e", `HF_TOKEN=${process.env.HF_TOKEN}`);

    runArgs.push(runtimeImage);
    if (remoteRepo) {
      runArgs.push("--hf-repo", opts.model);
      // llama.cpp enables automatic mmproj discovery for --hf-repo by default.
      // Make the manager's text-only switch authoritative so the launched
      // runtime matches both the UI promise and the VRAM admission estimate.
      if (textOnlyMode) runArgs.push("--no-mmproj");
    } else {
      runArgs.push("--model", modelArg);
    }
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
      "--reasoning-budget", String(reasoningBudget),
      "--metrics",
      "--jinja"
    );
    if (supportsB10630Controls) {
      runArgs.push("--reasoning-effort", reasoningEffort);
    } else if (reasoningEffort !== "default") {
      appendLog(job, `Runtime ${runtimeImage} predates --reasoning-effort; requested ${reasoningEffort} was left at template default.`);
    }
    if (Number(opts.fitTargetMb || 0) > 0) {
      runArgs.push("--fit", "on", "--fit-target", String(Math.floor(Number(opts.fitTargetMb))));
    }
    if (Number(opts.fitCtx || 0) > 0) {
      runArgs.push("--fit-ctx", String(Math.floor(Number(opts.fitCtx))));
    }
    if (!textOnlyMode && mmproj) runArgs.push("--mmproj", windowsPathToContainerPath(mmproj));
    if (!textOnlyMode && supportsB10630Controls) {
      runArgs.push("--mmproj-device", mmprojDevice);
    } else if (!textOnlyMode && mmprojDevice !== "auto") {
      appendLog(job, `Runtime ${runtimeImage} predates --mmproj-device; requested ${mmprojDevice} was left at auto.`);
    }
    if (speculativeMode !== "none") {
      runArgs.push("--spec-type", speculativeMode);
      if (speculativeMode.startsWith("draft-")) {
        if (speculativeMode === "draft-dflash") {
          if (!draftModel) throw new Error("draft-dflash requires a local DFlash GGUF draft model.");
          runArgs.push("--model-draft", windowsPathToContainerPath(draftModel));
          appendLog(job, `DFlash draft model: ${draftModel}`);
        } else if (speculativeMode === "draft-simple" && draftModel) {
          runArgs.push("--model-draft", windowsPathToContainerPath(draftModel));
        }
        runArgs.push("--spec-draft-n-max", String(clampSpeculativeTokens(opts.numSpeculativeTokens)));
      }
    }
    if (temperature !== null) runArgs.push("--temp", String(temperature));
    if (topP !== null) runArgs.push("--top-p", String(topP));
    if (topK !== null) runArgs.push("--top-k", String(topK));
    if (museGlimmer) appendLog(job, `Muse Glimmer sampling defaults: temp=${temperature}, top-p=${topP}, top-k=${topK}.`);
    if (opts.llamaApiKey) runArgs.push("--api-key", opts.llamaApiKey);
    if (opts.tensorSplit && opts.multiGpuMode !== "none") runArgs.push("--tensor-split", opts.tensorSplit);
    if (Number(opts.cacheReuse || 0) > 0) runArgs.push("--cache-reuse", String(Math.floor(Number(opts.cacheReuse))));
    if (opts.noMmap) runArgs.push("--no-mmap");
    if (opts.noRepack) runArgs.push("--no-repack");

    return { runArgs, activePublishArgs, runtimeImage };
  }

  return {
    buildLlamaRuntimeCommand,
    formatDockerPublishArgs,
    redactDockerArgs,
  };
}

function optionalSamplingNumber(value, fallback, min, max, integer = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return integer ? Math.floor(number) : number;
}

function normalizeLlamaSpeculativeMode(value, model = "", options = {}) {
  const mode = String(value || "auto").trim().toLowerCase().replaceAll("_", "-");
  if (mode === "off" || mode === "none") return "none";
  if (mode === "auto") {
    if (/(?:^|[-_/.])mtp(?:$|[-_/.])/i.test(String(model || ""))) return "draft-mtp";
    if (/dflash/i.test(`${options.draftArchitecture || ""} ${options.draftModel || ""}`)) return "draft-dflash";
    if (options.draftModel) return "draft-simple";
    return "none";
  }
  return new Set(["draft-simple", "draft-mtp", "draft-dflash", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"]).has(mode)
    ? mode
    : "none";
}

function clampSpeculativeTokens(value) {
  const number = Number(value || 3);
  return Math.min(16, Math.max(1, Number.isFinite(number) ? Math.floor(number) : 3));
}

module.exports = { clampSpeculativeTokens, createLlamaRuntimeCommandBuilder, normalizeLlamaSpeculativeMode, optionalSamplingNumber };
