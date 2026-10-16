"use strict";

// Library registry (03 §9): every model on this machine in one list. It scans
// the registered storage roots, the Hugging Face cache and the ModelScope
// cache; backfills provenance (where a model came from) from the sources
// that exist today; keeps entry ids stable across renames and migrations;
// and links duplicates. The actions of 03 §9.5 live here too: update check
// and update (§9.4), delete, residue cleanup and the import of a Hugging Face
// cache repository. They are the only code in the hub that removes or copies
// model files, and each one is guarded (confirm, root, busy path) before it
// touches the disk; none of them ever stops a container.
//
// Layout of this module:
//   - pure helpers (walking, hashing the file set, quant and format guesses,
//     provenance merge) at the top, so the precedence rules read in one place;
//   - createLibrary(): the scan, the persisted registry (library.json), the
//     in-memory tasks (rescan, verify) and the actions HUB-8 owns.
//
// Provenance is a pure function of the entry's recorded `internal.sources`
// (03 §9.3, first source wins per field):
//   user (identify) > hub job > platform marker > legacy ledger / migration
//   record > hf-local-metadata > cache refs.
// `internal` is persisted in library.json and never sent through an API.

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { replaceFileAtomically } = require("../file-utils");
const { createModelFilesystemStore } = require("../model-filesystem-store");
const { containsPath, overlapsPath, pathKey } = require("../model-storage");
const { redactSecrets } = require("../secret-redactor");
const { resolveSelection } = require("./selection");
const { writeDownloadMarker } = require("./verify");

const LIBRARY_SCHEMA_VERSION = 1;
const FILES_CAP = 5000;
const WALK_LIMIT = 200000;
const SCAN_CONCURRENCY = 4;
const METADATA_READ_CONCURRENCY = 8;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const TASK_KEEP = 100;
const EVENT_IDS_CAP = 1000;
const IDENTIFY_TIMEOUT_MS = 8000;
const STORAGE_WATCH_MS = 60 * 1000;
const HF_CACHE_ROOT_ID = "hf-cache";
const MS_CACHE_ROOT_ID = "modelscope-cache";
const HF_CACHE_LABEL = "Hugging Face cache";
const MS_CACHE_LABEL = "ModelScope cache";
const TERMINAL_JOB_STATES = Object.freeze(["ready", "failed", "cancelled"]);
const MARKER_FILE = ".platform-download.json";
const CONFIDENCES = Object.freeze(["declared", "detected", "unverified", "unknown"]);

const WEIGHT_RE = /\.(gguf|safetensors|bin|pt|pth)$/i;
const SCRIPT_RE = /\.(py|sh|js|cmd|ps1|bat)$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const GIT_OID_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ID_RE = /^lib_[0-9a-f]{16}$/;
const TASK_ID_RE = /^tsk_[0-9a-f]{16}$/;
const PROVENANCE_FIELDS = Object.freeze(["provider", "transport", "repo", "revision", "revisionSha", "artifactKey", "downloadedAt", "downloadJobId", "quant"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function maxOf(values) {
  let best = 0;
  for (const value of values) if (value > best) best = value;
  return best;
}

function computeRunnable(role, cardRunnable, verificationStatus) {
  if (role === "tooling-only" || cardRunnable === false) return false;
  return verificationStatus !== "fail";
}

function sameText(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function iso(value) {
  return new Date(value).toISOString();
}

class LibraryError extends Error {
  constructor(code, message, { status = 400, hint = "", details = null } = {}) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    this.status = status;
    if (hint) this.hint = hint;
    if (details) this.details = details;
  }
}

// --- pure helpers ---------------------------------------------------------------

/** The drive (or filesystem root) a path lives on: "X:" on Windows, "/" elsewhere. */
function volumeOf(value) {
  let target = path.resolve(String(value));
  try {
    target = fs.realpathSync.native(target);
  } catch {
    // A path that does not exist yet is judged by its own spelling.
  }
  const root = path.parse(target).root;
  if (process.platform === "win32") {
    const drive = /^([A-Za-z]:)/.exec(root);
    return drive ? drive[1].toUpperCase() : root.replace(/[\\/]+$/, "");
  }
  return root.replace(/[\\/]+$/, "") || "/";
}

// What the files of a model folder are for. `.incomplete` residue is counted
// wherever it sits (hf puts it under .cache), before the .cache rule.
function classifyFile(rel) {
  const lower = rel.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.endsWith(".incomplete")) return "incomplete";
  if (lower.startsWith(".cache/") || lower.includes("/.cache/")) return "cache";
  if (name.startsWith(".platform-")) return "marker";
  // ModelScope's bookkeeping files and temp folder.
  if (name === ".msc" || name === ".mv" || lower.startsWith("._____temp/")) return "bookkeeping";
  return "payload";
}

/**
 * The fileset hash (03 §9.3): sha256 of the sorted lines
 * "path<TAB>size<TAB>sha256|gitOid|-", joined by newlines.
 */
function computeFilesetHash(files) {
  const lines = files.map((file) => `${file.path}\t${file.size}\t${file.sha256 || file.gitOid || "-"}`).sort();
  return sha256Text(lines.join("\n"));
}

/** "hf:owner/name@<sha>#<filesetHash>"; huggingface and hf-mirror share "hf". */
function identityKeyFor(provenance, filesetHash) {
  if (!provenance?.repo || !provenance.revisionSha || !filesetHash) return null;
  if (provenance.confidence !== "declared" && provenance.confidence !== "detected") return null;
  const ns = provenance.provider === "modelscope" ? "ms" : "hf";
  return `${ns}:${provenance.repo.toLowerCase()}@${provenance.revisionSha.toLowerCase()}#${filesetHash}`;
}

function namespaceOf(value) {
  const text = String(value || "").toLowerCase();
  if (text === "modelscope") return "modelscope";
  if (text === "huggingface" || text === "hf-mirror" || text === "hf") return "huggingface";
  return null;
}

function cleanRepo(value) {
  const text = String(value || "").trim().split(":")[0];
  return REPO_RE.test(text) ? text : null;
}

function cleanSha(value) {
  const text = String(value || "").trim().toLowerCase();
  return GIT_OID_RE.test(text) ? text : null;
}

// The etag of a hf `.metadata` file or a cache blob name: 64 hex is the LFS
// sha256, 40 hex a git blob id.
function hashesFromEtag(value) {
  const text = String(value || "").trim().replace(/^W\//, "").replace(/^"+|"+$/g, "").toLowerCase();
  if (SHA256_RE.test(text)) return { sha256: text, gitOid: null };
  if (GIT_OID_RE.test(text)) return { sha256: null, gitOid: text };
  return null;
}

/** owner/name guesses from a folder name: "a__b" first, then each "-" split. */
function repoCandidatesFromName(name) {
  const base = String(name || "").trim();
  const out = [];
  const add = (repo) => {
    if (REPO_RE.test(repo) && !out.includes(repo)) out.push(repo);
  };
  const double = base.indexOf("__");
  if (double > 0 && double < base.length - 2) add(`${base.slice(0, double)}/${base.slice(double + 2)}`);
  let index = -1;
  let tried = 0;
  while (tried < 6 && (index = base.indexOf("-", index + 1)) !== -1) {
    if (index > 0 && index < base.length - 1) {
      add(`${base.slice(0, index)}/${base.slice(index + 1)}`);
      tried += 1;
    }
  }
  return out;
}

function detectFormat(weights) {
  const bytes = { gguf: 0, safetensors: 0, pytorch: 0 };
  for (const file of weights) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith(".gguf")) bytes.gguf += file.size;
    else if (lower.endsWith(".safetensors")) bytes.safetensors += file.size;
    else bytes.pytorch += file.size;
  }
  const best = Object.entries(bytes).sort((a, b) => b[1] - a[1])[0];
  if (!best || !weights.length) return null;
  return best[0];
}

function ggufQuantFromPaths(weights) {
  const ggufs = weights.filter((file) => file.path.toLowerCase().endsWith(".gguf") && !/mmproj|imatrix/i.test(file.path));
  const re = /(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Za-z0-9]+)*|BF16|F16|F32|MXFP4)(?=$|[-_.])/i;
  for (const file of [...ggufs].sort((a, b) => b.size - a.size)) {
    const segments = file.path.replace(/\.gguf$/i, "").split("/").reverse();
    for (const segment of segments) {
      const found = re.exec(segment);
      if (found) return found[1].toUpperCase();
    }
  }
  return null;
}

function quantFromConfig(config) {
  if (!isPlainObject(config)) return null;
  const quantization = config.quantization_config;
  if (isPlainObject(quantization)) {
    const method = String(quantization.quant_method || "").toLowerCase();
    if (method === "fp8") return "FP8";
    if (method === "compressed-tensors" && isPlainObject(quantization.config_groups)) {
      for (const group of Object.values(quantization.config_groups)) {
        const weights = group?.weights;
        if (!isPlainObject(weights)) continue;
        const bits = Number(weights.num_bits);
        if (Number.isFinite(bits)) return weights.type === "float" ? `FP${bits}` : `INT${bits}`;
      }
    }
    if (method) return method.toUpperCase();
  }
  const dtype = String(config.torch_dtype || config.dtype || "").toLowerCase();
  if (dtype === "bfloat16") return "BF16";
  if (dtype === "float16") return "FP16";
  if (dtype === "float32") return "FP32";
  return null;
}

function quantFromName(name) {
  const found = /(?:^|[-_.])(NVFP4|MXFP4|FP8|FP4|AWQ|GPTQ|INT4|INT8|BF16|FP16)(?=$|[-_.])/i.exec(String(name || ""));
  return found ? found[1].toUpperCase() : null;
}

/**
 * Provenance from the recorded sources (03 §9.3). `sources` is
 * { user, job, marker, ledger, metadata, cache }, each null or
 * { source, confidence, fields }. A record whose repo contradicts the repo
 * already chosen is skipped whole, so a revision never gets attached to the
 * wrong repository. `metadata` may carry `repoCandidates`, used only when no
 * source named a repo (confidence "unverified").
 */
function deriveProvenance(sources) {
  const order = ["user", "job", "marker", "ledger", "metadata", "cache"];
  const out = {};
  const fieldSources = {};
  let chosenRepo = null;
  let firstSource = null;
  for (const name of order) {
    const record = sources?.[name];
    if (!isPlainObject(record) || !isPlainObject(record.fields)) continue;
    const repo = record.fields.repo || null;
    if (repo && chosenRepo && !sameText(repo, chosenRepo)) continue;
    let took = false;
    for (const field of PROVENANCE_FIELDS) {
      const value = record.fields[field];
      if (out[field] == null && value != null && value !== "") {
        out[field] = value;
        fieldSources[field] = record.source;
        took = true;
      }
    }
    if (took && !firstSource) firstSource = record.source;
    if (!chosenRepo && out.repo) chosenRepo = out.repo;
  }

  let confidence = "unknown";
  let source = firstSource;
  let candidates = null;
  if (out.repo) {
    source = fieldSources.repo;
    const record = Object.values(sources).find((item) => isPlainObject(item) && item.source === source);
    confidence = CONFIDENCES.includes(record?.confidence) ? record.confidence : "unknown";
  } else if (Array.isArray(sources?.metadata?.repoCandidates) && sources.metadata.repoCandidates.length) {
    candidates = sources.metadata.repoCandidates.slice(0, 6);
    out.repo = candidates[0];
    fieldSources.repo = sources.metadata.source;
    if (out.provider == null) {
      out.provider = "huggingface";
      fieldSources.provider = sources.metadata.source;
    }
    source = sources.metadata.source;
    confidence = "unverified";
  }

  const provenance = {
    provider: out.provider ?? null,
    transport: out.transport ?? null,
    repo: out.repo ?? null,
    revision: out.revision ?? null,
    revisionSha: out.revisionSha ?? null,
    artifactKey: out.artifactKey ?? null,
    downloadedAt: out.downloadedAt ?? null,
    downloadJobId: out.downloadJobId ?? null,
    source: source ?? null,
    confidence,
    fieldSources,
  };
  if (candidates) provenance.candidates = candidates;
  return { provenance, quant: out.quant ?? null };
}

