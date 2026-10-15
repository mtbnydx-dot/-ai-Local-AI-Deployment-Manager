// The Flag diff tab (07 §6.5): pick a runtime, pick what to compare it with
// (another runtime, or the parameter catalog) and read the added, removed and
// changed flags and choices from
// GET /api/m/:id/engines/:engineId/runtimes/:runtimeId/flags?against=<other>.
// A flag in the first runtime and not in the other is "added", the reverse is
// "removed"; renamed flags, changed choices and changed defaults are "changed".

import { flagDiffRows, flagsSnapshot } from "../../lib/engines-model.js";
import { FlagsResponseGuard } from "../../lib/schemas.js";
import { EmptyState } from "../../components/empty-state.js";
import { Skeleton } from "../../components/skeleton.js";
import { useServices } from "../../ui/context.js";
import { useFormat, useQuery, useT } from "../../ui/hooks.js";
import { html } from "../../ui/html.js";
import { useId, useState } from "../../ui/vendor.js";
import { TableWrap } from "./engine-parts.js";

const enc = encodeURIComponent;
const KIND_BADGE = Object.freeze({ added: "badge-success", removed: "badge-danger", changed: "badge-warn" });

function Details({ row }) {
  const { t } = useT();
  if (row.change === "renamed") {
    return html`<span>${t("engines.page.flags.renamedTo")} <code class="code-inline">${row.to}</code>${row.evidence ? html` <span class="muted" data-user-content="">(${row.evidence})</span>` : null}</span>`;
  }
  if (row.change === "choices") {
    return html`<span>
      ${row.addedChoices.length ? html`<span>${t("engines.page.flags.choicesAdded")} <code class="code-inline">${row.addedChoices.join(", ")}</code></span> ` : null}
      ${row.removedChoices.length ? html`<span>${t("engines.page.flags.choicesRemoved")} <code class="code-inline">${row.removedChoices.join(", ")}</code></span>` : null}
    </span>`;
  }
  if (row.change === "default") {
    const shown = (value) => (value === "" ? t("engines.page.flags.noDefault") : value);
    return html`<span>${t("engines.page.flags.defaultChanged")} <code class="code-inline">${shown(row.from)}</code> → <code class="code-inline">${shown(row.to)}</code></span>`;
  }
  return html`<span class="muted">—</span>`;
}

function Select({ id, label, value, onChange, children }) {
  return html`<div class="field"><label class="field-label" for=${id}>${label}</label>
    <select id=${id} class="select" value=${value} onChange=${(event) => onChange(event.currentTarget.value)} data-testid=${`flag-diff.${id.split("-").pop()}`}>${children}</select></div>`;
}

