// The StatusStrip layer actions (06 §5.12, §10.2) as a hook: Start last used
// model (restore-models) shows its dry-run plan in a ConfirmDialog before the
// real call, Start supervisor confirms first, and any other action id opens
// /system. The topbar's strip and the Overview banner share it.

import { describeError } from "../lib/api.js";
import { tk } from "../lib/i18n.js";
import { useServices } from "../ui/context.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useState } from "../ui/vendor.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { actionKey } from "./status-strip.js";

// Layer actions the strip can run (06 §5.12, §10.2); any other id opens /system.
const LAYER_ACTIONS = Object.freeze({
  "restore-models": { path: "/api/platform/restore-models", dryRun: true, body: {}, bodyKey: "platform.strip.restoreBody" },
  "start-supervisor": { path: "/api/platform/supervisor/start", dryRun: false, body: {}, bodyKey: "platform.strip.supervisorBody" },
});

function planLines(plan, i18n) {
  const known = new Set(["launch", "skip-running", "offer-only"]);
  return (Array.isArray(plan) ? plan : []).filter((item) => item && typeof item === "object").map((item) => {
    const action = known.has(item.action) ? i18n.t(tk("platform.strip.plan.", item.action)) : String(item.action || "");
    return [item.managerId, item.model, action].filter(Boolean).join(" · ");
  });
}

export function useLayerAction() {
  const services = useServices();
  const { api, cache, toasts, router } = services;
  const i18n = useT();
  const { t, has, pick } = i18n;
  const [pending, setPending] = useState(null);

  async function start(action) {
    const config = LAYER_ACTIONS[action.id];
    if (!config) {
      router?.navigate?.("/system");
      return;
    }
    const label = has(actionKey(action.id)) ? t(actionKey(action.id)) : pick(action.label) || action.id;
    if (!config.dryRun) {
      setPending({ action, config, label, plan: null });
      return;
    }
    try {
      const answer = await api.post(config.path, { dryRun: true });
      setPending({ action, config, label, plan: planLines(answer?.plan, i18n), empty: Array.isArray(answer?.plan) && !answer.plan.length });
    } catch (error) {
      toasts?.push?.({ level: "error", title: label, body: describeError(error, i18n), requestId: error?.requestId || null });
    }
  }

  async function confirm() {
    await api.post(pending.config.path, pending.config.body);
    for (const prefix of [["platform"], ["status"], ["fleet"]]) cache.invalidate(prefix);
    toasts?.push?.({ level: "success", title: pending.label, body: t("platform.strip.started") });
  }

  const dialog = html`<${ConfirmDialog} open=${Boolean(pending)} title=${pending?.label || ""} body=${pending ? (pending.empty ? t("platform.strip.restoreEmpty") : t(pending.config.bodyKey)) : ""}
    details=${pending?.plan || []} confirmLabel=${pending?.label || ""} onConfirm=${confirm} onClose=${() => setPending(null)} testid="topbar.layer-confirm" />`;
  return { start, dialog };
}
