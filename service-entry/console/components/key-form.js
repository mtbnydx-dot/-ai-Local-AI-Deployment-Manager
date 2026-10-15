// KeyForm (07 §4.4, §6.10, 05 §13.4): create or edit a platform key.
//
// Controlled: the page owns the draft (lib/access-model.js) and the errors,
// this component draws them. Fields are grouped as Identity, Access, Limits,
// Browser access and Expiry; each one has a label in plain words, its API
// field as secondary mono text inside the help popover, and help text in
// both languages from the `access` catalog area. A limit left empty shows
// what that means ("inherits the default" or "no cap").
//
//   <KeyForm mode draft onChange errors presets customers models />
//   mode "create" shows the preset cards; "edit" does not.
//   errors { [field]: code | { code, message } } (client codes or a server fieldErrors map)

import { dateInput, EXPIRY_QUICK_DAYS, FIELD_COPY, KEY_CLASSES, LIMIT_FIELDS, LISTENERS, matchedModels, SCOPE_GROUPS, SCOPES, splitList } from "../lib/access-model.js";
import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { FormField } from "./form-field.js";

const MATCH_PREVIEW = 6;

function errorText(i18n, entry) {
  if (!entry) return undefined;
  const code = typeof entry === "string" ? entry : entry.code;
  const key = tk("access.err.", code);
  if (i18n.has(key)) return i18n.t(key);
  return typeof entry === "object" && entry.message ? entry.message : i18n.t("access.err.invalid");
}

function help(i18n, spec) {
  return { what: i18n.t(spec.help), flag: spec.flag };
}

function PresetCards({ presets, value, onPick }) {
  const { t, has } = useT();
  const cards = [...presets.map((preset) => ({ id: preset.id, title: has(preset.labelKey) ? t(preset.labelKey) : preset.id, body: has(preset.descriptionKey) ? t(preset.descriptionKey) : "" })),
    { id: "", title: t("access.preset.custom.title"), body: t("access.preset.custom.description") }];
  return html`<fieldset class="kf-presets" data-testid="key-form.presets">
    <legend class="kf-legend">${t("access.form.preset")}</legend>
    <div class="kf-preset-grid">
      ${cards.map((card) => html`<label key=${card.id || "custom"} class="kf-preset" data-selected=${value === card.id ? "true" : "false"} data-testid=${`key-form.preset.${card.id || "custom"}`}>
        <input type="radio" name="kf-preset" value=${card.id} checked=${value === card.id} onChange=${() => onPick(card.id)} />
        <span class="kf-preset-title">${card.title}</span>
        <span class="kf-preset-body">${card.body}</span>
      </label>`)}
    </div>
  </fieldset>`;
}

function ScopeBoxes({ draft, set, error }) {
  const i18n = useT();
  const { t } = i18n;
  const toggle = (id, on) => set({ scopes: on ? [...draft.scopes, id] : draft.scopes.filter((scope) => scope !== id) });
  return html`<fieldset class="kf-scopes" data-testid="key-form.scopes" aria-describedby=${error ? "kf-scopes-error" : undefined}>
    <legend class="kf-legend row">
      <span>${t(FIELD_COPY.scopes.label)}</span>
      <span class="muted small">${t(FIELD_COPY.scopes.help)}</span>
    </legend>
    ${SCOPE_GROUPS.map((group) => html`<div key=${group} class="kf-scope-group">
      <div class="kf-scope-title">${t(group)}</div>
      <div class="kf-scope-list">
        ${SCOPES.filter((scope) => scope.group === group).map((scope) => html`<label key=${scope.id} class="check kf-scope" data-testid=${`key-form.scope.${scope.id}`}>
          <input type="checkbox" checked=${draft.scopes.includes(scope.id)} onChange=${(event) => toggle(scope.id, event.currentTarget.checked)} />
          <span><span>${t(scope.label)}</span><span class="muted small kf-scope-hint">${t(scope.hint)}${scope.adminOnly ? ` ${t("access.scope.adminOnly")}` : ""}</span></span>
        </label>`)}
      </div>
    </div>`)}
    ${error ? html`<div id="kf-scopes-error" class="field-error" data-testid="key-form.scopes-error">${errorText(i18n, error)}</div>` : null}
  </fieldset>`;
}

