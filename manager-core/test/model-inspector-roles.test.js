"use strict";

// Role detection and companion pairing (docs/overhaul/02-models.md §7, §21.2,
// MOD-4): the role table for every fixture, evidence behind each role, the
// DSpark draft pairing with Qwen3.8-27B, tooling-only folders that are not
// runnable, and the rules a fixture does not cover (mtp-head, name heuristics,
// GGUF pooling types, adapters, mismatched companions).

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const models = require("../model-inspector");
const { factsWithoutEvidence } = require("../model-inspector/card-schema");
const { createFactSet } = require("../model-inspector/evidence");
const { resetInspector } = require("../model-inspector/inspect");
const { detectRole, pairCompanions, writeRole } = require("../model-inspector/detectors/role");
const { listFixtures, materializeFixture } = require("./helpers/fixture-materialize");

// Fixture id -> [role, runnable, best evidence confidence].
const EXPECTED = Object.freeze({
  "deepseek-v4-flash-q2k-gguf": ["main", true, "detected"],
  "ple-quant-tooling": ["tooling-only", false, "detected"],
  "qwen36-35b-a3b-fp8": ["main", true, "detected"],
  "qwen38-27b-dspark-draft": ["draft", false, "declared"],
  "qwen38-27b-fp8": ["main", true, "detected"],
  "qwen38-27b-fp8-indexed": ["main", true, "detected"],
  "qwen38-flashnext-nvfp4": ["main", true, "detected"],
  "syn-embedding-st": ["embedding", true, "declared"],
  "syn-gemma4": ["main", true, "detected"],
  "syn-glm45-air": ["main", true, "detected"],
  "syn-gpt-oss-20b": ["main", true, "detected"],
  "syn-kimi-k2": ["main", true, "detected"],
  "syn-llama3-8b": ["main", true, "detected"],
  "syn-lora-adapter": ["adapter", false, "declared"],
  "syn-mamba2-gguf": ["main", true, "detected"],
  "syn-mistral-small": ["main", true, "detected"],
  "syn-mla-deepseek-v3": ["main", true, "detected"],
  "syn-mmproj-gguf": ["main", true, "detected"],
  "syn-muse-glimmer-gguf": ["main", true, "detected"],
  "syn-nemotron3-nano": ["main", true, "detected"],
  "syn-reranker-seqcls": ["reranker", true, "declared"],
});

let cacheDir;
const materialized = new Map();
const cleanups = [];

test.before(async () => {
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "model-roles-cache-"));
});

test.after(async () => {
  await resetInspector();
  for (const model of materialized.values()) await model.cleanup();
  for (const cleanup of cleanups) await cleanup();
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

async function fixtureModel(id) {
  if (!materialized.has(id)) materialized.set(id, await materializeFixture(id, { sizes: "header" }));
  return materialized.get(id);
}

async function fixtureCard(id, file) {
  const model = await fixtureModel(id);
  return models.inspectLocal(file ? path.join(model.dir, file) : model.dir, { cacheDir });
}

// A one-off fixture (manifest + tensor table + metadata) in a temp library.
async function syntheticModel({ id, files, config, tensors }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "model-roles-fixtures-"));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, id);
  await fsp.mkdir(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1, id, synthetic: true, folderName: id, layout: "single",
    files: files.map((name) => ({ name, bytes: name === "config.json" ? 0 : 1024, kind: name === "config.json" ? "captured" : "safetensors" })),
  };
  if (config) {
    const text = JSON.stringify(config);
    manifest.files.find((entry) => entry.name === "config.json").bytes = Buffer.byteLength(text);
    await fsp.writeFile(path.join(dir, "config.json"), text);
  }
  await fsp.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await fsp.writeFile(path.join(dir, "tensor-table.json"), JSON.stringify({
    format: "safetensors",
    index: null,
    files: files.filter((name) => name.endsWith(".safetensors")).map((name) => ({ name, bytes: 1024, tensors: tensors.length })),
    groups: tensors.map(([name, shape]) => ({ name, dtype: "BF16", shape, bytesEach: shape.reduce((a, b) => a * b, 2), file: files.find((item) => item.endsWith(".safetensors")) })),
  }));
  const model = await materializeFixture(id, { fixturesRoot: root, sizes: "header" });
  cleanups.push(() => model.cleanup());
  return model;
}

