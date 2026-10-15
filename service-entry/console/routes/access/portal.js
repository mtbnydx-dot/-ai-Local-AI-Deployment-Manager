// /access/portal (07 §6.10, 05 §12.7, §13.1): what the public portal says.
// Announcements (a banner on the portal's pages, shown between two dates) and
// the public description of each model (display name, text, aliases, hidden,
// recommended, order). Owner only. The forms load on first use (portal-forms.js);
// deleting an announcement asks first.

import { modelNames } from "../../lib/access-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useId, useState } from "../../ui/vendor.js";
import { accessError, shown } from "./errors.js";
import { LazyView } from "./lazy.js";

const SEVERITY_BADGE = Object.freeze({ info: "info", maintenance: "warn", incident: "error" });

function Announcements({ onEdit, onNew, onDelete }) {
  const { api } = useServices();
  const { t, locale } = useT();
  const fmt = useFormat();
  const list = useQuery(["access", "portal", "announcements"], () => api.get("/api/public/announcements"), { ttlMs: 10_000 });
  const rows = Array.isArray(list.data?.items) ? list.data.items : [];
  const lang = locale === "zh-CN" ? "zh" : "en";
  const columns = [
    { id: "severity", header: t("access.portal.severity"), cell: (row) => html`<${StatusBadge} status=${SEVERITY_BADGE[row.severity] || "neutral"} label=${t(tk("access.portal.severity.", row.severity))} />`, csv: (row) => row.severity },
    { id: "title", header: t("access.portal.colTitle"), sort: (row) => row.title?.[lang] || "", cell: (row) => html`<span data-user-content>${row.title?.[lang] || row.title?.en || row.title?.zh || ""}</span>`, csv: (row) => row.title?.[lang] || "" },
    { id: "audience", header: t("access.portal.audience"), hideable: true, cell: (row) => t(tk("access.portal.audience.", row.audience)), csv: (row) => row.audience },
    { id: "window", header: t("access.portal.window"), cell: (row) => html`<span class="small">${fmt.dateTime(row.startsAt, { style: "short" })} - ${row.endsAt ? fmt.dateTime(row.endsAt, { style: "short" }) : t("access.portal.noEnd")}</span>`, csv: (row) => `${row.startsAt} ${row.endsAt || ""}` },
    { id: "published", header: t("access.portal.state"), cell: (row) => html`<${StatusBadge} status=${row.published ? "ok" : "neutral"} label=${row.published ? t("access.portal.published") : t("access.portal.draft")} />`, csv: (row) => (row.published ? "published" : "draft") },
    {
      id: "actions",
      header: t("access.portal.actions"),
      csv: false,
      cell: (row) => html`<div class="row-nowrap">
        <${Button} size="sm" onClick=${() => onEdit(row)} label=${t("access.portal.announcements.editLabel", { title: row.title?.[lang] || row.id })} testid="portal.announcement.edit">${t("access.portal.edit")}<//>
        <${Button} size="sm" variant="danger" onClick=${() => onDelete(row)} label=${t("access.portal.announcements.deleteLabel", { title: row.title?.[lang] || row.id })} testid="portal.announcement.delete">${t("access.portal.delete")}<//>
      </div>`,
    },
  ];
  return html`<${Card} title=${t("access.portal.announcements.title")} testid="portal.announcements" actions=${html`<${Button} variant="primary" size="sm" onClick=${onNew} testid="portal.announcement.new">${t("access.portal.announcements.new")}<//>`}>
    <p class="muted small">${t("access.portal.announcements.hint")}</p>
    ${list.status === "error" && !list.data ? html`<${EmptyState} icon="triangle-alert" title=${t("access.portal.announcements.failed")} body=${list.error?.message || ""} action=${{ label: t("access.retry"), onClick: list.refetch }} />`
      : html`<${DataTable} id="access-announcements" columns=${columns} rows=${rows} rowKey=${(row) => row.id} loading=${list.status === "loading" && !list.data} responsive="cards"
        caption=${t("access.portal.announcements.title")} empty=${html`<p class="muted" data-testid="portal.announcements.empty">${t("access.portal.announcements.empty")}</p>`} />`}
  <//>`;
}

function Models({ onEdit }) {
  const { api } = useServices();
  const { t } = useT();
  const id = useId();
  const [typed, setTyped] = useState("");
  const fleet = useQuery(["fleet"], () => api.get("/api/fleet"), { ttlMs: 10_000 });
  const names = modelNames(fleet.data);
  return html`<${Card} title=${t("access.portal.models.title")} testid="portal.models">
    <p class="muted small">${t("access.portal.models.hint")}</p>
    ${names.length ? html`<ul class="stack-sm" aria-label=${t("access.portal.models.title")}>${names.map((name) => html`<li key=${name} class="row" data-testid="portal.model">
      <code class="code-inline grow" data-user-content>${name}</code>
      <${Button} size="sm" onClick=${() => onEdit(name)} label=${t("access.portal.models.editLabel", { model: name })} testid="portal.model.edit">${t("access.portal.edit")}<//>
    </li>`)}</ul>` : html`<p class="muted" data-testid="portal.models.empty">${t("access.portal.models.empty")}</p>`}
    <form class="row" onSubmit=${(event) => {
      event.preventDefault();
      if (typed.trim()) onEdit(typed.trim());
    }}>
      <label class="field-label" for=${`${id}-id`}>${t("access.portal.models.other")}</label>
      <input id=${`${id}-id`} class="input mono keys-search" value=${typed} autocomplete="off" spellcheck="false" onInput=${(event) => setTyped(event.currentTarget.value)} data-testid="portal.models.other" />
      <${Button} type="submit" disabled=${!typed.trim()} testid="portal.models.other-edit">${t("access.portal.edit")}<//>
    </form>
  <//>`;
}

export default function Portal() {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = useT();
  const [form, setForm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const lang = i18n.locale === "zh-CN" ? "zh" : "en";

  return html`<div class="stack" data-testid="portal.root">
    <${PageHeader} title=${t("access.portal.title")} subtitle=${t("access.portal.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("access.portal.title") }]} />
    <${Announcements} onNew=${() => setForm({ kind: "announcement", item: null })} onEdit=${(item) => setForm({ kind: "announcement", item })} onDelete=${setDeleting} />
    <${Models} onEdit=${(modelId) => setForm({ kind: "meta", modelId })} />
    ${form?.kind === "announcement" ? html`<${LazyView} load=${() => import("./portal-forms.js")} name="AnnouncementDrawer" item=${form.item} onClose=${() => setForm(null)} />` : null}
    ${form?.kind === "meta" ? html`<${LazyView} load=${() => import("./portal-forms.js")} name="ModelMetaDrawer" modelId=${form.modelId} onClose=${() => setForm(null)} />` : null}
    ${deleting ? html`<${ConfirmDialog} open tone="danger" title=${t("access.portal.announcements.deleteTitle")} body=${t("access.portal.announcements.deleteBody")}
      details=${[deleting.title?.[lang] || deleting.title?.en || deleting.id]} confirmLabel=${t("access.portal.delete")} testid="portal.announcement.delete-dialog"
      onConfirm=${async () => {
        try {
          await api.del(`/api/public/announcements/${encodeURIComponent(deleting.id)}`);
        } catch (error) {
          throw shown(accessError(error, i18n));
        }
        cache.invalidate(["access", "portal"]);
        toasts?.push?.({ level: "success", title: t("access.portal.announcements.deleted") });
      }} onClose=${() => setDeleting(null)} />` : null}
  </div>`;
}
