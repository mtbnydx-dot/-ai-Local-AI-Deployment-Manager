// TimeSeriesChart (07 §4.4, §3.1, §4.3): a line or stacked-area chart over
// uPlot, which loads on first use (loadUplot()) and only when a chart is
// actually shown, never with the shell. `null` values are gaps and draw as
// breaks (a lone point between two gaps is dotted so it stays visible). The
// canvas is decorative for assistive technology: the container is a
// `role=img` with a summary, and a `Table view` toggle shows the same numbers
// as a <table>, which is also the keyboard path to the data. Legend entries
// are buttons that hide a series; hidden series leave the stack. Dragging
// across the plot calls `onBrush(from, to)` with epoch milliseconds (the
// TimeRangePicker's unit); `x` is epoch seconds, as uPlot wants it, and an
// annotation's `at` may be either (values above 1e11 are read as ms).
//
// The model and the uPlot options are built by pure functions (exported for
// tests); the component only wires them to the DOM.

import { loadUplot, uplotStylesheetUrl } from "../ui/vendor-lazy.js";
import { tk } from "../lib/i18n.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useMemo, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";

export const ANNOTATION_KINDS = Object.freeze(["launch", "restart", "config", "alert"]);
const MAX_PALETTE = 8;
const SECONDS_LIMIT = 1e11;

/** `values` as finite numbers or null, exactly `length` long (a short series is padded with gaps). */
export function cleanValues(values, length) {
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = Array.isArray(values) ? values[index] : null;
    out[index] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return out;
}

/**
 * Running totals for a stack. A gap stays a gap in its own band and adds
 * nothing to the bands above it, so a missing sample never reads as zero.
 */
export function stackValues(lists) {
  const totals = new Array(lists[0]?.length ?? 0).fill(0);
  return lists.map((values) => values.map((value, index) => {
    if (value === null) return null;
    totals[index] += value;
    return totals[index];
  }));
}

/** Indices of points that have a value but no neighbour with one: a line would not show them. */
export function isolatedIndices(values) {
  const out = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === null) continue;
    if ((index === 0 || values[index - 1] === null) && (index === values.length - 1 || values[index + 1] === null)) out.push(index);
  }
  return out;
}

/** The unit groups in first-seen order; each gets one y scale (at most two are drawn). */
export function unitGroups(rows) {
  const units = [];
  for (const row of rows) if (!units.includes(row.unit || "")) units.push(row.unit || "");
  return units;
}

/**
 * Everything the chart and the table need, from the props.
 * @returns {{ x, rows, shown, units, stacked, points, gaps, plotted, data }}
 *   rows: every series with clean values; shown: rows not hidden;
 *   plotted: the series in uPlot order (reversed when stacked, so the
 *   largest band paints first); data: uPlot's [x, ...ys].
 */
export function prepareChart({ series = [], x = [], stacked = false, hidden = new Set() } = {}) {
  const times = (Array.isArray(x) ? x : []).map((value) => (Number.isFinite(value) ? value : null));
  const length = times.length;
  const rows = (Array.isArray(series) ? series : []).map((item, index) => ({
    id: String(item?.id ?? index),
    label: item?.label ?? String(item?.id ?? index),
    unit: item?.unit || "",
    index,
    values: cleanValues(item?.values, length),
  }));
  const shown = rows.filter((row) => !hidden.has(row.id));
  const units = unitGroups(shown.length ? shown : rows);
  const stack = Boolean(stacked) && units.length <= 1;
  const cumulative = stack ? stackValues(shown.map((row) => row.values)) : null;
  let plotted = shown.map((row, position) => ({ ...row, plot: cumulative ? cumulative[position] : row.values }));
  if (stack) plotted = plotted.slice().reverse();
  let gaps = 0;
  let points = 0;
  for (const row of rows) {
    for (const value of row.values) {
      if (value === null) gaps += 1;
      else points += 1;
    }
  }
  return { x: times, rows, shown, units, stacked: stack, points, gaps, plotted, data: [times, ...plotted.map((row) => row.plot)] };
}

/** The ms instant of an annotation's `at` (seconds or milliseconds). */
export function annotationMs(at) {
  const value = Number(at);
  if (at === null || at === undefined || !Number.isFinite(value)) return null;
  return value > SECONDS_LIMIT ? value : value * 1000;
}

/** A value with its unit; ratios as percentages, a gap as an em dash. */
export function formatPoint(value, unit, fmt, digits = 2) {
  if (value === null || value === undefined) return fmt.number(null);
  if (unit === "ratio") return fmt.percent(value, 1);
  if (unit === "%") return `${fmt.number(value, 1)}%`;
  return unit ? `${fmt.number(value, digits)} ${unit}` : fmt.number(value, digits);
}

