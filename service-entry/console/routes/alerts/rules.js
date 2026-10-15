// Alerts › Rules (07 §6.9): the rule table, the rule drawer with the
// writer's errors under their fields, Disable or Enable for every rule and
// Delete for custom rules only (a builtin rule is never offered Delete).

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { localizedTitle } from "../../lib/observability-model.js";
import { BUILTIN_EDITABLE, CHANNELS, NUMBER_FIELDS, OPS, ruleBody, ruleDraft, SCOPE_BOOL, scopeFilters, SEVERITIES, splitErrors } from "../../lib/alerts-model.js";
import { Button } from "../../components/button.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Drawer } from "../../components/drawer.js";
import { FormField } from "../../components/form-field.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { Load, metricLabel, ruleTitle, SeverityBadge, unitLabel, useNotify } from "./common.js";

function conditionText(rule, metrics, i18n, fmt) {
  const info = metrics.find((item) => item.id === rule.metric);
  const unit = unitLabel(i18n, info?.unit);
  const text = `${metricLabel(metrics, rule.metric, i18n.locale)} ${rule.op} ${fmt.number(rule.threshold)}${unit ? ` ${unit}` : ""}`;
  return rule.forS ? `${text} · ${i18n.t("obs.al.forDuration", { n: rule.forS })}` : text;
}

function CheckList({ name, values, options, onChange, labelOf, disabled }) {
  return html`<div class="row" data-testid=${`alerts.rule.${name}`}>${options.map((option) => html`<label class="check" key=${option}>
    <input type="checkbox" disabled=${disabled} checked=${values.includes(option)} data-testid=${`alerts.rule.${name}.${option}`}
      onChange=${(event) => onChange(event.currentTarget.checked ? [...values, option] : values.filter((item) => item !== option))} /> ${labelOf(option)}</label>`)}</div>`;
}

