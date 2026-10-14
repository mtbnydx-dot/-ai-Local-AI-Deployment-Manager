"use strict";

// scripts/capture-model-fixture.js (docs/overhaul/02-models.md §21.1):
// read-only capture, license gate, path scrubbing, vocabulary dropping,
// privacy refusal, GGUF and safetensors tables, and the CLI contract.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const capture = require("../../scripts/capture-model-fixture.js");
const { buildGguf, writeGgufFile } = require("./helpers/gguf-writer");
const { writeSafetensorsFile } = require("./helpers/safetensors-writer");
const { expandGroups, materializeFixture } = require("./helpers/fixture-materialize");

// Obviously fake values, assembled at runtime (release privacy scan).
const FAKE_SK = ["sk", "-", "fakecapturekey0123456789abcdef"].join("");

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeTree(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, typeof content === "string" || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

// A small safetensors model folder: two indexed shards, metadata files,
// a README with a license, a vocabulary file and custom code.
async function makeSafetensorsModel(t, overrides = {}) {
  const work = await tempDir(t, "capture-src-");
  const source = path.join(work, overrides.folder || "Tiny-Model-7B");
  await fsp.mkdir(source, { recursive: true });
  const layer = (L) => [
    { name: `model.layers.${L}.self_attn.q_proj.weight`, dtype: "BF16", shape: [8, 8] },
    { name: `model.layers.${L}.mlp.experts.0.down_proj.weight`, dtype: "F8_E4M3", shape: [8, 4] },
    { name: `model.layers.${L}.mlp.experts.1.down_proj.weight`, dtype: "F8_E4M3", shape: [8, 4] },
  ];
  const shards = {
    "model-00001-of-00002.safetensors": [{ name: "model.embed_tokens.weight", dtype: "BF16", shape: [32, 8] }, ...layer(0), ...layer(1)],
    "model-00002-of-00002.safetensors": [...layer(2), { name: "lm_head.weight", dtype: "BF16", shape: [32, 8] }],
  };
  const weightMap = {};
  for (const [name, tensors] of Object.entries(shards)) {
    writeSafetensorsFile(path.join(source, name), tensors, { metadata: { format: "pt" } });
    for (const tensor of tensors) weightMap[tensor.name] = name;
  }
  await writeTree(source, {
    "config.json": { architectures: ["TinyForCausalLM"], model_type: "tiny", hidden_size: 8, _name_or_path: "C:\\fixture-src\\library\\Tiny-Model-7B" },
    "tokenizer_config.json": { chat_template: "{{ messages }}", added_tokens_decoder: { 0: { content: "<s>" }, 1: { content: "</s>" } } },
    "chat_template.jinja": "{# helper at /home/someone/tools/render.py #}{{ messages }}\n",
    "model.safetensors.index.json": { metadata: { total_size: 1234 }, weight_map: weightMap },
    "README.md": "---\nlicense: apache-2.0\ntags: [test]\n---\n# Tiny model\nBody text that must never be copied.\n",
    "tokenizer.json": JSON.stringify({ model: { vocab: { hello: 0, world: 1 } } }),
    "modeling_tiny.py": "class TinyForCausalLM: pass\n",
    ...(overrides.files || {}),
  });
  return { work, source };
}

function snapshot(dir) {
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const stat = fs.statSync(full);
      entries.push([path.relative(dir, full), stat.size, stat.mtimeMs, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  };
  visit(dir);
  return entries;
}

async function runMain(args, deps = {}) {
  const out = [];
  const err = [];
  const code = await capture.main(args, { stdout: (line) => out.push(line), stderr: (line) => err.push(line), needles: [], ...deps });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("captures metadata and headers, never weights, vocabularies or READMEs, and leaves the source untouched", async (t) => {
  const { work, source } = await makeSafetensorsModel(t);
  const out = path.join(work, "fixtures");
  const before = snapshot(source);
  const result = await runMain(["--from", source, "--id", "tiny-model", "--out", out]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(snapshot(source), before);

  const dir = path.join(out, "tiny-model");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["chat_template.jinja", "config.json", "manifest.json", "tensor-table.json", "tokenizer_config.json"]);
  const all = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
  assert.ok(!all.includes("Body text that must never be copied"));
  assert.ok(!all.includes("\"hello\""));
  assert.ok(!all.includes("class TinyForCausalLM"));

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.license, "apache-2.0");
  assert.equal(manifest.licenseSource, "readme");
  assert.equal(manifest.synthetic, false);
  assert.equal(manifest.folderName, "Tiny-Model-7B");
  assert.equal(manifest.layout, "indexed");
  const kinds = Object.fromEntries(manifest.files.map((entry) => [entry.name, entry.kind]));
  assert.equal(kinds["README.md"], "placeholder");
  assert.equal(kinds["tokenizer.json"], "placeholder");
  assert.equal(kinds["modeling_tiny.py"], "placeholder");
  assert.equal(kinds["model.safetensors.index.json"], "index");
  assert.equal(kinds["model-00001-of-00002.safetensors"], "safetensors");

  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(config._name_or_path, "Tiny-Model-7B");
  const tokenizer = JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8"));
  assert.equal(tokenizer.added_tokens_decoder, undefined);
  assert.equal(tokenizer.chat_template, "{{ messages }}");
  assert.equal(fs.readFileSync(path.join(dir, "chat_template.jinja"), "utf8"), "{# helper at render.py #}{{ messages }}\n");
  assert.deepEqual(manifest.scrubbed, [
    { file: "chat_template.jinja", pointer: null, reason: "absolute_path" },
    { file: "config.json", pointer: "/_name_or_path", reason: "absolute_path" },
    { file: "tokenizer_config.json", pointer: "/added_tokens_decoder", reason: "tokenizer_vocabulary", count: 2 },
  ]);

  const table = JSON.parse(fs.readFileSync(path.join(dir, "tensor-table.json"), "utf8"));
  assert.deepEqual(table.index, { name: "model.safetensors.index.json", metadata: { total_size: 1234 } });
  const experts = table.groups.find((group) => group.pattern === "model.layers.{L}.mlp.experts.{E}.down_proj.weight"
    && group.file === "model-00001-of-00002.safetensors");
  assert.deepEqual(experts.ranges, { L: [0, 1], E: [0, 1] });
  assert.equal(experts.bytesEach, 32);
  assert.equal(expandGroups(table.groups).length, 11);
  assert.match(result.out, /wrote 5 files for tiny-model/);
});

test("the license gate refuses unknown and non-permissive licenses", async (t) => {
  const { work, source } = await makeSafetensorsModel(t, { files: { "README.md": "---\nlicense: llama3\n---\n" } });
  const out = path.join(work, "fixtures");
  const refused = await runMain(["--from", source, "--id", "tiny", "--out", out]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /not on the permissive list/);
  assert.equal(fs.existsSync(path.join(out, "tiny")), false);
  const allowed = await runMain(["--from", source, "--id", "tiny", "--out", out, "--allow-license"]);
  assert.equal(allowed.code, 0, allowed.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "tiny", "manifest.json"), "utf8")).license, "llama3");

  await fsp.rm(path.join(source, "README.md"));
  const unknown = await runMain(["--from", source, "--id", "tiny-2", "--out", out]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /--license/);
  const given = await runMain(["--from", source, "--id", "tiny-2", "--out", out, "--license", "MIT"]);
  assert.equal(given.code, 0, given.err);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "tiny-2", "manifest.json"), "utf8"));
  assert.equal(manifest.license, "mit");
  assert.equal(manifest.licenseSource, "cli");

  await writeTree(source, { LICENSE: "                                 Apache License\n                           Version 2.0, January 2004\n" });
  const fromFile = capture.buildFixture({ from: source, id: "tiny-3", needles: [] });
  assert.equal(fromFile.manifest.license, "apache-2.0");
  assert.equal(fromFile.manifest.licenseSource, "license-file");
});

