(function () {
  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function normalizedOptions(values, fallback) {
    const options = Array.isArray(values) ? values : [fallback];
    return unique(options.map((item) => String(item || "").trim()).filter(Boolean));
  }

  function normalizedPrecisionOptions(values, fallback) {
    return unique(normalizedOptions(values, fallback)
      .map(normalizeDownloadPrecisionOption)
      .filter(Boolean));
  }

  function normalizeDownloadPrecisionOption(value) {
    const normalized = normalizeDownloadQuantValue(value);
    if (!normalized || normalized === "MTP") return "";
    if (normalized === "BASE" || normalized === "BF16" || normalized === "FP16") return "原始 BF16/FP16";
    return normalized;
  }

  function chooseDownloadPrecision(preferred, options, remoteQuantFilter = "") {
    const values = normalizedOptions(options, preferred);
    const remoteQuant = normalizeDownloadQuantValue(remoteQuantFilter);
    const remoteChoice = remoteQuant
      ? values.find((item) => downloadPrecisionMatchesFilter(item, remoteQuant))
      : "";
    if (remoteChoice) return remoteChoice;
    if (values.includes(preferred)) return preferred;
    return values[0] || preferred || "原始 BF16/FP16";
  }

  function downloadPrecisionMatchesFilter(precision, filter) {
    const value = normalizeDownloadQuantValue(precision);
    if (!filter) return true;
    if (filter === "quantized") return value && value !== "BASE" && value !== "GGUF";
    if (filter === "Q4") return value.startsWith("Q4") || value.startsWith("IQ4");
    if (filter === "IQ4") return value.startsWith("IQ4");
    if (filter === "INT4") {
      return value.includes("INT4")
        || value.startsWith("Q4")
        || value.startsWith("IQ4")
        || value === "NF4"
        || value === "NVFP4"
        || value === "MXFP4";
    }
    return value === filter;
  }

  function normalizeDownloadQuantValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/原始|BF16\/FP16|base/i.test(raw)) return "BASE";
    const upper = raw.replace(/\s+/g, "_").replace(/-/g, "_").toUpperCase();
    const aliases = {
      ALL: "",
      AUTO: "",
      ANY: "",
      QUANTIZED: "quantized",
      AWQ_INT4: "AWQ",
      GPTQ_INT4: "GPTQ",
      Q4KM: "Q4_K_M",
      Q5KM: "Q5_K_M",
      Q8: "Q8_0",
      IQ4XS: "IQ4_XS",
      BNB_4BIT: "BNB-4bit",
      MODEL_OPT_FP4: "NVFP4",
      MODELOPT_FP4: "NVFP4",
      NVFP4_FP4: "NVFP4",
      FP4_NVFP4: "NVFP4",
      NVFP4_MTP: "NVFP4",
      MTP_NVFP4: "NVFP4",
      MXFP4_MTP: "MXFP4",
      MTP_MXFP4: "MXFP4",
      FP8_MTP: "FP8",
      MTP_FP8: "FP8",
      MTP_GGUF: "GGUF",
      GGUF_MTP: "GGUF",
    };
    return aliases[upper] ?? upper;
  }

  function inferDownloadSelection(modelId, author, source = "huggingface") {
    const owner = author || String(modelId || "").split("/")[0] || "custom";
    const repoName = String(modelId || "").split("/").filter(Boolean).pop() || String(modelId || "");
    const tokens = repoName.split(/[-_\s]+/).map((token) => token.trim()).filter(Boolean);
    const sizeIndex = tokens.findIndex(isDownloadSizeToken);
    const versionTokens = sizeIndex > 0 ? tokens.slice(0, sizeIndex) : tokens.slice(0, Math.min(tokens.length, 4));
    const specTokens = sizeIndex >= 0 ? collectDownloadSpecTokens(tokens, sizeIndex) : [];
    const precisionTokens = tokens.map(normalizeDownloadPrecisionToken).filter(Boolean);
    return {
      developer: owner,
      modelVersion: unique(versionTokens.filter((token) => !normalizeDownloadPrecisionToken(token))).join(" ") || repoName || modelId,
      spec: unique(specTokens).join(" ") || "未标注规格",
      precision: unique(precisionTokens).join(" ") || "原始 BF16/FP16",
      source,
    };
  }

  function collectDownloadSpecTokens(tokens, sizeIndex) {
    const spec = [tokens[sizeIndex]];
    for (let index = sizeIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (normalizeDownloadPrecisionToken(token)) break;
      if (/^(?:text|chat|instruct|coder|code|vl|vision|audio|base|it|math|reasoning|distill|distilled|sft|rl|reasoner|thinking)$/i.test(token) || /^\d{3,4}$/.test(token)) {
        spec.push(token);
      }
    }
    return spec;
  }

  function normalizeDownloadPrecisionToken(token) {
    const clean = String(token || "").replace(/[^a-zA-Z0-9.]+/g, "").trim();
    if (!clean) return "";
    const upper = clean.toUpperCase();
    if (["AWQ", "GPTQ", "GGUF", "GGML", "EXL2", "EETQ", "HQQ", "AQLM", "NF4", "NVFP4", "MXFP4", "MTP"].includes(upper)) return upper;
    if (/^(?:BF|FP|INT)\d+$/i.test(clean)) return upper;
    if (/^Q\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
    if (/^IQ\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
    return "";
  }

  function isDownloadSizeToken(token) {
    return /^\d+(?:\.\d+)?[BM]$/i.test(String(token || ""))
      || /^\d+(?:\.\d+)?x\d+(?:\.\d+)?[BM]$/i.test(String(token || ""));
  }

  function normalizeSummary(value) {
    if (!value) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  function inferModelQuantLabel(value) {
    const text = String(value || "");
    const lower = text.toLowerCase();
    const gguf = text.match(/\bI?Q\d(?:_[A-Z0-9]+)+\b/i) || text.match(/\bQ\d\b/i);
    if (gguf) return gguf[0].toUpperCase();
    if (lower.includes("nvfp4") || lower.includes("mxfp4") || lower.includes("fp4")) return "NVFP4/FP4";
    if (lower.includes("fp8")) return "FP8";
    if (lower.includes("awq")) return "AWQ";
    if (lower.includes("gptq")) return "GPTQ";
    if (lower.includes("int4") || lower.includes("nf4")) return "INT4/NF4";
    if (lower.includes("bf16")) return "BF16";
    if (lower.includes("fp16")) return "FP16";
    return "";
  }

  function quantBytesForLabel(label) {
    const text = String(label || "").toLowerCase();
    if (text.includes("q2")) return 0.34;
    if (text.includes("q3")) return 0.45;
    if (text.includes("q4") || text.includes("fp4") || text.includes("int4") || text.includes("nf4")) return 0.56;
    if (text.includes("q5")) return 0.68;
    if (text.includes("q6")) return 0.8;
    if (text.includes("q8") || text.includes("fp8")) return 1.05;
    return 2;
  }

  function isManagerRunnableModelItem(item) {
    if (item?.source === "running") return true;
    const text = [
      item?.source,
      item?.label,
      item?.model,
      item?.detail,
      item?.format,
      item?.quantLabel,
      ...(item?.badges || []),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!text.trim()) return false;
    if (isBlockedForVllm(text)) return false;
    if (item?.format === "gguf" || /\.gguf(?:\b|$)/i.test(text) || /\bgguf\b/i.test(text)) return false;
    return true;
  }

  function isManagerRunnableRemoteModel(model) {
    const text = remoteModelCompatibilityText(model);
    if (!model?.id || isBlockedForVllm(text)) return false;
    if (model.hasGguf && !model.hasSafetensors) return false;
    if (/\bgguf\b|\bggml\b/i.test(text) && !model.hasSafetensors) return false;
    return true;
  }

  function remoteModelCompatibilityText(model) {
    return [
      model?.id,
      model?.label,
      model?.author,
      model?.pipelineTag,
      model?.libraryName,
      ...(model?.badges || []),
      ...(model?.quantFormats || []),
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function isBlockedForVllm(text) {
    const lower = String(text || "").toLowerCase();
    return [
      "qwen35moe",
      "gemma4",
      "embedding",
      "embeddings",
      "rerank",
      "sentence-transformers",
      "feature-extraction",
      "text-classification",
      "token-classification",
      "zero-shot-classification",
      "translation",
      "fill-mask",
    ].some((token) => lower.includes(token));
  }

  function modelRemoteSizeMatches(model, size) {
    const params = Number(model.paramsB || 0);
    if (!params) return false;
    if (size === "small") return params <= 8;
    if (size === "medium") return params > 8 && params <= 14;
    if (size === "large") return params > 14 && params <= 32;
    if (size === "xlarge") return params > 32;
    return true;
  }

  function modelRemoteQuantMatches(model, quant) {
    const filter = normalizeDownloadQuantValue(quant);
    if (!filter) return true;
    if (filter === "quantized") return Boolean(model.hasQuantizedFiles);
    const formats = new Set((model.quantFormats || []).map(normalizeDownloadQuantValue).filter(Boolean));
    if (filter === "GGUF") return Boolean(model.hasGguf) || formats.has("GGUF");
    if (formats.has(filter)) return true;
    if (filter === "Q4") return Array.from(formats).some((item) => item.startsWith("Q4") || item.startsWith("IQ4"));
    if (filter === "IQ4") return Array.from(formats).some((item) => item.startsWith("IQ4"));
    if (filter === "INT4") {
      return Array.from(formats).some((item) => item.includes("INT4")
        || item.startsWith("Q4")
        || item.startsWith("IQ4")
        || item === "NF4"
        || item === "NVFP4"
        || item === "MXFP4");
    }
    return false;
  }

  function formatParamsB(value) {
    const number = Number(value || 0);
    if (!number) return "-";
    return `${number >= 10 ? number.toFixed(0) : number.toFixed(1)}B`;
  }

  window.VllmModelUtils = {
    normalizedOptions,
    normalizedPrecisionOptions,
    normalizeDownloadPrecisionOption,
    chooseDownloadPrecision,
    downloadPrecisionMatchesFilter,
    normalizeDownloadQuantValue,
    inferDownloadSelection,
    collectDownloadSpecTokens,
    normalizeDownloadPrecisionToken,
    isDownloadSizeToken,
    normalizeSummary,
    inferModelQuantLabel,
    quantBytesForLabel,
    isManagerRunnableModelItem,
    isManagerRunnableRemoteModel,
    remoteModelCompatibilityText,
    isBlockedForVllm,
    modelRemoteSizeMatches,
    modelRemoteQuantMatches,
    formatParamsB,
  };
})();
