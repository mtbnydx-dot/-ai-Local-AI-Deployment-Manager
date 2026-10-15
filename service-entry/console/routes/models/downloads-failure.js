// The classified failure card of a download (07 §6.4 "Failure card", 03 §6.3).
//
// The cause comes from the job's `error` as the hub classified it (08's table
// plus the three refinements): `title` and `hint` in both languages, the
// redacted `detail`, whether it is retried by itself and the `actions[]` that
// fix it. The console keeps no per-code copy; `hub.error.fallback` covers an
// error without a title. Each action is a button or a link:
//
//   sign-in / enter-token      the local login window / a one-time token
//   open-approval              the repository page, where access is requested
//   switch-source              resume with the other source; a finished job
//                              cannot be resumed, so it opens a new plan
//   choose-root / pick-artifact open the plan sheet for the same repository
//   free-space / install-cli   the Storage page / the doctor
//   retry / view-log / check-id
//
// "Change root" opens the plan sheet, because a job's folder is fixed once it
// is queued; the plan finds the partial files by their marker and resumes them.

import { approvalUrl, canResumeInPlace, failureView, switchTarget } from "../../lib/downloads-model.js";
import { detailHref, planHref } from "../../lib/discover-model.js";
import { Button } from "../../components/button.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { Lazy } from "./lazy.js";

function planTarget(job, patch = {}) {
  return {
    provider: job.artifact?.provider === "modelscope" ? "modelscope" : "huggingface",
    repo: job.artifact?.repo || "",
    artifact: job.artifact?.artifactKey || "",
    runAfter: false,
    source: "",
    rootId: "",
    ...patch,
  };
}

/** @param actions useJobActions()  @param onViewLog() */
export function FailureCard({ job, owner, actions, onViewLog }) {
  const { t, pick, tk } = useT();
  const [token, setToken] = useState(false); // a job that is not finished yet can take a token in place
  const view = failureView(job, pick);
  if (!view) return null;
  const { run, busy } = actions;
  const target = planTarget(job);
  const next = switchTarget(job);

  function button(id) {
    const label = t(tk("hub.action.", id));
    const press = (onClick, extra = {}) => html`<${Button} key=${id} size="sm" onClick=${onClick} busy=${Boolean(busy[`${job.id}:${id}`])} testid=${`download.fix.${id}`} ...${extra}>${label}<//>`;
    const link = (href, extra = {}) => html`<${Button} key=${id} size="sm" href=${href} testid=${`download.fix.${id}`} ...${extra}>${label}<//>`;
    switch (id) {
      case "retry": return press(() => run.retry(job), { variant: "primary" });
      case "resume": return canResumeInPlace(job) ? press(() => run.resume(job)) : press(() => run.retry(job));
      case "sign-in": return press(() => run.login());
      case "enter-token": return canResumeInPlace(job) ? press(() => setToken(!token)) : link(planHref(target));
      case "open-approval": return approvalUrl(job) ? link(approvalUrl(job), { target: "_blank", rel: "noopener noreferrer" }) : null;
      case "switch-source":
        if (!next) return null;
        return canResumeInPlace(job) ? press(() => run.resume(job, { source: next })) : link(planHref(planTarget(job, { source: next })));
      case "choose-root": return link(planHref(target));
      case "pick-artifact": return link(planHref(planTarget(job, { artifact: "" })));
      case "free-space": return link("/models/storage");
      case "install-cli": return link("/system/doctor");
      case "check-id": return link(detailHref(target.provider, target.repo) || "/models/discover");
      case "view-log": return press(onViewLog);
      default: return null;
    }
  }

  return html`<div class="notice notice-danger failure-card stack-sm" role="group" aria-label=${view.title || t("hub.error.fallback")} data-testid="download.failure" data-code=${view.code}>
    <div class="row">
      <strong data-user-content="" data-testid="download.failure.title">${view.title || t("hub.error.fallback")}</strong>
      <span class="badge badge-neutral mono" data-testid="download.failure.code">${view.code}</span>
    </div>
    ${view.hint ? html`<p data-user-content="" data-testid="download.failure.hint">${view.hint}</p>` : null}
    ${view.detail && owner ? html`<code class="code-inline mono xsmall failure-detail" data-user-content="" data-testid="download.failure.detail">${view.detail}</code>` : null}
    <p class="small muted" data-testid="download.failure.retry">${view.retryable && view.attempts?.max
      ? t("hub.downloads.failure.attempts", { n: view.attempts.count, max: view.attempts.max }) : t("hub.error.notRetried")}</p>
    ${owner ? html`<div class="row">${view.actions.map(button).filter(Boolean)}</div>` : null}
    ${owner && token ? html`<${Lazy} from=${() => import("./downloads-token.js")} name="TokenResume" job=${job} run=${run} busy=${busy} onDone=${() => setToken(false)} />` : null}
  </div>`;
}
