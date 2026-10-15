// Audit › Timeline `/audit` (07 §6.8, 04 §11.7): what happened around the
// platform in the window — launches, alerts, access changes and security
// events — from GET /api/telemetry/events with the four type prefixes, and a
// short health line of the export chain (GET /api/audit/status). Neither
// needs the audit unlock: events carry no conversation text.

import { auditPath, TIMELINE_PAGE, TIMELINE_PREFIXES, timelineRows, timelineTypes } from "../../lib/audit-model.js";
import { tk } from "../../lib/i18n.js";
import { localizedTitle } from "../../lib/observability-model.js";
import { resolveTimeRange } from "../../lib/time-range.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { TimeRangePicker, useRangeLabel, useTimeRangeParam } from "../../components/time-range-picker.js";
import { AuditPage, LoadError, Loading, useAuditPages, useUrlSearch } from "./common.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo } from "../../ui/vendor.js";

function Health() {
  const { api } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const status = useQuery(["audit", "status"], () => api.get(auditPath("status")), { ttlMs: 10_000, refetchMs: 30_000 });
  if (status.data === undefined && status.error) return html`<${LoadError} error=${status.error} onRetry=${() => status.refetch()} testid="audit.health.error" />`;
  if (status.data === undefined) return html`<${Loading} rows=${1} />`;
  const data = status.data;
  const schedule = data.schedule || {};
  const chains = Array.isArray(data.chains) ? data.chains : [];
  const incrementals = chains[0] ? Number(chains[0].incrementals) || 0 : 0;
  const lastOk = data.lastRuns?.lastOkAt || schedule.lastOkAt || null;
  return html`<${Card} title=${t("audit.health")} testid="audit.health"
    actions=${html`<${Button} size="sm" href="/audit/exports" testid="audit.health.exports">${t("audit.health.open")}<//>`}>
    <div class="stack-sm">
      ${schedule.needsRebaseline ? html`<p class="notice notice-warn" role="status" data-testid="audit.rebaseline">${t("audit.rebaseline")}</p>` : null}
      ${data.index?.building ? html`<p class="notice notice-info" role="status" data-testid="audit.index-building">${t("audit.indexBuilding")}</p>` : null}
      <dl class="obs-facts">
        <div><dt>${t("audit.health.chain")}</dt><dd data-testid="audit.health.chain">${chains.length ? t("audit.chain", { n: incrementals }) : t("audit.health.noChain")}</dd></div>
        <div><dt>${t("audit.health.lastOk")}</dt><dd>${lastOk ? fmt.dateTime(lastOk) : "—"}</dd></div>
        <div><dt>${t("audit.health.nextIncremental")}</dt><dd>${schedule.enabled === false ? t("audit.health.off") : schedule.nextIncrementalAt ? fmt.dateTime(schedule.nextIncrementalAt) : "—"}</dd></div>
        <div><dt>${t("audit.health.nextFull")}</dt><dd>${schedule.enabled === false ? t("audit.health.off") : schedule.nextFullAt ? fmt.dateTime(schedule.nextFullAt) : "—"}</dd></div>
        <div><dt>${t("audit.health.container")}</dt><dd><${StatusBadge} status=${data.openWebuiContainer?.running ? "ok" : data.openWebuiContainer?.exists ? "warn" : "neutral"}
          label=${data.openWebuiContainer?.running ? t("audit.container.running") : data.openWebuiContainer?.exists ? t("audit.container.stopped") : t("audit.container.missing")} /></dd></div>
      </dl>
    </div>
  <//>`;
}

function Families({ chosen, onChange }) {
  const { t } = useT();
  return html`<fieldset class="obs-sources" data-testid="audit.families">
    <legend>${t("audit.timeline.kinds")}</legend>
    ${TIMELINE_PREFIXES.map((prefix) => {
      const family = prefix.slice(0, -1);
      return html`<label class="check" key=${family}><input type="checkbox" checked=${chosen.length === 0 || chosen.includes(family)} data-testid=${`audit.family.${family}`}
        onChange=${(event) => onChange(family, event.currentTarget.checked)} /> ${t(tk("audit.family.", family))}</label>`;
    })}
  </fieldset>`;
}

