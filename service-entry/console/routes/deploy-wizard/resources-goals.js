// Goal chips and plan cards of wizard step 3 (07 §6.3, 02 §18 step 4 "Plans").
// A chip calls POST /api/launch/recommend {cardId, goal, gpuSets:[draft.gpus]}
// and the answer shows as PlanCards (at most three per GPU set). Picking a
// card never applies it: a card whose engine differs from the draft first
// confirms the engine change, then a DiffTable shows the plan against the
// current values, and only Apply copies them in with the `planner` provenance
// (lib/resources-model.js planDraft). Loaded by step-resources.js on demand.

import { describeError } from "../../lib/api.js";
import { isExperimental } from "../../lib/compat-model.js";
import { engineRows, missingEndpoint, planDraft, planValues, recommendBody } from "../../lib/resources-model.js";
import { GOALS, diffValues } from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DiffTable } from "../../components/diff-table.js";
import { PlanCards } from "../../components/plan-cards.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";
import { guards } from "./guards.js";

// Literal keys, so the key checker sees each one used.
const GOAL_KEYS = Object.freeze({
  "max-context": "models.goal.max-context",
  balanced: "models.goal.balanced",
  throughput: "models.goal.throughput",
  "low-vram": "models.goal.low-vram",
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** @param engines engineIndex(GET /api/engines)  @param current the effective values the diff starts from */
export default function GoalPlans({ draft, update, cardId, catalog, engines, current }) {
  const { api, toasts } = useServices();
  const i18n = useT();
  const { t, locale } = i18n;
  const [active, setActive] = useState("");
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ status: "idle", data: null, error: null });
  const [pending, setPending] = useState(null);
  const [applied, setApplied] = useState("");
  const gpusKey = draft.gpus.join(",");
  const managerOf = (engineId) => engines.get(engineId)?.managerId || "";

  useEffect(() => {
    if (!active || !cardId) return undefined;
    const controller = new AbortController();
    setState((previous) => ({ status: "loading", data: previous.data, error: null }));
    api.post("/api/launch/recommend", recommendBody(cardId, active, draft.gpus), { signal: controller.signal, guard: guards.recommend }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data, error: null });
      },
      (error) => {
        if (!controller.signal.aborted) setState({ status: missingEndpoint(error) ? "unavailable" : "error", data: null, error });
      },
    );
    return () => controller.abort();
  }, [active, cardId, gpusKey, nonce]);

  function chooseGoal(goal) {
    update({ goal });
    setApplied("");
    if (goal === active) setNonce((value) => value + 1);
    else setActive(goal);
  }
  const gpuSets = list(state.data?.gpuSets);
  const notes = list(state.data?.notes);
  const planned = pending?.plan || null;
  const engineMeta = planned ? engines.get(planned.engineId) || null : null;
  const unresolved = Boolean(planned) && planned.engineId !== draft.engineId && !managerOf(planned.engineId);
  const rows = planned
    ? [...engineRows(draft, planned, { engine: t("models.plan.engine"), recipe: t("models.plan.recipeRow") }), ...diffValues(current, planValues(planned), catalog, { locale })]
    : [];
  function begin(chosen) {
    setPending({ plan: chosen, phase: chosen.engineId !== draft.engineId ? "engine" : "diff" });
  }
  function apply() {
    if (unresolved) throw new Error(t("models.plan.engineChange.noManager", { engine: planned.engineId }));
    update((draftNow) => planDraft(draftNow, planned, { managerId: managerOf(planned.engineId), experimental: isExperimental(engineMeta) }));
    setApplied(planned.planId || "");
    toasts?.push?.({ level: "success", title: t("models.plan.appliedToast") });
  }

  return html`<${Card} title=${t("models.goal.title")} testid="wizard.res.goals">
    <div class="stack-sm">
      <p class="small muted">${t("models.goal.hint")}</p>
      <div class="row goal-chips" role="group" aria-label=${t("models.goal.title")} data-testid="wizard.res.goal-chips">
        ${GOALS.map((goal) => html`<button key=${goal} type="button" class="chip goal-chip" aria-pressed=${draft.goal === goal ? "true" : "false"} disabled=${!cardId}
          onClick=${() => chooseGoal(goal)} data-testid="wizard.res.goal" data-goal=${goal}>${t(GOAL_KEYS[goal])}</button>`)}
      </div>
      <div aria-live="polite" data-testid="wizard.res.goal-state" data-state=${state.status}>
        ${state.status === "loading" ? html`<div aria-busy="true"><p class="small muted">${t("models.goal.running")}</p>${!state.data ? html`<${Skeleton} shape="line" rows=${3} />` : null}</div>` : null}
        ${state.status === "unavailable" ? html`<p class="small muted" data-testid="wizard.res.goal-unavailable">${t("models.goal.unavailable")}</p>` : null}
        ${state.status === "error" ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.res.goal-error">
          <span class="grow">${t("models.goal.failed")} <span data-user-content="">${describeError(state.error, i18n)}</span></span>
          <${Button} size="sm" onClick=${() => setNonce((value) => value + 1)} testid="wizard.res.goal-retry">${t("models.wizard.plan.retry")}<//>
        </div>` : null}
      </div>
      ${state.status === "ready" || (state.status === "loading" && state.data) ? html`<div class="stack-sm" data-testid="wizard.res.plans">
        ${gpuSets.length ? html`<${PlanCards} gpuSets=${gpuSets} value=${applied} onPick=${begin} catalog=${catalog} />` : html`<p class="muted" data-testid="wizard.res.plans-none">${t("models.goal.none")}</p>`}
        ${notes.length ? html`<ul class="small muted plan-notes" data-testid="wizard.res.plan-notes">${notes.map((note, index) => html`<li key=${index} data-user-content="">${i18n.pick(note) || String(note)}</li>`)}</ul>` : null}
      </div>` : null}
    </div>
    <${ConfirmDialog} open=${Boolean(pending) && pending.phase === "engine"} testid="wizard.res.engine-change" tone="default"
      title=${t("models.plan.engineChange.title")}
      body=${planned ? html`<div class="stack-sm">
        <p>${t("models.plan.engineChange.body", { from: draft.runtimeId || draft.engineId, to: planned.runtimeId || planned.engineId })}</p>
        ${unresolved ? html`<p class="field-error" role="alert" data-testid="wizard.res.engine-unresolved">${t("models.plan.engineChange.noManager", { engine: planned.engineId })}</p>` : null}
      </div>` : ""}
      confirmLabel=${t("models.plan.engineChange.confirm")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => {
        if (unresolved) throw new Error(t("models.plan.engineChange.noManager", { engine: planned.engineId }));
      }}
      onClose=${(reason) => setPending((value) => (value && reason === "confirmed" && value.phase === "engine" ? { ...value, phase: "diff" } : null))} />
    <${ConfirmDialog} open=${Boolean(pending) && pending.phase === "diff"} testid="wizard.res.diff" tone="default"
      title=${t("models.plan.diff.title")}
      body=${planned ? html`<div class="stack-sm"><p>${t("models.plan.diff.body")}</p><${DiffTable} rows=${rows} testid="wizard.res.diff-table" /></div>` : ""}
      confirmLabel=${t("models.plan.diff.apply")} cancelLabel=${t("common.cancel")}
      onConfirm=${apply}
      onClose=${() => setPending(null)} />
  <//>`;
}
