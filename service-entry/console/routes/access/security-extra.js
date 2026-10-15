// The read-only cards of the Security page (05 §13.6): recent `security.*`
// events, and the legacy findings of the exposure scan. Legacy findings are
// reported, never acted on: each one offers its suggested command to copy and
// there is no delete, move or stop control anywhere in this module.

import { severityBadge } from "../../lib/exposure-model.js";
import { tk } from "../../lib/i18n.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

const EVENT_KINDS = Object.freeze(["ban", "unban", "direct_manager_gateway", "admin_via_proxy", "internal_auth_failed"]);
const EVENT_LIMIT = 50;
const DATA_CHARS = 140;

function dataText(data) {
  if (!data || typeof data !== "object") return "";
  const text = Object.entries(data).filter(([name]) => name !== "kind" && name !== "severity")
    .map(([name, value]) => `${name}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" ");
  return text.length > DATA_CHARS ? `${text.slice(0, DATA_CHARS)}...` : text;
}

export function EventsCard() {
  const { api } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const [kind, setKind] = useState("");
  const query = { limit: EVENT_LIMIT, ...(kind ? { type: kind } : {}) };
  const events = useQuery(["access", "security", "events", kind], () => api.get("/api/security/events", { query }), { ttlMs: 10_000, keepPrevious: true });
  const rows = Array.isArray(events.data?.items) ? events.data.items : [];
  const columns = [
    { id: "at", header: t("security.events.at"), sort: (row) => Date.parse(row.at), cell: (row) => html`<span title=${row.at}>${fmt.dateTime(row.at, { style: "short" })}</span>`, csv: (row) => row.at },
    { id: "type", header: t("security.events.type"), cell: (row) => html`<span class="mono small">${row.type}</span>`, csv: (row) => row.type },
    { id: "severity", header: t("security.events.severity"), cell: (row) => html`<${StatusBadge} status=${severityBadge(row.severity)} label=${row.severity || "info"} />`, csv: (row) => row.severity || "" },
    { id: "data", header: t("security.events.data"), hideable: true, cell: (row) => html`<span class="mono xsmall muted" data-user-content>${dataText(row.data)}</span>`, csv: (row) => dataText(row.data) },
  ];
  const filter = html`<div class="row">
    <label class="field-label" for="security-events-kind">${t("security.events.filter")}</label>
    <select id="security-events-kind" class="select keys-filter" value=${kind} onChange=${(event) => setKind(event.currentTarget.value)} data-testid="security.events.filter">
      <option value="">${t("security.events.all")}</option>
      ${EVENT_KINDS.map((item) => html`<option key=${item} value=${item}>${item}</option>`)}
    </select>
  </div>`;
  return html`<${Card} title=${t("security.events.title")} testid="security.events">
    ${events.status === "error" && !events.data ? html`<${EmptyState} icon="triangle-alert" title=${t("security.events.failed")} body=${events.error?.message || ""} action=${{ label: t("access.retry"), onClick: events.refetch }} />`
      : html`<${DataTable} id="access-security-events" columns=${columns} rows=${rows} rowKey=${(row) => row.id ?? `${row.at}|${row.type}`} loading=${events.status === "loading" && !events.data} responsive="cards"
        caption=${t("security.events.caption")} filters=${filter} empty=${html`<p class="muted" data-testid="security.events.empty">${t("security.events.empty")}</p>`} />`}
  <//>`;
}

/** @param findings `report.legacy` */
export function LegacyCard({ findings, state }) {
  const { t, has } = useT();
  const list = Array.isArray(findings) ? findings : [];
  return html`<${Card} title=${t("security.legacy.title")} testid="security.legacy">
    <p class="notice" role="note" data-testid="security.legacy.note">${t("security.legacy.note")}</p>
    ${state === "unavailable" ? html`<p class="muted" data-testid="security.legacy.unavailable">${t("security.legacy.unavailable")}</p>`
      : !list.length ? html`<p class="muted" data-testid="security.legacy.none">${t("security.legacy.none")}</p>`
        : html`<ul class="stack" aria-label=${t("security.legacy.title")}>
          ${list.map((finding) => html`<li key=${finding.id} class="check-row" data-risk=${finding.risk} data-testid="security.legacy.item">
            <div class="row">
              <${StatusBadge} status=${finding.risk === "high" ? "error" : "warn"} label=${t(tk("security.risk.", finding.risk === "high" ? "high" : "medium"))} />
              <code class="code-inline grow" data-user-content>${finding.relPath}</code>
            </div>
            <p class="small muted" data-user-content>${finding.evidence}</p>
            ${has(finding.recommendation) ? html`<p class="small">${t(finding.recommendation)}</p>` : null}
            ${finding.suggestedCommand ? html`<${CodeBlock} code=${finding.suggestedCommand} language="powershell" copyLabel=${t("security.legacy.copy")} testid="security.legacy.command" />` : null}
          </li>`)}
        </ul>`}
  <//>`;
}
