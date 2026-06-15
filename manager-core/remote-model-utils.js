const { normalizeRemoteQuantFilter } = require("./download-utils");

const DEFAULT_REMOTE_PRECISION_ORDER = [
  "NVFP4",
  "MXFP4",
  "FP8",
  "Q4_K_M",
  "Q5_K_M",
  "Q8_0",
  "IQ4_XS",
  "Q4",
  "IQ4",
  "AWQ",
  "GPTQ",
  "NF4",
  "INT4",
  "BNB-4bit",
  "GGUF",
  "原始 BF16/FP16",
];

const DEFAULT_REMOTE_QUANT_KEYWORDS = [
  ["nvfp4", "NVFP4"],
  ["mxfp4", "MXFP4"],
  ["fp8", "FP8"],
  ["awq", "AWQ"],
  ["gptq", "GPTQ"],
  ["gguf", "GGUF"],
  ["nf4", "NF4"],
  ["int4", "INT4"],
  ["int8", "INT8"],
  ["bf16", "BF16"],
  ["fp16", "FP16"],
];

function unique(values) {
  return Array.from(new Set(values));
}

function remoteQuantSearchTerm(quantFilter) {
  const value = normalizeRemoteQuantFilter(quantFilter);
  if (!value || value === "quantized") return "";
  if (value === "Q4") return "Q4_K_M";
  if (value === "IQ4") return "IQ4_XS";
  return value;
}

function remoteSearchesWithQuant(searches, quantFilter) {
  const base = (searches || []).map((item) => String(item || "").trim());
  const term = remoteQuantSearchTerm(quantFilter);
  if (!term) return base;
  const hasSpecificSearch = base.some(Boolean);
  if (hasSpecificSearch) {
    return unique([
      ...base.map((item) => item ? `${item} ${term}` : term),
      ...base,
    ]);
  }
  return [term];
}

