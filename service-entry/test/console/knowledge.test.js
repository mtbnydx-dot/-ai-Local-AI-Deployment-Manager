// CON-29: the rules behind the Knowledge page (routes/models/knowledge.js):
// how a status answer turns into file rows, which files are invalid or stale,
// the pack id behind an imported file, the import diff rows and where a 422
// puts each field error. Rendering and the confirm flows run in a browser
// (tests/frontend/console/console-models-knowledge.spec.js).

import assert from "node:assert/strict";
import test from "node:test";

// Registers the vendor path mapping before any ui/ or routes/ module is imported.
await import("./loader.mjs");
const page = await import("../../console/routes/models/knowledge.js");

const STATUS = {
  domain: "models",
  layers: [
    { layer: "bundled", path: "<bundled>", files: [{ name: "families.json", kind: "families", entries: 12, errors: [], asOf: "2026-10-14", stale: false }] },
    { layer: "pack", path: "config/knowledge.d/packs", files: [
      { name: "packs/community@0123456789ab.json", kind: "families", entries: 2, errors: [], asOf: "2025-01-01", stale: true, ageDays: 650, staleAfterDays: 120 },
      { name: "packs/broken@ba9876543210.json", kind: "families", entries: 0, errors: [{ entryId: "x", code: "schema", message: "bad" }], stale: true },
    ] },
    { layer: "user", path: "config/knowledge.d", files: [] },
  ],
  errors: [{ layer: "pack", file: "broken", entryId: "x", code: "schema", message: "bad", severity: "error" }, { layer: "user", file: "a", entryId: "", code: "w", message: "m", severity: "warning" }],
};

test("domainRows: one row per file in layer order, with the state and the pack id of an imported pack", () => {
  const rows = page.domainRows(STATUS);
  assert.deepEqual(rows.map((row) => [row.layer, row.file.name, row.state, row.packId]), [
    ["bundled", "families.json", "ok", ""],
    ["pack", "packs/community@0123456789ab.json", "stale", "community"],
    ["pack", "packs/broken@ba9876543210.json", "invalid", "broken"],
  ]);
  assert.deepEqual(page.domainRows({ layers: null }), []);
});

test("an invalid file is invalid even when it is also stale; a warning is not a problem", () => {
  assert.equal(page.fileState({ errors: [{ code: "x" }], stale: true }), "invalid");
  assert.equal(page.fileState({ stale: true }), "stale");
  assert.equal(page.fileState({}), "ok");
  assert.equal(page.domainProblems(STATUS).length, 1);
});

test("packIdOfFile reads the id before @<sha> and nothing else", () => {
  assert.equal(page.packIdOfFile("packs/my.pack_1@0123456789ab.json"), "my.pack_1");
  assert.equal(page.packIdOfFile(["packs", "win@0123456789ab.json"].join(String.fromCharCode(92))), "win");
  assert.equal(page.packIdOfFile("families.json"), "");
  assert.equal(page.packIdOfFile(undefined), "");
});

test("diffRows: added has no current value, deleted no new value", () => {
  const labels = { added: "New", replaced: "Pack", current: "Now" };
  assert.deepEqual(page.diffRows({ added: ["a"], replaced: ["b"], deleted: ["c"] }, labels), [
    { label: "a", from: "", to: "New" },
    { label: "b", from: "Now", to: "Pack" },
    { label: "c", from: "Now", to: "" },
  ]);
  assert.deepEqual(page.diffRows(undefined, labels), []);
});

test("splitOverrideErrors: errors naming id go to the id field, the rest to the JSON field", () => {
  const split = page.splitOverrideErrors({ fieldErrors: [{ field: "id", message: "a" }, { field: "contextMax", message: "b" }, { field: null, message: "c" }] });
  assert.deepEqual(split.id.map((item) => item.message), ["a"]);
  assert.deepEqual(split.rest.map((item) => item.message), ["b", "c"]);
  assert.deepEqual(page.splitOverrideErrors(null), { id: [], rest: [] });
});

test("the page is the route's default export and lists the three kinds the API knows", () => {
  assert.equal(typeof page.default, "function");
  assert.deepEqual([...page.KINDS], ["families", "template-signatures", "error-signatures"]);
});
