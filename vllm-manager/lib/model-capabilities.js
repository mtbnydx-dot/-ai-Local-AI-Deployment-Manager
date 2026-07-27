const fs = require("node:fs");
const path = require("node:path");

const SPECULATIVE_MODES = new Set(["off", "auto", "mtp", "qwen3_next_mtp", "ngram"]);

function normalizeSpeculativeMode(value, fallback = "off") {
  const mode = String(value ?? fallback).trim().toLowerCase().replaceAll("-", "_");
  return SPECULATIVE_MODES.has(mode) ? mode : fallback;
}

function configValue(config = {}, key) {
  return config[key]
    ?? config.text_config?.[key]
    ?? config.language_config?.[key]
    ?? config.llm_config?.[key];
}

function quantizationMethod(config = {}, requested = "") {
  const quant = config.quantization_config || {};
  return String(quant.quant_method || quant.quant_algo || requested || "").trim().toLowerCase();
}

function architectureName(config = {}) {
  return String(Array.isArray(config.architectures) ? config.architectures[0] || "" : "");
}

function resolveNativeMtp(config = {}, model = "") {
  const layers = Number(configValue(config, "mtp_num_hidden_layers") || 0);
  return {
    layers,
    supported: layers > 0 || /(?:^|[-_/])mtp(?:$|[-_/])/i.test(String(model || "")),
  };
}

function resolveSpeculativeConfig(options = {}) {
  const {
    model = "",
    config = {},
    requestedMode = "off",
    requestedTokens = 0,
    quantization = "",
  } = options;
  const mode = normalizeSpeculativeMode(requestedMode);
  if (mode === "off") return null;
  const nativeMtp = resolveNativeMtp(config, model);
  const architecture = architectureName(config).toLowerCase();
  const modelType = String(config.model_type || config.text_config?.model_type || "").toLowerCase();
  const quantMethod = quantizationMethod(config, quantization);
  const text = `${model} ${architecture} ${modelType}`.toLowerCase();
  const isQwen35 = /qwen3[_\-.]?5|qwen3\.6/.test(text);
  const isMoe = /moe/.test(text) || Number(configValue(config, "num_experts") || configValue(config, "n_routed_experts") || 0) > 0;
  const isModelOptNvfp4 = /modelopt|nvfp4/.test(`${quantMethod} ${model}`.toLowerCase());

  if (mode === "ngram") {
    return {
      method: "ngram",
      num_speculative_tokens: clampTokens(requestedTokens, 5),
      prompt_lookup_max: 4,
    };
  }
  if (mode === "auto" && !nativeMtp.supported) return null;
  // NVIDIA's Qwen3.5/3.6 ModelOpt cards do not enable MTP, and affected
  // NVFP4 checkpoints have produced load failures or zero acceptance in vLLM.
  // Keep it available as an explicit opt-in, but never make model switching
  // depend on this experimental combination.
  if (mode === "auto" && isQwen35 && isModelOptNvfp4) return null;

  // Family-specific method names are deprecated in current vLLM and rewritten
  // to `mtp` internally. Emit the stable public method directly.
  const method = mode === "qwen3_next_mtp" ? "mtp" : mode === "auto" ? "mtp" : mode;
  const result = {
    method,
    num_speculative_tokens: clampTokens(requestedTokens, 1),
  };
  if (isMoe && method === "mtp" && isModelOptNvfp4) {
    result.moe_backend = "triton";
  }
  return result;
}

function resolveVllmModelCapabilities(options = {}) {
  const model = String(options.model || "");
  const config = options.config || {};
  const architecture = architectureName(config);
  const modelType = String(config.model_type || config.text_config?.model_type || "");
  const quantMethod = quantizationMethod(config, options.quantization);
  const text = `${model} ${architecture} ${modelType}`.toLowerCase();
  const nativeMtp = resolveNativeMtp(config, model);
  const speculativeConfig = resolveSpeculativeConfig({
    model,
    config,
    requestedMode: options.speculativeMode,
    requestedTokens: options.numSpeculativeTokens,
    quantization: options.quantization,
  });
  const result = {
    architecture,
    modelType,
    quantMethod,
    nativeMtp,
    speculativeConfig,
    reasoningParser: "",
    reasoningParserPlugin: "",
    toolCallParser: "",
    enableAutoToolChoice: false,
    forceTrustRemoteCode: false,
    env: {},
    notes: [],
  };

  if (/nemotron[-_ ]?3[-_ ]?nano/.test(text)) {
    result.reasoningParser = "nano_v3";
    result.toolCallParser = "qwen3_coder";
    result.enableAutoToolChoice = true;
    result.forceTrustRemoteCode = true;
    result.env = {
      VLLM_USE_FLASHINFER_MOE_FP4: "1",
      VLLM_FLASHINFER_MOE_BACKEND: "throughput",
    };
    const plugin = findLocalCapabilityFile(options.localPath, "nano_v3_reasoning_parser.py");
    if (plugin) result.reasoningParserPlugin = plugin;
    else result.unsupportedReason = "Nemotron 3 Nano requires nano_v3_reasoning_parser.py in the local model directory.";
    result.notes.push("Nemotron 3 Nano uses its checkpoint-specific reasoning parser plugin and qwen3_coder tool parser.");
  } else if (/qwen3[_\-.]?5|qwen3\.6/.test(text)) {
    result.reasoningParser = "qwen3";
    result.toolCallParser = /modelopt|nvfp4/.test(`${quantMethod} ${model}`.toLowerCase()) ? "qwen3_xml" : "qwen3_coder";
    result.enableAutoToolChoice = true;
  } else if (/deepseek/.test(text)) {
    result.reasoningParser = "deepseek_r1";
    result.toolCallParser = "deepseek_v3";
    result.enableAutoToolChoice = true;
  } else if (/gemma[_\-.]?4|diffusiongemma/.test(text)) {
    result.reasoningParser = "gemma4";
    result.toolCallParser = "gemma4";
    result.enableAutoToolChoice = true;
  }

  if (speculativeConfig) {
    result.notes.push(`Speculative decoding enabled with ${speculativeConfig.method} and ${speculativeConfig.num_speculative_tokens} draft tokens.`);
  } else if (normalizeSpeculativeMode(options.speculativeMode) === "auto") {
    const isModelOptNvfp4 = /modelopt|nvfp4/.test(`${quantMethod} ${model}`.toLowerCase());
    if (nativeMtp.supported && /qwen3[_\-.]?5|qwen3\.6/.test(text) && isModelOptNvfp4) {
      result.notes.push("Automatic MTP stays off for Qwen ModelOpt/NVFP4 checkpoints; use explicit MTP only after validating startup and acceptance rate on this exact checkpoint/runtime.");
    } else {
      result.notes.push("Speculative decoding stays off because this checkpoint does not declare native MTP support.");
    }
  }
  return result;
}

function findLocalCapabilityFile(localPath, filename) {
  if (!localPath || !path.isAbsolute(localPath)) return "";
  const candidate = path.join(localPath, filename);
  return fs.existsSync(candidate) ? candidate : "";
}

function clampTokens(value, fallback) {
  const number = Number(value || fallback);
  return Math.min(8, Math.max(1, Number.isFinite(number) ? Math.floor(number) : fallback));
}

module.exports = {
  SPECULATIVE_MODES,
  architectureName,
  configValue,
  findLocalCapabilityFile,
  normalizeSpeculativeMode,
  quantizationMethod,
  resolveNativeMtp,
  resolveSpeculativeConfig,
  resolveVllmModelCapabilities,
};
