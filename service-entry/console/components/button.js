// Button (07 §4.4): a <button>, or an <a> when `href` is given. A busy button
// stays focusable (aria-disabled) so a running confirmation keeps its focus.

import { html } from "../ui/html.js";
import { Icon } from "./icon.js";

// variant default|primary|danger|ghost; busy keeps focus (aria-disabled); elRef is the DOM ref.
export function Button({ variant = "default", size, icon, iconOnly = false, label, busy = false, disabled = false, href, type = "button", onClick, elRef, testid, class: extra = "", children, ...rest }) {
  const className = `btn${variant === "default" ? "" : ` btn-${variant}`}${size === "sm" ? " btn-sm" : ""}${iconOnly ? " btn-icon" : ""}${extra ? ` ${extra}` : ""}`;
  const lead = busy ? html`<span class="spinner" aria-hidden="true"></span>` : icon ? html`<${Icon} name=${icon} />` : null;
  const common = { class: className, "aria-label": label || undefined, "data-testid": testid || "button.root", ref: elRef, ...rest };
  if (href && !disabled) return html`<a ...${common} href=${href}>${lead}${children}</a>`;
  return html`<button ...${common} type=${type} disabled=${disabled} aria-busy=${busy ? "true" : undefined} aria-disabled=${busy ? "true" : undefined}
    onClick=${(event) => (busy ? event.preventDefault() : onClick?.(event))}>${lead}${children}</button>`;
}
