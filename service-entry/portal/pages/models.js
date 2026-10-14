// Models catalog (05 §12.3). Without a key it shows /catalog.json; with a key in
// sessionStorage it also reads the key's own /v1/models, marks what the key can
// use and shows the key's limits and prices.

import { useMemo, useState } from "preact/hooks";
import { html } from "../lib/html.js";
import { usePortal, usePageTitle } from "../lib/context.js";
import { useResource } from "../lib/hooks.js";
import { getCatalog, getKeyModels } from "../lib/api.js";
import { modelMatches } from "../lib/format.js";
import { fromCatalog, fromKeyModel, mergeModels, passesFilters } from "../lib/models.js";
import { ModelCard } from "../components/model-card.js";
import { EmptyState, ErrorNotice, Loading } from "../components/notice.js";

const REFRESH_MS = 60_000;

/**
 * Loads the catalog and, with a key, the key's models. A key the server rejects
 * is reported (`keyError`) and the catalog still shows; the page never hides
 * models because of a bad key.
 */
export function useModelList() {
  const { lang, key } = usePortal();
  const catalog = useResource((signal) => getCatalog({ signal }), [], { intervalMs: REFRESH_MS });
  const keyed = useResource(
    (signal) => getKeyModels(key, { signal }).then((doc) => (Array.isArray(doc?.data) ? doc.data : [])),
    [key],
    { enabled: Boolean(key), intervalMs: REFRESH_MS },
  );
  const list = useMemo(() => {
    if (!catalog.data) return null;
    const base = (Array.isArray(catalog.data.models) ? catalog.data.models : []).map((entry) => fromCatalog(entry, lang));
    const mine = key && keyed.data ? keyed.data.map(fromKeyModel) : null;
    return mergeModels(base, mine);
  }, [catalog.data, keyed.data, key, lang]);
  return { list, catalog, keyed, hasKey: Boolean(key) };
}

function FilterToggle({ id, label, pressed, onToggle }) {
  return html`<button type="button" class=${`filter${pressed ? " is-on" : ""}`} aria-pressed=${String(pressed)} data-filter=${id} onClick=${() => onToggle(id)}>${label}</button>`;
}

export default function ModelsPage() {
  const { t } = usePortal();
  usePageTitle(t("nav.models"));
  const { list, catalog, keyed, hasKey } = useModelList();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({});
  const toggle = (id) => setFilters((previous) => ({ ...previous, [id]: !previous[id] }));
  const shown = (list || []).filter((model) => modelMatches({ ...model, display_name: model.name }, query) && passesFilters(model, filters));
  const keyOk = hasKey && keyed.data && !keyed.error;
  // Only a 401 or 403 says the key itself is wrong; a timeout says nothing about it.
  const rejected = [401, 403].includes(keyed.error?.status);

  return html`<div class="page page-models">
    <h1>${t("models.title")}</h1>
    <p class="lead">${t("models.lead")}</p>
    ${hasKey
      ? keyed.error
        ? rejected
          ? html`<p class="notice notice-warn" role="status">${t("models.key_rejected")} <a href="/me">${t("models.key_manage")}</a></p>`
          : html`<p class="notice notice-warn" role="status">${t("models.key_unreachable")}</p>`
        : keyOk ? html`<p class="notice notice-info" role="status">${t("models.key_active")}</p>` : null
      : html`<p class="muted">${t("models.no_key")} <a href="/me">${t("models.key_add")}</a></p>`}
    <div class="toolbar">
      <div class="field">
        <label for="model-search">${t("models.search")}</label>
        <input id="model-search" type="search" value=${query} placeholder=${t("models.search_placeholder")} onInput=${(event) => setQuery(event.currentTarget.value)} autocomplete="off" />
      </div>
      <div class="filters" role="group" aria-label=${t("models.filters")}>
        <${FilterToggle} id="vision" label=${t("tag.vision")} pressed=${Boolean(filters.vision)} onToggle=${toggle} />
        <${FilterToggle} id="tools" label=${t("tag.tools")} pressed=${Boolean(filters.tools)} onToggle=${toggle} />
        <${FilterToggle} id="reasoning" label=${t("tag.reasoning")} pressed=${Boolean(filters.reasoning)} onToggle=${toggle} />
        ${keyOk ? html`<${FilterToggle} id="available" label=${t("models.only_available")} pressed=${Boolean(filters.available)} onToggle=${toggle} />` : null}
      </div>
    </div>
    ${catalog.loading && !list ? html`<${Loading} />` : null}
    ${catalog.error && !list ? html`<${ErrorNotice} error=${catalog.error} onRetry=${catalog.reload} />` : null}
    ${list && !list.length ? html`<${EmptyState} title=${t("models.empty")}><p class="muted">${t("models.empty_hint")}</p><//>` : null}
    ${list && list.length && !shown.length ? html`<${EmptyState} title=${t("models.no_match")} />` : null}
    ${shown.length ? html`<p class="muted small" aria-live="polite">${t("models.count", { shown: shown.length, total: list.length })}</p>
      <div class="grid grid-models">${shown.map((model) => html`<${ModelCard} key=${model.id} model=${model} />`)}</div>` : null}
  </div>`;
}
