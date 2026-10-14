// 07 §3.5 query cache and §3.6 applyEvent: dedupe, TTL, prefix
// invalidation, subscribe and gc, and the cache effect of every event type.

import assert from "node:assert/strict";
import test from "node:test";

import { EVENTED_PREFIXES, applyEvent } from "../../console/lib/events.js";
import { createQueryCache, createSignal, stableKey } from "../../console/lib/store.js";

function clock(start = 1000) {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

function envelope(type, data, id = "boot01-1") {
  return { id, type, at: "2026-10-14T08:00:00.000Z", source: "entry", data };
}

test("stableKey sorts object keys at every depth and ignores undefined", () => {
  assert.equal(stableKey(["hub", "downloads", { b: 1, a: { d: 1, c: 2 } }]), stableKey(["hub", "downloads", { a: { c: 2, d: 1 }, b: 1, z: undefined }]));
  assert.notEqual(stableKey(["m", "vllm"]), stableKey(["m", "llama"]));
  assert.equal(stableKey("status"), stableKey(["status"]));
});

test("concurrent fetches of one key share one request", async () => {
  const cache = createQueryCache();
  let calls = 0;
  let release;
  const fn = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = cache.fetch(["fleet"], fn);
  const second = cache.fetch(["fleet"], fn);
  assert.equal(first, second);
  assert.equal(cache.get(["fleet"]).fetching, true);
  assert.equal(cache.get(["fleet"]).status, "loading");
  release({ instances: [] });
  assert.deepEqual(await first, { instances: [] });
  assert.equal(calls, 1);
  assert.equal(cache.get(["fleet"]).status, "success");
  assert.equal(cache.get(["fleet"]).fetching, false);
});

test("a fresh entry is served for its TTL; force and expiry refetch", async () => {
  const time = clock();
  const cache = createQueryCache({ now: time.now });
  let calls = 0;
  const fn = async () => ++calls;
  assert.equal(await cache.fetch(["status"], fn, { ttlMs: 10000 }), 1);
  time.advance(9999);
  assert.equal(await cache.fetch(["status"], fn, { ttlMs: 10000 }), 1);
  assert.equal(cache.get(["status"]).stale, false);
  assert.equal(await cache.fetch(["status"], fn, { ttlMs: 10000, force: true }), 2);
  time.advance(10000);
  assert.equal(cache.get(["status"]).stale, true);
  assert.equal(await cache.fetch(["status"], fn, { ttlMs: 10000 }), 3);
});

test("errors are stored, keep earlier data, and the next fetch retries", async () => {
  const cache = createQueryCache();
  await cache.fetch(["status"], async () => "old", { ttlMs: 0 });
  await assert.rejects(cache.fetch(["status"], async () => {
    throw new Error("down");
  }, { ttlMs: 0 }), /down/);
  const view = cache.get(["status"]);
  assert.equal(view.status, "error");
  assert.equal(view.data, "old");
  assert.equal(view.error.message, "down");
  assert.equal(await cache.fetch(["status"], async () => "new", { ttlMs: 0 }), "new");
  assert.equal(cache.get(["status"]).error, null);
});

test("invalidate takes a prefix, or one exact key, and notifies subscribers", async () => {
  const cache = createQueryCache();
  for (const key of [["m", "vllm", "instances"], ["m", "vllm", "jobs"], ["m", "llama", "jobs"], ["platform"], ["platform", "op", "x"]]) {
    await cache.fetch(key, async () => 1, { ttlMs: 60000 });
  }
  const seen = [];
  const off = cache.subscribe(["m", "vllm", "jobs"], (view) => seen.push(view.invalidated));
  assert.equal(cache.invalidate(["m", "vllm"]), 2);
  assert.equal(cache.get(["m", "vllm", "instances"]).stale, true);
  assert.equal(cache.get(["m", "llama", "jobs"]).stale, false);
  assert.deepEqual(seen, [true]);
  off();
  assert.equal(cache.invalidate(["platform"], { exact: true }), 1);
  assert.equal(cache.get(["platform", "op", "x"]).stale, false);
  await cache.fetch(["m", "vllm", "jobs"], async () => 2, { ttlMs: 60000 });
  assert.equal(seen.length, 1, "an unsubscribed listener hears nothing");
  assert.equal(cache.invalidate([]), 5, "the empty prefix covers every key");
});

test("an invalidation during a fetch survives that fetch", async () => {
  const cache = createQueryCache();
  let release;
  const pending = cache.fetch(["fleet"], () => new Promise((resolve) => {
    release = resolve;
  }), { ttlMs: 60000 });
  cache.invalidate(["fleet"]);
  release("data");
  await pending;
  assert.equal(cache.get(["fleet"]).invalidated, true);
});

test("set stores data or applies an updater; subscribers get the new view", () => {
  const cache = createQueryCache();
  const views = [];
  cache.subscribe(["telemetry", "live"], (view) => views.push(view.data));
  cache.set(["telemetry", "live"], { gpu: 1 });
  cache.set(["telemetry", "live"], (previous) => ({ ...previous, gpu: previous.gpu + 1 }));
  assert.deepEqual(views, [{ gpu: 1 }, { gpu: 2 }]);
  assert.equal(cache.get(["telemetry", "live"]).status, "success");
});

test("gc drops idle unwatched entries only", async () => {
  const time = clock();
  const cache = createQueryCache({ now: time.now });
  await cache.fetch(["a"], async () => 1);
  await cache.fetch(["b"], async () => 2);
  const off = cache.subscribe(["b"], () => {});
  time.advance(300001);
  assert.equal(cache.gc(), 1);
  assert.deepEqual(cache.keys(), [["b"]]);
  off();
  assert.equal(cache.gc(300000), 0, "unsubscribing touches the entry");
  time.advance(300001);
  assert.equal(cache.gc(300000), 1);
});

test("createSignal notifies on change only", () => {
  const role = createSignal("owner");
  const seen = [];
  const off = role.subscribe((value) => seen.push(value));
  role.set("owner");
  role.set("viewer");
  off();
  role.set("none");
  assert.deepEqual(seen, ["viewer"]);
  assert.equal(role.get(), "none");
});

async function primed() {
  const cache = createQueryCache();
  const keys = [
    ["status"], ["platform"], ["platform", "components"], ["fleet"], ["m", "vllm", "instances"], ["m", "llama", "instances"],
    ["hub", "library", {}], ["alerts", "firing"], ["security"], ["access", "keys"], ["session"],
  ];
  for (const key of keys) await cache.fetch(key, async () => ({}), { ttlMs: 60000 });
  await cache.fetch(["m", "vllm", "jobs"], async () => [{ id: "j1", status: "running" }, { id: "j2", status: "queued" }], { ttlMs: 60000 });
  await cache.fetch(["hub", "downloads", {}], async () => ({ jobs: [{ id: "dl_1", state: "queued" }], aggregate: { activeCount: 0 } }), { ttlMs: 60000 });
  await cache.fetch(["hub", "downloads", { state: "failed" }], async () => ({ jobs: [] }), { ttlMs: 60000 });
  return cache;
}

const stale = (cache, key) => cache.get(key).stale;

test("applyEvent: status, platform, instances", async () => {
  let cache = await primed();
  assert.equal(applyEvent(cache, envelope("status", { reason: "manager_down", managerId: "vllm" })), true);
  assert.equal(stale(cache, ["status"]), true);
  assert.equal(stale(cache, ["platform"]), true);
  assert.equal(stale(cache, ["fleet"]), false);

  cache = await primed();
  const status = { schemaVersion: 1, readiness: { overall: "ok", layers: [] } };
  applyEvent(cache, envelope("platform", { kind: "status", full: true, status }));
  assert.equal(cache.get(["platform"]).data, status);
  applyEvent(cache, envelope("platform", { kind: "component", id: "entry", state: "ready", prev: "starting" }));
  assert.equal(stale(cache, ["platform"]), true);
  assert.equal(stale(cache, ["platform", "components"]), true);
  applyEvent(cache, envelope("platform", { kind: "operation", opId: "op_1", opKind: "restart", state: "running", progress: 0.5, line: "x" }));
  assert.deepEqual(cache.get(["platform", "op", "op_1"]).data, { opId: "op_1", kind: "restart", state: "running", progress: 0.5, line: "x" });

  cache = await primed();
  applyEvent(cache, envelope("instances", { managerId: "vllm", changed: ["primary"], removed: [], native: false }));
  assert.equal(stale(cache, ["fleet"]), true);
  assert.equal(stale(cache, ["m", "vllm", "instances"]), true);
  assert.equal(stale(cache, ["m", "llama", "instances"]), false);
});

test("applyEvent: jobs deltas merge by id and drop removed without a refetch", async () => {
  const cache = await primed();
  applyEvent(cache, envelope("jobs", { managerId: "vllm", jobs: [{ id: "j2", status: "running" }, { id: "j3", status: "queued" }], removed: ["j1"] }));
  const view = cache.get(["m", "vllm", "jobs"]);
  assert.deepEqual(view.data, [{ id: "j3", status: "queued" }, { id: "j2", status: "running" }]);
  assert.equal(view.stale, false);
  applyEvent(cache, envelope("jobs", { managerId: "llama", jobs: [{ id: "x" }], removed: [] }));
  assert.equal(cache.get(["m", "llama", "jobs"]).data, undefined, "an unloaded list is not created from a delta");
  applyEvent(cache, envelope("jobs", { truncated: true, managerId: "vllm" }));
  assert.equal(stale(cache, ["m", "vllm", "jobs"]), true, "a truncated replay refetches");
});

test("applyEvent: downloads merge known jobs, refetch lists that lack one, truncated invalidates", async () => {
  let cache = await primed();
  applyEvent(cache, envelope("downloads", { kind: "job", jobs: [{ id: "dl_1", state: "downloading" }], aggregate: { activeCount: 1 } }));
  assert.deepEqual(cache.get(["hub", "downloads", {}]).data, { jobs: [{ id: "dl_1", state: "downloading" }], aggregate: { activeCount: 1 } });
  assert.equal(stale(cache, ["hub", "downloads", { state: "failed" }]), true, "a filtered list without the job refetches");
  cache = await primed();
  applyEvent(cache, envelope("downloads", { truncated: true }));
  assert.equal(stale(cache, ["hub", "downloads", {}]), true);
});

test("applyEvent: library, alerts, telemetry.live, security and access", async () => {
  const cache = await primed();
  applyEvent(cache, envelope("library", { kind: "changed", entryIds: ["lib_1"] }));
  assert.equal(stale(cache, ["hub", "library", {}]), true);
  applyEvent(cache, envelope("alerts", { ruleId: "r", scopeKey: "s", state: "firing" }));
  assert.equal(stale(cache, ["alerts", "firing"]), true);
  applyEvent(cache, envelope("telemetry.live", { gpu: [{ util: 0.61 }] }));
  assert.deepEqual(cache.get(["telemetry", "live"]).data, { gpu: [{ util: 0.61 }] });
  applyEvent(cache, envelope("security", { kind: "ban" }));
  assert.equal(stale(cache, ["security"]), true);
  assert.equal(stale(cache, ["access", "keys"]), false);
  applyEvent(cache, envelope("access", { kind: "key.revoked" }));
  assert.equal(stale(cache, ["access", "keys"]), true);
  assert.equal(stale(cache, ["session"]), false, "session is not evented");
});

test("applyEvent: resync invalidates every evented key once; unknown and malformed envelopes are ignored", async () => {
  const cache = await primed();
  assert.equal(applyEvent(cache, { type: "resync", data: { reason: "restart" } }), true);
  for (const key of cache.keys()) {
    const evented = EVENTED_PREFIXES.some((prefix) => prefix.every((part, index) => key[index] === part));
    assert.equal(stale(cache, key), evented, JSON.stringify(key));
  }
  const clean = await primed();
  assert.equal(applyEvent(clean, envelope("mystery", {})), false);
  assert.equal(applyEvent(clean, { type: "status" }), false, "an envelope without at/source/data is ignored");
  assert.equal(applyEvent(clean, envelope("notification", { kind: "x", severity: "info", title: { zh: "z", en: "e" } })), false);
  assert.equal(applyEvent(clean, null), false);
  assert.equal(clean.keys().some((key) => stale(clean, key)), false);
});
