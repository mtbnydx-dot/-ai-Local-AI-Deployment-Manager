"use strict";

// Deploy post-steps (docs/overhaul/06-ops.md §9.3, OPS-11a): prune, staged
// dependency install and swap, MCP build stamp, version.json and the restart
// mapping. Every case runs on a fixture live root in a temp directory with a
// fake npm; nothing touches a real live root, service, network or Docker.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const steps = require("../platform/deploy-steps");
const versionApi = require("../platform/version");
const componentsApi = require("../platform/components");
const configApi = require("../platform/config");

const COMMIT = "c0146a7d2f1e5b9a8c7d6e5f4a3b2c1d0e9f8a7b";
const BOM = "﻿";
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0);

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-steps-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, rel, content) {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, ...rel.split("/")));
}

// What Windows PowerShell 5.1 writes: BOM, CRLF, 7-digit fractional seconds.
function psJson(value) {
  return `${BOM}${JSON.stringify(value, null, 4).replace(/\n/g, "\r\n")}`;
}

function record(path_, content, action = "updated", kind = "release") {
  return { path: path_, kind, action, beforeSha256: null, afterSha256: sha(content) };
}

function writeManifest(root, stamp, data) {
  const dir = path.join(root, "artifacts", "worktree-deploy-backups", stamp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deployment-manifest.json");
  fs.writeFileSync(file, psJson({
    schemaVersion: 1, deployedAt: "2026-10-14T08:00:00.1234567+08:00", sourceWorktree: "<SOURCE>", branch: "feature/example",
    commit: COMMIT, liveRoot: root, archive: "<RELEASE>\\local-model-service-platform-v0.2.0-git-c0146a7d2f1e.zip",
    archiveSha256: "a".repeat(64), includeLocalExtensions: false, liveDrift: [], files: [], ...data,
  }));
  return { file, dir };
}

const MCP_INPUTS = ["src/**/*.ts", "package.json", "package-lock.json", "tsconfig.json"];

function registryFixture() {
  return {
    packages: [
      { dir: "vllm-manager", live: true, components: ["vllm-manager"] },
      { dir: "platform-mcp", live: true, components: ["platform-mcp"], build: { script: "build", inputs: MCP_INPUTS, stamp: "dist/.build-stamp.json" } },
      { dir: ".", live: false, reason: "test-only" },
    ],
    components: [
      { id: "docker", kind: "external" },
      { id: "entry", kind: "node", paths: ["service-entry/**", "manager-core/**", "!manager-core/platform/**", "shared-public/**"] },
      { id: "service-entry-public", kind: "listener" },
      { id: "vllm-manager", kind: "node", paths: ["vllm-manager/**", "manager-core/**", "!manager-core/platform/**", "shared-public/**"] },
      { id: "platform-mcp", kind: "node", paths: ["platform-mcp/**"] },
    ],
  };
}

// A live root with two packages: vllm-manager (old node_modules, lock) and
// platform-mcp (a build, current stamp).
function liveRoot(t) {
  const root = tempRoot(t);
  put(root, "vllm-manager/package.json", '{"name":"vllm-manager","version":"1.0.0"}\n');
  put(root, "vllm-manager/package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  put(root, "vllm-manager/node_modules/old.txt", "old modules");
  put(root, "platform-mcp/package.json", '{"name":"platform-mcp","version":"0.6.0"}\n');
  put(root, "platform-mcp/package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  put(root, "platform-mcp/tsconfig.json", "{}\n");
  put(root, "platform-mcp/src/index.ts", "export const one = 1;\n");
  put(root, "platform-mcp/node_modules/typescript/package.json", '{"name":"typescript","version":"5.9.3"}\n');
  put(root, "platform-mcp/dist/src/index.js", "exports.one = 1;\n");
  return root;
}

function recordCurrentState(root) {
  const { hashBuildInputs } = require("../platform/doctor-probes");
  put(root, ".runtime/platform/deps-state.json", JSON.stringify({
    schemaVersion: 1,
    packages: {
      "vllm-manager": { lockSha256: sha(read(root, "vllm-manager/package-lock.json")), installedAt: "2026-10-01T00:00:00.000Z", node: "v24.16.0" },
      "platform-mcp": { lockSha256: sha(read(root, "platform-mcp/package-lock.json")), installedAt: "2026-10-01T00:00:00.000Z", node: "v24.16.0" },
    },
  }));
  put(root, "platform-mcp/dist/.build-stamp.json", JSON.stringify({ srcSha256: hashBuildInputs(path.join(root, "platform-mcp"), MCP_INPUTS), builtAt: "2026-10-01T00:00:00.000Z", node: "v24.16.0", tsc: "5.9.3" }));
}

// A fake npm: `ci` creates node_modules in cwd, `run build` writes dist.
function fakeNpm({ failCi = false, failBuild = false, ciHook = null } = {}) {
  const calls = [];
  const npm = async (args, { cwd }) => {
    calls.push({ args, cwd, files: fs.existsSync(cwd) ? fs.readdirSync(cwd).sort() : [] });
    if (args[0] === "ci") {
      if (failCi) return { code: 1, stdout: "", stderr: "npm error 404 not found" };
      fs.mkdirSync(path.join(cwd, "node_modules", "new-package"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "node_modules", "new.txt"), "new modules");
      ciHook?.(cwd);
      return { code: 0, stdout: "added 1 package", stderr: "" };
    }
    if (args[0] === "run" && args[1] === "build") {
      if (failBuild) return { code: 2, stdout: "", stderr: "error TS2304: Cannot find name" };
      fs.mkdirSync(path.join(cwd, "dist", "src"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "dist", "src", "index.js"), "exports.built = true;\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected npm ${args.join(" ")}` };
  };
  npm.calls = calls;
  return npm;
}

// Wraps fs so that the listed rename sources fail with the given error code.
function failingRenames(match, code) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (from, to) => {
          if (match(String(from), String(to))) throw Object.assign(new Error(`${code}: rename`), { code });
          return target.renameSync(from, to);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function snapshot(root) {
  const lines = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { lines.push(`${path.relative(root, full)}/`); walk(full); }
      else lines.push(`${path.relative(root, full)} ${sha(fs.readFileSync(full))}`);
    }
  };
  walk(root);
  return lines.join("\n");
}

async function runPost(root, manifestInfo, manifest, options = {}) {
  return steps.executePostDeploy({
    aiRoot: root, manifest, manifestFile: manifestInfo.file, backupRoot: manifestInfo.dir, registry: registryFixture(),
    now: () => NOW, nodeVersion: "v24.16.0", npm: fakeNpm(), ...options,
  });
}

// ---------------------------------------------------------------------------
// Prune

// Two deploys: the first shipped A..H, the second ships only A and B.
function pruneWorld(t) {
  const root = liveRoot(t);
  recordCurrentState(root);
  const files = {
    "scripts/a.js": "a", "scripts/b.js": "b-old", "scripts/stale.js": "stale",
    "scripts/hand-edited.js": "recorded", "service-entry/data/sample.json": "{}",
    "scripts/Case-Mixed.js": "mixed", "start-search-gateway.cmd": "@echo off\r\n",
    "manager-core/platform/dropped.js": "dropped", "scripts/already-gone.js": "gone",
  };
  put(root, "scripts/a.js", "a");
  put(root, "scripts/b.js", "b-new");
  put(root, "scripts/stale.js", files["scripts/stale.js"]);
  put(root, "scripts/hand-edited.js", "recorded + hand edit");
  put(root, "service-entry/data/sample.json", files["service-entry/data/sample.json"]);
  put(root, "scripts/Case-Mixed.js", files["scripts/Case-Mixed.js"]);
  put(root, "start-search-gateway.cmd", files["start-search-gateway.cmd"]);
  put(root, "manager-core/platform/dropped.js", files["manager-core/platform/dropped.js"]);
  put(root, "scripts/stray-unrecorded.js", "never deployed");
  const first = writeManifest(root, "20261001-100000-aaaaaaaaaaaa", {
    deployedAt: "2026-10-01T10:00:00.0000000+08:00",
    files: [
      record("scripts\\a.js", "a", "created"), record("scripts\\b.js", "b-old", "created"),
      record("scripts\\stale.js", files["scripts/stale.js"], "created"), record("scripts\\hand-edited.js", files["scripts/hand-edited.js"], "created"),
      record("service-entry\\data\\sample.json", files["service-entry/data/sample.json"], "created"),
      record("scripts\\case-mixed.js", files["scripts/Case-Mixed.js"], "created"),
      record("start-search-gateway.cmd", files["start-search-gateway.cmd"], "created", "local-extension"),
      record("manager-core\\platform\\dropped.js", files["manager-core/platform/dropped.js"], "created"),
      record("scripts\\already-gone.js", files["scripts/already-gone.js"], "created"),
    ],
  });
  const second = writeManifest(root, "20261014-100000-bbbbbbbbbbbb", {
    deployedAt: "2026-10-14T10:00:00.0000000+08:00",
    files: [record("scripts\\a.js", "a", "unchanged"), record("scripts\\b.js", "b-new", "updated")],
  });
  return { root, first, second, manifest: JSON.parse(fs.readFileSync(second.file, "utf8").slice(1)) };
}

test("computePruneCandidates prunes stale unmodified files and keeps drifted, protected and unrecorded ones", (t) => {
  const { root, manifest } = pruneWorld(t);
  const allManifests = versionApi.readDeploymentManifests(root);
  assert.equal(allManifests.length, 2);
  const plan = steps.computePruneCandidates({ aiRoot: root, manifest, allManifests });
  assert.deepEqual(plan.candidates.map((item) => item.path), ["manager-core\\platform\\dropped.js", "scripts\\case-mixed.js", "scripts\\stale.js"]);
  const kept = Object.fromEntries(plan.kept.map((item) => [item.path, item.reason]));
  assert.equal(kept["scripts\\hand-edited.js"], "drifted");
  assert.equal(kept["service-entry\\data\\sample.json"], "protected");
  assert.equal(kept["start-search-gateway.cmd"], "local_extension");
  assert.equal(Object.keys(kept).includes("scripts\\already-gone.js"), false, "a file that is already gone is neither pruned nor kept");
  assert.equal(Object.keys(kept).includes("scripts\\stray-unrecorded.js"), false, "an unrecorded file is never looked at");
});

test("the latest record per path decides, across any number of manifests", (t) => {
  const root = tempRoot(t);
  put(root, "tools/x.js", "second version");
  put(root, "tools/y.js", "first version");
  writeManifest(root, "20261001-100000-aaaaaaaaaaaa", {
    deployedAt: "2026-10-01T10:00:00+08:00",
    files: [record("tools\\x.js", "first version", "created"), record("tools\\y.js", "first version", "created")],
  });
  writeManifest(root, "20261005-100000-bbbbbbbbbbbb", {
    deployedAt: "2026-10-05T10:00:00+08:00",
    files: [record("tools\\x.js", "second version", "updated"), record("tools\\keep.js", "k", "created")],
  });
  const current = { deployedAt: "2026-10-14T10:00:00+08:00", files: [record("tools\\keep.js", "k", "unchanged")] };
  const plan = steps.computePruneCandidates({ aiRoot: root, manifest: current, allManifests: versionApi.readDeploymentManifests(root) });
  assert.deepEqual(plan.candidates.map((item) => item.path), ["tools\\x.js", "tools\\y.js"]);
  // y.js matches its (only) record; x.js matches the newer record, not the older.
  put(root, "tools/x.js", "first version");
  const drifted = steps.computePruneCandidates({ aiRoot: root, manifest: current, allManifests: versionApi.readDeploymentManifests(root) });
  assert.deepEqual(drifted.candidates.map((item) => item.path), ["tools\\y.js"]);
  assert.deepEqual(drifted.kept, [{ path: "tools\\x.js", reason: "drifted" }]);
});

test("protected prefixes are never pruned, even when unmodified", () => {
  for (const rel of ["config\\platform.json", "models\\a.bin", "logs\\x.log", ".runtime\\x", "backups\\x", "artifacts\\x", "venvs\\x", "tts-runtime\\x", "node_modules\\x", "worktrees\\x", "platform-repo.git\\HEAD", "vllm-manager\\data\\x.json", "service-entry\\logs\\x", "platform-mcp\\dist\\src\\index.js", "vllm-manager\\node_modules\\x\\y.js"]) {
    assert.equal(steps.protectedReason(rel), "protected", rel);
  }
  for (const rel of ["scripts\\x.js", "service-entry\\lib\\x.js", "docs\\data.md", "tts-platform\\voices\\README.md", "datafile.txt"]) {
    assert.equal(steps.protectedReason(rel), null, rel);
  }
});

test("a manifest path that leaves the live root is never touched", (t) => {
  const root = tempRoot(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));
  writeManifest(root, "20261001-100000-aaaaaaaaaaaa", { deployedAt: "2026-10-01T10:00:00+08:00", files: [record(`..\\${path.basename(outside)}`, "outside", "created")] });
  const plan = steps.computePruneCandidates({ aiRoot: root, manifest: { files: [] }, allManifests: versionApi.readDeploymentManifests(root) });
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.kept[0].reason, "unsafe_path");
});

test("executePostDeploy prunes with a backup, removes empty folders and writes post-deploy.json", async (t) => {
  const { root, second, manifest } = pruneWorld(t);
  const before = fs.readFileSync(second.file);
  const result = await runPost(root, second, manifest);
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.deepEqual(result.pruned, ["manager-core\\platform\\dropped.js", "scripts\\case-mixed.js", "scripts\\stale.js"]);
  assert.equal(exists(root, "scripts/stale.js"), false);
  assert.equal(exists(root, "scripts/Case-Mixed.js"), false);
  assert.equal(exists(root, "manager-core/platform"), false, "the emptied directory goes");
  // Backups hold the exact bytes.
  assert.equal(fs.readFileSync(path.join(second.dir, "pruned", "scripts", "stale.js"), "utf8"), "stale");
  assert.equal(fs.readFileSync(path.join(second.dir, "pruned", "manager-core", "platform", "dropped.js"), "utf8"), "dropped");
  // Drifted, protected, local-extension, unrecorded and current files stay.
  assert.equal(read(root, "scripts/hand-edited.js"), "recorded + hand edit");
  assert.equal(read(root, "service-entry/data/sample.json"), "{}");
  assert.equal(exists(root, "start-search-gateway.cmd"), true);
  assert.equal(exists(root, "scripts/stray-unrecorded.js"), true);
  assert.equal(read(root, "scripts/a.js"), "a");
  assert.ok(result.kept.some((item) => item.path === "scripts\\hand-edited.js" && item.reason === "drifted"));
  // The manifest is untouched, byte for byte (Get-LiveDrift still parses it).
  assert.ok(fs.readFileSync(second.file).equals(before));
  const written = JSON.parse(fs.readFileSync(path.join(second.dir, "post-deploy.json"), "utf8"));
  assert.deepEqual(written.pruned, result.pruned);
  // listDeployments reads the same file (OPS-10).
  const [newest] = versionApi.listDeployments(root);
  assert.equal(newest.counts.pruned, 3);
  assert.equal(newest.counts.updated, 1);
  assert.equal(newest.counts.unchanged, 1);
});

test("noPrune keeps every stale file", async (t) => {
  const { root, second, manifest } = pruneWorld(t);
  const result = await runPost(root, second, manifest, { noPrune: true });
  assert.deepEqual(result.pruned, []);
  assert.equal(exists(root, "scripts/stale.js"), true);
  assert.equal(fs.existsSync(path.join(second.dir, "pruned")), false);
});

test("a prune that cannot delete a file reports it, keeps going and fails the step", async (t) => {
  const { root, second, manifest } = pruneWorld(t);
  const locked = path.join(root, "scripts", "stale.js");
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === "unlinkSync") return (file) => { if (String(file) === locked) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return target.unlinkSync(file); };
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await runPost(root, second, manifest, { fs: fsImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["prune"]);
  assert.deepEqual(result.pruneFailed, [{ path: "scripts\\stale.js", code: "EBUSY" }]);
  assert.deepEqual(result.pruned, ["manager-core\\platform\\dropped.js", "scripts\\case-mixed.js"]);
  assert.equal(exists(root, "scripts/stale.js"), true);
});

// ---------------------------------------------------------------------------
// Dependencies

function depsWorld(t) {
  const root = liveRoot(t);
  recordCurrentState(root);
  const info = writeManifest(root, "20261014-100000-bbbbbbbbbbbb", { files: [record("vllm-manager\\package-lock.json", read(root, "vllm-manager/package-lock.json"), "unchanged")] });
  return { root, info, manifest: JSON.parse(fs.readFileSync(info.file, "utf8").slice(1)) };
}

test("an unchanged lock runs nothing; a lock change runs a staged npm ci and swaps node_modules", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  const quiet = fakeNpm();
  const first = await runPost(root, info, manifest, { npm: quiet });
  assert.equal(quiet.calls.length, 0);
  assert.deepEqual(first.npm, []);

  put(root, "vllm-manager/package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/x":{"version":"2.0.0"}}}\n');
  const npm = fakeNpm();
  const result = await runPost(root, info, manifest, { npm });
  assert.equal(result.ok, true, JSON.stringify(result.dependencies));
  assert.deepEqual(result.npm, ["vllm-manager"]);
  assert.equal(npm.calls.length, 1);
  assert.deepEqual(npm.calls[0].args.slice(0, 1), ["ci"]);
  assert.equal(npm.calls[0].cwd, path.join(root, ".runtime", "platform", "npm-stage", "vllm-manager"));
  assert.deepEqual(npm.calls[0].files, ["package-lock.json", "package.json"], "only the manifest and lock are staged");
  // The new modules are live, the old ones are kept as node_modules.prev-<stamp>.
  assert.equal(exists(root, "vllm-manager/node_modules/new.txt"), true);
  assert.equal(exists(root, "vllm-manager/node_modules/old.txt"), false);
  assert.equal(read(root, "vllm-manager/node_modules.prev-20261015-100000/old.txt"), "old modules");
  assert.equal(exists(root, ".runtime/platform/npm-stage/vllm-manager"), false, "the stage is cleaned up");
  const state = JSON.parse(read(root, ".runtime/platform/deps-state.json"));
  assert.deepEqual(state.packages["vllm-manager"], { lockSha256: sha(read(root, "vllm-manager/package-lock.json")), installedAt: new Date(NOW).toISOString(), node: "v24.16.0" });
  assert.equal(state.packages["platform-mcp"].lockSha256, sha(read(root, "platform-mcp/package-lock.json")), "other entries are kept");
  assert.equal(state.pendingSwap, undefined);
  // The restart set follows the swapped package.
  assert.deepEqual(result.restartResult.ids, ["vllm-manager"]);
  // Running again is a no-op: the lock matches the recorded hash.
  const again = fakeNpm();
  await runPost(root, info, manifest, { npm: again });
  assert.equal(again.calls.length, 0);
});

