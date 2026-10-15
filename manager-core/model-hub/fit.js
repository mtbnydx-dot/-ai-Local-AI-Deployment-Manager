"use strict";

// Fit and compatibility for the hub (03 §10). The hub contains no estimator:
// 02's core.models (estimateFit, evaluateCompatibility, inspectRemote) does
// the work and this file adapts it. labelOf() is the only mapping from 02's
// status to the hub labels.
//
//   createFitService({ models, getGpus, getCompatibilityContext })
//     → { hasModels, labelOf(fitResult), fitFor(input), compatibilityFor(card), gpus(ids),
//         inspect(request), engineFor(format) }
//
// `models` is core.models, injected by the entry; null before 02 lands or in
// a hub built without it. The credentials rule of §10: `source` is the
// namespace, the provider's own fetchImpl and apiBase are handed to
// inspectRemote, and the hub never passes a token (the provider's fetch
// attaches one for huggingface.co hosts only and strips it on redirects).
//
// Fallback (kept until the follow-up that deletes it, see 03 §10): while
// `models` is null, fitFor() grades the artifact's bytes with
// gguf-variants.js#fitFor. exceeds is wont-fit, everything else fits; it
// never yields tight or spills, and reports policy "bytes-heuristic",
// confidence "name-heuristic", basis "bytes".

const { fitFor: bytesFitFor } = require("../gguf-variants");

const FIT_LABELS = Object.freeze(["unknown", "fits", "tight", "spills", "wont-fit"]);
const DEFAULT_CONTEXT_TOKENS = 32768;
// Q4 class GGUF, used for the search hint where only the parameter count is known.
const GGUF_Q4_BYTES_PER_PARAM = 0.5625;

const LABEL_COPY = Object.freeze({
  unknown: Object.freeze({ zh: "未知", en: "Unknown" }),
  fits: Object.freeze({ zh: "可放下", en: "Fits" }),
  tight: Object.freeze({ zh: "偏紧", en: "Tight" }),
  spills: Object.freeze({ zh: "需卸载到内存", en: "Spills to RAM" }),
  "wont-fit": Object.freeze({ zh: "放不下", en: "Won't fit" }),
});

