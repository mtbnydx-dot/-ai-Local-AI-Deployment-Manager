// Wizard step 1, "Model" (07 §6.3, 02 §18 steps 1 and 2): choose what to run.
//
// Four ways in, as tabs: the library (GET /api/hub/library; before the hub
// ships, the managers' own /models lists), a running deployment to clone, an
// online search (the Models Discover page in a Drawer), and a pasted link or
// folder. The chosen model is inspected (POST /api/models/inspect, cached by
// 02) and shown as a ModelCardView with an evidence chip on every fact. A
// draft, a projector or a tooling-only folder cannot be the main model. Each
// GPU gets a fit badge from the compatibility endpoint. A remote model is
// planned from its card (a prospective plan) and offers "Download first".

import { describeError } from "../../lib/api.js";
import { fitBadgeFor } from "../../lib/compat-model.js";
import { buildDeployments } from "../../lib/deployments-model.js";
import {
  groupsForStep, isServableRole, looksLikePath, modelRefFromCard, modelRefFromLink, patchDraft, resetParam, setValue,
} from "../../lib/wizard-state.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { Drawer } from "../../components/drawer.js";
import { EmptyState } from "../../components/empty-state.js";
import { Icon } from "../../components/icon.js";
import { ModelCardView } from "../../components/model-card.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Tabs } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useMemo, useState } from "../../ui/vendor.js";
import { compatKey, loadCompatibility, modelKey, useCard } from "./card-source.js";
import { loadLaunchDraft } from "./quick-paths.js";

const enc = encodeURIComponent;
// The two engine hosts (00 D3); the legacy lists are read from both.
const MANAGERS = Object.freeze(["vllm", "llama"]);
const LIST_LIMIT = 200;
const FIT_STATUS = Object.freeze({ ok: "ok", warn: "warn", fail: "error", unknown: "unknown" });

function list(value) {
  return Array.isArray(value) ? value : [];
}

function sameRef(a, b) {
  return modelKey(a) === modelKey(b);
}

// ---- the library -------------------------------------------------------------------------

function libraryItem(entry) {
  return {
    key: String(entry.id || entry.path),
    entryId: typeof entry.id === "string" ? entry.id : null,
    path: String(entry.path || ""),
    name: String(entry.displayName || entry.name || entry.path || ""),
    format: typeof entry.format === "string" ? entry.format : "",
    bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : null,
    role: typeof entry.card?.role === "string" ? entry.card.role : entry.card?.role?.value || null,
    cardId: typeof entry.card?.cardId === "string" ? entry.card.cardId : undefined,
    runnable: entry.runnable !== false,
  };
}

// The hub library is absent before HUB-8; any "no such route" answer falls back to the managers.
function degradable(error) {
  return error?.status === 404 || error?.status === 405 || error?.status === 501 || error?.code === "endpoint_unavailable" || error?.code === "feature_unavailable";
}

async function legacyLibrary(api) {
  const results = await Promise.allSettled(MANAGERS.map((id) => api.manager(id).get("/models")));
  const seen = new Set();
  const items = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const model of list(result.value?.local)) {
      if (!model || typeof model.path !== "string" || seen.has(model.path)) continue;
      seen.add(model.path);
      items.push(libraryItem(model));
    }
  }
  if (!items.length && results.every((result) => result.status === "rejected")) throw results[0].reason;
  return { source: "managers", items };
}

function useLibrary() {
  const { api } = useServices();
  return useQuery(["hub", "library", "wizard"], async () => {
    try {
      const body = await api.get("/api/hub/library");
      return { source: "hub", items: list(body?.entries).filter((entry) => entry && typeof entry.path === "string").map(libraryItem) };
    } catch (error) {
      if (!degradable(error)) throw error;
      return legacyLibrary(api);
    }
  }, { ttlMs: 30000 });
}

