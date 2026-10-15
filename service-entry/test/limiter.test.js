"use strict";

// The one limiter (05 §9, PUB-9): token buckets, the pre-auth bucket,
// persistent bans with escalation, quotas in the quota tz, the public share
// gate and the response headers. Everything runs on a fake clock; the store
// is a real node:sqlite keys-store in a temp dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const core = require("../../manager-core");
const { createKeysStore } = require("../lib/keys-store");
const { lookupPublicError } = require("../lib/public-errors");
const { parseCidrList } = require("../lib/trusted-proxy");
const {
  createLimiter,
  createPersistentBanGuard,
  createShareGate,
  createTokenBucketMap,
  estimateAdmission,
  rateLimitHeaders,
} = require("../lib/limiter");

const START = Date.parse("2026-10-14T00:00:00.000Z");
const SECOND = 1000;
const HOUR = 3600 * SECOND;

function silentLogger() {
  return { warn() {}, error() {}, log() {} };
}

// A store on a temp file that can be closed and reopened; the clock is the
// test's.
function makeStore(t, clock, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limiter-"));
  const file = path.join(dir, "platform-access.sqlite");
  const opened = [];
  const open = (extra = {}) => {
    const store = createKeysStore({ file, DatabaseSync, now: () => new Date(clock.ms), tzOffsetMinutes: 0, ...options, ...extra });
    opened.push(store);
    return store;
  };
  const store = open();
  t.after(() => {
    for (const item of opened) {
      try { item.close(); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, open, file };
}

function fakeKey(limits = {}, extra = {}) {
  return { id: `k_${"a".repeat(20)}`, class: "friend", limits, ...extra };
}

function keyCaller(key) {
  return { ok: true, kind: "key", key };
}

const PUBLIC_IP = { ip: "203.0.113.9", socketIp: "203.0.113.9", missingHeader: false };

function chatBody(chars, extra = {}) {
  return { model: "m", messages: [{ role: "user", content: "x".repeat(chars) }], ...extra };
}

// ---- 9.1 token buckets ----------------------------------------------------

test("a bucket starts full, refills with the clock and reports reset and retry-after", () => {
  const buckets = createTokenBucketMap();
  const spec = { capacity: 10, refillPerSec: 1, cost: 1, now: START };
  for (let used = 1; used <= 10; used += 1) {
    const taken = buckets.take("k", spec);
    assert.equal(taken.ok, true);
    assert.equal(taken.remaining, 10 - used);
  }
  const refused = buckets.take("k", spec);
  assert.equal(refused.ok, false);
  assert.equal(refused.remaining, 0);
  assert.equal(refused.retryAfterSeconds, 1);
  assert.equal(refused.resetSeconds, 10);
  assert.equal(buckets.take("k", { ...spec, now: START + 2 * SECOND }).remaining, 1, "two seconds refill two tokens, one is taken");
  const full = buckets.take("k", { ...spec, now: START + 3600 * SECOND, cost: 0 });
  assert.equal(full.remaining, 10, "refill is capped at capacity");
  assert.equal(full.resetSeconds, 0);
});

test("peek reads without taking, and a cost above capacity can never succeed", () => {
  const buckets = createTokenBucketMap();
  const spec = { capacity: 5, refillPerSec: 5 / 60, cost: 1, now: START };
  assert.equal(buckets.peek("k", spec).remaining, 5);
  assert.equal(buckets.peek("k", spec).remaining, 5);
  assert.equal(buckets.size, 0, "peek creates no entry");
  const huge = buckets.take("k", { ...spec, cost: 6 });
  assert.equal(huge.ok, false);
  assert.equal(huge.exceedsCapacity, true);
  assert.equal(huge.retryAfterSeconds, 0);
  assert.equal(buckets.take("k", spec).remaining, 4, "the oversized request took nothing");
});

test("adjust refunds, may go negative, and is capped at capacity", () => {
  const buckets = createTokenBucketMap();
  const spec = { capacity: 100, refillPerSec: 1, cost: 60, now: START };
  assert.equal(buckets.take("k", spec).remaining, 40);
  assert.equal(buckets.adjust("k", 25), 65);
  assert.equal(buckets.adjust("k", 1000), 100, "capped at capacity");
  assert.equal(buckets.adjust("k", -130), -30, "a debit may overdraw");
  const blocked = buckets.take("k", { ...spec, cost: 1 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.remaining, 0, "an overdrawn bucket reports 0 remaining");
  assert.equal(blocked.retryAfterSeconds, 31);
  assert.equal(buckets.adjust("missing", 5), null, "nothing to adjust");
});

test("entries are evicted least recently used", () => {
  const buckets = createTokenBucketMap({ maxEntries: 2 });
  const spec = { capacity: 3, refillPerSec: 0, cost: 1, now: START };
  buckets.take("a", spec);
  buckets.take("b", spec);
  buckets.take("a", spec); // a is now the most recent
  buckets.take("c", spec); // evicts b
  assert.equal(buckets.size, 2);
  assert.equal(buckets.take("b", spec).remaining, 2, "b came back full");
  assert.equal(buckets.take("a", spec).ok, true);
});

// ---- rpm ------------------------------------------------------------------

test("rpm: capacity is the limit, refill is rpm/60 per second, cost 1", () => {
  const clock = { ms: START };
  const limiter = createLimiter({ config: {}, now: () => clock.ms });
  const caller = keyCaller(fakeKey({ rpm: 30, tpm: null }));
  let entered;
  for (let index = 0; index < 30; index += 1) {
    entered = limiter.enter({ caller, identity: PUBLIC_IP, listener: "public" });
    assert.equal(entered.ok, true, `request ${index + 1}`);
  }
  assert.equal(entered.ticket.rpm.remaining, 0);
  const refused = limiter.enter({ caller, identity: PUBLIC_IP, listener: "public" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "rate_limit_exceeded");
  assert.equal(refused.status, 429);
  assert.equal(refused.retryAfterSeconds, 2, "30 rpm refills a token every 2 s");
  clock.ms += 2 * SECOND;
  const again = limiter.enter({ caller, identity: PUBLIC_IP, listener: "public" });
  assert.equal(again.ok, true);
  assert.equal(again.ticket.rpm.remaining, 0);
  clock.ms += 60 * SECOND;
  const back = limiter.enter({ caller, identity: PUBLIC_IP, listener: "public" });
  assert.equal(back.ticket.rpm.remaining, 29, "a full minute refills the bucket");
});

test("a null limit falls back to public.defaults on PUBLIC, and to the gateway rpm for owner and ADMIN callers", () => {
  const config = { public: { defaults: { rpm: 7, tpm: 5000 } }, admin: { gatewayRpm: 11 } };
  const limiter = createLimiter({ config, now: () => START });
  const friend = keyCaller(fakeKey({}));
  assert.equal(limiter.enter({ caller: friend, identity: PUBLIC_IP, listener: "public" }).ticket.rpm.limit, 7);
  const owner = keyCaller(fakeKey({}, { class: "owner", id: `k_${"b".repeat(20)}` }));
  assert.equal(limiter.enter({ caller: owner, identity: PUBLIC_IP, listener: "public" }).ticket.rpm.limit, 11);
  assert.equal(limiter.enter({ caller: friend, identity: PUBLIC_IP, listener: "admin" }).ticket.rpm.limit, 11);
  const keyless = limiter.enter({ caller: { ok: true, kind: "keyless" }, identity: { ip: "192.0.2.5" }, listener: "admin" });
  assert.equal(keyless.ticket.rpm.limit, 11, "keyless ADMIN callers use admin.gatewayRpm");
  const session = limiter.enter({ caller: { ok: true, kind: "console-session", sessionId: "s1" }, listener: "admin" });
  assert.equal(session.ticket.rpm.limit, 11, "console-session uses the same rpm, per session");
  assert.equal(createLimiter({ config, now: () => START, gatewayRpm: () => 3 }).enter({ caller: { ok: true, kind: "keyless" }, listener: "admin" }).ticket.rpm.limit, 3,
    "SERVICE_ENTRY_RATE_LIMIT_RPM (the gatewayRpm override) wins");
});

test("buckets are per subject: two keys and two sessions do not share rpm", () => {
  const limiter = createLimiter({ config: {}, now: () => START });
  const a = keyCaller(fakeKey({ rpm: 1 }, { id: `k_${"a".repeat(20)}` }));
  const b = keyCaller(fakeKey({ rpm: 1 }, { id: `k_${"b".repeat(20)}` }));
  assert.equal(limiter.enter({ caller: a, listener: "public" }).ok, true);
  assert.equal(limiter.enter({ caller: a, listener: "public" }).ok, false);
  assert.equal(limiter.enter({ caller: b, listener: "public" }).ok, true);
  assert.equal(limiter.enter({ caller: { kind: "console-session", sessionId: "s1" }, listener: "admin" }).ok, true);
  assert.equal(limiter.enter({ caller: { kind: "console-session", sessionId: "s2" }, listener: "admin" }).ok, true);
});

// ---- tpm ------------------------------------------------------------------

test("tpm: admission costs input plus reserved output, and usage refunds the difference", () => {
  const clock = { ms: START };
  const limiter = createLimiter({ config: {}, now: () => clock.ms });
  const caller = keyCaller(fakeKey({ rpm: 100, tpm: 6000, maxOutputTokens: 1000 }));
  const body = chatBody(400, { max_tokens: 500 });
  const input = core.estimateOpenAiRequestInputTokens(body);
  assert.ok(input > 100 && input < 200, `a 400-character prompt estimates ${input} tokens`);

  const first = limiter.enter({ caller, listener: "public" });
  const admitted = limiter.admitBody({ ticket: first.ticket, caller, body });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.reservation.cost, input + 500, "reservedOutput is the requested max");
  assert.equal(first.ticket.tpm.limit, 6000);
  assert.equal(first.ticket.tpm.remaining, 6000 - input - 500);

  // 40 tokens in, 60 out: 600 tokens of the reservation come back.
  assert.equal(limiter.settle(admitted.reservation, { inputTokens: 40, outputTokens: 60 }), true);
  assert.equal(limiter.settle(admitted.reservation, { inputTokens: 40, outputTokens: 60 }), false, "settling is idempotent");
  const second = limiter.enter({ caller, listener: "public" });
  const next = limiter.admitBody({ ticket: second.ticket, caller, body });
  assert.equal(next.ok, true);
  assert.equal(second.ticket.tpm.remaining, 6000 - 100 - (input + 500), "the refund left 100 tokens used");
});

test("tpm: reserved output is min(requested, cap) and falls back to the key cap, then 4096", () => {
  const body = chatBody(40);
  const input = core.estimateOpenAiRequestInputTokens(body);
  assert.equal(estimateAdmission({ ...body, max_tokens: 300 }, { cap: 1000 }).reservedOutput, 300);
  assert.equal(estimateAdmission({ ...body, max_tokens: 5000 }, { cap: 1000 }).reservedOutput, 1000, "never above the cap");
  assert.equal(estimateAdmission({ ...body, max_completion_tokens: 200, max_tokens: 900 }, { cap: 1000 }).reservedOutput, 200);
  assert.equal(estimateAdmission(body, { cap: 1000 }).reservedOutput, 1000, "absent: the key cap");
  assert.equal(estimateAdmission(body, { cap: null }).reservedOutput, 4096, "no cap at all: 4096");
  assert.equal(estimateAdmission({ ...body, max_tokens: 9000 }, { cap: null }).reservedOutput, 9000);
  assert.equal(estimateAdmission(body, { cap: 1000, outputless: true }).cost, input, "embeddings reserve no output");
});

test("tpm: a request that can never fit is 400 request_exceeds_tpm and takes nothing", () => {
  const limiter = createLimiter({ config: {}, now: () => START });
  const caller = keyCaller(fakeKey({ rpm: 100, tpm: 1000, maxOutputTokens: 200 }));
  const ticket = limiter.enter({ caller, listener: "public" }).ticket;
  const refused = limiter.admitBody({ ticket, caller, body: chatBody(8000) });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 400);
  assert.equal(refused.code, "request_exceeds_tpm");
  assert.equal(ticket.tpm.remaining, 1000, "the bucket is untouched");
  assert.equal(lookupPublicError("request_exceeds_tpm").status, 400);
  const fits = limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body: chatBody(40) });
  assert.equal(fits.ok, true);
});

test("tpm: an empty bucket is 429 tokens_rate_limit_exceeded with the refill time, and refill admits again", () => {
  const clock = { ms: START };
  const limiter = createLimiter({ config: {}, now: () => clock.ms });
  const caller = keyCaller(fakeKey({ rpm: 100, tpm: 6000, maxOutputTokens: 3000 }));
  const body = chatBody(400, { max_tokens: 2800 });
  const cost = estimateAdmission(body, { cap: 3000 }).cost;
  assert.ok(cost > 2900 && cost < 3100, `cost ${cost}`);
  assert.equal(limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body }).ok, true);
  assert.equal(limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body }).ok, true);
  const refused = limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.code, "tokens_rate_limit_exceeded");
  // 6000 tokens per minute refill 100 per second.
  assert.ok(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 40, `retry-after ${refused.retryAfterSeconds}`);
  clock.ms += refused.retryAfterSeconds * SECOND;
  assert.equal(limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body }).ok, true);
});

