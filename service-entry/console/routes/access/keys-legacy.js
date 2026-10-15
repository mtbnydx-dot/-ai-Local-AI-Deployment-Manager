// The degrade path of /access/keys (07 §6.10, "before 05"): the per-engine
// keys that live in each manager. It reads `GET /api/keys` and acts through
// the management proxy `/api/m/:managerId/service-clients[/:id[/rotate]]`.
// The banner says what this is; a new or rotated key is shown once in the same
// ShareCard, without the portal link (the platform key store makes that).

import { buildBaseUrls, isLoopbackHost, legacyClients, legacyManagers, legacyShare } from "../../lib/access-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { Dialog } from "../../components/dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { describeError } from "../../lib/api.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";
import { useId, useState } from "../../ui/vendor.js";
import { LazyView } from "./lazy.js";

const STATE_TONE = { active: "ok", expired: "warn", disabled: "neutral" };

function serviceClientsPath(manager, id, tail = "") {
  return `/api/m/${encodeURIComponent(manager)}/service-clients${id ? `/${encodeURIComponent(id)}` : ""}${tail}`;
}

function CreateDialog({ managers, onClose, onCreated }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const id = useId();
  const [manager, setManager] = useState(managers[0]?.id || "");
  const [name, setName] = useState("");
  const [rpm, setRpm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const valid = name.trim() && manager;
  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const limit = Number(rpm);
      const body = { name: name.trim(), ...(rpm.trim() && Number.isInteger(limit) && limit > 0 ? { rateLimitRpm: limit } : {}) };
      const result = await api.post(serviceClientsPath(manager), body);
      onCreated({ key: { name: result.client?.name || name.trim(), limits: { rpm: body.rateLimitRpm ?? null }, expiresAt: null }, secret: result.apiKey });
    } catch (failure) {
      setBusy(false);
      setError(describeError(failure, i18n));
    }
  }
  const footer = html`
    <${Button} onClick=${onClose} disabled=${busy} testid="legacy.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} disabled=${!valid} onClick=${submit} testid="legacy.submit">${t("access.create.submit")}<//>`;
  return html`<${Dialog} open title=${t("access.legacy.createTitle")} onClose=${onClose} dismissible=${!busy} footer=${footer} testid="legacy.create">
    <div class="stack">
      <div class="field"><label class="field-label" for=${`${id}-m`}>${t("access.legacy.engine")}</label>
        <select id=${`${id}-m`} class="select" value=${manager} onChange=${(event) => setManager(event.currentTarget.value)} data-testid="legacy.manager">
          ${managers.map((item) => html`<option key=${item.id} value=${item.id}>${item.name}</option>`)}
        </select></div>
      <div class="field"><label class="field-label" for=${`${id}-n`}>${t("access.field.name.label")}</label>
        <input id=${`${id}-n`} class="input" value=${name} autocomplete="off" onInput=${(event) => setName(event.currentTarget.value)} data-autofocus data-testid="legacy.name" /></div>
      <div class="field"><label class="field-label" for=${`${id}-r`}>${t("access.field.rpm.label")}</label>
        <input id=${`${id}-r`} class="input" inputmode="numeric" value=${rpm} placeholder=${t("access.limit.inherit")} onInput=${(event) => setRpm(event.currentTarget.value)} data-testid="legacy.rpm" />
        <div class="field-hint">${t("access.field.rpm.help")}</div></div>
      ${error ? html`<p class="field-error" role="alert">${error}</p>` : null}
    </div>
  <//>`;
}

