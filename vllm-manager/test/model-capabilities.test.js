const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  inspectPackagedMtpTensors,
  isMuseGlimmerModel,
  normalizeSpeculativeMode,
  resolveSpeculativeConfig,
  resolveVllmModelCapabilities,
} = require("../lib/model-capabilities");

function withMtpIndex(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-mtp-index-"));
  fs.writeFileSync(path.join(directory, "model.safetensors.index.json"), JSON.stringify({
    weight_map: {
      "model.layers.0.self_attn.q_proj.weight": "model-00001-of-00002.safetensors",
      "mtp.layers.0.self_attn.q_proj.weight": "model-00002-of-00002.safetensors",
      "mtp.layers.0.mlp.down_proj.weight": "model-00002-of-00002.safetensors",
    },
  }));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("Qwen ModelOpt MoE keeps automatic MTP off and requires packaged MTP tensors for explicit opt-in", () => {
  const config = {
    architectures: ["Qwen3_5MoeForConditionalGeneration"],
    model_type: "qwen3_5_moe",
    mtp_num_hidden_layers: 1,
    quantization_config: { quant_method: "modelopt" },
    num_experts: 256,
  };
  assert.equal(resolveSpeculativeConfig({ model: "Qwen3.6-35B-NVFP4", config, requestedMode: "auto" }), null);
  assert.equal(resolveSpeculativeConfig({ model: "Qwen3.6-35B-NVFP4", config, requestedMode: "mtp" }), null);
  withMtpIndex((localPath) => {
    assert.deepEqual(resolveSpeculativeConfig({ model: "Qwen3.6-35B-NVFP4", config, localPath, requestedMode: "mtp" }), {
      method: "mtp",
      num_speculative_tokens: 1,
      moe_backend: "triton",
    });
  });
});

test("Qwen FP8 auto MTP requires exact packaged tensor evidence while the fallback stays off", () => {
  const qwen = {
    architectures: ["Qwen3_5ForConditionalGeneration"],
    model_type: "qwen3_5",
    mtp_num_hidden_layers: 1,
    quantization_config: { quant_method: "fp8" },
  };
  assert.equal(resolveSpeculativeConfig({ model: "Qwen3.6-27B-FP8", config: qwen, requestedMode: "auto" }), null);
  withMtpIndex((localPath) => {
    const inspected = inspectPackagedMtpTensors(localPath);
    assert.equal(inspected.known, true);
    assert.equal(inspected.tensorCount, 2);
    assert.deepEqual(resolveSpeculativeConfig({ model: "Qwen3.8-27B-FP8", config: qwen, localPath, requestedMode: "auto", requestedTokens: 3 }), {
      method: "mtp",
      num_speculative_tokens: 3,
    });
  });
  assert.equal(resolveSpeculativeConfig({ model: "Llama-3-8B", config: {}, requestedMode: "auto" }), null);
  assert.equal(resolveSpeculativeConfig({ model: "Qwen3.6-27B-FP8", config: qwen }), null);
  assert.equal(normalizeSpeculativeMode("bad-mode"), "off");
  assert.equal(normalizeSpeculativeMode("dspark"), "dspark");
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

  const qwen38Nvfp4 = resolveVllmModelCapabilities({
    model: "Qwen/Qwen3.8-27B-NVFP4",
    config: { architectures: ["Qwen3_8ForConditionalGeneration"], quantization_config: { quant_method: "modelopt" } },
  });
  assert.equal(qwen38Nvfp4.toolCallParser, "qwen3_coder");

  const qwen3EightB = resolveVllmModelCapabilities({
    model: "Qwen/Qwen3-8B",
    config: { architectures: ["Qwen3ForCausalLM"], quantization_config: { quant_method: "fp8" } },
  });
  assert.notEqual(qwen3EightB.toolCallParser, "qwen3_coder", "Qwen3-8B must not be mistaken for the Qwen3.8 family");
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
  assert.match(fromConfig.unsupportedReason, /retired/);
  assert.match(fromConfig.unsupportedReason, /another model/);

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

test("Muse retirement policy cannot be bypassed by the legacy environment flag", () => {
  const capabilities = resolveVllmModelCapabilities({
    model: "D:\\AI\\models\\Muse-Glimmer-30B",
    config: { model_type: "muse_glimmer" },
    runtimeMetadata: { version: "v0.26.0", transformersVersion: "5.14.1" },
    allowMuseGlimmer: true,
  });
  assert.equal(capabilities.unsupportedCode, "muse_glimmer");
  assert.equal(capabilities.museGlimmerOverride, false);
  assert.match(capabilities.unsupportedReason, /retired/);
  assert.match(capabilities.unsupportedReason, /no longer bypasses/);
});

test("the pinned vLLM 0.28 image blocks BNB checkpoints until vllm-bnb-plugin is added", () => {
  const capabilities = resolveVllmModelCapabilities({
    model: "unsloth/Llama-30B-bnb-4bit",
    config: {
      model_type: "llama",
      quantization_config: { quant_method: "bitsandbytes_4bit" },
    },
    runtimeMetadata: {
      version: "v0.28.0",
      transformersVersion: "5.15.1",
      bitsAndBytesPlugin: false,
    },
  });
  assert.equal(capabilities.unsupportedCode, "bitsandbytes_plugin_missing");
  assert.match(capabilities.unsupportedReason, /vllm-bnb-plugin/);
});
