"use strict";

// Version, build id, live drift, deploy history and newer commits
// (docs/overhaul/06-ops.md §9.5, 00 §9.16). Plain CommonJS with no
// dependencies.
//
// - readVersion: <AI_ROOT>/version.json (written by post-deploy, OPS-11a),
//   else the worktree's git HEAD, else only the package version.
// - getBuildId: the single build id. 07's console (/c/<contentHash>/) and 05's
//   portal (/assets/<contentHash>/) template it and never compute their own.
//   It is synchronous and follows file content without a restart, because
//   deploys copy files into a running platform.
// - computeLiveDrift: a Node port of Get-LiveDrift in scripts/deploy-worktree.ps1
//   for the doctor (ops.deploy-drift) and the console's updates page.
// - listDeployments: the deploy backups' manifests, newest first.
// - countNewerCommits: commits on the update branch of <AI_ROOT>/platform-repo.git
//   that the deployed commit does not contain yet.
//
// Every reader tolerates a BOM: Windows PowerShell 5.1 writes the deploy
// manifests with `Set-Content -Encoding UTF8` (V14).

const crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { replaceFileAtomically } = require("../file-utils");

const DEFAULT_AI_ROOT = path.resolve(__dirname, "..", "..");
const VERSION_FILE_NAME = "version.json";
const VERSION_SCHEMA_VERSION = 1;
const PLATFORM_REPO_DIR = "platform-repo.git";
const DEPLOY_BACKUPS_DIR = "artifacts/worktree-deploy-backups";
const DEPLOY_MANIFEST_NAME = "deployment-manifest.json";
const POST_DEPLOY_NAME = "post-deploy.json";

// The static trees the entry serves (00 §9.16, 07 C2, 05 C7c).
const BUILD_ID_ROOTS = Object.freeze(["service-entry/console", "service-entry/portal", "shared-public/vendor", "shared-public/styles"]);
const BUILD_ID_REFRESH_MS = 2000;
const DRIFT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_DEPLOY_LIMIT = 20;
const MAX_DEPLOY_LIMIT = 1000;
const GIT_TIMEOUT_MS = 10000;
const GIT_FETCH_TIMEOUT_MS = 120000;
const DEFAULT_UPDATE_BRANCH = "main";

const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// The schema pattern of updates.branch, without "..", "@{" or a trailing ".lock",
// so the value can only ever name refs/heads/<branch>.
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveRoot(aiRoot, env = process.env) {
  return path.resolve(String(aiRoot || env.AI_ROOT || DEFAULT_AI_ROOT));
}

