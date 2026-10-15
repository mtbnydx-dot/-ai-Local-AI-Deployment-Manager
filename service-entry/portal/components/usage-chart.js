// A uPlot chart of per-day usage for My Key (05 §12.5): a time axis, a hover
// tooltip with the real (not stacked) values, gaps where a day is unknown, a
// legend of colour plus shape, and a table with the same numbers for anyone
// who cannot use the canvas. uPlot loads on first use through the import map;
// if it cannot, the table is all there is and a note says so.

import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "../lib/html.js";
import { usePortal } from "../lib/context.js";
import { formatInteger, formatTokenCount } from "../lib/format.js";
import { chartTableRows } from "../lib/me-view.js";
import { DataTable } from "./table.js";

const CHART_HEIGHT = 220;
const MIN_WIDTH = 240;
const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"];
const SHAPES = ["circle", "square", "diamond", "triangle"];

let uplotPromise = null;
let stylesheetPromise = null;

function loadUplot() {
  if (!uplotPromise) {
    uplotPromise = import("uplot").then((module) => module.default, (error) => {
      uplotPromise = null;
      throw error;
    });
  }
  return uplotPromise;
}

// uPlot's own stylesheet sits next to its module in the one vendor tree; the
// import map says where that is.
function ensureStylesheet() {
  if (!stylesheetPromise) {
    stylesheetPromise = new Promise((resolve) => {
      let href = "";
      try {
        href = new URL("uPlot.min.css", import.meta.resolve("uplot")).href;
      } catch {
        href = "";
      }
      if (!href) {
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.uplot = "1";
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
      document.head.append(link);
      setTimeout(resolve, 2000);
    });
  }
  return stylesheetPromise;
}

function cssColor(name, fallback) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

function useThemeTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let media = null;
    const bump = () => setTick((value) => value + 1);
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", bump);
    } catch {
      media = null;
    }
    return () => media?.removeEventListener("change", bump);
  }, []);
  return tick;
}

// Stacked bars are drawn from the largest running total down to the smallest,
// so every series shows as the band between two totals.
function stackedData(model) {
  const running = model.x.map(() => null);
  const layers = model.series.map((item) => item.values.map((value, index) => {
    if (value === null) return null;
    running[index] = (running[index] ?? 0) + value;
    return running[index];
  }));
  return layers;
}

function Shape({ index }) {
  const kind = SHAPES[index % SHAPES.length];
  if (kind === "circle") return html`<circle cx="6" cy="6" r="4.5" fill="currentColor" />`;
  if (kind === "square") return html`<rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.2" fill="currentColor" />`;
  if (kind === "diamond") return html`<path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="currentColor" />`;
  return html`<path d="M6 1.4 11 10.4H1z" fill="currentColor" />`;
}

function Legend({ items }) {
  return html`<ul class="chart-legend">
    ${items.map((item) => html`<li style=${{ color: item.color }}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><${Shape} index=${item.index} /></svg>
      <span class="chart-legend-text">${item.label}</span>
    </li>`)}
  </ul>`;
}

/**
 * UsageChart({ model, title, labelOf, caption, emptyText, tableHead, testid })
 *   model: lib/me-view.js buildTokenChart / buildRequestChart
 *   labelOf(series) -> the legend and tooltip name
 */
