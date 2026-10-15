// /billing/prices, the Plans & prices tab (07 §6.11): the official price
// template catalog with its preview-then-apply flow (templates.js, loaded on
// demand), the price rules in force, the plans, and the plan and manual price
// forms. Rates are integer microcredits per million tokens; the page never
// computes or corrects a price, it shows what the server returns.

import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { tk } from "../../lib/i18n.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { Field, FormCard, optionList, useForm, useSubmit } from "./forms.js";
import { filterPrices, MANAGER_IDS, MODES, validatePlan, validatePrice } from "../../lib/billing-model.js";
import { ActiveStatus, Cell, EmptyTable, LazyView, Section, useBillingFormat } from "./views.js";

const NEW_PLAN = { code: "", name: "", currency: "USD", enforcementMode: "shadow", monthlyPrice: "0", includedCredits: "0", monthlyTokenLimit: "0", monthlyRequestLimit: "0" };

function PriceFilters({ filters, set, providers, data, fmt }) {
  const { t } = fmt;
  return html`
    <select class="select keys-filter" aria-label=${t("billing.filter.provider")} value=${filters.provider} onChange=${(event) => set({ provider: event.currentTarget.value })} data-testid="billing.filter.provider">
      <option value="">${t("billing.filter.allSources")}</option>
      ${providers.map((provider) => html`<option key=${provider} value=${provider}>${provider}</option>`)}
    </select>
    <select class="select keys-filter" aria-label=${t("billing.filter.manager")} value=${filters.managerId} onChange=${(event) => set({ managerId: event.currentTarget.value })} data-testid="billing.filter.manager">
      <option value="">${t("billing.filter.allManagers")}</option>
      ${MANAGER_IDS.map((id) => html`<option key=${id} value=${id}>${fmt.manager(id)}</option>`)}
    </select>
    <select class="select keys-filter" aria-label=${t("billing.filter.plan")} value=${filters.planId} onChange=${(event) => set({ planId: event.currentTarget.value })} data-testid="billing.filter.price-plan">
      <option value="">${t("billing.filter.allPlans")}</option>
      ${data.plans.map((plan) => html`<option key=${plan.id} value=${plan.id}>${plan.name}</option>`)}
    </select>
    <input class="input keys-search" type="search" maxlength="160" value=${filters.query} placeholder=${t("billing.filter.models")} aria-label=${t("billing.filter.modelsLabel")}
      onInput=${(event) => set({ query: event.currentTarget.value })} data-testid="billing.filter.model" />`;
}

function PriceRules({ data, fmt }) {
  const { t } = fmt;
  const [filters, setFilters] = useState({ provider: "", managerId: "", planId: "", query: "" });
  const providers = useMemo(() => [...new Set(data.prices.map((price) => price.templateProvider).filter(Boolean))].sort(), [data.prices]);
  const rows = useMemo(() => filterPrices(data.prices, filters), [data.prices, filters]);
  const columns = [
    { id: "manager", header: t("billing.col.manager"), sort: (p) => p.managerId, cell: (p) => fmt.manager(p.managerId), csv: (p) => p.managerId },
    { id: "model", header: t("billing.col.localModel"), sort: (p) => p.modelPattern, cell: (p) => html`<${Cell} primary=${p.modelPattern} code />`, csv: (p) => p.modelPattern },
    { id: "plan", header: t("billing.col.plan"), sort: (p) => data.planName(p.planId), cell: (p) => data.planName(p.planId) || t("billing.plan.none"), csv: (p) => data.planName(p.planId) },
    { id: "input", header: t("billing.col.input"), align: "end", cell: (p) => fmt.integer(p.input), csv: (p) => p.input },
    { id: "cached", header: t("billing.col.cachedInput"), align: "end", cell: (p) => (p.cachedInput === "" ? "—" : fmt.integer(p.cachedInput)), csv: (p) => p.cachedInput },
    { id: "output", header: t("billing.col.output"), align: "end", cell: (p) => fmt.integer(p.output), csv: (p) => p.output },
    {
      id: "source",
      header: t("billing.col.source"),
      sort: (p) => p.templateProvider || p.sourceLabel,
      cell: (p) => html`<${Cell} primary=${p.templateProvider || p.sourceLabel || t(p.templateId ? "billing.source.template" : "billing.source.manual")} detail=${p.templateId || p.snapshotDate} />`,
      csv: (p) => p.templateId || p.templateProvider || p.sourceLabel,
    },
    { id: "effective", header: t("billing.col.effective"), sort: (p) => Date.parse(p.effectiveAt || p.updatedAt) || 0, cell: (p) => fmt.dateTime(p.effectiveAt || p.updatedAt), csv: (p) => p.effectiveAt },
    { id: "status", header: t("billing.col.status"), sort: (p) => p.active, cell: (p) => html`<${ActiveStatus} active=${p.active} onKey="billing.state.inEffect" />`, csv: (p) => (p.active ? "active" : "inactive") },
  ];
  return html`<${Section} id="billing-price-rules">
    <${Card} title=${t("billing.prices.title")} level=${2} testid="billing.prices.card">
      <p class="muted small">${t("billing.prices.note")}</p>
      <${DataTable} id="billing-prices" columns=${columns} rows=${rows} rowKey=${(p) => p.id} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.prices.title") })} exportName="billing-prices"
        loading=${!data.settled && !data.loaded}
        filters=${html`<${PriceFilters} filters=${filters} set=${(patch) => setFilters((current) => ({ ...current, ...patch }))} providers=${providers} data=${data} fmt=${fmt} />`}
        empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.prices" testid="billing.prices.empty" />`} />
    <//>
  <//>`;
}

