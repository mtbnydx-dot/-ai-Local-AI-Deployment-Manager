// Observability › Settings `/observability/settings` (owner; 07 §6.7, 04
// §11.7, §20): collector status, retention, sampling and the energy tariff
// (GET and PUT /api/telemetry/settings with If-Match), and the history import,
// which always runs as a dry run first.
//
// Only the fields that changed are sent. A stale etag (409) asks for a reload,
// the writer's `errors[]` show under their fields, and `restartRequired` is
// said out loud. The webhook list belongs to Alerts and is never touched here.

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { FormField } from "../../components/form-field.js";
import { StatusBadge } from "../../components/status-badge.js";
import { ObsPage, QueryView, useObsState } from "./common.js";
import { LazyView } from "./lazy.js";
import { hasPrice, SETTING_FIELDS, SETTING_GROUPS, serverFieldErrors, settingsDraft, settingsPatch } from "../../lib/observability-settings-model.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

const loadImport = () => import("./settings-import.js");

const COLLECTOR_STATUS = { ok: "ok", idle: "ok", degraded: "warn", error: "error", disabled: "neutral" };

function errorText(i18n, code) {
  if (!code) return null;
  const key = tk("obs.settings.error.", code);
  return i18n.has(key) ? i18n.t(key) : i18n.t("obs.settings.error.invalid");
}

// ---------------------------------------------------------------------------
// Collector status

function StatusCard() {
  const { api } = useServices();
  const i18n = useT();
  const { t, has } = i18n;
  const fmt = useFormat();
  const query = useQuery(["telemetry", "status"], () => api.get("/api/telemetry/status"), { ttlMs: 5000, refetchMs: 15_000 });
  return html`<${Card} title=${t("obs.settings.status")} testid="obs.status-card">
    <p class="small muted" data-window=${t("obs.live.now")} data-testid="obs.panel.window">${t("obs.live.now")}</p>
    <${QueryView} query=${query}>${(data) => {
      const collectors = data.collectors && typeof data.collectors === "object" ? Object.entries(data.collectors) : [];
      const degraded = Array.isArray(data.degraded) ? data.degraded : [];
      return html`<div class="stack-sm">
        ${degraded.length ? html`<p class="notice notice-warn" role="status" data-testid="obs.status.degraded">${t("obs.settings.degraded", { items: degraded.join(", ") })}</p>` : null}
        <div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.tableOf", { title: t("obs.settings.status") })}>
          <table class="table" data-testid="obs.collectors">
            <caption class="sr-only">${t("obs.settings.status")}</caption>
            <thead><tr><th scope="col">${t("obs.col.collector")}</th><th scope="col">${t("obs.col.state")}</th><th scope="col">${t("obs.col.lastOk")}</th><th scope="col">${t("obs.col.lastError")}</th></tr></thead>
            <tbody>${collectors.map(([name, info]) => html`<tr key=${name} data-collector=${name} data-testid="obs.collector">
              <td>${has(tk("obs.collector.", name)) ? t(tk("obs.collector.", name)) : name}</td>
              <td><${StatusBadge} status=${COLLECTOR_STATUS[info?.state] || "unknown"} label=${has(tk("obs.collectorState.", String(info?.state))) ? t(tk("obs.collectorState.", String(info?.state))) : String(info?.state || "")} /></td>
              <td>${info?.lastOkAt ? html`<time dateTime=${info.lastOkAt} title=${fmt.dateTime(info.lastOkAt)}>${fmt.relative(info.lastOkAt)}</time>` : "—"}</td>
              <td><span class="mono small" data-user-content>${info?.lastError || "—"}</span></td>
            </tr>`)}</tbody>
          </table>
        </div>
        <dl class="obs-facts small">
          <div><dt>${t("obs.settings.dbSize")}</dt><dd>${Number.isFinite(data.dbBytes) ? fmt.bytes(data.dbBytes) : "—"}</dd></div>
          <div><dt>${t("obs.settings.dropped")}</dt><dd>${fmt.integer(data.recorder?.dropped ?? 0)}</dd></div>
          <div><dt>${t("obs.settings.lastRetention")}</dt><dd>${data.retention?.lastRunAt ? fmt.dateTime(data.retention.lastRunAt) : "—"}</dd></div>
        </dl>
      </div>`;
    }}<//>
  <//>`;
}

