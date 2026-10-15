// The actions of a library row (07 §6.4, 03 §9.5): Verify, Check update,
// Update, Clean up leftovers and Delete. `useLibraryActions()` returns
// `{ run, busy, startDelete, dialog }`; the page renders `dialog` once.
//
// Delete always asks first: a danger ConfirmDialog with type-to-confirm on the
// folder name (the API wants the same text in `confirm`), which says how much
// space it frees. The removal is a hub task, so the dialog stays open and busy
// until the task ends, and the toast reports the bytes it really freed. A root
// can never be targeted, so the row does not offer Delete for one. Nothing here
// stops a container: the hub refuses to delete a folder a container has mounted.

import { describeError } from "../../lib/api.js";
import { deleteConfirmName, reclaimedBytes } from "../../lib/library-model.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { waitForTask } from "./data.js";

const enc = encodeURIComponent;

function DeleteBody({ view }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<div class="stack-sm" data-testid="library.delete.body">
    <p>${t("hub.library.delete.body", { size: fmt.bytes(view.bytes) })}</p>
    <p class="small muted mono" data-user-content="">${view.path}</p>
    ${view.duplicates.length ? html`<p class="small muted">${t("hub.library.delete.duplicates")}</p>` : null}
  </div>`;
}

/** @returns {{ run: { verify, checkUpdate, update, cleanup, rescan }, busy: object, startDelete(view), dialog }} */
export function useLibraryActions() {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const fmt = useFormat();
  const [busy, setBusy] = useState({});
  const [target, setTarget] = useState(null);

  function invalidate() {
    cache.invalidate(["hub", "library"]);
  }
  function tell(level, title, body) {
    toasts?.push?.({ level, title, ...(body ? { body } : {}) });
  }
  async function guarded(view, action, work) {
    const key = `${view?.key || "all"}:${action}`;
    setBusy((current) => ({ ...current, [key]: true }));
    try {
      await work();
    } catch (error) {
      tell("error", describeError(error, i18n));
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }

  const run = {
    verify: (view) => guarded(view, "verify", async () => {
      await api.post(`/api/hub/library/${enc(view.id)}/verify`, { checksums: false });
      tell("info", t("hub.library.verify.started", { name: view.name }));
      invalidate();
    }),
    checkUpdate: (view) => guarded(view, "checkUpdate", async () => {
      const body = await api.post(`/api/hub/library/${enc(view.id)}/check-update`, {});
      const update = body?.update || {};
      if (update.status === "available") {
        tell("info", t("hub.library.update.available", { files: Number(update.changedFiles) || 0, size: fmt.bytes(update.bytesToDownload) }));
      } else if (update.status === "unsupported") {
        tell("warn", t("hub.library.update.noSource"));
      } else {
        tell("success", t("hub.library.update.upToDate"), view.name);
      }
      invalidate();
    }),
    update: (view) => guarded(view, "update", async () => {
      await api.post(`/api/hub/library/${enc(view.id)}/update`, {});
      tell("success", t("hub.library.update.queued", { name: view.name }));
      cache.invalidate(["hub", "downloads"]);
      invalidate();
    }),
    cleanup: (view) => guarded(view, "cleanup", async () => {
      const body = await api.post(`/api/hub/library/${enc(view.id)}/cleanup-residue`, {});
      tell("success", t("hub.library.cleanup.done", { size: fmt.bytes(body?.removedBytes) }));
      invalidate();
    }),
    rescan: () => guarded(null, "rescan", async () => {
      await api.post("/api/hub/library/rescan", {});
      tell("info", t("hub.library.rescan.started"));
      invalidate();
    }),
  };

  async function confirmDelete() {
    const view = target;
    const started = await api.del(`/api/hub/library/${enc(view.id)}`, { body: { confirm: deleteConfirmName(view) } });
    const task = await waitForTask(api, started?.taskId);
    const freed = reclaimedBytes(task) || view.bytes;
    tell("success", t("hub.library.delete.done", { name: view.name, size: fmt.bytes(freed) }));
    invalidate();
  }

  const dialog = html`<${ConfirmDialog} open=${Boolean(target)} tone="danger" testid="library.delete"
    title=${t("hub.library.delete.title", { name: target?.name || "" })}
    body=${target ? html`<${DeleteBody} view=${target} />` : ""}
    typeToConfirm=${target ? deleteConfirmName(target) : undefined}
    confirmLabel=${t("hub.library.action.delete")}
    onConfirm=${confirmDelete} onClose=${() => setTarget(null)} />`;
  return { run, busy, startDelete: setTarget, dialog };
}