/** The values under the cursor at data index `index`: one entry per shown series, actual values even when stacked. */
export function tooltipRows(model, index, fmt) {
  if (!Number.isInteger(index) || index < 0 || index >= model.x.length) return null;
  return {
    title: fmt.dateTime(model.x[index] * 1000, { style: "long" }),
    rows: model.shown.map((row) => ({ id: row.id, label: row.label, text: formatPoint(row.values[index], row.unit, fmt), gap: row.values[index] === null, color: row.index % MAX_PALETTE })),
  };
}

/** `#rrggbb` as rgba(); anything else comes back unchanged. */
export function withAlpha(color, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!match) return color;
  const n = parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const FALLBACK_COLORS = { text: "#475569", border: "#cbd5e1", danger: "#b91c1c", series: ["#2563eb", "#0d9488", "#c2410c", "#7c3aed", "#db2777", "#4d7c0f", "#0891b2", "#64748b"] };

/** The chart colors from the CSS custom properties of `root` (re-read when the theme changes). */
export function readChartColors(root = globalThis.document?.documentElement) {
  let style = null;
  try {
    style = root && globalThis.getComputedStyle ? globalThis.getComputedStyle(root) : null;
  } catch {
    style = null;
  }
  const read = (name, fallback) => (style?.getPropertyValue(name).trim() || fallback);
  return {
    text: read("--text-muted", FALLBACK_COLORS.text),
    border: read("--border", FALLBACK_COLORS.border),
    danger: read("--danger", FALLBACK_COLORS.danger),
    series: FALLBACK_COLORS.series.map((fallback, index) => read(`--chart-${index + 1}`, fallback)),
  };
}

// Dash patterns tell annotation kinds apart without color.
const ANNOTATION_DASH = { launch: [], restart: [6, 4], config: [2, 3], alert: [8, 3, 2, 3] };

/**
 * uPlot options for `model`. `hooks` carries the callbacks the component
 * wires (cursor, select, draw, ready); everything else is data.
 */
export function buildPlotOptions(model, { width, height, colors, fmt, yUnits, hooks = {} }) {
  const scaleOf = (unit) => (model.units.indexOf(unit) <= 0 ? "y" : "y2");
  const labels = (Array.isArray(yUnits) ? yUnits : yUnits ? [yUnits] : []).map(String);
  const axis = (scale, side, unit, position) => ({
    scale,
    side,
    stroke: colors.text,
    label: labels[position] ?? unit,
    labelSize: 16,
    grid: side === 3 ? { stroke: colors.border, width: 1 } : { show: false },
    ticks: { stroke: colors.border, width: 1 },
    values: (_u, ticks) => ticks.map((tick) => fmt.number(tick, Math.abs(tick) < 10 ? 2 : 0)),
  });
  const axes = [{ stroke: colors.text, grid: { stroke: colors.border, width: 1 }, ticks: { stroke: colors.border, width: 1 } }, axis("y", 3, model.units[0] ?? "", 0)];
  if (model.units.length > 1) axes.push(axis("y2", 1, model.units[1], 1));
  const series = [{}, ...model.plotted.map((row) => {
    const color = colors.series[row.index % MAX_PALETTE];
    const isolated = isolatedIndices(row.plot);
    return {
      label: row.label,
      scale: scaleOf(row.unit),
      stroke: color,
      width: 1.5,
      fill: model.stacked ? withAlpha(color, 0.35) : undefined,
      spanGaps: false,
      points: { show: () => false, filter: () => (isolated.length ? isolated : null), size: 6, stroke: color, fill: color },
    };
  })];
  return {
    width,
    height,
    legend: { show: false },
    cursor: { drag: { x: true, y: false, setScale: false }, points: { size: 7 } },
    select: { show: true },
    scales: { x: { time: true }, y: { auto: true }, ...(model.units.length > 1 ? { y2: { auto: true } } : {}) },
    axes,
    series,
    hooks,
  };
}

/** The select box of a uPlot instance as an epoch-ms range, or null for a click without a drag. */
export function brushRange(plot) {
  const { left, width } = plot.select || {};
  if (!(width > 2)) return null;
  const from = plot.posToVal(left, "x");
  const to = plot.posToVal(left + width, "x");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { from: Math.round(from * 1000), to: Math.round(to * 1000) };
}

