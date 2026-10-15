// What every Observability page shares (07 §6.7): the header with the time
// range, the common filters, the auto-refresh toggle and the view link, the
// query hook that sends 04's parameters, the panel frame that shows its
// window, the chart panel with its edge-state notes, and the "Legacy
// statistics" card that stands in before 04 exists.
//
// The view state (range, filters, refresh) lives in the URL; see model.js.

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { metricLabelKey } from "../../data/metric-ids.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { TimeRangePicker, useRangeLabel } from "../../components/time-range-picker.js";
import { loadChart, loadLegacy, LazyView } from "./lazy.js";
import { useServices } from "../../ui/context.js";
import { useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useBootstrap } from "../../ui/shell.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "../../ui/vendor.js";
import { carrySearch, chartData, FILTER_IDS, isOtherGroup, isReadOnlyView, keyFor, onlyMetrics, OWNER_FILTERS, parseObsSearch, patchObsSearch, queryFor, REFRESH_MS, SUBPAGES, unsupportedMetrics } from "../../lib/observability-model.js";

function readSearch(services) {
  try {
    return globalThis.location?.search ?? services.router?.current?.search ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// View state

/**
 * The URL-backed view state of a page.
 * @returns {{ range, filters, refresh, rangeValid, rangeProblem, search, windowText, key,
 *   setRange(value), setFilters(patch), setRefresh(on), query(endpoint, extra), keyFor(endpoint), link(path, extra), refreshNow() }}
 */
export function useObsState({ fallback = "24h" } = {}) {
  const services = useServices();
  const rangeLabel = useRangeLabel();
  const latest = useRef(null);
  const [search, setSearch] = useState(() => readSearch(services));
  latest.current = search;
  useEffect(() => {
    const onPop = () => setSearch(readSearch(services));
    globalThis.addEventListener?.("popstate", onPop);
    return () => globalThis.removeEventListener?.("popstate", onPop);
  }, [services]);
  const state = useMemo(() => parseObsSearch(search, { fallback }), [search, fallback]);

  const commit = useCallback((patch) => {
    const next = patchObsSearch(latest.current, patch);
    latest.current = next;
    setSearch(next);
    try {
      const location = globalThis.location;
      const target = `${location.pathname}${next}${location.hash}`;
      if (services.router?.navigate) services.router.navigate(target, { replace: true });
      else globalThis.history.replaceState(globalThis.history.state, "", target);
    } catch {
      // Without a history (tests, previews) the state stays in memory.
    }
  }, [services]);

  return {
    range: state.range,
    filters: state.filters,
    refresh: state.refresh,
    rangeValid: state.rangeValid,
    rangeProblem: state.rangeProblem,
    search,
    windowText: rangeLabel(state.range, Date.now()),
    state,
    setRange: (value) => commit({ range: value }),
    setFilters: (filters) => commit({ filters }),
    setRefresh: (on) => commit({ refresh: on }),
    query: (endpoint, extra = {}) => queryFor(endpoint, state, Date.now(), extra),
    keyFor: (endpoint) => keyFor(endpoint, state),
    link: (path, extra = {}) => `${path}${carrySearch(search, extra)}`,
    refreshNow: () => {
      services.cache.invalidate(["telemetry"]);
      services.cache.invalidate(["alerts"]);
    },
  };
}

/**
 * One GET /api/telemetry/<name> over the page's window and filters.
 * @param extra the call's own parameters (04 §19), as the table lists them
 */
export function useTelemetry(obs, name, extra = {}, { enabled = true, ttlMs = 15_000 } = {}) {
  const { api } = useServices();
  return useQuery(["telemetry", name, obs.keyFor(name), JSON.stringify(extra)], () => api.get(`/api/telemetry/${name}`, { query: obs.query(name, extra) }), {
    ttlMs,
    refetchMs: obs.refresh ? REFRESH_MS : 0,
    enabled,
    keepPrevious: false,
  });
}

/** GET /api/telemetry/live: first paint and polling fallback; `telemetry.live` events replace it (lib/events.js). */
export function useLive({ enabled = true } = {}) {
  const { api } = useServices();
  return useQuery(["telemetry", "live"], () => api.get("/api/telemetry/live"), { ttlMs: 5000, refetchMs: 5000, enabled });
}

// ---------------------------------------------------------------------------
// Frames

/** A card whose first line is the window its numbers cover. */
export function Panel({ title, obs, windowText, note, actions, testid, children }) {
  const text = windowText ?? obs.windowText;
  return html`<${Card} title=${title} actions=${actions} testid=${testid}>
    <p class="small muted obs-window" data-window=${text} data-testid="obs.panel.window">${text}</p>
    ${note}
    ${children}
  <//>`;
}

/** The "widen the range" or "clear the filters" action an empty panel offers. */
export function useEmptyAction(obs) {
  const { t } = useT();
  if (Object.keys(obs.filters).length) return { label: t("obs.empty.clearFilters"), onClick: () => obs.setFilters(Object.fromEntries(FILTER_IDS.map((id) => [id, null]))) };
  const range = obs.range?.range;
  const next = { "15m": "1h", "1h": "6h", "6h": "24h", "24h": "7d", "7d": "30d" }[range] || "30d";
  return { label: t("obs.empty.widen"), onClick: () => obs.setRange({ range: next }) };
}

/** Skeleton while loading, the error with Retry, or `children(data)` once the answer is in. */
export function QueryView({ query, children, rows = 3, testid }) {
  const i18n = useT();
  const { t } = i18n;
  if (query.data === undefined && query.error) {
    return html`<div class="notice notice-warn" role="alert" data-testid=${testid || "obs.error"}>
      <span class="grow">${describeError(query.error, i18n)}</span>
      <${Button} size="sm" onClick=${() => query.refetch()} testid="obs.retry">${t("obs.retry")}<//>
    </div>`;
  }
  if (query.data === undefined) return html`<div aria-busy="true" data-testid="obs.loading"><${Skeleton} shape="line" rows=${rows} /></div>`;
  return children(query.data);
}

/** A table-less empty panel body with its next action. */
export function PanelEmpty({ obs, title, testid }) {
  const action = useEmptyAction(obs);
  return html`<${EmptyState} icon="search" title=${title} action=${action} testid=${testid || "obs.empty"} />`;
}

/** The label of a metric id (04 METRICS; every id has one in both catalogs). */
export function useMetricLabel() {
  const { t, has } = useT();
  return (metric) => (has(metricLabelKey(metric)) ? t(metricLabelKey(metric)) : metric);
}

/** The text of a series group: a model, a fleet, "GPU 0", an error class, or "other". */
export function useGroupText() {
  const { t, has } = useT();
  return (group) => {
    if (!group || typeof group !== "object") return "";
    if (isOtherGroup(group)) return t("obs.other");
    const entries = Object.entries(group);
    if (!entries.length) return "";
    return entries.map(([name, value]) => {
      if (name === "error_class" && has(tk("obs.err.", String(value)))) return t(tk("obs.err.", String(value)));
      if (name === "gpu") return t("obs.gpuName", { index: value });
      return String(value);
    }).join(" · ");
  };
}

/**
 * A chart over a timeseries answer, with the notes for its edge states: the
 * metrics the engine does not report (04 §19) and the collection gaps.
 * Brushing the plot narrows the time range.
 */
export function ChartPanel({ obs, title, query, metrics, live, stacked = false, annotate = false, height = 220, yUnits, testid }) {
  const { t } = useT();
  const metricLabel = useMetricLabel();
  const groupText = useGroupText();
  return html`<${Panel} title=${title} obs=${obs} testid=${testid}>
    <${QueryView} query=${query}>${(answer) => {
      const missing = unsupportedMetrics(answer, live).filter((metric) => !metrics || metrics.includes(metric));
      const chart = chartData(answer, { metricLabel, groupText, skip: (metric) => missing.includes(metric) });
      return html`<div class="stack-sm" data-testid=${testid ? `${testid}.body` : "obs.chart"}>
        ${missing.length ? html`<ul class="obs-notes small" data-testid="obs.unsupported">
          ${missing.map((metric) => html`<li key=${metric} data-metric=${metric}><strong>${metricLabel(metric)}</strong> · ${t("obs.noMetric")}</li>`)}
        </ul>` : null}
        <${LazyView} load=${loadChart} name="TimeSeriesChart" title=${title} window=${obs.windowText} x=${chart.x} series=${chart.series} stacked=${stacked}
          annotations=${annotate ? chart.annotations : []} height=${height} yUnits=${yUnits}
          onBrush=${(from, to) => obs.setRange({ from, to })} testid=${testid ? `${testid}.chart` : undefined} />
        ${chart.gaps > 0 && chart.points > 0 ? html`<p class="small muted obs-gap" data-testid="obs.gap">${t("obs.gap")}</p>` : null}
      </div>`;
    }}<//>
  <//>`;
}

/**
 * One small chart per metric of a timeseries answer, each with its own unit
 * scale. A metric the engine does not report (listed in `unsupported`, or
 * silent while its siblings report) reads "not reported", never an empty
 * chart and never 0 (04 §19).
 */
export function MetricGrid({ obs, answer, metrics, live, testid, height = 160 }) {
  const { t } = useT();
  const metricLabel = useMetricLabel();
  const groupText = useGroupText();
  const missing = unsupportedMetrics(answer, live);
  const chart = chartData(answer, { metricLabel, groupText });
  const reporting = chart.series.some((item) => item.values.some((value) => value !== null));
  return html`<div class="obs-engine-grid" data-testid=${testid || "obs.grid"}>
    ${metrics.map((metric) => {
      const part = onlyMetrics(chart, [metric]);
      const hasValues = part.series.some((item) => item.values.some((value) => value !== null));
      const notReported = missing.includes(metric) || (reporting && !hasValues);
      return html`<div key=${metric} data-metric=${metric} data-testid=${`${testid || "obs.grid"}.${metric}`}>
        <h3 class="obs-subtitle">${metricLabel(metric)}</h3>
        ${notReported ? html`<p class="muted small" data-testid="obs.metric.unsupported">${t("obs.noMetric")}</p>`
          : html`<${LazyView} load=${loadChart} name="TimeSeriesChart" title=${metricLabel(metric)} window=${obs.windowText} x=${part.x} series=${part.series} height=${height}
            onBrush=${(from, to) => obs.setRange({ from, to })} />
            ${part.series.length && part.series.some((item) => item.values.some((value) => value === null)) && hasValues ? html`<p class="small muted obs-gap" data-testid="obs.gap">${t("obs.gap")}</p>` : null}`}
      </div>`;
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Header

function Filters({ obs, live, readOnly }) {
  const { t } = useT();
  const active = Object.keys(obs.filters).length;
  const options = {
    model: [...new Set((live?.instances || []).map((item) => item.model).filter(Boolean))],
    fleet_id: [...new Set((live?.instances || []).map((item) => item.fleetId).filter(Boolean))],
    engine_id: [...new Set((live?.instances || []).map((item) => item.engineId).filter(Boolean))],
  };
  const ids = FILTER_IDS.filter((id) => !(readOnly && OWNER_FILTERS.includes(id)));
  return html`<details class="obs-filters" open=${active > 0} data-testid="obs.filters">
    <summary class="btn btn-sm" data-testid="obs.filters.toggle">${t("obs.filters.title")}${active ? html` <span class="tab-badge">${active}</span>` : null}</summary>
    <div class="obs-filter-grid">
      ${ids.map((id) => html`<div class="field" key=${id}>
        <label class="field-label" for=${`obs-filter-${id}`}>${t(tk("obs.filter.", id))}</label>
        <input class="input" id=${`obs-filter-${id}`} key=${`${id}:${obs.filters[id] || ""}`} type="text" defaultValue=${obs.filters[id] || ""} maxlength="200"
          list=${options[id] ? `obs-options-${id}` : undefined} autocomplete="off" spellcheck="false" data-testid=${`obs.filter.${id}`}
          onChange=${(event) => obs.setFilters({ [id]: event.currentTarget.value })} />
        ${options[id] ? html`<datalist id=${`obs-options-${id}`}>${options[id].map((value) => html`<option key=${value} value=${value}></option>`)}</datalist>` : null}
      </div>`)}
    </div>
  </details>`;
}

/** The header every sub-page starts with. */
export function ObsHeader({ obs, id, live, readOnly, bare = false }) {
  const services = useServices();
  const i18n = useT();
  const { t } = i18n;
  const role = useRole();
  const page = t(tk("obs.page.", id));
  const items = SUBPAGES.filter((item) => !(item.owner && role !== "owner"));

  async function copyLink() {
    const url = `${globalThis.location.origin}${globalThis.location.pathname}${obs.search}`;
    const { copyText } = await import("../../components/code-block.js");
    const ok = await copyText(url);
    services.toasts?.push?.({ level: ok ? "success" : "warn", title: t(ok ? "obs.linkCopied" : "common.copyFailed") });
  }

  return html`<div class="stack-sm obs-header" data-testid="obs.header">
    <${PageHeader} title=${page} breadcrumbs=${[{ label: t("obs.title"), href: obs.link("/observability") }, { label: page }]} />
    <nav aria-label=${t("obs.subnav")} data-testid="obs.subnav">
      <ul class="obs-subnav">
        ${items.map((item) => html`<li key=${item.id}><a class="obs-subnav-link" href=${obs.link(item.path)} aria-current=${item.id === id ? "page" : undefined} data-testid=${`obs.nav.${item.id}`}>${t(tk("obs.page.", item.id))}</a></li>`)}
      </ul>
    </nav>
    ${bare ? null : html`<section class="obs-toolbar" aria-label=${t("obs.toolbar")} data-testid="obs.toolbar">
      <${TimeRangePicker} value=${obs.range} onChange=${(value) => obs.setRange(value)} />
      <div class="row">
        <${Filters} obs=${obs} live=${live} readOnly=${readOnly} />
        <label class="row-nowrap obs-auto"><input type="checkbox" checked=${obs.refresh} data-testid="obs.auto-refresh" onChange=${(event) => obs.setRefresh(event.currentTarget.checked)} /> ${t("obs.refresh.auto")}</label>
        <${Button} size="sm" icon="refresh-cw" onClick=${obs.refreshNow} testid="obs.refresh-now">${t("obs.refresh.now")}<//>
        <${Button} size="sm" icon="copy" onClick=${copyLink} testid="obs.copy-link">${t("obs.copyLink")}<//>
      </div>
      ${Object.keys(obs.filters).length ? html`<ul class="obs-chips" aria-label=${t("obs.filters.active")} data-testid="obs.chips">
        ${Object.entries(obs.filters).map(([name, value]) => html`<li key=${name} class="chip chip-neutral" data-filter=${name}>
          <span>${t(tk("obs.filter.", name))}: <span class="mono" data-user-content>${value}</span></span>
          <button type="button" class="obs-chip-remove" aria-label=${t("obs.filters.remove", { name: t(tk("obs.filter.", name)) })} data-testid="obs.chip.remove" onClick=${() => obs.setFilters({ [name]: null })}>×</button>
        </li>`)}
      </ul>` : null}
      ${obs.rangeValid ? null : html`<p class="notice notice-warn" role="status" data-testid="obs.range-invalid">${t(tk("common.range.problem.", obs.rangeProblem || "invalid"), { days: 400 })} ${t("obs.rangeFallback")}</p>`}
    </section>`}
  </div>`;
}

/**
 * The frame of a sub-page: header, the read-only notice, then `children(obs)`
 * (a function, so a page without 04 never builds its panels) or, before 04,
 * the Legacy statistics card.
 * @param props.obs the page's useObsState()
 * @param props.bare no time range or filters (Settings has no window)
 * @param props.ownerOnly the page is only for the owner (a viewer sees the notice, not the panels)
 * @param props.readOnly the answers said they are redacted (summary `viewer: true`)
 */
export function ObsPage({ obs, id, ownerOnly = false, readOnly = false, bare = false, children, testid }) {
  const { t } = useT();
  const features = useBootstrap().features || {};
  const role = useRole();
  const live = useLive({ enabled: Boolean(features.telemetry) });
  const redacted = isReadOnlyView(role, readOnly ? { viewer: true } : null);
  return html`<div class="stack obs-page" data-page=${id} data-testid=${testid || `obs.${id}.root`}>
    <${ObsHeader} obs=${obs} id=${id} live=${live.data} readOnly=${redacted} bare=${bare} />
    ${redacted ? html`<p class="notice notice-info" role="status" data-testid="obs.read-only">${t("obs.lanReadOnly")}</p>` : null}
    ${!features.telemetry ? html`<${LazyView} load=${loadLegacy} name="LegacyStats" obs=${obs} />` : ownerOnly && role !== "owner" ? null : children(obs)}
  </div>`;
}
