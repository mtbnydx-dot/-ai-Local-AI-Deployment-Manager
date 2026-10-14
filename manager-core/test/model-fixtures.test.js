"use strict";

// Model-card fixtures (docs/overhaul/02-models.md §21.1): the manifest
// contract, internal consistency of the tensor tables, and the round trip
// fixture → materialized folder → capture tool → same fixture, which keeps
// the fixtures, scripts/capture-model-fixture.js and the test helpers in step.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("..");
const capture = require("../../scripts/capture-model-fixture.js");
const {
  FIXTURES_ROOT,
  expandGroups,
  listFixtures,
  loadFixture,
  materializeFixture,
  resizeFiles,
  stableCardProjection,
} = require("./helpers/fixture-materialize");
const { DTYPE_BYTES } = require("./helpers/safetensors-writer");

const SYNTHETIC = [
  "syn-embedding-st",
  "syn-gemma4",
  "syn-glm45-air",
  "syn-gpt-oss-20b",
  "syn-kimi-k2",
  "syn-llama3-8b",
  "syn-lora-adapter",
  "syn-mamba2-gguf",
  "syn-mistral-small",
  "syn-mla-deepseek-v3",
  "syn-mmproj-gguf",
  "syn-muse-glimmer-gguf",
  "syn-nemotron3-nano",
  "syn-reranker-seqcls",
];
// Captured from the owner's library with the capture tool (02 §21.1).
const LIBRARY = [
  "qwen38-27b-fp8",
  "qwen38-27b-fp8-indexed",
  "qwen36-35b-a3b-fp8",
  "qwen38-flashnext-nvfp4",
  "qwen38-27b-dspark-draft",
  "ple-quant-tooling",
  "deepseek-v4-flash-q2k-gguf",
];
const LAYOUTS = new Set(["indexed", "unindexed-shards", "single", "gguf-split", "custom"]);
const KINDS = new Set(["captured", "safetensors", "gguf", "index", "placeholder"]);
const LICENSE_SOURCES = new Set(["cli", "readme", "license-file", "gguf"]);
const GENERATED = new Set(["manifest.json", "tensor-table.json", "gguf-header.json", "expected-card.json"]);
const SAMPLES_DIR = path.join(__dirname, "fixtures", "root-cause-samples");

function filesUnder(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full, base));
    else files.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return files.sort();
}

function isCapturedName(name) {
  return capture.CAPTURED_ROOT_FILES.has(name) || /^\d+_Pooling\/config\.json$/.test(name);
}

test("the synthetic family fixtures are present and marked synthetic", () => {
  const present = listFixtures();
  for (const id of SYNTHETIC) {
    assert.ok(present.includes(id), `${id} is missing`);
    assert.equal(loadFixture(id).manifest.synthetic, true, id);
  }
  assert.equal(SYNTHETIC.length, 14);
});

test("the library fixtures are present and captured from real folders", () => {
  const present = listFixtures();
  for (const id of LIBRARY) {
    assert.ok(present.includes(id), `${id} is missing (node scripts/capture-model-fixture.js --from <LIBRARY_ROOT>/<folder> --id ${id})`);
    const { manifest } = loadFixture(id);
    assert.equal(manifest.synthetic, false, id);
    assert.ok(manifest.notes.length > 0, `${id}: notes say what the fixture covers`);
    if (!capture.PERMISSIVE_LICENSES.has(manifest.license)) {
      assert.ok(manifest.notes.some((note) => note.includes("--allow-license")), `${id}: a non-permissive license is explained`);
    }
  }
  assert.equal(LIBRARY.length, 7);
});

