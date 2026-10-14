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
  pythonInvocation,
  repositoryFiles,
  resolveBatchFile,
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

function runCheck(args, { env } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** process.env with PATH (any spelling) replaced by one folder. */
function envWithPath(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = directory;
  return env;
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
  await writeFile(root, "lib/cli.js", '#!/usr/bin/env node\n"use strict";\nif (require.main !== module) return;\nmodule.exports = {};\n');
  const { code, output } = runCheck(["--lang", "js", "--root", root]);
  assert.equal(code, 1, output);
  assert.match(output, /FAILED lib\/broken\.cjs \(CommonJS\)/);
  assert.match(output, /FAILED lib\/broken\.js \(CommonJS\)/);
  assert.match(output, /lib\/broken\.js:2/, "the error names the file instead of [stdin]");
  assert.doesNotMatch(output, /FAILED lib\/cli\.js/, "a shebang and a top-level return stay valid CommonJS");
  assert.match(output, /3 JavaScript file\(s\) checked .*; 2 failed\./);
});

test("module syntax the detection misses fails as CommonJS instead of passing unchecked", async (t) => {
  const root = await makeRoot(t, "check-syntax-missed-esm-");
  // Indented, or after a comment on the same line: not a top-level statement
  // for the detection, and `node --check` exits 0 on both (module detection).
  await writeFile(root, "app/indented.js", "const a = 1;\n  export const b = ;\n");
  await writeFile(root, "app/after-comment.js", '/* entry */ import fs from "node:fs";\nfs.existsSync(".");\n');
  // Node does not detect module syntax below an explicit "type": "commonjs".
  await writeFile(root, "strict/package.json", JSON.stringify({ name: "strict", type: "commonjs" }));
  await writeFile(root, "strict/esm.js", "export const a = 1;\n");

  const { code, output } = runCheck(["--lang", "js", "--root", root]);
  assert.equal(code, 1, output);
  assert.match(output, /FAILED app\/indented\.js \(CommonJS\)\n[\s\S]*Unexpected token 'export'[\s\S]*Hint: if this is an ES module/);
  assert.match(output, /FAILED app\/after-comment\.js \(CommonJS\)\n[\s\S]*Cannot use import statement outside a module/);
  assert.match(output, /FAILED strict\/esm\.js \(CommonJS\)/);
  assert.match(output, /3 JavaScript file\(s\) checked \(0 as ES modules, 3 as CommonJS\) from directory walk; 3 failed\./);
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
  await writeFile(root, "strict-pkg/package.json", JSON.stringify({ name: "strict-pkg", type: "commonjs" }));
  await writeFile(root, "strict-pkg/console/app.js", "export const a = 1;\n");
  const packageTypeOf = createPackageTypeLookup(root);
  const esmGlobs = ["console/**/*.js", "strict-pkg/console/**/*.js"].map(globToRegExp);
  const classify = (file, source = "const a = 1;\n") => classifyJsFile(file, source, { esmGlobs, packageTypeOf });

  assert.equal(packageTypeOf("cjs-pkg/index.js"), "", "a package.json without type leaves module detection on");
  assert.equal(packageTypeOf("strict-pkg/lib/index.js"), "commonjs");
  assert.equal(packageTypeOf("esm-pkg/nested/deeper/index.js"), "module");
  assert.deepEqual(classify("esm-pkg/legacy.cjs"), { mode: "cjs", reason: ".cjs" });
  assert.deepEqual(classify("cjs-pkg/tool.mjs"), { mode: "esm", reason: ".mjs" });
  assert.deepEqual(classify("esm-pkg/nested/deeper/index.js"), { mode: "esm", reason: "package.json type module" });
  assert.deepEqual(classify("cjs-pkg/index.js"), { mode: "cjs", reason: "default" });
  assert.deepEqual(classify("cjs-pkg/index.js", "export const a = 1;\n"), { mode: "esm", reason: "top-level import or export" });
  assert.deepEqual(classify("strict-pkg/lib/index.js", "export const a = 1;\n"), { mode: "cjs", reason: "package.json type commonjs" });
  assert.deepEqual(classify("strict-pkg/console/app.js", "export const a = 1;\n"), { mode: "esm", reason: "syntaxCheck.esmGlobs" }, "esmGlobs name browser modules");
  assert.deepEqual(classify("console/routes/home.js"), { mode: "esm", reason: "syntaxCheck.esmGlobs" });
  assert.deepEqual(classify("lib/app.js", "export const a = 1;\n"), { mode: "esm", reason: "top-level import or export" });
  assert.deepEqual(classify("app.js"), { mode: "cjs", reason: "default" });
});

