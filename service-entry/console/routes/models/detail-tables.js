// The tables of the model detail page (07 §6.4): Quantizations of a repository
// (artifact, files, size, estimated VRAM at 8K and 32K, engines, recommended
// star) and the file list of a folder or a repository (cursor "load more").

import { repoPath, fitLabelKey } from "../../lib/library-model.js";
import { Button } from "../../components/button.js";
import { DataTable } from "../../components/data-table.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { Failure } from "./detail-failure.js";

function FitCell({ fit, spill }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  if (!fit) return html`<span class="muted">—</span>`;
  const key = fitLabelKey(fit.label, spill);
  const status = key === "fits" ? "ok" : key === "unknown" ? "unknown" : key === "wont-fit" ? "error" : "warn";
  return html`<span class="stack-sm"><${StatusBadge} status=${status} label=${t(tk("hub.fit.", key))} />
    ${fit.neededMb ? html`<span class="xsmall muted num">${fmt.mib(fit.neededMb)}</span>` : null}</span>`;
}

/** @param rows quantRows() merged with the 32K fit  @param downloadHref(row) the plan sheet link */
export function QuantsTab({ rows, loading, error, onRetry, downloadHref }) {
  const { t } = useT();
  const fmt = useFormat();
  if (error && !rows.length) return html`<${Failure} error=${error} onRetry=${onRetry} testid="detail.quants.error" />`;
  if (loading && !rows.length) return html`<div aria-busy="true"><${Skeleton} shape="table" rows=${4} /></div>`;
  if (!rows.length) return html`<p class="muted" data-testid="detail.quants.none">${t("hub.detail.quants.none")}</p>`;
  const columns = [
    { id: "quant", header: t("hub.detail.quants.col.quant"), sort: (row) => row.label, cell: (row) => html`<span class="row">
      ${row.recommended ? html`<span class="badge badge-info" data-testid="detail.quants.recommended">${t("hub.detail.quants.recommended")}</span>` : null}
      <strong class="mono">${row.label}</strong>
      ${row.libraryState !== "absent" ? html`<span class="badge badge-success">${t("hub.detail.quants.inLibrary")}</span>` : null}</span>`, csv: (row) => row.label },
    { id: "files", header: t("hub.detail.quants.col.files"), align: "end", sort: (row) => row.fileCount, cell: (row) => html`<span class="num">${row.fileCount}</span>`, csv: (row) => row.fileCount },
    { id: "size", header: t("hub.detail.quants.col.size"), align: "end", sort: (row) => row.bytes, cell: (row) => html`<span class="num">${fmt.bytes(row.bytes)}</span>`, csv: (row) => row.bytes },
    { id: "fit8k", header: t("hub.detail.quants.col.fit8k"), cell: (row) => html`<${FitCell} fit=${row.fit8k} spill=${row.spill8k} />`, csv: (row) => row.fit8k?.neededMb ?? "" },
    { id: "fit32k", header: t("hub.detail.quants.col.fit32k"), cell: (row) => html`<${FitCell} fit=${row.fit32k} spill=${row.spill32k} />`, csv: (row) => row.fit32k?.neededMb ?? "" },
    { id: "engines", header: t("hub.detail.quants.col.engines"), cell: (row) => (row.engines.length
      ? html`<span class="row">${row.engines.map((engine) => html`<span key=${engine} class="badge badge-neutral">${engine}</span>`)}</span>` : html`<span class="muted">—</span>`), csv: (row) => row.engines.join(" ") },
    { id: "actions", header: html`<span class="sr-only">${t("hub.library.col.actions")}</span>`, hideable: false, csv: false, cell: (row) => html`<${Button} size="sm" href=${downloadHref(row)} testid="detail.quants.download">${t("hub.detail.action.download")}<//>` },
  ];
  return html`<${DataTable} id="quants" columns=${columns} rows=${rows} rowKey=${(row) => row.key} caption=${t("hub.detail.tab.quants")} testid="detail.quants"
    rowAttrs=${(row) => ({ "data-quant": row.label })} />`;
}

// ---- files ---------------------------------------------------------------------------------------

/** @param files [{ path, size, sha256? }] */
export function FilesTable({ files, source, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  const columns = [
    { id: "path", header: t("hub.detail.files.path"), sort: (row) => row.path, cell: (row) => html`<code class="code-inline mono xsmall" data-user-content="">${row.path}</code>`, csv: (row) => row.path },
    { id: "size", header: t("hub.detail.files.size"), align: "end", sort: (row) => Number(row.size) || 0, cell: (row) => html`<span class="num">${Number.isFinite(Number(row.size)) ? fmt.bytes(row.size) : "—"}</span>`, csv: (row) => row.size },
    { id: "sha256", header: t("hub.detail.files.sha256"), hideable: true, cell: (row) => (row.sha256 ? html`<code class="code-inline mono xsmall" title=${row.sha256}>${String(row.sha256).slice(0, 12)}</code>` : html`<span class="muted">—</span>`), csv: (row) => row.sha256 || "" },
  ];
  return html`<${DataTable} id="files" columns=${columns} rows=${files} source=${source} rowKey=${(row) => row.path} caption=${t("hub.detail.tab.files")} exportName="files" testid=${testid || "detail.files"} />`;
}

/** The files of a repository, a page at a time (GET .../files?cursor). */
export function RemoteFiles({ target }) {
  const { api } = useServices();
  const { t } = useT();
  const [extra, setExtra] = useState({ files: [], cursor: null, loading: false, started: false });
  const first = useQuery(["hub", "repos", target.provider, target.owner, target.name, "files"], () => api.get(`${repoPath(target)}/files`, { query: { limit: 200 } }), { ttlMs: 60000 });
  const files = [...(first.data?.files || []), ...extra.files];
  const cursor = extra.started ? extra.cursor : first.data?.nextCursor || null;
  async function more() {
    setExtra((current) => ({ ...current, loading: true }));
    try {
      const body = await api.get(`${repoPath(target)}/files`, { query: { limit: 200, cursor } });
      setExtra((current) => ({ files: [...current.files, ...(body?.files || [])], cursor: body?.nextCursor || null, loading: false, started: true }));
    } catch {
      setExtra((current) => ({ ...current, loading: false }));
    }
  }
  if (first.error && !first.data) return html`<${Failure} error=${first.error} onRetry=${() => first.refetch()} testid="detail.files.error" />`;
  if (!first.data) return html`<div aria-busy="true"><${Skeleton} shape="table" rows=${4} /></div>`;
  if (!files.length) return html`<p class="muted">${t("hub.detail.files.none")}</p>`;
  return html`<${FilesTable} files=${files} source=${{ cursor, loading: extra.loading, loadMore: more }} />`;
}
