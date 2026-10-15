// The rules behind the Models Discover page (07 §6.4, 03 §13.2): how the
// search form becomes a GET /api/hub/search query, how the result items group
// into family cards with variant chips, and how a plan sheet target travels in
// the page URL. Pure, so it can be tested without a DOM.
//
// "Hugging Face mirror" is a download source, not a search provider (03 §13.2
// takes `huggingface` or `modelscope`): choosing it searches Hugging Face and
// hands `source=hf-mirror` to the plan sheet.

const enc = encodeURIComponent;

export const SEARCH_SOURCES = Object.freeze([
  { id: "huggingface", provider: "huggingface" },
  { id: "hf-mirror", provider: "huggingface" },
  { id: "modelscope", provider: "modelscope" },
]);
export const SORTS = Object.freeze(["trending", "downloads", "likes", "updated"]);
export const FORMAT_FACETS = Object.freeze(["gguf", "safetensors", "fp8", "nvfp4", "mxfp4", "awq", "gptq", "bnb"]);
export const SIZE_FACETS = Object.freeze(["lt8b", "8-16b", "16-40b", "40-80b", "gt80b"]);
export const UPDATED_FACETS = Object.freeze(["7d", "30d", "90d", "365d"]);
export const MODALITY_FACETS = Object.freeze(["vision", "audio"]);
export const PAGE_SIZE = 24;

