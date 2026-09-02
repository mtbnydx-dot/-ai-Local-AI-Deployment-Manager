"use strict";
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createExitLogWriter, describeSignal, installProcessExitLogging } = require("../process-exit-log");

function fakeProcess() {
  const emitter = new EventEmitter();
  emitter.pid = 4242;
  emitter.version = "v22.0.0";
  emitter.argv = ["node", "server.js"];
  emitter.exits = [];
  emitter.exit = (code) => { emitter.exits.push(code); };
  return emitter;
}

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exit-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "logs", "process-exit.log");
}

test("writes start, signal and exit lines and runs the shutdown hook", async (t) => {
  const file = tempFile(t);
  const proc = fakeProcess();
  const seen = [];
  const install = installProcessExitLogging({
    process: proc,
    file,
    label: "test-manager",
    logger: { warn() {}, error() {} },
    onSignal: async (signal) => { seen.push(signal); },
  });
  proc.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 10));
  proc.emit("exit", 0);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.event), ["start", "signal", "exit"]);
  assert.equal(lines[1].signal, "SIGINT");
  assert.equal(lines[1].reason, describeSignal("SIGINT"));
  assert.equal(lines[1].pid, 4242);
  assert.deepEqual(seen, ["SIGINT"]);
  assert.deepEqual(proc.exits, [0]);
  install.uninstall();
  assert.equal(proc.listenerCount("SIGINT"), 0);
});

test("uncaught exceptions are recorded before exiting with code 1", (t) => {
  const file = tempFile(t);
  const proc = fakeProcess();
  installProcessExitLogging({ process: proc, file, label: "x", logger: { warn() {}, error() {} } });
  proc.emit("uncaughtException", new Error("boom"));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[1].event, "uncaught-exception");
  assert.match(lines[1].error, /boom/);
  assert.deepEqual(proc.exits, [1]);
});

test("the log file rotates once it exceeds maxBytes", (t) => {
  const file = tempFile(t);
  const writer = createExitLogWriter({ file, label: "rot", maxBytes: 200, keep: 2 });
  for (let index = 0; index < 20; index += 1) writer.write("tick", { index });
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(file).size < 400);
});
