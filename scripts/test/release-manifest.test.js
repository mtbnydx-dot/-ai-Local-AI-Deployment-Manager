"use strict";

// release-manifest.json is the release allowlist that build-github-release.ps1
// reads. These tests model the build (robocopy of the release directories,
// runtime-data removal, forceInclude, explicit files) over the repository's
// git file list and prove that every file is either shipped or excluded with a
// reason, so a new file can never fall out of (or into) the release silently.
// The last test runs the real build on a fixture repository.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "release-manifest.json");
const BUILD_SCRIPT = path.join(ROOT, "build-github-release.ps1");
const PACKAGE_NAME_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
// Same expression as the README documentation-link check in the build script.
const README_DOC_LINK = /\]\((docs\/[^)#?]+\.md)(?:#[^)]*)?\)/g;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Manifest globs match forward-slash paths relative to the repository root,
 * ignoring case: "*" and "?" stay inside one segment and a "**" segment matches
 * any number of segments. ConvertTo-ReleaseGlobRegex in the build script
 * builds the same expression.
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

/** Robocopy /XD and /XF wildcards match one file or folder name, ignoring case. */
function wildcardToRegExp(pattern) {
  const source = Array.from(pattern, (character) => {
    if (character === "*") return ".*";
    if (character === "?") return ".";
    return escapeRegExp(character);
  }).join("");
  return new RegExp(`^${source}$`, "i");
}

function isUnder(file, directory) {
  return file.toLowerCase().startsWith(`${directory.replace(/\/+$/, "").toLowerCase()}/`);
}

/**
 * The privacy check's forbidden-name rule, read from the build script so the
 * model can never drift from it. The script carries the rule twice (the
 * privacy check and the forceInclude filter); both copies must be identical.
 */
function loadForbiddenNameRule(scriptText) {
  const copies = Array.from(scriptText.matchAll(/-match '(\(\?i\)\([^']*\))'/g), (match) => match[1]);
  const expression = new RegExp(copies[0] ? copies[0].replace(/^\(\?i\)/, "") : "$^", "i");
  const isForbiddenName = (name) => {
    const lower = name.toLowerCase();
    return lower === ".env" || (lower.startsWith(".env.") && lower !== ".env.example") || expression.test(name);
  };
  return { copies, isForbiddenName };
}

/** Tracked plus untracked-but-not-ignored files that exist on disk, or null outside git. */
function gitFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  const files = new Set(result.stdout.split("\0").filter(Boolean));
  return Array.from(files).filter((file) => fs.existsSync(path.join(root, file))).sort();
}

/**
 * Decides, for every file, what the build does with it and reports the files
 * the manifest does not account for. Returns { shipped: Map(file -> via), problems }.
 */