test("privacy refusal names the file and check, never the value, and writes nothing", async (t) => {
  const { work, source } = await makeSafetensorsModel(t, {
    files: { "generation_config.json": { temperature: 0.6, note: `key ${FAKE_SK}` } },
  });
  const out = path.join(work, "fixtures");
  const result = await runMain(["--from", source, "--id", "leaky", "--out", out]);
  assert.equal(result.code, 2);
  assert.match(result.err, /generation_config\.json: sk-key/);
  assert.ok(!result.err.includes(FAKE_SK));
  assert.equal(fs.existsSync(path.join(out, "leaky")), false);

  const { source: clean } = await makeSafetensorsModel(t, { folder: "Clean-Model" });
  const named = await runMain(["--from", clean, "--id", "named", "--out", out], { needles: ["tiny"] });
  assert.equal(named.code, 2);
  assert.match(named.err, /config\.json: identity/);
});

test("--out inside --from, an existing fixture, --force and --dry-run", async (t) => {
  const { work, source } = await makeSafetensorsModel(t);
  const before = snapshot(source);
  const inside = await runMain(["--from", source, "--id", "x", "--out", path.join(source, "fixtures")]);
  assert.equal(inside.code, 1);
  assert.match(inside.err, /never written/);
  assert.deepEqual(snapshot(source), before);

  const out = path.join(work, "fixtures");
  const dry = await runMain(["--from", source, "--id", "tiny", "--out", out, "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /dry run/);
  assert.match(dry.out, /tiny\/tensor-table\.json/);
  assert.equal(fs.existsSync(out), false);

  assert.equal((await runMain(["--from", source, "--id", "tiny", "--out", out])).code, 0);
  await writeTree(path.join(out, "tiny"), { "expected-card.json": { kept: true }, "stale.json": { stale: true } });
  const again = await runMain(["--from", source, "--id", "tiny", "--out", out]);
  assert.equal(again.code, 1);
  assert.match(again.err, /--force/);
  const forced = await runMain(["--from", source, "--id", "tiny", "--out", out, "--force", "--note", "re-captured"]);
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "tiny", "expected-card.json"), "utf8")), { kept: true });
  assert.equal(fs.existsSync(path.join(out, "tiny", "stale.json")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "tiny", "manifest.json"), "utf8")).notes, ["re-captured"]);
});

