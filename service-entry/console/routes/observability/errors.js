// Observability › Errors `/observability/errors` (07 §6.7, 04 §19): the rate
// of failed requests by `error_class`, and a class table whose rows open
// Requests pre-filtered to that class.

import { tk } from "../../lib/i18n.js";
import { Panel, ChartPanel, ObsPage, PanelEmpty, QueryView, useLive, useObsState, useTelemetry } from "./common.js";
import { breakdownRows, requestsHref } from "../../lib/observability-model.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";

function ClassTable({ obs }) {
  const { router } = useServices();
  const { t, has } = useT();
  const fmt = useFormat();
  const query = useTelemetry(obs, "breakdown", { dim: "error_class" });
  const label = (key) => (has(tk("obs.err.", key)) ? t(tk("obs.err.", key)) : key);
  const open = (href) => {
    if (router?.navigate) router.navigate(href);
  };
  return html`<${Panel} title=${t("obs.panel.errorClasses")} obs=${obs} testid="obs.classes">
    <${QueryView} query=${query}>${(answer) => {
      const rows = breakdownRows(answer).filter((row) => row.key !== "none");
      if (!rows.length) return html`<${PanelEmpty} obs=${obs} title=${t("obs.empty.errors")} />`;
      return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.panel.errorClasses") })}>
        <table class="table" data-testid="obs.classes.table">
          <caption class="sr-only">${t("obs.panel.errorClasses")} · ${obs.windowText}</caption>
          <thead><tr><th scope="col">${t("obs.col.errorClass")}</th><th scope="col" class="num">${t("obs.col.requests")}</th><th scope="col" class="num">${t("obs.col.share")}</th>
            <th scope="col">${t("obs.col.firstSeen")}</th><th scope="col">${t("obs.col.lastSeen")}</th><th scope="col">${t("obs.col.samples")}</th></tr></thead>
          <tbody>${rows.map((row) => {
            const href = requestsHref(obs.search, { error_class: row.key });
            return html`<tr key=${row.rowId} class="obs-row-link" data-class=${row.key} data-testid="obs.classes.row" onClick=${(event) => {
              if (event.target.closest?.("a, button")) return;
              open(href);
            }}>
              <td><a href=${href} data-testid="obs.classes.open">${label(row.key)}</a> <span class="muted small mono">${row.key}</span></td>
              <td class="num tabular">${fmt.integer(row.requests)}</td>
              <td class="num tabular">${row.share === null ? fmt.number(null) : fmt.percent(row.share, 1)}</td>
              <td>${row.firstSeen ? html`<time dateTime=${row.firstSeen} title=${fmt.dateTime(row.firstSeen)}>${fmt.relative(row.firstSeen)}</time>` : "—"}</td>
              <td>${row.lastSeen ? html`<time dateTime=${row.lastSeen} title=${fmt.dateTime(row.lastSeen)}>${fmt.relative(row.lastSeen)}</time>` : "—"}</td>
              <td>${row.sampleRequestIds.length ? html`<ul class="obs-samples">${row.sampleRequestIds.map((id) => html`<li key=${id}><a class="mono small" href=${`/observability/requests/${encodeURIComponent(id)}`} data-testid="obs.classes.sample" data-user-content>${id}</a></li>`)}</ul>` : "—"}</td>
            </tr>`;
          })}</tbody>
        </table>
      </div>`;
    }}<//>
  <//>`;
}

function Body({ obs, telemetry }) {
  const { t } = useT();
  const live = useLive({ enabled: telemetry });
  const rate = useTelemetry(obs, "timeseries", { metrics: "req.errors", groupBy: "error_class" }, { enabled: telemetry });
  return html`
    <${ChartPanel} obs=${obs} title=${t("obs.panel.errorRate")} query=${rate} metrics=${["req.errors"]} live=${live.data} stacked=${true} testid="obs.errors" />
    <${ClassTable} obs=${obs} />
  `;
}

export default function ObservabilityErrors() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  return html`<${ObsPage} obs=${obs} id="errors">${() => html`<${Body} obs=${obs} telemetry=${telemetry} />`}<//>`;
}
