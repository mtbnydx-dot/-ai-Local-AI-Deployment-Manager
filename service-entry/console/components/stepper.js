// Stepper (07 §4.4): an ordered list of phases. The active step carries
// aria-current="step", and every state is also written as text. The pulse on
// the active dot stops under prefers-reduced-motion (components.css).

import { tk } from "../lib/i18n.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Icon } from "./icon.js";

const ICON = Object.freeze({ done: "check", error: "circle-x", skipped: "circle-minus" });

// steps [{ id, label, state, detail?, durationMs? }]; orientation horizontal|vertical.
export function Stepper({ steps = [], orientation = "horizontal", label, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<ol class=${`stepper${orientation === "vertical" ? " stepper-vertical" : ""}`} aria-label=${label} data-testid=${testid || "stepper.root"}>
    ${steps.map((step) => {
      const state = Object.hasOwn(ICON, step.state) || step.state === "active" ? step.state : "pending";
      return html`<li key=${step.id} class=${`step step-${state}`} aria-current=${state === "active" ? "step" : undefined} data-state=${state} data-testid="stepper.step">
        ${ICON[state] ? html`<${Icon} name=${ICON[state]} size="sm" />` : html`<span class="step-dot" aria-hidden="true"></span>`}
        <span>
          <span>${step.label}</span>
          <span class="xsmall step-state">· ${t(tk("common.step.", state))}</span>
          ${Number.isFinite(step.durationMs) ? html`<span class="xsmall muted num">· ${fmt.duration(step.durationMs)}</span>` : null}
          ${step.detail ? html`<span class="xsmall muted step-detail">${step.detail}</span>` : null}
        </span>
      </li>`;
    })}
  </ol>`;
}
