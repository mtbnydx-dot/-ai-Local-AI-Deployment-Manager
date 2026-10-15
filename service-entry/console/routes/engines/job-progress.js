// Follows one manager job (an `introspect` or an `image-pull` job, 07 §6.5).
//
// The list is the same cache key the entry's `jobs` events merge into
// (["m", managerId, "jobs"], 07 §3.6), so progress arrives with no refetch. A
// slow refetch (every 5 s, paused while the tab is hidden) is only a safety net
// for an event that never comes, and stops when the job ends. When the job ends,
// every engines query is invalidated so the page shows the new state (image
// present, runtime introspected, fresh flags).

import { findJob, jobView } from "../../lib/engines-model.js";
import { Button } from "../../components/button.js";
import { ProgressRow } from "../../components/progress-row.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { useServices } from "../../ui/context.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef } from "../../ui/vendor.js";

const SAFETY_REFRESH_MS = 5000;

// kind: "introspect" | "pull"; `name` is the runtime id or the image the label names.
export function JobProgress({ managerId, jobId, kind, name, onFinished, onDismiss, testid }) {
  const services = useServices();
  const { api, cache } = services;
  const { t } = useT();
  const jobs = useQuery(["m", managerId, "jobs"], () => api.manager(managerId).get("/jobs", { query: { fields: "summary" } }), { ttlMs: 2000 });
  const refetch = useRef(jobs.refetch);
  refetch.current = jobs.refetch;
  const view = jobView(findJob(jobs.data, jobId));
  const reported = useRef(false);
  // A list cached before the job was created cannot hold it: read it again once.
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
    cache.invalidate(["engines"]);
    onFinished?.(view);
  }, [view?.state]);

  const root = testid || `engine-job.${kind}`;
  if (view?.state === "success") {
    return html`<div class="notice notice-success" role="status" data-testid=${root} data-state="success">
      <span class="grow">${t(kind === "pull" ? "engines.page.job.pullDone" : "engines.page.job.introspectDone", { name })}</span>
      <${Button} size="sm" variant="ghost" onClick=${onDismiss} testid="engine-job.dismiss">${t("engines.page.dismiss")}<//>
    </div>`;
  }
  if (view?.state === "failed") {
    return html`<div class="notice notice-danger" role="alert" data-testid=${root} data-state="failed">
      <span class="grow">
        ${t(kind === "pull" ? "engines.page.job.pullFailed" : "engines.page.job.introspectFailed", { name })}
        ${view.error ? html` <span data-user-content="" data-testid="engine-job.error">${view.error}</span>` : null}
        ${view.code === "runtime_image_missing" ? html` ${t("engines.page.job.pullFirst")}` : null}
      </span>
      <${Button} size="sm" variant="ghost" onClick=${onDismiss} testid="engine-job.dismiss">${t("engines.page.dismiss")}<//>
    </div>`;
  }
  return html`<div data-testid=${root} data-state=${view?.state || "starting"}>
    <${ProgressRow} label=${t(kind === "pull" ? "engines.page.job.pulling" : "engines.page.job.introspecting", { name })}
      percent=${view ? view.percent : null} testid="engine-job.progress" />
  </div>`;
}