// Walks a directory without following directory links. Files reached through
// a symbolic link (the hf cache) are stat-ed through it and flagged.
async function walkTree(root, { limit = WALK_LIMIT } = {}) {
  const files = [];
  let truncated = false;
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await walk(full, childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const stat = await fsp.stat(full);
          if (stat.isFile()) files.push({ rel: childRel, full, size: stat.size, mtimeMs: stat.mtimeMs, isLink: entry.isSymbolicLink() });
        } catch {
          // Broken link or a file that vanished mid-scan.
        }
      }
    }
  }
  await walk(root, "");
  return { files, truncated };
}

async function readSmallJson(file, maxBytes = 1024 * 1024) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > maxBytes) return { value: null, mtimeMs: stat.mtimeMs };
    const text = await fsp.readFile(file, "utf8");
    const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return { value: isPlainObject(value) ? value : null, mtimeMs: stat.mtimeMs };
  } catch {
    return { value: null, mtimeMs: 0 };
  }
}

/**
 * Bytes of the regular files under `root`. Links are not followed, so the
 * blobs of a Hugging Face cache count once, and a vanished file counts zero.
 */
async function dirBytes(root) {
  let total = 0;
  async function walk(dir) {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of list) {
      const full = path.join(dir, item.name);
      try {
        if (item.isDirectory()) await walk(full);
        else if (item.isFile()) total += (await fsp.stat(full)).size;
      } catch {
        // A file that changes while it is counted is skipped.
      }
    }
  }
  await walk(root);
  return total;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// sha256 of one file in a worker thread, so hashing a large weight file never
