// /models/knowledge (07 §6.4 "Knowledge", 02 R-UI-8): what the platform knows
// about model families, chat templates and engine errors, and where each fact
// comes from.
//
// A status panel (GET /api/knowledge/status) lists every domain with its
// layers and files: an invalid file says so (`models.knowledge.status.invalid`)
// and a file past its `staleAfterDays` is marked stale. Three tabs list the
// merged entries (GET /api/knowledge?kind=&q=&withMatches=1), each with its
// layer, file, matched cards and heuristic hits. The owner can import a pack
// (the preview shows the diff, and only a second click sends `confirm` with the
// previewed `sha256`), delete an imported pack (ConfirmDialog, then the
// `x-confirm: delete` header), reload the layers, and edit one model's override
// (`?override=<cardId>`, linked from the model's detail page), whose 422
// answer lands next to the field it names.

import { ApiError, describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DiffTable } from "../../components/diff-table.js";
import { Drawer } from "../../components/drawer.js";
import { EmptyState } from "../../components/empty-state.js";
import { FormField } from "../../components/form-field.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Tabs } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { ModelsNav } from "./subnav.js";

export const KINDS = Object.freeze(["families", "template-signatures", "error-signatures"]);
const CARD_ID = /^mc_[a-z2-7]{20}$/;
const MAX_MATCH_SHOWN = 3;

const list = (value) => (Array.isArray(value) ? value : []);
const enc = encodeURIComponent;

/** The pack id inside an imported pack's file name (`packs/<packId>@<sha12>.json`), or "". */
export function packIdOfFile(name) {
  const match = /([^/\\]+?)@[0-9a-f]{6,64}\.json$/i.exec(String(name || ""));
  return match ? match[1] : "";
}

/** "invalid" when the file reported errors, else "stale" past its staleAfterDays, else "ok". */
export function fileState(file) {
  if (list(file?.errors).length) return "invalid";
  return file?.stale ? "stale" : "ok";
}

/** One row per file of a domain, in layer order: { layer, path, file, state, packId }. */
export function domainRows(domain) {
  const rows = [];
  for (const layer of list(domain?.layers)) {
    const files = list(layer?.files);
    for (const file of files) {
      rows.push({ layer: String(layer.layer || ""), path: String(layer.path || ""), file, state: fileState(file), packId: layer.layer === "pack" ? packIdOfFile(file?.name) : "" });
    }
  }
  return rows;
}

/** Problems of a domain that count as failures (warnings do not). */
export function domainProblems(domain) {
  return list(domain?.errors).filter((item) => item?.severity !== "warning");
}

/** The pack diff as DiffTable rows: added entries have no current value, deleted ones no new value. */
export function diffRows(diff, labels) {
  return [
    ...list(diff?.added).map((id) => ({ label: id, from: "", to: labels.added })),
    ...list(diff?.replaced).map((id) => ({ label: id, from: labels.current, to: labels.replaced })),
    ...list(diff?.deleted).map((id) => ({ label: id, from: labels.current, to: "" })),
  ];
}

/** Splits a 422 answer: errors naming `id` go to that field, every other one to the JSON field. */
export function splitOverrideErrors(error) {
  const fieldErrors = list(error?.fieldErrors);
  return { id: fieldErrors.filter((item) => item.field === "id"), rest: fieldErrors.filter((item) => item.field !== "id") };
}

function FieldErrorList({ items, testid }) {
  if (!items.length) return null;
  return html`<ul class="small stack-sm" data-testid=${testid}>${items.map((item, index) => html`<li key=${index} data-user-content="">
    ${item.field ? html`<code class="code-inline mono xsmall">${item.field}</code> ` : null}${item.message || item.code}</li>`)}</ul>`;
}

// ---- status ----------------------------------------------------------------------------------------

function FileStateBadge({ file, state }) {
  const { t } = useT();
  if (state === "invalid") return html`<${StatusBadge} status="error" label=${t("models.knowledge.status.invalid")} testid="knowledge.file.invalid" />`;
  if (state === "stale") return html`<${StatusBadge} status="warn" label=${t("models.knowledge.status.stale", { days: file.ageDays ?? "?" })} testid="knowledge.file.stale" />`;
  return html`<${StatusBadge} status="ok" label=${t("models.knowledge.status.ok")} testid="knowledge.file.ok" />`;
}

