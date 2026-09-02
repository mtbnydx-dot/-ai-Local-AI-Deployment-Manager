"use strict";

// Groups repositories that carry the same model in different precisions
// (Qwen/Qwen3-32B, Qwen/Qwen3-32B-FP8, RedHatAI/Qwen3-32B-NVFP4, unsloth/
// Qwen3-32B-GGUF ...) and says which engine on this platform can run each
// one directly, so the search result can show the runnable option instead of
// the first hit.

const matrix = require("./model-capability-matrix");
const { getRuntimeRelease } = require("./runtime-manifest");

const PRECISION_TOKENS = [
  ["NVFP4", /(?:^|[-_.])(?:nvfp4|modelopt[-_]?fp4|fp4)(?=$|[-_.])/i],
  ["MXFP4", /(?:^|[-_.])mxfp4(?=$|[-_.])/i],
  ["FP8", /(?:^|[-_.])fp8(?:[-_](?:dynamic|block|kv))?(?=$|[-_.])/i],
  ["AWQ", /(?:^|[-_.])awq(?=$|[-_.])/i],
  ["GPTQ", /(?:^|[-_.])gptq(?:[-_]?int[48])?(?=$|[-_.])/i],
  ["BNB-4bit", /(?:^|[-_.])(?:bnb(?:[-_]4bit)?|bitsandbytes)(?=$|[-_.])/i],
  ["GGUF", /(?:^|[-_.])gguf(?=$|[-_.])/i],
  ["MLX", /(?:^|[-_.])mlx(?:[-_]\d+bit)?(?=$|[-_.])/i],
  ["EXL2", /(?:^|[-_.])exl[23](?=$|[-_.])/i],
  ["INT8", /(?:^|[-_.])(?:int8|w8a8)(?=$|[-_.])/i],
  ["INT4", /(?:^|[-_.])(?:int4|w4a16|nf4)(?=$|[-_.])/i],
];
const ORDER = ["BASE", "NVFP4", "FP8", "MXFP4", "AWQ", "GPTQ", "INT8", "INT4", "GGUF", "BNB-4bit", "MLX", "EXL2"];

function detectPrecision(repoId) {
  const name = String(repoId || "").split("/").pop() || "";
  for (const [label, pattern] of PRECISION_TOKENS) if (pattern.test(name)) return label;
  return "BASE";
}

function baseNameOf(repoId) {
  let name = String(repoId || "").split("/").pop().toLowerCase();
  for (const [, pattern] of PRECISION_TOKENS) name = name.replace(pattern, "");
  return name
    .replace(/(?:^|[-_.])(?:dynamic|block|compressed|quantized|quant|abliterated|uncensored|\d+bit)(?=$|[-_.])/g, "")
    .replace(/[-_.]+/g, "-")
    .replace(/^-|-$/g, "");
}

function engineSupport(precision, options = {}) {
  const vllmRuntime = options.vllmRuntime || getRuntimeRelease("vllm") || {};
  const flashNext = Boolean(options.flashNext);
  const support = { vllm: "ok", sglang: "ok", llama: "block", notes: [] };
  switch (precision) {
    case "GGUF":
      support.llama = "ok";
      support.vllm = "warn";
      support.sglang = "block";
      support.notes.push("GGUF 由 llama.cpp 直接运行；vLLM 只支持单文件 GGUF 且为实验特性。");
      break;
    case "BNB-4bit":
      support.vllm = vllmRuntime.bitsAndBytesPlugin === false ? "block" : "warn";
      support.sglang = "block";
      support.notes.push(vllmRuntime.bitsAndBytesPlugin === false ? "当前 vLLM 镜像没有 vllm-bnb-plugin，BNB 权重被阻断。" : "BNB 加载依赖 vllm-bnb-plugin。");
      break;
    case "MLX":
    case "EXL2":
      support.vllm = "block";
      support.sglang = "block";
      support.notes.push(`${precision} 是其它推理框架的格式，本平台两个引擎都不能加载。`);
      break;
    case "NVFP4":
      support.notes.push(flashNext ? "NVFP4 + Flash-Next 走本地 SGLang SM120 镜像。" : "NVFP4 需要 Blackwell 以上 GPU；vLLM 用 modelopt_fp4 加载。");
      break;
    case "MXFP4":
      support.notes.push("MXFP4 主要用于 gpt-oss；其他模型请确认引擎版本支持。");
      break;
    default:
      break;
  }
  return support;
}

function groupPrecisionVariants(model, candidates, options = {}) {
  const base = baseNameOf(model);
  const seen = new Set();
  const variants = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const id = String(candidate?.id || candidate?.model || candidate || "").trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    if (baseNameOf(id) !== base) continue;
    seen.add(id.toLowerCase());
    const precision = detectPrecision(id);
    const flashNext = matrix.matchesCapabilityEntry("qwen3.8-flash-next", { model: id });
    const support = engineSupport(precision, { ...options, flashNext });
    variants.push({
      id,
      precision,
      isCurrent: id.toLowerCase() === String(model || "").toLowerCase(),
      downloads: Number(candidate?.downloads || 0),
      likes: Number(candidate?.likes || 0),
      gated: Boolean(candidate?.gated),
      hasGguf: Boolean(candidate?.hasGguf),
      support,
      recommendedEngine: support.vllm === "ok" ? "vllm" : support.llama === "ok" ? "llama" : support.vllm === "warn" ? "vllm" : "",
    });
  }
  variants.sort((a, b) => ORDER.indexOf(a.precision) - ORDER.indexOf(b.precision) || b.downloads - a.downloads);
  return { model, base, variants };
}

module.exports = { PRECISION_ORDER: ORDER, baseNameOf, detectPrecision, engineSupport, groupPrecisionVariants };
