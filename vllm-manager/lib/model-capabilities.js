const fs = require("node:fs");
const path = require("node:path");
const capabilityMatrix = require("../../manager-core/model-capability-matrix");

const SPECULATIVE_MODES = new Set(["off", "auto", "mtp", "qwen3_next_mtp", "ngram", "dspark"]);
// The native MTP modes, and the public vLLM method each mode emits: the
// family-specific method name is deprecated in vLLM and rewritten to `mtp`.
const MTP_MODES = new Set(["mtp", "qwen3_next_mtp"]);
const SPECULATIVE_METHODS = Object.freeze({ auto: "mtp", qwen3_next_mtp: "mtp" });
// DSpark is a draft-model method that runs inside SGLang, not a model family.
const DSPARK_MODE = "dspark";

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

function describeRuntimeMetadata(metadata = null) {
  const runtimeVersion = String(metadata?.version || "").trim();
  const transformersVersion = String(metadata?.transformersVersion || "").trim();
  return `${runtimeVersion ? `vLLM ${runtimeVersion}` : "the configured vLLM runtime"} / ${transformersVersion ? `Transformers ${transformersVersion}` : "an unverified Transformers version"}`;
}

function inspectPackagedMtpTensors(localPath = "") {
  if (!localPath || !path.isAbsolute(localPath) || !fs.existsSync(localPath)) {
    return { known: false, tensorCount: 0, source: "" };
  }
  try {
    const stat = fs.statSync(localPath);
    const directory = stat.isDirectory() ? localPath : path.dirname(localPath);
    const indexes = fs.readdirSync(directory)
      .filter((name) => /\.safetensors\.index\.json$/i.test(name));
    if (indexes.length) {
      let tensorCount = 0;
      for (const name of indexes) {
        const index = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        tensorCount += Object.keys(index?.weight_map || {})
          .filter((key) => /(^|\.)mtp(\.|$)/i.test(key)).length;
      }
      return { known: true, tensorCount, source: indexes.join(", ") };
    }

    const files = stat.isFile() && /\.safetensors$/i.test(localPath)
      ? [localPath]
      : fs.readdirSync(directory)
        .filter((name) => /\.safetensors$/i.test(name))
        .map((name) => path.join(directory, name));
    if (!files.length) return { known: false, tensorCount: 0, source: "" };
    let tensorCount = 0;
    for (const file of files) {
      const handle = fs.openSync(file, "r");
      try {
        const lengthBuffer = Buffer.alloc(8);
        if (fs.readSync(handle, lengthBuffer, 0, 8, 0) !== 8) continue;
        const headerLength = Number(lengthBuffer.readBigUInt64LE(0));
        if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength > 256 * 1024 * 1024) continue;
        const headerBuffer = Buffer.alloc(headerLength);
        if (fs.readSync(handle, headerBuffer, 0, headerLength, 8) !== headerLength) continue;
        const header = JSON.parse(headerBuffer.toString("utf8"));
        tensorCount += Object.keys(header)
          .filter((key) => key !== "__metadata__" && /(^|\.)mtp(\.|$)/i.test(key)).length;
      } finally {
        fs.closeSync(handle);
      }
    }
    return { known: true, tensorCount, source: `${files.length} safetensors header(s)` };
  } catch {
    return { known: false, tensorCount: 0, source: "" };
  }
}

function resolveNativeMtp(config = {}, model = "", localPath = "") {
  const layers = Number(configValue(config, "mtp_num_hidden_layers") || 0);
  const packaged = inspectPackagedMtpTensors(localPath);
  const explicitCheckpoint = /(?:^|[-_/])mtp(?:$|[-_/])/i.test(String(model || ""));
  return {
    layers,
    declared: layers > 0,
    tensorCount: packaged.tensorCount,
    evidence: packaged.source,
    inspected: packaged.known,
    supported: packaged.tensorCount > 0 || (!packaged.known && explicitCheckpoint),
  };
}

// The family entry (families v2 through the capability matrix shim) and its
// vLLM section resolved for this checkpoint's quantization.
function resolveFamilyCapabilities({ model = "", config = {}, quantization = "", ggufArchitecture, onNameHeuristic } = {}) {
  const capability = capabilityMatrix.resolveModelCapabilityEntry({ model, config, ggufArchitecture, onNameHeuristic });
  const engineCapabilities = capability.entry
    ? capabilityMatrix.resolveEngineCapabilities(capability.entry, "vllm", { quantMethod: quantizationMethod(config, quantization), model })
    : null;
  return { capability, engineCapabilities };
}

