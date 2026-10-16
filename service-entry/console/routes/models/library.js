// /models (07 §6.4 "Library"): every model on this machine, with the capacity
// of each storage root above it.
//
// Rows come from GET /api/hub/library (03 §9): name, role, format and quant,
// size, root, engine chips (the engines a card is known to run on),
// verification, provenance `repo@rev`, update state and last use. Facets: root,
// format, runnable-on-engine, role, has-update. Actions per row: Deploy,
// Verify, Check update, Update, Move (the Storage page's migration planner),
// Probe (the detail page's Compatibility tab), clean up leftovers and Delete
// (type-to-confirm, library-actions.js).
//
// Before the hub exists the rows are the managers' own listing
// (`/api/m/{vllm,llama}/models`): name, size, format and verification are there,
// provenance, update state and cards are not, and a banner says so (data.js).

import { describeError } from "../../lib/api.js";
import { EMPTY_FILTERS, applyFilters, canDelete, facetOptions } from "../../lib/library-model.js";
import { Button } from "../../components/button.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";
import { CapacityBars } from "./capacity.js";
import { useLibraryQuery, useUsageQuery } from "./data.js";
import { useLibraryActions } from "./library-actions.js";
import { ModelsNav } from "./subnav.js";

const enc = encodeURIComponent;
const VERIFY_STATUS = Object.freeze({ ok: "ok", warn: "warn", fail: "error", unchecked: "unknown" });

function RoleCell({ view }) {
  const { t, has, tk } = useT();
  if (!view.role) return html`<span class="muted">—</span>`;
  const key = tk("models.role.", view.role);
  return html`<span class="badge badge-neutral">${has(key) ? t(key) : view.role}</span>`;
}

function UpdateCell({ view }) {
  const { t } = useT();
  const fmt = useFormat();
  if (view.update === "available") {
    return html`<${StatusBadge} status="info" label=${t("hub.library.update.available", { files: view.updateFiles, size: fmt.bytes(view.updateBytes) })} />`;
  }
  if (view.update === "current") return html`<span class="muted small">${t("hub.library.update.upToDate")}</span>`;
  if (view.update === "unsupported") return html`<span class="muted small">${t("hub.library.update.noSource")}</span>`;
  if (view.update === "error") return html`<${StatusBadge} status="warn" label=${t("hub.library.update.failed")} />`;
  return html`<span class="muted">—</span>`;
}

function NameCell({ view, byId }) {
  const { t } = useT();
  const fmt = useFormat();
  const href = view.routeId ? `/models/library/${enc(view.routeId)}` : null;
  const twin = view.duplicates.map((id) => byId.get(id)).find(Boolean);
  return html`<div class="stack-sm library-name">
    <span class="row library-name-heading">
      ${href ? html`<a class="library-model-name" href=${href} title=${view.name} data-user-content="" data-testid="library.link">${view.name}</a>` : html`<span class="library-model-name" title=${view.name} data-user-content="">${view.name}</span>`}
      ${view.cache ? html`<span class="badge badge-neutral">${t("hub.library.cache")}</span>` : null}
      ${twin ? html`<span class="badge badge-warn" title=${t("hub.library.duplicate", { name: twin.name, size: fmt.bytes(Math.min(twin.bytes, view.bytes)) })} data-testid="library.duplicate">${t("hub.library.duplicateBadge")}</span>` : null}
      ${view.residueFiles ? html`<span class="badge badge-warn" data-testid="library.residue">${t("hub.library.residue", { size: fmt.bytes(view.residueBytes) })}</span>` : null}
    </span>
    ${view.path ? html`<span class="xsmall muted mono truncate library-model-path" title=${view.path} data-user-content="">${view.path}</span>` : null}
  </div>`;
}

