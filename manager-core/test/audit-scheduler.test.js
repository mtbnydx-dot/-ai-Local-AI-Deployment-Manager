"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAuditScheduler, latestSlotAtOrBefore, nextSlotAfter, normalizeSchedule } = require("../telemetry/audit-scheduler");

// Built at run time so the file holds no key-shaped literal.
const FAKE_KEY = ["sk", "live", "abcdef0123456789abcdef0123456789"].join("-");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Local wall-clock times, as the scheduler reads them.
const at = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0).getTime();

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-scheduler-"));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

function createClock(start) {
  let current = start;
  return {
    now: () => current,
    set(value) { current = value; },
    advance(ms) { current += ms; },
  };
}

// The telemetry store as the scheduler uses it: state, events, audit rows.
function createFakeStore() {
  const saved = new Map();
  const store = {
    events: [],
    access: [],
    saved,
    async getState(name) {
      return saved.has(name) ? JSON.parse(saved.get(name)) : null;
    },
    async setState(name, value) {
      saved.set(name, JSON.stringify(value));
      return { ok: true };
    },
    async insertEvents(rows) {
      store.events.push(...rows);
      return { accepted: rows.length };
    },
    async appendAuditAccess(entry) {
      store.access.push(entry);
      return { seq: store.access.length, hash: "x" };
    },
    types() {
      return store.events.map((event) => event.type);
    },
  };
  return store;
}

function exportEntry(auditId, mode, createdMs, chatCount = 3) {
  return { auditId, mode, createdAt: new Date(createdMs).toISOString(), chatCount, messageCount: chatCount * 4, mdBytes: 100 };
}

// An audit store whose export is a script; each export it "writes" joins the list.
function createFakeAuditStore({ exports = [], clock, respond } = {}) {
  const list = exports.slice();
  const store = {
    calls: [],
    list,
    async listAuditExports() {
      return list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    async exportOpenWebuiAudit(reason, context) {
      store.calls.push({ reason, context, at: clock.now() });
      if (respond) return respond(store.calls.length, reason, context);
      const mode = context.full ? "full" : "incremental";
      const auditId = `exp-${store.calls.length}`;
      list.push(exportEntry(auditId, mode, clock.now()));
      return { ok: true, auditId, auditDir: `/audit/${auditId}`, mode, chatCount: 3, messageCount: 12, totalChatCount: 9, pruned: [] };
    },
  };
  return store;
}

function settings(overrides = {}) {
  return {
    schedule: { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00", ...(overrides.schedule || {}) },
    retention: { maxExports: 30, maxAgeDays: 90, rebaselineDays: 7, maxChains: 8, ...(overrides.retention || {}) },
    logQueryText: false,
  };
}

function setup({ start, exports, respond, overrides, containerStatus, index } = {}) {
  const clock = createClock(start ?? at(10, 14, 10, 0));
  const store = createFakeStore();
  const auditStore = createFakeAuditStore({ exports, clock, respond });
  const current = overrides || settings();
  const scheduler = createAuditScheduler({
    auditStore, store, index, config: () => current, now: clock.now, containerStatus,
    logger: { warn() {}, log() {} },
  });
  return { clock, store, auditStore, scheduler, current };
}

// Ticks once a minute for `minutes` of fake time.
async function runMinutes(clock, scheduler, minutes) {
  const outcomes = [];
  await scheduler.prime();
  for (let minute = 0; minute < minutes; minute += 1) {
    clock.advance(MINUTE_MS);
    const result = await scheduler.tick();
    if (result.ran) outcomes.push({ at: clock.now(), ...result });
  }
  return outcomes;
}

test("slot arithmetic follows the local clock and normalizes a bad schedule", () => {
  assert.equal(latestSlotAtOrBefore(at(10, 14, 3, 59), "04:00"), at(10, 13, 4, 0));
  assert.equal(latestSlotAtOrBefore(at(10, 14, 4, 0), "04:00"), at(10, 14, 4, 0));
  assert.equal(nextSlotAfter(at(10, 14, 4, 0), "04:00"), at(10, 15, 4, 0));
  assert.equal(nextSlotAfter(at(10, 14, 1, 30), "04:00"), at(10, 14, 4, 0));
  assert.deepEqual(normalizeSchedule({}), { enabled: true, incrementalEveryMinutes: 60, fullAtLocal: "04:00" });
  assert.deepEqual(normalizeSchedule({ enabled: false, incrementalEveryMinutes: 5, fullAtLocal: "25:61" }), { enabled: false, incrementalEveryMinutes: 15, fullAtLocal: "04:00" });
  assert.equal(normalizeSchedule({ incrementalEveryMinutes: 99999 }).incrementalEveryMinutes, 1440);
});

test("under a fake clock the scheduler runs an incremental per incrementalEveryMinutes", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, store, auditStore, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - 2 * DAY_MS)],
    overrides: settings({ schedule: { incrementalEveryMinutes: 30 } }),
  });
  const outcomes = await runMinutes(clock, scheduler, 125);
  assert.deepEqual(outcomes.map((item) => item.at - start), [30, 60, 90, 120].map((minutes) => minutes * MINUTE_MS));
  assert.ok(outcomes.every((item) => item.mode === "incremental"));
  // Incrementals are explicit, so the store never rebaselines on its own.
  assert.deepEqual(auditStore.calls.map((call) => [call.reason, call.context.full]), Array(4).fill(["scheduled", false]));
  assert.equal(auditStore.calls[0].context.manager, "service-entry");
  assert.deepEqual(store.types(), Array(4).fill("audit.export"));
  assert.deepEqual(store.access.map((row) => [row.action, row.actor, row.source, row.outcome]), Array(4).fill(["export_scheduled", "system:audit-scheduler", "entry", "ok"]));

  const state = JSON.parse(store.saved.get("audit"));
  assert.equal(state.lastRunAt, start + 120 * MINUTE_MS);
  assert.equal(state.lastOkAt, start + 120 * MINUTE_MS);
  assert.equal(state.lastError, null);
  assert.equal(state.nextIncrementalAt, start + 150 * MINUTE_MS);
  assert.equal(typeof state.nextFullAt, "number");
});

