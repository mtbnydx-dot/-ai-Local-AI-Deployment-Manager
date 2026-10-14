"use strict";

// ModelCard v1 from the local inspector (docs/overhaul/02-models.md §4, §5,
// §21.2, MOD-3): golden cards for the library fixtures, evidence behind every
// fact, rename invariance, the fingerprint cache, the worker keeping the event
// loop free, and the core.models namespace.
//
// Goldens live next to each fixture as expected-card.json (the stable
// projection: no inspectedAt, ref or cardId). After an intended change to the
// inspector, rewrite them with UPDATE_MODEL_CARD_GOLDENS=1 and review the diff.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const core = require("..");
const models = require("../model-inspector");
const { factsWithoutEvidence } = require("../model-inspector/card-schema");
const { cardIdFor } = require("../model-inspector/cache");
const { compileSchema, validate } = require("../model-inspector/json-schema-lite");
const { layerRuns } = require("../model-inspector/detectors/topology");
const { resetInspector } = require("../model-inspector/inspect");
const { FIXTURES_ROOT, listFixtures, loadFixture, materializeFixture, stableCardProjection } = require("./helpers/fixture-materialize");

const GiB = 1024 ** 3;
const LIBRARY = [
  "qwen38-27b-fp8",
  "qwen38-27b-fp8-indexed",
  "qwen36-35b-a3b-fp8",
  "qwen38-flashnext-nvfp4",
  "qwen38-27b-dspark-draft",
  "ple-quant-tooling",
  "deepseek-v4-flash-q2k-gguf",
];
const UPDATE_GOLDENS = process.env.UPDATE_MODEL_CARD_GOLDENS === "1";

let cacheDir;
const materialized = new Map();

test.before(async () => {
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "model-cards-cache-"));
});

