(function () {
const DOWNLOAD_SOURCES = {
  huggingface: {
    label: "Hugging Face",
    hint: "Hugging Face 通用性最好，私有或 gated 模型需要提前配置 HF_TOKEN。",
  },
  modelscope: {
    label: "ModelScope 魔搭",
    hint: "ModelScope 在国内网络环境通常更顺手，需要本机可调用 modelscope CLI。",
  },
};

const PRECISION_PRESETS = [
  { value: "gguf", label: "GGUF 全部", quantFilter: "gguf", launchQuantization: "" },
  { value: "q4_k_m", label: "Q4_K_M", quantFilter: "q4_k_m", launchQuantization: "" },
  { value: "iq4_xs", label: "IQ4_XS", quantFilter: "iq4_xs", launchQuantization: "" },
  { value: "q5_k_m", label: "Q5_K_M", quantFilter: "q5_k_m", launchQuantization: "" },
  { value: "q6_k", label: "Q6_K", quantFilter: "q6_k", launchQuantization: "" },
  { value: "q8_0", label: "Q8_0", quantFilter: "q8_0", launchQuantization: "" },
  { value: "q3_k_m", label: "Q3_K_M", quantFilter: "q3_k_m", launchQuantization: "" },
  { value: "q2_k", label: "Q2_K", quantFilter: "q2_k", launchQuantization: "" },
  { value: "base", label: "原始仓库 / 不筛选", quantFilter: "", launchQuantization: "" },
];

const MODEL_PRESETS = [
  { developer: "Qwen", version: "Qwen3", spec: "0.6B", repo: "Qwen/Qwen3-0.6B", note: "轻量验证和低显存测试。" },
  { developer: "Qwen", version: "Qwen3", spec: "4B", repo: "Qwen/Qwen3-4B", note: "单卡友好的日常中文模型。" },
  { developer: "Qwen", version: "Qwen3", spec: "8B", repo: "Qwen/Qwen3-8B", note: "质量和速度比较均衡。" },
  { developer: "Qwen", version: "Qwen3", spec: "14B", repo: "Qwen/Qwen3-14B", note: "更强推理，建议高显存或量化。" },
  { developer: "Qwen", version: "Qwen3", spec: "32B", repo: "Qwen/Qwen3-32B", note: "适合多卡或量化部署。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "7B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", note: "推理蒸馏小规格。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "14B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", note: "推理能力更稳，显存需求更高。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "32B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", note: "建议多卡或量化版本。" },
  { developer: "Meta", version: "Llama 3.1 Instruct", spec: "8B", repo: "meta-llama/Meta-Llama-3.1-8B-Instruct", note: "英文和通用任务稳定，可能需要授权 token。" },
  { developer: "Google", version: "Gemma 3 IT", spec: "4B", repo: "google/gemma-3-4b-it", note: "轻量 instruction 模型，可能需要授权 token。" },
  { developer: "Mistral", version: "Small Instruct", spec: "24B", repo: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", note: "中等规模通用模型，建议高显存。" },
];

const DTYPE_BYTES = {
  auto: 2,
  bfloat16: 2,
  float16: 2,
  float32: 4,
};

const KV_DTYPE_BYTES = {
  auto: null,
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1,
  q5_1: 0.7,
  q5_0: 0.66,
  q4_1: 0.58,
  q4_0: 0.52,
  iq4_nl: 0.52,
  fp8: 1,
  fp8_e5m2: 1,
  fp8_e4m3: 1,
};

const QUANTIZATION_PROFILES = {
  "": { label: "Auto", bytesPerParam: null, note: "按模型配置或 dtype 估算" },
  awq: { label: "AWQ INT4", bytesPerParam: 0.58, note: "4-bit 权重量化，另含 scale/zero 开销" },
  gptq: { label: "GPTQ INT4", bytesPerParam: 0.58, note: "4-bit 权重量化，另含 scale 开销" },
  bitsandbytes: { label: "BitsAndBytes 4-bit", bytesPerParam: 0.62, note: "通常按 NF4/INT4 估算" },
  fp8: { label: "FP8", bytesPerParam: 1.08, note: "FP8 权重，预留少量 scale 开销" },
  modelopt: { label: "ModelOpt FP8", bytesPerParam: 1.08, note: "ModelOpt FP8 权重" },
  modelopt_fp4: { label: "NVFP4", bytesPerParam: 0.62, note: "FP4 权重，预留 scale 开销" },
  "compressed-tensors": { label: "Compressed", bytesPerParam: 0.62, note: "按常见 4-bit 压缩估算" },
};

const ICON_FALLBACKS = {
  activity: "~",
  database: "DB",
  download: "DL",
  terminal: ">_",
  wrench: "TOOL",
  "badge-check": "OK",
  "refresh-cw": "R",
  "rotate-cw": "R",
  "scroll-text": "LOG",
  play: ">",
  square: "STOP",
  send: ">",
  "trash-2": "DEL",
  "bar-chart-3": "STAT",
  "shield-check": "AUD",
  "lock-keyhole": "KEY",
  eye: "VIEW",
};

  window.LlamaCatalog = { DOWNLOAD_SOURCES, PRECISION_PRESETS, MODEL_PRESETS, DTYPE_BYTES, KV_DTYPE_BYTES, QUANTIZATION_PROFILES, ICON_FALLBACKS };
})();
