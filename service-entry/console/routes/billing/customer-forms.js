// The write forms of the customers: a new customer (overview), the account
// policy, the credential binding and the manual credit adjustment (customers
// tab) (07 §6.11). Each validates through the billing model first, so what
// reaches the API is the canonical payload. An adjustment goes into the
// immutable ledger, so it is confirmed in a dialog that says so; a debit also
// needs its amount typed back (type-to-confirm). Loaded on demand by the tabs
// that show them (07 §11).

import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { availableClients, createIdempotencyKey, MANAGER_IDS, MODES, validateAdjustment, validateCredential, validateCustomer, validatePolicy } from "../../lib/billing-model.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useState } from "../../ui/vendor.js";
import { Field, FormCard, optionList, useForm, useSubmit } from "./forms.js";

const NEW_CUSTOMER = { name: "", externalRef: "", planId: "", enforcementMode: "shadow", creditLimit: "0", monthlyTokenLimit: "0", monthlyRequestLimit: "0" };

export function NewCustomer({ data, fmt, defaults }) {
  const { t } = fmt;
  const form = useForm({ ...NEW_CUSTOMER, ...defaults });
  const submit = useSubmit(form);
  const plans = data.plans.filter((plan) => plan.active);
  return html`<${FormCard} id="billing-customer-form" form=${form} title=${t("billing.newCustomer.title")} note=${t("billing.newCustomer.note")} submit=${t("billing.customer.create")}
    onSubmit=${() => submit({
      validate: () => validateCustomer(form.values, { plans: data.plans }),
      send: (body, api) => api.post("/api/billing/customers", body),
      doneKey: "billing.customer.created",
      reset: true,
    })}>
    <${Field} form=${form} id="billing-customer-form" name="name" label=${t("billing.field.customerName")} required maxLength=${80} placeholder=${t("billing.field.customerNameExample")} />
    <${Field} form=${form} id="billing-customer-form" name="externalRef" label=${t("billing.field.externalRef")} maxLength=${80} placeholder="CRM-1001" />
    <${Field} form=${form} id="billing-customer-form" name="planId" label=${t("billing.field.plan")} kind="select" options=${optionList(t("billing.field.planNone"), plans, (plan) => plan.id, (plan) => `${plan.name} · ${plan.code}`)} />
    <${Field} form=${form} id="billing-customer-form" name="enforcementMode" label=${t("billing.field.mode")} kind="select"
      options=${MODES.map((mode) => ({ value: mode, label: t(tk("billing.modeLong.", mode)) }))} />
    <${Field} form=${form} id="billing-customer-form" name="creditLimit" label=${t("billing.field.creditLimit")} inputMode="decimal" maxLength=${26} />
    <${Field} form=${form} id="billing-customer-form" name="monthlyTokenLimit" label=${t("billing.field.monthlyTokens")} inputMode="numeric" maxLength=${24} />
    <${Field} form=${form} id="billing-customer-form" name="monthlyRequestLimit" label=${t("billing.field.monthlyRequests")} inputMode="numeric" maxLength=${24} />
    <p class="muted small">${t("billing.field.creditsHelp")}</p>
  <//>`;
}

export function PolicyForm({ data, fmt, form }) {
  const { t } = fmt;
  const submit = useSubmit(form);
  const plans = data.plans.filter((plan) => plan.active);
  return html`<${FormCard} id="billing-policy-form" form=${form} title=${t("billing.policy.title")} submit=${t("billing.policy.save")}
    onSubmit=${() => submit({
      validate: () => validatePolicy(form.values, { customers: data.customers, plans: data.plans }),
      send: ({ customerId, body }, api) => api.patch(`/api/billing/customers/${encodeURIComponent(customerId)}/policy`, body),
      doneKey: "billing.policy.saved",
    })}>
    <${Field} form=${form} id="billing-policy-form" name="customerId" label=${t("billing.field.customer")} required kind="select"
      options=${optionList(t("billing.field.customerSelect"), data.customers, (c) => c.id, (c) => `${c.name} · ${c.id}`)} />
    <${Field} form=${form} id="billing-policy-form" name="planId" label=${t("billing.field.plan")} kind="select" options=${optionList(t("billing.field.planUnbound"), plans, (p) => p.id, (p) => `${p.name} · ${p.code}`)} />
    <${Field} form=${form} id="billing-policy-form" name="enforcementMode" label=${t("billing.field.mode")} kind="select" options=${MODES.map((mode) => ({ value: mode, label: fmt.mode(mode) }))} />
    <${Field} form=${form} id="billing-policy-form" name="creditLimit" label=${t("billing.field.creditLimit")} inputMode="decimal" maxLength=${26} />
    <${Field} form=${form} id="billing-policy-form" name="monthlyTokenLimit" label=${t("billing.field.monthlyTokens")} inputMode="numeric" maxLength=${24} />
    <${Field} form=${form} id="billing-policy-form" name="monthlyRequestLimit" label=${t("billing.field.monthlyRequests")} inputMode="numeric" maxLength=${24} />
  <//>`;
}

