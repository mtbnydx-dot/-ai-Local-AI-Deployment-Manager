"use strict";

// Repository hygiene that no single package owns: script encodings (the rule
// of scripts/check-script-encoding.js, whose allowlist stays the single
// source), the legacy shims of 06 §6.6, the README's Node range, and test
// discovery. Tests are registered by placing files (00 §9.15): package test
// scripts, the root script tests and Playwright specs are found by glob, so no
// package edits package.json, playwright.config.cjs or test-all.cmd for that.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { ALLOW_BOM, checkScriptEncoding } = require("../check-script-encoding.js");
const { repositoryFiles } = require("../check-syntax.js");

const ROOT = path.resolve(__dirname, "..", "..");
const ENCODING_SCRIPT = path.join(ROOT, "scripts", "check-script-encoding.js");
const BATCH_FILE = /\.(?:cmd|bat)$/i;
const PACKAGE_TEST_GLOB = '"test/**/*.test.{js,mjs}"';
const PACKAGE_TEST_SCRIPTS = {
  "manager-core": `node --test ${PACKAGE_TEST_GLOB}`,
  "service-entry": `node --test ${PACKAGE_TEST_GLOB}`,
  "vllm-manager": `node --test ${PACKAGE_TEST_GLOB}`,
  "llama-manager": `node --test ${PACKAGE_TEST_GLOB}`,
  "search-gateway": `node --test --test-isolation=none ${PACKAGE_TEST_GLOB}`,
  "platform-mcp": 'npm run build && node --test "dist/test/**/*.test.js"',
};
const PLAYWRIGHT_TEST_MATCH = ["**/*.spec.cjs", "**/*.spec.js", "**/*.spec.mjs"];
const AXE_CORE_VERSION = "4.13.0";
// 06 §6.6: the names, arguments and scheduled-task paths stay; OPS-8 turns
// each into a short call to platform.cmd.
const LEGACY_SHIMS = [
  "start-platform.cmd",
  "stop-platform.cmd",
  "status-platform.cmd",
  "start-service-entry.cmd",
  "start-service-entry-lan.cmd",
  "stop-service-entry.cmd",
  "status-service-entry.cmd",
  "start-platform-mcp.cmd",
  "stop-platform-mcp.cmd",
  "status-platform-mcp.cmd",
  "start-search-gateway.cmd",
  "stop-search-gateway.cmd",
  "start-tts-platform.cmd",
  "vllm-manager/start-manager.cmd",
  "vllm-manager/stop-manager.cmd",
  "llama-manager/start-manager.cmd",
  "llama-manager/stop-manager.cmd",
];
const MAX_SHIM_LINES = 8;
const COMPONENT_REGISTRY = "manager-core/data/platform-components.json";
// The root shim as a command, at a path boundary once %~dp0 and %NAME% are
// read as folders: "%~dp0platform.cmd", %~dp0..\platform.cmd,
// "%ROOT%platform.cmd" or a bare platform.cmd. start-platform.cmd and
// start-tts-platform.cmd merely end in "platform.cmd" and do not count.
const PLATFORM_CMD_COMMAND = /(?:^|[\s"(&|\\/])platform\.cmd(?=$|[\s"&|)<>])/i;

const repository = repositoryFiles(ROOT);

/** The source repository's files, or null after skipping the test with a note. */
function trackedFilesOrSkip(t) {
  if (repository.source !== "git") {
    t.skip("not the top of a git work tree, so tracked files cannot be told apart from local ones");
    return null;
  }
  return repository.files;
}

function fullPath(relativePath, root = ROOT) {
  return path.join(root, ...relativePath.split("/"));
}

function readText(relativePath, root = ROOT) {
  return fs.readFileSync(fullPath(relativePath, root), "utf8").replace(/^\uFEFF/, "");
}

function readJson(relativePath, root = ROOT) {
  return JSON.parse(readText(relativePath, root));
}

