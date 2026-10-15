// Alerts › Channels (07 §6.9): the in-console and Windows toast channels, the
// webhook list (masked URLs; add, edit and remove through the telemetry
// settings with If-Match) and "Send test", which reports what the server says.

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { newWebhookId, SEVERITIES, WEBHOOK_FORMATS, webhookBody } from "../../lib/alerts-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Drawer } from "../../components/drawer.js";
import { EmptyState } from "../../components/empty-state.js";
import { FormField } from "../../components/form-field.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { Load, useNotify } from "./common.js";

function TestResult({ result }) {
  const { t, has } = useT();
  if (!result) return null;
  const tone = result.delivered ? "ok" : result.error === "no_subscriber" ? "warn" : "error";
  let text;
  if (result.delivered) text = t("obs.al.test.delivered");
  else if (result.error === "no_subscriber") text = t("obs.al.test.noSubscriber");
  else text = t("obs.al.test.failed", { reason: has(tk("obs.alert.testfail.", result.error)) ? t(tk("obs.alert.testfail.", result.error)) : result.message || String(result.error || "") });
  return html`<p class=${`notice notice-${tone === "ok" ? "success" : tone === "warn" ? "warn" : "danger"}`} role=${tone === "error" ? "alert" : "status"} data-delivered=${result.delivered ? "true" : "false"} data-testid="alerts.test.result">${text}</p>`;
}

function WebhookDrawer({ hook, settings, onClose, onSaved }) {
  const { api } = useServices();
  const i18n = useT();
  const { t, has } = i18n;
  const notify = useNotify();
  const [draft, setDraft] = useState(() => ({ url: hook?.url || "", format: hook?.format || "generic", minSeverity: hook?.minSeverity || "warning", secret: "" }));
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const hooks = Array.isArray(settings.alerts?.webhooks) ? settings.alerts.webhooks : [];
  const message = (field) => {
    const item = errors[field];
    if (!item) return undefined;
    return has(tk("obs.alert.err.", item.code)) ? t(tk("obs.alert.err.", item.code)) : item.message || item.code;
  };

  async function save() {
    setBusy(true);
    setProblem(null);
    setErrors({});
    const id = hook?.id || newWebhookId();
    const drafted = { id, url: draft.url.trim(), format: draft.format, minSeverity: draft.minSeverity, ...(draft.secret ? { secret: draft.secret } : {}) };
    try {
      await api.put("/api/telemetry/settings", webhookBody(hooks, id, drafted), { headers: { "if-match": settings.etag } });
      notify("success", t("obs.al.hook.saved"));
      onSaved();
    } catch (error) {
      if (error?.status === 409 || error?.code === "etag_mismatch") {
        setProblem(t("obs.al.hook.conflict"));
      } else {
        const list = error?.fieldErrors?.length ? error.fieldErrors : error?.details?.errors;
        const mapped = {};
        for (const item of Array.isArray(list) ? list : []) {
          const name = /\.(url|format|minSeverity|secret)$/.exec(String(item.field))?.[1];
          if (name && !mapped[name]) mapped[name] = item;
        }
        setErrors(mapped);
        setProblem(describeError(error, i18n));
      }
      setBusy(false);
    }
  }

  const footer = html`
    <${Button} onClick=${onClose} disabled=${busy} testid="alerts.hook.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} disabled=${!draft.url.trim()} onClick=${save} testid="alerts.hook.save">${t("obs.al.hook.save")}<//>`;
  return html`<${Drawer} open=${true} title=${hook ? t("obs.al.hook.editTitle") : t("obs.al.hook.newTitle")} width=${480} onClose=${onClose} footer=${footer} testid="alerts.hook.drawer">
    <form class="stack" noValidate onSubmit=${(event) => { event.preventDefault(); if (draft.url.trim() && !busy) save(); }}>
      <${FormField} id="alerts-hook-url" label=${t("obs.al.hook.url")} hint=${t("obs.al.hook.urlHint")} error=${message("url")}>
        ${(props) => html`<input ...${props} class="input mono" type="text" autocomplete="off" spellcheck="false" value=${draft.url} data-testid="alerts.hook.url" onInput=${(event) => setDraft((current) => ({ ...current, url: event.currentTarget.value }))} />`}
      <//>
      <${FormField} id="alerts-hook-format" label=${t("obs.al.hook.format")} error=${message("format")}>
        ${(props) => html`<select ...${props} class="select" value=${draft.format} data-testid="alerts.hook.format" onChange=${(event) => setDraft((current) => ({ ...current, format: event.currentTarget.value }))}>
          ${WEBHOOK_FORMATS.map((item) => html`<option key=${item} value=${item} selected=${item === draft.format}>${t(tk("obs.alert.format.", item))}</option>`)}</select>`}
      <//>
      <${FormField} id="alerts-hook-severity" label=${t("obs.al.hook.minSeverity")} error=${message("minSeverity")}>
        ${(props) => html`<select ...${props} class="select" value=${draft.minSeverity} data-testid="alerts.hook.minSeverity" onChange=${(event) => setDraft((current) => ({ ...current, minSeverity: event.currentTarget.value }))}>
          ${SEVERITIES.map((item) => html`<option key=${item} value=${item} selected=${item === draft.minSeverity}>${t(tk("obs.severity.", item))}</option>`)}</select>`}
      <//>
      <${FormField} id="alerts-hook-secret" label=${t("obs.al.hook.secret")} hint=${hook?.secret?.set ? t("obs.al.hook.secretSet") : t("obs.al.hook.secretHint")} error=${message("secret")}>
        ${(props) => html`<input ...${props} class="input" type="password" autocomplete="new-password" value=${draft.secret} data-testid="alerts.hook.secret" onInput=${(event) => setDraft((current) => ({ ...current, secret: event.currentTarget.value }))} />`}
      <//>
      ${problem ? html`<p class="notice notice-danger" role="alert" data-testid="alerts.hook.problem">${problem}</p>` : null}
    </form>
  <//>`;
}