test("a missing node_modules triggers an install even with a matching hash", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  fs.rmSync(path.join(root, "vllm-manager", "node_modules"), { recursive: true });
  const npm = fakeNpm();
  const result = await runPost(root, info, manifest, { npm });
  assert.deepEqual(result.npm, ["vllm-manager"]);
  assert.equal(exists(root, "vllm-manager/node_modules/new.txt"), true);
  assert.equal(result.dependencies.find((item) => item.package === "vllm-manager").previous, null);
});

test("EBUSY on the swap records pendingSwap and leaves the live node_modules alone", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  put(root, "vllm-manager/package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/x":{"version":"3.0.0"}}}\n');
  const newLock = sha(read(root, "vllm-manager/package-lock.json"));
  const busy = failingRenames((from) => from === path.join(root, "vllm-manager", "node_modules"), "EBUSY");
  const result = await runPost(root, info, manifest, { fs: busy, npm: fakeNpm() });
  assert.equal(result.ok, true, "a pending swap is not a failure");
  assert.deepEqual(result.pendingSwap, ["vllm-manager"]);
  assert.equal(read(root, "vllm-manager/node_modules/old.txt"), "old modules");
  const state = JSON.parse(read(root, ".runtime/platform/deps-state.json"));
  const entry = state.packages["vllm-manager"];
  assert.notEqual(entry.lockSha256, newLock, "the live modules are still the old install");
  assert.equal(entry.pendingSwap.lockSha256, newLock);
  assert.equal(entry.pendingSwap.stage, ".runtime/platform/npm-stage/vllm-manager/node_modules");
  assert.equal(exists(root, entry.pendingSwap.stage), true);
  // A restart picks the swap up, so the component is listed.
  assert.deepEqual(result.restartResult.ids, ["vllm-manager"]);

  // The next post-deploy does not run npm again: the staged install is reused.
  const plan = steps.planDependencies({ aiRoot: root, registry: registryFixture() });
  assert.equal(plan.find((item) => item.package === "vllm-manager").action, "swap");
  const second = fakeNpm();
  const retried = await runPost(root, info, manifest, { fs: busy, npm: second });
  assert.equal(second.calls.length, 0, "the staged install is reused, not rebuilt");
  assert.deepEqual(retried.pendingSwap, ["vllm-manager"]);

  // The supervisor finishes the swap while the component is stopped.
  const applied = steps.applyPendingSwaps({ aiRoot: root, packages: ["vllm-manager"], now: () => NOW + 60000, nodeVersion: "v24.16.0" });
  assert.deepEqual(applied, [{ package: "vllm-manager", status: "swapped" }]);
  assert.equal(exists(root, "vllm-manager/node_modules/new.txt"), true);
  assert.equal(exists(root, "vllm-manager/node_modules.prev-20261015-100100/old.txt"), true);
  const done = JSON.parse(read(root, ".runtime/platform/deps-state.json")).packages["vllm-manager"];
  assert.equal(done.lockSha256, newLock);
  assert.equal(done.pendingSwap, undefined);
  assert.equal(exists(root, ".runtime/platform/npm-stage/vllm-manager"), false);
  assert.deepEqual(steps.applyPendingSwaps({ aiRoot: root }), [], "nothing pending any more");
});