function layerLabel(i18n, layer) {
  const key = tk("models.knowledge.layer.", layer);
  return i18n.has(key) ? i18n.t(key) : layer;
}

function DomainPanel({ domain, writable, onDelete }) {
  const i18n = useT();
  const { t } = i18n;
  const rows = domainRows(domain);
  const problems = domainProblems(domain);
  const unavailable = Boolean(domain.unavailable);
  const status = unavailable ? "unknown" : problems.length ? "warn" : "ok";
  return html`<section class="stack-sm" data-testid="knowledge.domain" data-domain=${domain.domain}>
    <div class="row">
      <h3 class="card-title" data-user-content="">${domain.domain}</h3>
      <${StatusBadge} status=${status} label=${unavailable ? t("models.knowledge.status.unavailable") : problems.length ? t("models.knowledge.status.problems", { count: problems.length }) : t("models.knowledge.status.ok")} />
    </div>
    ${unavailable ? html`<p class="small muted">${t("models.knowledge.status.unavailableBody")}</p>` : null}
    ${rows.length ? html`<div class="table-wrap" tabindex="0" role="region" aria-label=${t("models.knowledge.status.filesCaption", { domain: domain.domain })}><table class="table" data-testid="knowledge.files">
      <caption class="sr-only">${t("models.knowledge.status.filesCaption", { domain: domain.domain })}</caption>
      <thead><tr>
        <th scope="col">${t("models.knowledge.col.layer")}</th><th scope="col">${t("models.knowledge.col.file")}</th><th scope="col">${t("models.knowledge.col.kind")}</th>
        <th scope="col">${t("models.knowledge.col.entries")}</th><th scope="col">${t("models.knowledge.col.asOf")}</th><th scope="col">${t("models.knowledge.col.state")}</th>
        ${writable ? html`<td></td>` : null}
      </tr></thead>
      <tbody>${rows.map((row, index) => html`<tr key=${index} data-testid="knowledge.file" data-layer=${row.layer} data-state=${row.state}>
        <th scope="row"><span class="badge badge-neutral" data-testid="knowledge.file.layer">${layerLabel(i18n, row.layer)}</span>
          ${row.path ? html`<div class="mono xsmall muted" data-user-content="">${row.path}</div>` : null}</th>
        <td class="mono small" data-user-content="" data-testid="knowledge.file.name">${row.file?.name || "—"}</td>
        <td>${row.file?.kind || "—"}</td>
        <td>${row.file?.entries ?? "—"}</td>
        <td>${row.file?.asOf || "—"}</td>
        <td><${FileStateBadge} file=${row.file} state=${row.state} />
          ${list(row.file?.errors).length ? html`<ul class="small" data-testid="knowledge.file.errors">${list(row.file.errors).map((item, at) => html`<li key=${at} data-user-content="">
            ${item.entryId ? html`<code class="code-inline mono xsmall">${item.entryId}</code> ` : null}${item.message || item.code}</li>`)}</ul>` : null}
          ${row.state === "stale" ? html`<p class="small muted">${t("models.knowledge.status.staleBody", { days: row.file.staleAfterDays ?? "?" })}</p>` : null}</td>
        ${writable ? html`<td>${row.packId ? html`<${Button} size="sm" variant="danger" onClick=${() => onDelete(row.packId)} testid="knowledge.pack.delete">${t("models.knowledge.pack.delete")}<//>` : null}</td>` : null}
      </tr>`)}</tbody>
    </table></div>` : (!unavailable ? html`<p class="small muted">${t("models.knowledge.status.noFiles")}</p>` : null)}
    ${problems.length ? html`<details open><summary>${t("models.knowledge.status.problemList", { count: problems.length })}</summary>
      <ul class="small" data-testid="knowledge.problems">${problems.map((item, index) => html`<li key=${index} data-user-content="">
        <code class="code-inline mono xsmall">${[item.layer, item.file, item.entryId].filter(Boolean).join(" · ") || item.code}</code> ${item.message || item.code}</li>`)}</ul></details>` : null}
  </section>`;
}

