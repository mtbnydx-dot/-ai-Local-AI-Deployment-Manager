// 07 §3.6 event stream client with a fake EventSource and a fake clock:
// named events, `?lastEventId=` on self-reopen, the switch to polling via
// /api/events/recent every 5 s, `gap:true` invalidating everything, per-key
// timers only when /recent fails too, SSE retry and the hidden-tab close.

import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, createEventStream, EVENT_TYPES, VIEWER_EVENT_TYPES } from "../../console/lib/events.js";
import { createQueryCache } from "../../console/lib/store.js";

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  fail({ closed = false } = {}) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.({});
  }

  emit(type, envelope, { named = true } = {}) {
    const event = { data: JSON.stringify(envelope), lastEventId: envelope.id || "" };
    if (named) for (const fn of this.listeners.get(type) || []) fn(event);
    else this.onmessage?.(event);
  }

  get query() {
    return new URL(this.url, "file:///").searchParams;
  }
}

function scheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    pending: () => timers.size,
  };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function envelope(id, type = "status", data = { reason: "x" }) {
  return { id, type, at: "2026-10-14T08:00:00.000Z", source: "entry", data };
}

function setup(options = {}) {
  FakeEventSource.instances = [];
  const clock = scheduler();
  const states = [];
  const recentCalls = [];
  let recentImpl = options.recent || (async () => ({ ok: true, events: [], lastId: null, gap: false }));
  const stream = createEventStream({
    EventSourceImpl: FakeEventSource,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onState: (state) => states.push(state),
    recent: (query) => {
      recentCalls.push(query);
      return recentImpl(query);
    },
    ...options.stream,
  });
  return {
    stream, clock, states, recentCalls,
    setRecent: (fn) => {
      recentImpl = fn;
    },
    last: () => FakeEventSource.instances[FakeEventSource.instances.length - 1],
  };
}

test("one stream with every type and the console client label; a viewer asks for status and instances", () => {
  const { stream, last } = setup();
  assert.equal(FakeEventSource.instances.length, 1);
  assert.deepEqual(last().query.get("types").split(","), [...EVENT_TYPES]);
  assert.equal(last().query.get("client"), "console");
  assert.equal(last().query.has("lastEventId"), false, "the first open has no id to resume from");
  stream.close();

  const viewer = setup({ stream: { types: VIEWER_EVENT_TYPES } });
  assert.equal(viewer.last().query.get("types"), "status,instances");
  viewer.stream.close();
});

test("named and unnamed events reach handlers; the last id is remembered", () => {
  const { stream, last } = setup();
  const seen = [];
  stream.on("jobs", (event) => seen.push(`jobs:${event.id}`));
  stream.on("*", (event) => seen.push(`*:${event.type}`));
  last().open();
  assert.equal(stream.state, "open");
  last().emit("jobs", envelope("b1-1", "jobs", { managerId: "vllm", jobs: [], removed: [] }));
  last().emit("status", { ...envelope("b1-2"), type: undefined }, { named: true });
  last().emit("message", envelope("b1-3", "library", {}), { named: false });
  assert.deepEqual(seen, ["jobs:b1-1", "*:jobs", "*:status", "*:library"]);
  assert.equal(stream.lastId, "b1-3");
  stream.close();
});

test("a self-opened stream passes ?lastEventId=", () => {
  const { stream, last } = setup();
  last().open();
  last().emit("status", envelope("k3f9a2-1042"));
  stream.reconnect();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(FakeEventSource.instances[0].closed, true);
  assert.equal(last().query.get("lastEventId"), "k3f9a2-1042");
  stream.close();
});

test("a refused stream switches to polling /recent every 5 s and applies events in order", async () => {
  const cache = createQueryCache();
  await cache.fetch(["status"], async () => ({}), { ttlMs: 60000 });
  await cache.fetch(["fleet"], async () => ({}), { ttlMs: 60000 });
  const answers = [
    { ok: true, events: [envelope("b1-5", "instances", { managerId: "vllm", changed: [], removed: [] }), envelope("b1-6")], lastId: "b1-6", gap: false },
    { ok: true, events: [], lastId: "b1-6", gap: false },
  ];
  const ctx = setup({ recent: async () => answers.shift() || { ok: true, events: [], lastId: "b1-6", gap: false } });
  const order = [];
  ctx.stream.on("*", (event) => {
    order.push(event.id);
    applyEvent(cache, event);
  });
  ctx.last().open();
  ctx.last().emit("status", envelope("b1-4"));
  ctx.last().fail({ closed: true });
  await flush();
  assert.equal(ctx.stream.state, "polling");
  assert.deepEqual(ctx.recentCalls[0], { since: "b1-4", types: EVENT_TYPES.join(",") });
  assert.deepEqual(order, ["b1-4", "b1-5", "b1-6"]);
  assert.equal(cache.get(["fleet"]).stale, true);
  assert.equal(ctx.stream.needsTimers(), false, "/recent works, so no per-key timers");
  await ctx.clock.advance(4999);
  assert.equal(ctx.recentCalls.length, 1);
  await ctx.clock.advance(1);
  assert.equal(ctx.recentCalls.length, 2);
  assert.equal(ctx.recentCalls[1].since, "b1-6");
  await ctx.clock.advance(10000);
  assert.equal(ctx.recentCalls.length, 4);
  ctx.stream.close();
});