test("a swap that fails halfway puts the old node_modules back", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  put(root, "vllm-manager/package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/x":{"version":"4.0.0"}}}\n');
  const flaky = failingRenames((from) => from.includes("npm-stage"), "EPERM");
  const result = await runPost(root, info, manifest, { fs: flaky, npm: fakeNpm() });
  assert.deepEqual(result.pendingSwap, ["vllm-manager"]);
  assert.equal(read(root, "vllm-manager/node_modules/old.txt"), "old modules", "rolled back");
  assert.equal(fs.readdirSync(path.join(root, "vllm-manager")).some((name) => name.startsWith("node_modules.prev-")), false);
  const hard = failingRenames((from) => from.includes("npm-stage"), "ENOENT");
  const failed = await runPost(root, info, manifest, { fs: hard, npm: fakeNpm() });
  assert.equal(failed.ok, false);
  assert.equal(failed.dependencies.find((item) => item.package === "vllm-manager").status, "failed");
  assert.equal(read(root, "vllm-manager/node_modules/old.txt"), "old modules");
});

test("an npm failure leaves the live node_modules untouched and fails the step", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  put(root, "vllm-manager/package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/x":{"version":"5.0.0"}}}\n');
  const before = JSON.parse(read(root, ".runtime/platform/deps-state.json"));
  const result = await runPost(root, info, manifest, { npm: fakeNpm({ failCi: true }) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["dependencies"]);
  const row = result.dependencies.find((item) => item.package === "vllm-manager");
  assert.equal(row.status, "failed");
  assert.equal(row.code, "npm_failed");
  assert.match(row.detail, /404/);
  assert.equal(read(root, "vllm-manager/node_modules/old.txt"), "old modules");
  assert.deepEqual(JSON.parse(read(root, ".runtime/platform/deps-state.json")), before, "the recorded hash is not advanced");
  assert.equal(JSON.parse(read(root, "artifacts/worktree-deploy-backups/20261014-100000-bbbbbbbbbbbb/post-deploy.json")).ok, false);
  // version.json is still written: the files are deployed.
  assert.equal(result.version.written, true);
});