function LibraryTab({ draft, onPick }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  const library = useLibrary();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const items = useMemo(() => list(library.data?.items).filter((item) => !needle || `${item.name} ${item.path}`.toLowerCase().includes(needle)), [library.data, needle]);
  if (library.error && !library.data) {
    return html`<${EmptyState} testid="wizard.model.library-error" icon="triangle-alert" title=${t("models.wizard.model.libraryFailed")}
      action=${{ label: t("models.wizard.plan.retry"), onClick: () => library.refetch() }} />`;
  }
  if (!library.data) return html`<div aria-busy="true"><${Skeleton} shape="line" rows=${4} /></div>`;
  if (!library.data.items.length) {
    return html`<${EmptyState} testid="wizard.model.library-empty" icon="search" title=${t("models.wizard.model.libraryEmpty")} body=${t("models.wizard.model.libraryEmptyBody")}
      action=${{ label: t("models.wizard.model.openDiscover"), href: "/models/discover" }} />`;
  }
  return html`<div class="stack-sm" data-testid="wizard.model.library" data-source=${library.data.source}>
    <label class="field-label" for="wizard-model-filter">${t("models.wizard.model.filter")}</label>
    <input id="wizard-model-filter" class="input" type="search" value=${filter} onInput=${(event) => setFilter(event.currentTarget.value)} data-testid="wizard.model.filter" />
    <ul class="wizard-models" data-testid="wizard.model.list">
      ${items.slice(0, LIST_LIMIT).map((item) => {
        const blocked = (item.role && !isServableRole(item.role)) || !item.runnable;
        const selected = draft.modelRef?.kind === "local" && draft.modelRef.path === item.path;
        return html`<li key=${item.key} data-testid="wizard.model.item" data-path=${item.path} data-role=${item.role || ""} data-blocked=${blocked ? "true" : "false"}>
          <button type="button" class="wizard-model" aria-pressed=${selected ? "true" : "false"} disabled=${blocked} onClick=${() => onPick(item)} data-testid="wizard.model.pick">
            <strong data-user-content="">${item.name}</strong>
            <span class="small muted">
              ${item.format ? html`<span class="mono">${item.format}</span> · ` : null}${item.bytes ? html`${fmt.bytes(item.bytes)} · ` : null}${item.role ? t(tk("models.role.", item.role)) : ""}
            </span>
          </button>
          ${blocked && item.role && !isServableRole(item.role) ? html`<p class="small muted" data-testid="wizard.model.item-note">${t("models.wizard.model.notMain")}</p>` : null}
        </li>`;
      })}
    </ul>
    ${items.length > LIST_LIMIT ? html`<p class="small muted">${t("models.wizard.model.refine", { count: items.length - LIST_LIMIT })}</p>` : null}
    ${!items.length ? html`<p class="muted" data-testid="wizard.model.nomatch">${t("models.wizard.model.noMatch")}</p>` : null}
  </div>`;
}

// ---- a running deployment to clone ---------------------------------------------------------

function RunningTab({ onClone, busyKey }) {
  const { api } = useServices();
  const { t } = useT();
  const query = useQuery(["wizard", "running"], async () => {
    const results = await Promise.allSettled(MANAGERS.map(async (managerId) => ({ managerId, instances: await api.manager(managerId).get("/instances") })));
    const managers = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    if (!managers.length) throw results[0]?.reason || new Error("no manager");
    return buildDeployments({ managers }).rows;
  }, { ttlMs: 10000 });
  if (query.error && !query.data) {
    return html`<${EmptyState} testid="wizard.model.running-error" icon="triangle-alert" title=${t("models.wizard.model.runningFailed")}
      action=${{ label: t("models.wizard.plan.retry"), onClick: () => query.refetch() }} />`;
  }
  if (!query.data) return html`<div aria-busy="true"><${Skeleton} shape="line" rows=${3} /></div>`;
  if (!query.data.length) {
    return html`<${EmptyState} testid="wizard.model.running-empty" icon="info" title=${t("models.wizard.model.runningEmpty")} action=${{ label: t("models.wizard.model.openDeployments"), href: "/deployments" }} />`;
  }
  return html`<ul class="wizard-models" data-testid="wizard.model.running">
    ${query.data.map((row) => html`<li key=${row.key} data-testid="wizard.model.running-item" data-fleet=${row.key}>
      <div class="row">
        <span class="grow"><strong data-user-content="">${row.model}</strong> <span class="small muted mono">${row.engine}</span></span>
        <${Button} size="sm" disabled=${!row.launchId} busy=${busyKey === row.key} onClick=${() => onClone(row)} testid="wizard.model.clone">${t("models.wizard.model.clone")}<//>
      </div>
      ${!row.launchId ? html`<p class="small muted">${t("models.wizard.model.noLaunchRecord")}</p>` : null}
    </li>`)}
  </ul>`;
}

