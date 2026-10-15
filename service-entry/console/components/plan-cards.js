// PlanCards (07 §4.4, 02 §11 and §18 R-UI-4): the launch planner's output, at
// most three plans per GPU set. A card shows the engine@runtime, the plan's
// key values, a FitBar, the trade-offs and whether the manager validated the
// plan (`validated`: ok, failed with its errors, or not validated). Picking a
// plan never applies it: onPick(plan, gpuSet) opens the page's DiffTable
// first. The plan's `values` are catalog ids; they are handed over exactly as
// the planner named them (planValues keeps every id, value and nothing else).
//
// <PlanCards gpuSets=[{ gpuIds, plans }] value=<planId> onPick(plan, set) catalog />

import { planValues } from "../lib/resources-model.js";
import { pickText } from "../lib/schema-form-model.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { FitBar } from "./fit-bar.js";
import { Icon } from "./icon.js";
import { StatusBadge } from "./status-badge.js";

export { planValues };

/** The settings a card leads with, in this order; the rest follow in the planner's order. */
export const KEY_VALUE_ORDER = Object.freeze(["contextLength", "concurrency", "kvCacheDtype", "llamacpp.cacheTypeK", "llamacpp.cacheTypeV", "tensorParallel"]);
const KEY_VALUE_LIMIT = 6;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** "ok" when the manager validated the plan, "failed" when it answered with problems, "unvalidated" otherwise (validated null: no manager, a timeout). */
export function validationOf(plan) {
  const validated = plan?.validated;
  if (!isObject(validated)) return "unvalidated";
  return validated.ok === true && !list(validated.errors).length ? "ok" : "failed";
}

function unwrapValue(entry) {
  return isObject(entry) && Object.hasOwn(entry, "value") ? entry.value : entry;
}

/** The rows of a card's key values: [{ id, value, reason }], leading settings first, at most `limit`. */
export function keyValues(plan, limit = KEY_VALUE_LIMIT) {
  const ids = Object.keys(isObject(plan?.values) ? plan.values : {});
  const rank = (id) => (KEY_VALUE_ORDER.includes(id) ? KEY_VALUE_ORDER.indexOf(id) : KEY_VALUE_ORDER.length);
  const sorted = ids.map((id, order) => ({ id, order })).sort((a, b) => rank(a.id) - rank(b.id) || a.order - b.order);
  return sorted.slice(0, limit).map(({ id }) => {
    const entry = plan.values[id];
    return { id, value: unwrapValue(entry), reason: isObject(entry) && entry.reason ? entry.reason : null };
  });
}