test("a package that was never recorded but matches its node_modules is only recorded", (t) => {
  const root = liveRoot(t);
  put(root, "vllm-manager/package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }));
  put(root, "vllm-manager/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/left-pad": { version: "1.3.0" } } }));
  const plan = steps.planDependencies({ aiRoot: root, registry: registryFixture() });
  assert.equal(plan.find((item) => item.package === "vllm-manager").action, "record");
  put(root, "vllm-manager/node_modules/.package-lock.json", JSON.stringify({ packages: { "node_modules/left-pad": { version: "1.0.0" } } }));
  assert.equal(steps.planDependencies({ aiRoot: root, registry: registryFixture() }).find((item) => item.package === "vllm-manager").action, "install");
  // Test-only packages (live:false) are not part of the plan.
  assert.equal(plan.some((item) => item.package === "."), false);
});

test("old node_modules.prev-* directories are deleted after 7 days only", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  put(root, "vllm-manager/node_modules.prev-20261001-000000/a.txt", "old");
  put(root, "vllm-manager/node_modules.prev-20261013-000000/b.txt", "recent");
  const result = await runPost(root, info, manifest);
  assert.deepEqual(result.removedModules, ["vllm-manager/node_modules.prev-20261001-000000"]);
  assert.equal(exists(root, "vllm-manager/node_modules.prev-20261001-000000"), false);
  assert.equal(exists(root, "vllm-manager/node_modules.prev-20261013-000000"), true);
});

