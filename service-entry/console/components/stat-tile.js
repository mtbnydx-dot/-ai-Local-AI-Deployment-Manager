// StatTile (07 §4.4, §4.3): a number with its unit and, always, the window it
// aggregates over (rendered as [data-window]; a dev warning when missing).
// Delta direction is paired with text, and `goodWhen` decides its tone.

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { StatusBadge } from "./status-badge.js";

let warned = false;

function sparkPoints(values, width = 96, height = 24) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (nums.length < 2) return "";
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min || 1;
  return nums.map((value, index) => `${((index / (nums.length - 1)) * width).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
}

// window is required; delta { value, goodWhen: up|down }; sparkline number[]; note is one line of context under the value.
export function StatTile({ label, value, unit, window: windowText, denominator, delta, sparkline, status, href, note, testid }) {
  const { t } = useT();
  if (!windowText && !warned) {
    warned = true;
    globalThis.console?.warn?.("StatTile: `window` is required (07 §4.3)");
  }
  const shown = value === null || value === undefined || value === "" ? "—" : String(value);
  const good = delta && delta.value !== 0 ? (delta.value > 0) === (delta.goodWhen !== "down") : null;
  const points = Array.isArray(sparkline) ? sparkPoints(sparkline) : "";
  return html`<div class="stat-tile" data-status=${status} data-testid=${testid || "stat-tile.root"}>
    <div class="row-nowrap">
      <div class="stat-label grow">${href ? html`<a href=${href}>${label}</a>` : label}</div>
      ${status ? html`<${StatusBadge} status=${status} />` : null}
    </div>
    <div class="stat-value">
      <data value=${shown} data-testid="stat-tile.value">${shown}</data>
      ${unit ? html`<span class="stat-unit">${unit}</span>` : null}
      ${denominator ? html`<span class="stat-unit">/ ${denominator.value} ${denominator.label}</span>` : null}
    </div>
    ${note ? html`<div class="stat-note small muted" data-testid="stat-tile.note">${note}</div>` : null}
    ${delta ? html`<div class=${`stat-delta small ${good === null ? "muted" : good ? "text-success" : "text-danger"}`}>
      <span aria-hidden="true">${delta.value > 0 ? "▲" : delta.value < 0 ? "▼" : "▬"}</span>
      ${delta.text || `${delta.value > 0 ? "+" : ""}${delta.value}`}
      ${good === null ? null : html`<span class="sr-only">${t(good ? "common.delta.better" : "common.delta.worse")}</span>`}
    </div>` : null}
    ${points ? html`<svg class="stat-spark" viewBox="0 0 96 24" aria-hidden="true" focusable="false"><polyline points=${points} /></svg>` : null}
    ${windowText ? html`<div class="stat-window" data-window=${windowText} data-testid="stat-tile.window">${windowText}</div>` : null}
  </div>`;
}