test("the directory walk follows the manifest and skips what the release drops, node_modules, dist and skipGlobs", async (t) => {
  const root = await makeRoot(t, "check-syntax-walk-");
  const manifest = {
    schemaVersion: 1,
    directories: ["pkg", "deploy/public"],
    files: ["root.cjs", "missing.cjs", "upnp-port-map.js"],
    runtimeDataDirectories: ["pkg/data"],
    robocopy: { excludeDirs: ["node_modules", "logs", "*-cache"], excludeFiles: ["manager-public-proxy.js", "upnp-port-map.js", "*.local.js"] },
    forceInclude: ["*/test/fixtures/**"],
    syntaxCheck: { esmGlobs: ["pkg/console/**/*.js"], skipGlobs: ["pkg/vendor/**", "**/*.min.js"] },
  };
  await writeFile(root, "release-manifest.json", JSON.stringify(manifest));
  for (const file of [
    "root.cjs", "upnp-port-map.js", "outside.js", "outside/index.js",
    "pkg/a.js", "pkg/console/app.js", "pkg/sub/b.mjs", "pkg/lib.min.js", "pkg/README.md",
    "pkg/node_modules/dep/index.js", "pkg/dist/out.js", "pkg/vendor/lib.js", "pkg/logs/trace.js",
    "pkg/data/state.js", "pkg/build-cache/x.js", "pkg/script.ps1", "deploy/public/start.ps1",
    "pkg/tts.py",
    // Machine-local files the release leaves out (robocopy /XF).
    "pkg/manager-public-proxy.js", "pkg/sub/upnp-port-map.js", "pkg/settings.local.js",
    // forceInclude keeps fixtures that the robocopy rules would drop.
    "pkg/test/fixtures/upnp-port-map.js", "pkg/test/fixtures/logs/entry.js", "pkg/test/logs/dropped.js",
  ]) {
    await writeFile(root, file, "const a = 1;\n");
  }

  const js = listSyntaxFiles("js", { root });
  assert.equal(js.source, "directory walk");
  assert.deepEqual(js.files, [
    "pkg/a.js", "pkg/console/app.js", "pkg/sub/b.mjs", "pkg/test/fixtures/logs/entry.js", "pkg/test/fixtures/upnp-port-map.js",
    "root.cjs", "upnp-port-map.js",
  ], "a root file the manifest lists is copied whatever its name");
  assert.deepEqual(listSyntaxFiles("ps1", { root }).files, ["deploy/public/start.ps1", "pkg/script.ps1"]);
  assert.deepEqual(listSyntaxFiles("py", { root }).files, [], "Python files are checked only under tts-platform");

  const listing = runCheck(["--lang", "js", "--root", root, "--list"]);
  assert.equal(listing.code, 0, listing.output);
  assert.equal(listing.output.trim(), [
    "cjs\tpkg/a.js", "esm\tpkg/console/app.js", "esm\tpkg/sub/b.mjs", "cjs\tpkg/test/fixtures/logs/entry.js",
    "cjs\tpkg/test/fixtures/upnp-port-map.js", "cjs\troot.cjs", "cjs\tupnp-port-map.js", "7 JavaScript file(s) (directory walk).",
  ].join("\n"));

  // Without a manifest the whole root is walked, still without node_modules and dist.
  await fsp.rm(path.join(root, "release-manifest.json"));
  assert.deepEqual(listSyntaxFiles("js", { root }).files, [
    "outside.js", "outside/index.js", "pkg/a.js", "pkg/build-cache/x.js", "pkg/console/app.js", "pkg/data/state.js",
    "pkg/lib.min.js", "pkg/logs/trace.js", "pkg/manager-public-proxy.js", "pkg/settings.local.js", "pkg/sub/b.mjs",
    "pkg/sub/upnp-port-map.js", "pkg/test/fixtures/logs/entry.js", "pkg/test/fixtures/upnp-port-map.js", "pkg/test/logs/dropped.js",
    "pkg/vendor/lib.js", "root.cjs", "upnp-port-map.js",
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

test("a .bat or .cmd Python, as pyenv-win puts on PATH, runs through cmd.exe", { skip: process.platform !== "win32" && "batch files are a Windows matter" }, async (t) => {
  const python = findPython();
  if (!python) return t.skip("Python 3 is not installed");
  const { command, args, windowsVerbatimArguments } = pythonInvocation(python);
  const probe = spawnSync(command, args, { input: "import sys\nprint(sys.executable)\n", encoding: "utf8", windowsHide: true, windowsVerbatimArguments });
  assert.equal(probe.status, 0, probe.stderr);
  const shims = await makeRoot(t, "check-syntax-pyshim-");
  const forward = `@echo off\r\n"${probe.stdout.trim()}" %*\r\n`;
  await writeFile(shims, "python.cmd", forward);
  await writeFile(shims, "py-shim.bat", forward);
  const root = await makeRoot(t, "check-syntax-pyshim-root-");
  await writeFile(root, "tts-platform/gateway/good.py", "VALUE = '语音'\n");
  await writeFile(root, "tts-platform/workers/bad.py", "def broken(:\n    pass\n");
  const expectChecked = ({ code, output }, how) => {
    assert.equal(code, 1, `${how}\n${output}`);
    assert.match(output, /FAILED tts-platform\/workers\/bad\.py:1:/, how);
    assert.match(output, /Syntax check \(py\): 2 Python file\(s\) checked from directory walk; 1 failed\./, how);
  };

  assert.equal(resolveBatchFile(path.join(shims, "py-shim.bat")), path.join(shims, "py-shim.bat"));
  // CreateProcess cannot start these, so a plain spawn found no Python and the step was skipped.
  expectChecked(runCheck(["--lang", "py", "--root", root], { env: envWithPath(shims) }), "found on PATH");
  expectChecked(runCheck(["--lang", "py", "--root", root, "--python", "py-shim"], { env: envWithPath(shims) }), "--python by name");
  expectChecked(runCheck(["--lang", "py", "--root", root, "--python", path.join(shims, "python.cmd")]), "--python by path");
});

test("no Python exits 77, a --python that cannot start fails, and bad arguments exit 2", async (t) => {
  const root = await makeRoot(t, "check-syntax-missing-");
  await writeFile(root, "tts-platform/gateway/main.py", "VALUE = 1\n");
  const emptyPath = await makeRoot(t, "check-syntax-empty-path-");
  const missing = runCheck(["--lang", "py", "--root", root], { env: envWithPath(emptyPath) });
  assert.equal(missing.code, EXIT_INTERPRETER_MISSING, missing.output);
  assert.match(missing.output, /Syntax check \(py\) skipped: the Python interpreter is missing\./);

  // test-all passes the Python it found; one that cannot be started is not a skip.
  const unstartable = runCheck(["--lang", "py", "--root", root, "--python", path.join(root, "no-such-python.exe")]);
  assert.equal(unstartable.code, 1, unstartable.output);
  assert.match(unstartable.output, /no-such-python\.exe could not be started/);
  assert.match(unstartable.output, /Syntax check \(py\): 0 Python file\(s\) checked from directory walk; 1 failed\./);

  assert.equal(runCheck(["--lang", "rb"]).code, 2);
  assert.equal(runCheck([]).code, 2);
  assert.equal(runCheck(["--lang", "js", "--root", path.join(root, "absent")]).code, 2);
  assert.ok(!fs.existsSync(path.join(root, "absent")));
});
