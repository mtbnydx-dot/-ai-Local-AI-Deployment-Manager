// Number, time and price formatting for the portal. Pure functions: the
// language and the clock are arguments, so tests and the pages agree.

function trim(number) {
  return String(Math.round(number * 10) / 10).replace(/\.0$/, "");
}

/** 262144 -> "256K", 1048576 -> "1M", 8192 -> "8K", 900 -> "900"; null for no value. */
export function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number >= 1_048_576) return `${trim(number / 1_048_576)}M`;
  if (number >= 1024) return `${trim(number / 1024)}K`;
  return String(Math.round(number));
}

/** 1234567 -> "1,234,567" (zh-CN groups the same way). */
export function formatInteger(value, lang = "en-US") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(number);
}

/** 99.3 -> "99.3%"; null for no value. */
export function formatPercent(value, lang = "en-US") {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return null;
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(number)}%`;
}

/** Milliseconds as "350 ms" or "1.2 s". */
export function formatMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (number >= 1000) return `${trim(number / 1000)} s`;
  return `${Math.round(number)} ms`;
}

/** An ISO time in the viewer's zone; "" for a value that is not a date. */
export function formatDateTime(value, lang = "en-US") {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

/** "5 minutes ago" / "in 2 hours" through Intl.RelativeTimeFormat. */
export function formatRelative(value, now, lang = "en-US") {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const formatter = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (abs < 45_000) return formatter.format(0, "second");
  if (abs < 45 * 60_000) return formatter.format(Math.round(diff / 60_000), "minute");
  if (abs < 22 * 3_600_000) return formatter.format(Math.round(diff / 3_600_000), "hour");
  return formatter.format(Math.round(diff / 86_400_000), "day");
}

/**
 * A price from /v1/models `pricing` or /catalog.json `prices`: { unit, input,
 * cached_input, output } with decimal strings. Returns null when there is none.
 */
export function readPricing(value) {
  if (!value || typeof value !== "object") return null;
  const pick = (name) => {
    const text = value[name];
    return text === undefined || text === null || text === "" ? null : String(text);
  };
  const input = pick("input");
  const output = pick("output");
  if (input === null && output === null) return null;
  return { unit: pick("unit") || "credits_per_million_tokens", input, cachedInput: pick("cached_input"), output };
}

/** A case-insensitive match of a search text against a model's names, id and aliases. */
export function modelMatches(model, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const names = [model.id, model.family, model.parameters, model.quantization, ...(Array.isArray(model.aliases) ? model.aliases : [])];
  const display = model.display_name;
  if (typeof display === "string") names.push(display);
  else if (display && typeof display === "object") names.push(...Object.values(display));
  return names.some((name) => typeof name === "string" && name.toLowerCase().includes(needle));
}

/** The /models/:id path of a model id (ids can hold "/" and spaces). */
export function modelPath(id) {
  return `/models/${encodeURIComponent(String(id))}`;
}

/** 0.000125 -> "0.000125", 1.5 -> "1.5", 0 -> "0", 0.0000004 -> "<0.000001". */
export function formatCredits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number === 0) return "0";
  if (number < 0) return `-${formatCredits(-number)}`;
  if (number < 0.000001) return "<0.000001";
  return number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
