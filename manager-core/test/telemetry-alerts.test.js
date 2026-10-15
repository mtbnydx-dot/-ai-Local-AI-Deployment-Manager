"use strict";

// Alert engine and notifier (docs/overhaul/04-telemetry.md §12, §13, TEL-13).
// The store is a real in-process telemetry store in a temp folder; the event
// bus, the secret store and fetch are fakes, so nothing leaves the process.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openTelemetryStore } = require("../telemetry/store");
const alerts = require("../telemetry/alerts");
const notifyModule = require("../telemetry/notify");

const { createAlertEngine, DEFAULT_ALERT_RULES, ALERT_METRICS } = alerts;
const { createNotifier, formatWebhook, assertSafeWebhookUrl } = notifyModule;

const FAKE_SECRET = "fake-signing-secret-0001";
const HOOK_URL = "https://hooks.example.test/send?token=fake-token-0001";
const MINUTE = 60_000;

// --- fakes ----------------------------------------------------------------------------

function fakeClock(start = Date.now()) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; return clock.t; } };
  return clock;
}

function fakeEvents({ supervisors = 0 } = {}) {
  const published = [];
  return {
    published,
    supervisors,
    publish(type, data, opts) {
      published.push({ type, data, opts });
      return { id: `evt-${published.length}`, type, data };
    },
    subscriberCount(options = {}) {
      return options.principal === "system:supervisor" ? this.supervisors : 0;
    },
    ofType(type) {
      return published.filter((item) => item.type === type).map((item) => item.data);
    },
  };
}

function fakeSecrets(initial = {}, { failGet = false, failHas = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    calls: [],
    async has(ns, key) {
      this.calls.push(["has", ns, key]);
      if (failHas) throw new Error("dpapi unavailable");
      return map.has(`${ns}/${key}`);
    },
    async get(ns, key) {
      this.calls.push(["get", ns, key]);
      if (failGet) throw new Error("dpapi unavailable");
      return map.get(`${ns}/${key}`) || "";
    },
    async set(ns, key, value) { map.set(`${ns}/${key}`, value); },
    async clear(ns, key) { map.delete(`${ns}/${key}`); },
  };
}