test("more than 3 errors in 60 s switch to polling; fewer keep EventSource retrying", async () => {
  const ctx = setup();
  ctx.last().open();
  for (let index = 0; index < 3; index += 1) {
    ctx.last().fail();
    await ctx.clock.advance(1000);
  }
  assert.equal(ctx.stream.state, "connecting");
  assert.equal(ctx.recentCalls.length, 0);
  ctx.last().fail();
  await flush();
  assert.equal(ctx.stream.state, "polling");
  assert.equal(ctx.recentCalls.length, 1);

  const spaced = setup();
  spaced.last().open();
  for (let index = 0; index < 5; index += 1) {
    spaced.last().fail();
    await spaced.clock.advance(30000);
  }
  assert.notEqual(spaced.stream.state, "polling", "errors older than 60 s do not count");
  ctx.stream.close();
  spaced.stream.close();
});

test("gap:true from /recent invalidates every evented key", async () => {
  const cache = createQueryCache();
  for (const key of [["status"], ["fleet"], ["m", "vllm", "jobs"], ["session"]]) await cache.fetch(key, async () => ({}), { ttlMs: 60000 });
  const ctx = setup({ recent: async () => ({ ok: true, events: [], lastId: "new-1", gap: true }) });
  ctx.stream.on("*", (event) => applyEvent(cache, event));
  ctx.last().fail({ closed: true });
  await flush();
  for (const key of [["status"], ["fleet"], ["m", "vllm", "jobs"]]) assert.equal(cache.get(key).stale, true, JSON.stringify(key));
  assert.equal(cache.get(["session"]).stale, false);
  assert.equal(ctx.stream.lastId, "new-1");
  ctx.stream.close();
});

test("per-key timers run only while /recent fails too", async () => {
  const ctx = setup({ recent: async () => {
    throw new Error("down");
  } });
  ctx.last().fail({ closed: true });
  await flush();
  assert.equal(ctx.stream.state, "offline");
  assert.equal(ctx.stream.needsTimers(), true);
  ctx.setRecent(async () => ({ ok: true, events: [], lastId: null, gap: false }));
  await ctx.clock.advance(5000);
  assert.equal(ctx.stream.state, "polling");
  assert.equal(ctx.stream.needsTimers(), false);
  ctx.stream.close();
});

test("SSE is retried every 60 s with ?lastEventId= and polling stops once it opens", async () => {
  const ctx = setup({ recent: async () => ({ ok: true, events: [envelope("p-9")], lastId: "p-9", gap: false }) });
  ctx.last().fail({ closed: true });
  await flush();
  assert.equal(FakeEventSource.instances.length, 1);
  await ctx.clock.advance(60000);
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(ctx.last().query.get("lastEventId"), "p-9");
  assert.equal(ctx.stream.state, "polling", "still polling until the new stream opens");
  ctx.last().fail({ closed: true });
  await ctx.clock.advance(60000);
  assert.equal(FakeEventSource.instances.length, 3, "a refused retry is retried again after 60 s");
  ctx.last().open();
  assert.equal(ctx.stream.state, "open");
  const calls = ctx.recentCalls.length;
  await ctx.clock.advance(30000);
  assert.equal(ctx.recentCalls.length, calls, "no /recent polling while SSE is open");
  assert.deepEqual(ctx.states.filter((state, index, list) => state !== list[index - 1]), ["polling", "open"]);
  ctx.stream.close();
});

test("a tab hidden for more than 5 min closes the stream and reopens with ?lastEventId= when visible", async () => {
  let hidden = false;
  let notify = null;
  const visibility = { hidden: () => hidden, onChange: (fn) => {
    notify = fn;
    return () => {
      notify = null;
    };
  } };
  const ctx = setup({ stream: { visibility } });
  ctx.last().open();
  ctx.last().emit("status", envelope("v-1"));
  hidden = true;
  notify();
  await ctx.clock.advance(4 * 60000);
  assert.equal(ctx.last().closed, false);
  hidden = false;
  notify();
  await ctx.clock.advance(10 * 60000);
  assert.equal(ctx.last().closed, false, "a short hide keeps the stream");
  hidden = true;
  notify();
  await ctx.clock.advance(5 * 60000);
  assert.equal(ctx.last().closed, true);
  assert.equal(FakeEventSource.instances.length, 1);
  hidden = false;
  notify();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.equal(ctx.last().query.get("lastEventId"), "v-1");
  ctx.stream.close();
  assert.equal(notify, null, "close() unsubscribes from visibility");
  assert.equal(ctx.clock.pending(), 0, "close() clears every timer");
});

test("without EventSource the client polls from the start", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { value: undefined, configurable: true, writable: true });
  const ctx = setup({ stream: { EventSourceImpl: null } });
  if (saved) Object.defineProperty(globalThis, "EventSource", saved);
  else delete globalThis.EventSource;
  await flush();
  assert.equal(ctx.stream.state, "polling");
  assert.equal(ctx.recentCalls.length, 1);
  ctx.stream.close();
  assert.equal(ctx.stream.state, "offline");
});
