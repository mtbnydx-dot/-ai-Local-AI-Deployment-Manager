"use strict";

// The legacy launchers of 06 §6.6 (OPS-8) run against a fake platform.cmd that
// only records its arguments and a few environment variables, so no component
// starts. The real shims are copied into a temp tree, next to the fake.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const WINDOWS = process.platform === "win32";
const SKIP = !WINDOWS && "the launchers are Windows .cmd and .ps1 files";
const SHIM_FILES = [
  "start-platform.cmd", "stop-platform.cmd", "status-platform.cmd",
  "start-service-entry.cmd", "start-service-entry-lan.cmd", "stop-service-entry.cmd", "status-service-entry.cmd",
  "start-platform-mcp.cmd", "stop-platform-mcp.cmd", "status-platform-mcp.cmd",
  "start-search-gateway.cmd", "stop-search-gateway.cmd", "start-tts-platform.cmd",
  "vllm-manager/start-manager.cmd", "vllm-manager/stop-manager.cmd",
  "llama-manager/start-manager.cmd", "llama-manager/stop-manager.cmd",
  "scripts/start-platform-mcp.ps1", "scripts/stop-platform-mcp.ps1", "scripts/status-platform-mcp.ps1",
];
// Records "<arguments>|<AI_ROOT>|<NODE_EXE>|<PLATFORM_MCP_PORT>" per call.
const FAKE_PLATFORM = [
  "@echo off",
  ">>\"%SHIM_LOG%\" echo %*^|%AI_ROOT%^|%NODE_EXE%^|%PLATFORM_MCP_PORT%",
  "if defined FAKE_EXIT exit /b %FAKE_EXIT%",
  "exit /b 0",
  "",
].join("\r\n");

async function makeTree(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "legacy-shims-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (const file of SHIM_FILES) {
    await fsp.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fsp.copyFile(path.join(ROOT, ...file.split("/")), path.join(root, ...file.split("/")));
  }
  await fsp.writeFile(path.join(root, "platform.cmd"), FAKE_PLATFORM);
  return { root, log: path.join(root, "calls.log") };
}