test("tpm: an overrun is debited, so the next request waits for the refill", () => {
  const clock = { ms: START };
  const limiter = createLimiter({ config: {}, now: () => clock.ms });
  const caller = keyCaller(fakeKey({ rpm: 100, tpm: 1000, maxOutputTokens: 100 }));
  const body = chatBody(40, { max_tokens: 50 });
  const admitted = limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body });
  assert.equal(admitted.ok, true);
  limiter.settle(admitted.reservation, { inputTokens: 100, outputTokens: 1500 });
  const next = limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body });
  assert.equal(next.ok, false);
  assert.equal(next.code, "tokens_rate_limit_exceeded");
  clock.ms += 60 * SECOND;
  assert.equal(limiter.admitBody({ ticket: limiter.enter({ caller, listener: "public" }).ticket, caller, body }).ok, true);
});

test("tpm: a failed request gives its whole reservation back", () => {
  const limiter = createLimiter({ config: {}, now: () => START });
  const caller = keyCaller(fakeKey({ rpm: 100, tpm: 6000, maxOutputTokens: 1000 }));
  const body = chatBody(400, { max_tokens: 500 });
  const first = limiter.enter({ caller, listener: "public" });
  const admitted = limiter.admitBody({ ticket: first.ticket, caller, body });
  limiter.settle(admitted.reservation, { inputTokens: 0, outputTokens: 0 });
  const second = limiter.enter({ caller, listener: "public" });
  limiter.admitBody({ ticket: second.ticket, caller, body });
  assert.equal(second.ticket.tpm.remaining, 6000 - admitted.reservation.cost, "back to full before the second request");
});

