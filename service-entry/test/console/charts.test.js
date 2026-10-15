// CON-7b (07 §4.4, §6.7): the pure parts of the chart components, run in
// Node: the time-range library and its URL round trip, the metric id list,
// the chart model (gaps stay gaps, stacks, hidden series), the uPlot options,
// and the GPU memory model whose table total must equal its segments.
// Rendering, uPlot's lazy request and the table view are covered in a browser
// by tests/frontend/console/console-charts.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);
const range = await load("lib/time-range.js");
const { createFormatters } = await load("lib/format.js");
const fmt = createFormatters("en-US", { timeZone: "UTC" });

test("a preset range parses, serializes and parses back", () => {
  for (const id of range.RANGE_IDS) {
    const parsed = range.parseTimeRange(`?range=${id}`);
    assert.deepEqual(parsed, { value: { range: id }, valid: true, problem: null });
    assert.equal(range.timeRangeQuery(parsed.value), `?range=${id}`);
  }
  assert.deepEqual(range.parseTimeRange("").value, { range: "24h" }, "no query: the default");
  assert.deepEqual(range.parseTimeRange("", { fallback: "1h" }).value, { range: "1h" });
  assert.deepEqual(range.parseTimeRange(new URLSearchParams("range=7d")).value, { range: "7d" });
  assert.deepEqual(range.parseTimeRange({ range: "6h" }).value, { range: "6h" });
});

test("a custom range round-trips through the URL in whole seconds", () => {
  const value = { from: Date.parse("2026-10-13T08:00:00Z"), to: Date.parse("2026-10-14T09:30:15Z") };
  const query = range.timeRangeQuery(value);
  assert.equal(query, "?from=2026-10-13T08%3A00%3A00Z&to=2026-10-14T09%3A30%3A15Z");
  const back = range.parseTimeRange(query);
  assert.deepEqual(back, { value, valid: true, problem: null });
  assert.equal(range.timeRangeQuery(back.value), query, "serialize is stable");
  // Milliseconds are dropped on the way in, so a second pass changes nothing.
  const precise = range.parseTimeRange({ from: "2026-10-13T08:00:00.987Z", to: "2026-10-13T09:00:00.100Z" }).value;
  assert.equal(precise.from % 1000, 0);
  assert.deepEqual(range.parseTimeRange(range.timeRangeQuery(precise)).value, precise);
  // Epoch milliseconds are read like 04 §11 accepts them.
  assert.deepEqual(range.parseTimeRange({ from: String(value.from), to: String(value.to) }).value, value);
});

test("unusable ranges fall back and say why", () => {
  const cases = [
    ["?range=2h", "invalid"],
    ["?from=2026-10-13T08:00:00Z", "invalid"],
    ["?from=nope&to=also", "invalid"],
    ["?from=2026-10-14T08:00:00Z&to=2026-10-13T08:00:00Z", "order"],
    ["?from=2026-10-13T08:00:00Z&to=2026-10-13T08:00:00Z", "order"],
    ["?from=2024-01-01T00:00:00Z&to=2026-10-13T08:00:00Z", "tooLong"],
  ];
  for (const [search, problem] of cases) {
    const parsed = range.parseTimeRange(search);
    assert.equal(parsed.valid, false, search);
    assert.equal(parsed.problem, problem, search);
    assert.deepEqual(parsed.value, { range: "24h" }, search);
  }
  const capped = range.parseTimeRange("?from=2026-10-01T00:00:00Z&to=2026-10-20T00:00:00Z", { maxRangeDays: 7 });
  assert.equal(capped.problem, "tooLong", "maxRangeDays is honored");
  assert.equal(range.rangeProblem({ from: 5, to: 4 }), "order");
  assert.equal(range.rangeProblem({ range: "30d" }), null);
});

test("applyTimeRange replaces only the range parameters", () => {
  assert.equal(range.applyTimeRange("?model=a&range=1h&tab=x", { range: "7d" }), "?model=a&tab=x&range=7d");
  const custom = { from: Date.parse("2026-10-13T08:00:00Z"), to: Date.parse("2026-10-13T10:00:00Z") };
  const search = range.applyTimeRange("?range=1h&model=a", custom);
  assert.equal(new URLSearchParams(search).get("range"), null, "a custom range drops ?range=");
  assert.equal(new URLSearchParams(search).get("model"), "a");
  assert.deepEqual(range.parseTimeRange(search).value, custom);
  assert.equal(range.applyTimeRange("", { range: "15m" }), "?range=15m");
});