test("a changed interval applies live, and a disabled schedule exports nothing", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, auditStore, scheduler, current } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
  });
  assert.equal((await runMinutes(clock, scheduler, 59)).length, 0);
  current.schedule.incrementalEveryMinutes = 15;
  assert.equal((await runMinutes(clock, scheduler, 1)).length, 1);
  current.schedule.enabled = false;
  assert.equal((await runMinutes(clock, scheduler, 240)).length, 0);
  assert.equal(auditStore.calls.length, 1);
  assert.deepEqual(await scheduler.tick(), { ran: false, reason: "disabled" });
});

test("a full export runs at the first fullAtLocal slot after needsRebaseline, and only once", async () => {
  const start = at(10, 14, 2, 0);
  // The baseline is 8 days old, so needsRebaseline is already true.
  const { clock, store, auditStore, scheduler } = setup({
    start,
    exports: [exportEntry("old-base", "full", start - 8 * DAY_MS)],
    overrides: settings({ schedule: { incrementalEveryMinutes: 1440 } }),
  });
  clock.set(at(10, 14, 3, 58));
  await scheduler.tick();
  const before = await runMinutes(clock, scheduler, 1);
  assert.deepEqual(before, []);
  assert.equal(clock.now(), at(10, 14, 3, 59));
  assert.equal(auditStore.calls.length, 0);
  const atSlot = await runMinutes(clock, scheduler, 1);
  assert.equal(clock.now(), at(10, 14, 4, 0));
  assert.equal(atSlot.length, 1);
  assert.equal(atSlot[0].mode, "full");
  assert.deepEqual(auditStore.calls.map((call) => call.context.full), [true]);
  assert.equal(store.types()[0], "audit.export");

  // The new baseline ends needsRebaseline; the next days only see incrementals.
  const later = await runMinutes(clock, scheduler, 3 * 24 * 60);
  assert.equal(later.filter((item) => item.mode === "full").length, 0);
  assert.ok(auditStore.calls.slice(1).every((call) => call.context.full === false));
});

