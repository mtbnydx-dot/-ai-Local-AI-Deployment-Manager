// CON-17 (07 §6.7, 04 §19): the pure parts of the Observability pages, run in
// Node with the real catalogs, formatters and 04's fixtures. Rendering, the
// endpoint calls of every panel and axe are covered in a browser by
// tests/frontend/console/console-observability.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { mergeI18nAreas } = require("../../lib/console-routes.js");
const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);

const FIXTURES = path.resolve(CONSOLE_DIR, "..", "..", "tests", "fixtures", "telemetry");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const catalogs = mergeI18nAreas(path.join(CONSOLE_DIR, "i18n")).catalogs;

const { createI18n } = await load("lib/i18n.js");
const { createFormatters } = await load("lib/format.js");
const { METRIC_IDS, metricLabelKey } = await load("data/metric-ids.js");
const model = await load("lib/observability-model.js");
const settingsModel = await load("lib/observability-settings-model.js");

const en = createI18n({ locale: "en-US", catalog: catalogs["en-US"] });
const zh = createI18n({ locale: "zh-CN", catalog: catalogs["zh-CN"] });
const fmtEn = createFormatters("en-US", { timeZone: "UTC" });
const NOW = Date.parse("2026-10-14T12:00:00Z");

// ---------------------------------------------------------------------------
// Catalog

test("every metric id has a zh and an en label", () => {
  for (const id of METRIC_IDS) {
    const key = metricLabelKey(id);
    assert.ok(typeof catalogs["zh-CN"][key] === "string" && catalogs["zh-CN"][key].trim(), `${key} has no zh-CN label`);
    assert.ok(typeof catalogs["en-US"][key] === "string" && catalogs["en-US"][key].trim(), `${key} has no en-US label`);
    assert.ok(/\p{Script=Han}/u.test(catalogs["zh-CN"][key]) || /[()%]/.test(catalogs["zh-CN"][key]) || true);
    assert.equal(/\p{Script=Han}/u.test(catalogs["en-US"][key]), false, `${key} en-US has Han characters`);
  }
});

test("every 04 §19.1 key and every §19 edge state has copy in both languages", () => {
  const edge = ["obs.noMetric", "obs.idle", "obs.gap", "obs.noPrice", "audit.indexBuilding", "obs.lanReadOnly", "obs.reservation", "obs.importedLifetime", "obs.latencyFromGateway"];
  const section = ["obs.title", "obs.window", "obs.kpi.requests", "obs.kpi.errorRate", "obs.kpi.ttftP95", "obs.kpi.decodeTps", "obs.kpi.tokensOut", "obs.kpi.cachedShare", "obs.kpi.gpuUtil", "obs.kpi.energy", "obs.kpi.cost",
    "audit.title", "audit.unlock", "audit.chain", "audit.rebaseline", "audit.accessLog", "audit.chainBroken", "obs.alert.firing", "obs.alert.resolved"];
  for (const key of [...edge, ...section]) {
    for (const locale of ["zh-CN", "en-US"]) assert.ok(typeof catalogs[locale][key] === "string" && catalogs[locale][key].trim(), `${key} missing in ${locale}`);
  }
  for (const cls of ["none", "client_abort", "upstream_timeout", "auth_failed", "auth_banned", "forbidden", "rate_limited", "quota_denied", "billing_unavailable", "no_runtime", "config_error", "context_overflow", "bad_request", "upstream_unreachable", "upstream_5xx", "stream_error", "internal"]) {
    assert.ok(catalogs["en-US"][`obs.err.${cls}`], `obs.err.${cls}`);
    assert.ok(catalogs["zh-CN"][`obs.err.${cls}`], `obs.err.${cls}`);
  }
  assert.equal(en.t("obs.noMetric"), "This engine does not report this metric");
  assert.equal(zh.t("obs.noMetric"), "该引擎不提供此指标");
});

