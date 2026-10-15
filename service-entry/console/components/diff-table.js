// DiffTable (07 §4.4): current → new values for profile apply, recipe changes
// and comparison with the last launch. Removed values are struck through and
// new ones bold, so the change reads without color.

import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";

const text = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

/** @param rows [{ label, from, to, source?, reason? }]  @param caption table caption (visually hidden) */
export function DiffTable({ rows = [], caption, testid }) {
  const { t } = useT();
  const withSource = rows.some((row) => row.source);
  const withReason = rows.some((row) => row.reason);
  const columns = 3 + (withSource ? 1 : 0) + (withReason ? 1 : 0);
  return html`<div class="table-wrap" role="region" tabindex="0" aria-label=${caption || t("common.diff.caption")} data-testid=${testid || "diff-table.root"}>
    <table class="table diff-table">
      <caption class="sr-only">${caption || t("common.diff.caption")}</caption>
      <thead><tr>
        <th scope="col">${t("common.diff.setting")}</th><th scope="col">${t("common.diff.current")}</th><th scope="col">${t("common.diff.new")}</th>
        ${withSource ? html`<th scope="col">${t("common.diff.source")}</th>` : null}
        ${withReason ? html`<th scope="col">${t("common.diff.reason")}</th>` : null}
      </tr></thead>
      <tbody>
        ${rows.length ? rows.map((row, index) => {
          const changed = text(row.from) !== text(row.to);
          return html`<tr key=${index} data-changed=${changed ? "true" : "false"} data-testid="diff-table.row">
            <th scope="row">${row.label}</th>
            <td class=${changed ? "diff-del" : ""}>${text(row.from)}</td>
            <td class=${changed ? "diff-add" : ""}>${changed ? html`<strong>${text(row.to)}</strong>` : text(row.to)}</td>
            ${withSource ? html`<td class="muted">${row.source || ""}</td>` : null}
            ${withReason ? html`<td class="small" data-user-content="">${row.reason || ""}</td>` : null}
          </tr>`;
        }) : html`<tr><td colspan=${columns} class="muted">${t("common.diff.none")}</td></tr>`}
      </tbody>
    </table>
  </div>`;
}