function PlansTable({ data, fmt }) {
  const { t } = fmt;
  const columns = [
    { id: "plan", header: t("billing.col.planName"), sort: (p) => p.name, cell: (p) => html`<${Cell} primary=${p.name} detail=${p.code} />`, csv: (p) => p.name },
    { id: "fee", header: t("billing.col.monthlyFee"), align: "end", cell: (p) => `${fmt.credits(p.monthlyPrice)} ${p.currency}`, csv: (p) => `${p.monthlyPrice} ${p.currency}` },
    { id: "included", header: t("billing.col.included"), align: "end", cell: (p) => fmt.credits(p.includedCredits), csv: (p) => p.includedCredits },
    { id: "quota", header: t("billing.col.quota"), cell: (p) => `${fmt.quota(p.monthlyTokenLimit, "tokens")} · ${fmt.quota(p.monthlyRequestLimit, "requests")}`, csv: (p) => `${p.monthlyTokenLimit} / ${p.monthlyRequestLimit}` },
    { id: "mode", header: t("billing.col.defaultMode"), cell: (p) => fmt.mode(p.enforcementMode), csv: (p) => p.enforcementMode },
    { id: "status", header: t("billing.col.status"), cell: (p) => html`<${ActiveStatus} active=${p.active} />`, csv: (p) => (p.active ? "active" : "inactive") },
  ];
  return html`<${DataTable} id="billing-plans" columns=${columns} rows=${data.plans} rowKey=${(p) => p.id} responsive="cards" caption=${t("billing.tableOf", { title: t("billing.plans.title") })} exportName="billing-plans"
    loading=${!data.settled && !data.loaded}
    empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.plans" testid="billing.plans.empty" />`} />`;
}

function PlanForm({ fmt }) {
  const { t } = fmt;
  const form = useForm(NEW_PLAN);
  const submit = useSubmit(form);
  return html`<${FormCard} id="billing-plan-form" form=${form} title=${t("billing.planForm.title")} submit=${t("billing.planForm.submit")}
    onSubmit=${() => submit({
      validate: () => validatePlan(form.values),
      send: (body, api) => api.post("/api/billing/plans", body),
      doneKey: "billing.planForm.created",
      reset: true,
    })}>
    <${Field} form=${form} id="billing-plan-form" name="code" label=${t("billing.field.planCode")} required maxLength=${32} placeholder="PRO" />
    <${Field} form=${form} id="billing-plan-form" name="name" label=${t("billing.field.planName")} required maxLength=${80} placeholder=${t("billing.field.planNameExample")} />
    <${Field} form=${form} id="billing-plan-form" name="currency" label=${t("billing.field.currency")} required maxLength=${3} />
    <${Field} form=${form} id="billing-plan-form" name="enforcementMode" label=${t("billing.field.defaultMode")} kind="select" options=${MODES.map((mode) => ({ value: mode, label: t(tk("billing.modeLong.", mode)) }))} />
    <${Field} form=${form} id="billing-plan-form" name="monthlyPrice" label=${t("billing.field.monthlyPrice")} inputMode="decimal" maxLength=${26} />
    <${Field} form=${form} id="billing-plan-form" name="includedCredits" label=${t("billing.field.included")} inputMode="decimal" maxLength=${26} />
    <${Field} form=${form} id="billing-plan-form" name="monthlyTokenLimit" label=${t("billing.field.monthlyTokens")} inputMode="numeric" maxLength=${24} />
    <${Field} form=${form} id="billing-plan-form" name="monthlyRequestLimit" label=${t("billing.field.monthlyRequests")} inputMode="numeric" maxLength=${24} />
  <//>`;
}

