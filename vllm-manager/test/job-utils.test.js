const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUtils() {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "js", "job-utils.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "job-utils.js" });
  return context.window.VllmJobUtils;
}

test("vLLM job utils map statuses and job types", () => {
  const utils = loadUtils();
  const success = utils.jobStatusInfo("success");
  assert.equal(success.label, "完成");
  assert.equal(success.pillClass, "ok");
  assert.equal(success.rowClass, "is-success");
  assert.equal(success.detail, "任务已完成");
  assert.equal(utils.jobStatusInfo("queued").label, "等待");
  assert.equal(utils.jobStatusInfo("running").rowClass, "is-running");
  assert.equal(utils.jobTypeLabel("benchmark"), "模型测速");
  assert.equal(utils.jobTypeLabel("custom"), "custom");
});

test("vLLM job utils detect Docker daemon failures", () => {
  const utils = loadUtils();
  assert.equal(utils.isDockerDaemonIssue({
    error: "Cannot connect to the Docker daemon",
    progress: { issues: [] },
    logs: [],
  }), true);
  assert.equal(utils.isDockerDaemonIssue({
    error: "model config not found",
    progress: { detail: "bad model path" },
    logs: [],
  }), false);
});

test("vLLM job utils format durations", () => {
  const utils = loadUtils();
  assert.equal(utils.formatDuration(8.3), "8秒");
  assert.equal(utils.formatDuration(125), "2分5秒");
  assert.equal(utils.formatDuration(3725), "1小时2分");
});
