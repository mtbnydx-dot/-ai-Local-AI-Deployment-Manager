// SchemaForm (07 section 4.5): draws the FieldModels that
// lib/schema-form-model.js builds from 01's parameter catalog. The model
// decides what shows; this file only renders it and reports changes.
//
// <SchemaForm catalog plan values onChange onReset onApplySuggestion
//             level onLevelChange groups readOnly mode="launch|config|catalog" />
//
// onChange(id, value, field) reports one edited field: null unsets it and, for
// a secret, means Clear (keep it with withValue(values, id, value,
// { keepNull: field.secret }) from the model). onReset(id) drops the explicit
// value; a secret goes back to Unchanged. onApplySuggestion(id, value) fires
// only when the user clicks a suggestion chip, and falls back to onChange.
// Locked fields are disabled with their reason. Secrets are write-only: the
// input stays empty, the value is sent once and never echoed. DOM hooks:
// id=<domId> on the control, data-field="<paramId>" and data-source on the
// field wrapper.

import {
  buildFormModel,
  LEVELS,
  pickText,
  sameValue,
} from "../lib/schema-form-model.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useId, useMemo, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { FormField } from "./form-field.js";
import { Icon } from "./icon.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Draft text for a number input and the value it stands for (null for empty, undefined for unparsable text). */
export function parseNumberText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * A draft that follows `value` when the parent changes it, and keeps its own
 * rows or text while the user edits (an empty row or half-typed number is not
 * a value). fromDraft returns the value, or undefined for "no value yet".
 */
function useDraft(value, toDraft, fromDraft) {
  const [draft, setDraft] = useState(() => toDraft(value));
  const last = useRef(value);
  useEffect(() => {
    if (!sameValue(value ?? null, last.current ?? null)) {
      last.current = value;
      setDraft(toDraft(value));
    }
  }, [value]);
  // → { emit, value }: emit is false for text that stands for no value yet (half-typed JSON or number).
  function update(next) {
    setDraft(next);
    const out = fromDraft(next);
    if (out === undefined) return { emit: false };
    const emit = !sameValue(out ?? null, last.current ?? null);
    last.current = out;
    return { emit, value: out };
  }
  return [draft, update];
}

