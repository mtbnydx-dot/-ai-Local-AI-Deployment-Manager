// Observability › Traffic `/observability/traffic` (07 §6.7, 04 §19): requests
// by key, by source and by protocol; breakdown rows with sparklines; auth
// failures by IP with the ban events (owner only).

import { tk } from "../../lib/i18n.js";
import { Panel, ChartPanel, ObsPage, PanelEmpty, QueryView, useLive, useObsState, useTelemetry } from "./common.js";
import { breakdownRows, labelText } from "../../lib/observability-model.js";
import { useFormat, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";

const DIMS = ["key", "source", "protocol"];

/** A 24-point sparkline as an SVG polyline; a gap breaks the line. */
export function Spark({ values, label }) {
  const nums = (values || []).filter((value) => Number.isFinite(value));
  if (nums.length < 2) return html`<span class="muted">—</span>`;
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min || 1;
  const width = 96;
  const height = 24;
  const step = width / Math.max(1, values.length - 1);
  const runs = [];
  let run = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([(index * step).toFixed(1), (height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)]);
  });
  if (run.length) runs.push(run);
  return html`<svg class="stat-spark" viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${label} focusable="false" data-testid="obs.spark">
    ${runs.map((points, index) => (points.length > 1
    ? html`<polyline key=${index} points=${points.map((point) => point.join(",")).join(" ")} />`
    : html`<circle key=${index} cx=${points[0][0]} cy=${points[0][1]} r="1.5" />`))}
  </svg>`;
}

function KeyTable({ obs }) {
  const { t, locale } = useT();
  const fmt = useFormat();
  const query = useTelemetry(obs, "breakdown", { dim: "key", spark: "1" });
  return html`<${Panel} title=${t("obs.panel.byKey")} obs=${obs} testid="obs.keys">
    <${QueryView} query=${query}>${(answer) => {
      const rows = breakdownRows(answer);
      if (!rows.length) return html`<${PanelEmpty} obs=${obs} title=${t("obs.empty.traffic")} />`;
      return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.panel.byKey") })}>
        <table class="table" data-testid="obs.keys.table">
          <caption class="sr-only">${t("obs.panel.byKey")} · ${obs.windowText}</caption>
          <thead><tr><th scope="col">${t("obs.col.key")}</th><th scope="col" class="num">${t("obs.col.requests")}</th><th scope="col" class="num">${t("obs.col.errorRate")}</th>
            <th scope="col" class="num">${t("obs.col.tokens")}</th><th scope="col" class="num">${t("obs.col.ttftP95")}</th><th scope="col">${t("obs.col.trend")}</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr key=${row.rowId} data-key=${row.key} data-testid="obs.keys.row">
            <td><span class="mono" data-user-content>${labelText(row, locale) || row.key}</span></td>
            <td class="num tabular">${fmt.integer(row.requests)}</td>
            <td class="num tabular">${row.errorRate === null || row.errorRate === undefined ? fmt.number(null) : fmt.percent(row.errorRate, 1)}</td>
            <td class="num tabular">${fmt.tokens((row.promptTokens || 0) + (row.outputTokens || 0))}</td>
            <td class="num tabular">${row.ttftP95Ms === null || row.ttftP95Ms === undefined ? fmt.number(null) : `${fmt.number(row.ttftP95Ms, 0)} ms`}</td>
            <td><${Spark} values=${row.spark} label=${t("obs.spark", { name: row.key })} /></td>
          </tr>`)}</tbody>
        </table>
      </div>`;
    }}<//>
  <//>`;
}

function AuthFailures({ obs }) {
  const { t } = useT();
  const fmt = useFormat();
  const failures = useTelemetry(obs, "breakdown", { dim: "client_ip", error_class: "auth_failed,auth_banned" });
  const bans = useTelemetry(obs, "events", { type: "security.ban" });
  const events = Array.isArray(bans.data?.rows) ? bans.data.rows : [];
  return html`<${Panel} title=${t("obs.panel.authFailures")} obs=${obs} testid="obs.auth">
    <${QueryView} query=${failures}>${(answer) => {
      const rows = breakdownRows(answer);
      const banned = new Set(events.map((item) => item?.data?.ip || item?.data?.ipMasked).filter(Boolean));
      if (!rows.length) return html`<p class="muted" data-testid="obs.auth.empty">${t("obs.auth.none")}</p>`;
      return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.panel.authFailures") })}>
        <table class="table" data-testid="obs.auth.table">
          <caption class="sr-only">${t("obs.panel.authFailures")} · ${obs.windowText}</caption>
          <thead><tr><th scope="col">${t("obs.col.ip")}</th><th scope="col" class="num">${t("obs.col.failures")}</th><th scope="col">${t("obs.col.lastSeen")}</th><th scope="col">${t("obs.col.banned")}</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr key=${row.rowId} data-testid="obs.auth.row">
            <td class="mono" data-user-content>${row.key}</td>
            <td class="num tabular">${fmt.integer(row.requests)}</td>
            <td>${row.lastSeen ? html`<time dateTime=${row.lastSeen} title=${fmt.dateTime(row.lastSeen)}>${fmt.relative(row.lastSeen)}</time>` : "—"}</td>
            <td>${banned.has(row.key) ? t("obs.yes") : t("obs.no")}</td>
          </tr>`)}</tbody>
        </table>
      </div>
      ${events.length ? html`<ul class="small obs-notes" aria-label=${t("obs.auth.bans")} data-testid="obs.auth.bans">
        ${events.map((item) => html`<li key=${item.id}><time dateTime=${item.at} title=${fmt.dateTime(item.at)}>${fmt.relative(item.at)}</time> · <span data-user-content>${item.title || item.type}</span></li>`)}
      </ul>` : null}`;
    }}<//>
  <//>`;
}

function Body({ obs, telemetry, owner }) {
  const { t } = useT();
  const live = useLive({ enabled: telemetry });
  const keyChart = useTelemetry(obs, "timeseries", { metrics: "req.count", groupBy: "key" }, { enabled: telemetry && owner });
  const sourceChart = useTelemetry(obs, "timeseries", { metrics: "req.count", groupBy: "source" }, { enabled: telemetry });
  const protocolChart = useTelemetry(obs, "timeseries", { metrics: "req.count", groupBy: "protocol" }, { enabled: telemetry });
  const charts = { key: keyChart, source: sourceChart, protocol: protocolChart };
  return html`
    <div class="obs-grid" data-testid="obs.traffic.charts">
      ${DIMS.filter((dim) => dim !== "key" || owner).map((dim) => html`<${ChartPanel} key=${dim} obs=${obs} title=${t(tk("obs.panel.by.", dim))} query=${charts[dim]} metrics=${["req.count"]} live=${live.data} stacked=${true} height=${200} testid=${`obs.by.${dim}`} />`)}
    </div>
    ${owner ? html`<${KeyTable} obs=${obs} />` : null}
    ${owner ? html`<${AuthFailures} obs=${obs} />` : null}
  `;
}

export default function ObservabilityTraffic() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  const owner = useRole() === "owner";
  return html`<${ObsPage} obs=${obs} id="traffic">${() => html`<${Body} obs=${obs} telemetry=${telemetry} owner=${owner} />`}<//>`;
}
