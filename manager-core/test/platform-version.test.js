"use strict";

// Version, build id, live drift, deploy history and newer commits
// (docs/overhaul/06-ops.md §9.5, §14). Every case works on a temp AI root:
// deploy manifests are written in the shape Windows PowerShell 5.1 gives them
// (BOM, CRLF), the drift port is checked against the real Get-LiveDrift from
// scripts/deploy-worktree.ps1 on Windows, and git cases use fixture
// repositories created here with an isolated git config.

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("..");
const version = require("../platform/version");

const REPO_ROOT = path.join(__dirname, "..", "..");
const DEPLOY_SCRIPT = path.join(REPO_ROOT, "scripts", "deploy-worktree.ps1");
const VERSION_MODULE = path.join(__dirname, "..", "platform", "version.js");
const BOM = "﻿";
const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const IS_WINDOWS = process.platform === "win32";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(root, relPath, content) {
  const file = path.join(root, ...relPath.split(/[\\/]/));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// What Windows PowerShell 5.1 `ConvertTo-Json | Set-Content -Encoding UTF8`
// leaves on disk: a UTF-8 BOM, CRLF line ends and `"key":  value`.
function psJson(value) {
  return `${BOM}${JSON.stringify(value, null, 4).replace(/": /g, "\":  ").replace(/\n/g, "\r\n")}\r\n`;
}

function writeManifest(root, stamp, manifest) {
  const dir = path.join(root, "artifacts", "worktree-deploy-backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deployment-manifest.json");
  fs.writeFileSync(file, typeof manifest === "string" ? manifest : psJson(manifest));
  return file;
}

function manifest(deployedAt, files, extra = {}) {
  return {
    schemaVersion: 1,
    deployedAt,
    sourceWorktree: "<AI_ROOT>\\worktrees\\main",
    branch: "main",
    commit: "c0146a7d2f1e00000000000000000000000000aa",
    liveRoot: "<AI_ROOT>",
    archive: "artifacts\\worktree-deploy\\fixture.zip",
    archiveSha256: "0".repeat(64),
    includeLocalExtensions: false,
    liveDrift: [],
    files,
    ...extra,
  };
}

function record(filePath, after, action = "updated", before = null) {
  return { path: filePath, kind: "release", action, beforeSha256: before, afterSha256: after };
}

// ---------------------------------------------------------------------------
// git fixtures

function gitEnv(dir) {
  const globalConfig = path.join(dir, "empty.gitconfig");
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, "");
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(env, args) {
  return execFileSync("git", args, { env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(env, work, name, content) {
  fs.writeFileSync(path.join(work, name), content);
  git(env, ["-C", work, "add", "-A"]);
  git(env, ["-C", work, "commit", "-q", "-m", `add ${name}`]);
  return git(env, ["-C", work, "rev-parse", "HEAD"]);
}

// A work repository with three commits on main, and an AI root whose
// platform-repo.git is a bare clone of it.
function repoFixture(t) {
  const dir = tempDir(t, "platform-version-git-");
  const env = gitEnv(dir);
  const work = path.join(dir, "work");
  git(env, ["init", "-q", "-b", "main", work]);
  const commits = [
    commitFile(env, work, "one.txt", "one\n"),
    commitFile(env, work, "two.txt", "two\n"),
    commitFile(env, work, "three.txt", "three\n"),
  ];
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const repo = path.join(root, "platform-repo.git");
  git(env, ["clone", "-q", "--bare", work, repo]);
  return { dir, env, work, root, repo, commits };
}

function writeVersionJson(root, value) {
  fs.writeFileSync(path.join(root, "version.json"), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// readVersion / writeVersionFile

test("readVersion reads version.json, BOM or not, ahead of everything else", (t) => {
  const root = tempDir(t, "platform-version-");
  writeFile(root, "package.json", JSON.stringify({ version: "0.2.0" }));
  const commit = "c0146a7d2f1e5b6a7c8d9e0f1a2b3c4d5e6f7a8b";
  writeVersionJson(root, `${BOM}${JSON.stringify({
    schemaVersion: 1, commit, shortCommit: "c0146a7d2f1e", branch: "feature/x", version: "0.2.0-git-c0146a7d2f1e",
    deployedAt: "2026-10-14T08:00:00.000Z", archiveSha256: "a".repeat(64),
    manifest: "artifacts/worktree-deploy-backups/20261014-080000-c0146a7d2f1e/deployment-manifest.json",
    sourceWorktree: "main", postDeploy: { pruned: 3, npm: ["vllm-manager"], mcpBuild: true, restart: "none" },
  })}`);
  const result = version.readVersion(root);
  assert.equal(result.source, "version.json");
  assert.equal(result.commit, commit);
  assert.equal(result.shortCommit, "c0146a7d2f1e");
  assert.equal(result.branch, "feature/x");
  assert.equal(result.version, "0.2.0-git-c0146a7d2f1e");
  assert.equal(result.deployedAt, "2026-10-14T08:00:00.000Z");
  assert.equal(result.sourceWorktree, "main");
  assert.deepEqual(result.postDeploy, { pruned: 3, npm: ["vllm-manager"], mcpBuild: true, restart: "none" });
  assert.equal(result.error, undefined);
});

test("readVersion without version.json or git knows only the package version", (t) => {
  const root = tempDir(t, "platform-version-");
  writeFile(root, "package.json", `${BOM}{"version":"0.2.0"}`);
  const result = version.readVersion(root);
  assert.equal(result.source, "unknown");
  assert.equal(result.version, "0.2.0");
  assert.equal(result.commit, null);
  assert.equal(result.shortCommit, null);
  assert.equal(result.deployedAt, null);

  // A corrupt version.json never throws; it falls through with the reason.
  writeVersionJson(root, "{ not json");
  const corrupt = version.readVersion(root);
  assert.equal(corrupt.source, "unknown");
  assert.equal(corrupt.error.code, "version_file_invalid");
  writeVersionJson(root, { commit: "not-a-commit" });
  assert.equal(version.readVersion(root).error.code, "version_file_invalid");
  assert.equal(version.readVersion(path.join(root, "missing")).source, "unknown");
});

test("readVersion in a worktree reports git HEAD and follows new commits", { skip: !HAS_GIT && "git is not installed" }, (t) => {
  const dir = tempDir(t, "platform-version-wt-");
  const env = gitEnv(dir);
  const root = path.join(dir, "tree");
  git(env, ["init", "-q", "-b", "feature/demo", root]);
  writeFile(root, "package.json", JSON.stringify({ version: "0.2.0" }));
  const first = commitFile(env, root, "a.txt", "a\n");
  const short = git(env, ["-C", root, "rev-parse", "--short=12", "HEAD"]);
  const result = version.readVersion(root);
  assert.equal(result.source, "git");
  assert.equal(result.commit, first);
  assert.equal(result.shortCommit, short);
  assert.equal(result.branch, "feature/demo");
  assert.equal(result.version, `0.2.0-git-${short}`);

  const second = commitFile(env, root, "b.txt", "b\n");
  assert.equal(version.readVersion(root).commit, second);
  git(env, ["-C", root, "checkout", "-q", "--detach", first]);
  const detached = version.readVersion(root);
  assert.equal(detached.commit, first);
  assert.equal(detached.branch, null);

  // A version.json in the worktree still wins.
  writeVersionJson(root, { commit: second });
  assert.equal(version.readVersion(root).source, "version.json");
  assert.equal(version.readVersion(root).shortCommit, second.slice(0, 12));
});

test("writeVersionFile writes the post-deploy stamp atomically and without user paths", async (t) => {
  const root = tempDir(t, "platform-version-");
  const commit = "c0146a7d2f1e5b6a7c8d9e0f1a2b3c4d5e6f7a8b";
  const manifestFile = path.join(root, "artifacts", "worktree-deploy-backups", "20261014-080000-c0146a7d2f1e", "deployment-manifest.json");
  const written = await version.writeVersionFile(root, {
    commit: commit.toUpperCase(),
    branch: "feature/x",
    version: "0.2.0-git-c0146a7d2f1e",
    deployedAt: "2026-10-14T08:00:00.000Z",
    archiveSha256: "B".repeat(64),
    manifest: manifestFile,
    sourceWorktree: path.join(root, "worktrees", "feature-x"),
    postDeploy: { pruned: 3, npm: ["vllm-manager"], mcpBuild: true, restart: "changed" },
  });
  assert.deepEqual(written, {
    schemaVersion: 1,
    commit,
    shortCommit: "c0146a7d2f1e",
    branch: "feature/x",
    version: "0.2.0-git-c0146a7d2f1e",
    deployedAt: "2026-10-14T08:00:00.000Z",
    archiveSha256: "b".repeat(64),
    manifest: "artifacts/worktree-deploy-backups/20261014-080000-c0146a7d2f1e/deployment-manifest.json",
    sourceWorktree: "feature-x",
    postDeploy: { pruned: 3, npm: ["vllm-manager"], mcpBuild: true, restart: "changed" },
  });
  const bytes = fs.readFileSync(path.join(root, "version.json"));
  assert.notEqual(bytes[0], 0xef, "no BOM");
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), written);
  assert.ok(!bytes.toString("utf8").includes(root), "no absolute path in version.json");
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  assert.equal(version.versionFilePath(root), path.join(root, "version.json"));

  const read = version.readVersion(root);
  assert.equal(read.source, "version.json");
  assert.equal(read.commit, commit);
  assert.equal(read.manifest, written.manifest);

  // deployedAt defaults to now; invalid input is refused before anything is written.
  const defaulted = await version.writeVersionFile(root, { commit });
  assert.ok(!Number.isNaN(Date.parse(defaulted.deployedAt)));
  for (const bad of [
    {},
    { commit: "c0146a7" },
    { commit, shortCommit: "ffffffffffff" },
    { commit, deployedAt: "yesterday" },
    { commit, archiveSha256: "nope" },
    { commit, manifest: path.join(path.dirname(root), "elsewhere.json") },
    { commit, postDeploy: ["not", "an", "object"] },
  ]) {
    await assert.rejects(version.writeVersionFile(root, bad), { code: "version_invalid" }, JSON.stringify(bad));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8")).deployedAt, defaulted.deployedAt);
});

// ---------------------------------------------------------------------------
// getBuildId

const BUILD_FILES = {
  "service-entry/console/index.html": "<!doctype html><title>console</title>\n",
  "service-entry/console/app.js": "export const app = 1;\n",
  "service-entry/console/routes/system/updates.js": "export default {};\n",
  "shared-public/vendor/VENDOR.json": "{\"schemaVersion\":1}\n",
  "shared-public/vendor/preact/10.27.2/preact.module.js": "export const h = () => null;\n",
  "shared-public/styles/tokens.css": ":root { --accent: #2563eb; }\n",
  // Outside the build roots: never part of the id.
  "service-entry/server.js": "// not served as a static file\n",
  "shared-public/js/theme.js": "// not a build root\n",
};

function buildRoot(t) {
  const root = tempDir(t, "platform-buildid-");
  for (const [relPath, content] of Object.entries(BUILD_FILES)) writeFile(root, relPath, content);
  return root;
}

// The §9.5 formula, computed independently of version.js.
function expectedContentHash(root, roots = version.BUILD_ID_ROOTS) {
  const lines = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${rel}/${entry.name}`);
      else if (entry.isFile()) lines.push(`${rel}/${entry.name}\0${sha256(fs.readFileSync(full))}`);
    }
  };
  for (const relRoot of roots) walk(path.join(root, ...relRoot.split("/")), relRoot);
  return sha256(lines.sort().join("\n")).slice(0, 12);
}

function fakeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function spyFs(onRead) {
  return {
    ...fs,
    readFileSync(file, ...rest) {
      onRead(String(file));
      return fs.readFileSync(file, ...rest);
    },
  };
}

test("BUILD_ID_ROOTS are the static trees the entry serves", () => {
  assert.deepEqual(version.BUILD_ID_ROOTS, ["service-entry/console", "service-entry/portal", "shared-public/vendor", "shared-public/styles"]);
  assert.ok(Object.isFrozen(version.BUILD_ID_ROOTS));
});

test("getBuildId returns {commit, contentHash} from the §9.5 formula", (t) => {
  const root = buildRoot(t);
  const id = version.getBuildId({ aiRoot: root });
  assert.deepEqual(Object.keys(id).sort(), ["commit", "contentHash"]);
  assert.match(id.contentHash, /^[0-9a-f]{12}$/);
  assert.equal(id.contentHash, expectedContentHash(root));
  // No version.json and no worktree: the commit is unknown.
  assert.equal(id.commit, null);
  // core.platform carries it (07 C2 calls core.platform.getBuildId), and 05's
  // getBuildId(aiRoot) string form gives the same answer.
  assert.equal(core.platform.getBuildId, version.getBuildId);
  assert.equal(core.platform.version, version);
  assert.deepEqual(core.platform.getBuildId(root), id);
  // The caller cannot alter the cached value.
  id.contentHash = "tampered";
  assert.equal(version.getBuildId({ aiRoot: root }).contentHash, expectedContentHash(root));
});

test("getBuildId is stable across runs and processes", (t) => {
  const root = buildRoot(t);
  const first = version.createBuildIdSource().getBuildId({ aiRoot: root });
  const second = version.createBuildIdSource().getBuildId({ aiRoot: root });
  assert.deepEqual(second, first);
  const script = "const v = require(process.argv[1]); process.stdout.write(JSON.stringify(v.getBuildId({ aiRoot: process.argv[2] })));";
  const child = JSON.parse(execFileSync(process.execPath, ["-e", script, VERSION_MODULE, root], { encoding: "utf8", windowsHide: true }));
  assert.deepEqual(child, first);
  // Files outside the build roots do not move it.
  writeFile(root, "service-entry/server.js", "// edited\n");
  writeFile(root, "shared-public/js/theme.js", "// edited\n");
  assert.equal(version.createBuildIdSource().getBuildId({ aiRoot: root }).contentHash, first.contentHash);
});

test("getBuildId follows an edit within 2 s and without a restart", (t) => {
  const root = buildRoot(t);
  const clock = fakeClock();
  const source = version.createBuildIdSource({ now: clock.now });
  const before = source.getBuildId({ aiRoot: root });
  writeFile(root, "service-entry/console/app.js", "export const app = 2; // a deploy copied a new build\n");
  clock.advance(1999);
  assert.equal(source.getBuildId({ aiRoot: root }).contentHash, before.contentHash, "cached between re-stats");
  clock.advance(1);
  const after = source.getBuildId({ aiRoot: root });
  assert.notEqual(after.contentHash, before.contentHash);
  assert.equal(after.contentHash, expectedContentHash(root));

  // Added, removed and renamed files move it as well.
  writeFile(root, "shared-public/styles/extra.css", "body { margin: 0; }\n");
  clock.advance(2000);
  const added = source.getBuildId({ aiRoot: root }).contentHash;
  assert.notEqual(added, after.contentHash);
  fs.renameSync(path.join(root, "shared-public", "styles", "extra.css"), path.join(root, "shared-public", "styles", "renamed.css"));
  clock.advance(2000);
  const renamed = source.getBuildId({ aiRoot: root }).contentHash;
  assert.notEqual(renamed, added);
  fs.rmSync(path.join(root, "shared-public", "styles", "renamed.css"));
  clock.advance(2000);
  assert.equal(source.getBuildId({ aiRoot: root }).contentHash, after.contentHash);
});

test("the shared getBuildId sees an edit on the real clock within 2 s", async (t) => {
  const root = buildRoot(t);
  const before = version.getBuildId({ aiRoot: root });
  writeFile(root, "shared-public/styles/tokens.css", ":root { --accent: #16a34a; --edited: 1; }\n");
  await delay(version.BUILD_ID_REFRESH_MS + 50);
  const after = version.getBuildId({ aiRoot: root });
  assert.notEqual(after.contentHash, before.contentHash);
  assert.equal(after.contentHash, expectedContentHash(root));
});

test("getBuildId re-hashes only the files that changed", (t) => {
  const root = buildRoot(t);
  const clock = fakeClock();
  let reads = [];
  const underRoots = (file) => version.BUILD_ID_ROOTS.some((relRoot) => file.startsWith(path.join(root, ...relRoot.split("/")) + path.sep));
  const source = version.createBuildIdSource({ now: clock.now, fs: spyFs((file) => { if (underRoots(file)) reads.push(file); }) });
  source.getBuildId({ aiRoot: root });
  assert.equal(reads.length, 6, "the first walk hashes every file under the roots");

  reads = [];
  clock.advance(2000);
  source.getBuildId({ aiRoot: root });
  assert.deepEqual(reads, [], "an unchanged tree is re-stated, not re-read");

  reads = [];
  const edited = writeFile(root, "service-entry/console/routes/system/updates.js", "export default { edited: true };\n");
  clock.advance(2000);
  const id = source.getBuildId({ aiRoot: root });
  assert.deepEqual(reads, [edited]);
  assert.equal(id.contentHash, expectedContentHash(root));

  reads = [];
  clock.advance(500);
  source.getBuildId({ aiRoot: root });
  assert.deepEqual(reads, [], "nothing is touched between re-stats");
});

test("getBuildId tolerates missing roots", (t) => {
  const root = buildRoot(t);
  // service-entry/portal does not exist in the fixture.
  assert.ok(!fs.existsSync(path.join(root, "service-entry", "portal")));
  const source = version.createBuildIdSource();
  assert.equal(source.getBuildId({ aiRoot: root }).contentHash, expectedContentHash(root));
  const empty = tempDir(t, "platform-buildid-empty-");
  assert.equal(source.getBuildId({ aiRoot: empty }).contentHash, sha256("").slice(0, 12));
  const roots = ["shared-public/styles", "no/such/root"];
  assert.equal(source.getBuildId({ aiRoot: root, roots }).contentHash, expectedContentHash(root, ["shared-public/styles"]));
});

test("an unreadable file throws build_id_unavailable and the next call retries", (t) => {
  const root = buildRoot(t);
  const clock = fakeClock();
  const blocked = new Set();
  const flakyFs = {
    ...fs,
    readFileSync(file, ...rest) {
      if (blocked.has(String(file))) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return fs.readFileSync(file, ...rest);
    },
  };
  const source = version.createBuildIdSource({ now: clock.now, fs: flakyFs });
  const tokens = path.join(root, "shared-public", "styles", "tokens.css");
  blocked.add(tokens);
  assert.throws(() => source.getBuildId({ aiRoot: root }), (error) => {
    assert.equal(error.code, "build_id_unavailable");
    assert.equal(error.path, "shared-public/styles/tokens.css");
    assert.ok(!error.message.includes(root), "the message names the relative path only");
    return true;
  });
  blocked.clear();
  const first = source.getBuildId({ aiRoot: root });
  assert.equal(first.contentHash, expectedContentHash(root));

  // A failed refresh keeps nothing half-done: the caller keeps its snapshot,
  // and the next call (without waiting) re-walks.
  writeFile(root, "shared-public/styles/tokens.css", ":root { --accent: #dc2626; --mid-deploy: 1; }\n");
  blocked.add(tokens);
  clock.advance(2000);
  assert.throws(() => source.getBuildId({ aiRoot: root }), { code: "build_id_unavailable" });
  blocked.clear();
  const recovered = source.getBuildId({ aiRoot: root });
  assert.notEqual(recovered.contentHash, first.contentHash);
  assert.equal(recovered.contentHash, expectedContentHash(root));
});

test("getBuildId takes the commit from version.json, else the worktree HEAD", { skip: !HAS_GIT && "git is not installed" }, (t) => {
  const dir = tempDir(t, "platform-buildid-git-");
  const env = gitEnv(dir);
  const root = path.join(dir, "tree");
  git(env, ["init", "-q", "-b", "main", root]);
  for (const [relPath, content] of Object.entries(BUILD_FILES)) writeFile(root, relPath, content);
  commitFile(env, root, "README.md", "fixture\n");
  const clock = fakeClock();
  const source = version.createBuildIdSource({ now: clock.now });
  assert.equal(source.getBuildId({ aiRoot: root }).commit, git(env, ["-C", root, "rev-parse", "--short=12", "HEAD"]));

  commitFile(env, root, "NEXT.md", "next\n");
  clock.advance(2000);
  assert.equal(source.getBuildId({ aiRoot: root }).commit, git(env, ["-C", root, "rev-parse", "--short=12", "HEAD"]));

  writeVersionJson(root, { commit: "c0146a7d2f1e5b6a7c8d9e0f1a2b3c4d5e6f7a8b", shortCommit: "c0146a7d2f1e" });
  clock.advance(2000);
  assert.equal(source.getBuildId({ aiRoot: root }).commit, "c0146a7d2f1e");

  // A directory nested in a repository is not a worktree root.
  const nested = path.join(root, "nested-root");
  fs.mkdirSync(nested);
  assert.equal(source.getBuildId({ aiRoot: nested }).commit, null);
});

// ---------------------------------------------------------------------------
// computeLiveDrift

// A live root deployed three times (plus a corrupt, an empty and a missing
// manifest), then edited by hand. Returns the drift Get-LiveDrift reports.
function driftFixture(t) {
  const root = tempDir(t, "platform-drift-");
  const live = {
    "service-entry\\server.js": "entry v2\n",
    "vllm-manager\\server.js": "hand-edited in the live root\n",
    "docs\\说明.md": "手工修改\n",
    "README.md": "readme\n",
    "llama-manager\\public\\app.js": "app v2\n",
    "Shared-Public\\x.css": "body { color: red; }\n",
    "tts-platform\\a.py": "print('edited')\n",
    "tts-platform\\b.py": "print('b')\n",
    "never-deployed.txt": "not in any manifest\n",
  };
  for (const [relPath, content] of Object.entries(live)) writeFile(root, relPath, content);
  const deployed = (text) => sha256(text);
  // Directory names deliberately sort against deployedAt: the latest record
  // is chosen by deployedAt, never by folder name.
  writeManifest(root, "a-newest", manifest("2026-10-10T09:00:00.0000000+08:00", [
    record("service-entry\\server.js", deployed("entry v2\n")),
    record("llama-manager/public/app.js", deployed("app v2\n")),
    record("shared-public\\x.css", deployed("body { color: blue; }\n")),
    record("tts-platform\\a.py", null, "unchanged"),
    record("tts-platform\\b.py", "", "unchanged"),
    record("scripts\\gone.ps1", deployed("gone\n"), "created"),
  ]));
  writeManifest(root, "b-oldest", manifest("2026-10-01T09:00:00.0000000+08:00", [
    record("service-entry\\server.js", deployed("entry v1\n"), "created"),
    record("vllm-manager\\server.js", deployed("vllm as deployed\n"), "created"),
    record("docs\\说明.md", deployed("原始内容\n"), "created"),
    record("README.md", deployed("readme\n").toUpperCase(), "created"),
    record("llama-manager\\public\\app.js", deployed("app v1\n"), "created"),
    record("Shared-Public\\x.css", deployed("body { color: green; }\n"), "created"),
    record("tts-platform\\a.py", deployed("print('a')\n"), "created"),
    record("tts-platform\\b.py", deployed("print('b')\n"), "created"),
  ]));
  // PowerShell reads a one-element `files` the same as a list.
  writeManifest(root, "c-middle", manifest("2026-10-05T09:00:00.0000000+08:00", record("README.md", deployed("readme\n"))));
  writeManifest(root, "d-corrupt", `${BOM}{ "deployedAt": "2026-10-12T09:00:00+08:00", "files": [ { "path": "README.md", `);
  writeManifest(root, "e-empty", manifest("2026-10-13T09:00:00.0000000+08:00", []));
  fs.mkdirSync(path.join(root, "artifacts", "worktree-deploy-backups", "f-no-manifest"), { recursive: true });
  const expected = [
    { path: "docs\\说明.md", deployedSha256: deployed("原始内容\n"), liveSha256: deployed("手工修改\n") },
    { path: "Shared-Public\\x.css", deployedSha256: deployed("body { color: blue; }\n"), liveSha256: deployed("body { color: red; }\n") },
    { path: "tts-platform\\a.py", deployedSha256: deployed("print('a')\n"), liveSha256: deployed("print('edited')\n") },
    { path: "vllm-manager\\server.js", deployedSha256: deployed("vllm as deployed\n"), liveSha256: deployed("hand-edited in the live root\n") },
  ];
  return { root, expected };
}

function sortByPath(items) {
  return [...items].sort((left, right) => (left.path.toLowerCase() < right.path.toLowerCase() ? -1 : 1));
}

test("computeLiveDrift ports Get-LiveDrift onto PS-5.1-shaped manifests with BOMs", (t) => {
  const { root, expected } = driftFixture(t);
  const first = fs.readFileSync(path.join(root, "artifacts", "worktree-deploy-backups", "a-newest", "deployment-manifest.json"));
  assert.deepEqual([...first.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the fixture manifests carry a BOM");
  assert.deepEqual(version.computeLiveDrift(root, { fresh: true }), expected);
  assert.deepEqual(core.platform.computeLiveDrift(root, { fresh: true }), expected);
  assert.deepEqual(version.computeLiveDrift(tempDir(t, "platform-drift-none-")), []);
});

test("computeLiveDrift equals the real Get-LiveDrift", { skip: !IS_WINDOWS && "Windows PowerShell 5.1 is Windows-only" }, (t) => {
  const { root } = driftFixture(t);
  const backups = path.join(root, "artifacts", "worktree-deploy-backups");
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  // A PSModulePath inherited from PowerShell 7 (test-all started from pwsh)
  // makes Windows PowerShell load the wrong Utility module (no Get-FileHash),
  // so it is dropped and powershell.exe rebuilds its default.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  const run = (script) => {
    const prelude = "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";
    const encoded = Buffer.from(`${prelude}${script}`, "utf16le").toString("base64");
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env, encoding: "utf8", windowsHide: true, timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    });
  };
  // One more manifest, written exactly as deploy-worktree.ps1 writes it.
  writeFile(root, "llama-manager\\server.js", "llama edited after the last deploy\n");
  const records = JSON.stringify([
    record("llama-manager\\server.js", sha256("llama as deployed\n"), "created"),
    record("docs\\说明.md", sha256("原始内容\n")),
  ]);
  const psManifest = path.join(backups, "g-written-by-ps", "deployment-manifest.json");
  run([
    `New-Item -ItemType Directory -Force -Path ${quote(path.dirname(psManifest))} | Out-Null`,
    `$records = ${quote(records)} | ConvertFrom-Json`,
    "$manifest = [ordered]@{ schemaVersion = 1; deployedAt = '2026-10-11T09:00:00.0000000+08:00'; branch = 'main'; commit = 'c0146a7d2f1e00000000000000000000000000bb'; liveDrift = @(); files = @($records) }",
    `$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath ${quote(psManifest)} -Encoding UTF8`,
  ].join("\n"));
  assert.deepEqual([...fs.readFileSync(psManifest).subarray(0, 3)], [0xef, 0xbb, 0xbf], "PowerShell 5.1 wrote a BOM");

  const scriptText = fs.readFileSync(DEPLOY_SCRIPT, "utf8");
  const getLiveDrift = /^function Get-LiveDrift \{[\s\S]*?^\}\r?$/m.exec(scriptText);
  assert.ok(getLiveDrift, "Get-LiveDrift is defined in scripts/deploy-worktree.ps1");
  const output = run(`${getLiveDrift[0]}\n$drift = @(Get-LiveDrift -LiveRootPath ${quote(root)})\nConvertTo-Json -InputObject $drift -Depth 4 -Compress`);
  const expected = JSON.parse(output.trim());
  assert.ok(expected.length >= 5, "the fixture drifts in several files");
  assert.deepEqual(sortByPath(version.computeLiveDrift(root, { fresh: true })), sortByPath(expected));
});

test("computeLiveDrift caches for 10 minutes unless the manifests change", (t) => {
  const { root, expected } = driftFixture(t);
  const clock = fakeClock();
  const options = { now: clock.now };
  assert.deepEqual(version.computeLiveDrift(root, options), expected);

  // A hand edit inside the window is seen after it, or with fresh:true.
  writeFile(root, "README.md", "edited readme\n");
  clock.advance(9 * 60 * 1000);
  assert.deepEqual(version.computeLiveDrift(root, options), expected);
  const withReadme = version.computeLiveDrift(root, { ...options, fresh: true });
  assert.equal(withReadme.length, expected.length + 1);
  assert.ok(withReadme.some((item) => item.path === "README.md" && item.liveSha256 === sha256("edited readme\n")));

  // A new deploy (a new manifest) invalidates the cache at once.
  writeManifest(root, "h-redeploy", manifest("2026-10-14T09:00:00.0000000+08:00", [record("README.md", sha256("edited readme\n"))]));
  clock.advance(1000);
  assert.deepEqual(version.computeLiveDrift(root, options), expected);

  writeFile(root, "vllm-manager\\server.js", "vllm as deployed\n");
  clock.advance(10 * 60 * 1000);
  assert.deepEqual(version.computeLiveDrift(root, options).map((item) => item.path), ["docs\\说明.md", "Shared-Public\\x.css", "tts-platform\\a.py"]);

  // Callers get copies.
  const copy = version.computeLiveDrift(root, options);
  copy[0].path = "tampered";
  assert.equal(version.computeLiveDrift(root, options)[0].path, "docs\\说明.md");
});

test("computeLiveDrift reports an unreadable live file instead of hiding it", (t) => {
  const root = tempDir(t, "platform-drift-");
  const file = writeFile(root, "service-entry\\server.js", "entry\n");
  writeManifest(root, "a", manifest("2026-10-10T09:00:00+08:00", [record("service-entry\\server.js", sha256("entry\n")), record("..\\outside.txt", sha256("x"))]));
  const lockedFs = {
    ...fs,
    readFileSync(target, ...rest) {
      if (String(target) === file) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return fs.readFileSync(target, ...rest);
    },
  };
  assert.deepEqual(version.computeLiveDrift(root, { fresh: true, fs: lockedFs }), [
    { path: "service-entry\\server.js", deployedSha256: sha256("entry\n"), liveSha256: null, error: "EBUSY" },
  ]);
  assert.deepEqual(version.computeLiveDrift(root, { fresh: true }), []);
});

test("latestDeployRecords is the per-path rule post-deploy's prune shares", (t) => {
  const { root } = driftFixture(t);
  const latest = version.latestDeployRecords(root);
  assert.equal(latest.get("service-entry\\server.js").afterSha256, sha256("entry v2\n"));
  assert.equal(latest.get("service-entry\\server.js").stamp, "a-newest");
  assert.equal(latest.get("llama-manager\\public\\app.js").path, "llama-manager\\public\\app.js");
  assert.equal(latest.get("shared-public\\x.css").path, "Shared-Public\\x.css");
  assert.equal(latest.get("tts-platform\\a.py").afterSha256, sha256("print('a')\n"));
  assert.equal(latest.get("readme.md").stamp, "c-middle");
  assert.deepEqual(version.readDeploymentManifests(root).map((item) => item.stamp), ["b-oldest", "c-middle", "a-newest", "e-empty"]);
});

// ---------------------------------------------------------------------------
// listDeployments

test("listDeployments lists deploys newest first with counts and post-deploy results", (t) => {
  const { root } = driftFixture(t);
  writeFile(root, "artifacts\\worktree-deploy-backups\\a-newest\\post-deploy.json", `${BOM}${JSON.stringify({ pruned: ["old\\file.js", "old\\other.js"], npm: [], mcpBuild: false, restart: "none" })}`);
  writeFile(root, "artifacts\\worktree-deploy-backups\\b-oldest\\post-deploy.json", "{ corrupt");
  const deployments = version.listDeployments(root);
  assert.deepEqual(deployments.map((item) => item.stamp), ["e-empty", "a-newest", "c-middle", "b-oldest"]);
  const newest = deployments.find((item) => item.stamp === "a-newest");
  assert.deepEqual(newest, {
    stamp: "a-newest",
    commit: "c0146a7d2f1e00000000000000000000000000aa",
    branch: "main",
    deployedAt: "2026-10-10T09:00:00.0000000+08:00",
    counts: { created: 1, updated: 3, unchanged: 2, pruned: 2 },
    postDeploy: { pruned: ["old\\file.js", "old\\other.js"], npm: [], mcpBuild: false, restart: "none" },
  });
  const oldest = deployments.find((item) => item.stamp === "b-oldest");
  assert.deepEqual(oldest.counts, { created: 8, updated: 0, unchanged: 0, pruned: 0 });
  assert.equal(oldest.postDeploy, null);
  assert.deepEqual(version.listDeployments(root, { limit: 2 }).map((item) => item.stamp), ["e-empty", "a-newest"]);
  assert.equal(version.listDeployments(root, { limit: 0 }).length, 4);
  assert.deepEqual(version.listDeployments(tempDir(t, "platform-deploys-none-")), []);
});

// ---------------------------------------------------------------------------
// countNewerCommits

test("countNewerCommits counts commits on the update branch since the deployed one", { skip: !HAS_GIT && "git is not installed" }, async (t) => {
  const { root, repo, commits, env } = repoFixture(t);
  writeVersionJson(root, { commit: commits[0] });
  assert.deepEqual(await version.countNewerCommits(root), {
    available: true, behind: 2, head: commits[2], deployed: commits[0], ref: "refs/heads/main", fetched: false,
  });
  assert.equal((await core.platform.countNewerCommits(root, { branch: "main" })).behind, 2);

  writeVersionJson(root, { commit: commits[2], shortCommit: commits[2].slice(0, 12) });
  assert.deepEqual(await version.countNewerCommits(root), {
    available: false, behind: 0, head: commits[2], deployed: commits[2], ref: "refs/heads/main", fetched: false,
  });

  // The branch comes from platform.json updates.branch by default.
  git(env, ["--git-dir", repo, "branch", "release", commits[1]]);
  writeVersionJson(root, { commit: commits[0] });
  writeFile(root, "config/platform.json", JSON.stringify({ updates: { branch: "release" } }));
  const release = await version.countNewerCommits(root);
  assert.equal(release.ref, "refs/heads/release");
  assert.equal(release.behind, 1);
  assert.equal(release.head, commits[1]);
});

test("countNewerCommits falls back to the newest deploy manifest without version.json", { skip: !HAS_GIT && "git is not installed" }, async (t) => {
  const { root, commits } = repoFixture(t);
  writeManifest(root, "20261001-090000-old", manifest("2026-10-01T09:00:00.0000000+08:00", [record("a.txt", sha256("a"))], { commit: commits[0] }));
  writeManifest(root, "20261005-090000-new", manifest("2026-10-05T09:00:00.0000000+08:00", [record("a.txt", sha256("a"))], { commit: commits[1] }));
  const result = await version.countNewerCommits(root);
  assert.equal(result.deployed, commits[1]);
  assert.equal(result.behind, 1);
  assert.equal(result.available, true);
  // An explicit deployed commit wins.
  assert.equal((await version.countNewerCommits(root, { deployed: commits[0] })).behind, 2);
});

test("countNewerCommits fetches only when asked", { skip: !HAS_GIT && "git is not installed" }, async (t) => {
  const { root, repo, work, commits, env } = repoFixture(t);
  // The bare repo mirrors the fixture work repo's branches (a local path, no network).
  git(env, ["--git-dir", repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
  writeVersionJson(root, { commit: commits[0] });
  const fourth = commitFile(env, work, "four.txt", "four\n");
  const local = await version.countNewerCommits(root, { branch: "main" });
  assert.equal(local.behind, 2);
  assert.equal(local.fetched, false);
  const fetched = await version.countNewerCommits(root, { branch: "main", fetch: true });
  assert.equal(fetched.fetched, true);
  assert.equal(fetched.behind, 3);
  assert.equal(fetched.head, fourth);

  // A fetch that fails falls back to local refs and never echoes git's output.
  git(env, ["--git-dir", repo, "config", "remote.origin.url", path.join(path.dirname(work), "no-such-remote")]);
  const failed = await version.countNewerCommits(root, { branch: "main", fetch: true });
  assert.equal(failed.fetched, false);
  assert.equal(failed.fetchError.code, "fetch_failed");
  assert.ok(!failed.fetchError.message.includes("no-such-remote"));
  assert.equal(failed.behind, 3);
});

test("countNewerCommits explains why it cannot count, and never rejects", { skip: !HAS_GIT && "git is not installed" }, async (t) => {
  const { root, commits } = repoFixture(t);
  const noRepo = tempDir(t, "platform-version-norepo-");
  assert.equal((await version.countNewerCommits(noRepo, { branch: "main" })).error.code, "repo_missing");

  assert.equal((await version.countNewerCommits(root, { branch: "main" })).error.code, "deployed_unknown");
  writeVersionJson(root, { commit: commits[0] });
  const missingRef = await version.countNewerCommits(root, { branch: "no-such-branch" });
  assert.equal(missingRef.error.code, "ref_missing");
  assert.equal(missingRef.behind, null);
  assert.equal(missingRef.available, false);

  const foreign = "f".repeat(40);
  const notInRepo = await version.countNewerCommits(root, { branch: "main", deployed: foreign });
  assert.equal(notInRepo.error.code, "deployed_not_in_repo");
  assert.equal(notInRepo.deployed, foreign);
  assert.equal(notInRepo.head, commits[2]);

  for (const branch of ["--upload-pack=x", "../main", "main.lock", "a b", ""]) {
    const invalid = await version.countNewerCommits(root, { branch });
    assert.equal(invalid.error.code, "invalid_branch", branch);
  }
  const noGit = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); };
  assert.equal((await version.countNewerCommits(root, { branch: "main", git: noGit })).error.code, "git_unavailable");
});
