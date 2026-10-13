const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createModelFilesystemStore } = require("../model-filesystem-store");
const { inspectDownloadResume } = require("../download-resume-check");

// Storage roots are temp dirs whose names avoid the ignored "models/" name.
function makeTree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "disk-roots-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const legacy = path.join(base, "lib-legacy");
  const main = path.join(base, "lib-main");
  const single = path.join(base, "single-model");
  const hfCache = path.join(base, "hf-home");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(path.join(main, "org__alpha"), { recursive: true });
  fs.writeFileSync(path.join(main, "org__alpha", "config.json"), "{}");
  fs.writeFileSync(path.join(main, "org__alpha", "model.safetensors"), Buffer.alloc(4096));
  fs.mkdirSync(path.join(main, "org__beta", ".cache", "huggingface", "download"), { recursive: true });
  fs.writeFileSync(path.join(main, "org__beta", "config.json"), "{}");
  fs.writeFileSync(path.join(main, "org__beta", ".cache", "huggingface", "download", "model.safetensors.abc.incomplete"), Buffer.alloc(1024));
  fs.mkdirSync(single, { recursive: true });
  fs.writeFileSync(path.join(single, "config.json"), "{}");
  fs.writeFileSync(path.join(single, "weights.gguf"), Buffer.alloc(2048));
  return { base, legacy, main, single, hfCache };
}

test("disk usage lists every storage root, default first, and tags models with rootId", async (t) => {
  const tree = makeTree(t);
  const store = createModelFilesystemStore({
    modelsRoot: tree.legacy,
    hfCache: tree.hfCache,
    listRoots: () => [
      { id: "legacy", path: tree.legacy, label: "原模型库", default: false, legacy: true },
      { id: "main", path: tree.main, label: "模型库", default: true, legacy: false },
    ],
  });
  const usage = await store.getDiskUsage();
  assert.equal(usage.ok, true);
  assert.deepEqual(usage.roots.map((root) => root.id), ["main", "legacy"], "default root first");
  const [main, legacy] = usage.roots;
  assert.equal(main.default, true);
  assert.equal(main.legacy, false);
  assert.equal(main.label, "模型库");
  assert.equal(main.modelCount, 2);
  assert.equal(main.usedByModelsBytes, 4096 + 2 + 2 + 1024);
  assert.equal(main.incompleteFiles, 1);
  assert.ok(main.freeBytes > 0 && main.totalBytes >= main.freeBytes);

  // An empty legacy root is still listed.
  assert.equal(legacy.default, false);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.modelCount, 0);
  assert.equal(legacy.usedByModelsBytes, 0);

  assert.deepEqual(usage.models.map((model) => [model.name, model.rootId]).sort(), [["org__alpha", "main"], ["org__beta", "main"]]);
  const beta = usage.models.find((model) => model.name === "org__beta");
  assert.equal(beta.incomplete, true);
  assert.equal(beta.sizeBytes, beta.bytes);
  assert.equal(beta.incompleteFiles, 1);

  // Legacy top-level fields describe the default root.
  assert.equal(usage.root, tree.main);
  assert.equal(usage.modelsBytes, main.usedByModelsBytes);
  assert.equal(usage.incompleteFiles, main.incompleteFiles);
  assert.equal(usage.incompleteBytes, main.incompleteBytes);
  assert.deepEqual(Object.keys(usage.disk).sort(), ["freeBytes", "totalBytes"]);
  assert.equal(usage.disk.totalBytes, main.totalBytes);
  assert.ok(usage.hfCache && usage.updatedAt);
  assert.equal(Object.hasOwn(usage, "volumes"), false);
});

