"use strict";

// Widened GGUF parser (docs/overhaul/02-models.md §5.1, MOD-2): every KV pair,
// tensor infos with exact bytes from model-inspector/ggml-types.js, and the
// buffer parser whose partial mode drives the remote Range reader (§6.1).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = require("..");
const gguf = require("../gguf-metadata");
const { GGML_TYPES, GGML_TYPE_IDS, ggmlTensorBytes, ggmlTypeInfo } = require("../model-inspector/ggml-types");
const capture = require("../../scripts/capture-model-fixture.js");
const { expandGroups, listFixtures, loadFixture, materializeFixture } = require("./helpers/fixture-materialize");
const { buildGguf, fakeGguf } = require("./helpers/gguf-writer");

const GiB = 1024 ** 3;
const MiB = 1024 * 1024;
const DEEPSEEK = "deepseek-v4-flash-q2k-gguf";
const EXPERT_TENSOR = /^blk\.\d+\.ffn_(?:gate|up|down|gate_up)_exps\./;

function sumBytes(tensors, pattern = null) {
  return tensors.filter((tensor) => !pattern || pattern.test(tensor.name)).reduce((sum, tensor) => sum + tensor.bytes, 0);
}

// Header-only copies: the parser reads nothing past the tensor-info table, so
// the 97 GB payload is never needed (and never reserved on disk).
async function materializedHeaders(t, id) {
  const materialized = await materializeFixture(id, { sizes: "header" });
  t.after(() => materialized.cleanup());
  return materialized.files
    .filter((file) => file.kind === "gguf")
    .map((file) => ({ ...file, file: path.join(materialized.dir, file.name) }));
}

function capturedFile(id, name) {
  return loadFixture(id).ggufHeader.files.find((file) => file.name === name);
}

// The widened kv against a captured gguf-header.json: plain values are equal;
// an array placeholder is { $array, count } when over 4096 items, otherwise
// the writer's filler array of that length; a long string stays { $string }.
function assertKvMatchesCapture(kv, captured, label) {
  assert.deepEqual(Object.keys(kv), captured.kv.map((entry) => entry.key), `${label}: key order`);
  for (const entry of captured.kv) {
    const value = kv[entry.key];
    const placeholder = entry.value && typeof entry.value === "object" && !Array.isArray(entry.value);
    if (placeholder && entry.value.$array) {
      if (entry.value.count > 4096) {
        assert.deepEqual(value, { $array: entry.value.$array, count: entry.value.count }, `${label}: ${entry.key}`);
      } else {
        assert.equal(value.length, entry.value.count, `${label}: ${entry.key}`);
        assert.deepEqual(value.slice(0, entry.value.head.length), entry.value.head, `${label}: ${entry.key}`);
      }
    } else if (placeholder && entry.value.$string !== undefined) {
      assert.deepEqual(value, { $string: entry.value.$string }, `${label}: ${entry.key}`);
    } else {
      assert.deepEqual(value, entry.value, `${label}: ${entry.key}`);
    }
  }
}

test("the ggml type table has the ggml block sizes and agrees with the capture tool", () => {
  const expected = {
    F32: [1, 4], F16: [1, 2], BF16: [1, 2], F64: [1, 8], I8: [1, 1], I16: [1, 2], I32: [1, 4], I64: [1, 8],
    Q4_0: [32, 18], Q4_1: [32, 20], Q5_0: [32, 22], Q5_1: [32, 24], Q8_0: [32, 34], Q8_1: [32, 36],
    Q2_K: [256, 84], Q3_K: [256, 110], Q4_K: [256, 144], Q5_K: [256, 176], Q6_K: [256, 210], Q8_K: [256, 292],
    IQ2_XXS: [256, 66], IQ2_XS: [256, 74], IQ2_S: [256, 82], IQ3_XXS: [256, 98], IQ3_S: [256, 110],
    IQ1_S: [256, 50], IQ1_M: [256, 56], IQ4_NL: [32, 18], IQ4_XS: [256, 136],
    TQ1_0: [256, 54], TQ2_0: [256, 66], MXFP4: [32, 17],
  };
  for (const [name, [blockElems, blockBytes]] of Object.entries(expected)) {
    assert.deepEqual([ggmlTypeInfo(name)?.blockElems, ggmlTypeInfo(name)?.blockBytes], [blockElems, blockBytes], name);
  }
  const ids = Object.keys(GGML_TYPES).map(Number);
  assert.equal(new Set(ids.map((id) => GGML_TYPES[id].name)).size, ids.length, "names are unique");
  for (const id of ids) assert.equal(GGML_TYPE_IDS[GGML_TYPES[id].name], id);
  assert.equal(ggmlTypeInfo(4), null, "Q4_2 predates GGUF");
  assert.equal(GGML_TYPES[31].removed, true, "Q4_0_4_4 is kept for old files");

  // Fixture bytesEach values come from the capture tool's own (smaller)
  // table; every type it knows must size identically here.
  for (const [name, id] of Object.entries(capture.GGML_TYPE_IDS)) {
    assert.equal(GGML_TYPE_IDS[name], id, name);
    const dims = [GGML_TYPES[id].blockElems * 3, 5];
    assert.equal(ggmlTensorBytes(id, dims), capture.ggmlTensorBytes(id, dims), name);
  }
});

