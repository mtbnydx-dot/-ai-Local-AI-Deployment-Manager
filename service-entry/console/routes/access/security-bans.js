// Bans on the Security page (05 §13.3, §13.6): the active bans, the ban dialog
// and the unban dialog. Every ban and unban goes through a ConfirmDialog, and
// the server audits it (`ban.upsert`, `ban.remove`). The dialog is the ban
// form too, so adding a ban by hand and banning an address from the top-IP
// table are the same, confirmed, action.

import { BAN_DURATIONS, BAN_KINDS, banBody, banSubjectProblem } from "../../lib/exposure-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useId, useState } from "../../ui/vendor.js";
import { accessError, shown } from "./errors.js";

function useDone() {
  const { cache, toasts, i18n } = useServices();
  return (messageKey, vars) => {
    cache.invalidate(["access", "security"]);
    toasts?.push?.({ level: "success", title: i18n.t(messageKey, vars) });
  };
}

/** @param initial { subject?, kind? } to start from  @param onClose(reason) */
export function BanDialog({ initial, onClose }) {
  const { t } = useT();
  const { api, i18n } = useServices();
  const done = useDone();
  const id = useId();
  const [form, setForm] = useState({ subject: initial?.subject || "", kind: initial?.kind || "ip", reason: "", duration: "24h" });
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const body = html`<div class="stack-sm" data-testid="security.ban-form">
    <p>${t("security.ban.body")}</p>
    <div class="field">
      <label class="field-label" for=${`${id}-subject`}>${t("security.ban.subject")}</label>
      <input id=${`${id}-subject`} class="input mono" value=${form.subject} autocomplete="off" spellcheck="false" data-autofocus onInput=${(event) => set({ subject: event.currentTarget.value })} data-testid="security.ban.subject" />
    </div>
    <div class="row">
      <div class="field">
        <label class="field-label" for=${`${id}-kind`}>${t("security.ban.kind")}</label>
        <select id=${`${id}-kind`} class="select" value=${form.kind} onChange=${(event) => set({ kind: event.currentTarget.value })} data-testid="security.ban.kind">
          ${BAN_KINDS.map((kind) => html`<option key=${kind} value=${kind}>${t(tk("security.ban.kind.", kind))}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for=${`${id}-duration`}>${t("security.ban.duration")}</label>
        <select id=${`${id}-duration`} class="select" value=${form.duration} onChange=${(event) => set({ duration: event.currentTarget.value })} data-testid="security.ban.duration">
          ${BAN_DURATIONS.map((item) => html`<option key=${item.id} value=${item.id}>${t(tk("security.ban.duration.", item.id))}</option>`)}
        </select>
      </div>
    </div>
    <div class="field">
      <label class="field-label" for=${`${id}-reason`}>${t("security.ban.reason")}</label>
      <input id=${`${id}-reason`} class="input" value=${form.reason} maxlength="200" autocomplete="off" onInput=${(event) => set({ reason: event.currentTarget.value })} data-testid="security.ban.reason" />
    </div>
  </div>`;
  return html`<${ConfirmDialog} open tone="danger" title=${t("security.ban.title")} body=${body} confirmLabel=${t("security.ban.confirm")} testid="security.ban-dialog"
    onConfirm=${async () => {
      const problem = banSubjectProblem(form.subject, form.kind);
      if (problem) throw shown(t(tk("security.ban.err.", problem)));
      try {
        await api.post("/api/security/bans", banBody(form));
      } catch (error) {
        throw shown(accessError(error, i18n));
      }
      done("security.ban.done", { subject: form.subject.trim() });
    }} onClose=${onClose} />`;
}

/** @param ban a ban row  @param onClose(reason) */
export function UnbanDialog({ ban, onClose }) {
  const { t } = useT();
  const { api, i18n } = useServices();
  const done = useDone();
  return html`<${ConfirmDialog} open title=${t("security.unban.title", { subject: ban.subject })} body=${t("security.unban.body")} confirmLabel=${t("security.unban.confirm")} testid="security.unban-dialog"
    onConfirm=${async () => {
      try {
        await api.del(`/api/security/bans/${encodeURIComponent(ban.subject)}`);
      } catch (error) {
        throw shown(accessError(error, i18n));
      }
      done("security.unban.done", { subject: ban.subject });
    }} onClose=${onClose} />`;
}

/** @param query the useQuery result of GET /api/security/bans */
export function BansCard({ query, onAdd, onUnban }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const rows = (Array.isArray(query.data?.items) ? query.data.items : []).filter((ban) => ban.active !== false);
  const columns = [
    { id: "subject", header: t("security.bans.subject"), sort: (row) => row.subject, cell: (row) => html`<span class="mono" data-user-content>${row.subject}</span>`, csv: (row) => row.subject },
    { id: "kind", header: t("security.bans.kind"), cell: (row) => (has(tk("security.ban.kind.", row.kind)) ? t(tk("security.ban.kind.", row.kind)) : row.kind), csv: (row) => row.kind },
    { id: "reason", header: t("security.bans.reason"), hideable: true, cell: (row) => html`<span data-user-content>${row.reason || "-"}</span>`, csv: (row) => row.reason || "" },
    { id: "source", header: t("security.bans.source"), hideable: true, cell: (row) => (has(tk("security.bans.source.", row.source)) ? t(tk("security.bans.source.", row.source)) : row.source), csv: (row) => row.source || "" },
    { id: "created", header: t("security.bans.created"), sort: (row) => Date.parse(row.createdAt), cell: (row) => fmt.dateTime(row.createdAt, { style: "short" }), csv: (row) => row.createdAt },
    { id: "expires", header: t("security.bans.expires"), sort: (row) => (row.expiresAt ? Date.parse(row.expiresAt) : Infinity), cell: (row) => (row.expiresAt ? fmt.dateTime(row.expiresAt, { style: "short" }) : t("security.bans.never")), csv: (row) => row.expiresAt || "" },
    { id: "actions", header: t("security.bans.actions"), csv: false, cell: (row) => html`<${Button} size="sm" onClick=${() => onUnban(row)} label=${t("security.unban.label", { subject: row.subject })} testid="security.bans.unban">${t("security.unban.open")}<//>` },
  ];
  return html`<${Card} title=${t("security.bans.title")} testid="security.bans" actions=${html`<${Button} size="sm" onClick=${onAdd} testid="security.bans.add">${t("security.bans.add")}<//>`}>
    <p class="muted small">${t("security.bans.hint")}</p>
    ${query.status === "error" && !query.data ? html`<${EmptyState} icon="triangle-alert" title=${t("security.bans.failed")} body=${query.error?.message || ""} action=${{ label: t("access.retry"), onClick: query.refetch }} />`
      : html`<${DataTable} id="access-bans" columns=${columns} rows=${rows} rowKey=${(row) => row.subject} loading=${query.status === "loading" && !query.data} responsive="cards"
        caption=${t("security.bans.title")} empty=${html`<p class="muted" data-testid="security.bans.empty">${t("security.bans.empty")}</p>`} />`}
  <//>`;
}
