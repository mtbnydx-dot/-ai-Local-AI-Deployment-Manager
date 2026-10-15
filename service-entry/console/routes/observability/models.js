// Observability › Models & instances `/observability/models` (07 §6.7, 04
// §19): the lifecycle Gantt, launch reliability with the top failures, the
// share of answers cut off by length, and the imported lifetime totals, which
// are never charted over time.

import { Panel, ObsPage, PanelEmpty, QueryView, useObsState, useTelemetry } from "./common.js";
import { Gantt } from "./gantt.js";
import { breakdownRows, ganttModel, launchRows, windowBounds } from "../../lib/observability-model.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";

function Lifecycle({ obs, query }) {
  const { t } = useT();
  return html`<${Panel} title=${t("obs.panel.lifecycle")} obs=${obs} testid="obs.lifecycle">
    <${QueryView} query=${query}>${(answer) => {
      const bounds = windowBounds(obs.range, Date.now());
      return html`<${Gantt} model=${ganttModel(answer, { from: bounds.fromMs, to: bounds.toMs })} window=${obs.windowText} />`;
    }}<//>
  <//>`;
}

function Launches({ obs, query }) {
  const { t } = useT();
  const fmt = useFormat();
  const seconds = (value) => (value === null ? fmt.number(null) : fmt.duration(value * 1000));
  return html`<${Panel} title=${t("obs.panel.launches")} obs=${obs} testid="obs.launches">
    <${QueryView} query=${query}>${(answer) => {
      const rows = launchRows(answer);
      if (!rows.length) return html`<${PanelEmpty} obs=${obs} title=${t("obs.empty.launches")} />`;
      return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.panel.launches") })}>
        <table class="table" data-testid="obs.launches.table">
          <caption class="sr-only">${t("obs.panel.launches")} · ${obs.windowText}</caption>
          <thead><tr><th scope="col">${t("obs.col.model")}</th><th scope="col" class="num">${t("obs.col.started")}</th><th scope="col" class="num">${t("obs.col.ready")}</th>
            <th scope="col" class="num">${t("obs.col.failed")}</th><th scope="col" class="num">${t("obs.col.readyP50")}</th><th scope="col">${t("obs.col.topFailures")}</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr key=${row.key} data-testid="obs.launches.row">
            <td><span data-user-content>${row.key}</span></td>
            <td class="num tabular">${fmt.integer(row.started)}</td>
            <td class="num tabular">${fmt.integer(row.ready)}</td>
            <td class="num tabular">${fmt.integer(row.failed)}</td>
            <td class="num tabular">${seconds(row.readyP50Seconds)}</td>
            <td>${row.topFailures.length ? html`<ul class="obs-failures small">${row.topFailures.map((item) => html`<li key=${item.signature}><code class="code-inline" data-user-content>${item.signature}</code> <span class="num muted">× ${fmt.integer(item.count)}</span></li>`)}</ul>` : "—"}</td>
          </tr>`)}</tbody>
        </table>
      </div>`;
    }}<//>
  <//>`;
}

function Truncation({ obs, query }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<${Panel} title=${t("obs.panel.truncation")} obs=${obs} testid="obs.truncation">
    <p class="small muted">${t("obs.truncation.note")}</p>
    <${QueryView} query=${query}>${(answer) => {
      const rows = breakdownRows(answer);
      if (!rows.length) return html`<${PanelEmpty} obs=${obs} title=${t("obs.empty.truncation")} />`;
      return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.panel.truncation") })}>
        <table class="table" data-testid="obs.truncation.table">
          <caption class="sr-only">${t("obs.panel.truncation")} · ${obs.windowText}</caption>
          <thead><tr><th scope="col">${t("obs.col.model")}</th><th scope="col" class="num">${t("obs.col.requests")}</th><th scope="col" class="num">${t("obs.col.lengthShare")}</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr key=${row.rowId} data-testid="obs.truncation.row">
            <td><span data-user-content>${row.key}</span></td>
            <td class="num tabular">${fmt.integer(row.requests)}</td>
            <td class="num tabular">${Number.isFinite(row.lengthShare)
              ? html`<progress class="obs-share" max="1" value=${row.lengthShare} aria-label=${t("obs.col.lengthShare")}></progress> ${fmt.percent(row.lengthShare, 1)}`
              : fmt.number(null)}</td>
          </tr>`)}</tbody>
        </table>
      </div>`;
    }}<//>
  <//>`;
}

function Imported({ obs, query }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<${Panel} title=${t("obs.panel.imported")} obs=${obs} windowText=${t("obs.importedLifetime")} testid="obs.imported">
    <${QueryView} query=${query}>${(answer) => {
      const rows = Array.isArray(answer?.rows) ? answer.rows.filter((row) => row && typeof row === "object") : [];
      if (!rows.length) return html`<p class="muted" data-testid="obs.imported.empty">${t("obs.imported.none")}</p>`;
      return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.panel.imported") })}>
        <table class="table" data-testid="obs.imported.table">
          <caption class="sr-only">${t("obs.panel.imported")} · ${t("obs.importedLifetime")}</caption>
          <thead><tr><th scope="col">${t("obs.col.model")}</th><th scope="col">${t("obs.col.manager")}</th><th scope="col" class="num">${t("obs.col.requests")}</th>
            <th scope="col" class="num">${t("obs.col.promptTokens")}</th><th scope="col" class="num">${t("obs.col.outputTokens")}</th><th scope="col">${t("obs.col.firstSeen")}</th><th scope="col">${t("obs.col.lastSeen")}</th></tr></thead>
          <tbody>${rows.map((row, index) => html`<tr key=${index} data-testid="obs.imported.row">
            <td><span data-user-content>${row.model || "—"}</span></td>
            <td><span class="mono" data-user-content>${row.managerId || "—"}</span></td>
            <td class="num tabular">${fmt.integer(row.requests)}</td>
            <td class="num tabular">${fmt.tokens(row.promptTokens)}</td>
            <td class="num tabular">${fmt.tokens(row.outputTokens)}</td>
            <td>${row.firstSeen ? fmt.dateTime(row.firstSeen, { style: "short" }) : "—"}</td>
            <td>${row.lastSeen ? fmt.dateTime(row.lastSeen, { style: "short" }) : "—"}</td>
          </tr>`)}</tbody>
        </table>
      </div>`;
    }}<//>
  <//>`;
}

function Body({ obs, telemetry }) {
  const lifecycle = useTelemetry(obs, "lifecycle", {}, { enabled: telemetry });
  const launches = useTelemetry(obs, "launches", { groupBy: "model" }, { enabled: telemetry });
  const truncation = useTelemetry(obs, "breakdown", { dim: "model", metrics: "requests,lengthShare" }, { enabled: telemetry });
  const baseline = useTelemetry(obs, "baseline", {}, { enabled: telemetry, ttlMs: 60_000 });
  return html`
    <${Lifecycle} obs=${obs} query=${lifecycle} />
    <${Launches} obs=${obs} query=${launches} />
    <${Truncation} obs=${obs} query=${truncation} />
    <${Imported} obs=${obs} query=${baseline} />
  `;
}

export default function ObservabilityModels() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  return html`<${ObsPage} obs=${obs} id="models">${() => html`<${Body} obs=${obs} telemetry=${telemetry} />`}<//>`;
}
