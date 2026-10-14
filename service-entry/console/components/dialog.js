// Dialog (07 §4.4, §9) and Modal, the native <dialog> behaviour Drawer and
// ConfirmDialog share.
//
// Modal is mounted only while open: it calls showModal() (the browser traps
// focus and makes the page inert), moves focus to `initialFocus` when given,
// turns Esc and backdrop clicks into onRequestClose(reason), and on unmount
// closes the dialog and returns focus to the element that opened it.

import { html } from "../ui/html.js";
import { useId, useLayoutEffect, useRef } from "../ui/vendor.js";

// onRequestClose(reason) gets escape|backdrop; the parent decides to close. initialFocus is a selector (default [data-autofocus]).
export function Modal({ class: className, role, labelId, describedBy, onRequestClose, backdropCloses = true, initialFocus, testid, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = globalThis.document.activeElement;
    try {
      el.showModal();
    } catch {
      el.setAttribute("open", "");
    }
    el.querySelector(initialFocus || "[data-autofocus]")?.focus();
    return () => {
      try {
        el.close();
      } catch {
        // Already closed or detached.
      }
      if (opener?.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);
  return html`<dialog ref=${ref} class=${className} role=${role} aria-labelledby=${labelId} aria-describedby=${describedBy} data-testid=${testid}
    onCancel=${(event) => {
      event.preventDefault();
      onRequestClose?.("escape");
    }}
    onClick=${(event) => {
      if (event.target === event.currentTarget && backdropCloses) onRequestClose?.("backdrop");
    }}>${children}</dialog>`;
}

function DialogSheet({ title, tone, onClose, dismissible, footer, initialFocus, testid, children }) {
  const id = useId();
  const danger = tone === "danger";
  return html`<${Modal} class=${`dialog${danger ? " dialog-danger" : ""}`} role=${danger ? "alertdialog" : undefined} labelId=${`${id}-t`} describedBy=${`${id}-b`}
    backdropCloses=${!danger && dismissible} initialFocus=${initialFocus} testid=${testid || "dialog.root"}
    onRequestClose=${(reason) => dismissible && onClose?.(reason)}>
    <div class="overlay-head"><h2 id=${`${id}-t`} class="card-title">${title}</h2></div>
    <div class="overlay-body" id=${`${id}-b`}>${children}</div>
    ${footer ? html`<div class="overlay-foot">${footer}</div>` : null}
  <//>`;
}

// tone danger = alertdialog the backdrop never closes; dismissible=false ignores Esc while a request runs.
export function Dialog({ open, title, tone = "default", onClose, dismissible = true, footer, initialFocus, testid, children }) {
  return open ? html`<${DialogSheet} title=${title} tone=${tone} onClose=${onClose} dismissible=${dismissible} footer=${footer} initialFocus=${initialFocus} testid=${testid}>${children}<//>` : null;
}