function templateSha(id) {
  const text = fs.readFileSync(path.join(FIXTURES_ROOT, id, "chat_template.jinja"), "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function tensorBytes(tensors, pattern = /./) {
  return tensors.filter((tensor) => pattern.test(tensor.name)).reduce((sum, tensor) => sum + tensor.bytesEach, 0);
}

// The library facts 02 §1-§2 verified read-only; MOD-2/MOD-3 goldens build on them.
test("the library fixtures keep the facts the model spec verified", () => {
  const qwen38 = ["qwen38-27b-fp8", "qwen38-27b-fp8-indexed", "qwen38-flashnext-nvfp4"];
  for (const id of qwen38) assert.ok(templateSha(id).startsWith("c3cf9e34abf4f9e3"), `${id}: Qwen3.8 template`);
  assert.ok(templateSha("qwen36-35b-a3b-fp8").startsWith("e84f32a23fdda276"), "Qwen3.6 template");

  const config = (id) => JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, id, "config.json"), "utf8"));
  for (const id of ["qwen38-27b-fp8", "qwen38-27b-fp8-indexed"]) {
    const card = config(id);
    assert.equal(card.model_type, "qwen3_5", id);
    assert.deepEqual(card.architectures, ["Qwen3_5ForConditionalGeneration"], id);
    assert.deepEqual([card.text_config.hidden_size, card.text_config.num_hidden_layers, card.text_config.vocab_size], [5120, 64, 248320], id);
    const tensors = expandGroups(loadFixture(id).tensorTable.groups);
    assert.equal(tensorBytes(tensors), 30866663264, `${id}: 28.75 GiB of weights`);
    assert.ok(tensorBytes(tensors, /^mtp\./) > 0, `${id}: MTP tensors`);
  }
  assert.equal(loadFixture("qwen38-27b-fp8").manifest.layout, "indexed");
  assert.ok(loadFixture("qwen38-27b-fp8").manifest.files.some((entry) => entry.name === "layers-63.safetensors"), "layers-N shards");
  assert.equal(config("qwen36-35b-a3b-fp8").model_type, "qwen3_5_moe");

  const flash = loadFixture("qwen38-flashnext-nvfp4");
  assert.equal(config("qwen38-flashnext-nvfp4").model_type, "qwen4_exp");
  assert.equal(config("qwen38-flashnext-nvfp4").text_config.num_experts, 512);
  const quant = JSON.parse(fs.readFileSync(path.join(flash.dir, "hf_quant_config.json"), "utf8"));
  assert.equal(quant.producer.name, "modelopt");
  assert.equal(quant.quantization.quant_algo, "NVFP4");
  assert.equal(flash.manifest.files.filter((entry) => entry.name.endsWith(".complete.json")).length, 192);
  const flashTensors = expandGroups(flash.tensorTable.groups);
  assert.ok(flashTensors.some((tensor) => /\.experts\.511\./.test(tensor.name)), "512 routed experts");
  assert.ok(flashTensors.some((tensor) => /\.ple\./.test(tensor.name)), "PLE tensors");
  assert.ok(flashTensors.some((tensor) => /\.indexer\./.test(tensor.name)), "indexer tensors");

  const draft = loadFixture("qwen38-27b-dspark-draft");
  const draftConfig = config("qwen38-27b-dspark-draft");
  assert.deepEqual(draftConfig.architectures, ["DSparkDraftModel"]);
  assert.deepEqual([draftConfig.hidden_size, draftConfig.vocab_size, draftConfig.num_target_layers], [5120, 248320, 64]);
  assert.ok(draftConfig.auto_map && draftConfig.dflash_config, "auto_map and dflash_config");
  for (const name of ["dflash.py", "dspark.py"]) assert.equal(draft.manifest.files.find((entry) => entry.name === name).kind, "placeholder", name);

  const tooling = loadFixture("ple-quant-tooling");
  assert.equal(tooling.manifest.layout, "custom");
  assert.ok(!tooling.manifest.files.some((entry) => entry.name === "config.json"), "no config.json");
  assert.ok(tooling.manifest.files.every((entry) => entry.kind !== "safetensors" || entry.name.startsWith("ples_int4/")), "weights only in ples_int4/");

  const deepseek = loadFixture("deepseek-v4-flash-q2k-gguf").ggufHeader.files[0];
  const kv = Object.fromEntries(deepseek.kv.map((entry) => [entry.key, entry.value]));
  assert.equal(kv["general.architecture"], "deepseek4");
  assert.equal(kv["deepseek4.block_count"], 43);
  assert.equal(kv["deepseek4.attention.head_count_kv"], 1);
  assert.equal(kv["deepseek4.attention.key_length"], 512);
  assert.equal(kv["deepseek4.attention.sliding_window"], 128);
  const ratios = kv["deepseek4.attention.compress_ratios"];
  assert.equal(ratios.length, 44);
  assert.deepEqual([...ratios.slice(0, 4), ratios[42], ratios[43]], [0, 0, 4, 128, 4, 0]);
  assert.deepEqual([kv["deepseek4.attention.indexer.head_count"], kv["deepseek4.attention.indexer.key_length"], kv["deepseek4.attention.indexer.top_k"]], [64, 128, 512]);
  assert.deepEqual([kv["deepseek4.expert_count"], kv["deepseek4.expert_used_count"], kv["deepseek4.expert_shared_count"]], [256, 6, 1]);
  assert.equal(kv["deepseek4.nextn_predict_layers"], 1);
  assert.ok("general.sampling.temp" in kv && "general.sampling.top_p" in kv, "sampling defaults");
  assert.match(kv["tokenizer.chat_template"], /DSML/);
  const ggufTensors = expandGroups(deepseek.groups);
  const GiB = 1024 ** 3;
  assert.equal(tensorBytes(ggufTensors, /_exps\./), 88785027072);
  assert.equal((tensorBytes(ggufTensors, /_exps\./) / GiB).toFixed(2), "82.69");
  assert.equal(tensorBytes(ggufTensors), 97586411868);
  assert.equal((tensorBytes(ggufTensors, /^token_embd\./) / GiB).toFixed(2), "0.99");
  assert.equal((tensorBytes(ggufTensors, /^output\.weight$/) / GiB).toFixed(2), "0.52");
  assert.ok(ggufTensors.every((tensor) => tensor.bytesExact !== false), "every ggml type is known");
});