function hasBom(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasNonAscii(bytes) {
  for (let index = hasBom(bytes) ? 3 : 0; index < bytes.length; index += 1) {
    if (bytes[index] > 0x7f) return true;
  }
  return false;
}

/**
 * A .ps1 may keep a BOM when Windows PowerShell 5.1 needs one to read its
 * non-ASCII text, or when check-script-encoding.js allowlists it. Batch files
 * never may.
 */
function bomAllowance(root, files) {
  const allowed = new Set(ALLOW_BOM);
  for (const file of files) {
    if (/\.ps1$/i.test(file) && hasNonAscii(fs.readFileSync(path.join(root, file)))) allowed.add(file);
  }
  return allowed;
}

/**
 * True when a batch file runs the root platform.cmd on some line. rem, :: and
 * echo lines only mention names, so they never count.
 */
function callsPlatformCmd(text) {
  return text.split(/\r?\n/).some((line) => {
    const statement = line.trim().replace(/^@/, "");
    if (/^(?:rem\b|::|echo\b)/i.test(statement)) return false;
    return PLATFORM_CMD_COMMAND.test(statement.replace(/%~[a-z]*[0-9]|%[^%\s]+%/gi, "\\"));
  });
}

/**
 * OPS-8 turns every launcher into a platform.cmd shim at once (06 §6.6), so
 * the shim and README checks start when start-platform.cmd itself calls
 * platform.cmd. platform.cmd alone (OPS-7a adds it) does not start them, and
 * neither do the launchers' mentions of start-platform.cmd or
 * start-tts-platform.cmd. The gate looks at the call only, not the length, so
 * an over-long shim after OPS-8 fails instead of skipping.
 */
function legacyShimsLanded(root = ROOT) {
  return fs.existsSync(fullPath("start-platform.cmd", root)) && callsPlatformCmd(readText("start-platform.cmd", root));
}

/** After OPS-8: every §6.6 launcher is at most MAX_SHIM_LINES lines and calls platform.cmd. */
function legacyShimProblems(root = ROOT) {
  const problems = [];
  if (!fs.existsSync(fullPath("platform.cmd", root))) problems.push("platform.cmd is missing, but start-platform.cmd calls it");
  for (const file of LEGACY_SHIMS) {
    if (!fs.existsSync(fullPath(file, root))) {
      problems.push(`${file} is missing`);
      continue;
    }
    const lines = readText(file, root).split(/\r?\n/);
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > MAX_SHIM_LINES) problems.push(`${file} has ${lines.length} lines (at most ${MAX_SHIM_LINES})`);
    if (!callsPlatformCmd(lines.join("\n"))) problems.push(`${file} does not call platform.cmd`);
  }
  return problems;
}

/** { skip: reason } until OPS-4 and OPS-8 have landed, then { problems }. */
function readmeNodeRangeCheck(root = ROOT) {
  if (!fs.existsSync(fullPath(COMPONENT_REGISTRY, root)) || !legacyShimsLanded(root)) {
    return { skip: "requirements.node lands with the component registry (OPS-4) and the README range with OPS-8" };
  }
  const { requirements } = readJson(COMPONENT_REGISTRY, root);
  const range = requirements && requirements.node;
  if (typeof range !== "string" || !range.trim()) return { problems: [`${COMPONENT_REGISTRY} has no requirements.node`] };
  return { problems: readText("README.md", root).includes(range) ? [] : [`README.md must state the Node range ${range} exactly`] };
}

function describeProblems(problems) {
  return problems.map((problem) => `  - ${problem.file}: ${problem.message}`).join("\n");
}

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

test("every .cmd and .bat file is CRLF without a BOM", (t) => {
  const files = trackedFilesOrSkip(t);
  if (!files) return;
  const batchFiles = files.filter((file) => BATCH_FILE.test(file));
  assert.ok(batchFiles.includes("test-all.cmd"));
  const { checked, problems } = checkScriptEncoding(batchFiles, { root: ROOT, allowBom: new Set() });
  assert.equal(checked, batchFiles.length);
  assert.deepEqual(problems, [], `Save these as UTF-8 without a BOM and with CRLF line endings:\n${describeProblems(problems)}`);
});

