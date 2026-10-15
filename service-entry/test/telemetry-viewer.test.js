"use strict";

// The viewer redactions of the telemetry API (docs/overhaul/04-telemetry.md
// §11.8, TEL-11). Each function runs on a full owner-grade fixture, and
// nothing that names an address, a key, a customer, a request, a channel or a
// billing figure may survive. The registry cases mirror 05's coverage test:
// every 04 GET route is either registered with its redaction or owner-only.

const assert = require("node:assert/strict");
const test = require("node:test");

const { createViewerRegistry } = require("../lib/viewer-allowlist");
const { AUDIT_ROUTES } = require("../lib/audit-http");
const { registerTelemetryRoutes } = require("../lib/telemetry-routes");
const viewer = require("../lib/telemetry-viewer");

// Strings that must never reach a viewer.
const SECRETS = [
  "192.0.2.10", "198.51.100.7", "203.0.113.9", "k_owner_key", "key_abc123", "cust_acme", "Acme Co",
  "req_aaaaaaaaaaaaaaaaaaaa", "mgr_bbbbbbbbbbbbbbbbbbbb", "client-req-1", "chat_9", "1234000", "hook-secret-id",
  "https://hooks.example.test/T0K3N", "webhook-signing-secret", "/srv/ai/logs", "C:\\\\ai\\\\data", "usr_internal",
];

