"use strict";

// Topology detector (docs/overhaul/02-models.md §4.3, §5): per-layer attention
// kinds, MoE, MTP and PLE, and the weight byte classes. hf-config.js and
// gguf.js read the declared fields into a TopologyInput; the tensor tables
// (safetensors headers or GGUF tensor infos) are folded into TensorStats here;
// buildTopology combines the two into card facts with evidence.
//
// TopologyInput fields are Field objects {value, source, confidence, note?}:
//   hiddenSize, vocabSize, layers, heads, kvHeads, headDim,
//   layerKinds (value: one kind per layer), kinds.{full,swa,linear,mla,compressed,indexer},
//   moe.{experts, active, shared}, mtpLayers, ple.{layers, dtype}.
//
// Tensor classes are data (02 §5). Until the knowledge layers load them from
// data/knowledge/families.json (MOD-5), DEFAULT_TENSOR_CLASSES is the bundled
// table; callers may pass their own. The order is the match order: MTP and
// vision tensors are classed before experts, so an MTP layer's experts are MTP
// bytes, not a main layer's expert bytes.

const DEFAULT_TENSOR_CLASSES = Object.freeze([
  { class: "mtp", patterns: ["^(?:model\\.)?mtp\\.", "\\.nextn\\.", "^blk\\.\\d+\\.nextn\\."] },
  { class: "vision", patterns: ["(?:^|\\.)visual\\.", "vision_tower", "^v\\.", "multi_modal_projector"] },
  { class: "audio", patterns: ["audio_tower", "^a\\."] },
  { class: "ple", patterns: ["\\.ple\\.", "per_layer_embed"] },
  { class: "experts", patterns: ["\\.experts\\.\\d+\\.", "\\.mlp\\.experts\\.", "^blk\\.\\d+\\.ffn_(?:gate|up|down|gate_up)_exps\\."], layerGroup: 1 },
  { class: "embedding", patterns: ["embed_tokens\\.weight$", "^token_embd\\."] },
  { class: "lmHead", patterns: ["^lm_head\\.", "^output\\.weight$"] },
].map((entry) => Object.freeze({ ...entry, patterns: Object.freeze(entry.patterns) })));
const WEIGHT_CLASSES = Object.freeze(["dense", "experts", "embedding", "lmHead", "vision", "audio", "mtp", "ple", "other"]);
// Per-layer attention kinds (02 §4.3, §10.3). "none" is a layer without an
// attention or state mixer (an MLP/MoE-only block of a hybrid pattern).
const LAYER_KINDS = Object.freeze(["full", "swa", "linear", "mla", "compressed", "none", "unknown"]);
const KIND_OBJECTS = Object.freeze(["full", "swa", "linear", "mla", "compressed", "indexer"]);
// A class's layerGroup N buckets its bytes by the Nth numeric path segment:
// with 1, "model.layers.12.mlp.experts.5…" and "blk.12.ffn…" are layer 12.
const NUMERIC_SEGMENT = /(?:^|\.)(\d+)(?=\.|$)/g;
// Quantization side tensors carry scales, offsets or zero points, not parameters.
const SIDE_TENSOR = /(?:^|[._])(?:weight_scale(?:_inv|_2)?|input_scale|scale_inv|scales|qzeros|g_idx|zero_point|k_scale|v_scale|absmax|quant_map|nested_absmax|nested_quant_map)$|\.quant_state\./;

const COPY = Object.freeze({
  layoutBytes: {
    zh: "按文件头布局计算的权重文件总大小（头、张量和对齐填充），即完整下载的大小；tensorBytes 只计张量。",
    en: "The weight files as their headers lay them out (header, tensors, padding): the size of a complete download. tensorBytes counts tensors only.",
  },
  layerTypesMismatch: (types, layers) => ({
    zh: `layer_types 列出 ${types} 层，但 num_hidden_layers 是 ${layers}；按 layer_types 计算。`,
    en: `layer_types lists ${types} layers but num_hidden_layers is ${layers}; the layer kinds follow layer_types.`,
  }),
});

function field(value, source, confidence, note) {
  if (value === undefined || value === null) return null;
  const result = { value, source, confidence };
  if (note) result.note = note;
  return result;
}

function compileTensorClasses(classes = DEFAULT_TENSOR_CLASSES) {
  return classes.map((entry) => ({
    class: WEIGHT_CLASSES.includes(entry.class) ? entry.class : "other",
    patterns: entry.patterns.map((pattern) => new RegExp(pattern)),
    layerGroup: entry.layerGroup ?? null,
  }));
}

function classifyTensor(name, compiled) {
  for (const entry of compiled) {
    if (entry.patterns.some((pattern) => pattern.test(name))) return entry;
  }
  return null;
}

function layerIndexOf(name, group = 1) {
  let seen = 0;
  for (const match of name.matchAll(NUMERIC_SEGMENT)) {
    seen += 1;
    if (seen === group) return Number(match[1]);
  }
  return null;
}

function addTo(map, key, amount) {
  map[key] = (map[key] || 0) + amount;
}

