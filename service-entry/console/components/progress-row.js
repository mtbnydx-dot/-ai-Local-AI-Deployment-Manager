// ProgressRow (07 §4.4): one transfer or phase. The bar is a progressbar whose
// aria-valuetext carries percent, speed and ETA; `percent: null` (with no byte
// totals) is indeterminate.

import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useId } from "../ui/vendor.js";

// percent null = indeterminate; derived from bytes when omitted.
export function ProgressRow({ label, percent, bytesDone, bytesTotal, speedBps, etaSec, phase, actions, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  const id = useId();
  const derived = percent === undefined && bytesTotal > 0 ? (bytesDone / bytesTotal) * 100 : percent;
  const value = Number.isFinite(derived) ? Math.max(0, Math.min(100, derived)) : null;
  const rate = Number.isFinite(speedBps) ? `${fmt.bytes(speedBps)}/s` : null;
  const eta = Number.isFinite(etaSec) ? t("common.progress.eta", { time: fmt.duration(etaSec * 1000) }) : null;
  const sep = " · ";
  const valueText = [value === null ? t("common.progress.running") : fmt.percent(value / 100, 0), rate, eta].filter(Boolean).join(sep);
  const sizes = Number.isFinite(bytesDone) && bytesTotal > 0 ? `${fmt.bytes(bytesDone)} / ${fmt.bytes(bytesTotal)}` : null;
  return html`<div class="progress-row" data-testid=${testid || "progress-row.root"}>
    <div class="row-nowrap">
      <span id=${`${id}-l`} class="truncate">${label}</span>
      ${phase ? html`<span class="badge badge-neutral">${phase}</span>` : null}
    </div>
    <div class="row-nowrap">
      <span class="small muted num">${[sizes, rate, eta].filter(Boolean).join(sep)}</span>
      ${actions ? html`<span class="row-nowrap">${actions}</span>` : null}
    </div>
    <div class="progress" role="progressbar" aria-labelledby=${`${id}-l`} aria-valuemin="0" aria-valuemax="100"
      aria-valuenow=${value === null ? undefined : String(Math.round(value))} aria-valuetext=${valueText} data-testid="progress-row.bar">
      <div class=${`progress-bar${value === null ? " progress-indeterminate" : ""}`} style=${value === null ? undefined : { width: `${value}%` }}></div>
    </div>
  </div>`;
}
