// CON-14: the rules behind the Models library, storage and detail pages
// (lib/library-model.js, lib/storage-model.js) and the shape of the real hub
// answers they read. Rendering, dialogs and the flows against mocked APIs are
// covered in a browser by tests/frontend/console/console-models.spec.js.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { check } from "../../console/lib/guards.js";
import * as library from "../../console/lib/library-model.js";
import * as schemas from "../../console/lib/schemas.js";
import * as storage from "../../console/lib/storage-model.js";

// Registers the vendor path mapping before any ui/ or routes/ module is imported.
await import("./loader.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "console", `${name}.json`), "utf8"));

// ---------------------------------------------------------------------------
// Library rows

test("entryView turns a hub LibraryEntry into one row: role, engines, verification, provenance repo@rev, update and leftovers", () => {
  const body = fixture("models-library");
  const views = body.entries.map((item) => library.entryView(item, body.roots));
  const [qwen, gemma, copy, tools, single, cache] = views;
  assert.equal(qwen.name, "Qwen3-8B-FP8");
  assert.equal(qwen.role, "main");
  assert.deepEqual(qwen.engines, [{ engineId: "vllm", verdict: "ok" }, { engineId: "sglang", verdict: "ok" }]);
  assert.equal(qwen.provenance, "Qwen/Qwen3-8B-FP8@40f1c0de", "a 40-hex revision is shortened");
  assert.equal(qwen.provenanceConfidence, "declared");
  assert.equal(qwen.verification, "ok");
  assert.equal(qwen.update, "available");
  assert.equal(qwen.updateFiles, 3);
  assert.equal(qwen.updateBytes, 120_000_000);
  assert.deepEqual(qwen.duplicates, ["lib_c3d4e5f607182930"]);
  assert.equal(qwen.lastLaunchedAt, "2026-10-10T12:00:00.000Z");
  assert.equal(gemma.residueFiles, 2);
  assert.equal(gemma.residueBytes, 4_000_000_000);
  assert.equal(gemma.update, "unsupported");
  assert.equal(copy.verification, "warn");
  assert.equal(copy.engines[0].verdict, "warn");
  assert.equal(tools.role, "tooling-only");
  assert.equal(tools.runnable, false, "a tooling-only folder is not offered for Deploy");
  assert.equal(cache.cache, true);
  assert.equal(cache.rootId, "");
  assert.equal(single.isRoot, true, "a model-mode root is the entry itself");
  assert.equal(qwen.isRoot, false);
});

test("entryView survives a sparse or hostile entry", () => {
  const view = library.entryView({ id: 7, path: null, provenance: "x", verification: { status: "weird" }, update: { status: "weird" }, card: { role: { value: "draft" }, compatibility: [null, { engineId: "x", verdict: "block" }, { engineId: "y", verdict: "ok" }, { engineId: "y", verdict: "warn" }] } });
  assert.equal(view.id, "");
  assert.equal(view.verification, "unchecked");
  assert.equal(view.update, "unknown");
  assert.equal(view.role, "draft");
  assert.deepEqual(view.engines, [{ engineId: "y", verdict: "ok" }], "blocked and unknown rows are no chip; an engine appears once");
  assert.equal(library.entryView(null).name, "");
});

test("provenanceText: repo@revision, a short sha, nothing without a repo", () => {
  assert.equal(library.provenanceText({ repo: "a/b", revision: "main" }), "a/b@main");
  assert.equal(library.provenanceText({ repo: "a/b", revision: "main", revisionSha: "0123456789abcdef0123456789abcdef01234567" }), "a/b@01234567");
  assert.equal(library.provenanceText({ repo: "a/b" }), "a/b");
  assert.equal(library.provenanceText({ repo: "" }), "");
  assert.equal(library.provenanceText(null), "");
});

test("the legacy listing: models both managers list appear once, with the root they sit in, and no hub-only data", () => {
  const model = { path: "X:/models/a", label: "a", size: 10, storageId: "legacy", storageLabel: "Original library", runnable: true, verificationStatus: "ok", modelFormat: "safetensors" };
  const merged = library.mergeLegacyModels([
    { managerId: "vllm", body: { local: [model, { ...model, path: "Y:/m/b", label: "b", hasGguf: true, modelFormat: "", storageId: "r2", storageLabel: "Second" }, { label: "no path" }] } },
    { managerId: "llama", body: { local: [{ ...model, path: "x:/models/A" }] } },
    { managerId: "x", body: null },
  ]);
  assert.deepEqual(merged.views.map((view) => view.name), ["a", "b"]);
  assert.equal(merged.views[1].format, "gguf");
  assert.deepEqual(merged.roots.map((root) => root.id), ["legacy", "r2"]);
  const [a] = merged.views;
  assert.equal(a.legacy, true);
  assert.equal(a.source, "managers");
  assert.equal(a.routeId, "X:/models/a", "the detail route id is the folder path");
  assert.equal(a.provenance, "");
  assert.equal(a.update, "unknown");
  assert.equal(library.canDelete(a), false, "the managers' listing has no hub to delete through");
});

test("degradable: the answers that mean the hub is not there", () => {
  for (const error of [{ status: 404 }, { status: 405 }, { status: 501 }, { code: "endpoint_unavailable" }, { code: "feature_unavailable" }, { status: 503, code: "hub_unavailable" }]) {
    assert.equal(library.degradable(error), true, JSON.stringify(error));
  }
  for (const error of [{ status: 500, code: "internal_error" }, { code: "network_error" }, { status: 403, code: "csrf_invalid" }, null]) {
    assert.equal(library.degradable(error), false, JSON.stringify(error));
  }
});

test("facets list what the rows hold, and the filters combine", () => {
  const body = fixture("models-library");
  const views = body.entries.map((item) => library.entryView(item, body.roots));
  const options = library.facetOptions(views, body.roots);
  assert.deepEqual(options.formats, ["gguf", "safetensors"]);
  assert.deepEqual(options.engines, ["llamacpp", "sglang", "vllm"]);
  assert.deepEqual(options.roles, ["main", "tooling-only"]);
  assert.equal(options.canFilterUpdate, true);
  assert.ok(options.roots.some((root) => root.id === "r_second" && root.label === "Library Y"));
  const names = (filters) => library.applyFilters(views, { ...library.EMPTY_FILTERS, ...filters }).map((view) => view.name);
  assert.equal(names({}).length, 6);
  assert.deepEqual(names({ rootId: "r_second" }), ["gemma-3-12b-it-Q4_K_M"]);
  assert.deepEqual(names({ format: "gguf" }), ["gemma-3-12b-it-Q4_K_M"]);
  assert.deepEqual(names({ engine: "sglang" }), ["Qwen3-8B-FP8"]);
  assert.deepEqual(names({ role: "tooling-only" }), ["sglang-tools"]);
  assert.deepEqual(names({ hasUpdate: true }), ["Qwen3-8B-FP8"]);
  assert.deepEqual(names({ q: "QWEN/qwen3-8b" }), ["Qwen3-8B-FP8", "Qwen3-8B-FP8-copy"], "the search covers the provenance repo");
  assert.deepEqual(names({ q: "qwen", format: "safetensors", engine: "vllm" }), ["Qwen3-8B-FP8", "Qwen3-8B-FP8-copy"]);
  assert.deepEqual(names({ q: "zzz" }), []);
});

// ---------------------------------------------------------------------------
// Capacity

test("rootBars: per-root parts from storage/usage; a hidden root is left out; nothing is negative", () => {
  const usage = fixture("models-usage");
  const bars = library.rootBars(usage);
  assert.deepEqual(bars.map((bar) => bar.id), ["r_main", "r_second"], "the hidden legacy root is not drawn");
  const second = bars[1];
  assert.equal(second.online, true);
  assert.equal(second.totalBytes, 2_000_000_000_000);
  assert.deepEqual(second.parts, {
    used: 2_000_000_000_000 - 1_900_000_000_000 - 7_300_000_000,
    models: 7_300_000_000 - 4_000_000_000,
    residue: 4_000_000_000,
    pending: 5_000_000_000,
  });
  assert.equal(second.default, false);
  assert.equal(bars[0].default, true);
  // A drive that is gone has no capacity to draw.
  const [offline] = library.rootBars({ roots: [{ id: "r", label: "Gone", totalBytes: null, freeBytes: null, available: false, usedByModelsBytes: 5 }] });
  assert.equal(offline.online, false);
  assert.equal(offline.totalBytes, 0);
  // More models than the drive says it holds never produces a negative part.
  const [odd] = library.rootBars({ roots: [{ id: "r", label: "Odd", totalBytes: 100, freeBytes: 90, usedByModelsBytes: 50, incompleteBytes: 80 }] });
  assert.equal(odd.parts.used, 0);
  assert.equal(odd.parts.residue, 50, "leftovers cannot exceed the models they sit in");
  assert.equal(odd.parts.models, 0);
  assert.deepEqual(library.rootBars(null), []);
});

test("cacheBar: the three cache folders and the free space beside them", () => {
  const bar = library.cacheBar(fixture("models-usage"));
  assert.equal(bar.parts.hub, 21_000_000_000);
  assert.equal(bar.parts.xet, 0);
  assert.equal(bar.parts.modelscope, 3_000_000_000);
  assert.equal(bar.totalBytes, 24_000_000_000 + 675_000_000_000);
  assert.equal(bar.volume, "D:");
  assert.equal(library.cacheBar({}), null);
});

test("cleanupTargets: idle residues and orphan partial downloads in the order storage/cleanup takes them; duplicates only count", () => {
  const usage = fixture("models-usage");
  assert.deepEqual(library.cleanupTargets(usage), [
    { kind: "incomplete", entryId: "lib_b2c3d4e5f6071829", bytes: 4_000_000_000 },
    { kind: "partial-download", jobId: "dl_orphan01", bytes: 12_000_000_000 },
  ]);
  const busy = { residues: [{ entryId: "lib_x", incompleteBytes: 1, busy: true }], orphanPartials: [] };
  assert.deepEqual(library.cleanupTargets(busy), [], "a residue under an active download is not offered");
  assert.equal(library.duplicateBytes(usage), 8_900_000_000);
});

// ---------------------------------------------------------------------------
// Delete

test("delete asks for the folder name, never targets a root, and is not offered without the hub", () => {
  const body = fixture("models-library");
  const [qwen, , , , single] = body.entries.map((item) => library.entryView(item, body.roots));
  assert.equal(library.deleteConfirmName(qwen), "Qwen3-8B-FP8");
  assert.equal(library.canDelete(qwen), true);
  assert.equal(library.canDelete(single), false, "a registered root can never be targeted");
  assert.equal(library.canDelete(null), false);
  assert.equal(library.reclaimedBytes({ result: { reclaimedBytes: 123 } }), 123);
  assert.equal(library.reclaimedBytes({ result: null }), 0);
  assert.equal(library.taskDone({ state: "running" }), false);
  assert.equal(library.taskDone({ state: "succeeded" }), true);
  assert.equal(library.taskDone({ state: "failed" }), true);
  assert.equal(library.taskFailed({ state: "failed" }), true);
  assert.equal(library.taskFailed({ state: "succeeded" }), false);
});

// ---------------------------------------------------------------------------
// Detail

test("detailTabs: Quantizations for a repository only, Provenance for a local model only", () => {
  assert.deepEqual(library.detailTabs(true), ["overview", "compat", "quants", "files", "readme"]);
  assert.deepEqual(library.detailTabs(false), ["overview", "compat", "files", "readme", "provenance"]);
});

test("quantRows joins the 8K and the 32K fit of each artifact and keeps the recommended star", () => {
  const eight = [
    { artifactKey: "gguf:|Q4", label: "Q4", format: "gguf", bytes: 4, fileCount: 1, fit: { label: "fits", neededMb: 6100, basis: "params" }, engines: [{ engineId: "llamacpp" }], recommended: true, library: { state: "present", entryId: "lib_x" } },
    { artifactKey: "st:", format: "safetensors", quant: "BF16", bytes: 9, fit: { label: "fits", spill: true, neededMb: 1 } },
    { kind: "no key" },
  ];
  const wide = [{ artifactKey: "gguf:|Q4", fit: { label: "tight", neededMb: 9800 } }, { artifactKey: "st:", fit: { label: "fits", spill: true, neededMb: 2 } }];
  const rows = library.quantRows(eight, wide);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].recommended, true);
  assert.equal(rows[0].fit8k.neededMb, 6100);
  assert.equal(rows[0].fit32k.label, "tight");
  assert.deepEqual(rows[0].engines, ["llamacpp"]);
  assert.equal(rows[0].libraryState, "present");
  assert.equal(rows[1].label, "BF16");
  assert.equal(rows[1].spill8k, true);
  assert.equal(rows[1].spill32k, true);
  assert.equal(library.quantRows(eight)[0].fit32k, null, "no 32K answer yet");
  assert.deepEqual(library.quantRows(null), []);
});