test("PUBLIC keys without their own tpm use public.defaults.tpm; owner keys and ADMIN callers have none", () => {
  const config = { public: { defaults: { rpm: 60, tpm: 2000, maxOutputTokens: 100 } } };
  const limiter = createLimiter({ config, now: () => START });
  const body = chatBody(40);
  const friend = keyCaller(fakeKey({}));
  const ticket = limiter.enter({ caller: friend, listener: "public" }).ticket;
  assert.equal(limiter.admitBody({ ticket, caller: friend, body }).ok, true);
  assert.equal(ticket.tpm.limit, 2000);
  const owner = keyCaller(fakeKey({}, { class: "owner", id: `k_${"c".repeat(20)}` }));
  const ownerTicket = limiter.enter({ caller: owner, listener: "public" }).ticket;
  const free = limiter.admitBody({ ticket: ownerTicket, caller: owner, body: chatBody(40000) });
  assert.equal(free.ok, true);
  assert.equal(free.reservation, null, "no tpm and no cap: nothing is reserved");
  assert.equal(ownerTicket.tpm, null);
  const adminTicket = limiter.enter({ caller: friend, listener: "admin" }).ticket;
  assert.equal(limiter.admitBody({ ticket: adminTicket, caller: friend, body: chatBody(40000) }).reservation, null);
});

// ---- quotas ---------------------------------------------------------------

function quotaFixture(t, clock, limits, config = {}) {
  const { store } = makeStore(t, clock, { tzOffsetMinutes: 0 });
  const created = store.createKey({
    name: "Quota key", class: "friend", scopes: ["chat"], models: ["*"], listeners: ["public"], limits: { rpm: 1000, ...limits },
  }, { actor: "test" }).key;
  const limiter = createLimiter({ store, config, now: () => clock.ms, logger: silentLogger() });
  const caller = keyCaller(created);
  const attempt = (body = chatBody(40, { max_tokens: 10 })) => {
    const ticket = limiter.enter({ caller, listener: "public" }).ticket;
    const result = limiter.admitBody({ ticket, caller, body });
    if (result.ok) limiter.settle(result.reservation, { inputTokens: 0, outputTokens: 0 });
    return { result, ticket };
  };
  const addUsage = (at, amounts) => {
    store.addUsage(created.id, { at: new Date(at), ...amounts });
    limiter.invalidateUsage(created.id);
  };
  return { store, key: created, limiter, caller, attempt, addUsage };
}

