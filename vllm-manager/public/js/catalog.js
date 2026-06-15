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

// 量化精度不再用来拼仓库后缀（-AWQ/-FP8 这类仓库多半不存在）。
// base 直接下载原始仓库；其它精度引导到在线搜索按 quantFilter 找真实存在的量化仓库。
const PRECISION_PRESETS = [
  { value: "base", label: "原始 BF16/FP16", quantFilter: "", launchQuantization: "" },
  { value: "fp8", label: "FP8", quantFilter: "fp8", launchQuantization: "fp8" },
  { value: "awq", label: "AWQ INT4", quantFilter: "awq", launchQuantization: "awq" },
  { value: "gptq", label: "GPTQ INT4", quantFilter: "gptq", launchQuantization: "gptq" },
  { value: "nvfp4", label: "NVFP4", quantFilter: "nvfp4", launchQuantization: "modelopt_fp4" },
  { value: "int4", label: "INT4 / NF4", quantFilter: "int4", launchQuantization: "bitsandbytes" },
  { value: "gguf", label: "GGUF", quantFilter: "gguf", launchQuantization: "" },
];

const MODEL_PRESETS = [
  // Qwen3 稠密：单卡主力，覆盖从验证到 32B
  { developer: "Qwen", version: "Qwen3 稠密", spec: "0.6B", repo: "Qwen/Qwen3-0.6B", note: "极轻量，用于跑通流程和低显存验证。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "1.7B", repo: "Qwen/Qwen3-1.7B", note: "小显存设备也能流畅运行。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "4B", repo: "Qwen/Qwen3-4B", note: "单卡友好的日常中文模型。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "8B", repo: "Qwen/Qwen3-8B", note: "质量与速度均衡，单卡通用首选。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "14B", repo: "Qwen/Qwen3-14B", note: "更强推理，建议 24GB+ 或量化。" },
  { developer: "Qwen", version: "Qwen3 稠密", spec: "32B", repo: "Qwen/Qwen3-32B", note: "高质量稠密模型，建议大显存或量化。" },
  // Qwen3 MoE：激活参数少、吞吐高
  { developer: "Qwen", version: "Qwen3 MoE", spec: "30B-A3B", repo: "Qwen/Qwen3-30B-A3B", note: "激活仅 3B，吞吐高且质量接近 32B 稠密。" },
  { developer: "Qwen", version: "Qwen3 MoE", spec: "235B-A22B", repo: "Qwen/Qwen3-235B-A22B", note: "旗舰 MoE，需多卡或低比特量化。" },
  // Qwen3-VL：多模态
  { developer: "Qwen", version: "Qwen3-VL 多模态", spec: "8B", repo: "Qwen/Qwen3-VL-8B-Instruct", note: "图文理解，单卡可跑。" },
  { developer: "Qwen", version: "Qwen3-VL 多模态", spec: "30B-A3B", repo: "Qwen/Qwen3-VL-30B-A3B-Instruct", note: "MoE 多模态，吞吐高。" },
  // OpenAI gpt-oss：原生 MXFP4 开源权重
  { developer: "OpenAI", version: "gpt-oss", spec: "20B", repo: "openai/gpt-oss-20b", note: "原生 MXFP4 量化，单卡即可运行。" },
  { developer: "OpenAI", version: "gpt-oss", spec: "120B", repo: "openai/gpt-oss-120b", note: "大号开源权重，需多卡或大显存。" },
  // NVIDIA DiffusionGemma：需要 vLLM Gemma 专用镜像与 gemma4 parser
  { developer: "NVIDIA", version: "DiffusionGemma", spec: "26B-A4B IT", repo: "nvidia/diffusiongemma-26B-A4B-it-NVFP4", precision: "nvfp4", note: "NVFP4 多模态/扩散式 Gemma 架构；启动时管理器会自动切换 Gemma vLLM 镜像、V2 runner、TRITON_ATTN 与 gemma4 parser。" },
  // DeepSeek R1 蒸馏：强推理小模型
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "1.5B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", note: "最小的强推理蒸馏模型。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "7B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", note: "单卡推理蒸馏小规格。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "14B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", note: "推理更稳，显存需求更高。" },
  { developer: "DeepSeek", version: "R1 Distill Qwen", spec: "32B", repo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", note: "蒸馏旗舰，建议多卡或量化。" },
  { developer: "DeepSeek", version: "R1 Distill Llama", spec: "8B", repo: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", note: "Llama 架构的推理蒸馏版。" },
  { developer: "DeepSeek", version: "R1 Distill Llama", spec: "70B", repo: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B", note: "高质量推理，需多卡或量化。" },
  // Meta Llama：英文/通用，多数需授权 token
  { developer: "Meta", version: "Llama 3.3", spec: "70B", repo: "meta-llama/Llama-3.3-70B-Instruct", note: "强英文/通用模型，需授权 token，建议多卡。" },
  { developer: "Meta", version: "Llama 3.1", spec: "8B", repo: "meta-llama/Llama-3.1-8B-Instruct", note: "单卡通用英文模型，需授权 token。" },
  // Google Gemma 3：轻量多语言，多数需授权 token
  { developer: "Google", version: "Gemma 3", spec: "1B", repo: "google/gemma-3-1b-it", note: "超轻量，需授权 token。" },
  { developer: "Google", version: "Gemma 3", spec: "4B", repo: "google/gemma-3-4b-it", note: "轻量多语言 instruction 模型。" },
  { developer: "Google", version: "Gemma 3", spec: "12B", repo: "google/gemma-3-12b-it", note: "单卡可跑的中端模型。" },
  { developer: "Google", version: "Gemma 3", spec: "27B", repo: "google/gemma-3-27b-it", note: "Gemma 旗舰，建议大显存或量化。" },
  // Mistral：欧洲通用模型
  { developer: "Mistral", version: "Small 3.2", spec: "24B", repo: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", note: "中等规模通用模型，建议高显存。" },
];

const DTYPE_BYTES = {
  auto: 2,
  bfloat16: 2,
  float16: 2,
  float32: 4,
};

const KV_DTYPE_BYTES = {
  auto: null,
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
  wrench: "TOOL",
  "badge-check": "OK",
};

  window.VllmCatalog = { DOWNLOAD_SOURCES, PRECISION_PRESETS, MODEL_PRESETS, DTYPE_BYTES, KV_DTYPE_BYTES, QUANTIZATION_PROFILES, ICON_FALLBACKS };
})();
