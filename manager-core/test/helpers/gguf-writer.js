"use strict";

// GGUF writer for tests (docs/overhaul/02-models.md §21.1). fakeGguf is the
// small builder gguf-metadata.test.js has always used; buildGguf writes real
// v3 headers with typed KV entries, string arrays and typed tensors at aligned
// offsets, for the model-card fixtures. Tensor payloads are never written:
// fixture-materialize sizes the files afterwards.

const fs = require("node:fs");
const { GGML_TYPE_IDS, GGUF_VALUE_TYPES, ggmlTensorBytes } = require("../../../scripts/capture-model-fixture.js");

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

// Type inference for fakeGguf: strings, bools, unsigned/signed integers,
// floats, and arrays of one of those. { $type, value } forces a type.
function ggufValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.$type) {
    return [GGUF_VALUE_TYPES[value.$type], encodeTyped(value.$type, value.value, value.itemType)];
  }
  if (typeof value === "string") return [8, ggufString(value)];
  if (typeof value === "boolean") return [7, Buffer.from([value ? 1 : 0])];
  if (Number.isInteger(value) && value >= 0) return [4, u32(value)];
  if (Number.isInteger(value)) return [5, i32(value)];
  if (typeof value === "number") return [6, f32(value)];
  if (Array.isArray(value)) {
    let elementType = 4;
    if (value.every((item) => typeof item === "boolean")) elementType = 7;
    else if (value.every((item) => typeof item === "string")) elementType = 8;
    else if (value.some((item) => typeof item === "number" && !Number.isInteger(item))) elementType = 6;
    else if (value.some((item) => Number.isInteger(item) && item < 0)) elementType = 5;
    const encoded = value.map((item) => {
      if (elementType === 7) return Buffer.from([item ? 1 : 0]);
      if (elementType === 8) return ggufString(item);
      if (elementType === 6) return f32(item);
      if (elementType === 5) return i32(item);
      return u32(item);
    });
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
      u32(typeof tensor.type === "string" ? ggmlTypeId(tensor.type) : tensor.type || 0),
      u64(tensor.offset || 0),
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

function ggmlTypeId(type) {
  if (Number.isInteger(type)) return type;
  const id = GGML_TYPE_IDS[String(type).toUpperCase()];
  if (id === undefined) throw new Error(`Unknown ggml type ${type}`);
  return id;
}

function encodeScalar(type, value) {
  const number = typeof value === "string" && /^-?(?:NaN|Infinity)$/.test(value) ? Number(value) : value;
  switch (type) {
    case "uint8": return Buffer.from([Number(number)]);
    case "int8": { const buffer = Buffer.alloc(1); buffer.writeInt8(Number(number)); return buffer; }
    case "uint16": { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(Number(number)); return buffer; }
    case "int16": { const buffer = Buffer.alloc(2); buffer.writeInt16LE(Number(number)); return buffer; }
    case "uint32": return u32(number);
    case "int32": return i32(number);
    case "float32": return f32(number);
    case "bool": return Buffer.from([number ? 1 : 0]);
    case "string": return ggufString(number);
    case "uint64": return u64(number);
    case "int64": { const buffer = Buffer.alloc(8); buffer.writeBigInt64LE(BigInt(number)); return buffer; }
    case "float64": { const buffer = Buffer.alloc(8); buffer.writeDoubleLE(Number(number)); return buffer; }
    default: throw new Error(`Unsupported GGUF value type ${type}`);
  }
}

// A fixture placeholder { $array, count, head } becomes head + filler: empty
// strings, zeros or false. Captured again, it yields the same placeholder.
// extraChars lengthens the first filler string (header size matching).
function arrayItems(itemType, value, extraChars = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.count)) throw new Error("GGUF array value must be a list or { $array, count, head }.");
  const head = Array.isArray(value.head) ? value.head : [];
  const filler = itemType === "string" ? "" : itemType === "bool" ? false : 0;
  return Array.from({ length: value.count }, (_, index) => {
    if (index < head.length) return head[index];
    return index === head.length && extraChars ? "x".repeat(extraChars) : filler;
  });
}