test("every fixture id is a known synthetic or library fixture", () => {
  const known = new Set([...SYNTHETIC, ...LIBRARY]);
  assert.deepEqual(listFixtures().filter((id) => !known.has(id)), []);
});

for (const id of listFixtures()) {
  test(`${id}: manifest contract and table consistency`, () => {
    const fixture = loadFixture(id);
    const { manifest, tensorTable, ggufHeader } = fixture;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.id, id);
    assert.equal(typeof manifest.synthetic, "boolean");
    assert.match(manifest.license, /^[a-z0-9][a-z0-9.+-]*$/, "manifest.license");
    assert.ok(LICENSE_SOURCES.has(manifest.licenseSource), "manifest.licenseSource");
    if (!capture.PERMISSIVE_LICENSES.has(manifest.license)) {
      assert.equal(manifest.synthetic, false, "a synthetic fixture needs a permissive license");
    }
    assert.ok(manifest.folderName && !/[\\/]/.test(manifest.folderName), "manifest.folderName");
    assert.ok(LAYOUTS.has(manifest.layout), `layout ${manifest.layout}`);
    assert.deepEqual(manifest.capturedWith, { tool: "scripts/capture-model-fixture.js", version: 1 });
    for (const key of ["notes", "warnings", "scrubbed", "files"]) assert.ok(Array.isArray(manifest[key]), key);
    if (manifest.synthetic) assert.ok(manifest.notes.length > 0, "synthetic fixtures say what they model");

    const names = manifest.files.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length, "unique file names");
    for (const entry of manifest.files) {
      assert.ok(KINDS.has(entry.kind), `${entry.name}: kind ${entry.kind}`);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, `${entry.name}: bytes`);
    }
    const captured = manifest.files.filter((entry) => entry.kind === "captured");
    for (const entry of captured) {
      assert.ok(isCapturedName(entry.name), `${entry.name} is not a captured file name`);
      assert.equal(fs.statSync(path.join(fixture.dir, ...entry.name.split("/"))).size, entry.bytes, `${entry.name}: bytes`);
    }
    const onDisk = filesUnder(fixture.dir).filter((name) => !GENERATED.has(name));
    assert.deepEqual(onDisk, captured.map((entry) => entry.name).sort(), "only captured files and tables are stored");

    const safetensors = manifest.files.filter((entry) => entry.kind === "safetensors");
    assert.equal(Boolean(tensorTable), safetensors.length > 0, "tensor-table.json iff safetensors files");
    if (tensorTable) {
      assert.equal(tensorTable.format, "safetensors");
      assert.deepEqual(tensorTable.files.map((file) => file.name), safetensors.map((entry) => entry.name));
      assert.equal(Boolean(tensorTable.index), manifest.files.some((entry) => entry.kind === "index"), "index entry");
      const tensors = expandGroups(tensorTable.groups);
      assert.equal(new Set(tensors.map((tensor) => `${tensor.file}\u0000${tensor.name}`)).size, tensors.length, "unique tensors");
      for (const file of tensorTable.files) {
        const inFile = tensors.filter((tensor) => tensor.file === file.name);
        assert.equal(inFile.length, file.tensors, `${file.name}: tensor count`);
        const payload = inFile.reduce((sum, tensor) => sum + tensor.bytesEach, 0);
        assert.ok(8 + file.headerBytes + payload <= file.bytes, `${file.name}: header + payload fit in the file`);
        assert.equal(manifest.files.find((entry) => entry.name === file.name).bytes, file.bytes);
      }
      for (const tensor of tensors) {
        const width = DTYPE_BYTES[tensor.dtype];
        if (width) assert.equal(tensor.bytesEach, tensor.shape.reduce((product, dim) => product * dim, width), `${tensor.name}: bytes`);
      }
    }

    const gguf = manifest.files.filter((entry) => entry.kind === "gguf");
    assert.equal(Boolean(ggufHeader), gguf.length > 0, "gguf-header.json iff GGUF headers");
    if (ggufHeader) {
      assert.equal(ggufHeader.format, "gguf");
      assert.deepEqual(ggufHeader.files.map((file) => file.name), gguf.map((entry) => entry.name));
      for (const file of ggufHeader.files) {
        const tensors = expandGroups(file.groups);
        assert.equal(tensors.length, file.tensorCount, `${file.name}: tensor count`);
        assert.equal(file.headerBytes % file.alignment, 0, `${file.name}: aligned data offset`);
        let end = 0;
        for (const tensor of tensors) {
          if (tensor.bytesExact !== false) {
            assert.equal(tensor.bytesEach, capture.ggmlTensorBytes(tensor.typeId, tensor.dims), `${tensor.name}: bytes`);
            assert.equal(tensor.type, capture.GGML_TYPES[tensor.typeId].name, `${tensor.name}: type name`);
          }
          end = Math.ceil(end / file.alignment) * file.alignment + tensor.bytesEach;
        }
        assert.ok(file.headerBytes + end <= file.bytes, `${file.name}: header + tensors fit in the file`);
        for (const entry of file.kv) {
          if (!entry.key.startsWith("tokenizer.ggml.") || entry.type !== "array") continue;
          assert.ok(entry.value && entry.value.$array, `${entry.key} keeps a count, not the vocabulary`);
          if (entry.itemType === "string") assert.deepEqual(entry.value.head, [], `${entry.key}: no tokens copied`);
        }
      }
    }
  });
}

