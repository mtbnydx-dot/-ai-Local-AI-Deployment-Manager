"use strict";

// Launch planner (docs/overhaul/02-models.md §11, MOD-14): ranked launch plans
// for a ModelCard on this host, per GPU set and goal. The planner searches only
// parameter ids present in each engine's catalog (01 catalog ids are canonical,
// 00 §9.10), grades every candidate with fit.estimateFit on an idle GPU
// (budgetBasis "empty-gpu"), keeps the ones with at least 5 % headroom whose
// host-RAM use stays below ramFree - ramReserve, and returns up to three
// diversified plans per GPU set: the best plan of each engine, then the best
// alternative trade-off on the winning engine.
//
//   planLaunches({card, host, goal, gpuSets, rows, catalogs, recipes, constraints}, options)
//     -> GpuSetPlans[] = [{ gpuIds, goal, plans: Plan[], notes: [{zh, en}], evaluations }]
//
// Every plan `values` entry is {value, source: "planner", reason?}; parameters a
// matched recipe sets or locks are left to the recipe (plan.recipeId) and never
// repeated in `values`. The only engine knowledge here is which catalog ids are
// offload and KV-dtype knobs, keyed by engineId like fit.js's KV layouts; model
// knowledge (speculative methods) comes from the family data (D5).

const fitModule = require("./fit");
const knowledgeModule = require("./knowledge");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const GOALS = Object.freeze(["max-context", "balanced", "throughput", "low-vram"]);
// 02 §11's context ladder; the card's native context is prepended when it is not a rung.
const CONTEXT_LADDER = Object.freeze([524288, 262144, 131072, 65536, 32768, 16384, 8192]);
const GOAL_CONCURRENCY = Object.freeze({
  "max-context": Object.freeze([1]),
  balanced: Object.freeze([4]),
  throughput: Object.freeze([16, 32]),
  "low-vram": Object.freeze([1]),
});
const PLANNER_CONSTANTS = Object.freeze({
  headroomRatio: 0.05,
  ramReserveGb: 16,
  balancedContext: 65536,
  throughputContext: 32768,
  lowVramContext: 8192,
  maxPlansPerSet: 3,
  // Offloaded bytes compare in buckets so a few MiB of rounding never decide a rank.
  offloadBucketMb: 256,
  maxEvaluations: 4000,
});

// KV cache dtype tiers, higher precision first (02 §11).
const KV_TIERS = Object.freeze([
  Object.freeze(["auto", "f16", "bf16"]),
  Object.freeze(["fp8", "q8_0", "fp8_e4m3", "fp8_e5m2"]),
  Object.freeze(["q4_0"]),
]);
const KV_PARAMS = Object.freeze({
  llamacpp: Object.freeze(["llamacpp.cacheTypeK", "llamacpp.cacheTypeV"]),
  default: Object.freeze(["kvCacheDtype"]),
});
// Offload knobs per engine, in the order they are tried (02 §11).
const OFFLOAD_KINDS = Object.freeze({
  llamacpp: Object.freeze([
    Object.freeze({ kind: "moe", param: "llamacpp.nCpuMoe" }),
    Object.freeze({ kind: "layers", param: "llamacpp.gpuLayers" }),
  ]),
  vllm: Object.freeze([Object.freeze({ kind: "cpu-offload", param: "vllm.cpuOffloadGb" })]),
  sglang: Object.freeze([Object.freeze({ kind: "ple", param: "sglang.pleOffloadEmbedding" })]),
});
const TENSOR_PARALLEL_ENGINES = Object.freeze(new Set(["vllm", "sglang"]));
// Speculative methods the planner can switch on by itself: the model's own MTP
// heads (needs packaged MTP tensors) and n-gram lookup. Draft-model methods need
// a draft the planner does not pick.
const MTP_METHODS = Object.freeze(new Set(["mtp", "nextn", "qwen3_next_mtp", "draft-mtp"]));
// Compatibility reasons about fit: the planner grades fit itself.
const FIT_REASON_CODES = Object.freeze(new Set(["fits_with_offload", "does_not_fit", "context_exceeds_native"]));
const ENGINE_LABELS = Object.freeze({ vllm: "vLLM", sglang: "SGLang", llamacpp: "llama.cpp" });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function bilingual(zh, en) {
  return { zh, en };
}

function joined(text) {
  return `${text.zh} / ${text.en}`;
}

