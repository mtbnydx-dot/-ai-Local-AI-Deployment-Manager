const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// GET /api/model/config resolves parsers through manager-core's resolveParsers
// (docs/overhaul/02-models.md 8.6, MOD-7). The model directory lives under a
// temp models root and the runtime facts are a stub; no engine, Docker or live
// data is touched.
const MODELS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-parsers-models-"));
process.env.VLLM_MODELS_ROOT = MODELS_ROOT;
test.after(() => fs.rmSync(MODELS_ROOT, { recursive: true, force: true }));

const manager = require("../server");

const FIXTURE = path.join(__dirname, "..", "..", "manager-core", "test", "fixtures", "model-cards", "qwen38-27b-fp8");
const MODEL_DIR = path.join(MODELS_ROOT, "qwen38-27b-fp8");
fs.mkdirSync(MODEL_DIR, { recursive: true });
for (const name of ["config.json", "chat_template.jinja"]) fs.copyFileSync(path.join(FIXTURE, name), path.join(MODEL_DIR, name));

function stubFacts({ tool, reasoning, registries = null }) {
  const calls = [];
  const flags = [];
  if (tool) flags.push({ flag: "--tool-call-parser", aliases: [], choices: tool });
  if (reasoning) flags.push({ flag: "--reasoning-parser", aliases: [], choices: reasoning });
  return {
    calls,
    async get(runtimeId) {
      calls.push(runtimeId);
      return { schemaVersion: 1, engineId: "vllm", runtimeId, imageId: `sha256:${"b".repeat(64)}`, flags: flags.length ? { flags } : null, registries };
    },
  };
}

test.afterEach(() => manager.setParserRuntimeFacts(null));

test("/api/model/config returns parsers keyed by catalog id with their sources", async () => {
  const facts = stubFacts({ tool: ["hermes", "qwen3_coder", "qwen3_xml"], reasoning: ["qwen3", "deepseek_r1"] });
  manager.setParserRuntimeFacts(facts);
  const config = await manager.getModelConfigRequest({ model: MODEL_DIR, source: "local" });

  assert.equal(config.found, true);
  assert.deepEqual(facts.calls, ["vllm@0.28.0"]);
  assert.equal(config.parsers.toolCallParser.value, "qwen3_coder");
  assert.equal(config.parsers.toolCallParser.source, "knowledge");
  assert.equal(config.parsers.toolCallParser.listSource, "introspected");
  assert.equal(config.parsers.reasoningParser.value, "qwen3");
  assert.equal(config.parsers.autoToolChoice.value, true);
  assert.equal(config.parsers.signatureId, "qwen38-xml-effort");
  assert.equal(config.parsers.familyId, "qwen3.8");
  assert.equal(config.parsers.runtimeId, "vllm@0.28.0");
  assert.deepEqual(config.parsers.warnings, []);
  // The legacy fields read the same answers.
  assert.equal(config.recommendedToolCallParser, "qwen3_coder");
  assert.equal(config.recommendedReasoningParser, "qwen3");
  const wire = JSON.parse(JSON.stringify(config.parsers));
  assert.deepEqual(Object.keys(wire).slice(0, 3), ["toolCallParser", "reasoningParser", "autoToolChoice"]);
  assert.equal(wire.tool, undefined);
});

test("a parser missing from the image is reported, never dropped silently", async () => {
  manager.setParserRuntimeFacts(stubFacts({ tool: ["hermes"], reasoning: ["deepseek_r1"] }));
  const config = await manager.getModelConfigRequest({ model: MODEL_DIR, source: "local" });

  assert.equal(config.parsers.toolCallParser.value, "");
  assert.equal(config.parsers.toolCallParser.requested, "qwen3_coder");
  assert.equal(config.parsers.autoToolChoice.value, false);
  assert.deepEqual(config.parsers.warnings.map((item) => [item.code, item.kind, item.parser]), [
    ["parser_not_in_image", "tool", "qwen3_coder"],
    ["parser_not_in_image", "reasoning", "qwen3"],
  ]);
  assert.match(config.parsers.warnings[0].message, /vllm-openai/);
  assert.equal(config.recommendedToolCallParser, "");
});

test("without readable runtime facts the knowledge answer stands and nothing is flagged", async () => {
  manager.setParserRuntimeFacts({ get: async () => { throw new Error("runtime_image_missing"); } });
  const config = await manager.getModelConfigRequest({ model: MODEL_DIR, source: "local" });
  assert.equal(config.parsers.toolCallParser.value, "qwen3_coder");
  assert.equal(config.parsers.toolCallParser.listSource, null);
  assert.deepEqual(config.parsers.warnings, []);
});

test("summarizeModelConfigCapabilities uses the quantization to pick the quant-scoped tool parser", () => {
  const summary = manager.summarizeModelConfigCapabilities({
    architectures: ["Qwen3_5MoeForConditionalGeneration"],
    model_type: "qwen3_5_moe",
    text_config: { model_type: "qwen3_5_moe_text" },
    quantization_config: { quant_method: "modelopt" },
  }, "nv-community/Qwen3.6-35B-A3B-NVFP4");
  assert.equal(summary.parsers.toolCallParser.value, "qwen3_xml");
  assert.equal(summary.parsers.toolCallParser.source, "knowledge");
  assert.equal(summary.recommendedToolCallParser, "qwen3_xml");
  assert.equal(summary.parsers.reasoningParser.value, "qwen3");
});

test("launch normalization reports an unknown parser instead of dropping it", async () => {
  assert.equal(manager.normalizeToolCallParser(""), "");
  assert.equal(manager.normalizeToolCallParser(" Hermes "), "hermes");
  assert.equal(manager.normalizeReasoningParser("auto"), "auto");
  // Without parser lists any well-formed name passes; the engine itself has the final say.
  assert.equal(manager.normalizeToolCallParser("brand_new_parser"), "brand_new_parser");
  assert.throws(() => manager.normalizeToolCallParser("bad name; rm"), (error) => error.status === 400 && error.code === "invalid_parser_name");

  manager.setParserRuntimeFacts(stubFacts({ tool: ["hermes", "qwen3_coder"], reasoning: ["qwen3"] }));
  await manager.getModelConfigRequest({ model: MODEL_DIR, source: "local" });
  assert.equal(manager.normalizeLaunchConfig({ toolCallParser: "hermes", reasoningParser: "qwen3" }).toolCallParser, "hermes");
  assert.equal(manager.normalizeLaunchConfig({ toolCallParser: "auto" }).toolCallParser, "auto");
  assert.throws(() => manager.normalizeLaunchConfig({ toolCallParser: "mistral" }), (error) => {
    return error.status === 400 && error.code === "parser_not_in_image" && /hermes, qwen3_coder/.test(error.message);
  });
  assert.throws(() => manager.normalizeLaunchConfig({ reasoningParser: "gemma4" }), (error) => error.code === "parser_not_in_image");
});