// ---------------------------------------------------------------------------
// Settings form

function Field({ path, draft, set, errors, i18n }) {
  const { t } = i18n;
  const field = SETTING_FIELDS.find((item) => item.path === path);
  const label = t(tk("obs.set.", path));
  const error = errorText(i18n, errors[path]);
  const id = `obs-set-${path.replace(/\./g, "-")}`;
  const unit = field.unit ? t(tk("obs.unit.", field.unit)) : undefined;
  if (field.kind === "bool") {
    return html`<div class="field" key=${path}>
      <label class="check"><input type="checkbox" id=${id} checked=${Boolean(draft[path])} data-testid=${`obs.set.${path}`} onChange=${(event) => set(path, event.currentTarget.checked)} /> ${label}</label>
      ${field.restart ? html`<div class="field-hint">${t("obs.settings.restartNote")}</div>` : null}
    </div>`;
  }
  return html`<${FormField} id=${id} label=${label} unit=${unit} error=${error} hint=${field.kind === "price" ? t("obs.settings.priceHint") : undefined} testid=${`obs.set.${path}.field`}>
    ${(props) => html`<input ...${props} class="input" type="text" inputmode=${field.kind === "currency" ? "text" : "decimal"} autocomplete="off" spellcheck="false"
      maxlength=${field.kind === "currency" ? 3 : 12} value=${draft[path]} data-testid=${`obs.set.${path}`} onInput=${(event) => set(path, event.currentTarget.value)} />`}
  <//>`;
}

function Tariffs({ draft, setDraft, errors, i18n }) {
  const { t } = i18n;
  const rows = draft.tariffs;
  const update = (index, name, value) => setDraft((current) => ({ ...current, tariffs: current.tariffs.map((row, at) => (at === index ? { ...row, [name]: value } : row)) }));
  return html`<fieldset class="obs-tariffs" data-testid="obs.tariffs">
    <legend>${t("obs.set.energy.tariffs")}</legend>
    <p class="small muted">${t("obs.settings.tariffHint")}</p>
    ${rows.map((row, index) => html`<div class="row obs-tariff" key=${index} data-testid="obs.tariff">
      ${["from", "to", "pricePerKwh"].map((name) => html`<${FormField} key=${name} id=${`obs-tariff-${index}-${name}`} label=${t(tk("obs.tariff.", name))} error=${errorText(i18n, errors[`energy.tariffs[${index}].${name}`])}>
        ${(props) => html`<input ...${props} class="input" type="text" inputmode=${name === "pricePerKwh" ? "decimal" : "numeric"} placeholder=${name === "pricePerKwh" ? "0.00" : "HH:MM"} value=${row[name]}
          data-testid=${`obs.tariff.${name}`} onInput=${(event) => update(index, name, event.currentTarget.value)} />`}
      <//>`)}
      <${Button} size="sm" variant="danger" label=${t("obs.tariff.removeFor", { n: index + 1 })} onClick=${() => setDraft((current) => ({ ...current, tariffs: current.tariffs.filter((_, at) => at !== index) }))} testid="obs.tariff.remove">${t("obs.tariff.remove")}<//>
    </div>`)}
    <${Button} size="sm" onClick=${() => setDraft((current) => ({ ...current, tariffs: [...current.tariffs, { from: "", to: "", pricePerKwh: "" }] }))} testid="obs.tariff.add">${t("obs.tariff.add")}<//>
  </fieldset>`;
}