// ---------------------------------------------------------------------------
// MCP build

test("a stamp mismatch builds the MCP and writes the stamp; a current stamp does nothing", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  const quiet = fakeNpm();
  const current = await runPost(root, info, manifest, { npm: quiet });
  assert.equal(current.mcpBuild, false);
  assert.equal(current.mcp.status, "current");
  assert.equal(quiet.calls.length, 0);

  put(root, "platform-mcp/src/index.ts", "export const one = 2;\n");
  const npm = fakeNpm();
  const result = await runPost(root, info, manifest, { npm });
  assert.equal(result.mcpBuild, true);
  assert.deepEqual(npm.calls.map((call) => call.args), [["run", "build"]]);
  assert.equal(npm.calls[0].cwd, path.join(root, "platform-mcp"));
  const { hashBuildInputs } = require("../platform/doctor-probes");
  const stamp = JSON.parse(read(root, "platform-mcp/dist/.build-stamp.json"));
  assert.deepEqual(Object.keys(stamp).sort(), ["builtAt", "node", "srcSha256", "tsc"]);
  assert.equal(stamp.srcSha256, hashBuildInputs(path.join(root, "platform-mcp"), MCP_INPUTS));
  assert.equal(stamp.builtAt, new Date(NOW).toISOString());
  assert.equal(stamp.node, "v24.16.0");
  assert.equal(stamp.tsc, "5.9.3");
  assert.equal(read(root, "platform-mcp/dist/src/index.js"), "exports.built = true;\n");
  assert.deepEqual(result.restartResult.ids, ["platform-mcp"]);
  assert.equal(JSON.parse(read(root, "version.json")).postDeploy.mcpBuild, true);
});

