"use strict";

// Cumulative histograms in the Prometheus shape that 01's metrics route
// returns: `{ le, counts, sum, count }`, where `le` lists the bucket upper
// bounds ending with "+Inf" and `counts[i]` is the number of observations
// <= le[i]. The same shape serves the fixed gateway buckets (rollup columns
// store `counts`) and engine histograms (`deltaCumulative` over two scrapes).
// Persisted runtime-sample JSON may name the counts `d`; every function here
// reads either name and always writes `counts`.
//
// "+Inf" stays a string so the bounds survive JSON.stringify unchanged.

const INF = "+Inf";

// Gateway latency in milliseconds: TTFT, upstream headers and request duration.
const GATEWAY_MS_BUCKETS = Object.freeze([
  5, 10, 25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000,
  7500, 10000, 15000, 30000, 60000, 120000, 300000, 600000, INF,
]);

// Per-request decode speed in tokens per second.
const DECODE_TPS_BUCKETS = Object.freeze([
  1, 2, 5, 10, 15, 20, 30, 40, 50, 60, 80, 100, 125, 150, 200, 250, 300,
  400, 500, 750, 1000, INF,
]);

function boundValue(bound) {
  if (bound === INF || bound === "Inf" || bound === "inf" || bound === Infinity) return Infinity;
  const value = Number(bound);
  return Number.isNaN(value) ? NaN : value;
}

function boundKey(bound) {
  const value = boundValue(bound);
  return value === Infinity ? INF : value;
}

function normalizeBounds(le) {
  const bounds = Array.from(le || [], boundKey);
  if (!bounds.length || bounds[bounds.length - 1] !== INF) bounds.push(INF);
  return bounds;
}

function readCounts(hist) {
  const counts = Array.isArray(hist?.counts) ? hist.counts : hist?.d;
  return Array.isArray(counts) ? counts : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function sameBounds(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (boundValue(a[index]) !== boundValue(b[index])) return false;
  }
  return true;
}

// Returns a hist with sorted-as-given bounds, numeric counts and a total, or
// null when the input is not a histogram.
function toHist(hist) {
  const counts = readCounts(hist);
  if (!hist || !Array.isArray(hist.le) || !counts || counts.length !== hist.le.length) return null;
  const numeric = counts.map((value) => Number(value) || 0);
  const total = finiteOrNull(hist.count) ?? numeric[numeric.length - 1] ?? 0;
  return { le: hist.le.map(boundKey), counts: numeric, sum: finiteOrNull(hist.sum), count: total };
}

function newHist(le = GATEWAY_MS_BUCKETS) {
  const bounds = normalizeBounds(le);
  return { le: bounds, counts: new Array(bounds.length).fill(0), sum: 0, count: 0 };
}

// Adds one observation. Values that are not finite numbers are ignored.
function observe(hist, value) {
  if (!hist || value === null || value === undefined || value === "") return hist;
  const number = Number(value);
  if (!Number.isFinite(number)) return hist;
  const counts = readCounts(hist);
  for (let index = 0; index < hist.le.length; index += 1) {
    if (number <= boundValue(hist.le[index])) counts[index] += 1;
  }
  hist.sum = (Number(hist.sum) || 0) + number;
  hist.count = (Number(hist.count) || 0) + 1;
  return hist;
}

// Sums two histograms with the same bounds. A missing side is the identity,
// so `list.reduce(mergeHist, null)` works. Different bounds cannot be merged
// and throw `histogram_bounds_mismatch`.
function mergeHist(a, b) {
  const left = a ? toHist(a) : null;
  const right = b ? toHist(b) : null;
  if (a && !left) throw histogramError("histogram_invalid", "Left histogram is malformed.");
  if (b && !right) throw histogramError("histogram_invalid", "Right histogram is malformed.");
  if (!left || !right) return left || right || null;
  if (!sameBounds(left.le, right.le)) {
    throw histogramError("histogram_bounds_mismatch", "Histograms with different bucket bounds cannot be merged.");
  }
  return {
    le: left.le.slice(),
    counts: left.counts.map((value, index) => value + right.counts[index]),
    sum: left.sum === null || right.sum === null ? null : left.sum + right.sum,
    count: left.count + right.count,
  };
}