function classifyRelease(manifest, files, { isForbiddenName = () => false } = {}) {
  const rootFiles = new Set(list(manifest.files));
  const extraFiles = new Set(list(manifest.extraFiles));
  const directories = list(manifest.directories);
  const runtimeDataDirectories = list(manifest.runtimeDataDirectories);
  const robocopy = manifest.robocopy || {};
  const excludeDirs = list(robocopy.excludeDirs).map((pattern) => ({ pattern, re: wildcardToRegExp(pattern) }));
  const excludeFiles = list(robocopy.excludeFiles).map((pattern) => ({ pattern, re: wildcardToRegExp(pattern) }));
  const forceInclude = list(manifest.forceInclude).map((glob) => ({ glob, re: globToRegExp(glob) }));
  const excluded = list(manifest.excluded).map((entry) => ({
    glob: String(entry && entry.glob || ""),
    reason: String(entry && entry.reason || "").trim(),
    re: globToRegExp(String(entry && entry.glob || "")),
  }));

  function decide(file) {
    if (rootFiles.has(file)) return { shipped: true, via: "files" };
    if (extraFiles.has(file)) return { shipped: true, via: "extraFiles" };
    const directory = directories.find((candidate) => isUnder(file, candidate));
    if (!directory) return { shipped: false, why: "it is not in a release directory, files or extraFiles" };
    const runtime = runtimeDataDirectories.find((candidate) => isUnder(file, candidate));
    if (runtime) return { shipped: false, why: `runtime data directory ${runtime} is removed from the release` };
    const segments = file.slice(directory.replace(/\/+$/, "").length + 1).split("/");
    const name = segments.pop();
    let dropped = "";
    for (const segment of segments) {
      const rule = excludeDirs.find((entry) => entry.re.test(segment));
      if (rule) {
        dropped = `robocopy excludes the folder name "${rule.pattern}"`;
        break;
      }
    }
    if (!dropped) {
      const rule = excludeFiles.find((entry) => entry.re.test(name));
      if (rule) dropped = `robocopy excludes the file name "${rule.pattern}"`;
    }
    if (!dropped) return { shipped: true, via: `directory ${directory}` };
    const force = forceInclude.find((entry) => entry.re.test(file));
    if (force && !isForbiddenName(name)) return { shipped: true, via: `forceInclude ${force.glob}` };
    if (force) return { shipped: false, why: `${dropped}, and forceInclude skips it because the privacy check rejects its name` };
    return { shipped: false, why: `it is inside ${directory}, but ${dropped}` };
  }

  const shipped = new Map();
  const problems = [];
  for (const file of files) {
    const decision = decide(file);
    const exclusion = excluded.find((entry) => entry.glob && entry.re.test(file));
    if (decision.shipped) {
      shipped.set(file, decision.via);
      if (exclusion) {
        problems.push(`${file}: ships through ${decision.via}, but the excluded glob "${exclusion.glob}" also matches it`);
      }
      if (isForbiddenName(path.posix.basename(file))) {
        problems.push(`${file}: ships through ${decision.via}, but the release privacy check rejects its file name`);
      }
      continue;
    }
    if (exclusion && exclusion.reason) continue;
    if (exclusion) {
      problems.push(`${file}: the excluded glob "${exclusion.glob}" has no reason`);
      continue;
    }
    problems.push(`${file}: not shipped (${decision.why}) and no excluded glob with a reason matches it`);
  }
  return { shipped, problems };
}

function isManifestPath(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["the manifest is not a JSON object"];
  if (manifest.schemaVersion !== 1) problems.push(`schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`);
  if (typeof manifest.packageName !== "string" || !PACKAGE_NAME_PATTERN.test(manifest.packageName)) {
    problems.push("packageName must be a plain name such as local-model-service-platform");
  }
  const robocopy = manifest.robocopy || {};
  // syntaxCheck is read by scripts/check-syntax.js, so it is optional here.
  const syntaxCheck = manifest.syntaxCheck;
  const lists = [
    ["directories", manifest.directories, { paths: true }],
    ["files", manifest.files, { paths: true }],
    ["extraFiles", manifest.extraFiles, { paths: true }],
    ["runtimeDataDirectories", manifest.runtimeDataDirectories, { paths: true }],
    ["forceInclude", manifest.forceInclude, {}],
    ["robocopy.excludeDirs", robocopy.excludeDirs, {}],
    ["robocopy.excludeFiles", robocopy.excludeFiles, {}],
    ["syntaxCheck.esmGlobs", syntaxCheck && syntaxCheck.esmGlobs, { optional: !syntaxCheck }],
    ["syntaxCheck.skipGlobs", syntaxCheck && syntaxCheck.skipGlobs, { optional: !syntaxCheck }],
  ];
  for (const [name, value, { paths: isPathList = false, optional = false }] of lists) {
    if (value === undefined && optional) continue;
    if (!Array.isArray(value)) {
      problems.push(`${name} must be an array`);
      continue;
    }
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) problems.push(`${name} holds an empty or non-string entry`);
      else if (isPathList && !isManifestPath(item)) problems.push(`${name} entry "${item}" must be a relative forward-slash path`);
      else if (seen.has(item)) problems.push(`${name} lists "${item}" twice`);
      seen.add(item);
    }
  }
  for (const runtime of list(manifest.runtimeDataDirectories)) {
    if (!list(manifest.directories).some((directory) => isUnder(runtime, directory))) {
      problems.push(`runtimeDataDirectories entry "${runtime}" is not inside a release directory`);
    }
  }
  if (!Array.isArray(manifest.excluded)) {
    problems.push("excluded must be an array of { glob, reason }");
  } else {
    for (const entry of manifest.excluded) {
      if (!entry || typeof entry.glob !== "string" || !entry.glob.trim()) problems.push("an excluded entry has no glob");
      else if (typeof entry.reason !== "string" || !entry.reason.trim()) problems.push(`excluded glob "${entry.glob}" has no reason`);
    }
  }
  return problems;
}

