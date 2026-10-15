"use strict";

// Memory fit (docs/overhaul/02-models.md §10, 00 §9.1): the artifact side of
// memory planning. 02 derives the bytes a model brings (weights by class and
// where the offload values put them, KV bytes per token and per layer kind,
// recurrent state per sequence, draft and projector bytes); 01's
// engines/memory-models.js owns how an engine reserves memory and what it asks
// gpu-admission for. estimateFit = artifactMemoryInputs -> memoryModels.estimate
// -> grading, so a fit and a launch plan for the same card and values report
// the same perGpuMb, policy and admission request.
//
//   artifactMemoryInputs(FitInput-like, options) -> MemoryInputs.artifact
//   kvBytes(card, values, { engineId })          -> KV bytes per layer kind
//   estimateFit(FitInput, options)               -> FitResult
//   legacyEstimate(input, { engineId })          -> the legacy /api/memory-estimate plan
//
// The admission fields 08 C1 made must-keep (requestedFractionOfFree,
// poolCappedTokens, minClampMb, clamped, verdict) are never renamed or
// recomputed here: they only appear inside admissionRequest exactly as 01
// returns it. The engine formulas (activations, graphs, pools, compute
// buffers) are 01's MEMORY_CONSTANTS; FIT_CONSTANTS hold artifact-side numbers
// only and carry no model-family knowledge (D5).

const memoryEstimator = require("../memory-estimator");
const { DEFAULT_RESERVE_MB, DEFAULT_MAX_UTILIZATION_PCT } = require("../gpu-admission");
const { validate } = require("./json-schema-lite");

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const ARTIFACT_SCHEMA_ID = "artifact-memory-inputs/v1";

// 00 §4.3 LaunchPlan.memory.policy as amended by 00 §9.1.
const MEMORY_POLICIES = Object.freeze([
  "device-fraction",
  "free-fraction-after-weights",
  "gguf-estimate",
  "measured",
  "server-reported",
  "static-fraction-of-free",
  "weights-plus-kv",
]);

// 08's name before 00 §9.1 renamed it.
const POLICY_ALIASES = Object.freeze({ "free-fraction": "static-fraction-of-free" });

const FIT_CONFIDENCES = Object.freeze(["exact", "config", "heuristic", "measured"]);
const FIT_STATUSES = Object.freeze(["ok", "warn", "fail"]);
const BUDGET_BASES = Object.freeze(["empty-gpu", "now"]);
const INSTANCE_MODES = Object.freeze(["replace", "parallel", "add"]);

const WEIGHT_CLASSES = Object.freeze(["dense", "experts", "embedding", "lmHead", "vision", "audio", "mtp", "ple", "other"]);

// speculative.method values that load the checkpoint's own MTP / next-n layers,
// and those that load a separate draft model (01 catalogs).
const MTP_METHODS = Object.freeze(["mtp", "nextn", "qwen3_next_mtp", "draft-mtp"]);
const DRAFT_METHODS = Object.freeze(["draft_model", "dspark", "eagle", "eagle3", "standalone", "draft-dflash", "draft-simple"]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// Artifact-side constants (02 §10.5). Overridable from platform.json
// models.fitConstants through resolveFitConstants / fitConstantsFromConfig.
const FIT_CONSTANTS = deepFreeze({
  // Bytes per cache element by dtype (02 §10.3); GGUF block types carry their scale bytes.
  dtypeBytes: {
    f32: 4, float32: 4, f16: 2, float16: 2, half: 2, bf16: 2, bfloat16: 2,
    fp8: 1, fp8_e4m3: 1, fp8_e5m2: 1, fp8_e4m3fn: 1,
    q8_0: 34 / 32, q5_1: 24 / 32, q5_0: 22 / 32, q4_1: 20 / 32, q4_0: 18 / 32, iq4_nl: 18 / 32,
    nvfp4: 9 / 16,
  },
  // kvCacheDtype "auto" on vLLM/SGLang: the model's compute dtype (bf16/f16).
  modelDtypeBytes: 2,
  // Recurrent state: conv state in the compute dtype, SSM state in float32 unless declared.
  convStateBytes: 2,
  ssmStateBytes: 4,
  // llama.cpp pads its KV cell count; the SWA pool also keeps one ubatch of cells.
  llamaCellPadding: 256,
  defaultUbatch: 512,
  // A synthetic idle GPU for budgetBasis "empty-gpu".
  idleUsedMb: 600,
  ramReserveGb: 16,
  // Grading thresholds (02 §10.5, §10.6).
  warnBudgetRatio: 0.9,
  driftLow: 0.9,
  driftHigh: 1.15,
  driftSamples: 5,
  weightsMismatchRatio: 0.05,
  maxSuggestions: 4,
  minSuggestedContext: 4096,
});

// The one piece of engine knowledge on the artifact side (02 §10.3): how an
// engine lays out KV cells. llama.cpp keeps one pool of contextLength x
// concurrency cells (padded) plus a ubatch of cells for sliding-window layers;
// vLLM and SGLang page per sequence. Keyed by engineId, never by family.
const KV_LAYOUTS = deepFreeze({
  llamacpp: { pooled: true, perTokenBasis: "slot-context" },
  default: { pooled: false, perTokenBasis: "token" },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function count(value) {
  return Math.max(0, Math.floor(positive(value)));
}

function bilingual(zh, en) {
  return { zh, en };
}

function finding(code, zh, en, extra = {}) {
  return { code, message: bilingual(zh, en), ...extra };
}

function mbCeil(bytes) {
  return Math.ceil(Math.max(0, Number(bytes) || 0) / MIB);
}

function maxOf(map) {
  const numbers = Object.values(isPlainObject(map) ? map : {}).map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : 0;
}

function median(numbers) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Plan values as plain values: { id: value } from { id: value | { value, source } }. */
function plainValues(values) {
  const out = {};
  for (const [id, entry] of Object.entries(isPlainObject(values) ? values : {})) {
    out[id] = isPlainObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry;
  }
  return out;
}

function isLlama(engineId) {
  return engineId === "llamacpp" || engineId === "llama";
}

function layoutFor(engineId) {
  return isLlama(engineId) ? KV_LAYOUTS.llamacpp : KV_LAYOUTS.default;
}

/**
 * FIT_CONSTANTS with overrides (platform.json models.fitConstants). Unknown
 * keys and non-numeric values are ignored; dtypeBytes merges per dtype.
 */
function resolveFitConstants(overrides = null) {
  if (!isPlainObject(overrides)) return FIT_CONSTANTS;
  const out = { ...FIT_CONSTANTS, dtypeBytes: { ...FIT_CONSTANTS.dtypeBytes } };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "dtypeBytes" && isPlainObject(value)) {
      for (const [dtype, bytes] of Object.entries(value)) {
        if (positive(bytes)) out.dtypeBytes[String(dtype).toLowerCase()] = Number(bytes);
      }
    } else if (Object.hasOwn(FIT_CONSTANTS, key) && key !== "dtypeBytes" && Number.isFinite(Number(value)) && Number(value) >= 0) {
      out[key] = Number(value);
    }
  }
  return deepFreeze(out);
}

/**
 * FIT_CONSTANTS from the platform config: readSection is 06 OPS-3's
 * readSection (or a stub); a missing section or a read error keeps the defaults.
 */
function fitConstantsFromConfig(readSection, options = {}) {
  if (typeof readSection !== "function") return FIT_CONSTANTS;
  try {
    const section = readSection("models", options);
    return resolveFitConstants(section?.values?.fitConstants ?? section?.value?.fitConstants ?? null);
  } catch {
    return FIT_CONSTANTS;
  }
}

// ---------------------------------------------------------------------------
// Values (01 catalog ids only)
// ---------------------------------------------------------------------------

function loadCatalogFor(engineId, options) {
  if (options.catalog === null) return null;
  if (isPlainObject(options.catalog) && options.catalog.byId) return options.catalog;
  if (isPlainObject(options.catalogs) && options.catalogs[engineId]) return options.catalogs[engineId];
  try {
    return require("../engines/param-catalog").loadCatalog(engineId);
  } catch {
    return null;
  }
}

/**
 * FitInput values -> plain catalog values for engineId. Ids absent from the
 * engine's catalog are dropped with one assumption naming them; absent ids
 * take the catalog default (platformDefault, else engineDefault).
 */
function normalizeFitValues(engineId, rawValues, { catalog = null, instanceMode = "parallel", assumptions = [] } = {}) {
  const given = plainValues(rawValues);
  if (!catalog?.byId) {
    if (Object.keys(given).length) {
      assumptions.push(bilingual(
        `没有找到引擎 ${engineId || "（未指定）"} 的参数目录，按原样使用传入的参数。`,
        `No parameter catalog was found for engine ${engineId || "(none)"}; the values are used as given.`));
    }
    return given;
  }
  const values = {};
  const ignored = [];
  for (const [id, value] of Object.entries(given)) {
    if (catalog.byId.has(id)) values[id] = value;
    else ignored.push(id);
  }
  if (ignored.length) {
    assumptions.push(bilingual(
      `以下参数不属于 ${engineId} 的参数目录，已忽略：${ignored.join("、")}。`,
      `These ids are not in the ${engineId} parameter catalog and were ignored: ${ignored.join(", ")}.`));
  }
  let paramCatalog = null;
  try {
    paramCatalog = require("../engines/param-catalog");
  } catch {
    paramCatalog = null;
  }
  const facts = paramCatalog ? paramCatalog.buildFacts({ instanceMode }) : {};
  for (const param of Array.isArray(catalog.params) ? catalog.params : []) {
    if (!param?.id || Object.hasOwn(values, param.id)) continue;
    let value = null;
    try {
      value = paramCatalog
        ? paramCatalog.platformDefaultValue(param, catalog, { facts, param: (id) => values[id] ?? null })
        : param.platformDefault ?? null;
    } catch {
      value = null;
    }
    if (isPlainObject(value)) value = null;
    if (value === null || value === undefined) value = param.engineDefault ?? null;
    if (value !== null && value !== undefined) values[param.id] = value;
  }
  return values;
}

// ---------------------------------------------------------------------------
// KV bytes per attention kind (02 §10.3)
// ---------------------------------------------------------------------------

function dtypeBytesFor(name, constants, fallback) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return fallback;
  if (positive(constants.dtypeBytes[key])) return constants.dtypeBytes[key];
  if (/fp8|f8_e/.test(key)) return 1;
  if (/f32|float32/.test(key)) return 4;
  return fallback;
}