// ---- online search -------------------------------------------------------------------------

// The Models Discover page (CON-15) opens in a Drawer when it is in the build, and is a link otherwise.
function DiscoverDrawer({ open, onClose, onPick }) {
  const { t } = useT();
  const [Page, setPage] = useState(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!open || Page || missing) return;
    import("../models/discover.js").then((module) => setPage(() => module.default), () => setMissing(true));
  }, [open]);
  return html`<${Drawer} open=${open} title=${t("models.wizard.model.searchTitle")} width=${840} onClose=${onClose} testid="wizard.model.discover">
    ${Page ? html`<${Page} embedded=${true} onPick=${onPick} />` : missing
      ? html`<p data-testid="wizard.model.discover-missing">${t("models.wizard.model.searchMissing")} <a href="/models/discover">${t("models.wizard.model.openDiscover")}</a></p>`
      : html`<div aria-busy="true"><${Skeleton} shape="line" rows=${4} /></div>`}
  <//>`;
}

function SearchTab({ onPick }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return html`<div class="stack-sm" data-testid="wizard.model.search">
    <p>${t("models.wizard.model.searchBody")}</p>
    <div><${Button} variant="primary" onClick=${() => setOpen(true)} testid="wizard.model.search-open">${t("models.wizard.model.searchOpen")}<//></div>
    <${DiscoverDrawer} open=${open} onClose=${() => setOpen(false)} onPick=${(ref) => {
      setOpen(false);
      onPick(ref);
    }} />
  </div>`;
}

// ---- a link or a folder --------------------------------------------------------------------

function LinkTab({ onResolved }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve() {
    const input = value.trim();
    if (!input) return;
    setBusy(true);
    setError("");
    try {
      if (looksLikePath(input)) {
        onResolved({ kind: "local", entryId: null, path: input });
      } else {
        const body = await api.post("/api/hub/resolve-link", { url: input });
        const ref = modelRefFromLink(body?.link ?? body?.resolved ?? body);
        if (!ref) setError(t("models.wizard.model.linkUnknown"));
        else onResolved(ref);
      }
    } catch (failure) {
      setError(describeError(failure, i18n));
    } finally {
      setBusy(false);
    }
  }
  return html`<form class="stack-sm" onSubmit=${(event) => {
    event.preventDefault();
    resolve();
  }} data-testid="wizard.model.link">
    <label class="field-label" for="wizard-model-link">${t("models.wizard.model.linkLabel")}</label>
    <div class="field-control">
      <input id="wizard-model-link" class="input" type="text" value=${value} placeholder=${t("models.wizard.model.linkPlaceholder")} autocomplete="off"
        onInput=${(event) => setValue(event.currentTarget.value)} data-testid="wizard.model.link-input" />
      <${Button} variant="primary" type="submit" busy=${busy} disabled=${!value.trim()} testid="wizard.model.link-resolve">${t("models.wizard.model.linkResolve")}<//>
    </div>
    <p class="small muted">${t("models.wizard.model.linkHint")}</p>
    ${error ? html`<p class="field-error" role="alert" data-testid="wizard.model.link-error" data-user-content="">${error}</p>` : null}
  </form>`;
}

// ---- GPU fit badges ------------------------------------------------------------------------

function GpuBadge({ cardId, gpu }) {
  const { api } = useServices();
  const { t, tk } = useT();
  const fmt = useFormat();
  const query = useQuery(compatKey(cardId, [gpu.id]), () => loadCompatibility(api, cardId, [gpu.id]), { ttlMs: 30000 });
  const fit = query.data ? fitBadgeFor(query.data.rows) : "unknown";
  const totalMb = Number(gpu.totalMb);
  const freeMb = Number(gpu.freeMb);
  return html`<li data-testid="wizard.gpu-fit.item" data-gpu=${gpu.id} data-fit=${query.data ? fit : "loading"}>
    <span class="grow"><strong>${t("models.wizard.model.gpu", { id: gpu.id })}</strong> <span class="small muted" data-user-content="">${gpu.name}</span>
      ${Number.isFinite(totalMb) && totalMb > 0 ? html`<span class="small muted num"> · ${Number.isFinite(freeMb) ? t("models.wizard.model.gpuFree", { free: fmt.bytes(freeMb * 1048576, { unit: "GiB" }), total: fmt.bytes(totalMb * 1048576, { unit: "GiB" }) }) : fmt.bytes(totalMb * 1048576, { unit: "GiB" })}</span>` : null}
    </span>
    <${StatusBadge} status=${query.data ? FIT_STATUS[fit] : "loading"} label=${query.data ? t(tk("models.wizard.model.fit.", fit)) : t("models.wizard.model.fit.loading")} testid="wizard.gpu-fit.badge" />
  </li>`;
}

