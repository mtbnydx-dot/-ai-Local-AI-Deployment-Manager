"use strict";

// Remote fact collection (docs/overhaul/02-models.md §6): the same detectors
// as a local folder, fed from a repository instead of a directory, so the
// pre-download card equals the post-download card.
//
// 1. A hub client (hf.js / modelscope.js) lists the repository: files and
//    sizes, and for Hugging Face the API facts (sha, safetensors, gguf, config).
// 2. The small metadata files are fetched (config.json, generation_config.json,
//    tokenizer_config.json, chat_template.jinja, hf_quant_config.json and the
//    safetensors index, each <= 8 MiB), plus adapter_config.json and
//    chat_template.json when listed.
// 3. Weight headers are Range-read: the first GGUF shards of the selected
//    variant (a window of 2 MiB that grows as the parser asks), and the
//    safetensors headers when there is no index or at most 8 shards (8 bytes,
//    then the header). Otherwise the weight facts come from the sizes in the
//    listing and the API, not exact.
// 4. Everything fetched sits in an inventory with a `remote` reader (the
//    detectors are synchronous), and collectLocalFacts runs over it.
// 5. API facts fill what the files did not say, and every `file` evidence
//    source becomes `http`.
//
// Failures never invent a fact: a header that cannot be read leaves the facts
// that depend on it unknown, with a warning. A spent 45 s budget stops further
// requests and returns what is known (warning remote_budget_exhausted).

const crypto = require("node:crypto");
const { GgufNeedMoreBytes, parseGgufHeaderBuffer } = require("../../gguf-metadata");
const {
  InventoryError, MAX_ENTRIES, classifyName, compareNames, transformersWeights, weightIndex,
} = require("../detectors/inventory");
const { parseSafetensorsHeader, safetensorsHeaderLength } = require("../detectors/safetensors");
const { DEFAULT_TENSOR_CLASSES, classifyTensor, compileTensorClasses } = require("../detectors/topology");
const { templateSha256 } = require("../detectors/template");
const { REVISION_PATTERN, createHfClient } = require("./hf");
const { createModelScopeClient } = require("./modelscope");
const { REPO_ID } = require("../detectors/hf-config");
const { DEFAULT_MAX_BYTES, RemoteError, createBudget } = require("./range-reader");

const MiB = 1024 * 1024;
const SMALL_FILES = Object.freeze([
  "config.json", "generation_config.json", "tokenizer_config.json", "chat_template.jinja", "hf_quant_config.json",
]);
// Read when listed: detectors look at them, the content digest does not.
const EXTRA_SMALL_FILES = Object.freeze(["adapter_config.json", "chat_template.json"]);
const GGUF_INITIAL_BYTES = 2 * MiB;
const GGUF_MAX_SHARDS = 64;
const GGUF_MAX_PROJECTORS = 2;
const SAFETENSORS_HEADER_SHARDS = 8;
const SAFETENSORS_HEADER_SHARDS_UNINDEXED = 32;
const FETCH_CONCURRENCY = 3;
const HEADER_CONCURRENCY = 4;
const MAX_SIBLINGS_ON_CARD = 2000;
const GGUF_SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const DTYPE_BYTES = Object.freeze({
  F64: 8, F32: 4, F16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, F8_E8M0: 1, I64: 8, I32: 4, I16: 2, I8: 1, U64: 8, U32: 4, U16: 2, U8: 1, BOOL: 1,
});