test("ggmlTensorBytes sizes rows in whole blocks and refuses anything it cannot size", () => {
  assert.equal(ggmlTensorBytes("Q2_K", [2048, 4096, 256]), 704643072);
  assert.equal(ggmlTensorBytes(10, [2048, 4096, 256]), 704643072);
  assert.equal(ggmlTensorBytes("iq2_xxs", [4096, 2048, 256]), 553648128);
  assert.equal(ggmlTensorBytes("Q8_0", [4096, 129280]), 562626560);
  assert.equal(ggmlTensorBytes("F32", []), 4, "a scalar is one element");
  assert.equal(ggmlTensorBytes("Q4_K", [0, 10]), 0);
  assert.equal(ggmlTensorBytes(41, [256]), null, "unknown id");
  assert.equal(ggmlTensorBytes("NOT_A_TYPE", [256]), null, "unknown name");
  assert.equal(ggmlTensorBytes("Q4_K", [100, 2]), null, "row is not a whole number of blocks");
  assert.equal(ggmlTensorBytes("F16", [-1]), null);
  assert.equal(ggmlTensorBytes("F16", [2 ** 40, 2 ** 20]), null, "beyond safe integers");
  assert.equal(ggmlTensorBytes("F16", "4096"), null);
});

test("DeepSeek-V4 widened capture keeps the chat template, compress ratios, indexer and sampling", async (t) => {
  const [header] = await materializedHeaders(t, DEEPSEEK);
  const parsed = gguf.readGgufHeaderSync(header.file);
  const captured = capturedFile(DEEPSEEK, header.name);
  const kv = parsed.kv;

  const capturedTemplate = captured.kv.find((entry) => entry.key === "tokenizer.chat_template").value;
  assert.equal(kv["tokenizer.chat_template"], capturedTemplate);
  assert.match(kv["tokenizer.chat_template"], /DSML/);

  const ratios = kv["deepseek4.attention.compress_ratios"];
  assert.equal(ratios.length, 44);
  assert.deepEqual([...ratios.slice(0, 4), ratios[42], ratios[43]], [0, 0, 4, 128, 4, 0]);
  assert.deepEqual([4, 128, 0].map((ratio) => ratios.slice(0, 43).filter((value) => value === ratio).length), [21, 20, 2]);

  assert.deepEqual(
    [kv["deepseek4.attention.indexer.head_count"], kv["deepseek4.attention.indexer.key_length"], kv["deepseek4.attention.indexer.top_k"]],
    [64, 128, 512],
  );
  assert.deepEqual([kv["general.sampling.temp"], kv["general.sampling.top_p"]], [1, 1]);
  assert.equal(kv["general.type"], "model");
  assert.equal(kv["deepseek4.expert_shared_count"], 1);
  assert.equal(kv["deepseek4.nextn_predict_layers"], 1);
  assert.equal(kv["deepseek4.attention.q_lora_rank"], 1024);
  assert.equal(kv["deepseek4.rope.scaling.type"], "yarn");
  assert.equal(kv["deepseek4.hyper_connection.count"], 4);
  assert.equal(kv["deepseek4.swiglu_clamp_exp"].length, 43);
  assert.deepEqual(kv["tokenizer.ggml.tokens"], { $array: "string", count: 129280 });
  assert.deepEqual(kv["tokenizer.ggml.token_type"], { $array: "int32", count: 129280 });
  assert.deepEqual(kv["tokenizer.ggml.merges"], { $array: "string", count: 127741 });
  assertKvMatchesCapture(kv, captured, DEEPSEEK);

  // The legacy whitelist is untouched: none of the widened keys leak into
  // `metadata`, so /api/models inventories keep their size and shape.
  for (const key of ["tokenizer.chat_template", "deepseek4.attention.compress_ratios", "deepseek4.attention.indexer.top_k", "deepseek4.nextn_predict_layers"]) {
    assert.equal(Object.hasOwn(parsed.metadata, key), false, key);
  }
  assert.equal(parsed.metadata["general.sampling.temp"], 1);
  assert.equal(parsed.architecture, "deepseek4");
  assert.deepEqual([parsed.layers, parsed.kvHeads, parsed.keyLength, parsed.contextLength], [43, 1, 512, 1048576]);
});

