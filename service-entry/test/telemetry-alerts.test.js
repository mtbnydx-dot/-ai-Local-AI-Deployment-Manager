"use strict";

// The alert API of 04 section 13.4 (TEL-13) through the real entry: the 05
// guard, the viewer registry and the event bus. The engine and notifier run on
// an in-process telemetry store in a temp folder with a fake secret store and a
// fake fetch, so nothing leaves the process and no real secret is read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openTelemetryStore } = require("../../manager-core/telemetry/store");
const { createAlertEngine } = require("../../manager-core/telemetry/alerts");
const { createNotifier } = require("../../manager-core/telemetry/notify");
const internalAuth = require("../../manager-core/internal-auth");
const telemetryRoutes = require("../lib/telemetry-routes");
const harness = require("./helpers/entry-harness");
const { loadEntry, ownerSession, quietLogger, serveEntry } = harness;

const LAN = "192.168.1.50";
const FAKE_SECRET = "fake-signing-secret-0001";
const HOOK_URL = "https://hooks.example.test/send?token=fake-token-0001";

const owners = new Map();
function request(port, pathname, options = {}) {
  const owner = options.owner || (options.peer ? undefined : owners.get(port));
  return harness.request(port, pathname, { ...options, owner });
}

function fakeSecrets(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async has(ns, key) { return map.has(`${ns}/${key}`); },
    async get(ns, key) { return map.get(`${ns}/${key}`) || ""; },
    async set(ns, key, value) { map.set(`${ns}/${key}`, value); },
    async clear(ns, key) { map.delete(`${ns}/${key}`); },
  };
}