function plannerError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function contextLabel(tokens) {
  if (tokens >= 1048576 && tokens % 1048576 === 0) return `${tokens / 1048576}M`;
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`;
  return String(tokens);
}

function gib(mb) {
  return Math.round((mb / 1024) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A catalog (compiled 01 catalog with byId, or a GET /schema payload) -> {has, choices, compiled}. */
function catalogView(engineId, catalogs) {
  let catalog = null;
  if (catalogs instanceof Map) catalog = catalogs.get(engineId) || null;
  else if (isPlainObject(catalogs) && Object.hasOwn(catalogs, engineId)) catalog = catalogs[engineId];
  else {
    try {
      catalog = require("../engines/param-catalog").loadCatalog(engineId);
    } catch {
      catalog = null;
    }
  }
  if (!isPlainObject(catalog)) return null;
  const params = new Map();
  if (catalog.byId instanceof Map) for (const [id, param] of catalog.byId) params.set(id, param);
  else for (const param of Array.isArray(catalog.params) ? catalog.params : []) if (param?.id) params.set(param.id, param);
  if (!params.size) return null;
  return {
    compiled: catalog.byId instanceof Map ? catalog : null,
    has: (id) => params.has(id),
    choices: (id) => {
      const list = params.get(id)?.choices;
      return Array.isArray(list) ? list.map((item) => (isPlainObject(item) ? item.value : item)).map(String) : null;
    },
  };
}

function descriptorMap(descriptors) {
  const list = Array.isArray(descriptors) ? descriptors
    : descriptors instanceof Map ? [...descriptors.values()]
      : isPlainObject(descriptors) ? Object.entries(descriptors).map(([id, descriptor]) => ({ id, ...descriptor }))
        : null;
  if (list) return new Map(list.filter((item) => isPlainObject(item) && item.id).map((item) => [item.id, item]));
  try {
    return new Map(require("../engines/registry").getEngineRegistry().list().map((item) => [item.id, item]));
  } catch {
    return new Map();
  }
}

function normalizeHostGpus(host) {
  return (Array.isArray(host?.gpus) ? host.gpus : [])
    .map((gpu, index) => ({ ...gpu, id: String(gpu?.id ?? gpu?.index ?? index) }))
    .filter((gpu) => positive(gpu.totalMb) > 0);
}

function gpuSetsFor(gpus, requested, notes) {
  const ids = gpus.map((gpu) => gpu.id);
  if (Array.isArray(requested) && requested.length) {
    const sets = [];
    for (const set of requested) {
      const list = [...new Set((Array.isArray(set) ? set : [set]).map(String))];
      const unknown = list.filter((id) => !ids.includes(id));
      if (unknown.length || !list.length) {
        notes.push(bilingual(`GPU 组 [${list.join(", ")}] 中有本机没有的 GPU，已跳过。`, `GPU set [${list.join(", ")}] names GPUs this host does not have; skipped.`));
        continue;
      }
      sets.push(list);
    }
    return sets;
  }
  const sets = ids.map((id) => [id]);
  if (ids.length > 1) sets.push([...ids]);
  return sets;
}

function ramLimitMb(host, reserveGb) {
  const bytes = positive(host?.ramFreeBytes) || positive(host?.ramBytes);
  if (!bytes) return null;
  return bytes / MIB - reserveGb * 1024;
}

function quantMatches(card, pattern) {
  const tokens = String(pattern || "").toLowerCase().split("|").map((item) => item.trim()).filter(Boolean);
  const quant = [card?.quant?.method, card?.quant?.algo].filter(Boolean).map((item) => String(item).toLowerCase());
  return tokens.some((token) => quant.includes(token));
}

function nameHeuristic(card, match) {
  if (match?.confidence === "name-heuristic") return true;
  return (Array.isArray(card?.evidence) ? card.evidence : []).some((item) => item?.confidence === "name-heuristic");
}

/** The speculative method the family data enables for this engine, or null (02 §11). */
function speculativeFor(engineId, card, match, view) {
  const family = match?.entry;
  if (!family || match.confidence === "name-heuristic" || !isPlainObject(family.speculative)) return null;
  const spec = family.speculative;
  const byEngine = isPlainObject(spec.byEngine?.[engineId]) ? spec.byEngine[engineId] : {};
  const method = byEngine.auto ?? spec.auto?.[engineId] ?? null;
  if (!method || method === "off" || method === "none") return null;
  if (quantMatches(card, byEngine.autoOffForQuant ?? spec.autoOffForQuant)) return null;
  if (!view.has("speculative.method") || !(view.choices("speculative.method") || []).includes(method)) return null;
  const nativeMtp = card?.speculative?.nativeMtp === true || positive(card?.weights?.byClass?.mtp) > 0;
  if (MTP_METHODS.has(method)) {
    if (!nativeMtp) return null;
  } else if (!/^ngram/.test(method)) {
    return null;
  }
  const reason = byEngine.reason || spec.reason || null;
  return { method, reason: typeof reason === "string" ? reason : reason?.en || null };
}

function kvOptions(engineId, view) {
  const params = KV_PARAMS[engineId] || KV_PARAMS.default;
  if (!params.every((id) => view.has(id))) return { params, options: [] };
  const choices = view.choices(params[0]);
  const options = [];
  KV_TIERS.forEach((tier, index) => {
    const dtype = choices ? tier.find((item) => choices.includes(item)) : tier[0];
    if (dtype) options.push({ tier: index, dtype });
  });
  return { params, options };
}

function kvValues(params, dtype) {
  return Object.fromEntries(params.map((id) => [id, dtype]));
}

function expertLayers(card) {
  const listed = Array.isArray(card?.weights?.expertsByLayer) ? card.weights.expertsByLayer
    : Array.isArray(card?.topology?.moe?.expertBytesPerLayer) ? card.topology.moe.expertBytesPerLayer : null;
  if (listed && listed.some((bytes) => positive(bytes) > 0)) return listed.length;
  return positive(card?.weights?.byClass?.experts) > 0 ? Math.floor(positive(card?.topology?.layers)) : 0;
}

function ladderFor(native, minContext) {
  const top = Math.floor(positive(native));
  const rungs = CONTEXT_LADDER.filter((rung) => !top || rung < top);
  return (top ? [top, ...rungs] : [...rungs]).filter((rung) => rung >= minContext);
}

// ---------------------------------------------------------------------------
// Candidate rows
// ---------------------------------------------------------------------------

const VERDICT_RANK = Object.freeze({ ok: 0, warn: 1, unknown: 2 });

function rowPenalty(row, descriptor, card, heuristic) {
  const reasons = Array.isArray(row?.reasons) ? row.reasons : [];
  let points = 0;
  const unknownSupport = row.verdict === "unknown" || reasons.some((reason) => reason?.level === "unknown")
    || !(Array.isArray(row?.supportEvidence) && row.supportEvidence.length);
  if (unknownSupport) points += 2;
  points += reasons.filter((reason) => reason?.level === "warn" && !FIT_REASON_CODES.has(reason.code)).length;
  if (heuristic) points += 1;
  // The engine's first artifact format is its native one (GGUF on llama.cpp).
  const formats = Array.isArray(descriptor?.artifactFormats) ? descriptor.artifactFormats : [];
  const kind = card?.format?.kind;
  if (kind && formats.length && formats[0] !== kind) points += 2;
  return { points, requiresProbe: unknownSupport };
}

/** The best compatibility row per engine (verdict, then not retired, then input order). */
function bestRows(rows, constraints, notes) {
  const allowed = Array.isArray(constraints.engines) && constraints.engines.length ? new Set(constraints.engines.map(String)) : null;
  const byEngine = new Map();
  let skippedUnknown = 0;
  rows.forEach((row, index) => {
    if (!isPlainObject(row) || !row.engineId || row.engineId === "external") return;
    if (allowed && !allowed.has(row.engineId)) return;
    if (row.verdict === "unknown" && !constraints.includeUnverified) {
      skippedUnknown += 1;
      return;
    }
    if (!Object.hasOwn(VERDICT_RANK, row.verdict)) return;
    const retired = (row.reasons || []).some((reason) => reason?.code === "runtime_retired") ? 1 : 0;
    const key = [VERDICT_RANK[row.verdict], retired, index];
    const list = byEngine.get(row.engineId) || [];
    list.push({ row, key });
    byEngine.set(row.engineId, list);
  });
  if (skippedUnknown) {
    notes.push(bilingual(
      `${skippedUnknown} 个兼容性未验证的引擎/运行时没有参与规划；打开“包含未验证”可以纳入（需要先运行预检探针）。`,
      `${skippedUnknown} engine/runtime rows with unverified support were left out; enable "include unverified" to plan them (they need a dry probe first).`));
  }
  const out = new Map();
  for (const [engineId, list] of byEngine) {
    list.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    out.set(engineId, list.map((item) => item.row));
  }
  return out;
}

function recipeStoreOf(recipes) {
  if (recipes && typeof recipes.list === "function") return recipes;
  if (Array.isArray(recipes)) {
    const list = recipes.map((item) => (isPlainObject(item?.recipe) ? item.recipe : item)).filter((item) => isPlainObject(item) && item.id);
    return {
      list: (filter = {}) => list.filter((recipe) => (!filter.kind || (recipe.kind || "model") === filter.kind)
        && (!filter.engineId || recipe.engineId === filter.engineId)),
    };
  }
  return null;
}

function recipeCandidates({ engineId, rows, card, familyId, hostFacts, store, notes }) {
  let recipesModule;
  try {
    recipesModule = require("../engines/recipes");
  } catch {
    return [];
  }
  const out = [];
  const model = { contentDigest: card.contentDigest || null, familyId: familyId || null, quantMethod: card.quant?.method || null };
  const seen = new Set();
  for (const row of rows) {
    let matches = [];
    try {
      matches = recipesModule.matchRecipes({ engineId, model, hostFacts, runtime: { runtimeId: row.runtimeId, manifestKey: row.manifestKey ?? null } },
        store || recipesModule.getRecipeStore());
    } catch {
      matches = [];
    }
    for (const match of matches) {
      const recipe = match.recipe;
      if (!match.eligible || seen.has(recipe.id)) continue;
      if (recipe.match?.runtimeId !== undefined && recipe.match.runtimeId !== row.runtimeId) continue;
      let applied;
      try {
        applied = recipesModule.applyRecipe(recipe, {}, { hostFacts, model, runtime: { runtimeId: row.runtimeId } });
      } catch {
        continue;
      }
      seen.add(recipe.id);
      if (applied.blocks?.length) {
        notes.push(bilingual(`方案 ${recipe.id} 在本机被阻止，没有使用。`, `Recipe ${recipe.id} is blocked on this host and was not used.`));
        continue;
      }
      out.push({ row, recipe, applied });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function offloadParamsFor(engineId, view, card) {
  const moeLayers = expertLayers(card);
  const layers = Math.floor(positive(card?.topology?.layers));
  const kinds = [];
  const missing = [];
  for (const item of OFFLOAD_KINDS[engineId] || []) {
    if (!view.has(item.param)) {
      missing.push(item.param);
      continue;
    }
    if (item.kind === "moe" && !moeLayers) continue;
    if (item.kind === "layers" && !layers) continue;
    if (item.kind === "ple" && !(positive(card?.weights?.byClass?.ple) > 0)) continue;
    if (item.kind === "cpu-offload" && !positive(card?.weights?.totalBytes)) continue;
    kinds.push({ ...item, max: item.kind === "moe" ? moeLayers : item.kind === "layers" ? layers : null });
  }
  return { kinds, missing, moeLayers, layers };
}

/** Plain values that express one offload choice (amount: layers, GiB or true). */
function offloadValues(engineId, view, card, offload, tensorParallel) {
  const values = {};
  const moeLayers = expertLayers(card);
  if (engineId === "llamacpp") {
    if (moeLayers && view.has("llamacpp.nCpuMoe")) values["llamacpp.nCpuMoe"] = 0;
    if (view.has("llamacpp.gpuLayers")) values["llamacpp.gpuLayers"] = "all";
    if (offload?.kind === "moe") values["llamacpp.nCpuMoe"] = offload.amount;
    if (offload?.kind === "layers") {
      if (moeLayers && view.has("llamacpp.nCpuMoe")) values["llamacpp.nCpuMoe"] = moeLayers;
      values["llamacpp.gpuLayers"] = offload.amount;
    }
  } else if (engineId === "vllm") {
    if (view.has("vllm.cpuOffloadGb")) values["vllm.cpuOffloadGb"] = offload?.kind === "cpu-offload" ? offload.amount : 0;
  } else if (engineId === "sglang") {
    if (positive(card?.weights?.byClass?.ple) > 0 && view.has("sglang.pleOffloadEmbedding")) {
      values["sglang.pleOffloadEmbedding"] = offload?.kind === "ple";
    }
  }
  if (tensorParallel > 1) values.tensorParallel = tensorParallel;
  return values;
}

/**
 * Feasibility of one estimate (02 §11): status not fail, headroom >= 5 % of the
 * budget, host RAM use <= ramFree - ramReserve. gpuOk is the GPU side alone:
 * it only improves with more offload while the RAM side only gets worse, so
 * the offload searches bisect on gpuOk and then check RAM once.
 */
function judge(fit, ramLimit, constants, { fullConcurrency = false } = {}) {
  if (!fit) return { ok: false, gpuOk: false, why: ["error"] };
  const reasons = Array.isArray(fit.statusReasons) ? fit.statusReasons : [];
  const why = [];
  if (fit.status === "fail" && (reasons.includes("vram") || reasons.includes("engine") || !reasons.includes("ram"))) why.push("gpu");
  // Headroom of the graded estimate (the high end for uncertain layouts) against
  // the smallest budget of the set.
  const budgets = Object.values(fit.budgetMb || {}).map(Number).filter(Number.isFinite);
  if (budgets.length && Number.isFinite(fit.headroomMb) && fit.headroomMb < constants.headroomRatio * Math.min(...budgets)) why.push("headroom");
  if (fullConcurrency && reasons.includes("kv_below_concurrency")) why.push("kv_below_concurrency");
  const gpuOk = !why.length;
  if (fit.status === "fail" && reasons.includes("ram")) why.push("ram");
  if (ramLimit !== null && ramUsedMb(fit) > ramLimit) why.push("ram_reserve");
  return { ok: !why.length, gpuOk, why };
}

function ramUsedMb(fit) {
  const ram = fit?.ram || {};
  return positive(ram.weights) + positive(ram.experts) + positive(ram.kv);
}

function offloadedMb(fit) {
  return Math.max(0, ramUsedMb(fit) - positive(fit?.artifact?.offload?.fixedRamMb));
}

/**
 * Searches one engine (and optional recipe) on one GPU set. Returns candidate
 * results {values, plannerIds, fit, contextLength, concurrency, kv, offload,
 * spec, meetsTarget} for every (kv dtype, concurrency, speculative) choice.
 */
function searchEngine(ctx) {
  const { engineId, view, card, goal, constraints, constants, evaluate, recipeApplied, gpuIds, notes } = ctx;
  const locked = new Set((recipeApplied?.locks || []).map((lock) => lock.param));
  const recipeValues = recipeApplied ? { ...recipeApplied.values } : {};
  const fixedByRecipe = (id) => recipeApplied && (locked.has(id) || Object.hasOwn(recipeValues, id));
  const results = [];
  if (!view.has("contextLength")) {
    notes.push(bilingual(`${engineId} 的参数目录没有 contextLength，无法为它规划。`, `The ${engineId} catalog has no contextLength; it cannot be planned.`));
    return results;
  }

  const ladder = ladderFor(card?.context?.native, constraints.minContext);
  if (!ladder.length) {
    notes.push(bilingual(`没有不小于 ${constraints.minContext} 且不超过原生上下文的上下文档位。`, `No context rung is at least ${constraints.minContext} and within the native context.`));
    return results;
  }
  const native = ladder[0];
  const searchContext = !locked.has("contextLength");
  const searchConcurrency = view.has("concurrency") && !locked.has("concurrency");
  const concurrencies = !searchConcurrency ? [Math.floor(positive(recipeValues.concurrency)) || null]
    : positive(constraints.concurrency) ? [Math.floor(positive(constraints.concurrency))] : GOAL_CONCURRENCY[goal];

  // KV dtypes: the recipe's own (or locked) choice, else the catalog tiers.
  const kv = kvOptions(engineId, view);
  let kvList = kv.options;
  if (kv.params.some((id) => fixedByRecipe(id))) kvList = [{ tier: null, dtype: null, fixed: true }];
  if (!kvList.length) {
    notes.push(bilingual(`${engineId} 的参数目录没有 KV 缓存精度参数，按默认值规划。`, `The ${engineId} catalog has no KV cache dtype parameter; the default is used.`));
    kvList = [{ tier: null, dtype: null, fixed: true }];
  }

  // Offload: only knobs the catalog has and the recipe leaves open.
  const offload = offloadParamsFor(engineId, view, card);
  if (offload.missing.length) {
    notes.push(bilingual(
      `${engineId} 的参数目录缺少 ${offload.missing.join("、")}，相应的卸载策略已移除。`,
      `The ${engineId} catalog lacks ${offload.missing.join(", ")}; that offload strategy was removed.`));
  }
  // Throughput ranks offload last instead of excluding it.
  const allowOffload = constraints.allowCpuOffload !== false;
  const offloadKinds = allowOffload ? offload.kinds.filter((item) => !fixedByRecipe(item.param)) : [];
  const tensorParallel = TENSOR_PARALLEL_ENGINES.has(engineId) && gpuIds.length > 1 && view.has("tensorParallel") && !fixedByRecipe("tensorParallel")
    ? gpuIds.length : 1;

  // Speculative decoding: considered for balanced and throughput; the
  // memory-first goals keep it off.
  const spec = fixedByRecipe("speculative.method") ? null : speculativeFor(engineId, card, ctx.match, view);
  const specList = !spec ? [null] : goal === "balanced" || goal === "throughput" ? [spec.method, "off"] : ["off"];

  for (const kvChoice of kvList) {
    for (const concurrency of concurrencies) {
      for (const specMethod of specList) {
        const base = {};
        if (kvChoice.dtype) Object.assign(base, kvValues(kv.params, kvChoice.dtype));
        if (concurrency && searchConcurrency) base.concurrency = concurrency;
        if (specMethod) base["speculative.method"] = specMethod;
        const valuesFor = (contextLength, choice) => {
          const planner = { ...base, ...offloadValues(engineId, view, card, choice, tensorParallel) };
          if (searchContext) planner.contextLength = contextLength;
          for (const id of Object.keys(planner)) if (fixedByRecipe(id)) delete planner[id];
          const full = { ...recipeValues, ...planner };
          for (const lock of recipeApplied?.locks || []) full[lock.param] = lock.value;
          return { planner, full };
        };
        const tryAt = (contextLength, choice) => {
          const { planner, full } = valuesFor(contextLength, choice);
          const fit = evaluate(full);
          return { planner, full, fit, verdict: judge(fit, ctx.ramLimit, constants, { fullConcurrency: goal === "balanced" }), contextLength, offload: choice };
        };

        // The smallest offload that fits at a context: none, then each knob in
        // order. More offload only helps the GPU side and only costs host RAM,
        // so each knob bisects for the least offload whose GPU side fits and
        // then checks RAM at that point (any more offload would use more RAM).
        const bisect = (contextLength, kind, lo, hi, amountFor) => {
          const most = tryAt(contextLength, { kind, amount: amountFor(hi) });
          if (!most.verdict.gpuOk) return null;
          let best = most;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const result = tryAt(contextLength, { kind, amount: amountFor(mid) });
            if (result.verdict.gpuOk) {
              best = result;
              hi = mid;
            } else lo = mid + 1;
          }
          return best.verdict.ok ? best : null;
        };
        const minOffloadAt = (contextLength) => {
          const none = tryAt(contextLength, null);
          if (none.verdict.ok) return none;
          // A GPU-side fit that fails on RAM cannot improve with more offload.
          if (!none.verdict.gpuOk) {
            for (const item of offloadKinds) {
              let found = null;
              if (item.kind === "ple") {
                const result = tryAt(contextLength, { kind: "ple", amount: true });
                found = result.verdict.ok ? result : null;
              } else if (item.kind === "moe") {
                found = bisect(contextLength, "moe", 1, item.max, (step) => step);
              } else if (item.kind === "layers") {
                // Steps count layers moved off the GPU: the most layers that still fit stay on it.
                found = bisect(contextLength, "layers", 1, item.max, (step) => item.max - step);
              } else if (item.kind === "cpu-offload") {
                const maxGb = Math.max(1, Math.ceil(positive(card.weights.totalBytes) / Math.max(1, tensorParallel) / GIB));
                found = bisect(contextLength, "cpu-offload", 1, maxGb, (step) => step);
              }
              if (found) return found;
            }
          }
          return null;
        };

        const push = (result, meetsTarget) => {
          if (!result) return;
          results.push({
            ...result,
            concurrency: concurrency || Math.floor(positive(result.full.concurrency)) || 1,
            kv: kvChoice,
            spec: specMethod && specMethod !== "off" ? specMethod : null,
            specReason: spec?.reason || null,
            meetsTarget,
          });
        };

        if (!searchContext) {
          push(minOffloadAt(Math.floor(positive(recipeValues.contextLength)) || native), true);
          continue;
        }
        if (goal === "max-context") {
          // The largest rung that fits with any allowed offload, plus the largest
          // without offload as an alternative trade-off.
          let found = null;
          for (const rung of ladder) {
            found = minOffloadAt(rung);
            if (found) break;
          }
          push(found, true);
          if (found?.offload) {
            for (const rung of ladder) {
              if (rung >= found.contextLength) continue;
              const plain = tryAt(rung, null);
              if (plain.verdict.ok) {
                push(plain, true);
                break;
              }
            }
          }
          continue;
        }
        const target = Math.min(native, Math.max(constraints.minContext,
          goal === "balanced" ? constants.balancedContext : goal === "throughput" ? constants.throughputContext : constants.lowVramContext));
        const targetRung = ladder.find((rung) => rung <= target) ?? ladder[ladder.length - 1];
        let result = minOffloadAt(targetRung);
        if (result) {
          if (goal === "balanced") {
            // Extend the context while the same offload still fits.
            const above = ladder.filter((rung) => rung > targetRung).reverse();
            for (const rung of above) {
              const bigger = tryAt(rung, result.offload);
              if (!bigger.verdict.ok) break;
              result = bigger;
            }
          }
          push(result, true);
          continue;
        }
        for (const rung of ladder.filter((item) => item < targetRung)) {
          const lower = minOffloadAt(rung);
          if (lower) {
            push(lower, false);
            break;
          }
        }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Ranking, diversification and plan objects
// ---------------------------------------------------------------------------

function admissionMb(fit) {
  const request = Number(fit?.admissionRequestMb);
  if (Number.isFinite(request) && request > 0) return request;
  return Math.max(0, ...Object.values(fit?.perGpuMb || {}).map(Number).filter(Number.isFinite));
}

/** Sort key per goal; lower sorts first. */
function scoreKey(candidate, goal, constants) {
  const offload = Math.round(offloadedMb(candidate.fit) / constants.offloadBucketMb);
  const kvTier = candidate.kv.tier ?? 0;
  const spec = candidate.spec ? 1 : 0;
  const head = [candidate.meetsTarget ? 0 : 1, candidate.penalty];
  if (goal === "max-context") return [...head, -candidate.contextLength, offload, kvTier, spec];
  if (goal === "balanced") return [...head, offload, kvTier, -candidate.contextLength, -spec];
  if (goal === "throughput") {
    const full = Number(candidate.fit.maxFullLengthRequests);
    const requests = Number.isFinite(full) && full > 0 ? full : candidate.concurrency;
    return [...head, offload > 0 ? 1 : 0, -Math.min(requests, candidate.concurrency), -spec, -requests, kvTier];
  }
  return [...head, offload, Math.round(admissionMb(candidate.fit)), kvTier];
}

function compareKeys(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

function signature(candidate) {
  return stableString(candidate.planner);
}

/** Up to maxPlansPerSet: the best per engine, then the best alternative on the winner. */
function diversify(sorted, constants) {
  const plans = [];
  const engines = new Set();
  for (const candidate of sorted) {
    if (engines.has(candidate.engineId)) continue;
    engines.add(candidate.engineId);
    plans.push(candidate);
    if (plans.length >= constants.maxPlansPerSet) return plans;
  }
  const winner = plans[0];
  if (winner) {
    // Prefer a different context, offload or speculative choice over a KV-only change.
    const key = signature(winner);
    const shape = (candidate) => stableString([candidate.contextLength, candidate.offload, candidate.spec, candidate.recipe?.id || null]);
    const others = sorted.filter((candidate) => candidate.engineId === winner.engineId
      && !plans.includes(candidate) && signature(candidate) !== key);
    const alternative = others.find((candidate) => shape(candidate) !== shape(winner)) || others[0];
    if (alternative) plans.push(alternative);
  }
  return plans.slice(0, constants.maxPlansPerSet);
}

function offloadText(candidate) {
  const offload = candidate.offload;
  if (!offload) return null;
  const mb = offloadedMb(candidate.fit);
  if (offload.kind === "moe") return bilingual(`${offload.amount} 层专家放内存`, `experts of ${offload.amount} layers in RAM`);
  if (offload.kind === "layers") return bilingual(`${offload.amount} 层放 GPU，其余在内存`, `${offload.amount} layers on GPU, the rest in RAM`);
  if (offload.kind === "cpu-offload") return bilingual(`${offload.amount} GiB 权重放内存`, `${offload.amount} GiB of weights in RAM`);
  if (offload.kind === "ple") return bilingual(`PLE 嵌入放内存（${gib(mb)} GiB）`, `PLE embeddings in RAM (${gib(mb)} GiB)`);
  return null;
}

function titleFor(candidate, engineLabel) {
  const zh = [engineLabel, `${contextLabel(candidate.contextLength)} 上下文`];
  const en = [engineLabel, `${contextLabel(candidate.contextLength)} context`];
  if (candidate.concurrency > 1) {
    zh.push(`${candidate.concurrency} 路并发`);
    en.push(`${candidate.concurrency} parallel requests`);
  }
  const offload = offloadText(candidate);
  if (offload) {
    zh.push(offload.zh);
    en.push(offload.en);
  }
  if (candidate.kv.dtype && candidate.kv.tier > 0) {
    zh.push(`KV ${candidate.kv.dtype}`);
    en.push(`KV ${candidate.kv.dtype}`);
  }
  if (candidate.spec) {
    zh.push(`投机解码 ${candidate.spec}`);
    en.push(`speculative ${candidate.spec}`);
  }
  if (candidate.recipe) {
    zh.push(`方案 ${candidate.recipe.id}`);
    en.push(`recipe ${candidate.recipe.id}`);
  }
  return { zh: zh.join(" · "), en: en.join(" · ") };
}

function reasonFor(id, candidate, goal, constants) {
  const fit = candidate.fit;
  if (id === "contextLength") {
    if (goal === "max-context") return bilingual("本机放得下的最大上下文档位", "the largest context rung that fits on this host");
    if (!candidate.meetsTarget) return bilingual("目标上下文放不下，降到放得下的最大档位", "the goal's target context does not fit; the largest rung that does");
    if (goal === "balanced") return bilingual(`至少 ${contextLabel(Math.min(constants.balancedContext, candidate.contextLength))}，在同样的卸载量下尽量加大`, `at least ${contextLabel(Math.min(constants.balancedContext, candidate.contextLength))}, extended while the same offload fits`);
    if (goal === "throughput") return bilingual("按吞吐目标的 32K 上下文评估并发", "the throughput goal measures concurrency at 32K");
    return bilingual("低显存目标的最小上下文", "the low-VRAM goal's minimum context");
  }
  if (id === "concurrency") return bilingual(`目标“${goal}”的并发数`, `concurrency for the "${goal}" goal`);
  if (id === "kvCacheDtype" || id === "llamacpp.cacheTypeK" || id === "llamacpp.cacheTypeV") {
    return candidate.kv.tier > 0
      ? bilingual("降低 KV 缓存精度以换取更多上下文或更少卸载", "lower KV cache precision buys context or saves offload")
      : bilingual("放得下时优先使用最高的 KV 缓存精度", "the highest KV cache precision that fits");
  }
  if (id === "llamacpp.nCpuMoe") {
    if (!candidate.offload) return bilingual("全部专家都在 GPU 上", "every expert stays on the GPU");
    return bilingual(`把 ${gib(positive(fit.ram?.experts))} GiB 路由专家移到内存`, `moves ${gib(positive(fit.ram?.experts))} GiB of routed experts to RAM`);
  }
  if (id === "llamacpp.gpuLayers") {
    return candidate.offload?.kind === "layers"
      ? bilingual("放得下的最多 GPU 层数", "the most layers that fit on the GPU")
      : bilingual("全部层放在 GPU 上", "every layer on the GPU");
  }
  if (id === "vllm.cpuOffloadGb") {
    return candidate.offload
      ? bilingual("放得下所需的最小 CPU 卸载量", "the smallest CPU offload that fits")
      : bilingual("不需要 CPU 卸载", "no CPU offload needed");
  }
  if (id === "sglang.pleOffloadEmbedding") {
    return candidate.offload
      ? bilingual("把 PLE 嵌入移到内存才能放下", "PLE embeddings move to RAM to fit")
      : bilingual("PLE 嵌入留在 GPU 上", "PLE embeddings stay on the GPU");
  }
  if (id === "tensorParallel") return bilingual("在所选的全部 GPU 上做张量并行", "tensor parallel over every selected GPU");
  if (id === "speculative.method") {
    return candidate.spec
      ? bilingual(`模型知识中为该引擎推荐的投机解码（${candidate.spec}）`, candidate.specReason || `speculative decoding the model knowledge enables for this engine (${candidate.spec})`)
      : bilingual("以显存为先的目标关闭投机解码", "speculative decoding stays off for this goal");
  }
  return null;
}

function tradeoffsFor(candidate, first) {
  const out = [];
  const offload = candidate.offload;
  if (offload?.kind === "moe") out.push(bilingual(`${offload.amount} 层的路由专家在 CPU 上计算，生成速度会下降。`, `Routed experts of ${offload.amount} layers run on the CPU; generation is slower.`));
  if (offload?.kind === "layers") out.push(bilingual("部分层在 CPU 上计算，生成会明显变慢。", "Some layers run on the CPU; generation is much slower."));
  if (offload?.kind === "cpu-offload") out.push(bilingual(`每步要从内存读取 ${offload.amount} GiB 权重，吞吐会下降。`, `${offload.amount} GiB of weights stream from RAM on every step; throughput drops.`));
  if (offload?.kind === "ple") out.push(bilingual("PLE 嵌入在内存中，首字延迟略高。", "PLE embeddings live in RAM; first-token latency is slightly higher."));
  if (candidate.kv.tier === 1) out.push(bilingual(`KV 缓存使用 ${candidate.kv.dtype}，显存减半，精度略有损失。`, `The KV cache uses ${candidate.kv.dtype}: half the memory at a small precision cost.`));
  if (candidate.kv.tier === 2) out.push(bilingual(`KV 缓存使用 ${candidate.kv.dtype}（4 位），精度明显下降。`, `The KV cache uses ${candidate.kv.dtype} (4-bit); precision drops noticeably.`));
  if (candidate.spec) out.push(bilingual(`投机解码（${candidate.spec}）加快生成，但占用更多显存。`, `Speculative decoding (${candidate.spec}) speeds up generation and uses more memory.`));
  if (candidate.requiresProbe) out.push(bilingual("该引擎对这个模型的支持尚未验证，请先运行预检探针。", "Support for this model on this engine is unverified; run the dry probe first."));
  if (!candidate.meetsTarget) out.push(bilingual("达不到该目标的上下文或并发要求。", "Falls short of the goal's context or concurrency target."));
  if ((candidate.fit.statusReasons || []).includes("vram_tight")) out.push(bilingual("显存余量较小。", "Little VRAM headroom."));
  if (first && first !== candidate && first.contextLength !== candidate.contextLength) {
    out.push(bilingual(
      `上下文 ${contextLabel(candidate.contextLength)}，方案 1 为 ${contextLabel(first.contextLength)}。`,
      `Context ${contextLabel(candidate.contextLength)} vs ${contextLabel(first.contextLength)} in plan 1.`));
  }
  return out;
}

function fitSummary(fit) {
  return {
    status: fit.status,
    statusReasons: fit.statusReasons || [],
    spill: fit.spill,
    policy: fit.policy,
    perGpuMb: fit.perGpuMb,
    budgetMb: fit.budgetMb,
    headroomMb: fit.headroomMb,
    admissionRequestMb: fit.admissionRequestMb ?? null,
    kvPoolTokens: fit.kvPoolTokens ?? null,
    maxFullLengthRequests: fit.maxFullLengthRequests ?? null,
    breakdown: fit.breakdown,
    ram: fit.ram,
    offloadedMb: Math.ceil(offloadedMb(fit)),
    range: fit.range,
    confidence: fit.confidence,
    paramsKey: fit.paramsKey ?? null,
  };
}

function planFrom(candidate, rank, ctx) {
  const values = {};
  for (const [id, value] of Object.entries(candidate.planner)) {
    const reason = reasonFor(id, candidate, ctx.goal, ctx.constants);
    values[id] = { value, source: "planner", ...(reason ? { reason: joined(reason) } : {}) };
  }
  return {
    planId: `pl_${ctx.nextId()}`,
    rank,
    gpuIds: [...ctx.gpuIds],
    goal: ctx.goal,
    engineId: candidate.engineId,
    runtimeId: candidate.row.runtimeId || null,
    recipeId: candidate.recipe?.id || null,
    title: titleFor(candidate, ctx.labelOf(candidate.engineId)),
    values,
    ...(candidate.recipe ? { locks: (candidate.recipe.locks || []).map((lock) => lock.param) } : {}),
    fit: fitSummary(candidate.fit),
    support: { verdict: candidate.row.verdict, reasons: candidate.row.reasons || [] },
    requiresProbe: candidate.requiresProbe,
    meetsTarget: candidate.meetsTarget,
    tradeoffs: tradeoffsFor(candidate, ctx.first),
    validated: null,
  };
}

// ---------------------------------------------------------------------------
// planLaunches
// ---------------------------------------------------------------------------

/**
 * planLaunches({card, host, goal, gpuSets, rows, catalogs, recipes, constraints}, options) -> GpuSetPlans[]
 *
 * card: a ModelCard (local or remote). host: {gpus:[{id, totalMb, ...}],
 * ramBytes, ramFreeBytes, platform, admissionPolicy?}. goal: max-context |
 * balanced | throughput | low-vram. gpuSets: [[gpuId, ...], ...] (default: each
 * GPU alone, plus all GPUs when there are several). rows: evaluateCompatibility
 * rows (default: computed for the card and host). catalogs: {engineId: catalog
 * | GET /schema payload} (default: the bundled catalogs). recipes: a recipe
 * store, an array of recipes, or null for the default store. constraints:
 * {minContext, concurrency, allowCpuOffload (true), ramReserveGb (16),
 * includeUnverified (false), engines[]}.
 *
 * options: {memoryModels, admissionPolicy, calibrationFor, fitConstants,
 * knowledge, descriptors, compatibility (evaluateCompatibility options),
 * constants}. Side-effect free.
 */
function planLaunches(input = {}, options = {}) {
  const request = isPlainObject(input) ? input : {};
  const card = isPlainObject(request.card) ? request.card : null;
  if (!card) throw plannerError("planner_input_invalid", "The planner needs a model card.");
  const goal = request.goal === undefined || request.goal === null ? "balanced" : String(request.goal);
  if (!GOALS.includes(goal)) throw plannerError("invalid_value", `goal must be one of ${GOALS.join(", ")}.`);
  const constants = { ...PLANNER_CONSTANTS, ...(isPlainObject(options.constants) ? options.constants : {}) };
  const raw = isPlainObject(request.constraints) ? request.constraints : {};
  const constraints = {
    minContext: Math.floor(positive(raw.minContext)) || 0,
    concurrency: Math.floor(positive(raw.concurrency)) || null,
    allowCpuOffload: raw.allowCpuOffload !== false,
    ramReserveGb: Number.isFinite(Number(raw.ramReserveGb)) && Number(raw.ramReserveGb) >= 0 && raw.ramReserveGb !== null && raw.ramReserveGb !== ""
      ? Number(raw.ramReserveGb) : constants.ramReserveGb,
    includeUnverified: raw.includeUnverified === true,
    engines: Array.isArray(raw.engines) ? raw.engines.map(String) : [],
  };
  const host = isPlainObject(request.host) ? request.host : {};
  const gpus = normalizeHostGpus(host);
  const commonNotes = [];
  const gpuSets = gpuSetsFor(gpus, request.gpuSets, commonNotes);
  const ramLimit = ramLimitMb(host, constraints.ramReserveGb);
  if (ramLimit === null) {
    commonNotes.push(bilingual("主机可用内存未知，没有检查 CPU 卸载是否超出内存预留。", "Free host RAM is unknown; CPU offload was not checked against the RAM reserve."));
  }

  const knowledge = options.knowledge || (() => {
    try {
      return knowledgeModule.loadKnowledge();
    } catch {
      return null;
    }
  })();
  let match = { entry: null, matchedBy: [], confidence: null };
  try {
    if (knowledge) match = knowledgeModule.matchFamily(card, knowledge) || match;
  } catch {
    // No family: no speculative defaults and no recipe family match.
  }
  const familyId = match.entry?.id || card.identity?.familyId || null;
  const heuristic = nameHeuristic(card, match);
  const descriptors = descriptorMap(options.descriptors);
  const labelOf = (engineId) => {
    const label = descriptors.get(engineId)?.label;
    return (isPlainObject(label) ? label.en || label.zh : label) || ENGINE_LABELS[engineId] || engineId;
  };

  let rows = request.rows;
  if (!Array.isArray(rows)) {
    try {
      rows = require("./compatibility").evaluateCompatibility(card, { host, knowledge: knowledge || undefined, ...(options.compatibility || {}) });
    } catch {
      rows = [];
    }
  }
  const rowNotes = [];
  const engineRows = bestRows(rows, constraints, rowNotes);
  const store = request.recipes === undefined || request.recipes === null ? null : recipeStoreOf(request.recipes);
  const recipesOff = Array.isArray(request.recipes) && !request.recipes.length;

  const fitOptions = { suggestions: false };
  if (options.memoryModels) fitOptions.memoryModels = options.memoryModels;
  const admissionPolicy = isPlainObject(options.admissionPolicy) ? options.admissionPolicy : isPlainObject(host.admissionPolicy) ? host.admissionPolicy : null;
  if (admissionPolicy) fitOptions.admissionPolicy = admissionPolicy;
  if (typeof options.calibrationFor === "function") fitOptions.calibrationFor = options.calibrationFor;
  if (options.fitConstants) fitOptions.fitConstants = options.fitConstants;
  const fitHost = { gpus: gpus.map(({ index: _index, ...gpu }) => gpu), ramBytes: host.ramBytes, ramFreeBytes: host.ramFreeBytes, platform: host.platform };

  let planCounter = 0;
  const nextId = () => {
    planCounter += 1;
    return planCounter;
  };
  let evaluations = 0;
  let truncated = false;

  return gpuSets.map((gpuIds) => {
    const notes = [...commonNotes, ...rowNotes];
    const memo = new Map();
    const before = evaluations;
    const hostFacts = (() => {
      try {
        const selected = gpus.filter((gpu) => gpuIds.includes(gpu.id));
        const facts = require("../engines/param-catalog").hostFactsFromGpus(selected, host.platform || process.platform);
        return { ...facts, maxGpuMemoryGb: Math.max(0, ...selected.map((gpu) => positive(gpu.totalMb) / 1024)) };
      } catch {
        return {};
      }
    })();
    const candidates = [];
    for (const [engineId, list] of engineRows) {
      const view = catalogView(engineId, request.catalogs);
      if (!view) {
        notes.push(bilingual(`找不到 ${engineId} 的参数目录，没有为它规划。`, `No parameter catalog was found for ${engineId}; it was not planned.`));
        continue;
      }
      const descriptor = descriptors.get(engineId) || null;
      const fitCatalogs = view.compiled ? { catalogs: { [engineId]: view.compiled } } : {};
      const variants = [];
      // 01 recipes matching this card, runtime and host are evaluated first and keep their locks.
      if (!recipesOff) {
        for (const item of recipeCandidates({ engineId, rows: list, card, familyId, hostFacts, store, notes })) variants.push(item);
      }
      variants.push({ row: list[0], recipe: null, applied: null });
      for (const variant of variants) {
        const recipeId = variant.recipe?.id || "";
        const evaluate = (values) => {
          const key = `${engineId}|${variant.row.runtimeId || ""}|${recipeId}|${stableString(values)}`;
          if (memo.has(key)) return memo.get(key);
          if (evaluations >= constants.maxEvaluations) {
            truncated = true;
            return null;
          }
          evaluations += 1;
          let fit = null;
          try {
            fit = fitModule.estimateFit({
              card, engineId, runtimeId: variant.row.runtimeId || null, gpuIds, values, host: fitHost,
              budgetBasis: "empty-gpu", instanceMode: "parallel", recipeMemory: variant.applied?.memory || null,
            }, { ...fitOptions, ...fitCatalogs });
          } catch {
            fit = null;
          }
          memo.set(key, fit);
          return fit;
        };
        const penalty = rowPenalty(variant.row, descriptor, card, heuristic);
        const verifiedRecipe = variant.recipe?.status === "verified" ? 1 : 0;
        const found = searchEngine({
          engineId, view, card, goal, constraints, constants, evaluate, gpuIds, notes, match,
          ramLimit, recipeApplied: variant.applied,
        });
        for (const result of found) {
          // Plan values must validate against the engine catalog before they leave the planner.
          if (view.compiled) {
            try {
              const checked = require("../engines/param-catalog").validateValues(result.planner, view.compiled, {});
              if (checked.errors.length) continue;
            } catch {
              // A catalog that cannot validate keeps the plan; the manager validates it again.
            }
          }
          candidates.push({
            ...result,
            engineId,
            row: variant.row,
            recipe: variant.recipe,
            penalty: Math.max(0, penalty.points - verifiedRecipe),
            requiresProbe: penalty.requiresProbe && !verifiedRecipe,
          });
        }
      }
    }
    if (!engineRows.size) {
      notes.push(bilingual("没有可用于这个模型的引擎（兼容性为阻止或未验证）。", "No engine can serve this model (compatibility is blocked or unverified)."));
    } else if (!candidates.length) {
      notes.push(bilingual("在这组 GPU 上没有找到放得下的配置。", "No configuration fits on this GPU set."));
    }
    if (truncated) notes.push(bilingual("规划的评估次数达到上限，结果可能不完整。", "The planner hit its evaluation limit; the result may be incomplete."));
    const sorted = candidates
      .map((candidate, order) => ({ candidate, order, key: scoreKey(candidate, goal, constants) }))
      .sort((a, b) => compareKeys(a.key, b.key) || a.order - b.order)
      .map((item) => item.candidate);
    const chosen = diversify(sorted, constants);
    const ctx = { goal, constants, gpuIds, nextId, labelOf, first: chosen[0] || null };
    const seenNotes = new Set();
    return {
      gpuIds: [...gpuIds],
      goal,
      plans: chosen.map((candidate, index) => planFrom(candidate, index + 1, ctx)),
      notes: notes.filter((note) => {
        const key = note.en;
        if (seenNotes.has(key)) return false;
        seenNotes.add(key);
        return true;
      }),
      evaluations: evaluations - before,
    };
  });
}

module.exports = {
  planLaunches,
  GOALS,
  CONTEXT_LADDER,
  GOAL_CONCURRENCY,
  PLANNER_CONSTANTS,
};
