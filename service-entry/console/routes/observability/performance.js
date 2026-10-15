// Observability › Performance `/observability/performance` (07 §6.7, 04 §19):
// TTFT p50/p95/p99 by model with launch, config, benchmark and container
// annotations; engine metrics by fleet with the `latency_source` badge; the
// TTFT heatmap.

import { tk } from "../../lib/i18n.js";
import { ChartPanel, MetricGrid, ObsPage, Panel, QueryView, useLive, useObsState, useTelemetry } from "./common.js";
import { Heatmap } from "./heatmap.js";
import { heatmapModel, latencySourceOf } from "../../lib/observability-model.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";

const LATENCY = ["lat.ttft_p50", "lat.ttft_p95", "lat.ttft_p99"];
const ENGINE = ["rt.output_tps", "rt.running", "rt.waiting", "rt.kv_usage", "rt.prefix_hit", "rt.spec_accept"];
const ANNOTATE = "launch,config,benchmark,container";

/** One badge per fleet that says where its latency numbers come from. */
function SourceBadges({ live }) {
  const { t, has } = useT();
  const rows = (Array.isArray(live?.instances) ? live.instances : []).map((item) => ({ fleetId: item.fleetId, source: latencySourceOf(item) })).filter((item) => item.source);
  if (!rows.length) return null;
  return html`<ul class="obs-badges small" aria-label=${t("obs.latencySource")} data-testid="obs.latency-source">
    ${rows.map((row) => html`<li key=${row.fleetId} class="badge badge-neutral" data-source=${row.source} data-fleet=${row.fleetId}>
      <span class="mono" data-user-content>${row.fleetId}</span>
      <span>${row.source === "gateway" ? t("obs.latencyFromGateway") : row.source === "none" ? t("obs.noMetric") : has(tk("obs.source.", row.source)) ? t(tk("obs.source.", row.source)) : row.source}</span>
    </li>`)}
  </ul>`;
}

function EnginePanel({ obs, query, live }) {
  const { t } = useT();
  return html`<${Panel} title=${t("obs.panel.engine")} obs=${obs} note=${html`<${SourceBadges} live=${live} />`} testid="obs.engine">
    <${QueryView} query=${query}>${(answer) => html`<${MetricGrid} obs=${obs} answer=${answer} metrics=${ENGINE} live=${live} testid="obs.engine.grid" />`}<//>
  <//>`;
}

function HeatPanel({ obs, query }) {
  const { t } = useT();
  return html`<${Panel} title=${t("obs.panel.heatmap")} obs=${obs} testid="obs.heatmap-panel">
    <${QueryView} query=${query}>${(answer) => html`<${Heatmap} model=${heatmapModel(answer)} title=${t("obs.panel.heatmap")} window=${obs.windowText} />`}<//>
  <//>`;
}

function Body({ obs, telemetry }) {
  const { t } = useT();
  const live = useLive({ enabled: telemetry });
  const latency = useTelemetry(obs, "timeseries", { metrics: LATENCY.join(","), groupBy: "model", annotate: ANNOTATE }, { enabled: telemetry });
  const engine = useTelemetry(obs, "timeseries", { metrics: ENGINE.join(","), groupBy: "fleet" }, { enabled: telemetry });
  const heat = useTelemetry(obs, "timeseries", { metrics: "lat.ttft_hist" }, { enabled: telemetry });
  return html`
    <${ChartPanel} obs=${obs} title=${t("obs.panel.latency")} query=${latency} metrics=${LATENCY} live=${live.data} annotate=${true} testid="obs.latency" />
    <${EnginePanel} obs=${obs} query=${engine} live=${live.data} />
    <${HeatPanel} obs=${obs} query=${heat} />
  `;
}

export default function ObservabilityPerformance() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  return html`<${ObsPage} obs=${obs} id="performance">${() => html`<${Body} obs=${obs} telemetry=${telemetry} />`}<//>`;
}
