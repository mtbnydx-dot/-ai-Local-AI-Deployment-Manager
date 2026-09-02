"use strict";
// Helpers for metering TTS usage at the entry proxy (F3).
//
// Synthesis requests are recognised by route, the input text is counted from
// the JSON body, and the produced audio length is taken from the response:
// the WAV header of /v1/audio/speech, or the duration field in the JSON of
// the legacy /api/tts endpoint. Nothing here stores the text itself.

const { Transform } = require("node:stream");

const SYNTHESIS_ROUTES = new Map([
  ["openai/v1/audio/speech", { endpoint: "/v1/audio/speech", kind: "audio" }],
  ["api/tts", { endpoint: "/api/tts", kind: "json" }],
  ["api/jobs", { endpoint: "/api/jobs", kind: "batch" }],
]);

function ttsSynthesisRoute(route, method = "POST") {
  if (String(method || "").toUpperCase() !== "POST") return null;
  const rest = String(route?.rest || "").replace(/\/+$/, "");
  return SYNTHESIS_ROUTES.get(rest) || null;
}

function textLength(value) {
  return typeof value === "string" ? Array.from(value.trim()).length : 0;
}

// Character count of the text the client asked to synthesise.
function countTtsCharacters(body, kind = "audio") {
  if (!body || typeof body !== "object") return 0;
  if (kind === "batch") {
    const items = Array.isArray(body.items) ? body.items : Array.isArray(body.requests) ? body.requests : [];
    return items.reduce((sum, item) => sum + textLength(item?.text) + textLength(item?.input), 0) + textLength(body.text);
  }
  return textLength(body.input) + textLength(body.text);
}

function ttsEngineFromBody(body, fallback = "unknown") {
  if (!body || typeof body !== "object") return fallback;
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const engine = typeof body.engine === "string" ? body.engine.trim() : "";
  const value = engine || (model.startsWith("tts-") ? model.slice(4) : model) || fallback;
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 80) || fallback;
}

// Reads the RIFF/WAVE header from the first bytes of a response and reports the
// audio length once the stream ends. Streams that are not WAV report 0 with
// source "missing"; a header with an unknown data size falls back to counting
// the bytes that actually passed through.
function createWavDurationProbe(onDone) {
  let header = Buffer.alloc(0);
  let byteRate = 0;
  let declaredDataBytes = 0;
  let totalBytes = 0;
  let parsed = false;
  let isWav = false;

  function parseHeader() {
    parsed = true;
    if (header.length < 36 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return;
    // Walk chunks: fmt gives byte rate, data gives the declared payload size.
    let offset = 12;
    while (offset + 8 <= header.length) {
      const id = header.toString("ascii", offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      if (id === "fmt " && offset + 16 <= header.length) {
        byteRate = header.readUInt32LE(offset + 16);
        isWav = byteRate > 0;
      } else if (id === "data") {
        declaredDataBytes = size === 0xffffffff ? 0 : size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
  }

  const probe = new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (!parsed) {
        header = Buffer.concat([header, chunk]).subarray(0, 512);
        if (header.length >= 64) parseHeader();
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (!parsed) parseHeader();
      callback();
    },
  });

  function result() {
    if (!parsed) parseHeader();
    if (!isWav) return { audioMs: 0, durationSource: "missing", bytes: totalBytes };
    const dataBytes = declaredDataBytes > 0 ? Math.min(declaredDataBytes, Math.max(0, totalBytes - 44)) : Math.max(0, totalBytes - 44);
    return { audioMs: Math.round((dataBytes / byteRate) * 1000), durationSource: declaredDataBytes > 0 ? "reported" : "measured", bytes: totalBytes };
  }

  probe.once("end", () => { if (typeof onDone === "function") onDone(result()); });
  probe.once("close", () => { if (!probe.readableEnded && typeof onDone === "function") onDone(result()); });
  probe.result = result;
  return probe;
}

// Duration from the legacy JSON response ({ output: { duration_ms } } or similar).
function parseTtsJsonDuration(payload) {
  const candidates = [
    payload?.output?.duration_ms,
    payload?.output?.durationMs,
    payload?.duration_ms,
    payload?.durationMs,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return { audioMs: Math.round(number), durationSource: "reported" };
  }
  const seconds = Number(payload?.output?.duration_seconds ?? payload?.output?.durationSeconds);
  if (Number.isFinite(seconds) && seconds >= 0) return { audioMs: Math.round(seconds * 1000), durationSource: "reported" };
  return { audioMs: 0, durationSource: "missing" };
}

// Collects a JSON response body (bounded) while passing it through unchanged.
function createJsonCollector(maxBytes, onDone) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  const collector = new Transform({
    transform(chunk, _encoding, callback) {
      if (!overflow) {
        size += chunk.length;
        if (size > maxBytes) { overflow = true; chunks.length = 0; } else chunks.push(chunk);
      }
      callback(null, chunk);
    },
  });
  const finish = () => {
    if (typeof onDone !== "function") return;
    if (overflow) return onDone(null);
    try {
      onDone(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      onDone(null);
    }
  };
  collector.once("end", finish);
  return collector;
}

module.exports = {
  SYNTHESIS_ROUTES,
  countTtsCharacters,
  createJsonCollector,
  createWavDurationProbe,
  parseTtsJsonDuration,
  ttsEngineFromBody,
  ttsSynthesisRoute,
};
