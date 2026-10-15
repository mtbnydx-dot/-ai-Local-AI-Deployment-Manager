// Wizard step 2, "Engine" (07 §6.3, 02 §18 steps 3 and 5): which engine and
// runtime runs this model.
//
// The CompatMatrix comes from GET /api/models/:id/compatibility (for the
// chosen GPUs, all when none) and the engines from GET /api/engines. Picking a
// row sets engineId, runtimeId and managerId (the recipe stays automatic, 01
// §10.3, unless a quick path named one). A blocked row is disabled with its
// reason. An unknown row is grey and offers the dry probe and Override; the
// override, like an experimental engine, is chosen after a warning (an
// experimental engine also adds acknowledge "experimental-engine", 01 §11).
// The probe is a manager job followed through `jobs` events; when it ends the
// matrix is read again. A model that ships its own Python code asks for
// consent before a probe may run it, listing the auto_map files (R-UI-9).

import { describeError } from "../../lib/api.js";
import { engineIndex, recommendedKey, viewRows, whyReasons } from "../../lib/compat-model.js";
import { findJob, jobView } from "../../lib/engines-model.js";
import { EnginesResponseGuard } from "../../lib/schemas.js";
import { inspectRequest, patchDraft } from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CompatMatrix } from "../../components/compat-matrix.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { needsRemoteCode, remoteCodeFiles } from "../../components/model-card.js";
import { ProgressRow } from "../../components/progress-row.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useRef, useState } from "../../ui/vendor.js";
import { compatKey, loadCompatibility, useCard } from "./card-source.js";
import { guards } from "./guards.js";

const enc = encodeURIComponent;
const SAFETY_REFRESH_MS = 5000;
const EXPERIMENTAL_ACK = "experimental-engine";

// ---- a probe job ---------------------------------------------------------------------------

// Follows one probe through the same cache key the entry's `jobs` events merge into; a slow refetch is the safety net.
function ProbeJob({ managerId, jobId, engineLabel, onDone }) {
  const services = useServices();
  const { api } = services;
  const { t } = useT();
  const jobs = useQuery(["m", managerId, "jobs"], () => api.manager(managerId).get("/jobs", { query: { fields: "summary" } }), { ttlMs: 2000 });
  const refetch = useRef(jobs.refetch);
  refetch.current = jobs.refetch;
  const view = jobView(findJob(jobs.data, jobId));
  const reported = useRef(false);
  useEffect(() => {
    refetch.current();
  }, [jobId]);
  useEffect(() => {
    if (view?.done) return undefined;
    const timer = globalThis.setInterval(() => {
      if (!services.visibility?.hidden?.()) refetch.current();
    }, SAFETY_REFRESH_MS);
    return () => globalThis.clearInterval(timer);
  }, [Boolean(view?.done)]);
  useEffect(() => {
    if (!view?.done || reported.current) return;
    reported.current = true;
    onDone(view);
  }, [view?.state]);
  if (view?.state === "success") {
    return html`<div class="notice notice-success" role="status" data-testid="wizard.probe" data-state="success">${t("models.wizard.engine.probeDone", { engine: engineLabel })}</div>`;
  }
  if (view?.state === "failed") {
    return html`<div class="notice notice-danger" role="alert" data-testid="wizard.probe" data-state="failed">
      ${t("models.wizard.engine.probeFailed", { engine: engineLabel })} <span data-user-content="" data-testid="wizard.probe.error">${view.error}</span>
    </div>`;
  }
  return html`<div data-testid="wizard.probe" data-state=${view?.state || "starting"}>
    <${ProgressRow} label=${t("models.wizard.engine.probing", { engine: engineLabel })} percent=${view ? view.percent : null} testid="wizard.probe.progress" />
  </div>`;
}

// ---- the page ------------------------------------------------------------------------------

