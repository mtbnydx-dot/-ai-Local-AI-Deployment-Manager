// /models/library/:entryId and /models/hub/:provider/:owner/:name (07 §6.4
// "Model detail"): one model, on this machine or on a hub.
//
// Overview is the ModelCardView: every fact with an evidence chip, and
// "Guessed from the name" for a name-heuristic one (02 R-UI-1). Compatibility is
// the CompatMatrix (R-UI-2, detail-tabs.js). Quantizations (a repository only)
// lists each artifact with its estimated VRAM at 8K and 32K context. Files,
// README and Provenance (a local model only) follow. Actions: Deploy, Probe,
// Copy id and Open on hub for a local model; Download, Download & deploy, Open on
// hub and Copy id for a repository. The plan sheet itself belongs to the
// Discover page (CON-15): Download links to it with `?drawer=plan`.
//
// A local model comes from the hub library entry (`lib_…` ids) or, before the
// hub exists, from the managers' listing (the id is the folder path); its card
// is inspected from the path either way (POST /api/models/inspect).

import { describeError } from "../../lib/api.js";
import { degradable, detailTabs, entryView, quantRows, repoPath, sourceUrl } from "../../lib/library-model.js";
import { Button } from "../../components/button.js";
import { EmptyState } from "../../components/empty-state.js";
import { ModelCardView } from "../../components/model-card.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Tabs, readQueryParam } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { LazyView } from "../deployment-detail/lazy.js";
import { useCard } from "../deploy-wizard/card-source.js";
import { loadLibrary } from "./data.js";
import { ModelsNav } from "./subnav.js";

const enc = encodeURIComponent;
// The heavy tabs (the matrix, the tables, the README) load when their tab is shown (07 §11).
const LOADERS = Object.freeze({
  CompatTab: () => import("./detail-compat.js"),
  QuantsTab: () => import("./detail-tables.js"),
  FilesTable: () => import("./detail-tables.js"),
  RemoteFiles: () => import("./detail-tables.js"),
  ReadmeTab: () => import("./detail-readme.js"),
});

function Tab({ name, ...props }) {
  return html`<${LazyView} key=${name} load=${LOADERS[name]} name=${name} ...${props} />`;
}