function fakeFetch(plan = []) {
  const calls = [];
  let index = 0;
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    const step = plan[Math.min(index, plan.length - 1)] || { status: 200 };
    index += 1;
    if (step.throws) throw Object.assign(new Error(step.throws), { name: step.name || "TypeError" });
    return { status: step.status, type: step.type || "basic", body: null };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const noLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const noSleep = async () => {};

async function openStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-alerts-"));
  const file = path.join(dir, "telemetry.sqlite");
  const store = await openTelemetryStore({ file, inProcess: true, logger: null });
  t.after(async () => {
    await store.close({ flushMs: 0 });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { store, file, dir };
}

function sqliteRows(file, sql, ...params) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function rig(t, store, overrides = {}) {
  const clock = overrides.clock || fakeClock();
  const events = overrides.events || fakeEvents();
  const notifier = createNotifier({
    events,
    webhooks: overrides.webhooks || [],
    secretStore: overrides.secretStore || fakeSecrets(),
    fetch: overrides.fetch || fakeFetch([{ status: 200 }]),
    now: clock.now,
    lookup: noLookup,
    sleep: noSleep,
    logger: null,
    record: (event) => store.insertEvents([event]),
    ...overrides.notifier,
  });
  const engine = createAlertEngine({
    store,
    notify: notifier,
    now: clock.now,
    sources: overrides.sources || {},
    readGuard: overrides.readGuard,
    logger: null,
    ...overrides.engine,
  });
  t.after(async () => {
    await engine.stop();
    await notifier.close();
  });
  return { clock, events, notifier, engine };
}

function requestRow(index, receivedAt, extra = {}) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let value = index + (extra.salt || 0);
  let text = "";
  for (let position = 0; position < 20; position += 1) {
    text = alphabet[value % 32] + text;
    value = Math.floor(value / 32);
  }
  const { salt, ...rest } = extra; // eslint-disable-line no-unused-vars
  return {
    requestId: `req_${text}`,
    ingress: "entry",
    receivedAt,
    endedAt: receivedAt + 500,
    managerId: "vllm",
    fleetId: "vllm:primary",
    protocol: "openai",
    op: "chat",
    method: "POST",
    path: "/gateway/auto/openai/v1/chat/completions",
    stream: false,
    sourceProgram: "curl",
    status: 200,
    terminalState: "completed",
    errorClass: "none",
    durationMs: 500,
    ...rest,
  };
}

const ALERT = Object.freeze({
  ruleId: "gpu_temp_high",
  scopeKey: "gpu:0",
  severity: "warning",
  title: { zh: "GPU 0 温度过高", en: "GPU 0 temperature high" },
  value: 87,
  threshold: 85,
  since: Date.UTC(2026, 9, 15, 8, 0, 0),
  at: Date.UTC(2026, 9, 15, 8, 2, 0),
  link: "/#/observability/alerts?rule=gpu_temp_high",
});
const GOLDEN_NOW = Date.UTC(2026, 9, 15, 8, 2, 0);
const GOLDEN_TEXT = "[FIRING][warning] GPU 0 温度过高 / GPU 0 temperature high\nrule: gpu_temp_high | scope: gpu:0 | value: 87 | threshold: 85\nsince: 2026-10-15T08:00:00.000Z\nhttp://127.0.0.1:5176/#/observability/alerts?rule=gpu_temp_high";

// --- seeding -----------------------------------------------------------------------------

test("the default rules are seeded once, never overwrite an edit and never duplicate", async (t) => {
  const { store, file } = await openStore(t);
  const first = rig(t, store);
  const rules = await first.engine.listRules();
  assert.equal(rules.length, DEFAULT_ALERT_RULES.length);
  assert.equal(rules.length, 16);
  assert.ok(rules.every((rule) => rule.builtin === true && rule.enabled === true));
  assert.deepEqual(new Set(rules.map((rule) => rule.ruleId)), new Set(DEFAULT_ALERT_RULES.map((rule) => rule.ruleId)));
  const hot = rules.find((rule) => rule.ruleId === "gpu_temp_high");
  assert.deepEqual([hot.metric, hot.op, hot.threshold, hot.forS, hot.windowS, hot.severity, hot.channels], ["gpu.temp_c", ">", 85, 120, 60, "warning", ["inapp", "toast"]]);
  const disk = rules.find((rule) => rule.ruleId === "disk_low");
  assert.deepEqual([disk.op, disk.threshold, disk.clearThreshold, disk.forS, disk.windowS], ["<", 0.1, 0.12, 600, 60]);
  assert.equal(rules.find((rule) => rule.ruleId === "upstream_errors").minSamples, 20);
  for (const metric of ALERT_METRICS) assert.ok(metric.id && metric.unit && metric.scopes.length && metric.label.zh && metric.label.en, metric.id);
  for (const rule of DEFAULT_ALERT_RULES) assert.ok(ALERT_METRICS.some((metric) => metric.id === rule.metric), rule.ruleId);

  await first.engine.updateRule("gpu_temp_high", { threshold: 80 });
  // A second engine (a restart) seeds again: the edit stays and nothing is added.
  const second = rig(t, store);
  const again = await second.engine.listRules();
  assert.equal(again.length, 16);
  assert.equal(again.find((rule) => rule.ruleId === "gpu_temp_high").threshold, 80);
  assert.equal(sqliteRows(file, "SELECT COUNT(*) AS n FROM alert_rules")[0].n, 16);
});

test("the legacy GPU guard thresholds seed gpu_temp_high and gpu_power_cap once", async (t) => {
  const { store } = await openStore(t);
  const guard = { tempGuardEnabled: true, tempLimitC: 82, powerGuardEnabled: true, powerLimitPct: 95 };
  const first = rig(t, store, { readGuard: () => guard });
  const rules = await first.engine.listRules();
  assert.equal(rules.find((rule) => rule.ruleId === "gpu_temp_high").threshold, 82);
  assert.equal(rules.find((rule) => rule.ruleId === "gpu_power_cap").threshold, 0.95);
  assert.equal(rules.find((rule) => rule.ruleId === "gpu_temp_critical").threshold, 90, "the critical limit is not a guard setting");
  assert.equal(rules.find((rule) => rule.ruleId === "gpu_temp_high").updatedBy, "migration");

  // The migration ran: a later change of the legacy settings does not move the rule again.
  const second = rig(t, store, { readGuard: () => ({ tempGuardEnabled: true, tempLimitC: 70, powerGuardEnabled: true, powerLimitPct: 90 }) });
  const again = await second.engine.listRules();
  assert.equal(again.find((rule) => rule.ruleId === "gpu_temp_high").threshold, 82);
  assert.equal(again.find((rule) => rule.ruleId === "gpu_power_cap").threshold, 0.95);
});

test("disabled guards leave the defaults, and the guard is only consulted once", async (t) => {
  const { store } = await openStore(t);
  const first = rig(t, store, { readGuard: () => ({ tempGuardEnabled: false, tempLimitC: 70, powerGuardEnabled: false }) });
  const rules = await first.engine.listRules();
  assert.equal(rules.find((rule) => rule.ruleId === "gpu_temp_high").threshold, 85);
  assert.equal(rules.find((rule) => rule.ruleId === "gpu_power_cap").threshold, 0.98);
  const second = rig(t, store, { readGuard: () => ({ tempGuardEnabled: true, tempLimitC: 70 }) });
  assert.equal((await second.engine.listRules()).find((rule) => rule.ruleId === "gpu_temp_high").threshold, 85, "the one-time migration is over");
});

test("an unreadable guard does not use up the migration", async (t) => {
  const { store } = await openStore(t);
  const first = rig(t, store, { readGuard: () => { throw new Error("unreadable"); } });
  assert.equal((await first.engine.listRules()).find((rule) => rule.ruleId === "gpu_temp_high").threshold, 85);
  const second = rig(t, store, { readGuard: () => ({ tempGuardEnabled: true, tempLimitC: 78 }) });
  assert.equal((await second.engine.listRules()).find((rule) => rule.ruleId === "gpu_temp_high").threshold, 78);
});

// --- rules --------------------------------------------------------------------------------

test("builtin rules cannot be deleted; custom rules can be created, edited and deleted", async (t) => {
  const { store } = await openStore(t);
  const { engine } = rig(t, store);
  await assert.rejects(() => engine.deleteRule("gpu_temp_high"), (error) => error.status === 409 && error.code === "builtin_rule");
  await assert.rejects(() => engine.deleteRule("no_such_rule"), (error) => error.status === 404 && error.code === "rule_not_found");

  const created = await engine.createRule({
    metric: "gpu.temp_c", scope: { gpu: 1 }, op: ">=", threshold: 70, clearThreshold: 65, windowS: 60, forS: 30, severity: "info", channels: ["inapp"], titleZh: "GPU {id} 偏热", titleEn: "GPU {id} warm",
  });
  assert.match(created.ruleId, /^custom_[0-9a-f]{10}$/);
  assert.equal(created.builtin, false);
  assert.deepEqual([created.scope, created.minSamples, created.cooldownS, created.enabled], [{ gpu: 1 }, 0, 1800, true]);

  const updated = await engine.updateRule(created.ruleId, { threshold: 72, titleEn: "GPU {id} getting warm", channels: ["inapp", "webhook"] });
  assert.equal(updated.rule.threshold, 72);
  assert.deepEqual(updated.rule.channels, ["inapp", "webhook"]);
  assert.deepEqual(updated.changed.sort(), ["channels", "threshold", "titleEn"]);

  // A builtin rule accepts only the editable fields.
  const edited = await engine.updateRule("kv_saturation", { threshold: 0.9, enabled: false, cooldownS: 600 });
  assert.deepEqual([edited.rule.threshold, edited.rule.enabled, edited.rule.cooldownS], [0.9, false, 600]);
  await assert.rejects(() => engine.updateRule("kv_saturation", { metric: "rt.waiting", titleEn: "renamed", minSamples: 3 }), (error) => {
    assert.equal(error.status, 400);
    assert.deepEqual(error.errors.map((item) => [item.field, item.code]), [["metric", "not_editable"], ["titleEn", "not_editable"], ["minSamples", "not_editable"]]);
    return true;
  });

  await engine.deleteRule(created.ruleId);
  assert.equal((await engine.listRules()).some((rule) => rule.ruleId === created.ruleId), false);
});

test("a bad rule is refused with a list of errors", async (t) => {
  const { store } = await openStore(t);
  const { engine } = rig(t, store);
  const good = { metric: "rt.waiting", op: ">", threshold: 1, windowS: 60, forS: 0, severity: "info", channels: ["inapp"], titleZh: "排队", titleEn: "Queue" };
  const cases = [
    [{ ...good, metric: "sql.anything" }, "metric", "unknown_metric"],
    [{ ...good, op: "==" }, "op", "invalid_value"],
    [{ ...good, threshold: "high" }, "threshold", "invalid_type"],
    [{ ...good, windowS: 1 }, "windowS", "out_of_range"],
    [{ ...good, forS: -1 }, "forS", "out_of_range"],
    [{ ...good, severity: "fatal" }, "severity", "invalid_value"],
    [{ ...good, channels: ["sms"] }, "channels", "invalid_value"],
    [{ ...good, channels: ["inapp", "inapp"] }, "channels", "invalid_value"],
    [{ ...good, titleEn: "" }, "titleEn", "invalid_value"],
    [{ ...good, scope: { gpu: 0 } }, "scope.gpu", "unknown_key"],
    [{ ...good, clearThreshold: 5 }, "clearThreshold", "invalid_value"],
    [{ ...good, bogus: 1 }, "bogus", "unknown_key"],
    [{ ...good, cooldownS: 5 }, "cooldownS", "out_of_range"],
  ];
  for (const [body, field, code] of cases) {
    await assert.rejects(() => engine.createRule(body), (error) => {
      assert.equal(error.status, 400, JSON.stringify(body));
      assert.equal(error.code, "invalid_request");
      assert.ok(error.errors.some((item) => item.field === field && item.code === code), `${field} ${code}: ${JSON.stringify(error.errors)}`);
      return true;
    });
  }
  const { op, ...incomplete } = good; // eslint-disable-line no-unused-vars
  await assert.rejects(() => engine.createRule(incomplete), (error) => error.errors.some((item) => item.field === "op" && item.code === "required"));
  assert.equal((await engine.listRules()).length, 16, "nothing was saved");
});

// --- the state machine ----------------------------------------------------------------------

function downSource(state) {
  return { instances: () => [{ fleetId: "vllm:primary", expectedReady: true, lifecycleState: state.lifecycle || "ready", failures: state.failures }] };
}

test("pending becomes firing after for_s, notifies once and writes alert.firing", async (t) => {
  const { store, file } = await openStore(t);
  const state = { failures: 3 };
  const { engine, clock, events } = rig(t, store, { sources: downSource(state) });

  await engine.tick();
  assert.deepEqual((await engine.listAlerts({ state: "all" })).map((row) => [row.ruleId, row.scopeKey, row.state]), [["instance_down", "fleet:vllm:primary", "pending"]]);
  assert.equal(events.published.length, 0, "pending says nothing");

  clock.advance(15_000);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "all" }))[0].state, "pending", "for_s (30 s) has not passed");

  clock.advance(15_000);
  await engine.tick();
  const [row] = await engine.listAlerts({ state: "firing" });
  assert.deepEqual([row.ruleId, row.state, row.severity, row.value, row.threshold], ["instance_down", "firing", "critical", 1, 1]);
  assert.deepEqual(row.title, { zh: "实例 vllm:primary 无响应", en: "Instance vllm:primary is down" });
  assert.ok(row.since && row.firedAt && row.ackedAt === null && row.silencedUntil === null);
  assert.ok(Date.parse(row.firedAt) - Date.parse(row.since) >= 30_000, "since is when the condition began");

  const fired = events.ofType("alerts");
  assert.equal(fired.length, 1);
  assert.equal(fired[0].action, "firing");
  assert.deepEqual(Object.keys(fired[0].alert).sort(), ["link", "ruleId", "scopeKey", "severity", "since", "threshold", "title", "value"]);
  const notes = events.ofType("notification");
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].channels, ["inapp", "toast"], "the webhook channel is not an in-app channel");
  assert.match(notes[0].dedupeKey, /^alert:instance_down:fleet:vllm:primary:firing:\d+$/);
  assert.equal(notes[0].severity, "error");
  assert.deepEqual(notes[0].title, { zh: "实例 vllm:primary 无响应", en: "Instance vllm:primary is down" });

  const eventRows = sqliteRows(file, "SELECT type, severity, fleet_id, data FROM events WHERE type LIKE 'alert.%'");
  assert.deepEqual(eventRows.map((item) => [item.type, item.severity, item.fleet_id]), [["alert.firing", "critical", "vllm:primary"]]);
  assert.equal(JSON.parse(eventRows[0].data).ruleId, "instance_down");

  // Another evaluation does not notify again.
  clock.advance(15_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 1);
});

