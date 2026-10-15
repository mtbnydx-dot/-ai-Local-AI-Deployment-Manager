// GpuMemoryBar (07 §4.1 memory segments, §4.4): one stacked bar per GPU. The
// segments are this deployment's memory (weights, KV, activations, draft,
// projector, overhead), then other tenants' memory (striped), then the free
// part. A solid marker shows the budget and a dashed one the admission
// estimate; the part of the bar beyond the budget is hatched in the danger
// color. Color never carries the meaning alone: every kind has its own fill
// pattern, shared with the legend, and the bar is `role=img` with a summary
// next to a screen-reader table whose total row is the sum of the segment
// rows above it.

import { tk } from "../lib/i18n.js";
import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";

export const SEGMENT_KINDS = Object.freeze(["weights", "kv", "activations", "draft", "mmproj", "overhead"]);

function mbOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The numbers behind the bar, in MiB.
 * @returns {{ totalMb, segmentsMb, otherMb, usedMb, freeMb, budgetMb, admissionMb, overBudgetMb, overTotalMb, scaleMb, parts }}
 *   segmentsMb: sum of the deployment's segments; usedMb = segmentsMb + otherMb
 *   (the table's total row); overBudgetMb: used beyond the budget (0 without
 *   a budget); overTotalMb: used beyond the GPU's memory; scaleMb: the bar's
 *   full width (the GPU, or the use when that is larger); parts: segments and
 *   other tenants in bar order.
 */
export function gpuMemoryModel({ gpu, segments = [], budgetMb, admissionMb, otherTenantsMb } = {}) {
  const totalMb = mbOf(gpu?.totalMb);
  const parts = (Array.isArray(segments) ? segments : []).map((segment, index) => ({
    id: `${segment?.kind ?? "segment"}:${index}`,
    kind: String(segment?.kind ?? "other-kind"),
    mb: mbOf(segment?.mb),
    label: segment?.label,
  }));
  const segmentsMb = parts.reduce((sum, part) => sum + part.mb, 0);
  const otherMb = mbOf(otherTenantsMb);
  if (otherMb > 0) parts.push({ id: "tenants", kind: "tenants", mb: otherMb, label: undefined });
  const usedMb = segmentsMb + otherMb;
  const budget = mbOf(budgetMb);
  return {
    totalMb,
    segmentsMb,
    otherMb,
    usedMb,
    freeMb: Math.max(0, totalMb - usedMb),
    budgetMb: budget,
    admissionMb: mbOf(admissionMb),
    overBudgetMb: budget > 0 ? Math.max(0, usedMb - budget) : 0,
    overTotalMb: Math.max(0, usedMb - totalMb),
    scaleMb: Math.max(totalMb, usedMb, 1),
    parts,
  };
}

const KNOWN = new Set(SEGMENT_KINDS);

/** The CSS class of a segment kind (charts.css defines the fill and pattern of each). */
export function segmentClass(kind) {
  if (kind === "tenants") return "gpu-seg-tenants";
  return KNOWN.has(kind) ? `gpu-seg-${kind}` : "gpu-seg-unknown";
}

