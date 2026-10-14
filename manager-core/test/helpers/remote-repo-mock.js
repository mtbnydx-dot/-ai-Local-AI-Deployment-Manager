"use strict";

// An in-memory Hugging Face / ModelScope for the remote inspector tests
// (docs/overhaul/02-models.md §21.2, MOD-8): a fetch implementation that
// answers the model-info API, `resolve` downloads and Range requests from a
// table of virtual files, records every request, and can ignore Range,
// redirect downloads to a CDN host, refuse files (gated), or hang.
//
// A virtual file is { size, head }: `head` holds the bytes that matter (a
// whole small file, or the header of a weight file); every byte past it reads
// as zero, so a 98 GB GGUF costs the header only.

const fs = require("node:fs");
const path = require("node:path");
const { loadFixture } = require("./fixture-materialize");

const CHUNK_BYTES = 64 * 1024;

function virtualFile(head, size = head.length) {
  return { head: Buffer.isBuffer(head) ? head : Buffer.from(head), size };
}

/**
 * Virtual files of a model-card fixture that was materialized with
 * `sizes: "header"` (so the weight files hold only their headers): sizes come
 * from the fixture manifest, bytes from the materialized files. Placeholder
 * files (README, LICENSE, ...) have a size and no bytes.
 */
// A materialized weight file may be sparse-extended to gigabytes; its header
// is all that matters, and everything past it reads as zero.
function readHead(file, limit = 16 * 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, limit));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function filesFromMaterialized(id, materialized) {
  const { manifest } = loadFixture(id);
  const files = new Map();
  for (const entry of manifest.files) {
    const file = path.join(materialized.dir, ...entry.name.split("/"));
    const head = entry.kind === "placeholder" ? Buffer.alloc(0) : readHead(file);
    files.set(entry.name, virtualFile(head, entry.bytes));
  }
  return files;
}

function readWindow(file, start, end) {
  // end exclusive, clamped to the file size.
  const stop = Math.min(end, file.size);
  const out = Buffer.alloc(Math.max(0, stop - start));
  if (start < file.head.length) file.head.copy(out, 0, start, Math.min(stop, file.head.length));
  return out;
}