function GpuFit({ cardId }) {
  const { api } = useServices();
  const { t } = useT();
  const hostQuery = useQuery(compatKey(cardId, []), () => loadCompatibility(api, cardId, []), { ttlMs: 30000 });
  const gpus = list(hostQuery.data?.host?.gpus).filter((gpu) => gpu && gpu.id !== undefined).slice(0, 8);
  if (!gpus.length) return hostQuery.data ? html`<p class="small muted" data-testid="wizard.gpu-fit.none">${t("models.wizard.model.noGpu")}</p>` : null;
  return html`<section aria-label=${t("models.wizard.model.gpuTitle")} class="stack-sm">
    <h3 class="card-title">${t("models.wizard.model.gpuTitle")}</h3>
    <ul class="wizard-gpus" data-testid="wizard.gpu-fit">${gpus.map((gpu) => html`<${GpuBadge} key=${String(gpu.id)} cardId=${cardId} gpu=${gpu} />`)}</ul>
  </section>`;
}

// ---- the chosen model ----------------------------------------------------------------------

function remoteParts(ref) {
  const [owner, ...rest] = String(ref.repo || "").split("/");
  return { provider: ref.source === "modelscope" ? "modelscope" : "huggingface", owner, name: rest.join("/") || owner };
}

function SelectedModel({ draft, update, onRejected, leaveTo }) {
  const { t } = useT();
  const { router, i18n } = useServices();
  const ref = draft.modelRef;
  const { card, loading, error, refetch } = useCard(ref);
  useEffect(() => {
    if (!card || !ref) return;
    if (!isServableRole(card.role?.value)) {
      onRejected(card);
      update((current) => patchDraft(current, { modelRef: null }));
      return;
    }
    if (card.cardId !== ref.cardId) update((current) => (current.modelRef && sameRef(current.modelRef, ref) ? patchDraft(current, { modelRef: modelRefFromCard(card, current.modelRef) }) : current));
  }, [card?.cardId, ref && modelKey(ref)]);

  if (!ref) return html`<p class="muted" data-testid="wizard.model.none">${t("models.wizard.model.none")}</p>`;
  const remote = ref.kind === "remote";
  const { provider, owner, name } = remote ? remoteParts(ref) : {};
  function downloadFirst() {
    const href = router?.href?.("models.hub", { provider, owner, name }, { draft: draft.id }) || `/models/hub/${enc(provider)}/${enc(owner)}/${enc(name)}?draft=${enc(draft.id)}`;
    leaveTo(href);
  }
  return html`<${Card} title=${t("models.wizard.model.selected")} testid="wizard.model.selected">
    <div class="stack" data-model=${modelKey(ref)}>
      ${loading ? html`<div aria-busy="true" data-testid="wizard.model.loading"><${Skeleton} shape="line" rows=${4} /></div>` : null}
      ${error ? html`<div class="notice notice-danger" role="alert" data-testid="wizard.model.error">
        <span class="grow" data-user-content="">${describeError(error, i18n)}</span>
        <${Button} size="sm" onClick=${() => refetch()} testid="wizard.model.retry">${t("models.wizard.plan.retry")}<//>
      </div>` : null}
      ${card ? html`<${ModelCardView} card=${card} />` : null}
      ${remote ? html`<div class="notice notice-warn" data-testid="wizard.model.remote">
        <span class="grow">${t("models.wizard.model.remoteNote")}</span>
        <${Button} size="sm" icon="external-link" onClick=${downloadFirst} testid="wizard.model.download-first">${t("models.wizard.model.downloadFirst")}<//>
      </div>` : null}
      ${card ? html`<${GpuFit} cardId=${card.cardId} />` : null}
    </div>
  <//>`;
}

