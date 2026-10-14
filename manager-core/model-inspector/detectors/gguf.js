"use strict";

// GGUF detector (docs/overhaul/02-models.md §5, §5.1). Wraps the widened
// header reader of gguf-metadata.js (every KV pair, every tensor info with
// exact bytes) and turns one GGUF model into card facts: identity, context,
// modalities (from projector files next to it), sampling, the topology input
// and the tensor stats. Only header bytes are read.
//
// A folder may hold several GGUF files: split shards of one model, quant
// variants, vision projectors and drafts. selectGgufSet picks the model the
// card describes (the requested file's shards, else the largest complete
// model variant) and the projectors that go with it.
//
// Synchronous on purpose: this runs in the inspect worker.

const path = require("node:path");
const { readGgufHeaderSync } = require("../../gguf-metadata");
const { REPO_ID } = require("./hf-config");
const { absolutePath, filesOfKind } = require("./inventory");
const { createTensorStats, field } = require("./topology");

const SPLIT_GGUF = /^.*-\d{5}-of-\d{5}\.gguf$/i;

const COPY = Object.freeze({
  headerInvalid: (name, reason) => ({
    zh: `${name} 的 GGUF 头无效（${reason}）。`,
    en: `${name} has an invalid GGUF header (${reason}).`,
  }),
  variants: (count, chosen) => ({
    zh: `文件夹中有 ${count} 个 GGUF 模型变体，此卡片描述 ${chosen}；检查其他变体时请选择对应文件。`,
    en: `The folder holds ${count} GGUF model variants; this card describes ${chosen}. Inspect a file to see another variant.`,
  }),
  swaUnknown: {
    zh: "GGUF 只声明了滑动窗口大小，没有逐层模式：哪些层使用滑动窗口未知，按全注意力上限估算。",
    en: "The GGUF declares a sliding window but no per-layer pattern: which layers use it is unknown, so estimates use the full-attention bound.",
  },
  shardsMissing: (count) => ({
    zh: `缺少 ${count} 个 GGUF 分片。`,
    en: `${count} GGUF shard(s) are missing.`,
  }),
  truncated: (count) => ({
    zh: `${count} 个 GGUF 文件比头部声明的张量数据短，可能没有下载完整。`,
    en: `${count} GGUF file(s) are shorter than the tensor data their headers declare; the download may be incomplete.`,
  }),
  allFull: {
    zh: "GGUF 没有声明逐层注意力类型，按全部为全注意力处理。",
    en: "The GGUF declares no per-layer attention types; every layer is treated as full attention.",
  },
  compressed: {
    zh: "GGUF 声明了 attention.compress_ratios：所有层使用压缩注意力，比率逐层不同。",
    en: "The GGUF declares attention.compress_ratios: every layer uses compressed attention with its own ratio.",
  },
  mla: {
    zh: "GGUF 声明了 attention.kv_lora_rank：所有层使用潜在压缩注意力（MLA）。",
    en: "The GGUF declares attention.kv_lora_rank: every layer uses multi-head latent attention (MLA).",
  },
  ssm: {
    zh: "GGUF 声明了 ssm.* 参数：所有层是状态空间（线性）层。",
    en: "The GGUF declares ssm.* parameters: every layer is a state-space (linear) layer.",
  },
  interval: (every) => ({
    zh: `每 ${every} 层中的最后一层是全注意力，其余是线性层（full_attention_interval）。`,
    en: `Every ${every}th layer is full attention and the others are linear (full_attention_interval).`,
  }),
  swaEvery: (every) => ({
    zh: `每 ${every} 层中的最后一层是全注意力，其余是滑动窗口（sliding_window_pattern）。`,
    en: `Every ${every}th layer is full attention and the others use the sliding window (sliding_window_pattern).`,
  }),
  headDimFromHidden: {
    zh: "GGUF 没有 attention.key_length，按 embedding_length / head_count 计算。",
    en: "No attention.key_length in the GGUF; computed as embedding_length / head_count.",
  },
  textInput: {
    zh: "文本输入；图像/音频输入来自同目录的投影文件。",
    en: "Text input; image and audio input come from projector files in the same folder.",
  },
  headerUnavailable: {
    zh: "没有读取到 GGUF 文件头（服务器没有按 Range 返回，或读取失败），来自头部的信息未知。",
    en: "The GGUF header could not be read (the server did not honour Range, or the read failed); the facts it holds are unknown.",
  },
  noProjector: {
    zh: "同目录没有多模态投影文件（mmproj），只接受文本输入。",
    en: "No projector (mmproj) file sits beside the model, so it takes text input only.",
  },
});

