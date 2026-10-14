"use strict";

// Hugging Face config detector (docs/overhaul/02-models.md §5). Reads
// config.json (with a nested text_config / llm_config / language_config for
// multimodal checkpoints) and writes identity, context, modalities and custom
// code facts with "declared" evidence pointing at the exact JSON field. The
// per-layer attention layout, MoE, MTP and PLE fields are returned as a
// TopologyInput for topology.js, which joins them with the tensor table.
//
// No branch here looks at a model family: every rule reads a config field
// that any checkpoint may declare (D5).

const { readJsonFile, fileEntry, filesOfKind } = require("./inventory");
const { field } = require("./topology");

const NESTED_TEXT_KEYS = Object.freeze(["text_config", "llm_config", "language_config"]);
// Repo ids only ("owner/name"); a local path never lands on a card.
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OUTPUT_TEXT_ARCHITECTURE = /(?:ForCausalLM|ForConditionalGeneration|LMHeadModel)$/;
const LAYER_TYPE_KINDS = Object.freeze({
  full_attention: "full",
  attention: "full",
  global: "full",
  global_attention: "full",
  sliding_attention: "swa",
  sliding_window_attention: "swa",
  local: "swa",
  local_attention: "swa",
  chunked_attention: "swa",
  linear_attention: "linear",
  mamba: "linear",
  mamba2: "linear",
});
// Nemotron-H style hybrid_override_pattern: one character per layer.
const HYBRID_PATTERN_KINDS = Object.freeze({ M: "linear", "*": "full", "-": "none", E: "none" });

