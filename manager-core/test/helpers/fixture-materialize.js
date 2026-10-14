"use strict";

// Expands a model-card fixture (manager-core/test/fixtures/model-cards/<id>/,
// docs/overhaul/02-models.md §21.1) into a temporary model folder: metadata
// files are copied, safetensors and GGUF files get real headers, and every
// file is sized to its captured length without writing payload bytes.
//
// Sizing: files are extended with truncate, which is sparse on Linux and
// macOS. NTFS reserves the space of a plain extended file, so on Windows each
// large file is first marked sparse with `fsutil sparse setflag` (no
// elevation needed). sizes: "auto" (default) falls back to header-only sizes
// when that is impossible, "real" throws instead, "header" never extends.
// Every result file reports `sized` and `exact`, so tests can tell.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { expandGroupTensors } = require("../../../scripts/capture-model-fixture.js");
const { buildGguf } = require("./gguf-writer");
const { buildSafetensorsHeader } = require("./safetensors-writer");

const FIXTURES_ROOT = path.join(__dirname, "..", "fixtures", "model-cards");
const SPARSE_MIN_BYTES = 1024 * 1024;
const NON_SPARSE_LIMIT = 256 * 1024 * 1024;
const SPARSE_CONCURRENCY = 8;

function fixtureDir(id, root = FIXTURES_ROOT) {
  return path.join(root, id);
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Fixture ids (folders holding a manifest.json), sorted. */
function listFixtures(root = FIXTURES_ROOT) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort();
}

function loadFixture(id, root = FIXTURES_ROOT) {
  const dir = fixtureDir(id, root);
  const manifest = readJsonIfPresent(path.join(dir, "manifest.json"));
  if (!manifest) throw new Error(`Fixture ${id} has no manifest.json.`);
  return {
    id,
    dir,
    manifest,
    tensorTable: readJsonIfPresent(path.join(dir, "tensor-table.json")),
    ggufHeader: readJsonIfPresent(path.join(dir, "gguf-header.json")),
    expectedCard: readJsonIfPresent(path.join(dir, "expected-card.json")),
  };
}

/**
 * Every tensor of a tensor-table or GGUF group list, with the group fields;
 * `file` is the tensor's shard (filePattern filled in), absent for GGUF.
 */
function expandGroups(groups) {
  const tensors = [];
  for (const group of groups || []) {
    const { pattern, ranges, name, file, filePattern, ...fields } = group;
    for (const tensor of expandGroupTensors(group)) tensors.push({ ...tensor, ...fields });
  }
  return tensors;
}

// The stable projection kept in expected-card.json: no inspectedAt, ref or
// cardId (02 §21.1), so goldens survive renames and re-inspection.
function stableCardProjection(card) {
  if (!card || typeof card !== "object") return card;
  const { inspectedAt, ref, cardId, ...rest } = card;
  return JSON.parse(JSON.stringify(rest));
}

function markSparse(file) {
  return new Promise((resolve) => {
    execFile("fsutil.exe", ["sparse", "setflag", file], { windowsHide: true, timeout: 15000 }, (error) => resolve(!error));
  });
}

async function markSparseAll(files) {
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      results.set(file, await markSparse(file));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPARSE_CONCURRENCY, files.length) }, worker));
  return results;
}

/**
 * entries: [{file, bytes}] for files that already hold their header. Extends
 * each to `bytes`. Returns a Map file → sized (boolean).
 */
async function resizeFiles(entries, { sizes = "auto", platform = process.platform } = {}) {
  const result = new Map();
  if (sizes === "header") {
    for (const entry of entries) result.set(entry.file, fs.statSync(entry.file).size === entry.bytes);
    return result;
  }
  const large = entries.filter((entry) => entry.bytes >= SPARSE_MIN_BYTES && fs.statSync(entry.file).size < entry.bytes);
  const sparse = platform === "win32" && large.length ? await markSparseAll(large.map((entry) => entry.file)) : null;
  for (const entry of entries) {
    const current = fs.statSync(entry.file).size;
    if (current >= entry.bytes) {
      if (current > entry.bytes) await fsp.truncate(entry.file, entry.bytes);
      result.set(entry.file, true);
      continue;
    }
    const isSparse = sparse ? sparse.get(entry.file) !== false : true;
    if (sparse && sparse.has(entry.file) && !isSparse && entry.bytes > NON_SPARSE_LIMIT) {
      if (sizes === "real") throw new Error(`Cannot mark ${path.basename(entry.file)} sparse; refusing to reserve ${entry.bytes} bytes.`);
      result.set(entry.file, false);
      continue;
    }
    try {
      await fsp.truncate(entry.file, entry.bytes);
      result.set(entry.file, true);
    } catch (error) {
      if (sizes === "real" || !["ENOSPC", "EFBIG", "EINVAL"].includes(error.code)) throw error;
      result.set(entry.file, false);
    }
  }
  return result;
}

