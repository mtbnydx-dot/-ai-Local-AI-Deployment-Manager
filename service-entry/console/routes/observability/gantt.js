// The lifecycle Gantt (04 §19 Models & instances): one row per instance, one
// bar per interval (loading, ready, sleeping, crashed). State is carried by
// the bar's pattern and by the legend text, never by color alone, and every
// row lists its intervals as text for screen readers.

import { GANTT_STATE_IDS } from "../../lib/observability-model.js";
import { tk } from "../../lib/i18n.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

export function Gantt({ model, window: windowText, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  const rows = model.rows.filter((row) => row.bars.length);
  const stateText = (state) => t(tk("obs.state.", state));
  if (!rows.length) return html`<p class="muted" role="status" data-testid=${testid ? `${testid}.empty` : "obs.gantt.empty"}>${t("obs.gantt.empty")}</p>`;
  return html`<div class="gantt" data-testid=${testid || "obs.gantt"}>
    <p class="small muted" data-window=${windowText || undefined}>${windowText || ""}</p>
    <ul class="gantt-legend small" aria-label=${t("obs.gantt.legend")}>
      ${GANTT_STATE_IDS.map((state) => html`<li key=${state}><span class=${`gantt-swatch gantt-${state}`} aria-hidden="true"></span>${stateText(state)}</li>`)}
    </ul>
    <ol class="gantt-rows">
      ${rows.map((row) => html`<li key=${row.key} class="gantt-row" data-fleet=${row.fleetId} data-testid="obs.gantt.row">
        <div class="gantt-label"><span data-user-content>${row.model || row.fleetId}</span>${row.model ? html` <span class="muted small mono" data-user-content>${row.fleetId}</span>` : null}</div>
        <div class="gantt-track" aria-hidden="true">
          ${row.bars.map((bar, index) => html`<span key=${index} class=${`gantt-bar gantt-${bar.state}`} data-state=${bar.state}
            style=${{ left: `${bar.left.toFixed(3)}%`, width: `${bar.width.toFixed(3)}%` }} title=${`${stateText(bar.state)} · ${fmt.dateTime(bar.from)} – ${fmt.dateTime(bar.to)}`}></span>`)}
        </div>
        <ul class="sr-only">${row.bars.map((bar, index) => html`<li key=${index}>${stateText(bar.state)}: ${fmt.dateTime(bar.from)} – ${fmt.dateTime(bar.to)}</li>`)}</ul>
      </li>`)}
    </ol>
    <p class="small muted gantt-range"><span>${fmt.dateTime(model.from)}</span><span>${fmt.dateTime(model.to)}</span></p>
  </div>`;
}