test("fitLabelKey maps a spill to the hub label 'spills' and keeps the others", () => {
  assert.equal(library.fitLabelKey("fits", true), "spills");
  assert.equal(library.fitLabelKey("tight", true), "spills");
  assert.equal(library.fitLabelKey("wont-fit", true), "wont-fit");
  assert.equal(library.fitLabelKey("fits"), "fits");
  assert.equal(library.fitLabelKey("weird"), "unknown");
});

test("repoPath and sourceUrl encode the repository and know the two hubs", () => {
  const target = { provider: "huggingface", owner: "example-org", name: "model 7B" };
  assert.equal(library.repoPath(target), "/api/hub/repos/huggingface/example-org/model%207B");
  assert.equal(library.sourceUrl(target), "https://huggingface.co/example-org/model 7B");
  assert.equal(library.sourceUrl({ ...target, provider: "modelscope" }), "https://modelscope.cn/models/example-org/model 7B");
  assert.equal(library.sourceUrl({ ...target, provider: "elsewhere" }), "");
});

// ---------------------------------------------------------------------------
// Storage

test("path text: quotes, parent folder and the final location follow the legacy page", () => {
  assert.equal(storage.cleanPath('  "X:\\models\\a"  '), "X:\\models\\a");
  assert.equal(storage.parentDirectory("X:\\models\\a"), "X:\\models\\");
  assert.equal(storage.parentDirectory("X:/models/a/"), "X:/models/");
  assert.equal(storage.parentDirectory("X:"), "");
  assert.equal(storage.destinationText("X:\\models\\", "", "Y:\\old\\Qwen3"), "X:\\models\\Qwen3", "the name defaults to the source folder");
  assert.equal(storage.destinationText("X:/models", "renamed", "Y:/old/Qwen3"), "X:/models/renamed");
  assert.equal(storage.destinationText("X:", "n", ""), "X:\\n");
  assert.equal(storage.destinationText("/data/models", "n", ""), "/data/models/n");
  assert.equal(storage.destinationText("", "n", "s"), "");
  assert.equal(storage.destinationText("X:/m", "", ""), "");
  assert.equal(storage.folderChoosable("X:\\"), false);
  assert.equal(storage.folderChoosable("X:"), false);
  assert.equal(storage.folderChoosable("/"), false);
  assert.equal(storage.folderChoosable(""), false);
  assert.equal(storage.folderChoosable("X:\\models"), true);
});