test("the full export waits for the first slot after the baseline turns old", async () => {
  // The baseline will be 6 days 22 hours old at 04:00 on the 14th: not due.
  // On the 15th at 04:00 it is 7 days 22 hours old: due, and not before.
  const baseline = at(10, 7, 6, 0);
  const { clock, auditStore, scheduler } = setup({
    start: at(10, 14, 2, 0),
    exports: [exportEntry("base", "full", baseline)],
    overrides: settings({ schedule: { incrementalEveryMinutes: 1440 } }),
  });
  await scheduler.tick();
  const outcomes = await runMinutes(clock, scheduler, 2 * 24 * 60);
  const fulls = outcomes.filter((item) => item.mode === "full");
  assert.equal(fulls.length, 1);
  assert.equal(fulls[0].at, at(10, 15, 4, 0));
  assert.equal(auditStore.calls.filter((call) => call.context.full).length, 1);
  const described = await scheduler.describe();
  assert.equal(described.needsRebaseline, false);
});

test("rebaselineDays 0 never schedules a full export", async () => {
  const { clock, auditStore, scheduler } = setup({
    start: at(10, 14, 2, 0),
    exports: [exportEntry("ancient", "full", at(9, 1, 0, 0))],
    overrides: settings({ retention: { rebaselineDays: 0 }, schedule: { incrementalEveryMinutes: 1440 } }),
  });
  await scheduler.tick();
  await runMinutes(clock, scheduler, 3 * 24 * 60);
  assert.equal(auditStore.calls.filter((call) => call.context.full).length, 0);
  assert.equal((await scheduler.describe()).nextFullAt, null);
});

test("a missing OpenWebUI container produces a skip event only", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, store, auditStore, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    containerStatus: async () => ({ exists: false, running: false }),
  });
  const outcomes = await runMinutes(clock, scheduler, 3 * 60 + 5);
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((item) => item.outcome.reason === "openwebui_missing" && item.outcome.skipped));
  assert.equal(auditStore.calls.length, 0, "no export is attempted");
  // One event for the first skip; the same reason is not repeated every hour.
  assert.deepEqual(store.types(), ["audit.export.skipped"]);
  assert.equal(store.events[0].severity, "info");
  assert.equal(store.events[0].data.reason, "openwebui_missing");
  assert.equal(store.events[0].source, "entry");
  const state = JSON.parse(store.saved.get("audit"));
  assert.equal(state.lastError, null);
  assert.equal(state.lastOkAt, null);
  assert.equal(state.lastSkip.reason, "openwebui_missing");
  assert.deepEqual(store.access.map((row) => [row.action, row.outcome]), [["export_skipped", "ok"]]);

  // Once a day the skip is recorded again.
  await runMinutes(clock, scheduler, 24 * 60);
  assert.equal(store.types().filter((type) => type === "audit.export.skipped").length, 2);
  assert.equal(store.types().some((type) => type === "audit.export.failed" || type === "audit.export"), false);
});

test("the exporter's own container-not-found answer is also only a skip", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, store, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: () => ({ ok: false, skipped: true, reason: "Open WebUI container not found: open-webui" }),
  });
  const outcomes = await runMinutes(clock, scheduler, 61);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome.reason, "openwebui_missing");
  assert.deepEqual(store.types(), ["audit.export.skipped"]);
});

test("a failed export is recorded, keeps lastError and is retried after 15 minutes", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, store, auditStore, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: (count) => {
      if (count === 1) throw new Error(`docker cp failed: ${FAKE_KEY}`);
      return { ok: true, auditId: "recovered", auditDir: "/audit/recovered", mode: "incremental", chatCount: 1, messageCount: 2, pruned: [] };
    },
  });
  const outcomes = await runMinutes(clock, scheduler, 61 + 15);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].outcome.kind, "failed");
  assert.equal(outcomes[1].at - outcomes[0].at, 15 * MINUTE_MS);
  assert.deepEqual(store.types(), ["audit.export.failed", "audit.export"]);
  assert.equal(store.events[0].severity, "warning");
  assert.equal(JSON.stringify(store.events).includes("abcdef0123456789abcdef"), false, "secrets are redacted");
  assert.equal(auditStore.calls.length, 2);
  assert.deepEqual(store.access.map((row) => [row.action, row.outcome]), [["export_failed", "error"], ["export_scheduled", "ok"]]);
  const state = JSON.parse(store.saved.get("audit"));
  assert.equal(state.lastError, null, "a later success clears the error");
  assert.equal(state.lastRuns.incremental.ok, true);
});

