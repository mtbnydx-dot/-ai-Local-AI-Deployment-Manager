// Observability › Settings: the history import (04 §11.7, §18). It always runs
// as a dry run first; the live run is only offered once a dry run of exactly
// the selected sources has finished. Its own module (loaded by settings.js)
// so the settings form keeps the 60 KB route budget.

import { describeError } from "../../lib/api.js";
import { tk } from "../../lib/i18n.js";
import { importAllowed, IMPORT_SOURCES, selectedSources } from "../../lib/observability-settings-model.js";
import { Button } from "../../components/button.js";
import { Card } from "../../components/card.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useEffect, useState } from "../../ui/vendor.js";

// Polls one import run every 2 s until it is no longer running (04 §11.7).
function useImportRun(run) {
  const { api } = useServices();
  const [stopped, setStopped] = useState(false);
  const id = run?.id || "";
  const query = useQuery(["telemetry", "import", id], () => api.get(`/api/telemetry/import/${encodeURIComponent(id)}`), {
    ttlMs: 1000, enabled: Boolean(id), refetchMs: stopped ? 0 : 2000, keepPrevious: false,
  });
  const finished = Boolean(query.data && query.data.state && query.data.state !== "running");
  useEffect(() => setStopped(finished), [id, finished]);
  return { query, data: query.data, finished };
}

function ImportReport({ data, dryRun }) {
  const { t } = useT();
  const fmt = useFormat();
  const report = data.report;
  if (data.state === "running") return html`<p class="muted" role="status" data-testid="obs.import.running" aria-busy="true">${t("obs.import.running")}${data.progress?.source ? ` · ${data.progress.source}` : ""}</p>`;
  if (data.state === "failed") return html`<p class="notice notice-danger" role="alert" data-testid="obs.import.failed">${t("obs.import.failed", { code: data.error?.code || "import_failed" })}</p>`;
  if (!report) return null;
  const skipped = Object.values(report.rowsSkipped || {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
  return html`<div class="stack-sm" data-testid="obs.import.report" data-dry-run=${dryRun ? "true" : "false"}>
    <p role="status" data-testid="obs.import.summary"><strong>${t(dryRun ? "obs.import.dryDone" : "obs.import.done")}</strong> ${t("obs.import.counts", { read: fmt.integer(report.rowsIn), written: fmt.integer(report.rowsWritten), skipped: fmt.integer(skipped) })}</p>
    ${Array.isArray(report.reports) && report.reports.length ? html`<div class="table-wrap" role="region" tabindex="0" aria-label=${t("obs.import.report")}>
      <table class="table"><caption class="sr-only">${t("obs.import.report")}</caption>
        <thead><tr><th scope="col">${t("obs.col.source")}</th><th scope="col" class="num">${t("obs.col.files")}</th><th scope="col" class="num">${t("obs.col.rowsRead")}</th><th scope="col" class="num">${t("obs.col.rowsWritten")}</th></tr></thead>
        <tbody>${report.reports.map((row) => html`<tr key=${row.source} data-testid="obs.import.source-row"><td>${t(tk("obs.import.source.", row.source))}</td><td class="num tabular">${fmt.integer(row.files)}</td>
          <td class="num tabular">${fmt.integer(row.rowsIn)}</td><td class="num tabular">${fmt.integer(row.rowsWritten)}</td></tr>`)}</tbody></table>
    </div>` : null}
    ${Array.isArray(report.warnings) && report.warnings.length ? html`<ul class="small obs-notes" data-testid="obs.import.warnings">${report.warnings.map((line, index) => html`<li key=${index}>${line}</li>`)}</ul>` : null}
  </div>`;
}

export function ImportCard() {
  const { api, cache } = useServices();
  const i18n = useT();
  const { t } = i18n;
  const [selection, setSelection] = useState(() => Object.fromEntries(IMPORT_SOURCES.map((id) => [id, true])));
  const [dry, setDry] = useState(null);
  const [live, setLive] = useState(null);
  const [problem, setProblem] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const sources = selectedSources(selection);
  const dryRun = useImportRun(dry);
  const liveRun = useImportRun(live);
  const running = (dry && !dryRun.finished) || (live && !liveRun.finished);
  const allowed = importAllowed(dry && dryRun.finished ? dryRun.data : null, sources);

  async function start(isDry) {
    setProblem(null);
    try {
      const answer = await api.post("/api/telemetry/import", { sources, dryRun: isDry });
      const run = { id: answer.runId, sources };
      if (isDry) {
        setDry(run);
        setLive(null);
      } else {
        setLive(run);
      }
      cache.invalidate(["telemetry", "import"]);
    } catch (error) {
      setProblem(describeError(error, i18n));
    }
  }

  const toggle = (id, on) => {
    setSelection((current) => ({ ...current, [id]: on }));
    setDry(null);
  };

  return html`<${Card} title=${t("obs.settings.import")} testid="obs.import">
    <p class="small muted">${t("obs.import.note")}</p>
    <fieldset class="obs-sources">
      <legend>${t("obs.import.sources")}</legend>
      ${IMPORT_SOURCES.map((id) => html`<label class="check" key=${id}><input type="checkbox" checked=${selection[id]} data-testid=${`obs.import.source.${id}`} onChange=${(event) => toggle(id, event.currentTarget.checked)} /> ${t(tk("obs.import.source.", id))}</label>`)}
    </fieldset>
    <div class="row">
      <${Button} onClick=${() => start(true)} disabled=${!sources.length || Boolean(running)} testid="obs.import.dry">${t("obs.import.dry")}<//>
      <${Button} variant="primary" onClick=${() => setConfirming(true)} disabled=${!allowed || Boolean(running)} testid="obs.import.run">${t("obs.import.run")}<//>
    </div>
    ${!allowed && !live ? html`<p class="small muted" data-testid="obs.import.dry-first">${t("obs.import.dryFirst")}</p>` : null}
    ${problem ? html`<p class="notice notice-danger" role="alert" data-testid="obs.import.problem">${problem}</p>` : null}
    ${dry && dryRun.data ? html`<${ImportReport} data=${dryRun.data} dryRun=${true} />` : null}
    ${live && liveRun.data ? html`<${ImportReport} data=${liveRun.data} dryRun=${false} />` : null}
    <${ConfirmDialog} open=${confirming} title=${t("obs.import.confirmTitle")} body=${t("obs.import.confirmBody")} confirmLabel=${t("obs.import.run")}
      onConfirm=${async () => { await start(false); }} onClose=${() => setConfirming(false)} testid="obs.import.confirm" />
  <//>`;
}

