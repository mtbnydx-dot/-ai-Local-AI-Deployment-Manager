"use strict";

// Model hub library registry (docs/overhaul/03-hub.md §9, HUB-8): scans of the
// registered roots, the HF cache and the ModelScope cache; the provenance
// precedence; ids that survive a migration alias; duplicate links; library
// events through events.publish; rescan, verify and identify. Everything is
// built in temp directories from small synthetic files; no network, no real
// AI_ROOT. Ledgers, markers and .metadata files are written by the helpers
// below in the shapes the managers and the hf CLI write them.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createModelFilesystemStore } = require("../model-filesystem-store");
const { createModelStorage } = require("../model-storage");
const { createHubStore } = require("../model-hub/store");
const { createLibrary, computeFilesetHash, deriveProvenance, identityKeyFor, repoCandidatesFromName, scrubPaths } = require("../model-hub/library");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const FIXED_NOW = Date.parse("2026-10-14T08:00:00.000Z");

function tempDir(t, prefix = "hub-library-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLogger() {
  const lines = [];
  return { lines, log: () => {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
}

function sha256Of(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// A syntactically valid safetensors file (8-byte header length, "{}", padding)
// whose content differs per `seed`.
function safetensorsBytes(size, seed = "x") {
  const buffer = Buffer.alloc(size, seed);
  buffer.writeBigUInt64LE(2n, 0);
  buffer.write("{}", 8, "latin1");
  return buffer;
}

function ggufBytes(size, seed = "g") {
  const buffer = Buffer.alloc(size, seed);
  buffer.write("GGUF", 0, "latin1");
  return buffer;
}

function put(dir, rel, content) {
  const file = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function putJson(dir, rel, value) {
  return put(dir, rel, JSON.stringify(value, null, 2));
}

// config + tokenizer + weights: a folder the structure check calls ok.
function makeModel(dir, { weights = { "model.safetensors": 4096 }, config = { model_type: "llama" }, seed = "x" } = {}) {
  const built = {};
  putJson(dir, "config.json", config);
  putJson(dir, "tokenizer.json", { version: "1.0" });
  for (const [name, size] of Object.entries(weights)) {
    const bytes = name.endsWith(".gguf") ? ggufBytes(size, seed) : safetensorsBytes(size, seed);
    put(dir, name, bytes);
    built[name] = { size, sha256: sha256Of(bytes) };
  }
  return built;
}

function markerV2(dir, fields) {
  putJson(dir, ".platform-download.json", {
    schemaVersion: 2, source: "huggingface", provider: "huggingface", transport: "huggingface", createdAt: "2026-10-01T00:00:00.000Z", ...fields,
  });
}

// hf download --local-dir metadata: commit sha, etag, timestamp.
function hfMetadata(dir, rel, sha, etag) {
  put(dir, `.cache/huggingface/download/${rel}.metadata`, `${sha}\n${etag}\n1759276800.0\n`);
}

function ledgerJob(localDir, meta = {}, extra = {}) {
  return {
    id: crypto.randomUUID(), type: "download", status: "success", createdAt: "2026-09-01T10:00:00.000Z", finishedAt: "2026-09-01T11:00:00.000Z",
    meta: { model: "ledger/Repo", source: "huggingface", precision: "Q8_0", localDir, ...meta }, ...extra,
  };
}

function writeLedger(aiRoot, manager, jobs) {
  putJson(path.join(aiRoot, `${manager}-manager`, "logs"), "jobs-ledger.json", { jobs });
}

// A Hugging Face cache repo: blobs/<etag>, snapshots/<sha>/<file> as links to
// them (copies where the OS refuses symbolic links), refs/main.
function makeHfCacheRepo(hfHome, repo, sha, files) {
  const repoDir = path.join(hfHome, "hub", `models--${repo.replace("/", "--")}`);
  let linked = true;
  put(repoDir, "refs/main", sha);
  for (const [name, bytes] of Object.entries(files)) {
    const etag = /\.(safetensors|gguf|bin)$/.test(name) ? sha256Of(bytes) : crypto.createHash("sha1").update(bytes).digest("hex");
    const blob = put(repoDir, `blobs/${etag}`, bytes);
    const link = path.join(repoDir, "snapshots", sha, ...name.split("/"));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try {
      fs.symlinkSync(path.relative(path.dirname(link), blob), link, "file");
    } catch {
      fs.copyFileSync(blob, link);
      linked = false;
    }
  }
  return { repoDir, linked };
}

function eventRecorder() {
  const list = [];
  return {
    list,
    publish(type, payload) {
      list.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    },
    changed() {
      return list.filter((item) => item.type === "library" && item.payload.kind === "changed").flatMap((item) => item.payload.entryIds);
    },
    clear() {
      list.length = 0;
    },
  };
}

async function waitTask(library, taskId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = library.getTask(taskId);
    if (task && (task.state === "succeeded" || task.state === "failed")) return task;
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not finish: ${JSON.stringify(task)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A world: legacy root <root>/models, a second library root <root>/libF, the
// HF home <root>/cache/huggingface, ledgers under <root>/<manager>-manager.
function makeWorld(t, options = {}) {
  const root = fs.realpathSync(tempDir(t));
  const modelsRoot = path.join(root, "models");
  const libF = path.join(root, "libF");
  const hfHome = path.join(root, "cache", "huggingface");
  fs.mkdirSync(modelsRoot, { recursive: true });
  fs.mkdirSync(libF, { recursive: true });
  fs.mkdirSync(hfHome, { recursive: true });
  const dataDir = path.join(root, "service-entry", "data", "hub");
  const storage = createModelStorage({ modelsRoot, file: path.join(root, "service-entry", "data", "model-storage.json") });
  storage.registerRoot({ path: libF, label: "Library F" });
  const fsStore = createModelFilesystemStore({ storage, modelsRoot, hfCache: hfHome, listRoots: () => storage.roots() });
  const events = eventRecorder();
  const logger = quietLogger();
  const store = createHubStore({ dataDir });
  const world = { root, modelsRoot, libF, hfHome, dataDir, storage, fsStore, events, logger, store, library: null, libraryOptions: options };
  world.open = async (extra = {}) => {
    await store.init();
    world.library = createLibrary({
      store, modelStorage: storage, fsStore, hfHome, events, aiRoot: root, logger, watchMs: 0, clock: { now: () => FIXED_NOW }, ...options, ...extra,
    });
    world.library.start();
    return world.library;
  };
  world.scan = async (rootIds) => {
    const { taskId } = await world.library.rescan(rootIds ? { rootIds } : {});
    const task = await waitTask(world.library, taskId);
    assert.equal(task.state, "succeeded", JSON.stringify(task.error));
    return task;
  };
  world.byName = (name) => world.library.list({}).then((result) => result.entries.find((entry) => entry.relativePath === name || entry.displayName === name));
  t.after(async () => {
    await world.library?.stop();
    await store.flush();
  });
  return world;
}

// --- pure helpers ----------------------------------------------------------------

test("the fileset hash is order independent and the identity key shares hf between huggingface and hf-mirror", () => {
  const files = [{ path: "b.gguf", size: 2, sha256: "1".repeat(64), gitOid: null }, { path: "a.json", size: 1, sha256: null, gitOid: SHA_A }, { path: "c.txt", size: 3, sha256: null, gitOid: null }];
  assert.equal(computeFilesetHash(files), computeFilesetHash([...files].reverse()));
  assert.notEqual(computeFilesetHash(files), computeFilesetHash(files.map((file) => ({ ...file, size: file.size + 1 }))));
  const hash = computeFilesetHash(files);
  const base = { repo: "Qwen/Qwen3-8B", revisionSha: SHA_A, confidence: "declared" };
  assert.equal(identityKeyFor({ ...base, provider: "huggingface" }, hash), `hf:qwen/qwen3-8b@${SHA_A}#${hash}`);
  assert.equal(identityKeyFor({ ...base, provider: "hf-mirror" }, hash), identityKeyFor({ ...base, provider: "huggingface" }, hash));
  assert.equal(identityKeyFor({ ...base, provider: "modelscope" }, hash), `ms:qwen/qwen3-8b@${SHA_A}#${hash}`);
  assert.equal(identityKeyFor({ ...base, provider: "huggingface", confidence: "unverified" }, hash), null, "a guess does not make an identity");
  assert.equal(identityKeyFor({ ...base, revisionSha: null }, hash), null);
});

test("deriveProvenance: first source wins per field, a contradicting repo skips the whole record, guesses stay unverified", () => {
  const job = { source: "hub-job", confidence: "declared", fields: { provider: "huggingface", repo: "acme/Model", quant: "Q4_K_M", revisionSha: null } };
  const marker = { source: "platform-marker", confidence: "declared", fields: { provider: "huggingface", repo: "acme/model", revision: "main", quant: "Q8_0", revisionSha: SHA_A } };
  const stranger = { source: "legacy-ledger", confidence: "declared", fields: { provider: "modelscope", repo: "other/Thing", revisionSha: SHA_B, downloadedAt: "2026-01-01T00:00:00.000Z" } };
  const merged = deriveProvenance({ job, marker, ledger: stranger });
  assert.equal(merged.provenance.repo, "acme/Model");
  assert.equal(merged.provenance.source, "hub-job");
  assert.equal(merged.quant, "Q4_K_M");
  assert.equal(merged.provenance.revisionSha, SHA_A, "a field the job lacks comes from the next source");
  assert.equal(merged.provenance.fieldSources.revisionSha, "platform-marker");
  assert.equal(merged.provenance.downloadedAt, null, "the contradicting ledger record is skipped whole");
  assert.equal(merged.provenance.provider, "huggingface");

  const guess = deriveProvenance({ metadata: { source: "hf-local-metadata", confidence: "unverified", fields: { provider: "huggingface", revisionSha: SHA_C }, repoCandidates: ["acme/tiny-lm", "acme-tiny/lm"] } });
  assert.deepEqual([guess.provenance.repo, guess.provenance.confidence, guess.provenance.source, guess.provenance.revisionSha], ["acme/tiny-lm", "unverified", "hf-local-metadata", SHA_C]);
  assert.deepEqual(guess.provenance.candidates, ["acme/tiny-lm", "acme-tiny/lm"]);

  const nothing = deriveProvenance({});
  assert.deepEqual([nothing.provenance.repo, nothing.provenance.confidence, nothing.provenance.source], [null, "unknown", null]);
});

test("repoCandidatesFromName offers owner__name first, then each dash split", () => {
  assert.equal(repoCandidatesFromName("Qwen__Qwen3-8B")[0], "Qwen/Qwen3-8B");
  assert.deepEqual(repoCandidatesFromName("unsloth-Qwen3-8B-GGUF").slice(0, 2), ["unsloth/Qwen3-8B-GGUF", "unsloth-Qwen3/8B-GGUF"]);
  assert.deepEqual(repoCandidatesFromName("plain"), []);
  assert.equal(scrubPaths("failed at D:\\models\\x\\a.gguf and /srv/models/x/a.gguf here"), "failed at <path> and <path> here");
});

// --- scanning ------------------------------------------------------------------------

test("a scan lists the registered roots, the HF cache and the ModelScope cache with format, quant, bytes and roles", async (t) => {
  const world = makeWorld(t);
  const { modelsRoot, libF, hfHome } = world;
  makeModel(path.join(modelsRoot, "Qwen-Qwen3-8B-FP8"), {
    weights: { "model-00001-of-00002.safetensors": 4096, "model-00002-of-00002.safetensors": 2048 },
    config: { model_type: "qwen3", quantization_config: { quant_method: "fp8" } },
  });
  makeModel(path.join(modelsRoot, "unsloth-Qwen3-8B-GGUF"), { weights: { "Qwen3-8B-Q4_K_M.gguf": 3000 } });
  makeModel(path.join(libF, "Other-Model"), { weights: { "pytorch_model.bin": 1024 }, config: { model_type: "llama", torch_dtype: "bfloat16" } });
  put(path.join(modelsRoot, "scripts-only"), "convert.py", "print('x')\n");
  put(path.join(modelsRoot, "notes"), "README.md", "# no model here\n");
  makeModel(path.join(modelsRoot, ".hidden-model"));
  put(modelsRoot, "loose-Q5_K_M.gguf", ggufBytes(2500));
  put(modelsRoot, "readme.txt", "ignored");
  const cache = makeHfCacheRepo(hfHome, "acme/cached-model", SHA_A, {
    "config.json": Buffer.from("{\"model_type\":\"llama\"}"),
    "model.safetensors": safetensorsBytes(5000, "c"),
  });
  put(path.join(hfHome, "modelscope", "models", "ms-org", "ms___model"), "config.json", "{\"model_type\":\"llama\"}");
  put(path.join(hfHome, "modelscope", "models", "ms-org", "ms___model"), "model.safetensors", safetensorsBytes(1500, "m"));
  put(path.join(hfHome, "modelscope", "models", "ms-org", "ms___model"), ".msc", "bookkeeping");

  const library = await world.open();
  await world.scan();
  const { entries, roots, nextCursor, total } = await library.list({});
  assert.equal(nextCursor, null);
  assert.equal(total, entries.length);
  const byName = Object.fromEntries(entries.map((entry) => [entry.relativePath, entry]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "Other-Model", "Qwen-Qwen3-8B-FP8", "loose-Q5_K_M.gguf", "models--acme--cached-model", "ms-org/ms___model", "scripts-only", "unsloth-Qwen3-8B-GGUF",
  ].sort());

  const qwen = byName["Qwen-Qwen3-8B-FP8"];
  assert.match(qwen.id, /^lib_[0-9a-f]{16}$/);
  const qwenBytes = ["model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors", "config.json", "tokenizer.json"].reduce((sum, name) => sum + fs.statSync(path.join(modelsRoot, "Qwen-Qwen3-8B-FP8", name)).size, 0);
  assert.deepEqual([qwen.kind, qwen.format, qwen.quant, qwen.bytes, qwen.rootId, qwen.rootLabel, qwen.runnable], ["folder", "safetensors", "FP8", qwenBytes, "legacy", "原模型库", true]);
  assert.equal(qwen.fileCount, 4, "two shards, config.json and tokenizer.json");
  assert.equal(qwen.path, path.join(modelsRoot, "Qwen-Qwen3-8B-FP8"));
  assert.equal(qwen.displayPath, "原模型库/Qwen-Qwen3-8B-FP8");
  assert.equal(qwen.provenance.confidence, "unknown");
  assert.equal(qwen.internal, undefined, "internal state never reaches the API");

  const gguf = byName["unsloth-Qwen3-8B-GGUF"];
  assert.deepEqual([gguf.format, gguf.quant], ["gguf", "Q4_K_M"]);
  const other = byName["Other-Model"];
  assert.deepEqual([other.rootId, other.rootLabel, other.format, other.quant], [roots.find((root) => root.label === "Library F").id, "Library F", "pytorch", "BF16"]);
  const single = byName["loose-Q5_K_M.gguf"];
  assert.deepEqual([single.kind, single.format, single.quant, single.bytes, single.fileCount], ["single-file", "gguf", "Q5_K_M", 2500, 1]);
  const tooling = byName["scripts-only"];
  assert.deepEqual([tooling.card.role, tooling.runnable, tooling.format], ["tooling-only", false, null]);

  const hf = byName["models--acme--cached-model"];
  assert.deepEqual([hf.kind, hf.rootId, hf.rootLabel, hf.displayName], ["hf-cache-repo", null, "Hugging Face cache", "cached-model"]);
  assert.deepEqual(hf.cache.snapshots.map((item) => [item.sha, item.files]), [[SHA_A, 2]]);
  assert.equal(hf.cache.refs.main, SHA_A);
  assert.equal(hf.format, "safetensors");
  if (cache.linked) assert.equal(hf.bytes, 5000 + 22, "linked snapshot files are counted once, through their blobs");
  const ms = byName["ms-org/ms___model"];
  assert.deepEqual([ms.kind, ms.rootLabel, ms.provenance.repo, ms.provenance.provider, ms.fileCount], ["modelscope-cache", "ModelScope cache", "ms-org/ms.model", "modelscope", 2], ".msc is bookkeeping, not payload");

  assert.deepEqual(roots.map((root) => [root.label, root.default, root.entryCount]), [["原模型库", true, 4], ["Library F", false, 1], ["Hugging Face cache", false, 1], ["ModelScope cache", false, 1]]);
  assert.equal((await library.list({ rootId: "hf-cache" })).entries.length, 1);
  assert.equal((await library.list({ format: "gguf" })).total, 2);
  assert.equal((await library.list({ q: "qwen3" })).total, 2);
  assert.equal((await library.list({ limit: 2 })).entries.length, 2);
  const second = await library.list({ limit: 5, cursor: (await library.list({ limit: 5 })).nextCursor });
  assert.equal(second.entries.length, 2);
  await assert.rejects(library.list({ cursor: "###" }), { code: "invalid_cursor" });
  await assert.rejects(library.list({ provenance: "bogus" }), { code: "invalid_request" });
});

test("a retired path and a root that is offline are not scanned, and an offline root keeps its entries", async (t) => {
  const world = makeWorld(t);
  makeModel(path.join(world.libF, "stay"));
  makeModel(path.join(world.modelsRoot, "also"));
  const library = await world.open();
  await world.scan();
  assert.equal((await library.list({})).total, 2);
  fs.renameSync(world.libF, `${world.libF}-away`);
  await world.scan();
  const after = await library.list({});
  assert.deepEqual(after.entries.map((entry) => entry.relativePath).sort(), ["also", "stay"], "the offline root's entry is kept until the root returns");
  assert.equal(after.roots.find((root) => root.label === "Library F").online, false);
  fs.renameSync(`${world.libF}-away`, world.libF);
  fs.rmSync(path.join(world.libF, "stay"), { recursive: true });
  await world.scan();
  assert.deepEqual((await library.list({})).entries.map((entry) => entry.relativePath), ["also"]);
});

test("scans are incremental: an unchanged folder is not reported, a changed or removed one is", async (t) => {
  const world = makeWorld(t);
  const keep = path.join(world.modelsRoot, "keep");
  const edit = path.join(world.modelsRoot, "edit");
  const gone = path.join(world.modelsRoot, "gone");
  for (const dir of [keep, edit, gone]) makeModel(dir);
  const library = await world.open();
  await world.scan();
  const ids = Object.fromEntries((await library.list({})).entries.map((entry) => [entry.relativePath, entry.id]));
  assert.deepEqual(world.events.changed().sort(), Object.values(ids).sort(), "the first scan reports every entry once");
  assert.ok(world.events.list.every((item) => item.type === "library"), "the hub publishes library events and nothing else");

  world.events.clear();
  await world.scan();
  assert.deepEqual(world.events.changed(), [], "nothing changed, nothing reported");

  put(edit, "extra.json", "{}");
  fs.rmSync(gone, { recursive: true });
  world.events.clear();
  await world.scan();
  assert.deepEqual(world.events.changed().sort(), [ids.edit, ids.gone].sort());
  assert.equal(library.get(ids.gone), null);
  assert.equal(library.get(ids.edit).fileCount, 4);
  assert.equal(library.get(ids.keep).id, ids.keep);
  const kinds = world.events.list.filter((item) => item.payload.kind === "task").map((item) => item.payload.task.state);
  assert.equal(kinds[0], "running");
  assert.equal(kinds.at(-1), "succeeded");
});

test("the registry persists to library.json and a restart keeps ids and provenance; a corrupt file is set aside", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.modelsRoot, "persist-me");
  makeModel(dir);
  markerV2(dir, { model: "acme/Persist", revisionSha: SHA_A, precision: "FP8" });
  const first = await world.open();
  await world.scan();
  const entry = (await first.list({})).entries[0];
  await first.stop();
  await world.store.flush();
  const file = path.join(world.dataDir, "library.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 1);

  const second = await world.open();
  assert.equal(second.size, 1, "the persisted registry is served before any scan");
  assert.equal(second.get(entry.id).provenance.repo, "acme/Persist");
  await world.scan();
  assert.equal((await second.list({})).entries[0].id, entry.id);
  await second.stop();

  fs.writeFileSync(file, "{ torn");
  const third = await world.open();
  assert.equal(third.size, 0);
  assert.equal(third.errors().length, 1);
  assert.equal(third.errors()[0].code, "corrupt");
  assert.ok(fs.existsSync(`${file}.corrupt`), "the unreadable file is kept");
  await world.scan();
  assert.equal(third.size, 1, "the next scan rebuilds the registry");
});

// --- provenance -----------------------------------------------------------------------

test("provenance precedence golden: job > marker v2 > marker v1 > ledger > hf metadata > cache refs", async (t) => {
  const world = makeWorld(t);
  const { modelsRoot, libF, hfHome, root } = world;

  // 1. a hub job result, also carrying a marker whose quant and revision differ
  const jobDir = path.join(modelsRoot, "from-job");
  const jobFiles = makeModel(jobDir, { weights: { "Job-Q4_K_M.gguf": 3000 } });
  markerV2(jobDir, { model: "acme/Job-GGUF", precision: "Q8_0", revision: "main", revisionSha: SHA_B });
  // 2. marker v2 alone
  const v2Dir = path.join(modelsRoot, "from-marker-v2");
  makeModel(v2Dir);
  markerV2(v2Dir, { model: "acme/Marker-V2", precision: "FP8", revision: "main", revisionSha: SHA_A, artifactKey: "st:", jobId: "dl_1", completedAt: "2026-10-02T00:00:00.000Z" });
  // 3. marker v1 (what prepareDownload wrote before the hub)
  const v1Dir = path.join(modelsRoot, "from-marker-v1");
  makeModel(v1Dir);
  putJson(v1Dir, ".platform-download.json", { model: "acme/Marker-V1", source: "modelscope", precision: "BF16", createdAt: "2026-08-01T00:00:00.000Z" });
  // 4. a legacy ledger entry for a folder with no marker
  const ledgerDir = path.join(libF, "from-ledger");
  makeModel(ledgerDir);
  writeLedger(root, "vllm", [ledgerJob(ledgerDir, { model: "acme/Ledger", precision: "Q6_K" }), ledgerJob(path.join(libF, "unrelated"), { model: "acme/Nope" })]);
  // 5. hf CLI metadata only: no repo id anywhere, the folder name supplies guesses
  const metaDir = path.join(modelsRoot, "acme__Tiny-LM");
  const metaFiles = makeModel(metaDir, { weights: { "model-00001-of-00002.safetensors": 2048, "model-00002-of-00002.safetensors": 1024 }, seed: "m" });
  hfMetadata(metaDir, "model-00001-of-00002.safetensors", SHA_C, metaFiles["model-00001-of-00002.safetensors"].sha256);
  hfMetadata(metaDir, "model-00002-of-00002.safetensors", SHA_C, metaFiles["model-00002-of-00002.safetensors"].sha256);
  hfMetadata(metaDir, "config.json", SHA_B, "d".repeat(40));
  // 6. marker names the repo, metadata supplies the revision
  const mixedDir = path.join(modelsRoot, "from-mixed");
  const mixedFiles = makeModel(mixedDir, { seed: "q" });
  markerV2(mixedDir, { model: "acme/Mixed" });
  hfMetadata(mixedDir, "model.safetensors", SHA_A, mixedFiles["model.safetensors"].sha256);
  // 7. the HF cache
  makeHfCacheRepo(hfHome, "acme/Cached", SHA_C, { "config.json": Buffer.from("{\"model_type\":\"llama\"}"), "model.safetensors": safetensorsBytes(2000, "k") });

  const library = await world.open();
  const registered = await library.registerFromJob({
    id: "dl_job1", finishedAt: "2026-10-03T00:00:00.000Z", target: { localDir: jobDir }, transfer: { options: { source: "hf-mirror" } },
    artifact: {
      provider: "huggingface", repo: "acme/Job-GGUF", revision: null, revisionSha: SHA_A, artifactKey: "gguf:|Q4_K_M", quant: "Q4_K_M",
      files: [{ path: "Job-Q4_K_M.gguf", size: 3000, sha256: jobFiles["Job-Q4_K_M.gguf"].sha256 }],
    },
  });
  assert.ok(registered.entryId);
  await world.scan();

  const { entries } = await library.list({});
  const golden = Object.fromEntries(entries.map((entry) => {
    const p = entry.provenance;
    return [entry.relativePath, { repo: p.repo, provider: p.provider, transport: p.transport, sha: p.revisionSha, quant: entry.quant, source: p.source, confidence: p.confidence, job: p.downloadJobId }];
  }));
  assert.deepEqual(golden, {
    "from-job": { repo: "acme/Job-GGUF", provider: "huggingface", transport: "hf-mirror", sha: SHA_A, quant: "Q4_K_M", source: "hub-job", confidence: "declared", job: "dl_job1" },
    "from-marker-v2": { repo: "acme/Marker-V2", provider: "huggingface", transport: "huggingface", sha: SHA_A, quant: "FP8", source: "platform-marker", confidence: "declared", job: "dl_1" },
    "from-marker-v1": { repo: "acme/Marker-V1", provider: "modelscope", transport: "modelscope", sha: null, quant: "BF16", source: "platform-marker", confidence: "declared", job: null },
    "from-ledger": { repo: "acme/Ledger", provider: "huggingface", transport: "huggingface", sha: null, quant: "Q6_K", source: "legacy-ledger", confidence: "declared", job: null },
    "acme__Tiny-LM": { repo: "acme/Tiny-LM", provider: "huggingface", transport: null, sha: SHA_C, quant: null, source: "hf-local-metadata", confidence: "unverified", job: null },
    "from-mixed": { repo: "acme/Mixed", provider: "huggingface", transport: "huggingface", sha: SHA_A, quant: null, source: "platform-marker", confidence: "declared", job: null },
    "models--acme--Cached": { repo: "acme/Cached", provider: "huggingface", transport: "huggingface", sha: SHA_C, quant: null, source: "hf-cache-refs", confidence: "declared", job: null },
  });

  // field-level precedence: the job's fields win, the marker fills what the job lacks
  const job = library.get(registered.entryId);
  assert.equal(job.provenance.revision, "main", "revision comes from the marker, the job has none");
  assert.deepEqual([job.provenance.fieldSources.quant, job.provenance.fieldSources.revision, job.provenance.fieldSources.revisionSha], ["hub-job", "platform-marker", "hub-job"]);
  assert.equal(job.provenance.artifactKey, "gguf:|Q4_K_M");
  assert.equal(job.provenance.downloadedAt, "2026-10-03T00:00:00.000Z");
  assert.equal(job.files.find((file) => file.path === "Job-Q4_K_M.gguf").sha256, jobFiles["Job-Q4_K_M.gguf"].sha256);

  // hf metadata: the majority commit, per-file hashes by etag length, guesses
  const meta = entries.find((entry) => entry.relativePath === "acme__Tiny-LM");
  assert.equal(meta.provenance.candidates[0], "acme/Tiny-LM");
  assert.equal(meta.identityKey, null, "an unverified guess has no identity");
  const shard = library.get(meta.id).files.find((file) => file.path === "model-00001-of-00002.safetensors");
  assert.equal(shard.sha256, metaFiles["model-00001-of-00002.safetensors"].sha256);
  assert.equal(library.get(meta.id).files.find((file) => file.path === "config.json").gitOid, "d".repeat(40), "a 40-hex etag is a git blob id");
  assert.equal(library.get(meta.id).files.find((file) => file.path === "config.json").sha256, null);

  // marker repo + metadata revision: the identity is complete
  const mixed = entries.find((entry) => entry.relativePath === "from-mixed");
  assert.deepEqual([mixed.provenance.fieldSources.repo, mixed.provenance.fieldSources.revisionSha], ["platform-marker", "hf-local-metadata"]);
  assert.match(mixed.identityKey, new RegExp(`^hf:acme/mixed@${SHA_A}#[0-9a-f]{64}$`));
  assert.equal(entries.find((entry) => entry.relativePath === "from-ledger").identityKey, null, "no revision, no identity");
});

test("a ledger path retired by an alias or a migration record still names the folder it became", async (t) => {
  const world = makeWorld(t);
  const { modelsRoot, libF, root } = world;
  const viaAlias = path.join(libF, "moved-by-alias");
  const viaRecord = path.join(libF, "moved-by-record");
  makeModel(viaAlias);
  makeModel(viaRecord);
  const oldLib = path.join(root, "old-lib");
  world.storage.addAlias(path.join(oldLib, "moved-by-alias"), viaAlias, "mig-alias");
  writeLedger(root, "llama", [
    ledgerJob(path.join(oldLib, "moved-by-alias"), { model: "acme/ByAlias" }),
    ledgerJob(path.join(root, "retired", "moved-by-record"), { model: "acme/ByRecord", source: "modelscope" }),
  ]);
  putJson(path.join(root, "service-entry", "data", "model-migrations"), "mig-record.json", {
    id: "mig-record", state: "completed", source: path.join(root, "retired"), target: libF,
  });
  assert.ok(modelsRoot);
  const library = await world.open();
  await world.scan();
  const alias = await world.byName("moved-by-alias");
  assert.deepEqual([alias.provenance.repo, alias.provenance.source, alias.provenance.confidence], ["acme/ByAlias", "legacy-ledger", "declared"]);
  const record = await world.byName("moved-by-record");
  assert.deepEqual([record.provenance.repo, record.provenance.provider, record.provenance.source], ["acme/ByRecord", "modelscope", "migration-record"]);
  assert.equal(library.size, 2);
});

// --- ids across aliases -------------------------------------------------------------------

test("an entry keeps its id, provenance and old path when its folder moves to another root through an alias", async (t) => {
  const world = makeWorld(t);
  const { modelsRoot, libF, root } = world;
  const oldDir = path.join(modelsRoot, "Qwen-Qwen3-8B-FP8");
  makeModel(oldDir);
  writeLedger(root, "vllm", [ledgerJob(oldDir, { model: "Qwen/Qwen3-8B-FP8", precision: "FP8" })]);
  const library = await world.open();
  await world.scan();
  const before = await world.byName("Qwen-Qwen3-8B-FP8");
  assert.equal(before.rootId, "legacy");
  assert.equal(before.provenance.repo, "Qwen/Qwen3-8B-FP8");

  // The migration: copy to the new root, alias the old path to it.
  const newDir = path.join(libF, "Qwen-Qwen3-8B-FP8");
  fs.cpSync(oldDir, newDir, { recursive: true });
  world.storage.addAlias(oldDir, newDir, "mig-1");
  fs.rmSync(oldDir, { recursive: true });
  world.events.clear();
  await world.scan();

  const { entries } = await library.list({});
  assert.equal(entries.length, 1, "the moved folder is the same entry, not a second one");
  const after = entries[0];
  assert.equal(after.id, before.id);
  assert.equal(after.path, newDir);
  assert.equal(after.rootLabel, "Library F");
  assert.deepEqual(after.aliases, [oldDir]);
  assert.deepEqual(after.aliasDisplay, ["原模型库/Qwen-Qwen3-8B-FP8"]);
  assert.equal(after.provenance.repo, "Qwen/Qwen3-8B-FP8", "the ledger path maps through the alias");
  assert.equal(library.findByPath(oldDir).id, before.id, "the retired path finds the entry");
  assert.equal(library.findByPath(path.join(newDir, "config.json")).id, before.id, "a path inside the entry finds it");
  assert.equal(library.findByPath("relative/path"), null);
  assert.ok(world.events.changed().includes(before.id));

  // A second rescan, and a restart, keep it.
  await world.scan();
  await library.stop();
  const again = await world.open();
  await world.scan();
  assert.equal((await again.list({})).entries[0].id, before.id);
  assert.equal(again.get(before.id).path, newDir);
});

test("a folder renamed through two aliases (A to B to C) keeps its id", async (t) => {
  const world = makeWorld(t);
  const a = path.join(world.modelsRoot, "m");
  makeModel(a);
  const library = await world.open();
  await world.scan();
  const id = (await world.byName("m")).id;
  const b = path.join(world.libF, "m");
  fs.cpSync(a, b, { recursive: true });
  world.storage.addAlias(a, b, "hop-1");
  fs.rmSync(a, { recursive: true });
  await world.scan();
  const c = path.join(world.libF, "m-final");
  fs.renameSync(b, c);
  world.storage.addAlias(b, c, "hop-2");
  await world.scan();
  const entry = library.get(id);
  assert.ok(entry);
  assert.equal(entry.path, c);
  assert.deepEqual([...entry.aliases].sort(), [a, b].sort());
  assert.equal(library.size, 1);
});

// --- duplicates ---------------------------------------------------------------------------------

test("duplicates are linked by identity key or by a fully hashed fileset, and nothing is removed", async (t) => {
  const world = makeWorld(t);
  const { modelsRoot, libF } = world;
  const files = { "model.safetensors": 4096 };
  const a = path.join(modelsRoot, "dup-a");
  const built = makeModel(a, { weights: files, seed: "d" });
  markerV2(a, { model: "acme/Dup", revisionSha: SHA_A, files: [{ path: "model.safetensors", size: 4096, sha256: built["model.safetensors"].sha256 }] });
  const b = path.join(libF, "dup-b");
  fs.cpSync(a, b, { recursive: true });
  // c: same bytes, no marker, hashes known from hf metadata only
  const c = path.join(libF, "dup-c-no-repo");
  makeModel(c, { weights: files, seed: "d" });
  hfMetadata(c, "model.safetensors", SHA_B, built["model.safetensors"].sha256);
  // d: same names and sizes, different content, no hashes
  const d = path.join(libF, "dup-d-lookalike");
  makeModel(d, { weights: files, seed: "z" });
  // e: same repo and revision but different content: a different identity
  const e = path.join(libF, "dup-e-other-fileset");
  const eBuilt = makeModel(e, { weights: { "model.safetensors": 4000 }, seed: "e" });
  markerV2(e, { model: "acme/Dup", revisionSha: SHA_A, files: [{ path: "model.safetensors", size: 4000, sha256: eBuilt["model.safetensors"].sha256 }] });

  const library = await world.open();
  await world.scan();
  const by = Object.fromEntries((await library.list({})).entries.map((entry) => [entry.relativePath, entry]));
  const ids = (...names) => names.map((name) => by[name].id).sort();
  assert.deepEqual(by["dup-a"].duplicates, ids("dup-b", "dup-c-no-repo"), "b shares the identity key, c the fully hashed fileset");
  assert.deepEqual(by["dup-b"].duplicates, ids("dup-a", "dup-c-no-repo"));
  assert.deepEqual(by["dup-c-no-repo"].duplicates, ids("dup-a", "dup-b"));
  assert.equal(by["dup-a"].identityKey, by["dup-b"].identityKey);
  assert.equal(by["dup-c-no-repo"].identityKey, null, "c has no repo, so only the fileset links it");
  assert.equal(by["dup-a"].filesetHash, by["dup-c-no-repo"].filesetHash);
  assert.deepEqual(by["dup-d-lookalike"].duplicates, [], "same names and sizes without hashes are not proof");
  assert.deepEqual(by["dup-e-other-fileset"].duplicates, [], "the same repo and revision with a different fileset is another identity");
  assert.notEqual(by["dup-e-other-fileset"].identityKey, by["dup-a"].identityKey);
  assert.equal((await library.list({ duplicates: "1" })).total, 3);
  assert.ok(fs.existsSync(a) && fs.existsSync(b), "linking never deletes");
});

test("two folders with the same fileset hash and a sha256 for every weight are duplicates without any repo", async (t) => {
  const world = makeWorld(t);
  const files = { "model-00001-of-00002.safetensors": 2048, "model-00002-of-00002.safetensors": 1024 };
  const dirs = ["twin-1", "twin-2"].map((name) => path.join(world.libF, name));
  for (const dir of dirs) {
    const built = makeModel(dir, { weights: files, seed: "t" });
    for (const [name, info] of Object.entries(built)) hfMetadata(dir, name, SHA_B, info.sha256);
  }
  const library = await world.open();
  await world.scan();
  const [one, two] = (await library.list({})).entries.sort((x, y) => x.relativePath.localeCompare(y.relativePath));
  assert.equal(one.filesetHash, two.filesetHash);
  assert.equal(one.identityKey, null);
  assert.deepEqual([one.duplicates, two.duplicates], [[two.id], [one.id]]);
});

// --- cards ------------------------------------------------------------------------------------------

test("with core.models the entry carries the card, role, family and engine verdicts; a tooling-only card is not runnable", async (t) => {
  const world = makeWorld(t);
  makeModel(path.join(world.modelsRoot, "with-card"));
  makeModel(path.join(world.modelsRoot, "tooling-card"));
  const seen = [];
  const models = {
    async inspectLocal(target, options) {
      seen.push([path.basename(target), options]);
      const tooling = path.basename(target) === "tooling-card";
      return { cardId: `mc_${path.basename(target)}`, role: { value: tooling ? "tooling-only" : "main", runnable: !tooling }, identity: { familyId: "llama3" } };
    },
  };
  const fit = { async compatibilityFor() { return [{ engineId: "vllm", runtimeId: "vllm@0.28.0", verdict: "ok", extra: "dropped" }]; } };
  const library = await world.open({ models, fit });
  await world.scan();
  const card = await world.byName("with-card");
  assert.deepEqual(card.card, { cardId: "mc_with-card", role: "main", familyId: "llama3", compatibility: [{ engineId: "vllm", runtimeId: "vllm@0.28.0", verdict: "ok" }] });
  assert.equal(card.runnable, true);
  const tooling = await world.byName("tooling-card");
  assert.equal(tooling.runnable, false);
  assert.ok(seen.every(([, options]) => options.depth === "quick"));
  const calls = seen.length;
  await world.scan();
  assert.equal(seen.length, calls, "an unchanged folder reuses its card");
  assert.ok(library.size === 2);
});

// --- verify -------------------------------------------------------------------------------------------

test("verify checks structure and size, then sha256 in a worker thread when asked", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.libF, "verify-me");
  const built = makeModel(dir, { weights: { "model-00001-of-00002.safetensors": 3000, "model-00002-of-00002.safetensors": 2000 }, seed: "v" });
  markerV2(dir, {
    model: "acme/Verify", revisionSha: SHA_A,
    files: Object.entries(built).map(([name, info]) => ({ path: name, size: info.size, sha256: info.sha256 })),
  });
  const library = await world.open();
  await world.scan();
  const entry = await world.byName("verify-me");

  const quick = library.verify(entry.id, { checksums: false });
  assert.match(quick.taskId, /^tsk_[0-9a-f]{16}$/);
  assert.equal((await waitTask(library, quick.taskId)).state, "succeeded");
  assert.deepEqual([library.get(entry.id).verification.status, library.get(entry.id).verification.checksum], ["ok", "none"]);

  world.events.clear();
  const full = library.verify(entry.id, { checksums: true });
  const task = await waitTask(library, full.taskId);
  assert.equal(task.state, "succeeded");
  assert.deepEqual(task.result, { entryId: entry.id, status: "ok", checksum: "verified" });
  const verified = library.get(entry.id);
  assert.equal(verified.verification.checkedAt, "2026-10-14T08:00:00.000Z");
  assert.ok(verified.files.filter((file) => file.sha256).every((file) => file.verifiedAt === "2026-10-14T08:00:00.000Z"));
  assert.ok(world.events.list.some((item) => item.type === "library" && item.payload.kind === "task" && item.payload.task.id === full.taskId && item.payload.task.state === "succeeded"));
  assert.ok(world.events.changed().includes(entry.id));

  // The same request while one is running returns the running task.
  const first = library.verify(entry.id, { checksums: true });
  const again = library.verify(entry.id, { checksums: true });
  assert.equal(again.taskId, first.taskId);
  await waitTask(library, first.taskId);

  // Same size, different bytes: a sha256 mismatch fails the entry.
  const shard = path.join(dir, "model-00002-of-00002.safetensors");
  fs.writeFileSync(shard, safetensorsBytes(2000, "!"));
  const bad = await waitTask(library, library.verify(entry.id, { checksums: true }).taskId);
  assert.equal(bad.result.status, "fail");
  const failed = library.get(entry.id);
  assert.ok(failed.verification.issues.some((issue) => issue.code === "sha256_mismatch" && issue.path === "model-00002-of-00002.safetensors"));
  assert.equal(failed.runnable, false);
  assert.equal(failed.verification.checksum, "partial");

  // A truncated file is caught by the size check alone.
  fs.writeFileSync(shard, safetensorsBytes(1500, "!"));
  const small = await waitTask(library, library.verify(entry.id, {}).taskId);
  assert.equal(small.result.status, "fail");
  assert.ok(library.get(entry.id).verification.issues.some((issue) => issue.code === "size_mismatch"));
  assert.equal(JSON.stringify(library.get(entry.id).verification).includes(world.root), false, "issues never carry an absolute path");

  // A rescan sees the new content, so the old verdict no longer applies.
  await world.scan();
  assert.equal(library.get(entry.id).verification.status, "unchecked");
  assert.equal(library.get(entry.id).runnable, true);
  assert.equal(library.get(entry.id).files.find((file) => file.path.endsWith("00002-of-00002.safetensors")).sha256, null, "a hash recorded for other bytes is not kept");
  const healed = await waitTask(library, library.verify(entry.id, {}).taskId);
  assert.deepEqual([healed.result.status, library.get(entry.id).runnable], ["ok", true]);

  assert.throws(() => library.verify("lib_0000000000000000"), { code: "library_entry_not_found", status: 404 });
});

test("verify reports a missing file and a vanished folder, and a hash worker failure is a warning not a crash", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.libF, "broken");
  const built = makeModel(dir, { weights: { "model.safetensors": 2048 } });
  markerV2(dir, { model: "acme/Broken", revisionSha: SHA_A, files: [{ path: "model.safetensors", size: 2048, sha256: built["model.safetensors"].sha256 }] });
  const hashes = [];
  const library = await world.open({ hashFile: async (file) => { hashes.push(path.basename(file)); throw Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" }); } });
  await world.scan();
  const entry = await world.byName("broken");
  const locked = await waitTask(library, library.verify(entry.id, { checksums: true }).taskId);
  assert.equal(locked.result.status, "warn");
  assert.deepEqual(hashes, ["model.safetensors"]);
  assert.equal(library.get(entry.id).verification.issues.find((issue) => issue.code === "sha256_unreadable").severity, "warn");

  fs.rmSync(path.join(dir, "model.safetensors"));
  const missing = await waitTask(library, library.verify(entry.id, { checksums: true }).taskId);
  assert.equal(missing.result.status, "fail");
  assert.ok(library.get(entry.id).verification.issues.some((issue) => issue.code === "file_missing"));

  fs.rmSync(dir, { recursive: true });
  const gone = await waitTask(library, library.verify(entry.id, {}).taskId);
  assert.equal(gone.result.status, "fail");
  assert.equal(library.get(entry.id).verification.issues[0].code, "path_missing");
});

test("residue is counted and reported: .incomplete files are not part of the payload", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.libF, "resumed");
  makeModel(dir);
  put(dir, ".cache/huggingface/download/model.safetensors.abc.incomplete", Buffer.alloc(700));
  put(dir, "other.bin.incomplete", Buffer.alloc(300));
  const library = await world.open();
  await world.scan();
  const entry = await world.byName("resumed");
  assert.deepEqual(entry.residue, { incompleteFiles: 2, incompleteBytes: 1000 });
  assert.equal(entry.fileCount, 3);
  assert.ok(library.get(entry.id).files.every((file) => !file.path.includes(".incomplete") && !file.path.startsWith(".cache/")));
});

// --- identify ------------------------------------------------------------------------------------------------

function fakeProviders(known) {
  const calls = [];
  return {
    calls,
    get(namespace) {
      return {
        async getRepo(repo, { revision }) {
          calls.push([namespace, repo, revision]);
          if (known.has(repo.toLowerCase())) return { repo, revisionSha: /^[0-9a-f]{40}$/.test(revision) ? revision : SHA_A };
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      };
    },
  };
}

test("identify confirms a folder-name candidate against the hub, or records what the user declared", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.modelsRoot, "acme__Tiny-LM");
  const built = makeModel(dir, { seed: "i" });
  hfMetadata(dir, "model.safetensors", SHA_C, built["model.safetensors"].sha256);
  const providers = fakeProviders(new Set(["acme/tiny-lm", "elsewhere/real-name"]));
  const library = await world.open({ providers });
  await world.scan();
  const before = await world.byName("acme__Tiny-LM");
  assert.deepEqual([before.provenance.confidence, before.identityKey], ["unverified", null]);

  // Nothing is confirmed in the background unless identifyOnline is set.
  await library.confirmCandidatesInBackground();
  assert.equal(providers.calls.length, 0);

  world.events.clear();
  const confirmed = await library.identify(before.id, {});
  assert.deepEqual([confirmed.provenance.repo, confirmed.provenance.confidence, confirmed.provenance.source], ["acme/Tiny-LM", "detected", "user"]);
  assert.deepEqual(providers.calls[0], ["huggingface", "acme/Tiny-LM", SHA_C], "the candidate is checked at the entry's revision");
  assert.match(confirmed.identityKey, new RegExp(`^hf:acme/tiny-lm@${SHA_C}#`));
  assert.equal(confirmed.displayName, "Tiny-LM");
  assert.deepEqual(world.events.changed(), [before.id]);

  // The decision survives a rescan and a restart.
  await world.scan();
  assert.equal(library.get(before.id).provenance.source, "user");
  await library.stop();
  const restarted = await world.open({ providers });
  assert.equal(restarted.get(before.id).provenance.repo, "acme/Tiny-LM");

  // An explicit repo that exists replaces the guess; one that does not is refused unless forced.
  const other = await restarted.identify(before.id, { provider: "huggingface", repo: "elsewhere/real-name" });
  assert.deepEqual([other.provenance.repo, other.provenance.confidence], ["elsewhere/real-name", "detected"]);
  await assert.rejects(restarted.identify(before.id, { repo: "no/such-repo" }), { code: "repo_revision_not_found", status: 422 });
  assert.equal(restarted.get(before.id).provenance.repo, "elsewhere/real-name", "a refused identify changes nothing");
  const forced = await restarted.identify(before.id, { repo: "no/such-repo", force: true });
  assert.deepEqual([forced.provenance.repo, forced.provenance.confidence], ["no/such-repo", "declared"]);
  await assert.rejects(restarted.identify(before.id, { repo: "not a repo" }), { code: "invalid_request" });
  await assert.rejects(restarted.identify(before.id, { repo: "a/b", provider: "nowhere" }), { code: "invalid_request" });
  await assert.rejects(restarted.identify("lib_ffffffffffffffff", { repo: "a/b" }), { code: "library_entry_not_found", status: 404 });
});

test("identify without a hub declares the repo; identifyOnline confirms candidates in the background", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.modelsRoot, "acme__Tiny-LM");
  const built = makeModel(dir, { seed: "i" });
  hfMetadata(dir, "model.safetensors", SHA_C, built["model.safetensors"].sha256);
  const plain = await world.open();
  await world.scan();
  const entry = await world.byName("acme__Tiny-LM");
  await assert.rejects(plain.identify(entry.id, {}), { code: "identify_unavailable", status: 503 });
  const declared = await plain.identify(entry.id, { repo: "mine/own-copy" });
  assert.deepEqual([declared.provenance.repo, declared.provenance.confidence], ["mine/own-copy", "declared"]);
  await plain.stop();

  const second = makeWorld(t);
  const dir2 = path.join(second.modelsRoot, "acme__Tiny-LM");
  const built2 = makeModel(dir2, { seed: "i" });
  hfMetadata(dir2, "model.safetensors", SHA_C, built2["model.safetensors"].sha256);
  const providers = fakeProviders(new Set(["acme/tiny-lm"]));
  const online = await second.open({ providers, getSettings: () => ({ library: { identifyOnline: true } }) });
  await second.scan();
  await online.confirmCandidatesInBackground();
  const confirmed = (await online.list({})).entries[0];
  assert.deepEqual([confirmed.provenance.repo, confirmed.provenance.confidence], ["acme/Tiny-LM", "detected"]);
});

