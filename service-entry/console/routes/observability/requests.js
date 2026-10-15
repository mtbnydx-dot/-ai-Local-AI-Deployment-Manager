// Observability › Requests `/observability/requests` (07 §6.7, 04 §11.5, §19):
// a chart of the request count by status class over the window, the cursor
// table of the requests in it with the facet sidebar, the request-only
// filters and the owner's server-side export. Brushing the chart narrows the
// window, and the table follows; every filter lives in the URL.

import { tk } from "../../lib/i18n.js";
import { REFRESH_MS } from "../../lib/observability-model.js";
import { appendRows, cleanFilter, facetGroups, facetToggle, MIN_ID_QUERY, parseRequestFilters, requestsPage, requestsQuery, REQUEST_FILTER_IDS, seriesFilters, TERMINAL_STATES } from "../../lib/requests-model.js";
import { Button } from "../../components/button.js";
import { ChartPanel, ObsPage, Panel, QueryView, useLive, useObsState, useTelemetry } from "./common.js";
import { loadRequestsTable, LazyView } from "./lazy.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";
import { useMemo, useRef, useState } from "../../ui/vendor.js";

const SERIES = { metrics: "req.count", groupBy: "status_class" };

// ---------------------------------------------------------------------------
// Data: the first page (with the facets) and the pages the person loads after it

function useRequestList(obs, filters, enabled) {
  const { api } = useServices();
  const ran = useRef(null);
  const id = `${obs.keyFor("requests")}|${JSON.stringify(filters)}`;
  const first = useQuery(["telemetry", "requests", id], () => {
    ran.current = requestsQuery(obs.state, filters, Date.now(), { facets: true });
    return api.get("/api/telemetry/requests", { query: ran.current });
  }, { ttlMs: 15_000, refetchMs: obs.refresh ? REFRESH_MS : 0, enabled, keepPrevious: false });

  // Pages after the first. They belong to one view (id) and are dropped when it changes.
  const [more, setMore] = useState({ id, rows: [], cursor: undefined, loading: false, error: null });
  const current = more.id === id ? more : { id, rows: [], cursor: undefined, loading: false, error: null };
  const page = useMemo(() => requestsPage(first.data), [first.data]);

  async function loadMore() {
    const cursor = current.cursor === undefined ? page.cursor : current.cursor;
    if (!cursor || current.loading) return;
    setMore({ ...current, loading: true, error: null });
    const query = { ...(ran.current || requestsQuery(obs.state, filters, Date.now())), cursor };
    delete query.facets;
    try {
      const next = requestsPage(await api.get("/api/telemetry/requests", { query }));
      setMore((previous) => (previous.id !== id ? previous : { id, rows: appendRows(previous.rows, next.rows), cursor: next.cursor, loading: false, error: null }));
    } catch (error) {
      setMore((previous) => (previous.id !== id ? previous : { ...previous, loading: false, error }));
    }
  }

  return {
    query: first,
    page,
    rows: appendRows(page.rows, current.rows),
    cursor: current.cursor === undefined ? page.cursor : current.cursor,
    loading: current.loading,
    error: current.error,
    loadMore,
  };
}

// ---------------------------------------------------------------------------
// Facets and filters

function Facets({ page, obs, filters }) {
  const { t, has } = useT();
  const groups = facetGroups(page.facets, obs.state, filters).filter((group) => group.items.length);
  const label = (group, value) => {
    if (group.id === "error_class" && has(tk("obs.err.", value))) return t(tk("obs.err.", value));
    return value;
  };
  if (!groups.length) return null;
  return html`<aside class="req-facets stack-sm" aria-label=${t("obs.req.facets")} data-testid="obs.req.facets">
    ${groups.map((group) => html`<section key=${group.id} class="req-facet" data-facet=${group.id}>
      <h3 class="obs-subtitle">${t(tk("obs.req.facet.", group.id))}</h3>
      <ul class="req-facet-list">
        ${group.items.slice(0, 8).map((item) => html`<li key=${item.value}>
          <button type="button" class="req-facet-item" aria-pressed=${item.active ? "true" : "false"} data-value=${item.value} data-testid="obs.req.facet.item"
            onClick=${() => obs.apply(facetToggle(group, item.value, obs.state, filters))}>
            <span class="req-facet-name" data-user-content>${label(group, item.value)}</span>
            <span class="req-facet-count tabular">${item.count}</span>
          </button>
        </li>`)}
      </ul>
    </section>`)}
    ${page.facetsTruncated ? html`<p class="small muted" role="note" data-testid="obs.req.facets.truncated">${t("obs.req.facetsTruncated")}</p>` : null}
  </aside>`;
}

