"use strict";

// Inventory detector (docs/overhaul/02-models.md §5): what a model folder
// holds, from readdir and stat only. The folder and one level of subfolders
// are listed (the same depth as scripts/capture-model-fixture.js); dot entries
// (.cache, .git, .platform) and links are skipped, and at most 20,000 files
// are listed (02 §19). The scan is asynchronous so it can run on a manager's
// event loop: the fingerprint and the card cache need nothing more.
//
// The bounded file readers below are synchronous and meant for the inspect
// worker (inspect-worker.js), where the detectors run.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_DEPTH = 2;
const MAX_ENTRIES = 20000;
const STAT_BATCH = 64;
// 02 §5: JSON metadata files above 8 MiB are not parsed. A safetensors index
// is a different animal: a 400-shard checkpoint's index is tens of MiB, so it
// has the capture tool's index bound instead.
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

const ROOT_KINDS = Object.freeze({
  "config.json": "config",
  "generation_config.json": "generation-config",
  "tokenizer_config.json": "tokenizer-config",
  "chat_template.jinja": "template",
  "chat_template.json": "template-json",
  "hf_quant_config.json": "quant-config",
  "preprocessor_config.json": "processor",
  "processor_config.json": "processor",
  "video_preprocessor_config.json": "processor",
  "adapter_config.json": "adapter-config",
  "modules.json": "modules",
  "config_sentence_transformers.json": "sentence-transformers",
  "sentence_bert_config.json": "sentence-transformers",
  "tokenizer.json": "tokenizer",
  "tokenizer.model": "tokenizer",
  "vocab.json": "tokenizer",
  "merges.txt": "tokenizer",
  "special_tokens_map.json": "tokenizer",
  "added_tokens.json": "tokenizer",
  "sentencepiece.bpe.model": "tokenizer",
  "spiece.model": "tokenizer",
});
const TRANSFORMERS_WEIGHT_KINDS = new Set(["weights:safetensors", "weights:bin"]);

const COPY = Object.freeze({
  too_many_entries: (max) => ({
    zh: `文件夹中的文件超过 ${max} 个，只检查了前 ${max} 个。`,
    en: `The folder holds more than ${max} files; only the first ${max} were inspected.`,
  }),
  file_too_large: (name, max) => ({
    zh: `${name} 大于 ${Math.round(max / 1024 / 1024)} MiB，没有读取，相关信息未知。`,
    en: `${name} is larger than ${Math.round(max / 1024 / 1024)} MiB and was not read; the facts it holds are unknown.`,
  }),
  json_invalid: (name) => ({
    zh: `${name} 不是有效的 JSON，相关信息未知。`,
    en: `${name} is not valid JSON; the facts it holds are unknown.`,
  }),
  read_failed: (name) => ({
    zh: `无法读取 ${name}，相关信息未知。`,
    en: `${name} could not be read; the facts it holds are unknown.`,
  }),
});

class InventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
  }
}

function compareNames(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** The inventory class of a folder-relative name ("a/b.safetensors"). */
function classifyName(name) {
  const base = name.split("/").pop();
  const lower = base.toLowerCase();
  const atRoot = !name.includes("/");
  if (atRoot && Object.hasOwn(ROOT_KINDS, base)) return ROOT_KINDS[base];
  if (/^\d+_Pooling\/config\.json$/.test(name)) return "pooling";
  if (atRoot && lower.endsWith(".safetensors.index.json")) return "index:safetensors";
  if (atRoot && lower.endsWith(".bin.index.json")) return "index:bin";
  if (lower.endsWith(".safetensors")) return "weights:safetensors";
  if (lower.endsWith(".gguf")) return "weights:gguf";
  // The capture tool's rule: .bin/.pt/.pth count as weights when named like
  // weights (pytorch_model*.bin, adapter_model.bin), not training_args.bin.
  if (/\.(?:bin|pt|pth)$/.test(lower)) return /(?:pytorch_model|model)/.test(lower) ? "weights:bin" : "other";
  if (lower.endsWith(".complete.json")) return "complete-marker";
  if (lower.endsWith(".py")) return "python";
  if (/^license(?:\.|$)/.test(lower)) return "license";
  if (lower.endsWith(".md")) return "doc";
  if (lower.endsWith(".tiktoken")) return "tokenizer";
  return "other";
}

async function statAll(jobs) {
  const results = [];
  for (let start = 0; start < jobs.length; start += STAT_BATCH) {
    const batch = jobs.slice(start, start + STAT_BATCH);
    results.push(...await Promise.all(batch.map(async (job) => {
      try {
        return { job, stat: await fsp.stat(job.full) };
      } catch {
        return { job, stat: null };
      }
    })));
  }
  return results;
}

/**
 * scanInventory(dir, {maxEntries, signal}) -> Promise<Inventory>
 * Inventory: { dir, files: [{name, size, mtimeMs, kind}] sorted by name,
 * skipped: {hidden, links, deep}, truncated }. Names are folder-relative with
 * "/" separators; absolute paths stay out of the result.
 */
async function scanInventory(dir, options = {}) {
  const root = path.resolve(String(dir || ""));
  const maxEntries = Math.max(1, Number(options.maxEntries) || MAX_ENTRIES);
  const files = [];
  const skipped = { hidden: 0, links: 0, deep: 0 };
  let truncated = false;

  async function visit(abs, rel, depth) {
    if (options.signal?.aborted) throw abortError();
    const entries = (await fsp.readdir(abs, { withFileTypes: true })).sort((left, right) => compareNames(left.name, right.name));
    const jobs = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        skipped.hidden += 1;
        continue;
      }
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.links += 1;
      } else if (entry.isDirectory()) {
        if (depth + 1 < MAX_DEPTH) dirs.push({ full, name });
        else skipped.deep += 1;
      } else if (entry.isFile()) {
        if (files.length + jobs.length >= maxEntries) {
          truncated = true;
          break;
        }
        jobs.push({ full, name });
      }
    }
    for (const { job, stat } of await statAll(jobs)) {
      if (!stat || !stat.isFile()) continue;
      files.push({ name: job.name, size: stat.size, mtimeMs: stat.mtimeMs, kind: classifyName(job.name) });
    }
    for (const child of dirs) {
      if (truncated) break;
      await visit(child.full, child.name, depth + 1);
    }
  }

  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new InventoryError("not_a_directory", "The model path is not a folder.");
  await visit(root, "", 0);
  files.sort((left, right) => compareNames(left.name, right.name));
  return { dir: root, files, skipped, truncated, maxEntries };
}

