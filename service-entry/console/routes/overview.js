// Overview `/overview` (07 §6.1): the first page of the new console.
//
// Top to bottom: the readiness banner (only while readiness is not ok; it runs
// the first non-ok layer's own `action`, and restore-models shows its dry-run
// plan first), four StatTiles that each carry their window, what needs
// attention, quick actions, the running deployments and the recent activity.
//
// Before 04 (no `features.telemetry`) the tiles fall back to the entry's own
// gateway log and say so: tiles 1 and 2 read GET /api/gateway-access over the
// last 2,000 log lines, tile 3 shows "—", and the activity comes from the
// event ring (/api/events/recent) since the entry started. The builders below


import { tk } from "../lib/i18n.js";
import {
  ACTIVITY_MAX, buildActivity, buildAttention, buildTiles, DAY_MS, deploymentRows, GATEWAY_LINES, HOUR_MS, KEY_EXPIRY_DAYS, list, managerName, STATE_STATUS,
} from "../lib/overview-model.js";
import { FleetGuard, PlatformStatusGuard, StatusGuard } from "../lib/schemas.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { copyText } from "../components/code-block.js";
import { EmptyState } from "../components/empty-state.js";
import { Icon } from "../components/icon.js";
import { PageHeader } from "../components/page-header.js";
import { StatTile } from "../components/stat-tile.js";
import { StatusBadge } from "../components/status-badge.js";
import { buildStripModel, gpuSummary, layerDetail, actionKey } from "../components/status-strip.js";
import { useLayerAction } from "../components/layer-action.js";
import { useServices } from "../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useState } from "../ui/vendor.js";

// ---------------------------------------------------------------------------
// Page

// One call per manager; a manager that does not answer only drops out of the list.
async function perManager(api, managers, path, options) {
  const answers = await Promise.allSettled(managers.map((id) => api.get(path(id), options)));
  return answers.flatMap((answer, index) => (answer.status === "fulfilled" ? [{ managerId: managers[index], data: answer.value }] : []));
}

function ReadinessBanner({ model, owner, onAction }) {
  const i18n = useT();
  const { t, has, pick } = i18n;
  const layer = model.layers.find((item) => item.status !== "ok");
  if (!layer) return null;
  const detail = layerDetail(layer, i18n) || t(tk("platform.strip.status.", layer.status));
  const action = owner && layer.action ? layer.action : null;
  const label = action ? (has(actionKey(action.id)) ? t(actionKey(action.id)) : pick(action.label) || action.id) : "";
  const failed = layer.status === "fail";
  return html`<div class=${`notice overview-banner ${failed ? "notice-danger" : "notice-warn"}`} role="status" data-layer=${layer.id} data-testid="overview.banner">
    <${Icon} name=${failed ? "circle-x" : "triangle-alert"} />
    <span class="grow"><strong>${t(tk("platform.layer.", layer.id))}</strong> · <span data-testid="overview.banner.detail">${detail}</span></span>
    ${action ? html`<${Button} size="sm" variant="primary" onClick=${() => onAction(action, layer)} testid=${`overview.banner.action.${action.id}`}>${label}<//>` : null}
  </div>`;
}

function AttentionCard({ attention, loading }) {
  const { t } = useT();
  return html`<${Card} title=${t("overview.attention.title")} testid="overview.attention">
    ${attention.items.length ? html`<ul class="overview-list">
      ${attention.items.map((item) => html`<li key=${item.id} class="overview-item" data-kind=${item.kind} data-testid="overview.attention.item">
        <span class=${item.tone === "danger" ? "text-danger" : "text-warn"}><${Icon} name=${item.icon} /></span>
        <span class="overview-item-text"><span>${item.text}</span>${item.detail ? html`<span class="muted small"> · ${item.detail}</span>` : null}</span>
        <${Button} size="sm" href=${item.href} testid="overview.attention.action">${item.action}<//>
      </li>`)}
    </ul>
    ${attention.more ? html`<p class="muted small" data-testid="overview.attention.more">${t("overview.attention.more", { count: attention.more })}</p>` : null}` : html`<p class="muted" data-testid="overview.attention.empty">${loading ? "…" : t("overview.attention.empty")}</p>`}
  <//>`;
}