/** Listed files and directories must exist, and README-linked docs must ship as extraFiles. */
function checkListedPaths(manifest, files, root) {
  const problems = [];
  const fileSet = new Set(files);
  for (const key of ["files", "extraFiles"]) {
    for (const file of list(manifest[key])) {
      if (!fileSet.has(file)) problems.push(`${key} lists ${file}, which is not a file in the repository`);
    }
  }
  for (const directory of list(manifest.directories)) {
    const full = path.join(root, directory);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) problems.push(`directories lists ${directory}, which is not a directory`);
    else if (!files.some((file) => isUnder(file, directory))) problems.push(`directories lists ${directory}, which holds no repository file`);
  }
  const readme = path.join(root, "README.md");
  if (fs.existsSync(readme)) {
    const extraFiles = new Set(list(manifest.extraFiles));
    const linked = new Set(Array.from(fs.readFileSync(readme, "utf8").matchAll(README_DOC_LINK), (match) => match[1]));
    for (const doc of linked) {
      if (!extraFiles.has(doc)) problems.push(`README.md links ${doc}, which is missing from extraFiles`);
    }
  }
  return problems;
}

const SHIP_OR_EXCLUDE = "Ship each file through directories, files or extraFiles in release-manifest.json, or add { glob, reason } to excluded.";

function report(title, problems, hint = "") {
  return `${title}\n${problems.map((problem) => `  - ${problem}`).join("\n")}${hint ? `\n${hint}` : ""}`;
}

const scriptText = fs.readFileSync(BUILD_SCRIPT, "utf8");
const forbiddenNameRule = loadForbiddenNameRule(scriptText);
const manifest = readJson(MANIFEST_PATH);
const repositoryFiles = gitFiles(ROOT);
const NOT_GIT = "not a git checkout (an extracted release), so tracked files cannot be listed";

test("release-manifest.json has the schemaVersion 1 shape", () => {
  const problems = validateManifest(manifest);
  assert.deepEqual(problems, [], report("release-manifest.json is malformed:", problems));
  assert.ok(manifest.files.includes("release-manifest.json"), "the manifest ships itself, because the released build script reads it");
});

test("every repository file is shipped or excluded with a reason", (t) => {
  if (!repositoryFiles) return t.skip(NOT_GIT);
  const { problems } = classifyRelease(manifest, repositoryFiles, forbiddenNameRule);
  assert.deepEqual(problems, [], report("release-manifest.json does not account for these files:", problems, SHIP_OR_EXCLUDE));
});

test("every listed file and directory exists and README-linked docs ship", (t) => {
  if (!repositoryFiles) return t.skip(NOT_GIT);
  const problems = checkListedPaths(manifest, repositoryFiles, ROOT);
  assert.deepEqual(problems, [], report("release-manifest.json lists paths that do not hold up:", problems));
});

test("every excluded glob still matches a repository file", (t) => {
  if (!repositoryFiles) return t.skip(NOT_GIT);
  const stale = list(manifest.excluded)
    .filter((entry) => !repositoryFiles.some((file) => globToRegExp(entry.glob).test(file)))
    .map((entry) => `excluded glob "${entry.glob}" matches nothing; remove it`);
  assert.deepEqual(stale, [], stale.join("\n"));
});