export default function KeysLegacy() {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const bootstrap = useBootstrap();
  const legacy = useQuery(["legacy", "keys"], () => api.get("/api/keys"), { ttlMs: 5000 });
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [share, setShare] = useState(null);
  const rows = legacyClients(legacy.data);
  const managers = legacyManagers(legacy.data);
  const location = globalThis.location;
  const where = { protocol: location?.protocol, hostname: location?.hostname, port: location?.port };
  const urls = buildBaseUrls({ where, gateway: bootstrap.gateway, publicBase: "" }).find((item) => item.id === (isLoopbackHost(where.hostname) ? "local" : "lan"));

  const refresh = () => cache.invalidate(["legacy"]);
  const showSecret = (result, kind) => setShare({ kind, key: result.key, secret: result.secret, share: legacyShare(urls, result.secret) });

  const columns = [
    { id: "name", header: t("access.table.name"), sort: (row) => row.name, cell: (row) => html`<span data-user-content>${row.name}</span>`, csv: (row) => row.name },
    { id: "engine", header: t("access.legacy.engine"), sort: (row) => row.managerName, cell: (row) => html`<span data-user-content>${row.managerName}</span>`, csv: (row) => row.managerName },
    { id: "state", header: t("access.table.status"), sort: (row) => row.state, cell: (row) => html`<${StatusBadge} status=${STATE_TONE[row.state] || "neutral"} label=${t(tk("access.status.", row.state))} />`, csv: (row) => row.state },
    { id: "models", header: t("access.table.models"), hideable: true, cell: (row) => html`<span class="mono small" data-user-content>${row.allowedModels.length ? row.allowedModels.join(", ") : t("access.models.all")}</span>`, csv: (row) => row.allowedModels.join(" ") },
    { id: "rpm", header: t("access.field.rpm.label"), align: "end", hideable: true, sort: (row) => row.rateLimitRpm, cell: (row) => row.rateLimitRpm ?? "—", csv: (row) => row.rateLimitRpm ?? "" },
    { id: "lastUsed", header: t("access.table.lastUsed"), sort: (row) => (row.lastUsedAt ? Date.parse(row.lastUsedAt) : null), cell: (row) => (row.lastUsedAt ? fmt.relative(row.lastUsedAt) : html`<span class="muted">${t("access.table.neverUsed")}</span>`), csv: (row) => row.lastUsedAt || "" },
    { id: "expires", header: t("access.table.expires"), sort: (row) => (row.expiresAt ? Date.parse(row.expiresAt) : null), cell: (row) => (row.expiresAt ? fmt.dateTime(row.expiresAt, { style: "date" }) : html`<span class="muted">${t("access.expiry.never")}</span>`), csv: (row) => row.expiresAt || "" },
    {
      id: "actions",
      header: t("access.table.actions"),
      csv: false,
      cell: (row) => html`<div class="row-nowrap">
        <${Button} size="sm" onClick=${() => setRotating(row)} testid="legacy.rotate" label=${t("access.table.rotateFor", { name: row.name })}>${t("access.table.rotate")}<//>
        <${Button} size="sm" variant="danger" onClick=${() => setRemoving(row)} testid="legacy.revoke" label=${t("access.table.revokeFor", { name: row.name })}>${t("access.table.revoke")}<//>
      </div>`,
    },
  ];

  return html`<div class="stack" data-testid="keys-legacy.root">
    <${PageHeader} title=${t("access.keys.title")} subtitle=${t("access.keys.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("access.keys.title") }]}
      actions=${html`<${Button} variant="primary" icon="key-round" disabled=${!managers.length} onClick=${() => setCreating(true)} testid="legacy.create-open">${t("access.create.open")}<//>`} />
    <section class="notice notice-warn" role="note" data-testid="keys-legacy.banner"><div class="stack-sm"><strong>${t("access.legacy.banner")}</strong><span>${t("access.legacy.body")}</span></div></section>
    ${legacy.status === "error" && !legacy.data
      ? html`<${EmptyState} icon="triangle-alert" title=${t("access.keys.failed")} body=${legacy.error?.message || ""} action=${{ label: t("access.retry"), onClick: legacy.refetch }} />`
      : html`<${DataTable} id="access-keys-legacy" columns=${columns} rows=${rows} rowKey=${(row) => `${row.manager}:${row.id}`} loading=${legacy.status === "loading" && !legacy.data} responsive="cards" exportName="legacy-keys" caption=${t("access.legacy.caption")}
        empty=${html`<${EmptyState} icon="key-round" title=${t("access.keys.empty")} body=${t("access.legacy.emptyBody")} action=${{ label: t("access.create.open"), onClick: () => setCreating(true) }} />`} />`}

    ${creating ? html`<${CreateDialog} managers=${managers} onClose=${() => setCreating(false)} onCreated=${(result) => {
      setCreating(false);
      refresh();
      showSecret(result, "create");
    }} />` : null}
    ${rotating ? html`<${ConfirmDialog} open title=${t("access.rotate.title", { name: rotating.name })} body=${t("access.legacy.rotateBody")} confirmLabel=${t("access.rotate.confirm")} typeToConfirm=${rotating.name} testid="legacy.rotate-dialog"
      onConfirm=${async () => {
        const result = await api.post(serviceClientsPath(rotating.manager, rotating.id, "/rotate"), {});
        refresh();
        showSecret({ key: { name: rotating.name, limits: { rpm: rotating.rateLimitRpm }, expiresAt: rotating.expiresAt }, secret: result.apiKey }, "rotate");
      }} onClose=${() => setRotating(null)} />` : null}
    ${removing ? html`<${ConfirmDialog} open tone="danger" title=${t("access.revoke.title", { name: removing.name })} body=${t("access.legacy.removeBody")} confirmLabel=${t("access.revoke.confirm")} typeToConfirm=${removing.name} testid="legacy.remove-dialog"
      onConfirm=${async () => {
        await api.del(serviceClientsPath(removing.manager, removing.id));
        refresh();
        toasts?.push?.({ level: "success", title: i18n.t("access.revoke.done", { name: removing.name }) });
      }} onClose=${() => setRemoving(null)} />` : null}
    ${share ? html`<${LazyView} load=${() => import("../../components/share-card.js")} name="ShareCard" data=${share} onClose=${() => setShare(null)} />` : null}
  </div>`;
}
