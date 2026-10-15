// The actions on a download job (07 §6.4 "Downloads", 03 §13.1):
// `useJobActions()` returns `{ run, busy, startCancelDelete, dialog }`; the page
// renders `dialog` once.
//
// Pause, Resume, Retry, Start now, Priority, Cancel (keep files) and Remove
// send their POST/DELETE and refresh the lists. "Cancel and delete partial
// files" always asks first: a danger ConfirmDialog that says how many bytes
// it frees (the resume check's bytes on disk) and wants the folder name typed;
// the request carries `{ deletePartial: true, confirm: <folder name> }` and the
// toast reports the bytes the hub really reclaimed. Nothing here stops a
// container: the hub refuses to delete a folder that is in use (409
// `path_busy`), and the dialog shows that.

import { describeError } from "../../lib/api.js";
import { reclaimableBytes } from "../../lib/downloads-model.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useServices } from "../../ui/context.js";
import { useFormat } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

const enc = encodeURIComponent;

function CancelBody({ job, check }) {
  const { i18n } = useServices();
  const fmt = useFormat();
  const bytes = reclaimableBytes(job, check);
  return html`<div class="stack-sm" data-testid="download.cancel.body">
    <p>${i18n.t("hub.downloads.cancel.body", { size: fmt.bytes(bytes) })}</p>
    <p class="small muted mono" data-user-content="" data-testid="download.cancel.dir">${job.target?.rootLabel ? `${job.target.rootLabel} / ` : ""}${job.target?.outputName}</p>
    <p class="small muted">${i18n.t("hub.downloads.cancel.running")}</p>
  </div>`;
}

/** @returns {{ run, busy, startCancelDelete(job), dialog }} */
export function useJobActions() {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const fmt = useFormat();
  const [busy, setBusy] = useState({});
  const [target, setTarget] = useState(null);
  const [check, setCheck] = useState(null);

  function refresh() {
    cache.invalidate(["hub", "downloads"]);
    cache.invalidate(["hub", "history"]);
  }
  function tell(level, title, body) {
    toasts?.push?.({ level, title, ...(body ? { body } : {}) });
  }
  async function guarded(job, action, work) {
    const key = `${job?.id || "all"}:${action}`;
    setBusy((current) => ({ ...current, [key]: true }));
    try {
      return await work();
    } catch (error) {
      tell("error", describeError(error, i18n));
      return null;
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }
  const post = (job, action, body = {}) => guarded(job, action, async () => {
    const result = await api.post(`/api/hub/downloads/${enc(job.id)}/${action}`, body);
    refresh();
    return result || {};
  });

  const run = {
    pause: (job) => post(job, "pause"),
    resume: (job, body = {}) => post(job, "resume", body),
    retry: (job) => post(job, "retry"),
    startNow: (job) => post(job, "start-now"),
    priority: (job, priority) => post(job, "priority", { priority }),
    cancelKeep: (job) => guarded(job, "cancel", async () => {
      await api.post(`/api/hub/downloads/${enc(job.id)}/cancel`, {});
      tell("info", t("hub.downloads.cancel.kept", { name: job.target?.outputName || job.id }));
      refresh();
    }),
    remove: (job) => guarded(job, "remove", async () => {
      await api.del(`/api/hub/downloads/${enc(job.id)}`);
      refresh();
    }),
    pauseAll: () => guarded(null, "pause-all", async () => {
      const result = await api.post("/api/hub/downloads/pause-all", {});
      tell("info", t("hub.downloads.paused", { count: Number(result?.affected) || 0 }));
      refresh();
    }),
    resumeAll: () => guarded(null, "resume-all", async () => {
      const result = await api.post("/api/hub/downloads/resume-all", {});
      tell("info", t("hub.downloads.resumed", { count: Number(result?.affected) || 0 }));
      refresh();
    }),
    reorder: (ids) => guarded(null, "reorder", async () => {
      await api.post("/api/hub/downloads/reorder", { ids });
      refresh();
      return true;
    }),
    login: () => guarded(null, "login", async () => {
      await api.post("/api/hub/auth/huggingface/login", {});
      tell("info", t("hub.plan.loginOpened"));
    }),
  };

  useEffect(() => {
    setCheck(null);
    if (!target) return undefined;
    let alive = true;
    api.get(`/api/hub/downloads/${enc(target.id)}/resume-check`).then((body) => alive && setCheck(body), () => {});
    return () => {
      alive = false;
    };
  }, [target?.id]);

  async function confirmCancel() {
    const job = target;
    const result = await api.post(`/api/hub/downloads/${enc(job.id)}/cancel`, { deletePartial: true, confirm: job.target?.outputName });
    tell("success", t("hub.downloads.cancel.deleted", { name: job.target?.outputName || job.id, size: fmt.bytes(result?.reclaimedBytes) }));
    refresh();
  }

  const dialog = html`<${ConfirmDialog} open=${Boolean(target)} tone="danger" testid="download.cancel"
    title=${t("hub.downloads.cancel.title", { name: target?.target?.outputName || "" })}
    body=${target ? html`<${CancelBody} job=${target} check=${check} />` : ""}
    typeToConfirm=${target?.target?.outputName || undefined}
    confirmLabel=${t("hub.action.cancel-delete")}
    onConfirm=${confirmCancel} onClose=${() => setTarget(null)} />`;
  return { run, busy, startCancelDelete: setTarget, dialog };
}
