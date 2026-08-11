const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadGgufUi() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "js", "gguf-model-ui.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "gguf-model-ui.js" });
  return context.window.LlamaGgufUi;
}

test("selectedVariant prefers a global exact path before same-basename fallback", () => {
  const ui = loadGgufUi();
  const models = [
    { path: "D:/models/first", ggufVariants: [{ launchModel: "D:/models/first/model.gguf" }] },
    { path: "D:/models/second", ggufVariants: [{ launchModel: "D:/models/second/model.gguf" }] },
  ];

  const exact = ui.selectedVariant(models, "D:\\models\\second\\model.gguf");
  assert.equal(exact.model.path, "D:/models/second");
  assert.equal(exact.variant.launchModel, "D:/models/second/model.gguf");

  const fallback = ui.selectedVariant(models, "model.gguf");
  assert.equal(fallback.model.path, "D:/models/first");
});
