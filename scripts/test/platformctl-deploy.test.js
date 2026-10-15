"use strict";

// OPS-11b: `platform deploy`, `platform update`, the post-deploy restart wiring
// and scripts/update-platform.ps1 in a live runtime root (06 §9.3, §9.4).
// Everything runs against temp roots with a spy in place of PowerShell; the
// update script itself is only run in a fake root that has no git repository.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const UPDATE_SCRIPT = path.join(ROOT, "scripts", "update-platform.ps1");
const { run, COMMANDS, PLANNED } = require("../platformctl.js");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platformctl-deploy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sink() {
  const chunks = [];
  return { write(text) { chunks.push(String(text)); return true; }, text: () => chunks.join(""), isTTY: false };
}

function put(root, rel, content = "") {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function liveLayout(root) {
  fs.mkdirSync(path.join(root, "platform-repo.git"), { recursive: true });
  fs.mkdirSync(path.join(root, "worktrees", "main"), { recursive: true });
}

function worktreeLayout(root) {
  put(root, ".git", "gitdir: elsewhere\n");
  put(root, "scripts/deploy-worktree.ps1", "# fixture\n");
}

async function cli(argv, options = {}) {
  const stdout = sink();
  const stderr = sink();
  const spawned = [];
  const code = await run(argv, {
    env: { PLATFORM_LANG: "en-US", ...(options.env || {}) },
    stdout,
    stderr,
    stdin: Readable.from([]),
    stdinIsTTY: false,
    runPowerShell: async (args) => { spawned.push(args); return options.psExit ?? 0; },
    ...options.ctx,
  });
  return { code, out: stdout.text(), err: stderr.text(), spawned };
}

test("deploy and update are real commands now", () => {
  for (const name of ["deploy", "update"]) {
    assert.ok(COMMANDS[name], `${name} is implemented`);
    assert.ok(!PLANNED[name], `${name} left PLANNED`);
  }
});

test("deploy refuses in a live root, and in a directory that is not a git work tree", async (t) => {
  const live = tempRoot(t);
  liveLayout(live);
  put(live, "scripts/deploy-worktree.ps1", "# fixture\n");
  const refused = await cli(["deploy", "--yes"], { ctx: { aiRoot: live, sourceRoot: live } });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /live runtime root/);
  assert.deepEqual(refused.spawned, []);

  const plain = tempRoot(t);
  put(plain, "scripts/deploy-worktree.ps1", "# fixture\n");
  const noGit = await cli(["deploy"], { ctx: { aiRoot: plain, sourceRoot: plain } });
  assert.equal(noGit.code, 2);
  assert.deepEqual(noGit.spawned, []);

  const zh = await cli(["deploy", "--lang", "zh-CN"], { ctx: { aiRoot: live, sourceRoot: live } });
  assert.match(zh.err, /线上运行根目录/);
});

test("deploy maps its flags onto deploy-worktree.ps1", async (t) => {
  const tree = tempRoot(t);
  worktreeLayout(tree);
  const script = path.join(tree, "scripts", "deploy-worktree.ps1");
  const base = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];

  const plain = await cli(["deploy"], { ctx: { aiRoot: tree, sourceRoot: tree } });
  assert.equal(plain.code, 0);
  assert.deepEqual(plain.spawned, [[...base, "-Restart", "none"]]);

  const full = await cli(["deploy", "--restart", "changed", "--skip-tests", "--no-prune", "--allow-live-drift", "--yes", "--dry-run"], { ctx: { aiRoot: tree, sourceRoot: tree } });
  assert.deepEqual(full.spawned, [[...base, "-Restart", "changed", "-SkipTests", "-NoPrune", "-AllowLiveDrift", "-Confirm:$false", "-WhatIf"]]);

  // An explicit AI_ROOT elsewhere names the live root.
  const elsewhere = tempRoot(t);
  const targeted = await cli(["deploy", "--restart", "all"], { env: { AI_ROOT: elsewhere }, ctx: { aiRoot: tree, sourceRoot: tree } });
  assert.deepEqual(targeted.spawned, [[...base, "-Restart", "all", "-LiveRoot", elsewhere]]);

  const bad = await cli(["deploy", "--restart", "sometimes"], { ctx: { aiRoot: tree, sourceRoot: tree } });
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.spawned, []);

  const failed = await cli(["deploy"], { psExit: 7, ctx: { aiRoot: tree, sourceRoot: tree } });
  assert.equal(failed.code, 7, "the script's exit code is the command's");
});