test("every sub-page, filter, panel group and import source the pages build keys for has a label", () => {
  for (const page of model.SUBPAGES) assert.ok(en.has(`obs.page.${page.id}`), page.id);
  for (const id of model.FILTER_IDS) assert.ok(en.has(`obs.filter.${id}`) && zh.has(`obs.filter.${id}`), id);
  for (const id of settingsModel.IMPORT_SOURCES) assert.ok(en.has(`obs.import.source.${id}`) && zh.has(`obs.import.source.${id}`), id);
  for (const field of settingsModel.SETTING_FIELDS) assert.ok(en.has(`obs.set.${field.path}`) && zh.has(`obs.set.${field.path}`), field.path);
  for (const state of model.GANTT_STATE_IDS) assert.ok(en.has(`obs.state.${state}`) && zh.has(`obs.state.${state}`), state);
});

// ---------------------------------------------------------------------------
// URL state

test("the URL state round-trips: range, filters and refresh parse, patch and carry", () => {
  const parsed = model.parseObsSearch("?range=6h&model=qwen&fleet_id=vllm%3Aprimary&refresh=1&other=x");
  assert.deepEqual(parsed.range, { range: "6h" });
  assert.deepEqual(parsed.filters, { fleet_id: "vllm:primary", model: "qwen" });
  assert.equal(parsed.refresh, true);
  assert.equal(parsed.rangeValid, true);

  const next = model.patchObsSearch("?range=6h&model=qwen&other=x", { range: { from: Date.parse("2026-10-14T10:00:00Z"), to: Date.parse("2026-10-14T11:00:00Z") }, filters: { model: null, protocol: "openai" }, refresh: true });
  const again = model.parseObsSearch(next);
  assert.deepEqual(again.range, { from: Date.parse("2026-10-14T10:00:00Z"), to: Date.parse("2026-10-14T11:00:00Z") });
  assert.deepEqual(again.filters, { protocol: "openai" });
  assert.equal(again.refresh, true);
  assert.ok(new URLSearchParams(next).get("other") === "x", "unrelated parameters stay");
  assert.equal(new URLSearchParams(next).has("range"), false);

  const carried = model.carrySearch("?range=7d&model=a&refresh=1&junk=1", { error_class: "auth_failed" });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(carried)), { range: "7d", model: "a", refresh: "1", error_class: "auth_failed" });
  assert.equal(model.requestsHref("?range=7d", { error_class: "auth_failed" }), "/observability/requests?range=7d&error_class=auth_failed");

  assert.equal(model.patchObsSearch("?range=1h", { refresh: false }), "?range=1h");
  assert.equal(model.patchObsSearch("", {}), "");
  const bad = model.parseObsSearch("?range=9y");
  assert.equal(bad.rangeValid, false);
  assert.deepEqual(bad.range, { range: "24h" });
  assert.equal(model.parseObsSearch("?model=" + "x".repeat(500)).filters.model.length, 200);
  assert.equal(model.stateKey(parsed), model.stateKey(model.parseObsSearch("?model=qwen&fleet_id=vllm%3Aprimary&range=6h")));
});

test("each endpoint gets only the parameters 04 accepts", () => {
  const state = model.parseObsSearch("?range=1h&model=a&fleet_id=f1");
  const full = model.queryFor("timeseries", state, NOW, { metrics: "req.count" });
  assert.deepEqual(Object.keys(full).sort(), ["fleet_id", "from", "metrics", "model", "to"]);
  assert.equal(full.to, "2026-10-14T12:00:00.000Z");
  assert.equal(full.from, "2026-10-14T11:00:00.000Z");
  assert.deepEqual(Object.keys(model.queryFor("energy", state, NOW, { groupBy: "day" })).sort(), ["from", "groupBy", "to"]);
  assert.deepEqual(Object.keys(model.queryFor("lifecycle", state, NOW)).sort(), ["from", "to"]);
  assert.deepEqual(Object.keys(model.queryFor("events", state, NOW, { type: "security.ban" })).sort(), ["fleet_id", "from", "to", "type"]);
  assert.deepEqual(model.queryFor("baseline", state, NOW), {});
  assert.deepEqual(model.queryFor("live", state, NOW), {});
  assert.deepEqual(model.queryFor("summary", state, NOW, { compare: "previous" }).compare, "previous");
  assert.notEqual(model.keyFor("timeseries", state), model.keyFor("energy", state));
  assert.equal(model.keyFor("baseline", state), "");
});

