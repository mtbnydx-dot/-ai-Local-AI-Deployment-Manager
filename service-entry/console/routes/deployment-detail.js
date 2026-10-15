// Deployment detail `/deployments/:fleetId` (07 §6.2): Overview, Metrics,
// Logs, Config, Requests and Events tabs (`?tab=`), and the header actions
// Stop, Relaunch, Wake and Open legacy UI.
//
// - Overview: the launch Stepper with per-phase durations from
//   `lifecycle.phaseHistory` (00 §9.17), endpoints with copy, capability
//   chips, image and recipe, the GPU memory bar and the key facts of the
//   metrics reply.
// - Metrics: live tiles from the instance `metrics` (a key in `unsupported[]`
//   reads "not reported", never 0), then the telemetry charts of this fleetId.
// - Logs: the LogViewer polls the manager's per-instance log with `since` and
//   appends without repeating lines.
// - Config: the LaunchStore record as a read-only SchemaForm and the redacted
//   command. Clone and Save as profile open the wizard. The qualification block
//   (verify the deployment, Save as recipe; CON-31) sits below.
// - Relaunch never starts anything here: it opens the wizard's Review step.
// - Wake sends the sleep record id and asks before it replaces a running model.
//
// Logs, config and launch records are owner-only (01 §20); a viewer sees the
// Overview, the metrics and the events.

import {
  buildDeployments, capabilityIds, DETAIL_TABS, endpointsOf, factsOf, lifecycleSteps, memoryOf, relaunchHref, splitFleetId, STATE_STATUS,
} from "../lib/deployments-model.js";
import { tk } from "../lib/i18n.js";
import { FleetGuard } from "../lib/schemas.js";
import { legacyUiHref } from "../lib/url.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { copyText } from "../components/code-block.js";
import { useStopAction, useWakeAction } from "../components/deployment-actions.js";
import { EmptyState } from "../components/empty-state.js";
import { GpuMemoryBar } from "../components/gpu-memory-bar.js";
import { PageHeader } from "../components/page-header.js";
import { StatusBadge } from "../components/status-badge.js";
import { Stepper } from "../components/stepper.js";
import { Tabs, readQueryParam } from "../components/tabs.js";
import { useServices } from "../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useMemo, useState } from "../ui/vendor.js";
import { LazyView } from "./deployment-detail/lazy.js";

const enc = encodeURIComponent;

function Chips({ ids }) {
  const { t } = useT();
  if (!ids.length) return html`<span class="muted">—</span>`;
  return html`<ul class="deploy-chips" aria-label=${t("deploy.detail.capabilities")}>
    ${ids.map((id) => html`<li key=${id} class="deploy-chip" data-testid="deploy.chip">${t(tk("deploy.capability.", id))}</li>`)}
  </ul>`;
}

function Fact({ label, children, testid }) {
  return html`<div class="deploy-fact" data-testid=${testid}><dt class="small muted">${label}</dt><dd>${children}</dd></div>`;
}

// ---------------------------------------------------------------------------
// Overview

