// Wizard step 6, "Review" (07 §6.3): everything the launch will do, before it does it.
//
//   changes    what a 409 `plan_changed` or an applied suggestion changed (a DiffTable)
//   steps      what happens: the image step (review-image.js), replace, start
//   overrides  what the recipe or planner changed on the user's values, with the reason
//   values     every effective value with its provenance (read-only SchemaForm, review-values.js)
//   command    the redacted command (CommandPreview) and the diff vs the last successful launch
//   Launch     disabled while the plan has errors or blockers, the admission verdict is `block`, the
//              plan is only a preview or being refreshed. Replace mode asks first. The request
//              carries `expectedPlanHash`; a plan that changed in the meantime comes back here.
//
// Errors, blockers and warnings are listed by the plan strip above every step, each with its
// fix; the Launch button says how many stand in the way.

import { launchGate, overrideRows, replaceTargetOf } from "../../lib/launch-model.js";
import { buildDeployments } from "../../lib/deployments-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CommandPreview } from "../../components/command-preview.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DiffTable } from "../../components/diff-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { LazyPart } from "./lazy-part.js";
import { ImageStep } from "./review-image.js";
import { LastLaunch, SaveProfile } from "./review-last.js";

const loadValues = () => import("./review-values.js");

function Summary({ draft, plan }) {
  const { t, tk } = useT();
  const recipe = plan.plan?.recipe;
  const runtime = plan.plan?.runtime;
  const model = draft.modelRef ? (draft.modelRef.kind === "remote" ? draft.modelRef.repo : draft.modelRef.path) : "";
  const rows = [
    ["model", model],
    ["engine", draft.engineId],
    ["runtime", runtime?.runtimeId || runtime?.id || draft.runtimeId],
    ["recipe", recipe?.id || draft.recipeId],
    ["mode", t(draft.instance.mode === "replace" ? "models.wizard.resources.mode.replace" : "models.wizard.resources.mode.parallel")],
    ["gpus", draft.gpus.length ? draft.gpus.join(", ") : t("models.wizard.resources.gpusAll")],
    ["network", t(draft.access.networkAccess === "lan" ? "models.wizard.access.network.lan" : "models.wizard.access.network.local")],
  ].filter(([, value]) => value);
  return html`<${Card} title=${t("models.wizard.review.summary")} testid="wizard.review.summary">
    <dl class="kv">${rows.map(([id, value]) => html`<div key=${id} class="kv-row" data-fact=${id}><dt>${t(tk("models.wizard.review.fact.", id))}</dt><dd class="mono" data-user-content="">${value}</dd></div>`)}</dl>
  <//>`;
}

function Changes({ change, onDismiss }) {
  const { t } = useT();
  if (!change) return null;
  const title = change.kind === "planChanged" ? t("models.wizard.review.changed") : t("models.wizard.review.applied");
  return html`<div class="notice notice-warn stack-sm" role="status" data-kind=${change.kind} data-testid="wizard.review.change">
    <div class="row"><strong class="grow">${title}</strong><${Button} size="sm" variant="ghost" onClick=${onDismiss} testid="wizard.review.change-dismiss">${t("common.dismiss")}<//></div>
    ${change.rows.length ? html`<${DiffTable} rows=${change.rows} caption=${t("models.wizard.review.change.caption")} testid="wizard.review.change-diff" />` : html`<p class="small" data-testid="wizard.review.change-none">${t("models.wizard.review.changedNone")}</p>`}
  </div>`;
}

function PlanSteps({ plan }) {
  const { t } = useT();
  const steps = (plan.plan?.steps || []).filter((step) => step && (step.kind === "replace" || step.kind === "start"));
  if (!steps.length) return null;
  const gpus = (step) => (Array.isArray(step.gpuIds) && step.gpuIds.length ? step.gpuIds.join(", ") : "—");
  return html`<ol class="stack-sm" aria-label=${t("models.wizard.review.steps")} data-testid="wizard.review.steps">
    ${steps.map((step, index) => html`<li key=${index} data-kind=${step.kind} data-testid="wizard.review.step">
      ${step.kind === "replace" ? t("engines.plan.step.replace", { model: step.model || step.containerName || "" })
        : t("engines.plan.step.start", { container: step.containerName || "", port: String(step.port ?? "—"), gpus: gpus(step) })}
    </li>`)}
  </ol>`;
}

function GateReasons({ gate }) {
  const { t, tk } = useT();
  if (gate.allowed) return null;
  return html`<ul class="small stack-sm" data-testid="wizard.review.gate">
    ${gate.reasons.map((reason) => html`<li key=${reason.kind} data-reason=${reason.kind}>${t(tk("models.wizard.review.gate.", reason.kind), { count: reason.count ?? 0 })}</li>`)}
  </ul>`;
}

