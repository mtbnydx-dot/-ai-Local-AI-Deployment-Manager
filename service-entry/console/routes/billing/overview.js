// /billing, the Overview tab (07 §6.11): this period's numbers, the customer
// accounts with their filters, the new-customer form, the period's usage as
// aggregates and the most recent raw requests under it.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { StatTile } from "../../components/stat-tile.js";
import { buildQuery } from "../../lib/url.js";
import { useRouter } from "../../ui/shell.js";
import { tk } from "../../lib/i18n.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { customerColumns, useCustomerToggle } from "./customer-parts.js";
import { filterCustomers, MODES, sumDecimals, sumIntegers, usageState, validateCustomer } from "../../lib/billing-model.js";
import { UsageSummary } from "./usage-summary.js";
import { EmptyTable, LazyView, UsageStatus, useBillingFormat } from "./views.js";


function Tiles({ data, fmt }) {
  const { t } = fmt;
  const summary = data.summary;
  const usage = data.usage.items;
  const active = (list) => String(list.filter((item) => item.status === "active" || item.active === true).length);
  const tts = summary.tts;
  const tiles = [
    { id: "customers", value: fmt.integer(summary.activeCustomers || active(data.customers)), window: t("billing.window.now") },
    { id: "credentials", value: fmt.integer(summary.activeCredentials || active(data.credentials)), window: t("billing.window.now") },
    { id: "balance", value: fmt.credits(summary.availableCredits || "0"), window: t("billing.window.now") },
    { id: "tokens", value: fmt.integer(summary.periodTokens || sumIntegers(usage.map((item) => item.totalTokens))), window: t("billing.window.period") },
    { id: "spend", value: fmt.credits(summary.periodSpend || sumDecimals(usage.map((item) => item.debited || item.cost))), window: t("billing.window.period") },
    {
      id: "tts",
      value: tts ? t("billing.tile.ttsValue", { seconds: Math.round(tts.audioSeconds), requests: tts.requests, charged: fmt.credits(tts.charged) }) : "—",
      window: t("billing.window.period"),
    },
  ];
  return html`<div class="billing-tiles" role="group" aria-label=${t("billing.tiles.label")} data-testid="billing.tiles">
    ${tiles.map((tile) => html`<${StatTile} key=${tile.id} label=${t(tk("billing.tile.", tile.id))} value=${tile.value} window=${tile.window} testid=${`billing.tile.${tile.id}`} />`)}
  </div>`;
}

function CustomerFilters({ filters, set, data, fmt }) {
  const { t } = fmt;
  return html`
    <input class="input keys-search" type="search" maxlength="80" value=${filters.query} placeholder=${t("billing.filter.customers")} aria-label=${t("billing.filter.customersLabel")}
      onInput=${(event) => set({ query: event.currentTarget.value })} data-testid="billing.filter.query" />
    <select class="select keys-filter" aria-label=${t("billing.filter.plan")} value=${filters.planId} onChange=${(event) => set({ planId: event.currentTarget.value })} data-testid="billing.filter.plan">
      <option value="">${t("billing.filter.allPlans")}</option>
      ${data.plans.map((plan) => html`<option key=${plan.id} value=${plan.id}>${plan.name}</option>`)}
    </select>
    <select class="select keys-filter" aria-label=${t("billing.filter.mode")} value=${filters.mode} onChange=${(event) => set({ mode: event.currentTarget.value })} data-testid="billing.filter.mode">
      <option value="">${t("billing.filter.allModes")}</option>
      ${MODES.map((mode) => html`<option key=${mode} value=${mode}>${fmt.mode(mode)}</option>`)}
    </select>
    <select class="select keys-filter" aria-label=${t("billing.filter.status")} value=${filters.status} onChange=${(event) => set({ status: event.currentTarget.value })} data-testid="billing.filter.status">
      <option value="">${t("billing.filter.allStatuses")}</option>
      ${["active", "suspended", "closed"].map((status) => html`<option key=${status} value=${status}>${t(tk("billing.customerStatus.", status))}</option>`)}
    </select>
    <${Button} size="sm" onClick=${() => set({ query: "", planId: "", mode: "", status: "" })} testid="billing.filter.reset">${t("billing.filter.reset")}<//>`;
}

