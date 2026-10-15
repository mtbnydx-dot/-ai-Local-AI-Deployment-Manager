// Alerts `/alerts` (owner; 07 §6.9, 04 §13.4): Firing, History, Rules and
// Channels as ?tab=firing|history|rules|channels.
//
// Ack and Silence post the row's `scopeKey` (one rule fires per scope, so a
// bare rule id would act on the wrong rows). A builtin rule offers Disable and
// Enable, never Delete; the server answers a delete of one with 409
// `builtin_rule`. The rule drawer shows the writer's `errors[]` under their
// fields. `alerts` events invalidate the ["alerts"] cache keys (lib/events.js),
// which refreshes every list here; `notification` events reach the bell through

import { describeError } from "../lib/api.js";
import { tk } from "../lib/i18n.js";
import { localizedTitle } from "../lib/observability-model.js";
import { ackBody, alertPath, rowKey, silenceBody, SILENCE_PRESETS, silenceUntil, sortFiring, TABS } from "../lib/alerts-model.js";
import { Button } from "../components/button.js";
import { Card } from "../components/card.js";
import { Dialog } from "../components/dialog.js";
import { EmptyState } from "../components/empty-state.js";
import { FormField } from "../components/form-field.js";
import { PageHeader } from "../components/page-header.js";
import { StatusBadge } from "../components/status-badge.js";
import { Tabs } from "../components/tabs.js";
import { useServices } from "../ui/context.js";
import { useFormat, useQuery, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useState } from "../ui/vendor.js";
import { Load, SeverityBadge, Time, useNotify } from "./alerts/common.js";
import { LazyView } from "./observability/lazy.js";

const loadRules = () => import("./alerts/rules.js");
const loadChannels = () => import("./alerts/channels.js");

// ---------------------------------------------------------------------------
// Firing

function SilenceDialog({ row, onClose, onDone }) {
  const { api } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const notify = useNotify();
  const [choice, setChoice] = useState("1h");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const picked = silenceUntil(choice, custom);

  async function send(until) {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(alertPath(row.ruleId, "silence"), silenceBody(row, until));
      notify("success", t(until ? "obs.al.silenced" : "obs.al.unsilenced"));
      onDone();
    } catch (error) {
      setProblem(describeError(error, i18n));
      setBusy(false);
    }
  }

  const footer = html`
    ${row.silencedUntil ? html`<${Button} onClick=${() => send(null)} disabled=${busy} testid="alerts.silence.clear">${t("obs.al.unsilence")}<//>` : null}
    <${Button} onClick=${onClose} disabled=${busy} testid="alerts.silence.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} disabled=${!picked.until} onClick=${() => send(picked.until)} testid="alerts.silence.confirm">${t("obs.al.silence")}<//>`;
  return html`<${Dialog} open=${true} title=${t("obs.al.silenceTitle", { title: localizedTitle(row.title, i18n.locale) })} onClose=${onClose} dismissible=${!busy} footer=${footer} testid="alerts.silence.dialog">
    <p class="small muted">${t("obs.al.silenceBody", { scope: row.scopeKey })}</p>
    <fieldset class="stack-sm" data-testid="alerts.silence.choices">
      <legend class="sr-only">${t("obs.al.silenceFor")}</legend>
      ${SILENCE_PRESETS.map((item) => html`<label class="check" key=${item.id}><input type="radio" name="silence" value=${item.id} checked=${choice === item.id} onChange=${() => setChoice(item.id)} data-testid=${`alerts.silence.${item.id}`} /> ${t(tk("obs.alert.silence.", item.id))}</label>`)}
      <label class="check"><input type="radio" name="silence" value="custom" checked=${choice === "custom"} onChange=${() => setChoice("custom")} data-testid="alerts.silence.custom" /> ${t("obs.alert.silence.custom")}</label>
      ${choice === "custom" ? html`<${FormField} id="alerts-silence-until" label=${t("obs.al.silenceUntil")} error=${custom && picked.problem ? t(tk("obs.alert.silenceProblem.", picked.problem)) : undefined}>
        ${(props) => html`<input ...${props} class="input" type="datetime-local" value=${custom} onInput=${(event) => setCustom(event.currentTarget.value)} data-testid="alerts.silence.until" />`}
      <//>` : null}
    </fieldset>
    ${problem ? html`<p class="field-error" role="alert" data-testid="alerts.silence.error">${problem}</p>` : null}
  <//>`;
}