export default function StepReview({ draft, plan, catalog, status, launch, goto }) {
  const { api, i18n } = useServices();
  const { t, locale } = i18n;
  const [asking, setAsking] = useState(false);
  const instances = useQuery(["wizard", "instances", draft.managerId], async () => {
    const body = await api.manager(draft.managerId).get("/instances");
    return buildDeployments({ managers: [{ managerId: draft.managerId, instances: body }] }).rows.filter((row) => row.managerId === draft.managerId);
  }, { ttlMs: 10000, enabled: Boolean(draft.managerId) });
  const overrides = useMemo(() => overrideRows(plan.plan, catalog, locale), [plan.plan, catalog, locale]);
  if (!draft.modelRef || !draft.engineId) {
    return html`<${EmptyState} testid="wizard.step.review" icon="info" title=${t(draft.modelRef ? "models.wizard.resources.noEngine" : "models.wizard.engine.noModel")}
      action=${{ label: t(draft.modelRef ? "models.wizard.step.engine" : "models.wizard.step.model"), href: `/deployments/new?step=${draft.modelRef ? "engine" : "model"}` }} />`;
  }
  const running = launch.state.status === "started" && launch.state.jobState === "running";
  const gate = launchGate(plan.plan, { updating: plan.status === "updating", running: running || launch.state.status === "starting" });
  const target = replaceTargetOf(plan.plan, draft, instances.data);
  const click = () => (target ? setAsking(true) : launch.start());
  return html`<div class="stack" data-testid="wizard.step.review" data-state=${status.review}>
    <${Changes} change=${launch.state.change} onDismiss=${launch.dismissChange} />
    ${launch.state.error ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.review.error"><span class="grow" data-user-content="">${launch.message}</span></div>` : null}
    ${running ? html`<div class="notice notice-info" role="status" data-testid="wizard.review.running">
      <span class="grow">${t("models.wizard.review.running")}</span><${Button} size="sm" onClick=${() => goto("launch")} testid="wizard.review.to-launch">${t("models.wizard.review.toLaunch")}<//>
    </div>` : null}
    <${Summary} draft=${draft} plan=${plan} />
    ${plan.plan?.prospective ? html`<p class="notice notice-warn" role="status" data-testid="wizard.review.prospective">${t("engines.plan.prospective")} ${t("engines.err.prospective_not_launchable")}</p>` : null}
    <${Card} title=${t("models.wizard.review.plan")} testid="wizard.review.plan">
      <div class="stack-sm">
        <${PlanSteps} plan=${plan} />
        ${plan.plan?.recipe?.status === "experimental" ? html`<p class="small" data-testid="wizard.review.experimental">${t("engines.plan.experimental")}</p>` : null}
      </div>
    <//>
    <${ImageStep} plan=${plan} managerId=${draft.managerId} />
    ${overrides.length ? html`<${Card} title=${t("models.wizard.review.overrides")} testid="wizard.review.overrides">
      <p class="small muted">${t("models.wizard.review.overridesHint")}</p>
      <${DiffTable} rows=${overrides} caption=${t("models.wizard.review.overrides.caption")} testid="wizard.review.overrides-diff" />
    <//>` : null}
    <${Card} title=${t("models.wizard.review.values")} testid="wizard.review.values">
      <${LazyPart} id="review-values" loader=${loadValues} props=${{ catalog, plan: plan.plan, draft }} />
    <//>
    <${Card} title=${t("models.wizard.review.command")} testid="wizard.review.command">
      <${CommandPreview} command=${plan.plan?.command} extraArgs=${draft.extraArgs} />
    <//>
    <${LastLaunch} draft=${draft} plan=${plan.plan} catalog=${catalog} />
    <div class="row wizard-launch-bar" data-testid="wizard.review.bar">
      <${SaveProfile} draft=${draft} plan=${plan.plan} />
      <span class="grow"></span>
      <${Button} variant="primary" icon="rocket" disabled=${!gate.allowed} busy=${launch.state.status === "starting"} onClick=${click} testid="wizard.launch">${t("models.wizard.review.launch")}<//>
    </div>
    <${GateReasons} gate=${gate} />
    <${ConfirmDialog} open=${asking} testid="wizard.replace" tone="danger" title=${t("models.wizard.review.replace.title", { instance: target?.instance || "", model: target?.model || "" })}
      body=${t("models.wizard.review.replace.body")} confirmLabel=${t("models.wizard.review.replace.confirm")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => launch.start()} onClose=${() => setAsking(false)} />
  </div>`;
}