function remoteFamilyKey(model) {
  const repo = String(model?.id || "").split("/").pop() || "";
  return repo.toLowerCase()
    .replace(/\b(?:awq|gptq|gguf|fp8|nvfp4|mxfp4|int4|int8|bf16|fp16|q\d(?:_[a-z0-9]+)*)\b/g, "")
    .replace(/[-_\s]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isAfterDate(value, cutoff) {
  const date = new Date(value || "");
  const threshold = new Date(cutoff);
  if (Number.isNaN(date.getTime()) || Number.isNaN(threshold.getTime())) return false;
  return date >= threshold;
}

function matchesRemoteSizeFilter(model, filter) {
  const params = Number(model?.paramsB || 0);
  if (!params) return false;
  if (filter === "small") return params <= 8;
  if (filter === "medium") return params > 8 && params <= 14;
  if (filter === "large") return params > 14 && params <= 32;
  if (filter === "xlarge") return params > 32;
  return true;
}

function remoteQuantSet(model) {
  return new Set((model?.quantFormats || []).map((item) => normalizeRemoteQuantFilter(item)).filter(Boolean));
}

function matchesRemoteQuantFilter(model, filter) {
  const value = normalizeRemoteQuantFilter(filter);
  if (!value) return true;
  if (value === "quantized") return Boolean(model?.hasQuantizedFiles);
  if (value === "GGUF") return Boolean(model?.hasGguf) || remoteQuantSet(model).has("GGUF");
  const formats = remoteQuantSet(model);
  if (formats.has(value)) return true;
  if (value === "Q4") return Array.from(formats).some((item) => item.startsWith("Q4") || item.startsWith("IQ4"));
  if (value === "IQ4") return Array.from(formats).some((item) => item.startsWith("IQ4"));
  if (value === "INT4") {
    return Array.from(formats).some((item) => item.includes("INT4")
      || item.startsWith("Q4")
      || item.startsWith("IQ4")
      || item === "NF4"
      || item === "NVFP4"
      || item === "MXFP4");
  }
  return false;
}

function hasQuantizedRemoteFiles(formats) {
  return (formats || []).some((format) => !["BF16", "FP16"].includes(String(format).toUpperCase()));
}

function inferRemoteParamsB(text) {
  const matches = Array.from(String(text || "").matchAll(/(?:^|[-_\s])(?:A)?(\d+(?:\.\d+)?)([BM])(?:[-_\s]|$)/gi));
  if (!matches.length) return null;
  const values = matches.map((match) => {
    const value = Number(match[1]);
    return match[2].toUpperCase() === "M" ? value / 1000 : value;
  }).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function remoteSizeClass(paramsB) {
  const params = Number(paramsB || 0);
  if (!params) return "";
  if (params <= 8) return "small";
  if (params <= 14) return "medium";
  if (params <= 32) return "large";
  return "xlarge";
}

function isUncensoredText(text) {
  return /(uncensored|abliterat|unfiltered|no[-_\s]?filter|nofilter|uncens)/i.test(String(text || ""));
}

function inferRemoteQuantFormats({ id, tags = [], siblings = [], keywords = DEFAULT_REMOTE_QUANT_KEYWORDS }) {
  const text = `${id} ${tags.join(" ")} ${siblings.map((item) => item.rfilename || "").join(" ")}`;
  const formats = new Set();
  for (const match of text.matchAll(/\bI?Q[2-8](?:_[A-Z0-9]+)*\b/gi)) formats.add(match[0].toUpperCase());
  const lower = text.toLowerCase();
  for (const [needle, label] of keywords || []) {
    if (lower.includes(String(needle).toLowerCase())) formats.add(label);
  }
  return Array.from(formats);
}

function inferModelSelection({
  id,
  author,
  tags = [],
  siblings = [],
  source = "huggingface",
  quantFormats = [],
  precisionOrder = DEFAULT_REMOTE_PRECISION_ORDER,
}) {
  const owner = author || String(id || "").split("/")[0] || "custom";
  const repoName = String(id || "").split("/").filter(Boolean).pop() || String(id || "");
  const tokens = repoName.split(/[-_\s]+/).map((token) => token.trim()).filter(Boolean);
  const sizeIndex = tokens.findIndex(isSizeToken);
  const precisionTokens = collectPrecisionTokens(tokens);
  const tagPrecisionTokens = collectPrecisionTokens(tags.map(String));
  const fileText = siblings.map((item) => item.rfilename || "").join(" ");
  const lowerAll = `${id} ${tags.join(" ")} ${fileText}`.toLowerCase();

  const developer = prettyDeveloper(owner);
  const modelVersion = titleJoin(sizeIndex > 0
    ? tokens.slice(0, sizeIndex).filter((token) => !isPrecisionToken(token))
    : leadingVersionTokens(tokens));
  const spec = titleJoin(sizeIndex >= 0
    ? collectSpecTokens(tokens, sizeIndex)
    : []);
  const detectedPrecision = titleJoin([...precisionTokens, ...tagPrecisionTokens])
    || precisionFromText(lowerAll)
    || "原始 BF16/FP16";
  const precisionOptions = buildRemotePrecisionOptions(detectedPrecision, quantFormats, precisionOrder);
  const precision = precisionOptions[0] || detectedPrecision;

  const result = {
    developer,
    modelVersion: modelVersion || repoName || String(id || ""),
    spec: spec || "未标注规格",
    precision,
    source,
  };

  return {
    ...result,
    options: {
      developers: [result.developer],
      modelVersions: [result.modelVersion],
      specs: [result.spec],
      precisions: precisionOptions,
    },
  };
}

function buildRemotePrecisionOptions(preferred, formats = [], order = DEFAULT_REMOTE_PRECISION_ORDER) {
  const normalized = unique([
    ...(formats || []).flatMap(remotePrecisionLabelsFromValue),
    ...remotePrecisionLabelsFromValue(preferred),
  ].filter(Boolean));
  const options = normalized.length ? normalized : ["原始 BF16/FP16"];
  return options.sort((a, b) => remotePrecisionSortRank(a, order) - remotePrecisionSortRank(b, order) || a.localeCompare(b));
}

function remotePrecisionSortRank(value, order = DEFAULT_REMOTE_PRECISION_ORDER) {
  if (value === "GGUF") return 900;
  if (value === "原始 BF16/FP16") return 950;
  const explicit = order.indexOf(value);
  if (explicit >= 0) return explicit;
  if (/^Q8/.test(value)) return 80;
  if (/^Q6/.test(value)) return 90;
  if (/^Q5/.test(value)) return 100;
  if (/^Q4/.test(value) || /^IQ4/.test(value)) return 110;
  if (/^Q3/.test(value) || /^IQ3/.test(value)) return 120;
  if (/^Q2/.test(value) || /^IQ2/.test(value)) return 130;
  return 500;
}

function normalizeRemotePrecisionLabel(value) {
  return remotePrecisionLabelsFromValue(value)[0] || "";
}

function remotePrecisionLabelsFromValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (/原始|BF16\/FP16|base/i.test(raw)) return ["原始 BF16/FP16"];
  const lower = raw.toLowerCase();
  const labels = [];
  const add = (label) => {
    if (!label || label === "MTP") return;
    if (/原始|BF16\/FP16|^BF16$|^FP16$|^BASE$/i.test(label)) {
      labels.push("原始 BF16/FP16");
      return;
    }
    const normalized = normalizeRemoteQuantFilter(label);
    if (!normalized) return;
    if (normalized === "BF16" || normalized === "FP16" || normalized === "BASE") labels.push("原始 BF16/FP16");
    else labels.push(normalized);
  };
  for (const match of raw.matchAll(/\bI?Q[2-8](?:_[A-Z0-9]+)*\b/gi)) add(match[0]);
  [
    ["nvfp4", "NVFP4"],
    ["mxfp4", "MXFP4"],
    ["fp8", "FP8"],
    ["awq", "AWQ"],
    ["gptq", "GPTQ"],
    ["gguf", "GGUF"],
    ["nf4", "NF4"],
    ["int4", "INT4"],
    ["int8", "INT8"],
    ["bf16", "原始 BF16/FP16"],
    ["fp16", "原始 BF16/FP16"],
  ].forEach(([needle, label]) => {
    if (lower.includes(needle)) add(label);
  });
  if (!labels.length) add(raw);
  return unique(labels);
}

function prettyDeveloper(owner) {
  const value = String(owner || "").trim() || "custom";
  const normalized = value.toLowerCase();
  const known = {
    qwen: "Qwen",
    qwenlm: "Qwen",
    "deepseek-ai": "DeepSeek",
    "meta-llama": "Meta",
    google: "Google",
    mistralai: "Mistral",
    microsoft: "Microsoft",
    nvidia: "NVIDIA",
    openai: "OpenAI",
    "01-ai": "01.AI",
  };
  return known[normalized] || value;
}

function leadingVersionTokens(tokens) {
  const precisionIndex = tokens.findIndex(isPrecisionToken);
  const end = precisionIndex > 0 ? precisionIndex : Math.min(tokens.length, 4);
  return tokens.slice(0, end).filter((token) => !isPrecisionToken(token));
}

function collectSpecTokens(tokens, sizeIndex) {
  const spec = [tokens[sizeIndex]];
  for (let index = sizeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isPrecisionToken(token)) break;
    if (isVersionSuffixToken(token) || isModelVariantToken(token) || isSizeToken(token)) {
      spec.push(token);
      continue;
    }
    if (/^\d{3,4}$/.test(token)) spec.push(token);
  }
  if (tokens[sizeIndex + 1] && /^A?\d+(?:\.\d+)?[BM]$/i.test(tokens[sizeIndex + 1])) {
    spec.push(tokens[sizeIndex + 1]);
  }
  return spec;
}

function collectPrecisionTokens(tokens) {
  const seen = new Set();
  return tokens
    .map((token) => normalizePrecisionToken(token))
    .filter(Boolean)
    .filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function precisionFromText(lower) {
  if (lower.includes("nvfp4")) return "NVFP4";
  if (lower.includes("mxfp4")) return "MXFP4";
  if (lower.includes("fp8")) return "FP8";
  if (lower.includes("awq")) return "AWQ INT4";
  if (lower.includes("gptq")) return "GPTQ INT4";
  if (lower.includes("gguf")) return "GGUF";
  if (lower.includes("nf4")) return "NF4";
  if (lower.includes("int8")) return "INT8";
  if (lower.includes("int4")) return "INT4";
  return "";
}

function normalizePrecisionToken(token) {
  const clean = String(token || "").replace(/[^a-zA-Z0-9.]+/g, "").trim();
  if (!clean) return "";
  const upper = clean.toUpperCase();
  if (["AWQ", "GPTQ", "GGUF", "GGML", "EXL2", "EETQ", "HQQ", "AQLM", "NF4", "NVFP4", "MXFP4", "MTP"].includes(upper)) {
    return upper;
  }
  if (/^(?:BF|FP|INT)\d+$/i.test(clean)) return upper;
  if (/^Q\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
  if (/^IQ\d(?:[A-Z0-9]+)?$/i.test(clean)) return upper;
  return "";
}

function isPrecisionToken(token) {
  return Boolean(normalizePrecisionToken(token));
}

function isSizeToken(token) {
  return /^\d+(?:\.\d+)?[BM]$/i.test(String(token || ""))
    || /^\d+(?:\.\d+)?x\d+(?:\.\d+)?[BM]$/i.test(String(token || ""));
}

function isModelVariantToken(token) {
  return /^(?:text|chat|instruct|coder|code|vl|vision|audio|base|it|math|reasoning|distill|distilled|sft|rl|reasoner|thinking)$/i.test(String(token || ""));
}

function isVersionSuffixToken(token) {
  return /^(?:a?\d+(?:\.\d+)?[bm]?|\d{3,4})$/i.test(String(token || ""));
}

function titleJoin(tokens) {
  return Array.from(new Set((tokens || []).filter(Boolean))).join(" ").trim();
}

function parseModelReference(input) {
  const text = String(input || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    if (/^[^/\s]+\/[^/\s]+$/.test(text)) {
      return {
        source: "huggingface",
        model: text,
        url: `https://huggingface.co/${text}`,
      };
    }
    const error = new Error("请输入 Hugging Face / ModelScope 模型介绍页链接，或 owner/model 形式的模型 ID。");
    error.status = 400;
    throw error;
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf-mirror.com") {
    const cleanParts = parts[0] === "models" ? parts.slice(1) : parts;
    if (cleanParts.length >= 2) {
      const model = `${cleanParts[0]}/${cleanParts[1]}`;
      return { source: "huggingface", model, url: `https://huggingface.co/${model}` };
    }
  }

  if (host.includes("modelscope.cn")) {
    const modelIndex = parts.indexOf("models");
    const cleanParts = modelIndex >= 0 ? parts.slice(modelIndex + 1) : parts;
    if (cleanParts.length >= 2) {
      const model = `${cleanParts[0]}/${cleanParts[1]}`;
      return { source: "modelscope", model, url: `https://modelscope.cn/models/${model}` };
    }
  }

  const error = new Error("没有从链接中识别出模型 ID。请使用模型介绍页地址，例如 https://huggingface.co/Qwen/Qwen3-8B。");
  error.status = 400;
  throw error;
}

function encodeRepoId(repoId) {
  return String(repoId).split("/").map(encodeURIComponent).join("/");
}

function deriveName(model) {
  const normalized = String(model || "").replace(/[\\/]+$/g, "");
  const leaf = normalized.split(/[\\/]/).filter(Boolean).pop() || "model";
  return leaf.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

module.exports = {
  DEFAULT_REMOTE_PRECISION_ORDER,
  DEFAULT_REMOTE_QUANT_KEYWORDS,
  remoteSearchesWithQuant,
  remoteQuantSearchTerm,
  remoteFamilyKey,
  isAfterDate,
  matchesRemoteSizeFilter,
  matchesRemoteQuantFilter,
  remoteQuantSet,
  hasQuantizedRemoteFiles,
  inferRemoteParamsB,
  remoteSizeClass,
  isUncensoredText,
  inferRemoteQuantFormats,
  inferModelSelection,
  buildRemotePrecisionOptions,
  remotePrecisionSortRank,
  normalizeRemotePrecisionLabel,
  remotePrecisionLabelsFromValue,
  prettyDeveloper,
  normalizePrecisionToken,
  isPrecisionToken,
  isSizeToken,
  parseModelReference,
  encodeRepoId,
  deriveName,
};
