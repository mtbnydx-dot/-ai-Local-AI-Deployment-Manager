const { redactSecrets } = require("../../manager-core/secret-redactor");
const runtimeManifest = require("../../manager-core/runtime-manifest");
const engines = require("../../manager-core/engines");
const llamacpp = require("../../manager-core/engines/adapters/llamacpp");
const { renderRunArgs } = require("../../manager-core/engines/adapters/_docker-segments");

// Thin wrapper over the llamacpp engine adapter (docs/overhaul/01-engines.md
// §7, ENG-4). buildLlamaRuntimeCommand keeps its legacy signature and return
// shape: it maps the run options to a plan, resolves the runtime the launch
// runs, calls adapter.buildLaunch, replays the adapter's log lines through
// appendLog and renders runArgs with the shared docker renderer.

const ENGINE_ID = llamacpp.id;

// The Muse Glimmer preset is the recipe llama-muse-glimmer
// (manager-core/data/recipes, ENG-6): the retired Muse runtime and its
// sampling values. The resolver selects recipes by plan (ENG-7); until then
// this wrapper applies it the way the old branch did, by architecture or name.
// The adapter reads only the recipe, never the model family.
const MUSE_GLIMMER_RECIPE_ID = "llama-muse-glimmer";

function createLlamaRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    getModelMountArgs = () => ["-v", `${CONFIG.modelsRoot}:/models`],
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

  const formatDockerPublishArgs = llamacpp.formatDockerPublishArgs;

  // The builder no longer puts secrets in argv; this stays as a guard for the
  // stored launchCommand and legacy argv, using the platform redactor.
  function redactDockerArgs(args, opts = {}) {
    const secrets = [opts.llamaApiKey, process.env.HF_TOKEN]
      .map((value) => String(value || ""))
      .filter((value) => value.length >= 6);
    if (!secrets.length) return args;
    return args.map((arg) => redactSecrets(String(arg), { secrets, patterns: false, minSecretLength: 6 }));
  }

  function selectRecipe(opts, launch) {
    const architecture = String(launch.selectedModel?.architecture || "").trim().toLowerCase();
    return architecture === "muse-glimmer" || /muse[-_. ]glimmer/i.test(String(opts.model || ""))
      ? engines.recipes.getRecipeStore().get(MUSE_GLIMMER_RECIPE_ID)
      : null;
  }

  // The images this manager runs for its manifest runtimes; CONFIG applied
  // env > manifest the way the registry's envOverride does.
  function slotImage(manifestKey) {
    if (manifestKey === "llama") return CONFIG.image;
    if (manifestKey === "llamaMuse") return CONFIG.museImage;
    return "";
  }

  function manifestRuntime(selector) {
    try {
      return runtimeManifest.resolveRuntime(ENGINE_ID, selector);
    } catch {
      return null;
    }
  }

  // RuntimeRef of the image a launch runs (01 §5). An image this manager
  // configured for a manifest runtime keeps that runtime's identity and
  // features; any other image resolves through the manifest, and one the
  // manifest does not know is a custom runtime with features {}, so every
  // gated control reads as unsupported. default marks the configured default
  // image, which supportsB10630Controls compared against before.
  function resolveRuntime(image) {
    const slotKey = ["llama", "llamaMuse"].find((key) => slotImage(key) && slotImage(key) === image);
    const ref = (slotKey && manifestRuntime({ manifestKey: slotKey })) || manifestRuntime({ image });
    return {
      runtimeId: ref?.runtimeId || `${ENGINE_ID}@custom`,
      manifestKey: ref?.manifestKey ?? null,
      image,
      features: ref?.features ? { ...ref.features } : {},
      compatVersion: ref?.compatVersion ?? null,
      status: ref?.status || "unpinned",
      default: image === CONFIG.image,
    };
  }

  /**
   * Legacy run options -> { plan, ctx } for adapter.buildLaunch. The model is
   * resolved here (filesystem I/O), as the builder did first.
   */
  function planLlamaLaunch(job, opts) {
    const launch = opts.launch?.selectedModel ? opts.launch : resolveLaunchModel(opts.model, "gguf");
    const recipe = selectRecipe(opts, launch);
    const runtimeImage = String(opts.runtimeImage || (recipe ? slotImage(recipe.runtime.ref) : "") || CONFIG.image);
    const plan = llamacpp.planFromRunOptions(opts, { jobId: job?.id, recipe, normalizeDefaultTrueBoolean });
    const ctx = {
      runtime: resolveRuntime(runtimeImage),
      host: {
        kind: "docker",
        containerPort: 8080,
        config: {
          containerName: CONFIG.containerName,
          managerLabelValue: CONFIG.managerId,
          hfCache: CONFIG.hfCache,
          modelsRoot: CONFIG.modelsRoot,
        },
        labelKeys: { manager: MANAGER_LABEL_KEY, engine: MANAGER_ENGINE_LABEL_KEY, apiKeyRef: MANAGER_APIKEY_REF_LABEL_KEY },
        modelMountArgs: getModelMountArgs(),
      },
      model: { ...launch, ref: opts.model },
      secrets: { hfToken: process.env.HF_TOKEN },
      extra: { args: opts.extraArgs, env: opts.extraEnv },
      // LaunchStore id (01 §15): the server mints it into job.meta before the build.
      launchId: opts.launchId || job?.meta?.launchId || null,
      toContainerPath: windowsPathToContainerPath,
      dockerGpuArg,
      dockerPublishArgs,
      publishArgsToDockerRunArgs,
      normalizeGpuIds,
    };
    return { plan, ctx };
  }

  function buildLlamaRuntimeCommand(job, opts) {
    const { plan, ctx } = planLlamaLaunch(job, opts);
    let command;
    try {
      command = llamacpp.buildLaunch(plan, ctx);
    } catch (error) {
      for (const line of error?.logs || []) appendLog(job, line);
      throw error;
    }
    for (const line of command.logs) appendLog(job, line);
    if (job && Object.keys(command.metaPatch).length) job.meta = { ...(job.meta || {}), ...command.metaPatch };
    return {
      runArgs: renderRunArgs(command),
      activePublishArgs: command.publish,
      runtimeImage: command.docker.image,
      secretEnv: command.secretEnv,
    };
  }

  return {
    buildLlamaRuntimeCommand,
    formatDockerPublishArgs,
    planLlamaLaunch,
    redactDockerArgs,
  };
}

module.exports = {
  clampSpeculativeTokens: llamacpp.clampSpeculativeTokens,
  createLlamaRuntimeCommandBuilder,
  normalizeLlamaSpeculativeMode: llamacpp.normalizeLlamaSpeculativeMode,
  optionalSamplingNumber: llamacpp.optionalSamplingNumber,
};
