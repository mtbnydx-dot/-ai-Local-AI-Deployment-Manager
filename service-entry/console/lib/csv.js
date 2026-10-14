// CSV export for tables (07 §4.4 DataTable, §13.1 csv.test.js).
//
// RFC 4180 quoting with CRLF line ends, a UTF-8 BOM so spreadsheet apps read
// Chinese text correctly, and formula escaping: a text cell that starts with
// = + - @ or a tab/CR gets a leading apostrophe so it is never evaluated.

export const BOM = "\ufeff";
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

/** One cell as CSV text. Numbers and booleans are written as-is; text is escaped and quoted when needed. */
export function csvCell(value, { separator = "," } = {}) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text) || text.includes(separator)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * @param rows objects
 * @param columns [{ key, header, value?(row) }]; `value` wins over `key`
 * @returns CSV text, BOM first unless `bom:false`
 */
export function toCsv(rows, columns, { bom = true, separator = "," } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const lines = [cols.map((column) => csvCell(column.header ?? column.key ?? "", { separator })).join(separator)];
  for (const row of Array.isArray(rows) ? rows : []) {
    lines.push(cols.map((column) => {
      const value = typeof column.value === "function" ? column.value(row) : row?.[column.key];
      return csvCell(value, { separator });
    }).join(separator));
  }
  return `${bom ? BOM : ""}${lines.join("\r\n")}\r\n`;
}
