"use strict";

// `platform autostart enable|disable|status` (06 §6.5, OPS-12) in-process with
// fake PowerShell and registry runners. Nothing is registered anywhere.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const { run, EXIT, COMMANDS, PLANNED } = require("../platformctl.js");

function sink() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join(""), isTTY: false };
}

function makeCli(t, { worktree = false, taskCode = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platformctl-autostart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (worktree) fs.writeFileSync(path.join(root, ".git"), "gitdir: ../elsewhere\n");
  const calls = [];
  const autostartOptions = {
    node: "C:\\fixture\\bin\\node.exe", user: "fixture-user", build: 26300,
    runPowerShell: async (script) => {
      calls.push(["ps", script]);
      if (/Get-ScheduledTaskInfo/.test(script)) return { code: 0, stdout: '{"registered":false}', stderr: "" };
      return { code: taskCode, stdout: /Unregister/.test(script) ? "removed" : "", stderr: taskCode ? "denied" : "" };
    },
    runReg: async (args) => { calls.push(["reg", args]); return { code: args[0] === "query" ? 1 : 0, stdout: "", stderr: "" }; },
  };
  return {
    root, calls,
    async cli(argv, lang = "en-US") {
      const stdout = sink();
      const stderr = sink();
      const code = await run(argv, {
        aiRoot: root, env: { PLATFORM_LANG: lang }, stdout, stderr, stdin: Readable.from([]), stdinIsTTY: false,
        acl: { secure: async () => {} }, listListeners: async () => [], fetch: async () => { throw new Error("offline"); },
        autostartOptions,
      });
      return { code, out: stdout.text(), err: stderr.text() };
    },
  };
}

test("autostart is a real command now, no longer planned", () => {
  assert.ok(COMMANDS.autostart);
  assert.ok(!PLANNED.autostart);
});

test("enable registers through the fake runner and reports the method; --json is one document", async (t) => {
  const world = makeCli(t);
  const result = await world.cli(["autostart", "enable", "--profile", "full"]);
  assert.equal(result.code, EXIT.OK, result.err);
  assert.match(result.out, /Start at logon is on \(task\)/);
  assert.ok(world.calls.some(([kind, value]) => kind === "ps" && /Register-ScheduledTask/.test(value)));
  const json = await world.cli(["autostart", "enable", "--json"]);
  assert.equal(JSON.parse(json.out).method, "task");
  assert.match(JSON.parse(json.out).command, /supervise --profile core --autostart$/);
  const zh = await world.cli(["autostart", "enable"], "zh-CN");
  assert.match(zh.out, /已开启登录自启动/);
});

test("enable on a worktree exits 5 with one next action and registers nothing; --allow-worktree overrides", async (t) => {
  const world = makeCli(t, { worktree: true });
  const refused = await world.cli(["autostart", "enable"]);
  assert.equal(refused.code, EXIT.PREFLIGHT);
  assert.match(refused.err, /--allow-worktree/);
  assert.equal(world.calls.length, 0);
  const allowed = await world.cli(["autostart", "enable", "--allow-worktree"]);
  assert.equal(allowed.code, EXIT.OK, allowed.err);
});

test("a denied task falls back to the Run key and says so; bad usage exits 2", async (t) => {
  const world = makeCli(t, { taskCode: 1 });
  const result = await world.cli(["autostart", "enable"]);
  assert.equal(result.code, EXIT.OK, result.err);
  assert.match(result.out, /Run key is used instead/);
  assert.match(result.out, /\(run-key\)/);
  assert.equal((await world.cli(["autostart", "bogus"])).code, EXIT.USAGE);
  assert.equal((await world.cli(["autostart", "enable", "--profile", "everything"])).code, EXIT.USAGE);
});

test("disable and status read through the same runners", async (t) => {
  const world = makeCli(t);
  assert.match((await world.cli(["autostart", "disable"])).out, /Start at logon is off/);
  const status = await world.cli(["autostart", "status"]);
  assert.equal(status.code, EXIT.OK);
  assert.match(status.out, /Autostart: off/);
  assert.equal(JSON.parse((await world.cli(["autostart", "status", "--json"])).out).registered, false);
});
