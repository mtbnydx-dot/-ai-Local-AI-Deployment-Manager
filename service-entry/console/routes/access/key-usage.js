// The telemetry half of a key's detail page (07 §6.10, 05 §13.4): a usage
// chart from `GET /api/telemetry/timeseries?key_id=` and the recent requests
// from `GET /api/telemetry/requests?key_id=` (04 §11.3, §11.5), over a time
// range kept in the URL. Loaded only when the detail page has telemetry.

import { tk } from "../../lib/i18n.js";
import { resolveTimeRange, suggestStep, timeRangeQuery } from "../../lib/time-range.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { TimeRangePicker, useTimeRangeParam } from "../../components/time-range-picker.js";
import { TimeSeriesChart } from "../../components/time-series-chart.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useRouter } from "../../ui/shell.js";
import { useMemo } from "../../ui/vendor.js";

const REQUEST_LIMIT = 50;
const METRICS = ["req.count", "tok.prompt", "tok.output"];
const TERMINAL_TONE = { completed: "ok", failed: "error", client_abort: "neutral", timeout: "warn", rejected: "warn" };

/** Series of a timeseries answer → one shared x axis (epoch seconds) and values aligned to it; a missing sample is a gap. */
export function chartData(answer, ids) {
  const wanted = (Array.isArray(answer?.series) ? answer.series : []).filter((item) => ids.includes(item.metric));
  const times = [...new Set(wanted.flatMap((item) => (item.points || []).map((point) => point[0])))].sort((a, b) => a - b);
  const series = wanted.map((item) => {
    const byTime = new Map((item.points || []).map((point) => [point[0], typeof point[1] === "number" ? point[1] : null]));
    return { id: item.metric, unit: item.unit || "", values: times.map((time) => byTime.get(time) ?? null) };
  });
  return { x: times.map((time) => Math.floor(time / 1000)), series };
}

export function KeyUsage({ keyId }) {
  const { api } = useServices();
  const { t, has } = useT();
  const fmt = useFormat();
  const router = useRouter();
  const [value, setValue] = useTimeRangeParam({ fallback: "7d" });
  const span = useMemo(() => resolveTimeRange(value, Date.now()), [timeRangeQuery(value)]);
  const bounds = { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString() };
  const series = useQuery(["telemetry", "timeseries", "key", keyId, timeRangeQuery(value)], () => api.get("/api/telemetry/timeseries", {
    query: { metrics: METRICS.join(","), key_id: keyId, ...bounds, step: suggestStep(span) },
  }), { ttlMs: 15_000, keepPrevious: false });
  const requests = useQuery(["telemetry", "requests", "key", keyId, timeRangeQuery(value)], () => api.get("/api/telemetry/requests", {
    query: { key_id: keyId, ...bounds, limit: REQUEST_LIMIT },
  }), { ttlMs: 15_000, keepPrevious: false });

  const label = (metric) => (has(tk("access.metric.", metric)) ? t(tk("access.metric.", metric)) : metric);
  const requestChart = chartData(series.data, ["req.count"]);
  const tokenChart = chartData(series.data, ["tok.prompt", "tok.output"]);
  const windowText = fmt.range(span.from, span.to);
  const rows = Array.isArray(requests.data?.rows) ? requests.data.rows : [];

  const columns = [
    { id: "at", header: t("access.requests.at"), sort: (row) => Date.parse(row.receivedAt), cell: (row) => html`<span title=${row.receivedAt}>${fmt.dateTime(row.receivedAt, { style: "short" })}</span>`, csv: (row) => row.receivedAt },
    { id: "model", header: t("access.requests.model"), cell: (row) => html`<span class="mono small" data-user-content>${row.modelResolved || row.modelRequested || "—"}</span>`, csv: (row) => row.modelResolved || row.modelRequested || "" },
    {
      id: "status",
      header: t("access.requests.status"),
      cell: (row) => html`<${StatusBadge} status=${TERMINAL_TONE[row.terminalState] || "neutral"} label=${`${row.status ?? ""} ${row.terminalState || ""}`.trim()} />`,
      csv: (row) => `${row.status ?? ""} ${row.terminalState || ""}`.trim(),
    },
    { id: "duration", header: t("access.requests.duration"), align: "end", sort: (row) => row.durationMs, cell: (row) => (typeof row.durationMs === "number" ? fmt.duration(row.durationMs) : "—"), csv: (row) => row.durationMs ?? "" },
    { id: "tokens", header: t("access.requests.tokens"), align: "end", cell: (row) => html`<span class="tabular">${fmt.integer(row.promptTokens || 0)} / ${fmt.integer(row.outputTokens || 0)}</span>`, csv: (row) => `${row.promptTokens ?? ""}/${row.outputTokens ?? ""}` },
    { id: "client", header: t("access.requests.client"), hideable: true, cell: (row) => html`<span class="mono small" data-user-content>${row.clientIp || "—"}${row.clientCountry ? ` · ${row.clientCountry}` : ""}</span>`, csv: (row) => `${row.clientIp || ""} ${row.clientCountry || ""}`.trim() },
    { id: "open", header: t("access.table.actions"), csv: false, cell: (row) => html`<a href=${router.href("observability.request", { requestId: row.requestId })} data-testid="key-usage.request-link">${t("access.requests.open")}</a>` },
  ];

  const failed = (series.status === "error" && !series.data) || (requests.status === "error" && !requests.data);
  return html`<div class="stack" data-testid="key-usage.root">
    <${TimeRangePicker} value=${value} onChange=${setValue} maxRangeDays=${90} />
    ${failed ? html`<${EmptyState} icon="activity" title=${t("access.usage.historyFailed")} body=${(series.error || requests.error)?.message || ""} action=${{ label: t("access.retry"), onClick: () => {
      series.refetch();
      requests.refetch();
    } }} />` : html`
      <div class="grid-auto kd-charts">
        <${Card} title=${t("access.usage.requests")} testid="key-usage.requests-chart">
          <${TimeSeriesChart} series=${requestChart.series.map((item) => ({ ...item, label: label(item.id) }))} x=${requestChart.x} height=${180} title=${t("access.usage.requests")} window=${windowText} />
        <//>
        <${Card} title=${t("access.usage.tokens")} testid="key-usage.tokens-chart">
          <${TimeSeriesChart} series=${tokenChart.series.map((item) => ({ ...item, label: label(item.id) }))} x=${tokenChart.x} height=${180} title=${t("access.usage.tokens")} window=${windowText} />
        <//>
      </div>
      <${Card} title=${t("access.requests.title")} testid="key-usage.requests" actions=${html`<a href=${router.href("observability.requests", {}, { key_id: keyId })}>${t("access.requests.all")}</a>`}>
        <${DataTable} id="access-key-requests" columns=${columns} rows=${rows} rowKey=${(row) => row.requestId} loading=${requests.status === "loading" && !requests.data} responsive="cards"
          caption=${t("access.requests.caption")} exportName="key-requests"
          empty=${html`<p class="muted" data-testid="key-usage.empty">${t("access.requests.empty")}</p>`} />
      <//>`}
  </div>`;
}