function fakeInventory(names, dir = path.join(os.tmpdir(), "fake-model")) {
  const kindOf = (name) => (name.endsWith(".gguf") ? "weights:gguf" : name.endsWith(".safetensors") ? "weights:safetensors" : name === "config.json" ? "config" : name === "modules.json" ? "modules" : name === "adapter_config.json" ? "adapter-config" : /^\d+_Pooling\/config\.json$/.test(name) ? "pooling" : "other");
  return { dir, files: names.map((name) => ({ name, size: 1024, mtimeMs: 0, kind: kindOf(name) })), skipped: [], truncated: false };
}

// ---------------------------------------------------------------------------
// §7 table over the fixtures

test("every fixture has an expected role, and the §7 table holds for each", async () => {
  assert.deepEqual(listFixtures(), Object.keys(EXPECTED).sort(), "a new fixture needs a row in EXPECTED");
  for (const id of listFixtures()) {
    const card = await fixtureCard(id);
    const [role, runnable, confidence] = EXPECTED[id];
    assert.deepEqual(card.role, { value: role, runnable }, id);
    assert.equal(models.evidence.confidenceOf(card, "/role/value"), confidence, `${id}: role confidence`);
    assert.equal(models.evidence.confidenceOf(card, "/role/runnable"), confidence, `${id}: runnable confidence`);
    assert.deepEqual(models.validateCard(card).errors, [], id);
    assert.deepEqual(factsWithoutEvidence(card), [], id);
    for (const entry of card.evidence.filter((item) => item.fact.startsWith("/role") || item.fact.startsWith("/compatibleWith"))) {
      assert.ok(!entry.source.ref || !/^(?:[A-Za-z]:|[\\/])/.test(entry.source.ref), `${id}: ${entry.source.ref}`);
    }
  }
});

test("only companions carry compatibleWith", async () => {
  for (const id of listFixtures()) {
    const card = await fixtureCard(id);
    if (["draft", "mtp-head", "mmproj", "adapter"].includes(card.role.value)) assert.ok(card.compatibleWith, id);
    else assert.equal(card.compatibleWith, null, id);
  }
});

test("tooling-only folders are detected and not runnable", async () => {
  const card = await fixtureCard("ple-quant-tooling");
  assert.deepEqual(card.role, { value: "tooling-only", runnable: false });
  assert.equal(card.format.layout, "custom");
  const [entry] = card.evidence.filter((item) => item.fact === "/role/value");
  assert.equal(entry.confidence, "detected");
  assert.match(entry.note.en, /config\.json/);
  assert.deepEqual(models.projectCard(card, { view: "summary" }).role, { value: "tooling-only", runnable: false });
});

test("the DSpark draft is a declared draft with the compatibleWith block from the spec", async () => {
  const card = await fixtureCard("qwen38-27b-dspark-draft");
  assert.deepEqual(card.role, { value: "draft", runnable: false });
  assert.deepEqual(card.compatibleWith, { hiddenSize: 5120, vocabSize: 248320, targetLayers: 64 });
  const facts = card.evidence.filter((item) => item.fact === "/role/value").map((item) => `${item.source.ref}:${item.confidence}`);
  assert.ok(facts.includes("config.json#/architectures:declared"), facts.join(", "));
  assert.ok(facts.includes("config.json#/dflash_config:declared"), facts.join(", "));
  assert.ok(facts.includes("config.json#/num_target_layers:declared"), facts.join(", "));
  assert.equal(models.evidence.confidenceOf(card, "/compatibleWith/targetLayers"), "declared");
});

// ---------------------------------------------------------------------------
// Pairing