test("roots: the badge, the libraries a migration can target and the starting target", () => {
  const snapshot = {
    defaultRootId: "b",
    roots: [
      { id: "a", label: "A", path: "X:/a", mode: "library", online: true },
      { id: "b", label: "B", path: "Y:/b", mode: "library", online: true },
      { id: "c", label: "C", path: "Z:/c", mode: "model", online: true },
      { id: "d", label: "D", path: "W:/d", mode: "library", online: false },
    ],
  };
  assert.deepEqual(snapshot.roots.map((root) => storage.rootBadge(root, snapshot.defaultRootId)), ["available", "default", "imported", "offline"]);
  assert.deepEqual(storage.libraryRoots(snapshot).map((root) => root.id), ["a", "b"]);
  assert.equal(storage.defaultTarget(snapshot), "Y:/b");
  assert.equal(storage.defaultTarget({ defaultRootId: "zz", roots: snapshot.roots }), "X:/a");
  assert.equal(storage.defaultTarget({ roots: [] }), "");
});

test("request bodies match the manager's /api/model-storage routes", () => {
  assert.deepEqual(storage.registerBody({ path: ' "X:/m" ', label: " Mine ", mode: "model", create: true, makeDefault: true }), { path: "X:/m", label: "Mine", mode: "model", create: true, makeDefault: true });
  assert.deepEqual(storage.registerBody({ path: "X:/m", mode: "weird" }), { path: "X:/m", label: "", mode: "library", create: false, makeDefault: false });
  assert.deepEqual(storage.planBody({ source: "Y:/a", targetDirectory: ' "X:/m" ', outputName: " n " }), { source: "Y:/a", targetDirectory: "X:/m", outputName: "n" });
});