test("dtype-ordered shards and a one-line index materialize with their captured sizes", async (t) => {
  const work = await tempDir(t, "capture-layout-");
  const source = path.join(work, "Rust-Ordered");
  await fsp.mkdir(source);
  const tensors = [
    { name: "a.scale", dtype: "F32", shape: [] },
    { name: "b.weight", dtype: "F8_E4M3", shape: [16, 16] },
    { name: "c.norm", dtype: "BF16", shape: [16] },
    { name: "d.weight", dtype: "F8_E4M3", shape: [16, 8] },
  ];
  const mixed = writeSafetensorsFile(path.join(source, "model-00001-of-00002.safetensors"), tensors, { order: "dtype" });
  writeSafetensorsFile(path.join(source, "model-00002-of-00002.safetensors"), [{ name: "lm_head.weight", dtype: "BF16", shape: [32, 16] }]);
  await fsp.truncate(path.join(source, "model-00001-of-00002.safetensors"), mixed.totalBytes);
  await fsp.truncate(path.join(source, "model-00002-of-00002.safetensors"), 8 + 1024 + 32 * 16 * 2);
  const weightMap = Object.fromEntries([...tensors.map((tensor) => [tensor.name, "model-00001-of-00002.safetensors"]), ["lm_head.weight", "model-00002-of-00002.safetensors"]]);
  // Python json.dumps() default: one line, no final newline, keys unsorted.
  const index = `{"metadata": {"total_size": 1234}, "weight_map": {${Object.entries(weightMap).reverse().map(([key, value]) => `"${key}": "${value}"`).join(", ")}}}`;
  await writeTree(source, { "model.safetensors.index.json": index, "config.json": { model_type: "tiny" } });

  const read = capture.readSafetensorsHeader(path.join(source, "model-00001-of-00002.safetensors"), mixed.totalBytes);
  assert.deepEqual(read.tensors.map((tensor) => tensor.name), ["a.scale", "c.norm", "b.weight", "d.weight"]);

  const out = path.join(work, "fixtures");
  const result = await runMain(["--from", source, "--id", "rust-ordered", "--out", out, "--license", "mit"]);
  assert.equal(result.code, 0, result.err);
  const table = JSON.parse(fs.readFileSync(path.join(out, "rust-ordered", "tensor-table.json"), "utf8"));
  assert.deepEqual(table.files.map((file) => file.order ?? null), ["dtype", null]);
  assert.deepEqual(table.index, { name: "model.safetensors.index.json", metadata: { total_size: 1234 }, style: "python", newline: false });

  const materialized = await materializeFixture("rust-ordered", { fixturesRoot: out });
  t.after(materialized.cleanup);
  for (const file of materialized.files) assert.ok(file.exact, `${file.name}: ${file.actualBytes} of ${file.bytes} bytes`);
  const again = capture.readSafetensorsHeader(path.join(materialized.dir, "model-00001-of-00002.safetensors"), mixed.totalBytes);
  assert.deepEqual(again.tensors.map((tensor) => [tensor.name, tensor.begin]), read.tensors.map((tensor) => [tensor.name, tensor.begin]));
  const rebuilt = fs.readFileSync(path.join(materialized.dir, "model.safetensors.index.json"), "utf8");
  assert.deepEqual(JSON.parse(rebuilt).weight_map, Object.fromEntries(Object.entries(weightMap).sort()));
  assert.ok(!rebuilt.includes("\n"));
});

