"use strict";

// VLLM_MANAGER_STATE_DIR moves logs/ and data/ out of the package folder, so that
// several managers started by tests never share a ledger or the usage database.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MANAGER_DIR = path.resolve(__dirname, "..");

function readConfig(env) {
  const script = [
    "const { CONFIG } = require('./server.js');",
    "const keys = ['jobsLedger', 'serviceUsageDb', 'launchProfiles', 'serviceExposureSettings', 'runtimeApiKeys'];",
    "process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, CONFIG[key]]))));",
    "process.exit(0);",
  ].join(" ");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: MANAGER_DIR,
    env: { ...process.env, VLLM_MANAGER_STATE_DIR: "", ...env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("VLLM_MANAGER_STATE_DIR moves the ledgers and the usage database; unset keeps the package logs folder", () => {
  const state = path.join(os.tmpdir(), "manager-state-dir-test");
  const moved = readConfig({ VLLM_MANAGER_STATE_DIR: state });
  for (const value of Object.values(moved)) assert.ok(path.resolve(value).startsWith(path.resolve(state) + path.sep), value);
  assert.equal(moved.serviceUsageDb, path.join(path.resolve(state), "logs", "service-usage.sqlite"));

  const standard = readConfig({});
  for (const value of Object.values(standard)) assert.ok(path.resolve(value).startsWith(path.join(MANAGER_DIR, "logs") + path.sep), value);
});
