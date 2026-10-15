// /billing/audit, the Audit tab (07 §6.11): the administrator's billing
// operations as the server publishes them, already reduced to a redacted
// summary. Details that look like secrets are replaced before they are shown,
// and fields outside the allowlist never reach the page.

import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { html } from "../../ui/html.js";
import { usePaged } from "./data.js";
import { EmptyTable, useBillingFormat } from "./views.js";

export default function AuditTab({ data }) {
  const fmt = useBillingFormat();
  const { t } = fmt;
  const paged = usePaged({ first: data.audit, fetchPage: data.pageAudit, resetKey: "audit" });
  const columns = [
    { id: "at", header: t("billing.col.time"), sort: (e) => Date.parse(e.at) || 0, cell: (e) => fmt.dateTime(e.at), csv: (e) => e.at },
    { id: "action", header: t("billing.col.action"), sort: (e) => e.action, cell: (e) => html`<span data-user-content>${e.action || "\u2014"}</span>`, csv: (e) => e.action },
    { id: "actor", header: t("billing.col.actor"), sort: (e) => e.actor, cell: (e) => html`<span data-user-content>${e.actor || "system"}</span>`, csv: (e) => e.actor },
    { id: "target", header: t("billing.col.target"), cell: (e) => html`<span data-user-content>${e.target || "\u2014"}</span>`, csv: (e) => e.target },
    { id: "customer", header: t("billing.col.customer"), sort: (e) => data.customerName(e.customerId), cell: (e) => html`<span data-user-content>${data.customerName(e.customerId) || "\u2014"}</span>`, csv: (e) => data.customerName(e.customerId) },
    { id: "summary", header: t("billing.col.summary"), cell: (e) => html`<span data-user-content>${e.summary || "\u2014"}</span>`, csv: (e) => e.summary },
  ];
  return html`<div class="stack" data-testid="billing.audit">
    <${Card} title=${t("billing.audit.title")} level=${2} testid="billing.audit.card">
      <p class="muted small">${t("billing.audit.note")}</p>
      <${DataTable} id="billing-audit" columns=${columns} rows=${paged.rows} rowKey=${(e, index) => e.id || index} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.audit.title") })} exportName="billing-audit"
        loading=${!data.settled && !data.loaded}
        source=${{ cursor: paged.cursor, loading: paged.loading, loadMore: paged.loadMore }}
        empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.audit" icon="file-search" testid="billing.audit.empty" />`} />
    <//>
  </div>`;
}