test("damaged headers and a partial index become warnings, not failures", async (t) => {
  const { source } = await makeSafetensorsModel(t);
  await fsp.writeFile(path.join(source, "model-00002-of-00002.safetensors"), Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 1, 2, 3]));
  const built = capture.buildFixture({ from: source, id: "damaged", needles: [] });
  const codes = built.manifest.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("safetensors_header_invalid"));
  assert.ok(codes.includes("index_files_missing"));
  assert.equal(built.manifest.files.find((entry) => entry.name === "model-00002-of-00002.safetensors").kind, "placeholder");
});

test("GGUF headers: typed KV, vocabulary placeholders, exact and unknown tensor sizes, --gguf selection", async (t) => {
  const work = await tempDir(t, "capture-gguf-");
  const source = path.join(work, "Tiny-GGUF");
  await fsp.mkdir(source);
  const kv = [
    { key: "general.architecture", type: "string", value: "tiny" },
    { key: "general.license", type: "string", value: "MIT" },
    { key: "general.source.url", type: "string", value: "/home/someone/src/tiny" },
    { key: "tiny.block_count", type: "uint32", value: 2 },
    { key: "tiny.attention.compress_ratios", type: "array", itemType: "uint32", value: [0, 4, 128] },
    { key: "tiny.large", type: "array", itemType: "uint32", value: Array.from({ length: 5000 }, (_, index) => index) },
    { key: "tiny.big_count", type: "uint64", value: "18446744073709551615" },
    { key: "tokenizer.ggml.tokens", type: "array", itemType: "string", value: ["hello", "world", "secretword"] },
    { key: "tokenizer.ggml.scores", type: "array", itemType: "float32", value: [0, -1, -2] },
    { key: "tokenizer.chat_template", type: "string", value: "{% for m in messages %}{{ m.content }}{% endfor %}" },
  ];
  const tensors = [
    { name: "token_embd.weight", type: "Q8_0", dims: [64, 32] },
    { name: "blk.0.ffn_down_exps.weight", type: "Q4_K", dims: [256, 4, 2] },
    { name: "blk.1.ffn_down_exps.weight", type: "Q4_K", dims: [256, 4, 2] },
    { name: "blk.0.mystery.weight", typeId: 99, dims: [10], bytes: 40 },
  ];
  writeGgufFile(path.join(source, "tiny-Q4_K.gguf"), { kv, tensors });
  writeGgufFile(path.join(source, "tiny-Q8_0.gguf"), { kv, tensors: tensors.slice(0, 1) });
  // Payload bytes for the size check: the last tensor's gap ends at the file end.
  const sized = buildGguf({ kv, tensors });
  await fsp.truncate(path.join(source, "tiny-Q4_K.gguf"), sized.totalBytes);

  const built = capture.buildFixture({ from: source, id: "tiny-gguf", gguf: ["tiny-Q4_K.gguf"], needles: [] });
  assert.equal(built.manifest.license, "mit");
  assert.equal(built.manifest.licenseSource, "gguf");
  assert.equal(built.manifest.layout, "single");
  assert.equal(built.manifest.files.find((entry) => entry.name === "tiny-Q8_0.gguf").kind, "placeholder");
  const header = JSON.parse(built.files.get("gguf-header.json"));
  assert.equal(header.files.length, 1);
  const file = header.files[0];
  assert.equal(file.headerBytes, sized.dataOffset);
  assert.equal(file.tensorCount, 4);
  const byKey = Object.fromEntries(file.kv.map((entry) => [entry.key, entry]));
  assert.deepEqual(byKey["tiny.attention.compress_ratios"].value, [0, 4, 128]);
  assert.deepEqual(byKey["tiny.large"].value, { $array: "uint32", count: 5000, head: [0, 1, 2, 3, 4, 5, 6, 7] });
  assert.equal(byKey["tiny.big_count"].value, "18446744073709551615");
  assert.deepEqual(byKey["tokenizer.ggml.tokens"].value, { $array: "string", count: 3, head: [] });
  assert.deepEqual(byKey["tokenizer.ggml.scores"].value, { $array: "float32", count: 3, head: [0, -1, -2] });
  assert.equal(byKey["general.source.url"].value, "tiny");
  assert.ok(!built.files.get("gguf-header.json").includes("secretword"));
  assert.deepEqual(built.manifest.scrubbed, [{ file: "tiny-Q4_K.gguf", pointer: "/kv/general.source.url", reason: "absolute_path" }]);

  const experts = file.groups.find((group) => group.pattern === "blk.{L}.ffn_down_exps.weight");
  assert.deepEqual(experts.ranges, { L: [0, 1] });
  assert.equal(experts.bytesEach, capture.ggmlTensorBytes(capture.GGML_TYPE_IDS.Q4_K, [256, 4, 2]));
  assert.equal(experts.bytesEach, 8 * 144);
  const mystery = file.groups.find((group) => group.pattern === "blk.{L}.mystery.weight");
  assert.equal(mystery.type, null);
  assert.equal(mystery.bytesExact, false);
  assert.equal(mystery.bytesEach, 40);
  assert.ok(built.manifest.warnings.some((warning) => warning.code === "ggml_type_unknown"));
});