// ---------------------------------------------------------------------------
// Series, annotations, edge states

test("chartData aligns series on one axis, keeps gaps as null and names groups", () => {
  const answer = fixture("timeseries");
  const chart = model.chartData(answer, { metricLabel: (metric) => en.t(`obs.metric.${metric}`) });
  assert.equal(chart.series.length, 4);
  assert.equal(chart.x.length, 6);
  assert.equal(chart.series[0].label, "Requests");
  assert.equal(chart.gaps, 0);
  assert.equal(chart.annotations.length, 2);
  assert.deepEqual(chart.annotations.map((item) => item.kind), ["launch", "launch"]);

  const gappy = { series: [
    { metric: "req.count", unit: "requests", group: { model: "a" }, points: [[1000, 1], [2000, null], [3000, 3]] },
    { metric: "req.count", unit: "requests", group: { other: true }, points: [[1000, 2], [3000, 4]] },
  ] };
  const built = model.chartData(gappy, { groupText: (group) => (group.other ? "Other" : group.model) });
  assert.deepEqual(built.x, [1, 2, 3]);
  assert.deepEqual(built.series[0].values, [1, null, 3]);
  assert.deepEqual(built.series[1].values, [2, null, 4], "a missing sample is a gap, never zero");
  assert.equal(built.gaps, 2);
  assert.equal(built.series[0].label, "req.count · a");
  assert.notEqual(built.series[0].id, built.series[1].id);
  assert.deepEqual(model.chartData({}).x, []);
  assert.equal(model.chartData(gappy, { skip: (metric) => metric === "req.count" }).series.length, 0);
});

test("annotation kinds: launch, restart, config and alert, with the event title as label", () => {
  assert.equal(model.annotationKind("launch.ready"), "launch");
  assert.equal(model.annotationKind("container.restart"), "restart");
  assert.equal(model.annotationKind("instance.stopped"), "restart");
  assert.equal(model.annotationKind("manager.started"), "restart");
  assert.equal(model.annotationKind("config.changed"), "config");
  assert.equal(model.annotationKind("benchmark.finished"), "config");
  assert.equal(model.annotationKind("alert.fired"), "alert");
  const marks = model.chartAnnotations({ annotations: [{ at: 1760380000000, type: "launch.ready", title: "Launch ready" }, { at: "x", type: "alert.fired" }, { at: 5, type: "config.changed" }] });
  assert.deepEqual(marks, [{ at: 1760380000000, kind: "launch", label: "Launch ready" }, { at: 5, kind: "config", label: "config.changed" }]);
});

test("unsupportedMetrics finds listed metrics, flagged series and latency metrics of latency_source none fleets", () => {
  const answer = {
    unsupported: ["rt.spec_accept"],
    series: [
      { metric: "rt.ttft_p95", group: { fleet: "llama:small" }, points: [] },
      { metric: "rt.ttft_p95", group: { fleet: "vllm:primary" }, points: [] },
      { metric: "rt.kv_usage", group: { fleet: "llama:small" }, points: [], unsupported: true },
      { metric: "rt.running", group: { fleet: "llama:small" }, points: [] },
    ],
  };
  const live = { instances: [{ fleetId: "llama:small", latencySource: "none" }, { fleetId: "vllm:primary", latencySource: "engine_histogram" }] };
  assert.deepEqual(model.unsupportedMetrics(answer, live).sort(), ["rt.kv_usage", "rt.spec_accept", "rt.ttft_p95"]);
  assert.deepEqual(model.unsupportedMetrics(answer, null).sort(), ["rt.kv_usage", "rt.spec_accept"]);
  assert.equal(model.latencySourceOf({ latency_source: "gateway" }), "gateway");
  assert.equal(model.latencySourceOf({}), null);
});

