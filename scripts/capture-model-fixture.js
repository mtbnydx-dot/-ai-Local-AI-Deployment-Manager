"use strict";

// Captures a model folder as a test fixture (docs/overhaul/02-models.md §21.1).
//
//   node scripts/capture-model-fixture.js --from <dir> --id <id> [--gguf <file>]...
//
// The source folder is only read. Small metadata files are copied with
// absolute paths reduced to their last segment; safetensors and GGUF headers
// become pattern-compressed tables (tensor-table.json, gguf-header.json); every
// other file is listed by name and size in manifest.json. Weights, tokenizer
// vocabularies and READMEs are never copied. expected-card.json is the golden
// of the card tests (written by them, not here) and survives --force.
//
// Flags and exit codes are a contract:
//   --from <dir>      model folder (read-only)
//   --id <id>         fixture id: lowercase letters, digits and dashes
//   --gguf <file>     GGUF file to capture, relative to --from (repeatable; default: all)
//   --license <id>    license id (as on Hugging Face) when the folder declares none
//   --allow-license   accept a license outside the permissive list
//   --synthetic       the folder was built for tests (manifest synthetic:true)
//   --note <text>     manifest note (repeatable)
//   --out <dir>       fixtures root (default: manager-core/test/fixtures/model-cards)
//   --force           replace an existing fixture
//   --dry-run         list what would be written; nothing changes
//   exit 0 written (or dry run), 2 refused (license or privacy), 1 error
//
// Output names are fixture-relative; source paths are never printed or stored.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOOL = "scripts/capture-model-fixture.js";
const TOOL_VERSION = 1;
const DEFAULT_OUT = path.join(__dirname, "..", "manager-core", "test", "fixtures", "model-cards");
const PRESERVED_ON_FORCE = new Set(["expected-card.json"]);

const USAGE = [
  "Usage: node scripts/capture-model-fixture.js --from <dir> --id <id> [--gguf <file>]... [--license <id>]",
  "         [--allow-license] [--synthetic] [--note <text>]... [--out <dir>] [--force] [--dry-run]",
  "  Reads <dir> only; writes <out>/<id>/. Never copies weights, tokenizer vocabularies or READMEs.",
].join("\n");

// Bounds shared with the inspector (02 §4.1, §5).
const MAX_DEPTH = 2;
const MAX_ENTRIES = 20000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_SAFETENSORS_HEADER = 256 * 1024 * 1024;
const MAX_METADATA_CHARS = 4096;
const MAX_README_BYTES = 64 * 1024;
const GGUF_ARRAY_LIMIT = 4096;
const GGUF_ARRAY_HEAD = 8;
const GGUF_MAX_STRING = 1024 * 1024;

// The only files copied into a fixture. Everything else is listed by size.
const CAPTURED_ROOT_FILES = new Set([
  "config.json",
  "generation_config.json",
  "tokenizer_config.json",
  "chat_template.jinja",
  "hf_quant_config.json",
  "preprocessor_config.json",
  "adapter_config.json",
  "modules.json",
  // sentence-transformers metadata, read by role detection (02 §7)
  "config_sentence_transformers.json",
  "sentence_bert_config.json",
]);
const CAPTURED_NESTED = /^\d+_Pooling\/config\.json$/;

// Hugging Face license ids that need no --allow-license.
const PERMISSIVE_LICENSES = new Set([
  "0bsd",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "bsd-3-clause-clear",
  "bsl-1.0",
  "cc-by-3.0",
  "cc-by-4.0",
  "cc0-1.0",
  "isc",
  "mit",
  "unlicense",
  "zlib",
]);

// ggml tensor types: [id, name, elements per block, bytes per block]. The
// complete table for the inspector is model-inspector/ggml-types.js (MOD-2);
// this one covers the types llama.cpp writes and is used for capture only.
const GGML_TYPE_TABLE = [
  [0, "F32", 1, 4], [1, "F16", 1, 2], [2, "Q4_0", 32, 18], [3, "Q4_1", 32, 20],
  [6, "Q5_0", 32, 22], [7, "Q5_1", 32, 24], [8, "Q8_0", 32, 34], [9, "Q8_1", 32, 36],
  [10, "Q2_K", 256, 84], [11, "Q3_K", 256, 110], [12, "Q4_K", 256, 144], [13, "Q5_K", 256, 176],
  [14, "Q6_K", 256, 210], [15, "Q8_K", 256, 292], [16, "IQ2_XXS", 256, 66], [17, "IQ2_XS", 256, 74],
  [18, "IQ3_XXS", 256, 98], [19, "IQ1_S", 256, 50], [20, "IQ4_NL", 32, 18], [21, "IQ3_S", 256, 110],
  [22, "IQ2_S", 256, 82], [23, "IQ4_XS", 256, 136], [24, "I8", 1, 1], [25, "I16", 1, 2],
  [26, "I32", 1, 4], [27, "I64", 1, 8], [28, "F64", 1, 8], [29, "IQ1_M", 256, 56],
  [30, "BF16", 1, 2], [34, "TQ1_0", 256, 54], [35, "TQ2_0", 256, 66], [39, "MXFP4", 32, 17],
];
const GGML_TYPES = Object.freeze(Object.fromEntries(GGML_TYPE_TABLE.map(([id, name, blockElems, blockBytes]) => [
  id,
  Object.freeze({ name, blockElems, blockBytes }),
])));
const GGML_TYPE_IDS = Object.freeze(Object.fromEntries(GGML_TYPE_TABLE.map(([id, name]) => [name, id])));

const GGUF_VALUE_TYPES = Object.freeze({
  uint8: 0, int8: 1, uint16: 2, int16: 3, uint32: 4, int32: 5, float32: 6,
  bool: 7, string: 8, array: 9, uint64: 10, int64: 11, float64: 12,
});
const GGUF_VALUE_TYPE_NAMES = Object.freeze(Object.fromEntries(Object.entries(GGUF_VALUE_TYPES).map(([name, id]) => [id, name])));
const GGUF_FIXED_BYTES = Object.freeze({ 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 });

