// External endpoints (07 §6.5, 01 §20, §21.2): OpenAI-compatible servers
// registered with the entry. The table shows name, base URL, models, latency,
// health and whether the endpoint is routable. Add and Edit take the API key as
// a write-only secret: it is typed into a password field, sent once and dropped
// from the page state; neither the key nor its secret-store reference is ever
// rendered, and a saved endpoint only shows "key stored". Test is a read-only
// probe; Remove asks first and deletes the stored key with the record.
//
// The panel is the /engines/external page and the card on /engines.

import { describeError } from "../../lib/api.js";
import {
  EXTERNAL_KINDS, draftFromEndpoint, emptyEndpointDraft, endpointCreateBody, endpointHealthStatus, endpointPatchBody, endpointRoutable,
  needsPlaintextAck, testResultView, validateEndpointDraft,
} from "../../lib/engines-model.js";
import { ExternalEndpointsGuard } from "../../lib/schemas.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Dialog } from "../../components/dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { FormField } from "../../components/form-field.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { TableWrap } from "./engine-parts.js";

const enc = encodeURIComponent;
const ENDPOINTS = "/api/engines/external/endpoints";

/** The field errors of a failed save, by field name; `rest` are the ones no field shows. */
function splitServerErrors(error) {
  const byField = {};
  const rest = [];
  for (const item of error?.fieldErrors || []) {
    const field = item.field && ["endpointId", "label", "kind", "baseUrl", "apiKey"].includes(item.field) ? item.field : null;
    if (field && !byField[field]) byField[field] = item;
    else rest.push(item);
  }
  return { byField, rest };
}

