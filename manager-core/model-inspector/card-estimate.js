"use strict";

// /api/memory-estimate card mode (docs/overhaul/02-models.md §10.7, MOD-9b).
//
// A body with a model card (cardId, or model together with one of the new
// optional fields engineId / runtimeId / gpuIds / values) is answered from
// estimateFit. The response keeps every key the legacy response has (the
// manager wrapper computes that legacy response from card-derived facts and
// this module overlays the card numbers onto its plan) and adds `fit`
// (FitResult) and `card` ({cardId, confidence}). A body without those fields,
// including today's UIs that send `model` and a variant object, stays on the
// legacy path byte for byte.

const fit = require("./fit");
const planFacts = require("./plan-facts");

const GIB = 1024 * 1024 * 1024;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** True when the body asks for card mode (a bare legacy `model` / `variant` does not). */
function cardModeRequested(body) {
  if (!isPlainObject(body)) return false;
  if (typeof body.cardId === "string" && body.cardId.trim()) return true;
  if (!(typeof body.model === "string" && body.model.trim())) return false;
  return ["engineId", "runtimeId", "gpuIds", "values"].some((field) => body[field] !== undefined && body[field] !== null);
}

function engineFor(body, managerFamily) {
  if (typeof body.engineId === "string" && body.engineId.trim()) return body.engineId.trim();
  if (managerFamily === "llama") return "llamacpp";
  return String(body.engine || "").toLowerCase() === "sglang" ? "sglang" : "vllm";
}

function splitWeights(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,\s:;]+/);
  return raw.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
}

function pick(...candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== "") return candidate;
  }
  return undefined;
}

/**
 * The catalog values (01 ids) of a legacy-named body. Fields the body does not
 * carry are left out so the catalog default applies; body.values (catalog ids)
 * wins over the mapped legacy fields.
 */
function bodyToValues(body, engineId) {
  const llama = engineId === "llamacpp";
  const values = {};
  const set = (id, value) => {
    if (value !== undefined) values[id] = value;
  };
  set("contextLength", pick(body.contextTokens, body.maxModelLen));
  set("concurrency", pick(body.maxNumSeqs, body.parallelSlots));
  const utilization = pick(body.gpuMemoryUtilization, body.utilization);
  set("tensorParallel", pick(body.tensorParallelSize, body.tpSize));
  set("pipelineParallel", pick(body.pipelineParallelSize, body.ppSize));
  const speculative = pick(body.speculativeMode);
  set("speculative.method", speculative === undefined ? undefined : String(speculative).toLowerCase());
  set("speculative.numTokens", pick(body.numSpeculativeTokens));
  if (llama) {
    const kv = pick(body.cacheTypeK, body.kvCacheDtype);
    set("llamacpp.cacheTypeK", kv);
    set("llamacpp.cacheTypeV", pick(body.cacheTypeV, body.kvCacheDtype));
    set("llamacpp.gpuLayers", pick(body.gpuLayers, body.nGpuLayers));
    const split = splitWeights(pick(body.tensorSplitWeights, body.tensorSplit));
    if (split.length) values["llamacpp.tensorSplit"] = split;
    if (body.textOnlyMode !== undefined) values["llamacpp.textOnly"] = body.textOnlyMode !== false;
    const mmproj = pick(body.mmproj?.path, typeof body.mmproj === "string" ? body.mmproj : undefined);
    if (mmproj) values["llamacpp.mmproj"] = mmproj;
    const draft = pick(body.dflash?.path, body.draft?.path);
    if (draft) values["speculative.draftModel"] = draft;
  } else {
    set("kvCacheDtype", pick(body.kvCacheDtype));
    const prefix = engineId === "sglang" ? "sglang" : "vllm";
    if (utilization !== undefined) values[prefix === "sglang" ? "sglang.memFractionStatic" : "vllm.gpuMemoryUtilization"] = utilization;
    if (prefix === "vllm") {
      set("vllm.cpuOffloadGb", pick(body.cpuOffloadGb));
      set("vllm.kvOffloadingSize", pick(body.kvOffloadGb, body.kvOffloadingSize));
      if (body.languageModelOnly !== undefined) values["vllm.languageModelOnly"] = Boolean(body.languageModelOnly);
    } else {
      set("sglang.maxTotalTokens", pick(body.sglangMaxTotalTokens));
    }
  }
  if (isPlainObject(body.values)) Object.assign(values, body.values);
  return values;
}

