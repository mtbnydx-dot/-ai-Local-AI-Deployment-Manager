"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("..");

// Feeds a counter that grows by `perSecond` output tokens per second.
function counters(time, perSecond = 10) {
  return { promptTokens: time * 2 * perSecond, generationTokens: time * perSecond, requestCount: Math.floor(time / 6) };
}

test("the history sampler alone (updateSamples=false) produces rates once 10 s of samples exist", () => {
  const samples = new Map();
  assert.deepEqual(core.calculateRecentRates(samples, "m", 1000, counters(1000), false), {
    recentPromptTokensPerSecond: 0,
    recentOutputTokensPerSecond: 0,
    recentRequestsPerMinute: 0,
  });
  // 5 s later there is still no baseline old enough.
  const early = core.calculateRecentRates(samples, "m", 1005, counters(1005), false);
  assert.equal(early.recentOutputTokensPerSecond, 0);
  assert.equal(early.windowSeconds, undefined);
  const later = core.calculateRecentRates(samples, "m", 1060, counters(1060), false);
  assert.equal(later.recentOutputTokensPerSecond, 10);
  assert.equal(later.recentPromptTokensPerSecond, 20);
  assert.equal(later.windowSeconds, 60, "the 1000 sample is exactly 60 s old");
});

test("the baseline is the 10-150 s old sample closest to the requested window", () => {
  const samples = new Map();
  for (const time of [0, 30, 60, 90, 100]) core.calculateRecentRates(samples, "m", time, counters(time), true);
  const window60 = core.calculateRecentRates(new Map([["m", samples.get("m").slice()]]), "m", 120, counters(120, 10), true);
  assert.equal(window60.windowSeconds, 60);
  assert.equal(window60.recentOutputTokensPerSecond, 10);
  const window30 = core.calculateRecentRates(new Map([["m", samples.get("m").slice()]]), "m", 120, counters(120), true, { windowSeconds: 30 });
  assert.equal(window30.windowSeconds, 30);
  // Samples younger than 10 s never serve as the baseline.
  const window5 = core.calculateRecentRates(new Map([["m", samples.get("m").slice()]]), "m", 108, counters(108), true, { windowSeconds: 5 });
  assert.equal(window5.windowSeconds, 18);
});

test("samples are spaced at least 2 s apart, whoever polls", () => {
  const samples = new Map();
  for (const time of [0, 0.5, 1, 1.9, 2, 3, 3.5, 4.1]) core.calculateRecentRates(samples, "m", time, counters(time), true);
  assert.deepEqual(samples.get("m").map((sample) => sample.time), [0, 2, 4.1]);
  // Several tabs polling at the same moment give the same answer.
  const first = core.calculateRecentRates(samples, "m", 30, counters(30), true);
  const second = core.calculateRecentRates(samples, "m", 30, counters(30), true);
  assert.deepEqual(first, second);
});

test("a counter reset clears the buffer, returns zeros and restarts the window", () => {
  const samples = new Map();
  for (const time of [0, 20, 40]) core.calculateRecentRates(samples, "m", time, counters(time), true);
  const reset = core.calculateRecentRates(samples, "m", 50, { promptTokens: 5, generationTokens: 3, requestCount: 0 }, true);
  assert.deepEqual(reset, { recentPromptTokensPerSecond: 0, recentOutputTokensPerSecond: 0, recentRequestsPerMinute: 0 });
  assert.equal(samples.get("m").length, 1);
  const after = core.calculateRecentRates(samples, "m", 70, { promptTokens: 45, generationTokens: 23, requestCount: 2 }, true);
  assert.equal(after.windowSeconds, 20);
  assert.equal(after.recentOutputTokensPerSecond, 1);
  assert.equal(after.recentPromptTokensPerSecond, 2);
  assert.equal(after.recentRequestsPerMinute, 6);
});

test("keys are isolated", () => {
  const samples = new Map();
  core.calculateRecentRates(samples, "vllm:a", 0, counters(0, 10), true);
  core.calculateRecentRates(samples, "sglang:a", 0, counters(0, 50), true);
  const a = core.calculateRecentRates(samples, "vllm:a", 60, counters(60, 10), true);
  const b = core.calculateRecentRates(samples, "sglang:a", 60, counters(60, 50), true);
  assert.equal(a.recentOutputTokensPerSecond, 10);
  assert.equal(b.recentOutputTokensPerSecond, 50);
  const fresh = core.calculateRecentRates(samples, "llama:other", 60, counters(60), true);
  assert.equal(fresh.recentOutputTokensPerSecond, 0);
});

test("the buffer is bounded to 40 samples and 150 s", () => {
  const samples = new Map();
  for (let time = 0; time <= 200; time += 2) core.calculateRecentRates(samples, "m", time, counters(time), true);
  const buffer = samples.get("m");
  assert.equal(buffer.length, 40);
  assert.ok(buffer.every((sample) => 200 - sample.time <= 150));

  const slow = new Map();
  for (const time of [0, 60, 120, 180, 240]) core.calculateRecentRates(slow, "m", time, counters(time), false);
  assert.ok(slow.get("m").every((sample) => 240 - sample.time <= 150));
  // A gap longer than 150 s leaves no baseline.
  const gap = core.calculateRecentRates(slow, "m", 500, counters(500), false);
  assert.equal(gap.recentOutputTokensPerSecond, 0);
  assert.deepEqual(slow.get("m").map((sample) => sample.time), [500]);
});

test("a legacy single-sample store value is still accepted", () => {
  const samples = new Map([["m", { time: 0, promptTokens: 0, generationTokens: 0, requestCount: 0 }]]);
  const rates = core.calculateRecentRates(samples, "m", 60, counters(60), true);
  assert.equal(rates.recentOutputTokensPerSecond, 10);
  assert.equal(rates.windowSeconds, 60);
  assert.ok(Array.isArray(samples.get("m")));
});
