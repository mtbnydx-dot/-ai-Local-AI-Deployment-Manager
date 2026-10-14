// HelpPopover (07 §4.4): non-modal help beside a field. The trigger carries
// aria-expanded; Esc closes it and returns focus to the trigger, a pointer
// press outside closes it, and below sm it is a bottom sheet (components.css).
// Content is the "what / when to change / trade-offs / flag / docs" set of the
// parameter catalog, so help never has to be a wall of notes on the page.

import { safeUrl } from "../lib/url.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId, useRef, useState } from "../ui/vendor.js";
import { Icon } from "./icon.js";

// what, whenToChange, tradeoffs, flag, docs; label names the trigger.
export function HelpPopover({ what, whenToChange, tradeoffs, flag, docs, label, onToggle, testid }) {
  const { t } = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const name = label || t("common.helpButton");
  const href = docs ? safeUrl(docs) : null;

  function toggle(next) {
    setOpen(next);
    onToggle?.(next);
  }

  useEffect(() => {
    if (!open) return undefined;
    const doc = globalThis.document;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      // Esc closes the popover only, not a dialog around it.
      event.preventDefault();
      event.stopPropagation();
      toggle(false);
      trigger.current?.focus();
    };
    const onPress = (event) => {
      if (!wrap.current?.contains(event.target)) toggle(false);
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onPress, true);
    return () => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onPress, true);
    };
  }, [open]);

  return html`<span class="popover-wrap" ref=${wrap} data-testid=${testid || "help-popover.root"}>
    <button type="button" ref=${trigger} class="btn btn-ghost btn-sm btn-icon" aria-label=${name} aria-expanded=${open ? "true" : "false"} aria-controls=${open ? id : undefined}
      onClick=${() => toggle(!open)} data-testid="help-popover.trigger"><${Icon} name="circle-help" /></button>
    ${open ? html`<div id=${id} class="popover" role="group" aria-label=${name} data-testid="help-popover.panel">
      ${what ? html`<p>${what}</p>` : null}
      <dl class="help-list">
        ${whenToChange ? html`<dt>${t("common.help.whenToChange")}</dt><dd>${whenToChange}</dd>` : null}
        ${tradeoffs ? html`<dt>${t("common.help.tradeoffs")}</dt><dd>${tradeoffs}</dd>` : null}
        ${flag ? html`<dt>${t("common.help.flag")}</dt><dd><code class="code-inline">${flag}</code></dd>` : null}
      </dl>
      ${href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${t("common.help.docs")}</a>` : null}
    </div>` : null}
  </span>`;
}