function StatusPanel({ query, writable, onDelete }) {
  const { t } = useT();
  const domains = list(query.data?.domains);
  let body;
  if (query.error && !query.data) {
    body = html`<${EmptyState} testid="knowledge.status.failed" icon="triangle-alert" title=${t("models.knowledge.status.failed")}
      action=${{ label: t("models.knowledge.retry"), onClick: () => query.refetch() }} />`;
  } else if (!query.data) {
    body = html`<div aria-busy="true"><${Skeleton} shape="line" rows=${4} /></div>`;
  } else if (!domains.length) {
    body = html`<p class="muted">${t("models.knowledge.status.empty")}</p>`;
  } else {
    const managerFailures = list(query.data.managers).filter((item) => item && item.ok === false);
    body = html`<div class="stack">
      ${managerFailures.length ? html`<p class="notice notice-warn" role="status" data-testid="knowledge.status.managers">${t("models.knowledge.status.managersDown", { managers: managerFailures.map((item) => item.managerId).join(", ") })}</p>` : null}
      ${domains.map((domain) => html`<${DomainPanel} key=${domain.domain} domain=${domain} writable=${writable} onDelete=${onDelete} />`)}
    </div>`;
  }
  return html`<${Card} title=${t("models.knowledge.status.title")} testid="knowledge.status">${body}<//>`;
}

// ---- entries ---------------------------------------------------------------------------------------

function EntriesTable({ kind, q }) {
  const { api, i18n } = useServices();
  const { t } = i18n;
  const query = useQuery(["models", "knowledge", "entries", kind, q], () => api.get("/api/knowledge", { query: { kind, ...(q ? { q } : {}), withMatches: 1 } }), { ttlMs: 10000 });
  if (query.error && !query.data) {
    return html`<${EmptyState} testid="knowledge.entries.failed" icon="triangle-alert" title=${t("models.knowledge.entries.failed")} body=${describeError(query.error, i18n)}
      action=${{ label: t("models.knowledge.retry"), onClick: () => query.refetch() }} />`;
  }
  if (!query.data) return html`<div aria-busy="true"><${Skeleton} shape="line" rows=${5} /></div>`;
  const entries = list(query.data.entries);
  if (!entries.length) {
    return html`<p class="muted" data-testid="knowledge.entries.empty">${t(q ? "models.knowledge.entries.noMatch" : "models.knowledge.entries.empty")}</p>`;
  }
  const withMatches = kind !== "error-signatures";
  return html`<div class="table-wrap" tabindex="0" role="region" aria-label=${t(tk("models.knowledge.tab.", kind))}><table class="table" data-testid="knowledge.entries" data-kind=${kind}>
    <caption class="sr-only">${t(tk("models.knowledge.tab.", kind))}</caption>
    <thead><tr>
      <th scope="col">${t("models.knowledge.col.entry")}</th><th scope="col">${t("models.knowledge.col.layer")}</th><th scope="col">${t("models.knowledge.col.file")}</th>
      ${withMatches ? html`<th scope="col">${t("models.knowledge.col.matches")}</th>` : null}<th scope="col">${t("models.knowledge.col.hits")}</th>
    </tr></thead>
    <tbody>${entries.map((entry) => {
      const label = i18n.pick(entry.label || entry.title) || "";
      const matches = list(entry.matches);
      return html`<tr key=${entry.id} data-testid="knowledge.entry" data-entry=${entry.id} data-layer=${entry.layer}>
        <th scope="row"><span data-user-content="">${label || entry.id}</span>
          ${label && label !== entry.id ? html`<div class="mono xsmall muted" data-user-content="">${entry.id}</div>` : null}</th>
        <td><span class="badge badge-neutral" data-testid="knowledge.entry.layer">${layerLabel(i18n, entry.layer)}</span>
          ${list(entry.overrides).length ? html`<div class="xsmall muted">${t("models.knowledge.entry.overrides", { layers: list(entry.overrides).map((item) => layerLabel(i18n, typeof item === "string" ? item : item?.layer || "")).join(", ") })}</div>` : null}</td>
        <td class="mono small" data-user-content="">${entry.file || "—"}</td>
        ${withMatches ? html`<td data-testid="knowledge.entry.matches">${matches.length
          ? html`${t("models.knowledge.entry.matchCount", { count: matches.length })}<div class="mono xsmall muted" data-user-content="">${matches.slice(0, MAX_MATCH_SHOWN).join(", ")}${matches.length > MAX_MATCH_SHOWN ? " …" : ""}</div>`
          : "—"}</td>` : null}
        <td>${entry.heuristicHits || 0}</td>
      </tr>`;
    })}</tbody>
  </table></div>`;
}