test("windows, previous window, step and datetime-local", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  assert.deepEqual(range.resolveTimeRange({ range: "1h" }, now), { from: now - 3600000, to: now });
  assert.deepEqual(range.resolveTimeRange({ from: 1000, to: 5000 }, now), { from: 1000, to: 5000 });
  assert.deepEqual(range.previousWindow({ from: 1000000, to: 1600000 }), { from: 400000, to: 1000000 });
  // 24 h at 600 points needs at least 144 s: the next nice step is 300 s.
  assert.equal(range.suggestStep(range.resolveTimeRange({ range: "24h" }, now)), 300);
  assert.equal(range.suggestStep(range.resolveTimeRange({ range: "15m" }, now)), 10);
  assert.equal(range.suggestStep(range.resolveTimeRange({ range: "30d" }, now)), 10800);
  assert.equal(range.suggestStep({ from: 0, to: 400 * 86400000 }), 86400);
  assert.ok(range.sameTimeRange({ range: "1h" }, { range: "1h" }));
  assert.ok(!range.sameTimeRange({ range: "1h" }, { from: 1, to: 2 }));
  const local = range.toDatetimeLocal(Date.parse("2026-10-13T08:05:30Z"));
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(range.fromDatetimeLocal(local), Math.floor(Date.parse("2026-10-13T08:05:30Z") / 60000) * 60000, "minute precision, same zone");
  assert.equal(range.fromDatetimeLocal("garbage"), null);
  assert.equal(range.toDatetimeLocal(NaN), "");
});

test("metric ids are 04's catalog, unique, well formed and labelled", async () => {
  const ids = await load("data/metric-ids.js");
  assert.equal(new Set(ids.METRIC_IDS).size, ids.METRIC_IDS.length, "no duplicate id");
  for (const id of ids.METRIC_IDS) {
    assert.match(id, /^[a-z]+\.[a-z0-9_]+$/, id);
    assert.ok(ids.isMetricId(id));
  }
  for (const id of ["req.count", "lat.ttft_p95", "rt.kv_usage", "gpu.mem_used_mb", "lat.ttft_hist", "energy.cost"]) assert.ok(ids.isMetricId(id), id);
  assert.equal(ids.metricFamily("lat.ttft_p95"), "req");
  assert.equal(ids.metricFamily("rt.kv_usage"), "rt");
  assert.equal(ids.metricFamily("gpu.util"), "gpu");
  assert.equal(ids.metricFamily("nope.x"), null);
  assert.equal(ids.metricLabelKey("req.count"), "obs.metric.req.count");
  assert.equal(ids.MAX_METRICS_PER_QUERY, 6);
  // 04 TEL-19 creates the telemetry area; once it exists, every id needs a label in both locales.
  for (const locale of ["zh-CN", "en-US"]) {
    const file = path.join(CONSOLE_DIR, "i18n", "telemetry", `${locale}.json`);
    if (!fs.existsSync(file)) continue;
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    const missing = ids.METRIC_IDS.filter((id) => !catalog[ids.metricLabelKey(id)]);
    assert.deepEqual(missing, [], `${locale} labels`);
  }
});

const chart = await load("components/time-series-chart.js");

test("gaps stay gaps: null is kept, junk becomes null, short series are padded", () => {
  assert.deepEqual(chart.cleanValues([1, null, undefined, NaN, "x", 5, Infinity], 8), [1, null, null, null, null, 5, null, null]);
  const model = chart.prepareChart({ x: [10, 20, 30, 40], series: [{ id: "a", label: "A", unit: "ms", values: [1, null, 3] }] });
  assert.deepEqual(model.data, [[10, 20, 30, 40], [1, null, 3, null]]);
  assert.equal(model.gaps, 2);
  assert.equal(model.points, 2);
  assert.deepEqual(chart.isolatedIndices([1, null, 3, null, null, 6, 7]), [0, 2], "a lone point between gaps gets a dot");
  assert.deepEqual(chart.isolatedIndices([null, 1, 2, null]), []);
});