// Compares a recapture with the stored fixture. Files the materializer could
// not reproduce byte for byte (no sparse files, or a real header whose JSON
// came out longer) are compared without their sizes.
function normalizeForCompare(name, text, inexact) {
  if (!name.endsWith(".json") || !["manifest.json", "tensor-table.json", "gguf-header.json"].includes(name)) return text;
  const value = JSON.parse(text);
  const dropSizes = (file) => {
    if (!inexact.has(file.name)) return file;
    const { bytes, headerBytes, ...rest } = file;
    return rest;
  };
  if (name === "manifest.json") {
    delete value.licenseSource;
    delete value.scrubbed;
    value.files = value.files.map(dropSizes);
    value.warnings = value.warnings.filter((warning) => !/_payload_short$/.test(warning.code));
  } else {
    value.files = value.files.map(dropSizes);
  }
  return value;
}

for (const id of listFixtures()) {
  test(`${id}: materialize then capture reproduces the fixture`, async (t) => {
    const fixture = loadFixture(id);
    const { manifest } = fixture;
    const materialized = await materializeFixture(id);
    t.after(materialized.cleanup);
    assert.equal(path.basename(materialized.dir), manifest.folderName);
    // Headers, index files and sizes match the captured folder (tensor order
    // and index style are recorded), so inspector goldens see true sizes.
    for (const file of materialized.files) {
      if (file.sized) assert.ok(file.exact, `${file.name}: materializes with its captured size`);
    }
    const built = capture.buildFixture({
      from: materialized.dir,
      id,
      license: manifest.license,
      allowLicense: true,
      synthetic: manifest.synthetic,
      notes: manifest.notes,
      needles: [],
    });
    const stored = filesUnder(fixture.dir).filter((name) => name !== "expected-card.json");
    assert.deepEqual(Array.from(built.files.keys()).sort(), stored);
    const inexact = new Set(materialized.files.filter((file) => !file.exact).map((file) => file.name));
    for (const [name, content] of built.files) {
      const expected = fs.readFileSync(path.join(fixture.dir, ...name.split("/")), "utf8");
      assert.deepEqual(normalizeForCompare(name, content, inexact), normalizeForCompare(name, expected, inexact), `${id}/${name}`);
    }
  });
}

