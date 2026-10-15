// View logic of the My Key page (05 §12.5): scope names, the quota pace, the
// expiry countdown, the allowed-origins rules and the chart data. Pure
// functions of the /v1/me family answers, the language and the clock.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const MAX_ORIGINS = 10;
export const URGENT_EXPIRY_DAYS = 7;
export const MAX_MODEL_SERIES = 7;

/** "audio.speech" -> "me.scope.audio_speech" (the dictionary key of its plain-language text). */
export function scopeKey(scope) {
  return `me.scope.${String(scope).replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
}

function toMs(value) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// The reset instant is the end of the period. A day lasts 24 h (the quota zone
// is a fixed offset); a month's length comes from the calendar month that ends
// at the reset, read 13 h earlier so every zone offset lands inside that month.
function periodStart(kind, endMs) {
  if (kind === "day") return endMs - DAY_MS;
  const inside = new Date(endMs - 13 * HOUR_MS);
  const days = new Date(Date.UTC(inside.getUTCFullYear(), inside.getUTCMonth() + 1, 0)).getUTCDate();
  return endMs - days * DAY_MS;
}

/**
 * The quota bar of one period. `quota` is /v1/me `quota.daily_tokens` or
 * `quota.monthly_tokens` (null when the key has no such cap), `resetsAt` the
 * matching `usage.*.resets_at`.
 *   -> { limit, used, remaining, usedFraction, elapsedFraction, pace, exhaustAt, resetsAt } | null
 */
export function paceView(quota, resetsAt, kind, now) {
  if (!quota || !Number.isFinite(Number(quota.limit)) || Number(quota.limit) <= 0) return null;
  const limit = Number(quota.limit);
  const used = Math.max(0, Number(quota.used) || 0);
  const end = toMs(resetsAt);
  let elapsedFraction = null;
  if (end !== null) {
    const start = periodStart(kind, end);
    elapsedFraction = Math.min(1, Math.max(0, (now - start) / (end - start)));
  }
  const pace = quota.pace === "ahead" || quota.pace === "exhausted" ? quota.pace : "ok";
  return {
    limit,
    used,
    remaining: Number.isFinite(Number(quota.remaining)) ? Math.max(0, Number(quota.remaining)) : Math.max(0, limit - used),
    usedFraction: Math.min(1, used / limit),
    elapsedFraction,
    pace,
    exhaustAt: toMs(quota.projected_exhaustion_at),
    resetsAt: end,
  };
}

/** "14:20" for a time today, "Oct 20, 14:20" otherwise (24-hour clock in both languages). */
export function formatClock(value, now, lang = "en-US") {
  const ms = toMs(value);
  if (ms === null) return "";
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const options = sameDay
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat(lang, options).format(new Date(ms));
}

/** A span as { days, hours, minutes } rounded down; past spans are zero. */
export function splitSpan(ms) {
  const left = Math.max(0, Number(ms) || 0);
  return { days: Math.floor(left / DAY_MS), hours: Math.floor((left % DAY_MS) / HOUR_MS), minutes: Math.floor((left % HOUR_MS) / 60_000) };
}

/** The expiry of a key: { state: "never" | "active" | "expired", days, hours, minutes, urgent }. */
export function expiryView(expiresAt, now) {
  const ms = toMs(expiresAt);
  if (ms === null) return { state: "never", days: null, hours: null, minutes: null, urgent: false };
  const left = ms - now;
  if (left <= 0) return { state: "expired", days: 0, hours: 0, minutes: 0, urgent: true };
  return { state: "active", ...splitSpan(left), urgent: left < URGENT_EXPIRY_DAYS * DAY_MS };
}

/** Whole seconds until `value`, never negative; null for no date. */
export function secondsUntil(value, now) {
  const ms = toMs(value);
  return ms === null ? null : Math.max(0, Math.round((ms - now) / 1000));
}

// ---- allowed origins (the rules of PUT /v1/me/origins, 05 §8.5) ----------------

/**
 * Checks one origin the way the server will: exact `https://host[:port]`, plus
 * `http://localhost[:port]` and `http://127.0.0.1[:port]`; `*`, paths, queries
 * and credentials are rejected.
 *   -> { ok: true, origin } | { ok: false, reason }   reason: empty | wildcard | invalid | path | scheme
 */
export function checkOrigin(text) {
  const value = String(text ?? "").trim();
  if (!value) return { ok: false, reason: "empty" };
  if (value === "*" || value.includes("*")) return { ok: false, reason: "wildcard" };
  if (value.length > 2048) return { ok: false, reason: "invalid" };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "invalid" };
  if (url.pathname !== "/" || /[?#]/.test(value)) return { ok: false, reason: "path" };
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return { ok: false, reason: "scheme" };
  return { ok: true, origin: url.origin };
}

/** Adds `text` to the list: { ok: true, list } or { ok: false, reason } (also "duplicate" and "limit"). */
export function addOrigin(list, text) {
  const checked = checkOrigin(text);
  if (!checked.ok) return checked;
  if (list.includes(checked.origin)) return { ok: false, reason: "duplicate" };
  if (list.length >= MAX_ORIGINS) return { ok: false, reason: "limit" };
  return { ok: true, list: [...list, checked.origin], origin: checked.origin };
}

// ---- usage charts ----------------------------------------------------------------

function parseDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// Every day from the first to the last row as local midnights in epoch seconds,
// so uPlot's time axis labels read the same calendar days as the rows.
function dayAxis(rows) {
  const days = rows.map((row) => parseDay(row.date)).filter(Boolean);
  if (!days.length) return { x: [], index: new Map() };
  const first = new Date(Math.min(...days));
  const last = new Date(Math.max(...days));
  const x = [];
  const index = new Map();
  for (let at = new Date(first); at <= last; at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)) {
    const seconds = Math.round(at.getTime() / 1000);
    index.set(`${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`, x.length);
    x.push(seconds);
  }
  return { x, index };
}

function tokensOf(row) {
  return (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0);
}

/**
 * Tokens per day. With model rows (telemetry) it is one series per model (the
 * biggest MAX_MODEL_SERIES, the rest folded into "other"), stacked; otherwise
 * one total series. Days the answer does not mention stay null: a gap.
 *   -> { x, series: [{ id, model, values }], stacked, empty }
 */
export function buildTokenChart(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const { x, index } = dayAxis(list);
  const grouped = list.some((row) => typeof row.model === "string" && row.model);
  const touched = new Set();
  let series;
  if (!grouped) {
    const values = x.map(() => null);
    for (const row of list) {
      const at = index.get(row.date);
      if (at === undefined) continue;
      values[at] = (values[at] ?? 0) + tokensOf(row);
      touched.add(at);
    }
    series = [{ id: "total", model: null, values }];
  } else {
    const totals = new Map();
    for (const row of list) totals.set(row.model || "unknown", (totals.get(row.model || "unknown") || 0) + tokensOf(row));
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
    const named = ranked.slice(0, MAX_MODEL_SERIES);
    const fold = ranked.length > named.length;
    series = named.map((model) => ({ id: `model:${model}`, model, values: x.map(() => null) }));
    if (fold) series.push({ id: "other", model: null, values: x.map(() => null) });
    const byModel = new Map(series.map((item) => [item.model, item]));
    for (const row of list) {
      const at = index.get(row.date);
      if (at === undefined) continue;
      const target = byModel.get(row.model || "unknown") || series.find((item) => item.id === "other");
      if (!target) continue;
      target.values[at] = (target.values[at] ?? 0) + tokensOf(row);
      touched.add(at);
    }
    // A day that has rows counts as zero for the models that did not appear.
    for (const at of touched) for (const item of series) if (item.values[at] === null) item.values[at] = 0;
  }
  const empty = !series.some((item) => item.values.some((value) => value > 0));
  return { x, series, stacked: grouped, empty };
}

/** Requests and errors per day (rows are the day rows; model rows are summed). */
export function buildRequestChart(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const { x, index } = dayAxis(list);
  const requests = x.map(() => null);
  const errors = x.map(() => null);
  for (const row of list) {
    const at = index.get(row.date);
    if (at === undefined) continue;
    requests[at] = (requests[at] ?? 0) + (Number(row.requests) || 0);
    errors[at] = (errors[at] ?? 0) + (Number(row.errors) || 0);
  }
  const empty = !requests.some((value) => value > 0);
  return { x, series: [{ id: "requests", model: null, values: requests }, { id: "errors", model: null, values: errors }], stacked: false, empty };
}

/** A chart model as table rows [date, ...values] for the "view as table" fallback. */
export function chartTableRows(model, lang = "en-US") {
  const format = new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" });
  return model.x.map((seconds, index) => [format.format(new Date(seconds * 1000)), ...model.series.map((item) => item.values[index])]);
}
