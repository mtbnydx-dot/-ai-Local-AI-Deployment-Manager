"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAuthFailureGuard, maskAddress } = require("../auth-failure-guard");

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("bans a client after the failure threshold and lifts the ban after banMs", () => {
  const time = clock();
  const guard = createAuthFailureGuard({ maxFailures: 3, windowMs: 60_000, banMs: 120_000, now: time.now });
  assert.equal(guard.check("203.0.113.9").banned, false);
  assert.equal(guard.record("203.0.113.9").banned, false);
  assert.equal(guard.record("203.0.113.9").banned, false);
  const third = guard.record("203.0.113.9");
  assert.equal(third.banned, true);
  assert.equal(third.retryAfterSeconds, 120);
  const blocked = guard.check("203.0.113.9");
  assert.equal(blocked.banned, true);
  assert.equal(blocked.retryAfterSeconds, 120);
  time.advance(60_000);
  assert.equal(guard.check("203.0.113.9").retryAfterSeconds, 60);
  time.advance(60_001);
  assert.equal(guard.check("203.0.113.9").banned, false);
  // Other clients are unaffected.
  assert.equal(guard.check("203.0.113.10").banned, false);
});

test("failures outside the window expire and a success clears the counter", () => {
  const time = clock();
  const guard = createAuthFailureGuard({ maxFailures: 3, windowMs: 10_000, banMs: 60_000, now: time.now });
  guard.record("a");
  guard.record("a");
  time.advance(10_001);
  assert.equal(guard.record("a").failures, 1, "old failures dropped");
  guard.clear("a");
  assert.equal(guard.record("a").failures, 1, "cleared after success");
});

test("describe masks client addresses and counts bans", () => {
  const time = clock();
  const guard = createAuthFailureGuard({ maxFailures: 1, banMs: 60_000, now: time.now });
  guard.record("198.51.100.77");
  guard.record("2001:db8::1");
  guard.check("198.51.100.77");
  const state = guard.describe();
  assert.equal(state.bannedCount, 2);
  assert.equal(state.bansIssued, 2);
  assert.equal(state.blockedRequests, 1);
  assert.ok(state.banned.every((item) => !item.client.includes("77") && !item.client.endsWith("::1")));
  assert.equal(maskAddress("198.51.100.77"), "198.51.100.x");
  assert.equal(maskAddress("2001:db8::1"), "2001:db8:…");
});

test("tracked entries are bounded", () => {
  const time = clock();
  const guard = createAuthFailureGuard({ maxFailures: 100, maxEntries: 100, now: time.now });
  for (let index = 0; index < 250; index += 1) guard.record(`10.0.0.${index}`);
  assert.ok(guard.describe().tracked <= 100);
});
