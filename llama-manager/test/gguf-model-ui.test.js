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

test("an architecture outside the verified list reads as unknown, never compatible", () => {
  const ui = loadGgufUi();
  // The server's shape for an unmatched architecture (08 P0-15).
  const unknown = ui.normalizeCompatibility({
    status: "unknown",
    supported: null,
    message: "newarch 不在已验证的架构列表中，能否运行取决于当前 llama.cpp 版本。 / newarch is not in the verified architecture list. Whether it runs depends on the current llama.cpp build.",
  });
  assert.equal(unknown.label, "未知（未验证）");
  assert.equal(unknown.state, "warn");
  assert.match(unknown.detail, /newarch/);
  assert.equal(ui.normalizeCompatibility({ status: "unknown" }).label, "未知（未验证）");

  // Known architectures keep their labels.
  assert.equal(ui.normalizeCompatibility({ status: "not-required", supported: true }).label, "兼容");
  assert.equal(ui.normalizeCompatibility({ status: "ok", supported: true }).state, "ok");
  assert.equal(ui.normalizeCompatibility({ status: "unsupported", supported: false }).state, "fail");
  assert.equal(ui.normalizeCompatibility(undefined).label, "待核验");
});

test("an unknown architecture renders with the warn style in the library", () => {
  const ui = loadGgufUi();
  const model = {
    path: "D:/models/newarch",
    hasGguf: true,
    ggufVariants: [{ launchModel: "D:/models/newarch/model.gguf", runtimeCompatibility: { status: "unknown", supported: null, message: "unverified" } }],
  };
  const [variant] = ui.variantsFor(model);
  assert.equal(variant.compatibility.state, "warn");
  assert.equal(variant.compatibility.label, "未知（未验证）");
});