test("buildGguf matches a captured data offset through filler strings", () => {
  const kv = [
    { key: "general.architecture", type: "string", value: "tiny" },
    { key: "tokenizer.ggml.tokens", type: "array", itemType: "string", value: { $array: "string", count: 100, head: [] } },
  ];
  const tensors = [{ name: "w", type: "F32", dims: [8] }];
  const natural = buildGguf({ kv, tensors });
  const padded = buildGguf({ kv, tensors, headerBytes: natural.dataOffset + 96 });
  assert.equal(padded.exactHeader, true);
  assert.equal(padded.dataOffset, natural.dataOffset + 96);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "capture-filler-"));
  try {
    const file = path.join(work, "x.gguf");
    fs.writeFileSync(file, Buffer.concat([padded.header, Buffer.alloc(padded.dataBytes)]));
    const read = capture.readGgufHeader(file, fs.statSync(file).size);
    assert.equal(read.headerBytes, padded.dataOffset);
    assert.deepEqual(read.kv[1].value, { $array: "string", count: 100, head: [] });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  assert.equal(buildGguf({ kv: kv.slice(0, 1), tensors, headerBytes: natural.dataOffset + 96 }).exactHeader, false);
});

test("tensor-name compression is exact for regular and irregular layouts", () => {
  assert.deepEqual(capture.abstractTensorName("model.layers.12.mlp.experts.7.w1.weight"), {
    pattern: "model.layers.{L}.mlp.experts.{E}.w1.weight", keys: ["L", "E"], values: [12, 7],
  });
  assert.equal(capture.abstractTensorName("v.patch_embd.weight.01").pattern, "v.patch_embd.weight.01");
  assert.equal(capture.abstractTensorName("a.{x}.b"), null);
  assert.deepEqual(capture.rangeSpec([3, 7, 11, 15]), { from: 3, to: 15, step: 4 });
  assert.deepEqual(capture.rangeSpec([0, 1, 2]), [0, 2]);
  assert.deepEqual(capture.rangeSpec([1, 5]), { values: [1, 5] });
  assert.deepEqual(capture.expandRangeSpec({ from: 3, to: 15, step: 4 }), [3, 7, 11, 15]);

  // Pseudo-random subsets of a layers x experts grid survive compress + expand.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 25; round += 1) {
    const names = [];
    for (let L = 0; L < 12; L += 1) {
      for (let E = 0; E < 16; E += 1) if (random() < 0.6) names.push(`model.layers.${L}.mlp.experts.${E}.down_proj.weight`);
      if (random() < 0.5) names.push(`model.layers.${L}.self_attn.q_proj.weight`);
    }
    names.push("lm_head.weight", "odd.{name}");
    const groups = capture.compressTensors(names.map((name) => ({ name })), () => ({ dtype: "BF16" }));
    const expanded = groups.flatMap((group) => capture.expandGroupNames(group));
    assert.deepEqual(expanded.sort(), [...names].sort());
  }
});