function valueText(id, value, fmt) {
  if (value === null || value === undefined || value === "") return "—";
  if (id === "contextLength" && Number.isFinite(Number(value))) return fmt.tokens(Number(value));
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function Validation({ plan }) {
  const { t, pick } = useT();
  const state = validationOf(plan);
  const errors = list(plan?.validated?.errors);
  return html`<div class="stack-sm" data-testid="plan-cards.validated" data-state=${state}>
    <${StatusBadge} status=${state === "ok" ? "ok" : state === "failed" ? "error" : "unknown"} label=${t(state === "ok" ? "models.plan.validated.ok" : state === "failed" ? "models.plan.validated.failed" : "models.plan.validated.none")} />
    ${state === "ok" ? html`<p class="small muted">${t("models.plan.validated.okHint")}</p>` : null}
    ${state === "unvalidated" ? html`<p class="small muted">${t("models.plan.validated.noneHint")}</p>` : null}
    ${errors.length ? html`<ul class="small plan-card-errors" data-testid="plan-cards.errors">
      ${errors.slice(0, 3).map((error, index) => html`<li key=${index} data-code=${error?.code || ""}><span data-user-content="">${pick(error?.message) || error?.code || ""}</span></li>`)}
    </ul>` : null}
  </div>`;
}

function PlanCard({ plan, set, selected, onPick, catalog }) {
  const { t, pick, locale } = useT();
  const fmt = useFormat();
  const params = new Map(list(catalog?.params).filter((param) => isObject(param) && typeof param.id === "string").map((param) => [param.id, param]));
  const rows = keyValues(plan);
  const hidden = Object.keys(isObject(plan.values) ? plan.values : {}).length - rows.length;
  const tradeoffs = list(plan.tradeoffs);
  return html`<li class="plan-card" data-testid="plan-cards.card" data-plan-id=${plan.planId} data-engine=${plan.engineId} data-rank=${plan.rank}
    data-validated=${validationOf(plan)} data-selected=${selected ? "true" : "false"}>
    <div class="row-nowrap plan-card-head">
      <span class="chip chip-neutral">${t("models.plan.rank", { rank: plan.rank ?? 1 })}</span>
      <strong class="grow plan-card-title" data-user-content="" data-testid="plan-cards.title">${pick(plan.title) || plan.engineId}</strong>
    </div>
    <p class="small muted"><code class="code-inline" data-testid="plan-cards.engine">${plan.runtimeId || plan.engineId}</code>${plan.recipeId ? html` · <span data-testid="plan-cards.recipe">${t("models.plan.recipe", { recipe: plan.recipeId })}</span>` : null}</p>
    <${Validation} plan=${plan} />
    <${FitBar} fit=${plan.fit} testid="plan-cards.fit" />
    <dl class="plan-values" aria-label=${t("models.plan.keyValues")} data-testid="plan-cards.values">
      ${rows.map((row) => {
        const label = pickText(params.get(row.id)?.label, locale);
        return html`<div key=${row.id} data-testid="plan-cards.value" data-param=${row.id}>
          <dt>${label ? html`${label} <code class="code-inline xsmall">${row.id}</code>` : html`<code class="code-inline">${row.id}</code>`}</dt>
          <dd class="num" title=${row.reason ? pick(row.reason) : undefined}>${valueText(row.id, row.value, fmt)}</dd>
        </div>`;
      })}
    </dl>
    ${hidden > 0 ? html`<p class="small muted">${t("models.plan.moreValues", { count: hidden })}</p>` : null}
    ${plan.requiresProbe ? html`<p class="small" data-testid="plan-cards.probe"><${Icon} name="circle-help" /> ${t("models.plan.needsProbe")}</p>` : null}
    ${tradeoffs.length ? html`<div class="stack-sm" data-testid="plan-cards.tradeoffs">
      <h4 class="small plan-card-sub">${t("models.plan.tradeoffs")}</h4>
      <ul class="small plan-tradeoffs">${tradeoffs.map((item, index) => html`<li key=${index} data-user-content="">${pick(item) || String(item)}</li>`)}</ul>
    </div>` : null}
    <div class="row-nowrap plan-card-foot">
      <span class="grow small muted">${selected ? t("models.plan.applied") : ""}</span>
      <${Button} size="sm" variant=${selected ? "default" : "primary"} onClick=${() => onPick?.(plan, set)} testid="plan-cards.pick">${t("models.plan.pick")}<//>
    </div>
  </li>`;
}

export function PlanCards({ gpuSets = [], value, onPick, catalog, testid }) {
  const { t } = useT();
  return html`<div class="plan-cards stack" data-testid=${testid || "plan-cards.root"}>
    ${list(gpuSets).map((set, index) => {
      const plans = list(set?.plans).slice(0, 3);
      const gpus = list(set?.gpuIds).join(", ");
      return html`<section key=${index} class="plan-set stack-sm" aria-label=${t("models.goal.gpuSet", { gpus: gpus || "—" })} data-testid="plan-cards.set" data-gpus=${list(set?.gpuIds).join(",")}>
        <h3 class="plan-set-title">${t("models.goal.gpuSet", { gpus: gpus || "—" })}</h3>
        ${plans.length ? html`<ul class="plan-grid">
          ${plans.map((plan) => html`<${PlanCard} key=${plan.planId || plan.rank} plan=${plan} set=${set} selected=${Boolean(value) && value === plan.planId} onPick=${onPick} catalog=${catalog} />`)}
        </ul>` : html`<p class="muted" data-testid="plan-cards.empty">${t("models.goal.none")}</p>`}
      </section>`;
    })}
  </div>`;
}
