#!/usr/bin/env node
"use strict";
// Captures and checks the engine golden fixtures (01-engines §8) in
// manager-core/test/fixtures/engines/goldens/.
//
//   node scripts/capture-engine-goldens.js                         check every fixture (the default)
//   node scripts/capture-engine-goldens.js --check [G-V1,PRE-03]   check some fixtures
//   node scripts/capture-engine-goldens.js --write all --reason "<text>" [--at YYYY-MM-DD]
//   node scripts/capture-engine-goldens.js --write G-V1,P-L02 --reason "<text>"
//   --out <dir>   check or write another directory (the tests use a temp dir)
//   --list        print the capture list
//
// The capture list below is the source of every fixture's input. A check runs
// each input through the current builders and exits 1 on any difference,
// printing a unified diff of runArgs (and of any other field that changed).
// A write is refused without --reason. It leaves a fixture whose content is
// unchanged byte for byte, so capturing twice is idempotent, and appends
// {at, reason} to the history of every fixture it rewrites.

const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const harness = require("../manager-core/test/helpers/engine-golden-stubs");
const { PENNYROYAL_DEFAULTS, createPennyroyalPreset } = require("../vllm-manager/lib/pennyroyal");

const SCHEMA_VERSION = 1;
const FIXTURE_MODELS = `${harness.CANONICAL_ROOT}/models`;
const VLLM_BUILDER_ENV = { HF_TOKEN: null, VLLM_START_TIMEOUT_MS: null };
const VLLM_PRESET_ENV = {
  VLLM_QWEN_MOE_BACKEND: null,
  VLLM_GEMMA_USE_V2_MODEL_RUNNER: null,
  VLLM_GEMMA_MAX_NEW_TOKENS: null,
  VLLM_ALLOW_WINDOWS_DIFFUSION_GEMMA: null,
  VLLM_ALLOW_MUSE_GLIMMER: null,
};
const LLAMA_BUILDER_ENV = { HF_TOKEN: null };
const VLLM_HOST_GPUS = [
  { id: "0", index: 0, name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", computeCap: "12.0", totalMb: 97887, usedMb: 600 },
];
const LLAMA_HOST_GPUS = [
  { id: "0", index: 0, name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", totalMb: 97887, usedMb: 600 },
  { id: "1", index: 1, name: "NVIDIA GeForce RTX 4090", totalMb: 24564, usedMb: 500 },
];

const VLLM_TEST = "vllm-manager/test/runtime-command.test.js";
const LLAMA_TEST = "llama-manager/test/runtime-command.test.js";
const CORE_TEST = "vllm-manager/test/core.test.js";
const CAPABILITIES_TEST = "vllm-manager/test/model-capabilities.test.js";

function fixtureModel(directory) {
  return `${FIXTURE_MODELS}/${directory}`;
}

function localLaunch(directory) {
  return { modelArg: `/models/${directory}`, localPath: fixtureModel(directory) };
}

function vllmBaseConfig(extra = {}) {
  return {
    containerName: "vllm-local",
    managerId: "vllm-manager",
    hfCache: "D:/AI/cache/huggingface",
    modelsRoot: "D:/AI/models",
    ...extra,
  };
}

function builderCases() {
  const sglangFlashNextPreset = {
    id: "qwen3.8-flash-next-sglang-sm120",
    label: "Qwen3.8 Flash-Next / SGLang / SM120",
    engine: "sglang",
    image: "local/sglang:qwen38flashnext-sm120-dac5523d",
    quantization: "modelopt_fp4",
    maxRunningRequests: 1,
    effectiveMaxRunningRequests: 1,
    maxTotalTokens: 262144,
    pageSize: 64,
    chunkedPrefillSize: 4096,
    fp4GemmBackend: "flashinfer_cutlass",
    attentionBackend: "triton",
    pleOffloadEmbedding: true,
    linearAttnPrefillBackend: "triton",
    linearAttnDecodeBackend: "flashinfer",
    mambaSsmDtype: "bfloat16",
    mambaRadixCacheStrategy: "extra_buffer",
    mambaTrackInterval: 64,
    maxMambaCacheSize: 8,
    disableThinkingByDefault: true,
    defaultChatTemplateKwargs: JSON.stringify({ enable_thinking: false }),
    forceTrustRemoteCode: true,
    reasoningParser: "qwen3",
    toolCallParser: "qwen3_coder",
    enableAutoToolChoice: true,
  };
  const prefixCacheOpts = {
    model: "D:/AI/models/qwen", loadFormat: "gguf", quantization: "", port: 8000, networkAccess: "local",
    serviceHost: "127.0.0.1", gpuDeviceIds: ["0"], name: "qwen-local", dtype: "auto",
    maxModelLen: 32768, maxNumSeqs: 4, gpuMemoryUtilization: 0.9, tokenizer: "", kvCacheDtype: "auto",
    cpuOffloadGb: 0, kvOffloadingSize: 0, languageModelOnly: false, tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
  };
  const prefixCacheInput = (opts) => ({
    config: vllmBaseConfig({ image: "vllm/default:fixed" }),
    launch: { modelArg: "/models/qwen/model.gguf", effectiveLoadFormat: "gguf", localPath: "D:/AI/models/qwen" },
    quantization: { value: "", modelConfigMethod: "" },
    preset: { id: "test-preset", label: "Test preset" },
    opts,
    job: { meta: {} },
    modelFixture: null,
  });
  const museLaunch = {
    modelArg: "/models/muse/muse-glimmer-dynamic.gguf",
    effectiveLoadFormat: "gguf",
    selectedGgufFile: "D:/AI/models/muse/muse-glimmer-dynamic.gguf",
    selectedModel: { path: "D:/AI/models/muse/muse-glimmer-dynamic.gguf", architecture: "muse-glimmer" },
    ggufFiles: [],
    ggufInventory: { models: [{}, {}] },
    mmprojFiles: [{ path: "D:/AI/models/muse/mmproj-kquant.gguf", architecture: "clip" }],
    draftFiles: [{ path: "D:/AI/models/muse/dflash-kquant.gguf", architecture: "dflash" }],
  };
  return [
    {
      id: "G-V1-vllm-gguf-preset-lan-tp2",
      manager: "vllm",
      source: `${VLLM_TEST} › vLLM runtime command builds Docker args and redacts API keys (plus an HF token to pin the secret channel)`,
      stubs: "vllm-test-v1",
      env: { HF_TOKEN: "<secret:hfToken>", VLLM_START_TIMEOUT_MS: null },
      input: {
        config: vllmBaseConfig({ image: "vllm/default:fixed", imagePlatform: "linux/amd64" }),
        launch: {
          modelArg: "/models/qwen/model.gguf",
          effectiveLoadFormat: "gguf",
          selectedGgufFile: "D:/AI/models/qwen/model.gguf",
          ggufFiles: [{ path: "D:/AI/models/qwen/small.gguf", size: 1 }, { path: "D:/AI/models/qwen/model.gguf", size: 2 }],
          localPath: "D:/AI/models/qwen",
        },
        quantization: { value: "awq", modelConfigMethod: "" },
        preset: {
          id: "test-preset",
          label: "Test preset",
          image: "vllm/custom:pinned",
          env: { VLLM_TEST: "1" },
          notes: ["preset note"],
          dtype: "bfloat16",
          kvCacheDtype: "fp8",
          moeBackend: "flashinfer_b12x",
          generationConfig: "vllm",
          forceTrustRemoteCode: true,
          enableAutoToolChoice: true,
          toolCallParser: "qwen3_coder",
          maxNumBatchedTokens: 8192,
          defaultChatTemplateKwargs: JSON.stringify({ enable_thinking: false }),
          speculativeConfig: { method: "mtp", num_speculative_tokens: 3 },
          asyncScheduling: true,
        },
        opts: {
          model: "D:/AI/models/qwen", loadFormat: "gguf", quantization: "awq", port: 8000, networkAccess: "lan",
          serviceHost: "192.168.1.27", gpuDeviceIds: ["0", "1"], vllmApiKey: "<secret:apiKey>", runtimeApiKeyRef: "runtime-secret-ref",
          name: "qwen-local", dtype: "auto", maxModelLen: 65536, maxNumSeqs: 1, gpuMemoryUtilization: 0.9,
          vramReservationMb: 12000, gpuAdmissionLeaseId: "lease-vllm", tokenizer: "D:/AI/models/qwen/tokenizer",
          kvCacheDtype: "auto", cpuOffloadGb: 0, kvOffloadingSize: 0, enablePrefixCaching: true, languageModelOnly: false,
          tensorParallelSize: 2, pipelineParallelSize: 1, dataParallelSize: 1,
        },
        job: { id: "serve-job-1", meta: {} },
        modelFixture: null,
      },
    },
    {
      id: "G-V2-vllm-preset-autodetect",
      manager: "vllm",
      source: `${VLLM_TEST} › runtime preset can leave quantization and KV cache dtype to checkpoint auto-detection`,
      stubs: "vllm-test-v1",
      env: VLLM_BUILDER_ENV,
      input: {
        config: vllmBaseConfig({ image: "vllm/default:fixed" }),
        launch: { modelArg: "/models/qwen", effectiveLoadFormat: "auto", localPath: "D:/AI/models/qwen" },
        quantization: { value: "modelopt", modelConfigMethod: "modelopt" },
        preset: { id: "qwen-auto", image: "vllm/custom:pinned", disableQuantizationArg: true, disableKvCacheDtypeArg: true },
        opts: {
          model: "D:/AI/models/qwen", loadFormat: "auto", quantization: "modelopt_fp4", port: 8000, networkAccess: "local",
          serviceHost: "127.0.0.1", gpuDeviceIds: ["0"], name: "qwen-local", dtype: "auto", maxModelLen: 262144,
          maxNumSeqs: 4, gpuMemoryUtilization: 0.91, tokenizer: "", kvCacheDtype: "fp8", cpuOffloadGb: 0,
          kvOffloadingSize: 0, enablePrefixCaching: false, languageModelOnly: false, tensorParallelSize: 1,
          pipelineParallelSize: 1, dataParallelSize: 1,
        },
        job: { meta: {} },
        modelFixture: null,
      },
    },
    {
      id: "G-V3a-vllm-prefix-cache-default",
      manager: "vllm",
      source: `${VLLM_TEST} › vLLM runtime command emits --no-enable-prefix-caching only when disabling (default)`,
      stubs: "vllm-test-v1",
      env: VLLM_BUILDER_ENV,
      input: prefixCacheInput({ ...prefixCacheOpts }),
    },
    {
      id: "G-V3b-vllm-prefix-cache-disabled",
      manager: "vllm",
      source: `${VLLM_TEST} › vLLM runtime command emits --no-enable-prefix-caching only when disabling (disabled)`,
      stubs: "vllm-test-v1",
      env: VLLM_BUILDER_ENV,
      input: prefixCacheInput({ ...prefixCacheOpts, disablePrefixCaching: true }),
    },
    {
      id: "G-V4-vllm-qwen38-positional",
      manager: "vllm",
      source: `${VLLM_TEST} › vLLM runtime supports the current positional serve syntax and persistent cache`,
      stubs: "vllm-test-v1",
      env: VLLM_BUILDER_ENV,
      input: {
        config: vllmBaseConfig({ vllmCache: "D:/AI/cache/vllm-qwen38", image: "vllm/default:fixed" }),
        launch: { modelArg: "/models/Qwen-Qwen3.8-27B-FP8", effectiveLoadFormat: "auto", localPath: "D:/AI/models/Qwen-Qwen3.8-27B-FP8" },
        quantization: { value: "fp8", modelConfigMethod: "fp8" },
        preset: { id: "qwen3.8-vllm-fp8", image: "vllm/qwen38:fixed", positionalModel: true, speculativeConfig: { method: "mtp", num_speculative_tokens: 3 } },
        opts: {
          model: "D:/AI/models/Qwen-Qwen3.8-27B-FP8", name: "qwen3.8-27b", port: 8000, networkAccess: "local",
          serviceHost: "127.0.0.1", gpuDeviceIds: ["0"], dtype: "auto", quantization: "fp8", loadFormat: "auto",
          maxModelLen: 262144, maxNumSeqs: 4, gpuMemoryUtilization: 0.8, kvCacheDtype: "auto", cpuOffloadGb: 0,
          kvOffloadingSize: 0, tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
        },
        job: { id: "serve-vllm", meta: {} },
        modelFixture: null,
      },
    },
    {
      id: "G-S1-sglang-qwen38-dspark",
      manager: "vllm",
      source: `${VLLM_TEST} › SGLang runtime command emits the validated Qwen3.8 DSpark contract`,
      stubs: "vllm-test-v1",
      env: VLLM_BUILDER_ENV,
      input: {
        config: vllmBaseConfig({
          vllmCache: "D:/AI/cache/vllm-qwen38",
          sglangCache: "D:/AI/cache/sglang-qwen38",
          image: "vllm/default:fixed",
          imagePlatform: "linux/amd64",
        }),
        launch: { modelArg: "/models/Qwen-Qwen3.8-27B-FP8", effectiveLoadFormat: "auto", localPath: "D:/AI/models/Qwen-Qwen3.8-27B-FP8" },
        quantization: { value: "fp8", modelConfigMethod: "fp8" },
        preset: {
          id: "qwen3.8-sglang-dspark",
          label: "Qwen3.8 / SGLang / DSpark",
          engine: "sglang",
          image: "lmsysorg/sglang@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          attentionBackend: "flashinfer",
          reasoningParser: "qwen3",
          toolCallParser: "qwen3_coder",
          enableAutoToolChoice: true,
          chunkedPrefillSize: 8192,
          mambaSchedulerStrategy: "extra_buffer",
          disablePrefillCudaGraph: true,
          mmFeatureTransport: "cpu",
          speculativeAlgorithm: "DSPARK",
          draftModel: "D:/AI/models/RadixArk-Qwen3.8-27B-DSpark",
          dsparkBlockSize: 7,
          draftModelQuantization: "unquant",
        },
        opts: {
          engine: "sglang", model: "D:/AI/models/Qwen-Qwen3.8-27B-FP8", name: "qwen3.8-27b",
          port: 8000, networkAccess: "local", serviceHost: "127.0.0.1", gpuDeviceIds: ["0"],
          dtype: "auto", quantization: "fp8", loadFormat: "auto", maxModelLen: 262144,
          maxNumSeqs: 4, gpuMemoryUtilization: 0.8, kvCacheDtype: "auto", cpuOffloadGb: 0,
          kvOffloadingSize: 0, mmProcessorCacheGb: 0, tensorParallelSize: 1,
          pipelineParallelSize: 1, dataParallelSize: 1, enablePrefixCaching: true,
        },
        job: { id: "serve-dspark", meta: {} },
        modelFixture: null,
      },
    },
    {
      id: "G-S2-sglang-flashnext-262k",
      manager: "vllm",
      source: `${VLLM_TEST} › SGLang runtime command emits the validated Flash-Next SM120 long-context contract`,
      stubs: "vllm-test-v1",
      env: VLLM_BUILDER_ENV,
      input: {
        config: vllmBaseConfig({ sglangCache: "D:/AI/cache/sglang-qwen38", image: "vllm/default:fixed", imagePlatform: "linux/amd64" }),
        launch: {
          modelArg: "/models/RadixArk-Qwen3.8-Flash-Next-NVFP4",
          effectiveLoadFormat: "auto",
          localPath: "D:/AI/models/RadixArk-Qwen3.8-Flash-Next-NVFP4",
        },
        quantization: { value: "modelopt_fp4", modelConfigMethod: "modelopt_fp4" },
        preset: sglangFlashNextPreset,
        opts: {
          engine: "sglang", model: "D:/AI/models/RadixArk-Qwen3.8-Flash-Next-NVFP4", name: "qwen3.8-flash-next",
          port: 8000, networkAccess: "local", serviceHost: "127.0.0.1", gpuDeviceIds: ["0"],
          dtype: "auto", quantization: "modelopt_fp4", loadFormat: "auto", maxModelLen: 262144,
          maxNumSeqs: 4, gpuMemoryUtilization: 0.995, kvCacheDtype: "auto", cpuOffloadGb: 0,
          kvOffloadingSize: 0, tensorParallelSize: 1, pipelineParallelSize: 1, dataParallelSize: 1,
          trustRemoteCode: true, enablePrefixCaching: true,
        },
        job: { id: "serve-flash-next", meta: {} },
        modelFixture: null,
      },
    },
    {
      id: "G-S3-sglang-pennyroyal-v251",
      manager: "vllm",
      source: "vllm-manager/test/pennyroyal.test.js › Pennyroyal Docker command retains the proven GPU-only recipe and manager lifecycle",
      stubs: "vllm-pennyroyal-test-v1",
      env: VLLM_BUILDER_ENV,
      input: {
        config: vllmBaseConfig({ hfCache: "D:/AI/cache/hf", sglangCache: "D:/AI/cache/old", image: "old" }),
        modelMountArgs: ["-v", "F:/llm/model:/model-storage/f-models"],
        launch: { modelArg: "/model-storage/f-models/OrcaRouter", localPath: "F:/llm/model/OrcaRouter", effectiveLoadFormat: "safetensors" },
        quantization: { value: "modelopt_fp4" },
        preset: createPennyroyalPreset(PENNYROYAL_DEFAULTS),
        opts: { ...PENNYROYAL_DEFAULTS, vllmApiKey: "<secret:apiKey>", tensorParallelSize: 1 },
        job: { id: "penny-test", meta: {} },
        modelFixture: null,
      },
    },
    {
      id: "G-L1-llama-remote-hf-hetero-fit",
      manager: "llama",
      source: `${LLAMA_TEST} › llama runtime command builds remote GGUF and hetero GPU args`,
      stubs: "llama-test-v1",
      env: LLAMA_BUILDER_ENV,
      input: {
        config: {
          containerName: "llama-local",
          managerId: "llama-manager",
          hfCache: "D:/AI/cache/huggingface",
          modelsRoot: "D:/AI/models",
          image: "ghcr.io/ggml-org/llama.cpp@sha256:test",
        },
        launch: { modelArg: "/models/qwen/model.gguf", effectiveLoadFormat: "gguf", selectedGgufFile: "", ggufFiles: [] },
        opts: {
          model: "user/qwen-gguf", port: 8080, networkAccess: "lan", serviceHost: "192.168.1.27",
          gpuDeviceIds: ["0", "1"], textOnlyMode: true, languageModelOnly: true, multiGpuMode: "layer",
          tensorSplit: "2,1", mainGpu: 0, gpuPlan: { summary: "2:1 split", mainGpuHostId: "0" }, name: "qwen-gguf",
          maxModelLen: 131072, maxNumSeqs: 1, batchSize: 4096, ubatchSize: 1024, gpuLayers: "auto",
          fitTargetMb: 8192, fitCtx: 131072, gpuMemoryUtilization: 0.5, vramReservationMb: 10000,
          gpuAdmissionLeaseId: "lease-llama", cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttention: "auto",
          reasoning: "auto", reasoningFormat: "none", reasoningEffort: "high", reasoningBudget: 2048,
          mmprojDevice: "auto", noMmap: true, noRepack: true,
        },
        job: { id: "serve-test" },
        modelFixture: null,
      },
    },
    {
      id: "G-L2-llama-mmproj-mtp-apikey",
      manager: "llama",
      source: `${LLAMA_TEST} › llama runtime command loads mmproj, protects API keys, and enables checkpoint MTP (plus an HF token to pin the secret channel)`,
      stubs: "llama-test-v2",
      env: { HF_TOKEN: "<secret:hfToken>" },
      input: {
        config: { containerName: "llama-local", managerId: "llama-manager", hfCache: "D:/cache", modelsRoot: "D:/AI/models", image: "llama:pinned" },
        launch: {
          modelArg: "/models/qwen/model.gguf",
          effectiveLoadFormat: "gguf",
          selectedGgufFile: "D:/AI/models/qwen/model.gguf",
          ggufFiles: [{ path: "D:/AI/models/qwen/model.gguf", size: 1000 }, { path: "D:/AI/models/qwen/mmproj-F16.gguf", size: 100 }],
        },
        opts: {
          model: "D:/AI/models/qwen/model-MTP.gguf", port: 8080, networkAccess: "local", serviceHost: "127.0.0.1",
          gpuDeviceIds: ["0"], textOnlyMode: false, languageModelOnly: false, multiGpuMode: "none", mainGpu: 0,
          name: "qwen-mtp", maxModelLen: 32768, maxNumSeqs: 4, batchSize: 2048, ubatchSize: 512, gpuLayers: -1,
          cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttention: "auto", reasoning: "auto", reasoningFormat: "auto",
          reasoningEffort: "medium", reasoningBudget: 4096, mmprojDevice: "CUDA0", speculativeMode: "auto",
          numSpeculativeTokens: 5, llamaApiKey: "<secret:apiKey>", runtimeApiKeyRef: "runtime-secret-ref",
        },
        job: {},
        modelFixture: null,
      },
    },
    {
      id: "G-L3-llama-muse-mmproj-dflash",
      manager: "llama",
      source: `${LLAMA_TEST} › llama runtime command auto-loads Muse mmproj and DFlash draft together`,
      stubs: "llama-test-v2",
      env: LLAMA_BUILDER_ENV,
      input: {
        config: {
          containerName: "llama-local",
          managerId: "llama-manager",
          hfCache: "D:/cache",
          modelsRoot: "D:/AI/models",
          image: "llama:regular",
          museImage: "local/llama.cpp:server-cuda-muse-62bf73d",
        },
        launch: museLaunch,
        opts: {
          model: "D:/AI/models/muse", launch: museLaunch, port: 8080, networkAccess: "local", serviceHost: "127.0.0.1",
          gpuDeviceIds: ["0"], textOnlyMode: false, languageModelOnly: false, multiGpuMode: "none", mainGpu: 0,
          name: "muse-glimmer", maxModelLen: 131072, maxNumSeqs: 1, batchSize: 2048, ubatchSize: 512, gpuLayers: "all",
          cacheTypeK: "q8_0", cacheTypeV: "q8_0", flashAttention: "auto", reasoning: "auto", reasoningFormat: "auto",
          speculativeMode: "auto", numSpeculativeTokens: 3,
        },
        job: {},
        modelFixture: null,
      },
    },
  ].map((item) => ({ kind: "builder", ...item }));
}

function presetCases() {
  const preset = (id, source, input, env = {}) => ({
    id,
    kind: "preset",
    manager: "vllm",
    source: `vllm-manager/server.js resolveVllmRuntimePreset › ${source}`,
    stubs: "none",
    env: { ...VLLM_PRESET_ENV, ...env },
    input: { opts: input.opts, launch: input.launch || {}, modelFixture: input.modelFixture || null },
  });
  const flashNext = "RadixArk-Qwen3.8-Flash-Next-NVFP4";
  const qwen38Fp8 = "Qwen-Qwen3.8-27B-FP8";
  const coreFlashNext = `${CORE_TEST} › Qwen3.8 Flash-Next NVFP4 resolves to the patched SM120 SGLang profile (inputs)`;
  const coreQwen36 = `${CORE_TEST} › Qwen3.6 MoE NVFP4 uses the nightly runtime preset (inputs)`;
  const coreGemma = `${CORE_TEST} › DiffusionGemma is blocked by default on Windows Docker WSL (inputs)`;
  const gemmaModel = "D:/AI/models/nv-community-diffusiongemma-26B-A4B-it-NVFP4";
  return [
    preset("PRE-01-pennyroyal-on-flash-next", "Pennyroyal image on a Qwen3.8 Flash-Next NVFP4 checkpoint", {
      opts: { ...PENNYROYAL_DEFAULTS, model: fixtureModel(flashNext) },
      launch: localLaunch(flashNext),
      modelFixture: "qwen38-flash-next-nvfp4",
    }),
    preset("PRE-02-pennyroyal-on-non-flash-next", "Pennyroyal image on a checkpoint that is not Flash-Next (unsupportedReason)", {
      opts: { ...PENNYROYAL_DEFAULTS, model: fixtureModel(qwen38Fp8) },
      launch: localLaunch(qwen38Fp8),
      modelFixture: "qwen38-27b-fp8-mtp",
    }),
    preset("PRE-03-sglang-flash-next-nvfp4-speculative-off", coreFlashNext, {
      opts: { engine: "sglang", model: "RadixArk/Qwen3.8-Flash-Next-NVFP4", maxModelLen: 262144, maxNumSeqs: 4, speculativeMode: "off", sglangDisableThinkingByDefault: true },
    }),
    preset("PRE-04-sglang-flash-next-nvfp4-mtp-blocked", `${coreFlashNext}, with speculativeMode mtp`, {
      opts: { engine: "sglang", model: "RadixArk/Qwen3.8-Flash-Next-NVFP4", maxModelLen: 262144, maxNumSeqs: 4, speculativeMode: "mtp", sglangDisableThinkingByDefault: true },
    }),
    preset("PRE-05-sglang-qwen38-fp8-dspark", "SGLang Qwen3.8 FP8 with the DSpark draft at its default location", {
      opts: { engine: "sglang", model: fixtureModel(qwen38Fp8), maxModelLen: 262144, maxNumSeqs: 4, speculativeMode: "dspark", dsparkBlockSize: 7 },
      launch: localLaunch(qwen38Fp8),
      modelFixture: "qwen38-27b-fp8-mtp",
    }),
    preset("PRE-06-sglang-generic-llama3", "SGLang on a generic Llama-3 checkpoint", {
      opts: { engine: "sglang", model: fixtureModel("Meta-Llama-3-8B-Instruct"), maxModelLen: 8192, maxNumSeqs: 4, speculativeMode: "off" },
      launch: localLaunch("Meta-Llama-3-8B-Instruct"),
      modelFixture: "llama3-8b-instruct",
    }),
    preset("PRE-07-vllm-dspark-unsupported", "vLLM with speculativeMode dspark (unsupported on this host)", {
      opts: { engine: "vllm", model: fixtureModel(qwen38Fp8), speculativeMode: "dspark" },
      launch: localLaunch(qwen38Fp8),
      modelFixture: "qwen38-27b-fp8-mtp",
    }),
    preset("PRE-08-vllm-qwen38-fp8", "vLLM Qwen3.8 FP8 with packaged MTP tensors and speculativeMode mtp", {
      opts: { engine: "vllm", model: fixtureModel(qwen38Fp8), quantization: "fp8", speculativeMode: "mtp", numSpeculativeTokens: 3 },
      launch: localLaunch(qwen38Fp8),
      modelFixture: "qwen38-27b-fp8-mtp",
    }),
    preset("PRE-09-vllm-qwen38-nvfp4", "vLLM Qwen3.8 ModelOpt NVFP4", {
      opts: { engine: "vllm", model: fixtureModel("Qwen-Qwen3.8-27B-NVFP4"), speculativeMode: "off" },
      launch: localLaunch("Qwen-Qwen3.8-27B-NVFP4"),
      modelFixture: "qwen38-27b-nvfp4",
    }),
    preset("PRE-10-qwen36-moe-nvfp4-sm120", coreQwen36, {
      opts: { model: "nvidia/Qwen3.6-35B-A3B-NVFP4", kvCacheDtype: "auto", hostGpus: [{ id: "0", name: "NVIDIA RTX PRO 5000 Blackwell", computeCap: "12.0" }] },
    }),
    preset("PRE-11-qwen36-moe-nvfp4-non-sm12", `${coreQwen36}, without an SM12 GPU`, {
      opts: { model: "nvidia/Qwen3.6-35B-A3B-NVFP4", kvCacheDtype: "auto", hostGpus: [{ id: "0", name: "NVIDIA RTX 4090", computeCap: "8.9" }] },
    }),
    preset("PRE-12-qwen36-dense-nvfp4", `${coreQwen36}, dense checkpoint`, {
      opts: { model: "nvidia/Qwen3.6-27B-NVFP4", kvCacheDtype: "auto" },
    }),
    preset("PRE-13-diffusiongemma-win32-blocked", `${coreGemma}, platform win32`, {
      opts: { model: gemmaModel },
      launch: { localPath: "" },
    }, { platform: "win32" }),
    preset("PRE-14-diffusiongemma-linux", `${coreGemma}, platform linux`, {
      opts: { model: gemmaModel },
      launch: { localPath: "" },
    }, { platform: "linux" }),
    preset("PRE-15-gpt-oss-matrix-parsers", `${CAPABILITIES_TEST} (matrix parsers for a declared gpt-oss checkpoint)`, {
      opts: { model: fixtureModel("openai-gpt-oss-20b") },
      launch: localLaunch("openai-gpt-oss-20b"),
      modelFixture: "gpt-oss-20b",
    }),
    preset("PRE-16a-nemotron3-nano-plugin", `${CAPABILITIES_TEST} (Nemotron-3-Nano with its reasoning parser plugin)`, {
      opts: { model: fixtureModel("nvidia-Nemotron-3-Nano-30B-A3B") },
      launch: localLaunch("nvidia-Nemotron-3-Nano-30B-A3B"),
      modelFixture: "nemotron3-nano-plugin",
    }),
    preset("PRE-16b-nemotron3-nano-no-plugin", `${CAPABILITIES_TEST} (Nemotron-3-Nano without the plugin file)`, {
      opts: { model: fixtureModel("nvidia-Nemotron-3-Nano-30B-A3B") },
      launch: localLaunch("nvidia-Nemotron-3-Nano-30B-A3B"),
      modelFixture: "nemotron3-nano-no-plugin",
    }),
    preset("PRE-17-bnb-checkpoint", `${CAPABILITIES_TEST} › the pinned vLLM 0.28 image blocks BNB checkpoints until vllm-bnb-plugin is added`, {
      opts: { model: fixtureModel("unsloth-Llama-30B-bnb-4bit") },
      launch: localLaunch("unsloth-Llama-30B-bnb-4bit"),
      modelFixture: "llama-bnb-4bit",
    }),
    preset("PRE-18-muse-glimmer", `${CAPABILITIES_TEST} › Muse Glimmer is blocked before vLLM container startup`, {
      opts: { model: fixtureModel("meta-muse-glimmer") },
      launch: localLaunch("meta-muse-glimmer"),
      modelFixture: "muse-glimmer",
    }),
    preset("PRE-19-unknown-model", "a checkpoint no preset or capability entry knows", {
      opts: { model: fixtureModel("example-MadeUp-7B") },
      launch: localLaunch("example-MadeUp-7B"),
      modelFixture: "unknown-architecture",
    }),
  ];
}

function profileCases() {
  const vllmProfile = (code, profileId, directory, modelFixture) => ({
    id: `${code}-${profileId}`,
    kind: "profile",
    manager: "vllm",
    source: `vllm-manager/lib/default-profiles.js › ${profileId} → normalizeLaunchConfig → launch-request normalisation → preset → builder`,
    stubs: "vllm-profile-v1",
    env: { ...VLLM_BUILDER_ENV, ...VLLM_PRESET_ENV },
    input: { profileId, model: fixtureModel(directory), modelFixture, hostGpus: VLLM_HOST_GPUS, jobId: "serve-golden" },
  });
  const llamaProfile = (code, profileId) => ({
    id: `${code}-${profileId}`,
    kind: "profile",
    manager: "llama",
    source: `llama-manager/lib/default-profiles.js › ${profileId} → normalizeLaunchConfig → launch-request normalisation → builder`,
    stubs: "llama-profile-v1",
    env: LLAMA_BUILDER_ENV,
    input: {
      profileId,
      model: fixtureModel("Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"),
      modelFixture: "gguf-qwen3-8b",
      hostGpus: LLAMA_HOST_GPUS,
      jobId: "serve-golden",
    },
  });
  const flashNext = ["RadixArk-Qwen3.8-Flash-Next-NVFP4", "qwen38-flash-next-nvfp4"];
  const qwen38Fp8 = ["Qwen-Qwen3.8-27B-FP8", "qwen38-27b-fp8-mtp"];
  const llama3 = ["Meta-Llama-3-8B-Instruct", "llama3-8b-instruct"];
  return [
    vllmProfile("P-V01", "orcarouter-pennyroyal-v251-524k", ...flashNext),
    vllmProfile("P-V02", "qwen38-flash-next-sglang-262k", ...flashNext),
    vllmProfile("P-V03", "qwen38-vllm-mtp3-quality", ...qwen38Fp8),
    vllmProfile("P-V04", "qwen38-sglang-dspark-fastest", ...qwen38Fp8),
    vllmProfile("P-V05", "qwen38-nvfp4-capacity", ...qwen38Fp8),
    vllmProfile("P-V06", "blackwell-96gb-256k", ...llama3),
    vllmProfile("P-V07", "claude-long-context-64k", ...llama3),
    vllmProfile("P-V08", "claude-maximum-context", ...llama3),
    vllmProfile("P-V09", "openwebui-chat", ...llama3),
    vllmProfile("P-V10", "low-vram-safe", ...llama3),
    llamaProfile("P-L01", "llama-96gb-single-256k"),
    llamaProfile("P-L02", "llama-hetero-64k-safe"),
    llamaProfile("P-L03", "llama-hetero-256k-max"),
    llamaProfile("P-L04", "llama-openwebui-daily"),
    llamaProfile("P-L05", "llama-single-gpu-debug"),
  ];
}

function requestCases() {
  const vllmTest = "vllm-manager/test/launch-request.test.js";
  const llamaTest = "llama-manager/test/launch-request.test.js";
  return [
    {
      id: "R-V1-vllm-parallel-sglang-tp2-key",
      manager: "vllm",
      source: `${vllmTest} › vLLM launch request builds serve job metadata and run options (first request)`,
      stubs: "vllm-request-test-v1",
      input: {
        body: {
          model: "Qwen/Qwen3.6-27B", instanceMode: "parallel", instanceId: "code", port: "8123", maxModelLen: "262144",
          maxNumSeqs: "4", maxNumBatchedTokens: "16384", gpuDeviceIds: "0,1", multiGpuMode: "tensor", tensorParallelSize: "2",
          toolCallParser: "auto", clientPreset: "claude", enableAutoToolChoice: true, networkAccess: "lan",
          apiKey: "<secret:apiKey>", speculativeMode: "auto", numSpeculativeTokens: "2", engine: "sglang",
          runtimeImage: "lmsysorg/sglang@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          draftModel: "D:/AI/models/RadixArk-Qwen3.8-27B-DSpark", dsparkBlockSize: "9", sglangMaxTotalTokens: "262144",
          sglangPageSize: "64", sglangChunkedPrefillSize: "4096", sglangFp4GemmBackend: "flashinfer_cutlass",
          sglangAttentionBackend: "triton", sglangPleOffloadEmbedding: true, sglangLinearAttnPrefillBackend: "triton",
          sglangLinearAttnDecodeBackend: "flashinfer", sglangMambaSsmDtype: "bfloat16", sglangMambaRadixCacheStrategy: "extra_buffer",
          sglangMambaTrackInterval: "64", sglangMaxMambaCacheSize: "8", sglangDisableThinkingByDefault: true,
        },
        modelFixture: null,
      },
    },
    {
      id: "R-V2-vllm-parallel-implicit-gpu",
      manager: "vllm",
      source: `${vllmTest} › vLLM parallel launch binds an implicit GPU selection to the admitted device`,
      stubs: "vllm-request-implicit-gpu-v1",
      input: { body: { model: "model", instanceMode: "parallel", port: 8126 }, modelFixture: null },
    },
    {
      id: "R-V3-vllm-replace-after-prepare",
      manager: "vllm",
      source: `${vllmTest} › vLLM replace launch acquires after preparation and deletes its key even if lease release fails`,
      stubs: "vllm-request-replace-v1",
      input: { body: { model: "model", instanceMode: "replace", apiKey: "<secret:apiKey>" }, modelFixture: null },
    },
    {
      id: "R-L1-llama-parallel-hetero-key",
      manager: "llama",
      source: `${llamaTest} › llama launch request keeps hetero GPU plan and tensor split in sync (first request)`,
      stubs: "llama-request-test-v1",
      input: {
        body: {
          model: "D:/AI/models/model.gguf", instanceMode: "parallel", instanceId: "vision", port: "8180", gpuDeviceIds: "0,1",
          multiGpuMode: "layer", networkAccess: "lan", reasoning: "on", reasoningEffort: "high", reasoningBudget: "2048",
          mmproj: "D:/AI/models/mmproj.gguf", mmprojDevice: "CUDA0", speculativeMode: "draft-mtp", numSpeculativeTokens: "4",
          gpuLayers: "auto", fitTargetMb: 4096, fitCtx: 8192, apiKey: "<secret:apiKey>",
        },
        modelFixture: null,
      },
    },
    {
      id: "R-L2-llama-parallel-local-gguf-estimate",
      manager: "llama",
      source: `${llamaTest} › llama parallel VRAM estimate uses local GGUF size and fails closed for remote references (inputs, through the launch request with the real estimate)`,
      stubs: "llama-request-estimate-v1",
      input: {
        body: {
          model: fixtureModel("local-gguf/model.gguf"), instanceMode: "parallel", instanceId: "estimate", port: "8183",
          gpuDeviceIds: "0,1", multiGpuMode: "layer", tensorSplit: "2,1", maxModelLen: 8192, maxNumSeqs: 1,
        },
        modelFixture: "gguf-zero-2mib",
      },
    },
  ].map((item) => ({ kind: "request", env: {}, ...item }));
}

function captureList() {
  return [...builderCases(), ...presetCases(), ...profileCases(), ...requestCases()];
}

// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage:",
    "  node scripts/capture-engine-goldens.js [--check [ids]] [--out <dir>]",
    "  node scripts/capture-engine-goldens.js --write all|<ids> --reason \"<text>\" [--at YYYY-MM-DD] [--out <dir>]",
    "  node scripts/capture-engine-goldens.js --list",
    "ids is a comma-separated list of fixture ids or their codes (G-V1, PRE-16a, P-L03, R-V2).",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { mode: "check", selection: "all", reason: "", at: "", out: harness.GOLDEN_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
      index += 1;
      return value;
    };
    if (arg === "--check") {
      options.mode = "check";
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) options.selection = next();
    } else if (arg === "--write") {
      options.mode = "write";
      options.selection = next();
    } else if (arg === "--reason") {
      options.reason = next().trim();
    } else if (arg === "--at") {
      options.at = next();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(options.at)) throw new UsageError("--at must be a YYYY-MM-DD date.");
    } else if (arg === "--out") {
      options.out = path.resolve(next());
    } else if (arg === "--list") {
      options.mode = "list";
    } else if (arg === "--help" || arg === "-h") {
      options.mode = "help";
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

class UsageError extends Error {}

function fixtureCode(id) {
  return String(id).split("-").slice(0, 2).join("-");
}

function selectCases(cases, selection) {
  if (selection === "all") return cases;
  const wanted = selection.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = wanted.filter((item) => !cases.some((entry) => entry.id === item || fixtureCode(entry.id) === item));
  if (unknown.length) throw new UsageError(`Unknown fixture id(s): ${unknown.join(", ")}`);
  return cases.filter((entry) => wanted.includes(entry.id) || wanted.includes(fixtureCode(entry.id)));
}

function withoutHistory(fixture) {
  const { history: _history, ...rest } = fixture || {};
  return rest;
}

function fixtureFile(dir, id) {
  return path.join(dir, `${id}.json`);
}

function readFixtureFile(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function captureFixture(entry) {
  const input = JSON.parse(JSON.stringify(entry.input));
  const expect = await harness.runGoldenFixture({ ...entry, input });
  return {
    schemaVersion: SCHEMA_VERSION,
    id: entry.id,
    kind: entry.kind,
    manager: entry.manager,
    source: entry.source,
    stubs: entry.stubs,
    env: entry.env,
    input,
    expect,
  };
}

// Line diff with three lines of context; enough for argv and pretty JSON.
function unifiedDiff(beforeLines, afterLines, label) {
  const n = beforeLines.length;
  const m = afterLines.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = beforeLines[i] === afterLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && beforeLines[i] === afterLines[j]) {
      ops.push({ type: " ", text: beforeLines[i], a: i, b: j });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ type: "-", text: beforeLines[i], a: i, b: j });
      i += 1;
    } else {
      ops.push({ type: "+", text: afterLines[j], a: i, b: j });
      j += 1;
    }
  }
  const changed = ops.map((op, index) => (op.type === " " ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) return "";
  const output = [`--- ${label} (fixture)`, `+++ ${label} (current builders)`];
  const context = 3;
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (end + 1 < changed.length && changed[end + 1] - changed[end] <= context * 2 + 1) end += 1;
    const from = Math.max(0, changed[start] - context);
    const to = Math.min(ops.length - 1, changed[end] + context);
    const hunk = ops.slice(from, to + 1);
    const aStart = hunk[0].a + 1;
    const bStart = hunk[0].b + 1;
    const aCount = hunk.filter((op) => op.type !== "+").length;
    const bCount = hunk.filter((op) => op.type !== "-").length;
    output.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) output.push(`${op.type}${op.text}`);
    start = end + 1;
  }
  return output.join("\n");
}