async function cardFor(body, options) {
  const card = await planFacts.resolveCard(
    { card: isPlainObject(body.card) ? body.card : undefined, cardId: body.cardId, ref: body.model },
    options,
  );
  if (card) return card;
  const repo = typeof body.model === "string" ? body.model.trim() : "";
  if (options.inspectRemote !== false && REPO_PATTERN.test(repo) && !/^[A-Za-z]:/.test(repo)) {
    try {
      const inspect = require("./inspect");
      const remote = typeof options.inspectRemote === "function" ? options.inspectRemote : inspect.inspectRemote;
      return await remote({ source: "hf", repo, revision: "main" }, { fetchImpl: options.fetchImpl });
    } catch {
      return null;
    }
  }
  return null;
}

/** Facts for the legacy builders, derived from the card so every legacy key is computed. */
function legacyFactsFromCard(card, values) {
  const topology = card.topology || {};
  const histogram = topology.attention?.histogram || {};
  const layers = number(topology.layers, 0);
  const kvLayers = Object.entries(histogram)
    .filter(([kind]) => !["linear", "none"].includes(kind))
    .reduce((sum, [, n]) => sum + number(n, 0), 0) || layers;
  const totalBytes = number(card.weights?.totalBytes, 0);
  const full = topology.attention?.kinds?.full || topology.attention?.kinds?.swa || null;
  return {
    paramsB: totalBytes / 1e9,
    bytesPerParam: 1,
    arch: layers && number(topology.kvHeads, 0) && number(topology.headDim, 0) ? {
      layers,
      kvLayers,
      kvHeads: number(full?.kvHeads, number(topology.kvHeads, 0)),
      headDim: number(full?.kDim, number(topology.headDim, 0)),
      label: "model card",
      source: "card",
    } : null,
    contextLength: number(values.contextLength, 0),
  };
}

function overlayPlan(plan, result, { card, engineId, values, legacyPlan }) {
  const llama = engineId === "llamacpp";
  const artifact = result.artifact;
  const sum = (map) => Object.values(map || {}).reduce((total, mb) => total + number(mb, 0), 0);
  const weightsGb = sum(artifact.weightsMbByGpu) / 1024;
  const peakMb = Math.max(0, ...Object.values(result.perGpuMb || {}).map((mb) => number(mb, 0)));
  const breakdown = result.breakdown || {};
  const overheadPerGpuGb = (number(breakdown.activations) + number(breakdown.draft) + number(breakdown.mmproj) + number(breakdown.overhead)) / 1024;
  const overflowPerGpuGb = number(result.overflowMb, 0) / 1024;
  const out = {
    ...plan,
    weightsGb,
    kvGb: number(artifact.kvMb?.low, 0) / 1024,
    kvGbHigh: number(artifact.kvMb?.high, 0) / 1024,
    overheadPerGpuGb,
    perGpuGb: peakMb / 1024,
    peakGpuGb: peakMb / 1024,
    overflowPerGpuGb,
    status: result.status,
    estimatePolicy: result.admissionRequest?.estimatePolicy ?? plan.estimatePolicy,
    policy: result.policy,
  };
  if (llama) {
    out.totalWeightsGb = number(card.weights?.totalBytes, 0) / GIB;
    out.gpuWeightsGb = weightsGb;
    out.cpuWeightsGb = number(result.ram?.weights, 0) / 1024 + number(result.ram?.experts, 0) / 1024;
    out.totalKvGb = out.kvGb;
    out.totalKvHighGb = out.kvGbHigh;
    out.gpuKvGb = out.kvGb;
    out.gpuKvHighGb = out.kvGbHigh;
    out.cpuKvGb = number(result.ram?.kv, 0) / 1024;
    // The allocations follow the card-based per-GPU figures the status was graded on.
    if (Array.isArray(plan.allocations)) {
      out.allocations = plan.allocations.map((item) => {
        const mb = result.perGpuMb?.[String(item?.gpu?.id)];
        if (!Number.isFinite(Number(mb))) return item;
        const allocatedGb = Number(mb) / 1024;
        return { ...item, allocatedGb, overflowGb: Math.max(0, allocatedGb - number(item.usableGb, 0)) };
      });
    }
  } else {
    const cpuOffload = number(values["vllm.cpuOffloadGb"], 0);
    const kvOffload = number(values["vllm.kvOffloadingSize"], 0);
    const weightPerGpu = number(legacyPlan?.weightPerGpuBeforeOffloadGb, weightsGb);
    out.recommendedCpuOffloadGb = overflowPerGpuGb > 0 ? Math.min(weightPerGpu, cpuOffload + overflowPerGpuGb + 2) : cpuOffload;
    out.recommendedKvOffloadGb = kvOffload;
  }
  return out;
}

