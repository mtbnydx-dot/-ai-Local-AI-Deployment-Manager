// ChecksList (07 §4.4, 05 §13.5 step 5): the live checks of an exposure report.
// Each row has the state as a badge, the check's title and evidence, and, unless
// the check passes, a fix hint. The title and fix are catalog keys the scanner
// sends (`access.check.<id>`, `access.fix.<id>`); an unknown key falls back to
// the id. `renderAction(check)` lets the page add a button to one row (for
// example "trust this proxy" on trusted_proxy_match).

import { badgeFor, summarizeChecks } from "../lib/exposure-model.js";
import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { StatusBadge } from "./status-badge.js";

/** @param checks `report.checks`  @param renderAction (check) → node | null */
export function ChecksList({ checks = [], renderAction, testid }) {
  const { t, has } = useT();
  const list = Array.isArray(checks) ? checks : [];
  const summary = summarizeChecks(list);
  const text = (key, fallback) => (typeof key === "string" && has(key) ? t(key) : fallback);
  return html`<div class="stack-sm" data-testid=${testid || "checks-list.root"}>
    <p class="small" role="status" data-testid="checks-list.summary">${t("public.checks.summary", { ok: summary.ok + summary.manual, warn: summary.warn + summary.unknown, fail: summary.fail })}</p>
    <ul class="checks" aria-label=${t("public.checks.label")}>
      ${list.map((check) => html`<li key=${check.id} class="check-row" data-check=${check.id} data-state=${check.state} data-testid="checks-list.item">
        <div class="row">
          <${StatusBadge} status=${badgeFor(check.state)} label=${t(tk("public.state.", check.state))} />
          <strong class="grow" data-testid="checks-list.title">${text(check.title, check.id)}</strong>
          ${renderAction ? renderAction(check) : null}
        </div>
        ${check.evidence ? html`<p class="small muted check-evidence" data-user-content data-testid="checks-list.evidence">${check.evidence}</p>` : null}
        ${check.state !== "ok" && check.fix ? html`<p class="small check-fix" data-testid="checks-list.fix">${text(check.fix, "")}</p>` : null}
      </li>`)}
    </ul>
  </div>`;
}