test("a new file that is neither shipped nor excluded fails the check", () => {
  const files = ["README.md", "scripts/check-i18n.js", "new-launcher.cmd", "docs/new-guide.md", "manager-core/logs/trace.txt"];
  const base = {
    schemaVersion: 1,
    packageName: "fixture",
    directories: ["manager-core", "scripts"],
    files: ["README.md"],
    extraFiles: [],
    runtimeDataDirectories: [],
    robocopy: manifest.robocopy,
    forceInclude: manifest.forceInclude,
    excluded: [],
  };
  const { shipped, problems } = classifyRelease(base, files, forbiddenNameRule);
  assert.deepEqual(Array.from(shipped.keys()), ["README.md", "scripts/check-i18n.js"]);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^new-launcher\.cmd: not shipped \(it is not in a release directory/);
  assert.match(problems[1], /^docs\/new-guide\.md: not shipped/);
  // A file a robocopy exclude drops inside a release directory must be excluded explicitly.
  assert.match(problems[2], /^manager-core\/logs\/trace\.txt: not shipped \(it is inside manager-core, but robocopy excludes the folder name "logs"\)/);

  const withReasons = {
    ...base,
    files: ["README.md", "new-launcher.cmd"],
    excluded: [
      { glob: "docs/new-guide.md", reason: "internal draft" },
      { glob: "manager-core/logs/**", reason: "" },
    ],
  };
  const second = classifyRelease(withReasons, files, forbiddenNameRule);
  assert.deepEqual(second.problems, ['manager-core/logs/trace.txt: the excluded glob "manager-core/logs/**" has no reason']);
  assert.deepEqual(validateManifest(withReasons), ['excluded glob "manager-core/logs/**" has no reason']);
});

test("a shipped file that an excluded glob also matches is a contradiction", () => {
  const files = ["README.md", "claude-vllm-anthropic-proxy.py"];
  const contradictory = {
    schemaVersion: 1,
    packageName: "fixture",
    directories: [],
    files: ["README.md", "claude-vllm-anthropic-proxy.py"],
    extraFiles: [],
    runtimeDataDirectories: [],
    robocopy: manifest.robocopy,
    forceInclude: [],
    excluded: [{ glob: "claude-vllm-anthropic-proxy.py", reason: "retired" }],
  };
  const { problems } = classifyRelease(contradictory, files, forbiddenNameRule);
  assert.deepEqual(problems, ['claude-vllm-anthropic-proxy.py: ships through files, but the excluded glob "claude-vllm-anthropic-proxy.py" also matches it']);
});

test("forceInclude keeps tracked fixtures that robocopy excludes would drop", () => {
  const files = [
    "manager-core/test/fixtures/logs/run.log",
    "manager-core/test/fixtures/models/card.json",
    "manager-core/test/fixtures/trace.jsonl",
    "manager-core/test/fixtures/.env",
    "manager-core/test/fixtures/sample.env.example",
    "manager-core/tests/fixtures/run.log",
    "manager-core/lib/test/fixtures/run.log",
  ];
  const fixtureManifest = { ...manifest, excluded: [] };
  const { shipped, problems } = classifyRelease(fixtureManifest, files, forbiddenNameRule);
  assert.equal(shipped.get("manager-core/test/fixtures/logs/run.log"), "forceInclude */test/fixtures/**");
  assert.equal(shipped.get("manager-core/test/fixtures/models/card.json"), "forceInclude */test/fixtures/**");
  assert.equal(shipped.get("manager-core/test/fixtures/sample.env.example"), "directory manager-core");
  // Names the privacy check rejects are never force-included, and "*" covers one segment only.
  assert.deepEqual(problems.map((problem) => problem.split(":")[0]), [
    "manager-core/test/fixtures/trace.jsonl",
    "manager-core/test/fixtures/.env",
    "manager-core/tests/fixtures/run.log",
    "manager-core/lib/test/fixtures/run.log",
  ]);
  assert.match(problems[0], /forceInclude skips it because the privacy check rejects its name/);
});

