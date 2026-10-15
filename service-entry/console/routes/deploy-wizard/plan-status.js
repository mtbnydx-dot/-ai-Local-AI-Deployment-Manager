// What the plan says, on every wizard step (07 §6.3 "Plan loop"). The strip
// shows whether the plan is current ("Updating…" while a request is out, the
// last plan stays visible); an `ok:false` plan renders its field errors with
// their suggestions and its blockers as cards with a fix action; only a 400 or
// a transport failure is a banner, and the last plan stays under it.

import { describeError } from "../../lib/api.js";
import { stepOfBlocker } from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Icon } from "../../components/icon.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function paramOf(catalog, field) {
  const params = list(catalog?.params);
  let name = String(field || "");
  while (name) {
    const found = params.find((param) => param?.id === name);
    if (found) return found;
    const cut = Math.max(name.lastIndexOf("."), name.lastIndexOf("["));
    if (cut <= 0) break;
    name = name.slice(0, cut);
  }
  return null;
}

function valueText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function FieldErrors({ errors, catalog, onSuggestion }) {
  const { t, pick } = useT();
  if (!errors.length) return null;
  return html`<ul class="stack-sm plan-problems" data-testid="wizard.plan-errors">
    ${errors.map((error, index) => {
      const field = typeof error.field === "string" ? error.field : typeof error.path === "string" ? error.path : "";
      const label = pick(paramOf(catalog, field)?.label);
      const suggestion = isObject(error.suggestion) && Object.hasOwn(error.suggestion, "value") ? error.suggestion : null;
      return html`<li key=${index} class="notice notice-danger plan-problem" data-field=${field} data-code=${error.code} data-testid="wizard.plan-error">
        <span class="grow">
          ${label ? html`<strong>${label}</strong> ` : null}
          <span data-user-content="">${error.message || error.code}</span>
          ${field ? html` <code class="code-inline xsmall">${field}</code>` : null}
          ${suggestion?.why ? html`<span class="small muted" data-user-content=""> ${pick(suggestion.why)}</span>` : null}
        </span>
        ${suggestion ? html`<${Button} size="sm" onClick=${() => onSuggestion?.({ param: field, value: suggestion.value })} testid="wizard.plan-suggestion">
          ${t("models.wizard.plan.useSuggestion", { value: valueText(suggestion.value) })}<//>` : null}
      </li>`;
    })}
  </ul>`;
}

function Blockers({ blockers, onGoto }) {
  const { t, pick } = useT();
  if (!blockers.length) return null;
  return html`<ul class="stack-sm plan-problems" data-testid="wizard.plan-blockers">
    ${blockers.map((blocker, index) => {
      const step = stepOfBlocker(blocker);
      const action = isObject(blocker.action) ? blocker.action : null;
      return html`<li key=${index} class="notice notice-warn plan-problem" data-code=${blocker.code} data-step=${step} data-testid="wizard.plan-blocker">
        <span class="grow">
          <strong>${t("models.wizard.plan.blocker")}</strong>
          <span data-user-content=""> ${pick(blocker.message) || blocker.code}</span>
        </span>
        <${Button} size="sm" onClick=${() => onGoto?.(step)} testid="wizard.plan-fix">${(action && pick(action.label)) || t("models.wizard.plan.fix")}<//>
      </li>`;
    })}
  </ul>`;
}

function Warnings({ warnings }) {
  const { t, pick } = useT();
  if (!warnings.length) return null;
  return html`<ul class="stack-sm small plan-warnings" data-testid="wizard.plan-warnings">
    ${warnings.map((warning, index) => html`<li key=${index} data-code=${warning?.code || ""}>
      <${Icon} name="triangle-alert" /> <span class="sr-only">${t("models.wizard.plan.warning")}</span>
      <span data-user-content="">${pick(warning?.message) || (typeof warning?.message === "string" ? warning.message : "") || warning?.code || ""}</span>
    </li>`)}
  </ul>`;
}

/**
 * @param state the usePlan() result
 * @param catalog the engine's schema catalog, for field labels
 * @param onSuggestion ({ param, value }) apply a suggestion to the draft
 * @param onGoto (step) jump to the step a blocker is fixed on
 */
export function PlanStatus({ state, catalog, onSuggestion, onGoto }) {
  const i18n = useT();
  const { t } = i18n;
  const plan = state.plan;
  const errors = list(plan?.errors);
  const blockers = list(plan?.blockers);
  const warnings = list(plan?.warnings);
  const problems = errors.length + blockers.length;
  let label;
  if (state.status === "updating") label = t("models.wizard.plan.updating");
  else if (!plan) label = t("models.wizard.plan.idle");
  else if (plan.ok === false || problems) label = t("models.wizard.plan.problems", { count: problems });
  else label = t("models.wizard.plan.ok");
  return html`<section class="plan-status stack-sm" aria-label=${t("models.wizard.plan.title")} data-testid="wizard.plan-status" data-status=${state.status}
    data-ok=${plan ? String(plan.ok !== false && !problems) : "none"} data-requests=${String(state.requests || 0)}>
    <p class="small" role="status" data-testid="wizard.plan-label">${label}</p>
    ${state.status === "error" ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.plan-banner">
      <span class="grow">${t("models.wizard.plan.failed")} <span data-user-content="">${describeError(state.error, i18n)}</span></span>
      <${Button} size="sm" onClick=${() => state.refresh?.()} testid="wizard.plan-retry">${t("models.wizard.plan.retry")}<//>
    </div>` : null}
    <${FieldErrors} errors=${errors} catalog=${catalog} onSuggestion=${onSuggestion} />
    <${Blockers} blockers=${blockers} onGoto=${onGoto} />
    <${Warnings} warnings=${warnings} />
  </section>`;
}