function ModelsField({ draft, set, error, models }) {
  const i18n = useT();
  const { t } = i18n;
  const patterns = splitList(draft.models);
  const known = Array.isArray(models) ? models : [];
  const hits = matchedModels(patterns, known);
  return html`<${FormField} id="kf-models" label=${t(FIELD_COPY.models.label)} help=${help(i18n, FIELD_COPY.models)} error=${errorText(i18n, error)} hint=${t("access.form.modelsHint")} required testid="key-form.field.models">
    ${(props) => html`<div class="stack-sm grow">
      <textarea ...${props} class="textarea mono" rows="3" spellcheck="false" value=${draft.models} onInput=${(event) => set({ models: event.currentTarget.value })} data-testid="key-form.models"></textarea>
      <div class="small muted" role="status" data-testid="key-form.matches">
        ${known.length
          ? html`<strong data-testid="key-form.matches-count">${t("access.form.matches", { count: hits.length, total: known.length })}</strong>${hits.length ? html`: <span class="mono" data-user-content>${hits.slice(0, MATCH_PREVIEW).join(", ")}${hits.length > MATCH_PREVIEW ? ` +${hits.length - MATCH_PREVIEW}` : ""}</span>` : null}`
          : t("access.form.matchesUnknown")}
      </div>
    </div>`}
  <//>`;
}

function TextField({ i18n, id, spec, value, onInput, error, required, multiline, placeholder, mono }) {
  return html`<${FormField} id=${id} label=${i18n.t(spec.label)} help=${help(i18n, spec)} error=${errorText(i18n, error)} required=${required} testid=${`key-form.field.${spec.flag}`}>
    ${(props) => (multiline
      ? html`<textarea ...${props} class=${`textarea${mono ? " mono" : ""}`} rows="2" spellcheck="false" value=${value} placeholder=${placeholder} onInput=${(event) => onInput(event.currentTarget.value)} data-testid=${`key-form.${spec.flag}`}></textarea>`
      : html`<input ...${props} class=${`input${mono ? " mono" : ""}`} value=${value} placeholder=${placeholder} autocomplete="off" onInput=${(event) => onInput(event.currentTarget.value)} data-testid=${`key-form.${spec.flag}`} />`)}
  <//>`;
}

/**
 * @param presets GET /api/access/presets entries; customers [{ id, name }] from the billing API (may be empty)
 * @param models served model ids for the live "matches N models" count
 */
