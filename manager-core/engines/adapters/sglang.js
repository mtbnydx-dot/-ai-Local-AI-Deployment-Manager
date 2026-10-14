"use strict";

// Tier-1 SGLang adapter (01-engines §6-§7): appendSglangServeArgs and the
// SGLang docker branch of vllm-manager/lib/runtime-command.js, changed to read
// plan.values (catalog param ids) and plan.fixed (recipe data) instead of the
// run options and the runtime preset. Model-specific launch data (Pennyroyal's
// docker flags, labels, cache volume and NEXTN/FR-Spec tail) arrives as recipe
// data through named slots, never as a branch here:
//   restart, hfCacheMount, modelMountReadOnly   shared docker layout
//   variantDockerFlags                           fixed.dockerFlags + fixed.labels, after the ai.sglang.* labels
//   cacheMount                                   slots.cacheMount ("--mount" spec) instead of the cache root
//   fixedArgsTail                                fixed.args, after DSPARK and before --api-key
// SGLang takes the API key as --api-key (08 O1): it stays in argv and is
// listed in redactions for the redactor.

const {
  blockedError,
  effectivePlan,
  ggufLogs,
  jsonArg,
  launchCommand,
  legacyPresetEffects,
  managerDockerFlags,
} = require("./_vllm-manager");

const ENGINE_ID = "sglang";
const ENTRYPOINT = "sglang";
const CONTAINER_PORT = "8000";
const DEFAULT_CHUNKED_PREFILL_SIZE = 8192;
const DEFAULT_DSPARK_BLOCK_SIZE = 7;
const CACHE_MOUNT = Object.freeze({ configKey: "sglangCache", target: "/root/.cache" });

/** The running-request cap SGLang is launched with (the recipe's, else the concurrency). */
function maxRunningRequests(values) {
  return values["sglang.maxRunningRequests"] || values.concurrency;
}

/**
 * plan + ctx -> LaunchCommand. Throws { code: "blocked", findings, launch }
 * when the runtime preset (recipe) blocks the launch.
 */
