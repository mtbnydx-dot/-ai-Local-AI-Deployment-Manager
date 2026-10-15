"use strict";

// Deploy post-steps (docs/overhaul/06-ops.md §9.3, OPS-11a). deploy-worktree.ps1
// copies the release into the live root and writes deployment-manifest.json;
// `platform post-deploy` then calls executePostDeploy with that manifest:
//
//   1. prune         stale, unmodified deploy artifacts leave the live root
//                    (backed up first); drifted or protected files stay
//   2. dependencies  a changed package-lock.json gets a staged `npm ci` and a
//                    node_modules swap, or `pendingSwap` when the rename is
//                    refused (EBUSY/EPERM) for the supervisor to finish
//   3. mcp build     `npm run build` in platform-mcp when the stamp mismatches
//   4. version.json  the deploy stamp (version.writeVersionFile)
//   5. restart       the components the change touches; listed here, queued or
//                    restarted through the supervisor adapter (OPS-11b)
//
// Everything is plain CommonJS. fs, npm, the clock and the restart adapter are
// injectable so tests run against temp roots with a fake npm and never touch a
// real live root, a service or the network.

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const nodeFs = require("node:fs");
const path = require("node:path");
const components = require("./components");
const versionApi = require("./version");

const POST_DEPLOY_SCHEMA_VERSION = 1;
const DEPS_STATE_SCHEMA_VERSION = 1;
const POST_DEPLOY_NAME = "post-deploy.json";
const PRUNED_DIR = "pruned";
const PREVIOUS_MODULES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NPM_TIMEOUT_MS = 15 * 60 * 1000;
const RESTART_MODES = Object.freeze(["none", "changed", "all"]);
const SWAP_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const RESTARTABLE_KINDS = new Set(["node", "process", "group", "compose"]);

// §9.3 step 1. Whole-path prefixes, plus `*/data/`, `*/logs/` and `*/dist/`
// (one directory level below the root) and node_modules anywhere.
const PROTECTED_PREFIXES = Object.freeze([
  "config/", "models/", "cache/", "logs/", ".runtime/", "backups/", "artifacts/", "venvs/",
  "tts-runtime/", "node_modules/", "worktrees/", "platform-repo.git/",
]);
const PROTECTED_SECOND_SEGMENTS = Object.freeze(["data", "logs", "dist"]);

// ---------------------------------------------------------------------------
// Small helpers

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Of(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function segmentsOf(relPath) {
  return String(relPath || "").split(/[\\/]+/).filter(Boolean);
}

function toBackslash(relPath) {
  return segmentsOf(relPath).join("\\");
}

function toSlash(relPath) {
  return segmentsOf(relPath).join("/");
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value ?? Date.now());
}

// yyyymmdd-HHMMSS in UTC, the stamp node_modules.prev-<stamp> carries.
function stampOf(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function parseStamp(text) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(text);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : NaN;
}

