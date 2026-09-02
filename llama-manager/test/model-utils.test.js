const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUtils() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "js", "model-utils.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "model-utils.js" });
  return context.window.LlamaModelUtils;
}

test("llama model utils normalize download quantization aliases", () => {
  const utils = loadUtils();
  assert.equal(utils.normalizeDownloadQuantValue("q4km"), "Q4_K_M");
  assert.equal(utils.normalizeDownloadQuantValue("MTP_GGUF"), "GGUF");
  assert.equal(utils.normalizeDownloadQuantValue("原始 BF16/FP16"), "BASE");
  assert.equal(utils.chooseDownloadPrecision("Q8_0", ["Q4_K_M", "Q6_K", "Q8_0"], "Q4"), "Q4_K_M");
});

test("llama model utils infer model metadata from repo names", () => {
  const utils = loadUtils();
  const selection = utils.inferDownloadSelection("bartowski/Qwen3-32B-GGUF", "", "huggingface");
  assert.equal(selection.developer, "bartowski");
  assert.equal(selection.modelVersion, "Qwen3");
  assert.equal(selection.spec, "32B");
  assert.equal(selection.precision, "GGUF");
  assert.equal(utils.inferModelQuantLabel("Qwen3-32B-Q4_K_M.gguf"), "Q4_K_M");
});

test("llama runnable filters require GGUF-compatible models", () => {
  const utils = loadUtils();
  assert.equal(utils.isManagerRunnableModelItem({ model: "foo.gguf", format: "gguf" }), true);
  assert.equal(utils.isManagerRunnableModelItem({ model: "org/model-AWQ", format: "auto" }), false);
  assert.equal(utils.isManagerRunnableRemoteModel({ id: "org/model-GGUF", hasGguf: true, hasSafetensors: false }), true);
  assert.equal(utils.isManagerRunnableRemoteModel({ id: "org/model-AWQ", hasSafetensors: true, quantFormats: ["AWQ"] }), false);
});

test("llama remote quant filters match GGUF families", () => {
  const utils = loadUtils();
  const model = { hasQuantizedFiles: true, hasGguf: true, quantFormats: ["Q4_K_M", "Q8_0"] };
  assert.equal(utils.modelRemoteQuantMatches(model, "GGUF"), true);
  assert.equal(utils.modelRemoteQuantMatches(model, "Q4"), true);
  assert.equal(utils.modelRemoteQuantMatches(model, "FP8"), false);
  assert.equal(utils.modelRemoteSizeMatches({ paramsB: 7 }, "small"), true);
});