function PriceForm({ data, fmt, defaultManager }) {
  const { t } = fmt;
  const form = useForm({ planId: "", managerId: defaultManager, modelPattern: "", inputMicrocreditsPerMillion: "0", cachedInputMicrocreditsPerMillion: "0", outputMicrocreditsPerMillion: "0", active: "true" });
  const submit = useSubmit(form);
  const plans = data.plans.filter((plan) => plan.active);
  return html`<${FormCard} id="billing-price-form" form=${form} title=${t("billing.priceForm.title")} submit=${t("billing.priceForm.submit")}
    onSubmit=${() => submit({
      validate: () => validatePrice(form.values, { plans: data.plans }),
      send: (body, api) => api.post("/api/billing/prices", body),
      doneKey: "billing.priceForm.saved",
      reset: true,
    })}>
    <${Field} form=${form} id="billing-price-form" name="planId" label=${t("billing.field.pricePlan")} kind="select" options=${optionList(t("billing.field.planGlobal"), plans, (p) => p.id, (p) => `${p.name} · ${p.code}`)} />
    <${Field} form=${form} id="billing-price-form" name="managerId" label=${t("billing.field.manager")} kind="select" options=${MANAGER_IDS.map((id) => ({ value: id, label: fmt.manager(id) }))} />
    <${Field} form=${form} id="billing-price-form" name="modelPattern" label=${t("billing.field.modelPattern")} required maxLength=${160} placeholder=${t("billing.field.modelPatternExample")} />
    <${Field} form=${form} id="billing-price-form" name="inputMicrocreditsPerMillion" label=${t("billing.field.inputRate")} inputMode="numeric" maxLength=${19} />
    <${Field} form=${form} id="billing-price-form" name="cachedInputMicrocreditsPerMillion" label=${t("billing.field.cachedRate")} inputMode="numeric" maxLength=${19} />
    <${Field} form=${form} id="billing-price-form" name="outputMicrocreditsPerMillion" label=${t("billing.field.outputRate")} inputMode="numeric" maxLength=${19} />
    <${Field} form=${form} id="billing-price-form" name="active" label=${t("billing.field.priceState")} kind="select"
      options=${[{ value: "true", label: t("billing.state.enabled") }, { value: "false", label: t("billing.state.disabled") }]} />
    <p class="muted small">${t("billing.priceForm.help")}</p>
  <//>`;
}

export default function PricesTab({ data, section, defaultManager }) {
  const fmt = useBillingFormat();
  const { t } = fmt;
  return html`<div class="stack" data-testid="billing.prices">
    <p class="notice" role="note" data-testid="billing.prices.banner">${t("billing.templates.banner")}</p>
    <p class="notice notice-warn" role="note" data-testid="billing.prices.boundary">${t("billing.templates.boundary")}</p>
    <${LazyView} load=${() => import("./templates.js")} data=${data} />
    <${PriceRules} data=${data} fmt=${fmt} />
    <div class="billing-grid">
      <${Section} id="billing-plans-section" active=${section === "plans"}>
        <${Card} title=${t("billing.plans.title")} level=${2} testid="billing.plans.card">
          <p class="muted small">${t("billing.plans.note")}</p>
          <${PlansTable} data=${data} fmt=${fmt} />
        <//>
      <//>
      <div class="stack">
        <${PlanForm} fmt=${fmt} />
        <${PriceForm} data=${data} fmt=${fmt} defaultManager=${defaultManager} />
      </div>
    </div>
  </div>`;
}
