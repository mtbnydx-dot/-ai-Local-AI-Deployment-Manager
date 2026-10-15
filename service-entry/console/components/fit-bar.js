// FitBar (07 §4.4, 02 §18 R-UI-3): 02's stacked fit bar. It stacks weights, KV
// cache, activations, draft model, vision projector and headroom from a
// FitResult / LaunchPlan.memory `breakdown`, and adds a system-RAM bar when
// weights, experts or KV sit in host RAM (`spill`). The segments share their
// fill patterns with the GpuMemoryBar (charts.css), so color never carries the
// meaning alone: every segment has a pattern, a legend line with its size and a
// place in the `role=img` summary.
//
// <FitBar fit ram ramOnly />  fit: { breakdown, headroomMb?, budgetMb?, perGpuMb?, spill?, ram?, status? }
//   ram: optional { weights, experts, kv } in MiB (default fit.ram), ramFreeMb
//   optional on `fit` for the RAM bar's scale. `breakdown.overhead` (runtime
//   overhead, graphs) is drawn with the activations segment: 02 names six
//   segments and activations & graphs is where the engines put it.
//
// fitModel() is the pure half: the numbers behind the bar, tested in Node.

import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";

export const FIT_SEGMENTS = Object.freeze(["weights", "kv", "activations", "draft", "mmproj", "headroom"]);
export const RAM_PARTS = Object.freeze(["weights", "experts", "kv"]);

// Every LaunchPlan.memory.policy value (00 §4.3 as amended by §9.1) has a label; literal keys, so the key checker sees each one used.
const POLICY_KEYS = Object.freeze({
  "device-fraction": "models.fit.policy.device-fraction",
  "static-fraction-of-free": "models.fit.policy.static-fraction-of-free",
  "free-fraction-after-weights": "models.fit.policy.free-fraction-after-weights",
  "weights-plus-kv": "models.fit.policy.weights-plus-kv",
  "gguf-estimate": "models.fit.policy.gguf-estimate",
  measured: "models.fit.policy.measured",
  "server-reported": "models.fit.policy.server-reported",
});
export const MEMORY_POLICIES = Object.freeze(Object.keys(POLICY_KEYS));

/** The catalog key that labels a memory policy, or null for a policy this console does not know (the page then shows the raw name in mono). */
export function policyKey(policy) {
  return typeof policy === "string" && Object.hasOwn(POLICY_KEYS, policy) ? POLICY_KEYS[policy] : null;
}

// Literal keys, so the key checker sees each one used.
const SEGMENT_KEYS = Object.freeze({
  weights: "models.fit.weights",
  kv: "models.fit.kv",
  activations: "models.fit.activations",
  draft: "models.fit.draft",
  mmproj: "models.fit.mmproj",
  headroom: "models.fit.headroom",
});
const RAM_KEYS = Object.freeze({
  weights: "models.fit.ramWeights",
  experts: "models.fit.ramExperts",
  kv: "models.fit.ramKv",
});
const SEGMENT_CLASS = Object.freeze({
  weights: "gpu-seg-weights",
  kv: "gpu-seg-kv",
  activations: "gpu-seg-activations",
  draft: "gpu-seg-draft",
  mmproj: "gpu-seg-mmproj",
  headroom: "gpu-seg-free",
});
const RAM_CLASS = Object.freeze({ weights: "gpu-seg-weights", experts: "gpu-seg-activations", kv: "gpu-seg-kv" });
const MIB = 1048576;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mbOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sumOf(value) {
  if (typeof value === "number") return mbOf(value);
  return isObject(value) ? Object.values(value).reduce((sum, item) => sum + mbOf(item), 0) : 0;
}

/**
 * The numbers behind the bar, in MiB, or null when the estimate has no breakdown.
 * @returns {{ segments: {kind, mb}[], usedMb, headroomMb, headroomKnown, totalMb, budgetMb, overMb, spill, ram: {parts: {kind, mb}[], totalMb, freeMb}, status }}
 *   segments always holds the six kinds in order (a missing one is 0);
 *   totalMb is the bar's full width (use plus headroom); overMb is use beyond
 *   the budget; ram.parts always holds weights, experts, kv.
 */
export function fitModel(fit, ramOverride) {
  if (!isObject(fit) || !isObject(fit.breakdown)) return null;
  const b = fit.breakdown;
  const used = {
    weights: mbOf(b.weights),
    kv: mbOf(b.kv),
    activations: mbOf(b.activations) + mbOf(b.overhead),
    draft: mbOf(b.draft),
    mmproj: mbOf(b.mmproj),
  };
  const usedMb = Object.values(used).reduce((sum, mb) => sum + mb, 0);
  const budgetMb = sumOf(fit.budgetMb);
  const perGpuMb = sumOf(fit.perGpuMb);
  const reported = Number(fit.headroomMb);
  const headroomKnown = Number.isFinite(reported) || (budgetMb > 0 && (perGpuMb > 0 || usedMb > 0));
  const headroomMb = Number.isFinite(reported) ? Math.max(0, reported) : budgetMb > 0 ? Math.max(0, budgetMb - (perGpuMb || usedMb)) : 0;
  const ramRaw = isObject(ramOverride) ? ramOverride : isObject(fit.ram) ? fit.ram : {};
  const ramParts = RAM_PARTS.map((kind) => ({ kind, mb: mbOf(ramRaw[kind]) }));
  const ramMb = ramParts.reduce((sum, part) => sum + part.mb, 0);
  const over = Number(fit.overflowMb);
  return {
    segments: [...Object.entries(used).map(([kind, mb]) => ({ kind, mb })), { kind: "headroom", mb: headroomMb }],
    usedMb,
    headroomMb,
    headroomKnown,
    totalMb: usedMb + headroomMb,
    budgetMb,
    overMb: Number.isFinite(over) && over > 0 ? over : budgetMb > 0 ? Math.max(0, (perGpuMb || usedMb) - budgetMb) : 0,
    spill: fit.spill === true || ramMb > 0,
    ram: { parts: ramParts, totalMb: ramMb, freeMb: mbOf(fit.ramFreeMb) },
    status: typeof fit.status === "string" ? fit.status : "",
  };
}