function OverviewTab({ row, fleet, launch, metrics, ctx }) {
  const { t, has } = useT();
  const services = useServices();
  const fmt = useFormat();
  const instance = row.instance || {};
  const steps = lifecycleSteps(instance);
  const phaseSteps = steps.map((step) => ({ id: step.id, state: step.state, durationMs: step.durationMs, label: t(tk("deploy.phase.", step.id)) }));
  const endpoints = endpointsOf(instance, { managerId: row.managerId, origin: ctx.origin, autoPath: services.bootstrap?.gateway?.autoOpenAi });
  const memory = memoryOf(row, fleet, launch, t("deploy.memory.own"));
  const facts = factsOf(metrics);
  const image = instance.runtime?.image || instance.image || "";
  const digest = instance.runtime?.digest || "";

  async function copy(url) {
    const ok = await copyText(url);
    services.toasts?.push?.({ level: ok ? "success" : "warn", title: t(ok ? "shell.palette.copied" : "common.copyFailed") });
  }

  return html`<div class="stack" data-testid="deploy.tab.overview">
    <${Card} title=${t("deploy.detail.lifecycle")} testid="deploy.lifecycle">
      ${phaseSteps.length
        ? html`<${Stepper} steps=${phaseSteps} label=${t("deploy.detail.lifecycle")} testid="deploy.stepper" />`
        : html`<p class="muted" data-testid="deploy.lifecycle.plain">${t(tk("deploy.state.", row.state))}${row.uptimeMs !== null ? ` · ${t("deploy.detail.upFor", { time: fmt.duration(row.uptimeMs) })}` : ""}</p>`}
    <//>
    <${Card} title=${t("deploy.detail.endpoints")} testid="deploy.endpoints">
      ${endpoints.length ? html`<ul class="deploy-endpoints">
        ${endpoints.map((item) => html`<li key=${item.id} data-endpoint=${item.id} data-testid="deploy.endpoint">
          <span class="small muted">${t(tk("deploy.endpoint.", item.id))}</span>
          <code class="code-inline deploy-url">${item.url}</code>
          <${Button} size="sm" label=${t("deploy.endpoint.copyFor", { name: t(tk("deploy.endpoint.", item.id)) })} onClick=${() => copy(item.url)} testid="deploy.endpoint.copy">${t("common.copy")}<//>
        </li>`)}
      </ul>` : html`<p class="muted">${t("deploy.detail.noEndpoints")}</p>`}
    <//>
    <${Card} title=${t("deploy.detail.facts")} testid="deploy.facts">
      <dl class="deploy-facts">
        <${Fact} label=${t("deploy.col.engine")}><code class="code-inline">${row.engine}</code><//>
        <${Fact} label=${t("deploy.col.recipe")}>${row.recipeId ? html`<code class="code-inline">${row.recipeId}</code>` : "—"}<//>
        <${Fact} label=${t("deploy.detail.capabilities")}><${Chips} ids=${capabilityIds(instance)} /><//>
        <${Fact} label=${t("deploy.detail.image")} testid="deploy.fact.image">${image ? html`<code class="code-inline deploy-url">${image}${digest ? `@${digest}` : ""}</code>` : "—"}<//>
        <${Fact} label=${t("deploy.col.context")}>${row.context === null ? "—" : fmt.tokens(row.context)}<//>
        <${Fact} label=${t("deploy.col.gpus")}>${row.gpus.length ? row.gpus.join(", ") : "—"}<//>
        ${facts.map((fact) => html`<${Fact} key=${fact.id} label=${has(tk("deploy.fact.", fact.id)) ? t(tk("deploy.fact.", fact.id)) : fact.id} testid="deploy.fact">${typeof fact.value === "number" ? fmt.number(fact.value, 1) : fact.value}<//>`)}
      </dl>
    <//>
    ${memory ? html`<${Card} title=${t("deploy.detail.memory")} testid="deploy.memory">
      <${GpuMemoryBar} gpu=${memory.gpu} segments=${memory.segments} otherTenantsMb=${memory.otherTenantsMb} admissionMb=${memory.admissionMb || undefined} />
    <//>` : null}
  </div>`;
}

// ---------------------------------------------------------------------------
// Page

export default function DeploymentDetail({ params = {}, query = {} }) {
  const services = useServices();
  const { api, bootstrap } = services;
  const i18n = useT();
  const { t } = i18n;
  const role = useRole();
  const owner = role === "owner";
  const features = bootstrap?.features || {};
  const telemetry = Boolean(features.telemetry);
  const fleetId = String(params.fleetId || "");
  const { managerId, instanceId } = splitFleetId(fleetId);
  const managers = Array.isArray(bootstrap?.managers) ? bootstrap.managers : [];
  const stop = useStopAction();
  const wake = useWakeAction();
  const origin = globalThis.location?.origin || "";

  const fleet = useQuery(["fleet"], () => api.get("/api/fleet", { guard: FleetGuard }), { ttlMs: 5000, refetchMs: 10000 });
  const typed = useQuery(["fleet", "manager", managerId, owner ? "owner" : "viewer"], async () => {
    const manager = api.manager(managerId);
    const instances = await manager.get("/instances", { query: { include: "sleeping" } });
    const idle = !features.engines && owner ? await manager.get("/idle-unload").catch(() => null) : null;
    return { instances, idle };
  }, { ttlMs: 5000, refetchMs: 10000, enabled: Boolean(managerId) });
  const live = useQuery(["telemetry", "live"], () => api.get("/api/telemetry/live"), { ttlMs: 5000, refetchMs: 5000, enabled: telemetry });

  const built = useMemo(() => buildDeployments({
    fleet: fleet.data, managers: typed.data ? [{ managerId, ...typed.data }] : [], live: live.data,
  }), [fleet.data, typed.data, live.data, managerId]);
  const row = built.rows.find((item) => item.key === fleetId) || built.sleeping.find((item) => item.key === fleetId) || null;
  const sleeping = row?.state === "sleeping";
  const running = Boolean(row) && !sleeping && row.state !== "stopped";
  const metricsQuery = useQuery(["deployments", "metrics", fleetId], () => api.manager(managerId).get(`/instances/${enc(instanceId)}/metrics`), {
    ttlMs: 5000, refetchMs: 10000, enabled: Boolean(row) && running,
  });
  const launch = useQuery(["m", managerId, "launch", instanceId, row?.launchId || ""], () => api.manager(managerId).get(`/instances/${enc(instanceId)}/launch`), {
    ttlMs: 15000, enabled: Boolean(row) && owner && !sleeping,
  });

  const tabsList = [
    { id: "overview", label: t("deploy.tab.overview") },
    { id: "metrics", label: t("deploy.tab.metrics"), disabled: sleeping },
    { id: "logs", label: t("deploy.tab.logs"), disabled: !owner || sleeping },
    { id: "config", label: t("deploy.tab.config"), disabled: !owner },
    { id: "requests", label: t("deploy.tab.requests"), disabled: !telemetry },
    { id: "events", label: t("deploy.tab.events") },
  ];
  // The wizard's old "Qualify this deployment" link (?qualify=1) lands on the Config tab, where the qualification block lives.
  const initial = readQueryParam("tab") || query?.tab || (readQueryParam("qualify") ? "config" : "");
  const [tab, setTab] = useState(() => (DETAIL_TABS.includes(initial) && !tabsList.find((item) => item.id === initial)?.disabled ? initial : "overview"));
  const active = tabsList.find((item) => item.id === tab)?.disabled ? "overview" : tab;

  const loading = !row && (fleet.status !== "success" && !fleet.error) && (typed.status !== "success" && !typed.error);
  const legacyPort = managers.find((item) => item.id === managerId)?.legacyUiPort;
  const legacy = legacyUiHref(globalThis.location, Number.isInteger(legacyPort) ? legacyPort : 0);

  if (!row) {
    return html`<div class="stack deploy" data-ready=${loading ? "false" : "true"} data-testid="deploy.detail.root">
      <${PageHeader} title=${t("deploy.detail.notFound.title")} breadcrumbs=${[{ label: t("shell.nav.deployments"), href: "/deployments" }, { label: fleetId }]} />
      ${loading ? html`<p class="muted" aria-busy="true">…</p>` : html`<${EmptyState} icon="boxes" title=${t("deploy.detail.notFound.title")} body=${t("deploy.detail.notFound.body", { instance: fleetId })}
        action=${{ label: t("deploy.detail.back"), href: "/deployments" }} testid="deploy.detail.notfound" />`}
    </div>`;
  }

  const actions = html`<${Button} href=${`/playground?model=${enc(row.model)}`} disabled=${row.state !== "ready"} testid="deploy.action.playground">${t("overview.row.playground")}<//>
    ${owner && !sleeping ? html`<${Button} icon="rotate-cw" href=${relaunchHref({ managerId, launchId: row.launchId, instanceId })} testid="deploy.action.relaunch">${t("deploy.action.relaunch")}<//>` : null}
    ${owner && sleeping && row.wakeable ? html`<${Button} variant="primary" icon="power" busy=${wake.busyKey === row.key} onClick=${() => wake.start(row)} testid="deploy.action.wake">${t("deploy.action.wake")}<//>` : null}
    ${owner && running ? html`<${Button} variant="danger" icon="square" onClick=${() => stop.start(row)} testid="deploy.action.stop">${t("overview.row.stop")}<//>` : null}
    ${legacy ? html`<${Button} href=${legacy} target="_blank" rel="noopener noreferrer" icon="external-link" testid="deploy.action.legacy">${t("deploy.action.legacy")}<//>` : null}`;
  const percent = row.percent === null ? "" : ` ${Math.round(row.percent)}%`;

  return html`<div class="stack deploy" data-ready="true" data-state=${row.state} data-testid="deploy.detail.root">
    <${PageHeader} title=${row.model} breadcrumbs=${[{ label: t("shell.nav.deployments"), href: "/deployments" }, { label: row.fleetId }]} actions=${actions}
      meta=${html`<${StatusBadge} status=${STATE_STATUS[row.state] || "unknown"} label=${`${t(tk("deploy.state.", row.state))}${percent}`} />
        <code class="code-inline">${row.engine}</code><span class="muted small">${row.fleetId}</span>`} />
    <${Tabs} tabs=${tabsList} value=${active} onChange=${setTab} label=${t("deploy.detail.tabs")} testid="deploy.tabs"
      renderPanel=${(id) => {
        if (id === "metrics") return html`<${LazyView} load=${() => import("./deployment-detail/metrics.js")} name="MetricsTab" row=${row} metricsQuery=${metricsQuery} telemetry=${telemetry} loaded=${metricsQuery.status === "success" || Boolean(metricsQuery.error)} />`;
        if (id === "logs") return html`<${LazyView} load=${() => import("./deployment-detail/logs.js")} name="LogsTab" row=${row} />`;
        if (id === "config") return html`<${LazyView} load=${() => import("./deployment-detail/config.js")} name="ConfigTab" row=${row} owner=${owner} />`;
        if (id === "requests") return html`<${LazyView} load=${() => import("./deployment-detail/activity.js")} name="RequestsTab" row=${row} />`;
        if (id === "events") return html`<${LazyView} load=${() => import("./deployment-detail/activity.js")} name="EventsTab" row=${row} telemetry=${telemetry} />`;
        return html`<${OverviewTab} row=${row} fleet=${fleet.data} launch=${launch.data?.launch || null} metrics=${metricsQuery.data} ctx=${{ origin }} />`;
      }} />
    ${stop.dialog}
    ${wake.dialog}
  </div>`;
}
