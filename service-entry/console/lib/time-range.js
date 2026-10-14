// Time ranges (07 §4.4 TimeRangePicker, §6.7): the pure part. A range value is
// either a preset, `{ range: "24h" }`, or a custom window, `{ from, to }` in
// epoch milliseconds. It lives in the URL as `?range=24h` or
// `?from=<ISO>&to=<ISO>`, so a copied link shows the same view; custom bounds
// are written in whole seconds and read back as ISO 8601 or epoch ms (04 §11:
// both are accepted). Nothing here reads the clock or the location: `now` and
// the search string are always passed in.

import { buildQuery } from "./url.js";

export const RANGE_IDS = Object.freeze(["15m", "1h", "6h", "24h", "7d", "30d"]);
export const DEFAULT_RANGE = "24h";
/** 04 §11 caps a custom range at 400 days. */
export const MAX_RANGE_DAYS = 400;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RANGE_MS = Object.freeze({ "15m": 15 * MINUTE, "1h": HOUR, "6h": 6 * HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY });

/** 04 §11.1: the smallest of these steps (seconds) that keeps a result within the point budget. */
export const NICE_STEPS = Object.freeze([10, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400, 604800]);

export function isPresetRange(id) {
  return typeof id === "string" && Object.hasOwn(RANGE_MS, id);
}

/** Epoch ms from an ISO 8601 string or a digits-only epoch ms; null when it is neither. */
export function parseInstant(text) {
  if (typeof text === "number") return Number.isFinite(text) && text >= 0 ? Math.floor(text / 1000) * 1000 : null;
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (/^\d{9,15}$/.test(value)) return Math.floor(Number(value) / 1000) * 1000;
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) * 1000 : null;
}

function lookup(source, name) {
  if (source === null || source === undefined) return null;
  if (typeof source === "string") return new URLSearchParams(source.startsWith("?") ? source.slice(1) : source).get(name);
  if (typeof source.get === "function") return source.get(name);
  return source[name] ?? null;
}

/**
 * Checks a value. @returns {null | "invalid" | "order" | "tooLong"} the first problem.
 */
export function rangeProblem(value, { maxRangeDays = MAX_RANGE_DAYS } = {}) {
  if (value && isPresetRange(value.range)) return null;
  const from = value?.from;
  const to = value?.to;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "invalid";
  if (from >= to) return "order";
  if (to - from > maxRangeDays * DAY) return "tooLong";
  return null;
}

/**
 * Reads the range from a query (a search string, URLSearchParams or object).
 * A missing or unusable query gives the fallback preset and `valid: false`
 * only when something was present but wrong, so a page can say why.
 * @returns {{ value: { range } | { from, to }, valid: boolean, problem: string | null }}
 */
export function parseTimeRange(source, { maxRangeDays = MAX_RANGE_DAYS, fallback = DEFAULT_RANGE } = {}) {
  const fallbackValue = { range: isPresetRange(fallback) ? fallback : DEFAULT_RANGE };
  const range = lookup(source, "range");
  const fromText = lookup(source, "from");
  const toText = lookup(source, "to");
  if (range !== null && range !== "") {
    return isPresetRange(range) ? { value: { range }, valid: true, problem: null } : { value: fallbackValue, valid: false, problem: "invalid" };
  }
  if ((fromText === null || fromText === "") && (toText === null || toText === "")) return { value: fallbackValue, valid: true, problem: null };
  const value = { from: parseInstant(fromText), to: parseInstant(toText) };
  const problem = rangeProblem(value, { maxRangeDays });
  return problem ? { value: fallbackValue, valid: false, problem } : { value, valid: true, problem: null };
}

/** The query parameters for a value: `{ range }` or `{ from, to }` as ISO 8601 (UTC, whole seconds). */
export function serializeTimeRange(value) {
  if (value && isPresetRange(value.range)) return { range: value.range };
  if (!Number.isFinite(value?.from) || !Number.isFinite(value?.to)) return {};
  const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
  return { from: iso(value.from), to: iso(value.to) };
}

/** `?range=24h` or `?from=…&to=…` (the buildQuery form, keys sorted). */
export function timeRangeQuery(value) {
  return buildQuery(serializeTimeRange(value));
}

/**
 * `search` with the range parameters replaced by `value`; every other
 * parameter is kept in order. Returns a string starting with "?" or "".
 */
export function applyTimeRange(search, value) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  for (const name of ["range", "from", "to"]) params.delete(name);
  for (const [name, text] of Object.entries(serializeTimeRange(value))) params.set(name, text);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The window a value covers at `now`: `{ from, to }` in epoch ms. */
export function resolveTimeRange(value, now = Date.now()) {
  if (value && isPresetRange(value.range)) return { from: now - RANGE_MS[value.range], to: now };
  return { from: value.from, to: value.to };
}

/** The window of the same length that ends where `span` starts (`compare=previous`). */
export function previousWindow(span) {
  const length = span.to - span.from;
  return { from: span.from - length, to: span.from };
}

/** The `step` (seconds) the console sends so a series stays within `maxPoints` (07 §11 data volume: 600). */
export function suggestStep(span, maxPoints = 600) {
  const seconds = Math.max(1, (span.to - span.from) / 1000);
  return NICE_STEPS.find((step) => seconds / step <= maxPoints) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

export function sameTimeRange(a, b) {
  if (!a || !b) return a === b;
  if (isPresetRange(a.range) || isPresetRange(b.range)) return a.range === b.range;
  return a.from === b.from && a.to === b.to;
}

const pad = (n) => String(n).padStart(2, "0");

/** The value of a `datetime-local` input (local time, minute precision) for an instant. */
export function toDatetimeLocal(ms) {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value means in the viewer's time zone, or null. */
export function fromDatetimeLocal(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : null;
}