// The increase between two cumulative snapshots of one histogram, as a
// histogram of the interval. Returns null when there is no usable baseline:
// a missing side, changed bounds, or any count that went down (a restart).
function deltaCumulative(prev, cur) {
  const before = prev ? toHist(prev) : null;
  const after = cur ? toHist(cur) : null;
  if (!before || !after || !sameBounds(before.le, after.le)) return null;
  if (after.count < before.count) return null;
  const counts = [];
  for (let index = 0; index < after.counts.length; index += 1) {
    const delta = after.counts[index] - before.counts[index];
    if (delta < 0) return null;
    counts.push(delta);
  }
  const sum = before.sum === null || after.sum === null ? null : after.sum - before.sum;
  return { le: after.le.slice(), counts, sum, count: after.count - before.count };
}

// Prometheus histogram_quantile(q, …): linear interpolation inside the bucket
// that holds the q-th observation, with the lower bound of the first bucket
// taken as 0 (or the bucket's own bound when that is <= 0), and the highest
// finite bound returned for ranks that fall into the +Inf bucket. Counts that
// decrease across buckets are raised to the running maximum first, as
// Prometheus does. Where Prometheus yields NaN (no observations, fewer than
// two buckets, no +Inf bucket, q is NaN) this returns null, so the result can
// go straight into a nullable column. q < 0 gives -Infinity and q > 1 gives
// Infinity, as in Prometheus.
function quantile(hist, q) {
  const parsed = toHist(hist);
  const level = Number(q);
  if (q === null || q === undefined || Number.isNaN(level)) return null;
  if (level < 0) return -Infinity;
  if (level > 1) return Infinity;
  if (!parsed) return null;
  const buckets = parsed.le
    .map((bound, index) => ({ upperBound: boundValue(bound), count: parsed.counts[index] }))
    .filter((bucket) => !Number.isNaN(bucket.upperBound))
    .sort((left, right) => left.upperBound - right.upperBound);
  if (!buckets.length || buckets[buckets.length - 1].upperBound !== Infinity) return null;
  // Buckets with the same bound are one bucket.
  const coalesced = [];
  for (const bucket of buckets) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.upperBound === bucket.upperBound) last.count += bucket.count;
    else coalesced.push({ ...bucket });
  }
  let max = -Infinity;
  for (const bucket of coalesced) {
    if (bucket.count < max) bucket.count = max;
    else max = bucket.count;
  }
  if (coalesced.length < 2) return null;
  const observations = coalesced[coalesced.length - 1].count;
  if (!(observations > 0)) return null;
  let rank = level * observations;
  let index = coalesced.length - 1;
  for (let candidate = 0; candidate < coalesced.length - 1; candidate += 1) {
    if (coalesced[candidate].count >= rank) {
      index = candidate;
      break;
    }
  }
  if (index === coalesced.length - 1) return coalesced[coalesced.length - 2].upperBound;
  if (index === 0 && coalesced[0].upperBound <= 0) return coalesced[0].upperBound;
  let bucketStart = 0;
  const bucketEnd = coalesced[index].upperBound;
  let count = coalesced[index].count;
  if (index > 0) {
    bucketStart = coalesced[index - 1].upperBound;
    count -= coalesced[index - 1].count;
    rank -= coalesced[index - 1].count;
  }
  // Only q = 0 over an empty first bucket reaches 0 / 0 here.
  const value = bucketStart + (bucketEnd - bucketStart) * (rank / count);
  return Number.isNaN(value) ? null : value;
}

function histogramError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  GATEWAY_MS_BUCKETS,
  DECODE_TPS_BUCKETS,
  newHist,
  observe,
  mergeHist,
  deltaCumulative,
  quantile,
};
