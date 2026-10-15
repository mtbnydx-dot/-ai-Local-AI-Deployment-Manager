// Audit › Access log `/audit/access-log` (07 §6.8, 04 §16.4): who looked at
// the audit and what they did — the append-only, hash-chained audit_access_log
// (GET /api/audit/access-log) and its verification (…/verify). Needs the audit
// unlock. A broken chain is said out loud with the entry it breaks after.

import { accessPage, detailText, LOG_PAGE, outcomeTone, verifyView } from "../../lib/audit-model.js";
import { tk } from "../../lib/i18n.js";
import { resolveTimeRange } from "../../lib/time-range.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { TimeRangePicker, useRangeLabel, useTimeRangeParam } from "../../components/time-range-picker.js";
import { AuditPage, LoadError, Loading, useAuditApi, useAuditPages } from "./common.js";
import { useAuditErrorText } from "./common.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";

function Verify() {
  const audit = useAuditApi();
  const { t } = useT();
  const errorText = useAuditErrorText();
  const [state, setState] = useState({ busy: false, result: null, error: null });
  async function run() {
    setState({ busy: true, result: null, error: null });
    try {
      setState({ busy: false, result: verifyView(await audit.get("access-log/verify")), error: null });
    } catch (error) {
      setState({ busy: false, result: null, error });
    }
  }
  const { result, error } = state;
  return html`<div class="stack-sm" data-testid="audit.verify">
    <div class="row">
      <${Button} icon="check" busy=${state.busy} onClick=${run} testid="audit.verify-run">${t("audit.verify")}<//>
      <span class="small muted">${t("audit.verify.note")}</span>
    </div>
    ${result?.ok ? html`<p class="notice notice-success" role="status" data-testid="audit.verify-ok">${t("audit.verify.ok", { rows: result.rows })}</p>` : null}
    ${result && !result.ok ? html`<p class="notice notice-danger" role="alert" data-testid="audit.verify-broken">${result.firstBrokenSeq === null ? t("audit.verify.failed") : t("audit.chainBroken", { seq: result.firstBrokenSeq })}</p>` : null}
    ${error ? html`<p class="notice notice-warn" role="alert" data-testid="audit.verify-error">${errorText(error)}</p>` : null}
  </div>`;
}

function Log() {
  const audit = useAuditApi();
  const { t, has } = useT();
  const fmt = useFormat();
  const rangeLabel = useRangeLabel();
  const [range, setRange, { valid }] = useTimeRangeParam({ fallback: "7d" });
  const id = JSON.stringify(range);
  const log = useAuditPages(id, async (cursor) => {
    const span = resolveTimeRange(range, Date.now());
    const page = accessPage(await audit.get("access-log", { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString(), limit: LOG_PAGE, ...(cursor ? { cursor } : {}) }));
    return { rows: page.rows, cursor: page.cursor };
  });
  const windowText = rangeLabel(range, Date.now());
  const columns = useMemo(() => [
    { id: "seq", header: t("audit.col.seq"), align: "end", sort: true },
    { id: "at", header: t("audit.col.time"), sort: (row) => Date.parse(row.at) || 0, csv: (row) => row.at,
      cell: (row) => (row.at ? html`<time dateTime=${row.at} title=${fmt.dateTime(row.at, { style: "long" })}>${fmt.dateTime(row.at, { style: "short" })}</time>` : "—") },
    { id: "action", header: t("audit.col.action"), sort: true, csv: (row) => row.action, cell: (row) => (has(tk("audit.action.", row.action)) ? t(tk("audit.action.", row.action)) : row.action) },
    { id: "outcome", header: t("audit.col.outcome"), sort: true, csv: (row) => row.outcome,
      cell: (row) => html`<${StatusBadge} status=${outcomeTone(row.outcome)} label=${has(tk("audit.outcome.", row.outcome)) ? t(tk("audit.outcome.", row.outcome)) : row.outcome || t("common.badge.unknown")} />` },
    { id: "actor", header: t("audit.col.actor"), sort: true, cell: (row) => html`<span class="mono small" data-user-content>${row.actor || "—"}</span>` },
    { id: "target", header: t("audit.col.target"), sort: true, hideable: true, cell: (row) => html`<span class="mono small" data-user-content>${row.target || "—"}</span>` },
    { id: "clientIp", header: t("obs.col.ip"), sort: true, hideable: true, defaultHidden: true, cell: (row) => html`<span class="mono small" data-user-content>${row.clientIp || "—"}</span>` },
    { id: "source", header: t("obs.col.source"), sort: true, hideable: true, defaultHidden: true, cell: (row) => html`<span data-user-content>${row.source || "—"}</span>` },
    { id: "detail", header: t("audit.col.detail"), hideable: true, defaultHidden: true, csv: (row) => detailText(row.detail), cell: (row) => html`<span class="mono small" data-user-content>${detailText(row.detail) || "—"}</span>` },
    { id: "hash", header: t("audit.col.hash"), hideable: true, defaultHidden: true, cell: (row) => html`<span class="mono small" title=${row.hash} data-user-content>${row.hash.slice(0, 12)}</span>` },
  ], [t, has, fmt]);
  const empty = html`<${EmptyState} icon="search" title=${t("audit.log.empty")} action=${{ label: t("obs.empty.widen"), onClick: () => setRange({ range: "30d" }) }} testid="audit.log.empty" />`;
  return html`<${Card} title=${t("audit.accessLog")} testid="audit.log">
    <div class="stack-sm">
      <p class="small muted obs-window" data-window=${windowText} data-testid="obs.panel.window">${windowText}</p>
      <${TimeRangePicker} value=${range} onChange=${(value) => setRange(value)} />
      ${valid ? null : html`<p class="notice notice-warn" role="status">${t("obs.rangeFallback")}</p>`}
      <${Verify} />
      ${log.error ? html`<${LoadError} error=${log.error} onRetry=${log.reload} />`
        : log.loading ? html`<${Loading} rows=${4} />`
        : html`<${DataTable} id="audit-access-log" columns=${columns} rows=${log.rows} rowKey="seq" caption=${t("audit.table.log")} exportName="audit-access-log" empty=${empty} responsive="cards"
          source=${{ cursor: log.cursor, loading: log.loadingMore, loadMore: log.loadMore }} testid="audit.log.table" />`}
      ${log.moreError ? html`<p class="notice notice-warn" role="alert">${t("obs.req.moreFailed")}</p>` : null}
    </div>
  <//>`;
}

export default function AuditAccessLog() {
  return html`<${AuditPage} id="access-log" needsUnlock=${true}>${() => html`<${Log} />`}<//>`;
}