test("a missing dist or stamp builds; a failed build is reported and leaves no new stamp", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  fs.rmSync(path.join(root, "platform-mcp", "dist"), { recursive: true });
  const failing = await runPost(root, info, manifest, { npm: fakeNpm({ failBuild: true }) });
  assert.equal(failing.ok, false);
  assert.deepEqual(failing.failed, ["mcp-build"]);
  assert.equal(failing.mcp.code, "build_failed");
  assert.equal(exists(root, "platform-mcp/dist/.build-stamp.json"), false);
  const built = await runPost(root, info, manifest, { npm: fakeNpm() });
  assert.equal(built.mcp.status, "built");
  assert.equal(built.mcp.reason, "dist_missing");
  fs.rmSync(path.join(root, "platform-mcp", "dist", ".build-stamp.json"));
  const plan = steps.planMcpBuild({ aiRoot: root, registry: registryFixture() });
  assert.equal(plan.reason, "stamp_missing");
  assert.equal(plan.needed, true);
});

test("a lock change in the MCP package installs first and then builds against the new modules", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  put(root, "platform-mcp/package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/y":{"version":"9.0.0"}}}\n');
  const npm = fakeNpm();
  const result = await runPost(root, info, manifest, { npm });
  assert.deepEqual(npm.calls.map((call) => call.args[0]), ["ci", "run"]);
  assert.deepEqual(result.npm, ["platform-mcp"]);
  assert.equal(result.mcpBuild, true, "package-lock.json is a build input");
  assert.deepEqual(result.restartResult.ids, ["platform-mcp"]);
});