function bodyStream(file, stats, limit = file.size) {
  let offset = 0;
  // highWaterMark 0: nothing is pulled until the reader asks, so bytesPulled
  // is what the reader consumed (plus the chunk it was reading).
  return new ReadableStream({
    pull(controller) {
      if (offset >= limit) {
        controller.close();
        return;
      }
      const chunk = readWindow(file, offset, Math.min(offset + CHUNK_BYTES, limit));
      offset += chunk.length;
      stats.bytesPulled += chunk.length;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      stats.cancelled += 1;
    },
  }, { highWaterMark: 0 });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * createRepoMock({repo, sha, files, api, ignoreRange, cdnHost, deny, endpoint, source})
 *   files: Map name -> virtualFile.
 *   api: extra fields of the model-info body (safetensors, gguf, config, ...).
 *   ignoreRange: answer a Range request with 200 and the whole body.
 *   cdnHost: redirect weight-file downloads to https://<cdnHost>/... (302).
 *   deny: Set of file names answered 403 (gated).
 *   requireToken: Set of file names answered 403 unless a bearer token is sent.
 *   hang: Set of URL substrings that never answer (until aborted).
 *   status: HTTP status of the model-info/file-list call (default 200).
 *   source "hf" (default) or "modelscope".
 * Returns {fetchImpl, requests, stats, setSha}. `requests` entries carry
 * {url, host, method, headers, range, kind}.
 */
function createRepoMock(options = {}) {
  const {
    repo = "acme/demo-model",
    revision: requestedRevision = null,
    files = new Map(),
    api = {},
    ignoreRange = false,
    cdnHost = null,
    deny = new Set(),
    requireToken = new Set(),
    hang = [],
    status = 200,
    source = "hf",
    endpoint = source === "modelscope" ? "https://www.modelscope.cn" : "https://huggingface.co",
    onRequest = null,
  } = options;
  const revision = requestedRevision || (source === "modelscope" ? "master" : "main");
  let sha = options.sha || "0123456789abcdef0123456789abcdef01234567";
  const requests = [];
  const stats = { bytesPulled: 0, cancelled: 0 };
  const host = new URL(endpoint).host;

  function respondFile(name, init) {
    const file = files.get(name);
    if (!file) return new Response("not found", { status: 404 });
    const rangeHeader = init.headers.range || "";
    const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    if (match && !ignoreRange) {
      const start = Number(match[1]);
      const end = Number(match[2]) + 1;
      if (start >= file.size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}` } });
      }
      const body = readWindow(file, start, end);
      stats.bytesPulled += body.length;
      return new Response(body, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${start + body.length - 1}/${file.size}`, "content-length": String(body.length) },
      });
    }
    return new Response(bodyStream(file, stats), { status: 200, headers: { "content-length": String(file.size) } });
  }

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const entry = {
      url: String(url), host: parsed.host, method: init.method || "GET", headers, range: headers.range || null, kind: "other", redirect: init.redirect,
    };
    requests.push(entry);
    onRequest?.(entry);
    if (hang.some((needle) => String(url).includes(needle))) {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason || new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (init.signal?.aborted) throw init.signal.reason || new DOMException("aborted", "AbortError");

    // CDN host: serves any file by path (no credentials needed).
    if (cdnHost && parsed.host === cdnHost) {
      entry.kind = "cdn";
      return respondFile(decodeURIComponent(parsed.pathname.slice(1)), { headers });
    }
    if (parsed.host !== host) return new Response("unexpected host", { status: 502 });

    if (source === "hf") {
      if (parsed.pathname === `/api/models/${repo}/revision/${encodeURIComponent(revision)}`) {
        entry.kind = "api";
        if (status !== 200) return new Response(JSON.stringify({ error: status === 404 ? "Repository not found" : "denied" }), { status });
        return jsonResponse({
          id: repo,
          sha,
          gated: false,
          downloads: 1234,
          likes: 56,
          lastModified: "2026-09-01T00:00:00.000Z",
          pipeline_tag: "text-generation",
          library_name: "transformers",
          siblings: Array.from(files, ([rfilename, file]) => ({ rfilename, size: file.size })),
          ...api,
        });
      }
      const prefix = `/${repo}/resolve/${sha}/`;
      if (parsed.pathname.startsWith(prefix)) {
        const name = decodeURIComponent(parsed.pathname.slice(prefix.length));
        entry.kind = /\.(safetensors|gguf)$/.test(name) ? "weights" : "small";
        if (deny.has(name) || (requireToken.has(name) && !headers.authorization)) return new Response("gated", { status: 403 });
        if (cdnHost && entry.kind === "weights") {
          return new Response(null, { status: 302, headers: { location: `https://${cdnHost}/${name}?signature=abc` } });
        }
        return respondFile(name, { headers });
      }
      return new Response("not found", { status: 404 });
    }

    // ModelScope
    if (parsed.pathname === `/api/v1/models/${repo}/repo/files`) {
      entry.kind = "api";
      if (status !== 200) return new Response("denied", { status });
      return jsonResponse({
        Code: 200,
        Success: true,
        Data: { Files: Array.from(files, ([name, file]) => ({ Name: path.posix.basename(name), Path: name, Size: file.size, Type: "blob", Sha256: "0".repeat(64) })) },
      });
    }
    const prefix = `/models/${repo}/resolve/${revision}/`;
    if (parsed.pathname.startsWith(prefix)) {
      const name = decodeURIComponent(parsed.pathname.slice(prefix.length));
      entry.kind = /\.(safetensors|gguf)$/.test(name) ? "weights" : "small";
      if (deny.has(name)) return new Response("denied", { status: 403 });
      return respondFile(name, { headers });
    }
    return new Response("not found", { status: 404 });
  }

  return { fetchImpl, requests, stats, setSha(value) { sha = value; }, get sha() { return sha; } };
}

module.exports = { CHUNK_BYTES, createRepoMock, filesFromMaterialized, virtualFile };
