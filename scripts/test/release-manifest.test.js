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

/**
 * The privacy check's content rule (identity needles and credential patterns),
 * read from the build script. The script carries both lists twice (the privacy
 * check, and the forceInclude filter that reads every candidate as text); the
 * copies must be identical. forRoot(root) returns file -> true when the build
 * would refuse to force-include that file.
 */
function loadForbiddenContentRule(scriptText) {
  const copiesOf = (name) => Array.from(
    scriptText.matchAll(new RegExp(`\\$(?:forceInclude)?${name} = @\\(\\r?\\n([\\s\\S]*?)\\r?\\n\\)`, "g")),
    (match) => match[1].split(/\r?\n/).map((line) => line.trim().replace(/,$/, "")).filter(Boolean),
  );
  const needleCopies = copiesOf("[Ii]dentityNeedles");
  const patternCopies = copiesOf("[Cc]redentialPatterns");
  // PowerShell -match ignores case; the patterns are single-quoted literals.
  const patterns = (patternCopies[0] || []).map((item) => new RegExp(item.replace(/^'|'$/g, "").replace(/''/g, "'"), "i"));
  function needlesFor(root) {
    return (needleCopies[0] || []).map((item) => {
      const variable = /^\$env:(\w+)$/.exec(item);
      if (variable) return process.env[variable[1]];
      if (item === "$projectRoot") return root;
      throw new Error(`the release-manifest test does not know the privacy needle ${item}`);
    }).filter((needle) => needle && needle.trim()).map((needle) => needle.toLowerCase());
  }
  function forRoot(root) {
    const needles = needlesFor(root);
    return (file) => {
      const bytes = fs.readFileSync(path.join(root, ...file.split("/")));
      const texts = [bytes.toString("utf8"), bytes.toString("latin1")];
      if (bytes[0] === 0xff && bytes[1] === 0xfe) texts.push(bytes.toString("utf16le"));
      return texts.some((text) => {
        const lower = text.toLowerCase();
        return needles.some((needle) => lower.includes(needle)) || patterns.some((pattern) => pattern.test(text));
      });
    };
  }
  return { needleCopies, patternCopies, forRoot };
}

/** Tracked plus untracked-but-not-ignored files that exist on disk, or null when git fails. */
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
 * The repository checks need the source repository's file list, so they run
 * only at the top of a git work tree that is not a built release. Every build
 * writes RELEASE-MANIFEST.md at the release root and the source repository
 * never has one, so it marks a built or extracted release even under git (the
 * public GitHub repository is the staged tree under git). A release unpacked
 * in an ignored folder of another work tree is not that work tree's top, and
 * git would list nothing there. Returns { files }, { skip } with a note, or
 * { error } when the root holds .git but git cannot list it.
 */
function sourceRepositoryFiles(root) {
  if (fs.existsSync(path.join(root, "RELEASE-MANIFEST.md"))) {
    return { skip: "a built release (RELEASE-MANIFEST.md is at its root), not the source repository" };
  }
  const prefix = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], { encoding: "utf8", windowsHide: true });
  if (prefix.error || prefix.status !== 0) {
    if (fs.existsSync(path.join(root, ".git"))) {
      return { error: `git cannot read the work tree at the repository root: ${prefix.error ? prefix.error.message : String(prefix.stderr).trim()}` };
    }
    return { skip: "not a git checkout (an extracted release), so tracked files cannot be listed" };
  }
  const nested = prefix.stdout.trim();
  if (nested) return { skip: `an extracted release at ${nested} inside another git work tree, not the source repository` };
  const files = gitFiles(root);
  return files ? { files } : { error: "git ls-files failed at the top of the source repository" };
}

/** The privacy rules the forceInclude step applies to files under root. */
function privacyRulesFor(root) {
  return { isForbiddenName: forbiddenNameRule.isForbiddenName, hasForbiddenContent: forbiddenContentRule.forRoot(root) };
}

/**
 * Decides, for every file, what the build does with it and reports the files
 * the manifest does not account for. Returns { shipped: Map(file -> via), problems }.
 */