test("daily_tokens resets at midnight in the quota tz offset", (t) => {
  const clock = { ms: Date.parse("2026-10-14T15:30:00.000Z") }; // 23:30 at UTC+8
  const { attempt, addUsage } = quotaFixture(t, clock, { dailyTokens: 100 }, { public: { quotaTzOffsetMinutes: 480 } });
  addUsage(clock.ms, { requests: 1, inputTokens: 60, outputTokens: 30 });
  const open = attempt();
  assert.equal(open.result.ok, true, "90 of 100 tokens used");
  assert.equal(open.ticket.quota.dayTokens, 10);
  addUsage(clock.ms, { requests: 1, inputTokens: 5, outputTokens: 5 });
  const full = attempt();
  assert.equal(full.result.ok, false);
  assert.equal(full.result.status, 429);
  assert.equal(full.result.code, "insufficient_quota");
  assert.equal(full.result.param, "daily_tokens");
  assert.equal(full.result.retryAfterSeconds, 30 * 60, "the local day ends at 16:00Z");
  clock.ms = Date.parse("2026-10-14T15:59:59.000Z");
  assert.equal(attempt().result.ok, false, "still the same local day");
  clock.ms = Date.parse("2026-10-14T16:00:01.000Z");
  const fresh = attempt();
  assert.equal(fresh.result.ok, true, "a new local day starts with empty counters");
  assert.equal(fresh.ticket.quota.dayTokens, 100);
});

test("the same instant belongs to another day when the quota tz differs", (t) => {
  const clock = { ms: Date.parse("2026-10-14T20:00:00.000Z") };
  // UTC: Oct 14. At UTC+8 it is already Oct 15 04:00.
  const utc = quotaFixture(t, clock, { dailyTokens: 50 });
  utc.addUsage(Date.parse("2026-10-14T01:00:00.000Z"), { inputTokens: 50 });
  assert.equal(utc.attempt().result.ok, false, "the Oct 14 usage counts toward Oct 14 at UTC");
  const east = quotaFixture(t, clock, { dailyTokens: 50 }, { public: { quotaTzOffsetMinutes: 480 } });
  east.addUsage(Date.parse("2026-10-14T01:00:00.000Z"), { inputTokens: 50 });
  east.limiter.invalidateUsage();
  assert.equal(east.attempt().result.ok, true, "at UTC+8 that usage is yesterday's");
});

test("monthly_tokens resets at the start of the month in the quota tz offset", (t) => {
  const clock = { ms: Date.parse("2026-10-31T15:00:00.000Z") }; // Oct 31 23:00 at UTC+8
  const { attempt, addUsage } = quotaFixture(t, clock, { monthlyTokens: 1000 }, { public: { quotaTzOffsetMinutes: 480 } });
  addUsage(clock.ms, { requests: 1, inputTokens: 900, outputTokens: 100 });
  const full = attempt();
  assert.equal(full.result.ok, false);
  assert.equal(full.result.code, "insufficient_quota");
  assert.equal(full.result.param, "monthly_tokens");
  assert.equal(full.result.retryAfterSeconds, 3600, "the local month ends at 16:00Z");
  clock.ms = Date.parse("2026-10-31T16:00:00.000Z");
  const november = attempt();
  assert.equal(november.result.ok, true);
  assert.equal(november.ticket.quota.monthTokens, 1000);
});

test("daily_requests is a cap too, with its own param", (t) => {
  const clock = { ms: Date.parse("2026-10-14T10:00:00.000Z") };
  const { attempt, addUsage } = quotaFixture(t, clock, { dailyRequests: 3 });
  addUsage(clock.ms, { requests: 3 });
  const full = attempt();
  assert.equal(full.result.code, "insufficient_quota");
  assert.equal(full.result.param, "daily_requests");
  assert.equal(full.result.retryAfterSeconds, 14 * 3600);
});

test("a refused quota hands the tpm reservation back, and in-flight reservations count against the cap", (t) => {
  const clock = { ms: Date.parse("2026-10-14T10:00:00.000Z") };
  const { limiter, caller } = quotaFixture(t, clock, { dailyTokens: 100, tpm: 100000, maxOutputTokens: 80 });
  const body = chatBody(40, { max_tokens: 80 });
  const first = limiter.enter({ caller, listener: "public" }).ticket;
  const running = limiter.admitBody({ ticket: first, caller, body });
  assert.equal(running.ok, true, "nothing used yet");
  // The first request holds its whole reservation (about 90 tokens); a second
  // one sees little headroom left.
  const second = limiter.enter({ caller, listener: "public" }).ticket;
  const spare = limiter.admitBody({ ticket: second, caller, body });
  assert.equal(spare.ok, true, "headroom is positive, so it is still admitted");
  const third = limiter.enter({ caller, listener: "public" }).ticket;
  const refused = limiter.admitBody({ ticket: third, caller, body });
  assert.equal(refused.ok, false, "two reservations exhaust the cap");
  assert.equal(refused.code, "insufficient_quota");
  assert.equal(third.tpm.remaining, 100000 - 2 * running.reservation.cost, "the refused request's tokens were returned");
  limiter.settle(running.reservation, { inputTokens: 0, outputTokens: 0 });
  limiter.settle(spare.reservation, { inputTokens: 0, outputTokens: 0 });
  const fourth = limiter.enter({ caller, listener: "public" }).ticket;
  assert.equal(limiter.admitBody({ ticket: fourth, caller, body }).ok, true, "settling released the holds");
});