test("a stack adds up present values, keeps a gap in its own band and drops hidden series", () => {
  const series = [
    { id: "a", unit: "req", values: [1, 2, 3] },
    { id: "b", unit: "req", values: [10, null, 30] },
    { id: "c", unit: "req", values: [100, 200, 300] },
  ];
  const stacked = chart.prepareChart({ x: [1, 2, 3], series, stacked: true });
  assert.equal(stacked.stacked, true);
  assert.deepEqual(stacked.plotted.map((row) => row.id), ["c", "b", "a"], "largest band first");
  assert.deepEqual(stacked.plotted[0].plot, [111, 202, 333]);
  assert.deepEqual(stacked.plotted[1].plot, [11, null, 33], "the gap is not a zero");
  assert.deepEqual(stacked.rows[1].values, [10, null, 30], "the table keeps the real values");
  const without = chart.prepareChart({ x: [1, 2, 3], series, stacked: true, hidden: new Set(["a"]) });
  assert.deepEqual(without.plotted.map((row) => row.id), ["c", "b"]);
  assert.deepEqual(without.plotted[0].plot, [110, 200, 330], "a hidden series leaves the stack");
  assert.equal(without.rows.length, 3, "but stays in the table and the legend");
  const mixed = chart.prepareChart({ x: [1], series: [{ id: "a", unit: "ms", values: [1] }, { id: "b", unit: "req", values: [2] }], stacked: true });
  assert.equal(mixed.stacked, false, "different units are never stacked");
  assert.deepEqual(mixed.units, ["ms", "req"]);
});

test("tooltip rows show the actual values and a gap as a dash", () => {
  const model = chart.prepareChart({ x: [1760342400, 1760342460], stacked: true, series: [{ id: "a", label: "2xx", unit: "req", values: [5, 7] }, { id: "b", label: "5xx", unit: "req", values: [1, null] }] });
  const info = chart.tooltipRows(model, 1, fmt);
  assert.match(info.title, /Oct 13, 2025/);
  assert.deepEqual(info.rows.map((row) => row.text), ["7 req", "—"]);
  assert.equal(info.rows[1].gap, true);
  assert.equal(chart.tooltipRows(model, 9, fmt), null);
  assert.equal(chart.formatPoint(12.345, "ms", fmt), "12.35 ms");
  assert.equal(chart.formatPoint(0.25, "ratio", fmt), "25.0%");
  assert.equal(chart.formatPoint(null, "ms", fmt), "—");
});

