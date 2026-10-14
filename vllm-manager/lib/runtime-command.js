const { redactSecrets } = require("../../manager-core/secret-redactor");
const engines = require("../../manager-core/engines");
const { pennyroyalLaunchFixed } = require("./pennyroyal");

// The vLLM/SGLang launch command is built by the engine adapters
// (manager-core/engines/adapters/{vllm,sglang}.js, 01-engines ENG-5). This
// module is the legacy wrapper around them: it maps the run options and the
// runtime preset to a plan (catalog values, recipe fixed data, instance) and a
// context (host config, model facts, secrets, docker helpers), dispatches to
// the adapter by engineId, and turns the LaunchCommand back into the legacy
// { runArgs, activePublishArgs, runtimeImage, runtimePreset, runtimeEngine,
// secretEnv } while writing the same job.meta, log lines and ledger save.

const MANAGER_ID = "vllm";
// The adapters this wrapper can feed from legacy run options.
const LEGACY_BUILDER_ADAPTERS = new Set(["vllm", "sglang"]);
const LEGACY_ENGINES = new Set(["vllm", "sglang"]);
const FRACTION_PARAMS = Object.freeze({ vllm: "vllm.gpuMemoryUtilization", sglang: "sglang.memFractionStatic" });
// Engines whose legacy branch emitted a preset's quantization. The vLLM branch
// emitted the model/form value and only recorded a preset's in job.meta; no
// vLLM preset sets one, so this keeps hand-made presets byte-identical too.
const PRESET_QUANTIZATION_ENGINES = new Set(["sglang"]);

