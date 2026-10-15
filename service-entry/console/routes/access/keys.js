// /access/keys (07 §6.10, 05 §13.4): the key table with filters and an
// attention strip, the create drawer with presets, revoke, rotate and bulk
// revoke behind type-to-confirm, and the one-time ShareCard. The Customers
// and Audit tabs (keys-extra.js) and the drawer (key-drawer.js) load on
// first use. Without the platform key store (features.access false) the page
// shows the legacy per-engine keys instead (keys-legacy.js).

import { attentionCounts, displayStatus, KEY_CLASSES, KEY_STATUSES, keyAttention, keyListQuery, revocable, STATUS_TONE, tokensByKey } from "../../lib/access-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Tabs } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useFeature, useRouter } from "../../ui/shell.js";
import { useEffect, useMemo, useState } from "../../ui/vendor.js";
import { BulkRevokeDialog, RevokeDialog, RotateDialog } from "./key-dialogs.js";
import { LazyView } from "./lazy.js";
import { fetchCustomers } from "./queries.js";

const PAGE_SIZE = 200;
const TABS = ["keys", "customers", "audit"];

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function modelSummary(models, t) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return t("access.models.none");
  if (list.length === 1 && list[0] === "*") return t("access.models.all");
  return list.length > 2 ? `${list.slice(0, 2).join(", ")} +${list.length - 2}` : list.join(", ");
}

function AttentionStrip({ counts, active, onPick }) {
  const { t } = useT();
  const total = counts.expired + counts.expiring + counts.unused;
  if (!total) return html`<p class="muted small" data-testid="keys.attention-none">${t("access.attention.none")}</p>`;
  return html`<div class="row" role="group" aria-label=${t("access.attention.label")} data-testid="keys.attention">
    ${["expired", "expiring", "unused"].map((kind) => (counts[kind] ? html`<button key=${kind} type="button" class=${`chip ${kind === "unused" ? "chip-neutral" : "chip-warn"}`}
      aria-pressed=${active === kind} onClick=${() => onPick(active === kind ? null : kind)} data-testid=${`keys.attention.${kind}`}>
      ${t(tk("access.attention.", kind))} <span class="chip-value">${counts[kind]}</span></button>` : null))}
  </div>`;
}

