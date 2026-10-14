// Topbar (07 §4.4, §8): the menu button (below lg), the StatusStrip with the
// queries that feed it, the palette button and the bell. The strip reads
// 06's PlatformStatus when the entry has it, otherwise it derives readiness
// from /api/status and /api/fleet. Layer actions (Start last used model, Start
// supervisor) confirm first; restore-models shows its dry-run plan.

import { describeError } from "../lib/api.js";
import { tk } from "../lib/i18n.js";
import { FleetGuard, PlatformStatusGuard, StatusGuard } from "../lib/schemas.js";
import { useServices } from "../ui/context.js";
import { useQuery, usePref, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { NotificationCenter } from "./notification-center.js";
import { actionKey, StatusStrip } from "./status-strip.js";

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

function useLayerAction() {
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

function useStore(store) {
  const [items, setItems] = useState(() => store?.list?.() || []);
  useEffect(() => {
    if (!store?.subscribe) return undefined;
    setItems(store.list());
    return store.subscribe(setItems);
  }, [store]);
  return items;
}

function browserSupport() {
  return Boolean(globalThis.isSecureContext && typeof globalThis.Notification === "function");
}

// onOpenNav shows the off-canvas navigation; onOpenPalette opens the command palette.
export function Topbar({ onOpenNav, onOpenPalette, testid }) {
  const services = useServices();
  const { api, bootstrap, notifications, prefs, toasts } = services;
  const { t } = useT();
  const role = useRole();
  const features = bootstrap?.features || {};
  const status = useQuery(["status"], () => api.get("/api/status", { guard: StatusGuard }), { ttlMs: 10000, refetchMs: 15000 });
  const fleet = useQuery(["fleet"], () => api.get("/api/fleet", { guard: FleetGuard }), { ttlMs: 5000, refetchMs: 10000 });
  const platform = useQuery(["platform"], () => api.get("/api/platform/status", { guard: PlatformStatusGuard }), { ttlMs: 5000, refetchMs: 15000, enabled: Boolean(features.platform) });
  const live = useQuery(["telemetry", "live"], () => api.get("/api/telemetry/live"), { ttlMs: 5000, refetchMs: 5000, enabled: Boolean(features.telemetry) });
  const version = useQuery(["platform", "version"], () => api.get("/api/platform/version"), { ttlMs: 60000, refetchMs: 120000, enabled: Boolean(features.platform) });
  const items = useStore(notifications);
  const [readAt] = usePref("notificationsReadAt");
  const [browserOn] = usePref("notifyBrowser");
  const layerAction = useLayerAction();
  const loading = status.status !== "success" && !status.error && !platform.data;
  const owner = role === "owner";
  const mac = /mac/i.test(String(globalThis.navigator?.platform || ""));

  async function runNotification(entry) {
    const call = entry.action.apiCall;
    await api.request(call.path, { method: call.method.toUpperCase(), body: call.body });
    toasts?.push?.({ level: "success", title: t("notify.done") });
  }

  const browser = browserSupport() ? {
    supported: true,
    enabled: Boolean(browserOn) && globalThis.Notification.permission === "granted",
    onToggle: async (on) => {
      let granted = false;
      if (on) {
        try {
          granted = (await globalThis.Notification.requestPermission()) === "granted";
        } catch {
          granted = false;
        }
      }
      prefs.set("notifyBrowser", on && granted);
    },
  } : null;

  return html`<header class="topbar" data-testid=${testid || "topbar.root"}>
    <${Button} class="show-md-only" variant="ghost" iconOnly icon="menu" label=${t("shell.menu")} aria-haspopup="dialog" onClick=${onOpenNav} testid="topbar.menu" />
    <div class="topbar-strip grow">
      <${StatusStrip} platform=${platform.data || null} status=${status.data || null} fleet=${fleet.data || null} live=${live.data || null}
        build=${{ version: version.data?.version ?? bootstrap?.platform?.version, commit: platform.data?.build?.commit ?? version.data?.build?.commit ?? bootstrap?.platform?.commit }}
        newerCommits=${Number(version.data?.newerCommits) || 0} loading=${loading} canAct=${owner} onAction=${layerAction.start} />
    </div>
    <${Button} variant="ghost" icon="search" label=${t("shell.palette.open")} onClick=${onOpenPalette} testid="topbar.palette">
      <span class="hide-sm">${t("shell.palette.button")}</span><kbd class="kbd hide-md" aria-hidden="true">${mac ? "⌘K" : "Ctrl K"}</kbd>
    <//>
    <${NotificationCenter} items=${items} readAt=${readAt} canRun=${owner} browser=${browser}
      onRead=${() => prefs.set("notificationsReadAt", new Date().toISOString())} onRun=${runNotification} />
    ${layerAction.dialog}
  </header>`;
}