// Release privacy scan (build-github-release.ps1) plus the redactor's HF token
// shape. Fixtures must pass both the release scan and fixture-privacy.test.js.
const CREDENTIAL_PATTERNS = Object.freeze([
  Object.freeze({ id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i }),
  Object.freeze({ id: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/i }),
  Object.freeze({ id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i }),
  Object.freeze({ id: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i }),
  Object.freeze({ id: "sk-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/i }),
  Object.freeze({ id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i }),
  Object.freeze({ id: "hf-token", pattern: /\bhf_[A-Za-z0-9]{20,}/i }),
]);
const PRIVACY_PATTERNS = Object.freeze([
  Object.freeze({ id: "drive-path", pattern: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/ }),
  Object.freeze({ id: "users-path", pattern: /[\\/]Users[\\/]/i }),
  Object.freeze({ id: "home-path", pattern: /\/home\//i }),
  Object.freeze({ id: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ }),
  ...CREDENTIAL_PATTERNS,
]);

class UsageError extends Error {}

class CaptureError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const options = {
    from: "", id: "", gguf: [], license: "", allowLicense: false, synthetic: false,
    notes: [], out: "", force: false, dryRun: false, help: false,
  };
  const takeValue = (name, inline, index) => {
    if (inline !== undefined) return { value: inline, next: index };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value.`);
    return { value, next: index + 1 };
  };
  const valueFlags = { "--from": "from", "--id": "id", "--license": "license", "--out": "out" };
  const listFlags = { "--gguf": "gguf", "--note": "notes" };
  const boolFlags = { "--allow-license": "allowLicense", "--synthetic": "synthetic", "--force": "force", "--dry-run": "dryRun", "--help": "help", "-h": "help" };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    const [flag, inline] = raw.startsWith("--") && raw.includes("=")
      ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)]
      : [raw, undefined];
    if (boolFlags[flag] && inline === undefined) {
      options[boolFlags[flag]] = true;
    } else if (valueFlags[flag] || listFlags[flag]) {
      const taken = takeValue(flag, inline, index);
      if (valueFlags[flag]) options[valueFlags[flag]] = taken.value;
      else options[listFlags[flag]].push(taken.value);
      index = taken.next;
    } else {
      throw new UsageError(`Unknown option: ${flag}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Inventory and classification

function compareNames(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// readdir up to depth 2 with stat only, like the inspector's inventory. Dot
// entries (.cache, .git, .gitattributes) and links are skipped.
function walkInventory(root) {
  const files = [];
  const skipped = { links: 0, deep: 0 };
  const visit = (dir, rel, depth) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.links += 1;
      } else if (entry.isDirectory()) {
        if (depth + 1 < MAX_DEPTH) visit(abs, name, depth + 1);
        else skipped.deep += 1;
      } else if (entry.isFile()) {
        if (files.length >= MAX_ENTRIES) throw new CaptureError("too_many_entries", `The folder holds more than ${MAX_ENTRIES} files.`);
        files.push({ name, abs, bytes: fs.statSync(abs).size });
      }
    }
  };
  visit(root, "", 0);
  return { files, skipped };
}

function classifyFile(name, isSelectedGguf) {
  const lower = name.toLowerCase();
  if (CAPTURED_ROOT_FILES.has(name) || CAPTURED_NESTED.test(name)) return "captured";
  if (lower.endsWith(".safetensors")) return "safetensors";
  if (lower.endsWith(".safetensors.index.json")) return "index";
  if (lower.endsWith(".gguf")) return isSelectedGguf(name) ? "gguf" : "placeholder";
  return "placeholder";
}

function readFileBounded(abs, maxBytes, code) {
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) throw new CaptureError(code, `file is larger than ${maxBytes} bytes`);
  return fs.readFileSync(abs);
}

// ---------------------------------------------------------------------------
// Scrubbing: absolute paths are reduced to their last segment; tokenizer
// vocabularies are dropped. Every change is listed in manifest.scrubbed.

const WHOLE_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|*?]*$/;
const EMBEDDED_PATHS = [
  /(?<![A-Za-z0-9_])[A-Za-z]:[\\/](?:[^\s"'<>|*?]*[\\/])?([^\s"'<>|*?\\/]*)/g,
  /\\\\[^\s"'<>|*?\\/]+\\(?:[^\s"'<>|*?]*[\\/])?([^\s"'<>|*?\\/]*)/g,
  /\/(?:home|Users)\/[^\s"'<>|*?\/]+(?:\/[^\s"'<>|*?]*\/)?([^\s"'<>|*?\/]*)/g,
];

function lastPathSegment(value) {
  const parts = String(value).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function scrubString(value) {
  if (WHOLE_ABSOLUTE_PATH.test(value) && /[\\/].*[\\/]|^[A-Za-z]:/.test(value)) {
    return lastPathSegment(value);
  }
  let output = value;
  for (const pattern of EMBEDDED_PATHS) output = output.replace(pattern, (match, last) => last || "");
  return output;
}

function escapePointerToken(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function scrubJsonValue(value, pointer, changes) {
  if (typeof value === "string") {
    const next = scrubString(value);
    if (next !== value) changes.push(pointer || "/");
    return next;
  }
  if (Array.isArray(value)) return value.map((item, index) => scrubJsonValue(item, `${pointer}/${index}`, changes));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = scrubJsonValue(item, `${pointer}/${escapePointerToken(key)}`, changes);
    return output;
  }
  return value;
}

function scrubCapturedFile(name, buffer, scrubbed, warnings) {
  const text = buffer.toString("utf8");
  if (!name.endsWith(".json")) {
    const next = scrubString(text);
    if (next !== text) scrubbed.push({ file: name, pointer: null, reason: "absolute_path" });
    return next;
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    warnings.push({ code: "json_invalid", file: name });
    const next = scrubString(text);
    if (next !== text) scrubbed.push({ file: name, pointer: null, reason: "absolute_path" });
    return next;
  }
  if (name === "tokenizer_config.json" && parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Object.hasOwn(parsed, "added_tokens_decoder")) {
    const count = parsed.added_tokens_decoder && typeof parsed.added_tokens_decoder === "object"
      ? Object.keys(parsed.added_tokens_decoder).length
      : 0;
    delete parsed.added_tokens_decoder;
    scrubbed.push({ file: name, pointer: "/added_tokens_decoder", reason: "tokenizer_vocabulary", count });
  }
  const changes = [];
  const value = scrubJsonValue(parsed, "", changes);
  for (const pointer of changes) scrubbed.push({ file: name, pointer, reason: "absolute_path" });
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Tensor-name compression: numeric name segments become placeholders and a
// group's placeholder values are a cartesian product of ranges.

const LAYER_SEGMENTS = /^(?:layers?|blk|blocks?|h)$/i;
const EXPERT_SEGMENTS = /^experts?$/i;

function abstractTensorName(name) {
  if (/[{}]/.test(name)) return null;
  const segments = name.split(".");
  const keys = [];
  const values = [];
  const counts = {};
  const pattern = segments.map((segment, index) => {
    if (!/^(?:0|[1-9]\d{0,8})$/.test(segment)) return segment;
    const previous = segments[index - 1] || "";
    const letter = LAYER_SEGMENTS.test(previous) ? "L" : EXPERT_SEGMENTS.test(previous) ? "E" : "N";
    counts[letter] = (counts[letter] || 0) + 1;
    const key = counts[letter] === 1 ? letter : `${letter}${counts[letter]}`;
    keys.push(key);
    values.push(Number(segment));
    return `{${key}}`;
  }).join(".");
  return { pattern, keys, values };
}

// A range is [first, last] (step 1), {from, to, step} or {values:[...]}.
function rangeSpec(values) {
  if (values.length === 1) return [values[0], values[0]];
  const step = values[1] - values[0];
  const arithmetic = values.every((value, index) => index === 0 || value - values[index - 1] === step);
  if (arithmetic && step === 1) return [values[0], values[values.length - 1]];
  if (arithmetic && values.length > 2) return { from: values[0], to: values[values.length - 1], step };
  return { values: [...values] };
}

function expandRangeSpec(spec) {
  if (Array.isArray(spec)) {
    const [first, last] = spec.map(Number);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw new Error(`Invalid range ${JSON.stringify(spec)}.`);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }
  if (spec && Array.isArray(spec.values)) return spec.values.map(Number);
  if (spec && Number.isSafeInteger(spec.from) && Number.isSafeInteger(spec.to) && Number.isSafeInteger(spec.step) && spec.step > 0) {
    const output = [];
    for (let value = spec.from; value <= spec.to; value += spec.step) output.push(value);
    return output;
  }
  throw new Error(`Invalid range ${JSON.stringify(spec)}.`);
}

// Splits a set of unique tuples into cartesian products of per-dimension
// value sets. Exact for any input; compact for the regular layouts models use.
function decompose(tuples, dims) {
  if (dims === 0) return [[]];
  const uniques = [];
  for (let dim = 0; dim < dims; dim += 1) {
    uniques.push(Array.from(new Set(tuples.map((tuple) => tuple[dim]))).sort((a, b) => a - b));
  }
  const product = uniques.reduce((count, values) => count * values.length, 1);
  if (product === tuples.length) return [uniques.map(rangeSpec)];
  const byFirst = new Map();
  for (const tuple of tuples) {
    const rest = byFirst.get(tuple[0]) || [];
    rest.push(tuple.slice(1));
    byFirst.set(tuple[0], rest);
  }
  const byShape = new Map();
  for (const [value, rest] of byFirst) {
    const sub = decompose(rest, dims - 1);
    const key = JSON.stringify(sub);
    const entry = byShape.get(key) || { sub, values: [] };
    entry.values.push(value);
    byShape.set(key, entry);
  }
  const output = [];
  for (const { sub, values } of byShape.values()) {
    values.sort((a, b) => a - b);
    for (const specs of sub) output.push([rangeSpec(values), ...specs]);
  }
  return output;
}

// describe(tensor) returns the fields shared by a group, in output order.
function compressTensors(tensors, describe) {
  const groups = new Map();
  const literal = [];
  for (const tensor of tensors) {
    const fields = describe(tensor);
    const abstracted = abstractTensorName(tensor.name);
    if (!abstracted) {
      literal.push({ name: tensor.name, ...fields });
      continue;
    }
    const key = JSON.stringify([abstracted.pattern, abstracted.keys, fields]);
    let group = groups.get(key);
    if (!group) {
      group = { pattern: abstracted.pattern, keys: abstracted.keys, fields, tuples: [] };
      groups.set(key, group);
    }
    group.tuples.push(abstracted.values);
  }
  const output = [];
  for (const group of groups.values()) {
    for (const specs of decompose(group.tuples, group.keys.length)) {
      const entry = { pattern: group.pattern };
      if (group.keys.length) entry.ranges = Object.fromEntries(group.keys.map((key, index) => [key, specs[index]]));
      output.push(Object.assign(entry, group.fields));
    }
  }
  output.push(...literal);
  return output;
}

function groupSortKey(group) {
  return `${group.pattern ?? group.name}\u0000${JSON.stringify(group.ranges || {})}`;
}

function sortGroups(groups, fileOrder) {
  return groups.sort((left, right) => {
    if (fileOrder) {
      const byFile = (fileOrder.get(left.file) ?? 0) - (fileOrder.get(right.file) ?? 0);
      if (byFile) return byFile;
    }
    return compareNames(groupSortKey(left), groupSortKey(right));
  });
}

function expandGroupNames(group) {
  if (group.name !== undefined) return [group.name];
  const keys = Object.keys(group.ranges || {});
  let names = [group.pattern];
  for (const key of keys) {
    const values = expandRangeSpec(group.ranges[key]);
    const token = `{${key}}`;
    const next = [];
    for (const name of names) for (const value of values) next.push(name.split(token).join(String(value)));
    names = next;
  }
  return names;
}

// ---------------------------------------------------------------------------
// safetensors

function readExact(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!read) throw new CaptureError("read_failed", `unexpected end of file at byte ${position + offset}`);
    offset += read;
  }
}

function readSafetensorsHeader(abs, fileBytes) {
  if (fileBytes < 8) throw new CaptureError("safetensors_header_invalid", "file is shorter than the header length field");
  const fd = fs.openSync(abs, "r");
  try {
    const lengthBuffer = Buffer.alloc(8);
    readExact(fd, lengthBuffer, 0);
    const length = lengthBuffer.readBigUInt64LE(0);
    if (length > BigInt(MAX_SAFETENSORS_HEADER) || Number(length) + 8 > fileBytes) {
      throw new CaptureError("safetensors_header_invalid", "header length is outside the file");
    }
    const headerBytes = Number(length);
    const buffer = Buffer.alloc(headerBytes);
    readExact(fd, buffer, 8);
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new CaptureError("safetensors_header_invalid", "header is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CaptureError("safetensors_header_invalid", "header is not an object");
    const tensors = [];
    let payloadEnd = 0;
    for (const [name, info] of Object.entries(parsed)) {
      if (name === "__metadata__") continue;
      const offsets = info?.data_offsets;
      const valid = info && typeof info.dtype === "string" && Array.isArray(info.shape)
        && info.shape.every((dim) => Number.isSafeInteger(dim) && dim >= 0)
        && Array.isArray(offsets) && offsets.length === 2
        && offsets.every((value) => Number.isSafeInteger(value) && value >= 0) && offsets[1] >= offsets[0];
      if (!valid) throw new CaptureError("safetensors_header_invalid", `tensor entry ${JSON.stringify(name)} is malformed`);
      tensors.push({ name, dtype: info.dtype, shape: info.shape.map(Number), bytes: offsets[1] - offsets[0], begin: offsets[0] });
      payloadEnd = Math.max(payloadEnd, offsets[1]);
    }
    tensors.sort((left, right) => left.begin - right.begin || compareNames(left.name, right.name));
    const metadata = parsed.__metadata__ && typeof parsed.__metadata__ === "object" && !Array.isArray(parsed.__metadata__)
      ? parsed.__metadata__
      : null;
    return { headerBytes, metadata, tensors, payloadBytes: payloadEnd, truncated: fileBytes < 8 + headerBytes + payloadEnd };
  } finally {
    fs.closeSync(fd);
  }
}

function captureSafetensors(entries, indexEntry, warnings, scrubbed) {
  const files = [];
  const tensors = [];
  for (const entry of entries) {
    let header;
    try {
      header = readSafetensorsHeader(entry.abs, entry.bytes);
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error;
      warnings.push({ code: "safetensors_header_invalid", file: entry.name, detail: error.message });
      entry.kind = "placeholder";
      continue;
    }
    const record = { name: entry.name, bytes: entry.bytes, headerBytes: header.headerBytes, tensors: header.tensors.length };
    if (header.metadata) {
      const changes = [];
      const metadata = scrubJsonValue(header.metadata, "", changes);
      if (JSON.stringify(metadata).length > MAX_METADATA_CHARS) {
        warnings.push({ code: "safetensors_metadata_dropped", file: entry.name });
      } else {
        record.metadata = metadata;
        for (const pointer of changes) scrubbed.push({ file: entry.name, pointer: `/__metadata__${pointer}`, reason: "absolute_path" });
      }
    }
    if (header.truncated) warnings.push({ code: "safetensors_payload_short", file: entry.name });
    files.push(record);
    for (const tensor of header.tensors) tensors.push({ ...tensor, file: entry.name });
  }
  if (!files.length) return null;

  let index = null;
  if (indexEntry) {
    try {
      const parsed = JSON.parse(readFileBounded(indexEntry.abs, MAX_INDEX_BYTES, "index_too_large").toString("utf8").replace(/^\uFEFF/, ""));
      const changes = [];
      const metadata = parsed?.metadata && typeof parsed.metadata === "object" ? scrubJsonValue(parsed.metadata, "", changes) : null;
      for (const pointer of changes) scrubbed.push({ file: indexEntry.name, pointer: `/metadata${pointer}`, reason: "absolute_path" });
      index = { name: indexEntry.name, metadata: metadata && JSON.stringify(metadata).length <= MAX_METADATA_CHARS ? metadata : null };
      const weightMap = parsed?.weight_map && typeof parsed.weight_map === "object" ? parsed.weight_map : {};
      const listed = new Set(Object.keys(weightMap));
      const present = new Set(tensors.map((tensor) => tensor.name));
      const missingFiles = Array.from(new Set(Object.values(weightMap).map(String)))
        .filter((file) => !files.some((record) => record.name === file || record.name.endsWith(`/${file}`)))
        .sort(compareNames);
      const unlisted = tensors.filter((tensor) => !listed.has(tensor.name)).length;
      const absent = Array.from(listed).filter((name) => !present.has(name)).length;
      if (missingFiles.length) warnings.push({ code: "index_files_missing", file: indexEntry.name, detail: missingFiles.map(lastPathSegment).join(", ") });
      if (unlisted) warnings.push({ code: "index_omits_tensors", file: indexEntry.name, detail: `${unlisted}` });
      if (absent) warnings.push({ code: "index_lists_absent_tensors", file: indexEntry.name, detail: `${absent}` });
    } catch (error) {
      if (!(error instanceof CaptureError) && !(error instanceof SyntaxError)) throw error;
      warnings.push({ code: "index_invalid", file: indexEntry.name });
      indexEntry.kind = "placeholder";
    }
  }

  const fileOrder = new Map(files.map((record, position) => [record.name, position]));
  const groups = sortGroups(compressTensors(tensors, (tensor) => ({
    dtype: tensor.dtype,
    shape: tensor.shape,
    bytesEach: tensor.bytes,
    file: tensor.file,
  })), fileOrder);
  return { format: "safetensors", index, files, groups };
}

// ---------------------------------------------------------------------------
// GGUF

class GgufReader {
  constructor(fd, fileBytes) {
    this.fd = fd;
    this.fileBytes = fileBytes;
    this.offset = 0;
    this.buffer = Buffer.alloc(1024 * 1024);
    this.start = 0;
    this.length = 0;
  }

  take(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > this.fileBytes) {
      throw new CaptureError("gguf_header_invalid", `GGUF header runs past the end of the file at byte ${this.offset}`);
    }
    if (bytes > this.buffer.length) {
      const output = Buffer.alloc(bytes);
      readExact(this.fd, output, this.offset);
      this.offset += bytes;
      return output;
    }
    if (this.offset < this.start || this.offset + bytes > this.start + this.length) {
      this.start = this.offset;
      this.length = fs.readSync(this.fd, this.buffer, 0, this.buffer.length, this.start);
      if (this.length < bytes) throw new CaptureError("gguf_header_invalid", `unexpected end of file at byte ${this.offset}`);
    }
    const output = this.buffer.subarray(this.offset - this.start, this.offset - this.start + bytes);
    this.offset += bytes;
    return output;
  }

  skip(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset + bytes > this.fileBytes) {
      throw new CaptureError("gguf_header_invalid", `GGUF header runs past the end of the file at byte ${this.offset}`);
    }
    this.offset += bytes;
  }

  u32() { return this.take(4).readUInt32LE(0); }

  count() {
    const value = this.take(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CaptureError("gguf_header_invalid", "GGUF count is out of range");
    return Number(value);
  }

  // Keys and tensor names; bounded so a corrupt length cannot allocate GBs.
  name(what) {
    const length = this.count();
    if (!length || length > 65536) throw new CaptureError("gguf_header_invalid", `${what} is empty or longer than 64 KiB`);
    return this.take(length).toString("utf8");
  }

  scalar(type) {
    switch (type) {
      case 0: return this.take(1).readUInt8(0);
      case 1: return this.take(1).readInt8(0);
      case 2: return this.take(2).readUInt16LE(0);
      case 3: return this.take(2).readInt16LE(0);
      case 4: return this.take(4).readUInt32LE(0);
      case 5: return this.take(4).readInt32LE(0);
      case 6: return jsonFloat(this.take(4).readFloatLE(0));
      case 7: return this.take(1).readUInt8(0) !== 0;
      case 10: return jsonInteger(this.take(8).readBigUInt64LE(0));
      case 11: return jsonInteger(this.take(8).readBigInt64LE(0));
      case 12: return jsonFloat(this.take(8).readDoubleLE(0));
      default: throw new CaptureError("gguf_header_invalid", `unsupported GGUF value type ${type}`);
    }
  }
}

function jsonInteger(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
}

function jsonFloat(value) {
  return Number.isFinite(value) ? value : String(value);
}

function isTokenizerArray(key) {
  return /^tokenizer\.ggml\./.test(key);
}

// One KV entry as {key, type, value} or, for arrays, {key, type:"array",
// itemType, value}. Tokenizer arrays and arrays over the limit keep their
// count and a short head (no head for tokenizer strings: no vocabulary).
function readGgufKv(reader, key, type) {
  if (type === GGUF_VALUE_TYPES.string) {
    const length = reader.count();
    if (length > GGUF_MAX_STRING) {
      reader.skip(length);
      return { key, type: "string", value: { $string: length } };
    }
    return { key, type: "string", value: reader.take(length).toString("utf8") };
  }
  if (type !== GGUF_VALUE_TYPES.array) {
    const name = GGUF_VALUE_TYPE_NAMES[type];
    if (!name) throw new CaptureError("gguf_header_invalid", `unsupported GGUF value type ${type}`);
    return { key, type: name, value: reader.scalar(type) };
  }
  const itemType = reader.u32();
  const itemName = GGUF_VALUE_TYPE_NAMES[itemType];
  if (!itemName || itemType === GGUF_VALUE_TYPES.array) throw new CaptureError("gguf_header_invalid", `unsupported GGUF array item type ${itemType}`);
  const count = reader.count();
  const placeholder = isTokenizerArray(key) || count > GGUF_ARRAY_LIMIT;
  const keepHead = !placeholder ? count : itemType === GGUF_VALUE_TYPES.string && isTokenizerArray(key) ? 0 : Math.min(GGUF_ARRAY_HEAD, count);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    if (itemType === GGUF_VALUE_TYPES.string) {
      const length = reader.count();
      if (index < keepHead && length <= GGUF_MAX_STRING) values.push(reader.take(length).toString("utf8"));
      else reader.skip(length);
    } else if (index < keepHead) {
      values.push(reader.scalar(itemType));
    } else {
      reader.skip(GGUF_FIXED_BYTES[itemType] * (count - index));
      break;
    }
  }
  return {
    key,
    type: "array",
    itemType: itemName,
    value: placeholder ? { $array: itemName, count, head: values } : values,
  };
}

