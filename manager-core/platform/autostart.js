"use strict";

// Logon autostart (06 §6.5): the scheduled task LocalAIPlatform, with the HKCU
// Run value as the fallback when registration is denied. This module builds
// the command line, the PowerShell scripts and the Run-key arguments as plain
// text, and runs them through injected runners (runPowerShell, runReg). The
// tests only ever see fakes; nothing here registers anything by itself.
//
// Parameters travel in the environment of the PowerShell child, never inside
// the script text, so a path with quotes cannot change what the script does.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TASK_NAME = "LocalAIPlatform";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const LOGON_DELAY = "PT30S";
const HEADLESS_MIN_BUILD = 22000;
const PROFILES = Object.freeze(["core", "full", "none"]);
const POWERSHELL_ARGS = Object.freeze(["-NoProfile", "-NonInteractive", "-Command", "-"]);

function autostartError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** A worktree (or any git checkout) is not a deploy target: its `.git` is a file or a directory. */
function isWorktreeRoot(aiRoot, fsImpl = fs) {
  try { fsImpl.statSync(path.join(aiRoot, ".git")); return true; } catch { return false; }
}

function windowsBuild(release = os.release()) {
  const build = Number(String(release).split(".")[2]);
  return Number.isFinite(build) ? build : 0;
}

const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The supervise command for the task action and the Run value:
 * { exe, args, scriptPath, text }. Windows 11 hides the console with
 * `conhost.exe --headless`; Windows 10 starts a hidden PowerShell instead.
 */
function buildCommand({ aiRoot, node = process.execPath, profile = "core", build = windowsBuild() } = {}) {
  if (!PROFILES.includes(profile)) throw autostartError("bad_profile", `Unknown profile "${profile}".`);
  const scriptPath = path.win32.join(String(aiRoot), "scripts", "platformctl.js");
  const tail = ["supervise", "--profile", profile, "--autostart"];
  if (build >= HEADLESS_MIN_BUILD) {
    const args = ["--headless", quote(node), quote(scriptPath), ...tail].join(" ");
    return { exe: "conhost.exe", args, scriptPath, text: `conhost.exe ${args}`, headless: true };
  }
  const args = `-WindowStyle Hidden -Command & ${psQuote(node)} ${psQuote(scriptPath)} ${tail.join(" ")}`;
  return { exe: "powershell.exe", args, scriptPath, text: `powershell.exe ${args}`, headless: false };
}

/** The environment the PowerShell scripts read; no value is spliced into the script text. */
function buildTaskEnv(command, { user = os.userInfo().username, taskName = TASK_NAME } = {}) {
  return { LAP_TASK_NAME: taskName, LAP_USER: String(user), LAP_EXE: command.exe, LAP_ARGS: command.args, LAP_DELAY: LOGON_DELAY };
}

/** Register-ScheduledTask for the logon task: delayed logon trigger, limited interactive principal, restart settings. */
function buildRegisterScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:LAP_USER",
    "$trigger.Delay = $env:LAP_DELAY",
    "$action = New-ScheduledTaskAction -Execute $env:LAP_EXE -Argument $env:LAP_ARGS",
    "$principal = New-ScheduledTaskPrincipal -UserId $env:LAP_USER -LogonType Interactive -RunLevel Limited",
    "$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries",
    "Register-ScheduledTask -TaskName $env:LAP_TASK_NAME -Trigger $trigger -Action $action -Principal $principal -Settings $settings -Force | Out-Null",
    "",
  ].join("\r\n");
}

function buildUnregisterScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$task = Get-ScheduledTask -TaskName $env:LAP_TASK_NAME -ErrorAction SilentlyContinue",
    "if ($task) { Unregister-ScheduledTask -TaskName $env:LAP_TASK_NAME -Confirm:$false; Write-Output 'removed' } else { Write-Output 'absent' }",
    "",
  ].join("\r\n");
}

function buildStatusScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$task = Get-ScheduledTask -TaskName $env:LAP_TASK_NAME -ErrorAction SilentlyContinue",
    "if (-not $task) { Write-Output '{\"registered\":false}'; exit 0 }",
    "$info = Get-ScheduledTaskInfo -TaskName $env:LAP_TASK_NAME",
    "$action = $task.Actions | Select-Object -First 1",
    "$result = [ordered]@{ registered = $true; execute = [string]$action.Execute; arguments = [string]$action.Arguments; lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }; lastTaskResult = $info.LastTaskResult }",
    "$result | ConvertTo-Json -Compress",
    "",
  ].join("\r\n");
}

/** `reg add` arguments for the Run value; the value is one string, the same command line as the task. */
function buildRunKeyAdd(command, { taskName = TASK_NAME } = {}) {
  return ["add", RUN_KEY, "/v", taskName, "/t", "REG_SZ", "/d", command.text, "/f"];
}
const buildRunKeyDelete = ({ taskName = TASK_NAME } = {}) => ["delete", RUN_KEY, "/v", taskName, "/f"];
const buildRunKeyQuery = ({ taskName = TASK_NAME } = {}) => ["query", RUN_KEY, "/v", taskName];

// ---------------------------------------------------------------------------
// Default runners (the only code here that touches the machine)

