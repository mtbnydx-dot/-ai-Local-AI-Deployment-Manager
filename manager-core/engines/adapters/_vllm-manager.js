"use strict";

// The launch-command parts vllm-manager has always built the same way for the
// two tier-1 engines it hosts (01-engines §6-§7): the docker flags up to the
// image, the shared launch log lines, and the job.meta block of a runtime
// preset. adapters/vllm.js and adapters/sglang.js add their engine args. The
// code is the extracted legacy builder (vllm-manager/lib/runtime-command.js);
// docker flags are emitted in exactly today's order.
//
// What an adapter reads (ENG-5):
//   plan.values    effective values by catalog param id (contextLength,
//                  concurrency, vllm.*, sglang.*, ...), plain or wrapped as
//                  { value, source } the way a resolved LaunchPlan carries them
//   plan.fixed     recipe data { args, env, labels, dockerFlags, slots }. Slots:
//                  restart, hfCacheMount, modelMountReadOnly, cacheMount,
//                  modelArgStyle, disableQuantizationArg, disableKvCacheDtypeArg,
//                  disableLanguageModelOnly
//   plan.instance  { id, mode, port, networkAccess, serviceHost, containerName, gpuIds }
//   plan.legacy    { preset, runOptions, quantization }: the legacy inputs the
//                  job.meta block and its log lines are written from, until the
//                  supervisor writes job meta from the plan
//   ctx            { descriptor, runtime, host: { config, labelKeys, modelMountArgs },
//                    model, hostFacts: { env }, secrets: { apiKey, apiKeyRef, hfToken },
//                    jobId, admission: { leaseId, vramReservationMb },
//                    toContainerPath, dockerGpuArg, dockerPublishArgs,
//                    publishArgsToDockerRunArgs, normalizeGpuIds, lanAddress }
// Secrets reach the adapter only through ctx.secrets, never through the plan,
// so a plan can be shown, hashed and stored as it is.

const path = require("node:path");
const { envAssignmentFlags, labelFlags, labelsFromFlags, launchLabelFlags } = require("./_docker-segments");

const HEALTH_CMD = "curl -fsS http://127.0.0.1:8000/health || exit 1";
const HF_CACHE_TARGET = "/root/.cache/huggingface";
const VLLM_CACHE_TARGET = "/root/.cache/vllm";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The plan an adapter builds from: plan.values as plain values. A resolved
 * plan wraps each value with its provenance (00 §4.3); the legacy wrapper
 * passes plain values. Both build the same command.
 */