function ggmlTensorBytes(typeId, dims) {
  const type = GGML_TYPES[typeId];
  if (!type || !Array.isArray(dims)) return null;
  const elements = dims.reduce((product, dim) => product * Number(dim), 1);
  if (!Number.isSafeInteger(elements) || (dims.length && Number(dims[0]) % type.blockElems !== 0)) return null;
  return (elements / type.blockElems) * type.blockBytes;
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function readGgufHeader(abs, fileBytes) {
  const fd = fs.openSync(abs, "r");
  try {
    const reader = new GgufReader(fd, fileBytes);
    const magic = reader.take(4).toString("latin1");
    if (magic !== "GGUF") throw new CaptureError("gguf_header_invalid", "not a little-endian GGUF file");
    const version = reader.u32();
    if (version !== 2 && version !== 3) throw new CaptureError("gguf_header_invalid", `unsupported GGUF version ${version}`);
    const tensorCount = reader.count();
    const kvCount = reader.count();
    const kv = [];
    for (let index = 0; index < kvCount; index += 1) {
      const key = reader.name(`GGUF key ${index}`);
      kv.push(readGgufKv(reader, key, reader.u32()));
    }
    const tensors = [];
    for (let index = 0; index < tensorCount; index += 1) {
      const name = reader.name(`GGUF tensor name ${index}`);
      const nDims = reader.u32();
      if (nDims > 8) throw new CaptureError("gguf_header_invalid", `tensor ${index} has ${nDims} dimensions`);
      const dims = [];
      for (let dim = 0; dim < nDims; dim += 1) dims.push(reader.count());
      const typeId = reader.u32();
      const offset = reader.count();
      tensors.push({ name, dims, typeId, offset });
    }
    const alignmentEntry = kv.find((entry) => entry.key === "general.alignment");
    const alignment = Number.isSafeInteger(alignmentEntry?.value) && alignmentEntry.value > 0 ? alignmentEntry.value : 32;
    return { version, alignment, headerBytes: alignUp(reader.offset, alignment), tensorCount, kv, tensors };
  } finally {
    fs.closeSync(fd);
  }
}

// Exact tensor bytes come from the type table; the gap to the next tensor's
// offset verifies them. An unknown type keeps the gap and bytesExact:false.
function ggufTensorSizes(header, fileBytes, file, warnings) {
  const byOffset = [...header.tensors].sort((left, right) => left.offset - right.offset);
  const dataBytes = Math.max(0, fileBytes - header.headerBytes);
  const sizes = new Map();
  let unknown = 0;
  let mismatched = 0;
  byOffset.forEach((tensor, position) => {
    const next = byOffset[position + 1];
    const gap = (next ? next.offset : dataBytes) - tensor.offset;
    const computed = ggmlTensorBytes(tensor.typeId, tensor.dims);
    if (computed === null) {
      unknown += 1;
      sizes.set(tensor, { bytes: Math.max(0, gap), exact: false });
      return;
    }
    const truncated = !next && header.headerBytes + tensor.offset + computed > fileBytes;
    if (!truncated && (computed > gap || (next && gap - computed >= header.alignment))) mismatched += 1;
    sizes.set(tensor, { bytes: computed, exact: true });
  });
  if (unknown) warnings.push({ code: "ggml_type_unknown", file, detail: `${unknown}` });
  if (mismatched) warnings.push({ code: "tensor_size_mismatch", file, detail: `${mismatched}` });
  const dataEnd = byOffset.reduce((end, tensor) => Math.max(end, tensor.offset + sizes.get(tensor).bytes), 0);
  if (header.headerBytes + dataEnd > fileBytes) warnings.push({ code: "gguf_payload_short", file });
  return sizes;
}

function scrubGgufKv(entry, file, scrubbed) {
  const scrub = (value, pointer) => {
    if (typeof value !== "string") return value;
    const next = scrubString(value);
    if (next !== value) scrubbed.push({ file, pointer, reason: "absolute_path" });
    return next;
  };
  if (entry.type === "string") return { ...entry, value: scrub(entry.value, `/kv/${escapePointerToken(entry.key)}`) };
  if (entry.type !== "array" || entry.itemType !== "string") return entry;
  const pointer = (index) => `/kv/${escapePointerToken(entry.key)}/${index}`;
  if (Array.isArray(entry.value)) return { ...entry, value: entry.value.map((item, index) => scrub(item, pointer(index))) };
  return { ...entry, value: { ...entry.value, head: entry.value.head.map((item, index) => scrub(item, pointer(index))) } };
}

function captureGguf(entries, warnings, scrubbed) {
  const files = [];
  for (const entry of entries) {
    let header;
    try {
      header = readGgufHeader(entry.abs, entry.bytes);
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error;
      warnings.push({ code: "gguf_header_invalid", file: entry.name, detail: error.message });
      entry.kind = "placeholder";
      continue;
    }
    const sizes = ggufTensorSizes(header, entry.bytes, entry.name, warnings);
    const groups = sortGroups(compressTensors(header.tensors, (tensor) => {
      const size = sizes.get(tensor);
      const fields = {
        type: GGML_TYPES[tensor.typeId]?.name ?? null,
        typeId: tensor.typeId,
        dims: tensor.dims,
        bytesEach: size.bytes,
      };
      if (!size.exact) fields.bytesExact = false;
      return fields;
    }));
    files.push({
      name: entry.name,
      bytes: entry.bytes,
      version: header.version,
      alignment: header.alignment,
      headerBytes: header.headerBytes,
      tensorCount: header.tensorCount,
      kv: header.kv.map((item) => scrubGgufKv(item, entry.name, scrubbed)),
      groups,
    });
  }
  return files.length ? { format: "gguf", files } : null;
}

// ---------------------------------------------------------------------------
// License, layout, privacy

function normalizeLicense(value) {
  const text = String(value ?? "").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
  return text || "";
}

function readmeFrontMatterLicense(abs) {
  const fd = fs.openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(Math.min(MAX_README_BYTES, fs.fstatSync(fd).size));
    readExact(fd, buffer, 0);
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!text.startsWith("---\n")) return "";
    const end = text.indexOf("\n---", 4);
    if (end < 0) return "";
    const line = text.slice(4, end).split("\n").find((item) => /^license\s*:/.test(item));
    return line ? normalizeLicense(line.slice(line.indexOf(":") + 1)) : "";
  } finally {
    fs.closeSync(fd);
  }
}