function positiveInt(value) {
  const number = Number(value);
  return typeof value !== "boolean" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return typeof value === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function arrayCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object" && Number.isSafeInteger(value.count)) return value.count;
  return null;
}

function isProjectorHeader(header) {
  const kv = header.kv || {};
  const type = String(kv["general.type"] || "").toLowerCase();
  return header.role === "mmproj" || type === "mmproj" || type === "projector" || Object.keys(kv).some((key) => key.startsWith("clip."));
}

function headerRole(header) {
  if (isProjectorHeader(header)) return "mmproj";
  return header.role === "draft" ? "draft" : "model";
}

// unavailable: files of a remote inventory whose header could not be fetched.
// That is not damage (the file is listed and sized), so it is no error and
// no missing shard; the card just knows nothing from inside those files.
function readHeaders(inv, facts, names, unavailable = []) {
  const headers = [];
  for (const name of names) {
    const entry = inv.files.find((item) => item.name === name);
    try {
      const header = inv.remote
        ? inv.remote.ggufHeader(name, entry.size)
        : readGgufHeaderSync(absolutePath(inv, name), { stat: { size: entry.size } });
      headers.push({ name, size: entry.size, header, role: headerRole(header) });
    } catch (error) {
      if (inv.remote && error?.code === "remote_header_unavailable") {
        unavailable.push(name);
        continue;
      }
      // File system errors name the absolute path; the card keeps the code only.
      const reason = typeof error?.code === "string" ? `read failed (${error.code})` : String(error?.message || error).slice(0, 160);
      facts.error("gguf_header_invalid", name, COPY.headerInvalid(name, reason));
    }
  }
  return headers;
}

function groupKey(item) {
  const split = item.header.split || {};
  const dir = item.name.includes("/") ? item.name.slice(0, item.name.lastIndexOf("/")) : "";
  return `${dir}|${String(split.prefix || path.posix.basename(item.name, ".gguf")).toLowerCase()}|${item.role}`;
}

function summarizeGroup(items) {
  const shards = [...items].sort((left, right) => Number(left.header.split?.index || 1) - Number(right.header.split?.index || 1));
  const count = Math.max(1, ...shards.map((item) => Number(item.header.split?.count || 1)));
  const indexes = new Set(shards.map((item) => Number(item.header.split?.index || 1)));
  const missing = [];
  const first = shards[0];
  const prefix = first.header.split?.prefix || path.posix.basename(first.name, ".gguf");
  const dir = first.name.includes("/") ? `${first.name.slice(0, first.name.lastIndexOf("/"))}/` : "";
  for (let index = 1; index <= count; index += 1) {
    if (!indexes.has(index)) missing.push(`${dir}${prefix}-${String(index).padStart(5, "0")}-of-${String(count).padStart(5, "0")}.gguf`);
  }
  return {
    role: first.role,
    shards,
    first,
    count,
    missing,
    complete: missing.length === 0,
    bytes: shards.reduce((sum, item) => sum + item.size, 0),
  };
}

/**
 * Groups GGUF headers into models and picks the one the card describes.
 * file: a requested folder-relative name, or null for the folder.
 * Returns { main, projectors: [group], variants: count of model groups } or null.
 */
