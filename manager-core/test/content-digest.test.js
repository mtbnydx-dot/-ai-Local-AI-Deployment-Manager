"use strict";

// contentDigest (docs/overhaul/02-models.md §4.1, MOD-3): a rename-stable
// content identity from the small metadata files, the safetensors index, the
// GGUF KV block (tokenizer arrays as counts) and the (name, size) list of the
// weight files. Weight files are only stat-ed; a GGUF file is read up to the
// end of its header. The fs spy below holds the digest to that.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const core = require("..");
const { canonicalGgufKv, contentDigestForDir, digestPlan } = require("../model-inspector/content-digest");
const { scanInventory } = require("../model-inspector/detectors/inventory");
const { loadFixture, materializeFixture } = require("./helpers/fixture-materialize");
const { buildGguf } = require("./helpers/gguf-writer");

const MiB = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SMALL_FILES = new Set(["config.json", "generation_config.json", "tokenizer_config.json", "chat_template.jinja", "hf_quant_config.json"]);

async function tempDir(t, prefix = "content-digest-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function materialized(t, id, options = {}) {
  const result = await materializeFixture(id, options);
  t.after(() => result.cleanup());
  return result;
}

// Records every file the digest opens through fs.promises (and fails loudly
// if anything uses the synchronous or stream readers instead), with the bytes
// read from each.
function spyOnReads(t) {
  const opened = new Map();
  const promises = fs.promises;
  const originalOpen = promises.open;
  const originalReadFile = promises.readFile;
  const forbidden = ["readFileSync", "openSync", "readSync", "createReadStream"];
  const originals = Object.fromEntries(forbidden.map((name) => [name, fs[name]]));
  const sync = [];
  promises.open = async function spyOpen(file, ...rest) {
    const handle = await originalOpen.call(this, file, ...rest);
    const key = path.resolve(String(file));
    if (!opened.has(key)) opened.set(key, 0);
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      const result = await read(...args);
      opened.set(key, opened.get(key) + result.bytesRead);
      return result;
    };
    return handle;
  };
  promises.readFile = async function spyReadFile(file, ...rest) {
    const key = path.resolve(String(file));
    const content = await originalReadFile.call(this, file, ...rest);
    opened.set(key, (opened.get(key) || 0) + Buffer.byteLength(content));
    return content;
  };
  for (const name of forbidden) {
    fs[name] = function spySync(file, ...rest) {
      sync.push({ name, file: typeof file === "number" ? `fd:${file}` : path.resolve(String(file)) });
      return originals[name].call(this, file, ...rest);
    };
  }
  const restore = () => {
    promises.open = originalOpen;
    promises.readFile = originalReadFile;
    for (const name of forbidden) fs[name] = originals[name];
  };
  t.after(restore);
  return { opened, sync, restore };
}

test("a digest is sha256:<hex>, deterministic, and exposed as core.models.contentDigest.forDir", async (t) => {
  const model = await materialized(t, "qwen38-27b-fp8");
  const first = await contentDigestForDir(model.dir);
  const second = await core.models.contentDigest.forDir(model.dir);
  assert.match(first, DIGEST);
  assert.equal(second, first);
  const inventory = await scanInventory(model.dir);
  assert.equal(await contentDigestForDir(model.dir, { inventory }), first, "a passed inventory gives the same digest");
});

test("the digest reads only small files and the index, and stats the weights (fs spy)", async (t) => {
  const model = await materialized(t, "qwen38-27b-fp8");
  const inventory = await scanInventory(model.dir);
  const spy = spyOnReads(t);
  const digest = await contentDigestForDir(model.dir, { inventory });
  spy.restore();
  assert.match(digest, DIGEST);
  assert.deepEqual(spy.sync, [], "no synchronous or stream reads");
  const names = Array.from(spy.opened.keys()).map((file) => path.relative(model.dir, file).split(path.sep).join("/")).sort();
  assert.deepEqual(names, ["chat_template.jinja", "config.json", "generation_config.json", "model.safetensors.index.json", "tokenizer_config.json"]);
  for (const name of names) {
    const entry = inventory.files.find((file) => file.name === name);
    assert.equal(spy.opened.get(path.join(model.dir, ...name.split("/"))), entry.size, `${name} is read once, in full`);
    assert.ok(SMALL_FILES.has(name) || name.endsWith(".index.json"), name);
  }
  const weights = inventory.files.filter((file) => file.kind === "weights:safetensors");
  assert.equal(weights.length, 66);
  assert.ok(weights.every((file) => !spy.opened.has(path.join(model.dir, file.name))), "no shard is opened");
});

