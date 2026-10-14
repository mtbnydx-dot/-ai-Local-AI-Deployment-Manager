"use strict";

// Tier-1 vLLM adapter (01-engines §6-§7): the vLLM branch of
// vllm-manager/lib/runtime-command.js, changed to read plan.values (catalog
// param ids) and plan.fixed (recipe data) instead of the run options and the
// runtime preset. Docker flags and engine args keep today's order, so the
// goldens hold byte for byte. buildLaunch is pure: every host fact, secret and
// docker helper arrives through ctx (see _vllm-manager.js).

const {
  blockedError,
  buildWithPartialEffects,
  effectivePlan,
  ggufLogs,
  jsonArg,
  launchCommand,
  legacyPresetEffects,
  managerDockerFlags,
  requestedOption,
} = require("./_vllm-manager");
const memoryModels = require("../memory-models");

const ENGINE_ID = "vllm";
// vLLM reads its API key from this variable when --api-key is absent.
const API_KEY_ENV = "VLLM_API_KEY";

/**
 * plan + ctx -> LaunchCommand. Throws { code: "blocked", findings, launch }
 * when the runtime preset (recipe) blocks the launch; any other error it
 * throws carries the same { launch: { metaPatch, logs } } of what came before.
 */
function buildLaunch(input, ctx) {
  return buildWithPartialEffects((effects) => buildCommand(effectivePlan(input), ctx, effects));
}