function licenseFileId(abs) {
  const fd = fs.openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(Math.min(4096, fs.fstatSync(fd).size));
    readExact(fd, buffer, 0);
    const text = buffer.toString("utf8");
    if (/Apache License/i.test(text) && /Version 2\.0/i.test(text)) return "apache-2.0";
    if (/^\s*MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text)) return "mit";
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

function detectLicense(options, inventory, gguf) {
  if (options.license) return { license: normalizeLicense(options.license), licenseSource: "cli" };
  const byName = new Map(inventory.map((entry) => [entry.name.toLowerCase(), entry]));
  const readme = byName.get("readme.md");
  if (readme) {
    const license = readmeFrontMatterLicense(readme.abs);
    if (license) return { license, licenseSource: "readme" };
  }
  for (const name of ["license", "license.txt", "license.md"]) {
    const entry = byName.get(name);
    const license = entry ? licenseFileId(entry.abs) : "";
    if (license) return { license, licenseSource: "license-file" };
  }
  for (const file of gguf?.files || []) {
    const entry = file.kv.find((item) => item.key === "general.license" && typeof item.value === "string");
    if (entry && normalizeLicense(entry.value)) return { license: normalizeLicense(entry.value), licenseSource: "gguf" };
  }
  return { license: "", licenseSource: null };
}