test("DeepSeek-V4 tensor bytes are exact: total 90.89 GiB, routed experts 82.69 GiB", async (t) => {
  const [header] = await materializedHeaders(t, DEEPSEEK);
  const parsed = gguf.readGgufHeaderSync(header.file);
  const captured = capturedFile(DEEPSEEK, header.name);

  assert.equal(parsed.weights.exact, true);
  assert.deepEqual(parsed.weights.unknownTypeIds, []);
  assert.equal(parsed.tensors.length, 1328);
  assert.equal(parsed.alignment, 32);
  assert.equal(parsed.headerBytes, captured.headerBytes);

  const capturedBytes = new Map(expandGroups(captured.groups).map((tensor) => [tensor.name, tensor]));
  for (const tensor of parsed.tensors) {
    const expected = capturedBytes.get(tensor.name);
    assert.ok(expected, tensor.name);
    assert.deepEqual([tensor.type, tensor.typeId, tensor.dims, tensor.bytes], [expected.type, expected.typeId, expected.dims, expected.bytesEach], tensor.name);
  }

  // totalBytes is the file the header lays out (header + tensors + padding):
  // the captured file size, so a remote sibling size and a local stat agree.
  assert.equal(parsed.weights.totalBytes, captured.bytes);
  assert.equal(parsed.weights.totalBytes, 97591747456);
  assert.equal((parsed.weights.totalBytes / GiB).toFixed(2), "90.89");
  assert.equal(parsed.weights.tensorBytes, 97586411868);
  assert.equal(sumBytes(parsed.tensors), parsed.weights.tensorBytes);
  assert.equal(Object.values(parsed.weights.byType).reduce((sum, bytes) => sum + bytes, 0), parsed.weights.tensorBytes);
  assert.deepEqual(Object.keys(parsed.weights.byType).sort(), ["F16", "F32", "I32", "IQ2_XXS", "Q2_K", "Q4_K", "Q8_0"]);

  const experts = sumBytes(parsed.tensors, EXPERT_TENSOR);
  assert.equal(experts, 88785027072);
  assert.equal((experts / GiB).toFixed(2), "82.69");
  assert.equal((sumBytes(parsed.tensors, /^token_embd\./) / GiB).toFixed(2), "0.99");
  assert.equal((sumBytes(parsed.tensors, /^output\.weight$/) / GiB).toFixed(2), "0.52");

  // The copy on disk is header-only: flagged as short, still exact.
  assert.deepEqual(parsed.warnings.map((warning) => warning.code), ["gguf_payload_short"]);
  assert.ok(parsed.warnings[0].message.zh && parsed.warnings[0].message.en);

  // The widened result carries every legacy field with the legacy value.
  const { kv, alignment, headerBytes, tensors, weights, warnings, ...legacyFields } = parsed;
  assert.deepEqual(legacyFields, gguf.readGgufMetadataSync(header.file, { cache: false }));
});

test("every GGUF fixture parses to its captured KV block, tensor bytes and file size", async (t) => {
  const ids = listFixtures().filter((id) => loadFixture(id).ggufHeader);
  assert.ok(ids.includes(DEEPSEEK) && ids.length >= 4, `GGUF fixtures: ${ids.join(", ")}`);
  for (const id of ids) {
    for (const header of await materializedHeaders(t, id)) {
      const label = `${id}/${header.name}`;
      const parsed = gguf.readGgufHeaderSync(header.file);
      const captured = capturedFile(id, header.name);
      assertKvMatchesCapture(parsed.kv, captured, label);
      assert.equal(parsed.tensors.length, captured.tensorCount, label);
      assert.equal(parsed.weights.exact, true, label);
      assert.equal(parsed.weights.tensorBytes, sumBytes(expandGroups(captured.groups).map((tensor) => ({ name: tensor.name, bytes: tensor.bytesEach }))), label);
      assert.equal(parsed.weights.totalBytes, captured.bytes, label);
      assert.equal(parsed.headerBytes, captured.headerBytes, label);
    }
  }
});

