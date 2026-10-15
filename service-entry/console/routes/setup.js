// /setup (07 §6.14, CON-25; 06 §8, §11): the first-run wizard.
//
// With the platform backend (`features.setup`) the page lists the ten 06 §8
// steps from GET /api/platform/setup, each with its status, an explanation and
// one primary button. A step POST (POST /api/platform/setup/:step) answers 202
// {opId}; the operation is followed by the System pages' OperationPanel, which
// reads GET /api/platform/operations/:opId and listens to `platform` events.
// The `ops` step never runs anything: it shows the commands to copy. The
// `storage`, `exposure` and `first-model` steps hand off to console pages with
// ?from=setup, which adds the way back (components/setup-return-bar.js).
//
// Before the backend exists the page shows the five-item checklist derived
// from /api/status, /api/fleet, the library and /api/keys, each item linking
// to its page.

import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { CodeBlock } from "../components/code-block.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { ProgressRow } from "../components/progress-row.js";
import { Skeleton } from "../components/skeleton.js";
import { StatusBadge } from "../components/status-badge.js";
import { describeError } from "../lib/api.js";
import { tk } from "../lib/i18n.js";
import {
  buildChecklist, CHECKLIST_ITEMS, DEFAULT_ENGINES, doneRequest, firstModelHref, imagePullJobs, needsSupervisor, normalizeSetup, pullManagers, setupIncomplete,
  setupProgress, SETUP_ENGINES, SETUP_PATH, SETUP_QUERY_KEY, skipAllRequest, skipRequest, stepPlan, stepRequest, stepSettled,
} from "../lib/setup-model.js";
import { useServices } from "../ui/context.js";
import { useFormat, usePref, useQuery, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useFeature } from "../ui/shell.js";
import { useState } from "../ui/vendor.js";
import { OperationPanel } from "./system/operation.js";

const DEFAULT_OPS_COMMANDS = Object.freeze(["platform autostart enable"]);
const TONE = Object.freeze({ done: "ok", todo: "neutral", blocked: "warn", skipped: "neutral", failed: "error" });
const CHECK_TONE = Object.freeze({ ok: "ok", todo: "warn", unknown: "unknown" });

// ---------------------------------------------------------------------------
// The `images` step: the byte progress of the pull jobs the operation starts.

function ManagerPullJobs({ managerId }) {
  const { api } = useServices();
  const { t } = useT();
  const jobs = useQuery(["m", managerId, "jobs"], () => api.manager(managerId).get("/jobs", { query: { fields: "summary" } }), { ttlMs: 2000, refetchMs: 3000 });
  const running = imagePullJobs(jobs.data);
  return html`${running.map((job) => html`<${ProgressRow} key=${job.id} label=${t("platform.setup.pulling", { name: job.label })}
    percent=${job.percent === null && !job.bytesTotal ? null : job.percent ?? undefined} bytesDone=${job.bytesDone ?? undefined} bytesTotal=${job.bytesTotal ?? undefined}
    speedBps=${job.speedBps ?? undefined} testid="setup.pull-job" />`)}`;
}

function PullJobs({ engines }) {
  return html`<div class="stack-sm" data-testid="setup.pull-jobs">${pullManagers(engines).map((managerId) => html`<${ManagerPullJobs} key=${managerId} managerId=${managerId} />`)}</div>`;
}

// ---------------------------------------------------------------------------
// Step bodies

function PrereqBody({ step }) {
  const { t, pick } = useT();
  const blocking = step.data.blocking || [];
  if (!blocking.length) return null;
  return html`<div class="stack-sm" data-testid="setup.blocking">
    <p class="small"><strong>${t("platform.setup.blocking")}</strong></p>
    <ul class="checks">
      ${blocking.map((item) => html`<li key=${item.id} class="check-row stack-sm" data-check=${item.id}>
        <div class="row"><code class="code-inline small">${item.id}</code></div>
        ${item.detail ? html`<p class="small muted" data-user-content>${item.detail}</p>` : null}
        ${item.fix?.command ? html`<${CodeBlock} code=${item.fix.command} testid="setup.blocking-command" />` : null}
        ${item.fix?.docs ? html`<p class="small"><a href=${item.fix.docs}>${t("platform.setup.docs")}</a></p>` : null}
      </li>`)}
    </ul>
  </div>`;
}