function fakeFetch(status = 200) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    return { status, type: "basic", body: null };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function startAlerts(t, { webhooks = [], secrets = fakeSecrets({ "webhooks/ops": FAKE_SECRET }), fetchImpl = fakeFetch() } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-alerts-routes-"));
  const root = path.join(base, "ai-root");
  fs.mkdirSync(root, { recursive: true });
  const store = await openTelemetryStore({ file: path.join(base, "db", "telemetry.sqlite"), inProcess: true, logger: null });
  const { entry } = await loadEntry();
  const logger = quietLogger();
  const ctx = entry.createRouteContext({
    logger,
    aiRoot: root,
    rootDir: path.join(root, "service-entry"),
    managers: [{ id: "vllm", port: 1 }, { id: "llama", port: 2 }],
    telemetry: { store },
  });
  const configChanges = [];
  ctx.telemetry.recordConfigChange = (section, change, extra) => { configChanges.push({ section, change, extra }); };
  const state = { failures: 3 };
  const notifier = createNotifier({
    events: ctx.bus,
    webhooks,
    secretStore: secrets,
    fetch: fetchImpl,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    sleep: async () => {},
    logger: null,
    record: (event) => store.insertEvents([event]),
  });
  const engine = createAlertEngine({
    store,
    notify: notifier,
    sources: { instances: () => [{ fleetId: "vllm:primary", expectedReady: true, lifecycleState: "ready", failures: state.failures }] },
    logger: null,
  });
  ctx.telemetry.alerts = engine;
  const routes = await entry.mountRouteModules({ ctx });
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  owners.set(port, await ownerSession(entry, port));
  t.after(async () => {
    await engine.stop();
    await notifier.close();
    routes.close();
    await store.close({ flushMs: 0 });
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const published = [];
  ctx.bus.subscribe((envelope) => published.push(envelope), { types: ["alerts", "notification"] });
  return { entry, ctx, engine, notifier, store, port, logger, state, published, configChanges, secrets, fetchImpl };
}

async function fireInstanceDown(rig) {
  await rig.engine.updateRule("instance_down", { forS: 0 });
  await rig.engine.tick();
}

// --- reads -------------------------------------------------------------------------

test("GET alert-rules lists the seeded rules and the metric catalog; GET alerts is empty at first", async (t) => {
  const rig = await startAlerts(t);
  await rig.engine.ready();
  const rules = await request(rig.port, "/api/telemetry/alert-rules");
  assert.equal(rules.status, 200);
  assert.equal(rules.json.ok, true);
  assert.equal(rules.json.rules.length, 16);
  assert.equal(rules.json.toastChannel, "no_subscriber");
  const hot = rules.json.rules.find((rule) => rule.ruleId === "gpu_temp_high");
  assert.deepEqual(
    [hot.builtin, hot.enabled, hot.metric, hot.op, hot.threshold, hot.forS, hot.windowS, hot.severity, hot.channels],
    [true, true, "gpu.temp_c", ">", 85, 120, 60, "warning", ["inapp", "toast"]],
  );
  assert.equal(typeof hot.titleZh, "string");
  assert.ok(rules.json.metrics.length >= 16);
  assert.deepEqual(Object.keys(rules.json.metrics[0]).sort(), ["filters", "id", "label", "scopes", "unit"]);
  assert.ok(rules.json.metrics.every((metric) => metric.label.zh && metric.label.en));

  const none = await request(rig.port, "/api/telemetry/alerts");
  assert.equal(none.status, 200);
  assert.deepEqual(none.json.rows, []);
});

test("GET alerts returns the documented row shape for firing, and all includes pending ones", async (t) => {
  const rig = await startAlerts(t);
  await fireInstanceDown(rig);
  const firing = await request(rig.port, "/api/telemetry/alerts?state=firing&limit=10");
  assert.equal(firing.status, 200);
  assert.equal(firing.json.rows.length, 1);
  const [row] = firing.json.rows;
  assert.deepEqual(Object.keys(row).sort(), ["ackedAt", "firedAt", "resolvedAt", "ruleId", "scopeKey", "severity", "silencedUntil", "since", "state", "threshold", "title", "value"]);
  assert.deepEqual([row.ruleId, row.scopeKey, row.state, row.severity, row.value, row.threshold], ["instance_down", "fleet:vllm:primary", "firing", "critical", 1, 1]);
  assert.deepEqual(row.title, { zh: "实例 vllm:primary 无响应", en: "Instance vllm:primary is down" });
  assert.match(row.since, /^\d{4}-\d\d-\d\dT/);
  assert.equal(row.ackedAt, null);
  assert.equal(row.silencedUntil, null);

  // The live strip counts what the engine wrote.
  assert.deepEqual((await request(rig.port, "/api/telemetry/live")).json.alerts, { firing: 1, critical: 1 });

  rig.state.failures = 0;
  await rig.engine.tick();
  assert.deepEqual((await request(rig.port, "/api/telemetry/alerts")).json.rows, []);
  assert.deepEqual((await request(rig.port, "/api/telemetry/live")).json.alerts, { firing: 0, critical: 0 });
  const all = await request(rig.port, "/api/telemetry/alerts?state=all");
  assert.deepEqual(all.json.rows.map((item) => item.state), ["ok"]);
});

test("alert list parameters are validated", async (t) => {
  const rig = await startAlerts(t);
  for (const target of [
    "/api/telemetry/alerts?state=pending",
    "/api/telemetry/alerts?limit=0",
    "/api/telemetry/alerts?limit=501",
    "/api/telemetry/alerts?limit=abc",
    "/api/telemetry/alerts?bogus=1",
    "/api/telemetry/alerts?state=all&state=firing",
    "/api/telemetry/alert-rules?x=1",
  ]) {
    const response = await request(rig.port, target);
    assert.equal(response.status, 400, target);
    assert.equal(response.json.ok, false);
    assert.ok(response.json.error.code, target);
  }
  assert.equal((await request(rig.port, "/api/telemetry/alerts?state=pending")).json.error.code, "invalid_value");
  assert.equal((await request(rig.port, "/api/telemetry/alerts?bogus=1")).json.error.code, "unknown_parameter");
});

// --- writes ----------------------------------------------------------------------------

test("a custom rule is created (201), edited, listed and deleted; every write is recorded as config.alerts", async (t) => {
  const rig = await startAlerts(t);
  const body = { metric: "gpu.temp_c", scope: { gpu: 1 }, op: ">", threshold: 70, windowS: 60, forS: 30, severity: "info", channels: ["inapp"], titleZh: "GPU {id} 偏热", titleEn: "GPU {id} warm" };
  const created = await request(rig.port, "/api/telemetry/alert-rules", { method: "POST", body });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.ok, true);
  const { rule } = created.json;
  assert.match(rule.ruleId, /^custom_[0-9a-f]{10}$/);
  assert.equal(rule.builtin, false);
  assert.deepEqual([rule.metric, rule.scope, rule.threshold, rule.minSamples, rule.cooldownS], ["gpu.temp_c", { gpu: 1 }, 70, 0, 1800]);

  const updated = await request(rig.port, `/api/telemetry/alert-rules/${rule.ruleId}`, { method: "PUT", body: { threshold: 75, channels: ["inapp", "toast"] } });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.json.rule.threshold, updated.json.rule.channels], [75, ["inapp", "toast"]]);

  const listed = await request(rig.port, "/api/telemetry/alert-rules");
  assert.equal(listed.json.rules.length, 17);

  const deleted = await request(rig.port, `/api/telemetry/alert-rules/${rule.ruleId}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal((await request(rig.port, "/api/telemetry/alert-rules")).json.rules.length, 16);
  assert.equal((await request(rig.port, `/api/telemetry/alert-rules/${rule.ruleId}`, { method: "DELETE" })).status, 404);

  assert.ok(rig.configChanges.length >= 3);
  assert.ok(rig.configChanges.every((item) => item.section === "alerts" && item.extra.actor === "owner"));
  const keys = rig.configChanges.flatMap((item) => item.change.changed);
  assert.ok(keys.includes(`${rule.ruleId}.created`));
  assert.ok(keys.includes(`${rule.ruleId}.threshold`));
  assert.ok(keys.includes(`${rule.ruleId}.deleted`));
});

test("a bad rule is 400 with errors[], and a builtin rule accepts only its editable fields", async (t) => {
  const rig = await startAlerts(t);
  await rig.engine.ready();
  const bad = await request(rig.port, "/api/telemetry/alert-rules", { method: "POST", body: { metric: "sql.anything", op: "==", threshold: "x", windowS: 1, forS: 0, severity: "fatal", channels: ["sms"], titleZh: "", titleEn: "t" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.error.code, "invalid_request");
  const fields = bad.json.errors.map((item) => item.field).sort();
  assert.deepEqual(fields, ["channels", "metric", "op", "severity", "threshold", "titleZh", "windowS"]);
  assert.ok(bad.json.errors.every((item) => item.code && item.message));
  assert.equal((await request(rig.port, "/api/telemetry/alert-rules")).json.rules.length, 16, "nothing was saved");

  const notEditable = await request(rig.port, "/api/telemetry/alert-rules/gpu_temp_high", { method: "PUT", body: { metric: "rt.waiting", titleEn: "renamed" } });
  assert.equal(notEditable.status, 400);
  assert.deepEqual(notEditable.json.errors.map((item) => [item.field, item.code]), [["metric", "not_editable"], ["titleEn", "not_editable"]]);

  const editable = await request(rig.port, "/api/telemetry/alert-rules/gpu_temp_high", { method: "PUT", body: { enabled: false, threshold: 80, clearThreshold: 78, forS: 60, windowS: 30, severity: "critical", channels: ["inapp"], cooldownS: 900 } });
  assert.equal(editable.status, 200, editable.text);
  const rule = editable.json.rule;
  assert.deepEqual([rule.enabled, rule.threshold, rule.clearThreshold, rule.forS, rule.windowS, rule.severity, rule.channels, rule.cooldownS, rule.builtin], [false, 80, 78, 60, 30, "critical", ["inapp"], 900, true]);

  assert.equal((await request(rig.port, "/api/telemetry/alert-rules/no_such_rule", { method: "PUT", body: { threshold: 1 } })).status, 404);
  const torn = await request(rig.port, "/api/telemetry/alert-rules", { method: "POST", body: "{ nope" });
  assert.equal(torn.status, 400);
  assert.equal(torn.json.error.code, "invalid_json");
});

test("deleting a builtin rule is 409 builtin_rule", async (t) => {
  const rig = await startAlerts(t);
  await rig.engine.ready();
  const response = await request(rig.port, "/api/telemetry/alert-rules/gpu_temp_high", { method: "DELETE" });
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, "builtin_rule");
  assert.equal(response.json.ok, false);
  assert.equal((await request(rig.port, "/api/telemetry/alert-rules")).json.rules.length, 16);
});

test("ack and silence return {ok, state}; ack needs a firing alert", async (t) => {
  const rig = await startAlerts(t);
  await fireInstanceDown(rig);
  const target = "/api/telemetry/alerts/instance_down";
  const scopeKey = "fleet:vllm:primary";

  const acked = await request(rig.port, `${target}/ack`, { method: "POST", body: { scopeKey } });
  assert.equal(acked.status, 200, acked.text);
  assert.deepEqual([acked.json.ok, acked.json.state], [true, "firing"]);
  assert.ok(acked.json.ackedAt);
  assert.ok((await request(rig.port, "/api/telemetry/alerts")).json.rows[0].ackedAt);

  const until = new Date(Date.now() + 3600_000).toISOString();
  const silenced = await request(rig.port, `${target}/silence`, { method: "POST", body: { scopeKey, until } });
  assert.equal(silenced.status, 200, silenced.text);
  assert.deepEqual([silenced.json.ok, silenced.json.state, silenced.json.silencedUntil], [true, "firing", until]);
  assert.equal((await request(rig.port, "/api/telemetry/alerts")).json.rows[0].silencedUntil, until);

  assert.equal((await request(rig.port, `${target}/silence`, { method: "POST", body: { scopeKey, until: "2001-01-01T00:00:00Z" } })).status, 400);
  assert.equal((await request(rig.port, `${target}/silence`, { method: "POST", body: { scopeKey, until: true } })).status, 400);
  assert.equal((await request(rig.port, `${target}/silence`, { method: "POST", body: { scopeKey, until: null } })).json.silencedUntil, null);
  assert.equal((await request(rig.port, `${target}/ack`, { method: "POST", body: { scopeKey: "fleet:nope" } })).status, 404);
  assert.equal((await request(rig.port, `${target}/ack`, { method: "POST", body: { scopeKey: "bad key" } })).status, 400);

  rig.state.failures = 0;
  await rig.engine.tick();
  rig.state.failures = 3;
  await rig.engine.updateRule("instance_down", { forS: 60 });
  await rig.engine.tick();
  const pendingAck = await request(rig.port, `${target}/ack`, { method: "POST", body: { scopeKey } });
  assert.equal(pendingAck.status, 409);
  assert.equal(pendingAck.json.error.code, "not_firing");
});

test("the in-app events reach the bus: alerts firing, acked and resolved, and a notification with channels and dedupeKey", async (t) => {
  const rig = await startAlerts(t);
  await fireInstanceDown(rig);
  await request(rig.port, "/api/telemetry/alerts/instance_down/ack", { method: "POST", body: { scopeKey: "fleet:vllm:primary" } });
  rig.state.failures = 0;
  await rig.engine.tick();
  const alerts = rig.published.filter((item) => item.type === "alerts");
  assert.deepEqual(alerts.map((item) => item.data.action), ["firing", "acked", "resolved"]);
  assert.equal(alerts[0].data.alert.ruleId, "instance_down");
  assert.equal(alerts[0].source, "telemetry");
  const notes = rig.published.filter((item) => item.type === "notification");
  assert.equal(notes.length, 2, "firing and resolved; an ack is not a notification");
  assert.deepEqual(notes[0].data.channels, ["inapp", "toast"]);
  assert.match(notes[0].data.dedupeKey, /^alert:instance_down:/);
  assert.equal(notes[0].data.severity, "error");
  assert.equal(notes[1].data.severity, "success");
});

// --- the test button --------------------------------------------------------------------

test("POST alerts/test: inapp, toast and webhook; the secret comes from the webhooks namespace and never into a response", async (t) => {
  const rig = await startAlerts(t, { webhooks: [{ id: "ops", url: HOOK_URL, format: "generic", minSeverity: "warning" }] });
  await rig.engine.ready();
  const post = (body) => request(rig.port, "/api/telemetry/alerts/test", { method: "POST", body });

  const inapp = await post({ channel: "inapp" });
  assert.deepEqual(inapp.json, { ok: true, delivered: true });
  assert.equal(rig.published.at(-1).type, "notification");
  assert.deepEqual(rig.published.at(-1).data.channels, ["inapp"]);

  const toast = await post({ channel: "toast" });
  assert.deepEqual(toast.json, { ok: true, delivered: false, error: "no_subscriber" });

  const webhook = await post({ channel: "webhook", webhookId: "ops" });
  assert.deepEqual(webhook.json, { ok: true, delivered: true });
  assert.equal(rig.fetchImpl.calls.length, 1);
  const sent = JSON.parse(rig.fetchImpl.calls[0].init.body);
  assert.equal(sent.event, "alert.test");
  assert.match(rig.fetchImpl.calls[0].init.headers["x-ai-signature"], /^sha256=[0-9a-f]{64}$/);
  for (const response of [inapp, toast, webhook]) assert.equal(response.text.includes(FAKE_SECRET), false);
  assert.equal(JSON.stringify(rig.published).includes(FAKE_SECRET), false);
  assert.equal(rig.logger.lines.join("\n").includes(FAKE_SECRET), false);

  assert.equal((await post({ channel: "webhook", webhookId: "nope" })).status, 404);
  assert.equal((await post({ channel: "webhook" })).status, 400);
  assert.equal((await post({ channel: "pager" })).status, 400);
  assert.equal((await post({ channel: "inapp", extra: 1 })).status, 400);
  assert.equal((await post({})).status, 400);
});

test("a failing webhook reports the failure without the secret or the URL token", async (t) => {
  const rig = await startAlerts(t, { webhooks: [{ id: "ops", url: HOOK_URL, format: "generic", minSeverity: "warning" }], fetchImpl: fakeFetch(404) });
  await rig.engine.ready();
  const response = await request(rig.port, "/api/telemetry/alerts/test", { method: "POST", body: { channel: "webhook", webhookId: "ops" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: false, delivered: false, error: "http_404" });
  const rows = await rig.store.call("listEvents", { from: 0, to: Date.now() + 1000, types: ["alert.notify_failed"], limit: 10 }).catch(() => null);
  const everything = JSON.stringify([response.json, rows, rig.logger.lines]);
  assert.equal(everything.includes(FAKE_SECRET), false);
  assert.equal(everything.includes("fake-token-0001"), false);
});

// --- access ----------------------------------------------------------------------------------

test("a viewer reads redacted alerts and rules and cannot write; the writes are declared admin-only", async (t) => {
  const rig = await startAlerts(t);
  await fireInstanceDown(rig);
  const viewerRules = await request(rig.port, "/api/telemetry/alert-rules", { peer: LAN });
  assert.equal(viewerRules.status, 200);
  assert.equal(viewerRules.json.rules.length, 16);
  assert.equal(JSON.stringify(viewerRules.json).includes('"channels"'), false, "rule channels are owner-only");
  assert.equal(viewerRules.json.rules[0].ruleId.length > 0, true);
  const viewerAlerts = await request(rig.port, "/api/telemetry/alerts", { peer: LAN });
  assert.equal(viewerAlerts.status, 200);
  assert.equal(viewerAlerts.json.rows.length, 1);
  assert.equal(viewerAlerts.json.rows[0].title.en, "Instance vllm:primary is down");

  const writes = [
    ["POST", "/api/telemetry/alert-rules", { metric: "rt.waiting" }],
    ["PUT", "/api/telemetry/alert-rules/gpu_temp_high", { threshold: 1 }],
    ["DELETE", "/api/telemetry/alert-rules/gpu_temp_high", undefined],
    ["POST", "/api/telemetry/alerts/instance_down/ack", { scopeKey: "fleet:vllm:primary" }],
    ["POST", "/api/telemetry/alerts/instance_down/silence", { scopeKey: "fleet:vllm:primary", until: null }],
    ["POST", "/api/telemetry/alerts/test", { channel: "inapp" }],
  ];
  for (const peer of [LAN, undefined]) {
    for (const [method, target, body] of writes) {
      // Loopback without the owner session is a viewer since PUB-5.
      const response = await harness.request(rig.port, target, { method, ...(peer ? { peer } : {}), ...(body ? { body } : {}) });
      assert.ok([401, 403].includes(response.status), `${method} ${target} ${peer || "loopback"} answered ${response.status}`);
    }
  }
  assert.equal((await rig.engine.listRules()).find((rule) => rule.ruleId === "gpu_temp_high").threshold, 85);
  assert.equal((await rig.engine.listAlerts({ state: "firing" }))[0].ackedAt, null);

  const registry = rig.ctx.auth.viewerRegistry;
  for (const [method, target] of [
    ["POST", "/api/telemetry/alert-rules"],
    ["PUT", "/api/telemetry/alert-rules/gpu_temp_high"],
    ["DELETE", "/api/telemetry/alert-rules/gpu_temp_high"],
    ["POST", "/api/telemetry/alerts/test"],
    ["POST", "/api/telemetry/alerts/instance_down/ack"],
    ["POST", "/api/telemetry/alerts/instance_down/silence"],
  ]) {
    assert.equal(registry.match(method, target).access, "admin", `${method} ${target}`);
  }
  for (const target of ["/api/telemetry/alerts", "/api/telemetry/alert-rules"]) assert.equal(registry.match("GET", target).access, "viewer", target);
  assert.ok(telemetryRoutes.TELEMETRY_ADMIN_ONLY_ROUTES.length >= 8);
});

test("methods the alert paths do not serve answer 405", async (t) => {
  const rig = await startAlerts(t);
  assert.equal((await request(rig.port, "/api/telemetry/alerts", { method: "POST", body: {} })).status, 405);
  assert.equal((await request(rig.port, "/api/telemetry/alert-rules", { method: "DELETE" })).status, 405);
  assert.equal((await request(rig.port, "/api/telemetry/alert-rules/gpu_temp_high")).status, 405);
  assert.equal((await request(rig.port, "/api/telemetry/alerts/test")).status, 405);
  assert.equal((await request(rig.port, "/api/telemetry/alerts/instance_down/ack")).status, 405);
  assert.equal((await request(rig.port, "/api/telemetry/alerts/Bad-Id/ack", { method: "POST", body: {} })).status, 404, "an unknown path falls through");
});

test("without an engine the reads answer an empty, degraded body and the writes 503", async (t) => {
  const rig = await startAlerts(t);
  rig.ctx.telemetry.alerts = null;
  const rules = await request(rig.port, "/api/telemetry/alert-rules");
  assert.deepEqual([rules.status, rules.json.rules, rules.json.degraded, rules.json.toastChannel], [200, [], true, "no_subscriber"]);
  assert.deepEqual((await request(rig.port, "/api/telemetry/alerts")).json.rows, []);
  const write = await request(rig.port, "/api/telemetry/alert-rules", { method: "POST", body: {} });
  assert.equal(write.status, 503);
  assert.equal(write.json.error.code, "telemetry_unavailable");
});

// --- toastChannel -----------------------------------------------------------------------------

function openStream(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = http.get({ host: "127.0.0.1", port, path: pathname, headers: { host: "127.0.0.1:5176", ...headers }, agent: false }, (response) => {
      const stream = { status: response.statusCode, close: () => { call.destroy(); response.destroy(); } };
      response.on("error", () => {});
      if (response.statusCode !== 200) {
        response.resume();
        response.on("end", () => resolve(stream));
        return;
      }
      // Wait for the first bytes ("retry: 3000") so the client is registered.
      response.once("data", () => resolve(stream));
    });
    call.on("error", reject);
  });
}

test("toastChannel is available only for an authenticated system:supervisor stream", async (t) => {
  const rig = await startAlerts(t);
  await rig.engine.ready();
  const toast = async () => (await request(rig.port, "/api/telemetry/alerts")).json.toastChannel;
  assert.equal(await toast(), "no_subscriber");

  // An owner console stream and an unauthenticated viewer stream, even one that
  // claims the supervisor's client label, are not the supervisor.
  const owner = owners.get(rig.port);
  const streams = [];
  t.after(() => streams.forEach((stream) => stream.close()));
  streams.push(await openStream(rig.port, "/api/events?client=supervisor", owner.headers("GET")));
  streams.push(await openStream(rig.port, "/api/events?client=supervisor"));
  assert.equal(await toast(), "no_subscriber");

  // A bare principal marker, or a signature made with the wrong token, is nobody.
  const forged = await openStream(rig.port, "/api/events?client=supervisor", { "x-ai-internal-principal": "system:supervisor" });
  streams.push(forged);
  assert.notEqual(forged.status, 200);
  const wrongToken = await openStream(rig.port, "/api/events?client=supervisor", internalAuth.buildMachineHeaders("not-the-entry-token-0123456789", {
    method: "GET", pathWithQuery: "/api/events?client=supervisor", principal: "system:supervisor", body: "", now: Date.now(),
  }));
  streams.push(wrongToken);
  assert.notEqual(wrongToken.status, 200);
  assert.equal(await toast(), "no_subscriber");

  // The real thing: a request signed with the entry trust token.
  const token = rig.entry.security.getTrustToken();
  const supervisor = await openStream(rig.port, "/api/events?client=supervisor", internalAuth.buildMachineHeaders(token, {
    method: "GET", pathWithQuery: "/api/events?client=supervisor", principal: "system:supervisor", body: "", now: Date.now(),
  }));
  streams.push(supervisor);
  assert.equal(supervisor.status, 200);
  assert.equal(await toast(), "available");
  const test = await request(rig.port, "/api/telemetry/alerts/test", { method: "POST", body: { channel: "toast" } });
  assert.deepEqual(test.json, { ok: true, delivered: true });

  supervisor.close();
  for (let attempt = 0; attempt < 50 && (await toast()) === "available"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await toast(), "no_subscriber", "closing the stream ends the subscription");
});
