"use strict";

// Completion pipeline of a download (03 §7.4), run by the queue after the CLI
// exits with code 0:
//
//   1. selected weights present and non-empty, otherwise `transfer_empty`
//   2. per-file size against the manifest (bad files are deleted → `verify_failed`)
//   3. no `.incomplete` fragments of the selected files left (→ `verify_failed`)
//   4. structure check (`fsStore.verifyDownloadedModel`, strictIncomplete) (→ `verify_failed`)
//   5. sha256 of every manifest file that has one, in the hash worker; files
//      already `verified` with the same size and mtime are skipped; only the
//      mismatched files are deleted (→ `checksum_mismatch`)
//   6. marker v2 `.platform-download.json`, a superset of v1
//
// Hashing never runs on the calling thread: hash-worker.js is a worker_threads
// worker. verify.js watches its heartbeat. After 5 minutes of silence the
// worker is terminated and the remaining files are hashed once more; a second
// silence ends in `verify_failed`.
//
//   verifyArtifact(job, { onProgress, signal, ...deps })
//     → { ok, mismatched[], missing[], empty[], verifiedFiles[], badFiles[], skipped, failure, marker, seconds }
//
// `failure` is a classifyTransferFailure result (code, retryable, title, hint…)
// the queue turns into the job's `error`; `badFiles` is what it stores in
// `job.retry.badFiles` so the same file failing twice stops the retries.

const path = require("node:path");
const fsp = require("node:fs/promises");
const { Worker } = require("node:worker_threads");
const { classifyTransferFailure } = require("./errors");
const { HASH_JOB_KIND } = require("./hash-worker");
const { listIncompleteFiles, settingValue } = require("./progress");

const HASH_WORKER_PATH = path.join(__dirname, "hash-worker.js");
const HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
const HEARTBEAT_CHECK_MS = 15_000;
const STAT_CONCURRENCY = 4;
const MARKER_FILE = ".platform-download.json";
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^[0-9a-f]{40}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nowOf(clock) {
  return typeof clock?.now === "function" ? clock.now() : Date.now();
}

