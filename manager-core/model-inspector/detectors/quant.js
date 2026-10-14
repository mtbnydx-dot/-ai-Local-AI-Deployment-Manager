"use strict";

// Quantization detector (docs/overhaul/02-models.md §5). Sources, strongest
// first: hf_quant_config.json (ModelOpt), config.json quantization_config
// (fp8, modelopt, compressed-tensors, awq, gptq, auto-round, bitsandbytes,
// mxfp4, exl3), the GGUF file type and per-tensor types, and finally the
// tensor dtypes of an unquantized checkpoint. `method` is normalised to the
// 02 §4.3 names; an unknown quant_method is kept as declared.

const { GGUF_FILE_TYPE_NAMES } = require("../../gguf-metadata");
const { fileEntry, readJsonFile } = require("./inventory");

// Weight bits per declared algorithm name (ModelOpt quant_algo and friends).
const ALGO_BITS = Object.freeze({
  FP8: 8,
  FP8_BLOCK: 8,
  FP8_PB_WO: 8,
  INT8: 8,
  INT8_SQ: 8,
  W8A8_SQ_PER_CHANNEL: 8,
  NVFP4: 4,
  NVFP4_AWQ: 4,
  MXFP4: 4,
  MXFP8: 8,
  INT4_AWQ: 4,
  W4A8_AWQ: 4,
  W4A16: 4,
});
const FLOAT_DTYPE_BITS = Object.freeze({ F64: 64, F32: 32, BF16: 16, F16: 16 });
const METHOD_ALIASES = Object.freeze({
  bnb: "bitsandbytes",
  "auto_round": "auto-round",
  autoround: "auto-round",
  compressed_tensors: "compressed-tensors",
  exl2: "exl3",
});

