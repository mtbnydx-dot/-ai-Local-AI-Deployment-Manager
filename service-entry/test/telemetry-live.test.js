"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");
const { createTelemetryRuntime } = require("../lib/telemetry-runtime");

// telemetry.live (04 section 12, TEL-19): published every 5 s through
// events.publish, and only while somebody listens. A fake clock drives the
// timers; the bus and the store are fakes.

function fakeClock() {
  const clock = { time: 1_000_000, timers: [], seq: 0 };
  clock.timers_api = {
    setTimeout(fn, delay) {
      clock.seq += 1;
      const timer = { id: clock.seq, at: clock.time + delay, fn, unref() {} };
      clock.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      clock.timers = clock.timers.filter((item) => item !== timer);
    },
  };
  clock.advance = async (ms) => {
    const target = clock.time + ms;
    for (;;) {
      const due = clock.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.timers = clock.timers.filter((timer) => timer !== due);
      clock.time = due.at;
      due.fn();
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    clock.time = target;
  };
  return clock;
}

function fakeBus() {
  const bus = { listeners: 0, published: [], counts: [] };
  bus.subscribe = () => () => {};
  bus.subscriberCount = (query) => {
    bus.counts.push(query);
    return bus.listeners;
  };
  bus.publish = (type, data) => {
    bus.published.push({ type, data });
    return { id: bus.published.length };
  };
  return bus;
}

function fakeStore(liveCalls) {
  return {
    state: "ready",
    async insertEvents(batch) {
      return { accepted: batch.length, duplicates: 0, rejected: 0, dropped: 0, errors: [] };
    },
    async getState() {
      return null;
    },
    async setState() {},
    async call(name, params) {
      liveCalls.push({ name, params });
      return { ok: true, at: new Date(params.now).toISOString(), windowSeconds: 60, calls: liveCalls.length };
    },
    async close() {},
  };
}

async function makeRuntime(t, clock, bus, liveCalls) {
  const runtime = createTelemetryRuntime({
    aiRoot: os.tmpdir(),
    dataDir: os.tmpdir(),
    managers: [],
    events: bus,
    env: {},
    docker: false,
    alerts: false,
    logger: null,
    openStore: async () => fakeStore(liveCalls),
    config: {},
    now: () => clock.time,
    timers: clock.timers_api,
  });
  t.after(() => runtime.stop({ flushMs: 0 }));
  await runtime.start();
  return runtime;
}

test("telemetry.live is published every 5 s only while a subscriber is listening", async (t) => {
  const clock = fakeClock();
  const bus = fakeBus();
  const liveCalls = [];
  await makeRuntime(t, clock, bus, liveCalls);

  await clock.advance(20_000);
  assert.equal(bus.published.length, 0, "nobody listens: nothing is built or published");
  assert.equal(liveCalls.length, 0);
  assert.ok(bus.counts.length >= 4);
  assert.deepEqual(bus.counts[0], { types: ["telemetry.live"] });

  bus.listeners = 1;
  await clock.advance(4_000);
  assert.equal(bus.published.length, 0, "not before the next 5 s tick");
  await clock.advance(1_000);
  assert.equal(bus.published.length, 1);
  assert.equal(bus.published[0].type, "telemetry.live");
  assert.equal(bus.published[0].data.ok, true);
  assert.equal(bus.published[0].data.at, new Date(clock.time).toISOString());
  assert.equal(liveCalls[0].name, "live");
  assert.equal(liveCalls[0].params.inflight, 0);
  assert.deepEqual(Object.keys(liveCalls[0].params.collectors).sort(), ["events", "gpu", "recorder", "runtime", "store"]);

  await clock.advance(10_000);
  assert.equal(bus.published.length, 3, "one envelope per 5 s");

  bus.listeners = 0;
  await clock.advance(30_000);
  assert.equal(bus.published.length, 3, "the last listener left: publishing stops");

  bus.listeners = 2;
  await clock.advance(5_000);
  assert.equal(bus.published.length, 4, "and resumes with the next listener");
});

test("stopping the runtime cancels the live timer", async (t) => {
  const clock = fakeClock();
  const bus = fakeBus();
  const runtime = await makeRuntime(t, clock, bus, []);
  bus.listeners = 1;
  await runtime.stop({ flushMs: 0 });
  await clock.advance(30_000);
  assert.equal(bus.published.length, 0);
});

test("a failing query is logged by the loop and does not stop later ticks", async (t) => {
  const clock = fakeClock();
  const bus = fakeBus();
  bus.listeners = 1;
  const liveCalls = [];
  const store = fakeStore(liveCalls);
  let fail = true;
  const original = store.call;
  store.call = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error("query_timeout");
    }
    return original(...args);
  };
  const runtime = createTelemetryRuntime({
    aiRoot: os.tmpdir(), dataDir: os.tmpdir(), managers: [], events: bus, env: {}, docker: false, alerts: false, logger: null,
    openStore: async () => store, config: {}, now: () => clock.time, timers: clock.timers_api,
  });
  t.after(() => runtime.stop({ flushMs: 0 }));
  await runtime.start();
  await clock.advance(10_000);
  assert.equal(bus.published.length, 1);
});
