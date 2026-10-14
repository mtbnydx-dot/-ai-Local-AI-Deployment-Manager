// EmptyState (07 §4.4, §4.3): every empty state names its next action, so
// `action` is required (a dev warning when missing).

import { h, html } from "../ui/html.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";

let warned = false;

// action { label, href | onClick } is required.
export function EmptyState({ icon = "info", title, body, action, level = 3, testid }) {
  if (!action && !warned) {
    warned = true;
    globalThis.console?.warn?.("EmptyState: `action` is required (07 §4.3)");
  }
  return html`<div class="empty-state" data-testid=${testid || "empty-state.root"}>
    <${Icon} name=${icon} size="lg" />
    ${h(`h${level}`, { "data-testid": "empty-state.title" }, title)}
    ${body ? html`<p>${body}</p>` : null}
    ${action ? html`<${Button} variant="primary" href=${action.href} onClick=${action.onClick} testid="empty-state.action">${action.label}<//>` : null}
  </div>`;
}
