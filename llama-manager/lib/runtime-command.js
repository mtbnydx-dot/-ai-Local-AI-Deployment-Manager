const path = require("path");

function createLlamaRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY,
    appendLog,
    dockerGpuArg,
    dockerPublishArgs,
    publishArgsToDockerRunArgs,
    normalizeGpuIds,
    normalizeDefaultTrueBoolean,
    resolveLaunchModel,
  } = deps;

  function formatDockerPublishArgs(publishArgs) {
    return publishArgs.map((arg) => `-p ${arg}`).join(" ");
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
    if (normalizeDefaultTrueBoolean(opts.textOnlyMode, opts.languageModelOnly)) {
      appendLog(job, "Text-only mode: no mmproj/projector will be loaded.");
    } else {
      appendLog(job, "Text-only mode is off, but this manager does not pass an mmproj/projector yet; llama.cpp will still launch as text unless a projector option is added later.");
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
      "--name", CONFIG.containerName,
      "--label", `${MANAGER_LABEL_KEY}=${CONFIG.managerId}`,
      "--label", `${MANAGER_ENGINE_LABEL_KEY}=llama`,
      "--gpus", dockerGpuArg(opts.gpuDeviceIds || []),
      "--ipc=host",
      ...publishArgsToDockerRunArgs(activePublishArgs),
      "-v", `${CONFIG.hfCache}:/root/.cache/huggingface`,
      "-v", `${CONFIG.modelsRoot}:/models`,
    ];
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
    runArgs.push(
      "--alias", opts.name,
      "--host", "0.0.0.0",
      "--port", "8080",
      "--ctx-size", String(opts.maxModelLen),
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
    if (opts.tensorSplit && opts.multiGpuMode !== "none") runArgs.push("--tensor-split", opts.tensorSplit);
    if (opts.noMmap) runArgs.push("--no-mmap");

    return { runArgs, activePublishArgs };
  }

  return {
    buildLlamaRuntimeCommand,
    formatDockerPublishArgs,
  };
}

module.exports = { createLlamaRuntimeCommandBuilder };