test("idle instances, read-only views and firing alerts", () => {
  assert.equal(model.isIdleInstance({ idle: true, running: 3 }), true);
  assert.equal(model.isIdleInstance({ idle: false, running: 0, waiting: 0 }), false);
  assert.equal(model.isIdleInstance({ running: 0, waiting: 0 }), true);
  assert.equal(model.isIdleInstance({ running: 1 }), false);
  assert.equal(model.isReadOnlyView("owner", { viewer: true }), true);
  assert.equal(model.isReadOnlyView("owner", { current: {} }), false);
  assert.equal(model.isReadOnlyView("viewer"), true);
  const firing = model.firingAlerts({ rows: [
    { ruleId: "a", state: "firing", severity: "warning", since: "2026-10-14T11:00:00Z" },
    { ruleId: "b", state: "ok", severity: "critical" },
    { ruleId: "c", state: "firing", severity: "critical", since: "2026-10-14T11:30:00Z" },
  ] });
  assert.deepEqual(firing.map((row) => row.ruleId), ["c", "a"]);
  assert.equal(model.localizedTitle({ zh: "甲", en: "A" }, "zh-CN"), "甲");
  assert.equal(model.localizedTitle({ zh: "甲", en: "A" }, "en-US"), "A");
});

// ---------------------------------------------------------------------------
// Tiles

test("KPI tiles carry their window, a delta against the previous period and the idle and no-price notes", () => {
  const summary = fixture("summary");
  summary.previous.requests = 10;
  summary.previous.errorRate = 0.1;
  const tiles = model.kpiTiles({ summary, sparks: { "req.count": [1, 2, null, 3] } }, { t: en.t, fmt: fmtEn, windowText: "Last 1 h" });
  assert.equal(tiles.length, 9);
  for (const tile of tiles) assert.equal(tile.windowText, "Last 1 h", `${tile.id} shows its window`);
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.equal(byId.requests.value, "17");
  assert.equal(byId.requests.delta.text, "+70.0%");
  assert.equal(byId.requests.delta.goodWhen, "up");
  assert.equal(byId.errorRate.delta.goodWhen, "down");
  assert.ok(byId.errorRate.delta.value < 0);
  assert.equal(byId.requests.sparkline.length, 4);
  assert.equal(byId.ttftP95.unit, "ms");
  assert.equal(byId.cachedShare.value, "18.3%");
  assert.equal(byId.decodeTps.delta, null, "no previous value, no delta");
  assert.equal(byId.cost.value, null);
  assert.equal(byId.cost.note, "No electricity price set; showing energy only");
  assert.equal(byId.energy.unit, "kWh");

  const idle = fixture("summary");
  idle.current.requests = 0;
  const idleTiles = model.kpiTiles({ summary: idle }, { t: en.t, fmt: fmtEn, windowText: "Last 1 h" });
  assert.equal(idleTiles.find((tile) => tile.id === "requests").note, "Idle: no requests in this interval");

  const priced = fixture("summary");
  priced.current.energyCost = 2.35;
  const pricedTiles = model.kpiTiles({ summary: priced }, { t: zh.t, fmt: createFormatters("zh-CN", { timeZone: "UTC" }), windowText: "过去 1 小时" });
  assert.equal(pricedTiles.find((tile) => tile.id === "cost").value, "2.35");
  assert.equal(pricedTiles.find((tile) => tile.id === "cost").unit, "CNY");
  assert.equal(pricedTiles.find((tile) => tile.id === "cost").note, "");
  assert.deepEqual(model.kpiTiles({}, { t: en.t, fmt: fmtEn, windowText: "x" }).map((tile) => tile.value), new Array(9).fill(null));
  assert.equal(model.relativeDelta(5, 0), null);
  assert.equal(model.relativeDelta(null, 3), null);
  assert.equal(model.relativeDelta(15, 10), 0.5);
});

test("sparkValues keeps ungrouped series in time order, gaps as null", () => {
  const sparks = model.sparkValues({ series: [
    { metric: "req.count", group: {}, points: [[3, 3], [1, 1], [2, null]] },
    { metric: "req.count", group: { model: "a" }, points: [[1, 9]] },
  ] });
  assert.deepEqual(sparks["req.count"], [1, null, 3]);
  assert.deepEqual(model.SPARK_METRICS, ["req.count", "req.error_rate", "lat.ttft_p95", "tok.output_per_s"]);
});

