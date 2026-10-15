// /access/sessions (07 §6.15, 05 §5.2, §5.6): the browsers paired with this
// console. The owner sees when each was created and last used, from which
// address, revokes one (revoking the session this tab runs on warns first and
// leaves the tab to pair again), signs out, and pairs another device: a
// single-use code that lasts two minutes, shown with a QR of the pairing
// address and a countdown. The code lives only in the pair dialog's state and
// is gone when the dialog closes; it is never logged or cached.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { Dialog } from "../../components/dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { QrCode } from "../../components/qr-code.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import { accessError, shown } from "./errors.js";

const PAIR_TTL_SECONDS = 120;

/** A short "Chrome on Windows" from a user agent; the full text stays in the tooltip. */
export function describeAgent(agent) {
  const text = String(agent || "");
  if (!text) return "";
  const browser = /Edg\//.test(text) ? "Edge" : /OPR\//.test(text) ? "Opera" : /Firefox\//.test(text) ? "Firefox" : /Chrome\//.test(text) ? "Chrome" : /Safari\//.test(text) ? "Safari" : "";
  const system = /Windows/.test(text) ? "Windows" : /Android/.test(text) ? "Android" : /iPhone|iPad/.test(text) ? "iOS" : /Mac OS X/.test(text) ? "macOS" : /Linux/.test(text) ? "Linux" : "";
  if (!browser && !system) return text.length > 48 ? `${text.slice(0, 48)}...` : text;
  return [browser, system].filter(Boolean).join(" / ");
}

function PairDialog({ onClose }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const [lan, setLan] = useState(false);
  const [state, setState] = useState({ busy: true, issued: null, error: null });
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);

  async function issue(withLan) {
    setState({ busy: true, issued: null, error: null });
    try {
      const answer = await api.post("/api/session/pair-codes", { ttlSeconds: PAIR_TTL_SECONDS, ...(withLan ? { lan: true } : {}) });
      if (alive.current) setState({ busy: false, issued: { code: String(answer.code), url: String(answer.url), expiresAt: Date.parse(answer.expiresAt) }, error: null });
    } catch (error) {
      if (alive.current) setState({ busy: false, issued: null, error: accessError(error, i18n) });
    }
  }

  useEffect(() => {
    alive.current = true;
    issue(false);
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive.current = false;
      globalThis.clearInterval(timer);
    };
  }, []);

  const { issued } = state;
  const remaining = issued ? Math.max(0, Math.ceil((issued.expiresAt - now) / 1000)) : 0;
  const footer = html`
    <${Button} onClick=${() => issue(lan)} busy=${state.busy} testid="sessions.pair.renew">${t("sessions.pair.renew")}<//>
    <span class="spacer"></span>
    <${Button} variant="primary" onClick=${() => onClose?.()} testid="sessions.pair.close">${t("common.close")}<//>`;
  return html`<${Dialog} open title=${t("sessions.pair.title")} onClose=${onClose} footer=${footer} testid="sessions.pair-dialog">
    <div class="stack" data-testid="sessions.pair">
      <p>${t("sessions.pair.intro")}</p>
      <label class="check"><input type="checkbox" checked=${lan} disabled=${state.busy} onChange=${(event) => {
        setLan(event.currentTarget.checked);
        issue(event.currentTarget.checked);
      }} data-testid="sessions.pair.lan" />${t("sessions.pair.lan")}</label>
      ${state.error ? html`<p class="notice notice-danger" role="alert" data-testid="sessions.pair.error">${state.error}</p>` : null}
      ${state.busy ? html`<p class="muted" aria-busy="true">${t("sessions.pair.working")}</p>` : null}
      ${issued && remaining > 0 ? html`<div class="stack" data-testid="sessions.pair.issued">
        <div class="stack-sm"><span class="field-label">${t("sessions.pair.code")}</span><${CodeBlock} code=${issued.code} language="text" testid="sessions.pair.code" /></div>
        <div class="share-qr"><${QrCode} text=${issued.url} label=${t("sessions.pair.qr")} testid="sessions.pair.qr" /></div>
        <div class="stack-sm"><span class="field-label">${t("sessions.pair.url")}</span><${CodeBlock} code=${issued.url} language="text" wrap testid="sessions.pair.url" /></div>
        <p class="small" role="timer" data-testid="sessions.pair.countdown">${t("sessions.pair.expires", { seconds: remaining })}</p>
        <p class="small muted">${t("sessions.pair.hint")}</p>
      </div>` : issued ? html`<p class="notice notice-warn" role="status" data-testid="sessions.pair.expired">${t("sessions.pair.expired")}</p>` : null}
    </div>
  <//>`;
}

