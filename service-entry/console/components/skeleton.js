// Skeleton (07 §4.4): a placeholder shape. It is aria-hidden; the parent
// region sets aria-busy while its data loads.

import { html } from "../ui/html.js";

/** @param shape "line" | "tile" | "table"  @param rows line or table-row count */
export function Skeleton({ shape = "line", rows = 3, testid }) {
  const count = shape === "tile" ? 1 : Math.max(1, Math.min(20, Number(rows) || 1));
  return html`<div class=${`skeleton-group skeleton-${shape}`} aria-hidden="true" data-testid=${testid || "skeleton.root"}>
    ${Array.from({ length: count }, (_, index) => html`<span key=${index} class="skeleton skeleton-item"></span>`)}
  </div>`;
}
