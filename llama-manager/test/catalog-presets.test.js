const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadCatalog() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "js", "catalog.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "catalog.js" });
  return context.window.LlamaCatalog;
}

// The GGUF files each preset repo listed on the read-only Hugging Face model API
// (GET /api/models/<repo>) when the presets were last checked, 2026-10-14. All
// of these repos were ungated. Re-check before changing a repo or a precision.
const VERIFIED_QUANT_FILES = {
  "Qwen/Qwen3-0.6B-GGUF": ["Qwen3-0.6B-Q8_0.gguf"],
  "Qwen/Qwen3-4B-GGUF": ["Qwen3-4B-Q4_K_M.gguf"],
  "Qwen/Qwen3-8B-GGUF": ["Qwen3-8B-Q4_K_M.gguf"],
  "Qwen/Qwen3-14B-GGUF": ["Qwen3-14B-Q4_K_M.gguf"],
  "Qwen/Qwen3-32B-GGUF": ["Qwen3-32B-Q4_K_M.gguf"],
  "unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF": ["DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf"],
  "unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF": ["DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf"],
  "unsloth/DeepSeek-R1-Distill-Qwen-32B-GGUF": ["DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf"],
  "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF": ["Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"],
  "unsloth/gemma-3-4b-it-GGUF": ["gemma-3-4b-it-Q4_K_M.gguf"],
  "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF": ["Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf"],
};

test("every llama download preset points at a GGUF repository", () => {
  const { MODEL_PRESETS } = loadCatalog();
  assert.ok(MODEL_PRESETS.length > 0);
  for (const preset of MODEL_PRESETS) {
    assert.match(preset.repo, /gguf/i, `${preset.repo} is not a GGUF repository`);
  }
});

test("each preset pre-selects a quant its repository was verified to contain", () => {
  const { MODEL_PRESETS, PRECISION_PRESETS } = loadCatalog();
  const precisions = new Map(Array.from(PRECISION_PRESETS, (item) => [item.value, item]));
  for (const preset of MODEL_PRESETS) {
    const precision = precisions.get(preset.precision);
    assert.ok(precision, `${preset.repo} has no known precision preset (${preset.precision})`);
    assert.ok(precision.quantFilter, `${preset.repo} must filter to one quant, not the whole repository`);
    const files = VERIFIED_QUANT_FILES[preset.repo];
    assert.ok(files, `${preset.repo} was not verified against the Hugging Face API`);
    assert.ok(
      files.some((file) => file.toLowerCase().includes(precision.quantFilter)),
      `${preset.repo} has no ${precision.label} file`,
    );
  }
  // Q4_K_M is the default everywhere a repository has it.
  const notQ4 = Array.from(MODEL_PRESETS.filter((preset) => preset.precision !== "q4_k_m"), (preset) => preset.repo);
  assert.deepEqual(notQ4, ["Qwen/Qwen3-0.6B-GGUF"]);
});

test("preset notes no longer ask for an authorization token", () => {
  const { MODEL_PRESETS } = loadCatalog();
  for (const preset of MODEL_PRESETS) {
    assert.doesNotMatch(preset.note, /授权|token/i, `${preset.repo}: ${preset.note}`);
  }
});

test("the launch form defaults to a GGUF repository", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const input = html.match(/<input id="startModel"[^>]*>/)?.[0] || "";
  assert.match(input, /value="Qwen\/Qwen3-0\.6B-GGUF"/);
});
