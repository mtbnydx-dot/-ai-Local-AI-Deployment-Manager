// Observability › Overview `/observability` (07 §6.7, 04 §19): the live strip
// (`telemetry.live`, polling fallback GET /live), KPI tiles from
// `summary?compare=previous` with the window on every tile, sparklines from
// `timeseries`, the firing-alerts banner and requests by status class.

import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Panel, ChartPanel, ObsPage, QueryView, useLive, useObsState, useTelemetry } from "./common.js";
import { firingAlerts, INSTANCE_STATUS, isIdleInstance, isReadOnlyView, kpiTiles, liveTiles, localizedTitle, SPARK_METRICS, sparkValues } from "../../lib/observability-model.js";
import { Icon } from "../../components/icon.js";
import { StatTile } from "../../components/stat-tile.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";

function AlertBanner() {
  const { api } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  const alerts = useQuery(["alerts", "firing"], () => api.get("/api/telemetry/alerts", { query: { state: "firing" } }), { ttlMs: 10_000, refetchMs: 30_000 });
  const rows = firingAlerts(alerts.data);
  if (!rows.length) return null;
  return html`<section class="notice notice-danger obs-alerts" role="status" aria-label=${t("obs.alerts.title")} data-testid="obs.alerts">
    <${Icon} name="triangle-alert" />
    <ul class="grow obs-alert-list">
      ${rows.map((row) => html`<li key=${`${row.ruleId}:${row.scopeKey}`} data-severity=${row.severity} data-testid="obs.alert">
        <strong data-user-content>${localizedTitle(row.title, i18n.locale)}</strong>
        <span class="small"> · ${t(tk("obs.severity.", row.severity))} · ${t("obs.alert.firing")}${row.since ? html` · <time dateTime=${row.since} title=${fmt.dateTime(row.since)}>${t("obs.alerts.since", { when: fmt.relative(row.since) })}</time>` : null}</span>
      </li>`)}
    </ul>
    <${Button} size="sm" href="/alerts" testid="obs.alerts.open">${t("obs.alerts.open")}<//>
  </section>`;
}

function stateLabel(i18n, state) {
  const key = tk("obs.state.", String(state));
  return i18n.has(key) ? i18n.t(key) : String(state || "");
}

function LiveStrip({ obs, live }) {
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  return html`<${Panel} title=${t("obs.panel.live")} obs=${obs} windowText=${t("obs.live.now")} testid="obs.live">
    <${QueryView} query=${live}>${(data) => {
      const tiles = liveTiles(data, fmt);
      const instances = Array.isArray(data.instances) ? data.instances : [];
      const gpus = Array.isArray(data.gpus) ? data.gpus : [];
      return html`<div class="stack-sm">
        <div class="obs-tiles" data-testid="obs.live.tiles">
          ${tiles.map((tile) => html`<${StatTile} key=${tile.id} label=${t(tile.labelKey)} value=${tile.value} unit=${tile.unit} window=${t(tile.windowKey, tile.windowVars)} testid=${`obs.live.${tile.id}`} />`)}
        </div>
        ${instances.length ? html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.live.instances")}>
          <table class="table" data-testid="obs.live.instances">
            <caption class="sr-only">${t("obs.live.instances")}</caption>
            <thead><tr><th scope="col">${t("obs.col.model")}</th><th scope="col">${t("obs.col.state")}</th><th scope="col" class="num">${t("obs.col.running")}</th>
              <th scope="col" class="num">${t("obs.col.waiting")}</th><th scope="col" class="num">${t("obs.col.kv")}</th><th scope="col" class="num">${t("obs.col.tps")}</th></tr></thead>
            <tbody>${instances.map((item) => {
              const idle = isIdleInstance(item);
              return html`<tr key=${item.fleetId} data-fleet=${item.fleetId} data-idle=${idle ? "true" : "false"} data-testid="obs.live.instance">
                <td><span data-user-content>${item.model || item.fleetId}</span> <span class="muted small mono" data-user-content>${item.fleetId}</span></td>
                <td><${StatusBadge} status=${INSTANCE_STATUS[item.state] || "unknown"} label=${stateLabel(i18n, item.state)} />
                  ${idle ? html`<div class="small muted" data-testid="obs.live.idle">${t("obs.idle")}</div>` : null}</td>
                <td class="num tabular">${fmt.number(item.running, 0)}</td>
                <td class="num tabular">${fmt.number(item.waiting, 0)}</td>
                <td class="num tabular">${item.kvUsage === null || item.kvUsage === undefined ? fmt.number(null) : fmt.percent(item.kvUsage, 0)}</td>
                <td class="num tabular">${fmt.number(item.outputTps, 1)} <span class="muted">tokens/s</span></td>
              </tr>`;
            })}</tbody>
          </table>
        </div>` : html`<p class="muted" data-testid="obs.live.none">${t("obs.live.noInstances")}</p>`}
        ${gpus.length ? html`<ul class="obs-gpus small" aria-label=${t("obs.live.gpus")} data-testid="obs.live.gpus">
          ${gpus.map((gpu) => html`<li key=${gpu.index}><strong>${t("obs.gpuName", { index: gpu.index })}</strong> · ${fmt.number(gpu.util, 0)}% · ${fmt.mib(gpu.memUsedMb)} / ${fmt.mib(gpu.memTotalMb)} · ${fmt.number(gpu.tempC, 0)} °C · ${fmt.number(gpu.powerW, 0)} W</li>`)}
        </ul>` : null}
      </div>`;
    }}<//>
  <//>`;
}

function Kpis({ obs, summary }) {
  const { t } = useT();
  const fmt = useFormat();
  const sparks = useTelemetry(obs, "timeseries", { metrics: SPARK_METRICS.join(",") });
  return html`<${Panel} title=${t("obs.panel.kpi")} obs=${obs} testid="obs.kpi">
    <${QueryView} query=${summary}>${(data) => {
      const tiles = kpiTiles({ summary: data, sparks: sparkValues(sparks.data) }, { t, fmt, windowText: obs.windowText });
      return html`<div class="obs-tiles" data-testid="obs.tiles">
        ${tiles.map((tile) => html`<${StatTile} key=${tile.id} label=${tile.label} value=${tile.value} unit=${tile.unit} window=${tile.windowText}
          delta=${tile.delta} sparkline=${tile.sparkline} note=${tile.note} testid=${`obs.tile.${tile.id}`} />`)}
      </div>`;
    }}<//>
  <//>`;
}

function StatusChart({ obs, enabled, live }) {
  const { t } = useT();
  const status = useTelemetry(obs, "timeseries", { metrics: "req.count", groupBy: "status_class" }, { enabled });
  return html`<${ChartPanel} obs=${obs} title=${t("obs.panel.status")} query=${status} metrics=${["req.count"]} live=${live} stacked=${true} testid="obs.status" />`;
}

export default function ObservabilityOverview() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  const live = useLive({ enabled: telemetry });
  const summary = useTelemetry(obs, "summary", { compare: "previous" }, { enabled: telemetry });
  return html`<${ObsPage} obs=${obs} id="overview" readOnly=${isReadOnlyView("owner", summary.data)}>${() => html`
    <${AlertBanner} />
    <${LiveStrip} obs=${obs} live=${live} />
    <${Kpis} obs=${obs} summary=${summary} />
    <${StatusChart} obs=${obs} enabled=${telemetry} live=${live.data} />
  `}<//>`;
}