function assertNoLeak(value, label) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label} leaks ${secret}`);
}

const LIVE = {
  ok: true,
  at: "2026-10-14T08:00:05.000Z",
  windowSeconds: 60,
  gateway: { inflight: 2, requestsPerMin: 14, outputTokensPerSec: 85.2, errorRate5m: 0.02, ttftP95Ms5m: 640, clientAborts5m: 1, clientIps: ["192.0.2.10"] },
  instances: [{ fleetId: "vllm:primary", engineId: "sglang", model: "qwen3.8-flash", state: "ready", idle: false, running: 1, waiting: 0, kvUsage: 0.31, outputTps: 92.4, vramReservationMb: 88000, sampleAt: "2026-10-14T08:00:00.000Z", launchArgv: ["--api-key", "webhook-signing-secret"] }],
  gpus: [{ index: 0, util: 87, memUsedMb: 90112, memTotalMb: 97887, tempC: 71, powerW: 412, powerLimitW: 600, throttle: ["sw_power_cap"], uuid: "usr_internal" }],
  alerts: { firing: 1, critical: 0 },
  collectors: {
    recorder: { state: "ok", lastError: "C:\\\\ai\\\\data" },
    runtime: "degraded",
    gpu: { state: "unavailable", lastError: { message: "/srv/ai/logs" } },
    events: "stopped",
    store: "ok",
  },
};

const SUMMARY_PERIOD = {
  requests: 1240, errorRate: 0.031, clientAbortRate: 0.004, ttftP95Ms: 812, durationP95Ms: 14100, decodeTpsP50: 61.2,
  promptTokens: 2.1e6, cachedTokens: 1.3e6, outputTokens: 4.4e5, activeKeys: 6, gpuUtilAvg: 41.5, vramPeakMb: 91002,
  energyKwh: 3.92, energyCost: 2.35, currency: "CNY", billedMicrocredits: "1234000",
};

test("redactLive keeps aggregates, models and GPU numbers and reduces collectors to ok or degraded", () => {
  const out = viewer.redactLive(LIVE);
  assertNoLeak(out, "live");
  assert.deepEqual(out.gateway, { inflight: 2, requestsPerMin: 14, outputTokensPerSec: 85.2, errorRate5m: 0.02, ttftP95Ms5m: 640, clientAborts5m: 1 });
  assert.equal(out.instances[0].model, "qwen3.8-flash");
  assert.equal(out.instances[0].vramReservationMb, 88000);
  assert.equal("launchArgv" in out.instances[0], false);
  assert.deepEqual(out.gpus[0], { index: 0, util: 87, memUsedMb: 90112, memTotalMb: 97887, tempC: 71, powerW: 412, powerLimitW: 600, throttle: ["sw_power_cap"] });
  assert.deepEqual(out.alerts, { firing: 1, critical: 0 });
  assert.deepEqual(out.collectors, { recorder: "ok", runtime: "degraded", gpu: "degraded", events: "degraded", store: "ok" });
  assert.equal(out.at, LIVE.at);
  assert.deepEqual(viewer.redactLive(viewer.redactLive(LIVE)), out, "idempotent: the central and the route redaction may both run");
  assert.notEqual(out, LIVE);
  assert.equal(LIVE.collectors.recorder.state, "ok", "the input is not modified");
});

test("redactSummary drops billing and active keys and marks the body as a viewer copy", () => {
  const body = { ok: true, from: "a", to: "b", current: SUMMARY_PERIOD, previous: { ...SUMMARY_PERIOD, requests: 900 }, coverage: 0.98, source: "rollup_1h" };
  const out = viewer.redactSummary(body);
  assertNoLeak(out, "summary");
  assert.equal(out.viewer, true);
  for (const period of [out.current, out.previous]) {
    assert.equal("billedMicrocredits" in period, false);
    assert.equal("activeKeys" in period, false);
    assert.equal(period.currency, "CNY");
  }
  assert.equal(out.current.requests, 1240);
  assert.equal(out.previous.requests, 900);
  assert.equal(body.current.activeKeys, 6, "the input is not modified");
  assert.equal(viewer.redactSummary({ ok: true, current: SUMMARY_PERIOD }).previous, undefined);
});

test("series queries naming a key or a customer are refused for viewers before any SQL runs", () => {
  for (const search of ["groupBy=key", "groupBy=customer", "key_id=k_1", "customer_id=c_1", "metrics=req.count&groupBy=key&top=3"]) {
    const denied = viewer.redactSeriesQuery(new URLSearchParams(search));
    assert.equal(denied.status, 403, search);
    assert.equal(denied.code, "owner_required");
  }
  for (const search of ["metrics=req.count&groupBy=model", "groupBy=fleet", "model=m&error_class=auth_failed", ""]) {
    assert.equal(viewer.redactSeriesQuery(new URLSearchParams(search)), null, search);
  }
  assert.equal(viewer.redactSeriesQuery({ groupBy: "key" }).code, "owner_required", "a plain object works too");
  assert.equal(viewer.redactSeriesQuery({ groupBy: "model" }), null);
});

test("redactSeries keeps type, at and title of annotations and drops series grouped by key or customer", () => {
  const body = {
    ok: true,
    step: 300,
    series: [
      { metric: "req.count", unit: "requests", group: { model: "m" }, points: [[1, 2]] },
      { metric: "req.count", unit: "requests", group: { key: "key_abc123" }, points: [[1, 9]] },
      { metric: "req.count", unit: "requests", group: { customer: "cust_acme" }, points: [[1, 9]] },
    ],
    annotations: [{ at: 1760380000000, type: "launch.ready", fleetId: "vllm:primary", title: "Launch ready", eventId: 991, requestId: "req_aaaaaaaaaaaaaaaaaaaa" }],
    otherGroups: 0,
  };
  const out = viewer.redactSeries(body);
  assertNoLeak(out, "series");
  assert.equal(out.series.length, 1);
  assert.deepEqual(out.annotations, [{ at: 1760380000000, type: "launch.ready", title: "Launch ready" }]);
  assert.equal(out.step, 300);
});

test("breakdowns by address, customer or key are refused; the rest lose their sample request ids", () => {
  for (const dim of ["client_ip", "customer", "key"]) {
    assert.equal(viewer.redactBreakdownQuery(new URLSearchParams(`dim=${dim}`)).code, "owner_required", dim);
  }
  assert.equal(viewer.redactBreakdownQuery(new URLSearchParams("dim=key_id")), null, "key_id is not a dimension name; the parser refuses it");
  assert.equal(viewer.redactBreakdownQuery(new URLSearchParams("dim=error_class&key_id=k")).status, 403);
  assert.equal(viewer.redactBreakdownQuery(new URLSearchParams("dim=error_class")), null);
  assert.equal(viewer.redactBreakdownQuery(new URLSearchParams("dim=model&customer_id=c")).status, 403);
  const out = viewer.redactBreakdown({
    ok: true,
    dim: "error_class",
    rows: [{ key: "auth_failed", label: { zh: "鉴权失败", en: "Authentication failed" }, requests: 90, share: 0.24, firstSeen: "x", lastSeen: "y", sampleRequestIds: ["req_aaaaaaaaaaaaaaaaaaaa"], spark: [0, 3, 9] }],
    total: { requests: 372 },
  });
  assertNoLeak(out, "breakdown");
  assert.equal("sampleRequestIds" in out.rows[0], false);
  assert.deepEqual(out.rows[0].spark, [0, 3, 9]);
  assert.equal(out.total.requests, 372);
});

test("redactEvents keeps the safe columns, drops data and request ids, and keeps only the masked address of a ban", () => {
  const out = viewer.redactEvents({
    ok: true,
    rows: [
      { id: 7, at: "2026-10-14T08:00:00.000Z", type: "security.ban", severity: "warning", source: "entry", managerId: null, fleetId: null, launchId: null, requestId: null, title: "Client address banned", data: { ip: "203.0.113.9", ipMasked: "203.0.113.x", until: "later" } },
      { id: 8, at: "2026-10-14T08:01:00.000Z", type: "launch.failed", severity: "warning", source: "vllm", managerId: "vllm", fleetId: "vllm:primary", launchId: "lch_x", requestId: "req_aaaaaaaaaaaaaaaaaaaa", title: "Launch failed", data: { message: "key_abc123 refused", ip: "192.0.2.10" } },
      { id: 9, at: "2026-10-14T08:02:00.000Z", type: "alert.firing", severity: "critical", source: "telemetry", managerId: null, title: "GPU hot", data: { ipMasked: "x" } },
    ],
    nextCursor: "abc",
  });
  assertNoLeak(out, "events");
  assert.deepEqual(out.rows[0], { id: 7, at: "2026-10-14T08:00:00.000Z", type: "security.ban", severity: "warning", source: "entry", managerId: null, title: "Client address banned", data: { ipMasked: "203.0.113.x" } });
  assert.deepEqual(Object.keys(out.rows[1]), ["id", "at", "type", "severity", "source", "managerId", "title"]);
  assert.equal("data" in out.rows[2], false, "ipMasked is kept on security.ban only");
  assert.equal(out.nextCursor, "abc");
});

test("redactAlerts removes channels and webhook ids everywhere and leaves the rest", () => {
  const rules = {
    ok: true,
    rules: [{ ruleId: "gpu_temp_high", metric: "gpu.temp_max", enabled: true, threshold: 85, severity: "warning", channels: ["inapp", "webhook"], webhookIds: ["hook-secret-id"], titleZh: "x", titleEn: "y" }],
    metrics: [{ id: "gpu.temp_max", unit: "celsius", scopes: ["gpu"] }],
  };
  const out = viewer.redactAlerts(rules);
  assertNoLeak(out, "alert rules");
  assert.equal("channels" in out.rules[0], false);
  assert.equal("webhookIds" in out.rules[0], false);
  assert.equal(out.rules[0].threshold, 85);
  assert.deepEqual(out.metrics, rules.metrics);
  const rows = viewer.redactAlerts({ rows: [{ ruleId: "gpu_temp_high", scopeKey: "gpu:0", state: "firing", severity: "warning", value: 87, threshold: 85, webhookId: "hook-secret-id" }] });
  assert.equal("webhookId" in rows.rows[0], false);
  assert.equal(rows.rows[0].value, 87);
  const event = viewer.redactAlerts({ action: "firing", alert: { ruleId: "gpu_temp_high", scopeKey: "gpu:0", severity: "warning", channels: ["webhook"], value: 87 } });
  assert.deepEqual(event, { action: "firing", alert: { ruleId: "gpu_temp_high", scopeKey: "gpu:0", severity: "warning", value: 87 } });
});

test("redactStatus keeps collector states, the schema version and degraded names only", () => {
  const out = viewer.redactStatus({
    ok: true,
    schemaVersion: 1,
    dbBytes: 123456,
    walBytes: 789,
    rows: { requests: 5 },
    collectors: { recorder: { state: "ok", lastOkAt: "x", lastError: "C:\\\\ai\\\\data" }, runtime: { state: "degraded", lastError: "/srv/ai/logs" } },
    recorder: { inflight: 1, buffered: 2, dropped: 0 },
    rollup: { watermark1m: 1, dirty: 0 },
    retention: { lastRunAt: "x", deleted: 4 },
    imports: [{ source: "stats-ledger", rowsIn: 3 }],
    degraded: ["runtime_degraded"],
  });
  assertNoLeak(out, "status");
  assert.deepEqual(out, { ok: true, schemaVersion: 1, collectors: { recorder: "ok", runtime: "degraded" }, degraded: ["runtime_degraded"] });
});

test("the energy, lifecycle, launches and baseline routes carry no personal data and pass through unchanged", () => {
  const body = { ok: true, rows: [{ key: "x", energyWh: 1 }] };
  assert.equal(viewer.identity(body), body);
  for (const path of ["/api/telemetry/energy", "/api/telemetry/lifecycle", "/api/telemetry/launches", "/api/telemetry/baseline"]) {
    const route = viewer.TELEMETRY_VIEWER_ROUTES.find((item) => item.path === path);
    assert.equal(route.redact, viewer.identity, path);
  }
});

// --- registry -----------------------------------------------------------------

// Every GET route 04 serves under /api/telemetry/ (TEL-11, TEL-13, TEL-18), and
// the audit routes TEL-16 declares.
const TELEMETRY_GET_ROUTES = [
  "/api/telemetry/live", "/api/telemetry/summary", "/api/telemetry/timeseries", "/api/telemetry/breakdown",
  "/api/telemetry/requests", "/api/telemetry/requests/req_x", "/api/telemetry/events", "/api/telemetry/energy",
  "/api/telemetry/lifecycle", "/api/telemetry/launches", "/api/telemetry/baseline", "/api/telemetry/export",
  "/api/telemetry/status", "/api/telemetry/settings", "/api/telemetry/alerts", "/api/telemetry/alert-rules",
  "/api/telemetry/import/run_x",
];
const VIEWER_GET_ROUTES = new Set([
  "/api/telemetry/live", "/api/telemetry/summary", "/api/telemetry/timeseries", "/api/telemetry/breakdown",
  "/api/telemetry/events", "/api/telemetry/energy", "/api/telemetry/lifecycle", "/api/telemetry/launches",
  "/api/telemetry/baseline", "/api/telemetry/status", "/api/telemetry/alerts", "/api/telemetry/alert-rules",
]);

test("every 04 GET route is registered for viewers with its redaction or is owner-only", () => {
  const registry = createViewerRegistry({ logger: { warn() {} } });
  const warnings = [];
  registerTelemetryRoutes(registry, (line) => warnings.push(line));
  viewer.registerTelemetryViewerRoutes(registry, (line) => warnings.push(line));
  assert.deepEqual(warnings, []);
  for (const route of TELEMETRY_GET_ROUTES) {
    const found = registry.match("GET", route);
    assert.ok(found, `${route} is neither registered nor owner-only`);
    assert.equal(found.access, VIEWER_GET_ROUTES.has(route) ? "viewer" : "admin", route);
    if (found.access === "viewer") assert.equal(typeof found.entry.redact, "function", `${route} names its redaction`);
  }
  const redactions = new Map(viewer.TELEMETRY_VIEWER_ROUTES.map((route) => [route.path, route.redact]));
  assert.equal(registry.match("GET", "/api/telemetry/live").entry.redact, viewer.redactLive);
  assert.equal(registry.match("GET", "/api/telemetry/summary").entry.redact, viewer.redactSummary);
  assert.equal(registry.match("GET", "/api/telemetry/timeseries").entry.redact, viewer.redactSeries);
  assert.equal(registry.match("GET", "/api/telemetry/breakdown").entry.redact, viewer.redactBreakdown);
  assert.equal(registry.match("GET", "/api/telemetry/events").entry.redact, viewer.redactEvents);
  assert.equal(registry.match("GET", "/api/telemetry/alerts").entry.redact, viewer.redactAlerts);
  assert.equal(registry.match("GET", "/api/telemetry/alert-rules").entry.redact, viewer.redactAlerts);
  assert.equal(registry.match("GET", "/api/telemetry/status").entry.redact, viewer.redactStatus);
  assert.equal(redactions.size, viewer.TELEMETRY_VIEWER_ROUTES.length);
  assert.equal(registry.match("PUT", "/api/telemetry/settings").access, "admin");
  assert.equal(registry.match("POST", "/api/telemetry/import").access, "admin");
  for (const audit of AUDIT_ROUTES) {
    // 05's route inventory lists audit routes through audit-http; none is a viewer route.
    assert.notEqual(registry.match(audit.method, audit.path.replace(/:[A-Za-z]+/g, "x"))?.access, "viewer", `${audit.method} ${audit.path}`);
  }
});

test("telemetry.live and alerts reach viewer streams redacted and notification never does", () => {
  const registry = createViewerRegistry({ logger: { warn() {} } });
  viewer.registerTelemetryViewerRoutes(registry, () => {});
  assert.deepEqual(registry.viewerEventTypes().sort(), ["alerts", "telemetry.live"]);
  const live = registry.redactEvent("telemetry.live", LIVE);
  assert.deepEqual(live.collectors, { recorder: "ok", runtime: "degraded", gpu: "degraded", events: "degraded", store: "ok" });
  assertNoLeak(live, "telemetry.live event");
  const alert = registry.redactEvent("alerts", { action: "firing", alert: { ruleId: "r", channels: ["webhook"], webhookId: "hook-secret-id" } });
  assert.deepEqual(alert, { action: "firing", alert: { ruleId: "r" } });
  assert.equal(registry.redactEvent("notification", { kind: "x" }), null);
});

test("a registration that cannot be made is reported and leaves the others in place", () => {
  const registered = [];
  const allowlist = {
    registerRoute: (route) => {
      if (route.path.endsWith("/events")) throw new Error("already registered");
      registered.push(route.path);
    },
    registerAdminOnly: () => {},
    registerEventType: () => {},
  };
  const warnings = [];
  viewer.registerTelemetryViewerRoutes(allowlist, (line) => warnings.push(line));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GET \/api\/telemetry\/events was not registered and stays owner-only/);
  assert.ok(registered.includes("/api/telemetry/live"));
  assert.equal(registered.includes("/api/telemetry/events"), false);
});
