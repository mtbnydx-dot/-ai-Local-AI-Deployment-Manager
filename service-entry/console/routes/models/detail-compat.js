// The Compatibility tab of the model detail page (07 §6.4, 02 §9 and §18):
// the CompatMatrix of GET /api/models/:id/compatibility. A row whose verdict
// is `unknown` is grey and offers the dry probe and Override, and `ok` is shown
// only with evidence (R-UI-2); the probe asks for consent first when the model
// ships its own Python code (R-UI-9). Select and Override open the deployment
// wizard with the engine chosen, where the warnings are. A repository that is
// not on disk cannot be probed (the probe never downloads).

import { describeError } from "../../lib/api.js";
import { engineIndex, viewRows } from "../../lib/compat-model.js";
import { EnginesResponseGuard } from "../../lib/schemas.js";
import { CompatMatrix } from "../../components/compat-matrix.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { needsRemoteCode } from "../../components/model-card.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { compatKey, loadCompatibility } from "../deploy-wizard/card-source.js";
import { guards } from "../deploy-wizard/guards.js";
import { ProbeJob, RemoteCodeBody } from "../deploy-wizard/probe-job.js";
import { Failure } from "./detail-failure.js";

const enc = encodeURIComponent;

/** @param card the full ModelCard  @param remote true for a repository  @param path the folder, for the wizard link */
export function CompatTab({ card, remote, path }) {
  const { api, cache, toasts, router, i18n } = useServices();
  const { t, pick } = useT();
  const cardId = card?.cardId || "";
  const engines = useQuery(["engines"], () => api.get("/api/engines", { guard: EnginesResponseGuard }), { ttlMs: 10000 });
  const index = useMemo(() => engineIndex(engines.data), [engines.data]);
  const compat = useQuery(compatKey(cardId, []), () => loadCompatibility(api, cardId, []), { ttlMs: 10000, enabled: Boolean(cardId) });
  const [jobs, setJobs] = useState({});
  const [starting, setStarting] = useState({});
  const [consent, setConsent] = useState(null);
  const views = useMemo(() => viewRows(compat.data?.rows, index), [compat.data, index]);

  const labelOf = (view) => pick(view.label) || view.engineId;
  function deploy(view) {
    const href = `/deployments/new?model=${enc(path)}&engine=${enc(view.engineId)}${view.managerId ? `&manager=${enc(view.managerId)}` : ""}`;
    router?.navigate?.(href);
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
    if (remote) toasts?.push?.({ level: "warn", title: t("hub.detail.probeNeedsLocal") });
    else if (card && needsRemoteCode(card)) setConsent(view);
    else startProbe(view, false);
  }

  if (!cardId) return html`<p class="muted" data-testid="detail.compat.nocard">${t("hub.detail.noCard")}</p>`;
  return html`<div class="stack" data-testid="detail.compat">
    <p class="small muted">${t("hub.detail.compat.lead")}</p>
    ${remote ? html`<p class="notice" data-testid="detail.compat.remote">${t("hub.detail.compat.remote")}</p>` : null}
    ${compat.error && !compat.data ? html`<${Failure} error=${compat.error} onRetry=${() => compat.refetch()} testid="detail.compat.error" />` : null}
    ${!compat.data && !compat.error ? html`<div aria-busy="true"><${Skeleton} shape="line" rows=${4} /></div>` : null}
    ${compat.data && !views.length ? html`<p class="muted" data-testid="detail.compat.none">${t("hub.detail.compat.none")}</p>` : null}
    ${views.length ? html`<${CompatMatrix} rows=${compat.data.rows} engines=${index} probing=${starting}
      onSelect=${remote ? undefined : deploy} onProbe=${onProbe} onOverride=${remote ? undefined : deploy} />` : null}
    ${Object.values(jobs).map((job) => html`<${ProbeJob} key=${job.jobId} managerId=${job.managerId} jobId=${job.jobId} engineLabel=${job.label}
      onDone=${() => {
        cache.invalidate(["models", "compat"]);
        compat.refetch();
      }} />`)}
    <${ConfirmDialog} open=${Boolean(consent)} tone="danger" testid="detail.compat.consent" title=${t("models.wizard.engine.remoteCodeTitle")}
      body=${html`<${RemoteCodeBody} card=${card} />`} confirmLabel=${t("models.wizard.engine.remoteCodeRun")}
      onConfirm=${() => startProbe(consent, true)} onClose=${() => setConsent(null)} />
  </div>`;
}
