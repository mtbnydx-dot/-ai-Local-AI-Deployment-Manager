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
  return context.window.LlamaJobUtils;
}

test("llama job utils map statuses", () => {
  const utils = loadUtils();
  const failed = utils.jobStatusInfo("failed");
  assert.equal(failed.label, "失败");
  assert.equal(failed.pillClass, "fail");
  assert.equal(failed.rowClass, "is-failed");
  assert.equal(failed.detail, "任务失败，查看日志尾部或重试");
  assert.equal(utils.jobStatusInfo("paused").label, "已暂停");
  assert.equal(utils.jobStatusInfo("running").rowClass, "is-running");
});

test("llama job utils detect Docker daemon failures", () => {
  const utils = loadUtils();
  assert.equal(utils.isDockerDaemonIssue({
    progress: { detail: "DockerDesktopLinuxEngine did not respond" },
    logs: [],
  }), true);
  assert.equal(utils.isDockerDaemonIssue({
    error: "llama.cpp exited with code 1",
    progress: { issues: ["model load failed"] },
    logs: [],
  }), false);
});

test("llama job utils format durations", () => {
  const utils = loadUtils();
  assert.equal(utils.formatDuration(8.3), "8秒");
  assert.equal(utils.formatDuration(125), "2分5秒");
  assert.equal(utils.formatDuration(3725), "1小时2分");
});