/** "94.5 GiB" for a MiB quantity. */
function gib(fmt, mb) {
  return fmt.bytes(mb * MIB, { unit: "GiB" });
}

export function FitBar({ fit, ram, ramOnly = false, testid }) {
  const { t } = useT();
  const fmt = useFormat();
  const model = fitModel(fit, ram);
  if (!model) return html`<p class="small muted" data-testid=${testid || "fit-bar.root"} data-empty="true">${t("models.fit.none")}</p>`;
  const scale = Math.max(model.totalMb, 1);
  const width = (mb) => `${Math.min(100, (mb / scale) * 100)}%`;
  const share = (mb) => fmt.percent(mb / scale, 0);
  const summary = [
    t("models.fit.summary", { used: gib(fmt, model.usedMb), headroom: model.headroomKnown ? gib(fmt, model.headroomMb) : "—" }),
    ...model.segments.filter((segment) => segment.mb > 0).map((segment) => `${t(SEGMENT_KEYS[segment.kind])} ${gib(fmt, segment.mb)}`),
    model.spill ? t("models.fit.spill") : "",
  ].filter(Boolean).join(". ");
  const ramScale = Math.max(model.ram.totalMb, model.ram.freeMb, 1);
  const ramWidth = (mb) => `${Math.min(100, (mb / ramScale) * 100)}%`;
  return html`<div class="fit-bar" data-testid=${testid || "fit-bar.root"} data-status=${model.status || undefined} data-spill=${model.spill ? "true" : "false"}
    data-used=${model.usedMb} data-headroom=${model.headroomMb}>
    ${ramOnly ? null : html`<div class="gpu-bar-track" role="img" aria-label=${summary} data-testid="fit-bar.bar">
      ${model.segments.map((segment) => html`<span key=${segment.kind} class=${`gpu-bar-seg ${SEGMENT_CLASS[segment.kind]}`} data-testid="fit-bar.segment"
        data-kind=${segment.kind} data-mb=${segment.mb} style=${{ width: width(segment.mb) }}></span>`)}
    </div>`}
    ${ramOnly ? null : html`<ul class="gpu-bar-legend small" aria-hidden="true">
      ${model.segments.map((segment) => html`<li key=${segment.kind} data-testid="fit-bar.legend" data-kind=${segment.kind}>
        <span class=${`gpu-bar-swatch ${SEGMENT_CLASS[segment.kind]}`}></span>${t(SEGMENT_KEYS[segment.kind])}
        <span class="num muted">${segment.kind === "headroom" && !model.headroomKnown ? "—" : `${gib(fmt, segment.mb)} (${share(segment.mb)})`}</span></li>`)}
    </ul>`}
    ${model.overMb > 0 && !ramOnly ? html`<p class="small text-danger" role="status" data-testid="fit-bar.over">${t("models.fit.over", { value: gib(fmt, model.overMb) })}</p>` : null}
    ${model.spill ? html`<div class="fit-bar-ram stack-sm" data-testid="fit-bar.ram">
      <div class="gpu-bar-track" role="img" aria-label=${`${t("models.fit.ram")}: ${model.ram.parts.filter((part) => part.mb > 0).map((part) => `${t(RAM_KEYS[part.kind])} ${gib(fmt, part.mb)}`).join(", ") || "—"}`} data-testid="fit-bar.ram-bar">
        ${model.ram.parts.map((part) => html`<span key=${part.kind} class=${`gpu-bar-seg ${RAM_CLASS[part.kind]}`} data-testid="fit-bar.ram-segment" data-kind=${part.kind} data-mb=${part.mb}
          style=${{ width: ramWidth(part.mb) }}></span>`)}
      </div>
      <ul class="gpu-bar-legend small" aria-hidden="true">
        <li class="muted"><strong>${t("models.fit.ram")}</strong> <span class="num">${gib(fmt, model.ram.totalMb)}${model.ram.freeMb ? ` / ${gib(fmt, model.ram.freeMb)}` : ""}</span></li>
        ${model.ram.parts.map((part) => html`<li key=${part.kind} data-testid="fit-bar.ram-legend" data-kind=${part.kind}>
          <span class=${`gpu-bar-swatch ${RAM_CLASS[part.kind]}`}></span>${t(RAM_KEYS[part.kind])} <span class="num muted">${gib(fmt, part.mb)}</span></li>`)}
      </ul>
      <p class="small" data-testid="fit-bar.spill"><span class="chip chip-warn">${t("models.fit.spillBadge")}</span> ${t("models.fit.spill")}</p>
    </div>` : null}
  </div>`;
}
