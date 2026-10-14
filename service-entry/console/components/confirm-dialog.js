// ConfirmDialog (07 §4.4, §9): the confirmation every destructive action goes
// through. Initial focus is the type-to-confirm field when there is one,
// otherwise Cancel for a danger dialog and Confirm for a default one. Confirm
// stays disabled until the typed text matches exactly; while onConfirm runs
// the button is busy and Esc is ignored; a failure keeps the dialog open and
// shows the error. Focus returns to the opener on close (Modal).

import { describeError } from "../lib/api.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { Dialog } from "./dialog.js";

// typeToConfirm is compared exactly; onConfirm resolving closes via onClose('confirmed'), rejecting keeps it open.
export function ConfirmDialog({ open, title, body, details = [], confirmLabel, cancelLabel, tone = "default", typeToConfirm, onConfirm, onClose, testid }) {
  const i18n = useT();
  const { t } = i18n;
  const id = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  const danger = tone === "danger";
  const matches = !typeToConfirm || typed === typeToConfirm;
  async function confirm() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm?.();
      if (alive.current) setBusy(false);
      onClose?.("confirmed");
    } catch (failure) {
      if (alive.current) {
        setBusy(false);
        setError(failure);
      }
    }
  }
  const footer = html`
    <${Button} onClick=${() => onClose?.("cancel")} disabled=${busy} testid="dialog.cancel" data-autofocus=${!typeToConfirm && danger ? "" : undefined}>${cancelLabel || t("common.cancel")}<//>
    <${Button} variant=${danger ? "danger" : "primary"} onClick=${confirm} busy=${busy} disabled=${!matches} testid="dialog.confirm"
      data-autofocus=${!typeToConfirm && !danger ? "" : undefined}>${confirmLabel || t("common.confirm")}<//>`;
  return html`<${Dialog} open=${open} title=${title} tone=${tone} dismissible=${!busy} onClose=${onClose} footer=${footer} testid=${testid || "confirm-dialog.root"}>
    ${body ? html`<p>${body}</p>` : null}
    ${details.length ? html`<ul class="confirm-details">${details.map((line, index) => html`<li key=${index}>${line}</li>`)}</ul>` : null}
    ${typeToConfirm ? html`<div class="field confirm-type">
      <label class="field-label" for=${`${id}-in`}>${t("common.typeToConfirm")} <code class="code-inline" data-testid="dialog.expected">${typeToConfirm}</code></label>
      <input id=${`${id}-in`} class="input mono" data-autofocus autocomplete="off" autocapitalize="off" spellcheck="false" value=${typed} disabled=${busy}
        onInput=${(event) => setTyped(event.currentTarget.value)}
        onKeyDown=${(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            confirm();
          }
        }} data-testid="dialog.input" />
    </div>` : null}
    ${error ? html`<p class="field-error" role="alert" data-testid="dialog.error">${describeError(error, i18n)}</p>` : null}
  <//>`;
}
