// The settings form of wizard step 3 (07 §6.3): the SchemaForm of this step's
// catalog groups (capacity, memory, parallelism, runtime-expert) and of every
// group 07 does not know, under "Other". The `contextLength` field carries a
// FitBar that follows the debounced plan, so the context control is bound to
// the fit. Loaded by step-resources.js on demand (the form is the heaviest
// part of the step).

import { fitOf } from "../../lib/resources-model.js";
import { withValue } from "../../lib/schema-form-model.js";
import { applySuggestion, groupsForStep, unknownGroups } from "../../lib/wizard-state.js";
import { Card } from "../../components/card.js";
import { FitBar } from "../../components/fit-bar.js";
import { SchemaForm } from "../../components/schema-form.js";
import { Skeleton } from "../../components/skeleton.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo } from "../../ui/vendor.js";

/** @param plan the usePlan() state  @param gpus hostGpus() */
export default function ResourceForm({ draft, update, plan, catalog, gpus }) {
  const { t } = useT();
  const others = useMemo(() => unknownGroups(catalog), [catalog]);
  const known = useMemo(() => groupsForStep(catalog, "resources").filter((id) => !others.includes(id)), [catalog, others]);
  const otherGroups = useMemo(() => others.map((id) => ({ id })), [others]);
  if (!catalog) return html`<div aria-busy="true" data-testid="wizard.res.catalog-loading"><${Skeleton} shape="line" rows=${5} /></div>`;

  const change = (id, value, field) => update((now) => ({ ...now, values: withValue(now.values, id, value, { keepNull: field?.secret }) }));
  const reset = (id) => update((now) => ({ ...now, values: withValue(now.values, id, undefined) }));
  const suggestion = (id, value) => update((now) => applySuggestion(now, { param: id, value }));
  const fit = fitOf(plan.plan?.memory, gpus);
  const fieldBadges = (field) => (field.id === "contextLength"
    ? html`<div class="sf-fit" data-testid="wizard.res.context-fit"><${FitBar} fit=${fit} testid="wizard.res.context-fitbar" /></div>` : null);
  const common = { catalog, plan: plan.plan, values: draft.values, mode: "launch", onChange: change, onReset: reset, onApplySuggestion: suggestion };
  return html`<div class="stack">
    ${known.length ? html`<${Card} title=${t("models.wizard.resources.settings")} testid="wizard.res.form">
      <${SchemaForm} ...${common} groups=${known} fieldBadges=${fieldBadges} testid="wizard.res.schema-form" />
    <//>` : null}
    ${others.length ? html`<${Card} title=${t("models.wizard.resources.other")} testid="wizard.res.other">
      <${SchemaForm} ...${common} groups=${otherGroups} testid="wizard.res.schema-form-other" />
    <//>` : null}
  </div>`;
}