function RuleDrawer({ rule, metrics, onClose, onSaved }) {
  const { api } = useServices();
  const i18n = useT();
  const { t, has, locale } = i18n;
  const notify = useNotify();
  const builtin = Boolean(rule?.builtin);
  const [draft, setDraft] = useState(() => ruleDraft(rule, metrics));
  const [server, setServer] = useState({ byField: {}, other: [] });
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const info = metrics.find((item) => item.id === draft.metric);
  const filters = scopeFilters(info);
  const result = ruleBody(draft, rule);
  const set = (name, value) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setServer((current) => ({ ...current, byField: { ...current.byField, [name]: undefined } }));
  };
  const locked = (name) => (builtin && !BUILTIN_EDITABLE.includes(name) ? { reason: t("obs.al.rule.builtinLocked") } : undefined);
  const known = [...NUMBER_FIELDS, "metric", "op", "severity", "channels", "enabled", "titleZh", "titleEn", "scope"];
  const errorOf = (name) => {
    const code = result.local[name];
    const item = server.byField[name];
    if (code) return t(tk("obs.alert.err.", code));
    if (!item) return undefined;
    const key = tk("obs.alert.err.", item.code);
    return has(key) ? t(key) : item.message || item.code;
  };
  const scopeError = () => {
    const key = Object.keys(server.byField).find((field) => field.startsWith("scope"));
    const item = key ? server.byField[key] : null;
    return item ? `${key.replace(/^scope\./, "")}: ${has(tk("obs.alert.err.", item.code)) ? t(tk("obs.alert.err.", item.code)) : item.message || item.code}` : undefined;
  };

  async function save() {
    if (busy || !result.changed || Object.keys(result.local).length) return;
    setBusy(true);
    setProblem(null);
    try {
      if (rule) await api.put(`/api/telemetry/alert-rules/${encodeURIComponent(rule.ruleId)}`, result.body);
      else await api.post("/api/telemetry/alert-rules", result.body);
      notify("success", t("obs.al.rule.saved"));
      onSaved();
    } catch (error) {
      if (error?.status === 400 || error?.fieldErrors?.length) {
        setServer(splitErrors(error.fieldErrors?.length ? error.fieldErrors : error.details?.errors, known));
        setProblem(describeError(error, i18n));
      } else {
        setProblem(describeError(error, i18n));
      }
      setBusy(false);
    }
  }

  const numberField = (name, label, extra = {}) => html`<${FormField} id=${`alerts-rule-${name}`} label=${label} unit=${extra.unit} hint=${extra.hint} error=${errorOf(name)} locked=${locked(name)} testid=${`alerts.rule.${name}.field`}>
    ${(props) => html`<input ...${props} class="input" type="text" inputmode="decimal" autocomplete="off" value=${draft[name]} data-testid=${`alerts.rule.${name}`} onInput=${(event) => set(name, event.currentTarget.value)} />`}
  <//>`;
  const unit = unitLabel(i18n, info?.unit);
  const footer = html`
    <${Button} onClick=${onClose} disabled=${busy} testid="alerts.rule.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} disabled=${!result.changed || Boolean(Object.keys(result.local).length)} onClick=${save} testid="alerts.rule.save">${t("obs.al.rule.save")}<//>`;
  return html`<${Drawer} open=${true} title=${rule ? t("obs.al.rule.editTitle", { title: ruleTitle(rule, locale) }) : t("obs.al.rule.newTitle")} width=${640} onClose=${onClose} footer=${footer} testid="alerts.rule.drawer">
    <form class="stack" noValidate onSubmit=${(event) => { event.preventDefault(); save(); }} data-testid="alerts.rule.form">
      ${builtin ? html`<p class="notice notice-info" role="status" data-testid="alerts.rule.builtin-note">${t("obs.al.rule.builtinNote")}</p>` : null}
      <${FormField} id="alerts-rule-metric" label=${t("obs.al.rule.metric")} error=${errorOf("metric")} locked=${locked("metric")} testid="alerts.rule.metric.field">
        ${(props) => html`<select ...${props} class="select" value=${draft.metric} data-testid="alerts.rule.metric"
          onChange=${(event) => setDraft((current) => ({ ...current, metric: event.currentTarget.value, scope: {} }))}>
          ${metrics.map((item) => html`<option key=${item.id} value=${item.id} selected=${item.id === draft.metric}>${localizedTitle(item.label, locale)} (${item.id})</option>`)}</select>`}
      <//>
      ${filters.length ? html`<fieldset class="stack-sm" data-testid="alerts.rule.scope">
        <legend>${t("obs.al.rule.scope")}</legend>
        <p class="small muted">${t("obs.al.rule.scopeHint")}</p>
        ${filters.map((name) => (SCOPE_BOOL.has(name)
          ? html`<label class="check" key=${name}><input type="checkbox" disabled=${Boolean(locked("scope"))} checked=${draft.scope[name] === true || draft.scope[name] === "true"} data-testid=${`alerts.rule.scope.${name}`}
            onChange=${(event) => setDraft((current) => ({ ...current, scope: { ...current.scope, [name]: event.currentTarget.checked } }))} /> ${t(tk("obs.alert.scope.", name))}</label>`
          : html`<${FormField} key=${name} id=${`alerts-rule-scope-${name}`} label=${t(tk("obs.alert.scope.", name))} locked=${locked("scope")}>
            ${(props) => html`<input ...${props} class="input" type="text" autocomplete="off" spellcheck="false" value=${draft.scope[name] ?? ""} data-testid=${`alerts.rule.scope.${name}`}
              onInput=${(event) => setDraft((current) => ({ ...current, scope: { ...current.scope, [name]: event.currentTarget.value } }))} />`}
          <//>`))}
        ${scopeError() ? html`<p class="field-error" role="alert" data-testid="alerts.rule.scope.error">${scopeError()}</p>` : null}
      </fieldset>` : null}
      <div class="obs-form-grid">
        <${FormField} id="alerts-rule-op" label=${t("obs.al.rule.op")} error=${errorOf("op")} locked=${locked("op")}>
          ${(props) => html`<select ...${props} class="select" value=${draft.op} data-testid="alerts.rule.op" onChange=${(event) => set("op", event.currentTarget.value)}>
            ${OPS.map((op) => html`<option key=${op} value=${op} selected=${op === draft.op}>${op}</option>`)}</select>`}
        <//>
        ${numberField("threshold", t("obs.al.rule.threshold"), { unit })}
        ${numberField("clearThreshold", t("obs.al.rule.clearThreshold"), { unit, hint: t("obs.al.rule.clearHint") })}
        ${numberField("windowS", t("obs.al.rule.window"), { unit: t("obs.unit.s") })}
        ${numberField("forS", t("obs.al.rule.for"), { unit: t("obs.unit.s") })}
        ${numberField("minSamples", t("obs.al.rule.minSamples"))}
        ${numberField("cooldownS", t("obs.al.rule.cooldown"), { unit: t("obs.unit.s") })}
        <${FormField} id="alerts-rule-severity" label=${t("obs.al.rule.severity")} error=${errorOf("severity")} locked=${locked("severity")}>
          ${(props) => html`<select ...${props} class="select" value=${draft.severity} data-testid="alerts.rule.severity" onChange=${(event) => set("severity", event.currentTarget.value)}>
            ${SEVERITIES.map((item) => html`<option key=${item} value=${item} selected=${item === draft.severity}>${t(tk("obs.severity.", item))}</option>`)}</select>`}
        <//>
      </div>
      <${FormField} id="alerts-rule-channels" label=${t("obs.al.rule.channels")} error=${errorOf("channels")} locked=${locked("channels")}>
        ${() => html`<${CheckList} name="channels" values=${draft.channels} options=${CHANNELS} labelOf=${(item) => t(tk("obs.alert.channel.", item))} onChange=${(next) => set("channels", next)} disabled=${Boolean(locked("channels"))} />`}
      <//>
      <div class="obs-form-grid">
        <${FormField} id="alerts-rule-titleZh" label=${t("obs.al.rule.titleZh")} hint=${t("obs.al.rule.titleHint")} error=${errorOf("titleZh")} locked=${locked("titleZh")}>
          ${(props) => html`<input ...${props} class="input" type="text" maxlength="120" value=${draft.titleZh} data-testid="alerts.rule.titleZh" onInput=${(event) => set("titleZh", event.currentTarget.value)} />`}
        <//>
        <${FormField} id="alerts-rule-titleEn" label=${t("obs.al.rule.titleEn")} error=${errorOf("titleEn")} locked=${locked("titleEn")}>
          ${(props) => html`<input ...${props} class="input" type="text" maxlength="120" value=${draft.titleEn} data-testid="alerts.rule.titleEn" onInput=${(event) => set("titleEn", event.currentTarget.value)} />`}
        <//>
      </div>
      <label class="check"><input type="checkbox" checked=${draft.enabled} data-testid="alerts.rule.enabled" onChange=${(event) => set("enabled", event.currentTarget.checked)} /> ${t("obs.al.rule.enabled")}</label>
      ${problem ? html`<p class="notice notice-danger" role="alert" data-testid="alerts.rule.problem">${problem}</p>` : null}
      ${server.other.length ? html`<ul class="field-error" role="alert" data-testid="alerts.rule.other">${server.other.map((item, index) => html`<li key=${index}><span class="mono">${item.field}</span> ${item.message || item.code}</li>`)}</ul>` : null}
    </form>
  <//>`;
}