function abortError() {
  return Object.assign(new Error("Verification aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function selectedFiles(job) {
  return (Array.isArray(job?.artifact?.files) ? job.artifact.files : [])
    .filter((file) => isPlainObject(file) && typeof file.path === "string" && file.path)
    .map((file) => {
      const size = Number(file.size);
      const sha256 = String(file.sha256 || "").toLowerCase();
      const gitOid = String(file.gitOid || "").toLowerCase();
      return {
        path: file.path,
        size: Number.isFinite(size) && size > 0 ? size : 0,
        sha256: SHA256_RE.test(sha256) ? sha256 : null,
        gitOid: GIT_OID_RE.test(gitOid) ? gitOid : null,
        role: file.role || "weight",
      };
    });
}

function absolutePath(localDir, rel) {
  const target = path.resolve(localDir, ...String(rel).split("/"));
  return target !== localDir && target.startsWith(localDir + path.sep) ? target : null;
}

// --- hashing in the worker --------------------------------------------------

function defaultCreateWorker(data) {
  return new Worker(HASH_WORKER_PATH, { workerData: data });
}

/**
 * One worker attempt over `manifest`. Resolves with what finished and why it
 * ended: `done`, `timedOut` (no heartbeat), or `crashed`.
 */
function runWorkerOnce({ localDir, manifest, signal, clock, timers, createWorker, heartbeatTimeoutMs, checkMs, onProgress }) {
  return new Promise((resolve, reject) => {
    const outcome = { done: false, timedOut: false, crashed: false, message: "", files: [], result: null };
    let worker = null;
    let settled = false;
    let lastBeat = nowOf(clock);
    let checker = null;

    function finish(patch, error) {
      if (settled) return;
      settled = true;
      if (checker !== null) timers.clearInterval(checker);
      signal?.removeEventListener?.("abort", onAbort);
      Object.assign(outcome, patch);
      // terminate() can be pending on a worker stuck in a read; do not wait for it.
      Promise.resolve(worker?.terminate?.()).catch(() => {});
      if (error) reject(error);
      else resolve(outcome);
    }
    function onAbort() {
      finish({}, abortError());
    }

    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
      worker = createWorker({ kind: HASH_JOB_KIND, localDir, manifest });
    } catch (error) {
      finish({ crashed: true, message: String(error?.message || error) });
      return;
    }
    worker.on("message", (message) => {
      lastBeat = nowOf(clock);
      if (!isPlainObject(message)) return;
      if (message.type === "file") outcome.files.push({ name: message.name, status: message.status, bytes: Number(message.bytes) || 0 });
      else if (message.type === "progress") onProgress?.(message);
      else if (message.type === "done") finish({ done: true, result: message.result || null });
      else if (message.type === "error") finish({ crashed: true, message: String(message.message || "") });
    });
    worker.on("error", (error) => finish({ crashed: true, message: String(error?.message || error) }));
    worker.on("exit", (code) => finish({ crashed: true, message: `hash worker exited with code ${code}` }));
    checker = timers.setInterval(() => {
      if (nowOf(clock) - lastBeat >= heartbeatTimeoutMs) finish({ timedOut: true, message: "the hash worker sent no heartbeat" });
    }, checkMs);
    checker?.unref?.();
  });
}

/** Hashes `manifest` in the worker; retries the unfinished files once after a silent or crashed worker. */
async function hashInWorker(options) {
  let remaining = options.manifest.slice();
  const files = [];
  const results = new Map();
  let failed = null;
  for (let attempt = 1; remaining.length; attempt += 1) {
    const outcome = await runWorkerOnce({ ...options, manifest: remaining });
    files.push(...outcome.files);
    for (const item of outcome.result?.mismatched || []) results.set(item.name, item);
    const finished = new Set(outcome.files.map((item) => item.name));
    remaining = remaining.filter((entry) => !finished.has(entry.name));
    if (outcome.done) {
      remaining = [];
      break;
    }
    if (attempt >= 2) {
      failed = { reason: outcome.timedOut ? "heartbeat" : "crash", message: outcome.message };
      break;
    }
    options.onRetry?.(outcome);
  }
  return { files, results, failed };
}

// --- marker v2 ---------------------------------------------------------------

async function readMarker(markerPath) {
  try {
    const value = JSON.parse(await fsp.readFile(markerPath, "utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Writes marker v2 (`.platform-download.json`). `model`, `source`, `precision`
 * and `createdAt` of an existing v1 marker are kept verbatim, because
 * `prepareDownload` compares exactly those three on the next start.
 */
async function writeDownloadMarker(job, { files, clock = Date } = {}) {
  const localDir = path.resolve(String(job?.target?.localDir || ""));
  const artifact = job?.artifact || {};
  const options = job?.transfer?.options || {};
  const markerPath = path.join(localDir, MARKER_FILE);
  const previous = await readMarker(markerPath);
  const at = new Date(nowOf(clock)).toISOString();
  const marker = {
    schemaVersion: 2,
    model: previous?.model ?? artifact.repo,
    source: previous?.source ?? options.source ?? artifact.provider,
  };
  if (previous && Object.hasOwn(previous, "precision")) marker.precision = previous.precision;
  else if (artifact.quant) marker.precision = artifact.quant;
  Object.assign(marker, {
    createdAt: previous?.createdAt || at,
    provider: artifact.provider || null,
    transport: options.source || artifact.provider || null,
    revision: artifact.revision || null,
    revisionSha: artifact.revisionSha || null,
    artifactKey: artifact.artifactKey || null,
    jobId: job?.id || null,
    completedAt: at,
    files: (files || []).map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256 || null,
      ...(file.sha256 ? {} : file.gitOid ? { gitOid: file.gitOid } : {}),
    })),
  });
  const temp = `${markerPath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`);
  await fsp.rename(temp, markerPath);
  return { path: markerPath, marker };
}

// --- the pipeline ------------------------------------------------------------

function buildFailure(job, { lines = [], signals = {}, source } = {}) {
  return classifyTransferFailure({
    exitCode: 0,
    stderrTail: lines,
    phase: "verifying",
    source: source || job?.transfer?.options?.source,
    job,
    signals,
  });
}

function setFileProgress(job, rel, patch) {
  const files = job?.progress?.files;
  if (!Array.isArray(files)) return;
  const entry = files.find((item) => item.path === rel);
  if (entry) Object.assign(entry, patch);
}

async function verifyArtifact(job, options = {}) {
  const clock = options.clock || Date;
  const timers = options.timers || { setInterval, clearInterval };
  const signal = options.signal || null;
  const fs = options.fs || fsp;
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
  const startedAt = nowOf(clock);
  const localDir = path.resolve(String(job?.target?.localDir || ""));
  const files = selectedFiles(job);
  const source = job?.transfer?.options?.source;
  const result = {
    ok: false,
    mismatched: [],
    missing: [],
    empty: [],
    verifiedFiles: [],
    badFiles: [],
    skipped: 0,
    failure: null,
    marker: null,
    seconds: 0,
  };
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  const fail = (extra) => {
    result.failure = buildFailure(job, { source, ...extra });
    result.seconds = Math.round((nowOf(clock) - startedAt) / 1000);
    return result;
  };
  const markFile = (rel, state, details) => {
    options.monitor?.markFile?.(rel, state, details);
    setFileProgress(job, rel, state === "verified" ? { state, mtimeMs: details.mtimeMs, sha256: details.sha256 } : { state });
  };
  const deleteBad = async (items) => {
    for (const item of items) {
      const target = absolutePath(localDir, item.path);
      if (!target) continue;
      await fs.rm(target, { force: true }).catch(() => {});
      markFile(item.path, "bad", { size: item.actual ?? 0, mtimeMs: 0 });
      onLog(`Deleted a file that failed verification: ${item.path} (${item.reason === "size" ? "size mismatch" : "sha256 mismatch"})`);
    }
  };

  // 1. Existence, emptiness and size of every selected file.
  const stats = await mapLimit(files, STAT_CONCURRENCY, async (file) => {
    const target = absolutePath(localDir, file.path);
    const stat = target ? await fs.stat(target).catch(() => null) : null;
    return stat && stat.isFile() ? stat : null;
  });
  throwIfAborted();
  const entries = files.map((file, index) => ({ ...file, stat: stats[index] }));
  for (const entry of entries) {
    if (!entry.stat) result.missing.push(entry.path);
    else if (entry.stat.size === 0 && (entry.size > 0 || entry.role === "weight")) result.empty.push(entry.path);
  }
  // A selected weight that is absent or has no bytes is a finished-but-empty transfer.
  const emptyWeights = entries.filter((entry) => entry.role === "weight" && (!entry.stat || entry.stat.size === 0));
  if (emptyWeights.length) {
    return fail({
      lines: [`Selected weight file is missing or empty: ${emptyWeights.slice(0, 5).map((entry) => entry.path).join(", ")}`],
      signals: { errorCode: "filter_no_match", emptySelection: true },
    });
  }
  if (result.missing.length) {
    return fail({
      lines: [`Download verification failed: ${result.missing.length} selected files are missing: ${result.missing.slice(0, 5).join(", ")}`],
      signals: { verifyFailed: true },
    });
  }

  const sizeMismatch = entries
    .filter((entry) => entry.size > 0 && entry.stat.size !== entry.size)
    .map((entry) => ({ path: entry.path, reason: "size", expected: entry.size, actual: entry.stat.size }));
  if (sizeMismatch.length) {
    result.mismatched.push(...sizeMismatch);
    result.badFiles.push(...sizeMismatch.map((item) => item.path));
    await deleteBad(sizeMismatch);
    return fail({
      lines: [`Download verification failed: size mismatch for ${sizeMismatch.slice(0, 5).map((item) => item.path).join(", ")}`],
      signals: { verifyFailed: true, badFiles: result.badFiles },
    });
  }

  // 2. Fragments of the selected files must be gone once the CLI exited with 0.
  const leftovers = await listIncompleteFiles({ fs, localDir, paths: files.map((file) => file.path) });
  if (leftovers.length) {
    result.missing.push(...leftovers.map((item) => item.path));
    return fail({
      lines: [`Download verification failed: unfinished .incomplete files remain for ${leftovers.slice(0, 5).map((item) => item.path).join(", ")}`],
      signals: { verifyFailed: true },
    });
  }

  // 3. Structure (config, weight index, headers) through the shared store.
  if (options.fsStore && typeof options.fsStore.verifyDownloadedModel === "function") {
    let structure = null;
    let structureError = "";
    try {
      structure = await options.fsStore.verifyDownloadedModel({ localDir }, { strictIncomplete: true });
    } catch (error) {
      structureError = String(error?.message || error);
    }
    throwIfAborted();
    if (structureError || !structure?.ok) {
      const reasons = structureError
        ? [structureError]
        : (structure?.issues || []).filter((issue) => issue.severity === "fail").map((issue) => `${issue.title}: ${issue.detail || ""}`.trim());
      return fail({
        lines: [`Download verification failed: ${reasons.slice(0, 3).join("; ") || "the model structure check failed"}`],
        signals: { verifyFailed: true },
      });
    }
  }

  // 4. sha256 in the worker, skipping files verified earlier with the same size and mtime.
  const checkSha = settingValue(options.settings, "verify.sha256", true) !== false;
  const previousByPath = new Map((Array.isArray(job?.progress?.files) ? job.progress.files : []).map((entry) => [entry.path, entry]));
  const hashed = new Map();
  const toHash = [];
  const shaEntries = entries.filter((entry) => entry.sha256);
  const progress = { filesDone: 0, filesTotal: checkSha ? shaEntries.length : 0, bytesDone: 0, bytesTotal: checkSha ? shaEntries.reduce((sum, entry) => sum + entry.stat.size, 0) : 0 };
  const report = (current, extraBytes = 0) => {
    const snapshot = { ...progress, bytesDone: progress.bytesDone + extraBytes, current: current || null };
    job.progress = { ...(isPlainObject(job.progress) ? job.progress : {}), verify: { filesDone: snapshot.filesDone, filesTotal: snapshot.filesTotal, bytesDone: snapshot.bytesDone } };
    options.onProgress?.(snapshot);
  };
  if (checkSha) {
    for (const entry of shaEntries) {
      const prior = previousByPath.get(entry.path);
      if (prior?.state === "verified" && prior.sha256 === entry.sha256 && prior.size === entry.stat.size && prior.mtimeMs === entry.stat.mtimeMs) {
        result.skipped += 1;
        progress.filesDone += 1;
        progress.bytesDone += entry.stat.size;
        hashed.set(entry.path, "ok");
      } else {
        toHash.push(entry);
      }
    }
  }
  report(null);

  if (toHash.length) {
    const byName = new Map(toHash.map((entry) => [entry.path, entry]));
    const outcome = await hashInWorker({
      localDir,
      manifest: toHash.map((entry) => ({ name: entry.path, size: entry.size || entry.stat.size, sha256: entry.sha256 })),
      signal,
      clock,
      timers,
      createWorker: options.createWorker || defaultCreateWorker,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs || HEARTBEAT_TIMEOUT_MS,
      checkMs: options.heartbeatCheckMs || HEARTBEAT_CHECK_MS,
      onProgress: (message) => report(message.name, Math.min(Number(message.bytes) || 0, byName.get(message.name)?.stat.size || 0)),
      onRetry: () => onLog("The hash worker stopped responding; hashing the remaining files again."),
    });
    throwIfAborted();
    for (const item of outcome.files) {
      const entry = byName.get(item.name);
      if (!entry) continue;
      progress.filesDone += 1;
      progress.bytesDone += entry.stat.size;
      if (item.status === "ok") {
        hashed.set(item.name, "ok");
        markFile(item.name, "verified", { size: entry.stat.size, mtimeMs: entry.stat.mtimeMs, sha256: entry.sha256 });
      } else if (item.status === "sha256-mismatch" || item.status === "size-mismatch") {
        const detail = outcome.results.get(item.name);
        result.mismatched.push({
          path: item.name,
          reason: item.status === "size-mismatch" ? "size" : "sha256",
          expected: entry.sha256,
          actual: detail?.actual ?? null,
        });
      } else {
        result.missing.push(item.name);
      }
      report(item.name);
    }
    if (outcome.failed) {
      return fail({
        lines: [`Download verification failed: the hash worker ${outcome.failed.reason === "heartbeat" ? "stopped responding" : "crashed"}${outcome.failed.message ? ` (${outcome.failed.message})` : ""}`],
        signals: { verifyFailed: true },
      });
    }
    if (result.missing.length) {
      return fail({
        lines: [`Download verification failed: ${result.missing.length} files disappeared during hashing: ${result.missing.slice(0, 5).join(", ")}`],
        signals: { verifyFailed: true },
      });
    }
    if (result.mismatched.length) {
      result.badFiles.push(...result.mismatched.map((item) => item.path));
      await deleteBad(result.mismatched);
      const bySize = result.mismatched.every((item) => item.reason === "size");
      return bySize
        ? fail({ lines: [`Download verification failed: size mismatch for ${result.badFiles.slice(0, 5).join(", ")}`], signals: { verifyFailed: true, badFiles: result.badFiles } })
        : fail({ lines: [`SHA256 mismatch: ${result.badFiles.slice(0, 5).join(", ")}`], signals: { badFiles: result.badFiles } });
    }
  }

  // 5. All good: what is recorded in the marker.
  result.verifiedFiles = entries.map((entry) => ({
    path: entry.path,
    size: entry.stat.size,
    sha256: hashed.has(entry.path) ? entry.sha256 : null,
    gitOid: entry.gitOid,
  }));
  result.ok = true;
  result.seconds = Math.round((nowOf(clock) - startedAt) / 1000);
  if (options.writeMarker !== false) {
    const written = await writeDownloadMarker(job, { files: result.verifiedFiles, clock });
    result.marker = written.path;
  }
  return result;
}

/** Binds the shared dependencies once (the queue's `verifier`). */
function createArtifactVerifier(deps = {}) {
  return {
    verifyArtifact: (job, options = {}) => verifyArtifact(job, { ...deps, ...options }),
    writeMarker: (job, options = {}) => writeDownloadMarker(job, { clock: deps.clock, ...options }),
  };
}

module.exports = {
  HEARTBEAT_TIMEOUT_MS,
  MARKER_FILE,
  createArtifactVerifier,
  verifyArtifact,
  writeDownloadMarker,
};
