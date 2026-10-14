"use strict";

// Local model inspection (docs/overhaul/02-models.md §3, §4, §5).
//
// inspectLocal(path) lists the folder (readdir + stat), computes the cache
// key from that listing and answers from the facts cache while the key holds.
// Otherwise the detectors run in a worker_threads worker (inspect-worker.js):
// one job at a time per process, single-flighted per (cardId, key, depth), so
// hundreds of safetensors headers or a multi-MB GGUF header never block the
// caller's event loop. The worker returns raw facts with their evidence; the
// card is assembled here, and the derived fields (family, parsers, support)
// are recomputed on every read, so knowledge edits never need re-inspection.
//
// Until the knowledge layers land (MOD-5..MOD-7), derived fields stay at
// their "not matched" values: familyId null, support "unknown", parsers null.
// Role detection and companion pairing are MOD-4; role stays null here.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { Worker } = require("node:worker_threads");
const { createSingleFlightCache } = require("../single-flight-cache");
const {
  cardIdFor, defaultCacheDir, fingerprintKey, isCardId, readCachedFacts, readCachedFactsSync, writeCachedFacts,
} = require("./cache");
const { contentDigestForDir } = require("./content-digest");
const { createFactSet } = require("./evidence");
const { detectAdapterConfig, detectConfig, pythonFiles } = require("./detectors/hf-config");
const { detectGenerationConfig, detectGgufSampling } = require("./detectors/generation-config");
const { ggufFacts } = require("./detectors/gguf");
const {
  abortError, filesOfKind, inventoryWarnings, scanInventory, transformersLayout, transformersWeights,
} = require("./detectors/inventory");
const { detectQuant } = require("./detectors/quant");
const { buildTensorTable } = require("./detectors/safetensors");
const { detectTemplate } = require("./detectors/template");
const { buildTopology, writeWeights } = require("./detectors/topology");