// Case-insensitive path order, so a listing reads the way Windows sorts it.
function comparePaths(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function statKey(fsImpl, file) {
  try {
    const stat = fsImpl.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "-";
  }
}

function readTextOrNull(fsImpl, file) {
  try {
    return stripBom(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// { exists, value, error }: a missing file is not an error; a BOM is stripped.
function readJsonObject(fsImpl, file) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { exists: false, value: null, error: null };
    return { exists: true, value: null, error: { code: "unreadable", message: `${path.basename(file)} could not be read (${error?.code || "error"}).` } };
  }
  try {
    const value = JSON.parse(stripBom(text));
    if (isPlainObject(value)) return { exists: true, value, error: null };
  } catch {
    // fall through
  }
  return { exists: true, value: null, error: { code: "invalid_json", message: `${path.basename(file)} is not a JSON object.` } };
}

// ---------------------------------------------------------------------------
// git

function runGitSync(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function runGitAsync(args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      // A fetch must never wait for a credential prompt nobody can answer.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

// The git dir of a worktree rooted exactly at `root` (a directory .git or a
// "gitdir:" file), or null. A root merely nested inside some repository does
// not count, so a live root never reports a parent repository's HEAD.
function worktreeGitDir(root, fsImpl) {
  const dotGit = path.join(root, ".git");
  let stat;
  try {
    stat = fsImpl.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readTextOrNull(fsImpl, dotGit) || "");
  return match ? path.resolve(root, match[1]) : null;
}

// Changes whenever HEAD moves (checkout, commit, reset), without spawning git:
// HEAD itself, its reflog and the branch ref it points at (loose, packed or
// reftable).
function gitHeadSignature(gitDir, fsImpl) {
  const head = readTextOrNull(fsImpl, path.join(gitDir, "HEAD"));
  if (head === null) return null;
  const parts = [gitDir, head.trim(), statKey(fsImpl, path.join(gitDir, "logs", "HEAD"))];
  const ref = /^ref:\s*(\S+)/.exec(head);
  if (ref) {
    const commonDir = readTextOrNull(fsImpl, path.join(gitDir, "commondir"));
    const common = commonDir ? path.resolve(gitDir, commonDir.trim()) : gitDir;
    parts.push(
      statKey(fsImpl, path.join(common, ...ref[1].split("/"))),
      statKey(fsImpl, path.join(common, "packed-refs")),
      statKey(fsImpl, path.join(common, "reftable", "tables.list")),
    );
  }
  return parts.join("|");
}

const gitInfoCache = new Map();

// { commit, shortCommit, branch } of the worktree at `root`, or null when root
// is not a worktree or git fails. Cached until HEAD moves.
function readGitInfo(root, { fs: fsImpl = fs, git = runGitSync } = {}) {
  const gitDir = worktreeGitDir(root, fsImpl);
  if (!gitDir) return null;
  const signature = gitHeadSignature(gitDir, fsImpl);
  const cached = gitInfoCache.get(root);
  if (signature && cached && cached.signature === signature && cached.git === git) return cached.info;
  let info = null;
  try {
    const [commit, branch] = String(git(["-C", root, "rev-parse", "HEAD", "--abbrev-ref", "HEAD"])).trim().split(/\r?\n/);
    const shortCommit = String(git(["-C", root, "rev-parse", "--short=12", "HEAD"])).trim();
    if (COMMIT_PATTERN.test(commit || "") && COMMIT_PATTERN.test(shortCommit)) {
      info = { commit, shortCommit, branch: branch && branch !== "HEAD" ? branch : null };
    }
  } catch {
    info = null;
  }
  if (signature) gitInfoCache.set(root, { signature, git, info });
  return info;
}

// ---------------------------------------------------------------------------
// version.json

function packageVersion(root, fsImpl) {
  const { value } = readJsonObject(fsImpl, path.join(root, "package.json"));
  return textOrNull(value?.version);
}

function versionFilePath(aiRoot) {
  return path.join(resolveRoot(aiRoot), VERSION_FILE_NAME);
}

// The valid fields of version.json, or { error }.
function readVersionFile(root, fsImpl) {
  const read = readJsonObject(fsImpl, path.join(root, VERSION_FILE_NAME));
  if (!read.exists) return { exists: false };
  if (read.error) return { exists: true, error: { code: "version_file_invalid", message: read.error.message } };
  const data = read.value;
  const commit = typeof data.commit === "string" ? data.commit.trim().toLowerCase() : "";
  if (!COMMIT_PATTERN.test(commit)) {
    return { exists: true, error: { code: "version_file_invalid", message: "version.json has no valid commit." } };
  }
  const short = typeof data.shortCommit === "string" ? data.shortCommit.trim().toLowerCase() : "";
  return {
    exists: true,
    record: {
      commit,
      shortCommit: COMMIT_PATTERN.test(short) ? short : commit.slice(0, 12),
      branch: textOrNull(data.branch),
      version: textOrNull(data.version),
      deployedAt: textOrNull(data.deployedAt),
      archiveSha256: textOrNull(data.archiveSha256),
      manifest: textOrNull(data.manifest),
      sourceWorktree: textOrNull(data.sourceWorktree),
      postDeploy: isPlainObject(data.postDeploy) ? data.postDeploy : null,
    },
  };
}

/**
 * What is deployed or checked out at aiRoot (06 §9.5). Never throws.
 * source "version.json": the stamp post-deploy wrote. source "git": a worktree,
 * versioned like deploy-worktree.ps1 names a build (<package>-git-<short>).
 * source "unknown": neither; only the package version is known. A corrupt
 * version.json falls through to the next source with `error` set.
 */
function readVersion(aiRoot, options = {}) {
  const fsImpl = options.fs || fs;
  const root = resolveRoot(aiRoot);
  const empty = {
    commit: null, shortCommit: null, branch: null, version: null, deployedAt: null,
    archiveSha256: null, manifest: null, sourceWorktree: null, postDeploy: null,
  };
  const file = readVersionFile(root, fsImpl);
  if (file.record) return { source: "version.json", ...empty, ...file.record };
  const extra = file.error ? { error: file.error } : {};
  const pkg = packageVersion(root, fsImpl);
  const git = readGitInfo(root, { fs: fsImpl, git: options.git });
  if (git) {
    return { source: "git", ...empty, ...git, version: pkg ? `${pkg}-git-${git.shortCommit}` : null, ...extra };
  }
  return { source: "unknown", ...empty, version: pkg, ...extra };
}

function normalizeManifestPath(root, value) {
  const text = textOrNull(value);
  if (!text) return null;
  const relative = path.isAbsolute(text) ? path.relative(root, text) : text;
  const posix = relative.split(/[\\/]+/).filter(Boolean).join("/");
  if (!posix || posix.split("/").includes("..") || path.isAbsolute(posix)) {
    throw versionError("version_invalid", "manifest must be a path inside the AI root.");
  }
  return posix;
}

function versionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Writes <AI_ROOT>/version.json (06 §9.3 step 4) atomically, without a BOM,
 * and returns what was written. The manifest is stored relative to the AI
 * root and the source worktree as its base name only, so the file never holds
 * a user path.
 */
async function writeVersionFile(aiRoot, record = {}) {
  const root = resolveRoot(aiRoot);
  const commit = typeof record.commit === "string" ? record.commit.trim().toLowerCase() : "";
  if (!FULL_COMMIT_PATTERN.test(commit)) throw versionError("version_invalid", "commit must be a full hex commit id.");
  const short = typeof record.shortCommit === "string" && record.shortCommit.trim()
    ? record.shortCommit.trim().toLowerCase()
    : commit.slice(0, 12);
  if (!COMMIT_PATTERN.test(short) || !commit.startsWith(short)) {
    throw versionError("version_invalid", "shortCommit must be a prefix of commit.");
  }
  const deployedAt = record.deployedAt === undefined || record.deployedAt === null ? new Date().toISOString() : String(record.deployedAt);
  if (Number.isNaN(Date.parse(deployedAt))) throw versionError("version_invalid", "deployedAt must be a date.");
  const archiveSha256 = textOrNull(record.archiveSha256)?.toLowerCase() || null;
  if (archiveSha256 && !SHA256_PATTERN.test(archiveSha256)) throw versionError("version_invalid", "archiveSha256 must be a sha256 hex digest.");
  if (record.postDeploy !== undefined && record.postDeploy !== null && !isPlainObject(record.postDeploy)) {
    throw versionError("version_invalid", "postDeploy must be an object.");
  }
  const worktree = textOrNull(record.sourceWorktree);
  const value = {
    schemaVersion: VERSION_SCHEMA_VERSION,
    commit,
    shortCommit: short,
    branch: textOrNull(record.branch),
    version: textOrNull(record.version),
    deployedAt,
    archiveSha256,
    manifest: normalizeManifestPath(root, record.manifest),
    sourceWorktree: worktree ? worktree.split(/[\\/]+/).filter(Boolean).pop() || null : null,
    postDeploy: isPlainObject(record.postDeploy) ? JSON.parse(JSON.stringify(record.postDeploy)) : null,
  };
  const file = path.join(root, VERSION_FILE_NAME);
  const temp = path.join(root, `.${VERSION_FILE_NAME}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await replaceFileAtomically(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Build id (06 §9.5)

function buildIdUnavailable(relPath, cause) {
  const error = new Error(`The build id is unavailable: ${relPath} could not be read (${cause?.code || "error"}).`);
  error.code = "build_id_unavailable";
  error.path = relPath;
  error.cause = cause;
  return error;
}

function normalizeRoots(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  return list.map((root) => String(root).split(/[\\/]+/).filter(Boolean).join("/")).filter(Boolean);
}

// Walks every root and returns relPath -> {size, mtimeMs, ctimeMs, sha256}.
// A file whose stat matches the previous walk keeps its hash; only new or
// changed files are read. ctime joins (size, mtime) because a copy that keeps
// the source's mtime (Copy-Item, robocopy) still sets it. Symbolic links and
// junctions are not followed; the served trees hold none.
function scanBuildRoots(root, roots, previous, fsImpl) {
  const next = new Map();
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A missing root (or a directory removed mid-deploy) contributes nothing.
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw buildIdUnavailable(relDir, error);
    }
    for (const entry of entries) {
      const relPath = `${relDir}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fsImpl.statSync(full);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw buildIdUnavailable(relPath, error);
      }
      const prior = previous.get(relPath);
      if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs && prior.ctimeMs === stat.ctimeMs) {
        next.set(relPath, prior);
        continue;
      }
      let bytes;
      try {
        bytes = fsImpl.readFileSync(full);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw buildIdUnavailable(relPath, error);
      }
      next.set(relPath, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256: sha256Hex(bytes) });
    }
  };
  for (const relRoot of roots) walk(path.join(root, ...relRoot.split("/")), relRoot);
  return next;
}

