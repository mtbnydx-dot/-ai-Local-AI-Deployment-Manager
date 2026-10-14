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

const repository = repositoryFiles(ROOT);

/** The source repository's files, or null after skipping the test with a note. */
function trackedFilesOrSkip(t) {
  if (repository.source !== "git") {
    t.skip("not the top of a git work tree, so tracked files cannot be told apart from local ones");
    return null;
  }
  return repository.files;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split("/")), "utf8").replace(/^\uFEFF/, "");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
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
 * OPS-8 flips every launcher at once. Until start-platform.cmd calls
 * platform.cmd the launchers keep their full bodies and the README its old
 * wording.
 */
function legacyShimsLanded() {
  return fs.existsSync(path.join(ROOT, "platform.cmd")) && /platform\.cmd/i.test(readText("start-platform.cmd"));
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
  const problems = [];
  for (const file of LEGACY_SHIMS) {
    const lines = readText(file).split(/\r?\n/);
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > MAX_SHIM_LINES) problems.push(`${file} has ${lines.length} lines (at most ${MAX_SHIM_LINES})`);
    if (!/platform\.cmd/i.test(lines.join("\n"))) problems.push(`${file} does not call platform.cmd`);
  }
  assert.deepEqual(problems, []);
});

test("README states the Node range of requirements.node", (t) => {
  if (!fs.existsSync(path.join(ROOT, ...COMPONENT_REGISTRY.split("/"))) || !legacyShimsLanded()) {
    return t.skip("requirements.node lands with the component registry (OPS-4) and the README range with OPS-8");
  }
  const { requirements } = readJson(COMPONENT_REGISTRY);
  const range = requirements && requirements.node;
  assert.ok(typeof range === "string" && range.trim(), `${COMPONENT_REGISTRY} has no requirements.node`);
  assert.ok(readText("README.md").includes(range), `README.md must state the Node range ${range} exactly`);
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