test("a pending alert that stops holding returns to ok without a trace", async (t) => {
  const { store, file } = await openStore(t);
  const state = { failures: 3 };
  const { engine, clock, events } = rig(t, store, { sources: downSource(state) });
  await engine.tick();
  state.failures = 0;
  clock.advance(15_000);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "all" })).length, 0);
  assert.equal(events.published.length, 0);
  assert.equal(sqliteRows(file, "SELECT COUNT(*) AS n FROM alert_state")[0].n, 0);
});

test("firing resolves when the value crosses clear_threshold, not the threshold", async (t) => {
  const { store, file } = await openStore(t);
  const free = { ratio: 0.05 };
  const { engine, clock, events } = rig(t, store, { sources: { disks: () => [{ label: "ai-root", freeRatio: free.ratio }] } });
  await engine.tick();
  clock.advance(10 * MINUTE);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 1, "disk_low fires after 10 minutes");
  assert.equal((await engine.listAlerts({ state: "firing" }))[0].scopeKey, "disk:ai-root");

  // 0.11 is above the threshold (0.10) but below the clear threshold (0.12): still firing.
  free.ratio = 0.11;
  clock.advance(MINUTE);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 1);

  free.ratio = 0.12;
  clock.advance(MINUTE);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 0);
  const all = await engine.listAlerts({ state: "all" });
  assert.deepEqual(all.map((row) => row.state), ["ok"]);
  assert.ok(all[0].firedAt);
  assert.deepEqual(events.ofType("alerts").map((item) => item.action), ["firing", "resolved"]);
  const notes = events.ofType("notification");
  assert.deepEqual(notes.map((item) => item.severity), ["warn", "success"]);
  assert.match(notes[1].title.en, /^Resolved: /);
  assert.deepEqual(sqliteRows(file, "SELECT type FROM events WHERE type LIKE 'alert.%' ORDER BY id").map((row) => row.type), ["alert.firing", "alert.resolved"]);
});

test("a firing alert re-notifies after each cooldown; ack stops that, resolution still notifies", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 3 };
  const { engine, clock, events } = rig(t, store, { sources: downSource(state) });
  await engine.updateRule("instance_down", { forS: 0, cooldownS: 600 });
  await engine.tick();
  assert.equal(events.ofType("notification").length, 1, "for_s 0 fires at once");

  clock.advance(599_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 1, "inside the cooldown");
  clock.advance(1000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 2, "after cooldown_s");
  assert.equal(events.ofType("alerts").length, 1, "a re-notification does not repeat the state event");
  assert.notEqual(events.ofType("notification")[0].dedupeKey, events.ofType("notification")[1].dedupeKey);

  const acked = await engine.ack("instance_down", "fleet:vllm:primary");
  assert.equal(acked.ok, true);
  assert.equal(acked.state, "firing");
  assert.ok(acked.ackedAt);
  assert.deepEqual(events.ofType("alerts").map((item) => item.action), ["firing", "acked"]);
  assert.equal(events.ofType("notification").length, 2, "an ack is not a notification");

  clock.advance(1200_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 2, "acked alerts are not re-notified");
  assert.ok((await engine.listAlerts({ state: "firing" }))[0].ackedAt);

  state.failures = 0;
  clock.advance(15_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 3, "resolution is still announced");
  assert.equal(events.ofType("alerts").at(-1).action, "resolved");
  assert.equal((await engine.listAlerts({ state: "all" }))[0].ackedAt, null, "the ack ends with the alert");
});

test("ack needs a firing alert", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 3 };
  const { engine } = rig(t, store, { sources: downSource(state) });
  await engine.tick();
  await assert.rejects(() => engine.ack("instance_down", "fleet:vllm:primary"), (error) => error.status === 409 && error.code === "not_firing");
  await assert.rejects(() => engine.ack("instance_down", "fleet:nope"), (error) => error.status === 404 && error.code === "alert_not_found");
});

test("silence suppresses notifications without changing the state", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 3 };
  const { engine, clock, events } = rig(t, store, { sources: downSource(state), webhooks: [{ id: "ops", url: HOOK_URL, format: "generic", minSeverity: "info" }] });
  await engine.updateRule("instance_down", { forS: 0, cooldownS: 600 });
  await engine.updateRule("instance_down", { channels: ["inapp", "toast", "webhook"] });
  await engine.tick();
  const key = "fleet:vllm:primary";
  assert.equal(events.ofType("notification").length, 1);

  const until = clock.t + 1800_000;
  const silenced = await engine.silence("instance_down", key, until);
  assert.equal(silenced.state, "firing", "the state is unchanged");
  assert.equal(silenced.silencedUntil, new Date(until).toISOString());
  assert.equal((await engine.listAlerts({ state: "firing" }))[0].silencedUntil, new Date(until).toISOString());

  clock.advance(700_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 1, "no re-notification while silenced");

  state.failures = 0;
  clock.advance(15_000);
  await engine.tick();
  assert.equal(events.ofType("alerts").at(-1).action, "resolved", "the state stream still follows the state");
  assert.equal(events.ofType("notification").length, 1, "a silenced resolution is not announced either");

  // Silence validation.
  await assert.rejects(() => engine.silence("instance_down", key, clock.t - 1), (error) => error.status === 400);
  await assert.rejects(() => engine.silence("instance_down", key, clock.t + 31 * 86_400_000), (error) => error.status === 400);
  const cleared = await engine.silence("instance_down", key, null);
  assert.equal(cleared.silencedUntil, null);
});

test("an alert that fires while silenced notifies after the silence ends and the cooldown passes", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 0 };
  const { engine, clock, events } = rig(t, store, { sources: downSource(state) });
  await engine.updateRule("instance_down", { forS: 0, cooldownS: 600 });
  await engine.tick();
  state.failures = 3;
  await engine.tick();
  assert.equal(events.ofType("notification").length, 1);
  state.failures = 0;
  clock.advance(15_000);
  await engine.tick();
  // Silence the resolved scope in advance, then let it fire again.
  await engine.silence("instance_down", "fleet:vllm:primary", clock.t + 300_000);
  state.failures = 3;
  clock.advance(15_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 2, "only the first firing and the resolution so far");
  assert.equal(events.ofType("notification").at(-1).severity, "success");
  clock.advance(600_000);
  await engine.tick();
  assert.equal(events.ofType("notification").length, 3, "the silence ended and the cooldown has passed");
  assert.equal(events.ofType("notification").at(-1).severity, "error");
});