/** sha256(sorted(relPath + "\0" + sha256(bytes)).join("\n")).slice(0, 12). */
function contentHashOf(files) {
  const lines = [];
  for (const [relPath, entry] of files) lines.push(`${relPath}\0${entry.sha256}`);
  return sha256Hex(lines.sort().join("\n")).slice(0, 12);
}

// version.json's shortCommit, else the worktree's `git rev-parse --short=12
// HEAD`, else null. Display-only, so a failure is null rather than an error.
function buildCommit(root, fsImpl, git) {
  const file = readVersionFile(root, fsImpl);
  if (file.record) return file.record.shortCommit;
  return readGitInfo(root, { fs: fsImpl, git })?.shortCommit || null;
}

/**
 * A build-id source with its own cache. `fs`, `now` and `git` are injectable
 * for tests; the module's getBuildId uses one shared default source.
 */
function createBuildIdSource({ fs: fsImpl = fs, now = Date.now, refreshMs = BUILD_ID_REFRESH_MS, git = runGitSync } = {}) {
  const states = new Map();

  function getBuildId(options = {}) {
    const opts = typeof options === "string" ? { aiRoot: options } : (options || {});
    const root = resolveRoot(opts.aiRoot);
    const roots = normalizeRoots(opts.roots || BUILD_ID_ROOTS);
    const key = [root, ...roots].join("\0");
    const at = now();
    const state = states.get(key);
    if (state && at >= state.checkedAt && at - state.checkedAt < refreshMs) return { ...state.result };
    // A throw leaves the previous state in place, so the next call retries.
    const files = scanBuildRoots(root, roots, state ? state.files : new Map(), fsImpl);
    const result = { commit: buildCommit(root, fsImpl, git), contentHash: contentHashOf(files) };
    states.set(key, { checkedAt: at, files, result });
    return { ...result };
  }

  return { getBuildId };
}