test("a GGUF digest reads the header only, never the tensor data (fs spy)", async (t) => {
  const model = await materialized(t, "deepseek-v4-flash-q2k-gguf");
  const captured = loadFixture("deepseek-v4-flash-q2k-gguf").ggufHeader.files[0];
  const spy = spyOnReads(t);
  const digest = await contentDigestForDir(model.dir);
  spy.restore();
  assert.match(digest, DIGEST);
  assert.deepEqual(spy.sync, []);
  const file = path.join(model.dir, captured.name);
  assert.deepEqual(Array.from(spy.opened.keys()), [file]);
  const read = spy.opened.get(file);
  // The header is 5.3 MB of a 97.6 GB file; the window grows by doubling.
  assert.ok(read >= captured.headerBytes - captured.alignment, `read ${read} bytes, enough for the header`);
  assert.ok(read <= 2 * captured.headerBytes + 2 * MiB, `read ${read} bytes, header-sized`);
  assert.ok(read < captured.bytes / 1000, "a sliver of the file");
});

test("renaming or moving a folder keeps the digest; its contents change it", async (t) => {
  const parent = await tempDir(t);
  const one = await materializeFixture("qwen38-27b-dspark-draft", { parent, name: "first-name" });
  const other = await tempDir(t);
  const two = await materializeFixture("qwen38-27b-dspark-draft", { parent: other, name: "a completely different name" });
  const digest = await contentDigestForDir(one.dir);
  assert.equal(await contentDigestForDir(two.dir), digest, "same content, other folder and name");

  // mtime alone is not content.
  const config = path.join(two.dir, "config.json");
  const later = new Date(Date.now() + 60_000);
  await fsp.utimes(config, later, later);
  assert.equal(await contentDigestForDir(two.dir), digest, "a touched file keeps the digest");

  // A changed small file changes it.
  const text = await fsp.readFile(config, "utf8");
  await fsp.writeFile(config, text.replace('"num_hidden_layers": 5', '"num_hidden_layers": 6'));
  const edited = await contentDigestForDir(two.dir);
  assert.notEqual(edited, digest, "config.json bytes count");

  // A weight file of another size changes it; the same size with other
  // payload bytes does not (weights are never read).
  const weights = path.join(one.dir, "model.safetensors");
  const size = (await fsp.stat(weights)).size;
  const handle = await fsp.open(weights, "r+");
  try {
    await handle.write(Buffer.from("payload"), 0, 7, size - 64);
  } finally {
    await handle.close();
  }
  assert.equal(await contentDigestForDir(one.dir), digest, "weight payload bytes are not read");
  await fsp.truncate(weights, size + 1);
  assert.notEqual(await contentDigestForDir(one.dir), digest, "weight sizes count");
});

test("unrelated files (README, LICENSE, code, dot folders) do not change the digest", async (t) => {
  const parent = await tempDir(t);
  const model = await materializeFixture("syn-llama3-8b", { parent, name: "llama" });
  const digest = await contentDigestForDir(model.dir);
  await fsp.writeFile(path.join(model.dir, "README.md"), "# changed\n");
  await fsp.writeFile(path.join(model.dir, "notes.txt"), "notes\n");
  await fsp.mkdir(path.join(model.dir, ".cache", "huggingface"), { recursive: true });
  await fsp.writeFile(path.join(model.dir, ".cache", "huggingface", "x.lock"), "");
  assert.equal(await contentDigestForDir(model.dir), digest);
});

test("tokenizer arrays count, not their contents; other KV values are kept in file order", () => {
  const kv = {
    "general.architecture": "llama",
    "tokenizer.ggml.tokens": { $array: "string", count: 128256 },
    "tokenizer.ggml.token_type": [1, 1, 3],
    "tokenizer.ggml.bos_token_id": 1,
    "llama.attention.sliding_window_pattern": [true, false],
    "tokenizer.chat_template": "{{ messages }}",
  };
  assert.deepEqual(canonicalGgufKv(kv), [
    ["general.architecture", "llama"],
    ["tokenizer.ggml.tokens", { $count: 128256 }],
    ["tokenizer.ggml.token_type", { $count: 3 }],
    ["tokenizer.ggml.bos_token_id", 1],
    ["llama.attention.sliding_window_pattern", [true, false]],
    ["tokenizer.chat_template", "{{ messages }}"],
  ]);
});

function writeGguf(file, kv, tensors = [{ name: "token_embd.weight", dims: [64, 32], typeId: 0 }]) {
  const built = buildGguf({ kv, tensors });
  fs.writeFileSync(file, built.header);
  fs.truncateSync(file, built.totalBytes);
}

const GGUF_KV = (name) => [
  { key: "general.architecture", type: "string", value: "llama" },
  { key: "general.name", type: "string", value: name },
  { key: "llama.block_count", type: "uint32", value: 2 },
  { key: "tokenizer.ggml.tokens", type: "array", itemType: "string", value: ["a", "b", "c"] },
];