async function copy(text) {
  const { copyText } = await import("../../components/code-block.js");
  return copyText(text);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function splitRepo(repo) {
  const [owner, ...rest] = String(repo || "").split("/");
  return { owner, name: rest.join("/") };
}

function initialTab(tabs) {
  const wanted = readQueryParam("tab");
  return tabs.includes(wanted) ? wanted : tabs[0];
}

// ---- local ------------------------------------------------------------------------------------------

async function loadEntry(api, id) {
  try {
    const body = await api.get(`/api/hub/library/${enc(id)}`);
    return { source: "hub", entry: body?.entry || null };
  } catch (error) {
    if (error?.code !== "library_entry_not_found" && !degradable(error)) throw error;
    const library = await loadLibrary(api);
    const view = library.views.find((item) => item.routeId === id || item.id === id || item.path === id);
    if (!view) {
      const missing = new Error("library_entry_not_found");
      missing.code = "library_entry_not_found";
      missing.status = 404;
      throw missing;
    }
    return { source: library.source, view };
  }
}

function useLocal(id) {
  const { api } = useServices();
  return useQuery(["hub", "library", "entry", id], () => loadEntry(api, id), { ttlMs: 20000 });
}

function ProvenanceTab({ view, entry }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  const provenance = entry?.provenance || {};
  const verification = entry?.verification || {};
  const row = (label, value, mono) => (value === "" || value === null || value === undefined ? null
    : html`<dt>${label}</dt><dd class=${mono ? "mono" : ""} data-user-content="">${value}</dd>`);
  if (!entry) return html`<p class="muted" data-testid="detail.provenance.legacy">${t("hub.detail.provenance.legacy")}</p>`;
  return html`<div class="stack" data-testid="detail.provenance">
    <dl class="kv">
      <dt>${t("hub.detail.provenance.repo")}</dt><dd data-user-content="">${provenance.repo || "—"}</dd>
      <dt>${t("hub.detail.provenance.confidence")}</dt><dd>${t(tk("hub.library.provenance.", view.provenanceConfidence))}</dd>
      ${row(t("hub.detail.provenance.provider"), provenance.provider)}
      ${row(t("hub.detail.provenance.revision"), provenance.revisionSha || provenance.revision, true)}
      ${row(t("hub.detail.provenance.source"), provenance.source)}
      ${provenance.downloadedAt ? html`<dt>${t("hub.detail.provenance.downloadedAt")}</dt><dd>${fmt.dateTime(provenance.downloadedAt)}</dd>` : null}
      ${provenance.downloadJobId ? html`<dt>${t("hub.detail.provenance.job")}</dt><dd><a href=${`/models/downloads?job=${enc(provenance.downloadJobId)}`}>${provenance.downloadJobId}</a></dd>` : null}
      ${row(t("hub.detail.provenance.identity"), entry.identityKey, true)}
      ${row(t("hub.detail.provenance.path"), entry.path, true)}
      <dt>${t("hub.detail.provenance.verification")}</dt>
      <dd><${StatusBadge} status=${verification.status === "ok" ? "ok" : verification.status === "warn" ? "warn" : verification.status === "fail" ? "error" : "unknown"} label=${t(tk("hub.library.verification.", view.verification))} />
        ${verification.checkedAt ? html` <span class="small muted">${fmt.dateTime(verification.checkedAt)}</span>` : null}</dd>
    </dl>
    ${list(verification.issues).length ? html`<ul class="small" data-testid="detail.provenance.issues">${list(verification.issues).map((issue, index) => html`<li key=${index} data-user-content="">${typeof issue === "string" ? issue : issue?.message || issue?.code || ""}</li>`)}</ul>` : null}
    ${list(entry.aliases).length ? html`<div class="stack-sm" data-testid="detail.provenance.history">
      <h3 class="card-title">${t("hub.detail.provenance.history")}</h3>
      <p class="small muted">${t("hub.detail.provenance.historyNote")}</p>
      <ul class="small mono">${list(entry.aliases).map((alias) => html`<li key=${alias} data-user-content="">${alias}</li>`)}</ul>
    </div>` : null}
  </div>`;
}

function LocalDetail({ id, query }) {
  const { i18n } = useServices();
  const { t, tk } = useT();
  const loaded = useLocal(id);
  const entry = loaded.data?.entry || null;
  const view = entry ? entryView(entry, []) : loaded.data?.view || null;
  const ref = view?.path ? { kind: "local", path: view.path, ...(view.cardId ? { cardId: view.cardId } : {}) } : null;
  const { card, loading: cardLoading, error: cardError, refetch: refetchCard } = useCard(ref, { enabled: Boolean(ref) });
  const tabs = detailTabs(false);
  const [tab, setTab] = useState(() => initialTab(tabs));
  const [copied, setCopied] = useState(false);

  if (loaded.error && !loaded.data) {
    const missing = loaded.error.code === "library_entry_not_found";
    return html`<div class="stack"><${PageHeader} title=${t("shell.nav.models")} /><${ModelsNav} current="library" />
      <${EmptyState} testid="detail.missing" icon="triangle-alert" title=${t(missing ? "hub.detail.missing" : "hub.library.loadFailed")} body=${missing ? t("hub.detail.missingBody") : undefined}
        action=${{ label: t("hub.detail.backToLibrary"), href: "/models" }} /></div>`;
  }
  if (!view) return html`<div class="stack" aria-busy="true"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${5} /></div>`;

  const hubUrl = view.provenanceRepo ? sourceUrl({ provider: view.provenanceProvider === "modelscope" ? "modelscope" : "huggingface", ...splitRepo(view.provenanceRepo) }) : "";
  const readmeTarget = view.provenanceRepo ? { provider: view.provenanceProvider === "modelscope" ? "modelscope" : "huggingface", ...splitRepo(view.provenanceRepo) } : null;
  const draft = typeof query?.draft === "string" ? query.draft : "";
  const actions = html`${view.runnable && !view.cache ? html`<${Button} variant="primary" href=${`/deployments/new?model=${enc(view.path)}`} testid="detail.deploy">${t("hub.library.action.deploy")}<//>` : null}
    <${Button} onClick=${() => setTab("compat")} testid="detail.probe">${t("hub.library.action.probe")}<//>
    <${Button} onClick=${async () => {
      setCopied(await copy(card?.cardId || view.id || view.path));
    }} testid="detail.copy-id">${copied ? t("common.copied") : t("hub.detail.action.copyId")}<//>
    ${card?.cardId ? html`<${Button} href=${`/models/knowledge?override=${enc(card.cardId)}`} testid="detail.edit-override">${t("models.knowledge.override.edit")}<//>` : null}
    ${hubUrl ? html`<${Button} href=${hubUrl} target="_blank" rel="noopener noreferrer" testid="detail.open-hub">${t("hub.detail.action.openHub")}<//>` : null}`;

  const panel = (active) => {
    if (active === "overview") {
      return html`<div class="stack" data-testid="detail.overview">
        ${cardError ? html`<div class="notice notice-danger" role="alert" data-testid="detail.card-error"><span class="grow" data-user-content="">${describeError(cardError, i18n)}</span>
          <${Button} size="sm" onClick=${() => refetchCard()}>${t("hub.library.retry")}<//></div>` : null}
        ${cardLoading ? html`<div aria-busy="true"><${Skeleton} shape="line" rows=${5} /></div>` : null}
        ${card ? html`<${ModelCardView} card=${card} />` : null}
        ${view.legacy ? html`<p class="small muted" data-testid="detail.legacy-note">${t("hub.library.degraded")}</p>` : null}
      </div>`;
    }
    if (active === "compat") return html`<${Tab} name="CompatTab" card=${card} remote=${false} path=${view.path} />`;
    if (active === "files") {
      return entry ? html`<${Tab} name="FilesTable" files=${list(entry.files)} />` : html`<p class="muted">${t("hub.detail.provenance.legacy")}</p>`;
    }
    if (active === "readme") return html`<${Tab} name="ReadmeTab" target=${readmeTarget} />`;
    return html`<${ProvenanceTab} view=${view} entry=${entry} />`;
  };
  return html`<div class="stack" data-testid="model-detail" data-kind="local" data-entry=${view.key}>
    <${PageHeader} title=${view.name} breadcrumbs=${[{ label: t("shell.nav.models"), href: "/models" }, { label: view.name }]} actions=${actions}
      meta=${view.bytes ? html`<${DetailMeta} view=${view} />` : null} />
    <${ModelsNav} current="library" />
    ${draft ? html`<p><a href=${`/deployments/new?draft=${enc(draft)}`} data-testid="detail.back-to-wizard">${t("hub.detail.backToWizard")}</a></p>` : null}
    <${Tabs} tabs=${tabs.map((tabId) => ({ id: tabId, label: t(tk("hub.detail.tab.", tabId)) }))} value=${tab} onChange=${setTab} label=${t("hub.detail.tabs")} renderPanel=${panel} testid="detail.tabs" />
  </div>`;
}

function DetailMeta({ view }) {
  const fmt = useFormat();
  return html`<span class="muted small">${[view.format, view.quant, fmt.bytes(view.bytes)].filter(Boolean).join(" · ")}</span>`;
}

// ---- remote -----------------------------------------------------------------------------------------

function RemoteOverview({ detail, card, cardLoading, cardError, refetchCard }) {
  const { i18n } = useServices();
  const { t, tk } = useT();
  const fmt = useFormat();
  const summary = detail.summary || {};
  const access = detail.access || {};
  const warnings = list(detail.warnings);
  return html`<div class="stack" data-testid="detail.overview">
    <dl class="kv" data-testid="detail.summary">
      ${summary.license ? html`<dt>${t("hub.detail.summary.license")}</dt><dd data-user-content="">${summary.license}</dd>` : null}
      ${summary.baseModel ? html`<dt>${t("hub.detail.summary.baseModel")}</dt><dd data-user-content="">${summary.baseModel}</dd>` : null}
      ${Number(summary.paramsB) > 0 ? html`<dt>${t("hub.detail.summary.params")}</dt><dd>${summary.paramsB} B</dd>` : null}
      ${Number(summary.contextLength) > 0 ? html`<dt>${t("hub.detail.summary.context")}</dt><dd>${fmt.tokens(summary.contextLength)}</dd>` : null}
      ${summary.lastModified ? html`<dt>${t("hub.detail.summary.updated")}</dt><dd>${fmt.dateTime(summary.lastModified)}</dd>` : null}
      ${access.status ? html`<dt>${t("hub.detail.summary.access")}</dt><dd data-testid="detail.access">${t(tk("hub.detail.access.", access.status))}</dd>` : null}
    </dl>
    ${warnings.length ? html`<ul class="stack-sm small" data-testid="detail.warnings">${warnings.map((item, index) => html`<li key=${index} class="notice notice-warn" data-user-content="">${typeof item === "string" ? item : item?.message || item?.code || ""}</li>`)}</ul>` : null}
    ${cardError ? html`<div class="notice notice-danger" role="alert" data-testid="detail.card-error"><span class="grow" data-user-content="">${describeError(cardError, i18n)}</span>
      <${Button} size="sm" onClick=${() => refetchCard()}>${t("hub.library.retry")}<//></div>` : null}
    ${cardLoading ? html`<div aria-busy="true"><${Skeleton} shape="line" rows=${5} /></div>` : null}
    ${card ? html`<${ModelCardView} card=${card} />` : (!cardLoading && !cardError ? html`<p class="muted">${t("hub.detail.noCard")}</p>` : null)}
  </div>`;
}

function RemoteDetail({ params, query }) {
  const { api, i18n } = useServices();
  const { t, tk } = useT();
  const target = { provider: params.provider, owner: params.owner, name: params.name };
  const repo = `${target.owner}/${target.name}`;
  const tabs = detailTabs(true);
  const [tab, setTab] = useState(() => initialTab(tabs));
  const [copied, setCopied] = useState(false);
  const key = ["hub", "repos", target.provider, target.owner, target.name];
  const detail = useQuery([...key, "detail"], () => api.get(repoPath(target), { query: { context: 8192 } }), { ttlMs: 60000 });
  const wide = useQuery([...key, "detail32k"], () => api.get(repoPath(target), { query: { context: 32768 } }), { ttlMs: 60000, enabled: tab === "quants" });
  const ref = detail.data ? { kind: "remote", source: target.provider, repo, revision: detail.data.revision || "main", ...(detail.data.card?.cardId ? { cardId: detail.data.card.cardId } : {}) } : null;
  const { card, loading: cardLoading, error: cardError, refetch: refetchCard } = useCard(ref, { enabled: Boolean(ref) });

  if (detail.error && !detail.data) {
    const unavailable = degradable(detail.error);
    return html`<div class="stack"><${PageHeader} title=${t("shell.nav.models")} /><${ModelsNav} current="discover" />
      <${EmptyState} testid="detail.unavailable" icon="triangle-alert" title=${t(unavailable ? "hub.unavailable" : "hub.detail.repoFailed")} body=${unavailable ? undefined : describeError(detail.error, i18n)}
        action=${{ label: t("hub.library.retry"), onClick: () => detail.refetch() }} /></div>`;
  }
  if (!detail.data) return html`<div class="stack" aria-busy="true" data-testid="detail.loading"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${5} /></div>`;

  const rows = quantRows(detail.data.artifacts, wide.data?.artifacts);
  const hubUrl = sourceUrl(target);
  const planHref = `/models/discover?drawer=plan&provider=${enc(target.provider)}&repo=${enc(repo)}`;
  const draft = typeof query?.draft === "string" ? query.draft : "";
  const actions = html`<${Button} variant="primary" href=${planHref} testid="detail.download">${t("hub.detail.action.download")}<//>
    <${Button} href=${`${planHref}&runAfter=deploy`} testid="detail.download-deploy">${t("hub.detail.action.downloadDeploy")}<//>
    <${Button} onClick=${async () => {
      setCopied(await copy(repo));
    }} testid="detail.copy-id">${copied ? t("common.copied") : t("hub.detail.action.copyId")}<//>
    ${hubUrl ? html`<${Button} href=${hubUrl} target="_blank" rel="noopener noreferrer" testid="detail.open-hub">${t("hub.detail.action.openHub")}<//>` : null}`;

  const panel = (active) => {
    if (active === "overview") return html`<${RemoteOverview} detail=${detail.data} card=${card} cardLoading=${cardLoading} cardError=${cardError} refetchCard=${refetchCard} />`;
    if (active === "compat") return html`<${Tab} name="CompatTab" card=${card} remote=${true} path="" />`;
    if (active === "quants") {
      return html`<${Tab} name="QuantsTab" rows=${rows} loading=${wide.fetching && !wide.data} error=${wide.error && !wide.data ? wide.error : null} onRetry=${() => wide.refetch()}
        downloadHref=${(row) => `${planHref}&artifact=${enc(row.key)}`} />`;
    }
    if (active === "files") return html`<${Tab} name="RemoteFiles" target=${target} />`;
    return html`<${Tab} name="ReadmeTab" target=${target} />`;
  };
  return html`<div class="stack" data-testid="model-detail" data-kind="remote" data-repo=${repo}>
    <${PageHeader} title=${repo} breadcrumbs=${[{ label: t("shell.nav.models"), href: "/models" }, { label: t("hub.nav.discover"), href: "/models/discover" }, { label: repo }]} actions=${actions}
      meta=${html`<span class="small muted" data-testid="detail.provider">${t("hub.detail.provider", { provider: target.provider })}</span>`} />
    <${ModelsNav} current="discover" />
    ${draft ? html`<p><a href=${`/deployments/new?draft=${enc(draft)}`} data-testid="detail.back-to-wizard">${t("hub.detail.backToWizard")}</a></p>` : null}
    <${Tabs} tabs=${tabs.map((tabId) => ({ id: tabId, label: t(tk("hub.detail.tab.", tabId)) }))} value=${tab} onChange=${setTab} label=${t("hub.detail.tabs")} renderPanel=${panel} testid="detail.tabs" />
  </div>`;
}

export default function ModelDetailPage({ params = {}, query = {} }) {
  return params.provider ? html`<${RemoteDetail} params=${params} query=${query} />` : html`<${LocalDetail} id=${params.entryId || ""} query=${query} />`;
}