function describeDifferences(stored, current) {
  const lines = [];
  const storedExpect = stored.expect || {};
  const currentExpect = current.expect || {};
  for (const key of ["schemaVersion", "kind", "manager", "source", "stubs", "env", "input"]) {
    if (!util.isDeepStrictEqual(stored[key], current[key])) {
      lines.push(unifiedDiff(prettyLines(stored[key]), prettyLines(current[key]), key));
    }
  }
  const keys = new Set([...Object.keys(storedExpect), ...Object.keys(currentExpect)]);
  for (const key of keys) {
    if (util.isDeepStrictEqual(storedExpect[key], currentExpect[key])) continue;
    const argvLike = Array.isArray(storedExpect[key]) && Array.isArray(currentExpect[key])
      && [...storedExpect[key], ...currentExpect[key]].every((item) => typeof item === "string");
    lines.push(argvLike
      ? unifiedDiff(storedExpect[key].map((item) => JSON.stringify(item)), currentExpect[key].map((item) => JSON.stringify(item)), `expect.${key}`)
      : unifiedDiff(prettyLines(storedExpect[key]), prettyLines(currentExpect[key]), `expect.${key}`));
  }
  return lines.filter(Boolean).join("\n");
}

function prettyLines(value) {
  return value === undefined ? ["<absent>"] : JSON.stringify(value, null, 2).split("\n");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fixtureText(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

async function runCheck(options, cases) {
  let failures = 0;
  for (const entry of cases) {
    const file = fixtureFile(options.out, entry.id);
    const stored = readFixtureFile(file);
    if (!stored) {
      console.error(`MISSING ${entry.id}: ${path.relative(process.cwd(), file)} does not exist.`);
      failures += 1;
      continue;
    }
    const current = await captureFixture(entry);
    const problems = [];
    if (!Array.isArray(stored.history) || !stored.history.length || stored.history.some((item) => !item?.at || !item?.reason)) {
      problems.push("history must list {at, reason} for every write");
    }
    const leaks = harness.findMachineData(fs.readFileSync(file, "utf8"));
    if (leaks.length) problems.push(`fixture text contains machine data or a secret (${leaks.length} match(es))`);
    if (problems.length || !util.isDeepStrictEqual(withoutHistory(stored), current)) {
      failures += 1;
      console.error(`DIFF ${entry.id}`);
      for (const problem of problems) console.error(`  ${problem}`);
      const diff = describeDifferences(stored, current);
      if (diff) console.error(diff);
    }
  }
  if (options.selection === "all" && fs.existsSync(options.out)) {
    const known = new Set(cases.map((entry) => `${entry.id}.json`));
    for (const name of fs.readdirSync(options.out).filter((item) => item.endsWith(".json")).sort()) {
      if (!known.has(name)) {
        console.error(`UNEXPECTED ${name}: not in the capture list.`);
        failures += 1;
      }
    }
  }
  if (failures) {
    console.error(`Engine goldens: ${failures} of ${cases.length} fixture(s) differ from the current builders.`);
    return 1;
  }
  console.log(`Engine goldens: ${cases.length} fixture(s) match the current builders.`);
  return 0;
}

async function runWrite(options, cases) {
  const at = options.at || today();
  fs.mkdirSync(options.out, { recursive: true });
  let written = 0;
  let unchanged = 0;
  for (const entry of cases) {
    const file = fixtureFile(options.out, entry.id);
    const stored = readFixtureFile(file);
    const current = await captureFixture(entry);
    if (stored && util.isDeepStrictEqual(withoutHistory(stored), current)) {
      unchanged += 1;
      continue;
    }
    const history = [...(Array.isArray(stored?.history) ? stored.history : []), { at, reason: options.reason }];
    const text = fixtureText({ ...current, history });
    const leaks = harness.findMachineData(text);
    if (leaks.length) throw new Error(`Refusing to write ${entry.id}: the capture contains machine data or a secret.`);
    fs.writeFileSync(file, text);
    written += 1;
    console.log(`${stored ? "UPDATED" : "CREATED"} ${entry.id}`);
  }
  console.log(`Engine goldens: ${written} written, ${unchanged} unchanged.`);
  if (options.selection === "all") {
    const known = new Set(cases.map((entry) => `${entry.id}.json`));
    const stale = fs.readdirSync(options.out).filter((name) => name.endsWith(".json") && !known.has(name));
    for (const name of stale) console.warn(`WARNING ${name} is not in the capture list; delete it if it is obsolete.`);
  }
  return 0;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${usage()}`);
    return 2;
  }
  if (options.mode === "help") {
    console.log(usage());
    return 0;
  }
  if (options.mode === "write" && !options.reason) {
    console.error("Refusing to write engine goldens without --reason \"<text>\"; the reason is recorded in each fixture's history.");
    return 2;
  }
  let cases;
  try {
    cases = selectCases(captureList(), options.selection);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  if (options.mode === "list") {
    for (const entry of cases) console.log(`${entry.id}\t${entry.kind}\t${entry.manager}\t${entry.source}`);
    return 0;
  }
  harness.prepareGoldenEnvironment();
  return options.mode === "write" ? runWrite(options, cases) : runCheck(options, cases);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = { captureList, main, unifiedDiff };
