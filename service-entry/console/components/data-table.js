// DataTable (07 §4.4): a semantic <table> with a hidden <caption>, sortable
// columns (aria-sort), a column chooser kept per table id in the
// `tableColumns` preference, client CSV export of the loaded rows, a
// "load more" control for cursor sources, windowing above 500 rows and a
// card layout below sm for tables that ask for it.
//
// rows are the rows loaded so far. A cursor source adds `source: { cursor,
// loadMore(cursor, limit), loading }`: while `cursor` is set a "load more"
// button calls `loadMore`, and the caller appends the new rows to `rows`.
// `exportHref` is a server-side export link and is offered next to the CSV
// button. Column fields: id, header, cell(row), sort (true, or a function
// returning the sort value), align, width, hideable, defaultHidden and csv
// (a function returning the CSV value, or false to leave the column out).

import { toCsv } from "../lib/csv.js";
import { safeUrl } from "../lib/url.js";
import { useMediaQuery, usePref, useT } from "../ui/hooks.js";
import { html } from "../ui/html.js";
import { useEffect, useMemo, useRef, useState } from "../ui/vendor.js";
import { Button } from "./button.js";
import { Skeleton } from "./skeleton.js";

export const WINDOW_THRESHOLD = 500;
export const WINDOW_MAX_ROWS = 120;
const OVERSCAN = 20;
const DEFAULT_ROW_HEIGHT = 40;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The value a column sorts and exports by: its `sort` getter, else `row[column.id]`. */
export function sortValue(column, row) {
  const value = typeof column.sort === "function" ? column.sort(row) : row?.[column.id];
  return value instanceof Date ? value.getTime() : value;
}

function compareValues(a, b) {
  const aNull = a === null || a === undefined || a === "" || Number.isNaN(a);
  const bNull = b === null || b === undefined || b === "" || Number.isNaN(b);
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * A new array sorted by `column` ascending or descending. Stable: equal rows
 * keep their order, and empty values always sort last in both directions.
 * An unsortable column or `dir` null returns the rows as they are.
 */
export function sortRows(rows, column, dir) {
  if (!column || !column.sort || (dir !== "asc" && dir !== "desc")) return rows;
  const sign = dir === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(column, row) }))
    .sort((a, b) => {
      const aNull = a.value === null || a.value === undefined || a.value === "";
      const bNull = b.value === null || b.value === undefined || b.value === "";
      if (aNull || bNull) return aNull === bNull ? a.index - b.index : aNull ? 1 : -1;
      return compareValues(a.value, b.value) * sign || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** none → asc → desc → none for a clicked column. */
export function nextSort(current, columnId) {
  if (!current || current.id !== columnId) return { id: columnId, dir: "asc" };
  return current.dir === "asc" ? { id: columnId, dir: "desc" } : null;
}

/** The ids of the columns to show: always-on columns, plus the chosen (or default) optional ones. */
export function visibleColumnIds(columns, stored) {
  const chosen = Array.isArray(stored) ? new Set(stored) : null;
  return columns
    .filter((column) => !column.hideable || (chosen ? chosen.has(column.id) : !column.defaultHidden))
    .map((column) => column.id);
}

/** The id list to store after turning one optional column on or off. */
export function toggleColumn(columns, stored, columnId, on) {
  const current = new Set(visibleColumnIds(columns, stored));
  if (on) current.add(columnId);
  else current.delete(columnId);
  return columns.filter((column) => current.has(column.id)).map((column) => column.id);
}

/** The slice [start, end) of rows to render for a scroll position, never more than `max` rows. */
export function windowRange(total, scrollTop, viewportHeight, rowHeight, { overscan = OVERSCAN, max = WINDOW_MAX_ROWS } = {}) {
  const height = Math.max(1, rowHeight || DEFAULT_ROW_HEIGHT);
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / height) - overscan);
  const visible = Math.ceil(Math.max(0, viewportHeight) / height) + overscan * 2;
  const count = Math.min(max, Math.max(1, visible), total);
  const start = Math.min(first, Math.max(0, total - count));
  return { start, end: Math.min(total, start + count) };
}

/** The CSV text of rows (already in display order) for the exportable visible columns, with BOM. */
export function tableCsv(rows, columns) {
  const cols = columns
    .filter((column) => column.csv !== false)
    .map((column) => ({
      key: column.id,
      header: column.csvHeader ?? (typeof column.header === "string" ? column.header : column.id),
      value: (row) => (typeof column.csv === "function" ? column.csv(row) : sortValue(column, row)),
    }));
  return toCsv(rows, cols);
}