test("the DSpark draft pairs with Qwen3.8-27B and with nothing else in the library", async () => {
  const cards = [];
  for (const id of listFixtures()) cards.push(await fixtureCard(id));
  const draft = cards.find((card) => card.identity.architectures?.[0] === "DSparkDraftModel");
  const pairings = pairCompanions(cards);
  const draftPairs = pairings.filter((pairing) => pairing.companion === draft.cardId);
  const targets = draftPairs.map((pairing) => cards.find((card) => card.cardId === pairing.main));
  assert.ok(targets.length >= 1);
  for (const target of targets) {
    assert.equal(target.topology.hiddenSize, 5120);
    assert.equal(target.topology.vocabSize, 248320);
    assert.equal(target.topology.layers, 64);
    assert.equal(target.identity.modelType, "qwen3_5");
  }
  // The FP8 checkpoint and its indexed twin are the same model, two folders.
  assert.equal(targets.length, 2);
  for (const pairing of draftPairs) {
    assert.equal(pairing.role, "draft");
    assert.equal(pairing.basis, "shape");
    assert.equal(pairing.confidence, "detected");
    assert.deepEqual(pairing.checks, { vocabSize: true, hiddenSize: true, targetLayers: true });
  }
  assert.equal(pairings.filter((pairing) => pairing.role !== "draft" && pairing.basis === "shape").length, 0, "no other companion pairs by shape");
});

test("pairing is stable regardless of the order of the cards", async () => {
  const cards = [];
  for (const id of ["qwen38-27b-fp8", "qwen38-27b-dspark-draft", "qwen36-35b-a3b-fp8", "qwen38-27b-fp8-indexed"]) cards.push(await fixtureCard(id));
  assert.deepEqual(pairCompanions([...cards].reverse()), pairCompanions(cards));
});

test("a draft does not pair when the layer count or the hidden size differs", async () => {
  const draft = await fixtureCard("qwen38-27b-dspark-draft");
  const main = await fixtureCard("qwen38-27b-fp8");
  assert.equal(pairCompanions([draft, main]).length, 1);
  const otherLayers = { ...main, topology: { ...main.topology, layers: 48 } };
  assert.deepEqual(pairCompanions([draft, otherLayers]), []);
  const otherHidden = { ...main, topology: { ...main.topology, hiddenSize: 4096 } };
  assert.deepEqual(pairCompanions([draft, otherHidden]), []);
  const otherVocab = { ...main, topology: { ...main.topology, vocabSize: 151936 } };
  assert.deepEqual(pairCompanions([draft, otherVocab]), []);
  // targetLayers absent: any layer count is fine once vocab and hidden agree.
  const open = { ...draft, compatibleWith: { hiddenSize: 5120, vocabSize: 248320 } };
  assert.equal(pairCompanions([open, otherLayers]).length, 1);
  // vocabSize unknown on the companion never pairs across folders.
  const noVocab = { ...draft, compatibleWith: { hiddenSize: 5120, targetLayers: 64 } };
  assert.equal(pairCompanions([noVocab, main]).length, 1, "vocab is only compared when the companion states it");
});

test("a GGUF projector pairs with the main GGUF of its own folder first", async () => {
  const main = await fixtureCard("syn-mmproj-gguf", "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf");
  const projector = await fixtureCard("syn-mmproj-gguf", "mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf");
  assert.deepEqual(main.role, { value: "main", runnable: true });
  assert.deepEqual(projector.role, { value: "mmproj", runnable: false });
  assert.deepEqual(projector.compatibleWith, { projectionDim: main.topology.hiddenSize });
  assert.equal(main.topology.hiddenSize, 3584);
  assert.equal(models.evidence.confidenceOf(projector, "/role/value"), "declared");
  assert.equal(models.evidence.confidenceOf(projector, "/compatibleWith/projectionDim"), "declared");
  const dspark = await fixtureCard("qwen38-27b-dspark-draft");
  const qwen = await fixtureCard("qwen38-27b-fp8");
  const pairings = pairCompanions([dspark, qwen, projector, main]);
  assert.equal(pairings[0].basis, "same-folder");
  assert.equal(pairings[0].companion, projector.cardId);
  assert.equal(pairings[0].main, main.cardId);
  assert.deepEqual(pairings.filter((pairing) => pairing.companion === projector.cardId).map((pairing) => pairing.main), [main.cardId]);
  // The folder card of the same directory describes the main model and lists the projector.
  const folder = await fixtureCard("syn-mmproj-gguf");
  assert.deepEqual(folder.role, { value: "main", runnable: true });
  assert.deepEqual(folder.modalities.projectorFiles, ["mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf"]);
});

