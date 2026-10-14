"use strict";

// llama-manager follows DOCKER_WSL_DISTRO like vllm-manager (docs/overhaul/
// 01-engines.md §13 and §28.4, ENG-9). The manager is loaded in a child
// process per environment; docker is a fake execFile, nothing is started.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llama-docker-wsl-"));
test.after(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));

const SERVER = path.join(__dirname, "..", "server.js");
const CORE = path.join(__dirname, "..", "..", "manager-core");

// Loads the manager with `extraEnv`, builds its DockerHost from the exported
// CONFIG with a fake execFile, runs one `docker logs`, and prints what the
// fake saw.
const SCRIPT = `
const manager = require(${JSON.stringify(SERVER)});
const core = require(${JSON.stringify(CORE)});
const calls = [];
const host = core.engines.createDockerHost({
  config: core.engines.createDockerHostConfig(process.env, null, { firstExisting: (list) => list.find(Boolean) || "" }),
  execFileCommand: (file, args, options, callback) => { calls.push({ file, args }); callback(null, "log line\\n", ""); },
});
host.logs("llama-local", { tail: 3 }).then(() => {
  const c = manager.CONFIG;
  console.log(JSON.stringify({
    wslDistro: c.dockerWslDistro, dockerExe: c.dockerExe, prefix: c.dockerArgsPrefix, runtime: c.dockerRuntimeName,
    startFile: c.dockerDaemonStartFile, startArgs: c.dockerDaemonStartArgs, calls,
  }));
  process.exit(0);
});
`;

function loadManager(extraEnv) {
  const env = { ...process.env, AI_REFERENCE_DATA_DIR: CONFIG_DIR };
  delete env.DOCKER_WSL_DISTRO;
  delete env.WSL_EXE;
  Object.assign(env, extraEnv);
  const out = childProcess.execFileSync(process.execPath, ["-e", SCRIPT], { env, encoding: "utf8", timeout: 60000, windowsHide: true });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

test("llama-manager honours DOCKER_WSL_DISTRO", () => {
  const loaded = loadManager({ DOCKER_WSL_DISTRO: "Ubuntu-Test", WSL_EXE: "wsl-test.exe" });
  assert.equal(loaded.wslDistro, "Ubuntu-Test");
  assert.equal(loaded.dockerExe, "wsl-test.exe");
  assert.deepEqual(loaded.prefix, ["-d", "Ubuntu-Test", "--exec", "docker"]);
  assert.equal(loaded.runtime, "WSL Ubuntu-Test");
  assert.equal(loaded.startFile, "wsl-test.exe");
  assert.deepEqual(loaded.startArgs, ["-d", "Ubuntu-Test", "--exec", "sleep", "infinity"]);
  assert.equal(loaded.calls.length, 1);
  assert.equal(loaded.calls[0].file, "wsl-test.exe");
  assert.deepEqual(loaded.calls[0].args.slice(0, 5), ["-d", "Ubuntu-Test", "--exec", "docker", "logs"]);
});

test("llama-manager without the env keeps Docker Desktop (no behaviour change)", () => {
  const loaded = loadManager({});
  assert.equal(loaded.wslDistro, "");
  assert.deepEqual(loaded.prefix, []);
  assert.equal(loaded.runtime, "Docker Desktop");
  assert.equal(loaded.startFile, "");
  assert.deepEqual(loaded.startArgs, []);
  assert.deepEqual(loaded.calls[0].args.slice(0, 1), ["logs"]);
});