test.after(async () => {
  await resetInspector();
  for (const model of materialized.values()) await model.cleanup();
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

// One materialized copy per fixture for the whole file.
async function fixtureModel(id) {
  if (!materialized.has(id)) materialized.set(id, await materializeFixture(id));
  return materialized.get(id);
}

async function tempDir(t, prefix = "model-cards-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Goldens print arrays of scalars on one line and short objects (evidence
// entries) on one line each, so a review diff stays readable.
function formatGolden(value, indent = "") {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) return JSON.stringify(value);
    const inner = `${indent}  `;
    return `[\n${value.map((item) => {
      const flat = JSON.stringify(item);
      return inner + (flat.length <= 220 ? flat : formatGolden(item, inner));
    }).join(",\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${formatGolden(value[key], inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function allSized(model) {
  return model.files.every((file) => file.sized || file.kind === "captured" || file.kind === "index");
}

// ---------------------------------------------------------------------------
// Golden cards

for (const id of LIBRARY) {
  test(`${id}: golden card`, async (t) => {
    const model = await fixtureModel(id);
    if (!allSized(model)) {
      t.skip("this file system cannot size the fixture files (no sparse files); goldens need the captured sizes");
      return;
    }
    const card = await models.inspectLocal(model.dir, { cacheDir });
    const verdict = models.validateCard(card);
    assert.deepEqual(verdict.errors, [], "validateCard");
    const projection = stableCardProjection(card);
    const file = path.join(FIXTURES_ROOT, id, "expected-card.json");
    if (UPDATE_GOLDENS) fs.writeFileSync(file, `${formatGolden(projection)}\n`);
    const expected = loadFixture(id).expectedCard;
    assert.ok(expected, `${id}: expected-card.json is missing (UPDATE_MODEL_CARD_GOLDENS=1 writes it)`);
    assert.deepEqual(projection, expected);
  });
}

test("every fixture card validates and has evidence behind every fact", async () => {
  for (const id of listFixtures()) {
    const model = await fixtureModel(id);
    const card = await models.inspectLocal(model.dir, { cacheDir });
    assert.deepEqual(models.validateCard(card).errors, [], id);
    assert.deepEqual(factsWithoutEvidence(card), [], id);
    assert.ok(card.evidence.length > 10, `${id}: evidence`);
    for (const entry of card.evidence) {
      assert.ok(models.evidence.CONFIDENCES.includes(entry.confidence), `${id}: ${entry.fact}`);
      if (entry.source.ref) assert.ok(!/^(?:[A-Za-z]:|[\\/])/.test(entry.source.ref) && !entry.source.ref.includes("\\"), `${id}: ${entry.source.ref} is folder-relative`);
    }
    assert.equal(card.support, "unknown", `${id}: no knowledge layers yet`);
    assert.equal(card.identity.familyId, null, id);
  }
});

test("validateCard rejects a fact without evidence and a malformed card", async () => {
  const card = await models.inspectLocal((await fixtureModel("qwen38-27b-fp8")).dir, { cacheDir });
  const stripped = { ...card, evidence: card.evidence.filter((entry) => entry.fact !== "/topology/layers") };
  const verdict = models.validateCard(stripped);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.errors, [{ path: "/topology/layers", code: "evidence_missing", message: "this fact has no evidence entry" }]);
  // Evidence for a whole section backs nothing.
  const sectionWide = { ...stripped, evidence: [...stripped.evidence, { fact: "/topology", source: { kind: "file", ref: "config.json" }, confidence: "declared" }] };
  assert.equal(models.validateCard(sectionWide).ok, false);
  const broken = { ...card, cardId: "card-1", quant: { ...card.quant, activation: "sometimes" }, extra: true };
  const errors = models.validateCard(broken).errors.map((error) => `${error.path} ${error.code}`);
  assert.ok(errors.includes("/cardId schema_pattern"), errors.join("; "));
  assert.ok(errors.includes("/quant/activation schema_anyOf"), errors.join("; "));
  assert.ok(errors.includes("/extra schema_additionalProperties"), errors.join("; "));
});

// The facts 02 §1-§2 verified on the owner's library.
test("library facts: Qwen3.8 hybrid layout, weights and template; DeepSeek-V4 exact bytes", async () => {
  for (const id of ["qwen38-27b-fp8", "qwen38-27b-fp8-indexed"]) {
    const card = await models.inspectLocal((await fixtureModel(id)).dir, { cacheDir });
    assert.equal(card.identity.modelType, "qwen3_5", id);
    assert.deepEqual(card.identity.architectures, ["Qwen3_5ForConditionalGeneration"], id);
    assert.equal(models.evidence.confidenceOf(card, "/identity/modelType"), "declared");
    assert.equal(card.weights.tensorBytes, 30866663264, id);
    assert.equal(card.weights.totalBytes, card.format.weightBytes, `${id}: complete files are exactly their header layout`);
    assert.equal((card.weights.tensorBytes / GiB).toFixed(2), "28.75", id);
    assert.equal((card.weights.totalBytes / GiB).toFixed(2), "28.75", id);
    assert.equal(card.weights.exact, true, id);
    assert.deepEqual(card.topology.attention.histogram, { full: 16, linear: 48 }, id);
    assert.deepEqual(card.topology.attention.runs, [{ kind: "linear", count: 3 }, { kind: "full", count: 1 }], id);
    assert.deepEqual(card.topology.attention.kinds.full, { kvHeads: 4, kDim: 256, vDim: 256 }, id);
    assert.deepEqual(card.topology.attention.kinds.linear, {
      variant: "gated-deltanet", convKernel: 4, kHeads: 16, vHeads: 48, kDim: 128, vDim: 128, ssmDtype: "float32",
    }, id);
    assert.ok(card.topology.mtp.tensorCount > 0 && card.speculative.nativeMtp === true, `${id}: packaged MTP`);
    assert.ok(card.template.sha256.startsWith("c3cf9e34abf4f9e3"), id);
    assert.deepEqual(card.modalities.input, ["text", "image", "video"], id);
    assert.equal(card.quant.method, "fp8", id);
  }
  const qwen36 = await models.inspectLocal((await fixtureModel("qwen36-35b-a3b-fp8")).dir, { cacheDir });
  assert.ok(qwen36.template.sha256.startsWith("e84f32a23fdda276"));
  assert.equal(qwen36.topology.moe.experts, 256);

  const flash = await models.inspectLocal((await fixtureModel("qwen38-flashnext-nvfp4")).dir, { cacheDir });
  assert.deepEqual([flash.quant.method, flash.quant.algo, flash.quant.weightBits, flash.quant.groupSize], ["modelopt", "NVFP4", 4, 16]);
  assert.equal(flash.topology.moe.experts, 512);
  assert.equal(flash.topology.moe.expertBytesPerLayer.length, 48);
  assert.deepEqual(flash.topology.attention.kinds.indexer, { compressRatio: 4, kDim: 128, kvHeads: 1, heads: 4 });
  assert.deepEqual(flash.topology.ple.layers, [2]);
  assert.ok(flash.topology.ple.bytes > 50e9);
  assert.equal(flash.format.weightFiles, 206);
  assert.equal(flash.format.complete, true);

  const deepseek = await models.inspectLocal((await fixtureModel("deepseek-v4-flash-q2k-gguf")).dir, { cacheDir });
  assert.equal(deepseek.identity.ggufArchitecture, "deepseek4");
  // 02 §1: 90.89 GiB is the file as its header lays it out (MOD-2 weights.totalBytes);
  // the tensors alone are 5.3 MB of header smaller.
  assert.equal(deepseek.weights.totalBytes, 97591747456);
  assert.equal((deepseek.weights.totalBytes / GiB).toFixed(2), "90.89");
  assert.equal(deepseek.weights.tensorBytes, 97586411868);
  assert.equal(deepseek.weights.byClass.experts, 88785027072);
  assert.equal((deepseek.weights.byClass.experts / GiB).toFixed(2), "82.69");
  assert.equal(deepseek.weights.exact, true);
  assert.deepEqual(deepseek.topology.attention.histogram, { compressed: 43 });
  const compressed = deepseek.topology.attention.kinds.compressed;
  assert.equal(compressed.ratios.length, 44);
  assert.deepEqual([compressed.window, compressed.latentDim], [128, 512]);
  assert.deepEqual(compressed.indexer, { heads: 64, kDim: 128, topK: 512 });
  assert.deepEqual([deepseek.topology.moe.experts, deepseek.topology.moe.active, deepseek.topology.moe.shared], [256, 6, 1]);
  assert.deepEqual(deepseek.topology.mtp, { layers: 1, tensorCount: 0, bytes: 0 }, "nextn declared, no tensors packaged");
  assert.equal(deepseek.template.source, "gguf");
  assert.deepEqual([deepseek.sampling.temperature, deepseek.sampling.top_p, deepseek.sampling.source], [1, 1, "gguf"]);

  const draft = await models.inspectLocal((await fixtureModel("qwen38-27b-dspark-draft")).dir, { cacheDir });
  assert.deepEqual(draft.customCode, { autoMap: { AutoModel: "dspark.DSparkDraftModel" }, files: ["dflash.py", "dspark.py"], trustRemoteCodeRequired: true });
  const tooling = await models.inspectLocal((await fixtureModel("ple-quant-tooling")).dir, { cacheDir });
  assert.deepEqual([tooling.format.layout, tooling.identity.modelType, tooling.template.source], ["custom", null, "none"]);
});

test("a GGUF window without a per-layer pattern is an unknown layout, not all-SWA (02 §5.1)", async (t) => {
  const dir = await tempDir(t);
  const { buildGguf } = require("./helpers/gguf-writer");
  const built = buildGguf({
    kv: [
      { key: "general.architecture", type: "string", value: "windowed" },
      { key: "windowed.block_count", type: "uint32", value: 4 },
      { key: "windowed.embedding_length", type: "uint32", value: 256 },
      { key: "windowed.attention.head_count", type: "uint32", value: 4 },
      { key: "windowed.attention.head_count_kv", type: "uint32", value: 2 },
      { key: "windowed.attention.sliding_window", type: "uint32", value: 512 },
    ],
    tensors: [{ name: "token_embd.weight", dims: [256, 64], typeId: 1 }, { name: "blk.0.attn_q.weight", dims: [256, 256], typeId: 1 }],
  });
  const file = path.join(dir, "windowed.gguf");
  fs.writeFileSync(file, built.header);
  fs.truncateSync(file, built.totalBytes);
  const card = await models.inspectLocal(file, { cacheDir });
  assert.deepEqual(card.topology.attention.histogram, { unknown: 4 });
  assert.equal(card.topology.attention.kinds.swa.window, 512);
  assert.ok(card.warnings.some((warning) => warning.code === "swa_layout_unknown"));
  assert.equal(card.ref.file, "windowed.gguf");
  assert.deepEqual(models.validateCard(card).errors, []);
});

test("GGUF folders: the model with its projector, a projector file on its own, and several variants", async (t) => {
  const parent = await tempDir(t);
  const model = await materializeFixture("syn-mmproj-gguf", { parent, name: "vl" });
  const folder = await models.inspectLocal(model.dir, { cacheDir });
  assert.equal(folder.identity.ggufArchitecture, "qwen2vl");
  assert.deepEqual(folder.modalities.input, ["text", "image"]);
  assert.deepEqual(folder.modalities.projectorFiles, ["mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf"]);
  assert.equal(folder.format.weightFiles, 1, "the projector is a companion, not the model's weights");
  assert.equal(models.evidence.confidenceOf(folder, "/modalities/visionTower"), "declared");

  const projector = await models.inspectLocal(path.join(model.dir, "mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf"), { cacheDir });
  assert.equal(projector.identity.ggufArchitecture, "clip");
  assert.deepEqual(projector.modalities.input, ["image"]);
  assert.equal(projector.modalities.output, null);
  assert.notEqual(projector.cardId, folder.cardId);
  assert.notEqual(projector.contentDigest, folder.contentDigest);
  assert.deepEqual(models.validateCard(projector).errors, []);

  // A second (small) quant variant: the folder card names the one it describes.
  const { buildGguf } = require("./helpers/gguf-writer");
  const smaller = path.join(model.dir, "Qwen2.5-VL-7B-Instruct-Q2_K.gguf");
  const built = buildGguf({
    kv: [
      { key: "general.architecture", type: "string", value: "qwen2vl" },
      { key: "general.type", type: "string", value: "model" },
      { key: "qwen2vl.block_count", type: "uint32", value: 1 },
    ],
    tensors: [{ name: "token_embd.weight", dims: [64, 64], typeId: 1 }],
  });
  await fsp.writeFile(smaller, built.header);
  await fsp.truncate(smaller, built.totalBytes);
  const both = await models.inspectLocal(model.dir, { cacheDir });
  assert.ok(both.warnings.some((warning) => warning.code === "multiple_gguf_variants" && warning.message.en.includes("Q4_K_M")));
  const one = await models.inspectLocal(smaller, { cacheDir });
  assert.equal(one.ref.file, "Qwen2.5-VL-7B-Instruct-Q2_K.gguf");
  assert.ok(!one.warnings.some((warning) => warning.code === "multiple_gguf_variants"));
});

// ---------------------------------------------------------------------------
// Identity: rename invariance and card ids

test("rename invariance: same contentDigest and card body, different cardId", async (t) => {
  const first = await materializeFixture("qwen38-27b-fp8", { parent: await tempDir(t), name: "Qwen3.8-27B-FP8" });
  t.after(first.cleanup);
  const second = await materializeFixture("qwen38-27b-fp8", { parent: await tempDir(t), name: "renamed copy" });
  t.after(second.cleanup);
  const one = await models.inspectLocal(first.dir, { cacheDir });
  const two = await models.inspectLocal(second.dir, { cacheDir });
  assert.match(one.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(two.contentDigest, one.contentDigest);
  assert.notEqual(two.cardId, one.cardId);
  assert.match(one.cardId, /^mc_[a-z2-7]{20}$/);
  assert.deepEqual(stableCardProjection(two), stableCardProjection(one));
  assert.equal(path.basename(one.ref.path), "Qwen3.8-27B-FP8");
  assert.equal(two.ref.displayPath, "renamed copy");

  // The fine-tune shares the template, not the content.
  const tuned = await models.inspectLocal((await fixtureModel("qwen38-27b-fp8-indexed")).dir, { cacheDir });
  assert.equal(tuned.template.sha256, one.template.sha256);
  assert.notEqual(tuned.contentDigest, one.contentDigest);
});

test("cardId is mc_ + 20 base32 chars of sha256(canonicalRef), case-folded for local paths", () => {
  const id = cardIdFor({ kind: "local", path: "C:\\Models\\Qwen" });
  assert.equal(id, cardIdFor("local:c:/models/qwen"));
  assert.equal(id, cardIdFor({ kind: "local", path: "c:/MODELS/qwen" }));
  assert.notEqual(cardIdFor({ kind: "local", path: "c:/models/qwen", file: "a.gguf" }), id);
  assert.equal(cardIdFor({ kind: "hf", repo: "owner/name" }), cardIdFor("hf:owner/name@main"));
  assert.notEqual(cardIdFor({ kind: "modelscope", repo: "owner/name", revision: "main" }), cardIdFor("hf:owner/name@main"));
  assert.match(id, /^mc_[a-z2-7]{20}$/);
});

// ---------------------------------------------------------------------------
// The fingerprint cache

test("cache: hit on an unchanged folder, miss on a changed fingerprint, corrupt file is a miss", async (t) => {
  const localCache = await tempDir(t, "model-cards-cache-");
  const parent = await tempDir(t);
  const model = await materializeFixture("syn-llama3-8b", { parent, name: "llama" });
  await resetInspector();
  const first = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
  assert.equal(first.cached, false);
  const cacheFile = path.join(localCache, `${first.card.cardId}.json`);
  const stored = JSON.parse(await fsp.readFile(cacheFile, "utf8"));
  assert.equal(stored.key, first.key);
  assert.equal(stored.inspectorVersion, models.INSPECTOR_VERSION);
  assert.equal(stored.contentDigest, first.card.contentDigest);
  assert.ok(stored.facts.templateText === null || typeof stored.facts.templateText === "string");

  const second = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
  assert.equal(second.cached, true, "memory hit");
  await resetInspector();
  const third = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
  assert.equal(third.cached, true, "disk hit after the process forgot the card");
  assert.deepEqual(third.card, first.card, "same card, same inspectedAt");
  assert.deepEqual(models.getCard(first.card.cardId, { cacheDir: localCache }), first.card);
  await resetInspector();
  assert.deepEqual(models.getCard(first.card.cardId, { cacheDir: localCache }), first.card, "getCard reads the cache file");
  assert.equal(models.getCard("mc_aaaaaaaaaaaaaaaaaaaa", { cacheDir: localCache }), null);
  assert.equal(models.getCard("../escape", { cacheDir: localCache }), null);

  // A touched file changes the fingerprint (mtime), not the content digest.
  const later = new Date(Date.now() + 120_000);
  await fsp.utimes(path.join(model.dir, "config.json"), later, later);
  const touched = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
  assert.equal(touched.cached, false);
  assert.notEqual(touched.key, first.key);
  assert.equal(touched.card.contentDigest, first.card.contentDigest);

  // A new file changes it too.
  await fsp.writeFile(path.join(model.dir, "notes.md"), "notes\n");
  assert.equal((await models.inspectLocalDetailed(model.dir, { cacheDir: localCache })).cached, false);
  assert.equal((await models.inspectLocalDetailed(model.dir, { cacheDir: localCache })).cached, true);

  // refresh skips the cache; a corrupt or foreign-version cache file is a miss.
  assert.equal((await models.inspectLocalDetailed(model.dir, { cacheDir: localCache, refresh: true })).cached, false);
  await resetInspector();
  await fsp.writeFile(cacheFile, "{ not json");
  assert.equal((await models.inspectLocalDetailed(model.dir, { cacheDir: localCache })).cached, false);
  await resetInspector();
  const entry = JSON.parse(await fsp.readFile(cacheFile, "utf8"));
  await fsp.writeFile(cacheFile, JSON.stringify({ ...entry, inspectorVersion: "0.0.1" }));
  assert.equal((await models.inspectLocalDetailed(model.dir, { cacheDir: localCache })).cached, false);
  const leftovers = (await fsp.readdir(localCache)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "atomic writes leave no temporary files");

  // cache:false neither reads nor writes.
  const noCache = await tempDir(t, "model-cards-cache-");
  await resetInspector();
  assert.equal((await models.inspectLocalDetailed(model.dir, { cacheDir: noCache, cache: false })).cached, false);
  assert.deepEqual(await fsp.readdir(noCache), []);
});

test("concurrent inspections of one folder share one detection; a cache that cannot be written is logged once", async (t) => {
  const parent = await tempDir(t);
  const model = await materializeFixture("syn-mistral-small", { parent, name: "mistral" });
  const localCache = await tempDir(t, "model-cards-cache-");
  await resetInspector();
  const results = await Promise.all([1, 2, 3].map(() => models.inspectLocalDetailed(model.dir, { cacheDir: localCache })));
  assert.ok(results.every((result) => result.cached === false));
  assert.equal(new Set(results.map((result) => result.card.inspectedAt)).size, 1, "one detection for all three");

  // A cache "directory" that is a file: the card still comes back, and the
  // failure is logged once, not per inspection.
  const blocked = path.join(localCache, "not-a-directory");
  await fsp.writeFile(blocked, "");
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  await resetInspector();
  const card = await models.inspectLocal(model.dir, { cacheDir: blocked, logger });
  assert.equal(card.identity.modelType, "mistral");
  await models.inspectLocal(model.dir, { cacheDir: blocked, logger, refresh: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /model-card cache could not be written/);
});

test("a quick inspection never stands in for a full one", async (t) => {
  const localCache = await tempDir(t, "model-cards-cache-");
  const model = await fixtureModel("qwen38-27b-fp8");
  await resetInspector();
  const quick = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache, depth: "quick" });
  assert.equal(quick.card.weights.exact, false);
  assert.equal(quick.card.weights.byClass, null);
  assert.deepEqual(models.validateCard(quick.card).errors, []);
  const full = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
  assert.equal(full.cached, false, "quick facts do not answer a full request");
  assert.equal(full.card.weights.exact, true);
  await resetInspector();
  const quickAgain = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache, depth: "quick" });
  assert.equal(quickAgain.cached, true, "full facts answer a quick request");
  assert.equal(quickAgain.card.weights.exact, true);
});

// ---------------------------------------------------------------------------
// Performance and the event loop (02 §3: header parsing runs in the worker)

test("Flash-Next (418 files): cold inspect < 10 s without blocking the event loop > 100 ms; cached < 50 ms", async (t) => {
  const model = await fixtureModel("qwen38-flashnext-nvfp4");
  assert.equal(model.files.length, 418);
  const localCache = await tempDir(t, "model-cards-cache-");
  await resetInspector();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const started = performance.now();
  const cold = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
  const coldMs = performance.now() - started;
  histogram.disable();
  assert.equal(cold.cached, false);
  assert.ok(coldMs < 10_000, `cold inspect took ${Math.round(coldMs)} ms`);
  const maxDelayMs = histogram.max / 1e6;
  assert.ok(maxDelayMs < 100, `the event loop was blocked for ${maxDelayMs.toFixed(1)} ms`);

  const timed = async () => {
    const begin = performance.now();
    const result = await models.inspectLocalDetailed(model.dir, { cacheDir: localCache });
    assert.equal(result.cached, true);
    return performance.now() - begin;
  };
  // Best of three: one slow sample on a busy machine is noise, not the cache.
  const memoryMs = Math.min(await timed(), await timed(), await timed());
  assert.ok(memoryMs < 50, `cached inspect (memory) took ${memoryMs.toFixed(1)} ms`);
  const diskSamples = [];
  for (let index = 0; index < 3; index += 1) {
    await resetInspector();
    diskSamples.push(await timed());
  }
  const diskMs = Math.min(...diskSamples);
  assert.ok(diskMs < 50, `cached inspect (cache file) took ${diskMs.toFixed(1)} ms`);
});

test("a stuck inspection times out and the next one starts a fresh worker", async () => {
  const model = await fixtureModel("qwen38-27b-fp8");
  await resetInspector();
  await assert.rejects(
    models.inspectLocalDetailed(model.dir, { cacheDir, cache: false, timeoutMs: 1 }),
    (error) => error.code === "inspect_timeout" && error.status === 504,
  );
  const card = await models.inspectLocal(model.dir, { cacheDir, cache: false, refresh: true });
  assert.equal(card.weights.tensorBytes, 30866663264);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(models.inspectLocal(model.dir, { cacheDir, signal: aborted.signal }), (error) => error.code === "aborted");
});

test("a worker that dies during or between jobs fails that job only; the next job gets a new worker", async (t) => {
  const { createWorkerRunner } = require("../model-inspector/inspect");
  const dir = await tempDir(t);
  const file = path.join(dir, "flaky-worker.js");
  // Replies, then throws while idle; a message asking for it crashes mid-job.
  await fsp.writeFile(file, [
    "const { parentPort } = require('node:worker_threads');",
    "parentPort.on('message', (message) => {",
    "  if (message.crash) throw new Error('crash during a job');",
    "  parentPort.postMessage({ id: message.id, ok: true, facts: { pid: process.pid, n: message.n } });",
    "  setTimeout(() => { throw new Error('crash while idle'); }, 20);",
    "});",
  ].join("\n"));
  const runner = createWorkerRunner({ file, idleMs: 60_000 });
  t.after(() => runner.close());
  assert.deepEqual((await runner.run({ n: 1 })).n, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual((await runner.run({ n: 2 })).n, 2, "the idle crash did not take the caller down");
  await assert.rejects(runner.run({ crash: true }), (error) => error.code === "inspect_worker_failed");
  assert.deepEqual((await runner.run({ n: 3 })).n, 3);
});

test("the in-process detectors and the worker produce the same card", async () => {
  const model = await fixtureModel("deepseek-v4-flash-q2k-gguf");
  const viaWorker = await models.inspectLocal(model.dir, { cacheDir, cache: false, refresh: true });
  const inProcess = await models.inspectLocal(model.dir, { cacheDir, cache: false, refresh: true, inProcess: true });
  assert.deepEqual(stableCardProjection(inProcess), stableCardProjection(viaWorker));
});

// ---------------------------------------------------------------------------
// Damaged folders and path rules (02 §19, §20)

test("damaged downloads: missing and truncated shards, bad headers and bad JSON are reported, not thrown", async (t) => {
  const parent = await tempDir(t);
  const model = await materializeFixture("syn-llama3-8b", { parent, name: "damaged" });
  await fsp.rm(path.join(model.dir, "model-00004-of-00004.safetensors"));
  await fsp.truncate(path.join(model.dir, "model-00003-of-00004.safetensors"), 20000);
  await fsp.writeFile(path.join(model.dir, "model-00002-of-00004.safetensors"), Buffer.from([1, 2, 3]));
  await fsp.writeFile(path.join(model.dir, "generation_config.json"), "{ broken");
  const card = await models.inspectLocal(model.dir, { cacheDir });
  assert.equal(card.format.complete, false);
  assert.deepEqual(card.format.missing, ["model-00003-of-00004.safetensors", "model-00004-of-00004.safetensors"]);
  assert.equal(card.weights.exact, false);
  assert.deepEqual(card.errors.map((error) => `${error.code} ${error.file}`), [
    "json_invalid generation_config.json",
    "safetensors_header_invalid model-00002-of-00004.safetensors",
  ]);
  assert.ok(card.warnings.some((warning) => warning.code === "weights_missing"));
  assert.ok(card.warnings.some((warning) => warning.code === "weights_truncated"));
  assert.equal(card.sampling, null);
  assert.equal(card.identity.modelType, "llama", "the rest of the card is still inspected");
  assert.deepEqual(models.validateCard(card).errors, []);
});

test("a .complete.json marker without its shard is a missing shard", async (t) => {
  const dir = await tempDir(t);
  const { writeSafetensorsFile } = require("./helpers/safetensors-writer");
  writeSafetensorsFile(path.join(dir, "part-a.safetensors"), [{ name: "model.layers.0.mlp.weight", dtype: "BF16", shape: [4, 4] }]);
  await fsp.truncate(path.join(dir, "part-a.safetensors"), (await fsp.stat(path.join(dir, "part-a.safetensors"))).size + 32);
  await fsp.writeFile(path.join(dir, "part-a.complete.json"), "{}");
  await fsp.writeFile(path.join(dir, "part-b.complete.json"), "{}");
  await fsp.writeFile(path.join(dir, "config.json"), JSON.stringify({ model_type: "llama", num_hidden_layers: 1 }));
  const card = await models.inspectLocal(dir, { cacheDir });
  assert.deepEqual(card.format.missing, ["part-b.safetensors"]);
  assert.equal(card.format.complete, false);
});

test("inspect targets: a folder or a GGUF file; missing, non-model, UNC and out-of-library paths are refused", async (t) => {
  const dir = await tempDir(t);
  await fsp.writeFile(path.join(dir, "notes.txt"), "x");
  await assert.rejects(models.inspectLocal(path.join(dir, "absent"), { cacheDir }), (error) => error.code === "not_found" && error.status === 404);
  await assert.rejects(models.inspectLocal(path.join(dir, "notes.txt"), { cacheDir }), (error) => error.code === "not_a_model" && error.status === 422);
  await assert.rejects(models.inspectLocal("", { cacheDir }), (error) => error.code === "invalid_path");
  await assert.rejects(models.inspectLocal("\\\\server\\share\\model", { cacheDir }), (error) => error.code === "path_not_allowed");
  const library = await tempDir(t);
  await assert.rejects(models.inspectLocal(dir, { cacheDir, roots: [library] }), (error) => error.code === "path_outside_storage" && error.status === 400);
  const inside = path.join(library, "vendor", "model");
  await fsp.mkdir(inside, { recursive: true });
  const card = await models.inspectLocal(inside, { cacheDir, roots: [library] });
  assert.equal(card.ref.displayPath, "vendor/model");
  assert.equal(card.format.kind, "none");
});

// ---------------------------------------------------------------------------
// Projections and the namespace

test("projectCard: the summary, path redaction for viewers, and the template only on request", async () => {
  const model = await fixtureModel("qwen38-27b-fp8");
  const card = await models.inspectLocal(model.dir, { cacheDir });
  const summary = models.projectCard(card);
  assert.deepEqual(Object.keys(summary), [
    "cardId", "displayName", "role", "familyId", "familyLabel", "format", "quant", "weights", "topology", "context", "modalities", "template", "support", "confidence",
  ]);
  assert.equal(summary.displayName, path.basename(model.dir), "no declared name: the folder");
  assert.deepEqual(summary.quant, { method: "fp8", algo: "FP8" });
  assert.deepEqual(summary.confidence, { identity: "declared", template: "declared", weights: "detected" });

  assert.equal(card.template.text, undefined);
  const withTemplate = await models.inspectLocal(model.dir, { cacheDir, includeTemplate: true });
  assert.ok(withTemplate.template.text.includes("<tool_call>"));
  assert.deepEqual(models.validateCard(withTemplate).errors, []);
  assert.equal(models.projectCard(withTemplate, { view: "full" }).template.text, undefined);
  assert.ok(models.projectCard(withTemplate, { view: "full", includeTemplate: true }).template.text);

  const redacted = models.projectCard({ ...card, evidence: [...card.evidence, { fact: "/format/kind", source: { kind: "file", ref: "C:/elsewhere/x.json" }, confidence: "declared" }] }, { view: "full", redactPaths: true });
  assert.equal(redacted.ref.path, card.ref.displayPath);
  assert.equal(redacted.evidence[redacted.evidence.length - 1].source.ref, null);
  assert.equal(redacted.evidence[0].source.ref, card.evidence[0].source.ref, "folder-relative refs stay");
  assert.ok(path.isAbsolute(card.ref.path), "the projection never mutates the card");
});

test("require('manager-core') exposes models as a namespace without export collisions", () => {
  const warnings = [];
  const original = process.emitWarning;
  process.emitWarning = (message, options) => warnings.push({ message, code: options?.code });
  try {
    core.mergeExports(core.MODULES);
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(warnings.filter((item) => item.code === "MANAGER_CORE_EXPORT_COLLISION"), []);
  assert.equal(core.models, models);
  assert.ok(!core.MODULES.some((name) => name.includes("model-inspector")), "never spread into the flat exports");
  for (const name of ["inspectLocal", "inspectLocalDetailed", "getCard", "projectCard", "validateCard"]) {
    assert.equal(typeof core.models[name], "function", name);
  }
  assert.equal(typeof core.models.contentDigest.forDir, "function");
  assert.match(core.models.INSPECTOR_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(core.inspectLocal, undefined, "no flat inspector names");
});

// ---------------------------------------------------------------------------
// Building blocks

test("layer runs are the run-length encoding of the shortest repeating unit", () => {
  assert.deepEqual(layerRuns(["linear", "linear", "linear", "full", "linear", "linear", "linear", "full"]), [{ kind: "linear", count: 3 }, { kind: "full", count: 1 }]);
  assert.deepEqual(layerRuns(["swa", "full", "swa", "full", "swa"]), [{ kind: "swa", count: 1 }, { kind: "full", count: 1 }]);
  assert.deepEqual(layerRuns(["mla", "mla", "mla"]), [{ kind: "mla", count: 1 }]);
  assert.deepEqual(layerRuns(["full", "linear", "linear"]), [{ kind: "full", count: 1 }, { kind: "linear", count: 2 }]);
});

test("json-schema-lite: the subset validates, and unsupported keywords fail at compile time", () => {
  const schema = {
    $defs: { size: { type: "integer", minimum: 0 } },
    type: "object",
    required: ["kind", "size"],
    additionalProperties: false,
    properties: {
      kind: { enum: ["a", "b"] },
      size: { $ref: "#/$defs/size" },
      tags: { type: "array", items: { type: "string", pattern: "^[a-z]+$" }, uniqueItems: true, maxItems: 3 },
      extra: { oneOf: [{ type: "null" }, { type: "string", minLength: 2 }] },
    },
  };
  assert.deepEqual(validate(schema, { kind: "a", size: 1, tags: ["x"], extra: null }), { ok: true, errors: [] });
  const result = validate(schema, { kind: "c", size: -1, tags: ["x", "x", "Y"], extra: "z", other: 1 });
  assert.deepEqual(result.errors.map((error) => `${error.path} ${error.keyword}`).sort(), [
    "/extra oneOf", "/kind enum", "/other additionalProperties", "/size minimum", "/tags uniqueItems", "/tags/2 pattern",
  ]);
  assert.deepEqual(validate(schema, { kind: "a" }).errors, [{ path: "/size", keyword: "required", message: "is required" }]);
  assert.throws(() => compileSchema({ type: "object", propertys: {} }), /unsupported keyword "propertys"/);
  assert.throws(() => compileSchema({ $ref: "https://example.invalid/schema" }), /only local \$ref/);
  assert.throws(() => compileSchema({ pattern: "(" }), /not a valid regular expression/);
  assert.equal(validate({ type: "integer" }, 1.5).ok, false);
  assert.equal(validate({ type: "number" }, Number.NaN).ok, false);
});
