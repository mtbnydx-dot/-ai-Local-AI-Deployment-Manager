// A modal confirmation on the native <dialog> element: focus moves into it,
// Escape and the Cancel button close it, and focus returns to the opener.

import { useEffect, useRef } from "preact/hooks";
import { html } from "../lib/html.js";

/** ConfirmDialog({ open, title, body, confirmLabel, cancelLabel, busy, onConfirm, onCancel, tone }) */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel, busy = false, onConfirm, onCancel, testid }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (open && !element.open) {
      try {
        element.showModal();
      } catch {
        element.setAttribute("open", "");
      }
    }
    if (!open && element.open) element.close();
    return undefined;
  }, [open]);
  return html`<dialog ref=${dialog} class="dialog" data-testid=${testid} aria-labelledby="dialog-title" onCancel=${(event) => {
    event.preventDefault();
    if (!busy) onCancel();
  }} onClose=${() => open && !busy && onCancel()}>
    <h2 id="dialog-title">${title}</h2>
    <div class="dialog-body">${children}</div>
    <div class="dialog-actions">
      <button type="button" class="btn" disabled=${busy} onClick=${onCancel} autofocus>${cancelLabel}</button>
      <button type="button" class="btn btn-primary" disabled=${busy} onClick=${onConfirm}>${confirmLabel}</button>
    </div>
  </dialog>`;
}
