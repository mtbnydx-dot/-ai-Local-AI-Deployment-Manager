// The dry probe of a model on this machine (07 §6.3 step 2, 02 §18 R-UI-9),
// shared by the wizard's Engine step and the model detail page's
// Compatibility tab: ProbeJob follows one probe through the manager's `jobs`
// events, and RemoteCodeBody is the consent text for a model that ships its
// own Python code.

import { findJob, jobView } from "../../lib/engines-model.js";
import { remoteCodeFiles } from "../../components/model-card.js";
import { ProgressRow } from "../../components/progress-row.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef } from "../../ui/vendor.js";

const SAFETY_REFRESH_MS = 5000;

// Follows one probe through the same cache key the entry's `jobs` events merge into; a slow refetch is the safety net.
export function ProbeJob({ managerId, jobId, engineLabel, onDone }) {
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

export function RemoteCodeBody({ card }) {
  const { t } = useT();
  const files = remoteCodeFiles(card);
  return html`<div class="stack-sm" data-testid="wizard.remote-code">
    <p>${t("models.remoteCode.confirm", { files: files.length ? files.join(", ") : t("models.card.customCodeYes") })}</p>
    <ul class="stack-sm" data-testid="wizard.remote-code.files">${files.map((file) => html`<li key=${file}><code class="code-inline" data-user-content="">${file}</code></li>`)}</ul>
  </div>`;
}