test("a held export lock is retried in five minutes and records nothing", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, store, auditStore, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: (count) => (count === 1
      ? { ok: false, skipped: true, reason: "export_in_progress" }
      : { ok: true, auditId: "second", auditDir: "/audit/second", mode: "incremental", chatCount: 1, messageCount: 1, pruned: [] }),
  });
  const outcomes = await runMinutes(clock, scheduler, 61 + 5);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[1].at - outcomes[0].at, 5 * MINUTE_MS);
  assert.equal(auditStore.calls.length, 2);
  assert.deepEqual(store.types(), ["audit.export"]);
});

test("an empty incremental is recorded as skipped_empty and still counts as a good run", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, store, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: () => ({ ok: true, skipped: true, empty: true, mode: "incremental", chatCount: 0, pruned: [] }),
  });
  await runMinutes(clock, scheduler, 61);
  assert.deepEqual(store.types(), ["audit.export.skipped_empty"]);
  const state = JSON.parse(store.saved.get("audit"));
  assert.equal(state.lastOkAt, start + 60 * MINUTE_MS);
  assert.equal(state.lastError, null);
  assert.deepEqual(store.access.map((row) => [row.action, row.detail.reason]), [["export_skipped", "no_changes"]]);
});

test("after a success the new export is indexed and pruned exports leave the index", async (t) => {
  const dir = tempDir(t);
  const exportDir = path.join(dir, "exp-1");
  fs.mkdirSync(exportDir);
  fs.writeFileSync(path.join(exportDir, "manifest.json"), JSON.stringify({ auditId: "exp-1", mode: "incremental", createdAt: "2026-10-14T00:00:00.000Z" }));
  const start = at(10, 14, 10, 0);
  const indexed = [];
  const removed = [];
  const index = {
    async indexExport(auditDir, manifest) { indexed.push({ auditDir, manifest }); },
    async removeExport(auditId) { removed.push(auditId); },
  };
  const { clock, store, scheduler } = setup({
    start,
    index,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: () => ({
      ok: true, auditId: "exp-1", auditDir: exportDir, mode: "incremental", chatCount: 2, messageCount: 5,
      pruned: [{ auditId: "stale-1", reason: "max-age" }, { auditId: "stale-2", reason: "max-chains" }],
    }),
  });
  await runMinutes(clock, scheduler, 61);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].auditDir, exportDir);
  assert.equal(indexed[0].manifest.auditId, "exp-1");
  assert.deepEqual(removed, ["stale-1", "stale-2"]);
  assert.deepEqual(store.types(), ["audit.export", "audit.prune"]);
  assert.deepEqual(store.events[1].data.removed.map((item) => item.auditId), ["stale-1", "stale-2"]);
  assert.ok(store.access.some((row) => row.action === "prune" && row.detail.removed.length === 2));
});

test("an index failure never fails the export", async () => {
  const start = at(10, 14, 10, 0);
  const index = {
    async indexExport() { throw new Error("index is busy"); },
    async removeExport() { throw new Error("index is busy"); },
  };
  const { clock, store, scheduler } = setup({
    start,
    index,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: () => ({ ok: true, auditId: "exp-2", auditDir: "/nowhere", mode: "incremental", chatCount: 1, messageCount: 1, pruned: [{ auditId: "old", reason: "max-age" }] }),
  });
  await runMinutes(clock, scheduler, 61);
  assert.equal(store.types().includes("audit.export.failed"), false);
  assert.equal(JSON.parse(store.saved.get("audit")).lastError, null);
});