function RowActions({ view, owner, actions }) {
  const { t } = useT();
  const { run, busy, startDelete } = actions;
  if (!owner) return null;
  const hub = !view.legacy && Boolean(view.id);
  const deployHref = `/deployments/new?model=${enc(view.path)}`;
  return html`<div class="row library-actions" data-testid="library.actions" data-entry=${view.key}>
    ${view.runnable && !view.cache && view.path ? html`<${Button} size="sm" variant="primary" href=${deployHref} testid="library.deploy">${t("hub.library.action.deploy")}<//>` : null}
    ${hub ? html`<${Button} size="sm" busy=${Boolean(busy[`${view.key}:verify`])} onClick=${() => run.verify(view)} testid="library.verify">${t("hub.library.action.verify")}<//>` : null}
    ${hub && view.provenanceRepo ? html`<${Button} size="sm" busy=${Boolean(busy[`${view.key}:checkUpdate`])} onClick=${() => run.checkUpdate(view)} testid="library.check-update">${t("hub.library.action.checkUpdate")}<//>` : null}
    ${hub && view.update === "available" ? html`<${Button} size="sm" busy=${Boolean(busy[`${view.key}:update`])} onClick=${() => run.update(view)} testid="library.update">${t("hub.library.action.update")}<//>` : null}
    ${hub && view.residueFiles ? html`<${Button} size="sm" busy=${Boolean(busy[`${view.key}:cleanup`])} onClick=${() => run.cleanup(view)} testid="library.cleanup">${t("hub.library.action.cleanup")}<//>` : null}
    ${!view.cache && view.path ? html`<${Button} size="sm" href=${`/models/storage?move=${enc(view.path)}`} testid="library.move">${t("hub.library.action.move")}<//>` : null}
    ${view.routeId && view.runnable ? html`<${Button} size="sm" href=${`/models/library/${enc(view.routeId)}?tab=compat`} testid="library.probe">${t("hub.library.action.probe")}<//>` : null}
    ${canDelete(view) ? html`<${Button} size="sm" variant="danger" onClick=${() => startDelete(view)} testid="library.delete-open">${t("hub.library.action.delete")}<//>` : null}
    ${hub && view.isRoot ? html`<span class="xsmall muted" data-testid="library.root-note">${t("hub.library.delete.isRoot")}</span>` : null}
  </div>`;
}

function Filters({ filters, options, onChange, hubSource }) {
  const { t, has, tk } = useT();
  const select = (id, label, items, render) => html`<label class="deploy-filter">
    <span class="small muted">${label}</span>
    <select class="select" value=${filters[id]} data-testid=${`library.filter.${id}`} onChange=${(event) => onChange({ [id]: event.currentTarget.value })}>
      <option value="" selected=${!filters[id]}>${t("hub.library.filter.all")}</option>
      ${items.map((item) => html`<option key=${item.value} value=${item.value} selected=${filters[id] === item.value}>${render(item)}</option>`)}
    </select>
  </label>`;
  const plain = (values) => values.map((value) => ({ value, label: value }));
  return html`<div class="row deploy-filters library-filters" role="group" aria-label=${t("hub.library.filter.label")}>
    <label class="deploy-filter library-search">
      <span class="small muted">${t("hub.library.filter.search")}</span>
      <input class="input" type="search" value=${filters.q} data-testid="library.filter.q" autocomplete="off"
        onInput=${(event) => onChange({ q: event.currentTarget.value })} />
    </label>
    ${options.roots.length > 1 ? select("rootId", t("hub.library.filter.root"), options.roots.map((root) => ({ value: root.id, label: root.label })), (item) => item.label) : null}
    ${options.formats.length ? select("format", t("hub.library.filter.format"), plain(options.formats), (item) => item.label) : null}
    ${hubSource && options.engines.length ? select("engine", t("hub.library.filter.engine"), plain(options.engines), (item) => item.label) : null}
    ${hubSource && options.roles.length ? select("role", t("hub.library.filter.role"), plain(options.roles), (item) => (has(tk("models.role.", item.value)) ? t(tk("models.role.", item.value)) : item.value)) : null}
    ${hubSource ? html`<label class="row-nowrap">
      <input type="checkbox" checked=${filters.hasUpdate} disabled=${!options.canFilterUpdate && !filters.hasUpdate} data-testid="library.filter.update"
        onChange=${(event) => onChange({ hasUpdate: event.currentTarget.checked })} />
      <span class="small">${t("hub.library.filter.hasUpdate")}</span>
    </label>` : null}
  </div>`;
}

export default function LibraryPage() {
  const { i18n } = useServices();
  const { t, tk } = useT();
  const fmt = useFormat();
  const owner = useRole() === "owner";
  const library = useLibraryQuery();
  const usage = useUsageQuery();
  const actions = useLibraryActions();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const data = library.data;
  const views = data?.views || [];
  const hubSource = data?.source === "hub";
  const options = useMemo(() => facetOptions(views, data?.roots), [views, data?.roots]);
  const shown = useMemo(() => applyFilters(views, filters), [views, filters]);
  const byId = useMemo(() => new Map(views.filter((view) => view.id).map((view) => [view.id, view])), [views]);
  const totalBytes = views.reduce((sum, view) => sum + view.bytes, 0);

  const columns = [
    { id: "name", width: 360, header: t("hub.library.col.name"), sort: (view) => view.name.toLowerCase(), cell: (view) => html`<${NameCell} view=${view} byId=${byId} />`, csv: (view) => view.name },
    { id: "role", width: 96, hideable: true, header: t("hub.library.col.role"), sort: (view) => view.role, cell: (view) => html`<${RoleCell} view=${view} />`, csv: (view) => view.role, defaultHidden: !hubSource },
    { id: "format", width: 128, hideable: true, header: t("hub.library.col.format"), sort: (view) => view.format, cell: (view) => (view.format || view.quant
      ? html`<span class="mono small">${[view.format, view.quant].filter(Boolean).join(" · ")}</span>` : html`<span class="muted">—</span>`), csv: (view) => [view.format, view.quant].filter(Boolean).join(" ") },
    { id: "size", width: 96, header: t("hub.library.col.size"), align: "end", sort: (view) => view.bytes, cell: (view) => html`<span class="num">${view.bytes ? fmt.bytes(view.bytes) : "—"}</span>`, csv: (view) => view.bytes },
    { id: "root", width: 104, hideable: true, header: t("hub.library.col.root"), sort: (view) => view.rootLabel, cell: (view) => html`<span data-user-content="">${view.rootLabel || "—"}</span>`, csv: (view) => view.rootLabel },
    { id: "engines", width: 112, hideable: true, header: t("hub.library.col.engines"), cell: (view) => (view.engines.length
      ? html`<span class="row" data-testid="library.engines">${view.engines.map((chip) => html`<span key=${chip.engineId} class=${`badge ${chip.verdict === "ok" ? "badge-success" : "badge-warn"}`} data-engine=${chip.engineId}>${chip.engineId}</span>`)}</span>`
      : html`<span class="muted">—</span>`), csv: (view) => view.engines.map((chip) => chip.engineId).join(" "), defaultHidden: !hubSource },
    { id: "verification", width: 120, header: t("hub.library.col.verification"), sort: (view) => view.verification, cell: (view) => html`<${StatusBadge} status=${VERIFY_STATUS[view.verification] || "unknown"} label=${t(tk("hub.library.verification.", view.verification))} />`, csv: (view) => view.verification },
    { id: "provenance", width: 200, hideable: true, header: t("hub.library.col.provenance"), sort: (view) => view.provenance, cell: (view) => (view.provenance
      ? html`<span class="stack-sm library-provenance"><code class="code-inline library-repo" title=${view.provenance} data-user-content="">${view.provenance}</code>
        <span class="xsmall muted">${t(tk("hub.library.provenance.", view.provenanceConfidence))}</span></span>`
      : html`<span class="muted" data-testid="library.no-provenance">—</span>`), csv: (view) => view.provenance, defaultHidden: !hubSource },
    { id: "update", width: 124, hideable: true, header: t("hub.library.col.update"), sort: (view) => view.update, cell: (view) => html`<${UpdateCell} view=${view} />`, csv: (view) => view.update, defaultHidden: !hubSource },
    { id: "lastUsed", width: 124, hideable: true, header: t("hub.library.col.lastUsed"), sort: (view) => view.lastLaunchedAt || "", cell: (view) => (view.lastLaunchedAt
      ? html`<time dateTime=${view.lastLaunchedAt} title=${fmt.dateTime(view.lastLaunchedAt)}>${fmt.relative(view.lastLaunchedAt)}</time>` : html`<span class="muted">—</span>`), csv: (view) => view.lastLaunchedAt },
    ...(owner ? [{ id: "actions", width: 264, header: t("hub.library.col.actions"), hideable: false, csv: false, cell: (view) => html`<${RowActions} view=${view} owner=${owner} actions=${actions} />` }] : []),
  ];

  const headerActions = html`${owner && hubSource ? html`<${Button} busy=${Boolean(actions.busy["all:rescan"])} onClick=${() => actions.run.rescan()} testid="library.rescan">${t("hub.library.rescan")}<//>` : null}
    <${Button} variant="primary" href="/models/discover" testid="library.discover">${t("hub.library.discover")}<//>`;

  let body;
  if (library.error && !data) {
    body = html`<${EmptyState} testid="library.unavailable" icon="triangle-alert" title=${t("hub.library.loadFailed")} body=${describeError(library.error, i18n)}
      action=${{ label: t("hub.library.retry"), onClick: () => library.refetch() }} />`;
  } else if (!data) {
    body = html`<${DataTable} id="library" layout="fixed" columns=${columns} rows=${[]} loading=${true} caption=${t("hub.library.title")} testid="library.table" />`;
  } else {
    body = html`<div class="stack">
      ${hubSource ? null : html`<div class="notice notice-info" role="status" data-testid="library.degraded">${t("hub.library.degraded")}</div>`}
      ${data.views.length ? null : html`<${EmptyState} testid="library.empty" icon="boxes" title=${t("hub.library.empty")} body=${t("hub.library.emptyBody")}
        action=${{ label: t("hub.library.discover"), href: "/models/discover" }} />`}
      ${data.views.length ? html`<${DataTable} id="library" layout="fixed" columns=${columns} rows=${shown} rowKey=${(view) => view.key} caption=${t("hub.library.title")} exportName="library"
        filters=${html`<${Filters} filters=${filters} options=${options} hubSource=${hubSource} onChange=${(patch) => setFilters((current) => ({ ...current, ...patch }))} />`}
        empty=${html`<p class="muted" data-testid="library.no-match">${t("hub.library.noMatch")}</p>`} testid="library.table" />` : null}
    </div>`;
  }
  return html`<div class="stack model-library" data-testid="library" data-source=${data?.source || ""}>
    <${PageHeader} title=${t("shell.nav.models")} subtitle=${data ? t("hub.library.subtitle", { count: data.views.length, size: fmt.bytes(totalBytes) }) : t("hub.library.title")} actions=${headerActions} />
    <${ModelsNav} current="library" />
    <${CapacityBars} query=${usage} />
    ${body}
    ${actions.dialog}
  </div>`;
}
