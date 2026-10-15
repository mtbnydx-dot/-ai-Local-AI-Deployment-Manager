"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// D5 (00 §1, §9.11; 01-engines §26, ENG-23): model knowledge is layered data,
// so the code keeps no model-family branches. This is the single guard test
// and fixtures/family-branch-allowlist.json its single allowlist. Every hit of
// a pattern in the scope needs an allowlist entry for that file and pattern
// whose count is exactly the number of hits, with an owner, a reason and an
// expiry that has not passed. A new branch fails here, and so does a stale or
// expired entry.
//
// 02 MOD-21 appended its name-inference tokens (FAMILY_TOKENS) and the entry
// and shared browser scopes to SCOPES; the allowlist holds no entry for them.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ALLOWLIST_FILE = path.join(__dirname, "fixtures", "family-branch-allowlist.json");

// Each pattern is a literal token; the allowlist names it by this id.
const PATTERNS = [
  "isQwen3",
  "isPennyroyal",
  "isDiffusionGemma",
  "flashNext",
  "museGlimmer",
  "=== \"sglang\"",
  "=== \"vllm\"",
  "=== \"llama\"",
  "supportsB10630",
].map((id) => ({ id, regex: new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") }));

// 02 MOD-21: the model-family tokens of name inference (02-models §20). Each is
// a case-insensitive regex source, and the allowlist names it by that source.
// A token is a hit only where code decides on a model name: inside a regex
// literal or a new RegExp(...) source string, and inside a string literal that
// is compared (an equality on either side, a case label, or the argument of
// includes, startsWith, endsWith, indexOf, lastIndexOf, has, match or search).
// The same word in a message, a label, a table key or a comment is not a hit.
// 02 takes no allowlist entry for these tokens: model names are matched by the
// families data (match.namePatterns), never by code.
const FAMILY_TOKENS = [
  "qwen\\d",
  "deepseek",
  "gemma",
  "glm",
  "kimi",
  "mistral",
  "llama3",
  "gpt-oss",
  "nemotron",
  "muse",
  "flash.?next",
  "dspark",
  "pennyroyal",
].map((id) => ({ id, regex: new RegExp(id, "gi") }));

const STRING_LITERAL = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + "`(?:\\\\.|[^`\\\\\\n])*`";
// A slash that starts an expression (after an operator, a bracket, return or
// an arrow) opens a regex literal; a slash after a value is a division.
const REGEX_LITERAL = /(?:^|[=(,:[!&|?{};>]|\breturn|\btypeof)\s*(\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuvy]*)/g;
const COMPARED_STRING = new RegExp(String.raw`(?:[!=]==?\s*|\.(?:includes|startsWith|endsWith|indexOf|lastIndexOf|has|match|search)\(\s*|\bcase\s+|\bnew RegExp\(\s*)(${STRING_LITERAL})|(${STRING_LITERAL})\s*[!=]==?`, "g");

// Where the guard looks: a directory scanned recursively (skipping
// node_modules and the named subdirectories) or its own *.js files only,
// minus the files that hold the legacy name tables by design. A scope marked
// familyTokensOnly is scanned for FAMILY_TOKENS alone: the entry and the shared
// browser scripts dispatch on manager ids ("vllm", "llama") by design.
const SCOPES = [
  { dir: "manager-core", recursive: true, skipDirs: ["test"], exclude: ["manager-core/engines/legacy-aliases.js", "manager-core/engines/registry.js"] },
  { files: ["vllm-manager/server.js"] },
  { dir: "vllm-manager/lib" },
  { files: ["llama-manager/server.js"] },
  { dir: "llama-manager/lib" },
  { dir: "service-entry/lib", recursive: true, familyTokensOnly: true },
  { dir: "shared-public/js", recursive: true, familyTokensOnly: true, exclude: ["shared-public/js/lucide.min.js"] },
];

const toPosix = (file) => file.split(path.sep).join("/");

// skipDirs apply to the directory's own subdirectories; suffix narrows the files.
function listJs(dir, { recursive = false, skipDirs = [], suffix = ".js" } = {}) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive && entry.name !== "node_modules" && !skipDirs.includes(entry.name)) out.push(...listJs(rel, { recursive, suffix }));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(rel);
    }
  }
  return out;
}

// file -> true when only FAMILY_TOKENS apply to it.
function scopeMap() {
  const files = new Map();
  for (const scope of SCOPES) {
    const listed = scope.files || listJs(scope.dir, scope);
    for (const file of listed) {
      if ((scope.exclude || []).includes(file)) continue;
      const key = toPosix(file);
      files.set(key, Boolean(scope.familyTokensOnly) && files.get(key) !== false);
    }
  }
  return files;
}

function scopeFiles() {
  return [...scopeMap().keys()].sort();
}