/** Bytes per K and V element for the chosen cache dtype. */
function cacheElementBytes(card, values, engineId, constants) {
  if (isLlama(engineId)) {
    return {
      bk: dtypeBytesFor(values["llamacpp.cacheTypeK"] || "f16", constants, 2),
      bv: dtypeBytesFor(values["llamacpp.cacheTypeV"] || "f16", constants, 2),
    };
  }
  const kv = String(values.kvCacheDtype ?? "auto").trim().toLowerCase();
  if (!kv || kv === "auto") {
    // hf_quant_config kv_cache_quant_algo FP8 makes "auto" an FP8 cache.
    const scheme = String(card?.quant?.kvScheme ?? "");
    const bytes = /fp8/i.test(scheme) ? 1 : constants.modelDtypeBytes;
    return { bk: bytes, bv: bytes };
  }
  const bytes = dtypeBytesFor(kv, constants, constants.modelDtypeBytes);
  return { bk: bytes, bv: bytes };
}

function padCells(cells, padding) {
  const pad = Math.max(1, Math.floor(positive(padding) || 1));
  return Math.ceil(cells / pad) * pad;
}

function linearStatePerLayer(kind, constants) {
  const K = count(kind.convKernel) || 4;
  const conv = constants.convStateBytes;
  const ssm = dtypeBytesFor(kind.ssmDtype || "float32", constants, constants.ssmStateBytes);
  if (kind.variant === "mamba2") {
    const dInner = count(kind.dInner) || count(kind.nHeads) * count(kind.headDim);
    const G = count(kind.groups) || 1;
    const N = count(kind.stateSize);
    const nHeads = count(kind.nHeads);
    const headDim = count(kind.headDim) || (nHeads ? Math.floor(dInner / nHeads) : 0);
    // 02 §10.3: mamba2 SSM state is float32.
    return (dInner + 2 * G * N) * (K - 1) * conv + nHeads * headDim * N * 4;
  }
  if (kind.variant === "mamba") {
    const dInner = count(kind.dInner);
    const N = count(kind.stateSize);
    return dInner * (K - 1) * conv + dInner * N * 4;
  }
  // gated-deltanet
  const Hk = count(kind.kHeads);
  const Hv = count(kind.vHeads);
  const Dk = count(kind.kDim);
  const Dv = count(kind.vDim);
  return (2 * Hk * Dk + Hv * Dv) * (K - 1) * conv + Hv * Dk * Dv * ssm;
}

function layerGroups(card, { mtpOn }) {
  const topology = card?.topology || {};
  const attention = topology.attention || {};
  const kinds = attention.kinds || {};
  const groups = [];
  const histogram = isPlainObject(attention.histogram) ? attention.histogram : null;
  if (histogram && Object.keys(histogram).length) {
    for (const [kind, n] of Object.entries(histogram)) {
      if (count(n)) groups.push({ kind, count: count(n) });
    }
  } else if (count(topology.layers)) {
    groups.push({ kind: "unknown", count: count(topology.layers) });
  }
  const mtpLayers = count(topology.mtp?.layers);
  if (mtpOn && mtpLayers) {
    // The next-n/MTP layers attend like the main stack's attention layers.
    const kind = kinds.compressed ? "compressed" : kinds.full ? "full" : kinds.mla ? "mla" : "unknown";
    groups.push({ kind, count: mtpLayers, mtp: true });
  }
  return groups;
}

/**
 * kvBytes(card, values, { engineId, constants }) -> KV bytes for
 * contextLength x concurrency under the engine's layout:
 * { layers[], lowBytes, highBytes, stateBytesPerSeq, bytesPerTokenLow,
 *   bytesPerTokenHigh, uncertain, assumptions[] }.
 * lowBytes/highBytes exclude the recurrent state (stateBytesPerSeq x seqs).
 */
function kvBytes(card, values = {}, options = {}) {
  const constants = options.constants || FIT_CONSTANTS;
  const engineId = String(options.engineId || "");
  const plain = plainValues(values);
  const topology = card?.topology || {};
  const kinds = topology.attention?.kinds || {};
  const assumptions = [];
  const C = Math.max(1, Math.floor(positive(plain.contextLength) || positive(card?.context?.native) || 8192));
  const S = Math.max(1, Math.floor(positive(plain.concurrency) || 1));
  const { bk, bv } = cacheElementBytes(card, plain, engineId, constants);
  const layout = layoutFor(engineId);
  const ubatch = Math.floor(positive(plain["llamacpp.ubatchSize"]) || constants.defaultUbatch);
  const fullCells = layout.pooled ? padCells(C * S, constants.llamaCellPadding) : C * S;
  const swaCells = (window) => {
    if (layout.pooled) {
      if (plain["llamacpp.swaFull"] === true) return fullCells;
      return padCells(Math.min(C, window) * S + ubatch, constants.llamaCellPadding);
    }
    return Math.min(C, window) * S;
  };
  const mtpOn = MTP_METHODS.includes(String(plain["speculative.method"] || ""));
  const fallbackDims = {
    kvHeads: count(topology.kvHeads) || count(topology.heads),
    kDim: count(topology.headDim) || (count(topology.hiddenSize) && count(topology.heads) ? Math.floor(topology.hiddenSize / topology.heads) : 0),
  };
  const layers = [];
  let lowBytes = 0;
  let highBytes = 0;
  let stateBytesPerSeq = 0;
  let uncertain = false;
  const indexer = kinds.indexer && positive(kinds.indexer.compressRatio) ? kinds.indexer : null;
  const compressedRatios = Array.isArray(kinds.compressed?.ratios) ? kinds.compressed.ratios.map((r) => Math.max(0, Math.floor(Number(r) || 0))) : [];
  const mainCompressed = count(topology.attention?.histogram?.compressed);

  for (const group of layerGroups(card, { mtpOn })) {
    const n = group.count;
    switch (group.kind) {
      case "full": {
        const k = kinds.full || {};
        const Hkv = count(k.kvHeads) || fallbackDims.kvHeads;
        const Dk = count(k.kDim) || fallbackDims.kDim;
        const Dv = count(k.vDim) || Dk;
        if (!Hkv || !Dk) uncertain = true;
        const perToken = Hkv * (Dk * bk + Dv * bv);
        let bytes = n * perToken * fullCells;
        if (indexer && !group.mtp) {
          bytes += n * Math.ceil(C / indexer.compressRatio) * count(indexer.kDim) * (count(indexer.kvHeads) || 1) * 2 * S;
        }
        lowBytes += bytes;
        highBytes += bytes;
        layers.push({ kind: "full", count: n, bytesPerToken: n * perToken, ...(group.mtp ? { mtp: true } : {}) });
        break;
      }
      case "swa": {
        const k = kinds.swa || {};
        const window = count(k.window) || count(card?.context?.slidingWindow);
        const Hkv = count(k.kvHeads) || fallbackDims.kvHeads;
        const Dk = count(k.kDim) || fallbackDims.kDim;
        const Dv = count(k.vDim) || Dk;
        const perToken = Hkv * (Dk * bk + Dv * bv);
        if (!window) {
          assumptions.push(bilingual("滑动窗口大小未知，按全注意力计算 KV。", "The sliding window is unknown; KV is counted as full attention."));
          uncertain = true;
        }
        const bytes = n * perToken * (window ? swaCells(window) : fullCells);
        lowBytes += bytes;
        highBytes += bytes;
        layers.push({ kind: "swa", count: n, bytesPerToken: n * perToken, window: window || null });
        break;
      }
      case "mla": {
        const k = kinds.mla || {};
        const perToken = (count(k.kvLoraRank) + count(k.ropeDim)) * bk;
        if (!count(k.kvLoraRank)) uncertain = true;
        const bytes = n * perToken * fullCells;
        lowBytes += bytes;
        highBytes += bytes;
        layers.push({ kind: "mla", count: n, bytesPerToken: n * perToken });
        break;
      }
      case "compressed": {
        const k = kinds.compressed || {};
        const W = count(k.window);
        const latent = count(k.latentDim) || fallbackDims.kDim;
        const idxK = count(k.indexer?.kDim);
        // The main stack uses the first ratios; entries past it belong to MTP layers.
        const ratios = group.mtp
          ? compressedRatios.slice(mainCompressed, mainCompressed + n)
          : compressedRatios.slice(0, n);
        while (ratios.length < n) ratios.push(0);
        const histogram = {};
        let low = 0;
        let high = 0;
        for (const r of ratios) {
          histogram[r] = (histogram[r] || 0) + 1;
          if (r > 0) {
            const compressedTokens = Math.ceil(C / r);
            const bytes = (Math.min(C, W) + compressedTokens) * latent * bk + compressedTokens * idxK * 2;
            low += bytes;
            high += bytes;
          } else {
            // r = 0: only the window is certain; the whole context is the upper bound.
            low += Math.min(C, W || C) * latent * bk;
            high += C * latent * bk;
            uncertain = true;
          }
        }
        lowBytes += low * S;
        highBytes += high * S;
        layers.push({
          kind: "compressed", count: n, window: W || null, latentDim: latent || null, ratios: histogram,
          bytesPerSeqLow: low, bytesPerSeqHigh: high, ...(group.mtp ? { mtp: true } : {}),
        });
        break;
      }
      case "linear": {
        const k = kinds.linear || {};
        const perLayer = linearStatePerLayer(k, constants);
        if (!perLayer) uncertain = true;
        stateBytesPerSeq += n * perLayer;
        layers.push({ kind: "linear", count: n, stateBytesPerSeq: n * perLayer });
        break;
      }
      case "none":
        layers.push({ kind: "none", count: n });
        break;
      default: {
        // unknown: declared KV heads for low, all heads (MHA) for high.
        const D = fallbackDims.kDim;
        const lowHeads = count(topology.kvHeads) || count(topology.heads);
        const highHeads = Math.max(lowHeads, count(topology.heads));
        if (!D || !lowHeads) {
          assumptions.push(bilingual("注意力层结构未知，KV 显存无法按层计算。", "The attention layout is unknown; KV memory cannot be computed per layer."));
        }
        const perTokenLow = lowHeads * D * (bk + bv);
        const perTokenHigh = highHeads * D * (bk + bv);
        lowBytes += n * perTokenLow * fullCells;
        highBytes += n * perTokenHigh * fullCells;
        uncertain = true;
        layers.push({ kind: "unknown", count: n, bytesPerToken: n * perTokenLow, bytesPerTokenHigh: n * perTokenHigh });
      }
    }
  }
  // 01's memory models multiply kvBytesPerToken by tokens: per sequence token
  // on vLLM/SGLang; llama.cpp's gguf-estimate multiplies by contextLength
  // only, so there it is per slot-context token (the C x S pool / C).
  const basis = layout.perTokenBasis === "slot-context" ? C : C * S;
  return {
    layers,
    lowBytes,
    highBytes,
    stateBytesPerSeq,
    bytesPerTokenLow: Math.ceil(lowBytes / basis),
    bytesPerTokenHigh: Math.ceil(highBytes / basis),
    contextLength: C,
    concurrency: S,
    uncertain,
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// Weights on GPU (02 §10.4)
// ---------------------------------------------------------------------------

function classBytes(card) {
  const weights = card?.weights || {};
  const out = Object.fromEntries(WEIGHT_CLASSES.map((key) => [key, 0]));
  if (isPlainObject(weights.byClass) && WEIGHT_CLASSES.some((key) => positive(weights.byClass[key]))) {
    for (const key of WEIGHT_CLASSES) out[key] = positive(weights.byClass[key]);
    return { byClass: out, exact: weights.exact === true };
  }
  const bits = positive(card?.quant?.weightBits) || 16;
  out.other = positive(weights.totalBytes) || positive(card?.format?.weightBytes) || positive(card?.topology?.paramsTotal) * (bits / 8);
  return { byClass: out, exact: false };
}

function expertBytesByLayer(card, layers) {
  const listed = Array.isArray(card?.weights?.expertsByLayer) ? card.weights.expertsByLayer
    : Array.isArray(card?.topology?.moe?.expertBytesPerLayer) ? card.topology.moe.expertBytesPerLayer : null;
  if (listed && listed.length) return listed.slice(0, layers || listed.length).map(positive);
  const experts = positive(card?.weights?.byClass?.experts);
  return experts && layers ? Array.from({ length: layers }, () => experts / layers) : [];
}

function parseSplit(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,/]/);
  return list.map((item) => positive(isPlainObject(item) ? item.value : item));
}

