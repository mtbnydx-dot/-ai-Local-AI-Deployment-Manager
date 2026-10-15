// vLLM/SGLang starts run through the shared runtime-supervisor (docs/overhaul/
// 01-engines.md §14, ENG-11). This is the vLLM run context the supervisor
// executes: the model and preset preflight, the GPU list the builder needs,
// the runtime gate with vLLM's options, today's implicit pull before the
// checkpoint (same retries, platform and log lines), the stall timeout from
// the recipe (Pennyroyal: 30 min) and the wait texts. The lease and the new
// API-key ref stay with launch-request.js (cleanup "caller"), as on llama.

const { VLLM_GATE_OPTIONS } = require("./runtime-compatibility");
const { normalizeRuntimeEngine } = require("./runtime-command");

const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_BUILD_IMAGE = /^local\//i;

function buildVllmImagePullOptions(env = process.env, platform = "") {
  return {
    attempts: Math.max(1, Number(env.VLLM_IMAGE_PULL_RETRIES || 3)),
    initialDelayMs: Math.max(0, Number(env.VLLM_IMAGE_PULL_RETRY_DELAY_MS || 3000)),
    platform,
  };
}

/**
 * How long a start may log nothing: VLLM_START_STALL_TIMEOUT_MS, else the
 * stallMs of the recipe the preset was rendered from (large RAM-PLE
 * checkpoints on Windows bind mounts spend more than ten minutes in a quiet
 * read), else 10 minutes; never under one minute.
 */
function vllmStallTimeoutMs(preset, { env = process.env, stallMsForPreset } = {}) {
  const fromRecipe = typeof stallMsForPreset === "function" ? stallMsForPreset(preset) : null;
  return Math.max(60000, Number(env.VLLM_START_STALL_TIMEOUT_MS || fromRecipe || DEFAULT_STALL_TIMEOUT_MS));
}

/** The /api/instances id of a container: "primary" for the replace slot, else its instance label or name. */
function vllmInstanceId(CONFIG, containerName, instanceLabel = "") {
  return containerName === CONFIG.containerName ? "primary" : instanceLabel || containerName;
}

/**
 * The pull policy of the image a start runs (01 §5, 00 §9.2), as the plan's
 * pull step derives it: the registry's runtime policy, else "auto" for a
 * stable tier-1 engine (today's implicit pull) and "explicit" otherwise.
 */
function imagePullPolicyFor(registry, engineId, image) {
  try {
    return registry.resolveRuntime(engineId, { image }).pullPolicy || "explicit";
  } catch {
    const descriptor = registry.get?.(engineId);
    return descriptor?.tier === 1 && descriptor?.status === "stable" ? "auto" : "explicit";
  }
}

function modelCompatibilityError(compatibility) {
  const issues = (compatibility.findings || []).filter((item) => item.severity === "fail");
  const detail = issues.map((item) => `${item.title}: ${item.detail}`).join("；") || "模型文件或运行时不兼容";
  const error = new Error(`模型启动前校验失败：${detail}`);
  error.code = issues.some((item) => /Muse Glimmer/i.test(`${item.title || ""} ${item.detail || ""}`))
    ? "muse_glimmer_vllm_unsupported"
    : "model_compatibility_failed";
  error.findings = compatibility.findings || [];
  return { error, detail, issues: issues.map((item) => item.detail) };
}

function presetUnsupportedError(preset) {
  const error = new Error(preset.unsupportedReason);
  error.code = preset.capabilities?.unsupportedCode === "muse_glimmer"
    ? "muse_glimmer_vllm_unsupported"
    : "runtime_preset_unsupported";
  error.findings = [{
    severity: "fail",
    title: preset.label || "Runtime preset unsupported",
    detail: preset.unsupportedReason,
  }];
  return error;
}

/**
 * createVllmRunContext(deps) → (opts) => run context for supervisor.start.
 * deps: CONFIG, env?, appendLog, checkModelCompatibility, getGpuStatus,
 * previewRuntimePreset, buildRuntimeCommand, knownRuntimeImageMetadata,
 * stallMsForPreset, redactDockerArgs, dockerPublishArgs,
 * formatDockerPublishArgs, extractLogIssues, registry (the engine registry).
 */
