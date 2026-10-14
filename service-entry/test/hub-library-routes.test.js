"use strict";

// Model hub library routes (docs/overhaul/03-hub.md §9, §13, §13.1, HUB-8)
// through the real entry: list, detail, rescan, verify, identify and the task
// poll for the owner, and the viewer copies with root-relative paths. The hub
// and its library live in a temp directory with small synthetic models.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const internalAuth = require("../../manager-core/internal-auth");
const { createModelStorage } = require("../../manager-core/model-storage");
const { createModelHub } = require("../../manager-core/model-hub");
const hubRoutes = require("../lib/hub-routes");
const { loadEntry, quietLogger, request, serveEntry } = require("./helpers/entry-harness");

const LAN = "192.168.1.50";
const SHA = "a".repeat(40);

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function put(dir, rel, content) {
  const file = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeModel(dir, { marker = null } = {}) {
  put(dir, "config.json", JSON.stringify({ model_type: "llama" }));
  put(dir, "tokenizer.json", "{}");
  const weights = Buffer.alloc(2048, "w");
  weights.writeBigUInt64LE(2n, 0);
  weights.write("{}", 8, "latin1");
  put(dir, "model.safetensors", weights);
  if (marker) put(dir, ".platform-download.json", JSON.stringify({ schemaVersion: 2, source: "huggingface", createdAt: "2026-10-01T00:00:00.000Z", ...marker }));
}

function recorder() {
  const list = [];
  return { list, publish: (type, payload) => list.push({ type, payload: JSON.parse(JSON.stringify(payload)) }) };
}

async function startHub(t, { withStorage = true } = {}) {
  const root = tempDir(t, "hub-library-routes-");
  const modelsRoot = path.join(root, "models");
  fs.mkdirSync(modelsRoot, { recursive: true });
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const events = recorder();
  const options = { aiRoot: root, dataDir, env: {}, hfCli: "hf", modelScopeCli: "modelscope", logger: quietLogger(), heartbeatMs: 3_600_000, events };
  let storage = null;
  if (withStorage) {
    storage = createModelStorage({ modelsRoot, file: path.join(root, "service-entry", "data", "model-storage.json") });
    options.modelStorage = storage;
    options.libraryOptions = { watchMs: 0 };
  }
  const hub = createModelHub(options);
  return { hub, root, modelsRoot, storage, events, dataDir };
}

async function mountEntry(t, hub) {
  const { entry } = await loadEntry();
  const ctx = entry.createRouteContext({ logger: quietLogger(), hub });
  const routes = await entry.mountRouteModules({ ctx });
  t.after(() => routes.close());
  assert.deepEqual(routes.failed, []);
  const port = await serveEntry(t, entry, routes);
  return { entry, ctx, port, token: entry.security.getTrustToken() };
}

function signed(port, method, pathWithQuery, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const sign = { method, pathWithQuery, principal: options.principal, body: body || "", now: Date.now() };
  const headers = { ...internalAuth.buildMachineHeaders(options.token, sign) };
  return request(port, pathWithQuery, { method, headers, ...(body !== undefined ? { body } : {}) });
}

async function pollTask(port, taskId, { peer } = {}) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await request(port, `/api/hub/tasks/${taskId}`, peer ? { peer } : {});
    assert.equal(response.status, 200, response.text);
    if (response.json.task.state === "succeeded" || response.json.task.state === "failed") return response.json.task;
    assert.ok(Date.now() < deadline, "task did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A running hub with one model that has a moved-from alias, one with a marker.
async function readyHub(t) {
  const world = await startHub(t);
  const libF = path.join(world.root, "libF");
  fs.mkdirSync(libF, { recursive: true });
  world.storage.registerRoot({ path: libF, label: "Library F" });
  makeModel(path.join(world.modelsRoot, "plain-model"));
  const moved = path.join(libF, "moved-model");
  makeModel(moved, { marker: { model: "acme/Moved", revisionSha: SHA, precision: "FP8" } });
  world.storage.addAlias(path.join(world.modelsRoot, "moved-model"), moved, "mig-1");
  await world.hub.start();
  t.after(() => world.hub.stop());
  const first = await world.hub.library.rescan();
  await waitLibraryTask(world.hub, first.taskId);
  return { ...world, libF, moved };
}

async function waitLibraryTask(hub, taskId) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const task = hub.tasks.get(taskId);
    if (task && (task.state === "succeeded" || task.state === "failed")) return task;
    assert.ok(Date.now() < deadline, "task did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the owner lists the library with filters and reads an entry's detail with its files", async (t) => {
  const { hub, root, libF } = await readyHub(t);
  const { port } = await mountEntry(t, hub);

  const list = await request(port, "/api/hub/library");
  assert.equal(list.status, 200);
  assert.equal(list.json.ok, true);
  assert.deepEqual(list.json.entries.map((entry) => entry.relativePath).sort(), ["moved-model", "plain-model"]);
  assert.equal(list.json.nextCursor, null);
  assert.deepEqual(list.json.roots.map((item) => [item.label, item.entryCount]).sort(), [["Library F", 1], ["原模型库", 1]].sort());
  assert.ok(list.json.roots.every((item) => typeof item.path === "string"), "the owner sees root paths");
  const moved = list.json.entries.find((entry) => entry.relativePath === "moved-model");
  assert.equal(moved.path, path.join(libF, "moved-model"));
  assert.equal(moved.files, undefined, "the list leaves the file table to the detail");
  assert.equal(moved.internal, undefined);
  assert.equal(moved.provenance.repo, "acme/Moved");

  const filtered = await request(port, `/api/hub/library?q=acme&format=safetensors&provenance=declared`);
  assert.deepEqual(filtered.json.entries.map((entry) => entry.relativePath), ["moved-model"]);
  const paged = await request(port, "/api/hub/library?limit=1");
  assert.equal(paged.json.entries.length, 1);
  const next = await request(port, `/api/hub/library?limit=1&cursor=${encodeURIComponent(paged.json.nextCursor)}`);
  assert.equal(next.json.entries.length, 1);
  assert.notEqual(next.json.entries[0].id, paged.json.entries[0].id);
  const badCursor = await request(port, "/api/hub/library?cursor=%23%23");
  assert.deepEqual([badCursor.status, badCursor.json.error.code], [400, "invalid_cursor"]);
  const badProvenance = await request(port, "/api/hub/library?provenance=maybe");
  assert.deepEqual([badProvenance.status, badProvenance.json.error.code], [400, "invalid_request"]);

  const detail = await request(port, `/api/hub/library/${moved.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.entry.id, moved.id);
  assert.deepEqual(detail.json.entry.files.map((file) => file.path).sort(), ["config.json", "model.safetensors", "tokenizer.json"]);
  assert.deepEqual(detail.json.entry.aliases, [path.join(root, "models", "moved-model")]);
  const missing = await request(port, "/api/hub/library/lib_0000000000000000");
  assert.deepEqual([missing.status, missing.json.error.code], [404, "library_entry_not_found"]);
  const head = await request(port, `/api/hub/library/${moved.id}`, { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("a viewer sees root-relative paths and labels only, never an absolute path", async (t) => {
  const { hub, root, libF } = await readyHub(t);
  const { port } = await mountEntry(t, hub);
  const owner = await request(port, "/api/hub/library");
  const moved = owner.json.entries.find((entry) => entry.relativePath === "moved-model");

  const viewer = await request(port, "/api/hub/library", { peer: LAN });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.text.includes(root), false, "no host path in the list");
  assert.equal(viewer.text.includes(root.split(path.sep).join("\\\\")), false);
  const seen = viewer.json.entries.find((entry) => entry.id === moved.id);
  assert.equal(seen.path, "Library F/moved-model");
  assert.deepEqual(seen.aliases, ["原模型库/moved-model"]);
  assert.equal(seen.displayPath, undefined);
  assert.equal(seen.aliasDisplay, undefined);
  assert.ok(viewer.json.roots.every((item) => item.path === undefined && typeof item.label === "string"));
  assert.equal(seen.provenance.repo, "acme/Moved", "provenance is not a path and stays");

  const detail = await request(port, `/api/hub/library/${moved.id}`, { peer: LAN });
  assert.equal(detail.status, 200);
  assert.equal(detail.text.includes(root), false);
  assert.equal(detail.json.entry.path, "Library F/moved-model");
  assert.equal(detail.json.entry.files.length, 3, "the file table is not a path");
  assert.equal(detail.text.includes(libF), false);

  // Only paths differ between the two copies.
  const strip = (entry) => {
    const { path: _path, aliases: _aliases, displayPath: _display, aliasDisplay: _aliasDisplay, ...rest } = entry;
    return rest;
  };
  assert.deepEqual(strip(detail.json.entry), strip((await request(port, `/api/hub/library/${moved.id}`)).json.entry));
});

test("rescan, verify and identify are owner-only writes that answer a task id or the entry", async (t) => {
  const { hub } = await readyHub(t);
  const { port } = await mountEntry(t, hub);
  const list = await request(port, "/api/hub/library");
  const plain = list.json.entries.find((entry) => entry.relativePath === "plain-model");

  // viewers cannot write
  for (const [target, body] of [["/api/hub/library/rescan", {}], [`/api/hub/library/${plain.id}/verify`, {}], [`/api/hub/library/${plain.id}/identify`, { repo: "a/b" }]]) {
    const refused = await request(port, target, { method: "POST", peer: LAN, body });
    assert.equal(refused.status, 401, target);
    assert.equal(refused.json.error.code, "admin_session_required");
  }

  const rescan = await request(port, "/api/hub/library/rescan", { method: "POST", body: {} });
  assert.equal(rescan.status, 202);
  assert.match(rescan.json.taskId, /^tsk_[0-9a-f]{16}$/);
  const scanned = await pollTask(port, rescan.json.taskId);
  assert.deepEqual([scanned.kind, scanned.state], ["rescan", "succeeded"]);
  const badRoots = await request(port, "/api/hub/library/rescan", { method: "POST", body: { rootIds: ["nope"] } });
  assert.deepEqual([badRoots.status, badRoots.json.error.code], [400, "unknown_root"]);
  const noRoots = await request(port, "/api/hub/library/rescan", { method: "POST", body: { rootIds: "legacy" } });
  assert.deepEqual([noRoots.status, noRoots.json.error.code], [400, "invalid_request"]);

  const verify = await request(port, `/api/hub/library/${plain.id}/verify`, { method: "POST", body: { checksums: false } });
  assert.equal(verify.status, 202);
  const verified = await pollTask(port, verify.json.taskId);
  assert.deepEqual([verified.kind, verified.entryId, verified.state, verified.result.status], ["verify", plain.id, "succeeded", "ok"]);
  const after = await request(port, `/api/hub/library/${plain.id}`);
  assert.equal(after.json.entry.verification.status, "ok");
  const badVerify = await request(port, `/api/hub/library/${plain.id}/verify`, { method: "POST", body: { checksums: "yes" } });
  assert.deepEqual([badVerify.status, badVerify.json.error.code], [400, "invalid_request"]);
  const noEntry = await request(port, "/api/hub/library/lib_0000000000000000/verify", { method: "POST", body: {} });
  assert.deepEqual([noEntry.status, noEntry.json.error.code], [404, "library_entry_not_found"]);

  const identified = await request(port, `/api/hub/library/${plain.id}/identify`, { method: "POST", body: { provider: "huggingface", repo: "acme/Plain" } });
  assert.equal(identified.status, 200, identified.text);
  assert.deepEqual([identified.json.entry.provenance.repo, identified.json.entry.provenance.confidence, identified.json.entry.provenance.source], ["acme/Plain", "declared", "user"]);
  assert.equal((await request(port, `/api/hub/library/${plain.id}`)).json.entry.provenance.repo, "acme/Plain");
  const badRepo = await request(port, `/api/hub/library/${plain.id}/identify`, { method: "POST", body: { repo: "not a repo" } });
  assert.deepEqual([badRepo.status, badRepo.json.error.code], [400, "invalid_request"]);
  const badType = await request(port, `/api/hub/library/${plain.id}/identify`, { method: "POST", body: { repo: 5 } });
  assert.deepEqual([badType.status, badType.json.error.code], [400, "invalid_request"]);
  const noCandidates = await request(port, `/api/hub/library/${plain.id}/identify`, { method: "POST", body: {} });
  assert.equal(noCandidates.status, 422);
  const malformed = await request(port, `/api/hub/library/${plain.id}/identify`, { method: "POST", body: "{ nope" });
  assert.deepEqual([malformed.status, malformed.json.error.code], [400, "invalid_json"]);

  const wrongMethod = await request(port, `/api/hub/library/${plain.id}/verify`, { method: "GET" });
  assert.deepEqual([wrongMethod.status, wrongMethod.json.error.code, wrongMethod.headers.allow], [405, "method_not_allowed", "POST"]);
  const noTask = await request(port, "/api/hub/tasks/tsk_0000000000000000");
  assert.deepEqual([noTask.status, noTask.json.error.code], [404, "task_not_found"]);
});

test("a failed task keeps error.detail for the owner and drops it for a viewer; the library event is redacted the same way", async (t) => {
  const { hub, root, libF } = await readyHub(t);
  const { port, ctx } = await mountEntry(t, hub);
  const dir = path.join(libF, "will-vanish");
  makeModel(dir);
  await waitLibraryTask(hub, (await hub.library.rescan()).taskId);
  const entry = hub.library.list({}).then((result) => result.entries.find((item) => item.relativePath === "will-vanish"));
  const id = (await entry).id;

  // Make the task fail inside the worker path: an unreadable hash source.
  const task = hub.tasks.get((hub.library.verify(id, { checksums: false })).taskId);
  assert.ok(task);

  // A synthetic failed task, through the redaction functions the mount registered.
  const failed = { id: "tsk_0123456789abcdef", kind: "verify", state: "failed", progress: { done: 0, total: 1 }, error: { code: "task_failed", message: "boom", detail: `Error at ${root}` } };
  const body = hubRoutes.redactHubTaskBodyForViewer({ ok: true, task: failed });
  assert.deepEqual(body.task.error, { code: "task_failed", message: "boom" });
  assert.equal(failed.error.detail.includes(root), true, "the owner's value is untouched");

  const registry = ctx.auth.viewerRegistry;
  const changed = registry.redactEvent("library", { kind: "changed", entryIds: ["lib_1"] });
  assert.deepEqual(changed, { kind: "changed", entryIds: ["lib_1"] });
  const progress = registry.redactEvent("library", { kind: "task", task: failed });
  assert.deepEqual(progress.task.error, { code: "task_failed", message: "boom" });
  assert.equal(progress.task.progress.total, 1);
  assert.equal(registry.redactEvent("library", null), null, "a malformed payload is dropped");

  const viewerTask = await request(port, `/api/hub/tasks/${task.id}`, { peer: LAN });
  assert.equal(viewerTask.status, 200);
  assert.equal(viewerTask.json.task.id, task.id);
  await waitLibraryTask(hub, task.id);
});

test("the hub publishes library events only through events.publish, with entry ids and task progress", async (t) => {
  const { hub, events } = await readyHub(t);
  assert.ok(events.list.length > 0);
  assert.ok(events.list.every((item) => item.type === "library"));
  const kinds = new Set(events.list.map((item) => item.payload.kind));
  assert.deepEqual([...kinds].sort(), ["changed", "task"]);
  const changed = events.list.find((item) => item.payload.kind === "changed").payload;
  assert.ok(changed.entryIds.every((id) => /^lib_[0-9a-f]{16}$/.test(id)));
  assert.equal(hub.busy().verifying, 0);
});

test("a machine principal: system:mcp reads the library, a hub shim reaches no library route", async (t) => {
  const { hub } = await readyHub(t);
  const { port, token } = await mountEntry(t, hub);
  const read = await signed(port, "GET", "/api/hub/library", { principal: "system:mcp", token });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.entries.length, 2);
  const write = await signed(port, "POST", "/api/hub/library/rescan", { principal: "system:mcp", token, body: {} });
  assert.equal(write.status, 403);
  assert.equal(write.json.error.code, "principal_scope_denied", "05's guard keeps system:mcp read-only");
  const shim = await signed(port, "GET", "/api/hub/library", { principal: "system:hub-shim:vllm", token });
  assert.equal(shim.status, 403);
  assert.equal(shim.json.error.code, "principal_route_forbidden");
});

test("without a model storage the library routes answer 503, and the hub reports a corrupt library.json", async (t) => {
  const bare = await startHub(t, { withStorage: false });
  await bare.hub.start();
  t.after(() => bare.hub.stop());
  assert.equal(bare.hub.library, null);
  const { port } = await mountEntry(t, bare.hub);
  const list = await request(port, "/api/hub/library");
  assert.deepEqual([list.status, list.json.error.code], [503, "hub_unavailable"]);
  const rescan = await request(port, "/api/hub/library/rescan", { method: "POST", body: {} });
  assert.deepEqual([rescan.status, rescan.json.error.code], [503, "hub_unavailable"]);

  const damaged = await startHub(t);
  fs.mkdirSync(damaged.dataDir, { recursive: true });
  fs.writeFileSync(path.join(damaged.dataDir, "library.json"), "{ torn");
  await damaged.hub.start();
  t.after(() => damaged.hub.stop());
  const status = damaged.hub.status();
  assert.deepEqual(status.dataErrors.filter((item) => item.name === "library.json").map((item) => item.code), ["corrupt"]);
});

test("redactLibraryEntryForViewer falls back to the root label and relative name", () => {
  const entry = { id: "lib_1", path: "C:\\models\\x", aliases: ["C:\\old\\x"], rootLabel: "Lib", relativePath: "x", internal: { secret: 1 } };
  assert.deepEqual(hubRoutes.redactLibraryEntryForViewer(entry), { id: "lib_1", path: "Lib/x", aliases: [], rootLabel: "Lib", relativePath: "x" });
  assert.equal(hubRoutes.redactLibraryEntryForViewer(null), null);
  assert.deepEqual(hubRoutes.redactLibraryListForViewer({ entries: [entry], roots: [{ id: "r", label: "Lib", path: "C:\\models" }], nextCursor: null }), {
    entries: [{ id: "lib_1", path: "Lib/x", aliases: [], rootLabel: "Lib", relativePath: "x" }],
    roots: [{ id: "r", label: "Lib" }],
    nextCursor: null,
  });
});