test("a projector whose dimension differs from the main hidden size does not pair", async () => {
  const main = await fixtureCard("syn-mmproj-gguf", "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf");
  const projector = await fixtureCard("syn-mmproj-gguf", "mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf");
  const wrong = { ...projector, compatibleWith: { projectionDim: 4096 } };
  assert.deepEqual(pairCompanions([wrong, main]), []);
  const qwen = await fixtureCard("qwen38-27b-fp8");
  assert.deepEqual(pairCompanions([projector, qwen]), [], "another folder pairs only on a matching dimension");
});

test("an adapter pairs with the main named as its base model", async () => {
  const adapter = await fixtureCard("syn-lora-adapter");
  assert.deepEqual(adapter.compatibleWith, { baseModel: "meta-llama/Llama-3.1-8B-Instruct" });
  const llama = await fixtureCard("syn-llama3-8b");
  const named = { ...llama, origin: { source: "hf", repo: "meta-llama/Llama-3.1-8B-Instruct", revisionSha: null } };
  const pairings = pairCompanions([adapter, named, llama]);
  assert.deepEqual(pairings.map((pairing) => [pairing.role, pairing.main]), [["adapter", named.cardId]]);
  assert.deepEqual(pairCompanions([adapter, llama]), [], "no name, no pairing");
});

test("pairCompanions ignores cards that are neither mains nor companions", () => {
  assert.deepEqual(pairCompanions([]), []);
  assert.deepEqual(pairCompanions(null), []);
  assert.deepEqual(pairCompanions([{ cardId: "mc_a", role: null }, { cardId: "mc_b", role: { value: "embedding", runnable: true } }]), []);
});

// ---------------------------------------------------------------------------
// Rules the fixtures do not cover

test("a file holding only MTP tensors is an mtp-head", async () => {
  const model = await syntheticModel({
    id: "synthetic-mtp-head",
    files: ["config.json", "model.safetensors"],
    config: { model_type: "qwen3_5_mtp", hidden_size: 64, vocab_size: 1000, num_hidden_layers: 1, num_attention_heads: 4 },
    tensors: [["mtp.fc.weight", [64, 128]], ["mtp.layers.0.mlp.up_proj.weight", [128, 64]], ["mtp.norm.weight", [64]]],
  });
  const card = await models.inspectLocal(model.dir, { cacheDir });
  assert.deepEqual(card.role, { value: "mtp-head", runnable: false });
  assert.equal(models.evidence.confidenceOf(card, "/role/value"), "detected");
  assert.deepEqual(card.compatibleWith, { hiddenSize: 64, vocabSize: 1000 });
  assert.deepEqual(factsWithoutEvidence(card), []);

  // The same tensors beside a main's own embedding and LM head make a main.
  const full = await syntheticModel({
    id: "synthetic-mtp-packaged",
    files: ["config.json", "model.safetensors"],
    config: { model_type: "qwen3_5", architectures: ["Qwen3_5ForCausalLM"], hidden_size: 64, vocab_size: 1000, num_hidden_layers: 1, num_attention_heads: 4 },
    tensors: [["model.embed_tokens.weight", [1000, 64]], ["lm_head.weight", [1000, 64]], ["mtp.fc.weight", [64, 128]]],
  });
  assert.deepEqual((await models.inspectLocal(full.dir, { cacheDir })).role, { value: "main", runnable: true });
});

test("a folder named like a reranker is a name-heuristic reranker, never declared", async () => {
  const model = await syntheticModel({
    id: "Synthetic-Reranker-0.6B",
    files: ["config.json", "model.safetensors"],
    config: { model_type: "qwen3", architectures: ["Qwen3ForCausalLM"], hidden_size: 64, vocab_size: 1000, num_hidden_layers: 1, num_attention_heads: 4 },
    tensors: [["model.embed_tokens.weight", [1000, 64]], ["lm_head.weight", [1000, 64]]],
  });
  const card = await models.inspectLocal(model.dir, { cacheDir });
  assert.deepEqual(card.role, { value: "reranker", runnable: true });
  assert.equal(models.evidence.confidenceOf(card, "/role/value"), "name-heuristic");
  assert.ok(card.evidence.filter((item) => item.fact === "/role/value").every((item) => item.source.kind === "name" && item.source.ref === null));
});