function FiringTab({ firing, toastChannel }) {
  const { api, cache } = useServices();
  const i18n = useT();
  const { t, locale } = i18n;
  const fmt = useFormat();
  const notify = useNotify();
  const [busyKey, setBusyKey] = useState(null);
  const [silencing, setSilencing] = useState(null);
  const refresh = () => cache.invalidate(["alerts"]);

  async function ack(row) {
    setBusyKey(rowKey(row));
    try {
      await api.post(alertPath(row.ruleId, "ack"), ackBody(row));
      notify("success", t("obs.al.acked"));
      refresh();
    } catch (error) {
      notify("error", null, error);
    } finally {
      setBusyKey(null);
    }
  }

  return html`<${Load} query=${firing}>${(data) => {
    const rows = sortFiring(data.rows);
    if (!rows.length) {
      return html`<${EmptyState} icon="circle-check" title=${t("obs.al.firingEmpty")} body=${t("obs.al.firingEmptyBody")} action=${{ label: t("obs.al.openRules"), href: "/alerts?tab=rules" }} testid="alerts.firing.empty" />`;
    }
    return html`<div class="stack-sm">
      ${data.degraded ? html`<p class="notice notice-warn" role="status" data-testid="alerts.degraded">${t("obs.al.degraded")}</p>` : null}
      <div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.alert.tab.firing") })}>
        <table class="table" data-testid="alerts.firing.table">
          <caption class="sr-only">${t("obs.alert.tab.firing")}</caption>
          <thead><tr><th scope="col">${t("obs.al.col.severity")}</th><th scope="col">${t("obs.al.col.alert")}</th><th scope="col">${t("obs.al.col.scope")}</th><th scope="col">${t("obs.al.col.value")}</th><th scope="col">${t("obs.al.col.since")}</th><th scope="col">${t("obs.al.col.status")}</th><th scope="col">${t("obs.al.col.actions")}</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr key=${rowKey(row)} data-rule=${row.ruleId} data-scope=${row.scopeKey} data-severity=${row.severity} data-testid="alerts.firing.row">
            <td><${SeverityBadge} severity=${row.severity} /></td>
            <td data-user-content>${localizedTitle(row.title, locale)}</td>
            <td><span class="mono small">${row.scopeKey}</span></td>
            <td>${row.value === null || row.value === undefined ? "—" : fmt.number(row.value)} <span class="muted small">/ ${fmt.number(row.threshold)}</span></td>
            <td><${Time} value=${row.since} /></td>
            <td><div class="row">
              ${row.ackedAt ? html`<${StatusBadge} status="neutral" label=${t("obs.al.ackedBadge")} testid="alerts.acked" />` : null}
              ${row.silencedUntil ? html`<${StatusBadge} status="neutral" label=${t("obs.al.silencedUntil", { when: fmt.dateTime(row.silencedUntil) })} testid="alerts.silenced" />` : null}
            </div></td>
            <td><div class="row">
              <${Button} size="sm" busy=${busyKey === rowKey(row)} disabled=${Boolean(row.ackedAt)} onClick=${() => ack(row)} testid="alerts.ack">${t("obs.al.ack")}<//>
              <${Button} size="sm" onClick=${() => setSilencing(row)} testid="alerts.silence">${t("obs.al.silence")}<//>
            </div></td>
          </tr>`)}</tbody>
        </table>
      </div>
      ${toastChannel === "no_subscriber" ? html`<p class="small muted" data-testid="alerts.toast-note">${t("obs.al.toast.no_subscriber")}</p>` : null}
      ${silencing ? html`<${SilenceDialog} row=${silencing} onClose=${() => setSilencing(null)} onDone=${() => { setSilencing(null); refresh(); }} />` : null}
    </div>`;
  }}<//>`;
}

// ---------------------------------------------------------------------------
// History

