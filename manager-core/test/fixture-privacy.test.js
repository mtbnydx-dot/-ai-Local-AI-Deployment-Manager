"use strict";

// Privacy and hygiene scan of the model fixtures (docs/overhaul/02-models.md
// §19, §21.1): no drive-letter or user paths, no credentials, no e-mail
// addresses, nothing that names this machine or its user, and no file that
// .gitignore or the release robocopy would drop.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CREDENTIAL_PATTERNS: CAPTURE_CREDENTIALS,
  GENERIC_IDENTITY_NAMES,
  containsIdentity,
  filterIdentityNeedles,
  identityNeedles: captureIdentityNeedles,
} = require("../../scripts/capture-model-fixture.js");

const REPO_ROOT = path.join(__dirname, "..", "..");
const FIXTURE_DIRS = ["model-cards", "root-cause-samples"].map((name) => path.join(__dirname, "fixtures", name));
const RELEASE_SCRIPT = path.join(REPO_ROOT, "build-github-release.ps1");

// Used when the release script is absent; otherwise its own list is read.
const FALLBACK_CREDENTIALS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
];
// The redactor's Hugging Face token shape (secret-redactor.js) on top.
const HF_TOKEN = /\bhf_[A-Za-z0-9]{20,}/i;
const PATHS = [
  { id: "drive-letter path", pattern: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/ },
  { id: "\\Users\\ path", pattern: /[\\/]Users[\\/]/i },
  { id: "/home/ path", pattern: /\/home\//i },
  { id: "e-mail address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
];

// The release scan's own list, read from the script so the two cannot drift.
function releaseCredentialPatterns() {
  if (!fs.existsSync(RELEASE_SCRIPT)) return [];
  const text = fs.readFileSync(RELEASE_SCRIPT, "utf8");
  const block = text.match(/\$credentialPatterns\s*=\s*@\(([\s\S]*?)\r?\n\)/);
  if (!block) return [];
  // PowerShell -match is case-insensitive.
  return Array.from(block[1].matchAll(/'((?:[^']|'')*)'/g), (match) => new RegExp(match[1].replace(/''/g, "'"), "i"));
}

function credentialPatterns() {
  const release = releaseCredentialPatterns();
  return [...(release.length ? release : FALLBACK_CREDENTIALS), HF_TOKEN];
}

// The capture tool's rule, so a fixture it writes passes here: this account,
// host and home folder plus the repository path, generic names (user, root,
// dev, server, ...) dropped, matched as whole tokens only.
function identityNeedles() {
  return captureIdentityNeedles([path.resolve(REPO_ROOT)]);
}

function walk(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else if (entry.isFile()) files.push({ full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return files;
}

function fixtureFiles() {
  return FIXTURE_DIRS.flatMap((dir) => walk(dir).map((file) => ({ ...file, root: path.basename(dir) })));
}

function contentFindings(text, credentials, needles) {
  const findings = [];
  for (const entry of PATHS) if (entry.pattern.test(text)) findings.push(entry.id);
  if (credentials.some((pattern) => pattern.test(text))) findings.push("credential");
  if (containsIdentity(text, needles)) findings.push("machine or user name");
  return findings;
}

// .gitignore folders and names, the release robocopy /XD and /XF lists, and
// the release forbidden-name check.
const IGNORED_DIRS = new Set(["models", "logs", "cache", ".cache", "node_modules", "audit-logs", "projects", "test-results", "venvs", "dist"]);
const IGNORED_NAME = /(?:\.log|\.jsonl|\.pid|\.tmp|\.db|\.db-.*|\.sqlite3?|\.sqlite3?-.*|\.wal|\.shm|\.local\.json|\.secret\.json)$/i;
const FORBIDDEN_NAME = /(?:\.pem$|\.key$|id_rsa|id_ed25519|credential|service-api-key\.json$|^\.env(?:\.|$)|^stats-ledger\.json$|^jobs-ledger\.json$|^service-exposure\.json$)/i;

test("both fixture folders exist and hold files", () => {
  for (const dir of FIXTURE_DIRS) {
    assert.ok(fs.existsSync(dir), `${path.basename(dir)} is missing`);
    assert.ok(walk(dir).length > 0, `${path.basename(dir)} is empty`);
  }
});

test("the scan flags each kind of leak (planted strings, never written to disk)", () => {
  const credentials = credentialPatterns();
  const needle = "fixture-needle-xyz";
  const planted = {
    "drive-letter path": ["Q", ":\\", "models\\x"].join(""),
    "\\Users\\ path": ["\\", "Users", "\\someone\\x"].join(""),
    "/home/ path": ["/ho", "me/someone/x"].join(""),
    "e-mail address": ["someone", "@", "example.org"].join(""),
    credential: ["sk", "-", "A".repeat(24)].join(""),
    "machine or user name": needle,
  };
  for (const [kind, text] of Object.entries(planted)) {
    assert.ok(contentFindings(`config ${text} end`, credentials, [needle]).includes(kind), kind);
  }
  assert.ok(contentFindings(["hf", "_", "B".repeat(24)].join(""), credentials, []).includes("credential"));
  assert.deepEqual(contentFindings("https://huggingface.co/org/repo and re:.*mlp.gate$ and <AI_ROOT>\\models\\x", credentials, [needle]), []);
});

test("the capture tool refuses everything the release scan rejects", (t) => {
  if (!fs.existsSync(RELEASE_SCRIPT)) {
    t.skip("build-github-release.ps1 is not present");
    return;
  }
  const release = releaseCredentialPatterns();
  assert.ok(release.length >= 6, "build-github-release.ps1 $credentialPatterns not found");
  const capture = new Set(CAPTURE_CREDENTIALS.map((entry) => entry.pattern.source));
  for (const pattern of release) {
    const normalized = pattern.source.replace(/\((RSA \|EC \|OPENSSH )\)\?/, "(?:$1)?");
    assert.ok(capture.has(normalized), `release pattern ${pattern.source} is missing from scripts/capture-model-fixture.js`);
  }
});

function scanFixtures(needles) {
  const credentials = credentialPatterns();
  const hits = [];
  for (const file of fixtureFiles()) {
    const text = fs.readFileSync(file.full, "utf8");
    for (const finding of contentFindings(text, credentials, needles)) hits.push(`${file.root}/${file.rel}: ${finding}`);
  }
  return hits;
}

test("no fixture contains paths, credentials, e-mail addresses or machine names", () => {
  assert.deepEqual(scanFixtures(identityNeedles()), []);
});

// The result must not depend on what the machine running the suite is called.
test("generic account and host names never count; distinctive names match whole tokens", () => {
  const credentials = credentialPatterns();
  const template = "{%- if message.role == 'user' %}<|user|>{{ message.content }}{%- endif %} root-cause test on the dev server";
  assert.deepEqual(contentFindings(template, credentials, ["user", "root", "test", "dev", "server"]), []);
  assert.deepEqual(contentFindings(`${template} built by zq-builder`, credentials, ["user", "zq-builder"]), ["machine or user name"]);
  assert.deepEqual(contentFindings(`${template} built by zq-builders`, credentials, ["zq-builder"]), []);
  assert.deepEqual(filterIdentityNeedles(["User", "WORKSTATION", "Ubuntu", "zq-builder"]), ["zq-builder"]);

  const original = { userInfo: os.userInfo, hostname: os.hostname };
  try {
    for (const name of ["User", "root", "test", "dev", "server", "workstation", "ubuntu", "admin"]) {
      assert.ok(GENERIC_IDENTITY_NAMES.has(name.toLowerCase()), name);
      os.userInfo = () => ({ username: name });
      os.hostname = () => name.toUpperCase();
      const needles = identityNeedles();
      assert.ok(!needles.includes(name.toLowerCase()), `${name} is not a needle`);
      assert.deepEqual(scanFixtures(needles), [], `account and host named ${name}`);
    }
  } finally {
    Object.assign(os, original);
  }
});

test("fixture names survive .gitignore and the release robocopy", () => {
  const problems = [];
  for (const file of fixtureFiles()) {
    const segments = file.rel.split("/");
    for (const dir of segments.slice(0, -1)) if (IGNORED_DIRS.has(dir.toLowerCase())) problems.push(`${file.root}/${file.rel}: folder ${dir}`);
    const name = segments[segments.length - 1];
    if (IGNORED_NAME.test(name)) problems.push(`${file.root}/${file.rel}: ignored extension`);
    if (FORBIDDEN_NAME.test(name)) problems.push(`${file.root}/${file.rel}: forbidden release name`);
    if (/\.(?:test|spec)\.[cm]?js$/i.test(name)) problems.push(`${file.root}/${file.rel}: test file inside fixtures`);
    if (file.root === "root-cause-samples" && name !== "samples.json" && !name.endsWith(".log.fixture")) {
      problems.push(`${file.root}/${file.rel}: log samples end in .log.fixture`);
    }
  }
  assert.deepEqual(problems, []);
});

test("git check-ignore reports no fixture file", (t) => {
  let inWorkTree = false;
  try {
    inWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    inWorkTree = false;
  }
  if (!inWorkTree) {
    t.skip("not a git work tree (live root or extracted release)");
    return;
  }
  const names = fixtureFiles().map((file) => path.relative(REPO_ROOT, file.full).split(path.sep).join("/"));
  let output = "";
  try {
    // --no-index applies the rules to tracked files too; exit 1 means none is ignored.
    output = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: REPO_ROOT, input: `${names.join("\n")}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    if (error.status !== 1) throw error;
    output = error.stdout || "";
  }
  assert.deepEqual(output.split(/\r?\n/).filter(Boolean), []);
});