// --- rescan ----------------------------------------------------------------------------------------------------

test("rescan limits to the given roots, shares a queued scan and rejects unknown roots", async (t) => {
  const world = makeWorld(t);
  makeModel(path.join(world.modelsRoot, "legacy-model"));
  makeModel(path.join(world.libF, "libf-model"));
  const library = await world.open();
  const libFId = (await library.list({})).roots.find((root) => root.label === "Library F").id;
  await world.scan([libFId]);
  assert.deepEqual((await library.list({})).entries.map((entry) => entry.relativePath), ["libf-model"], "only the named root was scanned");
  await assert.rejects(library.rescan({ rootIds: ["nope"] }), { code: "unknown_root", status: 400 });
  await assert.rejects(library.rescan({ rootIds: "legacy" }), { code: "invalid_request" });

  const one = await library.rescan({});
  const two = await library.rescan({});
  assert.equal(two.taskId, one.taskId, "a scan that has not finished is reused");
  const done = await waitTask(library, one.taskId);
  assert.deepEqual([done.kind, done.state, done.progress.unit], ["rescan", "succeeded", "candidates"]);
  assert.equal((await library.list({})).total, 2);
  assert.equal(library.getTask("tsk_0000000000000000"), null);
  assert.equal(library.getTask("../etc"), null);
});