test("every .ps1 file is CRLF and has a BOM only for non-ASCII text or on the allowlist", (t) => {
  const files = trackedFilesOrSkip(t);
  if (!files) return;
  const scripts = files.filter((file) => /\.ps1$/i.test(file));
  assert.ok(scripts.length > 0);
  const { problems } = checkScriptEncoding(scripts, { root: ROOT, allowBom: bomAllowance(ROOT, scripts) });
  assert.deepEqual(problems, [], `Save these with CRLF line endings, and without a BOM unless they hold non-ASCII text:\n${describeProblems(problems)}`);
});

test("the BOM allowlist stays empty: the TTS scripts are plain ASCII without a BOM", (t) => {
  assert.equal(ALLOW_BOM.size, 0, "new scripts must not be added to the BOM allowlist");
  for (const file of ["start_all.ps1", "start_gateway.ps1", "status.ps1"]) {
    const buffer = fs.readFileSync(path.join(ROOT, "tts-platform", "scripts", file));
    assert.equal(hasNonAscii(buffer), false, `${file} holds non-ASCII text`);
    assert.notDeepEqual([...buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} starts with a BOM`);
  }
});

test("a planted BOM .cmd fails the encoding check", async (t) => {
  const root = await makeRoot(t, "scripts-hygiene-bom-");
  await writeFile(root, "start-planted.cmd", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("@echo off\r\necho planted\r\n")]));
  await writeFile(root, "lf-only.cmd", "@echo off\necho lf\n");
  await writeFile(root, "clean.cmd", "@echo off\r\necho clean\r\n");
  await writeFile(root, "ascii-bom.ps1", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Write-Output 'ascii'\r\n")]));
  await writeFile(root, "cjk-bom.ps1", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Write-Output '语音平台'\r\n")]));
  const files = ["start-planted.cmd", "lf-only.cmd", "clean.cmd", "ascii-bom.ps1", "cjk-bom.ps1"];

  const { checked, problems } = checkScriptEncoding(files, { root, allowBom: bomAllowance(root, files) });
  assert.equal(checked, 5);
  assert.deepEqual(problems.map(({ file, kind }) => `${file}:${kind}`), ["start-planted.cmd:bom", "lf-only.cmd:lf", "ascii-bom.ps1:bom"]);

  // The standalone script (no git there, so the directory is walked) fails too.
  const cli = spawnSync(process.execPath, [ENCODING_SCRIPT, root], { encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 1, cli.stdout);
  assert.match(cli.stdout, /start-planted\.cmd: starts with a UTF-8 BOM/);
});

test("the legacy launcher names stay, and after OPS-8 each one is a short platform.cmd shim", (t) => {
  const files = trackedFilesOrSkip(t);
  if (!files) return;
  const missing = LEGACY_SHIMS.filter((file) => !files.includes(file));
  assert.deepEqual(missing, [], "06 §6.6 keeps these launcher names (scheduled tasks and habits use them)");

  if (!legacyShimsLanded()) return t.skip("the launchers become platform.cmd shims in OPS-8");
  assert.deepEqual(legacyShimProblems(), []);
});

test("README states the Node range of requirements.node", (t) => {
  const { skip, problems } = readmeNodeRangeCheck();
  if (skip) return t.skip(skip);
  assert.deepEqual(problems, []);
});

test("only a command that runs the root shim counts as calling platform.cmd", () => {
  for (const text of [
    'call "%~dp0platform.cmd" start %1 %2 --legacy-args',
    'call "%~dp0..\\platform.cmd" stop vllm-manager --open',
    '"%ROOT%platform.cmd" status',
    "%~dp0platform.cmd stop all",
    "@call platform.cmd status entry",
    'if /i "%~1"=="all" (call "%~dp0platform.cmd" stop all) else (call "%~dp0platform.cmd" stop core)',
    'rem Usage: shim\r\ncall "%~dp0platform.cmd" start core --lan\r\nexit /b %ERRORLEVEL%',
  ]) {
    assert.equal(callsPlatformCmd(text), true, text);
  }
  for (const text of [
    "rem   start-platform.cmd core lan   core with the entry bound to the LAN",
    "rem Stops the platform processes started by start-platform.cmd.",
    'call "%ROOT%start-tts-platform.cmd" -GatewayOnly -NoBrowser',
    'if not exist "%ROOT%start-tts-platform.cmd" (',
    "  echo start-tts-platform.cmd not found; skipping TTS.",
    'call "%~dp0start-platform.cmd" core lan',
    'if exist "%ROOT%stop-platform-mcp.cmd" call "%ROOT%stop-platform-mcp.cmd"',
    "rem Thin wrapper over platform.cmd",
    ":: platform.cmd does the work",
    "echo Run platform.cmd start instead.",
    'call "%~dp0platform.cmd.bak" start',
  ]) {
    assert.equal(callsPlatformCmd(text), false, text);
  }
});

// Lines of today's start-platform.cmd that name *platform.cmd files without
// calling the root shim.
const LEGACY_START_PLATFORM = [
  "@echo off",
  "setlocal",
  "rem One command for the whole platform.",
  "rem   start-platform.cmd            core: service entry + both managers (loopback entry)",
  "rem   start-platform.cmd all lan    same, entry on the LAN",
  'set "ROOT=%~dp0"',
  ":startTts",
  'if not exist "%ROOT%start-tts-platform.cmd" (',
  "  echo start-tts-platform.cmd not found; skipping TTS.",
  '  set "ST_TTS=SKIPPED start-tts-platform.cmd not found"',
  "  exit /b 0",
  ")",
  'call "%ROOT%start-tts-platform.cmd" -GatewayOnly -NoBrowser',
  "exit /b 0",
  "",
].join("\r\n");
const NODE_RANGE = "^22.22.2 || ^24.15.0 || >=26.0.0";

/** The §6.6 shim body for one launcher. */
function shimBody(file) {
  const platform = file.includes("/") ? "%~dp0..\\platform.cmd" : "%~dp0platform.cmd";
  return `@echo off\r\nsetlocal\r\ncall "${platform}" start %*\r\nexit /b %ERRORLEVEL%\r\n`;
}

test("platform.cmd alone (OPS-7a) leaves the shim and README checks off", async (t) => {
  const root = await makeRoot(t, "scripts-hygiene-ops7a-");
  await writeFile(root, "start-platform.cmd", LEGACY_START_PLATFORM);
  await writeFile(root, "stop-platform.cmd", "@echo off\r\nrem Stops the platform processes started by start-platform.cmd.\r\n");
  await writeFile(root, "platform.cmd", '@echo off\r\nsetlocal\r\n"%PLATFORM_NODE%" "%~dp0scripts\\platformctl.js" %*\r\nexit /b %ERRORLEVEL%\r\n');
  await writeFile(root, COMPONENT_REGISTRY, JSON.stringify({ schemaVersion: 1, requirements: { node: NODE_RANGE } }));
  await writeFile(root, "README.md", "Node.js >=26 or 24 LTS\n");

  assert.equal(legacyShimsLanded(root), false);
  assert.match(readmeNodeRangeCheck(root).skip, /OPS-8/);
});

test("after OPS-8 every launcher must be a short platform.cmd shim and README must state requirements.node", async (t) => {
  const root = await makeRoot(t, "scripts-hygiene-ops8-");
  await writeFile(root, "platform.cmd", "@echo off\r\n");
  for (const file of LEGACY_SHIMS) await writeFile(root, file, shimBody(file));
  await writeFile(root, COMPONENT_REGISTRY, JSON.stringify({ schemaVersion: 1, requirements: { node: NODE_RANGE } }));
  await writeFile(root, "README.md", `Node.js ${NODE_RANGE}\n`);
  assert.equal(legacyShimsLanded(root), true);
  assert.deepEqual(legacyShimProblems(root), []);
  assert.deepEqual(readmeNodeRangeCheck(root), { problems: [] });

  // A shim that hands over to another launcher, and a launcher that only
  // mentions start-platform.cmd, do not call platform.cmd.
  await writeFile(root, "start-service-entry-lan.cmd", '@echo off\r\ncall "%~dp0start-platform.cmd" core lan\r\n');
  await writeFile(root, "stop-platform.cmd", '@echo off\r\nrem Stops what start-platform.cmd started.\r\ncall "%~dp0stop-service-entry.cmd"\r\n');
  await writeFile(root, "status-platform.cmd", `${shimBody("status-platform.cmd")}${"rem padding\r\n".repeat(5)}`);
  await writeFile(root, "README.md", "Node.js >=26\n");
  await fsp.rm(fullPath("llama-manager/stop-manager.cmd", root));
  assert.deepEqual(legacyShimProblems(root), [
    "stop-platform.cmd does not call platform.cmd",
    "status-platform.cmd has 9 lines (at most 8)",
    "start-service-entry-lan.cmd does not call platform.cmd",
    "llama-manager/stop-manager.cmd is missing",
  ]);
  assert.deepEqual(readmeNodeRangeCheck(root), { problems: [`README.md must state the Node range ${NODE_RANGE} exactly`] });

  // start-platform.cmd calling a platform.cmd that is not there is a failure, not a skip.
  await fsp.rm(fullPath("platform.cmd", root));
  assert.equal(legacyShimsLanded(root), true);
  assert.equal(legacyShimProblems(root)[0], "platform.cmd is missing, but start-platform.cmd calls it");
});

test("fixture and helper folders hold no test or spec files", (t) => {
  const files = trackedFilesOrSkip(t);
  if (!files) return;
  const misplaced = files.filter((file) => {
    const segments = file.split("/");
    const name = segments[segments.length - 1];
    const inFixtures = segments.slice(0, -1).some((segment) => segment.toLowerCase() === "fixtures");
    if (inFixtures && /\.test\.[cm]?[jt]sx?$/i.test(name)) return true;
    return /^tests\/(?:helpers|fixtures)\//i.test(file) && /\.spec\.[cm]?[jt]sx?$/i.test(name);
  });
  assert.deepEqual(misplaced, [], "test discovery globs would run these; rename them or move them out of fixtures and helpers");
});

test("package tests, script tests and Playwright specs are discovered by glob", () => {
  for (const [directory, expected] of Object.entries(PACKAGE_TEST_SCRIPTS)) {
    const pkg = readJson(`${directory}/package.json`);
    assert.equal(pkg.scripts && pkg.scripts.test, expected, `${directory}/package.json test script`);
  }
  const rootPackage = readJson("package.json");
  assert.equal(rootPackage.scripts["test:scripts"], 'node --test "scripts/test/**/*.test.{js,mjs}"');
  assert.equal(rootPackage.scripts["test:frontend-smoke"], "playwright test --config=playwright.config.cjs");

  const config = require(path.join(ROOT, "playwright.config.cjs"));
  assert.equal(path.resolve(ROOT, config.testDir), path.join(ROOT, "tests"));
  assert.deepEqual(config.testMatch, PLAYWRIGHT_TEST_MATCH);

  const testAll = readText("test-all.cmd");
  for (const language of ["js", "ps1", "py"]) {
    assert.match(testAll, new RegExp(`^call :syntax ${language}\\r?$`, "m"), `test-all.cmd runs the ${language} syntax step`);
  }
  assert.doesNotMatch(testAll, /^call :check(?:ps1|py)? "/m, "test-all.cmd no longer lists files one by one");
});

test("a test file in a new subfolder runs under a package's npm test", async (t) => {
  const root = await makeRoot(t, "scripts-hygiene-pkg-");
  await writeFile(root, "package.json", JSON.stringify({ name: "probe", private: true, scripts: { test: PACKAGE_TEST_SCRIPTS["manager-core"] } }));
  const probe = (name) => `"use strict";\nrequire("node:test")(${JSON.stringify(name)}, () => {});\n`;
  await writeFile(root, "test/top.test.js", probe("top-level probe"));
  await writeFile(root, "test/sub/probe.test.js", probe("subfolder probe"));
  await writeFile(root, "test/sub/deeper/esm.test.mjs", 'import test from "node:test";\ntest("module probe", () => {});\n');
  await writeFile(root, "test/fixtures/sample.js", 'throw new Error("fixtures are not tests");\n');
  await writeFile(root, "test/helpers/util.js", 'throw new Error("helpers are not tests");\n');

  // Without NODE_TEST_CONTEXT the child is a top-level test run, not a nested one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
  const run = spawnSync("npm test", { cwd: root, env, shell: true, encoding: "utf8", windowsHide: true, timeout: 120000 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, output);
  for (const name of ["top-level probe", "subfolder probe", "module probe"]) assert.match(output, new RegExp(name));
  assert.match(output, /tests 3\b/);
});

test("Playwright lists a new spec under tests/ without a config edit", async (t) => {
  let playwrightIndex;
  try {
    playwrightIndex = require.resolve("@playwright/test", { paths: [ROOT] });
  } catch {
    return t.skip("@playwright/test is not installed at the root (run install-all.cmd)");
  }
  const cli = path.join(path.dirname(require.resolve("@playwright/test/package.json", { paths: [ROOT] })), "cli.js");
  const root = await makeRoot(t, "scripts-hygiene-playwright-");
  // The real configuration, unchanged, re-exported from a folder whose tests/
  // holds probes: Playwright resolves testDir against the config file it loads.
  await writeFile(root, "playwright.config.cjs", `module.exports = require(${JSON.stringify(path.join(ROOT, "playwright.config.cjs"))});\n`);
  const commonJsSpec = (name) => `const { test } = require(${JSON.stringify(playwrightIndex)});\ntest(${JSON.stringify(name)}, () => {});\n`;
  await writeFile(root, "tests/frontend/probe.spec.js", commonJsSpec("frontend probe"));
  await writeFile(root, "tests/frontend/console/deep.spec.cjs", commonJsSpec("nested probe"));
  const moduleIndex = pathToFileURL(path.join(path.dirname(playwrightIndex), "index.mjs")).href;
  await writeFile(root, "tests/module.spec.mjs", `import { test } from ${JSON.stringify(moduleIndex)};\ntest("module probe", () => {});\n`);
  await writeFile(root, "tests/unit.test.js", commonJsSpec("not a spec"));
  await writeFile(root, "tests/helpers/util.js", "module.exports = {};\n");

  const run = spawnSync(process.execPath, [cli, "test", "--list", "--config", path.join(root, "playwright.config.cjs")], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 120000,
  });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, output);
  for (const name of ["frontend probe", "nested probe", "module probe"]) assert.match(output, new RegExp(name));
  assert.doesNotMatch(output, /not a spec/);
  assert.match(output, /Total: 3 tests in 3 files/);
});

test(`axe-core ${AXE_CORE_VERSION} is a root devDependency`, () => {
  const rootPackage = readJson("package.json");
  assert.equal(rootPackage.devDependencies["axe-core"], AXE_CORE_VERSION, "pinned exactly in the root package.json");
  assert.equal(rootPackage.dependencies, undefined, "the root package has dev dependencies only");
  for (const directory of ["manager-core", "service-entry"]) {
    const pkg = readJson(`${directory}/package.json`);
    assert.equal({ ...pkg.dependencies, ...pkg.devDependencies }["axe-core"], undefined, `${directory} takes no axe-core dependency`);
  }
  const lock = readJson("package-lock.json");
  assert.equal(lock.packages["node_modules/axe-core"].version, AXE_CORE_VERSION);
  assert.equal(lock.packages["node_modules/axe-core"].dev, true);
  let installed;
  try {
    installed = require(require.resolve("axe-core/package.json", { paths: [ROOT] }));
  } catch {
    assert.fail("axe-core is not installed at the root; run npm ci there (install-all.cmd does)");
  }
  assert.equal(installed.version, AXE_CORE_VERSION);
});