function EntriesCard() {
  const { t } = useT();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 300);
  return html`<${Card} title=${t("models.knowledge.entries.title")} testid="knowledge.entries.card">
    <div class="stack">
      <div class="field">
        <label class="field-label" for="knowledge-search">${t("models.knowledge.search")}</label>
        <input id="knowledge-search" class="input" type="search" value=${q} autocomplete="off" spellcheck="false" placeholder=${t("models.knowledge.searchHint")}
          onInput=${(event) => setQ(event.currentTarget.value)} data-testid="knowledge.search" />
      </div>
      <${Tabs} tabs=${KINDS.map((kind) => ({ id: kind, label: t(tk("models.knowledge.tab.", kind)) }))} label=${t("models.knowledge.tabs")}
        renderPanel=${(kind) => html`<${EntriesTable} kind=${kind} q=${debounced} />`} testid="knowledge.tabs" />
    </div>
  <//>`;
}

// ---- import ----------------------------------------------------------------------------------------

function ImportDrawer({ open, onClose }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const [mode, setMode] = useState("url");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState("");

  const request = mode === "url" ? { url: text.trim() } : { content: text };
  const edit = (patch) => {
    if (patch.mode !== undefined) setMode(patch.mode);
    if (patch.text !== undefined) setText(patch.text);
    setPreview(null);
    setError(null);
  };
  async function run(step, body) {
    setBusy(step);
    setError(null);
    try {
      return await api.post("/api/knowledge/import", body);
    } catch (failure) {
      setError(failure);
      // The bytes changed since the preview: the old sha256 must not be confirmed.
      if (failure?.code === "sha_mismatch") setPreview(null);
      return null;
    } finally {
      setBusy("");
    }
  }
  async function previewPack() {
    const result = await run("preview", request);
    if (result) setPreview({ body: request, result });
  }
  async function confirmPack() {
    const result = await run("confirm", { ...preview.body, confirm: true, sha256: preview.result.sha256 });
    if (!result) return;
    cache.invalidate(["models", "knowledge"]);
    toasts?.push?.({ level: "success", title: t("models.knowledge.import.done", { id: result.packId }) });
    setPreview(null);
    setText("");
    onClose();
  }

  const diff = preview?.result?.diff;
  const usable = list(diff?.added).length + list(diff?.replaced).length + list(diff?.deleted).length;
  const labels = { added: t("models.knowledge.import.new"), replaced: t("models.knowledge.import.replaced"), current: t("models.knowledge.import.current") };
  const footer = html`<${Button} onClick=${onClose} testid="knowledge.import.cancel">${t("common.cancel")}<//>
    <${Button} onClick=${previewPack} busy=${busy === "preview"} disabled=${!text.trim() || Boolean(busy)} variant=${preview ? "default" : "primary"} testid="knowledge.import.preview">${t("models.knowledge.import.preview")}<//>
    ${preview ? html`<${Button} variant="primary" onClick=${confirmPack} busy=${busy === "confirm"} disabled=${!usable || Boolean(busy)} testid="knowledge.import.confirm">${t("models.knowledge.import.confirm")}<//>` : null}`;
  return html`<${Drawer} open=${open} title=${t("models.knowledge.import.title")} width=${640} onClose=${onClose} footer=${footer} testid="knowledge.import">
    <div class="stack">
      <p class="small muted">${t("models.knowledge.import.lead")}</p>
      <div class="row" role="group" aria-label=${t("models.knowledge.import.source")}>
        <${Button} size="sm" variant=${mode === "url" ? "default" : "ghost"} aria-pressed=${mode === "url" ? "true" : "false"} onClick=${() => edit({ mode: "url" })} testid="knowledge.import.mode-url">${t("models.knowledge.import.fromUrl")}<//>
        <${Button} size="sm" variant=${mode === "content" ? "default" : "ghost"} aria-pressed=${mode === "content" ? "true" : "false"} onClick=${() => edit({ mode: "content" })} testid="knowledge.import.mode-content">${t("models.knowledge.import.fromText")}<//>
      </div>
      <${FormField} label=${t(mode === "url" ? "models.knowledge.import.url" : "models.knowledge.import.content")} hint=${t(mode === "url" ? "models.knowledge.import.urlHint" : "models.knowledge.import.contentHint")}>
        ${(props) => (mode === "url"
          ? html`<input ...${props} class="input mono" type="url" value=${text} autocomplete="off" spellcheck="false" onInput=${(event) => edit({ text: event.currentTarget.value })} data-testid="knowledge.import.input" />`
          : html`<textarea ...${props} class="textarea mono" rows="10" value=${text} spellcheck="false" onInput=${(event) => edit({ text: event.currentTarget.value })} data-testid="knowledge.import.input"></textarea>`)}
      <//>
      ${error ? html`<div class="notice notice-danger stack-sm" role="alert" data-testid="knowledge.import.error">
        <span data-user-content="">${describeError(error, i18n)}</span><${FieldErrorList} items=${list(error.fieldErrors)} testid="knowledge.import.errors" /></div>` : null}
      ${preview ? html`<div class="stack-sm" data-testid="knowledge.import.diff">
        <h3 class="card-title">${t("models.knowledge.import.diffTitle", { id: preview.result.packId, kind: preview.result.kind })}</h3>
        <p class="small muted">${t("models.knowledge.import.bytes", { bytes: preview.result.bytes ?? 0 })} · <code class="code-inline mono xsmall" data-testid="knowledge.import.sha" data-user-content="">${preview.result.sha256}</code></p>
        <${DiffTable} rows=${diffRows(diff, labels)} caption=${t("models.knowledge.import.diffCaption")} testid="knowledge.import.diff-table" />
        ${list(diff?.invalidEntries).length ? html`<div><p class="small">${t("models.knowledge.import.invalid", { count: list(diff.invalidEntries).length })}</p>
          <${FieldErrorList} items=${list(diff.invalidEntries).map((item) => ({ field: item.entryId, message: item.message, code: item.code }))} testid="knowledge.import.invalid" /></div>` : null}
        ${usable ? html`<p class="small">${t("models.knowledge.import.confirmHint")}</p>` : html`<p class="small field-error" role="alert">${t("models.knowledge.import.nothing")}</p>`}
      </div>` : null}
    </div>
  <//>`;
}