// The regex literals and compared string literals of one source text; comment
// lines are skipped.
function decidingLiterals(text) {
  const literals = [];
  for (const line of text.split("\n")) {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    for (const match of line.matchAll(REGEX_LITERAL)) literals.push(match[1]);
    for (const match of line.matchAll(COMPARED_STRING)) literals.push(match[1] || match[2]);
  }
  return literals;
}

// pattern id -> number of hits in one source text.
function countHits(text, { familyTokensOnly = false } = {}) {
  const counts = new Map();
  if (!familyTokensOnly) {
    for (const pattern of PATTERNS) {
      const count = (text.match(pattern.regex) || []).length;
      if (count) counts.set(pattern.id, count);
    }
  }
  for (const literal of decidingLiterals(text)) {
    for (const token of FAMILY_TOKENS) {
      const count = (literal.match(token.regex) || []).length;
      if (count) counts.set(token.id, (counts.get(token.id) || 0) + count);
    }
  }
  return counts;
}

// "file\u0000pattern" -> number of hits.
function scanHits(files) {
  const scopes = scopeMap();
  const hits = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const [id, count] of countHits(text, { familyTokensOnly: scopes.get(file) })) hits.set(`${file}\u0000${id}`, count);
  }
  return hits;
}

function readAllowlist() {
  return JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

test("the scope holds the managers and manager-core, and every scanned file exists", () => {
  const files = scopeFiles();
  for (const file of ["vllm-manager/server.js", "llama-manager/server.js", "manager-core/engines/recipes.js", "manager-core/engines/adapters/sglang.js", "vllm-manager/lib/pennyroyal.js", "service-entry/lib/model-fleet.js", "shared-public/js/i18n-common.js"]) {
    assert.ok(files.includes(file), file);
  }
  assert.equal(files.includes("shared-public/js/lucide.min.js"), false);
  const scopes = scopeMap();
  assert.equal(scopes.get("service-entry/lib/model-fleet.js"), true);
  assert.equal(scopes.get("vllm-manager/server.js"), false);
  assert.equal(files.some((file) => file.startsWith("manager-core/test/")), false);
  assert.equal(files.includes("manager-core/engines/legacy-aliases.js"), false);
  assert.equal(files.includes("manager-core/engines/registry.js"), false);
});

test("the allowlist is well formed: owner, reason and an unexpired expiry per file and pattern", () => {
  const allowlist = readAllowlist();
  assert.equal(allowlist.schemaVersion, 1);
  assert.ok(Array.isArray(allowlist.entries));
  const files = new Set(scopeFiles());
  const patterns = new Set([...PATTERNS, ...FAMILY_TOKENS].map((pattern) => pattern.id));
  const seen = new Set();
  for (const entry of allowlist.entries) {
    const label = `${entry.file} ${entry.pattern}`;
    assert.deepEqual(Object.keys(entry).sort(), ["count", "expires", "file", "owner", "pattern", "reason"], label);
    assert.ok(files.has(entry.file), `${label}: the file is not in the guard's scope`);
    assert.ok(patterns.has(entry.pattern), `${label}: unknown pattern`);
    assert.ok(Number.isInteger(entry.count) && entry.count > 0, `${label}: count`);
    assert.ok(typeof entry.owner === "string" && entry.owner.trim(), `${label}: owner`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length >= 20, `${label}: a reason is required`);
    assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/, `${label}: expires is YYYY-MM-DD`);
    assert.ok(entry.expires >= today(), `${label}: the entry expired on ${entry.expires}; remove the branch or renew it with a reason`);
    const key = `${entry.file}\u0000${entry.pattern}`;
    assert.equal(seen.has(key), false, `${label}: listed twice`);
    seen.add(key);
  }
});

test("no model-family branch outside the allowlist, and no stale allowlist entry", () => {
  const hits = scanHits(scopeFiles());
  const allowed = new Map(readAllowlist().entries.map((entry) => [`${entry.file}\u0000${entry.pattern}`, entry.count]));
  const problems = [];
  for (const [key, count] of hits) {
    const [file, pattern] = key.split("\u0000");
    const limit = allowed.get(key) || 0;
    if (count > limit) problems.push(`${file}: ${count} × ${pattern} (allowlisted ${limit})`);
  }
  for (const [key, count] of allowed) {
    const [file, pattern] = key.split("\u0000");
    const actual = hits.get(key) || 0;
    if (actual < count) problems.push(`${file}: the allowlist expects ${count} × ${pattern} but finds ${actual}; lower or remove the entry`);
  }
  assert.deepEqual(problems, []);
});

test("the vLLM and llama.cpp manager entry points and the engine adapters carry no allowlisted branch", () => {
  const allowed = readAllowlist().entries.map((entry) => entry.file);
  for (const file of ["vllm-manager/server.js", "llama-manager/server.js", "vllm-manager/lib/pennyroyal.js"]) {
    assert.equal(allowed.includes(file), false, file);
  }
  assert.equal(allowed.some((file) => file.startsWith("manager-core/engines/")), false);
});

