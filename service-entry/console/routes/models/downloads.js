// /models/downloads (07 §6.4 "Downloads"): the one download queue of the
// platform (03 §8), in three tabs.
//
// Active: a ProgressRow per job with the phase Stepper (queued, resolving,
// downloading, materializing, verifying, ready), per-file rows, the wait or
// retry line, and the actions Pause/Resume, Cancel (keep files) and Cancel and
// delete partial files (asks first, downloads-actions.js). A failed job shows
// the classified failure card (downloads-failure.js) until it is dismissed.
// An aggregate throughput sparkline sits above the tabs. Queued: reorder by
// drag or by the up/down buttons (POST downloads/reorder {ids}), priority, Start
// now, and Pause all. History: search, over the finished jobs and the compacted
// history. The settings Drawer (global) is loaded when first opened.
//
// The list lives under the query key ["hub","downloads","list"] with the hub's
// own shape ({ jobs, aggregate }), so the `downloads` events of the event
// stream (lib/events.js) update progress in place with no refetch; a
// `truncated` replay refetches. History is kept under ["hub","history"] so the
// progress events do not refetch it.
//
// Before the hub exists the page lists the managers' own download jobs,
// read-only, and says so.

import { describeError } from "../../lib/api.js";
import {
  PRIORITIES, applyOrder, fileRows, jobTitle, moveId, percentOf, phaseSteps, pushSample, sparkPoints, speedOf, splitJobs, stateLine,
} from "../../lib/downloads-model.js";
import { degradable } from "../../lib/library-model.js";
import { Button } from "../../components/button.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { ProgressRow } from "../../components/progress-row.js";
import { Skeleton } from "../../components/skeleton.js";
import { Stepper } from "../../components/stepper.js";
import { StatusBadge } from "../../components/status-badge.js";
import { Tabs, readQueryParam } from "../../components/tabs.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useRole, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useRef, useState } from "../../ui/vendor.js";
import { useJobActions } from "./downloads-actions.js";
import { FailureCard } from "./downloads-failure.js";
import { Lazy } from "./lazy.js";
import { ModelsNav } from "./subnav.js";

const enc = encodeURIComponent;
const LIST_KEY = ["hub", "downloads", "list"];
const TABS = Object.freeze(["active", "queued", "history"]);

function useTicker(on) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [on]);
  return now;
}

function Spark({ samples, current }) {
  const { t } = useT();
  const fmt = useFormat();
  return html`<span class="row-nowrap" data-testid="downloads.spark">
    <svg class="spark" viewBox="0 0 160 36" width="160" height="36" role="img" aria-label=${t("hub.downloads.throughput", { speed: `${fmt.bytes(current)}/s` })}>
      <polyline points=${sparkPoints(samples, 160, 36)} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
    <span class="num small" data-testid="downloads.speed">${fmt.bytes(current)}/s</span>
  </span>`;
}

function Summary({ aggregate, samples }) {
  const { t } = useT();
  const fmt = useFormat();
  if (!aggregate) return null;
  return html`<div class="row downloads-summary" data-testid="downloads.summary">
    <span class="num small" data-testid="downloads.counts">${t("hub.downloads.counts", { active: aggregate.activeCount || 0, queued: aggregate.queuedCount || 0 })}</span>
    <${Spark} samples=${samples} current=${Number(aggregate.speedBps) || 0} />
    ${Number.isFinite(aggregate.etaSeconds) && aggregate.etaSeconds !== null ? html`<span class="small muted">${t("common.progress.eta", { time: fmt.duration(aggregate.etaSeconds * 1000) })}</span>` : null}
  </div>`;
}

function JobLog({ job }) {
  const { api } = useServices();
  return html`<${Lazy} from=${() => import("../../components/log-viewer.js")} name="LogViewer" source=${{ kind: "download", id: job.id }} pollMs=${4000} follow=${true} testid="download.log"
    load=${({ tail }) => api.get(`/api/hub/downloads/${enc(job.id)}/logs`, { query: { tail } })} />`;
}