/**
 * Folds tensors into byte and element totals without keeping the tensor list
 * (a 400-shard checkpoint has hundreds of thousands of tensors).
 * add(name, {dtype, elements, bytes}); bytes null means unknown (inexact).
 * addLayout(bytes) once per weight file: its size as the header lays it out.
 */
function createTensorStats({ format, classes = DEFAULT_TENSOR_CLASSES, ref = null } = {}) {
  const compiled = compileTensorClasses(classes);
  const byClass = Object.fromEntries(WEIGHT_CLASSES.map((name) => [name, 0]));
  const stats = {
    format,
    ref,
    exact: true,
    tensorCount: 0,
    tensorBytes: 0,
    layoutBytes: 0,
    byDtype: {},
    byClass,
    classCounts: {},
    expertsByLayer: [],
    elementsByDtype: {},
    expertElementsByDtype: {},
  };

  function add(name, { dtype, elements, bytes }) {
    const known = Number.isSafeInteger(bytes) && bytes >= 0;
    if (!known) stats.exact = false;
    const size = known ? bytes : 0;
    const matched = classifyTensor(name, compiled);
    const tensorClass = matched ? matched.class : "dense";
    stats.tensorCount += 1;
    stats.tensorBytes += size;
    addTo(stats.byDtype, dtype, size);
    stats.byClass[tensorClass] += size;
    addTo(stats.classCounts, tensorClass, 1);
    const layer = matched?.layerGroup ? layerIndexOf(name, matched.layerGroup) : null;
    if (layer !== null) {
      while (stats.expertsByLayer.length <= layer) stats.expertsByLayer.push(0);
      stats.expertsByLayer[layer] += size;
    }
    if (!SIDE_TENSOR.test(name) && Number.isSafeInteger(elements)) {
      addTo(stats.elementsByDtype, dtype, elements);
      if (tensorClass === "experts") addTo(stats.expertElementsByDtype, dtype, elements);
    }
  }

  function markInexact() {
    stats.exact = false;
  }

  // The bytes a complete weight file occupies as its header lays it out
  // (header, tensors, padding): the size a download or a remote listing has.
  function addLayout(bytes) {
    if (Number.isSafeInteger(bytes) && bytes >= 0) stats.layoutBytes += bytes;
    else stats.exact = false;
  }

  return { add, addLayout, markInexact, stats };
}

/** Kind counts in LAYER_KINDS order, zero counts left out. */
function layerHistogram(kinds) {
  const counts = {};
  for (const kind of kinds) counts[kind] = (counts[kind] || 0) + 1;
  return Object.fromEntries(LAYER_KINDS.filter((kind) => counts[kind]).map((kind) => [kind, counts[kind]]));
}

/**
 * Run-length encoding of the shortest repeating unit (02 §4.3: runs repeat to
 * `layers`). [linear,linear,linear,full]×16 gives [{linear,3},{full,1}].
 */
function layerRuns(kinds) {
  let period = kinds.length;
  for (let candidate = 1; candidate < kinds.length; candidate += 1) {
    if (kinds.every((kind, index) => kind === kinds[index % candidate])) {
      period = candidate;
      break;
    }
  }
  const runs = [];
  for (const kind of kinds.slice(0, period)) {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.count += 1;
    else runs.push({ kind, count: 1 });
  }
  return runs;
}

function writeField(facts, pointer, input) {
  if (!input) return false;
  return facts.set(pointer, input.value, input.source, input.confidence, input.note);
}

// Packed quantized dtypes hold several parameters per element: 4-bit weights
// in U8 hold two, in I32 eight (AWQ/GPTQ qweight).
function packFactor(dtype, quant) {
  const bits = Number(quant?.weightBits);
  if (!Number.isFinite(bits) || bits <= 0 || bits >= 8) return 1;
  if (dtype === "U8" || dtype === "I8") return Math.round(8 / bits);
  if (dtype === "I32" || dtype === "U32") return Math.round(32 / bits);
  return 1;
}

function sumElements(byDtype, quant) {
  let total = 0;
  for (const [dtype, elements] of Object.entries(byDtype)) total += elements * packFactor(dtype, quant);
  return total;
}

const STATS_SOURCE = (stats) => ({ kind: "tensor-table", ref: stats.ref });

/**
 * Writes /topology/** from the declared input and the tensor stats.
 * options.quant: the card's quant facts (for packed parameter counts).
 */
