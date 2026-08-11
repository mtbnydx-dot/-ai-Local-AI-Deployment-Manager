"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = require("..");

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value));
  return buffer;
}

function i32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(Number(value));
  return buffer;
}

function f32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(Number(value));
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function ggufString(value) {
  const content = Buffer.from(String(value), "utf8");
  return Buffer.concat([u64(content.length), content]);
}

function ggufValue(value) {
  if (typeof value === "string") return [8, ggufString(value)];
  if (typeof value === "boolean") return [7, Buffer.from([value ? 1 : 0])];
  if (Number.isInteger(value) && value >= 0) return [4, u32(value)];
  if (Number.isInteger(value)) return [5, i32(value)];
  if (typeof value === "number") return [6, f32(value)];
  if (Array.isArray(value)) {
    const elementType = value.every((item) => typeof item === "boolean") ? 7 : 4;
    const encoded = value.map((item) => elementType === 7 ? Buffer.from([item ? 1 : 0]) : u32(item));
    return [9, Buffer.concat([u32(elementType), u64(value.length), ...encoded])];
  }
  throw new Error(`Unsupported test GGUF value ${value}`);
}

function fakeGguf(metadata, tensors = [], paddingBytes = 0) {
  const kv = [];
  for (const [key, value] of Object.entries(metadata)) {
    const [type, encoded] = ggufValue(value);
    kv.push(ggufString(key), u32(type), encoded);
  }
  const descriptors = [];
  for (const [index, tensor] of tensors.entries()) {
    descriptors.push(
      ggufString(tensor.name || `tensor.${index}`),
      u32(tensor.dims.length),
      ...tensor.dims.map(u64),
      u32(tensor.type || 0),
      u64(0),
    );
  }
  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(3),
    u64(tensors.length),
    u64(Object.keys(metadata).length),
    ...kv,
    ...descriptors,
    Buffer.alloc(paddingBytes),
  ]);
}

function museMetadata(overrides = {}) {
  return {
    "general.architecture": "muse-glimmer",
    "general.type": "model",
    "general.name": "Muse Glimmer Test",
    "general.size_label": "28B",
    "general.file_type": 15,
    "muse-glimmer.block_count": 52,
    "muse-glimmer.context_length": 131072,
    "muse-glimmer.embedding_length": 6656,
    "muse-glimmer.attention.head_count": 32,
    "muse-glimmer.attention.head_count_kv": 2,
    "muse-glimmer.attention.key_length": 128,
    "muse-glimmer.attention.value_length": 128,
    "muse-glimmer.attention.sliding_window": 2048,
    "muse-glimmer.attention.sliding_window_pattern": Array.from({ length: 52 }, (_, index) => index % 4 !== 3),
    ...overrides,
  };
}

test("GGUF inventory separates Muse model variants from mmproj and DFlash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gguf-inventory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modelDir = path.join(root, "Muse-Glimmer-GGUF");
  await fs.mkdir(modelDir, { recursive: true });
  const dynamic = path.join(modelDir, "muse-glimmer-30B-kquant-dynamic.gguf");
  const compact = path.join(modelDir, "muse-glimmer-30B-kquant-17gb.gguf");
  await fs.writeFile(dynamic, fakeGguf(museMetadata(), [{ dims: [1000, 2000] }], 4096));
  await fs.writeFile(compact, fakeGguf(museMetadata(), [{ dims: [1000, 2000] }], 1024));
  await fs.writeFile(path.join(modelDir, "mmproj-kquant.gguf"), fakeGguf({
    "general.architecture": "clip",
    "general.type": "projector",
  }, [{ dims: [100, 200] }]));
  await fs.writeFile(path.join(modelDir, "dflash-kquant.gguf"), fakeGguf({
    "general.architecture": "dflash",
    "general.type": "model",
  }, [{ dims: [100, 300] }]));

  const store = core.createModelFilesystemStore({ modelsRoot: root, hfCache: path.join(root, "cache") });
  const described = store.describeLocalModelPath(modelDir);
  assert.equal(described.ggufVariants.length, 2);
  assert.deepEqual(described.ggufInventory.models.map((item) => item.name), [
    "muse-glimmer-30B-kquant-dynamic.gguf",
    "muse-glimmer-30B-kquant-17gb.gguf",
  ]);
  assert.equal(described.ggufInventory.mmproj[0].name, "mmproj-kquant.gguf");
  assert.equal(described.ggufInventory.drafts[0].name, "dflash-kquant.gguf");
  assert.equal(described.ggufInventory.selectedModel.path, dynamic);
  assert.equal(described.ggufInventory.selectedModel.architecture, "muse-glimmer");
  assert.equal(described.ggufInventory.selectedModel.parameterCount, 2_000_000);
  assert.equal(described.ggufInventory.selectedModel.layers, 52);
  assert.equal(described.ggufInventory.selectedModel.kvHeads, 2);
  assert.equal(described.ggufInventory.selectedModel.contextLength, 131072);
  assert.equal(described.ggufInventory.selectedModel.slidingWindow, 2048);
  assert.equal(described.ggufInventory.selectedModel.slidingLayers, 39);
  assert.equal(described.ggufInventory.selectedModel.globalLayers, 13);
  assert.equal(store.resolveGgufSelection(compact).selectedModel.path, compact);
});

test("GGUF inventory groups complete shards and sums bytes and parameters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gguf-shards-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, "model-Q4_K_M-00001-of-00002.gguf");
  const second = path.join(root, "model-Q4_K_M-00002-of-00002.gguf");
  await fs.writeFile(first, fakeGguf(museMetadata({ "split.no": 0, "split.count": 2 }), [{ dims: [100, 10] }], 100));
  await fs.writeFile(second, fakeGguf(museMetadata({ "split.no": 1, "split.count": 2 }), [{ dims: [200, 10] }], 200));
  const files = await Promise.all([first, second].map(async (file) => ({ path: file, name: path.basename(file), size: (await fs.stat(file)).size })));
  const inventory = core.buildGgufInventory(files);
  assert.equal(inventory.models.length, 1);
  assert.equal(inventory.models[0].path, first);
  assert.equal(inventory.models[0].shardCount, 2);
  assert.equal(inventory.models[0].complete, true);
  assert.equal(inventory.models[0].parameterCount, 3000);
  assert.equal(inventory.models[0].fileBytes, files[0].size + files[1].size);
});

test("GGUF KV estimate honors cache dtype, sliding window, and GPU layers", () => {
  const model = {
    layers: 52,
    kvLayers: 52,
    kvHeads: 2,
    keyLength: 128,
    valueLength: 128,
    slidingWindow: 2048,
    slidingWindowPattern: Array.from({ length: 52 }, (_, index) => index % 4 !== 3),
  };
  const f16 = core.estimateGgufKvBytes(model, { maxModelLen: 131072, maxNumSeqs: 1, cacheTypeK: "f16", cacheTypeV: "f16" });
  const q8 = core.estimateGgufKvBytes(model, { maxModelLen: 131072, maxNumSeqs: 1, cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
  const withoutSliding = core.estimateGgufKvBytes({ ...model, slidingWindow: null, slidingWindowPattern: null }, { maxModelLen: 131072, maxNumSeqs: 1, cacheTypeK: "f16", cacheTypeV: "f16" });
  assert.ok(q8 < f16);
  assert.ok(f16 < withoutSliding);
  assert.equal(core.gpuLayerFraction(26, 52), 0.5);
  assert.equal(core.gpuLayerFraction(0, 52), 0);
  assert.equal(core.gpuLayerFraction("all", 52), 1);
});