function SettingsForm({ query }) {
  const { api, toasts, cache } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const settings = query.data;
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
  const set = (path, value) => {
    setDraft((current) => ({ ...current, [path]: value }));
    setServerErrors((current) => ({ ...current, byPath: { ...current.byPath, [path]: undefined } }));
  };
  const invalid = Object.values(errors).some(Boolean);

  async function save() {
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      const answer = await api.put("/api/telemetry/settings", result.patch, { headers: { "if-match": settings.etag } });
      setSaved({ restartRequired: Array.isArray(answer?.restartRequired) ? answer.restartRequired : answer?.restartRequired ? [String(answer.restartRequired)] : [] });
      toasts?.push?.({ level: "success", title: t("obs.settings.saved") });
      cache.invalidate(["telemetry"]);
      await query.refetch();
    } catch (error) {
      if (error?.status === 409 || error?.code === "etag_mismatch") {
        setProblem({ kind: "conflict" });
      } else if (error?.status === 400) {
        const mapped = serverFieldErrors(error.fieldErrors?.length ? error.fieldErrors : error.details?.errors);
        setServerErrors(mapped);
        setProblem({ kind: "invalid", text: describeError(error, i18n) });
      } else {
        setProblem({ kind: "error", text: describeError(error, i18n) });
      }
    } finally {
      setBusy(false);
    }
  }

  function reload() {
    setProblem(null);
    setSaved(null);
    cache.invalidate(["telemetry", "settings"]);
    query.refetch();
  }

  return html`<form class="stack" data-testid="obs.settings.form" noValidate onSubmit=${(event) => {
    event.preventDefault();
    if (result.changed && !invalid && !busy) save();
  }}>
    ${SETTING_GROUPS.map((group) => html`<${Card} key=${group.id} title=${t(tk("obs.settings.group.", group.id))} testid=${`obs.settings.group.${group.id}`}>
      <div class="obs-form-grid">${group.paths.map((path) => html`<${Field} key=${path} path=${path} draft=${draft} set=${set} errors=${errors} i18n=${i18n} />`)}</div>
      ${group.id === "energy" ? html`<${Tariffs} draft=${draft} setDraft=${setDraft} errors=${errors} i18n=${i18n} />
        ${hasPrice(settings) ? null : html`<p class="notice notice-info" role="status" data-testid="obs.settings.noPrice">${t("obs.noPrice")}</p>`}` : null}
    <//>`)}
    ${problem?.kind === "conflict" ? html`<div class="notice notice-warn" role="alert" data-testid="obs.settings.conflict"><span class="grow">${t("obs.settings.conflict")}</span>
      <${Button} size="sm" onClick=${reload} testid="obs.settings.reload">${t("obs.settings.reload")}<//></div>` : null}
    ${problem && problem.kind !== "conflict" ? html`<p class="notice notice-danger" role="alert" data-testid="obs.settings.problem">${problem.text}</p>` : null}
    ${serverErrors.other.length ? html`<ul class="field-error" role="alert" data-testid="obs.settings.other">${serverErrors.other.map((item, index) => html`<li key=${index}><span class="mono">${item.field}</span> ${item.message || item.code}</li>`)}</ul>` : null}
    ${saved ? html`<p class="notice notice-success" role="status" data-testid="obs.settings.saved">${t("obs.settings.saved")}${saved.restartRequired.length ? ` ${t("obs.settings.restart", { items: saved.restartRequired.join(", ") })}` : ""}</p>` : null}
    <div class="row">
      <${Button} type="submit" variant="primary" busy=${busy} disabled=${!result.changed || invalid} testid="obs.settings.save">${t("obs.settings.save")}<//>
      <${Button} onClick=${() => { setDraft(settingsDraft(settings)); setServerErrors({ byPath: {}, other: [] }); setProblem(null); }} disabled=${!result.changed || busy} testid="obs.settings.discard">${t("obs.settings.discard")}<//>
    </div>
  </form>`;
}

function Body() {
  const { api } = useServices();
  const query = useQuery(["telemetry", "settings"], () => api.get("/api/telemetry/settings"), { ttlMs: 5000 });
  return html`
    <${StatusCard} />
    <${QueryView} query=${query}>${() => html`<${SettingsForm} query=${query} />`}<//>
    <${LazyView} load=${loadImport} name="ImportCard" />
  `;
}

export default function ObservabilitySettings() {
  const obs = useObsState();
  return html`<${ObsPage} obs=${obs} id="settings" ownerOnly=${true} bare=${true}>${() => html`<${Body} />`}<//>`;
}
