// The Requests and Events tabs of a deployment (07 §6.2). Requests need 04
// (`features.telemetry`). Events come from 04 too, and before it from the
// entry's event ring since it started, filtered to this manager.

import { buildActivity } from "../../lib/overview-model.js";
import { describeError } from "../../lib/api.js";
import { DataTable } from "../../components/data-table.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";

const EVENT_LIMIT = 50;
const enc = encodeURIComponent;

export function RequestsTab({ row }) {
  const { api } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  const requests = useQuery(["telemetry", "requests", row.fleetId], () => api.get("/api/telemetry/requests", { query: { fleet_id: row.fleetId, limit: EVENT_LIMIT } }), { ttlMs: 10000, refetchMs: 15000 });
  const rows = Array.isArray(requests.data?.rows) ? requests.data.rows : [];
  const columns = [
    { id: "receivedAt", header: t("deploy.requests.time"), sort: (item) => item.receivedAt, cell: (item) => html`<time dateTime=${item.receivedAt} title=${fmt.dateTime(item.receivedAt)}>${fmt.relative(item.receivedAt)}</time>` },
    { id: "requestId", header: t("deploy.requests.id"), cell: (item) => html`<a href=${`/observability/requests/${enc(item.requestId)}`}><code class="code-inline">${item.requestId}</code></a>` },
    { id: "state", header: t("deploy.requests.state"), sort: (item) => item.terminalState, cell: (item) => item.terminalState || "—" },
    { id: "ttft", header: t("deploy.requests.ttft"), align: "end", sort: (item) => item.ttftMs, cell: (item) => (item.ttftMs === null || item.ttftMs === undefined ? "—" : html`<span class="tabular">${fmt.integer(item.ttftMs)} ms</span>`) },
    { id: "duration", header: t("deploy.requests.duration"), align: "end", sort: (item) => item.durationMs, cell: (item) => (item.durationMs === null || item.durationMs === undefined ? "—" : html`<span class="tabular">${fmt.duration(item.durationMs)}</span>`) },
  ];
  return html`<div data-testid="deploy.tab.requests">
    ${requests.error && !rows.length ? html`<p class="notice notice-warn" role="status">${describeError(requests.error, i18n)}</p>` : null}
    <${DataTable} id="deployment-requests" caption=${t("deploy.tab.requests")} columns=${columns} rows=${rows} rowKey="requestId" exportName="deployment-requests" testid="deploy.requests.table" />
  </div>`;
}

export function EventsTab({ row, telemetry }) {
  const services = useServices();
  const { api, bootstrap } = services;
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  const events = useQuery(["deployments", "events", row.fleetId, telemetry ? "telemetry" : "ring"], async () => {
    if (telemetry) return api.get("/api/telemetry/events", { query: { fleet_id: row.fleetId, limit: EVENT_LIMIT } });
    const recent = await api.get("/api/events/recent", { query: { types: "jobs,instances,notification", limit: 200 } });
    const mine = (Array.isArray(recent?.events) ? recent.events : []).filter((event) => (event?.data?.managerId ?? "") === row.managerId);
    return { events: mine.slice(-EVENT_LIMIT) };
  }, { ttlMs: 10000, refetchMs: 15000 });
  const lines = buildActivity(events.data, i18n, { managers: bootstrap?.managers || [] });
  return html`<div data-testid="deploy.tab.events">
    ${telemetry ? null : html`<p class="muted small" data-testid="deploy.events.degraded">${t("deploy.events.sinceStart")}</p>`}
    ${lines.length ? html`<ol class="overview-activity deploy-events">
      ${lines.map((line) => html`<li key=${line.id} data-testid="deploy.event">
        <time class="muted small tabular" dateTime=${line.at} title=${fmt.dateTime(line.at)}>${fmt.relative(line.at)}</time>
        <span class="overview-item-text">${line.text}</span>
      </li>`)}
    </ol>` : html`<p class="muted" data-testid="deploy.events.empty">${t("deploy.events.empty")}</p>`}
  </div>`;
}
