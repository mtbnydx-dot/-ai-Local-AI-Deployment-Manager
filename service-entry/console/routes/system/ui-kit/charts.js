// ui-kit section: the time range picker, GPU memory bars and the lazily
// loaded charts. The charts mount on demand (like the QR code), so opening
// the kit does not load the chart library.

import { useFormat, useT } from "../../../ui/hooks.js";
import { html } from "../../../ui/html.js";
import { useState } from "../../../ui/vendor.js";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { GpuMemoryBar } from "../../../components/gpu-memory-bar.js";
import { TimeRangePicker, useRangeLabel, useTimeRangeParam } from "../../../components/time-range-picker.js";
import { TimeSeriesChart } from "../../../components/time-series-chart.js";
import { CHART_ANNOTATIONS, CHART_LINE, CHART_STACK, CHART_X, GPU_BARS } from "../../../data/ui-kit-fixtures.js";

export default function ChartsSection() {
  const { t } = useT();
  const fmt = useFormat();
  const label = useRangeLabel();
  const [range, setRange] = useTimeRangeParam();
  const [compare, setCompare] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [brush, setBrush] = useState(null);
  const windowText = label(range);
  return html`
    <${Card} title=${t("uikit.range")}>
      <${TimeRangePicker} value=${range} compare=${compare} onChange=${(next, meta) => { setRange(next); setCompare(Boolean(meta?.compare)); }} />
    <//>

    <${Card} title=${t("uikit.memory")}>
      <div class="stack">
        ${GPU_BARS.map((bar) => html`<${GpuMemoryBar} key=${bar.gpu.id} ...${bar} />`)}
      </div>
    <//>

    <${Card} title=${t("uikit.charts")}>
      <div class="stack">
        <div class="row"><${Button} aria-pressed=${showCharts ? "true" : "false"} onClick=${() => setShowCharts(!showCharts)} testid="uikit.toggle-charts">${t("uikit.toggleCharts")}<//></div>
        ${showCharts ? html`
          <${TimeSeriesChart} title=${t("uikit.chart.line")} series=${CHART_LINE} x=${CHART_X} annotations=${CHART_ANNOTATIONS} window=${windowText} yUnits="ms" onBrush=${(from, to) => setBrush({ from, to })} testid="uikit.chart-line" />
          <${TimeSeriesChart} title=${t("uikit.chart.stacked")} series=${CHART_STACK} x=${CHART_X} stacked=${true} window=${windowText} testid="uikit.chart-stacked" />
          ${brush ? html`<p class="small" data-testid="uikit.brush">${t("uikit.chart.brush", { from: fmt.dateTime(brush.from), to: fmt.dateTime(brush.to) })}</p>` : null}` : null}
      </div>
    <//>`;
}
