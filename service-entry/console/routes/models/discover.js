// /models/discover (07 §6.4 "Discover"): search Hugging Face, the Hugging Face
// mirror or ModelScope, and open the download plan sheet.
//
// The search (GET /api/hub/search, 03 §13.2) is debounced by 300 ms. The
// facets are server side, so the result count stays honest: fits this GPU,
// engine, format, size class, vision/audio, MoE, gated and "updated within".
// Repositories that share a base model are variants of one family card; a
// variant chip reads `FP8 · 30 GiB · Fits`, and "In library" / "Update
// available" badges come from the hub's library state. Results continue with
// the opaque cursor ("Load more"); a changed form starts over, because the hub
// answers `cursor_mismatch` for a cursor of another search.
//
// The page is also the Deployment wizard's search (CON-11): `embedded` drops
// the header and the plan sheet, and `onPick(modelRef)` takes the repository.
// The plan sheet (download-plan.js) loads when it is first opened and mirrors
// its target into ?drawer=plan&provider=&repo=... so a reload or a shared link
// reopens it.

import { describeError } from "../../lib/api.js";
import {
  EMPTY_SEARCH, FORMAT_FACETS, MODALITY_FACETS, PAGE_SIZE, SEARCH_SOURCES, SIZE_FACETS, SORTS, UPDATED_FACETS,
  activeFacetCount, detailHref, facetValues, familyCards, planTargetFromQuery, planTargetParams, remoteRef, searchKey, searchQuery,
} from "../../lib/discover-model.js";
import { degradable } from "../../lib/library-model.js";
import { Button } from "../../components/button.js";
import { EmptyState } from "../../components/empty-state.js";
import { Icon } from "../../components/icon.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { replaceQueryParam } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useFormat, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import { ModelsNav } from "./subnav.js";

const FIT_TONE = Object.freeze({ fits: "badge-success", tight: "badge-warn", spills: "badge-warn", "wont-fit": "badge-danger", unknown: "badge-neutral" });
const FIT_ICON = Object.freeze({ fits: "check", tight: "triangle-alert", spills: "triangle-alert", "wont-fit": "circle-x", unknown: "circle-help" });
const EMPTY_PAGES = Object.freeze({ items: [], facets: {}, nextCursor: "", partial: false, warnings: [], fetchedFrom: "" });

// ---- the search state (first page, then cursor pages) --------------------------------------------

function useSearch(form) {
  const { api } = useServices();
  const [state, setState] = useState({ ...EMPTY_PAGES, status: "loading", error: null, more: false });
  const [tick, setTick] = useState(0);
  const key = searchKey(form);
  const formRef = useRef(form);
  formRef.current = form;
  const latest = useRef(0);

  useEffect(() => {
    const run = (latest.current += 1);
    setState({ ...EMPTY_PAGES, status: "loading", error: null, more: false });
    api.get("/api/hub/search", { query: searchQuery(formRef.current) }).then((body) => {
      if (run !== latest.current) return;
      setState({
        items: Array.isArray(body?.items) ? body.items : [], facets: body?.facets || {}, nextCursor: typeof body?.nextCursor === "string" ? body.nextCursor : "",
        partial: body?.partial === true, warnings: Array.isArray(body?.warnings) ? body.warnings : [], fetchedFrom: typeof body?.fetchedFrom === "string" ? body.fetchedFrom : "",
        status: "ready", error: null, more: false,
      });
    }, (error) => {
      if (run === latest.current) setState({ ...EMPTY_PAGES, status: "error", error, more: false });
    });
    return () => {
      latest.current += 1;
    };
  }, [key, tick]);

  async function loadMore() {
    const run = latest.current;
    setState((current) => ({ ...current, more: true }));
    try {
      const body = await api.get("/api/hub/search", { query: searchQuery(formRef.current, { cursor: state.nextCursor }) });
      if (run !== latest.current) return;
      setState((current) => {
        const known = new Set(current.items.map((item) => item.repo));
        return {
          ...current,
          items: [...current.items, ...(Array.isArray(body?.items) ? body.items.filter((item) => !known.has(item.repo)) : [])],
          nextCursor: typeof body?.nextCursor === "string" ? body.nextCursor : "",
          partial: body?.partial === true,
          warnings: [...current.warnings, ...(Array.isArray(body?.warnings) ? body.warnings : [])],
          more: false,
        };
      });
    } catch (error) {
      if (run === latest.current) setState((current) => ({ ...current, more: false, moreError: error }));
    }
  }
  return { ...state, reload: () => setTick((value) => value + 1), loadMore };
}

// ---- cards --------------------------------------------------------------------------------------

