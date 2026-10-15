// /system/ops (06 §6.5, §7.2, §10.2, §11; 07 §6.13, CON-24b): the platform's
// routine upkeep at a glance: the nightly check's last 30 runs, the newest
// backup, the scheduled tasks and the autostart status.
//
// Data: GET /api/platform/schedules and the doctor's `ops` group (GET
// /api/platform/doctor?group=ops). The page only reports. Nothing is
// registered from the console: for autostart it shows the command to run on
// this machine (platform.autostart.howto) with a Copy button.

import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { CodeBlock } from "../../components/code-block.js";
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
import { normalizeReport, statusTone } from "./doctor-model.js";
import { isUnavailable, P6Required, usePlatformOn } from "./gate.js";
import { SystemNav } from "./subnav.js";
import { barHeights, normalizeAutostart, normalizeSchedules, normalizeTask } from "./updates-model.js";

const DASH = "—";
const AUTOSTART_COMMAND = "platform autostart enable";
const FAILING_FROM = 2;
const DOCTOR_OPS_KEY = ["platform-doctor", "ops"];
const SCHEDULES_KEY = ["platform-schedules"];

function NightlyBars({ bars, schedule }) {
  const { t } = useT();
  const fmt = useFormat();
  const heights = barHeights(bars);
  const passed = bars.filter((bar) => bar.state === "pass").length;
  const failed = bars.filter((bar) => bar.state === "fail").length;
  const missing = bars.length - passed - failed;
  const summary = t("platform.nightly.trendSummary", { days: bars.length, passed, failed, missing });
  const describe = (bar) => (bar.state === "missing"
    ? t("platform.nightly.barMissing")
    : t("platform.nightly.bar", { date: bar.at ? fmt.dateTime(bar.at, { style: "short" }) : DASH, result: t(tk("platform.nightly.", bar.state)), passed: bar.passed, failed: bar.failed }));
  return html`<div class="stack-sm" data-testid="ops.trend" data-streak=${schedule.streak}>
    <div class="trend" role="img" aria-label=${summary} data-testid="ops.trend-bars">
      ${bars.map((bar, index) => html`<span key=${index} class="trend-bar" data-state=${bar.state} style=${{ height: `${heights[index]}%` }} title=${describe(bar)} data-testid="ops.bar"></span>`)}
    </div>
    <p class="small muted" data-testid="ops.trend-summary">${summary}</p>
    <ul class="trend-legend small" aria-hidden="true">
      ${["pass", "fail", "missing"].map((state) => html`<li key=${state}><span class="trend-swatch trend-bar" data-state=${state}></span>${t(tk("platform.nightly.", state))}</li>`)}
    </ul>
  </div>`;
}