function resolveSpeculativeConfig(options = {}) {
  const {
    model = "",
    config = {},
    requestedMode = "off",
    requestedTokens = 0,
    quantization = "",
    localPath = "",
  } = options;
  const mode = normalizeSpeculativeMode(requestedMode);
  if (mode === "off") return null;
  if (mode === DSPARK_MODE) return null;
  const nativeMtp = resolveNativeMtp(config, model, localPath);
  const architecture = architectureName(config).toLowerCase();
  const modelType = String(config.model_type || config.text_config?.model_type || "").toLowerCase();
  const quantMethod = quantizationMethod(config, quantization);
  const text = `${model} ${architecture} ${modelType}`.toLowerCase();
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
  if (MTP_MODES.has(mode) && !nativeMtp.supported) return null;
  // Auto mode follows the family's vLLM speculative default (families data):
  // a family may keep it off, or keep it off for some quantizations (the
  // Qwen3.5-3.8 ModelOpt/NVFP4 checkpoints, whose MTP has produced load
  // failures or zero acceptance in vLLM). An explicit mode stays an opt-in.
  if (mode === "auto") {
    const { engineCapabilities } = options.family || resolveFamilyCapabilities({ model, config, quantization });
    if (engineCapabilities?.speculative?.auto === "off") return null;
  }

  // Emit the stable public method name directly.
  const method = SPECULATIVE_METHODS[mode] || mode;
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
  const nativeMtp = resolveNativeMtp(config, model, options.localPath);
  const family = resolveFamilyCapabilities({
    model,
    config,
    quantization: options.quantization,
    ggufArchitecture: options.ggufArchitecture,
    onNameHeuristic: options.onNameHeuristic,
  });
  const { capability, engineCapabilities } = family;
  const speculativeConfig = resolveSpeculativeConfig({
    model,
    config,
    requestedMode: options.speculativeMode,
    requestedTokens: options.numSpeculativeTokens,
    quantization: options.quantization,
    localPath: options.localPath,
    family,
  });
  const result = {
    architecture,
    modelType,
    quantMethod,
    nativeMtp,
    speculativeConfig,
    speculativeDecision: null,
    capabilityEntry: {
      id: capability.id,
      label: capability.label,
      matchedBy: capability.matchedBy,
      heuristic: capability.heuristic,
      confidence: capability.confidence,
    },
    reasoningParser: "",
    reasoningParserPlugin: "",
    toolCallParser: "",
    enableAutoToolChoice: false,
    forceTrustRemoteCode: false,
    unsupportedCode: "",
    isMuseGlimmer: false,
    museGlimmerOverride: false,
    runtimeMetadata: options.runtimeMetadata || null,
    env: {},
    notes: [],
  };

  if (engineCapabilities?.supported === false) {
    // A family the vLLM runtime refuses (support "blocked" in the families
    // data, Muse Glimmer today). The reason names the runtime and checkpoint
    // versions, and no environment flag bypasses it. isMuseGlimmer (and its
    // always-false override flag) are the legacy names of this verdict, kept
    // in the result shape the 01 preset goldens record.
    const transformersVersion = String(config.transformers_version || config.text_config?.transformers_version || "").trim();
    const runtimeDescription = describeRuntimeMetadata(options.runtimeMetadata);
    const code = engineCapabilities.unsupportedCode || "unsupported_model";
    const reason = String(engineCapabilities.unsupportedReason || `${capability.label} is not a supported vLLM launch target.`).trim().replace(/\.$/, "");
    result.isMuseGlimmer = true;
    result.unsupportedCode = code;
    result.unsupportedReason = `${reason} (${runtimeDescription}${transformersVersion ? `; checkpoint Transformers ${transformersVersion}` : ""}). Choose another model; VLLM_ALLOW_${code.toUpperCase()} no longer bypasses this policy.`;
    result.notes.push(`${capability.label} remains blocked before container creation; no model or image data is deleted by this policy.`);
  } else if (engineCapabilities) {
    // Families data: parsers, plugins and environment. A checkpoint no family
    // matches keeps the empty defaults; no model name is matched here (D5).
    if (engineCapabilities.reasoningParser) result.reasoningParser = engineCapabilities.reasoningParser;
    if (engineCapabilities.toolCallParser) result.toolCallParser = engineCapabilities.toolCallParser;
    if (engineCapabilities.enableAutoToolChoice) result.enableAutoToolChoice = true;
    if (engineCapabilities.forceTrustRemoteCode) result.forceTrustRemoteCode = true;
    if (engineCapabilities.env && typeof engineCapabilities.env === "object") result.env = { ...engineCapabilities.env };
    if (engineCapabilities.requiredPluginFile) {
      const plugin = findLocalCapabilityFile(options.localPath, engineCapabilities.requiredPluginFile);
      if (plugin) result.reasoningParserPlugin = plugin;
      else result.unsupportedReason = `${capability.label} requires ${engineCapabilities.requiredPluginFile} in the local model directory.`;
    }
    for (const note of Array.isArray(capability.entry.notes) ? capability.entry.notes : []) result.notes.push(note);
    if (capability.heuristic) {
      result.notes.push(`Capability entry "${capability.label}" was matched by model name only; add config.json to the model directory for a declared identity.`);
    }
  }

  if (/^(?:bitsandbytes|bnb)(?:$|[_-])/.test(quantMethod) && options.runtimeMetadata?.bitsAndBytesPlugin === false) {
    result.unsupportedCode = "bitsandbytes_plugin_missing";
    result.unsupportedReason = `${describeRuntimeMetadata(options.runtimeMetadata)} no longer bundles BitsAndBytes loading; this verified image does not contain vllm-bnb-plugin. Install that plugin in a separate derived image or use a non-BNB checkpoint.`;
    result.notes.push("vLLM 0.28 moved BitsAndBytes loading to the out-of-tree vllm-bnb-plugin package.");
  }

  const requestedSpeculativeMode = normalizeSpeculativeMode(options.speculativeMode);
  if (speculativeConfig) {
    result.notes.push(`Speculative decoding enabled with ${speculativeConfig.method} and ${speculativeConfig.num_speculative_tokens} draft tokens.`);
    result.speculativeDecision = {
      requested: requestedSpeculativeMode,
      method: speculativeConfig.method,
      tokens: speculativeConfig.num_speculative_tokens,
      reason: requestedSpeculativeMode === "auto"
        ? `Auto mode: ${nativeMtp.tensorCount ? `${nativeMtp.tensorCount} packaged MTP tensors were found` : "the checkpoint declares native MTP"}${engineCapabilities?.speculative?.reason ? `; ${engineCapabilities.speculative.reason}` : ""}`
        : `Explicitly requested ${requestedSpeculativeMode}; validate acceptance rate and throughput on this checkpoint.`,
    };
  } else if (requestedSpeculativeMode === "auto") {
    let reason;
    if (engineCapabilities?.speculative?.auto === "off" && engineCapabilities.speculative.reason) {
      reason = engineCapabilities.speculative.reason;
    } else {
      reason = "Speculative decoding stays off because this checkpoint does not declare native MTP support.";
    }
    result.notes.push(reason);
    result.speculativeDecision = { requested: "auto", method: "off", tokens: 0, reason };
  } else if (requestedSpeculativeMode === DSPARK_MODE) {
    result.speculativeDecision = { requested: "dspark", method: "dspark", tokens: 0, reason: "DSpark draft model runs inside SGLang; vLLM does not receive a speculative config." };
  } else {
    result.speculativeDecision = {
      requested: requestedSpeculativeMode,
      method: "off",
      tokens: 0,
      reason: requestedSpeculativeMode === "off"
        ? "Speculative decoding is off in this profile."
        : `${requestedSpeculativeMode} was requested but this checkpoint has no usable draft head, so it stays off.`,
    };
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
  DSPARK_MODE,
  findLocalCapabilityFile,
  MTP_MODES,
  normalizeSpeculativeMode,
  inspectPackagedMtpTensors,
  quantizationMethod,
  resolveNativeMtp,
  resolveSpeculativeConfig,
  resolveVllmModelCapabilities,
};