test("a single-file card covers its GGUF (and split shards); the folder covers every GGUF", async (t) => {
  const dir = await tempDir(t);
  writeGguf(path.join(dir, "model-Q4_K_M.gguf"), GGUF_KV("q4"));
  writeGguf(path.join(dir, "model-Q8_0.gguf"), GGUF_KV("q8"));
  writeGguf(path.join(dir, "big-00001-of-00002.gguf"), [...GGUF_KV("split"), { key: "split.count", type: "uint16", value: 2 }]);
  writeGguf(path.join(dir, "big-00002-of-00002.gguf"), [{ key: "split.count", type: "uint16", value: 2 }]);
  const inventory = await scanInventory(dir);

  const folder = digestPlan(inventory);
  assert.deepEqual(folder.weights.map((entry) => entry.name), ["big-00001-of-00002.gguf", "big-00002-of-00002.gguf", "model-Q4_K_M.gguf", "model-Q8_0.gguf"]);
  assert.deepEqual(folder.gguf.map((entry) => entry.name), ["big-00001-of-00002.gguf", "model-Q4_K_M.gguf", "model-Q8_0.gguf"], "first shards only");
  const split = digestPlan(inventory, { file: "big-00001-of-00002.gguf" });
  assert.deepEqual(split.weights.map((entry) => entry.name), ["big-00001-of-00002.gguf", "big-00002-of-00002.gguf"]);
  assert.deepEqual(split.gguf.map((entry) => entry.name), ["big-00001-of-00002.gguf"]);

  const q4 = await contentDigestForDir(dir, { file: "model-Q4_K_M.gguf" });
  const q8 = await contentDigestForDir(dir, { file: "model-Q8_0.gguf" });
  const all = await contentDigestForDir(dir);
  assert.equal(new Set([q4, q8, all]).size, 3);
  // Another variant appearing next to it leaves a single-file digest alone.
  writeGguf(path.join(dir, "model-Q2_K.gguf"), GGUF_KV("q2"));
  assert.equal(await contentDigestForDir(dir, { file: "model-Q4_K_M.gguf" }), q4);
  assert.notEqual(await contentDigestForDir(dir), all);
});

test("fingerprintLocal: the stat-only cache key, and the digest reused while the key holds", async (t) => {
  const parent = await tempDir(t);
  const model = await materializeFixture("syn-reranker-seqcls", { parent, name: "reranker" });
  const first = await core.models.cache.fingerprintLocal(model.dir);
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.equal(first.contentDigest, await contentDigestForDir(model.dir));
  assert.ok(first.inventory.files.some((entry) => entry.name === "model.safetensors"));

  const spy = spyOnReads(t);
  const known = { key: first.key, contentDigest: "sha256:" + "0".repeat(64) };
  const again = await core.models.cache.fingerprintLocal(model.dir, { known });
  spy.restore();
  assert.equal(again.key, first.key);
  assert.equal(again.contentDigest, known.contentDigest, "an unchanged key reuses the known digest");
  assert.equal(spy.opened.size, 0, "and opens no file");

  const later = new Date(Date.now() + 60_000);
  await fsp.utimes(path.join(model.dir, "config.json"), later, later);
  const touched = await core.models.cache.fingerprintLocal(model.dir, { known });
  assert.notEqual(touched.key, first.key, "mtime is part of the key");
  assert.equal(touched.contentDigest, first.contentDigest, "but not of the content");
});

test("a damaged GGUF header or an unreadable small file still gives a digest (02 §20)", async (t) => {
  const dir = await tempDir(t);
  await fsp.writeFile(path.join(dir, "broken.gguf"), Buffer.from("GGUF not a header"));
  const broken = await contentDigestForDir(dir);
  assert.match(broken, DIGEST);
  await fsp.writeFile(path.join(dir, "broken.gguf"), Buffer.from("GGUF not a header either"));
  assert.notEqual(await contentDigestForDir(dir), broken, "its size still counts");

  const parent = await tempDir(t);
  const model = await materializeFixture("syn-llama3-8b", { parent, name: "llama" });
  const digest = await contentDigestForDir(model.dir);
  // A file that fails halfway hashes like one that fails at once.
  const failing = (failAfterReads) => ({
    promises: {
      async open(file, flags) {
        const handle = await fs.promises.open(file, flags);
        if (path.basename(String(file)) !== "config.json") return handle;
        let reads = 0;
        const read = handle.read.bind(handle);
        handle.read = async (...args) => {
          reads += 1;
          if (reads > failAfterReads) throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
          return read(...args);
        };
        return handle;
      },
    },
  });
  const atOnce = await contentDigestForDir(model.dir, { fs: failing(0) });
  assert.match(atOnce, DIGEST);
  assert.notEqual(atOnce, digest);
  assert.equal(await contentDigestForDir(model.dir, { fs: failing(0) }), atOnce, "deterministic");
  // A config.json over one read chunk (1 MiB): the first chunk reads, the second fails.
  const configFile = path.join(model.dir, "config.json");
  const text = await fsp.readFile(configFile, "utf8");
  await fsp.writeFile(configFile, text + " ".repeat(2 * MiB));
  assert.equal(await contentDigestForDir(model.dir, { fs: failing(1) }), await contentDigestForDir(model.dir, { fs: failing(0) }));
});
