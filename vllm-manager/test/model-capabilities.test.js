const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isMuseGlimmerModel,
  normalizeSpeculativeMode,
  resolveSpeculativeConfig,
  resolveVllmModelCapabilities,
} = require("../lib/model-capabilities");

test("Qwen3.6 ModelOpt MoE keeps automatic MTP off but allows explicit opt-in", () => {
  const config = {
    architectures: ["Qwen3_5MoeForConditionalGeneration"],
    model_type: "qwen3_5_moe",
    mtp_num_hidden_layers: 1,
    quantization_config: { quant_method: "modelopt" },
    num_experts: 256,
  };
  assert.equal(resolveSpeculativeConfig({ model: "Qwen3.6-35B-NVFP4", config, requestedMode: "auto" }), null);
  assert.deepEqual(resolveSpeculativeConfig({ model: "Qwen3.6-35B-NVFP4", config, requestedMode: "mtp" }), {
    method: "mtp",
    num_speculative_tokens: 1,
    moe_backend: "triton",
  });
});

test("Qwen3.6 FP8 can opt into automatic MTP while the fallback stays off", () => {
  const qwen = {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    model_type: "qwen3_5",
    mtp_num_hidden_layers: 1,
    quantization_config: { quant_method: "fp8" },
  };
  assert.deepEqual(resolveSpeculativeConfig({ model: "Qwen3.6-27B-FP8", config: qwen, requestedMode: "auto" }), {
    method: "mtp",
    num_speculative_tokens: 1,
  });
  assert.equal(resolveSpeculativeConfig({ model: "Llama-3-8B", config: {}, requestedMode: "auto" }), null);
  assert.equal(resolveSpeculativeConfig({ model: "Qwen3.6-27B-FP8", config: qwen }), null);
  assert.equal(normalizeSpeculativeMode("bad-mode"), "off");
});

test("model capabilities choose parser by checkpoint format", () => {
  const modelopt = resolveVllmModelCapabilities({
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    config: { architectures: ["Qwen3_5MoeForConditionalGeneration"], mtp_num_hidden_layers: 1, quantization_config: { quant_method: "modelopt" } },
    speculativeMode: "auto",
  });
  const fp8 = resolveVllmModelCapabilities({
    model: "Qwen/Qwen3.6-27B-FP8",
    config: { architectures: ["Qwen3_5ForConditionalGeneration"], mtp_num_hidden_layers: 1, quantization_config: { quant_method: "fp8" } },
    speculativeMode: "auto",
  });
  assert.equal(modelopt.toolCallParser, "qwen3_xml");
  assert.equal(fp8.toolCallParser, "qwen3_coder");
  assert.equal(modelopt.reasoningParser, "qwen3");
});

test("Muse Glimmer is blocked before vLLM container startup", () => {
  const runtimeMetadata = { version: "v0.26.0", transformersVersion: "5.14.1" };
  const fromConfig = resolveVllmModelCapabilities({
    model: "D:/AI/models/meta-muse-glimmer",
    config: {
      model_type: "muse_glimmer",
      architectures: ["MuseGlimmerForConditionalGeneration"],
      transformers_version: "5.15.0.dev0",
    },
    runtimeMetadata,
  });
  assert.equal(fromConfig.unsupportedCode, "muse_glimmer");
  assert.match(fromConfig.unsupportedReason, /vLLM v0\.26\.0/);
  assert.match(fromConfig.unsupportedReason, /Transformers 5\.14\.1/);
  assert.match(fromConfig.unsupportedReason, /Transformers 5\.15\.0\.dev0/);
  assert.match(fromConfig.unsupportedReason, /llama-manager/);
  assert.match(fromConfig.unsupportedReason, /GGUF/);

  const fromModelName = resolveVllmModelCapabilities({
    model: "meta-models/Muse-Glimmer-30B",
    config: {},
    runtimeMetadata,
  });
  assert.equal(fromModelName.unsupportedCode, "muse_glimmer");
});

test("Muse identity prefers config and only falls back to normalized Windows/repository names", () => {
  assert.equal(isMuseGlimmerModel({
    model_type: "llama",
    architectures: ["LlamaForCausalLM"],
  }, "D:\\AI\\models\\Muse-Glimmer-30B"), false);
  assert.equal(isMuseGlimmerModel({}, "D:\\AI\\models\\meta-models-Muse-Glimmer-30B-GGUF"), true);
  assert.equal(isMuseGlimmerModel({}, "meta-models/Muse_Glimmer-30B"), true);
});

test("Muse advanced-risk override is explicit and uses runtime metadata in its warning", () => {
  const capabilities = resolveVllmModelCapabilities({
    model: "D:\\AI\\models\\Muse-Glimmer-30B",
    config: { model_type: "muse_glimmer" },
    runtimeMetadata: { version: "v0.26.0", transformersVersion: "5.14.1" },
    allowMuseGlimmer: true,
  });
  assert.equal(capabilities.unsupportedCode, "");
  assert.equal(capabilities.unsupportedReason, undefined);
  assert.equal(capabilities.museGlimmerOverride, true);
  assert.match(capabilities.notes[0], /VLLM_ALLOW_MUSE_GLIMMER=1/);
  assert.match(capabilities.notes[0], /Transformers 5\.14\.1/);
});
