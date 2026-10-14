"use strict";

// llama.cpp engine adapter (docs/overhaul/01-engines.md §6-§7, ENG-4).
//
// buildLaunch is the extracted body of llama-manager's former
// buildLlamaRuntimeCommand: the docker flags and llama-server args come out in
// exactly the legacy order, but every effective value is read from plan.values
// (catalog param ids, §9.3) and every host, runtime and model fact from ctx.
// The adapter does no I/O and touches no job: what the builder used to
// appendLog comes back in LaunchCommand.logs for the caller to replay, and the
// API key and HF token come back in secretEnv (name-only `-e NAME` in argv,
// values for the docker child process; P0-RT-1).
//
// Runtime gating reads ctx.runtime.features (§5) instead of comparing the
// image with CONFIG.image: llamacpp@b10630 has reasoningEffort and
// mmprojDevice, the retired Muse build has neither, and an image the manifest
// does not know is a custom runtime with features {}, so it gets neither flag.
//
// Model-specific defaults come from plan.recipe, the recipe the caller applied
// (its runtime pin, sampling values and legacy label); this file has no
// model-family branch (§6.1).
//
// plan (what buildLaunch reads; values may be plain or wrapped as
// { value, source } the way a resolved LaunchPlan carries them, 00 §4.3):
//   { values: { "<paramId>": value },
//     instance: { mode, id, port, networkAccess, serviceHost, gpuIds, containerName },
//     secrets: { apiKey, apiKeyRef },
//     launch: { jobId, gpuAdmissionLeaseId, vramReservationMb, gpuPlan },
//     recipe: null | { id, runtime: { ref }, values: { temperature, topP, topK }, legacy: { presetLabel } } }
// ctx (01 §6 AdapterCtx, the parts this engine uses):
//   { runtime: { runtimeId, manifestKey, image, features, compatVersion, default },
//     host: { config: { containerName, managerLabelValue, hfCache, modelsRoot }, labelKeys, modelMountArgs },
//     model: { ref, modelArg, ggufFiles, mmprojFiles, draftFiles, selectedGgufFile, ggufInventory, ... },
//     secrets: { hfToken }, toContainerPath, dockerGpuArg, dockerPublishArgs,
//     publishArgsToDockerRunArgs?, normalizeGpuIds? }

const path = require("node:path");
const { normalizeGpuIds: defaultNormalizeGpuIds } = require("../../common-utils");
const { publishArgsToDockerRunArgs: defaultPublishArgsToDockerRunArgs } = require("../../docker-utils");
const { applyExtra, labelsFromFlags, launchLabelFlags } = require("./_docker-segments");
const memoryModels = require("../memory-models");
const { emitCatalogArgs } = require("./_catalog-emit");