test("usage counters are cached for 2 s", (t) => {
  const clock = { ms: Date.parse("2026-10-14T10:00:00.000Z") };
  const { store, key, attempt } = quotaFixture(t, clock, { dailyTokens: 100 });
  assert.equal(attempt().result.ok, true);
  store.addUsage(key.id, { at: new Date(clock.ms), inputTokens: 100 });
  assert.equal(attempt().result.ok, true, "the cached read is still in force");
  clock.ms += 1000;
  assert.equal(attempt().result.ok, true, "1 s later it still is");
  clock.ms += 2500;
  assert.equal(attempt().result.ok, false, "after 2 s the counters are read again");
});

// ---- 9.5 share gate -------------------------------------------------------

const SHARE = { public: { share: { maxConcurrent: 3, maxQueued: 2, queueTimeoutSeconds: 30, ownerActiveMaxConcurrent: 1 } } };

test("the share gate is a FIFO semaphore with a bounded queue", async () => {
  const gate = createShareGate({ config: SHARE });
  const a = await gate.acquire();
  const b = await gate.acquire();
  const c = await gate.acquire();
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, true]);
  const order = [];
  const d = gate.acquire().then((slot) => { order.push("d"); return slot; });
  const e = gate.acquire().then((slot) => { order.push("e"); return slot; });
  assert.deepEqual(await gate.acquire(), { ok: false, reason: "queue_full" }, "maxQueued is 2");
  assert.equal(gate.snapshot().queued, 2);
  a.release();
  a.release(); // releasing twice frees one slot
  const slotD = await d;
  assert.equal(slotD.ok, true);
  assert.deepEqual(order, ["d"], "first in, first out");
  b.release();
  assert.equal((await e).ok, true);
  assert.deepEqual(order, ["d", "e"]);
  assert.equal(gate.snapshot().active, 3);
});

test("while owner traffic is in flight the gate drops to ownerActiveMaxConcurrent", async () => {
  const gate = createShareGate({ config: SHARE });
  assert.equal(gate.snapshot().effectiveConcurrency, 3);
  const endOwner = gate.ownerBegin();
  assert.equal(gate.snapshot().effectiveConcurrency, 1);
  const first = await gate.acquire();
  assert.equal(first.ok, true, "one public request still runs next to the owner");
  let second = null;
  const waiting = gate.acquire().then((slot) => { second = slot; return slot; });
  await Promise.resolve();
  assert.equal(second, null, "the second waits while the owner is active");
  assert.equal(gate.snapshot().queued, 1);
  endOwner();
  endOwner(); // idempotent
  assert.equal((await waiting).ok, true, "the owner finished, so the cap is back to 3 and the queue moves");
  assert.equal(gate.snapshot().effectiveConcurrency, 3);
  first.release();
});

test("a lowered cap never evicts running requests; the queue drains as they finish", async () => {
  const gate = createShareGate({ config: SHARE });
  const slots = [await gate.acquire(), await gate.acquire(), await gate.acquire()];
  const endOwner = gate.ownerBegin();
  let granted = false;
  const waiting = gate.acquire().then((slot) => { granted = true; return slot; });
  slots[0].release();
  slots[1].release();
  await Promise.resolve();
  assert.equal(granted, false, "one is still running and the cap is 1");
  slots[2].release();
  assert.equal((await waiting).ok, true);
  endOwner();
});

test("with ownerActiveMaxConcurrent 0 the public waits entirely while the owner works", async () => {
  const gate = createShareGate({ config: { public: { share: { ...SHARE.public.share, ownerActiveMaxConcurrent: 0 } } } });
  const endOwner = gate.ownerBegin();
  let granted = false;
  const waiting = gate.acquire().then((slot) => { granted = true; return slot; });
  await Promise.resolve();
  assert.equal(granted, false);
  endOwner();
  assert.equal((await waiting).ok, true);
});

test("a queued request times out and an aborted one leaves the queue", async () => {
  const timers = [];
  const gate = createShareGate({
    config: SHARE,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
  });
  await gate.acquire();
  await gate.acquire();
  await gate.acquire();
  const timedOut = gate.acquire();
  assert.equal(timers.at(-1).ms, 30_000, "queueTimeoutSeconds");
  timers.at(-1).fn();
  assert.deepEqual(await timedOut, { ok: false, reason: "timeout" });
  assert.equal(gate.snapshot().queued, 0);

  const controller = new AbortController();
  const aborted = gate.acquire({ signal: controller.signal });
  assert.equal(gate.snapshot().queued, 1);
  controller.abort();
  assert.deepEqual(await aborted, { ok: false, reason: "aborted" });
  assert.equal(timers.at(-1).cleared, true, "the timer is cleared");
  assert.equal(gate.snapshot().queued, 0);
  assert.deepEqual(await gate.acquire({ signal: controller.signal }), { ok: false, reason: "aborted" }, "an already-aborted signal does not queue");
});

test("settings are read live", async () => {
  const live = { public: { share: { ...SHARE.public.share } } };
  const gate = createShareGate({ config: () => live });
  const slots = [await gate.acquire(), await gate.acquire(), await gate.acquire()];
  live.public.share.maxConcurrent = 4;
  assert.equal((await gate.acquire()).ok, true, "a raised cap applies at once");
  assert.equal(gate.snapshot().maxConcurrent, 4);
  slots.forEach((slot) => slot.release());
});

// ---- 9.2 / 9.3 pre-auth and bans ------------------------------------------

test("the pre-auth bucket is per IP, with the burst as capacity and rpm as refill", () => {
  const clock = { ms: START };
  const limiter = createLimiter({ config: { public: { preAuth: { rpm: 60, burst: 3 } } }, now: () => clock.ms });
  for (let index = 0; index < 3; index += 1) assert.equal(limiter.preAuth(PUBLIC_IP).ok, true);
  const refused = limiter.preAuth(PUBLIC_IP);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "ip_rate_limited");
  assert.equal(refused.status, 429);
  assert.equal(refused.retryAfterSeconds, 1);
  assert.equal(limiter.preAuth({ ip: "203.0.113.10", socketIp: "203.0.113.10", missingHeader: false }).ok, true, "another IP has its own bucket");
  clock.ms += SECOND;
  assert.equal(limiter.preAuth(PUBLIC_IP).ok, true);
});

