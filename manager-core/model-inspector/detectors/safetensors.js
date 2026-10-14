"use strict";

// safetensors detector (docs/overhaul/02-models.md §5). Every shard's header is
// read (8-byte length + JSON, at most 256 MiB): byte classes need the
// data_offsets, which an index does not have. No tensor payload is read. The
// index (model.safetensors.index.json) names the shards a complete download
// must have; a `.complete.json` marker without its shard is a missing shard
// too (per-shard conversion markers, 02 §2).
//
// Synchronous on purpose: this runs in the inspect worker.

const fs = require("node:fs");
const { MAX_INDEX_BYTES, absolutePath, fileEntry, filesOfKind, readJsonFile, weightIndex } = require("./inventory");
const { createTensorStats } = require("./topology");

const MAX_SAFETENSORS_HEADER = 256 * 1024 * 1024;

const COPY = Object.freeze({
  headerInvalid: (name, reason) => ({
    zh: `${name} 的 safetensors 头无效（${reason}），它的张量没有计入。`,
    en: `${name} has an invalid safetensors header (${reason}); its tensors are not counted.`,
  }),
  truncated: (count) => ({
    zh: `${count} 个权重文件比头部声明的数据短，可能没有下载完整。`,
    en: `${count} weight file(s) are shorter than the data their headers declare; the download may be incomplete.`,
  }),
  missing: (count) => ({
    zh: `缺少 ${count} 个权重文件（索引或 .complete.json 标记列出了它们）。`,
    en: `${count} weight file(s) are missing (named by the index or a .complete.json marker).`,
  }),
});

class SafetensorsHeaderError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SafetensorsHeaderError";
    this.code = "safetensors_header_invalid";
  }
}

function readExact(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!read) throw new SafetensorsHeaderError(`unexpected end of file at byte ${position + offset}`);
    offset += read;
  }
}

/**
 * Reads one safetensors header. Returns { headerBytes, metadata, tensors:
 * [{name, dtype, shape, bytes, begin}], payloadBytes, truncated }; throws
 * SafetensorsHeaderError for a malformed header.
 */
function readSafetensorsHeader(file, { size } = {}) {
  const fileBytes = Number.isSafeInteger(size) ? size : fs.statSync(file).size;
  if (fileBytes < 8) throw new SafetensorsHeaderError("shorter than the header length field");
  const fd = fs.openSync(file, "r");
  try {
    const lengthBuffer = Buffer.alloc(8);
    readExact(fd, lengthBuffer, 0);
    const length = lengthBuffer.readBigUInt64LE(0);
    if (length > BigInt(MAX_SAFETENSORS_HEADER) || Number(length) + 8 > fileBytes) {
      throw new SafetensorsHeaderError("header length is outside the file");
    }
    const headerBytes = Number(length);
    const buffer = Buffer.alloc(headerBytes);
    readExact(fd, buffer, 8);
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new SafetensorsHeaderError("header is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SafetensorsHeaderError("header is not an object");
    const tensors = [];
    let payloadBytes = 0;
    for (const [name, info] of Object.entries(parsed)) {
      if (name === "__metadata__") continue;
      const offsets = info?.data_offsets;
      const valid = info && typeof info.dtype === "string" && Array.isArray(info.shape)
        && info.shape.every((dim) => Number.isSafeInteger(dim) && dim >= 0)
        && Array.isArray(offsets) && offsets.length === 2
        && offsets.every((value) => Number.isSafeInteger(value) && value >= 0) && offsets[1] >= offsets[0];
      if (!valid) throw new SafetensorsHeaderError(`tensor entry ${JSON.stringify(name).slice(0, 120)} is malformed`);
      tensors.push({ name, dtype: info.dtype, shape: info.shape, bytes: offsets[1] - offsets[0], begin: offsets[0] });
      payloadBytes = Math.max(payloadBytes, offsets[1]);
    }
    const metadata = parsed.__metadata__ && typeof parsed.__metadata__ === "object" && !Array.isArray(parsed.__metadata__) ? parsed.__metadata__ : null;
    return { headerBytes, metadata, tensors, payloadBytes, truncated: fileBytes < 8 + headerBytes + payloadBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function shapeElements(shape) {
  return shape.reduce((product, dim) => product * dim, 1);
}

/** Names the index lists, relative to the folder root. */
function indexedShards(index) {
  const map = index && typeof index.weight_map === "object" && index.weight_map ? index.weight_map : {};
  return Array.from(new Set(Object.values(map).filter((value) => typeof value === "string" && value && !value.includes("..")))).sort();
}

function statsRef(files) {
  if (files.length === 1) return files[0].name;
  const dirs = new Set(files.map((entry) => (entry.name.includes("/") ? `${entry.name.slice(0, entry.name.lastIndexOf("/"))}/` : "")));
  return dirs.size === 1 ? `${[...dirs][0]}*.safetensors` : "*.safetensors";
}

/**
 * buildTensorTable(inv, facts, {files, depth, classes}) -> TensorTable
 * TensorTable: { stats (TensorStats, null for depth "quick"), indexName,
 * indexTotalBytes, missing: [name], truncated: [name] }. Errors and warnings
 * go to the fact set.
 */
function buildTensorTable(inv, facts, { files, depth = "full", classes } = {}) {
  const shards = files.filter((entry) => entry.kind === "weights:safetensors");
  const present = new Set(inv.files.map((entry) => entry.name));
  const missing = new Set();
  const truncated = [];

  const indexEntry = weightIndex(inv);
  const index = indexEntry ? readJsonFile(inv, indexEntry.name, facts, { maxBytes: MAX_INDEX_BYTES }) : null;
  for (const name of indexedShards(index)) if (!present.has(name)) missing.add(name);
  for (const marker of filesOfKind(inv, "complete-marker")) {
    const shard = `${marker.name.slice(0, -".complete.json".length)}.safetensors`;
    if (!fileEntry(inv, shard)) missing.add(shard);
  }
  const indexTotal = Number(index?.metadata?.total_size);
  const result = {
    stats: null,
    indexName: indexEntry ? indexEntry.name : null,
    indexTotalBytes: Number.isSafeInteger(indexTotal) && indexTotal >= 0 ? indexTotal : null,
    missing: [],
    truncated,
  };

  if (depth !== "quick" && shards.length) {
    const tensors = createTensorStats({ format: "safetensors", classes, ref: statsRef(shards) });
    for (const shard of shards) {
      let header;
      try {
        header = readSafetensorsHeader(absolutePath(inv, shard.name), { size: shard.size });
      } catch (error) {
        tensors.markInexact();
        tensors.addLayout(shard.size);
        const reason = error instanceof SafetensorsHeaderError ? error.message : "read failed";
        facts.error("safetensors_header_invalid", shard.name, COPY.headerInvalid(shard.name, reason));
        continue;
      }
      for (const tensor of header.tensors) {
        tensors.add(tensor.name, { dtype: tensor.dtype, elements: shapeElements(tensor.shape), bytes: tensor.bytes });
      }
      tensors.addLayout(8 + header.headerBytes + header.payloadBytes);
      if (header.truncated) truncated.push(shard.name);
    }
    if (missing.size) tensors.markInexact();
    result.stats = tensors.stats;
  }
  result.missing = Array.from(missing).sort();
  if (result.missing.length) facts.warn("weights_missing", COPY.missing(result.missing.length));
  if (truncated.length) facts.warn("weights_truncated", COPY.truncated(truncated.length));
  return result;
}

module.exports = {
  MAX_SAFETENSORS_HEADER,
  SafetensorsHeaderError,
  buildTensorTable,
  indexedShards,
  readSafetensorsHeader,
};
