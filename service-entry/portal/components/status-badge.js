// A state chip: a shape plus a word, never colour alone (05 §12.1).

import { html } from "../lib/html.js";

const TONES = {
  operational: "ok",
  ready: "ok",
  degraded: "warn",
  loading: "warn",
  starting: "warn",
  offline: "bad",
  incident: "bad",
  maintenance: "info",
  info: "info",
  sleeping: "idle",
  cold: "idle",
  unknown: "idle",
};

export function toneOf(kind) {
  return TONES[kind] || "idle";
}

// ok: disc, warn: diamond, bad: square, info and idle: ring. Decorative; the label says it all.
function Shape({ tone }) {
  if (tone === "ok") return html`<circle cx="6" cy="6" r="4.5" fill="currentColor" />`;
  if (tone === "warn") return html`<path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="currentColor" />`;
  if (tone === "bad") return html`<rect x="1.8" y="1.8" width="8.4" height="8.4" rx="1.2" fill="currentColor" />`;
  return html`<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="2" />`;
}

/** StatusBadge({ kind, label, large }) */
export function StatusBadge({ kind, label, large = false }) {
  const tone = toneOf(kind);
  return html`<span class=${`badge badge-${tone}${large ? " badge-large" : ""}`} data-kind=${kind}>
    <svg class="badge-shape" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><${Shape} tone=${tone} /></svg>
    <span>${label}</span>
  </span>`;
}