export const EMPTY_SEARCH = Object.freeze({
  q: "", source: "huggingface", sort: "trending", fit: false, engine: "", format: "", size: "", modality: "", moe: false, gated: "", updated: "",
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

/** The search provider a source id searches: the mirror searches Hugging Face. */
export function providerOf(sourceId) {
  return (SEARCH_SOURCES.find((source) => source.id === sourceId) || SEARCH_SOURCES[0]).provider;
}

/** The facet=key:value pairs of a search form (03 §13.2 facet keys). */
export function facetPairs(form) {
  const pairs = [];
  if (form.fit) pairs.push("fit:fits");
  for (const key of ["engine", "format", "size", "modality", "updated"]) if (form[key]) pairs.push(`${key}:${form[key]}`);
  if (form.moe) pairs.push("moe:true");
  if (form.gated === "true" || form.gated === "false") pairs.push(`gated:${form.gated}`);
  return pairs;
}

/** How many facet filters are on (the "clear filters" button shows when it is above zero). */
export function activeFacetCount(form) {
  return facetPairs(form).length;
}

/** The GET /api/hub/search query of a form and an optional cursor. */
export function searchQuery(form, { cursor = "", limit = PAGE_SIZE } = {}) {
  const q = text(form.q).trim();
  return {
    ...(q ? { q } : {}),
    provider: providerOf(form.source),
    sort: SORTS.includes(form.sort) ? form.sort : "trending",
    limit,
    ...(cursor ? { cursor } : {}),
    ...(facetPairs(form).length ? { facet: facetPairs(form) } : {}),
  };
}

/** Same string for a query that returns the same results, so a changed form drops the loaded pages. */
export function searchKey(form) {
  const { cursor: _cursor, ...rest } = searchQuery(form);
  return JSON.stringify([rest, form.source]);
}

/** `owner` and `name` of `owner/name`; a repo without a slash has no owner. */
export function splitRepo(repo) {
  const value = text(repo);
  const at = value.indexOf("/");
  return at < 0 ? { owner: "", name: value } : { owner: value.slice(0, at), name: value.slice(at + 1) };
}

/** The console route of a repository's detail page. */
export function detailHref(provider, repo) {
  const { owner, name } = splitRepo(repo);
  return owner ? `/models/hub/${enc(provider)}/${enc(owner)}/${enc(name)}` : "";
}

const FIT_ORDER = Object.freeze({ fits: 0, tight: 1, spills: 2, unknown: 3, "wont-fit": 4 });

function precisionLabel(item) {
  const formats = list(item.formats).map(text).filter(Boolean);
  // A precision (fp8, awq, ...) says more than the container format (safetensors).
  const primary = formats.find((format) => !["gguf", "safetensors"].includes(format)) || formats.find((format) => format !== "gguf") || formats[0] || "";
  if (primary === "gguf") {
    const quants = list(item.quants).map(text).filter(Boolean);
    return quants.length ? `GGUF ${quants.slice(0, 2).join(" ")}` : "GGUF";
  }
  return primary ? primary.toUpperCase() : "";
}

/** One variant of a family card: its chip text (`FP8`, `GGUF Q4_K_M`), the estimated VRAM and the fit label. */
export function variantOf(item) {
  const fit = isObject(item.fitHint) ? item.fitHint : {};
  const library = isObject(item.library) ? item.library : {};
  return {
    key: text(item.repo),
    provider: text(item.provider) || "huggingface",
    repo: text(item.repo),
    label: precisionLabel(item) || text(item.task) || "",
    neededMb: Number(fit.neededMb) > 0 ? Number(fit.neededMb) : 0,
    fit: Object.hasOwn(FIT_ORDER, fit.label) ? fit.label : "unknown",
    estimate: fit.basis === "params",
    libraryState: ["present", "partial", "update-available"].includes(library.state) ? library.state : "absent",
    libraryEntryId: text(library.entryId),
    engines: list(item.engines).map(text).filter(Boolean),
    gated: item.gated === true,
    paramsB: Number(item.paramsB) > 0 ? Number(item.paramsB) : 0,
    downloads: Number(item.downloads) || 0,
    likes: Number(item.likes) || 0,
    lastModified: text(item.lastModified),
    baseModel: text(item.baseModel),
    familyKey: text(item.familyKey),
  };
}

/**
 * Family cards from the search items: repositories that share a `familyKey`
 * (the base model and its quantizations) are variants of one card; the order
 * of the first appearance is kept, so the sort the person chose still reads.
 */
export function familyCards(items) {
  const cards = [];
  const byFamily = new Map();
  for (const raw of list(items)) {
    if (!isObject(raw) || !text(raw.repo)) continue;
    const variant = variantOf(raw);
    const known = variant.familyKey ? byFamily.get(variant.familyKey) : null;
    if (known) {
      known.variants.push(variant);
      continue;
    }
    const card = { key: variant.familyKey || variant.repo, variants: [variant] };
    cards.push(card);
    if (variant.familyKey) byFamily.set(variant.familyKey, card);
  }
  return cards.map((card) => {
    const first = card.variants[0];
    const base = card.variants.map((variant) => variant.baseModel).find(Boolean);
    return {
      ...card,
      title: card.variants.length > 1 ? (base || card.key) : first.repo,
      gated: card.variants.some((variant) => variant.gated),
      libraryState: card.variants.some((variant) => variant.libraryState === "update-available") ? "update-available"
        : card.variants.some((variant) => variant.libraryState === "present") ? "present"
          : card.variants.some((variant) => variant.libraryState === "partial") ? "partial" : "absent",
      bestFit: card.variants.map((variant) => variant.fit).sort((a, b) => FIT_ORDER[a] - FIT_ORDER[b])[0],
    };
  });
}

/** The facet value lists the response counted ("in these results"), by key. */
export function facetValues(facets, key) {
  return list(facets?.[key]).filter((entry) => isObject(entry) && text(entry.value)).map((entry) => ({ value: entry.value, count: Number(entry.count) || 0 }));
}

// ---- the plan sheet target in the page URL ----------------------------------

/**
 * What the plan sheet needs, read from the Discover URL
 * (`?drawer=plan&provider=&repo=&artifact=&runAfter=deploy&source=&root=`), or
 * null when the sheet is not open or the repository is missing.
 */
export function planTargetFromQuery(query) {
  if (!isObject(query) || query.drawer !== "plan") return null;
  const repo = text(query.repo).trim();
  if (!repo.includes("/")) return null;
  const provider = query.provider === "modelscope" ? "modelscope" : "huggingface";
  return {
    provider,
    repo,
    artifact: text(query.artifact),
    runAfter: query.runAfter === "deploy",
    source: ["huggingface", "hf-mirror", "modelscope"].includes(query.source) ? query.source : "",
    rootId: text(query.root),
  };
}

/** The query parameters that reopen a plan sheet (the inverse of planTargetFromQuery, without `drawer`). */
export function planTargetParams(target) {
  return {
    provider: target.provider,
    repo: target.repo,
    artifact: target.artifact || null,
    runAfter: target.runAfter ? "deploy" : null,
    source: target.source || null,
    root: target.rootId || null,
  };
}

/** A link to Discover with the plan sheet open for a target. */
export function planHref(target) {
  const params = new URLSearchParams({ drawer: "plan" });
  for (const [name, value] of Object.entries(planTargetParams(target))) if (value) params.set(name, value);
  return `/models/discover?${params.toString()}`;
}

/** The model reference the Deployment wizard takes from the embedded Discover page. */
export function remoteRef(variant) {
  return { kind: "remote", source: variant.provider === "modelscope" ? "modelscope" : "huggingface", repo: variant.repo, revision: "main" };
}
