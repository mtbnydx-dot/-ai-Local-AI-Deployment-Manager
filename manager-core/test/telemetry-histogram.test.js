"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  GATEWAY_MS_BUCKETS,
  DECODE_TPS_BUCKETS,
  newHist,
  observe,
  mergeHist,
  deltaCumulative,
  quantile,
} = require("../telemetry/histogram");
const reference = require("./fixtures/telemetry/histogram-prometheus.json");

function expectedValue(value) {
  if (value === "+Inf") return Infinity;
  if (value === "-Inf") return -Infinity;
  return value;
}

function assertClose(actual, expected, message) {
  if (!Number.isFinite(expected)) {
    assert.equal(actual, expected, message);
    return;
  }
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} != ${expected}`);
}

// A cumulative snapshot of the rate case at a given step.
function snapshot(le, perStep, step) {
  return perStep.map((series) => ({ le, counts: series.counts.map((value) => value * step) }));
}

function randomHist(seed, le = GATEWAY_MS_BUCKETS) {
  const hist = newHist(le);
  let state = seed;
  for (let index = 0; index < 50; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    observe(hist, state % 700000);
  }
  return hist;
}

test("quantile matches the Prometheus histogram_quantile reference values", () => {
  for (const item of reference.quantileCases) {
    for (const [q, value] of item.expected) {
      assertClose(quantile({ le: item.le, counts: item.counts }, q), expectedValue(value), `${item.name} q=${q}`);
    }
  }
});

test("rate-then-quantile: deltaCumulative per series, mergeHist across series", () => {
  const { le, perStep, fromStep, toStep, expected } = reference.rateCase;
  const before = snapshot(le, perStep, fromStep);
  const after = snapshot(le, perStep, toStep);
  const deltas = after.map((current, index) => deltaCumulative(before[index], current));
  assert.ok(deltas.every(Boolean));
  const summed = deltas.reduce(mergeHist, null);
  assert.deepEqual(summed.counts, [10, 19, 25]);
  for (const [q, value] of expected) assertClose(quantile(summed, q), value, `q=${q}`);
});

test("quantile returns null where Prometheus yields NaN", () => {
  assert.equal(quantile(newHist([1, 2, "+Inf"]), 0.5), null, "no observations");
  assert.equal(quantile({ le: ["+Inf"], counts: [5] }, 0.5), null, "fewer than two buckets");
  assert.equal(quantile({ le: [1, 2], counts: [1, 2] }, 0.5), null, "no +Inf bucket");
  assert.equal(quantile({ le: [1, 2, "+Inf"], counts: [0, 2, 2] }, 0), null, "q=0 over an empty first bucket");
  assert.equal(quantile({ le: [1, "+Inf"], counts: [1, 1] }, NaN), null);
  assert.equal(quantile(null, 0.5), null);
  assert.equal(quantile({ le: [1, "+Inf"], counts: [1] }, 0.5), null, "malformed");
});

test("ranks in the +Inf bucket return the highest finite bound", () => {
  const hist = newHist([100, 200, "+Inf"]);
  for (const value of [50, 5000, 6000, 7000]) observe(hist, value);
  assert.equal(quantile(hist, 0.95), 200);
});

test("observe fills cumulative buckets and ignores values that are not numbers", () => {
  const hist = newHist([10, 100, "+Inf"]);
  for (const value of [5, 10, 11, 100, 101, 1e9, null, undefined, "", "abc", NaN, Infinity]) observe(hist, value);
  assert.deepEqual(hist.counts, [2, 4, 6]);
  assert.equal(hist.count, 6);
  assert.equal(hist.sum, 5 + 10 + 11 + 100 + 101 + 1e9);
  // Linear interpolation inside (10, 100]: rank 3 of 6 is the first of the two observations there.
  assert.equal(quantile(hist, 0.5), 10 + 90 * (1 / 2));
});

test("newHist appends +Inf and the bounds survive JSON", () => {
  const hist = newHist([1, 2, 3]);
  assert.deepEqual(hist.le, [1, 2, 3, "+Inf"]);
  const copy = JSON.parse(JSON.stringify(observe(hist, 2.5)));
  assert.deepEqual(copy, { le: [1, 2, 3, "+Inf"], counts: [0, 0, 1, 1], sum: 2.5, count: 1 });
  assert.equal(quantile(copy, 1), 3);
});

test("bucket constants are increasing and end with +Inf", () => {
  for (const bounds of [GATEWAY_MS_BUCKETS, DECODE_TPS_BUCKETS]) {
    assert.ok(Object.isFrozen(bounds));
    assert.equal(bounds[bounds.length - 1], "+Inf");
    const finite = bounds.slice(0, -1);
    assert.ok(finite.every((value, index) => typeof value === "number" && (index === 0 || value > finite[index - 1])));
    assert.deepEqual(newHist(bounds).le, Array.from(bounds));
  }
  assert.equal(GATEWAY_MS_BUCKETS[GATEWAY_MS_BUCKETS.length - 2], 600000);
});

test("deltaCumulative returns null on a reset or when there is no baseline", () => {
  const before = { le: [1, 2, "+Inf"], counts: [3, 5, 6], sum: 7, count: 6 };
  const after = { le: [1, 2, "+Inf"], counts: [4, 7, 9], sum: 11, count: 9 };
  assert.deepEqual(deltaCumulative(before, after), { le: [1, 2, "+Inf"], counts: [1, 2, 3], sum: 4, count: 3 });
  assert.equal(deltaCumulative(after, before), null, "counter decrease (restart)");
  assert.equal(deltaCumulative({ ...before, counts: [3, 8, 8], count: 8 }, after), null, "one bucket decreased");
  assert.equal(deltaCumulative(before, { ...after, le: [1, 5, "+Inf"] }), null, "bounds changed");
  assert.equal(deltaCumulative(null, after), null, "no baseline");
  assert.equal(deltaCumulative(before, null), null);
  assert.deepEqual(deltaCumulative(after, after).counts, [0, 0, 0]);
});

test("deltaCumulative accepts the persisted {le, d} shape and numeric +Inf", () => {
  const before = { le: [0.5, 1, Infinity], d: [1, 1, 2] };
  const after = { le: [0.5, 1, "+Inf"], d: [3, 4, 6] };
  assert.deepEqual(deltaCumulative(before, after), { le: [0.5, 1, "+Inf"], counts: [2, 3, 4], sum: null, count: 4 });
});

test("mergeHist is associative and commutative, with null as identity", () => {
  const a = randomHist(1);
  const b = randomHist(2);
  const c = randomHist(3);
  const left = mergeHist(mergeHist(a, b), c);
  const right = mergeHist(a, mergeHist(b, c));
  assert.deepEqual(left, right);
  assert.deepEqual(mergeHist(a, b), mergeHist(b, a));
  assert.deepEqual(mergeHist(null, a), mergeHist(a, null));
  assert.deepEqual(mergeHist(null, a).counts, a.counts);
  assert.equal(mergeHist(null, null), null);
  assert.equal(left.count, 150);
  assert.equal(left.counts[left.counts.length - 1], 150);
  // Merging does not touch its inputs.
  const snapshotA = JSON.stringify(a);
  mergeHist(a, b);
  assert.equal(JSON.stringify(a), snapshotA);
  assert.equal(quantile(left, 0.5), quantile([a, b, c].reduce(mergeHist, null), 0.5));
});

test("mergeHist refuses histograms with different bounds", () => {
  assert.throws(() => mergeHist(newHist([1, "+Inf"]), newHist([2, "+Inf"])), { code: "histogram_bounds_mismatch" });
  assert.throws(() => mergeHist({ le: [1, "+Inf"], counts: [1] }, newHist([1, "+Inf"])), { code: "histogram_invalid" });
});