test("manifest globs follow the build script's segment rules", () => {
  const cases = [
    ["*/test/fixtures/**", "manager-core/test/fixtures/a/b.json", true],
    ["*/test/fixtures/**", "Manager-Core/Test/Fixtures/a.json", true],
    ["*/test/fixtures/**", "a/b/test/fixtures/c.json", false],
    ["docs/comprehensive-audit-*.md", "docs/comprehensive-audit-2026-07-16.md", true],
    ["docs/comprehensive-audit-*.md", "docs/sub/comprehensive-audit-1.md", false],
    ["**/*.min.js", "lib.min.js", true],
    ["**/*.min.js", "shared-public/vendor/x/lib.min.js", true],
    ["a/**/b.js", "a/b.js", true],
    ["a/**/b.js", "a/x/y/b.js", true],
    ["a?.md", "ab.md", true],
    ["a?.md", "a/.md", false],
  ];
  for (const [glob, file, expected] of cases) {
    assert.equal(globToRegExp(glob).test(file), expected, `${glob} vs ${file}`);
  }
  assert.ok(wildcardToRegExp("*.db-*").test("billing.DB-wal"));
  assert.ok(wildcardToRegExp(".env.*").test(".env.example"));
  assert.ok(!wildcardToRegExp("*.log").test("log.txt"));
});

test("the forceInclude name filter is the privacy check's rule", () => {
  assert.equal(forbiddenNameRule.copies.length, 2, "build-github-release.ps1 holds the forbidden-name rule in the privacy check and in Test-ReleaseForbiddenName");
  assert.equal(forbiddenNameRule.copies[0], forbiddenNameRule.copies[1]);
  for (const name of [".env", ".env.local", "id_rsa", "x.pem", "billing.sqlite-wal", "ledger.jsonl", "service-api-key.json"]) {
    assert.ok(forbiddenNameRule.isForbiddenName(name), name);
  }
  for (const name of [".env.example", "run.log", "card.json"]) {
    assert.ok(!forbiddenNameRule.isForbiddenName(name), name);
  }
});

// Windows PowerShell 5.1 started below a pwsh 7 session (pwsh > cmd > npm >
// node) inherits pwsh's PSModulePath and then cannot load its own utility
// module (Get-FileHash goes missing). Without the variable it builds its
// default module path, as it does when started from Explorer or cmd.
function windowsPowerShellEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
}

function hasWindowsPowerShell() {
  if (process.platform !== "win32") return false;
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"], { env: windowsPowerShellEnv(), windowsHide: true, timeout: 60000 });
  return !probe.error && probe.status === 0;
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, ...relativePath.split("/"));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf8");
}

function listFiles(root) {
  const files = [];
  const pending = [""];
  while (pending.length) {
    const relativeDir = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pending.push(relativePath);
      else files.push(relativePath);
    }
  }
  return files.sort();
}