test("min_samples keeps a rule ok; a firing alert that cannot be judged any more resolves", async (t) => {
  const { store } = await openStore(t);
  const { engine, clock, events } = rig(t, store);
  await engine.updateRule("upstream_errors", { forS: 0 });
  const rows = [];
  for (let index = 0; index < 19; index += 1) {
    rows.push(requestRow(index, clock.t - 60_000 + index, index % 2 ? { status: 502, terminalState: "failed", errorClass: "upstream_5xx" } : {}));
  }
  assert.equal((await store.insertRequests(rows)).rejected, 0);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "all" })).length, 0, "19 requests are below the minimum of 20");

  assert.equal((await store.insertRequests([requestRow(19, clock.t - 30_000, { status: 502, terminalState: "failed", errorClass: "upstream_timeout" })])).rejected, 0);
  clock.advance(15_000);
  await engine.tick();
  const [row] = await engine.listAlerts({ state: "firing" });
  assert.equal(row.ruleId, "upstream_errors");
  assert.equal(row.scopeKey, "*");
  assert.equal(row.value, 0.5);
  assert.equal(events.ofType("alerts").length, 1);

  // The window moves on and traffic stops: too few samples to judge, so it resolves.
  clock.advance(10 * MINUTE);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 0);
  assert.equal(events.ofType("alerts").at(-1).action, "resolved");
});

test("a scope that disappears resolves its alert, and a disabled rule clears quietly", async (t) => {
  const { store } = await openStore(t);
  const list = [{ fleetId: "vllm:primary", expectedReady: true, lifecycleState: "ready", failures: 3 }];
  const { engine, clock, events } = rig(t, store, { sources: { instances: () => list } });
  await engine.updateRule("instance_down", { forS: 0 });
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 1);
  list.length = 0;
  clock.advance(15_000);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 0, "an instance that was stopped on purpose is not down");
  assert.equal(events.ofType("alerts").at(-1).action, "resolved");

  list.push({ fleetId: "vllm:primary", expectedReady: true, lifecycleState: "crashed", failures: 0 });
  clock.advance(15_000);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 1, "a crashed lifecycle counts at once");
  const notesBefore = events.ofType("notification").length;
  await engine.updateRule("instance_down", { enabled: false });
  clock.advance(15_000);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 0);
  assert.equal(events.ofType("notification").length, notesBefore, "disabling a rule is not an announcement");
});

test("a source that fails leaves the states alone", async (t) => {
  const { store } = await openStore(t);
  const mode = { fail: false };
  const { engine, clock } = rig(t, store, {
    sources: { instances: () => { if (mode.fail) throw new Error("catalog unavailable"); return [{ fleetId: "vllm:primary", expectedReady: true, lifecycleState: "ready", failures: 3 }]; } },
  });
  await engine.updateRule("instance_down", { forS: 0 });
  await engine.tick();
  mode.fail = true;
  clock.advance(15_000);
  assert.equal((await engine.tick()).ok, true);
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 1);
});

test("a restart keeps a firing alert firing and does not announce it again", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 3 };
  const first = rig(t, store, { sources: downSource(state) });
  await first.engine.updateRule("instance_down", { forS: 0 });
  await first.engine.tick();
  assert.equal(first.events.ofType("notification").length, 1);
  await first.engine.stop();

  const second = rig(t, store, { sources: downSource(state), clock: first.clock });
  second.clock.advance(15_000);
  await second.engine.tick();
  assert.equal(second.events.published.length, 0, "no second announcement after a restart");
  assert.equal((await second.engine.listAlerts({ state: "firing" })).length, 1);
});

// --- measured metrics -------------------------------------------------------------------------

test("SQL metrics are measured per scope key", async (t) => {
  const { store } = await openStore(t);
  const now = Date.now();
  const rows = [];
  for (let index = 0; index < 6; index += 1) {
    rows.push(requestRow(index, now - 30_000 + index, { errorClass: "auth_failed", status: 401, terminalState: "rejected", clientIp: index < 4 ? "203.0.113.7" : "198.51.100.23" }));
  }
  rows.push(requestRow(10, now - 20_000, { errorClass: "billing_unavailable", status: 503, terminalState: "rejected" }));
  rows.push(requestRow(11, now - 20_000, { fleetId: "llama:main", errorClass: "upstream_5xx", status: 502, terminalState: "failed" }));
  rows.push(requestRow(12, now - 20_000, { fleetId: "llama:main" }));
  rows.push(requestRow(13, now - 20_000, { ingress: "import:entry", errorClass: "upstream_5xx", status: 502, terminalState: "failed" }));
  assert.equal((await store.insertRequests(rows)).rejected, 0);
  await store.insertRuntimeSamples([
    { at: now - 20_000, fleetId: "vllm:primary", model: "m", managerId: "vllm", runtimeKey: "k", scrapeOk: 1, idle: 0, waiting: 2, kvUsage: 0.96 },
    { at: now - 10_000, fleetId: "vllm:primary", model: "m", managerId: "vllm", runtimeKey: "k", scrapeOk: 1, idle: 0, waiting: 4, kvUsage: 0.98 },
    { at: now - 10_000, fleetId: "llama:main", model: "m", managerId: "llama", runtimeKey: "k", scrapeOk: 1, idle: 0, waiting: 0, kvUsage: 0.2 },
    { at: now - 5_000, fleetId: "llama:main", model: "m", managerId: "llama", runtimeKey: "k", scrapeOk: 0, idle: 0, waiting: 99, kvUsage: 0.99 },
  ]);
  await store.insertGpuSamples([
    { at: now - 20_000, gpuIndex: 0, name: "g", tempC: 88, powerW: 590, powerLimitW: 600, throttle: "hw_slowdown,sw_power_cap" },
    { at: now - 10_000, gpuIndex: 0, name: "g", tempC: 91, powerW: 596, powerLimitW: 600, throttle: "" },
    { at: now - 10_000, gpuIndex: 1, name: "g", tempC: 60, powerW: 100, powerLimitW: 600, throttle: "sw_thermal" },
  ]);
  await store.insertEvents([
    { at: now - 15_000, type: "security.ban", severity: "warning", source: "entry", title: "Client address banned", data: {}, dedupeKey: "ban-1" },
    { at: now - 3600_000, type: "security.ban", severity: "warning", source: "entry", title: "Old ban", data: {}, dedupeKey: "ban-0" },
  ]);

  const measure = async (id, metric, scope = {}, windowS = 300) => (await store.call("alertMeasure", { now, queries: [{ id, metric, windowS, scope }] })).results[id];
  assert.deepEqual(await measure("a", "req.upstream_error_rate"), [{ scopeKey: "*", value: 1 / 9, samples: 9 }], "imports are not live traffic");
  assert.deepEqual(await measure("b", "req.upstream_error_rate", { perFleet: true }), [
    { scopeKey: "fleet:llama:main", value: 0.5, samples: 2 },
    { scopeKey: "fleet:vllm:primary", value: 0, samples: 7 },
  ]);
  assert.deepEqual(await measure("c", "req.upstream_error_rate", { fleetId: "llama:main" }), [{ scopeKey: "fleet:llama:main", value: 0.5, samples: 2 }]);
  assert.deepEqual(await measure("d", "req.error_count", { errorClasses: ["auth_failed", "billing_unavailable"] }), [{ scopeKey: "*", value: 7, samples: 9 }]);
  assert.deepEqual(await measure("e", "req.error_count"), [{ scopeKey: "*", value: 1, samples: 9 }], "the default classes are upstream errors");
  assert.deepEqual(await measure("f", "billing.unavailable"), [{ scopeKey: "*", value: 1, samples: 9 }]);

  const [auth] = await measure("g", "req.auth_failures");
  assert.equal(auth.value, 6);
  assert.deepEqual(auth.detail, { topIps: [{ ipMasked: "203.0.113.x", count: 4 }, { ipMasked: "198.51.100.x", count: 2 }] }, "top addresses are masked in the worker");
  assert.equal(JSON.stringify(auth).includes("203.0.113.7"), false);

  assert.deepEqual(await measure("h", "rt.waiting", {}, 60), [{ scopeKey: "fleet:llama:main", value: 0, samples: 1 }, { scopeKey: "fleet:vllm:primary", value: 3, samples: 2 }], "failed scrapes are not samples");
  assert.deepEqual((await measure("i", "rt.kv_usage", {}, 60)).map((item) => [item.scopeKey, item.value]), [["fleet:llama:main", 0.2], ["fleet:vllm:primary", 0.97]]);
  assert.deepEqual(await measure("j", "gpu.temp_c", {}, 60), [{ scopeKey: "gpu:0", value: 91, samples: 2 }, { scopeKey: "gpu:1", value: 60, samples: 1 }]);
  assert.deepEqual(await measure("k", "gpu.temp_c", { gpu: 1 }, 60), [{ scopeKey: "gpu:1", value: 60, samples: 1 }]);
  const power = await measure("l", "gpu.power_ratio", {}, 60);
  assert.equal(power[0].scopeKey, "gpu:0");
  assert.ok(Math.abs(power[0].value - (590 / 600 + 596 / 600) / 2) < 1e-9);
  assert.deepEqual(await measure("m", "gpu.hw_throttle_share", {}, 60), [{ scopeKey: "gpu:0", value: 0.5, samples: 2 }, { scopeKey: "gpu:1", value: 0, samples: 1 }], "software reasons do not count");
  assert.deepEqual(await measure("n", "security.bans", {}, 300), [{ scopeKey: "*", value: 1, samples: 1 }]);
  assert.deepEqual(await measure("o", "security.bans", {}, 7200), [{ scopeKey: "*", value: 2, samples: 2 }]);
  assert.deepEqual((await store.call("alertMeasure", { now, queries: [{ id: "x", metric: "instance.down", windowS: 60, scope: {} }] })).results.x, { error: "unknown_metric" });
});

