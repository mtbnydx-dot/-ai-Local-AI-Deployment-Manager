// /system/doctor (06 §7, §11; 07 §6.13, CON-24b): the platform's checks grouped
// by category, each with its status, detail and fix.
//
// Data: GET /api/platform/doctor?group=&fresh= (06 §10.2; cached 30 s on the
// entry, "Run again" sends fresh=1). A fix is one of three kinds (06 §7.3):
//   auto     a Fix button that runs at once;
//   confirm  a Fix button that opens a ConfirmDialog first;
//   manual   the command in a CodeBlock with Copy and a Docs link. No request
//            is ever sent for it.
// An auto or confirmed fix is POST /api/platform/doctor/fix {checkId, fixId,
// confirm?} -> 202 {opId}; the page follows the operation until it ends and
// then runs the doctor again. Before the platform backend is mounted the page
// shows each model manager's GET /api/tools/health with its remediation
// actions (07 §6.13 degrade path).

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { EmptyState } from "../../components/empty-state.js";
import { PageHeader } from "../../components/page-header.js";
import { Skeleton } from "../../components/skeleton.js";
import { StatusBadge } from "../../components/status-badge.js";
import { readQueryParam, replaceQueryParam } from "../../components/tabs.js";
import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { safeUrl } from "../../lib/url.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useRef, useState } from "../../ui/vendor.js";
import { DOCTOR_GROUPS, fixRequest, groupChecks, legacyChecks, normalizeReport, STATUSES, statusTone } from "./doctor-model.js";
import { isUnavailable, usePlatformOn } from "./gate.js";
import { OperationPanel } from "./operation.js";
import { SystemNav } from "./subnav.js";

const GROUP_ALL = "all";

function initialGroup() {
  const value = readQueryParam("group");
  return value && DOCTOR_GROUPS.includes(value) ? value : GROUP_ALL;
}

// The two checks whose backend text is replaced by 06 §11's copy.
function detailOf(check, t) {
  if (check.id === "net.legacy-proxy" && check.status !== "ok") return t("platform.legacyProxy");
  if (check.id === "sec.secret-store" && check.data.protection === "acl-only") return t("platform.secrets.aclOnly");
  return check.detail;
}

function ManualFix({ fix }) {
  const { t } = useT();
  const docs = fix.docs ? safeUrl(fix.docs) : null;
  return html`<div class="stack-sm doctor-fix" data-testid="doctor.manual">
    <p class="small" data-testid="doctor.manual-note">${t("platform.fix.manual")}</p>
    ${fix.label ? html`<p class="small muted">${fix.label}</p>` : null}
    ${fix.command ? html`<${CodeBlock} code=${fix.command} wrap testid="doctor.command" />` : null}
    ${docs ? html`<div class="row"><${Button} size="sm" href=${docs} target="_blank" rel="noopener noreferrer" icon="external-link" testid="doctor.docs">${t("platform.doctor.docs")}<//></div>` : null}
  </div>`;
}

function CheckRow({ check, running, busy, onFix, onDismiss, onDone }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const fix = check.fix;
  const detail = detailOf(check, t);
  const label = fix?.label || t("platform.doctor.fix");
  const statusKey = tk("platform.doctor.status.", check.status);
  return html`<li class="check-row stack-sm" data-check=${check.id} data-status=${check.status} data-testid="doctor.check">
    <div class="row">
      <${StatusBadge} status=${statusTone(check.status)} label=${has(statusKey) ? t(statusKey) : check.status} testid="doctor.status" />
      <strong class="grow" data-testid="doctor.title">${check.title}</strong>
      <code class="code-inline small" data-testid="doctor.id">${check.id}</code>
      ${check.durationMs !== null ? html`<span class="small muted tabular">${fmt.duration(check.durationMs)}</span>` : null}
    </div>
    ${detail ? html`<p class="small muted check-evidence" data-user-content data-testid="doctor.detail">${detail}</p>` : null}
    ${fix && fix.risk !== "manual" && check.status !== "ok"
      ? html`<div class="row doctor-fix" data-testid="doctor.fix-row">
        <${Button} size="sm" variant=${fix.risk === "auto" ? "primary" : "default"} busy=${busy} disabled=${Boolean(running)}
          label=${t("platform.doctor.fixFor", { label, check: check.title })} onClick=${() => onFix(check)} testid="doctor.fix" data-risk=${fix.risk}>${label}<//>
        ${fix.risk === "confirm" ? html`<span class="small muted">${t("platform.doctor.needsConfirm")}</span>` : null}
      </div>`
      : null}
    ${fix && fix.risk === "manual" && check.status !== "ok" ? html`<${ManualFix} fix=${fix} />` : null}
    ${running ? html`<${OperationPanel} opId=${running.opId} label=${running.label} onDone=${(op) => onDone(check, running, op)} onDismiss=${() => onDismiss(check)} testid="doctor.operation" />` : null}
  </li>`;
}

function LegacyAction({ managerId, action }) {
  const { api, toasts } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const [busy, setBusy] = useState(false);
  if (action.kind === "command") {
    return html`<div class="stack-sm" data-testid="doctor.legacy-command"><p class="small">${action.label}</p><${CodeBlock} code=${action.command} wrap /></div>`;
  }
  async function run() {
    setBusy(true);
    try {
      await api.manager(managerId).request(action.path, { method: action.method });
      toasts?.push?.({ level: "success", title: action.label, body: t("platform.strip.started") });
    } catch (error) {
      toasts?.push?.({ level: "error", title: action.label, body: describeError(error, i18n), requestId: error?.requestId || null });
    } finally {
      setBusy(false);
    }
  }
  return html`<${Button} size="sm" busy=${busy} onClick=${run} testid="doctor.legacy-action">${action.label}<//>`;
}