test("the release build ships a tracked fixture through forceInclude", { timeout: 180000, skip: !hasWindowsPowerShell() && "the release build needs Windows PowerShell and robocopy" }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "release-manifest-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  const out = path.join(base, "out");

  const fixtureManifest = {
    schemaVersion: 1,
    packageName: "fixture-platform",
    directories: ["pkg"],
    files: [".gitignore", "README.md", "package.json", "release-manifest.json", "build-github-release.ps1"],
    extraFiles: [],
    runtimeDataDirectories: ["pkg/data"],
    robocopy: manifest.robocopy,
    forceInclude: manifest.forceInclude,
    excluded: [
      { glob: "pkg/data/**", reason: "runtime data" },
      { glob: "pkg/test/fixtures/trace.jsonl", reason: "the privacy check rejects .jsonl names" },
      { glob: "pkg/test/fixtures/.env", reason: "env files never ship" },
      { glob: "pkg/tests/fixtures/**", reason: "outside the forceInclude glob" },
    ],
  };
  await writeFile(repo, ".gitignore", "*.log\nlogs/\n");
  await writeFile(repo, "README.md", "# Fixture release\n");
  await writeFile(repo, "package.json", `${JSON.stringify({ name: "fixture", version: "0.0.1" })}\n`);
  await writeFile(repo, "release-manifest.json", `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  await fsp.copyFile(BUILD_SCRIPT, path.join(repo, "build-github-release.ps1"));
  await writeFile(repo, "pkg/index.js", "module.exports = {};\n");
  await writeFile(repo, "pkg/data/state.json", "{}\n");
  await writeFile(repo, "pkg/logs/runtime.txt", "untracked runtime log\n");
  await writeFile(repo, "pkg/test/fixtures/plain.json", "{}\n");
  await writeFile(repo, "pkg/test/fixtures/logs/sample.log", "fixture log line\n");
  await writeFile(repo, "pkg/test/fixtures/cache/entry.json", "{\"cached\":true}\n");
  await writeFile(repo, "pkg/test/fixtures/trace.jsonl", "{}\n");
  await writeFile(repo, "pkg/test/fixtures/.env", "FIXTURE_ONLY=1\n");
  await writeFile(repo, "pkg/test/fixtures/stray.log", "ignored and untracked\n");
  await writeFile(repo, "pkg/tests/fixtures/other.log", "not under a test/fixtures folder\n");

  const git = (...args) => spawnSync("git", ["-C", repo, "-c", "core.autocrlf=false", ...args], { encoding: "utf8", windowsHide: true });
  const init = git("init", "-q");
  if (init.error || init.status !== 0) return t.skip("git is not available");
  assert.equal(git("add", "-A").status, 0);
  // Tracked on purpose although .gitignore matches some of them, like a real
  // fixture added with -f (-f also keeps a global excludes file out of the way).
  const trackedFixtures = [
    "pkg/test/fixtures/logs/sample.log",
    "pkg/test/fixtures/cache/entry.json",
    "pkg/test/fixtures/trace.jsonl",
    "pkg/test/fixtures/.env",
    "pkg/tests/fixtures/other.log",
  ];
  assert.equal(git("add", "-f", ...trackedFixtures).status, 0);

  const tracked = gitFiles(repo);
  assert.ok(tracked.includes("pkg/test/fixtures/logs/sample.log"));
  assert.ok(!tracked.includes("pkg/test/fixtures/stray.log"));
  const model = classifyRelease(fixtureManifest, tracked, forbiddenNameRule);
  assert.deepEqual(model.problems, []);

  const build = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "build-github-release.ps1"),
    "-Version", "0.0.1", "-OutputDirectory", out,
  ], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true, timeout: 170000 });
  assert.equal(build.status, 0, `release build failed:\n${build.stdout}\n${build.stderr}`);
  assert.match(build.stdout, /Not force-including pkg\/test\/fixtures\/trace\.jsonl/);
  assert.match(build.stdout, /Force-included 2 fixture file\(s\)/);

  const staged = listFiles(path.join(out, "fixture-platform-v0.0.1"));
  assert.ok(staged.includes("pkg/test/fixtures/logs/sample.log"), "a tracked fixture under logs/ named *.log ships");
  assert.ok(staged.includes("pkg/test/fixtures/cache/entry.json"), "a tracked fixture under cache/ ships");
  for (const file of ["pkg/test/fixtures/trace.jsonl", "pkg/test/fixtures/.env", "pkg/test/fixtures/stray.log", "pkg/tests/fixtures/other.log", "pkg/logs/runtime.txt", "pkg/data/state.json"]) {
    assert.ok(!staged.includes(file), `${file} must not ship`);
  }
  // The model and the real build agree file for file.
  assert.deepEqual(staged, [...model.shipped.keys(), "RELEASE-MANIFEST.md"].sort());
  const releaseNotes = fs.readFileSync(path.join(out, "fixture-platform-v0.0.1", "RELEASE-MANIFEST.md"), "utf8");
  assert.match(releaseNotes, /release-manifest\.json \(schemaVersion 1\)/);
  assert.ok(fs.existsSync(path.join(out, "fixture-platform-v0.0.1.zip")));
});