function abortError() {
  const error = new Error("The inspection was cancelled.");
  error.name = "AbortError";
  error.code = "aborted";
  return error;
}

function fileEntry(inv, name) {
  return inv.files.find((entry) => entry.name === name) || null;
}

function filesOfKind(inv, kind, { rootOnly = false } = {}) {
  return inv.files.filter((entry) => entry.kind === kind && (!rootOnly || !entry.name.includes("/")));
}

function absolutePath(inv, name) {
  return path.join(inv.dir, ...name.split("/"));
}

/**
 * The transformers weight set (02 §4.3 format.layout): weights at the folder
 * root; a folder whose weights sit only in a subfolder is a custom layout.
 * GGUF files are handled by detectors/gguf.js.
 */
function transformersWeights(inv) {
  const root = inv.files.filter((entry) => !entry.name.includes("/") && TRANSFORMERS_WEIGHT_KINDS.has(entry.kind));
  if (root.length) return { files: root, nested: false };
  const nested = inv.files.filter((entry) => entry.name.includes("/") && TRANSFORMERS_WEIGHT_KINDS.has(entry.kind));
  return { files: nested, nested: nested.length > 0 };
}

function weightIndex(inv) {
  const indexes = filesOfKind(inv, "index:safetensors", { rootOnly: true });
  return indexes.find((entry) => entry.name === "model.safetensors.index.json") || indexes[0] || null;
}

function transformersLayout(inv, set) {
  if (!set.files.length) return null;
  if (set.nested) return "custom";
  if (weightIndex(inv) || filesOfKind(inv, "index:bin", { rootOnly: true }).length) return "indexed";
  return set.files.length > 1 ? "unindexed-shards" : "single";
}

function readBounded(inv, name, maxBytes) {
  // A remote inventory (remote/collect.js) serves the bytes it fetched up
  // front; it throws InventoryError file_too_large / read_failed itself.
  if (inv.remote) return inv.remote.readFile(name, maxBytes);
  const entry = fileEntry(inv, name);
  const size = entry ? entry.size : fs.statSync(absolutePath(inv, name)).size;
  if (size > maxBytes) throw new InventoryError("file_too_large", `${name} is larger than ${maxBytes} bytes.`);
  return fs.readFileSync(absolutePath(inv, name));
}

/**
 * Reads and parses a JSON file of the inventory (synchronous; worker side).
 * A missing file is null; an oversized, unreadable or invalid one is null
 * plus an error on the fact set, so inspection carries on (02 §20).
 */
function readJsonFile(inv, name, facts, { maxBytes = MAX_JSON_BYTES } = {}) {
  if (!fileEntry(inv, name)) return null;
  let buffer;
  try {
    buffer = readBounded(inv, name, maxBytes);
  } catch (error) {
    if (facts) {
      if (error.code === "file_too_large") facts.error("file_too_large", name, COPY.file_too_large(name, maxBytes));
      else facts.error("read_failed", name, COPY.read_failed(name));
    }
    return null;
  }
  try {
    return JSON.parse(buffer.toString("utf8").replace(/^﻿/, ""));
  } catch {
    if (facts) facts.error("json_invalid", name, COPY.json_invalid(name));
    return null;
  }
}

/** Reads a text file of the inventory (synchronous; worker side) or null. */
function readTextFile(inv, name, facts, { maxBytes = MAX_TEXT_BYTES } = {}) {
  if (!fileEntry(inv, name)) return null;
  try {
    return readBounded(inv, name, maxBytes).toString("utf8").replace(/^﻿/, "");
  } catch (error) {
    if (facts) {
      if (error.code === "file_too_large") facts.error("file_too_large", name, COPY.file_too_large(name, maxBytes));
      else facts.error("read_failed", name, COPY.read_failed(name));
    }
    return null;
  }
}

function inventoryWarnings(inv, facts) {
  if (inv.truncated) facts.warn("too_many_entries", COPY.too_many_entries(inv.maxEntries));
}

module.exports = {
  COPY,
  InventoryError,
  MAX_DEPTH,
  MAX_ENTRIES,
  MAX_INDEX_BYTES,
  MAX_JSON_BYTES,
  abortError,
  absolutePath,
  classifyName,
  compareNames,
  fileEntry,
  filesOfKind,
  inventoryWarnings,
  readJsonFile,
  readTextFile,
  scanInventory,
  transformersLayout,
  transformersWeights,
  weightIndex,
};