// gpu { id, name, totalMb }; segments [{ kind, mb, label }]; budget, admission and other tenants in MiB.
export function GpuMemoryBar({ gpu = {}, segments = [], budgetMb, admissionMb, otherTenantsMb, testid }) {
  const { t, has } = useT();
  const fmt = useFormat();
  const model = gpuMemoryModel({ gpu, segments, budgetMb, admissionMb, otherTenantsMb });
  const pct = (mb) => `${Math.min(100, (mb / model.scaleMb) * 100)}%`;
  const label = (part) => {
    if (part.label) return part.label;
    if (part.kind === "tenants") return t("common.gpu.tenants");
    const key = tk("common.gpu.kind.", part.kind);
    return has(key) ? t(key) : part.kind;
  };
  const name = gpu.name || gpu.id || t("common.gpu.unknown");
  const summary = [
    t("common.gpu.summary", { name, used: fmt.mib(model.usedMb), total: fmt.mib(model.totalMb), free: fmt.mib(model.freeMb) }),
    model.budgetMb ? t("common.gpu.budget", { value: fmt.mib(model.budgetMb) }) : "",
    model.admissionMb ? t("common.gpu.admission", { value: fmt.mib(model.admissionMb) }) : "",
    model.overBudgetMb ? t("common.gpu.over", { value: fmt.mib(model.overBudgetMb) }) : "",
  ].filter(Boolean).join(". ");
  const share = (mb) => fmt.percent(mb / model.scaleMb, 1);
  const overStart = model.overBudgetMb ? Math.max(0, model.budgetMb) : null;
  const rows = model.parts.map((part) => ({ ...part, text: label(part) }));

  return html`<div class="gpu-bar" data-testid=${testid || "gpu-memory-bar.root"} data-gpu=${gpu.id} data-over=${model.overBudgetMb || model.overTotalMb ? "true" : "false"}>
    <div class="row-nowrap gpu-bar-head">
      <strong class="grow">${name}</strong>
      <span class="small num muted" data-testid="gpu-memory-bar.usage">${fmt.mib(model.usedMb)} / ${fmt.mib(model.totalMb)}</span>
    </div>
    <div class="gpu-bar-track" role="img" aria-label=${summary} data-testid="gpu-memory-bar.bar">
      ${rows.map((part) => html`<span key=${part.id} class=${`gpu-bar-seg ${segmentClass(part.kind)}`} data-kind=${part.kind} data-mb=${part.mb} style=${{ width: pct(part.mb) }}></span>`)}
      ${overStart !== null ? html`<span class="gpu-bar-over" data-testid="gpu-memory-bar.over" style=${{ left: pct(overStart), width: pct(Math.min(model.overBudgetMb, model.scaleMb - overStart)) }}></span>` : null}
      ${model.budgetMb ? html`<span class="gpu-bar-marker gpu-bar-budget" data-testid="gpu-memory-bar.budget" style=${{ left: pct(model.budgetMb) }}></span>` : null}
      ${model.admissionMb ? html`<span class="gpu-bar-marker gpu-bar-admission" data-testid="gpu-memory-bar.admission" style=${{ left: pct(model.admissionMb) }}></span>` : null}
    </div>
    <ul class="gpu-bar-legend small" aria-hidden="true">
      ${rows.map((part) => html`<li key=${part.id} data-testid="gpu-memory-bar.legend-item"><span class=${`gpu-bar-swatch ${segmentClass(part.kind)}`}></span>${part.text} <span class="num muted">${fmt.mib(part.mb)} (${share(part.mb)})</span></li>`)}
      <li><span class="gpu-bar-swatch gpu-seg-free"></span>${t("common.gpu.free")} <span class="num muted">${fmt.mib(model.freeMb)} (${share(model.freeMb)})</span></li>
      ${model.budgetMb ? html`<li><span class="gpu-bar-swatch gpu-bar-swatch-budget"></span>${t("common.gpu.budget", { value: fmt.mib(model.budgetMb) })}</li>` : null}
      ${model.admissionMb ? html`<li><span class="gpu-bar-swatch gpu-bar-swatch-admission"></span>${t("common.gpu.admission", { value: fmt.mib(model.admissionMb) })}</li>` : null}
    </ul>
    ${model.overBudgetMb ? html`<p class="small text-danger" role="status" data-testid="gpu-memory-bar.over-text">${t("common.gpu.over", { value: fmt.mib(model.overBudgetMb) })}</p>` : null}
    ${model.overTotalMb ? html`<p class="small text-danger" role="status">${t("common.gpu.overTotal", { value: fmt.mib(model.overTotalMb) })}</p>` : null}
    <table class="sr-only" data-testid="gpu-memory-bar.table">
      <caption>${t("common.gpu.table", { name })}</caption>
      <thead><tr><th scope="col">${t("common.gpu.col.part")}</th><th scope="col">${t("common.gpu.col.size")}</th></tr></thead>
      <tbody>
        ${rows.map((part) => html`<tr key=${part.id} data-testid="gpu-memory-bar.row" data-mb=${part.mb}><th scope="row">${part.text}</th><td>${fmt.mib(part.mb)}</td></tr>`)}
      </tbody>
      <tfoot>
        <tr data-testid="gpu-memory-bar.total" data-mb=${model.usedMb}><th scope="row">${t("common.gpu.total")}</th><td>${fmt.mib(model.usedMb)}</td></tr>
        <tr><th scope="row">${t("common.gpu.free")}</th><td>${fmt.mib(model.freeMb)}</td></tr>
        <tr><th scope="row">${t("common.gpu.memory")}</th><td>${fmt.mib(model.totalMb)}</td></tr>
        ${model.budgetMb ? html`<tr><th scope="row">${t("common.gpu.budgetLabel")}</th><td>${fmt.mib(model.budgetMb)}</td></tr>` : null}
        ${model.admissionMb ? html`<tr><th scope="row">${t("common.gpu.admissionLabel")}</th><td>${fmt.mib(model.admissionMb)}</td></tr>` : null}
      </tfoot>
    </table>
  </div>`;
}
