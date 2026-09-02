const fs = require("node:fs");
const path = require("node:path");
const capabilityMatrix = require("../../manager-core/model-capability-matrix");

const SPECULATIVE_MODES = new Set(["off", "auto", "mtp", "qwen3_next_mtp", "ngram", "dspark"]);

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

function isMuseGlimmerModel(config = {}, model = "") {
  const identityValues = [
    config.model_type,
    config.text_config?.model_type,
    config.language_config?.model_type,
    config.llm_config?.model_type,
    ...architectureValues(config),
  ].map((value) => String(value || "").trim()).filter(Boolean);

  // A checkpoint's declared identity is authoritative. Falling back to the
  // path/repository name is only safe when no model identity is present at all.
  if (identityValues.length) {
    return identityValues.some((value) => {
      const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
      return normalized === "museglimmer" || normalized.startsWith("museglimmerfor");
    });
  }

  return normalizedModelNameCandidates(model)
    .some((value) => value.includes("museglimmer"));
}

function architectureValues(config = {}) {
  return [
    config.architectures,
    config.text_config?.architectures,
    config.language_config?.architectures,
    config.llm_config?.architectures,
  ].flatMap((value) => Array.isArray(value) ? value : []);
}

function normalizedModelNameCandidates(model = "") {
  const normalizedPath = String(model || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const parts = normalizedPath.split("/").filter(Boolean);
  const basename = parts.at(-1) || "";
  const repository = parts.length > 1 ? `${parts.at(-2)}/${basename}` : basename;
  return Array.from(new Set([basename, repository]
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)));
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
  if (mode === "dspark") return null;
  const nativeMtp = resolveNativeMtp(config, model, localPath);
  const architecture = architectureName(config).toLowerCase();
  const modelType = String(config.model_type || config.text_config?.model_type || "").toLowerCase();
  const quantMethod = quantizationMethod(config, quantization);
  const text = `${model} ${architecture} ${modelType}`.toLowerCase();
  const isQwen35 = /qwen3_(?:5|6|8)|qwen3\.(?:5|6|8)/.test(text);
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
  if (["mtp", "qwen3_next_mtp"].includes(mode) && !nativeMtp.supported) return null;
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
  const nativeMtp = resolveNativeMtp(config, model, options.localPath);
  const speculativeConfig = resolveSpeculativeConfig({
    model,
    config,
    requestedMode: options.speculativeMode,
    requestedTokens: options.numSpeculativeTokens,
    quantization: options.quantization,
    localPath: options.localPath,
  });
  const capability = capabilityMatrix.resolveModelCapabilityEntry({
    model,
    config,
    ggufArchitecture: options.ggufArchitecture,
    onNameHeuristic: options.onNameHeuristic,
  });
  const engineCapabilities = capability.entry
    ? capabilityMatrix.resolveEngineCapabilities(capability.entry, "vllm", { quantMethod, model })
    : null;
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

  if (isMuseGlimmerModel(config, model)) {
    const transformersVersion = String(config.transformers_version || config.text_config?.transformers_version || "").trim();
    const runtimeDescription = describeRuntimeMetadata(options.runtimeMetadata);
    result.isMuseGlimmer = true;
    result.unsupportedCode = "muse_glimmer";
    result.unsupportedReason = `Muse Glimmer has been retired from this local stack and is not a supported launch target (${runtimeDescription}${transformersVersion ? `; checkpoint Transformers ${transformersVersion}` : ""}). Choose another model; VLLM_ALLOW_MUSE_GLIMMER no longer bypasses this policy.`;
    result.notes.push("Muse Glimmer remains blocked before container creation; no model or image data is deleted by this policy.");
  } else if (engineCapabilities) {
    // Matrix entry: parsers, plugins and environment come from data. The legacy
    // name branches below only run for checkpoints the matrix does not know.
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
    if (engineCapabilities.supported === false) {
      result.unsupportedCode = engineCapabilities.unsupportedCode || "unsupported_model";
      result.unsupportedReason = engineCapabilities.unsupportedReason || `${capability.label} is not supported by the vLLM runtime.`;
    }
    for (const note of Array.isArray(capability.entry.notes) ? capability.entry.notes : []) result.notes.push(note);
    if (capability.heuristic) {
      result.notes.push(`Capability entry "${capability.label}" was matched by model name only; add config.json to the model directory for a declared identity.`);
    }
  } else if (/nemotron[-_ ]?3[-_ ]?nano/.test(text)) {
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
  } else if (/qwen3_(?:5|6|8)|qwen3\.(?:5|6|8)/.test(text)) {
    result.reasoningParser = "qwen3";
    const qwen38 = /qwen3_8|qwen3\.8/.test(text);
    result.toolCallParser = !qwen38 && /modelopt|nvfp4/.test(`${quantMethod} ${model}`.toLowerCase()) ? "qwen3_xml" : "qwen3_coder";
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
    const isModelOptNvfp4 = /modelopt|nvfp4/.test(`${quantMethod} ${model}`.toLowerCase());
    let reason;
    if (nativeMtp.supported && /qwen3_(?:5|6|8)|qwen3\.(?:5|6|8)/.test(text) && isModelOptNvfp4) {
      reason = "Automatic MTP stays off for Qwen ModelOpt/NVFP4 checkpoints; use explicit MTP only after validating startup and acceptance rate on this exact checkpoint/runtime.";
    } else if (engineCapabilities?.speculative?.auto === "off" && engineCapabilities.speculative.reason) {
      reason = engineCapabilities.speculative.reason;
    } else {
      reason = "Speculative decoding stays off because this checkpoint does not declare native MTP support.";
    }
    result.notes.push(reason);
    result.speculativeDecision = { requested: "auto", method: "off", tokens: 0, reason };
  } else if (requestedSpeculativeMode === "dspark") {
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
  findLocalCapabilityFile,
  isMuseGlimmerModel,
  normalizedModelNameCandidates,
  normalizeSpeculativeMode,
  inspectPackagedMtpTensors,
  quantizationMethod,
  resolveNativeMtp,
  resolveSpeculativeConfig,
  resolveVllmModelCapabilities,
};
