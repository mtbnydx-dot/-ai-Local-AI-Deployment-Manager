// Gauges and pace bars for My Key (05 §12.5). Both are SVG drawn with
// attributes only (the CSP forbids inline style attributes) and both state
// their numbers in words, so colour is never the only signal.

import { html } from "../lib/html.js";

const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** ok above a fifth left, warn below it, bad at nothing left. */
export function gaugeTone(value, max) {
  if (!(max > 0)) return "idle";
  if (value <= 0) return "bad";
  return value / max < 0.2 ? "warn" : "ok";
}

/**
 * A ring that shows `value` of `max`. `value` null draws an empty ring with
 * only the capacity text (a limit whose live value the service does not report).
 *   Gauge({ label, value, max, valueText, maxText, caption, tone, testid })
 */
export function Gauge({ label, value, max, valueText, maxText, caption, tone, testid }) {
  const known = value !== null && value !== undefined && Number.isFinite(Number(value));
  const fraction = known && max > 0 ? Math.min(1, Math.max(0, Number(value) / max)) : 0;
  const state = tone || (known ? gaugeTone(Number(value), max) : "idle");
  const aria = known
    ? { role: "meter", "aria-valuemin": "0", "aria-valuemax": String(max), "aria-valuenow": String(value), "aria-valuetext": `${valueText}${maxText ? ` / ${maxText}` : ""}` }
    : { role: "group" };
  return html`<div class=${`gauge gauge-${state}`} data-testid=${testid} aria-label=${label} ...${aria}>
    <svg class="gauge-ring" viewBox="0 0 100 100" width="104" height="104" aria-hidden="true" focusable="false">
      <circle class="gauge-track" cx="50" cy="50" r=${RADIUS} fill="none" stroke-width="10" />
      ${fraction > 0 ? html`<circle class="gauge-fill" cx="50" cy="50" r=${RADIUS} fill="none" stroke-width="10" stroke-linecap="round"
        stroke-dasharray=${`${(fraction * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`} transform="rotate(-90 50 50)" />` : null}
    </svg>
    <div class="gauge-text">
      <span class="gauge-label">${label}</span>
      <span class="gauge-value"><strong>${valueText}</strong>${maxText ? html` <span class="gauge-max">/ ${maxText}</span>` : null}</span>
      ${caption ? html`<span class="gauge-caption muted small">${caption}</span>` : null}
    </div>
  </div>`;
}

/**
 * A quota bar with a marker where an even spend would be by now.
 *   PaceBar({ label, usedFraction, markerFraction, pace, valueText, testid })
 * `pace` is ok | ahead | exhausted (05 §8.5).
 */
export function PaceBar({ label, used, limit, usedFraction, markerFraction, pace = "ok", valueText, markerLabel, testid }) {
  const marker = markerFraction === null || markerFraction === undefined ? null : Math.min(1, Math.max(0, markerFraction));
  return html`<div class=${`pace pace-${pace}`} data-testid=${testid} data-pace=${pace}>
    <div class="pace-head"><span class="pace-label">${label}</span><span class="pace-value">${valueText}</span></div>
    <div role="meter" aria-label=${label} aria-valuemin="0" aria-valuemax=${String(limit)} aria-valuenow=${String(Math.min(used, limit))} aria-valuetext=${valueText}>
      <svg class="pace-bar" viewBox="0 0 100 12" preserveAspectRatio="none" width="100%" height="14" aria-hidden="true" focusable="false">
        <rect class="pace-track" x="0" y="0" width="100" height="12" rx="3" />
        <rect class="pace-fill" x="0" y="0" width=${(Math.min(1, Math.max(0, usedFraction)) * 100).toFixed(2)} height="12" rx="3" />
        ${marker !== null ? html`<line class="pace-marker" x1=${(marker * 100).toFixed(2)} x2=${(marker * 100).toFixed(2)} y1="-1" y2="13" vector-effect="non-scaling-stroke" stroke-width="2" />` : null}
      </svg>
    </div>
    ${markerLabel ? html`<p class="pace-note muted small">${markerLabel}</p>` : null}
  </div>`;
}