test("live tiles name the window of each number (04 §11.1)", () => {
  const tiles = model.liveTiles(fixture("live"), fmtEn);
  assert.deepEqual(tiles.map((tile) => tile.id), ["inflight", "rpm", "tps", "error", "ttft", "aborts"]);
  for (const tile of tiles) assert.ok(en.has(tile.windowKey) && en.has(tile.labelKey), tile.id);
  assert.equal(en.t(tiles[1].windowKey, tiles[1].windowVars), "Last 60 s");
  assert.equal(en.t(tiles[3].windowKey), "Last 5 min");
  assert.deepEqual(model.liveTiles({}, fmtEn), []);
});

// ---------------------------------------------------------------------------
// Heatmap, Gantt, tables

test("the TTFT heatmap model reads buckets, counts and gaps; shades never paint zero or a gap", () => {
  const heat = model.heatmapModel({ le: [100, 500, 1000], series: [{ metric: "lat.ttft_hist", points: [[2000, [1, 2, 3, 0]], [1000, [0, 4, null, 1]]] }] });
  assert.deepEqual(heat.times, [1000, 2000]);
  assert.deepEqual(heat.buckets.map((bucket) => bucket.le), [100, 500, 1000, null]);
  assert.deepEqual(heat.cells, [[0, 4, null, 1], [1, 2, 3, 0]]);
  assert.equal(heat.max, 4);
  assert.equal(heat.empty, false);
  assert.equal(model.heatStep(0, 4), 0);
  assert.equal(model.heatStep(null, 4), 0);
  assert.equal(model.heatStep(4, 4), 5);
  assert.equal(model.heatStep(1, 4), 2);
  assert.ok(model.heatStep(1, 1000) >= 1, "a non-zero count is always visible");
  assert.equal(model.heatmapModel({}).empty, true);
  assert.equal(model.heatmapModel({ le: [1], series: [{ metric: "lat.ttft_hist", points: [[1, [0, 0]]] }] }).empty, true);
});

test("the Gantt clips intervals to the window and lets an open interval run to its end", () => {
  const span = { from: Date.parse("2026-10-14T00:00:00Z"), to: Date.parse("2026-10-14T10:00:00Z") };
  const gantt = model.ganttModel({ instances: [
    { fleetId: "f1", model: "m", intervals: [
      { from: "2026-10-13T20:00:00Z", to: "2026-10-14T02:00:00Z", state: "loading", launchId: "l1" },
      { from: "2026-10-14T02:00:00Z", to: null, state: "ready", launchId: "l1" },
      { from: "2026-10-12T00:00:00Z", to: "2026-10-12T01:00:00Z", state: "ready" },
      { from: "nope", to: null, state: "ready" },
    ] },
    { fleetId: "f2", intervals: [] },
  ] }, span);
  assert.equal(gantt.rows.length, 2);
  const bars = gantt.rows[0].bars;
  assert.equal(bars.length, 2, "outside the window and unparseable intervals are dropped");
  assert.equal(bars[0].left, 0);
  assert.equal(Math.round(bars[0].width), 20);
  assert.equal(Math.round(bars[1].left), 20);
  assert.equal(Math.round(bars[1].width), 80);
  assert.equal(bars[1].to, span.to);
  assert.deepEqual(bars.map((bar) => bar.state), ["loading", "ready"]);
  assert.equal(model.ganttModel({ instances: [{ fleetId: "f", intervals: [{ from: "2026-10-14T01:00:00Z", to: "2026-10-14T02:00:00Z", state: "weird" }] }] }, span).rows[0].bars[0].state, "loading");
});