test("uPlot options never join gaps, hide the built-in legend and brush in ms", () => {
  const model = chart.prepareChart({ x: [1, 2, 3, 4, 5], stacked: false, series: [{ id: "a", label: "A", unit: "ms", values: [1, null, 3, null, 5] }, { id: "b", label: "B", unit: "req", values: [1, 2, 3, 4, 5] }] });
  const colors = chart.readChartColors(null);
  const options = chart.buildPlotOptions(model, { width: 400, height: 200, colors, fmt, yUnits: ["ms", "requests"], hooks: {} });
  assert.equal(options.legend.show, false);
  assert.equal(options.series.length, 3, "x plus two");
  assert.ok(options.series.slice(1).every((s) => s.spanGaps === false));
  assert.deepEqual(options.series[1].points.filter(), [0, 2, 4], "isolated points are dotted");
  assert.equal(options.series[2].points.filter(), null);
  assert.deepEqual(options.series.slice(1).map((s) => s.scale), ["y", "y2"], "one scale per unit");
  assert.deepEqual(options.axes.filter((axis) => axis.scale).map((axis) => axis.label), ["ms", "requests"]);
  assert.equal(options.cursor.drag.x, true);
  assert.equal(options.cursor.drag.y, false);
  const stacked = chart.buildPlotOptions(chart.prepareChart({ x: [1, 2], stacked: true, series: [{ id: "a", unit: "req", values: [1, 2] }] }), { width: 1, height: 1, colors, fmt });
  assert.match(stacked.series[1].fill, /^rgba\(/, "stacked bands are filled");
  const plot = { select: { left: 100, width: 50 }, posToVal: (px) => 1760342400 + px };
  assert.deepEqual(chart.brushRange(plot), { from: 1760342500000, to: 1760342550000 });
  assert.equal(chart.brushRange({ select: { left: 5, width: 1 }, posToVal: () => 1 }), null, "a click is not a brush");
  assert.equal(chart.annotationMs(1760342400), 1760342400000);
  assert.equal(chart.annotationMs(1760342400000), 1760342400000);
  assert.equal(chart.annotationMs("x"), null);
  assert.equal(chart.annotationMs(null), null);
  assert.equal(chart.withAlpha("#2563eb", 0.5), "rgba(37, 99, 235, 0.5)");
});

const gpu = await load("components/gpu-memory-bar.js");

test("GpuMemoryBar: the total equals its segments, and over-budget is derived", () => {
  const segments = [{ kind: "weights", mb: 41000 }, { kind: "kv", mb: 22000.5 }, { kind: "activations", mb: 4200 }, { kind: "mmproj", mb: 0 }, { kind: "x-new", mb: 100 }];
  const model = gpu.gpuMemoryModel({ gpu: { id: "g", name: "GPU", totalMb: 98304 }, segments, budgetMb: 60000, admissionMb: 70000, otherTenantsMb: 6000 });
  assert.equal(model.segmentsMb, 41000 + 22000.5 + 4200 + 100);
  assert.equal(model.usedMb, model.segmentsMb + 6000);
  assert.equal(model.usedMb, model.parts.reduce((sum, part) => sum + part.mb, 0), "table total = sum of its rows");
  assert.equal(model.freeMb, 98304 - model.usedMb);
  assert.equal(model.overBudgetMb, model.usedMb - 60000);
  assert.equal(model.overTotalMb, 0);
  assert.equal(model.parts[model.parts.length - 1].kind, "tenants");
  assert.equal(gpu.segmentClass("weights"), "gpu-seg-weights");
  assert.equal(gpu.segmentClass("tenants"), "gpu-seg-tenants");
  assert.equal(gpu.segmentClass("x-new"), "gpu-seg-unknown");
  const over = gpu.gpuMemoryModel({ gpu: { totalMb: 1000 }, segments: [{ kind: "weights", mb: 1500 }], budgetMb: 900 });
  assert.equal(over.overTotalMb, 500);
  assert.equal(over.scaleMb, 1500, "the bar widens to hold the use");
  assert.equal(over.freeMb, 0);
  const none = gpu.gpuMemoryModel({});
  assert.equal(none.usedMb, 0);
  assert.equal(none.overBudgetMb, 0);
  assert.equal(none.scaleMb, 1);
  const bad = gpu.gpuMemoryModel({ gpu: { totalMb: "x" }, segments: [{ kind: "kv", mb: -5 }, { kind: "kv", mb: "7" }, null], otherTenantsMb: -1 });
  assert.equal(bad.usedMb, 7, "negative and non-numeric sizes count as zero");
});

test("chart components exist, export their component and obey the shared rules", async () => {
  for (const [file, name] of [["time-series-chart.js", "TimeSeriesChart"], ["time-range-picker.js", "TimeRangePicker"], ["gpu-memory-bar.js", "GpuMemoryBar"]]) {
    const module = await load(`components/${file}`);
    assert.equal(typeof module[name], "function", `${file} exports ${name}`);
    const source = fs.readFileSync(path.join(CONSOLE_DIR, "components", file), "utf8");
    assert.match(source, /data-testid|testid/, `${file} carries data-testid hooks`);
    assert.equal(/\sstyle="/.test(source), false, `${file} must not write a style attribute (CSP style-src 'self')`);
  }
  assert.equal(typeof (await load("components/time-range-picker.js")).useTimeRangeParam, "function");
  const kit = fs.readFileSync(path.join(CONSOLE_DIR, "routes", "system", "ui-kit.js"), "utf8");
  assert.match(kit, /ui-kit\/charts\.js/, "the kit lists the chart section");
});

test("uPlot is requested only by the chart component", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name) && /uplot/i.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(CONSOLE_DIR, full).replaceAll("\\", "/"));
    }
  };
  walk(CONSOLE_DIR);
  assert.deepEqual(offenders.filter((file) => file !== "ui/vendor-lazy.js" && file !== "components/time-series-chart.js"), []);
});
