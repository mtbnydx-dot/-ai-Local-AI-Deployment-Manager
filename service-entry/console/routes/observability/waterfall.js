// The request timeline waterfall (04 §11.6, §19 Requests › detail): one row
// per interval between two neighbouring marks of the request (queued in the
// gateway, waiting for the engine, time to the first token, generating), drawn
// as a bar positioned on the request's own time axis. Each row also states its
// duration and share in words, and the marks are listed in a table, so the
// picture is never the only carrier of the numbers.

import { tk } from "../../lib/i18n.js";
import { waterfallModel } from "../../lib/requests-model.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

const KINDS = new Set(["queue", "upstream", "prefill", "decode", "response", "other"]);

/** @param detail the GET /api/telemetry/requests/:id answer */
export function Waterfall({ detail, testid }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const model = waterfallModel(detail);
  const markText = (mark) => (has(tk("obs.req.mark.", mark)) ? t(tk("obs.req.mark.", mark)) : mark);
  if (!model.marks.length) {
    return html`<p class="muted" role="status" data-testid=${testid ? `${testid}.empty` : "obs.waterfall.empty"}>${t("obs.req.noTimeline")}</p>`;
  }
  const summary = model.segments.map((segment) => `${t(tk("obs.req.seg.", segment.kind))} ${fmt.duration(segment.durationMs)}`).join(", ");
  return html`<div class="waterfall" data-testid=${testid || "obs.waterfall"}>
    <p class="small muted" data-testid="obs.waterfall.total">${t("obs.req.total", { value: fmt.duration(model.totalMs) })}</p>
    <ol class="wf-rows" aria-label=${`${t("obs.req.waterfall")}: ${summary}`}>
      ${model.segments.map((segment, index) => {
        const kind = KINDS.has(segment.kind) ? segment.kind : "other";
        return html`<li key=${index} class="wf-row" data-kind=${kind} data-from=${segment.from} data-to=${segment.to} data-testid="obs.waterfall.row">
          <span class="wf-label">${t(tk("obs.req.seg.", kind))}</span>
          <span class="wf-track" aria-hidden="true">
            <span class=${`wf-bar wf-${kind}`} data-testid="obs.waterfall.bar"
              style=${{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }}></span>
          </span>
          <span class="wf-value tabular">${fmt.duration(segment.durationMs)}<span class="muted small"> · ${fmt.percent(model.totalMs > 0 ? segment.durationMs / model.totalMs : null, 1)}</span></span>
        </li>`;
      })}
    </ol>
    <div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.req.marks") })}>
      <table class="table" data-testid="obs.waterfall.marks">
        <caption class="sr-only">${t("obs.req.marks")}</caption>
        <thead><tr><th scope="col">${t("obs.req.col.mark")}</th><th scope="col" class="num">${t("obs.req.col.offset")}</th></tr></thead>
        <tbody>${model.marks.map((mark, index) => html`<tr key=${index} data-mark=${mark.mark}>
          <td>${markText(mark.mark)}</td><td class="num tabular">${fmt.duration(mark.offsetMs)}</td>
        </tr>`)}</tbody>
      </table>
    </div>
  </div>`;
}