function QuickActions({ owner, launches, gatewayPath, onCopy, managers }) {
  const i18n = useT();
  const { t } = i18n;
  return html`<${Card} title=${t("overview.quick.title")} testid="overview.quick">
    <div class="stack-sm">
      ${owner ? html`<${Button} variant="primary" icon="rocket" href="/deployments/new" testid="overview.quick.new">${t("overview.quick.new")}<//>` : null}
      ${owner ? launches.map((entry) => html`<${Button} key=${entry.managerId} href=${`/deployments/new?manager=${encodeURIComponent(entry.managerId)}&step=review&from=recent`} testid=${`overview.quick.last.${entry.managerId}`}>
        ${t("overview.quick.startLast", { manager: managerName(managers, entry.managerId, i18n) })}<//>`) : null}
      ${owner ? html`<${Button} icon="search" href="/models/discover" testid="overview.quick.download">${t("overview.quick.download")}<//>` : null}
      ${gatewayPath ? html`<${Button} icon="copy" onClick=${onCopy} testid="overview.quick.copy">${t("overview.quick.copyGateway")}<//>` : null}
    </div>
  <//>`;
}

function DeploymentsCard({ rows, owner, loading, onStop }) {
  const { t } = useT();
  const fmt = useFormat();
  const title = t("overview.deployments.title");
  return html`<${Card} title=${title} testid="overview.deployments">
    ${rows.length ? html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("overview.deployments.scroll")} data-testid="overview.deployments.scroll">
      <table class="table">
        <caption class="sr-only">${title}</caption>
        <thead><tr>
          <th scope="col">${t("overview.col.state")}</th><th scope="col">${t("overview.col.model")}</th><th scope="col">${t("overview.col.engine")}</th>
          <th scope="col" class="num">${t("overview.col.port")}</th><th scope="col" class="num">${t("overview.col.context")}</th><th scope="col" class="num">${t("overview.col.tps")}</th>
          <th scope="col"><span class="sr-only">${t("overview.col.actions")}</span></th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr key=${row.key} data-render-key=${row.key} data-testid="overview.deployment">
            <td><${StatusBadge} status=${STATE_STATUS[row.state] || "unknown"} label=${`${t(tk("overview.state.", row.state))}${row.percent === null ? "" : ` ${fmt.integer(Math.round(row.percent))}%`}`} /></td>
            <td>${row.model}${row.extraModels ? html` <span class="muted">+${row.extraModels}</span>` : null}</td>
            <td><code class="code-inline">${row.engine}</code></td>
            <td class="num tabular">${row.port === null ? "—" : row.port}</td>
            <td class="num tabular">${row.context === null ? "—" : fmt.tokens(row.context)}</td>
            <td class="num tabular">${row.tps === null ? "—" : fmt.number(row.tps, 1)}</td>
            <td><div class="row-nowrap">
              <${Button} size="sm" href=${`/playground?model=${encodeURIComponent(row.model)}`} label=${t("overview.row.playgroundFor", { model: row.model })} testid="overview.deployment.playground">${t("overview.row.playground")}<//>
              ${owner && row.managerId ? html`<${Button} size="sm" variant="danger" label=${t("overview.row.stopFor", { instance: row.fleetId })} onClick=${() => onStop(row)} testid="overview.deployment.stop">${t("overview.row.stop")}<//>` : null}
            </div></td>
          </tr>`)}
        </tbody>
      </table>
    </div>` : loading ? html`<p class="muted">…</p>` : html`<${EmptyState} icon="boxes" title=${t("overview.deployments.empty.title")} body=${t("overview.deployments.empty.body")}
      action=${{ label: t("overview.quick.new"), href: "/deployments/new" }} testid="overview.deployments.empty" />`}
  <//>`;
}

