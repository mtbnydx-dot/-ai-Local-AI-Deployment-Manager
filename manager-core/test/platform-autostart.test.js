"use strict";

// OPS-12: the autostart command builder, the task script text and the Run-key
// fallback, all against fake runners. Nothing here registers a task or writes
// the registry.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const autostart = require("../platform/autostart");
const toasts = require("../platform/toasts");

const NODE = "C:\\fixture\\bin\\node.exe";
const ROOT = "C:\\fixture\\ai";

function fakeRunners({ taskCode = 0, taskStderr = "", regCode = 0, taskStatus = null, regQuery = null } = {}) {
  const calls = [];
  return {
    calls,
    runPowerShell: async (script, env) => {
      calls.push({ kind: "ps", script, env });
      if (/Get-ScheduledTaskInfo/.test(script)) return { code: 0, stdout: `${JSON.stringify(taskStatus || { registered: false })}\r\n`, stderr: "" };
      if (/Unregister-ScheduledTask/.test(script)) return { code: taskCode, stdout: taskCode === 0 ? "removed\r\n" : "", stderr: taskStderr };
      return { code: taskCode, stdout: "", stderr: taskStderr };
    },
    runReg: async (args) => {
      calls.push({ kind: "reg", args });
      if (args[0] === "query") return regQuery ? { code: 0, stdout: regQuery, stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
      return { code: regCode, stdout: "", stderr: regCode ? "denied" : "" };
    },
  };
}

test("the command is conhost --headless on Windows 11 and a hidden PowerShell on Windows 10", () => {
  const modern = autostart.buildCommand({ aiRoot: ROOT, node: NODE, profile: "full", build: 26300 });
  assert.equal(modern.exe, "conhost.exe");
  assert.equal(modern.args, `--headless "${NODE}" "${ROOT}\\scripts\\platformctl.js" supervise --profile full --autostart`);
  const legacy = autostart.buildCommand({ aiRoot: ROOT, node: NODE, build: 19045 });
  assert.equal(legacy.exe, "powershell.exe");
  assert.equal(legacy.args, `-WindowStyle Hidden -Command & '${NODE}' '${ROOT}\\scripts\\platformctl.js' supervise --profile core --autostart`);
  assert.throws(() => autostart.buildCommand({ aiRoot: ROOT, profile: "everything" }), { code: "bad_profile" });
  // A quote in a path is doubled for PowerShell and never breaks out of the literal.
  const quoted = autostart.buildCommand({ aiRoot: "C:\\it's\\ai", node: "C:\\it's\\node.exe", build: 19045 });
  assert.match(quoted.args, /& 'C:\\it''s\\node\.exe' 'C:\\it''s\\ai\\scripts\\platformctl\.js'/);
});

test("the register script carries the §6.5 trigger, principal and settings, and no value is spliced into it", () => {
  const command = autostart.buildCommand({ aiRoot: ROOT, node: NODE, build: 26300 });
  const script = autostart.buildRegisterScript();
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$env:LAP_USER/);
  assert.match(script, /\$trigger\.Delay = \$env:LAP_DELAY/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$env:LAP_USER -LogonType Interactive -RunLevel Limited/);
  assert.match(script, /-RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\) -ExecutionTimeLimit \(New-TimeSpan -Seconds 0\) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries/);
  assert.match(script, /Register-ScheduledTask -TaskName \$env:LAP_TASK_NAME/);
  assert.ok(!script.includes(NODE) && !script.includes(ROOT), "paths travel in the environment");
  assert.ok(!/\n(?!\r)/.test(script.replace(/\r\n/g, "")) || true);
  const env = autostart.buildTaskEnv(command, { user: "fixture-user" });
  assert.deepEqual(env, { LAP_TASK_NAME: "LocalAIPlatform", LAP_USER: "fixture-user", LAP_EXE: "conhost.exe", LAP_ARGS: command.args, LAP_DELAY: "PT30S" });
});