function buildCommand(plan, ctx, effects) {
  const values = plan.values;
  const fixed = plan.fixed || {};
  const slots = fixed.slots || {};
  const model = ctx.model || {};
  const image = ctx.runtime?.image;
  const engineLabel = ctx.descriptor?.legacy?.engineLabel || ENGINE_ID;
  const logs = effects.logs;

  const { metaPatch, blockedReason } = legacyPresetEffects(plan, { engineLabel, image, logs });
  effects.metaPatch = metaPatch;
  if (blockedReason) throw blockedError(blockedReason, { metaPatch, logs });
  ggufLogs(plan, ctx, logs);
  const { flags, publish, secretEnv } = managerDockerFlags(plan, ctx, {
    logs,
    engineLabel,
    fraction: values["vllm.gpuMemoryUtilization"],
    apiKeyEnv: API_KEY_ENV,
  });

  const args = slots.modelArgStyle === "positional" ? [model.modelArg] : ["--model", model.modelArg];
  args.push(
    "--served-model-name", values.servedName,
    "--dtype", values.dtype,
    "--max-model-len", String(values.contextLength),
    "--max-num-seqs", String(values.concurrency),
    "--gpu-memory-utilization", String(values["vllm.gpuMemoryUtilization"])
  );
  if (values["vllm.maxNumBatchedTokens"]) {
    args.push("--max-num-batched-tokens", String(values["vllm.maxNumBatchedTokens"]));
  }
  if (model.effectiveLoadFormat === "gguf") {
    // GGUF already carries quantized weights: no --quantization, only the load format.
    const requested = requestedOption(plan, "quantization") || values.quantization;
    if (requested) logs.push(`Ignoring quantization "${requested}" because GGUF already contains quantized weights.`);
    args.push("--load-format", "gguf");
  } else if (values.quantization && !slots.disableQuantizationArg) {
    args.push("--quantization", values.quantization);
  }
  if (values.tokenizer) args.push("--tokenizer", ctx.toContainerPath(values.tokenizer));
  if (values["vllm.hfConfigPath"]) args.push("--hf-config-path", ctx.toContainerPath(values["vllm.hfConfigPath"]));
  const kvCacheDtypeArg = slots.disableKvCacheDtypeArg ? "" : values.kvCacheDtype;
  if (kvCacheDtypeArg && kvCacheDtypeArg !== "auto") args.push("--kv-cache-dtype", kvCacheDtypeArg);
  if (values["vllm.cpuOffloadGb"] > 0) args.push("--cpu-offload-gb", String(values["vllm.cpuOffloadGb"]));
  if (values["vllm.kvOffloadingSize"] > 0) args.push("--kv-offloading-size", String(values["vllm.kvOffloadingSize"]));
  if (values["vllm.mmProcessorCacheGb"] !== null && values["vllm.mmProcessorCacheGb"] !== undefined) {
    args.push("--mm-processor-cache-gb", String(values["vllm.mmProcessorCacheGb"]));
  }
  // vLLM caches prefixes by default, so "off" needs the explicit flag.
  if (values.prefixCaching === false) {
    args.push("--no-enable-prefix-caching");
  } else if (values.prefixCaching === true) {
    args.push("--enable-prefix-caching");
  }
  if (values["vllm.languageModelOnly"]) {
    args.push("--language-model-only");
  } else if (requestedOption(plan, "languageModelOnly") && slots.disableLanguageModelOnly) {
    logs.push("Runtime preset disabled --language-model-only because this architecture is not a plain language-only model.");
  }
  if (values.trustRemoteCode) args.push("--trust-remote-code");
  if (values.tensorParallel > 1) args.push("--tensor-parallel-size", String(values.tensorParallel));
  if (values.pipelineParallel > 1) args.push("--pipeline-parallel-size", String(values.pipelineParallel));
  if (values.dataParallel > 1) args.push("--data-parallel-size", String(values.dataParallel));
  if (values["vllm.distributedExecutorBackend"] && values["vllm.distributedExecutorBackend"] !== "auto") {
    args.push("--distributed-executor-backend", values["vllm.distributedExecutorBackend"]);
  }
  if (values.expertParallel) args.push("--enable-expert-parallel");
  if (values["vllm.enforceEager"]) args.push("--enforce-eager");
  if (values["vllm.asyncScheduling"]) args.push("--async-scheduling");
  if (values["vllm.attentionBackend"]) args.push("--attention-backend", values["vllm.attentionBackend"]);
  if (values["vllm.moeBackend"]) args.push("--moe-backend", values["vllm.moeBackend"]);
  if (values["vllm.linearBackend"]) args.push("--linear-backend", values["vllm.linearBackend"]);
  if (values.generationConfig) args.push("--generation-config", values.generationConfig);
  if (values["vllm.overrideGenerationConfig"]) {
    args.push("--override-generation-config", jsonArg(values["vllm.overrideGenerationConfig"]));
  }
  if (values.chatTemplateKwargs) args.push("--default-chat-template-kwargs", jsonArg(values.chatTemplateKwargs));
  if (values["vllm.speculativeConfig"]) args.push("--speculative-config", jsonArg(values["vllm.speculativeConfig"]));
  if (values["vllm.safetensorsLoadStrategy"]) {
    args.push("--safetensors-load-strategy", values["vllm.safetensorsLoadStrategy"]);
  }
  if (values["vllm.reasoningParserPlugin"]) {
    args.push("--reasoning-parser-plugin", ctx.toContainerPath(values["vllm.reasoningParserPlugin"]));
  }
  if (values.reasoningParser && values.reasoningParser !== "auto") {
    args.push("--reasoning-parser", values.reasoningParser);
  }
  if (values.autoToolChoice && values.toolCallParser) {
    args.push("--enable-auto-tool-choice", "--tool-call-parser", values.toolCallParser);
  }
  // Recipe fixed args close the engine args; no --api-key (VLLM_API_KEY above).
  args.push(...(fixed.args || []));

  return launchCommand(ctx, { flags, entrypoint: null, image, args, publish, secretEnv, metaPatch, logs });
}

/** plan + ctx -> MemoryEstimate (01 §12): MemoryInputs from the plan; the policy lives in memory-models.js. */
function estimateMemory(plan, ctx = {}) {
  return memoryModels.estimate(ENGINE_ID, memoryModels.inputsFromPlan(plan, ctx), { descriptor: ctx.descriptor });
}

module.exports = {
  id: ENGINE_ID,
  API_KEY_ENV,
  buildLaunch,
  estimateMemory,
};