function drawAnnotations(plot, items, colors) {
  const ctx = plot.ctx;
  const { left, top, width, height } = plot.bbox;
  const ratio = globalThis.devicePixelRatio || 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  ctx.lineWidth = Math.max(1, ratio);
  for (const item of items) {
    const ms = annotationMs(item.at);
    if (ms === null) continue;
    const position = plot.valToPos(ms / 1000, "x", true);
    if (!Number.isFinite(position) || position < left || position > left + width) continue;
    ctx.strokeStyle = item.kind === "alert" ? colors.danger : colors.series[Math.max(0, ANNOTATION_KINDS.indexOf(item.kind)) + 1] || colors.text;
    ctx.setLineDash((ANNOTATION_DASH[item.kind] || []).map((n) => n * ratio));
    ctx.beginPath();
    ctx.moveTo(position, top);
    ctx.lineTo(position, top + height);
    ctx.stroke();
  }
  ctx.restore();
}

function fillTooltip(element, info) {
  element.replaceChildren();
  const head = globalThis.document.createElement("div");
  head.textContent = info.title;
  element.append(head);
  for (const row of info.rows) {
    const line = globalThis.document.createElement("div");
    line.textContent = `${row.label}: ${row.text}`;
    element.append(line);
  }
}

let stylesheet = null;

/** Adds uPlot's stylesheet once; resolves when it has loaded (or failed: the chart still works). */
function ensureStylesheet() {
  if (!stylesheet) {
    stylesheet = new Promise((resolve) => {
      const link = globalThis.document.createElement("link");
      link.rel = "stylesheet";
      link.href = uplotStylesheetUrl();
      link.dataset.uplot = "1";
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
      globalThis.document.head.append(link);
      globalThis.setTimeout(resolve, 2000);
    });
  }
  return stylesheet;
}

function useThemeTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    let observer = null;
    let media = null;
    try {
      observer = new globalThis.MutationObserver(bump);
      observer.observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
      media?.addEventListener?.("change", bump);
    } catch {
      // No DOM (tests): the colors are read once.
    }
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", bump);
    };
  }, []);
  return tick;
}

function dataKey(model, annotations) {
  const sums = model.rows.map((row) => `${row.id}:${row.values.reduce((sum, value) => sum + (value ?? 0), 0)}:${row.label}:${row.unit}`).join("|");
  const marks = annotations.map((item) => `${item.at}${item.kind}`).join(",");
  return `${model.x.length}:${model.x[0]}:${model.x[model.x.length - 1]}:${sums}:${marks}`;
}

