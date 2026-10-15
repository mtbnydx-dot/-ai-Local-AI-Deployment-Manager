// The Runtimes tab of an engine (07 §6.5): runtime id, image (copyable),
// whether the image is present, when the flags were introspected, features and
// the two actions that start a job.
//
// Both actions ask first and send `{confirm:true}` only from the dialog:
//   Introspect  POST /api/m/:id/engines/:engineId/runtimes/:runtimeId/introspect (a short-lived container, 01 §17)
//   Pull image  POST /api/m/:id/runtimes/:runtimeId/pull (a `dl_` job of type image-pull, 01 §21.1)
// The job is followed with JobProgress, which reads the same jobs the entry
// events update. The pull route is the supervisor job of ENG-11 (`{ok, existing, job}`);
// an older manager answers 404 and the dialog says so. The `docker pull` command
// stays copyable either way.

import { dockerPullCommand, introspectAllowed, flagsSnapshot, pullAllowed, runtimeState } from "../../lib/engines-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { useCopy } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { TableWrap } from "./engine-parts.js";
import { JobProgress } from "./job-progress.js";

const enc = encodeURIComponent;

function CopyButton({ text, label }) {
  const { t } = useT();
  const [state, copy] = useCopy();
  return html`<${Button} size="sm" variant="ghost" onClick=${() => copy(text)} label=${label} testid="engine-runtime.copy">
    ${state === "copied" ? t("common.copied") : state === "failed" ? t("common.copyFailed") : t("common.copy")}
  <//>`;
}

function IntrospectedCell({ engine, runtime }) {
  const { api } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const flags = useQuery(
    ["engines", "flags", engine.managerId, engine.engineId, runtime.runtimeId],
    () => api.manager(engine.managerId).get(`/engines/${enc(engine.engineId)}/runtimes/${enc(runtime.runtimeId)}/flags`),
    { ttlMs: 30000, enabled: runtime.introspected === true },
  );
  if (runtime.introspected !== true) return html`<${StatusBadge} status="neutral" label=${t("engines.page.runtime.notIntrospected")} />`;
  const snapshot = flagsSnapshot(flags.data);
  return html`<div class="stack-sm">
    <${StatusBadge} status="ok" label=${t("engines.page.runtime.introspected")} />
    ${snapshot?.capturedAt ? html`<span class="xsmall muted" data-testid="engine-runtime.captured">${t("engines.page.runtime.capturedAt", { time: fmt.dateTime(snapshot.capturedAt) })}</span>` : null}
    ${snapshot ? html`<span class="xsmall muted">${t("engines.page.runtime.flagCount", { count: snapshot.count })}</span>` : null}
  </div>`;
}

function RuntimeRow({ engine, runtime, owner, onAction }) {
  const { t } = useT();
  const state = runtimeState(runtime);
  const features = Object.entries(runtime.features && typeof runtime.features === "object" ? runtime.features : {}).filter(([, value]) => value === true).map(([name]) => name);
  const missing = state === "missing";
  return html`<tr data-testid="engine-runtime" data-runtime=${runtime.runtimeId} data-present=${state}>
    <th scope="row">
      <code class="code-inline">${runtime.runtimeId}</code>
      ${runtime.default ? html` <span class="badge badge-info">${t("engines.page.runtime.default")}</span>` : null}
      ${runtime.label ? html`<div class="small muted" data-user-content="">${runtime.label}</div>` : null}
    </th>
    <td>
      ${runtime.image ? html`<div class="row-nowrap"><code class="code-inline truncate" data-testid="engine-runtime.image">${runtime.image}</code>
        <${CopyButton} text=${runtime.image} label=${t("engines.page.runtime.copyImage")} /></div>` : html`<span class="muted">—</span>`}
      ${missing && !runtime.localBuild && runtime.image ? html`<div class="row-nowrap small">
        <code class="code-inline truncate" data-testid="engine-runtime.pull-command">${dockerPullCommand(runtime)}</code>
        <${CopyButton} text=${dockerPullCommand(runtime)} label=${t("engines.page.runtime.copyCommand")} /></div>` : null}
    </td>
    <td><${StatusBadge} status=${state === "present" ? "ok" : state === "missing" ? "warn" : "unknown"} label=${t(tk("engines.page.runtime.state.", state))} testid="engine-runtime.present" />
      ${runtime.localBuild ? html`<div class="xsmall muted">${t("engines.page.runtime.localBuild")}</div>` : null}</td>
    <td><${IntrospectedCell} engine=${engine} runtime=${runtime} /></td>
    <td>${features.length ? html`<span class="row">${features.map((name) => html`<span key=${name} class="badge badge-neutral mono">${name}</span>`)}</span>` : html`<span class="muted">—</span>`}</td>
    <td>${owner ? html`<div class="row">
      <${Button} size="sm" onClick=${() => onAction("introspect", runtime)} disabled=${!introspectAllowed(runtime)} testid="engine-runtime.introspect">${t("engines.page.runtime.introspect")}<//>
      ${pullAllowed(runtime) ? html`<${Button} size="sm" variant="primary" onClick=${() => onAction("pull", runtime)} testid="engine-runtime.pull">${t("engines.page.runtime.pull")}<//>` : null}
    </div>
    ${missing && runtime.localBuild ? html`<div class="xsmall muted">${t("engines.page.runtime.rebuildHint")}</div>` : null}` : html`<span class="muted">—</span>`}</td>
  </tr>`;
}