function EndpointDialog({ mode, endpoint, existingIds, onClose }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t, tk } = useT();
  const [draft, setDraft] = useState(() => (mode === "edit" ? draftFromEndpoint(endpoint) : emptyEndpointDraft()));
  const [shown, setShown] = useState(false);
  const [client, setClient] = useState({});
  const [server, setServer] = useState({ byField: {}, rest: [], message: "", needsAck: false });
  const [busy, setBusy] = useState(false);
  const set = (name, value) => setDraft((current) => ({ ...current, [name]: value }));
  const editing = mode === "edit";
  const ack = needsPlaintextAck(draft.baseUrl) || server.needsAck;

  const message = (field, errors) => {
    const item = errors[field];
    if (!item) return null;
    const key = tk("engines.page.ext.err.", item.code);
    return i18n.has(key) ? t(key, item.params) : item.message || item.code;
  };
  const errorFor = (field) => (client[field] ? message(field, client) : server.byField[field] ? message(field, server.byField) : null);

  async function save() {
    const checked = validateEndpointDraft({ ...draft, acknowledgePlaintext: draft.acknowledgePlaintext }, { mode, existingIds });
    setClient(Object.fromEntries(checked.errors.map((item) => [item.field, item])));
    if (!checked.ok) return;
    setBusy(true);
    setServer({ byField: {}, rest: [], message: "", needsAck: false });
    try {
      if (editing) {
        const body = endpointPatchBody(draft, endpoint);
        if (Object.keys(body).length) await api.patch(`${ENDPOINTS}/${enc(endpoint.endpointId)}`, body);
      } else {
        await api.post(ENDPOINTS, endpointCreateBody(draft));
      }
      // The key leaves the page state with the dialog: the draft is dropped before anything else renders.
      setDraft(emptyEndpointDraft());
      cache.invalidate(["engines"]);
      toasts?.push?.({ level: "success", title: t(editing ? "engines.page.ext.saved" : "engines.page.ext.added") });
      onClose();
    } catch (error) {
      const { byField, rest } = splitServerErrors(error);
      setServer({
        byField,
        rest,
        message: Object.keys(byField).length || rest.length ? "" : describeError(error, i18n),
        needsAck: (error?.fieldErrors || []).some((item) => item.code === "plaintext_remote"),
      });
    } finally {
      setBusy(false);
    }
  }

  const footer = html`
    <${Button} onClick=${onClose} disabled=${busy} testid="engine-endpoint.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" onClick=${save} busy=${busy} testid="engine-endpoint.save">${t(editing ? "engines.page.ext.save" : "engines.page.ext.add")}<//>`;
  return html`<${Dialog} open title=${t(editing ? "engines.page.ext.editTitle" : "engines.page.ext.addTitle")} onClose=${() => !busy && onClose()} dismissible=${!busy}
    footer=${footer} testid="engine-endpoint.dialog">
    <div class="stack-sm">
      ${editing
        ? html`<p class="small"><span class="muted">${t("engines.page.ext.id")}</span> <code class="code-inline" data-testid="engine-endpoint.id">${endpoint.endpointId}</code></p>`
        : html`<${FormField} label=${t("engines.page.ext.id")} required error=${errorFor("endpointId")} hint=${t("engines.page.ext.idHint")}>
          ${(props) => html`<input ...${props} class="input mono" data-autofocus="" autocomplete="off" autocapitalize="off" spellcheck="false" value=${draft.endpointId}
            onInput=${(event) => set("endpointId", event.currentTarget.value)} data-testid="engine-endpoint.field.id" />`}
        <//>`}
      <${FormField} label=${t("engines.page.ext.label")} error=${errorFor("label")}>
        ${(props) => html`<input ...${props} class="input" autocomplete="off" value=${draft.label} onInput=${(event) => set("label", event.currentTarget.value)} data-testid="engine-endpoint.field.label" />`}
      <//>
      <${FormField} label=${t("engines.page.ext.kind")} error=${errorFor("kind")}>
        ${(props) => html`<select ...${props} class="select" value=${draft.kind} onChange=${(event) => set("kind", event.currentTarget.value)} data-testid="engine-endpoint.field.kind">
          ${EXTERNAL_KINDS.map((kind) => html`<option key=${kind} value=${kind}>${t(tk("engines.page.ext.kind.", kind))}</option>`)}</select>`}
      <//>
      <${FormField} label=${t("engines.page.ext.baseUrl")} required error=${errorFor("baseUrl")} hint=${t("engines.page.ext.baseUrlHint")}>
        ${(props) => html`<input ...${props} class="input mono" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder=${t("engines.page.ext.baseUrlPlaceholder")}
          value=${draft.baseUrl} onInput=${(event) => set("baseUrl", event.currentTarget.value)} data-testid="engine-endpoint.field.baseUrl" />`}
      <//>
      ${ack ? html`<label class="check" data-testid="engine-endpoint.ack"><input type="checkbox" checked=${draft.acknowledgePlaintext}
        onChange=${(event) => set("acknowledgePlaintext", event.currentTarget.checked)} data-testid="engine-endpoint.field.ack" /> ${t("engines.page.ext.ack")}</label>` : null}
      ${editing ? html`<fieldset class="stack-sm" data-testid="engine-endpoint.key-actions">
        <legend class="field-label">${t("engines.page.ext.key")}</legend>
        <p class="small muted">${draft.hasKey ? t("engines.page.ext.keyStored") : t("engines.page.ext.keyNone")}</p>
        ${[["keep", "engines.page.ext.keyKeep"], ["replace", "engines.page.ext.keyReplace"], ...(draft.hasKey ? [["remove", "engines.page.ext.keyRemove"]] : [])].map(([value, key]) => html`<label key=${value} class="check">
          <input type="radio" name="key-action" value=${value} checked=${draft.keyAction === value} onChange=${() => set("keyAction", value)} data-testid=${`engine-endpoint.key.${value}`} /> ${t(key)}</label>`)}
      </fieldset>` : null}
      ${!editing || draft.keyAction === "replace" ? html`<${FormField} label=${t("engines.page.ext.keyField")} error=${errorFor("apiKey")} hint=${t("engines.page.ext.keyHint")}>
        ${(props) => html`<div class="row-nowrap"><input ...${props} class="input mono grow" type=${shown ? "text" : "password"} autocomplete="new-password" autocapitalize="off" spellcheck="false"
          value=${draft.apiKey} onInput=${(event) => set("apiKey", event.currentTarget.value)} data-testid="engine-endpoint.field.apiKey" />
          <${Button} size="sm" variant="ghost" onClick=${() => setShown(!shown)} aria-pressed=${shown ? "true" : "false"} testid="engine-endpoint.key-toggle">${t(shown ? "engines.page.ext.keyHide" : "engines.page.ext.keyShow")}<//></div>`}
      <//>` : null}
      <label class="check"><input type="checkbox" checked=${draft.enabled} onChange=${(event) => set("enabled", event.currentTarget.checked)} data-testid="engine-endpoint.field.enabled" /> ${t("engines.page.ext.enabled")}</label>
      <label class="check"><input type="checkbox" checked=${draft.includeInAuto} onChange=${(event) => set("includeInAuto", event.currentTarget.checked)} data-testid="engine-endpoint.field.auto" /> ${t("engines.page.ext.includeInAuto")}</label>
      ${server.rest.length ? html`<ul class="field-error" data-testid="engine-endpoint.errors">${server.rest.map((item, index) => html`<li key=${index}><code class="code-inline">${item.field || item.code}</code> <span data-user-content="">${item.message}</span></li>`)}</ul>` : null}
      ${server.message ? html`<p class="field-error" role="alert" data-testid="engine-endpoint.error">${server.message}</p>` : null}
    </div>
  <//>`;
}