// series [{ id, label, unit, values }], x epoch seconds; annotations [{ at, kind, label }].
export function TimeSeriesChart({ series = [], x = [], stacked = false, annotations = [], onBrush, height = 220, yUnits, title, window: windowText, testid }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const [view, setView] = useState("chart");
  const [hidden, setHidden] = useState(() => new Set());
  const [status, setStatus] = useState("loading");
  const container = useRef(null);
  const brushRef = useRef(onBrush);
  brushRef.current = onBrush;
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;
  const themeTick = useThemeTick();
  const marks = useMemo(() => (Array.isArray(annotations) ? annotations : []).filter((item) => annotationMs(item?.at) !== null), [annotations]);
  const model = prepareChart({ series, x, stacked, hidden });
  const key = dataKey(model, marks);

  useEffect(() => {
    if (view !== "chart" || !model.x.length || !model.shown.length) return undefined;
    const host = container.current;
    if (!host) return undefined;
    let alive = true;
    let plot = null;
    let resize = null;
    let tooltip = null;
    setStatus("loading");
    Promise.all([loadUplot(), ensureStylesheet()]).then(([UPlot]) => {
      if (!alive) return;
      const currentColors = readChartColors();
      const hooks = {
        ready: [(u) => {
          tooltip = globalThis.document.createElement("div");
          tooltip.className = "chart-tooltip";
          tooltip.hidden = true;
          tooltip.dataset.testid = "time-series-chart.tooltip";
          u.over.append(tooltip);
        }],
        setCursor: [(u) => {
          if (!tooltip) return;
          const index = u.cursor.idx;
          const info = index === null || index === undefined || u.cursor.left < 0 ? null : tooltipRows(model, index, fmtRef.current);
          tooltip.hidden = !info;
          if (!info) return;
          fillTooltip(tooltip, info);
          const room = u.over.clientWidth - u.cursor.left;
          tooltip.style.left = room > 180 ? `${u.cursor.left + 12}px` : `${Math.max(0, u.cursor.left - tooltip.offsetWidth - 12)}px`;
          tooltip.style.top = "8px";
        }],
        setSelect: [(u) => {
          const range = brushRange(u);
          if (!range) return;
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          brushRef.current?.(range.from, range.to);
        }],
        draw: [(u) => drawAnnotations(u, marks, currentColors)],
      };
      const width = Math.max(120, host.clientWidth || 600);
      plot = new UPlot(buildPlotOptions(model, { width, height, colors: currentColors, fmt: fmtRef.current, yUnits, hooks }), model.data, host);
      setStatus("ready");
      if (typeof globalThis.ResizeObserver === "function") {
        resize = new globalThis.ResizeObserver(() => plot?.setSize({ width: Math.max(120, host.clientWidth || 600), height }));
        resize.observe(host);
      }
    }).catch(() => {
      if (alive) setStatus("error");
    });
    return () => {
      alive = false;
      resize?.disconnect();
      plot?.destroy();
      host.replaceChildren();
    };
  }, [view, key, [...hidden].sort().join(","), stacked, height, themeTick, String(yUnits)]);

  function toggle(id) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const empty = !model.x.length || !model.rows.length;
  const first = model.x[0];
  const last = model.x[model.x.length - 1];
  const summary = empty ? t("common.chart.empty") : t("common.chart.summary", {
    title: title || t("common.chart.title"),
    series: model.rows.length,
    points: model.points,
    from: fmt.dateTime(first * 1000),
    to: fmt.dateTime(last * 1000),
  });
  const kindLabel = (kind) => {
    const keyName = tk("common.chart.annotation.", kind);
    return has(keyName) ? t(keyName) : String(kind);
  };

  return html`<div class="chart-block" data-testid=${testid || "time-series-chart.root"} data-view=${view} data-stacked=${model.stacked ? "true" : "false"}>
    <div class="row-nowrap chart-toolbar">
      <span class="small muted grow" data-window=${windowText || undefined} data-testid="time-series-chart.window">${windowText || ""}</span>
      ${empty ? null : html`<${Button} size="sm" aria-pressed=${view === "table" ? "true" : "false"} onClick=${() => setView(view === "chart" ? "table" : "chart")} testid="time-series-chart.toggle">${view === "chart" ? t("common.chart.tableView") : t("common.chart.chartView")}<//>`}
    </div>
    ${empty ? html`<div class="chart-empty" role="status" data-testid="time-series-chart.empty">${t("common.chart.empty")}</div>` : view === "table" ? html`
      <div class="table-wrap chart-table" tabindex="0" role="region" aria-label=${summary} data-testid="time-series-chart.table">
        <table class="table">
          <caption class="sr-only">${summary}</caption>
          <thead><tr>
            <th scope="col">${t("common.chart.time")}</th>
            ${model.rows.map((row) => html`<th scope="col" class="num" key=${row.id}>${row.label}${row.unit ? ` (${row.unit})` : ""}</th>`)}
          </tr></thead>
          <tbody>
            ${model.x.map((moment, index) => html`<tr key=${index}>
              <th scope="row">${moment === null ? fmt.number(null) : fmt.dateTime(moment * 1000, { style: "long" })}</th>
              ${model.rows.map((row) => html`<td class="num" key=${row.id} data-gap=${row.values[index] === null ? "true" : undefined}>${row.values[index] === null ? fmt.number(null) : fmt.number(row.values[index])}</td>`)}
            </tr>`)}
          </tbody>
        </table>
      </div>` : html`
      <div class="chart-frame">
        <div class="chart" ref=${container} role="img" aria-label=${summary} data-testid="time-series-chart.canvas" data-status=${status} style=${{ height: `${height}px` }}></div>
        ${status === "loading" ? html`<div class="chart-state" aria-busy="true" data-testid="time-series-chart.loading"><span class="skeleton chart-placeholder"></span></div>` : null}
        ${status === "error" ? html`<p class="field-error" role="alert" data-testid="time-series-chart.error">${t("common.chart.failed")}</p>` : null}
      </div>`}
    ${empty ? null : html`<ul class="chart-legend" data-testid="time-series-chart.legend">
      ${model.rows.map((row) => html`<li key=${row.id}><button type="button" class="chart-legend-item" aria-pressed=${hidden.has(row.id) ? "false" : "true"} data-series=${row.id} data-testid="time-series-chart.legend-item" onClick=${() => toggle(row.id)}>
        <span class=${`chart-swatch series-${(row.index % MAX_PALETTE) + 1}`} aria-hidden="true"></span>${row.label}${row.unit ? html` <span class="muted">(${row.unit})</span>` : null}
      </button></li>`)}
    </ul>`}
    ${marks.length ? html`<ul class="chart-annotations small" data-testid="time-series-chart.annotations" aria-label=${t("common.chart.annotations")}>
      ${marks.map((item, index) => html`<li key=${index} data-kind=${item.kind} data-testid="time-series-chart.annotation"><span class=${`chart-mark chart-mark-${item.kind}`} aria-hidden="true"></span><span class="muted">${kindLabel(item.kind)}</span> ${item.label || ""} <span class="num muted">${fmt.dateTime(annotationMs(item.at))}</span></li>`)}
    </ul>` : null}
    ${view === "chart" && !empty ? html`<p class="small muted chart-hint">${t("common.chart.zoomHint")}</p>` : null}
  </div>`;
}
