// This adapter is deliberately scoped to the immutable, locally qualified image.
// Other SGLang/Flash-Next images retain their existing compatibility rules.
const PENNYROYAL_IMAGE = "ghcr.io/jpezzulli/sglang-rtxpro6000:v2.5.1@sha256:76258532b1c01f7583fbe951f90b80903db931030291db9db4e5a68b28567866";
const PENNYROYAL_CACHE_VOLUME = "pennyroyal-orcarouter-v251-compiler";
// Qualified 524K/TP1 profile peaked at ~86,855 MiB excluding the desktop.
// Admission adds its existing OS reserve and startup margin on top of this.
// SGLang's mem-fraction-static is not a vLLM whole-device reservation fraction.
const PENNYROYAL_VRAM_RESERVATION_MIB = 88000;
const PENNYROYAL_TOKENIZER_SHA256 = "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3";
const PENNYROYAL_DEFAULTS = Object.freeze({
  engine: "sglang", name: "pennyroyal", port: 8000,
  runtimeImage: PENNYROYAL_IMAGE,
  maxModelLen: 524288, maxNumSeqs: 4, gpuMemoryUtilization: 0.981,
  maxNumBatchedTokens: 0, cpuOffloadGb: 0, kvOffloadingSize: 0,
  tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
  enableExpertParallel: false, draftModel: "",
  dtype: "bfloat16", quantization: "modelopt_fp4", loadFormat: "safetensors",
  kvCacheDtype: "fp8_e4m3", trustRemoteCode: true,
  gpuDeviceIds: ["0"], multiGpuMode: "single", networkAccess: "local",
  clientPreset: "claude-code", reasoningParser: "qwen3", toolCallParser: "qwen3_coder",
  enableAutoToolChoice: true, speculativeMode: "mtp", numSpeculativeTokens: 3,
  enablePrefixCaching: true, disablePrefixCaching: false, languageModelOnly: false,
  sglangMaxTotalTokens: 524288, sglangPageSize: 64, sglangChunkedPrefillSize: 4096,
  sglangFp4GemmBackend: "flashinfer_cutlass", sglangAttentionBackend: "flashinfer",
  sglangPleOffloadEmbedding: true, sglangLinearAttnPrefillBackend: "flashinfer",
  sglangLinearAttnDecodeBackend: "flashinfer", sglangMambaSsmDtype: "bfloat16",
  sglangMambaRadixCacheStrategy: "extra_buffer", sglangMambaTrackInterval: 64,
  sglangMaxMambaCacheSize: 24, sglangDisableThinkingByDefault: false,
});

function isPennyroyalImage(image) {
  return String(image || "").trim() === PENNYROYAL_IMAGE;
}

function pennyroyalOptionErrors(options = {}) {
  const errors = [];
  if (!isPennyroyalImage(options.runtimeImage)) errors.push("请选择固定 digest 的 Pennyroyal v2.5.1 镜像。");
  for (const [key, expected] of Object.entries({
    kvCacheDtype: "fp8_e4m3", speculativeMode: "mtp",
    sglangAttentionBackend: "flashinfer", sglangLinearAttnPrefillBackend: "flashinfer",
    sglangFp4GemmBackend: "flashinfer_cutlass",
    sglangLinearAttnDecodeBackend: "flashinfer", sglangMambaSsmDtype: "bfloat16",
    sglangMambaRadixCacheStrategy: "extra_buffer",
  })) {
    if (options[key] && options[key] !== expected) errors.push(`${key} 要求 ${expected}。`);
  }
  for (const [key, expected] of Object.entries({
    numSpeculativeTokens: 3, sglangPageSize: 64, sglangChunkedPrefillSize: 4096,
    sglangMambaTrackInterval: 64, sglangMaxMambaCacheSize: 24,
  })) {
    if (Number(options[key]) > 0 && Number(options[key]) !== expected) errors.push(`${key} 要求 ${expected}。`);
  }
  if (Number(options.maxModelLen) > 524288 || Number(options.sglangMaxTotalTokens) > 524288) errors.push("本预设上限为 524288 tokens，且多请求共享 GPU KV 池。");
  if (Number(options.maxNumSeqs) > 4) errors.push("本预设最多同时运行 4 个请求。");
  if (Number(options.gpuMemoryUtilization) > 0.981) errors.push("本预设 mem-fraction-static 上限为 0.981；显存门禁使用实测预留并保留系统安全余量。");
  if (Number(options.tensorParallelSize) > 1 || (options.multiGpuMode && options.multiGpuMode !== "single")) errors.push("本预设仅验证单卡 TP=1。");
  if (options.sglangPleOffloadEmbedding === false) errors.push("Pennyroyal RAM PLE 必须启用。");
  if (Number(options.cpuOffloadGb) > 0 || Number(options.kvOffloadingSize) > 0) errors.push("Pennyroyal 使用 RAM PLE；CPU HiCache/NIXL 关闭，不接受 vLLM offload 参数。");
  return errors;
}