export function ChannelsTab({ rules }) {
  const { api, cache } = useServices();
  const i18n = useT();
  const { t, has } = i18n;
  const notify = useNotify();
  const settings = useQuery(["telemetry", "settings"], () => api.get("/api/telemetry/settings"), { ttlMs: 5000 });
  const [results, setResults] = useState({});
  const [testing, setTesting] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const toastChannel = rules.data?.toastChannel || "no_subscriber";

  async function runTest(key, body) {
    setTesting(key);
    try {
      const answer = await api.post("/api/telemetry/alerts/test", body);
      setResults((current) => ({ ...current, [key]: { delivered: answer?.delivered === true, error: answer?.error || null } }));
    } catch (error) {
      setResults((current) => ({ ...current, [key]: { delivered: false, error: error?.code || "error", message: describeError(error, i18n) } }));
    } finally {
      setTesting(null);
    }
  }
  const reload = () => {
    cache.invalidate(["telemetry", "settings"]);
    settings.refetch();
  };
  const button = (key, body, testid) => html`<${Button} size="sm" busy=${testing === key} onClick=${() => runTest(key, body)} testid=${testid}>${t("obs.al.test.send")}<//>`;

  return html`<div class="stack">
    <${Card} title=${t("obs.al.channels.local")} testid="alerts.channels.local">
      <ul class="stack-sm">
        <li class="stack-sm" data-channel="inapp" data-testid="alerts.channel">
          <div class="row"><strong class="grow">${t("obs.alert.channel.inapp")}</strong>${button("inapp", { channel: "inapp" }, "alerts.test.inapp")}</div>
          <${TestResult} result=${results.inapp} />
        </li>
        <li class="stack-sm" data-channel="toast" data-testid="alerts.channel">
          <div class="row"><strong class="grow">${t("obs.alert.channel.toast")}</strong>
            <${StatusBadge} status=${toastChannel === "available" ? "ok" : "warn"} label=${has(tk("obs.alert.toast.", toastChannel)) ? t(tk("obs.alert.toast.", toastChannel)) : toastChannel} testid="alerts.toast-channel" />
            ${button("toast", { channel: "toast" }, "alerts.test.toast")}</div>
          <${TestResult} result=${results.toast} />
        </li>
      </ul>
    <//>
    <${Card} title=${t("obs.al.channels.webhooks")} actions=${html`<${Button} size="sm" variant="primary" icon="plus" onClick=${() => setEditing({ hook: null })} disabled=${!settings.data} testid="alerts.hook.new">${t("obs.al.hook.new")}<//>`} testid="alerts.channels.webhooks">
      <${Load} query=${settings} rows=${2}>${(data) => {
        const hooks = Array.isArray(data.alerts?.webhooks) ? data.alerts.webhooks : [];
        return html`<div class="stack-sm">
          ${hooks.length ? html`<ul class="stack-sm" data-testid="alerts.hooks">${hooks.map((hook) => html`<li class="stack-sm" key=${hook.id} data-hook=${hook.id} data-testid="alerts.hook">
            <div class="row"><span class="grow"><span class="mono small" data-user-content>${hook.url}</span>
              <span class="badge badge-neutral">${t(tk("obs.alert.format.", hook.format))}</span> <span class="small muted">${t("obs.al.hook.from", { severity: t(tk("obs.severity.", hook.minSeverity)) })}</span>
              ${hook.secret?.set ? html`<span class="small muted"> · ${t("obs.al.hook.signed")}</span>` : null}</span>
              ${button(hook.id, { channel: "webhook", webhookId: hook.id }, "alerts.test.webhook")}
              <${Button} size="sm" onClick=${() => setEditing({ hook })} testid="alerts.hook.edit">${t("obs.al.rule.edit")}<//>
              <${Button} size="sm" variant="danger" onClick=${() => setRemoving(hook)} testid="alerts.hook.remove">${t("obs.al.hook.remove")}<//></div>
            <${TestResult} result=${results[hook.id]} />
          </li>`)}</ul>`
            : html`<${EmptyState} icon="link" title=${t("obs.al.hook.empty")} body=${t("obs.al.hook.emptyBody")} action=${{ label: t("obs.al.hook.new"), onClick: () => setEditing({ hook: null }) }} testid="alerts.hooks.empty" />`}
          ${editing ? html`<${WebhookDrawer} hook=${editing.hook} settings=${data} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reload(); }} />` : null}
          <${ConfirmDialog} open=${Boolean(removing)} tone="danger" title=${t("obs.al.hook.removeTitle")} body=${t("obs.al.hook.removeBody")} confirmLabel=${t("obs.al.hook.remove")}
            onConfirm=${async () => {
              await api.put("/api/telemetry/settings", { alerts: { webhooks: hooks.filter((hook) => hook.id !== removing.id).map((hook) => ({ id: hook.id, url: hook.url, format: hook.format, minSeverity: hook.minSeverity })) } }, { headers: { "if-match": data.etag } });
              notify("success", t("obs.al.hook.removed"));
              reload();
            }} onClose=${() => setRemoving(null)} testid="alerts.hook.remove-dialog" />
        </div>`;
      }}<//>
    <//>
  </div>`;
}

