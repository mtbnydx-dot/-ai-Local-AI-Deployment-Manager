// /system (06 §11, 07 §6.13, CON-24): the platform's components, the
// supervisor banner and the Danger zone.
//
// Data: GET /api/platform/status (06 §5.15) carries the component rows and is
// the same cache entry the top bar uses, so platform events keep it fresh. A
// viewer gets 06's redaction (no pid, owner, last exit or message) and no
// actions. Before the platform backend is mounted (`features.platform` off, or
// the route answers endpoint_unavailable) the rows come from GET /api/status
// and offer the manager start and stop the entry already has (model.js).
//
// Row actions go to POST /api/platform/components/:id/{start,stop,restart}.
// Restart sends {when:"now"}; a 409 component_busy lists its blockers and
// offers Restart when idle ({when:"idle"}). Stop asks first. Logs open the
// component LogViewer in a Drawer. The Danger zone stops the platform after
// "stop" is typed (POST /api/stop-all, the entry's own endpoint).

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { Drawer } from "../../components/drawer.js";
import { EmptyState } from "../../components/empty-state.js";
import { useLayerAction } from "../../components/layer-action.js";
import { LogViewer } from "../../components/log-viewer.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { readQueryParam } from "../../components/tabs.js";
import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { PlatformStatusGuard, StatusGuard } from "../../lib/schemas.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { actionRequest, actionsFor, blockersOf, degradeRows, isDeployRestart, platformRows, portConflictOf, stateTone, supervisorMissing } from "./model.js";
import { SystemNav } from "./subnav.js";

const LOGS_PREFIX = "logs:";
const DASH = "—";

function initialLogsId() {
  const value = readQueryParam("drawer");
  return value && value.startsWith(LOGS_PREFIX) ? value.slice(LOGS_PREFIX.length) : null;
}

function StateCell({ row }) {
  const { t, has } = useT();
  const conflict = portConflictOf(row);
  let detail = "";
  if (conflict) detail = t("platform.portConflict", { port: conflict.port, image: conflict.image || DASH, pid: conflict.pid ?? DASH });
  else if (row.reason) detail = has(tk("platform.reason.", row.reason)) ? t(tk("platform.reason.", row.reason)) : row.reason;
  else if (row.message) detail = row.message;
  return html`<div class="stack-sm" data-testid=${`system.state.${row.id}`}>
    <${StatusBadge} status=${stateTone(row.state)} label=${t(tk("platform.state.", row.state))} testid="system.state" />
    ${detail ? html`<span class="muted small" data-testid="system.state-detail">${detail}</span>` : null}
    ${row.startCommand ? html`<span class="muted small" data-testid="system.start-command">${t("platform.system.startCommand")} <code class="code-inline">${row.startCommand}</code></span>` : null}
  </div>`;
}

function ExitCell({ row }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const exit = row.lastExit;
  if (!exit) return DASH;
  const reason = typeof exit.reason === "string" && exit.reason ? (has(tk("platform.reason.", exit.reason)) ? t(tk("platform.reason.", exit.reason)) : exit.reason) : "";
  const exitCode = exit.code === null || exit.code === undefined ? null : Number(exit.code);
  const code = Number.isFinite(exitCode) && exitCode !== 0 ? t("platform.system.exitCode", { code: exitCode }) : "";
  const when = exit.at ? fmt.relative(exit.at) : "";
  return html`<span data-testid="system.exit">${[reason, code, when].filter(Boolean).join(" · ") || DASH}</span>`;
}

function PendingCell({ row }) {
  const { t } = useT();
  const fmt = useFormat();
  if (!row.pending) return DASH;
  const text = isDeployRestart(row.pending)
    ? t("platform.pending.restart", { component: row.label })
    : t("platform.system.pendingQueued", { time: row.pending.queuedAt ? fmt.relative(row.pending.queuedAt) : DASH });
  return html`<span data-testid="system.pending">${text}</span>`;
}

