"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createModelStorage, createModelMigration, createModelFilesystemStore, assertDownloadDiskSpace, createDownloadJobController } = require("..");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "platform-storage-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const primary = path.join(dir, "primary"), secondary = path.join(dir, "second disk 模型");
  await fs.mkdir(primary); await fs.mkdir(secondary);
  const opts = { modelsRoot: primary, file: path.join(dir, "state/storage.json") };
  const storage = createModelStorage(opts), root = storage.registerRoot({ path: secondary, makeDefault: true });
  const migration = createModelMigration({ storage, getBusyPaths: async () => [], reserveBytes: 0 });
  const source = path.join(primary, "small-model"); await fs.mkdir(source);
  await fs.writeFile(path.join(source, "model.bin"), Buffer.alloc(128 * 1024, 73));
  await fs.writeFile(path.join(source, "config.json"), '{"model_type":"qwen2"}');
  return { dir, primary, secondary, opts, storage, root, migration, source };
}
async function settle(migration, id) {
  for (let i = 0; i < 300; i++) { const j = migration.get(id); if (!["copying", "verifying", "publishing", "cleaning"].includes(j.state)) return j; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("migration timeout");
}

test("two managers share libraries and defaults; root escapes and nested junctions are refused", async t => {
  const x = await fixture(t), other = createModelStorage(x.opts);
  assert.equal(other.downloadTarget("", "new-model"), path.join(x.secondary, "new-model"));
  assert.throws(() => other.resolvePath(x.dir), /已登记/);
  assert.throws(() => other.downloadTarget(x.root.id, "../private"), /无效/);
  assert.throws(() => other.registerRoot({ path: x.source }), /重叠/);
  const nestedNew = path.join(x.primary, "must-not-create");
  assert.throws(() => other.registerRoot({ path: nestedNew, create: true }), /重叠/);
  await assert.rejects(fs.access(nestedNew), { code: "ENOENT" });
  const external = path.join(x.dir, "unmanaged"); await fs.mkdir(external);
  await fs.symlink(external, path.join(x.primary, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => other.resolvePath(path.join(x.primary, "escape/file.bin")), /库外/);
});

test("registered roots and individual imports appear with unique IDs and Docker mount mappings", async t => {
  const x = await fixture(t), duplicate = path.join(x.secondary, "small-model");
  await fs.mkdir(duplicate); await fs.writeFile(path.join(duplicate, "model.bin"), "second");
  const imported = path.join(x.dir, "individual"); await fs.mkdir(imported); await fs.writeFile(path.join(imported, "config.json"), "{}");
  const direct = x.storage.registerRoot({ path: imported, mode: "model" });
  const modelStore = createModelFilesystemStore({ modelsRoot: x.primary, hfCache: path.join(x.dir, "cache"), storage: x.storage });
  const models = await modelStore.listLocalModels();
  assert.equal(models.length, 3); assert.equal(new Set(models.map(m => m.id)).size, 3);
  assert.equal(x.storage.toContainerPath(path.join(duplicate, "model.bin")), `/model-storage/${x.root.id}/small-model/model.bin`);
  assert.equal(x.storage.toContainerPath(imported), `/model-storage/${direct.id}`);
  assert.ok(x.storage.dockerMountArgs().includes(`${x.secondary}:/model-storage/${x.root.id}`));
  await fs.rename(x.secondary, `${x.secondary}-offline`);
  assert.equal((await modelStore.listLocalModels()).length, 2);
  assert.equal((await x.storage.snapshot()).roots.find(r => r.id === x.root.id).online, false);
});

test("copy verification publishes a new location, redirects old paths, and keeps the source until separately confirmed", async t => {
  const x = await fixture(t), p = await x.migration.plan({ source: x.source, storageId: x.root.id });
  assert.equal(p.fileCount, 2); assert.equal(p.sourceWillBePreserved, true);
  await x.migration.start(p.id); const done = await settle(x.migration, p.id);
  assert.equal(done.state, "completed", done.error);
  assert.deepEqual(await fs.readFile(path.join(x.source, "model.bin")), await fs.readFile(path.join(p.target, "model.bin")));
  assert.equal(x.storage.resolvePath(path.join(x.source, "config.json")), path.join(p.target, "config.json"));
  const restarted = createModelStorage(x.opts);
  assert.equal(restarted.resolvePath(x.source), p.target);
  assert.equal(restarted.toContainerPath(x.source), `/model-storage/${x.root.id}/small-model`);
  const modelStore = createModelFilesystemStore({ modelsRoot: x.primary, hfCache: path.join(x.dir, "cache"), storage: restarted });
  assert.deepEqual((await modelStore.listLocalModels()).map(m => m.path), [p.target]);
  await assert.rejects(x.migration.cleanupSource(p.id, "incorrect"), /明确确认/);
  await fs.access(path.join(x.source, "model.bin"));
  await x.migration.cleanupSource(p.id, x.source);
  assert.equal((await settle(x.migration, p.id)).sourceRemoved, true);
  await assert.rejects(fs.access(x.source)); await fs.access(path.join(p.target, "model.bin"));
});

test("rollback restores the old launch location and retains both copies", async t => {
  const x = await fixture(t), p = await x.migration.plan({ source: x.source, storageId: x.root.id });
  await x.migration.start(p.id); assert.equal((await settle(x.migration, p.id)).state, "completed");
  await x.migration.rollback(p.id); assert.equal(x.storage.resolvePath(x.source), x.source);
  await fs.access(path.join(p.target, "model.bin")); await fs.access(path.join(x.source, "model.bin"));
});

test("a changed source or occupied destination cannot overwrite data or switch launch paths", async t => {
  const x = await fixture(t), p = await x.migration.plan({ source: x.source, storageId: x.root.id });
  await fs.writeFile(path.join(x.source, "new-user-data.txt"), "keep");
  await x.migration.start(p.id); const failed = await settle(x.migration, p.id);
  assert.equal(failed.state, "failed"); assert.match(failed.error, /发生变化/); assert.equal(x.storage.resolvePath(x.source), x.source);
  await fs.mkdir(p.target); await fs.writeFile(path.join(p.target, "private.txt"), "unrelated");
  await assert.rejects(x.migration.plan({ source: x.source, storageId: x.root.id }), /已经存在/);
  assert.equal(await fs.readFile(path.join(p.target, "private.txt"), "utf8"), "unrelated");
});

test("corrupted destination refuses source cleanup before deleting any file", async t => {
  const x = await fixture(t), p = await x.migration.plan({ source: x.source, storageId: x.root.id });
  await x.migration.start(p.id); await settle(x.migration, p.id);
  await fs.writeFile(path.join(p.target, "model.bin"), "broken");
  await x.migration.cleanupSource(p.id, x.source); const result = await settle(x.migration, p.id);
  assert.equal(result.state, "cleanup_failed"); assert.match(result.error, /校验不一致/);
  assert.equal((await fs.stat(path.join(x.source, "model.bin"))).size, 128 * 1024);
  await fs.access(path.join(x.source, "config.json"));
  await fs.copyFile(path.join(x.source, "model.bin"), path.join(p.target, "model.bin"));
  await x.migration.cleanupSource(p.id, x.source);
  assert.equal((await settle(x.migration, p.id)).sourceRemoved, true);
});

test("shared operation leases prevent a second manager from downloading or launching a migrating model", async t => {
  const x = await fixture(t), other = createModelStorage(x.opts);
  const lease = x.storage.acquireOperation([x.source], "migration");
  assert.throws(() => other.acquireOperation([x.source], "download"), /正在迁移/);
  assert.throws(() => other.toContainerPath(path.join(x.source, "model.bin")), /正在迁移/);
  await assert.rejects(x.migration.plan({ source: x.source, storageId: x.root.id }), /正在迁移/);
  x.storage.releaseOperation(lease);
  assert.equal(other.toContainerPath(x.source), "/models/small-model");
});

test("new downloads refuse an unrelated populated folder and never treat a full disk as unknown", async t => {
  const x = await fixture(t);
  assert.throws(() => x.storage.prepareDownload(x.source, { model: "new/repo", source: "huggingface", precision: "" }), /阻止覆盖/);
  const target = x.storage.downloadTarget(x.root.id, "fresh");
  x.storage.prepareDownload(target, { model: "new/repo", source: "huggingface", precision: "" });
  await fs.writeFile(path.join(target, "model.bin"), "partial");
  x.storage.prepareDownload(target, { model: "new/repo", source: "huggingface", precision: "" });
  assert.throws(() => x.storage.prepareDownload(target, { model: "different/repo", source: "huggingface", precision: "" }), /阻止覆盖/);
  assert.throws(() => assertDownloadDiskSpace(1, 0), /空间不足/);
});

test("cancelling a paused download preserves existing files", async () => {
  let removed = false;
  const job = { id: "paused", type: "download", status: "paused", meta: { localDir: "D:/existing-model" } };
  const controller = createDownloadJobController({ jobs: new Map([[job.id, job]]), createJob() {}, spawnJobProcess() {}, buildDownloadSpecFromJob() {}, appendLog() {}, stopProgressTracker() {}, removePartialPath: async () => { removed = true; } });
  await controller.cancelDownloadJob(job); assert.equal(job.status, "cancelled"); assert.equal(removed, false);
});

test("two managers cannot run the same migration ID simultaneously", async t => {
  const x = await fixture(t), other = createModelStorage(x.opts);
  const id = x.storage.acquireOperation([x.source], "migration");
  assert.throws(() => other.acquireOperation([x.source], "migration", id), /已在另一个/);
  x.storage.releaseOperation(id);
});

test("a nested junction inserted into staging blocks resume and preserves the external folder", async t => {
  const x = await fixture(t), p = await x.migration.plan({ source: x.source, storageId: x.root.id });
  const stage = path.join(x.secondary, `.model-migration-${p.id}`), external = path.join(x.dir, "external");
  await fs.mkdir(stage); await fs.mkdir(external);
  await fs.writeFile(path.join(external, "keep.txt"), "keep");
  await fs.symlink(external, path.join(stage, "nested"), process.platform === "win32" ? "junction" : "dir");
  await x.migration.start(p.id);
  assert.match((await settle(x.migration, p.id)).error, /链接/);
  assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "keep");
  await fs.access(path.join(x.source, "model.bin"));
});

test("successive migrations keep old launch paths and can release both original copies", async t => {
  const x = await fixture(t), first = await x.migration.plan({ source: x.source, storageId: x.root.id });
  await x.migration.start(first.id); assert.equal((await settle(x.migration, first.id)).state, "completed");
  const second = await x.migration.plan({ source: first.target, storageId: "legacy", outputName: "third-location" });
  await x.migration.start(second.id); assert.equal((await settle(x.migration, second.id)).state, "completed");
  assert.equal(x.storage.resolvePath(x.source), second.target);
  await assert.rejects(x.migration.rollback(first.id), /最新一轮/);
  await x.migration.cleanupSource(second.id, first.target);
  assert.equal((await settle(x.migration, second.id)).sourceRemoved, true);
  await x.migration.cleanupSource(first.id, x.source);
  assert.equal((await settle(x.migration, first.id)).sourceRemoved, true);
  await fs.access(path.join(second.target, "model.bin"));
  assert.equal(x.storage.resolvePath(x.source), second.target);
});

test("cleanup interrupted by a manager restart can verify the destination and finish safely", async t => {
  const x = await fixture(t), p = await x.migration.plan({ source: x.source, storageId: x.root.id });
  await x.migration.start(p.id); assert.equal((await settle(x.migration, p.id)).state, "completed");
  await fs.unlink(path.join(x.source, "config.json"));
  const recordFile = path.join(x.migration.jobDir, `${p.id}.json`);
  const record = JSON.parse(await fs.readFile(recordFile, "utf8")); record.state = "cleaning";
  await fs.writeFile(recordFile, JSON.stringify(record));
  const restarted = createModelMigration({ storage: createModelStorage(x.opts), reserveBytes: 0, getBusyPaths: async () => [] });
  assert.equal(restarted.get(p.id).state, "cleanup_failed");
  await restarted.cleanupSource(p.id, x.source);
  assert.equal((await settle(restarted, p.id)).sourceRemoved, true);
  await fs.access(path.join(p.target, "model.bin"));
});