export default function Sessions() {
  const { api, cache, pairing, role, toasts, i18n } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const list = useQuery(["access", "sessions"], () => api.get("/api/session/list"), { ttlMs: 5000 });
  const [revoking, setRevoking] = useState(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [signOut, setSignOut] = useState(false);
  const rows = Array.isArray(list.data?.items) ? list.data.items : [];

  // The session this tab runs on is gone: the tab is a viewer again and the pairing screen takes over.
  const unpair = () => {
    role?.set?.("viewer");
    pairing?.set?.({ reason: "unpaired" });
  };

  const columns = [
    { id: "created", header: t("sessions.col.created"), sort: (row) => Date.parse(row.createdAt), cell: (row) => html`<span title=${row.createdAt}>${fmt.dateTime(row.createdAt, { style: "short" })}</span>`, csv: (row) => row.createdAt },
    { id: "seen", header: t("sessions.col.seen"), sort: (row) => Date.parse(row.lastSeenAt), cell: (row) => html`<span title=${row.lastSeenAt}>${row.lastSeenAt ? fmt.relative(row.lastSeenAt) : "-"}</span>`, csv: (row) => row.lastSeenAt || "" },
    { id: "ip", header: t("sessions.col.ip"), cell: (row) => html`<span class="mono small" data-user-content>${row.createdIp || "-"}</span>`, csv: (row) => row.createdIp || "" },
    { id: "agent", header: t("sessions.col.agent"), hideable: true, cell: (row) => html`<span title=${row.userAgent || ""} data-user-content>${describeAgent(row.userAgent) || "-"}</span>`, csv: (row) => row.userAgent || "" },
    { id: "state", header: t("sessions.col.state"), cell: (row) => (row.current ? html`<${StatusBadge} status="info" label=${t("sessions.current")} />` : null), csv: (row) => (row.current ? "current" : "") },
    { id: "actions", header: t("sessions.col.actions"), csv: false, cell: (row) => html`<${Button} size="sm" variant=${row.current ? "danger" : "default"} onClick=${() => setRevoking(row)} label=${t("sessions.revoke.label", { when: fmt.dateTime(row.createdAt, { style: "short" }) })} testid="sessions.revoke">${t("sessions.revoke.open")}<//>` },
  ];

  return html`<div class="stack" data-testid="sessions.root">
    <${PageHeader} title=${t("sessions.title")} subtitle=${t("sessions.subtitle")}
      breadcrumbs=${[{ label: t("shell.nav.access"), href: "/access" }, { label: t("sessions.title") }]}
      actions=${html`<${Button} variant="primary" onClick=${() => setPairOpen(true)} testid="sessions.pair-open">${t("sessions.pair.open")}<//>
        <${Button} onClick=${() => setSignOut(true)} testid="sessions.signout">${t("sessions.signout.open")}<//>`} />
    <${Card} title=${t("sessions.list")} testid="sessions.list">
      ${list.status === "error" && !list.data ? html`<${EmptyState} icon="triangle-alert" title=${t("sessions.failed")} body=${list.error?.message || ""} action=${{ label: t("access.retry"), onClick: list.refetch }} />`
        : html`<${DataTable} id="access-sessions" columns=${columns} rows=${rows} rowKey=${(row) => row.id} loading=${list.status === "loading" && !list.data} responsive="cards"
          caption=${t("sessions.list")} empty=${html`<p class="muted" data-testid="sessions.empty">${t("sessions.empty")}</p>`} />`}
    <//>
    ${revoking ? html`<${ConfirmDialog} open tone="danger" title=${t(revoking.current ? "sessions.revoke.currentTitle" : "sessions.revoke.title")}
      body=${t(revoking.current ? "sessions.revoke.currentBody" : "sessions.revoke.body")}
      details=${[`${fmt.dateTime(revoking.createdAt, { style: "short" })} · ${revoking.createdIp || "-"}`]}
      confirmLabel=${t(revoking.current ? "sessions.revoke.currentConfirm" : "sessions.revoke.confirm")} testid=${revoking.current ? "sessions.revoke-current" : "sessions.revoke-dialog"}
      onConfirm=${async () => {
        try {
          await api.del(`/api/session/${encodeURIComponent(revoking.id)}`);
        } catch (error) {
          throw shown(accessError(error, i18n));
        }
        cache.invalidate(["access", "sessions"]);
        toasts?.push?.({ level: "success", title: t("sessions.revoke.done") });
        if (revoking.current) unpair();
      }} onClose=${() => setRevoking(null)} />` : null}
    ${signOut ? html`<${ConfirmDialog} open title=${t("sessions.signout.title")} body=${t("sessions.signout.body")} confirmLabel=${t("sessions.signout.confirm")} testid="sessions.signout-dialog"
      onConfirm=${async () => {
        try {
          await api.post("/api/session/logout", {});
        } catch (error) {
          throw shown(accessError(error, i18n));
        }
        unpair();
      }} onClose=${() => setSignOut(false)} />` : null}
    ${pairOpen ? html`<${PairDialog} onClose=${() => setPairOpen(false)} />` : null}
  </div>`;
}
