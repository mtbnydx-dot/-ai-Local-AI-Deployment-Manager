"use strict";

// scripts/check-syntax.js replaces test-all's hand-kept syntax lists. These
// tests pin its discovery (git or manifest walk, skips, ES module detection),
// prove that an ES-module .js with a syntax error fails although
// `node --check` lets it through on Node 24 (06 V13), and prove that every
// file the old lists named is still found.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXIT_INTERPRETER_MISSING,
  classifyJsFile,
  createPackageTypeLookup,
  findPython,
  globToRegExp,
  hasTopLevelModuleSyntax,
  listSyntaxFiles,
  repositoryFiles,
} = require("../check-syntax.js");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-syntax.js");

// The files test-all.cmd named one by one before discovery (OPS-2).
const PREVIOUSLY_LISTED = {
  js: [
    "vllm-manager/server.js",
    "llama-manager/server.js",
    "service-entry/server.js",
    "search-gateway/server.js",
    "tests/frontend-smoke.spec.cjs",
    "tests/connection-status.spec.cjs",
    "tts-platform/gateway/static/app.js",
    "platform-mcp/scripts/validate-live.mjs",
    "scripts/sqlite-snapshot.js",
    "scripts/verify-backup.js",
    "tests/billing-page.spec.cjs",
    "scripts/check-i18n.js",
    "manager-core/model-storage.js",
    "manager-core/model-migration.js",
    "manager-core/model-storage-routes.js",
    "shared-public/js/model-storage-page.js",
    "tests/model-storage.spec.cjs",
  ],
  ps1: [
    "build-github-release.ps1",
    "scripts/install-download-cli.ps1",
    "scripts/check-powershell-syntax.ps1",
    "scripts/new-worktree.ps1",
    "scripts/remove-worktree.ps1",
    "scripts/deploy-worktree.ps1",
    "scripts/start-platform-mcp.ps1",
    "scripts/stop-platform-mcp.ps1",
    "scripts/status-platform-mcp.ps1",
    "scripts/update-platform.ps1",
    "scripts/setup-public.ps1",
    "scripts/backup-platform.ps1",
    "scripts/nightly-e2e.ps1",
    "tts-platform/scripts/runtime-root.ps1",
    "tts-platform/scripts/install_gateway.ps1",
    "tts-platform/scripts/start_all.ps1",
    "tts-platform/scripts/start_gateway.ps1",
    "tts-platform/scripts/stop_gateway.ps1",
    "tts-platform/scripts/stop_workers.ps1",
    "tts-platform/scripts/start_chatterbox.ps1",
    "tts-platform/scripts/start_qwen.ps1",
    "tts-platform/scripts/start_fish.ps1",
    "tts-platform/scripts/start_step_docker.ps1",
    "tts-platform/scripts/start_voxcpm.ps1",
    "tts-platform/scripts/start_qwen_design.ps1",
    "tts-platform/scripts/install_model.ps1",
    "tts-platform/scripts/status.ps1",
  ],
  py: [
    "tts-platform/gateway/main.py",
    "tts-platform/gateway/tts_config.py",
    "tts-platform/gateway/tts_schemas.py",
    "tts-platform/gateway/tts_storage.py",
    "tts-platform/gateway/tts_services.py",
    "tts-platform/gateway/tts_jobs.py",
    "tts-platform/gateway/tts_identity.py",
    "tts-platform/gateway/tts_receipts.py",
    "tts-platform/gateway/tts_catalog.py",
    "tts-platform/gateway/tts_lifecycle.py",
    "tts-platform/workers/chatterbox_worker.py",
    "tts-platform/workers/qwen_worker.py",
    "tts-platform/workers/step_server.py",
    "tts-platform/workers/voxcpm_worker.py",
    "tts-platform/workers/qwen_design_worker.py",
  ],
};

async function makeRoot(t, prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, ...relativePath.split("/"));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
}

function runCheck(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

// Windows PowerShell 5.1 below pwsh 7 cannot load its modules with pwsh's PSModulePath.
function hasWindowsPowerShell() {
  if (process.platform !== "win32") return false;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { env, windowsHide: true, timeout: 60000 });
  return !probe.error && probe.status === 0;
}

function hasGit() {
  const probe = spawnSync("git", ["--version"], { windowsHide: true });
  return !probe.error && probe.status === 0;
}

const BAD_ESM = 'import fs from "node:fs";\n\nexport function read(file) {\n  return fs.readFileSync(file, "utf8")\n}\nexport const broken = ;\n';