function readJsonFile(fsImpl, file, fallback = null) {
  try {
    const value = JSON.parse(stripBom(fsImpl.readFileSync(file, "utf8")));
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function hashFile(fsImpl, file) {
  try {
    return sha256Of(fsImpl.readFileSync(file));
  } catch {
    return null;
  }
}

function isFile(fsImpl, file) {
  try {
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(fsImpl, file) {
  try {
    return fsImpl.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

// Atomic JSON write (temp file in the same directory, then rename), no BOM.
function writeJsonFile(fsImpl, file, value) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fsImpl.renameSync(temp, file);
  } catch (error) {
    // Windows can refuse a replace while another process holds the target open.
    try {
      fsImpl.copyFileSync(temp, file);
    } catch {
      throw error;
    } finally {
      try { fsImpl.rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }
}

// The live file for a manifest path, or null when it would leave the root.
function liveFile(aiRoot, relPath) {
  const segments = segmentsOf(relPath);
  if (!segments.length || segments.includes("..") || /^[A-Za-z]:$/.test(segments[0])) return null;
  const target = path.resolve(aiRoot, ...segments);
  const base = aiRoot.endsWith(path.sep) ? aiRoot : `${aiRoot}${path.sep}`;
  return target.startsWith(base) ? target : null;
}

function manifestFileRecords(manifest) {
  if (Array.isArray(manifest?.files)) return manifest.files.filter(isPlainObject);
  return isPlainObject(manifest?.files) ? [manifest.files] : [];
}

function statePaths(aiRoot) {
  const stateDir = path.join(aiRoot, ".runtime", "platform");
  return { stateDir, depsState: path.join(stateDir, "deps-state.json"), stageRoot: path.join(stateDir, "npm-stage") };
}

function stageName(dir) {
  return dir === "." ? "_root" : String(dir).replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Step 1: prune

/** The reason a recorded path may never be pruned, or null. */
function protectedReason(relPath) {
  const parts = toSlash(relPath).toLowerCase().split("/");
  const slash = parts.join("/");
  if (PROTECTED_PREFIXES.some((prefix) => slash.startsWith(prefix))) return "protected";
  if (parts.includes("node_modules")) return "protected";
  if (parts.length >= 3 && PROTECTED_SECOND_SEGMENTS.includes(parts[1])) return "protected";
  return null;
}

// Manifests in deployedAt order (compared as text, like Get-LiveDrift), later
// records with an afterSha256 replacing earlier ones, paths case-insensitive.
function latestRecords(allManifests) {
  const entries = (Array.isArray(allManifests) ? allManifests : [])
    .map((entry) => ({ deployedAt: String(entry?.deployedAt ?? entry?.data?.deployedAt ?? ""), data: entry?.data || entry }))
    .filter((entry) => isPlainObject(entry.data));
  entries.sort((left, right) => (left.deployedAt === right.deployedAt ? 0 : left.deployedAt < right.deployedAt ? -1 : 1));
  const latest = new Map();
  for (const entry of entries) {
    for (const record of manifestFileRecords(entry.data)) {
      const sha = record.afterSha256;
      if (sha === undefined || sha === null || sha === "" || sha === false) continue;
      const filePath = toBackslash(record.path);
      if (!filePath) continue;
      const key = filePath.toLowerCase();
      const prior = latest.get(key);
      latest.set(key, { path: prior ? prior.path : filePath, afterSha256: String(sha).toLowerCase(), kind: record.kind || null });
    }
  }
  return latest;
}

/**
 * §9.3 step 1. Read-only. Returns { candidates: [{ path, sha256 }], kept:
 * [{ path, reason }] } where candidates are the paths whose latest record
 * (across allManifests) is absent from the current manifest, whose live file
 * still has the recorded afterSha256 and which are outside the protected
 * prefixes. Drifted files are kept with reason "drifted"; a file that is
 * already gone is neither.
 */
function computePruneCandidates({ aiRoot, manifest, allManifests, fs: fsImpl = nodeFs } = {}) {
  const root = path.resolve(String(aiRoot || ""));
  const current = new Set(manifestFileRecords(manifest).map((record) => toBackslash(record.path).toLowerCase()));
  const keepLocalExtensions = manifest?.includeLocalExtensions !== true;
  const candidates = [];
  const kept = [];
  for (const [key, record] of latestRecords(allManifests)) {
    if (current.has(key)) continue;
    const target = liveFile(root, record.path);
    if (!target) { kept.push({ path: record.path, reason: "unsafe_path" }); continue; }
    const reason = protectedReason(record.path);
    if (reason) { kept.push({ path: record.path, reason }); continue; }
    if (keepLocalExtensions && record.kind === "local-extension") { kept.push({ path: record.path, reason: "local_extension" }); continue; }
    if (!isFile(fsImpl, target)) continue;
    const liveSha = hashFile(fsImpl, target);
    if (liveSha === null) { kept.push({ path: record.path, reason: "unreadable" }); continue; }
    if (liveSha !== record.afterSha256) { kept.push({ path: record.path, reason: "drifted" }); continue; }
    candidates.push({ path: record.path, sha256: liveSha });
  }
  const byPath = (left, right) => (left.path.toLowerCase() < right.path.toLowerCase() ? -1 : left.path.toLowerCase() > right.path.toLowerCase() ? 1 : 0);
  return { candidates: candidates.sort(byPath), kept: kept.sort(byPath) };
}

function removeEmptyParents(fsImpl, root, start) {
  let dir = path.dirname(start);
  const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  while (dir.startsWith(base)) {
    try {
      if (fsImpl.readdirSync(dir).length > 0) return;
      fsImpl.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// Copies every candidate to <backupRoot>\pruned\<path>, verifies the copy, then
// deletes the live file and empty directories. A failure is recorded and the
// next candidate is still tried.
function pruneFiles({ aiRoot, backupRoot, candidates, fs: fsImpl = nodeFs }) {
  const root = path.resolve(aiRoot);
  const pruned = [];
  const failed = [];
  for (const candidate of candidates) {
    const target = liveFile(root, candidate.path);
    try {
      if (!target) throw Object.assign(new Error("unsafe path"), { code: "unsafe_path" });
      const backup = path.join(backupRoot, PRUNED_DIR, ...segmentsOf(candidate.path));
      fsImpl.mkdirSync(path.dirname(backup), { recursive: true });
      fsImpl.copyFileSync(target, backup);
      if (hashFile(fsImpl, backup) !== candidate.sha256) throw Object.assign(new Error("backup copy does not match"), { code: "backup_mismatch" });
      // The file may have been edited since it was hashed; never delete that.
      if (hashFile(fsImpl, target) !== candidate.sha256) throw Object.assign(new Error("file changed while pruning"), { code: "changed" });
      fsImpl.unlinkSync(target);
      removeEmptyParents(fsImpl, root, target);
      pruned.push(candidate.path);
    } catch (error) {
      failed.push({ path: candidate.path, code: String(error?.code || "prune_failed") });
    }
  }
  return { pruned, failed };
}

// ---------------------------------------------------------------------------
// Step 2: dependencies

function savedDepsEntry(state, dir) {
  return state?.packages?.[dir] || state?.[dir] || null;
}

function readDepsState(fsImpl, aiRoot) {
  const state = readJsonFile(fsImpl, statePaths(aiRoot).depsState, {});
  return isPlainObject(state) ? state : {};
}

// Keeps unknown entries and the legacy flat shape readable; always writes the
// { schemaVersion, packages } shape the doctor and `platform deps` read.
function writeDepsEntry(fsImpl, aiRoot, dir, entry) {
  const state = readDepsState(fsImpl, aiRoot);
  const packages = isPlainObject(state.packages) ? { ...state.packages } : {};
  if (entry) packages[dir] = entry;
  else delete packages[dir];
  writeJsonFile(fsImpl, statePaths(aiRoot).depsState, { ...state, schemaVersion: DEPS_STATE_SCHEMA_VERSION, packages });
}

function lockMatchesInstalled(fsImpl, packageDir) {
  const { lockVersionsMatch } = require("./doctor-probes");
  return lockVersionsMatch(readJsonFile(fsImpl, path.join(packageDir, "package-lock.json")), readJsonFile(fsImpl, path.join(packageDir, "node_modules", ".package-lock.json")));
}

/**
 * §9.3 step 2, the decision only (read-only). One entry per package:
 * action "ok" (lock matches the recorded hash), "record" (never recorded but
 * node_modules matches the lock: just write the stamp), "install" (staged
 * npm ci + swap) or "swap" (a staged install from an earlier post-deploy is
 * waiting for the swap). `only` limits the packages and, with `force`, always
 * installs them (`platform deps --install`).
 */
function planDependencies({ aiRoot, registry, depsState, fs: fsImpl = nodeFs, only = null, force = false } = {}) {
  const root = path.resolve(aiRoot);
  const state = depsState || readDepsState(fsImpl, root);
  const steps = [];
  for (const pkg of registry?.packages || []) {
    if (only ? !only.includes(pkg.dir) : pkg.live !== true) continue;
    const dir = path.resolve(root, pkg.dir);
    const lockSha256 = hashFile(fsImpl, path.join(dir, "package-lock.json"));
    const base = { package: pkg.dir, components: Array.isArray(pkg.components) ? pkg.components : [], lockSha256 };
    if (!isFile(fsImpl, path.join(dir, "package.json"))) { steps.push({ ...base, action: "skip", reason: "no_package_json" }); continue; }
    if (!lockSha256) { steps.push({ ...base, action: "skip", reason: "no_lock" }); continue; }
    const saved = savedDepsEntry(state, pkg.dir);
    const installed = isDirectory(fsImpl, path.join(dir, "node_modules"));
    const pending = saved?.pendingSwap;
    const staged = pending && typeof pending.stage === "string" ? path.resolve(root, ...segmentsOf(pending.stage)) : null;
    if (!force && pending?.lockSha256 === lockSha256 && staged && isDirectory(fsImpl, staged)) {
      steps.push({ ...base, action: "swap", reason: "pending_swap" });
    } else if (force) {
      steps.push({ ...base, action: "install", reason: "requested" });
    } else if (!installed) {
      steps.push({ ...base, action: "install", reason: "node_modules_missing" });
    } else if (saved?.lockSha256) {
      steps.push(saved.lockSha256 === lockSha256 ? { ...base, action: "ok", reason: "lock_unchanged" } : { ...base, action: "install", reason: "lock_changed" });
    } else if (lockMatchesInstalled(fsImpl, dir) === true) {
      steps.push({ ...base, action: "record", reason: "not_recorded" });
    } else {
      steps.push({ ...base, action: "install", reason: "not_recorded" });
    }
  }
  return steps;
}

// Default npm runner. Node refuses to spawn npm.cmd without a shell, so use the
// npm-cli.js that ships beside node.exe and fall back to cmd.exe /c npm.
function defaultNpm(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    let command = "npm";
    let argv = args;
    if (nodeFs.existsSync(npmCli)) {
      command = process.execPath;
      argv = [npmCli, ...args];
    } else if (process.platform === "win32") {
      command = process.env.ComSpec || "cmd.exe";
      argv = ["/d", "/s", "/c", "npm", ...args];
    }
    childProcess.execFile(command, argv, { cwd, env: env || process.env, windowsHide: true, timeout: NPM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || error?.message || "") });
    });
  });
}

function tail(text, max = 400) {
  const value = String(text || "").trim();
  return value.length > max ? `...${value.slice(-max)}` : value;
}

function relToRoot(aiRoot, file) {
  return path.relative(aiRoot, file).split(path.sep).join("/");
}

/**
 * Moves a staged node_modules into place. The live one is renamed to
 * node_modules.prev-<stamp> first (same volume, so both renames are atomic).
 * status "swapped", "pending" (EBUSY/EPERM: the caller records pendingSwap) or
 * "failed". A failure of the second rename puts the old directory back.
 */
function swapNodeModules({ packageDir, stagedModules, stamp, fs: fsImpl = nodeFs }) {
  const live = path.join(packageDir, "node_modules");
  const previous = path.join(packageDir, `node_modules.prev-${stamp}`);
  const hadLive = isDirectory(fsImpl, live);
  const outcome = (error) => ({ status: SWAP_RETRY_CODES.has(error?.code) ? "pending" : "failed", code: String(error?.code || "swap_failed") });
  if (hadLive) {
    try { fsImpl.renameSync(live, previous); } catch (error) { return outcome(error); }
  }
  try {
    fsImpl.renameSync(stagedModules, live);
  } catch (error) {
    if (hadLive) {
      try { fsImpl.renameSync(previous, live); } catch { return { status: "failed", code: "swap_rollback_failed" }; }
    }
    return outcome(error);
  }
  return { status: "swapped", previous: hadLive ? path.basename(previous) : null };
}

function recordInstalled(fsImpl, aiRoot, dir, lockSha256, ms, nodeVersion) {
  writeDepsEntry(fsImpl, aiRoot, dir, { lockSha256, installedAt: new Date(ms).toISOString(), node: nodeVersion });
}

function removeTree(fsImpl, target) {
  try { fsImpl.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
}

// node_modules.prev-* directories older than 7 days (by their stamp, else mtime).
function cleanupPreviousModules({ aiRoot, registry, fs: fsImpl = nodeFs, now = Date.now }) {
  const removed = [];
  const current = nowMs(now);
  for (const pkg of registry?.packages || []) {
    if (pkg.live !== true) continue;
    const dir = path.resolve(aiRoot, pkg.dir);
    let entries = [];
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const match = /^node_modules\.prev-(.+)$/.exec(entry.name);
      if (!match || !entry.isDirectory()) continue;
      let at = parseStamp(match[1]);
      if (Number.isNaN(at)) { try { at = fsImpl.statSync(path.join(dir, entry.name)).mtimeMs; } catch { continue; } }
      if (current - at <= PREVIOUS_MODULES_MAX_AGE_MS) continue;
      removeTree(fsImpl, path.join(dir, entry.name));
      if (!isDirectory(fsImpl, path.join(dir, entry.name))) removed.push(`${toSlash(pkg.dir)}/${entry.name}`);
    }
  }
  return removed;
}

function pendingEntry(saved, aiRoot, stagedModules, lockSha256, ms) {
  return {
    ...(saved && typeof saved.lockSha256 === "string" ? { lockSha256: saved.lockSha256 } : {}),
    ...(saved?.installedAt ? { installedAt: saved.installedAt } : {}),
    ...(saved?.node ? { node: saved.node } : {}),
    pendingSwap: { lockSha256, stage: relToRoot(aiRoot, stagedModules), stagedAt: new Date(ms).toISOString() },
  };
}

async function executeDependencyStep(step, ctx) {
  const { aiRoot, fs: fsImpl, npm, nodeVersion, log } = ctx;
  const ms = nowMs(ctx.now);
  const result = { package: step.package, action: step.action, reason: step.reason, components: step.components };
  const packageDir = path.resolve(aiRoot, step.package);
  const paths = statePaths(aiRoot);
  const saved = savedDepsEntry(readDepsState(fsImpl, aiRoot), step.package);
  if (step.action === "ok" || step.action === "skip") return { ...result, status: step.action === "ok" ? "ok" : "skipped" };
  if (step.action === "record") {
    recordInstalled(fsImpl, aiRoot, step.package, step.lockSha256, ms, nodeVersion);
    return { ...result, status: "recorded" };
  }
  const stage = path.join(paths.stageRoot, stageName(step.package));
  const stagedModules = path.join(stage, "node_modules");
  const stamp = stampOf(ms);
  if (step.action === "install") {
    try {
      removeTree(fsImpl, stage);
      fsImpl.mkdirSync(stage, { recursive: true });
      for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
        const source = path.join(packageDir, name);
        if (isFile(fsImpl, source)) fsImpl.copyFileSync(source, path.join(stage, name));
      }
      log?.(`npm ci (${step.package})`);
      const run = await npm(["ci", "--no-audit", "--no-fund"], { cwd: stage, env: ctx.env });
      if (run.code !== 0) return { ...result, status: "failed", code: "npm_failed", exitCode: run.code, detail: tail(run.stderr || run.stdout) };
      if (!isDirectory(fsImpl, stagedModules)) return { ...result, status: "failed", code: "npm_no_modules", detail: "npm ci produced no node_modules." };
    } catch (error) {
      return { ...result, status: "failed", code: String(error?.code || "npm_failed"), detail: tail(error?.message) };
    }
  }
  const swap = swapNodeModules({ packageDir, stagedModules, stamp, fs: fsImpl });
  if (swap.status === "swapped") {
    recordInstalled(fsImpl, aiRoot, step.package, step.lockSha256, ms, nodeVersion);
    removeTree(fsImpl, stage);
    return { ...result, status: "installed", ran: step.action === "install", previous: swap.previous };
  }
  if (swap.status === "pending") {
    writeDepsEntry(fsImpl, aiRoot, step.package, pendingEntry(saved, aiRoot, stagedModules, step.lockSha256, ms));
    return { ...result, status: "pendingSwap", ran: step.action === "install", code: swap.code, stage: relToRoot(aiRoot, stagedModules) };
  }
  return { ...result, status: "failed", code: swap.code, detail: "node_modules could not be swapped; the live one is untouched." };
}

/**
 * Runs the dependency decisions: staged install + swap per package, then the
 * cleanup of old node_modules.prev-* directories. Returns { packages, removed }.
 * A package whose npm run fails keeps its live node_modules and reports
 * status "failed"; the other packages still run.
 */
async function runDependencies(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const aiRoot = path.resolve(options.aiRoot);
  const steps = options.steps || planDependencies({ aiRoot, registry: options.registry, fs: fsImpl, only: options.only, force: options.force });
  const ctx = {
    aiRoot, fs: fsImpl, npm: options.npm || defaultNpm, now: options.now || Date.now, env: options.env,
    nodeVersion: options.nodeVersion || process.version, log: options.log,
  };
  const packages = [];
  for (const step of steps) packages.push(await executeDependencyStep(step, ctx));
  const removed = options.cleanup === false ? [] : cleanupPreviousModules({ aiRoot, registry: options.registry, fs: fsImpl, now: ctx.now });
  return { packages, removed };
}

/**
 * Finishes the swaps that post-deploy could not (EBUSY/EPERM). The supervisor
 * calls this for a component's package while the component is stopped, before
 * it spawns. Returns [{ package, status: "swapped" | "pending" | "failed" |
 * "none" }]; a swap that is refused again stays recorded.
 */
function applyPendingSwaps({ aiRoot, packages = null, fs: fsImpl = nodeFs, now = Date.now, nodeVersion = process.version } = {}) {
  const root = path.resolve(aiRoot);
  const state = readDepsState(fsImpl, root);
  const results = [];
  for (const [dir, entry] of Object.entries(isPlainObject(state.packages) ? state.packages : {})) {
    if (packages && !packages.includes(dir)) continue;
    const pending = entry?.pendingSwap;
    if (!isPlainObject(pending) || typeof pending.stage !== "string") continue;
    const stagedModules = path.resolve(root, ...segmentsOf(pending.stage));
    const packageDir = path.resolve(root, ...segmentsOf(dir));
    const inside = (target) => target.startsWith(`${root}${path.sep}`);
    if (!inside(stagedModules) || !inside(packageDir) || !isDirectory(fsImpl, stagedModules)) {
      writeDepsEntry(fsImpl, root, dir, withoutPending(entry));
      results.push({ package: dir, status: "none" });
      continue;
    }
    const ms = nowMs(now);
    const swap = swapNodeModules({ packageDir, stagedModules, stamp: stampOf(ms), fs: fsImpl });
    if (swap.status === "swapped") {
      recordInstalled(fsImpl, root, dir, pending.lockSha256, ms, nodeVersion);
      removeTree(fsImpl, path.dirname(stagedModules));
    }
    results.push({ package: dir, status: swap.status, ...(swap.code ? { code: swap.code } : {}) });
  }
  return results;
}

function withoutPending(entry) {
  const rest = { ...entry };
  delete rest.pendingSwap;
  return rest;
}

/**
 * `platform deps --record` (install-all.cmd calls it last). Writes the lock
 * hash of every package that has a lock and node_modules, plus
 * the MCP build stamp when its dist exists. Returns { packages, mcp }.
 */
async function recordDependencyState({ aiRoot, registry, fs: fsImpl = nodeFs, now = Date.now, nodeVersion = process.version } = {}) {
  const root = path.resolve(aiRoot);
  const ms = nowMs(now);
  const packages = [];
  for (const pkg of registry?.packages || []) {
    const dir = path.resolve(root, pkg.dir);
    const lockSha256 = hashFile(fsImpl, path.join(dir, "package-lock.json"));
    if (!lockSha256 || !isDirectory(fsImpl, path.join(dir, "node_modules"))) {
      packages.push({ package: pkg.dir, status: "skipped" });
      continue;
    }
    recordInstalled(fsImpl, root, pkg.dir, lockSha256, ms, nodeVersion);
    packages.push({ package: pkg.dir, status: "recorded", lockSha256 });
  }
  let mcp = null;
  const buildPackage = (registry?.packages || []).find((pkg) => pkg.build);
  if (buildPackage) {
    const plan = planMcpBuild({ aiRoot: root, registry, fs: fsImpl });
    if (plan.exists) {
      writeBuildStamp({ aiRoot: root, plan, fs: fsImpl, now: ms, nodeVersion });
      mcp = { package: buildPackage.dir, status: "recorded", srcSha256: plan.currentHash };
    } else {
      mcp = { package: buildPackage.dir, status: "missing" };
    }
  }
  return { packages, mcp };
}

// ---------------------------------------------------------------------------
// Step 3: MCP build

function buildPackageOf(registry, only) {
  return (registry?.packages || []).find((pkg) => pkg.build && (!only || pkg.dir === only)) || null;
}

/**
 * §9.3 step 3, the decision (read-only): the package with a `build`, whether
 * dist/src/index.js exists, the hash of the build inputs and the hash in
 * dist/.build-stamp.json. `needed` when dist is missing or the two hashes differ.
 */
function planMcpBuild({ aiRoot, registry, fs: fsImpl = nodeFs } = {}) {
  const pkg = buildPackageOf(registry);
  if (!pkg) return null;
  const dir = path.resolve(aiRoot, pkg.dir);
  const { hashBuildInputs } = require("./doctor-probes");
  const stamp = readJsonFile(fsImpl, path.join(dir, pkg.build.stamp), null);
  const exists = isFile(fsImpl, path.join(dir, "dist", "src", "index.js"));
  const currentHash = isDirectory(fsImpl, dir) ? hashBuildInputs(dir, pkg.build.inputs) : null;
  const stampHash = typeof stamp?.srcSha256 === "string" ? stamp.srcSha256 : null;
  let reason = "current";
  if (!isDirectory(fsImpl, dir)) reason = "package_missing";
  else if (!exists) reason = "dist_missing";
  else if (!stampHash) reason = "stamp_missing";
  else if (stampHash !== currentHash) reason = "stamp_mismatch";
  return {
    package: pkg.dir, script: pkg.build.script || "build", stamp: pkg.build.stamp, inputs: pkg.build.inputs,
    components: Array.isArray(pkg.components) ? pkg.components : [],
    exists, currentHash, stampHash, needed: reason !== "current" && reason !== "package_missing", reason,
  };
}

function writeBuildStamp({ aiRoot, plan, fs: fsImpl = nodeFs, now = Date.now, nodeVersion = process.version }) {
  const dir = path.resolve(aiRoot, plan.package);
  const tscPackage = readJsonFile(fsImpl, path.join(dir, "node_modules", "typescript", "package.json"), null);
  const stamp = { srcSha256: plan.currentHash, builtAt: new Date(nowMs(now)).toISOString(), node: nodeVersion, tsc: typeof tscPackage?.version === "string" ? tscPackage.version : null };
  writeJsonFile(fsImpl, path.join(dir, plan.stamp), stamp);
  return stamp;
}

async function runMcpBuild({ aiRoot, plan, fs: fsImpl = nodeFs, npm = defaultNpm, now = Date.now, nodeVersion = process.version, env, log } = {}) {
  const dir = path.resolve(aiRoot, plan.package);
  try {
    log?.(`npm run ${plan.script} (${plan.package})`);
    const run = await npm(["run", plan.script], { cwd: dir, env });
    if (run.code !== 0) return { package: plan.package, status: "failed", code: "build_failed", exitCode: run.code, detail: tail(run.stderr || run.stdout) };
    if (!isFile(fsImpl, path.join(dir, "dist", "src", "index.js"))) return { package: plan.package, status: "failed", code: "build_no_output", detail: "The build produced no dist/src/index.js." };
    const stamp = writeBuildStamp({ aiRoot, plan, fs: fsImpl, now, nodeVersion });
    return { package: plan.package, status: "built", srcSha256: stamp.srcSha256, reason: plan.reason };
  } catch (error) {
    return { package: plan.package, status: "failed", code: String(error?.code || "build_failed"), detail: tail(error?.message) };
  }
}

// ---------------------------------------------------------------------------
// Step 4: version.json

function versionOf(manifest, aiRoot, fsImpl) {
  const archive = typeof manifest?.archive === "string" ? path.win32.basename(manifest.archive) : "";
  const match = /-v([0-9A-Za-z][0-9A-Za-z._-]*)\.zip$/.exec(archive);
  if (match) return match[1];
  const pkg = readJsonFile(fsImpl, path.join(aiRoot, "package.json"), null);
  const commit = String(manifest?.commit || "");
  return typeof pkg?.version === "string" && commit ? `${pkg.version}-git-${commit.slice(0, 12)}` : null;
}

function versionRecord({ aiRoot, manifest, manifestFile, summary, fs: fsImpl, now }) {
  const deployedAt = Number.isNaN(Date.parse(String(manifest?.deployedAt ?? ""))) ? new Date(nowMs(now)).toISOString() : String(manifest.deployedAt);
  const commit = String(manifest?.commit || "").toLowerCase();
  return {
    commit,
    shortCommit: commit.slice(0, 12),
    branch: manifest?.branch || null,
    version: versionOf(manifest, aiRoot, fsImpl),
    deployedAt,
    archiveSha256: manifest?.archiveSha256 || null,
    manifest: manifestFile || null,
    sourceWorktree: manifest?.sourceWorktree || null,
    postDeploy: summary,
  };
}

// ---------------------------------------------------------------------------
// Step 5: restart

function restartableIds(registry) {
  return (registry?.components || []).filter((component) => RESTARTABLE_KINDS.has(component.kind) && component.disabled !== true).map((component) => component.id);
}

/**
 * The components a deploy touches (§9.3 step 5): componentsForPaths over the
 * created, updated and pruned paths, plus the components of packages whose
 * dependencies were swapped or staged and of a rebuilt MCP. mode "all" lists
 * every restartable component. The pseudo id `supervisor` is never in ids; it
 * sets `reexec` (a supervisor change needs a re-exec before any restart).
 * Model containers are not components and are never listed.
 */
function restartComponents({ registry, manifest, prunedPaths = [], dependencyPackages = [], mcpBuilt = false, mode = "changed" } = {}) {
  const paths = manifestFileRecords(manifest).filter((record) => record.action === "created" || record.action === "updated").map((record) => record.path);
  const changed = components.componentsForPaths(registry, [...paths, ...prunedPaths]);
  for (const pkg of dependencyPackages) for (const id of pkg.components || []) changed.add(id);
  if (mcpBuilt) {
    const build = buildPackageOf(registry);
    for (const id of build?.components || []) changed.add(id);
  }
  const reexec = changed.has(components.SUPERVISOR_ID);
  changed.delete(components.SUPERVISOR_ID);
  const known = new Set((registry?.components || []).map((component) => component.id));
  const ids = mode === "all" ? restartableIds(registry) : [...changed].filter((id) => known.has(id)).sort();
  return { ids, reexec };
}

const REEXEC_WAIT_MS = 20000;
const REEXEC_POLL_MS = 300;

function restartError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The restart adapter used by `platform post-deploy` (§9.3 step 5), over a
 * control client ({ available(), request(method, route, {body, timeoutMs}) },
 * 5.14). Without a reachable supervisor it throws supervisor_unavailable, which
 * runRestart turns into the printed commands (exit 0). With one:
 *   1. a `supervisor` change (reexec) calls POST /v1/reexec first and waits
 *      for the new process (a different pid answering /v1/status); a re-exec
 *      that does not complete throws reexec_failed and restarts nothing;
 *   2. every component then gets POST /v1/components/:id/restart {when:"idle"}:
 *      idle ones restart now, busy ones are queued (5.11) with their blockers.
 * A failed single restart is recorded in `failed`, never thrown. Model
 * containers are not components and never appear here.
 * Test seams: sleep(ms), now().
 */
async function restartViaSupervisor({ ids = [], reexec = false, control, sleep, now = Date.now } = {}) {
  if (!control || typeof control.request !== "function") throw restartError("supervisor_unavailable", "No supervisor control client.");
  let up = false;
  try { up = await control.available(); } catch { up = false; }
  if (!up) throw restartError("supervisor_unavailable", "The supervisor is not running.");
  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const outcome = { reexeced: false, restarted: [], queued: [], failed: [] };

  if (reexec) {
    const before = (await control.request("GET", "/v1/status", { timeoutMs: 3000 }))?.json?.supervisor?.pid ?? null;
    const asked = await control.request("POST", "/v1/reexec", { body: {}, timeoutMs: 15000 });
    if (!asked || asked.status >= 300) throw restartError("reexec_failed", "The supervisor refused the re-exec.");
    const deadline = now() + REEXEC_WAIT_MS;
    for (;;) {
      await pause(REEXEC_POLL_MS);
      try {
        const status = await control.request("GET", "/v1/status", { timeoutMs: 2000 });
        const pid = status?.json?.supervisor?.pid ?? null;
        if (status?.status === 200 && pid !== null && pid !== before) break;
      } catch { /* the pipe is briefly closed during the hand-off */ }
      if (now() >= deadline) throw restartError("reexec_failed", "The re-exec did not complete.");
    }
    outcome.reexeced = true;
  }

  for (const id of ids) {
    try {
      const result = await control.request("POST", `/v1/components/${id}/restart`, { body: { when: "idle" }, timeoutMs: 15000 });
      if (!result || result.status >= 300) {
        outcome.failed.push({ id, code: String(result?.json?.error?.code || `http_${result?.status}`) });
      } else if (result.json?.queued) {
        outcome.queued.push({ id, blockers: Array.isArray(result.json.blockers) ? result.json.blockers : [] });
      } else {
        outcome.restarted.push(id);
      }
    } catch (error) {
      if (error?.code === "supervisor_unavailable") throw error;
      outcome.failed.push({ id, code: String(error?.code || "restart_failed") });
    }
  }
  return outcome;
}

async function runRestart({ mode, ids, reexec, adapter }) {
  const commands = [];
  if (reexec) commands.push("platform supervisor reexec");
  if (ids.length) commands.push(`platform restart ${ids.join(" ")} --when-idle`);
  if (mode === "none") return { mode, ids, reexec, action: "listed", commands };
  if (!ids.length && !reexec) return { mode, ids, reexec, action: "nothing", commands: [] };
  if (typeof adapter !== "function") return { mode, ids, reexec, action: "commands", commands };
  try {
    const outcome = await adapter({ ids, reexec, when: "idle" });
    return { mode, ids, reexec, action: "requested", commands, ...(isPlainObject(outcome) ? { outcome } : {}) };
  } catch (error) {
    // Restarting is a convenience; the files are deployed. Show the commands.
    return { mode, ids, reexec, action: "commands", commands, code: String(error?.code || "restart_failed") };
  }
}

// ---------------------------------------------------------------------------
// Plan and execution

function normalizeMode(restart) {
  const mode = restart === undefined || restart === null || restart === "" ? "none" : String(restart);
  if (!RESTART_MODES.includes(mode)) throw Object.assign(new Error(`restart must be one of ${RESTART_MODES.join(", ")}.`), { code: "restart_invalid" });
  return mode;
}

/**
 * §9.3: the post-deploy plan, read-only. { steps: [prune, dependencies,
 * mcp-build, version, restart] } in execution order. The restart step
 * is computed from what the earlier steps are going to do.
 */
function planPostDeploy({ aiRoot, manifest, allManifests, registry, depsState, restart = "none", noPrune = false, fs: fsImpl = nodeFs } = {}) {
  const root = path.resolve(aiRoot);
  const mode = normalizeMode(restart);
  const prune = noPrune
    ? { id: "prune", skipped: "no-prune", candidates: [], kept: [] }
    : { id: "prune", skipped: null, ...computePruneCandidates({ aiRoot: root, manifest, allManifests, fs: fsImpl }) };
  const dependencies = { id: "dependencies", packages: planDependencies({ aiRoot: root, registry, depsState, fs: fsImpl }) };
  const mcp = planMcpBuild({ aiRoot: root, registry, fs: fsImpl });
  // A lock change in the build package changes the build inputs; the plan
  // cannot see the post-install state, so a staged install there implies a build.
  const installsMcp = Boolean(mcp) && dependencies.packages.some((step) => step.package === mcp.package && (step.action === "install" || step.action === "swap"));
  const build = { id: "mcp-build", ...(mcp ? { ...mcp, needed: mcp.needed || installsMcp } : { needed: false, reason: "no_build_package" }) };
  const version = { id: "version", commit: String(manifest?.commit || "").toLowerCase() || null, branch: manifest?.branch || null, version: versionOf(manifest, root, fsImpl) };
  const touched = restartComponents({
    registry, manifest, prunedPaths: prune.candidates.map((item) => item.path),
    dependencyPackages: dependencies.packages.filter((step) => step.action === "install" || step.action === "swap"),
    mcpBuilt: build.needed, mode,
  });
  return { schemaVersion: POST_DEPLOY_SCHEMA_VERSION, steps: [prune, dependencies, build, version, { id: "restart", mode, ...touched }] };
}

function manifestEntryFor(manifestFile, manifest, allManifests) {
  const list = Array.isArray(allManifests) ? [...allManifests] : [];
  const resolved = manifestFile ? path.resolve(manifestFile).toLowerCase() : null;
  const known = list.some((entry) => (resolved && entry.file && path.resolve(entry.file).toLowerCase() === resolved) || entry.data === manifest);
  if (!known) list.push({ file: manifestFile || null, deployedAt: String(manifest?.deployedAt ?? ""), data: manifest });
  return list;
}

/**
 * Runs the post-steps (§9.3) and writes <backupRoot>\post-deploy.json. With
 * dryRun nothing is written or run: the result is the plan. Steps are
 * independent; a failed step is listed in `failed` and the rest still run, so
 * version.json always records the deployed commit. `ok` is false when any step
 * failed (the CLI exits 1).
 *
 * Options: aiRoot, manifest (parsed), manifestFile, backupRoot, allManifests,
 * registry, restart ("none"|"changed"|"all"), noPrune, dryRun, and the test
 * seams fs, npm(args, {cwd, env}) -> {code, stdout, stderr}, now, nodeVersion,
 * restartAdapter({ids, reexec, when}) (OPS-11b), log(line).
 */
async function executePostDeploy(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const aiRoot = path.resolve(options.aiRoot);
  const manifest = options.manifest;
  if (!isPlainObject(manifest)) throw Object.assign(new Error("A deployment manifest is required."), { code: "manifest_invalid" });
  const mode = normalizeMode(options.restart);
  const backupRoot = options.backupRoot ? path.resolve(options.backupRoot) : (options.manifestFile ? path.dirname(path.resolve(options.manifestFile)) : null);
  const registry = options.registry;
  const allManifests = manifestEntryFor(options.manifestFile, manifest, options.allManifests || versionApi.readDeploymentManifests(aiRoot, { fs: fsImpl }));
  const log = options.log || (() => {});
  const startedAt = new Date(nowMs(options.now)).toISOString();
  const nodeVersion = options.nodeVersion || process.version;

  const plan = planPostDeploy({ aiRoot, manifest, allManifests, registry, restart: mode, noPrune: options.noPrune === true, fs: fsImpl });
  const [pruneStep, depsStep] = plan.steps;
  if (options.dryRun === true) {
    return { schemaVersion: POST_DEPLOY_SCHEMA_VERSION, ok: true, dryRun: true, startedAt, restart: mode, plan, failed: [] };
  }
  if (!backupRoot) throw Object.assign(new Error("A backup root is required."), { code: "backup_root_missing" });

  const failed = [];
  const result = {
    schemaVersion: POST_DEPLOY_SCHEMA_VERSION, ok: true, dryRun: false, startedAt, finishedAt: null,
    commit: String(manifest.commit || "") || null, restart: mode,
    pruneSkipped: Boolean(pruneStep.skipped), pruned: [], kept: [], pruneFailed: [], dependencies: [], npm: [], pendingSwap: [], removedModules: [],
    mcpBuild: false, mcp: null, version: null, restartResult: null, failed,
  };

  // 1. prune
  if (pruneStep.skipped) {
    result.kept = [];
  } else {
    log(`prune: ${pruneStep.candidates.length} candidate(s)`);
    const done = pruneFiles({ aiRoot, backupRoot, candidates: pruneStep.candidates, fs: fsImpl });
    result.pruned = done.pruned;
    result.pruneFailed = done.failed;
    result.kept = pruneStep.kept;
    if (done.failed.length) failed.push("prune");
  }

  // 2. dependencies
  try {
    const deps = await runDependencies({
      aiRoot, registry, steps: depsStep.packages, fs: fsImpl, npm: options.npm, now: options.now, env: options.env, nodeVersion, log,
    });
    result.dependencies = deps.packages;
    result.removedModules = deps.removed;
    result.npm = deps.packages.filter((item) => item.ran === true).map((item) => item.package);
    result.pendingSwap = deps.packages.filter((item) => item.status === "pendingSwap").map((item) => item.package);
    if (deps.packages.some((item) => item.status === "failed")) failed.push("dependencies");
  } catch (error) {
    result.dependencies = [{ status: "failed", code: String(error?.code || "dependencies_failed"), detail: tail(error?.message) }];
    failed.push("dependencies");
  }

  // 3. MCP build. The decision is re-made now: a staged install may have
  // changed the build inputs (package-lock.json is one of them).
  let mcpPlan = null;
  try { mcpPlan = planMcpBuild({ aiRoot, registry, fs: fsImpl }); } catch (error) { result.mcp = { status: "failed", code: String(error?.code || "build_plan_failed"), detail: tail(error?.message) }; failed.push("mcp-build"); }
  if (mcpPlan) {
    if (mcpPlan.needed) {
      result.mcp = await runMcpBuild({ aiRoot, plan: mcpPlan, fs: fsImpl, npm: options.npm || defaultNpm, now: options.now, nodeVersion, env: options.env, log });
      result.mcpBuild = result.mcp.status === "built";
      if (result.mcp.status === "failed") failed.push("mcp-build");
    } else {
      result.mcp = { package: mcpPlan.package, status: mcpPlan.reason === "package_missing" ? "skipped" : "current", reason: mcpPlan.reason };
    }
  }

  // 5 (decided before 4 so version.json can say what was restarted).
  const touched = restartComponents({
    registry, manifest, prunedPaths: result.pruned,
    dependencyPackages: result.dependencies.filter((item) => item.status === "installed" || item.status === "pendingSwap"),
    mcpBuilt: result.mcpBuild, mode,
  });

  // 4. version.json
  const summary = { pruned: result.pruned.length, npm: result.npm, mcpBuild: result.mcpBuild, restart: mode };
  try {
    const manifestRef = options.manifestFile ? path.resolve(options.manifestFile) : null;
    const written = await versionApi.writeVersionFile(aiRoot, versionRecord({ aiRoot, manifest, manifestFile: manifestRef, summary, fs: fsImpl, now: options.now }));
    result.version = { written: true, commit: written.commit, version: written.version };
  } catch (error) {
    result.version = { written: false, code: String(error?.code || "version_failed"), detail: tail(error?.message) };
    failed.push("version");
  }

  // 5. restart
  result.restartResult = await runRestart({ mode, ids: touched.ids, reexec: touched.reexec, adapter: options.restartAdapter });

  result.ok = failed.length === 0;
  result.finishedAt = new Date(nowMs(options.now)).toISOString();
  try {
    writeJsonFile(fsImpl, path.join(backupRoot, POST_DEPLOY_NAME), result);
  } catch (error) {
    result.ok = false;
    failed.push("post-deploy.json");
    result.writeError = String(error?.code || "write_failed");
  }
  return result;
}

module.exports = {
  POST_DEPLOY_NAME,
  PROTECTED_PREFIXES,
  RESTART_MODES,
  planPostDeploy,
  executePostDeploy,
  computePruneCandidates,
  pruneFiles,
  planDependencies,
  runDependencies,
  applyPendingSwaps,
  swapNodeModules,
  cleanupPreviousModules,
  recordDependencyState,
  readDepsState,
  planMcpBuild,
  runMcpBuild,
  restartComponents,
  restartViaSupervisor,
  protectedReason,
  defaultNpm,
};
