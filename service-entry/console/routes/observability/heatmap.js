// The TTFT heatmap (04 §19 Performance): time on x, latency buckets on y, the
// count of requests as shade. Cells are SVG rects classed `heat-0..5`, so the
// colors come from the stylesheet (CSP-safe). The picture is `role=img` with a
// summary; a Table view toggle lists the same counts, which is also the
// keyboard path to the data. A gap (null count) is left unpainted.

import { heatStep } from "../../lib/observability-model.js";
import { Button } from "../../components/button.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

const CELL_HEIGHT = 14;
const WIDTH = 600;
const STEPS = 5;

/** The label of a bucket: "≤ 500 ms", or "> 60000 ms" for the open last bucket. */
export function bucketLabel(bucket, previous, fmt) {
  if (bucket.le === null) return previous === null || previous === undefined ? "—" : `> ${fmt.number(previous, 0)} ms`;
  return `≤ ${fmt.number(bucket.le, 0)} ms`;
}

export function Heatmap({ model, title, window: windowText, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  const [view, setView] = useState("chart");
  const columns = model.cells.length;
  const rows = model.buckets.length;
  const labels = model.buckets.map((bucket, index) => bucketLabel(bucket, index > 0 ? model.buckets[index - 1].le : null, fmt));
  const summary = t("obs.heatmap.summary", { title, columns: fmt.integer(columns), buckets: fmt.integer(rows), from: fmt.dateTime(model.times[0]), to: fmt.dateTime(model.times[columns - 1]) });
  const cellWidth = columns ? WIDTH / columns : WIDTH;
  const height = rows * CELL_HEIGHT;

  if (model.empty) return html`<div class="chart-empty" role="status" data-testid=${testid ? `${testid}.empty` : "obs.heatmap.empty"}>${t("common.chart.empty")}</div>`;

  return html`<div class="chart-block heatmap" data-view=${view} data-testid=${testid || "obs.heatmap"}>
    <div class="row-nowrap chart-toolbar">
      <span class="small muted grow" data-window=${windowText || undefined} data-testid="obs.heatmap.window">${windowText || ""}</span>
      <${Button} size="sm" aria-pressed=${view === "table" ? "true" : "false"} onClick=${() => setView(view === "chart" ? "table" : "chart")} testid="obs.heatmap.toggle">${view === "chart" ? t("common.chart.tableView") : t("common.chart.chartView")}<//>
    </div>
    ${view === "table" ? html`<div class="table-wrap chart-table" tabindex="0" role="region" aria-label=${summary} data-testid="obs.heatmap.table">
      <table class="table">
        <caption class="sr-only">${summary}</caption>
        <thead><tr><th scope="col">${t("common.chart.time")}</th>${labels.map((label, index) => html`<th scope="col" class="num" key=${index}>${label}</th>`)}</tr></thead>
        <tbody>${model.cells.map((column, index) => html`<tr key=${index}>
          <th scope="row">${fmt.dateTime(model.times[index], { style: "long" })}</th>
          ${column.map((count, bucket) => html`<td class="num" key=${bucket} data-gap=${count === null ? "true" : undefined}>${count === null ? fmt.number(null) : fmt.integer(count)}</td>`)}
        </tr>`)}</tbody>
      </table>
    </div>` : html`<div class="heat-frame">
      <ol class="heat-axis small muted" aria-hidden="true">${labels.slice().reverse().map((label, index) => html`<li key=${index}>${label}</li>`)}</ol>
      <svg class="heat-grid" viewBox=${`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" role="img" aria-label=${summary} data-testid="obs.heatmap.canvas" data-max=${model.max}>
        ${model.cells.map((column, x) => column.map((count, bucket) => {
          const step = heatStep(count, model.max, STEPS);
          if (count === null || step === 0) return null;
          return html`<rect key=${`${x}:${bucket}`} class=${`heat-cell heat-${step}`} x=${(x * cellWidth).toFixed(2)} y=${((rows - 1 - bucket) * CELL_HEIGHT).toFixed(2)}
            width=${Math.max(0.5, cellWidth).toFixed(2)} height=${CELL_HEIGHT} data-count=${count}><title>${`${fmt.dateTime(model.times[x])} · ${labels[bucket]} · ${fmt.integer(count)}`}</title></rect>`;
        }))}
      </svg>
    </div>
    <p class="small muted heat-range"><span>${fmt.dateTime(model.times[0])}</span><span>${fmt.dateTime(model.times[columns - 1])}</span></p>`}
  </div>`;
}
