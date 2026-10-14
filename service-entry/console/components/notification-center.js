// NotificationCenter (07 §4.4, §3.6): the bell, its unread count and a Drawer
// of the last 50 notifications that `notification` events carry (00 §9.6).
//
// The store validates every payload with NotificationGuard (same-origin
// `href`, `/api/` `apiCall` only), merges repeats (a `dedupeKey`, else
// kind + href) seen within 10 minutes into one entry, and keeps 50. An
// `apiCall` action never runs by itself: its button opens a ConfirmDialog that
// names the method and path, and the call goes out only on confirm. Read state
// is the `notificationsReadAt` preference. Browser notifications are opt-in
// and need a secure context.

import { check } from "../lib/guards.js";
import { NotificationGuard } from "../lib/schemas.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { Drawer } from "./drawer.js";
import { Icon } from "./icon.js";

export const MAX_NOTIFICATIONS = 50;
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const SEVERITY_ICON = Object.freeze({ info: "info", success: "circle-check", warn: "triangle-alert", error: "circle-x" });

function timeOf(at, fallback) {
  const ms = typeof at === "string" || typeof at === "number" ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : fallback;
}

function dedupeKeyOf(value) {
  return value.dedupeKey ? `d:${value.dedupeKey}` : `k:${value.kind}|${value.action?.href || ""}`;
}

/**
 * The notification list: { push(data, at) → entry | null, list(), remove(id), clear(), subscribe(fn) → off }.
 * `push` returns null for a payload the guard rejects.
 */
export function createNotificationStore({ now = Date.now, max = MAX_NOTIFICATIONS } = {}) {
  let items = [];
  let seq = 0;
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(items);
      } catch {
        // One broken listener must not starve the others.
      }
    }
  };
  return {
    push(data, at) {
      const checked = check(NotificationGuard, data);
      if (!checked.ok) return null;
      const value = checked.value;
      const atMs = timeOf(at, now());
      const key = dedupeKeyOf(value);
      const found = items.find((item) => item.key === key && Math.abs(atMs - item.atMs) < DEDUPE_WINDOW_MS);
      const entry = {
        id: found ? found.id : ++seq,
        key,
        kind: value.kind,
        severity: value.severity,
        title: value.title,
        body: value.body || null,
        action: value.action || null,
        at: new Date(atMs).toISOString(),
        atMs,
        count: found ? found.count + 1 : 1,
      };
      items = [entry, ...items.filter((item) => item !== found)].slice(0, max);
      emit();
      return entry;
    },
    list: () => items,
    remove(id) {
      items = items.filter((item) => item.id !== id);
      emit();
    },
    clear() {
      items = [];
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Entries newer than `readAt` (an ISO string; null counts everything as unread). */
export function unreadCount(items, readAt) {
  const since = readAt ? timeOf(readAt, 0) : 0;
  return (Array.isArray(items) ? items : []).filter((item) => item.atMs > since).length;
}

function Item({ entry, canRun, onAsk, now }) {
  const { t, pick } = useT();
  const fmt = useFormat();
  const action = entry.action;
  const label = action ? pick(action.label) : "";
  return html`<li class=${`notify-item notify-${entry.severity}`} data-severity=${entry.severity} data-testid="notification-center.item">
    <${Icon} name=${SEVERITY_ICON[entry.severity] || "info"} />
    <div class="grow stack-sm">
      <strong data-testid="notification-center.title">${pick(entry.title)}</strong>
      ${entry.body ? html`<span>${pick(entry.body)}</span>` : null}
      <span class="xsmall muted">${fmt.relative(entry.at, now)}${entry.count > 1 ? html` · ${t("notify.repeated", { count: entry.count })}` : null}</span>
      ${action?.href ? html`<span><a class="btn btn-sm" href=${action.href} data-testid="notification-center.link">${label}</a></span>` : null}
      ${action?.apiCall ? (canRun
        ? html`<span><${Button} size="sm" onClick=${() => onAsk(entry)} testid="notification-center.run">${label}<//></span>`
        : html`<span class="xsmall muted">${t("notify.ownerOnly")}</span>`) : null}
    </div>
  </li>`;
}

// items: store entries; readAt: ISO of the last read; onRead() marks everything read; onRun(entry) performs the confirmed apiCall;
// browser { supported, enabled, onToggle } is the opt-in for desktop notifications, or null.
export function NotificationCenter({ items = [], readAt = null, onRead, canRun = false, onRun, browser = null, now = Date.now(), testid }) {
  const { t, pick } = useT();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(null);
  const unread = unreadCount(items, readAt);

  function openDrawer() {
    setOpen(true);
    onRead?.();
  }

  const call = asking?.action?.apiCall;
  return html`<span data-testid=${testid || "notification-center.root"}>
    <button type="button" class="btn btn-ghost btn-icon bell" aria-label=${t("notify.bell", { n: unread })} aria-haspopup="dialog" onClick=${openDrawer} data-testid="notification-center.bell">
      <${Icon} name="bell" />${unread ? html`<span class="bell-count" aria-hidden="true" data-testid="notification-center.count">${unread > 99 ? "99+" : unread}</span>` : null}
    </button>
    <${Drawer} open=${open} title=${t("notify.title")} width=${480} onClose=${() => setOpen(false)} testid="notification-center.drawer"
      footer=${browser?.supported ? html`<label class="check"><input type="checkbox" checked=${browser.enabled} onChange=${(event) => browser.onToggle?.(event.currentTarget.checked)} data-testid="notification-center.browser" />${t("notify.browser")}</label>` : null}>
      ${items.length
        ? html`<ul class="notify-list" onClick=${(event) => {
          if (event.target.closest?.("a[href]")) setOpen(false);
        }}>${items.map((entry) => html`<${Item} key=${entry.id} entry=${entry} canRun=${canRun} onAsk=${setAsking} now=${now} />`)}</ul>`
        : html`<p class="muted" data-testid="notification-center.empty">${t("notify.empty")}</p>`}
    <//>
    <${ConfirmDialog} open=${Boolean(call)} title=${t("notify.confirm.title")} body=${call ? t("notify.confirm.body", { method: call.method.toUpperCase(), path: call.path }) : ""}
      details=${asking ? [pick(asking.action.label), pick(asking.title)] : []} confirmLabel=${asking ? pick(asking.action.label) : ""}
      onConfirm=${async () => {
        await onRun?.(asking);
      }} onClose=${() => setAsking(null)} testid="notification-center.confirm" />
  </span>`;
}
