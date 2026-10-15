// Pieces of the billing page that the overview and the customers tab share
// (07 §6.11): the customer table's columns, its status toggle with the
// confirmation every state change goes through, and the filter bar.

import { Button } from "../../components/button.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useServices } from "../../ui/context.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { Cell, CustomerStatus, useBillingFormat } from "./views.js";

/** The suspend / restore flow: `ask(customer)` opens the confirmation, `dialog` is its node (null while closed). */
export function useCustomerToggle() {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const [target, setTarget] = useState(null);
  const next = target?.status === "active" ? "suspended" : "active";
  const dialog = target
    ? html`<${ConfirmDialog} open tone=${next === "suspended" ? "danger" : "default"}
        title=${t(next === "active" ? "billing.toggle.restoreTitle" : "billing.toggle.suspendTitle", { name: target.name })}
        body=${t("billing.toggle.body")} confirmLabel=${t(next === "active" ? "billing.action.restore" : "billing.action.suspend")} testid="billing.toggle.dialog"
        onConfirm=${async () => {
          await api.patch(`/api/billing/customers/${encodeURIComponent(target.id)}`, { status: next });
          cache.invalidate(["billing"]);
          toasts?.push?.({ level: "success", title: t("billing.toggle.done") });
        }}
        onClose=${() => setTarget(null)} />`
    : null;
  return { ask: setTarget, dialog };
}

/**
 * Columns for the customer tables. `wide` adds the external reference, credit
 * limit and quota columns of the customers tab; the overview keeps the short form.
 */
export function customerColumns({ data, fmt, ask, wide = false, onEdit }) {
  const { t } = fmt;
  const actions = {
    id: "actions",
    header: t("billing.col.actions"),
    csv: false,
    cell: (customer) => html`<div class="row-nowrap">
      ${onEdit
        ? html`<${Button} size="sm" onClick=${() => onEdit(customer)} label=${t("billing.action.policyFor", { name: customer.name })} testid="billing.customer.edit">${t("billing.action.policy")}<//>`
        : html`<${Button} size="sm" href=${`/billing/customers?edit=${encodeURIComponent(customer.id)}`} label=${t("billing.action.policyFor", { name: customer.name })} testid="billing.customer.edit">${t("billing.action.policy")}<//>`}
      <${Button} size="sm" onClick=${() => ask(customer)} label=${t(customer.status === "active" ? "billing.action.suspendFor" : "billing.action.restoreFor", { name: customer.name })} testid="billing.customer.toggle">${t(customer.status === "active" ? "billing.action.suspend" : "billing.action.restore")}<//>
    </div>`,
  };
  const name = { id: "name", header: wide ? t("billing.col.customer") : t("billing.col.name"), sort: (c) => c.name, cell: (c) => html`<${Cell} primary=${c.name} detail=${wide ? c.id : c.externalRef || c.id} />`, csv: (c) => c.name };
  const plan = { id: "plan", header: t("billing.col.plan"), sort: (c) => data.planName(c.planId), cell: (c) => data.planName(c.planId) || t("billing.plan.none"), csv: (c) => data.planName(c.planId) };
  const mode = { id: "mode", header: t("billing.col.mode"), sort: (c) => c.enforcementMode, cell: (c) => fmt.mode(c.enforcementMode), csv: (c) => c.enforcementMode };
  const status = { id: "status", header: t("billing.col.status"), sort: (c) => c.status, cell: (c) => html`<${CustomerStatus} status=${c.status} />`, csv: (c) => c.status };
  if (!wide) {
    return [
      name,
      plan,
      mode,
      { id: "balance", header: t("billing.col.balanceCredits"), align: "end", sort: (c) => Number(c.available || c.balance), cell: (c) => fmt.credits(c.available || c.balance), csv: (c) => c.available || c.balance },
      { id: "monthTokens", header: t("billing.col.monthTokens"), align: "end", sort: (c) => Number(c.monthTokens), cell: (c) => `${fmt.integer(c.monthTokens)} ${t("billing.unit.tokens")}`, csv: (c) => c.monthTokens },
      status,
      actions,
    ];
  }
  return [
    name,
    { id: "externalRef", header: t("billing.col.externalRef"), sort: (c) => c.externalRef, cell: (c) => c.externalRef || "—", csv: (c) => c.externalRef },
    plan,
    mode,
    { id: "balance", header: t("billing.col.balanceAvailable"), align: "end", sort: (c) => Number(c.balance), cell: (c) => `${fmt.credits(c.balance)} / ${fmt.credits(c.available)}`, csv: (c) => `${c.balance} / ${c.available}` },
    { id: "creditLimit", header: t("billing.col.creditLimit"), align: "end", sort: (c) => Number(c.creditLimit), cell: (c) => fmt.credits(c.creditLimit), csv: (c) => c.creditLimit },
    { id: "limits", header: t("billing.col.limits"), cell: (c) => `${fmt.quota(c.monthlyTokenLimit, "tokens")} · ${fmt.quota(c.monthlyRequestLimit, "requests")}`, csv: (c) => `${c.monthlyTokenLimit} / ${c.monthlyRequestLimit}` },
    status,
    actions,
  ];
}