test("weights without an LM head and no companion marker leave the role unknown", async () => {
  const model = await syntheticModel({
    id: "synthetic-encoder",
    files: ["config.json", "model.safetensors"],
    config: { model_type: "vit", architectures: ["ViTModel"], hidden_size: 64, num_hidden_layers: 1, num_attention_heads: 4 },
    tensors: [["encoder.layer.0.attention.q.weight", [64, 64]]],
  });
  const card = await models.inspectLocal(model.dir, { cacheDir });
  assert.equal(card.role, null);
  assert.deepEqual(models.validateCard(card).errors, []);
  assert.ok(card.evidence.some((item) => item.fact === "/role" && /unknown/i.test(item.note?.en || "")));
});

test("detectRole follows the §7 order and the GGUF keys", () => {
  const detect = (names, ctx, dir) => detectRole(createFactSet(), fakeInventory(names, dir), ctx);
  const gguf = (kv, file = "model.gguf") => ({ kv, file });

  // adapter: GGUF general.type
  assert.equal(detect(["a.gguf"], { gguf: gguf({ "general.architecture": "llama", "general.type": "adapter" }, "a.gguf") }).role, "adapter");
  // mmproj: clip.* keys, architecture clip, a Projector architecture, and the file name alone
  assert.equal(detect(["m.gguf"], { gguf: gguf({ "general.architecture": "x", "clip.vision.projection_dim": 8 }, "m.gguf") }).role, "mmproj");
  assert.equal(detect(["m.gguf"], { gguf: gguf({ "general.architecture": "clip" }, "m.gguf") }).role, "mmproj");
  assert.equal(detect(["config.json", "model.safetensors"], { config: { architectures: ["InternVLProjectorModel"] } }).role, "mmproj");
  const byName = detect(["mmproj-x.gguf"], { gguf: gguf({ "general.architecture": "llama", "general.type": "model" }, "mmproj-x.gguf") });
  assert.deepEqual([byName.role, byName.evidence[0].confidence], ["mmproj", "name-heuristic"]);
  // draft: GGUF type, dflash architecture, file name (heuristic only)
  assert.equal(detect(["d.gguf"], { gguf: gguf({ "general.architecture": "llama", "general.type": "draft" }, "d.gguf") }).role, "draft");
  assert.equal(detect(["d.gguf"], { gguf: gguf({ "general.architecture": "dflash-qwen" }, "d.gguf") }).role, "draft");
  const draftName = detect(["Foo-DFlash-Q4.gguf"], { gguf: gguf({ "general.architecture": "llama" }, "Foo-DFlash-Q4.gguf") });
  assert.deepEqual([draftName.role, draftName.runnable, draftName.evidence[0].confidence], ["draft", false, "name-heuristic"]);
  for (const architecture of ["EagleModel", "Eagle3ForCausalLM", "MedusaForCausalLM", "FooDraftModel", "DFlashDraftModel"]) {
    assert.equal(detect(["config.json", "model.safetensors"], { config: { architectures: [architecture] } }).role, "draft", architecture);
  }
  assert.equal(detect(["config.json", "model.safetensors"], { config: { architectures: ["LlamaForCausalLM"], eagle_config: {} } }).role, "draft");
  // embedding: GGUF pooling types (names and ids), not for causal attention; rank is a reranker
  for (const pooling of ["mean", "cls", "last", 1, 2, 3]) {
    assert.equal(detect(["e.gguf"], { gguf: gguf({ "general.architecture": "bert", "bert.pooling_type": pooling }, "e.gguf") }).role, "embedding", String(pooling));
  }
  assert.equal(detect(["e.gguf"], { gguf: gguf({ "general.architecture": "qwen3", "qwen3.pooling_type": "last", "qwen3.attention.causal": true }, "e.gguf"), stats: { byClass: { lmHead: 1, embedding: 1 }, classCounts: { dense: 1 } } }).role, "main");
  for (const pooling of ["rank", 4]) {
    const result = detect(["r.gguf"], { gguf: gguf({ "general.architecture": "bert", "bert.pooling_type": pooling }, "r.gguf") });
    assert.deepEqual([result.role, result.runnable, result.evidence[0].confidence], ["reranker", true, "declared"], String(pooling));
  }
  // embedding architectures need an absent LM head
  const bert = { config: { architectures: ["BertModel"] }, stats: { byClass: { lmHead: 0, embedding: 10 }, classCounts: { dense: 3 } } };
  assert.equal(detect(["config.json", "model.safetensors"], bert).role, "embedding");
  const bertLm = { config: { architectures: ["BertModel"] }, stats: { byClass: { lmHead: 10, embedding: 10 }, classCounts: { dense: 3 } } };
  assert.equal(detect(["config.json", "model.safetensors"], bertLm).role, "main");
  // sequence classification needs a single label
  const twoLabels = { config: { architectures: ["XLMRobertaForSequenceClassification"], num_labels: 2 }, stats: { byClass: { lmHead: 0, embedding: 1 }, classCounts: { dense: 1 } } };
  assert.notEqual(detect(["config.json", "model.safetensors"], twoLabels).role, "reranker");
  const oneLabel = { config: { architectures: ["XLMRobertaForSequenceClassification"], num_labels: 1 }, stats: { byClass: { lmHead: 0, embedding: 1 }, classCounts: { dense: 1 } } };
  assert.equal(detect(["config.json", "model.safetensors"], oneLabel).role, "reranker");
  // tooling-only wins over everything when nothing loadable sits at the root
  assert.equal(detect(["README.md", "quant.py", "sub/shard_0.safetensors"], {}).role, "tooling-only");
  assert.equal(detect(["adapter_config.json"], {}).role, "tooling-only");
  // an unreadable GGUF still counts as weights at the root: not tooling-only
  assert.notEqual(detect(["broken.gguf"], { gguf: null }).role, "tooling-only");
  // a quick inspection has no tensor stats; the architecture decides
  assert.equal(detect(["config.json", "model.safetensors"], { config: { architectures: ["LlamaForCausalLM"] }, stats: null }).role, "main");
  assert.equal(detect(["config.json", "model.safetensors"], { config: { architectures: ["SomethingElse"] }, stats: null }).role, null);
});