// The 02 §4.3 format.layout values. Transformers weights count at the folder
// root only (a subfolder of weights is a custom layout); GGUF files often sit
// in a quant subfolder and count anywhere.
function detectLayout(inventory, tensorTable, gguf) {
  const weights = inventory.filter((entry) => !entry.name.includes("/") && (entry.kind === "safetensors"
    || (entry.kind === "placeholder" && /\.(?:bin|pt|pth)$/i.test(entry.name) && /(?:pytorch_model|model)/i.test(entry.name))));
  const ggufSplit = (gguf?.files || []).some((file) => file.kv.some((item) => item.key === "split.count" && Number(item.value) > 1));
  if (!weights.length && !gguf) return "custom";
  if (weights.length && gguf) return "custom";
  if (gguf) return ggufSplit ? "gguf-split" : "single";
  if (tensorTable?.index || inventory.some((entry) => /\.bin\.index\.json$/i.test(entry.name))) return "indexed";
  return weights.length > 1 ? "unindexed-shards" : "single";
}

function identityNeedles() {
  const needles = new Set();
  try {
    const user = os.userInfo().username;
    if (user && user.length >= 3) needles.add(user.toLowerCase());
  } catch {
    // userInfo throws when the account has no name; nothing to check then.
  }
  const host = os.hostname();
  if (host && host.length >= 3) needles.add(host.toLowerCase());
  const home = os.homedir();
  if (home && home.length >= 3) needles.add(home.toLowerCase());
  return Array.from(needles);
}

