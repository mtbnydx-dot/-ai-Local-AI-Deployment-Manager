"use strict";

// contentDigest (docs/overhaul/02-models.md §4.1): a rename-stable identity
// for a model's content. sha256 over, in this order:
//   - the bytes of config.json, generation_config.json, tokenizer_config.json,
//     chat_template.jinja and hf_quant_config.json (when present),
//   - the safetensors index (when present),
//   - the KV block of each GGUF model file, with the tokenizer arrays replaced
//     by their counts,
//   - the sorted (relative name, size) list of the weight files.
// Folder names and paths are not part of it, so a moved or renamed copy keeps
// its digest; host records, calibration and per-model overrides key on it.
//
// Weight files are only stat-ed. Small files are read in 1 MiB chunks and a
// GGUF file only up to the end of its header, through fs.promises file
// handles, so this can run on a manager's event loop (and a test can spy on
// exactly what is read).

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");
const { GgufNeedMoreBytes, parseGgufHeaderBuffer } = require("../gguf-metadata");
const { absolutePath, fileEntry, filesOfKind, scanInventory, transformersWeights, weightIndex } = require("./detectors/inventory");

const DIGEST_VERSION = "modelcard-content/v1";
const DIGEST_FILES = Object.freeze(["config.json", "generation_config.json", "tokenizer_config.json", "chat_template.jinja", "hf_quant_config.json"]);
const CHUNK_BYTES = 1024 * 1024;
// A metadata file this large is not metadata; it is listed by size only.
const MAX_HASHED_FILE_BYTES = 256 * 1024 * 1024;
const GGUF_INITIAL_BYTES = 2 * 1024 * 1024;
const GGUF_MAX_HEADER_BYTES = 256 * 1024 * 1024;
const SPLIT_GGUF = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

async function hashFileInto(hash, file, size, fs) {
  const handle = await fs.promises.open(file, "r");
  try {
    let position = 0;
    while (position < size) {
      const chunk = await readAt(handle, position, Math.min(CHUNK_BYTES, size - position));
      if (!chunk.length) break;
      hash.update(chunk);
      position += chunk.length;
    }
  } finally {
    await handle.close();
  }
}

/**
 * The widened header of a GGUF file, read from its first bytes only: 2 MiB,
 * then grown to what the parser asks for (doubling) until the header parses.
 */
async function readGgufHead(file, size, fs = nodeFs) {
  const handle = await fs.promises.open(file, "r");
  try {
    let buffer = Buffer.alloc(0);
    let want = Math.min(size, GGUF_INITIAL_BYTES);
    for (;;) {
      if (want > buffer.length) buffer = Buffer.concat([buffer, await readAt(handle, buffer.length, want - buffer.length)]);
      try {
        return parseGgufHeaderBuffer(buffer, { partial: true, fileBytes: size, path: file });
      } catch (error) {
        if (!(error instanceof GgufNeedMoreBytes) || buffer.length >= size || buffer.length >= GGUF_MAX_HEADER_BYTES) throw error;
        const required = Math.ceil(error.requiredBytes / CHUNK_BYTES) * CHUNK_BYTES;
        want = Math.min(size, GGUF_MAX_HEADER_BYTES, Math.max(required, buffer.length * 2));
      }
    }
  } finally {
    await handle.close();
  }
}

function isArrayValue(value) {
  return Array.isArray(value) || Boolean(value && typeof value === "object" && Object.hasOwn(value, "$array"));
}

/** The GGUF KV block in file order, tokenizer arrays reduced to their counts. */
function canonicalGgufKv(kv) {
  return Object.entries(kv || {}).map(([key, value]) => {
    if (key.startsWith("tokenizer.ggml.") && isArrayValue(value)) {
      return [key, { $count: Array.isArray(value) ? value.length : value.count }];
    }
    return [key, value];
  });
}

// GGUF files whose KV block counts: every model file, or for split models the
// first shard (the others repeat the split.* keys only).
function isFirstShard(name) {
  const match = path.posix.basename(name).match(SPLIT_GGUF);
  return !match || Number(match[2]) === 1;
}

function splitGroup(inv, file) {
  const base = path.posix.basename(file);
  const match = base.match(SPLIT_GGUF);
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  if (!match) return inv.files.filter((entry) => entry.name === file);
  const prefix = match[1].toLowerCase();
  return inv.files.filter((entry) => {
    if (entry.kind !== "weights:gguf" || !entry.name.startsWith(dir) || entry.name.slice(dir.length).includes("/")) return false;
    const other = path.posix.basename(entry.name).match(SPLIT_GGUF);
    return Boolean(other) && other[1].toLowerCase() === prefix && other[3] === match[3];
  });
}

/**
 * What the digest covers: { small: [entry], index: entry | null, gguf: [entry]
 * (KV blocks), weights: [entry] }. `file` (folder-relative) narrows a folder
 * to one GGUF model and its split shards.
 */
function digestPlan(inv, { file = null } = {}) {
  const small = DIGEST_FILES.map((name) => fileEntry(inv, name)).filter(Boolean);
  const index = weightIndex(inv);
  let weights;
  if (file) {
    weights = splitGroup(inv, file);
  } else {
    weights = [...transformersWeights(inv).files, ...filesOfKind(inv, "weights:gguf")];
  }
  weights = [...new Set(weights)].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const gguf = weights.filter((entry) => entry.kind === "weights:gguf" && isFirstShard(entry.name));
  return { small, index, gguf, weights };
}

/**
 * contentDigestForDir(dir, {file, inventory, fs}) -> Promise<"sha256:<hex>">
 * file: a folder-relative GGUF name for a single-file card. inventory: a
 * scanInventory result for `dir` (scanned when absent). fs: injectable for
 * tests (defaults to node:fs; only fs.promises.open is used for reads).
 */
async function contentDigestForDir(dir, options = {}) {
  const fs = options.fs || nodeFs;
  const inv = options.inventory || await scanInventory(dir);
  const plan = digestPlan(inv, { file: options.file || null });
  const hash = crypto.createHash("sha256");
  hash.update(`${DIGEST_VERSION}\n`);
  const hashEntry = async (label, entry) => {
    if (entry.size > MAX_HASHED_FILE_BYTES) {
      hash.update(`${label} ${entry.name} ${entry.size} unhashed\n`);
      return;
    }
    hash.update(`${label} ${entry.name} ${entry.size}\n`);
    await hashFileInto(hash, absolutePath(inv, entry.name), entry.size, fs);
    hash.update("\n");
  };
  for (const entry of plan.small) await hashEntry("file", entry);
  if (plan.index) await hashEntry("index", plan.index);
  for (const entry of plan.gguf) {
    const header = await readGgufHead(absolutePath(inv, entry.name), entry.size, fs);
    hash.update(`gguf-kv ${entry.name}\n${JSON.stringify(canonicalGgufKv(header.kv))}\n`);
  }
  hash.update("weights\n");
  for (const entry of plan.weights) hash.update(`${entry.name}\t${entry.size}\n`);
  return `sha256:${hash.digest("hex")}`;
}

module.exports = {
  DIGEST_FILES,
  DIGEST_VERSION,
  canonicalGgufKv,
  contentDigestForDir,
  digestPlan,
  readGgufHead,
};
