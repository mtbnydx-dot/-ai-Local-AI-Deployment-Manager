// Transient messages, announced politely and gone after a few seconds.

import { html } from "../lib/html.js";

export function ToastRegion({ toasts, onDismiss, closeLabel }) {
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((item) => html`<div class=${`toast toast-${item.kind}`} key=${item.id}>
      <span>${item.message}</span>
      <button type="button" class="toast-close" aria-label=${closeLabel} onClick=${() => onDismiss(item.id)}>×</button>
    </div>`)}
  </div>`;
}