/**
 * buildCardEstimate(body, ctx) → Promise<response>.
 * ctx: { managerFamily: "vllm"|"llama", hostGpus (the wrapper's normalized selected
 * GPUs), legacy(body) → the manager's legacy response for a body, admissionPolicy?,
 * resolveModelPath?, inspectLocal?, inspectRemote?, fetchImpl?, calibrationFor?,
 * fitOptions? }.
 * Throws {code: "model_not_found"} when no card can be built for the body.
 */
async function buildCardEstimate(body, ctx = {}) {
  const engineId = engineFor(body, ctx.managerFamily);
  const card = await cardFor(body, ctx);
  if (!card) {
    const error = new Error("No model card could be built for this request (model not found).");
    error.code = "model_not_found";
    error.status = 404;
    throw error;
  }
  const values = bodyToValues(body, engineId);
  const hostGpus = (Array.isArray(ctx.hostGpus) ? ctx.hostGpus : []).map((gpu) => ({
    id: String(gpu.id),
    name: gpu.name,
    totalMb: number(gpu.totalMb, 0),
    usedMb: number(gpu.usedMb, 0),
    freeMb: number(gpu.freeMb, 0),
    ...(gpu.computeCap ? { computeCap: gpu.computeCap } : {}),
  }));
  const gpuIds = Array.isArray(body.gpuIds) && body.gpuIds.length ? body.gpuIds.map(String) : hostGpus.map((gpu) => gpu.id);
  const fitInput = {
    card,
    engineId,
    runtimeId: typeof body.runtimeId === "string" ? body.runtimeId : null,
    gpuIds,
    values,
    host: { gpus: hostGpus, platform: body.platform },
    budgetBasis: body.budgetBasis === "now" ? "now" : "empty-gpu",
    instanceMode: ["replace", "parallel", "add"].includes(body.instanceMode) ? body.instanceMode : "parallel",
  };
  const fitOptions = { ...(isPlainObject(ctx.fitOptions) ? ctx.fitOptions : {}) };
  if (typeof ctx.calibrationFor === "function") fitOptions.calibrationFor = ctx.calibrationFor;
  if (isPlainObject(ctx.admissionPolicy)) fitOptions.admissionPolicy = ctx.admissionPolicy;
  const result = fit.estimateFit(fitInput, fitOptions);

  // Every legacy key: the manager's own legacy response for a body whose model
  // facts come from the card, then the card numbers laid over its plan.
  const facts = legacyFactsFromCard(card, values);
  const legacyBody = { ...body };
  delete legacyBody.model;
  delete legacyBody.cardId;
  if (!isPlainObject(legacyBody.variant)) delete legacyBody.variant;
  legacyBody.paramsB = facts.paramsB;
  legacyBody.bytesPerParam = facts.bytesPerParam;
  if (facts.arch) {
    legacyBody.arch = facts.arch;
    delete legacyBody.modelConfig;
    delete legacyBody.config;
  }
  if (facts.contextLength) legacyBody.contextTokens = body.contextTokens ?? body.maxModelLen ?? facts.contextLength;
  const legacy = JSON.parse(JSON.stringify(typeof ctx.legacy === "function" ? await ctx.legacy(legacyBody) : { ok: true, plan: {}, recommendations: {} }));

  const plan = overlayPlan(legacy.plan || {}, result, { card, engineId, values: result.values, legacyPlan: legacy.plan });
  const fitSuggestions = (result.suggestions || []).map((item) => item?.message?.zh).filter(Boolean);
  const recommendations = {
    ...(legacy.recommendations || {}),
    status: result.status,
    summary: result.status === "ok" ? "预计可运行" : result.status === "warn" ? "预计接近显存上限" : "预计会显存不足",
    suggestions: [...fitSuggestions, ...(Array.isArray(legacy.recommendations?.suggestions) ? legacy.recommendations.suggestions : [])],
    overflowPerGpuGb: plan.overflowPerGpuGb,
    ...(engineId === "llamacpp" ? { peakGpuGb: plan.peakGpuGb } : {
      cpuOffloadGb: plan.recommendedCpuOffloadGb,
      kvOffloadingSize: plan.recommendedKvOffloadGb,
    }),
  };
  return {
    ...legacy,
    ok: true,
    plan,
    recommendations,
    fit: result,
    card: { cardId: card.cardId ?? null, confidence: result.confidence },
  };
}

module.exports = {
  bodyToValues,
  buildCardEstimate,
  cardModeRequested,
};
