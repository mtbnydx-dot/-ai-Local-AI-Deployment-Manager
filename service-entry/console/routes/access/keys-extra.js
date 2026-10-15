// The Customers and Audit tabs of /access/keys (07 §6.10, 05 §13.4). They
// load only when their tab opens, so the key table's route module stays small.
//
// Customers are the billing customers (GET /api/billing/customers): each row
// links to the customer's keys and starts a Paid-preset key for them. Audit is
// the append-only access audit (GET /api/access/audit) with action and target
// filters and cursor paging.

import { Button } from "../../components/button.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useState } from "../../ui/vendor.js";
import { fetchCustomers } from "./queries.js";

const AUDIT_PAGE = 100;
const DETAIL_CHARS = 140;

const CUSTOMER_TONE = { active: "ok", suspended: "warn", closed: "neutral" };

/** @param onCreateFor(customerId) opens the create drawer on the Paid preset  @param onShowKeys(customerId) filters the key table */
export function CustomersTab({ onCreateFor, onShowKeys }) {
  const { api } = useServices();
  const { t, has } = useT();
  const fmt = useFormat();
  const customers = useQuery(["billing", "customers"], () => fetchCustomers(api), { ttlMs: 30_000 });
  const state = customers.data;
  const columns = [
    { id: "name", header: t("access.customers.name"), sort: (row) => row.name, cell: (row) => html`<span data-user-content>${row.name}</span>` },
    { id: "ref", header: t("access.customers.ref"), hideable: true, sort: (row) => row.externalRef, cell: (row) => html`<span class="mono small" data-user-content>${row.externalRef || "—"}</span>` },
    {
      id: "status",
      header: t("access.customers.status"),
      sort: (row) => row.status,
      cell: (row) => html`<${StatusBadge} status=${CUSTOMER_TONE[row.status] || "neutral"} label=${has(tk("access.customers.state.", row.status)) ? t(tk("access.customers.state.", row.status)) : row.status || "—"} />`,
    },
    { id: "plan", header: t("access.customers.plan"), hideable: true, cell: (row) => html`<span class="mono small" data-user-content>${row.planId || "—"}</span>` },
    {
      id: "balance",
      header: t("access.customers.balance"),
      align: "end",
      sort: (row) => Number(row.balance),
      cell: (row) => (row.balance === null || row.balance === undefined ? "—" : html`<span class="tabular">${fmt.number(Number(row.balance) / 1_000_000, 2)}</span>`),
    },
    {
      id: "actions",
      header: t("access.table.actions"),
      csv: false,
      cell: (row) => html`<div class="row-nowrap">
        <${Button} size="sm" onClick=${() => onShowKeys?.(row.id)} testid="customers.keys" label=${t("access.customers.keysFor", { name: row.name })}>${t("access.customers.keys")}<//>
        <${Button} size="sm" onClick=${() => onCreateFor?.(row.id)} testid="customers.new-key" label=${t("access.customers.newKeyFor", { name: row.name })}>${t("access.customers.newKey")}<//>
      </div>`,
    },
  ];
  if (state && !state.ok) {
    return html`<${EmptyState} icon="triangle-alert" title=${t("access.customers.unavailable")} body=${t("access.customers.unavailableBody")} action=${{ label: t("access.customers.openBilling"), href: "/billing" }} />`;
  }
  return html`<div class="stack" data-testid="customers.panel">
    <p class="muted small">${t("access.customers.hint")}</p>
    <${DataTable} id="access-customers" columns=${columns} rows=${state?.rows || []} rowKey=${(row) => row.id} loading=${!state} responsive="cards" exportName="customers" caption=${t("access.customers.caption")}
      empty=${html`<${EmptyState} icon="key-round" title=${t("access.customers.empty")} body=${t("access.customers.emptyBody")} action=${{ label: t("access.customers.openBilling"), href: "/billing" }} />`} />
  </div>`;
}