function StorageBody({ step }) {
  const { t } = useT();
  const fmt = useFormat();
  return step.data.freeBytes === null || step.data.freeBytes === undefined ? null
    : html`<p class="small muted" data-testid="setup.free">${t("platform.setup.freeSpace", { size: fmt.bytes(step.data.freeBytes) })}</p>`;
}

function ImagesBody({ step, engines, onEngines, running }) {
  const { t } = useT();
  const runtimes = step.data.runtimes || [];
  const toggle = (engine) => onEngines(engines.includes(engine) ? engines.filter((item) => item !== engine) : [...engines, engine]);
  return html`<div class="stack-sm">
    <fieldset class="stack-sm" data-testid="setup.engines">
      <legend class="small">${t("platform.setup.engines")}</legend>
      <div class="row">
        ${SETUP_ENGINES.map((engine) => html`<label key=${engine} class="row-nowrap">
          <input type="checkbox" checked=${engines.includes(engine)} disabled=${running} onChange=${() => toggle(engine)} data-testid=${`setup.engine.${engine}`} />
          <span>${t(tk("platform.setup.engine.", engine))}</span>
        </label>`)}
      </div>
    </fieldset>
    ${runtimes.length ? html`<ul class="strip-list small" data-testid="setup.runtimes">${runtimes.map((runtime) => html`<li key=${runtime.runtimeId}>
      <code class="code-inline">${runtime.runtimeId}</code> ${runtime.present ? t("platform.setup.runtimePresent") : runtime.localBuild ? t("platform.setup.runtimeLocal") : t("platform.setup.runtimeMissing")}</li>`)}</ul>` : null}
  </div>`;
}

function ExposureBody({ step, mode, onMode, running }) {
  const { t } = useT();
  const firewall = step.data.firewall;
  return html`<div class="stack-sm">
    <fieldset class="stack-sm" data-testid="setup.exposure-mode">
      <legend class="small">${t("platform.setup.exposure.label")}</legend>
      ${["local", "lan"].map((value) => html`<label key=${value} class="row-nowrap">
        <input type="radio" name="setup-exposure" value=${value} checked=${mode === value} disabled=${running} onChange=${() => onMode(value)} data-testid=${`setup.exposure.${value}`} />
        <span>${t(tk("platform.setup.exposure.", value))}</span>
      </label>`)}
    </fieldset>
    ${mode === "lan" ? html`<div class="notice notice-warn" role="note" data-testid="setup.exposure-lan">
      <span class="grow">${t("platform.setup.exposure.lanNote")}</span></div>` : null}
    ${mode === "lan" && firewall?.command ? html`<${CodeBlock} code=${firewall.command} testid="setup.firewall-command" />` : null}
    <p class="small"><a href="/access/public?from=setup" data-testid="setup.public-link">${t("platform.setup.exposure.public")}</a></p>
  </div>`;
}

function OpsBody({ step }) {
  const { t } = useT();
  const commands = step.data.commands?.length ? step.data.commands : DEFAULT_OPS_COMMANDS;
  return html`<div class="stack-sm" data-testid="setup.ops-commands">
    <p class="small muted">${t("platform.setup.ops.note")}</p>
    ${commands.map((command) => html`<${CodeBlock} key=${command} code=${command} testid="setup.ops-command" />`)}
  </div>`;
}

// ---------------------------------------------------------------------------
// One step