function splitAcrossGpus(totalBytes, gpuIds, { weights = [], gpus = [] } = {}) {
  const ids = gpuIds.length ? gpuIds : ["0"];
  let shares = ids.map((_, index) => positive(weights[index]));
  if (!shares.some(Boolean)) {
    const byId = new Map(gpus.map((gpu) => [gpu.id, gpu]));
    shares = ids.map((id) => positive(byId.get(id)?.freeMb));
  }
  if (!shares.some(Boolean)) shares = ids.map(() => 1);
  const sum = shares.reduce((a, b) => a + b, 0);
  return Object.fromEntries(ids.map((id, index) => [id, mbCeil((totalBytes * shares[index]) / sum)]));
}

function llamaTensorOverrides(values, assumptions) {
  const entries = Array.isArray(values["llamacpp.overrideTensor"]) ? values["llamacpp.overrideTensor"] : [];
  const regexps = [];
  let knowledge = null;
  for (const entry of entries) {
    const item = typeof entry === "string"
      ? { pattern: entry.split("=")[0], buffer: entry.split("=")[1] }
      : isPlainObject(entry) ? entry : null;
    if (!item || String(item.buffer || "").toUpperCase() !== "CPU") continue;
    knowledge = knowledge || require("./knowledge");
    const compiled = knowledge.compileSafeRegex(String(item.pattern || ""), "");
    if (compiled.ok) regexps.push(compiled.regexp);
    else {
      assumptions.push(bilingual(
        `张量覆盖规则 ${String(item.pattern || "")} 无法安全解析，未计入内存放置。`,
        `The tensor override ${String(item.pattern || "")} cannot be parsed safely and is not counted.`));
    }
  }
  return regexps;
}

function weightPlacement(card, ctx) {
  const { engineId, values, gpuIds, gpus, assumptions } = ctx;
  const { byClass, exact } = classBytes(card);
  const mtpOn = MTP_METHODS.includes(String(values["speculative.method"] || ""));
  const ram = { weights: 0, experts: 0 };
  const offload = { expertLayersInRam: 0, expertMbInRam: 0, layersInRam: 0, tensorsInRam: 0, fixedRamMb: 0 };
  const gpu = { ...byClass };
  if (!mtpOn) gpu.mtp = 0;

  if (isLlama(engineId)) {
    const L = count(card?.topology?.layers);
    const experts = expertBytesByLayer(card, L);
    const denseLayer = L ? gpu.dense / L : 0;
    const expertOnGpu = experts.map(() => true);
    const denseOnGpu = Array.from({ length: L }, () => true);
    // token_embd stays in host RAM on llama.cpp: counted in RAM, but it is the
    // engine's fixed placement, not a spill the values chose.
    ram.weights += gpu.embedding;
    offload.fixedRamMb = mbCeil(gpu.embedding);
    gpu.embedding = 0;
    const cpuMoe = values["llamacpp.cpuMoe"] === true ? L : Math.min(L, count(values["llamacpp.nCpuMoe"]));
    for (let i = 0; i < Math.min(cpuMoe, experts.length); i += 1) expertOnGpu[i] = false;
    const rawLayers = values["llamacpp.gpuLayers"];
    const gpuLayers = rawLayers === null || rawLayers === undefined || rawLayers === "" || rawLayers === "all" || rawLayers === "auto"
      ? Infinity
      : Number.isFinite(Number(rawLayers)) ? Math.max(0, Math.floor(Number(rawLayers))) : Infinity;
    if (rawLayers === "auto") {
      assumptions.push(bilingual("GPU 层数为 auto：按全部层放在 GPU 上估算。", "GPU layers is auto: the estimate assumes every layer on the GPU."));
    }
    const cpuLayers = Number.isFinite(gpuLayers) ? Math.max(0, L - gpuLayers) : 0;
    for (let i = 0; i < cpuLayers; i += 1) {
      denseOnGpu[i] = false;
      if (i < expertOnGpu.length) expertOnGpu[i] = false;
    }
    // The output layer is offloaded only when every repeating layer is.
    let lmHeadOnGpu = !Number.isFinite(gpuLayers) || gpuLayers > L;
    for (const regexp of llamaTensorOverrides(values, assumptions)) {
      for (let i = 0; i < L; i += 1) {
        if (expertOnGpu[i] && i < experts.length && experts[i]
          && ["ffn_up_exps", "ffn_gate_exps", "ffn_down_exps"].some((name) => regexp.test(`blk.${i}.${name}.weight`))) {
          expertOnGpu[i] = false;
          offload.tensorsInRam += 1;
        }
        if (denseOnGpu[i] && ["attn_q", "attn_kv_a_mqa", "ffn_up", "ffn_down"].some((name) => regexp.test(`blk.${i}.${name}.weight`))) {
          denseOnGpu[i] = false;
          offload.tensorsInRam += 1;
        }
      }
      if (lmHeadOnGpu && regexp.test("output.weight")) {
        lmHeadOnGpu = false;
        offload.tensorsInRam += 1;
      }
    }
    if (offload.tensorsInRam) {
      assumptions.push(bilingual(
        "张量覆盖规则按张量类别（专家、注意力/前馈、输出层）估算放置。",
        "Tensor overrides are estimated by tensor class (experts, attention/FFN, output)."));
    }
    let expertsInRam = 0;
    experts.forEach((bytes, i) => {
      if (!expertOnGpu[i]) {
        expertsInRam += bytes;
        offload.expertLayersInRam += 1;
      }
    });
    const denseLayersInRam = denseOnGpu.filter((onGpu) => !onGpu).length;
    ram.experts += expertsInRam;
    gpu.experts = Math.max(0, gpu.experts - expertsInRam);
    ram.weights += denseLayer * denseLayersInRam;
    gpu.dense = Math.max(0, gpu.dense - denseLayer * denseLayersInRam);
    if (!lmHeadOnGpu) {
      ram.weights += gpu.lmHead;
      gpu.lmHead = 0;
    }
    offload.layersInRam = cpuLayers;
    offload.expertMbInRam = mbCeil(expertsInRam);
    const gpuBytes = WEIGHT_CLASSES.reduce((sum, key) => sum + gpu[key], 0);
    return {
      byClass,
      exact,
      gpuBytes,
      ram,
      offload,
      byGpu: splitAcrossGpus(gpuBytes, gpuIds, { weights: parseSplit(values["llamacpp.tensorSplit"]), gpus }),
    };
  }

  if (engineId === "vllm" && values["vllm.languageModelOnly"] === true) {
    gpu.vision = 0;
    gpu.audio = 0;
  }
  if (engineId === "sglang" && values["sglang.pleOffloadEmbedding"] === true) {
    ram.weights += gpu.ple;
    gpu.ple = 0;
  }
  const shards = Math.max(1, Math.floor(positive(values.tensorParallel) || 1)) * Math.max(1, Math.floor(positive(values.pipelineParallel) || 1));
  let gpuBytes = WEIGHT_CLASSES.reduce((sum, key) => sum + gpu[key], 0);
  if (engineId === "vllm") {
    const offloadBytes = Math.min(gpuBytes, positive(values["vllm.cpuOffloadGb"]) * GIB * shards);
    gpuBytes -= offloadBytes;
    ram.weights += offloadBytes;
  }
  const ids = (gpuIds.length ? gpuIds : Array.from({ length: shards }, (_, index) => String(index))).slice(0, shards);
  return {
    byClass,
    exact,
    gpuBytes,
    ram,
    offload,
    byGpu: Object.fromEntries(ids.map((id) => [id, mbCeil(gpuBytes / shards)])),
  };
}

