"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ggmlTensorBytes, ggmlTypeInfo } = require("./model-inspector/ggml-types");

const GGUF_TYPES = Object.freeze({
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
});

const GGUF_FIXED_TYPE_BYTES = Object.freeze({
  [GGUF_TYPES.UINT8]: 1,
  [GGUF_TYPES.INT8]: 1,
  [GGUF_TYPES.UINT16]: 2,
  [GGUF_TYPES.INT16]: 2,
  [GGUF_TYPES.UINT32]: 4,
  [GGUF_TYPES.INT32]: 4,
  [GGUF_TYPES.FLOAT32]: 4,
  [GGUF_TYPES.BOOL]: 1,
  [GGUF_TYPES.UINT64]: 8,
  [GGUF_TYPES.INT64]: 8,
  [GGUF_TYPES.FLOAT64]: 8,
});

const GGUF_FILE_TYPE_NAMES = Object.freeze({
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  4: "Q4_1_F16",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "IQ3_XXS",
  22: "IQ1_S",
  23: "IQ4_NL",
  24: "IQ3_S",
  25: "IQ2_S",
  26: "IQ4_XS",
  27: "IQ1_M",
  28: "BF16",
  29: "Q4_0_4_4",
  30: "Q4_0_4_8",
  31: "Q4_0_8_8",
  32: "TQ1_0",
  33: "TQ2_0",
  34: "MXFP4",
});

const GGUF_TYPE_NAMES = Object.freeze(Object.fromEntries(Object.entries(GGUF_TYPES).map(([name, id]) => [id, name.toLowerCase()])));

const DEFAULT_CAPTURE_ARRAY_LIMIT = 4096;
const DEFAULT_CAPTURE_STRING_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_TENSOR_NAME_BYTES = 4096;
const DEFAULT_ALIGNMENT = 32;
const metadataCache = new Map();