function runProcess(file, args, { input, env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, env: { ...process.env, ...(env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || String(error.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}
const defaultRunPowerShell = (script, env) => runProcess("powershell.exe", [...POWERSHELL_ARGS], { input: script, env });
const defaultRunReg = (args) => runProcess("reg.exe", args);

function runners(options) {
  return { runPowerShell: options.runPowerShell || defaultRunPowerShell, runReg: options.runReg || defaultRunReg };
}

function parseJson(text) {
  try { return JSON.parse(String(text).trim().split(/\r?\n/).filter(Boolean).pop() || "null"); } catch { return null; }
}

/** The script path inside a stored command line (task arguments or Run value). */
function scriptPathOf(text) {
  const match = /([A-Za-z]:[\\/][^"']*?platformctl\.js)/i.exec(String(text || ""));
  return match ? match[1] : null;
}
const samePath = (left, right) => Boolean(left && right) && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

// ---------------------------------------------------------------------------
// enable / disable / status

/**
 * enable({ aiRoot, profile, allowWorktree, node, user, build, runPowerShell, runReg })
 * -> { ok, method: "task" | "run-key", command, taskName, fallbackReason? }.
 * Refuses a worktree root (code worktree_root) unless allowWorktree.
 */
async function enable(options = {}) {
  if (!options.aiRoot) throw autostartError("ai_root_required", "aiRoot is required.");
  const aiRoot = path.resolve(String(options.aiRoot));
  if (!options.allowWorktree && isWorktreeRoot(aiRoot, options.fs)) {
    throw autostartError("worktree_root", "This AI_ROOT is a git worktree; autostart must point at the live root. Pass --allow-worktree to override.");
  }
  const command = buildCommand({ aiRoot, node: options.node, profile: options.profile || "core", build: options.build });
  const { runPowerShell, runReg } = runners(options);
  const registered = await runPowerShell(buildRegisterScript(), buildTaskEnv(command, { user: options.user }));
  if (registered.code === 0) {
    // A leftover Run value would start a second supervisor (harmless, the pipe is single-instance), so it is removed.
    await Promise.resolve(runReg(buildRunKeyDelete())).catch(() => {});
    return { ok: true, method: "task", command: command.text, taskName: TASK_NAME };
  }
  const fallbackReason = String(registered.stderr || registered.stdout || `exit ${registered.code}`).trim().split(/\r?\n/)[0].slice(0, 200);
  const added = await runReg(buildRunKeyAdd(command));
  if (added.code !== 0) {
    throw autostartError("autostart_failed", "Neither the scheduled task nor the Run key could be written.", { taskError: fallbackReason, runKeyError: String(added.stderr || "").trim().slice(0, 200) });
  }
  return { ok: true, method: "run-key", command: command.text, taskName: TASK_NAME, fallbackReason };
}

/** disable({ runPowerShell, runReg }) -> { ok, removed: ["task"?, "run-key"?] }. Removes both. */
async function disable(options = {}) {
  const { runPowerShell, runReg } = runners(options);
  const removed = [];
  const task = await runPowerShell(buildUnregisterScript(), { LAP_TASK_NAME: TASK_NAME });
  if (task.code === 0 && /removed/.test(task.stdout)) removed.push("task");
  const key = await runReg(buildRunKeyDelete());
  if (key.code === 0) removed.push("run-key");
  if (task.code !== 0) {
    throw autostartError("autostart_failed", "The scheduled task could not be removed.", { taskError: String(task.stderr || "").trim().slice(0, 200), removed });
  }
  return { ok: true, removed };
}

/**
 * status({ aiRoot, runPowerShell, runReg })
 * -> { registered, method, action, matchesRoot, lastRunAt, lastResult }.
 */
async function status(options = {}) {
  const aiRoot = options.aiRoot ? path.resolve(String(options.aiRoot)) : null;
  const expected = aiRoot ? path.win32.join(aiRoot, "scripts", "platformctl.js") : null;
  const { runPowerShell, runReg } = runners(options);
  const task = await runPowerShell(buildStatusScript(), { LAP_TASK_NAME: TASK_NAME });
  const info = task.code === 0 ? parseJson(task.stdout) : null;
  if (info?.registered) {
    const action = scriptPathOf(`${info.arguments || ""} ${info.execute || ""}`);
    return {
      registered: true, method: "task", action, matchesRoot: expected ? samePath(action, expected) : null,
      lastRunAt: info.lastRunTime || null, lastResult: info.lastTaskResult ?? null,
    };
  }
  const key = await runReg(buildRunKeyQuery());
  if (key.code === 0 && /REG_SZ/i.test(key.stdout)) {
    const action = scriptPathOf(key.stdout);
    return { registered: true, method: "run-key", action, matchesRoot: expected ? samePath(action, expected) : null, lastRunAt: null, lastResult: null };
  }
  return { registered: false, method: null, action: null, matchesRoot: null, lastRunAt: null, lastResult: null };
}

module.exports = {
  TASK_NAME, RUN_KEY, LOGON_DELAY, PROFILES,
  isWorktreeRoot, windowsBuild, buildCommand, buildTaskEnv,
  buildRegisterScript, buildUnregisterScript, buildStatusScript,
  buildRunKeyAdd, buildRunKeyDelete, buildRunKeyQuery,
  enable, disable, status,
};