function createVllmRuntimeCommandBuilder(deps) {
  const {
    CONFIG,
    getModelMountArgs = () => ["-v", `${CONFIG.modelsRoot}:/models`],
    MANAGER_LABEL_KEY,
    MANAGER_ENGINE_LABEL_KEY,
    MANAGER_APIKEY_REF_LABEL_KEY,
    appendLog,
    scheduleJobsSave,
    dockerGpuArg,
    dockerPublishArgs,
    publishArgsToDockerRunArgs,
    windowsPathToContainerPath,
    normalizeGpuIds,
    getLanAddress,
    resolveLaunchModel,
    effectiveLaunchQuantization,
    resolveVllmRuntimePreset,
    engineRegistry = null,
  } = deps;

  function registry() {
    return engineRegistry || engines.getEngineRegistry();
  }

  function formatDockerPublishArgs(publishArgs) {
    return publishArgs.map((arg) => `-p ${arg}`).join(" ");
  }

  // SGLang still passes --api-key in argv (08 O1), so the stored launchCommand
  // and its log echo go through the platform redactor and show <redacted>.
  function redactDockerArgs(args, opts = {}) {
    const secrets = [opts.vllmApiKey, process.env.HF_TOKEN]
      .map((value) => String(value || ""))
      .filter((value) => value.length >= 6);
    if (!secrets.length) return args;
    return args.map((arg) => redactSecrets(String(arg), { secrets, patterns: false, minSecretLength: 6 }));
  }

  /**
   * Legacy run options -> { engineId, adapter, plan, ctx, preset }: the
   * adapter input buildVllmRuntimeCommand runs. Exposed so tests (and the
   * launch-plan resolver until legacy-aliases.js takes over) can call the
   * adapter on exactly what the manager would launch.
   */
  function prepareLaunch(job, opts) {
    const launch = resolveLaunchModel(opts.model, opts.loadFormat);
    const quantization = effectiveLaunchQuantization(opts.quantization, launch) || {};
    const runtimePreset = resolveVllmRuntimePreset(opts, launch) || {};
    const source = registry();
    const engineId = normalizeRuntimeEngine(runtimePreset.engine || opts.engine, source);
    const descriptor = safeCall(() => source.get(engineId), null);
    const adapter = engines.adapterFor(descriptor || engineId);
    if (!adapter) throw new Error(`No launch adapter for engine ${engineId}.`);
    const runtimeImage = runtimePreset.image || CONFIG.image;
    const fractionParam = descriptor?.memoryModel?.fractionParam || FRACTION_PARAMS[engineId];
    const plan = {
      engineId,
      values: legacyRunValues(opts, runtimePreset, quantization, {
        fractionParam,
        presetQuantization: PRESET_QUANTIZATION_ENGINES.has(engineId),
      }),
      fixed: legacyFixedData(opts, runtimePreset),
      instance: {
        id: opts.instanceId,
        mode: opts.instanceMode,
        port: opts.port,
        networkAccess: opts.networkAccess,
        serviceHost: opts.serviceHost,
        containerName: opts.containerName,
        gpuIds: opts.gpuDeviceIds,
      },
      legacy: { preset: runtimePreset, runOptions: opts, quantization },
    };
    const ctx = {
      descriptor,
      runtime: runtimeRef(source, engineId, runtimeImage),
      host: {
        kind: "docker",
        containerPort: descriptor?.host?.containerPort ?? 8000,
        config: {
          modelsRoot: CONFIG.modelsRoot,
          hfCache: CONFIG.hfCache,
          vllmCache: CONFIG.vllmCache,
          sglangCache: CONFIG.sglangCache,
          imagePlatform: CONFIG.imagePlatform,
          containerName: CONFIG.containerName,
          managerLabelValue: CONFIG.managerId,
        },
        labelKeys: { manager: MANAGER_LABEL_KEY, engine: MANAGER_ENGINE_LABEL_KEY, apiKeyRef: MANAGER_APIKEY_REF_LABEL_KEY },
        modelMountArgs: getModelMountArgs(),
      },
      model: { ...launch, quantMethod: quantization.modelConfigMethod || "" },
      hostFacts: {
        platform: process.platform,
        gpus: Array.isArray(opts.hostGpus) ? opts.hostGpus : [],
        env: { VLLM_START_TIMEOUT_MS: process.env.VLLM_START_TIMEOUT_MS },
      },
      secrets: { apiKey: opts.vllmApiKey, apiKeyRef: opts.runtimeApiKeyRef, hfToken: process.env.HF_TOKEN },
      jobId: job.id,
      admission: { leaseId: opts.gpuAdmissionLeaseId, vramReservationMb: opts.vramReservationMb },
      launchId: null,
      toContainerPath: windowsPathToContainerPath,
      dockerGpuArg,
      dockerPublishArgs,
      publishArgsToDockerRunArgs,
      normalizeGpuIds,
      lanAddress: getLanAddress,
    };
    return { engineId, adapter, plan, ctx, preset: runtimePreset };
  }

  // job.meta, the ledger save and the log lines the legacy builder wrote.
  function applyLegacyEffects(job, { metaPatch, logs }) {
    if (metaPatch) {
      job.meta = { ...job.meta, ...metaPatch };
      scheduleJobsSave();
    }
    for (const line of logs || []) appendLog(job, line);
  }

  function buildVllmRuntimeCommand(job, opts) {
    const { engineId, adapter, plan, ctx, preset } = prepareLaunch(job, opts);
    let command;
    try {
      command = adapter.buildLaunch(plan, ctx);
    } catch (error) {
      // The builder had written these before it failed; a blocked preset
      // fails with its reason as a plain Error, as the builder's did.
      if (error?.launch) applyLegacyEffects(job, error.launch);
      if (error?.code === "blocked") throw new Error(error.message);
      throw error;
    }
    applyLegacyEffects(job, command);
    return {
      runArgs: engines.renderRunArgs(command),
      activePublishArgs: command.publish,
      runtimeImage: command.docker.image,
      runtimePreset: preset,
      runtimeEngine: safeCall(() => registry().toLegacy(engineId), engineId) || engineId,
      secretEnv: command.secretEnv,
    };
  }

  return {
    buildVllmRuntimeCommand,
    formatDockerPublishArgs,
    prepareLaunch,
    redactDockerArgs,
  };
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * Run options + runtime preset -> effective values by catalog param id, with
 * the legacy precedence (a preset value beats the form value, `preset || opts`).
 * Only fields the legacy builder read are mapped, and each keeps the raw value
 * the builder used, so the adapters emit today's argv byte for byte.
 */
function legacyRunValues(opts, preset, quantization, { fractionParam, presetQuantization }) {
  const maxNumBatchedTokens = Math.max(positiveInteger(opts.maxNumBatchedTokens), positiveInteger(preset.maxNumBatchedTokens));
  return {
    servedName: opts.name,
    contextLength: opts.maxModelLen,
    concurrency: opts.maxNumSeqs,
    [fractionParam]: opts.gpuMemoryUtilization,
    dtype: preset.dtype || opts.dtype,
    // The model config declares the quantization before the form does
    // (effectiveLaunchQuantization); an SGLang preset may still pin it.
    quantization: (presetQuantization && preset.quantization) || quantization.value || "",
    kvCacheDtype: preset.kvCacheDtype || opts.kvCacheDtype,
    tokenizer: opts.tokenizer,
    trustRemoteCode: Boolean(opts.trustRemoteCode || preset.forceTrustRemoteCode),
    prefixCaching: opts.disablePrefixCaching || preset.disablePrefixCaching ? false : opts.enablePrefixCaching ? true : null,
    tensorParallel: opts.tensorParallelSize,
    pipelineParallel: opts.pipelineParallelSize,
    dataParallel: opts.dataParallelSize,
    expertParallel: Boolean(opts.enableExpertParallel),
    reasoningParser: preset.reasoningParser || opts.reasoningParser,
    toolCallParser: preset.toolCallParser || opts.toolCallParser,
    autoToolChoice: Boolean(preset.enableAutoToolChoice || opts.enableAutoToolChoice),
    chatTemplateKwargs: preset.defaultChatTemplateKwargs || null,
    generationConfig: preset.generationConfig || null,
    "vllm.maxNumBatchedTokens": maxNumBatchedTokens || null,
    "vllm.cpuOffloadGb": opts.cpuOffloadGb,
    "vllm.kvOffloadingSize": opts.kvOffloadingSize,
    "vllm.mmProcessorCacheGb": opts.mmProcessorCacheGb,
    "vllm.hfConfigPath": opts.hfConfigPath,
    "vllm.languageModelOnly": Boolean(opts.languageModelOnly && !preset.disableLanguageModelOnly),
    "vllm.distributedExecutorBackend": opts.distributedExecutorBackend,
    "vllm.enforceEager": Boolean(preset.enforceEager),
    "vllm.asyncScheduling": Boolean(preset.asyncScheduling),
    "vllm.attentionBackend": preset.attentionBackend || null,
    "vllm.moeBackend": preset.moeBackend || null,
    "vllm.linearBackend": preset.linearBackend || null,
    "vllm.overrideGenerationConfig": preset.overrideGenerationConfig || null,
    "vllm.speculativeConfig": preset.speculativeConfig || null,
    "vllm.safetensorsLoadStrategy": preset.safetensorsLoadStrategy || null,
    "vllm.reasoningParserPlugin": preset.reasoningParserPlugin || null,
    "sglang.maxRunningRequests": preset.maxRunningRequests || null,
    "sglang.maxTotalTokens": preset.maxTotalTokens || null,
    "sglang.pageSize": preset.pageSize || null,
    "sglang.chunkedPrefillSize": preset.chunkedPrefillSize || null,
    "sglang.fp4GemmBackend": preset.fp4GemmBackend || null,
    "sglang.attentionBackend": preset.attentionBackend || null,
    "sglang.pleOffloadEmbedding": Boolean(preset.pleOffloadEmbedding),
    "sglang.linearAttnPrefillBackend": preset.linearAttnPrefillBackend || null,
    "sglang.linearAttnDecodeBackend": preset.linearAttnDecodeBackend || null,
    "sglang.mambaSsmDtype": preset.mambaSsmDtype || null,
    "sglang.mambaRadixCacheStrategy": preset.mambaRadixCacheStrategy || null,
    "sglang.mambaTrackInterval": preset.mambaTrackInterval || null,
    "sglang.maxMambaCacheSize": preset.maxMambaCacheSize || null,
    "sglang.mambaSchedulerStrategy": preset.mambaSchedulerStrategy || null,
    "sglang.disablePrefillCudaGraph": Boolean(preset.disablePrefillCudaGraph),
    "sglang.mmFeatureTransport": preset.mmFeatureTransport || null,
    "speculative.method": preset.speculativeAlgorithm || null,
    // Raw, as the builder passed it to the path converter.
    "speculative.draftModel": preset.draftModel,
    "sglang.dsparkBlockSize": preset.dsparkBlockSize || null,
    "sglang.draftModelQuantization": preset.draftModelQuantization || null,
  };
}

/**
 * The preset's launch data in the recipe "fixed" shape: its env, the switches
 * that change how values are emitted, and Pennyroyal's qualified data from
 * pennyroyal.js (01-engines §7: preset passthrough until recipes, ENG-6).
 */
function legacyFixedData(opts, preset) {
  const fixed = { args: [], env: { ...(preset.env || {}) }, labels: [], dockerFlags: [], slots: {} };
  if (preset.positionalModel) fixed.slots.modelArgStyle = "positional";
  if (preset.disableQuantizationArg) fixed.slots.disableQuantizationArg = true;
  if (preset.disableKvCacheDtypeArg) fixed.slots.disableKvCacheDtypeArg = true;
  if (preset.disableLanguageModelOnly) fixed.slots.disableLanguageModelOnly = true;
  if (preset.pennyroyal) {
    const pennyroyal = pennyroyalLaunchFixed(opts, preset);
    fixed.args.push(...pennyroyal.args);
    fixed.labels.push(...pennyroyal.labels);
    fixed.dockerFlags.push(...pennyroyal.dockerFlags);
    Object.assign(fixed.slots, pennyroyal.slots);
  }
  return fixed;
}

// The image the launch runs always wins; the manifest identity is attached
// when the registry knows it, and an unknown image runs as a custom runtime.
function runtimeRef(source, engineId, image) {
  const ref = safeCall(() => source.resolveRuntime(engineId, { image }), null);
  return {
    runtimeId: ref?.runtimeId || null,
    manifestKey: ref?.manifestKey || null,
    image,
    features: ref?.features || {},
    compatVersion: ref?.compatVersion || null,
  };
}

/**
 * Legacy engine value (body field, preset engine, container label) -> engineId.
 * Delegates to the engine registry (01 §3); a value the registry does not map
 * to an engine this manager launches through an adapter, or a registry that
 * cannot load, falls back to the legacy coercion (anything but "sglang" is
 * vLLM). Unknown values become 400 unknown_engine at the request layer (ENG-7).
 */
function normalizeRuntimeEngine(value, registry = null) {
  const engineId = safeCall(() => {
    const source = registry || engines.getEngineRegistry();
    const mapped = source.fromLegacy(value, MANAGER_ID);
    const descriptor = source.hostedBy(MANAGER_ID).includes(mapped) ? source.get(mapped) : null;
    return descriptor && LEGACY_BUILDER_ADAPTERS.has(descriptor.adapter) && engines.adapterFor(descriptor) ? mapped : "";
  }, "");
  return engineId || legacyRuntimeEngine(value);
}

function legacyRuntimeEngine(value) {
  const text = String(value || "vllm").trim().toLowerCase();
  return LEGACY_ENGINES.has(text) ? text : "vllm";
}

module.exports = { createVllmRuntimeCommandBuilder, normalizeRuntimeEngine };
