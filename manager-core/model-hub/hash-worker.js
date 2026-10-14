"use strict";

// SHA-256 hashing off the entry's main thread (03 §3). verify.js starts one
// worker per verification attempt with `workerData = { kind: "hub-hash",
// localDir, manifest: [{ name, size, sha256 }] }`. The worker hashes the files
// one after another in 4 MB chunks by reusing `verifyDownloadChecksums`
// (size check, path guard, report-only semantics) with a hasher that reports
// progress. Messages to the parent:
//
//   { type: "heartbeat" }                       every 2 s while alive
//   { type: "progress", name, bytes, size }     every 256 MB of the current file
//   { type: "file", name, status, bytes }       per file: ok | size-mismatch | sha256-mismatch | missing
//   { type: "done", result }                    the verifyDownloadChecksums result
//   { type: "error", message }                  unexpected failure
//
// Nothing is deleted here; the parent decides what to do with bad files.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { isMainThread, parentPort, workerData } = require("node:worker_threads");
const { verifyDownloadChecksums } = require("../download-checksums");

const HASH_JOB_KIND = "hub-hash";
const CHUNK_BYTES = 4 * 1024 * 1024;
const PROGRESS_BYTES = 256 * 1024 * 1024;
const HEARTBEAT_MS = 2000;

function hashFileWithProgress(filePath, { chunkBytes = CHUNK_BYTES, progressBytes = PROGRESS_BYTES, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
    let bytes = 0;
    let reported = 0;
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      if (onProgress && bytes - reported >= progressBytes) {
        reported = bytes;
        onProgress(bytes);
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runHashJob(data, port) {
  const heartbeat = setInterval(() => port.postMessage({ type: "heartbeat" }), Number(data.heartbeatMs) || HEARTBEAT_MS);
  try {
    const result = await verifyDownloadChecksums(data.localDir, data.manifest, {
      sha256File: (filePath, entry) => hashFileWithProgress(filePath, {
        chunkBytes: data.chunkBytes,
        progressBytes: data.progressBytes,
        onProgress: (bytes) => port.postMessage({ type: "progress", name: entry.name, bytes, size: entry.size }),
      }),
      onFile: ({ name, status, bytes }) => port.postMessage({ type: "file", name, status, bytes: bytes || 0 }),
    });
    port.postMessage({ type: "done", result });
  } catch (error) {
    port.postMessage({ type: "error", message: String(error?.message || error) });
  } finally {
    clearInterval(heartbeat);
  }
}

if (!isMainThread && parentPort && workerData?.kind === HASH_JOB_KIND) {
  runHashJob(workerData, parentPort);
}

module.exports = {
  CHUNK_BYTES,
  HASH_JOB_KIND,
  HEARTBEAT_MS,
  PROGRESS_BYTES,
  hashFileWithProgress,
  runHashJob,
};
