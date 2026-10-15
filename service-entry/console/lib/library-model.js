// The rules behind the Models library, storage and detail pages (07 §6.4,
// 03 §9 and §13), pure so they can be tested without a DOM: how a hub
// LibraryEntry (or, before the hub exists, a manager's `models` row) becomes a
// table row, the facets, the capacity bars of GET /api/hub/storage/usage and
// the checks the delete dialog and the detail page make.
//
// A model is "legacy" when it comes from the managers' own listing. That
// listing has no provenance, update check or card, so those columns stay empty
// and the page says why.

const KNOWN_VERIFICATION = Object.freeze(["ok", "warn", "fail", "unchecked"]);
const KNOWN_UPDATE = Object.freeze(["unknown", "current", "available", "unsupported", "error"]);
const MANAGER_IDS = Object.freeze(["vllm", "llama"]);
// The roles a model can be launched as (wizard-state.js SERVABLE_ROLES): a draft, a projector or a tooling folder is not offered for Deploy.
const SERVABLE_ROLES = Object.freeze(["main", "embedding", "reranker"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function bytesOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Whether an error means "this endpoint does not exist here", so the page falls back to the managers. */
export function degradable(error) {
  return error?.status === 404 || error?.status === 405 || error?.status === 501
    || error?.code === "endpoint_unavailable" || error?.code === "feature_unavailable" || error?.code === "hub_unavailable";
}

/** The base name of a path in either separator style. */
export function baseName(value) {
  const parts = text(value).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/** `repo@revision` of an entry's provenance (a 40-hex sha is shortened), or "". */
export function provenanceText(provenance) {
  if (!isObject(provenance) || !text(provenance.repo)) return "";
  const revision = text(provenance.revisionSha) || text(provenance.revision);
  const short = /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 8) : revision;
  return short ? `${provenance.repo}@${short}` : provenance.repo;
}

function roleOf(entry) {
  const role = entry?.card?.role;
  if (typeof role === "string") return role;
  if (isObject(role) && typeof role.value === "string") return role.value;
  return "";
}

/** Engines a model is known to run on: the ok and warn rows of `card.compatibility`. */
export function engineChips(entry) {
  const seen = new Set();
  const out = [];
  for (const row of list(entry?.card?.compatibility)) {
    if (!isObject(row) || typeof row.engineId !== "string" || (row.verdict !== "ok" && row.verdict !== "warn") || seen.has(row.engineId)) continue;
    seen.add(row.engineId);
    out.push({ engineId: row.engineId, verdict: row.verdict });
  }
  return out;
}

/**
 * One table row from a hub LibraryEntry (03 §9.2). `roots` is the `roots[]` of
 * the same response; a model-mode root is the entry itself, so deleting the
 * entry would delete the root, which the server refuses and the page does not offer.
 */
export function entryView(entry, roots = []) {
  const provenance = isObject(entry?.provenance) ? entry.provenance : {};
  const update = isObject(entry?.update) ? entry.update : {};
  const verification = isObject(entry?.verification) ? entry.verification : {};
  const residue = isObject(entry?.residue) ? entry.residue : {};
  const id = text(entry?.id);
  const path = text(entry?.path);
  const rootIsEntry = list(roots).some((root) => isObject(root) && root.mode === "model" && text(root.path) && samePath(root.path, path));
  return {
    key: id || path,
    source: "hub",
    id,
    routeId: id,
    name: text(entry?.displayName) || baseName(path) || id,
    path,
    kind: text(entry?.kind) || "folder",
    role: roleOf(entry),
    runnable: entry?.runnable !== false && (roleOf(entry) === "" || SERVABLE_ROLES.includes(roleOf(entry))),
    format: text(entry?.format),
    quant: text(entry?.quant),
    bytes: bytesOf(entry?.bytes),
    rootId: text(entry?.rootId),
    rootLabel: text(entry?.rootLabel),
    engines: engineChips(entry),
    verification: KNOWN_VERIFICATION.includes(verification.status) ? verification.status : "unchecked",
    provenance: provenanceText(provenance),
    provenanceRepo: text(provenance.repo),
    provenanceProvider: text(provenance.provider),
    provenanceConfidence: text(provenance.confidence) || "unknown",
    update: KNOWN_UPDATE.includes(update.status) ? update.status : "unknown",
    updateFiles: Number(update.changedFiles) || 0,
    updateBytes: bytesOf(update.bytesToDownload),
    residueFiles: Number(residue.incompleteFiles) || 0,
    residueBytes: bytesOf(residue.incompleteBytes),
    duplicates: list(entry?.duplicates).filter((item) => typeof item === "string"),
    lastLaunchedAt: text(entry?.lastLaunchedAt),
    modified: text(entry?.mtime),
    cardId: text(entry?.card?.cardId),
    isRoot: rootIsEntry,
    cache: entry?.kind === "hf-cache-repo" || entry?.kind === "modelscope-cache",
    legacy: false,
  };
}

function samePath(a, b) {
  const norm = (value) => text(value).replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** One table row from a manager's `models.local[]` item (the pre-hub listing). */
export function legacyView(model, managerId = "") {
  const path = text(model?.path);
  return {
    key: path || text(model?.id),
    source: "managers",
    id: "",
    routeId: path,
    name: text(model?.label) || baseName(path),
    path,
    kind: "folder",
    role: "",
    runnable: model?.runnable !== false,
    format: text(model?.modelFormat) || (model?.hasGguf ? "gguf" : ""),
    quant: "",
    bytes: bytesOf(model?.size),
    rootId: text(model?.storageId),
    rootLabel: text(model?.storageLabel),
    engines: [],
    verification: KNOWN_VERIFICATION.includes(model?.verificationStatus) ? model.verificationStatus : "unchecked",
    provenance: "",
    provenanceRepo: "",
    provenanceProvider: "",
    provenanceConfidence: "unknown",
    update: "unknown",
    updateFiles: 0,
    updateBytes: 0,
    residueFiles: 0,
    residueBytes: 0,
    duplicates: [],
    lastLaunchedAt: "",
    modified: text(model?.modified),
    cardId: "",
    isRoot: false,
    cache: false,
    legacy: true,
    managerId,
  };
}

/**
 * The merged legacy listing: `answers` is [{ managerId, body }] with the
 * managers' `models` bodies. A model both managers list (they share the model
 * folders) appears once. Also returns the roots the rows came from.
 */
export function mergeLegacyModels(answers) {
  const seen = new Set();
  const views = [];
  const roots = new Map();
  for (const { managerId, body } of list(answers)) {
    for (const model of list(body?.local)) {
      if (!isObject(model) || !text(model.path)) continue;
      const key = text(model.path).replaceAll("\\", "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const view = legacyView(model, managerId);
      views.push(view);
      if (view.rootId && !roots.has(view.rootId)) roots.set(view.rootId, { id: view.rootId, label: view.rootLabel || view.rootId });
    }
  }
  return { views, roots: [...roots.values()] };
}

export function legacyManagers() {
  return MANAGER_IDS;
}

// ---- facets ---------------------------------------------------------------------------------

export const EMPTY_FILTERS = Object.freeze({ q: "", rootId: "", format: "", engine: "", role: "", hasUpdate: false });

/** The values each facet offers, from the loaded rows (and the roots the API listed). */
export function facetOptions(views, roots = []) {
  const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const rootsById = new Map();
  for (const root of list(roots)) if (isObject(root) && text(root.id)) rootsById.set(root.id, text(root.label) || root.id);
  for (const view of views) if (view.rootId && !rootsById.has(view.rootId)) rootsById.set(view.rootId, view.rootLabel || view.rootId);
  return {
    roots: [...rootsById].map(([id, label]) => ({ id, label })),
    formats: unique(views.map((view) => view.format)),
    engines: unique(views.flatMap((view) => view.engines.map((chip) => chip.engineId))),
    roles: unique(views.map((view) => view.role)),
    canFilterUpdate: views.some((view) => view.update === "available"),
  };
}

/** The rows the facets keep. */
export function applyFilters(views, filters = EMPTY_FILTERS) {
  const needle = text(filters.q).trim().toLowerCase();
  return views.filter((view) => {
    if (filters.rootId && view.rootId !== filters.rootId) return false;
    if (filters.format && view.format !== filters.format) return false;
    if (filters.role && view.role !== filters.role) return false;
    if (filters.engine && !view.engines.some((chip) => chip.engineId === filters.engine)) return false;
    if (filters.hasUpdate && view.update !== "available") return false;
    if (needle && ![view.name, view.provenance, view.format, view.quant, view.path].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });
}

// ---- capacity bars ----------------------------------------------------------------------------

/**
 * One bar per registered root from GET /api/hub/storage/usage (03 §13.5) or the
 * managers' disk-usage (same `roots[]` fields, less). A root the server marked
 * `hidden` is left out. Parts, in bytes: `used` (everything else on the drive),
 * `models` (without leftovers), `residue` (`.incomplete` files) and `pending`
 * (what active downloads still have to write). What is left of the bar is free.
 */
export function rootBars(usage) {
  const out = [];
  for (const root of list(usage?.roots)) {
    if (!isObject(root) || root.hidden === true || !text(root.id)) continue;
    const total = Number(root.totalBytes);
    const free = Number(root.freeBytes);
    const online = root.available !== false && Number.isFinite(total) && total > 0;
    const models = bytesOf(root.usedByModelsBytes);
    const residue = Math.min(models, bytesOf(root.incompleteBytes));
    const pending = bytesOf(root.pendingBytes);
    const other = online && Number.isFinite(free) ? Math.max(0, total - free - models) : 0;
    out.push({
      id: root.id,
      label: text(root.label) || root.id,
      path: text(root.path),
      volume: text(root.volume),
      mode: text(root.mode),
      default: root.default === true,
      legacy: root.legacy === true,
      online,
      totalBytes: online ? total : 0,
      freeBytes: Number.isFinite(free) ? free : 0,
      modelCount: Number(root.modelCount) || 0,
      residueFiles: Number(root.incompleteFiles) || 0,
      parts: { used: other, models: models - residue, residue, pending },
    });
  }
  return out;
}

/** The Hugging Face cache drive: its three folders and what is free beside them (null when the API has no cache section). */
export function cacheBar(usage) {
  const cache = usage?.hfCache;
  if (!isObject(cache)) return null;
  const parts = { hub: bytesOf(cache.hubBytes), xet: bytesOf(cache.xetBytes), modelscope: bytesOf(cache.modelscopeBytes) };
  const free = Number(cache.freeBytes);
  const used = parts.hub + parts.xet + parts.modelscope;
  return { volume: text(cache.volume), freeBytes: Number.isFinite(free) ? free : null, totalBytes: used + (Number.isFinite(free) ? free : 0), parts, empty: used === 0 };
}

/** The residues (`.incomplete` leftovers) and orphan partial downloads the usage lists, as cleanup targets (03 §13.5). */
export function cleanupTargets(usage) {
  const targets = [];
  for (const item of list(usage?.residues)) {
    if (isObject(item) && text(item.entryId) && !item.busy) targets.push({ kind: "incomplete", entryId: item.entryId, bytes: bytesOf(item.incompleteBytes) });
  }
  for (const item of list(usage?.orphanPartials)) {
    if (isObject(item) && text(item.jobId)) targets.push({ kind: "partial-download", jobId: item.jobId, bytes: bytesOf(item.bytes) });
  }
  return targets;
}

/** The reclaimable bytes of duplicate groups (nothing is deleted automatically). */
export function duplicateBytes(usage) {
  return list(usage?.duplicates).reduce((sum, group) => sum + bytesOf(group?.reclaimableBytes), 0);
}

// ---- delete -------------------------------------------------------------------------------------

/** What the delete dialog asks to be typed: the entry's name (03 §9.5 `confirm` equals `displayName`). */
export function deleteConfirmName(view) {
  return view?.name || "";
}

/** Whether Delete is offered: never for a root itself, nor while the rows are the legacy listing (no hub to ask). */
export function canDelete(view) {
  return Boolean(view) && !view.isRoot && !view.legacy && Boolean(view.id);
}

/** The bytes a finished delete task freed (`result.reclaimedBytes`), or 0. */
export function reclaimedBytes(task) {
  return bytesOf(task?.result?.reclaimedBytes);
}

/** A hub task is over when it reached a terminal state. */
export function taskDone(task) {
  return task?.state === "done" || task?.state === "completed" || task?.state === "succeeded" || task?.state === "failed" || task?.state === "error" || task?.state === "cancelled";
}

export function taskFailed(task) {
  return task?.state === "failed" || task?.state === "error";
}

// ---- model detail -------------------------------------------------------------------------------

export const DETAIL_TABS = Object.freeze(["overview", "compat", "quants", "files", "readme", "provenance"]);

/** The tabs a detail page has: Quantizations is remote only, Provenance local only (07 §6.4). */
export function detailTabs(remote) {
  return DETAIL_TABS.filter((id) => (id === "quants" ? remote : id === "provenance" ? !remote : true));
}

/** The hub path of a repository: `/models/hub/huggingface/owner/name`. */
export function repoPath({ provider, owner, name }) {
  const enc = encodeURIComponent;
  return `/api/hub/repos/${enc(provider)}/${enc(owner)}/${enc(name)}`;
}

/** The repository's page on its hub, or "" for a provider the console does not know. */
export function sourceUrl({ provider, owner, name }) {
  const repo = `${owner}/${name}`;
  if (provider === "huggingface") return `https://huggingface.co/${repo}`;
  if (provider === "modelscope") return `https://modelscope.cn/models/${repo}`;
  return "";
}

/**
 * The quantization rows of a repository detail (03 §13.3 `artifacts[]`) at
 * 8K context, with the same artifacts read at 32K beside them (`fit32k`); the
 * recommended one is marked. A fit is { label, neededMb, basis } or null.
 */
export function quantRows(artifacts, artifacts32k = []) {
  const fitOf = (item) => (isObject(item?.fit) ? { label: text(item.fit.label) || "unknown", neededMb: Number(item.fit.neededMb) || 0, basis: text(item.fit.basis) } : null);
  const wide = new Map(list(artifacts32k).filter((item) => isObject(item)).map((item) => [text(item.artifactKey), item]));
  return list(artifacts).filter((item) => isObject(item) && text(item.artifactKey)).map((item) => ({
    key: item.artifactKey,
    label: text(item.label) || text(item.quant) || item.artifactKey,
    format: text(item.format),
    quant: text(item.quant),
    bytes: bytesOf(item.bytes),
    fileCount: Number(item.fileCount) || 0,
    complete: item.complete !== false,
    fit8k: fitOf(item),
    spill8k: item.fit?.spill === true,
    fit32k: fitOf(wide.get(item.artifactKey)),
    spill32k: wide.get(item.artifactKey)?.fit?.spill === true,
    engines: list(item.engines).map((engine) => (isObject(engine) ? text(engine.engineId) : "")).filter(Boolean),
    recommended: item.recommended === true,
    libraryState: text(item.library?.state) || "absent",
    libraryEntryId: text(item.library?.entryId),
  }));
}

/** The hub fit labels (03 §19) a fit result maps to: a spill reads "spills", not "fits". */
export function fitLabelKey(label, spill = false) {
  if (spill && (label === "fits" || label === "tight")) return "spills";
  return ["fits", "tight", "spills", "wont-fit", "unknown"].includes(label) ? label : "unknown";
}