function classifyRelease(manifest, files, { isForbiddenName = () => false, hasForbiddenContent = () => false } = {}) {
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
    if (!force) return { shipped: false, why: `it is inside ${directory}, but ${dropped}` };
    if (isForbiddenName(name)) return { shipped: false, why: `${dropped}, and forceInclude skips it because the privacy check rejects its name` };
    if (hasForbiddenContent(file)) return { shipped: false, why: `${dropped}, and forceInclude skips it because the privacy check rejects its content` };
    return { shipped: true, via: `forceInclude ${force.glob}` };
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
const forbiddenContentRule = loadForbiddenContentRule(scriptText);
const manifest = readJson(MANIFEST_PATH);
const repository = sourceRepositoryFiles(ROOT);

/** The source repository's files, or null after skipping the test with a note. */
function repositoryFilesOrSkip(t) {
  if (repository.error) assert.fail(repository.error);
  if (repository.skip) {
    t.skip(repository.skip);
    return null;
  }
  return repository.files;
}

test("release-manifest.json has the schemaVersion 1 shape", () => {
  const problems = validateManifest(manifest);
  assert.deepEqual(problems, [], report("release-manifest.json is malformed:", problems));
  assert.ok(manifest.files.includes("release-manifest.json"), "the manifest ships itself, because the released build script reads it");
});

test("every repository file is shipped or excluded with a reason", (t) => {
  const repositoryFiles = repositoryFilesOrSkip(t);
  if (!repositoryFiles) return;
  const { problems } = classifyRelease(manifest, repositoryFiles, privacyRulesFor(ROOT));
  assert.deepEqual(problems, [], report("release-manifest.json does not account for these files:", problems, SHIP_OR_EXCLUDE));
});

test("every listed file and directory exists and README-linked docs ship", (t) => {
  const repositoryFiles = repositoryFilesOrSkip(t);
  if (!repositoryFiles) return;
  const problems = checkListedPaths(manifest, repositoryFiles, ROOT);
  assert.deepEqual(problems, [], report("release-manifest.json lists paths that do not hold up:", problems));
});

test("every excluded glob still matches a repository file", (t) => {
  const repositoryFiles = repositoryFilesOrSkip(t);
  if (!repositoryFiles) return;
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
    "manager-core/test/fixtures/logs/leaky.log",
    "manager-core/test/fixtures/leaky.json",
    "manager-core/tests/fixtures/run.log",
    "manager-core/lib/test/fixtures/run.log",
  ];
  const fixtureManifest = { ...manifest, excluded: [] };
  const hasForbiddenContent = (file) => path.posix.basename(file).startsWith("leaky.");
  const { shipped, problems } = classifyRelease(fixtureManifest, files, { ...forbiddenNameRule, hasForbiddenContent });
  assert.equal(shipped.get("manager-core/test/fixtures/logs/run.log"), "forceInclude */test/fixtures/**");
  assert.equal(shipped.get("manager-core/test/fixtures/models/card.json"), "forceInclude */test/fixtures/**");
  assert.equal(shipped.get("manager-core/test/fixtures/sample.env.example"), "directory manager-core");
  // A file robocopy keeps goes through the unchanged privacy scan instead.
  assert.equal(shipped.get("manager-core/test/fixtures/leaky.json"), "directory manager-core");
  // Names or contents the privacy check rejects are never force-included, and "*" covers one segment only.
  assert.deepEqual(problems.map((problem) => problem.split(":")[0]), [
    "manager-core/test/fixtures/trace.jsonl",
    "manager-core/test/fixtures/.env",
    "manager-core/test/fixtures/logs/leaky.log",
    "manager-core/tests/fixtures/run.log",
    "manager-core/lib/test/fixtures/run.log",
  ]);
  assert.match(problems[0], /forceInclude skips it because the privacy check rejects its name/);
  assert.match(problems[2], /forceInclude skips it because the privacy check rejects its content/);
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

// Fake credentials are assembled at run time, so no tracked file holds a
// credential-shaped string that the release privacy scan would reject.
const FAKE_OPENAI_KEY = ["sk", "FAKEFAKEFAKEFAKEFAKEFAKE0000"].join("-");
const FAKE_AWS_KEY_ID = ["AKIA", "FAKEFAKEFAKEFAKE"].join("");

test("the forceInclude content filter is the privacy check's rule", async (t) => {
  const { needleCopies, patternCopies } = forbiddenContentRule;
  assert.equal(needleCopies.length, 2, "build-github-release.ps1 holds the identity needles in the privacy check and in the forceInclude filter");
  assert.equal(patternCopies.length, 2, "build-github-release.ps1 holds the credential patterns in the privacy check and in the forceInclude filter");
  assert.deepEqual(needleCopies[1], needleCopies[0]);
  assert.deepEqual(patternCopies[1], patternCopies[0]);
  assert.ok(needleCopies[0].includes("$projectRoot") && patternCopies[0].length >= 6);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "release-content-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await writeFile(root, "fixtures/clean.log", "INFO started\n");
  await writeFile(root, "fixtures/key.log", `INFO key=${FAKE_OPENAI_KEY}\n`);
  await writeFile(root, "fixtures/aws.tmp", `id=${FAKE_AWS_KEY_ID.toLowerCase()}\n`);
  await writeFile(root, "fixtures/root.log", `cwd=${path.join(root, "pkg")}\n`);
  await fsp.writeFile(path.join(root, "fixtures", "wide.txt"), Buffer.from(`\uFEFFkey=${FAKE_OPENAI_KEY}\n`, "utf16le"));
  const hasForbiddenContent = forbiddenContentRule.forRoot(root);
  assert.equal(hasForbiddenContent("fixtures/clean.log"), false);
  assert.equal(hasForbiddenContent("fixtures/key.log"), true);
  assert.equal(hasForbiddenContent("fixtures/aws.tmp"), true, "PowerShell -match ignores case");
  assert.equal(hasForbiddenContent("fixtures/root.log"), true, "the project root is an identity needle");
  assert.equal(hasForbiddenContent("fixtures/wide.txt"), true, "UTF-16 text is read too");
});

test("the repository checks run only at the top of the source repository", async (t) => {
  const probe = spawnSync("git", ["--version"], { windowsHide: true });
  if (probe.error || probe.status !== 0) return t.skip("git is not available");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "release-source-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, "-c", "core.autocrlf=false", ...args], { encoding: "utf8", windowsHide: true });

  // The top of a work tree that is not a built release: its files are listed.
  const source = path.join(base, "source");
  await writeFile(source, ".gitignore", "artifacts/\n");
  await writeFile(source, "README.md", "# Source\n");
  assert.equal(git(source, "init", "-q").status, 0);
  assert.equal(git(source, "add", "-A").status, 0);
  assert.deepEqual(sourceRepositoryFiles(source), { files: [".gitignore", "README.md"] });

  // A release unpacked in that work tree's ignored artifacts folder, where git lists nothing.
  const extract = path.join(source, "artifacts", "extract", "fixture-v0.0.1");
  await writeFile(extract, "README.md", "# Release\n");
  assert.deepEqual(gitFiles(extract), []);
  assert.match(String(sourceRepositoryFiles(extract).skip), /^an extracted release at artifacts\/extract\/fixture-v0\.0\.1\/ inside another git work tree/);

  // A built release under git, like the public GitHub repository.
  const published = path.join(base, "published");
  await writeFile(published, "README.md", "# Release\n");
  await writeFile(published, "RELEASE-MANIFEST.md", "# Release Manifest\n");
  assert.equal(git(published, "init", "-q").status, 0);
  assert.equal(git(published, "add", "-A").status, 0);
  assert.match(String(sourceRepositoryFiles(published).skip), /^a built release/);

  // A .git that git cannot read is an error, never a silent skip.
  const broken = path.join(base, "broken");
  await writeFile(broken, "README.md", "# Broken\n");
  await writeFile(broken, ".git", "gitdir: missing-git-dir\n");
  assert.match(String(sourceRepositoryFiles(broken).error), /^git cannot read the work tree at the repository root/);
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

function runReleaseBuild(scriptPath, out) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-Version", "0.0.1", "-OutputDirectory", out,
  ], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true, timeout: 120000 });
}

