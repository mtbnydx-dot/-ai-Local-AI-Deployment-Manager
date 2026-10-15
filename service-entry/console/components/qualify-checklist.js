// QualifyChecklist (07 §6.2, 02 R-UI-5): the checks of one qualification run,
// each with its status and detail. The rows come from lib/qualify-model.js
// `checkRows` (the relayed `model-qualify` job while it runs, the stored host
// record once it is written). A check id that has no `models.qualify.check.*`
// entry shows the id itself; the detail is backend text in the user's language.
// The list is a polite live region, so a screen reader hears each check settle.

import { STATUS_BADGE, summarize } from "../lib/qualify-model.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { ProgressRow } from "./progress-row.js";
import { StatusBadge } from "./status-badge.js";

/**
 * @param rows checkRows(...)
 * @param running the job is still running
 * @param percent job progress 0..100 or null
 * @param durationMs the run's duration, when known
 */
export function QualifyChecklist({ rows = [], running = false, percent = null, durationMs = null, testid }) {
  const { t, tk, pick, has } = useT();
  const fmt = useFormat();
  const summary = summarize(rows);
  const settled = summary.pass + summary.warn + summary.fail + summary.skip;
  return html`<div class="stack-sm" data-testid=${testid || "qualify-checklist.root"} data-running=${running ? "true" : "false"}>
    ${running ? html`<${ProgressRow} label=${t("models.qualify.running")} percent=${percent} testid="qualify-checklist.progress" />` : null}
    ${rows.length ? html`<p class="small muted" role="status" data-testid="qualify-checklist.summary">
      ${t("models.qualify.summary", { pass: summary.pass, warn: summary.warn, fail: summary.fail, skip: summary.skip })}${durationMs !== null ? ` · ${fmt.duration(durationMs)}` : ""}
    </p>` : null}
    <ul class="checks" aria-label=${t("models.qualify.checks")} aria-live="polite" data-settled=${settled} data-testid="qualify-checklist.list">
      ${rows.map((row) => {
        const key = tk("models.qualify.check.", row.id);
        const detail = pick(row.detail);
        return html`<li key=${row.id} class="check-row" data-check=${row.id} data-status=${row.status} data-testid="qualify-checklist.item">
          <div class="row">
            <${StatusBadge} status=${STATUS_BADGE[row.status] || "unknown"} label=${t(tk("models.qualify.status.", row.status))} />
            <strong class="grow" data-testid="qualify-checklist.title">${has(key) ? t(key) : row.id}</strong>
            <code class="code-inline small muted">${row.id}</code>
          </div>
          ${detail ? html`<p class="small check-evidence" data-user-content="" data-testid="qualify-checklist.detail">${detail}</p>` : null}
        </li>`;
      })}
    </ul>
  </div>`;
}
