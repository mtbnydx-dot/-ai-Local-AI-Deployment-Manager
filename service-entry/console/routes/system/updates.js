// /system/updates (06 §9.5, §10.2, §11; 07 §6.13, CON-24b): what is deployed,
// what is not, and what is waiting to restart.
//
// Data: GET /api/platform/version (the version, the build's `commit` and
// `contentHash`, newer commits on the update branch and the live-file drift
// count), GET /api/platform/deploys (the history) and GET
// /api/platform/pending-restarts. A pending restart can be cancelled after a
// confirmation (DELETE /api/platform/pending-restarts/:id). Nothing is
// deployed from here: the page shows the command to run on this machine.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { DataTable } from "../../components/data-table.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";
import { isUnavailable, P6Required, usePlatformOn } from "./gate.js";
import { SystemNav } from "./subnav.js";
import { normalizeDeploys, normalizePending, normalizeVersion } from "./updates-model.js";

const DASH = "—";
const UPDATE_COMMAND = "platform update";
const VERSION_KEY = ["platform", "version"];

function Fact({ label, children, testid }) {
  return html`<div class="deploy-fact"><dt class="small muted">${label}</dt><dd data-testid=${testid}>${children}</dd></div>`;
}

export default function Updates() {
  const { api, cache, toasts } = useServices();
  const i18n = useT();
  const { t, has } = i18n;
  const fmt = useFormat();
  const platformOn = usePlatformOn();
  const version = useQuery(VERSION_KEY, () => api.get("/api/platform/version"), { ttlMs: 30000, enabled: platformOn });
  const deploys = useQuery(["platform-deploys"], () => api.get("/api/platform/deploys", { query: { limit: 20 } }), { ttlMs: 30000, enabled: platformOn });
  const pendingList = useQuery(["platform-pending"], () => api.get("/api/platform/pending-restarts"), { ttlMs: 5000, refetchMs: 15000, enabled: platformOn });
  const [cancelling, setCancelling] = useState(null);

  const header = html`<${PageHeader} title=${t("platform.updates.title")} subtitle=${t("platform.updates.subtitle")}
    actions=${html`<${Button} icon="refresh-cw" onClick=${refresh} testid="updates.refresh">${t("platform.updates.refresh")}<//>`} />`;
  const nav = html`<${SystemNav} current="updates" owner=${true} />`;

  function refresh() {
    cache.invalidate(VERSION_KEY, { exact: true });
    cache.invalidate(["platform-deploys"]);
    cache.invalidate(["platform-pending"]);
  }

  if (!platformOn || (isUnavailable(version.error) && version.data === undefined)) return html`<${P6Required} current="updates" titleKey="platform.updates.title" />`;
  if (version.data === undefined && version.status !== "error") {
    return html`<div class="stack" data-testid="updates.root" aria-busy="true">${header}${nav}<${Skeleton} shape="table" rows=${5} /></div>`;
  }
  if (version.data === undefined) {
    return html`<div class="stack" data-testid="updates.root">${header}${nav}
      <${EmptyState} icon="circle-x" level=${2} title=${t("platform.updates.error.title")} body=${describeError(version.error, i18n)}
        action=${{ label: t("shell.conn.retry"), onClick: () => version.refetch() }} testid="updates.error" />
    </div>`;
  }

  const info = normalizeVersion(version.data);
  const rows = normalizeDeploys(deploys.data);
  const pending = normalizePending(pendingList.data);
  const when = (iso) => (iso ? fmt.dateTime(iso) : DASH);

  const deployColumns = [
    { id: "deployedAt", header: t("platform.updates.col.deployedAt"), sort: (row) => row.deployedAt || "", cell: (row) => when(row.deployedAt) },
    { id: "commit", header: t("platform.updates.col.commit"), sort: (row) => row.commit, cell: (row) => (row.commit ? html`<code class="code-inline">${row.commit}</code>` : DASH) },
    { id: "branch", header: t("platform.updates.col.branch"), hideable: true, sort: (row) => row.branch, cell: (row) => row.branch || DASH },
    { id: "created", header: t("platform.updates.col.created"), align: "end", hideable: true, sort: (row) => row.created, cell: (row) => html`<span class="tabular">${fmt.integer(row.created)}</span>` },
    { id: "updated", header: t("platform.updates.col.updated"), align: "end", hideable: true, sort: (row) => row.updated, cell: (row) => html`<span class="tabular">${fmt.integer(row.updated)}</span>` },
    { id: "unchanged", header: t("platform.updates.col.unchanged"), align: "end", hideable: true, defaultHidden: true, sort: (row) => row.unchanged, cell: (row) => html`<span class="tabular">${fmt.integer(row.unchanged)}</span>` },
    { id: "pruned", header: t("platform.updates.col.pruned"), align: "end", hideable: true, sort: (row) => row.pruned, cell: (row) => html`<span class="tabular">${fmt.integer(row.pruned)}</span>` },
  ];
  const pendingColumns = [
    { id: "component", header: t("platform.updates.col.component"), sort: (row) => row.id, cell: (row) => html`<code class="code-inline">${row.id}</code>` },
    { id: "reason", header: t("platform.updates.col.reason"), sort: (row) => row.reason, cell: (row) => (has(tk("platform.updates.reason.", row.reason)) ? t(tk("platform.updates.reason.", row.reason)) : row.reason || DASH) },
    { id: "queuedAt", header: t("platform.updates.col.queuedAt"), sort: (row) => row.queuedAt || "", cell: (row) => (row.queuedAt ? fmt.relative(row.queuedAt) : DASH) },
    { id: "deadline", header: t("platform.updates.col.deadline"), hideable: true, sort: (row) => row.deadline || "", cell: (row) => when(row.deadline) },
    {
      id: "actions", header: t("platform.updates.col.actions"), csv: false,
      cell: (row) => html`<${Button} size="sm" variant="danger" label=${t("platform.updates.cancelFor", { component: row.id })} onClick=${() => setCancelling(row)} testid="updates.cancel">${t("platform.updates.cancel")}<//>`,
    },
  ];

  return html`<div class="stack" data-testid="updates.root">
    ${header}
    ${nav}
    <${Card} title=${t("platform.updates.version")} level=${2} testid="updates.version">
      <div class="stack">
        <dl class="deploy-facts">
          <${Fact} label=${t("platform.updates.fact.version")} testid="updates.version-value">${info.version || DASH}<//>
          <${Fact} label=${t("platform.updates.fact.commit")} testid="updates.commit">${info.commit ? html`<code class="code-inline">${info.commit}</code>` : DASH}<//>
          <${Fact} label=${t("platform.updates.fact.contentHash")} testid="updates.content-hash">${info.contentHash ? html`<code class="code-inline">${info.contentHash}</code>` : DASH}<//>
          <${Fact} label=${t("platform.updates.fact.node")} testid="updates.node">${info.node || DASH}<//>
          ${info.newer.deployed ? html`<${Fact} label=${t("platform.updates.fact.deployed")} testid="updates.deployed"><code class="code-inline">${info.newer.deployed}</code><//>` : null}
          ${info.newer.head ? html`<${Fact} label=${t("platform.updates.fact.head")} testid="updates.head"><code class="code-inline">${info.newer.head}</code><//>` : null}
        </dl>
        ${info.newer.available
          ? html`<div class="notice notice-warn" role="status" data-testid="updates.newer">
            <div class="stack-sm grow">
              <strong>${t("platform.updates.newer", { n: info.newer.behind })}</strong>
              <span>${t("platform.updates.howto")}</span>
              <${CodeBlock} code=${UPDATE_COMMAND} testid="updates.command" />
            </div>
          </div>`
          : info.newer.behind === 0
            ? html`<p data-testid="updates.up-to-date"><${StatusBadge} status="ok" label=${t("platform.updates.upToDate")} /></p>`
            : html`<p class="muted" data-testid="updates.newer-unknown">${t("platform.updates.newerUnknown", { code: info.newer.error || "unknown" })}</p>`}
        ${info.drift.count > 0
          ? html`<div class="notice notice-warn" role="status" data-testid="updates.drift">
            <div class="stack-sm grow">
              <strong>${t("platform.drift.found", { n: info.drift.count })}</strong>
              ${info.drift.checkedAt ? html`<span class="small muted">${t("platform.drift.checked", { time: fmt.dateTime(info.drift.checkedAt) })}</span>` : null}
            </div>
            <${Button} size="sm" href="/system/doctor?group=ops" testid="updates.drift-review">${t("platform.drift.review")}<//>
          </div>`
          : html`<p data-testid="updates.no-drift"><${StatusBadge} status="ok" label=${t("platform.drift.none")} /></p>`}
      </div>
    <//>
    ${info.packages.length ? html`<${Card} title=${t("platform.updates.packages")} level=${2} testid="updates.packages">
      <dl class="deploy-facts">
        ${info.packages.map((item) => html`<${Fact} key=${item.dir} label=${item.dir}>${item.version || DASH}<//>`)}
      </dl>
    <//>` : null}
    <${Card} title=${t("platform.updates.pending")} level=${2} testid="updates.pending">
      ${pendingList.data === undefined && pendingList.status !== "error" ? html`<${Skeleton} shape="table" rows=${2} />` : null}
      ${pendingList.status === "error" && pendingList.data === undefined ? html`<p class="field-error" role="alert">${describeError(pendingList.error, i18n)}</p>` : null}
      ${pendingList.data !== undefined
        ? html`<${DataTable} id="updates-pending" caption=${t("platform.updates.pending.caption")} columns=${pendingColumns} rows=${pending} rowKey="id" responsive="cards"
          empty=${html`<p class="muted" data-testid="updates.pending-none">${t("platform.updates.pending.none")}</p>`} testid="updates.pending-table" />`
        : null}
    <//>
    <${Card} title=${t("platform.updates.deploys")} level=${2} testid="updates.deploys">
      ${deploys.data === undefined && deploys.status !== "error" ? html`<${Skeleton} shape="table" rows=${3} />` : null}
      ${deploys.status === "error" && deploys.data === undefined ? html`<p class="field-error" role="alert">${describeError(deploys.error, i18n)}</p>` : null}
      ${deploys.data !== undefined
        ? html`<${DataTable} id="updates-deploys" caption=${t("platform.updates.deploys.caption")} columns=${deployColumns} rows=${rows} rowKey="stamp" responsive="cards" exportName="platform-deploys"
          empty=${html`<${EmptyState} icon="rocket" title=${t("platform.updates.deploys.empty.title")} body=${t("platform.updates.deploys.empty.body")}
            action=${{ label: t("platform.updates.refresh"), onClick: refresh }} testid="updates.deploys-empty" />`} testid="updates.deploys-table" />`
        : null}
    <//>
    <${ConfirmDialog} open=${Boolean(cancelling)} tone="danger" title=${cancelling ? t("platform.updates.cancel.title", { component: cancelling.id }) : ""}
      body=${t("platform.updates.cancel.body")} confirmLabel=${t("platform.updates.cancel")}
      onConfirm=${async () => {
        await api.del(`/api/platform/pending-restarts/${encodeURIComponent(cancelling.id)}`);
        cache.invalidate(["platform"]);
        cache.invalidate(["platform-pending"]);
        toasts?.push?.({ level: "success", title: cancelling.id, body: t("platform.updates.cancelled") });
      }} onClose=${() => setCancelling(null)} testid="updates.cancel-confirm" />
  </div>`;
}
