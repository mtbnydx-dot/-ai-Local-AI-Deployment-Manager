"use strict";

// ggml tensor types (docs/overhaul/02-models.md §5.1): the id written in a
// GGUF tensor info, the elements per quantization block and the bytes per
// block, as ggml's type traits define them. A tensor's size is its row length
// in blocks times the block bytes times the remaining dimensions. An id that
// is not in this table has no size: callers report it as inexact instead of
// guessing.
//
// Ids 4 and 5 (Q4_2/Q4_3) predate GGUF and are absent. The repacked Q4_0 and
// IQ4_NL variants (31-33, 36-38) are no longer written or loaded by llama.cpp,
// but GGUF files with Q4_0_4_4/4_8/8_8 tensors exist; their blocks have the
// Q4_0/IQ4_NL size, so they are kept with `removed: true`.

const QK_K = 256;

// [id, name, elements per block, bytes per block, removed]
const GGML_TYPE_TABLE = [
  [0, "F32", 1, 4],
  [1, "F16", 1, 2],
  [2, "Q4_0", 32, 2 + 16],
  [3, "Q4_1", 32, 2 + 2 + 16],
  [6, "Q5_0", 32, 2 + 4 + 16],
  [7, "Q5_1", 32, 2 + 2 + 4 + 16],
  [8, "Q8_0", 32, 2 + 32],
  [9, "Q8_1", 32, 4 + 32],
  [10, "Q2_K", QK_K, 2 + 2 + QK_K / 16 + QK_K / 4],
  [11, "Q3_K", QK_K, 2 + QK_K / 4 + QK_K / 8 + 12],
  [12, "Q4_K", QK_K, 2 + 2 + QK_K / 2 + 12],
  [13, "Q5_K", QK_K, 2 + 2 + QK_K / 2 + QK_K / 8 + 12],
  [14, "Q6_K", QK_K, 2 + QK_K / 2 + QK_K / 4 + QK_K / 16],
  [15, "Q8_K", QK_K, 4 + QK_K + QK_K / 8],
  [16, "IQ2_XXS", QK_K, 2 + QK_K / 4],
  [17, "IQ2_XS", QK_K, 2 + QK_K / 4 + QK_K / 32],
  [18, "IQ3_XXS", QK_K, 2 + QK_K / 4 + QK_K / 8],
  [19, "IQ1_S", QK_K, 2 + QK_K / 8 + QK_K / 16],
  [20, "IQ4_NL", 32, 2 + 16],
  [21, "IQ3_S", QK_K, 2 + QK_K / 4 + QK_K / 8 + QK_K / 32 + 4],
  [22, "IQ2_S", QK_K, 2 + QK_K / 4 + QK_K / 16],
  [23, "IQ4_XS", QK_K, 2 + 2 + QK_K / 2 + QK_K / 64],
  [24, "I8", 1, 1],
  [25, "I16", 1, 2],
  [26, "I32", 1, 4],
  [27, "I64", 1, 8],
  [28, "F64", 1, 8],
  [29, "IQ1_M", QK_K, QK_K / 8 + QK_K / 16 + QK_K / 32],
  [30, "BF16", 1, 2],
  [31, "Q4_0_4_4", 32, 2 + 16, true],
  [32, "Q4_0_4_8", 32, 2 + 16, true],
  [33, "Q4_0_8_8", 32, 2 + 16, true],
  [34, "TQ1_0", QK_K, 2 + 4 * 13],
  [35, "TQ2_0", QK_K, 2 + 64],
  [36, "IQ4_NL_4_4", 32, 2 + 16, true],
  [37, "IQ4_NL_4_8", 32, 2 + 16, true],
  [38, "IQ4_NL_8_8", 32, 2 + 16, true],
  [39, "MXFP4", 32, 1 + 16],
];

const GGML_TYPES = Object.freeze(Object.fromEntries(GGML_TYPE_TABLE.map(([id, name, blockElems, blockBytes, removed]) => [
  id,
  Object.freeze(removed ? { name, blockElems, blockBytes, removed: true } : { name, blockElems, blockBytes }),
])));

const GGML_TYPE_IDS = Object.freeze(Object.fromEntries(GGML_TYPE_TABLE.map(([id, name]) => [name, id])));

/** The table entry for a type id or name (case-insensitive), or null. */
function ggmlTypeInfo(type) {
  if (typeof type === "string") {
    const id = GGML_TYPE_IDS[type.trim().toUpperCase()];
    return id === undefined ? null : GGML_TYPES[id];
  }
  return Number.isInteger(type) && Object.hasOwn(GGML_TYPES, type) ? GGML_TYPES[type] : null;
}

/**
 * Exact bytes of a tensor with `dims` (ggml order: dims[0] is the row length)
 * stored as `type` (id or name). Null when the type is unknown, a dimension is
 * not a non-negative safe integer, the row length is not a whole number of
 * blocks, or the size is beyond Number.MAX_SAFE_INTEGER.
 */
function ggmlTensorBytes(type, dims) {
  const info = ggmlTypeInfo(type);
  if (!info || !Array.isArray(dims)) return null;
  let elements = 1;
  for (const dim of dims) {
    const value = Number(dim);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    elements *= value;
  }
  if (!Number.isSafeInteger(elements)) return null;
  const rowLength = dims.length ? Number(dims[0]) : 1;
  if (rowLength % info.blockElems !== 0) return null;
  const bytes = (elements / info.blockElems) * info.blockBytes;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

module.exports = {
  GGML_TYPES,
  GGML_TYPE_IDS,
  ggmlTensorBytes,
  ggmlTypeInfo,
};