function Chip({ variant }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  const tone = FIT_TONE[variant.fit];
  return html`<span class=${`badge ${tone}`} data-testid="discover.chip" data-fit=${variant.fit} title=${variant.estimate ? t("hub.fit.basis.params") : undefined}>
    <${Icon} name=${FIT_ICON[variant.fit]} />
    <span>${variant.label || "—"}${variant.neededMb ? ` · ${variant.estimate ? "~" : ""}${fmt.bytes(variant.neededMb * 1048576)}` : ""} · ${t(tk("hub.fit.", variant.fit))}</span>
  </span>`;
}

function LibraryBadge({ state }) {
  const { t } = useT();
  if (state === "update-available") return html`<span class="badge badge-info" data-testid="discover.badge.update">${t("hub.discover.badge.update")}</span>`;
  if (state === "present") return html`<span class="badge badge-success" data-testid="discover.badge.library">${t("hub.detail.quants.inLibrary")}</span>`;
  if (state === "partial") return html`<span class="badge badge-warn" data-testid="discover.badge.partial">${t("hub.discover.badge.partial")}</span>`;
  return null;
}

function VariantRow({ variant, owner, embedded, onDownload, onPick }) {
  const { t } = useT();
  const fmt = useFormat();
  const href = detailHref(variant.provider, variant.repo);
  return html`<li class="family-variant" data-testid="discover.variant" data-repo=${variant.repo}>
    <div class="stack-sm grow">
      <span class="row">
        ${embedded || !href ? html`<strong data-user-content="">${variant.repo}</strong>` : html`<a href=${href} data-user-content="" data-testid="discover.repo">${variant.repo}</a>`}
        <${LibraryBadge} state=${variant.libraryState} />
        ${variant.gated ? html`<span class="badge badge-warn" data-testid="discover.badge.gated"><${Icon} name="lock" /> ${t("hub.discover.badge.gated")}</span>` : null}
      </span>
      <span class="row"><${Chip} variant=${variant} />
        ${variant.downloads ? html`<span class="xsmall muted num">${t("hub.discover.downloads", { count: fmt.integer(variant.downloads) })}</span>` : null}
        ${variant.lastModified ? html`<span class="xsmall muted"><time dateTime=${variant.lastModified}>${fmt.relative(variant.lastModified)}</time></span>` : null}</span>
    </div>
    <div class="row-nowrap family-variant-actions">
      ${embedded ? html`<${Button} size="sm" variant="primary" onClick=${() => onPick(variant)} testid="discover.pick">${t("hub.discover.use")}<//>`
        : html`<${Button} size="sm" href=${href} testid="discover.details">${t("hub.discover.details")}<//>
          ${owner ? html`<${Button} size="sm" variant="primary" onClick=${() => onDownload(variant)} testid="discover.download">${t("hub.detail.action.download")}<//>` : null}`}
    </div>
  </li>`;
}

function FamilyCard({ card, ...rest }) {
  const { t } = useT();
  return html`<article class="card family-card" data-testid="discover.card" data-family=${card.key}>
    <div class="row"><h2 class="card-title grow" data-user-content="">${card.title}</h2>
      ${card.variants.length > 1 ? html`<span class="badge badge-neutral">${t("hub.discover.variants", { count: card.variants.length })}</span>` : null}</div>
    <ul class="family-variants">${card.variants.map((variant) => html`<${VariantRow} key=${variant.key} variant=${variant} ...${rest} />`)}</ul>
  </article>`;
}

// ---- the form ------------------------------------------------------------------------------------

function Select({ id, label, value, onChange, children }) {
  return html`<label class="deploy-filter">
    <span class="small muted">${label}</span>
    <select class="select" value=${value} data-testid=${`discover.${id}`} onChange=${(event) => onChange(event.currentTarget.value)}>${children}</select>
  </label>`;
}

function SearchForm({ form, setForm, facets }) {
  const { t, tk } = useT();
  const any = html`<option value="">${t("hub.library.filter.all")}</option>`;
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const engines = facetValues(facets, "engine");
  const options = (values, prefix, selected) => values.map((value) => html`<option key=${value} value=${value} selected=${selected === value}>${t(tk(prefix, value))}</option>`);
  return html`<div class="stack-sm" role="search" aria-label=${t("hub.discover.title")}>
    <div class="row deploy-filters">
      <label class="deploy-filter grow">
        <span class="small muted">${t("hub.library.filter.search")}</span>
        <input class="input" type="search" value=${form.q} placeholder=${t("hub.discover.placeholder")} autocomplete="off" data-testid="discover.q"
          onInput=${(event) => set({ q: event.currentTarget.value })} />
      </label>
      <${Select} id="source" label=${t("hub.discover.source")} value=${form.source} onChange=${(source) => set({ source })}>
        ${options(SEARCH_SOURCES.map((source) => source.id), "hub.discover.source.", form.source)}<//>
      <${Select} id="sort" label=${t("hub.discover.sort")} value=${form.sort} onChange=${(sort) => set({ sort })}>
        ${options(SORTS, "hub.discover.sort.", form.sort)}<//>
    </div>
    <div class="row deploy-filters" role="group" aria-label=${t("hub.library.filter.label")}>
      <label class="row-nowrap"><input type="checkbox" checked=${form.fit} data-testid="discover.fit" onChange=${(event) => set({ fit: event.currentTarget.checked })} />
        <span class="small">${t("hub.discover.facet.fit")}</span></label>
      <label class="row-nowrap"><input type="checkbox" checked=${form.moe} data-testid="discover.moe" onChange=${(event) => set({ moe: event.currentTarget.checked })} />
        <span class="small">${t("hub.discover.facet.moe")}</span></label>
      <${Select} id="engine" label=${t("hub.library.filter.engine")} value=${form.engine} onChange=${(engine) => set({ engine })}>
        ${any}${engines.map((entry) => html`<option key=${entry.value} value=${entry.value} selected=${form.engine === entry.value}>${entry.value} (${entry.count})</option>`)}${form.engine && !engines.some((entry) => entry.value === form.engine) ? html`<option value=${form.engine} selected>${form.engine}</option>` : null}<//>
      <${Select} id="format" label=${t("hub.library.filter.format")} value=${form.format} onChange=${(format) => set({ format })}>
        ${any}${FORMAT_FACETS.map((value) => html`<option key=${value} value=${value} selected=${form.format === value}>${value}</option>`)}<//>
      <${Select} id="size" label=${t("hub.discover.facet.size")} value=${form.size} onChange=${(size) => set({ size })}>
        ${any}${options(SIZE_FACETS, "hub.discover.size.", form.size)}<//>
      <${Select} id="modality" label=${t("hub.discover.facet.modality")} value=${form.modality} onChange=${(modality) => set({ modality })}>
        ${any}${options(MODALITY_FACETS, "hub.discover.modality.", form.modality)}<//>
      <${Select} id="gated" label=${t("hub.discover.facet.gated")} value=${form.gated} onChange=${(gated) => set({ gated })}>
        ${any}${options(["true", "false"], "hub.discover.gated.", form.gated)}<//>
      <${Select} id="updated" label=${t("hub.discover.facet.updated")} value=${form.updated} onChange=${(updated) => set({ updated })}>
        ${any}${options(UPDATED_FACETS, "hub.discover.updated.", form.updated)}<//>
      ${activeFacetCount(form) ? html`<${Button} size="sm" variant="ghost" onClick=${() => setForm((current) => ({ ...EMPTY_SEARCH, q: current.q, source: current.source, sort: current.sort }))} testid="discover.clear">${t("hub.discover.clear")}<//>` : null}
    </div>
  </div>`;
}

function PasteLink({ onResolved }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve() {
    const url = value.trim();
    if (!url) return;
    setBusy(true);
    setError("");
    try {
      const body = await api.post("/api/hub/resolve-link", { url });
      const link = body?.link ?? body?.resolved ?? body;
      if (!link?.repo) setError(t("hub.discover.link.unknown"));
      else onResolved({ provider: String(link.provider || "").toLowerCase().startsWith("model") ? "modelscope" : "huggingface", repo: link.repo });
    } catch (failure) {
      setError(describeError(failure, i18n));
    } finally {
      setBusy(false);
    }
  }
  return html`<form class="stack-sm" data-testid="discover.link" onSubmit=${(event) => {
    event.preventDefault();
    resolve();
  }}>
    <div class="row">
      <label class="deploy-filter grow"><span class="small muted">${t("hub.discover.link.label")}</span>
        <input class="input" type="text" value=${value} placeholder=${t("hub.discover.link.placeholder")} autocomplete="off" data-testid="discover.link-input"
          onInput=${(event) => setValue(event.currentTarget.value)} /></label>
      <${Button} type="submit" busy=${busy} disabled=${!value.trim()} testid="discover.link-open">${t("hub.discover.link.open")}<//>
    </div>
    ${error ? html`<p class="field-error" role="alert" data-testid="discover.link-error" data-user-content="">${error}</p>` : null}
  </form>`;
}

// ---- the plan sheet (loaded when first opened) ------------------------------------------------------

function useSheet(query, embedded) {
  const initial = embedded ? null : planTargetFromQuery(query);
  const [target, setTarget] = useState(initial);
  const [Sheet, setSheet] = useState(null);
  useEffect(() => {
    if (!target || Sheet) return undefined;
    let alive = true;
    import("./download-plan.js").then((module) => alive && setSheet(() => module.default), () => alive && setTarget(null));
    return () => {
      alive = false;
    };
  }, [Boolean(target)]);
  useEffect(() => {
    if (embedded) return; // the wizard owns ?source= (its Tabs); the embedded search never touches the URL
    const params = target ? planTargetParams(target) : { provider: null, repo: null, artifact: null, runAfter: null, source: null, root: null };
    for (const [name, value] of Object.entries(params)) replaceQueryParam(name, value);
  }, [target?.provider, target?.repo, target?.artifact, target?.runAfter, target?.source, target?.rootId]);
  return { target, Sheet, open: setTarget, close: () => setTarget(null) };
}

export default function DiscoverPage({ query = {}, embedded = false, onPick }) {
  const { i18n, router, toasts } = useServices();
  const { t } = useT();
  const owner = useRole() === "owner";
  const [form, setForm] = useState(EMPTY_SEARCH);
  const debounced = useDebounced(form.q, 300);
  const effective = { ...form, q: debounced };
  const search = useSearch(effective);
  const sheet = useSheet(query, embedded);
  const cards = familyCards(search.items);
  const unavailable = search.status === "error" && degradable(search.error);

  function openPlan(variant) {
    sheet.open({ provider: variant.provider, repo: variant.repo, artifact: "", runAfter: false, source: form.source === "hf-mirror" ? "hf-mirror" : "", rootId: "" });
  }
  function resolved(link) {
    if (embedded) onPick?.(remoteRef({ provider: link.provider, repo: link.repo }));
    else router?.navigate?.(detailHref(link.provider, link.repo));
  }
  function queued(job) {
    sheet.close();
    toasts?.push?.({ level: "success", title: t("hub.plan.queued", { name: job?.artifact?.repo || "" }) });
    router?.navigate?.(`/models/downloads?job=${encodeURIComponent(job?.id || "")}`);
  }

  let body;
  if (search.status === "error") {
    body = html`<${EmptyState} testid="discover.error" icon="triangle-alert" title=${t(unavailable ? "hub.unavailable" : "hub.discover.failed")} body=${unavailable ? undefined : describeError(search.error, i18n)}
      action=${{ label: t("hub.library.retry"), onClick: search.reload }} />`;
  } else if (search.status === "loading") {
    body = html`<div aria-busy="true" data-testid="discover.loading"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${4} /></div>`;
  } else if (!cards.length) {
    body = html`<${EmptyState} testid="discover.empty" icon="search" title=${t("hub.discover.empty")} body=${t("hub.discover.emptyBody")}
      action=${{ label: t("hub.discover.clear"), onClick: () => setForm({ ...EMPTY_SEARCH, source: form.source }) }} />`;
  } else {
    body = html`<div class="stack">
      <p class="small muted" role="status" data-testid="discover.count">${t("hub.discover.count", { cards: cards.length, repos: search.items.length })}
        ${search.fetchedFrom ? html` · <span class="mono" data-user-content="">${search.fetchedFrom}</span>` : null}</p>
      ${search.warnings.length ? html`<div class="notice notice-warn" data-testid="discover.warnings">${t("hub.discover.warnings")}</div>` : null}
      <div class="grid-auto family-grid" data-testid="discover.results">
        ${cards.map((card) => html`<${FamilyCard} key=${card.key} card=${card} owner=${owner} embedded=${embedded} onDownload=${openPlan} onPick=${(variant) => onPick?.(remoteRef(variant))} />`)}
      </div>
      ${search.partial ? html`<p class="small muted" data-testid="discover.partial">${t("hub.discover.partial")}</p>` : null}
      ${search.moreError ? html`<p class="field-error" role="alert">${describeError(search.moreError, i18n)}</p>` : null}
      ${search.nextCursor ? html`<div><${Button} busy=${search.more} onClick=${search.loadMore} testid="discover.more">${t("common.table.loadMore")}<//>
        <span class="small muted"> ${t("hub.discover.pageSize", { count: PAGE_SIZE })}</span></div>` : null}
    </div>`;
  }

  const { Sheet } = sheet;
  return html`<div class="stack" data-testid="discover" data-embedded=${embedded ? "true" : "false"} data-source=${form.source}>
    ${embedded ? null : html`<${PageHeader} title=${t("shell.nav.models")} subtitle=${t("hub.discover.subtitle")} />
      <${ModelsNav} current="discover" />`}
    <${SearchForm} form=${form} setForm=${setForm} facets=${search.facets} />
    <${PasteLink} onResolved=${resolved} />
    ${body}
    ${sheet.target && Sheet ? html`<${Sheet} target=${sheet.target} onClose=${sheet.close} onQueued=${queued} />` : null}
  </div>`;
}