test("a request without the client-IP header from a trusted socket uses proxy:<socketIp>", () => {
  const limiter = createLimiter({ config: { public: { preAuth: { rpm: 60, burst: 2 } } }, now: () => START });
  const direct = { ip: "127.0.0.1", socketIp: "127.0.0.1", missingHeader: true };
  assert.equal(limiter.preAuth(direct).ok, true);
  assert.equal(limiter.preAuth(direct).ok, true);
  assert.equal(limiter.preAuth(direct).ok, false);
  assert.equal(limiter.preAuth({ ip: "127.0.0.1", socketIp: "127.0.0.1", missingHeader: false }).ok, true,
    "a request that does carry the header is judged as its client IP, not as the proxy");
});

function banFixture(t, clock, overrides = {}) {
  const { store, open, file } = makeStore(t, clock);
  const config = {
    public: { authFailure: { limit: 3, windowSeconds: 60, banSeconds: 100, maxBanSeconds: 1000, ...overrides } },
    trustedCidrs: parseCidrList(["127.0.0.1/32", "::1/128", "10.9.0.0/16"]).cidrs,
  };
  const bans = [];
  const guard = createPersistentBanGuard({ store, config, now: () => clock.ms, onBan: (ban) => bans.push(ban), logger: silentLogger() });
  return { store, open, file, config, guard, bans };
}

function fail(guard, ip, times, clock) {
  let last;
  for (let index = 0; index < times; index += 1) last = guard.record(ip, clock.ms);
  return last;
}

test("failures inside the window reach the limit and ban the address; they expire out of the window", (t) => {
  const clock = { ms: START };
  const { guard, bans } = banFixture(t, clock);
  const ip = "203.0.113.9";
  assert.equal(guard.record(ip, clock.ms).remaining, 2);
  clock.ms += 61 * SECOND;
  assert.equal(guard.record(ip, clock.ms).failures, 1, "the first failure left the 60 s window");
  assert.equal(guard.record(ip, clock.ms).banned, false);
  const banned = guard.record(ip, clock.ms);
  assert.equal(banned.banned, true);
  assert.equal(banned.retryAfterSeconds, 100);
  assert.equal(bans.length, 1);
  assert.equal(bans[0].ipMasked, "203.0.113.x");
  assert.equal(bans[0].failures, 3);
  assert.equal(guard.check(ip, clock.ms).banned, true);
  clock.ms += 40 * SECOND;
  assert.equal(guard.check(ip, clock.ms).retryAfterSeconds, 60);
  clock.ms += 61 * SECOND;
  assert.equal(guard.check(ip, clock.ms).banned, false, "the ban ended");
});

test("a repeat ban lasts banSeconds x 4^(strikes-1), capped at maxBanSeconds, and strikes decay after 24 h", (t) => {
  const clock = { ms: START };
  const { guard } = banFixture(t, clock);
  const ip = "203.0.113.9";
  const lengths = [];
  for (let round = 0; round < 4; round += 1) {
    lengths.push(fail(guard, ip, 3, clock).retryAfterSeconds);
    clock.ms += (lengths.at(-1) + 1) * SECOND;
  }
  assert.deepEqual(lengths, [100, 400, 1000, 1000], "100, 400, then the 1000 s cap");
  clock.ms += 25 * HOUR;
  assert.equal(fail(guard, ip, 3, clock).retryAfterSeconds, 100, "24 h without a failure resets the strikes");
});

test("bans persist across a store reopen, and escalation continues from the stored strikes", (t) => {
  const clock = { ms: START };
  const { store, open, config, guard } = banFixture(t, clock);
  const ip = "198.51.100.23";
  assert.equal(fail(guard, ip, 3, clock).retryAfterSeconds, 100);
  store.close();

  const reopened = open();
  const bans = [];
  const restarted = createPersistentBanGuard({ store: reopened, config, now: () => clock.ms, onBan: (ban) => bans.push(ban), logger: silentLogger() });
  const still = restarted.check(ip, clock.ms);
  assert.equal(still.banned, true, "the ban survived the restart");
  assert.equal(still.retryAfterSeconds, 100);
  assert.equal(restarted.describe(clock.ms).bannedCount, 1);
  clock.ms += 101 * SECOND;
  assert.equal(restarted.check(ip, clock.ms).banned, false);
  const second = fail(restarted, ip, 3, clock);
  assert.equal(second.retryAfterSeconds, 400, "the second strike was read back from the store");
  assert.equal(second.strikes, 2);
  assert.equal(bans[0].strikes, 2);
  assert.equal(reopened.listBans({ now: new Date(clock.ms) })[0].strikes, 2);
});

test("a store that is opened lazily is loaded on first use", (t) => {
  const clock = { ms: START };
  const { store, config } = banFixture(t, clock);
  store.escalateBan("198.51.100.77", { at: new Date(clock.ms), banSeconds: 300 });
  let opened = 0;
  const guard = createPersistentBanGuard({ store: () => { opened += 1; return store; }, config, now: () => clock.ms, logger: silentLogger() });
  assert.equal(opened, 0);
  assert.equal(guard.check("198.51.100.77", clock.ms).banned, true);
  assert.equal(opened, 1);
});