test("the auth_storm rule carries masked addresses and nothing raw reaches the streams", async (t) => {
  const { store, file } = await openStore(t);
  const { engine, clock, events } = rig(t, store);
  const rows = [];
  for (let index = 0; index < 31; index += 1) {
    rows.push(requestRow(index, clock.t - 20_000 + index, { errorClass: "auth_failed", status: 401, terminalState: "rejected", clientIp: "203.0.113.7" }));
  }
  await store.insertRequests(rows);
  await engine.tick();
  const [row] = await engine.listAlerts({ state: "firing" });
  assert.equal(row.ruleId, "auth_storm");
  assert.equal(row.value, 31);
  assert.deepEqual(row.detail, { topIps: [{ ipMasked: "203.0.113.x", count: 31 }] });
  assert.equal(JSON.stringify(events.published).includes("203.0.113.7"), false);
  assert.equal(JSON.stringify(sqliteRows(file, "SELECT data FROM events WHERE type = 'alert.firing'")).includes("203.0.113.7"), false);
});

test("a custom GPU rule fires from stored samples and a vanished GPU resolves it", async (t) => {
  const { store } = await openStore(t);
  const { engine, clock, events } = rig(t, store);
  const rule = await engine.createRule({ metric: "gpu.temp_c", op: ">", threshold: 80, windowS: 60, forS: 0, severity: "warning", channels: ["inapp"], titleZh: "GPU {id} 偏热", titleEn: "GPU {id} hot" });
  await store.insertGpuSamples([{ at: clock.t - 10_000, gpuIndex: 0, name: "g", tempC: 83 }, { at: clock.t - 10_000, gpuIndex: 1, name: "g", tempC: 70 }]);
  await engine.tick();
  const firing = await engine.listAlerts({ state: "firing" });
  assert.deepEqual(firing.map((row) => [row.ruleId, row.scopeKey, row.value]), [[rule.ruleId, "gpu:0", 83]]);
  assert.deepEqual(firing[0].title, { zh: "GPU 0 偏热", en: "GPU 0 hot" });
  assert.deepEqual(events.ofType("notification")[0].channels, ["inapp"]);
  clock.advance(5 * MINUTE);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 0, "no samples any more: nothing to judge");
});

test("telemetry staleness: a degraded collector grows, an ok one resets, recorder drops count", async (t) => {
  const { store } = await openStore(t);
  const collectors = [{ name: "gpu", ok: true }];
  const recorder = { dropped: 0 };
  const { engine, clock } = rig(t, store, { sources: { collectors: () => collectors, recorder: () => recorder } });
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "all" })).length, 0);
  collectors[0].ok = false;
  clock.advance(30_000);
  await engine.tick();
  clock.advance(31_000);
  await engine.tick();
  const [stale] = await engine.listAlerts({ state: "firing" });
  assert.deepEqual([stale.ruleId, stale.scopeKey], ["telemetry_stale", "collector:gpu"]);
  assert.ok(stale.value > 60);
  collectors[0].ok = true;
  clock.advance(15_000);
  await engine.tick();
  assert.equal((await engine.listAlerts({ state: "firing" })).length, 0);
  recorder.dropped = 5;
  clock.advance(15_000);
  await engine.tick();
  assert.deepEqual((await engine.listAlerts({ state: "firing" })).map((row) => row.scopeKey), ["collector:recorder"]);
});

test("audit metrics: a failed export fires, an unknown chain status is not an alert", async (t) => {
  const { store } = await openStore(t);
  const audit = { exportFailed: true, chainRisk: null };
  const { engine } = rig(t, store, { sources: { audit: () => audit } });
  await engine.tick();
  assert.deepEqual((await engine.listAlerts({ state: "firing" })).map((row) => row.ruleId), ["audit_export_failed"]);
});

test("titles render {id} from the scope key and never come out empty", () => {
  assert.equal(alerts.renderTitle("GPU {id} 温度过高", "gpu:0"), "GPU 0 温度过高");
  assert.equal(alerts.renderTitle("Instance {id} is down", "fleet:vllm:primary"), "Instance vllm:primary is down");
  assert.equal(alerts.renderTitle("Billing is {scope}", "*"), "Billing is *");
  assert.equal(alerts.renderTitle("Disk  {id}  low", "disk:ai-root"), "Disk ai-root low", "spaces collapse");
  assert.equal(alerts.renderTitle("{id}", "*", "custom_0123456789"), "custom_0123456789", "an empty title falls back to the rule id");
  assert.equal(alerts.renderTitle("{id}", "*"), "");
});

test("disk roots come from the platform root and model-storage.json, by label and never by path", () => {
  const files = { "storage.json": JSON.stringify({ roots: [{ id: "archive", path: "E:\\models-archive" }, { id: "legacy", path: "E:\\dup" }] }) };
  const fakeFs = {
    readFileSync: (file) => { if (!files[file]) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[file]; },
    existsSync: () => true,
    statfsSync: (target) => ({ blocks: 1000, bavail: String(target).includes("archive") ? 50 : 500 }),
  };
  const roots = alerts.diskRootsFrom({ aiRoot: "C:\\platform", storageFile: "storage.json", fsImpl: fakeFs });
  assert.deepEqual(roots.map((item) => item.label), ["ai-root", "legacy", "archive"], "a duplicate label is ignored");
  assert.deepEqual(alerts.diskRootsFrom({ aiRoot: "C:\\platform", storageFile: "absent.json", fsImpl: fakeFs }).map((item) => item.label), ["ai-root", "legacy"]);
  const free = alerts.readDiskFree(roots, fakeFs);
  const labels = free.map((item) => item.label);
  // Roots on one Windows drive are one volume.
  assert.deepEqual(labels, process.platform === "win32" ? ["ai-root", "archive"] : ["ai-root", "legacy", "archive"]);
  assert.equal(free.find((item) => item.label === "archive").freeRatio, 0.05);
  assert.equal(JSON.stringify(free).includes("models-archive"), false);
  assert.deepEqual(alerts.readDiskFree([{ label: "gone", path: "Z:\\gone" }], { ...fakeFs, existsSync: () => false }), []);
});

