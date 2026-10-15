// The official price template catalog and its apply flow (07 §6.11). A
// template is a traceable snapshot from the server: the page shows its USD
// rates as returned, lets the owner map one to a local model pattern, and
// asks the server to PREVIEW the integer microcredit prices that mapping
// would create. Only a preview made from exactly the current form values can
// be applied (any change disables Apply until previewed again), and applying
// asks once more. The server computes and writes the rates, never this page.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { Field, FormCard, optionList, useForm } from "./forms.js";
import { filterTemplates, MANAGER_IDS, previewItem, templateAvailability, templateSignature, validateTemplateApply } from "../../lib/billing-model.js";
import { Cell, Chip, EmptyTable, useBillingFormat } from "./views.js";

const FORM = { managerId: "vllm-manager", planId: "", modelPattern: "", creditsPerUsd: "1", markupBps: "10000" };

function effectiveLabel(template, t) {
  if (template.effectiveFrom && template.effectiveTo) return t("billing.templates.effective.range", { from: template.effectiveFrom, to: template.effectiveTo });
  if (template.effectiveFrom) return t("billing.templates.effective.from", { from: template.effectiveFrom });
  if (template.effectiveTo) return t("billing.templates.effective.to", { to: template.effectiveTo });
  return t("billing.templates.effective.none");
}

function usd(value, template) {
  return value === "" ? "—" : `${value} ${template.currency}`;
}

function Selection({ template, t }) {
  if (!template) return html`<p class="muted" data-testid="billing.templates.selection">${t("billing.templates.noneSelected")}</p>`;
  const notes = [template.notes, template.cacheNotes, template.storageNotes].filter(Boolean).join("; ");
  const references = [
    template.cacheWrite ? `cache-write ${template.cacheWrite} USD/1M` : "",
    template.cacheWrite5m ? `cache-write 5m ${template.cacheWrite5m} USD/1M` : "",
    template.cacheWrite1h ? `cache-write 1h ${template.cacheWrite1h} USD/1M` : "",
    template.cacheStorage ? `cache-storage ${template.cacheStorage} USD/1M-token-hour` : "",
  ].filter(Boolean).join("; ");
  return html`<p data-testid="billing.templates.selection" data-user-content>
    ${template.displayName || template.model} · ${template.provider} · ${template.snapshotDate || t("billing.templates.noSnapshot")}
    ${notes ? t("billing.templates.notes", { notes }) : ""}
    ${references ? t("billing.templates.references", { references }) : ""}
  </p>`;
}

function Preview({ preview, template, pattern, fmt }) {
  const { t } = fmt;
  const item = previewItem(preview.response);
  const missing = t("billing.templates.preview.missing");
  const entries = [
    ["template", template ? template.displayName || template.model : "—"],
    ["target", item.modelPattern || pattern],
    ["input", item.input === "" ? missing : fmt.rate(item.input)],
    ["cached", item.cachedInput === "" ? t("billing.templates.preview.noCached") : fmt.rate(item.cachedInput)],
    ["output", item.output === "" ? missing : fmt.rate(item.output)],
    ["effective", fmt.dateTime(item.effectiveAt)],
  ];
  return html`<div class="stack-sm" data-testid="billing.templates.preview">
    <dl class="kv">
      ${entries.map(([id, value]) => html`<dt key=${`${id}-t`}>${t(tk("billing.templates.preview.", id))}</dt><dd key=${`${id}-d`} data-testid=${`billing.templates.preview.${id}`} data-user-content>${value}</dd>`)}
    </dl>
    ${item.warning ? html`<p class="notice notice-warn" role="note">${String(item.warning).slice(0, 400)}</p>` : null}
  </div>`;
}