test("an ES-module .js with a syntax error fails, although node --check passes it on Node 24 (V13)", async (t) => {
  const root = await makeRoot(t, "check-syntax-esm-");
  await writeFile(root, "pkg/bad-esm.js", BAD_ESM);
  await writeFile(root, "pkg/good-esm.js", 'import fs from "node:fs";\nexport const exists = (file) => fs.existsSync(file);\n');
  await writeFile(root, "pkg/good.cjs", '"use strict";\nmodule.exports = { ok: true };\n');
  await writeFile(root, "pkg/plain.js", '"use strict";\nconst value = import("node:fs");\nmodule.exports = { value };\n');

  const plainCheck = spawnSync(process.execPath, ["--check", path.join(root, "pkg", "bad-esm.js")], { windowsHide: true });
  t.diagnostic(`node --check on the bad ES module exits ${plainCheck.status} on ${process.version}`);

  const { code, output } = runCheck(["--lang", "js", "--root", root]);
  assert.equal(code, 1, output);
  assert.match(output, /FAILED pkg\/bad-esm\.js \(ES module: top-level import or export\)/);
  assert.match(output, /pkg\/bad-esm\.js:6/, "the error names the file instead of [stdin]");
  assert.doesNotMatch(output, /FAILED pkg\/(good-esm|good|plain)/);
  assert.match(output, /Syntax check \(js\): 4 JavaScript file\(s\) checked \(2 as ES modules, 2 as CommonJS\) from directory walk; 1 failed\./);

  await fsp.rm(path.join(root, "pkg", "bad-esm.js"));
  const clean = runCheck(["--lang", "js", "--root", root]);
  assert.equal(clean.code, 0, clean.output);
  assert.match(clean.output, /3 JavaScript file\(s\) checked .*; 0 failed\./);
});

test("a CommonJS syntax error fails", async (t) => {
  const root = await makeRoot(t, "check-syntax-cjs-");
  await writeFile(root, "lib/broken.js", '"use strict";\nconst value = ;\nmodule.exports = value;\n');
  await writeFile(root, "lib/broken.cjs", "module.exports = {\n");
  const { code, output } = runCheck(["--lang", "js", "--root", root]);
  assert.equal(code, 1, output);
  assert.match(output, /FAILED lib\/broken\.cjs \(CommonJS\)/);
  assert.match(output, /FAILED lib\/broken\.js \(CommonJS\)/);
  assert.match(output, /2 JavaScript file\(s\) checked .*; 2 failed\./);
});

test("module syntax detection looks for static import and export statements only", () => {
  for (const source of [
    'import fs from "node:fs";',
    'import "./side-effect.js";',
    "import { a,\n  b } from './x.js';",
    "import * as path from 'node:path';",
    "import def, { named } from './x.js';",
    "import {\n  a,\n} from './x.js';",
    "export default {};",
    "export const a = 1;",
    "export { a };",
    "export * from './x.js';",
    "export async function run() {}",
    "export function* walk() {}",
    "export class Thing {}",
    "// header\nexport let ready = false;",
  ]) {
    assert.equal(hasTopLevelModuleSyntax(source), true, source);
  }
  for (const source of [
    'const fs = require("node:fs");',
    'const loaded = import("node:fs");',
    "if (import.meta) {}",
    "  import fs from 'node:fs';",
    "import os\nimport sys",
    "import base64, json, pathlib",
    "export = {",
    "const exported = { important: true };",
    "module.exports = { exportAll: true };",
  ]) {
    assert.equal(hasTopLevelModuleSyntax(source), false, source);
  }
});