test("an unknown ggml type id makes weights inexact, with an upper bound and a warning", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gguf-unknown-type-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const kv = [{ key: "general.architecture", type: "string", value: "llama" }, { key: "llama.block_count", type: "uint32", value: 1 }];
  const write = (name, tensors) => {
    const built = buildGguf({ kv, tensors });
    const file = path.join(root, name);
    fs.writeFileSync(file, Buffer.concat([built.header, Buffer.alloc(built.dataBytes)]));
    return { file, built };
  };

  // Unknown type in the middle: bounded by the next tensor's offset.
  const middle = write("middle.gguf", [
    { name: "blk.0.attn_q.weight", dims: [64, 2], type: "Q8_0" },
    { name: "blk.0.mystery.weight", dims: [100], typeId: 41, bytes: 1000 },
    { name: "output_norm.weight", dims: [32], type: "F32" },
  ]);
  const parsed = gguf.readGgufHeaderSync(middle.file);
  const mystery = parsed.tensors.find((tensor) => tensor.typeId === 41);
  assert.deepEqual([mystery.type, mystery.bytes, mystery.bytesUpper], [null, null, 1024]);
  assert.equal(parsed.weights.exact, false);
  assert.deepEqual(parsed.weights.unknownTypeIds, [41]);
  assert.equal(parsed.weights.unboundedTensors, 0);
  assert.equal(parsed.weights.byType["type-41"], 1024);
  assert.equal(parsed.weights.tensorBytes, 136 + 1024 + 128);
  assert.ok(parsed.weights.tensorBytes >= 136 + 1000 + 128, "an upper bound, never an undercount");
  assert.equal(parsed.weights.totalBytes, middle.built.totalBytes);
  const warning = parsed.warnings.find((item) => item.code === "ggml_type_unknown");
  assert.deepEqual([warning.tensors, warning.typeIds], [1, [41]]);
  assert.match(warning.message.en, /41/);
  assert.match(warning.message.zh, /41/);
  assert.equal(parsed.warnings.some((item) => item.code === "gguf_payload_short"), false);

  // Unknown type last: bounded by the file size, unbounded without it.
  const last = write("last.gguf", [
    { name: "blk.0.attn_q.weight", dims: [64, 2], type: "Q8_0" },
    { name: "blk.0.mystery.weight", dims: [100], typeId: 200, bytes: 1000 },
  ]);
  const local = gguf.readGgufHeaderSync(last.file);
  assert.equal(local.weights.exact, false);
  assert.equal(local.tensors[1].bytesUpper, 1000);
  const headerOnly = last.built.header;
  const remote = gguf.parseGgufHeaderBuffer(headerOnly, { partial: true });
  assert.equal(remote.weights.exact, false);
  assert.equal(remote.tensors[1].bytesUpper, null);
  assert.equal(remote.weights.unboundedTensors, 1);
  assert.equal(remote.fileBytes, null);
  const sized = gguf.parseGgufHeaderBuffer(headerOnly, { partial: true, fileBytes: last.built.totalBytes });
  assert.equal(sized.tensors[1].bytesUpper, 1000);

  // Overlapping tensors (a type table that disagrees with the layout) are
  // not presented as exact either.
  const overlap = path.join(root, "overlap.gguf");
  fs.writeFileSync(overlap, fakeGguf({ "general.architecture": "llama" }, [
    { name: "a", dims: [64], type: 0, offset: 0 },
    { name: "b", dims: [64], type: 0, offset: 32 },
  ], 512));
  const overlapping = gguf.readGgufHeaderSync(overlap);
  assert.equal(overlapping.weights.exact, false);
  assert.ok(overlapping.warnings.some((item) => item.code === "tensor_size_mismatch"));
});

