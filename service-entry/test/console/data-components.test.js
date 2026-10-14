// CON-7a (07 §4.4): the pure parts of DataTable and LogViewer, run in Node.
// Rendering, focus, scrolling and persistence are covered in a browser by
// tests/frontend/console/console-data.spec.js against /system/ui-kit.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CONSOLE_DIR } = await import("./loader.mjs");
const load = (file) => import(pathToFileURL(path.join(CONSOLE_DIR, file)).href);
const table = await load("components/data-table.js");
const log = await load("components/log-viewer.js");

const BOM_CHAR = String.fromCharCode(0xfeff);

test("the CON-7a component files export their components and follow the shared rules", async () => {
  for (const [file, name] of [["data-table.js", "DataTable"], ["log-viewer.js", "LogViewer"], ["markdown-viewer.js", "MarkdownViewer"]]) {
    const module = await load(`components/${file}`);
    assert.equal(typeof module[name], "function", `${file} exports ${name}`);
    const source = fs.readFileSync(path.join(CONSOLE_DIR, "components", file), "utf8");
    assert.match(source, /data-testid|testid/);
    assert.equal(/\sstyle="/.test(source), false, "no style attribute (CSP)");
  }
});

test("sortRows sorts numbers and text, is stable, and keeps empty values last in both directions", () => {
  const rows = [
    { id: "a", n: 10, s: "b10" }, { id: "b", n: 2, s: "b2" }, { id: "c", n: null, s: "" },
    { id: "d", n: 2, s: "A1" }, { id: "e", n: undefined, s: "b1" },
  ];
  const num = { id: "n", sort: true };
  assert.deepEqual(table.sortRows(rows, num, "asc").map((row) => row.id), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(table.sortRows(rows, num, "desc").map((row) => row.id), ["a", "b", "d", "c", "e"], "ties keep their order; empties stay last");
  assert.deepEqual(table.sortRows(rows, { id: "s", sort: true }, "asc").map((row) => row.id), ["d", "e", "b", "a", "c"], "text sorts naturally (b2 before b10)");
  assert.equal(table.sortRows(rows, num, null), rows);
  assert.equal(table.sortRows(rows, { id: "n" }, "asc"), rows, "an unsortable column leaves the order");
  assert.deepEqual(table.sortRows(rows, { id: "x", sort: (row) => -row.n }, "asc").map((row) => row.id).slice(0, 1), ["a"], "sort getter");
});

test("nextSort cycles ascending, descending, none and restarts on another column", () => {
  assert.deepEqual(table.nextSort(null, "a"), { id: "a", dir: "asc" });
  assert.deepEqual(table.nextSort({ id: "a", dir: "asc" }, "a"), { id: "a", dir: "desc" });
  assert.equal(table.nextSort({ id: "a", dir: "desc" }, "a"), null);
  assert.deepEqual(table.nextSort({ id: "a", dir: "desc" }, "b"), { id: "b", dir: "asc" });
});

test("the column chooser: defaults, stored choices and toggling", () => {
  const columns = [{ id: "name" }, { id: "gpu", hideable: true }, { id: "note", hideable: true, defaultHidden: true }];
  assert.deepEqual(table.visibleColumnIds(columns, undefined), ["name", "gpu"]);
  assert.deepEqual(table.visibleColumnIds(columns, ["name", "note"]), ["name", "note"], "a stored list wins, and always-on columns stay");
  assert.deepEqual(table.visibleColumnIds(columns, []), ["name"]);
  assert.deepEqual(table.toggleColumn(columns, undefined, "note", true), ["name", "gpu", "note"]);
  assert.deepEqual(table.toggleColumn(columns, ["name", "gpu", "note"], "gpu", false), ["name", "note"]);
  assert.deepEqual(table.toggleColumn(columns, ["name"], "gpu", true), ["name", "gpu"], "ids follow the column order");
});

test("windowRange never asks for more than 120 rows and follows the scroll position", () => {
  assert.equal(table.WINDOW_THRESHOLD, 500);
  for (const total of [501, 5000, 100000]) {
    for (const [top, viewport, rowHeight] of [[0, 600, 40], [8000, 600, 40], [1e9, 600, 40], [0, 100000, 20], [300, 0, 40], [50, 600, 0]]) {
      const { start, end } = table.windowRange(total, top, viewport, rowHeight);
      assert.ok(end - start <= 120, `${total} rows at ${top}/${viewport}/${rowHeight}: ${end - start}`);
      assert.ok(start >= 0 && end <= total && end > start);
    }
  }
  const middle = table.windowRange(2000, 4000, 600, 40);
  assert.ok(middle.start <= 100 && middle.end > 115, "the visible rows (100 to 115) are inside the window");
  assert.equal(table.windowRange(2000, 0, 600, 40).start, 0);
  assert.equal(table.windowRange(2000, 1e9, 600, 40).end, 2000, "the end of the list is reachable");
  assert.deepEqual(table.windowRange(3, 0, 600, 40), { start: 0, end: 3 });
});

test("tableCsv writes the visible exportable columns in display order with BOM and formula escaping", () => {
  const columns = [
    { id: "name", header: "Name", sort: true },
    { id: "gpu", header: "GPU", sort: (row) => row.gpu },
    { id: "hidden", header: "Skip", csv: false },
    { id: "label", header: { not: "a string" }, csv: (row) => `${row.name}!` },
  ];
  const text = table.tableCsv([{ name: "=1+1", gpu: 61.5 }, { name: "a,b", gpu: null }], columns);
  assert.equal(text, `${BOM_CHAR}Name,GPU,label\r\n'=1+1,61.5,'=1+1!\r\n"a,b",,"a,b!"\r\n`);
  assert.equal(text.charCodeAt(0), 0xfeff);
});

test("levelOf and passesLevel classify lines and filter by minimum severity", () => {
  assert.equal(log.levelOf("2026 ERROR boom"), "error");
  assert.equal(log.levelOf("Traceback (most recent call last):"), "error");
  assert.equal(log.levelOf("x WARNING low memory"), "warn");
  assert.equal(log.levelOf("x WARN y"), "warn");
  assert.equal(log.levelOf("x INFO ok"), "info");
  assert.equal(log.levelOf("plain"), "other");
  assert.equal(log.levelOf("no errors here"), "other", "the word must be a whole upper-case level");
  const lines = ["ERROR a", "WARN b", "INFO c", "plain d"];
  assert.deepEqual(lines.filter((line) => log.passesLevel(line, "all")), lines);
  assert.deepEqual(lines.filter((line) => log.passesLevel(line, "error")), ["ERROR a"]);
  assert.deepEqual(lines.filter((line) => log.passesLevel(line, "warn")), ["ERROR a", "WARN b"]);
  assert.deepEqual(lines.filter((line) => log.passesLevel(line, "info")), ["ERROR a", "WARN b", "INFO c"]);
});

test("the ring buffer keeps the newest 5000 lines", () => {
  assert.equal(log.RING_LIMIT, 5000);
  const first = Array.from({ length: 4990 }, (_, index) => `l${index}`);
  const added = Array.from({ length: 30 }, (_, index) => `n${index}`);
  const merged = log.appendLines(first, added);
  assert.equal(merged.length, 5000);
  assert.equal(merged[0], "l20");
  assert.equal(merged[4999], "n29");
  assert.equal(log.appendLines(first, []), first);
  assert.equal(log.appendLines([], Array.from({ length: 9000 }, (_, index) => String(index))).length, 5000);
});

test("normalizeLogPayload reads the reply shapes of 01 and 06", () => {
  assert.deepEqual(log.normalizeLogPayload({ text: "a\nb\r\nc\n" }), { lines: ["a", "b", "c"], cursor: null });
  assert.deepEqual(log.normalizeLogPayload({ lines: ["x", { message: "y", at: "T" }, { text: "z" }], cursor: "7" }), { lines: ["x", "T y", "z"], cursor: "7" });
  assert.deepEqual(log.normalizeLogPayload(["p", "q"]).lines, ["p", "q"]);
  assert.deepEqual(log.normalizeLogPayload({ job: { logs: ["j1", "j2"] } }).lines, ["j1", "j2"]);
  assert.deepEqual(log.normalizeLogPayload({ nextSince: 12, logs: ["k"] }), { lines: ["k"], cursor: 12 });
  assert.deepEqual(log.normalizeLogPayload(null), { lines: [], cursor: null });
  assert.deepEqual(log.normalizeLogPayload({}), { lines: [], cursor: null });
});

test("logRequest builds the three source URLs and refuses unknown sources", () => {
  assert.deepEqual(log.logRequest({ kind: "instance", managerId: "vllm", id: "a b" }, { tail: 500, cursor: "c1" }), { manager: "vllm", path: "/instances/a%20b/logs", query: { tail: 500, since: "c1" } });
  assert.deepEqual(log.logRequest({ kind: "job", managerId: "llama", id: "j1" }, { tail: 500 }), { manager: "llama", path: "/jobs/j1", query: {} });
  assert.deepEqual(log.logRequest({ kind: "component", id: "entry" }, { tail: 200 }), { path: "/api/platform/components/entry/logs", query: { tail: 200 } });
  assert.equal(log.logRequest({ kind: "component" }), null);
  assert.equal(log.logRequest({ kind: "instance", id: "x" }), null, "an instance needs its manager");
  assert.equal(log.logRequest({ kind: "other", id: "x" }), null);
  assert.equal(log.logRequest(undefined), null);
});

test("highlightParts splits around case-insensitive matches", () => {
  assert.deepEqual(log.highlightParts("Foo bar foo", "foo"), [{ text: "Foo", match: true }, { text: " bar ", match: false }, { text: "foo", match: true }]);
  assert.deepEqual(log.highlightParts("nothing", "zz"), [{ text: "nothing", match: false }]);
  assert.deepEqual(log.highlightParts("keep", ""), [{ text: "keep", match: false }]);
  assert.deepEqual(log.highlightParts("a.*b", ".*"), [{ text: "a", match: false }, { text: ".*", match: true }, { text: "b", match: false }], "the query is text, not a pattern");
});
