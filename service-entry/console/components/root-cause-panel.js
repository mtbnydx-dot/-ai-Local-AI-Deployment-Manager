// RootCausePanel (07 §4.4, 02 R-UI-6): the one failure card for a failed
// launch, probe or qualification. It renders the 00 §9.11 job error
// `{code, signatureId, phase, hint, logExcerpt}` (plus the optional `title`,
// `explanation` and `suggestions` 02 §14 adds); when the error carries no
// title or suggestions they come from the signature the page looked up by
// `signatureId`. The log excerpt is already redacted by the manager and sits in
// a CodeBlock. Suggestions are actions the page decides what to do with:
//
//   param    onApply(suggestion)   change a setting and go back to Review (never relaunches);
//                                  a `security` one asks first (ConfirmDialog)
//   probe    onProbe()             run the dry probe
//   runtime  runtimeHref           the engine's Runtimes tab
//
// `knobs` are the Apply chips of an admission failure (`details.knobs`).

import { LAUNCH_PHASES, failureView } from "../lib/launch-model.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useMemo, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { Card } from "./card.js";
import { CodeBlock } from "./code-block.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { StatusBadge } from "./status-badge.js";

const TITLE_KEY = Object.freeze({ launch: "models.rootCause.title", probe: "models.rootCause.titleProbe", qualify: "models.rootCause.titleQualify" });

function valueText(value) {
  if (value === true) return "on";
  if (value === false) return "off";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * @param error the job error object
 * @param signature the looked-up error signature entry, or null
 * @param kind launch | probe | qualify
 * @param catalog the engine's parameter catalog, for the names of parameters
 */
export function RootCausePanel({ error, signature = null, kind = "launch", catalog = null, onApply, onProbe, runtimeHref, knobs = [], onKnob, testid }) {
  const { t, tk, pick, has, locale } = useT();
  const view = useMemo(() => failureView(error, signature, locale), [error, signature, locale]);
  const [asking, setAsking] = useState(null);
  const labelOf = (id) => pick(catalog?.params?.find?.((param) => param?.id === id)?.label) || id;
  const coded = has(tk("engines.job.failure.", view.code)) ? t(tk("engines.job.failure.", view.code)) : "";
  const title = view.title || coded || view.message || view.code;
  const root = testid || "root-cause.root";

  const actions = [];
  for (const [index, suggestion] of view.suggestions.entries()) {
    if (suggestion.kind === "param" && onApply) {
      const to = suggestion.to === "planner" ? t("models.rootCause.planner") : valueText(suggestion.to);
      actions.push(html`<li key=${index} class="root-cause-action" data-kind="param" data-param=${suggestion.param} data-testid="root-cause.suggestion">
        <span class="grow"><strong>${labelOf(suggestion.param)}</strong> → <span class="mono" data-user-content="">${to}</span>
          ${suggestion.security ? html` <${StatusBadge} status="warn" label=${t("models.rootCause.security")} />` : null}</span>
        <${Button} size="sm" onClick=${() => (suggestion.security ? setAsking(suggestion) : onApply(suggestion))} testid="root-cause.apply">${t("models.rootCause.apply")}<//>
      </li>`);
    } else if (suggestion.kind === "probe" && onProbe) {
      actions.push(html`<li key=${index} class="root-cause-action" data-kind="probe" data-testid="root-cause.suggestion">
        <span class="grow">${t("models.rootCause.probeHint")}</span>
        <${Button} size="sm" onClick=${onProbe} testid="root-cause.probe">${t("models.rootCause.probe")}<//>
      </li>`);
    } else if (suggestion.kind === "runtime" && runtimeHref) {
      actions.push(html`<li key=${index} class="root-cause-action" data-kind="runtime" data-testid="root-cause.suggestion">
        <span class="grow">${t("models.rootCause.runtimeHint")}</span>
        <${Button} size="sm" href=${runtimeHref} testid="root-cause.runtime">${t("models.rootCause.runtime")}<//>
      </li>`);
    }
  }
  for (const [index, knob] of knobs.entries()) {
    if (!onKnob) break;
    actions.push(html`<li key=${`k${index}`} class="root-cause-action" data-kind="knob" data-param=${knob.param} data-testid="root-cause.knob">
      <span class="grow"><strong>${labelOf(knob.param)}</strong> → <span class="mono">${valueText(knob.suggestion)}</span></span>
      <${Button} size="sm" onClick=${() => onKnob(knob)} testid="root-cause.knob-apply">${t("models.rootCause.useValue", { value: valueText(knob.suggestion) })}<//>
    </li>`);
  }

  return html`<${Card} title=${t(TITLE_KEY[kind] || TITLE_KEY.launch)} tone="danger" testid=${root}>
    <div class="stack-sm" role="alert" data-code=${view.code} data-signature=${view.signatureId || ""} data-phase=${view.phase || ""}>
      <p class="root-cause-title"><strong data-user-content="" data-testid="root-cause.title">${title}</strong></p>
      ${view.phase ? html`<p class="small" data-testid="root-cause.phase"><${StatusBadge} status="error" label=${t("models.rootCause.failedIn", { phase: LAUNCH_PHASES.includes(view.phase) ? t(tk("engines.phase.", view.phase)) : view.phase })} /></p>` : null}
      ${view.hint ? html`<p data-user-content="" data-testid="root-cause.hint">${view.hint}</p>` : null}
      ${view.explanation ? html`<p class="small muted" data-user-content="" data-testid="root-cause.explanation">${view.explanation}</p>` : null}
      ${view.logExcerpt ? html`<div class="stack-sm"><p class="small muted">${t("models.rootCause.log")}</p><${CodeBlock} code=${view.logExcerpt} wrap testid="root-cause.log" /></div>` : null}
      ${actions.length ? html`<ul class="stack-sm root-cause-actions" aria-label=${t("models.rootCause.actions")} data-testid="root-cause.actions">${actions}</ul>` : null}
      <p class="xsmall muted">
        ${view.signatureId ? html`${t("models.rootCause.signature")} <code class="code-inline mono" data-testid="root-cause.signature">${view.signatureId}</code> · ` : null}
        <code class="code-inline mono" data-testid="root-cause.code">${view.code}</code>
      </p>
    </div>
    <${ConfirmDialog} open=${Boolean(asking)} testid="root-cause.security" tone="danger" title=${t("models.rootCause.securityTitle")}
      body=${asking ? t("models.rootCause.securityBody", { param: labelOf(asking.param), value: valueText(asking.to) }) : ""}
      confirmLabel=${t("models.rootCause.securityConfirm")} cancelLabel=${t("common.cancel")}
      onConfirm=${() => onApply?.(asking)} onClose=${() => setAsking(null)} />
  <//>`;
}
