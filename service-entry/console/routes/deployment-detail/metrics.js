// The Metrics tab of a deployment (07 §6.2, §3.9): live tiles from the
// instance `metrics` reply, then the telemetry charts of this fleetId. Its own
// module so the detail page stays under the route-module budget (07 §11).

import { chartSeries, metricsTiles } from "../../lib/deployments-model.js";
import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { resolveTimeRange, serializeTimeRange } from "../../lib/time-range.js";
import { StatTile } from "../../components/stat-tile.js";
import { TimeRangePicker, useRangeLabel, useTimeRangeParam } from "../../components/time-range-picker.js";
import { TimeSeriesChart } from "../../components/time-series-chart.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo } from "../../ui/vendor.js";

const CHART_GROUPS = Object.freeze([
  { id: "load", metrics: ["rt.running", "rt.waiting"] },
  { id: "kv", metrics: ["rt.kv_usage"] },
  { id: "ttft", metrics: ["rt.ttft_p50", "rt.ttft_p95"] },
  { id: "throughput", metrics: ["rt.output_tps"] },
]);

export function MetricsTab({ row, metricsQuery, telemetry, loaded }) {
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  const tiles = metricsTiles(metricsQuery.data, { t, fmt });
  return html`<div class="stack" data-testid="deploy.tab.metrics">
    ${metricsQuery.error && !metricsQuery.data ? html`<p class="notice notice-warn" role="status" data-testid="deploy.metrics.error">${describeError(metricsQuery.error, i18n)}</p>` : null}
    <section class="deploy-tiles" aria-label=${t("deploy.metrics.label")} data-testid="deploy.metrics.tiles" data-ready=${loaded ? "true" : "false"}>
      ${tiles.map((tile) => html`<div key=${tile.id} data-state=${tile.state} data-testid=${`deploy.metric.${tile.id}`}>
        <${StatTile} label=${tile.label} value=${tile.value} unit=${tile.unit} note=${tile.note} window=${tile.span} testid=${`deploy.tile.${tile.id}`} />
      </div>`)}
    </section>
    ${telemetry ? html`<${Charts} row=${row} />` : html`<p class="muted small" data-testid="deploy.charts.degraded">${t("deploy.charts.needTelemetry")}</p>`}
  </div>`;
}

function Charts({ row }) {
  const { api } = useServices();
  const { t } = useT();
  const rangeLabel = useRangeLabel();
  const [value, setRange] = useTimeRangeParam({ fallback: "1h" });
  const span = resolveTimeRange(value);
  const metrics = CHART_GROUPS.flatMap((group) => group.metrics);
  const series = useQuery(["telemetry", "timeseries", row.fleetId, serializeTimeRange(value)], () => {
    const { from, to } = resolveTimeRange(value);
    return api.get("/api/telemetry/timeseries", { query: { metrics: metrics.join(","), fleet_id: row.fleetId, from: new Date(from).toISOString(), to: new Date(to).toISOString() } });
  }, { ttlMs: 15000, refetchMs: 30000 });
  const chart = useMemo(() => chartSeries(series.data, (item) => t(tk("deploy.chart.series.", item.metric))), [series.data]);
  const windowText = rangeLabel(value, span.to);
  return html`<section class="stack" aria-label=${t("deploy.charts.label")} data-testid="deploy.charts">
    <div class="row"><${TimeRangePicker} value=${value} onChange=${setRange} /></div>
    <div class="deploy-charts">
      ${CHART_GROUPS.map((group) => {
        const picked = chart.series.filter((item) => group.metrics.includes(item.id));
        return html`<div key=${group.id} data-testid=${`deploy.chart.${group.id}`}>
          <${TimeSeriesChart} title=${t(tk("deploy.chart.", group.id))} window=${windowText} x=${chart.x} series=${picked} height=${180} />
        </div>`;
      })}
    </div>
  </section>`;
}