function displayValue(value, field, t) {
  if (value === null || value === undefined) return "";
  const choice = field.choices?.find((item) => sameValue(item.value, value));
  if (choice) return choice.label;
  if (typeof value === "boolean") return value ? t("engines.form.on") : t("engines.form.off");
  if (Array.isArray(value)) return value.map((item) => (isPlainObject(item) ? JSON.stringify(item) : String(item))).join(", ");
  if (isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

function errorText(error, t, tk) {
  if (!error) return null;
  if (error.message) return error.message;
  const bounds = error.bounds || {};
  let code = error.code;
  if (code === "out_of_range") {
    if (bounds.min !== null && bounds.min !== undefined && (bounds.max === null || bounds.max === undefined)) code = "out_of_range_min";
    else if (bounds.max !== null && bounds.max !== undefined && (bounds.min === null || bounds.min === undefined)) code = "out_of_range_max";
  }
  return t(tk("engines.form.err.", code), bounds);
}

// ---- controls ------------------------------------------------------------

function NumberControl({ field, control, onChange }) {
  const [text, update] = useDraft(field.userValue, (value) => (value === null || value === undefined ? "" : String(value)), (draft) => parseNumberText(draft));
  const step = field.range?.step ?? (field.type === "float" ? "any" : 1);
  return html`<input ...${control} class="input" type="number" inputmode=${field.type === "float" ? "decimal" : "numeric"} step=${step}
    min=${field.range?.min ?? undefined} max=${field.range?.max ?? undefined}
    value=${text} placeholder=${field.ghost !== null && field.ghost !== undefined ? String(field.ghost) : undefined}
    data-testid="schema-form.number"
    onInput=${(event) => {
      const result = update(event.currentTarget.value);
      if (result.emit) onChange(result.value);
    }} />`;
}

function Segmented({ field, control, onChange }) {
  const group = useId();
  const selected = field.userValue ?? field.effective.value;
  const hasChoice = field.choices.some((choice) => sameValue(choice.value, selected));
  return html`<div class="sf-seg" role="radiogroup" id=${control.id} aria-label=${field.label} aria-describedby=${control["aria-describedby"]} aria-invalid=${control["aria-invalid"]}
    data-testid="schema-form.segmented">
    ${field.choices.map((choice, index) => html`<label key=${index} class="sf-seg-opt">
      <input type="radio" name=${group} checked=${hasChoice && sameValue(choice.value, selected)} disabled=${control.disabled}
        onChange=${() => onChange(choice.value)} />
      <span>${choice.label}</span>
    </label>`)}
  </div>`;
}

function SelectControl({ field, control, onChange }) {
  const { t } = useT();
  const selected = field.choices.findIndex((choice) => sameValue(choice.value, field.userValue));
  const ghost = field.ghost !== null && field.ghost !== undefined ? displayValue(field.ghost, field, t) : "";
  return html`<select ...${control} class="select" data-testid="schema-form.select" value=${selected >= 0 ? String(selected) : ""}
    onChange=${(event) => {
      const index = event.currentTarget.value;
      onChange(index === "" ? null : field.choices[Number(index)].value);
    }}>
    <option value="">${ghost ? t("engines.form.defaultIs", { value: ghost }) : t("engines.form.useDefault")}</option>
    ${field.choices.map((choice, index) => html`<option key=${index} value=${String(index)}>${choice.label}</option>`)}
  </select>`;
}

function SwitchControl({ field, control, onChange }) {
  const { t } = useT();
  const on = (field.userValue ?? field.effective.value) === true;
  return html`<label class="check sf-switch-wrap">
    <input ...${control} type="checkbox" role="switch" class="sf-switch" checked=${on} data-testid="schema-form.switch"
      onChange=${(event) => onChange(event.currentTarget.checked)} />
    <span>${on ? t("engines.form.on") : t("engines.form.off")}</span>
  </label>`;
}

function TristateControl({ field, control, onChange }) {
  const { t, tk } = useT();
  const group = useId();
  const current = field.userValue === true ? "on" : field.userValue === false ? "off" : "default";
  const options = [["default", null], ["on", true], ["off", false]];
  return html`<div class="sf-seg" role="radiogroup" id=${control.id} aria-label=${field.label} aria-describedby=${control["aria-describedby"]} data-testid="schema-form.tristate">
    ${options.map(([key, value]) => html`<label key=${key} class="sf-seg-opt">
      <input type="radio" name=${group} checked=${current === key} disabled=${control.disabled} onChange=${() => onChange(value)} />
      <span>${t(tk("engines.form.tristate.", key))}</span>
    </label>`)}
  </div>`;
}

function TextControl({ field, control, onChange, ctx }) {
  const { t } = useT();
  const value = typeof field.userValue === "string" ? field.userValue : "";
  const input = html`<input ...${control} class="input" type="text" value=${value} autocomplete="off" spellcheck="false"
    placeholder=${typeof field.ghost === "string" || typeof field.ghost === "number" ? String(field.ghost) : undefined} data-testid="schema-form.text"
    onInput=${(event) => onChange(event.currentTarget.value === "" ? null : event.currentTarget.value)} />`;
  if (field.widget !== "path" || !ctx.onPickPath) return input;
  return html`${input}<${Button} size="sm" disabled=${control.disabled} onClick=${() => ctx.onPickPath(field.id)} testid="schema-form.pick-path">${t("engines.form.path.browse")}<//>`;
}

function JsonControl({ field, control, onChange }) {
  const { t } = useT();
  const toText = (value) => (value === null || value === undefined ? "" : JSON.stringify(value, null, 2));
  const [text, update] = useDraft(field.userValue, toText, (draft) => {
    try {
      return draft.trim() ? JSON.parse(draft) : null;
    } catch {
      return undefined;
    }
  });
  let invalid = false;
  if (text.trim()) {
    try {
      JSON.parse(text);
    } catch {
      invalid = true;
    }
  }
  return html`<div class="sf-json">
    <textarea ...${control} class="textarea sf-json-input" spellcheck="false" value=${text} data-testid="schema-form.json"
      aria-invalid=${invalid ? "true" : control["aria-invalid"]}
      onInput=${(event) => {
        const result = update(event.currentTarget.value);
        if (result.emit) onChange(result.value);
      }}></textarea>
    ${invalid ? html`<div class="field-error" role="alert" data-testid="schema-form.json-error"><${Icon} name="circle-x" size="sm" /> ${t("engines.form.json.invalid")}</div>` : null}
  </div>`;
}

function TokenEditor({ field, control, onChange }) {
  const { t } = useT();
  const [rows, update] = useDraft(field.userValue, (value) => (Array.isArray(value) ? value.map(String) : []), (draft) => {
    const tokens = draft.filter((token) => token !== "");
    return tokens.length ? tokens : null;
  });
  const set = (next) => {
    const result = update(next);
    if (result.emit) onChange(result.value);
  };
  return html`<div class="sf-rows" data-testid="schema-form.tokens">
    ${rows.map((token, index) => html`<div key=${index} class="sf-row">
      <input ...${index === 0 ? control : { disabled: control.disabled }} class="input" type="text" value=${token} spellcheck="false" autocomplete="off"
        aria-label=${t("engines.form.rowLabel", { name: field.label, n: index + 1 })}
        onInput=${(event) => set(rows.map((item, at) => (at === index ? event.currentTarget.value : item)))} />
      <${Button} size="sm" variant="ghost" disabled=${control.disabled} label=${t("engines.form.remove", { name: field.label, n: index + 1 })}
        onClick=${() => set(rows.filter((_, at) => at !== index))} testid="schema-form.remove">${t("engines.form.removeShort")}<//>
    </div>`)}
    <${Button} size="sm" id=${rows.length ? undefined : control.id} label=${t("engines.form.addTo", { name: field.label })} disabled=${control.disabled} onClick=${() => set([...rows, ""])} testid="schema-form.add">${t("engines.form.add")}<//>
  </div>`;
}

function KvEditor({ field, control, onChange }) {
  const { t } = useT();
  const [rows, update] = useDraft(field.userValue, (value) => (isPlainObject(value) ? Object.entries(value).map(([key, item]) => [key, String(item)]) : []), (draft) => {
    const out = {};
    for (const [key, item] of draft) if (key.trim()) out[key.trim()] = item;
    return Object.keys(out).length ? out : null;
  });
  const set = (next) => {
    const result = update(next);
    if (result.emit) onChange(result.value);
  };
  const duplicate = (key, index) => key.trim() !== "" && rows.some(([other], at) => at !== index && other.trim() === key.trim());
  return html`<div class="sf-rows" data-testid="schema-form.kv">
    ${rows.map(([key, item], index) => html`<div key=${index} class="sf-row">
      <input ...${index === 0 ? control : { disabled: control.disabled }} class="input" type="text" value=${key} spellcheck="false" autocomplete="off"
        placeholder=${t("engines.form.kv.key")} aria-invalid=${duplicate(key, index) ? "true" : undefined}
        aria-label=${`${t("engines.form.rowLabel", { name: field.label, n: index + 1 })} ${t("engines.form.kv.key")}`}
        onInput=${(event) => set(rows.map((row, at) => (at === index ? [event.currentTarget.value, row[1]] : row)))} />
      <input class="input" type="text" value=${item} spellcheck="false" autocomplete="off" disabled=${control.disabled}
        placeholder=${t("engines.form.kv.value")}
        aria-label=${`${t("engines.form.rowLabel", { name: field.label, n: index + 1 })} ${t("engines.form.kv.value")}`}
        onInput=${(event) => set(rows.map((row, at) => (at === index ? [row[0], event.currentTarget.value] : row)))} />
      <${Button} size="sm" variant="ghost" disabled=${control.disabled} label=${t("engines.form.remove", { name: field.label, n: index + 1 })}
        onClick=${() => set(rows.filter((_, at) => at !== index))} testid="schema-form.remove">${t("engines.form.removeShort")}<//>
    </div>`)}
    <${Button} size="sm" id=${rows.length ? undefined : control.id} label=${t("engines.form.addTo", { name: field.label })} disabled=${control.disabled} onClick=${() => set([...rows, ["", ""]])} testid="schema-form.add">${t("engines.form.add")}<//>
  </div>`;
}

// A list of small objects (LoRA adapters, tensor overrides): one row of inputs per item.
function RowsEditor({ field, control, onChange, ctx }) {
  const { t, has, tk } = useT();
  const fields = Object.entries(field.item?.fields || {});
  const max = field.item?.maxItems ?? Infinity;
  const [rows, update] = useDraft(field.userValue, (value) => (Array.isArray(value) ? value.map((item) => ({ ...item })) : []), (draft) => {
    const items = draft.map((row) => {
      const out = {};
      for (const [name, spec] of fields) {
        const raw = row[name];
        if (raw === undefined || raw === null || raw === "") continue;
        out[name] = spec?.type === "number" ? (parseNumberText(String(raw)) ?? raw) : raw;
      }
      return out;
    }).filter((row) => Object.keys(row).length);
    return items.length ? items : null;
  });
  const set = (next) => {
    const result = update(next);
    if (result.emit) onChange(result.value);
  };
  const label = (name) => (has(tk("engines.form.field.", name)) ? t(tk("engines.form.field.", name)) : name);
  return html`<div class="sf-rows" data-testid="schema-form.rows">
    ${rows.map((row, index) => html`<div key=${index} class="sf-row sf-row-fields">
      ${fields.map(([name, spec], column) => html`<input key=${name} ...${index === 0 && column === 0 ? control : { disabled: control.disabled }} class="input" type=${spec?.type === "number" ? "number" : "text"}
        step=${spec?.type === "number" ? "any" : undefined} min=${spec?.min ?? undefined} max=${spec?.max ?? undefined}
        value=${row[name] ?? ""} placeholder=${label(name)} spellcheck="false" autocomplete="off" required=${spec?.required ? true : undefined}
        aria-label=${`${t("engines.form.rowLabel", { name: field.label, n: index + 1 })} ${label(name)}`}
        onInput=${(event) => set(rows.map((item, at) => (at === index ? { ...item, [name]: event.currentTarget.value } : item)))} />`)}
      <${Button} size="sm" variant="ghost" disabled=${control.disabled} label=${t("engines.form.remove", { name: field.label, n: index + 1 })}
        onClick=${() => set(rows.filter((_, at) => at !== index))} testid="schema-form.remove">${t("engines.form.removeShort")}<//>
    </div>`)}
    <${Button} size="sm" id=${rows.length ? undefined : control.id} label=${t("engines.form.addTo", { name: field.label })} disabled=${control.disabled || rows.length >= max} onClick=${() => set([...rows, {}])} testid="schema-form.add">${t("engines.form.add")}<//>
  </div>`;
}

// Write-only: the box stays empty, a typed value is sent once, and the state is shown as text.
function SecretControl({ field, control, onChange, onReset }) {
  const { t, tk } = useT();
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (field.secretState !== "pending") setDraft("");
  }, [field.secretState]);
  const state = field.secretState;
  const statusKey = state === "pending" ? "pending" : state === "clear" ? "clearing" : field.configured ? "set" : "unchanged";
  return html`<div class="sf-secret" data-testid="schema-form.secret" data-state=${state}>
    <input ...${control} class="input" type="password" autocomplete="new-password" spellcheck="false" value=${draft}
      placeholder=${field.configured ? t("engines.form.secret.replaceHint") : t("engines.form.secret.enter")}
      onInput=${(event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        if (text) onChange(text);
        else onReset();
      }} />
    <span class=${`badge ${state === "unchanged" && field.configured ? "badge-success" : state === "unchanged" ? "badge-neutral" : "badge-warn"}`} data-testid="schema-form.secret-state">${t(tk("engines.form.secret.", statusKey))}</span>
    ${state === "unchanged" && field.configured
      ? html`<${Button} size="sm" variant="ghost" disabled=${control.disabled} onClick=${() => onChange(null)} testid="schema-form.secret-clear">${t("engines.form.secret.clear")}<//>`
      : null}
    ${state !== "unchanged"
      ? html`<${Button} size="sm" variant="ghost" onClick=${() => {
        setDraft("");
        onReset();
      }} testid="schema-form.secret-undo">${t("engines.form.secret.undo")}<//>`
      : null}
  </div>`;
}

function renderControl(field, control, handlers, ctx) {
  const props = { field, control, ...handlers, ctx };
  switch (field.widget) {
    case "number": return html`<${NumberControl} ...${props} />`;
    case "segmented": return html`<${Segmented} ...${props} />`;
    case "select": return html`<${SelectControl} ...${props} />`;
    case "switch": return html`<${SwitchControl} ...${props} />`;
    case "tristate": return html`<${TristateControl} ...${props} />`;
    case "json": return html`<${JsonControl} ...${props} />`;
    case "tokens": return html`<${TokenEditor} ...${props} />`;
    case "kv": return html`<${KvEditor} ...${props} />`;
    case "rows": return html`<${RowsEditor} ...${props} />`;
    case "secret": return html`<${SecretControl} ...${props} />`;
    default: return html`<${TextControl} ...${props} />`;
  }
}

// ---- one field -----------------------------------------------------------

function Field({ field, ctx }) {
  const { t, has, tk } = useT();
  const disabled = ctx.readOnly || Boolean(field.locked);
  const source = field.effective.source;
  const chip = source ? ctx.sourceLabel?.(source) || (has(tk(ctx.sourcePrefix, source)) ? t(tk(ctx.sourcePrefix, source)) : source) : null;
  const lockReason = field.locked
    ? field.locked.reason || (field.locked.kind === "managed" ? t("engines.form.managedLock") : null)
    : null;
  const handlers = {
    onChange: (value) => ctx.onChange?.(field.id, value, field),
    onReset: () => ctx.onReset?.(field.id, field),
  };
  const message = errorText(field.error, t, tk);
  const warning = field.warnings.length ? field.warnings.map((item) => item.message).filter(Boolean).join(" ") : null;
  const helpProps = field.help.what || field.help.whenToChange || field.help.tradeoffs || field.flag
    ? { ...field.help, flag: field.flag }
    : null;
  const suggestion = field.suggestion && !ctx.readOnly ? field.suggestion : null;
  const badges = ctx.fieldBadges?.(field);
  const availabilityBadge = ctx.showAvailability && field.availability && field.availability.state !== "available"
    ? html`<span class=${`badge ${field.availability.state === "unavailable" ? "badge-warn" : "badge-neutral"}`} title=${field.availability.reason || undefined} data-testid="schema-form.availability">
      ${t(tk("engines.form.availability.", field.availability.state))}</span>`
    : null;
  const hint = field.summary || field.flag
    ? html`${field.summary}${field.summary && field.flag ? " " : ""}${field.flag ? html`<code class="code-inline sf-flag" data-testid="schema-form.flag">${field.flag}</code>` : null}`
    : null;
  const ghostLine = !field.secret && field.ghost !== null && field.ghost !== undefined && ["tristate", "segmented", "switch"].includes(field.widget)
    ? html`<span class="sf-ghost" data-testid="schema-form.ghost">${t("engines.form.defaultIs", { value: displayValue(field.ghost, field, t) })}</span>`
    : null;
  return html`<div class="sf-field" data-field=${field.id} data-source=${source || ""} data-widget=${field.widget} data-locked=${field.locked ? "true" : undefined}
    data-testid="schema-form.field">
    <${FormField} id=${field.domId} label=${field.label} unit=${field.unit} help=${helpProps} changed=${field.changed}
      onReset=${!ctx.readOnly && !field.secret ? handlers.onReset : undefined}
      provenance=${chip} locked=${field.locked ? { reason: lockReason } : undefined} hint=${hint} error=${message} warning=${warning} testid="schema-form.formfield">
      ${(control) => html`${renderControl(field, { ...control, disabled: control.disabled || disabled || undefined }, handlers, ctx)}
        ${field.hint ? html`<span class="sf-human" data-testid="schema-form.human">${field.hint}</span>` : null}`}
    <//>
    ${ghostLine || availabilityBadge || badges || suggestion
      ? html`<div class="sf-extras row">
        ${ghostLine}${availabilityBadge}${badges}
        ${suggestion
          ? html`<${Button} size="sm" onClick=${() => (ctx.onApplySuggestion || ((id, value) => ctx.onChange?.(id, value, field)))(field.id, suggestion.value, field)} testid="schema-form.suggestion"
            title=${suggestion.why || undefined}>${t("engines.form.apply", { value: displayValue(suggestion.value, field, t) })}<//>${suggestion.why ? html`<span class="field-hint">${suggestion.why}</span>` : null}`
          : null}
      </div>`
      : null}
  </div>`;
}