test("shard names and segment suffixes compress with their tensors", () => {
  assert.deepEqual(capture.abstractTensorName("model.layers.1.ple.ngram_embedding.shard_87.weight"), {
    pattern: "model.layers.{L}.ple.ngram_embedding.shard_{S}.weight", keys: ["L", "S"], values: [1, 87],
  });
  assert.deepEqual(capture.abstractFileName("layer-00020-experts-0384-0511.safetensors", 20), {
    pattern: "layer-{L:5}-experts-{F:4}-{F2:4}.safetensors", keys: ["F", "F2"], values: [384, 511],
  });
  assert.deepEqual(capture.abstractFileName("model-00001-of-00007.safetensors"), {
    pattern: "model-{F:5}-of-{F2:5}.safetensors", keys: ["F", "F2"], values: [1, 7],
  });
  assert.equal(capture.fillPlaceholders("layer-{L:5}-{F}.x", { L: 7, F: 12 }), "layer-00007-12.x");

  const describe = (tensor) => ({ dtype: "BF16", shape: [4], bytesEach: 8, file: tensor.file });
  const layers = [];
  for (let L = 0; L < 9; L += 1) {
    layers.push({ name: `model.layers.${L}.mlp.down_proj.weight`, file: `layers-${L}.safetensors` });
    if (L % 3 === 2) layers.push({ name: `model.layers.${L}.self_attn.q_proj.weight`, file: `layers-${L}.safetensors` });
  }
  layers.push({ name: "lm_head.weight", file: "outside.safetensors" }, { name: "model.norm.weight_scale_2", file: "outside.safetensors" });
  const layerGroups = capture.compressTensors(layers, describe);
  assert.deepEqual(layerGroups.find((group) => group.pattern === "model.layers.{L}.mlp.down_proj.weight"), {
    pattern: "model.layers.{L}.mlp.down_proj.weight", ranges: { L: [0, 8] }, dtype: "BF16", shape: [4], bytesEach: 8, filePattern: "layers-{L}.safetensors",
  });
  assert.deepEqual(layerGroups.find((group) => group.pattern === "model.layers.{L}.self_attn.q_proj.weight").ranges, { L: { from: 2, to: 8, step: 3 } });
  // A single suffix value is written back: no placeholder, no ranges.
  assert.deepEqual(layerGroups.find((group) => group.pattern === "model.norm.weight_scale_2"), {
    pattern: "model.norm.weight_scale_2", dtype: "BF16", shape: [4], bytesEach: 8, file: "outside.safetensors",
  });

  // Per-layer expert-range shards: one group per expert range across all layers.
  const experts = [];
  for (let L = 0; L < 3; L += 1) {
    for (let E = 0; E < 8; E += 1) {
      const range = E < 4 ? "0000-0003" : "0004-0007";
      experts.push({ name: `model.layers.${L}.mlp.experts.${E}.up_proj.weight`, file: `layer-${String(L).padStart(5, "0")}-experts-${range}.safetensors` });
    }
  }
  const expertGroups = capture.compressTensors(experts, describe);
  assert.deepEqual(expertGroups.map((group) => [group.filePattern, group.ranges]), [
    ["layer-{L:5}-experts-0000-0003.safetensors", { L: [0, 2], E: [0, 3] }],
    ["layer-{L:5}-experts-0004-0007.safetensors", { L: [0, 2], E: [4, 7] }],
  ]);

  // The same tensor name in numbered shards; a shard holding two layers names no layer.
  const shards = Array.from({ length: 5 }, (_, index) => ({ name: "weight_i4", file: `ples_int4/shard_${index}.safetensors` }));
  shards.push(
    { name: "model.layers.0.w.weight", file: "model-00001-of-00002.safetensors" },
    { name: "model.layers.1.w.weight", file: "model-00001-of-00002.safetensors" },
    { name: "model.layers.2.w.weight", file: "model-00002-of-00002.safetensors" },
  );
  const shardGroups = capture.compressTensors(shards, describe);
  assert.deepEqual(shardGroups.find((group) => group.pattern === "weight_i4"), {
    pattern: "weight_i4", ranges: { F: [0, 4] }, dtype: "BF16", shape: [4], bytesEach: 8, filePattern: "ples_int4/shard_{F}.safetensors",
  });
  assert.deepEqual(shardGroups.filter((group) => group.pattern === "model.layers.{L}.w.weight").map((group) => [group.file, group.ranges]), [
    ["model-00001-of-00002.safetensors", { L: [0, 1] }],
    ["model-00002-of-00002.safetensors", { L: [2, 2] }],
  ]);

  // Random shard assignments survive compress + expand with their files.
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 25; round += 1) {
    const tensors = [];
    for (let L = 0; L < 10; L += 1) {
      const perLayer = random() < 0.5;
      for (let E = 0; E < 12; E += 1) {
        if (random() < 0.3) continue;
        const file = perLayer ? `layers-${L}.safetensors` : `model-${String(1 + Math.floor(random() * 3)).padStart(5, "0")}-of-00003.safetensors`;
        tensors.push({ name: `model.layers.${L}.mlp.experts.${E}.down_proj.weight`, file });
      }
      tensors.push({ name: `model.layers.${L}.ple.shard_${Math.floor(random() * 4)}.weight`, file: `ple-${L % 2}.safetensors` });
    }
    const unique = Array.from(new Map(tensors.map((tensor) => [`${tensor.file}\u0000${tensor.name}`, tensor])).values());
    const groups = capture.compressTensors(unique, describe);
    const expanded = groups.flatMap((group) => capture.expandGroupTensors(group)).map((tensor) => `${tensor.file}\u0000${tensor.name}`);
    assert.deepEqual(expanded.sort(), unique.map((tensor) => `${tensor.file}\u0000${tensor.name}`).sort());
  }
});