function LegacyManager({ manager }) {
  const { api } = useServices();
  const i18n = useT();
  const { t, pick } = i18n;
  const report = useQuery(["m", manager.id, "tools-health"], () => api.manager(manager.id).get("/tools/health", { timeoutMs: 30000 }), { ttlMs: 15000 });
  const title = typeof manager.label === "string" ? manager.label : pick(manager.label || {}) || manager.id;
  const rows = report.data ? legacyChecks(report.data, pick) : [];
  const refresh = html`<${Button} size="sm" icon="refresh-cw" onClick=${() => report.refetch()} testid="doctor.legacy-refresh">${t("platform.doctor.run")}<//>`;
  return html`<${Card} title=${title} level=${2} actions=${refresh} testid=${`doctor.legacy.${manager.id}`}>
    ${report.data === undefined && report.status !== "error" ? html`<${Skeleton} shape="line" rows=${3} />` : null}
    ${report.status === "error" && report.data === undefined ? html`<p class="field-error" role="alert" data-testid="doctor.legacy-error">${describeError(report.error, i18n)}</p>` : null}
    ${rows.length ? html`<ul class="checks" aria-label=${title}>
      ${rows.map((row) => html`<li key=${row.id} class="check-row stack-sm" data-check=${row.id} data-status=${row.status} data-testid="doctor.legacy-check">
        <div class="row">
          <${StatusBadge} status=${row.tone} label=${t(tk("platform.doctor.status.", row.status === "fail" ? "fail" : row.status === "warn" ? "warn" : "ok"))} />
          <strong class="grow">${row.label}</strong>
        </div>
        ${row.detail ? html`<p class="small muted check-evidence" data-user-content>${row.detail}</p>` : null}
        ${row.actions.map((action) => html`<${LegacyAction} key=${action.id} managerId=${manager.id} action=${action} />`)}
      </li>`)}
    </ul>` : null}
    ${report.data !== undefined && !rows.length ? html`<p class="muted">${t("platform.doctor.legacy.empty")}</p>` : null}
  <//>`;
}

function LegacyDoctor({ managers }) {
  const { t } = useT();
  return html`<div class="stack" data-testid="doctor.legacy">
    <div class="notice" role="status" data-testid="doctor.degraded">
      <div class="stack-sm grow"><strong>${t("platform.doctor.legacy.title")}</strong><span>${t("platform.doctor.legacy.body")}</span></div>
    </div>
    ${managers.length
      ? managers.map((manager) => html`<${LegacyManager} key=${manager.id} manager=${manager} />`)
      : html`<${EmptyState} icon="boxes" level=${2} title=${t("platform.doctor.legacy.none")} action=${{ label: t("platform.system.nav.components"), href: "/system" }} />`}
  </div>`;
}

