// The pure part of the Observability pages (07 §6.7, 04 §19): URL state,
// request parameters, and the shaping of 04's answers for charts, tiles,
// heatmap and Gantt. Nothing here touches the DOM or the clock; `now` and the
// search string are always passed in, so the tests run in Node.
//
// URL state: `?range=24h` or `?from=&to=` (lib/time-range.js), the common
// filters of 04 §11 (`manager_id, fleet_id, engine_id, model, key_id,
// source_program, protocol`) and `refresh=1` for the auto-refresh toggle.

import { applyTimeRange, parseTimeRange, resolveTimeRange, serializeTimeRange } from "./time-range.js";

/** 04 §11 common filters offered in the header (the names the endpoints whitelist). */
export const FILTER_IDS = Object.freeze(["manager_id", "fleet_id", "engine_id", "model", "key_id", "source_program", "protocol"]);
/** The filters that name a person's key or a client program; hidden for a read-only viewer (04 §11.8). */
export const OWNER_FILTERS = Object.freeze(["key_id"]);
export const REFRESH_MS = 30_000;
export const FILTER_MAX_LENGTH = 200;

/** The sub-pages in header order; `path` is the route (routes.js); `owner` pages are hidden from a viewer. */
export const SUBPAGES = Object.freeze([
  Object.freeze({ id: "overview", path: "/observability" }),
  Object.freeze({ id: "performance", path: "/observability/performance" }),
  Object.freeze({ id: "traffic", path: "/observability/traffic" }),
  Object.freeze({ id: "errors", path: "/observability/errors" }),
  Object.freeze({ id: "gpu", path: "/observability/gpu" }),
  Object.freeze({ id: "models", path: "/observability/models" }),
  Object.freeze({ id: "requests", path: "/observability/requests" }),
  Object.freeze({ id: "settings", path: "/observability/settings", owner: true }),
]);

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// URL state

/**
 * The view state of a search string.
 * @returns {{ range, rangeValid, rangeProblem, filters: Record<string,string>, refresh: boolean }}
 */
export function parseObsSearch(search, { fallback = "24h" } = {}) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const range = parseTimeRange(params, { fallback });
  const filters = {};
  for (const id of FILTER_IDS) {
    const value = (params.get(id) || "").trim();
    if (value) filters[id] = value.slice(0, FILTER_MAX_LENGTH);
  }
  return { range: range.value, rangeValid: range.valid, rangeProblem: range.problem, filters, refresh: params.get("refresh") === "1" };
}

/**
 * `search` with a patch applied; every parameter the patch does not name stays, in order.
 * @param patch { range?, filters?: {name: value|null}, refresh?: boolean, extra?: {name: value|null} }
 * @returns {string} "?…" or ""
 */