// ---- the form ------------------------------------------------------------

export function SchemaForm({
  catalog, plan = null, values = {}, onChange, onReset, onApplySuggestion, level, onLevelChange, groups,
  readOnly = false, mode = "launch", engineLabel, fieldErrors, query, onQueryChange, onPickPath,
  sourcePrefix = "engines.source.", sourceLabel, fieldBadges, testid,
}) {
  const { t, tk, locale } = useT();
  const [ownLevel, setOwnLevel] = useState("basic");
  const [ownQuery, setOwnQuery] = useState("");
  const activeLevel = level ?? ownLevel;
  const activeQuery = query ?? ownQuery;
  const groupKey = Array.isArray(groups) ? groups.map((item) => (typeof item === "string" ? item : item?.id)).join(",") : "";
  const model = useMemo(
    () => buildFormModel({ catalog, plan, values, locale, level: activeLevel, query: activeQuery, groups, mode, fieldErrors }),
    [catalog, plan, values, locale, activeLevel, activeQuery, groupKey, mode, fieldErrors],
  );
  const catalogMode = mode === "catalog";
  const ro = readOnly || catalogMode;
  const engine = engineLabel || pickText(catalog?.label, locale) || catalog?.engineId || "";
  const ctx = { onChange, onReset, onApplySuggestion, readOnly: ro, onPickPath, sourcePrefix, sourceLabel, fieldBadges, showAvailability: catalogMode };
  const searchId = useId();

  function changeLevel(next) {
    if (level === undefined) setOwnLevel(next);
    onLevelChange?.(next);
  }

  function changeQuery(next) {
    if (query === undefined) setOwnQuery(next);
    onQueryChange?.(next);
  }

  return html`<div class="sf" data-mode=${mode} data-level=${model.level} data-testid=${testid || "schema-form.root"}>
    <div class="sf-toolbar">
      ${catalogMode
        ? null
        : html`<div class="sf-seg" role="group" aria-label=${t("engines.form.level.label")} data-testid="schema-form.levels">
          ${LEVELS.map((id) => html`<button key=${id} type="button" class="sf-seg-opt sf-level" aria-pressed=${model.level === id ? "true" : "false"} data-level=${id}
            onClick=${() => changeLevel(id)} data-testid="schema-form.level">${t(tk("engines.form.level.", id))}</button>`)}
        </div>`}
      <div class="sf-search">
        <label class="sr-only" for=${searchId}>${t("engines.form.searchLabel")}</label>
        <input id=${searchId} class="input" type="search" value=${activeQuery} placeholder=${t("engines.form.search")} autocomplete="off"
          onInput=${(event) => changeQuery(event.currentTarget.value)} data-testid="schema-form.search" />
      </div>
    </div>
    ${model.unplaced.length
      ? html`<ul class="notice notice-danger sf-unplaced" role="alert" data-testid="schema-form.unplaced">
        ${model.unplaced.map((item, index) => html`<li key=${index}>${item.message || item.code}</li>`)}
      </ul>`
      : null}
    ${model.groups.length
      ? model.groups.map((group) => html`<div key=${group.id} class="sf-group" role="group" aria-labelledby=${`${searchId}-g-${group.id}`} data-group=${group.id} data-testid="schema-form.group">
        <h3 class="sf-group-title" id=${`${searchId}-g-${group.id}`}>${group.label}</h3>
        <div class="sf-fields">
          ${group.fields.map((field) => html`<${Field} key=${field.id} field=${field} ctx=${ctx} />`)}
        </div>
      </div>`)
      : html`<p class="sf-empty" data-testid="schema-form.empty">${t("engines.form.empty")}</p>`}
    <div class="sf-footer" aria-live="polite" data-testid="schema-form.footer">
      ${model.counts.hidden > 0 && !catalogMode
        ? html`<p data-testid="schema-form.hidden-level">${t("engines.form.hiddenByLevel", { count: model.counts.hidden })}</p>`
        : null}
      ${model.counts.notApplicable > 0 && !catalogMode
        ? html`<p data-testid="schema-form.hidden-na">${t("engines.form.hiddenNotApplicable", { count: model.counts.notApplicable, engine })}</p>`
        : null}
    </div>
  </div>`;
}