// 03 §13.3 / 02 §9: the engines each format is a hint for (labelled
// basis "format"); 02's knowledge refines this once a card exists.
const ENGINES_BY_FORMAT = Object.freeze({
  gguf: Object.freeze(["llamacpp"]),
  safetensors: Object.freeze(["vllm", "sglang"]),
  pytorch: Object.freeze(["vllm", "sglang"]),
  fp8: Object.freeze(["vllm", "sglang"]),
  nvfp4: Object.freeze(["vllm", "sglang"]),
  mxfp4: Object.freeze(["vllm", "sglang"]),
  awq: Object.freeze(["vllm", "sglang"]),
  gptq: Object.freeze(["vllm", "sglang"]),
  // bitsandbytes loads through vLLM only (precision-variants.js#engineSupport).
  bnb: Object.freeze(["vllm"]),
});
const GPU_CACHE_MS = 5000;
const COMPAT_ENGINES = Object.freeze(["vllm", "sglang", "llamacpp"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function bilingual(zh, en) {
  return { zh, en };
}

/** The engine ids a format is a hint for, in display order. */
function enginesForFormat(format) {
  return [...(ENGINES_BY_FORMAT[String(format || "").toLowerCase()] || [])];
}

/** The engine a fit for this format is computed for when the caller names none. */
function defaultEngineFor(format) {
  return String(format || "").toLowerCase() === "gguf" ? "llamacpp" : "vllm";
}

function pickFunction(models, ...paths) {
  if (!models) return null;
  for (const dotted of paths) {
    let current = models;
    for (const segment of dotted.split(".")) current = current && current[segment];
    if (typeof current === "function") return current;
  }
  return null;
}

/**
 * The hub label of a 02 FitResult (03 §10 table). `spill` is 02's flag; a
 * missing result, or one without a status, is unknown.
 */
function labelOf(fitResult) {
  if (!isPlainObject(fitResult)) return "unknown";
  if (fitResult.status === "ok") return "fits";
  if (fitResult.status === "warn") return fitResult.spill === true ? "spills" : "tight";
  if (fitResult.status === "fail") return "wont-fit";
  return "unknown";
}

function unknownFit(basis, reason) {
  return {
    label: "unknown",
    status: "unknown",
    spill: false,
    neededMb: null,
    perGpuMb: {},
    range: null,
    policy: null,
    confidence: null,
    headroomMb: null,
    overflowMb: null,
    suggestions: [],
    basis,
    ...(reason ? { reason } : {}),
  };
}

function maxOf(map) {
  const values = Object.values(isPlainObject(map) ? map : {}).map(Number).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/** 02's FitResult → the hub `fit` object (03 §10). */
function toHubFit(result, basis) {
  const needed = positive(result.admissionRequestMb) ?? positive(result.range?.highMb) ?? positive(maxOf(result.perGpuMb));
  return {
    label: labelOf(result),
    status: result.status,
    spill: result.spill === true,
    neededMb: needed === null ? null : Math.round(needed),
    perGpuMb: isPlainObject(result.perGpuMb) ? { ...result.perGpuMb } : {},
    range: isPlainObject(result.range) ? { ...result.range } : null,
    policy: result.policy ?? null,
    confidence: result.confidence ?? null,
    headroomMb: Number.isFinite(Number(result.headroomMb)) ? Number(result.headroomMb) : null,
    overflowMb: Number.isFinite(Number(result.overflowMb)) ? Number(result.overflowMb) : null,
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    basis,
  };
}

/** Rows for a card nobody could evaluate: every known engine, unknown, with the reason. */
function unavailableRows(code = "inspector_unavailable") {
  return COMPAT_ENGINES.map((engineId) => ({
    engineId,
    runtimeId: null,
    verdict: "unknown",
    supportEvidence: [],
    reasons: [{
      code,
      level: "unknown",
      message: bilingual("模型检查器不可用，无法判断兼容性。", "The model inspector is unavailable, so compatibility is unknown."),
    }],
    actions: [],
  }));
}

function normalizeGpus(gpus, gpuIds) {
  const wanted = Array.isArray(gpuIds) && gpuIds.length ? new Set(gpuIds.map(String)) : null;
  return (Array.isArray(gpus) ? gpus : [])
    .filter((gpu) => isPlainObject(gpu) && positive(gpu.totalMb) && (!wanted || wanted.has(String(gpu.id))))
    .map((gpu) => {
      const totalMb = Number(gpu.totalMb);
      const freeMb = Number.isFinite(Number(gpu.freeMb)) ? Math.min(totalMb, Math.max(0, Number(gpu.freeMb))) : totalMb;
      return {
        id: String(gpu.id),
        name: String(gpu.name || `GPU ${gpu.id}`),
        totalMb,
        freeMb,
        usedMb: totalMb - freeMb,
        ...(gpu.computeCap ? { computeCap: String(gpu.computeCap) } : {}),
      };
    });
}

function createFitService(options = {}) {
  const models = options.models || null;
  const getGpus = typeof options.getGpus === "function" ? options.getGpus : null;
  const getCompatibilityContext = typeof options.getCompatibilityContext === "function" ? options.getCompatibilityContext : null;
  const logger = options.logger || null;
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const estimateFit = pickFunction(models, "estimateFit", "fit.estimateFit");
  const evaluateCompatibility = pickFunction(models, "evaluateCompatibility", "compatibility.evaluateCompatibility");
  const inspectRemote = pickFunction(models, "inspectRemote");
  const hasModels = Boolean(estimateFit);

  function debug(line) {
    try {
      logger?.debug?.(line);
    } catch {
      // Logging never breaks a fit.
    }
  }

  // The GPU list is read at most once per GPU_CACHE_MS, so a search page of
  // fit hints costs one probe, not one per item.
  let gpuCache = null;
  async function allGpus() {
    if (!getGpus) return [];
    const at = clock.now();
    if (gpuCache && at - gpuCache.at < GPU_CACHE_MS) return gpuCache.gpus;
    let gpus = [];
    try {
      gpus = await getGpus();
    } catch (error) {
      debug(`hub fit: the GPU list could not be read: ${error?.code || error?.message || error}`);
    }
    gpuCache = { at, gpus: Array.isArray(gpus) ? gpus : [] };
    return gpuCache.gpus;
  }

  async function readGpus(gpuIds) {
    return normalizeGpus(await allGpus(), gpuIds);
  }

  // The bytes-only fallback (see the header).
  function fallbackFit(bytes, gpus) {
    const totalMb = gpus.reduce((sum, gpu) => sum + gpu.totalMb, 0);
    const graded = bytesFitFor(Number(bytes) || 0, { gpuTotalMb: totalMb });
    const label = graded.status === "exceeds" ? "wont-fit" : graded.status === "unknown" ? "unknown" : "fits";
    const fit = unknownFit("bytes", label === "unknown" ? "gpu_unavailable" : "");
    return {
      ...fit,
      label,
      status: label === "wont-fit" ? "fail" : label === "fits" ? "ok" : "unknown",
      neededMb: Number.isFinite(graded.ratio) && totalMb > 0 ? Math.round(graded.ratio * totalMb) : null,
      policy: "bytes-heuristic",
      confidence: "name-heuristic",
    };
  }

  /**
   * fitFor({ card, legacy, bytes, format, engineId, contextTokens, gpuIds,
   * suggestions }) → the hub fit object (03 §10): { label, status, spill,
   * neededMb, perGpuMb, range, policy, confidence, headroomMb, overflowMb,
   * suggestions, basis }. A card gives basis "card", `legacy` ({ paramsB,
   * bytesPerParam }) gives "params", and the bytes fallback gives "bytes". No
   * input at all, or no GPU facts, gives label "unknown" (with `reason`).
   */
  async function fitFor(input = {}) {
    const card = isPlainObject(input.card) ? input.card : null;
    const legacy = isPlainObject(input.legacy) && positive(input.legacy.paramsB) ? input.legacy : null;
    const gpus = await readGpus(input.gpuIds);
    if (!hasModels) return fallbackFit(input.bytes, gpus);
    if (!card && !legacy) return unknownFit("params", "no_model_facts");
    const basis = card ? "card" : "params";
    if (!gpus.length) return unknownFit(basis, "gpu_unavailable");
    const engineId = String(input.engineId || defaultEngineFor(input.format));
    const contextTokens = positive(input.contextTokens) || DEFAULT_CONTEXT_TOKENS;
    try {
      const result = estimateFit({
        card,
        legacy: card ? null : legacy,
        engineId,
        gpuIds: gpus.map((gpu) => gpu.id),
        values: { contextLength: Math.floor(contextTokens), concurrency: 1 },
        host: { gpus },
        budgetBasis: "empty-gpu",
      }, { suggestions: input.suggestions !== false });
      return toHubFit(result, basis);
    } catch (error) {
      debug(`hub fit: estimateFit failed: ${error?.code || error?.message || error}`);
      return unknownFit(basis, String(error?.code || "estimate_failed"));
    }
  }

  /**
   * Compatibility rows for a card in 02's shape (03 §10). Without models, a
   * card or a working evaluator every engine is unknown with the reason
   * inspector_unavailable.
   */
  async function compatibilityFor(card) {
    if (!evaluateCompatibility || !isPlainObject(card)) return unavailableRows();
    let context = {};
    if (getCompatibilityContext) {
      try {
        context = (await getCompatibilityContext()) || {};
      } catch (error) {
        debug(`hub fit: the compatibility context failed: ${error?.code || error?.message || error}`);
        context = {};
      }
    }
    try {
      const rows = await evaluateCompatibility(card, context);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      debug(`hub fit: evaluateCompatibility failed: ${error?.code || error?.message || error}`);
      return unavailableRows();
    }
  }

  /**
   * One remote inspection (03 §10): { provider, namespace, repo, revision,
   * revisionSha, files, signal } → ModelCard, or null when there is no
   * inspector or it failed (the caller then keeps the params basis). The
   * request carries the namespace as `source`, the provider's own fetchImpl
   * and apiBase, and never a token.
   */
  async function inspect(request = {}) {
    if (!inspectRemote) return null;
    const provider = request.provider || {};
    const namespace = request.namespace === "modelscope" ? "modelscope" : "huggingface";
    try {
      const options = { signal: request.signal };
      if (typeof provider.fetchImpl === "function") options.fetchImpl = provider.fetchImpl;
      if (provider.apiBase) options.endpoint = provider.apiBase;
      return await inspectRemote({
        source: namespace,
        repo: request.repo,
        revision: request.revisionSha || request.revision || "main",
        files: Array.isArray(request.files) ? request.files : [],
      }, options);
    } catch (error) {
      debug(`hub fit: inspectRemote ${request.repo} failed: ${error?.code || error?.message || error}`);
      return null;
    }
  }

  return { hasModels, labelOf, fitFor, compatibilityFor, inspect, gpus: readGpus, engineFor: defaultEngineFor };
}

module.exports = {
  DEFAULT_CONTEXT_TOKENS,
  ENGINES_BY_FORMAT,
  FIT_LABELS,
  GGUF_Q4_BYTES_PER_PARAM,
  LABEL_COPY,
  createFitService,
  defaultEngineFor,
  enginesForFormat,
  labelOf,
  normalizeGpus,
  toHubFit,
  unavailableRows,
  unknownFit,
};