test("the release build ships a tracked fixture through forceInclude", { timeout: 300000, skip: !hasWindowsPowerShell() && "the release build needs Windows PowerShell and robocopy" }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "release-manifest-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  // The default output folder: inside the project, in a folder git ignores.
  const out = path.join(repo, "artifacts", "github-release");
  const machineName = process.env.COMPUTERNAME;
  assert.ok(machineName, "Windows sets COMPUTERNAME");

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
      { glob: "pkg/test/fixtures/*/leaky.*", reason: "holds a fake credential, so the privacy check rejects its content" },
      { glob: "pkg/test/fixtures/logs/host.tmp", reason: "names this machine, so the privacy check rejects its content" },
      { glob: "pkg/tests/fixtures/**", reason: "outside the forceInclude glob" },
    ],
  };
  await writeFile(repo, ".gitignore", "*.log\nlogs/\nartifacts/\n");
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
  // Robocopy drops these and the privacy check only reads known text
  // extensions, so the forceInclude filter itself must reject their content.
  await writeFile(repo, "pkg/test/fixtures/logs/leaky.log", `INFO key=${FAKE_OPENAI_KEY}\n`);
  await writeFile(repo, "pkg/test/fixtures/cache/leaky.json", `{"key":"${FAKE_OPENAI_KEY}"}\n`);
  await writeFile(repo, "pkg/test/fixtures/logs/host.tmp", `host=${machineName}\n`);
  await writeFile(repo, "pkg/test/fixtures/stray.log", "ignored and untracked\n");
  await writeFile(repo, "pkg/tests/fixtures/other.log", "not under a test/fixtures folder\n");

  const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, "-c", "core.autocrlf=false", ...args], { encoding: "utf8", windowsHide: true });
  const init = git(repo, "init", "-q");
  if (init.error || init.status !== 0) return t.skip("git is not available");
  assert.equal(git(repo, "add", "-A").status, 0);
  // Tracked on purpose although .gitignore matches some of them, like a real
  // fixture added with -f (-f also keeps a global excludes file out of the way).
  const trackedFixtures = [
    "pkg/test/fixtures/logs/sample.log",
    "pkg/test/fixtures/cache/entry.json",
    "pkg/test/fixtures/trace.jsonl",
    "pkg/test/fixtures/.env",
    "pkg/test/fixtures/logs/leaky.log",
    "pkg/test/fixtures/cache/leaky.json",
    "pkg/test/fixtures/logs/host.tmp",
    "pkg/tests/fixtures/other.log",
  ];
  assert.equal(git(repo, "add", "-f", ...trackedFixtures).status, 0);

  const tracked = gitFiles(repo);
  assert.ok(tracked.includes("pkg/test/fixtures/logs/sample.log"));
  assert.ok(!tracked.includes("pkg/test/fixtures/stray.log"));
  const model = classifyRelease(fixtureManifest, tracked, privacyRulesFor(repo));
  assert.deepEqual(model.problems, []);

  const build = runReleaseBuild(path.join(repo, "build-github-release.ps1"), out);
  assert.equal(build.status, 0, `release build failed:\n${build.stdout}\n${build.stderr}`);
  assert.match(build.stdout, /forceInclude candidates come from git ls-files\./);
  assert.match(build.stdout, /Not force-including pkg\/test\/fixtures\/trace\.jsonl: the privacy check rejects this file name/);
  for (const file of ["logs/leaky.log", "cache/leaky.json", "logs/host.tmp"]) {
    assert.ok(build.stdout.includes(`Not force-including pkg/test/fixtures/${file}: the privacy check rejects its content.`), file);
  }
  assert.ok(!build.stdout.includes(FAKE_OPENAI_KEY), "the build never prints what it rejected");
  assert.match(build.stdout, /Force-included 2 fixture file\(s\)/);

  const stagedRoot = path.join(out, "fixture-platform-v0.0.1");
  const staged = listFiles(stagedRoot);
  assert.ok(staged.includes("pkg/test/fixtures/logs/sample.log"), "a tracked fixture under logs/ named *.log ships");
  assert.ok(staged.includes("pkg/test/fixtures/cache/entry.json"), "a tracked fixture under cache/ ships");
  for (const file of [
    "pkg/test/fixtures/trace.jsonl", "pkg/test/fixtures/.env", "pkg/test/fixtures/logs/leaky.log", "pkg/test/fixtures/cache/leaky.json",
    "pkg/test/fixtures/logs/host.tmp", "pkg/test/fixtures/stray.log", "pkg/tests/fixtures/other.log", "pkg/logs/runtime.txt", "pkg/data/state.json",
  ]) {
    assert.ok(!staged.includes(file), `${file} must not ship`);
  }
  // The model and the real build agree file for file.
  assert.deepEqual(staged, [...model.shipped.keys(), "RELEASE-MANIFEST.md"].sort());
  const releaseNotes = fs.readFileSync(path.join(stagedRoot, "RELEASE-MANIFEST.md"), "utf8");
  assert.match(releaseNotes, /release-manifest\.json \(schemaVersion 1\)/);
  assert.ok(fs.existsSync(path.join(out, "fixture-platform-v0.0.1.zip")));

  // The repository checks skip in the staged release and in a git-initialised
  // copy of it (the public GitHub repository), whose tracked files are release files.
  assert.match(String(sourceRepositoryFiles(stagedRoot).skip), /^a built release/);
  const published = path.join(base, "published");
  await fsp.cp(stagedRoot, published, { recursive: true });
  assert.equal(git(published, "init", "-q").status, 0);
  assert.equal(git(published, "add", "-A").status, 0);
  assert.ok(gitFiles(published).includes("RELEASE-MANIFEST.md"));
  assert.match(String(sourceRepositoryFiles(published).skip), /^a built release/);

  // Rebuilding from the staged release, which sits in an ignored folder of the
  // fixture work tree where git lists nothing, walks the release directories
  // and ships the same files. The walk does not follow a junction, so a log
  // outside the project that robocopy drops is not force-included either.
  await writeFile(base, "outside/linked.log", "outside the project\n");
  fs.symlinkSync(path.join(base, "outside"), path.join(stagedRoot, "pkg", "test", "fixtures", "linked"), "junction");
  const rebuild = runReleaseBuild(path.join(stagedRoot, "build-github-release.ps1"), path.join(base, "rebuild"));
  assert.equal(rebuild.status, 0, `rebuild failed:\n${rebuild.stdout}\n${rebuild.stderr}`);
  assert.match(rebuild.stdout, /forceInclude candidates come from a walk of the release directories \(inside another git work tree at artifacts\/github-release\/fixture-platform-v0\.0\.1\/\)\./);
  assert.match(rebuild.stdout, /Force-included 2 fixture file\(s\)/);
  assert.deepEqual(listFiles(path.join(base, "rebuild", "fixture-platform-v0.0.1")), staged);

  async function copyProject(name) {
    const target = path.join(base, name);
    for (const file of [".gitignore", "README.md", "package.json", "release-manifest.json", "build-github-release.ps1", "pkg/index.js"]) {
      await fsp.mkdir(path.dirname(path.join(target, file)), { recursive: true });
      await fsp.copyFile(path.join(repo, file), path.join(target, file));
    }
    return target;
  }

  // A work tree whose git cannot run stops the build instead of walking it.
  const broken = await copyProject("broken");
  await writeFile(broken, ".git", "gitdir: missing-git-dir\n");
  const failed = runReleaseBuild(path.join(broken, "build-github-release.ps1"), path.join(base, "broken-out"));
  assert.notEqual(failed.status, 0, "a broken work tree must fail the build");
  assert.match(`${failed.stdout}\n${failed.stderr}`, /forceInclude\s+could\s+not\s+list\s+the\s+files\s+of\s+this\s+git\s+work\s+tree/);
  assert.ok(!fs.existsSync(path.join(base, "broken-out", "fixture-platform-v0.0.1.zip")));

  // A manifest path that leaves the project is refused before anything is copied.
  const escaping = await copyProject("escaping");
  await writeFile(base, "outside.txt", "outside the project\n");
  await writeFile(escaping, "release-manifest.json", `${JSON.stringify({ ...fixtureManifest, files: [...fixtureManifest.files, "../outside.txt"] }, null, 2)}\n`);
  const refused = runReleaseBuild(path.join(escaping, "build-github-release.ps1"), path.join(base, "escaping-out"));
  assert.notEqual(refused.status, 0, "a manifest path outside the project must fail the build");
  assert.match(`${refused.stdout}\n${refused.stderr}`, /files\s+entry\s+must\s+be\s+a\s+relative\s+forward-slash\s+path\s+inside\s+the\s+project/);
  assert.ok(!fs.existsSync(path.join(base, "escaping-out", "fixture-platform-v0.0.1")));
});
