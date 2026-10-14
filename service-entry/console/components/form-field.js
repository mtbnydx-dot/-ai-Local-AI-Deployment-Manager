// FormField (07 §4.4, §9): label, control, unit, help, hint, warning and error
// wired together. `children` is either an element the caller labels with the
// same `id`, or a function receiving the control props
// ({ id, aria-describedby, aria-invalid, required, disabled }) so the wiring
// cannot be forgotten. Errors and units are in aria-describedby; the control is
// disabled while `locked`, and the lock reason stays visible.

import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useId } from "../ui/vendor.js";
import { Button } from "./button.js";
import { HelpPopover } from "./help-popover.js";
import { Icon } from "./icon.js";

// help is text or HelpPopover props; locked { reason } disables the control.
export function FormField({ id, label, unit, help, required = false, error, warning, changed = false, onReset, provenance, locked, hint, testid, children }) {
  const { t, has } = useT();
  const auto = useId();
  const fieldId = id || auto;
  const ids = { hint: `${fieldId}-hint`, unit: `${fieldId}-unit`, warn: `${fieldId}-warn`, error: `${fieldId}-error`, lock: `${fieldId}-lock` };
  const described = [hint && ids.hint, unit && ids.unit, warning && ids.warn, locked && ids.lock, error && ids.error].filter(Boolean).join(" ");
  const controlProps = {
    id: fieldId,
    "aria-describedby": described || undefined,
    "aria-invalid": error ? "true" : undefined,
    required: required || undefined,
    disabled: locked ? true : undefined,
  };
  const helpProps = typeof help === "string" ? { what: help } : help;
  const chip = provenance ? (has(tk("common.provenance.", provenance)) ? t(tk("common.provenance.", provenance)) : provenance) : null;
  return html`<div class="field" data-changed=${changed ? "true" : undefined} data-testid=${testid || "form-field.root"}>
    <div class="row-nowrap field-head">
      <label class="field-label" for=${fieldId}>${label}${required ? html`<span class="field-required" aria-hidden="true"> *</span>` : null}</label>
      ${changed ? html`<span class="field-changed" role="img" aria-label=${t("common.modified")} data-testid="form-field.changed"></span>` : null}
      ${chip ? html`<span class="badge badge-neutral">${chip}</span>` : null}
      <span class="spacer"></span>
      ${changed && onReset ? html`<${Button} variant="ghost" size="sm" onClick=${onReset} testid="form-field.reset">${t("common.resetDefault")}<//>` : null}
      ${helpProps ? html`<${HelpPopover} ...${helpProps} label=${helpProps.label || (typeof label === "string" ? t("common.helpFor", { name: label }) : undefined)} />` : null}
    </div>
    ${hint ? html`<div id=${ids.hint} class="field-hint">${hint}</div>` : null}
    <div class="field-control">
      ${typeof children === "function" ? children(controlProps) : children}
      ${unit ? html`<span id=${ids.unit} class="field-unit">${unit}</span>` : null}
    </div>
    ${locked ? html`<div id=${ids.lock} class="field-hint"><${Icon} name="lock" size="sm" /> ${t("common.locked")}${locked.reason ? `: ${locked.reason}` : ""}</div>` : null}
    ${warning ? html`<div id=${ids.warn} class="field-warning"><${Icon} name="triangle-alert" size="sm" /> ${warning}</div>` : null}
    ${error ? html`<div id=${ids.error} class="field-error" data-testid="form-field.error"><${Icon} name="circle-x" size="sm" /> ${error}</div>` : null}
  </div>`;
}