test("loopback and the trusted proxies' own addresses are never banned", (t) => {
  const clock = { ms: START };
  const { guard, store } = banFixture(t, clock);
  for (const ip of ["127.0.0.1", "::1", "127.8.9.10", "10.9.1.2", "::ffff:127.0.0.1"]) {
    const result = fail(guard, ip, 10, clock);
    assert.equal(result.banned, false, ip);
    assert.equal(result.protected, true, ip);
    assert.equal(guard.check(ip, clock.ms).banned, false, ip);
  }
  assert.equal(store.listBans({ now: new Date(clock.ms) }).length, 0);

  const limiter = createLimiter({ store, config: banFixture(t, clock).config, now: () => clock.ms, logger: silentLogger() });
  const proxySocket = { ip: "10.9.0.5", socketIp: "10.9.0.5", missingHeader: true };
  for (let index = 0; index < 10; index += 1) limiter.noteAuthResult(proxySocket, { ok: false, status: 401 });
  assert.equal(limiter.checkBan(proxySocket), null);
  assert.equal(limiter.checkBan({ ip: "10.9.0.5", socketIp: "10.9.0.5", missingHeader: false }), null, "the proxy's address is protected even when named as a client");
});

test("the limiter bans a client behind a trusted proxy by its real address, not the proxy's", (t) => {
  const clock = { ms: START };
  const { store, config } = banFixture(t, clock);
  const limiter = createLimiter({ store, config, now: () => clock.ms, logger: silentLogger() });
  const behindProxy = { ip: "203.0.113.50", socketIp: "10.9.0.5", viaProxy: true, missingHeader: false };
  for (let index = 0; index < 3; index += 1) limiter.noteAuthResult(behindProxy, { ok: false, status: 401 });
  const refused = limiter.checkBan(behindProxy);
  assert.equal(refused.code, "auth_banned");
  assert.equal(refused.status, 429);
  assert.equal(refused.retryAfterSeconds, 100);
  assert.equal(limiter.checkBan({ ip: "203.0.113.51", socketIp: "10.9.0.5", viaProxy: true, missingHeader: false }), null);
  // Only 401s count; a success clears the window.
  const other = { ip: "203.0.113.60", socketIp: "10.9.0.5", viaProxy: true, missingHeader: false };
  limiter.noteAuthResult(other, { ok: false, status: 401 });
  limiter.noteAuthResult(other, { ok: false, status: 401 });
  limiter.noteAuthResult(other, { ok: true });
  limiter.noteAuthResult(other, { ok: false, status: 401 });
  limiter.noteAuthResult(other, { ok: false, status: 403 });
  assert.equal(limiter.checkBan(other), null);
});

test("admin bans of IPs, CIDRs and keys apply after a refresh and lift when removed", (t) => {
  const clock = { ms: START };
  const { store, config } = banFixture(t, clock);
  const limiter = createLimiter({ store, config, now: () => clock.ms, logger: silentLogger() });
  const at = { ip: "198.51.100.200", socketIp: "198.51.100.200", missingHeader: false };
  assert.equal(limiter.checkBan(at), null);
  store.upsertBan({ subject: "198.51.100.0/24", kind: "cidr", reason: "scanner" }, { actor: "test" });
  store.upsertBan({ subject: `k_${"z".repeat(20)}`, kind: "key", reason: "leaked", expiresAt: new Date(clock.ms + HOUR).toISOString() }, { actor: "test" });
  limiter.bans.refresh();
  assert.equal(limiter.checkBan(at).code, "auth_banned");
  assert.equal(limiter.checkBan({ ip: "198.51.101.1", socketIp: "198.51.101.1" }), null, "outside the CIDR");
  assert.equal(limiter.checkKeyBan(`k_${"z".repeat(20)}`).code, "auth_banned");
  assert.equal(limiter.checkKeyBan(`k_${"y".repeat(20)}`), null);
  clock.ms += 2 * HOUR;
  assert.equal(limiter.checkKeyBan(`k_${"z".repeat(20)}`), null, "the key ban expired");
  store.removeBan("198.51.100.0/24", { actor: "test" });
  limiter.bans.refresh();
  assert.equal(limiter.checkBan(at), null);
});

test("an admin ban is never shortened by the automatic one", (t) => {
  const clock = { ms: START };
  const { store, guard } = banFixture(t, clock);
  store.upsertBan({ subject: "203.0.113.9", kind: "ip", reason: "abuse", expiresAt: new Date(clock.ms + 10 * HOUR).toISOString() }, { actor: "test" });
  guard.refresh();
  assert.equal(guard.check("203.0.113.9", clock.ms).retryAfterSeconds, 10 * 3600);
  fail(guard, "203.0.113.9", 3, clock);
  assert.equal(guard.check("203.0.113.9", clock.ms).retryAfterSeconds, 10 * 3600);
});

test("without a usable store a ban still holds in this process", () => {
  const clock = { ms: START };
  const guard = createPersistentBanGuard({
    store: () => { throw new Error("store down"); },
    config: { public: { authFailure: { limit: 2, windowSeconds: 60, banSeconds: 50, maxBanSeconds: 500 } } },
    now: () => clock.ms,
    logger: silentLogger(),
  });
  assert.equal(guard.record("203.0.113.9", clock.ms).banned, false);
  assert.equal(guard.record("203.0.113.9", clock.ms).banned, true);
  assert.equal(guard.check("203.0.113.9", clock.ms).retryAfterSeconds, 50);
});

test("describe reports the figures /api/security shows", (t) => {
  const clock = { ms: START };
  const { guard } = banFixture(t, clock);
  fail(guard, "203.0.113.9", 3, clock);
  guard.check("203.0.113.9", clock.ms);
  const summary = guard.describe(clock.ms);
  assert.equal(summary.enabled, true);
  assert.equal(summary.maxFailures, 3);
  assert.equal(summary.banSeconds, 100);
  assert.equal(summary.bannedCount, 1);
  assert.equal(summary.banned[0].client, "203.0.113.x");
  assert.equal(summary.bansIssued, 1);
  assert.equal(summary.blockedRequests, 1);
});