export function FlagDiffTab({ engine, onShowRuntimes }) {
  const { api } = useServices();
  const { t } = useT();
  const fmt = useFormat();
  const base = useId();
  const runtimes = Array.isArray(engine.runtimes) ? engine.runtimes : [];
  const firstIntrospected = runtimes.find((runtime) => runtime.introspected) || runtimes.find((runtime) => runtime.default) || runtimes[0];
  const [runtimeId, setRuntimeId] = useState(firstIntrospected?.runtimeId || "");
  const [against, setAgainst] = useState(() => runtimes.find((runtime) => runtime.runtimeId !== firstIntrospected?.runtimeId && runtime.introspected)?.runtimeId
    || runtimes.find((runtime) => runtime.runtimeId !== firstIntrospected?.runtimeId)?.runtimeId || "catalog");
  const same = against === runtimeId;
  const flags = useQuery(
    ["engines", "flags", engine.managerId, engine.engineId, runtimeId, "against", against],
    () => api.manager(engine.managerId).get(`/engines/${enc(engine.engineId)}/runtimes/${enc(runtimeId)}/flags`, { query: { against }, guard: FlagsResponseGuard }),
    { ttlMs: 30000, enabled: Boolean(runtimeId) && !same },
  );
  const report = flags.data?.diff ? flagDiffRows(flags.data.diff) : null;
  const snapshot = flagsSnapshot(flags.data);
  const notIntrospected = flags.error?.code === "runtime_not_introspected" || flags.error?.status === 404;

  let body;
  if (!runtimeId) body = html`<${EmptyState} title=${t("engines.page.flags.noRuntime")} action=${{ label: t("engines.page.flags.showRuntimes"), onClick: onShowRuntimes }} />`;
  else if (same) body = html`<p class="muted" data-testid="flag-diff.same">${t("engines.page.flags.same")}</p>`;
  else if (flags.status === "loading" || flags.status === "idle") body = html`<div aria-busy="true"><${Skeleton} shape="table" rows=${4} /></div>`;
  else if (notIntrospected) {
    body = html`<${EmptyState} testid="flag-diff.not-introspected" title=${t("engines.page.flags.notIntrospected")} body=${t("engines.page.flags.notIntrospectedBody")}
      action=${{ label: t("engines.page.flags.showRuntimes"), onClick: onShowRuntimes }} />`;
  } else if (flags.error) {
    body = html`<div class="notice notice-danger" role="alert" data-testid="flag-diff.error">${t("engines.page.flags.failed")}
      <button type="button" class="btn btn-sm" onClick=${() => flags.refetch()}>${t("engines.page.retry")}</button></div>`;
  } else if (!report) {
    body = html`<p class="muted">${t("engines.page.flags.noDiff")}</p>`;
  } else {
    const { rows, counts } = report;
    body = html`<div class="stack-sm">
      <p data-testid="flag-diff.summary" aria-live="polite">${t("engines.page.flags.summary", { added: counts.added, removed: counts.removed, changed: counts.changed })}
        ${snapshot?.capturedAt ? html` <span class="muted">${t("engines.page.runtime.capturedAt", { time: fmt.dateTime(snapshot.capturedAt) })}</span>` : null}</p>
      ${rows.length ? html`<${TableWrap} label=${t("engines.page.flags.caption")}><table class="table" data-testid="flag-diff.table">
        <caption class="sr-only">${t("engines.page.flags.caption")}</caption>
        <thead><tr><th scope="col">${t("engines.page.flags.change")}</th><th scope="col">${t("engines.page.flags.flag")}</th><th scope="col">${t("engines.page.flags.details")}</th></tr></thead>
        <tbody>${rows.map((row, index) => html`<tr key=${`${row.kind}-${row.change || ""}-${row.flag}-${index}`} data-testid="flag-diff.row" data-kind=${row.kind} data-change=${row.change || ""}>
          <td><span class=${`badge ${KIND_BADGE[row.kind]}`}>${t(row.kind === "added" ? "engines.page.flags.added" : row.kind === "removed" ? "engines.page.flags.removed" : "engines.page.flags.changed")}</span></td>
          <td><code class="code-inline">${row.flag}</code></td>
          <td><${Details} row=${row} /></td>
        </tr>`)}</tbody></table><//>` : html`<p class="muted" data-testid="flag-diff.identical">${t("engines.page.flags.identical")}</p>`}
      ${report.catalogMissing.length || report.catalogUnmapped.length ? html`<details data-testid="flag-diff.coverage">
        <summary>${t("engines.page.flags.coverage")}</summary>
        <div class="stack-sm">
          ${report.catalogMissing.length ? html`<div><strong>${t("engines.page.flags.catalogMissing", { count: report.catalogMissing.length })}</strong>
            <p class="small"><code class="code-inline">${report.catalogMissing.join(" ")}</code></p></div>` : null}
          ${report.catalogUnmapped.length ? html`<div><strong>${t("engines.page.flags.catalogUnmapped", { count: report.catalogUnmapped.length })}</strong>
            <p class="small"><code class="code-inline">${report.catalogUnmapped.join(" ")}</code></p></div>` : null}
        </div></details>` : null}
    </div>`;
  }

  return html`<div class="stack" data-testid="engine-flags">
    <div class="row">
      <${Select} id=${`${base}-runtime`} label=${t("engines.page.flags.runtime")} value=${runtimeId} onChange=${setRuntimeId}>
        ${runtimes.map((runtime) => html`<option key=${runtime.runtimeId} value=${runtime.runtimeId}>${runtime.runtimeId}</option>`)}
      <//>
      <${Select} id=${`${base}-against`} label=${t("engines.page.flags.against")} value=${against} onChange=${setAgainst}>
        ${runtimes.map((runtime) => html`<option key=${runtime.runtimeId} value=${runtime.runtimeId}>${runtime.runtimeId}</option>`)}
        <option value="catalog">${t("engines.page.flags.catalog")}</option>
      <//>
    </div>
    ${body}
  </div>`;
}