export default function Ops() {
  const { api, cache } = useServices();
  const i18n = useT();
  const { t, pick, has } = i18n;
  const fmt = useFormat();
  const platformOn = usePlatformOn();
  const schedules = useQuery(SCHEDULES_KEY, () => api.get("/api/platform/schedules"), { ttlMs: 30000, enabled: platformOn });
  const doctor = useQuery(DOCTOR_OPS_KEY, () => api.get("/api/platform/doctor", { query: { group: "ops" }, timeoutMs: 60000 }), { ttlMs: 30000, enabled: platformOn });

  function refresh() {
    cache.invalidate(SCHEDULES_KEY);
    cache.invalidate(DOCTOR_OPS_KEY);
  }

  const header = html`<${PageHeader} title=${t("platform.ops.title")} subtitle=${t("platform.ops.subtitle")}
    actions=${html`<${Button} icon="refresh-cw" onClick=${refresh} testid="ops.refresh">${t("platform.ops.refresh")}<//>`} />`;
  const nav = html`<${SystemNav} current="ops" owner=${true} />`;

  if (!platformOn || (isUnavailable(schedules.error) && schedules.data === undefined)) return html`<${P6Required} current="ops" titleKey="platform.ops.title" />`;
  if (schedules.data === undefined && schedules.status !== "error") {
    return html`<div class="stack" data-testid="ops.root" aria-busy="true">${header}${nav}<${Skeleton} shape="table" rows=${5} /></div>`;
  }
  if (schedules.data === undefined) {
    return html`<div class="stack" data-testid="ops.root">${header}${nav}
      <${EmptyState} icon="circle-x" level=${2} title=${t("platform.ops.error.title")} body=${describeError(schedules.error, i18n)}
        action=${{ label: t("shell.conn.retry"), onClick: () => schedules.refetch() }} testid="ops.error" />
    </div>`;
  }

  const plan = normalizeSchedules(schedules.data);
  const checks = doctor.data ? normalizeReport(doctor.data, pick).checks : [];
  const byId = new Map(checks.map((check) => [check.id, check]));
  const autostartCheck = byId.get("ops.autostart") || null;
  const autostart = normalizeAutostart(autostartCheck && autostartCheck.status !== "skip" ? autostartCheck.data : plan.tasks.autostart);
  const autostartCommand = autostartCheck?.fix?.command || AUTOSTART_COMMAND;
  const nightly = plan.nightly;
  const backup = plan.backup;

  const when = (iso) => (iso ? fmt.dateTime(iso) : DASH);
  const result = (code) => (code === null ? DASH : code === 0 ? t("platform.ops.task.resultOk") : t("platform.ops.task.resultCode", { code: String(code) }));
  const taskRows = [
    { id: "autostart", state: autostart.registered ? t(tk("platform.autostart.method.", autostart.method || "task")) : t("platform.ops.task.missing"), last: null, result: null, next: null },
    ...["nightly", "backup"].map((id) => {
      const task = normalizeTask(plan.tasks[id]);
      return task
        ? { id, state: task.state || DASH, last: task.lastRunTime, result: task.lastResult, next: task.nextRunTime }
        : { id, state: t("platform.ops.task.missing"), last: null, result: null, next: null };
    }),
  ];
  const taskColumns = [
    { id: "task", header: t("platform.ops.col.task"), sort: (row) => row.id, cell: (row) => html`<strong>${t(tk("platform.ops.task.", row.id))}</strong>` },
    { id: "state", header: t("platform.ops.col.state"), sort: (row) => row.state, cell: (row) => row.state },
    { id: "last", header: t("platform.ops.col.lastRun"), hideable: true, sort: (row) => row.last || "", cell: (row) => when(row.last) },
    { id: "result", header: t("platform.ops.col.result"), hideable: true, sort: (row) => row.result ?? -1, cell: (row) => result(row.result) },
    { id: "next", header: t("platform.ops.col.nextRun"), hideable: true, sort: (row) => row.next || "", cell: (row) => when(row.next) },
  ];
  const opsChecks = checks.filter((check) => check.id.startsWith("ops."));

  return html`<div class="stack" data-testid="ops.root">
    ${header}
    ${nav}
    <${Card} title=${t("platform.nightly.title")} level=${2} testid="ops.nightly">
      <div class="stack">
        ${nightly.streak >= FAILING_FROM
          ? html`<div class="notice notice-warn" role="status" data-testid="ops.nightly-failing">
            <span class="grow">${t("platform.nightly.failing", { n: nightly.streak, date: nightly.since || DASH })}</span>
          </div>`
          : null}
        ${nightly.latest
          ? html`<p data-testid="ops.nightly-latest"><${StatusBadge} status=${nightly.latest.ok ? "ok" : "error"} label=${t(tk("platform.nightly.", nightly.latest.ok ? "pass" : "fail"))} />
            ${" "}${t("platform.nightly.latest", { passed: nightly.latest.passed, failed: nightly.latest.failed, time: when(nightly.latest.at) })}</p>`
          : html`<p class="muted" data-testid="ops.nightly-none">${t("platform.nightly.none")}</p>`}
        <${NightlyBars} bars=${nightly.bars} schedule=${nightly} />
      </div>
    <//>
    <${Card} title=${t("platform.ops.backup.title")} level=${2} testid="ops.backup">
      ${backup.latest
        ? html`<div class="stack-sm">
          <p data-testid="ops.backup-age"><${StatusBadge} status=${backup.ageHours !== null && backup.ageHours > 36 ? "warn" : "ok"} label=${backup.ageHours === null ? DASH : t("platform.ops.backup.age", { hours: fmt.number(backup.ageHours) })} /></p>
          <dl class="deploy-facts">
            <div class="deploy-fact"><dt class="small muted">${t("platform.ops.backup.at")}</dt><dd data-testid="ops.backup-at">${when(backup.latest.at)}</dd></div>
            <div class="deploy-fact"><dt class="small muted">${t("platform.ops.backup.files")}</dt><dd class="tabular">${fmt.integer(backup.files)}</dd></div>
            <div class="deploy-fact"><dt class="small muted">${t("platform.ops.backup.format")}</dt><dd>${backup.latest.format || DASH}${backup.latest.formatOk ? "" : html` <${StatusBadge} status="warn" label=${t("platform.ops.backup.formatUnexpected")} />`}</dd></div>
            ${backup.latest.warnings ? html`<div class="deploy-fact"><dt class="small muted">${t("platform.ops.backup.warnings")}</dt><dd class="tabular">${fmt.integer(backup.latest.warnings)}</dd></div>` : null}
          </dl>
        </div>`
        : html`<p class="muted" data-testid="ops.backup-none">${t("platform.ops.backup.none")}</p>`}
    <//>
    <${Card} title=${t("platform.ops.tasks.title")} level=${2} testid="ops.tasks">
      <${DataTable} id="ops-tasks" caption=${t("platform.ops.tasks.caption")} columns=${taskColumns} rows=${taskRows} rowKey="id" responsive="cards" testid="ops.tasks-table" />
    <//>
    <${Card} title=${t("platform.autostart.title")} level=${2} testid="ops.autostart">
      <div class="stack">
        <p data-testid="ops.autostart-status" data-status=${autostart.status}><${StatusBadge} status=${autostart.status === "registered" ? "ok" : autostart.status === "stale" ? "warn" : "info"}
          label=${t(tk("platform.autostart.status.", autostart.status))} /></p>
        <p data-testid="ops.autostart-howto">${t("platform.autostart.howto")}</p>
        <${CodeBlock} code=${autostartCommand} testid="ops.autostart-command" />
        <p class="small muted">${t("platform.autostart.noRegister")}</p>
      </div>
    <//>
    ${opsChecks.length ? html`<${Card} title=${t("platform.ops.checks.title")} level=${2} testid="ops.checks">
      <ul class="checks">
        ${opsChecks.map((check) => html`<li key=${check.id} class="check-row stack-sm" data-check=${check.id} data-status=${check.status} data-testid="ops.check">
          <div class="row">
            <${StatusBadge} status=${statusTone(check.status)} label=${has(tk("platform.doctor.status.", check.status)) ? t(tk("platform.doctor.status.", check.status)) : check.status} />
            <strong class="grow">${check.title}</strong>
            <code class="code-inline small">${check.id}</code>
          </div>
          ${check.detail ? html`<p class="small muted check-evidence" data-user-content>${check.detail}</p>` : null}
        </li>`)}
      </ul>
      <p class="small"><a href="/system/doctor?group=ops">${t("platform.ops.checks.open")}</a></p>
    <//>` : null}
  </div>`;
}
