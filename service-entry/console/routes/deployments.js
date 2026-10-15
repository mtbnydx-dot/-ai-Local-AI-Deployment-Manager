// Deployments `/deployments` (07 §6.2): every instance the fleet knows, with
// its state, model, engine@version, recipe, port, context, VRAM reservation,
// GPUs, live tok/s, requests in the last hour and uptime.
//
// Rows are keyed by fleetId (`data-render-key`), so a refresh keeps the row's
// DOM nodes and the focus inside them. Stop asks first. Sleeping records have
// their own section with Wake (08 P0-RT-2). `?manager=` (also `?engine=` and
// `?state=`) pre-filters. Recent launches and profiles per manager always open
// the wizard's Review step and never start anything themselves.
//
// The fleet comes from GET /api/fleet and is merged with each manager's typed
// instances (GET /api/m/:id/instances?include=sleeping, or the idle-unload
// list before 01). The pure merge lives in lib/deployments-model.js.

import {
  buildDeployments, cleanFilter, filterOptions, filterRows, gibText, profileEntries, recentEntries, requestsByFleet, STATE_STATUS,
} from "../lib/deployments-model.js";
import { tk } from "../lib/i18n.js";
import { managerName } from "../lib/overview-model.js";
import { FleetGuard } from "../lib/schemas.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { DataTable } from "../components/data-table.js";
import { useStopAction, useWakeAction } from "../components/deployment-actions.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeader } from "../components/page-header.js";
import { StatusBadge } from "../components/status-badge.js";
import { replaceQueryParam } from "../components/tabs.js";
import { useServices } from "../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useMemo, useState } from "../ui/vendor.js";

const HOUR_MS = 60 * 60 * 1000;
const RECENT_SHOWN = 5;

export const detailHref = (fleetId, tab) => `/deployments/${encodeURIComponent(fleetId)}${tab ? `?tab=${tab}` : ""}`;

// One call per manager; a manager that does not answer only drops out of the list.
async function perManager(managerIds, call) {
  const answers = await Promise.allSettled(managerIds.map((id) => call(id)));
  return answers.map((answer, index) => ({ managerId: managerIds[index], answer }));
}

function StateCell({ row }) {
  const { t } = useT();
  const fmt = useFormat();
  const percent = row.percent === null ? "" : ` ${fmt.integer(Math.round(row.percent))}%`;
  return html`<span class="deploy-state"><${StatusBadge} status=${STATE_STATUS[row.state] || "unknown"} label=${`${t(tk("deploy.state.", row.state))}${percent}`} />
    ${row.state === "loading" && row.phase ? html`<span class="muted xsmall"> · ${t(tk("deploy.phase.", row.phase))}</span>` : null}</span>`;
}

function Filters({ options, values, onChange, managers }) {
  const i18n = useT();
  const { t } = i18n;
  const select = (id, label, items, render) => html`<label class="deploy-filter">
    <span class="small muted">${label}</span>
    <select class="select" value=${values[id]} data-testid=${`deploy.filter.${id}`} onChange=${(event) => onChange(id, event.currentTarget.value)}>
      <option value="" selected=${!values[id]}>${t("deploy.filter.all")}</option>
      ${items.map((item) => html`<option key=${item} value=${item} selected=${values[id] === item}>${render(item)}</option>`)}
    </select>
  </label>`;
  return html`<div class="row deploy-filters" role="group" aria-label=${t("deploy.filter.label")}>
    ${select("engine", t("deploy.filter.engine"), options.engines, (id) => id)}
    ${select("manager", t("deploy.filter.manager"), options.managers, (id) => managerName(managers, id, i18n))}
    ${select("state", t("deploy.filter.state"), options.states, (id) => t(tk("deploy.state.", id)))}
  </div>`;
}

