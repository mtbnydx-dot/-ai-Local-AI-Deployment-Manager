// /billing/customers, the Customers & credentials tab (07 §6.11): the account
// table, the credential bindings and the three write forms (account policy,
// credential binding, manual credit adjustment), which load on demand from
// customer-forms.js. The policy form's state lives here so that the table's
// Policy button can fill it before the forms have loaded.

import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { html } from "../../ui/html.js";
import { useEffect } from "../../ui/vendor.js";
import { customerColumns, useCustomerToggle } from "./customer-parts.js";
import { useForm } from "./forms.js";
import { ActiveStatus, Cell, EmptyTable, LazyView, Section, useBillingFormat } from "./views.js";

const POLICY = { customerId: "", planId: "", enforcementMode: "shadow", creditLimit: "0", monthlyTokenLimit: "0", monthlyRequestLimit: "0" };
const loadForms = () => import("./customer-forms.js");

function CredentialsTable({ data, fmt }) {
  const { t } = fmt;
  const columns = [
    { id: "customer", header: t("billing.col.customer"), sort: (c) => data.customerName(c.customerId), cell: (c) => html`<span data-user-content>${data.customerName(c.customerId)}</span>`, csv: (c) => data.customerName(c.customerId) },
    { id: "manager", header: t("billing.col.manager"), sort: (c) => c.managerId, cell: (c) => fmt.manager(c.managerId), csv: (c) => c.managerId },
    {
      id: "client",
      header: t("billing.col.serviceClient"),
      sort: (c) => c.label || c.serviceClientId,
      cell: (c) => html`<${Cell} primary=${c.label || c.serviceClientId} detail=${c.serviceClientId + (c.keyPreview ? ` · ${c.keyPreview}` : "")} />`,
      csv: (c) => c.serviceClientId,
    },
    { id: "status", header: t("billing.col.status"), sort: (c) => c.active, cell: (c) => html`<${ActiveStatus} active=${c.active} />`, csv: (c) => (c.active ? "active" : "inactive") },
    { id: "updated", header: t("billing.col.updated"), sort: (c) => Date.parse(c.updatedAt) || 0, cell: (c) => fmt.dateTime(c.updatedAt), csv: (c) => c.updatedAt },
  ];
  return html`<${DataTable} id="billing-credentials" columns=${columns} rows=${data.credentials} rowKey=${(c) => c.id} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.credentials.title") })} exportName="billing-credentials"
    loading=${!data.settled && !data.loaded}
    empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.credentials" icon="key-round" testid="billing.credentials.empty" />`} />`;
}

export default function CustomersTab({ data, section, query = {}, defaultManager }) {
  const fmt = useBillingFormat();
  const { t } = fmt;
  const toggle = useCustomerToggle();
  const policy = useForm(POLICY);
  const edit = (customer) => {
    policy.patch({
      customerId: customer.id,
      planId: customer.planId,
      enforcementMode: customer.enforcementMode,
      creditLimit: customer.creditLimit,
      monthlyTokenLimit: customer.monthlyTokenLimit,
      monthlyRequestLimit: customer.monthlyRequestLimit,
    });
    globalThis.document?.getElementById("billing-policy")?.scrollIntoView?.({ block: "center" });
    globalThis.document?.querySelector('[data-testid="billing-policy-form.customerId"]')?.focus?.();
  };
  const wanted = query.edit;
  useEffect(() => {
    const customer = wanted ? data.customers.find((item) => item.id === wanted) : null;
    if (customer && policy.values.customerId !== customer.id) edit(customer);
  }, [wanted, data.customers.length]);
  const columns = customerColumns({ data, fmt, ask: toggle.ask, wide: true, onEdit: edit });
  return html`<div class="stack" data-testid="billing.customers">
    <${Card} title=${t("billing.manage.title")} level=${2} testid="billing.customers.card">
      <p class="muted small">${t("billing.manage.note")}</p>
      <${DataTable} id="billing-customers" columns=${columns} rows=${data.customers} rowKey=${(c) => c.id} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.manage.title") })} exportName="billing-customers"
        loading=${!data.settled && !data.loaded}
        empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.customers" icon="boxes" testid="billing.customers.empty" />`} />
    <//>
    <${Section} id="billing-credentials-section" active=${section === "credentials"}>
      <${Card} title=${t("billing.credentials.title")} level=${2} testid="billing.credentials.card">
        <p class="muted small">${t("billing.credentials.note")}</p>
        <${CredentialsTable} data=${data} fmt=${fmt} />
      <//>
    <//>
    <div class="billing-grid">
      <div class="stack">
        <${Section} id="billing-policy"><${LazyView} load=${loadForms} name="PolicyForm" data=${data} fmt=${fmt} form=${policy} /><//>
        <${LazyView} load=${loadForms} name="CredentialForm" data=${data} fmt=${fmt} defaultManager=${defaultManager} />
      </div>
      <${Section} id="billing-adjustment" active=${section === "adjustment"}><${LazyView} load=${loadForms} name="AdjustmentForm" data=${data} fmt=${fmt} /><//>
    </div>
    ${toggle.dialog}
  </div>`;
}