export function UsageChart({ model, title, labelOf, caption, emptyText, tableLabel, testid, errorIndex = -1 }) {
  const { t, lang } = usePortal();
  const holder = useRef(null);
  const [status, setStatus] = useState("loading");
  const theme = useThemeTick();
  const labels = model.series.map((item) => labelOf(item));
  const colors = model.series.map((item, index) => (index === errorIndex ? cssColor("--danger", "#c62828") : cssColor(PALETTE[index % PALETTE.length], "#0f766e")));

  useEffect(() => {
    if (model.empty || !model.x.length) return undefined;
    let chart = null;
    let observer = null;
    let alive = true;
    setStatus("loading");
    Promise.all([loadUplot(), ensureStylesheet()]).then(([UPlot]) => {
      if (!alive || !holder.current) return;
      const host = holder.current;
      const muted = cssColor("--text-muted", "#667085");
      const grid = cssColor("--border", "#d0d5dd");
      const layers = model.stacked ? stackedData(model) : model.series.map((item) => item.values);
      // Largest running total first when stacked, so smaller bands paint over it.
      const order = model.series.map((_, index) => index);
      if (model.stacked) order.reverse();
      const bars = UPlot.paths.bars({ size: [0.7, 48] });
      const tooltip = document.createElement("div");
      tooltip.className = "chart-tip";
      tooltip.hidden = true;
      const width = () => Math.max(MIN_WIDTH, Math.floor(host.clientWidth || 600));
      chart = new UPlot({
        width: width(),
        height: CHART_HEIGHT,
        padding: [12, 8, 0, 0],
        legend: { show: false },
        cursor: { drag: { x: false, y: false }, points: { show: false } },
        scales: { x: { time: true, range: (_u, min, max) => [min - 43_200, max + 43_200] }, y: { range: (_u, _min, max) => [0, Math.max(1, max || 1) * 1.1] } },
        axes: [
          { stroke: muted, incrs: [86_400, 86_400 * 2, 86_400 * 7, 86_400 * 30], grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } },
          { stroke: muted, size: 56, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, values: (_u, ticks) => ticks.map((tick) => (tick === 0 ? "0" : formatTokenCount(tick) || String(tick))) },
        ],
        series: [
          {},
          ...order.map((index) => ({
            label: labels[index],
            stroke: colors[index],
            fill: colors[index],
            width: 0,
            paths: bars,
            points: { show: false },
            spanGaps: false,
          })),
        ],
        hooks: {
          setCursor: [(u) => {
            const index = u.cursor.idx;
            if (index === null || index === undefined || model.x[index] === undefined || model.series.every((item) => item.values[index] === null)) {
              tooltip.hidden = true;
              return;
            }
            tooltip.replaceChildren();
            const head = document.createElement("strong");
            head.textContent = new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" }).format(new Date(model.x[index] * 1000));
            tooltip.append(head);
            for (let position = 0; position < model.series.length; position += 1) {
              const row = document.createElement("div");
              const value = model.series[position].values[index];
              row.textContent = `${labels[position]}: ${value === null ? "—" : formatInteger(value, lang)}`;
              tooltip.append(row);
            }
            tooltip.hidden = false;
            const left = Math.min(Math.max(0, u.cursor.left + 12), Math.max(0, u.over.clientWidth - 160));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = "8px";
          }],
        },
      }, [model.x, ...order.map((index) => layers[index])], host);
      chart.over.append(tooltip);
      chart.over.addEventListener("mouseleave", () => {
        tooltip.hidden = true;
      });
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(() => chart?.setSize({ width: width(), height: CHART_HEIGHT }));
        observer.observe(host);
      }
      setStatus("ready");
    }, () => alive && setStatus("failed"));
    return () => {
      alive = false;
      observer?.disconnect();
      chart?.destroy();
    };
  }, [model, lang, theme]);

  const tableHead = [t("me.chart.date"), ...labels];
  const tableRows = chartTableRows(model, lang).map((row) => row.map((cell, index) => (index === 0 ? cell : cell === null ? "—" : formatInteger(cell, lang))));
  return html`<figure class="chart" data-testid=${testid} data-chart-status=${model.empty ? "empty" : status}>
    <figcaption class="chart-title"><h3>${title}</h3>${caption ? html`<p class="muted small">${caption}</p>` : null}</figcaption>
    ${model.empty || !model.x.length
      ? html`<p class="notice notice-empty chart-empty">${emptyText}</p>`
      : html`<${Legend} items=${labels.map((label, index) => ({ label, color: colors[index], index }))} />
        <div class="chart-canvas" ref=${holder} role="img" aria-label=${`${title}: ${labels.join(", ")}`}></div>
        ${status === "failed" ? html`<p class="muted small" role="status">${t("me.chart.failed")}</p>` : null}
        <details class="chart-table" open=${status === "failed"}>
          <summary>${t("me.chart.table")}</summary>
          <${DataTable} caption=${tableLabel || title} head=${tableHead} rows=${tableRows} />
        </details>`}
  </figure>`;
}