function HistoryTab() {
  const { api } = useServices();
  const { t, locale } = useT();
  const fmt = useFormat();
  const history = useQuery(["alerts", "history"], () => api.get("/api/telemetry/alerts", { query: { state: "all", limit: 200 } }), { ttlMs: 10_000, refetchMs: 30_000 });
  const events = useQuery(["alerts", "events"], () => api.get("/api/telemetry/events", { query: { type: "alert.", limit: 50 } }), { ttlMs: 10_000, refetchMs: 30_000 });
  return html`<div class="stack">
    <${Card} title=${t("obs.al.history.states")} testid="alerts.history.states">
      <${Load} query=${history}>${(data) => (Array.isArray(data.rows) && data.rows.length
        ? html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.al.history.states") })}><table class="table" data-testid="alerts.history.table">
          <caption class="sr-only">${t("obs.al.history.states")}</caption>
          <thead><tr><th scope="col">${t("obs.al.col.severity")}</th><th scope="col">${t("obs.al.col.alert")}</th><th scope="col">${t("obs.al.col.scope")}</th><th scope="col">${t("obs.al.col.state")}</th><th scope="col">${t("obs.al.col.since")}</th><th scope="col">${t("obs.al.col.resolved")}</th></tr></thead>
          <tbody>${data.rows.map((row) => html`<tr key=${rowKey(row)} data-state=${row.state} data-testid="alerts.history.row">
            <td><${SeverityBadge} severity=${row.severity} /></td><td data-user-content>${localizedTitle(row.title, locale)}</td><td><span class="mono small">${row.scopeKey}</span></td>
            <td>${t(tk("obs.alert.state.", row.state))}</td><td><${Time} value=${row.since} /></td><td><${Time} value=${row.resolvedAt} /></td>
          </tr>`)}</tbody></table></div>`
        : html`<p class="muted" data-testid="alerts.history.empty">${t("obs.al.history.empty")}</p>`)}<//>
    <//>
    <${Card} title=${t("obs.al.history.events")} testid="alerts.history.events">
      <${Load} query=${events} rows=${3}>${(data) => (Array.isArray(data.rows) && data.rows.length
        ? html`<ul class="stack-sm" data-testid="alerts.events">${data.rows.map((event) => html`<li key=${event.id} data-testid="alerts.event">
          <${SeverityBadge} severity=${event.severity} /> <span data-user-content>${localizedTitle(event.title, locale)}</span> <span class="muted small">${fmt.dateTime(event.at)}</span></li>`)}</ul>`
        : html`<p class="muted" data-testid="alerts.events.empty">${t("obs.al.history.eventsEmpty")}</p>`)}<//>
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------
// Page

export default function Alerts() {
  const { api, cache } = useServices();
  const { t } = useT();
  const firing = useQuery(["alerts", "firing"], () => api.get("/api/telemetry/alerts", { query: { state: "firing" } }), { ttlMs: 10_000, refetchMs: 30_000 });
  const rules = useQuery(["alerts", "rules"], () => api.get("/api/telemetry/alert-rules"), { ttlMs: 10_000, refetchMs: 60_000 });
  const count = firing.data ? sortFiring(firing.data.rows).length : undefined;
  const tabs = TABS.map((id) => ({ id, label: t(tk("obs.alert.tab.", id)), badge: id === "firing" && count ? count : undefined }));
  return html`<div class="stack" data-testid="alerts.page">
    <${PageHeader} title=${t("shell.nav.alerts")} subtitle=${t("obs.al.subtitle")} />
    <${Tabs} tabs=${tabs} label=${t("shell.nav.alerts")} testid="alerts.tabs" renderPanel=${(id) => {
      if (id === "history") return html`<${HistoryTab} />`;
      if (id === "rules") return html`<${LazyView} load=${loadRules} name="RulesTab" rules=${rules} onChanged=${() => cache.invalidate(["alerts"])} />`;
      if (id === "channels") return html`<${LazyView} load=${loadChannels} name="ChannelsTab" rules=${rules} />`;
      return html`<${FiringTab} firing=${firing} toastChannel=${firing.data?.toastChannel} />`;
    }} />
  </div>`;
}