test("a change to model-storage.json starts a rescan, and a start-up registry is served before any scan", async (t) => {
  const world = makeWorld(t);
  makeModel(path.join(world.modelsRoot, "first"));
  const library = await world.open();
  assert.equal(library.checkStorageChanged(), false, "the first look only records the file");
  await world.scan();
  assert.equal(library.checkStorageChanged(), false);
  makeModel(path.join(world.libF, "added-after"));
  // Registering a root rewrites model-storage.json.
  const extra = path.join(world.root, "libG");
  fs.mkdirSync(extra);
  makeModel(path.join(extra, "in-new-root"));
  const future = new Date(Date.now() + 5000);
  world.storage.registerRoot({ path: extra, label: "Library G" });
  fs.utimesSync(world.storage.file, future, future);
  assert.equal(library.checkStorageChanged(), true);
  const deadline = Date.now() + 10_000;
  while (library.size < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(library.size, 3);
});

test("registerFromJob registers only a folder directly in a root and links the job to the entry", async (t) => {
  const world = makeWorld(t);
  const dir = path.join(world.libF, "fresh");
  const built = makeModel(dir, { weights: { "m-Q4_K_M.gguf": 2048 } });
  const library = await world.open();
  assert.equal(await library.registerFromJob({ id: "dl_x", target: { localDir: path.join(world.root, "outside", "x") }, artifact: {} }), null);
  assert.equal(await library.registerFromJob({}), null);
  const result = await library.registerFromJob({
    id: "dl_fresh", finishedAt: "2026-10-14T07:00:00.000Z", target: { localDir: dir },
    artifact: { provider: "modelscope", repo: "ms-org/Fresh", revisionSha: null, files: [{ path: "m-Q4_K_M.gguf", size: 2048, sha256: built["m-Q4_K_M.gguf"].sha256 }] },
  });
  assert.match(result.entryId, /^lib_/);
  assert.deepEqual([result.entry.provenance.source, result.entry.provenance.provider, result.entry.provenance.downloadJobId], ["hub-job", "modelscope", "dl_fresh"]);
  assert.equal(result.entry.files.find((file) => file.path === "m-Q4_K_M.gguf").sha256, built["m-Q4_K_M.gguf"].sha256);
  assert.equal(library.size, 1);
  await world.scan();
  assert.equal(library.get(result.entryId).provenance.source, "hub-job", "the job record outlives the next scan");
  assert.equal(library.get(result.entryId).id, result.entryId);
});
