// 07 §13.1 CSV export: BOM, formula escaping and RFC 4180 quoting.

import assert from "node:assert/strict";
import test from "node:test";

import { BOM, csvCell, toCsv } from "../../console/lib/csv.js";

const BOM_CHAR = String.fromCharCode(0xfeff);

test("the export starts with a UTF-8 BOM unless told otherwise and ends lines with CRLF", () => {
  const text = toCsv([{ a: 1, b: "x" }], [{ key: "a", header: "A" }, { key: "b", header: "B" }]);
  assert.equal(BOM, BOM_CHAR);
  assert.equal(text, `${BOM_CHAR}A,B\r\n1,x\r\n`);
  assert.equal(toCsv([], [{ key: "a", header: "A" }], { bom: false }), "A\r\n");
});

test("text that a spreadsheet would evaluate gets a leading apostrophe", () => {
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("\tlead"), "'\tlead");
  assert.equal(csvCell("\rlead"), "\"'\rlead\"");
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), "\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
  assert.equal(csvCell(-1), "-1", "real numbers are not text and stay numeric");
  assert.equal(csvCell("a=b"), "a=b");
});

test("quotes, separators, line breaks and edge spaces are quoted", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("line1\r\nline2"), '"line1\r\nline2"');
  assert.equal(csvCell(" padded "), '" padded "');
  assert.equal(csvCell("a;b", { separator: ";" }), '"a;b"');
  assert.equal(csvCell("plain"), "plain");
});

test("values of every type have a stable text form", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(Number.NaN), "");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell(new Date("2026-10-14T08:00:00Z")), "2026-10-14T08:00:00.000Z");
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell("模型"), "模型");
});

test("column value functions win over keys", () => {
  const rows = [{ model: "qwen", ms: 1500 }, { model: "=evil", ms: null }];
  const text = toCsv(rows, [{ key: "model", header: "Model" }, { header: "Seconds", value: (row) => (row.ms === null ? null : row.ms / 1000) }], { bom: false });
  assert.equal(text, "Model,Seconds\r\nqwen,1.5\r\n'=evil,\r\n");
});