export function RulesTab({ rules, onChanged }) {
  const { api } = useServices();
  const i18n = useT();
  const { t, locale } = i18n;
  const fmt = useFormat();
  const notify = useNotify();
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function toggle(rule) {
    setBusyId(rule.ruleId);
    try {
      await api.put(`/api/telemetry/alert-rules/${encodeURIComponent(rule.ruleId)}`, { enabled: !rule.enabled });
      notify("success", t(rule.enabled ? "obs.al.rule.disabledDone" : "obs.al.rule.enabledDone"));
      onChanged();
    } catch (error) {
      notify("error", null, error);
    } finally {
      setBusyId(null);
    }
  }

  return html`<${Load} query=${rules}>${(data) => {
    const list = Array.isArray(data.rules) ? data.rules : [];
    const metrics = Array.isArray(data.metrics) ? data.metrics : [];
    return html`<div class="stack-sm">
      <div class="row"><span class="grow small muted">${t("obs.al.rule.count", { n: list.length })}</span>
        <${Button} variant="primary" icon="plus" onClick=${() => setEditing({ rule: null })} disabled=${!metrics.length} testid="alerts.rule.new">${t("obs.al.rule.new")}<//></div>
      <div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.alert.tab.rules") })}>
        <table class="table" data-testid="alerts.rules.table">
          <caption class="sr-only">${t("obs.alert.tab.rules")}</caption>
          <thead><tr><th scope="col">${t("obs.al.col.rule")}</th><th scope="col">${t("obs.al.col.condition")}</th><th scope="col">${t("obs.al.col.severity")}</th><th scope="col">${t("obs.al.col.channels")}</th><th scope="col">${t("obs.al.col.status")}</th><th scope="col">${t("obs.al.col.actions")}</th></tr></thead>
          <tbody>${list.map((rule) => html`<tr key=${rule.ruleId} data-rule=${rule.ruleId} data-builtin=${rule.builtin ? "true" : "false"} data-enabled=${rule.enabled ? "true" : "false"} data-testid="alerts.rule.row">
            <td><span data-user-content>${ruleTitle(rule, locale)}</span> ${rule.builtin ? html`<span class="badge badge-neutral">${t("obs.al.rule.builtin")}</span>` : null}</td>
            <td class="small">${conditionText(rule, metrics, i18n, fmt)}</td>
            <td><${SeverityBadge} severity=${rule.severity} /></td>
            <td class="small">${(rule.channels || []).map((item) => t(tk("obs.alert.channel.", item))).join(", ") || "—"}</td>
            <td><${StatusBadge} status=${rule.enabled ? "ok" : "neutral"} label=${t(rule.enabled ? "obs.al.rule.on" : "obs.al.rule.off")} /></td>
            <td><div class="row">
              <${Button} size="sm" onClick=${() => setEditing({ rule })} testid="alerts.rule.edit">${t("obs.al.rule.edit")}<//>
              <${Button} size="sm" busy=${busyId === rule.ruleId} onClick=${() => toggle(rule)} testid=${rule.enabled ? "alerts.rule.disable" : "alerts.rule.enable"}>${t(rule.enabled ? "obs.al.rule.disable" : "obs.al.rule.enable")}<//>
              ${rule.builtin ? null : html`<${Button} size="sm" variant="danger" onClick=${() => setDeleting(rule)} testid="alerts.rule.delete">${t("obs.al.rule.delete")}<//>`}
            </div></td>
          </tr>`)}</tbody>
        </table>
      </div>
      ${editing ? html`<${RuleDrawer} rule=${editing.rule} metrics=${metrics} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); onChanged(); }} />` : null}
      <${ConfirmDialog} open=${Boolean(deleting)} tone="danger" title=${t("obs.al.rule.deleteTitle")} body=${t("obs.al.rule.deleteBody", { title: deleting ? ruleTitle(deleting, locale) : "" })}
        confirmLabel=${t("obs.al.rule.delete")} onConfirm=${async () => { await api.del(`/api/telemetry/alert-rules/${encodeURIComponent(deleting.ruleId)}`); notify("success", t("obs.al.rule.deleted")); onChanged(); }}
        onClose=${() => setDeleting(null)} testid="alerts.rule.delete-dialog" />
    </div>`;
  }}<//>`;
}

