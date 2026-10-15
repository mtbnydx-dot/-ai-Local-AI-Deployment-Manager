// Audit › Settings `/audit/settings` (07 §6.8, 04 §16.3, §16.5): the export
// schedule, the retention policy and whether search text is written to the
// access log (GET and PUT /api/audit/settings with If-Match). Only the fields
// that changed are sent; a stale etag asks for a reload, and the writer's
// `errors[]` show under their fields. Owner only; no audit unlock needed.

import { describeError } from "../../lib/api.js";
import { auditPath, SETTING_FIELDS, SETTING_GROUPS, serverSettingErrors, settingsDraft, settingsPatch } from "../../lib/audit-model.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { FormField } from "../../components/form-field.js";
import { AuditPage, LoadError, Loading, useAuditApi, useAuditLoad } from "./common.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

function Field({ path, draft, set, errors }) {
  const { t, has } = useT();
  const field = SETTING_FIELDS.find((item) => item.path === path);
  const label = t(tk("audit.set.", path));
  const code = errors[path];
  const error = code ? (has(tk("audit.set.error.", code)) ? t(tk("audit.set.error.", code), { min: String(field.min), max: String(field.max) }) : t("audit.set.error.invalid")) : null;
  const id = `audit-set-${path.replace(/\./g, "-")}`;
  const hint = has(tk("audit.set.hint.", path)) ? t(tk("audit.set.hint.", path)) : undefined;
  if (field.kind === "bool") {
    return html`<div class="field" key=${path}>
      <label class="check"><input type="checkbox" id=${id} checked=${Boolean(draft[path])} data-testid=${`audit.set.${path}`} onChange=${(event) => set(path, event.currentTarget.checked)} /> ${label}</label>
      ${hint ? html`<div class="field-hint">${hint}</div>` : null}
    </div>`;
  }
  return html`<${FormField} id=${id} label=${label} unit=${field.unit ? t(tk("audit.unit.", field.unit)) : undefined} error=${error} hint=${hint} testid=${`audit.set.${path}.field`}>
    ${(props) => html`<input ...${props} class="input" type="text" inputmode=${field.kind === "clock" ? "text" : "decimal"} autocomplete="off" spellcheck="false" maxlength=${field.kind === "clock" ? 5 : 8}
      placeholder=${field.kind === "clock" ? "HH:MM" : undefined} value=${draft[path]} data-testid=${`audit.set.${path}`} onInput=${(event) => set(path, event.currentTarget.value)} />`}
  <//>`;
}

function Form({ loaded }) {
  const { api, toasts, cache } = useServices();
  const audit = useAuditApi();
  const i18n = useT();
  const { t } = i18n;
  const settings = loaded.data;
  const [draft, setDraft] = useState(null);
  const [serverErrors, setServerErrors] = useState({ byPath: {}, other: [] });
  const [problem, setProblem] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) {
      setDraft(settingsDraft(settings));
      setServerErrors({ byPath: {}, other: [] });
    }
  }, [settings?.etag]);
  if (!draft) return null;

  const result = settingsPatch(settings, draft);
  const errors = { ...result.errors };
  for (const [path, code] of Object.entries(serverErrors.byPath)) if (code) errors[path] = code;
  const invalid = Object.values(errors).some(Boolean);
  const set = (path, value) => {
    setDraft((current) => ({ ...current, [path]: value }));
    setServerErrors((current) => ({ ...current, byPath: { ...current.byPath, [path]: undefined } }));
  };

  async function save() {
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      const answer = await api.put(auditPath("settings"), result.patch, { headers: { "if-match": settings.etag, ...audit.session.headers() } });
      setSaved({ restartRequired: Array.isArray(answer?.restartRequired) ? answer.restartRequired : [] });
      toasts?.push?.({ level: "success", title: t("audit.set.saved") });
      cache.invalidate(["audit"]);
      loaded.reload();
    } catch (error) {
      if (error?.status === 409 || error?.code === "etag_mismatch") setProblem({ kind: "conflict" });
      else if (error?.status === 400) {
        setServerErrors(serverSettingErrors(error.fieldErrors?.length ? error.fieldErrors : error.details?.errors));
        setProblem({ kind: "invalid", text: describeError(error, i18n) });
      } else setProblem({ kind: "error", text: describeError(error, i18n) });
    } finally {
      setBusy(false);
    }
  }

  return html`<form class="stack" data-testid="audit.settings.form" noValidate onSubmit=${(event) => {
    event.preventDefault();
    if (result.changed && !invalid && !busy) save();
  }}>
    ${SETTING_GROUPS.map((group) => html`<${Card} key=${group} title=${t(tk("audit.set.group.", group))} testid=${`audit.settings.group.${group}`}>
      <div class="obs-form-grid">${SETTING_FIELDS.filter((field) => field.group === group).map((field) => html`<${Field} key=${field.path} path=${field.path} draft=${draft} set=${set} errors=${errors} />`)}</div>
    <//>`)}
    ${problem?.kind === "conflict" ? html`<div class="notice notice-warn" role="alert" data-testid="audit.settings.conflict"><span class="grow">${t("obs.settings.conflict")}</span>
      <${Button} size="sm" onClick=${() => { setProblem(null); loaded.reload(); }} testid="audit.settings.reload">${t("obs.settings.reload")}<//></div>` : null}
    ${problem && problem.kind !== "conflict" ? html`<p class="notice notice-danger" role="alert" data-testid="audit.settings.problem">${problem.text}</p>` : null}
    ${serverErrors.other.length ? html`<ul class="field-error" role="alert" data-testid="audit.settings.other">${serverErrors.other.map((item, index) => html`<li key=${index}><span class="mono">${item.field}</span> ${item.message || item.code}</li>`)}</ul>` : null}
    ${saved ? html`<p class="notice notice-success" role="status" data-testid="audit.settings.saved">${t("audit.set.saved")}${saved.restartRequired.length ? ` ${t("obs.settings.restart", { items: saved.restartRequired.join(", ") })}` : ""}</p>` : null}
    <div class="row">
      <${Button} type="submit" variant="primary" busy=${busy} disabled=${!result.changed || invalid} testid="audit.settings.save">${t("obs.settings.save")}<//>
      <${Button} onClick=${() => { setDraft(settingsDraft(settings)); setServerErrors({ byPath: {}, other: [] }); setProblem(null); }} disabled=${!result.changed || busy} testid="audit.settings.discard">${t("obs.settings.discard")}<//>
    </div>
  </form>`;
}

function Body() {
  const audit = useAuditApi();
  const loaded = useAuditLoad(() => audit.get("settings"), []);
  if (loaded.error) return html`<${LoadError} error=${loaded.error} onRetry=${loaded.reload} />`;
  if (!loaded.data) return html`<${Loading} rows=${5} />`;
  return html`<${Form} loaded=${loaded} />`;
}

export default function AuditSettings() {
  return html`<${AuditPage} id="settings">${() => html`<${Body} />`}<//>`;
}