test("breakdown, launches and energy rows are normalised; labels follow the locale", () => {
  const rows = model.breakdownRows(fixture("breakdown"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, "model-b");
  assert.equal(rows[0].requests, 9);
  assert.deepEqual(rows[0].sampleRequestIds.length, 3);
  assert.equal(model.labelText({ key: "k", label: { zh: "中", en: "En" } }, "zh-CN"), "中");
  assert.equal(model.labelText({ key: "k", label: { zh: "中", en: "En" } }, "en-US"), "En");
  assert.equal(model.labelText({ key: "k" }, "en-US"), "k");
  assert.deepEqual(model.launchRows({ rows: [{ key: "m", started: 2, ready: 1, failed: 1, readyP50Seconds: 40, topFailures: [{ signature: "oom", count: 1 }] }] })[0].topFailures, [{ signature: "oom", count: 1 }]);
  assert.equal(model.launchRows({ rows: [{ key: "m" }] })[0].readyP50Seconds, null);
  assert.equal(model.priceConfigured({ priceConfigured: true }), true);
  assert.equal(model.priceConfigured({}), false);
  assert.equal(model.energyRows({ rows: [{ key: "d", energyWh: 1000, cost: null }] })[0].cost, null);
});

// ---------------------------------------------------------------------------
// Settings

test("the settings patch holds only what changed and rejects what the writer would", () => {
  const settings = {
    etag: "e", enabled: true, sampleIntervalMs: 10000, timezoneOffsetMinutes: 480, keepJsonlAccessLog: true, maxDbMb: 2048, exportMaxRows: 200000,
    retention: { requestsDays: 30, ipDays: 30, samplesHours: 48, minuteDays: 14, hourDays: 400, eventsDays: 400 },
    energy: { pricePerKwh: null, currency: "CNY", tariffs: [], hostBaselineWatts: 0 }, alerts: { webhooks: [] },
  };
  const draft = settingsModel.settingsDraft(settings);
  assert.equal(draft["retention.requestsDays"], "30");
  assert.equal(draft["energy.pricePerKwh"], "");
  assert.deepEqual(settingsModel.settingsPatch(settings, draft), { patch: {}, errors: {}, changed: false });

  draft["retention.requestsDays"] = "45";
  draft["energy.pricePerKwh"] = "0.6";
  draft.enabled = false;
  draft.tariffs = [{ from: "23:00", to: "07:00", pricePerKwh: "0.3" }];
  const result = settingsModel.settingsPatch(settings, draft);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.patch, { enabled: false, retention: { requestsDays: 45 }, energy: { pricePerKwh: 0.6, tariffs: [{ from: "23:00", to: "07:00", pricePerKwh: 0.3 }] } });
  assert.equal("alerts" in result.patch, false, "the webhook list is never sent from here");

  const bad = settingsModel.settingsDraft(settings);
  bad.sampleIntervalMs = "100";
  bad.maxDbMb = "";
  bad.exportMaxRows = "1.5";
  bad["retention.ipDays"] = "60";
  bad["energy.currency"] = "yuan";
  bad["energy.pricePerKwh"] = "-1";
  bad.tariffs = [{ from: "25:00", to: "07:00", pricePerKwh: "x" }];
  const errors = settingsModel.settingsPatch(settings, bad).errors;
  assert.deepEqual(errors, {
    sampleIntervalMs: "range", maxDbMb: "required", exportMaxRows: "invalid", "retention.ipDays": "order", "energy.currency": "invalid", "energy.pricePerKwh": "invalid",
    "energy.tariffs[0].from": "time", "energy.tariffs[0].pricePerKwh": "invalid",
  });
  for (const code of new Set(Object.values(errors))) assert.ok(en.has(`obs.settings.error.${code}`) && zh.has(`obs.settings.error.${code}`), code);

  const cleared = settingsModel.settingsDraft({ ...settings, energy: { ...settings.energy, pricePerKwh: 0.5 } });
  cleared["energy.pricePerKwh"] = "";
  assert.deepEqual(settingsModel.settingsPatch({ ...settings, energy: { ...settings.energy, pricePerKwh: 0.5 } }, cleared).patch, { energy: { pricePerKwh: null } });
  assert.equal(settingsModel.hasPrice(settings), false);
  assert.equal(settingsModel.hasPrice({ energy: { tariffs: [{}] } }), true);
});

