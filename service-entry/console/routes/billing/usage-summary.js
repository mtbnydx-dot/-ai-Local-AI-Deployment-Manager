// The period's usage as aggregates (07 §6.11, TEL-14): a daily token chart
// above a customer x model x month table with an exact total row, built from
// GET /api/billing/usage/summary. Amounts are integer microcredits summed by
// the server and shown as exact decimals. The panel is absent unless the
// answer has the summary shape, so raw records are never passed off as
// aggregates. A customer or model cell drills into the raw requests.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { tk } from "../../lib/i18n.js";
import { html } from "../../ui/html.js";
import { dailyChart, summaryPeriod } from "../../lib/billing-model.js";
import { useBillingFormat } from "./views.js";

const COLUMNS = ["customer", "model", "month", "requests", "ok", "input", "cached", "output", "projected", "charged"];
const KEY_COLUMNS = 3;

function NumberCells({ item, fmt }) {
  return html`${[item.requests, item.ok, item.inputTokens, item.cachedInputTokens, item.outputTokens].map((value, index) => html`<td key=${index} class="num">${fmt.integer(value)}</td>`)}
    <td class="num">${fmt.microcredits(item.projectedMicrocredits)}</td>
    <td class="num">${fmt.microcredits(item.chargedMicrocredits)}</td>`;
}

function DailyChart({ daily, fmt }) {
  const { t } = fmt;
  const chart = dailyChart(daily);
  if (!chart) return null;
  const peak = fmt.integer(chart.peak);
  return html`<figure class="usage-chart" data-testid="billing.summary.chart">
    <figcaption data-testid="billing.summary.chart-caption">${t("billing.summary.chart", { peak })}</figcaption>
    <svg viewBox=${`0 0 ${chart.width} 100`} role="img" preserveAspectRatio="none" aria-label=${t("billing.summary.chartLabel", { days: chart.days.length, peak })} data-testid="billing.summary.chart-svg">
      <line class="usage-chart-baseline" x1="0" y1="99.5" x2=${chart.width} y2="99.5" />
      ${chart.bars.map((bar) => html`<rect key=${bar.day} class="usage-chart-bar" x=${bar.x} y=${bar.y} width=${bar.width} height=${bar.height}>
        <title>${t("billing.summary.bar", { day: bar.day, requests: fmt.integer(bar.row.requests), tokens: fmt.integer(bar.row.totalTokens), credits: fmt.microcredits(bar.row.projectedMicrocredits) })}</title>
      </rect>`)}
    </svg>
    <div class="usage-chart-axis" data-testid="billing.summary.chart-axis">${chart.ticks.map((day) => html`<span key=${day}>${day.slice(5)}</span>`)}</div>
  </figure>`;
}

/** @param data useBillingData()  @param onDrill({ customerId?, model? }) opens those raw requests */
export function UsageSummary({ data, onDrill }) {
  const fmt = useBillingFormat();
  const { t, locale } = fmt;
  const summary = data.usageSummary;
  if (!summary) return null;
  const period = summaryPeriod(summary);
  return html`<div lang=${locale} data-testid="billing.summary">
    <${Card} title=${t("billing.summary.heading")} level=${2}>
      <p class="muted small" data-testid="billing.summary.note">${t("billing.summary.note", period)}</p>
      <${DailyChart} daily=${data.usageDaily} fmt=${fmt} />
      <div class="table-wrap" tabindex="0" role="region" aria-label=${t("billing.summary.heading")}>
        <table class="table usage-summary-table">
          <thead><tr>${COLUMNS.map((name, index) => html`<th key=${name} scope="col" class=${index >= KEY_COLUMNS ? "num" : undefined}>${t(tk("billing.summary.col.", name))}</th>`)}</tr></thead>
          <tbody data-testid="billing.summary.rows">
            ${summary.rows.length ? summary.rows.map((item, index) => html`<tr key=${index}>
              <td data-user-content>${item.customerId
                ? html`<${Button} variant="ghost" size="sm" onClick=${() => onDrill?.({ customerId: item.customerId })} label=${t("billing.summary.drillCustomer", { name: item.customerName || data.customerName(item.customerId) })}>${item.customerName || data.customerName(item.customerId)}<//>`
                : t("billing.summary.unbound")}</td>
              <td data-user-content>${item.model
                ? html`<${Button} variant="ghost" size="sm" onClick=${() => onDrill?.({ customerId: item.customerId, model: item.model })} label=${t("billing.summary.drillModel", { model: item.model })}>${item.model}<//>`
                : "—"}</td>
              <td>${item.month || "—"}</td>
              <${NumberCells} item=${item} fmt=${fmt} />
            </tr>`) : html`<tr><td colspan=${COLUMNS.length} class="muted">${t("billing.summary.empty")}</td></tr>`}
          </tbody>
          ${summary.rows.length ? html`<tfoot data-testid="billing.summary.totals"><tr>
            <td>${t("billing.summary.total")}</td><td></td><td></td>
            <${NumberCells} item=${summary.totals} fmt=${fmt} />
          </tr></tfoot>` : null}
        </table>
      </div>
      ${summary.truncated ? html`<p class="muted small" data-testid="billing.summary.truncated">${t("billing.summary.truncated", { count: fmt.integer(String(summary.rows.length)) })}</p>` : null}
    <//>
  </div>`;
}
