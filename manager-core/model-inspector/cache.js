"use strict";

// Card identifiers and the facts cache (docs/overhaul/02-models.md §4.1).
//
// cardId = "mc_" + the first 20 characters of the lowercase RFC 4648 base32
// (no padding) of sha256(canonicalRef):
//   local   "local:" + realpath(dir) with "/" separators, lower case
//           (+ "#file=<basename>" for a single GGUF file)
//   remote  "hf:<repo>@<revision>" or "modelscope:<repo>@<revision>"
//
// The cache holds raw detector facts at <AI_ROOT>/cache/model-cards/<cardId>.json
// as { schemaVersion, cardId, key, inspectorVersion, depth, contentDigest,
// inspectedAt, facts }. `key` is the local fingerprint: sha256 of the sorted
// (relative path, size, mtimeMs) of every listed file, from stat calls only.
// Derived fields are rebuilt on every read, so knowledge edits never need a
// re-inspection. A missing or corrupt cache file is a miss, never an error;
// writes go to a temporary file renamed into place.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { contentDigestForDir } = require("./content-digest");
const { scanInventory } = require("./detectors/inventory");

const CACHE_SCHEMA_VERSION = 1;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CARD_ID_PATTERN = /^mc_[a-z2-7]{20}$/;
const RENAME_RETRIES = 4;

function base32(buffer) {
  let output = "";
  let value = 0;
  let bits = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** The canonical reference string of 02 §4.1 for a local or remote ref. */
function canonicalRef(ref) {
  if (typeof ref === "string") return ref;
  if (!ref || typeof ref !== "object") throw new TypeError("A card reference is a string or {kind, ...}.");
  if (ref.kind === "local") {
    const dir = String(ref.path || "").replace(/\\/g, "/").toLowerCase();
    if (!dir) throw new TypeError("A local card reference needs a path.");
    return `local:${dir}${ref.file ? `#file=${ref.file}` : ""}`;
  }
  const source = ref.kind === "huggingface" ? "hf" : ref.kind;
  if (source !== "hf" && source !== "modelscope") throw new TypeError(`Unknown card reference kind ${JSON.stringify(ref.kind)}.`);
  if (!ref.repo) throw new TypeError("A remote card reference needs a repo.");
  return `${source}:${ref.repo}@${ref.revision || "main"}`;
}

/** cardId for a reference (02 §4.1): "mc_" + 20 base32 characters. */
function cardIdFor(ref) {
  return `mc_${base32(crypto.createHash("sha256").update(canonicalRef(ref), "utf8").digest()).slice(0, 20)}`;
}

function isCardId(value) {
  return typeof value === "string" && CARD_ID_PATTERN.test(value);
}

function defaultCacheDir(env = process.env) {
  const root = env.AI_ROOT ? path.resolve(env.AI_ROOT) : path.resolve(__dirname, "..", "..");
  return path.join(root, "cache", "model-cards");
}

/** sha256 over the sorted (relative path, size, mtimeMs) of an inventory. */
function fingerprintKey(inventory) {
  const hash = crypto.createHash("sha256");
  for (const entry of inventory.files) hash.update(`${entry.name}\t${entry.size}\t${entry.mtimeMs}\n`);
  return hash.digest("hex");
}

/**
 * fingerprintLocal(dir, {file, inventory, known}) -> Promise<{key, contentDigest, inventory}>
 * Lists the folder (stat only) for the cache key. The content digest reads
 * the small files, so it is reused from `known` ({key, contentDigest}, e.g.
 * the cached entry) while the key is unchanged.
 */
async function fingerprintLocal(dir, options = {}) {
  const inventory = options.inventory || await scanInventory(dir, { signal: options.signal });
  const key = fingerprintKey(inventory);
  const known = options.known;
  const contentDigest = known && known.key === key && typeof known.contentDigest === "string"
    ? known.contentDigest
    : await contentDigestForDir(dir, { file: options.file || null, inventory });
  return { key, contentDigest, inventory };
}

function cacheFile(cardId, cacheDir) {
  if (!isCardId(cardId)) throw new TypeError(`Not a cardId: ${JSON.stringify(cardId)}.`);
  return path.join(cacheDir || defaultCacheDir(), `${cardId}.json`);
}

function validEntry(value, cardId) {
  return Boolean(value) && typeof value === "object" && value.schemaVersion === CACHE_SCHEMA_VERSION
    && value.cardId === cardId && typeof value.key === "string" && typeof value.inspectorVersion === "string"
    && value.facts && typeof value.facts === "object" ? value : null;
}

/** The cached entry for a cardId, or null (missing, corrupt or another schema). */
async function readCachedFacts(cardId, { cacheDir } = {}) {
  try {
    return validEntry(JSON.parse(await fsp.readFile(cacheFile(cardId, cacheDir), "utf8")), cardId);
  } catch {
    return null;
  }
}

/** Synchronous read for getCard(); same rules as readCachedFacts. */
function readCachedFactsSync(cardId, { cacheDir } = {}) {
  try {
    return validEntry(JSON.parse(fs.readFileSync(cacheFile(cardId, cacheDir), "utf8")), cardId);
  } catch {
    return null;
  }
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open for a moment.
      if (attempt >= RENAME_RETRIES || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/** Writes the entry for a cardId atomically (temporary file + rename). */
async function writeCachedFacts(cardId, entry, { cacheDir } = {}) {
  const file = cacheFile(cardId, cacheDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const body = JSON.stringify({ ...entry, schemaVersion: CACHE_SCHEMA_VERSION, cardId });
  try {
    await fsp.writeFile(temporary, body, "utf8");
    await renameWithRetry(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CARD_ID_PATTERN,
  base32,
  canonicalRef,
  cardIdFor,
  defaultCacheDir,
  fingerprintKey,
  fingerprintLocal,
  isCardId,
  readCachedFacts,
  readCachedFactsSync,
  writeCachedFacts,
};
