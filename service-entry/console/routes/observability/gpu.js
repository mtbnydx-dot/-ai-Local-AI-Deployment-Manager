// Observability › GPU & energy `/observability/gpu` (07 §6.7, 04 §19): util,
// VRAM, temperature, power and clocks per GPU with the throttle reasons; VRAM
// by instance (a reservation, labelled as one); energy by day and by model.

import { Panel, ChartPanel, MetricGrid, ObsPage, QueryView, useLive, useObsState, useTelemetry } from "./common.js";
import { energyRows, priceConfigured } from "../../lib/observability-model.js";
import { StackedBar } from "../../components/stacked-bar.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";

const GPU_METRICS = ["gpu.util", "gpu.mem_used_mb", "gpu.temp_c", "gpu.power_w", "gpu.sm_clock_mhz"];

function VramByInstance({ obs, live }) {
  const { t } = useT();
  return html`<${Panel} title=${t("obs.panel.vram")} obs=${obs} windowText=${t("obs.live.now")} testid="obs.vram">
    <p class="small muted" data-testid="obs.vram.note">${t("obs.reservation")}</p>
    <${QueryView} query=${live}>${(data) => {
      const instances = (Array.isArray(data.instances) ? data.instances : []).filter((item) => Number.isFinite(item.vramReservationMb));
      const gpus = Array.isArray(data.gpus) ? data.gpus : [];
      const total = gpus.reduce((sum, gpu) => sum + (Number.isFinite(gpu.memTotalMb) ? gpu.memTotalMb : 0), 0);
      if (!instances.length) return html`<p class="muted" data-testid="obs.vram.empty">${t("obs.vram.none")}</p>`;
      return html`<${StackedBar} total=${total} unit="MiB" parts=${instances.map((item) => ({ id: item.fleetId, label: item.model || item.fleetId, value: item.vramReservationMb }))} testid="obs.vram.bar" />`;
    }}<//>
  <//>`;
}

function EnergyTable({ obs, query, title, keyHeader, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<${Panel} title=${title} obs=${obs} testid=${testid}>
    <${QueryView} query=${query}>${(answer) => {
      const rows = energyRows(answer);
      const priced = priceConfigured(answer);
      const currency = typeof answer?.currency === "string" ? answer.currency : "";
      return html`<div class="stack-sm">
        ${priced ? null : html`<p class="notice notice-info" role="status" data-testid="obs.no-price">${t("obs.noPrice")}</p>`}
        ${rows.length ? html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title })}>
          <table class="table" data-testid=${`${testid}.table`}>
            <caption class="sr-only">${title} · ${obs.windowText}</caption>
            <thead><tr><th scope="col">${keyHeader}</th><th scope="col" class="num">${t("obs.col.kwh")}</th>
              ${priced ? html`<th scope="col" class="num">${t("obs.col.cost")}</th><th scope="col" class="num">${t("obs.col.costPerM")}</th>` : null}</tr></thead>
            <tbody>${rows.map((row) => html`<tr key=${row.key} data-testid=${`${testid}.row`}>
              <td><span class="mono" data-user-content>${row.key}</span></td>
              <td class="num tabular">${row.energyWh === null ? fmt.number(null) : `${fmt.number(row.energyWh / 1000, 2)} kWh`}</td>
              ${priced ? html`<td class="num tabular">${row.cost === null ? fmt.number(null) : `${fmt.number(row.cost, 2)} ${currency}`}</td>
                <td class="num tabular">${row.costPerMOutputTokens === null ? fmt.number(null) : `${fmt.number(row.costPerMOutputTokens, 2)} ${currency}`}</td>` : null}
            </tr>`)}</tbody>
          </table>
        </div>` : html`<p class="muted" data-testid=${`${testid}.empty`}>${t("obs.energy.none")}</p>`}
      </div>`;
    }}<//>
  <//>`;
}

function Body({ obs, telemetry }) {
  const { t } = useT();
  const live = useLive({ enabled: telemetry });
  const gpu = useTelemetry(obs, "timeseries", { metrics: GPU_METRICS.join(","), groupBy: "gpu" }, { enabled: telemetry });
  const throttle = useTelemetry(obs, "timeseries", { metrics: "gpu.throttle_seconds", groupBy: "reason" }, { enabled: telemetry });
  const byDay = useTelemetry(obs, "energy", { groupBy: "day" }, { enabled: telemetry });
  const byModel = useTelemetry(obs, "energy", { groupBy: "model" }, { enabled: telemetry });
  return html`
    <${Panel} title=${t("obs.panel.gpu")} obs=${obs} testid="obs.gpu">
      <${QueryView} query=${gpu}>${(answer) => html`<${MetricGrid} obs=${obs} answer=${answer} metrics=${GPU_METRICS} live=${live.data} testid="obs.gpu.grid" />`}<//>
    <//>
    <${ChartPanel} obs=${obs} title=${t("obs.panel.throttle")} query=${throttle} metrics=${["gpu.throttle_seconds"]} live=${live.data} stacked=${true} testid="obs.throttle" />
    <${VramByInstance} obs=${obs} live=${live} />
    <div class="obs-grid">
      <${EnergyTable} obs=${obs} query=${byDay} title=${t("obs.panel.energyDay")} keyHeader=${t("obs.col.day")} testid="obs.energy-day" />
      <${EnergyTable} obs=${obs} query=${byModel} title=${t("obs.panel.energyModel")} keyHeader=${t("obs.col.model")} testid="obs.energy-model" />
    </div>
  `;
}

export default function ObservabilityGpu() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  return html`<${ObsPage} obs=${obs} id="gpu">${() => html`<${Body} obs=${obs} telemetry=${telemetry} />`}<//>`;
}