test("materialized folders run the real header readers", async (t) => {
  const vision = await materializeFixture("syn-mmproj-gguf");
  t.after(vision.cleanup);
  const files = fs.readdirSync(vision.dir).filter((name) => name.endsWith(".gguf")).map((name) => {
    const full = path.join(vision.dir, name);
    return { path: full, name, size: fs.statSync(full).size };
  });
  const inventory = core.buildGgufInventory(files, { cache: false });
  assert.equal(inventory.models.length, 1);
  assert.equal(inventory.models[0].architecture, "qwen2vl");
  assert.equal(inventory.models[0].layers, 28);
  assert.equal(inventory.mmproj.length, 1);
  assert.equal(inventory.mmproj[0].architecture, "clip");

  const muse = await materializeFixture("syn-muse-glimmer-gguf");
  t.after(muse.cleanup);
  const metadata = core.readGgufMetadataSync(path.join(muse.dir, "Muse-Glimmer-28B-Q4_K_M.gguf"), { cache: false });
  assert.equal(metadata.architecture, "muse-glimmer");
  assert.equal(metadata.contextLength, 131072);
  assert.equal(metadata.slidingLayers, 39);
  const header = loadFixture("syn-muse-glimmer-gguf").ggufHeader.files[0];
  assert.equal(metadata.tensorCount, header.tensorCount);
  const elements = expandGroups(header.groups).reduce((sum, tensor) => sum + tensor.dims.reduce((product, dim) => product * dim, 1), 0);
  assert.equal(metadata.parameterCount, elements);

  const llama = await materializeFixture("syn-llama3-8b", { name: "renamed-llama" });
  t.after(llama.cleanup);
  assert.equal(path.basename(llama.dir), "renamed-llama");
  const shard = "model-00001-of-00004.safetensors";
  const read = capture.readSafetensorsHeader(path.join(llama.dir, shard), fs.statSync(path.join(llama.dir, shard)).size);
  const table = loadFixture("syn-llama3-8b").tensorTable;
  assert.equal(read.tensors.length, table.files[0].tensors);
  assert.equal(read.headerBytes, table.files[0].headerBytes);
  const index = JSON.parse(fs.readFileSync(path.join(llama.dir, "model.safetensors.index.json"), "utf8"));
  assert.equal(index.weight_map["lm_head.weight"], "model-00004-of-00004.safetensors");
  assert.equal(index.metadata.total_size, table.index.metadata.total_size);
});

test("header-only materialization keeps headers and reports unsized files", async (t) => {
  const materialized = await materializeFixture("syn-mamba2-gguf", { sizes: "header" });
  t.after(materialized.cleanup);
  const gguf = materialized.files.find((file) => file.kind === "gguf");
  assert.equal(gguf.sized, false);
  assert.equal(gguf.exact, false);
  assert.ok(gguf.actualBytes < gguf.bytes);
  const metadata = core.readGgufMetadataSync(path.join(materialized.dir, gguf.name), { cache: false });
  assert.equal(metadata.architecture, "mamba2");
});