function clientLabel(client, t) {
  const name = client.global ? t("billing.client.global") : client.name;
  return `${name} · ${client.id}${client.keyPreview ? ` · ${client.keyPreview}` : ""}${client.enabled ? "" : ` · ${t("billing.client.disabled")}`}`;
}

export function CredentialForm({ data, fmt, defaultManager }) {
  const { t } = fmt;
  const form = useForm({ customerId: "", managerId: defaultManager, serviceClientId: "" });
  const submit = useSubmit(form);
  const clients = useMemo(() => availableClients(data.managers, form.values.managerId), [data.managers, form.values.managerId]);
  const chosen = form.values.serviceClientId;
  useEffect(() => {
    if (chosen && !clients.some((client) => client.id === chosen)) form.set("serviceClientId", "");
  }, [clients, chosen]);
  const placeholder = clients.length ? t("billing.credential.choose") : t("billing.credential.noClients");
  return html`<${FormCard} id="billing-credential-form" form=${form} title=${t("billing.credential.title")} submit=${t("billing.credential.save")}
    onSubmit=${() => submit({
      validate: () => validateCredential(form.values, { customers: data.customers, managers: data.managers }),
      send: (body, api) => api.post("/api/billing/credentials", body),
      doneKey: "billing.credential.saved",
      reset: true,
    })}>
    <${Field} form=${form} id="billing-credential-form" name="customerId" label=${t("billing.field.customer")} required kind="select"
      options=${optionList(t("billing.field.customerSelect"), data.customers, (c) => c.id, (c) => `${c.name} · ${c.id}`)} />
    <${Field} form=${form} id="billing-credential-form" name="managerId" label=${t("billing.field.manager")} required kind="select"
      options=${MANAGER_IDS.map((id) => ({ value: id, label: fmt.manager(id) }))} />
    <${Field} form=${form} id="billing-credential-form" name="serviceClientId" label=${t("billing.field.serviceClient")} required kind="select"
      locked=${clients.length ? undefined : { reason: t("billing.credential.noClientsHelp") }}
      hint=${clients.length ? t("billing.credential.help", { count: clients.length }) : undefined}
      options=${[{ value: "", label: placeholder }, ...clients.map((client) => ({ value: client.id, label: clientLabel(client, t), disabled: !client.enabled }))]} />
  <//>`;
}

export function AdjustmentForm({ data, fmt }) {
  const { t } = fmt;
  const { api, cache, toasts, i18n } = useServices();
  const form = useForm({ customerId: "", amountCredits: "", reason: "" });
  const [pending, setPending] = useState(null);
  const customer = pending ? data.customers.find((item) => item.id === pending.customerId) : null;
  const debit = Boolean(pending?.amountCredits.startsWith("-"));
  const check = (event) => {
    const checked = validateAdjustment(form.values, { customers: data.customers });
    form.setErrors(checked.ok ? {} : checked.errors);
    // One key per attempt: a retry after a failed send repeats the same entry, never a second one.
    if (checked.ok) setPending({ ...checked.value, idempotencyKey: createIdempotencyKey() });
  };
  return html`
    <${FormCard} id="billing-adjustment-form" form=${form} title=${t("billing.adjust.title")} submit=${t("billing.adjust.submit")} onSubmit=${check}>
      <${Field} form=${form} id="billing-adjustment-form" name="customerId" label=${t("billing.field.customer")} required kind="select"
        options=${optionList(t("billing.field.customerSelect"), data.customers, (c) => c.id, (c) => `${c.name} · ${c.id}`)} />
      <${Field} form=${form} id="billing-adjustment-form" name="amountCredits" label=${t("billing.adjust.amount")} required inputMode="decimal" maxLength=${27} placeholder=${t("billing.adjust.amountExample")} />
      <${Field} form=${form} id="billing-adjustment-form" name="reason" label=${t("billing.adjust.reason")} required kind="textarea" maxLength=${500} placeholder=${t("billing.adjust.reasonExample")} />
      <p class="muted small">${t("billing.adjust.help")}</p>
    <//>
    ${pending ? html`<${ConfirmDialog} open tone=${debit ? "danger" : "default"} testid="billing.adjust.dialog"
      title=${debit ? t("billing.adjust.debitTitle") : t("billing.adjust.creditTitle")}
      body=${debit ? t("billing.adjust.debitBody") : t("billing.adjust.creditBody")}
      details=${[
        t("billing.adjust.detailCustomer", { name: customer?.name || pending.customerId, id: pending.customerId }),
        t("billing.adjust.detailAmount", { amount: pending.amountCredits }),
        t("billing.adjust.detailReason", { reason: pending.reason }),
      ]}
      confirmLabel=${t("billing.adjust.confirm")} typeToConfirm=${debit ? pending.amountCredits : undefined}
      onConfirm=${async () => {
        await api.post("/api/billing/ledger/adjustments", pending);
        cache.invalidate(["billing"]);
        toasts?.push?.({ level: "success", title: i18n.t("billing.adjust.done") });
        form.reset();
      }}
      onClose=${() => setPending(null)} />` : null}`;
}
