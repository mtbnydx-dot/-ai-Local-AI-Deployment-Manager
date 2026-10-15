// Wizard step 4, "Capabilities" (07 §6.3): what the model can do and how the
// engine should expose it.
//
//   Settings   the SchemaForm of this step's groups: reasoning and tool parsers,
//              speculative decoding, multimodal, sampling defaults and LoRA adapters
//   Template   the "Detected template format" card with the evidence for each fact
//   Pairing    draft heads and vision projectors from the library that fit this model
//              (ModelCard `compatibleWith`, 02 §7); offered, never applied silently
//
// The parameters of this step's groups come from the engine's catalog (01 §9);
// the form follows the plan, so a parser the image does not have shows its warning.

import { COMPANION_ROLES, companionEntries, companionParam, pairsWith, templateRows } from "../../lib/capabilities-model.js";
import { withValue } from "../../lib/schema-form-model.js";
import { applySuggestion, groupsForStep } from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { EvidenceChip, confidenceOf, evidenceFor } from "../../components/evidence-chip.js";
import { SchemaForm } from "../../components/schema-form.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo } from "../../ui/vendor.js";
import { useCard } from "./card-source.js";

const MAX_CANDIDATES = 8;
const enc = encodeURIComponent;

function TemplateCard({ card, loading }) {
  const { t, tk } = useT();
  const rows = useMemo(() => templateRows(card), [card]);
  return html`<${Card} title=${t("models.wizard.cap.template.title")} testid="wizard.cap.template">
    ${loading ? html`<div aria-busy="true"><${Skeleton} shape="line" rows=${2} /></div>`
      : rows.length ? html`<table class="table model-card-facts" data-testid="wizard.cap.template-facts">
        <caption class="sr-only">${t("models.wizard.cap.template.title")}</caption>
        <tbody>${rows.map((row) => html`<tr key=${row.id} data-fact=${row.id} data-testid="wizard.cap.template-row">
          <th scope="row">${t(tk("models.wizard.cap.template.", row.id))}</th>
          <td class=${row.mono ? "mono" : ""} data-user-content="">${row.value}</td>
          <td><${EvidenceChip} confidence=${confidenceOf(card, row.pointer)} evidence=${evidenceFor(card, row.pointer)} /></td>
        </tr>`)}</tbody>
      </table>`
      : html`<p class="muted" data-testid="wizard.cap.template-none">${t("models.wizard.cap.template.none")}</p>`}
  <//>`;
}

// Companions of the library that pair with the main model; a library without them (or without the hub) shows nothing.
function useCompanions(card) {
  const { api } = useServices();
  const cardId = card?.cardId || "";
  return useQuery(["wizard", "companions", cardId], async () => {
    let entries;
    try {
      entries = (await api.get("/api/hub/library"))?.entries;
    } catch {
      return [];
    }
    const candidates = companionEntries(entries).slice(0, MAX_CANDIDATES);
    const cards = await Promise.all(candidates.map((entry) => api.get(`/api/models/${enc(entry.cardId)}/card`, { query: { view: "full" } }).then((body) => body?.card, () => null)));
    return candidates.filter((entry, index) => cards[index] && pairsWith(card, cards[index]));
  }, { ttlMs: 30000, enabled: Boolean(cardId) });
}

function PairingCard({ card, draft, update }) {
  const { t, tk } = useT();
  const found = useCompanions(card);
  const items = (found.data || []).filter((entry) => COMPANION_ROLES.includes(entry.role) && companionParam(entry.role, draft.engineId));
  if (!items.length) return null;
  const apply = (entry) => update((now) => applySuggestion(now, { param: companionParam(entry.role, now.engineId), value: entry.path }));
  return html`<${Card} title=${t("models.wizard.cap.pairing.title")} testid="wizard.cap.pairing">
    <p class="small muted">${t("models.wizard.cap.pairing.hint")}</p>
    <ul class="stack-sm">
      ${items.map((entry) => {
        const param = companionParam(entry.role, draft.engineId);
        const used = draft.values[param] === entry.path;
        return html`<li key=${entry.cardId} class="row" data-role=${entry.role} data-testid="wizard.cap.companion">
          <span class="grow"><strong data-user-content="">${entry.name}</strong> <span class="badge badge-neutral">${t(tk("models.role.", entry.role))}</span></span>
          <${Button} size="sm" disabled=${used} onClick=${() => apply(entry)} testid="wizard.cap.companion-use">${used ? t("models.wizard.cap.pairing.used") : t("models.wizard.cap.pairing.use")}<//>
        </li>`;
      })}
    </ul>
  <//>`;
}

export default function StepCapabilities({ draft, update, plan, catalog }) {
  const { t } = useT();
  const { card, loading } = useCard(draft.modelRef);
  const groups = useMemo(() => groupsForStep(catalog, "capabilities"), [catalog]);
  if (!draft.modelRef || !draft.engineId) {
    return html`<${EmptyState} testid="wizard.step.capabilities" icon="info" title=${t(draft.modelRef ? "models.wizard.resources.noEngine" : "models.wizard.engine.noModel")}
      action=${{ label: t(draft.modelRef ? "models.wizard.step.engine" : "models.wizard.step.model"), href: `/deployments/new?step=${draft.modelRef ? "engine" : "model"}` }} />`;
  }
  const change = (id, value, field) => update((now) => ({ ...now, values: withValue(now.values, id, value, { keepNull: field?.secret }) }));
  const reset = (id) => update((now) => ({ ...now, values: withValue(now.values, id, undefined) }));
  const suggestion = (id, value) => update((now) => applySuggestion(now, { param: id, value }));
  return html`<div class="stack" data-testid="wizard.step.capabilities">
    ${catalog ? html`<${Card} title=${t("models.wizard.cap.settings")} testid="wizard.cap.form">
      ${groups.length ? html`<${SchemaForm} catalog=${catalog} plan=${plan.plan} values=${draft.values} mode="launch" groups=${groups}
        onChange=${change} onReset=${reset} onApplySuggestion=${suggestion} testid="wizard.cap.schema-form" />`
        : html`<p class="muted" data-testid="wizard.cap.no-groups">${t("models.wizard.cap.noGroups")}</p>`}
    <//>` : html`<div aria-busy="true" data-testid="wizard.cap.catalog-loading"><${Skeleton} shape="line" rows=${5} /></div>`}
    <${TemplateCard} card=${card} loading=${loading} />
    ${card ? html`<${PairingCard} card=${card} draft=${draft} update=${update} />` : null}
  </div>`;
}