const COPY = Object.freeze({
  none: {
    zh: "没有量化配置（quantization_config 或 hf_quant_config.json），按未量化处理。",
    en: "No quantization config (quantization_config or hf_quant_config.json); treated as unquantized.",
  },
  bitsFromDtype: (dtype) => ({
    zh: `按张量中占比最大的浮点类型 ${dtype} 计算。`,
    en: `From the dominant floating-point tensor dtype, ${dtype}.`,
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value) {
  const number = Number(value);
  return typeof value !== "boolean" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeMethod(value) {
  const method = String(value || "").trim().toLowerCase();
  if (!method) return null;
  return METHOD_ALIASES[method] || method;
}

function upperOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null;
}

// compressed-tensors / ModelOpt config_groups: the first group with weights.
function firstGroup(config) {
  if (!isPlainObject(config?.config_groups)) return null;
  for (const [name, group] of Object.entries(config.config_groups)) {
    if (isPlainObject(group?.weights)) return { name, group };
  }
  return null;
}

function schemeName(group) {
  const weights = group.weights;
  const activations = isPlainObject(group.input_activations) ? group.input_activations : null;
  const wbits = positiveInt(weights.num_bits);
  const abits = activations ? positiveInt(activations.num_bits) : null;
  if (weights.type === "float" && wbits === 4 && positiveInt(weights.group_size) === 16) return "NVFP4";
  if (weights.type === "float" && wbits === 8 && (!activations || (activations.type === "float" && abits === 8))) return "FP8";
  if (!wbits) return null;
  return `W${wbits}A${abits || 16}`;
}

function activationOf(activations) {
  if (!isPlainObject(activations)) return null;
  if (activations.dynamic === true || activations.dynamic === "local") return "dynamic";
  if (activations.dynamic === false) return "static";
  return null;
}

function dominantFloatDtype(byDtype) {
  let best = null;
  for (const [dtype, bytes] of Object.entries(byDtype || {})) {
    if (!FLOAT_DTYPE_BITS[dtype]) continue;
    if (!best || bytes > byDtype[best]) best = dtype;
  }
  return best;
}

function ggufTensorTypeCounts(tensorTypes) {
  return Object.fromEntries(Object.keys(tensorTypes).sort().map((type) => [type, tensorTypes[type]]));
}

/**
 * Writes /quant/*. Inputs: config ({value, pointer} of quantization_config
 * from hf-config), dtype ({value, pointer}), stats (TensorStats), gguf
 * ({kv, file, tensorTypes}).
 */
function detectQuant(inv, facts, { quantization = null, dtype = null, stats = null, gguf = null } = {}) {
  const fileSource = (file, pointer) => ({ kind: "file", ref: pointer ? `${file}#${pointer}` : file });
  if (gguf) {
    const ref = (key) => ({ kind: "gguf", ref: `${gguf.file}#${key}` });
    facts.set("/quant/method", "gguf", { kind: "gguf", ref: gguf.file }, "declared");
    const fileType = positiveInt(gguf.kv["general.file_type"]) ?? (gguf.kv["general.file_type"] === 0 ? 0 : null);
    if (fileType !== null) {
      facts.set("/quant/ggufFileType", fileType, ref("general.file_type"), "declared");
      facts.set("/quant/algo", GGUF_FILE_TYPE_NAMES[fileType] || `type-${fileType}`, ref("general.file_type"), "declared");
    }
    if (gguf.tensorTypes && Object.keys(gguf.tensorTypes).length) {
      facts.set("/quant/ggufTensorTypes", ggufTensorTypeCounts(gguf.tensorTypes), { kind: "tensor-table", ref: `${gguf.file}#tensor_infos` }, "detected");
    }
    return;
  }

  const hfQuant = readJsonFile(inv, "hf_quant_config.json", facts);
  const quantSection = isPlainObject(hfQuant?.quantization) ? hfQuant.quantization : null;
  const config = isPlainObject(quantization?.value) ? quantization.value : null;
  const configPointer = quantization?.pointer || "/quantization_config";
  const configRef = (key) => fileSource("config.json", `${configPointer}/${key}`);
  const group = firstGroup(config);

  if (quantSection) {
    const producer = typeof hfQuant.producer?.name === "string" ? normalizeMethod(hfQuant.producer.name) : "modelopt";
    facts.set("/quant/method", producer, fileSource("hf_quant_config.json", "/producer/name"), "declared");
    const algo = upperOrNull(quantSection.quant_algo);
    if (algo) facts.set("/quant/algo", algo, fileSource("hf_quant_config.json", "/quantization/quant_algo"), "declared");
    const groupBits = group ? positiveInt(group.group.weights.num_bits) : null;
    if (groupBits) facts.set("/quant/weightBits", groupBits, configRef(`config_groups/${group.name}/weights/num_bits`), "declared");
    else if (algo && ALGO_BITS[algo]) facts.set("/quant/weightBits", ALGO_BITS[algo], fileSource("hf_quant_config.json", "/quantization/quant_algo"), "detected");
    const groupSize = positiveInt(quantSection.group_size);
    if (groupSize) facts.set("/quant/groupSize", groupSize, fileSource("hf_quant_config.json", "/quantization/group_size"), "declared");
    const activation = group ? activationOf(group.group.input_activations) : null;
    if (activation) facts.set("/quant/activation", activation, configRef(`config_groups/${group.name}/input_activations/dynamic`), "declared");
    const kvScheme = upperOrNull(quantSection.kv_cache_quant_algo);
    if (kvScheme) facts.set("/quant/kvScheme", kvScheme, fileSource("hf_quant_config.json", "/quantization/kv_cache_quant_algo"), "declared");
    if (Array.isArray(quantSection.exclude_modules)) {
      facts.set("/quant/excludedModules", quantSection.exclude_modules.length, fileSource("hf_quant_config.json", "/quantization/exclude_modules"), "declared");
    }
    return;
  }

  if (config) {
    const method = normalizeMethod(config.quant_method) || (group ? "compressed-tensors" : null);
    if (method) facts.set("/quant/method", method, configRef("quant_method"), "declared");
    let algo = null;
    let bits = null;
    let bitsRef = null;
    let groupSize = null;
    let groupRef = null;
    let activation = null;
    let activationRef = null;
    if (method === "fp8") {
      algo = "FP8";
      bits = 8;
    } else if (method === "modelopt" || method === "compressed-tensors") {
      algo = upperOrNull(config.quant_algo) || (group ? schemeName(group.group) : null);
      if (group) {
        bits = positiveInt(group.group.weights.num_bits);
        bitsRef = configRef(`config_groups/${group.name}/weights/num_bits`);
        groupSize = positiveInt(group.group.weights.group_size);
        groupRef = configRef(`config_groups/${group.name}/weights/group_size`);
        activation = activationOf(group.group.input_activations);
        activationRef = configRef(`config_groups/${group.name}/input_activations`);
      }
    } else if (method === "awq" || method === "gptq" || method === "auto-round") {
      algo = method === "auto-round" ? "AUTOROUND" : method.toUpperCase();
      bits = positiveInt(config.bits ?? config.w_bit);
      groupSize = positiveInt(config.group_size ?? config.q_group_size);
    } else if (method === "bitsandbytes") {
      if (config.load_in_4bit === true) {
        algo = upperOrNull(config.bnb_4bit_quant_type) || "NF4";
        bits = 4;
      } else if (config.load_in_8bit === true) {
        algo = "INT8";
        bits = 8;
      }
    } else if (method === "mxfp4") {
      algo = "MXFP4";
      bits = 4;
    } else if (method === "exl3") {
      algo = "EXL3";
      bits = typeof config.bits === "number" ? config.bits : null;
    }
    if (algo) facts.set("/quant/algo", algo, configRef(method === "modelopt" ? "quant_algo" : "quant_method"), method === "fp8" || method === "mxfp4" ? "detected" : "declared");
    if (bits === null && algo && ALGO_BITS[algo]) bits = ALGO_BITS[algo];
    if (bits !== null) facts.set("/quant/weightBits", bits, bitsRef || configRef("quant_method"), bitsRef ? "declared" : "detected");
    if (groupSize) facts.set("/quant/groupSize", groupSize, groupRef || configRef("group_size"), "declared");
    if (!activation && typeof config.activation_scheme === "string") {
      activation = config.activation_scheme.toLowerCase();
      activationRef = configRef("activation_scheme");
    }
    if (activation === "dynamic" || activation === "static") facts.set("/quant/activation", activation, activationRef, "declared");
    const kvScheme = isPlainObject(config.kv_cache_scheme) ? schemeName({ weights: config.kv_cache_scheme }) : upperOrNull(config.kv_cache_quant_algo);
    if (kvScheme) facts.set("/quant/kvScheme", kvScheme, configRef(isPlainObject(config.kv_cache_scheme) ? "kv_cache_scheme" : "kv_cache_quant_algo"), "declared");
    const excluded = ["modules_to_not_convert", "ignore", "ignored_layers", "exclude_modules"].find((key) => Array.isArray(config[key]));
    if (excluded) facts.set("/quant/excludedModules", config[excluded].length, configRef(excluded), "declared");
    return;
  }

  // "Unquantized" is a conclusion from a config that declares no
  // quantization; without a config.json the method stays unknown.
  if (!stats || !stats.tensorCount || !fileEntry(inv, "config.json")) return;
  facts.set("/quant/method", "none", { kind: "file", ref: "config.json" }, "detected", COPY.none);
  const dominant = dominantFloatDtype(stats.byDtype);
  if (dominant) {
    facts.set("/quant/weightBits", FLOAT_DTYPE_BITS[dominant], { kind: "tensor-table", ref: stats.ref }, "detected", COPY.bitsFromDtype(dominant));
  } else if (dtype && typeof dtype.value === "string") {
    const bits = { float32: 32, bfloat16: 16, float16: 16 }[dtype.value.toLowerCase()];
    if (bits) facts.set("/quant/weightBits", bits, { kind: "file", ref: `config.json#${dtype.pointer}` }, "declared");
  }
}

module.exports = {
  ALGO_BITS,
  detectQuant,
  dominantFloatDtype,
  normalizeMethod,
};
