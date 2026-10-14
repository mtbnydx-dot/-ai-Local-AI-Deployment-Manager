"use strict";

// Energy integration and electricity pricing (docs/overhaul/04-telemetry.md
// §8 and §14).
//
// integrateEnergyWh turns two consecutive samples of one GPU into the Wh it
// drew between them; the GpuCollector stores the result in
// gpu_samples.energy_wh. priceAt and costOf price energy with the *current*
// telemetry.energy configuration (the UI says "at current tariff"):
//
//   { pricePerKwh: number|null, currency: "CNY",
//     tariffs: [{ from: "HH:MM", to: "HH:MM", pricePerKwh }], hostBaselineWatts }
//
// Tariff windows are local wall-clock time and half-open, [from, to). A window
// whose `to` is earlier than its `from` crosses midnight ("23:00"–"07:00"
// covers 23:00 up to 06:59:59.999), and one whose `from` equals its `to`
// covers the whole day. The first matching window wins (OPS-3's validator
// rejects overlaps). Outside every window the flat pricePerKwh applies, and
// pricePerKwh: null with no tariffs means no price is configured.
//
// "Local" is telemetry.timezoneOffsetMinutes when the caller passes it (as
// options.timezoneOffsetMinutes or energyConfig.timezoneOffsetMinutes), and
// the host's offset at that instant otherwise, the same day boundary the
// rollups use (§10).

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_CURRENCY = "CNY";
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positive(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function epochMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "string" && value.trim() && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return finiteNumber(value);
}

// Six decimals keep stored Wh and money free of float noise (1e-6 Wh is far
// below what a 10 s sample can resolve).
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

// Wh drawn between two samples of one GPU: cur.powerW × min(Δt, 2 × interval)
// (§8). The cap keeps a collector outage, a restart or a stuck clock from
// being filled in at the last power reading. A sample without a power
// reading or a predecessor, or with a clock that did not move forward,
// integrates nothing and returns null (never 0).
function integrateEnergyWh(prev, cur, options = {}) {
  const power = nonNegative(cur && cur.powerW);
  if (power === null) return null;
  const prevAt = epochMs(prev && prev.at);
  const curAt = epochMs(cur && cur.at);
  if (prevAt === null || curAt === null) return null;
  const elapsedMs = curAt - prevAt;
  if (!(elapsedMs > 0)) return null;
  const intervalMs = positive(options && options.intervalMs) ?? DEFAULT_INTERVAL_MS;
  return round6((power * Math.min(elapsedMs, 2 * intervalMs)) / HOUR_MS);
}