test("each pattern finds the branches it stands for, and only those", () => {
  const quote = String.fromCharCode(34);
  const sample = [
    "if (isQwen38Model(model)) {}",
    "const pennyroyal = isPennyroyalImage(image);",
    "if (isDiffusionGemmaModel(model, config)) {}",
    "const flashNext = matches(model);",
    "if (museGlimmer) {}",
    `if (engine === ${quote}sglang${quote}) {}`,
    `if (engine === ${quote}vllm${quote} || other === ${quote}vllm${quote}) {}`,
    `const llama = engine === ${quote}llama${quote};`,
    "if (supportsB10630Controls(image)) {}",
  ].join("\n");
  const counts = countHits(sample);
  assert.deepEqual(
    PATTERNS.map((pattern) => [pattern.id, counts.get(pattern.id)]),
    PATTERNS.map((pattern) => [pattern.id, pattern.id.includes("vllm") ? 2 : 1]),
  );
  // An engine id looked up in a table, a config slot that names an image and
  // a comparison with a named constant are not hits.
  assert.equal(countHits("const image = { sglang: CONFIG.sglangImage }[engineId]; CONFIG.sglangFlashNextImage; if (engine === ENGINE) {}").size, 0);
});

test("02's family tokens have no allowlist entry: model names are matched by data, not code", () => {
  const tokens = new Set(FAMILY_TOKENS.map((token) => token.id));
  assert.deepEqual(readAllowlist().entries.filter((entry) => tokens.has(entry.pattern)).map((entry) => `${entry.file} ${entry.pattern}`), []);
});

test("each family token finds name inference in regex literals and compared strings, and only there", () => {
  const quote = String.fromCharCode(34);
  const q = (text) => `${quote}${text}${quote}`;
  const sample = [
    "if (/qwen3_(?:5|6|8)/i.test(model)) {}",
    `if (text.includes(${q("deepseek-r1")}) || text.includes(${q("deepseek")})) {}`,
    "const vision = /gemma-3|glm-4v/.test(name);",
    `if (${q("kimi")} === family) {}`,
    `switch (name) { case ${q("mistral")}: break; }`,
    `if (name.startsWith('llama3')) {}`,
    "const harmony = names.some((name) => /gpt-oss/.test(name));",
    `if (name.endsWith(${q("nemotron")})) {}`,
    `if (arch !== ${q("muse-glimmer")}) {}`,
    `const flash = new RegExp(${q("flash-next")}, "i");`,
    `if (mode === ${q("dspark")}) {}`,
    "return /pennyroyal/i.test(image);",
  ].join(String.fromCharCode(10));
  const counts = countHits(sample, { familyTokensOnly: true });
  assert.deepEqual(
    FAMILY_TOKENS.map((token) => [token.id, counts.get(token.id)]),
    FAMILY_TOKENS.map((token) => [token.id, token.id === "deepseek" ? 2 : 1]),
  );
  // Messages, labels, table keys, identifiers, comments and divisions are not
  // decisions on a model name.
  const quiet = [
    `findings.push(finding(${q("ok")}, ${q("Qwen3.8 DSpark")}, ${q("Muse Glimmer is retired")}));`,
    `const label = { ${q("qwen3.8")}: ${q("Qwen3.8")} }[familyId];`,
    "const isQwen38 = family.priority / weight / 2;",
    "// if (name === 'deepseek') the old code branched here",
    " * /gemma/ used to match by name",
    `const DSPARK_MODE = ${q("dspark")};`,
    "if (mode === DSPARK_MODE) {}",
  ].join(String.fromCharCode(10));
  assert.equal(countHits(quiet, { familyTokensOnly: true }).size, 0);
});

test("this is the only family-branch guard: no other test carries the pattern list or an allowlist", () => {
  const others = [];
  for (const pkg of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".") || pkg.name === "node_modules" || pkg.name === "worktrees") continue;
    const testDir = path.join(REPO_ROOT, pkg.name, "test");
    if (!fs.existsSync(testDir)) continue;
    for (const file of listJs(`${pkg.name}/test`, { recursive: true, skipDirs: ["fixtures"], suffix: ".test.js" })) {
      if (file === "manager-core/test/no-family-branches.test.js") continue;
      const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (/isDiffusionGemma/.test(text) && /supportsB10630/.test(text)) others.push(file);
      if (/family-branch-allowlist/.test(text)) others.push(file);
    }
  }
  assert.deepEqual(others, []);
  const fixtures = fs.readdirSync(path.join(__dirname, "fixtures"));
  assert.deepEqual(fixtures.filter((name) => /allowlist/i.test(name)), ["family-branch-allowlist.json"]);
});