const ENGINE_ID = "llamacpp";
// llama-server binds --api-key to LLAMA_API_KEY (common/arg.cpp, set_env); the
// descriptor declares the same name in secrets.apiKey.env.
const API_KEY_ENV = "LLAMA_API_KEY";
const DEFAULT_LABEL_KEYS = Object.freeze({
  manager: "ai.manager",
  engine: "ai.manager.engine",
  apiKeyRef: "ai.manager.api-key-ref",
});
const SPECULATIVE_MODES = new Set(["draft-simple", "draft-mtp", "draft-dflash", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A resolved plan wraps each value with its provenance; the legacy bridge
// passes plain values. Both read the same.
function readValue(values, id) {
  const entry = isPlainObject(values) && Object.hasOwn(values, id) ? values[id] : undefined;
  if (isPlainObject(entry) && Object.hasOwn(entry, "value") && Object.hasOwn(entry, "source")) return entry.value;
  return entry;
}

function formatDockerPublishArgs(publishArgs) {
  return publishArgs.map((arg) => `-p ${arg}`).join(" ");
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
  return SPECULATIVE_MODES.has(mode) ? mode : "none";
}

function clampSpeculativeTokens(value) {
  const number = Number(value || 3);
  return Math.min(16, Math.max(1, Number.isFinite(number) ? Math.floor(number) : 3));
}

/**
 * Effective plan values + ctx -> LaunchCommand (01 §6). Pure and synchronous.
 * A failure throws the builder's own Error with the lines logged before it in
 * error.logs, so the caller can replay them the way appendLog wrote them.
 */
function buildLaunch(plan = {}, ctx = {}) {
  const logs = [];
  try {
    return buildCommand(plan || {}, ctx || {}, logs);
  } catch (error) {
    if (error && typeof error === "object" && Object.isExtensible(error) && !Array.isArray(error.logs)) error.logs = logs.slice();
    throw error;
  }
}

function buildCommand(plan, ctx, logs) {
  const values = plan.values || {};
  const value = (id) => readValue(values, id);
  const log = (line) => logs.push(line);
  const instance = plan.instance || {};
  const launch = plan.launch || {};
  const secrets = plan.secrets || {};
  const recipe = isPlainObject(plan.recipe) ? plan.recipe : null;
  const recipeValues = isPlainObject(recipe?.values) ? recipe.values : {};
  const recipeLabel = recipe ? String(recipe.legacy?.presetLabel || recipe.id || "") : "";
  const model = ctx.model || {};
  const runtime = ctx.runtime || {};
  const features = isPlainObject(runtime.features) ? runtime.features : {};
  const hostConfig = ctx.host?.config || {};
  const labelKeys = { ...DEFAULT_LABEL_KEYS, ...(ctx.host?.labelKeys || {}) };
  const toContainerPath = ctx.toContainerPath;
  const normalizeGpuIds = typeof ctx.normalizeGpuIds === "function" ? ctx.normalizeGpuIds : defaultNormalizeGpuIds;
  const publishArgsToDockerRunArgs = typeof ctx.publishArgsToDockerRunArgs === "function"
    ? ctx.publishArgsToDockerRunArgs
    : defaultPublishArgsToDockerRunArgs;

  const modelRef = model.ref;
  const modelArg = model.modelArg;
  const runtimeImage = runtime.image;
  const reasoningEffort = String(value("llamacpp.reasoningEffort") || "default");
  const reasoningBudgetValue = value("llamacpp.reasoningBudget");
  const reasoningBudget = Number.isInteger(Number(reasoningBudgetValue)) ? Number(reasoningBudgetValue) : -1;
  const mmprojDevice = String(value("llamacpp.mmprojDevice") || "auto").trim() || "auto";
  const remoteRepo = !path.isAbsolute(modelRef)
    && /^[^/\s]+\/[^/\s]+/.test(modelRef)
    && !String(modelRef).toLowerCase().endsWith(".gguf");

  if (remoteRepo) {
    log(`Remote GGUF repo mode: ${modelRef}`);
  } else {
    log(`GGUF model: using ${modelArg}`);
  }
  if (model.selectedGgufFile && (model.ggufInventory?.models?.length || 0) > 1) {
    log(`Multiple GGUF model variants found; selected: ${path.basename(model.selectedGgufFile)}`);
  }
  // A recipe that pins a runtime other than the configured default says so.
  if (recipe?.runtime && !runtime.default) {
    log(`${recipeLabel} runtime image: ${runtimeImage}`);
  }
  const textOnlyMode = value("llamacpp.textOnly");
  const explicitMmproj = String(value("llamacpp.mmproj") || "").trim();
  const autoMmproj = model.mmprojFiles?.[0]?.path
    || model.ggufFiles.find((item) => item.role === "mmproj" || /(?:^|[\\/])mmproj[^\\/]*\.gguf$/i.test(String(item.path || item.name || "")))?.path
    || "";
  const mmproj = explicitMmproj || autoMmproj;
  if (textOnlyMode) {
    log("Text-only mode: no mmproj/projector will be loaded.");
  } else if (mmproj) {
    log(`Multimodal projector: ${mmproj}`);
  } else if (!remoteRepo) {
    throw new Error("Multimodal mode requires an mmproj GGUF file in the model directory or an explicit mmproj path.");
  } else {
    log("Multimodal projector: llama.cpp will auto-resolve mmproj from the remote Hugging Face repository.");
  }
  const explicitDraftModel = String(value("speculative.draftModel") || "").trim();
  const autoDraftModel = model.draftFiles?.[0]?.path || "";
  const draftModel = explicitDraftModel || autoDraftModel;
  const speculativeMode = normalizeLlamaSpeculativeMode(value("speculative.method"), modelRef, {
    draftModel,
    draftArchitecture: model.draftFiles?.[0]?.architecture || "",
  });
  // A recipe's sampling values stand in when the user value is unset or out of range.
  const temperature = optionalSamplingNumber(value("temperature"), recipeValues.temperature ?? null, 0, 5);
  const topP = optionalSamplingNumber(value("topP"), recipeValues.topP ?? null, 0, 1);
  const topK = optionalSamplingNumber(value("topK"), recipeValues.topK ?? null, 0, 100_000, true);
  const recipeSampling = ["temperature", "topP", "topK"].some((id) => recipeValues[id] !== undefined && recipeValues[id] !== null);
  const usesExternalDraft = (speculativeMode === "draft-dflash" || speculativeMode === "draft-simple") && Boolean(draftModel);
  const gpuIds = instance.gpuIds;
  const splitMode = value("llamacpp.splitMode");
  const tensorSplit = value("llamacpp.tensorSplit");
  const mainGpu = value("llamacpp.mainGpu");
  if ((gpuIds || []).length > 1) {
    log(`Heterogeneous GPU split: mode=${splitMode}, tensor-split=${tensorSplit || "auto"}, main-gpu=${mainGpu}`);
    if (launch.gpuPlan?.summary) log(`GPU plan: ${launch.gpuPlan.summary}`);
    if (launch.gpuPlan?.mainGpuHostId !== undefined) log(`Host GPU ${launch.gpuPlan.mainGpuHostId} is visible as llama.cpp main-gpu ${mainGpu}`);
  }

  const activePublishArgs = ctx.dockerPublishArgs(instance.port, instance.networkAccess, instance.serviceHost);
  log(`Docker publish: ${formatDockerPublishArgs(activePublishArgs)}`);
  const gpuVisibility = normalizeGpuIds(gpuIds).join(",");
  const vramReservationMb = Math.max(0, Math.round(Number(launch.vramReservationMb || 0)));
  const contextLength = value("contextLength");
  const concurrency = value("concurrency");
  const gpuLayers = value("llamacpp.gpuLayers");
  const fitTargetMb = value("llamacpp.fitTargetMb");
  const fitCtx = value("llamacpp.fitCtx");
  const modelMountArgs = Array.isArray(ctx.host?.modelMountArgs)
    ? ctx.host.modelMountArgs
    : ["-v", `${hostConfig.modelsRoot}:/models`];
  const flags = [
    "--name", instance.containerName || hostConfig.containerName,
    "--restart", "on-failure:3",
    "--label", `${labelKeys.manager}=${hostConfig.managerLabelValue}`,
    "--label", `${labelKeys.engine}=llama`,
    "--label", `ai.manager.job=${launch.jobId || ""}`,
    "--label", `ai.manager.instance=${instance.id || "primary"}`,
    "--label", `ai.manager.instance-mode=${instance.mode || "replace"}`,
    "--label", `ai.manager.model=${value("servedName") || ""}`,
    "--label", `ai.manager.port=${instance.port}`,
    "--label", `ai.manager.gpu-ids=${gpuVisibility}`,
    "--label", `ai.manager.vram-reservation-mb=${vramReservationMb}`,
    "--label", `ai.manager.max-model-len=${contextLength}`,
    "--label", `ai.manager.max-num-seqs=${concurrency}`,
    "--label", `ai.manager.gpu-memory-utilization=${value("llamacpp.planningUtilization")}`,
    "--label", `ai.manager.gpu-layers=${gpuLayers}`,
    "--label", `ai.manager.cache-type-k=${value("llamacpp.cacheTypeK") || ""}`,
    "--label", `ai.manager.cache-type-v=${value("llamacpp.cacheTypeV") || ""}`,
    "--label", `ai.manager.tensor-split=${tensorSplit || ""}`,
    "--label", `ai.manager.speculative-mode=${speculativeMode}`,
    "--label", `ai.manager.reasoning-effort=${features.reasoningEffort ? reasoningEffort : "default"}`,
    "--label", `ai.manager.reasoning-budget=${reasoningBudget}`,
    "--label", `ai.manager.mmproj-device=${features.mmprojDevice ? mmprojDevice : "auto"}`,
    "--label", `ai.manager.fit-target-mb=${Math.max(0, Number(fitTargetMb || 0))}`,
    "--label", `ai.manager.fit-ctx=${Math.max(0, Number(fitCtx || 0))}`,
    "--label", `ai.manager.mmproj=${Boolean(mmproj)}`,
    "--label", `ai.manager.draft-model=${usesExternalDraft}`,
    "--label", `ai.manager.text-only=${Boolean(textOnlyMode)}`,
    "--label", `ai.manager.gpu-admission-lease=${launch.gpuAdmissionLeaseId || ""}`,
    "--gpus", ctx.dockerGpuArg(gpuIds || []),
    "--ipc=host",
    ...publishArgsToDockerRunArgs(activePublishArgs),
    "-v", `${hostConfig.hfCache}:/root/.cache/huggingface`,
    ...modelMountArgs,
  ];
  if (secrets.apiKeyRef && labelKeys.apiKeyRef) {
    flags.push("--label", `${labelKeys.apiKeyRef}=${secrets.apiKeyRef}`);
  }
  if (gpuVisibility) {
    flags.push(
      "-e", `NVIDIA_VISIBLE_DEVICES=${gpuVisibility}`,
      "-e", `CUDA_VISIBLE_DEVICES=${gpuVisibility}`,
      "-e", "NVIDIA_DRIVER_CAPABILITIES=compute,utility"
    );
  }
  // Secrets travel as name-only -e flags; the caller hands secretEnv to the
  // docker child process (08 P0-4), so no value appears in argv.
  const secretEnv = {};
  const hfToken = ctx.secrets?.hfToken;
  if (hfToken) {
    flags.push("-e", "HF_TOKEN");
    secretEnv.HF_TOKEN = hfToken;
  }
  if (secrets.apiKey) {
    flags.push("-e", API_KEY_ENV);
    secretEnv[API_KEY_ENV] = String(secrets.apiKey);
  }
  // The launch identity labels (01 §15.2) are the last docker flags.
  flags.push(...launchLabelFlags({
    launchId: ctx.launchId,
    engineId: ctx.descriptor?.id || ENGINE_ID,
    recipeId: recipe?.id,
    runtimeId: runtime.runtimeId,
  }));

  const args = [];
  if (remoteRepo) {
    args.push("--hf-repo", modelRef);
    // llama.cpp enables automatic mmproj discovery for --hf-repo by default.
    // Make the manager's text-only switch authoritative so the launched
    // runtime matches both the UI promise and the VRAM admission estimate.
    if (textOnlyMode) args.push("--no-mmproj");
  } else {
    args.push("--model", modelArg);
  }
  const totalContextSize = Math.max(1, Number(contextLength || 1)) * Math.max(1, Number(concurrency || 1));
  log(`Context budget: ${contextLength} tokens per slot x ${concurrency} slots = --ctx-size ${totalContextSize}.`);
  args.push(
    "--alias", value("servedName"),
    "--host", "0.0.0.0",
    "--port", "8080",
    "--ctx-size", String(totalContextSize),
    "--parallel", String(concurrency),
    "--batch-size", String(value("llamacpp.batchSize")),
    "--ubatch-size", String(value("llamacpp.ubatchSize")),
    "--n-gpu-layers", gpuLayers,
    "--split-mode", splitMode,
    "--main-gpu", String(mainGpu),
    "--cache-type-k", value("llamacpp.cacheTypeK"),
    "--cache-type-v", value("llamacpp.cacheTypeV"),
    "--flash-attn", value("llamacpp.flashAttention"),
    "--reasoning", value("llamacpp.reasoning"),
    "--reasoning-format", value("llamacpp.reasoningFormat"),
    "--reasoning-budget", String(reasoningBudget),
    "--metrics",
    "--jinja"
  );
  if (features.reasoningEffort) {
    args.push("--reasoning-effort", reasoningEffort);
  } else if (reasoningEffort !== "default") {
    log(`Runtime ${runtimeImage} predates --reasoning-effort; requested ${reasoningEffort} was left at template default.`);
  }
  if (Number(fitTargetMb || 0) > 0) {
    args.push("--fit", "on", "--fit-target", String(Math.floor(Number(fitTargetMb))));
  }
  if (Number(fitCtx || 0) > 0) {
    args.push("--fit-ctx", String(Math.floor(Number(fitCtx))));
  }
  if (!textOnlyMode && mmproj) args.push("--mmproj", toContainerPath(mmproj));
  if (!textOnlyMode && features.mmprojDevice) {
    args.push("--mmproj-device", mmprojDevice);
  } else if (!textOnlyMode && mmprojDevice !== "auto") {
    log(`Runtime ${runtimeImage} predates --mmproj-device; requested ${mmprojDevice} was left at auto.`);
  }
  if (speculativeMode !== "none") {
    args.push("--spec-type", speculativeMode);
    if (speculativeMode.startsWith("draft-")) {
      if (speculativeMode === "draft-dflash") {
        if (!draftModel) throw new Error("draft-dflash requires a local DFlash GGUF draft model.");
        args.push("--model-draft", toContainerPath(draftModel));
        log(`DFlash draft model: ${draftModel}`);
      } else if (speculativeMode === "draft-simple" && draftModel) {
        args.push("--model-draft", toContainerPath(draftModel));
      }
      args.push("--spec-draft-n-max", String(clampSpeculativeTokens(value("speculative.numTokens"))));
    }
  }
  if (temperature !== null) args.push("--temp", String(temperature));
  if (topP !== null) args.push("--top-p", String(topP));
  if (topK !== null) args.push("--top-k", String(topK));
  if (recipeSampling) log(`${recipeLabel} sampling defaults: temp=${temperature}, top-p=${topP}, top-k=${topK}.`);
  if (tensorSplit && splitMode !== "none") args.push("--tensor-split", tensorSplit);
  const cacheReuse = value("llamacpp.cacheReuse");
  if (Number(cacheReuse || 0) > 0) args.push("--cache-reuse", String(Math.floor(Number(cacheReuse))));
  if (value("llamacpp.noMmap")) args.push("--no-mmap");
  if (value("llamacpp.noRepack")) args.push("--no-repack");
  // Catalog parameters that did not exist before P1 (01 §9.4): appended after
  // the legacy engine args, in catalog order, only when set.
  args.push(...emitCatalogArgs({ engineId: ENGINE_ID, ctx, values, existingArgs: args }));

  return applyExtra({
    host: "docker",
    docker: { flags, entrypoint: null, image: runtimeImage, args },
    publish: activePublishArgs,
    secretEnv,
    files: [],
    labels: labelsFromFlags(flags),
    metaPatch: {},
    logs,
    redactions: Object.values(secretEnv).map(String).filter(Boolean),
  }, ctx.extra);
}

// The server's normalizeDefaultTrueBoolean: on unless a value says off.
function defaultTrueBoolean(...values) {
  for (const value of values) {
    if (value === false || value === 0) return false;
    if (typeof value === "string" && /^(false|0|off|no)$/i.test(value.trim())) return false;
  }
  return true;
}

// llama-manager run options (launch-request runOptions, as runStartJobOnce
// passes them to the builder) -> catalog param ids (01 §9.3). Values are
// carried as given; the builder's own coercions run in buildLaunch, which is
// what keeps argv byte-identical.
const RUN_OPTION_PARAMS = Object.freeze([
  ["servedName", (opts) => opts.name],
  ["contextLength", (opts) => opts.maxModelLen],
  ["concurrency", (opts) => opts.maxNumSeqs],
  ["llamacpp.planningUtilization", (opts) => opts.gpuMemoryUtilization],
  ["llamacpp.gpuLayers", (opts) => opts.gpuLayers],
  ["llamacpp.fitTargetMb", (opts) => opts.fitTargetMb],
  ["llamacpp.fitCtx", (opts) => opts.fitCtx],
  ["llamacpp.batchSize", (opts) => opts.batchSize],
  ["llamacpp.ubatchSize", (opts) => opts.ubatchSize],
  ["llamacpp.cacheTypeK", (opts) => opts.cacheTypeK],
  ["llamacpp.cacheTypeV", (opts) => opts.cacheTypeV],
  ["llamacpp.flashAttention", (opts) => opts.flashAttention],
  ["llamacpp.cacheReuse", (opts) => opts.cacheReuse],
  ["llamacpp.splitMode", (opts) => opts.multiGpuMode],
  ["llamacpp.tensorSplit", (opts) => opts.tensorSplit],
  ["llamacpp.mainGpu", (opts) => opts.mainGpu],
  ["llamacpp.noMmap", (opts) => opts.noMmap],
  ["llamacpp.noRepack", (opts) => opts.noRepack],
  ["llamacpp.reasoning", (opts) => opts.reasoning],
  ["llamacpp.reasoningFormat", (opts) => opts.reasoningFormat],
  ["llamacpp.reasoningEffort", (opts) => opts.reasoningEffort],
  ["llamacpp.reasoningBudget", (opts) => opts.reasoningBudget],
  ["llamacpp.mmproj", (opts) => opts.mmproj],
  ["llamacpp.mmprojDevice", (opts) => opts.mmprojDevice],
  ["speculative.method", (opts) => opts.speculativeMode],
  ["speculative.numTokens", (opts) => opts.numSpeculativeTokens],
  ["speculative.draftModel", (opts) => opts.draftModel],
  ["temperature", (opts) => opts.temperature],
  ["topP", (opts) => opts.topP ?? opts.top_p],
  ["topK", (opts) => opts.topK ?? opts.top_k],
]);

/**
 * Legacy run options -> the plan buildLaunch reads. This is the llama.cpp
 * bridge for llama-manager's runtime-command wrapper until the launch-plan
 * resolver (ENG-7) produces plans itself. normalizeDefaultTrueBoolean is the
 * manager's own text-only normaliser; recipe is the recipe the caller applied.
 */
function planFromRunOptions(opts = {}, { jobId, recipe = null, normalizeDefaultTrueBoolean = defaultTrueBoolean } = {}) {
  const values = {};
  for (const [id, read] of RUN_OPTION_PARAMS) {
    const item = read(opts);
    if (item !== undefined) values[id] = item;
  }
  values["llamacpp.textOnly"] = normalizeDefaultTrueBoolean(opts.textOnlyMode, opts.languageModelOnly);
  // Catalog parameters with no legacy run option (01 §9.4): what a v2 launch
  // request set, carried by the resolver in runOptions.catalogValues.
  if (isPlainObject(opts.catalogValues)) {
    for (const [id, item] of Object.entries(opts.catalogValues)) {
      if (values[id] === undefined || values[id] === null || values[id] === "") values[id] = item;
    }
  }
  return {
    engineId: ENGINE_ID,
    values,
    instance: {
      mode: opts.instanceMode,
      id: opts.instanceId,
      port: opts.port,
      networkAccess: opts.networkAccess,
      serviceHost: opts.serviceHost,
      gpuIds: opts.gpuDeviceIds,
      containerName: opts.containerName,
    },
    secrets: { apiKey: opts.llamaApiKey, apiKeyRef: opts.runtimeApiKeyRef },
    launch: {
      jobId,
      gpuAdmissionLeaseId: opts.gpuAdmissionLeaseId,
      vramReservationMb: opts.vramReservationMb,
      gpuPlan: opts.gpuPlan,
    },
    recipe,
  };
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
  clampSpeculativeTokens,
  formatDockerPublishArgs,
  normalizeLlamaSpeculativeMode,
  optionalSamplingNumber,
  planFromRunOptions,
};