const defaultBuildIdSource = createBuildIdSource();

/**
 * The single build id (00 §9.16): { commit, contentHash }. Synchronous; it
 * re-stats the roots at most every 2 s, re-hashes only changed files and
 * returns the cached value in between. A missing root contributes nothing; an
 * unreadable file throws an error with code "build_id_unavailable". Accepts
 * { aiRoot, roots } or an aiRoot string.
 */
function getBuildId(options = {}) {
  return defaultBuildIdSource.getBuildId(options);
}

// ---------------------------------------------------------------------------
// Deploy manifests, drift and history

const manifestCache = new Map();

function backupsRoot(root) {
  return path.join(root, ...DEPLOY_BACKUPS_DIR.split("/"));
}

// Every <stamp>/deployment-manifest.json under the deploy backups, as
// [{ stamp, dir, file, size, mtimeMs }], in directory-name order.
function listManifestFiles(root, fsImpl) {
  let entries;
  try {
    entries = fsImpl.readdirSync(backupsRoot(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(backupsRoot(root), entry.name);
    const file = path.join(dir, DEPLOY_MANIFEST_NAME);
    try {
      const stat = fsImpl.statSync(file);
      if (stat.isFile()) files.push({ stamp: entry.name, dir, file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // no manifest in this backup
    }
  }
  return files.sort((left, right) => compareText(left.stamp, right.stamp));
}

function parseManifest(entry, fsImpl) {
  const cached = manifestCache.get(entry.file);
  if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) return cached.data;
  const { value } = readJsonObject(fsImpl, entry.file);
  manifestCache.set(entry.file, { size: entry.size, mtimeMs: entry.mtimeMs, data: value });
  return value;
}

// PowerShell reads `$data.files` as a list whether the JSON holds an array or
// one object; an empty list is falsy there.
function manifestFiles(data) {
  if (Array.isArray(data?.files)) return data.files.filter(isPlainObject);
  return isPlainObject(data?.files) ? [data.files] : [];
}

/**
 * The parseable deploy manifests of aiRoot, oldest first by `deployedAt`
 * (compared as text, as Get-LiveDrift's Sort-Object does). Corrupt or
 * unreadable manifests are left out, as Get-LiveDrift leaves them out.
 */
function readDeploymentManifests(aiRoot, options = {}) {
  const fsImpl = options.fs || fs;
  const root = resolveRoot(aiRoot);
  const manifests = [];
  for (const entry of listManifestFiles(root, fsImpl)) {
    const data = parseManifest(entry, fsImpl);
    if (!data) continue;
    manifests.push({
      stamp: entry.stamp,
      dir: entry.dir,
      file: entry.file,
      deployedAt: data.deployedAt === undefined || data.deployedAt === null ? "" : String(data.deployedAt),
      data,
    });
  }
  // Array#sort is stable, so equal timestamps keep directory order.
  return manifests.sort((left, right) => compareText(left.deployedAt, right.deployedAt));
}

/**
 * The newest record of every deployed path, the rule Get-LiveDrift uses and
 * post-deploy's prune shares (06 §9.3): manifests in deployedAt order, later
 * records with an afterSha256 replace earlier ones. Paths use backslashes and
 * match case-insensitively (a PowerShell hashtable), keeping the first
 * spelling seen. Returns Map(lowercased path -> { path, afterSha256, stamp, record }).
 */
function latestDeployRecords(aiRoot, options = {}) {
  const latest = new Map();
  for (const manifest of readDeploymentManifests(aiRoot, options)) {
    for (const record of manifestFiles(manifest.data)) {
      const sha = record.afterSha256;
      if (sha === undefined || sha === null || sha === "" || sha === false) continue;
      const filePath = String(record.path ?? "").replace(/\//g, "\\");
      if (!filePath) continue;
      const key = filePath.toLowerCase();
      const prior = latest.get(key);
      latest.set(key, { path: prior ? prior.path : filePath, afterSha256: String(sha), stamp: manifest.stamp, record });
    }
  }
  return latest;
}

// The live file for a manifest path, or null when it would leave the root.
function liveTarget(root, manifestPath) {
  const segments = manifestPath.split("\\").filter(Boolean);
  if (!segments.length || segments.includes("..") || /^[A-Za-z]:$/.test(segments[0])) return null;
  const target = path.resolve(root, ...segments);
  return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`) ? target : null;
}

function hashLiveFile(fsImpl, target) {
  try {
    const stat = fsImpl.statSync(target);
    if (!stat.isFile()) return { missing: true };
  } catch {
    return { missing: true };
  }
  try {
    return { sha256: sha256Hex(fsImpl.readFileSync(target)) };
  } catch (error) {
    return { error: error?.code || "unreadable" };
  }
}

const driftCache = new Map();

function manifestSetKey(root, fsImpl) {
  return listManifestFiles(root, fsImpl).map((entry) => `${entry.stamp}:${entry.size}:${entry.mtimeMs}`).join("|");
}

/**
 * Live files changed since their last deploy (06 §9.5): a Node port of
 * Get-LiveDrift. Returns [{ path, deployedSha256, liveSha256 }] sorted by
 * path; paths keep Get-LiveDrift's backslash form. A file that is gone is not
 * drift; a file that exists but cannot be read is reported with liveSha256
 * null and `error`, where Get-LiveDrift would stop the deploy. The result is
 * cached for 10 minutes per AI root while the manifest set and the manifests'
 * mtimes stay the same; `fresh: true` recomputes.
 */
function computeLiveDrift(aiRoot, options = {}) {
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DRIFT_CACHE_MS;
  const root = resolveRoot(aiRoot);
  const key = manifestSetKey(root, fsImpl);
  const at = now();
  const cached = driftCache.get(root);
  if (!options.fresh && cached && cached.key === key && at >= cached.at && at - cached.at < maxAgeMs) {
    return cached.drift.map((item) => ({ ...item }));
  }
  const drift = [];
  for (const entry of latestDeployRecords(root, { fs: fsImpl }).values()) {
    const target = liveTarget(root, entry.path);
    if (!target) continue;
    const live = hashLiveFile(fsImpl, target);
    if (live.missing) continue;
    if (live.error) {
      drift.push({ path: entry.path, deployedSha256: entry.afterSha256, liveSha256: null, error: live.error });
    } else if (live.sha256 !== entry.afterSha256.toLowerCase()) {
      // PowerShell's -ne is case-insensitive, so an upper-case record matches.
      drift.push({ path: entry.path, deployedSha256: entry.afterSha256, liveSha256: live.sha256 });
    }
  }
  drift.sort((left, right) => comparePaths(left.path, right.path));
  driftCache.set(root, { key, at, drift });
  return drift.map((item) => ({ ...item }));
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Deploy history, newest first (06 §9.5): [{ stamp, commit, branch,
 * deployedAt, counts: { created, updated, unchanged, pruned }, postDeploy }].
 * postDeploy is the backup's post-deploy.json (OPS-11a) or null; `pruned`
 * comes from it.
 */
function listDeployments(aiRoot, { limit = DEFAULT_DEPLOY_LIMIT, fs: fsImpl = fs } = {}) {
  const root = resolveRoot(aiRoot);
  const max = Math.min(Math.max(Math.trunc(Number(limit)) || DEFAULT_DEPLOY_LIMIT, 1), MAX_DEPLOY_LIMIT);
  const manifests = readDeploymentManifests(root, { fs: fsImpl }).reverse().slice(0, max);
  return manifests.map((manifest) => {
    const counts = { created: 0, updated: 0, unchanged: 0, pruned: 0 };
    for (const record of manifestFiles(manifest.data)) {
      if (Object.hasOwn(counts, record.action) && record.action !== "pruned") counts[record.action] += 1;
    }
    const postDeploy = readJsonObject(fsImpl, path.join(manifest.dir, POST_DEPLOY_NAME)).value;
    counts.pruned = countOf(postDeploy?.pruned);
    const commit = typeof manifest.data.commit === "string" && COMMIT_PATTERN.test(manifest.data.commit.toLowerCase())
      ? manifest.data.commit.toLowerCase()
      : null;
    return {
      stamp: manifest.stamp,
      commit,
      branch: textOrNull(manifest.data.branch),
      deployedAt: manifest.deployedAt || null,
      counts,
      postDeploy,
    };
  });
}

// ---------------------------------------------------------------------------
// Newer commits (06 §9.4, §9.5)

function updateBranch(root) {
  try {
    const { readSection } = require("./config");
    return textOrNull(readSection("updates", { aiRoot: root }).values?.branch) || DEFAULT_UPDATE_BRANCH;
  } catch {
    return DEFAULT_UPDATE_BRANCH;
  }
}

function validBranch(branch) {
  return BRANCH_PATTERN.test(branch) && !branch.includes("..") && !branch.includes("//") && !branch.endsWith("/")
    && !branch.endsWith(".lock") && !branch.endsWith(".");
}

// The commit the live root runs: version.json, else the newest deploy
// manifest (deploys before OPS-11a wrote no version.json).
function deployedCommit(root) {
  const file = readVersionFile(root, fs);
  if (file.record) return file.record.commit;
  const manifests = readDeploymentManifests(root);
  for (let index = manifests.length - 1; index >= 0; index -= 1) {
    const commit = typeof manifests[index].data.commit === "string" ? manifests[index].data.commit.trim().toLowerCase() : "";
    if (COMMIT_PATTERN.test(commit)) return commit;
  }
  return null;
}

async function gitText(git, args, options) {
  return String(await git(args, options)).trim();
}

/**
 * How many commits refs/heads/<branch> of <AI_ROOT>/platform-repo.git has that
 * the deployed commit lacks: `git --git-dir <repo> rev-list --count
 * <deployed>..refs/heads/<branch>`. Local refs only, unless `fetch: true`
 * runs `git fetch --all --prune` first. Resolves to { available, behind, head,
 * deployed, ref, fetched }; when the count cannot be made, behind is null and
 * `error` is { code, message }. Never rejects. `available` means newer
 * commits exist.
 */
async function countNewerCommits(aiRoot, options = {}) {
  const root = resolveRoot(aiRoot);
  const git = options.git || runGitAsync;
  const branch = options.branch === undefined || options.branch === null ? updateBranch(root) : String(options.branch);
  const ref = `refs/heads/${branch}`;
  const result = { available: false, behind: null, head: null, deployed: null, ref, fetched: false };
  const fail = (code, message) => ({ ...result, error: { code, message } });
  if (!validBranch(branch)) return fail("invalid_branch", "The update branch is not a valid branch name.");
  const repo = path.join(root, PLATFORM_REPO_DIR);
  try {
    if (!fs.statSync(repo).isDirectory()) return fail("repo_missing", `${PLATFORM_REPO_DIR} is not a directory.`);
  } catch {
    return fail("repo_missing", `${PLATFORM_REPO_DIR} was not found in the AI root.`);
  }
  const base = ["--git-dir", repo];
  const deployedText = options.deployed === undefined || options.deployed === null ? deployedCommit(root) : String(options.deployed).trim().toLowerCase();
  if (options.fetch) {
    try {
      await git([...base, "fetch", "--all", "--prune", "--quiet"], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
      result.fetched = true;
    } catch (error) {
      // git's stderr can echo a remote URL with credentials, so it is not passed on.
      result.fetchError = { code: "fetch_failed", message: `git fetch failed${error?.code === "ENOENT" ? " (git not found)" : ""}; local refs were used.` };
    }
  }
  try {
    result.head = await gitText(git, [...base, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (error) {
    if (error?.code === "ENOENT") return fail("git_unavailable", "git was not found on PATH.");
    return fail("ref_missing", `${ref} does not exist in ${PLATFORM_REPO_DIR}.`);
  }
  if (!deployedText) return fail("deployed_unknown", "No version.json or deploy manifest names the deployed commit.");
  if (!COMMIT_PATTERN.test(deployedText)) return fail("deployed_unknown", "The deployed commit is not a hex commit id.");
  try {
    result.deployed = await gitText(git, [...base, "rev-parse", "--verify", "--quiet", `${deployedText}^{commit}`]);
  } catch {
    result.deployed = deployedText;
    return fail("deployed_not_in_repo", `The deployed commit is not in ${PLATFORM_REPO_DIR}.`);
  }
  try {
    const behind = Number.parseInt(await gitText(git, [...base, "rev-list", "--count", `${result.deployed}..${result.head}`]), 10);
    if (!Number.isInteger(behind) || behind < 0) return fail("count_failed", "git rev-list returned no count.");
    result.behind = behind;
    result.available = behind > 0;
  } catch {
    return fail("count_failed", "git rev-list failed.");
  }
  return result;
}

module.exports = {
  BUILD_ID_ROOTS,
  BUILD_ID_REFRESH_MS,
  DRIFT_CACHE_MS,
  DEPLOY_BACKUPS_DIR,
  VERSION_FILE_NAME,
  readVersion,
  versionFilePath,
  writeVersionFile,
  getBuildId,
  createBuildIdSource,
  computeLiveDrift,
  readDeploymentManifests,
  latestDeployRecords,
  listDeployments,
  countNewerCommits,
};