test("update delegates to update-platform.ps1 -Delegate in a live root and refuses elsewhere", async (t) => {
  const live = tempRoot(t);
  liveLayout(live);
  const script = put(live, "scripts/update-platform.ps1", "# fixture\n");
  const done = await cli(["update"], { ctx: { aiRoot: live } });
  assert.equal(done.code, 0);
  assert.deepEqual(done.spawned, [["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Delegate"]]);

  const tree = tempRoot(t);
  worktreeLayout(tree);
  const refused = await cli(["update"], { ctx: { aiRoot: tree } });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /not a live runtime root/);
  assert.deepEqual(refused.spawned, []);
});

test("post-deploy --restart changed queues through the supervisor, and prints commands when there is none", async (t) => {
  const root = tempRoot(t);
  const stamp = "20261015-120000";
  const manifest = {
    schemaVersion: 1, deployedAt: "2026-10-15T12:00:00.000Z", sourceWorktree: "fixture", branch: "feature/x", commit: "b".repeat(40),
    liveRoot: root, archive: "x.zip", archiveSha256: "0".repeat(64), includeLocalExtensions: false, liveDrift: [],
    files: [{ path: "vllm-manager\\server.js", action: "updated", afterSha256: "0".repeat(64) }],
  };
  const file = put(root, `artifacts/worktree-deploy-backups/${stamp}/deployment-manifest.json`, JSON.stringify(manifest));
  const argv = ["post-deploy", "--manifest", file, "--restart", "changed", "--no-prune"];
  const npm = async () => ({ code: 0, stdout: "", stderr: "" });

  const calls = [];
  const control = {
    available: async () => true,
    request: async (method, route) => {
      calls.push(`${method} ${route}`);
      return { status: 202, json: { ok: true, queued: true, blockers: [{ kind: "requests", source: "entry", title: "stream" }] } };
    },
  };
  const queued = await cli(argv, { ctx: { aiRoot: root, controlClient: control, npm } });
  assert.equal(queued.code, 0, queued.err);
  assert.deepEqual(calls, ["POST /v1/components/vllm-manager/restart"]);
  assert.match(queued.out, /Queued, restarts when idle: vllm-manager/);
  assert.match(queued.out, /requests/);

  const down = { available: async () => false, request: async () => { throw Object.assign(new Error("no pipe"), { code: "supervisor_unavailable" }); } };
  const printed = await cli(argv, { ctx: { aiRoot: root, controlClient: down, npm } });
  assert.equal(printed.code, 0, "no supervisor is not a failure");
  assert.match(printed.out, /Run: platform restart vllm-manager --when-idle/);
});

function hasWindowsPowerShell() {
  if (process.platform !== "win32") return false;
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true, timeout: 60000 });
  return !probe.error && probe.status === 0;
}

function runUpdateScript(root, extra = []) {
  // Windows PowerShell 5.1 below a pwsh 7 session must not inherit pwsh's PSModulePath.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  const script = path.join(root, "scripts", "update-platform.ps1");
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...extra], { encoding: "utf8", env, windowsHide: true, timeout: 120000 });
}

test("update-platform.ps1 in a live root without -Delegate prints the bilingual message and exits 2", { timeout: 180000, skip: !hasWindowsPowerShell() && "needs Windows PowerShell" }, (t) => {
  const root = tempRoot(t);
  liveLayout(root);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(UPDATE_SCRIPT, path.join(root, "scripts", "update-platform.ps1"));
  const result = runUpdateScript(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /This is the live runtime root, not a Git checkout\. Run: platform update/);
  assert.match(result.stdout, /此目录是线上运行根目录，不是 Git 工作区。请运行：platform update/);
  assert.match(result.stdout, /-Delegate/, "the equivalent command is shown");
});

test("update-platform.ps1 in a plain non-git directory keeps today's error", { timeout: 180000, skip: !hasWindowsPowerShell() && "needs Windows PowerShell" }, (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(UPDATE_SCRIPT, path.join(root, "scripts", "update-platform.ps1"));
  const result = runUpdateScript(root);
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, 2);
  assert.match(result.stderr, /git rev-parse --is-inside-work-tree failed/);
});

test("update-platform.ps1 declares -Delegate and encodes its Chinese text as escapes", () => {
  const text = fs.readFileSync(UPDATE_SCRIPT, "utf8");
  assert.match(text, /\[switch\]\$Delegate/);
  assert.match(text, /merge', '--ff-only', '@\{u\}'/);
  assert.match(text, /deploy-worktree\.ps1/);
  assert.equal(/[^\x00-\x7f]/.test(text), false, "ASCII only, so Windows PowerShell 5.1 reads it correctly");
});