function ActivityCard({ rows, degraded }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<${Card} title=${t("overview.activity.title")} testid="overview.activity">
    ${degraded ? html`<p class="muted small" data-window=${t("overview.activity.sinceStart")} data-testid="overview.activity.window">${t("overview.activity.sinceStart")}</p>` : null}
    ${rows.length ? html`<ul class="overview-activity">
      ${rows.map((row) => html`<li key=${row.id} data-testid="overview.activity.item">
        <time class="muted small tabular" dateTime=${row.at} title=${fmt.dateTime(row.at)}>${fmt.relative(row.at)}</time>
        <span class=${row.tone === "error" ? "text-danger" : row.tone === "warn" ? "text-warn" : ""}><${Icon} name=${row.icon} /></span>
        <span class="overview-item-text">${row.text}</span>
      </li>`)}
    </ul>` : html`<p class="muted" data-testid="overview.activity.empty">${t("overview.activity.empty")}</p>`}
  <//>`;
}

export default function Overview() {
  const services = useServices();
  const { api, bootstrap, toasts, cache } = services;
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  const role = useRole();
  const owner = role === "owner";
  const features = bootstrap?.features || {};
  const managers = Array.isArray(bootstrap?.managers) ? bootstrap.managers : [];
  const managerIds = managers.map((item) => item.id).filter(Boolean);
  const telemetry = Boolean(features.telemetry);
  const layerAction = useLayerAction();
  const [stopping, setStopping] = useState(null);

  // These four share their cache entries with the topbar's StatusStrip.
  const status = useQuery(["status"], () => api.get("/api/status", { guard: StatusGuard }), { ttlMs: 10000, refetchMs: 15000 });
  const fleet = useQuery(["fleet"], () => api.get("/api/fleet", { guard: FleetGuard }), { ttlMs: 5000, refetchMs: 10000 });
  const platform = useQuery(["platform"], () => api.get("/api/platform/status", { guard: PlatformStatusGuard }), { ttlMs: 5000, refetchMs: 15000, enabled: Boolean(features.platform) });
  const live = useQuery(["telemetry", "live"], () => api.get("/api/telemetry/live"), { ttlMs: 5000, refetchMs: 5000, enabled: telemetry });

  const summary = (windowMs) => () => {
    const to = Date.now();
    return api.get("/api/telemetry/summary", { query: { from: new Date(to - windowMs).toISOString(), to: new Date(to).toISOString(), compare: "previous" } });
  };
  const summary24 = useQuery(["telemetry", "summary", "24h"], summary(DAY_MS), { ttlMs: 20000, refetchMs: 30000, enabled: telemetry });
  const summary1h = useQuery(["telemetry", "summary", "1h"], summary(HOUR_MS), { ttlMs: 20000, refetchMs: 30000, enabled: telemetry });
  const gateway = useQuery(["overview", "gateway"], () => api.get("/api/gateway-access", { query: { maxLines: GATEWAY_LINES, limit: 5 } }), { ttlMs: 20000, refetchMs: 30000, enabled: !telemetry });

  const alerts = useQuery(["alerts", "firing"], () => api.get("/api/telemetry/alerts", { query: { state: "firing" } }), { ttlMs: 10000, refetchMs: 30000, enabled: Boolean(features.alerts) });
  const jobs = useQuery(["overview", "jobs"], () => perManager(api, managerIds, (id) => `/api/m/${encodeURIComponent(id)}/jobs`, { query: { fields: "summary" } }), { ttlMs: 10000, refetchMs: 30000, enabled: managerIds.length > 0 });
  const downloads = useQuery(["hub", "downloads", "failed"], () => api.get("/api/hub/downloads", { query: { state: "failed" } }), { ttlMs: 10000, refetchMs: 30000, enabled: Boolean(features.hub) });
  const doctor = useQuery(["overview", "doctor"], () => api.get("/api/platform/doctor"), { ttlMs: 30000, refetchMs: 60000, enabled: Boolean(features.platform) && owner });
  const keys = useQuery(["access", "keys", "expiring"], () => api.get("/api/access/keys", { query: { expiring: KEY_EXPIRY_DAYS } }), { ttlMs: 30000, refetchMs: 60000, enabled: Boolean(features.access) && owner });
  const launches = useQuery(["overview", "recent-launches"], () => perManager(api, managerIds, (id) => `/api/m/${encodeURIComponent(id)}/recent-launches`), { ttlMs: 30000, refetchMs: 60000, enabled: owner && managerIds.length > 0 });
  const activity = useQuery(["overview", "activity"], () => (telemetry
    ? api.get("/api/telemetry/events", { query: { limit: ACTIVITY_MAX } })
    : api.get("/api/events/recent", { query: { types: "jobs,instances,notification", limit: ACTIVITY_MAX } })), { ttlMs: 5000, refetchMs: 15000 });

  const loading = status.status !== "success" && !status.error && !platform.data;
  const strip = buildStripModel({ platform: platform.data || null, status: status.data || null, fleet: fleet.data || null, live: live.data || null, loading });
  const showBanner = strip.overall !== "ok" && strip.overall !== "loading";
  const tiles = buildTiles({ summary24: summary24.data, summary1h: summary1h.data, live: live.data, gpu: gpuSummary(live.data), gateway: gateway.data, fleet: fleet.data }, { t, fmt });
  const attention = buildAttention({ alerts: alerts.data, jobs: jobs.data, downloads: downloads.data, doctor: doctor.data, keys: keys.data, managers }, i18n, fmt);
  const rows = deploymentRows(fleet.data, live.data);
  const events = buildActivity(activity.data, i18n, { managers });
  const lastUsed = (Array.isArray(launches.data) ? launches.data : []).filter((entry) => list(entry.data, "launches", "items").length > 0);
  const gatewayPath = bootstrap?.gateway?.autoOpenAi || "";

  async function copyGateway() {
    const ok = await copyText(`${globalThis.location.origin}${gatewayPath}`);
    toasts?.push?.({ level: ok ? "success" : "warn", title: t(ok ? "shell.palette.copied" : "common.copyFailed") });
  }

  async function stop() {
    await api.post(`/api/m/${encodeURIComponent(stopping.managerId)}/instances/${encodeURIComponent(stopping.instanceId)}/stop`, {});
    for (const prefix of [["fleet"], ["status"], ["platform"], ["m"]]) cache.invalidate(prefix);
    toasts?.push?.({ level: "success", title: t("overview.stop.done", { instance: stopping.fleetId }) });
  }

  return html`<div class="stack overview" data-ready=${loading ? "false" : "true"} data-testid="overview.root">
    <${PageHeader} title=${t("shell.nav.overview")} />
    ${showBanner ? html`<${ReadinessBanner} model=${strip} owner=${owner} onAction=${layerAction.start} />` : null}
    <section class="overview-tiles" aria-label=${t("overview.tiles.label")} data-testid="overview.tiles">
      ${tiles.map((tile) => html`<${StatTile} key=${tile.id} label=${tile.label} value=${tile.value} unit=${tile.unit} denominator=${tile.denominator}
        note=${tile.note} window=${tile.span} testid=${`overview.tile.${tile.id}`} />`)}
    </section>
    <div class="overview-grid">
      <${AttentionCard} attention=${attention} loading=${loading} />
      <${QuickActions} owner=${owner} launches=${lastUsed} gatewayPath=${gatewayPath} onCopy=${copyGateway} managers=${managers} />
    </div>
    <${DeploymentsCard} rows=${rows} owner=${owner} loading=${fleet.status !== "success" && !fleet.error} onStop=${setStopping} />
    <${ActivityCard} rows=${events} degraded=${!telemetry} />
    <${ConfirmDialog} open=${Boolean(stopping)} tone="danger" title=${t("overview.stop.title", { instance: stopping?.fleetId || "" })} body=${t("overview.stop.body")}
      confirmLabel=${t("overview.row.stop")} onConfirm=${stop} onClose=${() => setStopping(null)} testid="overview.stop-confirm" />
    ${layerAction.dialog}
  </div>`;
}