test("the manager health source counts consecutive failures", async () => {
  const outcomes = { vllm: [false, false, false, true], llama: [true, true, true, true] };
  const position = { vllm: 0, llama: 0 };
  const source = alerts.createManagerHealthSource({
    managers: [{ id: "vllm" }, { id: "llama" }],
    get: async (id, target) => {
      assert.equal(target, "/api/manager/health");
      const ok = outcomes[id][position[id]++];
      if (id === "llama" && position[id] === 4) throw new Error("socket hang up");
      return { ok, status: ok ? 200 : 502 };
    },
  });
  assert.deepEqual(await source.poll(), [{ id: "vllm", failures: 1 }, { id: "llama", failures: 0 }]);
  await source.poll();
  assert.deepEqual(await source.poll(), [{ id: "vllm", failures: 3 }, { id: "llama", failures: 0 }]);
  assert.deepEqual(await source.poll(), [{ id: "vllm", failures: 0 }, { id: "llama", failures: 1 }], "a thrown error is a failed poll; an answer resets the streak");
});

// --- webhook formats ------------------------------------------------------------------------------

test("webhook formats match their golden bodies", () => {
  const options = { now: GOLDEN_NOW, url: HOOK_URL, event: "alert.firing" };
  const generic = formatWebhook("generic", ALERT, options);
  const goldenBody = '{"version":1,"event":"alert.firing","ruleId":"gpu_temp_high","severity":"warning","scope":"gpu:0","title":"GPU 0 温度过高 / GPU 0 temperature high","value":87,"threshold":85,"since":"2026-10-15T08:00:00.000Z","at":"2026-10-15T08:02:00.000Z","link":"http://127.0.0.1:5176/#/observability/alerts?rule=gpu_temp_high"}';
  assert.equal(generic.body, goldenBody);
  assert.equal(generic.headers["x-ai-signature"], undefined, "no secret, no signature");
  assert.equal(generic.url, HOOK_URL);

  const signed = formatWebhook("generic", ALERT, { ...options, secret: FAKE_SECRET });
  assert.equal(signed.body, goldenBody);
  assert.equal(signed.headers["x-ai-signature"], "sha256=b3a26259aeeb685013e336133dba6322930c7122ba5604d2a54c2c59c9487aa6");
  assert.equal(signed.headers["x-ai-signature"], `sha256=${crypto.createHmac("sha256", FAKE_SECRET).update(goldenBody).digest("hex")}`);

  const feishu = formatWebhook("feishu", ALERT, options);
  assert.equal(feishu.body, JSON.stringify({ msg_type: "text", content: { text: GOLDEN_TEXT } }));
  const feishuSigned = formatWebhook("feishu", ALERT, { ...options, secret: FAKE_SECRET });
  assert.equal(feishuSigned.body, `{"timestamp":"1792051320","sign":"RK7k4CylB2HJJiHWSq14a/OzGGKgMGG2h6E4d4PQu4A=","msg_type":"text","content":{"text":${JSON.stringify(GOLDEN_TEXT)}}}`);
  assert.equal(JSON.parse(feishuSigned.body).sign, crypto.createHmac("sha256", `1792051320\n${FAKE_SECRET}`).update("").digest("base64"), "Feishu signs with the timestamp and secret as the key");

  const dingtalk = formatWebhook("dingtalk", ALERT, options);
  assert.equal(dingtalk.url, HOOK_URL);
  assert.equal(dingtalk.body, JSON.stringify({ msgtype: "text", text: { content: GOLDEN_TEXT } }));
  const dingtalkSigned = formatWebhook("dingtalk", ALERT, { ...options, secret: FAKE_SECRET });
  assert.equal(dingtalkSigned.url, "https://hooks.example.test/send?token=fake-token-0001&timestamp=1792051320000&sign=UAtp1lHfdgfBqDsImXALdM4rs71z%2BQIRlWhCou3O15Q%3D");
  assert.equal(dingtalkSigned.body, dingtalk.body);
  const expectedSign = crypto.createHmac("sha256", FAKE_SECRET).update(`1792051320000\n${FAKE_SECRET}`).digest("base64");
  assert.equal(new URL(dingtalkSigned.url).searchParams.get("sign"), expectedSign);

  const wecom = formatWebhook("wecom", ALERT, options);
  assert.equal(wecom.body, JSON.stringify({ msgtype: "text", text: { content: GOLDEN_TEXT } }));
  assert.equal(wecom.headers["x-ai-signature"], undefined);
  assert.equal(formatWebhook("wecom", ALERT, { ...options, secret: FAKE_SECRET }).headers["x-ai-signature"], "sha256=890dbcfdaa6b19257c0255159d0fa10ef4fcf3696edf8a7c42079573d8711f55");

  assert.equal(formatWebhook("slack", ALERT, options).body, JSON.stringify({ text: GOLDEN_TEXT }));
  assert.throws(() => formatWebhook("carrier-pigeon", ALERT, options), { code: "unknown_webhook_format" });
});

test("webhook payloads carry no address, key id or detail", () => {
  const alert = { ...ALERT, detail: { topIps: [{ ipMasked: "203.0.113.x", count: 3 }] }, keyId: "k_secret", clientIp: "203.0.113.7", body: "prompt text" };
  for (const format of ["generic", "feishu", "dingtalk", "wecom", "slack"]) {
    const built = formatWebhook(format, alert, { now: GOLDEN_NOW, url: HOOK_URL, secret: FAKE_SECRET });
    for (const forbidden of ["203.0.113", "k_secret", "prompt text", "topIps"]) assert.equal(built.body.includes(forbidden), false, `${format} ${forbidden}`);
  }
});

test("a resolved alert reads as resolved in every format", () => {
  const generic = JSON.parse(formatWebhook("generic", ALERT, { now: GOLDEN_NOW, event: "alert.resolved" }).body);
  assert.equal(generic.event, "alert.resolved");
  assert.match(JSON.parse(formatWebhook("slack", ALERT, { now: GOLDEN_NOW, event: "alert.resolved" }).body).text, /^\[RESOLVED\]/);
});

// --- delivery ---------------------------------------------------------------------------------------

function webhookNotifier(overrides = {}) {
  const clock = overrides.clock || fakeClock(GOLDEN_NOW);
  const records = [];
  const fetchImpl = overrides.fetch || fakeFetch([{ status: 200 }]);
  const notifier = createNotifier({
    events: overrides.events || fakeEvents(),
    webhooks: overrides.webhooks || [{ id: "ops", url: HOOK_URL, format: "generic", minSeverity: "warning" }],
    secretStore: overrides.secretStore || fakeSecrets({ "webhooks/ops": FAKE_SECRET }),
    fetch: fetchImpl,
    now: clock.now,
    lookup: overrides.lookup || noLookup,
    sleep: overrides.sleep || noSleep,
    logger: overrides.logger === undefined ? null : overrides.logger,
    record: async (event) => { records.push(event); },
    ...overrides.options,
  });
  return { notifier, clock, records, fetchImpl, events: notifier ? undefined : undefined };
}

