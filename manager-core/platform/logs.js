"use strict";

// Component log files (06 §5.9). Copy-truncate preserves an append handle;
// a few concurrent writes at that boundary can be lost, as the spec records.
const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { createSecretRedactor } = require("../secret-redactor");
const { allSecretValues } = require("../secret-store");

function rotatedPath(file, index) {
  return file.endsWith(".log") ? `${file.slice(0, -4)}.${index}.log` : `${file}.${index}`;
}

function keepCount(value) { return Math.max(1, Math.min(100, Number.isInteger(Number(value)) ? Number(value) : 5)); }

function rotatePrevious(file, keep) {
  for (let index = keep; index >= 1; index -= 1) {
    const previous = rotatedPath(file, index);
    if (!fs.existsSync(previous)) continue;
    if (index === keep) fs.unlinkSync(previous);
    else fs.renameSync(previous, rotatedPath(file, index + 1));
  }
}

function rotateOnStart(dir, base, keep = 5) {
  keep = keepCount(keep);
  if (!base || path.basename(base) !== base || /[\\/]/.test(base)) throw new Error("Invalid log base name.");
  fs.mkdirSync(dir, { recursive: true });
  const rotated = [];
  for (const stream of ["out", "err"]) {
    const file = path.join(dir, `${base}.${stream}.log`);
    if (!fs.existsSync(file)) continue;
    rotatePrevious(file, keep);
    const destination = rotatedPath(file, 1);
    fs.renameSync(file, destination);
    rotated.push({ file, destination });
  }
  return rotated;
}

function maybeCopyTruncate(file, maxBytes, { keep = 5 } = {}) {
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) <= 0) throw new Error("maxBytes must be positive.");
  let stat;
  try { stat = fs.statSync(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (stat.size <= Number(maxBytes)) return false;
  // Finish the copy before shifting previous runs or touching the current file.
  const staged = `${file}.rotate-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.copyFileSync(file, staged, fs.constants.COPYFILE_EXCL);
    rotatePrevious(file, keepCount(keep));
    fs.renameSync(staged, rotatedPath(file, 1));
    fs.truncateSync(file, 0);
  } finally {
    try { fs.unlinkSync(staged); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return true;
}

function lineRedactor(options) {
  const aiRoot = path.resolve(options.aiRoot || process.env.AI_ROOT || path.join(__dirname, "../.."));
  const redactor = options.redactor || createSecretRedactor({ getSecrets: options.getSecrets || (() => allSecretValues(aiRoot)) });
  if (typeof redactor === "function") return redactor;
  if (typeof redactor.redact !== "function") throw new TypeError("redactor must have a redact function.");
  return (line) => redactor.redact(line);
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes);
  } finally { fs.closeSync(fd); }
}

function tailLog(file, options = {}) {
  const lines = Math.max(0, Math.min(10000, Number(options.lines ?? 100) || 0));
  if (!lines) return "";
  let stat;
  try { stat = fs.statSync(file); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  const maxBytes = Math.max(1, Number(options.maxBytes) || 1024 * 1024);
  const start = Math.max(0, stat.size - maxBytes);
  let text = readRange(file, start, stat.size - start).toString("utf8");
  if (start) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
  const values = text.replace(/\r\n/g, "\n").split("\n");
  if (values.at(-1) === "") values.pop();
  const redact = lineRedactor(options);
  return values.slice(-lines).map(redact).join("\n");
}

function fileIdentity(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }

// Returns a closeable follower. A partial line is held across polls and passed
// through the same redactor only after it is complete, including split UTF-8.
function followLog(file, options = {}) {
  if (typeof options.onLine !== "function") throw new TypeError("followLog requires onLine.");
  const redact = lineRedactor(options);
  let closed = false, offset = 0, identity = null, partial = "", decoder = new StringDecoder("utf8");
  let timer;
  function emit(text) { options.onLine(redact(text.replace(/\r$/, ""))); }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    options.signal?.removeEventListener("abort", close);
  }
  function poll() {
    if (closed) return;
    try {
      const stat = fs.statSync(file);
      const nextIdentity = fileIdentity(stat);
      if (identity === null) {
        identity = nextIdentity;
        offset = stat.size;
        const start = Math.max(0, stat.size - 1024 * 1024);
        let buffer = readRange(file, start, stat.size - start);
        if (start) { const newline = buffer.indexOf(10); buffer = newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1); }
        const lines = decoder.write(buffer).split("\n");
        partial = lines.pop();
        const count = Math.max(0, Number(options.lines ?? 10) || 0);
        if (count) lines.slice(-count).forEach(emit);
        return;
      }
      if (identity !== nextIdentity || stat.size < offset) {
        identity = nextIdentity; offset = 0; partial = ""; decoder = new StringDecoder("utf8");
      }
      const count = Math.min(stat.size - offset, 1024 * 1024);
      if (!count) return;
      const buffer = readRange(file, offset, count);
      offset += buffer.length;
      const lines = (partial + decoder.write(buffer)).split("\n");
      partial = lines.pop();
      lines.forEach(emit);
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (typeof options.onError === "function") options.onError(error);
      else close();
    }
  }
  if (options.signal?.aborted) close();
  else {
    options.signal?.addEventListener("abort", close, { once: true });
    poll();
    if (!closed) { timer = setInterval(poll, Math.max(20, Number(options.intervalMs) || 250)); timer.unref?.(); }
  }
  return { close, poll, get closed() { return closed; } };
}

module.exports = { rotateOnStart, maybeCopyTruncate, tailLog, followLog };
