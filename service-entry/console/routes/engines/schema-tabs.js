// The Parameters and Recipes tabs (07 §6.5), both read from
// GET /api/m/:id/engines/:engineId/schema?runtime=<runtimeId> (01 §21.1).
//
// Parameters is SchemaForm in catalog mode, so every parameter carries its
// availability badge (`Not in this runtime`, `Unverified`). Recipes lists the
// schema's `recipes[]` with status, eligibility, score, reasons and locks.
// This module is loaded on demand: SchemaForm is the largest component.

import { recipeRows } from "../../lib/engines-model.js";
import { SchemaCatalogGuard } from "../../lib/schemas.js";
import { EmptyState } from "../../components/empty-state.js";
import { SchemaForm } from "../../components/schema-form.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useId } from "../../ui/vendor.js";
import { TableWrap } from "./engine-parts.js";

const enc = encodeURIComponent;
const NO_VALUES = Object.freeze({});
const RECIPE_BADGE = Object.freeze({ verified: "ok", experimental: "warn", blocked: "error" });

function useEngineSchema(engine, runtimeId) {
  const { api } = useServices();
  return useQuery(
    ["engines", "schema", engine.managerId, engine.engineId, runtimeId || "default"],
    () => api.manager(engine.managerId).get(`/engines/${enc(engine.engineId)}/schema`, { query: runtimeId ? { runtime: runtimeId } : {}, guard: SchemaCatalogGuard }),
    { ttlMs: 30000 },
  );
}

function RuntimePicker({ engine, value, onChange }) {
  const { t } = useT();
  const id = useId();
  const runtimes = Array.isArray(engine.runtimes) ? engine.runtimes : [];
  return html`<div class="field"><label class="field-label" for=${id}>${t("engines.page.schema.runtime")}</label>
    <select id=${id} class="select" value=${value} onChange=${(event) => onChange(event.currentTarget.value)} data-testid="engine-schema.runtime">
      ${runtimes.map((runtime) => html`<option key=${runtime.runtimeId} value=${runtime.runtimeId}>${runtime.runtimeId}</option>`)}
    </select></div>`;
}

function SchemaState({ query, children }) {
  const { t } = useT();
  if (query.data) return children(query.data);
  if (query.error) {
    return html`<div class="notice notice-danger" role="alert" data-testid="engine-schema.error">
      <span class="grow">${t("engines.page.schema.failed")}</span>
      <button type="button" class="btn btn-sm" onClick=${() => query.refetch()}>${t("engines.page.retry")}</button></div>`;
  }
  return html`<div aria-busy="true"><${Skeleton} shape="table" rows=${5} /></div>`;
}

export function ParametersTab({ engine, runtimeId, onRuntimeChange, label }) {
  const { t } = useT();
  const schema = useEngineSchema(engine, runtimeId);
  return html`<div class="stack" data-testid="engine-parameters">
    <${RuntimePicker} engine=${engine} value=${runtimeId} onChange=${onRuntimeChange} />
    <${SchemaState} query=${schema}>${(data) => html`
      ${data.runtime && data.runtime.introspected === false
        ? html`<div class="notice notice-warn" data-testid="engine-parameters.unverified">${t("engines.page.schema.notIntrospected")}</div>` : null}
      <${SchemaForm} catalog=${data} mode="catalog" values=${NO_VALUES} engineLabel=${label} testid="engine-parameters.form" />`}<//>
  </div>`;
}

function Reasons({ codes }) {
  const { t, has, tk } = useT();
  if (!codes.length) return html`<span class="muted">—</span>`;
  return html`<span class="row">${codes.map((code) => html`<span key=${code} class="badge badge-neutral" data-reason=${code}>${has(tk("engines.page.recipe.reason.", code)) ? t(tk("engines.page.recipe.reason.", code)) : code}</span>`)}</span>`;
}

export function RecipesTab({ engine, runtimeId, onRuntimeChange }) {
  const { t, pick, tk } = useT();
  const schema = useEngineSchema(engine, runtimeId);
  return html`<div class="stack" data-testid="engine-recipes">
    <${RuntimePicker} engine=${engine} value=${runtimeId} onChange=${onRuntimeChange} />
    <${SchemaState} query=${schema}>${(data) => {
      const rows = recipeRows(data);
      if (!rows.length) return html`<${EmptyState} title=${t("engines.page.recipes.none")} body=${t("engines.page.recipes.noneBody")} action=${{ label: t("engines.page.recipes.action"), href: "/deployments" }} />`;
      return html`<${TableWrap} label=${t("engines.page.recipes.caption")}><table class="table">
        <caption class="sr-only">${t("engines.page.recipes.caption")}</caption>
        <thead><tr>
          <th scope="col">${t("engines.page.recipes.recipe")}</th><th scope="col">${t("engines.page.recipes.status")}</th><th scope="col">${t("engines.page.recipes.eligible")}</th>
          <th scope="col">${t("engines.page.recipes.score")}</th><th scope="col">${t("engines.page.recipes.reasons")}</th><th scope="col">${t("engines.page.recipes.locks")}</th>
        </tr></thead>
        <tbody>${rows.map((row) => html`<tr key=${row.id} data-testid="engine-recipe" data-recipe=${row.id}>
          <th scope="row"><span data-user-content="">${row.label ? pick(row.label) : row.id}</span><div class="xsmall muted mono">${row.id}</div></th>
          <td><${StatusBadge} status=${RECIPE_BADGE[row.status]} label=${t(tk("engines.page.recipes.status.", row.status))} /></td>
          <td>${row.eligible === null ? html`<span class="muted">—</span>` : t(row.eligible ? "engines.page.recipes.yes" : "engines.page.recipes.no")}</td>
          <td class="num">${row.score === null ? "—" : row.score}</td>
          <td><${Reasons} codes=${row.reasons} /></td>
          <td>${row.locks.length ? html`<ul class="stack-sm">${row.locks.map((lock) => html`<li key=${lock.param}><code class="code-inline">${lock.param}</code> = <code class="code-inline">${String(lock.value)}</code>
            ${lock.reason ? html`<div class="xsmall muted" data-user-content="">${pick(lock.reason)}</div>` : null}</li>`)}</ul>` : html`<span class="muted">—</span>`}</td>
        </tr>`)}</tbody></table><//>`;
    }}<//>
  </div>`;
}