test("a quick inspection still resolves the role of an indexed checkpoint", async () => {
  const model = await fixtureModel("qwen38-27b-fp8-indexed");
  const card = await models.inspectLocal(model.dir, { cacheDir, depth: "quick", cache: false });
  assert.deepEqual(card.role, { value: "main", runnable: true });
});

test("writeRole stores role and companion fields with evidence and nothing for an unknown role", () => {
  const facts = createFactSet();
  facts.set("/topology/hiddenSize", 128, { kind: "file", ref: "config.json#/hidden_size" }, "declared");
  facts.set("/topology/vocabSize", 1000, { kind: "file", ref: "config.json#/vocab_size" }, "declared");
  const config = { architectures: ["EagleModel"], num_target_layers: 12 };
  const ctx = { config };
  writeRole(facts, detectRole(facts, fakeInventory(["config.json", "model.safetensors"]), ctx), ctx);
  assert.deepEqual(facts.data.role, { value: "draft", runnable: false });
  assert.deepEqual(facts.data.compatibleWith, { hiddenSize: 128, vocabSize: 1000, targetLayers: 12 });
  for (const pointer of ["/role/value", "/role/runnable", "/compatibleWith/hiddenSize", "/compatibleWith/vocabSize", "/compatibleWith/targetLayers"]) {
    assert.ok(facts.evidence.some((item) => item.fact === pointer), pointer);
  }
  const unknown = createFactSet();
  writeRole(unknown, { role: null, runnable: false, evidence: [{ fact: "/role/value", value: null, source: { kind: "file", ref: null }, confidence: "detected", note: "x" }] });
  assert.equal(unknown.data.role, undefined);
});
