#!/usr/bin/env node
"use strict";
// Syntax check for every JavaScript, PowerShell or Python file of the
// platform, discovered instead of listed, so a new file is checked from the
// moment it exists. test-all runs one step per language.
//
//   node scripts/check-syntax.js --lang js|ps1|py [--root <dir>] [--python <exe>] [--list]
//
// Files come from git (tracked plus untracked-but-not-ignored) at the top of a
// git work tree. Anywhere else (a deployed live root, an extracted release, a
// temp dir) the release-manifest.json directories and root files are walked,
// or the whole root when there is no manifest. node_modules, dist and the
// manifest's syntaxCheck.skipGlobs are never checked.
//
// js   *.cjs is checked as CommonJS with `node --check`. *.mjs, *.js below a
//      package.json with "type": "module", files matched by
//      syntaxCheck.esmGlobs and any *.js with a top-level import or export
//      statement are checked as ES modules through
//      `node --input-type=module --check` with the source on stdin: Node 24
//      returns 0 from `node --check x.js` for an ESM-syntax file with a syntax
//      error, because module detection skips the check. Everything else uses
//      `node --check`. Eight checks run at a time.
// ps1  One Windows PowerShell call to scripts/check-powershell-syntax.ps1.
// py   One Python process runs ast.parse over tts-platform/**/*.py. Exit code
//      77 means Python was not found, and test-all reports a skipped step.
//
// Exit codes: 0 all files parse, 1 a file failed, 2 usage error, 77 the
// language's interpreter is missing.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const MANIFEST_NAME = "release-manifest.json";
const POWERSHELL_CHECKER = path.join(__dirname, "check-powershell-syntax.ps1");
const LANGUAGES = {
  js: { label: "JavaScript", pattern: /\.(?:js|cjs|mjs)$/i },
  ps1: { label: "PowerShell", pattern: /\.ps1$/i },
  py: { label: "Python", pattern: /\.py$/i },
};
// Python files are checked only where the gateway and its workers live.
const PYTHON_GLOBS = ["tts-platform/**/*.py"];
const ALWAYS_SKIPPED_DIRECTORIES = ["node_modules", "dist", ".git"];
const CONCURRENCY = 8;
const EXIT_INTERPRETER_MISSING = 77;
// Windows command lines stop at 32767 characters; the repository's .ps1 list
// fits one call many times over, so batching only guards against growth.
const POWERSHELL_ARGUMENT_BUDGET = 24000;
// A static import or export at the start of a line. Dynamic import() and
// import.meta are allowed in CommonJS, and "import x" without "from" is the
// Python statement embedded in some template strings.
const MODULE_SYNTAX = /^(?:import\s*(?:["'{*]|[\w$]+\s*(?:,\s*[{*]|from\s*["']))|export\s*(?:[{*]|default\b|(?:const|let|var|function\*?|class|async)\s))/m;

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Manifest globs match forward-slash paths relative to the root, ignoring
 * case: "*" and "?" stay inside one segment and a "**" segment matches any
 * number of segments (the same rule as build-github-release.ps1).
 */
function globToRegExp(glob) {
  const segments = glob.split("/");
  let source = "^";
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === "**") {
      source += isLast ? ".*" : "(?:[^/]*/)*";
      return;
    }
    for (const character of segment) {
      if (character === "*") source += "[^/]*";
      else if (character === "?") source += "[^/]";
      else source += escapeRegExp(character);
    }
    if (!isLast) source += "/";
  });
  return new RegExp(`${source}$`, "i");
}

function readManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${MANIFEST_NAME} cannot be read: ${error.message}`);
  }
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Tracked plus untracked-but-not-ignored files at the top of a git work tree, or null. */
function gitFiles(root) {
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  if (prefix.error || prefix.status !== 0 || prefix.stdout.trim()) return null;
  const result = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (result.error || result.status !== 0) return null;
  const files = new Set(result.stdout.split("\0").filter(Boolean));
  return Array.from(files).filter((file) => fs.existsSync(path.join(root, file))).sort();
}

/**
 * Walks what a release would hold: the manifest's directories and root files,
 * leaving out folders the release never ships (robocopy excludes and runtime
 * data). Without a manifest the whole root is walked.
 */
function walkFiles(root, manifest) {
  const skippedNames = new Set(ALWAYS_SKIPPED_DIRECTORIES.map((name) => name.toLowerCase()));
  const skippedPatterns = [];
  for (const pattern of list(manifest && manifest.robocopy && manifest.robocopy.excludeDirs)) {
    if (/[*?]/.test(pattern)) skippedPatterns.push(new RegExp(`^${Array.from(pattern, (c) => (c === "*" ? ".*" : c === "?" ? "." : escapeRegExp(c))).join("")}$`, "i"));
    else skippedNames.add(pattern.toLowerCase());
  }
  const runtimeData = new Set(list(manifest && manifest.runtimeDataDirectories).map((directory) => directory.toLowerCase()));
  const skipDirectory = (name, relativePath) =>
    skippedNames.has(name.toLowerCase()) || skippedPatterns.some((re) => re.test(name)) || runtimeData.has(relativePath.toLowerCase());

  const files = new Set();
  const pending = manifest ? list(manifest.directories).filter((directory) => fs.existsSync(path.join(root, directory))) : [""];
  while (pending.length) {
    const relativeDir = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirectory(entry.name, relativePath)) pending.push(relativePath);
      } else if (entry.isFile()) {
        files.add(relativePath);
      }
    }
  }
  if (manifest) {
    for (const file of list(manifest.files)) {
      if (fs.existsSync(path.join(root, file))) files.add(file);
    }
  }
  return Array.from(files).sort();
}

/** Every candidate file under root: { files, source: "git" | "directory walk", manifest }. */
function repositoryFiles(root) {
  const manifest = readManifest(root);
  const tracked = gitFiles(root);
  if (tracked) return { files: tracked, source: "git", manifest };
  return { files: walkFiles(root, manifest), source: "directory walk", manifest };
}

function syntaxSettings(manifest) {
  const syntaxCheck = (manifest && manifest.syntaxCheck) || {};
  return {
    esmGlobs: list(syntaxCheck.esmGlobs).map(globToRegExp),
    skipGlobs: list(syntaxCheck.skipGlobs).map(globToRegExp),
  };
}

/** The files to check for one language, sorted, as forward-slash paths relative to root. */
function listSyntaxFiles(language, { root = DEFAULT_ROOT } = {}) {
  const spec = LANGUAGES[language];
  if (!spec) throw new Error(`unknown language "${language}" (use js, ps1 or py)`);
  const { files, source, manifest } = repositoryFiles(root);
  const { skipGlobs } = syntaxSettings(manifest);
  const skippedSegments = new Set(ALWAYS_SKIPPED_DIRECTORIES);
  const pythonGlobs = PYTHON_GLOBS.map(globToRegExp);
  const selected = files.filter((file) => {
    if (!spec.pattern.test(file)) return false;
    if (file.split("/").slice(0, -1).some((segment) => skippedSegments.has(segment.toLowerCase()))) return false;
    if (skipGlobs.some((re) => re.test(file))) return false;
    return language !== "py" || pythonGlobs.some((re) => re.test(file));
  });
  return { files: selected, source, manifest };
}

function hasTopLevelModuleSyntax(source) {
  return MODULE_SYNTAX.test(source);
}

/** Returns file -> the "type" of its nearest package.json at or below root. */
function createPackageTypeLookup(root) {
  const cache = new Map();
  function typeOfDirectory(relativeDir) {
    if (cache.has(relativeDir)) return cache.get(relativeDir);
    let type = "";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, relativeDir, "package.json"), "utf8").replace(/^\uFEFF/, ""));
      type = typeof pkg.type === "string" ? pkg.type : "commonjs";
    } catch (error) {
      if (error.code !== "ENOENT") type = "commonjs";
      else if (relativeDir) type = typeOfDirectory(path.posix.dirname(relativeDir) === "." ? "" : path.posix.dirname(relativeDir));
    }
    cache.set(relativeDir, type);
    return type;
  }
  return (file) => {
    const directory = path.posix.dirname(file);
    return typeOfDirectory(directory === "." ? "" : directory);
  };
}

/** "esm" or "cjs", with the reason, for one JavaScript file. */
function classifyJsFile(file, source, { esmGlobs = [], packageTypeOf = () => "" } = {}) {
  if (/\.cjs$/i.test(file)) return { mode: "cjs", reason: ".cjs" };
  if (/\.mjs$/i.test(file)) return { mode: "esm", reason: ".mjs" };
  if (packageTypeOf(file) === "module") return { mode: "esm", reason: "package.json type module" };
  if (esmGlobs.some((re) => re.test(file))) return { mode: "esm", reason: "syntaxCheck.esmGlobs" };
  if (hasTopLevelModuleSyntax(source)) return { mode: "esm", reason: "top-level import or export" };
  return { mode: "cjs", reason: "default" };
}

function run(command, args, { cwd, input, env } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, output: "", error });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.stdin.on("error", () => {});
    child.on("error", (error) => resolve({ code: null, output, error }));
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(input === undefined ? "" : input);
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Checks JavaScript files; returns [{ file, mode, reason, ok, output }]. */
async function checkJsFiles(files, { root = DEFAULT_ROOT, manifest = null, concurrency = CONCURRENCY } = {}) {
  const { esmGlobs } = syntaxSettings(manifest);
  const packageTypeOf = createPackageTypeLookup(root);
  return mapLimit(files, concurrency, async (file) => {
    const fullPath = path.join(root, ...file.split("/"));
    const source = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
    const { mode, reason } = classifyJsFile(file, source, { esmGlobs, packageTypeOf });
    const result = mode === "esm"
      ? await run(process.execPath, ["--input-type=module", "--check"], { cwd: root, input: source })
      : await run(process.execPath, ["--check", fullPath], { cwd: root });
    const output = result.error ? result.error.message : result.output.replace(/\[stdin\]/g, file).trim();
    return { file, mode, reason, ok: result.code === 0, output };
  });
}

// Windows PowerShell 5.1 started below a pwsh 7 session inherits pwsh's
// PSModulePath and then cannot load its own modules. Without the variable it
// builds its default module path.
function windowsPowerShellEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
}

function powerShellBatches(files) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    if (current.length && length + file.length + 3 > POWERSHELL_ARGUMENT_BUDGET) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 3;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Checks .ps1 files with check-powershell-syntax.ps1; returns { missing, checked, failed, output }. */
async function checkPowerShellFiles(files, { root = DEFAULT_ROOT, executable = process.platform === "win32" ? "powershell.exe" : "pwsh" } = {}) {
  let failed = 0;
  let output = "";
  for (const batch of powerShellBatches(files)) {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", POWERSHELL_CHECKER, ...batch.map((file) => file.split("/").join(path.sep))];
    const result = await run(executable, args, { cwd: root, env: windowsPowerShellEnv() });
    if (result.error) {
      if (result.error.code === "ENOENT") return { missing: true, checked: 0, failed: 0, output: `${executable} was not found.` };
      throw result.error;
    }
    output += result.output;
    const passed = (result.output.match(/^PowerShell syntax OK: /gm) || []).length;
    if (result.code !== 0) failed += Math.max(batch.length - passed, 1);
  }
  return { missing: false, checked: files.length, failed, output: output.trim() };
}

const PYTHON_CHECKER = [
  "import ast, json, sys",
  "failed = 0",
  "for name in json.loads(sys.stdin.read()):",
  "    try:",
  "        with open(name, encoding='utf-8-sig') as handle:",
  "            ast.parse(handle.read(), filename=name)",
  "    except SyntaxError as error:",
  "        failed += 1",
  "        print('FAILED %s:%s: %s' % (name, error.lineno, error.msg))",
  "    except (OSError, UnicodeDecodeError, ValueError) as error:",
  "        failed += 1",
  "        print('FAILED %s: %s' % (name, error))",
  "sys.exit(1 if failed else 0)",
].join("\n");

/** The first candidate that runs as Python 3, or "". */
function findPython(candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === "3") return candidate;
  }
  return "";
}

/** Parses .py files in one Python process; returns { missing, checked, failed, output }. */
async function checkPythonFiles(files, { root = DEFAULT_ROOT, python = "" } = {}) {
  const executable = python || findPython();
  if (!executable) return { missing: true, checked: 0, failed: 0, output: "Python 3 was not found; pass --python <exe>." };
  // UTF-8 both ways, so non-ASCII paths survive a non-UTF-8 console code page.
  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  const result = await run(executable, ["-c", PYTHON_CHECKER], { cwd: root, input: JSON.stringify(files), env });
  if (result.error) {
    if (result.error.code === "ENOENT") return { missing: true, checked: 0, failed: 0, output: `${executable} was not found.` };
    throw result.error;
  }
  const failed = (result.output.match(/^FAILED /gm) || []).length;
  if (result.code !== 0 && !failed) {
    return { missing: false, checked: files.length, failed: files.length, output: `${executable} exited with ${result.code}: ${result.output.trim()}` };
  }
  return { missing: false, checked: files.length, failed: result.code === 0 ? 0 : failed, output: result.output.trim() };
}

function parseArgs(argv) {
  const options = { language: "", root: DEFAULT_ROOT, python: "", list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === "--lang") options.language = value();
    else if (arg === "--root") options.root = path.resolve(value());
    else if (arg === "--python") options.python = value();
    else if (arg === "--list") options.list = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!LANGUAGES[options.language]) throw new Error("--lang must be js, ps1 or py");
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`check-syntax: ${error.message}`);
    console.error("Usage: node scripts/check-syntax.js --lang js|ps1|py [--root <dir>] [--python <exe>] [--list]");
    return 2;
  }
  const { language, root } = options;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`check-syntax: not a directory: ${root}`);
    return 2;
  }
  const { label } = LANGUAGES[language];
  const { files, source, manifest } = listSyntaxFiles(language, { root });

  if (options.list) {
    if (language === "js") {
      const { esmGlobs } = syntaxSettings(manifest);
      const packageTypeOf = createPackageTypeLookup(root);
      for (const file of files) {
        const text = fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
        console.log(`${classifyJsFile(file, text, { esmGlobs, packageTypeOf }).mode}\t${file}`);
      }
    } else {
      for (const file of files) console.log(file);
    }
    console.log(`${files.length} ${label} file(s) (${source}).`);
    return 0;
  }

  if (language === "js") {
    const results = await checkJsFiles(files, { root, manifest });
    const failures = results.filter((result) => !result.ok);
    for (const failure of failures) console.log(`FAILED ${failure.file} (${failure.mode === "esm" ? `ES module: ${failure.reason}` : "CommonJS"})\n${failure.output}\n`);
    const esm = results.filter((result) => result.mode === "esm").length;
    console.log(`Syntax check (js): ${results.length} ${label} file(s) checked (${esm} as ES modules, ${results.length - esm} as CommonJS) from ${source}; ${failures.length} failed.`);
    return failures.length ? 1 : 0;
  }

  const outcome = language === "ps1"
    ? await checkPowerShellFiles(files, { root })
    : await checkPythonFiles(files, { root, python: options.python });
  if (outcome.output) console.log(outcome.output);
  if (outcome.missing) {
    console.log(`Syntax check (${language}) skipped: the ${label} interpreter is missing.`);
    return EXIT_INTERPRETER_MISSING;
  }
  console.log(`Syntax check (${language}): ${outcome.checked} ${label} file(s) checked from ${source}; ${outcome.failed} failed.`);
  return outcome.failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`check-syntax: ${error && error.stack ? error.stack : error}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  EXIT_INTERPRETER_MISSING,
  LANGUAGES,
  PYTHON_GLOBS,
  checkJsFiles,
  checkPowerShellFiles,
  checkPythonFiles,
  classifyJsFile,
  createPackageTypeLookup,
  findPython,
  globToRegExp,
  hasTopLevelModuleSyntax,
  listSyntaxFiles,
  main,
  repositoryFiles,
};