function TestResult({ result }) {
  const { t } = useT();
  if (result === "pending") return html`<span class="small muted" role="status">${t("engines.page.ext.testing")}</span>`;
  const view = testResultView(result);
  return html`<span class=${`small ${view.ok ? "text-success" : "text-danger"}`} role="status" data-testid="engine-endpoint.test-result" data-ok=${view.ok ? "true" : "false"}>
    ${view.ok
      ? t("engines.page.ext.testOk", { ms: view.latencyMs ?? "—", count: view.models.length })
      : t("engines.page.ext.testFailed", { code: view.errorCode || view.state || "error" })}
  </span>`;
}

function EndpointRow({ endpoint, owner, test, onTest, onEdit, onRemove }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  const health = endpoint.health && typeof endpoint.health === "object" ? endpoint.health : {};
  const status = endpointHealthStatus(endpoint);
  const state = endpoint.enabled === false ? "disabled" : health.state || "unchecked";
  const routable = endpointRoutable(endpoint);
  const models = Number.isFinite(health.models) ? health.models : null;
  return html`<tr data-testid="engine-endpoint" data-endpoint=${endpoint.endpointId}>
    <th scope="row"><span data-user-content="">${endpoint.label || endpoint.endpointId}</span>
      <div class="xsmall muted mono">${endpoint.endpointId}${endpoint.kind ? ` · ${t(tk("engines.page.ext.kind.", endpoint.kind))}` : ""}</div></th>
    <td>${endpoint.baseUrl
      ? html`<code class="code-inline truncate" data-testid="engine-endpoint.url">${endpoint.baseUrl}</code>`
      : html`<span class="badge badge-neutral" data-testid="engine-endpoint.host-class">${t(tk("engines.page.ext.hostClass.", endpoint.hostClass || "remote"))}</span>`}
      ${owner && endpoint.apiKeyRef ? html`<div class="xsmall muted" data-testid="engine-endpoint.key-stored">${t("engines.page.ext.keyStored")}</div>` : null}</td>
    <td class="num">${models === null ? "—" : fmt.integer(models)}</td>
    <td class="num">${Number.isFinite(health.latencyMs) ? t("engines.page.ext.ms", { ms: health.latencyMs }) : "—"}</td>
    <td><${StatusBadge} status=${status} label=${t(tk("engines.page.ext.state.", state))} testid="engine-endpoint.health" /></td>
    <td><span data-routable=${routable.routable ? "yes" : "no"}>${t(routable.routable ? "engines.page.ext.routableYes" : "engines.page.ext.routableNo")}</span>
      <div class="xsmall muted">${t(tk("engines.page.ext.reason.", routable.reason))}</div></td>
    ${owner ? html`<td><div class="row">
      <${Button} size="sm" onClick=${() => onTest(endpoint)} busy=${test === "pending"} testid="engine-endpoint.test">${t("engines.page.ext.test")}<//>
      <${Button} size="sm" onClick=${() => onEdit(endpoint)} testid="engine-endpoint.edit">${t("engines.page.ext.edit")}<//>
      <${Button} size="sm" variant="danger" onClick=${() => onRemove(endpoint)} testid="engine-endpoint.remove">${t("engines.page.ext.remove")}<//>
    </div>${test ? html`<div><${TestResult} result=${test} /></div>` : null}</td>` : null}
  </tr>`;
}