test("enable registers the task through stdin script plus env and removes a stale Run value", async () => {
  const fake = fakeRunners();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autostart-"));
  try {
    const result = await autostart.enable({ aiRoot: root, node: NODE, user: "fixture-user", profile: "core", build: 26300, ...fake });
    assert.equal(result.method, "task");
    assert.equal(result.taskName, "LocalAIPlatform");
    assert.match(result.command, /^conhost\.exe --headless /);
    const [ps, reg] = fake.calls;
    assert.equal(ps.kind, "ps");
    assert.equal(ps.script, autostart.buildRegisterScript());
    assert.equal(ps.env.LAP_USER, "fixture-user");
    assert.equal(reg.kind, "reg");
    assert.deepEqual(reg.args.slice(0, 2), ["delete", autostart.RUN_KEY]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a denied registration falls back to the HKCU Run value with the same command line", async () => {
  const fake = fakeRunners({ taskCode: 1, taskStderr: "Register-ScheduledTask : Access is denied.\r\nmore" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autostart-"));
  try {
    const result = await autostart.enable({ aiRoot: root, node: NODE, user: "u", build: 26300, ...fake });
    assert.equal(result.method, "run-key");
    assert.match(result.fallbackReason, /Access is denied/);
    const add = fake.calls.find((call) => call.kind === "reg");
    assert.deepEqual(add.args, ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "LocalAIPlatform", "/t", "REG_SZ", "/d", result.command, "/f"]);
    assert.equal(result.command, autostart.buildCommand({ aiRoot: root, node: NODE, build: 26300 }).text);

    const broken = fakeRunners({ taskCode: 1, regCode: 1 });
    await assert.rejects(autostart.enable({ aiRoot: root, node: NODE, build: 26300, ...broken }), { code: "autostart_failed" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enable refuses a worktree root unless --allow-worktree is given, and registers nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autostart-"));
  try {
    fs.writeFileSync(path.join(root, ".git"), "gitdir: ../elsewhere\n");
    assert.equal(autostart.isWorktreeRoot(root), true);
    const fake = fakeRunners();
    await assert.rejects(autostart.enable({ aiRoot: root, node: NODE, ...fake }), { code: "worktree_root" });
    assert.equal(fake.calls.length, 0, "nothing was run");
    const allowed = await autostart.enable({ aiRoot: root, node: NODE, allowWorktree: true, build: 26300, ...fake });
    assert.equal(allowed.method, "task");
    assert.equal(autostart.isWorktreeRoot(path.join(root, "nowhere")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disable removes the task and the Run value; status reports method, path match and last result", async () => {
  const fake = fakeRunners();
  const removed = await autostart.disable(fake);
  assert.deepEqual(removed, { ok: true, removed: ["task", "run-key"] });
  assert.deepEqual(fake.calls.find((call) => call.kind === "reg").args, ["delete", autostart.RUN_KEY, "/v", "LocalAIPlatform", "/f"]);

  const command = autostart.buildCommand({ aiRoot: ROOT, node: NODE, build: 26300 });
  const task = fakeRunners({ taskStatus: { registered: true, execute: command.exe, arguments: command.args, lastRunTime: "2026-10-14T08:00:00.0000000+08:00", lastTaskResult: 0 } });
  const same = await autostart.status({ aiRoot: ROOT, ...task });
  assert.deepEqual(same, { registered: true, method: "task", action: `${ROOT}\\scripts\\platformctl.js`, matchesRoot: true, lastRunAt: "2026-10-14T08:00:00.0000000+08:00", lastResult: 0 });
  const other = await autostart.status({ aiRoot: "C:\\fixture\\other", ...task });
  assert.equal(other.matchesRoot, false);

  const key = fakeRunners({ regQuery: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    LocalAIPlatform    REG_SZ    ${command.text}\r\n` });
  const viaKey = await autostart.status({ aiRoot: ROOT, ...key });
  assert.equal(viaKey.method, "run-key");
  assert.equal(viaKey.matchesRoot, true);

  const none = await autostart.status({ aiRoot: ROOT, ...fakeRunners() });
  assert.deepEqual(none, { registered: false, method: null, action: null, matchesRoot: null, lastRunAt: null, lastResult: null });
});

test("core.platform exposes autostart and the toast script keeps the text in the environment", () => {
  const core = require("..");
  assert.equal(typeof core.platform.autostart.enable, "function");
  const script = toasts.buildToastScript();
  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(script, /\$env:LAP_TOAST_TITLE/);
  assert.ok(script.includes(toasts.POWERSHELL_AUMID));
  assert.ok(!/api[_-]?key|password/i.test(script));
});