function FilterForm({ obs, filters }) {
  const { t } = useT();
  // The form holds the filters the facets do not cover.
  const count = Object.keys(filters).filter((name) => !["status_class", "error_class"].includes(name)).length;
  const [key, setKey] = useState(0);
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patch = {};
    for (const name of ["q", "terminal_state", "min_ttft_ms", "min_duration_ms", "min_output_tokens", "client_ip"]) patch[name] = cleanFilter(name, form.get(name));
    obs.setExtra(patch);
  }
  const field = (name, props = {}) => html`<div class="field">
    <label class="field-label" for=${`req-filter-${name}`}>${t(tk("obs.req.filter.", name))}</label>
    <input class="input" id=${`req-filter-${name}`} name=${name} type="text" autocomplete="off" spellcheck="false" defaultValue=${filters[name] || ""} data-testid=${`obs.req.filter.${name}`} ...${props} />
  </div>`;
  return html`<details class="req-filters" open=${count > 0} data-testid="obs.req.filters">
    <summary class="btn btn-sm" data-testid="obs.req.filters.toggle">${t("obs.req.moreFilters")}${count ? html` <span class="tab-badge">${count}</span>` : null}</summary>
    <form class="req-filter-form" key=${key} data-testid="obs.req.filter-form" onSubmit=${submit}>
      <div class="obs-filter-grid">
        ${field("q", { maxlength: 128, placeholder: "req_…" })}
        <div class="field">
          <label class="field-label" for="req-filter-terminal_state">${t("obs.req.filter.terminal_state")}</label>
          <select class="select" id="req-filter-terminal_state" name="terminal_state" defaultValue=${filters.terminal_state || ""} data-testid="obs.req.filter.terminal_state">
            <option value="">${t("obs.req.any")}</option>
            ${TERMINAL_STATES.map((state) => html`<option key=${state} value=${state}>${t(tk("obs.term.", state))}</option>`)}
          </select>
        </div>
        ${field("min_ttft_ms", { inputmode: "numeric", maxlength: 12 })}
        ${field("min_duration_ms", { inputmode: "numeric", maxlength: 12 })}
        ${field("min_output_tokens", { inputmode: "numeric", maxlength: 12 })}
        ${field("client_ip", { maxlength: 64 })}
      </div>
      <p class="small muted">${t("obs.req.qHint", { n: MIN_ID_QUERY })}</p>
      <div class="row">
        <${Button} type="submit" variant="primary" size="sm" testid="obs.req.apply">${t("obs.req.apply")}<//>
        <${Button} size="sm" disabled=${!Object.keys(filters).length} onClick=${() => {
          setKey((value) => value + 1);
          obs.setExtra(Object.fromEntries(REQUEST_FILTER_IDS.map((name) => [name, null])));
        }} testid="obs.req.clear">${t("obs.req.clear")}<//>
      </div>
    </form>
  </details>`;
}

function Chips({ obs, filters }) {
  const { t, has } = useT();
  const entries = Object.entries(filters);
  if (!entries.length) return null;
  const valueText = (name, value) => (name === "terminal_state" && has(tk("obs.term.", value)) ? t(tk("obs.term.", value)) : value);
  return html`<ul class="obs-chips" aria-label=${t("obs.req.activeFilters")} data-testid="obs.req.chips">
    ${entries.map(([name, value]) => html`<li key=${name} class="chip chip-neutral" data-filter=${name}>
      <span>${t(tk("obs.req.filter.", name))}: <span class="mono" data-user-content>${valueText(name, value)}</span></span>
      <button type="button" class="obs-chip-remove" aria-label=${t("obs.filters.remove", { name: t(tk("obs.req.filter.", name)) })} data-testid="obs.req.chip.remove"
        onClick=${() => obs.setExtra({ [name]: null })}>×</button>
    </li>`)}
  </ul>`;
}

// ---------------------------------------------------------------------------
// Page

function Body({ obs, telemetry }) {
  const { t } = useT();
  const filters = useMemo(() => parseRequestFilters(obs.search), [obs.search]);
  const live = useLive({ enabled: telemetry });
  const series = useTelemetry(obs, "timeseries", { ...SERIES, ...seriesFilters(filters) }, { enabled: telemetry });
  const list = useRequestList(obs, filters, telemetry);
  return html`
    <${ChartPanel} obs=${obs} title=${t("obs.panel.requestsOverTime")} query=${series} metrics=${["req.count"]} live=${live.data} stacked=${true} testid="obs.req.chart" />
    <${Panel} title=${t("obs.page.requests")} obs=${obs} windowText=${filters.q ? t("obs.req.allTime") : undefined} testid="obs.req.panel">
      <div class="stack-sm">
        <p class="small muted">${t("obs.req.brushHint")}</p>
        ${filters.q ? html`<p class="notice notice-info" role="status" data-testid="obs.req.q-note">${t("obs.req.qIgnoresWindow")}</p>` : null}
        <${FilterForm} obs=${obs} filters=${filters} />
        <${Chips} obs=${obs} filters=${filters} />
        <${QueryView} query=${list.query} testid="obs.req.error">${() => html`<div class=${facetGroups(list.page.facets, obs.state, filters).some((group) => group.items.length) ? "req-layout" : "req-layout req-layout-single"}>
          <${Facets} page=${list.page} obs=${obs} filters=${filters} />
          <div class="req-main"><${LazyView} load=${loadRequestsTable} name="RequestsTable" obs=${obs} list=${list} filters=${filters} /></div>
        </div>`}<//>
      </div>
    <//>
  `;
}

export default function ObservabilityRequests() {
  const obs = useObsState();
  const telemetry = Boolean(useBootstrap().features?.telemetry);
  return html`<${ObsPage} obs=${obs} id="requests" ownerOnly=${true}>${() => html`<${Body} obs=${obs} telemetry=${telemetry} />`}<//>`;
}
