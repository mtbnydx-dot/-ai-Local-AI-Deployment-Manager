// The image step of Review (07 §6.3 step 6, 00 §9.2): what the plan's
// `steps[] {kind:"pull"}` says about the runtime image.
//
//   present   `required:false`: the image is already here
//   auto      a stable image is pulled first, before any model is replaced (today's behaviour):
//             nothing to do
//   explicit  an experimental image is never pulled by a launch. The plan carries the blocker
//             `image_pull_required`; Pull image asks first ("this only downloads the image, no
//             running model is stopped"), sends POST /api/m/:id/runtimes/:runtimeId/pull
//             {confirm:true} (a job of type image-pull, `existing` when one already runs),
//             follows it from `jobs` events and asks for a new plan when it succeeds
//   local     a locally built image that is missing cannot be pulled (422 `runtime_local_build`):
//             the rebuild hint takes the place of the button
//
// The copyable `docker pull` command stays as the secondary option.

import { describeError } from "../../lib/api.js";
import { imageStepOf } from "../../lib/launch-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { useCopy } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { JobProgress } from "../engines/job-progress.js";

const enc = encodeURIComponent;

function CopyCommand({ command }) {
  const { t } = useT();
  const [state, copy] = useCopy();
  return html`<div class="row" data-testid="wizard.image.command">
    <code class="code-inline mono truncate" data-testid="wizard.image.command-text">${command}</code>
    <${Button} size="sm" variant="ghost" onClick=${() => copy(command)} testid="wizard.image.copy">${state === "copied" ? t("common.copied") : state === "failed" ? t("common.copyFailed") : t("common.copy")}<//>
  </div>`;
}

/** @param plan the usePlan() state (refresh() asks for a new plan)  @param managerId the manager that pulls */
export function ImageStep({ plan, managerId }) {
  const { api, i18n } = useServices();
  const { t } = i18n;
  const fmt = useFormat();
  const image = imageStepOf(plan.plan);
  const [asking, setAsking] = useState(false);
  const [job, setJob] = useState(null);
  const [rebuild, setRebuild] = useState("");
  if (image.state === "none") return null;

  const step = (plan.plan?.steps || []).find((item) => item?.kind === "pull") || {};
  const size = Number.isFinite(Number(step.sizeBytes)) && Number(step.sizeBytes) > 0 ? fmt.bytes(Number(step.sizeBytes)) : t("models.wizard.review.image.sizeUnknown");
  const command = image.image ? `docker pull ${image.image}` : "";

  async function pull() {
    try {
      const body = await api.manager(managerId).post(`/runtimes/${enc(image.runtimeId)}/pull`, { confirm: true });
      const id = body?.job?.id;
      if (id) setJob({ id: String(id), existing: body.existing === true });
    } catch (error) {
      if (error?.code === "runtime_local_build") {
        setRebuild(describeError(error, i18n));
        return;
      }
      throw error;
    }
  }

  let body;
  if (image.state === "present") {
    body = html`<p data-testid="wizard.image.present"><${StatusBadge} status="ok" label=${t("models.wizard.review.image.present")} /> <code class="code-inline mono" data-user-content="">${image.image}</code></p>`;
  } else if (image.state === "auto") {
    body = html`<p data-testid="wizard.image.auto">${t("models.wizard.review.image.auto", { image: image.image })}</p>`;
  } else if (image.state === "local-build") {
    body = html`<div class="stack-sm" data-testid="wizard.image.local">
      <p class="notice notice-warn" role="status">${t("engines.err.runtime_local_build_missing", { image: image.image })}</p>
      ${command ? html`<p class="small muted">${t("models.wizard.review.image.rebuild")}</p>` : null}
    </div>`;
  } else {
    body = html`<div class="stack-sm" data-testid="wizard.image.explicit">
      <p data-testid="wizard.image.step">${t("engines.plan.step.pull", { image: image.image, size })}</p>
      <p class="notice notice-warn" role="status" data-testid="wizard.image.blocker">${t("engines.err.image_pull_required")}</p>
      ${rebuild ? html`<p class="notice notice-danger" role="alert" data-testid="wizard.image.rebuild">${rebuild}</p>` : null}
      ${job ? html`<${JobProgress} managerId=${managerId} jobId=${job.id} kind="pull" name=${image.image} testid="wizard.image.job"
        onFinished=${(view) => {
          if (view.state === "success") plan.refresh?.();
        }} onDismiss=${() => setJob(null)} />` : null}
      ${!job && !rebuild ? html`<div class="row"><${Button} variant="primary" onClick=${() => setAsking(true)} testid="wizard.image.pull">${t("models.wizard.review.image.pull")}<//></div>` : null}
      ${command ? html`<div class="stack-sm"><span class="xsmall muted">${t("models.wizard.review.image.orCommand")}</span><${CopyCommand} command=${command} /></div>` : null}
    </div>`;
  }
  return html`<${Card} title=${t("models.wizard.review.image.title")} testid="wizard.image" >
    <div data-state=${image.state} data-testid="wizard.image.state">${body}</div>
    <${ConfirmDialog} open=${asking} testid="wizard.image.confirm" title=${t("models.wizard.review.image.confirmTitle", { image: image.image })}
      body=${t("models.wizard.review.image.confirmBody")} confirmLabel=${t("models.wizard.review.image.pull")} cancelLabel=${t("common.cancel")}
      onConfirm=${pull} onClose=${() => setAsking(false)} />
  <//>`;
}