test("one export runs at a time inside the process, manual or scheduled", async () => {
  const start = at(10, 14, 10, 0);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { auditStore, scheduler } = setup({
    start,
    exports: [exportEntry("base", "full", start - DAY_MS)],
    respond: async () => {
      await gate;
      return { ok: true, auditId: "slow", auditDir: "/audit/slow", mode: "full", chatCount: 1, messageCount: 1, pruned: [] };
    },
  });
  const first = scheduler.runExport({ mode: "full", trigger: "manual", actor: "session:abcd1234", note: "check" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await scheduler.runExport({ mode: "incremental", trigger: "manual" });
  assert.deepEqual([second.ok, second.skipped, second.reason], [false, true, "export_in_progress"]);
  assert.deepEqual(await scheduler.tick(), { ran: false, reason: "busy" });
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal(done.auditId, "slow");
  assert.equal(auditStore.calls.length, 1);
  assert.deepEqual(
    [auditStore.calls[0].reason, auditStore.calls[0].context.full, auditStore.calls[0].context.note, auditStore.calls[0].context.requestedBy],
    ["manual", true, "check", "session:abcd1234"],
  );
});

test("the saved state survives a restart: the next incremental is not postponed", async () => {
  const start = at(10, 14, 10, 0);
  const first = setup({ start, exports: [exportEntry("base", "full", start - DAY_MS)] });
  await runMinutes(first.clock, first.scheduler, 61);
  assert.equal(first.auditStore.calls.length, 1);

  // A new scheduler (an entry restart) 90 minutes after that run, same state.
  const clock = createClock(first.clock.now() + 90 * MINUTE_MS);
  const auditStore = createFakeAuditStore({ exports: first.auditStore.list, clock });
  const scheduler = createAuditScheduler({ auditStore, store: first.store, config: () => settings(), now: clock.now, logger: { warn() {} } });
  const result = await scheduler.tick();
  assert.equal(result.ran, true, "it was already due");
  assert.equal(auditStore.calls.length, 1);

  // A fresh state waits one interval, and does not catch up an old full slot.
  const fresh = setup({ start, exports: [exportEntry("ancient", "full", start - 30 * DAY_MS)] });
  assert.deepEqual(await fresh.scheduler.tick(), { ran: false, reason: "not_due" });
  assert.equal(fresh.auditStore.calls.length, 0);
});

test("a full slot missed while the entry was down is caught up when it starts", async () => {
  const start = at(10, 14, 10, 0);
  const store = createFakeStore();
  await store.setState("audit", { lastFullSlotAt: at(10, 13, 4, 0), lastAttemptAt: start - 10 * MINUTE_MS });
  const clock = createClock(start);
  const auditStore = createFakeAuditStore({ exports: [exportEntry("old", "full", start - 9 * DAY_MS)], clock });
  const scheduler = createAuditScheduler({ auditStore, store, config: () => settings(), now: clock.now, logger: { warn() {} } });
  const result = await scheduler.tick();
  assert.equal(result.mode, "full");
  assert.deepEqual(auditStore.calls.map((call) => call.context.full), [true]);
});

test("start() ticks once a minute on the injected timer and stop() clears it", async () => {
  const start = at(10, 14, 10, 0);
  const timers = [];
  const clock = createClock(start);
  const store = createFakeStore();
  const auditStore = createFakeAuditStore({ exports: [exportEntry("base", "full", start - DAY_MS)], clock });
  const scheduler = createAuditScheduler({
    auditStore, store, config: () => settings(), now: clock.now, logger: { warn() {} },
    setInterval: (callback, ms) => { const timer = { callback, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearInterval: (timer) => { timer.cleared = true; },
  });
  scheduler.start();
  scheduler.start();
  await scheduler.prime();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, MINUTE_MS);
  clock.advance(HOUR_MS);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auditStore.calls.length, 1);
  scheduler.stop();
  assert.equal(timers[0].cleared, true);
});

test("describe() reports the schedule, the last runs and the next full slot", async () => {
  const start = at(10, 14, 10, 0);
  const { clock, scheduler } = setup({ start, exports: [exportEntry("base", "full", at(10, 12, 6, 0))] });
  await runMinutes(clock, scheduler, 61);
  const described = await scheduler.describe();
  assert.equal(described.enabled, true);
  assert.equal(described.incrementalEveryMinutes, 60);
  assert.equal(described.fullAtLocal, "04:00");
  assert.equal(described.lastError, null);
  assert.equal(described.lastRuns.incremental.ok, true);
  assert.equal(described.lastRuns.full, null);
  assert.equal(described.nextIncrementalAt, new Date(start + 2 * HOUR_MS).toISOString());
  // The baseline turns 7 days old on the 19th at 06:00; the first slot after that is the 20th.
  assert.equal(described.nextFullAt, new Date(at(10, 20, 4, 0)).toISOString());
  assert.equal(described.needsRebaseline, false);
  const retention = await scheduler.retention();
  assert.equal(retention.policy.maxChains, 8);
  assert.equal(retention.chains[0].fullAuditId, "base");
  assert.equal(retention.plan.needsRebaseline, false);
});