function Events() {
  const { api } = useServices();
  const { t, locale } = useT();
  const fmt = useFormat();
  const rangeLabel = useRangeLabel();
  const [range, setRange, { valid }] = useTimeRangeParam({ fallback: "7d" });
  const [search, patch] = useUrlSearch();
  const chosen = useMemo(() => (new URLSearchParams(search).get("kind") || "").split(",").filter((family) => TIMELINE_PREFIXES.includes(`${family}.`)), [search]);
  const id = `${JSON.stringify(range)}|${chosen.join(",")}`;
  const events = useAuditPages(id, async (cursor) => {
    const span = resolveTimeRange(range, Date.now());
    const answer = await api.get("/api/telemetry/events", { query: { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString(), type: timelineTypes(chosen), limit: TIMELINE_PAGE, ...(cursor ? { cursor } : {}) } });
    return { rows: timelineRows(answer), cursor: typeof answer?.nextCursor === "string" && answer.nextCursor ? answer.nextCursor : null };
  });
  const windowText = rangeLabel(range, Date.now());
  const toggle = (family, on) => {
    const current = chosen.length ? chosen : TIMELINE_PREFIXES.map((prefix) => prefix.slice(0, -1));
    const next = on ? [...new Set([...current, family])] : current.filter((item) => item !== family);
    patch({ kind: next.length === TIMELINE_PREFIXES.length || next.length === 0 ? null : next.join(",") });
  };
  const columns = useMemo(() => [
    { id: "at", header: t("audit.col.time"), sort: (row) => Date.parse(row.at), csv: (row) => row.at,
      cell: (row) => html`<time dateTime=${row.at} title=${fmt.dateTime(row.at, { style: "long" })}>${fmt.dateTime(row.at, { style: "short" })}</time>` },
    { id: "family", header: t("audit.col.kind"), sort: true, cell: (row) => (TIMELINE_PREFIXES.includes(`${row.family}.`) ? t(tk("audit.family.", row.family)) : row.family) },
    { id: "type", header: t("audit.col.type"), sort: true, hideable: true, cell: (row) => html`<span class="mono small" data-user-content>${row.type}</span>` },
    { id: "severity", header: t("audit.col.severity"), sort: true, csv: (row) => row.severity,
      cell: (row) => (row.severity ? html`<${StatusBadge} status=${row.tone} label=${t(tk("obs.severity.", row.severity === "warn" ? "warning" : row.severity))} />` : "—") },
    { id: "title", header: t("audit.col.event"), sort: (row) => localizedTitle(row.title, locale), csv: (row) => localizedTitle(row.title, locale),
      cell: (row) => html`<span data-user-content>${localizedTitle(row.title, locale) || row.type}</span>${row.fleetId ? html` <a class="mono small" href=${`/deployments/${encodeURIComponent(row.fleetId)}`} data-user-content>${row.fleetId}</a>` : null}${row.requestId ? html` <a class="mono small" href=${`/observability/requests/${encodeURIComponent(row.requestId)}`} data-user-content>${row.requestId}</a>` : null}` },
  ], [t, fmt, locale]);
  const empty = html`<${EmptyState} icon="search" title=${t("audit.timeline.empty")} action=${{ label: t("obs.empty.widen"), onClick: () => setRange({ range: "30d" }) }} testid="audit.timeline.empty" />`;
  return html`<${Card} title=${t("audit.timeline.title")} testid="audit.timeline">
    <div class="stack-sm">
      <p class="small muted obs-window" data-window=${windowText} data-testid="obs.panel.window">${windowText}</p>
      <${TimeRangePicker} value=${range} onChange=${(value) => setRange(value)} />
      ${valid ? null : html`<p class="notice notice-warn" role="status">${t("obs.rangeFallback")}</p>`}
      <${Families} chosen=${chosen} onChange=${toggle} />
      ${events.error ? html`<${LoadError} error=${events.error} onRetry=${events.reload} />`
        : events.loading ? html`<${Loading} rows=${4} />`
        : html`<${DataTable} id="audit-timeline" columns=${columns} rows=${events.rows} rowKey="id" caption=${t("audit.table.events")} exportName="audit-timeline" empty=${empty} responsive="cards"
          source=${{ cursor: events.cursor, loading: events.loadingMore, loadMore: events.loadMore }} testid="audit.timeline.table" />`}
      ${events.moreError ? html`<p class="notice notice-warn" role="alert">${t("obs.req.moreFailed")}</p>` : null}
    </div>
  <//>`;
}

export default function AuditTimeline() {
  return html`<${AuditPage} id="timeline">${() => html`<${Health} /><${Events} />`}<//>`;
}