function effectivePlan(plan) {
  const source = isPlainObject(plan) ? plan : {};
  const values = {};
  for (const [id, entry] of Object.entries(isPlainObject(source.values) ? source.values : {})) {
    values[id] = isPlainObject(entry) && Object.hasOwn(entry, "value") && Object.hasOwn(entry, "source") ? entry.value : entry;
  }
  return { ...source, values };
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function formatPublish(publishArgs) {
  return publishArgs.map((arg) => `-p ${arg}`).join(" ");
}

// A JSON-typed value is emitted verbatim when it arrives already serialised
// (the legacy presets hand over strings) and stringified otherwise.
function jsonArg(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The legacy run option a log line compares against (the user's request). */
function requestedOption(plan, field) {
  return plan.legacy?.runOptions?.[field];
}

function startPeriodMinutes(timeoutMs) {
  return Math.min(60, Math.max(5, Math.round(Math.max(5 * 60 * 1000, Number(timeoutMs || 60 * 60 * 1000)) / 60000)));
}

/**
 * The runtime-preset block of the legacy builder: the model-config
 * quantization note, then (only when a preset applies) the job.meta fields,
 * the preset log lines and the block reason. Log lines are pushed to `logs`.
 * -> { metaPatch: object|null, blockedReason: string }
 */
function legacyPresetEffects(plan, { engineLabel, image, logs }) {
  const legacy = plan.legacy || {};
  const preset = legacy.preset || {};
  const opts = legacy.runOptions || {};
  const quantization = legacy.quantization || {};
  const effectiveDtype = preset.dtype || opts.dtype;
  const effectiveKvCacheDtype = preset.kvCacheDtype || opts.kvCacheDtype;
  const effectiveMaxNumBatchedTokens = Math.max(positiveInteger(opts.maxNumBatchedTokens), positiveInteger(preset.maxNumBatchedTokens));

  if (quantization.modelConfigMethod && opts.quantization && quantization.value !== opts.quantization) {
    logs.push(`Quantization override: model config declares "${quantization.modelConfigMethod}", ignoring requested "${opts.quantization}".`);
  }
  if (!preset.id) return { metaPatch: null, blockedReason: "" };

  const metaPatch = {
    runtimePreset: preset.id,
    engine: engineLabel,
    runtimeImage: image,
    runtimeNotes: preset.notes || [],
    dtype: effectiveDtype,
    kvCacheDtype: preset.disableKvCacheDtypeArg ? "auto" : effectiveKvCacheDtype,
    trustRemoteCode: Boolean(opts.trustRemoteCode || preset.forceTrustRemoteCode),
    enablePrefixCaching: Boolean(opts.enablePrefixCaching && !preset.disablePrefixCaching),
    // vLLM enables prefix caching by default. The form exposes a *disable*
    // toggle (and presets can force it), so the explicit disable flag is
    // emitted instead of relying on "no flag", which still leaves caching on.
    disablePrefixCaching: Boolean(opts.disablePrefixCaching || preset.disablePrefixCaching),
    languageModelOnly: Boolean(opts.languageModelOnly && !preset.disableLanguageModelOnly),
    enforceEager: Boolean(preset.enforceEager),
    reasoningParser: preset.reasoningParser || opts.reasoningParser,
    toolCallParser: preset.toolCallParser || opts.toolCallParser,
    enableAutoToolChoice: Boolean(preset.enableAutoToolChoice || opts.enableAutoToolChoice),
    moeBackend: preset.moeBackend || "",
    generationConfig: preset.generationConfig || "",
    quantization: preset.quantization || quantization.value || "",
    speculativeConfig: preset.speculativeConfig || null,
    draftModel: preset.draftModel || opts.draftModel || "",
    dsparkBlockSize: preset.dsparkBlockSize || opts.dsparkBlockSize || null,
    reasoningParserPlugin: preset.reasoningParserPlugin || "",
    sglangMaxTotalTokens: preset.maxTotalTokens || 0,
    sglangPageSize: preset.pageSize || 0,
    sglangChunkedPrefillSize: preset.chunkedPrefillSize || 0,
    sglangFp4GemmBackend: preset.fp4GemmBackend || "",
    sglangAttentionBackend: preset.attentionBackend || "",
    sglangPleOffloadEmbedding: Boolean(preset.pleOffloadEmbedding),
    sglangLinearAttnPrefillBackend: preset.linearAttnPrefillBackend || "",
    sglangLinearAttnDecodeBackend: preset.linearAttnDecodeBackend || "",
    sglangMambaSsmDtype: preset.mambaSsmDtype || "",
    sglangMambaRadixCacheStrategy: preset.mambaRadixCacheStrategy || "",
    sglangMambaTrackInterval: preset.mambaTrackInterval || 0,
    sglangMaxMambaCacheSize: preset.maxMambaCacheSize || 0,
    sglangDisableThinkingByDefault: Boolean(preset.disableThinkingByDefault),
    effectiveMaxRunningRequests: preset.effectiveMaxRunningRequests || opts.maxNumSeqs,
    ...(effectiveMaxNumBatchedTokens ? { maxNumBatchedTokens: effectiveMaxNumBatchedTokens } : {}),
  };
  logs.push(`Runtime preset: ${preset.label || preset.id}; using ${engineLabel} image ${image}.`);
  for (const note of preset.notes || []) logs.push(`Runtime preset note: ${note}`);
  if (preset.kvCacheDtype && preset.kvCacheDtype !== opts.kvCacheDtype) {
    logs.push(`KV cache dtype override: ${opts.kvCacheDtype || "auto"} -> ${preset.kvCacheDtype}.`);
  }
  if (preset.dtype && preset.dtype !== opts.dtype) {
    logs.push(`Dtype override: ${opts.dtype || "auto"} -> ${preset.dtype}.`);
  }
  if (preset.generationConfig) {
    logs.push(`Generation config override: using ${preset.generationConfig}.`);
  }
  if (preset.quantization && preset.quantization !== quantization.value) {
    logs.push(`Quantization runtime override: ${quantization.value || "auto"} -> ${preset.quantization}.`);
  }
  if (preset.disableKvCacheDtypeArg && opts.kvCacheDtype && opts.kvCacheDtype !== "auto") {
    logs.push(`KV cache dtype override: ignoring requested "${opts.kvCacheDtype}" so vLLM can auto-detect this checkpoint.`);
  }
  if (preset.disableQuantizationArg && quantization.value) {
    logs.push(`Quantization override: ignoring requested "${opts.quantization || quantization.value}" so vLLM can auto-detect this checkpoint.`);
  }
  if (preset.unsupportedReason) {
    logs.push(`Runtime preset blocked: ${preset.unsupportedReason}`);
    return { metaPatch, blockedReason: String(preset.unsupportedReason) };
  }
  return { metaPatch, blockedReason: "" };
}

/**
 * The error buildLaunch throws when the preset (recipe) blocks the launch. It
 * carries the job.meta patch and log lines produced up to the block, which the
 * legacy builder had already written when it threw.
 */
function blockedError(reason, launch) {
  const error = new Error(reason);
  error.code = "blocked";
  error.findings = [{
    severity: "fail",
    code: "recipe_blocked",
    title: { zh: "当前配方不允许这次启动", en: "The launch recipe blocks this launch" },
    detail: { zh: reason, en: reason },
  }];
  error.launch = { metaPatch: launch.metaPatch || null, logs: launch.logs || [] };
  return error;
}

/**
 * Runs an adapter build. Whatever it throws carries error.launch: the job.meta
 * patch and the log lines produced before the failure, which the legacy
 * builder had already written by then (a blocked preset, or a docker or path
 * helper that throws), so the caller can replay them.
 */
function buildWithPartialEffects(build) {
  const effects = { metaPatch: null, logs: [] };
  try {
    return build(effects);
  } catch (error) {
    if (error && typeof error === "object" && !error.launch && Object.isExtensible(error)) {
      error.launch = { metaPatch: effects.metaPatch, logs: effects.logs.slice() };
    }
    throw error;
  }
}

/** The GGUF lines of the legacy builder (both engines log them). */
function ggufLogs(plan, ctx, logs) {
  const model = ctx.model || {};
  if (model.effectiveLoadFormat !== "gguf") return;
  logs.push(`GGUF mode: using ${model.modelArg}`);
  if (model.selectedGgufFile && (model.ggufFiles || []).length > 1) {
    logs.push(`Multiple GGUF files found; selected largest file: ${path.basename(model.selectedGgufFile)}`);
  }
  if (!plan.values?.tokenizer) {
    logs.push("GGUF warning: tokenizer is empty. vLLM can try GGUF tokenizer conversion, but a base Hugging Face tokenizer is usually faster and more stable.");
  }
}

/**
 * Docker flags between "run -d" and the entrypoint/image, in legacy order:
 * platform, name, restart, the ai.manager.* labels, GPUs, health check,
 * publish, the HF cache and model mounts, the engine's labels, the recipe's
 * docker flags and labels, the cache mount, the API-key ref label, then the
 * secret env names, the recipe env and last the launch identity labels (01
 * §15.2). Also logs the publish, LAN and GPU lines.
 *
 * options: { logs, engineId, engineLabel, fraction, engineLabelFlags, engineCacheMount:{configKey,target}, apiKeyEnv }
 * -> { flags, publish, secretEnv }
 */
function managerDockerFlags(plan, ctx, options) {
  const { logs, engineId = "", engineLabel, fraction, engineLabelFlags = [], engineCacheMount = null, apiKeyEnv = "" } = options;
  const values = plan.values || {};
  const fixed = plan.fixed || {};
  const slots = fixed.slots || {};
  const instance = plan.instance || {};
  const host = ctx.host || {};
  const config = host.config || {};
  const keys = host.labelKeys || {};
  const admission = ctx.admission || {};
  const secrets = ctx.secrets || {};

  const publish = ctx.dockerPublishArgs(instance.port, instance.networkAccess, instance.serviceHost);
  logs.push(`Docker publish: ${formatPublish(publish)}`);
  const selectedGpuIds = ctx.normalizeGpuIds(instance.gpuIds);
  const vramReservationMb = Math.max(0, Math.round(Number(admission.vramReservationMb || 0)));
  const flags = [
    ...(config.imagePlatform ? ["--platform", config.imagePlatform] : []),
    "--pull", "never",
    "--name", instance.containerName || config.containerName,
    "--restart", slots.restart || "on-failure:3",
    "--label", `${keys.manager}=${config.managerLabelValue}`,
    "--label", `${keys.engine}=${engineLabel}`,
    "--label", `ai.manager.job=${ctx.jobId}`,
    "--label", `ai.manager.instance=${instance.id || "primary"}`,
    "--label", `ai.manager.instance-mode=${instance.mode || "replace"}`,
    "--label", `ai.manager.model=${values.servedName || ""}`,
    "--label", `ai.manager.port=${instance.port}`,
    "--label", `ai.manager.gpu-ids=${selectedGpuIds.join(",")}`,
    "--label", `ai.manager.vram-reservation-mb=${vramReservationMb}`,
    "--label", `ai.manager.max-model-len=${values.contextLength}`,
    "--label", `ai.manager.max-num-seqs=${values.concurrency}`,
    // vllm-manager records the batched-token budget for both engines.
    "--label", `ai.manager.max-num-batched-tokens=${values["vllm.maxNumBatchedTokens"] || 0}`,
    "--label", `ai.manager.gpu-memory-utilization=${fraction}`,
    "--label", `ai.manager.gpu-admission-lease=${admission.leaseId || ""}`,
    "--gpus", ctx.dockerGpuArg(instance.gpuIds || []),
    "--ipc=host",
    "--health-cmd", HEALTH_CMD,
    "--health-interval", "30s",
    "--health-timeout", "5s",
    "--health-retries", "3",
    "--health-start-period", `${startPeriodMinutes(ctx.hostFacts?.env?.VLLM_START_TIMEOUT_MS)}m`,
    ...ctx.publishArgsToDockerRunArgs(publish),
    ...(slots.hfCacheMount === false ? [] : ["-v", `${config.hfCache}:${HF_CACHE_TARGET}`]),
    ...(host.modelMountArgs || []).map((arg, index) => (slots.modelMountReadOnly && index % 2 === 1 ? `${arg}:ro` : arg)),
    ...engineLabelFlags,
    ...(fixed.dockerFlags || []),
    ...labelFlags(fixed.labels),
  ];
  if (slots.cacheMount) {
    flags.push("--mount", slots.cacheMount);
  } else if (engineCacheMount && config[engineCacheMount.configKey]) {
    flags.push("-v", `${config[engineCacheMount.configKey]}:${engineCacheMount.target}`);
  } else if (config.vllmCache) {
    // Legacy fallback: without its own cache root an SGLang launch also gets
    // the vLLM compile cache, as the builder always did.
    flags.push("-v", `${config.vllmCache}:${VLLM_CACHE_TARGET}`);
  }
  if (secrets.apiKeyRef && keys.apiKeyRef) {
    flags.push("--label", `${keys.apiKeyRef}=${secrets.apiKeyRef}`);
  }
  if (instance.networkAccess === "lan" && !secrets.apiKey) {
    logs.push(`安全警告：服务将通过 Docker 发布到 ${instance.serviceHost || ctx.lanAddress()}（局域网可访问），但没有设置 API Key。同一网络内的任何设备都可以调用该模型。建议在启动参数中填写 API Key。`);
  }
  if (selectedGpuIds.length) {
    logs.push(`GPU isolation: --gpus device=${selectedGpuIds.join(",")}`);
  }
  // Secrets travel as name-only -e flags; the caller hands secretEnv to the
  // docker child process (08 P0-4). Engines that take the key as a flag get
  // no apiKeyEnv and append the flag to their args instead.
  const secretEnv = {};
  if (secrets.hfToken) {
    flags.push("-e", "HF_TOKEN");
    secretEnv.HF_TOKEN = secrets.hfToken;
  }
  if (apiKeyEnv && secrets.apiKey) {
    flags.push("-e", apiKeyEnv);
    secretEnv[apiKeyEnv] = String(secrets.apiKey);
  }
  flags.push(...envAssignmentFlags(fixed.env));
  flags.push(...launchLabelFlags({
    launchId: ctx.launchId,
    engineId: ctx.descriptor?.id || plan.engineId || engineId,
    recipeId: plan.recipeId ?? plan.recipe?.id,
    runtimeId: ctx.runtime?.runtimeId,
  }));
  return { flags, publish, secretEnv };
}

/** Assembles the LaunchCommand (01-engines §6) from the built parts. */
function launchCommand(ctx, { flags, entrypoint = null, image, args, publish, secretEnv, metaPatch, logs }) {
  const secrets = ctx.secrets || {};
  return {
    host: "docker",
    docker: { flags, entrypoint, image, args },
    publish,
    secretEnv,
    files: [],
    labels: labelsFromFlags(flags),
    metaPatch,
    logs,
    redactions: [secrets.apiKey, secrets.hfToken].filter((value) => value !== undefined && value !== null && value !== "").map(String),
  };
}

module.exports = {
  blockedError,
  buildWithPartialEffects,
  effectivePlan,
  ggufLogs,
  jsonArg,
  launchCommand,
  legacyPresetEffects,
  managerDockerFlags,
  requestedOption,
};
