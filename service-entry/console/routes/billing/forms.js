// Form plumbing for the billing page (07 §6.11): field state with per-field
// errors, FormField-wired inputs, and the one way a write goes out. A form
// validates through model.js first, so what reaches the API is the canonical
// payload; a server refusal stays on the form, in an alert, as text the
// catalog or the server wrote.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { FormField } from "../../components/form-field.js";
import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

/** `{ code, vars }` of a model.js validation error as the text under its field. */
export function errorText(t, error) {
  return error ? t(tk("billing.error.", error.code), error.vars || {}) : undefined;
}

export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  return {
    values,
    errors,
    failure,
    busy,
    setErrors,
    setFailure,
    setBusy,
    set(name, value) {
      setValues((current) => ({ ...current, [name]: value }));
      setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
    },
    patch(next) {
      setValues((current) => ({ ...current, ...next }));
      setErrors({});
    },
    reset(next = initial) {
      setValues(next);
      setErrors({});
      setFailure(null);
    },
  };
}

function Control({ form, name, props, kind, rows, options, ...rest }) {
  const common = {
    ...props,
    name,
    "data-testid": `${rest.id}.${name}`,
  };
  if (kind === "select") {
    return html`<select class="select" ...${common} value=${form.values[name] ?? ""} onChange=${(event) => form.set(name, event.currentTarget.value)}>
      ${options.map((option) => html`<option key=${option.value} value=${option.value} disabled=${option.disabled}>${option.label}</option>`)}
    </select>`;
  }
  if (kind === "textarea") {
    return html`<textarea class="textarea" rows=${rows || 3} ...${common} value=${form.values[name] ?? ""} onInput=${(event) => form.set(name, event.currentTarget.value)} maxlength=${rest.maxLength} placeholder=${rest.placeholder} />`;
  }
  return html`<input class="input" type="text" ...${common} value=${form.values[name] ?? ""} onInput=${(event) => form.set(name, event.currentTarget.value)} inputmode=${rest.inputMode} maxlength=${rest.maxLength} placeholder=${rest.placeholder} autocomplete="off" />`;
}

/**
 * One labelled control. `kind` is "text" (default), "select" or "textarea";
 * `options` are `{ value, label, disabled? }` for a select.
 */
export function Field({ form, id, name, label, kind = "text", options, help, hint, rows, inputMode, maxLength, placeholder, required = false, locked }) {
  const { t } = useT();
  return html`<${FormField} label=${label} help=${help} hint=${hint} required=${required} locked=${locked} error=${errorText(t, form.errors[name])} testid=${`${id}.${name}.field`}>
    ${(props) => html`<${Control} form=${form} name=${name} props=${props} kind=${kind} options=${options} rows=${rows} id=${id} inputMode=${inputMode} maxLength=${maxLength} placeholder=${placeholder} />`}
  <//>`;
}

/** Options of a select: `placeholder` first (value ""), then `items` mapped by `value`/`label`. */
export function optionList(placeholder, items, value, label) {
  return [{ value: "", label: placeholder }, ...items.map((item) => ({ value: value(item), label: label(item) }))];
}

/**
 * A card holding a form. `onSubmit` runs after the browser's submit event;
 * the card shows the form's server failure in an alert above the button.
 */
export function FormCard({ id, form, title, note, submit, onSubmit, children, extraActions, level = 3 }) {
  const i18n = useT();
  return html`<${Card} title=${title} level=${level} testid=${`${id}.card`}>
    ${note ? html`<p class="muted small">${note}</p>` : null}
    <form class="stack-sm billing-form" noValidate data-testid=${id} onSubmit=${(event) => {
      event.preventDefault();
      if (!form.busy) onSubmit(event);
    }}>
      ${children}
      ${form.failure ? html`<p class="field-error" role="alert" data-testid=${`${id}.failure`}>${describeError(form.failure, i18n)}</p>` : null}
      <div class="row">
        <${Button} type="submit" variant="primary" busy=${form.busy} testid=${`${id}.submit`}>${submit}<//>
        ${extraActions || null}
      </div>
    </form>
  <//>`;
}

/**
 * Validates `values` with `validate`, then runs `send(value, api)`; on success
 * invalidates ["billing"], toasts `doneKey` and resolves the send's result, on
 * a refusal keeps the error on the form. Resolves undefined when nothing was sent.
 */
export function useSubmit(form) {
  const { api, cache, toasts, i18n } = useServices();
  return async function submit({ validate, send, doneKey, reset = false }) {
    const checked = validate();
    if (!checked.ok) {
      form.setErrors(checked.errors);
      form.setFailure(null);
      return undefined;
    }
    form.setErrors({});
    form.setFailure(null);
    form.setBusy(true);
    try {
      const result = await send(checked.value, api);
      cache.invalidate(["billing"]);
      if (doneKey) toasts?.push?.({ level: "success", title: i18n.t(doneKey) });
      if (reset) form.reset();
      return result ?? true;
    } catch (error) {
      form.setFailure(error);
      return undefined;
    } finally {
      form.setBusy(false);
    }
  };
}