test("formatJson puts flat records on one line and nests the rest", () => {
  const text = capture.formatJson({ a: 1, files: [{ name: "x", n: [1, 2] }, { name: "y", r: { L: [0, 1] } }], kv: [] });
  assert.equal(text, "{\n  \"a\": 1,\n  \"files\": [\n    {\"name\":\"x\",\"n\":[1,2]},\n    {\"name\":\"y\",\"r\":{\"L\":[0,1]}}\n  ],\n  \"kv\": []\n}");
});

test("argument parsing and usage", async (t) => {
  assert.deepEqual(capture.parseArgs(["--from=a", "--id", "b", "--gguf", "x.gguf", "--gguf=y.gguf", "--note", "n", "--force"]), {
    from: "a", id: "b", gguf: ["x.gguf", "y.gguf"], license: "", allowLicense: false, synthetic: false,
    notes: ["n"], out: "", force: true, dryRun: false, help: false,
  });
  assert.equal((await runMain(["--bogus"])).code, 1);
  assert.equal((await runMain(["--from"])).code, 1);
  assert.equal((await runMain(["--id", "x"])).code, 1);
  const help = await runMain(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: node scripts\/capture-model-fixture\.js/);
  const work = await tempDir(t, "capture-args-");
  await fsp.mkdir(path.join(work, "src"));
  const badId = await runMain(["--from", path.join(work, "src"), "--id", "Bad_Id", "--out", path.join(work, "out")]);
  assert.equal(badId.code, 1);
  assert.match(badId.err, /--id must be/);
  const missing = await runMain(["--from", path.join(work, "absent"), "--id", "ok", "--out", path.join(work, "out")]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /existing folder/);
  assert.equal(fs.existsSync(path.join(work, "out")), false);
});
