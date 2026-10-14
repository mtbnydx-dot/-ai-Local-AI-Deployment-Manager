"use strict";

// Model-card fixtures (docs/overhaul/02-models.md §21.1): the manifest
// contract, internal consistency of the tensor tables, and the round trip
// fixture → materialized folder → capture tool → same fixture, which keeps
// the fixtures, scripts/capture-model-fixture.js and the test helpers in step.

const assert = require("node:assert/strict");
const fs = require("node:fs");
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

for (const id of LIBRARY) {
  const present = fs.existsSync(path.join(FIXTURES_ROOT, id, "manifest.json"));
  test(`library fixture ${id}`, {
    todo: present ? false : `owner capture: node scripts/capture-model-fixture.js --from <LIBRARY_ROOT>/<folder> --id ${id}`,
  }, () => {
    if (!present) return;
    const { manifest } = loadFixture(id);
    assert.equal(manifest.synthetic, false);
  });
}

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
    if (manifest.synthetic) {
      for (const file of materialized.files) {
        if (file.sized) assert.ok(file.exact, `${file.name}: a synthetic fixture materializes byte-exact`);
      }
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
    for (const secret of sample.expected.redacted || []) {
      assert.ok(text.includes(secret), `${sample.id}: carries ${secret}`);
      assert.ok(!core.redactSecrets(text, { secrets: sample.expected.redacted }).includes(secret), `${sample.id}: ${secret} is redactable`);
    }
  }
});
