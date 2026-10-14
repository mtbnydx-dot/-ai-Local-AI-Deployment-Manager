// StackedBar (07 §4.4): storage and capacity as one bar. The bar is
// decorative; the legend below it lists every part with its value and share,
// so no information is carried by color alone. Parts that exceed `total` show
// an over-capacity line.

import { useFormat, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";

// parts [{ id?, label, value }] in unit bytes|MiB|text.
export function StackedBar({ total, parts = [], unit = "bytes", testid }) {
  const { t } = useT();
  const fmt = useFormat();
  const used = parts.reduce((sum, part) => sum + Math.max(0, Number(part.value) || 0), 0);
  const cap = Number(total) > 0 ? Number(total) : used;
  const scale = Math.max(cap, used) || 1;
  const show = (value) => (unit === "bytes" ? fmt.bytes(value) : unit === "MiB" ? fmt.mib(value) : `${fmt.number(value)} ${unit}`);
  const share = (value) => fmt.percent(value / scale, 0);
  return html`<div class="stacked-bar" data-testid=${testid || "stacked-bar.root"}>
    <div class="small num">${show(used)} / ${show(cap)}</div>
    <div class="stack-track" aria-hidden="true">
      ${parts.map((part, index) => html`<span key=${part.id ?? index} class=${`stack-seg stack-c${index % 8}`} style=${{ width: `${(Math.max(0, part.value) / scale) * 100}%` }}></span>`)}
    </div>
    <ul class="stack-legend small">
      ${parts.map((part, index) => html`<li key=${part.id ?? index} data-testid="stacked-bar.part"><span class=${`stack-swatch stack-c${index % 8}`} aria-hidden="true"></span>${part.label} <span class="num muted">${show(part.value)} (${share(part.value)})</span></li>`)}
      ${cap > used ? html`<li><span class="stack-swatch stack-free" aria-hidden="true"></span>${t("common.stack.free")} <span class="num muted">${show(cap - used)} (${share(cap - used)})</span></li>` : null}
    </ul>
    ${used > cap ? html`<p class="small text-danger" role="status">${t("common.stack.over", { amount: show(used - cap) })}</p>` : null}
  </div>`;
}
