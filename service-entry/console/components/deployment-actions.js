// The Stop and Wake actions of a deployment (07 §6.2), shared by the list and
// the detail page. Both are hooks: `start(row)` opens the dialog (Stop) or
// sends the request (Wake), and `dialog` is the node to render once.
//
// Stop always asks first; nothing stops a container without the click on the
// danger button. Wake sends the sleep record id (`slp_…`), never the instance
// id. A 409 `wake_would_replace_running` opens a danger ConfirmDialog with 08's
// copy, and only its OK re-sends the request with `{confirmReplace:true}`.
// A 409 `wake_api_key_missing` shows 08's copy and offers Relaunch.

import { describeError } from "../lib/api.js";
import { relaunchHref, wakePath, wakeProblem } from "../lib/deployments-model.js";
import { useServices } from "../ui/context.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useState } from "../ui/vendor.js";
import { ConfirmDialog } from "./confirm-dialog.js";

// Everything that shows a deployment refetches after one starts, stops or wakes.
function refresh(cache) {
  for (const prefix of [["fleet"], ["status"], ["platform"], ["m"]]) cache.invalidate(prefix);
}

/** @returns {{ start(row), dialog }} row: { managerId, instanceId, fleetId } */
export function useStopAction({ onDone } = {}) {
  const { api, cache, toasts } = useServices();
  const { t } = useT();
  const [target, setTarget] = useState(null);

  async function stop() {
    await api.post(`/api/m/${encodeURIComponent(target.managerId)}/instances/${encodeURIComponent(target.instanceId)}/stop`, {});
    refresh(cache);
    toasts?.push?.({ level: "success", title: t("overview.stop.done", { instance: target.fleetId }) });
    onDone?.(target);
  }

  const dialog = html`<${ConfirmDialog} open=${Boolean(target)} tone="danger" title=${t("overview.stop.title", { instance: target?.fleetId || "" })}
    body=${t("overview.stop.body")} confirmLabel=${t("overview.row.stop")} onConfirm=${stop} onClose=${() => setTarget(null)} testid="deploy.stop-confirm" />`;
  return { start: setTarget, dialog };
}

/** @returns {{ start(row), busyKey, dialog }} row: { managerId, sleepId, fleetId, model, launchId } */
export function useWakeAction({ onDone } = {}) {
  const { api, cache, toasts, router } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const [busyKey, setBusyKey] = useState(null);
  const [replace, setReplace] = useState(null);
  const [keyMissing, setKeyMissing] = useState(null);

  function done(row) {
    refresh(cache);
    toasts?.push?.({ level: "success", title: t("deploy.wake.done", { model: row.model }) });
    onDone?.(row);
  }

  async function start(row) {
    setBusyKey(row.key || row.fleetId);
    try {
      await api.post(wakePath(row.managerId, row.sleepId), {});
      done(row);
    } catch (error) {
      const problem = wakeProblem(error);
      if (problem.kind === "replace") setReplace({ row, model: problem.model || row.model });
      else if (problem.kind === "key") setKeyMissing(row);
      else toasts?.push?.({ level: "error", title: describeError(error, i18n), requestId: error?.requestId || null });
    } finally {
      setBusyKey(null);
    }
  }

  // Only this button re-sends, and it carries the explicit confirmation.
  async function confirmReplace() {
    await api.post(wakePath(replace.row.managerId, replace.row.sleepId), { confirmReplace: true });
    done(replace.row);
  }

  const dialog = html`<${ConfirmDialog} open=${Boolean(replace)} tone="danger" title=${t("deploy.wake.replaceTitle")}
      body=${t("deploy.wake.replaceBody", { model: replace?.model || "" })} confirmLabel=${t("deploy.wake.replaceConfirm")}
      onConfirm=${confirmReplace} onClose=${() => setReplace(null)} testid="deploy.wake-replace" />
    <${ConfirmDialog} open=${Boolean(keyMissing)} title=${t("deploy.wake.keyTitle")} body=${t("deploy.wake.keyBody")}
      confirmLabel=${t("deploy.action.relaunch")}
      onConfirm=${() => router?.navigate?.(relaunchHref({ managerId: keyMissing.managerId, launchId: keyMissing.launchId, instanceId: keyMissing.instanceId }))}
      onClose=${() => setKeyMissing(null)} testid="deploy.wake-key" />`;
  return { start, busyKey, dialog };
}
