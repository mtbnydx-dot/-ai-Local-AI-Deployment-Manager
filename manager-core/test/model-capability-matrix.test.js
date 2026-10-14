const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const matrix = require("../model-capability-matrix");

const FIXTURES = path.join(__dirname, "fixtures", "model-cards");
// The chat template signature of Qwen3.8 checkpoints (XML tool calls plus reasoning_effort).
// Detecting it from chat_template.jinja belongs to the template-signature work (MOD-7); here
// the caller states it, as the card pipeline will.
const QWEN38_SIGNATURE = "qwen38-xml-effort";

function fixtureConfig(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name, "config.json"), "utf8"));
}

test("declared model_type wins over an earlier entry that only matches the name", () => {
  const resolved = matrix.resolveModelCapabilityEntry({
    model: "someone/qwen3-flash-next-awq",
    config: { model_type: "qwen2", architectures: ["Qwen2ForCausalLM"] },
  });
  assert.equal(resolved.id, "qwen2.5");
  assert.equal(resolved.matchedBy, "modelType");
  assert.equal(resolved.heuristic, false);
});

test("Qwen3.5 ModelOpt checkpoints get qwen3_xml while Qwen3.8 keeps qwen3_coder", () => {
  const qwen36 = matrix.resolveModelCapabilityEntry({
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    config: { model_type: "qwen3_6_moe", quantization_config: { quant_method: "modelopt" } },
  });
  assert.equal(qwen36.id, "qwen3.5-3.6");
  const vllm36 = matrix.resolveEngineCapabilities(qwen36.entry, "vllm", { quantMethod: "modelopt", model: qwen36.model });
  assert.equal(vllm36.toolCallParser, "qwen3_xml");
  assert.equal(vllm36.speculative.auto, "off");
  assert.match(vllm36.speculative.reason, /stays off/);

  // Real Qwen3.8 checkpoints declare qwen3_5 (02 section 2); only the template tells them from Qwen3.5/3.6.
  const qwen38 = matrix.resolveModelCapabilityEntry({
    model: "Qwen/Qwen3.8-27B-FP8",
    config: fixtureConfig("qwen38-27b-fp8"),
    templateSignature: QWEN38_SIGNATURE,
  });
  assert.equal(qwen38.id, "qwen3.8");
  assert.match(qwen38.matchedBy, /templateSignature/);
  assert.equal(qwen38.heuristic, false);
  const vllm38 = matrix.resolveEngineCapabilities(qwen38.entry, "vllm", { quantMethod: "modelopt" });
  assert.equal(vllm38.toolCallParser, "qwen3_coder");
  assert.equal(vllm38.speculative.auto, "off");

  // The same declared type without the Qwen3.8 template stays Qwen3.5/3.6, and so does a real 3.6 checkpoint.
  const withoutTemplate = matrix.resolveModelCapabilityEntry({ model: "Qwen/Qwen3.8-27B-FP8", config: fixtureConfig("qwen38-27b-fp8") });
  assert.equal(withoutTemplate.id, "qwen3.5-3.6");
  const real36 = matrix.resolveModelCapabilityEntry({ model: "Qwen/Qwen3.6-35B-A3B-FP8", config: fixtureConfig("qwen36-35b-a3b-fp8"), templateSignature: null });
  assert.equal(real36.id, "qwen3.5-3.6");
});

test("the old fictional qwen3_8 identity and Qwen3.8 repository names still resolve to qwen3.8", () => {
  const typed = matrix.resolveModelCapabilityEntry({ model: "Qwen/Qwen3.8-27B-NVFP4", config: { model_type: "qwen3_8", quantization_config: { quant_method: "modelopt" } } });
  assert.equal(typed.id, "qwen3.8");
  assert.equal(typed.matchedBy, "modelType");
  const named = matrix.resolveModelCapabilityEntry({ model: "Qwen/Qwen3.8-27B" });
  assert.equal(named.id, "qwen3.8");
  assert.equal(named.heuristic, true);
  assert.equal(matrix.resolveModelCapabilityEntry({ model: "Qwen/Qwen3.8-Flash-Next-NVFP4" }).id, "qwen3.8-flash-next");
});

test("Flash-Next is recognised by qwen4_exp identity and gates the SGLang image on NVFP4 weights", () => {
  const subject = { model: "/models/Qwen3.8-Flash-Next", config: { model_type: "qwen4_exp", architectures: ["Qwen4ExpForCausalLM"] } };
  assert.equal(matrix.matchesCapabilityEntry("qwen3.8-flash-next", subject), true);
  const resolved = matrix.resolveModelCapabilityEntry(subject);
  assert.equal(resolved.matchedBy, "modelType");
  const nvfp4 = matrix.resolveEngineCapabilities(resolved.entry, "sglang", { quantMethod: "modelopt_fp4" });
  assert.equal(nvfp4.image, "sglangFlashNext");
  const bf16 = matrix.resolveEngineCapabilities(resolved.entry, "sglang", { quantMethod: "" });
  assert.equal(bf16.image, "");
  assert.match(bf16.imageSkippedReason, /only used for/);
});

test("GGUF general.architecture resolves llama-side entries without a config.json", () => {
  const resolved = matrix.resolveModelCapabilityEntry({ model: "unsloth/Qwen3-8B-GGUF", ggufArchitecture: "qwen3moe" });
  assert.equal(resolved.id, "qwen3");
  assert.equal(resolved.matchedBy, "gguf");
  const llama = matrix.resolveEngineCapabilities(resolved.entry, "llama", {});
  assert.equal(llama.speculative.auto, "dflash");
});

test("name-only matches are reported as heuristics and counted", () => {
  const before = matrix.getNameHeuristicStats().find((item) => item.id === "deepseek")?.hits || 0;
  const seen = [];
  const resolved = matrix.resolveModelCapabilityEntry({ model: "deepseek-ai/DeepSeek-R1", onNameHeuristic: (hit) => seen.push(hit) });
  assert.equal(resolved.id, "deepseek");
  assert.equal(resolved.matchedBy, "name");
  assert.equal(resolved.heuristic, true);
  assert.deepEqual(seen, [{ id: "deepseek", model: "deepseek-ai/DeepSeek-R1" }]);
  const after = matrix.getNameHeuristicStats().find((item) => item.id === "deepseek").hits;
  assert.equal(after, before + 1);
});

test("retired and documented entries carry engine support flags", () => {
  const muse = matrix.resolveModelCapabilityEntry({ config: { model_type: "muse_glimmer" } });
  assert.equal(muse.entry.vllm.supported, false);
  assert.equal(muse.entry.download.level, "block");
  const llama3 = matrix.resolveModelCapabilityEntry({ config: { architectures: ["LlamaForCausalLM"] } });
  assert.equal(llama3.id, "llama3");
  assert.equal(llama3.confidence, "documented");
  assert.equal(matrix.resolveEngineCapabilities(llama3.entry, "vllm", {}).toolCallParser, "llama3_json");
  const unknown = matrix.resolveModelCapabilityEntry({ model: "acme/totally-new-arch", config: { model_type: "acme_v1" } });
  assert.equal(unknown.entry, null);
  assert.equal(unknown.matchedBy, "");
});

test("the matrix description lists entries for the UI and stays loadable", () => {
  const described = matrix.describeModelCapabilityMatrix({ force: true });
  assert.ok(described.entries.length >= 10);
  assert.ok(described.entries.every((entry) => entry.id && entry.label));
  assert.equal(described.source, "bundled");
});