const COPY = Object.freeze({
  gated: {
    zh: "该仓库需要授权（受限或私有），部分文件无法读取；请在下载设置里登录 Hugging Face 后重新检查。",
    en: "The repository needs authorization (gated or private), so some files could not be read. Log in to Hugging Face in the download settings and inspect again.",
  },
  budget: (seconds) => ({
    zh: `远程检查超过 ${seconds} 秒的总时限，已停止后续请求；没有读取到的信息为未知。`,
    en: `The remote inspection used up its ${seconds} s budget and stopped; whatever was not read is unknown.`,
  }),
  headersUnavailable: {
    zh: "没有读取到权重文件头，字节分类与参数量按列表和 API 估算，不精确。",
    en: "The weight file headers could not be read; byte classes and parameter counts come from the file list and the API and are not exact.",
  },
  rangeIgnored: {
    zh: "服务器没有按 Range 返回（返回了完整内容），读取在上限处被截断。",
    en: "The server ignored the Range header and answered with the whole file; reads were cut off at the byte limit.",
  },
  configFromApi: {
    zh: "config.json 或 tokenizer_config.json 无法读取，相关信息来自仓库 API 返回的摘要。",
    en: "config.json or tokenizer_config.json could not be read; those facts come from the summary in the repository API.",
  },
  variants: (count, chosen) => ({
    zh: `仓库中有 ${count} 个 GGUF 模型变体，此卡片描述 ${chosen}；检查其他变体时请选择对应文件。`,
    en: `The repository holds ${count} GGUF model variants; this card describes ${chosen}. Select its files to see another variant.`,
  }),
  listing: {
    zh: "来自仓库文件列表（只读取文件大小）。",
    en: "From the repository file list (file sizes only).",
  },
  tooManyFiles: (max) => ({
    zh: `仓库中的文件超过 ${max} 个，只检查了前 ${max} 个。`,
    en: `The repository holds more than ${max} files; only the first ${max} were inspected.`,
  }),
  apiDtype: {
    zh: "按仓库 API 的各数据类型参数个数乘以每个元素的字节数估算，不精确。",
    en: "Estimated from the API's parameter count per dtype times the bytes per element; not exact.",
  },
  apiParams: {
    zh: "参数总量来自仓库 API。",
    en: "The total parameter count comes from the repository API.",
  },
  indexMtp: {
    zh: "来自权重索引中的张量名称。",
    en: "From the tensor names in the weight index.",
  },
  indexOnly: {
    zh: "权重大小来自仓库文件列表，没有读取各分片的头，张量级字节数未知。",
    en: "The weight size comes from the repository file list; shard headers were not read, so tensor-level bytes are unknown.",
  },
});

// ---------------------------------------------------------------------------
// Small helpers