// Python's json.dumps default: one line, ", " and ": " separators.
function pythonJson(value) {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

// weight_map values are relative to the index file, as Hugging Face writes
// them. Keys are sorted; the captured style and final newline keep the size.
function writeIndexFile(target, index, safetensorsFiles, tensorsByFile) {
  const weightMap = {};
  const base = path.posix.dirname(index.name);
  for (const record of safetensorsFiles) {
    const relative = path.posix.relative(base === "." ? "" : base, record.name);
    for (const tensor of tensorsByFile.get(record.name) || []) weightMap[tensor.name] = relative;
  }
  const sorted = Object.fromEntries(Object.keys(weightMap).sort().map((name) => [name, weightMap[name]]));
  const value = { metadata: index.metadata || {}, weight_map: sorted };
  const body = index.style === "python" ? pythonJson(value) : JSON.stringify(value, null, 2);
  fs.writeFileSync(target, index.newline === false ? body : `${body}\n`, "utf8");
}

/**
 * Builds the model folder for fixture `id` under `parent` (default: a new
 * temp folder). `name` overrides the folder name (rename tests); the default
 * is manifest.folderName. Returns { root, dir, files, cleanup }, where files
 * lists {name, kind, bytes (captured), actualBytes, sized, exact}.
 */
async function materializeFixture(id, options = {}) {
  const fixture = loadFixture(id, options.fixturesRoot);
  const { manifest, tensorTable, ggufHeader } = fixture;
  const root = options.parent ? path.resolve(options.parent) : await fsp.mkdtemp(path.join(os.tmpdir(), "model-fixture-"));
  const dir = path.join(root, options.name || manifest.folderName || id);
  await fsp.mkdir(dir, { recursive: true });
  const target = (name) => path.join(dir, ...name.split("/"));
  const exact = new Map();
  const toSize = [];

  const tensorsByFile = new Map();
  for (const tensor of expandGroups(tensorTable?.groups)) {
    const list = tensorsByFile.get(tensor.file) || [];
    list.push(tensor);
    tensorsByFile.set(tensor.file, list);
  }
  const safetensorsByName = new Map((tensorTable?.files || []).map((record) => [record.name, record]));
  const ggufByName = new Map((ggufHeader?.files || []).map((record) => [record.name, record]));

  for (const entry of manifest.files) {
    const file = target(entry.name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (entry.kind === "captured") {
      await fsp.copyFile(path.join(fixture.dir, ...entry.name.split("/")), file);
      exact.set(entry.name, true);
    } else if (entry.kind === "safetensors") {
      const record = safetensorsByName.get(entry.name);
      if (!record) throw new Error(`Fixture ${id}: ${entry.name} is missing from tensor-table.json.`);
      const tensors = (tensorsByFile.get(entry.name) || []).map((tensor) => ({
        name: tensor.name, dtype: tensor.dtype, shape: tensor.shape, bytes: tensor.bytesEach,
      }));
      const built = buildSafetensorsHeader(tensors, { metadata: record.metadata || null, headerBytes: record.headerBytes, order: record.order || null });
      await fsp.writeFile(file, built.header);
      exact.set(entry.name, built.exactHeader);
      toSize.push({ name: entry.name, file, bytes: Math.max(entry.bytes, built.totalBytes) });
    } else if (entry.kind === "gguf") {
      const record = ggufByName.get(entry.name);
      if (!record) throw new Error(`Fixture ${id}: ${entry.name} is missing from gguf-header.json.`);
      const built = buildGguf({
        version: record.version,
        alignment: record.alignment,
        headerBytes: record.headerBytes,
        kv: record.kv,
        tensors: expandGroups(record.groups).map((tensor) => ({
          name: tensor.name, dims: tensor.dims, typeId: tensor.typeId, bytes: tensor.bytesEach,
        })),
      });
      await fsp.writeFile(file, built.header);
      exact.set(entry.name, built.exactHeader);
      toSize.push({ name: entry.name, file, bytes: Math.max(entry.bytes, built.totalBytes) });
    } else if (entry.kind === "index") {
      if (!tensorTable?.index) throw new Error(`Fixture ${id}: ${entry.name} has no index in tensor-table.json.`);
      writeIndexFile(file, tensorTable.index, tensorTable.files, tensorsByFile);
      exact.set(entry.name, fs.statSync(file).size === entry.bytes);
    } else {
      await fsp.writeFile(file, "");
      exact.set(entry.name, true);
      toSize.push({ name: entry.name, file, bytes: entry.bytes });
    }
  }

  const sized = await resizeFiles(toSize, { sizes: options.sizes || "auto" });
  const files = manifest.files.map((entry) => {
    const file = target(entry.name);
    const actualBytes = fs.statSync(file).size;
    return {
      name: entry.name,
      kind: entry.kind,
      bytes: entry.bytes,
      actualBytes,
      sized: sized.has(file) ? sized.get(file) && actualBytes === entry.bytes : actualBytes === entry.bytes,
      exact: Boolean(exact.get(entry.name)) && actualBytes === entry.bytes,
    };
  });
  return {
    root,
    dir,
    files,
    // A caller-supplied parent is never removed, only the model folder in it.
    cleanup: () => fsp.rm(options.parent ? dir : root, { recursive: true, force: true }),
  };
}

module.exports = {
  FIXTURES_ROOT,
  expandGroups,
  fixtureDir,
  listFixtures,
  loadFixture,
  materializeFixture,
  resizeFiles,
  stableCardProjection,
};