// ---- per-model override ----------------------------------------------------------------------------

function OverrideDrawer({ cardId, onClose }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const [id, setId] = useState("");
  const [json, setJson] = useState("{\n  \n}");
  const [error, setError] = useState(null);
  const [parseError, setParseError] = useState("");
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState(cardId);

  async function save() {
    let fields;
    try {
      fields = JSON.parse(json.trim() || "{}");
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("not an object");
    } catch {
      setParseError(t("models.knowledge.override.notJson"));
      return;
    }
    setParseError("");
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/knowledge/overrides/models/${enc(card.trim())}`, { ...fields, ...(id.trim() ? { id: id.trim() } : {}) });
      cache.invalidate(["models", "knowledge"]);
      toasts?.push?.({ level: "success", title: t("models.knowledge.override.done") });
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure : new ApiError({ message: String(failure?.message || failure) }));
    } finally {
      setBusy(false);
    }
  }
  const split = splitOverrideErrors(error);
  const idError = split.id.map((item) => item.message || item.code).join(" ");
  const cardValid = CARD_ID.test(card.trim());
  const footer = html`<${Button} onClick=${onClose} testid="knowledge.override.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" onClick=${save} busy=${busy} disabled=${!cardValid} testid="knowledge.override.save">${t("models.knowledge.override.save")}<//>`;
  return html`<${Drawer} open=${true} title=${t("models.knowledge.override.title")} width=${640} onClose=${onClose} footer=${footer} testid="knowledge.override">
    <div class="stack">
      <p class="small muted">${t("models.knowledge.override.lead")}</p>
      <${FormField} label=${t("models.knowledge.override.card")} hint=${t("models.knowledge.override.cardHint")} error=${card && !cardValid ? t("models.knowledge.override.cardInvalid") : undefined}>
        ${(props) => html`<input ...${props} class="input mono" value=${card} autocomplete="off" spellcheck="false" onInput=${(event) => setCard(event.currentTarget.value)} data-testid="knowledge.override.card" />`}
      <//>
      <${FormField} label=${t("models.knowledge.override.id")} hint=${t("models.knowledge.override.idHint")} error=${idError || undefined} testid="knowledge.override.id-field">
        ${(props) => html`<input ...${props} class="input mono" value=${id} autocomplete="off" spellcheck="false" onInput=${(event) => setId(event.currentTarget.value)} data-testid="knowledge.override.id" />`}
      <//>
      <${FormField} label=${t("models.knowledge.override.fields")} hint=${t("models.knowledge.override.fieldsHint")} error=${parseError || (split.rest.length ? t("models.knowledge.override.rejected") : undefined)} testid="knowledge.override.fields-field">
        ${(props) => html`<textarea ...${props} class="textarea mono" rows="12" value=${json} spellcheck="false" onInput=${(event) => setJson(event.currentTarget.value)} data-testid="knowledge.override.json"></textarea>`}
      <//>
      <${FieldErrorList} items=${split.rest} testid="knowledge.override.errors" />
      ${error && error.status !== 422 ? html`<p class="field-error" role="alert" data-testid="knowledge.override.error" data-user-content="">${describeError(error, i18n)}</p>` : null}
    </div>
  <//>`;
}

// ---- page ------------------------------------------------------------------------------------------

export default function KnowledgePage({ query = {} }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = i18n;
  const writable = useRole() === "owner";
  const status = useQuery(["models", "knowledge", "status"], () => api.get("/api/knowledge/status"), { ttlMs: 10000 });
  const [importing, setImporting] = useState(false);
  const [overrideCard, setOverrideCard] = useState(typeof query.override === "string" ? query.override : null);
  const [deleting, setDeleting] = useState("");
  const [reloading, setReloading] = useState(false);

  async function reload() {
    setReloading(true);
    try {
      await api.post("/api/knowledge/reload", {});
      cache.invalidate(["models", "knowledge"]);
      toasts?.push?.({ level: "success", title: t("models.knowledge.reloaded") });
    } catch (failure) {
      toasts?.push?.({ level: "error", title: describeError(failure, i18n), requestId: failure?.requestId || null });
    } finally {
      setReloading(false);
    }
  }
  async function deletePack() {
    await api.del(`/api/knowledge/packs/${enc(deleting)}`, { headers: { "x-confirm": "delete" } });
    cache.invalidate(["models", "knowledge"]);
    toasts?.push?.({ level: "success", title: t("models.knowledge.pack.deleted", { id: deleting }) });
  }

  const actions = writable ? html`<${Button} onClick=${() => setOverrideCard("")} testid="knowledge.override.open">${t("models.knowledge.override.open")}<//>
    <${Button} onClick=${reload} busy=${reloading} testid="knowledge.reload">${t("models.knowledge.reload")}<//>
    <${Button} variant="primary" onClick=${() => setImporting(true)} testid="knowledge.import.open">${t("models.knowledge.import.open")}<//>` : null;
  return html`<div class="stack" data-testid="knowledge">
    <${PageHeader} title=${t("shell.nav.models")} subtitle=${t("models.knowledge.subtitle")} actions=${actions} />
    <${ModelsNav} current="knowledge" />
    <${StatusPanel} query=${status} writable=${writable} onDelete=${setDeleting} />
    <${EntriesCard} />
    ${importing ? html`<${ImportDrawer} open=${true} onClose=${() => setImporting(false)} />` : null}
    ${overrideCard !== null ? html`<${OverrideDrawer} cardId=${overrideCard} onClose=${() => setOverrideCard(null)} />` : null}
    <${ConfirmDialog} open=${Boolean(deleting)} tone="danger" testid="knowledge.pack.confirm" title=${t("models.knowledge.pack.deleteTitle")}
      body=${t("models.knowledge.pack.deleteBody", { id: deleting })} confirmLabel=${t("models.knowledge.pack.delete")} onConfirm=${deletePack} onClose=${() => setDeleting("")} />
  </div>`;
}