// ---- 9.6 headers and codes ------------------------------------------------

test("the §9.6 headers", () => {
  const ticket = {
    rpm: { limit: 30, remaining: 28, resetSeconds: 4 },
    tpm: { limit: 100000, remaining: 93000, resetSeconds: 5 },
    quota: { dayTokens: 1849444, monthTokens: null },
  };
  assert.deepEqual(rateLimitHeaders(ticket, { now: START }), {
    "x-ratelimit-limit-requests": "30",
    "x-ratelimit-remaining-requests": "28",
    "x-ratelimit-reset-requests": "4s",
    "x-ratelimit-limit-tokens": "100000",
    "x-ratelimit-remaining-tokens": "93000",
    "x-ratelimit-reset-tokens": "5s",
    "x-quota-remaining-tokens-day": "1849444",
  });
  const both = rateLimitHeaders({ ...ticket, quota: { dayTokens: 10, monthTokens: 20 } }, { now: START });
  assert.equal(both["x-quota-remaining-tokens-month"], "20");
  assert.deepEqual(Object.keys(rateLimitHeaders({ rpm: ticket.rpm }, { now: START })).sort(), [
    "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
  ], "no tpm bucket and no cap: only the request headers");
  assert.equal(rateLimitHeaders({ rpm: { limit: 5, remaining: -2, resetSeconds: 0 } })["x-ratelimit-remaining-requests"], "0");
  assert.deepEqual(rateLimitHeaders(null), {});
});

test("Anthropic routes add anthropic-ratelimit-* with RFC 3339 reset times", () => {
  const ticket = { rpm: { limit: 30, remaining: 28, resetSeconds: 4 }, tpm: { limit: 100000, remaining: 93000, resetSeconds: 5 } };
  const headers = rateLimitHeaders(ticket, { protocol: "claude", now: START });
  assert.equal(headers["anthropic-ratelimit-requests-limit"], "30");
  assert.equal(headers["anthropic-ratelimit-requests-remaining"], "28");
  assert.equal(headers["anthropic-ratelimit-requests-reset"], new Date(START + 4000).toISOString());
  assert.equal(headers["anthropic-ratelimit-tokens-limit"], "100000");
  assert.equal(headers["anthropic-ratelimit-tokens-remaining"], "93000");
  assert.equal(headers["anthropic-ratelimit-tokens-reset"], new Date(START + 5000).toISOString());
  assert.equal(headers["x-ratelimit-limit-requests"], "30", "the OpenAI-style headers stay");
  assert.equal(Object.keys(rateLimitHeaders(ticket, { protocol: "openai", now: START })).some((name) => name.startsWith("anthropic-")), false);
});

test("a refused rpm request still reports its headers, and the headers follow the stages", () => {
  const limiter = createLimiter({ config: {}, now: () => START });
  const caller = keyCaller(fakeKey({ rpm: 1, tpm: 5000, maxOutputTokens: 100 }));
  const first = limiter.enter({ caller, listener: "public" });
  assert.equal(limiter.headers(first.ticket, { at: START })["x-ratelimit-remaining-requests"], "0");
  assert.equal(limiter.headers(first.ticket, { at: START })["x-ratelimit-limit-tokens"], undefined, "tpm is judged after the model is chosen");
  limiter.admitBody({ ticket: first.ticket, caller, body: chatBody(40) });
  assert.ok(limiter.headers(first.ticket, { at: START })["x-ratelimit-limit-tokens"]);
  const second = limiter.enter({ caller, listener: "public" });
  assert.equal(second.ok, false);
  const headers = limiter.headers(second.ticket, { at: START });
  assert.equal(headers["x-ratelimit-remaining-requests"], "0");
  assert.equal(headers["x-ratelimit-reset-requests"], "60s");
});

test("every refusal the limiter makes is a distinct taxonomy code with the §10.2 status", () => {
  const expected = {
    rate_limit_exceeded: 429,
    tokens_rate_limit_exceeded: 429,
    request_exceeds_tpm: 400,
    insufficient_quota: 429,
    ip_rate_limited: 429,
    auth_banned: 429,
    overloaded: 503,
  };
  for (const [code, status] of Object.entries(expected)) assert.equal(lookupPublicError(code)?.status, status, code);
  assert.equal(lookupPublicError("overloaded").anthropicStatus, 529);
  assert.equal(lookupPublicError("overloaded").retryAfterSeconds, 5);
  assert.equal(new Set(Object.keys(expected)).size, Object.keys(expected).length);
  // The limiter produces exactly these codes.
  const limiter = createLimiter({ config: { public: { preAuth: { rpm: 60, burst: 1 } } }, now: () => START });
  const caller = keyCaller(fakeKey({ rpm: 1, tpm: 1000, maxOutputTokens: 10 }));
  const produced = new Set();
  const ticket = limiter.enter({ caller, listener: "public" }).ticket;
  produced.add(limiter.enter({ caller, listener: "public" }).code);
  produced.add(limiter.admitBody({ ticket, caller, body: chatBody(40000) }).code);
  limiter.preAuth(PUBLIC_IP);
  produced.add(limiter.preAuth(PUBLIC_IP).code);
  assert.deepEqual([...produced].sort(), ["ip_rate_limited", "rate_limit_exceeded", "request_exceeds_tpm"]);
});

test("reset clears the buckets and holds", () => {
  const limiter = createLimiter({ config: {}, now: () => START });
  const caller = keyCaller(fakeKey({ rpm: 1 }));
  limiter.enter({ caller, listener: "public" });
  assert.equal(limiter.enter({ caller, listener: "public" }).ok, false);
  limiter.reset();
  assert.equal(limiter.enter({ caller, listener: "public" }).ok, true);
  assert.equal(limiter.describe().share.effectiveConcurrency, 4);
});