export default function System() {
  const services = useServices();
  const { api, cache, toasts, bootstrap } = services;
  const i18n = useT();
  const { t, pick } = i18n;
  const fmt = useFormat();
  const role = useRole();
  const owner = role === "owner";
  const platformOn = Boolean(bootstrap?.features?.platform);
  const platform = useQuery(["platform"], () => api.get("/api/platform/status", { guard: PlatformStatusGuard }), { ttlMs: 5000, refetchMs: 15000, enabled: platformOn });
  const status = useQuery(["status"], () => api.get("/api/status", { guard: StatusGuard }), { ttlMs: 10000, refetchMs: 15000 });
  const layerAction = useLayerAction();
  const [busy, setBusy] = useState("");
  const [stopping, setStopping] = useState(null);
  const [busyAsk, setBusyAsk] = useState(null);
  const [stopAll, setStopAll] = useState(false);
  const [logsId, setLogsId] = useState(initialLogsId);
  const [supervisorGone, setSupervisorGone] = useState(false);

  const degraded = !platformOn || platform.error?.code === "endpoint_unavailable";
  const source = degraded ? status : platform;
  const rows = degraded ? degradeRows(status.data) : platformRows(platform.data, pick);
  const loading = source.data === undefined && source.status !== "error";
  const failed = source.data === undefined && source.status === "error";
  const missing = !degraded && (supervisorMissing(platform.data) || (supervisorGone && platform.data?.supervisor?.running !== true));
  const supervisor = platform.data?.supervisor;

  function refresh() {
    for (const prefix of [["platform"], ["status"], ["fleet"]]) cache.invalidate(prefix);
  }

  function failure(row, error) {
    if (error?.code === "supervisor_unavailable") {
      setSupervisorGone(true);
      toasts?.push?.({ level: "error", title: row.label, body: t("platform.supervisor.missing"), requestId: error?.requestId || null });
      return;
    }
    toasts?.push?.({ level: "error", title: row.label, body: describeError(error, i18n), requestId: error?.requestId || null });
  }

  async function send(row, action) {
    const request = actionRequest(row, action);
    if (!request) return null;
    const answer = await api.post(request.path, request.body);
    refresh();
    if (action === "restartIdle") toasts?.push?.({ level: "success", title: row.label, body: t("platform.system.queued", { component: row.label }) });
    else toasts?.push?.({ level: "success", title: row.label, body: t("platform.strip.started") });
    return answer;
  }

  async function run(row, action) {
    if (action === "logs") {
      setLogsId(row.id);
      return;
    }
    if (action === "stop") {
      setStopping(row);
      return;
    }
    setBusy(`${row.id}:${action}`);
    try {
      await send(row, action);
    } catch (error) {
      if (action === "restart" && error?.code === "component_busy") setBusyAsk({ row, blockers: blockersOf(error) });
      else failure(row, error);
    } finally {
      setBusy("");
    }
  }

  const columns = [
    {
      id: "component", header: t("platform.system.col.component"), sort: (row) => row.label,
      cell: (row) => html`<div class="stack-sm"><strong data-testid="system.label">${row.label}</strong><code class="code-inline small">${row.id}</code></div>`,
    },
    { id: "state", header: t("platform.system.col.state"), sort: (row) => row.state, cell: (row) => html`<${StateCell} row=${row} />` },
    { id: "owner", header: t("platform.system.col.owner"), hideable: true, sort: (row) => row.owner || "", cell: (row) => (row.owner && row.owner !== "none" ? (i18n.has(tk("platform.owner.", row.owner)) ? t(tk("platform.owner.", row.owner)) : row.owner) : DASH) },
    { id: "ports", header: t("platform.system.col.ports"), align: "end", sort: (row) => row.ports[0] ?? null, cell: (row) => (row.ports.length ? html`<span class="tabular">${row.ports.join(", ")}</span>` : DASH) },
    { id: "uptime", header: t("platform.system.col.uptime"), align: "end", sort: (row) => row.uptimeSec, cell: (row) => (row.uptimeSec === null ? DASH : html`<span class="tabular">${fmt.duration(row.uptimeSec * 1000)}</span>`) },
    { id: "restarts", header: t("platform.system.col.restarts"), align: "end", hideable: true, sort: (row) => row.restartCount, cell: (row) => (row.restartCount === null ? DASH : html`<span class="tabular">${fmt.integer(row.restartCount)}</span>`) },
    { id: "lastExit", header: t("platform.system.col.lastExit"), hideable: true, sort: (row) => row.lastExit?.at ?? "", cell: (row) => html`<${ExitCell} row=${row} />` },
    { id: "pending", header: t("platform.system.col.pending"), hideable: true, sort: (row) => row.pending?.queuedAt ?? "", cell: (row) => html`<${PendingCell} row=${row} />` },
  ];
  if (owner) {
    columns.push({
      id: "actions", header: t("platform.system.col.actions"), csv: false,
      cell: (row) => html`<div class="row" data-testid=${`system.actions.${row.id}`}>
        ${actionsFor(row, { owner }).map((action) => html`<${Button} key=${action} size="sm" variant=${action === "stop" ? "danger" : "default"}
          busy=${busy === `${row.id}:${action}`} disabled=${Boolean(busy) && busy !== `${row.id}:${action}`}
          label=${t(tk("platform.system.action.for.", action), { component: row.label })} onClick=${() => run(row, action)} testid=${`system.action.${action}`}>${action === "restartIdle" ? t("platform.action.restartWhenIdle") : t(tk("platform.system.action.", action))}<//>`)}
      </div>`,
    });
  }

  const header = html`<${PageHeader} title=${t("shell.nav.system")} subtitle=${t("platform.system.subtitle")}
    actions=${html`<${Button} icon="refresh-cw" onClick=${refresh} testid="system.refresh">${t("platform.system.refresh")}<//>`}
    meta=${supervisor?.running ? html`<span class="muted small" data-testid="system.supervisor">${t("platform.system.supervisor.running", { profile: supervisor.profile || DASH })}</span>` : null} />`;
  const nav = html`<${SystemNav} current="components" owner=${owner} />`;

  if (loading) {
    return html`<div class="stack" data-testid="system.root" aria-busy="true">${header}${nav}<${Skeleton} shape="table" rows=${5} /></div>`;
  }
  if (failed) {
    return html`<div class="stack" data-testid="system.root">${header}${nav}
      <${EmptyState} icon="circle-x" level=${2} title=${t("platform.system.error.title")} body=${describeError(source.error, i18n)}
        action=${{ label: t("shell.conn.retry"), onClick: () => source.refetch() }} testid="system.error" />
    </div>`;
  }

  const logsRow = logsId ? rows.find((row) => row.id === logsId) || { id: logsId, label: logsId } : null;
  const empty = html`<${EmptyState} icon="boxes" title=${t("platform.system.empty.title")} body=${t("platform.system.empty.body")}
    action=${{ label: t("platform.system.refresh"), onClick: refresh }} testid="system.empty" />`;

  return html`<div class="stack" data-testid="system.root">
    ${header}
    ${nav}
    ${!owner ? html`<p class="muted" data-testid="system.viewer-note">${t("shell.readonly")}</p>` : null}
    ${missing ? html`<div class="notice notice-warn" role="status" data-testid="system.supervisor-banner">
      <span class="grow">${t("platform.supervisor.missing")}</span>
      ${owner ? html`<${Button} size="sm" variant="primary" onClick=${() => layerAction.start({ id: "start-supervisor" })} testid="system.supervisor-start">${t("platform.action.startSupervisor")}<//>` : null}
    </div>` : null}
    ${degraded ? html`<div class="notice" role="status" data-testid="system.degraded">
      <div class="stack-sm grow"><strong>${t("platform.system.degraded.title")}</strong><span>${t("platform.system.degraded.body")}</span></div>
    </div>` : null}
    <${Card} title=${t("platform.system.table")} level=${2} testid="system.components">
      <${DataTable} id="system-components" caption=${t("platform.system.table")} columns=${columns} rows=${rows} rowKey="id" responsive="cards" empty=${empty}
        exportName="platform-components" testid="system.table" />
    <//>
    ${owner ? html`<${Card} title=${t("platform.system.danger.title")} tone="danger" level=${2} testid="system.danger">
      <div class="row">
        <p class="grow">${t("platform.system.danger.desc")}</p>
        <${Button} variant="danger" icon="power" onClick=${() => setStopAll(true)} testid="system.stop-all">${t("platform.system.danger.stop")}<//>
      </div>
    <//>` : null}
    ${layerAction.dialog}
    <${ConfirmDialog} open=${Boolean(stopping)} tone="danger" title=${stopping ? t("platform.system.stop.title", { component: stopping.label }) : ""}
      body=${stopping ? t("platform.system.stop.body", { component: stopping.label }) : ""} confirmLabel=${t("platform.system.action.stop")}
      onConfirm=${() => send(stopping, "stop").catch((error) => {
        if (error?.code === "supervisor_unavailable") setSupervisorGone(true);
        throw error;
      })} onClose=${() => setStopping(null)} testid="system.stop-confirm" />
    <${ConfirmDialog} open=${Boolean(busyAsk)} title=${busyAsk ? t("platform.system.busy.title", { component: busyAsk.row.label }) : ""}
      body=${busyAsk ? t("platform.busy.refuse", { n: busyAsk.blockers.length }) : ""}
      details=${busyAsk ? busyAsk.blockers.map((item) => [t(tk("platform.blocker.", item.kind)), item.title].filter(Boolean).join(" · ")) : []}
      confirmLabel=${t("platform.action.restartWhenIdle")} onConfirm=${() => send(busyAsk.row, "restartIdle")} onClose=${() => setBusyAsk(null)} testid="system.busy" />
    <${ConfirmDialog} open=${stopAll} tone="danger" title=${t("platform.system.danger.stop")} body=${t("platform.stopAll.confirm")} typeToConfirm="stop"
      confirmLabel=${t("platform.system.danger.stop")} onConfirm=${async () => {
        await api.post("/api/stop-all");
        toasts?.push?.({ level: "success", title: t("platform.system.danger.stop"), body: t("platform.system.danger.stopped") });
      }} onClose=${() => setStopAll(false)} testid="system.stop-all-confirm" />
    <${Drawer} open=${Boolean(logsRow)} width=${840} title=${logsRow ? t("platform.system.logs.title", { component: logsRow.label }) : ""} urlId=${logsRow ? `${LOGS_PREFIX}${logsRow.id}` : undefined}
      onClose=${() => setLogsId(null)} testid="system.logs">
      ${logsRow ? html`<${LogViewer} key=${logsRow.id} source=${{ kind: "component", id: logsRow.id }} label=${t("platform.system.logs.title", { component: logsRow.label })} testid="system.log-viewer" />` : null}
    <//>
  </div>`;
}
