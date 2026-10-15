// Wizard step 7, "Launch" (07 §6.3): follows the launch job the Review step
// started, from the entry's `jobs` events (a slow refetch is the safety net).
//
//   Stepper   the 00 §4.1 phases pull → admission → container → weights → kv → graphs → api →
//             probe → ready, each with its duration (job.lifecycle.phaseHistory). `pull` is
//             skipped when the image was present. The live detail line is the job's
//             progress.stageKey when it names a phase, else the server's bilingual stageText.
//   Log tail  the job's LogViewer
//   Failure   the job error object in a RootCausePanel; the signature behind it is looked up
//             once from GET /api/knowledge?kind=error-signatures. A suggestion changes the
//             draft and goes back to Review with a DiffTable. Nothing relaunches by itself.
//   Success   Open in Playground, Copy endpoint, View deployment, Qualify this deployment
//   Notice    a plan that changed at launch (a manager before ENG-2 does not refuse it)

import { jobFailure, jobPhases, jobState, knobsOf, runtimesHref, stageDetail, startOverrideRows, successLinks } from "../../lib/launch-model.js";
import { findJob } from "../../lib/engines-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { copyText } from "../../components/code-block.js";
import { DiffTable } from "../../components/diff-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { LogViewer } from "../../components/log-viewer.js";
import { ProgressRow } from "../../components/progress-row.js";
import { RootCausePanel } from "../../components/root-cause-panel.js";
import { Stepper } from "../../components/stepper.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import { useFailureActions, useSignature } from "./failure-actions.js";

const SAFETY_REFRESH_MS = 5000;
const GATEWAY_FALLBACK = "/gateway/auto/openai/v1";

const plain = (entry) => (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "value") ? entry.value : entry);

