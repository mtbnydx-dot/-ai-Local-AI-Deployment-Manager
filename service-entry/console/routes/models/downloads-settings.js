// The global download settings Drawer (07 §6.4 "Downloads", 03 §14): sources and
// the mirror, Xet, SHA256 verification, retry per error class, concurrency,
// idle-only and notifications. GET /api/hub/settings fills it and
// PUT /api/hub/settings {settings: patch} saves only the fields that changed;
// the hub's per-field errors (400 `settings_invalid`) show under their field.
// Loaded when the Drawer is first opened (downloads.js).

import { describeError } from "../../lib/api.js";
import { SETTINGS_FIELDS, settingsForm, settingsPatch } from "../../lib/downloads-model.js";
import { Button } from "../../components/button.js";
import { Drawer } from "../../components/drawer.js";
import { FormField } from "../../components/form-field.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

const GROUPS = Object.freeze(["sources", "transfer", "queue", "retry", "notify"]);

function Control({ field, value, onChange, props }) {
  const { t, tk } = useT();
  if (field.kind === "select") {
    return html`<select ...${props} class="select" value=${value} data-testid=${`settings.${field.path}`} onChange=${(event) => onChange(event.currentTarget.value)}>
      ${field.options.map((option) => html`<option key=${option} value=${option} selected=${value === option}>${t(tk("hub.settings.opt.", option))}</option>`)}</select>`;
  }
  if (field.kind === "number") {
    return html`<input ...${props} class="input" type="number" min=${field.min} max=${field.max} step="1" value=${value} data-testid=${`settings.${field.path}`}
      onInput=${(event) => onChange(event.currentTarget.value)} />`;
  }
  return html`<input ...${props} class="input" type="text" value=${value} data-testid=${`settings.${field.path}`} autocomplete="off" onInput=${(event) => onChange(event.currentTarget.value)} />`;
}

export default function DownloadSettings({ onClose }) {
  const { api, cache, toasts, i18n } = useServices();
  const { t, tk } = useT();
  const query = useQuery(["hub", "settings"], () => api.get("/api/hub/settings"), { ttlMs: 1000 });
  const settings = query.data?.settings || null;
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings && !form) setForm(settingsForm(settings));
  }, [Boolean(settings)]);

  const patch = settings && form ? settingsPatch(settings, form) : {};
  const changed = Object.keys(patch).length > 0;

  async function save() {
    setBusy(true);
    setErrors({});
    setFailure("");
    try {
      const result = await api.put("/api/hub/settings", { settings: patch });
      cache.invalidate(["hub", "settings"]);
      toasts?.push?.({ level: "success", title: t("hub.settings.saved") });
      if (result?.settings) setForm(settingsForm(result.settings));
      onClose?.();
    } catch (error) {
      const byField = {};
      for (const item of error?.fieldErrors || []) if (item?.field) byField[item.field] = item.message || item.code;
      setErrors(byField);
      setFailure(Object.keys(byField).length ? t("hub.settings.invalid") : describeError(error, i18n));
    } finally {
      setBusy(false);
    }
  }

  const footer = html`<${Button} variant="ghost" onClick=${onClose} testid="settings.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} disabled=${!changed} onClick=${save} testid="settings.save">${t("hub.settings.save")}<//>`;
  let content;
  if (query.error && !settings) {
    content = html`<div class="notice notice-danger" role="alert" data-testid="settings.error"><span class="grow">${describeError(query.error, i18n)}</span>
      <${Button} size="sm" onClick=${() => query.refetch()}>${t("hub.library.retry")}<//></div>`;
  } else if (!settings || !form) {
    content = html`<div aria-busy="true"><${Skeleton} shape="line" rows=${6} /></div>`;
  } else {
    content = html`<div class="stack" data-testid="settings">
      ${failure ? html`<div class="notice notice-danger" role="alert" data-testid="settings.failure">${failure}</div>` : null}
      ${GROUPS.map((group) => html`<fieldset key=${group} class="stack-sm plan-choices" data-testid=${`settings.group.${group}`}>
        <legend class="card-title">${t(tk("hub.settings.group.", group))}</legend>
        ${SETTINGS_FIELDS.filter((field) => field.group === group).map((field) => (field.kind === "checkbox"
          ? html`<label key=${field.path} class="row-nowrap"><input type="checkbox" checked=${form[field.path]} data-testid=${`settings.${field.path}`}
              onChange=${(event) => setForm({ ...form, [field.path]: event.currentTarget.checked })} /><span>${t(tk("hub.settings.", field.path))}</span></label>`
          : html`<${FormField} key=${field.path} label=${t(tk("hub.settings.", field.path))} error=${errors[field.path]} testid=${`settings.field.${field.path}`}>
              ${(props) => html`<${Control} field=${field} value=${form[field.path]} props=${props} onChange=${(value) => setForm({ ...form, [field.path]: value })} />`}<//>`))}
      </fieldset>`)}
    </div>`;
  }
  return html`<${Drawer} open=${true} title=${t("hub.settings.title")} width=${480} onClose=${onClose} footer=${footer} urlId="settings" testid="settings.drawer">${content}<//>`;
}