// Returns check ids only, never the matched text (it could be a secret).
function privacyFindings(text, needles = identityNeedles()) {
  const findings = [];
  for (const entry of PRIVACY_PATTERNS) if (entry.pattern.test(text)) findings.push(entry.id);
  const lower = text.toLowerCase();
  if (needles.some((needle) => lower.includes(needle))) findings.push("identity");
  return findings;
}

// ---------------------------------------------------------------------------
// JSON layout: objects and arrays of objects one entry per line, flat entries
// (tensor groups, KV entries, file records) on a single line each.

function isInlineJson(value) {
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every((item) => item === null || typeof item !== "object");
  return Object.values(value).every((item) => isInlineJson(item));
}

function formatJson(value, indent = "") {
  if (isInlineJson(value)) return JSON.stringify(value);
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((item) => `${next}${formatJson(item, next)}`).join(",\n")}\n${indent}]` : "[]";
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length
    ? `{\n${entries.map(([key, item]) => `${next}${JSON.stringify(key)}: ${formatJson(item, next)}`).join(",\n")}\n${indent}}`
    : "{}";
}

// ---------------------------------------------------------------------------
// Capture

const FIXTURE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function normalizeRelative(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// Builds every fixture file in memory. Throws CaptureError; exit code 2 means
// a refusal the owner can override (--license/--allow-license) or must fix.
function buildFixture(options) {
  const source = path.resolve(String(options.from || ""));
  if (!options.from || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new CaptureError("source_missing", "--from must name an existing folder.");
  }
  if (!FIXTURE_ID.test(String(options.id || ""))) {
    throw new CaptureError("invalid_id", "--id must be lowercase letters, digits and dashes.");
  }
  const { files: inventory, skipped } = walkInventory(source);
  const warnings = [];
  const scrubbed = [];
  if (skipped.links) warnings.push({ code: "links_skipped", detail: `${skipped.links}` });
  if (skipped.deep) warnings.push({ code: "deep_entries_skipped", detail: `${skipped.deep}` });

  const requestedGguf = new Set((options.gguf || []).map(normalizeRelative));
  for (const name of requestedGguf) {
    if (!inventory.some((entry) => entry.name === name && entry.name.toLowerCase().endsWith(".gguf"))) {
      throw new CaptureError("gguf_missing", `--gguf ${name} is not a GGUF file in the folder.`);
    }
  }
  const isSelectedGguf = (name) => !requestedGguf.size || requestedGguf.has(name);
  for (const entry of inventory) entry.kind = classifyFile(entry.name, isSelectedGguf);

  const indexEntries = inventory.filter((entry) => entry.kind === "index");
  for (const extra of indexEntries.slice(1)) {
    extra.kind = "placeholder";
    warnings.push({ code: "extra_index_listed", file: extra.name });
  }
  const tensorTable = captureSafetensors(inventory.filter((entry) => entry.kind === "safetensors"), indexEntries[0] || null, warnings, scrubbed);
  if (!tensorTable && indexEntries[0]) indexEntries[0].kind = "placeholder";
  const gguf = captureGguf(inventory.filter((entry) => entry.kind === "gguf"), warnings, scrubbed);

  const { license, licenseSource } = detectLicense(options, inventory, gguf);
  if (!license) {
    throw new CaptureError("license_unknown", "The folder declares no license (README front matter, LICENSE or GGUF general.license). Pass --license <id>.", 2);
  }
  if (!PERMISSIVE_LICENSES.has(license) && !options.allowLicense) {
    throw new CaptureError("license_not_permissive", `License "${license}" is not on the permissive list. Pass --allow-license to capture it anyway.`, 2);
  }

  const output = new Map();
  for (const entry of inventory.filter((item) => item.kind === "captured")) {
    let buffer;
    try {
      buffer = readFileBounded(entry.abs, MAX_JSON_BYTES, "file_too_large");
    } catch (error) {
      if (!(error instanceof CaptureError)) throw error;
      warnings.push({ code: "file_too_large", file: entry.name });
      entry.kind = "placeholder";
      continue;
    }
    const content = scrubCapturedFile(entry.name, buffer, scrubbed, warnings);
    output.set(entry.name, content);
    entry.capturedBytes = Buffer.byteLength(content, "utf8");
  }
  if (tensorTable) output.set("tensor-table.json", `${formatJson(tensorTable)}\n`);
  if (gguf) output.set("gguf-header.json", `${formatJson(gguf)}\n`);

  const folderName = scrubString(path.basename(source));
  const manifest = {
    schemaVersion: 1,
    id: options.id,
    synthetic: Boolean(options.synthetic),
    license,
    licenseSource,
    folderName,
    layout: detectLayout(inventory, tensorTable, gguf),
    capturedWith: { tool: TOOL, version: TOOL_VERSION },
    notes: [...(options.notes || [])],
    warnings,
    scrubbed,
    files: inventory.map((entry) => ({ name: entry.name, bytes: entry.kind === "captured" ? entry.capturedBytes : entry.bytes, kind: entry.kind })),
  };
  output.set("manifest.json", `${formatJson(manifest)}\n`);

  // Nothing leaves the tool that the privacy test would reject.
  const needles = options.needles || identityNeedles();
  const refusals = [];
  for (const [name, content] of output) {
    for (const finding of privacyFindings(content, needles)) refusals.push(`${name}: ${finding}`);
  }
  if (refusals.length) {
    const error = new CaptureError("privacy_refused", `Privacy check failed; nothing was written:\n  ${refusals.join("\n  ")}`, 2);
    error.refusals = refusals;
    throw error;
  }

  return { manifest, files: output, summary: summarize(manifest, tensorTable, gguf) };
}

function summarize(manifest, tensorTable, gguf) {
  const count = (kind) => manifest.files.filter((entry) => entry.kind === kind).length;
  return {
    captured: count("captured"),
    safetensors: count("safetensors"),
    tensorGroups: tensorTable ? tensorTable.groups.length : 0,
    tensors: tensorTable ? tensorTable.files.reduce((sum, file) => sum + file.tensors, 0) : 0,
    gguf: count("gguf"),
    placeholders: count("placeholder"),
    warnings: manifest.warnings.length,
    scrubbed: manifest.scrubbed.length,
  };
}

function writeFixture(outRoot, id, files, { force = false } = {}) {
  const dir = path.join(outRoot, id);
  if (fs.existsSync(dir)) {
    if (!force) throw new CaptureError("fixture_exists", `Fixture ${id} exists. Pass --force to replace it.`);
    for (const entry of fs.readdirSync(dir)) {
      if (!PRESERVED_ON_FORCE.has(entry)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  for (const [name, content] of files) {
    const target = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout || ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr || ((line) => process.stderr.write(`${line}\n`));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(error.message);
    err(USAGE);
    return 1;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (!options.from || !options.id) {
    err("--from and --id are required.");
    err(USAGE);
    return 1;
  }
  const outRoot = path.resolve(options.out || deps.defaultOut || DEFAULT_OUT);
  const source = path.resolve(options.from);
  if (isInside(outRoot, source) || isInside(path.join(outRoot, options.id), source)) {
    err("--out must not be inside --from; the source folder is never written.");
    return 1;
  }
  let built;
  try {
    built = buildFixture({ ...options, needles: deps.needles });
  } catch (error) {
    if (!(error instanceof CaptureError)) throw error;
    err(`capture-model-fixture: ${error.message}`);
    return error.exitCode;
  }
  const { summary } = built;
  const line = `${summary.captured} metadata files, ${summary.safetensors} safetensors files (${summary.tensors} tensors in ${summary.tensorGroups} groups), `
    + `${summary.gguf} GGUF headers, ${summary.placeholders} listed by size; ${summary.warnings} warnings, ${summary.scrubbed} scrubbed values.`;
  if (options.dryRun) {
    out(`capture-model-fixture: dry run for ${options.id}, nothing is written.`);
    for (const name of built.files.keys()) out(`  ${options.id}/${name}`);
    out(`  ${line}`);
    return 0;
  }
  try {
    writeFixture(outRoot, options.id, built.files, { force: options.force });
  } catch (error) {
    if (!(error instanceof CaptureError)) throw error;
    err(`capture-model-fixture: ${error.message}`);
    return error.exitCode;
  }
  out(`capture-model-fixture: wrote ${built.files.size} files for ${options.id}.`);
  out(`  ${line}`);
  for (const warning of built.manifest.warnings) out(`  warning ${warning.code}${warning.file ? ` (${warning.file})` : ""}`);
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`capture-model-fixture failed (${error?.code || "error"}).\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CAPTURED_ROOT_FILES,
  CREDENTIAL_PATTERNS,
  GGML_TYPES,
  GGML_TYPE_IDS,
  GGUF_VALUE_TYPES,
  PERMISSIVE_LICENSES,
  PRIVACY_PATTERNS,
  abstractTensorName,
  buildFixture,
  compressTensors,
  decompose,
  expandGroupNames,
  expandRangeSpec,
  formatJson,
  ggmlTensorBytes,
  main,
  parseArgs,
  privacyFindings,
  rangeSpec,
  readGgufHeader,
  readSafetensorsHeader,
  scrubString,
};
