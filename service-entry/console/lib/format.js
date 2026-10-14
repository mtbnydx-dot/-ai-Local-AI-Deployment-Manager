// Locale-aware number, size, duration and date formatting (07 §3.7).
//
// Everything goes through Intl, so this module holds no copy of its own.
// Sizes are binary and keep the GiB/MiB labels in both locales. Missing or
// non-finite values render as an em dash. `timeZone` is optional and exists
// so the golden test is independent of the machine's zone.

const DASH = "\u2014";
const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;
const DURATION_UNITS = [
  ["day", 86400000],
  ["hour", 3600000],
  ["minute", 60000],
  ["second", 1000],
];
const RELATIVE_STEPS = [
  ["second", 45, 1],
  ["minute", 45 * 60, 60],
  ["hour", 22 * 3600, 3600],
  ["day", 26 * 86400, 86400],
  ["month", 320 * 86400, 30 * 86400],
  ["year", Infinity, 365 * 86400],
];

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

/**
 * @param {"zh-CN"|"en-US"} locale
 * @returns formatters: number, integer, percent, bytes, mib, tokens, duration, rate, dateTime, time, relative, range
 */
export function createFormatters(locale, { timeZone } = {}) {
  const cache = new Map();
  const numberFormat = (options) => {
    const key = JSON.stringify(options);
    if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(locale, options));
    return cache.get(key);
  };
  const zone = timeZone ? { timeZone } : {};
  const dateStyles = {
    short: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", hourCycle: "h23", ...zone }),
    medium: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23", ...zone }),
    long: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23", ...zone }),
    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", ...zone }),
  };
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", ...zone });
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  /** A number with at most `digits` fraction digits (default 2). */
  function number(value, digits = 2) {
    const n = finite(value);
    return n === null ? DASH : numberFormat({ maximumFractionDigits: digits }).format(n);
  }

  function integer(value) {
    const n = finite(value);
    return n === null ? DASH : numberFormat({ maximumFractionDigits: 0 }).format(Math.round(n));
  }

  /** A ratio (0.612) as a percentage with exactly `digits` fraction digits ("61.2%"). */
  function percent(ratio, digits = 1) {
    const n = finite(ratio);
    return n === null ? DASH : numberFormat({ style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  }

  /** Binary sizes: "58.2 GiB"; `unit` forces MiB or GiB. */
  function bytes(value, { unit = "auto" } = {}) {
    const n = finite(value);
    if (n === null) return DASH;
    if (unit === "MiB") return `${number(n / MIB, 1)} MiB`;
    if (unit === "GiB") return `${number(n / GIB, 1)} GiB`;
    let index = 0;
    let scaled = Math.abs(n);
    while (scaled >= KIB && index < BINARY_UNITS.length - 1) {
      scaled /= KIB;
      index += 1;
    }
    const signed = n < 0 ? -scaled : scaled;
    return index === 0 ? `${integer(signed)} B` : `${number(signed, 1)} ${BINARY_UNITS[index]}`;
  }

  /** A MiB quantity as the backends report it (admission, plans): "96,801 MiB". */
  function mib(value) {
    const n = finite(value);
    return n === null ? DASH : `${integer(n)} MiB`;
  }

  /** Token counts with a binary short form: "262,144 (256K)". */
  function tokens(value) {
    const n = finite(value);
    if (n === null) return DASH;
    const full = integer(n);
    const size = Math.abs(n);
    if (size >= MIB) return `${full} (${number(n / MIB, 1)}M)`;
    if (size >= KIB) return `${full} (${number(n / KIB, 1)}K)`;
    return full;
  }

  /**
   * Durations as the two largest units ("9 min 5 sec" / "9分钟5秒");
   * below one second in milliseconds. `style` is an Intl unitDisplay.
   */
  function duration(ms, { style = "short" } = {}) {
    const n = finite(ms);
    if (n === null) return DASH;
    const sign = n < 0 ? "-" : "";
    const rest = Math.abs(n);
    const unitText = (unit, amount) => numberFormat({ style: "unit", unit, unitDisplay: style, maximumFractionDigits: 0 }).format(amount);
    if (rest < 1000) return `${sign}${unitText("millisecond", rest)}`;
    const index = DURATION_UNITS.findIndex(([, size]) => rest >= size);
    const [unit, size] = DURATION_UNITS[index];
    const amount = Math.floor(rest / size);
    const parts = [unitText(unit, amount)];
    const next = DURATION_UNITS[index + 1];
    if (next) {
      const smaller = Math.floor((rest - amount * size) / next[1]);
      if (smaller > 0) parts.push(unitText(next[0], smaller));
    }
    const joiner = locale === "zh-CN" ? "" : " ";
    return `${sign}${parts.join(joiner)}`;
  }

  /** A rate with one fraction digit and its unit: "38.6 tok/s". */
  function rate(value, unit) {
    const n = finite(value);
    return n === null ? DASH : `${number(n, 1)} ${unit}`;
  }

  /** A date and time; `style` is short, medium (default), long or date. */
  function dateTime(value, { style = "medium" } = {}) {
    const date = toDate(value);
    return date ? (dateStyles[style] || dateStyles.medium).format(date) : DASH;
  }

  /** A 24-hour clock time, "08:00:05". */
  function time(value) {
    const date = toDate(value);
    return date ? timeFormat.format(date) : DASH;
  }

  /** "3 minutes ago" / "3分钟前" relative to `now` (ms or ISO). */
  function relative(value, now = Date.now()) {
    const date = toDate(value);
    const reference = toDate(now);
    if (!date || !reference) return DASH;
    const seconds = Math.round((date.getTime() - reference.getTime()) / 1000);
    const size = Math.abs(seconds);
    for (const [unit, below, divisor] of RELATIVE_STEPS) {
      if (size < below) return relativeFormat.format(Math.round(seconds / divisor), unit);
    }
    return DASH;
  }

  /** A from–to range, collapsing shared date parts. */
  function range(from, to) {
    const start = toDate(from);
    const end = toDate(to);
    if (!start || !end) return DASH;
    try {
      return dateStyles.medium.formatRange(start, end);
    } catch {
      return `${dateStyles.medium.format(start)} \u2013 ${dateStyles.medium.format(end)}`;
    }
  }

  return { locale, number, integer, percent, bytes, mib, tokens, duration, rate, dateTime, time, relative, range };
}