function FileRows({ job }) {
  const { t } = useT();
  const fmt = useFormat();
  const files = fileRows(job);
  if (!files.length) return null;
  return html`<details data-testid="download.files"><summary class="small">${t("hub.downloads.files", { count: files.length })}</summary>
    <ul class="download-files">${files.map((file) => html`<li key=${file.path} class="row-nowrap" data-state=${file.state}>
      <span class="grow mono xsmall truncate" data-user-content="">${file.path}</span>
      <span class="num xsmall">${file.size ? `${fmt.bytes(file.bytes)} / ${fmt.bytes(file.size)}` : fmt.bytes(file.bytes)}</span>
      <span class="badge badge-neutral">${t(file.state === "complete" ? "hub.downloads.file.complete" : "hub.downloads.file.partial")}</span>
    </li>`)}</ul></details>`;
}

function StateText({ job, now }) {
  const { t } = useT();
  const line = stateLine(job, now);
  return t(line.key, line.vars);
}

function JobTitle({ job }) {
  return html`<span data-user-content="" data-testid="download.title">${jobTitle(job)}</span>`;
}

function ActiveJob({ job, owner, actions, focused, now }) {
  const { t, tk } = useT();
  const [logOpen, setLogOpen] = useState(false);
  const node = useRef(null);
  const { run, busy } = actions;
  const failed = job.state === "failed";
  const inProcess = ["resolving", "downloading", "materializing", "verifying"].includes(job.state);
  useEffect(() => {
    if (focused) node.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  const progress = job.progress || {};
  const line = stateLine(job, now);
  const controls = owner ? html`
    ${inProcess || job.state === "retrying" ? html`<${Button} size="sm" busy=${Boolean(busy[`${job.id}:pause`])} onClick=${() => run.pause(job)} testid="download.pause">${t("hub.action.pause")}<//>` : null}
    ${job.state === "paused" || job.state === "interrupted" ? html`<${Button} size="sm" variant="primary" busy=${Boolean(busy[`${job.id}:resume`])} onClick=${() => run.resume(job)} testid="download.resume">${t("hub.action.resume")}<//>` : null}
    ${!failed ? html`<${Button} size="sm" busy=${Boolean(busy[`${job.id}:cancel`])} onClick=${() => run.cancelKeep(job)} testid="download.cancel-keep">${t("hub.action.cancel-keep")}<//>
      <${Button} size="sm" variant="danger" onClick=${() => actions.startCancelDelete(job)} testid="download.cancel-delete">${t("hub.action.cancel-delete")}<//>` : html`<${Button} size="sm" busy=${Boolean(busy[`${job.id}:remove`])} onClick=${() => run.remove(job)} testid="download.dismiss">${t("common.dismiss")}<//>`}
    <${Button} size="sm" variant="ghost" onClick=${() => setLogOpen(!logOpen)} aria-expanded=${logOpen ? "true" : "false"} testid="download.log-toggle">${t("hub.action.view-log")}<//>` : null;
  return html`<li ref=${node} class="download-job stack-sm" data-testid="download.job" data-job=${job.id} data-state=${job.state} data-focus=${focused ? "true" : "false"}>
    ${failed ? html`<div class="row"><strong><${JobTitle} job=${job} /></strong><${StatusBadge} status="error" label=${t("hub.state.failed")} /></div>`
      : html`<${ProgressRow} label=${html`<${JobTitle} job=${job} />`} percent=${percentOf(job)} bytesDone=${progress.bytesDone} bytesTotal=${progress.bytesTotal || job.artifact?.totalBytes}
        speedBps=${inProcess ? speedOf(job) : undefined} etaSec=${inProcess && Number.isFinite(progress.etaSeconds) ? progress.etaSeconds : undefined}
        phase=${t(line.key, line.vars)} testid="download.progress" />`}
    ${owner ? html`<div class="row">${controls}</div>` : null}
    <${Stepper} steps=${phaseSteps(job).map((step) => ({ ...step, label: t(tk("hub.phase.", step.id)) }))} label=${t("hub.downloads.phases")} testid="download.stepper" />
    ${failed ? html`<${FailureCard} job=${job} owner=${owner} actions=${actions} onViewLog=${() => setLogOpen(true)} />` : null}
    <${FileRows} job=${job} />
    ${logOpen ? html`<${JobLog} job=${job} />` : null}
  </li>`;
}

function QueuedJob({ job, index, total, owner, actions, focused, now, dragging, onMove, onDragStart, onDrop, buttonRefs }) {
  const { t, tk } = useT();
  const fmt = useFormat();
  const { run, busy } = actions;
  const node = useRef(null);
  const [token, setToken] = useState(false);
  useEffect(() => {
    if (focused) node.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  const name = jobTitle(job);
  const move = (delta) => html`<${Button} size="sm" iconOnly=${true} elRef=${(element) => {
    buttonRefs.current[`${job.id}:${delta}`] = element;
  }} label=${t(delta < 0 ? "hub.downloads.moveUp" : "hub.downloads.moveDown", { name })} disabled=${delta < 0 ? index === 0 : index === total - 1}
    onClick=${() => onMove(index, index + delta, job.id, delta)} testid=${delta < 0 ? "download.up" : "download.down"}>${delta < 0 ? "↑" : "↓"}<//>`;
  return html`<li ref=${node} class=${`download-job stack-sm${dragging ? " is-dragging" : ""}`} data-testid="download.queued" data-job=${job.id} data-state=${job.state} data-position=${index + 1}
    data-focus=${focused ? "true" : "false"} draggable=${owner ? "true" : undefined} onDragStart=${(event) => onDragStart(event, job.id)} onDragOver=${(event) => owner && event.preventDefault()} onDrop=${(event) => onDrop(event, job.id)}>
    <div class="row-nowrap">
      <span class="badge badge-neutral num" aria-label=${t("hub.downloads.position", { n: index + 1 })}>#${index + 1}</span>
      <strong class="grow truncate"><${JobTitle} job=${job} /></strong>
      <span class="num small">${fmt.bytes(job.artifact?.totalBytes)}</span>
      ${owner ? html`<span class="row-nowrap">${move(-1)}${move(1)}</span>` : null}
    </div>
    <div class="row">
      <span class="small muted" data-testid="download.line"><${StateText} job=${job} now=${now} /></span>
      ${owner ? html`<label class="row-nowrap"><span class="small muted">${t("hub.downloads.priority")}</span>
        <select class="select" value=${job.priority || "normal"} data-testid="download.priority" onChange=${(event) => run.priority(job, event.currentTarget.value)}>
          ${PRIORITIES.map((value) => html`<option key=${value} value=${value} selected=${(job.priority || "normal") === value}>${t(tk("hub.downloads.priority.", value))}</option>`)}
        </select></label>
        <${Button} size="sm" variant="primary" busy=${Boolean(busy[`${job.id}:start-now`])} onClick=${() => run.startNow(job)} testid="download.start-now">${t("hub.action.start-now")}<//>
        <${Button} size="sm" busy=${Boolean(busy[`${job.id}:pause`])} onClick=${() => run.pause(job)} testid="download.pause">${t("hub.action.pause")}<//>
        <${Button} size="sm" busy=${Boolean(busy[`${job.id}:cancel`])} onClick=${() => run.cancelKeep(job)} testid="download.cancel-keep">${t("hub.action.cancel-keep")}<//>
        ${job.waitReason === "auth" ? html`<${Button} size="sm" onClick=${() => setToken(!token)} testid="download.enter-token">${t("hub.action.enter-token")}<//>` : null}` : null}
    </div>
    ${token ? html`<${Lazy} from=${() => import("./downloads-token.js")} name="TokenResume" job=${job} run=${run} busy=${busy} onDone=${() => setToken(false)} />` : null}
  </li>`;
}

function QueuedTab({ jobs, owner, actions, focusId, now }) {
  const { t } = useT();
  const [order, setOrder] = useState([]);
  const [dragId, setDragId] = useState("");
  const [said, setSaid] = useState("");
  const buttonRefs = useRef({});
  const pendingFocus = useRef(null);
  const shown = applyOrder(jobs, order);
  const ids = shown.map((job) => job.id);

  // A reorder the server has echoed (the same order) is no longer pending.
  useEffect(() => {
    if (order.length && jobs.map((job) => job.id).join() === order.join()) setOrder([]);
  }, [jobs.map((job) => job.id).join(), order.join()]);
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted) {
      pendingFocus.current = null;
      const same = buttonRefs.current[`${wanted.id}:${wanted.delta}`];
      (same && !same.disabled ? same : buttonRefs.current[`${wanted.id}:${-wanted.delta}`])?.focus?.();
    }
  });

  async function reorder(from, to, id, delta) {
    const next = moveId(ids, from, to);
    if (next === ids) return;
    setOrder(next);
    if (delta !== undefined) pendingFocus.current = { id, delta };
    const job = shown[from];
    setSaid(t("hub.downloads.moved", { name: jobTitle(job), position: to + 1, total: ids.length }));
    const ok = await actions.run.reorder(next);
    if (!ok) setOrder([]);
  }
  function onDrop(event, overId) {
    event.preventDefault();
    const from = ids.indexOf(dragId);
    setDragId("");
    if (from >= 0) reorder(from, ids.indexOf(overId));
  }
  if (!shown.length) {
    return html`<${EmptyState} testid="downloads.queued-empty" icon="info" title=${t("hub.downloads.queuedEmpty")} body=${t("hub.downloads.queuedEmptyBody")} action=${{ label: t("hub.nav.discover"), href: "/models/discover" }} />`;
  }
  return html`<div class="stack-sm">
    <p class="small muted">${t("hub.downloads.reorderHint")}</p>
    <span class="sr-only" role="status" data-testid="downloads.moved">${said}</span>
    <ol class="download-list" data-testid="downloads.queue">${shown.map((job, index) => html`<${QueuedJob} key=${job.id} job=${job} index=${index} total=${shown.length} owner=${owner} actions=${actions}
      focused=${focusId === job.id} now=${now} dragging=${dragId === job.id} onMove=${reorder} onDragStart=${(event, id) => {
      setDragId(id);
      event.dataTransfer?.setData?.("text/plain", id);
    }} onDrop=${onDrop} buttonRefs=${buttonRefs} />`)}</ol>
  </div>`;
}

function ActiveTab({ jobs, owner, actions, focusId, now }) {
  const { t } = useT();
  if (!jobs.length) {
    return html`<${EmptyState} testid="downloads.active-empty" icon="info" title=${t("hub.downloads.activeEmpty")} body=${t("hub.downloads.activeEmptyBody")} action=${{ label: t("hub.nav.discover"), href: "/models/discover" }} />`;
  }
  return html`<ul class="download-list" data-testid="downloads.active">${jobs.map((job) => html`<${ActiveJob} key=${job.id} job=${job} owner=${owner} actions=${actions} focused=${focusId === job.id} now=${now} />`)}</ul>`;
}

// ---- the page -------------------------------------------------------------------------------------------

export default function DownloadsPage({ query = {} }) {
  const { api, i18n } = useServices();
  const { t, tk } = useT();
  const owner = useRole() === "owner";
  const actions = useJobActions();
  const focusId = typeof query.job === "string" ? query.job : "";
  const list = useQuery(LIST_KEY, () => api.get("/api/hub/downloads", { query: { include: "terminal", limit: 200 } }), { ttlMs: 5000, refetchMs: 15000 });
  const groups = splitJobs(list.data?.jobs);
  const [tab, setTab] = useState(() => {
    const wanted = readQueryParam("tab");
    return TABS.includes(wanted) ? wanted : "active";
  });
  const [samples, setSamples] = useState([]);
  const [Settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(() => owner && query.drawer === "settings");
  const picked = useRef(false);
  const retrying = groups.active.some((job) => job.state === "retrying");
  const now = useTicker(retrying);
  const aggregate = list.data?.aggregate;

  useEffect(() => {
    if (aggregate) setSamples((current) => pushSample(current, aggregate.speedBps));
  }, [aggregate]);
  // A link to one job (?job=) opens the tab it is in, unless the URL names a tab.
  useEffect(() => {
    if (!focusId || picked.current || !list.data || readQueryParam("tab")) return;
    picked.current = true;
    setTab(groups.queued.some((job) => job.id === focusId) ? "queued" : groups.finished.some((job) => job.id === focusId) ? "history" : "active");
  }, [focusId, list.data]);
  useEffect(() => {
    if (!settingsOpen || Settings) return undefined;
    let alive = true;
    import("./downloads-settings.js").then((module) => alive && setSettings(() => module.default));
    return () => {
      alive = false;
    };
  }, [settingsOpen]);

  const hubMissing = list.error && !list.data && degradable(list.error);
  const headerActions = html`${owner && !hubMissing ? html`<${Button} onClick=${() => setSettingsOpen(true)} testid="downloads.settings">${t("hub.downloads.settings")}<//>
    <${Button} busy=${Boolean(actions.busy["all:resume-all"])} onClick=${() => actions.run.resumeAll()} testid="downloads.resume-all">${t("hub.downloads.resumeAll")}<//>
    <${Button} busy=${Boolean(actions.busy["all:pause-all"])} onClick=${() => actions.run.pauseAll()} testid="downloads.pause-all">${t("hub.downloads.pauseAll")}<//>` : null}
    <${Button} variant="primary" href="/models/discover" testid="downloads.discover">${t("hub.nav.discover")}<//>`;

  let body;
  if (hubMissing) {
    body = html`<${Lazy} from=${() => import("./downloads-history.js")} name="ManagerJobs" />`;
  } else if (list.error && !list.data) {
    body = html`<${EmptyState} testid="downloads.error" icon="triangle-alert" title=${t("hub.downloads.failed")} body=${describeError(list.error, i18n)} action=${{ label: t("hub.library.retry"), onClick: () => list.refetch() }} />`;
  } else if (!list.data) {
    body = html`<div aria-busy="true" data-testid="downloads.loading"><${Skeleton} shape="tile" /><${Skeleton} shape="line" rows=${4} /></div>`;
  } else {
    const tabs = TABS.map((id) => ({ id, label: t(tk("hub.downloads.tab.", id)), ...(id === "history" ? {} : { badge: groups[id].length }) }));
    body = html`<div class="stack">
      <${Summary} aggregate=${aggregate} samples=${samples} />
      <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} label=${t("hub.nav.downloads")} testid="downloads.tabs"
        renderPanel=${(active) => (active === "queued" ? html`<${QueuedTab} jobs=${groups.queued} owner=${owner} actions=${actions} focusId=${focusId} now=${now} />`
          : active === "history" ? html`<${Lazy} from=${() => import("./downloads-history.js")} name="HistoryTab" finished=${groups.finished} owner=${owner} actions=${actions} focusId=${focusId} />`
            : html`<${ActiveTab} jobs=${groups.active} owner=${owner} actions=${actions} focusId=${focusId} now=${now} />`)} />
    </div>`;
  }
  return html`<div class="stack" data-testid="downloads" data-source=${hubMissing ? "managers" : "hub"}>
    <${PageHeader} title=${t("shell.nav.models")} subtitle=${t("hub.downloads.subtitle")} actions=${headerActions} />
    <${ModelsNav} current="downloads" />
    ${body}
    ${actions.dialog}
    ${settingsOpen && Settings ? html`<${Settings} onClose=${() => setSettingsOpen(false)} />` : null}
  </div>`;
}