export function KeyForm({ mode = "create", draft, onChange, errors = {}, presets = [], customers = [], models = [], presetInfo = null, disabled = false, onPickPreset }) {
  const i18n = useT();
  const { t } = i18n;
  const set = (patch) => onChange({ ...draft, ...patch });
  const setLimit = (id, value) => onChange({ ...draft, limits: { ...draft.limits, [id]: value } });
  const needsCustomer = Boolean(presetInfo?.requiresCustomer) || draft.class === "customer";
  const quickExpiry = (days) => set({ expires: days ? dateInput(Date.now() + days * 86_400_000) : "" });

  return html`<form class="kf stack" onSubmit=${(event) => event.preventDefault()} noValidate data-testid="key-form.root" data-mode=${mode}>
    ${mode === "create" ? html`<${PresetCards} presets=${presets} value=${draft.preset} onPick=${onPickPreset} />` : null}
    <fieldset class="kf-group" disabled=${disabled}>
      <legend class="kf-legend">${t("access.form.identity")}</legend>
      <${TextField} i18n=${i18n} id="kf-name" spec=${FIELD_COPY.name} value=${draft.name} onInput=${(name) => set({ name })} error=${errors.name} required />
      <${TextField} i18n=${i18n} id="kf-holder" spec=${FIELD_COPY.holder} value=${draft.holder} onInput=${(holder) => set({ holder })} error=${errors.holder} />
      <${FormField} id="kf-class" label=${t(FIELD_COPY.class.label)} help=${help(i18n, FIELD_COPY.class)} error=${errorText(i18n, errors.class)} testid="key-form.field.class">
        ${(props) => html`<select ...${props} class="select" value=${draft.class} onChange=${(event) => set({ class: event.currentTarget.value })} data-testid="key-form.class">
          ${KEY_CLASSES.map((item) => html`<option key=${item} value=${item}>${t(tk("access.class.", item))}</option>`)}
        </select>`}
      <//>
      <${FormField} id="kf-customer" label=${t(FIELD_COPY.customerId.label)} help=${help(i18n, FIELD_COPY.customerId)} error=${errorText(i18n, errors.customerId)} required=${needsCustomer} testid="key-form.field.customerId">
        ${(props) => (customers.length
          ? html`<select ...${props} class="select" value=${draft.customerId} onChange=${(event) => set({ customerId: event.currentTarget.value })} data-testid="key-form.customerId">
              <option value="">${t("access.form.noCustomer")}</option>
              ${customers.map((customer) => html`<option key=${customer.id} value=${customer.id}>${customer.name}</option>`)}
            </select>`
          : html`<input ...${props} class="input mono" value=${draft.customerId} placeholder=${t("access.form.customerIdPlaceholder")} autocomplete="off" spellcheck="false" onInput=${(event) => set({ customerId: event.currentTarget.value })} data-testid="key-form.customerId" />`)}
      <//>
      <${TextField} i18n=${i18n} id="kf-notes" spec=${FIELD_COPY.notes} value=${draft.notes} onInput=${(notes) => set({ notes })} error=${errors.notes} multiline />
    </fieldset>

    <fieldset class="kf-group" disabled=${disabled}>
      <legend class="kf-legend">${t("access.form.access")}</legend>
      <${ScopeBoxes} draft=${draft} set=${set} error=${errors.scopes} />
      <${ModelsField} draft=${draft} set=${set} error=${errors.models} models=${models} />
      <${FormField} id="kf-listeners" label=${t(FIELD_COPY.listeners.label)} help=${help(i18n, FIELD_COPY.listeners)} error=${errorText(i18n, errors.listeners)} testid="key-form.field.listeners">
        ${() => html`<div class="row" role="group" aria-label=${t(FIELD_COPY.listeners.label)}>
          ${LISTENERS.map((item) => html`<label key=${item} class="check"><input type="checkbox" checked=${draft.listeners.includes(item)}
            onChange=${(event) => set({ listeners: event.currentTarget.checked ? [...draft.listeners, item] : draft.listeners.filter((entry) => entry !== item) })} data-testid=${`key-form.listener.${item}`} />${t(tk("access.listener.", item))}</label>`)}
        </div>`}
      <//>
      <${TextField} i18n=${i18n} id="kf-fleet" spec=${FIELD_COPY.fleetAllow} value=${draft.fleetAllow} onInput=${(fleetAllow) => set({ fleetAllow })} error=${errors.fleetAllow} multiline mono placeholder=${t("access.form.fleetPlaceholder")} />
    </fieldset>

    <fieldset class="kf-group" disabled=${disabled}>
      <legend class="kf-legend">${t("access.form.limits")}</legend>
      <p class="muted small">${t("access.form.limitsHint")}</p>
      <div class="kf-limits">
        ${LIMIT_FIELDS.map((field) => html`<${FormField} key=${field.id} id=${`kf-limit-${field.id}`} label=${t(field.label)} unit=${t(field.unit)} help=${help(i18n, field)}
          error=${errorText(i18n, errors[`limits.${field.id}`])} testid=${`key-form.field.${field.id}`}>
          ${(props) => html`<input ...${props} class="input" inputmode="numeric" autocomplete="off" value=${draft.limits[field.id]}
            placeholder=${t(field.blank === "unlimited" ? "access.limit.unlimited" : "access.limit.inherit")} onInput=${(event) => setLimit(field.id, event.currentTarget.value)} data-testid=${`key-form.limit.${field.id}`} />`}
        <//>`)}
      </div>
    </fieldset>

    <fieldset class="kf-group" disabled=${disabled}>
      <legend class="kf-legend">${t("access.form.browser")}</legend>
      <${TextField} i18n=${i18n} id="kf-origins" spec=${FIELD_COPY.allowedOrigins} value=${draft.allowedOrigins} onInput=${(allowedOrigins) => set({ allowedOrigins })} error=${errors.allowedOrigins} multiline mono placeholder=${t("access.form.originsPlaceholder")} />
      <${TextField} i18n=${i18n} id="kf-ips" spec=${FIELD_COPY.allowedIps} value=${draft.allowedIps} onInput=${(allowedIps) => set({ allowedIps })} error=${errors.allowedIps} multiline mono placeholder=${t("access.form.ipsPlaceholder")} />
    </fieldset>

    <fieldset class="kf-group" disabled=${disabled}>
      <legend class="kf-legend">${t("access.form.expiry")}</legend>
      <${FormField} id="kf-expires" label=${t(FIELD_COPY.expires.label)} help=${help(i18n, FIELD_COPY.expires)} error=${errorText(i18n, errors.expires)} testid="key-form.field.expires">
        ${(props) => html`<div class="stack-sm">
          <input ...${props} class="input" type="date" value=${draft.expires} onInput=${(event) => set({ expires: event.currentTarget.value })} data-testid="key-form.expires" />
          <div class="row">
            ${EXPIRY_QUICK_DAYS.map((days) => html`<${Button} key=${days} size="sm" onClick=${() => quickExpiry(days)} testid=${`key-form.expiry.${days}`}>${t("access.form.expiryDays", { count: days })}<//>`)}
            <${Button} size="sm" onClick=${() => quickExpiry(0)} testid="key-form.expiry.never">${t("access.expiry.never")}<//>
          </div>
        </div>`}
      <//>
    </fieldset>
  </form>`;
}