function encodeTyped(type, value, itemType, extraChars = 0) {
  if (type === "string" && value && typeof value === "object") {
    // { $string: n }: a string longer than the capture limit, kept by length.
    return ggufString("x".repeat(Number(value.$string) || 0));
  }
  if (type !== "array") return encodeScalar(type, value);
  if (GGUF_VALUE_TYPES[itemType] === undefined || itemType === "array") throw new Error(`Unsupported GGUF array item type ${itemType}`);
  const items = arrayItems(itemType, value, extraChars);
  return Buffer.concat([u32(GGUF_VALUE_TYPES[itemType]), u64(items.length), ...items.map((item) => encodeScalar(itemType, item))]);
}

// The first string-array placeholder with filler room absorbs the bytes a
// captured header had in its (dropped) vocabulary, so headerBytes matches.
function fillerEntryIndex(kv) {
  return kv.findIndex((entry) => entry.type === "array" && entry.itemType === "string"
    && entry.value && !Array.isArray(entry.value) && entry.value.count > (entry.value.head || []).length);
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

/**
 * Builds a GGUF header. kv: [{key, type, itemType?, value}] in file order
 * (gguf-header.json entries). tensors: [{name, dims, type (name or id),
 * bytes?}], laid out in order at aligned offsets. headerBytes (the data
 * offset of a captured file) is matched through filler strings when the KV
 * holds a string-array placeholder; otherwise the natural size is used.
 * Returns { header, dataOffset, dataBytes, totalBytes, exactHeader, tensors }.
 */
function buildGguf({ version = 3, kv = [], tensors = [], alignment, headerBytes } = {}) {
  const alignmentEntry = kv.find((entry) => entry.key === "general.alignment");
  const align = Number(alignmentEntry?.value) || Number(alignment) || 32;
  const encodeKv = (fillerIndex = -1, extraChars = 0) => kv.flatMap((entry, index) => [
    ggufString(entry.key),
    u32(GGUF_VALUE_TYPES[entry.type]),
    encodeTyped(entry.type, entry.value, entry.itemType, index === fillerIndex ? extraChars : 0),
  ]);
  let offset = 0;
  const laidOut = tensors.map((tensor) => {
    const typeId = ggmlTypeId(tensor.typeId ?? tensor.type);
    const bytes = tensor.bytes ?? ggmlTensorBytes(typeId, tensor.dims);
    if (!Number.isSafeInteger(bytes)) throw new Error(`Tensor ${tensor.name} needs bytes (type ${typeId} has no size).`);
    offset = alignUp(offset, align);
    const placed = { name: tensor.name, dims: tensor.dims, typeId, offset, bytes };
    offset += bytes;
    return placed;
  });
  const infoBuffers = laidOut.flatMap((tensor) => [
    ggufString(tensor.name),
    u32(tensor.dims.length),
    ...tensor.dims.map(u64),
    u32(tensor.typeId),
    u64(tensor.offset),
  ]);
  const assemble = (kvBuffers) => Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(version),
    u64(laidOut.length),
    u64(kv.length),
    ...kvBuffers,
    ...infoBuffers,
  ]);
  let body = assemble(encodeKv());
  const requested = Number(headerBytes) || 0;
  const fillerIndex = fillerEntryIndex(kv);
  if (requested > alignUp(body.length, align) && fillerIndex >= 0 && requested % align === 0) {
    body = assemble(encodeKv(fillerIndex, requested - body.length));
  }
  const dataOffset = alignUp(body.length, align);
  const header = Buffer.concat([body, Buffer.alloc(dataOffset - body.length)]);
  return {
    header,
    dataOffset,
    dataBytes: offset,
    totalBytes: dataOffset + offset,
    exactHeader: !requested || dataOffset === requested,
    tensors: laidOut,
  };
}

/** Writes the header only; the caller sizes the file. */
function writeGgufFile(file, spec) {
  const built = buildGguf(spec);
  fs.writeFileSync(file, built.header);
  return built;
}

module.exports = {
  buildGguf,
  f32,
  fakeGguf,
  ggmlTypeId,
  ggufString,
  ggufValue,
  i32,
  u32,
  u64,
  writeGgufFile,
};
