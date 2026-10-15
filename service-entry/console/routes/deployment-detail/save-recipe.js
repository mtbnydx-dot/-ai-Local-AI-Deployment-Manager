// Save as recipe (07 §6.2, 02 §15, R-UI-7): the Drawer that turns a qualified
// launch into a recipe of this host, and the panel that reports the result.
//
//   Drawer     recipe id, zh and en title, scope (family | this model) and the
//              locks to tick. Nothing is sent until the form passes its own checks.
//   Errors     422 `recipe_invalid` and 400 field errors render under the field
//              they name (paths without an input are listed under the form);
//              409 `not_qualified` shows the server's hint.
//   Overwrite  409 `recipe_exists` opens a ConfirmDialog; only OK re-sends the
//              request with `overwrite:true`. A bundled recipe cannot be replaced.
//   Result     SavedRecipe links the id to the engine's Recipes tab and shows the
//              `recipe_reload_failed` warning when a manager did not reload in time.

import { describeError } from "../../lib/api.js";
import { blankRecipeDraft, existingRecipeSource, mapFieldErrors, recipeHref, saveRecipeBody, validateRecipeDraft } from "../../lib/qualify-model.js";
import { Button } from "../../components/button.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { Drawer } from "../../components/drawer.js";
import { FormField } from "../../components/form-field.js";
import { useServices } from "../../ui/context.js";
import { useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

const enc = encodeURIComponent;
const SCOPES = ["family", "this-model"];

const preview = (value) => (typeof value === "string" ? value : JSON.stringify(value));

/** The warning of a save result, in the user's language; a code this page knows has its own copy. */
function warningText(warning, { t, pick, has, tk }) {
  const key = tk("models.recipe.warning.", warning?.code);
  if (has(key)) return t(key);
  return pick(warning?.message) || String(warning?.code || "");
}

/** What the recipe was saved as, with its link and the warnings the entry returned. */
export function SavedRecipe({ result, engineId, testid }) {
  const i18n = useT();
  const { t } = i18n;
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return html`<div class="stack-sm" data-testid=${testid || "recipe-saved.root"}>
    <div class="notice notice-success" role="status" data-testid="recipe-saved.ok">
      <span class="grow">${t("models.recipe.saved", { id: result.recipeId })}</span>
      <a class="btn btn-sm" href=${recipeHref(result.recipe?.engineId || engineId, result.recipeId)} data-testid="recipe-saved.link">${t("models.recipe.open")}</a>
    </div>
    ${warnings.map((warning) => html`<div key=${warning.code} class="notice notice-warn" role="status" data-warning=${warning.code} data-testid="recipe-saved.warning">
      <span class="grow">${warningText(warning, i18n)}</span>
    </div>`)}
  </div>`;
}

/**
 * @param launchId the qualified launch
 * @param modelName a name to suggest the recipe id and the English title from
 * @param candidates lockCandidates(resolved values)
 * @param onClose() the drawer was dismissed
 * @param onSaved(result) the entry's save-recipe answer
 */
export function SaveRecipeDrawer({ launchId, modelName = "", candidates = [], onClose, onSaved }) {
  const { api, i18n } = useServices();
  const { t, tk } = i18n;
  const [draft, setDraft] = useState(() => blankRecipeDraft(modelName));
  const [errors, setErrors] = useState({});
  const [other, setOther] = useState([]);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));

  function fail(error) {
    const mapped = mapFieldErrors(error);
    const fields = { ...mapped.fields };
    if (existingRecipeSource(error) === "bundled") fields.recipeId = t("models.recipe.bundledExists");
    setErrors(fields);
    setOther(mapped.other);
    setFailure(Object.keys(fields).length || mapped.other.length ? null : error);
    queueMicrotask(() => globalThis.document?.querySelector?.('[data-testid="recipe-drawer.root"] [aria-invalid="true"]')?.focus?.());
  }

  async function send(replace) {
    const result = await api.post(`/api/launches/${enc(launchId)}/save-recipe`, saveRecipeBody(draft, { overwrite: replace }));
    onSaved?.(result);
    return result;
  }

  async function submit() {
    const found = validateRecipeDraft(draft);
    const messages = {};
    for (const [field, problem] of Object.entries(found)) messages[field] = t(problem.code === "required" ? "models.recipe.err.required" : "models.recipe.err.invalid");
    setErrors(messages);
    setOther([]);
    setFailure(null);
    if (Object.keys(messages).length) {
      queueMicrotask(() => globalThis.document?.querySelector?.('[data-testid="recipe-drawer.root"] [aria-invalid="true"]')?.focus?.());
      return;
    }
    setBusy(true);
    try {
      await send(false);
    } catch (error) {
      setBusy(false);
      if (error?.code === "recipe_exists" && existingRecipeSource(error) !== "bundled") setOverwrite(true);
      else fail(error);
    }
  }

  const toggleLock = (id, on) => set({ locks: on ? [...draft.locks, id] : draft.locks.filter((item) => item !== id) });

  const footer = html`
    <${Button} onClick=${() => onClose?.()} disabled=${busy} testid="recipe-drawer.cancel">${t("common.cancel")}<//>
    <${Button} variant="primary" busy=${busy} onClick=${submit} testid="recipe-drawer.submit">${t("models.recipe.submit")}<//>`;

  return html`<${Drawer} open width=${640} title=${t("models.recipe.title")} onClose=${busy ? undefined : onClose} footer=${footer} testid="recipe-drawer.root">
    <div class="stack">
      <p class="muted">${t("models.recipe.intro")}</p>
      ${failure ? html`<p class="notice notice-danger" role="alert" data-testid="recipe-drawer.error">
        ${describeError(failure, i18n)}${failure.hint ? ` ${failure.hint}` : ""}</p>` : null}
      <${FormField} label=${t("models.recipe.id")} hint=${t("models.recipe.idHint")} required error=${errors.recipeId} testid="recipe-drawer.field.recipeId">
        ${(props) => html`<input ...${props} class="input mono" value=${draft.recipeId} autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64"
          disabled=${busy} onInput=${(event) => set({ recipeId: event.currentTarget.value })} data-testid="recipe-drawer.recipeId" />`}
      <//>
      <${FormField} label=${t("models.recipe.titleZh")} required error=${errors["title.zh"]} testid="recipe-drawer.field.title-zh">
        ${(props) => html`<input ...${props} class="input" value=${draft.titleZh} autocomplete="off" lang="zh-CN" disabled=${busy}
          onInput=${(event) => set({ titleZh: event.currentTarget.value })} data-testid="recipe-drawer.titleZh" />`}
      <//>
      <${FormField} label=${t("models.recipe.titleEn")} required error=${errors["title.en"]} testid="recipe-drawer.field.title-en">
        ${(props) => html`<input ...${props} class="input" value=${draft.titleEn} autocomplete="off" lang="en" disabled=${busy}
          onInput=${(event) => set({ titleEn: event.currentTarget.value })} data-testid="recipe-drawer.titleEn" />`}
      <//>
      <${FormField} label=${t("models.recipe.scope")} hint=${t(tk("models.recipe.scope.", draft.scope, "hint"))} error=${errors.scope} testid="recipe-drawer.field.scope">
        ${(props) => html`<select ...${props} class="select" value=${draft.scope} disabled=${busy} onChange=${(event) => set({ scope: event.currentTarget.value })} data-testid="recipe-drawer.scope">
          ${SCOPES.map((scope) => html`<option key=${scope} value=${scope}>${t(tk("models.recipe.scope.", scope))}</option>`)}
        </select>`}
      <//>
      <fieldset class="field" data-testid="recipe-drawer.field.locks" aria-invalid=${errors.locks ? "true" : undefined}>
        <legend class="field-label">${t("models.recipe.locks")}</legend>
        <p class="field-hint">${t("models.recipe.locksHint")}</p>
        ${candidates.length ? html`<ul class="stack-sm" data-testid="recipe-drawer.locks">
          ${candidates.map((item) => html`<li key=${item.id}><label class="check">
            <input type="checkbox" checked=${draft.locks.includes(item.id)} disabled=${busy} onChange=${(event) => toggleLock(item.id, event.currentTarget.checked)} data-testid=${`recipe-drawer.lock.${item.id}`} />
            <code class="code-inline">${item.id}</code> <span class="muted small" data-user-content="">${preview(item.value)}</span>
          </label></li>`)}
        </ul>` : html`<p class="muted small">${t("models.recipe.noLocks")}</p>`}
        ${errors.locks ? html`<div class="field-error" data-testid="form-field.error">${errors.locks}</div>` : null}
      </fieldset>
      ${other.length ? html`<div class="notice notice-danger" role="alert" data-testid="recipe-drawer.problems">
        <div class="stack-sm"><strong>${t("models.recipe.problems")}</strong>
          <ul>${other.map((item, index) => html`<li key=${index}><code class="code-inline">${item.field}</code> <span data-user-content="">${item.message}</span></li>`)}</ul></div>
      </div>` : null}
    </div>
    <${ConfirmDialog} open=${overwrite} tone="danger" title=${t("models.recipe.overwriteTitle", { id: draft.recipeId })} body=${t("models.recipe.overwriteBody")}
      confirmLabel=${t("models.recipe.overwrite")} onConfirm=${() => send(true)} testid="recipe-drawer.overwrite"
      onClose=${(reason) => {
        setOverwrite(false);
        if (reason !== "confirmed") setBusy(false);
      }} />
  <//>`;
}