test("JavaScript files are classified by extension, package type, esmGlobs and content", async (t) => {
  const root = await makeRoot(t, "check-syntax-classify-");
  await writeFile(root, "esm-pkg/package.json", JSON.stringify({ name: "esm-pkg", type: "module" }));
  await writeFile(root, "esm-pkg/nested/deeper/index.js", "const a = 1;\n");
  await writeFile(root, "cjs-pkg/package.json", "\uFEFF" + JSON.stringify({ name: "cjs-pkg" }));
  await writeFile(root, "cjs-pkg/index.js", "const a = 1;\n");
  const packageTypeOf = createPackageTypeLookup(root);
  const esmGlobs = ["console/**/*.js"].map(globToRegExp);
  const classify = (file, source = "const a = 1;\n") => classifyJsFile(file, source, { esmGlobs, packageTypeOf });

  assert.deepEqual(classify("esm-pkg/legacy.cjs"), { mode: "cjs", reason: ".cjs" });
  assert.deepEqual(classify("cjs-pkg/tool.mjs"), { mode: "esm", reason: ".mjs" });
  assert.deepEqual(classify("esm-pkg/nested/deeper/index.js"), { mode: "esm", reason: "package.json type module" });
  assert.deepEqual(classify("cjs-pkg/index.js"), { mode: "cjs", reason: "default" });
  assert.deepEqual(classify("console/routes/home.js"), { mode: "esm", reason: "syntaxCheck.esmGlobs" });
  assert.deepEqual(classify("lib/app.js", "export const a = 1;\n"), { mode: "esm", reason: "top-level import or export" });
  assert.deepEqual(classify("app.js"), { mode: "cjs", reason: "default" });
});

test("the directory walk follows the manifest and skips node_modules, dist, skipGlobs and runtime data", async (t) => {
  const root = await makeRoot(t, "check-syntax-walk-");
  const manifest = {
    schemaVersion: 1,
    directories: ["pkg", "deploy/public"],
    files: ["root.cjs", "missing.cjs"],
    runtimeDataDirectories: ["pkg/data"],
    robocopy: { excludeDirs: ["node_modules", "logs", "*-cache"] },
    syntaxCheck: { esmGlobs: ["pkg/console/**/*.js"], skipGlobs: ["pkg/vendor/**", "**/*.min.js"] },
  };
  await writeFile(root, "release-manifest.json", JSON.stringify(manifest));
  for (const file of [
    "root.cjs", "outside.js", "outside/index.js",
    "pkg/a.js", "pkg/console/app.js", "pkg/sub/b.mjs", "pkg/lib.min.js", "pkg/README.md",
    "pkg/node_modules/dep/index.js", "pkg/dist/out.js", "pkg/vendor/lib.js", "pkg/logs/trace.js",
    "pkg/data/state.js", "pkg/build-cache/x.js", "pkg/script.ps1", "deploy/public/start.ps1",
    "pkg/tts.py",
  ]) {
    await writeFile(root, file, "const a = 1;\n");
  }

  const js = listSyntaxFiles("js", { root });
  assert.equal(js.source, "directory walk");
  assert.deepEqual(js.files, ["pkg/a.js", "pkg/console/app.js", "pkg/sub/b.mjs", "root.cjs"]);
  assert.deepEqual(listSyntaxFiles("ps1", { root }).files, ["deploy/public/start.ps1", "pkg/script.ps1"]);
  assert.deepEqual(listSyntaxFiles("py", { root }).files, [], "Python files are checked only under tts-platform");

  const listing = runCheck(["--lang", "js", "--root", root, "--list"]);
  assert.equal(listing.code, 0, listing.output);
  assert.equal(listing.output.trim(), ["cjs\tpkg/a.js", "esm\tpkg/console/app.js", "esm\tpkg/sub/b.mjs", "cjs\troot.cjs", "4 JavaScript file(s) (directory walk)."].join("\n"));

  // Without a manifest the whole root is walked, still without node_modules and dist.
  await fsp.rm(path.join(root, "release-manifest.json"));
  assert.deepEqual(listSyntaxFiles("js", { root }).files, [
    "outside.js", "outside/index.js", "pkg/a.js", "pkg/build-cache/x.js", "pkg/console/app.js", "pkg/data/state.js",
    "pkg/lib.min.js", "pkg/logs/trace.js", "pkg/sub/b.mjs", "pkg/vendor/lib.js", "root.cjs",
  ]);
});

test("at the top of a git work tree the files come from git", { skip: !hasGit() && "git is not available" }, async (t) => {
  const root = await makeRoot(t, "check-syntax-git-");
  const git = (...args) => spawnSync("git", ["-C", root, "-c", "core.autocrlf=false", ...args], { encoding: "utf8", windowsHide: true });
  await writeFile(root, ".gitignore", "ignored/\n");
  await writeFile(root, "tracked/a.js", "const a = 1;\n");
  await writeFile(root, "untracked/b.js", "const b = 1;\n");
  await writeFile(root, "ignored/c.js", "const c = 1;\n");
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", ".gitignore", "tracked/a.js").status, 0);
  await writeFile(root, "tracked/deleted.js", "const d = 1;\n");
  assert.equal(git("add", "tracked/deleted.js").status, 0);
  await fsp.rm(path.join(root, "tracked", "deleted.js"));

  const listed = listSyntaxFiles("js", { root });
  assert.equal(listed.source, "git");
  assert.deepEqual(listed.files, ["tracked/a.js", "untracked/b.js"], "tracked and untracked-but-not-ignored files that exist");

  // A folder inside the work tree (an extracted release, say) is walked instead.
  const nested = repositoryFiles(path.join(root, "ignored"));
  assert.equal(nested.source, "directory walk");
  assert.deepEqual(nested.files, ["c.js"]);
});