export function TemplatesSection({ data }) {
  const fmt = useBillingFormat();
  const { t } = fmt;
  const { api, cache, toasts, i18n } = useServices();
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState(null);
  const form = useForm(FORM);
  const now = Date.now();

  const providers = useMemo(() => [...new Set(data.templates.map((template) => template.provider).filter(Boolean))].sort(), [data.templates]);
  const rows = useMemo(() => filterTemplates(data.templates, { provider, query: search }), [data.templates, provider, search]);
  const template = data.templates.find((item) => item.id === selectedId) || null;
  const plans = data.plans.filter((plan) => plan.active);

  const current = validateTemplateApply(form.values, { template, plans: data.plans, now });
  const signature = current.ok ? templateSignature(current.value) : "";
  const fresh = Boolean(preview && signature && preview.signature === signature);

  function pick(candidate) {
    const availability = templateAvailability(candidate, now);
    if (!availability.selectable) {
      setNotice({ tone: "warn", text: t("billing.templates.unavailable", { reason: t(tk("billing.templates.state.", availability.code)) }) });
      return;
    }
    setSelectedId(candidate.id);
    setPreview(null);
    setNotice(null);
    if (candidate.suggestedModelPattern && !form.values.modelPattern.trim()) form.set("modelPattern", candidate.suggestedModelPattern);
  }

  async function runPreview() {
    if (!current.ok) {
      form.setErrors(current.errors);
      setNotice(current.errors.template ? { tone: "warn", text: t(tk("billing.error.", current.errors.template.code), current.errors.template.vars) } : null);
      return;
    }
    form.setErrors({});
    form.setFailure(null);
    form.setBusy(true);
    try {
      const response = await api.post("/api/billing/templates/preview", current.value);
      setPreview({ signature: templateSignature(current.value), response });
      setNotice({ tone: "success", text: t("billing.templates.previewReady") });
    } catch (error) {
      form.setFailure(error);
    } finally {
      form.setBusy(false);
    }
  }

  const columns = [
    { id: "model", header: t("billing.templates.col.model"), sort: (item) => item.displayName || item.model, cell: (item) => html`<${Cell} primary=${item.displayName || item.model} detail=${`${item.provider} · ${item.id}`} />`, csv: (item) => item.id },
    {
      id: "tier",
      header: t("billing.templates.col.tier"),
      cell: (item) => html`<${Cell} primary=${item.tier || "—"} detail=${[item.contextLabel, effectiveLabel(item, t), t(tk("billing.templates.state.", templateAvailability(item, now).code))].filter(Boolean).join(" · ")} />`,
      csv: (item) => item.tier,
    },
    { id: "input", header: t("billing.templates.col.input"), align: "end", cell: (item) => usd(item.input, item), csv: (item) => item.input },
    { id: "cached", header: t("billing.templates.col.cached"), align: "end", cell: (item) => usd(item.cachedInput, item), csv: (item) => item.cachedInput },
    { id: "output", header: t("billing.templates.col.output"), align: "end", cell: (item) => usd(item.output, item), csv: (item) => item.output },
    {
      id: "source",
      header: t("billing.templates.col.source"),
      csv: (item) => item.sourceUrl,
      cell: (item) => html`<div data-user-content>
        ${item.sourceUrl
          ? html`<a href=${item.sourceUrl} target="_blank" rel="noopener noreferrer">${item.sourceLabel || t("billing.templates.officialSource")}</a>`
          : html`<span>${item.sourceLabel || t("billing.templates.backendSource")}</span>`}
        ${item.snapshotDate ? html`<div class="muted xsmall">${t("billing.templates.snapshotOf", { date: item.snapshotDate })}</div>` : null}
      </div>`,
    },
    {
      id: "select",
      header: t("billing.templates.col.select"),
      csv: false,
      cell: (item) => {
        const availability = templateAvailability(item, now);
        return html`<${Button} size="sm" variant=${item.id === selectedId ? "primary" : "default"} disabled=${!availability.selectable} aria-pressed=${item.id === selectedId ? "true" : "false"}
          title=${availability.selectable ? t("billing.templates.selectThis") : t(tk("billing.templates.state.", availability.code))} data-template-id=${item.id}
          label=${t("billing.templates.selectFor", { name: item.displayName || item.model })} onClick=${() => pick(item)} testid="billing.template.select">${t("billing.templates.select")}<//>`;
      },
    },
  ];

  const sources = [...new Set(data.templates.map((item) => item.sourceLabel).filter(Boolean))];
  const snapshots = data.templates.map((item) => item.snapshotDate).filter(Boolean).sort();
  const meta = data.templateMeta;
  const snapshot = `${meta.snapshot || snapshots[snapshots.length - 1] || "—"}${meta.catalogVersion ? ` · ${meta.catalogVersion}` : ""}`;

  return html`<div class="billing-grid" data-testid="billing.templates">
    <${Card} title=${t("billing.templates.title")} level=${2} testid="billing.templates.catalog"
      actions=${html`<${Button} size="sm" onClick=${data.refetchTemplates} testid="billing.templates.reload">${t("billing.templates.reload")}<//>`}>
      <p class="muted small">${t("billing.templates.note")}</p>
      <p class="muted small" data-testid="billing.templates.meta">${t("billing.templates.source", { source: meta.source || sources.join(", ") || t("billing.templates.catalogDefault") })} · ${t("billing.templates.snapshot", { snapshot })}</p>
      <div class="row" role="group" aria-label=${t("billing.templates.providers")} data-testid="billing.templates.providers">
        <${Chip} pressed=${provider === ""} onClick=${() => setProvider("")} data-template-provider="" testid="billing.templates.provider">${t("billing.templates.allProviders")}<//>
        ${providers.map((name) => html`<${Chip} key=${name} pressed=${provider === name} onClick=${() => setProvider(name)} data-template-provider=${name} testid="billing.templates.provider">${name}<//>`)}
      </div>
      <${DataTable} id="billing-templates" columns=${columns} rows=${rows} rowKey=${(item) => item.id} responsive="cards" caption=${t("billing.templates.title")} exportName="billing-price-templates"
        loading=${!data.templates.length && !data.settled}
        filters=${html`<input class="input keys-search" type="search" maxlength="100" value=${search} placeholder=${t("billing.templates.search")} aria-label=${t("billing.templates.searchLabel")}
          onInput=${(event) => setSearch(event.currentTarget.value)} data-testid="billing.templates.search" />`}
        empty=${html`<${EmptyTable} data=${data} titleKey="billing.empty.templates" testid="billing.templates.empty" />`} />
    <//>
    <div class="stack">
      <${FormCard} id="billing-template-form" form=${form} title=${t("billing.templates.apply.title")} note=${t("billing.templates.apply.note")} submit=${t("billing.templates.preview.button")}
        onSubmit=${runPreview}
        extraActions=${html`<${Button} variant="primary" disabled=${!fresh} onClick=${() => setConfirming(true)} testid="billing-template-form.apply">${t("billing.templates.apply.button")}<//>`}>
        <${Selection} template=${template} t=${t} />
        <${Field} form=${form} id="billing-template-form" name="managerId" label=${t("billing.field.targetManager")} required kind="select" options=${MANAGER_IDS.map((id) => ({ value: id, label: fmt.manager(id) }))} />
        <${Field} form=${form} id="billing-template-form" name="planId" label=${t("billing.field.targetPlan")} kind="select" options=${optionList(t("billing.field.planGlobal"), plans, (p) => p.id, (p) => `${p.name} · ${p.code}`)} />
        <${Field} form=${form} id="billing-template-form" name="modelPattern" label=${t("billing.field.localPattern")} required maxLength=${160} placeholder=${t("billing.field.localPatternExample")} />
        <${Field} form=${form} id="billing-template-form" name="creditsPerUsd" label=${t("billing.field.creditsPerUsd")} inputMode="decimal" maxLength=${26} />
        <${Field} form=${form} id="billing-template-form" name="markupBps" label=${t("billing.field.markupBps")} inputMode="numeric" maxLength=${12} />
        <p class="muted small">${t("billing.templates.apply.help")}</p>
      <//>
      ${notice ? html`<p class=${`notice${notice.tone === "warn" ? " notice-warn" : notice.tone === "success" ? " notice-success" : ""}`} role="status" data-testid="billing.templates.notice">${notice.text}</p>` : null}
      ${fresh ? html`<${Card} title=${t("billing.templates.preview.title")} level=${3} testid="billing.templates.preview-card"><${Preview} preview=${preview} template=${template} pattern=${form.values.modelPattern} fmt=${fmt} /><//>` : null}
    </div>
    ${confirming && fresh ? html`<${ConfirmDialog} open testid="billing.templates.dialog" title=${t("billing.templates.confirm.title")}
      body=${t("billing.templates.confirm.body", { name: template.displayName || template.model, pattern: current.value.items[0].modelPattern })}
      confirmLabel=${t("billing.templates.apply.button")}
      onConfirm=${async () => {
        await api.post("/api/billing/templates/apply", current.value);
        cache.invalidate(["billing"]);
        setPreview(null);
        setNotice({ tone: "success", text: t("billing.templates.applied") });
        toasts?.push?.({ level: "success", title: i18n.t("billing.templates.appliedToast") });
      }}
      onClose=${() => setConfirming(false)} />` : null}
  </div>`;
}

export default TemplatesSection;
