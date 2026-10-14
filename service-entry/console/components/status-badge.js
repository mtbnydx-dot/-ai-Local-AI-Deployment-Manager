// StatusBadge (07 §4.4): icon plus text, never color alone. `unknown` is grey
// and never reads as healthy.

import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Icon } from "./icon.js";

const STATUS = Object.freeze({
  ok: ["circle-check", "badge-success"],
  warn: ["triangle-alert", "badge-warn"],
  error: ["circle-x", "badge-danger"],
  info: ["info", "badge-info"],
  neutral: ["circle-minus", "badge-neutral"],
  unknown: ["circle-help", "badge-neutral"],
  loading: ["loader-circle", "badge-neutral"],
});

/** @param status ok | warn | error | info | neutral | unknown | loading (anything else is unknown) */
export function StatusBadge({ status = "unknown", label, testid }) {
  const { t } = useT();
  const key = Object.hasOwn(STATUS, status) ? status : "unknown";
  const [icon, tone] = STATUS[key];
  return html`<span class=${`badge ${tone}`} data-status=${key} data-testid=${testid || "status-badge.root"}>
    <${Icon} name=${icon} spin=${key === "loading"} />
    <span>${label || t(tk("common.badge.", key))}</span>
  </span>`;
}