function SleepingCard({ rows, owner, wake, managers }) {
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  if (!rows.length) return null;
  return html`<${Card} title=${t("deploy.sleeping.title")} testid="deploy.sleeping">
    <p class="muted small">${t("deploy.sleeping.hint")}</p>
    <div class="table-wrap" role="region" tabindex="0" aria-label=${t("deploy.sleeping.scroll")}>
      <table class="table">
        <caption class="sr-only">${t("deploy.sleeping.title")}</caption>
        <thead><tr>
          <th scope="col">${t("deploy.col.model")}</th><th scope="col">${t("deploy.col.engine")}</th><th scope="col">${t("deploy.col.manager")}</th>
          <th scope="col" class="num">${t("deploy.col.vram")}</th><th scope="col">${t("deploy.sleeping.since")}</th>
          <th scope="col"><span class="sr-only">${t("deploy.col.actions")}</span></th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr key=${row.key} data-render-key=${row.key} data-testid="deploy.sleeping.row">
            <td><a href=${detailHref(row.fleetId)}>${row.model}</a></td>
            <td><code class="code-inline">${row.engine}</code></td>
            <td>${managerName(managers, row.managerId, i18n)}</td>
            <td class="num tabular">${gibText(fmt, row.vramMb)}</td>
            <td>${row.sleptAt ? html`<time dateTime=${row.sleptAt} title=${fmt.dateTime(row.sleptAt)}>${fmt.relative(row.sleptAt)}</time>` : "—"}</td>
            <td>${owner && row.wakeable ? html`<${Button} size="sm" busy=${wake.busyKey === row.key} label=${t("deploy.action.wakeFor", { model: row.model })}
              onClick=${() => wake.start(row)} testid="deploy.row.wake">${t("deploy.action.wake")}<//>` : null}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  <//>`;
}

function RecentCard({ feeds, owner, managers }) {
  const i18n = useT();
  const { t } = i18n;
  const fmt = useFormat();
  if (!owner) return null;
  return html`<${Card} title=${t("deploy.recent.title")} testid="deploy.recent">
    <p class="muted small">${t("deploy.recent.hint")}</p>
    <div class="deploy-recent-grid">
      ${feeds.map((feed) => html`<section key=${feed.managerId} class="stack-sm" aria-label=${managerName(managers, feed.managerId, i18n)} data-manager=${feed.managerId} data-testid="deploy.recent.manager">
        <h3 class="deploy-recent-title">${managerName(managers, feed.managerId, i18n)}</h3>
        ${feed.recent.length || feed.profiles.length ? html`<ul class="overview-list">
          ${feed.recent.slice(0, RECENT_SHOWN).map((entry, index) => html`<li key=${entry.key} class="overview-item" data-testid="deploy.recent.launch">
            <span class="overview-item-text">${entry.model}${entry.launchedAt ? html` <span class="muted small">· ${fmt.relative(entry.launchedAt)}</span>` : null}</span>
            <${Button} size="sm" label=${t("deploy.recent.reviewFor", { model: entry.model })}
              href=${`/deployments/new?manager=${encodeURIComponent(feed.managerId)}&step=review&from=recent&recent=${index}`} testid="deploy.recent.review">${t("deploy.recent.review")}<//>
          </li>`)}
          ${feed.profiles.map((profile) => html`<li key=${`p:${profile.id}`} class="overview-item" data-testid="deploy.recent.profile">
            <span class="overview-item-text">${profile.name}${profile.builtin ? html` <span class="muted small">· ${t("deploy.recent.builtin")}</span>` : null}</span>
            <${Button} size="sm" label=${t("deploy.recent.reviewFor", { model: profile.name })}
              href=${`/deployments/new?manager=${encodeURIComponent(feed.managerId)}&profile=${encodeURIComponent(profile.id)}&step=review`} testid="deploy.recent.review-profile">${t("deploy.recent.review")}<//>
          </li>`)}
        </ul>` : html`<p class="muted small" data-testid="deploy.recent.empty">${t("deploy.recent.empty")}</p>`}
      </section>`)}
    </div>
  <//>`;
}