function RemoteCodeBody({ card }) {
  const { t } = useT();
  const files = remoteCodeFiles(card);
  return html`<div class="stack-sm" data-testid="wizard.remote-code">
    <p>${t("models.remoteCode.confirm", { files: files.length ? files.join(", ") : t("models.card.customCodeYes") })}</p>
    <ul class="stack-sm" data-testid="wizard.remote-code.files">${files.map((file) => html`<li key=${file}><code class="code-inline" data-user-content="">${file}</code></li>`)}</ul>
  </div>`;
}

export default function StepEngine({ draft, update }) {
  const services = useServices();
  const { api, cache, toasts, i18n } = services;
  const { t, pick, tk } = useT();
  const ref = draft.modelRef;
  const { card, loading: cardLoading, error: cardError, refetch: refetchCard } = useCard(ref);
  const cardId = card?.cardId || ref?.cardId || "";
  const engines = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000 });
  const index = useMemo(() => engineIndex(engines.data), [engines.data]);
  const compat = useQuery(compatKey(cardId, draft.gpus), () => loadCompatibility(api, cardId, draft.gpus), { ttlMs: 10000, enabled: Boolean(cardId) });
  const [jobs, setJobs] = useState({});
  const [starting, setStarting] = useState({});
  const [consent, setConsent] = useState(null);
  const [warn, setWarn] = useState(null);

  // The card cache can be cleared while the page is open: inspect again, then read the matrix again.
  const reinspected = useRef("");
  useEffect(() => {
    if (compat.error?.code !== "card_not_found" || !ref || reinspected.current === cardId) return;
    reinspected.current = cardId;
    api.post("/api/models/inspect", inspectRequest(ref)).then(() => compat.refetch(), () => undefined);
  }, [compat.error?.code, cardId]);

  const views = useMemo(() => viewRows(compat.data?.rows, index), [compat.data, index]);
  const recommended = recommendedKey(views);
  const shown = views.find((view) => view.key === recommended) || null;
  const selectedView = views.find((view) => view.engineId === draft.engineId && view.runtimeId === draft.runtimeId) || null;
  const why = selectedView && selectedView.selectable ? selectedView : shown;

  function labelOf(view) {
    return pick(view.label) || view.engineId;
  }
  function apply(view) {
    update((current) => {
      let next = patchDraft(current, {
        engineId: view.engineId,
        managerId: view.managerId,
        runtimeId: view.runtimeId,
        recipeId: current.engineId === view.engineId ? current.recipeId : "",
      });
      const rest = next.acknowledge.filter((item) => item !== EXPERIMENTAL_ACK);
      next = patchDraft(next, { acknowledge: view.experimental ? [...rest, EXPERIMENTAL_ACK] : rest });
      return next;
    });
  }
  function onSelect(view) {
    if (view.experimental && !draft.acknowledge.includes(EXPERIMENTAL_ACK)) setWarn({ view, kind: "experimental" });
    else apply(view);
  }
  function onOverride(view) {
    setWarn({ view, kind: view.verdict === "unknown" ? "unknown" : "experimental" });
  }

  async function startProbe(view, allowRemoteCode) {
    setStarting((current) => ({ ...current, [view.key]: true }));
    try {
      const body = { engineId: view.engineId, ...(view.runtimeId ? { runtimeId: view.runtimeId } : {}), allowRemoteCode };
      const result = await api.post(`/api/models/${enc(cardId)}/probe`, body, { guard: guards.probe });
      setJobs((current) => ({ ...current, [view.key]: { jobId: result.jobId, managerId: result.managerId || view.managerId, label: labelOf(view) } }));
    } catch (error) {
      toasts?.push?.({ level: "error", title: describeError(error, i18n) });
    } finally {
      setStarting((current) => ({ ...current, [view.key]: false }));
    }
  }
  function onProbe(view) {
    if (card && needsRemoteCode(card)) setConsent(view);
    else startProbe(view, false);
  }
  function probeDone(key) {
    cache.invalidate(["models", "compat"]);
    compat.refetch();
    setJobs((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  if (!ref) {
    return html`<${EmptyState} testid="wizard.step.engine" icon="info" title=${t("models.wizard.engine.noModel")} action=${{ label: t("models.wizard.step.model"), href: "/deployments/new?step=model" }} />`;
  }
  const loadingMatrix = cardLoading || (Boolean(cardId) && !compat.data && !compat.error) || (engines.data === undefined && !engines.error);
  return html`<div class="stack" data-testid="wizard.step.engine">
    <${Card} title=${t("models.wizard.engine.title")} testid="wizard.engine.matrix">
      <p class="small muted">${t("models.wizard.engine.lead")} ${draft.gpus.length ? t("models.wizard.engine.forGpus", { gpus: draft.gpus.join(", ") }) : t("models.wizard.engine.forAllGpus")}</p>
      ${cardError ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.engine.card-error">
        <span class="grow" data-user-content="">${describeError(cardError, i18n)}</span>
        <${Button} size="sm" onClick=${() => refetchCard()}>${t("models.wizard.plan.retry")}<//>
      </div>` : null}
      ${engines.error && !engines.data ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.engine.engines-error">
        <span class="grow">${t("models.wizard.engine.enginesFailed")}</span>
        <${Button} size="sm" onClick=${() => engines.refetch()}>${t("models.wizard.plan.retry")}<//>
      </div>` : null}
      ${compat.error && !compat.data ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.engine.error">
        <span class="grow" data-user-content="">${describeError(compat.error, i18n)}</span>
        <${Button} size="sm" onClick=${() => compat.refetch()} testid="wizard.engine.retry">${t("models.wizard.plan.retry")}<//>
      </div>` : null}
      ${loadingMatrix && !cardError && !compat.error ? html`<div aria-busy="true" data-testid="wizard.engine.loading"><${Skeleton} shape="line" rows=${4} /></div>` : null}
      ${compat.data && !views.length ? html`<p class="muted" data-testid="wizard.engine.none">${t("models.wizard.engine.none")}</p>` : null}
      ${views.length ? html`<${CompatMatrix} rows=${compat.data.rows} engines=${index}
        selected=${draft.engineId ? { engineId: draft.engineId, runtimeId: draft.runtimeId } : null} probing=${starting}
        onSelect=${onSelect} onProbe=${onProbe} onOverride=${onOverride} />` : null}
      ${Object.entries(jobs).map(([key, job]) => html`<${ProbeJob} key=${job.jobId} managerId=${job.managerId} jobId=${job.jobId} engineLabel=${job.label} onDone=${() => probeDone(key)} />`)}
    <//>
    ${views.length ? html`<details class="compat-why" data-testid="wizard.engine.why">
      <summary>${t("models.wizard.engine.why")}</summary>
      ${why ? html`<div class="stack-sm">
        <p><strong>${labelOf(why)}</strong> <span class="mono small muted">${why.runtimeId}</span></p>
        <ul>${whyReasons(why).map((key) => html`<li key=${key}>${t(tk("models.wizard.engine.why.", key))}</li>`)}</ul>
      </div>` : html`<p class="muted">${t("models.wizard.engine.whyNone")}</p>`}
    </details>` : null}

    <${ConfirmDialog} open=${Boolean(warn)} tone="default" testid="wizard.engine.warn"
      title=${warn?.kind === "unknown" ? t("models.wizard.engine.overrideTitle") : t("models.wizard.engine.experimentalTitle")}
      body=${warn?.kind === "unknown" ? t("models.verdict.unknownHint") : t("models.wizard.engine.experimentalBody")}
      confirmLabel=${t("models.wizard.engine.useAnyway")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => {
        apply(warn.view);
      }}
      onClose=${() => setWarn(null)} />
    <${ConfirmDialog} open=${Boolean(consent)} tone="danger" testid="wizard.engine.consent"
      title=${t("models.wizard.engine.remoteCodeTitle")} body=${html`<${RemoteCodeBody} card=${card} />`}
      confirmLabel=${t("models.wizard.engine.remoteCodeRun")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => startProbe(consent, true)}
      onClose=${() => setConsent(null)} />
  </div>`;
}