function run(tree, command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, SHIM_LOG: tree.log, PLATFORM_NO_PAUSE: "1", ...env };
    for (const key of ["FAKE_EXIT", "SERVICE_ENTRY_NO_BROWSER", "AI_ROOT", "NODE_EXE", "PLATFORM_MCP_PORT"]) {
      if (!(key in env)) delete childEnv[key];
    }
    const child = spawn(command, args, { cwd: tree.root, env: childEnv, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} ${args.join(" ")} did not finish:\n${stdout}`)); }, 60_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
    child.stdin.end();
  });
}

function runCmd(tree, file, args = [], env) {
  return run(tree, "cmd.exe", ["/d", "/c", path.join(tree.root, ...file.split("/")), ...args], env);
}

/** The recorded calls, with runs of spaces folded. */
function calls(tree) {
  if (!fs.existsSync(tree.log)) return [];
  return fs.readFileSync(tree.log, "utf8").split(/\r?\n/).filter(Boolean).map((line) => line.replace(/ +/g, " ").trim());
}

const CASES = [
  ["start-platform.cmd", [], ["start --legacy-args|||"]],
  ["start-platform.cmd", ["all", "lan"], ["start all lan --legacy-args|||"]],
  ["stop-platform.cmd", ["all"], ["stop all --legacy-args|||"]],
  ["status-platform.cmd", [], ["status|||"]],
  ["status-service-entry.cmd", [], ["status entry vllm-manager llama-manager|||"]],
  ["start-platform-mcp.cmd", [], ["start platform-mcp|||"]],
  ["stop-platform-mcp.cmd", [], ["stop platform-mcp|||"]],
  ["status-platform-mcp.cmd", [], ["status platform-mcp|||"]],
  ["start-search-gateway.cmd", [], ["start search-gateway|||"]],
  ["stop-search-gateway.cmd", [], ["stop search-gateway|||"]],
  ["start-tts-platform.cmd", ["-NoBrowser"], ["start tts-gateway tts-workers|||"]],
  ["start-tts-platform.cmd", ["-GatewayOnly", "-NoBrowser"], ["start tts-gateway|||"]],
  ["vllm-manager/stop-manager.cmd", [], ["stop vllm-manager|||"]],
  ["llama-manager/stop-manager.cmd", [], ["stop llama-manager|||"]],
];

for (const [file, args, expected] of CASES) {
  test(`${file} ${args.join(" ")} hands over to platform.cmd`.trimEnd(), { skip: SKIP }, async (t) => {
    const tree = await makeTree(t);
    const result = await runCmd(tree, file, args);
    assert.equal(result.code, 0);
    assert.deepEqual(calls(tree), expected);
  });
}

test("the exit code of platform.cmd is the exit code of the launcher", { skip: SKIP }, async (t) => {
  for (const file of ["start-platform.cmd", "stop-platform.cmd", "status-platform.cmd", "start-service-entry.cmd", "stop-service-entry.cmd", "start-platform-mcp.cmd", "start-search-gateway.cmd", "start-tts-platform.cmd"]) {
    const tree = await makeTree(t);
    const result = await runCmd(tree, file, [], { FAKE_EXIT: "3" });
    assert.equal(result.code, 3, file);
  }
});

test("start-service-entry.cmd starts core, opens the paired browser, and honours lan and SERVICE_ENTRY_NO_BROWSER", { skip: SKIP }, async (t) => {
  const tree = await makeTree(t);
  await runCmd(tree, "start-service-entry.cmd");
  await runCmd(tree, "start-service-entry.cmd", ["lan"]);
  await runCmd(tree, "start-service-entry.cmd", [], { SERVICE_ENTRY_NO_BROWSER: "1" });
  await runCmd(tree, "start-service-entry-lan.cmd");
  await runCmd(tree, "start-service-entry-lan.cmd", [], { SERVICE_ENTRY_NO_BROWSER: "1" });
  assert.deepEqual(calls(tree), [
    "start core --open|||",
    "start core --lan --open|||",
    "start core --no-browser|||",
    "start core --lan --open|||",
    "start core --lan --no-browser|||",
  ]);
  for (const file of ["start-service-entry.cmd", "start-service-entry-lan.cmd"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), "utf8"), /0\.0\.0\.0|SERVICE_ENTRY_HOST/, `${file} must not inject a wildcard bind`);
  }
});

test("stop-service-entry.cmd stops the entry and both managers and says that model containers keep running", { skip: SKIP }, async (t) => {
  const tree = await makeTree(t);
  const result = await runCmd(tree, "stop-service-entry.cmd");
  assert.equal(result.code, 0);
  assert.deepEqual(calls(tree), ["stop entry vllm-manager llama-manager|||"]);
  assert.match(result.stdout, /Model containers are not stopped/);
});

test("the manager start shims start the manager, then open its page; a failed start opens nothing", { skip: SKIP }, async (t) => {
  for (const [dir, id, page] of [["vllm-manager", "vllm-manager", "vllm"], ["llama-manager", "llama-manager", "llama"]]) {
    const tree = await makeTree(t);
    assert.equal((await runCmd(tree, `${dir}/start-manager.cmd`)).code, 0);
    assert.deepEqual(calls(tree), [`start ${id}|||`, `open ${page}|||`]);
    const failing = await makeTree(t);
    assert.equal((await runCmd(failing, `${dir}/start-manager.cmd`, [], { FAKE_EXIT: "1" })).code, 1);
    assert.deepEqual(calls(failing), [`start ${id}|||`]);
  }
});

test("start-platform.cmd pauses only when double-clicked", { skip: SKIP }, async (t) => {
  const tree = await makeTree(t);
  const { PLATFORM_NO_PAUSE: _unused, ...rest } = process.env;
  // run() sets PLATFORM_NO_PAUSE; an empty value turns it off. The prompt is localised, so look for its dots.
  const paused = await runCmd(tree, "start-platform.cmd", [], { ...rest, PLATFORM_NO_PAUSE: "" });
  assert.match(paused.stdout, /. . . /);
  const quiet = await runCmd(tree, "start-platform.cmd");
  assert.doesNotMatch(quiet.stdout, /. . . /);
});

test("the platform-mcp .ps1 wrappers keep -AiRoot, -NodeExe and -Port and hand over to platform.cmd", { skip: SKIP }, async (t) => {
  const tree = await makeTree(t);
  const aiRoot = path.join(tree.root, "data-root");
  const ps = (file, args) => run(tree, "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(tree.root, "scripts", file), ...args]);
  assert.equal((await ps("start-platform-mcp.ps1", ["-AiRoot", aiRoot, "-NodeExe", "node-x", "-Port", "5999"])).code, 0);
  assert.equal((await ps("stop-platform-mcp.ps1", ["-AiRoot", aiRoot])).code, 0);
  assert.equal((await ps("status-platform-mcp.ps1", ["-AiRoot", aiRoot, "-Json"])).code, 0);
  assert.equal((await ps("status-platform-mcp.ps1", [])).code, 0);
  assert.deepEqual(calls(tree), [
    `start platform-mcp|${aiRoot}|node-x|5999`,
    `stop platform-mcp|${aiRoot}||`,
    `status platform-mcp --json|${aiRoot}||`,
    "status platform-mcp|||",
  ]);
});