function compactName(name) {
  return String(name || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}

function isAbort(error) {
  return error?.name === "AbortError";
}

function unavailableError(reason) {
  const error = new Error(reason);
  error.code = "remote_header_unavailable";
  return error;
}

// ---------------------------------------------------------------------------
// Listing and variant selection

/**
 * The folder-style listing the detectors expect: depth <= 2, no dot entries,
 * sorted, classified. Sizes come from the repository.
 */
function buildListing(files) {
  const seen = new Map();
  let hidden = 0;
  let deep = 0;
  for (const item of files) {
    const name = compactName(item.name);
    if (!name || name.split("/").includes("..")) continue;
    const parts = name.split("/");
    if (parts.some((part) => part.startsWith("."))) {
      hidden += 1;
      continue;
    }
    if (parts.length > 2) {
      deep += 1;
      continue;
    }
    if (!seen.has(name)) seen.set(name, { name, size: Math.max(0, Math.floor(Number(item.size) || 0)), mtimeMs: 0, kind: classifyName(name) });
  }
  const entries = Array.from(seen.values()).sort((left, right) => compareNames(left.name, right.name));
  const truncated = entries.length > MAX_ENTRIES;
  return { files: truncated ? entries.slice(0, MAX_ENTRIES) : entries, skipped: { hidden, links: 0, deep }, truncated };
}

function ggufGroups(files) {
  const groups = new Map();
  for (const file of files.filter((item) => item.kind === "weights:gguf")) {
    const dir = file.name.includes("/") ? file.name.slice(0, file.name.lastIndexOf("/")) : "";
    const base = dir ? file.name.slice(dir.length + 1) : file.name;
    const match = base.match(GGUF_SHARD);
    const prefix = (match ? match[1] : base.replace(/\.gguf$/i, "")).toLowerCase();
    const projector = /mmproj|projector/i.test(base);
    const key = `${dir}|${prefix}|${projector ? "mmproj" : "model"}`;
    if (!groups.has(key)) groups.set(key, { key, dir, projector, count: 1, files: [] });
    const group = groups.get(key);
    group.files.push({ ...file, index: match ? Number(match[2]) : 1 });
    if (match) group.count = Math.max(group.count, Number(match[3]));
  }
  return Array.from(groups.values()).map((group) => {
    group.files.sort((left, right) => left.index - right.index || compareNames(left.name, right.name));
    const indexes = new Set(group.files.map((file) => file.index));
    group.complete = Array.from({ length: group.count }, (_, i) => i + 1).every((index) => indexes.has(index));
    group.bytes = group.files.reduce((sum, file) => sum + file.size, 0);
    return group;
  });
}

/**
 * Picks the GGUF model the card describes (02 §6): the group holding a
 * requested file, else the largest complete one, plus the projectors beside
 * it. Returns {keep: Set of names, main, variants} or null without GGUF files.
 */
function selectGgufVariant(files, requested) {
  const groups = ggufGroups(files);
  if (!groups.length) return null;
  const models = groups.filter((group) => !group.projector)
    .sort((left, right) => Number(right.complete) - Number(left.complete) || right.bytes - left.bytes || compareNames(left.files[0].name, right.files[0].name));
  let main = null;
  if (requested.size) main = groups.find((group) => group.files.some((file) => requested.has(file.name))) || null;
  if (!main) main = models[0] || groups[0];
  const projectors = main.projector ? [] : groups.filter((group) => group.projector && group.dir === main.dir)
    .sort((left, right) => compareNames(left.files[0].name, right.files[0].name)).slice(0, GGUF_MAX_PROJECTORS);
  const keep = new Set([...main.files, ...projectors.flatMap((group) => group.files)].map((file) => file.name));
  return { keep, main, projectors, variants: models.length };
}

// ---------------------------------------------------------------------------
// Header readers

async function readGgufHeaderRemote(client, file, maxBytes, flags) {
  let buffer = Buffer.alloc(0);
  let want = Math.min(file.size, GGUF_INITIAL_BYTES, maxBytes);
  for (;;) {
    if (want > buffer.length) {
      const result = await client.rangeRead(file.name, buffer.length, want - buffer.length);
      if (result.rangeIgnored) flags.rangeIgnored = true;
      if (!result.buffer.length) throw unavailableError("empty range answer");
      buffer = Buffer.concat([buffer, result.buffer]);
    }
    try {
      return parseGgufHeaderBuffer(buffer, { partial: true, fileBytes: file.size, path: file.name });
    } catch (error) {
      if (!(error instanceof GgufNeedMoreBytes)) throw unavailableError(`invalid GGUF header: ${String(error?.message || error).slice(0, 120)}`);
      // The answer was shorter than asked (a byte cap, or the end of the
      // data) or the limit is reached: no more header can be had.
      if (buffer.length < want || buffer.length >= file.size || buffer.length >= maxBytes) throw unavailableError("the header is larger than what could be read");
      const required = Math.ceil(error.requiredBytes / MiB) * MiB;
      const next = Math.min(file.size, maxBytes, Math.max(required, buffer.length * 2));
      if (next <= buffer.length) throw unavailableError("the header is larger than the byte limit");
      want = next;
    }
  }
}

async function readSafetensorsHeaderRemote(client, file, maxBytes, flags) {
  const head = await client.rangeRead(file.name, 0, 8);
  if (head.rangeIgnored) flags.rangeIgnored = true;
  let headerBytes;
  try {
    headerBytes = safetensorsHeaderLength(head.buffer, file.size);
  } catch (error) {
    throw unavailableError(error.message);
  }
  if (headerBytes > maxBytes) throw unavailableError("the header is larger than the byte limit");
  const body = await client.rangeRead(file.name, 8, Math.max(1, headerBytes));
  if (body.rangeIgnored) flags.rangeIgnored = true;
  if (body.buffer.length < headerBytes) throw unavailableError("the header was cut short");
  try {
    return parseSafetensorsHeader(body.buffer.subarray(0, headerBytes), headerBytes, file.size);
  } catch (error) {
    throw unavailableError(error.message);
  }
}

// ---------------------------------------------------------------------------
// The remote reader the detectors see (inventory.remote)

function createRemoteReader(store) {
  return {
    readFile(name, maxBytes) {
      const hit = store.files.get(name);
      if (!hit) throw new InventoryError("read_failed", `${name} was not fetched.`);
      if (hit.code === "file_too_large") throw new InventoryError("file_too_large", `${name} is larger than the read limit.`);
      if (!hit.buffer) throw new InventoryError("read_failed", `${name} could not be fetched.`);
      if (hit.buffer.length > maxBytes) throw new InventoryError("file_too_large", `${name} is larger than ${maxBytes} bytes.`);
      return hit.buffer;
    },
    safetensorsHeader(name) {
      const header = store.safetensors.get(name);
      if (!header) throw unavailableError(`${name}: header not fetched`);
      return header;
    },
    ggufHeader(name) {
      const header = store.gguf.get(name);
      if (!header) throw unavailableError(`${name}: header not fetched`);
      return header;
    },
    noteGap(name) {
      store.gaps.add(name);
    },
  };
}

// ---------------------------------------------------------------------------
// API facts (written after the detectors; they fill gaps and back the rest)

function apiSource(ref) {
  return { kind: "http", ref };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function positiveInteger(value) {
  const number = Number(value);
  return typeof value !== "boolean" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

function applyApiFacts(facts, info, { depth, weightBytes }) {
  const setOrSupport = (pointer, value, ref, note) => {
    if (value === undefined || value === null) return;
    const current = facts.get(pointer);
    if (current === undefined) facts.set(pointer, value, apiSource(ref), "declared", note);
    else if (sameValue(current, value)) facts.support(pointer, apiSource(ref), "declared", note);
  };
  const config = info.config;
  if (config) {
    if (typeof config.model_type === "string" && config.model_type) setOrSupport("/identity/modelType", config.model_type, "api#config.model_type");
    if (Array.isArray(config.architectures) && config.architectures.length && config.architectures.every((item) => typeof item === "string")) {
      setOrSupport("/identity/architectures", config.architectures, "api#config.architectures");
    }
  }
  if (info.gguf) {
    if (typeof info.gguf.architecture === "string" && info.gguf.architecture) setOrSupport("/identity/ggufArchitecture", info.gguf.architecture, "api#gguf.architecture");
    setOrSupport("/context/native", positiveInteger(info.gguf.context_length), "api#gguf.context_length");
  }
  setOrSupport("/identity/baseModel", info.baseModel, "api#cardData.base_model");
  const total = positiveInteger(info.safetensors?.total) || positiveInteger(info.gguf?.total);
  if (total) setOrSupport("/topology/paramsTotal", total, info.safetensors?.total ? "api#safetensors.total" : "api#gguf.total", COPY.apiParams);

  // Without shard headers the byte classes are unknown; the per-dtype
  // parameter counts of the API give the bytes by dtype (not exact).
  if (depth === "quick" && facts.get("/weights/byDtype") === undefined && info.safetensors?.parameters) {
    const byDtype = {};
    let known = true;
    for (const [dtype, count] of Object.entries(info.safetensors.parameters)) {
      const bytes = DTYPE_BYTES[dtype];
      const number = Number(count);
      if (!bytes || !Number.isSafeInteger(number) || number < 0) {
        known = false;
        break;
      }
      byDtype[dtype] = number * bytes;
    }
    if (known && Object.keys(byDtype).length) {
      facts.set("/weights/byDtype", Object.fromEntries(Object.keys(byDtype).sort().map((key) => [key, byDtype[key]])), apiSource("api#safetensors.parameters"), "detected", COPY.apiDtype);
    }
  }
  // GGUF without a readable header: the size is still exact.
  if (facts.get("/weights/totalBytes") === undefined && weightBytes > 0) {
    facts.set("/weights/exact", false, apiSource("api#siblings"), "detected", COPY.indexOnly);
    facts.set("/weights/totalBytes", weightBytes, apiSource("api#siblings"), "declared");
  }
}

function indexTensorFacts(facts, store, indexName) {
  const hit = indexName ? store.files.get(indexName) : null;
  if (!hit?.buffer) return;
  let index;
  try {
    index = JSON.parse(hit.buffer.toString("utf8"));
  } catch {
    return;
  }
  const names = Object.keys(index?.weight_map || {});
  if (!names.length) return;
  const classes = compileTensorClasses(DEFAULT_TENSOR_CLASSES);
  const mtp = names.filter((name) => classifyTensor(name, classes)?.class === "mtp").length;
  const source = { kind: "tensor-table", ref: indexName };
  facts.set("/speculative/nativeMtp", mtp > 0, source, "detected", COPY.indexMtp);
  if (mtp > 0) facts.set("/topology/mtp/tensorCount", mtp, source, "detected", COPY.indexMtp);
}

function filesKeyOf(requested) {
  return requested.size ? crypto.createHash("sha256").update(Array.from(requested).sort().join("\n")).digest("hex").slice(0, 16) : "";
}

// ---------------------------------------------------------------------------
// Session and collection

/**
 * openRemote(request, options) -> Promise<Session>
 * request: {source: "hf"|"modelscope", repo, revision, files}. Lists the
 * repository (the one request that must succeed). Throws RemoteError.
 */
async function openRemote(request, options = {}) {
  const budget = createBudget({ totalMs: options.budgetMs, requestMs: options.requestTimeoutMs, signal: options.signal, now: options.now });
  const maxBytes = Number.isSafeInteger(options.maxHeaderBytes) && options.maxHeaderBytes > 0 ? options.maxHeaderBytes : DEFAULT_MAX_BYTES;
  const common = {
    repo: request.repo,
    revision: request.revision,
    endpoint: options.endpoint,
    mirrors: options.mirrors,
    fetchImpl: options.fetchImpl,
    readRange: options.readRange,
    budget,
    maxBytes,
  };
  const client = request.source === "modelscope"
    ? createModelScopeClient(common)
    : createHfClient({ ...common, token: options.token || "" });
  const info = await client.info();
  const listing = buildListing(info.files);
  const key = request.source === "modelscope"
    ? `modelscope:${request.repo}@${request.revision}#${crypto.createHash("sha256").update(info.files.map((file) => `${file.name}\t${file.size}\t${file.sha256 || ""}`).sort().join("\n")).digest("hex").slice(0, 32)}`
    : `hf:${request.repo}@${info.sha || request.revision}`;
  return {
    request, options, budget, maxBytes, client, info, listing, key,
    sha: info.sha,
    filesKey: filesKeyOf(request.requested),
  };
}

/**
 * collectRemote(session, {collectFacts}) -> Promise<{facts, ref, remote, fetch}>
 * facts: the collectLocalFacts result; ref/remote: the card's ref and remote
 * blocks; fetch: bookkeeping for the cache entry. Never throws for a file
 * that cannot be read; a cancelled inspection throws an AbortError.
 */
async function collectRemote(session, { collectFacts }) {
  const { request, client, info, budget, maxBytes } = session;
  const flags = { rangeIgnored: false, budgetHit: false, unauthorized: false, headerFailure: false, networkFailure: false };
  const store = { files: new Map(), safetensors: new Map(), gguf: new Map(), gaps: new Set(), synthetic: new Set() };
  const notes = { warnings: [] };
  let { files } = session.listing;

  // 1. GGUF variant selection narrows the inventory to the described model.
  const selection = selectGgufVariant(files, request.requested);
  if (selection) {
    files = files.filter((file) => file.kind !== "weights:gguf" || selection.keep.has(file.name));
    if (selection.variants > 1 && !request.requested.size) notes.warnings.push(["multiple_gguf_variants", COPY.variants(selection.variants, selection.main.files[0].name)]);
  }
  const inventory = {
    dir: "",
    files,
    skipped: session.listing.skipped,
    truncated: session.listing.truncated,
    maxEntries: MAX_ENTRIES,
    remote: createRemoteReader(store),
  };
  const present = new Map(files.map((file) => [file.name, file]));

  const guard = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error instanceof RemoteError && error.code === "budget_exhausted") flags.budgetHit = true;
      else if (error instanceof RemoteError && (error.status === 401 || error.status === 403)) flags.unauthorized = true;
      else if (error instanceof RemoteError) flags.networkFailure = true;
      return undefined;
    }
  };

  // 2. Small metadata files.
  const index = weightIndex(inventory);
  const wanted = [...SMALL_FILES, ...EXTRA_SMALL_FILES, ...(index ? [index.name] : [])].filter((name, at, all) => present.has(name) && all.indexOf(name) === at);
  await mapLimit(wanted, FETCH_CONCURRENCY, (name) => guard(async () => {
    const entry = present.get(name);
    if (entry.size > 8 * MiB) {
      store.files.set(name, { code: "file_too_large" });
      return;
    }
    const result = await client.fetchFile(name);
    if (result.ok) store.files.set(name, { buffer: result.buffer });
    else {
      store.files.set(name, { code: result.code });
      if (result.code === "unauthorized") flags.unauthorized = true;
      if (["timeout", "unreachable", "http_error"].includes(result.code)) flags.networkFailure = true;
    }
  }));
  for (const name of wanted) if (!store.files.has(name)) store.files.set(name, { code: "not_fetched" });

  // A config.json or tokenizer_config.json that could not be read: the API's
  // summary of it stands in, so the detectors keep one code path. The digest
  // then no longer describes the real files and is dropped.
  const apiConfig = info.config;
  if (apiConfig) {
    const { tokenizer_config: apiTokenizer, ...configSummary } = apiConfig;
    const stand = (name, value) => {
      if (store.files.get(name)?.buffer || !present.has(name) || !value || typeof value !== "object") return;
      store.files.set(name, { buffer: Buffer.from(JSON.stringify(value)), synthetic: true });
      store.synthetic.add(name);
      if (!notes.warnings.some(([code]) => code === "config_from_api")) notes.warnings.push(["config_from_api", COPY.configFromApi]);
    };
    if (typeof configSummary.model_type === "string") stand("config.json", configSummary);
    stand("tokenizer_config.json", apiTokenizer);
  }

  // 3. Weight headers.
  const transformers = transformersWeights(inventory);
  const useGguf = !transformers.files.length && Boolean(selection);
  let depth = "full";
  if (useGguf) {
    const groups = [selection.main, ...selection.projectors];
    for (const [position, group] of groups.entries()) {
      const shards = group.files.slice(0, GGUF_MAX_SHARDS);
      const headers = new Map();
      const ok = await guard(async () => {
        // The first shard alone (a failure there ends it), the rest in parallel.
        headers.set(shards[0].name, await readGgufHeaderRemote(client, shards[0], maxBytes, flags));
        await mapLimit(shards.slice(1), HEADER_CONCURRENCY, async (shard) => {
          budget.check();
          headers.set(shard.name, await readGgufHeaderRemote(client, shard, maxBytes, flags));
        });
        return true;
      });
      if (ok && shards.length === group.files.length) {
        for (const [name, header] of headers) store.gguf.set(name, header);
      } else if (position === 0) {
        // The model's own header is the point; without it a projector's header
        // must not stand in for the model.
        flags.headerFailure = true;
        break;
      }
    }
  } else if (transformers.files.length) {
    const safetensors = transformers.files.filter((file) => file.kind === "weights:safetensors");
    const limit = index ? SAFETENSORS_HEADER_SHARDS : SAFETENSORS_HEADER_SHARDS_UNINDEXED;
    if (safetensors.length && safetensors.length === transformers.files.length && safetensors.length <= limit) {
      const headers = new Map();
      const ok = await guard(async () => {
        await mapLimit(safetensors, HEADER_CONCURRENCY, async (file) => {
          budget.check();
          headers.set(file.name, await readSafetensorsHeaderRemote(client, file, maxBytes, flags));
        });
        return true;
      });
      if (ok) for (const [name, header] of headers) store.safetensors.set(name, header);
      else {
        depth = "quick";
        flags.headerFailure = true;
      }
    } else {
      depth = "quick";
    }
  }
  if (budget.exhausted()) flags.budgetHit = true;

  // 4. The detectors, over the remote inventory.
  const weightBytes = files.filter((file) => file.kind.startsWith("weights:")).reduce((sum, file) => sum + file.size, 0);
  const refine = (facts, context) => {
    for (const [code, message] of notes.warnings) facts.warn(code, message);
    if (session.listing.truncated) facts.warn("too_many_entries", COPY.tooManyFiles(MAX_ENTRIES));
    applyApiFacts(facts, info, { depth: context.depth, weightBytes });
    if (context.depth === "quick" && transformers.files.length) indexTensorFacts(facts, store, index?.name);
    // A GGUF template the header could not give: the API carries it.
    let templateText = null;
    const apiTemplate = info.gguf?.chat_template;
    if (typeof apiTemplate === "string" && apiTemplate && facts.get("/template/sha256") === undefined) {
      const source = apiSource("api#gguf.chat_template");
      facts.set("/template/source", "gguf", source, "declared");
      facts.set("/template/sha256", templateSha256(apiTemplate), source, "detected");
      facts.set("/template/bytes", Buffer.byteLength(apiTemplate.replace(/\r\n/g, "\n"), "utf8"), source, "detected");
      const missing = facts.warnings.findIndex((item) => item.code === "template_missing");
      if (missing >= 0) facts.warnings.splice(missing, 1);
      templateText = apiTemplate.replace(/\r\n/g, "\n");
    }
    if (flags.unauthorized) facts.warn("remote_gated", COPY.gated);
    if (flags.rangeIgnored) facts.warn("remote_range_ignored", COPY.rangeIgnored);
    if (flags.headerFailure || (depth === "quick" && transformers.files.length && !index && transformers.files.length > SAFETENSORS_HEADER_SHARDS_UNINDEXED)) {
      facts.warn("remote_headers_unavailable", COPY.headersUnavailable);
    }
    if (flags.budgetHit) facts.warn("remote_budget_exhausted", COPY.budget(Math.round(budget.totalMs / 1000)));
    return { templateText };
  };
  const facts = await collectFacts("", { inventory, depth, refine });

  // 5. Evidence and digest bookkeeping.
  for (const entry of facts.evidence) {
    if (entry.source.kind === "file") entry.source = { kind: "http", ref: entry.source.ref === null ? "listing" : entry.source.ref };
  }
  if (store.gaps.size || store.synthetic.size) facts.contentDigest = null;

  const sha = info.sha;
  const ref = {
    kind: request.source === "modelscope" ? "modelscope" : "hf",
    repo: request.repo,
    revision: request.revision,
    sha: sha || null,
    gated: Boolean(info.gated || flags.unauthorized),
  };
  const siblings = info.files.slice(0, MAX_SIBLINGS_ON_CARD).map((file) => ({ name: file.name, size: file.size }));
  const remote = {
    downloads: info.downloads,
    likes: info.likes,
    lastModified: info.lastModified,
    pipelineTag: info.pipelineTag,
    libraryName: info.libraryName,
    hasConfig: info.files.some((file) => file.name === "config.json"),
    siblingCount: info.files.length,
    siblings,
  };
  return {
    facts,
    ref,
    remote,
    fetch: {
      sha: sha || null,
      key: session.key,
      filesKey: session.filesKey,
      unauthorized: flags.unauthorized || Boolean(info.gated),
      // A result that only a transient failure shaped is not worth caching.
      partial: flags.budgetHit || flags.networkFailure || (flags.headerFailure && !flags.unauthorized),
    },
  };
}