// Where Windows cannot mark files sparse (FAT/exFAT, a share, fsutil blocked),
// everything extended counts against one budget: ple-quant-tooling alone would
// otherwise reserve 128 × 250 MB of real disk.
test("without sparse files, real extension stays within one budget per call", async (t) => {
  const marked = [];
  const failing = async (file) => {
    marked.push(path.basename(file));
    return false;
  };
  const budget = 4 * 1024 * 1024;
  const materialized = await materializeFixture("ple-quant-tooling", { platform: "win32", markSparse: failing, nonSparseBudget: budget });
  t.after(materialized.cleanup);
  assert.ok(marked.length >= 128, "every large file was offered to fsutil");
  const grown = materialized.files.filter((file) => file.kind !== "captured" && file.kind !== "index" && file.sized);
  assert.ok(grown.reduce((sum, file) => sum + file.actualBytes, 0) <= budget);
  const shards = materialized.files.filter((file) => file.bytes >= 1024 * 1024);
  assert.ok(shards.length >= 128);
  for (const file of shards) assert.equal(file.sized, false, `${file.name} stays at header size`);

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), "fixture-budget-"));
  t.after(() => fsp.rm(work, { recursive: true, force: true }));
  const entries = ["a", "b", "c"].map((name) => ({ file: path.join(work, name), bytes: 2 * 1024 * 1024 }));
  entries.push({ file: path.join(work, "small"), bytes: 4096 });
  for (const entry of entries) fs.writeFileSync(entry.file, "");
  const sized = await resizeFiles(entries, { platform: "win32", markSparse: failing, nonSparseBudget: budget });
  assert.deepEqual(entries.map((entry) => sized.get(entry.file)), [true, true, false, false]);
  assert.deepEqual(entries.map((entry) => fs.statSync(entry.file).size), [2 * 1024 * 1024, 2 * 1024 * 1024, 0, 0]);
  await assert.rejects(resizeFiles([entries[2]], { platform: "win32", markSparse: failing, nonSparseBudget: 1024, sizes: "real" }), /refusing to reserve/);
  // Marked files never count against the budget.
  const marking = await resizeFiles([entries[2]], { platform: "win32", markSparse: async () => true, nonSparseBudget: 0 });
  assert.equal(marking.get(entries[2].file), true);
});

test("stableCardProjection drops inspectedAt, ref and cardId", () => {
  const card = { schema: "modelcard/v1", cardId: "mc_x", inspectedAt: "2026-10-14T00:00:00.000Z", ref: { kind: "local" }, identity: { modelType: "llama" } };
  assert.deepEqual(stableCardProjection(card), { schema: "modelcard/v1", identity: { modelType: "llama" } });
});

test("root-cause samples are indexed and carry their trigger lines", () => {
  const index = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, "samples.json"), "utf8"));
  assert.equal(index.schemaVersion, 1);
  const files = fs.readdirSync(SAMPLES_DIR).filter((name) => name.endsWith(".log.fixture")).sort();
  assert.deepEqual(index.samples.map((sample) => sample.file).sort(), files);
  assert.equal(new Set(index.samples.map((sample) => sample.id)).size, index.samples.length);
  for (const sample of index.samples) {
    assert.equal(sample.file, `${sample.id}.log.fixture`);
    assert.ok(["vllm", "sglang", "llamacpp"].includes(sample.engineId), sample.id);
    assert.match(sample.expected.code, /^[a-z][a-z0-9_]*$/, sample.id);
    const text = fs.readFileSync(path.join(SAMPLES_DIR, sample.file), "utf8");
    assert.ok(text.includes(sample.trigger), `${sample.id}: trigger line`);
    // Only the traceback fallback has no signature; a descriptor addition is stubbed with a named id.
    assert.equal(sample.expected.signatureId === null, sample.expected.code === "engine_start_failed", `${sample.id}: signatureId`);
    if (sample.expected.signatureId !== null) assert.match(sample.expected.signatureId, /^[a-z][a-z0-9-]*$/, sample.id);
    const withSecrets = sample.expected.redactedWithSecrets || [];
    const byPatterns = sample.expected.redactedByPatterns || [];
    for (const secret of byPatterns) assert.ok(withSecrets.includes(secret), `${sample.id}: ${secret} is listed with the known secrets`);
    for (const secret of withSecrets) {
      assert.ok(text.includes(secret), `${sample.id}: carries ${secret}`);
      assert.ok(!core.redactSecrets(text, { secrets: withSecrets }).includes(secret), `${sample.id}: ${secret} is redacted as a known secret`);
    }
    const patternsOnly = core.redactSecrets(text);
    for (const secret of byPatterns) assert.ok(!patternsOnly.includes(secret), `${sample.id}: ${secret} is redacted by the default patterns`);
  }
});

