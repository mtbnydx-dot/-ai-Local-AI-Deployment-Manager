// The History tab and the pre-hub fallback of the Downloads page (downloads.js
// loads this file when the History tab or the fallback is first shown).
//
// History lists the finished jobs the queue still holds plus the compacted
// history (GET /api/hub/downloads/history), searchable. Before the hub exists
// the page lists the managers' own download jobs, read-only, and says so.

import { describeError } from "../../lib/api.js";
import { historyRows, jobTitle } from "../../lib/downloads-model.js";
import { degradable } from "../../lib/library-model.js";
import { Button } from "../../components/button.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusBadge } from "../../components/status-badge.js";
import { useServices } from "../../ui/context.js";
import { useDebounced, useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useState } from "../../ui/vendor.js";

const enc = encodeURIComponent;
const STATE_TONE = Object.freeze({ ready: "ok", failed: "error", cancelled: "neutral", paused: "warn", interrupted: "warn", retrying: "warn" });
const MANAGERS = ["vllm", "llama"];

function JobTitle({ job }) {
  return html`<span data-user-content="" data-testid="download.title">${jobTitle(job)}</span>`;
}

function HistoryRow({ job, owner, actions, focused }) {
  const { t, tk, pick } = useT();
  const fmt = useFormat();
  const done = job.finishedAt || job.updatedAt;
  const entryId = job.result?.entryId;
  const status = STATE_TONE[job.state] || "neutral";
  return html`<li class="download-job stack-sm" data-testid="download.history" data-job=${job.id} data-state=${job.state} data-focus=${focused ? "true" : "false"}>
    <div class="row">
      <strong class="grow truncate"><${JobTitle} job=${job} /></strong>
      <${StatusBadge} status=${status} label=${t(tk("hub.state.", job.state), { done: 0, total: 0, seconds: 0, n: 0, max: 0 })} />
      <span class="num small">${fmt.bytes(job.artifact?.totalBytes)}</span>
      ${done ? html`<time class="small muted" dateTime=${done} title=${fmt.dateTime(done)}>${fmt.relative(done)}</time>` : null}
      ${job.target?.rootLabel ? html`<span class="small muted" data-user-content="">${job.target.rootLabel}</span>` : null}
      ${entryId ? html`<a href=${`/models/library/${enc(entryId)}`} data-testid="download.library-link">${t("hub.downloads.openLibrary")}</a>` : null}
      ${owner && (job.state === "failed" || job.state === "cancelled") ? html`<${Button} size="sm" busy=${Boolean(actions.busy[`${job.id}:retry`])} onClick=${() => actions.run.retry(job)} testid="download.retry">${t("hub.action.retry")}<//>` : null}
    </div>
    ${job.state === "failed" && job.error ? html`<p class="small muted" data-user-content="" data-testid="download.history-error">${job.error.title ? pick(job.error.title) : t("hub.error.fallback")}</p>` : null}
  </li>`;
}

export function HistoryTab({ finished, owner, actions, focusId }) {
  const { api, i18n } = useServices();
  const { t } = useT();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 300);
  const history = useQuery(["hub", "history", "list", debounced], () => api.get("/api/hub/downloads/history", { query: { ...(debounced ? { q: debounced } : {}), limit: 100 } }), { ttlMs: 10000 });
  const rows = historyRows(finished, history.data?.records, debounced);
  return html`<div class="stack-sm">
    <label class="deploy-filter"><span class="small muted">${t("hub.library.filter.search")}</span>
      <input class="input" type="search" value=${q} autocomplete="off" data-testid="downloads.history-q" onInput=${(event) => setQ(event.currentTarget.value)} /></label>
    ${history.error && !history.data && !degradable(history.error) ? html`<p class="field-error" role="alert">${describeError(history.error, i18n)}</p>` : null}
    ${rows.length ? html`<ul class="download-list" data-testid="downloads.history">${rows.map((job) => html`<${HistoryRow} key=${job.id} job=${job} owner=${owner} actions=${actions} focused=${focusId === job.id} />`)}</ul>`
      : html`<${EmptyState} testid="downloads.history-empty" icon="search" title=${t("hub.downloads.historyEmpty")} body=${t("hub.downloads.historyEmptyBody")} action=${{ label: t("hub.nav.discover"), href: "/models/discover" }} />`}
  </div>`;
}

// ---- before the hub: the managers' own download jobs, read-only ------------------------------------------

async function loadManagerDownloads(api) {
  const settled = await Promise.allSettled(MANAGERS.map((managerId) => api.manager(managerId).get("/jobs", { query: { fields: "summary" } })));
  const answers = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!answers.length) throw settled[0].reason;
  return answers.flatMap((body) => (Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : []))
    .filter((job) => job && typeof job === "object" && /download|pull/i.test(String(job.type || job.kind || "")));
}

export function ManagerJobs() {
  const { api, i18n } = useServices();
  const { t } = useT();
  const query = useQuery(["hub", "downloads", "managers"], () => loadManagerDownloads(api), { ttlMs: 10000, refetchMs: 10000 });
  return html`<div class="stack" data-testid="downloads.degraded">
    <div class="notice notice-info" role="status">${t("hub.downloads.degraded")}</div>
    ${query.error && !query.data ? html`<${EmptyState} icon="triangle-alert" title=${t("hub.downloads.failed")} body=${describeError(query.error, i18n)} action=${{ label: t("hub.library.retry"), onClick: () => query.refetch() }} />`
      : query.data && !query.data.length ? html`<p class="muted">${t("hub.downloads.activeEmpty")}</p>`
        : html`<ul class="download-list">${(query.data || []).map((job) => html`<li key=${job.id} class="download-job row" data-testid="download.manager-job">
          <strong class="grow truncate" data-user-content="">${job.label || job.repo || job.model || job.id}</strong>
          <span class="badge badge-neutral">${job.status || job.state || "—"}</span></li>`)}</ul>`}
  </div>`;
}