/**
 * normalizeRequest({source, repo, revision, files}) -> {source: "hf"|"modelscope",
 * repo, revision, requested: Set of repo-relative names}. Throws RemoteError
 * invalid_source / invalid_repo.
 */
function normalizeRequest(input = {}) {
  const raw = String(input.source || "hf").toLowerCase();
  const source = raw === "modelscope" || raw === "ms" ? "modelscope" : raw === "hf" || raw === "huggingface" ? "hf" : null;
  if (!source) throw new RemoteError("invalid_source", "The source must be huggingface or modelscope.");
  const repo = String(input.repo || "").trim();
  if (!REPO_ID.test(repo)) throw new RemoteError("invalid_repo", "The repository id must look like owner/name.");
  const revision = String(input.revision || (source === "hf" ? "main" : "master")).trim();
  if (!REVISION_PATTERN.test(revision)) throw new RemoteError("invalid_repo", "The revision is not valid.");
  const requested = new Set((Array.isArray(input.files) ? input.files : [])
    .map((item) => compactName(typeof item === "string" ? item : item?.path || item?.name))
    .filter(Boolean));
  return { source, repo, revision, requested };
}

module.exports = {
  EXTRA_SMALL_FILES,
  SMALL_FILES,
  buildListing,
  collectRemote,
  filesKeyOf,
  ggufGroups,
  normalizeRequest,
  openRemote,
  selectGgufVariant,
};
