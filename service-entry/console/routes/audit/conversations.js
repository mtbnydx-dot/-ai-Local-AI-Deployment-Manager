// Audit › Conversations `/audit/conversations` (07 §6.8, 04 §16.5): search and
// browse the OpenWebUI conversations from the audit index
// (GET /api/audit/chats), open one as a thread (GET /api/audit/chats/:chatId,
// its versions from …/versions). Needs the audit unlock.
//
// Message text is untrusted: it renders through MarkdownViewer as a node tree,
// so raw HTML, scripts and `javascript:` links stay inert text, remote images
// are not loaded, and nothing is written to a storage, a cookie or the URL
// (only the chat id and audit id are, never the text). The text lives in this
// page's state and goes away with it.

import { chatsPage, chatsQuery, parseChatSearch, threadModel, versionRows } from "../../lib/audit-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { DataTable } from "../../components/data-table.js";
import { Drawer } from "../../components/drawer.js";
import { EmptyState } from "../../components/empty-state.js";
import { MarkdownViewer } from "../../components/markdown-viewer.js";
import { AuditPage, LoadError, Loading, useAuditApi, useAuditLoad, useAuditPages, useUrlSearch } from "./common.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useMemo, useState } from "../../ui/vendor.js";

// ---------------------------------------------------------------------------
// Thread