export function ExternalEndpointsPanel({ level = 2 }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t } = useT();
  const owner = useRole() === "owner";
  const query = useQuery(["engines", "external"], () => api.get(ENDPOINTS, { guard: ExternalEndpointsGuard }), { ttlMs: 10000, refetchMs: 15000 });
  const [dialog, setDialog] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [tests, setTests] = useState({});
  const endpoints = query.data?.endpoints || [];

  async function runTest(endpoint) {
    setTests((current) => ({ ...current, [endpoint.endpointId]: "pending" }));
    try {
      const result = await api.post(`${ENDPOINTS}/${enc(endpoint.endpointId)}/test`);
      setTests((current) => ({ ...current, [endpoint.endpointId]: result }));
      cache.invalidate(["engines", "external"]);
    } catch (error) {
      setTests((current) => ({ ...current, [endpoint.endpointId]: { ok: false, error: { code: error?.code || "error" } } }));
      toasts?.push?.({ level: "error", title: describeError(error, i18n) });
    }
  }

  async function remove() {
    await api.del(`${ENDPOINTS}/${enc(removing.endpointId)}`, { query: { confirm: "1" } });
    cache.invalidate(["engines"]);
    toasts?.push?.({ level: "success", title: t("engines.page.ext.removed") });
  }

  const addAction = owner ? html`<${Button} variant="primary" size="sm" onClick=${() => setDialog({ mode: "create" })} testid="engine-endpoint.add">${t("engines.page.ext.add")}<//>` : null;
  let body;
  if (query.error && !query.data) {
    body = html`<div class="notice notice-danger" role="alert" data-testid="engine-endpoints.error">${t("engines.page.ext.failed")}
      <button type="button" class="btn btn-sm" onClick=${() => query.refetch()}>${t("engines.page.retry")}</button></div>`;
  } else if (!query.data) {
    body = html`<div aria-busy="true"><${Skeleton} shape="table" rows=${3} /></div>`;
  } else if (!endpoints.length) {
    body = html`<${EmptyState} icon="info" level=${level + 1} title=${t("engines.page.ext.none")} body=${t("engines.page.ext.noneBody")}
      action=${owner ? { label: t("engines.page.ext.add"), onClick: () => setDialog({ mode: "create" }) } : { label: t("engines.page.backToList"), href: "/engines" }} />`;
  } else {
    body = html`<${TableWrap} label=${t("engines.page.ext.tableLabel")}><table class="table" data-testid="engine-endpoints.table">
      <caption class="sr-only">${t("engines.page.ext.caption")}</caption>
      <thead><tr>
        <th scope="col">${t("engines.page.ext.name")}</th><th scope="col">${t("engines.page.ext.baseUrl")}</th><th scope="col">${t("engines.page.ext.models")}</th>
        <th scope="col">${t("engines.page.ext.latency")}</th><th scope="col">${t("engines.page.ext.health")}</th><th scope="col">${t("engines.page.ext.routable")}</th>
        ${owner ? html`<th scope="col">${t("engines.page.runtimes.actions")}</th>` : null}
      </tr></thead>
      <tbody>${endpoints.map((endpoint) => html`<${EndpointRow} key=${endpoint.endpointId} endpoint=${endpoint} owner=${owner} test=${tests[endpoint.endpointId]}
        onTest=${runTest} onEdit=${(row) => setDialog({ mode: "edit", endpoint: row })} onRemove=${setRemoving} />`)}</tbody>
    </table><//>`;
  }

  return html`<${Card} title=${t("engines.page.ext.title")} level=${level} actions=${addAction} testid="engine-endpoints">
    <p class="small muted">${t("engines.page.ext.intro")}</p>
    ${body}
    ${dialog ? html`<${EndpointDialog} mode=${dialog.mode} endpoint=${dialog.endpoint} existingIds=${endpoints.map((item) => item.endpointId)} onClose=${() => setDialog(null)} />` : null}
    <${ConfirmDialog} open=${Boolean(removing)} tone="danger" title=${removing ? t("engines.page.ext.removeTitle", { name: removing.label || removing.endpointId }) : ""}
      body=${t("engines.page.ext.removeBody")} confirmLabel=${t("engines.page.ext.remove")} onConfirm=${remove} onClose=${() => setRemoving(null)} testid="engine-endpoint.remove-dialog" />
  <//>`;
}

export default function ExternalEndpointsPage() {
  const { t } = useT();
  return html`<div class="stack" data-testid="engines-external">
    <${PageHeader} title=${t("engines.page.ext.pageTitle")} subtitle=${t("engines.page.ext.pageSubtitle")}
      breadcrumbs=${[{ label: t("shell.nav.engines"), href: "/engines" }, { label: t("engines.page.ext.pageTitle") }]} />
    <${ExternalEndpointsPanel} />
  </div>`;
}
