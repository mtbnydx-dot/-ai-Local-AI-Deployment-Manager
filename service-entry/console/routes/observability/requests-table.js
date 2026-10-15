// The Requests table (07 §6.7, §4.4 DataTable): the columns, the empty state and
// the server-side export link. Loaded with the Requests page on first use (see
// lazy.js) so the page module stays inside the 60 KB route budget.

import { tk } from "../../lib/i18n.js";
import { exportLink, REQUEST_FILTER_IDS, terminalTone } from "../../lib/requests-model.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo } from "../../ui/vendor.js";

function useColumns(obs) {
  const { t, has } = useT();
  const fmt = useFormat();
  return useMemo(() => {
    const dash = "—";
    const errorText = (value) => (!value || value === "none" ? dash : has(tk("obs.err.", value)) ? t(tk("obs.err.", value)) : value);
    const num = (fn) => (row) => fn(row);
    return [
      { id: "receivedAt", header: t("obs.req.col.time"), sort: (row) => Date.parse(row.receivedAt) || 0, csv: (row) => row.receivedAt,
        cell: (row) => html`<time dateTime=${row.receivedAt} title=${fmt.dateTime(row.receivedAt, { style: "long" })}>${fmt.dateTime(row.receivedAt, { style: "short" })}</time>` },
      { id: "requestId", header: t("obs.req.col.id"), sort: true,
        cell: (row) => html`<a class="mono small" href=${`/observability/requests/${encodeURIComponent(row.requestId)}${obs.search}`} data-testid="obs.req.open" data-user-content>${row.requestId}</a>` },
      { id: "model", header: t("obs.col.model"), sort: true, cell: (row) => html`<span data-user-content>${row.model || dash}</span>` },
      { id: "terminalState", header: t("obs.req.col.result"), sort: true, csv: (row) => `${row.status ?? ""} ${row.terminalState}`.trim(),
        cell: (row) => html`<span class="row-nowrap">${row.status === null ? null : html`<span class="mono small">${row.status}</span> `}<${StatusBadge} status=${terminalTone(row.terminalState)} label=${has(tk("obs.term.", row.terminalState)) ? t(tk("obs.term.", row.terminalState)) : row.terminalState || t("common.badge.unknown")} /></span>` },
      { id: "errorClass", header: t("obs.col.errorClass"), sort: true, hideable: true, csv: (row) => row.errorClass, cell: (row) => errorText(row.errorClass) },
      { id: "ttftMs", header: t("obs.req.col.ttft"), align: "end", sort: true, csv: (row) => row.ttftMs ?? "", cell: num((row) => fmt.duration(row.ttftMs)) },
      { id: "durationMs", header: t("obs.req.col.duration"), align: "end", sort: true, csv: (row) => row.durationMs ?? "", cell: num((row) => fmt.duration(row.durationMs)) },
      { id: "promptTokens", header: t("obs.col.promptTokens"), align: "end", sort: true, hideable: true, csv: (row) => row.promptTokens ?? "", cell: num((row) => fmt.integer(row.promptTokens)) },
      { id: "outputTokens", header: t("obs.col.outputTokens"), align: "end", sort: true, hideable: true, csv: (row) => row.outputTokens ?? "", cell: num((row) => fmt.integer(row.outputTokens)) },
      { id: "decodeTps", header: t("obs.col.tps"), align: "end", sort: true, hideable: true, defaultHidden: true, csv: (row) => row.decodeTps ?? "", cell: num((row) => fmt.number(row.decodeTps, 1)) },
      { id: "cachedTokens", header: t("obs.req.col.cached"), align: "end", sort: true, hideable: true, defaultHidden: true, csv: (row) => row.cachedTokens ?? "", cell: num((row) => fmt.integer(row.cachedTokens)) },
      { id: "fleetId", header: t("obs.req.col.fleet"), sort: true, hideable: true, defaultHidden: true, cell: (row) => html`<span class="mono small" data-user-content>${row.fleetId || dash}</span>` },
      { id: "sourceProgram", header: t("obs.req.col.source"), sort: true, hideable: true, cell: (row) => html`<span data-user-content>${row.sourceProgram || dash}</span>` },
      { id: "protocol", header: t("obs.req.col.protocol"), sort: true, hideable: true, defaultHidden: true, cell: (row) => row.protocol || dash },
      { id: "stream", header: t("obs.req.col.stream"), sort: (row) => (row.stream ? 1 : 0), hideable: true, defaultHidden: true, csv: (row) => (row.stream ? "1" : "0"), cell: (row) => t(row.stream ? "obs.yes" : "obs.no") },
      { id: "keyId", header: t("obs.col.key"), sort: true, hideable: true, defaultHidden: true, cell: (row) => html`<span class="mono small" data-user-content>${row.keyId || dash}</span>` },
      { id: "clientIp", header: t("obs.col.ip"), sort: true, hideable: true, defaultHidden: true, cell: (row) => html`<span class="mono small" data-user-content>${row.clientIp || dash}</span>` },
    ];
  }, [t, has, fmt, obs.search]);
}

export function RequestsTable({ obs, list, filters }) {
  const { t } = useT();
  const columns = useColumns(obs);
  const link = exportLink(obs.state, filters, Date.now());
  const clearable = Object.keys(obs.filters).length + Object.keys(filters).length > 0;
  const empty = html`<${EmptyState} icon="search" title=${t("obs.empty.requests")} testid="obs.req.empty"
    action=${clearable
      ? { label: t("obs.empty.clearFilters"), onClick: () => obs.apply({ filters: Object.fromEntries(["manager_id", "fleet_id", "engine_id", "model", "key_id", "source_program", "protocol"].map((name) => [name, null])), extra: Object.fromEntries(REQUEST_FILTER_IDS.map((name) => [name, null])) }) }
      : { label: t("obs.empty.widen"), onClick: () => obs.setRange({ range: { "15m": "1h", "1h": "6h", "6h": "24h", "24h": "7d", "7d": "30d" }[obs.range?.range] || "30d" }) }} />`;
  return html`<div class="stack-sm" data-testid="obs.req.table-area">
    ${list.error ? html`<p class="notice notice-warn" role="alert" data-testid="obs.req.more-error">${t("obs.req.moreFailed")}</p>` : null}
    <${DataTable} id="obs-requests" columns=${columns} rows=${list.rows} rowKey="requestId" caption=${t("obs.req.tableCaption")} exportName="requests"
      exportHref=${link.href} empty=${empty} responsive="cards" testid="obs.req.table"
      source=${{ cursor: list.cursor, loading: list.loading, loadMore: () => list.loadMore() }} />
    ${link.partial ? html`<p class="small muted" role="note" data-testid="obs.req.exportPartial">${t("obs.req.exportPartial")}</p>` : null}
  </div>`;
}

