// Toast (07 §4.4, §9) and the toast service (`services.toasts`, which
// ui/hooks.js useMutation pushes to).
//
// At most 3 are kept (the oldest non-error goes first). Success and info
// dismiss after 5 s, paused while the pointer or focus is inside; errors
// persist and offer Copy details. Roles: role=status, errors role=alert.

import { useServices } from "../ui/context.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { useCopy } from "./code-block.js";
import { Icon } from "./icon.js";

export const TOAST_MAX = 3;
export const TOAST_MS = 5000;
const LEVELS = Object.freeze({ success: "success", info: "info", warn: "warn", error: "error", danger: "error" });
const ICON = Object.freeze({ success: "circle-check", info: "info", warn: "triangle-alert", error: "circle-x" });

/** `{ level|tone, title, body|text, requestId, action }` → a normalized toast. */
export function normalizeToast(input, id) {
  const level = LEVELS[input?.level ?? input?.tone] || "info";
  return { id, level, title: input?.title || "", body: input?.body ?? input?.text ?? "", requestId: input?.requestId || null, action: input?.action || null };
}

/** The toast queue: { push(input) → id, dismiss(id), clear(), get(), subscribe(fn) → off }. */
export function createToasts({ max = TOAST_MAX } = {}) {
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
    push(input) {
      seq += 1;
      items = [...items, normalizeToast(input, seq)];
      while (items.length > max) {
        const drop = items.findIndex((item) => item.level !== "error");
        items = items.filter((_, index) => index !== (drop < 0 ? 0 : drop));
      }
      emit();
      return seq;
    },
    dismiss(id) {
      items = items.filter((item) => item.id !== id);
      emit();
    },
    clear() {
      items = [];
      emit();
    },
    get: () => items,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// Static without onDismiss; success and info close themselves.
export function Toast({ id, level = "info", title, body, requestId, action, onDismiss, testid }) {
  const { t } = useT();
  const [paused, setPaused] = useState(false);
  const [copied, copy] = useCopy();
  const left = useRef(TOAST_MS);
  const since = useRef(0);
  const persistent = level === "error" || level === "warn" || !onDismiss;
  useEffect(() => {
    if (persistent || paused) return undefined;
    since.current = Date.now();
    const timer = globalThis.setTimeout(() => onDismiss(id), left.current);
    return () => {
      globalThis.clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - since.current));
    };
  }, [paused, persistent, id]);
  const tone = level === "error" ? "danger" : level;
  return html`<div class=${`toast toast-${tone}`} role=${level === "error" ? "alert" : "status"} data-level=${level} data-testid=${testid || "toast.root"}
    onMouseEnter=${() => setPaused(true)} onMouseLeave=${() => setPaused(false)} onFocusIn=${() => setPaused(true)} onFocusOut=${() => setPaused(false)}>
    <${Icon} name=${ICON[level] || ICON.info} />
    <div class="grow stack-sm">
      ${title ? html`<strong>${title}</strong>` : null}
      ${body ? html`<span>${body}</span>` : null}
      ${requestId ? html`<span class="xsmall muted mono">${requestId}</span>` : null}
      ${action || level === "error" ? html`<div class="row">
        ${action ? html`<${Button} size="sm" href=${action.href} onClick=${action.onClick} testid="toast.action">${action.label}<//>` : null}
        ${level === "error" ? html`<${Button} size="sm" onClick=${() => copy([title, body, requestId].filter(Boolean).join("\n"))} testid="toast.copy">${copied === "copied" ? t("common.copied") : t("common.copyDetails")}<//>` : null}
      </div>` : null}
    </div>
    ${onDismiss ? html`<${Button} variant="ghost" size="sm" iconOnly icon="x" label=${t("common.dismiss")} onClick=${() => onDismiss(id)} testid="toast.dismiss" />` : null}
  </div>`;
}

/** The fixed region the AppShell mounts once; it renders `services.toasts`. */
export function ToastHost({ testid }) {
  const { toasts } = useServices();
  const [items, setItems] = useState(() => toasts?.get?.() || []);
  useEffect(() => {
    if (!toasts?.subscribe) return undefined;
    setItems(toasts.get());
    return toasts.subscribe(setItems);
  }, [toasts]);
  return html`<div class="toast-region" data-testid=${testid || "toast.region"}>
    ${items.map((item) => html`<${Toast} key=${item.id} ...${item} onDismiss=${toasts.dismiss} />`)}
  </div>`;
}