test("every file the old test-all lists checked is still discovered", (t) => {
  const { files: tracked, source } = repositoryFiles(ROOT);
  if (source !== "git") return t.skip("not the top of the source repository, so tracked files cannot be listed");
  for (const [language, expected] of Object.entries(PREVIOUSLY_LISTED)) {
    const discovered = new Set(listSyntaxFiles(language, { root: ROOT }).files);
    const missing = expected.filter((file) => tracked.includes(file) && !discovered.has(file));
    assert.deepEqual(missing, [], `check-syntax --lang ${language} no longer finds these files`);
    assert.ok(discovered.size >= expected.filter((file) => tracked.includes(file)).length);
  }
});

test("PowerShell files are parsed in one Windows PowerShell call", { skip: !hasWindowsPowerShell() && "needs Windows PowerShell" }, async (t) => {
  const root = await makeRoot(t, "check-syntax-ps1-");
  await writeFile(root, "scripts/good.ps1", "param([string]$Name = 'x')\r\nWrite-Output \"hello $Name\"\r\n");
  await writeFile(root, "scripts/bad.ps1", "function Broken {\r\n  if ($true) {\r\n    Write-Output 'open'\r\n}\r\n");
  const { code, output } = runCheck(["--lang", "ps1", "--root", root]);
  assert.equal(code, 1, output);
  assert.match(output, /bad\.ps1/);
  assert.match(output, /Syntax check \(ps1\): 2 PowerShell file\(s\) checked from directory walk; 1 failed\./);

  await fsp.rm(path.join(root, "scripts", "bad.ps1"));
  const clean = runCheck(["--lang", "ps1", "--root", root]);
  assert.equal(clean.code, 0, clean.output);
  assert.match(clean.output, /1 PowerShell file\(s\) checked from directory walk; 0 failed\./);
});

test("Python files under tts-platform are parsed in one Python process", async (t) => {
  const python = findPython();
  if (!python) return t.skip("Python 3 is not installed");
  const root = await makeRoot(t, "check-syntax-py-");
  await writeFile(root, "tts-platform/gateway/good.py", "def run():\n    return 1\n");
  await writeFile(root, "tts-platform/gateway/bom.py", "\uFEFF# -*- coding: utf-8 -*-\nVALUE = '语音'\n");
  await writeFile(root, "tts-platform/gateway/语音.py", "NAME = 'non-ASCII file name'\n");
  await writeFile(root, "tts-platform/workers/bad.py", "def broken(:\n    pass\n");
  await writeFile(root, "elsewhere/ignored.py", "def broken(:\n");
  const { code, output } = runCheck(["--lang", "py", "--root", root, "--python", python]);
  assert.equal(code, 1, output);
  assert.match(output, /FAILED tts-platform\/workers\/bad\.py:1:/);
  assert.doesNotMatch(output, /ignored\.py|bom\.py|语音\.py/);
  assert.match(output, /Syntax check \(py\): 4 Python file\(s\) checked from directory walk; 1 failed\./);
});

test("a missing interpreter exits 77 and bad arguments exit 2", async (t) => {
  const root = await makeRoot(t, "check-syntax-missing-");
  await writeFile(root, "tts-platform/gateway/main.py", "VALUE = 1\n");
  const missing = runCheck(["--lang", "py", "--root", root, "--python", path.join(root, "no-such-python.exe")]);
  assert.equal(missing.code, EXIT_INTERPRETER_MISSING, missing.output);
  assert.match(missing.output, /Syntax check \(py\) skipped: the Python interpreter is missing\./);

  assert.equal(runCheck(["--lang", "rb"]).code, 2);
  assert.equal(runCheck([]).code, 2);
  assert.equal(runCheck(["--lang", "js", "--root", path.join(root, "absent")]).code, 2);
  assert.ok(!fs.existsSync(path.join(root, "absent")));
});
