// The migration jobs of the Storage page (07 §6.4): progress and the start /
// pause / switch back / clean up actions, at parity with the legacy
// /model-storage page. Every write goes to the manager that served the
// snapshot (`managerApi`, /model-storage*), and every destructive one asks
// first; cleaning up the source asks for its full path.

import { describeError } from "../../lib/api.js";
import { knownState, migrationActions, migrationPercent, migrationTitle } from "../../lib/storage-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { ProgressRow } from "../../components/progress-row.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

const STATE_TONE = Object.freeze({ completed: "ok", failed: "error", cleanup_failed: "error", interrupted: "warn", cancelled: "warn", rolled_back: "neutral", planned: "info" });

function refresh(cache) {
  cache.invalidate(["hub", "storage"]);
  cache.invalidate(["hub", "library"]);
}

// ---- migrations -----------------------------------------------------------------------------

function MigrationCard({ job, managerApi }) {
  const { cache, toasts, i18n } = useServices();
  const { t, tk } = useT();
  const [busy, setBusy] = useState("");
  const [asking, setAsking] = useState(null);
  const offered = migrationActions(job);
  const state = knownState(job.state);

  async function send(action, body = {}) {
    await managerApi.post(`/model-storage/migrations/${encodeURIComponent(job.id)}/${action}`, body);
    refresh(cache);
  }
  async function plain(action) {
    setBusy(action);
    try {
      await send(action);
    } catch (error) {
      toasts?.push?.({ level: "error", title: describeError(error, i18n) });
    } finally {
      setBusy("");
    }
  }
  const dialogs = {
    start: { title: "hub.storage.migration.startTitle", body: "hub.storage.migration.startBody", label: "hub.storage.migration.start", tone: "default", run: () => send("start") },
    rollback: { title: "hub.storage.migration.rollbackTitle", body: "hub.storage.migration.rollbackBody", label: "hub.storage.migration.rollback", tone: "default", run: () => send("rollback") },
    cleanup: { title: "hub.storage.migration.cleanupTitle", body: "hub.storage.migration.cleanupBody", label: "hub.storage.migration.cleanup", tone: "danger", typed: job.source, run: () => send("cleanup", { confirmSource: job.source }) },
  };
  const dialog = asking ? dialogs[asking] : null;
  const percent = migrationPercent(job);
  const stateLabel = state ? t(tk("hub.storage.state.", state)) : String(job.state || "");
  return html`<li class="stack-sm migration" data-testid="storage.migration" data-job=${job.id} data-state=${job.state}>
    <div class="row">
      <strong data-user-content="">${migrationTitle(job)}</strong>
      <${StatusBadge} status=${offered.active ? "loading" : STATE_TONE[job.state] || "neutral"} label=${stateLabel} testid="storage.migration.state" />
    </div>
    <p class="small mono muted" data-user-content="">${job.source}<br />→ ${job.target}</p>
    ${offered.active || job.bytesDone ? html`<${ProgressRow} label=${t("hub.storage.migration.progress", { done: job.completedFiles || 0, total: job.fileCount || 0 })}
      percent=${percent} bytesDone=${Number(job.bytesDone) || 0} bytesTotal=${Number(job.totalBytes) || 0} testid="storage.migration.progress" />` : null}
    <p class="small muted" data-user-content="">${job.error || job.phase || (job.state === "planned" ? t("hub.storage.migration.waiting") : "")}</p>
    ${job.currentFile ? html`<p class="xsmall mono muted truncate" data-user-content="">${job.currentFile}</p>` : null}
    ${job.state === "completed" && !job.sourceRemoved ? html`<p class="small" data-testid="storage.migration.kept">${t("hub.storage.migration.kept")}</p>` : null}
    <div class="row">
      ${offered.start ? html`<${Button} size="sm" variant="primary" onClick=${() => setAsking("start")} testid="storage.migration.start">${offered.continue ? t("hub.storage.migration.continue") : t("hub.storage.migration.start")}<//>` : null}
      ${offered.cancel ? html`<${Button} size="sm" busy=${busy === "cancel"} onClick=${() => plain("cancel")} testid="storage.migration.cancel">${t("hub.storage.migration.pause")}<//>` : null}
      ${offered.rollback ? html`<${Button} size="sm" onClick=${() => setAsking("rollback")} testid="storage.migration.rollback">${t("hub.storage.migration.rollback")}<//>` : null}
      ${offered.cleanup ? html`<${Button} size="sm" variant="danger" onClick=${() => setAsking("cleanup")} testid="storage.migration.cleanup">${t("hub.storage.migration.cleanup")}<//>` : null}
    </div>
    <${ConfirmDialog} open=${Boolean(dialog)} tone=${dialog?.tone || "default"} testid=${`storage.migration.${asking || "ask"}`}
      title=${dialog ? t(dialog.title) : ""} body=${dialog ? html`<div class="stack-sm"><p>${t(dialog.body)}</p><p class="mono small" data-user-content="">${job.source}<br />→ ${job.target}</p></div>` : ""}
      typeToConfirm=${dialog?.typed} confirmLabel=${dialog ? t(dialog.label) : ""} onConfirm=${() => dialog.run()} onClose=${() => setAsking(null)} />
  </li>`;
}

export function MigrationsCard({ migrations, managerApi }) {
  const { t } = useT();
  const jobs = Array.isArray(migrations) ? migrations : [];
  return html`<${Card} title=${t("hub.storage.migrations.title")} testid="storage.migrations"
    actions=${html`<span class="badge badge-neutral" data-testid="storage.migrations.count">${t("hub.storage.migrations.count", { count: jobs.length })}</span>`}>
    <p class="small muted">${t("hub.storage.migrations.lead")}</p>
    ${jobs.length
      ? html`<ul class="stack">${jobs.map((job) => html`<${MigrationCard} key=${job.id} job=${job} managerApi=${managerApi} />`)}</ul>`
      : html`<p class="muted" data-testid="storage.migrations.none">${t("hub.storage.migrations.none")}</p>`}
  <//>`;
}