export default function Deployments({ query = {} }) {
  const services = useServices();
  const { api, bootstrap, cache } = services;
  const i18n = useT();
  const { t } = i18n;
  const role = useRole();
  const owner = role === "owner";
  const features = bootstrap?.features || {};
  const managers = Array.isArray(bootstrap?.managers) ? bootstrap.managers : [];
  const managerIds = managers.map((item) => item.id).filter(Boolean);
  const telemetry = Boolean(features.telemetry);
  const [filters, setFilters] = useState(() => ({
    engine: String(query?.engine || ""), manager: cleanFilter(query?.manager, managerIds), state: String(query?.state || ""),
  }));
  const stop = useStopAction();
  const wake = useWakeAction();

  const fleet = useQuery(["fleet"], () => api.get("/api/fleet", { guard: FleetGuard }), { ttlMs: 5000, refetchMs: 10000 });
  // Under the "fleet" prefix, so an `instances` event refreshes it with the fleet itself.
  const typed = useQuery(["fleet", "managers", managerIds.join(","), owner ? "owner" : "viewer"], async () => {
    const answers = await perManager(managerIds, async (id) => {
      const manager = api.manager(id);
      const instances = await manager.get("/instances", { query: { include: "sleeping" } });
      // Before 01 the sleeping records only exist in the idle-unload ledger (an owner read).
      const idle = !features.engines && owner ? await manager.get("/idle-unload").catch(() => null) : null;
      return { instances, idle };
    });
    return answers.flatMap(({ managerId, answer }) => (answer.status === "fulfilled" ? [{ managerId, ...answer.value }] : []));
  }, { ttlMs: 5000, refetchMs: 10000, enabled: managerIds.length > 0 });
  const live = useQuery(["telemetry", "live"], () => api.get("/api/telemetry/live"), { ttlMs: 5000, refetchMs: 5000, enabled: telemetry });
  const hour = useQuery(["telemetry", "breakdown", "fleet", "1h"], () => {
    const to = Date.now();
    return api.get("/api/telemetry/breakdown", { query: { dim: "fleet", metrics: "requests", from: new Date(to - HOUR_MS).toISOString(), to: new Date(to).toISOString(), limit: 200 } });
  }, { ttlMs: 20000, refetchMs: 30000, enabled: telemetry });
  const recent = useQuery(["deployments", "recent", managerIds.join(",")], async () => {
    const answers = await perManager(managerIds, async (id) => {
      const manager = api.manager(id);
      const [launches, profiles] = await Promise.all([manager.get("/recent-launches").catch(() => null), manager.get("/tools/profiles").catch(() => null)]);
      return { launches, profiles };
    });
    return answers.map(({ managerId, answer }) => ({
      managerId,
      recent: answer.status === "fulfilled" ? recentEntries(answer.value.launches) : [],
      profiles: answer.status === "fulfilled" ? profileEntries(answer.value.profiles) : [],
    }));
  }, { ttlMs: 30000, refetchMs: 60000, enabled: owner && managerIds.length > 0 });

  const built = useMemo(() => buildDeployments({
    fleet: fleet.data, managers: typed.data || [], live: live.data, requests: requestsByFleet(hour.data),
  }), [fleet.data, typed.data, live.data, hour.data]);
  const options = filterOptions(built.rows, managers);
  const rows = filterRows(built.rows, filters);
  const sleeping = filterRows(built.sleeping, { engine: filters.engine, manager: filters.manager });
  const first = fleet.status !== "success" && typed.status !== "success" && !fleet.error && !typed.error;
  const failed = !built.rows.length && !built.sleeping.length && Boolean(fleet.error) && !typed.data?.length;

  function setFilter(id, value) {
    setFilters((current) => ({ ...current, [id]: value }));
    replaceQueryParam(id, value);
  }

  async function reload() {
    for (const prefix of [["fleet"], ["deployments"], ["telemetry"]]) cache.invalidate(prefix);
  }

  const fmt = useFormat();
  const columns = [
    { id: "state", header: t("deploy.col.state"), sort: (row) => row.state, cell: (row) => html`<${StateCell} row=${row} />` },
    {
      id: "model", header: t("deploy.col.model"), sort: (row) => row.model,
      cell: (row) => html`<a href=${detailHref(row.fleetId)} data-testid="deploy.row.link">${row.model}</a>${row.extraModels ? html` <span class="muted">+${row.extraModels}</span>` : null}`,
    },
    { id: "engine", header: t("deploy.col.engine"), sort: (row) => row.engine, cell: (row) => html`<code class="code-inline">${row.engine}</code>` },
    { id: "recipe", header: t("deploy.col.recipe"), hideable: true, sort: (row) => row.recipeId, cell: (row) => (row.recipeId ? html`<code class="code-inline">${row.recipeId}</code>` : "—") },
    { id: "port", header: t("deploy.col.port"), align: "end", sort: (row) => row.port, cell: (row) => (row.port === null ? "—" : html`<span class="tabular">${row.port}</span>`) },
    { id: "context", header: t("deploy.col.context"), align: "end", sort: (row) => row.context, cell: (row) => (row.context === null ? "—" : html`<span class="tabular">${fmt.tokens(row.context)}</span>`) },
    { id: "vram", header: t("deploy.col.vram"), align: "end", hideable: true, sort: (row) => row.vramMb, cell: (row) => (row.vramMb === null ? "—" : html`<span class="tabular">${gibText(fmt, row.vramMb)}</span>`) },
    { id: "gpus", header: t("deploy.col.gpus"), hideable: true, sort: (row) => row.gpus.join(","), cell: (row) => (row.gpus.length ? row.gpus.join(", ") : "—") },
    { id: "tps", header: t("deploy.col.tps"), align: "end", sort: (row) => row.tps, cell: (row) => (row.tps === null ? "—" : html`<span class="tabular">${fmt.number(row.tps, 1)}</span>`) },
    { id: "requests", header: t("deploy.col.requests"), align: "end", hideable: true, sort: (row) => row.requests1h, cell: (row) => (row.requests1h === null ? "—" : html`<span class="tabular">${fmt.integer(row.requests1h)}</span>`) },
    { id: "uptime", header: t("deploy.col.uptime"), align: "end", hideable: true, sort: (row) => row.uptimeMs, cell: (row) => (row.uptimeMs === null ? "—" : html`<span class="tabular">${fmt.duration(row.uptimeMs)}</span>`) },
    {
      id: "actions", header: html`<span class="sr-only">${t("deploy.col.actions")}</span>`, csv: false,
      cell: (row) => html`<div class="row-nowrap">
        ${row.state === "ready" ? html`<${Button} size="sm" href=${`/playground?model=${encodeURIComponent(row.model)}`} label=${t("overview.row.playgroundFor", { model: row.model })} testid="deploy.row.playground">${t("overview.row.playground")}<//>` : null}
        <${Button} size="sm" href=${detailHref(row.fleetId, "logs")} label=${t("deploy.action.logsFor", { instance: row.fleetId })} testid="deploy.row.logs">${t("deploy.action.logs")}<//>
        ${owner && row.state !== "stopped" ? html`<${Button} size="sm" variant="danger" label=${t("overview.row.stopFor", { instance: row.fleetId })} onClick=${() => stop.start(row)} testid="deploy.row.stop">${t("overview.row.stop")}<//>` : null}
      </div>`,
    },
  ];

  const empty = html`<${EmptyState} icon="boxes" title=${t("overview.deployments.empty.title")} body=${t("overview.deployments.empty.body")}
    action=${owner ? { label: t("overview.quick.new"), href: "/deployments/new" } : { label: t("deploy.list.refresh"), onClick: reload }} testid="deploy.list.empty" />`;
  const actions = html`<${Button} onClick=${reload} icon="refresh-cw" testid="deploy.list.refresh">${t("deploy.list.refresh")}<//>
    <${Button} href="/deployments/routing" icon="route" testid="deploy.list.routing">${t("deploy.routing.link")}<//>
    ${owner ? html`<${Button} variant="primary" icon="rocket" href="/deployments/new" testid="deploy.list.new">${t("overview.quick.new")}<//>` : null}`;

  return html`<div class="stack deploy" data-ready=${first ? "false" : "true"} data-testid="deploy.list.root">
    <${PageHeader} title=${t("shell.nav.deployments")} actions=${actions}
      meta=${html`<span class="muted small" data-testid="deploy.list.count">${t("deploy.list.count", { count: rows.length })}</span>`} />
    ${failed ? html`<div class="notice notice-danger" role="alert" data-testid="deploy.list.error"><span class="grow">${t("deploy.list.error")}</span>
      <${Button} size="sm" onClick=${reload}>${t("deploy.list.retry")}<//></div>` : null}
    <${Card} title=${t("deploy.list.title")} testid="deploy.list">
      <${DataTable} id="deployments" caption=${t("shell.nav.deployments")} columns=${columns} rows=${rows} rowKey="key" rowAttrs=${(row) => ({ "data-render-key": row.key })}
        responsive="cards" loading=${first} empty=${empty} exportName="deployments"
        filters=${html`<${Filters} options=${options} values=${filters} onChange=${setFilter} managers=${managers} />`} testid="deploy.table" />
    <//>
    <${SleepingCard} rows=${sleeping} owner=${owner} wake=${wake} managers=${managers} />
    <${RecentCard} feeds=${recent.data || managerIds.map((managerId) => ({ managerId, recent: [], profiles: [] }))} owner=${owner} managers=${managers} />
    ${stop.dialog}
    ${wake.dialog}
  </div>`;
}
