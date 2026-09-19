const test = require("node:test");
const assert = require("node:assert/strict");
const { inferStartupProgress } = require("../runtime-wait");

test("SGLang graph warnings and configuration are not graph-capture progress", () => {
  const warnings = "Breakable CUDA graph is incompatible with multimodal model; disabling prefill CUDA graph.\nserver_args={'cuda_graph': 'capture CUDA graph'}";
  assert.equal(inferStartupProgress(warnings, 1000, 3600000).stage, "等待模型加载");
  assert.equal(inferStartupProgress(warnings + "\nLoad weight begin. avail mem=90 GB", 2000, 3600000).stage, "加载权重");
  assert.equal(inferStartupProgress(warnings + "\nCapture target verify CUDA graph begin.", 3000, 3600000).stage, "捕获 CUDA graphs");
  assert.equal(inferStartupProgress("Capturing CUDA graphs: 20%", 3000, 3600000).stage, "捕获 CUDA graphs");
});