function Filters({ filters, set, customerName }) {
  const { t } = useT();
  return html`<div class="row" role="search" data-testid="keys.filters">
    <input class="input keys-search" type="search" value=${filters.q} placeholder=${t("access.filter.search")} aria-label=${t("access.filter.search")} onInput=${(event) => set({ q: event.currentTarget.value })} data-testid="keys.search" />
    <select class="select keys-filter" value=${filters.status} aria-label=${t("access.filter.status")} onChange=${(event) => set({ status: event.currentTarget.value })} data-testid="keys.filter-status">
      <option value="">${t("access.filter.anyStatus")}</option>
      ${KEY_STATUSES.map((item) => html`<option key=${item} value=${item}>${t(tk("access.status.", item))}</option>`)}
    </select>
    <select class="select keys-filter" value=${filters.class} aria-label=${t("access.filter.class")} onChange=${(event) => set({ class: event.currentTarget.value })} data-testid="keys.filter-class">
      <option value="">${t("access.filter.anyClass")}</option>
      ${KEY_CLASSES.map((item) => html`<option key=${item} value=${item}>${t(tk("access.class.", item))}</option>`)}
    </select>
    <label class="check"><input type="checkbox" checked=${filters.expiring} onChange=${(event) => set({ expiring: event.currentTarget.checked })} data-testid="keys.filter-expiring" />${t("access.filter.expiring")}</label>
    ${filters.customer ? html`<${Button} size="sm" onClick=${() => set({ customer: "" })} testid="keys.filter-customer">${t("access.filter.customer", { name: customerName || filters.customer })} ×<//>` : null}
  </div>`;
}

function KeysPage({ query = {} }) {
  const { api } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const router = useRouter();
  const telemetry = useFeature("telemetry");
  const [tab, setTab] = useState(() => (TABS.includes(query.tab) ? query.tab : "keys"));
  const [filters, setFilters] = useState({ q: "", status: "", class: "", customer: String(query.customer || ""), expiring: false });
  const [attention, setAttention] = useState(null);
  const [selected, setSelected] = useState([]);
  const [drawer, setDrawer] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [rotating, setRotating] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [share, setShare] = useState(null);
  const [extra, setExtra] = useState({ items: [], cursor: null, loading: false });

  const debouncedQ = useDebounced(filters.q, 250);
  const queryParams = keyListQuery({ ...filters, q: debouncedQ }, { limit: PAGE_SIZE });
  const first = useQuery(["access", "keys", queryParams], () => api.get("/api/access/keys", { query: queryParams }), { ttlMs: 5000, keepPrevious: true });
  const customers = useQuery(["billing", "customers"], () => fetchCustomers(api), { ttlMs: 30_000 });
  const today = useQuery(["telemetry", "breakdown", "key", "today"], () => api.get("/api/telemetry/breakdown", { query: { dim: "key", from: startOfToday(), limit: 200 } }), { ttlMs: 30_000, enabled: telemetry });
  const tokens = useMemo(() => tokensByKey(today.data), [today.data]);
  const customerNames = useMemo(() => new Map((customers.data?.rows || []).map((row) => [row.id, row.name])), [customers.data]);

  useEffect(() => {
    setExtra({ items: [], cursor: null, loading: false });
    setSelected([]);
  }, [first.updatedAt]);

  const rows = useMemo(() => [...(first.data?.items || []), ...extra.items], [first.data, extra.items]);
  const now = Date.now();
  const counts = useMemo(() => attentionCounts(rows, now), [rows]);
  const shown = attention ? rows.filter((row) => keyAttention(row, now) === attention) : rows;
  const cursor = extra.items.length || extra.cursor ? extra.cursor : first.data?.nextCursor || null;
  const set = (patch) => setFilters((current) => ({ ...current, ...patch }));

  async function loadMore(after) {
    setExtra((current) => ({ ...current, loading: true }));
    try {
      const page = await api.get("/api/access/keys", { query: { ...queryParams, cursor: after } });
      setExtra((current) => ({ items: [...current.items, ...(page.items || [])], cursor: page.nextCursor || null, loading: false }));
    } catch {
      setExtra((current) => ({ ...current, loading: false }));
    }
  }

  const selectedKeys = revocable(rows.filter((row) => selected.includes(row.id)));
  const allSelected = shown.length > 0 && revocable(shown).every((row) => selected.includes(row.id));
  const toggleAll = (on) => setSelected(on ? revocable(shown).map((row) => row.id) : []);
  const toggleOne = (id, on) => setSelected((current) => (on ? [...new Set([...current, id])] : current.filter((item) => item !== id)));

  const columns = [
    {
      id: "select",
      header: t("access.table.select"),
      cell: (row) => (row.status === "revoked" ? null : html`<input type="checkbox" checked=${selected.includes(row.id)} onChange=${(event) => toggleOne(row.id, event.currentTarget.checked)} aria-label=${t("access.table.selectRow", { name: row.name })} data-testid="keys.select" />`),
      csv: false,
    },
    {
      id: "name",
      header: t("access.table.name"),
      sort: (row) => row.name,
      cell: (row) => html`<div class="keys-name"><a href=${router.href("access.key", { keyId: row.id })} data-testid="keys.link" data-user-content>${row.name}</a><div class="xsmall muted mono" data-user-content>${row.preview || ""}</div></div>`,
      csv: (row) => row.name,
    },
    {
      id: "holder",
      header: t("access.table.holder"),
      hideable: true,
      sort: (row) => row.holder || customerNames.get(row.customerId) || "",
      cell: (row) => html`<span data-user-content>${row.holder || customerNames.get(row.customerId) || "—"}</span>`,
      csv: (row) => row.holder || customerNames.get(row.customerId) || "",
    },
    { id: "class", header: t("access.table.class"), sort: (row) => row.class, cell: (row) => html`<span class="chip chip-neutral">${t(tk("access.class.", row.class))}</span>`, csv: (row) => row.class },
    {
      id: "status",
      header: t("access.table.status"),
      sort: (row) => displayStatus(row, now),
      cell: (row) => {
        const status = displayStatus(row, now);
        return html`<${StatusBadge} status=${STATUS_TONE[status] || "neutral"} label=${t(tk("access.status.", status))} />`;
      },
      csv: (row) => displayStatus(row, now),
    },
    {
      id: "models",
      header: t("access.table.models"),
      hideable: true,
      defaultHidden: true,
      cell: (row) => html`<span class="mono small" data-user-content>${modelSummary(row.models, t)}</span>`,
      csv: (row) => (row.models || []).join(" "),
    },
    {
      id: "limits",
      header: t("access.table.limits"),
      hideable: true,
      cell: (row) => html`<span class="tabular nowrap">${row.limits?.rpm ?? "—"} / ${row.limits?.tpm === null || row.limits?.tpm === undefined ? "—" : fmt.integer(row.limits.tpm)}</span>`,
      csv: (row) => `${row.limits?.rpm ?? ""} / ${row.limits?.tpm ?? ""}`,
    },
    {
      id: "today",
      header: t("access.table.today"),
      align: "end",
      sort: (row) => tokens.get(row.id) ?? -1,
      cell: (row) => html`<span class="tabular" data-testid="keys.today">${telemetry && today.data ? fmt.integer(tokens.get(row.id) ?? 0) : "—"}</span>`,
      csv: (row) => tokens.get(row.id) ?? "",
    },
    {
      id: "lastUsed",
      header: t("access.table.lastUsed"),
      sort: (row) => (row.lastUsedAt ? Date.parse(row.lastUsedAt) : null),
      cell: (row) => (row.lastUsedAt ? html`<span class="nowrap" title=${fmt.dateTime(row.lastUsedAt)}>${fmt.relative(row.lastUsedAt)}${row.lastUsedCountry ? ` · ${row.lastUsedCountry}` : ""}</span>` : html`<span class="muted">${t("access.table.neverUsed")}</span>`),
      csv: (row) => row.lastUsedAt || "",
    },
    {
      id: "expires",
      header: t("access.table.expires"),
      sort: (row) => (row.expiresAt ? Date.parse(row.expiresAt) : null),
      cell: (row) => (row.expiresAt ? html`<span title=${fmt.dateTime(row.expiresAt)} class=${displayStatus(row, now) === "expired" ? "nowrap text-danger" : "nowrap"}>${fmt.dateTime(row.expiresAt, { style: "date" })}</span>` : html`<span class="muted">${t("access.expiry.never")}</span>`),
      csv: (row) => row.expiresAt || "",
    },
    {
      id: "actions",
      header: t("access.table.actions"),
      csv: false,
      cell: (row) => (row.status === "revoked" ? null : html`<div class="row-nowrap">
        <${Button} size="sm" onClick=${() => setRotating(row)} testid="keys.rotate" label=${t("access.table.rotateFor", { name: row.name })}>${t("access.table.rotate")}<//>
        <${Button} size="sm" variant="danger" onClick=${() => setRevoking(row)} testid="keys.revoke" label=${t("access.table.revokeFor", { name: row.name })}>${t("access.table.revoke")}<//>
      </div>`),
    },
  ];

  const keysPanel = html`<div class="stack" data-testid="keys.panel">
    <${AttentionStrip} counts=${counts} active=${attention} onPick=${setAttention} />
    ${shown.length ? html`<label class="check"><input type="checkbox" checked=${allSelected} onChange=${(event) => toggleAll(event.currentTarget.checked)} data-testid="keys.select-all" />${t("access.table.selectAll")}</label>` : null}
    ${selectedKeys.length ? html`<div class="notice" role="region" aria-label=${t("access.bulk.bar")} data-testid="keys.bulk-bar">
      <span class="grow">${t("access.bulk.selected", { count: selectedKeys.length })}</span>
      <${Button} size="sm" onClick=${() => setSelected([])} testid="keys.bulk-clear">${t("access.bulk.clear")}<//>
      <${Button} size="sm" variant="danger" onClick=${() => setBulk(selectedKeys)} testid="keys.bulk-revoke">${t("access.bulk.start", { count: selectedKeys.length })}<//>
    </div>` : null}
    ${first.status === "error" && !first.data ? html`<${EmptyState} icon="triangle-alert" title=${t("access.keys.failed")} body=${first.error?.message || ""} action=${{ label: t("access.retry"), onClick: first.refetch }} />` : html`<${DataTable}
      id="access-keys" columns=${columns} rows=${shown} rowKey=${(row) => row.id} loading=${first.status === "loading" && !first.data}
      source=${{ cursor, loading: extra.loading, loadMore }} responsive="cards" exportName="keys" caption=${t("access.keys.caption")}
      filters=${html`<${Filters} filters=${filters} set=${set} customerName=${customerNames.get(filters.customer)} />`}
      empty=${html`<${EmptyState} icon="key-round" title=${t("access.keys.empty")} body=${t("access.keys.emptyBody")} action=${{ label: t("access.create.open"), onClick: () => setDrawer({ mode: "create" }) }} />`} />`}
  </div>`;

  const lazyExtra = (name) => html`<${LazyView} load=${() => import("./keys-extra.js")} name=${name}
    onCreateFor=${(customerId) => setDrawer({ mode: "create", initial: { preset: "paid", customerId } })}
    onShowKeys=${(customerId) => {
      set({ customer: customerId });
      setTab("keys");
    }} />`;
  const tabs = [
    { id: "keys", label: t("access.tab.keys"), badge: first.data?.counts?.total },
    { id: "customers", label: t("access.tab.customers") },
    { id: "audit", label: t("access.tab.audit") },
  ];

  return html`<div class="stack" data-testid="keys.root">
    <${PageHeader} title=${t("access.keys.title")} subtitle=${t("access.keys.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("access.keys.title") }]}
      actions=${html`<${Button} variant="primary" icon="key-round" onClick=${() => setDrawer({ mode: "create" })} testid="keys.create">${t("access.create.open")}<//>`} />
    <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} label=${t("access.keys.title")}
      renderPanel=${(id) => (id === "customers" ? lazyExtra("CustomersTab") : id === "audit" ? lazyExtra("AuditTab") : keysPanel)} />

    ${drawer ? html`<${LazyView} load=${() => import("./key-drawer.js")} name="KeyDrawer" mode=${drawer.mode} initial=${drawer.initial} onClose=${() => setDrawer(null)}
      onSaved=${(result) => {
        setDrawer(null);
        if (result.kind === "create") setShare(result);
      }} />` : null}
    ${revoking ? html`<${RevokeDialog} keyRecord=${revoking} onClose=${() => setRevoking(null)} />` : null}
    ${rotating ? html`<${RotateDialog} keyRecord=${rotating} onClose=${() => setRotating(null)} onRotated=${(result) => setShare(result)} />` : null}
    ${bulk ? html`<${BulkRevokeDialog} keys=${bulk} onClose=${() => setBulk(null)} onDone=${() => setSelected([])} />` : null}
    ${share ? html`<${LazyView} load=${() => import("../../components/share-card.js")} name="ShareCard" data=${share} onClose=${() => setShare(null)} />` : null}
  </div>`;
}

export default function KeysRoute(props) {
  const modern = useFeature("access");
  return modern ? html`<${KeysPage} ...${props} />` : html`<${LazyView} load=${() => import("./keys-legacy.js")} ...${props} />`;
}