function saveCsv(name, text) {
  try {
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([text], { type: "text/csv;charset=utf-8" }));
    const link = globalThis.document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    globalThis.document.body.appendChild(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function keyOf(rowKey, row, index) {
  if (typeof rowKey === "function") return rowKey(row, index);
  if (typeof rowKey === "string") return row?.[rowKey] ?? index;
  return row?.id ?? index;
}

function cellOf(column, row) {
  if (typeof column.cell === "function") return column.cell(row);
  const value = row?.[column.id];
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function ColumnChooser({ id, columns, visible, onToggle }) {
  const { t } = useT();
  const optional = columns.filter((column) => column.hideable);
  if (!optional.length) return null;
  return html`<details class="column-chooser" data-testid="data-table.chooser">
    <summary class="btn btn-sm" data-testid="data-table.chooser-toggle">${t("common.table.columns")}</summary>
    <fieldset class="column-chooser-list">
      <legend class="sr-only">${t("common.table.columns")}</legend>
      ${optional.map((column) => html`<label key=${column.id} class="check">
        <input type="checkbox" checked=${visible.includes(column.id)} data-testid=${`data-table.column.${column.id}`}
          onChange=${(event) => onToggle(column.id, event.currentTarget.checked)} />
        ${typeof column.header === "string" ? column.header : column.id}
      </label>`)}
    </fieldset>
  </details>`;
}

// id keys the column preference; caption names the table for screen readers.
export function DataTable({
  id,
  columns = [],
  rows = [],
  source,
  rowKey,
  onRowClick,
  filters,
  pageSize = 50,
  exportName,
  exportHref,
  empty,
  responsive = "scroll",
  caption,
  loading = false,
  testid,
}) {
  const { t } = useT();
  const [stored, setStored] = usePref("tableColumns");
  const narrow = useMediaQuery("(max-width: 639px)");
  const [sort, setSort] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const scroller = useRef(null);
  const body = useRef(null);

  const visibleIds = useMemo(() => visibleColumnIds(columns, stored?.[id]), [columns, stored, id]);
  const shownColumns = columns.filter((column) => visibleIds.includes(column.id));
  const sortColumn = sort ? columns.find((column) => column.id === sort.id) : null;
  const sorted = useMemo(() => sortRows(rows, sortColumn, sort?.dir), [rows, sortColumn, sort?.dir]);
  const cards = responsive === "cards" && narrow;
  const windowed = !cards && sorted.length > WINDOW_THRESHOLD;
  const range = windowed ? windowRange(sorted.length, scrollTop, viewport, rowHeight) : { start: 0, end: sorted.length };
  const visibleRows = windowed ? sorted.slice(range.start, range.end) : sorted;
  const name = caption || exportName || id;
  const hrefOk = typeof exportHref === "string" ? safeUrl(exportHref) : null;

  useEffect(() => {
    if (!windowed || !scroller.current) return;
    setViewport(scroller.current.clientHeight || 600);
    const first = body.current?.querySelector("tr[data-row]");
    const measured = first?.getBoundingClientRect().height;
    if (measured && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
  }, [windowed, range.start, sorted.length]);

  function onScroll(event) {
    const top = event.currentTarget.scrollTop;
    // Whole rows only: the window changes when a row boundary is crossed.
    setScrollTop(Math.floor(top / rowHeight) * rowHeight);
  }

  function onToggle(columnId, on) {
    const next = { ...(stored || {}), [id]: toggleColumn(columns, stored?.[id], columnId, on) };
    setStored(next);
  }

  function exportCsv() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    saveCsv(`${String(exportName || id).replace(/[^\w.-]/g, "_")}-${stamp}.csv`, tableCsv(sorted, shownColumns));
  }

  const sortable = (column) => Boolean(column.sort);
  const ariaSort = (column) => (!sortable(column) ? undefined : sort?.id === column.id ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
  const clickable = typeof onRowClick === "function";
  const rowProps = (row) => (clickable
    ? {
        tabindex: "0",
        "data-clickable": "true",
        onClick: () => onRowClick(row),
        onKeyDown: (event) => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onRowClick(row);
          }
        },
      }
    : {});

  const emptyView = empty ?? html`<p class="muted" data-testid="data-table.empty">${t("common.table.empty")}</p>`;
  const toolbar = html`<div class="table-toolbar row" data-testid="data-table.toolbar">
    ${filters ? html`<div class="table-filters row grow">${filters}</div>` : html`<span class="grow"></span>`}
    <span class="muted small" role="status" data-testid="data-table.count">${t("common.table.rows", { count: sorted.length })}</span>
    <${ColumnChooser} id=${id} columns=${columns} visible=${visibleIds} onToggle=${onToggle} />
    <${Button} size="sm" onClick=${exportCsv} disabled=${!sorted.length} testid="data-table.csv">${t("common.table.exportCsv")}<//>
    ${hrefOk ? html`<${Button} size="sm" href=${hrefOk} testid="data-table.export-server">${t("common.table.exportServer")}<//>` : null}
  </div>`;

  const more = source?.cursor ? html`<div class="table-more row" data-testid="data-table.more">
    <${Button} busy=${Boolean(source.loading)} onClick=${() => source.loadMore?.(source.cursor, pageSize)} testid="data-table.load-more">${t("common.table.loadMore")}<//>
  </div>` : null;

  if (loading) {
    return html`<div class="data-table" aria-busy="true" data-testid=${testid || "data-table.root"}>${toolbar}<${Skeleton} shape="table" rows=${5} /></div>`;
  }

  if (cards) {
    return html`<div class="data-table" data-mode="cards" data-testid=${testid || "data-table.root"}>
      ${toolbar}
      <p class="sr-only">${name}</p>
      ${sorted.length ? html`<ul class="data-cards" aria-label=${name}>
        ${sorted.map((row, index) => html`<li key=${keyOf(rowKey, row, index)} class="data-card" data-testid="data-table.card" ...${rowProps(row)}>
          <dl class="kv">
            ${shownColumns.map((column) => html`<dt key=${`${column.id}-t`}>${typeof column.header === "string" || typeof column.header === "number" ? column.header : column.id}</dt><dd key=${`${column.id}-d`}>${cellOf(column, row)}</dd>`)}
          </dl>
        </li>`)}
      </ul>` : emptyView}
      ${more}
    </div>`;
  }

  const topSpace = windowed ? range.start * rowHeight : 0;
  const bottomSpace = windowed ? (sorted.length - range.end) * rowHeight : 0;
  return html`<div class="data-table" data-mode=${windowed ? "windowed" : "table"} data-testid=${testid || "data-table.root"}>
    ${toolbar}
    <div class=${`table-wrap data-scroll${windowed ? " data-windowed" : ""}`} ref=${scroller} tabindex="0" role="region" aria-label=${name} onScroll=${windowed ? onScroll : undefined} data-testid="data-table.scroll">
      <table class="table" aria-rowcount=${windowed ? sorted.length + 1 : undefined}>
        <caption class="sr-only">${name}</caption>
        <thead><tr>
          ${shownColumns.map((column) => html`<th key=${column.id} scope="col" class=${column.align === "end" || column.align === "right" ? "num" : undefined}
            aria-sort=${ariaSort(column)} data-column=${column.id}>
            ${sortable(column)
              ? html`<button type="button" class="th-sort" onClick=${() => setSort(nextSort(sort, column.id))} data-testid="data-table.sort">
                  ${column.header}<span class="sort-mark" aria-hidden="true">${sort?.id === column.id ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
                </button>`
              : column.header}
          </th>`)}
        </tr></thead>
        <tbody ref=${body}>
          ${topSpace ? html`<tr aria-hidden="true" class="row-spacer"><td colspan=${shownColumns.length} style=${{ height: `${topSpace}px`, padding: 0, border: 0 }}></td></tr>` : null}
          ${visibleRows.map((row, offset) => html`<tr key=${keyOf(rowKey, row, range.start + offset)} data-row="true" data-testid="data-table.row"
            aria-rowindex=${windowed ? range.start + offset + 2 : undefined} ...${rowProps(row)}>
            ${shownColumns.map((column) => html`<td key=${column.id} class=${column.align === "end" || column.align === "right" ? "num" : undefined}>${cellOf(column, row)}</td>`)}
          </tr>`)}
          ${bottomSpace ? html`<tr aria-hidden="true" class="row-spacer"><td colspan=${shownColumns.length} style=${{ height: `${bottomSpace}px`, padding: 0, border: 0 }}></td></tr>` : null}
        </tbody>
      </table>
      ${sorted.length ? null : html`<div class="table-empty">${emptyView}</div>`}
    </div>
    ${more}
  </div>`;
}