test("without listRoots the legacy models root is the only, default root", async (t) => {
  const tree = makeTree(t);
  const store = createModelFilesystemStore({ modelsRoot: tree.main, hfCache: tree.hfCache });
  const usage = await store.getDiskUsage();
  assert.equal(usage.root, tree.main);
  assert.equal(usage.roots.length, 1);
  assert.equal(usage.roots[0].id, "legacy");
  assert.equal(usage.roots[0].default, true);
  assert.equal(usage.roots[0].legacy, true);
  assert.equal(usage.models.length, 2);
  assert.ok(usage.models.every((model) => model.rootId === "legacy"));
  assert.equal(usage.modelsBytes, usage.models.reduce((sum, model) => sum + model.bytes, 0));
});

test("a single-model root counts as one model and a root without a default falls back to legacy", async (t) => {
  const tree = makeTree(t);
  const missing = path.join(tree.base, "unplugged-drive");
  const store = createModelFilesystemStore({
    modelsRoot: tree.legacy,
    hfCache: tree.hfCache,
    listRoots: async () => [
      { id: "main", path: tree.main, label: "模型库" },
      { id: "legacy", path: tree.legacy, label: "原模型库" },
      { id: "solo", path: tree.single, label: "单个模型", mode: "model" },
      { id: "gone", path: missing, label: "移动硬盘" },
      { id: "dup", path: tree.main, label: "重复登记" },
    ],
  });
  const usage = await store.getDiskUsage();
  assert.deepEqual(usage.roots.map((root) => root.id), ["legacy", "main", "solo", "gone"]);
  assert.equal(usage.roots[0].default, true);
  assert.equal(usage.root, tree.legacy);
  assert.equal(usage.modelsBytes, 0);
  const solo = usage.roots.find((root) => root.id === "solo");
  assert.equal(solo.modelCount, 1);
  assert.ok(usage.models.some((model) => model.rootId === "solo" && model.name === "single-model" && model.path === tree.single));
  const gone = usage.roots.find((root) => root.id === "gone");
  assert.equal(gone.available, false);
  assert.equal(gone.freeBytes, null);
  assert.equal(gone.modelCount, 0);
  assert.equal(fs.existsSync(missing), false, "an unavailable root is reported, never created");
});

test("the resume check measures the disk of the job's own directory when diskFreeBytes is omitted", async (t) => {
  const tree = makeTree(t);
  const jobDir = path.join(tree.main, "org__beta");
  const seen = [];
  const statfs = async (target) => {
    seen.push(target);
    return { bavail: 1000, bsize: 1024 * 1024 * 1024, blocks: 2000 };
  };
  const measured = await inspectDownloadResume({ localDir: jobDir, fileManifest: [], statfs });
  assert.deepEqual(seen, [tree.main], "statfs runs on the job directory's parent");
  assert.equal(measured.diskFreeBytes, 1000 * 1024 ** 3);

  // A deleted job directory under an unplugged root walks up to an existing ancestor.
  seen.length = 0;
  const gone = await inspectDownloadResume({
    localDir: path.join(tree.base, "unplugged", "org__x"),
    fileManifest: [{ name: "model.safetensors", size: 10 }],
    statfs: async (target) => {
      seen.push(target);
      if (!fs.existsSync(target)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { bavail: 5, bsize: 1024 ** 3 };
    },
  });
  assert.deepEqual(seen, [path.join(tree.base, "unplugged"), tree.base]);
  assert.equal(gone.diskFreeBytes, 5 * 1024 ** 3);

  // Callers that pass diskFreeBytes explicitly are unchanged, including null.
  const explicit = await inspectDownloadResume({ localDir: jobDir, fileManifest: [], diskFreeBytes: 123, statfs: () => assert.fail("no measurement") });
  assert.equal(explicit.diskFreeBytes, 123);
  const unknown = await inspectDownloadResume({ localDir: jobDir, fileManifest: [], diskFreeBytes: null, statfs: () => assert.fail("no measurement") });
  assert.equal(unknown.diskFreeBytes, null);

  // Without an injected statfs the real disk is measured.
  const real = await inspectDownloadResume({ localDir: jobDir, fileManifest: [] });
  assert.ok(real.diskFreeBytes > 0);
});