function createVllmRunContext(deps = {}) {
  const { CONFIG } = deps;
  const env = deps.env || process.env;

  return function vllmRunContext(opts = {}) {
    // The builder reads the host GPU list (preset choice); the preflight
    // fills it from the probe, and every build reads the live run options so
    // the rebuild after admission sees the admitted devices.
    let hostGpus = [];
    const withHostGpus = () => ({ ...opts, hostGpus });
    let engine = normalizeRuntimeEngine(opts.engine);
    try {
      engine = normalizeRuntimeEngine(deps.previewRuntimePreset(opts).engine || opts.engine);
    } catch {
      // The preflight reports a preset that cannot be resolved.
    }
    const engineName = engine === "sglang" ? "SGLang" : "vLLM";
    const containerName = opts.containerName || CONFIG.containerName;

    return {
      options: opts,
      engineId: engine === "sglang" ? "sglang" : "vllm",
      engineName,
      apiLabel: `${engineName} API`,
      // mode add / onConflict: the supervisor re-checks the slot at its preflight (01 §11, 00 §9.3).
      ...(opts.launchMode === "add" ? { mode: "add", onConflict: opts.onConflict === "skip" ? "skip" : "fail" } : {}),
      containerName,
      instanceId: vllmInstanceId(CONFIG, containerName, opts.instanceId),
      port: opts.port,
      gpuIds: opts.gpuDeviceIds,
      warnings: opts.gpuWarnings || [],
      apiKeyRef: opts.runtimeApiKeyRef,
      cleanup: "caller",
      admissionRequest: opts.gpuAdmissionRequest,
      prepareAdmission: typeof opts.prepareGpuAdmission === "function" ? opts.prepareGpuAdmission : undefined,
      lanFallback: opts.networkAccess === "lan",
      bindRetryPublish: () => deps.dockerPublishArgs(opts.port, "lan", "0.0.0.0"),
      formatPublish: deps.formatDockerPublishArgs,
      redactArgs: (argv) => deps.redactDockerArgs(argv, opts),
      async preflight(job, { progress }) {
        const compatibility = opts.modelCompatibility && typeof opts.modelCompatibility === "object"
          ? opts.modelCompatibility
          : await deps.checkModelCompatibility({ ...opts, model: opts.model, remote: false });
        if (!compatibility.ok) {
          const { error, detail, issues } = modelCompatibilityError(compatibility);
          progress({ percent: 2, stage: "模型预检失败", detail, state: "fail", issues });
          throw error;
        }
        const gpuProbe = await deps.getGpuStatus();
        if (!gpuProbe.ok) {
          deps.appendLog(job, `GPU warning: 未检测到可用的 NVIDIA GPU（${gpuProbe.text || "nvidia-smi 不可用"}）。vLLM 官方镜像依赖 NVIDIA GPU，容器很可能启动失败。`);
        }
        hostGpus = Array.isArray(gpuProbe.gpus) ? gpuProbe.gpus : [];
        const preset = deps.previewRuntimePreset(withHostGpus());
        if (preset.unsupportedReason) {
          deps.appendLog(job, `Runtime preset blocked: ${preset.label || preset.id}`);
          deps.appendLog(job, preset.unsupportedReason);
          progress({ percent: 8, stage: "当前环境不支持该模型", detail: preset.unsupportedReason, state: "fail", issues: [preset.unsupportedReason] });
          throw presetUnsupportedError(preset);
        }
      },
      buildCommand: (job) => {
        const built = deps.buildRuntimeCommand(job, withHostGpus());
        return { runArgs: built.runArgs, publish: built.activePublishArgs, image: built.runtimeImage, secretEnv: built.secretEnv };
      },
      // Enforced before admission on the built image; an implicit single-GPU
      // selection passes when any GPU fits, and the admitted one is checked
      // again before the container is created.
      gate: {
        releaseFor: deps.knownRuntimeImageMetadata,
        options: VLLM_GATE_OPTIONS,
        allowAnyCompatibleGpu: () => opts.multiGpuMode === "single" && !opts.gpuSelectionExplicit && !opts.gpuAdmissionFinalized,
        errorCode: "vllm_runtime_incompatible",
      },
      // The plan's pull step (00 §9.2): "auto" pulls a missing stable tier-1
      // image before the checkpoint, as before; "explicit" never pulls.
      imagePolicy: (image) => (deps.registry ? imagePullPolicyFor(deps.registry, engine === "sglang" ? "sglang" : "vllm", image) : "auto"),
      pullOptions: buildVllmImagePullOptions(env, CONFIG.imagePlatform),
      pullLog: {
        attempt: ({ attempt, attempts, image }) => `Docker image pull attempt ${attempt}/${attempts}: ${image}`,
        failure: ({ attempt, attempts, detail }) => `Docker image pull ${attempt}/${attempts} failed: ${detail}`,
      },
      onMissingImage: ({ image }) => {
        if (!LOCAL_BUILD_IMAGE.test(String(image || ""))) return;
        const error = new Error(`本地构建的运行时镜像不存在：${image}。请先按运行时说明重新构建，不要对 local/ 前缀执行 docker pull。`);
        error.code = "runtime_local_build_missing";
        throw error;
      },
      wait: {
        apiKey: opts.vllmApiKey,
        serviceUrl: opts.serviceUrl,
        loadingDetail: `容器已创建，正在等待 ${engineName} API 返回 /v1/models。`,
        noLogIssue: `${engineName} 启动日志长时间无变化。`,
        pollDetail: ({ elapsed, formatElapsed }) => `已等待 ${formatElapsed(elapsed)}。正在轮询 ${engineName} API，并读取容器日志检查错误。`,
        extractLogIssues: deps.extractLogIssues,
        stallMs: () => vllmStallTimeoutMs(deps.previewRuntimePreset(withHostGpus()), { env, stallMsForPreset: deps.stallMsForPreset }),
      },
    };
  };
}

module.exports = {
  DEFAULT_STALL_TIMEOUT_MS,
  buildVllmImagePullOptions,
  createVllmRunContext,
  imagePullPolicyFor,
  vllmInstanceId,
  vllmStallTimeoutMs,
};
