"use strict";

// Root-cause extraction (docs/overhaul/02-models.md §14, MOD-12): turns the tail
// of an engine log into the 00 §9.11 job error object by matching the merged
// error signatures (bundled knowledge plus the engine descriptors' additions,
// §8.4). Pure apart from reading the signature list: no I/O, no logging.
//
//   classifyFailure(logText, { engineId, phase, secrets?, signatures? }) -> JobError | null
//   legacyHint(message, engineId) / legacySuggestions(issues, stage, engineId)
//       the data-driven replacements for vllm-manager's logIssueHint / buildLogSuggestions

const { redactSecrets } = require("../secret-redactor");
const knowledge = require("./knowledge");

const MAX_EXCERPT_LINES = 40;
const MAX_EXCERPT_BYTES = 4096;
const MAX_EXCERPT_LINE_CHARS = 600;
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 2;
const MAX_CAPTURE_CHARS = 120;
const FALLBACK_CODE = "engine_start_failed";

// The strings logIssueHint / buildLogSuggestions returned when nothing matched.
const DEFAULT_HINT = Object.freeze({
  zh: "打开日志页查看完整上下文，必要时用保守 Profile 重试。",
  en: "Open the log page for the full context and retry with a conservative profile if needed.",
});
const SLOW_START_SUGGESTION = Object.freeze({
  zh: "如果长时间停在编译或 warmup，观察 GPU 利用率；首次启动慢通常正常。",
  en: "If it stays in compilation or warm-up for a long time, watch the GPU utilisation; a slow first start is usually normal.",
});
const NO_ISSUE_SUGGESTION = Object.freeze({
  zh: "当前日志没有明显错误。",
  en: "The current log shows no obvious error.",
});

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const DOCKER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/;
const PROCESS_PREFIX = /^\((?:[A-Za-z][\w-]*)(?:\s+pid=\d+)?\)\s*/;
const SGLANG_PREFIX = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Za-z0-9_-]+)*\]\s+/;
const LEVEL_PREFIX = /^(?:INFO|WARNING|WARN|ERROR|DEBUG|CRITICAL)\s+(?:\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+)?(?:\[[^\]\s]+:\d+\]\s*)?/;
const TERMINAL_MARKER = /Engine core initialization failed|exited with code|error loading model|container exited/i;
const EXCEPTION_LINE = /^[\w.]+(?:Error|Exception|Interrupt)(?::\s.*)?$/;
const EXCEPTION_TYPE = /^([\w.]+(?:Error|Exception|Interrupt))(?::|\s|$)/;
const TRACEBACK_HEADER = /Traceback \(most recent call last\):/;
const LLAMA_PREFIX = /^(?:llama_model_load\w*|load_tensors|ggml_backend\w*|main):/;
const WINDOWS_PATH = /(?:[A-Za-z]:|<AI_ROOT>)(?:[\\/][^\\/\s'"`,;()<>|]+)+/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Strips ANSI, Docker timestamps, process/level prefixes and host paths from one raw log line. */
function normalizeLine(raw) {
  let line = String(raw ?? "").replace(ANSI_PATTERN, "").replace(/\r$/, "");
  line = line.replace(DOCKER_TIMESTAMP, "");
  let previous;
  do {
    previous = line;
    line = line.replace(PROCESS_PREFIX, "").replace(SGLANG_PREFIX, "").replace(LEVEL_PREFIX, "");
  } while (line !== previous);
  line = line.replace(WINDOWS_PATH, (match) => {
    const base = match.split(/[\\/]/).filter(Boolean).pop();
    return base && base !== "<AI_ROOT>" ? base : match;
  });
  line = line.replace(/\s+$/, "");
  return line.length > MAX_EXCERPT_LINE_CHARS ? `${line.slice(0, MAX_EXCERPT_LINE_CHARS)}…` : line;
}

/** Redacts and normalises a log; returns the non-empty lines (the last 4000 of them). */
function prepareLines(logText, secrets) {
  const redacted = redactSecrets(String(logText ?? ""), secrets && secrets.length ? { secrets } : {});
  const raw = knowledge.prepareLogLines(redacted);
  const lines = [];
  for (const item of raw) {
    const line = normalizeLine(item);
    if (line.trim()) lines.push(line);
  }
  return lines;
}

/** Joins lines into an excerpt of at most 40 lines and 4 KiB, dropping from the front (keepIndex survives). */
function boundExcerpt(lines, keepIndex = lines.length - 1) {
  let from = 0;
  let to = lines.length;
  while (to - from > MAX_EXCERPT_LINES || Buffer.byteLength(lines.slice(from, to).join("\n"), "utf8") > MAX_EXCERPT_BYTES) {
    if (from < keepIndex) from += 1;
    else if (to - 1 > keepIndex) to -= 1;
    else break;
  }
  let text = lines.slice(from, to).join("\n");
  while (Buffer.byteLength(text, "utf8") > MAX_EXCERPT_BYTES) text = text.slice(Math.floor(text.length * 0.1));
  return text;
}

function interpolate(value, captures) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const lang of ["zh", "en"]) {
    if (typeof value[lang] !== "string") continue;
    out[lang] = value[lang].replace(/\{(\d{1,2})\}/g, (match, index) => {
      const capture = captures[Number(index)];
      return typeof capture === "string" ? capture : match;
    });
  }
  return Object.keys(out).length ? out : null;
}