function detailText(details) {
  if (!details || typeof details !== "object" || !Object.keys(details).length) return "";
  const text = Object.entries(details).map(([name, value]) => `${name}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" ");
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

export function AuditTab() {
  const { api } = useServices();
  const { t, has } = useT();
  const fmt = useFormat();
  const [filters, setFilters] = useState({ action: "", target: "" });
  const [extra, setExtra] = useState({ items: [], cursor: null, loading: false });
  const action = useDebounced(filters.action.trim(), 250);
  const target = useDebounced(filters.target.trim(), 250);
  const query = { limit: AUDIT_PAGE, ...(action ? { action } : {}), ...(target ? { target } : {}) };
  const first = useQuery(["access", "audit", query], () => api.get("/api/access/audit", { query }), { ttlMs: 5000, keepPrevious: true });
  useEffect(() => setExtra({ items: [], cursor: null, loading: false }), [first.updatedAt]);
  const rows = useMemo(() => [...(first.data?.items || []), ...extra.items], [first.data, extra.items]);
  const cursor = extra.items.length || extra.cursor ? extra.cursor : first.data?.nextCursor || null;

  async function loadMore(after) {
    setExtra((current) => ({ ...current, loading: true }));
    try {
      const page = await api.get("/api/access/audit", { query: { ...query, cursor: after } });
      setExtra((current) => ({ items: [...current.items, ...(page.items || [])], cursor: page.nextCursor || null, loading: false }));
    } catch {
      setExtra((current) => ({ ...current, loading: false }));
    }
  }

  const columns = [
    { id: "at", header: t("access.audit.at"), sort: (row) => Date.parse(row.at), cell: (row) => html`<span title=${row.at}>${fmt.dateTime(row.at, { style: "short" })}</span>`, csv: (row) => row.at },
    { id: "actor", header: t("access.audit.actor"), sort: (row) => row.actor, cell: (row) => html`<span class="mono small" data-user-content>${row.actor}${row.actorIp ? ` · ${row.actorIp}` : ""}</span>`, csv: (row) => row.actor },
    { id: "action", header: t("access.audit.action"), sort: (row) => row.action, cell: (row) => (has(tk("access.audit.action.", row.action)) ? t(tk("access.audit.action.", row.action)) : html`<span class="mono small">${row.action}</span>`), csv: (row) => row.action },
    { id: "target", header: t("access.audit.target"), cell: (row) => html`<span class="mono small" data-user-content>${row.targetType}${row.targetId ? ` ${row.targetId}` : ""}</span>`, csv: (row) => `${row.targetType} ${row.targetId || ""}` },
    { id: "details", header: t("access.audit.details"), hideable: true, cell: (row) => html`<span class="mono xsmall muted" data-user-content>${detailText(row.details)}</span>`, csv: (row) => detailText(row.details) },
  ];
  if (first.status === "error" && !first.data) {
    return html`<${EmptyState} icon="triangle-alert" title=${t("access.audit.failed")} body=${first.error?.message || ""} action=${{ label: t("access.retry"), onClick: first.refetch }} />`;
  }
  return html`<div class="stack" data-testid="audit.panel">
    <p class="muted small">${t("access.audit.hint")}</p>
    <${DataTable} id="access-audit" columns=${columns} rows=${rows} rowKey=${(row) => row.id} loading=${first.status === "loading" && !first.data} source=${{ cursor, loading: extra.loading, loadMore }}
      responsive="cards" exportName="access-audit" caption=${t("access.audit.caption")}
      filters=${html`<div class="row" role="search">
        <input class="input keys-search" value=${filters.action} placeholder=${t("access.audit.filterAction")} aria-label=${t("access.audit.filterAction")} onInput=${(event) => setFilters({ ...filters, action: event.currentTarget.value })} data-testid="audit.filter-action" />
        <input class="input keys-search" value=${filters.target} placeholder=${t("access.audit.filterTarget")} aria-label=${t("access.audit.filterTarget")} onInput=${(event) => setFilters({ ...filters, target: event.currentTarget.value })} data-testid="audit.filter-target" />
      </div>`}
      empty=${html`<p class="muted" data-testid="audit.empty">${t("access.audit.empty")}</p>`} />
  </div>`;
}