// The "model" catalog group (served name, chat template, dtype, ...) is engine specific, so it
// shows once an engine is chosen. SchemaForm loads on demand to keep this step's own code small.
function ModelOptions({ draft, update, catalog, plan }) {
  const { t } = useT();
  const [Form, setForm] = useState(null);
  const groups = groupsForStep(catalog, "model");
  useEffect(() => {
    if (!groups.length || Form) return;
    import("../../components/schema-form.js").then((module) => setForm(() => module.SchemaForm));
  }, [groups.length]);
  if (!catalog || !groups.length || !Form) return null;
  return html`<${Card} title=${t("models.wizard.model.options")} testid="wizard.model.options">
    <p class="small muted">${t("models.wizard.model.optionsHint")}</p>
    <${Form} catalog=${catalog} plan=${plan} values=${draft.values} groups=${groups} mode="launch"
      onChange=${(id, value) => update((current) => setValue(current, id, value))}
      onReset=${(id) => update((current) => resetParam(current, id))}
      onApplySuggestion=${(id, value) => update((current) => setValue(current, id, value))} />
  <//>`;
}

/** @param draft the wizard draft  @param update (patch | fn(draft)) → void  @param leaveTo (href) leave the page and keep the draft */
export default function StepModel({ draft, update, leaveTo, catalog, plan }) {
  const { api, toasts, i18n } = useServices();
  const { t } = useT();
  const [rejected, setRejected] = useState(null);
  const [cloning, setCloning] = useState("");

  function choose(ref) {
    setRejected(null);
    update((current) => {
      const next = patchDraft(current, { modelRef: ref });
      return current.modelRef && sameRef(current.modelRef, ref) ? next : patchDraft(next, { engineId: "", managerId: "", runtimeId: "", recipeId: "" });
    });
  }
  function pickItem(item) {
    choose({ kind: "local", entryId: item.entryId, path: item.path, cardId: item.cardId });
  }
  async function clone(row) {
    setCloning(row.key);
    try {
      const cloned = await loadLaunchDraft(api, row.managerId, row.launchId, { id: draft.id, step: "model" });
      setRejected(null);
      update(() => cloned);
      toasts?.push?.({ level: "success", title: t("models.wizard.model.cloned") });
    } catch (error) {
      toasts?.push?.({ level: "error", title: describeError(error, i18n) });
    } finally {
      setCloning("");
    }
  }

  const tabs = [
    { id: "library", label: t("models.wizard.model.tab.library") },
    { id: "running", label: t("models.wizard.model.tab.running") },
    { id: "search", label: t("models.wizard.model.tab.search") },
    { id: "link", label: t("models.wizard.model.tab.link") },
  ];
  return html`<div class="stack" data-testid="wizard.step.model">
    <${Card} title=${t("models.wizard.model.source")} testid="wizard.model.source">
      <${Tabs} tabs=${tabs} urlParam="source" label=${t("models.wizard.model.source")} testid="wizard.model.tabs"
        renderPanel=${(active) => (active === "running" ? html`<${RunningTab} onClone=${clone} busyKey=${cloning} />`
          : active === "search" ? html`<${SearchTab} onPick=${choose} />`
            : active === "link" ? html`<${LinkTab} onResolved=${choose} />`
              : html`<${LibraryTab} draft=${draft} onPick=${pickItem} />`)} />
    <//>
    ${rejected ? html`<div class="notice notice-warn" role="alert" data-testid="wizard.model.notMain">
      <${Icon} name="triangle-alert" />
      <span class="grow">${t("models.wizard.model.notMain")}</span>
    </div>` : null}
    ${rejected ? html`<${Card} title=${t("models.wizard.model.rejected")} tone="flat" testid="wizard.model.rejected"><${ModelCardView} card=${rejected} /><//>` : null}
    <${SelectedModel} draft=${draft} update=${update} onRejected=${setRejected} leaveTo=${leaveTo} />
    <${ModelOptions} draft=${draft} update=${update} catalog=${catalog} plan=${plan} />
  </div>`;
}