// ---------------------------------------------------------------------------
// version.json, dry run, record

test("version.json is written from the manifest without user paths", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  await runPost(root, info, manifest, { restart: "changed" });
  const version = JSON.parse(read(root, "version.json"));
  assert.equal(version.schemaVersion, 1);
  assert.equal(version.commit, COMMIT);
  assert.equal(version.shortCommit, COMMIT.slice(0, 12));
  assert.equal(version.branch, "feature/example");
  assert.equal(version.version, "0.2.0-git-c0146a7d2f1e");
  assert.equal(version.archiveSha256, "a".repeat(64));
  assert.equal(version.manifest, "artifacts/worktree-deploy-backups/20261014-100000-bbbbbbbbbbbb/deployment-manifest.json");
  assert.equal(version.sourceWorktree, "<SOURCE>");
  assert.deepEqual(version.postDeploy, { pruned: 0, npm: [], mcpBuild: false, restart: "changed" });
  assert.equal(JSON.stringify(version).includes(root), false);
  const read1 = versionApi.readVersion(root);
  assert.equal(read1.source, "version.json");
  assert.equal(read1.shortCommit, COMMIT.slice(0, 12));
});

test("dryRun prints the plan and changes nothing", async (t) => {
  const { root, second, manifest } = pruneWorld(t);
  put(root, "vllm-manager/package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/z":{"version":"1.0.0"}}}\n');
  put(root, "platform-mcp/src/index.ts", "export const one = 3;\n");
  const before = snapshot(root);
  const npm = fakeNpm();
  const result = await runPost(root, second, manifest, { dryRun: true, npm, restart: "changed" });
  assert.equal(snapshot(root), before);
  assert.equal(npm.calls.length, 0);
  assert.equal(result.dryRun, true);
  const [prune, deps, build, version, restart] = result.plan.steps;
  assert.deepEqual(result.plan.steps.map((step) => step.id), ["prune", "dependencies", "mcp-build", "version", "restart"]);
  assert.deepEqual(prune.candidates.map((item) => item.path), ["manager-core\\platform\\dropped.js", "scripts\\case-mixed.js", "scripts\\stale.js"]);
  assert.equal(deps.packages.find((item) => item.package === "vllm-manager").action, "install");
  assert.equal(build.needed, true);
  assert.equal(version.version, "0.2.0-git-c0146a7d2f1e");
  assert.equal(restart.reexec, true, "a dropped manager-core/platform file is a supervisor change");
});

test("recordDependencyState writes the lock hashes and the MCP build stamp", async (t) => {
  const root = liveRoot(t);
  const result = await steps.recordDependencyState({ aiRoot: root, registry: registryFixture(), now: () => NOW, nodeVersion: "v24.16.0" });
  assert.deepEqual(result.packages.map((item) => [item.package, item.status]), [["vllm-manager", "recorded"], ["platform-mcp", "recorded"], [".", "skipped"]]);
  const state = JSON.parse(read(root, ".runtime/platform/deps-state.json"));
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.packages["vllm-manager"], { lockSha256: sha(read(root, "vllm-manager/package-lock.json")), installedAt: new Date(NOW).toISOString(), node: "v24.16.0" });
  assert.equal(result.mcp.status, "recorded");
  const { hashBuildInputs } = require("../platform/doctor-probes");
  assert.equal(JSON.parse(read(root, "platform-mcp/dist/.build-stamp.json")).srcSha256, hashBuildInputs(path.join(root, "platform-mcp"), MCP_INPUTS));
  // The doctor's reader sees them as installed and current.
  const plan = steps.planDependencies({ aiRoot: root, registry: registryFixture() });
  assert.deepEqual(plan.map((item) => item.action), ["ok", "ok"]);
  assert.equal(steps.planMcpBuild({ aiRoot: root, registry: registryFixture() }).needed, false);
});