// The llama.cpp loader lines must not contradict the GGUF fixture they name.
test("root-cause samples agree with the model fixture they describe", () => {
  const index = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, "samples.json"), "utf8"));
  const described = index.samples.filter((sample) => sample.modelFixture);
  assert.ok(described.length >= 2);
  for (const sample of described) {
    const text = fs.readFileSync(path.join(SAMPLES_DIR, sample.file), "utf8");
    const header = loadFixture(sample.modelFixture).ggufHeader.files[0];
    const tensors = expandGroups(header.groups);
    const kv = (key) => header.kv.find((entry) => entry.key === key)?.value;
    const arch = kv("general.architecture");
    assert.ok(text.includes(`/${header.name}`), `${sample.id}: file name ${header.name}`);
    const loaded = text.match(/loaded meta data with (\d+) key-value pairs and (\d+) tensors/);
    assert.ok(loaded, `${sample.id}: loader summary line`);
    assert.deepEqual([Number(loaded[1]), Number(loaded[2])], [header.kv.length, header.tensorCount], `${sample.id}: KV and tensor counts`);
    const types = [...text.matchAll(/- type\s+(\S+):\s+(\d+) tensors/g)];
    if (types.length) {
      const counts = {};
      for (const tensor of tensors) counts[tensor.type.toLowerCase()] = (counts[tensor.type.toLowerCase()] || 0) + 1;
      assert.deepEqual(Object.fromEntries(types.map((match) => [match[1].toLowerCase(), Number(match[2])])), counts, `${sample.id}: type counts`);
    }
    for (const match of text.matchAll(/- kv\s+(\d+):\s+(\S+)\s+\S+\s+= (.*)$/gm)) {
      const entry = header.kv[Number(match[1])];
      assert.equal(entry?.key, match[2], `${sample.id}: kv ${match[1]}`);
      // llama.cpp prints float32 values with six decimals.
      assert.equal(match[3], entry.type === "float32" ? Number(entry.value).toFixed(6) : String(entry.value), `${sample.id}: ${entry.key}`);
    }
    const info = Object.fromEntries([...text.matchAll(/^print_info: (\w+)\s+= (.*)$/gm)].map((match) => [match[1], match[2]]));
    const expected = {
      arch,
      n_ctx_train: kv(`${arch}.context_length`),
      n_embd: kv(`${arch}.embedding_length`),
      n_layer: kv(`${arch}.block_count`),
      n_expert: kv(`${arch}.expert_count`),
      n_expert_used: kv(`${arch}.expert_used_count`),
    };
    for (const [key, value] of Object.entries(expected)) {
      if (Object.hasOwn(info, key)) assert.equal(info[key], String(value), `${sample.id}: ${key}`);
    }
    const size = text.match(/^print_info: file size\s+= ([\d.]+) GiB \(([\d.]+) BPW\)$/m);
    if (size) {
      // llama.cpp prints the tensor bytes, not the file size.
      const bytes = tensors.reduce((sum, tensor) => sum + tensor.bytesEach, 0);
      const elements = tensors.reduce((sum, tensor) => sum + tensor.dims.reduce((product, dim) => product * dim, 1), 0);
      assert.deepEqual([size[1], size[2]], [(bytes / 2 ** 30).toFixed(2), (bytes * 8 / elements).toFixed(2)], `${sample.id}: file size`);
    }
  }
});