function StepCard({ step, current, locked, running, onRun, onMark, onSkip }) {
  const { t, pick, has } = useT();
  const { api } = useServices();
  const hubOn = useFeature("hub");
  const plan = stepPlan(step);
  const settled = stepSettled(step);
  const [engines, setEngines] = useState([...DEFAULT_ENGINES]);
  const [mode, setMode] = useState(step.data.mode === "lan" ? "lan" : "local");
  const library = useQuery(["setup", "library"], () => api.get("/api/hub/library", { query: { limit: 20 } }), { ttlMs: 30000, enabled: step.id === "first-model" && hubOn && !settled });
  const title = pick(step.title) || step.id;
  const explain = has(tk("platform.setup.explain.", step.id)) ? t(tk("platform.setup.explain.", step.id)) : "";
  const label = t(tk("platform.setup.action.", step.id));
  const head = html`<div class="row">
    <span class="muted tabular" aria-hidden="true">${step.index}</span>
    <h2 class="card-title grow">${title}</h2>
    ${step.optional ? html`<span class="small muted">${t("platform.setup.optional")}</span>` : null}
    <${StatusBadge} status=${TONE[step.status]} label=${t(tk("platform.setup.status.", step.status))} testid="setup.status" />
  </div>`;

  if (settled) {
    return html`<li class="setup-step setup-step-settled stack-sm" data-step=${step.id} data-status=${step.status} data-testid=${`setup.step.${step.id}`}>${head}</li>`;
  }
  const primaryBusy = running;
  const primary = plan.kind === "link"
    ? html`<${Button} variant="primary" href=${step.id === "first-model" ? firstModelHref(library.data?.entries) : plan.href} testid=${`setup.primary.${step.id}`}>${label}<//>`
    : html`<${Button} variant="primary" busy=${primaryBusy} disabled=${locked && !primaryBusy}
        onClick=${() => (plan.kind === "mark" ? onMark(step.id) : onRun(step.id, { engines, mode }))} testid=${`setup.primary.${step.id}`}>${label}<//>`;
  return html`<li class="setup-step stack-sm" data-step=${step.id} data-status=${step.status} data-current=${current ? "true" : "false"}
    aria-current=${current ? "step" : undefined} data-testid=${`setup.step.${step.id}`}>
    ${head}
    ${explain ? html`<p class="small">${explain}</p>` : null}
    ${step.detail ? html`<p class="small muted" data-user-content data-testid="setup.detail">${step.detail}</p>` : null}
    ${step.id === "prereq" ? html`<${PrereqBody} step=${step} />` : null}
    ${step.id === "storage" ? html`<${StorageBody} step=${step} />` : null}
    ${step.id === "images" ? html`<${ImagesBody} step=${step} engines=${engines} onEngines=${setEngines} running=${running} />` : null}
    ${step.id === "exposure" ? html`<${ExposureBody} step=${step} mode=${mode} onMode=${setMode} running=${running} />` : null}
    ${step.id === "ops" ? html`<${OpsBody} step=${step} />` : null}
    ${step.id === "first-model" && hubOn && library.data && !library.data.entries?.length ? html`<p class="small muted">${t("platform.setup.firstModel.none")}</p>` : null}
    ${running && step.id === "images" ? html`<${PullJobs} engines=${engines} />` : null}
    <div class="row" data-testid="setup.actions">
      ${primary}
      ${plan.kind === "link" ? html`<${Button} variant="ghost" size="sm" disabled=${locked} onClick=${() => onMark(step.id)} testid=${`setup.done.${step.id}`}>${t("platform.setup.markDone")}<//>` : null}
      <${Button} variant="ghost" size="sm" disabled=${locked} onClick=${() => onSkip(step.id)} testid=${`setup.skip.${step.id}`}>${t("platform.setup.skipStep")}<//>
    </div>
  </li>`;
}

// ---------------------------------------------------------------------------
// The wizard

function Wizard({ query: setupQuery, setup }) {
  const services = useServices();
  const { api, cache, router, toasts } = services;
  const i18n = useT();
  const { t } = i18n;
  const [, setDismissed] = usePref("dismissedSetup");
  const [activeOp, setActiveOp] = useState(null);
  const [error, setError] = useState(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const progress = setupProgress(setup);
  const incomplete = setupIncomplete(setup);

  function refresh() {
    cache.invalidate(SETUP_QUERY_KEY);
  }

  async function post(request, label, stepId) {
    setError(null);
    try {
      const answer = await api.post(request.path, request.body);
      if (answer?.opId) setActiveOp({ opId: answer.opId, label, stepId });
      else refresh();
    } catch (failure) {
      setError({ failure, stepId });
    }
  }

  const stepLabel = (id) => t(tk("platform.setup.action.", id));
  const run = (id, options) => post(stepRequest(id, options), stepLabel(id), id);
  const mark = (id) => post(doneRequest(id), t("platform.setup.markDone"), id);
  const skip = (id) => post(skipRequest(id), t("platform.setup.skipStep"), id);

  function later() {
    setDismissed(true);
    toasts?.push?.({ level: "info", title: t("platform.setup.laterToast") });
    router.navigate("/overview");
  }

  async function skipAll() {
    const request = skipAllRequest();
    const answer = await api.post(request.path, request.body);
    if (answer?.opId) setActiveOp({ opId: answer.opId, label: t("platform.setup.skipAll"), stepId: "all" });
    else refresh();
  }

  function finished(op) {
    refresh();
    if (op.state === "ok") setActiveOp(null);
  }

  const running = activeOp !== null;
  const current = setup.current;
  return html`<div class="stack" data-testid="setup.root" data-complete=${incomplete ? "false" : "true"}>
    <${PageHeader} title=${t("platform.setup.title")} subtitle=${t("platform.setup.subtitle")}
      actions=${incomplete ? html`<${Button} onClick=${later} testid="setup.later">${t("platform.setup.later")}<//>
        <${Button} variant="ghost" onClick=${() => setConfirmSkip(true)} testid="setup.skip-all">${t("platform.setup.skipAll")}<//>` : null} />
    ${incomplete
      ? html`<p class="small muted" role="status" data-testid="setup.progress">${t("platform.setup.progress", { done: progress.settled, total: progress.total })}</p>`
      : html`<div class="notice notice-success" role="status" data-testid="setup.complete">
        <span class="grow">${t("platform.setup.complete")}</span>
        <${Button} size="sm" href="/overview" testid="setup.complete-link">${t("platform.setup.openOverview")}<//>
      </div>`}
    ${activeOp ? html`<${OperationPanel} opId=${activeOp.opId} label=${activeOp.label} onDone=${finished} onDismiss=${() => setActiveOp(null)} testid="setup.operation" />` : null}
    ${error ? html`<div class="notice notice-danger" role="alert" data-testid="setup.error">
      <span class="grow">${describeError(error.failure, i18n)}${needsSupervisor(error.failure) ? html` ${t("platform.setup.needSupervisor")}` : null}</span>
      ${needsSupervisor(error.failure) ? html`<${Button} size="sm" href="/system" testid="setup.error-system">${t("platform.setup.openSystem")}<//>` : null}
      <${Button} size="sm" variant="ghost" onClick=${() => setError(null)} testid="setup.error-dismiss">${t("platform.operation.dismiss")}<//>
    </div>` : null}
    <ol class="setup-steps" aria-label=${t("platform.setup.steps")} data-testid="setup.steps">
      ${setup.steps.map((step) => html`<${StepCard} key=${step.id} step=${step} current=${step.id === current}
        locked=${running} running=${running && activeOp.stepId === step.id} onRun=${run} onMark=${mark} onSkip=${skip} />`)}
    </ol>
    <${ConfirmDialog} open=${confirmSkip} title=${t("platform.setup.skipAll.title")} body=${t("platform.setup.skipAll.body")} confirmLabel=${t("platform.setup.skipAll")}
      onConfirm=${skipAll} onClose=${() => setConfirmSkip(false)} testid="setup.skip-all-dialog" />
  </div>`;
}

// ---------------------------------------------------------------------------
// Before 06: the checklist

function Checklist() {
  const { api, router, toasts } = useServices();
  const { t } = useT();
  const [, setDismissed] = usePref("dismissedSetup");
  const status = useQuery(["status"], () => api.get("/api/status"), { ttlMs: 15000 });
  const fleet = useQuery(["fleet"], () => api.get("/api/fleet"), { ttlMs: 15000 });
  const hubOn = useFeature("hub");
  const library = useQuery(["setup", "library"], () => api.get("/api/hub/library", { query: { limit: 1 } }), { ttlMs: 30000, enabled: hubOn });
  const keys = useQuery(["legacy", "keys"], () => api.get("/api/keys"), { ttlMs: 30000 });
  const loading = [status, fleet, keys].some((query) => query.data === undefined && query.status !== "error");
  const items = buildChecklist({ status: status.data, fleet: fleet.data, library: hubOn ? library.data : null, keys: keys.data });

  return html`<div class="stack" data-testid="setup.checklist-root">
    <${PageHeader} title=${t("platform.setup.title")} subtitle=${t("platform.setup.checklist.subtitle")}
      actions=${html`<${Button} onClick=${() => {
        setDismissed(true);
        toasts?.push?.({ level: "info", title: t("platform.setup.laterToast") });
        router.navigate("/overview");
      }} testid="setup.later">${t("platform.setup.later")}<//>`} />
    <div class="notice" role="note" data-testid="setup.checklist-note"><span class="grow">${t("platform.setup.checklist.note")}</span></div>
    ${loading ? html`<${Skeleton} shape="table" rows=${5} />` : html`<ul class="checks" data-testid="setup.checklist">
      ${items.map((item) => html`<li key=${item.id} class="check-row row" data-check=${item.id} data-state=${item.state} data-testid=${`setup.check.${item.id}`}>
        <${StatusBadge} status=${CHECK_TONE[item.state]} label=${t(tk("platform.setup.check.state.", item.state))} />
        <span class="grow"><strong>${t(tk("platform.setup.check.", item.id))}</strong><br /><span class="small muted">${t(tk("platform.setup.checkHint.", item.id))}</span></span>
        ${item.state === "ok" ? null : html`<${Button} size="sm" href=${item.href} testid=${`setup.check-link.${item.id}`}>${t("platform.setup.checkOpen")}<//>`}
      </li>`)}
    </ul>`}
  </div>`;
}

// ---------------------------------------------------------------------------

export default function Setup({ query }) {
  const { api } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const setupOn = useFeature("setup");
  const setup = useQuery(SETUP_QUERY_KEY, () => api.get(SETUP_PATH), { ttlMs: 5000, enabled: setupOn });
  const missing = setup.error?.status === 501 || setup.error?.code === "setup_unavailable" || setup.error?.code === "endpoint_unavailable";

  if (!setupOn || (missing && setup.data === undefined)) return html`<${Checklist} />`;
  if (setup.data === undefined && setup.status !== "error") {
    return html`<div class="stack" data-testid="setup.root" aria-busy="true"><${PageHeader} title=${t("platform.setup.title")} /><${Skeleton} shape="table" rows=${6} /></div>`;
  }
  if (setup.data === undefined) {
    return html`<div class="stack" data-testid="setup.root"><${PageHeader} title=${t("platform.setup.title")} />
      <${EmptyState} icon="circle-x" level=${2} title=${t("platform.setup.error.title")} body=${describeError(setup.error, i18n)}
        action=${{ label: t("shell.conn.retry"), onClick: () => setup.refetch() }} testid="setup.load-error" /></div>`;
  }
  return html`<${Wizard} query=${query} setup=${normalizeSetup(setup.data)} />`;
}
