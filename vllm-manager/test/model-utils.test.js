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
  return context.window.VllmModelUtils;
}

test("vLLM model utils normalize download quantization aliases", () => {
  const utils = loadUtils();
  assert.equal(utils.normalizeDownloadQuantValue("model-opt-fp4"), "NVFP4");
  assert.equal(utils.normalizeDownloadQuantValue("MTP_GGUF"), "GGUF");
  assert.equal(utils.normalizeDownloadQuantValue("原始 BF16/FP16"), "BASE");
  assert.equal(utils.chooseDownloadPrecision("FP8", ["BF16", "NVFP4", "FP8"], "INT4"), "NVFP4");
});

test("vLLM model utils infer model metadata from repo names", () => {
  const utils = loadUtils();
  const selection = utils.inferDownloadSelection("Qwen/Qwen3-32B-AWQ", "", "huggingface");
  assert.equal(selection.developer, "Qwen");
  assert.equal(selection.modelVersion, "Qwen3");
  assert.equal(selection.spec, "32B");
  assert.equal(selection.precision, "AWQ");
  assert.equal(utils.inferModelQuantLabel("Qwen3-27B-NVFP4-MTP"), "NVFP4/FP4");
});

test("vLLM runnable filters reject GGUF-only and unsupported remote models", () => {
  const utils = loadUtils();
  assert.equal(utils.isManagerRunnableModelItem({ model: "foo.gguf", format: "gguf" }), false);
  assert.equal(utils.isManagerRunnableRemoteModel({ id: "org/model-GGUF", hasGguf: true, hasSafetensors: false }), false);
  assert.equal(utils.isManagerRunnableRemoteModel({ id: "org/model-AWQ", hasSafetensors: true, quantFormats: ["AWQ"] }), true);
  assert.equal(utils.isManagerRunnableRemoteModel({ id: "org/embedding-model", hasSafetensors: true }), false);
});

test("vLLM remote quant filters match actual formats", () => {
  const utils = loadUtils();
  const model = { hasQuantizedFiles: true, hasSafetensors: true, quantFormats: ["AWQ", "NVFP4"] };
  assert.equal(utils.modelRemoteQuantMatches(model, "AWQ"), true);
  assert.equal(utils.modelRemoteQuantMatches(model, "INT4"), true);
  assert.equal(utils.modelRemoteQuantMatches(model, "GGUF"), false);
  assert.equal(utils.modelRemoteSizeMatches({ paramsB: 27 }, "large"), true);
});