function Message({ message }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<article class="audit-msg" data-role=${message.role} data-testid="audit.message">
    <header class="audit-msg-head">
      <strong>${t(tk("audit.role.", message.role))}</strong>
      ${message.model ? html`<span class="mono small muted" data-user-content>${message.model}</span>` : null}
      ${message.at === null ? null : html`<time class="small muted" dateTime=${new Date(message.at).toISOString()}>${fmt.dateTime(message.at, { style: "long" })}</time>`}
    </header>
    <div class="audit-msg-body" data-user-content>
      <${MarkdownViewer} source=${message.content} allowImages="none" flatHeadings=${true} testid="audit.message.body" />
    </div>
  </article>`;
}

function Thread({ chatId, auditId, onVersion }) {
  const audit = useAuditApi();
  const { t } = useT();
  const fmt = useFormat();
  const loaded = useAuditLoad(async () => {
    const enc = encodeURIComponent(chatId);
    const [chat, versions] = await Promise.all([
      audit.get(`chats/${enc}`, auditId ? { auditId } : undefined),
      audit.get(`chats/${enc}/versions`).catch((error) => (error?.status === 401 ? Promise.reject(error) : null)),
    ]);
    return { thread: threadModel(chat), versions: versionRows(versions) };
  }, [chatId, auditId]);
  if (loaded.error) return html`<${LoadError} error=${loaded.error} onRetry=${loaded.reload} testid="audit.thread.error" />`;
  if (!loaded.data) return html`<${Loading} rows=${5} />`;
  const { thread, versions } = loaded.data;
  return html`<div class="stack" data-testid="audit.thread" data-chat=${thread.chatId || chatId}>
    <dl class="obs-facts small">
      ${thread.userName ? html`<div><dt>${t("audit.col.user")}</dt><dd data-user-content>${thread.userName}</dd></div>` : null}
      ${thread.models.length ? html`<div><dt>${t("audit.col.models")}</dt><dd data-user-content>${thread.models.join(", ")}</dd></div>` : null}
      <div><dt>${t("audit.col.messages")}</dt><dd>${fmt.integer(thread.messages.length)}</dd></div>
    </dl>
    ${versions.length > 1 ? html`<div class="field">
      <label class="field-label" for="audit-version">${t("audit.thread.version")}</label>
      <select class="select" id="audit-version" value=${thread.auditId} data-testid="audit.thread.versions" onChange=${(event) => onVersion(event.currentTarget.value)}>
        ${versions.map((item) => html`<option key=${item.auditId} value=${item.auditId}>${`${fmt.dateTime(item.createdAt)} · ${t("audit.thread.messagesN", { n: item.messageCount })}`}</option>`)}
      </select>
    </div>` : null}
    ${thread.isLatest ? null : html`<p class="notice notice-info" role="status" data-testid="audit.thread.old">${t("audit.thread.notLatest")}</p>`}
    ${thread.messages.length ? html`<div class="audit-thread">${thread.messages.map((message) => html`<${Message} key=${message.id} message=${message} />`)}</div>`
      : html`<p class="muted" data-testid="audit.thread.empty">${t("audit.thread.empty")}</p>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Search

function SearchForm({ filters, onApply }) {
  const { t } = useT();
  const [key, setKey] = useState(0);
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = {};
    for (const name of ["q", "user", "model", "archived", "from", "to"]) next[name] = String(form.get(name) || "").trim() || null;
    onApply(next);
  }
  const text = (name, props = {}) => html`<div class="field">
    <label class="field-label" for=${`audit-filter-${name}`}>${t(tk("audit.filter.", name))}</label>
    <input class="input" id=${`audit-filter-${name}`} name=${name} type="text" autocomplete="off" spellcheck="false" maxlength="200" defaultValue=${filters[name] || ""} data-testid=${`audit.filter.${name}`} ...${props} />
  </div>`;
  const day = (name) => html`<div class="field">
    <label class="field-label" for=${`audit-filter-${name}`}>${t(tk("audit.filter.", name))}</label>
    <input class="input" id=${`audit-filter-${name}`} name=${name} type="date" defaultValue=${filters[name] || ""} data-testid=${`audit.filter.${name}`} />
  </div>`;
  const active = Object.keys(filters).length;
  return html`<form class="stack-sm" key=${key} onSubmit=${submit} role="search" aria-label=${t("audit.search")} data-testid="audit.search">
    <div class="obs-filter-grid">
      ${text("q", { placeholder: t("audit.filter.qHint") })}
      ${text("user")}
      ${text("model")}
      <div class="field">
        <label class="field-label" for="audit-filter-archived">${t("audit.filter.archived")}</label>
        <select class="select" id="audit-filter-archived" name="archived" defaultValue=${filters.archived || ""} data-testid="audit.filter.archived">
          <option value="">${t("audit.filter.archived.any")}</option>
          <option value="no">${t("audit.filter.archived.no")}</option>
          <option value="yes">${t("audit.filter.archived.yes")}</option>
        </select>
      </div>
      ${day("from")}
      ${day("to")}
    </div>
    <div class="row">
      <${Button} type="submit" variant="primary" icon="search" testid="audit.search-submit">${t("audit.search")}<//>
      <${Button} disabled=${!active} onClick=${() => {
        setKey((value) => value + 1);
        onApply({ q: null, user: null, model: null, archived: null, from: null, to: null });
      }} testid="audit.search-clear">${t("obs.req.clear")}<//>
    </div>
  </form>`;
}

function Results({ filters, tick, onOpen }) {
  const audit = useAuditApi();
  const { t } = useT();
  const fmt = useFormat();
  // `tick` re-runs the same search (the Search button is also a refresh).
  const id = `${tick}|${JSON.stringify(filters)}`;
  const list = useAuditPages(id, async (cursor) => {
    const page = chatsPage(await audit.get("chats", chatsQuery(filters, { cursor })));
    return { rows: page.rows, cursor: page.cursor, meta: { building: page.building } };
  });
  const columns = useMemo(() => [
    { id: "title", header: t("audit.col.title"), sort: true, csv: (row) => row.title,
      cell: (row) => html`<button type="button" class="link-button" data-testid="audit.chat.open" onClick=${() => onOpen(row)}><span data-user-content>${row.title || row.chatId}</span></button>` },
    { id: "userName", header: t("audit.col.user"), sort: true, cell: (row) => html`<span data-user-content>${row.userName || "—"}</span>` },
    { id: "models", header: t("audit.col.models"), sort: (row) => row.models.join(","), csv: (row) => row.models.join(" "), hideable: true, cell: (row) => html`<span data-user-content>${row.models.join(", ") || "—"}</span>` },
    { id: "updatedAt", header: t("audit.col.updated"), sort: (row) => Date.parse(row.updatedAt) || 0, csv: (row) => row.updatedAt,
      cell: (row) => (row.updatedAt ? html`<time dateTime=${row.updatedAt} title=${fmt.dateTime(row.updatedAt, { style: "long" })}>${fmt.dateTime(row.updatedAt, { style: "short" })}</time>` : "—") },
    { id: "messageCount", header: t("audit.col.messages"), align: "end", sort: true, cell: (row) => fmt.integer(row.messageCount) },
    { id: "versions", header: t("audit.col.versions"), align: "end", sort: true, hideable: true, defaultHidden: true, cell: (row) => fmt.integer(row.versions) },
    { id: "archived", header: t("audit.col.archived"), sort: (row) => (row.archived ? 1 : 0), hideable: true, defaultHidden: true, csv: (row) => (row.archived ? "1" : "0"), cell: (row) => t(row.archived ? "obs.yes" : "obs.no") },
  ], [t, fmt, onOpen]);
  if (list.error) return html`<${LoadError} error=${list.error} onRetry=${list.reload} />`;
  if (list.loading) return html`<${Loading} rows=${4} />`;
  const empty = html`<${EmptyState} icon="search" title=${t("audit.empty")} body=${t("audit.emptyBody")} action=${{ label: t("obs.req.clear"), href: "/audit/conversations" }} testid="audit.empty" />`;
  return html`<div class="stack-sm">
    ${list.meta?.building ? html`<p class="notice notice-info" role="status" data-testid="audit.index-building">${t("audit.indexBuilding")}</p>` : null}
    <${DataTable} id="audit-chats" columns=${columns} rows=${list.rows} rowKey=${(row) => `${row.chatId}:${row.auditId}`} caption=${t("audit.table.chats")} exportName="audit-conversations" empty=${empty} responsive="cards"
      source=${{ cursor: list.cursor, loading: list.loadingMore, loadMore: list.loadMore }} testid="audit.chats" />
    ${list.moreError ? html`<p class="notice notice-warn" role="alert">${t("obs.req.moreFailed")}</p>` : null}
  </div>`;
}

function Body() {
  const { t } = useT();
  const [search, patch] = useUrlSearch();
  const [tick, setTick] = useState(0);
  const state = useMemo(() => parseChatSearch(search), [search]);
  const chat = state.chat;
  return html`
    <${Card} title=${t("audit.nav.conversations")} testid="audit.conversations">
      <div class="stack">
        <${SearchForm} filters=${state.filters} onApply=${(next) => {
          patch(next);
          setTick((value) => value + 1);
        }} />
        <${Results} filters=${state.filters} tick=${tick} onOpen=${(row) => patch({ chat: row.chatId, auditId: row.auditId || null }, { replace: false })} />
      </div>
    <//>
    <${Drawer} open=${Boolean(chat)} title=${t("audit.thread.title")} width=${840} onClose=${() => patch({ chat: null, auditId: null }, { replace: false })} testid="audit.drawer">
      ${chat ? html`<${Thread} chatId=${chat} auditId=${state.auditId} onVersion=${(auditId) => patch({ auditId }, { replace: true })} />` : null}
    <//>
  `;
}

export default function AuditConversations() {
  return html`<${AuditPage} id="conversations" needsUnlock=${true}>${() => html`<${Body} />`}<//>`;
}