function cardWeightBytes(card) {
  const { byClass } = classBytes(card);
  return WEIGHT_CLASSES.reduce((sum, key) => sum + byClass[key], 0);
}

function companionBytes(card, values, engineId, ctx) {
  const { draftCard, mmprojCard, constants, assumptions } = ctx;
  const method = String(values["speculative.method"] || "");
  let draft = 0;
  if (DRAFT_METHODS.includes(method) && (values["speculative.draftModel"] || draftCard)) {
    if (isPlainObject(draftCard)) {
      // Draft weights plus its own KV (02 §10.4).
      draft = cardWeightBytes(draftCard) + kvBytes(draftCard, values, { engineId, constants }).lowBytes;
    } else {
      assumptions.push(bilingual("草稿模型的大小未知，未计入显存。", "The draft model's size is unknown and is not counted."));
    }
  }
  let mmproj = 0;
  if (isLlama(engineId) && values["llamacpp.mmproj"] && values["llamacpp.textOnly"] !== true) {
    if (isPlainObject(mmprojCard)) {
      mmproj = positive(mmprojCard.weights?.totalBytes) || cardWeightBytes(mmprojCard);
    } else {
      const name = String(values["llamacpp.mmproj"]).split(/[\\/]/).pop();
      const file = (Array.isArray(card?.modalities?.projectorFiles) ? card.modalities.projectorFiles : [])
        .find((item) => isPlainObject(item) && String(item.name || "").split(/[\\/]/).pop() === name);
      mmproj = positive(file?.size ?? file?.bytes);
      if (!mmproj) assumptions.push(bilingual("多模态投影文件的大小未知，未计入显存。", "The multimodal projector's size is unknown and is not counted."));
    }
  }
  return { draft, mmproj };
}

function artifactConfidence(card, legacy, exact) {
  if (!card) return "heuristic";
  if (exact) return "exact";
  return count(card.topology?.layers) ? "config" : "heuristic";
}

function legacyArtifactFacts(legacy, values, engineId, constants) {
  const llama = isLlama(engineId);
  const paramsB = positive(legacy.paramsB);
  const bytesPerParam = positive(legacy.bytesPerParam) || (llama ? 0.56 : 2);
  const arch = memoryEstimator.estimateArchitecture(paramsB, legacy.arch || legacy.modelConfig || legacy.config || null);
  const C = Math.max(1, Math.floor(positive(values.contextLength) || 8192));
  const S = Math.max(1, Math.floor(positive(values.concurrency) || 1));
  let { bk, bv } = cacheElementBytes(null, values, engineId, constants);
  if (positive(legacy.kvBytes)) bk = bv = positive(legacy.kvBytes);
  const kvLayers = count(arch.kvLayers) || count(arch.layers);
  const lowPerToken = kvLayers * count(arch.kvHeads) * count(arch.headDim) * (bk + bv);
  const highPerToken = kvLayers * Math.max(count(arch.kvHeads), count(arch.kvHeadsHigh)) * count(arch.headDim) * (bk + bv);
  const weightBytes = paramsB * 1e9 * bytesPerParam;
  return {
    weightBytes,
    layers: count(arch.layers),
    kvLayers: [{ kind: arch.source === "heuristic" ? "unknown" : "full", count: kvLayers, bytesPerToken: lowPerToken, ...(highPerToken !== lowPerToken ? { bytesPerTokenHigh: highPerToken } : {}) }],
    lowBytes: lowPerToken * C * S,
    highBytes: highPerToken * C * S,
    basis: llama ? C : C * S,
    uncertain: highPerToken !== lowPerToken,
  };
}

/**
 * artifactMemoryInputs({ card, legacy, engineId, values, gpuIds, host,
 * draftCard?, mmprojCard? }, { constants }) -> MemoryInputs.artifact: 01 §12's
 * field names first, then the additive "artifact-memory-inputs/v1" fields.
 * values are effective catalog values (plain or { value, source }).
 */
