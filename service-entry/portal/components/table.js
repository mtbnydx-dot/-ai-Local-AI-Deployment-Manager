// A data table that scrolls inside its own box on a narrow screen, so the page
// itself never overflows.

import { html } from "../lib/html.js";

/** DataTable({ caption, head: string[], rows: any[][] }) */
export function DataTable({ caption, head, rows }) {
  return html`<div class="table-scroll" role="region" aria-label=${caption} tabindex="0">
    <table class="table">
      <caption class="visually-hidden">${caption}</caption>
      <thead><tr>${head.map((cell) => html`<th scope="col">${cell}</th>`)}</tr></thead>
      <tbody>
        ${rows.map((row) => html`<tr>${row.map((cell, index) => (index === 0 ? html`<th scope="row">${cell}</th>` : html`<td>${cell}</td>`))}</tr>`)}
      </tbody>
    </table>
  </div>`;
}