// Thrown by parseGgufHeaderBuffer in partial mode when the buffer ends inside
// the header. requiredBytes is the smallest buffer length (from byte 0) that
// gets the parse past the read that failed; the remote Range reader grows its
// window to at least that and retries (02 §6.1).
class GgufNeedMoreBytes extends Error {
  constructor(requiredBytes, availableBytes) {
    super(`GGUF header needs at least ${requiredBytes} bytes; ${availableBytes} are available.`);
    this.name = "GgufNeedMoreBytes";
    this.code = "gguf_need_more_bytes";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

// Typed reads shared by the file and buffer readers; subclasses provide
// readBuffer, skip and ensureAvailable.
class GgufReaderBase {
  uint8() { return this.readBuffer(1).readUInt8(0); }
  int8() { return this.readBuffer(1).readInt8(0); }
  uint16() { return this.littleEndian ? this.readBuffer(2).readUInt16LE(0) : this.readBuffer(2).readUInt16BE(0); }
  int16() { return this.littleEndian ? this.readBuffer(2).readInt16LE(0) : this.readBuffer(2).readInt16BE(0); }
  uint32() { return this.littleEndian ? this.readBuffer(4).readUInt32LE(0) : this.readBuffer(4).readUInt32BE(0); }
  int32() { return this.littleEndian ? this.readBuffer(4).readInt32LE(0) : this.readBuffer(4).readInt32BE(0); }
  float32() { return this.littleEndian ? this.readBuffer(4).readFloatLE(0) : this.readBuffer(4).readFloatBE(0); }
  float64() { return this.littleEndian ? this.readBuffer(8).readDoubleLE(0) : this.readBuffer(8).readDoubleBE(0); }
  uint64() { return this.littleEndian ? this.readBuffer(8).readBigUInt64LE(0) : this.readBuffer(8).readBigUInt64BE(0); }
  int64() { return this.littleEndian ? this.readBuffer(8).readBigInt64LE(0) : this.readBuffer(8).readBigInt64BE(0); }
}

class BufferedFileReader extends GgufReaderBase {
  constructor(file, fileBytes, options = {}) {
    super();
    this.file = file;
    this.fileBytes = Number(fileBytes || 0);
    this.fd = fs.openSync(file, "r");
    this.offset = 0;
    this.littleEndian = true;
    this.chunkBytes = Math.max(64 * 1024, Number(options.chunkBytes || 1024 * 1024));
    this.buffer = Buffer.alloc(this.chunkBytes);
    this.bufferStart = -1;
    this.bufferLength = 0;
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  ensureAvailable(length) {
    const bytes = Number(length || 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > this.fileBytes) {
      throw new Error(`GGUF metadata exceeds file bounds at byte ${this.offset}.`);
    }
  }

  readBuffer(length) {
    const bytes = Number(length || 0);
    this.ensureAvailable(bytes);
    if (bytes === 0) return Buffer.alloc(0);
    if (bytes > this.buffer.length) {
      const output = Buffer.allocUnsafe(bytes);
      const read = fs.readSync(this.fd, output, 0, bytes, this.offset);
      if (read !== bytes) throw new Error(`Unable to read ${bytes} GGUF bytes at offset ${this.offset}.`);
      this.offset += bytes;
      return output;
    }
    const insideBuffer = this.bufferStart >= 0
      && this.offset >= this.bufferStart
      && this.offset + bytes <= this.bufferStart + this.bufferLength;
    if (!insideBuffer) {
      this.bufferStart = this.offset;
      this.bufferLength = fs.readSync(this.fd, this.buffer, 0, this.buffer.length, this.bufferStart);
      if (this.bufferLength < bytes) throw new Error(`Unable to read ${bytes} GGUF bytes at offset ${this.offset}.`);
    }
    const start = this.offset - this.bufferStart;
    const output = this.buffer.subarray(start, start + bytes);
    this.offset += bytes;
    return output;
  }

  skip(length) {
    const bytes = Number(length || 0);
    this.ensureAvailable(bytes);
    this.offset += bytes;
  }
}

// Reads a header from memory (the first bytes of a file, e.g. a remote Range
// response). Without `partial` the buffer is the whole file and running past
// its end is the usual bounds error; with `partial` it throws
// GgufNeedMoreBytes, unless `fileBytes` shows the file itself is too short.
class GgufBufferReader extends GgufReaderBase {
  constructor(buffer, options = {}) {
    super();
    this.buffer = buffer;
    this.partial = options.partial === true;
    this.fileBytes = knownFileBytes(options.fileBytes);
    this.offset = 0;
    this.littleEndian = true;
  }

  close() {}

  ensureAvailable(length) {
    const bytes = Number(length || 0);
    const end = this.offset + bytes;
    if (Number.isSafeInteger(bytes) && bytes >= 0 && end <= this.buffer.length) return;
    if (this.partial && Number.isSafeInteger(end) && bytes >= 0 && (this.fileBytes === null || end <= this.fileBytes)) {
      throw new GgufNeedMoreBytes(end, this.buffer.length);
    }
    throw new Error(`GGUF metadata exceeds file bounds at byte ${this.offset}.`);
  }

  readBuffer(length) {
    const bytes = Number(length || 0);
    this.ensureAvailable(bytes);
    const output = this.buffer.subarray(this.offset, this.offset + bytes);
    this.offset += bytes;
    return output;
  }

  skip(length) {
    const bytes = Number(length || 0);
    this.ensureAvailable(bytes);
    this.offset += bytes;
  }
}

function bigintToJsonNumber(value) {
  if (typeof value !== "bigint") return value;
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  return value.toString();
}

function countValue(value, fallback = 0) {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return fallback;
    return Number(value);
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

// A string over the capture limit is skipped: null, or { $string: length }
// when `placeholder` is set (widened capture keeps the fact that it exists).
function readGgufString(reader, capture, maxCaptureBytes = DEFAULT_CAPTURE_STRING_BYTES, placeholder = false) {
  const length = countValue(reader.uint64(), -1);
  if (length < 0) throw new Error("GGUF string length is outside the supported range.");
  if (!capture || length > maxCaptureBytes) {
    reader.skip(length);
    if (!capture) return undefined;
    return placeholder ? { $string: length } : null;
  }
  return reader.readBuffer(length).toString("utf8");
}

function readGgufScalar(reader, type, capture = true, options = {}) {
  switch (type) {
    case GGUF_TYPES.UINT8: return capture ? reader.uint8() : reader.skip(1);
    case GGUF_TYPES.INT8: return capture ? reader.int8() : reader.skip(1);
    case GGUF_TYPES.UINT16: return capture ? reader.uint16() : reader.skip(2);
    case GGUF_TYPES.INT16: return capture ? reader.int16() : reader.skip(2);
    case GGUF_TYPES.UINT32: return capture ? reader.uint32() : reader.skip(4);
    case GGUF_TYPES.INT32: return capture ? reader.int32() : reader.skip(4);
    case GGUF_TYPES.FLOAT32: return capture ? reader.float32() : reader.skip(4);
    case GGUF_TYPES.BOOL: return capture ? Boolean(reader.uint8()) : reader.skip(1);
    case GGUF_TYPES.STRING: return readGgufString(reader, capture, DEFAULT_CAPTURE_STRING_BYTES, options.placeholders === true);
    case GGUF_TYPES.UINT64: return capture ? bigintToJsonNumber(reader.uint64()) : reader.skip(8);
    case GGUF_TYPES.INT64: return capture ? bigintToJsonNumber(reader.int64()) : reader.skip(8);
    case GGUF_TYPES.FLOAT64: return capture ? reader.float64() : reader.skip(8);
    default: throw new Error(`Unsupported GGUF metadata type ${type}.`);
  }
}

function skipGgufArray(reader, elementType, count) {
  const fixedBytes = GGUF_FIXED_TYPE_BYTES[elementType];
  if (fixedBytes) {
    reader.skip(count * fixedBytes);
    return;
  }
  if (elementType === GGUF_TYPES.STRING) {
    for (let index = 0; index < count; index += 1) readGgufString(reader, false);
    return;
  }
  if (elementType === GGUF_TYPES.ARRAY) {
    for (let index = 0; index < count; index += 1) readGgufValue(reader, GGUF_TYPES.ARRAY, false);
    return;
  }
  throw new Error(`Unsupported GGUF array element type ${elementType}.`);
}

// options.placeholders: an array over maxArrayItems becomes
// { $array: <item type>, count } and a long string { $string: length }
// instead of null (02 §5.1).
function readGgufValue(reader, type, capture = true, options = {}) {
  if (type !== GGUF_TYPES.ARRAY) return readGgufScalar(reader, type, capture, options);
  const elementType = reader.uint32();
  const count = countValue(reader.uint64(), -1);
  if (count < 0) throw new Error("GGUF array length is outside the supported range.");
  const maxItems = Math.max(0, Number(options.maxArrayItems ?? DEFAULT_CAPTURE_ARRAY_LIMIT));
  if (!capture || count > maxItems) {
    skipGgufArray(reader, elementType, count);
    if (!capture) return undefined;
    return options.placeholders === true ? { $array: GGUF_TYPE_NAMES[elementType], count } : null;
  }
  const values = [];
  for (let index = 0; index < count; index += 1) {
    values.push(readGgufValue(reader, elementType, true, options));
  }
  return values;
}

function shouldCaptureMetadataKey(key) {
  const value = String(key || "");
  if (/^general\.(?!description$|license\.text$)/.test(value)) return true;
  if (/^split\./.test(value)) return true;
  if (/^tokenizer\.ggml\.(?:model|bos_token_id|eos_token_id|eot_token_id|mask_token_id)$/.test(value)) return true;
  if (/^(?:clip|dflash|dflash-draft)\./.test(value)) return true;
  return /\.(?:architecture|context_length|embedding_length|block_count|feed_forward_length|expert_count|expert_used_count|head_count|head_count_kv|key_length|value_length|dimension_count|sliding_window|sliding_window_pattern|target_layers|block_size)$/.test(value);
}

// Widened capture keeps every KV pair; the legacy whitelist (above) still
// decides what lands in `metadata`. A placeholder there was null before.
function isGgufPlaceholder(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.hasOwn(value, "$array") || Object.hasOwn(value, "$string"));
}

function legacyMetadataValue(value) {
  if (isGgufPlaceholder(value)) return null;
  return Array.isArray(value) ? value.map(legacyMetadataValue) : value;
}

// GGUF keys are arbitrary text; defineProperty keeps "__proto__" an own key.
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

// Decodes the magic, the counts, the KV block and the tensor-info table; no
// tensor data is read. Legacy mode keeps the whitelisted keys and element
// counts only. Widened mode (02 §5.1) also returns every KV pair in file
// order (arrays over 4096 items as { $array, count }, strings over 1 MiB as
// { $string }) and every tensor info with its exact bytes, null for an
// unknown ggml type.
function parseGgufHeader(reader, { widened = false } = {}) {
  const magic = reader.readBuffer(4).toString("ascii");
  if (magic === "GGUF") reader.littleEndian = true;
  else if (magic === "FUGG") reader.littleEndian = false;
  else throw new Error(`Invalid GGUF magic ${JSON.stringify(magic)}.`);
  const version = reader.uint32();
  if (version < 1 || version > 3) throw new Error(`Unsupported GGUF version ${version}.`);
  const tensorCount = countValue(reader.uint64(), -1);
  const metadataCount = countValue(reader.uint64(), -1);
  if (tensorCount < 0 || metadataCount < 0) throw new Error("GGUF header counts exceed the supported range.");
  const metadata = {};
  const kv = widened ? {} : null;
  for (let index = 0; index < metadataCount; index += 1) {
    const key = readGgufString(reader, true, MAX_KEY_BYTES);
    if (!key) throw new Error(`GGUF metadata key ${index} is empty or too large.`);
    const type = reader.uint32();
    const capture = shouldCaptureMetadataKey(key);
    if (widened) {
      const value = readGgufValue(reader, type, true, { maxArrayItems: DEFAULT_CAPTURE_ARRAY_LIMIT, placeholders: true });
      defineOwn(kv, key, value);
      const legacy = capture ? legacyMetadataValue(value) : null;
      if (legacy !== undefined && legacy !== null) metadata[key] = legacy;
      continue;
    }
    const value = readGgufValue(reader, type, capture, {
      maxArrayItems: capture ? DEFAULT_CAPTURE_ARRAY_LIMIT : 0,
    });
    if (capture && value !== undefined && value !== null) metadata[key] = value;
  }

  let parameterCount = 0;
  const tensors = widened ? [] : null;
  for (let index = 0; index < tensorCount; index += 1) {
    const name = readGgufString(reader, widened, MAX_TENSOR_NAME_BYTES);
    if (widened && typeof name !== "string") throw new Error(`GGUF tensor ${index} name is too large.`);
    const dimensions = reader.uint32();
    if (dimensions > 8) throw new Error(`GGUF tensor ${index} has invalid dimension count ${dimensions}.`);
    const dims = [];
    let tensorElements = 1;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const length = countValue(reader.uint64(), -1);
      if (length < 0) throw new Error(`GGUF tensor ${index} dimension is outside the supported range.`);
      dims.push(length);
      tensorElements *= length;
    }
    const typeId = reader.uint32();
    const offset = countValue(reader.uint64(), -1);
    parameterCount += tensorElements;
    if (!widened) continue;
    if (offset < 0) throw new Error(`GGUF tensor ${index} offset is outside the supported range.`);
    tensors.push({
      name,
      type: ggmlTypeInfo(typeId)?.name ?? null,
      typeId,
      dims,
      offset,
      bytes: ggmlTensorBytes(typeId, dims),
    });
  }
  return { version, tensorCount, metadataCount, metadata, kv, tensors, parameterCount, tensorInfoEnd: reader.offset };
}

function readGgufMetadataSync(file, options = {}) {
  const resolved = path.resolve(String(file || ""));
  const stat = options.stat || fs.statSync(resolved);
  const cacheKey = `${resolved}|${stat.size}|${stat.mtimeMs}`;
  if (options.cache !== false && metadataCache.has(cacheKey)) return metadataCache.get(cacheKey);
  const reader = new BufferedFileReader(resolved, stat.size, options);
  try {
    const { version, tensorCount, metadataCount, metadata, parameterCount } = parseGgufHeader(reader);
    const architecture = String(metadata["general.architecture"] || "").trim().toLowerCase();
    const result = normalizeGgufMetadata({
      path: resolved,
      fileBytes: stat.size,
      version,
      tensorCount,
      metadataCount,
      metadata,
      parameterCount,
    });
    if (!result.architecture && architecture) result.architecture = architecture;
    if (options.cache !== false) {
      for (const key of metadataCache.keys()) {
        if (key.startsWith(`${resolved}|`) && key !== cacheKey) metadataCache.delete(key);
      }
      metadataCache.set(cacheKey, result);
    }
    return result;
  } finally {
    reader.close();
  }
}

const TENSOR_WARNING_COPY = Object.freeze({
  ggml_type_unknown: (count, ids) => ({
    zh: `${count} 个张量使用未知的 ggml 类型（编号 ${ids}），它们的大小按文件布局取上限，不是精确值。`,
    en: `${count} tensor(s) use unknown ggml type id(s) ${ids}; their sizes are upper bounds from the file layout, not exact.`,
  }),
  tensor_size_mismatch: (count) => ({
    zh: `${count} 个张量的计算大小超出了到下一个张量的空间，权重大小不可靠。`,
    en: `${count} tensor(s) are larger than the space before the next tensor; the weight bytes are not reliable.`,
  }),
  gguf_payload_short: () => ({
    zh: "文件比头部声明的张量数据短，可能没有下载完整。",
    en: "The file is shorter than the tensor data its header declares; it may be an incomplete download.",
  }),
});

// Sizes come from the type table. Sorted by offset, the gap to the next tensor
// (or to the end of the file, when its size is known) bounds each tensor: a
// known size larger than the gap is a mismatch, and an unknown type gets the
// gap as `bytesUpper`. Totals then hold the upper bound and exact is false.
// tensorBytes sums the tensors; totalBytes is the file size the header lays
// out (header, tensors and their alignment padding), which is what a complete
// file, or a remote sibling listing, reports.
function summarizeTensorBytes(tensors, { headerBytes, fileBytes, alignment }) {
  const ordered = [...tensors].sort((left, right) => left.offset - right.offset);
  const dataBytes = fileBytes === null ? null : fileBytes - headerBytes;
  const byType = {};
  const unknownTypeIds = new Set();
  let tensorBytes = 0;
  let unknown = 0;
  let unbounded = 0;
  let mismatched = 0;
  let dataEnd = 0;
  ordered.forEach((tensor, position) => {
    const next = ordered[position + 1];
    const limit = next ? next.offset : dataBytes;
    const gap = limit === null ? null : limit - tensor.offset;
    let bytes = tensor.bytes;
    if (bytes === null) {
      unknown += 1;
      unknownTypeIds.add(tensor.typeId);
      tensor.bytesUpper = gap !== null && gap >= 0 ? gap : null;
      if (tensor.bytesUpper === null) unbounded += 1;
      bytes = tensor.bytesUpper || 0;
    } else if (next && bytes > gap) {
      mismatched += 1;
    }
    const typeKey = tensor.type || `type-${tensor.typeId}`;
    byType[typeKey] = (byType[typeKey] || 0) + bytes;
    tensorBytes += bytes;
    dataEnd = Math.max(dataEnd, tensor.offset + bytes);
  });
  const typeIds = Array.from(unknownTypeIds).sort((left, right) => left - right);
  const warnings = [];
  if (unknown) {
    warnings.push({
      code: "ggml_type_unknown",
      tensors: unknown,
      typeIds,
      message: TENSOR_WARNING_COPY.ggml_type_unknown(unknown, typeIds.join(", ")),
    });
  }
  if (mismatched) {
    warnings.push({ code: "tensor_size_mismatch", tensors: mismatched, message: TENSOR_WARNING_COPY.tensor_size_mismatch(mismatched) });
  }
  if (dataBytes !== null && dataEnd > dataBytes) {
    warnings.push({ code: "gguf_payload_short", message: TENSOR_WARNING_COPY.gguf_payload_short() });
  }
  return {
    weights: {
      exact: unknown === 0 && mismatched === 0,
      totalBytes: headerBytes + alignUp(dataEnd, alignment),
      tensorBytes,
      byType,
      unknownTypeIds: typeIds,
      unboundedTensors: unbounded,
    },
    warnings,
  };
}

function knownFileBytes(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

// The widened result: every field readGgufMetadataSync returns (same values;
// `metadata` is still the whitelist) plus kv, alignment, headerBytes (the
// aligned start of the tensor data), tensors, weights and warnings.
function widenedHeaderResult(parsed, { file, fileBytes }) {
  const alignmentValue = Number(parsed.kv["general.alignment"]);
  const alignment = Number.isSafeInteger(alignmentValue) && alignmentValue > 0 ? alignmentValue : DEFAULT_ALIGNMENT;
  const headerBytes = alignUp(parsed.tensorInfoEnd, alignment);
  const { weights, warnings } = summarizeTensorBytes(parsed.tensors, { headerBytes, fileBytes, alignment });
  return {
    ...normalizeGgufMetadata({
      path: file,
      fileBytes,
      version: parsed.version,
      tensorCount: parsed.tensorCount,
      metadataCount: parsed.metadataCount,
      metadata: parsed.metadata,
      parameterCount: parsed.parameterCount,
    }),
    fileBytes,
    kv: parsed.kv,
    alignment,
    headerBytes,
    tensors: parsed.tensors,
    weights,
    warnings,
  };
}

/**
 * Widened header of a local GGUF file (02 §5.1), read synchronously; only
 * header bytes are read. Not cached: the model-card cache sits above it.
 */
function readGgufHeaderSync(file, options = {}) {
  const resolved = path.resolve(String(file || ""));
  const stat = options.stat || fs.statSync(resolved);
  const reader = new BufferedFileReader(resolved, stat.size, options);
  try {
    return widenedHeaderResult(parseGgufHeader(reader, { widened: true }), { file: resolved, fileBytes: stat.size });
  } finally {
    reader.close();
  }
}

/**
 * Widened header from the first bytes of a GGUF file, e.g. a Range response.
 * options: partial (the buffer may end inside the header: throw
 * GgufNeedMoreBytes {requiredBytes} instead of a bounds error), fileBytes
 * (the full file size when known: bounds unknown-type tensors and flags a
 * short payload), path (a file name, used for role and split detection).
 */
function parseGgufHeaderBuffer(buffer, options = {}) {
  if (!(buffer instanceof Uint8Array)) throw new TypeError("parseGgufHeaderBuffer needs a Buffer or Uint8Array.");
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const fileBytes = knownFileBytes(options.fileBytes);
  const reader = new GgufBufferReader(bytes, { partial: options.partial === true, fileBytes });
  const file = options.path ? String(options.path) : undefined;
  return widenedHeaderResult(parseGgufHeader(reader, { widened: true }), { file, fileBytes });
}

function metadataNumber(metadata, keys, fallback = null) {
  for (const key of keys) {
    const value = metadata[key];
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return fallback;
}

function architectureKey(metadata, architecture, suffix) {
  const direct = `${architecture}.${suffix}`;
  if (Object.hasOwn(metadata, direct)) return direct;
  return Object.keys(metadata).find((key) => key.endsWith(`.${suffix}`)) || direct;
}

function normalizeGgufMetadata(input = {}) {
  const metadata = input.metadata || {};
  const architecture = String(metadata["general.architecture"] || "").trim().toLowerCase();
  const blockCount = metadataNumber(metadata, [architectureKey(metadata, architecture, "block_count")]);
  const embeddingLength = metadataNumber(metadata, [architectureKey(metadata, architecture, "embedding_length")]);
  const attentionHeads = metadataNumber(metadata, [architectureKey(metadata, architecture, "attention.head_count")]);
  const kvHeads = metadataNumber(metadata, [architectureKey(metadata, architecture, "attention.head_count_kv")], attentionHeads);
  const keyLength = metadataNumber(metadata, [
    architectureKey(metadata, architecture, "attention.key_length"),
    architectureKey(metadata, architecture, "rope.dimension_count"),
  ], attentionHeads && embeddingLength ? embeddingLength / attentionHeads : null);
  const valueLength = metadataNumber(metadata, [architectureKey(metadata, architecture, "attention.value_length")], keyLength);
  const slidingWindowPattern = metadata[architectureKey(metadata, architecture, "attention.sliding_window_pattern")]
    || metadata[architectureKey(metadata, architecture, "sliding_window_pattern")]
    || null;
  const slidingWindow = metadataNumber(metadata, [
    architectureKey(metadata, architecture, "attention.sliding_window"),
    architectureKey(metadata, architecture, "sliding_window"),
  ]);
  const generalParameterCount = metadataNumber(metadata, ["general.parameter_count"]);
  const parameterCount = Number(input.parameterCount || generalParameterCount || 0);
  const fileType = metadataNumber(metadata, ["general.file_type"]);
  const role = classifyGgufRole({
    path: input.path,
    architecture,
    generalType: metadata["general.type"],
  });
  const pattern = Array.isArray(slidingWindowPattern) ? slidingWindowPattern.map(Boolean) : null;
  // Legacy semantics, kept because the legacy memory estimate reads it: a
  // window without a pattern counts every layer as SWA. The model card does
  // not inherit this (02 §5.1): from the widened `kv` a window-only file has
  // an unknown layer split unless its family declares ggufSwaAllLayers.
  const slidingLayers = pattern ? pattern.filter(Boolean).length : slidingWindow ? blockCount : 0;
  const globalLayers = pattern && blockCount ? Math.max(0, blockCount - slidingLayers) : slidingWindow ? 0 : blockCount;
  return {
    path: input.path,
    fileBytes: Number(input.fileBytes || 0),
    version: Number(input.version || 0),
    tensorCount: Number(input.tensorCount || 0),
    metadataCount: Number(input.metadataCount || 0),
    architecture,
    role,
    modelName: String(metadata["general.name"] || metadata["general.basename"] || path.basename(input.path || "", ".gguf")),
    basename: String(metadata["general.basename"] || ""),
    sizeLabel: String(metadata["general.size_label"] || ""),
    fileType,
    quantization: GGUF_FILE_TYPE_NAMES[fileType] || (fileType === null ? "" : `type-${fileType}`),
    parameterCount,
    paramsB: parameterCount > 0 ? parameterCount / 1e9 : inferParamsB(metadata["general.size_label"], input.path) || null,
    layers: blockCount,
    kvLayers: blockCount,
    embeddingLength,
    attentionHeads,
    kvHeads,
    headDim: keyLength,
    keyLength,
    valueLength,
    contextLength: metadataNumber(metadata, [architectureKey(metadata, architecture, "context_length")]),
    slidingWindow,
    slidingWindowPattern: pattern,
    slidingLayers,
    globalLayers,
    split: normalizeSplitInfo(metadata, input.path),
    metadata,
  };
}

function inferParamsB(...values) {
  for (const value of values) {
    const text = String(value || "");
    const match = text.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*[bB](?:[^a-z]|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function normalizeSplitInfo(metadata = {}, file = "") {
  const filename = path.basename(String(file || ""));
  const match = filename.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  const count = metadataNumber(metadata, ["split.count"], match ? Number(match[3]) : 1) || 1;
  const metadataIndex = metadataNumber(metadata, ["split.no"]);
  const index = metadataIndex === null ? (match ? Number(match[2]) : 1) : Number(metadataIndex) + 1;
  return {
    index,
    count,
    tensorCount: metadataNumber(metadata, ["split.tensors.count"]),
    prefix: match ? match[1] : filename.replace(/\.gguf$/i, ""),
  };
}

function classifyGgufRole(input = {}) {
  const filename = path.basename(String(input.path || "")).toLowerCase();
  const architecture = String(input.architecture || "").toLowerCase();
  const generalType = String(input.generalType || "").toLowerCase();
  if (/^mmproj(?:[-_.]|$)/i.test(filename) || /projector|mmproj/.test(generalType) || /^(?:clip|vision|mmproj)/.test(architecture)) return "mmproj";
  if (/^(?:dflash|draft|mtp)(?:[-_.]|$)/i.test(filename)
    || /(?:^|[-_.])(?:dflash|draft)(?:[-_.]|$)/i.test(filename)
    || /dflash|draft/.test(generalType)
    || /dflash|draft/.test(architecture)) return "draft";
  return "model";
}

function inspectGgufFileSync(file, options = {}) {
  const resolved = path.resolve(String(file?.path || file || ""));
  let stat;
  try {
    stat = file?.stat || fs.statSync(resolved);
    const parsed = readGgufMetadataSync(resolved, { ...options, stat });
    return {
      ...(file && typeof file === "object" ? file : {}),
      ...parsed,
      path: resolved,
      name: file?.name || path.basename(resolved),
      size: stat.size,
      fileBytes: stat.size,
      metadataError: "",
    };
  } catch (error) {
    return {
      ...(file && typeof file === "object" ? file : {}),
      path: resolved,
      name: file?.name || path.basename(resolved),
      size: Number(file?.size || stat?.size || 0),
      fileBytes: Number(file?.size || stat?.size || 0),
      architecture: "",
      role: classifyGgufRole({ path: resolved }),
      parameterCount: 0,
      paramsB: inferParamsB(resolved),
      split: normalizeSplitInfo({}, resolved),
      metadata: {},
      metadataError: error.message,
    };
  }
}

function groupKeyForGguf(file) {
  const split = file.split || normalizeSplitInfo(file.metadata, file.path);
  return `${path.dirname(file.path).toLowerCase()}|${String(split.prefix || path.basename(file.path, ".gguf")).toLowerCase()}|${file.role}`;
}

function summarizeGgufGroup(files) {
  const ordered = [...files].sort((left, right) => Number(left.split?.index || 1) - Number(right.split?.index || 1));
  const primary = ordered[0];
  const expectedShards = Math.max(1, ...ordered.map((file) => Number(file.split?.count || 1)));
  const indexes = new Set(ordered.map((file) => Number(file.split?.index || 1)));
  const complete = expectedShards === ordered.length && Array.from({ length: expectedShards }, (_, index) => index + 1).every((index) => indexes.has(index));
  const fileBytes = ordered.reduce((sum, file) => sum + Number(file.fileBytes || file.size || 0), 0);
  const parameterCount = ordered.reduce((sum, file) => sum + Number(file.parameterCount || 0), 0);
  return {
    id: primary.path,
    path: primary.path,
    launchModel: primary.path,
    name: primary.name,
    label: expectedShards > 1 ? String(primary.split?.prefix || primary.name) : primary.name,
    role: primary.role,
    architecture: primary.architecture || "",
    modelName: primary.modelName || "",
    quantization: primary.quantization || "",
    fileType: primary.fileType ?? null,
    fileBytes,
    size: fileBytes,
    parameterCount,
    paramsB: parameterCount > 0 ? parameterCount / 1e9 : primary.paramsB || null,
    layers: primary.layers || null,
    kvLayers: primary.kvLayers || primary.layers || null,
    embeddingLength: primary.embeddingLength || null,
    attentionHeads: primary.attentionHeads || null,
    kvHeads: primary.kvHeads || null,
    headDim: primary.headDim || null,
    keyLength: primary.keyLength || primary.headDim || null,
    valueLength: primary.valueLength || primary.headDim || null,
    contextLength: primary.contextLength || null,
    slidingWindow: primary.slidingWindow || null,
    slidingWindowPattern: primary.slidingWindowPattern || null,
    slidingLayers: primary.slidingLayers ?? null,
    globalLayers: primary.globalLayers ?? null,
    shardCount: expectedShards,
    complete,
    files: ordered.map((file) => ({
      path: file.path,
      name: file.name,
      size: file.fileBytes || file.size || 0,
      fileBytes: file.fileBytes || file.size || 0,
      shardIndex: file.split?.index || 1,
      shardCount: file.split?.count || 1,
      metadataError: file.metadataError || "",
    })),
    metadata: primary.metadata || {},
    metadataError: ordered.map((file) => file.metadataError).filter(Boolean).join("; "),
  };
}

function buildGgufInventory(files = [], options = {}) {
  const inspected = files.map((file) => inspectGgufFileSync(file, options));
  const groups = new Map();
  for (const file of inspected) {
    const key = groupKeyForGguf(file);
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }
  const summaries = Array.from(groups.values()).map(summarizeGgufGroup);
  const models = summaries.filter((item) => item.role === "model").sort((a, b) => b.fileBytes - a.fileBytes);
  const mmproj = summaries.filter((item) => item.role === "mmproj").sort((a, b) => b.fileBytes - a.fileBytes);
  const drafts = summaries.filter((item) => item.role === "draft").sort((a, b) => b.fileBytes - a.fileBytes);
  return {
    files: inspected,
    models,
    mmproj,
    drafts,
    selectedModel: models.find((item) => item.complete) || models[0] || null,
    totalFileBytes: inspected.reduce((sum, file) => sum + Number(file.fileBytes || file.size || 0), 0),
  };
}

function selectGgufModel(inventory, requestedFile = "") {
  const requested = requestedFile ? path.resolve(String(requestedFile)) : "";
  if (requested) {
    const exact = inventory.models.find((model) => model.files.some((file) => path.resolve(file.path) === requested));
    if (exact) return exact;
  }
  return inventory.selectedModel || inventory.models[0] || null;
}

function ggufKvBytesPerElement(value) {
  const normalized = String(value || "f16").trim().toLowerCase();
  const bytes = {
    f32: 4,
    f16: 2,
    bf16: 2,
    q8_0: 34 / 32,
    q4_0: 18 / 32,
    q4_1: 20 / 32,
    iq4_nl: 18 / 32,
    q5_0: 22 / 32,
    q5_1: 24 / 32,
  }[normalized];
  return bytes || 2;
}

function estimateGgufKvBytes(model = {}, options = {}) {
  const layers = Math.max(0, Number(model.kvLayers || model.layers || 0));
  const kvHeads = Math.max(0, Number(model.kvHeads || 0));
  const keyLength = Math.max(0, Number(model.keyLength || model.headDim || 0));
  const valueLength = Math.max(0, Number(model.valueLength || model.headDim || keyLength || 0));
  const contextTokens = Math.max(1, Number(options.contextTokens || options.maxModelLen || 8192));
  const parallelSlots = Math.max(1, Number(options.parallelSlots || options.maxNumSeqs || 1));
  if (!layers || !kvHeads || !keyLength || !valueLength) return null;
  const pattern = Array.isArray(model.slidingWindowPattern) ? model.slidingWindowPattern : null;
  const slidingLayers = pattern
    ? Math.min(layers, pattern.filter(Boolean).length)
    : model.slidingWindow ? Math.max(0, Number(model.slidingLayers ?? layers)) : 0;
  const globalLayers = Math.max(0, layers - slidingLayers);
  const slidingTokens = model.slidingWindow
    ? Math.min(contextTokens, Math.max(1, Number(model.slidingWindow)))
    : contextTokens;
  const keyBytes = ggufKvBytesPerElement(options.cacheTypeK || options.kvCacheDtype);
  const valueBytes = ggufKvBytesPerElement(options.cacheTypeV || options.kvCacheDtype);
  const elementsPerLayer = kvHeads * ((keyLength * keyBytes) + (valueLength * valueBytes));
  return Math.ceil(elementsPerLayer * parallelSlots * ((globalLayers * contextTokens) + (slidingLayers * slidingTokens)));
}

function gpuLayerFraction(gpuLayers, totalLayers) {
  const layers = Math.max(0, Number(totalLayers || 0));
  if (!layers) return 1;
  const value = String(gpuLayers ?? "all").trim().toLowerCase();
  if (["all", "auto", "-1", "999"].includes(value)) return 1;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 1;
  if (requested <= 0) return 0;
  return Math.min(1, Math.floor(requested) / layers);
}

module.exports = {
  GGUF_FILE_TYPE_NAMES,
  GGUF_TYPES,
  GgufNeedMoreBytes,
  buildGgufInventory,
  classifyGgufRole,
  estimateGgufKvBytes,
  ggufKvBytesPerElement,
  gpuLayerFraction,
  inspectGgufFileSync,
  normalizeGgufMetadata,
  parseGgufHeaderBuffer,
  readGgufHeaderSync,
  readGgufMetadataSync,
  selectGgufModel,
  summarizeGgufGroup,
};