function createPennyroyalPreset(options = {}) {
  const errors = pennyroyalOptionErrors(options);
  return {
    id: "pennyroyal-v2.5.1-flash-next-wsl", label: "Pennyroyal v2.5.1 / Flash-Next / GPU cache only",
    pennyroyal: true, engine: "sglang", image: PENNYROYAL_IMAGE,
    dtype: "bfloat16", kvCacheDtype: "fp8_e4m3", quantization: "modelopt_fp4",
    forceTrustRemoteCode: true, reasoningParser: "qwen3", toolCallParser: "qwen3_coder",
    enableAutoToolChoice: true, attentionBackend: "flashinfer", fp4GemmBackend: "flashinfer_cutlass",
    maxTotalTokens: Number(options.sglangMaxTotalTokens || options.maxModelLen || 524288),
    maxRunningRequests: Number(options.maxNumSeqs || 4), effectiveMaxRunningRequests: Number(options.maxNumSeqs || 4),
    pageSize: 64, chunkedPrefillSize: 4096, pleOffloadEmbedding: true,
    linearAttnPrefillBackend: "flashinfer", linearAttnDecodeBackend: "flashinfer",
    mambaSsmDtype: "bfloat16", mambaRadixCacheStrategy: "extra_buffer",
    mambaTrackInterval: 64, maxMambaCacheSize: 24,
    defaultChatTemplateKwargs: JSON.stringify({ enable_thinking: !options.sglangDisableThinkingByDefault, preserve_thinking: true, reasoning_effort: "medium" }),
    speculativeAlgorithm: "NEXTN", speculativeConfig: null,
    unsupportedReason: errors.join(" "),
    env: {
      PYTHONPATH: "/opt/pennyroyal/python", SGLANG_SM120_ONLINE_MXFP8: "true",
      SGLANG_MM_PREPROCESS_DEVICE: "cpu", NUMPY_MADVISE_HUGEPAGE: "0",
      SGLANG_NUMA_BIND_V2: "true", SGLANG_AUTO_NUMA_BIND: "false",
      SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN: "1", SGLANG_MAMBA_CONV_DTYPE: "bfloat16",
      PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True", TOKENIZERS_PARALLELISM: "false",
      CUDA_DEVICE_ORDER: "PCI_BUS_ID", CUDA_VISIBLE_DEVICES: "0",
      OMP_NUM_THREADS: "4", MKL_NUM_THREADS: "4", HF_HOME: "/cache/huggingface",
      XDG_CACHE_HOME: "/cache", TORCH_HOME: "/cache/torch", TORCHINDUCTOR_CACHE_DIR: "/cache/torchinductor",
      TRITON_CACHE_DIR: "/cache/triton", CUDA_CACHE_PATH: "/cache/cuda",
      FLASHINFER_WORKSPACE_BASE: "/cache/flashinfer", SGLANG_CACHE_DIR: "/cache/sglang",
      SGLANG_JIT_CACHE_DIR: "/cache/sglang/jit",
    },
    notes: [
      "Pennyroyal v2.5.1: NVFP4 + online FP8 + FP8 KV + FR-Spec/NEXTN-3 + RAM PLE",
      "CPU HiCache/NIXL disabled for WSL compatibility; GPU radix cache remains enabled",
      "524288 shared KV capacity; 500016-token synthetic retrieval qualified; cold load about 16 minutes",
    ],
  };
}

const PENNYROYAL_ROPE_OVERRIDE = JSON.stringify({ text_config: { rope_parameters: {
  mrope_interleaved: true, mrope_section: [11, 11, 10], rope_type: "yarn", rope_theta: 10000000,
  partial_rotary_factor: 0.25, factor: 2, original_max_position_embeddings: 262144,
} } });

module.exports = { PENNYROYAL_IMAGE, PENNYROYAL_CACHE_VOLUME, PENNYROYAL_DEFAULTS,
  PENNYROYAL_VRAM_RESERVATION_MIB,
  PENNYROYAL_TOKENIZER_SHA256, PENNYROYAL_ROPE_OVERRIDE,
  isPennyroyalImage, pennyroyalOptionErrors, createPennyroyalPreset };