// holds the entry's event loop (03 §3, F11). HUB-6's verify pipeline can
// replace it through options.hashFile.
const HASH_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const crypto = require("node:crypto");
const fs = require("node:fs");
const hash = crypto.createHash("sha256");
let done = 0;
let reported = 0;
let result = null;
const stream = fs.createReadStream(workerData.file, { highWaterMark: 4 * 1024 * 1024 });
stream.on("data", (chunk) => {
  hash.update(chunk);
  done += chunk.length;
  if (done - reported >= 64 * 1024 * 1024) {
    reported = done;
    parentPort.postMessage({ type: "progress", done });
  }
});
stream.on("error", (error) => { result = { type: "error", code: error.code || "error", message: error.message }; });
stream.on("end", () => { result = { type: "done", sha256: hash.digest("hex"), bytes: done }; });
// end means the bytes were read, not that Windows released the file handle.
stream.on("close", () => parentPort.postMessage(result || { type: "error", code: "ERR_STREAM_PREMATURE_CLOSE", message: "Hash stream closed before EOF." }));
`;

function hashFileInWorker(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(HASH_WORKER_SOURCE, { eval: true, workerData: { file } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      // Import may rename/remove this file as soon as hashing settles. Wait
      // for the worker's cleanup on both success and failure before it can.
      worker.terminate().catch(() => {}).then(() => fn(value));
    };
    worker.on("message", (message) => {
      if (message.type === "progress") onProgress?.(message.done);
      else if (message.type === "done") finish(resolve, message.sha256);
      else if (message.type === "error") finish(reject, Object.assign(new Error(message.message), { code: message.code }));
    });
    worker.on("error", (error) => finish(reject, error));
    worker.on("exit", (code) => finish(reject, new Error(`hash worker exited with code ${code}`)));
  });
}

// Absolute paths in a text, for the viewer copies and the stored issues.
function scrubPaths(text) {
  return String(text ?? "").replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:[\w.-]+\/){2,})[^\s"'<>|]*/g, "<path>");
}

// --- the registry ---------------------------------------------------------------

/**
 * createLibrary({ store, modelStorage, fsStore, hfHome, fit, models, providers,
 * events, getSettings, aiRoot, ledgerFiles, migrationsDir, hashFile, clock,
 * logger, watchMs, enqueue, getJobs, getBusyPaths, disk }) → Library (03 §3.1).
 *
 * `store` is the hub store (library.json). `modelStorage` is required;
 * `fsStore`, `fit`, `models` and `providers` are optional and degrade
 * quietly: no card or compatibility without `models`, no online confirmation
 * without `providers`. `events` receives `library` events through
 * events.publish and nothing else.
 */
function createLibrary(options = {}) {
  const store = options.store;
  const modelStorage = options.modelStorage;
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") throw new TypeError("createLibrary needs the hub store");
  if (!modelStorage || typeof modelStorage.roots !== "function" || typeof modelStorage.snapshot !== "function") throw new TypeError("createLibrary needs modelStorage");
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const logger = options.logger || console;
  const hfHome = path.resolve(String(options.hfHome || ""));
  const events = options.events || null;
  const fit = options.fit || null;
  const models = options.models || null;
  const providers = options.providers || null;
  const fsStore = options.fsStore || null;
  const getSettings = typeof options.getSettings === "function" ? options.getSettings : () => ({});
  const hashFile = typeof options.hashFile === "function" ? options.hashFile : hashFileInWorker;
  const aiRoot = options.aiRoot ? path.resolve(String(options.aiRoot)) : null;
  const ledgerFiles = Array.isArray(options.ledgerFiles)
    ? options.ledgerFiles
    : aiRoot ? ["vllm-manager", "llama-manager"].map((name) => path.join(aiRoot, name, "logs", "jobs-ledger.json")) : [];
  const migrationsDir = options.migrationsDir || (modelStorage.file ? path.join(path.dirname(modelStorage.file), "model-migrations") : null);
  const watchMs = Number.isFinite(Number(options.watchMs)) ? Number(options.watchMs) : STORAGE_WATCH_MS;
  // The actions of 03 §9.5. enqueue(input, ctx) is the hub's (update needs
  // it); getJobs() lists the queue's live jobs and getBusyPaths() is the
  // storage probe (running containers, migration locks); disk measures the
  // drive for an import. Each is optional and the action degrades safely.
  const enqueue = typeof options.enqueue === "function" ? options.enqueue : null;
  const getJobs = typeof options.getJobs === "function" ? options.getJobs : () => [];
  const getBusyPaths = typeof options.getBusyPaths === "function" ? options.getBusyPaths : null;
  const disk = options.disk && typeof options.disk.freeBytes === "function" ? options.disk : null;

  let entries = [];
  let scannedAt = null;
  let loadErrors = [];
  let started = false;
  let stopped = false;
  let scanChain = Promise.resolve();
  let watchTimer = null;
  let lastStorageMtime = null;
  const tasks = new Map();
  const verifyChains = new Map();
  const pendingJobs = new Map();
  const backgroundWork = new Set();

  function warn(line) {
    try {
      (typeof logger?.warn === "function" ? logger.warn : console.warn).call(logger, redactSecrets(String(line)));
    } catch {
      // Logging never breaks the registry.
    }
  }

  function nowIso() {
    return iso(clock.now());
  }

  function emit(payload) {
    if (!events || typeof events.publish !== "function") return;
    try {
      events.publish("library", payload);
    } catch (error) {
      warn(`library: publishing an event failed: ${error?.message || error}`);
    }
  }

  function emitChanged(ids) {
    const unique = [...new Set(ids)].slice(0, EVENT_IDS_CAP);
    if (unique.length) emit({ kind: "changed", entryIds: unique });
  }

  // --- persistence ---

  function persistedDocument() {
    return { schemaVersion: LIBRARY_SCHEMA_VERSION, scannedAt, entries };
  }

  function persist() {
    return store.write("library", persistedDocument()).catch((error) => {
      warn(`library: library.json could not be written: ${error?.message || error}`);
    });
  }

  function load() {
    const result = store.read("library");
    loadErrors = [];
    entries = [];
    if (result.error) {
      try {
        fs.copyFileSync(result.file, `${result.file}.corrupt`);
      } catch {
        // The original stays where it is until the next write.
      }
      loadErrors.push({ file: result.file, name: "library.json", code: result.error.code, message: `${result.error.message} It was copied to library.json.corrupt and the library starts empty until the next scan.` });
      return;
    }
    if (!result.exists) return;
    const list = Array.isArray(result.value.entries) ? result.value.entries : [];
    entries = list.filter((item) => isPlainObject(item) && ID_RE.test(String(item.id)) && typeof item.path === "string").map((item) => {
      const internal = isPlainObject(item.internal) ? item.internal : {};
      return {
        ...item,
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        aliasDisplay: Array.isArray(item.aliasDisplay) ? item.aliasDisplay : [],
        duplicates: Array.isArray(item.duplicates) ? item.duplicates : [],
        previousIds: Array.isArray(item.previousIds) ? item.previousIds : [],
        files: Array.isArray(item.files) ? item.files : [],
        provenance: isPlainObject(item.provenance) ? item.provenance : deriveProvenance({}).provenance,
        verification: isPlainObject(item.verification) ? item.verification : { status: "unchecked", checksum: "none", checkedAt: null, issues: [] },
        internal: { ...internal, sources: isPlainObject(internal.sources) ? internal.sources : {} },
      };
    });
    scannedAt = typeof result.value.scannedAt === "string" ? result.value.scannedAt : null;
  }

  // --- legacy sources, read once per scan ---

  async function readJsonLimited(file) {
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
      const text = await fsp.readFile(file, "utf8");
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return null;
    }
  }

  // Download jobs of both managers' ledgers, as { localDir, job }.
  async function readLedgerJobs() {
    const out = [];
    for (const file of ledgerFiles) {
      const data = await readJsonLimited(file);
      const jobs = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
      for (const job of jobs) {
        if (!isPlainObject(job) || job.type !== "download" || !isPlainObject(job.meta)) continue;
        const localDir = typeof job.meta.localDir === "string" && path.isAbsolute(job.meta.localDir) ? job.meta.localDir : null;
        if (localDir) out.push({ localDir, job });
      }
    }
    return out;
  }

  // Completed migrations, as { source, target }; used for ledger paths that
  // an alias no longer maps (03 §9.3 step 3).
  async function readMigrationRecords() {
    if (!migrationsDir) return [];
    let names = [];
    try {
      names = await fsp.readdir(migrationsDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const record = await readJsonLimited(path.join(migrationsDir, name));
      if (isPlainObject(record) && typeof record.source === "string" && typeof record.target === "string" && ["completed", "cleaning", "cleanup_failed"].includes(record.state)) {
        out.push({ source: path.resolve(record.source), target: path.resolve(record.target) });
      }
    }
    return out;
  }

  function buildLedgerIndex(ledgerJobs, migrations) {
    const index = new Map();
    for (const item of ledgerJobs) {
      let mapped = path.resolve(item.localDir);
      let via = null;
      try {
        const followed = modelStorage.followAliases(item.localDir);
        if (pathKey(followed) !== pathKey(item.localDir)) {
          mapped = followed;
          via = "alias";
        }
      } catch {
        // An alias loop: the path is used as written.
      }
      if (!via) {
        const migration = migrations.find((record) => containsPath(record.source, item.localDir));
        if (migration) {
          mapped = path.join(migration.target, path.relative(migration.source, path.resolve(item.localDir)));
          via = "migration";
        }
      }
      const key = pathKey(mapped);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ job: item.job, via });
    }
    return index;
  }

  function ledgerRecord(hits) {
    if (!hits?.length) return null;
    const stamp = (hit) => Date.parse(hit.job.finishedAt || hit.job.updatedAt || hit.job.createdAt || "") || 0;
    const ranked = [...hits].sort((a, b) => (b.job.status === "success") - (a.job.status === "success") || stamp(b) - stamp(a));
    for (const hit of ranked) {
      const meta = hit.job.meta;
      const repo = cleanRepo(meta.model);
      const provider = namespaceOf(meta.source);
      if (!repo || !provider) continue;
      return {
        source: hit.via === "migration" ? "migration-record" : "legacy-ledger",
        confidence: "declared",
        fields: {
          provider,
          transport: String(meta.source || provider),
          repo,
          downloadedAt: hit.job.finishedAt || hit.job.updatedAt || null,
          quant: String(meta.precision || "").trim() || null,
        },
      };
    }
    return null;
  }

  // --- candidates ---

  async function candidatesFromRoots(snapshot, rootIds) {
    const wanted = (id) => !rootIds || rootIds.includes(id);
    const candidates = [];
    const scannedRoots = new Set();
    const offlineRoots = new Set();
    {
      for (const root of snapshot.roots) {
        if (!wanted(root.id)) continue;
        let stat = null;
        try {
          stat = await fsp.stat(root.path);
        } catch {
          stat = null;
        }
        if (!stat?.isDirectory()) {
          offlineRoots.add(root.id);
          continue;
        }
        scannedRoots.add(root.id);
        const base = { rootId: root.id, rootLabel: root.label || path.basename(root.path), rootPath: root.path, volume: volumeOf(root.path) };
        if (root.mode === "model") {
          if (!modelStorage.isRetired(root.path)) {
            candidates.push({ ...base, kind: "folder", path: path.resolve(root.path), relativePath: path.basename(root.path) });
          }
          continue;
        }
        let children = [];
        try {
          children = await fsp.readdir(root.path, { withFileTypes: true });
        } catch {
          offlineRoots.add(root.id);
          scannedRoots.delete(root.id);
          continue;
        }
        for (const child of children) {
          if (child.name.startsWith(".")) continue;
          const full = path.join(root.path, child.name);
          if (modelStorage.isRetired(full)) continue;
          if (child.isDirectory()) candidates.push({ ...base, kind: "folder", path: full, relativePath: child.name });
          else if (child.isFile() && /\.gguf$/i.test(child.name)) candidates.push({ ...base, kind: "single-file", path: full, relativePath: child.name });
        }
      }

      const caches = { hf: false, ms: false };
      if (wanted(HF_CACHE_ROOT_ID)) {
        caches.hf = true;
        const hubDir = path.join(hfHome, "hub");
        let names = [];
        try {
          names = await fsp.readdir(hubDir, { withFileTypes: true });
        } catch {
          names = [];
        }
        for (const child of names) {
          if (!child.isDirectory() || !child.name.startsWith("models--")) continue;
          const body = child.name.slice("models--".length);
          const split = body.indexOf("--");
          const repo = split > 0 ? cleanRepo(`${body.slice(0, split)}/${body.slice(split + 2)}`) : null;
          if (!repo) continue;
          candidates.push({
            kind: "hf-cache-repo", path: path.join(hubDir, child.name), relativePath: child.name, rootId: null, rootLabel: HF_CACHE_LABEL,
            rootPath: null, volume: volumeOf(hubDir), cacheRepo: repo, cacheProvider: "huggingface",
          });
        }
      }
      if (wanted(MS_CACHE_ROOT_ID)) {
        caches.ms = true;
        for (const sub of [["modelscope", "models"], ["modelscope", "hub", "models"]]) {
          const base = path.join(hfHome, ...sub);
          let owners = [];
          try {
            owners = await fsp.readdir(base, { withFileTypes: true });
          } catch {
            owners = [];
          }
          for (const owner of owners) {
            if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
            let repos = [];
            try {
              repos = await fsp.readdir(path.join(base, owner.name), { withFileTypes: true });
            } catch {
              repos = [];
            }
            for (const child of repos) {
              if (!child.isDirectory() || child.name.startsWith(".")) continue;
              const repo = cleanRepo(`${owner.name}/${child.name.replace(/___/g, ".")}`);
              if (!repo) continue;
              candidates.push({
                kind: "modelscope-cache", path: path.join(base, owner.name, child.name), relativePath: `${owner.name}/${child.name}`, rootId: null,
                rootLabel: MS_CACHE_LABEL, rootPath: null, volume: volumeOf(base), cacheRepo: repo, cacheProvider: "modelscope",
              });
            }
          }
        }
      }
      return { candidates, scannedRoots, offlineRoots, caches };
    }
  }

  // The root and relative name of a path inside a registered root, for
  // registerFromJob. Only a folder directly in a library root (or a model
  // root itself) is a library candidate.
  function candidateForPath(value, snapshot) {
    const target = path.resolve(String(value));
    for (const root of snapshot.roots) {
      const base = { rootId: root.id, rootLabel: root.label || path.basename(root.path), rootPath: root.path, volume: volumeOf(root.path) };
      if (root.mode === "model" && pathKey(root.path) === pathKey(target)) return { ...base, kind: "folder", path: target, relativePath: path.basename(root.path) };
      if (root.mode !== "model" && pathKey(path.dirname(target)) === pathKey(root.path)) return { ...base, kind: "folder", path: target, relativePath: path.basename(target) };
    }
    return null;
  }

  // --- scanning one candidate ---

  async function hfCacheDetail(candidate) {
    const repoDir = candidate.path;
    const refs = {};
    const refsDir = path.join(repoDir, "refs");
    const refWalk = await walkTree(refsDir);
    for (const file of refWalk.files) {
      try {
        const sha = cleanSha(await fsp.readFile(file.full, "utf8"));
        if (sha) refs[file.rel] = sha;
      } catch {
        // An unreadable ref is skipped.
      }
    }
    const snapshotsDir = path.join(repoDir, "snapshots");
    let names = [];
    try {
      names = (await fsp.readdir(snapshotsDir, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name);
    } catch {
      names = [];
    }
    const snapshots = [];
    for (const sha of names.sort()) {
      const tree = await walkTree(path.join(snapshotsDir, sha));
      snapshots.push({ sha, files: tree.files.length, bytes: tree.files.reduce((sum, file) => sum + file.size, 0), tree, mtimeMs: maxOf(tree.files.map((file) => file.mtimeMs)) });
    }
    let current = snapshots.find((item) => item.sha === refs.main);
    if (!current) current = [...snapshots].sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
    const blobTree = await walkTree(path.join(repoDir, "blobs"));
    const copied = snapshots.flatMap((item) => item.tree.files.filter((file) => !file.isLink));
    const bytes = [...blobTree.files, ...copied].reduce((sum, file) => sum + file.size, 0);
    return { refs, snapshots, current, bytes, refsSignature: JSON.stringify(refs) };
  }

  async function cacheFileHashes(snapshotDir, files) {
    const out = new Map();
    await mapLimit(files.filter((file) => file.isLink), METADATA_READ_CONCURRENCY, async (file) => {
      try {
        const target = await fsp.readlink(file.full);
        const hashes = hashesFromEtag(path.basename(target));
        if (hashes) out.set(file.rel, hashes);
      } catch {
        // Not a link we can read: the file simply has no known hash.
      }
    });
    return out;
  }

  async function readMetadataHashes(dir, payload, treeSet) {
    const found = new Map();
    const revisions = new Map();
    await mapLimit(payload, METADATA_READ_CONCURRENCY, async (file) => {
      const rel = `.cache/huggingface/download/${file.rel}.metadata`;
      if (!treeSet.has(rel)) return;
      try {
        const full = path.join(dir, ...rel.split("/"));
        const stat = await fsp.stat(full);
        if (stat.size > 4096) return;
        const [commit, etag] = (await fsp.readFile(full, "utf8")).split(/\r?\n/);
        const sha = cleanSha(commit);
        if (sha) revisions.set(sha, (revisions.get(sha) || 0) + 1);
        const hashes = hashesFromEtag(etag);
        if (hashes) found.set(file.rel, hashes);
      } catch {
        // A torn metadata file is ignored.
      }
    });
    const ranked = [...revisions.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return { hashes: found, revisionSha: ranked[0]?.[0] || null };
  }

  function markerRecord(marker) {
    if (!isPlainObject(marker)) return null;
    const repo = cleanRepo(marker.model);
    const sourceName = String(marker.source || "");
    const provider = namespaceOf(marker.provider || sourceName);
    if (!repo && !provider) return null;
    return {
      source: "platform-marker",
      confidence: "declared",
      fields: {
        provider,
        transport: String(marker.transport || sourceName || provider || "") || null,
        repo,
        revision: marker.revision ? String(marker.revision) : null,
        revisionSha: cleanSha(marker.revisionSha),
        artifactKey: marker.artifactKey ? String(marker.artifactKey) : null,
        downloadedAt: marker.completedAt || marker.createdAt || null,
        downloadJobId: marker.jobId ? String(marker.jobId) : null,
        quant: String(marker.precision || "").trim() || null,
      },
    };
  }

  // The declared per-file hashes of the highest sources, only where the
  // recorded size matches the file on disk.
  function declaredHashes(sourceFiles, byPath) {
    const out = new Map();
    for (const item of Array.isArray(sourceFiles) ? sourceFiles : []) {
      if (!isPlainObject(item) || typeof item.path !== "string") continue;
      const file = byPath.get(item.path);
      if (!file || (Number.isFinite(Number(item.size)) && Number(item.size) !== file.size)) continue;
      const sha256 = SHA256_RE.test(String(item.sha256 || "")) ? String(item.sha256).toLowerCase() : null;
      const gitOid = GIT_OID_RE.test(String(item.gitOid || "")) ? String(item.gitOid).toLowerCase() : null;
      if (sha256 || gitOid) out.set(item.path, { sha256, gitOid });
    }
    return out;
  }

  async function readCard(candidate, snapshotDir) {
    const empty = { cardId: null, role: null, familyId: null, compatibility: [] };
    if (!models || typeof models.inspectLocal !== "function") return { card: empty, runnable: null };
    try {
      const target = candidate.kind === "hf-cache-repo" ? snapshotDir : candidate.path;
      if (!target) return { card: empty, runnable: null };
      const raw = await models.inspectLocal(target, { depth: "quick" });
      let compatibility = [];
      if (fit && typeof fit.compatibilityFor === "function") {
        try {
          const rows = await fit.compatibilityFor(raw);
          compatibility = (Array.isArray(rows) ? rows : []).map((row) => ({ engineId: row.engineId ?? null, runtimeId: row.runtimeId ?? null, verdict: row.verdict ?? null }));
        } catch {
          compatibility = [];
        }
      }
      const role = raw?.role?.value ?? null;
      return {
        card: { cardId: raw?.cardId ?? null, role, familyId: raw?.identity?.familyId ?? null, compatibility },
        runnable: typeof raw?.role?.runnable === "boolean" ? raw.role.runnable : null,
      };
    } catch {
      return { card: empty, runnable: null };
    }
  }

  async function configOf(dir, payload) {
    const file = payload.find((item) => item.rel.toLowerCase() === "config.json");
    if (!file) return null;
    return (await readSmallJson(path.join(dir, file.rel))).value;
  }

  // Builds the entry for one candidate; `previous` is the registry's earlier
  // entry for it, `world` the per-scan lookups. Returns null when the folder
  // is not a model.
  async function inspectCandidate(candidate, previous, world) {
    let tree;
    let cache = null;
    let contentDir = candidate.path;
    let dirMtimeMs = 0;
    try {
      dirMtimeMs = (await fsp.stat(candidate.path)).mtimeMs;
    } catch {
      return null;
    }
    if (candidate.kind === "single-file") {
      const stat = await fsp.stat(candidate.path);
      tree = { files: [{ rel: path.basename(candidate.path), full: candidate.path, size: stat.size, mtimeMs: stat.mtimeMs, isLink: false }], truncated: false };
      contentDir = path.dirname(candidate.path);
    } else if (candidate.kind === "hf-cache-repo") {
      cache = await hfCacheDetail(candidate);
      if (!cache.current) return null;
      contentDir = path.join(candidate.path, "snapshots", cache.current.sha);
      tree = cache.current.tree;
    } else {
      tree = await walkTree(candidate.path);
    }

    const classified = tree.files.map((file) => ({ ...file, role: candidate.kind === "single-file" ? "payload" : classifyFile(file.rel) }));
    const payload = classified.filter((file) => file.role === "payload");
    const incomplete = classified.filter((file) => file.role === "incomplete");
    const weights = payload.filter((file) => WEIGHT_RE.test(file.rel)).map((file) => ({ path: file.rel, size: file.size }));
    const hasConfig = payload.some((file) => file.rel.toLowerCase() === "config.json");
    let toolingOnly = false;
    if (!weights.length && !hasConfig) {
      if (payload.some((file) => SCRIPT_RE.test(file.rel))) toolingOnly = true;
      else return null;
    }

    const markerFile = candidate.kind === "single-file" || candidate.kind === "hf-cache-repo" ? { value: null, mtimeMs: 0 } : await readSmallJson(path.join(candidate.path, ".platform-download.json"));
    const maxMtime = maxOf(classified.map((file) => file.mtimeMs));
    const totalBytes = classified.reduce((sum, file) => sum + file.size, 0);
    const scanKey = [dirMtimeMs, totalBytes, classified.length, maxMtime, markerFile.mtimeMs, cache ? `${cache.current.sha}:${cache.refsSignature}:${cache.snapshots.map((item) => `${item.sha}.${item.files}.${item.bytes}`).join(",")}` : ""].join("|");
    const reuse = Boolean(previous && previous.kind === candidate.kind && previous.internal?.scanKey === scanKey && Array.isArray(previous.files));

    const job = pendingJobs.get(pathKey(candidate.path)) || previous?.internal?.sources?.job || null;
    const byPath = new Map(payload.map((file) => [file.rel, file]));

    let files;
    let metadata = null;
    let filesTruncated = false;
    if (reuse) {
      files = previous.files;
      filesTruncated = Boolean(previous.filesTruncated);
      metadata = previous.internal.sources?.metadata || null;
    } else {
      const treeSet = new Set(tree.files.map((file) => file.rel));
      const read = cache ? { hashes: await cacheFileHashes(contentDir, payload), revisionSha: null } : await readMetadataHashes(candidate.path, payload, treeSet);
      const fromJob = declaredHashes(job?.files, byPath);
      const fromMarker = declaredHashes(markerFile.value?.files, byPath);
      const sorted = [...payload].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      filesTruncated = sorted.length > FILES_CAP;
      files = sorted.slice(0, FILES_CAP).map((file) => {
        const hashes = fromJob.get(file.rel) || fromMarker.get(file.rel) || read.hashes.get(file.rel) || null;
        const prevFile = previous?.files?.find((item) => item.path === file.rel);
        return {
          path: file.rel,
          size: file.size,
          sha256: hashes?.sha256 ?? null,
          gitOid: hashes?.gitOid ?? null,
          verifiedAt: prevFile && prevFile.size === file.size && prevFile.sha256 === (hashes?.sha256 ?? null) ? prevFile.verifiedAt ?? null : null,
        };
      });
      // hf metadata exists only in a folder the hf CLI wrote. It names no repo,
      // so the folder name supplies guesses that stay "unverified" until the
      // hub confirms one (03 §9.3 step 4).
      metadata = candidate.kind === "folder" && (read.revisionSha || read.hashes.size)
        ? { source: "hf-local-metadata", confidence: "unverified", fields: { provider: "huggingface", revisionSha: read.revisionSha }, repoCandidates: repoCandidatesFromName(path.basename(candidate.path)) }
        : null;
    }

    const ledgerHits = world.ledgerIndex.get(pathKey(candidate.path));
    const sources = {
      user: previous?.internal?.sources?.user || null,
      job,
      marker: markerRecord(markerFile.value),
      ledger: ledgerRecord(ledgerHits),
      metadata,
      cache: candidate.cacheRepo
        ? {
          source: "hf-cache-refs",
          confidence: "declared",
          fields: {
            provider: candidate.cacheProvider,
            transport: candidate.cacheProvider,
            repo: candidate.cacheRepo,
            revision: cache ? (cache.refs.main === cache.current.sha ? "main" : (Object.entries(cache.refs).find(([, sha]) => sha === cache.current.sha)?.[0] || null)) : null,
            revisionSha: cache ? cache.current.sha : null,
          },
        }
        : null,
    };
    const { provenance, quant: sourceQuant } = deriveProvenance(sources);

    const format = toolingOnly ? null : detectFormat(weights);
    let detectedQuant = null;
    if (format === "gguf") detectedQuant = ggufQuantFromPaths(weights);
    else if (format) detectedQuant = quantFromConfig(await configOf(contentDir, payload)) || quantFromName(path.basename(candidate.path)) || null;
    const quant = sourceQuant || detectedQuant;

    const filesetHash = computeFilesetHash(files);
    const confident = provenance.repo && (provenance.confidence === "declared" || provenance.confidence === "detected");
    const displayName = confident ? provenance.repo.split("/")[1] : (candidate.kind === "hf-cache-repo" ? candidate.cacheRepo.split("/")[1] : path.basename(candidate.path));

    let cardPart = { card: previous?.card || { cardId: null, role: null, familyId: null, compatibility: [] }, runnable: null };
    if (!reuse || !previous?.card?.cardId) cardPart = await readCard(candidate, cache ? contentDir : null);
    const role = toolingOnly ? "tooling-only" : cardPart.card.role;
    const card = { ...cardPart.card, role };
    // A verification judges the files it saw; changed files start unchecked.
    const verification = reuse && previous.verification ? previous.verification : { status: "unchecked", checksum: "none", checkedAt: null, issues: [] };
    const cardRunnable = reuse && previous?.card?.cardId ? previous.internal?.cardRunnable ?? null : cardPart.runnable;

    const mtime = iso(Math.max(dirMtimeMs, maxMtime));
    const entry = {
      id: previous?.id || null,
      kind: candidate.kind,
      path: candidate.path,
      relativePath: candidate.relativePath,
      displayPath: `${candidate.rootLabel}/${candidate.relativePath}`,
      rootId: candidate.rootId,
      rootLabel: candidate.rootLabel,
      volume: candidate.volume,
      aliases: [],
      aliasDisplay: [],
      displayName,
      format,
      quant,
      bytes: cache ? cache.bytes : totalBytes,
      fileCount: payload.length,
      filesTruncated,
      mtime,
      runnable: computeRunnable(role, cardRunnable, verification.status),
      provenance,
      files,
      filesetHash,
      identityKey: identityKeyFor(provenance, filesetHash),
      verification,
      residue: { incompleteFiles: incomplete.length, incompleteBytes: incomplete.reduce((sum, file) => sum + file.size, 0) },
      update: previous?.update && previous.provenance?.revisionSha === provenance.revisionSha
        ? previous.update
        : { status: "unknown", remoteSha: null, changedFiles: 0, bytesToDownload: 0, checkedAt: null },
      card,
      ...(cache ? { cache: { currentSha: cache.current.sha, refs: cache.refs, snapshots: cache.snapshots.map((item) => ({ sha: item.sha, files: item.files, bytes: item.bytes })) } } : {}),
      duplicates: [],
      lastLaunchedAt: previous?.lastLaunchedAt ?? null,
      lastFailure: previous?.lastFailure ?? null,
      previousIds: previous?.previousIds || [],
      createdAt: previous?.createdAt || nowIso(),
      scannedAt: nowIso(),
      internal: { scanKey, sources, cardRunnable },
    };
    return entry;
  }

  // --- aliases ---

  // Paths an entry used to live at, from the alias table (A→B→C chains) and
  // what the registry remembered.
  function aliasPathsFor(entryPath, aliases, remembered) {
    const out = new Map();
    const add = (value) => {
      const key = pathKey(value);
      if (key !== pathKey(entryPath) && !out.has(key)) out.set(key, path.resolve(value));
    };
    for (const value of remembered || []) add(value);
    const frontier = [path.resolve(entryPath)];
    for (let depth = 0; depth < 8 && frontier.length; depth += 1) {
      const current = frontier.shift();
      for (const alias of aliases) {
        if (containsPath(alias.to, current)) {
          const old = path.join(alias.from, path.relative(alias.to, current));
          add(old);
          frontier.push(old);
        }
      }
    }
    return [...out.values()];
  }

  function displayForPath(value, snapshot) {
    const target = path.resolve(value);
    const root = snapshot.roots
      .filter((item) => containsPath(item.path, target))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) return `(moved)/${path.basename(target)}`;
    const relative = toPosix(path.relative(root.path, target)) || path.basename(root.path);
    return `${root.label || path.basename(root.path)}/${relative}`;
  }

  // --- duplicates ---

  function isWeight(file) {
    return WEIGHT_RE.test(file.path);
  }

  function linkDuplicates(list) {
    const groups = new Map();
    const add = (key, entry) => {
      if (!key) return;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(entry.id);
    };
    for (const entry of list) {
      add(entry.identityKey ? `id:${entry.identityKey}` : null, entry);
      const weights = (entry.files || []).filter(isWeight);
      if (weights.length && weights.every((file) => file.sha256)) add(`fs:${entry.filesetHash}`, entry);
    }
    const linked = new Map(list.map((entry) => [entry.id, new Set()]));
    for (const ids of groups.values()) {
      if (ids.size < 2) continue;
      for (const id of ids) for (const other of ids) if (other !== id) linked.get(id).add(other);
    }
    for (const entry of list) entry.duplicates = [...linked.get(entry.id)].sort();
  }

  // --- scan ---

  /**
   * One scan. `rootIds` limits it (storage root ids, "hf-cache",
   * "modelscope-cache"); `onlyCandidates` scans just those candidates and
   * removes nothing. Scans never overlap.
   */
  function runScan({ rootIds = null, onlyCandidates = null, onProgress = () => {} } = {}) {
    const run = scanChain.then(() => doScan({ rootIds, onlyCandidates, onProgress }));
    scanChain = run.catch(() => {});
    return run;
  }

  async function doScan({ rootIds, onlyCandidates, onProgress }) {
    const snapshot = await modelStorage.snapshot();
    const aliases = Array.isArray(snapshot.aliases) ? snapshot.aliases : [];
    const world = { ledgerIndex: buildLedgerIndex(await readLedgerJobs(), await readMigrationRecords()) };
    let found;
    if (onlyCandidates) {
      found = { candidates: onlyCandidates, scannedRoots: new Set(), offlineRoots: new Set(), caches: { hf: false, ms: false } };
    } else {
      found = await candidatesFromRoots(snapshot, rootIds);
    }
    const { candidates } = found;

    // Which earlier entry each candidate continues (03 §9.2): same path, an
    // alias of it, or an entry that remembered the path. The earliest entry
    // wins; the others' ids are kept in previousIds.
    const candidateKeys = new Map(candidates.map((candidate) => [pathKey(candidate.path), candidate]));
    const claims = new Map();
    const claim = (candidateKey, entry, rank) => {
      if (!claims.has(candidateKey)) claims.set(candidateKey, []);
      claims.get(candidateKey).push({ entry, rank });
    };
    for (const entry of entries) {
      const ownKey = pathKey(entry.path);
      if (candidateKeys.has(ownKey)) {
        claim(ownKey, entry, 0);
        continue;
      }
      let followedKey = ownKey;
      try {
        followedKey = pathKey(modelStorage.followAliases(entry.path));
      } catch {
        followedKey = ownKey;
      }
      if (followedKey !== ownKey && candidateKeys.has(followedKey)) {
        claim(followedKey, entry, 1);
        continue;
      }
      const remembered = (entry.aliases || []).map((value) => pathKey(value)).find((key) => candidateKeys.has(key));
      if (remembered) claim(remembered, entry, 2);
    }
    const survivors = new Map();
    const absorbed = new Set();
    for (const [key, list] of claims) {
      list.sort((a, b) => a.rank - b.rank || String(a.entry.createdAt).localeCompare(String(b.entry.createdAt)));
      survivors.set(key, list[0].entry);
      for (const other of list.slice(1)) absorbed.add(other.entry.id);
    }

    const usedIds = new Set(entries.map((entry) => entry.id));
    const results = new Map();
    let done = 0;
    onProgress({ done: 0, total: candidates.length });
    await mapLimit(candidates, SCAN_CONCURRENCY, async (candidate) => {
      const key = pathKey(candidate.path);
      const previous = survivors.get(key) || null;
      try {
        const entry = await inspectCandidate(candidate, previous, world);
        pendingJobs.delete(key);
        if (entry) {
          if (!entry.id) {
            do {
              entry.id = newId("lib");
            } while (usedIds.has(entry.id));
            usedIds.add(entry.id);
          }
          const lost = (claims.get(key) || []).filter((item) => item.entry !== previous).map((item) => item.entry.id);
          entry.previousIds = [...new Set([...(entry.previousIds || []), ...lost])];
          const remembered = [...(previous?.aliases || []), ...(claims.get(key) || []).flatMap((item) => [item.entry.path, ...(item.entry.aliases || [])])];
          entry.aliases = aliasPathsFor(candidate.path, aliases, remembered);
          entry.aliasDisplay = entry.aliases.map((value) => displayForPath(value, snapshot));
          results.set(key, entry);
        }
      } catch (error) {
        warn(`library: scanning ${candidate.relativePath} failed: ${error?.message || error}`);
        if (previous) results.set(key, previous);
      }
      done += 1;
      onProgress({ done, total: candidates.length });
    });

    // Earlier entries nothing continued: keep what this scan cannot judge.
    const keep = [];
    const claimedIds = new Set([...claims.values()].flat().map((item) => item.entry.id));
    for (const entry of entries) {
      if (claimedIds.has(entry.id) || absorbed.has(entry.id)) continue;
      if (onlyCandidates) {
        keep.push(entry);
        continue;
      }
      let moved = null;
      try {
        moved = modelStorage.followAliases(entry.path);
      } catch {
        moved = null;
      }
      const retired = moved && pathKey(moved) !== pathKey(entry.path);
      const isCache = entry.kind === "hf-cache-repo" || entry.kind === "modelscope-cache";
      let covered;
      if (isCache) covered = entry.kind === "hf-cache-repo" ? found.caches.hf : found.caches.ms;
      else if (retired) covered = snapshot.roots.some((root) => found.scannedRoots.has(root.id) && containsPath(root.path, moved));
      else {
        const root = snapshot.roots.filter((item) => containsPath(item.path, entry.path)).sort((a, b) => b.path.length - a.path.length)[0];
        covered = Boolean(root) && found.scannedRoots.has(root.id);
      }
      if (!covered) keep.push(entry);
    }

    const before = new Map(entries.map((entry) => [entry.id, entry]));
    const next = [...keep, ...results.values()];
    linkDuplicates(next);
    next.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));

    const changedIds = [];
    for (const entry of next) {
      const old = before.get(entry.id);
      if (!old || JSON.stringify(stripScanTime(old)) !== JSON.stringify(stripScanTime(entry))) changedIds.push(entry.id);
    }
    const nextIds = new Set(next.map((entry) => entry.id));
    const removedIds = entries.filter((entry) => !nextIds.has(entry.id)).map((entry) => entry.id);
    entries = next;
    scannedAt = nowIso();
    await persist();
    emitChanged([...changedIds, ...removedIds]);
    return { total: next.length, added: changedIds.filter((id) => !before.has(id)).length, changed: changedIds.filter((id) => before.has(id)).length, removed: removedIds.length };
  }

  function stripScanTime(entry) {
    const { scannedAt: _scannedAt, ...rest } = entry;
    return rest;
  }

  // --- tasks ---

  function newTask(kind, entryId = null) {
    const stamp = nowIso();
    const task = { id: newId("tsk"), kind, entryId, state: "queued", progress: { done: 0, total: 0, unit: "files" }, error: null, result: null, createdAt: stamp, updatedAt: stamp };
    tasks.set(task.id, task);
    const done = [...tasks.values()].filter((item) => item.state === "succeeded" || item.state === "failed");
    for (const old of done.slice(0, Math.max(0, done.length - TASK_KEEP))) tasks.delete(old.id);
    return task;
  }

  function publicTask(task) {
    const { key: _key, lastAnnounce: _lastAnnounce, ...rest } = task;
    return JSON.parse(JSON.stringify(rest));
  }

  function touchTask(task, patch, { announce = true } = {}) {
    Object.assign(task, patch, { updatedAt: nowIso() });
    if (announce) emit({ kind: "task", task: publicTask(task) });
  }

  function runTask(task, work) {
    const progress = (value) => {
      const stamp = clock.now();
      const terminal = value.total > 0 && value.done >= value.total;
      task.progress = { ...task.progress, ...value };
      task.updatedAt = iso(stamp);
      if (terminal || !task.lastAnnounce || stamp - task.lastAnnounce >= 500) {
        task.lastAnnounce = stamp;
        emit({ kind: "task", task: publicTask(task) });
      }
    };
    touchTask(task, { state: "running" });
    return Promise.resolve()
      .then(() => work(progress))
      .then((result) => touchTask(task, { state: "succeeded", result: result ?? null }))
      .catch((error) => {
        warn(`library: ${task.kind} task failed: ${error?.message || error}`);
        touchTask(task, {
          state: "failed",
          error: { code: String(error?.code || "task_failed"), message: redactSecrets(String(error?.message || error)).slice(0, 300), detail: redactSecrets(String(error?.stack || error?.message || error)).slice(0, 2000) },
        });
      });
  }

  function activeTask(kind, key) {
    return [...tasks.values()].find((task) => task.kind === kind && (task.state === "queued" || task.state === "running") && task.key === key);
  }

  // --- public reads ---

  function toPublic(entry, { files = true } = {}) {
    const { internal: _internal, files: list, ...rest } = entry;
    return JSON.parse(JSON.stringify(files ? { ...rest, files: list } : rest));
  }

  function findEntry(id) {
    const value = String(id || "");
    return entries.find((entry) => entry.id === value) || entries.find((entry) => (entry.previousIds || []).includes(value)) || null;
  }

  function parseCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === "") return 0;
    try {
      const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
      if (Number.isInteger(value?.o) && value.o >= 0) return value.o;
    } catch {
      // Falls through to the error below.
    }
    throw new LibraryError("invalid_cursor", "The cursor is not valid.", { status: 400 });
  }

  async function rootsView() {
    const snapshot = await modelStorage.snapshot();
    const defaultId = snapshot.defaultRootId || "legacy";
    const roots = snapshot.roots.map((root) => {
      const own = entries.filter((entry) => entry.rootId === root.id);
      return {
        id: root.id,
        label: root.label || path.basename(root.path),
        path: root.path,
        mode: root.mode,
        default: root.id === defaultId,
        legacy: root.id === "legacy",
        volume: volumeOf(root.path),
        online: root.online !== false,
        entryCount: own.length,
        bytes: own.reduce((sum, entry) => sum + entry.bytes, 0),
      };
    });
    roots.sort((a, b) => Number(b.default) - Number(a.default));
    for (const [id, label, kind] of [[HF_CACHE_ROOT_ID, HF_CACHE_LABEL, "hf-cache-repo"], [MS_CACHE_ROOT_ID, MS_CACHE_LABEL, "modelscope-cache"]]) {
      const own = entries.filter((entry) => entry.kind === kind);
      if (own.length) roots.push({ id, label, path: kind === "hf-cache-repo" ? path.join(hfHome, "hub") : path.join(hfHome, "modelscope"), mode: "cache", default: false, legacy: false, volume: volumeOf(hfHome), online: true, entryCount: own.length, bytes: own.reduce((sum, entry) => sum + entry.bytes, 0) });
    }
    return roots;
  }

  /**
   * list({ q, rootId, format, provenance, duplicates, cursor, limit }) →
   * { entries, roots, nextCursor, total } (03 §13).
   */
  async function list(query = {}) {
    const offset = parseCursor(query.cursor);
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit, 10) || 200));
    const text = String(query.q || "").trim().toLowerCase();
    const rootId = String(query.rootId || "");
    const format = String(query.format || "").toLowerCase();
    const provenance = String(query.provenance || "").toLowerCase();
    if (provenance && !CONFIDENCES.includes(provenance)) throw new LibraryError("invalid_request", `provenance must be one of ${CONFIDENCES.join(", ")}.`, { status: 400 });
    const duplicatesOnly = query.duplicates === true || query.duplicates === "1" || query.duplicates === "true";
    const matches = entries.filter((entry) => {
      if (rootId) {
        const entryRoot = entry.kind === "hf-cache-repo" ? HF_CACHE_ROOT_ID : entry.kind === "modelscope-cache" ? MS_CACHE_ROOT_ID : entry.rootId;
        if (entryRoot !== rootId) return false;
      }
      if (format && String(entry.format || "").toLowerCase() !== format) return false;
      if (provenance && entry.provenance.confidence !== provenance) return false;
      if (duplicatesOnly && !entry.duplicates.length) return false;
      if (text) {
        const haystack = [entry.displayName, entry.provenance.repo, entry.relativePath, entry.quant, entry.format].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
    const page = matches.slice(offset, offset + limit).map((entry) => toPublic(entry, { files: false }));
    const next = offset + limit < matches.length ? Buffer.from(JSON.stringify({ o: offset + limit })).toString("base64url") : null;
    return { entries: page, roots: await rootsView(), nextCursor: next, total: matches.length };
  }

  function get(id) {
    const entry = findEntry(id);
    return entry ? toPublic(entry) : null;
  }

  /** The entry for an absolute path: the entry's own path, a retired alias of it, or a path inside it. */
  function findByPath(value) {
    if (!path.isAbsolute(String(value || ""))) return null;
    const raw = path.resolve(String(value));
    let target = raw;
    try {
      target = modelStorage.followAliases(raw);
    } catch {
      target = raw;
    }
    const hit = entries
      .filter((entry) => containsPath(entry.path, target) || containsPath(entry.path, raw) || (entry.aliases || []).some((alias) => containsPath(alias, raw)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return hit ? toPublic(hit) : null;
  }

  function getTask(id) {
    const task = TASK_ID_RE.test(String(id || "")) ? tasks.get(String(id)) : null;
    return task ? publicTask(task) : null;
  }

  // --- rescan ---

  /**
   * rescan({ rootIds }) → { taskId, task }. A scan that is already queued
   * for the same scope is returned instead of starting another.
   */
  async function rescan({ rootIds = null } = {}) {
    let scope = null;
    if (rootIds !== null && rootIds !== undefined) {
      if (!Array.isArray(rootIds) || rootIds.length > 50 || !rootIds.every((item) => typeof item === "string" && item)) {
        throw new LibraryError("invalid_request", "rootIds must be a list of root ids.", { status: 400 });
      }
      const snapshot = await modelStorage.snapshot();
      const known = new Set([...snapshot.roots.map((root) => root.id), HF_CACHE_ROOT_ID, MS_CACHE_ROOT_ID]);
      const unknown = rootIds.filter((item) => !known.has(item));
      if (unknown.length) throw new LibraryError("unknown_root", `Unknown library root: ${unknown[0]}.`, { status: 400, details: { rootIds: unknown } });
      scope = [...new Set(rootIds)].sort();
    }
    const key = scope ? scope.join(",") : "*";
    const existing = activeTask("rescan", key) || activeTask("rescan", "*");
    if (existing) return { taskId: existing.id, task: publicTask(existing) };
    const task = newTask("rescan");
    task.key = key;
    task.progress.unit = "candidates";
    void runTask(task, async (progress) => {
      const result = await runScan({ rootIds: scope, onProgress: progress });
      // The identifyOnline setting: confirm folder-name candidates after the
      // scan, in the background (03 §9.3 step 4).
      const background = confirmCandidatesInBackground().catch((error) => warn(`library: confirming candidates failed: ${error?.message || error}`));
      backgroundWork.add(background);
      background.finally(() => backgroundWork.delete(background));
      return result;
    });
    return { taskId: task.id, task: publicTask(task) };
  }

  // --- verify ---

  function structureStore(entry) {
    if (fsStore && entry.rootId) return { store: fsStore, localDir: entry.path };
    const dir = entry.kind === "hf-cache-repo" && entry.cache ? path.join(entry.path, "snapshots", entry.cache.currentSha) : entry.path;
    return { store: createModelFilesystemStore({ modelsRoot: dir, hfCache: hfHome }), localDir: dir };
  }

  async function structureIssues(entry) {
    const issues = [];
    const rootDir = entry.kind === "single-file" ? path.dirname(entry.path) : entry.kind === "hf-cache-repo" && entry.cache ? path.join(entry.path, "snapshots", entry.cache.currentSha) : entry.path;
    let exists = true;
    try {
      await fsp.stat(entry.path);
    } catch {
      exists = false;
    }
    if (!exists) return [{ code: "path_missing", severity: "fail", title: "The model folder is missing", detail: "", path: null }];
    const recorded = new Map(entry.files.map((file) => [file.path, file]));
    const tree = entry.kind === "single-file" ? { files: [{ rel: path.basename(entry.path), size: (await fsp.stat(entry.path)).size }] } : await walkTree(rootDir);
    const actual = new Map(tree.files.filter((file) => entry.kind === "single-file" || classifyFile(file.rel) === "payload").map((file) => [file.rel, file]));
    if (!entry.filesTruncated) {
      for (const file of recorded.values()) {
        const seen = actual.get(file.path);
        if (!seen) issues.push({ code: "file_missing", severity: "fail", title: "A file is missing", detail: file.path, path: file.path });
        else if (seen.size !== file.size) issues.push({ code: "size_mismatch", severity: "fail", title: "A file changed size", detail: `${file.path}: ${file.size} -> ${seen.size} bytes`, path: file.path });
      }
    }
    if (entry.kind !== "single-file") {
      try {
        const { store: checker, localDir } = structureStore(entry);
        const result = await checker.verifyDownloadedModel({ localDir });
        for (const item of result.issues || []) {
          issues.push({ code: "structure", severity: item.severity === "fail" ? "fail" : "warn", title: scrubPaths(item.title), detail: scrubPaths(item.detail) });
        }
      } catch (error) {
        issues.push({ code: "structure_unchecked", severity: "warn", title: "The structure check could not run", detail: scrubPaths(error?.message || error) });
      }
    }
    return issues;
  }

  async function runVerify(entryId, checksums, progress) {
    const entry = findEntry(entryId);
    if (!entry) throw new LibraryError("library_entry_not_found", "The library entry no longer exists.", { status: 404 });
    progress({ done: 0, total: 1, unit: "files" });
    const issues = await structureIssues(entry);
    const weights = entry.files.filter(isWeight);
    let checksum = entry.verification?.checksum || "none";
    const verifiedAt = nowIso();
    if (checksums) {
      const targets = entry.files.filter((file) => file.sha256);
      const totalBytes = targets.reduce((sum, file) => sum + file.size, 0);
      let doneBytes = 0;
      progress({ done: 0, total: totalBytes, unit: "bytes" });
      const baseDir = entry.kind === "single-file" ? path.dirname(entry.path) : entry.kind === "hf-cache-repo" && entry.cache ? path.join(entry.path, "snapshots", entry.cache.currentSha) : entry.path;
      const matched = new Set();
      for (const file of targets) {
        const full = path.join(baseDir, ...file.path.split("/"));
        const missing = issues.some((item) => item.code === "file_missing" && item.path === file.path);
        if (missing) {
          doneBytes += file.size;
          continue;
        }
        let digest = null;
        try {
          digest = await hashFile(full, { onProgress: (done) => progress({ done: doneBytes + done, total: totalBytes, unit: "bytes" }) });
        } catch (error) {
          issues.push({ code: "sha256_unreadable", severity: "warn", title: "A file could not be read for hashing", detail: `${file.path}: ${scrubPaths(error?.code || error?.message)}`, path: file.path });
        }
        doneBytes += file.size;
        progress({ done: doneBytes, total: totalBytes, unit: "bytes" });
        if (digest === null) continue;
        if (digest.toLowerCase() === file.sha256.toLowerCase()) {
          file.verifiedAt = verifiedAt;
          matched.add(file.path);
        } else {
          file.verifiedAt = null;
          issues.push({ code: "sha256_mismatch", severity: "fail", title: "A file does not match its recorded sha256", detail: file.path, path: file.path });
        }
      }
      const verifiedWeights = weights.filter((file) => matched.has(file.path));
      checksum = weights.length && verifiedWeights.length === weights.length ? "verified" : matched.size ? "partial" : "none";
    }
    const status = issues.some((item) => item.severity === "fail") ? "fail" : issues.some((item) => item.severity === "warn") ? "warn" : "ok";
    entry.verification = { status, checksum, checkedAt: verifiedAt, issues };
    entry.runnable = computeRunnable(entry.card?.role, entry.internal?.cardRunnable ?? null, status);
    await persist();
    emitChanged([entry.id]);
    progress({ done: 1, total: 1 });
    return { entryId: entry.id, status, checksum };
  }

  /**
   * verify(id, { checksums }) → { taskId, task }. Structure and size always;
   * sha256 of the files with a recorded hash when `checksums` is true, in a
   * worker thread. The same request again returns the running task.
   */
  function verify(id, { checksums = false } = {}) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    const key = `${entry.id}:${checksums ? "sha" : "fast"}`;
    const existing = activeTask("verify", key);
    if (existing) return { taskId: existing.id, task: publicTask(existing) };
    const task = newTask("verify", entry.id);
    task.key = key;
    const previous = verifyChains.get(entry.id) || Promise.resolve();
    const run = previous.then(() => runTask(task, (progress) => runVerify(entry.id, Boolean(checksums), progress)));
    verifyChains.set(entry.id, run.catch(() => {}));
    run.finally(() => {
      if (verifyChains.get(entry.id) === run) verifyChains.delete(entry.id);
    }).catch(() => {});
    return { taskId: task.id, task: publicTask(task) };
  }

  // --- identify ---

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "timeout" })), ms);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // "confirmed" | "not_found" | "unavailable" | "error" for repo@sha on a provider.
  async function confirmRepo(namespace, repo, sha) {
    const provider = providers && typeof providers.get === "function" ? providers.get(namespace === "modelscope" ? "modelscope" : "huggingface") : null;
    if (!provider || typeof provider.getRepo !== "function") return "unavailable";
    try {
      const manifest = await withTimeout(Promise.resolve(provider.getRepo(repo, { revision: sha || "main" })), IDENTIFY_TIMEOUT_MS);
      if (sha && manifest?.revisionSha && !sameText(manifest.revisionSha, sha)) return "not_found";
      return "confirmed";
    } catch (error) {
      const status = Number(error?.status ?? error?.statusCode);
      if (status === 404 || /not_found/i.test(String(error?.code || ""))) return "not_found";
      return "error";
    }
  }

  function rederive(entry) {
    const { provenance, quant } = deriveProvenance(entry.internal.sources);
    entry.provenance = provenance;
    if (quant) entry.quant = quant;
    const confident = provenance.repo && (provenance.confidence === "declared" || provenance.confidence === "detected");
    if (confident) entry.displayName = provenance.repo.split("/")[1];
    entry.identityKey = identityKeyFor(provenance, entry.filesetHash);
    linkDuplicates(entries);
  }

  /**
   * identify(id, { provider, repo, force }) → entry. Sets (and, when a
   * provider is available, confirms) the repo of an entry. Without a repo it
   * tries the entry's folder-name candidates. A confirmed repo is "detected",
   * an unconfirmable one "declared" (the user said so); a repo the hub
   * definitely cannot find at the entry's revision is refused unless `force`.
   */
  async function identify(id, input = {}) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    const sha = entry.provenance?.revisionSha || null;
    const namespace = input.provider === undefined || input.provider === null || input.provider === "" ? (entry.provenance?.provider || "huggingface") : namespaceOf(input.provider);
    if (!namespace) throw new LibraryError("invalid_request", "provider must be huggingface, hf-mirror or modelscope.", { status: 400, details: { field: "provider" } });
    let repo = input.repo === undefined || input.repo === null || input.repo === "" ? null : String(input.repo).trim();
    if (repo && !REPO_RE.test(repo)) throw new LibraryError("invalid_request", "repo must look like owner/name.", { status: 400, details: { field: "repo" } });

    let confidence = "declared";
    if (repo) {
      const state = await confirmRepo(namespace, repo, sha);
      if (state === "confirmed") confidence = "detected";
      else if (state === "not_found" && sha && !input.force) {
        throw new LibraryError("repo_revision_not_found", "The hub has no such repository at this model's revision.", {
          status: 422,
          hint: "Check the repository name, or set force to record it anyway.",
          details: { repo, revisionSha: sha },
        });
      }
    } else {
      const candidates = entry.provenance?.candidates || [];
      if (!candidates.length) throw new LibraryError("identify_no_candidates", "Give a repo (owner/name): there is nothing to confirm for this entry.", { status: 422 });
      if (!sha || !providers) throw new LibraryError("identify_unavailable", "Confirming a candidate needs the hub's providers and a known revision.", { status: 503 });
      for (const candidate of candidates) {
        if (await confirmRepo(namespace, candidate, sha) === "confirmed") {
          repo = candidate;
          confidence = "detected";
          break;
        }
      }
      if (!repo) throw new LibraryError("identify_not_found", "None of the folder-name candidates exists at this revision.", { status: 422, details: { candidates } });
    }
    entry.internal.sources.user = {
      source: "user",
      confidence,
      fields: { provider: namespace, transport: namespace, repo },
    };
    rederive(entry);
    await persist();
    emitChanged([entry.id]);
    return toPublic(entry);
  }

  // The identifyOnline setting: confirm folder-name candidates in the
  // background after a scan. Never blocks a scan and never throws.
  async function confirmCandidatesInBackground() {
    if (!providers || getSettings()?.library?.identifyOnline !== true) return;
    const targets = entries.filter((entry) => entry.provenance?.candidates?.length && entry.provenance.revisionSha && !entry.internal.sources.user);
    await mapLimit(targets, 2, async (entry) => {
      for (const candidate of entry.provenance.candidates) {
        if (await confirmRepo("huggingface", candidate, entry.provenance.revisionSha) === "confirmed") {
          entry.internal.sources.user = { source: "hf-local-metadata", confidence: "detected", fields: { provider: "huggingface", repo: candidate } };
          rederive(entry);
          return;
        }
      }
    });
    await persist();
    emitChanged(targets.map((entry) => entry.id));
  }

  // --- registration from a finished job ---

  /**
   * registerFromJob(job) → { entryId, entry } | null. The queue calls it when
   * a download is ready (03 §7.4 step 5). The job's own record is the highest
   * source after the user's, and its per-file hashes seed the entry.
   */
  async function registerFromJob(job) {
    const localDir = job?.target?.localDir;
    if (!localDir || !path.isAbsolute(String(localDir))) return null;
    const artifact = isPlainObject(job.artifact) ? job.artifact : {};
    const provider = namespaceOf(artifact.provider);
    const repo = cleanRepo(artifact.repo);
    const record = {
      source: "hub-job",
      confidence: "declared",
      fields: {
        provider,
        transport: namespaceOf(job.transfer?.options?.source) ? String(job.transfer.options.source) : provider,
        repo,
        revision: artifact.revision ? String(artifact.revision) : null,
        revisionSha: cleanSha(artifact.revisionSha),
        artifactKey: artifact.artifactKey ? String(artifact.artifactKey) : null,
        downloadedAt: job.finishedAt || nowIso(),
        downloadJobId: job.id ? String(job.id) : null,
        quant: artifact.quant ? String(artifact.quant) : null,
      },
      files: (Array.isArray(artifact.files) ? artifact.files : []).filter(isPlainObject).map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 || null, gitOid: file.gitOid || null })),
    };
    const snapshot = await modelStorage.snapshot();
    const candidate = candidateForPath(localDir, snapshot);
    if (!candidate) {
      warn("library: a finished job's folder is not a library candidate; it was not registered.");
      return null;
    }
    pendingJobs.set(pathKey(candidate.path), record);
    const previous = entries.find((entry) => pathKey(entry.path) === pathKey(candidate.path));
    if (previous) previous.internal.scanKey = null;
    await runScan({ onlyCandidates: [candidate] });
    const entry = entries.find((item) => pathKey(item.path) === pathKey(candidate.path)) || null;
    if (entry && entry.internal.sources.job !== record) {
      entry.internal.sources.job = record;
      rederive(entry);
      await persist();
    }
    return entry ? { entryId: entry.id, entry: toPublic(entry) } : null;
  }

  // --- guards shared by the actions that touch files (03 §9.5, §17) ---

  // Long actions are awaited by stop(), so a restart does not cut a copy short unannounced.
  function track(promise) {
    backgroundWork.add(promise);
    promise.finally(() => backgroundWork.delete(promise)).catch(() => {});
    return promise;
  }

  function liveJobs() {
    try {
      const list = getJobs();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** A job that may still write the folder: any job not yet ready, failed or cancelled (paused and retrying included). */
  function activeJobOn(target) {
    return liveJobs().find((job) => job && !TERMINAL_JOB_STATES.includes(job.state) && job.target?.localDir && overlapsPath(job.target.localDir, target)) || null;
  }

  function pathBusy(label, details = {}) {
    return new LibraryError("path_busy", "The folder is in use; nothing was changed.", {
      status: 409,
      hint: "Wait for the task to finish or cancel it, then try again.",
      details: { usedBy: String(label).slice(0, 200), ...details },
    });
  }

  /**
   * Refuses (409 path_busy) while a queue job, a storage operation lock
   * (migration, verification) or a running container uses the path. A probe
   * that cannot answer refuses too: nothing is changed on a guess.
   */
  async function assertNotBusy(target) {
    const job = activeJobOn(target);
    if (job) throw pathBusy(`download ${job.id}`, { jobId: job.id, state: job.state });
    if (getBusyPaths) {
      let busy;
      try {
        busy = await getBusyPaths();
      } catch (error) {
        throw new LibraryError("path_busy", "The folder could not be checked for running containers; nothing was changed.", {
          status: 409,
          details: { reason: redactSecrets(String(error?.message || error)).slice(0, 200) },
        });
      }
      const hit = (Array.isArray(busy) ? busy : []).find((item) => item && item.path && overlapsPath(item.path, target));
      if (hit) throw pathBusy(hit.label || "a running task");
    }
    try {
      modelStorage.assertUnlocked([target]);
    } catch {
      throw pathBusy("a storage operation");
    }
  }

  function storageFailure(error, field = "target") {
    const status = Number(error?.status);
    return new LibraryError("invalid_target", String(error?.message || "The folder is not usable."), {
      status: status === 503 ? 503 : status === 409 ? 409 : 400,
      details: { field },
    });
  }

  // --- update check and update (03 §9.4) ---

  function providerFor(namespace) {
    if (!providers) return null;
    const id = namespace === "modelscope" ? "modelscope" : "huggingface";
    if (typeof providers.forNamespace === "function") return providers.forNamespace(id);
    if (typeof providers.get === "function") return providers.get(id);
    return null;
  }

  function fileDiffers(local, remote) {
    if (!local) return true;
    if (local.sha256 && remote.sha256) return String(local.sha256).toLowerCase() !== String(remote.sha256).toLowerCase();
    if (local.gitOid && remote.gitOid) return String(local.gitOid).toLowerCase() !== String(remote.gitOid).toLowerCase();
    // No hash both sides can compare: a different size is a change, the same size is not.
    return remote.size !== null && remote.size !== undefined && Number.isFinite(Number(remote.size)) && Number(local.size) !== Number(remote.size);
  }

  /**
   * Compares an entry with the remote revision it came from. Returns
   * { update, selection } and never throws for a provider problem: that is
   * `update.status = "error"` (the entry keeps working). The selection is the
   * artifact key when the remote still has it, else the entry's own paths.
   */
  async function inspectUpdate(entry) {
    const provenance = entry.provenance || {};
    const namespace = namespaceOf(provenance.provider);
    const repo = cleanRepo(provenance.repo);
    const checkedAt = nowIso();
    const base = { status: "unsupported", remoteSha: null, changedFiles: 0, bytesToDownload: 0, checkedAt };
    // Nothing to compare with: the console offers "identify" (03 §9.4).
    if (!namespace || !repo || (provenance.confidence !== "declared" && provenance.confidence !== "detected")) return { update: { ...base, action: "identify" }, selection: null };
    const provider = providerFor(namespace);
    if (!provider || typeof provider.getRepo !== "function") {
      return { update: { ...base, status: "error", error: { code: "hub_unavailable" } }, selection: null };
    }
    let manifest;
    try {
      manifest = await provider.getRepo(repo, { revision: provenance.revision || "main" });
    } catch (error) {
      return { update: { ...base, status: "error", remoteSha: entry.update?.remoteSha ?? null, error: { code: String(error?.code || "provider_error").slice(0, 60) } }, selection: null };
    }
    const remoteSha = cleanSha(manifest?.revisionSha);
    const remoteFiles = Array.isArray(manifest?.files) ? manifest.files : [];
    const remoteByPath = new Map(remoteFiles.filter((file) => file && typeof file.path === "string").map((file) => [file.path, file]));
    let selected = null;
    let selection = null;
    if (provenance.artifactKey) {
      try {
        selected = resolveSelection(manifest, { artifactKey: provenance.artifactKey }).files;
        selection = { artifactKey: provenance.artifactKey };
      } catch {
        selected = null;
      }
    }
    if (!selected) {
      selected = entry.files.map((file) => remoteByPath.get(file.path)).filter(Boolean);
      selection = selected.length ? { files: selected.map((file) => file.path) } : null;
    }
    const sameRevision = Boolean(remoteSha && provenance.revisionSha && sameText(remoteSha, provenance.revisionSha));
    let changedFiles = 0;
    let bytesToDownload = 0;
    if (!sameRevision) {
      const local = new Map(entry.files.map((file) => [file.path, file]));
      for (const remote of selected) {
        if (!fileDiffers(local.get(remote.path), remote)) continue;
        changedFiles += 1;
        bytesToDownload += Number(remote.size) || 0;
      }
    }
    const update = { status: changedFiles > 0 ? "available" : "current", remoteSha, changedFiles, bytesToDownload, checkedAt };
    return { update, selection };
  }

  const updateChecks = new Map();

  /**
   * checkUpdate(id) → update { status, remoteSha, changedFiles,
   * bytesToDownload, checkedAt }. The result is stored on the entry. An entry
   * with no repo is `unsupported` (the console offers "identify"); a hub that
   * cannot be reached is `error` with `error.code`, not an HTTP failure.
   */
  async function checkUpdate(id) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    const key = entry.id;
    const running = updateChecks.get(key);
    if (running) return running;
    const run = (async () => {
      const { update } = await inspectUpdate(entry);
      const live = findEntry(key);
      if (live) {
        live.update = update;
        await persist();
        emitChanged([live.id]);
      }
      return JSON.parse(JSON.stringify(update));
    })();
    updateChecks.set(key, run);
    try {
      return await run;
    } finally {
      updateChecks.delete(key);
    }
  }

  async function readMarkerFile(dir) {
    const marker = await readSmallJson(path.join(dir, MARKER_FILE));
    return isPlainObject(marker.value) ? marker.value : null;
  }

  /**
   * update(id, ctx) → DownloadJob. Enqueues a job into the entry's own folder
   * at the revision the check found (`origin.kind = "library-update"`); the
   * CLI skips files whose local etag matches, so only the changed files
   * transfer. A folder without a platform marker gets a v1 marker first (the
   * same one a first download writes), because the queue resumes only into a
   * folder whose marker names the same repo.
   */
  async function update(id, ctx = {}) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    if (!enqueue) throw new LibraryError("hub_unavailable", "The download queue is not available.", { status: 503 });
    const snapshot = await modelStorage.snapshot();
    const root = entry.rootId ? snapshot.roots.find((item) => item.id === entry.rootId) : null;
    if (entry.kind !== "folder" || !root || root.mode === "model") {
      throw new LibraryError("update_unsupported", "Only a model folder inside a library root can be updated in place.", {
        status: 422,
        hint: "Download the new revision as a new model instead.",
      });
    }
    const { update: result, selection } = await inspectUpdate(entry);
    const live = findEntry(entry.id);
    if (live) {
      live.update = result;
      await persist();
      emitChanged([live.id]);
    }
    if (result.status === "unsupported") {
      throw new LibraryError("update_unsupported", "This model has no known repository, so there is nothing to compare with.", { status: 422, hint: "Identify the repository first." });
    }
    if (result.status === "error") {
      throw new LibraryError("update_check_failed", "The remote revision could not be read.", { status: 502, details: { code: result.error?.code || "provider_error" } });
    }
    if (result.status === "current" || !selection) {
      throw new LibraryError("already_current", "This model is already up to date.", { status: 409, details: { remoteSha: result.remoteSha } });
    }
    const provenance = entry.provenance;
    const repo = cleanRepo(provenance.repo);
    const outputName = path.basename(entry.path);
    let marker = await readMarkerFile(entry.path);
    if (!marker || !marker.model) {
      const created = { model: repo, source: provenance.transport || provenance.provider || "huggingface", precision: entry.quant || "", createdAt: nowIso() };
      const file = path.join(entry.path, MARKER_FILE);
      const temp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(created, null, 2)}\n`);
      await fsp.rename(temp, file);
      marker = created;
    }
    const input = {
      provider: namespaceOf(provenance.provider),
      repo,
      revision: provenance.revision || "main",
      selection,
      target: { rootId: entry.rootId, outputName },
      allowDuplicate: true,
    };
    const origin = { ...(isPlainObject(ctx.origin) ? ctx.origin : {}), kind: "library-update", entryId: entry.id };
    return enqueue(input, { origin, markerMetadata: { model: marker.model, source: marker.source, precision: marker.precision } });
  }

  // --- cleanup of .incomplete residue (03 §9.5) ---

  async function refreshEntry(entry) {
    const snapshot = await modelStorage.snapshot();
    const candidate = candidateForPath(entry.path, snapshot);
    if (candidate) await runScan({ onlyCandidates: [candidate] });
    return findEntry(entry.id);
  }

  /**
   * cleanupResidue(id) → { removed[], removedBytes }. Removes the `.incomplete`
   * files of the folder and nothing else. 409 path_busy while a job is
   * active, paused or retrying on it (the legacy rule), or the folder is
   * locked.
   */
  async function cleanupResidue(id) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    if (entry.kind !== "folder" || !entry.rootId) {
      throw new LibraryError("residue_unsupported", "Only a model folder inside a library root has residue to clean.", { status: 422 });
    }
    const job = activeJobOn(entry.path);
    if (job) throw pathBusy(`download ${job.id}`, { jobId: job.id, state: job.state });
    const cleaner = fsStore && typeof fsStore.cleanupIncompleteFiles === "function"
      ? fsStore
      : createModelFilesystemStore({ storage: modelStorage, modelsRoot: path.dirname(entry.path), hfCache: hfHome });
    let result;
    try {
      result = await cleaner.cleanupIncompleteFiles(entry.path);
    } catch (error) {
      if (Number(error?.status) === 409) throw pathBusy("a storage operation");
      throw storageFailure(error, "path");
    }
    await refreshEntry(entry);
    emitChanged([entry.id]);
    return { removed: result.removed, removedBytes: result.removedBytes };
  }

  // --- delete (03 §9.5, §17) ---

  /**
   * The folder a delete would remove, after the structural guards: never a
   * root (nor a folder holding one), always inside the registered roots
   * (resolvePath with allowRoot: false), and a Hugging Face or ModelScope
   * cache repo only directly under its cache.
   */
  function deletionTarget(entry) {
    const target = path.resolve(entry.path);
    if (entry.kind === "hf-cache-repo" || entry.kind === "modelscope-cache") {
      const base = path.join(hfHome, entry.kind === "hf-cache-repo" ? "hub" : "modelscope");
      const direct = entry.kind === "hf-cache-repo" ? pathKey(path.dirname(target)) === pathKey(base) && path.basename(target).startsWith("models--") : containsPath(base, target) && pathKey(base) !== pathKey(target);
      if (!direct) throw new LibraryError("invalid_target", "The cache folder is not where the cache keeps repositories.", { status: 400 });
      return target;
    }
    return guardedFolder(target);
  }

  // The structural guards of every folder delete: never a root (nor a folder
  // holding one), always inside a registered root, never a migrated-away path.
  function guardedFolder(value) {
    const target = path.resolve(value);
    if (modelStorage.roots().some((root) => containsPath(target, root.path))) {
      throw new LibraryError("root_not_deletable", "A model library root cannot be deleted, nor a folder that contains one.", {
        status: 400,
        hint: "Unregister the root in the storage settings instead.",
      });
    }
    try {
      modelStorage.resolvePath(target, { follow: false, allowRoot: false });
    } catch (error) {
      throw storageFailure(error, "path");
    }
    if (modelStorage.isRetired(target)) throw new LibraryError("invalid_target", "This folder was migrated; delete the migrated copy instead.", { status: 409 });
    return target;
  }

  /**
   * removeFolder(path) → bytes. Deletes a folder that is no library entry any
   * more (the leftover of a failed or cancelled download) under the same
   * guards as remove(); an entry registered at the path is dropped with it.
   */
  async function removeFolder(value) {
    const target = guardedFolder(value);
    await assertNotBusy(target);
    const bytes = await dirBytes(target);
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    const gone = entries.filter((item) => pathKey(item.path) === pathKey(target));
    if (gone.length) {
      entries = entries.filter((item) => !gone.includes(item));
      linkDuplicates(entries);
      await persist();
      emitChanged(gone.map((item) => item.id));
    }
    return bytes;
  }

  /**
   * remove(id, { confirm }) → { taskId, task }. Guards run before anything
   * is touched: the root guard, `confirm === displayName`, and the busy
   * check (jobs, locks, mounted containers; a container is never stopped).
   * The removal itself is a task and is idempotent: a folder that is already
   * gone just drops the entry.
   */
  async function remove(id, { confirm } = {}) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    const target = deletionTarget(entry);
    if (typeof confirm !== "string" || confirm !== entry.displayName) {
      throw new LibraryError("confirm_required", "Type the model's name to delete it.", { status: 400, details: { field: "confirm", expected: "displayName" } });
    }
    const existing = activeTask("delete", entry.id);
    if (existing) return { taskId: existing.id, task: publicTask(existing) };
    await assertNotBusy(target);
    const task = newTask("delete", entry.id);
    task.key = entry.id;
    task.progress = { done: 0, total: 1, unit: "folders" };
    track(runTask(task, async (progress) => {
      // The check ran a moment ago; a job may have started since.
      await assertNotBusy(target);
      const bytes = await dirBytes(target);
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      entries = entries.filter((item) => item.id !== entry.id);
      linkDuplicates(entries);
      await persist();
      emitChanged([entry.id, ...entry.duplicates]);
      progress({ done: 1, total: 1 });
      return { entryId: entry.id, reclaimedBytes: bytes };
    }));
    return { taskId: task.id, task: publicTask(task) };
  }

  // --- import of a Hugging Face cache repository (03 §9.5) ---

  /**
   * importCache(id, { rootId, outputName }) → { taskId, task }. Copies the
   * current snapshot's real files into `<root>/<outputName>`, hashes each in
   * the worker, compares with the cache's recorded hash, and writes marker v2
   * with the entry's provenance. The cache copy is kept. The target comes
   * from modelStorage.downloadTarget and follows the target-occupied rule of
   * a download (409): a folder with other files is refused, one with the
   * same marker is resumed into.
   */
  async function importCache(id, input = {}) {
    const entry = findEntry(id);
    if (!entry) throw new LibraryError("library_entry_not_found", "No such library entry.", { status: 404 });
    const repo = cleanRepo(entry.provenance?.repo);
    if (entry.kind !== "hf-cache-repo" || !entry.cache?.currentSha || !repo) {
      throw new LibraryError("import_unsupported", "Only a Hugging Face cache repository with a known name can be imported.", { status: 422 });
    }
    for (const field of ["rootId", "outputName"]) {
      if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string") {
        throw new LibraryError("invalid_request", `${field} must be a string.`, { status: 400, details: { field } });
      }
    }
    const outputName = typeof input.outputName === "string" && input.outputName.trim() ? input.outputName.trim() : repo.replace("/", "-");
    let target;
    try {
      target = modelStorage.downloadTarget(input.rootId || null, outputName);
    } catch (error) {
      throw storageFailure(error);
    }
    const key = `${entry.id}:${pathKey(target)}`;
    const running = activeTask("import", key);
    if (running) return { taskId: running.id, task: publicTask(running) };
    const sha = entry.cache.currentSha;
    const snapshotDir = path.join(entry.path, "snapshots", sha);
    const tree = await walkTree(snapshotDir);
    const files = tree.files.filter((file) => classifyFile(file.rel) === "payload");
    if (!files.length) throw new LibraryError("import_empty", "The cached snapshot has no files to import.", { status: 422 });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (disk) {
      const free = Number(await Promise.resolve(disk.freeBytes(target)).catch(() => null));
      if (Number.isFinite(free)) {
        const reserve = typeof disk.reserveBytes === "function" ? Number(disk.reserveBytes(free)) || 0 : 0;
        if (totalBytes > free - reserve) {
          throw new LibraryError("disk_full", "The target drive does not have room for this import.", { status: 507, details: { freeBytes: free, reserveBytes: reserve, totalBytes } });
        }
      }
    }
    const busyJob = activeJobOn(target);
    if (busyJob) throw pathBusy(`download ${busyJob.id}`, { jobId: busyJob.id, state: busyJob.state });
    const provenance = entry.provenance;
    const quant = entry.quant || "";
    const transport = provenance.transport || provenance.provider || "huggingface";
    const existed = fs.existsSync(target);
    // The folder is locked like a migration's while files are copied into it.
    const lockId = crypto.randomUUID();
    try {
      modelStorage.acquireOperation([target], "import", lockId);
    } catch {
      throw pathBusy("a storage operation");
    }
    try {
      // The target-occupied rule, and the v1 marker a resume matches against.
      modelStorage.prepareDownload(target, { model: repo, source: transport, precision: quant });
    } catch (error) {
      modelStorage.releaseOperation(lockId);
      if (Number(error?.status) === 409) {
        throw new LibraryError("target_occupied", "The target folder already holds other files.", { status: 409, hint: "Choose another folder name." });
      }
      throw storageFailure(error);
    }
    const task = newTask("import", entry.id);
    task.key = key;
    task.progress = { done: 0, total: totalBytes, unit: "bytes" };
    const known = new Map(entry.files.map((file) => [file.path, { sha256: file.sha256 || null, gitOid: file.gitOid || null }]));
    track(runTask(task, async (progress) => {
      try {
        const realRepo = await fsp.realpath(entry.path);
        const copied = [];
        let done = 0;
        for (const file of files) {
          // A stopping hub leaves the copy for the next import to resume into.
          if (stopped) throw new LibraryError("hub_stopping", "The hub is stopping; repeat the import to continue.", { status: 503 });
          const dest = path.join(target, ...file.rel.split("/"));
          if (!containsPath(target, dest)) throw new LibraryError("unsafe_path", "A cached file name points outside the target folder.", { status: 400 });
          const real = await fsp.realpath(file.full);
          if (!containsPath(realRepo, real)) throw new LibraryError("import_unsafe_link", "A cached file links to a place outside the cache repository.", { status: 400 });
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          const temp = `${dest}.incomplete`;
          try {
            await fsp.copyFile(real, temp);
            const digest = (await hashFile(temp, { onProgress: (bytes) => progress({ done: done + bytes, total: totalBytes, unit: "bytes" }) })).toLowerCase();
            const expected = known.get(file.rel) || { sha256: null, gitOid: null };
            if (expected.sha256 && expected.sha256.toLowerCase() !== digest) {
              throw new LibraryError("import_hash_mismatch", "A copied file does not match the hash the cache recorded.", { status: 422, details: { path: file.rel } });
            }
            await replaceFileAtomically(temp, dest, 12, { fallbackToCopy: false });
            // The marker keeps the hub's convention: sha256 where the cache knew
            // one, the git object id for the other files it knew, so the copy has
            // the same fileset hash as the cache entry. Unknown files get the
            // sha256 just computed.
            copied.push({ path: file.rel, size: file.size, sha256: expected.sha256 ? digest : expected.gitOid ? null : digest, gitOid: expected.gitOid });
          } finally {
            await fsp.rm(temp, { force: true }).catch(() => {});
          }
          done += file.size;
          progress({ done, total: totalBytes, unit: "bytes" });
        }
        await writeDownloadMarker({
          id: null,
          target: { localDir: target },
          artifact: { provider: provenance.provider, repo, quant: quant || null, revision: provenance.revision || null, revisionSha: sha, artifactKey: provenance.artifactKey || null },
          transfer: { options: { source: transport } },
        }, { files: copied, clock });
        const snapshot = await modelStorage.snapshot();
        const candidate = candidateForPath(target, snapshot);
        if (!candidate) throw new LibraryError("invalid_target", "The target folder is not a library folder.", { status: 400 });
        await runScan({ onlyCandidates: [candidate] });
        const created = entries.find((item) => pathKey(item.path) === pathKey(target));
        emitChanged([entry.id, ...(created ? [created.id] : [])]);
        return { entryId: created ? created.id : null, outputName, files: copied.length, bytes: done };
      } catch (error) {
        // A folder this import created holds nothing else: take it back.
        if (!existed) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        modelStorage.releaseOperation(lockId);
      }
    }));
    return { taskId: task.id, task: publicTask(task) };
  }

  /** Every entry without its file list, for the storage view. */
  function all() {
    return entries.map((entry) => toPublic(entry, { files: false }));
  }

  // --- lifecycle ---

  function readStorageMtime() {
    try {
      return modelStorage.file ? fs.statSync(modelStorage.file).mtimeMs : null;
    } catch {
      return null;
    }
  }

  // A root registered or a migration completed changes model-storage.json
  // (03 §9.1). Returns whether a rescan was started.
  function checkStorageChanged() {
    const current = readStorageMtime();
    if (lastStorageMtime === null) {
      lastStorageMtime = current;
      return false;
    }
    if (current === lastStorageMtime) return false;
    lastStorageMtime = current;
    void rescan().catch((error) => warn(`library: rescan after a storage change failed: ${error?.message || error}`));
    return true;
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    load();
    lastStorageMtime = readStorageMtime();
    if (watchMs > 0) {
      watchTimer = setInterval(checkStorageChanged, watchMs);
      watchTimer.unref?.();
    }
  }

  async function stop() {
    stopped = true;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    await scanChain.catch(() => {});
    await Promise.allSettled([...verifyChains.values(), ...backgroundWork]);
    await store.flush?.().catch(() => {});
  }

  return {
    start,
    stop,
    list,
    get,
    getTask,
    rescan,
    verify,
    identify,
    checkUpdate,
    update,
    importCache,
    remove,
    cleanupResidue,
    removeFolder,
    all,
    findByPath,
    registerFromJob,
    checkStorageChanged,
    confirmCandidatesInBackground,
    errors: () => loadErrors.map((item) => ({ ...item })),
    activeVerifications: () => [...tasks.values()].filter((task) => task.kind === "verify" && (task.state === "queued" || task.state === "running")).length,
    get stopped() {
      return stopped;
    },
    get size() {
      return entries.length;
    },
    get scannedAt() {
      return scannedAt;
    },
  };
}

module.exports = {
  CONFIDENCES,
  FILES_CAP,
  HF_CACHE_ROOT_ID,
  LIBRARY_SCHEMA_VERSION,
  LibraryError,
  MS_CACHE_ROOT_ID,
  classifyFile,
  computeFilesetHash,
  createLibrary,
  deriveProvenance,
  dirBytes,
  hashFileInWorker,
  identityKeyFor,
  repoCandidatesFromName,
  scrubPaths,
  volumeOf,
};