test("a webhook is POSTed with the secret from the webhooks namespace and a valid signature", async () => {
  const secrets = fakeSecrets({ "webhooks/ops": FAKE_SECRET });
  const { notifier, fetchImpl, records } = webhookNotifier({ secretStore: secrets });
  const result = await notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  assert.equal(result.webhooks, 1);
  await notifier.idle();
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, HOOK_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal, "a timeout signal is attached");
  assert.equal(init.body, '{"version":1,"event":"alert.firing","ruleId":"gpu_temp_high","severity":"warning","scope":"gpu:0","title":"GPU 0 温度过高 / GPU 0 temperature high","value":87,"threshold":85,"since":"2026-10-15T08:00:00.000Z","at":"2026-10-15T08:02:00.000Z","link":"http://127.0.0.1:5176/#/observability/alerts?rule=gpu_temp_high"}');
  assert.equal(init.headers["x-ai-signature"], `sha256=${crypto.createHmac("sha256", FAKE_SECRET).update(init.body).digest("hex")}`);
  assert.deepEqual(secrets.calls, [["has", "webhooks", "ops"], ["get", "webhooks", "ops"]]);
  assert.equal(records.length, 0);
  assert.equal(JSON.stringify(init).includes(FAKE_SECRET), false, "the secret is never part of the request");
});

test("a webhook without a secret is sent unsigned; minSeverity filters; a resolved alert is sent too", async () => {
  const hooks = [
    { id: "open", url: "https://hooks.example.test/open", format: "generic", minSeverity: "warning" },
    { id: "critical-only", url: "https://hooks.example.test/crit", format: "generic", minSeverity: "critical" },
  ];
  const { notifier, fetchImpl } = webhookNotifier({ webhooks: hooks, secretStore: fakeSecrets() });
  await notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "resolved", channels: ["webhook"] });
  await notifier.idle();
  assert.deepEqual(fetchImpl.calls.map((call) => call.url), ["https://hooks.example.test/open", "https://hooks.example.test/open"]);
  assert.equal(fetchImpl.calls[0].init.headers["x-ai-signature"], undefined);
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).event, "alert.resolved");
});

test("an unavailable secret store skips the webhook with a notify_failed event", async () => {
  for (const flags of [{ failHas: true }, { failGet: true }]) {
    const { notifier, fetchImpl, records } = webhookNotifier({ secretStore: fakeSecrets({ "webhooks/ops": FAKE_SECRET }, flags) });
    await notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
    await notifier.idle();
    assert.equal(fetchImpl.calls.length, 0, "a webhook that needs a secret is not sent unsigned");
    assert.equal(records.length, 1);
    assert.equal(records[0].type, "alert.notify_failed");
    assert.equal(records[0].data.reason, "secret_unavailable");
    assert.equal(records[0].data.webhookId, "ops");
  }
});

test("failures retry after 1 s, 5 s and 30 s, then record alert.notify_failed without URL or secret", async () => {
  const sleeps = [];
  const logs = [];
  const { notifier, fetchImpl, records } = webhookNotifier({
    fetch: fakeFetch([{ throws: "connect ECONNREFUSED" }, { status: 503 }, { status: 502 }, { status: 500 }]),
    sleep: async (ms) => { sleeps.push(ms); },
    logger: { warn: (line) => logs.push(line) },
  });
  await notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await notifier.idle();
  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(sleeps, [1000, 5000, 30_000]);
  assert.equal(records.length, 1);
  assert.deepEqual([records[0].type, records[0].severity, records[0].data.reason, records[0].data.attempts, records[0].data.status], ["alert.notify_failed", "warning", "http_500", 4, 500]);
  assert.equal(records[0].data.host, "hooks.example.test");
  const everything = JSON.stringify([records, logs]);
  for (const secret of [FAKE_SECRET, "fake-token-0001"]) assert.equal(everything.includes(secret), false, "neither the signing secret nor the URL token is reported");
});

test("a retry that succeeds stops retrying; a 4xx and a redirect are final", async () => {
  const sleeps = [];
  const retried = webhookNotifier({ fetch: fakeFetch([{ status: 500 }, { status: 200 }]), sleep: async (ms) => { sleeps.push(ms); } });
  await retried.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await retried.notifier.idle();
  assert.equal(retried.fetchImpl.calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(retried.records.length, 0);

  for (const [step, reason] of [[{ status: 404 }, "http_404"], [{ status: 302 }, "redirect_blocked"], [{ status: 0, type: "opaqueredirect" }, "redirect_blocked"]]) {
    const run = webhookNotifier({ fetch: fakeFetch([step]) });
    await run.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
    await run.notifier.idle();
    assert.equal(run.fetchImpl.calls.length, 1, `${reason} is not retried`);
    assert.equal(run.records[0].data.reason, reason);
  }
});

test("a timeout is retried and reported as a timeout", async () => {
  const run = webhookNotifier({ fetch: fakeFetch([{ throws: "aborted", name: "TimeoutError" }]) });
  await run.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await run.notifier.idle();
  assert.equal(run.fetchImpl.calls.length, 4);
  assert.equal(run.records[0].data.reason, "timeout");
});

// --- SSRF -----------------------------------------------------------------------------------------------

test("the SSRF guard rejects userinfo, link-local, loopback and non-http URLs", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    "http://169.254.0.1:8080/x",
    "http://[fe80::1]/x",
    "http://[febf::1]/x",
    "http://[::ffff:169.254.169.254]/x",
    "http://2852039166/x",
    "http://0xa9fea9fe/x",
    "http://127.0.0.1:8080/x",
    "http://127.1.2.3/x",
    "http://localhost/x",
    "http://LOCALHOST./x",
    "http://api.localhost/x",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://0.0.0.0/x",
    "https://user:pass@hooks.example.test/x",
    "https://user@hooks.example.test/x",
    "ftp://hooks.example.test/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    assert.throws(() => assertSafeWebhookUrl(url), { code: "unsafe_webhook_url" }, url);
  }
  for (const url of ["https://hooks.example.test/x", "http://hooks.example.test:8080/x?token=1", "https://203.0.113.9/x", "http://10.0.0.8/x", "https://[2001:db8::1]/x"]) {
    assert.ok(assertSafeWebhookUrl(url), url);
  }
  // Loopback is allowed only on request; link-local never is.
  assert.ok(assertSafeWebhookUrl("http://127.0.0.1:8080/x", { allowLoopback: true }));
  assert.ok(assertSafeWebhookUrl("http://localhost:8080/x", { allowLoopback: true }));
  assert.throws(() => assertSafeWebhookUrl("http://169.254.169.254/", { allowLoopback: true }), { code: "unsafe_webhook_url" });
  assert.throws(() => assertSafeWebhookUrl("http://[fe80::1]/", { allowLoopback: true }), { code: "unsafe_webhook_url" });
  // The message does not repeat the URL (it can carry a token).
  try {
    assertSafeWebhookUrl("http://169.254.169.254/?token=fake-token-0001");
  } catch (error) {
    assert.equal(error.message.includes("fake-token"), false);
  }
});