const COPY = Object.freeze({
  headDimFromHidden: {
    zh: "配置没有 head_dim，按 hidden_size / num_attention_heads 计算。",
    en: "No head_dim in the config; computed as hidden_size / num_attention_heads.",
  },
  headDimFromMla: {
    zh: "配置没有 head_dim，按 qk_nope_head_dim + qk_rope_head_dim 计算。",
    en: "No head_dim in the config; computed as qk_nope_head_dim + qk_rope_head_dim.",
  },
  kvHeadsFromHeads: {
    zh: "配置没有 num_key_value_heads：每个注意力头都有自己的 KV。",
    en: "No num_key_value_heads in the config: every attention head keeps its own KV.",
  },
  allFull: {
    zh: "配置没有声明逐层注意力类型，按全部为全注意力处理。",
    en: "The config declares no per-layer attention types; every layer is treated as full attention.",
  },
  interval: (interval) => ({
    zh: `每 ${interval} 层中的最后一层是全注意力，其余是线性注意力（full_attention_interval）。`,
    en: `Every ${interval}th layer is full attention and the others are linear attention (full_attention_interval).`,
  }),
  swaPattern: (pattern) => ({
    zh: `每 ${pattern} 层中的最后一层是全注意力，其余是滑动窗口（sliding_window_pattern）。`,
    en: `Every ${pattern}th layer is full attention and the others use the sliding window (sliding_window_pattern).`,
  }),
  maxWindowLayers: (layers) => ({
    zh: `前 ${layers} 层是全注意力，之后的层使用滑动窗口（max_window_layers）。`,
    en: `The first ${layers} layers are full attention; later layers use the sliding window (max_window_layers).`,
  }),
  allSwa: {
    zh: "配置声明了 sliding_window，但没有逐层模式：按全部层使用滑动窗口处理。",
    en: "The config sets sliding_window without a per-layer pattern; every layer is treated as sliding-window attention.",
  },
  mla: {
    zh: "配置声明了 kv_lora_rank：所有层使用潜在压缩注意力（MLA）。",
    en: "The config sets kv_lora_rank: every layer uses multi-head latent attention (MLA).",
  },
  ssmOnly: {
    zh: "配置只声明了状态空间（SSM）参数：所有层都是线性（Mamba）层。",
    en: "The config declares only state-space (SSM) parameters: every layer is a linear (Mamba) layer.",
  },
  textInput: {
    zh: "文本输入；视觉/音频输入来自 config.json 中声明的编码器。",
    en: "Text input; image and audio input come from encoders declared in config.json.",
  },
  sharedFromSize: {
    zh: "配置声明了共享专家的中间层大小，按 1 个共享专家计。",
    en: "The config sets a shared-expert intermediate size; counted as one shared expert.",
  },
  trustRemoteCode: {
    zh: "config.json 的 auto_map 指向模型自带的 Python 代码。",
    en: "config.json auto_map points at Python code shipped with the model.",
  },
  noRemoteCode: {
    zh: "config.json 没有 auto_map。",
    en: "config.json has no auto_map.",
  },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value) {
  const number = Number(value);
  return typeof value !== "boolean" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return typeof value !== "boolean" && value !== null && value !== "" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function escapeToken(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function source(pointer, file = "config.json") {
  return { kind: "file", ref: pointer ? `${file}#${pointer}` : file };
}

// Looks fields up in the text config first, then at the root.
function createLookup(config, nestedKey) {
  const scopes = nestedKey
    ? [{ node: config[nestedKey], prefix: `/${escapeToken(nestedKey)}` }, { node: config, prefix: "" }]
    : [{ node: config, prefix: "" }];
  function pick(names, accept = (value) => value !== null && value !== undefined) {
    for (const scope of scopes) {
      for (const name of names) {
        if (Object.hasOwn(scope.node, name) && accept(scope.node[name])) {
          return { value: scope.node[name], pointer: `${scope.prefix}/${escapeToken(name)}` };
        }
      }
    }
    return null;
  }
  return { pick, textPrefix: scopes[0].prefix, text: scopes[0].node };
}

function rootField(config, name) {
  return Object.hasOwn(config, name) ? { value: config[name], pointer: `/${escapeToken(name)}` } : null;
}

function normalizeRope(value) {
  if (!isPlainObject(value)) return null;
  const type = value.rope_type ?? value.type ?? null;
  const factor = finiteNumber(value.factor);
  const originalContext = positiveInt(value.original_max_position_embeddings);
  if ((type === null || type === "default") && factor === null) return null;
  return { type: type === null ? null : String(type), factor, originalContext };
}

function declared(found, transform = (value) => value, note) {
  if (!found) return null;
  return field(transform(found.value), source(found.pointer), "declared", note);
}

// Per-layer attention kinds from the declared fields (02 §5 hf-config row),
// first rule that applies: explicit layer_types, a hybrid pattern string, the
// linear interval, MLA, a sliding-window pattern, a window with
// max_window_layers, a window alone, state-space only, else full attention.
function configLayerKinds(lookup, layers) {
  const layerTypes = lookup.pick(["layer_types"], Array.isArray);
  if (layerTypes && layerTypes.value.length) {
    const kinds = layerTypes.value.map((type) => LAYER_TYPE_KINDS[String(type).toLowerCase()] || "unknown");
    return field(kinds, source(layerTypes.pointer), "declared");
  }
  const hybrid = lookup.pick(["hybrid_override_pattern"], (value) => typeof value === "string" && value.length > 0);
  if (hybrid) {
    const kinds = Array.from(hybrid.value).map((symbol) => HYBRID_PATTERN_KINDS[symbol] || "unknown");
    return field(kinds, source(hybrid.pointer), "declared");
  }
  if (!layers) return null;
  const interval = lookup.pick(["full_attention_interval"], (value) => positiveInt(value) !== null);
  if (interval && lookup.pick(["linear_num_value_heads", "linear_num_key_heads", "linear_key_head_dim"])) {
    const every = positiveInt(interval.value);
    const kinds = Array.from({ length: layers }, (_, index) => ((index + 1) % every === 0 ? "full" : "linear"));
    return field(kinds, source(interval.pointer), "detected", COPY.interval(every));
  }
  const mla = lookup.pick(["kv_lora_rank"], (value) => positiveInt(value) !== null);
  if (mla) return field(Array(layers).fill("mla"), source(mla.pointer), "detected", COPY.mla);
  const window = lookup.pick(["sliding_window"], (value) => positiveInt(value) !== null);
  const useWindow = lookup.pick(["use_sliding_window"], (value) => typeof value === "boolean");
  const swaPattern = lookup.pick(["sliding_window_pattern"], (value) => positiveInt(value) !== null);
  if (window && useWindow?.value !== false) {
    if (swaPattern) {
      const every = positiveInt(swaPattern.value);
      const kinds = Array.from({ length: layers }, (_, index) => ((index + 1) % every === 0 ? "full" : "swa"));
      return field(kinds, source(swaPattern.pointer), "detected", COPY.swaPattern(every));
    }
    const maxWindowLayers = lookup.pick(["max_window_layers"], (value) => nonNegativeInt(value) !== null);
    if (maxWindowLayers && useWindow?.value === true) {
      const full = nonNegativeInt(maxWindowLayers.value);
      const kinds = Array.from({ length: layers }, (_, index) => (index < full ? "full" : "swa"));
      return field(kinds, source(maxWindowLayers.pointer), "detected", COPY.maxWindowLayers(full));
    }
    return field(Array(layers).fill("swa"), source(window.pointer), "detected", COPY.allSwa);
  }
  const heads = lookup.pick(["num_attention_heads", "n_head"], (value) => positiveInt(value) !== null);
  const ssm = lookup.pick(["state_size", "ssm_state_size", "d_state"], (value) => positiveInt(value) !== null);
  if (ssm && !heads) return field(Array(layers).fill("linear"), source(ssm.pointer), "detected", COPY.ssmOnly);
  const layersField = lookup.pick(["num_hidden_layers", "n_layer", "num_layers", "n_layers"]);
  return field(Array(layers).fill("full"), source(layersField?.pointer || ""), "detected", COPY.allFull);
}

function linearKind(lookup, prefix) {
  const value = (names) => lookup.pick(names, (item) => item !== null && item !== undefined)?.value;
  if (lookup.pick(["linear_num_value_heads", "linear_num_key_heads"])) {
    return field({
      variant: "gated-deltanet",
      convKernel: positiveInt(value(["linear_conv_kernel_dim"])),
      kHeads: positiveInt(value(["linear_num_key_heads"])),
      vHeads: positiveInt(value(["linear_num_value_heads"])),
      kDim: positiveInt(value(["linear_key_head_dim"])),
      vDim: positiveInt(value(["linear_value_head_dim"])),
      ssmDtype: typeof value(["mamba_ssm_dtype"]) === "string" ? value(["mamba_ssm_dtype"]) : null,
    }, source(prefix), "declared");
  }
  const stateSize = positiveInt(value(["ssm_state_size", "state_size", "d_state"]));
  if (!stateSize) return null;
  const hidden = positiveInt(value(["hidden_size", "d_model"]));
  const nHeads = positiveInt(value(["mamba_num_heads", "num_heads", "nheads"]));
  const headDim = positiveInt(value(["mamba_head_dim", "head_dim"]));
  const expand = finiteNumber(value(["mamba_expand", "expand"]));
  const dInner = positiveInt(value(["mamba_d_inner", "d_inner"]))
    || (nHeads && headDim ? nHeads * headDim : expand && hidden ? Math.round(expand * hidden) : null);
  const groups = positiveInt(value(["n_groups", "ngroups", "mamba_n_groups"]));
  return field({
    variant: nHeads || groups ? "mamba2" : "mamba",
    convKernel: positiveInt(value(["conv_kernel", "mamba_d_conv", "d_conv"])),
    nHeads,
    headDim,
    stateSize,
    groups,
    dInner,
    ssmDtype: typeof value(["mamba_ssm_dtype", "ssm_dtype"]) === "string" ? value(["mamba_ssm_dtype", "ssm_dtype"]) : null,
  }, source(prefix), "declared");
}

function topologyInput(lookup) {
  const int = (names) => lookup.pick(names, (value) => positiveInt(value) !== null);
  const hidden = int(["hidden_size", "d_model", "n_embd"]);
  const layers = int(["num_hidden_layers", "n_layer", "num_layers", "n_layers"]);
  const heads = int(["num_attention_heads", "n_head"]);
  const vocab = int(["vocab_size", "padded_vocab_size"]);
  const kvHeadsDeclared = int(["num_key_value_heads", "n_head_kv", "num_kv_heads", "multi_query_group_num"]);
  const kvHeads = kvHeadsDeclared
    ? declared(kvHeadsDeclared, positiveInt)
    : heads ? field(positiveInt(heads.value), source(heads.pointer), "detected", COPY.kvHeadsFromHeads) : null;
  const kvLoraRank = int(["kv_lora_rank"]);
  const ropeDim = int(["qk_rope_head_dim"]);
  const nopeDim = int(["qk_nope_head_dim"]);
  let headDim = declared(int(["head_dim", "attention_head_dim"]), positiveInt);
  if (!headDim && kvLoraRank && ropeDim && nopeDim) {
    headDim = field(positiveInt(nopeDim.value) + positiveInt(ropeDim.value), source(nopeDim.pointer), "detected", COPY.headDimFromMla);
  } else if (!headDim && hidden && heads && hidden.value % heads.value === 0) {
    headDim = field(hidden.value / heads.value, source(hidden.pointer), "detected", COPY.headDimFromHidden);
  }
  const layerCount = layers ? positiveInt(layers.value) : null;
  const layerKinds = configLayerKinds(lookup, layerCount);
  const vDim = int(["v_head_dim", "value_head_dim"]);
  const kinds = {};
  const kvHeadValue = kvHeads?.value ?? null;
  const kDim = headDim?.value ?? null;
  const vDimValue = vDim ? positiveInt(vDim.value) : kDim;
  const textSource = lookup.textPrefix;
  if (kvHeadValue || kDim) kinds.full = field({ kvHeads: kvHeadValue, kDim, vDim: vDimValue }, source(textSource), kvHeads?.confidence === "declared" ? "declared" : "detected");
  const window = lookup.pick(["sliding_window"], (value) => positiveInt(value) !== null);
  if (window) kinds.swa = field({ window: positiveInt(window.value), kvHeads: kvHeadValue, kDim, vDim: vDimValue }, source(window.pointer), "declared");
  const linear = linearKind(lookup, textSource);
  if (linear) kinds.linear = linear;
  if (kvLoraRank) kinds.mla = field({ kvLoraRank: positiveInt(kvLoraRank.value), ropeDim: ropeDim ? positiveInt(ropeDim.value) : null }, source(kvLoraRank.pointer), "declared");
  const indexerRatio = int(["indexer_compress_ratio"]);
  if (indexerRatio) {
    const value = (names) => positiveInt(lookup.pick(names)?.value);
    kinds.indexer = field({
      compressRatio: positiveInt(indexerRatio.value),
      kDim: value(["indexer_head_dim"]),
      kvHeads: value(["indexer_kv_heads"]),
      heads: value(["indexer_n_heads", "indexer_num_heads"]),
    }, source(indexerRatio.pointer), "declared");
  }

  const experts = int(["num_experts", "n_routed_experts", "num_local_experts", "moe_num_experts"]);
  let moe = null;
  if (experts) {
    const sharedDeclared = lookup.pick(["n_shared_experts", "num_shared_experts"], (value) => nonNegativeInt(value) !== null);
    const sharedSize = int(["shared_expert_intermediate_size", "moe_shared_expert_intermediate_size"]);
    moe = {
      experts: declared(experts, positiveInt),
      active: declared(int(["num_experts_per_tok", "experts_per_token", "moe_top_k", "num_selected_experts"]), positiveInt),
      shared: sharedDeclared
        ? declared(sharedDeclared, nonNegativeInt)
        : sharedSize ? field(1, source(sharedSize.pointer), "detected", COPY.sharedFromSize) : null,
    };
  }
  const mtpObject = lookup.pick(["mtp"], isPlainObject);
  const mtpLayersField = lookup.pick(["mtp_num_hidden_layers", "num_nextn_predict_layers", "nextn_predict_layers"], (value) => nonNegativeInt(value) !== null)
    || (mtpObject && nonNegativeInt(mtpObject.value.num_hidden_layers) !== null
      ? { value: mtpObject.value.num_hidden_layers, pointer: `${mtpObject.pointer}/num_hidden_layers` } : null);
  const pleLayers = lookup.pick(["ple_layer_ids"], (value) => Array.isArray(value) && value.every((item) => nonNegativeInt(item) !== null));
  const pleDtype = lookup.pick(["ple_embedding_dtype"], (value) => typeof value === "string");
  return {
    hiddenSize: declared(hidden, positiveInt),
    vocabSize: declared(vocab, positiveInt),
    layers: declared(layers, positiveInt),
    heads: declared(heads, positiveInt),
    kvHeads,
    headDim,
    layerKinds,
    kinds,
    moe,
    mtpLayers: declared(mtpLayersField, nonNegativeInt),
    ple: pleLayers || pleDtype ? { layers: declared(pleLayers, (value) => value.map(Number)), dtype: declared(pleDtype) } : null,
  };
}

/**
 * Reads config.json and writes identity, context, modalities and custom-code
 * facts. Returns null without a config, else
 * { config, quantization: {value, pointer} | null, dtype: {value, pointer} | null, topology: TopologyInput }.
 */
function detectConfig(inv, facts) {
  const config = readJsonFile(inv, "config.json", facts);
  if (!isPlainObject(config)) return null;
  const nestedKey = NESTED_TEXT_KEYS.find((key) => isPlainObject(config[key])) || null;
  const lookup = createLookup(config, nestedKey);

  const modelType = rootField(config, "model_type");
  if (modelType && typeof modelType.value === "string") facts.set("/identity/modelType", modelType.value, source(modelType.pointer), "declared");
  if (nestedKey && typeof config[nestedKey].model_type === "string") {
    facts.set("/identity/textModelType", config[nestedKey].model_type, source(`/${nestedKey}/model_type`), "declared");
  }
  const architectures = rootField(config, "architectures");
  if (architectures && Array.isArray(architectures.value) && architectures.value.length && architectures.value.every((item) => typeof item === "string")) {
    facts.set("/identity/architectures", [...architectures.value], source(architectures.pointer), "declared");
  }
  const transformers = lookup.pick(["transformers_version"], (value) => typeof value === "string");
  if (transformers) facts.set("/identity/transformersVersion", transformers.value, source(transformers.pointer), "declared");

  const native = lookup.pick(["max_position_embeddings", "n_positions", "max_sequence_length", "seq_length", "max_seq_len"], (value) => positiveInt(value) !== null);
  if (native) facts.set("/context/native", positiveInt(native.value), source(native.pointer), "declared");
  const rope = lookup.pick(["rope_scaling", "rope_parameters"], (value) => normalizeRope(value) !== null);
  if (rope) facts.set("/context/ropeScaling", normalizeRope(rope.value), source(rope.pointer), "declared");
  const window = lookup.pick(["sliding_window"], (value) => positiveInt(value) !== null);
  const useWindow = lookup.pick(["use_sliding_window"], (value) => typeof value === "boolean");
  if (window && useWindow?.value !== false) facts.set("/context/slidingWindow", positiveInt(window.value), source(window.pointer), "declared");

  detectModalities(inv, config, facts);
  detectCustomCode(inv, config, facts);

  return {
    config,
    quantization: lookup.pick(["quantization_config"], isPlainObject),
    dtype: lookup.pick(["dtype", "torch_dtype"], (value) => typeof value === "string"),
    topology: topologyInput(lookup),
  };
}

function detectModalities(inv, config, facts) {
  const visionKey = ["vision_config", "visual"].find((key) => isPlainObject(config[key]));
  const audioKey = ["audio_config"].find((key) => isPlainObject(config[key]));
  const input = ["text"];
  if (visionKey) {
    input.push("image");
    const videoToken = ["video_token_id", "video_token_index"].find((key) => config[key] !== undefined && config[key] !== null);
    if (videoToken || fileEntry(inv, "video_preprocessor_config.json")) input.push("video");
  }
  if (audioKey) input.push("audio");
  facts.set("/modalities/input", input, source(visionKey ? `/${visionKey}` : audioKey ? `/${audioKey}` : ""), visionKey || audioKey ? "declared" : "detected", COPY.textInput);
  facts.set("/modalities/visionTower", Boolean(visionKey), source(visionKey ? `/${visionKey}` : ""), visionKey ? "declared" : "detected");
  facts.set("/modalities/audioTower", Boolean(audioKey), source(audioKey ? `/${audioKey}` : ""), audioKey ? "declared" : "detected");
  const architectures = Array.isArray(config.architectures) ? config.architectures.filter((item) => typeof item === "string") : [];
  if (architectures.some((name) => OUTPUT_TEXT_ARCHITECTURE.test(name))) {
    facts.set("/modalities/output", ["text"], source("/architectures"), "declared");
  }
}

function detectCustomCode(inv, config, facts) {
  const autoMap = isPlainObject(config.auto_map) && Object.keys(config.auto_map).length ? config.auto_map : null;
  if (autoMap) facts.set("/customCode/autoMap", autoMap, source("/auto_map"), "declared");
  facts.set("/customCode/trustRemoteCodeRequired", Boolean(autoMap), source(autoMap ? "/auto_map" : ""), "detected", autoMap ? COPY.trustRemoteCode : COPY.noRemoteCode);
}

/** adapter_config.json (PEFT): the base model it was trained on. */
function detectAdapterConfig(inv, facts) {
  const adapter = readJsonFile(inv, "adapter_config.json", facts);
  if (!isPlainObject(adapter)) return null;
  const base = adapter.base_model_name_or_path;
  if (typeof base === "string" && REPO_ID.test(base)) {
    facts.set("/identity/baseModel", base, source("/base_model_name_or_path", "adapter_config.json"), "declared");
  }
  return adapter;
}

/** Root *.py files: model code that runs only with trust_remote_code. */
function pythonFiles(inv) {
  return filesOfKind(inv, "python", { rootOnly: true }).map((entry) => entry.name);
}

module.exports = {
  LAYER_TYPE_KINDS,
  REPO_ID,
  configLayerKinds,
  createLookup,
  detectAdapterConfig,
  detectConfig,
  normalizeRope,
  pythonFiles,
  topologyInput,
};