test("parseGgufHeaderBuffer partial mode throws GgufNeedMoreBytes until the window holds the header", async (t) => {
  const [header] = await materializedHeaders(t, DEEPSEEK);
  const captured = capturedFile(DEEPSEEK, header.name);
  const bytes = fs.readFileSync(header.file);
  const local = gguf.readGgufHeaderSync(header.file);

  assert.throws(() => gguf.parseGgufHeaderBuffer(bytes.subarray(0, 2 * MiB), { partial: true }), (error) => {
    assert.ok(error instanceof gguf.GgufNeedMoreBytes);
    assert.equal(error.name, "GgufNeedMoreBytes");
    assert.equal(error.code, "gguf_need_more_bytes");
    assert.equal(error.availableBytes, 2 * MiB);
    assert.ok(error.requiredBytes > 2 * MiB && error.requiredBytes <= captured.headerBytes, `requiredBytes ${error.requiredBytes}`);
    return true;
  });

  // The §6.1 growth loop: 2 MiB first, then requiredBytes rounded up to
  // 1 MiB, at least doubling, until the header parses.
  let window = 2 * MiB;
  let parsed = null;
  const windows = [];
  for (let attempt = 0; attempt < 10 && !parsed; attempt += 1) {
    windows.push(window);
    try {
      parsed = gguf.parseGgufHeaderBuffer(bytes.subarray(0, window), { partial: true, fileBytes: captured.bytes, path: header.name });
    } catch (error) {
      if (!(error instanceof gguf.GgufNeedMoreBytes)) throw error;
      assert.ok(error.requiredBytes > window);
      window = Math.max(Math.ceil(error.requiredBytes / MiB) * MiB, window * 2);
    }
  }
  assert.ok(parsed, `parsed within windows ${windows.join(", ")}`);
  assert.ok(windows.length > 1, `windows ${windows.join(", ")}`);
  assert.deepEqual(parsed.kv, local.kv);
  assert.deepEqual(parsed.tensors, local.tensors);
  assert.deepEqual(parsed.weights, local.weights);
  assert.equal(parsed.headerBytes, captured.headerBytes);
  assert.equal(parsed.fileBytes, captured.bytes);
  assert.deepEqual(parsed.warnings, [], "the full file size is known, so nothing is short");
  assert.equal(parsed.modelName, "DeepSeek V4 Flash");
  assert.equal(parsed.role, "model");

  // A Uint8Array view parses the same way.
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(gguf.parseGgufHeaderBuffer(view).weights, local.weights);

  // The first reads: magic, version, then the 8-byte tensor count.
  assert.throws(() => gguf.parseGgufHeaderBuffer(bytes.subarray(0, 10), { partial: true }), { name: "GgufNeedMoreBytes", requiredBytes: 16 });
  // Without partial the buffer is the whole file: running out is corruption.
  assert.throws(() => gguf.parseGgufHeaderBuffer(bytes.subarray(0, 2 * MiB)), (error) => {
    assert.equal(error instanceof gguf.GgufNeedMoreBytes, false);
    assert.match(error.message, /exceeds file bounds/);
    return true;
  });
  // A file smaller than the header needs cannot be fixed by a larger window.
  assert.throws(() => gguf.parseGgufHeaderBuffer(bytes.subarray(0, 2 * MiB), { partial: true, fileBytes: 2 * MiB + 1024 }), (error) => {
    assert.equal(error instanceof gguf.GgufNeedMoreBytes, false);
    return true;
  });
  assert.throws(() => gguf.parseGgufHeaderBuffer(Buffer.from("NOPE0000"), { partial: true }), /Invalid GGUF magic/);
  assert.throws(() => gguf.parseGgufHeaderBuffer("GGUF"), TypeError);
});

test("widened keys are own properties, even a hostile __proto__ key", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gguf-proto-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "proto.gguf");
  fs.writeFileSync(file, fakeGguf({ "general.architecture": "llama", ["__proto__"]: [1, 2], "llama.custom.flag": true }, []));
  const parsed = gguf.readGgufHeaderSync(file);
  assert.equal(Object.getPrototypeOf(parsed.kv), Object.prototype);
  assert.ok(Object.hasOwn(parsed.kv, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed.kv, "__proto__").value, [1, 2]);
  assert.equal(parsed.kv["llama.custom.flag"], true);
  assert.equal(parsed.weights.totalBytes, parsed.headerBytes, "no tensors: the header is the file");
});

test("manager-core exposes the widened parser without export collisions", () => {
  assert.equal(core.readGgufHeaderSync, gguf.readGgufHeaderSync);
  assert.equal(core.parseGgufHeaderBuffer, gguf.parseGgufHeaderBuffer);
  assert.equal(core.GgufNeedMoreBytes, gguf.GgufNeedMoreBytes);
  assert.equal(core.ggmlTensorBytes, undefined, "ggml-types stays out of the flat exports");
  const names = core.MODULES.flatMap((name) => Object.keys(require(path.join(__dirname, "..", name))));
  for (const name of ["readGgufHeaderSync", "parseGgufHeaderBuffer", "GgufNeedMoreBytes"]) {
    assert.equal(names.filter((item) => item === name).length, 1, name);
  }
});