function QuickActions({ fmt }) {
  const { t } = fmt;
  const links = [
    ["bind", "/billing/credentials"],
    ["adjust", "/billing/customers#billing-adjustment"],
    ["prices", "/billing/prices"],
    ["audit", "/billing/audit"],
  ];
  return html`<${Card} title=${t("billing.quick.title")} level=${3} testid="billing.quick">
    <p class="muted small">${t("billing.quick.note")}</p>
    <ul class="stack-sm billing-quick">
      ${links.map(([id, href]) => html`<li key=${id}><a href=${href} data-testid=${`billing.quick.${id}`}>${t(tk("billing.quick.", id))}</a></li>`)}
    </ul>
  <//>`;
}

function RecentRequests({ data, fmt }) {
  const { t } = fmt;
  const rows = data.usage.items.slice(0, 100);
  const columns = [
    { id: "at", header: t("billing.col.time"), sort: (u) => Date.parse(u.at) || 0, cell: (u) => fmt.dateTime(u.at), csv: (u) => u.at },
    { id: "customer", header: t("billing.col.customer"), sort: (u) => data.customerName(u.customerId), cell: (u) => html`<span data-user-content>${data.customerName(u.customerId) || "—"}</span>`, csv: (u) => data.customerName(u.customerId) },
    { id: "manager", header: t("billing.col.manager"), cell: (u) => fmt.manager(u.managerId), csv: (u) => u.managerId },
    { id: "model", header: t("billing.col.model"), sort: (u) => u.model, cell: (u) => html`<span data-user-content>${u.model || "—"}</span>`, csv: (u) => u.model },
    { id: "tokens", header: t("billing.col.tokens"), align: "end", sort: (u) => Number(u.totalTokens), cell: (u) => fmt.integer(u.totalTokens), csv: (u) => u.totalTokens },
    { id: "status", header: t("billing.col.status"), cell: (u) => html`<${UsageStatus} usage=${u} state=${usageState(u)} />`, csv: (u) => usageState(u).state },
  ];
  return html`<${Card} title=${html`<span data-testid="billing.recent.heading">${t("billing.recent.title")}</span>`} level=${2} testid="billing.recent"
    actions=${html`<${Button} size="sm" href="/billing/usage" testid="billing.recent.ledger">${t("billing.recent.viewLedger")}<//>`}>
    <p class="muted small">${t("billing.recent.note")}</p>
    <${DataTable} id="billing-recent" columns=${columns} rows=${rows} rowKey=${(u) => u.id} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.recent.title") })} exportName="billing-recent-requests"
      loading=${!data.settled && !data.loaded}
      empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.recent" testid="billing.recent.empty" />`} />
  <//>`;
}

export default function OverviewTab({ data, defaults }) {
  const fmt = useBillingFormat();
  const { t } = fmt;
  const router = useRouter();
  const toggle = useCustomerToggle();
  const [filters, setFilters] = useState({ query: "", planId: "", mode: "", status: "" });
  const rows = useMemo(() => filterCustomers(data.customers, filters).slice(0, 100), [data.customers, filters]);
  const columns = customerColumns({ data, fmt, ask: toggle.ask });
  const drill = (target) => router.navigate(`/billing/usage${buildQuery({ customer: target.customerId, model: target.model })}`);
  return html`<div class="stack" data-testid="billing.overview">
    <${Tiles} data=${data} fmt=${fmt} />
    <div class="billing-grid">
      <${Card} title=${t("billing.customers.title")} level=${2} testid="billing.overview.customers"
        actions=${html`<${Button} size="sm" href="/billing/customers" testid="billing.customers.viewAll">${t("billing.customers.viewAll")}<//>`}>
        <p class="muted small">${t("billing.customers.note")}</p>
        <${DataTable} id="billing-overview-customers" columns=${columns} rows=${rows} rowKey=${(c) => c.id} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.customers.title") })} exportName="billing-customers"
          loading=${!data.settled && !data.loaded}
          filters=${html`<${CustomerFilters} filters=${filters} set=${(patch) => setFilters((current) => ({ ...current, ...patch }))} data=${data} fmt=${fmt} />`}
          empty=${html`<${EmptyTable} data=${data} titleKey=${data.customers.length ? "billing.empty.customersMatch" : "billing.empty.customers"} icon="boxes" testid="billing.customers.empty" />`} />
      <//>
      <div class="stack">
        <${LazyView} load=${() => import("./customer-forms.js")} name="NewCustomer" data=${data} fmt=${fmt} defaults=${defaults} />
        <${QuickActions} fmt=${fmt} />
      </div>
    </div>
    <${UsageSummary} data=${data} onDrill=${drill} />
    <${RecentRequests} data=${data} fmt=${fmt} />
    ${toggle.dialog}
  </div>`;
}