test("migration jobs offer what the legacy page offered in each state", () => {
  const offered = (state, extra = {}) => {
    const actions = storage.migrationActions({ state, ...extra });
    return Object.keys(actions).filter((name) => actions[name]);
  };
  assert.deepEqual(offered("planned"), ["start"]);
  assert.deepEqual(offered("failed"), ["start", "continue"]);
  assert.deepEqual(offered("interrupted"), ["start", "continue"]);
  assert.deepEqual(offered("cancelled"), ["start", "continue"]);
  assert.deepEqual(offered("copying"), ["cancel", "active"]);
  assert.deepEqual(offered("verifying"), ["cancel", "active"]);
  assert.deepEqual(offered("cleaning"), ["active"], "a cleanup in progress cannot be paused");
  assert.deepEqual(offered("completed"), ["rollback", "cleanup"]);
  assert.deepEqual(offered("cleanup_failed"), ["rollback", "cleanup"]);
  assert.deepEqual(offered("completed", { sourceRemoved: true }), [], "after the source is gone there is no way back");
  assert.deepEqual(offered("rolled_back"), []);
  assert.equal(storage.anyActive([{ state: "completed" }, { state: "copying" }]), true);
  assert.equal(storage.anyActive([{ state: "completed" }]), false);
  assert.equal(storage.anyActive(null), false);
  assert.equal(storage.knownState("copying"), "copying");
  assert.equal(storage.knownState("odd"), "");
});

