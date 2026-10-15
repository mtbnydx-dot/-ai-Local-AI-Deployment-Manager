// CompatMatrix (07 §6.3 step 2, 02 §9 and §18, R-UI-2): one row per engine
// runtime for the chosen model. A row is green only with evidence: `ok` is
// shown only when the row has `supportEvidence`, otherwise it reads
// "Unknown (unverified)" in grey with the dry-probe and override actions. A
// blocked row is disabled and says why. Raw runtime ids are secondary mono
// text; the engine's label is the title.
//
// The rules (displayVerdict, viewRows, recommendedKey, whyReasons, fitBadgeFor)
// are pure and live in lib/compat-model.js; they are re-exported here.

import { VERDICT_STATUS, viewRows, recommendedKey } from "../lib/compat-model.js";
import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { Button } from "./button.js";
import { EvidenceChip } from "./evidence-chip.js";
import { Icon } from "./icon.js";
import { StatusBadge } from "./status-badge.js";

export {
  VERDICTS, displayVerdict, engineIndex, fitBadgeFor, isExperimental, recommendedKey, rowKey, viewRows, whyReasons,
} from "../lib/compat-model.js";

function ReasonList({ reasons }) {
  const { pick } = useT();
  if (!reasons.length) return null;
  return html`<ul class="compat-reasons small" data-testid="compat.reasons">
    ${reasons.map((reason, index) => html`<li key=${index} data-code=${reason.code} data-level=${reason.level || "info"}>
      <${Icon} name=${reason.level === "block" || reason.level === "warn" ? "triangle-alert" : reason.level === "unknown" ? "circle-help" : "info"} />
      <span data-user-content="">${pick(reason.message) || reason.code}</span>
    </li>`)}
  </ul>`;
}

function EvidenceList({ evidence }) {
  const { t } = useT();
  if (!evidence.length) return null;
  return html`<ul class="compat-evidence small" data-testid="compat.evidence">
    ${evidence.map((item, index) => html`<li key=${index} data-kind=${item.kind}>
      <span>${t(tk("models.compat.evidence.", item.kind))}</span> <${EvidenceChip} confidence=${item.confidence} />
    </li>`)}
  </ul>`;
}

function Row({ view, selected, recommended, busy, onSelect, onProbe, onOverride }) {
  const { t, pick } = useT();
  const label = pick(view.label) || view.engineId;
  const unknown = view.verdict === "unknown";
  const version = view.runtime?.version || view.runtime?.label || "";
  return html`<li class=${`compat-row compat-row-${view.verdict}`} data-testid="compat.row" data-engine=${view.engineId} data-runtime=${view.runtimeId}
    data-verdict=${view.verdict} data-selected=${selected ? "true" : "false"} data-recommended=${recommended ? "true" : "false"}>
    <div class="compat-head row">
      <strong data-testid="compat.engine">${label}</strong>
      ${version ? html`<span class="badge badge-neutral" data-testid="compat.version">${version}</span>` : null}
      ${view.runtimeId ? html`<span class="mono xsmall muted" data-testid="compat.runtime">${view.runtimeId}</span>` : null}
      ${view.runtime && view.runtime.present === false ? html`<span class="badge badge-warn" data-testid="compat.notPulled">${t("models.compat.notPulled")}</span>` : null}
      ${view.experimental ? html`<span class="badge badge-warn" data-testid="compat.experimental">${t("models.compat.experimental")}</span>` : null}
      ${recommended ? html`<span class="badge badge-info" data-testid="compat.recommended">${t("models.compat.recommended")}</span>` : null}
      <span class="grow"></span>
      <${StatusBadge} status=${VERDICT_STATUS[view.verdict]} label=${unknown ? t("models.compat.unknownArch") : t(tk("models.verdict.", view.verdict))} testid="compat.verdict" />
    </div>
    ${unknown ? html`<p class="small muted" data-testid="compat.unknownHint">${t("models.verdict.unknownHint")}</p>` : null}
    <${ReasonList} reasons=${view.reasons} />
    <${EvidenceList} evidence=${view.evidence} />
    <div class="compat-actions row">
      ${view.verdict === "ok" || view.verdict === "warn" || view.verdict === "block" ? html`
        <${Button} size="sm" variant=${selected ? "primary" : "default"} disabled=${!view.selectable} aria-pressed=${selected ? "true" : "false"}
          onClick=${() => onSelect?.(view)} testid="compat.select">${selected ? t("models.wizard.engine.selected") : t("models.wizard.engine.select")}<//>` : null}
      ${unknown ? html`
        <${Button} size="sm" busy=${busy} onClick=${() => onProbe?.(view)} testid="compat.probe">${t("models.wizard.engine.probe")}<//>
        <${Button} size="sm" variant="ghost" disabled=${!view.canOverride} onClick=${() => onOverride?.(view)} testid="compat.override">${t("models.wizard.engine.override")}<//>` : null}
    </div>
  </li>`;
}

/**
 * @param rows the compatibility rows (02 §9)
 * @param engines the GET /api/engines body, or an engineIndex map
 * @param selected { engineId, runtimeId } or null
 * @param probing { [rowKey]: true } rows whose probe is running
 */
export function CompatMatrix({ rows, engines, selected, probing = {}, onSelect, onProbe, onOverride, testid }) {
  const views = viewRows(rows, engines);
  const recommended = recommendedKey(views);
  return html`<ul class="compat-list" data-testid=${testid || "compat-matrix.root"}>
    ${views.map((view) => html`<${Row} key=${view.key} view=${view} recommended=${view.key === recommended}
      selected=${Boolean(selected) && selected.engineId === view.engineId && (selected.runtimeId || "") === view.runtimeId}
      busy=${Boolean(probing[view.key])} onSelect=${onSelect} onProbe=${onProbe} onOverride=${onOverride} />`)}
  </ul>`;
}