test("the guard is enforced at delivery: an unsafe URL is never fetched, and a name that resolves to link-local is refused", async () => {
  const unsafeHook = webhookNotifier({ webhooks: [{ id: "ops", url: "http://169.254.169.254/latest", format: "generic", minSeverity: "info" }] });
  await unsafeHook.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await unsafeHook.notifier.idle();
  assert.equal(unsafeHook.fetchImpl.calls.length, 0);
  assert.equal(unsafeHook.records[0].data.reason, "unsafe_url");

  const rebinding = webhookNotifier({ lookup: async () => [{ address: "169.254.169.254", family: 4 }] });
  await rebinding.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await rebinding.notifier.idle();
  assert.equal(rebinding.fetchImpl.calls.length, 0);
  assert.equal(rebinding.records[0].data.reason, "unsafe_url");

  const loopbackName = webhookNotifier({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  await loopbackName.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await loopbackName.notifier.idle();
  assert.equal(loopbackName.fetchImpl.calls.length, 0, "a hostname that resolves to loopback is refused too");

  const allowed = webhookNotifier({ webhooks: [{ id: "ops", url: "http://127.0.0.1:9/x", format: "generic", minSeverity: "info" }], options: { allowLoopback: true } });
  await allowed.notifier.notify({ ...ALERT, at: GOLDEN_NOW }, { action: "firing", channels: ["webhook"] });
  await allowed.notifier.idle();
  assert.equal(allowed.fetchImpl.calls.length, 1, "allowLoopback is honoured");
});

// --- publishing, the cap and the test button ----------------------------------------------------------------

test("publishing uses only events.publish(alerts | notification)", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 3 };
  const { engine, clock, events, notifier } = rig(t, store, { sources: downSource(state), webhooks: [{ id: "ops", url: HOOK_URL, format: "generic", minSeverity: "info" }] });
  await engine.updateRule("instance_down", { forS: 0 });
  await engine.tick();
  await engine.ack("instance_down", "fleet:vllm:primary");
  state.failures = 0;
  clock.advance(15_000);
  await engine.tick();
  await notifier.test({ channel: "inapp" });
  await notifier.test({ channel: "toast" });
  await notifier.idle();
  assert.ok(events.published.length >= 5);
  assert.deepEqual([...new Set(events.published.map((item) => item.type))].sort(), ["alerts", "notification"]);
  for (const note of events.ofType("notification")) {
    assert.ok(Array.isArray(note.channels) && note.channels.length >= 1 && note.channels.every((channel) => ["inapp", "toast"].includes(channel)), JSON.stringify(note.channels));
    assert.ok(typeof note.dedupeKey === "string" && note.dedupeKey.length > 0);
    assert.ok(note.kind && note.severity && note.title.zh && note.title.en, "the 00 section 9.6 envelope");
    assert.ok(note.action.href.startsWith("/"), "same-origin link");
  }
  assert.deepEqual(events.ofType("alerts").map((item) => item.action), ["firing", "acked", "resolved"]);
});

test("a rule without the inapp channel publishes no alerts event; toast alone sends a toast notification", async (t) => {
  const { store } = await openStore(t);
  const state = { failures: 3 };
  const { engine, events } = rig(t, store, { sources: downSource(state) });
  await engine.updateRule("instance_down", { forS: 0, channels: ["toast"] });
  await engine.tick();
  assert.equal(events.ofType("alerts").length, 0);
  assert.deepEqual(events.ofType("notification").map((item) => item.channels), [["toast"]]);
});

test("at most 20 notifications an hour per channel; the rest become one summary", async () => {
  const clock = fakeClock(GOLDEN_NOW);
  const events = fakeEvents();
  const { notifier } = webhookNotifier({ events, clock, webhooks: [] });
  const send = (index) => notifier.notify({ ...ALERT, scopeKey: `gpu:${index}`, at: clock.t, firedAt: clock.t }, { action: "firing", channels: ["inapp"] });
  for (let index = 0; index < 20; index += 1) {
    clock.advance(1000);
    await send(index);
  }
  assert.equal(events.ofType("notification").length, 20);
  for (let index = 20; index < 25; index += 1) {
    clock.advance(1000);
    const result = await send(index);
    assert.equal(result.inapp, false, "over the cap");
  }
  assert.equal(events.ofType("notification").length, 20);
  assert.equal(events.ofType("alerts").length, 25, "the state stream is not rate limited");
  await notifier.flush();
  assert.equal(events.ofType("notification").length, 20, "no room yet: the summary waits");

  clock.advance(HOUR_AFTER());
  await notifier.flush();
  const notes = events.ofType("notification");
  assert.equal(notes.length, 21);
  assert.equal(notes.at(-1).kind, "alert.summary");
  assert.deepEqual(notes.at(-1).channels, ["inapp"]);
  assert.match(notes.at(-1).title.en, /^5 alert notifications were combined$/);
  await notifier.flush();
  assert.equal(events.ofType("notification").length, 21, "one summary per batch");
});

function HOUR_AFTER() {
  return 3600_000;
}

test("the cap is counted per webhook; tests do not count", async () => {
  const clock = fakeClock(GOLDEN_NOW);
  const run = webhookNotifier({ clock, secretStore: fakeSecrets() });
  for (let index = 0; index < 22; index += 1) {
    clock.advance(1000);
    await run.notifier.notify({ ...ALERT, at: clock.t }, { action: "firing", channels: ["webhook"] });
  }
  await run.notifier.idle();
  assert.equal(run.fetchImpl.calls.length, 20);
  const outcome = await run.notifier.test({ channel: "webhook", webhookId: "ops" });
  assert.deepEqual(outcome, { ok: true, delivered: true });
  assert.equal(JSON.parse(run.fetchImpl.calls.at(-1).init.body).event, "alert.test");
  clock.advance(3600_000);
  await run.notifier.flush();
  await run.notifier.idle();
  const summary = JSON.parse(run.fetchImpl.calls.at(-1).init.body);
  assert.equal(summary.event, "alert.summary");
  assert.match(summary.title, /2 alert notifications were combined/);
});

test("toastChannel is available only while the supervisor principal is subscribed", () => {
  const events = fakeEvents();
  const { notifier } = webhookNotifier({ events });
  assert.equal(notifier.toastChannel(), "no_subscriber");
  events.supervisors = 1;
  assert.equal(notifier.toastChannel(), "available");
  const asked = [];
  const spy = { ...events, subscriberCount: (options) => { asked.push(options); return events.subscriberCount(options); } };
  createNotifier({ events: spy, logger: null }).toastChannel();
  assert.deepEqual(asked, [{ principal: "system:supervisor", types: ["notification"] }], "counted by principal, never by a client-supplied label");
  assert.equal(createNotifier({ logger: null }).toastChannel(), "no_subscriber");
});

test("the test notification reports delivery per channel", async () => {
  const events = fakeEvents();
  const run = webhookNotifier({ events });
  assert.deepEqual(await run.notifier.test({ channel: "inapp" }), { ok: true, delivered: true });
  assert.deepEqual(await run.notifier.test({ channel: "toast" }), { ok: true, delivered: false, error: "no_subscriber" });
  events.supervisors = 1;
  assert.deepEqual(await run.notifier.test({ channel: "toast" }), { ok: true, delivered: true });
  assert.deepEqual(events.ofType("notification").map((item) => [item.kind, item.channels]), [["alert.test", ["inapp"]], ["alert.test", ["toast"]], ["alert.test", ["toast"]]]);
  assert.deepEqual(await run.notifier.test({ channel: "webhook", webhookId: "nope" }), { ok: false, delivered: false, error: "webhook_not_found" });
  assert.deepEqual(await run.notifier.test({ channel: "pager" }), { ok: false, delivered: false, error: "unknown_channel" });
  const failing = webhookNotifier({ fetch: fakeFetch([{ status: 404 }]) });
  assert.deepEqual(await failing.notifier.test({ channel: "webhook", webhookId: "ops" }), { ok: false, delivered: false, error: "http_404" });
});

test("the notification text follows the 00 envelope and carries no secret", async () => {
  const events = fakeEvents();
  const run = webhookNotifier({ events, webhooks: [] });
  await run.notifier.notify({ ...ALERT, at: GOLDEN_NOW, firedAt: GOLDEN_NOW }, { action: "firing", channels: ["inapp", "toast"] });
  const [note] = events.ofType("notification");
  assert.deepEqual(note, {
    kind: "alert.firing",
    severity: "warn",
    title: { zh: "GPU 0 温度过高", en: "GPU 0 temperature high" },
    body: { zh: "当前值 87，阈值 85。", en: "Value 87, threshold 85." },
    action: { label: { zh: "查看告警", en: "View alert" }, href: "/#/observability/alerts?rule=gpu_temp_high" },
    channels: ["inapp", "toast"],
    dedupeKey: `alert:gpu_temp_high:gpu:0:firing:${GOLDEN_NOW}`,
  });
});