test("migration progress: a percentage only while the total is known", () => {
  assert.equal(storage.migrationPercent({ totalBytes: 200, bytesDone: 50 }), 25);
  assert.equal(storage.migrationPercent({ totalBytes: 200, bytesDone: 400 }), 100);
  assert.equal(storage.migrationPercent({ totalBytes: 0, bytesDone: 5 }), null);
  assert.equal(storage.migrationPercent({}), null);
  assert.equal(storage.migrationTitle({ source: "Y:\\old\\Qwen3" }), "Qwen3");
  assert.equal(storage.migrationTitle({ id: "mig_1" }), "mig_1");
});

// ---------------------------------------------------------------------------
// Guards and the real hub shapes

test("the library and usage fixtures pass their guards; the library fixture keeps the 03 §9.2 field names", () => {
  assert.equal(check(schemas.LibraryListGuard, fixture("models-library")).ok, true);
  assert.equal(check(schemas.StorageUsageGuard, fixture("models-usage")).ok, true);
  assert.equal(check(schemas.LibraryListGuard, { entries: "no" }).ok, false);
  assert.equal(check(schemas.StorageUsageGuard, { roots: [{ label: "no id" }] }).dropped, 1, "a root without an id is dropped and counted, not drawn");
  const [first] = fixture("models-library").entries;
  for (const field of ["id", "kind", "path", "rootId", "rootLabel", "displayName", "format", "quant", "bytes", "provenance", "verification", "residue", "update", "card", "duplicates", "lastLaunchedAt"]) {
    assert.ok(Object.hasOwn(first, field), field);
  }
});

test("the page modules answer to the console rules: the three pages exist and the heavy detail tabs load lazily", () => {
  const dir = path.join(ROOT, "service-entry", "console", "routes", "models");
  for (const file of ["library.js", "storage.js", "model-detail.js"]) assert.ok(fs.existsSync(path.join(dir, file)), file);
  const detail = fs.readFileSync(path.join(dir, "model-detail.js"), "utf8");
  assert.doesNotMatch(detail, /from "\.\/detail-(compat|tables|readme)\.js"/, "the detail tabs are dynamic imports (07 §11)");
  assert.match(detail, /import\("\.\/detail-compat\.js"\)/);
  const storagePage = fs.readFileSync(path.join(dir, "storage.js"), "utf8");
  assert.match(storagePage, /import\("\.\/folder-dialog\.js"\)/);
});
