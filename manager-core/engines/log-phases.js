"use strict";

// Log phases and log facts (docs/overhaul/01-engines.md §16.2, ENG-24).
//
// Both are data on the engine descriptor, so a new engine needs no code:
//   logPhases  [{ match, phase, percent, stageText{zh,en}, detailText? }]
//   logFacts   [{ id, match, group?, key?, type?, scale? }]
//
// createProgressInferer(descriptor) builds the `inferProgress` hook that
// runtime-wait consumes; extractLogFacts(descriptor, logText) returns the
// measured values (weights, KV cache, concurrency, per-device buffers) that the
// supervisor stores in LaunchStore `resolved.logFacts` and hands to
// `hooks.afterReady`, so 02's observations never re-parse logs.

const MAX_PATTERN_CACHE = 256;
const patternCache = new Map();

// Same exclusions runtime-wait applies today: configuration dumps and
// "CUDA graph disabled/incompatible" warnings are not evidence of progress.
const NOISE_LINE = /server_args=|\b(?:warning|incompatible|disabled|disabling)\b/i;

function compile(source, flags) {
  const key = `${flags}/${source}`;
  let regex = patternCache.get(key);
  if (regex === undefined) {
    try {
      regex = new RegExp(source, flags);
    } catch {
      regex = null;
    }
    if (patternCache.size >= MAX_PATTERN_CACHE) patternCache.clear();
    patternCache.set(key, regex);
  }
  if (!regex) return null;
  regex.lastIndex = 0;
  return regex;
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function localized(value) {
  if (!value || typeof value !== "object") return { zh: "", en: "" };
  return { zh: textOf(value.zh) || textOf(value.en), en: textOf(value.en) || textOf(value.zh) };
}

/**
 * createProgressInferer(descriptor) → (logText, elapsedMs, startupTimeoutMs)
 * => { percent, stage, detail, phase, stageText } | null
 *
 * Among the entries whose `match` is found in the log (noise lines removed) the
 * highest `percent` wins, ties going to the entry listed first. null means no
 * entry matched, so runtime-wait keeps its own elapsed-time fallback.
 */
function createProgressInferer(descriptor) {
  const entries = [];
  for (const raw of Array.isArray(descriptor?.logPhases) ? descriptor.logPhases : []) {
    if (!raw || typeof raw.match !== "string") continue;
    const regex = compile(raw.match, "i");
    if (!regex) continue;
    entries.push({
      regex,
      phase: raw.phase,
      percent: Number.isFinite(raw.percent) ? raw.percent : 0,
      stageText: localized(raw.stageText),
      detailText: localized(raw.detailText),
    });
  }
  if (!entries.length) return () => null;
  return function inferProgress(logText) {
    const text = String(logText || "").split(/\r?\n/).filter((line) => !NOISE_LINE.test(line)).join("\n");
    if (!text) return null;
    let best = null;
    for (const entry of entries) {
      if (best && entry.percent <= best.percent) continue;
      entry.regex.lastIndex = 0;
      if (entry.regex.test(text)) best = entry;
    }
    if (!best) return null;
    return {
      percent: best.percent,
      stage: best.stageText.zh,
      detail: best.detailText.zh,
      phase: best.phase,
      stageText: best.stageText,
    };
  };
}

function numberOf(raw, type, scale) {
  if (type === "string") return String(raw);
  const value = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const scaled = scale === undefined ? value : value * scale;
  return type === "int" ? Math.round(scaled) : scaled;
}

function lastMatch(text, regex) {
  let found = null;
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    found = match;
    if (match[0] === "") regex.lastIndex += 1;
  }
  return found;
}

/**
 * extractLogFacts(descriptor, logText) → { [factId]: number | string | { [key]: number } }
 *
 * A fact is the last (most recent) match of its pattern. `group` picks the
 * capture (default 1; a list is summed), `key` turns the fact into an object
 * keyed by that capture, e.g. modelBufferMiB: { CUDA0: 4096.5 }. Facts that do
 * not appear in the log are absent, never null or zero.
 */
function extractLogFacts(descriptor, logText) {
  const facts = {};
  const text = String(logText || "");
  if (!text) return facts;
  for (const entry of Array.isArray(descriptor?.logFacts) ? descriptor.logFacts : []) {
    if (!entry || typeof entry.id !== "string" || typeof entry.match !== "string") continue;
    const flags = `g${textOf(entry.flags).replace(/[gy]/g, "")}`;
    const regex = compile(entry.match, flags);
    if (!regex) continue;
    const type = entry.type || "number";
    const groups = Array.isArray(entry.group) ? entry.group : [entry.group || 1];
    const read = (match) => {
      if (groups.length === 1) return numberOf(match[groups[0]], type, entry.scale);
      if (type === "string") return null;
      let sum = 0;
      for (const group of groups) {
        const part = numberOf(match[group], "number", entry.scale);
        if (part === null) return null;
        sum += part;
      }
      return type === "int" ? Math.round(sum) : sum;
    };
    if (entry.key) {
      const byKey = {};
      regex.lastIndex = 0;
      for (let match = regex.exec(text); match; match = regex.exec(text)) {
        if (match[0] === "") regex.lastIndex += 1;
        const value = groups.some((group) => match[group] === undefined) ? null : read(match);
        if (value !== null && match[entry.key] !== undefined) byKey[match[entry.key]] = value;
      }
      if (Object.keys(byKey).length) facts[entry.id] = byKey;
      continue;
    }
    const match = lastMatch(text, regex);
    if (!match || groups.some((group) => match[group] === undefined)) continue;
    const value = read(match);
    if (value !== null) facts[entry.id] = value;
  }
  return facts;
}

/** Folds newly extracted facts into `into`: per-device maps merge, scalars replace. */
function mergeLogFacts(into, facts) {
  const target = into && typeof into === "object" ? into : {};
  for (const [id, value] of Object.entries(facts || {})) {
    if (value && typeof value === "object") target[id] = { ...(target[id] && typeof target[id] === "object" ? target[id] : {}), ...value };
    else target[id] = value;
  }
  return target;
}

module.exports = {
  createProgressInferer,
  extractLogFacts,
  mergeLogFacts,
};