export function RuntimesTab({ engine, owner }) {
  const { api } = useServices();
  const { t } = useT();
  const [dialog, setDialog] = useState(null);
  const [jobs, setJobs] = useState({});
  const runtimes = Array.isArray(engine.runtimes) ? engine.runtimes : [];
  const target = dialog?.runtime || null;

  async function start() {
    const manager = api.manager(engine.managerId);
    const response = dialog.kind === "pull"
      ? await manager.post(`/runtimes/${enc(target.runtimeId)}/pull`, { confirm: true })
      : await manager.post(`/engines/${enc(engine.engineId)}/runtimes/${enc(target.runtimeId)}/introspect`, { confirm: true });
    const id = response?.job?.id;
    if (!id) throw new Error(t("engines.page.job.noJob"));
    setJobs((current) => ({ ...current, [target.runtimeId]: { id, kind: dialog.kind } }));
  }

  const introspecting = dialog?.kind === "introspect";
  return html`<div data-testid="engine-runtimes">
    <${TableWrap} label=${t("engines.page.runtimes.caption")}>
      <table class="table">
        <caption class="sr-only">${t("engines.page.runtimes.caption")}</caption>
        <thead><tr>
          <th scope="col">${t("engines.page.runtimes.runtime")}</th><th scope="col">${t("engines.page.runtimes.image")}</th>
          <th scope="col">${t("engines.page.runtimes.present")}</th><th scope="col">${t("engines.page.runtimes.introspected")}</th>
          <th scope="col">${t("engines.page.runtimes.features")}</th><th scope="col">${t("engines.page.runtimes.actions")}</th>
        </tr></thead>
        <tbody>
          ${runtimes.length ? runtimes.map((runtime) => html`<${RuntimeRow} key=${runtime.runtimeId} engine=${engine} runtime=${runtime} owner=${owner}
            onAction=${(kind, row) => setDialog({ kind, runtime: row })} />
            ${jobs[runtime.runtimeId] ? html`<tr key=${`${runtime.runtimeId}-job`}><td colspan="6">
              <${JobProgress} managerId=${engine.managerId} jobId=${jobs[runtime.runtimeId].id} kind=${jobs[runtime.runtimeId].kind}
                name=${jobs[runtime.runtimeId].kind === "pull" ? runtime.image : runtime.runtimeId}
                onDismiss=${() => setJobs((current) => {
                  const { [runtime.runtimeId]: _gone, ...rest } = current;
                  return rest;
                })} /></td></tr>` : null}`)
            : html`<tr><td colspan="6" class="muted">${t("engines.page.runtimes.none")}</td></tr>`}
        </tbody>
      </table>
    <//>
    <${ConfirmDialog} open=${Boolean(dialog)} testid="engine-runtime.confirm"
      title=${target ? t(introspecting ? "engines.page.introspect.title" : "engines.page.pull.title", { runtime: target.runtimeId }) : ""}
      body=${target ? t(introspecting ? "engines.page.introspect.body" : "engines.page.pull.body", { runtime: target.runtimeId, image: target.image || "" }) : ""}
      details=${introspecting
        ? [t("engines.page.introspect.d1"), t("engines.page.introspect.d2"), t("engines.page.introspect.d3")]
        : [t("engines.page.pull.d1"), t("engines.page.pull.d2"), t("engines.page.pull.d3")]}
      confirmLabel=${t(introspecting ? "engines.page.introspect.confirm" : "engines.page.pull.confirm")}
      onConfirm=${start} onClose=${() => setDialog(null)} />
  </div>`;
}