function artifactMemoryInputs(input = {}, options = {}) {
  const constants = options.constants || resolveFitConstants(options.fitConstants);
  const card = isPlainObject(input.card) ? input.card : null;
  const legacy = isPlainObject(input.legacy) ? input.legacy : null;
  const engineId = String(input.engineId || "");
  const values = plainValues(input.values);
  const gpuIds = (Array.isArray(input.gpuIds) ? input.gpuIds : []).map(String);
  const gpus = normalizeHostGpus(input.host?.gpus);
  const assumptions = [];
  if (!card && !legacy) {
    const error = new Error("A fit needs a model card or legacy model facts.");
    error.code = "fit_input_invalid";
    throw error;
  }

  if (!card) {
    const facts = legacyArtifactFacts(legacy, values, engineId, constants);
    assumptions.push(bilingual("没有模型卡片：按参数量和架构估算（启发式）。", "No model card: estimated from the parameter count and architecture (heuristic)."));
    const ids = gpuIds.length ? gpuIds : gpus.length ? gpus.map((gpu) => gpu.id) : ["0"];
    const weightsMb = mbCeil(facts.weightBytes);
    return {
      weightsMb,
      kvBytesPerToken: Math.ceil(facts.lowBytes / facts.basis),
      kvBytesPerTokenHigh: Math.ceil(facts.highBytes / facts.basis),
      stateBytesPerSeq: 0,
      draftMb: 0,
      mmprojMb: 0,
      hidden: 0,
      vocab: 0,
      confidence: "heuristic",
      schema: ARTIFACT_SCHEMA_ID,
      cardId: null,
      contentDigest: null,
      layers: facts.layers,
      nativeContext: null,
      weightsMbByGpu: isLlama(engineId)
        ? splitAcrossGpus(facts.weightBytes, ids, { gpus })
        : Object.fromEntries(ids.map((id) => [id, weightsMb])),
      ramMb: { weights: 0, experts: 0, kv: 0 },
      byClassMb: { ...Object.fromEntries(WEIGHT_CLASSES.map((key) => [key, 0])), other: weightsMb },
      offload: { expertLayersInRam: 0, expertMbInRam: 0, layersInRam: 0, tensorsInRam: 0, fixedRamMb: 0 },
      kvMb: { low: mbCeil(facts.lowBytes), high: mbCeil(facts.highBytes) },
      kvLayers: facts.kvLayers,
      uncertain: facts.uncertain,
      assumptions,
    };
  }

  const kv = kvBytes(card, values, { engineId, constants });
  assumptions.push(...kv.assumptions);
  const placement = weightPlacement(card, { engineId, values, gpuIds, gpus, assumptions });
  if (!placement.exact) {
    assumptions.push(bilingual("权重大小来自配置或文件大小，不是张量表。", "Weight bytes come from the config or file sizes, not a tensor table."));
  }
  const companions = companionBytes(card, values, engineId, { draftCard: input.draftCard, mmprojCard: input.mmprojCard, constants, assumptions });
  const ramKvMb = engineId === "vllm" ? Math.ceil(positive(values["vllm.kvOffloadingSize"]) * 1024) : 0;
  const topology = card.topology || {};
  return {
    weightsMb: mbCeil(placement.gpuBytes),
    kvBytesPerToken: kv.bytesPerTokenLow,
    kvBytesPerTokenHigh: kv.bytesPerTokenHigh,
    stateBytesPerSeq: kv.stateBytesPerSeq,
    draftMb: mbCeil(companions.draft),
    mmprojMb: mbCeil(companions.mmproj),
    hidden: count(topology.hiddenSize),
    vocab: count(topology.vocabSize),
    confidence: artifactConfidence(card, legacy, placement.exact),
    schema: ARTIFACT_SCHEMA_ID,
    cardId: card.cardId || null,
    contentDigest: card.contentDigest || null,
    layers: count(topology.layers),
    nativeContext: count(card.context?.native) || null,
    weightsMbByGpu: placement.byGpu,
    ramMb: { weights: mbCeil(placement.ram.weights), experts: mbCeil(placement.ram.experts), kv: ramKvMb },
    byClassMb: Object.fromEntries(WEIGHT_CLASSES.map((key) => [key, mbCeil(placement.byClass[key])])),
    offload: placement.offload,
    kvMb: { low: mbCeil(kv.lowBytes), high: mbCeil(kv.highBytes) },
    kvLayers: kv.layers,
    uncertain: kv.uncertain,
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// estimateFit (02 §10.2, §10.5)
// ---------------------------------------------------------------------------

function normalizeHostGpus(gpus) {
  return (Array.isArray(gpus) ? gpus : []).map((gpu, index) => {
    const totalMb = positive(gpu?.totalMb);
    const usedMb = positive(gpu?.usedMb);
    const freeRaw = Number(gpu?.freeMb);
    return {
      id: String(gpu?.id ?? gpu?.index ?? index),
      name: gpu?.name ? String(gpu.name) : undefined,
      totalMb,
      usedMb,
      freeMb: Number.isFinite(freeRaw) && freeRaw >= 0 ? freeRaw : Math.max(0, totalMb - usedMb),
      computeCap: gpu?.computeCap ?? undefined,
    };
  }).filter((gpu) => gpu.totalMb > 0);
}

function fitGpus(host, gpuIds, budgetBasis, constants) {
  const all = normalizeHostGpus(host?.gpus);
  const selected = gpuIds.length ? all.filter((gpu) => gpuIds.includes(gpu.id)) : all;
  const strip = (gpu) => Object.fromEntries(Object.entries(gpu).filter(([, value]) => value !== undefined));
  if (budgetBasis === "now") return selected.map(strip);
  return selected.map((gpu) => strip({
    ...gpu,
    usedMb: constants.idleUsedMb,
    freeMb: Math.max(0, gpu.totalMb - constants.idleUsedMb),
  }));
}

function defaultMemoryModels() {
  return require("../engines/memory-models");
}

function paramsKeyFor(models, engineId, values) {
  const fn = typeof models?.paramsKey === "function" ? models.paramsKey : defaultMemoryModels().paramsKey;
  return fn({ engineId, values }, engineId);
}

function unavailableWarning(engineId, error) {
  return finding("engine_model_unavailable",
    `引擎 ${engineId || "（未指定）"} 的显存模型不可用，改按“权重 + KV”粗略估算。`,
    `The memory model of engine ${engineId || "(none)"} is unavailable; a coarse weights-plus-KV estimate is used instead.`,
    error?.code ? { cause: String(error.code) } : {});
}

// The last resort when memory-models itself cannot run: weights plus KV plus
// 1 GiB, the same shape as 01's weights-plus-kv policy.
function localWeightsPlusKv(inputs) {
  const artifact = inputs.artifact || {};
  const tokens = positive(inputs.values.contextLength) * Math.max(1, positive(inputs.values.concurrency) || 1);
  const kv = (tokens * positive(artifact.kvBytesPerToken)) / MIB;
  const requestedMb = Math.ceil(positive(artifact.weightsMb) + kv + 1024);
  return {
    perGpuMb: Object.fromEntries(inputs.gpus.map((gpu) => [gpu.id, requestedMb])),
    breakdown: { weights: Math.round(positive(artifact.weightsMb)), kv: Math.round(kv), activations: 0, draft: 0, mmproj: 0, overhead: 1024 },
    admissionRequestMb: requestedMb,
    kvPoolTokens: tokens || null,
    maxFullLengthRequests: null,
    policy: "weights-plus-kv",
    confidence: "estimated",
    admissionRequest: { requestedMb, estimatePolicy: "weights_plus_kv" },
    notes: [],
    warnings: [],
    errors: [],
  };
}

/** One memoryModels.estimate call with the engine_model_unavailable fallback. */
function runEstimate(models, engineId, inputs, fallbackWarnings) {
  let estimate = null;
  let failure = null;
  try {
    if (typeof models?.estimate !== "function") throw Object.assign(new Error("memory models missing"), { code: "memory_models_missing" });
    estimate = models.estimate(engineId, inputs);
    if (!isPlainObject(estimate)) throw Object.assign(new Error("memory model returned no estimate"), { code: "memory_model_invalid" });
    const policy = POLICY_ALIASES[estimate.policy] || estimate.policy;
    if (!MEMORY_POLICIES.includes(policy)) throw Object.assign(new Error(`unknown policy ${String(estimate.policy)}`), { code: "memory_policy_invalid" });
    if (policy !== estimate.policy) estimate = { ...estimate, policy };
    return estimate;
  } catch (error) {
    failure = error;
  }
  fallbackWarnings.push(unavailableWarning(engineId, failure));
  try {
    if (typeof models?.estimate === "function") {
      const coarse = models.estimate(engineId, inputs, { memoryModel: { kind: "weights-plus-kv" } });
      if (isPlainObject(coarse) && coarse.policy === "weights-plus-kv" && coarse.admissionRequest) return coarse;
    }
  } catch {
    // fall through to the local estimate
  }
  return localWeightsPlusKv(inputs);
}

function highArtifact(artifact) {
  return {
    ...artifact,
    kvBytesPerToken: artifact.kvBytesPerTokenHigh,
    kvMb: { low: artifact.kvMb.high, high: artifact.kvMb.high },
  };
}

function budgetsFor(gpus, budgetBasis, policy) {
  const maxUtil = positive(policy.maxUtilizationPct) / 100 || DEFAULT_MAX_UTILIZATION_PCT / 100;
  const reserveMb = Number.isFinite(Number(policy.reserveMb)) && Number(policy.reserveMb) >= 0 ? Number(policy.reserveMb) : DEFAULT_RESERVE_MB;
  const out = {};
  for (const gpu of gpus) {
    const budget = budgetBasis === "now"
      ? Math.min(gpu.freeMb - reserveMb, gpu.totalMb * maxUtil - gpu.usedMb)
      : gpu.totalMb * maxUtil - reserveMb;
    out[gpu.id] = Math.max(0, Math.floor(budget));
  }
  return out;
}

function ramLimitMb(host, budgetBasis, constants) {
  const bytes = budgetBasis === "now"
    ? positive(host?.ramFreeBytes)
    : positive(host?.ramBytes) || positive(host?.ramFreeBytes);
  if (!bytes) return null;
  return bytes / MIB - constants.ramReserveGb * 1024;
}

function engineWeightsMb(record) {
  const facts = record?.measured?.logFacts || record?.logFacts || null;
  if (!isPlainObject(facts)) return 0;
  if (positive(facts.weightsGiB)) return positive(facts.weightsGiB) * 1024;
  if (isPlainObject(facts.modelBufferMiB)) {
    return Object.entries(facts.modelBufferMiB)
      .filter(([device]) => !/^cpu/i.test(device))
      .reduce((sum, [, mb]) => sum + positive(mb), 0);
  }
  return 0;
}

/** calibration block, estimate_drift and weights_mismatch (02 §10.6). */
function calibrationFindings({ calibration, recipeMemory, primary, artifact, engineId, values, constants }) {
  const warnings = [];
  const exact = calibration?.exact === true && positive(calibration.measuredMb) > 0;
  const recipe = positive(recipeMemory?.measuredMiB) > 0;
  const block = {
    applied: primary.policy === "measured" && (exact || recipe),
    samples: count(calibration?.samples),
    source: primary.policy === "measured" ? (recipe ? "recipe" : exact ? "exact" : null) : null,
    driftRatio: null,
  };
  const records = (Array.isArray(calibration?.records) ? calibration.records : []).slice(-constants.driftSamples);
  const ratios = records.map((record) => {
    const measured = maxOf(record?.measured?.perGpuMb);
    const estimated = maxOf(record?.estimated?.perGpuMb);
    return measured && estimated ? measured / estimated : NaN;
  });
  const ratio = median(ratios);
  if (ratio !== null && (ratio < constants.driftLow || ratio > constants.driftHigh)) {
    block.driftRatio = Math.round(ratio * 1000) / 1000;
    warnings.push(finding("estimate_drift",
      `本机实测显存与估算相差较大（实测/估算 = ${block.driftRatio}），估算可能偏${ratio > 1 ? "低" : "高"}。`,
      `Measured memory on this host differs from the estimate (measured/estimated = ${block.driftRatio}); the estimate may be too ${ratio > 1 ? "low" : "high"}.`));
  }
  const latest = records.length ? records[records.length - 1] : null;
  const reportedMb = engineWeightsMb(latest);
  if (reportedMb && artifact.weightsMb) {
    const shards = isLlama(engineId) ? 1
      : Math.max(1, Math.floor(positive(values.tensorParallel) || 1)) * Math.max(1, Math.floor(positive(values.pipelineParallel) || 1));
    const expectedMb = artifact.weightsMb / shards;
    if (Math.abs(reportedMb - expectedMb) / expectedMb > constants.weightsMismatchRatio) {
      warnings.push(finding("weights_mismatch",
        `引擎报告的权重 ${Math.round(reportedMb)} MiB 与模型文件推算的 ${Math.round(expectedMb)} MiB 相差超过 ${Math.round(constants.weightsMismatchRatio * 100)}%；权重计入规则可能不适用于这个模型。`,
        `The engine reported ${Math.round(reportedMb)} MiB of weights, more than ${Math.round(constants.weightsMismatchRatio * 100)}% off the ${Math.round(expectedMb)} MiB derived from the files; a weight inclusion rule may not hold for this model.`));
    }
  }
  return { block, warnings };
}

function gradeEstimate({ estimate, artifact, budgetMb, gpus, values, ramLimit, confidence }, constants) {
  const reasons = [];
  let status = "ok";
  const fail = (reason) => {
    status = "fail";
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const warn = (reason) => {
    if (status === "ok") status = "warn";
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const perGpu = isPlainObject(estimate.perGpuMb) ? estimate.perGpuMb : {};
  let headroomMb = null;
  let overflowMb = 0;
  for (const [id, mb] of Object.entries(perGpu)) {
    if (!Object.hasOwn(budgetMb, id)) continue;
    const budget = budgetMb[id];
    const headroom = budget - mb;
    headroomMb = headroomMb === null ? headroom : Math.min(headroomMb, headroom);
    if (mb > budget) {
      overflowMb = Math.max(overflowMb, mb - budget);
      fail("vram");
    } else if (mb > budget * constants.warnBudgetRatio) warn("vram_tight");
  }
  if (!gpus.length) warn("no_gpu_data");
  if (estimate.maxFullLengthRequests === 0 || (Array.isArray(estimate.errors) && estimate.errors.length)) fail("engine");
  const concurrency = Math.max(1, Math.floor(positive(values.concurrency) || 1));
  if (Number.isFinite(estimate.maxFullLengthRequests) && estimate.maxFullLengthRequests > 0 && estimate.maxFullLengthRequests < concurrency) {
    warn("kv_below_concurrency");
  }
  const ram = artifact.ramMb;
  const ramUsed = ram.weights + ram.experts + ram.kv;
  const spill = ramUsed - (artifact.offload?.fixedRamMb || 0) > 0;
  if (ramLimit !== null && ramUsed > ramLimit) fail("ram");
  if (spill) warn("spill");
  if (confidence === "heuristic") warn("heuristic");
  if (estimate.confidence === "fraction-only") warn("fraction_only");
  return { status, reasons, spill, headroomMb: headroomMb === null ? null : Math.floor(headroomMb), overflowMb: Math.ceil(overflowMb) };
}

const SUGGESTION_COPY = {
  gmu_admission: (to) => bilingual(`显存门禁预算不足：把显存预留比例降到 ${to}。`, `The VRAM gate budget is too small: lower the GPU memory reservation to ${to}.`),
  kv_fp8: () => bilingual("把 KV 缓存精度改为 FP8，KV 显存大约减半。", "Use an FP8 KV cache to roughly halve KV memory."),
  kv_q8: () => bilingual("把 KV 缓存量化为 q8_0，KV 显存大约减半。", "Quantize the KV cache to q8_0 to roughly halve KV memory."),
  context_shorter: (to) => bilingual(`把上下文长度降到 ${to} tokens。`, `Lower the context length to ${to} tokens.`),
  cpu_offload: (to) => bilingual(`把 ${to} GiB/卡 的权重放到 CPU 内存，给 KV 留出空间。`, `Offload ${to} GiB of weights per GPU to CPU memory to make room for KV.`),
  sglang_pool_cap: (to) => bilingual(`设置 KV 池上限为 ${to} tokens，显存不足时门禁可按安全预算收紧预留。`, `Cap the KV pool at ${to} tokens so the VRAM gate can clamp the reservation to the safe budget.`),
  sglang_fraction: (to) => bilingual(`把静态显存比例降到 ${to}。`, `Lower the static memory fraction to ${to}.`),
  moe_to_ram: (to) => bilingual(`把前 ${to} 层的 MoE 专家放到 CPU 内存。`, `Keep the MoE experts of the first ${to} layers in CPU memory.`),
  ple_offload: () => bilingual("把逐层嵌入（PLE）放到 CPU 内存。", "Keep the per-layer embeddings (PLE) in CPU memory."),
  fewer_gpu_layers: (to) => bilingual(`只把 ${to} 层放到 GPU 上。`, `Put only ${to} layers on the GPU.`),
};

function suggestionsFor(ctx, constants) {
  const { engineId, values, base, grade, artifact, gpus, budgetMb, evaluate } = ctx;
  if (grade.status === "ok") return [];
  const out = [];
  const baseMax = maxOf(base.perGpuMb);
  const baseFull = Number.isFinite(base.maxFullLengthRequests) ? base.maxFullLengthRequests : null;
  const tight = grade.reasons.includes("vram");
  const kvShort = grade.reasons.includes("engine") || grade.reasons.includes("kv_below_concurrency");
  const C = Math.floor(positive(values.contextLength));
  const minBudget = Math.min(...gpus.map((gpu) => budgetMb[gpu.id] ?? Infinity));
  // admissionClamp: a capped SGLang pool keeps its reservation but lets the
  // gate clamp it to the safe budget instead of refusing (P0-RT-3).
  const offer = (code, param, to, { admissionClamp = false } = {}) => {
    if (out.length >= constants.maxSuggestions) return null;
    const changed = evaluate({ ...values, [param]: to });
    if (!changed) return null;
    const deltaMb = maxOf(changed.perGpuMb) - baseMax;
    const full = Number.isFinite(changed.maxFullLengthRequests) ? changed.maxFullLengthRequests : null;
    const helps = deltaMb < 0 || (full !== null && baseFull !== null && full > baseFull);
    if (!helps && !admissionClamp) return null;
    const suggestion = { code, param, to, deltaMb, message: SUGGESTION_COPY[code](to) };
    if (admissionClamp) suggestion.admissionClamp = true;
    if (full !== null) suggestion.maxFullLengthRequests = full;
    out.push(suggestion);
    return changed;
  };
  const shorterContext = () => {
    const to = Math.max(constants.minSuggestedContext, Math.floor(C / 2));
    if (C && to < C) offer("context_shorter", "contextLength", to);
  };
  const fitsBudget = (estimate) => Object.entries(estimate?.perGpuMb || {}).every(([id, mb]) => !Object.hasOwn(budgetMb, id) || mb <= budgetMb[id]);

  if (isLlama(engineId)) {
    const L = count(artifact.layers);
    const moe = artifact.byClassMb.experts > 0;
    if (tight && moe && L) {
      // Smallest llamacpp.nCpuMoe that fits (binary search, <= 7 evaluations).
      const current = count(values["llamacpp.nCpuMoe"]);
      let lo = current + 1;
      let hi = L;
      let best = null;
      for (let step = 0; step < 7 && lo <= hi; step += 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (fitsBudget(evaluate({ ...values, "llamacpp.nCpuMoe": mid }, { graded: true }))) {
          best = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      offer("moe_to_ram", "llamacpp.nCpuMoe", best ?? L);
    }
    if (tight && L) {
      let lo = 0;
      let hi = L - 1;
      let best = null;
      for (let step = 0; step < 7 && lo <= hi; step += 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (fitsBudget(evaluate({ ...values, "llamacpp.gpuLayers": mid }, { graded: true }))) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (best !== null) offer("fewer_gpu_layers", "llamacpp.gpuLayers", best);
    }
    if (String(values["llamacpp.cacheTypeK"] || "f16") === "f16" && String(values["llamacpp.cacheTypeV"] || "f16") === "f16") {
      const changed = evaluate({ ...values, "llamacpp.cacheTypeK": "q8_0", "llamacpp.cacheTypeV": "q8_0" });
      const deltaMb = changed ? maxOf(changed.perGpuMb) - baseMax : 0;
      if (changed && deltaMb < 0 && out.length < constants.maxSuggestions) {
        out.push({ code: "kv_q8", param: "llamacpp.cacheTypeK", to: "q8_0", also: { "llamacpp.cacheTypeV": "q8_0" }, deltaMb, message: SUGGESTION_COPY.kv_q8() });
      }
    }
    shorterContext();
    return out;
  }

  if (engineId === "sglang") {
    if (artifact.byClassMb.ple > 0 && values["sglang.pleOffloadEmbedding"] !== true) {
      offer("ple_offload", "sglang.pleOffloadEmbedding", true);
    }
    const free = Math.min(...gpus.map((gpu) => gpu.freeMb));
    if (tight && !positive(values["sglang.maxTotalTokens"]) && C) {
      offer("sglang_pool_cap", "sglang.maxTotalTokens", C * Math.max(1, Math.floor(positive(values.concurrency) || 1)), { admissionClamp: true });
    }
    const fraction = positive(values["sglang.memFractionStatic"]);
    if (tight && Number.isFinite(minBudget) && free > 0 && fraction) {
      const to = Math.floor((minBudget / free) * 100) / 100;
      if (to > 0 && to < fraction) offer("sglang_fraction", "sglang.memFractionStatic", to);
    }
  }

  if (engineId === "vllm") {
    // vLLM never lowers its reservation to make a model fit; only an
    // admission conflict (the reservation above the gate's budget) does.
    const gmu = positive(values["vllm.gpuMemoryUtilization"]);
    const total = Math.min(...gpus.map((gpu) => gpu.totalMb));
    if (tight && gmu && Number.isFinite(minBudget) && total > 0) {
      const to = Math.floor((minBudget / total) * 100) / 100;
      if (to > 0 && to < gmu) offer("gmu_admission", "vllm.gpuMemoryUtilization", to);
    }
  }

  if (kvShort || tight) {
    if (!/fp8/i.test(String(values.kvCacheDtype || "auto"))) offer("kv_fp8", "kvCacheDtype", "fp8");
    shorterContext();
    if (engineId === "vllm" && kvShort) {
      const shards = Math.max(1, Math.floor(positive(values.tensorParallel) || 1)) * Math.max(1, Math.floor(positive(values.pipelineParallel) || 1));
      const perRequestGiB = Math.ceil(artifact.kvMb.high / Math.max(1, Math.floor(positive(values.concurrency) || 1)) / shards / 1024);
      if (perRequestGiB > 0) offer("cpu_offload", "vllm.cpuOffloadGb", positive(values["vllm.cpuOffloadGb"]) + perRequestGiB);
    }
  }
  return out;
}

/**
 * The shared front half of estimateFit and of the plan's memory inputs
 * (MOD-9b): normalized values, selected GPUs, the artifact builder and the
 * MemoryInputs assembler. A launch plan (plan-facts) and a fit for the same
 * card, values and host report the same estimate because both go through here.
 */
function prepareFit(fitInput = {}, options = {}) {
  const input = isPlainObject(fitInput) ? fitInput : {};
  const constants = options.constants || resolveFitConstants(options.fitConstants);
  const engineId = String(input.engineId || "");
  const instanceMode = INSTANCE_MODES.includes(input.instanceMode) ? input.instanceMode : "parallel";
  const budgetBasis = BUDGET_BASES.includes(input.budgetBasis) ? input.budgetBasis : "empty-gpu";
  const card = isPlainObject(input.card) ? input.card : null;
  const assumptions = [];
  const catalog = loadCatalogFor(engineId, options);
  const values = normalizeFitValues(engineId, input.values, { catalog, instanceMode, assumptions });
  const hostGpus = normalizeHostGpus(input.host?.gpus);
  const gpuIds = Array.isArray(input.gpuIds) && input.gpuIds.length ? input.gpuIds.map(String) : hostGpus.map((gpu) => gpu.id);
  const gpus = fitGpus(input.host, gpuIds, budgetBasis, constants);
  const models = options.memoryModels || defaultMemoryModels();
  const recipeMemory = isPlainObject(input.recipeMemory) ? input.recipeMemory : isPlainObject(options.recipeMemory) ? options.recipeMemory : null;

  const build = (vals) => artifactMemoryInputs({ ...input, card, engineId, values: vals, gpuIds }, { constants });
  const calibrationOf = (vals) => {
    if (Object.hasOwn(options, "calibration")) return options.calibration ?? null;
    if (typeof options.calibrationFor !== "function" || !card) return null;
    try {
      return options.calibrationFor(card, engineId, input.runtimeId ?? null, paramsKeyFor(models, engineId, vals)) ?? null;
    } catch {
      return null;
    }
  };
  const inputsFor = (vals, artifact) => ({
    values: vals,
    artifact,
    gpus,
    mode: instanceMode,
    recipeMemory,
    calibration: calibrationOf(vals),
    legacy: null,
  });
  return { input, constants, engineId, instanceMode, budgetBasis, card, assumptions, values, gpuIds, gpus, models, recipeMemory, build, calibrationOf, inputsFor };
}

/**
 * fitMemoryInputs(FitInput, options) -> { inputs, artifact, values, paramsKey,
 * assumptions, engineId }: the full 01 MemoryInputs of a fit, without running
 * the estimate. Used by the launch plan's memory step.
 */
function fitMemoryInputs(fitInput = {}, options = {}) {
  const prep = prepareFit(fitInput, options);
  const artifact = prep.build(prep.values);
  const inputs = prep.inputsFor(prep.values, artifact);
  return {
    engineId: prep.engineId,
    inputs,
    artifact,
    values: prep.values,
    paramsKey: paramsKeyFor(prep.models, prep.engineId, prep.values),
    assumptions: [...prep.assumptions, ...artifact.assumptions],
  };
}

/**
 * estimateFit(FitInput, options) -> FitResult (02 §10.2).
 *
 * options: { memoryModels (01 engines/memory-models or a stub), catalog |
 * catalogs (01 param catalogs; default the bundled ones), calibrationFor
 * (card, engineId, runtimeId, paramsKey) | calibration, recipeMemory,
 * admissionPolicy { reserveMb, maxUtilizationPct }, fitConstants,
 * suggestions (false skips them) }.
 */
function estimateFit(fitInput = {}, options = {}) {
  const {
    input, constants, engineId, instanceMode, budgetBasis, card, assumptions, values, gpuIds, gpus, models, recipeMemory, build, inputsFor,
  } = prepareFit(fitInput, options);

  const artifact = build(values);
  assumptions.push(...artifact.assumptions);
  const fallbackWarnings = [];
  const inputs = inputsFor(values, artifact);
  const primary = runEstimate(models, engineId, inputs, fallbackWarnings);
  const hasRange = artifact.kvMb.low !== artifact.kvMb.high || artifact.kvBytesPerToken !== artifact.kvBytesPerTokenHigh;
  const high = hasRange ? runEstimate(models, engineId, { ...inputs, artifact: highArtifact(artifact) }, []) : primary;
  const confidence = primary.confidence === "measured" ? "measured" : artifact.confidence;
  const budgetMb = budgetsFor(gpus, budgetBasis, isPlainObject(options.admissionPolicy) ? options.admissionPolicy : {});
  const ramLimit = ramLimitMb(input.host, budgetBasis, constants);
  if (ramLimit === null && artifact.ramMb.weights + artifact.ramMb.experts + artifact.ramMb.kv > 0) {
    assumptions.push(bilingual("主机内存大小未知，没有检查 CPU 内存是否放得下。", "Host RAM is unknown; whether the CPU-side bytes fit was not checked."));
  }
  // Uncertain layouts (unknown kinds, r = 0, MHA upper bound) grade on the high end.
  const graded = hasRange && artifact.uncertain ? high : primary;
  const grade = gradeEstimate({ estimate: graded, artifact, budgetMb, gpus, values, ramLimit, confidence }, constants);
  const calibration = calibrationFindings({ calibration: inputs.calibration, recipeMemory, primary, artifact, engineId, values, constants });

  // A re-run for a suggestion: the point estimate, or with graded:true the
  // estimate grading would use (the high end for an uncertain layout).
  const evaluate = (vals, { graded: forGrade = false } = {}) => {
    try {
      const changed = build(vals);
      const changedInputs = inputsFor(vals, changed);
      const low = runEstimate(models, engineId, changedInputs, []);
      const range = changed.kvMb.low !== changed.kvMb.high || changed.kvBytesPerToken !== changed.kvBytesPerTokenHigh;
      if (!forGrade || !range || !changed.uncertain) return low;
      return runEstimate(models, engineId, { ...changedInputs, artifact: highArtifact(changed) }, []);
    } catch {
      return null;
    }
  };
  const suggestions = options.suggestions === false ? []
    : suggestionsFor({ engineId, values, base: primary, grade, artifact, gpus, budgetMb, evaluate }, constants);

  return {
    policy: primary.policy,
    perGpuMb: primary.perGpuMb,
    admissionRequestMb: primary.admissionRequestMb ?? null,
    kvPoolTokens: primary.kvPoolTokens ?? null,
    maxFullLengthRequests: primary.maxFullLengthRequests ?? null,
    breakdown: primary.breakdown,
    admissionRequest: primary.admissionRequest ?? null,
    ram: { ...artifact.ramMb },
    kv: { bytesPerToken: artifact.kvBytesPerToken, bytesPerTokenHigh: artifact.kvBytesPerTokenHigh, stateBytesPerSeq: artifact.stateBytesPerSeq },
    layers: artifact.kvLayers,
    range: {
      lowMb: maxOf(primary.perGpuMb) || positive(primary.admissionRequestMb),
      highMb: maxOf(high.perGpuMb) || positive(high.admissionRequestMb),
      ...(hasRange ? { lowKvMb: artifact.kvMb.low, highKvMb: artifact.kvMb.high, maxFullLengthRequestsHigh: high.maxFullLengthRequests ?? null } : {}),
    },
    confidence,
    engineConfidence: primary.confidence ?? null,
    status: grade.status,
    statusReasons: grade.reasons,
    spill: grade.spill,
    budgetBasis,
    budgetMb,
    headroomMb: grade.headroomMb,
    overflowMb: grade.overflowMb,
    suggestions,
    calibration: calibration.block,
    paramsKey: paramsKeyFor(models, engineId, values),
    values,
    artifact,
    notes: Array.isArray(primary.notes) ? primary.notes : [],
    warnings: [...(Array.isArray(primary.warnings) ? primary.warnings : []), ...fallbackWarnings, ...calibration.warnings],
    errors: Array.isArray(primary.errors) ? primary.errors : [],
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// fitGrid (02 §10.8, MOD-9b)
// ---------------------------------------------------------------------------

// 02 §11's context ladder, intersected with the card's native context.
const CONTEXT_LADDER = Object.freeze([524288, 262144, 131072, 65536, 32768, 16384, 8192]);
const GRID_LIMITS = Object.freeze({ kvDtypes: 4, concurrency: 8, contexts: 16, evaluationsPerCell: 12, budgetMs: 2000 });
const GRID_MEMO_MAX = 4000;
const gridMemo = new Map();

function gridError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

/** The ladder for a native context: native first, then the rungs below it, descending. */
function contextLadder(native) {
  const top = count(native);
  const rungs = CONTEXT_LADDER.filter((rung) => !top || rung < top);
  return top ? [top, ...rungs] : [...rungs];
}

function gridKvValues(engineId, dtype) {
  return isLlama(engineId)
    ? { "llamacpp.cacheTypeK": dtype, "llamacpp.cacheTypeV": dtype }
    : { kvCacheDtype: dtype };
}

function limitedByReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (list.includes("engine") && !list.includes("vram")) return "engine";
  if (list.includes("ram")) return "ram";
  if (list.includes("engine")) return "engine";
  return "vram";
}

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * fitGrid(FitInput, { kvDtypes, concurrency, contexts? }, options) -> FitGrid.
 *
 * For every (kvDtype, concurrency) cell a binary search over the context ladder
 * (<= the card's native context) finds the largest contextLength whose status is
 * not "fail"; limitedBy says why the next rung fails (native | vram | ram |
 * engine). With contexts[] the result also carries a matrix. Bounds: <= 4 kv
 * dtypes x <= 8 concurrency values, <= 12 evaluations per cell, a 2 s budget
 * (cells cut short carry truncated:true). Side-effect free; evaluations are
 * memoized per (cardId, engineId, runtimeId, paramsKey) plus a digest of the
 * remaining inputs, so a repeated grid costs no estimate calls.
 *
 * options: estimateFit's options plus { now() -> ms, budgetMs, memo (a Map) }.
 */
function fitGrid(fitInput = {}, grid = {}, options = {}) {
  const input = isPlainObject(fitInput) ? fitInput : {};
  const card = isPlainObject(input.card) ? input.card : null;
  if (!card) throw Object.assign(new Error("A fit grid needs a model card."), { code: "fit_input_invalid", status: 400 });
  const engineId = String(input.engineId || "");
  const defaults = isLlama(engineId) ? ["f16", "q8_0"] : ["auto", "fp8"];
  const kvDtypes = [...new Set((Array.isArray(grid.kvDtypes) && grid.kvDtypes.length ? grid.kvDtypes : defaults).map(String))];
  const concurrencies = [...new Set((Array.isArray(grid.concurrency) && grid.concurrency.length ? grid.concurrency : [1, 2, 4, 8])
    .map((item) => Math.floor(Number(item))))];
  const contexts = Array.isArray(grid.contexts)
    ? [...new Set(grid.contexts.map((item) => Math.floor(Number(item))))]
    : [];
  if (kvDtypes.length > GRID_LIMITS.kvDtypes || concurrencies.length > GRID_LIMITS.concurrency || contexts.length > GRID_LIMITS.contexts) {
    throw gridError("grid_too_large", `A fit grid takes at most ${GRID_LIMITS.kvDtypes} KV dtypes, ${GRID_LIMITS.concurrency} concurrency values and ${GRID_LIMITS.contexts} contexts.`);
  }
  if (concurrencies.some((item) => !(item >= 1)) || contexts.some((item) => !(item >= 1))) {
    throw gridError("invalid_value", "Concurrency and contexts are positive integers.");
  }

  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : GRID_LIMITS.budgetMs;
  const memo = options.memo instanceof Map ? options.memo : gridMemo;
  const started = now();
  const expired = () => now() - started >= budgetMs;
  const models = options.memoryModels || defaultMemoryModels();
  const native = count(card.context?.native) || null;
  const ladder = contextLadder(native);
  const baseValues = plainValues(input.values);
  const stats = { evaluations: 0, memoHits: 0 };

  const hostKey = stableString({
    gpus: normalizeHostGpus(input.host?.gpus),
    ramFreeBytes: input.host?.ramFreeBytes ?? null,
    gpuIds: input.gpuIds ?? null,
    basis: input.budgetBasis ?? null,
    mode: input.instanceMode ?? null,
    recipe: input.recipeMemory ?? null,
    constants: options.fitConstants ?? null,
  });
  const evaluate = (contextLength, concurrency, dtype) => {
    const values = { ...baseValues, ...gridKvValues(engineId, dtype), contextLength, concurrency };
    let key = null;
    try {
      const rest = { ...values };
      for (const id of ["contextLength", "concurrency", "kvCacheDtype", "llamacpp.cacheTypeK", "llamacpp.cacheTypeV", "sglang.maxTotalTokens"]) delete rest[id];
      key = `${card.cardId || ""}|${card.contentDigest || ""}|${engineId}|${input.runtimeId || ""}|${paramsKeyFor(models, engineId, values)}|${stableString(rest)}|${hostKey}`;
    } catch {
      key = null;
    }
    if (key && memo.has(key)) {
      stats.memoHits += 1;
      const hit = memo.get(key);
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
    stats.evaluations += 1;
    const fitResult = estimateFit({ ...input, values }, { ...options, suggestions: false });
    const slim = Object.freeze({
      status: fitResult.status,
      spill: fitResult.spill,
      perGpuMb: fitResult.perGpuMb,
      reasons: fitResult.statusReasons || [],
    });
    if (key) {
      memo.set(key, slim);
      while (memo.size > GRID_MEMO_MAX) memo.delete(memo.keys().next().value);
    }
    return slim;
  };

  const cells = [];
  let truncatedAny = false;
  for (const dtype of kvDtypes) {
    for (const concurrency of concurrencies) {
      // The ladder is descending. Memory grows with context, so rung i passing
      // means every later (smaller) rung passes: binary search for the first
      // (largest) passing index; ladder.length stands for "nothing passes".
      let evaluations = 0;
      let truncated = false;
      const known = new Map();
      const probe = (index) => {
        if (known.has(index)) return known.get(index);
        if (evaluations >= GRID_LIMITS.evaluationsPerCell || expired()) {
          truncated = true;
          return null;
        }
        evaluations += 1;
        const result = evaluate(ladder[index], concurrency, dtype);
        known.set(index, result);
        return result;
      };
      let lo = 0;
      let hi = ladder.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const result = probe(mid);
        if (!result) break;
        if (result.status === "fail") lo = mid + 1;
        else hi = mid;
      }
      let best = null;
      for (const [index, result] of known) {
        if (result.status !== "fail" && (best === null || index < best)) best = index;
      }
      const chosen = best === null ? null : known.get(best);
      let limitedBy = "native";
      if (best === null) {
        const lowest = known.get(ladder.length - 1) || [...known.values()].pop();
        limitedBy = lowest ? limitedByReasons(lowest.reasons) : "vram";
      } else if (best > 0) {
        limitedBy = known.has(best - 1) ? limitedByReasons(known.get(best - 1).reasons) : "vram";
      }
      if (truncated) truncatedAny = true;
      cells.push({
        kvDtype: dtype,
        concurrency,
        maxContext: best === null ? 0 : ladder[best],
        limitedBy,
        status: chosen ? chosen.status : "fail",
        spill: chosen ? chosen.spill : false,
        ...(truncated ? { truncated: true } : {}),
      });
    }
  }

  let matrix;
  if (contexts.length) {
    matrix = [];
    for (const dtype of kvDtypes) {
      for (const concurrency of concurrencies) {
        for (const contextLength of contexts) {
          if (expired()) {
            truncatedAny = true;
            matrix.push({ contextLength, concurrency, kvDtype: dtype, status: null, spill: null, perGpuMb: null, truncated: true });
            continue;
          }
          const result = evaluate(contextLength, concurrency, dtype);
          matrix.push({ contextLength, concurrency, kvDtype: dtype, status: result.status, spill: result.spill, perGpuMb: result.perGpuMb });
        }
      }
    }
  }

  return {
    ok: true,
    cardId: card.cardId || null,
    engineId,
    runtimeId: input.runtimeId || null,
    native,
    ladder,
    cells,
    ...(matrix ? { matrix } : {}),
    ...(truncatedAny ? { truncated: true } : {}),
    durationMs: Math.max(0, Math.round(now() - started)),
    stats,
  };
}

fitGrid.clearMemo = () => gridMemo.clear();
fitGrid.LIMITS = GRID_LIMITS;

// ---------------------------------------------------------------------------
// FitResult schema (00 §4.3 memory as amended by §9.1, plus 02 grading)
// ---------------------------------------------------------------------------

const mbMap = { type: "object", additionalProperties: { type: "number" } };
const i18n = { type: "object", required: ["zh", "en"], properties: { zh: { type: "string" }, en: { type: "string" } } };

const FIT_RESULT_SCHEMA = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["policy", "perGpuMb", "breakdown", "admissionRequest", "ram", "kv", "layers", "range", "confidence", "status", "spill", "budgetMb", "suggestions", "calibration", "assumptions"],
  properties: {
    policy: { enum: [...MEMORY_POLICIES] },
    perGpuMb: mbMap,
    admissionRequestMb: { type: ["number", "null"] },
    kvPoolTokens: { type: ["number", "null"] },
    maxFullLengthRequests: { type: ["number", "null"] },
    breakdown: {
      type: "object",
      required: ["weights", "kv", "activations", "draft", "mmproj", "overhead"],
      additionalProperties: { type: "number" },
    },
    admissionRequest: { type: ["object", "null"] },
    ram: { type: "object", required: ["weights", "experts", "kv"], additionalProperties: { type: "number" } },
    kv: { type: "object", required: ["bytesPerToken", "bytesPerTokenHigh", "stateBytesPerSeq"] },
    layers: { type: "array", items: { type: "object", required: ["kind", "count"] } },
    range: { type: "object", required: ["lowMb", "highMb"], properties: { lowMb: { type: "number" }, highMb: { type: "number" } } },
    confidence: { enum: [...FIT_CONFIDENCES] },
    status: { enum: [...FIT_STATUSES] },
    spill: { type: "boolean" },
    budgetBasis: { enum: [...BUDGET_BASES] },
    budgetMb: mbMap,
    headroomMb: { type: ["number", "null"] },
    overflowMb: { type: "number" },
    suggestions: {
      type: "array",
      items: { type: "object", required: ["code", "param", "to", "deltaMb", "message"], properties: { message: i18n, deltaMb: { type: "number" } } },
    },
    calibration: {
      type: "object",
      required: ["applied", "samples", "source", "driftRatio"],
      properties: { applied: { type: "boolean" }, samples: { type: "number" }, source: { enum: [null, "exact", "recipe"] }, driftRatio: { type: ["number", "null"] } },
    },
    assumptions: { type: "array", items: i18n },
  },
});

/** validateFitResult(result) -> { ok, errors[] } against FIT_RESULT_SCHEMA. */
function validateFitResult(result) {
  return validate(FIT_RESULT_SCHEMA, result, { maxErrors: 20 });
}

// ---------------------------------------------------------------------------
// Legacy /api/memory-estimate path (02 §10.7)
// ---------------------------------------------------------------------------

/**
 * legacyEstimate(input, { engineId }) -> the legacy plan of a body without a
 * model card, exactly as P0-RT-3 and ENG-12 leave it: llama.cpp bodies go to
 * estimateLlamaMemoryPlan, every other engine to estimateVllmMemoryPlan.
 * input is the normalized plan input the manager wrappers build.
 */
function legacyEstimate(input = {}, options = {}) {
  const engineId = String(options.engineId || options.engine || input?.engineId || input?.engine || "");
  return isLlama(engineId)
    ? memoryEstimator.estimateLlamaMemoryPlan(input)
    : memoryEstimator.estimateVllmMemoryPlan(input);
}

module.exports = {
  ARTIFACT_SCHEMA_ID,
  FIT_CONSTANTS,
  FIT_RESULT_SCHEMA,
  FIT_CONFIDENCES,
  FIT_STATUSES,
  KV_LAYOUTS,
  MEMORY_POLICIES,
  WEIGHT_CLASSES,
  artifactMemoryInputs,
  estimateFit,
  fitConstantsFromConfig,
  fitGrid,
  fitMemoryInputs,
  kvBytes,
  legacyEstimate,
  normalizeFitValues,
  normalizeHostGpus,
  resolveFitConstants,
  validateFitResult,
};