// ---------------------------------------------------------------------------
// Restart

test("restartComponents maps paths to components, adds the supervisor pseudo id and honours negation", (t) => {
  const root = tempRoot(t);
  const loaded = configApi.loadPlatformConfig({ aiRoot: root, env: {} });
  const registry = componentsApi.loadComponentRegistry({ aiRoot: root, config: loaded });
  const manifest = (...paths) => ({ files: paths.map((p) => ({ path: p, action: "updated", afterSha256: "0".repeat(64) })) });
  const ids = (input) => steps.restartComponents({ registry, ...input });

  assert.deepEqual(ids({ manifest: manifest("vllm-manager\\server.js") }), { ids: ["vllm-manager"], reexec: false });
  assert.deepEqual(ids({ manifest: manifest("manager-core\\common-utils.js") }).ids, ["entry", "llama-manager", "vllm-manager"]);
  const platformFile = ids({ manifest: manifest("manager-core\\platform\\supervisor.js") });
  assert.deepEqual(platformFile, { ids: [], reexec: true }, "negation: a platform file restarts no component");
  assert.equal(ids({ manifest: manifest("scripts\\platformctl.js") }).reexec, true);
  assert.deepEqual(ids({ manifest: manifest("docs\\a.md") }), { ids: [], reexec: false });
  assert.deepEqual(ids({ manifest: { files: [{ path: "vllm-manager\\x.js", action: "unchanged" }] } }), { ids: [], reexec: false }, "unchanged files do not restart anything");
  assert.deepEqual(ids({ manifest: manifest(), prunedPaths: ["llama-manager\\old.js"] }).ids, ["llama-manager"]);
  assert.deepEqual(ids({ manifest: manifest(), dependencyPackages: [{ components: ["platform-mcp"] }] }).ids, ["platform-mcp"]);
  assert.deepEqual(ids({ manifest: manifest(), mcpBuilt: true }).ids, ["platform-mcp"]);
  const all = ids({ manifest: manifest(), mode: "all" }).ids;
  assert.ok(all.includes("entry") && all.includes("vllm-manager") && all.includes("search-gateway"));
  assert.equal(all.includes("docker"), false, "external components are never restarted");
  assert.equal(all.includes("service-entry-public"), false);
  assert.equal(all.includes("supervisor"), false);
});

test("restart none lists, changed/all without the supervisor print commands, with an adapter they request it", async (t) => {
  const { root, info, manifest } = depsWorld(t);
  put(root, "platform-mcp/src/index.ts", "export const one = 4;\n");
  const none = await runPost(root, info, manifest, { restart: "none" });
  assert.equal(none.restartResult.action, "listed");
  assert.deepEqual(none.restartResult.ids, ["platform-mcp"]);

  put(root, "platform-mcp/src/index.ts", "export const one = 5;\n");
  const printed = await runPost(root, info, manifest, { restart: "changed" });
  assert.equal(printed.restartResult.action, "commands");
  assert.deepEqual(printed.restartResult.commands, ["platform restart platform-mcp --when-idle"]);

  put(root, "platform-mcp/src/index.ts", "export const one = 6;\n");
  const calls = [];
  const requested = await runPost(root, info, manifest, { restart: "changed", restartAdapter: async (request) => { calls.push(request); return { queued: ["platform-mcp"] }; } });
  assert.deepEqual(calls, [{ ids: ["platform-mcp"], reexec: false, when: "idle" }]);
  assert.equal(requested.restartResult.action, "requested");
  assert.equal(requested.ok, true);

  put(root, "platform-mcp/src/index.ts", "export const one = 7;\n");
  const broken = await runPost(root, info, manifest, { restart: "all", restartAdapter: async () => { throw Object.assign(new Error("no supervisor"), { code: "supervisor_unavailable" }); } });
  assert.equal(broken.ok, true, "a restart that cannot be requested still exits 0");
  assert.equal(broken.restartResult.action, "commands");
  assert.equal(broken.restartResult.code, "supervisor_unavailable");
  assert.throws(() => steps.planPostDeploy({ aiRoot: root, manifest, allManifests: [], registry: registryFixture(), restart: "sometimes" }), /restart must be/);
});

test("post-deploy.json holds no absolute paths", async (t) => {
  const { root, second, manifest } = pruneWorld(t);
  await runPost(root, second, manifest, { restart: "changed" });
  const text = fs.readFileSync(path.join(second.dir, "post-deploy.json"), "utf8");
  assert.equal(text.includes(root), false);
  assert.equal(text.includes(root.replace(/\\/g, "\\\\")), false);
});