export function patchObsSearch(search, patch = {}) {
  const base = patch.range ? applyTimeRange(String(search || ""), patch.range) : String(search || "");
  const params = new URLSearchParams(base.replace(/^\?/, ""));
  const put = (name, value) => {
    if (value === null || value === undefined || value === "" || value === false) params.delete(name);
    else params.set(name, value === true ? "1" : String(value));
  };
  for (const [name, value] of Object.entries(patch.filters || {})) if (FILTER_IDS.includes(name)) put(name, typeof value === "string" ? value.trim().slice(0, FILTER_MAX_LENGTH) : value);
  if (Object.hasOwn(patch, "refresh")) put("refresh", Boolean(patch.refresh));
  for (const [name, value] of Object.entries(patch.extra || {})) put(name, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The view state a link to another sub-page carries: range, filters and refresh, plus `extra`. */
export function carrySearch(search, extra = {}) {
  const state = parseObsSearch(search);
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(serializeTimeRange(state.range))) params.set(name, value);
  for (const [name, value] of Object.entries(state.filters)) params.set(name, value);
  if (state.refresh) params.set("refresh", "1");
  for (const [name, value] of Object.entries(extra)) if (value !== null && value !== undefined && value !== "") params.set(name, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** A stable text for a state's range and filters (a cache key part). */
export function stateKey(state) {
  const range = serializeTimeRange(state.range);
  return JSON.stringify([range, Object.entries(state.filters).sort(([a], [b]) => (a < b ? -1 : 1))]);
}

/** `{ from, to }` as ISO 8601 UTC in whole seconds for the window at `now`. */
export function windowBounds(range, now) {
  const span = resolveTimeRange(range, now);
  const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
  return { from: iso(span.from), to: iso(span.to), fromMs: span.from, toMs: span.to };
}

/**
 * Which of the view state each endpoint accepts (04 §11 answers 400
 * `unknown_parameter` to anything else): `full` takes the window and every
 * common filter; `range` only the window (and `events` also `fleet_id`);
 * `none` takes no parameter beyond the call's own.
 */
export const ENDPOINT_MODE = Object.freeze({
  summary: "full", timeseries: "full", breakdown: "full", requests: "full",
  events: "range", energy: "range", lifecycle: "range", launches: "range",
  live: "none", status: "none", baseline: "none", settings: "none", import: "none",
});

/** The query of GET /api/telemetry/<endpoint>: the window and filters it accepts plus the call's own parameters. */
export function queryFor(endpoint, state, now, extra = {}) {
  const mode = ENDPOINT_MODE[endpoint] || "full";
  if (mode === "none") return { ...extra };
  const { from, to } = windowBounds(state.range, now);
  if (mode === "range") return { from, to, ...(endpoint === "events" && state.filters.fleet_id ? { fleet_id: state.filters.fleet_id } : {}), ...extra };
  return { from, to, ...state.filters, ...extra };
}

/** The part of the view state an endpoint's answer depends on (a cache key part). */
export function keyFor(endpoint, state) {
  const mode = ENDPOINT_MODE[endpoint] || "full";
  if (mode === "none") return "";
  const range = JSON.stringify(serializeTimeRange(state.range));
  return mode === "range" ? range : stateKey(state);
}

// ---------------------------------------------------------------------------
// Series, groups, annotations

/**
 * The annotation kind a 04 event type draws as (the chart knows launch,
 * restart, config and alert): launches stay launches, container, instance and
 * manager events are restarts, configuration and benchmark runs are config
 * changes.
 */
export function annotationKind(type) {
  const head = String(type || "").split(".")[0];
  if (head === "launch") return "launch";
  if (head === "alert") return "alert";
  if (head === "instance" || head === "container" || head === "manager") return "restart";
  return "config";
}

/** `annotations` of a timeseries answer as the chart wants them. */
export function chartAnnotations(answer) {
  return list(answer?.annotations)
    .filter((item) => isObject(item) && finite(Number(item.at)) !== null)
    .map((item) => ({ at: Number(item.at), kind: annotationKind(item.type), label: typeof item.title === "string" && item.title ? item.title : String(item.type || "") }));
}

/** A group object as a stable text: `{model: "a"}` → "model=a". */
export function groupKey(group) {
  if (!isObject(group)) return "";
  if (group.other === true) return "other";
  return Object.entries(group).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => `${name}=${value}`).join(",");
}

/**
 * Series of a timeseries answer on one shared time axis.
 * @param options.metricLabel (metric) → text
 * @param options.groupText (group) → text, "" for no group
 * @param options.skip (metric) → true leaves the series out
 * @returns {{ x: number[], series: Array<{ id, metric, label, unit, values }>, gaps: number, points: number, annotations }}
 *   x in epoch seconds; a missing sample or a null value is a gap (`null`).
 */
export function chartData(answer, { metricLabel = (metric) => metric, groupText = () => "", skip = () => false } = {}) {
  const items = list(answer?.series).filter((item) => isObject(item) && Array.isArray(item.points) && !skip(item.metric));
  const stamps = new Set();
  for (const item of items) for (const point of item.points) if (Array.isArray(point) && finite(point[0]) !== null) stamps.add(point[0]);
  const axis = [...stamps].sort((a, b) => a - b);
  let gaps = 0;
  let points = 0;
  const series = items.map((item) => {
    const byStamp = new Map(item.points.filter(Array.isArray).map((point) => [point[0], finite(point[1])]));
    const values = axis.map((stamp) => (byStamp.has(stamp) ? byStamp.get(stamp) : null));
    for (const value of values) {
      if (value === null) gaps += 1;
      else points += 1;
    }
    const group = groupText(item.group);
    const label = metricLabel(item.metric);
    return { id: `${item.metric}|${groupKey(item.group)}`, metric: item.metric, label: group ? `${label} · ${group}` : label, unit: typeof item.unit === "string" ? item.unit : "", values };
  });
  return { x: axis.map((stamp) => Math.round(stamp / 1000)), series, gaps, points, annotations: chartAnnotations(answer) };
}

/** A chart with only the series of these metrics. */
export function onlyMetrics(chart, metrics) {
  return { ...chart, series: chart.series.filter((item) => metrics.includes(item.metric)) };
}

/** Whether a group is the "everything else" bucket 04 folds past `top` groups. */
export const isOtherGroup = (group) => isObject(group) && group.other === true;

/** The engine latency metrics a `latency_source: none` instance cannot report (04 §7). */
export const ENGINE_LATENCY_METRICS = Object.freeze(["rt.ttft_p50", "rt.ttft_p95", "rt.ttft_p99", "rt.e2e_p50", "rt.e2e_p95", "rt.itl_p50", "rt.itl_p95", "rt.tpot_p50", "rt.queue_p95"]);

/** The latency source of a live instance: engine_histogram, gateway, none or null (not reported). */
export function latencySourceOf(instance) {
  const value = instance?.latencySource ?? instance?.latency_source;
  return typeof value === "string" && value ? value : null;
}

/**
 * The metrics an engine does not report (04 §19 edge state): listed in the
 * answer's `unsupported`, flagged on a series, or an engine latency metric of
 * a fleet whose `/live` latency source is `none`.
 * @returns {string[]} metric ids
 */
export function unsupportedMetrics(answer, live) {
  const out = new Set();
  for (const id of list(answer?.unsupported)) if (typeof id === "string") out.add(id);
  const none = new Set(list(live?.instances).filter((item) => latencySourceOf(item) === "none").map((item) => item.fleetId));
  for (const item of list(answer?.series)) {
    if (!isObject(item)) continue;
    if (item.unsupported === true) out.add(item.metric);
    if (ENGINE_LATENCY_METRICS.includes(item.metric) && isObject(item.group) && Object.values(item.group).some((value) => none.has(value))) out.add(item.metric);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// KPI tiles

/** Per tile: the summary field(s), formatter kind, unit, which direction is good, and the sparkline metric. */
export const KPI_TILES = Object.freeze([
  Object.freeze({ id: "requests", labelKey: "obs.kpi.requests", kind: "integer", unit: "", good: "up", spark: "req.count" }),
  Object.freeze({ id: "errorRate", labelKey: "obs.kpi.errorRate", kind: "percent", unit: "", good: "down", spark: "req.error_rate" }),
  Object.freeze({ id: "ttftP95", labelKey: "obs.kpi.ttftP95", kind: "ms", unit: "ms", good: "down", spark: "lat.ttft_p95" }),
  Object.freeze({ id: "decodeTps", labelKey: "obs.kpi.decodeTps", kind: "rate", unit: "tokens/s", good: "up", spark: null }),
  Object.freeze({ id: "tokensOut", labelKey: "obs.kpi.tokensOut", kind: "tokens", unit: "", good: "up", spark: "tok.output_per_s" }),
  Object.freeze({ id: "cachedShare", labelKey: "obs.kpi.cachedShare", kind: "percent", unit: "", good: "up", spark: null }),
  Object.freeze({ id: "gpuUtil", labelKey: "obs.kpi.gpuUtil", kind: "gpu", unit: "%", good: "up", spark: null }),
  Object.freeze({ id: "energy", labelKey: "obs.kpi.energy", kind: "kwh", unit: "kWh", good: "down", spark: null }),
  Object.freeze({ id: "cost", labelKey: "obs.kpi.cost", kind: "cost", unit: "", good: "down", spark: null }),
]);

/** The sparkline metrics of the tiles, in the order of 04 §19. */
export const SPARK_METRICS = Object.freeze(KPI_TILES.map((tile) => tile.spark).filter(Boolean));

/** One number of a summary period by tile id (null when it is not known). */
export function kpiValue(period, id) {
  if (!isObject(period)) return null;
  switch (id) {
    case "requests": return finite(period.requests);
    case "errorRate": return finite(period.errorRate);
    case "ttftP95": return finite(period.ttftP95Ms);
    case "decodeTps": return finite(period.decodeTpsP50);
    case "tokensOut": return finite(period.outputTokens);
    case "cachedShare": {
      const prompt = finite(period.promptTokens);
      const cached = finite(period.cachedTokens);
      return prompt && cached !== null ? cached / prompt : null;
    }
    case "gpuUtil": return finite(period.gpuUtilAvg);
    case "energy": return finite(period.energyKwh);
    case "cost": return finite(period.energyCost);
    default: return null;
  }
}

/** The relative change from `previous` to `current`, or null when it has no meaning (no previous, or zero). */
export function relativeDelta(current, previous) {
  if (current === null || previous === null || previous === 0) return null;
  const value = (current - previous) / Math.abs(previous);
  return Number.isFinite(value) ? value : null;
}

function formatValue(kind, value, fmt, currency) {
  if (value === null) return { text: null, unit: "" };
  switch (kind) {
    case "integer": return { text: fmt.integer(value), unit: "" };
    case "percent": return { text: fmt.percent(value, 1), unit: "" };
    case "ms": return { text: fmt.number(value, 0), unit: "ms" };
    case "rate": return { text: fmt.number(value, 1), unit: "tokens/s" };
    case "tokens": return { text: fmt.tokens(value), unit: "" };
    case "gpu": return { text: fmt.number(value, 0), unit: "%" };
    case "kwh": return { text: fmt.number(value, 2), unit: "kWh" };
    case "cost": return { text: fmt.number(value, 2), unit: currency || "" };
    default: return { text: fmt.number(value), unit: "" };
  }
}

/**
 * The KPI tiles of GET /api/telemetry/summary?compare=previous (04 §11.2).
 * Every tile carries `windowText`; a delta needs a non-zero previous value. The
 * requests tile says "idle" when nothing was served, and the cost tile says
 * "no price" when the summary has no cost.
 * @param inputs { summary, sparks: Record<metricId, number[]> }
 * @param ctx { t, fmt, windowText }
 * @returns {Array<{ id, label, value, unit, windowText, delta, sparkline, note, noteKey, status }>}
 */
export function kpiTiles({ summary = null, sparks = {} } = {}, { t, fmt, windowText }) {
  const current = isObject(summary?.current) ? summary.current : null;
  const previous = isObject(summary?.previous) ? summary.previous : null;
  const currency = typeof current?.currency === "string" ? current.currency : "";
  return KPI_TILES.map((tile) => {
    const now = kpiValue(current, tile.id);
    const before = kpiValue(previous, tile.id);
    const shown = formatValue(tile.kind, now, fmt, currency);
    const change = relativeDelta(now, before);
    let noteKey = null;
    if (tile.id === "requests" && now === 0) noteKey = "obs.idle";
    if (tile.id === "cost" && now === null) noteKey = "obs.noPrice";
    return {
      id: tile.id,
      label: t(tile.labelKey),
      value: shown.text,
      unit: shown.unit,
      windowText,
      delta: change === null ? null : { value: change, goodWhen: tile.good, text: `${change > 0 ? "+" : ""}${fmt.percent(change, 1)}` },
      sparkline: tile.spark && Array.isArray(sparks[tile.spark]) ? sparks[tile.spark] : null,
      noteKey,
      note: noteKey ? t(noteKey) : "",
      status: undefined,
    };
  });
}

/** The values of each sparkline metric from a timeseries answer (a gap stays `null`, the chart skips it). */
export function sparkValues(answer) {
  const out = {};
  for (const item of list(answer?.series)) {
    if (!isObject(item) || !Array.isArray(item.points) || (isObject(item.group) && Object.keys(item.group).length)) continue;
    out[item.metric] = item.points.filter(Array.isArray).sort((a, b) => a[0] - b[0]).map((point) => finite(point[1]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live strip

/**
 * The numbers of the live strip, each with the window it covers (04 §11.1).
 * @returns {Array<{ id, labelKey, value, unit, windowKey, windowVars }>}
 */
export function liveTiles(live, fmt) {
  const gateway = isObject(live?.gateway) ? live.gateway : null;
  if (!gateway) return [];
  const seconds = finite(live.windowSeconds) ?? 60;
  const num = (value, digits = 0) => (finite(value) === null ? null : fmt.number(value, digits));
  return [
    { id: "inflight", labelKey: "obs.live.inflight", value: num(gateway.inflight), unit: "", windowKey: "obs.live.now", windowVars: {} },
    { id: "rpm", labelKey: "obs.live.rpm", value: num(gateway.requestsPerMin, 1), unit: "/min", windowKey: "obs.live.lastSeconds", windowVars: { seconds } },
    { id: "tps", labelKey: "obs.live.tps", value: num(gateway.outputTokensPerSec, 1), unit: "tokens/s", windowKey: "obs.live.lastSeconds", windowVars: { seconds } },
    { id: "error", labelKey: "obs.live.errorRate", value: finite(gateway.errorRate5m) === null ? null : fmt.percent(gateway.errorRate5m, 1), unit: "", windowKey: "obs.live.last5m", windowVars: {} },
    { id: "ttft", labelKey: "obs.live.ttftP95", value: num(gateway.ttftP95Ms5m), unit: "ms", windowKey: "obs.live.last5m", windowVars: {} },
    { id: "aborts", labelKey: "obs.live.aborts", value: num(gateway.clientAborts5m), unit: "", windowKey: "obs.live.last5m", windowVars: {} },
  ];
}

// ---------------------------------------------------------------------------
// Heatmap (lat.ttft_hist)

/**
 * The matrix of the TTFT histogram series (04 §11.3): `points` are
 * `[t, [count per bucket]]` and the answer carries `le`, the bucket upper
 * bounds in ms. A bucket count beyond `le` is the open last bucket.
 * @returns {{ times: number[], buckets: Array<{ le: number|null }>, cells: number[][], max: number, empty: boolean }}
 *   cells[column][bucket]; a null count is a gap.
 */
export function heatmapModel(answer) {
  const item = list(answer?.series).find((entry) => isObject(entry) && entry.metric === "lat.ttft_hist" && Array.isArray(entry.points));
  const bounds = list(answer?.le).map((value) => finite(value));
  if (!item) return { times: [], buckets: bounds.map((le) => ({ le })), cells: [], max: 0, empty: true };
  const rows = item.points.filter((point) => Array.isArray(point) && finite(point[0]) !== null).sort((a, b) => a[0] - b[0]);
  const width = Math.max(bounds.length, ...rows.map((point) => (Array.isArray(point[1]) ? point[1].length : 0)));
  const buckets = Array.from({ length: width }, (_, index) => ({ le: index < bounds.length ? bounds[index] : null }));
  const cells = rows.map((point) => Array.from({ length: width }, (_, index) => (Array.isArray(point[1]) ? finite(point[1][index]) : null)));
  let max = 0;
  let total = 0;
  for (const column of cells) for (const count of column) if (count !== null) {
    max = Math.max(max, count);
    total += count;
  }
  return { times: rows.map((point) => point[0]), buckets, cells, max, empty: !rows.length || total === 0 };
}

/** The shade step 0..steps of a count (0 only for a zero count; the busiest cell gets `steps`). */
export function heatStep(count, max, steps = 5) {
  if (count === null || count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(steps, Math.ceil((count / max) * steps)));
}

// ---------------------------------------------------------------------------
// Lifecycle Gantt

const GANTT_STATES = Object.freeze(["loading", "ready", "sleeping", "crashed"]);

function instant(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Rows of GET /api/telemetry/lifecycle clipped to the window.
 * An interval with no end is still going and runs to the end of the window.
 * @returns {{ from: number, to: number, rows: Array<{ key, fleetId, model, engineId, bars: Array<{ state, from, to, left, width, launchId }> }> }}
 *   left and width are percentages of the window.
 */
export function ganttModel(answer, span) {
  const length = Math.max(1, span.to - span.from);
  const rows = list(answer?.instances).filter(isObject).map((item, index) => {
    const bars = list(item.intervals).filter(isObject).map((interval) => {
      const start = instant(interval.from);
      const end = interval.to === null || interval.to === undefined ? span.to : instant(interval.to);
      if (start === null || end === null) return null;
      const from = Math.max(span.from, start);
      const to = Math.min(span.to, Math.max(end, start));
      if (to < span.from || from > span.to) return null;
      const state = GANTT_STATES.includes(interval.state) ? interval.state : "loading";
      return { state, from, to, left: ((from - span.from) / length) * 100, width: Math.max(0.4, ((to - from) / length) * 100), launchId: typeof interval.launchId === "string" ? interval.launchId : "" };
    }).filter(Boolean);
    return { key: `${item.fleetId ?? index}`, fleetId: String(item.fleetId ?? ""), model: typeof item.model === "string" ? item.model : "", engineId: typeof item.engineId === "string" ? item.engineId : "", bars };
  });
  return { from: span.from, to: span.to, rows };
}

export const GANTT_STATE_IDS = GANTT_STATES;

// ---------------------------------------------------------------------------
// Tables

/** The counts of a breakdown row with the share of the total, as plain numbers. */
export function breakdownRows(answer) {
  return list(answer?.rows).filter(isObject).map((row, index) => ({
    ...row,
    key: row.key === null || row.key === undefined ? "" : String(row.key),
    rowId: `${index}:${row.key ?? ""}`,
    requests: finite(row.requests) ?? 0,
    share: finite(row.share),
    spark: Array.isArray(row.spark) ? row.spark.map(finite) : null,
    sampleRequestIds: list(row.sampleRequestIds).filter((id) => typeof id === "string"),
  }));
}

/** The text of a breakdown label `{zh, en}` for a locale (falls back to the key). */
export function labelText(row, locale) {
  const label = row?.label;
  if (isObject(label)) {
    const short = String(locale || "").startsWith("zh") ? "zh" : "en";
    const text = label[short] ?? label[locale];
    if (typeof text === "string" && text) return text;
  }
  return typeof label === "string" && label ? label : String(row?.key ?? "");
}

/** The cost-per-million-output-tokens line of an energy row, or null. */
export function energyRows(answer) {
  return list(answer?.rows).filter(isObject).map((row) => ({
    key: String(row.key ?? ""),
    energyWh: finite(row.energyWh),
    idleWh: finite(row.idleWh),
    cost: finite(row.cost),
    outputTokens: finite(row.outputTokens),
    costPerMOutputTokens: finite(row.costPerMOutputTokens),
  }));
}

/** Whether energy is priced: the answer's `priceConfigured` (04 §11.7), false when absent. */
export function priceConfigured(answer) {
  return answer?.priceConfigured === true;
}

/** Rows of launches?groupBy=model (04 §11.7). */
export function launchRows(answer) {
  return list(answer?.rows).filter(isObject).map((row) => ({
    key: String(row.key ?? ""),
    started: finite(row.started) ?? 0,
    ready: finite(row.ready) ?? 0,
    failed: finite(row.failed) ?? 0,
    readyP50Seconds: finite(row.readyP50Seconds),
    readyP95Seconds: finite(row.readyP95Seconds),
    topFailures: list(row.topFailures).filter(isObject).map((item) => ({ signature: String(item.signature ?? ""), count: finite(item.count) ?? 0 })),
  }));
}

// ---------------------------------------------------------------------------
// States

/** The page reads as redacted when the user is not the owner or the answer says so (04 §11.8 `viewer: true`). */
export function isReadOnlyView(role, ...answers) {
  return role !== "owner" || answers.some((answer) => isObject(answer) && answer.viewer === true);
}

/** Whether a live instance is idle (no requests, nothing running): the explicit flag, else running = 0 with a sample. */
export function isIdleInstance(instance) {
  if (!isObject(instance)) return false;
  if (typeof instance.idle === "boolean") return instance.idle;
  return finite(instance.running) === 0 && finite(instance.waiting) === 0;
}

/** Sorts firing alerts critical first, then by `since` (oldest first). */
export function firingAlerts(answer) {
  const rank = { critical: 0, warning: 1, info: 2 };
  return list(answer?.rows).filter((row) => isObject(row) && row.state === "firing")
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || String(a.since ?? "").localeCompare(String(b.since ?? "")));
}

/** The text of a localized `{zh, en}` title for a locale. */
export function localizedTitle(title, locale) {
  if (typeof title === "string") return title;
  if (!isObject(title)) return "";
  const short = String(locale || "").startsWith("zh") ? "zh" : "en";
  return String(title[short] ?? title[locale] ?? title.en ?? title.zh ?? "");
}

/** The link to the Requests list prefiltered to an error class, keeping the view state (04 §19 Errors). */
export function requestsHref(search, filter) {
  return `/observability/requests${carrySearch(search, filter)}`;
}

/** How an instance state reads as a badge; anything unknown is grey. */
export const INSTANCE_STATUS = Object.freeze({
  ready: "ok", running: "ok", loading: "info", starting: "info", launching: "info", sleeping: "neutral", stopped: "neutral", failed: "error", crashed: "error", error: "error",
});
