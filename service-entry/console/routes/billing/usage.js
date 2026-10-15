// /billing/usage, the Usage & ledger tab (07 §6.11, TEL-14): the period's
// aggregates from usage/summary on top, with a drill-down into the raw
// request records below it (a customer or model from the aggregate table
// filters them), then the immutable credit ledger. Raw requests page by the
// server's keyset cursor and the ledger by offset; "load more" appends.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { html } from "../../ui/html.js";
import { useQuery } from "../../ui/hooks.js";
import { useServices } from "../../ui/context.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { fetchUsage, usePaged } from "./data.js";
import { normalizeList, normalizeUsage, usageState } from "../../lib/billing-model.js";
import { UsageSummary } from "./usage-summary.js";
import { Cell, EmptyTable, Section, UsageStatus, useBillingFormat } from "./views.js";

function RawRequests({ data, fmt, filters, setFilters }) {
  const { t } = fmt;
  const { api } = useServices();
  const { customerId, model } = filters;
  // The unfiltered first page is the one the overview already holds (same key).
  const first = useQuery(["billing", "usage", customerId], () => fetchUsage(api, { customerId, tz: data.tz }), { ttlMs: 10_000 });
  const page = useMemo(() => {
    const list = normalizeList(first.data, "usage", normalizeUsage);
    return { items: list.items, next: typeof first.data?.nextCursor === "string" && first.data.nextCursor ? first.data.nextCursor : null, updatedAt: first.updatedAt };
  }, [first.data, first.updatedAt]);
  const paged = usePaged({ first: page, fetchPage: (after) => data.pageUsage(after, customerId), resetKey: customerId });
  const rows = model ? paged.rows.filter((usage) => usage.model === model) : paged.rows;
  const columns = [
    { id: "at", header: t("billing.col.time"), sort: (u) => Date.parse(u.at) || 0, cell: (u) => fmt.dateTime(u.at), csv: (u) => u.at },
    { id: "customer", header: t("billing.col.customer"), sort: (u) => data.customerName(u.customerId), cell: (u) => html`<span data-user-content>${data.customerName(u.customerId) || "—"}</span>`, csv: (u) => data.customerName(u.customerId) },
    { id: "model", header: t("billing.col.managerModel"), sort: (u) => u.model, cell: (u) => html`<span data-user-content>${fmt.manager(u.managerId)}${u.model ? ` · ${u.model}` : ""}</span>`, csv: (u) => `${u.managerId} ${u.model}` },
    { id: "input", header: t("billing.col.inputTokens"), align: "end", sort: (u) => Number(u.inputTokens), cell: (u) => fmt.integer(u.inputTokens), csv: (u) => u.inputTokens },
    { id: "output", header: t("billing.col.outputTokens"), align: "end", sort: (u) => Number(u.outputTokens), cell: (u) => fmt.integer(u.outputTokens), csv: (u) => u.outputTokens },
    { id: "projected", header: t("billing.col.projected"), align: "end", cell: (u) => fmt.credits(u.projected || u.cost), csv: (u) => u.projected || u.cost },
    { id: "charged", header: t("billing.col.charged"), align: "end", cell: (u) => fmt.credits(u.debited || "0"), csv: (u) => u.debited || "0" },
    { id: "status", header: t("billing.col.status"), cell: (u) => html`<${UsageStatus} usage=${u} state=${usageState(u)} />`, csv: (u) => usageState(u).state },
  ];
  const chips = html`${customerId ? html`<${Button} size="sm" onClick=${() => setFilters({ customerId: "", model })} testid="billing.usage.filter-customer">${t("billing.usage.filterCustomer", { name: data.customerName(customerId) })} ×<//>` : null}
    ${model ? html`<${Button} size="sm" onClick=${() => setFilters({ customerId, model: "" })} testid="billing.usage.filter-model">${t("billing.usage.filterModel", { model })} ×<//>` : null}`;
  return html`<${Card} title=${html`<span data-testid="billing.usage.heading">${t("billing.usage.rawTitle")}</span>`} level=${2} testid="billing.usage.card">
    <p class="muted small">${t("billing.usage.rawNote")}</p>
    <${DataTable} id="billing-usage" columns=${columns} rows=${rows} rowKey=${(u) => u.id} responsive="cards" caption=${t("billing.usage.rawTitle")} exportName="billing-usage"
      loading=${first.status === "loading" && !first.data}
      source=${{ cursor: paged.cursor, loading: paged.loading, loadMore: paged.loadMore }}
      filters=${customerId || model ? chips : undefined}
      empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.usage" testid="billing.usage.empty" />`} />
  <//>`;
}

function Ledger({ data, fmt }) {
  const { t } = fmt;
  const paged = usePaged({ first: data.ledger, fetchPage: data.pageLedger, resetKey: "ledger" });
  const columns = [
    { id: "at", header: t("billing.col.time"), sort: (e) => Date.parse(e.at) || 0, cell: (e) => fmt.dateTime(e.at), csv: (e) => e.at },
    { id: "customer", header: t("billing.col.customer"), sort: (e) => data.customerName(e.customerId), cell: (e) => html`<span data-user-content>${data.customerName(e.customerId) || "—"}</span>`, csv: (e) => data.customerName(e.customerId) },
    { id: "type", header: t("billing.col.type"), sort: (e) => e.type, cell: (e) => e.type || "—", csv: (e) => e.type },
    { id: "delta", header: t("billing.col.delta"), align: "end", cell: (e) => fmt.signedCredits(e.delta), csv: (e) => e.delta },
    { id: "after", header: t("billing.col.balanceAfter"), align: "end", cell: (e) => (e.balanceAfter === "" ? "—" : fmt.credits(e.balanceAfter)), csv: (e) => e.balanceAfter },
    { id: "reason", header: t("billing.col.reason"), cell: (e) => html`<span data-user-content>${e.reason || "—"}</span>`, csv: (e) => e.reason },
    { id: "key", header: t("billing.col.idempotency"), cell: (e) => html`<${Cell} primary=${e.idempotencyKey || e.requestId || "—"} code />`, csv: (e) => e.idempotencyKey || e.requestId },
  ];
  return html`<${Card} title=${t("billing.ledger.title")} level=${2} testid="billing.ledger.card">
    <p class="muted small">${t("billing.ledger.note")}</p>
    <${DataTable} id="billing-ledger" columns=${columns} rows=${paged.rows} rowKey=${(e, index) => e.id || index} responsive="cards" caption=${t("billing.ledger.title")} exportName="billing-ledger"
      loading=${!data.settled && !data.loaded}
      source=${{ cursor: paged.cursor, loading: paged.loading, loadMore: paged.loadMore }}
      empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.ledger" testid="billing.ledger.empty" />`} />
  <//>`;
}

export default function UsageTab({ data, section, query = {} }) {
  const fmt = useBillingFormat();
  const [filters, setFilters] = useState({ customerId: String(query.customer || ""), model: String(query.model || "") });
  const drill = (target) => {
    setFilters({ customerId: target.customerId || "", model: target.model || "" });
    globalThis.document?.getElementById("billing-usage-raw")?.scrollIntoView?.({ block: "start" });
  };
  return html`<div class="stack" data-testid="billing.usage">
    <${UsageSummary} data=${data} onDrill=${drill} />
    <${Section} id="billing-usage-raw"><${RawRequests} data=${data} fmt=${fmt} filters=${filters} setFilters=${setFilters} /><//>
    <${Section} id="billing-ledger" active=${section === "ledger"}><${Ledger} data=${data} fmt=${fmt} /><//>
  </div>`;
}