function buildLaunch(input, ctx) {
  const plan = effectivePlan(input);
  const values = plan.values;
  const fixed = plan.fixed || {};
  const slots = fixed.slots || {};
  const model = ctx.model || {};
  const secrets = ctx.secrets || {};
  const image = ctx.runtime?.image;
  const engineLabel = ctx.descriptor?.legacy?.engineLabel || ENGINE_ID;
  const logs = [];

  const { metaPatch, blockedReason } = legacyPresetEffects(plan, { engineLabel, image, logs });
  if (blockedReason) throw blockedError(blockedReason, { metaPatch, logs });
  ggufLogs(plan, ctx, logs);
  const { flags, publish, secretEnv } = managerDockerFlags(plan, ctx, {
    logs,
    engineLabel,
    fraction: values["sglang.memFractionStatic"],
    engineLabelFlags: [
      "--label", `ai.sglang.max-total-tokens=${values["sglang.maxTotalTokens"] || 0}`,
      "--label", `ai.sglang.page-size=${values["sglang.pageSize"] || 0}`,
      "--label", `ai.sglang.max-mamba-cache-size=${values["sglang.maxMambaCacheSize"] || 0}`,
      "--label", `ai.sglang.effective-max-running-requests=${maxRunningRequests(values)}`,
      "--label", `ai.sglang.ple-offload-embedding=${Boolean(values["sglang.pleOffloadEmbedding"])}`,
    ],
    engineCacheMount: CACHE_MOUNT,
  });

  const args = [
    "serve",
    "--model-path", model.modelArg,
    "--served-model-name", values.servedName,
    "--host", "0.0.0.0",
    "--port", CONTAINER_PORT,
    "--tp-size", String(Math.max(1, Number(values.tensorParallel || 1))),
    "--mem-fraction-static", String(values["sglang.memFractionStatic"]),
    "--max-running-requests", String(maxRunningRequests(values)),
    "--context-length", String(values.contextLength),
    "--chunked-prefill-size", String(values["sglang.chunkedPrefillSize"] || DEFAULT_CHUNKED_PREFILL_SIZE),
    "--enable-metrics",
    "--sleep-on-idle",
  ];
  if (values["sglang.maxTotalTokens"]) args.push("--max-total-tokens", String(values["sglang.maxTotalTokens"]));
  if (values["sglang.pageSize"]) args.push("--page-size", String(values["sglang.pageSize"]));
  if (values.dtype && values.dtype !== "auto") args.push("--dtype", values.dtype);
  const quantizationArg = slots.disableQuantizationArg ? "" : values.quantization;
  if (quantizationArg) args.push("--quantization", quantizationArg);
  const kvCacheDtypeArg = slots.disableKvCacheDtypeArg ? "" : values.kvCacheDtype;
  if (kvCacheDtypeArg && kvCacheDtypeArg !== "auto") args.push("--kv-cache-dtype", kvCacheDtypeArg);
  if (values["sglang.fp4GemmBackend"]) args.push("--fp4-gemm-backend", values["sglang.fp4GemmBackend"]);
  if (values["sglang.pleOffloadEmbedding"]) args.push("--ple-offload-embedding");
  if (values["sglang.linearAttnPrefillBackend"]) {
    args.push("--linear-attn-prefill-backend", values["sglang.linearAttnPrefillBackend"]);
  }
  if (values["sglang.linearAttnDecodeBackend"]) {
    args.push("--linear-attn-decode-backend", values["sglang.linearAttnDecodeBackend"]);
  }
  if (values["sglang.mambaSsmDtype"]) args.push("--mamba-ssm-dtype", values["sglang.mambaSsmDtype"]);
  if (values["sglang.mambaRadixCacheStrategy"]) {
    args.push("--mamba-radix-cache-strategy", values["sglang.mambaRadixCacheStrategy"]);
  }
  if (values["sglang.mambaTrackInterval"]) {
    args.push("--mamba-track-interval", String(values["sglang.mambaTrackInterval"]));
  }
  if (values["sglang.maxMambaCacheSize"]) {
    args.push("--max-mamba-cache-size", String(values["sglang.maxMambaCacheSize"]));
  }
  if (values.chatTemplateKwargs) args.push("--default-chat-template-kwargs", jsonArg(values.chatTemplateKwargs));
  if (values["sglang.mambaSchedulerStrategy"]) {
    args.push("--mamba-scheduler-strategy", values["sglang.mambaSchedulerStrategy"]);
  }
  if (values["sglang.attentionBackend"]) args.push("--attention-backend", values["sglang.attentionBackend"]);
  if (values["sglang.disablePrefillCudaGraph"]) args.push("--disable-prefill-cuda-graph");
  if (values["sglang.mmFeatureTransport"]) args.push("--mm-feature-transport", values["sglang.mmFeatureTransport"]);
  if (values.prefixCaching === false) args.push("--disable-radix-cache");
  if (values.trustRemoteCode) args.push("--trust-remote-code");
  if (values.reasoningParser && values.reasoningParser !== "auto") {
    args.push("--reasoning-parser", values.reasoningParser);
  }
  if (values.autoToolChoice && values.toolCallParser) {
    args.push("--tool-call-parser", values.toolCallParser);
  }
  // Only DSPARK has a generic emission today; recipes that pin another
  // speculative method (NEXTN/FR-Spec) carry it in their fixed args.
  if (values["speculative.method"] === "DSPARK") {
    args.push(
      "--speculative-algorithm", "DSPARK",
      "--speculative-draft-model-path", ctx.toContainerPath(values["speculative.draftModel"]),
      "--speculative-dspark-block-size", String(values["sglang.dsparkBlockSize"] || DEFAULT_DSPARK_BLOCK_SIZE),
      "--speculative-draft-model-quantization", values["sglang.draftModelQuantization"] || "unquant"
    );
  }
  args.push(...(fixed.args || []));
  if (secrets.apiKey) args.push("--api-key", secrets.apiKey);

  return launchCommand(ctx, { flags, entrypoint: ENTRYPOINT, image, args, publish, secretEnv, metaPatch, logs });
}

module.exports = {
  id: ENGINE_ID,
  ENTRYPOINT,
  buildLaunch,
};