function buildTopology(input, stats, facts, { quant = null } = {}) {
  const topology = input || {};
  for (const key of ["hiddenSize", "vocabSize", "layers", "heads", "kvHeads", "headDim"]) {
    writeField(facts, `/topology/${key}`, topology[key]);
  }

  if (stats && stats.tensorCount > 0) {
    const source = STATS_SOURCE(stats);
    const total = sumElements(stats.elementsByDtype, quant);
    const packed = Object.keys(stats.elementsByDtype).some((dtype) => packFactor(dtype, quant) > 1);
    const note = packed
      ? { zh: "按张量形状计数，打包的低比特权重按每元素多个参数换算。", en: "Counted from tensor shapes; packed low-bit weights count several parameters per element." }
      : undefined;
    facts.set("/topology/paramsTotal", total, source, "detected", note);
    const experts = topology.moe?.experts?.value;
    const active = topology.moe?.active?.value;
    const expertElements = sumElements(stats.expertElementsByDtype, quant);
    if (experts > 0 && active > 0 && expertElements > 0) {
      const activeParams = Math.round(total - expertElements * (1 - Math.min(1, active / experts)));
      facts.set("/topology/paramsActive", activeParams, source, "detected", {
        zh: `按每个 token 激活 ${active}/${experts} 个专家计算。`,
        en: `Counts ${active} of ${experts} routed experts as active per token.`,
      });
    }
  }

  const layerKinds = topology.layerKinds;
  if (layerKinds && Array.isArray(layerKinds.value) && layerKinds.value.length) {
    const kinds = layerKinds.value;
    const declaredLayers = topology.layers?.value;
    const note = declaredLayers && declaredLayers !== kinds.length ? COPY.layerTypesMismatch(kinds.length, declaredLayers) : layerKinds.note;
    facts.set("/topology/attention/histogram", layerHistogram(kinds), layerKinds.source, layerKinds.confidence, note);
    facts.set("/topology/attention/runs", layerRuns(kinds), layerKinds.source, layerKinds.confidence);
    const present = new Set(kinds);
    for (const kind of KIND_OBJECTS) {
      const value = topology.kinds?.[kind];
      if (!value) continue;
      // The indexer sits on full layers; every other kind object describes
      // layers of that kind, and is kept only when such layers exist (or the
      // kind is "unknown" because the layout is not declared).
      if (kind === "indexer" ? present.has("full") : (present.has(kind) || (kind === "swa" && present.has("unknown")))) {
        writeField(facts, `/topology/attention/kinds/${kind}`, value);
      }
    }
  }

  const moe = topology.moe;
  if (moe?.experts?.value > 0) {
    writeField(facts, "/topology/moe/experts", moe.experts);
    writeField(facts, "/topology/moe/active", moe.active);
    writeField(facts, "/topology/moe/shared", moe.shared);
    if (stats && stats.byClass.experts > 0) {
      const source = STATS_SOURCE(stats);
      facts.set("/topology/moe/expertBytes", stats.byClass.experts, source, "detected");
      facts.set("/topology/moe/nonExpertBytes", stats.tensorBytes - stats.byClass.experts, source, "detected");
      facts.set("/topology/moe/expertBytesPerLayer", expertsByLayer(stats, topology), source, "detected");
    }
  }

  const mtpTensors = stats?.classCounts?.mtp || 0;
  const mtpLayers = topology.mtpLayers?.value || 0;
  if (mtpLayers > 0 || mtpTensors > 0) {
    if (mtpLayers > 0) writeField(facts, "/topology/mtp/layers", topology.mtpLayers);
    if (stats) {
      const source = STATS_SOURCE(stats);
      facts.set("/topology/mtp/tensorCount", mtpTensors, source, "detected");
      facts.set("/topology/mtp/bytes", stats.byClass.mtp, source, "detected");
    }
  }

  const ple = topology.ple;
  if (ple?.layers || (stats && stats.byClass.ple > 0)) {
    writeField(facts, "/topology/ple/layers", ple?.layers);
    writeField(facts, "/topology/ple/dtype", ple?.dtype);
    if (stats) facts.set("/topology/ple/bytes", stats.byClass.ple, STATS_SOURCE(stats), "detected");
  }
}

function expertsByLayer(stats, topology) {
  const layers = Math.max(stats.expertsByLayer.length, Number(topology.layers?.value) || 0);
  return Array.from({ length: layers }, (_, index) => stats.expertsByLayer[index] || 0);
}

/** Writes /weights/** from tensor stats (02 §4.3). */
function writeWeights(stats, facts, topology = {}) {
  if (!stats) return;
  const source = STATS_SOURCE(stats);
  facts.set("/weights/exact", stats.exact, source, "detected");
  facts.set("/weights/totalBytes", stats.layoutBytes, source, "detected", COPY.layoutBytes);
  facts.set("/weights/tensorBytes", stats.tensorBytes, source, "detected");
  facts.set("/weights/byDtype", sortedObject(stats.byDtype), source, "detected");
  facts.set("/weights/byClass", { ...stats.byClass }, source, "detected");
  if (stats.byClass.experts > 0) facts.set("/weights/expertsByLayer", expertsByLayer(stats, topology), source, "detected");
}

function sortedObject(map) {
  return Object.fromEntries(Object.keys(map).sort().map((key) => [key, map[key]]));
}

module.exports = {
  DEFAULT_TENSOR_CLASSES,
  KIND_OBJECTS,
  LAYER_KINDS,
  WEIGHT_CLASSES,
  buildTopology,
  classifyTensor,
  compileTensorClasses,
  createTensorStats,
  field,
  layerHistogram,
  layerIndexOf,
  layerRuns,
  packFactor,
  sortedObject,
  writeWeights,
};