// The job, kept current by the same cache key the entry's `jobs` events merge into.
function useLaunchJob(managerId, jobId) {
  const services = useServices();
  const { api } = services;
  const jobs = useQuery(["m", managerId, "jobs"], () => api.manager(managerId).get("/jobs", { query: { fields: "summary" } }), { ttlMs: 2000, enabled: Boolean(managerId) });
  const refetch = useRef(jobs.refetch);
  refetch.current = jobs.refetch;
  const job = findJob(jobs.data, jobId);
  const state = job ? jobState(job) : "running";
  useEffect(() => {
    refetch.current();
  }, [jobId]);
  useEffect(() => {
    if (state !== "running") return undefined;
    const timer = globalThis.setInterval(() => {
      if (!services.visibility?.hidden?.()) refetch.current();
    }, SAFETY_REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [state]);
  return { job, state };
}

function PhaseStepper({ job, started }) {
  const { t, tk, pick } = useT();
  const phases = jobPhases(job, { pullStep: started.pull });
  const detail = stageDetail(job);
  const steps = phases.map((phase) => ({
    id: phase.id,
    label: t(tk("engines.phase.", phase.id)),
    state: phase.state,
    durationMs: phase.durationMs ?? undefined,
    detail: phase.state === "active" ? (detail.phaseKey ? t(tk("engines.phase.", detail.phaseKey)) : pick(detail.text) || undefined) : undefined,
  }));
  return html`<div data-testid="wizard.launch.phases">
    <${Stepper} steps=${steps.map((step) => ({ ...step, label: html`<span data-testid=${`wizard.phase.${step.id}`} data-phase=${step.id} data-state=${step.state}>${step.label}</span>` }))} orientation="vertical" label=${t("models.wizard.launch.phases")} testid="wizard.launch.stepper" />
  </div>`;
}

function PullProgress({ job, started }) {
  const { t } = useT();
  const active = jobPhases(job, { pullStep: started.pull }).find((phase) => phase.id === "pull");
  if (!active || active.state !== "active" || !started.pull?.required) return null;
  const percent = Number(job?.progress?.percent);
  return html`<${ProgressRow} label=${t("engines.job.pull.stage", { image: started.pull.image || "", percent: Number.isFinite(percent) ? Math.round(percent) : "…" })} percent=${Number.isFinite(percent) ? percent : null} testid="wizard.launch.pull" />`;
}

function Success({ draft, plan, started }) {
  const { toasts, bootstrap, i18n } = useServices();
  const { t } = i18n;
  const links = successLinks({
    managerId: started.managerId,
    instanceId: started.instanceId,
    servedName: draft.instance.servedName || plain(plan.plan?.values?.servedName) || "",
    modelName: draft.modelRef?.path ? draft.modelRef.path.split(/[\\/]/).filter(Boolean).pop() : draft.modelRef?.repo,
  });
  async function copyEndpoint() {
    const path = bootstrap?.gateway?.autoOpenAi || GATEWAY_FALLBACK;
    const ok = await copyText(`${globalThis.location.origin}${path}`);
    toasts?.push?.({ level: ok ? "success" : "warn", title: t(ok ? "models.wizard.launch.copied" : "common.copyFailed") });
  }
  return html`<${Card} title=${t("models.wizard.launch.ready")} testid="wizard.launch.success">
    <div class="stack-sm">
      <p>${t("models.wizard.launch.readyBody")}</p>
      <div class="row">
        <${Button} variant="primary" href=${links.playground} testid="wizard.launch.playground">${t("models.wizard.launch.playground")}<//>
        <${Button} onClick=${copyEndpoint} testid="wizard.launch.copy">${t("models.wizard.launch.copyEndpoint")}<//>
        <${Button} href=${links.deployment} testid="wizard.launch.view">${t("models.wizard.launch.view")}<//>
        <${Button} href=${links.qualify} testid="wizard.launch.qualify">${t("models.wizard.launch.qualify")}<//>
      </div>
    </div>
  <//>`;
}

export default function StepLaunch({ draft, update, plan, catalog, launch, goto }) {
  const { t, locale } = useT();
  const started = launch.state;
  const live = started.status === "started";
  const { job, state } = useLaunchJob(live ? started.managerId : "", live ? started.jobId : "");
  const failure = state === "failed" ? jobFailure(job) : null;
  const signature = useSignature(failure, state === "failed");
  const [showDiff, setShowDiff] = useState(false);
  const actions = useFailureActions({ draft, plan, catalog, update, launch, goto });
  useEffect(() => {
    if (live && job) launch.report(state);
  }, [live, state, Boolean(job)]);
  if (!live) {
    return html`<${EmptyState} testid="wizard.step.launch" icon="info" title=${t("models.wizard.launch.none")} body=${t("models.wizard.launch.noneBody")}
      action=${{ label: t("models.wizard.step.review"), onClick: () => goto("review") }} />`;
  }

  const knobs = knobsOf(failure, job, job?.meta?.errorDetails);
  const overrides = startOverrideRows(started, catalog, locale);
  return html`<div class="stack" data-testid="wizard.step.launch" data-state=${state} data-job=${started.jobId}>
    ${started.changedAtLaunch ? html`<div class="notice notice-info stack-sm" role="status" data-testid="wizard.launch.changed">
      <div class="row"><span class="grow">${t("models.wizard.launch.changed")}</span>
        <${Button} size="sm" variant="ghost" onClick=${() => setShowDiff(!showDiff)} testid="wizard.launch.changed-toggle">${t("models.wizard.launch.changedView")}<//></div>
      ${showDiff ? (overrides.length ? html`<${DiffTable} rows=${overrides} caption=${t("models.wizard.launch.changed.caption")} testid="wizard.launch.changed-diff" />` : html`<p class="small" data-testid="wizard.launch.changed-none">${t("models.wizard.review.changedNone")}</p>`) : null}
    </div>` : null}
    ${actions.notice ? html`<div class="notice notice-warn" role="status" data-testid="wizard.launch.notice"><span class="grow" data-user-content="">${actions.notice}</span></div>` : null}
    <${Card} title=${t("models.wizard.launch.progress")} testid="wizard.launch.progress">
      <div class="stack-sm">
        ${job ? html`<${PhaseStepper} job=${job} started=${started} />` : html`<p class="muted" data-testid="wizard.launch.starting">${t("models.wizard.launch.starting")}</p>`}
        ${job ? html`<${PullProgress} job=${job} started=${started} />` : null}
      </div>
    <//>
    ${failure ? html`<${RootCausePanel} error=${failure} signature=${signature} catalog=${catalog} knobs=${knobs} testid="wizard.launch.failure"
      onApply=${actions.applyParam} onKnob=${actions.applyKnob} onProbe=${() => {
        launch.reset(null);
        goto("engine");
      }} runtimeHref=${runtimesHref(draft.engineId)} />` : null}
    ${state === "success" ? html`<${Success} draft=${draft} plan=${plan} started=${started} />` : null}
    <${Card} title=${t("models.wizard.launch.log")} testid="wizard.launch.log">
      <${LogViewer} source=${{ kind: "job", managerId: started.managerId, id: started.jobId }} label=${t("models.wizard.launch.log")} testid="wizard.launch.logviewer" pollMs=${state === "running" ? 2000 : 60000} />
    <//>
    ${state !== "running" ? html`<div class="row"><${Button} onClick=${() => {
      launch.reset(null);
      goto("review");
    }} testid="wizard.launch.back">${t("models.wizard.launch.backToReview")}<//></div>` : null}
  </div>`;
}