// "HH:MM" to milliseconds after local midnight. "24:00" is accepted as the
// end of the day; anything else out of range is null.
function timeOfDayMs(text) {
  const match = TIME_OF_DAY.exec(String(text ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return (hours * 60 + minutes) * MINUTE_MS;
}

function hostOffsetMinutes(atMs) {
  const offset = -new Date(atMs).getTimezoneOffset();
  return Number.isFinite(offset) ? offset : 0;
}

// Invalid tariff entries (bad times, a missing or negative price) are
// skipped rather than guessed at.
function energyPlan(energyConfig, options) {
  const config = energyConfig && typeof energyConfig === "object" ? energyConfig : {};
  const tariffs = [];
  for (const entry of Array.isArray(config.tariffs) ? config.tariffs : []) {
    if (!entry || typeof entry !== "object") continue;
    const fromMs = timeOfDayMs(entry.from);
    const toMs = timeOfDayMs(entry.to);
    const price = nonNegative(entry.pricePerKwh);
    if (fromMs === null || toMs === null || price === null) continue;
    tariffs.push({ fromMs: mod(fromMs, DAY_MS), toMs: mod(toMs, DAY_MS), price });
  }
  const base = nonNegative(config.pricePerKwh);
  const offset = finiteNumber(options && options.timezoneOffsetMinutes) ?? finiteNumber(config.timezoneOffsetMinutes);
  const currency = typeof config.currency === "string" && CURRENCY_CODE.test(config.currency.trim())
    ? config.currency.trim()
    : DEFAULT_CURRENCY;
  return { base, tariffs, offset, currency, configured: base !== null || tariffs.length > 0 };
}

function localTimeOfDayMs(plan, atMs) {
  const offset = plan.offset ?? hostOffsetMinutes(atMs);
  return mod(atMs + offset * MINUTE_MS, DAY_MS);
}

function inWindow(localMs, tariff) {
  if (tariff.fromMs === tariff.toMs) return true;
  if (tariff.fromMs < tariff.toMs) return localMs >= tariff.fromMs && localMs < tariff.toMs;
  return localMs >= tariff.fromMs || localMs < tariff.toMs;
}

function planPriceAt(plan, atMs) {
  const localMs = localTimeOfDayMs(plan, atMs);
  for (const tariff of plan.tariffs) {
    if (inWindow(localMs, tariff)) return tariff.price;
  }
  return plan.base;
}

// The price per kWh in force at atMs, or null when none applies.
function priceAt(atMs, energyConfig, options = {}) {
  const at = epochMs(atMs);
  if (at === null) return null;
  return planPriceAt(energyPlan(energyConfig, options), at);
}

// Cuts [start, end) wherever a tariff window opens or closes and prices each
// piece at its midpoint, so a bucket that a "07:30" boundary splits is priced
// half at each rate. Energy is taken as uniform within a bucket.
function priceSegments(plan, start, end) {
  const cuts = new Set([start, end]);
  if (plan.tariffs.length) {
    const startLocal = localTimeOfDayMs(plan, start);
    for (const tariff of plan.tariffs) {
      for (const boundary of [tariff.fromMs, tariff.toMs]) {
        for (let at = start + mod(boundary - startLocal, DAY_MS); at < end; at += DAY_MS) {
          if (at > start) cuts.add(at);
        }
      }
    }
  }
  const points = Array.from(cuts).sort((left, right) => left - right);
  const segments = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    segments.push({ fraction: (to - from) / (end - start), price: planPriceAt(plan, from + (to - from) / 2) });
  }
  return segments;
}

// Accepts a Map or plain object of bucketStartMs → Wh, an array of
// [bucketStartMs, Wh] pairs, or an array of rows ({ bucket | at | hour,
// energyWh | wh }) as the rollup queries return them.
function bucketEntries(whByHour) {
  if (!whByHour) return [];
  if (whByHour instanceof Map) return Array.from(whByHour.entries());
  if (Array.isArray(whByHour)) {
    return whByHour.map((item) => {
      if (Array.isArray(item)) return [item[0], item[1]];
      if (item && typeof item === "object") return [item.bucket ?? item.at ?? item.hour, item.energyWh ?? item.wh];
      return [null, null];
    });
  }
  if (typeof whByHour === "object") return Object.entries(whByHour);
  return [];
}

// Cost of hourly energy at the current tariff (§14). Each bucket is priced by
// the tariff in force during it (priceAt), split at window boundaries. The
// result keeps the energy that no price covered visible instead of pricing it
// at 0: `cost` is null when no price is configured or when none of the energy
// could be priced; `unpricedWh` > 0 marks a partial figure.
// options: { timezoneOffsetMinutes, bucketMs = 1 hour }.
function costOf(whByHour, energyConfig, options = {}) {
  const plan = energyPlan(energyConfig, options);
  const bucketMs = positive(options && options.bucketMs) ?? HOUR_MS;
  let energyWh = 0;
  let pricedWh = 0;
  let unpricedWh = 0;
  let cost = 0;
  for (const [bucketKey, whValue] of bucketEntries(whByHour)) {
    const bucket = epochMs(bucketKey);
    const wh = nonNegative(whValue);
    if (bucket === null || wh === null) continue;
    energyWh += wh;
    if (!plan.configured) {
      unpricedWh += wh;
      continue;
    }
    for (const segment of priceSegments(plan, bucket, bucket + bucketMs)) {
      const share = wh * segment.fraction;
      if (segment.price === null) {
        unpricedWh += share;
      } else {
        pricedWh += share;
        cost += (share / 1000) * segment.price;
      }
    }
  }
  const priced = plan.configured && (pricedWh > 0 || unpricedWh === 0);
  return {
    cost: priced ? round6(cost) : null,
    currency: plan.currency,
    priceConfigured: plan.configured,
    energyWh: round6(energyWh),
    pricedWh: round6(pricedWh),
    unpricedWh: round6(unpricedWh),
  };
}

module.exports = {
  integrateEnergyWh,
  priceAt,
  costOf,
};