export default function Doctor() {
  const { api, cache, toasts, bootstrap } = useServices();
  const i18n = useT();
  const { t, pick, has } = i18n;
  const fmt = useFormat();
  const platformOn = usePlatformOn();
  const [group, setGroup] = useState(initialGroup);
  const [runs, setRuns] = useState({});
  const [busyCheck, setBusyCheck] = useState("");
  const [asking, setAsking] = useState(null);
  const fresh = useRef(false);

  const query = useQuery(["platform-doctor", group], () => {
    const wantFresh = fresh.current;
    fresh.current = false;
    return api.get("/api/platform/doctor", { query: { group: group === GROUP_ALL ? undefined : group, fresh: wantFresh ? 1 : undefined }, timeoutMs: 60000 });
  }, { ttlMs: 30000, enabled: platformOn });

  const degraded = !platformOn || (isUnavailable(query.error) && query.data === undefined);

  function runAgain() {
    fresh.current = true;
    query.refetch();
  }

  function chooseGroup(next) {
    setGroup(next);
    replaceQueryParam("group", next === GROUP_ALL ? null : next);
  }

  async function startFix(check, confirmed) {
    const request = fixRequest(check, confirmed);
    if (!request) return;
    const answer = await api.post(request.path, request.body);
    const label = check.fix.label || check.title;
    if (answer?.opId) setRuns((current) => ({ ...current, [check.id]: { opId: String(answer.opId), label, fixId: check.fix.id } }));
    toasts?.push?.({ level: "success", title: label, body: t("platform.doctor.fixStarted") });
  }

  async function onFix(check) {
    if (check.fix.risk === "confirm") {
      setAsking(check);
      return;
    }
    setBusyCheck(check.id);
    try {
      await startFix(check, false);
    } catch (error) {
      toasts?.push?.({ level: "error", title: check.fix.label || check.title, body: describeError(error, i18n), requestId: error?.requestId || null });
    } finally {
      setBusyCheck("");
    }
  }

  function onDone(check, run, op) {
    const ok = op.state === "ok";
    toasts?.push?.({
      level: ok ? "success" : "error",
      title: run.label,
      body: ok ? t("platform.doctor.fixDone") : [t("platform.doctor.fixFailed"), op.result?.message].filter(Boolean).join(" "),
    });
    cache.invalidate(["platform"]);
    runAgain();
  }

  function dismiss(check) {
    setRuns((current) => {
      const next = { ...current };
      delete next[check.id];
      return next;
    });
  }

  const header = html`<${PageHeader} title=${t("platform.doctor.title")} subtitle=${t("platform.doctor.subtitle")}
    actions=${degraded ? null : html`<${Button} icon="refresh-cw" busy=${query.fetching} onClick=${runAgain} testid="doctor.run">${t("platform.doctor.run")}<//>`} />`;
  const nav = html`<${SystemNav} current="doctor" owner=${true} />`;

  if (degraded) {
    return html`<div class="stack" data-testid="doctor.root">${header}${nav}<${LegacyDoctor} managers=${Array.isArray(bootstrap?.managers) ? bootstrap.managers : []} /></div>`;
  }
  if (query.data === undefined && query.status !== "error") {
    return html`<div class="stack" data-testid="doctor.root" aria-busy="true">${header}${nav}<${Skeleton} shape="table" rows=${6} /></div>`;
  }
  if (query.data === undefined) {
    return html`<div class="stack" data-testid="doctor.root">${header}${nav}
      <${EmptyState} icon="circle-x" level=${2} title=${t("platform.doctor.error.title")} body=${describeError(query.error, i18n)}
        action=${{ label: t("shell.conn.retry"), onClick: () => query.refetch() }} testid="doctor.error" />
    </div>`;
  }

  const report = normalizeReport(query.data, pick);
  const groups = groupChecks(report.checks);
  const statusLabel = (status) => (has(tk("platform.doctor.status.", status)) ? t(tk("platform.doctor.status.", status)) : status);
  const groupLabel = (id) => (has(tk("platform.doctor.group.", id)) ? t(tk("platform.doctor.group.", id)) : id);
  const asked = asking?.fix;

  return html`<div class="stack" data-testid="doctor.root">
    ${header}
    ${nav}
    <div class="row" role="group" aria-label=${t("platform.doctor.groupLabel")} data-testid="doctor.groups">
      ${[GROUP_ALL, ...DOCTOR_GROUPS].map((id) => html`<${Button} key=${id} size="sm" variant=${group === id ? "primary" : "default"} aria-pressed=${group === id ? "true" : "false"}
        onClick=${() => chooseGroup(id)} testid=${`doctor.group.${id}`}>${groupLabel(id)}<//>`)}
    </div>
    <div class="row" data-testid="doctor.summary">
      ${STATUSES.filter((status) => report.summary[status] > 0).map((status) => html`<${StatusBadge} key=${status} status=${statusTone(status)}
        label=${t("platform.doctor.count", { count: report.summary[status], status: statusLabel(status) })} testid=${`doctor.count.${status}`} />`)}
      <span class="small muted" data-testid="doctor.checked">${report.at
        ? t("platform.doctor.checkedAt", { time: fmt.dateTime(report.at), duration: report.durationMs === null ? "—" : fmt.duration(report.durationMs) })
        : ""}</span>
    </div>
    ${groups.length
      ? groups.map((entry) => html`<${Card} key=${entry.id} title=${groupLabel(entry.id)} level=${2} testid=${`doctor.card.${entry.id}`}>
        <ul class="checks" aria-label=${groupLabel(entry.id)}>
          ${entry.checks.map((check) => html`<${CheckRow} key=${check.id} check=${check} running=${runs[check.id] || null} busy=${busyCheck === check.id}
            onFix=${onFix} onDismiss=${dismiss} onDone=${onDone} />`)}
        </ul>
      <//>`)
      : html`<${EmptyState} icon="circle-check" level=${2} title=${t("platform.doctor.empty.title")} body=${t("platform.doctor.empty.body")}
        action=${{ label: t("platform.doctor.run"), onClick: runAgain }} testid="doctor.empty" />`}
    <${ConfirmDialog} open=${Boolean(asking)} title=${asked ? t("platform.doctor.confirm.title", { fix: asked.label || asking.title }) : ""}
      body=${asked ? t("platform.doctor.confirm.body", { check: asking.title }) : ""}
      details=${asked ? [
        ...(asked.command ? [t("platform.doctor.confirm.command", { command: asked.command })] : []),
        ...(String(asked.id).startsWith("pull-image") ? [t("platform.doctor.confirm.pull")] : []),
      ] : []}
      confirmLabel=${t("platform.doctor.confirm.run")} onConfirm=${() => startFix(asking, true)} onClose=${() => setAsking(null)} testid="doctor.confirm" />
  </div>`;
}