function bilingual(value) {
  if (!value) return null;
  const zh = typeof value.zh === "string" ? value.zh : value.en;
  const en = typeof value.en === "string" ? value.en : value.zh;
  return typeof zh === "string" && typeof en === "string" ? { zh, en } : null;
}

function cleanCapture(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_CAPTURE_CHARS);
}

function signatureList(engineId, options) {
  const source = options.signatures;
  try {
    if (typeof source === "function") return source(engineId) || [];
    if (Array.isArray(source)) return source;
    return knowledge.errorSignatures(engineId);
  } catch {
    return [];
  }
}

function regexpOf(signature) {
  if (signature.regexp instanceof RegExp) return signature.regexp;
  if (typeof signature.regex !== "string") return null;
  const compiled = knowledge.compileSafeRegex(signature.regex, typeof signature.flags === "string" ? signature.flags : "i");
  return compiled.ok ? compiled.regexp : null;
}

function test(regexp, text) {
  regexp.lastIndex = 0;
  return regexp.test(text);
}

function exec(regexp, text) {
  regexp.lastIndex = 0;
  return regexp.exec(text);
}

/** Picks the winning signature hit: rootCause entries first, then the last line wins, then signature order. */
function findHit(lines, signatures) {
  const marker = lines.findIndex((line) => TERMINAL_MARKER.test(line));
  const compiled = [];
  signatures.forEach((signature, order) => {
    if (!isPlainObject(signature) || signature.severity === "warn") return;
    const regexp = regexpOf(signature);
    if (regexp) compiled.push({ signature, regexp, order });
  });
  const search = (limit) => {
    let best = null;
    for (const tier of [true, false]) {
      for (let index = 0; index < limit; index += 1) {
        for (const item of compiled) {
          if ((item.signature.rootCause === true) !== tier) continue;
          const captures = exec(item.regexp, lines[index]);
          if (!captures) continue;
          if (!best || index > best.index || (index === best.index && item.order < best.order)) {
            best = { index, order: item.order, signature: item.signature, captures };
          }
        }
      }
      if (best) return best;
    }
    return null;
  };
  return (marker >= 0 ? search(marker + 1) : null) || search(lines.length);
}

function fallbackFailure(lines, engineId, phase) {
  let excerptLines = null;
  let keep = 0;
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (TRACEBACK_HEADER.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start >= 0) {
    let end = lines.length - 1;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (EXCEPTION_LINE.test(lines[index].trim())) {
        end = index;
        break;
      }
    }
    excerptLines = lines.slice(start, end + 1);
    keep = excerptLines.length - 1;
  } else if (engineId === "llamacpp") {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (LLAMA_PREFIX.test(lines[index]) && /error|failed/i.test(lines[index])) {
        excerptLines = lines.slice(Math.max(0, index - CONTEXT_BEFORE), index + 1);
        keep = excerptLines.length - 1;
        break;
      }
    }
  }
  if (!excerptLines) {
    excerptLines = lines.slice(-5);
    keep = excerptLines.length - 1;
  }
  const last = excerptLines[keep] || "";
  return {
    code: FALLBACK_CODE,
    signatureId: null,
    phase: phase || null,
    hint: null,
    logExcerpt: boundExcerpt(excerptLines, keep),
    title: null,
    explanation: null,
    exceptionType: (EXCEPTION_TYPE.exec(last.trim()) || [])[1] || null,
    suggestions: [],
  };
}

