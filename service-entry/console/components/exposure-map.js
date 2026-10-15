// ExposureMap (07 §4.4, 05 §13.5 step 6): the SVG diagram of `report.map`.
// Nodes are boxes, edges are arrows whose line style and mid-point glyph carry
// the state (colour is never the only cue), and the evidence of each edge is a
// tooltip on the arrow and, for keyboard and screen-reader users, a table below
// the diagram. The geometry is lib/exposure-model.js mapLayout(); this
// component only draws it.

import { badgeFor, mapLayout } from "../lib/exposure-model.js";
import { tk } from "../lib/i18n.js";
import { useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useMemo } from "../ui/vendor.js";
import { StatusBadge } from "./status-badge.js";

const GLYPH = Object.freeze({ ok: "OK", warn: "!", fail: "X", unknown: "?", manual: "?" });
const HEAD = 9;

/** The three points of the arrow head at (x2, y2) for a line that starts at (x1, y1). */
export function arrowHead(edge) {
  const angle = Math.atan2(edge.y2 - edge.y1, edge.x2 - edge.x1);
  const point = (turn) => `${Math.round(edge.x2 - HEAD * Math.cos(angle + turn))},${Math.round(edge.y2 - HEAD * Math.sin(angle + turn))}`;
  return `${edge.x2},${edge.y2} ${point(0.45)} ${point(-0.45)}`;
}

/** @param map `report.map` = { nodes: [{ id, label, kind }], edges: [{ from, to, state, evidence }] } */
export function ExposureMap({ map, testid }) {
  const { t, has } = useT();
  const layout = useMemo(() => mapLayout(map), [map]);
  const nameOf = (node) => (has(tk("public.map.node.", node.id)) ? t(tk("public.map.node.", node.id)) : node.label);
  const names = new Map(layout.nodes.map((node) => [node.id, nameOf(node)]));
  const stateText = (state) => t(tk("public.state.", state));

  if (!layout.nodes.length) return html`<p class="muted" data-testid="exposure-map.empty">${t("public.map.empty")}</p>`;
  return html`<figure class="xmap" data-testid=${testid || "exposure-map.root"}>
    <div class="xmap-scroll" tabindex="0" role="region" aria-label=${t("public.map.scroll")}>
      <svg class="xmap-svg" viewBox=${`0 0 ${layout.width} ${layout.height}`} role="img"
        aria-label=${t("public.map.label", { nodes: layout.nodes.length, edges: layout.edges.length })} data-testid="exposure-map.svg">
        ${layout.edges.map((edge) => html`<g key=${edge.id} class=${`xmap-edge xmap-edge-${edge.state}`} data-state=${edge.state} data-testid="exposure-map.edge">
          <title>${`${names.get(edge.from)} > ${names.get(edge.to)}: ${stateText(edge.state)}${edge.evidence ? `. ${edge.evidence}` : ""}`}</title>
          <line x1=${edge.x1} y1=${edge.y1} x2=${edge.x2} y2=${edge.y2} />
          <polygon points=${arrowHead(edge)} />
          <rect class="xmap-chip" x=${edge.mx - 15} y=${edge.my - 10} width="30" height="20" rx="10" />
          <text class="xmap-glyph" x=${edge.mx} y=${edge.my + 4} text-anchor="middle">${GLYPH[edge.state] || "?"}</text>
        </g>`)}
        ${layout.nodes.map((node) => html`<g key=${node.id} class="xmap-node" data-state=${node.state} data-kind=${node.kind} data-testid="exposure-map.node">
          <rect x=${node.x - node.w / 2} y=${node.y - node.h / 2} width=${node.w} height=${node.h} rx="8" />
          <text x=${node.x} y=${node.y + 4} text-anchor="middle">${names.get(node.id)}</text>
        </g>`)}
      </svg>
    </div>
    <figcaption class="xsmall muted">${t("public.map.legend")}</figcaption>
    <div class="table-wrap" tabindex="0" role="region" aria-label=${t("public.map.caption")}><table class="table xmap-table" data-testid="exposure-map.table">
      <caption class="sr-only">${t("public.map.caption")}</caption>
      <thead><tr><th scope="col">${t("public.map.col.edge")}</th><th scope="col">${t("public.map.col.state")}</th><th scope="col">${t("public.map.col.evidence")}</th></tr></thead>
      <tbody>${layout.edges.map((edge) => html`<tr key=${edge.id} data-state=${edge.state} data-testid="exposure-map.row">
        <td>${names.get(edge.from)} > ${names.get(edge.to)}</td>
        <td><${StatusBadge} status=${badgeFor(edge.state)} label=${stateText(edge.state)} /></td>
        <td class="small" data-user-content data-testid="exposure-map.evidence">${edge.evidence || "-"}</td>
      </tr>`)}</tbody>
    </table></div>
  </figure>`;
}