const INSPECTOR_VERSION = "1.0.0";
const DEPTHS = Object.freeze(["full", "quick"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const WORKER_IDLE_MS = 30_000;
const WORKER_FILE = path.join(__dirname, "inspect-worker.js");
const MEMORY_LIMIT = 256;

const STATUS_BY_CODE = Object.freeze({
  invalid_path: 400,
  path_not_allowed: 400,
  path_outside_storage: 400,
  not_found: 404,
  not_a_model: 422,
  card_not_found: 404,
  aborted: 499,
  inspect_timeout: 504,
  inspect_worker_failed: 500,
});

const COPY = Object.freeze({
  formatFiles: {
    zh: "来自文件夹列表（只读取文件大小）。",
    en: "From the folder listing (file sizes only).",
  },
  mixed: {
    zh: "文件夹同时包含 Transformers 权重和 GGUF 文件；卡片描述 Transformers 权重，检查 GGUF 时请选择文件。",
    en: "The folder holds Transformers weights and GGUF files; the card describes the Transformers weights. Inspect a GGUF file to see it.",
  },
  noMtp: {
    zh: "没有找到 MTP 张量。",
    en: "No MTP tensors were found.",
  },
  mtpPackaged: {
    zh: "检查点包含 MTP 张量。",
    en: "The checkpoint packages MTP tensors.",
  },
  noRemoteCode: {
    zh: "没有 config.json 的 auto_map，也不需要运行模型自带的代码。",
    en: "No config.json auto_map; no model-supplied code needs to run.",
  },
  quickWeights: {
    zh: "快速检查只读取索引，没有读取每个分片的头，权重字节不精确。",
    en: "A quick inspection reads the index only, not every shard header; the weight bytes are not exact.",
  },
});

class InspectError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "InspectError";
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Detectors (worker side)

function writeFormat(inv, facts, { gguf, table, transformers, quantMethod }) {
  const listing = { kind: "file", ref: null };
  const hasGguf = filesOfKind(inv, "weights:gguf").length > 0;
  let kind = "none";
  let files = [];
  let layout = null;
  let missing = [];
  if (gguf) {
    kind = "gguf";
    files = gguf.files;
    layout = gguf.layout;
    missing = [...gguf.missing, ...gguf.truncated];
  } else if (transformers.files.length) {
    const kinds = new Set(transformers.files.map((entry) => entry.kind));
    if (hasGguf || kinds.size > 1) kind = "mixed";
    else if (kinds.has("weights:safetensors")) kind = quantMethod === "exl3" ? "exl3" : "safetensors";
    else kind = "pytorch-bin";
    files = transformers.files;
    layout = hasGguf ? "custom" : transformersLayout(inv, transformers);
    missing = [...(table?.missing || []), ...(table?.truncated || [])];
    if (hasGguf) facts.warn("mixed_weight_formats", COPY.mixed);
  }
  missing = Array.from(new Set(missing)).sort();
  facts.set("/format/kind", kind, listing, "declared", COPY.formatFiles);
  facts.set("/format/weightFiles", files.length, listing, "declared");
  facts.set("/format/weightBytes", files.reduce((sum, entry) => sum + entry.size, 0), listing, "declared");
  facts.set("/format/complete", missing.length === 0, listing, "detected");
  if (missing.length) facts.set("/format/missing", missing, listing, "detected");
  facts.set("/format/layout", layout, listing, "detected");
}

/**
 * Runs every local detector over one folder and returns the raw facts:
 * { contentDigest, depth, data, evidence, warnings, errors, templateText }.
 * file: a folder-relative GGUF name for a single-file card.
 */
async function collectLocalFacts(dir, options = {}) {
  const inv = options.inventory || await scanInventory(dir);
  const depth = options.depth === "quick" ? "quick" : "full";
  const file = options.file || null;
  const facts = createFactSet();
  inventoryWarnings(inv, facts);

  // A single GGUF file is described by its own header; the folder's
  // Transformers metadata belongs to other artifacts.
  const configInfo = file ? null : detectConfig(inv, facts);
  if (!file) {
    detectAdapterConfig(inv, facts);
    detectGenerationConfig(inv, facts);
  }
  const transformers = file ? { files: [], nested: false } : transformersWeights(inv);
  const useGguf = Boolean(file) || (!transformers.files.length && filesOfKind(inv, "weights:gguf").length > 0);
  const gguf = useGguf ? ggufFacts(inv, facts, { file }) : null;
  const table = !useGguf && transformers.files.length ? buildTensorTable(inv, facts, { files: transformers.files, depth }) : null;
  const stats = gguf ? gguf.stats : table?.stats || null;

  const template = detectTemplate(inv, facts, gguf ? { ggufKv: gguf.kv, ggufFile: gguf.file, ggufOnly: Boolean(file) } : {});
  if (gguf) detectGgufSampling(gguf.kv, gguf.file, facts);

  detectQuant(inv, facts, {
    quantization: configInfo?.quantization || null,
    dtype: configInfo?.dtype || null,
    stats,
    gguf: gguf ? { kv: gguf.kv, file: gguf.file, tensorTypes: gguf.tensorTypes } : null,
  });
  const topologyInput = gguf ? gguf.topology : configInfo?.topology || null;
  buildTopology(topologyInput, stats, facts, { quant: facts.get("/quant") || null });
  if (stats) {
    writeWeights(stats, facts, topologyInput || {});
  } else if (table && depth === "quick") {
    const listing = { kind: "file", ref: null };
    facts.set("/weights/exact", false, listing, "detected", COPY.quickWeights);
    facts.set("/weights/totalBytes", transformers.files.reduce((sum, entry) => sum + entry.size, 0), listing, "detected");
    if (table.indexTotalBytes !== null) facts.set("/weights/tensorBytes", table.indexTotalBytes, { kind: "file", ref: `${table.indexName}#/metadata/total_size` }, "declared");
  }

  writeFormat(inv, facts, { gguf, table, transformers, quantMethod: facts.get("/quant/method") });

  const python = file ? [] : pythonFiles(inv);
  if (python.length) facts.set("/customCode/files", python, { kind: "file", ref: python[0] }, "declared");
  if (facts.get("/customCode/trustRemoteCodeRequired") === undefined) {
    facts.set("/customCode/trustRemoteCodeRequired", false, { kind: "file", ref: null }, "detected", COPY.noRemoteCode);
  }
  if (stats) {
    const mtpTensors = facts.get("/topology/mtp/tensorCount") || 0;
    facts.set("/speculative/nativeMtp", mtpTensors > 0, { kind: "tensor-table", ref: stats.ref }, "detected", mtpTensors > 0 ? COPY.mtpPackaged : COPY.noMtp);
  }

  const contentDigest = await contentDigestForDir(inv.dir, { file, inventory: inv });
  return {
    contentDigest,
    depth,
    data: facts.data,
    evidence: facts.evidence,
    warnings: facts.warnings,
    errors: facts.errors,
    templateText: template?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// Card assembly (caller side)

const SECTION_DEFAULTS = Object.freeze({
  format: { kind: "none", weightFiles: 0, weightBytes: 0, complete: true, missing: [], layout: null },
  identity: {
    modelType: null, textModelType: null, architectures: null, ggufArchitecture: null, transformersVersion: null,
    baseModel: null, displayName: null, familyId: null, familyLabel: null, matchedBy: "",
  },
  topology: {
    paramsTotal: null, paramsActive: null, hiddenSize: null, vocabSize: null, layers: null, heads: null, kvHeads: null,
    headDim: null, attention: null, moe: null, mtp: null, ple: null,
  },
  context: { native: null, ropeScaling: null, slidingWindow: null },
  quant: {
    method: null, algo: null, weightBits: null, groupSize: null, activation: null, kvScheme: null, excludedModules: null,
    ggufFileType: null, ggufTensorTypes: null,
  },
  modalities: { input: [], output: null, visionTower: null, audioTower: null, projectorFiles: [] },
  template: {
    source: "none", sha256: null, bytes: null, signatureId: null, exact: null, toolFormat: null, reasoningFormat: null,
    thinking: null, systemRole: null,
  },
  speculative: { nativeMtp: null, draftOf: null, compatibleDrafts: null },
  customCode: { autoMap: null, files: [], trustRemoteCodeRequired: false },
});
const SAMPLING_ORDER = Object.freeze(["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "source"]);

function withDefaults(defaults, value) {
  return { ...structuredClone(defaults), ...(value || {}) };
}

function assembleTopology(value) {
  const topology = withDefaults(SECTION_DEFAULTS.topology, value);
  if (topology.attention) {
    topology.attention = {
      histogram: topology.attention.histogram || {},
      runs: topology.attention.runs || [],
      kinds: { full: null, swa: null, linear: null, mla: null, compressed: null, indexer: null, ...(topology.attention.kinds || {}) },
    };
  }
  if (topology.moe) {
    topology.moe = { experts: null, active: null, shared: null, expertBytes: null, nonExpertBytes: null, expertBytesPerLayer: null, ...topology.moe };
  }
  if (topology.mtp) topology.mtp = { layers: null, tensorCount: null, bytes: null, ...topology.mtp };
  if (topology.ple) topology.ple = { layers: null, bytes: null, dtype: null, ...topology.ple };
  return topology;
}

// Derived fields (02 §4.1): rebuilt from the current knowledge on every read.
// Without the knowledge layers nothing matches yet.
function deriveFields(card) {
  card.knowledgeDigest = null;
  card.identity.familyId = null;
  card.identity.familyLabel = null;
  card.identity.matchedBy = "";
  card.parsers = null;
  card.support = "unknown";
  return card;
}

/** Builds a ModelCard from a cache entry ({contentDigest, inspectedAt, facts}). */
function buildCard(cardId, entry, ref, { includeTemplate = false } = {}) {
  const facts = structuredClone(entry.facts);
  const data = facts.data || {};
  const sampling = data.sampling
    ? Object.fromEntries(SAMPLING_ORDER.filter((key) => data.sampling[key] !== undefined).map((key) => [key, data.sampling[key]]))
    : null;
  const card = {
    schema: "modelcard/v1",
    cardId,
    contentDigest: entry.contentDigest || facts.contentDigest || null,
    inspectorVersion: entry.inspectorVersion || INSPECTOR_VERSION,
    knowledgeDigest: null,
    inspectedAt: entry.inspectedAt,
    ref,
    origin: null,
    format: withDefaults(SECTION_DEFAULTS.format, data.format),
    role: data.role || null,
    identity: withDefaults(SECTION_DEFAULTS.identity, data.identity),
    topology: assembleTopology(data.topology),
    weights: data.weights ? { exact: false, totalBytes: 0, tensorBytes: null, byDtype: {}, byClass: null, expertsByLayer: null, ...data.weights } : null,
    context: withDefaults(SECTION_DEFAULTS.context, data.context),
    quant: withDefaults(SECTION_DEFAULTS.quant, data.quant),
    modalities: withDefaults(SECTION_DEFAULTS.modalities, data.modalities),
    template: withDefaults(SECTION_DEFAULTS.template, data.template),
    parsers: null,
    sampling: sampling && sampling.source ? sampling : null,
    speculative: withDefaults(SECTION_DEFAULTS.speculative, data.speculative),
    compatibleWith: null,
    customCode: withDefaults(SECTION_DEFAULTS.customCode, data.customCode),
    support: "unknown",
    remote: null,
    evidence: facts.evidence || [],
    warnings: facts.warnings || [],
    errors: facts.errors || [],
  };
  if (includeTemplate && typeof facts.templateText === "string") card.template.text = facts.templateText;
  return deriveFields(card);
}

// ---------------------------------------------------------------------------
// Worker runner: one worker per process, one job at a time.

function createWorkerRunner({ file = WORKER_FILE, idleMs = WORKER_IDLE_MS } = {}) {
  let worker = null;
  let idleTimer = null;
  let tail = Promise.resolve();
  let sequence = 0;

  function ensureWorker() {
    if (!worker) {
      const created = new Worker(file);
      // A worker that fails or exits between jobs is dropped quietly; the
      // next job starts a new one. (An 'error' with no listener would throw
      // on the caller's thread.)
      const drop = () => {
        if (worker === created) worker = null;
      };
      created.on("error", drop);
      created.on("exit", drop);
      created.unref();
      worker = created;
    }
    return worker;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const idle = worker;
      worker = null;
      if (idle) idle.terminate().catch(() => {});
    }, idleMs);
    idleTimer.unref?.();
  }

  function runOne(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let current;
      try {
        current = ensureWorker();
      } catch (error) {
        reject(new InspectError("inspect_worker_failed", `The inspect worker did not start: ${error.message}`));
        return;
      }
      clearTimeout(idleTimer);
      current.ref();
      sequence += 1;
      const id = sequence;
      const finish = () => {
        clearTimeout(timer);
        current.off("message", onMessage);
        current.off("error", onError);
        current.off("exit", onExit);
        if (worker === current) {
          current.unref();
          scheduleIdle();
        }
      };
      const fail = (code, text) => {
        finish();
        if (worker === current) worker = null;
        current.terminate().catch(() => {});
        reject(new InspectError(code, text));
      };
      const onMessage = (reply) => {
        if (!reply || reply.id !== id) return;
        finish();
        if (reply.ok) resolve(reply.facts);
        else reject(new InspectError(reply.error?.code || "inspect_failed", reply.error?.message || "Inspection failed."));
      };
      const onError = (error) => fail("inspect_worker_failed", `The inspect worker failed: ${error.message}`);
      const onExit = (code) => fail("inspect_worker_failed", `The inspect worker exited with code ${code}.`);
      const timer = setTimeout(() => fail("inspect_timeout", `Inspection did not finish within ${Math.round(timeoutMs / 1000)} s.`), timeoutMs);
      current.on("message", onMessage);
      current.on("error", onError);
      current.on("exit", onExit);
      current.postMessage({ id, ...message });
    });
  }

  function run(message, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const job = tail.then(() => runOne(message, timeoutMs));
    tail = job.catch(() => {});
    return job;
  }

  async function close() {
    clearTimeout(idleTimer);
    const current = worker;
    worker = null;
    if (current) await current.terminate().catch(() => {});
  }

  return { run, close };
}

// ---------------------------------------------------------------------------
// inspectLocal

let runner = null;
const flights = createSingleFlightCache({ ttlMs: 0, maxEntries: 64 });
const memory = new Map();
let cacheWriteWarned = false;

function remember(cardId, entry) {
  memory.delete(cardId);
  memory.set(cardId, entry);
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

function covers(have, want) {
  return have === "full" || want === "quick";
}

function usable(entry, key, depth) {
  return Boolean(entry) && entry.key === key && entry.inspectorVersion === INSPECTOR_VERSION && covers(entry.depth, depth);
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function within(dir, root) {
  const relative = path.relative(root, dir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves an inspect target to {dir, file, displayPath}. A GGUF file is a
 * single-file card in its folder; anything else must be a folder. UNC and
 * device paths are refused, and with `roots` (library roots) the real path
 * must lie under one of them (02 §19).
 */
async function resolveLocalTarget(target, { roots = null } = {}) {
  const input = String(target ?? "").trim();
  if (!input) throw new InspectError("invalid_path", "A model path is required.");
  if (/^[\\/]{2}/.test(input)) throw new InspectError("path_not_allowed", "UNC and device paths cannot be inspected.");
  let real;
  try {
    real = await fsp.realpath(path.resolve(input));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new InspectError("not_found", "The model path does not exist.");
    throw new InspectError("invalid_path", `The model path cannot be read (${error.code || error.message}).`);
  }
  if (/^[\\/]{2}/.test(real)) throw new InspectError("path_not_allowed", "UNC and device paths cannot be inspected.");
  const stat = await fsp.stat(real);
  let dir = real;
  let file = null;
  if (stat.isFile()) {
    if (!/\.gguf$/i.test(real)) throw new InspectError("not_a_model", "Only a GGUF file can be inspected on its own; pick its folder otherwise.");
    dir = path.dirname(real);
    file = path.basename(real);
  } else if (!stat.isDirectory()) {
    throw new InspectError("not_a_model", "The model path is neither a folder nor a GGUF file.");
  }
  let base = null;
  if (Array.isArray(roots) && roots.length) {
    for (const root of roots) {
      let realRoot;
      try {
        realRoot = await fsp.realpath(path.resolve(String(root)));
      } catch {
        continue;
      }
      const candidate = process.platform === "win32" ? dir.toLowerCase() : dir;
      const rootCandidate = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
      if (within(candidate, rootCandidate)) {
        base = realRoot;
        break;
      }
    }
    if (!base) throw new InspectError("path_outside_storage", "The model path is outside the model library roots.");
  }
  const relative = base && !samePath(base, dir) ? path.relative(base, dir) : path.basename(dir);
  const displayPath = [relative.split(path.sep).join("/"), file].filter(Boolean).join("/");
  return { dir, file, displayPath };
}

function getRunner() {
  if (!runner) runner = createWorkerRunner();
  return runner;
}

function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function logCacheWrite(logger, error) {
  if (cacheWriteWarned) return;
  cacheWriteWarned = true;
  const log = logger === undefined ? console : logger;
  log?.warn?.(`[model-inspector] The model-card cache could not be written (${error.code || error.message}); cards are still returned.`);
}

/**
 * inspectLocalDetailed(path, options) -> Promise<{card, cached, durationMs, key}>
 * options: depth "full"|"quick", refresh, signal, cacheDir, cache (false: no
 * cache reads or writes), includeTemplate, roots (library roots), inProcess
 * (run the detectors on this thread; tests only), timeoutMs, logger.
 */
async function inspectLocalDetailed(target, options = {}) {
  const started = performance.now();
  const depth = DEPTHS.includes(options.depth) ? options.depth : "full";
  const cacheDir = options.cacheDir || defaultCacheDir();
  const useCache = options.cache !== false;
  const { dir, file, displayPath } = await resolveLocalTarget(target, options);
  const ref = { kind: "local", path: dir, displayPath, file };
  const cardId = cardIdFor({ kind: "local", path: dir, file });
  const inventory = await scanInventory(dir, { signal: options.signal });
  const key = fingerprintKey(inventory);
  const finish = (entry, cached) => {
    remember(cardId, { ...entry, ref });
    const card = buildCard(cardId, entry, ref, { includeTemplate: options.includeTemplate === true });
    return { card, cached, durationMs: Math.round(performance.now() - started), key };
  };

  if (!options.refresh) {
    const remembered = memory.get(cardId);
    if (usable(remembered, key, depth)) return finish(remembered, true);
    if (useCache) {
      const stored = await readCachedFacts(cardId, { cacheDir });
      if (usable(stored, key, depth)) return finish(stored, true);
    }
  }

  const flightKey = `${cardId}|${key}|${depth}|${options.refresh ? "refresh" : ""}`;
  const entry = await raceSignal(flights.get(flightKey, async () => {
    const message = { dir, file, depth, inventory };
    const facts = options.inProcess === true
      ? await collectLocalFacts(dir, message)
      : await getRunner().run(message, { timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
    const detected = {
      key,
      inspectorVersion: INSPECTOR_VERSION,
      depth: facts.depth,
      contentDigest: facts.contentDigest,
      inspectedAt: new Date().toISOString(),
      ref,
      facts,
    };
    if (useCache) {
      // A quick result never replaces a full one for the same files.
      const existing = depth === "quick" ? await readCachedFacts(cardId, { cacheDir }) : null;
      if (!usable(existing, key, "full")) {
        await writeCachedFacts(cardId, detected, { cacheDir }).catch((error) => logCacheWrite(options.logger, error));
      }
    }
    return detected;
  }), options.signal);
  return finish(entry, false);
}

/** inspectLocal(path, options) -> Promise<ModelCard> (see inspectLocalDetailed). */
async function inspectLocal(target, options = {}) {
  return (await inspectLocalDetailed(target, options)).card;
}

/**
 * The card of the last inspection of `cardId` in this process or in the
 * cache, or null. It does not re-list the folder; inspectLocal does.
 */
function getCard(cardId, { cacheDir, includeTemplate = false } = {}) {
  if (!isCardId(cardId)) return null;
  const remembered = memory.get(cardId);
  const entry = remembered || readCachedFactsSync(cardId, { cacheDir: cacheDir || defaultCacheDir() });
  if (!entry || entry.inspectorVersion !== INSPECTOR_VERSION || !entry.ref) return null;
  return buildCard(cardId, entry, entry.ref, { includeTemplate });
}

/** Test hook: forget remembered cards and stop the worker. */
async function resetInspector() {
  memory.clear();
  flights.invalidate();
  cacheWriteWarned = false;
  if (runner) {
    const current = runner;
    runner = null;
    await current.close();
  }
}

module.exports = {
  DEPTHS,
  INSPECTOR_VERSION,
  InspectError,
  buildCard,
  collectLocalFacts,
  createWorkerRunner,
  getCard,
  inspectLocal,
  inspectLocalDetailed,
  resetInspector,
  resolveLocalTarget,
};