/**
 * classifyFailure(logText, { engineId, phase, secrets?, signatures? }) -> JobError | null
 * null only when there is no log text at all. `signatures` (array or
 * engineId -> array) replaces knowledge.errorSignatures for tests.
 */
function classifyFailure(logText, context = {}) {
  const engineId = textOf(context.engineId) || null;
  const phase = textOf(context.phase) || null;
  const lines = prepareLines(logText, Array.isArray(context.secrets) ? context.secrets : []);
  if (!lines.length) return null;
  const hit = findHit(lines, signatureList(engineId, context));
  if (!hit) return fallbackFailure(lines, engineId, phase);
  const { signature, captures, index } = hit;
  const groups = Array.from(captures, (item) => (item === undefined ? undefined : cleanCapture(item)));
  const from = Math.max(0, index - CONTEXT_BEFORE);
  const excerptLines = lines.slice(from, Math.min(lines.length, index + CONTEXT_AFTER + 1));
  const matched = lines[index].trim();
  let exceptionType = (EXCEPTION_TYPE.exec(matched) || [])[1] || null;
  if (!exceptionType) {
    for (let next = index + 1; next < Math.min(lines.length, index + CONTEXT_AFTER + 1) && !exceptionType; next += 1) {
      exceptionType = (EXCEPTION_TYPE.exec(lines[next].trim()) || [])[1] || null;
    }
  }
  return {
    code: textOf(signature.code) || FALLBACK_CODE,
    signatureId: textOf(signature.id) || null,
    phase: textOf(signature.phase) || phase,
    hint: bilingual(interpolate(signature.hint, groups)),
    logExcerpt: boundExcerpt(excerptLines, index - from),
    title: bilingual(interpolate(signature.title, groups)),
    explanation: bilingual(interpolate(signature.explanation, groups)),
    exceptionType,
    suggestions: Array.isArray(signature.suggestions) ? signature.suggestions.map((item) => ({ ...item })) : [],
  };
}

/** The one-line zh hint of the first signature (engine-specific first) that matches a log line; the default hint otherwise. */
function legacyHint(message, engineId = null, options = {}) {
  const text = String(message ?? "");
  for (const signature of signatureList(engineId, options)) {
    if (!isPlainObject(signature) || !isPlainObject(signature.hint) || typeof signature.hint.zh !== "string") continue;
    const regexp = regexpOf(signature);
    if (regexp && test(regexp, text)) return signature.hint.zh;
  }
  return DEFAULT_HINT.zh;
}

/** The zh suggestion lines for the issues of a log summary (one per distinct explanation), with the old fallbacks. */
function legacySuggestions(issues, stage, engineId = null, options = {}) {
  const messages = (Array.isArray(issues) ? issues : []).map((item) => String(isPlainObject(item) ? item.message : item ?? ""));
  const suggestions = [];
  for (const signature of signatureList(engineId, options)) {
    if (!isPlainObject(signature) || !isPlainObject(signature.explanation) || typeof signature.explanation.zh !== "string") continue;
    const regexp = regexpOf(signature);
    if (!regexp || !messages.some((message) => test(regexp, message))) continue;
    if (!suggestions.includes(signature.explanation.zh)) suggestions.push(signature.explanation.zh);
  }
  if (!suggestions.length && stage !== "API ready") suggestions.push(SLOW_START_SUGGESTION.zh);
  if (!suggestions.length) suggestions.push(NO_ISSUE_SUGGESTION.zh);
  return suggestions;
}

module.exports = {
  classifyFailure,
  legacyHint,
  legacySuggestions,
  normalizeLine,
  DEFAULT_HINT,
  SLOW_START_SUGGESTION,
  NO_ISSUE_SUGGESTION,
  FALLBACK_CODE,
  MAX_EXCERPT_LINES,
  MAX_EXCERPT_BYTES,
};