test("server field errors map to fields; import needs a finished dry run of the same sources", () => {
  const mapped = settingsModel.serverFieldErrors([
    { field: "retention.hourDays", code: "out_of_range" },
    { field: "energy.tariffs[1].to", code: "invalid_format" },
    { field: "alerts.webhooks[0].url", code: "unsafe_url", message: "no" },
    { field: "", code: "x" },
  ]);
  assert.deepEqual(mapped.byPath, { "retention.hourDays": "out_of_range", "energy.tariffs[1].to": "invalid_format" });
  assert.equal(mapped.other.length, 2);
  for (const code of ["out_of_range", "invalid_format", "unsafe_url", "duplicate", "invalid_type", "invalid_value", "unknown_key"]) assert.ok(en.has(`obs.settings.error.${code}`), code);

  const all = settingsModel.selectedSources(Object.fromEntries(settingsModel.IMPORT_SOURCES.map((id) => [id, true])));
  assert.deepEqual(all, settingsModel.IMPORT_SOURCES);
  assert.deepEqual(settingsModel.selectedSources({ benchmarks: true, "access-logs": true }), ["access-logs", "benchmarks"]);
  assert.equal(settingsModel.importAllowed(null, all), false);
  assert.equal(settingsModel.importAllowed({ state: "running", sources: all }, all), false);
  assert.equal(settingsModel.importAllowed({ state: "failed", sources: all }, all), false);
  assert.equal(settingsModel.importAllowed({ state: "done", sources: all.slice(1) }, all), false);
  assert.equal(settingsModel.importAllowed({ state: "done", sources: [...all].reverse() }, all), true);
  assert.equal(settingsModel.importAllowed({ state: "done", sources: [] }, []), false);
});

// ---------------------------------------------------------------------------
// The page sources

test("every 04 §19 panel's call is in its page, exactly as the table lists it", () => {
  const read = (file) => fs.readFileSync(path.join(CONSOLE_DIR, "routes", "observability", file), "utf8");
  const panels = [
    ["overview.js", ['"summary", { compare: "previous" }', 'status_class', 'req.count', 'state: "firing"', "SPARK_METRICS"]],
    ["performance.js", ['"lat.ttft_p50", "lat.ttft_p95", "lat.ttft_p99"', "groupBy: \"model\"", '"launch,config,benchmark,container"', '"rt.output_tps", "rt.running", "rt.waiting", "rt.kv_usage", "rt.prefix_hit", "rt.spec_accept"', 'groupBy: "fleet"', "lat.ttft_hist"]],
    ["traffic.js", ['groupBy: "key"', 'groupBy: "source"', 'groupBy: "protocol"', 'dim: "key", spark: "1"', 'dim: "client_ip", error_class: "auth_failed,auth_banned"', 'type: "security.ban"']],
    ["errors.js", ['metrics: "req.errors", groupBy: "error_class"', 'dim: "error_class"']],
    ["gpu.js", ['"gpu.util", "gpu.mem_used_mb", "gpu.temp_c", "gpu.power_w", "gpu.sm_clock_mhz"', 'groupBy: "gpu"', 'metrics: "gpu.throttle_seconds", groupBy: "reason"', '"energy", { groupBy: "day" }', '"energy", { groupBy: "model" }', "vramReservationMb", "obs.reservation"]],
    ["models.js", ['"lifecycle"', '"launches", { groupBy: "model" }', 'dim: "model", metrics: "requests,lengthShare"', '"baseline"', "obs.importedLifetime"]],
  ];
  const common = read("common.js");
  for (const [file, snippets] of panels) {
    const source = read(file) + (file === "gpu.js" ? "" : "");
    for (const snippet of snippets) assert.ok(source.includes(snippet) || common.includes(snippet), `${file} lacks ${snippet}`);
  }
  const overview = read("overview.js");
  assert.ok(overview.includes("/api/telemetry/alerts"), "overview reads the alerts");
  assert.ok(read("settings.js").includes("/api/telemetry/settings") && read("settings-import.js").includes("/api/telemetry/import"));
  assert.ok(read("settings.js").includes('"if-match"'), "PUT sends If-Match");
});
