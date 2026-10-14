"use strict";

// safetensors writer for tests (docs/overhaul/02-models.md §21.1): a real
// header (8-byte little-endian length + JSON, space padded) with data offsets
// for every tensor. Payloads are never written; fixture-materialize sizes the
// file afterwards, so readers see the true file length.

const fs = require("node:fs");

const DTYPE_BYTES = Object.freeze({
  BOOL: 1, U8: 1, I8: 1, F8_E5M2: 1, F8_E4M3: 1, F8_E8M0: 1,
  U16: 2, I16: 2, F16: 2, BF16: 2,
  U32: 4, I32: 4, F32: 4,
  U64: 8, I64: 8, F64: 8,
});

function tensorBytes(dtype, shape) {
  const width = DTYPE_BYTES[String(dtype)];
  if (!width) return null;
  return shape.reduce((product, dim) => product * Number(dim), width);
}

function compareNames(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * tensors: [{name, dtype, shape, bytes?}]. They are laid out sorted by name,
 * so the same set always gives the same header. headerBytes pads the JSON with
 * spaces to that length when it fits (a captured file's exact header size);
 * otherwise the JSON is padded to a multiple of 8, like the Rust writer.
 * Returns { header, headerBytes, payloadBytes, totalBytes, exactHeader }.
 */
function buildSafetensorsHeader(tensors, { metadata = null, headerBytes } = {}) {
  const sorted = [...tensors].sort((left, right) => compareNames(left.name, right.name));
  const entries = {};
  if (metadata) entries.__metadata__ = metadata;
  let offset = 0;
  for (const tensor of sorted) {
    const bytes = tensor.bytes ?? tensorBytes(tensor.dtype, tensor.shape);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Tensor ${tensor.name} needs bytes (dtype ${tensor.dtype}).`);
    if (Object.hasOwn(entries, tensor.name)) throw new Error(`Duplicate tensor ${tensor.name}.`);
    entries[tensor.name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [offset, offset + bytes] };
    offset += bytes;
  }
  const json = Buffer.from(JSON.stringify(entries), "utf8");
  const requested = Number(headerBytes) || 0;
  const length = requested >= json.length ? requested : Math.ceil(json.length / 8) * 8;
  const header = Buffer.alloc(8 + length, 0x20);
  header.writeBigUInt64LE(BigInt(length), 0);
  json.copy(header, 8);
  return {
    header,
    headerBytes: length,
    payloadBytes: offset,
    totalBytes: 8 + length + offset,
    exactHeader: !requested || length === requested,
  };
}

/** Writes the header only; the caller sizes the file. */
function writeSafetensorsFile(file, tensors, options = {}) {
  const built = buildSafetensorsHeader(tensors, options);
  fs.writeFileSync(file, built.header);
  return built;
}

module.exports = {
  DTYPE_BYTES,
  buildSafetensorsHeader,
  tensorBytes,
  writeSafetensorsFile,
};