function selectGgufSet(items, { file = null } = {}) {
  const groups = new Map();
  for (const item of items) {
    const key = groupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const summaries = Array.from(groups.values()).map(summarizeGroup);
  if (!summaries.length) return null;
  let main = file ? summaries.find((group) => group.shards.some((item) => item.name === file)) : null;
  const models = summaries.filter((group) => group.role === "model")
    .sort((left, right) => Number(right.complete) - Number(left.complete) || right.bytes - left.bytes || (left.first.name < right.first.name ? -1 : 1));
  if (!main) main = models[0] || summaries.find((group) => group.role === "draft") || summaries[0];
  const mainDir = path.posix.dirname(main.first.name);
  const projectors = main.role === "mmproj" ? [] : summaries.filter((group) => group.role === "mmproj" && path.posix.dirname(group.first.name) === mainDir);
  return { main, projectors, variants: models.length };
}

function ggufSource(file, key) {
  return { kind: "gguf", ref: `${file}#${key}` };
}

// Per-layer kinds from the declared keys (see the header of topology.js).
function ggufLayerKinds(kv, arch, file, layers) {
  const key = (suffix) => `${arch}.${suffix}`;
  const value = (suffix) => kv[key(suffix)];
  if (!layers) return { layerKinds: null, swaUnknown: false };
  const ratios = value("attention.compress_ratios");
  if (Array.isArray(ratios) && ratios.length >= layers) {
    return { layerKinds: field(Array(layers).fill("compressed"), ggufSource(file, key("attention.compress_ratios")), "declared", COPY.compressed) };
  }
  if (positiveInt(value("attention.kv_lora_rank"))) {
    return { layerKinds: field(Array(layers).fill("mla"), ggufSource(file, key("attention.kv_lora_rank")), "detected", COPY.mla) };
  }
  const kvHeads = value("attention.head_count_kv");
  const ssm = positiveInt(value("ssm.conv_kernel")) || positiveInt(value("ssm.state_size"));
  if (Array.isArray(kvHeads) && kvHeads.length === layers && kvHeads.some((count) => Number(count) === 0)) {
    const empty = ssm ? "linear" : "none";
    return { layerKinds: field(kvHeads.map((count) => (Number(count) === 0 ? empty : "full")), ggufSource(file, key("attention.head_count_kv")), "declared") };
  }
  if (ssm) {
    const interval = positiveInt(value("full_attention_interval"));
    if (interval) {
      const kinds = Array.from({ length: layers }, (_, index) => ((index + 1) % interval === 0 ? "full" : "linear"));
      return { layerKinds: field(kinds, ggufSource(file, key("full_attention_interval")), "detected", COPY.interval(interval)) };
    }
    return { layerKinds: field(Array(layers).fill("linear"), ggufSource(file, key("ssm.state_size")), "detected", COPY.ssm) };
  }
  const pattern = value("attention.sliding_window_pattern") ?? value("sliding_window_pattern");
  if (Array.isArray(pattern) && pattern.length) {
    const kinds = Array.from({ length: layers }, (_, index) => (pattern[index] ? "swa" : "full"));
    return { layerKinds: field(kinds, ggufSource(file, key("attention.sliding_window_pattern")), "declared") };
  }
  if (positiveInt(pattern) && positiveInt(value("attention.sliding_window"))) {
    const every = positiveInt(pattern);
    const kinds = Array.from({ length: layers }, (_, index) => ((index + 1) % every === 0 ? "full" : "swa"));
    return { layerKinds: field(kinds, ggufSource(file, key("attention.sliding_window_pattern")), "detected", COPY.swaEvery(every)) };
  }
  // 02 §5.1: a window without a pattern does not make every layer SWA.
  if (positiveInt(value("attention.sliding_window")) || positiveInt(value("sliding_window"))) {
    return { layerKinds: field(Array(layers).fill("unknown"), ggufSource(file, key("attention.sliding_window")), "detected", COPY.swaUnknown), swaUnknown: true };
  }
  return { layerKinds: field(Array(layers).fill("full"), ggufSource(file, key("block_count")), "detected", COPY.allFull) };
}

/** TopologyInput (see topology.js) from a GGUF KV block. */
function ggufTopologyInput(kv, file) {
  const arch = String(kv["general.architecture"] || "");
  const key = (suffix) => `${arch}.${suffix}`;
  const value = (suffix) => kv[key(suffix)];
  const declaredInt = (suffix, transform = positiveInt) => field(transform(value(suffix)), ggufSource(file, key(suffix)), "declared");
  const layers = positiveInt(value("block_count"));
  const hidden = positiveInt(value("embedding_length"));
  const headsRaw = value("attention.head_count");
  const heads = Array.isArray(headsRaw) ? Math.max(0, ...headsRaw.map(Number)) || null : positiveInt(headsRaw);
  const kvRaw = value("attention.head_count_kv");
  const kvHeads = Array.isArray(kvRaw) ? Math.max(0, ...kvRaw.map(Number)) || null : positiveInt(kvRaw);
  const keyLength = positiveInt(value("attention.key_length"));
  const valueLength = positiveInt(value("attention.value_length"));
  let headDim = keyLength ? field(keyLength, ggufSource(file, key("attention.key_length")), "declared") : null;
  if (!headDim && hidden && heads && hidden % heads === 0) {
    headDim = field(hidden / heads, ggufSource(file, key("embedding_length")), "detected", COPY.headDimFromHidden);
  }
  const vocabDeclared = positiveInt(value("vocab_size"));
  const vocab = vocabDeclared
    ? field(vocabDeclared, ggufSource(file, key("vocab_size")), "declared")
    : field(arrayCount(kv["tokenizer.ggml.tokens"]), ggufSource(file, "tokenizer.ggml.tokens"), "detected");
  const { layerKinds, swaUnknown } = ggufLayerKinds(kv, arch, file, layers);
  const kDim = headDim?.value ?? null;
  const vDim = valueLength || kDim;
  const kinds = {};
  if (kvHeads || kDim) kinds.full = field({ kvHeads, kDim, vDim }, ggufSource(file, key("attention.head_count_kv")), "declared");
  const window = positiveInt(value("attention.sliding_window")) || positiveInt(value("sliding_window"));
  if (window) kinds.swa = field({ window, kvHeads, kDim, vDim }, ggufSource(file, key("attention.sliding_window")), "declared");
  const kvLoraRank = positiveInt(value("attention.kv_lora_rank"));
  if (kvLoraRank) kinds.mla = field({ kvLoraRank, ropeDim: positiveInt(value("rope.dimension_count")) }, ggufSource(file, key("attention.kv_lora_rank")), "declared");
  const ratios = value("attention.compress_ratios");
  if (Array.isArray(ratios)) {
    const indexerHeads = positiveInt(value("attention.indexer.head_count"));
    kinds.compressed = field({
      window,
      latentDim: keyLength,
      ratios: ratios.map(Number),
      indexer: indexerHeads ? {
        heads: indexerHeads,
        kDim: positiveInt(value("attention.indexer.key_length")),
        topK: positiveInt(value("attention.indexer.top_k")),
      } : null,
    }, ggufSource(file, key("attention.compress_ratios")), "declared");
  }
  const stateSize = positiveInt(value("ssm.state_size"));
  if (stateSize) {
    const inner = positiveInt(value("ssm.inner_size"));
    const rank = positiveInt(value("ssm.time_step_rank"));
    const groups = positiveInt(value("ssm.group_count"));
    const convKernel = positiveInt(value("ssm.conv_kernel"));
    const interval = positiveInt(value("full_attention_interval"));
    // A hybrid with full-attention intervals stores gated-deltanet heads in
    // the ssm.* keys: group_count key heads, time_step_rank value heads.
    kinds.linear = field(interval ? {
      variant: "gated-deltanet",
      convKernel,
      kHeads: groups,
      vHeads: rank,
      kDim: stateSize,
      vDim: inner && rank && inner % rank === 0 ? inner / rank : null,
      ssmDtype: null,
    } : {
      variant: groups ? "mamba2" : "mamba",
      convKernel,
      nHeads: rank,
      headDim: inner && rank && inner % rank === 0 ? inner / rank : null,
      stateSize,
      groups,
      dInner: inner,
      ssmDtype: null,
    }, ggufSource(file, key("ssm.state_size")), "declared");
  }
  const experts = positiveInt(value("expert_count"));
  const shared = nonNegativeInt(value("expert_shared_count"));
  return {
    topology: {
      hiddenSize: declaredInt("embedding_length"),
      vocabSize: vocab,
      layers: declaredInt("block_count"),
      heads: heads ? field(heads, ggufSource(file, key("attention.head_count")), "declared") : null,
      kvHeads: kvHeads ? field(kvHeads, ggufSource(file, key("attention.head_count_kv")), "declared") : null,
      headDim,
      layerKinds,
      kinds,
      moe: experts ? {
        experts: declaredInt("expert_count"),
        active: declaredInt("expert_used_count"),
        shared: shared === null ? null : field(shared, ggufSource(file, key("expert_shared_count")), "declared"),
      } : null,
      mtpLayers: field(nonNegativeInt(value("nextn_predict_layers")), ggufSource(file, key("nextn_predict_layers")), "declared"),
      ple: null,
    },
    swaUnknown,
  };
}

// GGUF files whose headers could not be read, and nothing else to describe:
// the card lists them as damaged (02 §20) and knows nothing from inside them.
function damagedGguf(inv, names) {
  const split = names.every((name) => SPLIT_GGUF.test(path.posix.basename(name)));
  return {
    kv: {},
    file: names[0],
    role: "model",
    topology: null,
    stats: null,
    tensorTypes: {},
    files: names.map((name) => inv.files.find((entry) => entry.name === name)),
    layout: split ? "gguf-split" : names.length === 1 ? "single" : null,
    missing: [],
    truncated: [],
    damaged: [...names],
    projectors: [],
  };
}

// Remote GGUF files whose headers could not be read: sized by the listing,
// described by nothing else (02 §6: header facts stay unknown, never guessed).
function unavailableGguf(inv, facts, listed) {
  facts.warn("gguf_header_unavailable", COPY.headerUnavailable);
  const models = listed.filter((name) => !/mmproj|projector/i.test(path.posix.basename(name)));
  const names = models.length ? models : listed;
  const split = names.every((name) => SPLIT_GGUF.test(path.posix.basename(name)));
  return {
    kv: {},
    file: names[0],
    role: "model",
    topology: null,
    stats: null,
    tensorTypes: {},
    files: names.map((name) => inv.files.find((entry) => entry.name === name)),
    layout: split ? "gguf-split" : names.length === 1 ? "single" : null,
    missing: [],
    truncated: [],
    damaged: [],
    projectors: [],
  };
}

function baseModelOf(kv) {
  const url = kv["general.base_model.0.repo_url"];
  const match = typeof url === "string" ? url.match(/^https:\/\/huggingface\.co\/([^/\s?#]+\/[^/\s?#]+)\/?$/) : null;
  return match && REPO_ID.test(match[1]) ? match[1] : null;
}

/**
 * ggufFacts(inv, facts, {file, classes}) -> null without GGUF files, else
 * { kv, file, role, topology, stats, tensorTypes, files: [entries], layout,
 *   missing: [name], truncated: [name], damaged: [name], projectors: [name] }.
 * When no header can be read (or the requested file's cannot), kv is empty,
 * topology and stats are null and `damaged` names the files.
 */
function ggufFacts(inv, facts, { file = null, classes } = {}) {
  const names = filesOfKind(inv, "weights:gguf").map((entry) => entry.name);
  if (!names.length) return null;
  const unavailable = [];
  const items = readHeaders(inv, facts, names, unavailable);
  if (!items.length && unavailable.length) return unavailableGguf(inv, facts, unavailable);
  // A requested file with an unreadable header is described as damaged, never
  // by another variant of the folder.
  if (file && !items.some((item) => item.name === file)) return damagedGguf(inv, [file]);
  const set = selectGgufSet(items, { file });
  if (!set) return damagedGguf(inv, names);
  const { main } = set;
  const first = main.first.name;
  const kv = main.first.header.kv || {};
  const source = (key) => ggufSource(first, key);
  if (!file && set.variants > 1) facts.warn("multiple_gguf_variants", COPY.variants(set.variants, first));

  if (typeof kv["general.architecture"] === "string") facts.set("/identity/ggufArchitecture", kv["general.architecture"], source("general.architecture"), "declared");
  if (typeof kv["general.name"] === "string" && kv["general.name"].trim()) facts.set("/identity/displayName", kv["general.name"].trim(), source("general.name"), "declared");
  const baseModel = baseModelOf(kv);
  if (baseModel) facts.set("/identity/baseModel", baseModel, source("general.base_model.0.repo_url"), "declared");

  const arch = String(kv["general.architecture"] || "");
  const contextKey = `${arch}.context_length`;
  if (positiveInt(kv[contextKey])) facts.set("/context/native", positiveInt(kv[contextKey]), source(contextKey), "declared");
  const ropeType = kv[`${arch}.rope.scaling.type`];
  if (typeof ropeType === "string" && ropeType && ropeType !== "none") {
    const factor = kv[`${arch}.rope.scaling.factor`];
    facts.set("/context/ropeScaling", {
      type: ropeType,
      factor: typeof factor === "number" && Number.isFinite(factor) ? factor : null,
      originalContext: positiveInt(kv[`${arch}.rope.scaling.original_context_length`]),
    }, source(`${arch}.rope.scaling.type`), "declared");
  }
  const windowKey = `${arch}.attention.sliding_window`;
  if (positiveInt(kv[windowKey])) facts.set("/context/slidingWindow", positiveInt(kv[windowKey]), source(windowKey), "declared");

  // Modalities: a projector's own clip.* keys, or the projectors beside the model.
  const projectorHeaders = main.role === "mmproj" ? [main.first] : set.projectors.map((group) => group.first);
  const hasVision = projectorHeaders.some((item) => item.header.kv["clip.has_vision_encoder"] === true || Object.keys(item.header.kv).some((name) => name.startsWith("clip.vision.")));
  const hasAudio = projectorHeaders.some((item) => item.header.kv["clip.has_audio_encoder"] === true || Object.keys(item.header.kv).some((name) => name.startsWith("clip.audio.")));
  const input = main.role === "mmproj" ? [] : ["text"];
  if (hasVision) input.push("image");
  if (hasAudio) input.push("audio");
  if (projectorHeaders.length) {
    const projector = projectorHeaders[0].name;
    facts.set("/modalities/input", input, { kind: "gguf", ref: projector }, "declared", main.role === "mmproj" ? undefined : COPY.textInput);
    facts.set("/modalities/visionTower", hasVision, ggufSource(projector, "clip.has_vision_encoder"), "declared");
    facts.set("/modalities/audioTower", hasAudio, ggufSource(projector, "clip.has_audio_encoder"), "declared");
  } else {
    // No projector file beside the model: text in, no encoders.
    facts.set("/modalities/input", input, { kind: "file", ref: first }, "detected", COPY.noProjector);
    facts.set("/modalities/visionTower", false, { kind: "file", ref: first }, "detected");
    facts.set("/modalities/audioTower", false, { kind: "file", ref: first }, "detected");
  }
  const projectorFiles = set.projectors.flatMap((group) => group.shards.map((item) => item.name));
  if (projectorFiles.length) facts.set("/modalities/projectorFiles", projectorFiles, { kind: "gguf", ref: projectorFiles[0] }, "declared");

  // Unknown ggml types count with their layout upper bound (MOD-2 bytesUpper)
  // and leave the totals inexact.
  const tensors = createTensorStats({ format: "gguf", classes, ref: `${first}#tensor_infos` });
  const tensorTypes = {};
  const truncated = [];
  for (const item of main.shards) {
    for (const tensor of item.header.tensors || []) {
      const dtype = tensor.type || `type-${tensor.typeId}`;
      const elements = tensor.dims.reduce((product, dim) => product * dim, 1);
      if (tensor.bytes === null) tensors.markInexact();
      tensors.add(tensor.name, { dtype, elements, bytes: tensor.bytes ?? tensor.bytesUpper ?? null });
      tensorTypes[dtype] = (tensorTypes[dtype] || 0) + 1;
    }
    if (item.header.weights && item.header.weights.exact === false) tensors.markInexact();
    tensors.addLayout(item.header.weights?.totalBytes);
    for (const warning of item.header.warnings || []) {
      if (warning.code === "gguf_payload_short") truncated.push(item.name);
      else facts.warn(warning.code, warning.message, { file: item.name });
    }
  }
  if (main.missing.length) {
    tensors.markInexact();
    facts.warn("weights_missing", COPY.shardsMissing(main.missing.length));
  }
  if (truncated.length) facts.warn("weights_truncated", COPY.truncated(truncated.length));
  const stats = tensors.stats;
  // A causal model (no pooling head) with token embeddings or an output
  // matrix produces text.
  const lmBytes = stats.byClass.lmHead + stats.byClass.embedding;
  if (main.role === "model" && lmBytes > 0 && kv[`${arch}.pooling_type`] === undefined) {
    facts.set("/modalities/output", ["text"], { kind: "tensor-table", ref: `${first}#tensor_infos` }, "detected");
  }
  const { topology, swaUnknown } = ggufTopologyInput(kv, first);
  if (swaUnknown) facts.warn("swa_layout_unknown", COPY.swaUnknown);
  return {
    kv,
    file: first,
    role: main.role,
    topology,
    stats,
    tensorTypes,
    files: main.shards.map((item) => inv.files.find((entry) => entry.name === item.name)),
    layout: main.count > 1 ? "gguf-split" : "single",
    missing: main.missing,
    truncated,
    damaged: [],
    projectors: projectorFiles,
  };
}

module.exports = {
  ggufFacts,
  ggufLayerKinds,
  ggufTopologyInput,
  headerRole,
  selectGgufSet,
};
